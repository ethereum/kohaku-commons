/* eslint-disable no-await-in-loop */
import { Interface } from 'ethers'
import { createRailgunPlugin, Bundler, Signer } from '@kohaku-eth/railgun'
import type { Storage as PluginStorage } from '@kohaku-eth/plugins'
import ERC20 from '../../../contracts/compiled/IERC20.json'
import EventEmitter from '../eventEmitter/eventEmitter'
import type { KeystoreController } from '../keystore/keystore'
import type { NetworksController } from '../networks/networks'
import type { SelectedAccountController } from '../selectedAccount/selectedAccount'
import type { StorageController } from '../storage/storage'
import type { AccountsController } from '../accounts/accounts'
import type { ProvidersController } from '../providers/providers'
import type { PortfolioController } from '../portfolio/portfolio'
import type { ActivityController } from '../activity/activity'
import type { ExternalSignerControllers } from '../../interfaces/keystore'
import { SignAccountOpController } from '../signAccountOp/signAccountOp'
import { AccountOp } from '../../libs/accountOp/accountOp'
import { Call, AccountOpStatus } from '../../libs/accountOp/types'
import { SubmittedAccountOp } from '../../libs/accountOp/submittedAccountOp'
import { getBaseAccount } from '../../libs/account/getBaseAccount'
import { getAmbirePaymasterService } from '../../libs/erc7677/erc7677'
import { randomId } from '../../libs/humanizer/utils'
import { EstimationStatus } from '../estimation/types'
import wait from '../../utils/wait'
import { hostFactory } from './hostFactory'

const ERC20Interface = new Interface(ERC20.abi)

const PLUGIN_STORAGE_KEY = 'railgunV2PluginStorage'

// Bumped once when persisted state must be wiped (e.g. the alpha.27 upgrade).
const RAILGUN_STATE_CLEARED_FLAG = 'railgunV2StateClearedForAlpha27'

const RPC_BATCH_SIZE = 450

const DEFAULT_CHAIN_ID = 11155111n

type PersistablePluginStorage = PluginStorage & {
  saveToStorage(): Promise<void>
}

async function createPluginStorage(
  storageController: StorageController
): Promise<PersistablePluginStorage> {
  const persisted = await storageController.get(PLUGIN_STORAGE_KEY, {})
  const map = new Map<string, string>(Object.entries(persisted as Record<string, string>))

  return {
    _brand: 'Storage' as const,
    get(key: string) {
      return map.get(key) ?? null
    },
    set(key: string, value: string) {
      map.set(key, value)
    },
    async saveToStorage() {
      await storageController.set(PLUGIN_STORAGE_KEY, Object.fromEntries(map))
    }
  }
}

type RailgunPluginInstance = Awaited<ReturnType<typeof createRailgunPlugin>>
export type ShieldAsset = Parameters<RailgunPluginInstance['prepareShield']>[0]
export type UnshieldRecipient = Parameters<RailgunPluginInstance['prepareUnshield']>[1]
export type TransferRecipient = Parameters<RailgunPluginInstance['prepareTransfer']>[1]
export type PendingPrivateOperation = Awaited<ReturnType<RailgunPluginInstance['prepareUnshield']>>
export type RailgunBalance = Awaited<ReturnType<RailgunPluginInstance['balance']>>[number]

export type SyncState = 'unsynced' | 'syncing' | 'synced'
export type State = 'idle' | 'shielding' | 'preparing-unshield' | 'unshielding'
export interface OpStatus {
  op: Exclude<State, 'idle'>
  error?: string
}

export class RailgunV2Controller extends EventEmitter {
  #keystore: KeystoreController

  #networks: NetworksController

  #selectedAccount: SelectedAccountController

  #storageController: StorageController

  #accounts: AccountsController

  #providers: ProvidersController

  #portfolio: PortfolioController

  #activity: ActivityController

  #externalSignerControllers: ExternalSignerControllers

  #delegatingSignerPk: string

  #pluginStorage: PersistablePluginStorage | null = null

  #currentAccountAddr: string | null = null

  #subs: (() => void)[] = []

  #instance: RailgunPluginInstance | null = null

  #signAccountOpSubscriptions: Function[] = []

  pendingPrivateOperation: PendingPrivateOperation | null = null

  #pendingOpIsInternalTransfer: boolean = false

  // Lowercase contract of the shielded asset whose balance should drop when the
  // op succeeds — set by prepare*. For an erc20 it's the token; for a native
  // unshield it's the wrapped base token (WETH), which is what actually leaves the
  // shielded pool. The success guard checks THIS asset dropped, not just any token,
  // since the WETH relay fee is charged even when the op reverts.
  #pendingOpAssetKey: string | null = null

  // True for the entire unshield/transfer (submitPrivateOp) — spanning the
  // pre-prepare sync, prepare, and broadcast. Drives the "Sending…" button (so it
  // never sticks if prepare fails — the finally clears it) and gates background
  // syncs from interleaving a prepared-but-not-yet-broadcast op.
  privateOpInFlight: boolean = false

  // Serializes every call into the single-instance Railgun WASM. The SDK panics
  // on concurrent/reentrant use ("recursive use of an object … unsafe aliasing in
  // rust"), and we fire SDK calls from uncoordinated places (the state-context
  // sync effects + the shield/unshield flows). Each WASM call queues behind the
  // previous one. Wrapping per-call (not per-method) keeps it deadlock-free, since
  // submitPrivateOp → broadcastPrivateOp → sync would otherwise self-deadlock.
  #wasmLock: Promise<unknown> = Promise.resolve()

  #reestimateAbortController: AbortController | null = null

  balance: RailgunBalance[] = []

  zkAddress: string | null = null

  syncState: SyncState = 'unsynced'

  state: State = 'idle'

  lastOperation: OpStatus | null = null

  isInitialized: boolean = false

  initializationError: string | null = null

  signAccountOpController: SignAccountOpController | null = null

  latestBroadcastedAccountOp: AccountOp | null = null

  hasProceeded: boolean = false

  shouldTrackLatestBroadcastedAccountOp: boolean = true

  constructor(
    keystore: KeystoreController,
    networks: NetworksController,
    selectedAccount: SelectedAccountController,
    storageController: StorageController,
    accounts: AccountsController,
    providers: ProvidersController,
    portfolio: PortfolioController,
    activity: ActivityController,
    externalSignerControllers: ExternalSignerControllers,
    delegatingSignerPk: string = ''
  ) {
    super()

    this.#delegatingSignerPk = delegatingSignerPk
    this.#keystore = keystore
    this.#networks = networks
    this.#selectedAccount = selectedAccount
    this.#storageController = storageController
    this.#accounts = accounts
    this.#providers = providers
    this.#portfolio = portfolio
    this.#activity = activity
    this.#externalSignerControllers = externalSignerControllers
    this.initPluginWhenAccountChangesAndKeystoreIsUnlocked()
  }

  private initPluginWhenAccountChangesAndKeystoreIsUnlocked() {
    this.#subs.push(
      this.#selectedAccount.onUpdate(() => {
        const newAddr = this.#selectedAccount.account?.addr ?? null

        if (newAddr !== this.#currentAccountAddr) {
          this.#currentAccountAddr = newAddr
          // Account switched — re-instantiate against the new account's keys.
          this.reset(false)
        }

        if (!this.isInitialized && !this.initializationError && this.#keystore.isUnlocked) {
          // eslint-disable-next-line @typescript-eslint/no-floating-promises
          this.init()
        }
      }),
      this.#keystore.onUpdate(() => {
        if (!this.#instance && this.#keystore.isUnlocked) {
          // eslint-disable-next-line @typescript-eslint/no-floating-promises
          this.init()
        }
      })
    )
  }

  #initPromise: Promise<void> | null = null

  // Serializes init(): both selectedAccount.onUpdate and keystore.onUpdate call it
  // and can fire together when the keystore unlocks around an account change. Two
  // concurrent createRailgunPlugin() calls crash the single-instance WASM, so we
  // share one in-flight init and let the next call re-init after it settles.
  async init(): Promise<void> {
    if (this.#initPromise) return this.#initPromise
    this.#initPromise = this.#runInit().finally(() => {
      this.#initPromise = null
    })
    return this.#initPromise
  }

  async #runInit(): Promise<void> {
    this.#currentAccountAddr = this.#selectedAccount.account?.addr ?? null
    this.reset(false)

    try {
      // One-time migration: wipe Railgun plugin state persisted before the
      // alpha.27 upgrade. State carried over from alpha.22 (and from forked-Sepolia
      // runs) leaves the SDK with a commitment tree that no longer matches the
      // chain, which surfaces on unshield as "RailgunSmartWallet: Invalid Merkle
      // Root". Clearing it once lets the SDK re-sync a correct tree from scratch.
      if (!(await this.#storageController.get(RAILGUN_STATE_CLEARED_FLAG, false))) {
        await this.#storageController.set(PLUGIN_STORAGE_KEY, {})
        await this.#storageController.set(RAILGUN_STATE_CLEARED_FLAG, true)
      }

      this.#pluginStorage = await createPluginStorage(this.#storageController)

      const host = await hostFactory(
        this.#keystore,
        this.#networks,
        this.#selectedAccount,
        DEFAULT_CHAIN_ID,
        this.#pluginStorage
      )

      const pimlicoApiKey = process.env.REACT_APP_PIMLICO_API_KEY
      const bundlerConfig =
        pimlicoApiKey && this.#delegatingSignerPk
          ? {
              bundler: Bundler.pimlico(
                `https://api.pimlico.io/v2/${DEFAULT_CHAIN_ID}/rpc?apikey=${pimlicoApiKey}`
              ),
              smartAccountSigner: Signer.privateKey(this.#delegatingSignerPk as `0x${string}`)
            }
          : undefined

      // POI (Proof of Innocence) is enabled by default. On Railgun, freshly
      // shielded funds sit in a pending-POI state and are excluded from
      // balance() until validated by the POI aggregator — which does not serve
      // Sepolia, so testnet shields would never appear. Disable it for testnet.
      this.#instance = await createRailgunPlugin(
        host as unknown as Parameters<typeof createRailgunPlugin>[0],
        { rpcBatchSize: RPC_BATCH_SIZE, poi: false, bundler: bundlerConfig } as never
      )

      this.zkAddress = await this.#instance.instanceId()
      this.isInitialized = true
    } catch (e: any) {
      this.initializationError = e?.message ?? 'Unknown error during railgun initialization'
    }

    this.emitUpdate()
  }

  // Runs `fn` only after the previous WASM call settles (resolved or rejected), so
  // no two SDK calls are ever in flight at once. The chain itself never rejects
  // (so one failure doesn't stall the queue); the caller still gets fn's result.
  #withWasmLock<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#wasmLock.then(fn, fn)
    this.#wasmLock = result.then(
      () => {},
      () => {}
    )
    return result
  }

  async sync(): Promise<void> {
    // Skip background syncs while an unshield/transfer is mid-flight — a sync
    // landing between prepare and broadcast can stale the prepared op's tree root.
    if (!this.#instance || this.syncState === 'syncing' || this.privateOpInFlight) return

    this.syncState = 'syncing'
    this.emitUpdate()

    try {
      this.balance = await this.#withWasmLock(() => this.#instance!.balance(undefined))
      await this.#pluginStorage?.saveToStorage()
      this.syncState = 'synced'
    } catch (e: any) {
      // Background syncs self-heal: leaving syncState 'unsynced' re-triggers the
      // state-context retry effect on the next tick. Common on first shield while
      // the SDK is still warming up (initial tree build + one-time state wipe), so
      // surface it silently (logged, no user toast) rather than as a major error.
      this.syncState = 'unsynced'
      this.emitError({
        level: 'silent',
        message: 'Failed to sync Railgun balances',
        error: e instanceof Error ? e : new Error('Unknown error during railgun sync')
      })
    }

    this.emitUpdate()
  }

  async prepareShield(assetAmount: ShieldAsset): Promise<void> {
    if (!this.#instance) throw new Error('RailgunV2 not initialized')

    this.state = 'shielding'
    this.emitUpdate()

    const txDatas = await this.#withWasmLock(() => this.#instance!.prepareShield(assetAmount))

    const calls: Call[] = txDatas.map((txData) => ({
      to: txData.to as `0x${string}`,
      value: BigInt(txData.value ?? 0),
      data: txData.data as `0x${string}`
    }))

    // The SDK's prepareShield returns only the shield call itself — for ERC20
    // assets it does NOT include the token approval the Railgun contract needs
    // to pull the funds (native assets carry their value inline and need none).
    // Prepend an approve(spender, amount) to the Railgun contract (the shield
    // call's `to`). Since the user's account is a smart account, approve + shield
    // are batched into one account op and execute atomically.
    // eslint-disable-next-line no-underscore-dangle
    if (assetAmount.asset.__type === 'erc20' && calls.length > 0) {
      const spender = calls[0].to
      const approveCall: Call = {
        to: assetAmount.asset.contract as `0x${string}`,
        value: 0n,
        data: ERC20Interface.encodeFunctionData('approve', [
          spender,
          assetAmount.amount
        ]) as `0x${string}`
      }
      calls.unshift(approveCall)
    }

    await this.syncSignAccountOp(calls)
  }

  async syncSignAccountOp(calls: Call[]) {
    if (!this.#selectedAccount?.account) return
    if (!calls.length) return

    try {
      this.shouldTrackLatestBroadcastedAccountOp = true

      if (this.signAccountOpController) {
        this.destroySignAccountOp()
      }

      this.hasProceeded = false

      await this.#initSignAccOp(calls)
    } catch (error) {
      this.state = 'idle'
      this.emitError({
        level: 'major',
        message: 'Failed to initialize transaction signing',
        error: error instanceof Error ? error : new Error('Unknown error in syncSignAccountOp')
      })
    }
  }

  async #initSignAccOp(calls: Call[]) {
    if (!this.#selectedAccount?.account || this.signAccountOpController || !this.#accounts) return

    // The Railgun plugin is pinned to DEFAULT_CHAIN_ID — build the shield account
    // op for that same chain, NOT networks[0] (which may be mainnet).
    const network = this.#networks.networks.find((net) => net.chainId === DEFAULT_CHAIN_ID)
    if (!network) return

    const provider = this.#providers.providers[network.chainId.toString()]
    const accountState = await this.#accounts.getOrFetchAccountOnChainState(
      this.#selectedAccount.account.addr,
      network.chainId
    )

    if (!this.#keystore) return

    const baseAcc = getBaseAccount(
      this.#selectedAccount.account,
      accountState,
      this.#keystore.getAccountKeys(this.#selectedAccount.account),
      network
    )

    const accountOp: AccountOp = {
      accountAddr: this.#selectedAccount.account.addr,
      chainId: network.chainId,
      signingKeyAddr: null,
      signingKeyType: null,
      gasLimit: null,
      gasFeePayment: null,
      nonce: accountState.nonce,
      signature: null,
      accountOpToExecuteBefore: null,
      calls,
      meta: {
        paymasterService: getAmbirePaymasterService(baseAcc, '')
      }
    }

    this.signAccountOpController = new SignAccountOpController(
      this.#accounts,
      this.#networks,
      this.#keystore,
      this.#portfolio,
      this.#activity,
      this.#externalSignerControllers,
      this.#selectedAccount.account,
      network,
      provider,
      randomId(),
      accountOp,
      () => true,
      false,
      undefined
    )

    this.#signAccountOpSubscriptions.push(
      this.signAccountOpController.onUpdate(() => {
        this.emitUpdate()
      })
    )
    this.#signAccountOpSubscriptions.push(
      this.signAccountOpController.onError((error) => {
        if (this.signAccountOpController)
          this.#portfolio.overridePendingResults(this.signAccountOpController.accountOp)
        this.emitError(error)
      })
    )

    if (this.signAccountOpController) {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      this.signAccountOpController.estimate()
    }

    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this.reestimate()
  }

  async reestimate() {
    if (!this.signAccountOpController || this.#reestimateAbortController) return

    this.#reestimateAbortController = new AbortController()
    const signal = this.#reestimateAbortController!.signal

    const loop = async () => {
      await wait(30000)

      while (!signal.aborted) {
        if (signal.aborted) break

        if (this.signAccountOpController?.estimation.status !== EstimationStatus.Loading) {
          await this.signAccountOpController?.estimate()
        }

        await wait(30000)
        if (signal.aborted) break
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    loop()
  }

  destroySignAccountOp() {
    this.#signAccountOpSubscriptions.forEach((unsubscribe) => unsubscribe())
    this.#signAccountOpSubscriptions = []

    if (this.#reestimateAbortController) {
      this.#reestimateAbortController.abort()
      this.#reestimateAbortController = null
    }

    if (this.signAccountOpController) {
      this.signAccountOpController.reset()
      this.signAccountOpController = null
    }

    this.hasProceeded = false
    this.emitUpdate()
  }

  destroyLatestBroadcastedAccountOp() {
    this.shouldTrackLatestBroadcastedAccountOp = false
    this.latestBroadcastedAccountOp = null
    this.emitUpdate()
  }

  setUserProceeded(hasProceeded: boolean) {
    this.hasProceeded = hasProceeded
    this.emitUpdate()
  }

  // The shielded asset the success guard should watch: the erc20 contract
  // directly, or — for a native unshield — the wrapped base token (WETH), which is
  // what actually leaves the pool. Lowercased to match provider.balance() keys.
  #assetKeyFor(assetAmount: ShieldAsset): string | null {
    // eslint-disable-next-line no-underscore-dangle
    if (assetAmount.asset.__type === 'erc20') return assetAmount.asset.contract.toLowerCase()
    const wrapped = (this.#instance as unknown as { chain?: { wrappedBaseToken?: string } } | null)
      ?.chain?.wrappedBaseToken
    return wrapped ? wrapped.toLowerCase() : null
  }

  async prepareUnshield(assetAmount: ShieldAsset, to: UnshieldRecipient): Promise<void> {
    let errorMessage: string | undefined
    this.state = 'preparing-unshield'
    this.emitUpdate()
    try {
      if (!this.#instance) throw new Error('RailgunV2 not initialized')

      this.pendingPrivateOperation = await this.#withWasmLock(() =>
        this.#instance!.prepareUnshield(assetAmount, to)
      )
      this.#pendingOpIsInternalTransfer = false
      this.#pendingOpAssetKey = this.#assetKeyFor(assetAmount)
    } catch (error) {
      errorMessage = (error as Error).message
    } finally {
      this.state = 'idle'
      if (errorMessage) {
        this.lastOperation = { op: 'unshielding', error: errorMessage }
      }
      this.emitUpdate()
    }
  }

  async prepareTransfer(assetAmount: ShieldAsset, to: TransferRecipient): Promise<void> {
    let errorMessage: string | undefined
    this.state = 'preparing-unshield'
    this.emitUpdate()
    try {
      if (!this.#instance) throw new Error('RailgunV2 not initialized')

      this.pendingPrivateOperation = await this.#withWasmLock(() =>
        this.#instance!.prepareTransfer(assetAmount, to)
      )
      this.#pendingOpIsInternalTransfer = true
      this.#pendingOpAssetKey = this.#assetKeyFor(assetAmount)
    } catch (error) {
      errorMessage = (error as Error).message
    } finally {
      this.state = 'idle'
      if (errorMessage) {
        this.lastOperation = { op: 'unshielding', error: errorMessage }
      }
      this.emitUpdate()
    }
  }

  async submitPrivateOp(
    assetAmount: ShieldAsset,
    to: UnshieldRecipient | TransferRecipient
  ): Promise<void> {
    const isRailgunRecipient = `${to}`.toLowerCase().startsWith('0zk')

    // Marks the whole op in-flight: drives the UI "Sending…" state (cleared in the
    // finally even if prepare fails) and blocks background syncs from interleaving
    // between prepare and broadcast.
    this.privateOpInFlight = true
    this.emitUpdate()
    try {
      // prepare* runs the SDK's `drain`, which reads the provider WITHOUT syncing —
      // unlike `balance()`, which syncs first. Sync here so `drain` sees the same
      // notes the displayed balance does; otherwise a behind-the-curve provider
      // trips "Insufficient balance" even when the shielded balance is sufficient.
      if (this.#instance) {
        this.balance = await this.#withWasmLock(() => this.#instance!.balance(undefined))
        this.emitUpdate()
      }

      if (isRailgunRecipient) {
        await this.prepareTransfer(assetAmount, to as TransferRecipient)
      } else {
        await this.prepareUnshield(assetAmount, to as UnshieldRecipient)
      }

      if (!this.pendingPrivateOperation) return

      await this.broadcastPrivateOp()
    } finally {
      this.privateOpInFlight = false
      this.emitUpdate()
    }
  }

  async broadcastPrivateOp(): Promise<void> {
    let errorMessage: string | undefined
    this.state = 'unshielding'
    this.emitUpdate()
    try {
      if (!this.#instance) throw new Error('RailgunV2 not initialized')
      if (!this.pendingPrivateOperation) throw new Error('No pending private operation')
      if (!this.#selectedAccount?.account) throw new Error('No account selected')

      // Track the op on the Railgun chain (DEFAULT_CHAIN_ID), not networks[0].
      const chainId = DEFAULT_CHAIN_ID
      // The SDK's broadcast() returns no tx hash, so we track the op with a
      // placeholder id. isRailgunWithdrawal stays true for both unshields and
      // internal transfers (matching the legacy controller); isRailgunInternalTransfer
      // distinguishes 0zk→0zk sends. The UI tracking layer keys off these tags.
      const placeholderId = `0x${randomId().toString(16)}` as `0x${string}`
      const meta = {
        isRailgunOperation: true,
        isRailgunWithdrawal: true,
        isRailgunInternalTransfer: this.#pendingOpIsInternalTransfer
      } as never
      this.latestBroadcastedAccountOp = {
        accountAddr: this.#selectedAccount.account.addr,
        chainId,
        signingKeyAddr: null,
        signingKeyType: null,
        gasLimit: null,
        gasFeePayment: null,
        nonce: 0n,
        signature: placeholderId,
        accountOpToExecuteBefore: null,
        calls: [],
        status: AccountOpStatus.BroadcastedButNotConfirmed,
        txnId: placeholderId,
        meta
      }
      this.emitUpdate()

      // Snapshot shielded balances (keyed by erc20 contract) before broadcast so
      // we can confirm funds actually moved afterwards.
      const sumByContract = (bals: RailgunBalance[]) => {
        const m = new Map<string, bigint>()
        bals.forEach((b) => {
          // eslint-disable-next-line no-underscore-dangle
          const key = b.asset.__type === 'erc20' ? b.asset.contract : b.asset.__type
          m.set(key, (m.get(key) ?? 0n) + b.amount)
        })
        return m
      }
      const balanceBefore = sumByContract(this.balance)

      await this.#withWasmLock(() => this.#instance!.broadcast(this.pendingPrivateOperation!))
      this.pendingPrivateOperation = null

      // The SDK's broadcast() resolves once the userOp gets a receipt — even if it
      // reverted on-chain (the WETH relay fee is charged regardless). Confirm the
      // tracked asset dropped before marking success: assetKey is the erc20 (or the
      // wrapped base token for a native unshield), with a rare "any token dropped"
      // fallback only if it couldn't be resolved.
      const assetKey = this.#pendingOpAssetKey
      const didFundsMove = (after: Map<string, bigint>) =>
        assetKey
          ? (after.get(assetKey) ?? 0n) < (balanceBefore.get(assetKey) ?? 0n)
          : [...balanceBefore].some(([key, before]) => (after.get(key) ?? 0n) < before)

      // The post-broadcast balance can lag the on-chain spend by a sync cycle, so
      // refresh a few times before concluding nothing moved — otherwise a slow
      // indexer false-fails a successful op. We refresh balance() directly here
      // rather than sync() (which is gated by privateOpInFlight); balance() still
      // syncs the provider internally.
      let fundsMoved = false
      for (let attempt = 0; attempt < 3; attempt += 1) {
        this.balance = await this.#withWasmLock(() => this.#instance!.balance(undefined))
        this.emitUpdate()
        if (didFundsMove(sumByContract(this.balance))) {
          fundsMoved = true
          break
        }
        if (attempt < 2) await wait(2000)
      }
      if (!fundsMoved) {
        throw new Error(
          'Unshield/transfer did not move funds — the operation reverted on-chain ' +
            '(the relay fee was still charged).'
        )
      }

      const submittedOp: SubmittedAccountOp = {
        ...this.latestBroadcastedAccountOp,
        nonce: 0n,
        status: AccountOpStatus.Success,
        // Reused from privacy-pools: routes the relayer-style tracking that fits
        // Railgun's relay model (no user-signed on-chain tx). `identifier` is a
        // placeholder — the SDK's broadcast() returns no userOp/tx hash — so the UI
        // must not render an explorer link off it (see TransferScreen.explorerLink).
        // A dedicated Railgun identifiedBy type would need adding to the enum + the
        // tracking helpers; left as a follow-up.
        identifiedBy: { type: 'PrivacyPoolsRelayer', identifier: placeholderId },
        timestamp: Date.now(),
        meta
      }
      await this.#activity.addAccountOp(submittedOp)

      if (this.latestBroadcastedAccountOp) {
        this.latestBroadcastedAccountOp = {
          ...this.latestBroadcastedAccountOp,
          status: AccountOpStatus.Success
        }
      }
    } catch (error) {
      errorMessage = (error as Error).message
      if (this.latestBroadcastedAccountOp) {
        this.latestBroadcastedAccountOp = {
          ...this.latestBroadcastedAccountOp,
          status: AccountOpStatus.Failure
        }
      }
    } finally {
      this.state = 'idle'
      this.lastOperation = { op: 'unshielding', error: errorMessage }
      this.emitUpdate()
    }
  }

  async saveState(): Promise<void> {
    await this.#pluginStorage?.saveToStorage()
  }

  destroy(): void {
    this.#subs.forEach((u) => u())
    this.#subs = []
    this.reset()
  }

  reset(emitUpdate = true): void {
    this.destroySignAccountOp()
    this.#instance = null
    this.#pluginStorage = null
    this.pendingPrivateOperation = null
    this.balance = []
    this.zkAddress = null
    this.syncState = 'unsynced'
    this.isInitialized = false
    this.initializationError = null
    this.state = 'idle'
    if (emitUpdate) {
      this.emitUpdate()
    }
  }
}

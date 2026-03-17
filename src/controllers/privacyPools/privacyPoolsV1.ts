/* eslint-disable no-await-in-loop */
import {
  createPPv1Plugin,
  createPPv1Broadcaster,
  OxBowAspService,
  PrivacyPoolsV1_0xBow,
  E_ADDRESS
} from '@kohaku-eth/privacy-pools'
import type {
  PPv1AssetBalance,
  PPv1Instance,
  PPv1AssetAmount,
  PPv1Address
} from '@kohaku-eth/privacy-pools'
import type { Storage as PluginStorage, Host } from '@kohaku-eth/plugins'
import { ZERO_ADDRESS } from '../../services/socket/constants'
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
import * as sepoliaState from './state.json'

const BROADCASTER_URL = 'https://fastrelay.xyz/relayer'

const PLUGIN_STORAGE_KEY = 'privacyPoolsV1PluginStorage'

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

export type SyncState = 'unsynced' | 'syncing' | 'synced'
export type State = 'idle' | 'shielding' | 'preparing-unshield' | 'unshielding'
export interface OpStatus {
  op: Exclude<State, 'idle'>
  error?: string
}
export type INote = Awaited<ReturnType<PPv1Instance['notes']>>[number]
export type PendingUnshieldOperation = Awaited<ReturnType<PPv1Instance['prepareUnshield']>>

export class PrivacyPoolsV1Controller extends EventEmitter {
  #keystore: KeystoreController

  #networks: NetworksController

  #selectedAccount: SelectedAccountController

  #storageController: StorageController

  #accounts: AccountsController

  #providers: ProvidersController

  #portfolio: PortfolioController

  #activity: ActivityController

  #externalSignerControllers: ExternalSignerControllers

  #pluginStorage: PersistablePluginStorage | null = null

  #currentAccountAddr: string | null = null

  #subs: (() => void)[] = []

  #ppv1Instance: PPv1Instance | null = null

  #host: Host | null = null

  #signAccountOpSubscriptions: Function[] = []

  pendingUnshieldOperation: PendingUnshieldOperation | null = null

  #reestimateAbortController: AbortController | null = null

  balance: PPv1AssetBalance[] = []

  notes: INote[] = []

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
    externalSignerControllers: ExternalSignerControllers
  ) {
    super()

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
          // eslint-disable-next-line @typescript-eslint/no-floating-promises
          this.init()
        } else {
          this.#currentAccountAddr = newAddr
          // Retry init when portfolio loads for the first time (empty storage on first run)
          if (!this.isInitialized && !this.initializationError) {
            // eslint-disable-next-line @typescript-eslint/no-floating-promises
            this.init()
          }
        }
      }),
      this.#keystore.onUpdate(() => {
        if (!this.#ppv1Instance && this.#keystore.isUnlocked) {
          // eslint-disable-next-line @typescript-eslint/no-floating-promises
          this.init()
        }
      })
    )
  }

  async init(): Promise<void> {
    this.#currentAccountAddr = this.#selectedAccount.account?.addr ?? null
    this.reset(false)

    try {
      this.#pluginStorage = await createPluginStorage(this.#storageController)
      // I Couldn't find a better way to check the current chainId
      const chainId = this.#selectedAccount.portfolio.tokens.at(0)?.chainId
      if (!chainId) {
        // Portfolio not loaded yet (e.g. first run with empty storage).
        // Return without setting initializationError so the selectedAccount
        // subscription can retry once the portfolio arrives.
        this.emitUpdate()
        return
      }

      const host = await hostFactory(
        this.#keystore,
        this.#networks,
        this.#selectedAccount,
        chainId,
        this.#pluginStorage
      )
      this.#host = host

      const entrypointConfig =
        PrivacyPoolsV1_0xBow[Number(chainId) as keyof typeof PrivacyPoolsV1_0xBow]
      if (!entrypointConfig)
        throw new Error(
          `No entrypoint config found in privacy-pools package for chainId ${chainId}`
        )

      this.#ppv1Instance = createPPv1Plugin(host, {
        initialState: sepoliaState as never,
        accountIndex: 0,
        entrypoint: {
          address: BigInt(entrypointConfig.entrypoint.entrypointAddress),
          deploymentBlock: entrypointConfig.entrypoint.deploymentBlock
        },
        broadcasterUrl: BROADCASTER_URL,
        aspServiceFactory: () =>
          new OxBowAspService({ network: host.network, aspUrl: 'https://dw.0xbow.io' })
      })

      this.isInitialized = true
    } catch (e: any) {
      this.initializationError = e?.message ?? 'Unknown error during ppv1 initialization'
    }

    this.emitUpdate()
  }

  async sync(): Promise<void> {
    if (!this.#ppv1Instance || this.syncState === 'syncing') return

    this.syncState = 'syncing'
    this.emitUpdate()

    this.balance = (await this.#ppv1Instance.balance([])).map((a) =>
      a.asset.contract === E_ADDRESS ? { ...a, asset: { ...a.asset, contract: ZERO_ADDRESS } } : a
    )
    this.notes = (await this.#ppv1Instance.notes([])).map((n) =>
      n.assetAddress === BigInt(E_ADDRESS) ? { ...n, assetAddress: BigInt(0) } : n
    )
    await this.#pluginStorage?.saveToStorage()

    this.syncState = 'synced'
    this.emitUpdate()
  }

  async prepareShield(assetAmount: PPv1AssetAmount): Promise<void> {
    if (!this.#ppv1Instance) throw new Error('PrivacyPoolsV1 not initialized')

    this.state = 'shielding'
    this.emitUpdate()

    const parsedAsset: PPv1AssetAmount =
      assetAmount.asset.contract === ZERO_ADDRESS
        ? {
            ...assetAmount,
            asset: {
              contract: E_ADDRESS,
              __type: 'erc20'
            }
          }
        : assetAmount

    const { txns } = await this.#ppv1Instance.prepareShield(parsedAsset)

    const calls: Call[] = txns.map((txn) => ({
      to: txn.to as `0x${string}`,
      value: txn.value,
      data: txn.data as `0x${string}`
    }))

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

    const chainId = BigInt(this.#networks.networks[0].chainId)
    const network = this.#networks.networks.find((net) => net.chainId === chainId)
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
      // eslint-disable-next-line no-await-in-loop
      await wait(30000)

      while (!signal.aborted) {
        if (signal.aborted) break

        if (this.signAccountOpController?.estimation.status !== EstimationStatus.Loading) {
          // eslint-disable-next-line no-await-in-loop
          await this.signAccountOpController?.estimate()
        }

        // eslint-disable-next-line no-await-in-loop
        await wait(30000)
        if (signal.aborted) break
      }
    }

    void loop()
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

  async prepareUnshield(assetAmount: PPv1AssetAmount, to: PPv1Address): Promise<void> {
    const parsedAsset: PPv1AssetAmount =
      assetAmount.asset.contract === ZERO_ADDRESS
        ? {
            ...assetAmount,
            asset: {
              contract: E_ADDRESS,
              __type: 'erc20'
            }
          }
        : assetAmount
    let errorMessage: string | undefined
    this.state = 'preparing-unshield'
    this.emitUpdate()
    try {
      if (!this.#ppv1Instance) throw new Error('PrivacyPoolsV1 not initialized')

      this.pendingUnshieldOperation = await this.#ppv1Instance.prepareUnshield(parsedAsset, to)
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

  async unshield(): Promise<void> {
    let errorMessage: string | undefined
    this.state = 'unshielding'
    this.emitUpdate()
    try {
      if (!this.#ppv1Instance || !this.#host) throw new Error('PrivacyPoolsV1 not initialized')
      if (!this.pendingUnshieldOperation) throw new Error('No pending unshield operation')
      if (!this.#selectedAccount?.account) throw new Error('No account selected')

      const chainId = BigInt(this.#networks.networks[0].chainId)
      const placeholderId = `0x${randomId().toString(16)}` as `0x${string}`
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
        meta: {
          isPrivacyPoolsWithdrawal: true
        } as never
      }
      this.emitUpdate()

      const broadcaster = createPPv1Broadcaster(this.#host, { broadcasterUrl: BROADCASTER_URL })
      const broadcastResult = await broadcaster.broadcast(this.pendingUnshieldOperation)
      this.pendingUnshieldOperation = null

      // Update latestBroadcastedAccountOp with real txHash now that we have it
      if (this.latestBroadcastedAccountOp) {
        this.latestBroadcastedAccountOp = {
          ...this.latestBroadcastedAccountOp,
          signature: broadcastResult.txHash,
          txnId: broadcastResult.txHash
        }
      }

      await this.sync()

      const submittedOp: SubmittedAccountOp = {
        ...this.latestBroadcastedAccountOp,
        nonce: 0n,
        signature: broadcastResult.txHash,
        status: AccountOpStatus.Success,
        txnId: broadcastResult.txHash,
        identifiedBy: { type: 'PrivacyPoolsRelayer', identifier: broadcastResult.txHash },
        timestamp: Date.now(),
        meta: {
          isPrivacyPoolsWithdrawal: true
        } as never
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
    this.#ppv1Instance = null
    this.#host = null
    this.#pluginStorage = null
    this.pendingUnshieldOperation = null
    this.balance = []
    this.syncState = 'unsynced'
    this.isInitialized = false
    this.initializationError = null
    this.state = 'idle'
    if (emitUpdate) {
      this.emitUpdate()
    }
  }
}

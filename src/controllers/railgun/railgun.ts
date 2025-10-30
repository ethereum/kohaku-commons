/* eslint-disable no-console */
import type { Hex } from 'viem'
import { JsonRpcProvider, type Log } from 'ethers'
import EventEmitter from '../eventEmitter/eventEmitter'
import { SignAccountOpController } from '../signAccountOp/signAccountOp'
import { AccountOp } from '../../libs/accountOp/accountOp'
import { Call } from '../../libs/accountOp/types'
import { AddressState } from '../../interfaces/domains'
import { AccountsController } from '../accounts/accounts'
import { KeystoreController } from '../keystore/keystore'
import { SelectedAccountController } from '../selectedAccount/selectedAccount'
import { NetworksController } from '../networks/networks'
import { ProvidersController } from '../providers/providers'
import { PortfolioController } from '../portfolio/portfolio'
import { ActivityController } from '../activity/activity'
import { StorageController } from '../storage/storage'
import { ExternalSignerControllers } from '../../interfaces/keystore'
import { getBaseAccount } from '../../libs/account/getBaseAccount'
import { getAmbirePaymasterService } from '../../libs/erc7677/erc7677'
import { randomId } from '../../libs/humanizer/utils'
import { getPrivateKeyFromSeed } from '../../libs/keyIterator/keyIterator'
import { HD_PATH_TEMPLATE_TYPE, BIP44_STANDARD_DERIVATION_TEMPLATE } from '../../consts/derivation'
import { EstimationStatus } from '../estimation/types'
import wait from '../../utils/wait'
import {
  RailgunAccount,
  getAllLogs,
  RAILGUN_CONFIG_BY_CHAIN_ID
} from '@kohaku-eth/railgun'

interface RailgunFormUpdate {
  depositAmount?: string
  privacyProvider?: string
  chainId?: number
}

export type RailgunAccountKeys = {
  spendingKey: string
  viewingKey: string
  shieldKeySigner: string
}

export type RailgunBalance = {
  chainId: number
  tokenType: 'native' | 'erc20'
  tokenAddress?: string
  amount: string // base units
  source: 'railgun'
}

type RailgunAccountCache = {
  merkleTrees: {tree: string[][], nullifiers: string[]}[]
  noteBooks: any[][] // SerializedNoteData[][] from railgun-logic
  lastSyncedBlock: number
}

export type RailgunAccountSyncState = {
  status: 'idle' | 'loading-cache' | 'syncing' | 'ready' | 'error'
  balances: RailgunBalance[]
  lastSyncedBlock?: number
  error?: string
}

const DEFAULT_ADDRESS_STATE = {
  fieldValue: '',
  ensAddress: '',
  isDomainResolving: false
}

export class RailgunController extends EventEmitter {
  #accounts: AccountsController | null = null

  #keystore: KeystoreController | null = null

  #selectedAccount: SelectedAccountController | null = null

  #storage: StorageController

  #networks: NetworksController

  #providers: ProvidersController

  #portfolio: PortfolioController

  #activity: ActivityController

  #externalSignerControllers: ExternalSignerControllers

  #relayerUrl: string

  #signAccountOpSubscriptions: Function[] = []

  #reestimateAbortController: AbortController | null = null

  #isInitialized: boolean = false

  #initializationError: string | null = null

  #initialPromise: Promise<void> | null = null

  #initialPromiseLoaded: boolean = false

  shouldTrackLatestBroadcastedAccountOp: boolean = true

  signAccountOpController: SignAccountOpController | null = null

  latestBroadcastedAccountOp: AccountOp | null = null

  hasProceeded: boolean = false

  depositAmount: string = ''

  privacyProvider: string = 'railgun'

  chainId: number = 11155111 // Default to Sepolia

  addressState: AddressState = { ...DEFAULT_ADDRESS_STATE }

  #selectedToken: any = null

  // Transfer/Withdrawal-specific properties (kept for interface compatibility)
  amountInFiat: string = ''

  amountFieldMode: 'token' | 'fiat' = 'token'

  isRecipientAddressUnknown: boolean = false

  isRecipientAddressUnknownAgreed: boolean = false

  latestBroadcastedToken: any = null

  programmaticUpdateCounter: number = 0

  withdrawalAmount: string = ''

  maxAmount: string = ''

  currentRailgunKeys: RailgunAccountKeys | null = null

  // Account sync state
  accountSyncState: RailgunAccountSyncState = {
    status: 'idle',
    balances: []
  }

  validationFormMsgs: {
    amount: { success: boolean; message: string }
    recipientAddress: { success: boolean; message: string }
  } = {
    amount: { success: true, message: '' },
    recipientAddress: { success: true, message: '' }
  }

  constructor(
    keystore: KeystoreController,
    accounts: AccountsController,
    networks: NetworksController,
    providers: ProvidersController,
    selectedAccount: SelectedAccountController,
    portfolio: PortfolioController,
    activity: ActivityController,
    storage: StorageController,
    externalSignerControllers: ExternalSignerControllers,
    relayerUrl: string
  ) {
    super()

    this.#keystore = keystore
    this.#accounts = accounts
    this.#networks = networks
    this.#providers = providers
    this.#selectedAccount = selectedAccount
    this.#portfolio = portfolio
    this.#activity = activity
    this.#storage = storage
    this.#externalSignerControllers = externalSignerControllers
    this.#relayerUrl = relayerUrl

    this.#initialPromise = this.#load()

    this.emitUpdate()
  }

  async #load() {
    // Minimal initialization for Railgun
    // Railgun-specific SDK and configuration will be added here later
    await this.#selectedAccount?.initialLoadPromise
    this.#initialPromiseLoaded = true
  }

  async #getRailgunKeysInternal(index: number): Promise<RailgunAccountKeys> {
    const RAILGUN_VIEWING_DERIVATION_TEMPLATE = "m/420'/1984'/0'/0'/<account>'" as HD_PATH_TEMPLATE_TYPE
    const RAILGUN_SPENDING_DERIVATION_TEMPLATE = "m/44'/1984'/0'/0'/<account>'" as HD_PATH_TEMPLATE_TYPE
    
    console.log('DEBUG: RAILGUN: GET SEED PHRASE');
    const seedPhrase = await this.#getCurrentAccountSeed()

    if (!seedPhrase) {
      throw new Error('No seed phrase available for key derivation')
    } else {
      console.log('DEBUG: RAILGUN: SEED PHRASE FOUND');
    }

    const viewingKey = getPrivateKeyFromSeed(seedPhrase, null, index, RAILGUN_VIEWING_DERIVATION_TEMPLATE)
    const spendingKey = getPrivateKeyFromSeed(seedPhrase, null, index, RAILGUN_SPENDING_DERIVATION_TEMPLATE)
    const shieldKeySigner = getPrivateKeyFromSeed(seedPhrase, null, 0, BIP44_STANDARD_DERIVATION_TEMPLATE)
    
    return {spendingKey, viewingKey, shieldKeySigner};
  }

  async #getCurrentAccountSeed(): Promise<string | null> {
    try {
      if (!this.#selectedAccount?.account || !this.#keystore?.isUnlocked) {
        return null
      }

      const accountKeys = this.#keystore.getAccountKeys(this.#selectedAccount.account)

      const internalKey = accountKeys.find((key) => key.type === 'internal' && key.meta?.fromSeedId)

      if (!internalKey?.meta?.fromSeedId) {
        return null
      }

      const savedSeed = await this.#keystore.getSavedSeed(internalKey.meta.fromSeedId)
      return savedSeed?.seed || null
    } catch (error) {
      console.error('Failed to get current account seed:', error)
      return null
    }
  }

  async #initSignAccOp(calls: Call[]) {
    if (!this.#selectedAccount?.account || this.signAccountOpController || !this.#accounts) return
    // Use the network from the first call to determine the chainId
    const chainId = calls.length > 0 ? BigInt(11155111) : 11155111n // Default to Sepolia for now
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
        paymasterService: getAmbirePaymasterService(baseAcc, this.#relayerUrl)
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
      randomId(), // the account op and the action are fabricated
      accountOp,
      () => true,
      false,
      undefined
    )

    // propagate updates from signAccountOp here
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

    this.reestimate()
  }

  async reestimate() {
    // Don't run the estimation loop if there is no SignAccountOpController or if the loop is already running.
    if (!this.signAccountOpController || this.#reestimateAbortController) return

    this.#reestimateAbortController = new AbortController()
    const signal = this.#reestimateAbortController!.signal

    const loop = async () => {
      while (!signal.aborted) {
        // eslint-disable-next-line no-await-in-loop
        await wait(30000)
        if (signal.aborted) break

        if (this.signAccountOpController?.estimation.status !== EstimationStatus.Loading) {
          // eslint-disable-next-line no-await-in-loop
          await this.signAccountOpController?.estimate()
        }

        if (this.signAccountOpController?.estimation.errors.length) {
          console.log(
            'DEBUG: Errors on Railgun re-estimate',
            this.signAccountOpController.estimation.errors
          )
        }
      }
    }

    loop()
  }

  async getRailgunKeys(index: number): Promise<RailgunAccountKeys> {
    if (!this.currentRailgunKeys) {
      this.currentRailgunKeys = await this.#getRailgunKeysInternal(index)
    }
    return this.currentRailgunKeys
  }

  async syncSignAccountOp(calls?: Call[]) {
    if (!this.#selectedAccount?.account) return

    // Build the calls based on your privacy pools operations
    const transactionCalls: Call[] = calls || []

    if (!transactionCalls.length) return

    try {
      // IMPORTANT: Enable tracking for the upcoming broadcast
      // This flag is checked in main.ts handleSignAndBroadcastAccountOp() to determine
      // whether to set latestBroadcastedAccountOp after successful broadcast
      this.shouldTrackLatestBroadcastedAccountOp = true

      // If SignAccountOpController is already initialized, we just update it
      if (this.signAccountOpController) {
        this.signAccountOpController.update({ calls: transactionCalls })

        // // Update withdrawal metadata if we have pending withdrawal
        // if (this.#pendingWithdrawalParams) {
        //   if (!this.signAccountOpController.accountOp.meta) {
        //     this.signAccountOpController.accountOp.meta = {}
        //   }
        //   // @ts-ignore - Custom meta property for privacy pools withdrawal
        //   this.signAccountOpController.accountOp.meta.withdrawalData = {
        //     chainId: this.#pendingWithdrawalParams.chainId,
        //     poolAddress: this.#pendingWithdrawalParams.poolAddress,
        //     recipient: this.#pendingWithdrawalParams.recipient,
        //     totalAmount: this.#pendingWithdrawalParams.totalAmount,
        //     isPrivacyPoolsWithdrawal: true
        //   }
        // }

        return
      }

      await this.#initSignAccOp(transactionCalls)
    } catch (error) {
      this.emitError({
        level: 'major',
        message: 'Failed to initialize transaction signing',
        error: error instanceof Error ? error : new Error('Unknown error in syncSignAccountOp')
      })
    }
  }

  update({ depositAmount, privacyProvider, chainId }: RailgunFormUpdate) {
    console.log('DEBUG: RAILGUN CONTROLLER UPDATE', { depositAmount, privacyProvider, chainId })

    if (typeof depositAmount === 'string') {
      this.depositAmount = depositAmount
    }

    if (typeof privacyProvider === 'string') {
      this.privacyProvider = privacyProvider
    }

    if (typeof chainId === 'number') {
      this.chainId = chainId
    }

    this.emitUpdate()
  }

  unloadScreen(forceUnload?: boolean) {
    if (this.hasPersistedState && !forceUnload) return

    this.destroyLatestBroadcastedAccountOp()
    this.resetForm()
  }

  /**
   * Resets all form state including initialization status.
   * Use this for complete controller reset (e.g., when unloading screen).
   */
  resetForm(shouldDestroyAccountOp = true) {
    this.selectedToken = null
    this.depositAmount = ''
    this.withdrawalAmount = ''
    this.addressState = { ...DEFAULT_ADDRESS_STATE }
    this.amountInFiat = ''
    this.amountFieldMode = 'token'
    this.isRecipientAddressUnknown = false
    this.isRecipientAddressUnknownAgreed = false
    this.latestBroadcastedToken = null
    this.programmaticUpdateCounter = 0
    this.validationFormMsgs = {
      amount: { success: true, message: '' },
      recipientAddress: { success: true, message: '' }
    }
    this.#isInitialized = false

    if (shouldDestroyAccountOp) {
      this.destroySignAccountOp()
    }

    this.emitUpdate()
  }

  destroySignAccountOp() {
    // Unsubscribe from all previous subscriptions
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
  }

  destroyLatestBroadcastedAccountOp() {
    this.shouldTrackLatestBroadcastedAccountOp = false
    this.latestBroadcastedAccountOp = null
    this.emitUpdate()
  }

  setSdkInitialized() {
    this.#isInitialized = true
    this.#initializationError = null

    this.emitUpdate()
  }

  setUserProceeded(hasProceeded: boolean) {
    this.hasProceeded = hasProceeded
    this.emitUpdate()
  }

  set selectedToken(token: any) {
    this.#selectedToken = token
  }

  get selectedToken() {
    return this.#selectedToken
  }

  get isInitialized(): boolean {
    return this.#isInitialized
  }

  get initializationError(): string | null {
    return this.#initializationError
  }

  get initialPromiseLoaded(): boolean {
    return this.#initialPromiseLoaded
  }

  get hasPersistedState() {
    return !!this.depositAmount
  }

  get recipientAddress() {
    return this.addressState.ensAddress || this.addressState.fieldValue
  }

  /**
   * Load and sync Railgun account (orchestrator method)
   * This handles the complete flow: load from cache → sync from RPC → save to cache
   */
  async loadAndSyncRailgunAccount(opts: { identity: string; chainId: number }): Promise<void> {
    const { identity, chainId } = opts

    try {
      this.accountSyncState = { ...this.accountSyncState, status: 'loading-cache' }
      this.emitUpdate()

      // 1. Try to load from cache first (fast path)
      const cached = await this.loadAccountFromCache({ identity, chainId })

      let baseAccount: RailgunAccount
      let fromBlock: number | undefined

      if (cached) {
        baseAccount = cached.account
        fromBlock = cached.lastSyncedBlock

        // Show cached balances optimistically
        const cachedBalances = await this.getBalancesFromAccount({
          account: cached.account,
          chainId
        })

        this.accountSyncState = {
          status: 'syncing',
          balances: cachedBalances,
          lastSyncedBlock: cached.lastSyncedBlock
        }
        this.emitUpdate()
      } else {
        const raw = await this.getOrCreateRailgunAccount({ identity, chainId })
        baseAccount = raw.account

        this.accountSyncState = { ...this.accountSyncState, status: 'syncing' }
        this.emitUpdate()
      }

      // 2. Background sync from RPC
      const synced = await this.syncAccountFromRPC({ account: baseAccount, chainId, fromBlock })

      // 3. Get updated balances
      const balances = await this.getBalancesFromAccount({
        account: synced.account,
        chainId
      })

      // 4. Save to cache
      await this.saveAccountToCache({
        identity,
        chainId,
        account: synced.account,
        lastSyncedBlock: synced.lastSyncedBlock
      })

      this.accountSyncState = {
        status: 'ready',
        balances,
        lastSyncedBlock: synced.lastSyncedBlock
      }
      this.emitUpdate()

      console.log('DEBUG: Auto-sync completed', {
        lastSyncedBlock: synced.lastSyncedBlock,
        balanceCount: balances.length
      })
    } catch (error) {
      console.error('DEBUG: Auto-sync failed', error)
      this.accountSyncState = {
        status: 'error',
        balances: [],
        error: error instanceof Error ? error.message : 'Failed to sync account'
      }
      this.emitUpdate()
    }
  }

  // ==================== RAILGUN ACCOUNT MANAGEMENT ====================
  // These methods handle account creation, caching, and syncing for Railgun accounts

  /**
   * Helper: Generate a stable storage key for a given identity + chainId
   */
  #getRailgunCacheKey(identity: string, chainId: number): string {
    return `railgun:account:${identity}:${chainId}`
  }

  /**
   * 1) Get or create a Railgun account (raw, in-memory)
   * Does NOT load from cache or scan RPC — just derives/creates the account object.
   *
   * @param identity - The viewing key, Railgun address, or account index to derive from
   * @param chainId - The chain ID for this Railgun account
   * @returns The raw RailgunAccount instance
   */
  async getOrCreateRailgunAccount(opts: {
    identity: string
    chainId: number
  }): Promise<{ account: RailgunAccount }> {
    const { identity, chainId } = opts

    // Parse identity as an account index (default to 0 if not a valid number)
    const accountIndex = parseInt(identity, 10) || 0

    // Reuse existing key derivation logic
    const keys = await this.#getRailgunKeysInternal(accountIndex)

    // Create RailgunAccount from the derived keys
    const account = RailgunAccount.fromPrivateKeys(
      keys.spendingKey,
      keys.viewingKey,
      BigInt(chainId),
      keys.shieldKeySigner
    )

    return { account }
  }

  /**
   * 2) Load serialized account from storage (fast path)
   * Reconstructs the RailgunAccount from cached merkle trees and notebooks.
   *
   * @param identity - The viewing key, Railgun address, or account index
   * @param chainId - The chain ID for this Railgun account
   * @returns The cached account and last synced block, or null if not found
   */
  async loadAccountFromCache(opts: {
    identity: string
    chainId: number
  }): Promise<{ account: RailgunAccount; lastSyncedBlock: number } | null> {
    const { identity, chainId } = opts

    const cacheKey = this.#getRailgunCacheKey(identity, chainId)
    const cached = await this.#storage.get(cacheKey, null as RailgunAccountCache | null)

    if (!cached) {
      return null
    }

    // First create a fresh account
    const { account } = await this.getOrCreateRailgunAccount({ identity, chainId })

    // Then load cached data into it
    await account.loadCachedMerkleTrees(cached.merkleTrees)
    await account.loadCachedNoteBooks(cached.noteBooks)

    return {
      account,
      lastSyncedBlock: cached.lastSyncedBlock
    }
  }

  /**
   * 3) Scan RPC from last sync (slow path)
   * Fetches new logs from the blockchain and syncs the account to the latest block.
   *
   * @param account - The RailgunAccount instance to sync
   * @param chainId - The chain ID to sync against
   * @param fromBlock - Optional starting block (uses account's last sync if not provided)
   * @returns The updated account and the new lastSyncedBlock
   */
  async syncAccountFromRPC(opts: {
    account: RailgunAccount
    chainId: number
    fromBlock?: number
  }): Promise<{ account: RailgunAccount; lastSyncedBlock: number }> {
    const { account, chainId, fromBlock } = opts

    // Get the provider for this chain
    const provider = this.#providers.providers[chainId.toString()]
    if (!provider) {
      throw new Error(`No provider available for chainId ${chainId}`)
    }

    // Convert to ethers JsonRpcProvider if needed
    const ethersProvider = new JsonRpcProvider(provider._getConnection().url)

    // Determine start block
    const config = RAILGUN_CONFIG_BY_CHAIN_ID[chainId.toString() as keyof typeof RAILGUN_CONFIG_BY_CHAIN_ID]
    if (!config) {
      throw new Error(`Railgun not supported on chainId ${chainId}`)
    }

    const startBlock = fromBlock ?? config.GLOBAL_START_BLOCK
    const endBlock = await ethersProvider.getBlockNumber()

    console.log(`DEBUG: Syncing Railgun account from block ${startBlock} to ${endBlock}...`)

    // Fetch logs
    const logs = await getAllLogs(ethersProvider, BigInt(chainId), startBlock, endBlock)

    console.log(`DEBUG: Found ${logs.length} new Railgun logs`)

    // Sync the account with the logs
    if (logs.length > 0) {
      await account.syncWithLogs(logs)
    }

    return {
      account,
      lastSyncedBlock: endBlock
    }
  }

  /**
   * 4) Save back to storage
   * Serializes the account's merkle trees and notebooks and persists them.
   *
   * @param identity - The viewing key, Railgun address, or account index
   * @param chainId - The chain ID for this Railgun account
   * @param account - The RailgunAccount to serialize
   * @param lastSyncedBlock - The latest synced block number
   */
  async saveAccountToCache(opts: {
    identity: string
    chainId: number
    account: RailgunAccount
    lastSyncedBlock: number
  }): Promise<void> {
    const { identity, chainId, account, lastSyncedBlock } = opts

    const cacheKey = this.#getRailgunCacheKey(identity, chainId)

    const cacheData: RailgunAccountCache = {
      merkleTrees: account.serializeMerkleTrees(),
      noteBooks: account.serializeNoteBooks(),
      lastSyncedBlock
    }

    await this.#storage.set(cacheKey, cacheData)
    console.log(`DEBUG: Saved Railgun account cache for ${identity} on chain ${chainId}`)
  }

  /**
   * 5) Get balances from account (optional but useful)
   * Retrieves all token balances from a synced Railgun account.
   *
   * @param account - The synced RailgunAccount
   * @param chainId - The chain ID
   * @returns Array of balance objects in a generic format for the UI
   */
  async getBalancesFromAccount(opts: {
    account: RailgunAccount
    chainId: number
  }): Promise<RailgunBalance[]> {
    const { account, chainId } = opts

    // Get native (WETH) balance
    // In Railgun, native ETH is represented as WETH internally
    const nativeBalance = await account.getBalance()

    const balances: RailgunBalance[] = []

    if (nativeBalance > 0n) {
      balances.push({
        chainId,
        tokenType: 'native',
        amount: nativeBalance.toString(),
        source: 'railgun'
      })
    }

    // TODO: Add support for ERC20 tokens when needed
    // This would involve calling account.getBalance(tokenAddress) for each token

    return balances
  }

  toJSON() {
    return {
      ...this,
      ...super.toJSON(),
      isInitialized: this.isInitialized,
      initialPromiseLoaded: this.initialPromiseLoaded,
      hasPersistedState: this.hasPersistedState,
      selectedToken: this.selectedToken,
      recipientAddress: this.recipientAddress
    }
  }
}

// ==================== USAGE EXAMPLE ====================
// This shows the correct sequence for using the Railgun account management methods.
// The React context should orchestrate these calls in this order:
//
// const identity = '0'; // Account index or viewing key
// const chainId = 11155111; // Sepolia
//
// // 1. Try to load from cache first (fast path)
// const cached = await controller.loadAccountFromCache({ identity, chainId });
//
// // 2. If no cache, create a raw account
// let baseAccount: RailgunAccount;
// let fromBlock: number | undefined;
// if (cached) {
//   baseAccount = cached.account;
//   fromBlock = cached.lastSyncedBlock;
// } else {
//   const raw = await controller.getOrCreateRailgunAccount({ identity, chainId });
//   baseAccount = raw.account;
// }
//
// // 3. Sync from RPC to get latest state
// const synced = await controller.syncAccountFromRPC({
//   account: baseAccount,
//   chainId,
//   fromBlock
// });
//
// // 4. Save back to storage for next time
// await controller.saveAccountToCache({
//   identity,
//   chainId,
//   account: synced.account,
//   lastSyncedBlock: synced.lastSyncedBlock
// });
//
// // 5. Get balances to display in UI
// const balances = await controller.getBalancesFromAccount({
//   account: synced.account,
//   chainId
// });
//
// console.log('Railgun balances:', balances);

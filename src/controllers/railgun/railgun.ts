/* eslint-disable no-console */
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
import { validatePrivacyPoolsDepositAmount } from '../../services/privacyPools/validations'
import { formatUnits, parseUnits } from 'viem'
import wait from '../../utils/wait'
import { relayerCall } from '../../libs/relayerCall/relayerCall'
import { Fetch } from '../../interfaces/fetch'
import { AccountOpStatus } from '../../libs/accountOp/types'
import { SubmittedAccountOp } from '../../libs/accountOp/submittedAccountOp'

interface RailgunFormUpdate {
  depositAmount?: string
  privacyProvider?: string
  chainId?: number
  selectedToken?: any
}

export type RailgunAccountKeys = {
  spendingKey: string
  viewingKey: string
  shieldKeySigner: string
}

/**
 * This is the shape we’ll persist to extension storage.
 * The React layer will produce it from the real RailgunAccount and call
 * RAILGUN_CONTROLLER_SET_ACCOUNT_CACHE with it.
 */
export type RailgunAccountCache = {
  merkleTrees: any
  noteBooks: any
  lastSyncedBlock: number
}

export type RailgunAccountCacheFetch = {
  zkAddress: string
  chainId: number
  cache: RailgunAccountCache | null
  fetchedAt: number
}

const DEFAULT_ADDRESS_STATE = {
  fieldValue: '',
  ensAddress: '',
  isDomainResolving: false
}

const DEFAULT_VALIDATION_FORM_MSGS = {
  amount: {
    success: false,
    message: ''
  },
  recipientAddress: {
    success: false,
    message: ''
  }
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
  #fetch: Fetch
  #callRelayer: Function

  #signAccountOpSubscriptions: Function[] = []
  #reestimateAbortController: AbortController | null = null

  #isInitialized: boolean = false
  #initializationError: string | null = null
  #initialPromise: Promise<void> | null = null
  #initialPromiseLoaded: boolean = false

  #selectedToken: any = null

  // form-ish / UI-ish state we already had
  shouldTrackLatestBroadcastedAccountOp: boolean = true
  signAccountOpController: SignAccountOpController | null = null
  latestBroadcastedAccountOp: AccountOp | null = null
  hasProceeded: boolean = false
  depositAmount: string = ''
  privacyProvider: string = 'railgun'
  chainId: number = 11155111 // Sepolia
  addressState: AddressState = { ...DEFAULT_ADDRESS_STATE }
  amountInFiat: string = ''
  amountFieldMode: 'token' | 'fiat' = 'token'
  isRecipientAddressUnknown: boolean = false
  isRecipientAddressUnknownAgreed: boolean = false
  latestBroadcastedToken: any = null
  programmaticUpdateCounter: number = 0
  withdrawalAmount: string = ''
  maxAmount: string = ''
  withdrawAsWETH: boolean = false

  // railgun-specific
  defaultRailgunKeys: RailgunAccountKeys | null = null

  // every "get" must end up here so popup can see it
  derivedRailgunKeysByIndex: Record<number, RailgunAccountKeys> = {}
  lastFetchedRailgunAccountCache: RailgunAccountCacheFetch | null = null

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
    relayerUrl: string,
    fetch: Fetch
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
    this.#fetch = fetch

    // Bind relayer call function
    this.#callRelayer = relayerCall.bind({ url: relayerUrl, fetch })

    // old behaviour – we wait for selectedAccount to finish loading
    this.#initialPromise = this.#load()

    this.emitUpdate()
  }

  async #load() {
    await this.#selectedAccount?.initialLoadPromise
    this.#initialPromiseLoaded = true
  }

  // ─────────────────────────────────────────────
  // KEY DERIVATION (controller-only)
  // ─────────────────────────────────────────────
  async #getRailgunKeysInternal(index: number): Promise<RailgunAccountKeys> {
    const RAILGUN_VIEWING_DERIVATION_TEMPLATE =
      "m/420'/1984'/0'/0'/<account>'" as HD_PATH_TEMPLATE_TYPE
    const RAILGUN_SPENDING_DERIVATION_TEMPLATE =
      "m/44'/1984'/0'/0'/<account>'" as HD_PATH_TEMPLATE_TYPE

    console.log('DEBUG: RAILGUN: GET SEED PHRASE')
    const seedPhrase = await this.#getCurrentAccountSeed()

    if (!seedPhrase) {
      throw new Error('No seed phrase available for key derivation')
    }

    console.log('DEBUG: RAILGUN: SEED PHRASE FOUND')

    const viewingKey = getPrivateKeyFromSeed(
      seedPhrase,
      null,
      index,
      RAILGUN_VIEWING_DERIVATION_TEMPLATE
    )
    const spendingKey = getPrivateKeyFromSeed(
      seedPhrase,
      null,
      index,
      RAILGUN_SPENDING_DERIVATION_TEMPLATE
    )
    const shieldKeySigner = getPrivateKeyFromSeed(
      seedPhrase,
      null,
      index,
      BIP44_STANDARD_DERIVATION_TEMPLATE
    )

    return { spendingKey, viewingKey, shieldKeySigner }
  }

  async #getCurrentAccountSeed(): Promise<string | null> {
    try {
      if (!this.#selectedAccount?.account || !this.#keystore?.isUnlocked) {
        return null
      }

      const accountKeys = this.#keystore.getAccountKeys(this.#selectedAccount.account)
      const internalKey = accountKeys.find(
        (key) => key.type === 'internal' && key.meta?.fromSeedId
      )

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

  async getDefaultRailgunKeys(): Promise<RailgunAccountKeys> {
    if (!this.defaultRailgunKeys) {
      const keys = await this.#getRailgunKeysInternal(0)
      this.defaultRailgunKeys = keys
      this.derivedRailgunKeysByIndex[0] = keys
      this.emitUpdate()
    }
    return this.defaultRailgunKeys
  }

  async deriveRailgunKeys(index: number): Promise<RailgunAccountKeys> {
    console.log('[BG][RAILGUN] deriveRailgunKeys called', index)
    try {
      const res =
        index === 0 ? await this.getDefaultRailgunKeys() : await this.#getRailgunKeysInternal(index)
      console.log('[BG][RAILGUN] deriveRailgunKeys returning', res)
      this.derivedRailgunKeysByIndex[index] = res
      this.emitUpdate()
      return res
    } catch (err) {
      console.error('[BG][RAILGUN] deriveRailgunKeys failed', err)
      throw err
    }
  }

  // ─────────────────────────────────────────────
  // CACHE HELPERS (UI will call these)
  // ─────────────────────────────────────────────

  #getRailgunCacheKey(zkAddress: string, chainId: number): string {
    return `railgun:account:${zkAddress}:${chainId}`
  }

  async getRailgunAccountCache(
    zkAddress: string,
    chainId: number
  ): Promise<RailgunAccountCache | null> {
    const key = this.#getRailgunCacheKey(zkAddress, chainId)
    const cached = await this.#storage.get(key, null as RailgunAccountCache | null)

    this.lastFetchedRailgunAccountCache = {
      zkAddress,
      chainId,
      cache: cached,
      fetchedAt: Date.now()
    }
    this.emitUpdate()

    return cached
  }

  async setRailgunAccountCache(
    zkAddress: string,
    chainId: number,
    cache: RailgunAccountCache
  ): Promise<void> {
    const key = this.#getRailgunCacheKey(zkAddress, chainId);
    await this.#storage.set(key, cache);
  
    // Store the cache in lastFetchedRailgunAccountCache so UI can use it without another fetch
    // This avoids timeout issues and race conditions
    this.lastFetchedRailgunAccountCache = {
      zkAddress,
      chainId,
      cache: cache, // Store the cache payload - UI can use it directly
      fetchedAt: Date.now()
    };

    this.emitUpdate();
  }

  // ─────────────────────────────────────────────
  // EXISTING SIGN-ACCOUNT-OP STUFF (kept)
  // ─────────────────────────────────────────────
  async #initSignAccOp(calls: Call[]) {
    if (!this.#selectedAccount?.account || this.signAccountOpController || !this.#accounts) return

    // NOTE: for now we hardcode Sepolia exactly like before
    const chainId = calls.length > 0 ? BigInt(11155111) : 11155111n
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

    // Trigger immediate initial estimate
    // The SignAccountOpController's #load() should start estimation automatically,
    // but we ensure it happens immediately
    if (this.signAccountOpController) {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      this.signAccountOpController.estimate()
    }

    // Start the re-estimation loop for periodic updates
    this.reestimate()
  }

  async reestimate() {
    if (!this.signAccountOpController || this.#reestimateAbortController) return

    this.#reestimateAbortController = new AbortController()
    const signal = this.#reestimateAbortController!.signal

    const loop = async () => {
      // First, wait 30 seconds before starting the loop
      // eslint-disable-next-line no-await-in-loop
      await wait(30000)
      
      while (!signal.aborted) {
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

        // Wait 30 seconds before next re-estimation
        // eslint-disable-next-line no-await-in-loop
        await wait(30000)
        if (signal.aborted) break
      }
    }

    void loop()
  }

  async syncSignAccountOp(calls?: Call[]) {
    if (!this.#selectedAccount?.account) return

    const transactionCalls: Call[] = calls || []
    if (!transactionCalls.length) return

    try {
      this.shouldTrackLatestBroadcastedAccountOp = true

      // If a controller already exists, destroy it first to ensure clean state
      // This prevents issues when starting a new transaction after a previous one
      // The old controller might be in a stale state (e.g., still signing, estimating, etc.)
      if (this.signAccountOpController) {
        // Destroy the old controller to start fresh
        // This will also reset hasProceeded and clean up subscriptions/re-estimation loops
        this.destroySignAccountOp()
      }

      // Ensure hasProceeded is false when starting a new transaction
      // (destroySignAccountOp should already do this, but be explicit)
      this.hasProceeded = false

      await this.#initSignAccOp(transactionCalls)
    } catch (error) {
      this.emitError({
        level: 'major',
        message: 'Failed to initialize transaction signing',
        error: error instanceof Error ? error : new Error('Unknown error in syncSignAccountOp')
      })
    }
  }

  // ─────────────────────────────────────────────
  // FORM / UI-LEVEL HELPERS (kept)
  // ─────────────────────────────────────────────
  update({ depositAmount, privacyProvider, chainId, selectedToken }: RailgunFormUpdate) {
    console.log('DEBUG: RAILGUN CONTROLLER UPDATE', { depositAmount, privacyProvider, chainId, selectedToken })

    if (typeof depositAmount === 'string') {
      this.depositAmount = depositAmount
    }

    if (typeof privacyProvider === 'string') {
      this.privacyProvider = privacyProvider
    }

    if (typeof chainId === 'number') {
      this.chainId = chainId
    }
    if (selectedToken !== undefined) {
      this.selectedToken = selectedToken
    }

    this.emitUpdate()
  }

  unloadScreen(forceUnload?: boolean) {
    if (this.hasPersistedState && !forceUnload) return
    this.destroyLatestBroadcastedAccountOp()
    this.resetForm()
  }

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
    this.#isInitialized = false

    if (shouldDestroyAccountOp) {
      this.destroySignAccountOp()
    }

    this.emitUpdate()
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

  get validationFormMsgs() {
    const validationFormMsgsNew = { ...DEFAULT_VALIDATION_FORM_MSGS }

    if (this.depositAmount && this.selectedToken && this.selectedToken.decimals) {
      try {
        const amountToValidate = formatUnits(
          BigInt(this.depositAmount),
          this.selectedToken.decimals
        )

        validationFormMsgsNew.amount = validatePrivacyPoolsDepositAmount(
          amountToValidate,
          this.selectedToken,
          BigInt(0),
          BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")
        )
      } catch (error) {
        console.error('Failed to format deposit amount:', error)
        validationFormMsgsNew.amount = {
          success: false,
          message: 'Invalid amount.'
        }
      }
    }

    // TODO: handle withdrawal validation when implement withdrawals

    return validationFormMsgsNew
  }

  // ─────────────────────────────────────────────
  // WITHDRAWAL SUBMISSION (via relayer)
  // ─────────────────────────────────────────────
  async directBroadcastWithdrawal(params: {
    to: string
    data: string
    value: string
    chainId: number
    isInternalTransfer?: boolean
  }) {
    if (!this.#selectedAccount?.account) {
      throw new Error('No account selected')
    }

    // Clear any old transaction state before starting a new transaction
    // This ensures old "Private Transfer Done!" states don't persist when starting a new withdrawal
    this.latestBroadcastedAccountOp = null
    this.latestBroadcastedToken = null
    this.emitUpdate()

    // IMMEDIATELY set latestBroadcastedAccountOp to show loading screen
    // This allows the UI to transition to the track screen right away
    this.latestBroadcastedAccountOp = {
      accountAddr: this.#selectedAccount.account.addr,
      chainId: BigInt(params.chainId),
      signingKeyAddr: null,
      signingKeyType: null,
      gasLimit: null,
      gasFeePayment: null,
      nonce: 0n,
      signature: '0x' as `0x${string}`, // Temporary placeholder, will be updated with actual txId
      accountOpToExecuteBefore: null,
      calls: [],
      // @ts-ignore - Custom properties for railgun withdrawal tracking
      status: AccountOpStatus.BroadcastedButNotConfirmed,
      // @ts-ignore
      txnId: null, // Will be updated after relayer response
      // @ts-ignore
      identifiedBy: 'userOp',
      meta: {
        // @ts-ignore - Custom meta properties for railgun withdrawal
        txnId: null, // Will be updated after relayer response
        // @ts-ignore
        isRailgunWithdrawal: true,
        // @ts-ignore
        isRailgunInternalTransfer: params.isInternalTransfer || false
      }
    }

    // Store the token for tracking page display
    this.latestBroadcastedToken = this.selectedToken

    // CRITICAL: Set shouldTrackLatestBroadcastedAccountOp to true BEFORE emitUpdate
    // This ensures the UI knows to show the tracking screen immediately
    this.shouldTrackLatestBroadcastedAccountOp = true

    this.emitUpdate()

    try {
      // Call the relayer /forward endpoint
      const response = await this.#callRelayer('/forward', 'POST', {
        to: params.to,
        data: params.data,
        value: "0x0"
      }, {
        'Content-Type': 'application/json'
      })
      console.log('DEBUG: Response from relayer:', JSON.stringify(response, null, 2));

      // The relayerCall may wrap the response in a 'data' field or spread it directly
      // Check both response.data and response directly for the API response
      const apiResponse = response.data || response
      
      // Try multiple possible field names for status and transaction hash
      const apiStatus = apiResponse.status || apiResponse.Status || apiResponse.state
      const txHash = apiResponse.tx_hash || apiResponse.txHash || apiResponse.transactionHash || apiResponse.transaction_hash || apiResponse.hash || apiResponse.txId || apiResponse.txnId

      console.log('DEBUG: Parsed response - status:', apiStatus, 'txHash:', txHash);

      // Handle response based on status
      if (apiStatus === 'FAILURE' || apiStatus === 'failure' || apiStatus === 'failed') {
        if (this.latestBroadcastedAccountOp) {
          this.latestBroadcastedAccountOp = {
            ...this.latestBroadcastedAccountOp,
            // @ts-ignore
            status: AccountOpStatus.Failure
          }
          this.emitUpdate()
        }
        throw new Error('Transaction submission failed')
      }

      // If we have a transaction hash, treat it as success even if status is not explicitly 'SUCCESS'
      // This handles cases where the relayer returns the hash directly without a status field
      if (txHash) {
        const submittedAccountOp: SubmittedAccountOp = {
          accountAddr: this.#selectedAccount.account!.addr,
          chainId: BigInt(params.chainId),
          signingKeyAddr: null,
          signingKeyType: null,
          gasLimit: null,
          gasFeePayment: null,
          nonce: 0n,
          signature: txHash as `0x${string}`,
          accountOpToExecuteBefore: null,
          calls: [],
          status: AccountOpStatus.BroadcastedButNotConfirmed,
          txnId: txHash,
          identifiedBy: {
            type: 'Relayer',
            identifier: txHash
          },
          timestamp: new Date().getTime(),
          meta: {
            // @ts-ignore
            isRailgunWithdrawal: true,
            // @ts-ignore
            isRailgunInternalTransfer: params.isInternalTransfer || false
          }
        }

        await this.#activity.addAccountOp(submittedAccountOp)

        this.latestBroadcastedAccountOp = submittedAccountOp

        this.emitUpdate()

        // Immediately check transaction receipt to update status if available
        // This provides immediate feedback to the user instead of waiting for the periodic status update
        const network = this.#networks.networks.find((net) => net.chainId === BigInt(params.chainId))
        if (network) {
          const provider = this.#providers.providers[network.chainId.toString()]
          if (provider) {
            // Check receipt in background - don't await to avoid blocking
            provider
              .getTransactionReceipt(txHash)
              .then((receipt) => {
                if (receipt) {
                  const isSuccess = !!receipt.status
                  const newStatus = isSuccess ? AccountOpStatus.Success : AccountOpStatus.Failure

                  // Update activity controller
                  if (this.#selectedAccount?.account) {
                    this.#activity
                      .updateAccountOpStatus(
                        this.#selectedAccount.account.addr,
                        BigInt(params.chainId),
                        txHash,
                        newStatus
                      )
                      .then(() => {
                        // Update local tracking
                        if (this.latestBroadcastedAccountOp) {
                          this.latestBroadcastedAccountOp = {
                            ...this.latestBroadcastedAccountOp,
                            // @ts-ignore
                            status: newStatus
                          }
                          this.emitUpdate()
                        }
                      })
                      .catch((error) => {
                        console.error('Error updating accountOp status:', error)
                      })
                  }
                }
              })
              .catch((error) => {
                // Receipt not available yet - that's fine, the periodic status update will handle it
                console.log('Transaction receipt not available yet, will be checked by periodic update')
              })
          }
        }
      } else if (apiStatus === 'SUCCESS' || apiStatus === 'success') {
        // Status is SUCCESS but no txHash - this shouldn't happen, but handle gracefully
        throw new Error('Transaction submitted successfully but no transaction hash returned')
      } else {
        // No status and no txHash - log the full response for debugging
        console.error('DEBUG: Invalid response structure. Full response:', JSON.stringify(response, null, 2))
        throw new Error(`Invalid response from relayer: missing status and transaction hash. Response: ${JSON.stringify(response)}`)
      }
    } catch (error) {
      console.error('Error submitting withdrawal to relayer:', error)
      if (this.latestBroadcastedAccountOp) {
        this.latestBroadcastedAccountOp = {
          ...this.latestBroadcastedAccountOp,
          // @ts-ignore
          status: AccountOpStatus.Failure
        }
        this.emitUpdate()
      }
      throw error
    }
  }

  // ─────────────────────────────────────────────
  // SERIALIZATION
  // ─────────────────────────────────────────────
  toJSON() {
    return {
      ...super.toJSON(),
      isInitialized: this.isInitialized,
      initialPromiseLoaded: this.initialPromiseLoaded,
      hasPersistedState: this.hasPersistedState,
      selectedToken: this.selectedToken,
      recipientAddress: this.recipientAddress,
      chainId: this.chainId,
      depositAmount: this.depositAmount,
      privacyProvider: this.privacyProvider,
      defaultRailgunKeys: this.defaultRailgunKeys,
      derivedRailgunKeysByIndex: this.derivedRailgunKeysByIndex,
      lastFetchedRailgunAccountCache: this.lastFetchedRailgunAccountCache,
      validationFormMsgs: this.validationFormMsgs
    }
  }
}

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
import { SigningStatus } from '../signAccountOp/signAccountOp'
import { validatePrivacyPoolsDepositAmount } from '../../services/privacyPools/validations'
import { formatUnits } from 'viem'
import wait from '../../utils/wait'

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
  infuraApiKey: string

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
    infuraApiKey: string
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
    this.infuraApiKey = infuraApiKey

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
  
    this.lastFetchedRailgunAccountCache = {
      zkAddress,
      chainId,
      cache: null, // NOTE IMPORTANT: avoid big payload!
      fetchedAt: Date.now()
    };

    this.emitUpdate();
  }

  // ─────────────────────────────────────────────
  // EXISTING SIGN-ACCOUNT-OP STUFF (kept)
  // ─────────────────────────────────────────────
  async #initSignAccOp(calls: Call[]) {
    console.log('DEBUG: Railgun #initSignAccOp called')
    
    if (!this.#selectedAccount?.account) {
      console.error('DEBUG: Railgun #initSignAccOp failed: no selected account')
      throw new Error('No selected account available for Railgun transaction')
    }
    
    if (this.signAccountOpController) {
      console.error('DEBUG: Railgun #initSignAccOp failed: controller already exists')
      throw new Error('Sign account op controller already exists')
    }
    
    if (!this.#accounts) {
      console.error('DEBUG: Railgun #initSignAccOp failed: accounts controller not available')
      throw new Error('Accounts controller not available')
    }

    // NOTE: for now we hardcode Sepolia exactly like before
    const chainId = calls.length > 0 ? BigInt(11155111) : 11155111n
    const network = this.#networks.networks.find((net) => net.chainId === chainId)
    if (!network) {
      console.error('DEBUG: Railgun #initSignAccOp failed: network not found for chainId', chainId)
      throw new Error(`Network not found for chainId ${chainId}`)
    }

    const provider = this.#providers.providers[network.chainId.toString()]
    if (!provider) {
      console.error('DEBUG: Railgun #initSignAccOp failed: provider not found for chainId', network.chainId)
      throw new Error(`Provider not found for chainId ${network.chainId}`)
    }
    
    const accountState = await this.#accounts.getOrFetchAccountOnChainState(
      this.#selectedAccount.account.addr,
      network.chainId
    )

    if (!this.#keystore) {
      console.error('DEBUG: Railgun #initSignAccOp failed: keystore not available')
      throw new Error('Keystore not available')
    }

    console.log('DEBUG: Railgun #initSignAccOp: creating base account')
    const baseAcc = getBaseAccount(
      this.#selectedAccount.account,
      accountState,
      this.#keystore.getAccountKeys(this.#selectedAccount.account),
      network
    )
    console.log('DEBUG: Railgun #initSignAccOp: base account created')

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
    console.log('DEBUG: Railgun #initSignAccOp: accountOp created', {
      accountAddr: accountOp.accountAddr,
      chainId: accountOp.chainId.toString(),
      nonce: accountOp.nonce?.toString(),
      callsCount: accountOp.calls.length
    })

    console.log('DEBUG: Railgun #initSignAccOp: creating SignAccountOpController')
    try {
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
      console.log('DEBUG: Railgun #initSignAccOp: SignAccountOpController created', {
        controllerId: this.signAccountOpController ? 'exists' : 'null'
      })
    } catch (e) {
      console.error('DEBUG: Railgun #initSignAccOp: ERROR creating controller', e)
      throw e
    }

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

    console.log('DEBUG: Railgun #initSignAccOp: starting reestimate')
    this.reestimate()
    console.log('DEBUG: Railgun #initSignAccOp: COMPLETE')
  }

  async reestimate() {
    if (!this.signAccountOpController || this.#reestimateAbortController) {
      return
    }

    this.#reestimateAbortController = new AbortController()
    const signal = this.#reestimateAbortController!.signal

    const loop = async () => {
      // Trigger initial estimation immediately instead of waiting 30 seconds
      if (this.signAccountOpController?.estimation.status !== EstimationStatus.Loading) {
        // eslint-disable-next-line no-await-in-loop
        await this.signAccountOpController?.estimate()
      }

      while (!signal.aborted) {
        // eslint-disable-next-line no-await-in-loop
        await wait(30000)
        if (signal.aborted) break

        if (this.signAccountOpController?.estimation.status !== EstimationStatus.Loading) {
          // eslint-disable-next-line no-await-in-loop
          await this.signAccountOpController?.estimate()
        }

        // if (this.signAccountOpController?.estimation.errors.length) {
        //   console.log(
        //     'DEBUG: Errors on Railgun re-estimate',
        //     this.signAccountOpController.estimation.errors
        //   )
        // }
      }
    }

    loop()
  }

  async syncSignAccountOp(calls?: Call[]) {
    console.log('DEBUG: Railgun syncSignAccountOp called', { callsCount: calls?.length || 0 })
    
    if (!this.#selectedAccount?.account) {
      console.error('DEBUG: Railgun syncSignAccountOp failed: no selected account')
      this.emitError({
        level: 'major',
        message: 'No account selected. Please select an account and try again.',
        error: new Error('No selected account available')
      })
      return
    }

    const transactionCalls: Call[] = calls || []
    if (!transactionCalls.length) {
      console.error('DEBUG: Railgun syncSignAccountOp failed: no transaction calls provided')
      this.emitError({
        level: 'major',
        message: 'No transaction calls provided',
        error: new Error('Transaction calls array is empty')
      })
      return
    }

    try {
      this.shouldTrackLatestBroadcastedAccountOp = true

      // If a controller already exists, try to reuse it if it's healthy
      // This prevents unnecessary destruction/recreation which causes delays and errors
      if (this.signAccountOpController) {
        // Check if controller is in an error state - if so, always destroy and recreate
        const hasErrors = this.signAccountOpController.errors.length > 0
        const isInErrorState = 
          this.signAccountOpController.status?.type === SigningStatus.EstimationError ||
          this.signAccountOpController.estimation.status === EstimationStatus.Error

        // Try to reuse controller if it's healthy
        if (!hasErrors && !isInErrorState) {
          console.log('DEBUG: Railgun syncSignAccountOp: updating existing healthy controller')
          
          // Reset hasProceeded to ensure clean state when reusing controller
          this.hasProceeded = false
          
          // Update the controller with new calls (update method handles if calls are same/different)
          this.signAccountOpController.update({ calls: transactionCalls })

          // Emit update to notify listeners of the controller reuse
          this.emitUpdate()
          return
        }

        // Controller exists but is unhealthy - destroy and recreate
        // Only force provider recreation if there were errors (Helios might be in bad state)
        const forceProviderRecreate = hasErrors || isInErrorState
        console.log('DEBUG: Railgun syncSignAccountOp: destroying unhealthy controller', { 
          hasErrors, 
          isInErrorState,
          forceProviderRecreate 
        })
        this.destroySignAccountOp(forceProviderRecreate)
        
        // Small delay to ensure cleanup completes before creating new controller
        // This prevents race conditions when user clicks back and immediately tries again
        console.log('DEBUG: Railgun syncSignAccountOp: waiting 100ms after destroy')
        await wait(100)
        console.log('DEBUG: Railgun syncSignAccountOp: wait complete, controller should be null', {
          controllerIsNull: this.signAccountOpController === null
        })
      }

      // Ensure hasProceeded is false when starting a new transaction
      // (destroySignAccountOp should already do this, but be explicit)
      this.hasProceeded = false
      console.log('DEBUG: Railgun syncSignAccountOp: calling #initSignAccOp', {
        hasProceeded: this.hasProceeded,
        controllerIsNull: this.signAccountOpController === null
      })
      
      await this.#initSignAccOp(transactionCalls)
      console.log('DEBUG: Railgun syncSignAccountOp: #initSignAccOp completed', {
        controllerExists: !!this.signAccountOpController,
        hasErrors: this.signAccountOpController ? this.signAccountOpController.errors.length > 0 : false,
        estimationStatus: this.signAccountOpController?.estimation.status
      })
    } catch (error) {
      console.error('DEBUG: Railgun syncSignAccountOp error:', error)
      this.emitError({
        level: 'major',
        message: error instanceof Error ? error.message : 'Failed to initialize transaction signing',
        error: error instanceof Error ? error : new Error('Unknown error in syncSignAccountOp')
      })
      // Ensure controller is null on error
      // Force provider recreation when there's an error (Helios might be in bad state)
      if (this.signAccountOpController) {
        this.destroySignAccountOp(true) // Force provider recreation on error
      }
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
      const previousProvider = this.privacyProvider
      this.privacyProvider = privacyProvider
      
      // When switching providers, only destroy controller if it's in an error state
      // The DepositScreen already handles destroying controllers when switching providers,
      // so we only need to clean up unhealthy controllers here
      if (previousProvider && previousProvider !== privacyProvider) {
        console.log('DEBUG: Railgun provider changed', { previousProvider, newProvider: privacyProvider })
        if (this.signAccountOpController) {
          // Only destroy if controller is in an error state
          const hasErrors = this.signAccountOpController.errors.length > 0
          const isInErrorState = 
            this.signAccountOpController.status?.type === SigningStatus.EstimationError ||
            this.signAccountOpController.estimation.status === EstimationStatus.Error
          
          if (hasErrors || isInErrorState) {
            console.log('DEBUG: Railgun provider changed: destroying unhealthy controller', { hasErrors, isInErrorState })
            this.destroySignAccountOp(hasErrors || isInErrorState)
          } else {
            console.log('DEBUG: Railgun provider changed: keeping healthy controller for reuse')
          }
        }
        // Explicitly reset hasProceeded when switching providers to ensure clean state
        // This is critical when switching from another provider (e.g., Privacy Pools)
        this.hasProceeded = false
      }
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

  destroySignAccountOp(forceProviderRecreate: boolean = false) {
    console.log('DEBUG: Railgun destroySignAccountOp: START', {
      hasController: !!this.signAccountOpController,
      hasSubscriptions: this.#signAccountOpSubscriptions.length > 0,
      hasReestimateAbort: !!this.#reestimateAbortController,
      hasProceeded: this.hasProceeded,
      forceProviderRecreate
    })
    
    // Check if controller has errors - if so, force provider recreation
    const hasErrors = (this.signAccountOpController?.errors.length ?? 0) > 0 || 
                     this.signAccountOpController?.estimation.status === EstimationStatus.Error ||
                     this.signAccountOpController?.status?.type === SigningStatus.EstimationError
    
    const shouldRecreateProvider = forceProviderRecreate || hasErrors
    
    this.#signAccountOpSubscriptions.forEach((unsubscribe) => {
      try {
        unsubscribe()
      } catch (e) {
        console.error('DEBUG: Railgun destroySignAccountOp: error unsubscribing', e)
      }
    })
    this.#signAccountOpSubscriptions = []

    if (this.#reestimateAbortController) {
      try {
        this.#reestimateAbortController.abort()
      } catch (e) {
        console.error('DEBUG: Railgun destroySignAccountOp: error aborting reestimate', e)
      }
      this.#reestimateAbortController = null
    }

    // Get chainId before destroying controller (for provider recreation)
    const chainId = this.signAccountOpController?.accountOp?.chainId

    if (this.signAccountOpController) {
      try {
        console.log('DEBUG: Railgun destroySignAccountOp: resetting controller', {
          status: this.signAccountOpController.status?.type,
          estimationStatus: this.signAccountOpController.estimation.status,
          hasErrors: this.signAccountOpController.errors.length > 0
        })
        this.signAccountOpController.reset()
      } catch (e) {
        console.error('DEBUG: Railgun destroySignAccountOp: error resetting controller', e)
      }
      this.signAccountOpController = null
    }

    // Force provider recreation if there were errors (Helios might be in bad state)
    if (shouldRecreateProvider && chainId && this.#providers) {
      console.log('DEBUG: Railgun destroySignAccountOp: forcing provider recreation due to errors', { chainId })
      try {
        this.#providers.forceRecreateProvider(chainId)
      } catch (e) {
        console.error('DEBUG: Railgun destroySignAccountOp: error recreating provider', e)
      }
    }

    this.hasProceeded = false
    
    console.log('DEBUG: Railgun destroySignAccountOp: COMPLETE', {
      controllerIsNull: this.signAccountOpController === null,
      hasProceeded: this.hasProceeded,
      providerRecreated: shouldRecreateProvider
    })
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
      infuraApiKey: this.infuraApiKey,
      defaultRailgunKeys: this.defaultRailgunKeys,
      derivedRailgunKeysByIndex: this.derivedRailgunKeysByIndex,
      lastFetchedRailgunAccountCache: this.lastFetchedRailgunAccountCache,
      validationFormMsgs: this.validationFormMsgs
    }
  }
}

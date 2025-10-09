import { formatUnits, keccak256, parseUnits, toBytes, type Address, type Hex } from 'viem'
import { HDNodeWallet, Mnemonic } from 'ethers'
import type { KeystoreController } from '../keystore/keystore'
import { type ChainData, chainData, whitelistedChains } from './config'
import EventEmitter from '../eventEmitter/eventEmitter'
import { SignAccountOpController } from '../signAccountOp/signAccountOp'
import { getBaseAccount } from '../../libs/account/getBaseAccount'
import { AccountOp } from '../../libs/accountOp/accountOp'
import { Call } from '../../libs/accountOp/types'
import { KeystoreSigner } from '../../libs/keystoreSigner/keystoreSigner'
import { getAmbirePaymasterService } from '../../libs/erc7677/erc7677'
import { randomId } from '../../libs/humanizer/utils'
import { EstimationStatus } from '../estimation/types'
import { AccountsController } from '../accounts/accounts'
import { ActivityController } from '../activity/activity'
import { NetworksController } from '../networks/networks'
import { PortfolioController } from '../portfolio/portfolio'
import { ProvidersController } from '../providers/providers'
import { SelectedAccountController } from '../selectedAccount/selectedAccount'
import { ExternalSignerControllers, Key } from '../../interfaces/keystore'
import { AddressState } from '../../interfaces/domains'
import { getTokenAmount } from '../../libs/portfolio/helpers'
import {
  convertTokenPriceToBigInt,
  getSafeAmountFromFieldValue
} from '../../utils/numbers/formatters'
import { getAppSecret, getEip712Payload } from './derivation'
import wait from '../../utils/wait'
import { relayerCall } from '../../libs/relayerCall/relayerCall'
import { Fetch } from '../../interfaces/fetch'

const HARD_CODED_CURRENCY = 'usd'

interface PrivacyPoolsFormUpdate {
  depositAmount?: string
  withdrawalAmount?: string
  seedPhrase?: string
  addressState?: AddressState
  importedSecretNote?: string
  selectedToken?: any
  shouldSetMaxAmount?: boolean
  isRecipientAddressUnknownAgreed?: boolean
}

type Hash = bigint

type PoolInfo = {
  chainId: number
  address: Hex
  scope: Hash
  deploymentBlock: bigint
}

export type BatchWithdrawalProof = {
  pA: [bigint, bigint]
  pB: [readonly [bigint, bigint], readonly [bigint, bigint]]
  pC: [bigint, bigint]
  pubSignals: bigint[]
}

export type TransformedProof = {
  publicSignals: bigint[]
  proof: {
    pi_a: [bigint, bigint]
    pi_b: [readonly [bigint, bigint], readonly [bigint, bigint]]
    pi_c: [bigint, bigint]
  }
}

export type BatchWithdrawalParams = {
  chainId: number
  poolAddress: string
  withdrawal: {
    processooor: string
    data: string
  }
  proofs: TransformedProof[]
}

export type BatchWithdrawalResponse = {
  success: boolean
  data?: {
    txId: string
    relayerId: string
    estimatedConfirmation?: number
  }
  message?: string
}

const DEFAULT_ADDRESS_STATE = {
  fieldValue: '',
  ensAddress: '',
  isDomainResolving: false
}

export class PrivacyPoolsController extends EventEmitter {
  #accounts: AccountsController | null = null

  #keystore: KeystoreController | null = null

  #selectedAccount: SelectedAccountController | null = null

  #isInitialized: boolean = false

  #initializationError: string | null = null

  #initialPromise: Promise<void> | null = null

  #initialPromiseLoaded: boolean = false

  #privacyPoolsAspUrl: string

  #alchemyApiKey: string

  #signAccountOpSubscriptions: Function[] = []

  #reestimateAbortController: AbortController | null = null

  #networks: NetworksController

  #providers: ProvidersController

  #portfolio: PortfolioController

  #activity: ActivityController

  #externalSignerControllers: ExternalSignerControllers

  #relayerUrl: string

  #privacyPoolsRelayerUrl: string

  #callRelayer: Function

  #fetch: Fetch

  shouldTrackLatestBroadcastedAccountOp: boolean = true

  signAccountOpController: SignAccountOpController | null = null

  latestBroadcastedAccountOp: AccountOp | null = null

  hasProceeded: boolean = false

  depositAmount: string = ''

  withdrawalAmount: string = ''

  signedTypedData: string | null = null

  seedPhrase: string = ''

  addressState: AddressState = { ...DEFAULT_ADDRESS_STATE }

  #selectedToken: any = null

  importedSecretNote: string = ''

  // Transfer/Withdrawal-specific properties
  amountInFiat: string = ''

  amountFieldMode: 'token' | 'fiat' = 'token'

  isRecipientAddressUnknown: boolean = false

  isRecipientAddressUnknownAgreed: boolean = false

  latestBroadcastedToken: any = null

  programmaticUpdateCounter: number = 0

  validationFormMsgs: {
    amount: { success: boolean; message: string }
    recipientAddress: { success: boolean; message: string }
  } = {
    amount: { success: true, message: '' },
    recipientAddress: { success: true, message: '' }
  }

  poolsByChain: PoolInfo[] = []

  pools: PoolInfo[] = []

  chainDataByWhitelistedChains: ChainData[keyof ChainData][] = []

  chainData: ChainData | null = null

  constructor(
    keystore: KeystoreController,
    accounts: AccountsController,
    networks: NetworksController,
    providers: ProvidersController,
    selectedAccount: SelectedAccountController,
    portfolio: PortfolioController,
    activity: ActivityController,
    externalSignerControllers: ExternalSignerControllers,
    relayerUrl: string,
    privacyPoolsAspUrl: string,
    privacyPoolsRelayerUrl: string,
    alchemyApiKey: string,
    fetch: Fetch
  ) {
    super()

    this.#keystore = keystore
    this.#accounts = accounts
    this.#selectedAccount = selectedAccount
    this.#privacyPoolsAspUrl = privacyPoolsAspUrl
    this.#alchemyApiKey = alchemyApiKey
    this.#accounts = accounts
    this.#networks = networks
    this.#providers = providers
    this.#selectedAccount = selectedAccount
    this.#portfolio = portfolio
    this.#activity = activity
    this.#externalSignerControllers = externalSignerControllers
    this.#relayerUrl = relayerUrl
    this.#privacyPoolsRelayerUrl = privacyPoolsRelayerUrl
    this.#fetch = fetch

    // Bind relayer call function
    this.#callRelayer = relayerCall.bind({ url: privacyPoolsRelayerUrl, fetch })

    this.#initialPromise = this.#load()

    this.emitUpdate()
  }

  async #load() {
    await this.#selectedAccount?.initialLoadPromise

    this.chainDataByWhitelistedChains = Object.values(chainData).filter(
      (chain) =>
        chain.poolInfo.length > 0 &&
        whitelistedChains.some((c) => c.id === chain.poolInfo[0].chainId)
    )

    this.poolsByChain = this.chainDataByWhitelistedChains.flatMap((chain) => chain.poolInfo)

    this.pools = this.poolsByChain.map((pool: PoolInfo) => {
      return {
        chainId: pool.chainId,
        address: pool.address,
        scope: pool.scope as Hash,
        deploymentBlock: pool.deploymentBlock
      }
    })

    this.chainData = Object.fromEntries(
      Object.entries(chainData).map(([chainId, chain]) => [
        chainId,
        {
          ...chain,
          aspUrl: this.#privacyPoolsAspUrl,
          rpcUrl: `${chain.rpcUrl}${this.#alchemyApiKey}`
        }
      ])
    )

    this.#initialPromiseLoaded = true
  }

  async #generateAppSecretInternal(appInfo: string): Promise<string> {
    const appIdentifier = 'privacypools.com'

    // Step 1: Derive dedicated address and wallet
    const coinType = 9001
    const privacyPoolsPath = `m/44'/${coinType}'/0'/0/0`
    const seedPhrase = await this.#getCurrentAccountSeed()

    if (!seedPhrase) {
      throw new Error('No seed phrase available for key derivation')
    }

    const mnemonic = Mnemonic.fromPhrase(seedPhrase)
    const wallet = HDNodeWallet.fromMnemonic(mnemonic, privacyPoolsPath)
    const signerAddress = wallet.address as Address
    const privateKey = wallet.privateKey

    // Create a temporary Key object
    const tempKey: Key = {
      addr: signerAddress,
      type: 'internal',
      label: 'Privacy Pools Temporary Key',
      dedicatedToOneSA: true,
      isExternallyStored: false,
      meta: {
        createdAt: Date.now(),
        privacyPools: true,
        temporary: true
      }
    }

    const signer = new KeystoreSigner(tempKey, privateKey)

    const addressHash = keccak256(toBytes(signerAddress))

    // Step 2: Construct EIP-712 payload
    const eip712Payload = getEip712Payload(appIdentifier, addressHash)

    // Step 3: Request signature using the wallet directly
    let signature: string | null = await signer.signTypedData(eip712Payload)

    const appSecret = getAppSecret(signature, signerAddress, appIdentifier, appInfo)

    signature = null // Destroy signature component

    return appSecret
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

  #calculateAmountInFiat(amount: string) {
    if (!amount || !this.selectedToken) {
      this.amountInFiat = ''
      return
    }

    const tokenPrice = this.selectedToken?.priceIn?.find(
      (p: any) => p.baseCurrency === HARD_CODED_CURRENCY
    )?.price

    if (!tokenPrice || typeof this.selectedToken.decimals !== 'number') {
      this.amountInFiat = ''
      return
    }

    try {
      const formattedAmount = parseUnits(
        getSafeAmountFromFieldValue(amount, this.selectedToken.decimals),
        this.selectedToken.decimals
      )

      if (!formattedAmount) {
        this.amountInFiat = ''
        return
      }

      const { tokenPriceBigInt, tokenPriceDecimals } = convertTokenPriceToBigInt(tokenPrice)

      this.amountInFiat = formatUnits(
        formattedAmount * tokenPriceBigInt,
        this.selectedToken.decimals + tokenPriceDecimals
      )
    } catch (error) {
      this.amountInFiat = ''
    }
  }

  update({
    depositAmount,
    withdrawalAmount,
    seedPhrase,
    addressState,
    importedSecretNote,
    selectedToken,
    shouldSetMaxAmount,
    isRecipientAddressUnknownAgreed
  }: PrivacyPoolsFormUpdate) {
    if (typeof depositAmount === 'string') {
      this.depositAmount = depositAmount
    }

    if (typeof withdrawalAmount === 'string') {
      this.withdrawalAmount = withdrawalAmount
      this.#calculateAmountInFiat(withdrawalAmount)
    }

    if (addressState) {
      this.addressState = {
        ...this.addressState,
        ...addressState
      }

      // Validations if needed
      // this.#onRecipientAddressChange()
    }

    if (typeof importedSecretNote === 'string') {
      this.importedSecretNote = importedSecretNote
    }

    if (selectedToken !== undefined) {
      this.selectedToken = selectedToken
    }

    if (shouldSetMaxAmount && this.maxAmount) {
      this.withdrawalAmount = this.maxAmount
      this.#calculateAmountInFiat(this.maxAmount)
      this.programmaticUpdateCounter++
    }

    if (typeof isRecipientAddressUnknownAgreed === 'boolean') {
      this.isRecipientAddressUnknownAgreed = isRecipientAddressUnknownAgreed
    }

    this.seedPhrase = seedPhrase || ''

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

  async generateKeys() {
    try {
      // Step 1: Generate NullifyingKey
      const nullifyingKey = await this.#generateAppSecretInternal('nullifyingKey')
      console.log('DEBUG: Nullifying key:', nullifyingKey)

      // Step 2: Generate RevocableKey
      const revocableKey = await this.#generateAppSecretInternal('revocableKey')
      console.log('DEBUG: Revocable key:', revocableKey)

      // Step 3: Generate ViewingKey
      const viewingKey = await this.#generateAppSecretInternal('viewingKey')
      console.log('DEBUG: Viewing key:', viewingKey)

      // TODO: Encrypt and store keys in Extension Local Storage

      return {
        nullifyingKey,
        revocableKey,
        viewingKey
      }
    } catch (error) {
      console.error('Failed to generate keys:', error)
      throw error
    }
  }

  async generateSecret(appInfo: string = 'Standardized-Secret-Derivation-v1-App') {
    try {
      const appSecret = await this.#generateAppSecretInternal(appInfo)

      // TODO: Encrypt before saving in this.signedTypedData

      this.signedTypedData = appSecret
      console.log('DEBUG: App secret:', appSecret)

      this.emitUpdate()
    } catch (error) {
      console.error('Failed to generate app secret:', error)
      throw error
    }
  }

  async syncSignAccountOp(calls?: Call[]) {
    if (!this.#selectedAccount?.account) return

    // Build the calls based on your privacy pools operations
    const transactionCalls: Call[] = calls || []

    if (!transactionCalls.length) return

    try {
      // If SignAccountOpController is already initialized, we just update it
      if (this.signAccountOpController) {
        this.signAccountOpController.update({ calls: transactionCalls })
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
            'DEBUG: Errors on PrivacyPools re-estimate',
            this.signAccountOpController.estimation.errors
          )
        }
      }
    }

    loop()
  }

  /**
   * Submit batch withdrawal to relayer API
   * This method sends the batch withdrawal proofs to the relayer endpoint
   * instead of directly encoding and broadcasting the transaction
   */
  async submitBatchWithdrawal(params: BatchWithdrawalParams): Promise<BatchWithdrawalResponse> {
    try {
      console.log('DEBUG: calling Submit Batch Withdrawal', this.#privacyPoolsRelayerUrl)

      // Convert all bigint values to strings for JSON serialization
      const serializedParams = {
        ...params,
        proofs: params.proofs.map((proof) => ({
          publicSignals: proof.publicSignals.map((signal) => signal.toString()),
          proof: {
            pi_a: [proof.proof.pi_a[0].toString(), proof.proof.pi_a[1].toString()],
            pi_b: [
              [proof.proof.pi_b[0][0].toString(), proof.proof.pi_b[0][1].toString()],
              [proof.proof.pi_b[1][0].toString(), proof.proof.pi_b[1][1].toString()]
            ],
            pi_c: [proof.proof.pi_c[0].toString(), proof.proof.pi_c[1].toString()]
          }
        }))
      }

      console.log('DEBUG: serializedParams', serializedParams)

      const response = await this.#callRelayer('/relayer/batch/request', 'POST', serializedParams, {
        'Content-Type': 'application/json'
      })

      console.log('DEBUG: response', response)

      if (!response.success) {
        throw new Error(response.message || 'Batch withdrawal submission failed')
      }

      return {
        success: true,
        data: {
          txId: response.data?.txId || response.txId,
          relayerId: response.data?.relayerId || response.id,
          estimatedConfirmation: response.data?.estimatedConfirmation
        }
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Failed to submit batch withdrawal to relayer'

      this.emitError({
        level: 'major',
        message: errorMessage,
        error: error instanceof Error ? error : new Error(errorMessage)
      })

      return {
        success: false,
        message: errorMessage
      }
    }
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

  get selectedToken() {
    return this.#selectedToken
  }

  set selectedToken(token: any) {
    if (!token) {
      this.#selectedToken = null
      this.withdrawalAmount = ''
      this.amountInFiat = ''
      this.amountFieldMode = 'token'
      return
    }

    const prevSelectedToken = { ...this.selectedToken }

    this.#selectedToken = token

    // Reset amounts when token changes
    if (
      prevSelectedToken?.address !== token?.address ||
      prevSelectedToken?.chainId !== token?.chainId
    ) {
      if (!token.priceIn?.length) {
        this.amountFieldMode = 'token'
      }
      this.withdrawalAmount = ''
      this.amountInFiat = ''
    }
  }

  get maxAmount(): string {
    if (
      !this.selectedToken ||
      getTokenAmount(this.selectedToken) === 0n ||
      typeof this.selectedToken.decimals !== 'number'
    )
      return '0'

    return formatUnits(getTokenAmount(this.selectedToken), this.selectedToken.decimals)
  }

  get hasPersistedState() {
    return !!(this.depositAmount || this.withdrawalAmount || this.addressState.fieldValue)
  }

  get recipientAddress() {
    return this.addressState.ensAddress || this.addressState.fieldValue
  }

  toJSON() {
    return {
      ...this,
      ...super.toJSON(),
      isInitialized: this.isInitialized,
      initialPromiseLoaded: this.initialPromiseLoaded,
      hasPersistedState: this.hasPersistedState,
      selectedToken: this.selectedToken,
      maxAmount: this.maxAmount,
      recipientAddress: this.recipientAddress
    }
  }
}

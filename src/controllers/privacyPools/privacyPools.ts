/* eslint-disable no-console */
import {
  formatUnits,
  getAddress,
  keccak256,
  parseUnits,
  toBytes,
  type Address,
  type Hex,
  zeroAddress
} from 'viem'
import { HDNodeWallet, Mnemonic } from 'ethers'
import type { KeystoreController } from '../keystore/keystore'
import { type ChainData, chainData, whitelistedChains } from './config'
import EventEmitter from '../eventEmitter/eventEmitter'
import { SignAccountOpController } from '../signAccountOp/signAccountOp'
import { getBaseAccount } from '../../libs/account/getBaseAccount'
import { AccountOp } from '../../libs/accountOp/accountOp'
import { AccountOpStatus, Call } from '../../libs/accountOp/types'
import { KeystoreSigner } from '../../libs/keystoreSigner/keystoreSigner'
import { getAmbirePaymasterService } from '../../libs/erc7677/erc7677'
import { randomId } from '../../libs/humanizer/utils'
import { EstimationStatus } from '../estimation/types'
import { AccountsController } from '../accounts/accounts'
import { ActivityController } from '../activity/activity'
import { isValidAddress } from '../../services/address'
import {
  validatePrivacyPoolsDepositAmount,
  validateSendTransferAddress
} from '../../services/privacyPools/validations'
import { NetworksController } from '../networks/networks'
import { PortfolioController } from '../portfolio/portfolio'
import { ProvidersController } from '../providers/providers'
import { SelectedAccountController } from '../selectedAccount/selectedAccount'
import { ExternalSignerControllers, Key } from '../../interfaces/keystore'
import { AddressState } from '../../interfaces/domains'
import {
  convertTokenPriceToBigInt,
  getSafeAmountFromFieldValue
} from '../../utils/numbers/formatters'
import { getAppSecret, getEip712Payload } from './derivation'
import { relayerCall } from '../../libs/relayerCall/relayerCall'
import { Fetch } from '../../interfaces/fetch'
import { generateUuid } from '../../utils/uuid'
import wait from '../../utils/wait'
import { SubmittedAccountOp } from '../../libs/accountOp/submittedAccountOp'

const HARD_CODED_CURRENCY = 'usd'

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

interface PrivacyPoolsFormUpdate {
  depositAmount?: string
  withdrawalAmount?: string
  privacyProvider?: string
  seedPhrase?: string
  addressState?: AddressState
  importedSecretNote?: string
  selectedToken?: any
  maxAmount?: string
  shouldSetMaxAmount?: boolean
  isRecipientAddressUnknownAgreed?: boolean
  batchSize?: number
  currentPrivateBalance?: string
}

type Hash = bigint

type PoolInfo = {
  chainId: number
  address: Hex
  scope: Hash
  deploymentBlock: bigint
  maxDeposit: bigint
  minDeposit: bigint
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

  #hypersyncApiKey: string

  #signAccountOpSubscriptions: Function[] = []

  #reestimateAbortController: AbortController | null = null

  #quoteRefetchAbortController: AbortController | null = null

  #transactionPollingAbortController: AbortController | null = null

  #pendingWithdrawalParams: {
    chainId: number
    poolAddress: string
    processooor: string
    recipient: string
    batchSize: number
    totalAmount: string
    data: string
  } | null = null

  #networks: NetworksController

  #providers: ProvidersController

  #portfolio: PortfolioController

  #activity: ActivityController

  #externalSignerControllers: ExternalSignerControllers

  #relayerUrl: string

  #privacyPoolsRelayerUrl: string

  #callRelayer: Function

  #fetch: Fetch

  #updateQuoteId?: string

  shouldTrackLatestBroadcastedAccountOp: boolean = true

  signAccountOpController: SignAccountOpController | null = null

  latestBroadcastedAccountOp: AccountOp | null = null

  hasProceeded: boolean = false

  depositAmount: string = ''

  withdrawalAmount: string = ''

  currentPrivateBalance: string = ''

  maxAmount: string = ''

  secret: string | null = null

  seedPhrase: string = ''

  privacyProvider: string = 'privacy-pools'

  addressState: AddressState = { ...DEFAULT_ADDRESS_STATE }

  #selectedToken: any = null

  importedSecretNote: string = ''

  updateQuoteStatus: 'INITIAL' | 'LOADING' = 'INITIAL'

  relayerQuote: {
    relayFeeBPS: number
    feeRecipient: string
    totalAmountWithFee: string
    data: string
    estimatedFee: string
  } | null = null

  // Transfer/Withdrawal-specific properties
  amountInFiat: string = ''

  amountFieldMode: 'token' | 'fiat' = 'token'

  isRecipientAddressUnknown: boolean = false

  isRecipientAddressUnknownAgreed: boolean = false

  latestBroadcastedToken: any = null

  programmaticUpdateCounter: number = 0

  batchSize: number = 1

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
    hypersyncApiKey: string,
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
    this.#hypersyncApiKey = hypersyncApiKey
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
        deploymentBlock: pool.deploymentBlock,
        maxDeposit: pool.maxDeposit,
        minDeposit: pool.minDeposit
      }
    })

    this.chainData = Object.fromEntries(
      Object.entries(chainData).map(([chainId, chain]) => [
        chainId,
        {
          ...chain,
          aspUrl: this.#privacyPoolsAspUrl,
          rpcUrl: `${chain.rpcUrl}${this.#alchemyApiKey}`,
          sdkRpcUrl: `${chain.sdkRpcUrl}${this.#hypersyncApiKey}`
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
    console.log('DEBUG: PRIVACY POOLS: GET SEED PHRASE')
    const seedPhrase = await this.#getCurrentAccountSeed()
    if (!seedPhrase) {
      throw new Error('No seed phrase available for key derivation')
    } else {
      console.log('DEBUG: PRIVACY POOLS: SEED PHRASE FOUND')
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

  #getIsFormValidToFetchQuote() {
    const hasWithdrawalAmount = !!this.withdrawalAmount && parseFloat(this.withdrawalAmount) > 0
    const hasSelectedToken = !!this.selectedToken
    const hasRecipientAddress = !!this.recipientAddress
    const isRecipientValid = this.validationFormMsgs.recipientAddress.success

    const withdrawalAmountNum = parseFloat(this.withdrawalAmount)
    const currentBalanceNum = parseFloat(this.currentPrivateBalance)
    const isWithinBalance =
      !Number.isNaN(withdrawalAmountNum) &&
      !Number.isNaN(currentBalanceNum) &&
      withdrawalAmountNum <= currentBalanceNum

    return (
      hasWithdrawalAmount &&
      hasSelectedToken &&
      hasRecipientAddress &&
      isRecipientValid &&
      isWithinBalance
    )
  }

  update({
    depositAmount,
    withdrawalAmount,
    privacyProvider,
    seedPhrase,
    addressState,
    importedSecretNote,
    selectedToken,
    maxAmount,
    shouldSetMaxAmount,
    isRecipientAddressUnknownAgreed,
    batchSize,
    currentPrivateBalance
  }: PrivacyPoolsFormUpdate) {
    console.log('DEBUG: PRIVACY POOLS FORM UPDATE CONTROLLER UPDATE')
    let shouldUpdateQuote = false

    if (typeof depositAmount === 'string') {
      this.depositAmount = depositAmount
    }

    if (typeof privacyProvider === 'string') {
      this.privacyProvider = privacyProvider
    }

    if (typeof withdrawalAmount === 'string') {
      this.withdrawalAmount = withdrawalAmount
      this.#calculateAmountInFiat(withdrawalAmount)
      shouldUpdateQuote = true
    }

    if (addressState) {
      this.addressState = {
        ...this.addressState,
        ...addressState
      }
      shouldUpdateQuote = true

      // Validations if needed
      // this.#onRecipientAddressChange()
    }

    if (typeof importedSecretNote === 'string') {
      this.importedSecretNote = importedSecretNote
    }

    if (selectedToken !== undefined) {
      this.selectedToken = selectedToken
      shouldUpdateQuote = true
    }

    if (typeof maxAmount === 'string') {
      this.maxAmount = maxAmount
      this.#calculateAmountInFiat(this.maxAmount)
    }

    if (typeof isRecipientAddressUnknownAgreed === 'boolean') {
      this.isRecipientAddressUnknownAgreed = isRecipientAddressUnknownAgreed
    }

    if (typeof batchSize === 'number') {
      this.batchSize = batchSize
      shouldUpdateQuote = true
    }

    if (typeof currentPrivateBalance === 'string') {
      this.currentPrivateBalance = currentPrivateBalance
      shouldUpdateQuote = true
    }

    if (shouldSetMaxAmount && this.maxAmount) {
      this.withdrawalAmount = this.maxAmount
      this.#calculateAmountInFiat(this.maxAmount)
      this.programmaticUpdateCounter++
      shouldUpdateQuote = true
    }

    this.seedPhrase = seedPhrase || ''

    this.emitUpdate()

    if (shouldUpdateQuote) {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      this.updateQuote({ debounce: true })
    }
  }

  async updateQuote(options?: { debounce?: boolean }) {
    const { debounce = false } = options || {}

    // Clear quote if form is invalid
    if (!this.#getIsFormValidToFetchQuote()) {
      if (this.relayerQuote) {
        this.relayerQuote = null
        this.updateQuoteStatus = 'INITIAL'
        this.#stopQuoteRefetch()
        this.emitUpdate()
      }
      return
    }

    const quoteId = generateUuid()
    this.#updateQuoteId = quoteId

    this.updateQuoteStatus = 'LOADING'
    this.emitUpdate()

    if (debounce) await wait(500)
    if (this.#updateQuoteId !== quoteId) return

    try {
      const selectedPoolInfo = this.pools[0] // TODO: Determine the correct pool based on selected token/chain
      if (!selectedPoolInfo) {
        throw new Error('No pool information available')
      }

      // Fetch relayer details
      const detailsResponse = await this.#fetch(
        `${this.#privacyPoolsRelayerUrl}/relayer/details?chainId=${
          selectedPoolInfo.chainId
        }&assetAddress=0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE`
      )

      if (!detailsResponse.ok) {
        throw new Error('Failed to fetch relayer details')
      }

      const relayerDetails = await detailsResponse.json()

      if (this.#updateQuoteId !== quoteId) return // Guard check after async

      // Fetch quote using the actual batchSize from form calculation
      // Add unique requestId and timestamp to ensure relayer generates fresh, unique batchRelayData
      // This prevents the "unauthorized access" error when doing multiple withdrawals with same parameters
      const quoteResponse = await this.#fetch(
        `${this.#privacyPoolsRelayerUrl}/relayer/batch/quote`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chainId: selectedPoolInfo.chainId,
            batchSize: this.batchSize,
            totalAmount: parseUnits(this.withdrawalAmount, 18).toString(),
            recipient: this.recipientAddress,
            requestId: generateUuid(), // Unique identifier for this quote request
            timestamp: Date.now() // Timestamp to ensure uniqueness
          })
        }
      )

      if (!quoteResponse.ok) {
        throw new Error('Failed to fetch quote')
      }

      const quote = await quoteResponse.json()

      if (this.#updateQuoteId !== quoteId) return

      this.relayerQuote = {
        relayFeeBPS: quote.relayFeeBPS,
        feeRecipient: getAddress(relayerDetails.feeReceiverAddress),
        // TODO: This will be used in future (probably)
        totalAmountWithFee: (
          parseFloat(this.withdrawalAmount) *
          (1 + quote.relayFeeBPS / 10000)
        ).toString(),
        data: quote.batchFeeCommitment.batchRelayData,
        estimatedFee: quote.estimatedFee
      }

      this.#startQuoteRefetch()
    } catch (error) {
      if (this.#updateQuoteId !== quoteId) return

      this.emitError({
        level: 'minor',
        message: 'Failed to fetch relayer quote',
        error: error instanceof Error ? error : new Error('Unknown error fetching quote')
      })
    } finally {
      if (this.#updateQuoteId === quoteId) {
        this.updateQuoteStatus = 'INITIAL'
        this.emitUpdate()
      }
    }
  }

  #startQuoteRefetch() {
    this.#stopQuoteRefetch()

    if (!this.#getIsFormValidToFetchQuote()) return

    this.#quoteRefetchAbortController = new AbortController()
    const signal = this.#quoteRefetchAbortController.signal

    const refetchLoop = async () => {
      while (!signal.aborted) {
        // Wait 18 seconds (slightly less than 20s validity to have a buffer)
        // eslint-disable-next-line no-await-in-loop
        await wait(18000)
        if (signal.aborted) break

        // Only refetch if form is still valid and we're not already loading
        if (this.#getIsFormValidToFetchQuote() && this.updateQuoteStatus !== 'LOADING') {
          // eslint-disable-next-line no-await-in-loop
          await this.updateQuote({ debounce: false })
        }

        if (signal.aborted) break
      }
    }

    refetchLoop()
  }

  #stopQuoteRefetch() {
    if (this.#quoteRefetchAbortController) {
      this.#quoteRefetchAbortController.abort()
      this.#quoteRefetchAbortController = null
    }
  }

  unloadScreen(forceUnload?: boolean) {
    if (this.hasPersistedState && !forceUnload) return

    this.destroyLatestBroadcastedAccountOp()
    this.#stopQuoteRefetch()
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
    this.#isInitialized = false
    this.relayerQuote = null
    this.updateQuoteStatus = 'INITIAL'
    this.#updateQuoteId = undefined
    this.#pendingWithdrawalParams = null
    this.hasProceeded = false

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

    this.#stopQuoteRefetch()
    this.#pendingWithdrawalParams = null
    this.hasProceeded = false
    this.emitUpdate()
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

  async generatePPv1Keys() {
    try {
      // Step 1: Generate NullifyingKey
      const masterNullifierKey = await this.#generateAppSecretInternal('master-nullifier')

      // Step 2: Generate RevocableKey
      const masterSecretKey = await this.#generateAppSecretInternal('master-secret')

      const secrets = {
        masterNullifierSeed: masterNullifierKey,
        masterSecretSeed: masterSecretKey
      }

      this.secret = JSON.stringify(secrets)
      this.emitUpdate()
    } catch (error) {
      console.error('Failed to generate keys:', error)
      throw error
    }
  }

  async generateSecret(appInfo: string = 'Standardized-Secret-Derivation-v1-App') {
    try {
      const appSecret = await this.#generateAppSecretInternal(appInfo)

      this.secret = appSecret
      this.emitUpdate()
    } catch (error) {
      console.error('Failed to generate app secret:', error)
      throw error
    }
  }

  async directBroadcastWithdrawal(params: BatchWithdrawalParams) {
    if (!this.#selectedAccount?.account) {
      throw new Error('No account selected')
    }

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
      // @ts-ignore - Custom properties for privacy pools withdrawal tracking
      status: AccountOpStatus.BroadcastedButNotConfirmed,
      // @ts-ignore
      txnId: null, // Will be updated after relayer response
      // @ts-ignore
      identifiedBy: 'userOp',
      meta: {
        // @ts-ignore - Custom meta properties for privacy pools withdrawal
        txnId: null, // Will be updated after relayer response
        // @ts-ignore
        relayerId: null, // Will be updated after relayer response
        // @ts-ignore
        isPrivacyPoolsWithdrawal: true
      }
    }

    // Store the token for tracking page display
    this.latestBroadcastedToken = this.selectedToken

    // CRITICAL: Set shouldTrackLatestBroadcastedAccountOp to true BEFORE emitUpdate
    // This ensures the UI knows to show the tracking screen immediately
    this.shouldTrackLatestBroadcastedAccountOp = true

    this.emitUpdate()

    const response = await this.submitBatchWithdrawal(params)

    if (!response.success || !response.data) {
      if (this.latestBroadcastedAccountOp) {
        this.latestBroadcastedAccountOp = {
          ...this.latestBroadcastedAccountOp,
          // @ts-ignore
          status: AccountOpStatus.Failure
        }
        this.emitUpdate()
      }
      throw new Error(response.message || 'Withdrawal failed')
    }

    let gasFeePayment = null
    if (this.relayerQuote && this.relayerQuote.estimatedFee) {
      const feeAmount = BigInt(this.relayerQuote.estimatedFee)

      gasFeePayment = {
        isGasTank: false,
        paidBy: this.#selectedAccount.account!.addr,
        inToken: '0x0000000000000000000000000000000000000000', // ETH (native token)
        feeTokenChainId: BigInt(params.chainId),
        amount: feeAmount,
        simulatedGasLimit: 0n, // Not applicable for relayer transactions
        gasPrice: 0n, // Not applicable for relayer transactions
        broadcastOption: 'PrivacyPoolsRelayer',
        isSponsored: false
      }
    }

    const submittedAccountOp: SubmittedAccountOp = {
      accountAddr: this.#selectedAccount.account!.addr,
      chainId: BigInt(params.chainId),
      signingKeyAddr: null,
      signingKeyType: null,
      gasLimit: null,
      gasFeePayment,
      nonce: 0n, // Privacy pools don't use nonces
      signature: response.data.txId as `0x${string}`,
      accountOpToExecuteBefore: null,
      calls: [],
      status: AccountOpStatus.BroadcastedButNotConfirmed,
      txnId: response.data.txId,
      identifiedBy: {
        type: 'PrivacyPoolsRelayer',
        identifier: response.data.relayerId
      },
      timestamp: new Date().getTime(),
      meta: {
        // @ts-ignore
        isPrivacyPoolsWithdrawal: true,
        relayerId: response.data.relayerId,
        // @ts-ignore - Store withdrawal details for rich humanization
        withdrawalData: {
          recipient: this.recipientAddress, // The user's intended recipient address
          amount: parseUnits(this.withdrawalAmount, 18).toString(),
          token: '0x0000000000000000000000000000000000000000', // ETH address (native token)
          relayerAddress: params.withdrawal.processooor // BatchRelayer contract address
        }
      }
    }

    await this.#activity.addAccountOp(submittedAccountOp)

    this.latestBroadcastedAccountOp = submittedAccountOp

    this.#cleanupAfterBroadcast()

    this.#startTransactionPolling(BigInt(params.chainId), response.data.txId)

    this.emitUpdate()
  }

  async addImportedAccountToActivityController(accountName: string) {
    if (!this.#selectedAccount?.account) {
      throw new Error('No account selected')
    }

    // Construct a proper SubmittedAccountOp for the activity controller
    const submittedAccountOp: SubmittedAccountOp = {
      accountAddr: zeroAddress,
      chainId: BigInt(11155111),
      signingKeyAddr: null,
      signingKeyType: null,
      gasLimit: null,
      gasFeePayment: null,
      nonce: 0n, // Privacy pools don't use nonces
      signature: '0x' as `0x${string}`,
      accountOpToExecuteBefore: null,
      calls: [],
      status: AccountOpStatus.Success,
      txnId: new Date().getTime().toString(),
      identifiedBy: {
        type: 'ImportedAccount',
        identifier: accountName
      },
      timestamp: new Date().getTime()
    }

    await this.#activity.addAccountOp(submittedAccountOp)
    this.emitUpdate()
  }

  #cleanupAfterBroadcast() {
    this.selectedToken = null
    this.depositAmount = ''
    this.withdrawalAmount = ''
    this.addressState = { ...DEFAULT_ADDRESS_STATE }
    this.amountInFiat = ''
    this.amountFieldMode = 'token'
    this.isRecipientAddressUnknown = false
    this.isRecipientAddressUnknownAgreed = false
    this.programmaticUpdateCounter = 0
    this.relayerQuote = null
    this.updateQuoteStatus = 'INITIAL'
    this.#updateQuoteId = undefined
    this.batchSize = 1

    this.#stopQuoteRefetch()

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

  async resetSecret() {
    this.secret = null
    this.emitUpdate()
  }

  async syncSignAccountOp(calls?: Call[]) {
    console.log('DEBUG syncSignAccountOp: called')
    if (!this.#selectedAccount?.account) {
      console.log('DEBUG syncSignAccountOp: no selected account, returning')
      return
    }

    const transactionCalls: Call[] = calls || []

    if (!transactionCalls.length) {
      console.log('DEBUG syncSignAccountOp: no calls, returning')
      return
    }

    console.log('DEBUG syncSignAccountOp: controller exists?', !!this.signAccountOpController)

    try {
      // IMPORTANT: Enable tracking for the upcoming broadcast
      // This flag is checked in main.ts handleSignAndBroadcastAccountOp() to determine
      // whether to set latestBroadcastedAccountOp after successful broadcast
      this.shouldTrackLatestBroadcastedAccountOp = true

      if (this.signAccountOpController) {
        this.signAccountOpController.update({ calls: transactionCalls })

        if (this.#pendingWithdrawalParams) {
          if (!this.signAccountOpController.accountOp.meta) {
            this.signAccountOpController.accountOp.meta = {}
          }
          // @ts-ignore - Custom meta property for privacy pools withdrawal
          this.signAccountOpController.accountOp.meta.withdrawalData = {
            chainId: this.#pendingWithdrawalParams.chainId,
            poolAddress: this.#pendingWithdrawalParams.poolAddress,
            recipient: this.#pendingWithdrawalParams.recipient,
            totalAmount: this.#pendingWithdrawalParams.totalAmount,
            isPrivacyPoolsWithdrawal: true
          }
        }

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
        //     'DEBUG: Errors on PrivacyPools re-estimate',
        //     this.signAccountOpController.estimation.errors
        //   )
        // }
      }
    }

    loop()
  }

  async submitBatchWithdrawal(params: BatchWithdrawalParams): Promise<BatchWithdrawalResponse> {
    try {
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

      const response = await this.#callRelayer('/relayer/batch/request', 'POST', serializedParams, {
        'Content-Type': 'application/json'
      })

      if (!response.success) {
        throw new Error(response.message || 'Batch withdrawal submission failed')
      }

      return {
        success: true,
        data: {
          txId: response.data?.txId || response.txId || response.txHash,
          relayerId: response.data?.relayerId || response.id || response.requestId,
          estimatedConfirmation: response.data?.estimatedConfirmation
        }
      }
    } catch (error) {
      console.log('DEBUG: Error submitting batch withdrawal to relayer', error)
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

  #startTransactionPolling(chainId: bigint, txId: string) {
    this.#stopTransactionPolling()

    const network = this.#networks.networks.find((net) => net.chainId === chainId)
    if (!network) {
      console.error('DEBUG: Network not found for chainId:', chainId)
      return
    }

    const provider = this.#providers.providers[network.chainId.toString()]
    if (!provider) {
      console.error('DEBUG: Provider not found for chainId:', chainId)
      return
    }

    this.#transactionPollingAbortController = new AbortController()
    const signal = this.#transactionPollingAbortController.signal

    const startTime = Date.now()
    const TIMEOUT = 15 * 60 * 1000 // 15 minutes timeout (like ActivityController)
    const POLL_INTERVAL = 5000 // 5 seconds

    const pollLoop = async () => {
      let pollCount = 0
      while (!signal.aborted) {
        try {
          pollCount++
          const elapsed = Date.now() - startTime
          console.log(
            `DEBUG: Polling attempt #${pollCount} (elapsed: ${Math.round(elapsed / 1000)}s)`
          )

          // Check for timeout
          if (elapsed > TIMEOUT) {
            const newStatus = AccountOpStatus.BroadcastButStuck
            console.log('DEBUG: Transaction timeout, marking as stuck')

            if (this.latestBroadcastedAccountOp && this.#selectedAccount?.account) {
              // Update local tracking
              this.latestBroadcastedAccountOp = {
                ...this.latestBroadcastedAccountOp,
                // @ts-ignore
                status: newStatus
              }

              // Update ActivityController for persistence
              // eslint-disable-next-line no-await-in-loop
              await this.#activity.updateAccountOpStatus(
                this.#selectedAccount.account.addr,
                chainId,
                txId,
                newStatus
              )

              this.emitUpdate()

              // Stop polling - tracking screen will stay visible until user manually dismisses it
            }
            this.#stopTransactionPolling()
            break
          }

          // eslint-disable-next-line no-await-in-loop
          const receipt = await provider.getTransactionReceipt(txId)

          if (receipt) {
            const isSuccess = !!receipt.status
            const newStatus = isSuccess ? AccountOpStatus.Success : AccountOpStatus.Failure

            if (this.latestBroadcastedAccountOp && this.#selectedAccount?.account) {
              this.latestBroadcastedAccountOp = {
                ...this.latestBroadcastedAccountOp,
                // @ts-ignore - Update status based on receipt
                status: newStatus
              }

              // eslint-disable-next-line no-await-in-loop
              await this.#activity.updateAccountOpStatus(
                this.#selectedAccount.account.addr,
                chainId,
                txId,
                newStatus
              )

              this.emitUpdate()

              // Stop polling - tracking screen will stay visible until user manually dismisses it
            }

            this.#stopTransactionPolling()
            console.log('DEBUG: Polling stopped after confirmation')
            break
          } else {
            console.log('DEBUG: No receipt yet, will retry in', POLL_INTERVAL / 1000, 'seconds')
          }

          // Wait before next poll
          // eslint-disable-next-line no-await-in-loop
          await wait(POLL_INTERVAL)
        } catch (error) {
          console.error('DEBUG: Error polling transaction:', error)
          console.error('DEBUG: Error details:', {
            message: error instanceof Error ? error.message : 'Unknown error',
            stack: error instanceof Error ? error.stack : undefined
          })
          // Continue polling even on error
          // eslint-disable-next-line no-await-in-loop
          await wait(POLL_INTERVAL)
        }
      }
    }

    pollLoop()
  }

  #stopTransactionPolling() {
    if (this.#transactionPollingAbortController) {
      this.#transactionPollingAbortController.abort()
      this.#transactionPollingAbortController = null
    }
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

  get selectedToken() {
    return this.#selectedToken
  }

  get validationFormMsgs() {
    const validationFormMsgsNew = { ...DEFAULT_VALIDATION_FORM_MSGS }

    if (this.depositAmount && this.selectedToken && this.selectedToken.decimals) {
      try {
        const amountToValidate = formatUnits(
          BigInt(this.depositAmount),
          this.selectedToken.decimals
        )

        const poolInfo = this.pools.find(
          (pool) => BigInt(pool.chainId) === this.selectedToken.chainId
        )

        if (poolInfo) {
          validationFormMsgsNew.amount = validatePrivacyPoolsDepositAmount(
            amountToValidate,
            this.selectedToken,
            poolInfo.minDeposit,
            poolInfo.maxDeposit
          )
        } else {
          validationFormMsgsNew.amount = {
            success: false,
            message: 'Pool configuration not found for this token.'
          }
        }
      } catch (error) {
        console.error('Failed to format deposit amount:', error)
        validationFormMsgsNew.amount = {
          success: false,
          message: 'Invalid amount.'
        }
      }
    }

    if (this.withdrawalAmount && this.#selectedAccount?.account?.addr && this.recipientAddress) {
      const isEnsAddress = !!this.addressState.ensAddress

      if (!isValidAddress(this.recipientAddress)) {
        validationFormMsgsNew.recipientAddress = {
          success: false,
          message: 'Invalid address format'
        }
      } else if (this.addressState.isDomainResolving) {
        validationFormMsgsNew.recipientAddress = {
          success: false,
          message: 'Resolving domain...'
        }
      } else {
        validationFormMsgsNew.recipientAddress = validateSendTransferAddress(
          this.recipientAddress,
          this.#selectedAccount.account.addr,
          this.isRecipientAddressUnknownAgreed,
          this.isRecipientAddressUnknown,
          false, // isRecipientHumanizerKnownTokenOrSmartContract - not used in privacy pools
          isEnsAddress,
          this.addressState.isDomainResolving,
          false, // isSWWarningVisible - not used in privacy pools
          false // isSWWarningAgreed - not used in privacy pools
        )
      }
    }

    return validationFormMsgsNew
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
      recipientAddress: this.recipientAddress,
      validationFormMsgs: this.validationFormMsgs
    }
  }
}

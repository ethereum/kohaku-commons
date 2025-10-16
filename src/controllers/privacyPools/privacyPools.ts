/* eslint-disable no-console */
import {
  formatUnits,
  getAddress,
  keccak256,
  parseUnits,
  toBytes,
  type Address,
  type Hex
} from 'viem'
import { HDNodeWallet, Mnemonic } from 'ethers'
import type { KeystoreController } from '../keystore/keystore'
import { type ChainData, chainData, whitelistedChains } from './config'
import EventEmitter from '../eventEmitter/eventEmitter'
import { SignAccountOpController, SigningStatus } from '../signAccountOp/signAccountOp'
import { getBaseAccount } from '../../libs/account/getBaseAccount'
import { AccountOp } from '../../libs/accountOp/accountOp'
import { AccountOpStatus, Call } from '../../libs/accountOp/types'
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
import {
  convertTokenPriceToBigInt,
  getSafeAmountFromFieldValue
} from '../../utils/numbers/formatters'
import { getAppSecret, getEip712Payload } from './derivation'
import { relayerCall } from '../../libs/relayerCall/relayerCall'
import { Fetch } from '../../interfaces/fetch'
import { generateUuid } from '../../utils/uuid'
import wait from '../../utils/wait'

const HARD_CODED_CURRENCY = 'usd'

interface PrivacyPoolsFormUpdate {
  depositAmount?: string
  withdrawalAmount?: string
  seedPhrase?: string
  addressState?: AddressState
  importedSecretNote?: string
  selectedToken?: any
  maxAmount?: string
  shouldSetMaxAmount?: boolean
  isRecipientAddressUnknownAgreed?: boolean
  batchSize?: number
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

  #quoteRefetchAbortController: AbortController | null = null

  #transactionPollingAbortController: AbortController | null = null

  #pendingWithdrawalProof: TransformedProof[] | null = null

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

  maxAmount: string = ''

  secret: string | null = null

  seedPhrase: string = ''

  addressState: AddressState = { ...DEFAULT_ADDRESS_STATE }

  #selectedToken: any = null

  importedSecretNote: string = ''

  updateQuoteStatus: 'INITIAL' | 'LOADING' = 'INITIAL'

  relayerQuote: {
    relayFeeBPS: number
    feeRecipient: string
    totalAmountWithFee: string
    data: string
  } | null = null

  // Transfer/Withdrawal-specific properties
  amountInFiat: string = ''

  amountFieldMode: 'token' | 'fiat' = 'token'

  isRecipientAddressUnknown: boolean = false

  isRecipientAddressUnknownAgreed: boolean = false

  latestBroadcastedToken: any = null

  programmaticUpdateCounter: number = 0

  batchSize: number = 1

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

  #getIsFormValidToFetchQuote() {
    return (
      !!this.withdrawalAmount &&
      parseFloat(this.withdrawalAmount) > 0 &&
      !!this.selectedToken &&
      !!this.recipientAddress &&
      this.validationFormMsgs.amount.success &&
      this.validationFormMsgs.recipientAddress.success
    )
  }

  update({
    depositAmount,
    withdrawalAmount,
    seedPhrase,
    addressState,
    importedSecretNote,
    selectedToken,
    maxAmount,
    shouldSetMaxAmount,
    isRecipientAddressUnknownAgreed,
    batchSize
  }: PrivacyPoolsFormUpdate) {
    let shouldUpdateQuote = false

    if (typeof depositAmount === 'string') {
      this.depositAmount = depositAmount
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

    if (shouldSetMaxAmount && this.maxAmount) {
      this.withdrawalAmount = this.maxAmount
      this.#calculateAmountInFiat(this.maxAmount)
      this.programmaticUpdateCounter++
      shouldUpdateQuote = true
    }

    this.seedPhrase = seedPhrase || ''

    this.emitUpdate()

    // Trigger debounced quote fetch when relevant fields change
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

    // Debounce to avoid excessive calls
    if (debounce) await wait(500)
    if (this.#updateQuoteId !== quoteId) return // Guard check

    try {
      // Get the selected pool info - we need chainId and other details
      // For now, we'll use a placeholder. You'll need to pass or determine the correct pool info
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
      const quoteResponse = await this.#fetch(
        `${this.#privacyPoolsRelayerUrl}/relayer/batch/quote`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chainId: selectedPoolInfo.chainId,
            batchSize: this.batchSize,
            totalAmount: parseUnits(this.withdrawalAmount, 18).toString(),
            recipient: this.recipientAddress
          })
        }
      )

      if (!quoteResponse.ok) {
        throw new Error('Failed to fetch quote')
      }

      const quote = await quoteResponse.json()

      if (this.#updateQuoteId !== quoteId) return // Guard check after async

      // Store the quote
      this.relayerQuote = {
        relayFeeBPS: quote.relayFeeBPS,
        feeRecipient: getAddress(relayerDetails.feeReceiverAddress),
        // TODO: This will be used in future (probably)
        totalAmountWithFee: (
          parseFloat(this.withdrawalAmount) *
          (1 + quote.relayFeeBPS / 10000)
        ).toString(),
        data: quote.batchFeeCommitment.batchRelayData
      }

      console.log('DEBUG: relayerQuote', this.relayerQuote)

      // Start periodic refetch to keep quote fresh (quotes are valid for ~20 seconds)
      this.#startQuoteRefetch()
    } catch (error) {
      if (this.#updateQuoteId !== quoteId) return // Guard check

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
    this.relayerQuote = null
    this.updateQuoteStatus = 'INITIAL'
    this.#updateQuoteId = undefined
    this.#pendingWithdrawalProof = null
    this.#pendingWithdrawalParams = null

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

    this.#stopQuoteRefetch()
    this.#pendingWithdrawalProof = null
    this.#pendingWithdrawalParams = null
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

  async prepareWithdrawal(params: BatchWithdrawalParams) {
    if (!this.#selectedAccount?.account) {
      throw new Error('No account selected')
    }

    if (!this.relayerQuote) {
      throw new Error('No relayer quote available')
    }

    // Store the withdrawal proof and params
    this.#pendingWithdrawalProof = params.proofs
    this.#pendingWithdrawalParams = {
      chainId: params.chainId,
      poolAddress: params.poolAddress,
      processooor: params.withdrawal.processooor,
      recipient: this.recipientAddress || '',
      batchSize: params.proofs.length,
      totalAmount: this.withdrawalAmount,
      data: params.withdrawal.data
    }

    // Create a placeholder call for the confirmation modal
    // IMPORTANT: For Privacy Pools withdrawals via relayer, this Call is NEVER broadcast
    // The actual withdrawal is submitted to the relayer API in broadcastWithdrawal()
    // We create a simple placeholder Call (0 ETH transfer) that will pass estimation
    // This allows the SignAccountOpController to initialize and show the confirmation modal
    const placeholderCall: Call = {
      to: (this.recipientAddress || this.#selectedAccount.account.addr) as `0x${string}`,
      value: 0n,
      data: '0x' as `0x${string}`, // Empty data - simple ETH transfer
      fromUserRequestId: randomId()
    }

    // Initialize SignAccountOpController with the placeholder call
    // This shows the confirmation modal with transaction details
    // When user confirms, broadcastWithdrawal() will be called instead of broadcasting this Call
    await this.syncSignAccountOp([placeholderCall])

    this.emitUpdate()
  }

  async broadcastWithdrawal() {
    if (!this.#pendingWithdrawalProof || !this.#pendingWithdrawalParams) {
      throw new Error('No pending withdrawal to broadcast')
    }

    if (!this.#selectedAccount?.account) {
      throw new Error('No account selected')
    }

    // Update SignAccountOpController status to show loading screen
    if (this.signAccountOpController) {
      this.signAccountOpController.updateStatus(SigningStatus.InProgress)
    }

    // IMMEDIATELY set latestBroadcastedAccountOp to show loading screen
    // This allows the UI to transition to the track screen right away
    this.latestBroadcastedAccountOp = {
      accountAddr: this.#selectedAccount.account.addr,
      chainId: BigInt(this.#pendingWithdrawalParams.chainId),
      signingKeyAddr: null,
      signingKeyType: null,
      gasLimit: null,
      gasFeePayment: null,
      nonce: 0n,
      signature: '0x' as `0x${string}`, // Temporary placeholder, will be updated with actual txId
      accountOpToExecuteBefore: null,
      calls: this.signAccountOpController?.accountOp.calls || [],
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

    // Build params for relayer API
    const params: BatchWithdrawalParams = {
      chainId: this.#pendingWithdrawalParams.chainId,
      poolAddress: this.#pendingWithdrawalParams.poolAddress,
      withdrawal: {
        processooor: this.#pendingWithdrawalParams.processooor,
        data: this.#pendingWithdrawalParams.data
      },
      proofs: this.#pendingWithdrawalProof
    }

    const response = await this.submitBatchWithdrawal(params)

    console.log('DEBUG broadcastWithdrawal: response', response)

    if (!response.success || !response.data) {
      // Update status to Done even on error so user can retry
      if (this.signAccountOpController) {
        this.signAccountOpController.updateStatus(SigningStatus.Done)
      }
      throw new Error(response.message || 'Withdrawal failed')
    }

    console.log('DEBUG broadcastWithdrawal: response.data', response.data)
    console.log('DEBUG broadcastWithdrawal: txId', response.data.txId)
    console.log('DEBUG broadcastWithdrawal: relayerId', response.data.relayerId)

    // Update latestBroadcastedAccountOp with actual transaction data from relayer
    this.latestBroadcastedAccountOp = {
      ...this.latestBroadcastedAccountOp,
      signature: response.data.txId as `0x${string}`, // Use txHash as signature for tracking
      // @ts-ignore
      txnId: response.data.txId,
      meta: {
        ...(this.latestBroadcastedAccountOp?.meta || {}),
        // @ts-ignore - Update with actual relayer response data
        txnId: response.data.txId,
        // @ts-ignore
        relayerId: response.data.relayerId
      }
    }

    console.log(
      'DEBUG broadcastWithdrawal: Updated latestBroadcastedAccountOp with relayer response',
      this.latestBroadcastedAccountOp
    )

    this.#pendingWithdrawalProof = null
    this.#pendingWithdrawalParams = null

    this.#startTransactionPolling(
      BigInt(this.latestBroadcastedAccountOp?.chainId || 0),
      response.data.txId
    )

    this.emitUpdate()

    console.log(
      'DEBUG broadcastWithdrawal: after emitUpdate, latestBroadcastedAccountOp',
      this.latestBroadcastedAccountOp
    )
  }

  async resetSecret() {
    this.secret = null
    this.emitUpdate()
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

        // Update withdrawal metadata if we have pending withdrawal
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
    // Stop any existing polling
    this.#stopTransactionPolling()

    console.log('DEBUG: Starting transaction polling', { chainId: chainId.toString(), txId })

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

    console.log('DEBUG: Provider found, starting polling loop')

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
            if (this.latestBroadcastedAccountOp) {
              this.latestBroadcastedAccountOp = {
                ...this.latestBroadcastedAccountOp,
                // @ts-ignore
                status: AccountOpStatus.BroadcastButStuck
              }
              this.emitUpdate()
            }
            this.#stopTransactionPolling()
            break
          }

          // eslint-disable-next-line no-await-in-loop
          const receipt = await provider.getTransactionReceipt(txId)

          if (receipt) {
            console.log('DEBUG: Transaction receipt found!', {
              status: receipt.status,
              blockNumber: receipt.blockNumber,
              gasUsed: receipt.gasUsed?.toString()
            })

            // Determine success based on receipt status
            const isSuccess = !!receipt.status

            if (this.latestBroadcastedAccountOp) {
              this.latestBroadcastedAccountOp = {
                ...this.latestBroadcastedAccountOp,
                // @ts-ignore - Update status based on receipt
                status: isSuccess ? AccountOpStatus.Success : AccountOpStatus.Failure
              }

              this.emitUpdate()
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
      recipientAddress: this.recipientAddress
    }
  }
}

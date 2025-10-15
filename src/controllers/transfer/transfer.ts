import { ActivityController } from 'ambire-common/src/controllers/activity/activity'
import { formatUnits, isAddress, parseUnits } from 'ethers'

import { FEE_COLLECTOR } from '../../consts/addresses'
import { AddressState } from '../../interfaces/domains'
import { ExternalSignerControllers } from '../../interfaces/keystore'
import { TransferUpdate } from '../../interfaces/transfer'
import { isSmartAccount } from '../../libs/account/account'
import { getBaseAccount } from '../../libs/account/getBaseAccount'
import { AccountOp } from '../../libs/accountOp/accountOp'
import { Call } from '../../libs/accountOp/types'
import { getAmbirePaymasterService } from '../../libs/erc7677/erc7677'
import { HumanizerMeta } from '../../libs/humanizer/interfaces'
import { randomId } from '../../libs/humanizer/utils'
import { TokenResult } from '../../libs/portfolio'
import { getTokenAmount } from '../../libs/portfolio/helpers'
import { getSanitizedAmount } from '../../libs/transfer/amount'
import { buildTransferUserRequest } from '../../libs/transfer/userRequest'
import { validateSendTransferAddress, validateSendTransferAmount } from '../../services/validations'
import { getAddressFromAddressState } from '../../utils/domains'
import {
  convertTokenPriceToBigInt,
  getSafeAmountFromFieldValue
} from '../../utils/numbers/formatters'
import wait from '../../utils/wait'
import { AccountsController } from '../accounts/accounts'
import { AddressBookController } from '../addressBook/addressBook'
import { EstimationStatus } from '../estimation/types'
import EventEmitter from '../eventEmitter/eventEmitter'
import { KeystoreController } from '../keystore/keystore'
import { NetworksController } from '../networks/networks'
import { PortfolioController } from '../portfolio/portfolio'
import { ProvidersController } from '../providers/providers'
import { SelectedAccountController } from '../selectedAccount/selectedAccount'
import { SignAccountOpController } from '../signAccountOp/signAccountOp'
import { StorageController } from '../storage/storage'

const CONVERSION_PRECISION = 16
const CONVERSION_PRECISION_POW = BigInt(10 ** CONVERSION_PRECISION)

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

const HARD_CODED_CURRENCY = 'usd'

export class TransferController extends EventEmitter {
  #storage: StorageController

  #networks: NetworksController

  #addressBook: AddressBookController

  #selectedToken: TokenResult | null = null

  #selectedAccountData: SelectedAccountController

  #humanizerInfo: HumanizerMeta | null = null

  isSWWarningVisible = false

  isSWWarningAgreed = false

  /**
   * The field value for the amount input. Not sanitized and can contain
   * invalid values. Use #getSafeAmountFromFieldValue() to get a formatted value.
   */
  amount = ''

  amountInFiat = ''

  /**
   * A counter used to trigger UI updates when a form values is
   * changed programmatically by the controller.
   */
  programmaticUpdateCounter = 0

  amountFieldMode: 'fiat' | 'token' = 'token'

  addressState: AddressState = { ...DEFAULT_ADDRESS_STATE }

  isRecipientAddressUnknown = false

  isRecipientAddressUnknownAgreed = false

  isRecipientHumanizerKnownTokenOrSmartContract = false

  isTopUp: boolean = false

  #shouldSkipTransactionQueuedModal: boolean = false

  #accounts: AccountsController

  #keystore: KeystoreController

  #portfolio: PortfolioController

  #externalSignerControllers: ExternalSignerControllers

  #providers: ProvidersController

  #relayerUrl: string

  signAccountOpController: SignAccountOpController | null = null

  /**
   * Holds all subscriptions (on update and on error) to the signAccountOpController.
   * This is needed to unsubscribe from the subscriptions when the controller is destroyed.
   */
  #signAccountOpSubscriptions: Function[] = []

  latestBroadcastedAccountOp: AccountOp | null = null

  latestBroadcastedToken: TokenResult | null = null

  #shouldTrackLatestBroadcastedAccountOp: boolean = true

  hasProceeded: boolean = false

  // Used to safely manage and cancel the periodic estimation loop.
  // When destroySignAccountOp() is called, the AbortController is aborted,
  // which prevents further re-estimation calls even if a wait() is in progress.
  // This ensures only one active estimation loop exists at any time.
  #reestimateAbortController: AbortController | null = null

  // Holds the initial load promise, so that one can wait until it completes
  #initialLoadPromise: Promise<void>

  #activity: ActivityController

  constructor(
    storage: StorageController,
    humanizerInfo: HumanizerMeta,
    selectedAccountData: SelectedAccountController,
    networks: NetworksController,
    addressBook: AddressBookController,
    accounts: AccountsController,
    keystore: KeystoreController,
    portfolio: PortfolioController,
    activity: ActivityController,
    externalSignerControllers: ExternalSignerControllers,
    providers: ProvidersController,
    relayerUrl: string
  ) {
    super()

    this.#storage = storage
    this.#humanizerInfo = humanizerInfo
    this.#selectedAccountData = selectedAccountData
    this.#networks = networks
    this.#addressBook = addressBook

    this.#accounts = accounts
    this.#keystore = keystore
    this.#portfolio = portfolio
    this.#activity = activity
    this.#externalSignerControllers = externalSignerControllers
    this.#providers = providers
    this.#relayerUrl = relayerUrl

    this.#initialLoadPromise = this.#load()
    this.emitUpdate()
  }

  async #load() {
    this.#shouldSkipTransactionQueuedModal = await this.#storage.get(
      'shouldSkipTransactionQueuedModal',
      false
    )

    await this.#selectedAccountData.initialLoadPromise
  }

  get shouldSkipTransactionQueuedModal() {
    return this.#shouldSkipTransactionQueuedModal
  }

  set shouldSkipTransactionQueuedModal(value: boolean) {
    this.#shouldSkipTransactionQueuedModal = value
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this.#storage.set('shouldSkipTransactionQueuedModal', value)
    this.emitUpdate()
  }

  get shouldTrackLatestBroadcastedAccountOp() {
    return this.#shouldTrackLatestBroadcastedAccountOp
  }

  set shouldTrackLatestBroadcastedAccountOp(value: boolean) {
    this.#shouldTrackLatestBroadcastedAccountOp = value
  }

  // every time when updating selectedToken update the amount and maxAmount of the form
  set selectedToken(token: TokenResult | null) {
    if (!token || Number(getTokenAmount(token)) === 0) {
      this.#selectedToken = null
      this.#setAmountAndNotifyUI('')
      this.#setAmountInFiatAndNotifyUI('')
      this.amountFieldMode = 'token'
      return
    }

    const prevSelectedToken = { ...this.selectedToken }

    this.#selectedToken = token

    if (
      prevSelectedToken?.address !== token?.address ||
      prevSelectedToken?.chainId !== token?.chainId
    ) {
      if (!token.priceIn.length) {
        this.amountFieldMode = 'token'
      }
      this.#setAmountAndNotifyUI('')
      this.#setAmountInFiatAndNotifyUI('')
      this.#setSWWarningVisibleIfNeeded()
    }
  }

  get selectedToken() {
    return this.#selectedToken
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

  get maxAmountInFiat(): string {
    if (!this.selectedToken || getTokenAmount(this.selectedToken) === 0n) return '0'

    const tokenPrice = this.selectedToken?.priceIn.find(
      (p) => p.baseCurrency === HARD_CODED_CURRENCY
    )?.price
    if (!tokenPrice || !Number(this.maxAmount)) return '0'

    const maxAmount = getTokenAmount(this.selectedToken)
    const { tokenPriceBigInt, tokenPriceDecimals } = convertTokenPriceToBigInt(tokenPrice)

    // Multiply the max amount by the token price. The calculation is done in big int to avoid precision loss
    return formatUnits(
      maxAmount * tokenPriceBigInt,
      // Shift the decimal point by the number of decimals in the token price
      this.selectedToken.decimals + tokenPriceDecimals
    )
  }

  resetForm(shouldDestroyAccountOp = true) {
    this.selectedToken = null
    this.amount = ''
    this.amountInFiat = ''
    this.amountFieldMode = 'token'
    this.addressState = { ...DEFAULT_ADDRESS_STATE }
    this.#onRecipientAddressChange()
    this.programmaticUpdateCounter = 0

    if (shouldDestroyAccountOp) {
      this.destroySignAccountOp()
    }

    this.emitUpdate()
  }

  get validationFormMsgs() {
    if (!this.isInitialized) return DEFAULT_VALIDATION_FORM_MSGS

    const validationFormMsgsNew = DEFAULT_VALIDATION_FORM_MSGS

    if (this.#humanizerInfo && this.#selectedAccountData.account?.addr) {
      const isEnsAddress = !!this.addressState.ensAddress

      validationFormMsgsNew.recipientAddress = validateSendTransferAddress(
        this.recipientAddress,
        this.#selectedAccountData.account?.addr,
        this.isRecipientAddressUnknownAgreed,
        this.isRecipientAddressUnknown,
        this.isRecipientHumanizerKnownTokenOrSmartContract,
        isEnsAddress,
        this.addressState.isDomainResolving,
        this.isSWWarningVisible,
        this.isSWWarningAgreed
      )
    }

    // Validate the amount
    if (this.selectedToken) {
      validationFormMsgsNew.amount = validateSendTransferAmount(this.amount, this.selectedToken)
    }

    return validationFormMsgsNew
  }

  get isFormValid() {
    if (!this.isInitialized) return false

    // if the amount is set, it's enough in topUp mode
    if (this.isTopUp) {
      return (
        this.selectedToken && validateSendTransferAmount(this.amount, this.selectedToken).success
      )
    }

    const areFormFieldsValid =
      this.validationFormMsgs.amount.success && this.validationFormMsgs.recipientAddress.success

    const isSWWarningMissingOrAccepted = !this.isSWWarningVisible || this.isSWWarningAgreed

    const isRecipientAddressUnknownMissingOrAccepted =
      !this.isRecipientAddressUnknown || this.isRecipientAddressUnknownAgreed

    return (
      areFormFieldsValid &&
      isSWWarningMissingOrAccepted &&
      isRecipientAddressUnknownMissingOrAccepted &&
      !this.addressState.isDomainResolving
    )
  }

  get isInitialized() {
    return (
      !!this.#humanizerInfo &&
      !!this.#selectedAccountData.account?.addr &&
      !!this.#networks.networks.length
    )
  }

  get recipientAddress() {
    return this.addressState.ensAddress || this.addressState.fieldValue
  }

  async update({
    humanizerInfo,
    selectedToken,
    amount,
    shouldSetMaxAmount,
    addressState,
    isSWWarningAgreed,
    isRecipientAddressUnknownAgreed,
    isTopUp,
    amountFieldMode
  }: TransferUpdate) {
    this.shouldTrackLatestBroadcastedAccountOp = true

    if (humanizerInfo) {
      this.#humanizerInfo = humanizerInfo
    }

    if (amountFieldMode) {
      this.amountFieldMode = amountFieldMode
    }

    if (selectedToken) {
      if (selectedToken.chainId !== this.selectedToken?.chainId) {
        // The SignAccountOp controller is already initialized with the previous chainId and account operation.
        // When the chainId changes, we need to recreate the controller to correctly estimate for the new chain.
        // Here, we destroy it, and at the end of this update method, we initialize it again.
        this.destroySignAccountOp()
      }

      this.selectedToken = selectedToken
    }
    // If we do a regular check the value won't update if it's '' or '0'
    if (typeof amount === 'string') {
      this.#setAmount(amount)
    }

    if (shouldSetMaxAmount) {
      this.amountFieldMode = 'token'
      this.#setAmount(this.maxAmount, true)
    }

    if (addressState) {
      this.addressState = {
        ...this.addressState,
        ...addressState
      }
      if (this.isInitialized) {
        this.#onRecipientAddressChange()
      }
    }
    // We can do a regular check here, because the property defines if it should be updated
    // and not the actual value
    if (isSWWarningAgreed) {
      this.isSWWarningAgreed = !this.isSWWarningAgreed
    }
    // We can do a regular check here, because the property defines if it should be updated
    // and not the actual value
    if (isRecipientAddressUnknownAgreed) {
      this.isRecipientAddressUnknownAgreed = !this.isRecipientAddressUnknownAgreed
    }

    if (typeof isTopUp === 'boolean') {
      this.isTopUp = isTopUp
      this.#setSWWarningVisibleIfNeeded()
    }

    await this.syncSignAccountOp()
    this.emitUpdate()
  }

  checkIsRecipientAddressUnknown() {
    if (!isAddress(this.recipientAddress)) {
      this.isRecipientAddressUnknown = false
      this.isRecipientAddressUnknownAgreed = false

      this.emitUpdate()
      return
    }
    const isAddressInAddressBook = this.#addressBook.contacts.some(
      ({ address }) => address.toLowerCase() === this.recipientAddress.toLowerCase()
    )

    this.isRecipientAddressUnknown =
      !isAddressInAddressBook && this.recipientAddress.toLowerCase() !== FEE_COLLECTOR.toLowerCase()
    this.isRecipientAddressUnknownAgreed = false
    this.#setSWWarningVisibleIfNeeded()

    this.emitUpdate()
  }

  #onRecipientAddressChange() {
    if (!isAddress(this.recipientAddress)) {
      this.isRecipientAddressUnknown = false
      this.isRecipientAddressUnknownAgreed = false
      this.isRecipientHumanizerKnownTokenOrSmartContract = false
      this.isSWWarningVisible = false
      this.isSWWarningAgreed = false

      return
    }

    if (this.#humanizerInfo) {
      // @TODO: could fetch address code
      this.isRecipientHumanizerKnownTokenOrSmartContract =
        !!this.#humanizerInfo.knownAddresses[this.recipientAddress.toLowerCase()]?.isSC
    }

    this.checkIsRecipientAddressUnknown()
  }

  #setAmountAndNotifyUI(amount: string) {
    this.amount = amount
    this.programmaticUpdateCounter += 1
  }

  #setAmountInFiatAndNotifyUI(amountInFiat: string) {
    this.amountInFiat = amountInFiat
    this.programmaticUpdateCounter += 1
  }

  #setAmount(fieldValue: string, isProgrammaticUpdate = false) {
    if (isProgrammaticUpdate) {
      // There is no problem in updating this first as there are no
      // emit updates in this method
      this.programmaticUpdateCounter += 1
    }

    if (!fieldValue) {
      this.amount = ''
      this.amountInFiat = ''
      return
    }

    const tokenPrice = this.selectedToken?.priceIn.find(
      (p) => p.baseCurrency === HARD_CODED_CURRENCY
    )?.price

    if (!tokenPrice) {
      this.amount = fieldValue
      this.amountInFiat = ''
      return
    }

    if (this.amountFieldMode === 'fiat' && typeof this.selectedToken?.decimals === 'number') {
      this.amountInFiat = fieldValue

      // Get the number of decimals
      const amountInFiatDecimals = 10
      const { tokenPriceBigInt, tokenPriceDecimals } = convertTokenPriceToBigInt(tokenPrice)

      // Convert the numbers to big int
      const amountInFiatBigInt = parseUnits(
        getSanitizedAmount(fieldValue, amountInFiatDecimals),
        amountInFiatDecimals
      )

      this.amount = formatUnits(
        (amountInFiatBigInt * CONVERSION_PRECISION_POW) / tokenPriceBigInt,
        // Shift the decimal point by the number of decimals in the token price
        amountInFiatDecimals + CONVERSION_PRECISION - tokenPriceDecimals
      )

      return
    }
    if (this.amountFieldMode === 'token') {
      this.amount = fieldValue

      if (!this.selectedToken) return

      const formattedAmount = parseUnits(
        getSafeAmountFromFieldValue(fieldValue, this.selectedToken.decimals),
        this.selectedToken.decimals
      )

      if (!formattedAmount) return

      const { tokenPriceBigInt, tokenPriceDecimals } = convertTokenPriceToBigInt(tokenPrice)

      this.amountInFiat = formatUnits(
        formattedAmount * tokenPriceBigInt,
        // Shift the decimal point by the number of decimals in the token price
        this.selectedToken.decimals + tokenPriceDecimals
      )
    }
  }

  #setSWWarningVisibleIfNeeded() {
    if (!this.#selectedAccountData.account?.addr) return

    this.isSWWarningVisible =
      this.isRecipientAddressUnknown &&
      isSmartAccount(this.#selectedAccountData.account) &&
      !this.isTopUp &&
      !!this.selectedToken?.address &&
      Number(this.selectedToken?.address) === 0 &&
      this.#networks.networks
        .filter((n) => n.chainId !== 1n)
        .map(({ chainId }) => chainId)
        .includes(this.selectedToken.chainId || 1n)

    this.emitUpdate()
  }

  get hasPersistedState() {
    return !!(this.amount || this.amountInFiat || this.addressState.fieldValue)
  }

  async syncSignAccountOp() {
    // shouldn't happen ever
    if (!this.#selectedAccountData.account) return

    const recipientAddress = this.isTopUp
      ? FEE_COLLECTOR
      : getAddressFromAddressState(this.addressState)

    // form field validation
    if (!this.#selectedToken || !this.amount || !isAddress(recipientAddress)) return

    const userRequest = buildTransferUserRequest({
      selectedAccount: this.#selectedAccountData.account.addr,
      amount: getSafeAmountFromFieldValue(this.amount, this.selectedToken?.decimals),
      selectedToken: this.#selectedToken,
      recipientAddress
    })

    if (!userRequest || userRequest.action.kind !== 'calls') {
      this.emitError({
        level: 'major',
        message: 'Unexpected error while building transfer request',
        error: new Error(
          'buildUserRequestFromTransferRequest: bad parameters passed to buildTransferUserRequest'
        )
      })

      return
    }

    const calls = userRequest.action.calls

    // If SignAccountOpController is already initialized, we just update it.
    if (this.signAccountOpController) {
      this.signAccountOpController.update({ calls })
      return
    }

    await this.#initSignAccOp(calls)
  }

  async #initSignAccOp(calls: Call[]) {
    if (!this.#selectedAccountData.account || this.signAccountOpController) return

    const network = this.#networks.networks.find(
      (net) => net.chainId === this.#selectedToken!.chainId
    )

    // shouldn't happen ever
    if (!network) return

    const provider = this.#providers.providers[network.chainId.toString()]
    const accountState = await this.#accounts.getOrFetchAccountOnChainState(
      this.#selectedAccountData.account.addr,
      network.chainId
    )

    const baseAcc = getBaseAccount(
      this.#selectedAccountData.account,
      accountState,
      this.#keystore.getAccountKeys(this.#selectedAccountData.account),
      network
    )

    const accountOp = {
      accountAddr: this.#selectedAccountData.account.addr,
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
      this.#selectedAccountData.account,
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

  /**
   * Reestimate the signAccountOp request periodically.
   * Encapsulate it here instead of creating an interval in the background
   * as intervals are tricky and harder to control
   */
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
            'Errors on Transfer re-estimate',
            this.signAccountOpController.estimation.errors
          )
        }
      }
    }

    loop()
  }

  setUserProceeded(hasProceeded: boolean) {
    this.hasProceeded = hasProceeded
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
    this.latestBroadcastedToken = null
    this.emitUpdate()
  }

  unloadScreen(forceUnload?: boolean) {
    if (this.hasPersistedState && !forceUnload) return

    this.destroyLatestBroadcastedAccountOp()
    this.resetForm()
  }

  // includes the getters in the stringified instance
  toJSON() {
    return {
      ...this,
      ...super.toJSON(),
      validationFormMsgs: this.validationFormMsgs,
      isFormValid: this.isFormValid,
      isInitialized: this.isInitialized,
      selectedToken: this.selectedToken,
      maxAmount: this.maxAmount,
      maxAmountInFiat: this.maxAmountInFiat,
      shouldSkipTransactionQueuedModal: this.shouldSkipTransactionQueuedModal,
      hasPersistedState: this.hasPersistedState
    }
  }
}

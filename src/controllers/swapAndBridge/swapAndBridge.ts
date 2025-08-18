import { formatUnits, isAddress, parseUnits } from 'ethers'

import EmittableError from '../../classes/EmittableError'
import SwapAndBridgeError from '../../classes/SwapAndBridgeError'
import { ExternalSignerControllers } from '../../interfaces/keystore'
import { Network } from '../../interfaces/network'
/* eslint-disable no-await-in-loop */
import { SignAccountOpError } from '../../interfaces/signAccountOp'
import {
  CachedSupportedChains,
  CachedTokenListKey,
  CachedToTokenLists,
  FromToken,
  SocketApiBridgeStep,
  SocketAPIBridgeUserTx,
  SwapAndBridgeActiveRoute,
  SwapAndBridgeQuote,
  SwapAndBridgeRoute,
  SwapAndBridgeRouteStatus,
  SwapAndBridgeSendTxRequest,
  SwapAndBridgeToToken,
  SwapAndBridgeUserTx
} from '../../interfaces/swapAndBridge'
import { UserRequest } from '../../interfaces/userRequest'
import { isBasicAccount, isSmartAccount } from '../../libs/account/account'
import { getBaseAccount } from '../../libs/account/getBaseAccount'
import { SubmittedAccountOp } from '../../libs/accountOp/submittedAccountOp'
import { AccountOpStatus, Call } from '../../libs/accountOp/types'
import { getBridgeBanners } from '../../libs/banners/banners'
import { getAmbirePaymasterService } from '../../libs/erc7677/erc7677'
import { randomId } from '../../libs/humanizer/utils'
import { TokenResult } from '../../libs/portfolio'
import { getTokenAmount } from '../../libs/portfolio/helpers'
import { batchCallsFromUserRequests } from '../../libs/requests/requests'
import {
  addCustomTokensIfNeeded,
  convertPortfolioTokenToSwapAndBridgeToToken,
  getActiveRoutesForAccount,
  getIsBridgeTxn,
  getIsTokenEligibleForSwapAndBridge,
  getSwapAndBridgeCalls,
  lifiTokenListFilter,
  mapNativeToAddr,
  sortPortfolioTokenList,
  sortTokenListResponse
} from '../../libs/swapAndBridge/swapAndBridge'
import { getHumanReadableSwapAndBridgeError } from '../../libs/swapAndBridge/swapAndBridgeErrorHumanizer'
import { getSanitizedAmount } from '../../libs/transfer/amount'
import { LiFiAPI } from '../../services/lifi/api'
import { normalizeIncomingSocketToken, SocketAPI } from '../../services/socket/api'
import { ZERO_ADDRESS } from '../../services/socket/constants'
import { validateSendTransferAmount } from '../../services/validations/validate'
import formatDecimals from '../../utils/formatDecimals/formatDecimals'
import {
  convertTokenPriceToBigInt,
  getSafeAmountFromFieldValue
} from '../../utils/numbers/formatters'
import { generateUuid } from '../../utils/uuid'
import wait from '../../utils/wait'
import { AccountsController } from '../accounts/accounts'
import { AccountOpAction, Action } from '../actions/actions'
import { ActivityController } from '../activity/activity'
import { EstimationStatus } from '../estimation/types'
import EventEmitter, { Statuses } from '../eventEmitter/eventEmitter'
import { InviteController } from '../invite/invite'
import { KeystoreController } from '../keystore/keystore'
import { NetworksController } from '../networks/networks'
import { PortfolioController } from '../portfolio/portfolio'
import { ProvidersController } from '../providers/providers'
import { SelectedAccountController } from '../selectedAccount/selectedAccount'
import { SignAccountOpController } from '../signAccountOp/signAccountOp'
import { StorageController } from '../storage/storage'

type SwapAndBridgeErrorType = {
  id: 'to-token-list-fetch-failed' | 'no-routes'
  title: string
  text?: string
  level: 'error' | 'warning'
}

const HARD_CODED_CURRENCY = 'usd'

const CONVERSION_PRECISION = 16
const CONVERSION_PRECISION_POW = BigInt(10 ** CONVERSION_PRECISION)

const NETWORK_MISMATCH_MESSAGE =
  'Swap & Bridge network configuration mismatch. Please try again or contact Ambire support.'

// For performance reasons, limit the max number of tokens in the to token list
const TO_TOKEN_LIST_LIMIT = 100

export enum SwapAndBridgeFormStatus {
  Empty = 'empty',
  Invalid = 'invalid',
  FetchingRoutes = 'fetching-routes',
  NoRoutesFound = 'no-routes-found',
  InvalidRouteSelected = 'invalid-route-selected',
  ReadyToEstimate = 'ready-to-estimate',
  ReadyToSubmit = 'ready-to-submit',
  Proceeded = 'proceeded'
}

const STATUS_WRAPPED_METHODS = {
  addToTokenByAddress: 'INITIAL'
} as const

const SUPPORTED_CHAINS_CACHE_THRESHOLD = 1000 * 60 * 60 * 24 // 1 day
const TO_TOKEN_LIST_CACHE_THRESHOLD = 1000 * 60 * 60 * 4 // 4 hours

const PROTOCOLS_WITH_CONTRACT_FEE_IN_NATIVE = [
  'stargate',
  'stargate-v2',
  'arbitrum-bridge',
  'zksync-native'
]

/**
 * The Swap and Bridge controller is responsible for managing the state and
 * logic related to swapping and bridging tokens across different networks.
 * Key responsibilities:
 *  - Initially setting up the swap and bridge form with the necessary data.
 *  - Managing form state for token swap and bridge operations (including user preferences).
 *  - Fetching and updating token lists (from and to).
 *  - Fetching and updating quotes for token swaps and bridges.
 *  - Manages token active routes
 */
export class SwapAndBridgeController extends EventEmitter {
  #selectedAccount: SelectedAccountController

  #networks: NetworksController

  #activity: ActivityController

  #invite: InviteController

  #storage: StorageController

  #serviceProviderAPI: SocketAPI | LiFiAPI

  #activeRoutes: SwapAndBridgeActiveRoute[] = []

  statuses: Statuses<keyof typeof STATUS_WRAPPED_METHODS> = STATUS_WRAPPED_METHODS

  updateQuoteStatus: 'INITIAL' | 'LOADING' = 'INITIAL'

  #updateToTokenListThrottle: {
    time: number
    throttled: boolean
    shouldReset: boolean
    addressToSelect?: string
  } = {
    time: 0,
    shouldReset: true,
    throttled: false
  }

  #updateQuoteId?: string

  updateToTokenListStatus: 'INITIAL' | 'LOADING' = 'INITIAL'

  switchTokensStatus: 'INITIAL' | 'LOADING' = 'INITIAL'

  sessionIds: string[] = []

  fromChainId: number | null = 1

  fromSelectedToken: FromToken | null = null

  fromAmount: string = ''

  fromAmountInFiat: string = ''

  /**
   * A counter used to trigger UI updates when the amount is changed programmatically
   * by the controller.
   */
  fromAmountUpdateCounter: number = 0

  fromAmountFieldMode: 'fiat' | 'token' = 'token'

  toChainId: number | null = 1

  toSelectedToken: SwapAndBridgeToToken | null = null

  toTokenSearchTerm: string = ''

  toTokenSearchResults: SwapAndBridgeToToken[] = []

  quote: SwapAndBridgeQuote | null = null

  quoteRoutesStatuses: { [key: string]: { status: string } } = {}

  portfolioTokenList: FromToken[] = []

  isTokenListLoading: boolean = false

  errors: SwapAndBridgeErrorType[] = []

  /**
   * Needed to efficiently manage and cache token lists for different chain
   * combinations (fromChainId and toChainId) without having to fetch them
   * repeatedly from the API. Moreover, this way tokens added to a list by
   * address are also cached for sometime.
   */
  #cachedToTokenLists: CachedToTokenLists = {}

  #toTokenList: SwapAndBridgeToToken[] = []

  /**
   * Similar to the `#cachedToTokenLists`, this helps in avoiding repeated API
   * calls to fetch the supported chains from our service provider.
   */
  #cachedSupportedChains: CachedSupportedChains = { lastFetched: 0, data: [] }

  routePriority: 'output' | 'time' = 'output'

  // Holds the initial load promise, so that one can wait until it completes
  #initialLoadPromise: Promise<void>

  #shouldDebounceFlags: { [key: string]: boolean } = {}

  #accounts: AccountsController

  #keystore: KeystoreController

  #portfolio: PortfolioController

  #externalSignerControllers: ExternalSignerControllers

  #providers: ProvidersController

  /**
   * A possibly outdated instance of the SignAccountOpController. Please always
   * read the public getter `signAccountOpController` to get the up-to-date
   * instance. If updating a route consists of:
   * QUOTE FETCH -> ROUTE START -> ROUTE ESTIMATION
   *
   * This instance may be outdated during QUOTE FETCH -> ROUTE START
   * The reason is that the controller is not immediately destroyed after the
   * form changes, but instead is being updated after the route is started.
   */
  #signAccountOpController: SignAccountOpController | null = null

  /**
   * Holds all subscriptions (on update and on error) to the signAccountOpController.
   * This is needed to unsubscribe from the subscriptions when the controller is destroyed.
   */
  #signAccountOpSubscriptions: Function[] = []

  #portfolioUpdate: Function

  #isMainSignAccountOpThrowingAnEstimationError: Function | undefined

  #getUserRequests: () => UserRequest[]

  #getVisibleActionsQueue: () => Action[]

  hasProceeded: boolean = false

  /**
   * Describes whether quote refetch should happen at a given interval.
   * We forbid it:
   * - when the user has chosen a custom route by himself
   */
  isAutoSelectRouteDisabled: boolean = false

  #isReestimating: boolean = false

  #relayerUrl: string

  constructor({
    accounts,
    keystore,
    portfolio,
    externalSignerControllers,
    providers,
    selectedAccount,
    networks,
    activity,
    serviceProviderAPI,
    storage,
    invite,
    portfolioUpdate,
    relayerUrl,
    isMainSignAccountOpThrowingAnEstimationError,
    getUserRequests,
    getVisibleActionsQueue
  }: {
    accounts: AccountsController
    keystore: KeystoreController
    portfolio: PortfolioController
    externalSignerControllers: ExternalSignerControllers
    providers: ProvidersController
    selectedAccount: SelectedAccountController
    networks: NetworksController
    activity: ActivityController
    serviceProviderAPI: SocketAPI | LiFiAPI
    storage: StorageController
    invite: InviteController
    relayerUrl: string
    portfolioUpdate?: Function
    isMainSignAccountOpThrowingAnEstimationError?: Function
    getUserRequests: () => UserRequest[]
    getVisibleActionsQueue: () => Action[]
  }) {
    super()
    this.#accounts = accounts
    this.#keystore = keystore
    this.#portfolio = portfolio
    this.#externalSignerControllers = externalSignerControllers
    this.#providers = providers
    this.#portfolioUpdate = portfolioUpdate || (() => {})
    this.#isMainSignAccountOpThrowingAnEstimationError =
      isMainSignAccountOpThrowingAnEstimationError
    this.#selectedAccount = selectedAccount
    this.#networks = networks
    this.#activity = activity
    this.#serviceProviderAPI = serviceProviderAPI
    this.#storage = storage
    this.#invite = invite
    this.#relayerUrl = relayerUrl
    this.#getUserRequests = getUserRequests
    this.#getVisibleActionsQueue = getVisibleActionsQueue

    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this.#initialLoadPromise = this.#load()
  }

  #emitUpdateIfNeeded(forceUpdate: boolean = false) {
    const shouldSkipUpdate =
      // No need to emit emit updates if there are no active sessions
      !this.sessionIds.length &&
      // but ALSO there are no active routes (otherwise, banners need the updates)
      !this.activeRoutes.length &&
      // Force update is needed when the form is reset
      // as the sessions are cleared
      !forceUpdate

    if (shouldSkipUpdate) return

    super.emitUpdate()
  }

  #setFromAmountAndNotifyUI(amount: string) {
    this.fromAmount = amount
    this.fromAmountUpdateCounter += 1
  }

  #setFromAmountInFiatAndNotifyUI(amountInFiat: string) {
    this.fromAmountInFiat = amountInFiat
    this.fromAmountUpdateCounter += 1
  }

  #setFromAmountAmount(fromAmount: string, isProgrammaticUpdate = false) {
    const fromAmountFormatted = fromAmount.indexOf('.') === 0 ? `0${fromAmount}` : fromAmount
    this.fromAmount = fromAmount

    if (isProgrammaticUpdate) {
      // There is no problem in updating this first as there are no
      // emit updates in this method
      this.fromAmountUpdateCounter += 1
    }

    if (fromAmount === '') {
      this.fromAmountInFiat = ''
      return
    }
    const tokenPrice = this.fromSelectedToken?.priceIn.find(
      (p) => p.baseCurrency === HARD_CODED_CURRENCY
    )?.price

    if (!tokenPrice) {
      this.fromAmountInFiat = ''
      return
    }

    if (
      this.fromAmountFieldMode === 'fiat' &&
      typeof this.fromSelectedToken?.decimals === 'number'
    ) {
      this.fromAmountInFiat = fromAmount

      // Get the number of decimals
      const amountInFiatDecimals = 10
      const { tokenPriceBigInt, tokenPriceDecimals } = convertTokenPriceToBigInt(tokenPrice)

      // Convert the numbers to big int
      const amountInFiatBigInt = parseUnits(
        getSanitizedAmount(fromAmountFormatted, amountInFiatDecimals),
        amountInFiatDecimals
      )

      this.fromAmount = formatUnits(
        (amountInFiatBigInt * CONVERSION_PRECISION_POW) / tokenPriceBigInt,
        // Shift the decimal point by the number of decimals in the token price
        amountInFiatDecimals + CONVERSION_PRECISION - tokenPriceDecimals
      )

      return
    }
    if (this.fromAmountFieldMode === 'token') {
      this.fromAmount = fromAmount

      if (!this.fromSelectedToken) return

      // Convert the field value to big int
      const formattedAmount = parseUnits(
        getSafeAmountFromFieldValue(fromAmount, this.fromSelectedToken.decimals),
        this.fromSelectedToken.decimals
      )

      if (!formattedAmount) return

      const { tokenPriceBigInt, tokenPriceDecimals } = convertTokenPriceToBigInt(tokenPrice)

      this.fromAmountInFiat = formatUnits(
        formattedAmount * tokenPriceBigInt,
        // Shift the decimal point by the number of decimals in the token price
        this.fromSelectedToken.decimals + tokenPriceDecimals
      )
    }
  }

  async #load() {
    await this.#networks.initialLoadPromise
    await this.#selectedAccount.initialLoadPromise

    this.activeRoutes = await this.#storage.get('swapAndBridgeActiveRoutes', [])
    // Service provider may have changed since the last time the user interacted
    // with the Swap & Bridge. So strip out cached active routes that were NOT
    // made by the current service provider, because they are NOT compatible.
    //
    // also, just in case protection: filter out ready routes as we don't have
    // retry mechanism or follow up transaction handling anymore. Which means
    // ready routes in the storage are just leftover routes.
    // Same is true for completed, failed and refunded routes - they are just
    // leftover routes in storage
    const filterOutStatuses = ['ready', 'completed', 'failed', 'refunded']
    this.activeRoutes = this.activeRoutes.filter(
      (r) =>
        r.serviceProviderId === this.#serviceProviderAPI.id &&
        !filterOutStatuses.includes(r.routeStatus)
    )

    this.#selectedAccount.onUpdate(() => {
      this.#debounceFunctionCallsOnSameTick('updateFormOnSelectedAccountUpdate', async () => {
        if (this.#selectedAccount.portfolio.isReadyToVisualize) {
          this.isTokenListLoading = false
          await this.updatePortfolioTokenList(this.#selectedAccount.portfolio.tokens)
          // To token list includes selected account portfolio tokens, it should get an update too
          await this.updateToTokenList(false)
        }
      })
    })
    this.#emitUpdateIfNeeded()
  }

  // The token in portfolio is the source of truth for the amount, it updates
  // on every balance (pending or anything) change.
  #getFromSelectedTokenInPortfolio = () =>
    this.portfolioTokenList.find(
      (t) =>
        t.address === this.fromSelectedToken?.address &&
        t.chainId === this.fromSelectedToken?.chainId &&
        getIsTokenEligibleForSwapAndBridge(t)
    )

  get maxFromAmount(): string {
    const tokenRef = this.#getFromSelectedTokenInPortfolio() || this.fromSelectedToken
    if (!tokenRef || getTokenAmount(tokenRef) === 0n || typeof tokenRef.decimals !== 'number')
      return '0'

    return formatUnits(getTokenAmount(tokenRef), tokenRef.decimals)
  }

  get maxFromAmountInFiat(): string {
    const tokenRef = this.#getFromSelectedTokenInPortfolio() || this.fromSelectedToken
    if (!tokenRef || getTokenAmount(tokenRef) === 0n) return '0'

    const tokenPrice = tokenRef?.priceIn.find((p) => p.baseCurrency === HARD_CODED_CURRENCY)?.price
    if (!tokenPrice || !Number(this.maxFromAmount)) return '0'

    const maxAmount = getTokenAmount(tokenRef)
    const { tokenPriceBigInt, tokenPriceDecimals } = convertTokenPriceToBigInt(tokenPrice)

    // Multiply the max amount by the token price. The calculation is done in big int to avoid precision loss
    return formatUnits(
      BigInt(maxAmount) * tokenPriceBigInt,
      // Shift the decimal point by the number of decimals in the token price
      tokenRef.decimals + tokenPriceDecimals
    )
  }

  get isFormEmpty() {
    return (
      !this.fromChainId ||
      !this.toChainId ||
      !this.fromAmount ||
      !this.fromSelectedToken ||
      !this.toSelectedToken
    )
  }

  /**
   * Returns an instance of the SignAccountOpController that is ALWAYS up-to-date with the current
   * quote and the current form state.
   */
  get signAccountOpController() {
    const controllerFromQuoteId = this.#signAccountOpController?.accountOp.meta?.fromQuoteId

    const isSignAccountOpCtrlStale =
      controllerFromQuoteId && controllerFromQuoteId !== this.#updateQuoteId

    if (isSignAccountOpCtrlStale) return null

    return this.#signAccountOpController
  }

  get formStatus() {
    if (this.hasProceeded) return SwapAndBridgeFormStatus.Proceeded

    if (this.isFormEmpty) return SwapAndBridgeFormStatus.Empty
    if (this.validateFromAmount.message || this.swapSignErrors.length)
      return SwapAndBridgeFormStatus.Invalid
    if (this.updateQuoteStatus === 'LOADING') return SwapAndBridgeFormStatus.FetchingRoutes
    if (!this.quote?.routes.filter((route) => !route.hasFailed).length)
      return SwapAndBridgeFormStatus.NoRoutesFound

    if (this.quote?.selectedRoute?.errorMessage) return SwapAndBridgeFormStatus.InvalidRouteSelected

    if (
      !this.signAccountOpController ||
      this.signAccountOpController.estimation.status !== EstimationStatus.Success
    )
      return SwapAndBridgeFormStatus.ReadyToEstimate

    return SwapAndBridgeFormStatus.ReadyToSubmit
  }

  get validateFromAmount() {
    const fromSelectedTokenWithUpToDateAmount = this.#getFromSelectedTokenInPortfolio()

    if (!fromSelectedTokenWithUpToDateAmount) return { success: false, message: '' }

    if (
      !this.isFormEmpty &&
      !this.quote &&
      Object.values(this.quoteRoutesStatuses).some((val) => val.status === 'MIN_AMOUNT_NOT_MET')
    ) {
      return {
        success: true,
        message: '🔔 A route was found for this pair but the minimum token amount was not met.'
      }
    }

    return validateSendTransferAmount(this.fromAmount, fromSelectedTokenWithUpToDateAmount)
  }

  get activeRoutesInProgress() {
    return this.activeRoutes.filter((r) => r.routeStatus === 'in-progress' && r.userTxHash)
  }

  get activeRoutes() {
    return this.#activeRoutes
  }

  set activeRoutes(value: SwapAndBridgeActiveRoute[]) {
    this.#activeRoutes = value
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this.#storage.set('swapAndBridgeActiveRoutes', value)
  }

  get shouldEnableRoutesSelection() {
    return (
      !!this.quote &&
      !!this.quote.routes &&
      this.quote.routes.length > 0 &&
      this.updateQuoteStatus !== 'LOADING'
    )
  }

  async initForm(
    sessionId: string,
    params?: {
      preselectedFromToken?: Pick<TokenResult, 'address' | 'chainId'>
      preselectedToToken?: Pick<TokenResult, 'address' | 'chainId'>
      fromAmount?: string
      activeRouteIdToDelete?: SwapAndBridgeSendTxRequest['activeRouteId']
    }
  ) {
    const { preselectedFromToken, preselectedToToken, fromAmount, activeRouteIdToDelete } =
      params || {}
    await this.#initialLoadPromise

    if (this.sessionIds.includes(sessionId)) return

    // reset only if there are no other instances opened/active
    if (!this.sessionIds.length) {
      this.reset() // clear prev session form state
      // for each new session remove the completed activeRoutes from the previous session
      this.activeRoutes = this.activeRoutes.filter((r) => r.routeStatus !== 'completed')
      // remove activeRoutes errors from the previous session
      this.activeRoutes.forEach((r) => {
        if (r.routeStatus !== 'failed') {
          // eslint-disable-next-line no-param-reassign
          delete r.error
        }
      })
      if (this.activeRoutes.length) {
        // Otherwise there may be an emitUpdate with [] tokens
        this.isTokenListLoading = true

        // update the activeRoute.route prop for the new session
        this.activeRoutes.forEach((r) => {
          // eslint-disable-next-line @typescript-eslint/no-floating-promises
          this.updateActiveRoute(r.activeRouteId, undefined, true)
        })
      }
    }

    this.sessionIds.push(sessionId)
    // do not await the health status check to prevent UI freeze while fetching
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this.#serviceProviderAPI.updateHealth()
    await this.updatePortfolioTokenList(this.#selectedAccount.portfolio.tokens, {
      preselectedToken: preselectedFromToken,
      preselectedToToken,
      fromAmount
    })
    this.isTokenListLoading = false
    // Do not await on purpose as it's not critical for the controller state to be ready
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this.#fetchSupportedChainsIfNeeded()

    if (activeRouteIdToDelete) {
      this.removeActiveRoute(activeRouteIdToDelete, false)
    }

    this.#emitUpdateIfNeeded()
  }

  get isHealthy() {
    return this.#serviceProviderAPI.isHealthy
  }

  #fetchSupportedChainsIfNeeded = async () => {
    const shouldNotReFetchSupportedChains =
      this.#cachedSupportedChains.data.length &&
      Date.now() - this.#cachedSupportedChains.lastFetched < SUPPORTED_CHAINS_CACHE_THRESHOLD
    if (shouldNotReFetchSupportedChains) return

    try {
      const supportedChains = await this.#serviceProviderAPI.getSupportedChains()

      this.#cachedSupportedChains = { lastFetched: Date.now(), data: supportedChains }
      this.#emitUpdateIfNeeded()
    } catch (error: any) {
      // Fail silently, as this is not a critical feature, Swap & Bridge is still usable
      this.emitError({ error, level: 'silent', message: error?.message })
    }
  }

  get supportedChainIds(): Network['chainId'][] {
    // if the account is smart, do not allow the user to bridge to
    // a chain that doesn't support our smart accounts as those funds
    // would be stuck
    if (isSmartAccount(this.#selectedAccount.account)) {
      return this.#cachedSupportedChains.data
        .filter((c) => {
          const network = this.#networks.networks.find((net) => net.chainId === BigInt(c.chainId))
          if (!network) return false
          return network.areContractsDeployed && (network.hasRelayer || network.erc4337.enabled)
        })
        .map((c) => BigInt(c.chainId))
    }

    return this.#cachedSupportedChains.data.map((c) => BigInt(c.chainId))
  }

  get #toTokenListKey(): CachedTokenListKey | null {
    if (this.fromChainId === null || this.toChainId === null) return null

    return `from-${this.fromChainId}-to-${this.toChainId}`
  }

  unloadScreen(sessionId: string, forceUnload?: boolean) {
    const isFormDirty = !!this.fromAmount || !!this.toSelectedToken
    const shouldPersistState = isFormDirty && sessionId === 'popup' && !forceUnload

    if (shouldPersistState) return

    this.sessionIds = this.sessionIds.filter((id) => id !== sessionId)
    if (!this.sessionIds.length) {
      this.reset(true)
      // Reset health to prevent the error state from briefly flashing
      // before the next health check resolves when the Swap & Bridge
      // screen is opened after a some time
      this.#serviceProviderAPI.resetHealth()
    }
    this.hasProceeded = false
  }

  addOrUpdateError(error: SwapAndBridgeErrorType) {
    const errorIndex = this.errors.findIndex((e) => e.id === error.id)
    if (errorIndex === -1) {
      this.errors.push(error)
    } else {
      this.errors[errorIndex] = error
    }
    this.#emitUpdateIfNeeded()
  }

  removeError(id: SwapAndBridgeErrorType['id'], shouldEmit?: boolean) {
    this.errors = this.errors.filter((e) => e.id !== id)
    if (shouldEmit) this.#emitUpdateIfNeeded()
  }

  async updateForm(
    props: {
      fromAmount?: string
      fromAmountInFiat?: string
      shouldSetMaxAmount?: boolean
      fromAmountFieldMode?: 'fiat' | 'token'
      fromSelectedToken?: TokenResult | null
      toChainId?: bigint | number
      toSelectedTokenAddr?: SwapAndBridgeToToken['address'] | null
      routePriority?: 'output' | 'time'
    },
    updateProps?: {
      emitUpdate?: boolean
      updateQuote?: boolean
      shouldIncrementFromAmountUpdateCounter?: boolean
    }
  ) {
    const {
      fromAmount,
      fromAmountInFiat,
      fromAmountFieldMode,
      fromSelectedToken,
      toChainId,
      shouldSetMaxAmount,
      routePriority
    } = props

    const {
      emitUpdate = true,
      updateQuote = true,
      shouldIncrementFromAmountUpdateCounter = false
    } = updateProps || {}

    // map the token back
    const chainId = toChainId ?? this.toChainId
    const toSelectedTokenAddr =
      chainId && props.toSelectedTokenAddr
        ? mapNativeToAddr(this.#serviceProviderAPI.id, Number(chainId), props.toSelectedTokenAddr)
        : undefined
    // when we init the form by using the retry button
    const shouldNotResetFromAmount =
      fromAmount && props.toSelectedTokenAddr && fromSelectedToken && toChainId

    let shouldUpdateToTokenList = false

    // fromAmountFieldMode must be set before fromAmount so it
    // works correctly when both are set at the same time
    if (fromAmountFieldMode) {
      this.fromAmountFieldMode = fromAmountFieldMode
    }

    if (fromAmountFieldMode) {
      this.fromAmountFieldMode = fromAmountFieldMode
    }

    if (shouldSetMaxAmount) {
      this.fromAmountFieldMode = 'token'
      this.#setFromAmountAmount(this.maxFromAmount, true)
    }

    if (fromAmount !== undefined) {
      this.#setFromAmountAmount(fromAmount)
    }

    if (fromAmountInFiat !== undefined) {
      this.fromAmountInFiat = fromAmountInFiat
    }

    if (shouldIncrementFromAmountUpdateCounter) {
      this.fromAmountUpdateCounter += 1
    }

    if (typeof fromSelectedToken !== 'undefined') {
      const isFromNetworkChanged = this.fromSelectedToken?.chainId !== fromSelectedToken?.chainId

      if (fromSelectedToken && isFromNetworkChanged) {
        const network = this.#networks.networks.find((n) => n.chainId === fromSelectedToken.chainId)
        if (network) {
          this.fromChainId = Number(network.chainId)
          // Don't update the selected token programmatically if the user
          // has selected it manually
          if (!this.toSelectedToken) {
            // defaults to swap after network change (should keep fromChainId and toChainId in sync after fromChainId update)
            this.toChainId = Number(network.chainId)
            shouldUpdateToTokenList = true
          }
        }
      }

      const shouldResetFromTokenAmount =
        !shouldNotResetFromAmount &&
        (isFromNetworkChanged ||
          !fromSelectedToken ||
          this.fromSelectedToken?.address !== fromSelectedToken.address)
      if (shouldResetFromTokenAmount) {
        this.#setFromAmountAndNotifyUI('')
        this.#setFromAmountInFiatAndNotifyUI('')
        this.fromAmountFieldMode = 'token'
      }

      // Always update to reflect portfolio amount (or other props) changes
      this.fromSelectedToken = fromSelectedToken
    }

    if (toChainId) {
      if (this.toChainId !== Number(toChainId)) {
        this.toChainId = Number(toChainId)
        shouldUpdateToTokenList = true
      }
    }

    const nextToToken = toSelectedTokenAddr
      ? this.#toTokenList.find((t) => t.address === toSelectedTokenAddr)
      : null

    if (nextToToken) this.toSelectedToken = { ...nextToToken }

    if (routePriority) {
      this.routePriority = routePriority
      if (this.quote) {
        this.quote = null
        this.quoteRoutesStatuses = {}
      }
    }

    if (emitUpdate) this.#emitUpdateIfNeeded()

    await Promise.all([
      shouldUpdateToTokenList
        ? // we put toSelectedTokenAddr so that "retry" btn functionality works
          this.updateToTokenList(true, nextToToken?.address || toSelectedTokenAddr)
        : undefined,
      updateQuote ? this.updateQuote({ debounce: true }) : undefined
    ])
  }

  resetForm(shouldEmit?: boolean) {
    // Preserve key form states instead of resetting the whole form to enhance UX and reduce confusion.
    // After form submission, maintain the state for fromSelectedToken, fromChainId, and toChainId,
    // while resetting all other state related to the form.
    this.#setFromAmountAndNotifyUI('')
    this.#setFromAmountInFiatAndNotifyUI('')
    this.fromAmountFieldMode = 'token'
    this.toSelectedToken = null
    this.quote = null
    this.updateQuoteStatus = 'INITIAL'
    this.quoteRoutesStatuses = {}
    this.destroySignAccountOp()
    this.hasProceeded = false
    this.isAutoSelectRouteDisabled = false
    this.#updateQuoteId = undefined
    this.fromAmountUpdateCounter = 0

    if (shouldEmit) this.#emitUpdateIfNeeded(true)
  }

  reset(shouldEmit?: boolean) {
    this.resetForm()
    this.fromChainId = 1
    this.fromSelectedToken = null
    this.toChainId = 1
    this.portfolioTokenList = []
    this.#toTokenList = []
    this.errors = []

    if (shouldEmit) this.#emitUpdateIfNeeded(true)
  }

  async updatePortfolioTokenList(
    nextPortfolioTokenList: TokenResult[],
    params?: {
      preselectedToken?: Pick<TokenResult, 'address' | 'chainId'>
      preselectedToToken?: Pick<TokenResult, 'address' | 'chainId'>
      fromAmount?: string
    }
  ) {
    // If the user has switched TOKEN -> NULL that would make the fromSelectedToken
    // null, so we need to keep it null, even if the portfolio token list is updated
    // until the user manually selects a new token
    const isSelectedTokenFalsyBeforeListUpdate = !this.fromSelectedToken && !!this.toSelectedToken
    const { preselectedToken, preselectedToToken, fromAmount } = params || {}
    const tokens = nextPortfolioTokenList.filter(getIsTokenEligibleForSwapAndBridge)
    this.portfolioTokenList = sortPortfolioTokenList(
      // Filtering out hidden tokens here means: 1) They won't be displayed in
      // the "From" token list (`this.portfolioTokenList`) and 2) They won't be
      // added to the "Receive" token list as additional tokens from portfolio,
      // BUT 3) They will appear in the "Receive" if they are present in service
      // provider's to token list. This is the desired behavior.
      tokens.filter((t) => !t.flags.isHidden)
    )

    const fromSelectedTokenInNextPortfolio = this.portfolioTokenList.find((t) => {
      if (preselectedToken) {
        return t.address === preselectedToken.address && t.chainId === preselectedToken.chainId
      }

      return (
        t.address === this.fromSelectedToken?.address &&
        t.chainId === this.fromSelectedToken?.chainId
      )
    })

    const shouldUpdateFromSelectedToken =
      !this.fromSelectedToken || // initial (default) state
      // May happen if selected account gets changed or the token gets send away in the meantime
      !fromSelectedTokenInNextPortfolio ||
      // May happen if user receives or sends the token in the meantime
      fromSelectedTokenInNextPortfolio.amount !== this.fromSelectedToken?.amount ||
      preselectedToken

    // If the token is not in the portfolio because it was a "to" token
    // and the user has switched the "from" and "to" tokens we should not
    // update the selected token
    if (
      !this.fromSelectedToken?.isSwitchedToToken &&
      !isSelectedTokenFalsyBeforeListUpdate &&
      shouldUpdateFromSelectedToken
    ) {
      const nextFromSelectedToken =
        fromSelectedTokenInNextPortfolio ||
        // Select the first token in the portfolio that is not the same as the "to" token
        this.portfolioTokenList.find((t) => t.address !== this.toSelectedToken?.address) ||
        null

      await this.updateForm(
        {
          fromSelectedToken: nextFromSelectedToken,
          toSelectedTokenAddr: preselectedToToken?.address,
          toChainId: preselectedToToken?.chainId,
          fromAmount
        },
        {
          emitUpdate: false,
          shouldIncrementFromAmountUpdateCounter: true
        }
      )
      return
    }
    this.#addFromTokenToPortfolioListIfNeeded()

    this.#emitUpdateIfNeeded()
  }

  async updateToTokenList(shouldReset: boolean, addressToSelect?: string) {
    const now = Date.now()
    const timeSinceLastCall = now - this.#updateToTokenListThrottle.time
    if (timeSinceLastCall <= 500) {
      this.#updateToTokenListThrottle.shouldReset = shouldReset
      this.#updateToTokenListThrottle.addressToSelect = addressToSelect

      if (!this.#updateToTokenListThrottle.throttled) {
        this.#updateToTokenListThrottle.throttled = true
        await wait(500 - timeSinceLastCall)
        this.#updateToTokenListThrottle.throttled = false
        await this.updateToTokenList(
          this.#updateToTokenListThrottle.shouldReset,
          this.#updateToTokenListThrottle.addressToSelect
        )
      }
      return
    }

    const toTokenListKeyAtStart = this.#toTokenListKey

    this.updateToTokenListStatus = 'LOADING'
    this.#updateToTokenListThrottle.time = now
    this.removeError('to-token-list-fetch-failed', false)
    if (!this.fromChainId || !this.toChainId) {
      this.updateToTokenListStatus = 'INITIAL'
      return
    }

    // Emit an update to set the loading state in the UI
    this.#emitUpdateIfNeeded()

    if (shouldReset) {
      this.#toTokenList = []
      this.toSelectedToken = null
    }

    const toTokenListInCache =
      this.#toTokenListKey && this.#cachedToTokenLists[this.#toTokenListKey]
    let toTokenList: SwapAndBridgeToToken[] = toTokenListInCache?.data || []
    const shouldFetchTokenList =
      !toTokenList.length ||
      now - (toTokenListInCache?.lastFetched || 0) >= TO_TOKEN_LIST_CACHE_THRESHOLD
    if (shouldFetchTokenList) {
      try {
        toTokenList = await this.#serviceProviderAPI.getToTokenList({
          fromChainId: this.fromChainId,
          toChainId: this.toChainId
        })
        // Cache the latest token list
        if (this.#toTokenListKey) {
          this.#cachedToTokenLists[this.#toTokenListKey] = {
            lastFetched: now,
            data: toTokenList
          }
        }
      } catch (error: any) {
        // Display an error only if there is no cached data
        if (!toTokenList.length) {
          toTokenList = addCustomTokensIfNeeded({ chainId: this.toChainId, tokens: toTokenList })
          const { message } = getHumanReadableSwapAndBridgeError(error)

          this.addOrUpdateError({
            id: 'to-token-list-fetch-failed',
            title: 'Token list on the receiving network is temporarily unavailable.',
            text: message,
            level: 'error'
          })
        }
      }
    }

    // The key has changed, meaning the user has modified the form,
    // so we should not update the to token list as another update is in progress
    if (toTokenListKeyAtStart !== this.#toTokenListKey) return

    const toTokenNetwork = this.#networks.networks.find((n) => Number(n.chainId) === this.toChainId)
    // should never happen
    if (!toTokenNetwork) {
      this.updateToTokenListStatus = 'INITIAL'
      this.#emitUpdateIfNeeded()
      throw new SwapAndBridgeError(NETWORK_MISMATCH_MESSAGE)
    }

    const additionalTokensFromPortfolio = this.portfolioTokenList
      .filter((t) => t.chainId === toTokenNetwork.chainId)
      .filter((token) => !toTokenList.some((t) => t.address === token.address))
      .map((t) => convertPortfolioTokenToSwapAndBridgeToToken(t, Number(toTokenNetwork.chainId)))

    // The key has changed, meaning the user has modified the form,
    // so we should not update the to token list as another update is in progress
    if (toTokenListKeyAtStart !== this.#toTokenListKey) return

    this.#toTokenList = sortTokenListResponse(
      [...toTokenList, ...additionalTokensFromPortfolio],
      this.portfolioTokenList.filter((t) => t.chainId === toTokenNetwork.chainId)
    )

    // if the provider is lifi, filter out tokens that are not supported by it
    if (this.#serviceProviderAPI.id === 'lifi') {
      this.#toTokenList = this.#toTokenList.filter(lifiTokenListFilter)
    }

    if (!this.toSelectedToken) {
      if (addressToSelect) {
        const token = this.#toTokenList.find((t) => t.address === addressToSelect)
        if (token) {
          await this.updateForm({ toSelectedTokenAddr: token.address }, { emitUpdate: false })
          this.updateToTokenListStatus = 'INITIAL'
          this.#emitUpdateIfNeeded()
          return
        }
      }
    }

    this.updateToTokenListStatus = 'INITIAL'
    this.#emitUpdateIfNeeded()
  }

  /**
   * Returns the short list of tokens for the "to" token list, because the full
   * list (stored in #toTokenList) could be HUGE, causing the controller to be
   * HUGE as well, that leads to performance problems.
   */
  get toTokenShortList(): SwapAndBridgeToToken[] {
    const isSwapping = this.fromChainId === this.toChainId
    if (isSwapping) {
      return (
        this.#toTokenList
          // Swaps between same "from" and "to" tokens are not feasible, filter them out
          .filter((t) => t.address !== this.fromSelectedToken?.address)
          .slice(0, TO_TOKEN_LIST_LIMIT)
      )
    }

    return this.#toTokenList.slice(0, TO_TOKEN_LIST_LIMIT)
  }

  async #addToTokenByAddress(address: string) {
    if (!this.toChainId) return // should never happen
    if (!isAddress(address)) return // no need to attempt with invalid addresses

    const isAlreadyInTheList = this.#toTokenList.some((t) => t.address === address)
    if (isAlreadyInTheList) return

    let token: SwapAndBridgeToToken | null
    try {
      token = await this.#serviceProviderAPI.getToken({ address, chainId: this.toChainId })

      if (!token)
        throw new SwapAndBridgeError(
          'Token with this address is not supported by our service provider.'
        )
    } catch (error: any) {
      const { message } = getHumanReadableSwapAndBridgeError(error)
      throw new EmittableError({ error, level: 'minor', message })
    }

    if (this.#toTokenListKey)
      // Cache for sometime the tokens added by address
      this.#cachedToTokenLists[this.#toTokenListKey]?.data.push(token)

    const toTokenNetwork = this.#networks.networks.find((n) => Number(n.chainId) === this.toChainId)
    // should never happen
    if (!toTokenNetwork) {
      const error = new SwapAndBridgeError(NETWORK_MISMATCH_MESSAGE)
      throw new EmittableError({ error, level: 'minor', message: error?.message })
    }

    const nextTokenList: SwapAndBridgeToToken[] = [...this.#toTokenList, token]

    this.#toTokenList = sortTokenListResponse(
      nextTokenList,
      this.portfolioTokenList.filter((t) => t.chainId === toTokenNetwork.chainId)
    )

    // Re-trigger search, because of the updated #toTokenList
    await this.searchToToken(token.address)

    this.#emitUpdateIfNeeded()
    return token
  }

  /**
   * Add the selected token to the portfolio token list if needed. This is
   * necessary because the user may switch the "from" and "to" tokens, and the
   * to token may be a token that is not in the portfolio token list.
   */
  #addFromTokenToPortfolioListIfNeeded() {
    if (!this.fromSelectedToken) return

    const isAlreadyInTheList = this.portfolioTokenList.some(
      (t) =>
        t.address === this.fromSelectedToken!.address &&
        t.chainId === this.fromSelectedToken!.chainId
    )

    if (isAlreadyInTheList || !this.fromSelectedToken.isSwitchedToToken) return

    this.portfolioTokenList = [...this.portfolioTokenList, this.fromSelectedToken]
  }

  addToTokenByAddress = async (address: string) =>
    this.withStatus('addToTokenByAddress', () => this.#addToTokenByAddress(address), true)

  async searchToToken(searchTerm: string) {
    // Reset the search results
    this.toTokenSearchTerm = ''
    this.toTokenSearchResults = []
    this.#emitUpdateIfNeeded()

    if (!searchTerm) return // should never happen

    const normalizedSearchTerm = searchTerm.trim().toLowerCase()
    this.toTokenSearchTerm = normalizedSearchTerm

    const { exactMatches, partialMatches } = this.#toTokenList.reduce(
      (result, token) => {
        const fieldsToSearch = [
          token.address.toLowerCase(),
          token.symbol.toLowerCase(),
          token.name.toLowerCase()
        ]

        // Prioritize exact matches, partial matches come after
        const isExactMatch = fieldsToSearch.some((field) => field === normalizedSearchTerm)
        const isPartialMatch = fieldsToSearch.some((field) => field.includes(normalizedSearchTerm))

        if (isExactMatch) {
          result.exactMatches.push(token)
        } else if (isPartialMatch) {
          result.partialMatches.push(token)
        }

        return result
      },
      { exactMatches: [] as SwapAndBridgeToToken[], partialMatches: [] as SwapAndBridgeToToken[] }
    )

    this.toTokenSearchResults = [...exactMatches, ...partialMatches].slice(0, TO_TOKEN_LIST_LIMIT)
    this.#emitUpdateIfNeeded()
  }

  async switchFromAndToTokens() {
    this.switchTokensStatus = 'LOADING'
    this.#emitUpdateIfNeeded()

    const prevFromSelectedToken = this.fromSelectedToken ? { ...this.fromSelectedToken } : null
    // Update the from token
    if (!this.toSelectedToken) {
      await this.updateForm(
        {
          fromAmount: '',
          fromAmountFieldMode: 'token',
          toSelectedTokenAddr: this.fromSelectedToken?.address || null
        },
        {
          emitUpdate: false,
          updateQuote: false,
          shouldIncrementFromAmountUpdateCounter: true
        }
      )
      this.fromSelectedToken = null
    } else if (this.toChainId) {
      const toSelectedTokenNetwork = this.#networks.networks.find(
        (n) => Number(n.chainId) === this.toChainId
      )!
      const tokenInPortfolio = this.portfolioTokenList.find(
        (token: TokenResult) =>
          token.address === this.toSelectedToken?.address &&
          token.chainId === toSelectedTokenNetwork.chainId
      )

      const price = Number(this.quote?.selectedRoute?.toToken?.priceUSD || 0)

      this.fromSelectedToken = tokenInPortfolio || {
        ...this.toSelectedToken,
        chainId: BigInt(this.toChainId),
        amount: 0n,
        flags: {
          onGasTank: false,
          isFeeToken: false,
          canTopUpGasTank: false,
          rewardsType: null
        },
        priceIn: price ? [{ baseCurrency: 'usd', price }] : []
      }

      this.fromSelectedToken.isSwitchedToToken = true
      this.#addFromTokenToPortfolioListIfNeeded()

      // Update the amount to the one from the quote
      let fromAmount = ''
      // Try catch just in case because of formatUnits
      try {
        if (this.quote && this.quote.selectedRoute?.fromAmount) {
          fromAmount = formatUnits(
            this.quote.selectedRoute.toAmount,
            this.quote.selectedRoute.toToken.decimals
          )
        }
      } catch (error) {
        console.error('Error formatting fromAmount', error)
      }
      await this.updateForm(
        {
          fromAmount,
          fromAmountFieldMode: 'token'
        },
        {
          emitUpdate: false,
          updateQuote: false,
          shouldIncrementFromAmountUpdateCounter: true
        }
      )
    }

    // Update the chain ids
    ;[this.fromChainId, this.toChainId] = [this.toChainId, this.fromChainId]

    // Update the to token list
    await this.updateToTokenList(true, prevFromSelectedToken?.address)

    this.switchTokensStatus = 'INITIAL'
    this.#emitUpdateIfNeeded()
  }

  async updateQuote(options?: {
    skipQuoteUpdateOnSameValues?: boolean
    skipPreviousQuoteRemoval?: boolean
    skipStatusUpdate?: boolean
    debounce?: boolean
  }) {
    const {
      skipQuoteUpdateOnSameValues = true,
      skipPreviousQuoteRemoval = false,
      skipStatusUpdate = false,
      debounce = false
    } = options || {}
    // no updates if the user has commited
    if (this.formStatus === SwapAndBridgeFormStatus.Proceeded || this.isAutoSelectRouteDisabled)
      return

    // no quote fetch if there are errors
    if (this.swapSignErrors.length) return

    const quoteId = generateUuid()
    this.#updateQuoteId = quoteId

    const updateQuoteFunction = async (): Promise<boolean | undefined> => {
      if (!this.#selectedAccount.account) return
      if (!this.#getIsFormValidToFetchQuote()) return
      if (!this.fromAmount || !this.fromSelectedToken || !this.toSelectedToken) return

      const bigintFromAmount = parseUnits(
        getSafeAmountFromFieldValue(this.fromAmount, this.fromSelectedToken.decimals),
        this.fromSelectedToken.decimals
      )

      if (this.quote) {
        const isFromAmountSame =
          this.quote.selectedRoute?.fromAmount === bigintFromAmount.toString()
        const isFromNetworkSame = this.quote.fromChainId === this.fromChainId
        const isFromAddressSame = this.quote.fromAsset.address === this.fromSelectedToken.address
        const isToNetworkSame = this.quote.toChainId === this.toChainId
        const isToAddressSame = this.quote.toAsset.address === this.toSelectedToken.address

        if (
          skipQuoteUpdateOnSameValues &&
          isFromAmountSame &&
          isFromNetworkSame &&
          isFromAddressSame &&
          isToNetworkSame &&
          isToAddressSame
        ) {
          return
        }
      }
      if (!skipPreviousQuoteRemoval) {
        if (this.quote) {
          this.quote = null
          this.updateQuoteStatus = 'LOADING'
        }
        this.quoteRoutesStatuses = {}
        this.#emitUpdateIfNeeded()
      }

      try {
        const quoteResult = await this.#serviceProviderAPI.quote({
          fromAsset: this.fromSelectedToken,
          fromChainId: this.fromChainId!,
          fromTokenAddress: this.fromSelectedToken.address,
          toAsset: this.toSelectedToken,
          toChainId: this.toChainId!,
          toTokenAddress: this.toSelectedToken.address,
          fromAmount: bigintFromAmount,
          userAddress: this.#selectedAccount.account.addr,
          isSmartAccount: !isBasicAccount(
            this.#selectedAccount.account,
            await this.#accounts.getOrFetchAccountOnChainState(
              this.#selectedAccount.account.addr,
              BigInt(this.toChainId!)
            )
          ),
          sort: this.routePriority,
          isOG: this.#invite.isOG
        })

        if (this.#isQuoteIdObsoleteAfterAsyncOperation(quoteId)) return
        // no updates if the user has commited
        if (this.formStatus === SwapAndBridgeFormStatus.Proceeded || this.isAutoSelectRouteDisabled)
          return

        if (
          this.#getIsFormValidToFetchQuote() &&
          quoteResult &&
          quoteResult?.routes?.[0] &&
          quoteResult.fromChainId === this.fromChainId &&
          quoteResult.toChainId === this.toChainId &&
          quoteResult.toAsset.address === this.toSelectedToken?.address
        ) {
          let routeToSelect
          let routeToSelectSteps
          let routes = quoteResult.routes || []

          try {
            if (this.#serviceProviderAPI.id === 'socket') {
              routes = routes.map((route) => {
                if (!route.userTxs) return route

                const bridgeTx = route.userTxs.find((tx) => getIsBridgeTxn(tx.userTxType)) as
                  | SwapAndBridgeUserTx
                  | undefined

                if (!bridgeTx) return route

                const bridgeStep = (bridgeTx as unknown as SocketAPIBridgeUserTx).steps.find(
                  (s) => s.type === 'bridge'
                ) as SocketApiBridgeStep | undefined

                if (!bridgeStep) return route
                if (bridgeStep.protocolFees.amount === '0') return route

                const normalizedProtocolFeeToken = normalizeIncomingSocketToken(
                  bridgeStep.protocolFees.asset
                )

                const doesProtocolRequireExtraContractFeeInNative =
                  PROTOCOLS_WITH_CONTRACT_FEE_IN_NATIVE.includes(bridgeStep.protocol.name) &&
                  // When other tokens than the native ones are being bridged,
                  // Socket API takes the fee directly from the "From" amount.
                  normalizedProtocolFeeToken.address === ZERO_ADDRESS

                if (!doesProtocolRequireExtraContractFeeInNative) return route

                const protocolFeeTokenNetwork = this.#networks.networks.find(
                  (n) => Number(n.chainId) === normalizedProtocolFeeToken.chainId
                )!

                const isTokenToPayFeeWithTheSameAsFromToken =
                  this.fromSelectedToken?.address === normalizedProtocolFeeToken.address &&
                  this.fromChainId === normalizedProtocolFeeToken.chainId

                const tokenToPayFeeWith = this.portfolioTokenList.find((t) => {
                  return (
                    t.address === normalizedProtocolFeeToken.address &&
                    t.chainId === protocolFeeTokenNetwork.chainId
                  )
                })

                const protocolFeeTokenDecimals = bridgeStep.protocolFees.asset.decimals
                const portfolioTokenToPayFeeWithDecimals = tokenToPayFeeWith
                  ? tokenToPayFeeWith.decimals
                  : protocolFeeTokenDecimals
                const fromAmountNumber = Number(this.fromAmount)
                const fromAmountScaledToTokenToPayFeeWithDecimals = BigInt(
                  Math.round(fromAmountNumber * 10 ** portfolioTokenToPayFeeWithDecimals)
                )

                const tokenToPayFeeWithScaledToPortfolioTokenToPayFeeWithDecimals =
                  tokenToPayFeeWith
                    ? // Scale tokenToPayFeeWith to the same decimals as portfolioTokenToPayFeeWithDecimals
                      tokenToPayFeeWith.amount *
                      BigInt(10 ** (protocolFeeTokenDecimals - portfolioTokenToPayFeeWithDecimals))
                    : BigInt(0)

                const availableAfterSubtractionScaledToPortfolioTokenToPayFeeWithDecimals =
                  isTokenToPayFeeWithTheSameAsFromToken
                    ? tokenToPayFeeWithScaledToPortfolioTokenToPayFeeWithDecimals -
                      fromAmountScaledToTokenToPayFeeWithDecimals
                    : tokenToPayFeeWithScaledToPortfolioTokenToPayFeeWithDecimals

                const protocolFeesAmountScaledToPortfolioTokenToPayFeeWithDecimals = BigInt(
                  Math.round(
                    Number(bridgeStep.protocolFees.amount) *
                      10 ** (portfolioTokenToPayFeeWithDecimals - protocolFeeTokenDecimals)
                  )
                )
                const hasEnoughAmountToPayFee =
                  availableAfterSubtractionScaledToPortfolioTokenToPayFeeWithDecimals >=
                  protocolFeesAmountScaledToPortfolioTokenToPayFeeWithDecimals

                if (!hasEnoughAmountToPayFee) {
                  const protocolName = bridgeStep.protocol.displayName
                  const insufficientTokenSymbol = bridgeStep.protocolFees.asset.symbol
                  const insufficientTokenNetwork = protocolFeeTokenNetwork.name
                  const insufficientAssetAmount = formatUnits(
                    bridgeStep.protocolFees.amount,
                    bridgeStep.protocolFees.asset.decimals
                  )
                  const insufficientAssetAmountInUsd = formatDecimals(
                    bridgeStep.protocolFees.feesInUsd,
                    'value'
                  )

                  // Trick to show the error message on the UI, as the API doesn't handle this
                  // eslint-disable-next-line no-param-reassign
                  route.errorMessage = `Insufficient ${insufficientTokenSymbol} on ${insufficientTokenNetwork}. You need ${insufficientAssetAmount} ${insufficientTokenSymbol} (${insufficientAssetAmountInUsd}) on ${insufficientTokenNetwork} to cover the ${protocolName} protocol fee for this route.`
                }

                return route
              })
            }

            routes = routes.sort((a, b) => Number(!!a.errorMessage) - Number(!!b.errorMessage))
          } catch (error) {
            // if the filtration fails for some reason continue with the original routes
            // array without interrupting the rest of the logic
            // eslint-disable-next-line no-console
            console.error(error)
          }

          if (!routes.length) {
            this.quote = null
            return
          }

          const alreadySelectedRoute = routes.find((nextRoute) => {
            if (!this.quote) return false

            // Because we only have routes with unique bridges (bridging case)
            const selectedRouteUsedBridge = this.quote.selectedRoute?.usedBridgeNames?.[0]
            if (selectedRouteUsedBridge)
              return nextRoute.usedBridgeNames?.[0] === selectedRouteUsedBridge

            // Assuming to only have routes with unique DEXes (swapping case)
            const selectedRouteUsedDex = this.quote.selectedRoute?.usedDexName
            if (selectedRouteUsedDex) return nextRoute.usedDexName === selectedRouteUsedDex

            return false // should never happen, but just in case of bad data
          })

          if (alreadySelectedRoute) {
            routeToSelect = alreadySelectedRoute
            routeToSelectSteps = alreadySelectedRoute.steps
          } else {
            let bestRoute = routes[0]
            if (this.#serviceProviderAPI.id === 'socket') {
              bestRoute =
                this.routePriority === 'output'
                  ? routes[0] // API returns highest output first
                  : routes[routes.length - 1] // API returns fastest... last
            }
            routeToSelect = bestRoute
            routeToSelectSteps = bestRoute.steps
          }

          this.quote = {
            fromAsset: quoteResult.fromAsset,
            fromChainId: quoteResult.fromChainId,
            toAsset: quoteResult.toAsset,
            toChainId: quoteResult.toChainId,
            selectedRoute: routeToSelect,
            selectedRouteSteps: routeToSelectSteps,
            routes
          }
        }
        this.quoteRoutesStatuses = (quoteResult as any).bridgeRouteErrors || {}

        return true
      } catch (error: any) {
        if (this.#isQuoteIdObsoleteAfterAsyncOperation(quoteId)) return

        const { message } = getHumanReadableSwapAndBridgeError(error)
        this.emitError({ error, level: 'major', message })

        return false
      }
    }

    if (!this.#getIsFormValidToFetchQuote()) {
      if (this.quote || this.quoteRoutesStatuses) {
        this.quote = null
        this.quoteRoutesStatuses = {}
        this.updateQuoteStatus = 'INITIAL'
        this.removeError('no-routes')
        this.#emitUpdateIfNeeded()
      }
      return
    }

    if (!skipStatusUpdate) {
      this.updateQuoteStatus = 'LOADING'
      this.removeError('no-routes')
      this.#emitUpdateIfNeeded()
    }

    // Debounce the updateQuote function to avoid multiple calls
    if (debounce) await wait(500)
    if (this.#updateQuoteId !== quoteId) return

    const isSuccessful = await updateQuoteFunction()

    if (this.#updateQuoteId !== quoteId) return

    this.updateQuoteStatus = 'INITIAL'
    this.#emitUpdateIfNeeded()

    if (isSuccessful) {
      await this.initSignAccountOpIfNeeded(quoteId)
    } else {
      // @TODO: This is correct, right?
      this.destroySignAccountOp()
      this.emitUpdate()
    }
  }

  async getRouteStartUserTx(): Promise<
    | (
        | (SwapAndBridgeSendTxRequest & { success: true })
        | (SwapAndBridgeErrorType & { success: false })
      )
    | null
  > {
    if (
      this.formStatus !== SwapAndBridgeFormStatus.ReadyToEstimate &&
      this.formStatus !== SwapAndBridgeFormStatus.ReadyToSubmit
    )
      return null

    try {
      const routeResult = await this.#serviceProviderAPI.startRoute({
        fromChainId: this.quote!.fromChainId,
        fromAssetAddress: this.quote!.fromAsset.address,
        toChainId: this.quote!.toChainId,
        toAssetAddress: this.quote!.toAsset.address,
        route: this.quote!.selectedRoute
      })

      return {
        ...routeResult,
        success: true
      }
    } catch (error: any) {
      const humanizedError = getHumanReadableSwapAndBridgeError(error)

      // Display the error in the UI only if it has a shortMessage
      // as we don't have much space and there is a default error message
      if (
        'shortMessage' in humanizedError &&
        humanizedError.shortMessage &&
        typeof humanizedError.shortMessage === 'string'
      ) {
        return {
          success: false,
          id: 'no-routes',
          title: humanizedError.shortMessage,
          level: 'error'
        }
      }

      return null
    }
  }

  async getNextRouteUserTx({
    activeRouteId,
    activeRoute: { route }
  }: {
    activeRouteId: SwapAndBridgeActiveRoute['activeRouteId']
    activeRoute: SwapAndBridgeActiveRoute
  }) {
    try {
      const response = await this.#serviceProviderAPI.getNextRouteUserTx({
        activeRouteId,
        route: route as SwapAndBridgeRoute // TODO: type cast might not be needed?
      })
      return response
    } catch (error: any) {
      const { message } = getHumanReadableSwapAndBridgeError(error)
      throw new EmittableError({ error, level: 'minor', message })
    }
  }

  async checkForNextUserTxForActiveRoutes() {
    await this.#initialLoadPromise
    const fetchAndUpdateRoute = async (activeRoute: SwapAndBridgeActiveRoute) => {
      let status: SwapAndBridgeRouteStatus = null
      const broadcastedButNotConfirmed = this.#activity.broadcastedButNotConfirmed.find((op) =>
        op.calls.some((c) => c.fromUserRequestId === activeRoute.activeRouteId)
      )

      // call getRouteStatus only after the transaction has processed
      if (broadcastedButNotConfirmed) return
      if (activeRoute.routeStatus === 'completed') return

      try {
        // should never happen
        if (!activeRoute.route) throw new Error('Route data is missing.')

        status = await this.#serviceProviderAPI.getRouteStatus({
          fromChainId: activeRoute.route.fromChainId,
          toChainId: activeRoute.route.toChainId,
          bridge: activeRoute.route.usedBridgeNames?.[0],
          activeRouteId: activeRoute.activeRouteId,
          userTxIndex: activeRoute.userTxIndex,
          txHash: activeRoute.userTxHash!
        })
      } catch (e: any) {
        const { message } = getHumanReadableSwapAndBridgeError(e)
        this.updateActiveRoute(activeRoute.activeRouteId, { error: message })
        return
      }

      const route = this.activeRoutes.find((r) => r.activeRouteId === activeRoute.activeRouteId)
      if (route?.error) {
        this.updateActiveRoute(activeRoute.activeRouteId, {
          error: undefined
        })
      }

      if (status === 'completed') {
        this.updateActiveRoute(
          activeRoute.activeRouteId,
          {
            routeStatus: 'completed',
            error: undefined
          },
          true
        )
        this.#portfolioUpdate()
      } else if (status === 'ready') {
        this.updateActiveRoute(
          activeRoute.activeRouteId,
          {
            routeStatus: 'ready',
            error: undefined
          },
          true
        )
      } else if (status === 'refunded') {
        this.updateActiveRoute(
          activeRoute.activeRouteId,
          {
            routeStatus: 'refunded',
            error: undefined
          },
          true
        )
      }
    }

    await Promise.all(
      this.activeRoutesInProgress.map(async (route) => {
        await fetchAndUpdateRoute(route)
      })
    )
  }

  async selectRoute(route: SwapAndBridgeRoute, isAutoSelectDisabled?: boolean) {
    if (!this.quote || !this.quote.routes.length) return
    if (
      ![
        SwapAndBridgeFormStatus.ReadyToSubmit,
        SwapAndBridgeFormStatus.ReadyToEstimate,
        SwapAndBridgeFormStatus.InvalidRouteSelected
      ].includes(this.formStatus)
    )
      return

    this.quote.selectedRoute = route
    this.quote.selectedRouteSteps = route.steps
    if (isAutoSelectDisabled !== undefined) {
      this.isAutoSelectRouteDisabled = isAutoSelectDisabled
    }

    if (this.#updateQuoteId) await this.initSignAccountOpIfNeeded(this.#updateQuoteId)
    this.emitUpdate()
  }

  async addActiveRoute({
    activeRouteId,
    userTxIndex
  }: {
    activeRouteId: SwapAndBridgeActiveRoute['activeRouteId']
    userTxIndex: SwapAndBridgeSendTxRequest['userTxIndex']
  }) {
    await this.#initialLoadPromise

    try {
      let route = this.quote?.routes.find((r) => r.routeId === activeRouteId.toString())
      if (this.#serviceProviderAPI.id === 'socket') {
        route = await this.#serviceProviderAPI.getActiveRoute(activeRouteId.toString())
      }

      if (route) {
        this.activeRoutes.push({
          serviceProviderId: this.#serviceProviderAPI.id,
          activeRouteId: activeRouteId.toString(),
          userTxIndex,
          routeStatus: 'ready',
          userTxHash: null,
          // @ts-ignore TODO: types mismatch by a bit, align types better
          route
        })
      }
      this.emitUpdate()
    } catch (error: any) {
      const { message } = getHumanReadableSwapAndBridgeError(error)
      throw new EmittableError({ error, level: 'major', message })
    }
  }

  updateActiveRoute(
    activeRouteId: SwapAndBridgeActiveRoute['activeRouteId'],
    activeRoute?: Partial<SwapAndBridgeActiveRoute>,
    forceUpdateRoute?: boolean
  ) {
    const currentActiveRoutes = [...this.activeRoutes]
    const activeRouteIndex = currentActiveRoutes.findIndex((r) => r.activeRouteId === activeRouteId)

    if (activeRouteIndex !== -1) {
      if (forceUpdateRoute) {
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        ;(async () => {
          let route = currentActiveRoutes[activeRouteIndex].route
          if (this.#serviceProviderAPI.id === 'socket') {
            // @ts-ignore TODO: types mismatch by a bit, align types better
            route = await this.#serviceProviderAPI.getActiveRoute(activeRouteId)
          }
          this.updateActiveRoute(activeRouteId, { route })
        })()
      }

      if (activeRoute) {
        currentActiveRoutes[activeRouteIndex] = {
          ...currentActiveRoutes[activeRouteIndex],
          ...activeRoute
        }
      } else {
        currentActiveRoutes[activeRouteIndex] = { ...currentActiveRoutes[activeRouteIndex] }
      }

      if (activeRoute?.routeStatus === 'completed' || activeRoute?.routeStatus === 'refunded') {
        // Change the currentUserTxIndex to the length of the userTxs array
        // a.k.a. all transactions are completed
        const activeRouteRoute = currentActiveRoutes[activeRouteIndex].route

        if (activeRouteRoute) {
          activeRouteRoute.currentUserTxIndex = activeRouteRoute.userTxs.length
        }
      } else if (activeRoute?.userTxHash) {
        // Mark all source destination actions as completed
        // when the transaction is mined
        const activeRouteRoute = currentActiveRoutes[activeRouteIndex].route

        if (activeRouteRoute) {
          activeRouteRoute.currentUserTxIndex = activeRouteRoute.userTxs.filter(
            (tx) => tx.userTxType === 'dex-swap'
          ).length
        }
      }

      this.activeRoutes = currentActiveRoutes

      this.#emitUpdateIfNeeded()
    }
  }

  removeActiveRoute(
    activeRouteId: SwapAndBridgeSendTxRequest['activeRouteId'],
    shouldEmitUpdate: boolean = true
  ) {
    this.activeRoutes = this.activeRoutes.filter((r) => r.activeRouteId !== activeRouteId)

    // Purposely not using `this.#emitUpdateIfNeeded()` here, as this should always emit to update banners
    if (shouldEmitUpdate) this.emitUpdate()
  }

  /**
   * Find the next route in line and try to re-estimate with it
   */
  async onEstimationFailure(
    activeRouteId?: SwapAndBridgeSendTxRequest['activeRouteId'],
    error?: SwapAndBridgeErrorType | null
  ) {
    if (!this.quote || !this.quote.selectedRoute || this.isAutoSelectRouteDisabled) return

    const routeId = activeRouteId ?? this.quote.selectedRoute.routeId
    let routeIndex = null
    this.quote.routes.forEach((route, i) => {
      if (route.routeId === routeId) {
        this.quote!.routes.splice(i, 1)
        routeIndex = i
      }
    })

    // no routes available
    if (routeIndex === null || !this.quote.routes[routeIndex]) {
      this.quote.selectedRoute = undefined
      this.quote.routes = []
      this.updateQuoteStatus = 'INITIAL'
      this.emitUpdate()

      // Emit an error only if there are no routes left
      // and one is provided
      if (error) {
        this.addOrUpdateError(error)
      }

      return
    }

    await this.selectRoute(this.quote.routes[routeIndex])
  }

  async markSelectedRouteAsFailed() {
    if (!this.quote || !this.quote.selectedRoute) return

    const routeId = this.quote.selectedRoute.routeId
    this.quote.routes.forEach((route, i) => {
      if (route.routeId === routeId) {
        this.quote!.routes[i].hasFailed = true
      }
    })

    this.emitUpdate()
  }

  // update active route if needed on SubmittedAccountOp update
  handleUpdateActiveRouteOnSubmittedAccountOpStatusUpdate(op: SubmittedAccountOp) {
    op.calls.forEach((call) => {
      this.#handleActiveRouteBroadcastedTransaction(call.fromUserRequestId, op.status)
      this.#handleActiveRouteBroadcastedApproval(call.fromUserRequestId, op.status)
      this.#handleActiveRoutesWithReadyApproval(call.fromUserRequestId, op.status)
      this.#handleUpdateActiveRoutesUserTxData(call.fromUserRequestId, op)
      this.#handleActiveRoutesCompleted(call.fromUserRequestId, op.status)
    })
  }

  #handleActiveRouteBroadcastedTransaction(
    fromUserRequestId: Call['fromUserRequestId'],
    opStatus: SubmittedAccountOp['status']
  ) {
    if (opStatus !== AccountOpStatus.BroadcastedButNotConfirmed) return

    const activeRoute = this.activeRoutes.find((r) => r.activeRouteId === fromUserRequestId)
    if (!activeRoute) return

    // learn the additional step tokens so if the route fails alongs the way,
    // the user has the token learnt in his portfolio
    activeRoute.route?.steps.forEach((step) => {
      this.#portfolio.addTokensToBeLearned([step.toAsset.address], BigInt(step.chainId))
    })

    this.updateActiveRoute(activeRoute.activeRouteId, { routeStatus: 'in-progress' })
  }

  #handleActiveRouteBroadcastedApproval(
    fromUserRequestId: Call['fromUserRequestId'],
    opStatus: SubmittedAccountOp['status']
  ) {
    if (opStatus !== AccountOpStatus.BroadcastedButNotConfirmed) return

    const activeRoute = this.activeRoutes.find(
      (r) => `${r.activeRouteId}-approval` === fromUserRequestId
    )
    if (!activeRoute) return

    this.updateActiveRoute(activeRoute.activeRouteId, {
      routeStatus: 'waiting-approval-to-resolve'
    })
  }

  #handleActiveRoutesWithReadyApproval(
    fromUserRequestId: Call['fromUserRequestId'],
    opStatus: SubmittedAccountOp['status']
  ) {
    const activeRouteWaitingApproval = this.activeRoutes.find(
      (r) =>
        r.routeStatus === 'waiting-approval-to-resolve' &&
        `${r.activeRouteId}-approval` === fromUserRequestId
    )

    if (!activeRouteWaitingApproval) return

    if (opStatus === AccountOpStatus.Success) {
      this.updateActiveRoute(activeRouteWaitingApproval.activeRouteId, {
        routeStatus: 'ready'
      })
    }

    if (opStatus === AccountOpStatus.Failure || opStatus === AccountOpStatus.Rejected) {
      const errorMessage =
        opStatus === AccountOpStatus.Rejected
          ? 'The approval was rejected but you can try to sign it again'
          : 'The approval failed but you can try to sign it again'
      this.updateActiveRoute(activeRouteWaitingApproval.activeRouteId, {
        routeStatus: 'ready',
        error: errorMessage
      })
    }
  }

  #handleUpdateActiveRoutesUserTxData(
    fromUserRequestId: Call['fromUserRequestId'],
    submittedAccountOp: SubmittedAccountOp
  ) {
    const activeRoute = this.activeRoutes.find((r) => r.activeRouteId === fromUserRequestId)
    if (!activeRoute) return

    if (submittedAccountOp && !activeRoute.userTxHash) {
      this.updateActiveRoute(activeRoute.activeRouteId, {
        userTxHash: submittedAccountOp?.txnId,
        identifiedBy: submittedAccountOp.identifiedBy
      })
    }
  }

  #handleActiveRoutesCompleted(
    fromUserRequestId: Call['fromUserRequestId'],
    opStatus: SubmittedAccountOp['status']
  ) {
    const activeRoute = this.activeRoutes.find((r) => r.activeRouteId === fromUserRequestId)
    if (!activeRoute || !activeRoute.route) return

    let shouldUpdateActiveRouteStatus = false

    const isSwap = activeRoute.route.fromChainId === activeRoute.route.toChainId

    // force update the active route status if the route is of type 'swap'
    if (isSwap) shouldUpdateActiveRouteStatus = true

    // force update the active route with an error message if the tx fails (for both swap and bridge)
    if (opStatus === AccountOpStatus.Failure || opStatus === AccountOpStatus.Rejected)
      shouldUpdateActiveRouteStatus = true

    if (!shouldUpdateActiveRouteStatus) return

    if (opStatus === AccountOpStatus.Success) {
      this.updateActiveRoute(activeRoute.activeRouteId, { routeStatus: 'completed' })
    }

    // If the transaction fails, update the status to "ready" to allow the user to sign it again
    if (opStatus === AccountOpStatus.Failure || opStatus === AccountOpStatus.Rejected) {
      const errorMessage =
        opStatus === AccountOpStatus.Rejected
          ? 'The transaction was rejected'
          : 'The transaction failed onchain'
      this.updateActiveRoute(activeRoute.activeRouteId, {
        routeStatus: 'failed',
        error: errorMessage
      })
    }
  }

  #getIsFormValidToFetchQuote() {
    return (
      this.fromChainId &&
      this.toChainId &&
      !!getSafeAmountFromFieldValue(this.fromAmount, this.fromSelectedToken?.decimals) &&
      this.fromSelectedToken &&
      this.toSelectedToken &&
      (this.validateFromAmount.success || this.fromSelectedToken?.isSwitchedToToken)
    )
  }

  #debounceFunctionCallsOnSameTick(funcName: string, func: Function) {
    if (this.#shouldDebounceFlags[funcName]) return
    this.#shouldDebounceFlags[funcName] = true

    // Debounce multiple calls in the same tick and only execute one of them
    setTimeout(() => {
      this.#shouldDebounceFlags[funcName] = false
      func()
    }, 0)
  }

  destroySignAccountOp() {
    // Always attempt to unsubscribe from all previous subscriptions,
    // because the signAccountOpController getter might return null,
    // but prev references to the signAccountOpController might still exist.
    this.#signAccountOpSubscriptions.forEach((unsubscribe) => unsubscribe())
    this.#signAccountOpSubscriptions = []

    if (!this.#signAccountOpController) return
    this.#signAccountOpController.reset()
    this.#signAccountOpController = null
    this.hasProceeded = false
  }

  /**
   * Guard to ensure we only proceed with data that matches the latest active quote in `this.#updateQuoteId`.
   */
  #isQuoteIdObsoleteAfterAsyncOperation(quoteIdGuard: string) {
    return quoteIdGuard && quoteIdGuard !== this.#updateQuoteId
  }

  /**
   * This method might be called multiple times due to async updates (e.g., tokens, routes, etc.).
   * The `quoteIdGuard` acts as a guard to ensure we only proceed with data that matches
   * the latest active quote in `this.#updateQuoteId`.
   *
   * If the component re-renders or receives stale async events (e.g., an old estimation result),
   * this check prevents applying outdated data to the current form state.
   *
   * ⚠️ IMPORTANT: If you make changes here and they involve async operations,
   * make sure to check `isQuoteIdObsoleteAfterAsyncOperation` afterwards
   * to ensure you’re not acting on obsolete data.
   */
  async initSignAccountOpIfNeeded(quoteIdGuard: string) {
    // no updates if the user has committed
    if (this.formStatus === SwapAndBridgeFormStatus.Proceeded) return

    // shouldn't happen ever
    if (!this.#selectedAccount.account) return

    // again it shouldn't happen but there might be a case where the from token
    // disappears because of a strange update event. It's fine to just not
    // continue from the point forward
    if (!this.fromSelectedToken || !this.toSelectedToken || !this.toChainId) return

    if (
      this.formStatus !== SwapAndBridgeFormStatus.ReadyToEstimate &&
      this.formStatus !== SwapAndBridgeFormStatus.ReadyToSubmit
    )
      return

    const fromToken = this.fromSelectedToken as TokenResult
    const network = this.#networks.networks.find((net) => net.chainId === fromToken.chainId)

    // shouldn't happen ever
    if (!network) return

    const provider = this.#providers.providers[network.chainId.toString()]
    const accountState = await this.#accounts.getOrFetchAccountOnChainState(
      this.#selectedAccount.account.addr,
      network.chainId
    )

    if (this.#isQuoteIdObsoleteAfterAsyncOperation(quoteIdGuard)) return

    const userTxn = await this.getRouteStartUserTx()

    if (this.#isQuoteIdObsoleteAfterAsyncOperation(quoteIdGuard)) return

    // if no txn is provided because of a route failure (large slippage),
    // auto select the next route and continue on
    if (!userTxn || !userTxn.success) {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      this.onEstimationFailure(undefined, userTxn)
      return
    }

    // learn the token in the portfolio
    this.#portfolio.addTokensToBeLearned([this.toSelectedToken.address], BigInt(this.toChainId))

    // check if we have an accountOp in main
    const userRequestCalls = batchCallsFromUserRequests({
      accountAddr: this.#selectedAccount.account.addr,
      chainId: network.chainId,
      userRequests: this.#getUserRequests()
    })
    const swapOrBridgeCalls = await getSwapAndBridgeCalls(
      userTxn,
      this.#selectedAccount.account,
      provider,
      accountState
    )

    if (this.#isQuoteIdObsoleteAfterAsyncOperation(quoteIdGuard)) return

    const isBridge = this.fromChainId && this.toChainId && this.fromChainId !== this.toChainId
    const calls = !isBridge ? [...userRequestCalls, ...swapOrBridgeCalls] : [...swapOrBridgeCalls]

    if (this.#signAccountOpController) {
      // if the chain id has changed, we need to destroy the sign account op
      if (
        this.#signAccountOpController.accountOp.meta &&
        this.#signAccountOpController.accountOp.meta.swapTxn &&
        this.#signAccountOpController.accountOp.meta.swapTxn.chainId !== userTxn.chainId
      ) {
        this.destroySignAccountOp()
      } else {
        this.#signAccountOpController.update({ calls })

        // add the real swapTxn
        if (!this.#signAccountOpController.accountOp.meta)
          this.#signAccountOpController.accountOp.meta = {}
        this.#signAccountOpController.accountOp.meta.swapTxn = userTxn
        this.#signAccountOpController.accountOp.meta.fromQuoteId = quoteIdGuard
        return
      }
    }

    const baseAcc = getBaseAccount(
      this.#selectedAccount.account,
      accountState,
      this.#keystore.getAccountKeys(this.#selectedAccount.account),
      network
    )
    const accountOp = {
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
      flags: {
        hideActivityBanner: this.fromSelectedToken.chainId !== BigInt(this.toSelectedToken.chainId)
      },
      meta: {
        swapTxn: userTxn,
        paymasterService: getAmbirePaymasterService(baseAcc, this.#relayerUrl),
        fromQuoteId: quoteIdGuard
      }
    }

    this.#signAccountOpController = new SignAccountOpController(
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
      () => {
        // this is more for a "just-in-case"
        // stop the gas price refetch if there's no signAccountOpController
        // this could only happen if there's a major bug and more than one
        // instance gets created in this controller.
        // It's arguable if it's not better to leave this to "true" instead
        // as leaving it to true will make the problem bigger, but more easy
        // identifiable
        return !!this.#signAccountOpController
      },
      false,
      undefined
    )

    this.emitUpdate()

    // Unsubscribe from all previous subscriptions, if any exist, because the
    // sign account op does NOT destroys before every initSignAccountOpIfNeeded() call
    this.#signAccountOpSubscriptions.forEach((unsubscribe) => unsubscribe())
    this.#signAccountOpSubscriptions = []

    // propagate updates from signAccountOp here
    this.#signAccountOpSubscriptions.push(
      this.#signAccountOpController.onUpdate(() => {
        this.emitUpdate()
      })
    )
    this.#signAccountOpSubscriptions.push(
      this.#signAccountOpController.onError((error) => {
        // Need to clean the pending results for THIS signAccountOpController
        // specifically. NOT the one from the getter (this.signAccountOpController)
        // that is ALWAYS up-to-date with the current quote and the current form state.
        // Due to the async nature, it might not exist - an issue caught by our crash reporting.
        if (this.#signAccountOpController)
          this.#portfolio.overridePendingResults(this.#signAccountOpController.accountOp)

        this.emitError(error)
      })
    )
    // if the estimation emits an error, handle it
    this.#signAccountOpSubscriptions.push(
      this.#signAccountOpController.estimation.onUpdate(() => {
        if (
          this.#signAccountOpController?.accountOp.meta?.swapTxn?.activeRouteId &&
          this.#signAccountOpController.estimation.status === EstimationStatus.Error
        ) {
          // eslint-disable-next-line @typescript-eslint/no-floating-promises
          this.onEstimationFailure(
            this.#signAccountOpController.accountOp.meta.swapTxn.activeRouteId
          )
        }
      })
    )

    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this.reestimate(userTxn)
  }

  /**
   * Reestimate the signAccountOp request periodically.
   * Encapsulate it here instead of creating an interval in the background
   * as intervals are tricky and harder to control
   */
  async reestimate(userTxn: SwapAndBridgeSendTxRequest) {
    if (this.#isReestimating) return

    this.#isReestimating = true
    await wait(30000)
    this.#isReestimating = false

    if (!this.#signAccountOpController) return
    if (!this.#signAccountOpController.accountOp.meta?.swapTxn) return

    const newestUserTxn = JSON.parse(
      JSON.stringify(this.#signAccountOpController.accountOp.meta.swapTxn)
    )

    // if we're refetching a quote atm, we don't execute the estimation
    // a race between the old estimation with the old quote and the new
    // estimation with the new quote might happen
    //
    // also, if the tx data is different, it means the user is playing
    // with the swap, so we don't want to reestimate
    //
    // we only want a re-estimate in a stale state
    if (
      this.updateQuoteStatus === 'LOADING' ||
      userTxn.txData !== this.#signAccountOpController.accountOp.meta.swapTxn.txData
    ) {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      this.reestimate(newestUserTxn)
      return
    }

    this.#signAccountOpController.estimate().catch((e) => {
      // eslint-disable-next-line no-console
      console.log('error on swap&bridge re-estimate')
      // eslint-disable-next-line no-console
      console.log(e)
    })
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this.reestimate(newestUserTxn)
  }

  setUserProceeded(hasProceeded: boolean) {
    this.hasProceeded = hasProceeded
    this.emitUpdate()
  }

  setIsAutoSelectRouteDisabled(isDisabled: boolean) {
    this.isAutoSelectRouteDisabled = isDisabled
    this.emitUpdate()
  }

  get swapSignErrors(): SignAccountOpError[] {
    const errors: SignAccountOpError[] = []
    const isBridge = this.fromChainId && this.toChainId && this.fromChainId !== this.toChainId
    const fromSelectedTokenWithUpToDateAmount = this.#getFromSelectedTokenInPortfolio()

    if (
      isBridge &&
      fromSelectedTokenWithUpToDateAmount &&
      fromSelectedTokenWithUpToDateAmount.amountPostSimulation &&
      fromSelectedTokenWithUpToDateAmount.amount !==
        fromSelectedTokenWithUpToDateAmount.amountPostSimulation
    ) {
      errors.push({
        title: `${fromSelectedTokenWithUpToDateAmount.symbol} detected in batch. Please complete the batch before bridging`
      })
    }

    // Check if there are any errors from the main SignAccountOp controller
    // This prevents proceeding with a swap/bridge if there are estimation errors
    // in the pending batch of transactions
    if (
      this.#isMainSignAccountOpThrowingAnEstimationError &&
      this.#isMainSignAccountOpThrowingAnEstimationError(this.fromChainId, this.toChainId)
    ) {
      errors.push({
        title: 'Error detected in the pending batch. Please review it before proceeding'
      })
    }

    // if we're bridging to ethereum, make the min from amount 10 usd
    if (
      isBridge &&
      this.toChainId === 1 &&
      this.fromAmountInFiat &&
      Number(this.fromAmountInFiat) < 10
    ) {
      errors.push({
        title: 'Min amount for bridging to Ethereum is $10'
      })
    }

    return errors
  }

  get banners() {
    if (!this.#selectedAccount.account) return []

    const activeRoutesForSelectedAccount = getActiveRoutesForAccount(
      this.#selectedAccount.account.addr,
      this.activeRoutes
    )
    const accountOpActions = this.#getVisibleActionsQueue().filter(
      ({ type }) => type === 'accountOp'
    ) as AccountOpAction[]

    // Swap banners aren't generated because swaps are completed instantly,
    // thus the activity banner on broadcast is sufficient
    return getBridgeBanners(activeRoutesForSelectedAccount, accountOpActions)
  }

  toJSON() {
    return {
      ...this,
      ...super.toJSON(),
      toTokenShortList: this.toTokenShortList,
      maxFromAmount: this.maxFromAmount,
      validateFromAmount: this.validateFromAmount,
      isFormEmpty: this.isFormEmpty,
      formStatus: this.formStatus,
      activeRoutesInProgress: this.activeRoutesInProgress,
      activeRoutes: this.activeRoutes,
      isHealthy: this.isHealthy,
      shouldEnableRoutesSelection: this.shouldEnableRoutesSelection,
      supportedChainIds: this.supportedChainIds,
      swapSignErrors: this.swapSignErrors,
      signAccountOpController: this.signAccountOpController,
      banners: this.banners
    }
  }
}

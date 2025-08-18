import { formatUnits, isAddress } from 'ethers'
import { HumanizerMeta } from 'libs/humanizer/interfaces'

import { FEE_COLLECTOR } from '../../consts/addresses'
import { testnetNetworks } from '../../consts/testnetNetworks'
import { Account } from '../../interfaces/account'
import { ExtendedAddressState } from '../../interfaces/interop'
import { Network } from '../../interfaces/network'
import {
  CachedSupportedChains,
  CachedTokenListKey,
  CachedToTokenLists,
  FromToken,
  SwapAndBridgeActiveRoute,
  SwapAndBridgeQuote,
  SwapAndBridgeToToken
} from '../../interfaces/swapAndBridge'
import { TokenResult } from '../../libs/portfolio'
import { getTokenAmount } from '../../libs/portfolio/helpers'
import {
  addCustomTokensIfNeeded,
  convertPortfolioTokenToSwapAndBridgeToToken,
  getIsTokenEligibleForSwapAndBridge,
  sortPortfolioTokenList,
  sortTokenListResponse
} from '../../libs/swapAndBridge/swapAndBridge'
import { getHumanReadableSwapAndBridgeError } from '../../libs/swapAndBridge/swapAndBridgeErrorHumanizer'
import { handleAmountConversion } from '../../libs/transaction/conversion'
import { validateSendTransferAddress } from '../../services/validations'
import wait from '../../utils/wait'
import { Contacts } from '../addressBook/addressBook'
// import SwapAndBridgeError from '../../classes/SwapAndBridgeError'
import EventEmitter from '../eventEmitter/eventEmitter'
import { ControllersTransactionDependencies } from './dependencies'

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

const DEFAULT_ADDRESS_STATE = {
  fieldValue: '',
  ensAddress: '',
  interopAddress: '',
  isDomainResolving: false
}
const HARD_CODED_CURRENCY = 'usd'
const SUPPORTED_CHAINS_CACHE_THRESHOLD = 1000 * 60 * 60 * 24 // 1 day
const TO_TOKEN_LIST_CACHE_THRESHOLD = 1000 * 60 * 60 * 4 // 4 hours
const NETWORK_MISMATCH_MESSAGE =
  'Swap & Bridge network configuration mismatch. Please try again or contact Ambire support.'

type SwapAndBridgeErrorType = {
  id: 'to-token-list-fetch-failed' // ...
  title: string
  text?: string
  level: 'error' | 'warning'
}

export class TransactionFormState extends EventEmitter {
  sessionIds: string[] = []

  fromAmount: string = ''

  fromAmountInFiat: string = ''

  fromAmountFieldMode: 'fiat' | 'token' = 'token'

  toAmount: string = ''

  toAmountInFiat: string = ''

  toAmountFieldMode: 'fiat' | 'token' = 'token'

  fromChainId: number | null = null

  toChainId: number | null = null

  addressState: ExtendedAddressState = { ...DEFAULT_ADDRESS_STATE }

  isRecipientAddressUnknown = false

  isRecipientAddressUnknownAgreed = false

  isRecipientHumanizerKnownTokenOrSmartContract = false

  #selectedAccountData: Account | null = null

  #addressBookContacts: Contacts = []

  #humanizerInfo: HumanizerMeta | null = null

  fromSelectedToken: FromToken | null = null

  toSelectedToken: SwapAndBridgeToToken | null = null

  portfolioTokenList: FromToken[] = []

  routePriority: 'output' | 'time' = 'output'

  quote: SwapAndBridgeQuote | null = null

  quoteRoutesStatuses: { [key: string]: { status: string } } = {}

  // Routes should not be loaded here but in specific controller
  activeRoutes: SwapAndBridgeActiveRoute[] = []

  updateToTokenListStatus: 'INITIAL' | 'LOADING' = 'INITIAL'

  switchTokensStatus: 'INITIAL' | 'LOADING' = 'INITIAL'

  errors: SwapAndBridgeErrorType[] = []

  isTokenListLoading: boolean = false

  #shouldDebounceFlags: { [key: string]: boolean } = {}

  #initialLoadPromise: Promise<void>

  #toTokenList: SwapAndBridgeToToken[] = []

  supportedChainIds: Network['chainId'][] = []

  /**
   * Needed to efficiently manage and cache token lists for different chain
   * combinations (fromChainId and toChainId) without having to fetch them
   * repeatedly from the API. Moreover, this way tokens added to a list by
   * address are also cached for sometime.
   */
  #cachedToTokenLists: CachedToTokenLists = {}

  /**
   * Similar to the `#cachedToTokenLists`, this helps in avoiding repeated API
   * calls to fetch the supported chains from our service provider.
   */
  #cachedSupportedChains: CachedSupportedChains = { lastFetched: 0, data: [] }

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

  constructor(private readonly dependencies: ControllersTransactionDependencies) {
    super()

    this.#initialLoadPromise = this.#load()
    this.supportedChainIds = testnetNetworks.map((c) => BigInt(c.chainId))
  }

  async update(
    params: any,
    updateProps?: {
      emitUpdate?: boolean
      updateQuote?: boolean
    }
  ) {
    const {
      fromAmount,
      fromAmountInFiat,
      fromAmountFieldMode,
      fromSelectedToken,
      toSelectedToken,
      toChainId,
      routePriority,
      addressState
    } = params

    const { emitUpdate = true } = updateProps || {}

    let shouldUpdateToTokenList = false

    if (addressState) {
      // If there is no address, or is invalid interop address, toChainId should be the same as fromChainId
      if (!this.addressState.interopAddress || !this.addressState.fieldValue) {
        this.toChainId = this.fromChainId
      }

      this.addressState = {
        ...this.addressState,
        ...addressState
      }
      this.#onRecipientAddressChange()
    }

    if (fromAmountFieldMode) {
      this.fromAmountFieldMode = fromAmountFieldMode
    }

    if (fromAmount !== undefined) {
      const fromAmountFormatted = fromAmount.indexOf('.') === 0 ? `0${fromAmount}` : fromAmount
      this.fromAmount = fromAmount
      this.#handleAmountConversion(fromAmount, fromAmountFormatted)
    }

    if (fromAmountInFiat !== undefined) {
      this.fromAmountInFiat = fromAmountInFiat
    }

    if (fromSelectedToken) {
      const isFromNetworkChanged = this.fromSelectedToken?.chainId !== fromSelectedToken?.chainId
      if (isFromNetworkChanged) {
        const network = this.dependencies.networks.networks.find(
          (n) => n.chainId === fromSelectedToken.chainId
        )
        if (network) {
          this.fromChainId = Number(network.chainId)
          // Don't update the selected token programmatically if the user
          // has selected it manually
          if (!this.toSelectedToken && !this.addressState.interopAddress) {
            // defaults to swap after network change (should keep fromChainId and toChainId in sync after fromChainId update)
            this.toChainId = Number(network.chainId)
            shouldUpdateToTokenList = true
          }
        }
      }

      const shouldResetFromTokenAmount =
        isFromNetworkChanged || this.fromSelectedToken?.address !== fromSelectedToken.address
      if (shouldResetFromTokenAmount) {
        this.fromAmount = ''
        this.fromAmountInFiat = ''
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

    if (typeof toSelectedToken !== 'undefined') {
      this.toSelectedToken = toSelectedToken
    }

    if (routePriority) {
      this.routePriority = routePriority
      if (this.quote) {
        this.quote = null
        this.quoteRoutesStatuses = {}
      }
    }

    if (emitUpdate) this.#emitUpdateIfNeeded()

    await Promise.all([
      shouldUpdateToTokenList ? this.updateToTokenList(true, toSelectedToken?.address) : undefined
      // TODO: Maybe quote should be updated by the specific Controller that use it
      // and not by the Form, each controller could use a different implementation for quoting (SDK or API)
      // updateQuote ? this.updateQuote({ debounce: true }) : undefined
    ])

    this.emitUpdate()
  }

  unloadScreen(sessionId: string, forceUnload?: boolean) {
    const isFormDirty =
      !!this.fromAmount || !!this.toSelectedToken || !!this.addressState.fieldValue
    // const signAccountOpCtrlStatus = this.dependencies.signAccountOpController?.status?.type
    // const isSigningOrBroadcasting =
    //   signAccountOpCtrlStatus && noStateUpdateStatuses.includes(signAccountOpCtrlStatus)
    const shouldPersistState =
      isFormDirty && sessionId === 'popup' /*  || isSigningOrBroadcasting */ && !forceUnload

    if (shouldPersistState) return

    this.sessionIds = this.sessionIds.filter((id) => id !== sessionId)
    if (!this.sessionIds.length) {
      this.reset(true)
      // Reset health to prevent the error state from briefly flashing
      // before the next health check resolves when the Swap & Bridge
      // screen is opened after a some time
      this.dependencies.serviceProviderAPI.resetHealth()
    }
    // this.hasProceeded = false
  }

  checkIsRecipientAddressUnknown() {
    if (!isAddress(this.recipientAddress)) {
      this.isRecipientAddressUnknown = false
      this.isRecipientAddressUnknownAgreed = false

      this.emitUpdate()
      return
    }
    const isAddressInAddressBook = this.#addressBookContacts.some(
      ({ address }) => address.toLowerCase() === this.recipientAddress.toLowerCase()
    )

    this.isRecipientAddressUnknown =
      !isAddressInAddressBook && this.recipientAddress.toLowerCase() !== FEE_COLLECTOR.toLowerCase()
    this.isRecipientAddressUnknownAgreed = false
    // this.#setSWWarningVisibleIfNeeded()

    this.emitUpdate()
  }

  #handleAmountConversion(fromAmount: string, fromAmountFormatted: string) {
    const { tokenAmount, fiatAmount } = handleAmountConversion(
      fromAmount,
      fromAmountFormatted,
      this.fromSelectedToken,
      this.fromAmountFieldMode === 'fiat',
      HARD_CODED_CURRENCY
    )

    if (this.fromAmountFieldMode === 'fiat') {
      this.fromAmount = tokenAmount
      this.fromAmountInFiat = fiatAmount
    } else {
      this.fromAmount = tokenAmount
      this.fromAmountInFiat = fiatAmount
    }
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
        toTokenList = await this.dependencies.serviceProviderAPI.getToTokenList({
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

    const toTokenNetwork = this.dependencies.networks.networks.find(
      (n) => Number(n.chainId) === this.toChainId
    )
    // should never happen
    if (!toTokenNetwork) {
      this.updateToTokenListStatus = 'INITIAL'
      this.emitUpdate()
      return
      // throw new SwapAndBridgeError(NETWORK_MISMATCH_MESSAGE)
    }

    const additionalTokensFromPortfolio = this.portfolioTokenList
      .filter((t) => t.chainId === toTokenNetwork.chainId)
      .filter((token) => !toTokenList.some((t) => t.address === token.address))
      .map((t) => convertPortfolioTokenToSwapAndBridgeToToken(t, Number(toTokenNetwork.chainId)))

    this.#toTokenList = sortTokenListResponse(
      [...toTokenList, ...additionalTokensFromPortfolio],
      this.portfolioTokenList.filter((t) => t.chainId === toTokenNetwork.chainId)
    )

    if (!this.toSelectedToken) {
      if (addressToSelect) {
        const token = this.#toTokenList.find((t) => t.address === addressToSelect)
        if (token) {
          await this.update({ toSelectedToken: token })
          this.updateToTokenListStatus = 'INITIAL'
          this.emitUpdate()
          return
        }
      }
    }

    this.updateToTokenListStatus = 'INITIAL'
    this.emitUpdate()
  }

  async switchFromAndToTokens() {
    this.switchTokensStatus = 'LOADING'
    this.#emitUpdateIfNeeded()

    const prevFromSelectedToken = this.fromSelectedToken ? { ...this.fromSelectedToken } : null
    // Update the from token
    if (!this.toSelectedToken) {
      await this.update(
        {
          fromAmount: '',
          fromAmountFieldMode: 'token',
          toSelectedToken: this.fromSelectedToken
            ? {
                ...this.fromSelectedToken,
                chainId: Number(this.fromSelectedToken.chainId)
              }
            : null
        },
        {
          emitUpdate: false,
          updateQuote: false
        }
      )
      this.fromSelectedToken = null
    } else if (this.toChainId) {
      const toSelectedTokenNetwork = this.dependencies.networks.networks.find(
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
      await this.update(
        {
          fromAmount,
          fromAmountFieldMode: 'token'
        },
        {
          emitUpdate: false,
          updateQuote: false
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

  resetForm(shouldEmit?: boolean) {
    // Preserve key form states instead of resetting the whole form to enhance UX and reduce confusion.
    // After form submission, maintain the state for fromSelectedToken, fromChainId, and toChainId,
    // while resetting all other state related to the form.
    this.toAmount = ''
    this.fromAmount = ''
    this.fromAmountInFiat = ''
    this.fromAmountFieldMode = 'token'
    // this.toSelectedToken = null
    // this.quote = null
    // this.updateQuoteStatus = 'INITIAL'
    this.quoteRoutesStatuses = {}
    this.addressState = { ...DEFAULT_ADDRESS_STATE }
    // this.destroySignAccountOp()
    // this.hasProceeded = false
    // this.isAutoSelectRouteDisabled = false

    if (shouldEmit) this.#emitUpdateIfNeeded()
  }

  reset(shouldEmit?: boolean) {
    this.resetForm()
    this.fromChainId = 11155111
    this.fromSelectedToken = null
    this.toChainId = 11155111
    this.portfolioTokenList = []
    this.#toTokenList = []
    this.errors = []

    if (shouldEmit) this.#emitUpdateIfNeeded()
  }

  async initForm(sessionId: string) {
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
    this.dependencies.serviceProviderAPI.updateHealth()
    await this.updatePortfolioTokenList(this.dependencies.selectedAccount.portfolio.tokens)
    this.isTokenListLoading = false
    // Do not await on purpose as it's not critical for the controller state to be ready
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this.#fetchSupportedChainsIfNeeded()
    this.#emitUpdateIfNeeded()
  }

  async updatePortfolioTokenList(nextPortfolioTokenList: TokenResult[]) {
    const tokens = nextPortfolioTokenList.filter(getIsTokenEligibleForSwapAndBridge)
    this.portfolioTokenList = sortPortfolioTokenList(
      // Filtering out hidden tokens here means: 1) They won't be displayed in
      // the "From" token list (`this.portfolioTokenList`) and 2) They won't be
      // added to the "Receive" token list as additional tokens from portfolio,
      // BUT 3) They will appear in the "Receive" if they are present in service
      // provider's to token list. This is the desired behavior.
      tokens.filter((t) => !t.flags.isHidden)
    )

    const fromSelectedTokenInNextPortfolio = this.portfolioTokenList.find(
      (t) =>
        t.address === this.fromSelectedToken?.address &&
        t.chainId === this.fromSelectedToken?.chainId
    )

    const shouldUpdateFromSelectedToken =
      !this.fromSelectedToken || // initial (default) state
      // May happen if selected account gets changed or the token gets send away in the meantime
      !fromSelectedTokenInNextPortfolio ||
      // May happen if user receives or sends the token in the meantime
      fromSelectedTokenInNextPortfolio.amount !== this.fromSelectedToken?.amount

    // If the token is not in the portfolio because it was a "to" token
    // and the user has switched the "from" and "to" tokens we should not
    // update the selected token
    if (!this.fromSelectedToken?.isSwitchedToToken && shouldUpdateFromSelectedToken) {
      await this.update(
        {
          fromSelectedToken: fromSelectedTokenInNextPortfolio || null
        },
        {
          emitUpdate: false
        }
      )
      return
    }
    this.#addFromTokenToPortfolioListIfNeeded()
    this.#emitUpdateIfNeeded()
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
          if (this.dependencies.serviceProviderAPI.id === 'socket') {
            // @ts-ignore TODO: types mismatch by a bit, align types better
            route = await this.dependencies.serviceProviderAPI.getActiveRoute(activeRouteId)
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

      if (activeRoute?.routeStatus === 'completed') {
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

  async #load() {
    await this.dependencies.networks.initialLoadPromise
    await this.dependencies.selectedAccount.initialLoadPromise

    this.activeRoutes = await this.dependencies.storage.get('swapAndBridgeActiveRoutes', [])
    // Service provider may have changed since the last time the user interacted
    // with the Swap & Bridge. So strip out cached active routes that were NOT
    // made by the current service provider, because they are NOT compatible.
    //
    // also, just in case protection: filter out ready routes as we don't have
    // retry mechanism or follow up transaction handling anymore. Which means
    // ready routes in the storage are just leftover routes
    this.activeRoutes = this.activeRoutes.filter(
      (r) =>
        r.serviceProviderId === this.dependencies.serviceProviderAPI.id && r.routeStatus !== 'ready'
    )

    this.dependencies.selectedAccount.onUpdate(() => {
      this.#debounceFunctionCallsOnSameTick('updateFormOnSelectedAccountUpdate', async () => {
        if (this.dependencies.selectedAccount.portfolio.isReadyToVisualize) {
          this.isTokenListLoading = false
          await this.updatePortfolioTokenList(this.dependencies.selectedAccount.portfolio.tokens)
          // To token list includes selected account portfolio tokens, it should get an update too
          await this.updateToTokenList(false)
        }
      })
    })
    this.#emitUpdateIfNeeded()
  }

  #onRecipientAddressChange() {
    if (!isAddress(this.recipientAddress)) {
      this.isRecipientAddressUnknown = false
      this.isRecipientAddressUnknownAgreed = false
      this.isRecipientHumanizerKnownTokenOrSmartContract = false
      return
    }

    if (this.#humanizerInfo) {
      // @TODO: could fetch address code
      this.isRecipientHumanizerKnownTokenOrSmartContract =
        !!this.#humanizerInfo.knownAddresses[this.recipientAddress.toLowerCase()]?.isSC
    }

    this.checkIsRecipientAddressUnknown()
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

  #emitUpdateIfNeeded() {
    const shouldSkipUpdate =
      // No need to emit emit updates if there are no active sessions
      !this.sessionIds.length &&
      // but ALSO there are no active routes (otherwise, banners need the updates)
      !this.activeRoutes.length
    if (shouldSkipUpdate) return

    super.emitUpdate()
  }

  #fetchSupportedChainsIfNeeded = async () => {
    const shouldNotReFetchSupportedChains =
      this.#cachedSupportedChains.data.length &&
      Date.now() - this.#cachedSupportedChains.lastFetched < SUPPORTED_CHAINS_CACHE_THRESHOLD
    if (shouldNotReFetchSupportedChains) return

    try {
      const supportedChains = await this.dependencies.serviceProviderAPI.getSupportedChains()

      this.#cachedSupportedChains = { lastFetched: Date.now(), data: supportedChains }
      this.#emitUpdateIfNeeded()
    } catch (error: any) {
      // Fail silently, as this is not a critical feature, Swap & Bridge is still usable
      this.emitError({ error, level: 'silent', message: error?.message })
    }
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

  get #toTokenListKey(): CachedTokenListKey | null {
    if (this.fromChainId === null || this.toChainId === null) return null

    return `from-${this.fromChainId}-to-${this.toChainId}`
  }

  get isInitialized() {
    return !!this.#humanizerInfo && !!this.#selectedAccountData
  }

  get validationFormMsgs() {
    if (!this.isInitialized) return DEFAULT_VALIDATION_FORM_MSGS

    const validationFormMsgsNew = DEFAULT_VALIDATION_FORM_MSGS

    if (this.#humanizerInfo && this.#selectedAccountData) {
      const isEnsAddress = !!this.addressState.ensAddress

      validationFormMsgsNew.recipientAddress = validateSendTransferAddress(
        this.recipientAddress,
        this.#selectedAccountData.addr,
        this.isRecipientAddressUnknownAgreed,
        this.isRecipientAddressUnknown,
        this.isRecipientHumanizerKnownTokenOrSmartContract,
        isEnsAddress,
        this.addressState.isDomainResolving
      )
    }
    return validationFormMsgsNew
  }

  get recipientAddress() {
    return (
      this.addressState.ensAddress ||
      this.addressState.interopAddress ||
      this.addressState.fieldValue
    )
  }

  get maxFromAmount(): string {
    const tokenRef = this.#getFromSelectedTokenInPortfolio() || this.fromSelectedToken
    if (!tokenRef || getTokenAmount(tokenRef) === 0n || typeof tokenRef.decimals !== 'number')
      return '0'

    return formatUnits(getTokenAmount(tokenRef), tokenRef.decimals)
  }

  get isFormEmpty() {
    return (
      !this.fromChainId ||
      !this.toChainId ||
      !this.fromAmount ||
      !this.toAmount ||
      !this.addressState.fieldValue
    )
  }

  get state() {
    return {
      fromChainId: this.fromChainId,
      fromSelectedToken: this.fromSelectedToken,
      toChainId: this.toChainId,
      toSelectedToken: this.toSelectedToken,
      fromAmount: this.fromAmount,
      fromAmountInFiat: this.fromAmountInFiat,
      fromAmountFieldMode: this.fromAmountFieldMode,
      toAmount: this.toAmount,
      toAmountInFiat: this.toAmountInFiat,
      toAmountFieldMode: this.toAmountFieldMode,
      addressState: this.addressState
    }
  }

  toJSON() {
    return {
      ...this,
      ...super.toJSON(),
      name: 'TransactionFormState',
      supportedChainIds: this.supportedChainIds,
      maxFromAmount: this.maxFromAmount,
      recipientAddress: this.recipientAddress
    }
  }
}

import { getAddress, ZeroAddress } from 'ethers'

import { STK_WALLET } from '../../consts/addresses'
import { Account, AccountId, AccountOnchainState } from '../../interfaces/account'
import { Banner } from '../../interfaces/banner'
import { Fetch } from '../../interfaces/fetch'
import { Network } from '../../interfaces/network'
import { isBasicAccount } from '../../libs/account/account'
/* eslint-disable @typescript-eslint/no-shadow */
import { AccountOp, isAccountOpsIntentEqual } from '../../libs/accountOp/accountOp'
import { AccountOpStatus } from '../../libs/accountOp/types'
import { Portfolio } from '../../libs/portfolio'
import batcher from '../../libs/portfolio/batcher'
/* eslint-disable @typescript-eslint/no-use-before-define */
import { CustomToken, TokenPreference } from '../../libs/portfolio/customToken'
import getAccountNetworksWithAssets from '../../libs/portfolio/getNetworksWithAssets'
import {
  getFlags,
  getSpecialHints,
  getTotal,
  getUpdatedHints,
  validateERC20Token
} from '../../libs/portfolio/helpers'
/* eslint-disable no-restricted-syntax */
// eslint-disable-next-line import/no-cycle
import {
  AccountAssetsState,
  AccountState,
  GasTankTokenResult,
  GetOptions,
  NetworkState,
  PortfolioControllerState,
  PreviousHintsStorage,
  TemporaryTokens,
  TokenResult
} from '../../libs/portfolio/interfaces'
import { relayerCall } from '../../libs/relayerCall/relayerCall'
import { AccountsController } from '../accounts/accounts'
import { BannerController } from '../banner/banner'
import EventEmitter from '../eventEmitter/eventEmitter'
import { KeystoreController } from '../keystore/keystore'
import { NetworksController } from '../networks/networks'
import { ProvidersController } from '../providers/providers'
import { StorageController } from '../storage/storage'

/* eslint-disable @typescript-eslint/no-shadow */

const LEARNED_TOKENS_NETWORK_LIMIT = 50

export class PortfolioController extends EventEmitter {
  #latest: PortfolioControllerState

  #pending: PortfolioControllerState

  // A queue to prevent race conditions when calling `updateSelectedAccount`.
  // All calls are queued by network and account.
  // Each time `updateSelectedAccount` is invoked to update the latest or pending state, the call is added to the queue.
  // If a previous call is still running, the new call will be queued and executed only after the first one completes,
  // regardless of whether it succeeds or fails.
  // Before implementing this queue, multiple `updateSelectedAccount` calls made in a short period of time could cause
  // the response of the latest call to be overwritten by a slower previous call.
  #queue: { [accountId: string]: { [chainId: string]: Promise<void> } }

  #toBeLearnedTokens: { [chainId: string]: string[] }

  customTokens: CustomToken[] = []

  tokenPreferences: TokenPreference[] = []

  validTokens: any = { erc20: {}, erc721: {} }

  temporaryTokens: TemporaryTokens = {}

  #portfolioLibs: Map<string, Portfolio>

  #bannerController: BannerController

  #storage: StorageController

  #fetch: Fetch

  #callRelayer: Function

  #velcroUrl: string

  #batchedVelcroDiscovery: Function

  #networksWithAssetsByAccounts: {
    [accountId: string]: AccountAssetsState
  } = {}

  #minUpdateInterval: number = 20000 // 20 seconds

  /**
   * Hints stored in storage, divided into three categories:
   * - fromExternalAPI: Hints fetched from an external API, used when the external API response fails.
   * - learnedTokens: Hints of learned tokens, each with a timestamp indicating the last time the token was seen with a balance and not included in fromExternalAPI hints. This helps prioritize tokens not yet found by Velcro during cleansing.
   * - learnedNfts: Hints of learned NFTs.
   */
  #previousHints: PreviousHintsStorage = {
    fromExternalAPI: {},
    learnedTokens: {},
    learnedNfts: {}
  }

  #providers: ProvidersController

  #networks: NetworksController

  #accounts: AccountsController

  #keystore: KeystoreController

  // Holds the initial load promise, so that one can wait until it completes
  #initialLoadPromise: Promise<void>

  constructor(
    storage: StorageController,
    fetch: Fetch,
    providers: ProvidersController,
    networks: NetworksController,
    accounts: AccountsController,
    keystore: KeystoreController,
    relayerUrl: string,
    velcroUrl: string,
    bannerController: BannerController
  ) {
    super()
    this.#latest = {}
    this.#pending = {}
    this.#queue = {}
    this.#portfolioLibs = new Map()
    this.#storage = storage
    this.#fetch = fetch
    this.#callRelayer = relayerCall.bind({ url: relayerUrl, fetch })
    this.#velcroUrl = velcroUrl
    this.#providers = providers
    this.#networks = networks
    this.#accounts = accounts
    this.#keystore = keystore
    this.temporaryTokens = {}
    this.#toBeLearnedTokens = {}
    this.#bannerController = bannerController
    this.#batchedVelcroDiscovery = batcher(
      fetch,
      (queue) => {
        const baseCurrencies = [...new Set(queue.map((x) => x.data.baseCurrency))]
        const accountAddrs = [...new Set(queue.map((x) => x.data.accountAddr))]
        const pairs = baseCurrencies
          .map((baseCurrency) => accountAddrs.map((accountAddr) => ({ baseCurrency, accountAddr })))
          .flat()
        return pairs.map(({ baseCurrency, accountAddr }) => {
          const queueSegment = queue.filter(
            (x) => x.data.baseCurrency === baseCurrency && x.data.accountAddr === accountAddr
          )
          const url = `${velcroUrl}/multi-hints?networks=${queueSegment
            .map((x) => x.data.chainId)
            .join(',')}&accounts=${queueSegment
            .map((x) => x.data.accountAddr)
            .join(',')}&baseCurrency=${baseCurrency}`

          return { url, queueSegment }
        })
      },
      {
        timeoutSettings: {
          timeoutAfter: 3000,
          timeoutErrorMessage: 'Velcro discovery timed out'
        },
        dedupeByKeys: ['chainId', 'accountAddr']
      }
    )

    this.#initialLoadPromise = this.#load()
  }

  async #load() {
    try {
      await this.#networks.initialLoadPromise
      await this.#accounts.initialLoadPromise

      this.tokenPreferences = await this.#storage.get('tokenPreferences', [])
      this.customTokens = await this.#storage.get('customTokens', [])

      this.#previousHints = await this.#storage.get('previousHints', {})
      const networksWithAssets = await this.#storage.get('networksWithAssetsByAccount', {})
      const isOldStructure = Object.keys(networksWithAssets).every(
        (key) =>
          Array.isArray(networksWithAssets[key]) &&
          (networksWithAssets[key] as any).every((item: any) => typeof item === 'string')
      )
      if (!isOldStructure) {
        this.#networksWithAssetsByAccounts = networksWithAssets
      }
    } catch (e) {
      this.emitError({
        message:
          'Something went wrong when loading portfolio. Please try again or contact support if the problem persists.',
        level: 'major',
        error: new Error('portfolio: failed to pull keys from storage')
      })
    }

    this.emitUpdate()
  }

  async #updatePortfolioOnTokenChange(chainId: bigint, selectedAccountAddr?: string) {
    // As this function currently only updates the portfolio we can skip it altogether
    // if skipPortfolioUpdate is set to true
    if (!selectedAccountAddr) return

    const networkData = this.#networks.networks.find((n) => n.chainId === chainId)
    await this.updateSelectedAccount(
      selectedAccountAddr,
      networkData ? [networkData] : undefined,
      undefined,
      {
        forceUpdate: true
      }
    )
  }

  async addCustomToken(
    customToken: CustomToken,
    selectedAccountAddr?: string,
    shouldUpdatePortfolio?: boolean
  ) {
    await this.#initialLoadPromise
    const isTokenAlreadyAdded = this.customTokens.some(
      ({ address, chainId }) =>
        address.toLowerCase() === customToken.address.toLowerCase() &&
        chainId === customToken.chainId
    )

    if (isTokenAlreadyAdded) return

    this.customTokens.push(customToken)

    if (shouldUpdatePortfolio) {
      await this.#updatePortfolioOnTokenChange(customToken.chainId, selectedAccountAddr)
    }

    await this.#storage.set('customTokens', this.customTokens)
  }

  async removeCustomToken(
    customToken: Omit<CustomToken, 'standard'>,
    selectedAccountAddr?: string,
    shouldUpdatePortfolio?: boolean
  ) {
    await this.#initialLoadPromise
    this.customTokens = this.customTokens.filter(
      (token) =>
        !(
          token.address.toLowerCase() === customToken.address.toLowerCase() &&
          token.chainId === customToken.chainId
        )
    )
    const existingPreference = this.tokenPreferences.some(
      (pref) => pref.address === customToken.address && pref.chainId === customToken.chainId
    )

    // Delete custom token preference if it exists
    if (existingPreference) {
      await this.toggleHideToken(customToken, selectedAccountAddr, shouldUpdatePortfolio)
      await this.#storage.set('customTokens', this.customTokens)
    } else {
      this.emitUpdate()
      if (shouldUpdatePortfolio) {
        await this.#updatePortfolioOnTokenChange(customToken.chainId, selectedAccountAddr)
      }
      await this.#storage.set('customTokens', this.customTokens)
    }
  }

  async toggleHideToken(
    tokenPreference: TokenPreference,
    selectedAccountAddr?: string,
    shouldUpdatePortfolio?: boolean
  ) {
    await this.#initialLoadPromise

    const existingPreference = this.tokenPreferences.find(
      ({ address, chainId }) =>
        address.toLowerCase() === tokenPreference.address.toLowerCase() &&
        chainId === tokenPreference.chainId
    )

    // Push the token as hidden
    if (!existingPreference) {
      this.tokenPreferences.push({ ...tokenPreference, isHidden: true })
      // Remove the token preference if the user decides to show it again
    } else if (existingPreference.isHidden) {
      this.tokenPreferences = this.tokenPreferences.filter(
        ({ address, chainId }) =>
          !(address === tokenPreference.address && chainId === tokenPreference.chainId)
      )
    } else {
      // Should happen only after migration
      existingPreference.isHidden = !existingPreference.isHidden
    }

    this.emitUpdate()
    if (shouldUpdatePortfolio) {
      await this.#updatePortfolioOnTokenChange(tokenPreference.chainId, selectedAccountAddr)
    }
    await this.#storage.set('tokenPreferences', this.tokenPreferences)
  }

  async #updateNetworksWithAssets(accountId: AccountId, accountState: AccountState) {
    const storageStateByAccount = this.#networksWithAssetsByAccounts

    this.#networksWithAssetsByAccounts[accountId] = getAccountNetworksWithAssets(
      accountId,
      accountState,
      storageStateByAccount,
      this.#providers.providers
    )

    this.emitUpdate()
    await this.#storage.set('networksWithAssetsByAccount', this.#networksWithAssetsByAccounts)
  }

  #setNetworkLoading(
    accountId: AccountId,
    stateKey: 'latest' | 'pending',
    network: string,
    isLoading: boolean,
    error?: any
  ) {
    const states = { latest: this.#latest, pending: this.#pending }
    const accountState = states[stateKey][accountId]
    if (!accountState[network]) accountState[network] = { errors: [], isReady: false, isLoading }
    accountState[network]!.isLoading = isLoading
    if (error)
      accountState[network]!.criticalError = {
        message:
          error?.message || 'Error while executing the get function in the portfolio library.',
        simulationErrorMsg: error?.simulationErrorMsg,
        stack: error?.stack,
        name: error?.name
      }
  }

  removeNetworkData(chainId: bigint) {
    for (const accountState of [this.#latest, this.#pending]) {
      for (const accountId of Object.keys(accountState)) {
        delete accountState[accountId][chainId.toString()]
      }
    }
    this.emitUpdate()
  }

  // make the pending results the same as the latest ones
  overridePendingResults(accountOp: AccountOp) {
    if (
      this.#pending[accountOp.accountAddr] &&
      this.#pending[accountOp.accountAddr][accountOp.chainId.toString()] &&
      this.#latest[accountOp.accountAddr] &&
      this.#latest[accountOp.accountAddr][accountOp.chainId.toString()]
    ) {
      this.#pending[accountOp.accountAddr][accountOp.chainId.toString()]!.result =
        this.#latest[accountOp.accountAddr][accountOp.chainId.toString()]!.result
      this.emitUpdate()
    }
  }

  async updateTokenValidationByStandard(
    token: { address: TokenResult['address']; chainId: TokenResult['chainId'] },
    accountId: AccountId
  ) {
    await this.#initialLoadPromise
    if (this.validTokens.erc20[`${token.address}-${token.chainId}`] === true) return

    const [isValid, standard]: [boolean, string] = (await validateERC20Token(
      token,
      accountId,
      this.#providers.providers[token.chainId.toString()]
    )) as [boolean, string]

    this.validTokens[standard] = {
      ...this.validTokens[standard],
      [`${token.address}-${token.chainId}`]: isValid
    }

    this.emitUpdate()
  }

  initializePortfolioLibIfNeeded(
    accountId: AccountId,
    chainId: bigint,
    network: Network
  ): Portfolio | null {
    const providers = this.#providers.providers
    const key = `${chainId}:${accountId}`
    // Initialize a new Portfolio lib if:
    // 1. It does not exist in the portfolioLibs map
    // 2. The network RPC URL has changed
    if (
      !this.#portfolioLibs.has(key) ||
      this.#portfolioLibs.get(key)?.network?.selectedRpcUrl !==
        // eslint-disable-next-line no-underscore-dangle
        providers[network.chainId.toString()]?._getConnection().url
    ) {
      try {
        this.#portfolioLibs.set(
          key,
          new Portfolio(
            this.#fetch,
            providers[network.chainId.toString()],
            network,
            this.#velcroUrl,
            this.#batchedVelcroDiscovery
          )
        )
      } catch (e: any) {
        return null
      }
    }
    return this.#portfolioLibs.get(key)!
  }

  async getTemporaryTokens(accountId: AccountId, chainId: bigint, additionalHint: string) {
    const network = this.#networks.networks.find((x) => x.chainId === chainId)

    if (!network) throw new Error('network not found')

    const portfolioLib = this.initializePortfolioLibIfNeeded(accountId, chainId, network)

    const temporaryTokensToFetch =
      (this.temporaryTokens[network.chainId.toString()] &&
        this.temporaryTokens[network.chainId.toString()].result?.tokens.filter(
          (x) => x.address !== additionalHint
        )) ||
      []

    this.temporaryTokens[network.chainId.toString()] = {
      isLoading: false,
      errors: [],
      result:
        this.temporaryTokens[network.chainId.toString()] &&
        this.temporaryTokens[network.chainId.toString()].result
    }
    this.emitUpdate()

    try {
      if (!portfolioLib) {
        throw new Error(
          `a portfolio library is not initialized for ${network.name} (${network.chainId})`
        )
      }

      const result = await portfolioLib.get(accountId, {
        priceRecency: 60000 * 5,
        additionalErc20Hints: [additionalHint, ...temporaryTokensToFetch.map((x) => x.address)],
        disableAutoDiscovery: true
      })
      this.temporaryTokens[network.chainId.toString()] = {
        isLoading: false,
        errors: [],
        result: {
          tokens: result.tokens
        }
      }
      this.emitUpdate()
      return true
    } catch (e: any) {
      this.emitError({
        level: 'silent',
        message: "Error while executing the 'get' function in the portfolio library.",
        error: e
      })
      this.temporaryTokens[network.chainId.toString()].isLoading = false
      this.temporaryTokens[network.chainId.toString()].errors.push(e)
      this.emitUpdate()
      return false
    }
  }

  async #getAdditionalPortfolio(accountId: AccountId, forceUpdate?: boolean) {
    const rewardsOrGasTankState =
      this.#latest[accountId]?.rewards || this.#latest[accountId]?.gasTank
    const canSkipUpdate = rewardsOrGasTankState
      ? this.#getCanSkipUpdate(rewardsOrGasTankState, forceUpdate)
      : false

    if (canSkipUpdate) return

    const start = Date.now()
    const accountState = this.#latest[accountId]

    this.#setNetworkLoading(accountId, 'latest', 'gasTank', true)
    this.#setNetworkLoading(accountId, 'latest', 'rewards', true)
    this.emitUpdate()

    let res: any
    try {
      res = await this.#callRelayer(`/v2/identity/${accountId}/portfolio-additional`)
    } catch (e: any) {
      console.error('relayer error for portfolio additional')
      this.#setNetworkLoading(accountId, 'latest', 'gasTank', false, e)
      this.#setNetworkLoading(accountId, 'latest', 'rewards', false, e)
      this.emitUpdate()
      return
    }

    if (res.data.banner) {
      const banner = res.data.banner

      const formattedBanner: Banner = {
        // eslint-disable-next-line no-underscore-dangle
        id: banner.id || banner._id,
        type: banner.type || 'updates',
        params: {
          startTime: banner.startTime,
          endTime: banner.endTime
        },
        ...(banner.text && { text: banner.text }),
        ...(banner.title && { title: banner.title }),
        ...(banner.url && {
          actions: [
            {
              label: 'Open',
              actionName: 'open-link',
              meta: { url: banner.url }
            }
          ]
        })
      }

      this.#bannerController.addBanner(formattedBanner)
    }

    if (!res) throw new Error('portfolio controller: no res, should never happen')

    const rewardsTokens = [
      res.data.rewards.stkWalletClaimableBalance || [],
      res.data.rewards.walletClaimableBalance || []
    ]
      .flat()
      .map((t: any) => ({
        ...t,
        chainId: BigInt(t.chainId || 1),
        amount: BigInt(t.amount || 0),
        symbol: t.address === STK_WALLET ? 'stkWALLET' : t.symbol,
        flags: getFlags(res.data.rewards, 'rewards', t.chainId, t.address)
      }))

    accountState.rewards = {
      isReady: true,
      isLoading: false,
      errors: [],
      result: {
        ...res.data.rewards,
        lastSuccessfulUpdate: Date.now(),
        updateStarted: start,
        tokens: rewardsTokens,
        total: getTotal(rewardsTokens)
      }
    }

    const gasTankTokens: GasTankTokenResult[] = res.data.gasTank.balance.map((t: any) => ({
      ...t,
      amount: BigInt(t.amount || 0),
      chainId: BigInt(t.chainId || 1),
      availableAmount: BigInt(t.availableAmount || 0),
      cashback: BigInt(t.cashback || 0),
      saved: BigInt(t.saved || 0),
      flags: getFlags(res.data, 'gasTank', t.chainId, t.address)
    }))

    accountState.gasTank = {
      isReady: true,
      isLoading: false,
      errors: [],
      result: {
        updateStarted: start,
        lastSuccessfulUpdate: Date.now(),
        tokens: [],
        gasTankTokens,
        total: getTotal(gasTankTokens)
      }
    }

    this.emitUpdate()
  }

  #getCanSkipUpdate(
    networkState?: NetworkState,
    forceUpdate?: boolean,
    maxDataAgeMs: number = this.#minUpdateInterval
  ) {
    const hasImportantErrors = networkState?.errors.some((e) => e.level === 'critical')

    if (forceUpdate || !networkState || networkState.criticalError || hasImportantErrors)
      return false
    const updateStarted = networkState.result?.updateStarted || 0
    const isWithinMinUpdateInterval = !!updateStarted && Date.now() - updateStarted < maxDataAgeMs

    return isWithinMinUpdateInterval || networkState.isLoading
  }

  // By our convention, we always stick with private (#) instead of protected methods.
  // However, we made a compromise here to allow Jest tests to mock updatePortfolioState.
  protected async updatePortfolioState(
    accountId: string,
    network: Network,
    portfolioLib: Portfolio | null,
    portfolioProps: Partial<GetOptions> & { blockTag: 'latest' | 'pending' },
    forceUpdate: boolean,
    maxDataAgeMs?: number
  ): Promise<boolean> {
    const blockTag = portfolioProps.blockTag
    const stateKeys = { latest: this.#latest, pending: this.#pending }
    const accountState = stateKeys[blockTag][accountId]

    // Can occur if the account is removed while updateSelectedAccount is in progress
    if (!accountState) return false

    if (!accountState[network.chainId.toString()]) {
      // isLoading must be false here, otherwise canSkipUpdate will return true
      // and portfolio will not be updated
      accountState[network.chainId.toString()] = { isLoading: false, isReady: false, errors: [] }
    }

    const canSkipUpdate = this.#getCanSkipUpdate(
      accountState[network.chainId.toString()],
      forceUpdate,
      maxDataAgeMs
    )

    if (canSkipUpdate) return false

    this.#setNetworkLoading(accountId, blockTag, network.chainId.toString(), true)
    const state = accountState[network.chainId.toString()]!
    if (forceUpdate) state.criticalError = undefined

    this.emitUpdate()

    const hasNonZeroTokens = !!Object.values(
      this.#networksWithAssetsByAccounts?.[accountId] || {}
    ).some(Boolean)

    try {
      if (!portfolioLib)
        throw new Error(
          `a portfolio library is not initialized for ${network.name} (${network.chainId})`
        )

      const result = await portfolioLib.get(accountId, {
        priceRecency: 60000 * 5,
        priceCache: state.result?.priceCache,
        fetchPinned: !hasNonZeroTokens,
        ...portfolioProps
      })

      const hasError = result.errors.some((e) => e.level !== 'silent')
      let lastSuccessfulUpdate =
        accountState[network.chainId.toString()]?.result?.lastSuccessfulUpdate || 0

      // Reset lastSuccessfulUpdate on forceUpdate in case of critical errors as the user
      // is likely expecting a change in the portfolio.
      if (forceUpdate && hasError) {
        lastSuccessfulUpdate = 0
      } else if (!hasError) {
        // Update the last successful update only if there are no critical errors.
        lastSuccessfulUpdate = Date.now()
      }

      accountState[network.chainId.toString()] = {
        // We cache the previously simulated AccountOps
        // in order to compare them with the newly passed AccountOps before executing a new updatePortfolioState.
        // This allows us to identify any differences between the two.
        accountOps: portfolioProps?.simulation?.accountOps,
        isReady: true,
        isLoading: false,
        errors: result.errors,
        result: {
          ...result,
          lastSuccessfulUpdate,
          tokens: result.tokens,
          total: getTotal(result.tokens)
        }
      }

      this.emitUpdate()
      return true
    } catch (e: any) {
      this.emitError({
        level: 'silent',
        message: "Error while executing the 'get' function in the portfolio library.",
        error: e
      })
      state.isLoading = false
      // Convert the error to an object because the portfolio state is cloned
      // using structuredClone() which doesn't preserve custom error properties
      // like simulationErrorMsg
      state.criticalError = {
        message: e?.message || 'Error while executing the get function in the portfolio library.',
        simulationErrorMsg: e?.simulationErrorMsg,
        stack: e?.stack,
        name: e?.name
      }

      if (forceUpdate && state.result) {
        // Reset lastSuccessfulUpdate on forceUpdate in case of a critical error as the user
        // is likely expecting a change in the portfolio.
        state.result.lastSuccessfulUpdate = 0
      }
      this.emitUpdate()

      return false
    }
  }

  // NOTE: we always pass in all `accounts` and `networks` to ensure that the user of this
  // controller doesn't have to update this controller every time that those are updated

  // The recommended behavior of the application that this API encourages is:
  // 1) when the user selects an account, update it's portfolio on all networks (latest state only) by calling updateSelectedAccount
  // 2) every time the user has a change in their pending (to be signed or to be mined) bundle(s) on a
  // certain network, call updateSelectedAccount again with those bundles; it will update the portfolio balance
  // on each network where there are bundles, and it will update both `latest` and `pending` states on said networks
  // it will also use a high `priceRecency` to make sure we don't lose time in updating prices (since we care about running the simulations)

  // the purpose of this function is to call it when an account is selected or the queue of accountOps changes
  async updateSelectedAccount(
    accountId: AccountId,
    networks?: Network[],
    simulation?: {
      accountOps: { [key: string]: AccountOp[] }
      states: { [chainId: string]: AccountOnchainState }
    },
    opts?: { forceUpdate?: boolean; maxDataAgeMs?: number }
  ) {
    await this.#initialLoadPromise
    const selectedAccount = this.#accounts.accounts.find((x) => x.addr === accountId)
    if (!selectedAccount) throw new Error('selected account does not exist')
    if (!this.#latest[accountId]) this.#latest[accountId] = {}
    if (!this.#pending[accountId]) this.#pending[accountId] = {}

    const accountState = this.#latest[accountId]
    const pendingState = this.#pending[accountId]

    const networksToUpdate = networks || this.#networks.networks
    await Promise.all([
      this.#getAdditionalPortfolio(accountId, opts?.forceUpdate),
      ...networksToUpdate.map(async (network) => {
        const key = `${network.chainId}:${accountId}`

        const portfolioLib = this.initializePortfolioLibIfNeeded(
          accountId,
          network.chainId,
          network
        )

        const currentAccountOps = simulation?.accountOps[network.chainId.toString()]?.filter(
          (op) => op.accountAddr === accountId
        )
        const state = simulation?.states?.[network.chainId.toString()]
        const simulatedAccountOps = pendingState[network.chainId.toString()]?.accountOps

        if (!this.#queue?.[accountId]?.[network.chainId.toString()])
          this.#queue[accountId] = {
            ...this.#queue[accountId],
            [network.chainId.toString()]: Promise.resolve()
          }

        const updatePromise = async (): Promise<void> => {
          // We are performing the following extended check because both (or one of both) variables may have an undefined value.
          // If both variables contain AccountOps, we can simply compare for changes in the AccountOps intent.
          // However, when one of the variables is not set, two cases arise:
          // 1. A change occurs if one variable is undefined and the other one holds an AccountOps object.
          // 2. No change occurs if both variables are undefined.
          const areAccountOpsChanged =
            currentAccountOps && simulatedAccountOps
              ? !isAccountOpsIntentEqual(currentAccountOps, simulatedAccountOps)
              : currentAccountOps !== simulatedAccountOps
          const forceUpdate = opts?.forceUpdate || areAccountOpsChanged

          const previousHintsFromExternalAPI = this.#previousHints?.fromExternalAPI?.[key]

          const additionalErc20Hints = Object.keys(
            (this.#previousHints?.learnedTokens &&
              this.#previousHints?.learnedTokens[network.chainId.toString()]) ??
              {}
          )

          const specialErc20Hints = getSpecialHints(
            network.chainId,
            this.customTokens,
            this.tokenPreferences,
            this.#toBeLearnedTokens
          )

          // TODO: Add custom ERC721 tokens to the hints
          const additionalErc721Hints = Object.fromEntries(
            Object.entries(
              this.#previousHints?.learnedNfts?.[network.chainId.toString()] || {}
            ).map(([k, v]) => [
              getAddress(k),
              { isKnown: false, tokens: v.map((i) => i.toString()) }
            ])
          )
          const allHints = {
            previousHintsFromExternalAPI,
            additionalErc20Hints,
            additionalErc721Hints,
            specialErc20Hints
          }

          const [isSuccessfulLatestUpdate] = await Promise.all([
            // Latest state update
            this.updatePortfolioState(
              accountId,
              network,
              portfolioLib,
              {
                blockTag: 'latest',
                ...allHints
              },
              forceUpdate,
              opts?.maxDataAgeMs
            ),
            this.updatePortfolioState(
              accountId,
              network,
              portfolioLib,
              {
                blockTag: 'pending',
                ...(currentAccountOps &&
                  state && {
                    simulation: {
                      account: selectedAccount,
                      accountOps: currentAccountOps,
                      state
                    }
                  }),
                ...allHints
              },
              forceUpdate,
              opts?.maxDataAgeMs
            )
          ])

          // Persist latest state in previousHints in the disk storage for further requests
          if (
            isSuccessfulLatestUpdate &&
            !areAccountOpsChanged &&
            accountState[network.chainId.toString()]?.result
          ) {
            const networkResult = accountState[network.chainId.toString()]!.result
            const readyToLearnTokens = networkResult?.toBeLearned?.erc20s || []

            if (readyToLearnTokens.length) {
              await this.learnTokens(readyToLearnTokens, network.chainId)
            }

            // Either a valid response or there is no external API to fetch hints from
            const isExternalHintsApiResponseValid =
              !!networkResult?.hintsFromExternalAPI || !network.hasRelayer

            if (
              isExternalHintsApiResponseValid &&
              !networkResult?.hintsFromExternalAPI?.skipOverrideSavedHints
            ) {
              const updatedStoragePreviousHints = getUpdatedHints(
                networkResult!.hintsFromExternalAPI || null,
                networkResult!.tokens,
                networkResult!.tokenErrors,
                network.chainId,
                this.#previousHints,
                key,
                this.customTokens,
                this.tokenPreferences
              )

              // Updating hints is only needed when the external API response is valid.
              // learnTokens and learnNfts update storage separately, so we don't need to update them here
              // if the external API response is invalid.
              this.#previousHints = updatedStoragePreviousHints
              await this.#storage.set('previousHints', updatedStoragePreviousHints)
            }
          }
        }

        // Chain the new updatePromise to the current queue
        this.#queue[accountId][network.chainId.toString()] = this.#queue[accountId][
          network.chainId.toString()
        ]
          .then(updatePromise)
          .catch(() => updatePromise())

        // Ensure the method waits for the entire queue to resolve
        await this.#queue[accountId][network.chainId.toString()]
      })
    ])

    await this.#updateNetworksWithAssets(accountId, accountState)
    this.emitUpdate()
  }

  markSimulationAsBroadcasted(accountId: string, chainId: bigint) {
    const simulation = this.#pending[accountId][chainId.toString()]?.accountOps?.[0]

    if (!simulation) return

    simulation.status = AccountOpStatus.BroadcastedButNotConfirmed

    this.emitUpdate()
  }

  addTokensToBeLearned(tokenAddresses: string[], chainId: bigint) {
    const chainIdString = chainId.toString()

    if (!tokenAddresses.length) return false
    if (!this.#toBeLearnedTokens[chainIdString]) this.#toBeLearnedTokens[chainIdString] = []

    let networkToBeLearnedTokens = this.#toBeLearnedTokens[chainIdString]

    const alreadyLearned = networkToBeLearnedTokens.map((addr) => getAddress(addr))

    const tokensToLearn = tokenAddresses.filter((address) => {
      let normalizedAddress
      try {
        normalizedAddress = getAddress(address)
      } catch (e) {
        console.error('Error while normalizing token address', e)
      }

      return normalizedAddress && !alreadyLearned.includes(normalizedAddress)
    })

    if (!tokensToLearn.length) return false

    networkToBeLearnedTokens = [...tokensToLearn, ...networkToBeLearnedTokens]

    this.#toBeLearnedTokens[chainIdString] = networkToBeLearnedTokens
    return true
  }

  // Learn new tokens from humanizer and debug_traceCall
  // return: whether new tokens have been learned
  async learnTokens(tokenAddresses: string[] | undefined, chainId: bigint): Promise<boolean> {
    if (!tokenAddresses) return false

    if (!this.#previousHints.learnedTokens) this.#previousHints.learnedTokens = {}

    let networkLearnedTokens: PreviousHintsStorage['learnedTokens'][''] =
      this.#previousHints.learnedTokens[chainId.toString()] || {}

    const alreadyLearned = Object.keys(networkLearnedTokens).map((addr) => getAddress(addr))

    const tokensToLearn = tokenAddresses.reduce((acc: { [key: string]: null }, address) => {
      if (address === ZeroAddress) return acc
      if (alreadyLearned.includes(getAddress(address))) return acc

      acc[address] = acc[address] || null // Keep the timestamp of all learned tokens

      if (this.#toBeLearnedTokens[chainId.toString()]) {
        // Remove the token from toBeLearnedTokens if it will be learned
        this.#toBeLearnedTokens[chainId.toString()] = this.#toBeLearnedTokens[
          chainId.toString()
        ].filter((addr) => addr !== address)
      }

      return acc
    }, {})

    if (!Object.keys(tokensToLearn).length) return false
    // Add new tokens in the beginning of the list
    networkLearnedTokens = { ...tokensToLearn, ...networkLearnedTokens }

    // Reached limit
    if (LEARNED_TOKENS_NETWORK_LIMIT - Object.keys(networkLearnedTokens).length < 0) {
      // Convert learned tokens into an array of [address, timestamp] pairs and sort by timestamp in descending order.
      // This ensures that tokens with the most recent timestamps are prioritized for retention,
      // and tokens with the oldest timestamps are deleted last when the limit is exceeded.
      const learnedTokensArray = Object.entries(networkLearnedTokens).sort(
        (a, b) => Number(b[1]) - Number(a[1])
      )

      networkLearnedTokens = Object.fromEntries(
        learnedTokensArray.slice(0, LEARNED_TOKENS_NETWORK_LIMIT)
      )
    }

    this.#previousHints.learnedTokens[chainId.toString()] = networkLearnedTokens
    await this.#storage.set('previousHints', this.#previousHints)
    return true
  }

  async learnNfts(nftsData: [string, bigint[]][] | undefined, chainId: bigint): Promise<boolean> {
    if (!nftsData?.length) return false
    if (!this.#previousHints.learnedNfts) this.#previousHints.learnedNfts = {}
    const networkLearnedNfts: PreviousHintsStorage['learnedNfts'][''] =
      this.#previousHints.learnedNfts[chainId.toString()] || {}

    const newAddrToId = nftsData.map(([addr, ids]) => ids.map((id) => `${addr}:${id}`)).flat()
    const alreadyLearnedAddrToId = Object.entries(networkLearnedNfts)
      .map(([addr, ids]) => ids.map((id) => `${addr}:${id}`))
      .flat()
    if (newAddrToId.every((i) => alreadyLearnedAddrToId.includes(i))) return false
    nftsData.forEach(([addr, ids]) => {
      if (addr === ZeroAddress) return
      if (!networkLearnedNfts[addr]) networkLearnedNfts[addr] = ids
      else networkLearnedNfts[addr] = Array.from(new Set([...ids, ...networkLearnedNfts[addr]]))
    })

    this.#previousHints.learnedNfts[chainId.toString()] = networkLearnedNfts
    await this.#storage.set('previousHints', this.#previousHints)
    return true
  }

  removeAccountData(address: Account['addr']) {
    delete this.#latest[address]
    delete this.#pending[address]
    delete this.#networksWithAssetsByAccounts[address]

    this.#networks.networks.forEach((network) => {
      const key = `${network.chainId}:${address}`

      if (key in this.#previousHints.fromExternalAPI) {
        delete this.#previousHints.fromExternalAPI[key]
      }
      if (key in this.#portfolioLibs) {
        this.#portfolioLibs.delete(key)
      }
    })
    this.#storage.set('previousHints', this.#previousHints)
    this.#storage.set('networksWithAssetsByAccount', this.#networksWithAssetsByAccounts)

    this.emitUpdate()
  }

  getLatestPortfolioState(accountAddr: string) {
    return this.#latest[accountAddr] || {}
  }

  getPendingPortfolioState(accountAddr: string) {
    return this.#pending[accountAddr] || {}
  }

  getNetworksWithAssets(accountAddr: string) {
    return this.#networksWithAssetsByAccounts[accountAddr] || []
  }

  async simulateAccountOp(op: AccountOp): Promise<void> {
    const account = this.#accounts.accounts.find((acc) => acc.addr === op.accountAddr)!
    const network = this.#networks.networks.find((net) => net.chainId === op.chainId)!
    const state = await this.#accounts.getOrFetchAccountOnChainState(op.accountAddr, op.chainId)
    const noSimulation = isBasicAccount(account, state) && network.rpcNoStateOverride
    const simulation = !noSimulation
      ? {
          accountOps: { [network.chainId.toString()]: [op] },
          states: await this.#accounts.getOrFetchAccountStates(op.accountAddr)
        }
      : undefined
    return this.updateSelectedAccount(op.accountAddr, [network], simulation, { forceUpdate: true })
  }

  toJSON() {
    return {
      ...this,
      ...super.toJSON()
    }
  }
}

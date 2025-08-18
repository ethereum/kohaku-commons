/* eslint-disable no-underscore-dangle */
import { getAddress } from 'ethers'

import { AMBIRE_ACCOUNT_FACTORY } from '../../consts/deploy'
import { Account } from '../../interfaces/account'
import { Banner } from '../../interfaces/banner'
import {
  CashbackStatus,
  CashbackStatusByAccount,
  SelectedAccountPortfolio,
  SelectedAccountPortfolioByNetworks
} from '../../interfaces/selectedAccount'
import { isSmartAccount } from '../../libs/account/account'
import {
  defiPositionsOnDisabledNetworksBannerId,
  getDefiPositionsOnDisabledNetworksForTheSelectedAccount,
  getFirstCashbackBanners
} from '../../libs/banners/banners'
import { sortByValue } from '../../libs/defiPositions/helpers'
import { getStakedWalletPositions } from '../../libs/defiPositions/providers'
import { PositionsByProvider } from '../../libs/defiPositions/types'
import { PortfolioGasTankResult } from '../../libs/portfolio/interfaces'
// eslint-disable-next-line import/no-cycle
import {
  getNetworksWithDeFiPositionsErrorErrors,
  getNetworksWithFailedRPCErrors,
  getNetworksWithPortfolioErrorErrors,
  SelectedAccountBalanceError
} from '../../libs/selectedAccount/errors'
import { calculateSelectedAccountPortfolio } from '../../libs/selectedAccount/selectedAccount'
import { getIsViewOnly } from '../../utils/accounts'
// eslint-disable-next-line import/no-cycle
import { AccountsController } from '../accounts/accounts'
// eslint-disable-next-line import/no-cycle
import { DefiPositionsController } from '../defiPositions/defiPositions'
import EventEmitter from '../eventEmitter/eventEmitter'
import { KeystoreController } from '../keystore/keystore'
import { NetworksController } from '../networks/networks'
// eslint-disable-next-line import/no-cycle
import { PortfolioController } from '../portfolio/portfolio'
import { ProvidersController } from '../providers/providers'
import { StorageController } from '../storage/storage'

export const DEFAULT_SELECTED_ACCOUNT_PORTFOLIO = {
  tokens: [],
  collections: [],
  tokenAmounts: [],
  totalBalance: 0,
  balancePerNetwork: {},
  isReadyToVisualize: false,
  isAllReady: false,
  networkSimulatedAccountOp: {},
  latest: {},
  pending: {}
}

export class SelectedAccountController extends EventEmitter {
  #storage: StorageController

  #accounts: AccountsController

  #portfolio: PortfolioController | null = null

  #defiPositions: DefiPositionsController | null = null

  #networks: NetworksController | null = null

  #keystore: KeystoreController | null = null

  #providers: ProvidersController | null = null

  account: Account | null = null

  /**
   * Holds the selected account portfolio that is used by the UI to display the portfolio.
   * It includes the portfolio and defi positions for the selected account.
   * It is updated when the portfolio or defi positions controllers are updated.
   */
  portfolio: SelectedAccountPortfolio = DEFAULT_SELECTED_ACCOUNT_PORTFOLIO

  /**
   * Holds the selected account portfolio divided by networks. It includes the portfolio
   * and defi positions for each network. It's used when calculating the portfolio
   * for the UI - unnecessary calculations are avoided by using data stored here
   * in case it doesn't have to be recalculated.
   */
  #portfolioByNetworks: SelectedAccountPortfolioByNetworks = {}

  portfolioStartedLoadingAtTimestamp: number | null = null

  #isPortfolioLoadingFromScratch = true

  dashboardNetworkFilter: bigint | string | null = null

  #shouldDebounceFlags: { [key: string]: boolean } = {}

  #portfolioErrors: SelectedAccountBalanceError[] = []

  #defiPositionsErrors: SelectedAccountBalanceError[] = []

  isReady: boolean = false

  areControllersInitialized: boolean = false

  // Holds the initial load promise, so that one can wait until it completes
  initialLoadPromise: Promise<void>

  #cashbackStatusByAccount: CashbackStatusByAccount = {}

  dismissedBannerIds: { [key: string]: string[] } = {}

  #_defiPositions: PositionsByProvider[] = []

  set defiPositions(val: PositionsByProvider[]) {
    this.#_defiPositions = val
  }

  // @TODO: Get rid of this and get ambire's staked wallet position from cena, like all other positions
  // Currently, if you hide the stkWallet token, its balance will be deducted from the total balance,
  // unlike other positions (which isn't desired).
  get defiPositions() {
    const stkWalletToken = this.portfolio.tokens.find(
      (t) =>
        t.chainId === 1n &&
        t.address === '0xE575cC6EC0B5d176127ac61aD2D3d9d19d1aa4a0' &&
        !t.flags.rewardsType
    )
    const ambireStakedWalletDefiPosition = getStakedWalletPositions(stkWalletToken)

    if (ambireStakedWalletDefiPosition) {
      return [ambireStakedWalletDefiPosition, ...this.#_defiPositions]
    }

    return this.#_defiPositions
  }

  constructor({
    storage,
    accounts,
    keystore
  }: {
    storage: StorageController
    accounts: AccountsController
    keystore: KeystoreController
  }) {
    super()

    this.#storage = storage
    this.#accounts = accounts
    this.#keystore = keystore

    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this.initialLoadPromise = this.#load()
  }

  async #load() {
    await this.#accounts.initialLoadPromise

    const [selectedAccountAddress, cashbackStatusByAccount, selectedAccountDismissedBannerIds] =
      await Promise.all([
        this.#storage.get('selectedAccount', null),
        this.#storage.get('cashbackStatusByAccount', {}),
        this.#storage.get('selectedAccountDismissedBannerIds', [])
      ])
    this.#cashbackStatusByAccount = cashbackStatusByAccount
    this.dismissedBannerIds = selectedAccountDismissedBannerIds
    this.account = this.#accounts.accounts.find((a) => a.addr === selectedAccountAddress) || null
    this.isReady = true

    this.emitUpdate()
  }

  initControllers({
    portfolio,
    defiPositions,
    networks,
    providers
  }: {
    portfolio: PortfolioController
    defiPositions: DefiPositionsController
    networks: NetworksController
    providers: ProvidersController
  }) {
    this.#portfolio = portfolio
    this.#defiPositions = defiPositions
    this.#networks = networks
    this.#providers = providers

    this.updateSelectedAccountPortfolio(true)
    this.#updatePortfolioErrors(true)
    this.#updateSelectedAccountDefiPositions(true)
    this.#updateDefiPositionsErrors(true)

    this.#portfolio.onUpdate(async () => {
      this.#debounceFunctionCallsOnSameTick('updateSelectedAccountPortfolio', () => {
        this.updateSelectedAccountPortfolio()
      })
    }, 'selectedAccount')

    this.#defiPositions.onUpdate(() => {
      this.#debounceFunctionCallsOnSameTick('updateSelectedAccountDefiPositions', () => {
        this.#updateSelectedAccountDefiPositions()

        if (!this.#areDefiPositionsLoading) {
          this.#debounceFunctionCallsOnSameTick('updateSelectedAccountPortfolio', () => {
            this.updateSelectedAccountPortfolio(true)
          })
          this.#updateDefiPositionsErrors()
        }
      })
    })

    this.#providers.onUpdate(() => {
      this.#debounceFunctionCallsOnSameTick('updateDefiPositionsErrors', () => {
        this.#updatePortfolioErrors(true)
        this.#updateDefiPositionsErrors()
      })
    })

    this.#networks.onUpdate(() => {
      this.#debounceFunctionCallsOnSameTick('resetDashboardNetworkFilterIfNeeded', () => {
        if (!this.dashboardNetworkFilter) return
        const dashboardFilteredNetwork = this.#networks!.networks.find(
          (n) => n.chainId === this.dashboardNetworkFilter
        )

        // reset the dashboardNetworkFilter if the network is removed
        if (!dashboardFilteredNetwork) this.setDashboardNetworkFilter(null)
      })
    })

    this.#accounts.onUpdate(() => {
      this.#debounceFunctionCallsOnSameTick('updateSelectedAccount', () => {
        this.#updateSelectedAccount()
        this.#updatePortfolioErrors(true)
        this.#updateDefiPositionsErrors()
      })
    })

    this.areControllersInitialized = true

    this.emitUpdate()
  }

  async setAccount(account: Account | null) {
    this.account = account
    this.#portfolioErrors = []
    this.#defiPositionsErrors = []
    this.defiPositions = []
    this.#portfolioByNetworks = {}
    this.resetSelectedAccountPortfolio({ skipUpdate: true })
    this.dashboardNetworkFilter = null
    this.portfolioStartedLoadingAtTimestamp = null

    if (!account) {
      await this.#storage.remove('selectedAccount')
    } else {
      await this.#storage.set('selectedAccount', account.addr)
    }

    this.emitUpdate()
  }

  #updateSelectedAccount() {
    if (!this.account) return

    const updatedAccount = this.#accounts.accounts.find((a) => a.addr === this.account!.addr)
    if (!updatedAccount) return

    this.account = updatedAccount

    this.emitUpdate()
  }

  resetSelectedAccountPortfolio({
    maxDataAgeMs,
    skipUpdate
  }: { maxDataAgeMs?: number; skipUpdate?: boolean } = {}) {
    if (!this.#portfolio || !this.account) return

    if (maxDataAgeMs) {
      const latestStateSelectedAccount = this.#portfolio.getLatestPortfolioState(this.account.addr)

      const networksThatAreAboutToBeUpdated = Object.values(latestStateSelectedAccount)
        .filter((state) => !state?.criticalError)
        .filter((state) => {
          const updateStarted = state?.result?.updateStarted || 0

          return !!updateStarted && Date.now() - updateStarted >= maxDataAgeMs
        })

      if (!networksThatAreAboutToBeUpdated.length) return
    }

    this.portfolio = DEFAULT_SELECTED_ACCOUNT_PORTFOLIO
    this.#portfolioErrors = []
    this.#isPortfolioLoadingFromScratch = true
    this.#portfolioByNetworks = {}

    if (!skipUpdate) {
      this.emitUpdate()
    }
  }

  updateSelectedAccountPortfolio(skipUpdate?: boolean) {
    if (!this.#portfolio || !this.#defiPositions || !this.account) return

    const defiPositionsAccountState = this.#defiPositions.getDefiPositionsState(this.account.addr)

    const latestStateSelectedAccount = structuredClone(
      this.#portfolio.getLatestPortfolioState(this.account.addr)
    )
    const pendingStateSelectedAccount = structuredClone(
      this.#portfolio.getPendingPortfolioState(this.account.addr)
    )

    const {
      selectedAccountPortfolio: newSelectedAccountPortfolio,
      selectedAccountPortfolioByNetworks: newSelectedAccountPortfolioByNetworks
    } = calculateSelectedAccountPortfolio(
      latestStateSelectedAccount,
      pendingStateSelectedAccount,
      structuredClone(this.#portfolioByNetworks),
      this.portfolioStartedLoadingAtTimestamp,
      defiPositionsAccountState,
      this.#isPortfolioLoadingFromScratch
    )

    // Reset the loading timestamp if the portfolio is ready
    if (this.portfolioStartedLoadingAtTimestamp && newSelectedAccountPortfolio.isAllReady) {
      this.portfolioStartedLoadingAtTimestamp = null
    }

    // Set the loading timestamp when the portfolio starts loading
    if (!this.portfolioStartedLoadingAtTimestamp && !newSelectedAccountPortfolio.isAllReady) {
      this.portfolioStartedLoadingAtTimestamp = Date.now()
    }

    // Reset isPortfolioLoadingFromScratch flag when the portfolio has finished the initial load
    if (this.#isPortfolioLoadingFromScratch && newSelectedAccountPortfolio.isAllReady) {
      this.#isPortfolioLoadingFromScratch = false
    }

    this.portfolio = newSelectedAccountPortfolio
    this.#portfolioByNetworks = newSelectedAccountPortfolioByNetworks
    this.#updatePortfolioErrors(true)
    this.updateCashbackStatus(skipUpdate)

    if (!skipUpdate) {
      this.emitUpdate()
    }
  }

  async updateCashbackStatus(skipUpdate?: boolean) {
    if (!this.#portfolio || !this.account || !this.portfolio.latest.gasTank?.result) return
    const importedAccountKeys = this.#keystore?.getAccountKeys(this.account) || []

    // Don't update cashback status for view-only accounts
    if (getIsViewOnly(importedAccountKeys, this.account.associatedKeys)) return

    const accountId = this.account.addr
    const gasTankResult = this.portfolio.latest.gasTank.result as PortfolioGasTankResult

    const isCashbackZero = gasTankResult.gasTankTokens?.[0]?.cashback === 0n
    const cashbackWasZeroBefore = this.#cashbackStatusByAccount[accountId] === 'no-cashback'
    const notReceivedFirstCashbackBefore =
      this.#cashbackStatusByAccount[accountId] !== 'unseen-cashback'

    if (isCashbackZero) {
      await this.changeCashbackStatus('no-cashback', skipUpdate)
    } else if (!isCashbackZero && cashbackWasZeroBefore && notReceivedFirstCashbackBefore) {
      await this.changeCashbackStatus('unseen-cashback', skipUpdate)
    }
  }

  async changeCashbackStatus(newStatus: CashbackStatus, skipUpdate?: boolean) {
    if (!this.account) return

    const accountId = this.account.addr

    this.#cashbackStatusByAccount = {
      ...this.#cashbackStatusByAccount,
      [accountId]: newStatus
    }

    await this.#storage.set('cashbackStatusByAccount', this.#cashbackStatusByAccount)

    if (!skipUpdate) {
      this.emitUpdate()
    }
  }

  get #areDefiPositionsLoading() {
    if (!this.account || !this.#defiPositions) return false

    const defiPositionsAccountState = this.#defiPositions.getDefiPositionsState(this.account.addr)
    return (
      !Object.keys(defiPositionsAccountState).length ||
      Object.values(defiPositionsAccountState).some((n) => n.isLoading)
    )
  }

  #updateSelectedAccountDefiPositions(skipUpdate?: boolean) {
    if (!this.#defiPositions || !this.account) return

    const defiPositionsAccountState = this.#defiPositions.getDefiPositionsState(this.account.addr)

    const positionsByProvider = Object.values(defiPositionsAccountState).flatMap(
      (n) => n.positionsByProvider
    )

    const positionsByProviderWithSortedAssets = positionsByProvider.map((provider) => {
      const positions = provider.positions
        .map((position) => {
          const assets = position.assets
            .filter(Boolean)
            .sort((a, b) => sortByValue(a.value, b.value))

          return { ...position, assets }
        })
        .sort((a, b) => sortByValue(a.additionalData.positionInUSD, b.additionalData.positionInUSD))

      return { ...provider, positions }
    })

    const sortedPositionsByProvider = positionsByProviderWithSortedAssets.sort((a, b) =>
      sortByValue(a.positionInUSD, b.positionInUSD)
    )

    this.defiPositions = sortedPositionsByProvider

    if (!skipUpdate) {
      this.emitUpdate()
    }
  }

  #debounceFunctionCallsOnSameTick(funcName: string, func: () => void) {
    if (this.#shouldDebounceFlags[funcName]) return
    this.#shouldDebounceFlags[funcName] = true

    // Debounce multiple calls in the same tick and only execute one of them
    setTimeout(() => {
      this.#shouldDebounceFlags[funcName] = false
      try {
        func()
      } catch (error: any) {
        this.emitError({
          level: 'minor',
          message: `The execution of ${funcName} in SelectedAccountController failed`,
          error
        })
      }
    }, 0)
  }

  #updateDefiPositionsErrors(skipUpdate?: boolean) {
    if (
      !this.account ||
      !this.#networks ||
      !this.#providers ||
      !this.#defiPositions ||
      this.#areDefiPositionsLoading
    ) {
      this.#defiPositionsErrors = []
      if (!skipUpdate) {
        this.emitUpdate()
      }
      return
    }

    const defiPositionsAccountState = this.#defiPositions.getDefiPositionsState(this.account.addr)

    const errorBanners = getNetworksWithDeFiPositionsErrorErrors({
      networks: this.#networks.networks,
      currentAccountState: defiPositionsAccountState,
      providers: this.#providers.providers,
      networksWithPositions: this.#defiPositions.getNetworksWithPositions(this.account.addr)
    })

    this.#defiPositionsErrors = errorBanners

    if (!skipUpdate) {
      this.emitUpdate()
    }
  }

  #updatePortfolioErrors(skipUpdate?: boolean) {
    if (
      !this.account ||
      !this.#networks ||
      !this.#providers ||
      !this.#portfolio ||
      !this.portfolio.isReadyToVisualize
    ) {
      this.#portfolioErrors = []
      if (!skipUpdate) {
        this.emitUpdate()
      }
      return
    }

    const networksWithFailedRPCBanners = getNetworksWithFailedRPCErrors({
      providers: this.#providers.providers,
      networks: this.#networks.networks,
      networksWithAssets: this.#portfolio.getNetworksWithAssets(this.account.addr)
    })

    const errorBanners = getNetworksWithPortfolioErrorErrors({
      networks: this.#networks.networks,
      selectedAccountLatest: this.portfolio.latest,
      isAllReady: this.portfolio.isAllReady,
      providers: this.#providers.providers
    })

    this.#portfolioErrors = [...networksWithFailedRPCBanners, ...errorBanners]

    if (!skipUpdate) {
      this.emitUpdate()
    }
  }

  get balanceAffectingErrors() {
    return [...this.#portfolioErrors, ...this.#defiPositionsErrors]
  }

  get deprecatedSmartAccountBanner(): Banner[] {
    if (!this.account || !isSmartAccount(this.account)) return []

    if (
      !this.#accounts.accountStates[this.account.addr] ||
      !this.#accounts.accountStates[this.account.addr]['1'] ||
      !this.#accounts.accountStates[this.account.addr]['1'].isV2
    )
      return []

    if (
      !this.account.creation ||
      getAddress(this.account.creation.factoryAddr) === AMBIRE_ACCOUNT_FACTORY
    )
      return []

    return [
      {
        id: 'old-account',
        meta: {
          accountAddr: this.account.addr
        },
        type: 'warning',
        category: 'old-account',
        title: 'Old Ambire Account',
        text: "The account you are using is an old Ambire Account that was intended for testing the extension only. Fee options aren't available on custom networks. It won't be supported in the future. Please migrate to another by creating a new smart account in the extension or contact the team for support",
        actions: []
      }
    ]
  }

  get firstCashbackBanner(): Banner[] {
    if (!this.account || !isSmartAccount(this.account) || !this.#portfolio) return []

    return getFirstCashbackBanners({
      selectedAccountAddr: this.account.addr,
      cashbackStatusByAccount: this.#cashbackStatusByAccount
    })
  }

  get cashbackStatus(): CashbackStatus | undefined {
    if (!this.account) return undefined

    return this.#cashbackStatusByAccount[this.account.addr]
  }

  setDashboardNetworkFilter(networkFilter: bigint | string | null) {
    this.dashboardNetworkFilter = networkFilter
    this.emitUpdate()
  }

  async dismissDefiPositionsBannerForTheSelectedAccount() {
    if (!this.account) return

    const defiBanner = this.banners.find((b) => b.id === defiPositionsOnDisabledNetworksBannerId)
    if (!defiBanner) return

    const action = defiBanner.actions.find((a) => a.actionName === 'enable-networks')
    if (!action) return

    if (!this.dismissedBannerIds[defiPositionsOnDisabledNetworksBannerId])
      this.dismissedBannerIds[defiPositionsOnDisabledNetworksBannerId] = []

    action.meta.networkChainIds.forEach((chainId) => {
      if (
        this.dismissedBannerIds[defiPositionsOnDisabledNetworksBannerId].includes(
          `${this.account!.addr}-${chainId}`
        )
      )
        return
      this.dismissedBannerIds[defiPositionsOnDisabledNetworksBannerId].push(
        `${this.account!.addr}-${chainId}`
      )
    })

    await this.#storage.set('selectedAccountDismissedBannerIds', this.dismissedBannerIds)
    this.emitUpdate()
  }

  // ! IMPORTANT !
  // Banners that depend on async data from sub-controllers should be implemented
  // in the sub-controllers themselves. This is because updates in the sub-controllers
  // will not trigger emitUpdate in the MainController, therefore the banners will
  // remain the same until a subsequent update in the MainController.
  get banners(): Banner[] {
    if (
      !this.account ||
      !this.#networks ||
      !this.#networks.isInitialized ||
      !this.#defiPositions ||
      !this.portfolio.isAllReady
    )
      return []

    const defiPositionsAccountState = this.#defiPositions.getDefiPositionsStateForAllNetworks(
      this.account.addr
    )

    const notDismissedNetworks = this.dismissedBannerIds[defiPositionsOnDisabledNetworksBannerId]
      ? this.#networks.allNetworks.filter(
          (n) =>
            !this.dismissedBannerIds[defiPositionsOnDisabledNetworksBannerId].includes(
              `${this.account!.addr}-${n.chainId}`
            )
        )
      : this.#networks.allNetworks
    return getDefiPositionsOnDisabledNetworksForTheSelectedAccount({
      defiPositionsAccountState,
      networks: notDismissedNetworks
    })
  }

  toJSON() {
    return {
      ...this,
      ...super.toJSON(),
      banners: this.banners,
      firstCashbackBanner: this.firstCashbackBanner,
      cashbackStatus: this.cashbackStatus,
      deprecatedSmartAccountBanner: this.deprecatedSmartAccountBanner,
      balanceAffectingErrors: this.balanceAffectingErrors,
      defiPositions: this.defiPositions
    }
  }
}

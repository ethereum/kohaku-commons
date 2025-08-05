/* eslint-disable @typescript-eslint/brace-style */
import { ethErrors } from 'eth-rpc-errors'
import { getAddress } from 'ethers'

import AmbireAccount7702 from '../../../contracts/compiled/AmbireAccount7702.json'
import EmittableError from '../../classes/EmittableError'
import { Session } from '../../classes/session'
import { AMBIRE_ACCOUNT_FACTORY, SINGLETON } from '../../consts/deploy'
import {
  BIP44_LEDGER_DERIVATION_TEMPLATE,
  BIP44_STANDARD_DERIVATION_TEMPLATE
} from '../../consts/derivation'
import humanizerInfo from '../../consts/humanizer/humanizerInfo.json'
import { Account, AccountOnchainState } from '../../interfaces/account'
import { Fetch } from '../../interfaces/fetch'
import { Hex } from '../../interfaces/hex'
import { ExternalSignerControllers, Key, KeystoreSignerType } from '../../interfaces/keystore'
import { AddNetworkRequestParams, Network } from '../../interfaces/network'
import { NotificationManager } from '../../interfaces/notification'
import { Platform } from '../../interfaces/platform'
import { RPCProvider } from '../../interfaces/provider'
import { TraceCallDiscoveryStatus } from '../../interfaces/signAccountOp'
import { Storage } from '../../interfaces/storage'
import { SwapAndBridgeActiveRoute } from '../../interfaces/swapAndBridge'
import { Calls, SignUserRequest, UserRequest } from '../../interfaces/userRequest'
import { WindowManager } from '../../interfaces/window'
import { getDefaultSelectedAccount, isBasicAccount } from '../../libs/account/account'
import { getBaseAccount } from '../../libs/account/getBaseAccount'
import { AccountOp, getSignableCalls } from '../../libs/accountOp/accountOp'
import {
  AccountOpIdentifiedBy,
  getDappIdentifier,
  SubmittedAccountOp
} from '../../libs/accountOp/submittedAccountOp'
import { AccountOpStatus, Call } from '../../libs/accountOp/types'
import { getAccountOpFromAction } from '../../libs/actions/actions'
import { BROADCAST_OPTIONS, buildRawTransaction } from '../../libs/broadcast/broadcast'
import { getHumanReadableBroadcastError } from '../../libs/errorHumanizer'
import { insufficientPaymasterFunds } from '../../libs/errorHumanizer/errors'
/* eslint-disable no-await-in-loop */
import { HumanizerMeta } from '../../libs/humanizer/interfaces'
import { getAccountOpsForSimulation } from '../../libs/main/main'
import { relayerAdditionalNetworks } from '../../libs/networks/networks'
import { relayerCall } from '../../libs/relayerCall/relayerCall'
import { makeAccountOpAction } from '../../libs/requests/requests'
import { isNetworkReady } from '../../libs/selectedAccount/selectedAccount'
import { debugTraceCall } from '../../libs/tracer/debugTraceCall'
/* eslint-disable no-underscore-dangle */
import { LiFiAPI } from '../../services/lifi/api'
import { paymasterFactory } from '../../services/paymaster'
import { failedPaymasters } from '../../services/paymaster/FailedPaymasters'
import { getHdPathFromTemplate } from '../../utils/hdPath'
import shortenAddress from '../../utils/shortenAddress'
import { generateUuid } from '../../utils/uuid'
import wait from '../../utils/wait'
import { AccountPickerController } from '../accountPicker/accountPicker'
import { AccountsController } from '../accounts/accounts'
import { AccountOpAction } from '../actions/actions'
import { ActivityController } from '../activity/activity'
import { AddressBookController } from '../addressBook/addressBook'
import { BannerController } from '../banner/banner'
import { DappsController } from '../dapps/dapps'
import { DefiPositionsController } from '../defiPositions/defiPositions'
import { DomainsController } from '../domains/domains'
import { EmailVaultController } from '../emailVault/emailVault'
import { EstimationStatus } from '../estimation/types'
import EventEmitter, { ErrorRef, Statuses } from '../eventEmitter/eventEmitter'
import { FeatureFlagsController } from '../featureFlags/featureFlags'
import { InviteController } from '../invite/invite'
import { KeystoreController } from '../keystore/keystore'
import { NetworksController } from '../networks/networks'
import { PhishingController } from '../phishing/phishing'
import { PortfolioController } from '../portfolio/portfolio'
import { ProvidersController } from '../providers/providers'
import { RequestsController } from '../requests/requests'
import { SelectedAccountController } from '../selectedAccount/selectedAccount'
import {
  SIGN_ACCOUNT_OP_MAIN,
  SIGN_ACCOUNT_OP_SWAP,
  SIGN_ACCOUNT_OP_TRANSFER,
  SignAccountOpType
} from '../signAccountOp/helper'
import { SignAccountOpController, SigningStatus } from '../signAccountOp/signAccountOp'
import { SignMessageController } from '../signMessage/signMessage'
import { StorageController } from '../storage/storage'
import { SwapAndBridgeController } from '../swapAndBridge/swapAndBridge'
import { TransferController } from '../transfer/transfer'
import { PrivacyController } from '../privacy/privacy'

const STATUS_WRAPPED_METHODS = {
  removeAccount: 'INITIAL',
  handleAccountPickerInitLedger: 'INITIAL',
  handleAccountPickerInitTrezor: 'INITIAL',
  handleAccountPickerInitLattice: 'INITIAL',
  importSmartAccountFromDefaultSeed: 'INITIAL',
  selectAccount: 'INITIAL',
  signAndBroadcastAccountOp: 'INITIAL'
} as const

type CustomStatuses = {
  signAndBroadcastAccountOp: 'INITIAL' | 'SIGNING' | 'BROADCASTING' | 'SUCCESS' | 'ERROR'
}

export class MainController extends EventEmitter {
  #storageAPI: Storage

  storage: StorageController

  fetch: Fetch

  // Holds the initial load promise, so that one can wait until it completes
  #initialLoadPromise: Promise<void>

  callRelayer: Function

  isReady: boolean = false

  featureFlags: FeatureFlagsController

  invite: InviteController

  keystore: KeystoreController

  /**
   * Hardware wallets (usually) need an additional (external signer) controller,
   * that is app-specific (web, mobile) and is used to interact with the device.
   * (example: LedgerController, TrezorController, LatticeController)
   */
  #externalSignerControllers: ExternalSignerControllers = {}

  // Subcontrollers
  networks: NetworksController

  providers: ProvidersController

  accountPicker: AccountPickerController

  portfolio: PortfolioController

  defiPositions: DefiPositionsController

  dapps: DappsController

  phishing: PhishingController

  // Public sub-structures
  // @TODO emailVaults
  emailVault: EmailVaultController

  signMessage: SignMessageController

  swapAndBridge: SwapAndBridgeController

  transfer: TransferController

  privacy: PrivacyController

  signAccountOp: SignAccountOpController | null = null

  signAccOpInitError: string | null = null

  activity: ActivityController

  addressBook: AddressBookController

  domains: DomainsController

  accounts: AccountsController

  selectedAccount: SelectedAccountController

  requests: RequestsController

  banner: BannerController

  accountOpsToBeConfirmed: { [key: string]: { [key: string]: AccountOp } } = {}

  // TODO: Temporary solution to expose the fee payer key during Account Op broadcast.
  feePayerKey: Key | null = null

  lastUpdate: Date = new Date()

  isOffline: boolean = false

  statuses: Statuses<keyof typeof STATUS_WRAPPED_METHODS> & CustomStatuses = STATUS_WRAPPED_METHODS

  onPopupOpenStatus: 'LOADING' | 'INITIAL' | 'SUCCESS' = 'INITIAL'

  #windowManager: WindowManager

  #notificationManager: NotificationManager

  #signAccountOpSigningPromise?: Promise<AccountOp | void | null>

  #traceCallTimeoutId: ReturnType<typeof setTimeout> | null = null

  /**
   * Tracks broadcast request IDs to abort stale requests.
   * Prevents rejected hardware wallet signatures from affecting new requests
   * when a user closes an action window and starts a new one.
   */
  #signAndBroadcastCallId: string | null = null

  constructor({
    platform,
    storageAPI,
    fetch,
    relayerUrl,
    velcroUrl,
    swapApiKey,
    keystoreSigners,
    externalSignerControllers,
    windowManager,
    notificationManager
  }: {
    platform: Platform
    storageAPI: Storage
    fetch: Fetch
    relayerUrl: string
    velcroUrl: string
    swapApiKey: string
    keystoreSigners: Partial<{ [key in Key['type']]: KeystoreSignerType }>
    externalSignerControllers: ExternalSignerControllers
    windowManager: WindowManager
    notificationManager: NotificationManager
  }) {
    super()
    this.#storageAPI = storageAPI
    this.fetch = fetch
    this.#windowManager = windowManager
    this.#notificationManager = notificationManager

    this.storage = new StorageController(this.#storageAPI)
    this.invite = new InviteController({ relayerUrl, fetch, storage: this.storage })
    this.keystore = new KeystoreController(platform, this.storage, keystoreSigners, windowManager)
    this.#externalSignerControllers = externalSignerControllers
    this.networks = new NetworksController({
      storage: this.storage,
      fetch,
      relayerUrl,
      onAddOrUpdateNetworks: async (networks: Network[]) => {
        networks.forEach((n) => n.disabled && this.removeNetworkData(n.chainId))
        networks.filter((net) => !net.disabled).forEach((n) => this.providers.setProvider(n))
        await this.reloadSelectedAccount({
          chainIds: networks.map((n) => n.chainId),
          forceUpdate: false
        })
      },
      onRemoveNetwork: (chainId: bigint) => {
        this.providers.removeProvider(chainId)
      }
    })
    this.featureFlags = new FeatureFlagsController(this.networks)
    this.providers = new ProvidersController(this.networks)
    this.accounts = new AccountsController(
      this.storage,
      this.providers,
      this.networks,
      this.keystore,
      async (accounts) => {
        const defaultSelectedAccount = getDefaultSelectedAccount(accounts)
        if (defaultSelectedAccount) {
          await this.#selectAccount(defaultSelectedAccount.addr)
        }
      },
      this.providers.updateProviderIsWorking.bind(this.providers),
      this.#updateIsOffline.bind(this)
    )
    this.selectedAccount = new SelectedAccountController({
      storage: this.storage,
      accounts: this.accounts
    })
    this.banner = new BannerController(this.storage)
    this.portfolio = new PortfolioController(
      this.storage,
      this.fetch,
      this.providers,
      this.networks,
      this.accounts,
      this.keystore,
      relayerUrl,
      velcroUrl,
      this.banner
    )
    this.defiPositions = new DefiPositionsController({
      fetch: this.fetch,
      storage: this.storage,
      selectedAccount: this.selectedAccount,
      keystore: this.keystore,
      accounts: this.accounts,
      networks: this.networks,
      providers: this.providers
    })
    this.emailVault = new EmailVaultController(this.storage, this.fetch, relayerUrl, this.keystore)
    this.accountPicker = new AccountPickerController({
      accounts: this.accounts,
      keystore: this.keystore,
      networks: this.networks,
      providers: this.providers,
      externalSignerControllers: this.#externalSignerControllers,
      relayerUrl,
      fetch: this.fetch,
      /**
       * callback that gets triggered as a finalization step of adding new
       * accounts via the AccountPickerController.
       *
       * VIEW-ONLY ACCOUNTS: In case of changes in this method, make sure these
       * changes are reflected for view-only accounts as well. Because the
       * view-only accounts import flow bypasses the AccountPicker, this method
       * won't click for them. Their on add success flow continues in the
       * MAIN_CONTROLLER_ADD_VIEW_ONLY_ACCOUNTS action case.
       */
      onAddAccountsSuccessCallback: this.#onAccountPickerSuccess.bind(this)
    })
    this.addressBook = new AddressBookController(this.storage, this.accounts, this.selectedAccount)
    this.signMessage = new SignMessageController(
      this.keystore,
      this.providers,
      this.networks,
      this.accounts,
      this.#externalSignerControllers,
      this.invite
    )
    this.phishing = new PhishingController({
      fetch: this.fetch,
      storage: this.storage,
      windowManager: this.#windowManager
    })
    // const socketAPI = new SocketAPI({ apiKey: swapApiKey, fetch: this.fetch })
    const lifiAPI = new LiFiAPI({ apiKey: swapApiKey, fetch: this.fetch })
    this.dapps = new DappsController(this.storage)

    this.selectedAccount.initControllers({
      portfolio: this.portfolio,
      defiPositions: this.defiPositions,
      networks: this.networks,
      providers: this.providers
    })

    this.callRelayer = relayerCall.bind({ url: relayerUrl, fetch: this.fetch })
    this.activity = new ActivityController(
      this.storage,
      this.fetch,
      this.callRelayer,
      this.accounts,
      this.selectedAccount,
      this.providers,
      this.networks,
      this.portfolio,
      async (network: Network) => {
        await this.setContractsDeployedToTrueIfDeployed(network)
      }
    )
    this.swapAndBridge = new SwapAndBridgeController({
      accounts: this.accounts,
      keystore: this.keystore,
      portfolio: this.portfolio,
      externalSignerControllers: this.#externalSignerControllers,
      providers: this.providers,
      selectedAccount: this.selectedAccount,
      networks: this.networks,
      activity: this.activity,
      invite: this.invite,
      // TODO: This doesn't work, because the invite controller is not yet loaded at this stage
      // serviceProviderAPI: this.invite.isOG ? lifiAPI : socketAPI,
      serviceProviderAPI: lifiAPI,
      storage: this.storage,
      relayerUrl,
      portfolioUpdate: () => {
        this.updateSelectedAccountPortfolio({ forceUpdate: true })
      },
      isMainSignAccountOpThrowingAnEstimationError: (
        fromChainId: number | null,
        toChainId: number | null
      ) => {
        return (
          this.signAccountOp &&
          fromChainId &&
          toChainId &&
          this.signAccountOp.estimation.status === EstimationStatus.Error &&
          this.signAccountOp.accountOp.chainId === BigInt(fromChainId) &&
          fromChainId === toChainId
        )
      },
      getUserRequests: () => this.requests.userRequests || [],
      getVisibleActionsQueue: () => this.requests.actions.visibleActionsQueue || []
    })
    this.transfer = new TransferController(
      this.storage,
      humanizerInfo as HumanizerMeta,
      this.selectedAccount,
      this.networks,
      this.addressBook,
      this.accounts,
      this.keystore,
      this.portfolio,
      this.activity,
      this.#externalSignerControllers,
      this.providers,
      relayerUrl
    )

    this.privacy = new PrivacyController()

    this.domains = new DomainsController(
      this.providers.providers,
      this.networks.defaultNetworksMode
    )
    this.requests = new RequestsController({
      relayerUrl,
      accounts: this.accounts,
      networks: this.networks,
      providers: this.providers,
      selectedAccount: this.selectedAccount,
      keystore: this.keystore,
      dapps: this.dapps,
      transfer: this.transfer,
      swapAndBridge: this.swapAndBridge,
      windowManager: this.#windowManager,
      notificationManager: this.#notificationManager,
      getSignAccountOp: () => this.signAccountOp,
      updateSignAccountOp: (props) => {
        if (!this.signAccountOp) return
        this.signAccountOp.update(props)
      },
      destroySignAccountOp: this.destroySignAccOp.bind(this),
      updateSelectedAccountPortfolio: async (networks) => {
        await this.updateSelectedAccountPortfolio({ forceUpdate: true, networks })
      },
      addTokensToBeLearned: this.portfolio.addTokensToBeLearned.bind(this.portfolio),
      guardHWSigning: this.#guardHWSigning.bind(this)
    })
    this.#initialLoadPromise = this.#load()
    paymasterFactory.init(relayerUrl, fetch, (e: ErrorRef) => {
      if (!this.signAccountOp) return
      this.emitError(e)
    })

    this.keystore.onUpdate(() => {
      if (this.keystore.statuses.unlockWithSecret === 'SUCCESS') {
        this.storage.associateAccountKeysWithLegacySavedSeedMigration(
          new AccountPickerController({
            accounts: this.accounts,
            keystore: this.keystore,
            networks: this.networks,
            providers: this.providers,
            externalSignerControllers: this.#externalSignerControllers,
            relayerUrl,
            fetch: this.fetch,
            onAddAccountsSuccessCallback: async () => {}
          }),
          this.keystore,
          async () => {
            await this.keystore.updateKeystoreKeys()
          }
        )
      }
    })
  }

  /**
   * - Updates the selected account's account state, portfolio and defi positions
   * - Calls batchReverseLookup for all accounts
   *
   * It's not a problem to call it many times consecutively as all methods have internal
   * caching mechanisms to prevent unnecessary calls.
   */
  async onPopupOpen() {
    const selectedAccountAddr = this.selectedAccount.account?.addr

    this.onPopupOpenStatus = 'LOADING'
    await this.forceEmitUpdate()

    if (selectedAccountAddr) {
      const FIVE_MINUTES = 1000 * 60 * 5
      this.domains.batchReverseLookup(this.accounts.accounts.map((a) => a.addr))
      if (!this.activity.broadcastedButNotConfirmed.length) {
        this.selectedAccount.resetSelectedAccountPortfolio({ maxDataAgeMs: FIVE_MINUTES })
        this.updateSelectedAccountPortfolio({ maxDataAgeMs: FIVE_MINUTES })
        this.defiPositions.updatePositions({ maxDataAgeMs: FIVE_MINUTES })
      }

      if (!this.accounts.areAccountStatesLoading) {
        this.accounts.updateAccountState(selectedAccountAddr)
      }
    }

    this.onPopupOpenStatus = 'SUCCESS'
    await this.forceEmitUpdate()

    this.onPopupOpenStatus = 'INITIAL'
    await this.forceEmitUpdate()
  }

  async #load(): Promise<void> {
    this.isReady = false
    // #load is called in the constructor which is synchronous
    // we await (1 ms/next tick) for the constructor to extend the EventEmitter class
    // and then we call it's methods
    await wait(1)
    this.emitUpdate()
    await this.networks.initialLoadPromise
    await this.providers.initialLoadPromise
    await this.accounts.initialLoadPromise
    await this.selectedAccount.initialLoadPromise

    this.defiPositions.updatePositions()
    this.updateSelectedAccountPortfolio()
    this.domains.batchReverseLookup(this.accounts.accounts.map((a) => a.addr))

    this.isReady = true
    this.emitUpdate()
  }

  lock() {
    this.keystore.lock()
    this.emailVault.cleanMagicAndSessionKeys()
    this.selectedAccount.setDashboardNetworkFilter(null)
  }

  async selectAccount(toAccountAddr: string) {
    await this.withStatus('selectAccount', async () => this.#selectAccount(toAccountAddr), true)
  }

  async #selectAccount(toAccountAddr: string | null) {
    await this.#initialLoadPromise
    if (!toAccountAddr) {
      await this.selectedAccount.setAccount(null)

      this.emitUpdate()
      return
    }

    const accountToSelect = this.accounts.accounts.find((acc) => acc.addr === toAccountAddr)
    if (!accountToSelect) {
      console.error(`Account with address ${toAccountAddr} does not exist`)
      return
    }

    this.isOffline = false
    // call closeActionWindow while still on the currently selected account to allow proper
    // state cleanup of the controllers like actionsCtrl, signAccountOpCtrl, signMessageCtrl...
    if (this.requests.actions?.currentAction?.type !== 'switchAccount') {
      await this.requests.actions.closeActionWindow()
    }
    const swapAndBridgeSigningAction = this.requests.actions.visibleActionsQueue.find(
      ({ type }) => type === 'swapAndBridge'
    )
    if (swapAndBridgeSigningAction) {
      await this.requests.actions.removeActions([swapAndBridgeSigningAction.id])
    }
    await this.selectedAccount.setAccount(accountToSelect)
    this.swapAndBridge.reset()
    this.transfer.resetForm()
    await this.dapps.broadcastDappSessionEvent('accountsChanged', [toAccountAddr])
    // forceEmitUpdate to update the getters in the FE state of the ctrl
    await this.forceEmitUpdate()
    await this.requests.actions.forceEmitUpdate()
    await this.addressBook.forceEmitUpdate()
    await this.activity.forceEmitUpdate()
    // Don't await these as they are not critical for the account selection
    // and if the user decides to quickly change to another account withStatus
    // will block the UI until these are resolved.
    this.reloadSelectedAccount({ forceUpdate: false })
    this.emitUpdate()
  }

  async #onAccountPickerSuccess() {
    // Add accounts first, because some of the next steps have validation
    // if accounts exists.
    if (this.accountPicker.readyToRemoveAccounts) {
      // eslint-disable-next-line no-restricted-syntax
      for (const acc of this.accountPicker.readyToRemoveAccounts) {
        await this.#removeAccount(acc.addr)
      }
    }

    await this.accounts.addAccounts(this.accountPicker.readyToAddAccounts)

    if (this.keystore.isKeyIteratorInitializedWithTempSeed(this.accountPicker.keyIterator)) {
      await this.keystore.persistTempSeed()
    }

    const storedSeed = await this.keystore.getKeystoreSeed(this.accountPicker.keyIterator)

    if (storedSeed) {
      this.keystore.updateSeed({
        id: storedSeed.id,
        hdPathTemplate: this.accountPicker.hdPathTemplate
      })

      this.accountPicker.readyToAddKeys.internal = this.accountPicker.readyToAddKeys.internal.map(
        (key) => ({ ...key, meta: { ...key.meta, fromSeedId: storedSeed.id } })
      )
    }
    // Then add keys, because some of the next steps could have validation
    // if keys exists. Should be separate (not combined in Promise.all,
    // since firing multiple keystore actions is not possible
    // (the #wrapKeystoreAction listens for the first one to finish and
    // skips the parallel one, if one is requested).
    await this.keystore.addKeys(this.accountPicker.readyToAddKeys.internal)
    await this.keystore.addKeysExternallyStored(this.accountPicker.readyToAddKeys.external)
  }

  initSignAccOp(actionId: AccountOpAction['id']): null | void {
    const accountOp = getAccountOpFromAction(actionId, this.requests.actions.actionsQueue)
    if (!accountOp) {
      this.signAccOpInitError =
        'We cannot initiate the signing process because no transaction has been found for the specified account and network.'
      return null
    }

    const network = this.networks.networks.find((n) => n.chainId === accountOp.chainId)

    if (
      !this.selectedAccount.account ||
      this.selectedAccount.account.addr !== accountOp.accountAddr
    ) {
      this.signAccOpInitError =
        'Attempting to initialize an accountOp for an account other than the currently selected one.'
      return null
    }

    if (!network) {
      this.signAccOpInitError =
        'We cannot initiate the signing process as we are unable to locate the specified network.'
      return null
    }

    // on init, set the accountOp nonce to the latest one we know
    // it could happen that the user inits a userRequest with an old
    // accountState and therefore caching the old nonce in the accountOp.
    // we make sure the latest nonce is set when initing signAccountOp
    const state =
      this.accounts.accountStates?.[accountOp.accountAddr]?.[accountOp.chainId.toString()]
    if (state) accountOp.nonce = state.nonce

    this.signAccOpInitError = null

    // if there's no signAccountOp OR
    // there is but there's a new actionId requested, rebuild it
    if (!this.signAccountOp || this.signAccountOp.fromActionId !== actionId) {
      this.destroySignAccOp()
      this.signAccountOp = new SignAccountOpController(
        this.accounts,
        this.networks,
        this.keystore,
        this.portfolio,
        this.activity,
        this.#externalSignerControllers,
        this.selectedAccount.account,
        network,
        this.providers.providers[network.chainId.toString()],
        actionId,
        accountOp,
        () => {
          return this.isSignRequestStillActive
        },
        true,
        (ctrl: SignAccountOpController) => {
          this.traceCall(ctrl)
        }
      )
    }

    this.forceEmitUpdate()
  }

  async handleSignAndBroadcastAccountOp(type: SignAccountOpType) {
    if (this.statuses.signAndBroadcastAccountOp !== 'INITIAL') {
      this.emitError({
        level: 'major',
        message: 'The signing process is already in progress.',
        error: new Error(
          'The signing process is already in progress. (handleSignAndBroadcastAccountOp)'
        )
      })
      return
    }

    const signAndBroadcastCallId = generateUuid()
    this.#signAndBroadcastCallId = signAndBroadcastCallId

    this.statuses.signAndBroadcastAccountOp = 'SIGNING'
    this.forceEmitUpdate()

    let signAccountOp: SignAccountOpController | null

    if (type === SIGN_ACCOUNT_OP_MAIN) {
      signAccountOp = this.signAccountOp
    } else if (type === SIGN_ACCOUNT_OP_SWAP) {
      signAccountOp = this.swapAndBridge.signAccountOpController
    } else {
      signAccountOp = this.transfer.signAccountOpController
    }

    // It's vital that everything that can throw an error is wrapped in a try/catch block
    // to prevent signAndBroadcastAccountOp from being stuck in the SIGNING state
    try {
      // if the accountOp has a swapTxn, start the route as the user is broadcasting it
      if (signAccountOp?.accountOp.meta?.swapTxn) {
        await this.swapAndBridge.addActiveRoute({
          activeRouteId: signAccountOp?.accountOp.meta?.swapTxn.activeRouteId,
          userTxIndex: signAccountOp?.accountOp.meta?.swapTxn.userTxIndex
        })
      }

      const wasAlreadySigned = signAccountOp?.status?.type === SigningStatus.Done

      if (!wasAlreadySigned) {
        if (!signAccountOp) {
          const message =
            'The signing process was not initialized as expected. Please try again later or contact Ambire support if the issue persists.'

          throw new EmittableError({ level: 'major', message })
        }

        // Reset the promise in the `finally` block to ensure it doesn't remain unresolved if an error is thrown
        this.#signAccountOpSigningPromise = signAccountOp.sign().finally(() => {
          if (this.#signAndBroadcastCallId !== signAndBroadcastCallId) return

          this.#signAccountOpSigningPromise = undefined
        })

        await this.#signAccountOpSigningPromise
      }

      if (this.#signAndBroadcastCallId !== signAndBroadcastCallId) return

      // Error handling on the prev step will notify the user, it's fine to return here
      if (signAccountOp?.status?.type !== SigningStatus.Done) {
        // remove the active route on signing failure
        if (signAccountOp?.accountOp.meta?.swapTxn) {
          this.swapAndBridge.removeActiveRoute(signAccountOp.accountOp.meta.swapTxn.activeRouteId)
        }
        this.statuses.signAndBroadcastAccountOp = 'ERROR'
        await this.forceEmitUpdate()
        this.statuses.signAndBroadcastAccountOp = 'INITIAL'
        this.#signAndBroadcastCallId = null
        await this.forceEmitUpdate()
        return
      }

      await this.#broadcastSignedAccountOp(signAccountOp, type, signAndBroadcastCallId)
      if (signAndBroadcastCallId === this.#signAndBroadcastCallId) {
        this.statuses.signAndBroadcastAccountOp = 'SUCCESS'
        await this.forceEmitUpdate()
      }
    } catch (error: any) {
      if (signAndBroadcastCallId === this.#signAndBroadcastCallId) {
        if ('message' in error && 'level' in error && 'error' in error) {
          this.emitError(error)
        } else {
          const hasSigned = signAccountOp?.status?.type === SigningStatus.Done

          this.emitError({
            level: 'major',
            message:
              error.message ||
              `Unknown error occurred while ${
                !hasSigned ? 'signing the transaction' : 'broadcasting the transaction'
              }`,
            error
          })
        }
        this.statuses.signAndBroadcastAccountOp = 'ERROR'
        await this.forceEmitUpdate()
      }
    } finally {
      if (signAndBroadcastCallId === this.#signAndBroadcastCallId) {
        this.statuses.signAndBroadcastAccountOp = 'INITIAL'
        this.#signAndBroadcastCallId = null
        await this.forceEmitUpdate()
      }
    }
  }

  async resolveDappBroadcast(
    submittedAccountOp: SubmittedAccountOp,
    dappHandlers: {
      promise: {
        session: { name: string; origin: string; icon: string }
        resolve: (data: any) => void
        reject: (data: any) => void
      }
      txnId?: string
    }[]
  ) {
    // this could take a while
    // return the txnId to the dapp once it's confirmed as return a txId
    // that could be front ran would cause bad UX on the dapp side
    const txnId = await this.activity.getConfirmedTxId(submittedAccountOp)
    dappHandlers.forEach((handler) => {
      if (txnId) {
        // If the call has a txnId, resolve the promise with it.
        // This could happen when an EOA account is broadcasting multiple transactions.
        handler.promise.resolve({ hash: handler.txnId || txnId })
      } else {
        handler.promise.reject(
          ethErrors.rpc.transactionRejected({
            message: 'Transaction rejected by the bundler'
          })
        )
      }
    })

    this.emitUpdate()
  }

  #abortHWTransactionSign(signAccountOp: SignAccountOpController) {
    if (!signAccountOp) return

    const isAwaitingHWSignature =
      (signAccountOp.accountOp.signingKeyType !== 'internal' &&
        this.statuses.signAndBroadcastAccountOp === 'SIGNING') ||
      // this.feePayerKey should be set before checking if it's type is internal
      // if it's not, we are not waiting for a hw sig
      (this.feePayerKey &&
        this.feePayerKey.type !== 'internal' &&
        this.statuses.signAndBroadcastAccountOp === 'BROADCASTING')

    // Reset these flags only if we were awaiting a HW signature
    // to broadcast a transaction.
    // If the user is using a hot wallet we can sign the transaction immediately
    // and once its signed there is no way to cancel the broadcast. Once the user
    // On the other hand HWs can be in 'SIGNING' or 'BROADCASTING' state
    // and be able to 'cancel' the broadcast.
    if (isAwaitingHWSignature) {
      this.statuses.signAndBroadcastAccountOp = 'INITIAL'
      this.#signAndBroadcastCallId = null
    }

    const uniqueSigningKeys = [
      ...new Set([signAccountOp.accountOp.signingKeyType, this.feePayerKey?.type])
    ]

    // Call the cleanup method for each unique signing key type
    uniqueSigningKeys.forEach((keyType) => {
      if (!keyType || keyType === 'internal') return

      this.#externalSignerControllers[keyType]?.signingCleanup?.()
    })

    this.#signAccountOpSigningPromise = undefined
  }

  destroySignAccOp() {
    if (!this.signAccountOp) return

    this.#abortHWTransactionSign(this.signAccountOp)
    this.feePayerKey = null
    this.signAccountOp.reset()
    this.signAccountOp = null
    this.signAccOpInitError = null

    // NOTE: no need to update the portfolio here as an update is
    // fired upon removeUserRequest

    this.emitUpdate()
  }

  async traceCall(signAccountOpCtrl: SignAccountOpController) {
    const accountOp = signAccountOpCtrl.accountOp
    if (!accountOp) return

    const network = this.networks.networks.find((n) => n.chainId === accountOp.chainId)
    if (!network) return

    const account = this.accounts.accounts.find((acc) => acc.addr === accountOp.accountAddr)
    if (!account) return

    // `traceCall` should not be invoked too frequently. However, if there is a pending timeout,
    // it should be cleared to prevent the previous interval from changing the status
    // to `SlowPendingResponse` for the newer `traceCall` invocation.
    if (this.#traceCallTimeoutId) clearTimeout(this.#traceCallTimeoutId)

    // Here, we also check the status because, in the case of re-estimation,
    // `traceCallDiscoveryStatus` is already set, and we don’t want to reset it to "InProgress".
    // This prevents the BalanceDecrease banner from flickering.
    if (signAccountOpCtrl.traceCallDiscoveryStatus === TraceCallDiscoveryStatus.NotStarted)
      signAccountOpCtrl.setDiscoveryStatus(TraceCallDiscoveryStatus.InProgress)

    // Flag the discovery logic as `SlowPendingResponse` if the call does not resolve within 2 seconds.
    const timeoutId = setTimeout(() => {
      signAccountOpCtrl.setDiscoveryStatus(TraceCallDiscoveryStatus.SlowPendingResponse)
      signAccountOpCtrl.calculateWarnings()
    }, 2000)

    this.#traceCallTimeoutId = timeoutId

    try {
      const state = this.accounts.accountStates[accountOp.accountAddr][accountOp.chainId.toString()]
      const provider = this.providers.providers[network.chainId.toString()]
      const stateOverride =
        accountOp.calls.length > 1 && isBasicAccount(account, state)
          ? {
              [account.addr]: {
                code: AmbireAccount7702.binRuntime
              }
            }
          : undefined
      const { tokens, nfts } = await debugTraceCall(
        account,
        accountOp,
        provider,
        state,
        !network.rpcNoStateOverride,
        stateOverride
      )
      const learnedNewTokens = this.portfolio.addTokensToBeLearned(tokens, network.chainId)
      const learnedNewNfts = await this.portfolio.learnNfts(nfts, network.chainId)
      const accountOpsForSimulation = getAccountOpsForSimulation(
        account,
        this.requests.actions.visibleActionsQueue,
        this.networks.networks
      )

      // update the portfolio only if new tokens were found through tracing
      const canUpdateSignAccountOp = !signAccountOpCtrl || signAccountOpCtrl.canUpdate()
      if (canUpdateSignAccountOp && (learnedNewTokens || learnedNewNfts)) {
        await this.portfolio.updateSelectedAccount(
          accountOp.accountAddr,
          [network],
          accountOpsForSimulation
            ? {
                accountOps: accountOpsForSimulation,
                states: await this.accounts.getOrFetchAccountStates(account.addr)
              }
            : undefined,
          { forceUpdate: true }
        )
      }

      signAccountOpCtrl.setDiscoveryStatus(TraceCallDiscoveryStatus.Done)
    } catch (e: any) {
      signAccountOpCtrl.setDiscoveryStatus(TraceCallDiscoveryStatus.Failed)

      this.emitError({
        level: 'silent',
        message: 'Error in main.traceCall',
        error: new Error(`Debug trace call error on ${network.name}: ${e.message}`)
      })
    }

    signAccountOpCtrl?.calculateWarnings()
    this.#traceCallTimeoutId = null
    clearTimeout(timeoutId)
  }

  async handleSignMessage() {
    const accountAddr = this.signMessage.messageToSign?.accountAddr
    const chainId = this.signMessage.messageToSign?.chainId

    // Could (rarely) happen if not even a single account state is fetched yet
    const shouldForceUpdateAndWaitForAccountState =
      accountAddr && chainId && !this.accounts.accountStates?.[accountAddr]?.[chainId.toString()]
    if (shouldForceUpdateAndWaitForAccountState)
      await this.accounts.updateAccountState(accountAddr, 'latest', [chainId])

    const isAccountStateStillMissing =
      !accountAddr || !chainId || !this.accounts.accountStates?.[accountAddr]?.[chainId.toString()]
    if (isAccountStateStillMissing) {
      const message =
        'Unable to sign the message. During the preparation step, required account data failed to get received. Please try again later or contact Ambire support.'
      const error = new Error(
        `The account state of ${accountAddr} is missing for the network with id ${chainId}.`
      )
      return this.emitError({ level: 'major', message, error })
    }

    await this.signMessage.sign()

    const signedMessage = this.signMessage.signedMessage
    // Error handling on the prev step will notify the user, it's fine to return here
    if (!signedMessage) return

    await this.activity.addSignedMessage(signedMessage, signedMessage.accountAddr)

    await this.requests.resolveUserRequest(
      { hash: signedMessage.signature },
      signedMessage.fromActionId
    )

    await this.#notificationManager.create({
      title: 'Done!',
      message: 'The Message was successfully signed.'
    })
  }

  async #handleAccountPickerInitLedger(
    LedgerKeyIterator: any // TODO: KeyIterator type mismatch
  ) {
    try {
      const ledgerCtrl = this.#externalSignerControllers.ledger
      if (!ledgerCtrl) {
        const message =
          'Could not initialize connection with your Ledger device. Please try again later or contact Ambire support.'
        throw new EmittableError({ message, level: 'major', error: new Error(message) })
      }

      // Once a session with the Ledger device gets initiated, the user might
      // use the device with another app. In this scenario, when coming back to
      // Ambire (the second time a connection gets requested onwards),
      // the Ledger device throws with "invalid channel" error.
      // To overcome this, always make sure to clean up before starting
      // a new session when retrieving keys, in case there already is one.
      if (ledgerCtrl.walletSDK) await ledgerCtrl.cleanUp()

      const hdPathTemplate = BIP44_LEDGER_DERIVATION_TEMPLATE
      const pathToUnlock = getHdPathFromTemplate(hdPathTemplate, 0)
      await ledgerCtrl.unlock(pathToUnlock)

      if (!ledgerCtrl.walletSDK) {
        const message = 'Could not establish connection with the Ledger device'
        throw new EmittableError({ message, level: 'major', error: new Error(message) })
      }

      const keyIterator = new LedgerKeyIterator({ controller: ledgerCtrl })
      await this.accountPicker.setInitParams({
        keyIterator,
        hdPathTemplate,
        pageSize: 5,
        shouldAddNextAccountAutomatically: false
      })
    } catch (error: any) {
      const message = error?.message || 'Could not unlock the Ledger device. Please try again.'
      throw new EmittableError({ message, level: 'major', error })
    }
  }

  async handleAccountPickerInitLedger(
    LedgerKeyIterator: any /* TODO: KeyIterator type mismatch */
  ) {
    await this.withStatus('handleAccountPickerInitLedger', async () =>
      this.#handleAccountPickerInitLedger(LedgerKeyIterator)
    )
  }

  async #handleAccountPickerInitTrezor(
    TrezorKeyIterator: any /* TODO: KeyIterator type mismatch */
  ) {
    try {
      const trezorCtrl = this.#externalSignerControllers.trezor

      if (!trezorCtrl) {
        const message =
          'Could not initialize connection with your Trezor device. Please try again later or contact Ambire support.'
        throw new EmittableError({ message, level: 'major', error: new Error(message) })
      }

      const hdPathTemplate = BIP44_STANDARD_DERIVATION_TEMPLATE
      const { walletSDK } = trezorCtrl
      await this.accountPicker.setInitParams({
        keyIterator: new TrezorKeyIterator({ walletSDK }),
        hdPathTemplate,
        pageSize: 5,
        shouldAddNextAccountAutomatically: false
      })
    } catch (error: any) {
      const message = error?.message || 'Could not unlock the Trezor device. Please try again.'
      throw new EmittableError({ message, level: 'major', error })
    }
  }

  async handleAccountPickerInitTrezor(
    TrezorKeyIterator: any /* TODO: KeyIterator type mismatch */
  ) {
    await this.withStatus('handleAccountPickerInitTrezor', async () =>
      this.#handleAccountPickerInitTrezor(TrezorKeyIterator)
    )
  }

  async #handleAccountPickerInitLattice(
    LatticeKeyIterator: any /* TODO: KeyIterator type mismatch */
  ) {
    try {
      const latticeCtrl = this.#externalSignerControllers.lattice
      if (!latticeCtrl) {
        const message =
          'Could not initialize connection with your Lattice1 device. Please try again later or contact Ambire support.'
        throw new EmittableError({ message, level: 'major', error: new Error(message) })
      }

      const hdPathTemplate = BIP44_STANDARD_DERIVATION_TEMPLATE

      await this.accountPicker.setInitParams({
        keyIterator: new LatticeKeyIterator({ controller: latticeCtrl }),
        hdPathTemplate,
        pageSize: 5,
        shouldAddNextAccountAutomatically: false
      })
    } catch (error: any) {
      const message = error?.message || 'Could not unlock the Lattice1 device. Please try again.'
      throw new EmittableError({ message, level: 'major', error })
    }
  }

  async handleAccountPickerInitLattice(
    LatticeKeyIterator: any /* TODO: KeyIterator type mismatch */
  ) {
    await this.withStatus('handleAccountPickerInitLattice', async () =>
      this.#handleAccountPickerInitLattice(LatticeKeyIterator)
    )
  }

  async updateAccountsOpsStatuses(): Promise<{ newestOpTimestamp: number }> {
    await this.#initialLoadPromise

    const { shouldEmitUpdate, shouldUpdatePortfolio, updatedAccountsOps, newestOpTimestamp } =
      await this.activity.updateAccountsOpsStatuses()

    if (shouldEmitUpdate) {
      this.emitUpdate()

      if (shouldUpdatePortfolio) {
        this.updateSelectedAccountPortfolio({ forceUpdate: true })
      }
    }

    updatedAccountsOps.forEach((op) => {
      this.swapAndBridge.handleUpdateActiveRouteOnSubmittedAccountOpStatusUpdate(op)
    })

    return { newestOpTimestamp }
  }

  // call this function after a call to the singleton has been made
  // it will check if the factory has been deployed and update the network settings if it has been
  async setContractsDeployedToTrueIfDeployed(network: Network) {
    await this.#initialLoadPromise
    if (network.areContractsDeployed) return

    const provider = this.providers.providers[network.chainId.toString()]
    if (!provider) return

    const factoryCode = await provider.getCode(AMBIRE_ACCOUNT_FACTORY)
    if (factoryCode === '0x') return
    await this.networks.updateNetwork({ areContractsDeployed: true }, network.chainId)
  }

  #removeAccountKeyData(address: Account['addr']) {
    // Compute account keys that are only associated with this account
    const accountAssociatedKeys =
      this.accounts.accounts.find((acc) => acc.addr === address)?.associatedKeys || []
    const keysInKeystore = this.keystore.keys
    const importedAccountKeys = keysInKeystore.filter((key) =>
      accountAssociatedKeys.includes(key.addr)
    )
    const solelyAccountKeys = importedAccountKeys.filter((key) => {
      const isKeyAssociatedWithOtherAccounts = this.accounts.accounts.some(
        (acc) => acc.addr !== address && acc.associatedKeys.includes(key.addr)
      )

      return !isKeyAssociatedWithOtherAccounts
    })

    // Remove account keys from the keystore
    solelyAccountKeys.forEach((key) => {
      this.keystore.removeKey(key.addr, key.type).catch((e) => {
        throw new EmittableError({
          level: 'major',
          message: 'Failed to remove account key',
          error: e
        })
      })
    })
  }

  async #removeAccount(address: Account['addr']) {
    try {
      this.#removeAccountKeyData(address)
      // Remove account data from sub-controllers
      this.accounts.removeAccountData(address)
      this.portfolio.removeAccountData(address)
      await this.activity.removeAccountData(address)
      this.requests.actions.removeAccountData(address)
      this.signMessage.removeAccountData(address)
      this.defiPositions.removeAccountData(address)

      if (this.selectedAccount.account?.addr === address) {
        await this.#selectAccount(this.accounts.accounts[0]?.addr)
      }

      if (this.signAccountOp?.account.addr === address) {
        this.destroySignAccOp()
      }

      this.emitUpdate()
    } catch (e: any) {
      throw new EmittableError({
        level: 'major',
        message: 'Failed to remove account',
        error: e || new Error('Failed to remove account')
      })
    }
  }

  async removeAccount(address: Account['addr']) {
    await this.withStatus('removeAccount', async () => this.#removeAccount(address))
  }

  async reloadSelectedAccount(options?: { forceUpdate?: boolean; chainIds?: bigint[] }) {
    const { forceUpdate = true, chainIds } = options || {}
    const networksToUpdate = chainIds
      ? this.networks.networks.filter((n) => chainIds.includes(n.chainId))
      : undefined
    if (!this.selectedAccount.account) return

    this.selectedAccount.resetSelectedAccountPortfolio()
    await Promise.all([
      // When we trigger `reloadSelectedAccount` (for instance, from Dashboard -> Refresh balance icon),
      // it's very likely that the account state is already in the process of being updated.
      // If we try to run the same action, `withStatus` validation will throw an error.
      // So, we perform this safety check to prevent the error.
      // However, even if we don't trigger an update here, it's not a big problem,
      // as the account state will be updated anyway, and its update will be very recent.
      !this.accounts.areAccountStatesLoading && this.selectedAccount.account?.addr
        ? this.accounts.updateAccountState(this.selectedAccount.account.addr, 'pending', chainIds)
        : Promise.resolve(),
      // `updateSelectedAccountPortfolio` doesn't rely on `withStatus` validation internally,
      // as the PortfolioController already exposes flags that are highly sufficient for the UX.
      // Additionally, if we trigger the portfolio update twice (i.e., running a long-living interval + force update from the Dashboard),
      // there won't be any error thrown, as all portfolio updates are queued and they don't use the `withStatus` helper.
      this.updateSelectedAccountPortfolio({ networks: networksToUpdate, forceUpdate }),
      this.defiPositions.updatePositions({ chainIds, forceUpdate })
    ])
  }

  #updateIsOffline() {
    const oldIsOffline = this.isOffline
    const accountAddr = this.selectedAccount.account?.addr

    if (!accountAddr) return

    // We have to make calculations based on the state of the portfolio
    // and not the selected account portfolio the flag isOffline
    // and the errors of the selected account portfolio should
    // come in the same tick. Otherwise the UI may flash the wrong error.
    const latestState = this.portfolio.getLatestPortfolioState(accountAddr)
    const latestStateKeys = Object.keys(latestState)
    const isAllLoaded = latestStateKeys.every((chainId) => {
      return isNetworkReady(latestState[chainId]) && !latestState[chainId]?.isLoading
    })

    // Set isOffline back to false if the portfolio is loading.
    // This is done to prevent the UI from flashing the offline error
    if (!latestStateKeys.length || !isAllLoaded) {
      // Skip unnecessary updates
      if (!this.isOffline) return

      this.isOffline = false
      this.emitUpdate()
      return
    }

    const allPortfolioNetworksHaveErrors = latestStateKeys.every((chainId) => {
      const state = latestState[chainId]

      return !!state?.criticalError
    })

    const allNetworkRpcsAreDown = Object.keys(this.providers.providers).every((chainId) => {
      const provider = this.providers.providers[chainId]
      const isWorking = provider.isWorking

      return typeof isWorking === 'boolean' && !isWorking
    })

    // Update isOffline if either all portfolio networks have errors or we've failed to fetch
    // the account state for every account. This is because either update may fail first.
    this.isOffline = !!allNetworkRpcsAreDown || !!allPortfolioNetworksHaveErrors

    if (oldIsOffline !== this.isOffline) {
      this.emitUpdate()
    }
  }

  // TODO: Refactor this to accept an optional object with options
  async updateSelectedAccountPortfolio(opts?: {
    forceUpdate?: boolean
    networks?: Network[]
    maxDataAgeMs?: number
  }) {
    const { networks, maxDataAgeMs, forceUpdate } = opts || {}

    await this.#initialLoadPromise
    if (!this.selectedAccount.account) return
    const canUpdateSignAccountOp = !this.signAccountOp || this.signAccountOp.canUpdate()
    if (!canUpdateSignAccountOp) return

    const accountOpsToBeSimulatedByNetwork = getAccountOpsForSimulation(
      this.selectedAccount.account,
      this.requests.actions.visibleActionsQueue,
      this.networks.networks
    )

    await this.portfolio.updateSelectedAccount(
      this.selectedAccount.account.addr,
      networks,
      accountOpsToBeSimulatedByNetwork
        ? {
            accountOps: accountOpsToBeSimulatedByNetwork,
            states: await this.accounts.getOrFetchAccountStates(this.selectedAccount.account.addr)
          }
        : undefined,
      { forceUpdate, maxDataAgeMs }
    )
    this.#updateIsOffline()
  }

  async rejectSignAccountOpCall(callId: string) {
    if (!this.signAccountOp) return

    const { calls, chainId, accountAddr } = this.signAccountOp.accountOp

    const requestId = calls.find((c) => c.id === callId)?.fromUserRequestId
    if (requestId) {
      const userRequestIndex = this.requests.userRequests.findIndex((r) => r.id === requestId)
      const userRequest = this.requests.userRequests[userRequestIndex] as SignUserRequest
      if (userRequest.action.kind === 'calls') {
        ;(userRequest.action as Calls).calls = (userRequest.action as Calls).calls.filter(
          (c) => c.id !== callId
        )

        if (userRequest.action.calls.length === 0) {
          // the reject will remove the userRequest which will rebuild the action and update the signAccountOp
          await this.requests.rejectUserRequests('User rejected the transaction request.', [
            userRequest.id
          ])
        } else {
          const accountOpAction = makeAccountOpAction({
            account: this.accounts.accounts.find((a) => a.addr === accountAddr)!,
            chainId,
            nonce: this.accounts.accountStates[accountAddr][chainId.toString()].nonce,
            userRequests: this.requests.userRequests,
            actionsQueue: this.requests.actions.actionsQueue
          })

          await this.requests.actions.addOrUpdateActions([accountOpAction], {
            skipFocus: true
          })
          this.signAccountOp?.update({ calls: accountOpAction.accountOp.calls })
        }
      }
    } else {
      this.emitError({
        message: 'Reject call: the call was not found or was not linked to a user request',
        level: 'major',
        error: new Error(
          `Error: rejectAccountOpCall: userRequest for call with id ${callId} was not found`
        )
      })
    }
  }

  async removeActiveRoute(activeRouteId: SwapAndBridgeActiveRoute['activeRouteId']) {
    const userRequest = this.requests.userRequests.find((r) =>
      [activeRouteId, `${activeRouteId}-approval`, `${activeRouteId}-revoke-approval`].includes(
        r.id as string
      )
    )

    if (userRequest) {
      await this.requests.rejectUserRequests('User rejected the transaction request.', [
        userRequest.id
      ])
    } else {
      this.swapAndBridge.removeActiveRoute(activeRouteId)
    }
  }

  async addNetwork(network: AddNetworkRequestParams) {
    await this.networks.addNetwork(network)

    await this.updateSelectedAccountPortfolio()
  }

  removeNetworkData(chainId: bigint) {
    this.portfolio.removeNetworkData(chainId)
    this.accountPicker.removeNetworkData(chainId)
    // Don't remove user activity for now because removing networks
    // is no longer possible in the UI. Users can only disable networks
    // and it doesn't make sense to delete their activity
    // this.activity.removeNetworkData(chainId)

    // Don't remove the defi positions state data because we keep track of the defi positions
    // on the disabled networks so we can suggest enabling them from a dashboard banner
    // this.defiPositions.removeNetworkData(chainId)
  }

  async resolveAccountOpAction(
    submittedAccountOp: SubmittedAccountOp,
    actionId: AccountOpAction['id'],
    isBasicAccountBroadcastingMultiple: boolean
  ) {
    const accountOpAction = this.requests.actions.actionsQueue.find((a) => a.id === actionId)
    if (!accountOpAction) return

    const { accountOp } = accountOpAction as AccountOpAction
    const network = this.networks.networks.find((n) => n.chainId === accountOp.chainId)

    if (!network) return

    const calls: Call[] = submittedAccountOp.calls
    const meta: SignUserRequest['meta'] = {
      isSignAction: true,
      accountAddr: accountOp.accountAddr,
      chainId: network.chainId,
      txnId: null,
      userOpHash: null
    }

    if (submittedAccountOp) {
      // can be undefined, check submittedAccountOp.ts
      meta.txnId = submittedAccountOp.txnId
      meta.identifiedBy = submittedAccountOp.identifiedBy
      meta.submittedAccountOp = submittedAccountOp
    }

    if (!isBasicAccountBroadcastingMultiple) {
      const benzinUserRequest: SignUserRequest = {
        id: new Date().getTime(),
        action: { kind: 'benzin' },
        session: new Session(),
        meta
      }
      await this.requests.addUserRequests([benzinUserRequest], {
        actionPosition: 'first',
        skipFocus: true
      })
    }

    await this.requests.actions.removeActions([actionId])

    const userRequestsToRemove: UserRequest['id'][] = []
    const dappHandlers: any[] = []

    // handle wallet_sendCalls before activity.getConfirmedTxId as 1) it's faster
    // 2) the identifier is different
    calls.forEach((call) => {
      const walletSendCallsUserReq = this.requests.userRequests.find(
        (r) => r.id === call.fromUserRequestId && r.meta.isWalletSendCalls
      )
      const uReq = this.requests.userRequests.find((r) => r.id === call.fromUserRequestId)

      if (walletSendCallsUserReq) {
        walletSendCallsUserReq.dappPromise?.resolve({
          hash: getDappIdentifier(submittedAccountOp)
        })

        userRequestsToRemove.push(walletSendCallsUserReq.id)
      }

      if (uReq) {
        if (uReq.dappPromise) {
          dappHandlers.push({
            promise: uReq.dappPromise,
            txnId: call.txnId
          })
        }

        userRequestsToRemove.push(uReq.id)
      }
    })

    await this.requests.removeUserRequests(userRequestsToRemove, {
      shouldRemoveSwapAndBridgeRoute: false,
      // Since `resolveAccountOpAction` is invoked only when we broadcast a transaction,
      // we don't want to update the account portfolio immediately, as we would lose the simulation.
      // The simulation is required to calculate the pending badges (see: calculatePendingAmounts()).
      // Once the transaction is confirmed, delayed, or the user manually refreshes the portfolio,
      // the account will be updated automatically.
      shouldUpdateAccount: false
    })

    await this.resolveDappBroadcast(submittedAccountOp, dappHandlers)

    this.emitUpdate()
  }

  async rejectAccountOpAction(
    err: string,
    actionId: AccountOpAction['id'],
    shouldOpenNextAction: boolean
  ) {
    const accountOpAction = this.requests.actions.actionsQueue.find((a) => a.id === actionId)
    if (!accountOpAction) return

    const { accountOp, id } = accountOpAction as AccountOpAction

    if (this.signAccountOp && this.signAccountOp.fromActionId === id) {
      this.destroySignAccOp()
    }
    await this.requests.actions.removeActions([actionId], shouldOpenNextAction)

    const requestIdsToRemove = accountOp.calls
      .filter((call) => !!call.fromUserRequestId)
      .map((call) => call.fromUserRequestId)

    await this.requests.rejectUserRequests(err, requestIdsToRemove as string[], {
      shouldOpenNextRequest: shouldOpenNextAction
    })

    this.emitUpdate()
  }

  onOneClickSwapClose() {
    const signAccountOp = this.swapAndBridge.signAccountOpController

    // Always unload the screen when the action window is closed
    this.swapAndBridge.unloadScreen('action-window', true)

    if (!signAccountOp) return

    // Remove the active route if it exists
    if (signAccountOp.accountOp.meta?.swapTxn) {
      this.swapAndBridge.removeActiveRoute(signAccountOp.accountOp.meta.swapTxn.activeRouteId)
    }

    this.#abortHWTransactionSign(signAccountOp)

    const network = this.networks.networks.find(
      (n) => n.chainId === signAccountOp.accountOp.chainId
    )

    this.updateSelectedAccountPortfolio({
      forceUpdate: true,
      networks: network ? [network] : undefined
    })
    this.emitUpdate()
  }

  onOneClickTransferClose() {
    const signAccountOp = this.transfer.signAccountOpController

    // Always unload the screen when the action window is closed
    this.transfer.unloadScreen(true)

    if (!signAccountOp) return

    this.#abortHWTransactionSign(signAccountOp)

    const network = this.networks.networks.find(
      (n) => n.chainId === signAccountOp.accountOp.chainId
    )

    this.updateSelectedAccountPortfolio({
      forceUpdate: true,
      networks: network ? [network] : undefined
    })
    this.emitUpdate()
  }

  /**
   * There are 4 ways to broadcast an AccountOp:
   *   1. For EOAs, there is only one way to do that. After
   *   signing the transaction, the serialized signed transaction object gets
   *   send to the network.
   *   2. For smart accounts, when EOA pays the fee. Two signatures are needed
   *   for this. The first one is the signature of the AccountOp itself. The
   *   second one is the signature of the transaction that will be executed
   *   by the smart account.
   *   3. For smart accounts that broadcast the ERC-4337 way.
   *   4. for smart accounts, when the Relayer does the broadcast.
   *
   */
  async #broadcastSignedAccountOp(
    signAccountOp: SignAccountOpController,
    type: SignAccountOpType,
    callId: string
  ) {
    if (this.statuses.signAndBroadcastAccountOp !== 'SIGNING') {
      this.throwBroadcastAccountOp({
        signAccountOp,
        message: 'Pending broadcast. Please try again in a bit.'
      })
      return
    }
    const accountOp = signAccountOp.accountOp
    const estimation = signAccountOp.estimation.estimation
    const actionId = signAccountOp.fromActionId
    const bundlerSwitcher = signAccountOp.bundlerSwitcher
    const contactSupportPrompt = 'Please try again or contact support if the problem persists.'

    if (
      !accountOp ||
      !estimation ||
      !actionId ||
      !accountOp.signingKeyAddr ||
      !accountOp.signingKeyType ||
      !accountOp.signature ||
      !bundlerSwitcher ||
      !accountOp.gasFeePayment
    ) {
      const message = `Missing mandatory transaction details. ${contactSupportPrompt}`
      return this.throwBroadcastAccountOp({ signAccountOp, message })
    }

    const provider = this.providers.providers[accountOp.chainId.toString()]
    const account = this.accounts.accounts.find((acc) => acc.addr === accountOp.accountAddr)
    const network = this.networks.networks.find((n) => n.chainId === accountOp.chainId)

    if (!provider) {
      const networkName = network?.name || `network with id ${accountOp.chainId}`
      const message = `Provider for ${networkName} not found. ${contactSupportPrompt}`
      return this.throwBroadcastAccountOp({ signAccountOp, message })
    }

    if (!account) {
      const addr = shortenAddress(accountOp.accountAddr, 13)
      const message = `Account with address ${addr} not found. ${contactSupportPrompt}`
      return this.throwBroadcastAccountOp({ signAccountOp, message })
    }

    if (!network) {
      const message = `Network with id ${accountOp.chainId} not found. ${contactSupportPrompt}`
      return this.throwBroadcastAccountOp({ signAccountOp, message })
    }

    this.statuses.signAndBroadcastAccountOp = 'BROADCASTING'
    await this.forceEmitUpdate()

    const accountState = await this.accounts.getOrFetchAccountOnChainState(
      accountOp.accountAddr,
      accountOp.chainId
    )
    const baseAcc = getBaseAccount(
      account,
      accountState,
      this.keystore.getAccountKeys(account),
      network
    )
    let transactionRes: {
      txnId?: string
      nonce: number
      identifiedBy: AccountOpIdentifiedBy
    } | null = null

    // broadcasting by EOA is quite the same:
    // 1) build a rawTxn 2) sign 3) broadcast
    // we have one handle, just a diff rawTxn for each case
    const rawTxnBroadcast = [
      BROADCAST_OPTIONS.bySelf,
      BROADCAST_OPTIONS.bySelf7702,
      BROADCAST_OPTIONS.byOtherEOA,
      BROADCAST_OPTIONS.delegation
    ]

    if (rawTxnBroadcast.includes(accountOp.gasFeePayment.broadcastOption)) {
      const multipleTxnsBroadcastRes = []
      const senderAddr = BROADCAST_OPTIONS.byOtherEOA
        ? accountOp.gasFeePayment.paidBy
        : accountOp.accountAddr
      const nonce = await provider.getTransactionCount(senderAddr).catch((e) => e)

      // @precaution
      if (nonce instanceof Error) {
        return this.throwBroadcastAccountOp({
          signAccountOp,
          message: 'RPC error. Please try again',
          accountState
        })
      }

      try {
        const feePayerKey = this.keystore.getFeePayerKey(accountOp)
        if (feePayerKey instanceof Error) {
          return this.throwBroadcastAccountOp({
            signAccountOp,
            message: feePayerKey.message,
            accountState
          })
        }
        this.feePayerKey = feePayerKey
        this.emitUpdate()

        const signer = await this.keystore.getSigner(feePayerKey.addr, feePayerKey.type)
        if (signer.init) {
          signer.init(this.#externalSignerControllers[feePayerKey.type])
        }

        const txnLength = baseAcc.shouldBroadcastCallsSeparately(accountOp)
          ? accountOp.calls.length
          : 1
        if (txnLength > 1) signAccountOp.update({ signedTransactionsCount: 0 })
        for (let i = 0; i < txnLength; i++) {
          const currentNonce = nonce + i
          const rawTxn = await buildRawTransaction(
            account,
            accountOp,
            accountState,
            provider,
            network,
            currentNonce,
            accountOp.gasFeePayment.broadcastOption,
            accountOp.calls[i]
          )
          const signedTxn =
            accountOp.gasFeePayment.broadcastOption === BROADCAST_OPTIONS.delegation
              ? signer.signTransactionTypeFour(rawTxn, accountOp.meta!.delegation!)
              : await signer.signRawTransaction(rawTxn)
          if (callId !== this.#signAndBroadcastCallId) {
            return
          }
          if (accountOp.gasFeePayment.broadcastOption === BROADCAST_OPTIONS.delegation) {
            multipleTxnsBroadcastRes.push({
              hash: await provider.send('eth_sendRawTransaction', [signedTxn])
            })
          } else {
            multipleTxnsBroadcastRes.push(await provider.broadcastTransaction(signedTxn))
          }
          if (txnLength > 1) signAccountOp.update({ signedTransactionsCount: i + 1 })

          // send the txn to the relayer if it's an EOA sending for itself
          if (accountOp.gasFeePayment.broadcastOption !== BROADCAST_OPTIONS.byOtherEOA) {
            this.callRelayer(`/v2/eoaSubmitTxn/${accountOp.chainId}`, 'POST', {
              rawTxn: signedTxn
            }).catch((e: any) => {
              // eslint-disable-next-line no-console
              console.log('failed to record EOA txn to relayer')
              // eslint-disable-next-line no-console
              console.log(e)
            })
          }
        }
        if (callId !== this.#signAndBroadcastCallId) return
        transactionRes = {
          nonce,
          identifiedBy: {
            type: txnLength > 1 ? 'MultipleTxns' : 'Transaction',
            identifier: multipleTxnsBroadcastRes.map((res) => res.hash).join('-')
          },
          txnId:
            txnLength === 1 ? multipleTxnsBroadcastRes.map((res) => res.hash).join('-') : undefined
        }
      } catch (error: any) {
        if (this.#signAndBroadcastCallId !== callId) return
        // eslint-disable-next-line no-console
        console.error('Error broadcasting', error)
        // for multiple txn cases
        // if a batch of 5 txn is sent to Ledger for sign but the user reject
        // #3, #1 and #2 are already broadcast. Reduce the accountOp's call
        // to #1 and #2 and create a submittedAccountOp
        //
        // unless it's the build-in swap - we want to throw an error and
        // allow the user to retry in this case
        if (multipleTxnsBroadcastRes.length && type !== SIGN_ACCOUNT_OP_SWAP) {
          transactionRes = {
            nonce,
            identifiedBy: {
              type: 'MultipleTxns',
              identifier: multipleTxnsBroadcastRes.map((res) => res.hash).join('-')
            }
          }
        } else {
          return this.throwBroadcastAccountOp({ signAccountOp, error, accountState })
        }
      } finally {
        if (this.#signAndBroadcastCallId === callId) {
          signAccountOp.update({ signedTransactionsCount: null })
        }
      }
    }
    // Smart account, the ERC-4337 way
    else if (accountOp.gasFeePayment?.broadcastOption === BROADCAST_OPTIONS.byBundler) {
      const userOperation = accountOp.asUserOperation
      if (!userOperation) {
        const accAddr = shortenAddress(accountOp.accountAddr, 13)
        const message = `Trying to broadcast an ERC-4337 request but userOperation is not set for the account with address ${accAddr}`
        return this.throwBroadcastAccountOp({ signAccountOp, message, accountState })
      }

      // broadcast through bundler's service
      let userOperationHash
      const bundler = bundlerSwitcher.getBundler()
      try {
        userOperationHash = await bundler.broadcast(userOperation, network)
      } catch (e: any) {
        let retryMsg

        // if the signAccountOp is still active (it should be)
        // try to switch the bundler and ask the user to try again
        if (signAccountOp) {
          const switcher = signAccountOp.bundlerSwitcher
          signAccountOp.updateStatus(SigningStatus.ReadyToSign)

          if (switcher.canSwitch(baseAcc)) {
            switcher.switch()
            signAccountOp.simulate()
            signAccountOp.gasPrice.fetch()
            retryMsg = 'Broadcast failed because bundler was down. Please try again'
          }
        }

        return this.throwBroadcastAccountOp({
          signAccountOp,
          error: e,
          accountState,
          provider,
          network,
          message: retryMsg
        })
      }
      if (!userOperationHash) {
        return this.throwBroadcastAccountOp({
          signAccountOp,
          message: 'Bundler broadcast failed. Please try broadcasting by an EOA or contact support.'
        })
      }

      transactionRes = {
        nonce: Number(userOperation.nonce),
        identifiedBy: {
          type: 'UserOperation',
          identifier: userOperationHash,
          bundler: bundler.getName()
        }
      }
    }
    // Smart account, the Relayer way
    else {
      try {
        const body = {
          gasLimit: Number(accountOp.gasFeePayment!.simulatedGasLimit),
          txns: getSignableCalls(accountOp),
          signature: accountOp.signature,
          signer: { address: accountOp.signingKeyAddr },
          nonce: Number(accountOp.nonce)
        }
        const additionalRelayerNetwork = relayerAdditionalNetworks.find(
          (net) => net.chainId === network.chainId
        )
        const relayerChainId = additionalRelayerNetwork
          ? additionalRelayerNetwork.chainId
          : accountOp.chainId
        const response = await this.callRelayer(
          `/identity/${accountOp.accountAddr}/${relayerChainId}/submit`,
          'POST',
          body
        )
        if (!response.success) throw new Error(response.message)

        transactionRes = {
          txnId: response.txId,
          nonce: Number(accountOp.nonce),
          identifiedBy: {
            type: 'Relayer',
            identifier: response.id
          }
        }
      } catch (error: any) {
        return this.throwBroadcastAccountOp({ signAccountOp, error, accountState, isRelayer: true })
      }
    }

    if (this.#signAndBroadcastCallId !== callId) return

    if (!transactionRes)
      return this.throwBroadcastAccountOp({
        signAccountOp,
        message: 'No transaction response received after being broadcasted.'
      })

    // simulate the swap & bridge only after a successful broadcast
    if (type === SIGN_ACCOUNT_OP_SWAP || type === SIGN_ACCOUNT_OP_TRANSFER) {
      signAccountOp?.portfolioSimulate().then(() => {
        this.portfolio.markSimulationAsBroadcasted(account.addr, network.chainId)
      })
    } else {
      this.portfolio.markSimulationAsBroadcasted(account.addr, network.chainId)
    }

    const submittedAccountOp: SubmittedAccountOp = {
      ...accountOp,
      status: AccountOpStatus.BroadcastedButNotConfirmed,
      txnId: transactionRes.txnId,
      nonce: BigInt(transactionRes.nonce),
      identifiedBy: transactionRes.identifiedBy,
      timestamp: new Date().getTime(),
      isSingletonDeploy: !!accountOp.calls.find(
        (call) => call.to && getAddress(call.to) === SINGLETON
      )
    }

    // add the txnIds from each transaction to each Call from the accountOp
    // if identifiedBy is MultipleTxns
    const isBasicAccountBroadcastingMultiple = transactionRes.identifiedBy.type === 'MultipleTxns'
    if (isBasicAccountBroadcastingMultiple) {
      const txnIds = transactionRes.identifiedBy.identifier.split('-')
      const calls = submittedAccountOp.calls
        .map((oneCall, i) => {
          const localCall = { ...oneCall }

          // we're cutting off calls the user didn't sign / weren't broadcast
          if (!(i in txnIds)) return null

          localCall.txnId = txnIds[i] as Hex
          localCall.status = AccountOpStatus.BroadcastedButNotConfirmed
          return localCall
        })
        .filter((aCall) => aCall !== null) as Call[]
      submittedAccountOp.calls = calls

      // Handle the calls that weren't signed
      const rejectedCalls = accountOp.calls.filter((call) =>
        submittedAccountOp.calls.every((c) => c.id !== call.id)
      )
      const rejectedSwapActiveRouteIds = rejectedCalls.map((call) => {
        const userRequest = this.requests.userRequests.find((r) => r.id === call.fromUserRequestId)

        return userRequest?.meta.activeRouteId
      })

      rejectedSwapActiveRouteIds.forEach((routeId) => {
        this.removeActiveRoute(routeId)
      })

      if (rejectedCalls.length) {
        // remove the user requests that were rejected
        await this.requests.rejectUserRequests(
          'Transaction rejected by the bundler',
          rejectedCalls
            .filter((call) => !!call.fromUserRequestId)
            .map((call) => call.fromUserRequestId as string)
        )
      }
    }

    this.swapAndBridge.handleUpdateActiveRouteOnSubmittedAccountOpStatusUpdate(submittedAccountOp)
    await this.activity.addAccountOp(submittedAccountOp)

    // resolve dapp requests, open benzin and etc only if the main sign accountOp
    if (type === SIGN_ACCOUNT_OP_MAIN) {
      await this.resolveAccountOpAction(
        submittedAccountOp,
        actionId,
        isBasicAccountBroadcastingMultiple
      )
    }
    // TODO<Bobby>: make a new SwapAndBridgeFormStatus "Broadcast" and
    // visualize the success page on the FE instead of resetting the form
    if (type === SIGN_ACCOUNT_OP_SWAP) {
      this.swapAndBridge.resetForm()
    }

    if (type === SIGN_ACCOUNT_OP_TRANSFER) {
      if (this.transfer.shouldTrackLatestBroadcastedAccountOp) {
        this.transfer.latestBroadcastedToken = this.transfer.selectedToken
        this.transfer.latestBroadcastedAccountOp = submittedAccountOp
      }

      this.transfer.resetForm()
    }

    await this.#notificationManager.create({
      title:
        // different count can happen only on isBasicAccountBroadcastingMultiple
        submittedAccountOp.calls.length === accountOp.calls.length
          ? 'Done!'
          : 'Partially submitted',
      message: `${
        isBasicAccountBroadcastingMultiple
          ? `${submittedAccountOp.calls.length}/${accountOp.calls.length} transactions were`
          : 'The transaction was'
      } successfully signed and broadcast to the network.`
    })

    // reset the fee payer key
    this.feePayerKey = null
    return Promise.resolve()
  }

  // Technically this is an anti-pattern, but it's the only way to
  // test the error handling in the method.
  protected throwBroadcastAccountOp({
    signAccountOp,
    message: humanReadableMessage,
    error: _err,
    accountState,
    isRelayer = false,
    provider = undefined,
    network = undefined
  }: {
    signAccountOp: SignAccountOpController
    message?: string
    error?: Error
    accountState?: AccountOnchainState
    isRelayer?: boolean
    provider?: RPCProvider
    network?: Network
  }) {
    const originalMessage = _err?.message
    let message = humanReadableMessage
    let isReplacementFeeLow = false

    this.statuses.signAndBroadcastAccountOp = 'ERROR'
    this.forceEmitUpdate()

    if (originalMessage) {
      if (originalMessage.includes('replacement fee too low')) {
        message =
          'Replacement fee is insufficient. Fees have been automatically adjusted so please try submitting your transaction again.'
        isReplacementFeeLow = true
        if (signAccountOp) {
          signAccountOp.simulate(false)
        }
      } else if (originalMessage.includes('INSUFFICIENT_PRIVILEGE')) {
        message = accountState?.isV2
          ? 'Broadcast failed because of a pending transaction. Please try again'
          : 'Signer key not supported on this network'
      } else if (
        originalMessage.includes('underpriced') ||
        originalMessage.includes('Fee confirmation failed')
      ) {
        if (originalMessage.includes('underpriced')) {
          message =
            'Transaction fee underpriced. Please select a higher transaction speed and try again'
        }

        if (signAccountOp) {
          // eslint-disable-next-line @typescript-eslint/no-floating-promises
          signAccountOp.gasPrice.fetch()
          // eslint-disable-next-line @typescript-eslint/no-floating-promises
          signAccountOp.simulate(false)
        }
      } else if (originalMessage.includes('Failed to fetch') && isRelayer) {
        message =
          'Currently, the Ambire relayer seems to be down. Please try again a few moments later or broadcast with an EOA account'
      } else if (originalMessage.includes('user nonce') && isRelayer) {
        if (this.signAccountOp) {
          this.accounts
            .updateAccountState(this.signAccountOp.accountOp.accountAddr, 'pending', [
              this.signAccountOp.accountOp.chainId
            ])
            .then(() => this.signAccountOp?.simulate())
            .catch((e) => e)
        }
      }
    }

    if (!message) {
      message = getHumanReadableBroadcastError(_err || new Error('')).message

      // if the message states that the paymaster doesn't have sufficient amount,
      // add it to the failedPaymasters to disable it until a top-up is made
      if (message.includes(insufficientPaymasterFunds) && provider && network) {
        failedPaymasters.addInsufficientFunds(provider, network).then(() => {
          if (signAccountOp) {
            signAccountOp.simulate(false)
          }
        })
      }
      if (message.includes('the selected fee is too low')) {
        signAccountOp.gasPrice.fetch()
      }
    }

    // To enable another try for signing in case of broadcast fail
    // broadcast is called in the FE only after successful signing
    signAccountOp?.updateStatus(SigningStatus.ReadyToSign, isReplacementFeeLow)
    this.feePayerKey = null

    // remove the active route on broadcast failure
    if (signAccountOp?.accountOp.meta?.swapTxn) {
      this.swapAndBridge.removeActiveRoute(signAccountOp.accountOp.meta.swapTxn.activeRouteId)
    }

    throw new EmittableError({ level: 'major', message, error: _err || new Error(message) })
  }

  get isSignRequestStillActive(): boolean {
    if (!this.signAccountOp) return false

    return !!this.requests.actions.actionsQueue.find(
      (a) => a.id === this.signAccountOp!.fromActionId
    )
  }

  /**
   * Don't allow the user to open new action windows
   * if there's a pending to sign action (swap and bridge or transfer)
   * with a hardware wallet (аpplies to Trezor only, since it doesn't work in a pop-up and must be opened in an action window).
   * This is done to prevent complications with the signing process- e.g. a new request
   * being sent to the hardware wallet while the swap and bridge (or transfer) is still pending.
   * @returns {boolean} - true if an error was thrown
   * @throws {Error} - if throwRpcError is true
   */
  async #guardHWSigning(throwRpcError = false): Promise<boolean> {
    const pendingAction = this.requests.actions.visibleActionsQueue.find(
      ({ type }) => type === 'swapAndBridge' || type === 'transfer'
    )

    if (!pendingAction) return false

    const isSigningOrBroadcasting =
      this.statuses.signAndBroadcastAccountOp === 'SIGNING' ||
      this.statuses.signAndBroadcastAccountOp === 'BROADCASTING'

    // The swap and bridge or transfer is done/forgotten so we can remove the action
    if (!isSigningOrBroadcasting) {
      await this.requests.actions.removeActions([pendingAction.id])

      if (pendingAction.type === 'swapAndBridge') {
        this.swapAndBridge.reset()
      } else {
        this.transfer.resetForm()
      }

      return false
    }

    const errors = {
      swapAndBridge: {
        message: 'Please complete the pending swap action.',
        error: 'Pending swap action',
        rpcError: 'You have a pending swap action. Please complete it before signing.'
      },
      transfer: {
        message: 'Please complete the pending transfer action.',
        error: 'Pending transfer action',
        rpcError: 'You have a pending transfer action. Please complete it before signing.'
      }
    }

    const error = errors[pendingAction.type as keyof typeof errors]

    await this.requests.actions.focusActionWindow()
    this.emitError({
      level: 'major',
      message: error.message,
      error: new Error(error.error)
    })

    if (throwRpcError) {
      throw ethErrors.rpc.transactionRejected({
        message: error.rpcError
      })
    }

    return true
  }

  // includes the getters in the stringified instance
  toJSON() {
    return {
      ...this,
      ...super.toJSON(),
      isSignRequestStillActive: this.isSignRequestStillActive
    }
  }
}

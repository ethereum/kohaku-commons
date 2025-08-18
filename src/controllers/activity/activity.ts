import { Account, AccountId } from '../../interfaces/account'
import { Banner, BannerCategory, BannerType } from '../../interfaces/banner'
import { Fetch } from '../../interfaces/fetch'
import { Network } from '../../interfaces/network'
import { isSmartAccount } from '../../libs/account/account'
import {
  AccountOpIdentifiedBy,
  fetchFrontRanTxnId,
  fetchTxnId,
  isIdentifiedByRelayer,
  isIdentifiedByUserOpHash,
  SubmittedAccountOp,
  updateOpStatus
} from '../../libs/accountOp/submittedAccountOp'
import { AccountOpStatus } from '../../libs/accountOp/types'
/* eslint-disable import/no-extraneous-dependencies */
import { getTransferLogTokens } from '../../libs/logsParser/parseLogs'
import { parseLogs } from '../../libs/userOperation/userOperation'
import { getBenzinUrlParams } from '../../utils/benzin'
import wait from '../../utils/wait'
import { AccountsController } from '../accounts/accounts'
import EventEmitter from '../eventEmitter/eventEmitter'
import { NetworksController } from '../networks/networks'
import { PortfolioController } from '../portfolio/portfolio'
import { ProvidersController } from '../providers/providers'
import { SelectedAccountController } from '../selectedAccount/selectedAccount'
import { StorageController } from '../storage/storage'
import { InternalSignedMessages, SignedMessage } from './types'

export interface Pagination {
  fromPage: number
  itemsPerPage: number
}

interface PaginationResult<T> {
  items: T[]
  itemsTotal: number
  currentPage: number
  maxPages: number
}

interface AccountsOps extends PaginationResult<SubmittedAccountOp> {}
interface MessagesToBeSigned extends PaginationResult<SignedMessage> {}

export interface Filters {
  account: string
  chainId?: bigint
}

export interface InternalAccountsOps {
  // account => network => SubmittedAccountOp[]
  [key: string]: { [key: string]: SubmittedAccountOp[] }
}

// We are limiting items array to include no more than 1000 records,
// as we trim out the oldest ones (in the beginning of the items array).
// We do this to maintain optimal storage and performance.
const trim = <T>(items: T[], maxSize = 1000): void => {
  if (items.length > maxSize) {
    // If the array size is greater than maxSize, remove the last (oldest) item
    // newest items are added to the beginning of the array so oldest will be at the end (thats why we .pop())
    items.pop()
  }
}

const paginate = (items: any[], fromPage: number, itemsPerPage: number) => {
  return {
    items: items.slice(fromPage * itemsPerPage, fromPage * itemsPerPage + itemsPerPage),
    itemsTotal: items.length,
    currentPage: fromPage, // zero/index based
    maxPages: Math.ceil(items.length / itemsPerPage)
  }
}

const CONFIRMED_STATUSES = [AccountOpStatus.Success, AccountOpStatus.UnknownButPastNonce]

const BANNER_CONTENT: {
  category: BannerCategory
  title: string
  type: BannerType
  statuses: AccountOpStatus[]
}[] = [
  {
    category: 'pending-to-be-confirmed-acc-op',
    type: 'success',
    title:
      'Transaction was successfully signed and broadcasted!\nCheck it out on the block explorer!',
    statuses: [AccountOpStatus.Pending, AccountOpStatus.BroadcastedButNotConfirmed]
  },
  {
    category: 'successful-acc-op',
    type: 'success',
    title: 'Transaction confirmed!\nCheck it out on the block explorer!',
    statuses: CONFIRMED_STATUSES
  },
  {
    category: 'failed-acc-op',
    type: 'error',
    title: 'Transaction failed!\nCheck it out on the block explorer!',
    statuses: [AccountOpStatus.Failure, AccountOpStatus.Rejected]
  }
]

/**
 * Activity Controller
 * Manages signed AccountsOps and Messages in controller memory and browser storage.
 *
 * Raw, unfiltered data is stored in private properties `ActivityController.#accountsOps` and
 * `ActivityController.#signedMessages`.
 *
 * Public methods and properties are exposed for retrieving data with filtering and pagination.
 *
 * To apply filters or pagination, call `filterAccountsOps()` or `filterSignedMessages()` with the
 * required parameters. Filtered items are stored in `ActivityController.accountsOps` and
 * `ActivityController.signedMessages` by session ID.
 *
 * Sessions ensure that each page manages its own filters and pagination independently. For example,
 * filters in "Settings -> Transactions History" and "Dashboard -> Activity Tab" are isolated per session.
 *
 * After adding or removing an AccountOp or SignedMessage, call `syncFilteredAccountsOps()` or
 * `syncFilteredSignedMessages()` to synchronize filtered data with the source data.
 *
 * The frontend is responsible for clearing filtered items for a session when a component unmounts
 * by calling `resetAccountsOpsFilters()` or `resetSignedMessagesFilters()`. If not cleared, all
 * sessions will be automatically removed when the browser is closed or the controller terminates.
 *
 * 💡 For performance, items per account and network are limited to 1000.
 * Older items are trimmed, keeping the most recent ones.
 */
export class ActivityController extends EventEmitter {
  #storage: StorageController

  #fetch: Fetch

  #initialLoadPromise: Promise<void>

  #accounts: AccountsController

  #selectedAccount: SelectedAccountController

  #accountsOps: InternalAccountsOps = {}

  accountsOps: {
    [sessionId: string]: {
      result: AccountsOps
      filters: Filters
      pagination: Pagination
    }
  } = {}

  #signedMessages: InternalSignedMessages = {}

  signedMessages: {
    [sessionId: string]: {
      result: MessagesToBeSigned
      filters: Filters
      pagination: Pagination
    }
  } = {}

  #providers: ProvidersController

  #networks: NetworksController

  #portfolio: PortfolioController

  #onContractsDeployed: (network: Network) => Promise<void>

  #rbfStatuses = [AccountOpStatus.BroadcastedButNotConfirmed, AccountOpStatus.BroadcastButStuck]

  #callRelayer: Function

  #bannerUpdateTimeout: NodeJS.Timeout | null = null

  banners: Banner[] = []

  constructor(
    storage: StorageController,
    fetch: Fetch,
    callRelayer: Function,
    accounts: AccountsController,
    selectedAccount: SelectedAccountController,
    providers: ProvidersController,
    networks: NetworksController,
    portfolio: PortfolioController,
    onContractsDeployed: (network: Network) => Promise<void>
  ) {
    super()
    this.#storage = storage
    this.#fetch = fetch
    this.#callRelayer = callRelayer
    this.#accounts = accounts
    this.#selectedAccount = selectedAccount
    this.#providers = providers
    this.#networks = networks
    this.#portfolio = portfolio
    this.#onContractsDeployed = onContractsDeployed
    this.#initialLoadPromise = this.#load()
  }

  async #load(): Promise<void> {
    await this.#accounts.initialLoadPromise
    await this.#selectedAccount.initialLoadPromise
    const [accountsOps, signedMessages] = await Promise.all([
      this.#storage.get('accountsOps', {}),
      this.#storage.get('signedMessages', {})
    ])

    this.#accountsOps = accountsOps
    this.#signedMessages = signedMessages

    this.emitUpdate()
  }

  async filterAccountsOps(
    sessionId: string,
    filters: Filters,
    pagination: Pagination = {
      fromPage: 0,
      itemsPerPage: 10
    }
  ) {
    await this.#initialLoadPromise

    let filteredItems

    if (filters.chainId) {
      filteredItems = this.#accountsOps[filters.account]?.[filters.chainId.toString()] || []
    } else {
      filteredItems = Object.values(this.#accountsOps[filters.account] || []).flat()
      // By default, #accountsOps are grouped by network and sorted in descending order.
      // However, when the network filter is omitted, #accountsOps from different networks are mixed,
      // requiring additional sorting to ensure they are also in descending order.
      filteredItems.sort((a, b) => b.timestamp - a.timestamp)
    }

    const result = paginate(filteredItems, pagination.fromPage, pagination.itemsPerPage)

    this.accountsOps[sessionId] = {
      result,
      filters,
      pagination
    }

    this.emitUpdate()
  }

  // Reset filtered AccountsOps session.
  // Example: when a FE component is being unmounted, we don't need anymore the filtered accounts ops and we
  // free the memory calling this method.
  resetAccountsOpsFilters(sessionId: string) {
    delete this.accountsOps[sessionId]
    this.emitUpdate()
  }

  // Everytime we add/remove an AccOp, we should run this method in order to keep the filtered and internal accounts ops in sync.
  private async syncFilteredAccountsOps() {
    const promises = Object.keys(this.accountsOps).map(async (sessionId) => {
      await this.filterAccountsOps(
        sessionId,
        this.accountsOps[sessionId].filters,
        this.accountsOps[sessionId].pagination
      )
    })

    await Promise.all(promises)
  }

  async filterSignedMessages(
    sessionId: string,
    filters: Filters,
    pagination: Pagination = {
      fromPage: 0,
      itemsPerPage: 10
    }
  ) {
    await this.#initialLoadPromise

    const filteredItems = this.#signedMessages[filters.account] || []

    const result = paginate(filteredItems, pagination.fromPage, pagination.itemsPerPage)

    this.signedMessages[sessionId] = {
      result,
      filters,
      pagination
    }

    this.emitUpdate()
  }

  // Reset filtered Messages session.
  // Example: when a FE component is being unmounted, we don't need anymore the filtered messages and we
  // free the memory calling this method.
  resetSignedMessagesFilters(sessionId: string) {
    delete this.signedMessages[sessionId]
    this.emitUpdate()
  }

  // Everytime we add/remove a Message, we should run this method in order to keep the filtered and internal messages in sync.
  private async syncSignedMessages() {
    const promises = Object.keys(this.signedMessages).map(async (sessionId) => {
      await this.filterSignedMessages(
        sessionId,
        this.signedMessages[sessionId].filters,
        this.signedMessages[sessionId].pagination
      )
    })

    await Promise.all(promises)
  }

  /**
   * Hides the banners of confirmed accountOps. The idea is to prevent
   * displaying too many banners at once. Banners of failed transactions
   * are not hidden, as they are useful for the user to see.
   */
  private hideBannersOfConfirmedAccountOps() {
    if (!this.#selectedAccount.account || !this.#accountsOps[this.#selectedAccount.account.addr])
      return

    const latestAccountOps = Object.values(this.#accountsOps[this.#selectedAccount.account.addr])
      .flat()
      .sort((a, b) => b.timestamp - a.timestamp)
      // Performance optimization. There is a very low probability that the user will have
      // more than 9 pending or failed account ops at the same time.
      // Even if some user has more than 10 he can close the banner manually
      .slice(0, 10)

    latestAccountOps.forEach((accountOp) => {
      if (
        accountOp.status &&
        CONFIRMED_STATUSES.includes(accountOp.status) &&
        !accountOp.flags?.hideActivityBanner
      ) {
        // eslint-disable-next-line no-param-reassign
        if (!accountOp.flags) accountOp.flags = {}

        // eslint-disable-next-line no-param-reassign
        accountOp.flags.hideActivityBanner = true
      }
    })
  }

  /**
   * Starts a timeout to update banners ONLY if there are banners to update.
   */
  private startBannerUpdateTimeout() {
    if (this.#bannerUpdateTimeout) {
      this.stopBannerUpdateTimeout()
    }

    if (!this.banners.length) return

    this.#bannerUpdateTimeout = setTimeout(() => {
      this.updateAccountOpBanners()
      this.emitUpdate()
      this.startBannerUpdateTimeout()
    }, 1000 * 60 * 1)
  }

  /**
   * Stops the banner update timeout if it exists.
   */
  private stopBannerUpdateTimeout() {
    if (this.#bannerUpdateTimeout) {
      clearTimeout(this.#bannerUpdateTimeout)
      this.#bannerUpdateTimeout = null
    }
  }

  /**
   * Updates banners based on the latest accountOps.
   * A getter cannot be used, because banners have a lifetime
   * of X minutes. The UI won't know when a banner has
   * expired, until an update is emitted.
   */
  private updateAccountOpBanners() {
    if (
      !this.#networks.isInitialized ||
      !this.#selectedAccount.account ||
      !this.#accountsOps[this.#selectedAccount.account.addr]
    ) {
      this.banners = []
      this.stopBannerUpdateTimeout()
      return
    }

    const latestAccountOps = Object.values(this.#accountsOps[this.#selectedAccount.account.addr])
      .flat()
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 10) // Performance optimization: only check the last 10 ops

    const accountOpsToTurnToBanners = latestAccountOps.filter((accountOp) => {
      const TEN_MINUTES = 1000 * 60 * 10
      const isClosed = accountOp.flags && accountOp.flags.hideActivityBanner
      const isRecent = accountOp.timestamp >= Date.now() - TEN_MINUTES
      const isBroadcasted =
        accountOp.status !== AccountOpStatus.Pending &&
        accountOp.status !== AccountOpStatus.Rejected

      return isRecent && !isClosed && isBroadcasted
    }, [] as SubmittedAccountOp[])

    if (!accountOpsToTurnToBanners.length) {
      this.banners = []
      this.stopBannerUpdateTimeout()
      return
    }

    this.banners = accountOpsToTurnToBanners.map((accountOp) => {
      const url = `https://explorer.ambire.com/${getBenzinUrlParams({
        chainId: accountOp.chainId,
        txnId: accountOp.txnId,
        identifiedBy: accountOp.identifiedBy
      })}`

      const content = BANNER_CONTENT.find((c) =>
        c.statuses.includes(accountOp.status as AccountOpStatus)
      )

      return {
        id: accountOp.txnId || accountOp.identifiedBy.identifier,
        type: content?.type || 'success',
        category: content?.category || 'pending-to-be-confirmed-acc-op',
        title:
          content?.title ||
          'Transaction successfully signed and sent!\nCheck it out on the block explorer!',
        text: '',
        actions: [
          {
            label: 'Close',
            actionName: 'hide-activity-banner',
            meta: {
              addr: accountOp.accountAddr,
              chainId: accountOp.chainId,
              timestamp: accountOp.timestamp,
              isHideStyle: true
            }
          },
          {
            label: 'Check',
            actionName: 'open-external-url' as const,
            meta: { url }
          }
        ] as Banner['actions']
      }
    })
    this.startBannerUpdateTimeout()
  }

  removeNetworkData(chainId: bigint) {
    Object.keys(this.accountsOps).forEach(async (sessionId) => {
      const state = this.accountsOps[sessionId]
      const isFilteredByRemovedNetwork = state.filters.chainId === chainId

      if (isFilteredByRemovedNetwork) {
        await this.filterAccountsOps(
          sessionId,
          { account: state.filters.account },
          state.pagination
        )
      }
    })
  }

  async addAccountOp(accountOp: SubmittedAccountOp) {
    await this.#initialLoadPromise

    const { accountAddr, chainId } = accountOp

    if (!this.#accountsOps[accountAddr]) this.#accountsOps[accountAddr] = {}
    if (!this.#accountsOps[accountAddr][chainId.toString()])
      this.#accountsOps[accountAddr][chainId.toString()] = []

    // Hide confirmed banners first as that will modify this.#accountsOps
    this.hideBannersOfConfirmedAccountOps()

    // newest SubmittedAccountOp goes first in the list
    this.#accountsOps[accountAddr][chainId.toString()].unshift({ ...accountOp })
    trim(this.#accountsOps[accountAddr][chainId.toString()])

    await this.syncFilteredAccountsOps()
    this.updateAccountOpBanners()

    await this.#storage.set('accountsOps', this.#accountsOps)
    this.emitUpdate()
  }

  /**
   * Update AccountsOps statuses (inner and public state, and storage)
   *
   * Here is the algorithm:
   * 0. Once we broadcast an AccountOp, we are adding it to ActivityController via `addAccountOp`,
   * and are setting its status to AccountOpStatus.BroadcastedButNotConfirmed.
   * 1. Here, we firstly rely on `getTransactionReceipt` for determining the status (success or failure).
   * 2. If we don't manage to determine its status, we are comparing AccountOp and Account nonce.
   * If Account nonce is greater than AccountOp, then we know that AccountOp has past nonce (AccountOpStatus.UnknownButPastNonce).
   */
  async updateAccountsOpsStatuses(): Promise<{
    shouldEmitUpdate: boolean
    shouldUpdatePortfolio: boolean
    updatedAccountsOps: SubmittedAccountOp[]
    newestOpTimestamp: number
  }> {
    await this.#initialLoadPromise

    if (!this.#selectedAccount.account || !this.#accountsOps[this.#selectedAccount.account.addr])
      return {
        shouldEmitUpdate: false,
        shouldUpdatePortfolio: false,
        updatedAccountsOps: [],
        newestOpTimestamp: 0
      }

    // This flag tracks the changes to AccountsOps statuses
    // and optimizes the number of the emitted updates and storage/state updates.
    let shouldEmitUpdate = false

    let shouldUpdatePortfolio = false
    const updatedAccountsOps: SubmittedAccountOp[] = []

    // Use this flag to make the auto-refresh slower with the passege of time.
    // implementation is in background.ts
    let newestOpTimestamp: number = 0

    await Promise.all(
      Object.keys(this.#accountsOps[this.#selectedAccount.account.addr]).map(
        async (keyAsChainId) => {
          const network = this.#networks.networks.find((n) => n.chainId.toString() === keyAsChainId)
          if (!network) return
          const provider = this.#providers.providers[network.chainId.toString()]

          const selectedAccount = this.#selectedAccount.account?.addr

          if (!selectedAccount) return

          return Promise.all(
            this.#accountsOps[selectedAccount][network.chainId.toString()].map(
              async (accountOp, accountOpIndex) => {
                // Don't update the current network account ops statuses,
                // as the statuses are already updated in the previous calls.
                if (accountOp.status !== AccountOpStatus.BroadcastedButNotConfirmed) return

                shouldEmitUpdate = true

                if (newestOpTimestamp === undefined || newestOpTimestamp < accountOp.timestamp) {
                  newestOpTimestamp = accountOp.timestamp
                }

                const declareStuckIfQuaterPassed = (op: SubmittedAccountOp) => {
                  const accountOpDate = new Date(op.timestamp)
                  accountOpDate.setMinutes(accountOpDate.getMinutes() + 15)
                  const aQuaterHasPassed = accountOpDate < new Date()
                  if (aQuaterHasPassed) {
                    const updatedOpIfAny = updateOpStatus(
                      this.#accountsOps[selectedAccount][network.chainId.toString()][
                        accountOpIndex
                      ],
                      AccountOpStatus.BroadcastButStuck
                    )
                    if (updatedOpIfAny) updatedAccountsOps.push(updatedOpIfAny)
                  }
                }

                const fetchTxnIdResult = await fetchTxnId(
                  accountOp.identifiedBy,
                  network,
                  this.#fetch,
                  this.#callRelayer,
                  accountOp
                )
                if (fetchTxnIdResult.status === 'rejected') {
                  const updatedOpIfAny = updateOpStatus(
                    this.#accountsOps[selectedAccount][network.chainId.toString()][accountOpIndex],
                    AccountOpStatus.Rejected
                  )
                  if (updatedOpIfAny) updatedAccountsOps.push(updatedOpIfAny)
                  return
                }
                if (fetchTxnIdResult.status === 'not_found') {
                  declareStuckIfQuaterPassed(accountOp)
                  return
                }

                const txnId = fetchTxnIdResult.txnId as string
                this.#accountsOps[selectedAccount][network.chainId.toString()][
                  accountOpIndex
                ].txnId = txnId

                try {
                  let receipt = await provider.getTransactionReceipt(txnId)
                  if (receipt) {
                    // if the status is a failure and it's an userOp, it means it
                    // could've been front ran. We need to make sure we find the
                    // transaction that has succeeded
                    if (!receipt.status && isIdentifiedByUserOpHash(accountOp.identifiedBy)) {
                      const frontRanTxnId = await fetchFrontRanTxnId(
                        accountOp.identifiedBy,
                        txnId,
                        network
                      )
                      this.#accountsOps[selectedAccount][network.chainId.toString()][
                        accountOpIndex
                      ].txnId = frontRanTxnId
                      receipt = await provider.getTransactionReceipt(frontRanTxnId)
                      if (!receipt) return
                    }

                    // if this is an user op, we have to check the logs
                    let isSuccess: boolean | undefined
                    if (isIdentifiedByUserOpHash(accountOp.identifiedBy)) {
                      const userOpEventLog = parseLogs(
                        receipt.logs,
                        accountOp.identifiedBy.identifier
                      )
                      if (userOpEventLog) isSuccess = userOpEventLog.success
                    }

                    // if it's not an userOp or it is, but isSuccess was not found
                    if (isSuccess === undefined) isSuccess = !!receipt.status

                    // This must be done before updateOpStatus is called
                    // otherwise the function will hide the banner of this accountOp
                    this.hideBannersOfConfirmedAccountOps()

                    const updatedOpIfAny = updateOpStatus(
                      this.#accountsOps[selectedAccount][network.chainId.toString()][
                        accountOpIndex
                      ],
                      isSuccess ? AccountOpStatus.Success : AccountOpStatus.Failure,
                      receipt
                    )
                    if (updatedOpIfAny) updatedAccountsOps.push(updatedOpIfAny)

                    if (receipt.status) {
                      shouldUpdatePortfolio = true
                    }

                    if (accountOp.isSingletonDeploy && receipt.status) {
                      await this.#onContractsDeployed(network)
                    }

                    // learn tokens from the transfer logs
                    if (isSuccess) {
                      const foundTokens = await getTransferLogTokens(
                        receipt.logs,
                        accountOp.accountAddr
                      )
                      if (foundTokens.length) {
                        this.#portfolio.addTokensToBeLearned(foundTokens, accountOp.chainId)
                      }
                    }

                    return
                  }

                  // if there's no receipt, confirm there's a txn
                  // if there's no txn and 15 minutes have passed, declare it a failure
                  const txn = await provider.getTransaction(txnId)
                  if (txn) return
                  declareStuckIfQuaterPassed(accountOp)
                } catch {
                  this.emitError({
                    level: 'silent',
                    message: `Failed to determine transaction status on network with id ${accountOp.chainId} for ${accountOp.txnId}.`,
                    error: new Error(
                      `activity: failed to get transaction receipt for ${accountOp.txnId}`
                    )
                  })
                }

                // if there are more than 1 txns with the same nonce and payer,
                // we can conclude this one is replaced by fee
                //
                // Comment out this code as it's doing more bad than good.
                // In order to track rbf transactions, we need a per account unique nonce
                // in submitted account op first
                // const sameNonceTxns = this.#accountsOps[selectedAccount][
                //   network.chainId.toString()
                // ].filter(
                //   (accOp) =>
                //     accOp.gasFeePayment &&
                //     accountOp.gasFeePayment &&
                //     accOp.gasFeePayment.paidBy === accountOp.gasFeePayment.paidBy &&
                //     accOp.nonce.toString() === accountOp.nonce.toString()
                // )
                // const confirmedSameNonceTxns = sameNonceTxns.find(
                //   (accOp) =>
                //     accOp.status === AccountOpStatus.Success ||
                //     accOp.status === AccountOpStatus.Failure
                // )
                // if (sameNonceTxns.length > 1 && !!confirmedSameNonceTxns) {
                //   const updatedOpIfAny = updateOpStatus(
                //     this.#accountsOps[selectedAccount][network.chainId.toString()][accountOpIndex],
                //     AccountOpStatus.UnknownButPastNonce
                //   )
                //   if (updatedOpIfAny) updatedAccountsOps.push(updatedOpIfAny)
                //   shouldUpdatePortfolio = true
                // }
              }
            )
          )
        }
      )
    )

    if (shouldEmitUpdate) {
      await this.#storage.set('accountsOps', this.#accountsOps)
      await this.syncFilteredAccountsOps()
      this.updateAccountOpBanners()
      this.emitUpdate()
    }

    return { shouldEmitUpdate, shouldUpdatePortfolio, updatedAccountsOps, newestOpTimestamp }
  }

  async addSignedMessage(signedMessage: SignedMessage, account: string) {
    await this.#initialLoadPromise

    if (!this.#signedMessages[account]) this.#signedMessages[account] = []

    // newest SignedMessage goes first in the list
    this.#signedMessages[account].unshift(signedMessage)
    trim(this.#signedMessages[account])
    await this.syncSignedMessages()

    await this.#storage.set('signedMessages', this.#signedMessages)
    this.emitUpdate()
  }

  async removeAccountData(address: Account['addr']) {
    await this.#initialLoadPromise

    delete this.#accountsOps[address]
    delete this.#signedMessages[address]

    await this.syncFilteredAccountsOps()
    await this.syncSignedMessages()

    await this.#storage.set('accountsOps', this.#accountsOps)
    await this.#storage.set('signedMessages', this.#signedMessages)

    this.emitUpdate()
  }

  async hideBanner({
    addr,
    chainId,
    timestamp
  }: {
    addr: string
    chainId: bigint
    timestamp: number
  }) {
    await this.#initialLoadPromise

    // shouldn't happen
    if (!this.#accountsOps[addr]) return
    if (!this.#accountsOps[addr][chainId.toString()]) return

    // find the op we want to update
    const op = this.#accountsOps[addr][chainId.toString()].find(
      (accOp) => accOp.timestamp === timestamp
    )
    if (!op) return

    // update by reference
    if (!op.flags) op.flags = {}
    op.flags.hideActivityBanner = true

    this.updateAccountOpBanners()
    this.emitUpdate()

    await this.#storage.set('accountsOps', this.#accountsOps)
  }

  get broadcastedButNotConfirmed(): SubmittedAccountOp[] {
    if (!this.#selectedAccount.account || !this.#accountsOps[this.#selectedAccount.account.addr])
      return []

    return Object.values(this.#accountsOps[this.#selectedAccount.account.addr] || {})
      .flat()
      .filter((accountOp) => accountOp.status === AccountOpStatus.BroadcastedButNotConfirmed)
  }

  /**
   * A not confirmed account op can actually be with a status of BroadcastButNotConfirmed
   * and BroadcastButStuck. Typically, it becomes BroadcastButStuck if not confirmed
   * in a 15 minutes interval after becoming BroadcastButNotConfirmed. We need two
   * statuses to hide the banner of BroadcastButNotConfirmed from the dashboard.
   */
  getNotConfirmedOpIfAny(accId: AccountId, chainId: bigint): SubmittedAccountOp | null {
    const acc = this.#accounts.accounts.find((oneA) => oneA.addr === accId)
    if (!acc) return null

    // if the broadcasting account is a smart account, it means relayer
    // broadcast => it's in this.#accountsOps[acc.addr][chainId]
    // disregard erc-4337 txns as they shouldn't have an RBF
    const isSA = isSmartAccount(acc)
    if (isSA) {
      if (!this.#accountsOps[acc.addr] || !this.#accountsOps[acc.addr][chainId.toString(0)])
        return null
      if (!this.#rbfStatuses.includes(this.#accountsOps[acc.addr][chainId.toString(0)][0].status!))
        return null

      return this.#accountsOps[acc.addr][chainId.toString(0)][0]
    }

    // if the account is an EOA, we have to go through all the smart accounts
    // to check whether the EOA has made a broadcast for them
    const theEOAandSAaccounts = this.#accounts.accounts.filter(
      (oneA) => isSmartAccount(oneA) || oneA.addr === accId
    )
    const ops: SubmittedAccountOp[] = []
    theEOAandSAaccounts.forEach((oneA) => {
      if (!this.#accountsOps[oneA.addr] || !this.#accountsOps[oneA.addr][chainId.toString()]) return
      const op = this.#accountsOps[oneA.addr][chainId.toString()].find(
        (oneOp) =>
          this.#rbfStatuses.includes(this.#accountsOps[oneA.addr][chainId.toString()][0].status!) &&
          oneOp.gasFeePayment?.paidBy === oneA.addr
      )
      if (!op) return
      ops.push(op)
    })
    return !ops.length ? null : ops.reduce((m, e) => (e.nonce > m.nonce ? e : m))
  }

  async findMessage(account: string, filter: (item: SignedMessage) => boolean) {
    await this.#initialLoadPromise

    if (!this.#signedMessages[account]) return null

    return this.#signedMessages[account].find(filter)
  }

  // return a txn id only if we have certainty that this is the final txn id:
  // EOA broadcast: 100% certainty on broadcast
  // Relayer | Bundler broadcast: once we have a receipt as there could be
  // front running or txnId replacement issues
  async getConfirmedTxId(
    submittedAccountOp: SubmittedAccountOp,
    counter = 0
  ): Promise<string | undefined> {
    if (
      !this.#accountsOps[submittedAccountOp.accountAddr] ||
      !this.#accountsOps[submittedAccountOp.accountAddr][submittedAccountOp.chainId.toString()]
    )
      return undefined

    const activityAccountOp = this.#accountsOps[submittedAccountOp.accountAddr][
      submittedAccountOp.chainId.toString()
    ].find((op) => op.identifiedBy === submittedAccountOp.identifiedBy)
    // shouldn't happen
    if (!activityAccountOp) return undefined

    if (
      !isIdentifiedByUserOpHash(activityAccountOp.identifiedBy) &&
      !isIdentifiedByRelayer(activityAccountOp.identifiedBy)
    )
      return activityAccountOp.txnId

    // @frontrunning
    if (
      activityAccountOp.status === AccountOpStatus.Pending ||
      activityAccountOp.status === AccountOpStatus.BroadcastedButNotConfirmed
    ) {
      // if the receipt cannot be confirmed after a lot of retries, continue on
      if (counter >= 30) return activityAccountOp.txnId

      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      await wait(1000)
      return this.getConfirmedTxId(submittedAccountOp, counter + 1)
    }

    return activityAccountOp.txnId
  }

  findByIdentifiedBy(
    identifiedBy: AccountOpIdentifiedBy,
    accountAddr: string,
    chainId: bigint
  ): SubmittedAccountOp | undefined {
    if (!this.#accountsOps[accountAddr] || !this.#accountsOps[accountAddr][chainId.toString()]) {
      return undefined
    }

    return this.#accountsOps[accountAddr][chainId.toString()].find(
      (op) => op.identifiedBy.identifier === identifiedBy.identifier
    )
  }

  toJSON() {
    return {
      ...this,
      ...super.toJSON(),
      broadcastedButNotConfirmed: this.broadcastedButNotConfirmed, // includes the getter in the stringified instance
      banners: this.banners // includes the getter in the stringified instance
    }
  }
}

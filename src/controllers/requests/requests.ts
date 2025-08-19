/* eslint-disable no-await-in-loop */
import { ethErrors } from 'eth-rpc-errors'
import { getAddress, getBigInt } from 'ethers'

import { buildSignUserRequest } from '../privacy/buildRequest'
import EmittableError from '../../classes/EmittableError'
import { Session } from '../../classes/session'
import SwapAndBridgeError from '../../classes/SwapAndBridgeError'
import { ORIGINS_WHITELISTED_TO_ALL_ACCOUNTS } from '../../consts/dappCommunication'
import { AccountId } from '../../interfaces/account'
import { Banner } from '../../interfaces/banner'
import { DappProviderRequest } from '../../interfaces/dapp'
import { Network } from '../../interfaces/network'
import { NotificationManager } from '../../interfaces/notification'
import { BuildRequest } from '../../interfaces/requests'
import {
  SwapAndBridgeActiveRoute,
  SwapAndBridgeSendTxRequest
} from '../../interfaces/swapAndBridge'
import { Calls, DappUserRequest, SignUserRequest, UserRequest } from '../../interfaces/userRequest'
import { WindowManager } from '../../interfaces/window'
import { isBasicAccount, isSmartAccount } from '../../libs/account/account'
import { getBaseAccount } from '../../libs/account/getBaseAccount'
import { Call } from '../../libs/accountOp/types'
// eslint-disable-next-line import/no-cycle
import {
  dappRequestMethodToActionKind,
  getAccountOpActionsByNetwork
} from '../../libs/actions/actions'
import { getAccountOpBanners } from '../../libs/banners/banners'
import { getAmbirePaymasterService, getPaymasterService } from '../../libs/erc7677/erc7677'
import { TokenResult } from '../../libs/portfolio'
import {
  ACCOUNT_SWITCH_USER_REQUEST,
  buildSwitchAccountUserRequest,
  makeAccountOpAction
} from '../../libs/requests/requests'
import { parse } from '../../libs/richJson/richJson'
import {
  buildSwapAndBridgeUserRequests,
  getActiveRoutesForAccount
} from '../../libs/swapAndBridge/swapAndBridge'
import {
  buildClaimWalletRequest,
  buildMintVestingRequest,
  buildTransferUserRequest,
  prepareIntentUserRequest
} from '../../libs/transfer/userRequest'
import { AccountsController } from '../accounts/accounts'
// eslint-disable-next-line import/no-cycle
import {
  AccountOpAction,
  Action,
  ActionExecutionType,
  ActionPosition,
  ActionsController
} from '../actions/actions'
import { DappsController } from '../dapps/dapps'
import EventEmitter, { Statuses } from '../eventEmitter/eventEmitter'
import { KeystoreController } from '../keystore/keystore'
import { NetworksController } from '../networks/networks'
import { ProvidersController } from '../providers/providers'
// eslint-disable-next-line import/no-cycle
import { SelectedAccountController } from '../selectedAccount/selectedAccount'
import { SignAccountOpController, SignAccountOpUpdateProps } from '../signAccountOp/signAccountOp'
import { SwapAndBridgeController, SwapAndBridgeFormStatus } from '../swapAndBridge/swapAndBridge'
import { TransactionManagerController } from '../transaction/transactionManager'
import { TransferController } from '../transfer/transfer'

const STATUS_WRAPPED_METHODS = {
  buildSwapAndBridgeUserRequest: 'INITIAL'
} as const

/**
 * The RequestsController is responsible for building different user request types and managing their associated actions (within an action window).
 * Prior to v2.66.0, all request logic resided in the MainController. To improve scalability, readability,
 * and testability, this logic was encapsulated in this dedicated controller.
 */
export class RequestsController extends EventEmitter {
  #relayerUrl: string

  #accounts: AccountsController

  #networks: NetworksController

  #providers: ProvidersController

  #selectedAccount: SelectedAccountController

  #keystore: KeystoreController

  #dapps: DappsController

  #transfer: TransferController

  #swapAndBridge: SwapAndBridgeController

  #transactionManager?: TransactionManagerController

  #getSignAccountOp: () => SignAccountOpController | null

  #updateSignAccountOp: (props: SignAccountOpUpdateProps) => void

  #destroySignAccountOp: () => void

  #updateSelectedAccountPortfolio: (networks?: Network[]) => Promise<void>

  #addTokensToBeLearned: (tokenAddresses: string[], chainId: bigint) => void

  #guardHWSigning: (throwRpcError: boolean) => Promise<boolean>

  userRequests: UserRequest[] = []

  userRequestsWaitingAccountSwitch: UserRequest[] = []

  actions: ActionsController

  statuses: Statuses<keyof typeof STATUS_WRAPPED_METHODS> = STATUS_WRAPPED_METHODS

  // Holds the initial load promise, so that one can wait until it completes
  initialLoadPromise: Promise<void>

  constructor({
    relayerUrl,
    accounts,
    networks,
    providers,
    selectedAccount,
    keystore,
    dapps,
    transfer,
    swapAndBridge,
    transactionManager,
    windowManager,
    notificationManager,
    getSignAccountOp,
    updateSignAccountOp,
    destroySignAccountOp,
    updateSelectedAccountPortfolio,
    addTokensToBeLearned,
    guardHWSigning
  }: {
    relayerUrl: string
    accounts: AccountsController
    networks: NetworksController
    providers: ProvidersController
    selectedAccount: SelectedAccountController
    keystore: KeystoreController
    dapps: DappsController
    transfer: TransferController
    swapAndBridge: SwapAndBridgeController
    transactionManager?: TransactionManagerController
    windowManager: WindowManager
    notificationManager: NotificationManager
    getSignAccountOp: () => SignAccountOpController | null
    updateSignAccountOp: (props: SignAccountOpUpdateProps) => void
    destroySignAccountOp: () => void
    updateSelectedAccountPortfolio: (networks?: Network[]) => Promise<void>
    addTokensToBeLearned: (tokenAddresses: string[], chainId: bigint) => void
    guardHWSigning: (throwRpcError: boolean) => Promise<boolean>
  }) {
    super()

    this.#relayerUrl = relayerUrl
    this.#accounts = accounts
    this.#networks = networks
    this.#providers = providers
    this.#selectedAccount = selectedAccount
    this.#keystore = keystore
    this.#dapps = dapps
    this.#transfer = transfer
    this.#swapAndBridge = swapAndBridge
    this.#transactionManager = transactionManager

    this.#getSignAccountOp = getSignAccountOp
    this.#updateSignAccountOp = updateSignAccountOp
    this.#destroySignAccountOp = destroySignAccountOp
    this.#updateSelectedAccountPortfolio = updateSelectedAccountPortfolio
    this.#addTokensToBeLearned = addTokensToBeLearned
    this.#guardHWSigning = guardHWSigning

    this.actions = new ActionsController({
      selectedAccount: this.#selectedAccount,
      windowManager,
      notificationManager,
      onActionWindowClose: async () => {
        // eslint-disable-next-line no-restricted-syntax
        for (const r of this.userRequests) {
          if (r.action.kind === 'walletAddEthereumChain') {
            const chainId = r.action.params?.[0]?.chainId
            // eslint-disable-next-line no-continue
            if (!chainId) continue

            const network = this.#networks.networks.find((n) => n.chainId === BigInt(chainId))
            if (network && !network.disabled) {
              await this.resolveUserRequest(null, r.id)
            }
          }
        }

        const userRequestsToRejectOnWindowClose = this.userRequests.filter(
          (r) => r.action.kind !== 'calls'
        )
        await this.rejectUserRequests(
          ethErrors.provider.userRejectedRequest().message,
          userRequestsToRejectOnWindowClose.map((r) => r.id),
          // If the user closes a window and non-calls user requests exist,
          // the window will reopen with the next request.
          // For example: if the user has both a sign message and sign account op request,
          // closing the window will reject the sign message request but immediately
          // reopen the window for the sign account op request.
          { shouldOpenNextRequest: false }
        )

        this.userRequestsWaitingAccountSwitch = []
        this.emitUpdate()
      }
    })

    this.actions.onUpdate(() => this.emitUpdate(), 'requests-on-update-listener')
    this.initialLoadPromise = this.#load()
  }

  async #load() {
    await this.#networks.initialLoadPromise
    await this.#providers.initialLoadPromise
    await this.#accounts.initialLoadPromise
    await this.#selectedAccount.initialLoadPromise
    await this.#keystore.initialLoadPromise
    await this.#dapps.initialLoadPromise
  }

  async addUserRequests(
    reqs: UserRequest[],
    {
      actionPosition = 'last',
      actionExecutionType = 'open-action-window',
      allowAccountSwitch = false,
      skipFocus = false
    }: {
      actionPosition?: ActionPosition
      actionExecutionType?: ActionExecutionType
      allowAccountSwitch?: boolean
      skipFocus?: boolean
    } = {}
  ) {
    await this.initialLoadPromise
    const shouldSkipAddUserRequest = await this.#guardHWSigning(false)

    if (shouldSkipAddUserRequest) return

    const actionsToAdd: Action[] = []
    const baseWindowId = reqs.find((r) => r.session.windowId)?.session?.windowId

    // eslint-disable-next-line no-restricted-syntax
    for (const req of reqs) {
      if (
        allowAccountSwitch &&
        req.meta.isSignAction &&
        req.meta.accountAddr !== this.#selectedAccount.account?.addr
      ) {
        await this.#addSwitchAccountUserRequest(req)
        return
      }

      if (req.action.kind === 'calls') {
        ;(req.action as Calls).calls.forEach((_, i) => {
          ;(req.action as Calls).calls[i].id = `${req.id}-${i}`
        })
      }
      if (actionPosition === 'first') {
        this.userRequests.unshift(req)
      } else {
        this.userRequests.push(req)
      }

      const { id, action, meta } = req
      if (action.kind === 'calls') {
        const account = this.#accounts.accounts.find((x) => x.addr === meta.accountAddr)!
        const accountState = await this.#accounts.getOrFetchAccountOnChainState(
          meta.accountAddr,
          meta.chainId
        )
        const network = this.#networks.networks.find((n) => n.chainId === meta.chainId)!

        const accountOpAction = makeAccountOpAction({
          account,
          chainId: meta.chainId,
          nonce: accountState.nonce,
          userRequests: this.userRequests,
          actionsQueue: this.actions.actionsQueue
        })

        actionsToAdd.push(accountOpAction)

        const signAccountOp = this.#getSignAccountOp()
        if (signAccountOp) {
          if (signAccountOp.fromActionId === accountOpAction.id) {
            this.#updateSignAccountOp({ calls: accountOpAction.accountOp.calls })
          }
        } else {
          // Even without an initialized SignAccountOpController or Screen, we should still update the portfolio and run the simulation.
          // It's necessary to continue operating with the token `amountPostSimulation` amount.
          this.#updateSelectedAccountPortfolio(network ? [network] : undefined)
        }
      } else {
        let actionType: 'dappRequest' | 'benzin' | 'signMessage' | 'switchAccount' = 'dappRequest'

        if (req.action.kind === 'typedMessage' || req.action.kind === 'message') {
          actionType = 'signMessage'

          if (this.actions.visibleActionsQueue.find((a) => a.type === 'signMessage')) {
            const msgReq = this.userRequests.find((uReq) => uReq.id === id)
            if (!msgReq) return
            msgReq.dappPromise?.reject(
              ethErrors.provider.custom({
                code: 1001,
                message:
                  'Rejected: Please complete your pending message request before initiating a new one.'
              })
            )
            this.userRequests.splice(this.userRequests.indexOf(msgReq), 1)
            return
          }
        }
        if (req.action.kind === 'benzin') actionType = 'benzin'
        if (req.action.kind === 'switchAccount') actionType = 'switchAccount'
        if (req.action.kind === 'authorization-7702') actionType = 'signMessage'

        actionsToAdd.push({
          id,
          type: actionType,
          userRequest: req as UserRequest as never
        })
      }
    }

    if (actionsToAdd.length)
      await this.actions.addOrUpdateActions(actionsToAdd, {
        position: actionPosition,
        executionType: actionExecutionType,
        skipFocus,
        baseWindowId
      })

    this.emitUpdate()
  }

  async removeUserRequests(
    ids: UserRequest['id'][],
    options?: {
      shouldRemoveSwapAndBridgeRoute?: boolean
      shouldUpdateAccount?: boolean
      shouldOpenNextRequest?: boolean
    }
  ) {
    const {
      shouldRemoveSwapAndBridgeRoute = true,
      shouldUpdateAccount = true,
      shouldOpenNextRequest = true
    } = options || {}

    const actionsToAddOrUpdate: Action[] = []
    const userRequestsToAdd: UserRequest[] = []
    const actionsToRemove: string[] = []

    ids.forEach((id) => {
      const req = this.userRequests.find((uReq) => uReq.id === id)

      if (!req) return

      // remove from the request queue
      this.userRequests.splice(this.userRequests.indexOf(req), 1)

      // update the pending stuff to be signed
      const { action, meta } = req
      if (action.kind === 'calls') {
        const network = this.#networks.networks.find((net) => net.chainId === meta.chainId)!
        const account = this.#accounts.accounts.find((x) => x.addr === meta.accountAddr)
        if (!account)
          throw new Error(
            `batchCallsFromUserRequests: tried to run for non-existent account ${meta.accountAddr}`
          )

        const accountOpIndex = this.actions.actionsQueue.findIndex(
          (a) => a.type === 'accountOp' && a.id === `${meta.accountAddr}-${meta.chainId}`
        )
        const accountOpAction = this.actions.actionsQueue[accountOpIndex] as
          | AccountOpAction
          | undefined
        // accountOp has just been rejected or broadcasted
        if (!accountOpAction) {
          if (shouldUpdateAccount)
            this.#updateSelectedAccountPortfolio(network ? [network] : undefined)

          if (this.#swapAndBridge.activeRoutes.length && shouldRemoveSwapAndBridgeRoute) {
            this.#swapAndBridge.removeActiveRoute(meta.activeRouteId)
          }
          return
        }

        accountOpAction.accountOp.calls = this.#batchCallsFromUserRequests(
          meta.accountAddr,
          meta.chainId
        )
        const signAccountOp = this.#getSignAccountOp()

        if (accountOpAction.accountOp.calls.length) {
          actionsToAddOrUpdate.push(accountOpAction)

          if (signAccountOp && signAccountOp.fromActionId === accountOpAction.id) {
            this.#updateSignAccountOp({ calls: accountOpAction.accountOp.calls })
          }
        } else {
          if (signAccountOp && signAccountOp.fromActionId === accountOpAction.id) {
            this.#destroySignAccountOp()
          }
          actionsToRemove.push(`${meta.accountAddr}-${meta.chainId}`)
          if (shouldUpdateAccount)
            this.#updateSelectedAccountPortfolio(network ? [network] : undefined)
        }
        if (this.#swapAndBridge.activeRoutes.length && shouldRemoveSwapAndBridgeRoute) {
          this.#swapAndBridge.removeActiveRoute(meta.activeRouteId)
        }
      } else if (id === ACCOUNT_SWITCH_USER_REQUEST) {
        const requestsToAddOrRemove = this.userRequestsWaitingAccountSwitch.filter(
          (r) => r.meta.accountAddr === this.#selectedAccount.account!.addr
        )
        const isSelectedAccountSwitched =
          this.#selectedAccount.account?.addr === (action as any).params!.switchToAccountAddr

        if (!isSelectedAccountSwitched) {
          actionsToRemove.push(id)
        } else {
          requestsToAddOrRemove.forEach((r) => {
            this.userRequestsWaitingAccountSwitch.splice(this.userRequests.indexOf(r), 1)
            userRequestsToAdd.push(r)
          })
        }
      } else {
        actionsToRemove.push(id as string)
      }
    })

    if (actionsToRemove.length) {
      await this.actions.removeActions(actionsToRemove, shouldOpenNextRequest)
    }
    if (userRequestsToAdd.length) {
      await this.addUserRequests(userRequestsToAdd, { skipFocus: true })
    }
    if (actionsToAddOrUpdate.length) {
      await this.actions.addOrUpdateActions(actionsToAddOrUpdate, {
        skipFocus: true
      })
    }

    this.emitUpdate()
  }

  async resolveUserRequest(data: any, requestId: UserRequest['id']) {
    const userRequest = this.userRequests.find((r) => r.id === requestId)
    if (!userRequest) return // TODO: emit error

    userRequest.dappPromise?.resolve(data)
    // These requests are transitionary initiated internally (not dApp requests) that block dApp requests
    // before being resolved. The timeout prevents the action-window from closing before the actual dApp request arrives
    if (['unlock', 'dappConnect'].includes(userRequest.action.kind)) {
      setTimeout(async () => {
        await this.removeUserRequests([requestId])
        this.emitUpdate()
      }, 300)
    } else {
      await this.removeUserRequests([requestId])
      this.emitUpdate()
    }
  }

  async rejectUserRequests(
    err: string,
    requestIds: UserRequest['id'][],
    options?: {
      shouldRemoveSwapAndBridgeRoute?: boolean
      shouldOpenNextRequest?: boolean
    }
  ) {
    const userRequestsToRemove: string[] = []

    requestIds.forEach((requestId) => {
      const userRequest = this.userRequests.find((r) => r.id === requestId)
      if (!userRequest) return

      // if the userRequest that is about to be removed is an approval request
      // find and remove the associated pending transaction request if there is any
      // this is valid scenario for a swap & bridge txs with a BA
      if (userRequest.action.kind === 'calls') {
        const acc = this.#accounts.accounts.find((a) => a.addr === userRequest.meta.accountAddr)!

        if (
          isBasicAccount(acc, this.#accounts.accountStates[acc.addr][userRequest.meta.chainId]) &&
          userRequest.meta.isSwapAndBridgeCall
        ) {
          userRequestsToRemove.push(
            userRequest.meta.activeRouteId,
            `${userRequest.meta.activeRouteId}-approval`,
            `${userRequest.meta.activeRouteId}-revoke-approval`
          )
        }
      }

      userRequest.dappPromise?.reject(ethErrors.provider.userRejectedRequest<any>(err))
    })

    await this.removeUserRequests([...userRequestsToRemove, ...requestIds], options)
  }

  async build({ type, params }: BuildRequest) {
    await this.initialLoadPromise

    if (type === 'dappRequest') {
      await this.#buildUserRequestFromDAppRequest(params.request, params.dappPromise)
    }

    if (type === 'transferRequest') {
      await this.#buildTransferUserRequest(params)
    }

    if (type === 'swapAndBridgeRequest') {
      await this.#buildSwapAndBridgeUserRequest(params)
    }

    if (type === 'claimWalletRequest') {
      await this.#buildClaimWalletUserRequest(params)
    }

    if (type === 'mintVestingRequest') {
      await this.#buildMintVestingUserRequest(params)
    }

    if (type === 'intentRequest') {
      await this.#buildIntentUserRequest(params)
    }

    if (type === 'privateDepositRequest') {
      await this.#buildPrivacyPoolsUserRequest(params)
    }

    if (type === 'privateSendRequest') {
      await this.#buildPrivacyPoolsUserRequest(params)
    }

    if (type === 'privateRagequitRequest') {
      await this.#buildPrivacyPoolsUserRequest(params)
    }
  }

  async #buildPrivacyPoolsUserRequest({
    txList,
    actionExecutionType = 'open-action-window'
  }: {
    txList: { to: string; value: bigint; data: string }[]
    actionExecutionType: ActionExecutionType
  }) {
    await this.initialLoadPromise
    if (!this.#selectedAccount.account) return

    const baseAcc = getBaseAccount(
      this.#selectedAccount.account,
      await this.#accounts.getOrFetchAccountOnChainState(
        this.#selectedAccount.account.addr,
        11155111n
      ),
      this.#keystore.getAccountKeys(this.#selectedAccount.account),
      this.#networks.networks.find((net) => net.chainId === 11155111n)!
    )
    const userRequest = buildSignUserRequest({
      txList,
      accountAddr: this.#selectedAccount.account.addr,
      chainId: 11155111n,
      paymasterService: getAmbirePaymasterService(baseAcc, this.#relayerUrl)
    })

    if (!userRequest) {
      this.emitError({
        level: 'major',
        message: 'Unexpected error while building private deposit request',
        error: new Error(
          'buildPrivateDepositUserRequest: bad parameters passed to buildPrivateDepositUserRequest'
        )
      })
      return
    }

    await this.addUserRequests([userRequest], {
      actionPosition: 'last',
      actionExecutionType
    })
  }

  async #buildPrivateSendUserRequest(params: any) {
    // eslint-disable-next-line
    console.log('buildPrivateSendUserRequest', params)
    await this.initialLoadPromise
    throw new Error('Not implemented')
  }

  async #buildPrivateRagequitUserRequest(params: any) {
    // eslint-disable-next-line
    console.log('buildPrivateRagequitUserRequest', params)
    await this.initialLoadPromise
    throw new Error('Not implemented')
  }

  async #buildUserRequestFromDAppRequest(
    request: DappProviderRequest,
    dappPromise: {
      session: DappProviderRequest['session']
      resolve: (data: any) => void
      reject: (data: any) => void
    }
  ) {
    await this.initialLoadPromise
    await this.#guardHWSigning(true)

    let userRequest = null
    let actionPosition: ActionPosition = 'last'
    const kind = dappRequestMethodToActionKind(request.method)
    const dapp = this.#dapps.getDapp(request.session.id)

    if (kind === 'calls') {
      if (!this.#selectedAccount.account) throw ethErrors.rpc.internal()
      const network = this.#networks.networks.find(
        (n) => Number(n.chainId) === Number(dapp?.chainId)
      )
      if (!network) {
        throw ethErrors.provider.chainDisconnected('Transaction failed - unknown network')
      }

      const baseAcc = getBaseAccount(
        this.#selectedAccount.account,
        await this.#accounts.getOrFetchAccountOnChainState(
          this.#selectedAccount.account.addr,
          network.chainId
        ),
        this.#keystore.getAccountKeys(this.#selectedAccount.account),
        network
      )

      const isWalletSendCalls = !!request.params[0].calls
      const accountAddr = getAddress(request.params[0].from)

      if (isWalletSendCalls && !request.params[0].calls.length)
        throw ethErrors.provider.unsupportedMethod({
          message: 'Request rejected - empty calls array not allowed!'
        })

      const calls: Calls['calls'] = isWalletSendCalls
        ? request.params[0].calls
        : [request.params[0]]
      const paymasterService =
        isWalletSendCalls && !!request.params[0].capabilities?.paymasterService
          ? getPaymasterService(network.chainId, request.params[0].capabilities)
          : getAmbirePaymasterService(baseAcc, this.#relayerUrl)

      const atomicRequired = isWalletSendCalls && !!request.params[0].atomicRequired
      if (isWalletSendCalls && atomicRequired && baseAcc.getAtomicStatus() === 'unsupported') {
        throw ethErrors.provider.custom({
          code: 5700,
          message: 'Transaction failed - atomicity is not supported for this account'
        })
      }

      const walletSendCallsVersion = isWalletSendCalls
        ? request.params[0].version ?? '1.0.0'
        : undefined

      userRequest = {
        id: new Date().getTime(),
        action: {
          kind,
          calls: calls.map((call) => ({
            to: call.to,
            data: call.data || '0x',
            value: call.value ? getBigInt(call.value) : 0n
          }))
        },
        session: new Session({ windowId: request.session.windowId }),
        meta: {
          dapp,
          isSignAction: true,
          isWalletSendCalls,
          walletSendCallsVersion,
          accountAddr,
          chainId: network.chainId,
          paymasterService
        },
        dappPromise
      } as SignUserRequest
    } else if (kind === 'message') {
      if (!this.#selectedAccount.account) throw ethErrors.rpc.internal()

      const msg = request.params
      if (!msg) {
        throw ethErrors.rpc.invalidRequest('No msg request to sign')
      }
      const msgAddress = getAddress(msg?.[1])

      const network = this.#networks.networks.find(
        (n) => Number(n.chainId) === Number(dapp?.chainId)
      )

      if (!network) {
        throw ethErrors.provider.chainDisconnected('Transaction failed - unknown network')
      }

      userRequest = {
        id: new Date().getTime(),
        action: {
          kind: 'message',
          message: msg[0]
        },
        session: request.session,
        meta: {
          isSignAction: true,
          accountAddr: msgAddress,
          chainId: network.chainId
        },
        dappPromise
      } as SignUserRequest
    } else if (kind === 'typedMessage') {
      if (!this.#selectedAccount.account) throw ethErrors.rpc.internal()

      const msg = request.params
      if (!msg) {
        throw ethErrors.rpc.invalidRequest('No msg request to sign')
      }
      const msgAddress = getAddress(msg?.[0])

      const network = this.#networks.networks.find(
        (n) => Number(n.chainId) === Number(dapp?.chainId)
      )

      if (!network) {
        throw ethErrors.provider.chainDisconnected('Transaction failed - unknown network')
      }

      let typedData = msg?.[1]

      try {
        typedData = parse(typedData)
      } catch (error) {
        throw ethErrors.rpc.invalidRequest('Invalid typedData provided')
      }

      if (
        !typedData?.types ||
        !typedData?.domain ||
        !typedData?.message ||
        !typedData?.primaryType
      ) {
        throw ethErrors.rpc.methodNotSupported(
          'Invalid typedData format - only typedData v4 is supported'
        )
      }

      if (
        msgAddress === this.#selectedAccount.account.addr &&
        (typedData.primaryType === 'AmbireOperation' || !!typedData.types.AmbireOperation)
      ) {
        throw ethErrors.rpc.methodNotSupported('Signing an AmbireOperation is not allowed')
      }

      userRequest = {
        id: new Date().getTime(),
        action: {
          kind: 'typedMessage',
          types: typedData.types,
          domain: typedData.domain,
          message: typedData.message,
          primaryType: typedData.primaryType
        },
        session: request.session,
        meta: {
          isSignAction: true,
          accountAddr: msgAddress,
          chainId: network.chainId
        },
        dappPromise
      } as SignUserRequest
    } else {
      userRequest = {
        id: new Date().getTime(),
        session: request.session,
        action: { kind, params: request.params },
        meta: { isSignAction: false },
        dappPromise
      } as DappUserRequest
    }

    if (userRequest.action.kind !== 'calls') {
      const otherUserRequestFromSameDapp = this.userRequests.find(
        (r) => r.dappPromise?.session?.origin === dappPromise?.session?.origin
      )

      if (!otherUserRequestFromSameDapp && !!dappPromise?.session?.origin) {
        actionPosition = 'first'
      }
    }

    if (!userRequest) return

    const isASignOperationRequestedForAnotherAccount =
      userRequest.meta.isSignAction &&
      userRequest.meta.accountAddr !== this.#selectedAccount.account?.addr

    // We can simply add the user request if it's not a sign operation
    // for another account
    if (!isASignOperationRequestedForAnotherAccount) {
      await this.addUserRequests([userRequest], {
        actionPosition,
        actionExecutionType:
          actionPosition === 'first' || isSmartAccount(this.#selectedAccount.account)
            ? 'open-action-window'
            : 'queue-but-open-action-window'
      })
      return
    }

    const accountError = this.#getUserRequestAccountError(
      dappPromise.session.origin,
      userRequest.meta.accountAddr
    )

    if (accountError) {
      dappPromise.reject(ethErrors.provider.userRejectedRequest(accountError))
      return
    }

    await this.#addSwitchAccountUserRequest(userRequest)
  }

  async #buildIntentUserRequest({
    amount,
    recipientAddress,
    selectedToken,
    actionExecutionType = 'open-action-window'
  }: {
    amount: string
    recipientAddress: string
    selectedToken: TokenResult
    actionExecutionType: ActionExecutionType
  }) {
    await this.initialLoadPromise
    if (!this.#selectedAccount.account) return

    if (!this.#transactionManager) {
      this.emitError({
        error: new Error('Error: TransactionManagerController feature is not enabled'),
        message: 'This feature is currently disabled',
        level: 'major'
      })
      return
    }

    const baseAcc = getBaseAccount(
      this.#selectedAccount.account,
      await this.#accounts.getOrFetchAccountOnChainState(
        this.#selectedAccount.account.addr,
        selectedToken.chainId
      ),
      this.#keystore.getAccountKeys(this.#selectedAccount.account),
      this.#networks.networks.find((net) => net.chainId === selectedToken.chainId)!
    )

    const userRequests = prepareIntentUserRequest({
      selectedAccount: this.#selectedAccount.account.addr,
      selectedToken,
      recipientAddress,
      paymasterService: getAmbirePaymasterService(baseAcc, this.#relayerUrl),
      transactions: this.#transactionManager.intent?.transactions
    })

    if (!userRequests.length) {
      this.emitError({
        level: 'major',
        message: 'Unexpected error while building intent request',
        error: new Error(
          'buildUserRequestFromIntentRequest: bad parameters passed to buildIntentUserRequest'
        )
      })
      return
    }

    await this.addUserRequests(userRequests, { actionExecutionType, actionPosition: 'last' })
  }

  async #buildTransferUserRequest({
    amount,
    recipientAddress,
    selectedToken,
    actionExecutionType = 'open-action-window',
    windowId
  }: {
    amount: string
    recipientAddress: string
    selectedToken: TokenResult
    // eslint-disable-next-line default-param-last
    actionExecutionType: ActionExecutionType
    windowId?: number
  }) {
    await this.initialLoadPromise
    if (!this.#selectedAccount.account) return

    const baseAcc = getBaseAccount(
      this.#selectedAccount.account,
      await this.#accounts.getOrFetchAccountOnChainState(
        this.#selectedAccount.account.addr,
        selectedToken.chainId
      ),
      this.#keystore.getAccountKeys(this.#selectedAccount.account),
      this.#networks.networks.find((net) => net.chainId === selectedToken.chainId)!
    )
    const userRequest = buildTransferUserRequest({
      selectedAccount: this.#selectedAccount.account.addr,
      amount,
      selectedToken,
      recipientAddress,
      paymasterService: getAmbirePaymasterService(baseAcc, this.#relayerUrl),
      windowId
    })

    if (!userRequest) {
      this.emitError({
        level: 'major',
        message: 'Unexpected error while building transfer request',
        error: new Error(
          'buildUserRequestFromTransferRequest: bad parameters passed to buildTransferUserRequest'
        )
      })
      return
    }

    await this.addUserRequests([userRequest], {
      actionPosition: 'last',
      actionExecutionType
    })

    // reset the transfer form after adding a req
    this.#transfer.resetForm()
  }

  async #buildSwapAndBridgeUserRequest({
    openActionWindow,
    activeRouteId,
    windowId
  }: {
    openActionWindow: boolean
    activeRouteId?: SwapAndBridgeActiveRoute['activeRouteId']
    windowId?: number
  }) {
    await this.withStatus(
      'buildSwapAndBridgeUserRequest',
      async () => {
        if (!this.#selectedAccount.account) return
        let transaction: SwapAndBridgeSendTxRequest | null | undefined = null

        const activeRoute = this.#swapAndBridge.activeRoutes.find(
          (r) => r.activeRouteId === activeRouteId
        )

        // learn the receiving token
        if (this.#swapAndBridge.toSelectedToken && this.#swapAndBridge.toChainId) {
          this.#addTokensToBeLearned(
            [this.#swapAndBridge.toSelectedToken.address],
            BigInt(this.#swapAndBridge.toChainId)
          )
        }

        if (this.#swapAndBridge.signAccountOpController?.accountOp.meta?.swapTxn) {
          transaction = this.#swapAndBridge.signAccountOpController?.accountOp.meta?.swapTxn
        }

        if (activeRoute) {
          await this.removeUserRequests([activeRoute.activeRouteId], {
            shouldRemoveSwapAndBridgeRoute: false,
            shouldOpenNextRequest: false
          })
          this.#swapAndBridge.updateActiveRoute(activeRoute.activeRouteId, { error: undefined })

          transaction = await this.#swapAndBridge.getNextRouteUserTx({
            activeRouteId: activeRoute.activeRouteId,
            activeRoute
          })

          if (transaction) {
            const network = this.#networks.networks.find(
              (n) => Number(n.chainId) === transaction!.chainId
            )!
            if (
              isBasicAccount(
                this.#selectedAccount.account,
                await this.#accounts.getOrFetchAccountOnChainState(
                  this.#selectedAccount.account.addr,
                  network.chainId
                )
              )
            ) {
              await this.removeUserRequests(
                [
                  `${activeRoute.activeRouteId}-approval`,
                  `${activeRoute.activeRouteId}-revoke-approval`
                ],
                {
                  shouldRemoveSwapAndBridgeRoute: false,
                  shouldOpenNextRequest: false
                }
              )
            }
          }
        }

        if (!this.#selectedAccount.account || !transaction) {
          const errorDetails = `missing ${
            this.#selectedAccount.account ? 'selected account' : 'transaction'
          } info`
          const error = new SwapAndBridgeError(
            `Something went wrong when preparing your request. Please try again later or contact Ambire support. Error details: <${errorDetails}>`
          )
          throw new EmittableError({ message: error.message, level: 'major', error })
        }

        const network = this.#networks.networks.find(
          (n) => Number(n.chainId) === transaction!.chainId
        )!

        // TODO: Consider refining the error handling in here, because this
        // swallows errors and doesn't provide any feedback to the user.
        const accountState = await this.#accounts.getOrFetchAccountOnChainState(
          this.#selectedAccount.account.addr,
          network.chainId
        )
        const baseAcc = getBaseAccount(
          this.#selectedAccount.account,
          accountState,
          this.#keystore.getAccountKeys(this.#selectedAccount.account),
          network
        )
        const swapAndBridgeUserRequests = await buildSwapAndBridgeUserRequests(
          transaction,
          network.chainId,
          this.#selectedAccount.account,
          this.#providers.providers[network.chainId.toString()],
          accountState,
          getAmbirePaymasterService(baseAcc, this.#relayerUrl),
          windowId
        )
        await this.addUserRequests(swapAndBridgeUserRequests, {
          actionPosition: 'last',
          actionExecutionType: openActionWindow ? 'open-action-window' : 'queue'
        })

        if (this.#swapAndBridge.formStatus === SwapAndBridgeFormStatus.ReadyToSubmit) {
          await this.#swapAndBridge.addActiveRoute({
            activeRouteId: transaction.activeRouteId,
            userTxIndex: transaction.userTxIndex
          })
        }

        if (activeRouteId) {
          this.#swapAndBridge.updateActiveRoute(
            activeRouteId,
            {
              userTxIndex: transaction.userTxIndex,
              userTxHash: null
            },
            true
          )
        }

        this.#swapAndBridge.resetForm()
      },
      true
    )
  }

  async #buildClaimWalletUserRequest({
    token,
    windowId
  }: {
    token: TokenResult
    windowId?: number
  }) {
    if (!this.#selectedAccount.account) return

    const claimableRewardsData =
      this.#selectedAccount.portfolio.latest.rewards?.result?.claimableRewardsData

    if (!claimableRewardsData) return

    const userRequest: UserRequest = buildClaimWalletRequest({
      selectedAccount: this.#selectedAccount.account.addr,
      selectedToken: token,
      claimableRewardsData,
      windowId
    })

    await this.addUserRequests([userRequest])
  }

  async #buildMintVestingUserRequest({
    token,
    windowId
  }: {
    token: TokenResult
    windowId?: number
  }) {
    if (!this.#selectedAccount.account) return

    const addrVestingData = this.#selectedAccount.portfolio.latest.rewards?.result?.addrVestingData

    if (!addrVestingData) return
    const userRequest: UserRequest = buildMintVestingRequest({
      selectedAccount: this.#selectedAccount.account.addr,
      selectedToken: token,
      addrVestingData,
      windowId
    })

    await this.addUserRequests([userRequest])
  }

  #batchCallsFromUserRequests(accountAddr: AccountId, chainId: bigint): Call[] {
    // Note: we use reduce instead of filter/map so that the compiler can deduce that we're checking .kind
    return (this.userRequests.filter((r) => r.action.kind === 'calls') as SignUserRequest[]).reduce(
      (uCalls: Call[], req) => {
        if (req.meta.chainId === chainId && req.meta.accountAddr === accountAddr) {
          const { calls } = req.action as Calls
          calls.map((call) => uCalls.push({ ...call, fromUserRequestId: req.id }))
        }
        return uCalls
      },
      []
    )
  }

  #getUserRequestAccountError(dappOrigin: string, fromAccountAddr: string): string | null {
    if (ORIGINS_WHITELISTED_TO_ALL_ACCOUNTS.includes(dappOrigin)) {
      const isAddressInAccounts = this.#accounts.accounts.some((a) => a.addr === fromAccountAddr)

      if (isAddressInAccounts) return null

      return 'The dApp is trying to sign using an address that is not imported in the extension.'
    }
    const isAddressSelected = this.#selectedAccount.account?.addr === fromAccountAddr

    if (isAddressSelected) return null

    return 'The dApp is trying to sign using an address that is not selected in the extension.'
  }

  async #addSwitchAccountUserRequest(req: UserRequest) {
    this.userRequestsWaitingAccountSwitch.push(req)
    await this.addUserRequests(
      [
        buildSwitchAccountUserRequest({
          nextUserRequest: req,
          selectedAccountAddr: req.meta.accountAddr,
          session: req.session || new Session(),
          dappPromise: req.dappPromise
        })
      ],
      {
        actionPosition: 'last',
        actionExecutionType: 'open-action-window'
      }
    )
  }

  // ! IMPORTANT !
  // Banners that depend on async data from sub-controllers should be implemented
  // in the sub-controllers themselves. This is because updates in the sub-controllers
  // will not trigger emitUpdate in the MainController, therefore the banners will
  // remain the same until a subsequent update in the MainController.
  get banners(): Banner[] {
    if (!this.#selectedAccount.account || !this.#networks.isInitialized) return []

    const activeSwapAndBridgeRoutesForSelectedAccount = getActiveRoutesForAccount(
      this.#selectedAccount.account.addr,
      this.#swapAndBridge.activeRoutes
    )
    const swapAndBridgeRoutesPendingSignature = activeSwapAndBridgeRoutesForSelectedAccount.filter(
      (r) => r.routeStatus === 'ready'
    )

    return getAccountOpBanners({
      accountOpActionsByNetwork: getAccountOpActionsByNetwork(
        this.#selectedAccount.account.addr,
        this.actions.actionsQueue
      ),
      selectedAccount: this.#selectedAccount.account.addr,
      accounts: this.#accounts.accounts,
      networks: this.#networks.networks,
      swapAndBridgeRoutesPendingSignature
    })
  }

  toJSON() {
    return {
      ...this,
      ...super.toJSON(),
      banners: this.banners
    }
  }
}

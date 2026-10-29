import { AccountOpAction, Action } from '../../controllers/actions/actions'
import { Account, AccountId } from '../../interfaces/account'
import { DappProviderRequest } from '../../interfaces/dapp'
import { AccountOpRecoveryKit, RecoveryKit } from '../../interfaces/recoveryKit'
import { Calls, DappUserRequest, SignUserRequest, UserRequest } from '../../interfaces/userRequest'
import generateSpoofSig from '../../utils/generateSpoofSig'
import { AccountOp } from '../accountOp/accountOp'
import { Call } from '../accountOp/types'

export const batchCallsFromUserRequests = ({
  accountAddr,
  chainId,
  userRequests
}: {
  accountAddr: AccountId
  chainId: bigint
  userRequests: UserRequest[]
}): Call[] => {
  return (userRequests.filter((r) => r.action.kind === 'calls') as SignUserRequest[]).reduce(
    (uCalls: Call[], req) => {
      if (req.meta.chainId === chainId && req.meta.accountAddr === accountAddr) {
        const { calls } = req.action as Calls
        calls.forEach((call) =>
          uCalls.push({ ...call, fromUserRequestId: req.id, dapp: req.meta.dapp })
        )
      }
      return uCalls
    },
    []
  )
}

// The recovery kit mark comes only from the wallet's own calls request of this account and chain,
// and names that request. The calls of a batch are told apart by their request id only, so there
// is no mark when more than one request carries the mark or when another request shares its id.
const getRecoveryKitFromUserRequests = ({
  accountAddr,
  chainId,
  userRequests
}: {
  accountAddr: AccountId
  chainId: bigint
  userRequests: UserRequest[]
}): AccountOpRecoveryKit | undefined => {
  const userReqsWithRecoveryKit = userRequests.filter(
    (req) =>
      req.action.kind === 'calls' &&
      req.meta.accountAddr === accountAddr &&
      req.meta.chainId === chainId &&
      req.meta.recoveryKit
  )
  if (userReqsWithRecoveryKit.length !== 1) {
    return undefined
  }

  const [userReqWithRecoveryKit] = userReqsWithRecoveryKit
  if (userRequests.filter((req) => req.id === userReqWithRecoveryKit.id).length !== 1) {
    return undefined
  }

  const { manager, auditedActions } = userReqWithRecoveryKit.meta.recoveryKit as RecoveryKit
  return { manager, auditedActions, fromUserRequestId: userReqWithRecoveryKit.id }
}

// The op's meta with the recovery kit mark of the requests still batched in it, or without one
export const getAccountOpMetaWithRecoveryKit = (
  accountOp: AccountOp,
  userRequests: UserRequest[]
): AccountOp['meta'] => {
  const recoveryKit = getRecoveryKitFromUserRequests({
    accountAddr: accountOp.accountAddr,
    chainId: accountOp.chainId,
    userRequests
  })

  if (recoveryKit) {
    return { ...accountOp.meta, recoveryKit }
  }
  if (!accountOp.meta) {
    return accountOp.meta
  }

  const meta = { ...accountOp.meta }
  delete meta.recoveryKit
  return meta
}

export const ACCOUNT_SWITCH_USER_REQUEST = 'ACCOUNT_SWITCH_USER_REQUEST'

export const buildSwitchAccountUserRequest = ({
  nextUserRequest,
  selectedAccountAddr,
  session,
  dappPromise
}: {
  nextUserRequest: UserRequest
  selectedAccountAddr: string
  session?: DappProviderRequest['session']
  dappPromise?: DappUserRequest['dappPromise']
}): UserRequest => {
  return {
    id: ACCOUNT_SWITCH_USER_REQUEST,
    action: {
      kind: 'switchAccount',
      params: {
        accountAddr: selectedAccountAddr,
        switchToAccountAddr: nextUserRequest.meta.accountAddr,
        nextRequestType: nextUserRequest.action.kind
      }
    },
    session,
    meta: {
      isSignAction: false,
      accountAddr: selectedAccountAddr,
      switchToAccountAddr: nextUserRequest.meta.accountAddr,
      nextRequestType: nextUserRequest.action.kind
    },
    dappPromise: dappPromise
      ? {
          ...dappPromise,
          resolve: () => {}
        }
      : undefined
  } as any
}

export const makeAccountOpAction = ({
  account,
  chainId,
  nonce,
  actionsQueue,
  userRequests
}: {
  account: Account
  chainId: bigint
  nonce: bigint | null
  actionsQueue: Action[]
  userRequests: UserRequest[]
}): AccountOpAction => {
  const accountOpAction = actionsQueue.find(
    (a) => a.type === 'accountOp' && a.id === `${account.addr}-${chainId}`
  ) as AccountOpAction | undefined

  if (accountOpAction) {
    accountOpAction.accountOp.calls = batchCallsFromUserRequests({
      accountAddr: account.addr,
      chainId,
      userRequests
    })
    // the nonce might have changed during estimation because of
    // a nonce discrepancy issue. This makes sure we're with the
    // latest nonce should the user decide to batch
    accountOpAction.accountOp.nonce = nonce
    accountOpAction.accountOp.meta = getAccountOpMetaWithRecoveryKit(
      accountOpAction.accountOp,
      userRequests
    )
    return accountOpAction
  }

  // find the user request with a paymaster service
  const userReqWithPaymasterService = userRequests.find(
    (req) =>
      req.meta.accountAddr === account.addr &&
      req.meta.chainId === chainId &&
      req.meta.paymasterService
  )
  const paymasterService = userReqWithPaymasterService
    ? userReqWithPaymasterService.meta.paymasterService
    : undefined

  // find the user request with a wallet send calls version if any
  const userReqWithWalletSendCallsVersion = userRequests.find(
    (req) =>
      req.meta.accountAddr === account.addr &&
      req.meta.chainId === chainId &&
      req.meta.walletSendCallsVersion
  )
  const walletSendCallsVersion = userReqWithWalletSendCallsVersion
    ? userReqWithWalletSendCallsVersion.meta.walletSendCallsVersion
    : undefined

  // find the user request with a setDelegation meta property if any
  const userReqWithDelegation = userRequests.find(
    (req) =>
      req.meta.accountAddr === account.addr &&
      req.meta.chainId === chainId &&
      'setDelegation' in req.meta
  )
  const setDelegation = userReqWithDelegation ? userReqWithDelegation.meta.setDelegation : undefined

  const recoveryKit = getRecoveryKitFromUserRequests({
    accountAddr: account.addr,
    chainId,
    userRequests
  })

  const accountOp: AccountOpAction['accountOp'] = {
    accountAddr: account.addr,
    chainId,
    signingKeyAddr: null,
    signingKeyType: null,
    gasLimit: null,
    gasFeePayment: null,
    nonce,
    signature: account.associatedKeys[0] ? generateSpoofSig(account.associatedKeys[0]) : null,
    accountOpToExecuteBefore: null, // @TODO from pending recoveries
    calls: batchCallsFromUserRequests({
      accountAddr: account.addr,
      chainId,
      userRequests
    }),
    meta: {
      paymasterService,
      walletSendCallsVersion,
      setDelegation,
      ...(recoveryKit && { recoveryKit })
    }
  }

  return {
    id: `${account.addr}-${chainId}`, // SA accountOpAction id
    type: 'accountOp',
    accountOp
  }
}

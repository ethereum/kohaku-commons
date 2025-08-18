import { PaymasterService } from 'libs/erc7677/types'
import { Session } from '../../classes/session'
import { SignUserRequest } from '../../interfaces/userRequest'

type BuildSignUserRequestParams = {
  txList: { to: string; value: bigint; data: string }[]
  accountAddr: string
  chainId: bigint
  paymasterService?: PaymasterService
  windowId?: number
  meta?: Omit<
    Partial<SignUserRequest['meta']>,
    'isSignAction' | 'accountAddr' | 'chainId' | 'paymasterService'
  >
}

export function buildSignUserRequest({
  txList,
  accountAddr,
  chainId,
  paymasterService,
  windowId,
  meta
}: BuildSignUserRequestParams): SignUserRequest {
  const action = {
    kind: 'calls' as const,
    calls: txList
  }

  return {
    id: new Date().getTime(),
    action,
    session: new Session({ windowId }),
    meta: {
      isSignAction: true,
      chainId,
      accountAddr,
      paymasterService,
      ...(meta || {})
    }
  }
}

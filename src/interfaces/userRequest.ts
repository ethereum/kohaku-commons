import { SignMessageAction } from 'ambire-common/src/controllers/actions/actions'
import { TypedDataDomain, TypedDataField } from 'ethers'

import { Session } from '../classes/session'
import { PaymasterService } from '../libs/erc7677/types'
import { AccountId } from './account'
import { Dapp, DappProviderRequest } from './dapp'
import { Hex } from './hex'
import { EIP7702Signature } from './signatures'

export interface Calls {
  kind: 'calls'
  calls: {
    to: string
    value: bigint
    data: string
    id?: string
  }[]
}
export interface PlainTextMessage {
  kind: 'message'
  message: Hex
}

export interface TypedMessage {
  kind: 'typedMessage'
  domain: TypedDataDomain
  types: Record<string, Array<TypedDataField>>
  message: Record<string, any>
  primaryType: keyof TypedMessage['types']
}

export interface Authorization {
  kind: 'authorization-7702'
  chainId: bigint
  nonce: bigint
  contractAddr: Hex
  message: Hex
}

// @TODO: move this type and it's deps (PlainTextMessage, TypedMessage) to another place,
// probably interfaces
export interface Message {
  fromActionId: SignMessageAction['id']
  accountAddr: AccountId
  chainId: bigint
  content: PlainTextMessage | TypedMessage | Authorization
  signature: EIP7702Signature | string | null
}

export interface SignUserRequest {
  id: string | number
  action: Calls | PlainTextMessage | TypedMessage | Authorization | { kind: 'benzin' }
  session: Session
  meta: {
    isSignAction: true
    accountAddr: AccountId
    chainId: bigint
    paymasterService?: PaymasterService
    isWalletSendCalls?: boolean
    submittedAccountOp?: any
    activeRouteId?: string
    dapp?: Dapp
    [key: string]: any
  }
  // defined only when SignUserRequest is built from a DappRequest
  dappPromise?: {
    session: DappProviderRequest['session']
    resolve: (data: any) => void
    reject: (data: any) => void
  }
}

export interface DappUserRequest {
  id: string | number
  action: {
    kind: Exclude<string, 'calls' | 'message' | 'typedMessage' | 'benzin' | 'switchAccount'>
    params: any
  }
  session: Session
  meta: {
    isSignAction: false
    [key: string]: any
  }
  dappPromise: {
    session: DappProviderRequest['session']
    resolve: (data: any) => void
    reject: (data: any) => void
  }
}

export type UserRequest = DappUserRequest | SignUserRequest

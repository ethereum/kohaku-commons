import { ActionExecutionType } from '../controllers/actions/actions'
import { TokenResult } from '../libs/portfolio'
import { DappProviderRequest } from './dapp'
import { SwapAndBridgeActiveRoute } from './swapAndBridge'

export type BuildRequest =
  | {
      type: 'dappRequest'
      params: {
        request: DappProviderRequest
        dappPromise: {
          session: DappProviderRequest['session']
          resolve: (data: any) => void
          reject: (data: any) => void
        }
      }
    }
  | {
      type: 'transferRequest'
      params: {
        amount: string
        recipientAddress: string
        selectedToken: TokenResult
        actionExecutionType: ActionExecutionType
        windowId?: number
      }
    }
  | {
      type: 'swapAndBridgeRequest'
      params: {
        openActionWindow: boolean
        activeRouteId?: SwapAndBridgeActiveRoute['activeRouteId']
        windowId?: number
      }
    }
  | {
      type: 'claimWalletRequest' | 'mintVestingRequest'
      params: {
        token: TokenResult
        windowId?: number
      }
    }
  | {
      type: 'intentRequest'
      params: {
        amount: string
        recipientAddress: string
        selectedToken: TokenResult
        actionExecutionType: ActionExecutionType
      }
    }
  | {
      type: 'privateDepositRequest'
      params: {
        actionExecutionType: ActionExecutionType
        txList: { to: string; value: bigint; data: string }[]
      }
    }
  | {
      type: 'privateSendRequest'
      params: {
        actionExecutionType: ActionExecutionType
        txList: { to: string; value: bigint; data: string }[]
      }
    }
  | {
      type: 'privateRagequitRequest'
      params: {
        actionExecutionType: ActionExecutionType
        txList: { to: string; value: bigint; data: string }[]
      }
    }
  | {
      type: 'privateWithdrawRequest'
      params: {
        actionExecutionType: ActionExecutionType
        txList: { to: string; value: bigint; data: string }[]
      }
    }

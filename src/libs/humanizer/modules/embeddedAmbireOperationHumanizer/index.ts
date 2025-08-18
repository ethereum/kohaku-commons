import { AccountOp } from '../../../accountOp/accountOp'
import { HumanizerCallModule, IrCall } from '../../interfaces'
import { getAction } from '../../utils'

// the purpose of this module is simply to visualize attempts to hide ambire operations within the current account op
// such thing can be done if the dapp requests a tryCatch/executeBySelfSingle/executeBySelf/... function call directed to the current account
// this call will be executed without needing extra authentication. For more details check out AmbireAccount.sol
export const embeddedAmbireOperationHumanizer: HumanizerCallModule = (
  accountOp: AccountOp,
  irCalls: IrCall[]
) => {
  return irCalls.map((call: IrCall) => {
    if (!call.to) return call
    if (call.to.toLowerCase() === accountOp.accountAddr.toLowerCase()) {
      return {
        ...call,
        fullVisualization: [
          getAction('Allow multiple actions from this account!', { warning: true })
        ]
      }
    }
    return call
  })
}

import { Interface } from 'ethers'

import { AccountOp } from '../../../accountOp/accountOp'
import { HumanizerCallModule, IrCall } from '../../interfaces'
import { getAction, getAddressVisualization } from '../../utils'

const iface = new Interface([
  'function commitSetup(address action, bytes32 setupCommitment, uint64 nonce, bytes publicMetadata, bytes privateMetadata)',
  'function clearSetup(address action, uint64 nonce)',
  'function cancelByOwner(address action, uint64 attemptId)'
])

const labels: { [selector: string]: string } = {
  [iface.getFunction('commitSetup')!.selector]: 'Save recovery setup',
  [iface.getFunction('clearSetup')!.selector]: 'Remove recovery setup',
  [iface.getFunction('cancelByOwner')!.selector]: 'Cancel recovery'
}

// The recovery kit's manager is known only from the op that carries the recovery kit, so its
// calls are labelled only there.
export const recoveryManagerHumanizer: HumanizerCallModule = (
  accountOp: AccountOp,
  irCalls: IrCall[]
) => {
  const manager = accountOp.meta?.recoveryKit?.manager
  if (!manager) {
    return irCalls
  }
  return irCalls.map((call) => {
    if (!call.to || call.to.toLowerCase() !== manager.toLowerCase()) {
      return call
    }
    const label = labels[call.data.slice(0, 10).toLowerCase()]
    if (!label) {
      return call
    }
    let action: string
    try {
      ;[action] = iface.parseTransaction(call)!.args
    } catch {
      return call
    }
    return {
      ...call,
      fullVisualization: [getAction(label), getAddressVisualization(action)]
    }
  })
}

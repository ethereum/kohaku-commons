import { Interface, ZeroHash } from 'ethers'

import { describe, expect, test } from '@jest/globals'

import humanizerInfo from '../../../../consts/humanizer/humanizerInfo.json'
import { AccountOp } from '../../../accountOp/accountOp'
import { Call } from '../../../accountOp/types'
import { humanizeAccountOp } from '../../index'
import { HumanizerMeta, IrCall } from '../../interfaces'
import { recoveryManagerHumanizer } from './recoveryManager'

const manager = '0x5ff137D4b0FDCD49DcA30c7CF57E578a026d2789'
const action = '0x2222222222222222222222222222222222222222'
const otherAddress = '0x3333333333333333333333333333333333333333'
const kitRequestId = 1

const managerIface = new Interface([
  'function commitSetup(address, bytes32, uint64, bytes, bytes)',
  'function clearSetup(address, uint64)',
  'function cancelByOwner(address, uint64)'
])

const callTo = (to: string, data: string): Call => ({
  to,
  value: 0n,
  data,
  fromUserRequestId: kitRequestId
})

const managerCalls: { name: string; data: string; label: string }[] = [
  {
    name: 'commitSetup',
    data: managerIface.encodeFunctionData('commitSetup', [action, ZeroHash, 1, '0x', '0x']),
    label: 'Save recovery setup'
  },
  {
    name: 'clearSetup',
    data: managerIface.encodeFunctionData('clearSetup', [action, 1]),
    label: 'Remove recovery setup'
  },
  {
    name: 'cancelByOwner',
    data: managerIface.encodeFunctionData('cancelByOwner', [action, 7]),
    label: 'Cancel recovery'
  }
]

const accountOp: AccountOp = {
  accountAddr: '0xB674F3fd5F43464dB0448a57529eAF37F04cceA5',
  chainId: 11155111n,
  signingKeyAddr: null,
  signingKeyType: null,
  nonce: null,
  calls: [],
  gasLimit: null,
  signature: null,
  gasFeePayment: null,
  accountOpToExecuteBefore: null
}

const withKit = (calls: Call[], kitManager = manager): AccountOp => ({
  ...accountOp,
  calls,
  meta: {
    recoveryKit: { manager: kitManager, auditedActions: [action], fromUserRequestId: kitRequestId }
  }
})

const humanize = (op: AccountOp): IrCall[] =>
  recoveryManagerHumanizer(op, op.calls, humanizerInfo as HumanizerMeta)

describe('the recovery manager calls', () => {
  managerCalls.forEach(({ name, data, label }) => {
    describe(name, () => {
      test(`is shown as "${label}" of its action when the op carries the recovery kit`, () => {
        const [shown] = humanize(withKit([callTo(manager, data)]))
        expect(shown.fullVisualization).toMatchObject([
          { type: 'action', content: label },
          { type: 'address', address: action.toLowerCase() }
        ])
      })

      test('is labelled whatever the casing of the manager address', () => {
        const [lowerCaseCall] = humanize(withKit([callTo(manager.toLowerCase(), data)]))
        expect(lowerCaseCall.fullVisualization?.[0]).toMatchObject({ content: label })
        const [lowerCaseKit] = humanize(withKit([callTo(manager, data)], manager.toLowerCase()))
        expect(lowerCaseKit.fullVisualization?.[0]).toMatchObject({ content: label })
      })

      test('is left untouched when the op does not carry the recovery kit', () => {
        const call = callTo(manager, data)
        const [shown] = humanize({ ...accountOp, calls: [call] })
        expect(shown).toEqual(call)
      })

      test('to another address is left untouched', () => {
        const call = callTo(otherAddress, data)
        const [shown] = humanize(withKit([call]))
        expect(shown).toEqual(call)
      })
    })
  })

  test('names the action the call carries, not the one the recovery kit lists', () => {
    const [shown] = humanize(
      withKit([
        callTo(manager, managerIface.encodeFunctionData('cancelByOwner', [otherAddress, 7]))
      ])
    )
    expect(shown.fullVisualization).toMatchObject([
      { type: 'action', content: 'Cancel recovery' },
      { type: 'address', address: otherAddress.toLowerCase() }
    ])
  })

  test('a call with a known selector but malformed arguments is left untouched', () => {
    const call = callTo(manager, managerCalls[1].data.slice(0, 20))
    const [shown] = humanize(withKit([call]))
    expect(shown).toEqual(call)
  })

  test('another call to the manager is left untouched', () => {
    const call = callTo(
      manager,
      new Interface([
        'function cancelByVeto(address, address, uint64, address)'
      ]).encodeFunctionData('cancelByVeto', [accountOp.accountAddr, action, 1, otherAddress])
    )
    const [shown] = humanize(withKit([call]))
    expect(shown).toEqual(call)
  })

  test('the earlier one-argument clearSetup is left untouched', () => {
    const call = callTo(
      manager,
      new Interface(['function clearSetup(address)']).encodeFunctionData('clearSetup', [action])
    )
    const [shown] = humanize(withKit([call]))
    expect(shown).toEqual(call)
  })

  test('the wallet shows the label in place of the fallback, and the fallback without the kit', () => {
    const calls = managerCalls.map(({ data }) => callTo(manager, data))
    const shown = humanizeAccountOp(withKit(calls), {})
    managerCalls.forEach(({ label }, i) => {
      expect(shown[i].fullVisualization?.slice(0, 2)).toMatchObject([
        { type: 'action', content: label },
        { type: 'address', address: action.toLowerCase() }
      ])
    })
    const withoutKit = humanizeAccountOp({ ...accountOp, calls }, {})
    withoutKit.forEach((call) => {
      expect(call.fullVisualization?.slice(0, 3)).toMatchObject([
        { type: 'action', content: 'Interacting' },
        { type: 'label', content: 'with' },
        { type: 'address', address: manager.toLowerCase() }
      ])
    })
  })
})

import { AbiCoder, getAddress, id, Interface, keccak256, ZeroHash } from 'ethers'

import { describe, expect, test } from '@jest/globals'

import AmbireAccount from '../../../contracts/compiled/AmbireAccount.json'
import { Session } from '../../classes/session'
import { SignUserRequest } from '../../interfaces/userRequest'
import { AccountOp } from '../../libs/accountOp/accountOp'
import { makeAccountOpAction } from '../../libs/requests/requests'
import { isRefusedCallToSelf } from './signAccountOp'

const accountAddr = '0x77777777789A8BBEE6C64381e5E89E501fb0e4c8'
const otherAddr = '0x6969174FD72466430a46e18234D0b530c9FD5f49'
const manager = '0x1111111111111111111111111111111111111111'
const auditedAction = '0x2222222222222222222222222222222222222222'
const unlistedAction = '0x3333333333333333333333333333333333333333'
const ambireAccount = new Interface(AmbireAccount.abi)
const abiCoder = AbiCoder.defaultAbiCoder()

const kitSlot = (action: string) =>
  getAddress(`0x${keccak256(abiCoder.encode(['string', 'address'], ['kit', action])).slice(-40)}`)
const kitValue = (action: string) => keccak256(abiCoder.encode(['address', 'string'], [action, '']))
const grantData = (slot: string, value: string) =>
  ambireAccount.encodeFunctionData('setAddrPrivilege', [slot, value])

const kitRequestId = 1
const otherRequestId = 2
const kitGrant = {
  to: accountAddr,
  value: 0n,
  data: grantData(kitSlot(auditedAction), kitValue(auditedAction)),
  fromUserRequestId: kitRequestId
}
const commitSetup = {
  to: manager,
  value: 0n,
  data: new Interface([
    'function commitSetup(address, bytes32, uint64, bytes, bytes)'
  ]).encodeFunctionData('commitSetup', [auditedAction, ZeroHash, 1, '0x', '0x']),
  fromUserRequestId: kitRequestId
}
const recoveryKit = { manager, auditedActions: [auditedAction] }
const opRecoveryKit = { ...recoveryKit, fromUserRequestId: kitRequestId }
const fromOtherRequest = <T extends AccountOp['calls'][number]>(call: T): T => ({
  ...call,
  fromUserRequestId: otherRequestId
})

const opWith = (
  calls: AccountOp['calls'],
  meta: AccountOp['meta'] = { recoveryKit: opRecoveryKit }
): Pick<AccountOp, 'accountAddr' | 'calls' | 'meta'> => ({ accountAddr, calls, meta })

describe('Calls to the account itself', () => {
  test('the kit grant to an audited action beside its commitSetup is allowed', () => {
    expect(isRefusedCallToSelf(kitGrant, opWith([commitSetup, kitGrant]))).toBe(false)
  })

  test('the kit grant is recognised whatever the address and data casing', () => {
    const upperCaseGrant = {
      to: accountAddr.toLowerCase(),
      value: 0n,
      data: `0x${kitGrant.data.slice(2).toUpperCase()}`,
      fromUserRequestId: kitRequestId
    }
    expect(
      isRefusedCallToSelf(
        upperCaseGrant,
        opWith([{ ...commitSetup, to: manager.toUpperCase() }, upperCaseGrant])
      )
    ).toBe(false)
  })

  test('the kit grant is allowed whether it comes before or after the commitSetup', () => {
    expect(isRefusedCallToSelf(kitGrant, opWith([kitGrant, commitSetup]))).toBe(false)
    expect(isRefusedCallToSelf(kitGrant, opWith([commitSetup, kitGrant]))).toBe(false)
  })

  test('the manager is matched whatever its casing', () => {
    const checksummedManager = '0x5ff137D4b0FDCD49DcA30c7CF57E578a026d2789'
    const lowerCaseCommit = { ...commitSetup, to: checksummedManager.toLowerCase() }
    expect(
      isRefusedCallToSelf(
        kitGrant,
        opWith([lowerCaseCommit, kitGrant], {
          recoveryKit: { ...opRecoveryKit, manager: checksummedManager }
        })
      )
    ).toBe(false)
    expect(
      isRefusedCallToSelf(
        kitGrant,
        opWith([{ ...commitSetup, to: checksummedManager }, kitGrant], {
          recoveryKit: { ...opRecoveryKit, manager: checksummedManager.toLowerCase() }
        })
      )
    ).toBe(false)
  })

  test('the audited action is matched whatever its casing', () => {
    const checksummedAction = '0x6969174FD72466430a46e18234D0b530c9FD5f49'
    const grant = {
      to: accountAddr,
      value: 0n,
      data: grantData(kitSlot(checksummedAction), kitValue(checksummedAction)),
      fromUserRequestId: kitRequestId
    }
    expect(
      isRefusedCallToSelf(
        grant,
        opWith([commitSetup, grant], {
          recoveryKit: {
            ...opRecoveryKit,
            auditedActions: [checksummedAction.toLowerCase()]
          }
        })
      )
    ).toBe(false)
  })

  test('the kit grant beside another call to the manager than commitSetup is refused', () => {
    const otherManagerCall = {
      to: manager,
      value: 0n,
      data: `${id('commitSetup(bytes32,uint256,bytes)').slice(0, 10)}${'00'.repeat(32)}`,
      fromUserRequestId: kitRequestId
    }
    expect(isRefusedCallToSelf(kitGrant, opWith([otherManagerCall, kitGrant]))).toBe(true)
  })

  test('the kit grant to an audited action is allowed among several audited actions', () => {
    const grant = {
      to: accountAddr,
      value: 0n,
      data: grantData(kitSlot(unlistedAction), kitValue(unlistedAction)),
      fromUserRequestId: kitRequestId
    }
    expect(
      isRefusedCallToSelf(
        grant,
        opWith([commitSetup, grant], {
          recoveryKit: { ...opRecoveryKit, auditedActions: [auditedAction, unlistedAction] }
        })
      )
    ).toBe(false)
  })

  test('the kit slot of one audited action with the value of another is refused', () => {
    const grant = {
      to: accountAddr,
      value: 0n,
      data: grantData(kitSlot(auditedAction), kitValue(unlistedAction)),
      fromUserRequestId: kitRequestId
    }
    expect(
      isRefusedCallToSelf(
        grant,
        opWith([commitSetup, grant], {
          recoveryKit: { ...opRecoveryKit, auditedActions: [auditedAction, unlistedAction] }
        })
      )
    ).toBe(true)
  })

  test('the kit grant without commitSetup in the batch is refused', () => {
    expect(isRefusedCallToSelf(kitGrant, opWith([kitGrant]))).toBe(true)
  })

  test('the kit grant with commitSetup sent to another address than the manager is refused', () => {
    const misdirected = { ...commitSetup, to: otherAddr }
    expect(isRefusedCallToSelf(kitGrant, opWith([misdirected, kitGrant]))).toBe(true)
  })

  test('the kit grant to an action that is not audited is refused', () => {
    const unlistedGrant = {
      to: accountAddr,
      value: 0n,
      data: grantData(kitSlot(unlistedAction), kitValue(unlistedAction)),
      fromUserRequestId: kitRequestId
    }
    expect(isRefusedCallToSelf(unlistedGrant, opWith([commitSetup, unlistedGrant]))).toBe(true)
  })

  test('the kit slot of an audited action with another value is refused', () => {
    const wrongValues = [kitValue(unlistedAction), abiCoder.encode(['uint256'], [1])]
    wrongValues.forEach((value) => {
      const grant = { ...kitGrant, data: grantData(kitSlot(auditedAction), value) }
      expect(isRefusedCallToSelf(grant, opWith([commitSetup, grant]))).toBe(true)
    })
  })

  test('the kit grant without the recovery kit on the op is refused', () => {
    expect(isRefusedCallToSelf(kitGrant, { accountAddr, calls: [commitSetup, kitGrant] })).toBe(
      true
    )
    expect(isRefusedCallToSelf(kitGrant, opWith([commitSetup, kitGrant], {}))).toBe(true)
  })

  test('a privilege grant to another address on the account itself is refused', () => {
    const strangerGrant = {
      to: accountAddr,
      value: 0n,
      data: grantData(otherAddr, abiCoder.encode(['uint256'], [2])),
      fromUserRequestId: kitRequestId
    }
    expect(isRefusedCallToSelf(strangerGrant, opWith([commitSetup, strangerGrant]))).toBe(true)
  })

  test('any other call to the account itself is refused', () => {
    const executeBySelfData = ambireAccount.encodeFunctionData('executeBySelf', [
      [[otherAddr, 0n, '0x']]
    ])
    const op = opWith([commitSetup, kitGrant])
    expect(isRefusedCallToSelf({ to: accountAddr, value: 0n, data: executeBySelfData }, op)).toBe(
      true
    )
    expect(isRefusedCallToSelf({ to: accountAddr, value: 1n, data: '0x' }, op)).toBe(true)
    expect(isRefusedCallToSelf({ to: accountAddr, value: 0n, data: ZeroHash }, op)).toBe(true)
  })

  test('a call to another address is left to the other checks', () => {
    const op = opWith([commitSetup, kitGrant])
    expect(isRefusedCallToSelf({ ...kitGrant, to: otherAddr }, op)).toBe(false)
    expect(isRefusedCallToSelf({ to: otherAddr, value: 0n, data: '0x' }, op)).toBe(false)
  })

  test('the kit grant and commitSetup from another request than the marked one are refused', () => {
    const markedRequestCall = {
      to: otherAddr,
      value: 0n,
      data: '0x',
      fromUserRequestId: kitRequestId
    }
    const otherGrant = fromOtherRequest(kitGrant)
    const op = opWith([markedRequestCall, fromOtherRequest(commitSetup), otherGrant])
    expect(isRefusedCallToSelf(otherGrant, op)).toBe(true)
  })

  test('a grant of another audited action from another request beside the marked grant is refused', () => {
    const otherGrant = fromOtherRequest({
      ...kitGrant,
      data: grantData(kitSlot(unlistedAction), kitValue(unlistedAction))
    })
    const op = opWith([commitSetup, kitGrant, otherGrant], {
      recoveryKit: { ...opRecoveryKit, auditedActions: [auditedAction, unlistedAction] }
    })
    expect(isRefusedCallToSelf(kitGrant, op)).toBe(false)
    expect(isRefusedCallToSelf(otherGrant, op)).toBe(true)
  })

  test('the kit grant from the marked request with the commitSetup from another is refused', () => {
    expect(isRefusedCallToSelf(kitGrant, opWith([fromOtherRequest(commitSetup), kitGrant]))).toBe(
      true
    )
  })

  test('the kit grant from another request with the commitSetup from the marked one is refused', () => {
    const otherGrant = fromOtherRequest(kitGrant)
    expect(isRefusedCallToSelf(otherGrant, opWith([commitSetup, otherGrant]))).toBe(true)
  })

  test('a mark that names a request no call comes from exempts nothing', () => {
    const op = opWith([commitSetup, kitGrant], {
      recoveryKit: { ...opRecoveryKit, fromUserRequestId: 3 }
    })
    expect(isRefusedCallToSelf(kitGrant, op)).toBe(true)
  })

  describe('the kit revoke', () => {
    const kitRevoke = { ...kitGrant, data: grantData(kitSlot(auditedAction), ZeroHash) }
    const clearSetup = {
      to: manager,
      value: 0n,
      data: new Interface(['function clearSetup(address, uint64)']).encodeFunctionData(
        'clearSetup',
        [auditedAction, 1]
      ),
      fromUserRequestId: kitRequestId
    }

    test('alone from the marked request is allowed', () => {
      expect(isRefusedCallToSelf(kitRevoke, opWith([kitRevoke]))).toBe(false)
    })

    test('beside clearSetup from the marked request is allowed', () => {
      const op = opWith([kitRevoke, clearSetup])
      expect(op.calls.some((c) => isRefusedCallToSelf(c, op))).toBe(false)
    })

    test('without the recovery kit on the op is refused', () => {
      expect(isRefusedCallToSelf(kitRevoke, { accountAddr, calls: [kitRevoke, clearSetup] })).toBe(
        true
      )
      expect(isRefusedCallToSelf(kitRevoke, opWith([kitRevoke, clearSetup], {}))).toBe(true)
    })

    test('from another request than the marked one is refused', () => {
      const otherRevoke = fromOtherRequest(kitRevoke)
      expect(isRefusedCallToSelf(otherRevoke, opWith([otherRevoke, clearSetup]))).toBe(true)
    })

    test('a zero write at the slot of an action that is not audited is refused', () => {
      const revoke = { ...kitGrant, data: grantData(kitSlot(unlistedAction), ZeroHash) }
      expect(isRefusedCallToSelf(revoke, opWith([revoke]))).toBe(true)
    })

    test('a zero write at another address than a kit slot is refused', () => {
      const revoke = { ...kitGrant, data: grantData(otherAddr, ZeroHash) }
      expect(isRefusedCallToSelf(revoke, opWith([revoke, clearSetup]))).toBe(true)
    })

    test('a value at the kit slot that is neither zero nor the grant is refused without commitSetup', () => {
      const wrongValues = [
        kitValue(unlistedAction),
        abiCoder.encode(['uint256'], [1]),
        kitValue(auditedAction)
      ]
      wrongValues.forEach((value) => {
        const write = { ...kitGrant, data: grantData(kitSlot(auditedAction), value) }
        expect(isRefusedCallToSelf(write, opWith([write, clearSetup]))).toBe(true)
      })
    })
  })

  test('the kit grant in an op built from the wallet request with the kit is allowed, and refused without it', () => {
    const buildOp = (meta: Partial<SignUserRequest['meta']>) =>
      makeAccountOpAction({
        account: {
          addr: accountAddr,
          associatedKeys: [otherAddr],
          initialPrivileges: [],
          creation: null,
          preferences: { label: 'Account', pfp: accountAddr }
        },
        chainId: 1n,
        nonce: 0n,
        actionsQueue: [],
        userRequests: [
          {
            id: 1,
            action: { kind: 'calls', calls: [commitSetup, kitGrant] },
            session: new Session(),
            meta: { isSignAction: true, accountAddr, chainId: 1n, ...meta }
          }
        ]
      }).accountOp

    const markedOp = buildOp({ recoveryKit })
    expect(markedOp.calls.some((c) => isRefusedCallToSelf(c, markedOp))).toBe(false)

    const unmarkedOp = buildOp({})
    expect(unmarkedOp.calls.some((c) => isRefusedCallToSelf(c, unmarkedOp))).toBe(true)
  })
})

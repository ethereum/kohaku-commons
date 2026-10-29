import { describe, expect, test } from '@jest/globals'

import { Session } from '../../classes/session'
import { AccountOpAction } from '../../controllers/actions/actions'
import { Account } from '../../interfaces/account'
import { SignUserRequest, UserRequest } from '../../interfaces/userRequest'
import { makeAccountOpAction } from './requests'

const account: Account = {
  addr: '0x77777777789A8BBEE6C64381e5E89E501fb0e4c8',
  associatedKeys: ['0xd6e371526cdaeE04cd8AF225D42e37Bc14688D9E'],
  initialPrivileges: [],
  creation: null,
  preferences: { label: 'Account', pfp: '0x77777777789A8BBEE6C64381e5E89E501fb0e4c8' }
}
const otherAccountAddr = '0x6C0937c7a04487573673a47F22E4Af9e96b91ecd'
const recoveryKit = {
  manager: '0x1111111111111111111111111111111111111111',
  auditedActions: ['0x2222222222222222222222222222222222222222']
}

const callsRequest = (
  id: number,
  meta: Partial<SignUserRequest['meta']> = {}
): SignUserRequest => ({
  id,
  action: {
    kind: 'calls',
    calls: [{ to: '0x3333333333333333333333333333333333333333', value: 0n, data: '0x' }]
  },
  session: new Session(),
  meta: { isSignAction: true, accountAddr: account.addr, chainId: 1n, ...meta }
})

const buildOp = (userRequests: UserRequest[], actionsQueue: AccountOpAction[] = []) =>
  makeAccountOpAction({ account, chainId: 1n, nonce: 0n, actionsQueue, userRequests })

describe('The recovery kit mark on an account op', () => {
  test('an op built from a request that carries the mark has it', () => {
    const { accountOp } = buildOp([callsRequest(1, { recoveryKit })])
    expect(accountOp.meta?.recoveryKit).toEqual({ ...recoveryKit, fromUserRequestId: 1 })
  })

  test('an op built from requests without the mark has none', () => {
    const { accountOp } = buildOp([callsRequest(1), callsRequest(2)])
    expect(accountOp.meta).not.toHaveProperty('recoveryKit')
  })

  test('a request without the mark batched after a marked one keeps the mark', () => {
    const marked = callsRequest(1, { recoveryKit })
    const action = buildOp([marked])
    const { accountOp } = buildOp([marked, callsRequest(2)], [action])
    expect(accountOp.calls).toHaveLength(2)
    expect(accountOp.meta?.recoveryKit).toEqual({ ...recoveryKit, fromUserRequestId: 1 })
  })

  test('a marked request batched after an unmarked one gives the op the mark', () => {
    const unmarked = callsRequest(1)
    const action = buildOp([unmarked])
    const { accountOp } = buildOp([unmarked, callsRequest(2, { recoveryKit })], [action])
    expect(accountOp.meta?.recoveryKit).toEqual({ ...recoveryKit, fromUserRequestId: 2 })
  })

  test('the op loses the mark once the marked request leaves the batch', () => {
    const unmarked = callsRequest(2)
    const action = buildOp([callsRequest(1, { recoveryKit }), unmarked])
    const { accountOp } = buildOp([unmarked], [action])
    expect(accountOp.meta).not.toHaveProperty('recoveryKit')
  })

  test('the mark of another account or chain is not taken', () => {
    const { accountOp } = buildOp([
      callsRequest(1),
      callsRequest(2, { recoveryKit, accountAddr: otherAccountAddr }),
      callsRequest(3, { recoveryKit, chainId: 10n })
    ])
    expect(accountOp.meta).not.toHaveProperty('recoveryKit')
  })

  test('the mark on a request that is not a calls request is not taken', () => {
    const messageRequest: SignUserRequest = {
      ...callsRequest(2, { recoveryKit }),
      action: { kind: 'message', message: '0x' }
    }
    const { accountOp } = buildOp([callsRequest(1), messageRequest])
    expect(accountOp.meta).not.toHaveProperty('recoveryKit')
  })

  test('the mark names the request that carries it, whatever id the mark itself holds', () => {
    const markNamingAnotherRequest = { ...recoveryKit, fromUserRequestId: 1 }
    const { accountOp } = buildOp([
      callsRequest(1),
      callsRequest(2, { recoveryKit: markNamingAnotherRequest })
    ])
    expect(accountOp.meta?.recoveryKit).toEqual({ ...recoveryKit, fromUserRequestId: 2 })
  })

  test('there is no mark when another request shares the id of the marked one', () => {
    const marked = callsRequest(1, { recoveryKit })
    expect(buildOp([marked, callsRequest(1)]).accountOp.meta).not.toHaveProperty('recoveryKit')
    expect(
      buildOp([marked, callsRequest(1, { accountAddr: otherAccountAddr })]).accountOp.meta
    ).not.toHaveProperty('recoveryKit')
  })

  test('the op loses the mark when a request with the id of the marked one joins the batch', () => {
    const marked = callsRequest(1, { recoveryKit })
    const action = buildOp([marked])
    const { accountOp } = buildOp([marked, callsRequest(1)], [action])
    expect(accountOp.calls).toHaveLength(2)
    expect(accountOp.meta).not.toHaveProperty('recoveryKit')
  })

  test('there is no mark when more than one request of the batch carries one', () => {
    const { accountOp } = buildOp([
      callsRequest(1, { recoveryKit }),
      callsRequest(2, { recoveryKit })
    ])
    expect(accountOp.meta).not.toHaveProperty('recoveryKit')
  })
})

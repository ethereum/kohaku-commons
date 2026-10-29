import { AbiCoder, getAddress, Interface, keccak256, ZeroHash } from 'ethers'

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals'

import AmbireAccount from '../../../contracts/compiled/AmbireAccount.json'
import { mockWindowManager } from '../../../test/helpers/window'
import { Session } from '../../classes/session'
import { networks } from '../../consts/networks'
import { Account, AccountOnchainState } from '../../interfaces/account'
import { Calls, SignUserRequest } from '../../interfaces/userRequest'
import { AccountOp } from '../../libs/accountOp/accountOp'
import { AccountOpAction } from '../actions/actions'
import { GasPriceController } from '../gasPrice/gasPrice'
import { SignAccountOpController, SignAccountOpUpdateProps } from '../signAccountOp/signAccountOp'
import { RequestsController } from './requests'

const accountAddr = '0x77777777789A8BBEE6C64381e5E89E501fb0e4c8'
const account: Account = {
  addr: accountAddr,
  associatedKeys: ['0xd6e371526cdaeE04cd8AF225D42e37Bc14688D9E'],
  initialPrivileges: [],
  creation: null,
  preferences: { label: 'Account', pfp: accountAddr }
}
const accountState: AccountOnchainState = {
  accountAddr,
  isDeployed: true,
  eoaNonce: null,
  nonce: 0n,
  erc4337Nonce: 0n,
  associatedKeys: {},
  deployError: false,
  balance: 0n,
  isEOA: false,
  isErc4337Enabled: false,
  isErc4337Nonce: false,
  isV2: true,
  currentBlock: 0n,
  isSmarterEoa: false,
  delegatedContract: null,
  delegatedContractName: null
}
const recoveryKit = {
  manager: '0x1111111111111111111111111111111111111111',
  auditedActions: ['0x2222222222222222222222222222222222222222']
}
const origin = 'https://test-dApp.com'
const session = new Session({ tabId: 1, origin })
const loaded = { initialLoadPromise: Promise.resolve() }
const network = networks.find((n) => n.chainId === 1n)!

const abiCoder = AbiCoder.defaultAbiCoder()
const auditedAction = recoveryKit.auditedActions[0]
const kitGrant = {
  to: accountAddr,
  value: 0n,
  data: new Interface(AmbireAccount.abi).encodeFunctionData('setAddrPrivilege', [
    getAddress(
      `0x${keccak256(abiCoder.encode(['string', 'address'], ['kit', auditedAction])).slice(-40)}`
    ),
    keccak256(abiCoder.encode(['address', 'string'], [auditedAction, '']))
  ])
}
const commitSetup = {
  to: recoveryKit.manager,
  value: 0n,
  data: new Interface([
    'function commitSetup(address, bytes32, uint64, bytes, bytes)'
  ]).encodeFunctionData('commitSetup', [auditedAction, ZeroHash, 1, '0x', '0x'])
}
const harmlessCall = { to: '0x3333333333333333333333333333333333333333', value: 0n, data: '0x' }

const openSignScreen = (accountOp: AccountOp) =>
  new SignAccountOpController(
    { accountStates: { [accountAddr]: { '1': accountState } } } as never,
    { networks } as never,
    { keys: [] } as never,
    {} as never,
    {} as never,
    {},
    account,
    network,
    {} as never,
    `${accountAddr}-1`,
    accountOp,
    () => true,
    false
  )

const refusesCallToSelf = (screen: SignAccountOpController) =>
  screen.errors.some((e) => e.code === 'CALL_TO_SELF')

const prepareController = (getScreen: () => SignAccountOpController | null = () => null) =>
  new RequestsController({
    relayerUrl: 'https://relayer.test',
    accounts: {
      ...loaded,
      accounts: [account],
      getOrFetchAccountOnChainState: () => Promise.resolve(accountState)
    },
    networks: { ...loaded, networks },
    providers: loaded,
    selectedAccount: { ...loaded, account },
    keystore: { ...loaded, getAccountKeys: () => [] },
    dapps: { ...loaded, getDapp: () => ({ id: session.id, chainId: 1 }) },
    transfer: {},
    swapAndBridge: { activeRoutes: [] },
    windowManager: mockWindowManager().windowManager,
    notificationManager: { create: () => Promise.resolve() },
    getSignAccountOp: getScreen,
    updateSignAccountOp: (props: SignAccountOpUpdateProps) => getScreen()?.update(props),
    destroySignAccountOp: () => {},
    updateSelectedAccountPortfolio: () => Promise.resolve(),
    addTokensToBeLearned: () => {},
    guardHWSigning: () => Promise.resolve(false)
  } as unknown as ConstructorParameters<typeof RequestsController>[0])

const accountOpOf = (controller: RequestsController) =>
  (controller.actions.actionsQueue.find((a) => a.type === 'accountOp') as AccountOpAction).accountOp

const walletCallsRequest = (
  reqId: number,
  meta: Partial<SignUserRequest['meta']> = {},
  calls: Calls['calls'] = [harmlessCall]
) =>
  ({
    id: reqId,
    action: { kind: 'calls', calls: calls.map((call) => ({ ...call })) },
    session: new Session(),
    meta: { isSignAction: true, accountAddr, chainId: 1n, ...meta }
  } as SignUserRequest)

beforeEach(() => {
  jest.spyOn(SignAccountOpController.prototype, 'learnTokensFromCalls').mockImplementation(() => {})
  jest.spyOn(SignAccountOpController.prototype, 'simulate').mockResolvedValue(undefined)
  jest.spyOn(SignAccountOpController.prototype, 'estimate').mockResolvedValue(undefined)
  jest.spyOn(SignAccountOpController.prototype, 'calculateWarnings').mockImplementation(() => {})
  jest.spyOn(GasPriceController.prototype, 'fetch').mockResolvedValue(undefined)
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('The recovery kit mark in the request queue', () => {
  test('the op keeps the mark while the marked request is batched and drops it once removed', async () => {
    const controller = prepareController()

    await controller.addUserRequests([walletCallsRequest(1, { recoveryKit })])
    await controller.addUserRequests([walletCallsRequest(2)])
    expect(accountOpOf(controller).calls).toHaveLength(2)
    expect(accountOpOf(controller).meta?.recoveryKit).toEqual({
      ...recoveryKit,
      fromUserRequestId: 1
    })

    await controller.removeUserRequests([1])
    expect(accountOpOf(controller).calls).toHaveLength(1)
    expect(accountOpOf(controller).meta).not.toHaveProperty('recoveryKit')
  })
})

describe('An open sign screen and the recovery kit mark', () => {
  test('the screen loses the mark when the marked request leaves, and refuses the remaining grant', async () => {
    let screen: SignAccountOpController | null = null
    const controller = prepareController(() => screen)

    await controller.addUserRequests([
      walletCallsRequest(1, { recoveryKit }, [commitSetup, kitGrant])
    ])
    screen = openSignScreen(accountOpOf(controller))
    expect(refusesCallToSelf(screen)).toBe(false)

    await controller.addUserRequests([walletCallsRequest(2, {}, [commitSetup, kitGrant])])
    expect(screen.accountOp.calls).toHaveLength(4)
    expect(screen.accountOp.meta?.recoveryKit).toEqual({ ...recoveryKit, fromUserRequestId: 1 })
    expect(refusesCallToSelf(screen)).toBe(true)

    await controller.removeUserRequests([1])
    expect(screen.accountOp.calls).toHaveLength(2)
    expect(screen.accountOp.meta).not.toHaveProperty('recoveryKit')
    expect(refusesCallToSelf(screen)).toBe(true)
  })

  test('a request that reuses the id of the marked request after it left gets no exemption on the screen', async () => {
    let screen: SignAccountOpController | null = null
    const controller = prepareController(() => screen)

    await controller.addUserRequests([
      walletCallsRequest(1, { recoveryKit }, [commitSetup, kitGrant])
    ])
    screen = openSignScreen(accountOpOf(controller))
    await controller.addUserRequests([walletCallsRequest(2)])
    await controller.removeUserRequests([1])
    await controller.addUserRequests([walletCallsRequest(1, {}, [commitSetup, kitGrant])])

    expect(screen.accountOp.calls).toHaveLength(3)
    expect(screen.accountOp.meta).not.toHaveProperty('recoveryKit')
    expect(refusesCallToSelf(screen)).toBe(true)
  })

  test('a screen opened without the mark gets it when the marked request is added and accepts the grant', async () => {
    let screen: SignAccountOpController | null = null
    const controller = prepareController(() => screen)

    await controller.addUserRequests([walletCallsRequest(1)])
    screen = openSignScreen(accountOpOf(controller))
    expect(screen.accountOp.meta).not.toHaveProperty('recoveryKit')

    await controller.addUserRequests([
      walletCallsRequest(2, { recoveryKit }, [commitSetup, kitGrant])
    ])
    expect(screen.accountOp.calls).toHaveLength(3)
    expect(screen.accountOp.meta?.recoveryKit).toEqual({ ...recoveryKit, fromUserRequestId: 2 })
    expect(refusesCallToSelf(screen)).toBe(false)
  })

  test('the screen takes calls that differ from its own only in the request they come from', async () => {
    const controller = prepareController()
    await controller.addUserRequests([
      walletCallsRequest(1, { recoveryKit }, [commitSetup, kitGrant])
    ])
    const screen = openSignScreen(accountOpOf(controller))
    expect(refusesCallToSelf(screen)).toBe(false)

    screen.update({
      calls: screen.accountOp.calls.map((call) => ({ ...call, fromUserRequestId: 2 })),
      recoveryKit: screen.accountOp.meta?.recoveryKit
    })
    expect(screen.accountOp.calls.map((c) => c.fromUserRequestId)).toEqual([2, 2])
    expect(refusesCallToSelf(screen)).toBe(true)
  })
})

describe('A dapp request whose id equals the marked request id', () => {
  test('takes the mark off the op and the screen, so its kit calls are refused', async () => {
    const markedId = 1700000000000
    let screen: SignAccountOpController | null = null
    const controller = prepareController(() => screen)

    await controller.addUserRequests([
      walletCallsRequest(markedId, { recoveryKit }, [harmlessCall])
    ])
    screen = openSignScreen(accountOpOf(controller))
    expect(screen.accountOp.meta?.recoveryKit).toEqual({
      ...recoveryKit,
      fromUserRequestId: markedId
    })

    const clock = jest.spyOn(Date.prototype, 'getTime').mockReturnValue(markedId)
    await controller.build({
      type: 'dappRequest',
      params: {
        request: {
          method: 'wallet_sendCalls',
          params: [
            {
              version: '2.0.0',
              from: accountAddr,
              chainId: '0x1',
              calls: [
                { to: commitSetup.to, data: commitSetup.data, value: '0x0' },
                { to: kitGrant.to, data: kitGrant.data, value: '0x0' }
              ]
            }
          ],
          session,
          origin
        } as never,
        dappPromise: { resolve: () => {}, reject: () => {}, session }
      }
    })
    clock.mockRestore()

    expect(controller.userRequests.map((r) => r.id)).toEqual([markedId, markedId])
    expect(accountOpOf(controller).meta).not.toHaveProperty('recoveryKit')
    expect(screen.accountOp.calls.map((c) => c.fromUserRequestId)).toEqual([
      markedId,
      markedId,
      markedId
    ])
    expect(screen.accountOp.meta).not.toHaveProperty('recoveryKit')
    expect(refusesCallToSelf(screen)).toBe(true)
  })
})

describe('A dapp calls request', () => {
  test('a wallet_sendCalls payload cannot put the recovery kit on the op', async () => {
    const controller = prepareController()

    await controller.build({
      type: 'dappRequest',
      params: {
        request: {
          method: 'wallet_sendCalls',
          params: [
            {
              version: '2.0.0',
              from: accountAddr,
              chainId: '0x1',
              calls: [{ to: accountAddr, data: '0x', value: '0x0', recoveryKit }],
              capabilities: { recoveryKit },
              meta: { recoveryKit },
              recoveryKit
            }
          ],
          session,
          origin,
          meta: { recoveryKit }
        } as never,
        dappPromise: { resolve: () => {}, reject: () => {}, session }
      }
    })

    expect(controller.userRequests).toHaveLength(1)
    expect(controller.userRequests[0].meta).not.toHaveProperty('recoveryKit')
    expect(accountOpOf(controller).calls).toHaveLength(1)
    expect(accountOpOf(controller).meta).not.toHaveProperty('recoveryKit')
  })

  test('an eth_sendTransaction payload cannot put the recovery kit on the op', async () => {
    const controller = prepareController()

    await controller.build({
      type: 'dappRequest',
      params: {
        request: {
          method: 'eth_sendTransaction',
          params: [{ from: accountAddr, to: accountAddr, data: '0x', value: '0x0', recoveryKit }],
          session,
          origin,
          meta: { recoveryKit }
        } as never,
        dappPromise: { resolve: () => {}, reject: () => {}, session }
      }
    })

    expect(controller.userRequests).toHaveLength(1)
    expect(controller.userRequests[0].meta).not.toHaveProperty('recoveryKit')
    expect(accountOpOf(controller).calls).toHaveLength(1)
    expect(accountOpOf(controller).meta).not.toHaveProperty('recoveryKit')
  })
})

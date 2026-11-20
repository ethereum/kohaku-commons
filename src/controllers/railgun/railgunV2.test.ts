import { beforeEach, describe, expect, jest, test } from '@jest/globals'

import { suppressConsoleBeforeEach } from '../../../test/helpers/console'
import type { ErrorRef } from '../eventEmitter/eventEmitter'
import type { StorageController } from '../storage/storage'
import { RailgunV2Controller } from './railgunV2'

const mockPrepareUnshield = jest.fn<() => Promise<any>>()
const mockBroadcast = jest.fn<() => Promise<void>>()

// The SDK is ESM-only, so it cannot be resolved by Jest and is mocked as a virtual module
jest.mock(
  '@kohaku-eth/railgun',
  () => ({
    createRailgunPlugin: jest.fn(async () => ({
      instanceId: async () => '0zk-test',
      balance: async () => [],
      prepareUnshield: mockPrepareUnshield,
      broadcast: mockBroadcast
    })),
    Bundler: { pimlico: jest.fn() },
    Signer: { privateKey: jest.fn() }
  }),
  { virtual: true }
)

jest.mock('./hostFactory', () => ({
  hostFactory: jest.fn(async () => ({}))
}))

jest.mock('../../utils/wait', () => jest.fn(async () => {}))

const subscribe = () => () => {}

const createController = async () => {
  const keystore = { onUpdate: subscribe, isUnlocked: true }
  const selectedAccount = {
    onUpdate: subscribe,
    account: { addr: '0x0000000000000000000000000000000000000001' }
  }
  const storage = {
    get: async (_key: string, defaultValue: any) => defaultValue,
    set: async () => {}
  } as unknown as StorageController
  const unused = {} as never
  const controller = new RailgunV2Controller(
    keystore as never,
    unused,
    selectedAccount as never,
    storage,
    unused,
    unused,
    unused,
    unused,
    unused
  )
  await controller.init()
  if (!controller.isInitialized) throw new Error('controller did not initialize')

  const errors: ErrorRef[] = []
  controller.onError((error) => errors.push(error))
  return { controller, errors }
}

const amount = {
  asset: { contract: '0x0000000000000000000000000000000000000002', __type: 'erc20' },
  amount: 1n
} as never
const recipient = '0x0000000000000000000000000000000000000003' as never

beforeEach(() => {
  mockPrepareUnshield.mockReset()
  mockBroadcast.mockReset()
})

describe('RailgunV2Controller.submitPrivateOp()', () => {
  suppressConsoleBeforeEach()

  test('does not rebroadcast an operation after a failed broadcast when the next prepare fails', async () => {
    const { controller } = await createController()
    mockPrepareUnshield
      .mockResolvedValueOnce({ op: 'first' })
      .mockRejectedValueOnce(new Error('Insufficient balance'))
    mockBroadcast.mockRejectedValueOnce(new Error('bundler rejected'))

    await controller.submitPrivateOp(amount, recipient)
    await controller.submitPrivateOp(amount, recipient)

    expect(mockBroadcast).toHaveBeenCalledTimes(1)
  })
})

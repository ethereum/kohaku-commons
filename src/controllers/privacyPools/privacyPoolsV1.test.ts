import { beforeEach, describe, expect, jest, test } from '@jest/globals'

import { suppressConsoleBeforeEach } from '../../../test/helpers/console'
import { AccountOpStatus } from '../../libs/accountOp/types'
import type { ErrorRef } from '../eventEmitter/eventEmitter'
import type { StorageController } from '../storage/storage'
import { PrivacyPoolsV1Controller } from './privacyPoolsV1'

// EIP-155 chain id of Sepolia
const SEPOLIA_CHAIN_ID = 11155111n

const BROADCAST_TX_HASH = '0x0000000000000000000000000000000000000000000000000000000000000abc'

const mockBalance = jest.fn<() => Promise<any[]>>()
const mockNotes = jest.fn<() => Promise<any[]>>()
const mockBroadcast = jest.fn<() => Promise<{ txHash: string }>>()

// The SDK is ESM-only, so it cannot be resolved by Jest and is mocked as a virtual module
jest.mock(
  '@kohaku-eth/privacy-pools',
  () => ({
    // A new object per init() so a replaced instance can be told apart
    createPPv1Plugin: jest.fn(() => ({ balance: mockBalance, notes: mockNotes })),
    createPPv1Broadcaster: jest.fn(() => ({ broadcast: mockBroadcast })),
    OxBowAspService: jest.fn(),
    PrivacyPoolsV1_0xBow: {
      // Keyed by the Sepolia chain id (11155111); jest.mock factories cannot reference outer constants.
      11155111: { entrypoint: { entrypointAddress: '0x1', deploymentBlock: 0n } }
    },
    E_ADDRESS: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
  }),
  { virtual: true }
)

jest.mock('./hostFactory', () => ({
  hostFactory: jest.fn(async () => ({ network: {} }))
}))

const subscribe = () => () => {}

const createController = async ({ activity = {} }: { activity?: object } = {}) => {
  const keystore = { onUpdate: subscribe, isUnlocked: true }
  const selectedAccount = {
    onUpdate: subscribe,
    account: { addr: '0x0000000000000000000000000000000000000001' },
    portfolio: { tokens: [{ chainId: SEPOLIA_CHAIN_ID }] }
  }
  const networks = { networks: [{ chainId: SEPOLIA_CHAIN_ID }] }
  const storage = {
    get: async (_key: string, defaultValue: any) => defaultValue,
    set: async () => {}
  } as unknown as StorageController
  const unused = {} as never
  const controller = new PrivacyPoolsV1Controller(
    keystore as never,
    networks as never,
    selectedAccount as never,
    storage,
    unused,
    unused,
    unused,
    activity as never,
    unused
  )
  await controller.init()
  if (!controller.isInitialized) throw new Error('controller did not initialize')

  const errors: ErrorRef[] = []
  controller.onError((error) => errors.push(error))
  return { controller, errors }
}

beforeEach(() => {
  mockBalance.mockReset().mockResolvedValue([])
  mockNotes.mockReset().mockResolvedValue([])
  mockBroadcast.mockReset().mockResolvedValue({ txHash: BROADCAST_TX_HASH })
})

describe('PrivacyPoolsV1Controller.sync()', () => {
  suppressConsoleBeforeEach()

  test.each([
    ['balance', mockBalance],
    ['notes', mockNotes]
  ])('publishes syncState unsynced when the %s fetch fails', async (_label, failingFetch) => {
    const { controller } = await createController()
    failingFetch.mockRejectedValueOnce(new Error('boom'))
    const published: string[] = []
    controller.onUpdate(() => published.push(controller.syncState))

    await controller.sync()

    expect(published.at(-1)).toBe('unsynced')
  })

  test('reports a failed sync as a major error', async () => {
    const { controller, errors } = await createController()
    mockBalance.mockRejectedValueOnce(new Error('boom'))

    await controller.sync()

    expect(errors.map(({ level }) => level)).toEqual(['major'])
  })

  test('runs the next sync() after a failed one', async () => {
    const { controller } = await createController()
    mockBalance.mockRejectedValueOnce(new Error('boom'))

    await controller.sync()
    await controller.sync()

    expect(mockBalance).toHaveBeenCalledTimes(2)
  })

  // The first sync fails only after init() replaced its instance and a newer sync completed
  const failSyncAfterReplacement = async () => {
    const created = await createController()
    let failStaleSync: (error: Error) => void = () => {}
    mockBalance.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failStaleSync = reject
        })
    )
    const staleSync = created.controller.sync()
    await created.controller.init()
    await created.controller.sync()
    failStaleSync(new Error('boom'))
    await staleSync
    return created
  }

  test('keeps the newer syncState when a sync from a replaced instance fails', async () => {
    const { controller } = await failSyncAfterReplacement()

    expect(controller.syncState).toBe('synced')
  })

  test('does not report a failure from a sync whose instance was replaced', async () => {
    const { errors } = await failSyncAfterReplacement()

    expect(errors).toHaveLength(0)
  })
})

describe('PrivacyPoolsV1Controller.unshield()', () => {
  suppressConsoleBeforeEach()

  const unshieldWithFailingSync = async () => {
    const addAccountOp = jest.fn(async () => {})
    const { controller } = await createController({ activity: { addAccountOp } })
    controller.pendingUnshieldOperation = {} as never
    mockBalance.mockRejectedValueOnce(new Error('rpc down'))
    await controller.unshield()
    return { controller, addAccountOp }
  }

  test('marks a broadcast withdrawal as successful when the follow-up sync fails', async () => {
    const { controller } = await unshieldWithFailingSync()

    expect(controller.latestBroadcastedAccountOp?.status).toBe(AccountOpStatus.Success)
  })

  test('adds a broadcast withdrawal to activity when the follow-up sync fails', async () => {
    const { addAccountOp } = await unshieldWithFailingSync()

    expect(addAccountOp).toHaveBeenCalledTimes(1)
  })
})

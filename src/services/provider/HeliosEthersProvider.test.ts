/* eslint-disable @typescript-eslint/no-use-before-define */

import { describe, expect, test } from '@jest/globals'
import { Network } from 'ethers'
import { networks } from '../../consts/networks'

function getConfigByName(name: string) {
  const config = networks.find((n) => n.name === name)

  if (!config) {
    throw new Error(`Network ${JSON.stringify(name)} not found in networks`)
  }

  return config
}

// @TODO Try to get it to work with fake timers.
describe('HeliosEthersProvider tests', () => {
  beforeEach(() => {
    jest.resetModules()
  })

  test('falls back when Helios initialization fails', async () => {
    const mockHeliosRequest = mockHelios({
      initTimeout: 1,
      syncTimeout: 5,
      shouldInitFail: true
    })

    const mockFallbackRequest = mockJsonRpcProvider()
    const provider = getHeliosEthersProvider('Ethereum')

    const block = await provider.request({ method: 'eth_blockNumber', params: [] })
    expect(typeof block.result).toBe('string')
    expect(mockHeliosRequest).not.toHaveBeenCalled()
    expect(mockFallbackRequest).toHaveBeenCalled()
  }, 10_000)

  test('handles sync failure and falls back', async () => {
    const mockHeliosRequest = mockHelios({
      initTimeout: 1,
      syncTimeout: 5,
      shouldSyncFail: true
    })

    const mockFallbackRequest = mockJsonRpcProvider()
    const provider = getHeliosEthersProvider('Ethereum')
    // @ts-ignore
    provider.SYNC_TIMEOUT_MS = 10

    const block = await provider.request({ method: 'eth_blockNumber', params: [] })
    expect(typeof block.result).toBe('string')
    expect(mockHeliosRequest).not.toHaveBeenCalled()
    expect(mockFallbackRequest).toHaveBeenCalled()
  }, 10_000)

  test('falls back when Helios sync times out and retries after cooldown', async () => {
    const INIT_TIME_MS = 1
    const SYNC_TIME_MS = 10
    const FALLBACK_COOLDOWN_MS = 1

    const mockHeliosRequest = mockHelios({
      initTimeout: INIT_TIME_MS,
      syncTimeout: SYNC_TIME_MS
    })
    const mockFallbackRequest = mockJsonRpcProvider()
    const provider = getHeliosEthersProvider('Ethereum')
    // @ts-ignore
    provider.SYNC_TIMEOUT_MS = SYNC_TIME_MS - 5
    // @ts-ignore
    provider.FALLBACK_COOLDOWN_MS = FALLBACK_COOLDOWN_MS

    // First call -> timeout -> fallback used
    const block1 = await provider.request({ method: 'eth_blockNumber', params: [] })
    expect(typeof block1.result).toBe('string')
    expect(mockHeliosRequest).not.toHaveBeenCalled()
    expect(mockFallbackRequest).toHaveBeenCalled()

    await new Promise((resolve) => {
      setTimeout(resolve, 10)
    })

    // Second call -> waitSynced resolves -> Helios used
    const block2 = await provider.request({ method: 'eth_blockNumber', params: [] })
    expect(typeof block2.result).toBe('string')
    expect(mockHeliosRequest).toHaveBeenCalled()
  }, 10_000)

  test('uses syncedHelios for subsequent requests after successful sync', async () => {
    const INIT_TIME_MS = 1
    const SYNC_TIME_MS = 5

    const mockHeliosRequest = mockHelios({
      initTimeout: INIT_TIME_MS,
      syncTimeout: SYNC_TIME_MS
    })

    const provider = getHeliosEthersProvider('Ethereum')
    // @ts-ignore
    provider.SYNC_TIMEOUT_MS = 20 // Make sure it's enough time for sync

    // First call - should wait for sync then use Helios
    const block1 = await provider.request({ method: 'eth_blockNumber', params: [] })
    expect(typeof block1.result).toBe('string')
    expect(mockHeliosRequest).toHaveBeenCalledTimes(1)

    // Second call - should use cached syncedHelios without waiting
    const block2 = await provider.request({ method: 'eth_blockNumber', params: [] })
    expect(typeof block2.result).toBe('string')
    expect(mockHeliosRequest).toHaveBeenCalledTimes(2)
  }, 10_000)

  test('immediately uses fallback during cooldown period', async () => {
    const INIT_TIME_MS = 1
    const SYNC_TIME_MS = 10
    const FALLBACK_COOLDOWN_MS = 20

    const mockHeliosRequest = mockHelios({
      initTimeout: INIT_TIME_MS,
      syncTimeout: SYNC_TIME_MS
    })

    const mockFallbackRequest = mockJsonRpcProvider()
    const provider = getHeliosEthersProvider('Ethereum')
    // @ts-ignore
    provider.SYNC_TIMEOUT_MS = SYNC_TIME_MS - 5
    // @ts-ignore
    provider.FALLBACK_COOLDOWN_MS = FALLBACK_COOLDOWN_MS

    // First call -> timeout -> fallback used
    const block1 = await provider.request({ method: 'eth_blockNumber', params: [] })
    expect(typeof block1.result).toBe('string')
    expect(mockFallbackRequest).toHaveBeenCalledTimes(1)

    mockFallbackRequest.mockClear()

    // Second call during cooldown - should go straight to fallback
    const block2 = await provider.request({ method: 'eth_blockNumber', params: [] })
    expect(typeof block2.result).toBe('string')
    expect(mockFallbackRequest).toHaveBeenCalledTimes(1)
    expect(mockHeliosRequest).not.toHaveBeenCalled()
  }, 10_000)
})

function getHeliosEthersProvider(networkName: string): typeof HeliosEthersProvider {
  const config = getConfigByName(networkName)
  const rpcUrl = config.rpcUrls[0]
  const staticNetwork = Network.from(config.chainId)
  const HeliosEthersProvider = jest.requireActual('./HeliosEthersProvider').HeliosEthersProvider
  return new HeliosEthersProvider(config, rpcUrl, staticNetwork)
}

interface MockHeliosParams {
  initTimeout: number
  syncTimeout: number
  shouldInitFail?: boolean
  shouldSyncFail?: boolean
}

function mockHelios({
  initTimeout,
  syncTimeout,
  shouldInitFail = false,
  shouldSyncFail = false
}: MockHeliosParams): jest.Mock {
  // Create a mock waitSynced that behaves like the real one
  const mockHeliosRequest = jest.fn().mockImplementation(getMockedRequestFunction())

  jest.doMock('@a16z/helios', () => {
    return {
      createHeliosProvider: jest.fn().mockImplementation(() => {
        // First, initialization promise
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            if (shouldInitFail) {
              reject(new Error('Helios initialization failed'))
              return
            }

            // After initialization, sync starts immediately
            const syncPromise = new Promise<void>((resolveSync, rejectSync) => {
              setTimeout(() => {
                if (shouldSyncFail) {
                  rejectSync(new Error('Helios sync failed'))
                  return
                }
                resolveSync()
              }, syncTimeout)
            })
            resolve({
              waitSynced: () => syncPromise,
              request: mockHeliosRequest,
              on: jest.fn()
            })
          }, initTimeout)
        })
      })
    }
  })

  return mockHeliosRequest
}

function mockJsonRpcProvider(): jest.Mock {
  const mockSend = jest.fn().mockImplementation(() => {
    const result = '0x12345'
    return Promise.resolve({ result, id: 1 })
  })
  jest.doMock('ethers', () => {
    const actualEthers = jest.requireActual('ethers')
    return {
      ...actualEthers,
      JsonRpcProvider: jest.fn().mockImplementation(() => ({
        send: mockSend
      }))
    }
  })
  return mockSend
}

function getMockedRequestFunction(): (payload: {
  method: string
  params: any[]
}) => Promise<{ result: any; id: number }> {
  return async (payload: {
    method: string
    params: any[]
  }): Promise<{ result: any; id: number }> => {
    let result
    switch (payload.method) {
      case 'eth_blockNumber':
        result = '0x12345'
        break
      case 'eth_getBalance':
        result = '0x12345'
        break
      case 'eth_getBlockByNumber':
        result = {
          number: '0x12345',
          timestamp: '0x12345',
          parentHash: '0x12345',
          nonce: '0x12345'
        }
        break
      case 'eth_getBlockByHash':
        result = {
          number: '0x12345',
          timestamp: '0x12345',
          parentHash: '0x12345',
          nonce: '0x12345'
        }
        break
      case 'eth_getTransactionReceipt':
        result = {
          number: '0x12345',
          timestamp: '0x12345',
          parentHash: '0x12345',
          nonce: '0x12345'
        }
        break
      case 'helios_getCurrentCheckpoint':
        result = '0x1234567890abcdef'
        break
      default:
        throw new Error(`Unknown method: ${payload.method}`)
    }
    return { result, id: 1 }
  }
}

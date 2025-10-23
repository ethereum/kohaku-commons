/* eslint-disable @typescript-eslint/no-use-before-define */

import { describe, expect, test } from '@jest/globals'
import { networks } from '../../consts/networks'

function getConfigByName(name: string) {
  const config = networks.find((n) => n.name === name)

  if (!config) {
    throw new Error(`Network ${JSON.stringify(name)} not found in networks`)
  }

  return config
}

describe('getRpcProvider', () => {
  describe('Helios tests', () => {
    beforeEach(() => {
      jest.resetModules()
      jest.unmock('./getRpcProvider')
    })

    afterEach(() => {
      jest.clearAllMocks()
    })

    test('should fetch balance on mainnet with Helios', async () => {
      const { BrowserProvider: RealBrowserProvider } = jest.requireActual('./BrowserProvider')

      const provider = getRealGetRpcProvider({
        ...getConfigByName('Ethereum'),
        useHelios: true
      })

      expect(provider).toBeInstanceOf(RealBrowserProvider)

      const vitalikAddress = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
      const balance = await provider.getBalance(vitalikAddress)

      expect(typeof balance).toBe('bigint')
      expect(balance).toBeGreaterThan(0n)
    }, 300_000) // Long test due to sync time when using Helios on mainnet

    // @TODO this test is flaky, full of race conditions, needs to be rewritten.
    // Couldn't get Jest fake timers to work in a reasonable timeframe, so using setTimeout instead.
    test('falls back when Helios sync times out and retries after cooldown', async () => {
      const TIMEOUT_MS = 10
      const FALLBACK_COOLDOWN_MS = 1
      jest.resetModules()

      // Create a mock waitSynced that behaves like the real one
      const mockWaitSynced = getMockWaitSynced(TIMEOUT_MS + 500)
      const mockHeliosRequest = jest.fn().mockResolvedValue('0x12345')

      jest.doMock('@a16z/helios', () => {
        return {
          createHeliosProvider: jest.fn().mockResolvedValue({
            waitSynced: mockWaitSynced,
            request: mockHeliosRequest
          }),
          NetworkKind: {},
          Network: {}
        }
      })

      jest.doMock('./HeliosEthersProvider', () => {
        const Actual = jest.requireActual('./HeliosEthersProvider')
        class Patched extends Actual.HeliosEthersProvider {
          constructor(config: any, rpcUrl: string, staticNetwork: any) {
            super(config, rpcUrl, staticNetwork)
            // @ts-ignore
            this.SYNC_TIMEOUT_MS = TIMEOUT_MS
            // @ts-ignore
            this.FALLBACK_COOLDOWN_MS = FALLBACK_COOLDOWN_MS
          }
        }
        return { ...Actual, HeliosEthersProvider: Patched }
      })

      const provider = getRealGetRpcProvider({
        ...getConfigByName('Ethereum'),
        useHelios: true
      })

      // First call -> timeout -> fallback used
      const block1 = await provider.getBlockNumber()
      expect(typeof block1).toBe('number')
      expect(mockHeliosRequest).not.toHaveBeenCalled()

      await new Promise((resolve) => {
        setTimeout(resolve, 600)
      })

      // Second call -> waitSynced resolves -> Helios used
      const block2 = await provider.getBlockNumber()
      expect(typeof block2).toBe('number')
      expect(mockHeliosRequest).toHaveBeenCalled()
    }, 10_000)
  })

  afterAll(() => {
    restoreGlobalMock()
  })
})

function getMockWaitSynced(timeout: number): () => Promise<void> {
  let promise: Promise<void> | null = null
  promise = new Promise((resolve) => {
    setTimeout(resolve, timeout)
  })
  return () => {
    return promise
  }
}

/**
 * For these tests, we need to use the real getRpcProvider function, not the globally mocked one.
 */
function getRealGetRpcProvider(config: any) {
  const { getRpcProvider: realGetRpcProvider } = jest.requireActual('./getRpcProvider')
  return realGetRpcProvider(config)
}

// Restore the global mock for other tests
function restoreGlobalMock() {
  jest.doMock('./getRpcProvider', () => {
    const originalModule = jest.requireActual('./getRpcProvider')
    return {
      ...originalModule,
      getRpcProvider: (config: any) => {
        const testConfig = { ...config, useHelios: false }
        return originalModule.getRpcProvider(testConfig)
      }
    }
  })
}

import { JsonRpcProvider } from 'ethers'
import { describe, expect, test } from '@jest/globals'
import { networks } from '../../consts/networks'
import { getRpcProvider } from './getRpcProvider'

function getConfigByName(name: string) {
  const config = networks.find((n) => n.name === name)

  if (!config) {
    throw new Error(`Network ${JSON.stringify(name)} not found in networks`)
  }

  return config
}

describe('getRpcProvider', () => {
  test('should fetch tx on mainnet', async () => {
    const provider = getRpcProvider(getConfigByName('Ethereum'))

    expect(provider).toBeInstanceOf(JsonRpcProvider)

    const tx = await provider.getTransaction(
      '0xe1868fb0592e85c03203dc9336aecd222cf83984bad91fd797ad2f6f825d5bf9'
    )

    expect(tx?.to?.toLowerCase()).toBe('0xe688b84b23f322a994a53dbf8e15fa82cdb71127')
  })

  describe('Helios tests', () => {
    beforeEach(() => {
      // Restore original implementation for each test in this block
      jest.resetModules()
      jest.unmock('./getRpcProvider')
    })

    afterEach(() => {
      // Clear all mocks after each test
      jest.clearAllMocks()
    })

    test('should fetch balance on mainnet with Helios', async () => {
      // Import the real implementation after unmocking
      const { getRpcProvider: realGetRpcProvider } = jest.requireActual('./getRpcProvider')
      const { BrowserProvider: RealBrowserProvider } = jest.requireActual('./BrowserProvider')

      const provider = realGetRpcProvider({
        ...getConfigByName('Ethereum'),
        useHelios: true
      })

      expect(provider).toBeInstanceOf(RealBrowserProvider)

      const vitalikAddress = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
      const balance = await provider.getBalance(vitalikAddress)

      expect(typeof balance).toBe('bigint')
      expect(balance).toBeGreaterThan(0n)
    }, 300_000) // Long test due to sync time when using Helios on mainnet
  })
})

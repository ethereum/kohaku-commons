import { JsonRpcProvider } from 'ethers'
import { describe, expect, test } from '@jest/globals'
import { networks } from '../../consts/networks'
import { getRpcProvider } from './getRpcProvider'
import { HeliosEthersProvider } from './HeliosEthersProvider'

function getMainnetConfig() {
  const ethereum = networks.find((n) => n.name === 'Ethereum')

  if (!ethereum) {
    throw new Error('Regular Ethereum network not found in networks')
  }

  return ethereum
}

describe('getRpcProvider', () => {
  test('should fetch tx on regular Ethereum network', async () => {
    const provider = getRpcProvider(getMainnetConfig())

    expect(provider).toBeInstanceOf(JsonRpcProvider)

    const tx = await provider.getTransaction(
      '0xe1868fb0592e85c03203dc9336aecd222cf83984bad91fd797ad2f6f825d5bf9'
    )

    expect(tx?.to?.toLowerCase()).toBe('0xe688b84b23f322a994a53dbf8e15fa82cdb71127')
  })

  test('should fetch tx on Ethereum with Helios network', async () => {
    const provider = getRpcProvider({
      ...getMainnetConfig(),
      preferHelios: true
    })

    expect(provider).toBeInstanceOf(HeliosEthersProvider)

    // This can take a minute or so, but is dominated by initial sync time for
    // Helios. After sync, queries like this take 1000-3000ms.
    const tx = await provider.getTransaction(
      '0xe1868fb0592e85c03203dc9336aecd222cf83984bad91fd797ad2f6f825d5bf9'
    )

    expect(tx?.to?.toLowerCase()).toBe('0xe688b84b23f322a994a53dbf8e15fa82cdb71127')
  }, 300_000) // Long test due to sync time when using Helios
})

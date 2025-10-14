import { JsonRpcProvider } from 'ethers'
import { describe, expect, test } from '@jest/globals'
import { networks } from '../../consts/networks'
import { getRpcProvider } from './getRpcProvider'
import { HeliosEthersProvider } from './HeliosEthersProvider'

describe('getRpcProvider', () => {
  test('should return JsonRpcProvider for regular Ethereum network', async () => {
    const regularEthereum = networks.find((n) => n.name === 'Ethereum' && !n.consensusRpcUrl)

    if (!regularEthereum) {
      throw new Error('Regular Ethereum network not found in networks')
    }

    const provider = getRpcProvider(regularEthereum)

    expect(provider).toBeInstanceOf(JsonRpcProvider)

    const tx = await provider.send('eth_getTransactionByHash', [
      '0xe1868fb0592e85c03203dc9336aecd222cf83984bad91fd797ad2f6f825d5bf9'
    ])

    expect(tx.to).toBe('0xe688b84b23f322a994a53dbf8e15fa82cdb71127')
  })

  test('should return HeliosEthersProvider for Ethereum with Helios network', async () => {
    const heliosNetwork = networks.find((n) => n.name === 'Ethereum with Helios')

    if (!heliosNetwork) {
      throw new Error('Ethereum with Helios network not found in networks')
    }

    expect(heliosNetwork.consensusRpcUrl).toBeDefined()
    expect(heliosNetwork.consensusRpcUrl).toBe('https://ethereum.operationsolarstorm.org')

    const provider = getRpcProvider(heliosNetwork)

    expect(provider).toBeInstanceOf(HeliosEthersProvider)

    // This can take a minute or so, but is dominated by initial sync time for
    // Helios. After sync, queries like this take 1000-3000ms.
    const tx = await provider.send('eth_getTransactionByHash', [
      '0xe1868fb0592e85c03203dc9336aecd222cf83984bad91fd797ad2f6f825d5bf9'
    ])

    expect(tx.to).toBe('0xe688b84b23f322a994a53dbf8e15fa82cdb71127')
  }, 300_000) // Long test due to sync time when using Helios
})

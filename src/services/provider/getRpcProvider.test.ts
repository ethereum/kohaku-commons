import { JsonRpcProvider } from 'ethers'
import { describe, expect, test } from '@jest/globals'
import { networks } from '../../consts/networks'
import { getRpcProvider } from './getRpcProvider'
import { HeliosEthersProvider } from './HeliosEthersProvider'

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

  test('should fetch tx on mainnet with Helios', async () => {
    const provider = getRpcProvider({
      ...getConfigByName('Ethereum'),
      useHelios: true
    })

    expect(provider).toBeInstanceOf(HeliosEthersProvider)

    // This can take a minute or so, but is dominated by initial sync time for
    // Helios. After sync, queries like this take 1000-3000ms.
    const tx = await provider.getTransaction(
      '0xe1868fb0592e85c03203dc9336aecd222cf83984bad91fd797ad2f6f825d5bf9'
    )

    expect(tx?.to?.toLowerCase()).toBe('0xe688b84b23f322a994a53dbf8e15fa82cdb71127')
  }, 300_000) // Long test due to sync time when using Helios on mainnet

  test('should fetch tx on optimism with Helios', async () => {
    const provider = getRpcProvider({
      ...getConfigByName('OP Mainnet'),
      useHelios: true
    })

    expect(provider).toBeInstanceOf(HeliosEthersProvider)

    const tx = await provider.getTransaction(
      '0xbf0d550be064df4e6226e5b12c7660a2bbfec42ce8bd67f49b33cc8801b81fc2'
    )

    expect(tx?.to?.toLowerCase()).toBe('0x61d1e5e08c20b5628bc81f67952dbd01441cbffb')
  })
})

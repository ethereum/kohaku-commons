import { createPublicClient, http } from 'viem'
import { viem as viemProvider } from '@kohaku-eth/provider/viem'
import { Host, Storage as PluginStorage } from '@kohaku-eth/plugins'
import { deriveRailgunKey } from 'derive-railgun-keys'
import type { KeystoreController } from '../keystore/keystore'
import type { NetworksController } from '../networks/networks'
import type { SelectedAccountController } from '../selectedAccount/selectedAccount'

function createInMemoryStorage(): PluginStorage {
  const map = new Map<string, string>()
  return {
    _brand: 'Storage' as const,
    get: (key) => map.get(key) ?? null,
    set: (key, value) => {
      map.set(key, value)
    }
  }
}

export async function hostFactory(
  keystore: KeystoreController,
  networks: NetworksController,
  selectedAccount: SelectedAccountController,
  chainId: bigint = 11155111n,
  storage?: PluginStorage
): Promise<Host> {
  const account = selectedAccount.account
  if (!account) throw new Error('No account selected')
  if (!keystore.isUnlocked) throw new Error('Keystore is locked')

  const accountKeys = keystore.getAccountKeys(account)
  const internalKey = accountKeys.find((k) => k.type === 'internal' && k.meta?.fromSeedId)
  if (!internalKey?.meta?.fromSeedId)
    throw new Error('No internal key with seed found for selected account')

  const savedSeed = await keystore.getSavedSeed(internalKey.meta.fromSeedId)
  if (!savedSeed?.seed) throw new Error('Failed to retrieve seed phrase')

  const seedPhrase = savedSeed.seed

  const pluginKeystore = {
    deriveAt(path: string): `0x${string}` {
      return `0x${deriveRailgunKey(seedPhrase, path)}` as `0x${string}`
    }
  }

  const pluginNetwork = { fetch: globalThis.fetch.bind(globalThis) }

  const pluginStorage = storage ?? createInMemoryStorage()

  const network = networks.networks.find((n) => n.chainId === BigInt(chainId))
  if (!network) throw new Error(`Network with chainId ${chainId} not found`)

  const publicClient = createPublicClient({ transport: http(network.selectedRpcUrl) })

  const baseProvider = viemProvider(publicClient)
  const provider = {
    ...baseProvider,
    async call(c: {
      to: `0x${string}`
      from?: `0x${string}`
      input?: `0x${string}`
      value?: bigint | string
      gas?: bigint | string
      gasPrice?: bigint | string
    }) {
      const result = await publicClient.call({
        to: c.to,
        account: c.from,
        data: c.input,
        value: c.value !== undefined ? BigInt(c.value) : undefined,
        gas: c.gas !== undefined ? BigInt(c.gas) : undefined,
        gasPrice: c.gasPrice !== undefined ? BigInt(c.gasPrice) : undefined
      })
      return result.data ?? '0x'
    },
    async estimateGas(c: {
      to: `0x${string}`
      from?: `0x${string}`
      input?: `0x${string}`
      value?: bigint | string
    }) {
      return publicClient.estimateGas({
        to: c.to,
        account: c.from,
        data: c.input,
        value: c.value !== undefined ? BigInt(c.value) : undefined
      })
    },
    async getGasPrice() {
      return publicClient.getGasPrice()
    },
    async getTransactionCount(address: `0x${string}`, block?: string) {
      return BigInt(
        await publicClient.getTransactionCount({
          address,
          blockTag: (block as 'latest' | 'pending' | undefined) ?? 'latest'
        })
      )
    }
  }

  return { keystore: pluginKeystore, network: pluginNetwork, storage: pluginStorage, provider }
}

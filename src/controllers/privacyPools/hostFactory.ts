import { HDNodeWallet, Mnemonic } from 'ethers'
import { createPublicClient, http } from 'viem'
import { viem as viemProvider } from '@kohaku-eth/provider/viem'
import { Host, Storage as PluginStorage } from '@kohaku-eth/plugins'
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

  const masterNode = HDNodeWallet.fromSeed(Mnemonic.fromPhrase(savedSeed.seed).computeSeed())
  savedSeed.seed = ''

  const pluginKeystore = {
    deriveAt(path: string) {
      return masterNode.derivePath(path).privateKey as `0x${string}`
    }
  }

  const pluginNetwork = { fetch: globalThis.fetch.bind(globalThis) }

  const pluginStorage = storage ?? createInMemoryStorage()

  const network = networks.networks.find((n) => n.chainId === BigInt(chainId))
  if (!network) throw new Error(`Network with chainId ${chainId} not found`)

  const publicClient = createPublicClient({ transport: http(network.selectedRpcUrl) })
  const provider = viemProvider(publicClient)

  return { keystore: pluginKeystore, network: pluginNetwork, storage: pluginStorage, provider }
}

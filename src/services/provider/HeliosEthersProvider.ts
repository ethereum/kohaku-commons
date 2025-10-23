import {
  Network as HeliosNetworkName,
  createHeliosProvider,
  HeliosProvider,
  NetworkKind
} from '@a16z/helios'
import { Eip1193Provider, JsonRpcProvider, Network } from 'ethers'
import type { MinNetworkConfig } from './getRpcProvider'

export class HeliosEthersProvider implements Eip1193Provider {
  readonly config: MinNetworkConfig

  readonly rpcUrl: string

  private heliosInitPromise?: Promise<HeliosProvider>

  private staticNetwork: Network

  private heliosNetworkName: HeliosNetworkName

  private SYNC_TIMEOUT_MS = 12000

  private FALLBACK_COOLDOWN_MS = 10000

  private syncedHelios: HeliosProvider | null = null

  private lastFallbackTime: number | null = null

  private fallbackProvider: JsonRpcProvider | null = null

  constructor(config: MinNetworkConfig, rpcUrl: string, staticNetwork: Network) {
    this.config = config
    this.rpcUrl = rpcUrl
    this.staticNetwork = staticNetwork
    this.heliosNetworkName = HeliosEthersProvider.getHeliosNetworkName(staticNetwork.chainId)
  }

  static getHeliosNetworkName(chainId: bigint): HeliosNetworkName {
    const map: Record<string, HeliosNetworkName | undefined> = {
      1: 'mainnet',
      5: 'goerli',
      11155111: 'sepolia',
      17000: 'holesky',
      17001: 'hoodi',
      10: 'op-mainnet',
      8453: 'base',
      4801: 'worldchain',
      7777777: 'zora',
      130: 'unichain',
      59144: 'linea',
      59141: 'linea-sepolia'
    }

    const name = map[`${chainId}`]

    if (name === undefined) {
      throw new Error(`Couldn't map chainId ${chainId} to a Helios network name`)
    }

    return name
  }

  private isInCooldown(): boolean {
    if (this.lastFallbackTime === null) return false
    return Date.now() - this.lastFallbackTime < this.FALLBACK_COOLDOWN_MS
  }

  private getFallbackProvider(): JsonRpcProvider {
    if (!this.fallbackProvider) {
      this.fallbackProvider = new JsonRpcProvider(this.rpcUrl, this.staticNetwork, {
        staticNetwork: this.staticNetwork,
        batchMaxCount: this.config.batchMaxCount
      })
    }
    return this.fallbackProvider
  }

  private async getSyncedHelios(): Promise<HeliosProvider> {
    if (this.syncedHelios) {
      return this.syncedHelios
    }

    if (!this.heliosInitPromise) {
      let kind: NetworkKind

      if (this.config.isOptimistic) {
        kind = 'opstack'
      } else if (this.config.isLinea) {
        kind = 'linea'
      } else {
        kind = 'ethereum'
      }

      this.heliosInitPromise = createHeliosProvider(
        {
          executionRpc: this.rpcUrl,
          consensusRpc: this.config.consensusRpcUrl,
          checkpoint: this.config.heliosCheckpoint,
          network: this.heliosNetworkName
        },
        kind
      )
    }

    let helios: HeliosProvider
    try {
      helios = await this.heliosInitPromise
    } catch (e) {
      // Provider creation failed; reset promise to allow retries and enter cooldown
      this.heliosInitPromise = undefined
      this.lastFallbackTime = Date.now()
      throw e
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('Helios sync timeout'))
      }, this.SYNC_TIMEOUT_MS)
    })

    try {
      await Promise.race([helios.waitSynced(), timeoutPromise])
      this.syncedHelios = helios
      return helios
    } catch (error) {
      this.lastFallbackTime = Date.now()

      // Continue syncing in the background so it can complete later
      helios
        .waitSynced()
        .then(() => {
          this.syncedHelios = helios
        })
        .catch(() => {
          // Ignore errors from background sync
        })

      throw error
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  // This takes about a minute. You can call this proactively if you want Helios to respond faster
  // later.
  async warmUp() {
    try {
      await this.getSyncedHelios()
    } catch (error) {
      // Ignore init/sync errors during warmup - fallback will handle it
    }
  }

  async request({ method, params }: { method: string; params: any[] }) {
    if (this.syncedHelios) {
      return this.syncedHelios.request({ method, params })
    }

    if (this.isInCooldown()) {
      return this.getFallbackProvider().send(method, params ?? [])
    }

    try {
      const helios = await this.getSyncedHelios()
      return await helios.request({ method, params })
    } catch (error) {
      return this.getFallbackProvider().send(method, params ?? [])
    }
  }
}

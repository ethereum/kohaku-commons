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

  private heliosSyncPromise?: Promise<void>

  private throwAfterTimeout?: Promise<void>

  private timeoutTimerId?: NodeJS.Timeout

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

  private initializeHelios(): Promise<HeliosProvider> {
    let kind: NetworkKind

    if (this.config.isOptimistic) {
      kind = 'opstack'
    } else if (this.config.isLinea) {
      kind = 'linea'
    } else {
      kind = 'ethereum'
    }

    return createHeliosProvider(
      {
        executionRpc: this.rpcUrl,
        consensusRpc: this.config.consensusRpcUrl,
        checkpoint: this.config.heliosCheckpoint,
        network: this.heliosNetworkName
      },
      kind
    )
  }

  private isInCooldown(): boolean {
    if (this.lastFallbackTime === null) return false
    return Date.now() - this.lastFallbackTime < this.FALLBACK_COOLDOWN_MS
  }

  getFallbackProvider(): JsonRpcProvider {
    if (!this.fallbackProvider) {
      this.fallbackProvider = new JsonRpcProvider(this.rpcUrl, this.staticNetwork, {
        staticNetwork: this.staticNetwork,
        batchMaxCount: this.config.batchMaxCount
      })
    }
    return this.fallbackProvider
  }

  private setTimeoutAndThrow(): Promise<void> {
    return new Promise<void>((_, reject) => {
      this.timeoutTimerId = setTimeout(() => {
        reject(new Error('Helios sync timeout'))
      }, this.SYNC_TIMEOUT_MS)
    })
  }

  private async getSyncedHelios(): Promise<HeliosProvider> {
    if (this.syncedHelios) {
      return this.syncedHelios
    }

    if (!this.heliosInitPromise) {
      this.heliosInitPromise = this.initializeHelios()
    }

    let helios: HeliosProvider
    try {
      helios = await this.heliosInitPromise
    } catch (e) {
      this.heliosInitPromise = undefined
      throw new Error(`Helios initialization failed: ${(e as Error).message}`)
    }

    if (!this.heliosSyncPromise) {
      this.heliosSyncPromise = helios.waitSynced()
      this.heliosSyncPromise.catch(() => {
        this.heliosSyncPromise = undefined
      })
    }

    if (!this.throwAfterTimeout) {
      this.throwAfterTimeout = this.setTimeoutAndThrow()
    }

    try {
      await Promise.race([this.heliosSyncPromise, this.throwAfterTimeout])
      this.syncedHelios = helios
      return helios
    } catch (error) {
      this.throwAfterTimeout = undefined
      this.lastFallbackTime = Date.now()
      throw error
    } finally {
      if (this.timeoutTimerId) {
        clearTimeout(this.timeoutTimerId)
        this.timeoutTimerId = undefined
      }
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

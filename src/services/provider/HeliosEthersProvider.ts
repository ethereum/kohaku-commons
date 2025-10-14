/* eslint-disable no-underscore-dangle */

import { createHeliosProvider, HeliosProvider, NetworkKind } from '@a16z/helios'
import { AbstractProvider, Network, PerformActionRequest } from 'ethers'
import { RPCProvider } from 'interfaces/provider'
import type { MinNetworkConfig } from './getRpcProvider'
import { mapPerformActionToJsonRpc } from './mapPerformActionToJsonRpc'

export class HeliosEthersProvider extends AbstractProvider implements RPCProvider {
  readonly config: MinNetworkConfig

  readonly rpcUrl: string

  private heliosProviderPromise?: Promise<HeliosProvider>

  private cachedNetwork: Network | null = null

  constructor(config: MinNetworkConfig, rpcUrl: string, staticNetwork?: Network) {
    super(staticNetwork)

    this.config = config
    this.rpcUrl = rpcUrl
  }

  private async getSyncedProvider() {
    if (!this.heliosProviderPromise) {
      let kind: NetworkKind

      if (this.config.isOptimistic) {
        kind = 'opstack'
      } else if (this.config.isLinea) {
        kind = 'linea'
      } else {
        kind = 'ethereum'
      }

      this.heliosProviderPromise = createHeliosProvider(
        {
          executionRpc: this.rpcUrl,
          consensusRpc: this.config.consensusRpcUrl
          // network: "mainnet" | "goerli" | "sepolia" | ...
          // FIXME: network apparently defaults to mainnet, so we need to specify
          //        otherwise?
        },
        kind
      )
    }

    const provider = await this.heliosProviderPromise
    await provider.waitSynced()

    return provider
  }

  // This takes about a minute. You can call this proactively if you want Helios to respond faster
  // later.
  async warmUp() {
    await this.getSyncedProvider()
  }

  async _send(method: string, params: unknown[]) {
    const provider = await this.getSyncedProvider()

    return provider.request({ method, params })
  }

  send(method: string, params: any[] = []) {
    return this._send(method, params)
  }

  request({ method, params = [] }: { method: string; params: any[] }) {
    return this._send(method, params)
  }

  _getConnection() {
    return { url: this.rpcUrl }
  }

  async _detectNetwork(): Promise<Network> {
    // Return cached network if available
    if (this.cachedNetwork) {
      return this.cachedNetwork
    }

    let network: Network

    // If we have a chainId in config, create a static network from it
    if (this.config.chainId) {
      network = Network.from(Number(this.config.chainId))
    } else {
      // Fallback: query the network via eth_chainId RPC call
      const chainIdHex = await this._send('eth_chainId', [])
      const chainId = parseInt(chainIdHex as string, 16)
      network = Network.from(chainId)
    }

    // Cache the network for future calls
    this.cachedNetwork = network
    return network
  }

  _perform<T = any>(req: PerformActionRequest): Promise<T> {
    return this._send(...mapPerformActionToJsonRpc(req))
  }
}

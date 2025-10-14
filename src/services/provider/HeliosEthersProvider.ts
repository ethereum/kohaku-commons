/* eslint-disable no-underscore-dangle */

import { createHeliosProvider, HeliosProvider, NetworkKind } from '@a16z/helios'
import { AbstractProvider, Network, PerformActionRequest } from 'ethers'
import { RPCProvider } from 'interfaces/provider'
import type { MinNetworkConfig } from './getRpcProvider'
import { mapPerformActionToJsonRpc } from './mapPerformActionToJsonRpc'

export class HeliosEthersProvider extends AbstractProvider implements RPCProvider {
  config: MinNetworkConfig

  rpcUrl: string

  heliosProviderPromise: Promise<HeliosProvider>

  private cachedNetwork: Network | null = null

  constructor(config: MinNetworkConfig, rpcUrl: string, staticNetwork?: Network) {
    super(staticNetwork)

    this.config = config
    this.rpcUrl = rpcUrl

    let kind: NetworkKind

    if (config.isOptimistic) {
      kind = 'opstack'
    } else if (config.isLinea) {
      kind = 'linea'
    } else {
      kind = 'ethereum'
    }

    this.heliosProviderPromise = createHeliosProvider(
      {
        executionRpc: rpcUrl,
        consensusRpc: config.consensusRpcUrl
        // network: "mainnet" | "goerli" | "sepolia" | ...
        // FIXME: network apparently defaults to mainnet, so we need to specify
        //        otherwise?
      },
      kind
    )
  }

  async _send(method: string, params: unknown[]) {
    const heliosProvider = await this.heliosProviderPromise
    await heliosProvider.waitSynced()

    return heliosProvider.request({ method, params })
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

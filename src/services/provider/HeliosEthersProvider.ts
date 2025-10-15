/* eslint-disable no-underscore-dangle */

import {
  Network as HeliosNetworkName,
  createHeliosProvider,
  HeliosProvider,
  NetworkKind
} from '@a16z/helios'
import { AbstractProvider, Network, PerformActionRequest } from 'ethers'
import { RPCProvider } from 'interfaces/provider'
import type { MinNetworkConfig } from './getRpcProvider'
import { mapPerformActionToJsonRpc } from './mapPerformActionToJsonRpc'

export class HeliosEthersProvider extends AbstractProvider implements RPCProvider {
  readonly config: MinNetworkConfig

  readonly rpcUrl: string

  private heliosProviderPromise?: Promise<HeliosProvider>

  private staticNetwork: Network

  private heliosNetworkName: HeliosNetworkName

  constructor(config: MinNetworkConfig, rpcUrl: string, staticNetwork: Network) {
    super(staticNetwork)

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
          consensusRpc: this.config.consensusRpcUrl,
          network: this.heliosNetworkName
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
    return this.staticNetwork
  }

  _perform<T = any>(req: PerformActionRequest): Promise<T> {
    return this._send(...mapPerformActionToJsonRpc(req))
  }
}

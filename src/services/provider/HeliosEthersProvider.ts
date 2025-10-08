import { createHeliosProvider, HeliosProvider, NetworkKind } from '@a16z/helios'
import { AbstractProvider, Network } from 'ethers'
import { RPCProvider } from 'interfaces/provider'
import type { MinNetworkConfig } from './getRpcProvider'

export class HeliosEthersProvider extends AbstractProvider implements RPCProvider {
  config: MinNetworkConfig

  rpcUrl: string

  heliosProviderPromise: Promise<HeliosProvider>

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

  // eslint-disable-next-line no-underscore-dangle
  async _send(method: string, params: unknown[]) {
    const heliosProvider = await this.heliosProviderPromise

    return heliosProvider.request({ method, params })
  }

  send(method: string, params: any[] = []) {
    // eslint-disable-next-line no-underscore-dangle
    return this._send(method, params)
  }

  request({ method, params = [] }: { method: string; params: any[] }) {
    // eslint-disable-next-line no-underscore-dangle
    return this._send(method, params)
  }

  // eslint-disable-next-line no-underscore-dangle
  _getConnection() {
    return { url: this.rpcUrl }
  }
}

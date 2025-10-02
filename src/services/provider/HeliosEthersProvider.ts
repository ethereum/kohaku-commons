import { createHeliosProvider, HeliosProvider } from '@a16z/helios'
import { AbstractProvider, Network } from 'ethers'
import { RPCProvider } from 'interfaces/provider'

export class HeliosEthersProvider extends AbstractProvider implements RPCProvider {
  rpcUrl: string

  heliosProviderPromise: Promise<HeliosProvider>

  constructor(rpcUrl: string, network?: Network) {
    super(network)

    this.rpcUrl = rpcUrl

    this.heliosProviderPromise = createHeliosProvider(
      {
        // TODO
      },
      'ethereum'
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

  getRpcUrl() {
    return this.rpcUrl
  }
}

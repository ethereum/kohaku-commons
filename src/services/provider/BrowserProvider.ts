/* eslint-disable no-underscore-dangle */

import { BrowserProvider as BrowserProviderEthers, EnsResolver, JsonRpcProvider } from 'ethers'
import { RPCProvider } from '../../interfaces/provider'
import { HeliosEthersProvider } from './HeliosEthersProvider'

export class BrowserProvider extends BrowserProviderEthers implements RPCProvider {
  #heliosProvider: HeliosEthersProvider

  readonly rpcUrl: string

  constructor(provider: HeliosEthersProvider, rpcUrl: string) {
    super(provider)
    this.#heliosProvider = provider
    this.rpcUrl = rpcUrl
  }

  // @TODO Now that Helios abstraction is leaking all over the place,
  // we should rework provider structure and move fallback logic away from Helios provider
  getFallbackProvider(): JsonRpcProvider {
    return this.#heliosProvider.getFallbackProvider()
  }

  _getConnection(): { url: string } {
    return { url: this.rpcUrl }
  }

  async getResolver(name: string): Promise<null | EnsResolver> {
    return super.getResolver(name)
  }

  onCheckpointUpdate(callback: (checkpoint: string) => void) {
    this.#heliosProvider.onCheckpointUpdate(callback)
  }
}

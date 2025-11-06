/* eslint-disable no-underscore-dangle */

import { BrowserProvider as BrowserProviderEthers, Eip1193Provider, EnsResolver } from 'ethers'
import { RPCProvider } from '../../interfaces/provider'

export class BrowserProvider extends BrowserProviderEthers implements RPCProvider {
  readonly rpcUrl: string

  constructor(provider: Eip1193Provider, rpcUrl: string) {
    super(provider)
    this.rpcUrl = rpcUrl
  }

  _getConnection(): { url: string } {
    return { url: this.rpcUrl }
  }

  async getResolver(name: string): Promise<null | EnsResolver> {
    return super.getResolver(name)
  }
}

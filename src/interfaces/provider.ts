import { EnsResolver, Provider } from 'ethers'

export type RPCProvider = Provider & {
  send(method: string, params: any[]): Promise<any>
  request?(args: { method: string; params?: any[] }): Promise<any>
  _getConnection(): { url: string }
  isWorking?: boolean
  getResolver(name: string): Promise<null | EnsResolver>
}

export type RPCProviders = { [chainId: string]: RPCProvider }

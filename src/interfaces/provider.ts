import { EnsResolver, Provider } from 'ethers'
import { RpcProviderKind } from './network'

export type RPCProvider = Provider & {
  send(method: string, params: any[]): Promise<any>
  request?(args: { method: string; params?: any[] }): Promise<any>
  _getConnection(): { url: string }
  isWorking?: boolean
  rpcProvider?: RpcProviderKind
  getResolver(name: string): Promise<null | EnsResolver>
}

export type RPCProviders = { [chainId: string]: RPCProvider }

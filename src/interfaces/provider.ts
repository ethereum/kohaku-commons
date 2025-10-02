import { Provider } from 'ethers'

export type RPCProvider = Provider & {
  send(method: string, params: any[]): Promise<any>
  request(args: { method: string; params?: any[] }): Promise<any>
  getRpcUrl(): string
  isWorking?: boolean
}

export type RPCProviders = { [chainId: string]: RPCProvider }

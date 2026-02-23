import { JsonRpcProvider, Network, Provider } from 'ethers'

import { Network as NetworkConfig, RpcProviderKind } from '../../interfaces/network'
import { BrowserProvider } from './BrowserProvider'
import {
  ColibriRpcProvider,
  ColibriRpcProviderOptions,
  isColibriSupportedChain
} from './ColibriRpcProvider'
import { HeliosEthersProvider } from './HeliosEthersProvider'

export type MinNetworkConfig = Omit<Partial<NetworkConfig>, 'chainId'> & {
  rpcUrls: string[]
  chainId?: bigint | number
}

export type GetRpcProviderConfig = MinNetworkConfig & ColibriRpcProviderOptions

export function getRpcProvider (config: GetRpcProviderConfig, forceBypassHelios: boolean = false) {
  if (!config.rpcUrls.length) {
    throw new Error('rpcUrls must be a non-empty array')
  }

  let rpcUrl = config.rpcUrls[0]

  if (config.selectedRpcUrl) {
    const prefUrl = config.rpcUrls.find((u) => u === config.selectedRpcUrl)
    if (prefUrl) rpcUrl = prefUrl
  }

  if (!rpcUrl) {
    throw new Error('Invalid RPC URL provided')
  }

  let staticNetwork: Network | undefined

  if (config.chainId) {
    staticNetwork = Network.from(Number(config.chainId))
  }

  const providerKind = forceBypassHelios ? 'rpc' : ( config.rpcProvider ?? 'rpc' )
  let provider: JsonRpcProvider | BrowserProvider | ColibriRpcProvider 
  switch (providerKind) {
    case 'rpc':
      provider = new JsonRpcProvider(rpcUrl, staticNetwork, {
        staticNetwork,
        batchMaxCount: config.batchMaxCount
      })
      break

    case 'helios':
      if (!staticNetwork) {
        const advice = config.chainId === undefined ? ' (likely fix: specify chainId)' : ''
  
        throw new Error(`Cannot use Helios without staticNetwork${advice}`)
      }
      const heliosProvider = new HeliosEthersProvider(config, rpcUrl, staticNetwork)
      provider = new BrowserProvider(heliosProvider, rpcUrl)
      break

    case 'colibri':
      if (!config.chainId || !isColibriSupportedChain(config.chainId)) {
        throw new Error(`Colibri is not supported for chain ${config.chainId}`)
      }
      const proverRpcUrl = config.proverRpcUrl 
      const colibriOverrides =
        proverRpcUrl && proverRpcUrl.trim()
          ? { ...(config.colibri || {}), prover: [proverRpcUrl.trim()] }
          : config.colibri
  
      provider = new ColibriRpcProvider(rpcUrl, config.chainId, {
        batchMaxCount: config.batchMaxCount,
        colibri: colibriOverrides
      })
      break

    default:
      throw new Error(`Invalid provider kind: ${providerKind}`)
  }

  ;(provider as any).rpcProvider = providerKind
  return provider
}



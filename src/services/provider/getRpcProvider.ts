import { JsonRpcProvider, Network } from 'ethers'

import { Network as NetworkConfig } from '../../interfaces/network'
import { BrowserProvider } from './BrowserProvider'
import { ColibriRpcProvider, ColibriRpcProviderOptions, isColibriEnabledForChain } from './ColibriRpcProvider'
import { HeliosEthersProvider } from './HeliosEthersProvider'

export type MinNetworkConfig = Partial<NetworkConfig> & {
  rpcUrls: string[]
}

export type GetRpcProviderConfig = MinNetworkConfig & ColibriRpcProviderOptions

const getRpcProvider = (config: GetRpcProviderConfig, forceBypassHelios: boolean = false) => {
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

  if (config.useHelios && !forceBypassHelios) {
    if (!staticNetwork) {
      const advice = config.chainId === undefined ? ' (likely fix: specify chainId)' : ''

      throw new Error(`Cannot use Helios without staticNetwork${advice}`)
    }
    const heliosProvider = new HeliosEthersProvider(config, rpcUrl, staticNetwork)
    return new BrowserProvider(heliosProvider, rpcUrl)
  }

  if (config.chainId && isColibriEnabledForChain(config.chainId, { colibri: config.colibri })) {
    return new ColibriRpcProvider(rpcUrl, config.chainId, {
      batchMaxCount: config.batchMaxCount,
      colibri: config.colibri
    })
  }

  return new JsonRpcProvider(rpcUrl, staticNetwork, {
    staticNetwork,
    batchMaxCount: config.batchMaxCount
  })
}

export { getRpcProvider }

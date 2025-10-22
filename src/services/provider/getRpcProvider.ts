import { JsonRpcProvider, Network } from 'ethers'

import { BrowserProvider } from './BrowserProvider'
import { Network as NetworkConfig } from '../../interfaces/network'
import { HeliosEthersProvider } from './HeliosEthersProvider'

export type MinNetworkConfig = Partial<NetworkConfig> & {
  rpcUrls: string[]
}

const getRpcProvider = (config: MinNetworkConfig) => {
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

  if (config.useHelios) {
    if (!staticNetwork) {
      const advice = config.chainId === undefined ? ' (likely fix: specify chainId)' : ''

      throw new Error(`Cannot use Helios without staticNetwork${advice}`)
    }
    const heliosProvider = new HeliosEthersProvider(config, rpcUrl, staticNetwork)
    return new BrowserProvider(heliosProvider, rpcUrl)
  }

  return new JsonRpcProvider(rpcUrl, staticNetwork, {
    staticNetwork,
    batchMaxCount: config.batchMaxCount
  })
}

export { getRpcProvider }

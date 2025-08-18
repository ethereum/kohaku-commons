import { JsonRpcProvider, Network } from 'ethers'

import { Network as NetworkInterface } from '../../interfaces/network'

interface ProviderOptions {
  batchMaxCount: number
}

const getRpcProvider = (
  rpcUrls: NetworkInterface['rpcUrls'],
  chainId?: bigint | number,
  selectedRpcUrl?: string,
  options?: ProviderOptions
) => {
  if (!rpcUrls.length) {
    throw new Error('rpcUrls must be a non-empty array')
  }

  let rpcUrl = rpcUrls[0]

  if (selectedRpcUrl) {
    const prefUrl = rpcUrls.find((u) => u === selectedRpcUrl)
    if (prefUrl) rpcUrl = prefUrl
  }

  if (!rpcUrl) {
    throw new Error('Invalid RPC URL provided')
  }

  if (chainId) {
    const staticNetwork = Network.from(Number(chainId))

    if (staticNetwork) {
      return new JsonRpcProvider(rpcUrl, staticNetwork, { staticNetwork, ...options })
    }
  }

  return new JsonRpcProvider(rpcUrl)
}

export { getRpcProvider }

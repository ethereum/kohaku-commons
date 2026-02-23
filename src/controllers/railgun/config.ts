import { type Chain, sepolia } from 'viem/chains'

// Add chains to the whitelist to be used in the app
const testnetChains: readonly [Chain, ...Chain[]] = [sepolia]

export const whitelistedChains = testnetChains

export type ChainAssets = 'ETH' | 'USDC' | 'USDT'

export interface ChainData {
  [chainId: number]: {
    name: string
    symbol: string
    decimals: number
    image: string
    explorerUrl: string
    rpcUrl: string
    relayers: {
      name: string
      url: string
    }[]
  }
}

const testnetChainData: ChainData = {
  // Testnets
  [sepolia.id]: {
    name: sepolia.name,
    symbol: sepolia.nativeCurrency.symbol,
    decimals: sepolia.nativeCurrency.decimals,
    image: '',
    explorerUrl: sepolia.blockExplorers.default.url,
    // sdkRpcUrl: `/api/hypersync-rpc?chainId=11155111`, // Secure Hypersync proxy (relative URL)
    rpcUrl: 'https://eth-sepolia.g.alchemy.com/v2/',
    relayers: [
      { name: 'Testnet Relay', url: 'https://testnet-relayer.railgun.com' },
      { name: 'Freedom Relay', url: 'https://fastrelay.xyz' }
    ],
  }
}

export const chainData = testnetChainData

export const getRpcUrl = (chainId: number) => {
  return chainData[chainId].rpcUrl
}

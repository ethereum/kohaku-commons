import { type Address, parseEther } from 'viem'
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
      //   {
      //     chainId: sepolia.id,
      //     assetAddress: '0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0',
      //     address: '0x6709277E170DEe3E54101cDb73a450E392ADfF54',
      //     scope: 9423591183392302543658559874370404687995075471172962430042059179876435583731n,
      //     deploymentBlock: 8587019n,
      //     entryPointAddress: '0x34A2068192b1297f2a7f85D7D8CdE66F8F0921cB',
      //     maxDeposit: parseUnits('100', 6),
      //     asset: 'USDT',
      //     assetDecimals: 6,
      //     isStableAsset: true,
      //   },
      //   {
      //     chainId: sepolia.id,
      //     assetAddress: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
      //     address: '0x0b062Fe33c4f1592D8EA63f9a0177FcA44374C0f',
      //     scope: 18021368285297593722986850677939473668942851500120722179451099768921996600282n,
      //     deploymentBlock: 8587019n,
      //     entryPointAddress: '0x34A2068192b1297f2a7f85D7D8CdE66F8F0921cB',
      //     maxDeposit: parseUnits('100', 6),
      //     asset: 'USDC',
      //     assetDecimals: 6,
      //     isStableAsset: true,
      //   },
  }
}

export const chainData = testnetChainData

export const getRpcUrl = (chainId: number) => {
  return chainData[chainId].rpcUrl
}

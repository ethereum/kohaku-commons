import { Network } from '../interfaces/network'
import { PIMLICO } from './bundlers'

const ALCHEMY_API_KEY = process.env.REACT_APP_ALCHEMY_API_KEY

const testnetNetworks: Network[] = [
  {
    name: 'Sepolia',
    nativeAssetSymbol: 'ETH',
    has7702: false,
    nativeAssetName: 'Ether',
    rpcUrls: [`https://eth-sepolia.g.alchemy.com/v2/${ALCHEMY_API_KEY}`],
    selectedRpcUrl: `https://eth-sepolia.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
    consensusRpcUrl: 'http://unstable.sepolia.beacon-api.nimbus.team/',
    rpcNoStateOverride: true,
    chainId: 11155111n,
    iconUrls: ['https://icons.llamao.fi/icons/chains/rsz_ethereum.jpg'],
    explorerUrl: 'https://sepolia.etherscan.io',
    erc4337: {
      enabled: false,
      hasPaymaster: false,
      hasBundlerSupport: false,
      bundlers: [],
      defaultBundler: PIMLICO
    },
    isSAEnabled: false,
    hasRelayer: false,
    areContractsDeployed: true,
    platformId: 'ethereum-sepolia',
    nativeAssetId: 'ethereum-sepolia',
    hasSingleton: true,
    features: [],
    feeOptions: { is1559: true },
    predefined: true,
    useHelios: true,
    heliosCheckpoint: '0x5ba822735c5060e34516eab195b1a84af6b6e830f95dca276812354994f70245'
  }
  // {
  //   name: 'Base Sepolia',
  //   nativeAssetSymbol: 'ETH',
  //   has7702: false,
  //   nativeAssetName: 'Ether',
  //   rpcUrls: [`https://base-sepolia.g.alchemy.com/v2/${ALCHEMY_API_KEY}`],
  //   selectedRpcUrl: `https://base-sepolia.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
  //   rpcNoStateOverride: false,
  //   chainId: 84532n,
  //   explorerUrl: 'https://base-sepolia.blockscout.com',
  //   erc4337: {
  //     enabled: false,
  //     hasPaymaster: false,
  //     hasBundlerSupport: false,
  //     bundlers: [],
  //     defaultBundler: PIMLICO
  //   },
  //   isSAEnabled: false,
  //   hasRelayer: false,
  //   areContractsDeployed: true,
  //   platformId: 'base-sepolia',
  //   nativeAssetId: 'base-sepolia',
  //   hasSingleton: true,
  //   features: [],
  //   feeOptions: { is1559: true },
  //   predefined: true
  // },
  // {
  //   name: 'Arbitrum Sepolia',
  //   nativeAssetSymbol: 'ETH',
  //   has7702: false,
  //   nativeAssetName: 'Ether',
  //   rpcUrls: [`https://arb-sepolia.g.alchemy.com/v2/${ALCHEMY_API_KEY}`],
  //   selectedRpcUrl: `https://arb-sepolia.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
  //   rpcNoStateOverride: false,
  //   chainId: 421614n,
  //   explorerUrl: 'https://sepolia.arbiscan.io',
  //   erc4337: {
  //     enabled: false,
  //     hasPaymaster: false,
  //     hasBundlerSupport: false,
  //     bundlers: [],
  //     defaultBundler: PIMLICO
  //   },
  //   isSAEnabled: false,
  //   hasRelayer: false,
  //   areContractsDeployed: true,
  //   platformId: 'arbitrum-sepolia',
  //   nativeAssetId: 'arbitrum-sepolia',
  //   hasSingleton: true,
  //   features: [],
  //   feeOptions: { is1559: true },
  //   predefined: true
  // }
]
export { testnetNetworks }

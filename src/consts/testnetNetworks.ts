import { Network } from '../interfaces/network'
import { PIMLICO } from './bundlers'

const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL
const USE_HELIOS = process.env.USE_HELIOS
const HELIOS_CHECKPOINT = process.env.HELIOS_CHECKPOINT

if (!SEPOLIA_RPC_URL) {
  throw new Error('SEPOLIA_RPC_URL is not set')
}

const testnetNetworks: Network[] = [
  {
    name: 'Sepolia',
    nativeAssetSymbol: 'ETH',
    has7702: false,
    nativeAssetName: 'Ether',
    rpcUrls: [SEPOLIA_RPC_URL || ''],
    selectedRpcUrl: SEPOLIA_RPC_URL || '',
    consensusRpcUrl: 'http://unstable.sepolia.beacon-api.nimbus.team/',
    rpcNoStateOverride: false,
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
    useHelios: USE_HELIOS === 'true',
    heliosCheckpoint:
      HELIOS_CHECKPOINT || '0x178bea570e6aff265cf670b1b65be4479dca2ed9c8c4d0a5752ffa36ea670395'
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

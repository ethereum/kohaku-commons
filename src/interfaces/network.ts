import { BUNDLER } from '../consts/bundlers'

export type ChainId = bigint

export interface Erc4337settings {
  enabled: boolean
  hasPaymaster: boolean
  hasBundlerSupport?: boolean
  bundlers?: BUNDLER[]
  defaultBundler?: BUNDLER
  // increase the bundler estimation & gas price by a percent so we get
  // "txn underpriced" errors less often
  increasePreVerGas?: number
}

interface FeeOptions {
  is1559: boolean
  minBaseFee?: bigint
  elasticityMultiplier?: bigint
  baseFeeMaxChangeDenominator?: bigint
  feeIncrease?: bigint // should we increase the relayer fee in %
  // transactions on Base get stuck on slow as we lower the baseFee a lot
  // so we make the minBaseFee the same as the last block one
  minBaseFeeEqualToLastBlock?: boolean
}

/** Current network configuration and statuses, which may change over time */
export interface NetworkInfo {
  chainId: bigint
  isSAEnabled: boolean
  hasSingleton: boolean
  isOptimistic: boolean
  rpcNoStateOverride: boolean
  erc4337: Erc4337settings
  areContractsDeployed: boolean
  feeOptions: FeeOptions
  platformId: string
  nativeAssetId: string
  flagged: boolean
}

export type NetworkInfoLoading<T> = {
  [K in keyof T]: T[K] | 'LOADING'
}

export interface NetworkFeature {
  id: string
  title: string
  msg?: string
  level: 'success' | 'danger' | 'warning' | 'loading' | 'initial'
}

/**
 * If you add a new mandatory property, make sure to adjust accordingly
 * `sanityCheckImportantNetworkProperties` function, if needed
 */
export interface Network {
  chainId: bigint
  name: string
  nativeAssetSymbol: string
  nativeAssetName: string
  rpcUrls: string[]
  explorerUrl: string
  selectedRpcUrl: string
  erc4337: NetworkInfo['erc4337']
  rpcNoStateOverride: NetworkInfo['rpcNoStateOverride']
  feeOptions: NetworkInfo['feeOptions']
  isSAEnabled: NetworkInfo['isSAEnabled']
  areContractsDeployed: NetworkInfo['areContractsDeployed']
  features: NetworkFeature[]
  hasRelayer: boolean
  hasSingleton: NetworkInfo['hasSingleton']
  platformId: NetworkInfo['platformId']
  nativeAssetId: NetworkInfo['nativeAssetId']
  iconUrls?: string[]
  isOptimistic?: NetworkInfo['isOptimistic']
  flagged?: NetworkInfo['flagged']
  predefined: boolean
  wrappedAddr?: string
  blockGasLimit?: bigint
  oldNativeAssetSymbols?: string[]
  disableEstimateGas?: boolean
  predefinedConfigVersion?: number
  // Last time the network details were updated from the rpc for custom and no SA networks
  lastUpdatedNetworkInfo?: number
  has7702: boolean
  allowForce4337?: boolean
  disabled?: boolean
}

export interface AddNetworkRequestParams {
  name: Network['name']
  rpcUrls: Network['rpcUrls']
  selectedRpcUrl: Network['selectedRpcUrl']
  chainId: Network['chainId']
  nativeAssetSymbol: Network['nativeAssetSymbol']
  nativeAssetName: Network['nativeAssetName']
  explorerUrl: Network['explorerUrl']
  iconUrls: Network['iconUrls']
}

export interface ChainlistNetwork {
  name: string
  chain: string
  icon: string
  rpc: string[]
  features: {
    name: string
  }[]
  faucets: string[]
  nativeCurrency: {
    name: string
    symbol: string
    decimals: number
  }
  infoURL: string
  shortName: string
  chainId: number
  networkId: number
  slip44: number
  ens: {
    registry: string
  }
  explorers: {
    name: string
    url: string
    standard: string
    icon?: string
  }[]
}

export type RelayerNetwork = {
  /**
   * Mechanism to merge incoming config with user storage. If versions match -
   * prioritize user changed values. If incoming config version is higher, override user config.
   */
  predefinedConfigVersion: number
  ambireId: string
  platformId: string
  chainId: number
  name: string
  iconUrls: string[]
  explorerUrl: string
  rpcUrls: string[]
  selectedRpcUrl: string
  native: {
    symbol: string
    name: string
    coingeckoId: string
    icon: string
    decimals: number
    wrapped: {
      address: string
      symbol: string
      name: string
      coingeckoId: string
      icon: string
      decimals: number
    }
    oldNativeAssetSymbols?: string[]
  }
  isOptimistic: boolean
  disableEstimateGas: boolean
  feeOptions: {
    is1559: boolean
    elasticityMultiplier?: number
    baseFeeMaxChangeDenominator?: number
    feeIncrease?: number
    minBaseFee?: number
    minBaseFeeEqualToLastBlock?: boolean
  }
  has7702?: boolean
  smartAccounts?: {
    hasRelayer: boolean
    erc4337: {
      enabled: boolean
      hasPaymaster: boolean
      hasBundlerSupport?: boolean
      bundlers?: [bundler: BUNDLER]
      defaultBundler?: BUNDLER
      increasePreVerGas?: number
    }
  }
  disabledByDefault?: boolean
}

export type RelayerNetworkConfigResponse = { [chainId: string]: RelayerNetwork }

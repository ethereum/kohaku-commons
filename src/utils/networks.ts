import { JsonRpcProvider } from 'ethers'

import { BUNDLER } from '../consts/bundlers'
import {
  ChainlistNetwork,
  Erc4337settings,
  Network,
  NetworkFeature,
  RelayerNetwork
} from '../interfaces/network'

const hardcodedRpcUrls: { [chainId: string]: string } = {
  '11155111': 'https://eth-sepolia.public.blastapi.io'
}

const checkIsRpcUrlWorking = async (rpcUrl: string) => {
  const provider = new JsonRpcProvider(rpcUrl)

  try {
    await provider.getBlockNumber()
  } catch {
    provider?.destroy()
    return false
  }

  provider.destroy()

  return true
}

const rollProviderUrlsAndFindWorking = async (
  rpcUrls: string[],
  index: number
): Promise<string | null> => {
  const isProviderWorking = await checkIsRpcUrlWorking(rpcUrls[index])

  if (isProviderWorking) {
    return rpcUrls[index]
  }

  const nextIndex = index + 1

  if (rpcUrls.length > nextIndex) {
    return rollProviderUrlsAndFindWorking(rpcUrls, nextIndex)
  }

  return null
}

const convertToAmbireNetworkFormat = async (network: ChainlistNetwork): Promise<Network> => {
  const freeHttpRpcUrls = network.rpc.filter((rpcUrl: string) => {
    const isHttpOrHttps = rpcUrl.startsWith('http')

    if (!isHttpOrHttps) return false

    const isApiKeyRequired = /${.+}/.test(rpcUrl)

    return !isApiKeyRequired
  })
  const workingRpcUrl: string =
    hardcodedRpcUrls[network.chainId.toString()] ??
    (await rollProviderUrlsAndFindWorking(freeHttpRpcUrls, 0))

  let platformId = null
  let nativeAssetId = null

  try {
    const coingeckoRequest = await fetch(
      `https://cena.ambire.com/api/v3/platform/${Number(network.chainId)}`
    ).catch(() => ({
      error: 'currently, we cannot fetch the coingecko information'
    }))

    // set the coingecko info

    if (!('error' in coingeckoRequest)) {
      const coingeckoInfo = await coingeckoRequest.json()
      if (!coingeckoInfo.error) {
        platformId = coingeckoInfo.platformId
        nativeAssetId = coingeckoInfo.nativeAssetId
      }
    }
  } catch (e) {
    console.error(e)
    // do nothing
  }

  return {
    name: network.name,
    chainId: BigInt(network.chainId),
    rpcUrls: [workingRpcUrl ?? network.rpc[0]],
    explorerUrl: network.explorers[0].url,
    selectedRpcUrl: workingRpcUrl || '',
    platformId,
    nativeAssetId,
    nativeAssetSymbol: network.nativeCurrency.symbol,
    nativeAssetName: network.nativeCurrency.name,
    // Not needed for benzin
    hasRelayer: false,
    rpcNoStateOverride: false, // TODO
    areContractsDeployed: false, // TODO
    features: [],
    feeOptions: { is1559: false },
    flagged: false,
    hasSingleton: false,
    iconUrls: [],
    erc4337: { enabled: false, hasPaymaster: false },
    isSAEnabled: false,
    predefined: false,
    has7702: false
  }
}

/**
 * Maps the configuration of a Relayer network to the Ambire network format.
 * Needed, because the structures does NOT fully match, some values need to be
 * transformed or parsed (number to bigint). And finally, because there are
 * default values that need to be set for the so called "predefined" networks.
 */
export const mapRelayerNetworkConfigToAmbireNetwork = (
  chainId: bigint,
  relayerNetwork: RelayerNetwork
): Network & { predefinedConfigVersion: number; disabledByDefault?: boolean } => {
  const {
    name,
    explorerUrl,
    selectedRpcUrl,
    isOptimistic,
    disableEstimateGas,
    predefinedConfigVersion,
    rpcUrls,
    iconUrls,
    platformId,
    has7702,
    disabledByDefault
  } = relayerNetwork
  const {
    native: {
      symbol: nativeAssetSymbol,
      name: nativeAssetName,
      coingeckoId: nativeAssetId,
      wrapped: { address: wrappedAddr },
      oldNativeAssetSymbols
    },
    smartAccounts,
    feeOptions: incomingFeeOptions
  } = relayerNetwork

  const is7702Enabled = has7702 || false
  const hasRelayer = smartAccounts?.hasRelayer ?? false
  const incomingErc4337 = smartAccounts?.erc4337 ?? { enabled: false, hasPaymaster: false }

  const feeOptions = {
    is1559: incomingFeeOptions.is1559,
    minBaseFeeEqualToLastBlock: !!incomingFeeOptions.minBaseFeeEqualToLastBlock,
    ...(typeof incomingFeeOptions.minBaseFee === 'number' && {
      minBaseFee: BigInt(incomingFeeOptions.minBaseFee)
    }),
    ...(typeof incomingFeeOptions.elasticityMultiplier === 'number' && {
      elasticityMultiplier: BigInt(incomingFeeOptions.elasticityMultiplier)
    }),
    ...(typeof incomingFeeOptions.baseFeeMaxChangeDenominator === 'number' && {
      baseFeeMaxChangeDenominator: BigInt(incomingFeeOptions.baseFeeMaxChangeDenominator)
    }),
    ...(typeof incomingFeeOptions.feeIncrease === 'number' && {
      feeIncrease: BigInt(incomingFeeOptions.feeIncrease)
    })
  }

  const erc4337: Erc4337settings = {
    enabled: incomingErc4337.enabled,
    hasPaymaster: incomingErc4337.hasPaymaster,
    ...(typeof incomingErc4337.hasBundlerSupport === 'boolean' && {
      hasBundlerSupport: incomingErc4337.hasBundlerSupport
    }),
    ...(incomingErc4337.bundlers && {
      bundlers: incomingErc4337.bundlers as BUNDLER[]
    }),
    ...(incomingErc4337.defaultBundler && {
      defaultBundler: incomingErc4337.defaultBundler
    }),
    ...(incomingErc4337.increasePreVerGas && {
      increasePreVerGas: incomingErc4337.increasePreVerGas ?? 0
    })
  }

  // Always fallback to these values for the "predefined" networks, coming from
  // the RPC for the custom networks.
  const rpcNoStateOverride = true // @TODO Revert when overrides are supported in Helios
  const isSAEnabled = !!smartAccounts
  const areContractsDeployed = !!smartAccounts
  const features: NetworkFeature[] = []
  const hasSingleton = true

  // Coming from the RPC, only for the custom networks
  // const flagged
  // const blockGasLimit
  // const force4337

  return {
    name,
    iconUrls,
    explorerUrl,
    rpcUrls,
    selectedRpcUrl,
    isOptimistic,
    disableEstimateGas,
    platformId,
    chainId,
    nativeAssetSymbol,
    nativeAssetName,
    nativeAssetId,
    hasRelayer,
    wrappedAddr,
    oldNativeAssetSymbols,
    feeOptions,
    erc4337,
    rpcNoStateOverride,
    isSAEnabled,
    predefined: !disabledByDefault,
    predefinedConfigVersion,
    areContractsDeployed,
    features,
    hasSingleton,
    has7702: is7702Enabled,
    disabledByDefault
  }
}

export { checkIsRpcUrlWorking, convertToAmbireNetworkFormat, rollProviderUrlsAndFindWorking }

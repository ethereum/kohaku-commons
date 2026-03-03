import { ZeroAddress } from 'ethers'

import { Network } from '../interfaces/network'
import { WALLET_STAKING_ADDR, WALLET_TOKEN } from './addresses'

const COINGECKO_API_BASE_URL = 'https://api.coingecko.com/api/v3/coins/'
const COINGECKO_BASE_URL = 'https://www.coingecko.com/en/coins/'

// @TODO some form of a constants list
export function geckoIdMapper(address: string, network: Network): string | null {
  if (address === ZeroAddress) return network.nativeAssetId

  // we currently can't map aave so we're leaving this
  if (address === '0x4da27a545c0c5B758a6BA100e3a049001de870f5') return 'aave'

  const STABLE_GECKO_IDS: Record<string, string> = {
    '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238': 'usd-coin', // Sepolia
    '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48': 'usd-coin' // Mainnet
    // add others as needed
  }

  return STABLE_GECKO_IDS[address] ?? null
}

/**
 * Maps specific token addresses to alternative addresses if they are missing on
 * CoinGecko (so that they are aliased to existing tokens).
 */
export function geckoTokenAddressMapper(address: string) {
  // xWALLET is missing on CoinGecko, so alias it to WALLET token (that exists on CoinGecko)
  if (address === WALLET_STAKING_ADDR) return WALLET_TOKEN

  return address
}

/**
 * Constructs the CoinGecko API URL for a given token address and network ID.
 * Handles special cases where the CoinGecko API handles differently certain
 * tokens like the native tokens.
 */
export function getCoinGeckoTokenApiUrl({
  tokenAddr,
  geckoChainId,
  geckoNativeCoinId
}: {
  tokenAddr: string
  geckoChainId: string
  geckoNativeCoinId: string
}) {
  // CoinGecko does not handle native assets (ETH, MATIC, BNB...) via the /contract endpoint.
  // Instead, native assets are identified by URL with the `nativeAssetId` directly.
  if (tokenAddr === ZeroAddress) return `${COINGECKO_API_BASE_URL}${geckoNativeCoinId}`

  const geckoTokenAddress = geckoTokenAddressMapper(tokenAddr)
  return `${COINGECKO_API_BASE_URL}${geckoChainId}/contract/${geckoTokenAddress}`
}

/** Constructs the CoinGecko URL for a given token slug. */
export const getCoinGeckoTokenUrl = (slug: string) => `${COINGECKO_BASE_URL}${slug}`

// @ts-ignore
import constants from 'bip44-constants'
import { isAddress } from 'ethers'

// @ts-ignore
import { normalize } from '@ensdomains/eth-ens-namehash'

import { networks } from '../../consts/networks'
import { RPCProvider } from '../../interfaces/provider'
import { getRpcProvider } from '../provider'

const BIP44_BASE_VALUE = 2147483648
const ADDRESS_ZERO = '0x0000000000000000000000000000000000000000'

const normalizeDomain = (domain: string) => {
  try {
    return normalize(domain)
  } catch (e) {
    return null
  }
}

function getNormalisedCoinType(bip44Item: number[][]) {
  return bip44Item[0].length ? bip44Item[0][0] - BIP44_BASE_VALUE : null
}

async function resolveForCoin(resolver: any, bip44Item?: number[][]) {
  if (bip44Item && bip44Item.length === 1) {
    const coinType = getNormalisedCoinType(bip44Item)
    if (!coinType) return null
    return resolver.getAddress(coinType)
  }
  return resolver.getAddress()
}

export function isCorrectAddress(address: string) {
  return !(ADDRESS_ZERO === address) && isAddress(address)
}

// @TODO: Get RPC provider url from settings controller
async function resolveENSDomain(domain: string, bip44Item?: number[][]): Promise<string> {
  const normalizedDomainName = normalizeDomain(domain)
  if (!normalizedDomainName) return ''
  const ethereum = networks.find((n) => n.chainId === 1n)!
  const provider = getRpcProvider(ethereum)
  const resolver = await provider.getResolver(normalizedDomainName)
  if (!resolver) return ''
  try {
    const ethAddress = await resolver.getAddress()
    const addressForCoin = await resolveForCoin(resolver, bip44Item).catch(() => null)
    return isCorrectAddress(addressForCoin) ? addressForCoin : ethAddress || ''
  } catch (e: any) {
    // If the error comes from an internal server error don't
    // show it to the user, because it happens when a domain
    // doesn't exist and we already show a message for that.
    // https://dnssec-oracle.ens.domains/ 500 (ISE)
    if (e.message?.includes('500_SERVER_ERROR')) return ''

    throw e
  } finally {
    provider?.destroy()
  }
}

function getBip44Items(coinTicker: string) {
  if (!coinTicker) return null
  return constants.filter((item: string[]) => item[1] === coinTicker)
}

async function reverseLookupEns(address: string, provider: RPCProvider) {
  return provider.lookupAddress(address)
}

export { resolveENSDomain, getBip44Items, reverseLookupEns }

import { RPCProvider } from 'interfaces/provider'
import { Network } from '../../interfaces/network'
import { GetOptions, Portfolio, TokenResult } from '../../libs/portfolio'
import { getRpcProvider } from '../provider'

const RANDOM_ADDRESS = '0x0000000000000000000000000000000000000001'
const scheduledActions: {
  [chainId: string]:
    | {
        promise: Promise<any>
        data: { callback: Function; address: string }[]
      }
    | undefined
} = {}

export async function executeBatchedFetch(
  network: Network,
  providerOverride?: RPCProvider
): Promise<void> {
  const provider = providerOverride ?? getRpcProvider(network)
  const allAddresses =
    Array.from(new Set(scheduledActions[network.chainId.toString()]?.data.map((i) => i.address))) ||
    []
  const portfolio = new Portfolio(fetch as any, provider, network)
  const options: Partial<GetOptions> = {
    disableAutoDiscovery: true,
    additionalErc20Hints: allAddresses,
    additionalErc721Hints: Object.fromEntries(
      allAddresses.map((i) => [
        i,
        {
          tokens: ['1'],
          isKnown: false
        }
      ])
    )
  }
  const portfolioResponse = await portfolio.get(RANDOM_ADDRESS, options)

  scheduledActions[network.chainId.toString()]?.data.forEach((i) => {
    const tokenInfo =
      (i.address,
      portfolioResponse.tokens.find(
        (t) => t.address.toLocaleLowerCase() === i.address.toLowerCase()
      ))
    const nftInfo =
      (i.address,
      portfolioResponse.collections.find(
        (t) => t.address.toLocaleLowerCase() === i.address.toLowerCase()
      ))

    i.callback({ tokenInfo, nftInfo })
  })
}

/**
 * Resolves symbol and decimals for tokens or name for nfts.
 */
export async function resolveAssetInfo(
  address: string,
  network: Network,
  callback: (arg: { tokenInfo?: TokenResult; nftInfo?: { name: string } }) => void,
  providerOverride?: RPCProvider
): Promise<void> {
  if (!scheduledActions[network.chainId.toString()]?.data?.length) {
    scheduledActions[network.chainId.toString()] = {
      promise: new Promise((resolve, reject) => {
        setTimeout(async () => {
          await executeBatchedFetch(network, providerOverride).catch(reject)
          scheduledActions[network.chainId.toString()] = undefined
          resolve(0)
        }, 500)
      }),
      data: [{ address, callback }]
    }
  } else {
    scheduledActions[network.chainId.toString()]?.data.push({ address, callback })
  }
  // we are returning a promise so we can await the full execution
  return scheduledActions[network.chainId.toString()]?.promise
}

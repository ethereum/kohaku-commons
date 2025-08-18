/* eslint-disable @typescript-eslint/no-floating-promises */
import fetch from 'node-fetch'

import { expect, jest } from '@jest/globals'

import { monitor } from '../../../test/helpers/requests'
import { networks } from '../../consts/networks'
import * as assetInfo from './assetInfo'

const WETH_ADDRESS = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const USDC_ADDRESS = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const LOBSTER_ADDRESS = '0x026224A2940bFE258D0dbE947919B62fE321F042'
const UNISWAP_ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564'

global.fetch = fetch as any
interface CallbackArgs {
  nftInfo?: { name: string }
  tokenInfo?: { decimals: number; symbol: string }
}
describe('Asset info service', () => {
  test('Fetches all tokens and NFTS correctly', async () => {
    jest.spyOn(assetInfo, 'executeBatchedFetch')

    const wethCallback = jest.fn(({ tokenInfo }: CallbackArgs) =>
      expect(tokenInfo).toMatchObject({ symbol: 'WETH', decimals: 18 })
    )

    const usdcCallback = jest.fn(({ tokenInfo }: CallbackArgs) => {
      expect(tokenInfo).toMatchObject({ symbol: 'USDC', decimals: 6 })
    })
    const lobsterCallback = jest.fn(({ nftInfo }: CallbackArgs) => {
      expect(nftInfo).toMatchObject({ name: 'lobsterdao' })
    })
    const uniswapCallback = jest.fn((res: any) => {
      expect(res?.nftInfo).toBeFalsy()
      expect(res?.tokenInfo).toBeFalsy()
    })

    await Promise.all([
      assetInfo.resolveAssetInfo(WETH_ADDRESS, networks[0], wethCallback),
      assetInfo.resolveAssetInfo(USDC_ADDRESS, networks[0], usdcCallback),
      assetInfo.resolveAssetInfo(UNISWAP_ROUTER, networks[0], uniswapCallback),
      assetInfo.resolveAssetInfo(LOBSTER_ADDRESS, networks[0], lobsterCallback)
    ])
    expect(wethCallback).toHaveBeenCalledTimes(1)
    expect(usdcCallback).toHaveBeenCalledTimes(1)
    expect(lobsterCallback).toHaveBeenCalledTimes(1)
    expect(uniswapCallback).toHaveBeenCalledTimes(1)
  })

  test('Batches', async () => {
    const interceptedRequests = monitor()

    await Promise.all([
      assetInfo.resolveAssetInfo(WETH_ADDRESS, networks[0], () => {}),
      assetInfo.resolveAssetInfo(USDC_ADDRESS, networks[0], () => {}),
      assetInfo.resolveAssetInfo(UNISWAP_ROUTER, networks[0], () => {}),
      assetInfo.resolveAssetInfo(LOBSTER_ADDRESS, networks[0], () => {})
    ])
    const requests = interceptedRequests.filter((i) => i.url === networks[0].rpcUrls[0])
    expect(requests.length).toBe(1)
  })
})

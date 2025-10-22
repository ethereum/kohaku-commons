import { JsonRpcProvider, Provider } from 'ethers'

import DeFiPositionsDeploylessCode from '../../../../contracts/compiled/DeFiUniswapV3Positions.json'
import { Network } from '../../../interfaces/network'
import { fromDescriptor } from '../../deployless/deployless'
import { UNISWAP_V3 } from '../defiAddresses'
import { AssetType, Position, PositionsByProvider } from '../types'
import { uniV3DataToPortfolioPosition } from './helpers/univ3Math'

export async function getUniV3Positions(
  userAddr: string,
  provider: Provider | JsonRpcProvider,
  network: Network
): Promise<PositionsByProvider | null> {
  const { chainId } = network
  if (chainId && !UNISWAP_V3[chainId.toString() as keyof typeof UNISWAP_V3]) return null

  const { nonfungiblePositionManagerAddr, factoryAddr } =
    UNISWAP_V3[chainId.toString() as keyof typeof UNISWAP_V3]

  const deploylessDeFiPositionsGetter = fromDescriptor(
    provider,
    DeFiPositionsDeploylessCode,
    !network.rpcNoStateOverride
  )
  const [result] = await deploylessDeFiPositionsGetter.call('getUniV3Position', [
    userAddr,
    nonfungiblePositionManagerAddr,
    factoryAddr
  ])

  const data = result.map((asset: any) => ({
    positionId: asset.positionId,
    token0Symbol: asset.token0Symbol,
    token0Name: asset.token0Name,
    token0Decimals: asset.token0Decimals,
    token1Symbol: asset.token1Symbol,
    token1Name: asset.token1Name,
    token1Decimals: asset.token1Decimals,
    feeGrowthGlobal0X128: asset.feeGrowthGlobal0X128,
    positionInfo: {
      nonce: asset.positionInfo.nonce,
      operator: asset.positionInfo.operator,
      token0: asset.positionInfo.token0,
      token1: asset.positionInfo.token1,
      fee: asset.positionInfo.fee,
      tickLower: asset.positionInfo.tickLower,
      tickUpper: asset.positionInfo.tickUpper,
      liquidity: asset.positionInfo.liquidity,
      feeGrowthInside0LastX128: asset.positionInfo.feeGrowthInside0LastX128,
      feeGrowthInside1LastX128: asset.positionInfo.feeGrowthInside1LastX128,
      tokensOwed0: asset.positionInfo.tokensOwed0,
      tokensOwed1: asset.positionInfo.tokensOwed1
    },
    poolSlot0: {
      sqrtPriceX96: asset.poolSlot0.sqrtPriceX96,
      tick: asset.poolSlot0.tick,
      observationIndex: asset.poolSlot0.observationIndex,
      observationCardinality: asset.poolSlot0.observationCardinality,
      observationCardinalityNext: asset.poolSlot0.observationCardinalityNext,
      feeProtocol: asset.poolSlot0.feeProtocol,
      unlocked: asset.poolSlot0.unlocked
    }
  }))

  const positions: Position[] = data
    .map((pos: any) => {
      const tokenAmounts = uniV3DataToPortfolioPosition(
        pos.positionInfo.liquidity,
        pos.poolSlot0.sqrtPriceX96,
        pos.positionInfo.tickLower,
        pos.positionInfo.tickUpper
      )
      return {
        id: pos.positionId.toString(),
        additionalData: {
          inRange: tokenAmounts.isInRage,
          positionIndex: pos.positionId.toString(),
          liquidity: pos.positionInfo.liquidity,
          name: 'Liquidity Pool'
        },
        assets: [
          {
            address: pos.positionInfo.token0,
            symbol: pos.token0Symbol,
            name: pos.token0Name,
            decimals: Number(pos.token0Decimals),
            amount: BigInt(tokenAmounts.amount0),
            type: AssetType.Liquidity
          },
          {
            address: pos.positionInfo.token1,
            symbol: pos.token1Symbol,
            name: pos.token1Name,
            decimals: Number(pos.token1Decimals),
            amount: BigInt(tokenAmounts.amount1),
            type: AssetType.Liquidity
          }
        ]
      }
    })
    .filter((p: Position) => p.additionalData.liquidity !== BigInt(0))

  if (positions.length === 0) return null

  return {
    providerName: 'Uniswap V3',
    chainId,
    iconUrl: '',
    siteUrl: 'https://app.uniswap.org/swap',
    type: 'common',
    positions
  }
}

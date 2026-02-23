import { describe, expect, test } from '@jest/globals'

import { networks } from '../../consts/networks'
import { getRpcProvider } from '../../services/provider'
import { getAAVEPositions, getUniV3Positions } from './providers'

describe('DeFi positions', () => {
  // If this test ever fails because the accounts remove their positions, you can:
  // 1. Go to https://debank.com/protocols/matic_uniswap3/holders
  // 2. Find an account that has the required positions and use it in the test
  const userAddrUni = '0xbd67a10726e6d112295a698ea348f40d27fe5149'
  const userAddrAave = '0xe40d278afd00e6187db21ff8c96d572359ef03bf'

  const ethereum = networks.find((n) => n.chainId === 1n)
  if (!ethereum) throw new Error('unable to find ethereum network in consts')

  const polygon = networks.find((n) => n.chainId === 137n)
  if (!polygon) throw new Error('unable to find polygon network in consts')

  const providerEthereum = getRpcProvider({
    rpcUrls: ['https://invictus.ambire.com/ethereum'],
    chainId: 1n
  })

  const providerPolygon = getRpcProvider({
    rpcUrls: ['https://invictus.ambire.com/polygon'],
    chainId: 137n
  })

  describe('Uni V3', () => {
    test('Get uni v3 positions on Polygon', async () => {
      const uniV3Positions = await getUniV3Positions(userAddrUni, providerPolygon, polygon)
      expect(uniV3Positions).not.toBeNull()

      if (uniV3Positions !== null) {
        const firstPos = uniV3Positions.positions[0]
        expect(firstPos.additionalData.liquidity).toBeGreaterThan(0)
        expect(firstPos.assets.length).toBeGreaterThan(0)
      }
    })
    test('Uni V3 returns multiple positions', async () => {
      const uniV3Positions = await getUniV3Positions(userAddrUni, providerPolygon, polygon)

      expect(uniV3Positions?.positions.length).toBeGreaterThan(1)
    })
  })
  describe('AAVE v3', () => {
    test('Get AAVE positions on Ethereum', async () => {
      const aavePositions = await getAAVEPositions(userAddrAave, providerEthereum, ethereum)

      expect(aavePositions).not.toBeNull()
      if (aavePositions !== null) {
        const pos1 = aavePositions.positions[0]
        expect(pos1.additionalData.healthRate).toBeGreaterThan(1)
      }
    })
    test('AAVE returns prices, health rate, additional date and asset value', async () => {
      const aavePositions = await getAAVEPositions(userAddrAave, providerEthereum, ethereum)
      const pos = aavePositions?.positions[0]

      if (!pos) throw new Error('no positions found')

      expect(aavePositions?.positionInUSD).toBeGreaterThan(0)
      expect(pos.additionalData.positionInUSD).toBeGreaterThan(0)
      expect(pos.additionalData.healthRate).toBeGreaterThan(0)
      expect(pos.additionalData.collateralInUSD).toBeGreaterThan(0)
    })
  })
})

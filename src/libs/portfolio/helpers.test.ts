import fetch from 'node-fetch'

import { describe, expect, test } from '@jest/globals'

import { velcroUrl } from '../../../test/config'
import { networks } from '../../consts/networks'
import { getRpcProvider } from '../../services/provider'
import { getUpdatedHints } from './helpers'
import { Portfolio } from './portfolio'

const ethereum = networks.find((x) => x.chainId === 1n)
const polygon = networks.find((x) => x.chainId === 137n)

if (!ethereum || !polygon) throw new Error('Failed to find ethereum in networks')

const provider = getRpcProvider(ethereum)

const ethPortfolio = new Portfolio(fetch, provider, ethereum, velcroUrl)

const TEST_ACCOUNT_ADDRESS = '0xc4A6bB5139123bD6ba0CF387828a9A3a73EF8D1e'
const LEARNED_TOKEN_WITH_BALANCE_ADDRESS = '0x335F4e66B9B61CEE5CeaDE4e727FCEC20156B2F0'

const getTokens = async () => {
  const ethAccPortfolio = await ethPortfolio.get(TEST_ACCOUNT_ADDRESS, {
    additionalErc20Hints: [LEARNED_TOKEN_WITH_BALANCE_ADDRESS]
  })

  return ethAccPortfolio.tokens
}

describe('Portfolio helpers', () => {
  test('getUpdatedHints', async () => {
    const tokens = await getTokens()
    const key = `1:${TEST_ACCOUNT_ADDRESS}`

    const updatedHints = getUpdatedHints(
      {
        erc20s: ['0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7'],
        erc721s: {},
        lastUpdate: Date.now()
      },
      tokens,
      [],
      1n,
      {
        learnedTokens: {
          '1': {
            [LEARNED_TOKEN_WITH_BALANCE_ADDRESS]: null
          }
        },
        learnedNfts: {},
        fromExternalAPI: {
          [key]: {
            lastUpdate: Date.now(),
            erc20s: [],
            erc721s: {}
          }
        }
      },
      key,
      [],
      []
    )

    expect(tokens.find((token) => token.address === LEARNED_TOKEN_WITH_BALANCE_ADDRESS))
    expect(updatedHints.fromExternalAPI[key]?.erc20s).toContain(
      '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7'
    )
    expect(updatedHints.learnedTokens['1'][LEARNED_TOKEN_WITH_BALANCE_ADDRESS]).toBeDefined()
  })
})

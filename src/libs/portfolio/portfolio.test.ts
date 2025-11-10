import { AbiCoder, Contract, ethers, JsonRpcProvider } from 'ethers'
import fetch from 'node-fetch'

import { describe, expect, jest, test } from '@jest/globals'

import AmbireAccount from '../../../contracts/compiled/AmbireAccount.json'
import { velcroUrl } from '../../../test/config'
import { monitor, stopMonitoring } from '../../../test/helpers/requests'
import { DEFAULT_ACCOUNT_LABEL } from '../../consts/account'
import { PORTFOLIO_TESTS_V2 } from '../../consts/addresses'
import { EOA_SIMULATION_NONCE } from '../../consts/deployless'
import { networks } from '../../consts/networks'
import { Account, AccountStates } from '../../interfaces/account'
import { Network } from '../../interfaces/network'
import { getRpcProvider } from '../../services/provider'
import { AccountOp } from '../accountOp/accountOp'
import { getAccountState } from '../accountState/accountState'
import { ERC20 } from '../humanizer/const/abis'
import { stringify } from '../richJson/richJson'
import { StrippedExternalHintsAPIResponse } from './interfaces'
import { Portfolio } from './portfolio'

const providers = Object.fromEntries(
  networks.map((network) => [network.chainId, getRpcProvider(network)])
)
const getAccountsInfo = async (accounts: Account[]): Promise<AccountStates> => {
  const result = await Promise.all(
    networks.map((network) =>
      getAccountState(providers[network.chainId.toString()], network, accounts)
    )
  )
  const states = accounts.map((acc: Account, accIndex: number) => {
    return [
      acc.addr,
      Object.fromEntries(
        networks.map((network: Network, netIndex: number) => {
          return [network.chainId.toString(), result[netIndex][accIndex]]
        })
      )
    ]
  })
  return Object.fromEntries(states)
}

describe('Portfolio', () => {
  const USDT_ADDRESS = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
  const ethereum = networks.find((n) => n.chainId === 1n)
  const arbitrum = networks.find((n) => n.chainId === 42161n)

  if (!ethereum) throw new Error('unable to find ethereum network in consts')
  if (!arbitrum) throw new Error('unable to find arbitrum network in consts')

  const provider = getRpcProvider({
    rpcUrls: ['https://invictus.ambire.com/ethereum'],
    chainId: 1n
  })
  const providerArbitrum = getRpcProvider({
    rpcUrls: ['https://invictus.ambire.com/arbitrum'],
    chainId: 42161n
  })

  const portfolio = new Portfolio(fetch, provider, ethereum, velcroUrl)
  const portfolioArbitrum = new Portfolio(fetch, providerArbitrum, arbitrum, velcroUrl)

  async function getNonce(address: string) {
    const accountContract = new Contract(address, AmbireAccount.abi, provider)
    try {
      const res = await accountContract.nonce()
      return res
    } catch (e) {
      return '0x00'
    }
  }
  async function getSafeSendUSDTTransaction(from: string, to: string, amount: bigint) {
    const usdtContract = new Contract(USDT_ADDRESS, ERC20, provider)
    const usdtBalance = await usdtContract.balanceOf(from)
    expect(usdtBalance).toBeGreaterThan(amount)
    return {
      to: USDT_ADDRESS,
      value: 0n,
      data: usdtContract.interface.encodeFunctionData('transfer', [to, amount])
    }
  }

  test('batching works', async () => {
    const interceptedRequests = monitor()

    // 💡 Important Note: BATCH_LIMIT is set to 40 in portfolio/gecko.ts.
    // To simplify testing, we've chosen addresses that contain no more than 40 tokens.
    // This allows us to predict the number of requests in advance.
    // If more advanced testing is required, we'll need to count the number of hints and calculate the expected
    // number of paginated requests accordingly.
    const [result1, result2] = await Promise.all([
      portfolio.get('0x77777777789A8BBEE6C64381e5E89E501fb0e4c8'),
      portfolio.get('0xe750Fff1AA867DFb52c9f98596a0faB5e05d30A6')
    ])

    const tokens =
      (result1.hintsFromExternalAPI?.erc20s.filter((addr) => Number(addr) !== 0).length || 0) +
      (result2.hintsFromExternalAPI?.erc20s.filter((addr) => Number(addr) !== 0).length || 0)

    stopMonitoring()

    const multiHintsReqs = interceptedRequests.filter(
      (req) =>
        req?.url.hostname === 'relayer.ambire.com' && req?.url.pathname === '/velcro-v3/multi-hints'
    )
    const nativePriceReqs = interceptedRequests.filter(
      (req) =>
        req?.url.hostname === 'cena.ambire.com' && req?.url.pathname === '/api/v3/simple/price'
    )
    const tokenPriceReqs = interceptedRequests.filter(
      (req) =>
        req?.url.hostname === 'cena.ambire.com' &&
        req?.url.pathname === '/api/v3/simple/token_price/ethereum'
    )
    const rpcReqs = interceptedRequests.filter(
      (req) => req?.url === 'https://invictus.ambire.com/ethereum'
    )

    expect(multiHintsReqs.length).toEqual(1)
    expect(nativePriceReqs.length).toEqual(1)
    // Expect tokenPriceReqs to be paginated. 40 is the max tokens per request.
    expect(tokenPriceReqs.length).toEqual(Math.ceil(tokens / 40))
    expect(rpcReqs.length).toEqual(1)
  })

  test('token simulation', async () => {
    const accountOp: any = {
      accountAddr: PORTFOLIO_TESTS_V2.addr,
      signingKeyAddr: PORTFOLIO_TESTS_V2.key,
      gasLimit: null,
      gasFeePayment: null,
      chainId: 1n,
      nonce: await getNonce(PORTFOLIO_TESTS_V2.addr),
      // fake sig, doesn't matter
      signature: '0x000000000000000000000000e5a4Dad2Ea987215460379Ab285DF87136E83BEA03',
      calls: [
        await getSafeSendUSDTTransaction(
          PORTFOLIO_TESTS_V2.addr,
          // random addr, doesn't matter
          '0xe5a4dad2ea987215460379ab285df87136e83bea',
          1000000n
        )
      ]
    }
    const account = {
      addr: PORTFOLIO_TESTS_V2.addr,
      initialPrivileges: [],
      associatedKeys: [PORTFOLIO_TESTS_V2.key],
      creation: {
        factoryAddr: PORTFOLIO_TESTS_V2.factory,
        bytecode: PORTFOLIO_TESTS_V2.bytecode,
        salt: PORTFOLIO_TESTS_V2.salt
      },
      preferences: {
        label: DEFAULT_ACCOUNT_LABEL,
        pfp: PORTFOLIO_TESTS_V2.addr
      }
    } as Account
    const accountStates = await getAccountsInfo([account])
    const postSimulation = await portfolio.get(PORTFOLIO_TESTS_V2.addr, {
      simulation: {
        accountOps: [accountOp],
        account,
        state: accountStates[accountOp.accountAddr]['1']
      }
    })
    const entry = postSimulation.tokens.find((x) => x.symbol === 'USDT')

    if (!entry || entry.amountPostSimulation === undefined) {
      throw new Error('Token not found or `amountPostSimulation` is not calculated')
    }

    // If there is a diff, it means the above txn simulation is successful
    // and the diff amount would be deduced from entry.amount when the txn is executed
    expect(entry.amount - entry.amountPostSimulation).toBeGreaterThan(0)
  })

  test('nft simulation', async () => {
    const ABI = ['function transferFrom(address from, address to, uint256 tokenId)']
    const iface = new ethers.Interface(ABI)
    const data = iface.encodeFunctionData('transferFrom', [
      '0xf2d83373bE7dE6dEB14745F6512Df1306b6175EA',
      '0x77777777789A8BBEE6C64381e5E89E501fb0e4c8',
      66185
    ])

    const SPOOF_SIGTYPE = '03'
    const spoofSig =
      new AbiCoder().encode(['address'], ['0xF5102a9bd0Ca021D3cF262BeF81c25F704AF1615']) +
      SPOOF_SIGTYPE

    const accountOp: AccountOp = {
      accountAddr: '0xf2d83373bE7dE6dEB14745F6512Df1306b6175EA',
      signingKeyAddr: '0xF5102a9bd0Ca021D3cF262BeF81c25F704AF1615',
      signingKeyType: 'internal',
      gasLimit: null,
      gasFeePayment: null,
      chainId: 42161n,
      nonce: await getNonce('0xf2d83373bE7dE6dEB14745F6512Df1306b6175EA'),
      signature: spoofSig,
      accountOpToExecuteBefore: null,
      calls: [{ to: '0xA245fe89Af4573Bc53f4BeA5Ae4c38db431d9123', value: BigInt(0), data }]
    }
    const account = {
      addr: '0xf2d83373bE7dE6dEB14745F6512Df1306b6175EA',
      initialPrivileges: [],
      associatedKeys: ['0xF5102a9bd0Ca021D3cF262BeF81c25F704AF1615'],
      creation: {
        bytecode:
          '0x7f00000000000000000000000000000000000000000000000000000000000000027f04f3c84c7bf7b333aca32e4d61247cc315ac4a0e396a5fc174276184ae537f84553d602d80604d3d3981f3363d3d373d3d3d363d730f2aa7bcda3d9d210df69a394b6965cb2566c8285af43d82803e903d91602b57fd5bf3',
        factoryAddr: '0x26cE6745A633030A6faC5e64e41D21fb6246dc2d',
        salt: '0x0000000000000000000000000000000000000000000000000000000000000000'
      },
      preferences: {
        label: 'Smart Account v2',
        pfp: '0xf2d83373bE7dE6dEB14745F6512Df1306b6175EA'
      }
    }

    const accountStates = await getAccountsInfo([account])
    const postSimulation = await portfolioArbitrum.get(
      '0xf2d83373bE7dE6dEB14745F6512Df1306b6175EA',
      {
        simulation: {
          accountOps: [accountOp],
          account,
          state: accountStates[accountOp.accountAddr][accountOp.chainId.toString()]
        }
      }
    )

    const collection = postSimulation.collections.find((c) => c.symbol === 'SIZECREATURE')

    if (!collection || collection.amountPostSimulation === undefined) {
      throw new Error('Collection not found or `amountPostSimulation` is not calculated')
    }
    expect(collection.postSimulation?.sending?.[0]).toBe(66185n)
    expect(collection.amount - collection.amountPostSimulation).toBe(1n)
  })

  test('price cache works', async () => {
    const { priceCache } = await portfolio.get('0x77777777789A8BBEE6C64381e5E89E501fb0e4c8')
    const resultTwo = await portfolio.get('0x77777777789A8BBEE6C64381e5E89E501fb0e4c8', {
      priceCache,
      priceRecency: 60000
    })
    expect(resultTwo.priceUpdateTime).toBeLessThanOrEqual(3)
    expect(resultTwo.tokens.every((x) => x.priceIn.length)).toBe(true)
  })

  test('simulation works for EOAs', async () => {
    const acc = '0xD8293ad21678c6F09Da139b4B62D38e514a03B78'
    const accountOp: any = {
      accountAddr: acc,
      signingKeyAddr: acc,
      gasLimit: null,
      gasFeePayment: null,
      chainId: 1n,
      nonce: await getNonce('0xD8293ad21678c6F09Da139b4B62D38e514a03B78'),
      signature: '0x',
      calls: [
        await getSafeSendUSDTTransaction(acc, '0xe5a4dad2ea987215460379ab285df87136e83bea', 209434n)
      ]
    }
    const account: Account = {
      addr: acc,
      associatedKeys: [acc],
      creation: null,
      initialPrivileges: [],
      preferences: {
        label: DEFAULT_ACCOUNT_LABEL,
        pfp: acc
      }
    }
    const accountStates = await getAccountsInfo([account])
    const postSimulation = await portfolio.get(acc, {
      simulation: {
        accountOps: [accountOp],
        account,
        state: accountStates[accountOp.accountAddr][accountOp.chainId.toString()]
      }
    })
    const entry = postSimulation.tokens.find((x) => x.symbol === 'USDT')
    if (!entry || entry.amountPostSimulation === undefined) {
      throw new Error('Entry not found or `amountPostSimulation` is not calculated')
    }
    expect(entry.amount - entry.amountPostSimulation).toBe(209434n)
  })

  test('simulation works for smart accounts imported as EOAs', async () => {
    const acc = '0xba4d70875B99CAaBb90e558e46d3ea7164D80E4E'
    const accountOp: any = {
      accountAddr: acc,
      signingKeyAddr: acc,
      gasLimit: null,
      gasFeePayment: null,
      chainId: 1n,
      nonce: BigInt(EOA_SIMULATION_NONCE),
      signature: '0x',
      calls: [
        {
          to: '0x26d6a373397d553595cd6a7bbabd86debd60a1cc',
          value: 10000000000000000n,
          data: '0x'
        }
      ]
    }
    const account: Account = {
      addr: acc,
      associatedKeys: [acc],
      creation: null,
      initialPrivileges: [],
      preferences: {
        label: DEFAULT_ACCOUNT_LABEL,
        pfp: acc
      }
    }
    const accountStates = await getAccountsInfo([account])
    const postSimulation = await portfolio.get(acc, {
      simulation: {
        accountOps: [accountOp],
        account,
        state: accountStates[accountOp.accountAddr][accountOp.chainId.toString()]
      }
    })
    const entry = postSimulation.tokens.find((x) => x.symbol === 'ETH')
    if (!entry || entry.amountPostSimulation === undefined) {
      throw new Error('Entry not found or `amountPostSimulation` is not calculated')
    }
    expect(entry.amount - entry.amountPostSimulation).toBe(10000000000000000n)
  })

  test('token simulation should throw a simulation error if the account op nonce is lower or higher than the original contract nonce', async () => {
    const acc = '0xD8293ad21678c6F09Da139b4B62D38e514a03B78'
    const accountOp: any = {
      accountAddr: '0x77777777789A8BBEE6C64381e5E89E501fb0e4c8',
      signingKeyAddr: '0xe5a4Dad2Ea987215460379Ab285DF87136E83BEA',
      gasLimit: null,
      gasFeePayment: null,
      chainId: 1n,
      nonce: 0n,
      signature: '0x',
      calls: [
        await getSafeSendUSDTTransaction(acc, '0xe5a4dad2ea987215460379ab285df87136e83bea', 209434n)
      ]
    }
    const account = {
      addr: '0x77777777789A8BBEE6C64381e5E89E501fb0e4c8',
      initialPrivileges: [],
      associatedKeys: ['0xe5a4Dad2Ea987215460379Ab285DF87136E83BEA'],
      creation: {
        factoryAddr: '0xBf07a0Df119Ca234634588fbDb5625594E2a5BCA',
        bytecode:
          '0x7f00000000000000000000000000000000000000000000000000000000000000017f02c94ba85f2ea274a3869293a0a9bf447d073c83c617963b0be7c862ec2ee44e553d602d80604d3d3981f3363d3d373d3d3d363d732a2b85eb1054d6f0c6c2e37da05ed3e5fea684ef5af43d82803e903d91602b57fd5bf3',
        salt: '0x2ee01d932ede47b0b2fb1b6af48868de9f86bfc9a5be2f0b42c0111cf261d04c'
      },
      preferences: {
        label: DEFAULT_ACCOUNT_LABEL,
        pfp: '0x77777777789A8BBEE6C64381e5E89E501fb0e4c8'
      }
    }
    const accountStates = await getAccountsInfo([account])
    try {
      await portfolio.get('0x77777777789A8BBEE6C64381e5E89E501fb0e4c8', {
        simulation: {
          accountOps: [accountOp],
          account,
          state: accountStates[accountOp.accountAddr][accountOp.chainId.toString()]
        }
      })
      // should throw an error and never come here
      expect(true).toBe(false)
    } catch (e: any) {
      expect(e.message).toBe(
        'simulation error: Account op passed for simulation but the nonce did not increment. Perhaps wrong nonce set in Account op'
      )
    }

    accountOp.nonce = 99999999999999999999999999999999999999999n
    try {
      await portfolio.get('0x77777777789A8BBEE6C64381e5E89E501fb0e4c8', {
        simulation: {
          accountOps: [accountOp],
          account,
          state: accountStates[accountOp.accountAddr][accountOp.chainId.toString()]
        }
      })
      // should throw an error and never come here
      expect(true).toBe(false)
    } catch (e: any) {
      expect(e.message).toBe(
        'simulation error: Account op passed for simulation but the nonce did not increment. Perhaps wrong nonce set in Account op'
      )
    }
  })

  test('simulation should revert with SV_NO_KEYS for an account we do not posses the associated key for', async () => {
    const acc = '0x7a15866aFfD2149189Aa52EB8B40a8F9166441D9'
    const accountOp: any = {
      accountAddr: acc,
      signingKeyAddr: acc,
      gasLimit: null,
      gasFeePayment: null,
      chainId: 1n,
      nonce: BigInt(EOA_SIMULATION_NONCE),
      signature: '0x',
      calls: [
        {
          to: USDT_ADDRESS,
          value: BigInt(0),
          data: '0xa9059cbb000000000000000000000000e5a4dad2ea987215460379ab285df87136e83bea00000000000000000000000000000000000000000000000000000000005040aa'
        }
      ]
    }
    const account: Account = {
      addr: acc,
      associatedKeys: [],
      creation: null,
      initialPrivileges: [],
      preferences: {
        label: DEFAULT_ACCOUNT_LABEL,
        pfp: acc
      }
    }

    try {
      const accountStates = await getAccountsInfo([account])
      await portfolio.get(acc, {
        simulation: {
          accountOps: [accountOp],
          account,
          state: accountStates[accountOp.accountAddr][accountOp.chainId.toString()]
        }
      })
    } catch (e: any) {
      expect(e.message).toBe('simulation error: Spoof failed: no keys')
    }
  })

  test('simulation should revert with SV_WRONG_KEYS for an account that we pass a wrong associated key', async () => {
    const acc = '0xD8293ad21678c6F09Da139b4B62D38e514a03B78'
    const accountOp: any = {
      accountAddr: acc,
      signingKeyAddr: acc,
      gasLimit: null,
      gasFeePayment: null,
      chainId: 1n,
      nonce: await getNonce(acc),
      signature: '0x',
      calls: [
        await getSafeSendUSDTTransaction(acc, '0xe5a4dad2ea987215460379ab285df87136e83bea', 209434n)
      ]
    }
    const account: Account = {
      addr: acc,
      associatedKeys: ['0xdAC17F958D2ee523a2206206994597C13D831ec7'],
      creation: null,
      initialPrivileges: [],
      preferences: {
        label: DEFAULT_ACCOUNT_LABEL,
        pfp: acc
      }
    }

    try {
      const accountStates = await getAccountsInfo([account])
      await portfolio.get(acc, {
        simulation: {
          accountOps: [accountOp],
          account,
          state: accountStates[accountOp.accountAddr][accountOp.chainId.toString()]
        }
      })
    } catch (e: any) {
      expect(e.message).toBe('simulation error: Spoof failed: wrong keys')
    }
  })

  test('token simulation works with multiple calls in an account op', async () => {
    const accountOp: any = {
      accountAddr: PORTFOLIO_TESTS_V2.addr,
      signingKeyAddr: PORTFOLIO_TESTS_V2.key,
      gasLimit: null,
      gasFeePayment: null,
      chainId: 1n,
      nonce: await getNonce(PORTFOLIO_TESTS_V2.addr),
      signature: '0x000000000000000000000000e5a4Dad2Ea987215460379Ab285DF87136E83BEA03',
      calls: [
        await getSafeSendUSDTTransaction(PORTFOLIO_TESTS_V2.addr, PORTFOLIO_TESTS_V2.key, 1000000n),
        await getSafeSendUSDTTransaction(
          PORTFOLIO_TESTS_V2.addr,
          '0x0000000000000000000000000000000000000000',
          500000n
        )
      ]
    }
    const account = {
      addr: PORTFOLIO_TESTS_V2.addr,
      initialPrivileges: [],
      associatedKeys: [PORTFOLIO_TESTS_V2.key],
      creation: {
        factoryAddr: PORTFOLIO_TESTS_V2.factory,
        bytecode: PORTFOLIO_TESTS_V2.bytecode,
        salt: PORTFOLIO_TESTS_V2.salt
      },
      preferences: {
        label: DEFAULT_ACCOUNT_LABEL,
        pfp: PORTFOLIO_TESTS_V2.addr
      }
    }

    const accountStates = await getAccountsInfo([account])
    const postSimulation = await portfolio.get(PORTFOLIO_TESTS_V2.addr, {
      simulation: {
        accountOps: [accountOp],
        account,
        state: accountStates[accountOp.accountAddr][accountOp.chainId.toString()]
      }
    })
    const entry = postSimulation.tokens.find((x) => x.symbol === 'USDT')

    if (!entry || entry.amountPostSimulation === undefined) {
      throw new Error('Token not found or `amountPostSimulation` is not calculated')
    }

    // If there is a diff, it means the above txn simulation is successful
    // and the diff amount would be deduced from entry.amount when the txn is executed
    expect(entry.amount - entry.amountPostSimulation).toBeGreaterThan(0)
  })

  test('token simulation fails if there are two account ops but the last one has a higher nonce than expected', async () => {
    const accountOp: any = {
      accountAddr: PORTFOLIO_TESTS_V2.addr,
      signingKeyAddr: PORTFOLIO_TESTS_V2.key,
      gasLimit: null,
      gasFeePayment: null,
      chainId: 1n,
      nonce: await getNonce(PORTFOLIO_TESTS_V2.addr),
      signature: '0x000000000000000000000000e5a4Dad2Ea987215460379Ab285DF87136E83BEA03',
      calls: [
        await getSafeSendUSDTTransaction(PORTFOLIO_TESTS_V2.addr, PORTFOLIO_TESTS_V2.key, 1000000n)
      ]
    }
    const account = {
      addr: PORTFOLIO_TESTS_V2.addr,
      initialPrivileges: [],
      associatedKeys: [PORTFOLIO_TESTS_V2.key],
      creation: {
        factoryAddr: PORTFOLIO_TESTS_V2.factory,
        bytecode: PORTFOLIO_TESTS_V2.bytecode,
        salt: PORTFOLIO_TESTS_V2.salt
      },
      preferences: {
        label: DEFAULT_ACCOUNT_LABEL,
        pfp: PORTFOLIO_TESTS_V2.addr
      }
    }
    const secondAccountOp = { ...accountOp }
    secondAccountOp.nonce = accountOp.nonce + 2n // wrong, should be +1n
    try {
      const accountStates = await getAccountsInfo([account])
      await portfolio.get(PORTFOLIO_TESTS_V2.addr, {
        simulation: {
          accountOps: [accountOp, secondAccountOp],
          account,
          state: accountStates[accountOp.accountAddr][accountOp.chainId.toString()]
        }
      })
      // portfolio.get should revert and not come here
      expect(true).toBe(false)
    } catch (e: any) {
      expect(e.message).toBe(
        'simulation error: Failed to increment the nonce to the final account op nonce'
      )
    }
  })
  test('errors caused by a malfunctioning RPC are not swallowed', async () => {
    const originalLog = console.log
    // Ignore Failed to start rpc error
    console.log = jest.fn()

    const failingProvider = new JsonRpcProvider('https://invictus.ambire.com/ethereum-fail')

    const failingPortfolio = new Portfolio(fetch, failingProvider, ethereum, velcroUrl)

    let didThrow = false

    try {
      await failingPortfolio.get('0x77777777789A8BBEE6C64381e5E89E501fb0e4c8')
    } catch (e: any) {
      didThrow = true
      expect(e?.message).toContain('server response 404')
    }

    expect(didThrow).toBe(true)
    console.log = originalLog
    // Destroy the failing provider
    failingProvider.destroy()
  })

  describe('Hints', () => {
    describe('With blocked Velcro discovery', () => {
      // Done in beforeEach instead of a reusable function because
      // mocks can't be reused as functions
      beforeEach(() => {
        // Simulate a Velcro Discovery failure
        jest.mock('node-fetch', () => {
          return jest.fn((url: any) => {
            // @ts-ignore
            const { Response } = jest.requireActual('node-fetch')
            if (url.includes(`${velcroUrl}/multi-hints`)) {
              const body = stringify({ message: 'API error' })
              const headers = { status: 200 }

              return Promise.resolve(new Response(body, headers))
            }

            // @ts-ignore
            return jest.requireActual('node-fetch')(url)
          })
        })
      })
      afterEach(() => {
        // Restore the original implementations
        jest.restoreAllMocks()
      })

      test('portfolio works with previously cached hints, even if Velcro Discovery request fails', async () => {
        const portfolioInner = new Portfolio(fetch, provider, ethereum, velcroUrl)
        const previousHints = {
          erc20s: [
            '0x0000000000000000000000000000000000000000',
            '0x4da27a545c0c5B758a6BA100e3a049001de870f5',
            '0xba100000625a3754423978a60c9317c58a424e3D'
          ],
          erc721s: {},
          lastUpdate: Date.now()
        }
        const result = await portfolioInner.get('0x77777777789A8BBEE6C64381e5E89E501fb0e4c8', {
          previousHintsFromExternalAPI: previousHints
        })

        expect(
          result.tokens
            .map((token) => token.address)
            .filter((token) => previousHints.erc20s.includes(token))
        ).toEqual(previousHints.erc20s)
      })
      test('Erc 721 external api hints should be prioritized over additional hints', async () => {
        const hintsFromExternalAPI: StrippedExternalHintsAPIResponse = {
          erc20s: [],
          lastUpdate: Date.now(),
          erc721s: {
            '0x026224A2940bFE258D0dbE947919B62fE321F042': {
              isKnown: false,
              tokens: ['2647']
            }
          }
        }
        const additionalErc721Hints = {
          '0x026224A2940bFE258D0dbE947919B62fE321F042': {
            isKnown: false,
            tokens: ['2648'] // Different token id on purpose
          }
        }

        const portfolioInner = new Portfolio(fetch, provider, ethereum, velcroUrl)

        const result = await portfolioInner.get('0x77777777789A8BBEE6C64381e5E89E501fb0e4c8', {
          previousHintsFromExternalAPI: hintsFromExternalAPI,
          additionalErc721Hints
        })

        // The correct tokenId was found
        expect(
          result.collections.find((c) => c.address === '0x026224A2940bFE258D0dbE947919B62fE321F042')
            ?.collectibles.length
        ).toBe(1)
      })
    })
    test('Hints are deduped', async () => {
      const additionalErc20Hints = [USDT_ADDRESS, USDT_ADDRESS.toLowerCase()]
      const portfolioInner = new Portfolio(fetch, provider, ethereum, velcroUrl)

      const result = await portfolioInner.get('0x77777777789A8BBEE6C64381e5E89E501fb0e4c8', {
        additionalErc20Hints
      })

      const usdtFoundTimes = result.tokens
        .map((token) => token.address)
        .filter((address) => address.toLowerCase() === USDT_ADDRESS.toLowerCase()).length

      expect(usdtFoundTimes).toBeLessThan(2)
    })
    test("Bad hints don't break the portfolio", async () => {
      const additionalErc20Hints = [
        `${USDT_ADDRESS.slice(-1)}4` // Bad hint
      ]
      const portfolioInner = new Portfolio(fetch, provider, ethereum, velcroUrl)

      const result = await portfolioInner.get('0x77777777789A8BBEE6C64381e5E89E501fb0e4c8', {
        additionalErc20Hints
      })

      expect(result.tokens.length).toBeGreaterThan(0)
    })
  })
})

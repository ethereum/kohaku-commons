/* eslint no-console: "off" */

import { AbiCoder, Contract, Interface, parseEther, ZeroAddress } from 'ethers'
import fetch from 'node-fetch'

import { describe, expect } from '@jest/globals'

import AmbireAccount from '../../../contracts/compiled/AmbireAccount.json'
import ERC20 from '../../../contracts/compiled/IERC20.json'
import { relayerUrl, velcroUrl } from '../../../test/config'
import { getNativeToCheckFromEOAs } from '../../../test/helpers'
import { DEFAULT_ACCOUNT_LABEL } from '../../consts/account'
import { FEE_COLLECTOR } from '../../consts/addresses'
import { AMBIRE_ACCOUNT_FACTORY } from '../../consts/deploy'
import { networks } from '../../consts/networks'
import { Account, AccountStates } from '../../interfaces/account'
import { dedicatedToOneSAPriv } from '../../interfaces/keystore'
import { Network } from '../../interfaces/network'
import { BundlerSwitcher } from '../../services/bundlers/bundlerSwitcher'
import { paymasterFactory } from '../../services/paymaster'
import { getRpcProvider } from '../../services/provider'
import { getSmartAccount } from '../account/account'
import { getBaseAccount } from '../account/getBaseAccount'
import { Call } from '../accountOp/types'
import { getAccountState } from '../accountState/accountState'
import { Portfolio } from '../portfolio/portfolio'
import { getEstimation } from './estimate'
import {
  AmbireEstimation,
  Erc4337GasLimits,
  FullEstimation,
  ProviderEstimation
} from './interfaces'

const ethereum = networks.find((x) => x.chainId === 1n)!
ethereum.areContractsDeployed = true
const optimism = networks.find((x) => x.chainId === 10n)
const arbitrum = networks.find((x) => x.chainId === 42161n)!
arbitrum.areContractsDeployed = true
const avalanche = networks.find((x) => x.chainId === 43114n)!
avalanche.areContractsDeployed = true
const polygon = networks.find((x) => x.chainId === 137n)
if (!ethereum || !optimism || !arbitrum || !avalanche || !polygon) throw new Error('no network')
const provider = getRpcProvider(ethereum.rpcUrls, ethereum.chainId)
const providerOptimism = getRpcProvider(optimism.rpcUrls, optimism.chainId)
const providerArbitrum = getRpcProvider(arbitrum.rpcUrls, arbitrum.chainId)
// const providerAvalanche = getRpcProvider(avalanche.rpcUrls, avalanche.chainId)
const providerPolygon = getRpcProvider(polygon.rpcUrls, polygon.chainId)
const addrWithDeploySignature = '0x52C37FD54BD02E9240e8558e28b11e0Dc22d8e85'
const errorCallback = () => {}

const smartAccDeployed: Account = {
  addr: '0x8E5F6c1F0b134657A546932C3eC9169E1633a39b',
  initialPrivileges: [
    [
      '0xBd84Cc40a5b5197B5B61919c22A55e1c46d2A3bb',
      '0x0000000000000000000000000000000000000000000000000000000000000002'
    ]
  ],
  creation: {
    factoryAddr: AMBIRE_ACCOUNT_FACTORY,
    bytecode:
      '0x7f00000000000000000000000000000000000000000000000000000000000000027ff33cc417366b7e38d2706a67ab46f85465661c28b864b521441180d15df82251553d602d80604d3d3981f3363d3d373d3d3d363d731cde6a53e9a411eaaf9d11e3e8c653a3e379d5355af43d82803e903d91602b57fd5bf3',
    salt: '0x0000000000000000000000000000000000000000000000000000000000000000'
  },
  associatedKeys: ['0xBd84Cc40a5b5197B5B61919c22A55e1c46d2A3bb'],
  preferences: {
    label: DEFAULT_ACCOUNT_LABEL,
    pfp: '0x8E5F6c1F0b134657A546932C3eC9169E1633a39b'
  }
}

const v1Acc: Account = {
  addr: '0xa07D75aacEFd11b425AF7181958F0F85c312f143',
  associatedKeys: ['0xd6e371526cdaeE04cd8AF225D42e37Bc14688D9E'],
  initialPrivileges: [
    [
      '0xd6e371526cdaeE04cd8AF225D42e37Bc14688D9E',
      '0x0000000000000000000000000000000000000000000000000000000000000001'
    ]
  ],
  creation: {
    factoryAddr: '0xBf07a0Df119Ca234634588fbDb5625594E2a5BCA',
    bytecode:
      '0x7f28d4ea8f825adb036e9b306b2269570e63d2aa5bd10751437d98ed83551ba1cd7fa57498058891e98f45f8abb85dafbcd30f3d8b3ab586dfae2e0228bbb1de7018553d602d80604d3d3981f3363d3d373d3d3d363d732a2b85eb1054d6f0c6c2e37da05ed3e5fea684ef5af43d82803e903d91602b57fd5bf3',
    salt: '0x0000000000000000000000000000000000000000000000000000000000000001'
  },
  preferences: {
    label: DEFAULT_ACCOUNT_LABEL,
    pfp: '0xa07D75aacEFd11b425AF7181958F0F85c312f143'
  }
}
const to = '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45'

const yesterdayHex = Math.floor((Date.now() - 86400000) / 1000).toString(16)
// 64 chars expire hex
// we set swap deadline always for tomorrow, in order to prevent the test failure with 'TRANSACTION TOO OLD'

const expired = '0'.repeat(64 - yesterdayHex.length) + yesterdayHex
const expiredData = `0x5ae401dc${expired}00000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000e404e45aaf000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec700000000000000000000000000000000000000000000000000000000000001f4000000000000000000000000a07d75aacefd11b425af7181958f0f85c312f14300000000000000000000000000000000000000000000000000000000000f424000000000000000000000000000000000000000000000000000000000000c33d9000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000`

const SPOOF_SIGTYPE = '03'
const spoofSig =
  new AbiCoder().encode(['address'], ['0xd6e371526cdaeE04cd8AF225D42e37Bc14688D9E']) + SPOOF_SIGTYPE

// View only, because its key isn't in MOCK_KEYSTORE_KEYS
const viewOnlyAcc = {
  addr: '0x77777777789A8BBEE6C64381e5E89E501fb0e4c8',
  creation: null,
  initialPrivileges: [],
  associatedKeys: ['0x77777777789A8BBEE6C64381e5E89E501fb0e4c8'],
  preferences: {
    label: DEFAULT_ACCOUNT_LABEL,
    pfp: '0x77777777789A8BBEE6C64381e5E89E501fb0e4c8'
  }
} as Account
const nativeToCheck: Account[] = [
  {
    addr: '0x0000000000000000000000000000000000000001',
    initialPrivileges: [],
    associatedKeys: ['0x0000000000000000000000000000000000000001'],
    creation: null,
    preferences: {
      label: DEFAULT_ACCOUNT_LABEL,
      pfp: '0x0000000000000000000000000000000000000001'
    }
  },
  {
    addr: FEE_COLLECTOR,
    initialPrivileges: [],
    associatedKeys: ['0x0000000000000000000000000000000000000001'],
    creation: null,
    preferences: {
      label: DEFAULT_ACCOUNT_LABEL,
      pfp: FEE_COLLECTOR
    }
  },
  viewOnlyAcc
]

const feeTokens = [
  {
    address: '0x0000000000000000000000000000000000000000',
    amount: 1n,
    symbol: 'ETH',
    name: 'Ethereum',
    chainId: 1n,
    decimals: 18,
    priceIn: [],
    flags: {
      onGasTank: false,
      rewardsType: null,
      canTopUpGasTank: true,
      isFeeToken: true
    }
  },
  {
    address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    amount: 1n,
    symbol: 'USDT',
    name: 'Tether',
    chainId: 1n,
    decimals: 6,
    priceIn: [],
    flags: {
      onGasTank: false,
      rewardsType: null,
      canTopUpGasTank: true,
      isFeeToken: true
    }
  },
  {
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    amount: 1n,
    symbol: 'USDC',
    name: 'USD Coin',
    chainId: 1n,
    decimals: 6,
    priceIn: [],
    flags: {
      onGasTank: false,
      rewardsType: null,
      canTopUpGasTank: true,
      isFeeToken: true
    }
  }
]

// const feeTokensAvalanche = [
//   {
//     address: '0x0000000000000000000000000000000000000000',
//     amount: 1n,
//     symbol: 'AVAX',
//     chainId: 43114n,
//     decimals: 18,
//     priceIn: [],
//     flags: {
//       onGasTank: false,
//       rewardsType: null,
//       canTopUpGasTank: true,
//       isFeeToken: true
//     }
//   },
//   {
//     address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
//     amount: 1n,
//     symbol: 'USDC',
//     chainId: 43114n,
//     decimals: 6,
//     priceIn: [],
//     flags: {
//       onGasTank: false,
//       rewardsType: null,
//       canTopUpGasTank: true,
//       isFeeToken: true
//     }
//   }
// ]

const portfolio = new Portfolio(fetch, provider, ethereum, velcroUrl)

const providers = Object.fromEntries(
  networks.map((network) => [network.chainId, getRpcProvider(network.rpcUrls, network.chainId)])
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
          return [network.chainId, result[netIndex][accIndex]]
        })
      )
    ]
  })
  return Object.fromEntries(states)
}

const deprycatedV2: Account = {
  addr: '0x4AA524DDa82630cE769e5C9d7ec7a45B94a41bc6',
  associatedKeys: ['0x141A14B5C4dbA2aC7a7943E02eDFE2E7eDfdA28F'],
  creation: {
    factoryAddr: '0xa8202f888b9b2dfa5ceb2204865018133f6f179a',
    bytecode:
      '0x7f00000000000000000000000000000000000000000000000000000000000000027fa70e7c3e588683d0493e3cad10209993d632b6631bc4637b53a4174bad869718553d602d80604d3d3981f3363d3d373d3d3d363d730e370942ebe4d026d05d2cf477ff386338fc415a5af43d82803e903d91602b57fd5bf3',
    salt: '0x0000000000000000000000000000000000000000000000000000000000000000'
  },
  initialPrivileges: [],
  preferences: {
    label: DEFAULT_ACCOUNT_LABEL,
    pfp: '0x4AA524DDa82630cE769e5C9d7ec7a45B94a41bc6'
  }
}

const trezorSlot6v2NotDeployed: Account = {
  addr: '0x29e54b17CAe69edaf2D7138053c23436aac1B379',
  associatedKeys: ['0x71c3D24a627f0416db45107353d8d0A5ae0401ae'],
  creation: {
    factoryAddr: '0xa8202f888b9b2dfa5ceb2204865018133f6f179a',
    bytecode:
      '0x7f00000000000000000000000000000000000000000000000000000000000000027f3369d2838e4eeae4638428c523923f47cfb9039c70a8c40d546493e82c7ba866553d602d80604d3d3981f3363d3d373d3d3d363d730e370942ebe4d026d05d2cf477ff386338fc415a5af43d82803e903d91602b57fd5bf3',
    salt: '0x0000000000000000000000000000000000000000000000000000000000000000'
  },
  initialPrivileges: [],
  preferences: {
    label: DEFAULT_ACCOUNT_LABEL,
    pfp: '0x29e54b17CAe69edaf2D7138053c23436aac1B379'
  }
}

paymasterFactory.init(relayerUrl, fetch, () => {})

const areUpdatesForbidden = () => {
  return false
}

describe('estimate', () => {
  it('[EOA]:Ethereum | gasUsage and native balance for a normal transfer', async () => {
    const EOAAccount: Account = {
      addr: '0x40b38765696e3d5d8d9d834d8aad4bb6e418e489',
      associatedKeys: ['0x40b38765696e3d5d8d9d834d8aad4bb6e418e489'],
      initialPrivileges: [
        [
          '0x40b38765696e3d5d8d9d834d8aad4bb6e418e489',
          '0x0000000000000000000000000000000000000000000000000000000000000001'
        ]
      ],
      creation: null,
      preferences: {
        label: DEFAULT_ACCOUNT_LABEL,
        pfp: '0x40b38765696e3d5d8d9d834d8aad4bb6e418e489'
      }
    }

    const call: Call = {
      to: '0xf7bB3EEF4ffA13ce037E3E5b6a59340c7e0f3941',
      value: BigInt(1),
      data: '0x'
    }

    const op = {
      accountAddr: EOAAccount.addr,
      signingKeyAddr: null,
      signingKeyType: null,
      gasLimit: null,
      gasFeePayment: null,
      chainId: 1n,
      nonce: null,
      signature: null,
      calls: [call],
      accountOpToExecuteBefore: null
    }

    const accountStates = await getAccountsInfo([EOAAccount])
    const accountState = accountStates[EOAAccount.addr][ethereum.chainId.toString()]
    const baseAcc = getBaseAccount(EOAAccount, accountState, [], ethereum)
    const response = await getEstimation(
      baseAcc,
      accountState,
      op,
      ethereum,
      provider,
      feeTokens,
      [],
      new BundlerSwitcher(ethereum, areUpdatesForbidden),
      errorCallback
    )
    expect(response instanceof Error).toBe(false)
    const res = response as FullEstimation
    expect(res.provider instanceof Error).toBe(false)
    const providerGas = res.provider as ProviderEstimation
    expect(providerGas.gasUsed).toBe(21000n)

    // there should be native here
    expect(providerGas.feePaymentOptions[0].availableAmount).toBeGreaterThan(0)
    expect(providerGas.feePaymentOptions[0].token).not.toBe(undefined)
    expect(providerGas.feePaymentOptions[0].token).not.toBe(null)
    expect(providerGas.feePaymentOptions[0].token.address).toBe(ZeroAddress)
    expect(providerGas.feePaymentOptions[0].token.symbol).toBe('ETH')
  })

  it('[EOA]:Polygon | sends all his available native and estimation should return a 0 balance available for fee but still a 21K gasUsed as we are doing a normal transfer', async () => {
    const addr = '0xa8eEaC54343F94CfEEB3492e07a7De72bDFD118a'
    const EOAAccount: Account = {
      addr,
      associatedKeys: [addr],
      initialPrivileges: [],
      creation: null,
      preferences: {
        label: DEFAULT_ACCOUNT_LABEL,
        pfp: addr
      }
    }

    // send all the native balance the user has in a call
    const nativeBalance = await providerPolygon.getBalance(addr)
    const call = {
      to: '0xf7bB3EEF4ffA13ce037E3E5b6a59340c7e0f3941',
      value: nativeBalance,
      data: '0x'
    }

    const op = {
      accountAddr: EOAAccount.addr,
      signingKeyAddr: null,
      signingKeyType: null,
      gasLimit: null,
      gasFeePayment: null,
      chainId: 137n,
      nonce: null,
      signature: null,
      calls: [call],
      accountOpToExecuteBefore: null
    }

    const accountStates = await getAccountsInfo([EOAAccount])
    const accountState = accountStates[EOAAccount.addr][polygon.chainId.toString()]
    const baseAcc = getBaseAccount(EOAAccount, accountState, [], polygon)
    const response = await getEstimation(
      baseAcc,
      accountState,
      op,
      polygon,
      providerPolygon,
      feeTokens,
      [],
      new BundlerSwitcher(polygon, areUpdatesForbidden),
      errorCallback
    )

    expect(response instanceof Error).toBe(false)
    const res = response as FullEstimation
    expect(res.provider instanceof Error).toBe(false)
    const providerGas = res.provider as ProviderEstimation
    expect(providerGas.gasUsed).toBe(21000n)

    // availableAmount for the providerGas is above 0 as it doesn't have
    // the subtraction that the ambire estimation has
    expect(providerGas.feePaymentOptions[0].availableAmount).toBeGreaterThan(0n)
    expect(providerGas.feePaymentOptions[0].token).not.toBe(undefined)
    expect(providerGas.feePaymentOptions[0].token).not.toBe(null)
    expect(providerGas.feePaymentOptions[0].token.address).toBe(ZeroAddress)

    expect(res.ambire instanceof Error).toBe(false)
    const ambireGas = res.ambire as AmbireEstimation
    const nativeOption = ambireGas.feePaymentOptions.find(
      (opt) => opt.token.address === ZeroAddress && !opt.token.flags.onGasTank
    )
    expect(nativeOption).not.toBe(undefined)
    expect(nativeOption).not.toBe(null)
    expect(nativeOption?.availableAmount).toBe(0n)
  })

  it("[EOA]:Polygon | shouldn't return an error if there is a valid txn but with no native to pay the fee as it is handled in signAccountOp", async () => {
    const addr = '0x952064055eFE9dc8b261510869B032068c8699bB'
    const EOAAccount: Account = {
      addr,
      associatedKeys: [addr],
      initialPrivileges: [],
      creation: null,
      preferences: {
        label: DEFAULT_ACCOUNT_LABEL,
        pfp: addr
      }
    }

    // this should be a valid txn
    // sending 0.00001 USDC to 0xf7bB3EEF4ffA13ce037E3E5b6a59340c7e0f3941
    // so addr should posses that amount
    const ERC20Interface = new Interface(ERC20.abi)
    const call = {
      to: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
      value: 0n,
      data: ERC20Interface.encodeFunctionData('transfer', [
        '0xf7bB3EEF4ffA13ce037E3E5b6a59340c7e0f3941',
        1n
      ])
    }

    const op = {
      accountAddr: EOAAccount.addr,
      signingKeyAddr: null,
      signingKeyType: null,
      gasLimit: null,
      gasFeePayment: null,
      chainId: 137n,
      nonce: null,
      signature: null,
      calls: [call],
      accountOpToExecuteBefore: null
    }

    const accountStates = await getAccountsInfo([EOAAccount])
    const accountState = accountStates[EOAAccount.addr][polygon.chainId.toString()]
    const baseAcc = getBaseAccount(EOAAccount, accountState, [], polygon)
    const response = await getEstimation(
      baseAcc,
      accountState,
      op,
      polygon,
      providerPolygon,
      feeTokens,
      [],
      new BundlerSwitcher(polygon, areUpdatesForbidden),
      errorCallback
    )

    expect(response instanceof Error).toBe(false)
    const res = response as FullEstimation
    expect(res.provider instanceof Error).toBe(false)
    const providerGas = res.provider as ProviderEstimation
    expect(providerGas.gasUsed).toBeGreaterThan(21000n)
  })

  it('[EOA]:Polygon | should throw an error if there is an invalid txn', async () => {
    const addr = '0x952064055eFE9dc8b261510869B032068c8699bB'
    const EOAAccount: Account = {
      addr,
      associatedKeys: [addr],
      initialPrivileges: [],
      creation: null,
      preferences: {
        label: DEFAULT_ACCOUNT_LABEL,
        pfp: addr
      }
    }

    // this should be an invalid txn
    const ERC20Interface = new Interface(ERC20.abi)
    const call = {
      to: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
      value: 0n,
      data: ERC20Interface.encodeFunctionData('transfer', [
        '0xf7bB3EEF4ffA13ce037E3E5b6a59340c7e0f3941',
        1000000000n // 10K USDC
      ])
    }

    const op = {
      accountAddr: EOAAccount.addr,
      signingKeyAddr: null,
      signingKeyType: null,
      gasLimit: null,
      gasFeePayment: null,
      chainId: 137n,
      nonce: null,
      signature: null,
      calls: [call],
      accountOpToExecuteBefore: null
    }

    const accountStates = await getAccountsInfo([EOAAccount])
    const accountState = accountStates[EOAAccount.addr][polygon.chainId.toString()]
    const baseAcc = getBaseAccount(EOAAccount, accountState, [], polygon)
    const response = await getEstimation(
      baseAcc,
      accountState,
      op,
      polygon,
      providerPolygon,
      feeTokens,
      [],
      new BundlerSwitcher(polygon, areUpdatesForbidden),
      errorCallback
    )

    expect(response instanceof Error).toBe(true)
    expect(
      (response as Error).message.indexOf(
        'Transaction cannot be sent because the transfer amount exceeds your account balance'
      )
    ).not.toBe(-1)
  })

  it.skip('[v1] estimates gasUsage and native tokens outcome', async () => {
    const eoaAddr = '0x40b38765696e3d5d8d9d834d8aad4bb6e418e489'
    const v1AccAbi = new Contract(v1Acc.addr, AmbireAccount.abi, provider)
    const op = {
      accountAddr: v1Acc.addr,
      signingKeyAddr: null,
      signingKeyType: null,
      gasLimit: null,
      gasFeePayment: null,
      chainId: 1n,
      nonce: await v1AccAbi.nonce(),
      signature: spoofSig,
      calls: [{ to: eoaAddr, value: BigInt(1), data: '0x' }],
      accountOpToExecuteBefore: null
    }

    const portfolioResponse = await portfolio.get('0xa07D75aacEFd11b425AF7181958F0F85c312f143')
    const nativeToken = portfolioResponse.tokens.find(
      (tok) => tok.address === ZeroAddress && tok.chainId === ethereum.chainId
    )

    const accountStates = await getAccountsInfo([v1Acc])
    const accountState = accountStates[v1Acc.addr][ethereum.chainId.toString()]
    const baseAcc = getBaseAccount(v1Acc, accountState, [], ethereum)
    const response = await getEstimation(
      baseAcc,
      accountState,
      op,
      ethereum,
      provider,
      feeTokens,
      getNativeToCheckFromEOAs(nativeToCheck, v1Acc),
      new BundlerSwitcher(ethereum, areUpdatesForbidden),
      errorCallback
    )

    expect(response instanceof Error).toBe(false)
    const res = response as FullEstimation
    expect(res.ambire instanceof Error).toBe(false)
    const ambireGas = res.ambire as AmbireEstimation
    const nativeOutcome = ambireGas.feePaymentOptions.find(
      (option) => option.token.address === ZeroAddress && !option.token.flags.onGasTank
    )
    expect(nativeOutcome).not.toBe(undefined)
    expect(nativeOutcome).not.toBe(null)
    expect(nativeOutcome!.gasUsed).toBeGreaterThan(0n)
    expect(nativeToken!.amount - nativeOutcome!.availableAmount).toBe(1n)

    // This is the min gas unit we can spend, but we expect more than that having in mind that multiple computations happens in the Contract
    expect(ambireGas.gasUsed).toBeLessThan(21000n)
    expect(ambireGas.gasUsed + nativeOutcome!.gasUsed!).toBeGreaterThan(21000n)

    // the view only should be undefined
    const viewOnlyAccOption = ambireGas.feePaymentOptions.find(
      (opt) => opt.paidBy === viewOnlyAcc.addr && opt.token.address === ethers.ZeroAddress
    )
    expect(viewOnlyAccOption).toBe(undefined)

    expect(res.provider).toBe(null)
    expect(res.bundler).toBe(null)
  })

  it('[v1] estimates correctly by passing multiple view only accounts to estimation and removing the fee options for them as they are not valid', async () => {
    const v1AccAbi = new Contract(v1Acc.addr, AmbireAccount.abi, provider)
    const eoaAddr = '0x40b38765696e3d5d8d9d834d8aad4bb6e418e489'
    const op = {
      accountAddr: v1Acc.addr,
      signingKeyAddr: null,
      signingKeyType: null,
      gasLimit: null,
      gasFeePayment: null,
      chainId: 1n,
      nonce: await v1AccAbi.nonce(),
      signature: spoofSig,
      calls: [{ to: eoaAddr, value: 1n, data: '0x' }],
      accountOpToExecuteBefore: null
    }

    const accountStates = await getAccountsInfo([v1Acc])
    const accountState = accountStates[v1Acc.addr][ethereum.chainId.toString()]
    const baseAcc = getBaseAccount(v1Acc, accountState, [], ethereum)
    const response = await getEstimation(
      baseAcc,
      accountState,
      op,
      ethereum,
      provider,
      feeTokens,
      getNativeToCheckFromEOAs(nativeToCheck, v1Acc),
      new BundlerSwitcher(ethereum, areUpdatesForbidden),
      errorCallback
    )

    expect(response instanceof Error).toBe(false)
    const res = response as FullEstimation
    expect(res.ambire instanceof Error).toBe(false)
    const ambireGas = res.ambire as AmbireEstimation
    const viewOnlyAccOption = ambireGas.feePaymentOptions.find(
      (opt) => opt.paidBy === viewOnlyAcc.addr
    )
    // view only accounts shouldn't appear as payment options for other accounts
    expect(viewOnlyAccOption).toBe(undefined)
  })

  it('estimate a view only account op', async () => {
    const eoaAddr = '0x40b38765696e3d5d8d9d834d8aad4bb6e418e489'
    const op = {
      accountAddr: viewOnlyAcc.addr,
      signingKeyAddr: null,
      signingKeyType: null,
      gasLimit: null,
      gasFeePayment: null,
      chainId: 1n,
      nonce: 1n,
      signature: spoofSig,
      calls: [{ to: eoaAddr, value: BigInt(1), data: '0x' }],
      accountOpToExecuteBefore: null
    }

    const accountStates = await getAccountsInfo([viewOnlyAcc])
    const accountState = accountStates[viewOnlyAcc.addr][ethereum.chainId.toString()]
    const baseAcc = getBaseAccount(viewOnlyAcc, accountState, [], ethereum)
    const response = await getEstimation(
      baseAcc,
      accountState,
      op,
      ethereum,
      provider,
      feeTokens,
      getNativeToCheckFromEOAs(nativeToCheck, viewOnlyAcc),
      new BundlerSwitcher(ethereum, areUpdatesForbidden),
      errorCallback
    )

    expect(response instanceof Error).toBe(false)
    const res = response as FullEstimation
    expect(res.ambire instanceof Error).toBe(false)
    const ambireGas = res.ambire as AmbireEstimation

    // make sure we display the view only account payment option
    const viewOnlyAccOption = ambireGas.feePaymentOptions.find(
      (opt) => opt.paidBy === viewOnlyAcc.addr
    )
    expect(viewOnlyAccOption).not.toBe(undefined)
  })

  it.skip('estimates with `addedNative`', async () => {
    const accountOptimismv1: Account = {
      addr: '0xB674F3fd5F43464dB0448a57529eAF37F04cceA5',
      associatedKeys: ['0x5Be214147EA1AE3653f289E17fE7Dc17A73AD175'],
      initialPrivileges: [
        [
          '0x5Be214147EA1AE3653f289E17fE7Dc17A73AD175',
          '0x0000000000000000000000000000000000000000000000000000000000000001'
        ]
      ],
      creation: {
        factoryAddr: '0xBf07a0Df119Ca234634588fbDb5625594E2a5BCA',
        bytecode:
          '0x7f00000000000000000000000000000000000000000000000000000000000000017fc00d23fd13e6cc01978ac25779646c3ba8aa974211c51a8b0f257a4593a6b7d3553d602d80604d3d3981f3363d3d373d3d3d363d732a2b85eb1054d6f0c6c2e37da05ed3e5fea684ef5af43d82803e903d91602b57fd5bf3',
        salt: '0x0000000000000000000000000000000000000000000000000000000000000001'
      },
      preferences: {
        label: DEFAULT_ACCOUNT_LABEL,
        pfp: '0xB674F3fd5F43464dB0448a57529eAF37F04cceA5'
      }
    }

    const v1AccAbi = new Contract(accountOptimismv1.addr, AmbireAccount.abi, providerOptimism)
    const eoaAddr = '0x40b38765696e3d5d8d9d834d8aad4bb6e418e489'
    const opOptimism = {
      accountAddr: accountOptimismv1.addr,
      signingKeyAddr: accountOptimismv1.associatedKeys[0],
      signingKeyType: null,
      gasLimit: null,
      gasFeePayment: null,
      chainId: 10n,
      nonce: await v1AccAbi.nonce(),
      signature: spoofSig,
      calls: [{ to: eoaAddr, value: BigInt(1), data: '0x' }],
      accountOpToExecuteBefore: null
    }

    const accountStates = await getAccountsInfo([accountOptimismv1])
    const accountState = accountStates[accountOptimismv1.addr][optimism.chainId.toString()]
    const baseAcc = getBaseAccount(accountOptimismv1, accountState, [], optimism)
    const response = await getEstimation(
      baseAcc,
      accountState,
      opOptimism,
      optimism,
      providerOptimism,
      feeTokens,
      getNativeToCheckFromEOAs(nativeToCheck, accountOptimismv1),
      new BundlerSwitcher(optimism, areUpdatesForbidden),
      errorCallback
    )

    expect(response instanceof Error).toBe(false)
    const res = response as FullEstimation
    expect(res.ambire instanceof Error).toBe(false)
    const ambireGas = res.ambire as AmbireEstimation
    ambireGas.feePaymentOptions.forEach((feeToken) => {
      expect(feeToken.addedNative).toBeGreaterThan(0n)
    })
  })

  // skipping this one as we don't handle the deprycated account anymore
  it.skip('estimates an arbitrum request with the deprycated ambire v2 account', async () => {
    const eoaAddr = '0x40b38765696e3d5d8d9d834d8aad4bb6e418e489'
    const usdtAddr = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9'
    const v2AccAbi = new Contract(deprycatedV2.addr, AmbireAccount.abi, providerArbitrum)
    const ERC20Interface = new Interface(ERC20.abi)
    const opArbitrum = {
      accountAddr: deprycatedV2.addr,
      signingKeyAddr: deprycatedV2.associatedKeys[0],
      signingKeyType: null,
      gasLimit: null,
      gasFeePayment: null,
      chainId: 42161n,
      nonce: await v2AccAbi.nonce(),
      signature: spoofSig,
      calls: [
        {
          to: usdtAddr,
          value: 0n,
          data: ERC20Interface.encodeFunctionData('transfer', [eoaAddr, 1])
        }
      ],
      accountOpToExecuteBefore: null
    }

    const accountStates = await getAccountsInfo([deprycatedV2])
    const accountState = accountStates[deprycatedV2.addr][arbitrum.chainId.toString()]
    const baseAcc = getBaseAccount(deprycatedV2, accountState, [], arbitrum)
    const response = await getEstimation(
      baseAcc,
      accountState,
      opArbitrum,
      arbitrum,
      providerArbitrum,
      feeTokens,
      getNativeToCheckFromEOAs(nativeToCheck, deprycatedV2),
      new BundlerSwitcher(arbitrum, areUpdatesForbidden),
      errorCallback
    )

    console.log(response)

    expect(response instanceof Error).toBe(false)
    const res = response as FullEstimation
    expect(res.ambire instanceof Error).toBe(false)
    const ambireGas = res.ambire as AmbireEstimation
    ambireGas.feePaymentOptions.forEach((feeToken) => {
      expect(feeToken.addedNative).toBe(0n)
    })
    // this is true because it's an outdate smart account here
    // and we're testing ambire estimate only
    expect(res.bundler instanceof Error).toBe(true)
  })

  it.skip('Optimism | deployed account | should put a lower account nonce in account op and ambire etimation should raise a nonce discrepancy flag', async () => {
    const opOptimism = {
      accountAddr: smartAccDeployed.addr,
      signingKeyAddr: smartAccDeployed.associatedKeys[0],
      signingKeyType: null,
      gasLimit: null,
      gasFeePayment: null,
      chainId: 10n,
      nonce: 6n, // corrupt the nonce
      signature: '0x',
      calls: [{ to: FEE_COLLECTOR, value: 1n, data: '0x' }],
      accountOpToExecuteBefore: null
    }
    const accountStates = await getAccountsInfo([smartAccDeployed])
    const accountState = accountStates[smartAccDeployed.addr][optimism.chainId.toString()]
    const baseAcc = getBaseAccount(smartAccDeployed, accountState, [], optimism)
    const response = await getEstimation(
      baseAcc,
      accountState,
      opOptimism,
      optimism,
      providerOptimism,
      feeTokens,
      getNativeToCheckFromEOAs(nativeToCheck, smartAccDeployed),
      new BundlerSwitcher(optimism, areUpdatesForbidden),
      errorCallback
    )

    expect(response instanceof Error).toBe(false)
    const res = response as FullEstimation
    expect(res.provider).toBe(null)
    expect(res.ambire instanceof Error).toBe(false)
    expect(res.bundler instanceof Error).toBe(false)
    const ambireGas = res.ambire as AmbireEstimation
    expect(ambireGas.feePaymentOptions.length).toBeGreaterThan(0)
    expect(ambireGas.ambireAccountNonce).toBe(7)
    expect(ambireGas.flags.hasNonceDiscrepancy).toBe(true)
  })

  it.skip('[ERC-4337]:Optimism | not deployed | should work', async () => {
    const privs = [
      {
        addr: addrWithDeploySignature,
        hash: dedicatedToOneSAPriv
      }
    ]
    const smartAcc = await getSmartAccount(privs, [])
    const opOptimism = {
      accountAddr: smartAcc.addr,
      signingKeyAddr: smartAcc.associatedKeys[0],
      signingKeyType: null,
      gasLimit: null,
      gasFeePayment: null,
      chainId: 10n,
      nonce: 0n,
      signature: '0x',
      calls: [{ to: FEE_COLLECTOR, value: 1n, data: '0x' }],
      accountOpToExecuteBefore: null,
      meta: {
        entryPointAuthorization:
          '0x05404ea5dfa13ddd921cda3f587af6927cc127ee174b57c9891491bfc1f0d3d005f649f8a1fc9147405f064507bae08816638cfc441c4d0dc4eb6640e16621991b01'
      }
    }
    const accountStates = await getAccountsInfo([smartAcc])
    const accountState = accountStates[smartAcc.addr][optimism.chainId.toString()]
    const baseAcc = getBaseAccount(smartAcc, accountState, [], optimism)
    const response = await getEstimation(
      baseAcc,
      accountState,
      opOptimism,
      optimism,
      providerOptimism,
      feeTokens,
      getNativeToCheckFromEOAs(nativeToCheck, smartAcc),
      new BundlerSwitcher(optimism, areUpdatesForbidden),
      errorCallback
    )

    expect(response instanceof Error).toBe(false)
    const res = response as FullEstimation
    expect(res.provider).toBe(null)
    expect(res.ambire instanceof Error).toBe(false)
    const ambireGas = res.ambire as AmbireEstimation
    expect(ambireGas.feePaymentOptions.length).toBeGreaterThan(0)
    expect(res.bundler instanceof Error).toBe(false)
    const bundlerGas = res.bundler as Erc4337GasLimits

    expect(BigInt(bundlerGas.callGasLimit)).toBeGreaterThan(0n)
    expect(BigInt(bundlerGas.verificationGasLimit)).toBeGreaterThan(0n)
    expect(BigInt(bundlerGas.preVerificationGas)).toBeGreaterThan(0n)
    expect(BigInt(bundlerGas.paymasterPostOpGasLimit)).toBeGreaterThan(0n)
    expect(BigInt(bundlerGas.paymasterVerificationGasLimit)).toBeGreaterThan(0n)
  })

  it.skip('[ERC-4337]:Optimism | not deployed | should fail with an inner call failure but otherwise estimation should work', async () => {
    const privs = [
      {
        addr: addrWithDeploySignature,
        hash: dedicatedToOneSAPriv
      }
    ]
    const smartAcc = await getSmartAccount(privs, [])
    const opOptimism = {
      accountAddr: smartAcc.addr,
      signingKeyAddr: smartAcc.associatedKeys[0],
      signingKeyType: null,
      gasLimit: null,
      gasFeePayment: null,
      chainId: 10n,
      nonce: 0n,
      signature: '0x',
      calls: [{ to: FEE_COLLECTOR, value: parseEther('1'), data: '0x' }],
      accountOpToExecuteBefore: null,
      meta: {
        entryPointAuthorization:
          '0x05404ea5dfa13ddd921cda3f587af6927cc127ee174b57c9891491bfc1f0d3d005f649f8a1fc9147405f064507bae08816638cfc441c4d0dc4eb6640e16621991b01'
      }
    }
    const accountStates = await getAccountsInfo([smartAcc])
    const accountState = accountStates[smartAcc.addr][optimism.chainId.toString()]
    const baseAcc = getBaseAccount(smartAcc, accountState, [], optimism)
    const response = await getEstimation(
      baseAcc,
      accountState,
      opOptimism,
      optimism,
      providerOptimism,
      feeTokens,
      getNativeToCheckFromEOAs(nativeToCheck, smartAcc),
      new BundlerSwitcher(optimism, areUpdatesForbidden),
      errorCallback
    )

    expect(response instanceof Error).toBe(true)
    expect((response as Error).message).toBe(
      "Transaction cannot be sent because you don't have enough ETH to cover the gas costs for this transaction."
    )
    expect((response as Error).cause).toBe('Insufficient ETH for transaction calls')
  })

  it.skip('[ERC-4337]:Optimism | not deployed | should result in an error as transfer amount of erc-20 token exceed balance', async () => {
    const privs = [
      {
        addr: addrWithDeploySignature,
        hash: dedicatedToOneSAPriv
      }
    ]
    const ERC20Interface = new Interface(ERC20.abi)
    const smartAcc = await getSmartAccount(privs, [])
    const opOptimism = {
      accountAddr: smartAcc.addr,
      signingKeyAddr: smartAcc.associatedKeys[0],
      signingKeyType: null,
      gasLimit: null,
      gasFeePayment: null,
      chainId: 10n,
      nonce: 0n,
      signature: '0x',
      calls: [
        {
          to: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
          value: 0n,
          data: ERC20Interface.encodeFunctionData('transfer', [FEE_COLLECTOR, 100])
        }
      ],
      accountOpToExecuteBefore: null,
      meta: {
        entryPointAuthorization:
          '0x05404ea5dfa13ddd921cda3f587af6927cc127ee174b57c9891491bfc1f0d3d005f649f8a1fc9147405f064507bae08816638cfc441c4d0dc4eb6640e16621991b01'
      }
    }
    const accountStates = await getAccountsInfo([smartAcc])
    const accountState = accountStates[smartAcc.addr][optimism.chainId.toString()]
    const baseAcc = getBaseAccount(smartAcc, accountState, [], optimism)
    const response = await getEstimation(
      baseAcc,
      accountState,
      opOptimism,
      optimism,
      providerOptimism,
      feeTokens,
      getNativeToCheckFromEOAs(nativeToCheck, smartAcc),
      new BundlerSwitcher(optimism, areUpdatesForbidden),
      errorCallback
    )

    expect(response instanceof Error).toBe(true)
    expect((response as Error).message).toBe(
      'Transaction cannot be sent because the transfer amount exceeds your account balance. Please check your balance or adjust the transfer amount.'
    )
  })

  it.skip('[ERC-4337]:Optimism | deployed account | should work', async () => {
    const ambAcc = new Contract(smartAccDeployed.addr, AmbireAccount.abi, providerOptimism)
    const nonce = await ambAcc.nonce()
    const opOptimism = {
      accountAddr: smartAccDeployed.addr,
      signingKeyAddr: smartAccDeployed.associatedKeys[0],
      signingKeyType: null,
      gasLimit: null,
      gasFeePayment: null,
      chainId: 10n,
      nonce,
      signature: '0x',
      calls: [{ to: FEE_COLLECTOR, value: 1n, data: '0x' }],
      accountOpToExecuteBefore: null
    }
    const accountStates = await getAccountsInfo([smartAccDeployed])
    const accountState = accountStates[smartAccDeployed.addr][optimism.chainId.toString()]
    const baseAcc = getBaseAccount(smartAccDeployed, accountState, [], optimism)
    const response = await getEstimation(
      baseAcc,
      accountState,
      opOptimism,
      optimism,
      providerOptimism,
      feeTokens,
      getNativeToCheckFromEOAs(nativeToCheck, smartAccDeployed),
      new BundlerSwitcher(optimism, areUpdatesForbidden),
      errorCallback
    )

    expect(response instanceof Error).toBe(false)
    const res = response as FullEstimation
    expect(res.provider).toBe(null)
    expect(res.ambire instanceof Error).toBe(false)
    const ambireGas = res.ambire as AmbireEstimation
    expect(ambireGas.feePaymentOptions.length).toBeGreaterThan(0)
    expect(res.bundler instanceof Error).toBe(false)
    const bundlerGas = res.bundler as Erc4337GasLimits

    expect(BigInt(bundlerGas.callGasLimit)).toBeGreaterThan(0n)
    expect(BigInt(bundlerGas.verificationGasLimit)).toBeGreaterThan(0n)
    expect(BigInt(bundlerGas.preVerificationGas)).toBeGreaterThan(0n)
    expect(BigInt(bundlerGas.paymasterPostOpGasLimit)).toBeGreaterThan(0n)
    expect(BigInt(bundlerGas.paymasterVerificationGasLimit)).toBeGreaterThan(0n)
  })

  it.skip('[ERC-4337]:Optimism | deployed account | corrupt the account info with incorrect 4337 nonce | should work regardless', async () => {
    const ambAcc = new Contract(smartAccDeployed.addr, AmbireAccount.abi, providerOptimism)
    const nonce = await ambAcc.nonce()
    const opOptimism = {
      accountAddr: smartAccDeployed.addr,
      signingKeyAddr: smartAccDeployed.associatedKeys[0],
      signingKeyType: null,
      gasLimit: null,
      gasFeePayment: null,
      chainId: 10n,
      nonce,
      signature: '0x',
      calls: [{ to: FEE_COLLECTOR, value: 1n, data: '0x' }],
      accountOpToExecuteBefore: null
    }
    const accountStates = await getAccountsInfo([smartAccDeployed])
    const accountState = accountStates[smartAccDeployed.addr][optimism.chainId.toString()]

    // corrupt the nonce to be lower
    accountState.erc4337Nonce = 6n

    const baseAcc = getBaseAccount(smartAccDeployed, accountState, [], optimism)
    const response = await getEstimation(
      baseAcc,
      accountState,
      opOptimism,
      optimism,
      providerOptimism,
      feeTokens,
      getNativeToCheckFromEOAs(nativeToCheck, smartAccDeployed),
      new BundlerSwitcher(optimism, areUpdatesForbidden),
      errorCallback
    )

    expect(response instanceof Error).toBe(false)
    const res = response as FullEstimation
    expect(res.provider).toBe(null)
    expect(res.ambire instanceof Error).toBe(false)
    const ambireGas = res.ambire as AmbireEstimation
    expect(ambireGas.feePaymentOptions.length).toBeGreaterThan(0)
    expect(res.bundler instanceof Error).toBe(false)
    const bundlerGas = res.bundler as Erc4337GasLimits

    expect(BigInt(bundlerGas.callGasLimit)).toBeGreaterThan(0n)
    expect(BigInt(bundlerGas.verificationGasLimit)).toBeGreaterThan(0n)
    expect(BigInt(bundlerGas.preVerificationGas)).toBeGreaterThan(0n)
    expect(BigInt(bundlerGas.paymasterPostOpGasLimit)).toBeGreaterThan(0n)
    expect(BigInt(bundlerGas.paymasterVerificationGasLimit)).toBeGreaterThan(0n)

    // make sure the flag was raised
    expect(bundlerGas.flags.has4337NonceDiscrepancy).toBe(true)
    expect(res.flags.has4337NonceDiscrepancy).toBe(true)
  })

  it('estimates a polygon request with insufficient funds for txn and estimation should fail with transaction reverted because of insufficient funds', async () => {
    const opPolygonFailBzNoFunds = {
      accountAddr: deprycatedV2.addr,
      signingKeyAddr: deprycatedV2.associatedKeys[0],
      signingKeyType: null,
      gasLimit: null,
      gasFeePayment: null,
      chainId: polygon.chainId,
      nonce: 1n,
      signature: '0x',
      calls: [{ to: trezorSlot6v2NotDeployed.addr, value: parseEther('10'), data: '0x' }],
      accountOpToExecuteBefore: null
    }
    const accountStates = await getAccountsInfo([deprycatedV2])
    const accountState = accountStates[deprycatedV2.addr][polygon.chainId.toString()]
    const baseAcc = getBaseAccount(deprycatedV2, accountState, [], polygon)
    const response = await getEstimation(
      baseAcc,
      accountState,
      opPolygonFailBzNoFunds,
      polygon,
      providerPolygon,
      feeTokens,
      getNativeToCheckFromEOAs(nativeToCheck, deprycatedV2),
      new BundlerSwitcher(polygon, areUpdatesForbidden),
      errorCallback
    )
    expect(response instanceof Error).toBe(true)
    expect((response as Error).message).toBe(
      "Transaction cannot be sent because you don't have enough POL to cover the gas costs for this transaction."
    )
    expect((response as Error).cause).toBe('Insufficient POL for transaction calls')
  })

  it('estimates a polygon request with wrong signer and estimation should fail with insufficient privileges', async () => {
    const opPolygonFailBzNoFunds = {
      accountAddr: deprycatedV2.addr,
      signingKeyAddr: trezorSlot6v2NotDeployed.associatedKeys[0],
      signingKeyType: null,
      gasLimit: null,
      gasFeePayment: null,
      chainId: polygon.chainId,
      nonce: 1n,
      signature: '0x',
      calls: [{ to: trezorSlot6v2NotDeployed.addr, value: 100000n, data: '0x' }],
      accountOpToExecuteBefore: null
    }
    const accountStates = await getAccountsInfo([deprycatedV2])
    const accountState = accountStates[deprycatedV2.addr][polygon.chainId.toString()]

    const baseAcc = getBaseAccount(
      { ...deprycatedV2, associatedKeys: [trezorSlot6v2NotDeployed.associatedKeys[0]] },
      accountState,
      [],
      polygon
    )
    const response = await getEstimation(
      baseAcc,
      accountState,
      opPolygonFailBzNoFunds,
      polygon,
      providerPolygon,
      feeTokens,
      getNativeToCheckFromEOAs(nativeToCheck, deprycatedV2),
      new BundlerSwitcher(polygon, areUpdatesForbidden),
      errorCallback
    )
    expect(response instanceof Error).toBe(true)
    expect((response as Error).message).toBe(
      'Transaction cannot be sent because your account key lacks the necessary permissions. Ensure that you have authorization to sign or use an account with sufficient privileges.'
    )
  })

  it('[v1] estimates an expired uniswap swap and it should display error properly', async () => {
    const op = {
      accountAddr: v1Acc.addr,
      signingKeyAddr: null,
      signingKeyType: null,
      gasLimit: null,
      gasFeePayment: null,
      chainId: 1n,
      nonce: 1n,
      signature: '0x',
      calls: [{ to, value: BigInt(0), data: expiredData }],
      accountOpToExecuteBefore: null
    }

    const accountStates = await getAccountsInfo([v1Acc])
    const accountState = accountStates[v1Acc.addr][ethereum.chainId.toString()]
    const baseAcc = getBaseAccount(v1Acc, accountState, [], ethereum)
    const response = await getEstimation(
      baseAcc,
      accountState,
      op,
      ethereum,
      provider,
      feeTokens,
      getNativeToCheckFromEOAs(nativeToCheck, v1Acc),
      new BundlerSwitcher(ethereum, areUpdatesForbidden),
      errorCallback
    )

    expect(response instanceof Error).toBe(true)
    expect((response as Error).message).toBe(
      'Transaction cannot be sent because the swap has expired. Return to the app and reinitiate the swap if you wish to proceed.'
    )
  })
})

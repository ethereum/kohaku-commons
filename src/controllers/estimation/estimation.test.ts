import { ZeroAddress } from 'ethers'

import { beforeEach, describe, expect, jest, test } from '@jest/globals'

import { DEFAULT_ACCOUNT_LABEL } from '../../consts/account'
import { networks } from '../../consts/networks'
import { Account, AccountOnchainState } from '../../interfaces/account'
import { Key } from '../../interfaces/keystore'
import { Network } from '../../interfaces/network'
import { AccountOp } from '../../libs/accountOp/accountOp'
import { getEstimation } from '../../libs/estimate/estimate'
import { FeePaymentOption, FullEstimation } from '../../libs/estimate/interfaces'
import { TokenResult } from '../../libs/portfolio'
import { AccountsController } from '../accounts/accounts'
import { ActivityController } from '../activity/activity'
import { KeystoreController } from '../keystore/keystore'
import { NetworksController } from '../networks/networks'
import { PortfolioController } from '../portfolio/portfolio'
import { EstimationController } from './estimation'
import { EstimationStatus } from './types'

jest.mock('../../libs/estimate/estimate', () => {
  const actual = jest.requireActual<typeof import('../../libs/estimate/estimate')>(
    '../../libs/estimate/estimate'
  )
  return { ...actual, getEstimation: jest.fn() }
})

type Harness = {
  controller: EstimationController
  nativeToCheck: () => string[]
}

const mockedGetEstimation = getEstimation as jest.MockedFunction<typeof getEstimation>

const network: Network = {
  ...networks.find((n) => n.chainId === 1n)!,
  chainId: 11155111n,
  has7702: false,
  hasRelayer: false,
  erc4337: {
    ...networks.find((n) => n.chainId === 1n)!.erc4337,
    enabled: false,
    hasPaymaster: false,
    hasBundlerSupport: false
  }
}

const nativeToken: TokenResult = {
  address: ZeroAddress,
  symbol: 'ETH',
  name: 'Ether',
  amount: 0n,
  chainId: network.chainId,
  decimals: 18,
  priceIn: [{ baseCurrency: 'usd', price: 1000 }],
  flags: { onGasTank: false, rewardsType: null, canTopUpGasTank: true, isFeeToken: true }
}

const controllingKeyAddr = '0x16c81367c30c71d6B712355255A07FCe8fd3b5bB'
const listedBasicAddr = '0x71c3D24a627f0416db45107353d8d0A5ae0401ae'
const strangerKeyAddr = '0x141A14B5C4dbA2aC7a7943E02eDFE2E7eDfdA28F'

const makeKey = (addr: string): Key => ({
  addr,
  type: 'internal',
  label: 'Key',
  dedicatedToOneSA: true,
  meta: { createdAt: null },
  isExternallyStored: false
})

const makeSmartAccount = (associatedKeys: string[]): Account => ({
  addr: '0x4AA524DDa82630cE769e5C9d7ec7a45B94a41bc6',
  associatedKeys,
  initialPrivileges: [],
  creation: {
    factoryAddr: '0xa8202f888b9b2dfa5ceb2204865018133f6f179a',
    bytecode: '0x00',
    salt: '0x0000000000000000000000000000000000000000000000000000000000000000'
  },
  preferences: { label: DEFAULT_ACCOUNT_LABEL, pfp: '' }
})

const makeBasicAccount = (addr: string): Account => ({
  addr,
  associatedKeys: [addr],
  initialPrivileges: [],
  creation: null,
  preferences: { label: DEFAULT_ACCOUNT_LABEL, pfp: addr }
})

const makeState = (account: Account): AccountOnchainState => ({
  accountAddr: account.addr,
  isDeployed: !account.creation,
  eoaNonce: 0n,
  nonce: 0n,
  erc4337Nonce: 0n,
  associatedKeys: {},
  deployError: false,
  balance: 0n,
  isEOA: !account.creation,
  isErc4337Enabled: false,
  isErc4337Nonce: false,
  isV2: !!account.creation,
  currentBlock: 0n,
  isSmarterEoa: false,
  delegatedContract: null,
  delegatedContractName: null
})

const makeOp = (account: Account): AccountOp => ({
  accountAddr: account.addr,
  chainId: network.chainId,
  signingKeyAddr: null,
  signingKeyType: null,
  gasLimit: null,
  gasFeePayment: null,
  nonce: 0n,
  signature: null,
  accountOpToExecuteBefore: null,
  calls: [{ to: listedBasicAddr, value: 0n, data: '0x' }]
})

// Each payer the estimation reads gets this native balance, as the
// estimation contract would return it for the addresses it is given
const balances: { [addr: string]: bigint } = {
  [controllingKeyAddr]: 3n * 10n ** 16n,
  [listedBasicAddr]: 5n * 10n ** 16n,
  [strangerKeyAddr]: 10n ** 16n
}

const option = (paidBy: string, availableAmount: bigint): FeePaymentOption => ({
  paidBy,
  availableAmount,
  gasUsed: 0n,
  addedNative: 0n,
  token: { ...nativeToken, amount: availableAmount }
})

const setup = (account: Account, listed: Account[], keys: Key[]): Harness => {
  let checked: string[] = []
  mockedGetEstimation.mockImplementation(async (baseAcc, state, op, net, provider, f, native) => {
    checked = native
    const estimation: FullEstimation = {
      provider: null,
      bundler: null,
      flags: {},
      ambire: {
        gasUsed: 50000n,
        deploymentGas: 0n,
        ambireAccountNonce: 0,
        flags: {},
        feePaymentOptions: [
          option(account.addr, 0n),
          ...native.map((addr) => option(addr, balances[addr] ?? 0n))
        ]
      }
    }
    return estimation
  })

  const keystore = {
    keys,
    getAccountKeys: (acc: Account) => keys.filter((key) => acc.associatedKeys.includes(key.addr))
  } as unknown as KeystoreController
  const accounts = {
    accounts: [account, ...listed],
    getOrFetchAccountOnChainState: async () => makeState(account),
    updateAccountState: async () => {}
  } as unknown as AccountsController
  const networksCtrl = { networks: [network] } as unknown as NetworksController
  const portfolio = {
    getLatestPortfolioState: () => ({
      [network.chainId.toString()]: { result: { feeTokens: [nativeToken] } }
    }),
    updateSelectedAccount: async () => {}
  } as unknown as PortfolioController

  const controller = new EstimationController(
    keystore,
    accounts,
    networksCtrl,
    {} as never,
    portfolio,
    {} as ActivityController,
    {} as never
  )

  return { controller, nativeToCheck: () => checked }
}

describe('EstimationController payers', () => {
  beforeEach(() => {
    mockedGetEstimation.mockReset()
  })

  test('a smart account whose key the keystore holds gets that key as a payer, before the listed accounts', async () => {
    const account = makeSmartAccount([controllingKeyAddr])
    const { controller, nativeToCheck } = setup(
      account,
      [makeBasicAccount(listedBasicAddr)],
      [makeKey(controllingKeyAddr), makeKey(listedBasicAddr)]
    )

    await controller.estimate(makeOp(account))

    expect(controller.status).toBe(EstimationStatus.Success)
    expect(nativeToCheck()).toEqual([controllingKeyAddr, listedBasicAddr])
    expect(controller.availableFeeOptions.map((opt) => opt.paidBy)).toEqual([
      account.addr,
      controllingKeyAddr,
      listedBasicAddr
    ])
    const keyOption = controller.availableFeeOptions.find(
      (opt) => opt.paidBy === controllingKeyAddr
    )!
    expect(keyOption.availableAmount).toBe(balances[controllingKeyAddr])
    expect(keyOption.token.address).toBe(ZeroAddress)
  })

  test('a view only smart account gets no key payer', async () => {
    const account = makeSmartAccount([strangerKeyAddr])
    const { controller, nativeToCheck } = setup(
      account,
      [makeBasicAccount(listedBasicAddr)],
      [makeKey(listedBasicAddr)]
    )

    await controller.estimate(makeOp(account))

    expect(nativeToCheck()).toEqual([listedBasicAddr])
    expect(controller.availableFeeOptions.map((opt) => opt.paidBy)).toEqual([
      account.addr,
      listedBasicAddr
    ])
  })

  test('a key that is also a listed account is read once, in the listed order', async () => {
    const otherListedAddr = '0x71c3D24a627f0416db45107353d8d0A5ae0402ae'
    const account = makeSmartAccount([listedBasicAddr])
    const { controller, nativeToCheck } = setup(
      account,
      [makeBasicAccount(otherListedAddr), makeBasicAccount(listedBasicAddr)],
      [makeKey(listedBasicAddr), makeKey(otherListedAddr)]
    )

    await controller.estimate(makeOp(account))

    expect(nativeToCheck()).toEqual([otherListedAddr, listedBasicAddr])
  })

  test('a key with no native balance is read but gets no option where neither a relayer nor a bundler runs', async () => {
    const emptyKeyAddr = '0x16c81367c30c71d6B712355255A07FCe8fd3b5cC'
    const account = makeSmartAccount([emptyKeyAddr])
    const { controller, nativeToCheck } = setup(
      account,
      [makeBasicAccount(listedBasicAddr)],
      [makeKey(emptyKeyAddr), makeKey(listedBasicAddr)]
    )

    await controller.estimate(makeOp(account))

    expect(controller.status).toBe(EstimationStatus.Success)
    expect(nativeToCheck()).toEqual([emptyKeyAddr, listedBasicAddr])
    expect(controller.availableFeeOptions.map((opt) => opt.paidBy)).toEqual([
      account.addr,
      listedBasicAddr
    ])
  })

  test('a basic account reads no other payer', async () => {
    const account = makeBasicAccount(listedBasicAddr)
    const { controller, nativeToCheck } = setup(
      account,
      [makeBasicAccount(controllingKeyAddr)],
      [makeKey(listedBasicAddr), makeKey(controllingKeyAddr)]
    )

    await controller.estimate(makeOp(account))

    expect(nativeToCheck()).toEqual([])
    expect(controller.availableFeeOptions.map((opt) => opt.paidBy)).toEqual([listedBasicAddr])
  })
})

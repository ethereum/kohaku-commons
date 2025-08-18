/* eslint no-console: "off" */

import { AbiCoder, getAddress, hexlify, parseEther, verifyMessage } from 'ethers'
import fetch from 'node-fetch'

import { describe, expect, test } from '@jest/globals'
import { recoverTypedSignature, SignTypedDataVersion } from '@metamask/eth-sig-util'

import { relayerUrl, trezorSlot7v24337Deployed, velcroUrl } from '../../../test/config'
import { produceMemoryStore, waitForAccountsCtrlFirstLoad } from '../../../test/helpers'
import { suppressConsoleBeforeEach } from '../../../test/helpers/console'
import { mockWindowManager } from '../../../test/helpers/window'
import { DEFAULT_ACCOUNT_LABEL } from '../../consts/account'
import { FEE_COLLECTOR } from '../../consts/addresses'
import { EOA_SIMULATION_NONCE } from '../../consts/deployless'
import { networks } from '../../consts/networks'
import { Account } from '../../interfaces/account'
import { Storage } from '../../interfaces/storage'
import { getBaseAccount } from '../../libs/account/getBaseAccount'
import { AccountOp, accountOpSignableHash } from '../../libs/accountOp/accountOp'
import { BROADCAST_OPTIONS } from '../../libs/broadcast/broadcast'
import { FullEstimationSummary } from '../../libs/estimate/interfaces'
import { GasRecommendation } from '../../libs/gasPrice/gasPrice'
import { KeystoreSigner } from '../../libs/keystoreSigner/keystoreSigner'
import { TokenResult } from '../../libs/portfolio'
import { relayerCall } from '../../libs/relayerCall/relayerCall'
import {
  adaptTypedMessageForMetaMaskSigUtil,
  getTypedData
} from '../../libs/signMessage/signMessage'
import { BundlerSwitcher } from '../../services/bundlers/bundlerSwitcher'
import { getRpcProvider } from '../../services/provider'
import { AccountsController } from '../accounts/accounts'
import { ActivityController } from '../activity/activity'
import { BannerController } from '../banner/banner'
import { EstimationController } from '../estimation/estimation'
import { EstimationStatus } from '../estimation/types'
import { GasPriceController } from '../gasPrice/gasPrice'
import { KeystoreController } from '../keystore/keystore'
import { NetworksController } from '../networks/networks'
import { PortfolioController } from '../portfolio/portfolio'
import { ProvidersController } from '../providers/providers'
import { SelectedAccountController } from '../selectedAccount/selectedAccount'
import { StorageController } from '../storage/storage'
import { getFeeSpeedIdentifier } from './helper'
import { FeeSpeed, SigningStatus } from './signAccountOp'
import { SignAccountOpTesterController } from './signAccountOpTester'

const providers = Object.fromEntries(
  networks.map((network) => [network.chainId, getRpcProvider(network.rpcUrls, network.chainId)])
)

const createEOAAccountOp = (account: Account) => {
  const to = '0x0000000000000000000000000000000000000000'

  const data = '0x'

  const nativeToCheck: Account[] = [
    {
      addr: account.addr,
      associatedKeys: [account.addr],
      initialPrivileges: [],
      creation: null,
      preferences: {
        label: DEFAULT_ACCOUNT_LABEL,
        pfp: account.addr
      }
    }
  ]
  const feeTokens = [
    {
      address: '0x0000000000000000000000000000000000000000',
      amount: 1n,
      symbol: 'ETH',
      name: 'Ether',
      chainId: 1n,
      decimals: 18,
      priceIn: [],
      flags: {
        onGasTank: false,
        rewardsType: null,
        canTopUpGasTank: true,
        isFeeToken: true
      }
    }
  ]

  const op = {
    accountAddr: account.addr,
    signingKeyAddr: null,
    signingKeyType: null,
    gasLimit: null,
    gasFeePayment: null,
    chainId: 1n,
    nonce: null, // does not matter when estimating
    calls: [{ to, value: BigInt(1), data }],
    accountOpToExecuteBefore: null,
    signature: null
  }

  return { op, nativeToCheck, feeTokens }
}

const createAccountOp = (
  account: Account,
  chainId: bigint = 1n
): {
  op: AccountOp
  nativeToCheck: Account[]
  feeTokens: TokenResult[]
} => {
  const to = '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45'

  const tomorrowHex = Math.floor((Date.now() + 86400000) / 1000).toString(16)
  // 64 chars expire hex
  // we set swap deadline always for tomorrow, in order to prevent the test failure with 'TRANSACTION TOO OLD'
  const expire = '0'.repeat(64 - tomorrowHex.length) + tomorrowHex

  // USDT -> USDC swap
  // Fee tokens: USDT, USDC
  const data = `0x5ae401dc${expire}00000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000e404e45aaf000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec7000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb4800000000000000000000000000000000000000000000000000000000000001f4000000000000000000000000a07d75aacefd11b425af7181958f0f85c312f14300000000000000000000000000000000000000000000000000000000000f424000000000000000000000000000000000000000000000000000000000000c33d9000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000`

  const nativeToCheck: Account[] = [
    {
      addr: '0xAa0e9a1E2D2CcF2B867fda047bb5394BEF1883E0',
      associatedKeys: ['0xAa0e9a1E2D2CcF2B867fda047bb5394BEF1883E0'],
      initialPrivileges: [],
      creation: null,
      preferences: {
        label: DEFAULT_ACCOUNT_LABEL,
        pfp: '0xAa0e9a1E2D2CcF2B867fda047bb5394BEF1883E0'
      }
    }
  ]
  const feeTokens = [
    {
      address: '0x0000000000000000000000000000000000000000',
      amount: 1n,
      symbol: 'ETH',
      name: 'Ether',
      chainId: 1n,
      decimals: 18,
      priceIn: [],
      flags: {
        onGasTank: false,
        rewardsType: null,
        canTopUpGasTank: true,
        isFeeToken: true
      }
    }
  ]

  const op: AccountOp = {
    accountAddr: account.addr,
    signingKeyAddr: null,
    signingKeyType: null,
    gasLimit: null,
    gasFeePayment: null,
    chainId,
    nonce: 0n, // does not matter when estimating
    calls: [{ to, value: BigInt(0), data }],
    accountOpToExecuteBefore: null,
    signature: null
  }

  return { op, nativeToCheck, feeTokens }
}

const usdcFeeToken: TokenResult = {
  amount: 54409383n,
  chainId: 137n,
  decimals: Number(6),
  priceIn: [{ baseCurrency: 'usd', price: 1.0 }],
  symbol: 'USDC',
  name: 'USD Coin',
  address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  flags: {
    onGasTank: false,
    rewardsType: null,
    canTopUpGasTank: true,
    isFeeToken: true
  }
}

const trezorEoa: Account = {
  addr: '0x71c3D24a627f0416db45107353d8d0A5ae0401ae',
  associatedKeys: ['0x71c3D24a627f0416db45107353d8d0A5ae0401ae'],
  initialPrivileges: [],
  creation: null,
  preferences: {
    label: DEFAULT_ACCOUNT_LABEL,
    pfp: '0x71c3D24a627f0416db45107353d8d0A5ae0401ae'
  }
}

const otherEoa: Account = {
  addr: '0x71c3D24a627f0416db45107353d8d0A5ae0402ae',
  associatedKeys: ['0x71c3D24a627f0416db45107353d8d0A5ae0401ae'],
  initialPrivileges: [],
  creation: null,
  preferences: {
    label: DEFAULT_ACCOUNT_LABEL,
    pfp: '0x71c3D24a627f0416db45107353d8d0A5ae0402ae'
  }
}

const nativeFeeTokenPolygon: TokenResult = {
  address: '0x0000000000000000000000000000000000000000',
  symbol: 'POL',
  name: 'Polygon Ecosystem Token',
  amount: 1000n,
  chainId: 137n,
  decimals: Number(18),
  priceIn: [{ baseCurrency: 'usd', price: 5000 }],
  flags: {
    onGasTank: false,
    rewardsType: null,
    canTopUpGasTank: true,
    isFeeToken: true
  }
}

const eoaSigner = {
  privKey: '0x1941fd49fae923cae5ba789ac8ed2662066861960c7aa339443e76d309a80f6f',
  keyPublicAddress: '0x16c81367c30c71d6B712355255A07FCe8fd3b5bB',
  pass: 'testpass'
}

const v1Account = {
  addr: '0xa07D75aacEFd11b425AF7181958F0F85c312f143',
  associatedKeys: ['0xd6e371526cdaeE04cd8AF225D42e37Bc14688D9E', eoaSigner.keyPublicAddress],
  initialPrivileges: [],
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

// add the eoaSigner as an associatedKey
trezorSlot7v24337Deployed.associatedKeys.push(eoaSigner.keyPublicAddress)

const eoaAccount: Account = {
  addr: eoaSigner.keyPublicAddress,
  associatedKeys: [eoaSigner.keyPublicAddress],
  initialPrivileges: [],
  creation: null,
  preferences: {
    label: DEFAULT_ACCOUNT_LABEL,
    pfp: eoaSigner.keyPublicAddress
  }
}

const smartAccount: Account = {
  addr: '0x4AA524DDa82630cE769e5C9d7ec7a45B94a41bc6',
  associatedKeys: ['0x141A14B5C4dbA2aC7a7943E02eDFE2E7eDfdA28F', eoaSigner.keyPublicAddress],
  creation: {
    factoryAddr: '0xa8202f888b9b2dfa5ceb2204865018133f6f179a',
    bytecode:
      '0x7f00000000000000000000000000000000000000000000000000000000000000027fa70e7c3e588683d0493e3cad10209993d632b6631bc4637b53a4174bad869718553d602d80604d3d3981f3363d3d373d3d3d363d730e370942ebe4d026d05d2cf477ff386338fc415a5af43d82803e903d91602b57fd5bf3',
    salt: '0x0000000000000000000000000000000000000000000000000000000000000000'
  },
  initialPrivileges: [
    [
      '0x141A14B5C4dbA2aC7a7943E02eDFE2E7eDfdA28F',
      '0x0000000000000000000000000000000000000000000000000000000000000001'
    ]
  ],
  preferences: {
    label: DEFAULT_ACCOUNT_LABEL,
    pfp: '0x4AA524DDa82630cE769e5C9d7ec7a45B94a41bc6'
  }
}

const e2esmartAccount: Account = {
  addr: '0x4C71d299f23eFC660b3295D1f631724693aE22Ac',
  associatedKeys: ['0xa18fe725A4a0E25A02411Ab28073E4F35D32d8e2'],
  creation: {
    factoryAddr: '0x26cE6745A633030A6faC5e64e41D21fb6246dc2d',
    bytecode:
      '0x7f00000000000000000000000000000000000000000000000000000000000000027fca32523c64c36083b1291dd9ad1e268d3731e36174438cb702336b275ccb8295553d602d80604d3d3981f3363d3d373d3d3d363d730f2aa7bcda3d9d210df69a394b6965cb2566c8285af43d82803e903d91602b57fd5bf3',
    salt: '0x0000000000000000000000000000000000000000000000000000000000000000'
  },
  initialPrivileges: [
    [
      '0xa18fe725A4a0E25A02411Ab28073E4F35D32d8e2',
      '0x0000000000000000000000000000000000000000000000000000000000000001'
    ]
  ],
  preferences: {
    label: DEFAULT_ACCOUNT_LABEL,
    pfp: '0x4C71d299f23eFC660b3295D1f631724693aE22Ac'
  }
}

const nativeFeeToken: TokenResult = {
  address: '0x0000000000000000000000000000000000000000',
  symbol: 'ETH',
  name: 'Ether',
  amount: 1000n,
  chainId: 1n,
  decimals: Number(18),
  priceIn: [{ baseCurrency: 'usd', price: 5000 }],
  flags: {
    onGasTank: false,
    rewardsType: null,
    canTopUpGasTank: true,
    isFeeToken: true
  }
}

const gasTankToken: TokenResult = {
  address: '0x0000000000000000000000000000000000000000',
  symbol: 'POL',
  name: 'Polygon Ecosystem Token',
  amount: 323871237812612123123n,
  chainId: 137n,
  decimals: Number(18),
  priceIn: [{ baseCurrency: 'usd', price: 5000 }],
  flags: {
    onGasTank: true,
    rewardsType: null,
    canTopUpGasTank: true,
    isFeeToken: true
  }
}

const windowManager = mockWindowManager().windowManager

const init = async (
  account: Account,
  accountOp: {
    op: AccountOp
    nativeToCheck: Account[]
    feeTokens: TokenResult[]
  },
  signer: any,
  estimationOrMock: FullEstimationSummary,
  gasPricesOrMock: { [key: string]: GasRecommendation[] },
  updateWholePortfolio?: boolean
) => {
  const storage: Storage = produceMemoryStore()
  const storageCtrl = new StorageController(storage)
  await storageCtrl.set('accounts', [account])
  await storageCtrl.set('selectedAccount', account.addr)
  const keystore = new KeystoreController(
    'default',
    storageCtrl,
    { internal: KeystoreSigner },
    windowManager
  )
  await keystore.addSecret('passphrase', signer.pass, '', false)
  await keystore.unlockWithSecret('passphrase', signer.pass)

  await keystore.addKeys([
    {
      addr: signer.keyPublicAddress,
      type: 'internal',
      label: 'Key 1',
      privateKey: signer.privKey,
      dedicatedToOneSA: true,
      meta: {
        createdAt: new Date().getTime()
      }
    }
  ])

  let providersCtrl: ProvidersController
  const networksCtrl = new NetworksController({
    storage: storageCtrl,
    fetch,
    relayerUrl,
    onAddOrUpdateNetworks: (nets) => {
      nets.forEach((n) => {
        providersCtrl.setProvider(n)
      })
    },
    onRemoveNetwork: (id) => {
      providersCtrl.removeProvider(id)
    }
  })
  providersCtrl = new ProvidersController(networksCtrl)
  providersCtrl.providers = providers
  const accountsCtrl = new AccountsController(
    storageCtrl,
    providersCtrl,
    networksCtrl,
    keystore,
    () => {},
    () => {},
    () => {}
  )
  await accountsCtrl.initialLoadPromise
  await waitForAccountsCtrlFirstLoad(accountsCtrl)
  await networksCtrl.initialLoadPromise
  await providersCtrl.initialLoadPromise

  const portfolio = new PortfolioController(
    storageCtrl,
    fetch,
    providersCtrl,
    networksCtrl,
    accountsCtrl,
    keystore,
    'https://staging-relayer.ambire.com',
    velcroUrl,
    new BannerController(storageCtrl)
  )
  const { op } = accountOp
  const network = networksCtrl.networks.find((x) => x.chainId === op.chainId)!
  await portfolio.updateSelectedAccount(account.addr, updateWholePortfolio ? undefined : [network])
  const provider = getRpcProvider(network.rpcUrls, network.chainId)

  if (portfolio.getLatestPortfolioState(account.addr)[op.chainId.toString()]!.result) {
    portfolio!.getLatestPortfolioState(account.addr)[op.chainId.toString()]!.result!.tokens = [
      {
        amount: 1n,
        chainId: op.chainId,
        decimals: Number(18),
        symbol: 'ETH',
        name: 'Ether',
        address: '0x0000000000000000000000000000000000000000',
        flags: {
          onGasTank: false,
          rewardsType: null,
          canTopUpGasTank: true,
          isFeeToken: true
        },
        priceIn: [{ baseCurrency: 'usd', price: 1000.0 }] //  For the sake of simplicity we mocked 1 ETH = 1000 USD
      },
      {
        amount: 54409383n,
        chainId: op.chainId,
        decimals: Number(6),
        symbol: 'USDC',
        name: 'USD Coin',
        address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        flags: {
          onGasTank: false,
          rewardsType: null,
          canTopUpGasTank: true,
          isFeeToken: true
        },
        priceIn: [{ baseCurrency: 'usd', price: 1.0 }]
      }
    ]
  }

  const bundlerSwitcher = new BundlerSwitcher(network, () => {
    return false
  })
  const callRelayer = relayerCall.bind({ url: '', fetch })
  const selectedAccountCtrl = new SelectedAccountController({
    storage: storageCtrl,
    accounts: accountsCtrl,
    keystore
  })
  const activity = new ActivityController(
    storageCtrl,
    fetch,
    callRelayer,
    accountsCtrl,
    selectedAccountCtrl,
    providersCtrl,
    networksCtrl,
    portfolio,
    () => Promise.resolve()
  )
  const baseAccount = getBaseAccount(
    account,
    accountsCtrl.accountStates[account.addr][network.chainId.toString()],
    keystore.keys.filter((key) => account.associatedKeys.includes(key.addr)),
    network
  )
  const estimationController = new EstimationController(
    keystore,
    accountsCtrl,
    networksCtrl,
    providers,
    portfolio,
    activity,
    bundlerSwitcher
  )
  estimationController.estimation = estimationOrMock
  estimationController.hasEstimated = true
  estimationController.status = EstimationStatus.Success
  estimationController.availableFeeOptions = estimationOrMock.ambireEstimation
    ? estimationOrMock.ambireEstimation.feePaymentOptions
    : estimationOrMock.providerEstimation!.feePaymentOptions
  const gasPriceController = new GasPriceController(
    network,
    provider,
    baseAccount,
    bundlerSwitcher,
    () => ({
      estimation: estimationController,
      readyToSign: true,
      isSignRequestStillActive: () => true
    })
  )
  gasPriceController.gasPrices = gasPricesOrMock
  const controller = new SignAccountOpTesterController(
    accountsCtrl,
    networksCtrl,
    keystore,
    portfolio,
    activity,
    {},
    account,
    network,
    provider,
    1,
    op,
    () => {},
    true,
    () => {},
    estimationController,
    gasPriceController
  )
  controller.update({
    hasNewEstimation: true,
    gasPrices: gasPricesOrMock[network.chainId.toString()]
  })

  return { controller }
}

describe('SignAccountOp Controller ', () => {
  test('Signing [EOA]: EOA account paying with a native token', async () => {
    const feePaymentOptions = [
      {
        paidBy: eoaAccount.addr,
        availableAmount: 1000000000000000000n, // 1 ETH
        gasUsed: 0n,
        addedNative: 5000n,
        token: {
          address: '0x0000000000000000000000000000000000000000',
          amount: parseEther('1'),
          symbol: 'ETH',
          name: 'Ether',
          chainId: 1n,
          decimals: 18,
          priceIn: [],
          flags: {
            onGasTank: false,
            rewardsType: null,
            canTopUpGasTank: true,
            isFeeToken: true
          }
        }
      }
    ]
    const { controller } = await init(
      eoaAccount,
      createEOAAccountOp(eoaAccount),
      eoaSigner,
      {
        providerEstimation: {
          gasUsed: 10000n,
          feePaymentOptions
        },
        ambireEstimation: {
          deploymentGas: 0n,
          gasUsed: 10000n,
          feePaymentOptions,
          ambireAccountNonce: Number(EOA_SIMULATION_NONCE),
          flags: {}
        },
        flags: {}
      },
      {
        // ethereum chain id
        '1': [
          {
            name: 'slow',
            baseFeePerGas: 100n,
            maxPriorityFeePerGas: 100n
          },
          {
            name: 'medium',
            baseFeePerGas: 200n,
            maxPriorityFeePerGas: 200n
          },
          {
            name: 'fast',
            baseFeePerGas: 300n,
            maxPriorityFeePerGas: 300n
          },
          {
            name: 'ape',
            baseFeePerGas: 400n,
            maxPriorityFeePerGas: 400n
          }
        ]
      }
    )

    controller.update({
      signingKeyAddr: eoaSigner.keyPublicAddress,
      signingKeyType: 'internal',
      feeToken: nativeFeeToken,
      paidBy: eoaAccount.addr,
      speed: FeeSpeed.Fast
    })

    await controller.sign()

    if (!controller.accountOp?.signature) {
      console.log('Signing errors:', controller.errors)
      throw new Error('Signing failed!')
    }

    expect(controller.accountOp.gasFeePayment).toEqual({
      paidBy: eoaAccount.addr,
      broadcastOption: BROADCAST_OPTIONS.bySelf,
      isGasTank: false,
      inToken: '0x0000000000000000000000000000000000000000',
      feeTokenChainId: 1n,
      amount: 6005000n, // ((300 + 300) × 10000) + 10000, i.e. ((baseFee + priorityFee) * gasUsed) + addedNative
      simulatedGasLimit: 10000n, // 10000, i.e. gasUsed,
      maxPriorityFeePerGas: 300n,
      gasPrice: 600n
    })

    expect(controller.accountOp.signature).toEqual('0x') // broadcasting and signRawTransaction is handled in main controller
    expect(controller.status).toEqual({ type: 'done' })
  })

  test('Signing [EOA]: should emit an error if the availableAmount is 0', async () => {
    const feePaymentOptions = [
      {
        paidBy: eoaAccount.addr,
        availableAmount: 0n,
        gasUsed: 0n,
        addedNative: 5000n,
        token: {
          address: '0x0000000000000000000000000000000000000000',
          amount: 100000n,
          symbol: 'ETH',
          name: 'Ether',
          chainId: 1n,
          decimals: 18,
          priceIn: [],
          flags: {
            onGasTank: false,
            rewardsType: null,
            canTopUpGasTank: true,
            isFeeToken: true
          }
        }
      }
    ]
    const { controller } = await init(
      eoaAccount,
      createEOAAccountOp(eoaAccount),
      eoaSigner,
      {
        providerEstimation: {
          gasUsed: 10000n,
          feePaymentOptions
        },
        ambireEstimation: {
          deploymentGas: 0n,
          gasUsed: 10000n,
          feePaymentOptions,
          ambireAccountNonce: Number(EOA_SIMULATION_NONCE),
          flags: {}
        },
        flags: {}
      },
      {
        '1': [
          {
            name: 'slow',
            baseFeePerGas: 100n,
            maxPriorityFeePerGas: 100n
          },
          {
            name: 'medium',
            baseFeePerGas: 200n,
            maxPriorityFeePerGas: 200n
          },
          {
            name: 'fast',
            baseFeePerGas: 300n,
            maxPriorityFeePerGas: 300n
          },
          {
            name: 'ape',
            baseFeePerGas: 400n,
            maxPriorityFeePerGas: 400n
          }
        ]
      }
    )

    let errorCount = 0
    const mockEmitError = jest.fn(() => errorCount++)
    ;(controller as any).emitError = mockEmitError

    controller.update({
      hasNewEstimation: true,
      signingKeyAddr: eoaSigner.keyPublicAddress,
      signingKeyType: 'internal',
      feeToken: nativeFeeToken,
      paidBy: eoaAccount.addr,
      speed: FeeSpeed.Fast
    })

    await controller.sign()

    expect(errorCount).toBe(1)
  })

  test('Signing [EOA]: should emit an error if the availableAmount is lower than required', async () => {
    const feePaymentOptions = [
      {
        paidBy: eoaAccount.addr,
        availableAmount: 1n,
        gasUsed: 0n,
        addedNative: 5000n,
        token: {
          address: '0x0000000000000000000000000000000000000000',
          amount: 100000n,
          symbol: 'ETH',
          name: 'Ether',
          chainId: 1n,
          decimals: 18,
          priceIn: [],
          flags: {
            onGasTank: false,
            rewardsType: null,
            canTopUpGasTank: true,
            isFeeToken: true
          }
        }
      }
    ]
    const { controller } = await init(
      eoaAccount,
      createEOAAccountOp(eoaAccount),
      eoaSigner,
      {
        providerEstimation: {
          gasUsed: 10000n,
          feePaymentOptions
        },
        ambireEstimation: {
          deploymentGas: 0n,
          gasUsed: 10000n,
          feePaymentOptions,
          ambireAccountNonce: Number(EOA_SIMULATION_NONCE),
          flags: {}
        },
        flags: {}
      },
      {
        '1': [
          {
            name: 'slow',
            baseFeePerGas: 100n,
            maxPriorityFeePerGas: 100n
          },
          {
            name: 'medium',
            baseFeePerGas: 200n,
            maxPriorityFeePerGas: 200n
          },
          {
            name: 'fast',
            baseFeePerGas: 300n,
            maxPriorityFeePerGas: 300n
          },
          {
            name: 'ape',
            baseFeePerGas: 400n,
            maxPriorityFeePerGas: 400n
          }
        ]
      }
    )

    let errorCount = 0
    const mockEmitError = jest.fn(() => errorCount++)
    ;(controller as any).emitError = mockEmitError

    controller.update({
      signingKeyAddr: eoaSigner.keyPublicAddress,
      signingKeyType: 'internal',
      feeToken: nativeFeeToken,
      paidBy: eoaAccount.addr
    })

    await controller.sign()

    expect(errorCount).toBe(1)
  })

  test('Signing [Relayer]: Smart account paying with ERC-20 token.', async () => {
    const chainId = 137n
    const feePaymentOptions = [
      {
        paidBy: smartAccount.addr,
        availableAmount: 500000000n,
        gasUsed: 25000n,
        addedNative: 0n,
        token: {
          address: '0x0000000000000000000000000000000000000000',
          amount: 1n,
          symbol: 'POL',
          name: 'Polygon Ecosystem Token',
          chainId: 137n,
          decimals: 18,
          priceIn: [],
          flags: {
            onGasTank: false,
            rewardsType: null,
            canTopUpGasTank: true,
            isFeeToken: true
          }
        }
      },
      {
        paidBy: smartAccount.addr,
        availableAmount: 500000000n,
        gasUsed: 50000n,
        addedNative: 0n,
        token: {
          address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
          amount: 1n,
          symbol: 'usdt',
          name: 'USD Token',
          chainId: 137n,
          decimals: 6,
          priceIn: [
            {
              baseCurrency: 'usd',
              price: 1
            }
          ],
          flags: {
            onGasTank: false,
            rewardsType: null,
            canTopUpGasTank: true,
            isFeeToken: true
          }
        }
      },
      {
        paidBy: smartAccount.addr,
        availableAmount: 500000000n,
        gasUsed: 25000n,
        addedNative: 0n,
        token: {
          address: usdcFeeToken.address,
          amount: 1n,
          symbol: 'usdc',
          name: 'USD Coin',
          chainId: 137n,
          decimals: 6,
          priceIn: [
            {
              baseCurrency: 'usd',
              price: 1
            }
          ],
          flags: {
            onGasTank: false,
            rewardsType: null,
            canTopUpGasTank: true,
            isFeeToken: true
          }
        }
      }
    ]
    const network = networks.find((n) => n.chainId === chainId)!
    const { controller } = await init(
      smartAccount,
      createAccountOp(smartAccount, network.chainId),
      eoaSigner,
      {
        providerEstimation: {
          gasUsed: 50000n,
          feePaymentOptions
        },
        ambireEstimation: {
          deploymentGas: 0n,
          gasUsed: 50000n,
          feePaymentOptions,
          ambireAccountNonce: 0,
          flags: {}
        },
        flags: {}
      },
      {
        '137': [
          {
            name: 'slow',
            baseFeePerGas: 1000000000n,
            maxPriorityFeePerGas: 1000000000n
          },
          {
            name: 'medium',
            baseFeePerGas: 2000000000n,
            maxPriorityFeePerGas: 2000000000n
          },
          {
            name: 'fast',
            baseFeePerGas: 5000000000n,
            maxPriorityFeePerGas: 5000000000n
          },
          {
            name: 'ape',
            baseFeePerGas: 7000000000n,
            maxPriorityFeePerGas: 7000000000n
          }
        ]
      }
    )

    controller.update({
      feeToken: usdcFeeToken,
      paidBy: smartAccount.addr,
      signingKeyAddr: eoaSigner.keyPublicAddress,
      signingKeyType: 'internal',
      hasNewEstimation: true
    })

    expect(controller.estimation.availableFeeOptions.length).toBe(3)
    controller.estimation.availableFeeOptions.forEach((option) => {
      const identifier = getFeeSpeedIdentifier(option, smartAccount.addr, null)
      expect(controller.feeSpeeds[identifier]).not.toBe(undefined)
      expect(controller.feeSpeeds[identifier].length).not.toBe(0)
    })

    await controller.sign()

    if (!controller.accountOp?.signature) {
      console.log('Signing errors:', controller.errors)
      throw new Error('Signing failed!')
    }

    expect(controller.accountOp!.gasFeePayment?.paidBy).toBe(smartAccount.addr)

    const typedData = getTypedData(
      network.chainId,
      controller.accountOp.accountAddr,
      hexlify(accountOpSignableHash(controller.accountOp, network.chainId))
    )
    const unwrappedSig = controller.accountOp.signature.slice(0, -2)
    const signerAddr = getAddress(
      recoverTypedSignature({
        data: adaptTypedMessageForMetaMaskSigUtil(typedData),
        signature: unwrappedSig,
        version: SignTypedDataVersion.V4
      })
    )

    // We expect the transaction to be signed with the passed signer address (keyPublicAddress)
    expect(eoaAccount.addr).toEqual(signerAddr)
    // If signing is successful, we expect controller's status to be done
    expect(controller.status).toEqual({ type: 'done' })

    // USDC decimals 6, that's why we divide by 1e6
    const fee = controller.accountOp!.gasFeePayment!.amount / BigInt(1e6)

    // We expect fee of $1 USDC
    expect(fee.toString()).toEqual('1')

    // We expect the fee payment call to be added.
    // TODO: here we can extend the validation a bit.
    expect(controller.accountOp.feeCall!.to).toEqual(controller.accountOp.gasFeePayment!.inToken)

    // We expect the signature to be wrapped with an Ambire type. More info: wrapEthSign().
    expect(controller.accountOp?.signature.slice(-2)).toEqual('01')
  })
})

describe('Negative cases', () => {
  suppressConsoleBeforeEach()

  test('Signing [Relayer]: should return an error if paying with ERC-20 token but no priceIn | nativeRatio available.', async () => {
    const chainId = 137n
    const network = networks.find((n) => n.chainId === chainId)!
    const feeTokenResult = {
      address: usdcFeeToken.address,
      amount: 1n,
      symbol: 'usdc',
      name: 'USD Coin',
      chainId: 137n,
      decimals: 6,
      // we make the priceIn empty for this test
      priceIn: [],
      flags: {
        onGasTank: false,
        rewardsType: null,
        canTopUpGasTank: true,
        isFeeToken: true
      }
    }
    const feePaymentOptions = [
      {
        paidBy: smartAccount.addr,
        availableAmount: 500000000n,
        gasUsed: 50000n,
        addedNative: 0n,
        token: feeTokenResult
      }
    ]
    const { controller } = await init(
      smartAccount,
      createAccountOp(smartAccount, network.chainId),
      eoaSigner,
      {
        providerEstimation: {
          gasUsed: 50000n,
          feePaymentOptions
        },
        ambireEstimation: {
          deploymentGas: 0n,
          gasUsed: 50000n,
          feePaymentOptions,
          ambireAccountNonce: 0,
          flags: {}
        },
        flags: {}
      },
      {
        '137': [
          {
            name: 'slow',
            baseFeePerGas: 1000000000n,
            maxPriorityFeePerGas: 1000000000n
          },
          {
            name: 'medium',
            baseFeePerGas: 2000000000n,
            maxPriorityFeePerGas: 2000000000n
          },
          {
            name: 'fast',
            baseFeePerGas: 5000000000n,
            maxPriorityFeePerGas: 5000000000n
          },
          {
            name: 'ape',
            baseFeePerGas: 7000000000n,
            maxPriorityFeePerGas: 7000000000n
          }
        ]
      }
    )

    controller.update({
      hasNewEstimation: true,
      feeToken: feeTokenResult,
      paidBy: smartAccount.addr,
      signingKeyAddr: eoaSigner.keyPublicAddress,
      signingKeyType: 'internal'
    })

    expect(controller.estimation.availableFeeOptions.length).toBe(1)
    const identifier = getFeeSpeedIdentifier(
      controller.estimation.availableFeeOptions[0],
      smartAccount.addr,
      null
    )
    expect(controller.feeSpeeds[identifier]).not.toBe(undefined)
    expect(controller.feeSpeeds[identifier].length).toBe(0)

    const errors = controller.errors
    expect(errors.length).toBe(1)
    expect(errors[0].title).toBe(
      `Currently, ${controller.estimation.availableFeeOptions[0].token.symbol} is unavailable as a fee token as we're experiencing troubles fetching its price. Please select another or contact support`
    )
    expect(controller.status?.type).toBe(SigningStatus.UnableToSign)
    await controller.sign()

    expect(controller.accountOp?.signature).toBe(null)
  })
  test('Signing [Relayer]: Smart account paying with gas tank.', async () => {
    const chainId = 137n
    const network = networks.find((n) => n.chainId === chainId)!
    network.erc4337.enabled = false
    const feePaymentOptions = [
      {
        paidBy: e2esmartAccount.addr,
        availableAmount: 500000000000000000000n,
        gasUsed: 25000n,
        addedNative: 0n,
        token: {
          address: '0x0000000000000000000000000000000000000000',
          amount: 1n,
          symbol: 'POL',
          name: 'Polygon Ecosystem Token',
          chainId: 137n,
          decimals: 18,
          priceIn: [],
          flags: {
            onGasTank: true,
            rewardsType: null,
            canTopUpGasTank: true,
            isFeeToken: true
          }
        }
      },
      {
        paidBy: e2esmartAccount.addr,
        availableAmount: 500000000n,
        gasUsed: 50000n,
        addedNative: 0n,
        token: {
          address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
          amount: 1n,
          symbol: 'usdt',
          name: 'USD Token',
          chainId: 137n,
          decimals: 6,
          priceIn: [],
          flags: {
            onGasTank: false,
            rewardsType: null,
            canTopUpGasTank: true,
            isFeeToken: true
          }
        }
      },
      {
        paidBy: e2esmartAccount.addr,
        availableAmount: 500000000n,
        gasUsed: 25000n,
        addedNative: 0n,
        token: {
          address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          amount: 1n,
          symbol: 'usdc',
          name: 'USD Coin',
          chainId: 137n,
          decimals: 6,
          priceIn: [],
          flags: {
            onGasTank: false,
            rewardsType: null,
            canTopUpGasTank: true,
            isFeeToken: true
          }
        }
      }
    ]
    const { controller } = await init(
      e2esmartAccount,
      createAccountOp(e2esmartAccount, network.chainId),
      eoaSigner,
      {
        providerEstimation: {
          gasUsed: 50000n,
          feePaymentOptions
        },
        ambireEstimation: {
          deploymentGas: 0n,
          gasUsed: 50000n,
          feePaymentOptions,
          ambireAccountNonce: 0,
          flags: {}
        },
        flags: {}
      },
      {
        '137': [
          {
            name: 'slow',
            baseFeePerGas: 1000000000n,
            maxPriorityFeePerGas: 1000000000n
          },
          {
            name: 'medium',
            baseFeePerGas: 2000000000n,
            maxPriorityFeePerGas: 2000000000n
          },
          {
            name: 'fast',
            baseFeePerGas: 5000000000n,
            maxPriorityFeePerGas: 5000000000n
          },
          {
            name: 'ape',
            baseFeePerGas: 7000000000n,
            maxPriorityFeePerGas: 7000000000n
          }
        ]
      },
      true
    )
    // @ts-ignore
    controller.update({
      hasNewEstimation: true,
      feeToken: gasTankToken,
      paidBy: e2esmartAccount.addr,
      signingKeyAddr: eoaSigner.keyPublicAddress,
      signingKeyType: 'internal'
    })
    await controller.sign()

    if (!controller.accountOp?.signature) {
      console.log('Signing errors:', controller.errors)
      throw new Error('Signing failed!')
    }
    const typedData = getTypedData(
      network.chainId,
      controller.accountOp.accountAddr,
      hexlify(accountOpSignableHash(controller.accountOp, network.chainId))
    )
    const unwrappedSig = controller.accountOp.signature.slice(0, -2)
    const signerAddr = getAddress(
      recoverTypedSignature({
        data: adaptTypedMessageForMetaMaskSigUtil(typedData),
        signature: unwrappedSig,
        version: SignTypedDataVersion.V4
      })
    )

    // We expect the transaction to be signed with the passed signer address (keyPublicAddress)
    expect(eoaAccount.addr).toEqual(signerAddr)
    // If signing is successful, we expect controller's status to be done
    expect(controller.status).toEqual({ type: 'done' })

    // We expect the fee payment call to be added.
    const abiCoder = new AbiCoder()
    expect(controller.accountOp.feeCall!.to).toEqual(FEE_COLLECTOR)
    expect(controller.accountOp.feeCall!.value).toEqual(0n)
    expect(controller.accountOp.feeCall!.data).toEqual(
      abiCoder.encode(
        ['string', 'uint256', 'string'],
        ['gasTank', controller.accountOp!.gasFeePayment!.amount, 'POL']
      )
    )

    // We expect the signature to be wrapped with an Ambire type. More info: wrapEthSign().
    expect(controller.accountOp?.signature.slice(-2)).toEqual('01')
  })
  test('Signing [SA with EOA payment]: working case + 2 feePaymentOptions but 1 feeSpeed as both feePaymentOptions are EOA', async () => {
    const network = networks.find((n) => n.chainId === 137n)!
    const feePaymentOptions = [
      {
        paidBy: eoaAccount.addr,
        availableAmount: 1000000000000000000n, // 1 POL
        gasUsed: 0n,
        addedNative: 5000n,
        token: {
          address: '0x0000000000000000000000000000000000000000',
          amount: 1n,
          symbol: 'POL',
          name: 'Polygon Ecosystem Token',
          chainId: 137n,
          decimals: 18,
          priceIn: [],
          flags: {
            onGasTank: false,
            rewardsType: null,
            canTopUpGasTank: true,
            isFeeToken: true
          }
        }
      },
      {
        paidBy: trezorEoa.addr,
        availableAmount: 2000000000000000000n, // 1 POL
        gasUsed: 0n,
        addedNative: 5000n,
        token: {
          address: '0x0000000000000000000000000000000000000000',
          amount: 1n,
          symbol: 'POL',
          name: 'Polygon Ecosystem Token',
          chainId: 137n,
          decimals: 18,
          priceIn: [],
          flags: {
            onGasTank: false,
            rewardsType: null,
            canTopUpGasTank: true,
            isFeeToken: true
          }
        }
      },
      {
        paidBy: otherEoa.addr,
        availableAmount: 3000000000000000000n, // 1 POL
        gasUsed: 0n,
        addedNative: 5000n,
        token: {
          address: '0x0000000000000000000000000000000000000000',
          amount: 1n,
          symbol: 'POL',
          name: 'Polygon Ecosystem Token',
          chainId: 137n,
          decimals: 18,
          priceIn: [],
          flags: {
            onGasTank: false,
            rewardsType: null,
            canTopUpGasTank: true,
            isFeeToken: true
          }
        }
      }
    ]
    const { controller } = await init(
      smartAccount,
      createAccountOp(smartAccount, network.chainId),
      eoaSigner,
      {
        providerEstimation: {
          gasUsed: 10000n,
          feePaymentOptions
        },
        ambireEstimation: {
          deploymentGas: 0n,
          gasUsed: 10000n,
          feePaymentOptions,
          ambireAccountNonce: 0,
          flags: {}
        },
        flags: {}
      },
      {
        '137': [
          {
            name: 'slow',
            baseFeePerGas: 100n,
            maxPriorityFeePerGas: 100n
          },
          {
            name: 'medium',
            baseFeePerGas: 200n,
            maxPriorityFeePerGas: 200n
          },
          {
            name: 'fast',
            baseFeePerGas: 300n,
            maxPriorityFeePerGas: 300n
          },
          {
            name: 'ape',
            baseFeePerGas: 400n,
            maxPriorityFeePerGas: 400n
          }
        ]
      }
    )

    controller.update({
      hasNewEstimation: true,
      feeToken: nativeFeeTokenPolygon,
      paidBy: eoaSigner.keyPublicAddress,
      signingKeyAddr: eoaSigner.keyPublicAddress,
      signingKeyType: 'internal'
    })

    expect(controller.estimation.availableFeeOptions.length).toBe(3)
    const firstIdentity = getFeeSpeedIdentifier(
      controller.estimation.availableFeeOptions[0],
      smartAccount.addr,
      null
    )
    const secondIdentity = getFeeSpeedIdentifier(
      controller.estimation.availableFeeOptions[1],
      smartAccount.addr,
      null
    )
    expect(firstIdentity).toBe(secondIdentity)
    expect(Object.keys(controller.feeSpeeds).length).toBe(1)
    expect(controller.feeSpeeds[firstIdentity]).not.toBe(undefined)
    expect(controller.feeSpeeds[firstIdentity].length).toBe(4)

    await controller.sign()

    if (!controller.accountOp?.signature) {
      console.log('Signing errors:', controller.errors)
      throw new Error('Signing failed!')
    }

    expect(controller.accountOp.gasFeePayment!.paidBy).toEqual(eoaSigner.keyPublicAddress)
    expect(controller.accountOp.gasFeePayment!.broadcastOption).toEqual(
      BROADCAST_OPTIONS.byOtherEOA
    )
    expect(controller.accountOp.gasFeePayment!.isGasTank).toEqual(false)
    expect(controller.accountOp.gasFeePayment!.inToken).toEqual(
      '0x0000000000000000000000000000000000000000'
    )
    expect(controller.accountOp.gasFeePayment!.feeTokenChainId).toEqual(137n)
    expect(controller.accountOp.gasFeePayment!.maxPriorityFeePerGas).toEqual(300n)
    expect(controller.accountOp.gasFeePayment!.gasPrice).toEqual(600n)

    const typedData = getTypedData(
      network.chainId,
      controller.accountOp.accountAddr,
      hexlify(accountOpSignableHash(controller.accountOp, network.chainId))
    )
    const unwrappedSig = controller.accountOp.signature.slice(0, -2)
    const signerAddr = getAddress(
      recoverTypedSignature({
        data: adaptTypedMessageForMetaMaskSigUtil(typedData),
        signature: unwrappedSig,
        version: SignTypedDataVersion.V4
      })
    )

    // We expect the transaction to be signed with the passed signer address (keyPublicAddress)
    expect(eoaSigner.keyPublicAddress).toEqual(signerAddr)

    // We expect the signature to be wrapped with an Ambire type. More info: wrapEthSign().
    expect(controller.accountOp?.signature.slice(-2)).toEqual('01')

    // If signing is successful, we expect controller's status to be done
    expect(controller.status).toEqual({ type: 'done' })
  })
})

describe('Negative cases', () => {
  suppressConsoleBeforeEach()

  test('Signing [SA with EOA payment]: not enough funds to cover the fee', async () => {
    const network = networks.find((n) => n.chainId === 137n)!
    const feePaymentOptions = [
      {
        paidBy: eoaAccount.addr,
        availableAmount: 100n, // not enough
        gasUsed: 0n,
        addedNative: 5000n,
        token: {
          address: '0x0000000000000000000000000000000000000000',
          amount: 1n,
          symbol: 'POL',
          name: 'Polygon Ecosystem Token',
          chainId: 137n,
          decimals: 18,
          priceIn: [],
          flags: {
            onGasTank: false,
            rewardsType: null,
            canTopUpGasTank: true,
            isFeeToken: true
          }
        }
      }
    ]
    const { controller } = await init(
      smartAccount,
      createAccountOp(smartAccount, network.chainId),
      eoaSigner,
      {
        providerEstimation: {
          gasUsed: 10000n,
          feePaymentOptions
        },
        ambireEstimation: {
          deploymentGas: 0n,
          gasUsed: 10000n,
          feePaymentOptions,
          ambireAccountNonce: 0,
          flags: {}
        },
        flags: {}
      },
      {
        '137': [
          {
            name: 'slow',
            baseFeePerGas: 100n,
            maxPriorityFeePerGas: 100n
          },
          {
            name: 'medium',
            baseFeePerGas: 200n,
            maxPriorityFeePerGas: 200n
          },
          {
            name: 'fast',
            baseFeePerGas: 300n,
            maxPriorityFeePerGas: 300n
          },
          {
            name: 'ape',
            baseFeePerGas: 400n,
            maxPriorityFeePerGas: 400n
          }
        ]
      }
    )

    controller.update({
      hasNewEstimation: true,
      feeToken: nativeFeeTokenPolygon,
      paidBy: eoaSigner.keyPublicAddress,
      signingKeyAddr: eoaSigner.keyPublicAddress,
      signingKeyType: 'internal'
    })

    const errors = controller.errors
    expect(errors.length).toBe(1)
    expect(errors[0].title).toBe(
      'Insufficient funds to cover the fee. Available fee options: USDC in Gas Tank, POL, WMATIC, WSTETH, WBTC, WETH, DAI, USDT, USDC.E, USDC, RETH, AAVE, LINK and others'
    )
    expect(controller.status?.type).toBe(SigningStatus.UnableToSign)
    await controller.sign()

    expect(controller.signedAccountOp?.signature).toBeFalsy()
  })
})

test('Signing [V1 with EOA payment]: working case', async () => {
  const feePaymentOptions = [
    {
      paidBy: eoaAccount.addr,
      availableAmount: 1000000000000000000n, // 1 ETH
      gasUsed: 0n,
      addedNative: 5000n,
      token: {
        address: '0x0000000000000000000000000000000000000000',
        amount: 1n,
        symbol: 'eth',
        name: 'Ether',
        chainId: 1n,
        decimals: 18,
        priceIn: [],
        flags: {
          onGasTank: false,
          rewardsType: null,
          canTopUpGasTank: true,
          isFeeToken: true
        }
      }
    }
  ]
  const { controller } = await init(
    v1Account,
    createAccountOp(v1Account),
    eoaSigner,
    {
      providerEstimation: {
        gasUsed: 10000n,
        feePaymentOptions
      },
      ambireEstimation: {
        deploymentGas: 0n,
        gasUsed: 10000n,
        feePaymentOptions,
        ambireAccountNonce: 0,
        flags: {}
      },
      flags: {}
    },
    {
      '1': [
        {
          name: 'slow',
          baseFeePerGas: 100n,
          maxPriorityFeePerGas: 100n
        },
        {
          name: 'medium',
          baseFeePerGas: 200n,
          maxPriorityFeePerGas: 200n
        },
        {
          name: 'fast',
          baseFeePerGas: 300n,
          maxPriorityFeePerGas: 300n
        },
        {
          name: 'ape',
          baseFeePerGas: 400n,
          maxPriorityFeePerGas: 400n
        }
      ]
    }
  )

  controller.update({
    hasNewEstimation: true,
    feeToken: nativeFeeToken,
    paidBy: eoaSigner.keyPublicAddress,
    signingKeyAddr: eoaSigner.keyPublicAddress,
    signingKeyType: 'internal'
  })

  await controller.sign()

  if (!controller.accountOp?.signature) {
    console.log('Signing errors:', controller.errors)
    throw new Error('Signing failed!')
  }

  const message = accountOpSignableHash(controller.accountOp, 1n)
  const unwrappedSig = controller.accountOp.signature.slice(0, -2)
  const signerAddr = verifyMessage(message, unwrappedSig)

  // We expect the transaction to be signed with the passed signer address (keyPublicAddress)
  expect(eoaSigner.keyPublicAddress).toEqual(signerAddr)

  // We expect the signature to be wrapped with an Ambire type. More info: wrapEthSign().
  expect(controller.accountOp?.signature.slice(-2)).toEqual('01')

  // If signing is successful, we expect controller's status to be done
  expect(controller.status).toEqual({ type: 'done' })
})

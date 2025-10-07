/* eslint-disable @typescript-eslint/no-floating-promises */

import { AbiCoder, Interface, keccak256, parseEther, toBeHex, Wallet } from 'ethers'
import fetch from 'node-fetch'

import { describe, expect, test } from '@jest/globals'

import AmbireAccount from '../../../contracts/compiled/AmbireAccount.json'
import AmbireFactory from '../../../contracts/compiled/AmbireFactory.json'
import ERC20 from '../../../contracts/compiled/IERC20.json'
import { getAccountsInfo } from '../../../test/helpers'
import { DEFAULT_ACCOUNT_LABEL } from '../../consts/account'
import { FEE_COLLECTOR } from '../../consts/addresses'
import { AMBIRE_ACCOUNT_FACTORY } from '../../consts/deploy'
import { networks } from '../../consts/networks'
import { Account } from '../../interfaces/account'
import { dedicatedToOneSAPriv } from '../../interfaces/keystore'
import { Network } from '../../interfaces/network'
import { getSmartAccount } from '../../libs/account/account'
import { AccountOp, callToTuple, getSignableCalls } from '../../libs/accountOp/accountOp'
import { getPaymasterDataForEstimate } from '../../libs/paymaster/paymaster'
import { getTypedData, wrapStandard } from '../../libs/signMessage/signMessage'
import {
  getActivatorCall,
  getSigForCalculations,
  getUserOperation
} from '../../libs/userOperation/userOperation'
import { getRpcProvider } from '../provider'
import { Biconomy } from './biconomy'
import { Bundler } from './bundler'
import { getDefaultBundler } from './getBundler'
import { Pimlico } from './pimlico'

const to = '0x706431177041C87BEb1C25Fa29b92057Cb3c7089'

const addrWithDeploySignature = '0x52C37FD54BD02E9240e8558e28b11e0Dc22d8e85'
const optimism = networks.find((n) => n.chainId === 10n)!
const arbitrum = networks.find((n) => n.chainId === 42161n)!
const gnosis: Network = {
  name: 'Gnosis',
  nativeAssetSymbol: 'XDAI',
  nativeAssetName: 'XDAI',
  rpcUrls: ['https://invictus.ambire.com/gnosis'],
  selectedRpcUrl: 'https://invictus.ambire.com/gnosis',
  rpcNoStateOverride: true,
  chainId: 100n,
  explorerUrl: 'https://gnosisscan.io',
  erc4337: {
    enabled: false,
    hasPaymaster: false,
    hasBundlerSupport: true
  },
  isSAEnabled: true,
  areContractsDeployed: true,
  hasRelayer: true,
  platformId: 'xdai',
  nativeAssetId: 'xdai',
  hasSingleton: true,
  has7702: false,
  features: [],
  feeOptions: {
    is1559: true,
    feeIncrease: 100n
  },
  predefined: false
}
const baseSepolia: Network = {
  name: 'Base Sepolia',
  nativeAssetSymbol: 'ETH',
  nativeAssetName: 'Ether',
  rpcUrls: ['https://sepolia.base.org'],
  selectedRpcUrl: 'https://sepolia.base.org',
  rpcNoStateOverride: false,
  chainId: 84532n,
  explorerUrl: 'https://gnosisscan.io',
  erc4337: {
    enabled: true,
    hasPaymaster: false,
    hasBundlerSupport: true
  },
  isSAEnabled: true,
  areContractsDeployed: true,
  hasRelayer: false,
  platformId: '',
  nativeAssetId: '',
  hasSingleton: true,
  features: [],
  has7702: false,
  feeOptions: {
    is1559: true
  },
  predefined: false
}

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

const smartAccDeployedOnGnosisButNo4337: Account = {
  addr: '0xae376B42699fDB0D80e9ceE068A4f75ae6d70d85',
  initialPrivileges: [
    [
      '0xD5Cdb05Df16FB0f84a02ebff3405f80e441d7D57',
      '0x0000000000000000000000000000000000000000000000000000000000000002'
    ]
  ],
  creation: {
    factoryAddr: AMBIRE_ACCOUNT_FACTORY,
    bytecode:
      '0x7f00000000000000000000000000000000000000000000000000000000000000027fa85abbdf4f476f0727ae1450f282935c0d57708ae82c281b3fa758db2e21c89b553d602d80604d3d3981f3363d3d373d3d3d363d730f2aa7bcda3d9d210df69a394b6965cb2566c8285af43d82803e903d91602b57fd5bf3',
    salt: '0x0000000000000000000000000000000000000000000000000000000000000000'
  },
  associatedKeys: ['0xD5Cdb05Df16FB0f84a02ebff3405f80e441d7D57'],
  preferences: {
    label: DEFAULT_ACCOUNT_LABEL,
    pfp: '0x8E5F6c1F0b134657A546932C3eC9169E1633a39b'
  }
}

const mantle: Network = {
  name: 'mantle',
  nativeAssetSymbol: 'MNT',
  nativeAssetName: 'Mantle',
  rpcUrls: ['https://mantle-rpc.publicnode.com'],
  selectedRpcUrl: 'https://mantle-rpc.publicnode.com',
  rpcNoStateOverride: false,
  chainId: 5000n,
  explorerUrl: 'https://explorer.mantle.xyz',
  erc4337: {
    enabled: true,
    hasPaymaster: false
  },
  isSAEnabled: true,
  areContractsDeployed: true,
  hasRelayer: false,
  has7702: false,
  platformId: 'mantle',
  nativeAssetId: 'mantle',
  hasSingleton: true,
  features: [],
  feeOptions: {
    is1559: true
  },
  predefined: false
}
const base: Network = {
  name: 'base',
  nativeAssetSymbol: 'ETH',
  nativeAssetName: 'Ether',
  rpcUrls: ['https://mainnet.base.org'],
  selectedRpcUrl: 'https://mainnet.base.org',
  rpcNoStateOverride: false,
  chainId: 8453n,
  explorerUrl: 'https://basescan.org/',
  erc4337: {
    enabled: true,
    hasPaymaster: false
  },
  isSAEnabled: true,
  areContractsDeployed: true,
  hasRelayer: false,
  platformId: 'base',
  has7702: false,
  nativeAssetId: 'base',
  hasSingleton: true,
  features: [],
  feeOptions: {
    is1559: true
  },
  predefined: false
}

const smartAccNew: Account = {
  addr: '0x0a83DB1C54D6CbD7d23BbcB504C7a9E36A6c9038',
  initialPrivileges: [
    [
      '0xC85cc4127a6E7fcFcab66BA36198c9aD4Ee54E61',
      '0x0000000000000000000000000000000000000000000000000000000000000002'
    ]
  ],
  creation: {
    factoryAddr: AMBIRE_ACCOUNT_FACTORY,
    bytecode:
      '0x7f00000000000000000000000000000000000000000000000000000000000000027f2d17cfd8161c7b1377884dafe009bcbff53a4255916f43e68b6debb84d22e8d3553d602d80604d3d3981f3363d3d373d3d3d363d730f2aa7bcda3d9d210df69a394b6965cb2566c8285af43d82803e903d91602b57fd5bf3',
    salt: '0x0000000000000000000000000000000000000000000000000000000000000000'
  },
  associatedKeys: ['0xC85cc4127a6E7fcFcab66BA36198c9aD4Ee54E61'],
  preferences: {
    label: DEFAULT_ACCOUNT_LABEL,
    pfp: '0x0a83DB1C54D6CbD7d23BbcB504C7a9E36A6c9038'
  }
}

export async function getDeploySignature(smartAcc: Account, network: Network) {
  // CODE FOR getting a valid deploy signature if you have the PK
  const nonce = 0
  const call = getActivatorCall(smartAcc.addr)
  const tupleCall = callToTuple(call)
  const txns = [tupleCall]
  const abiCoder = new AbiCoder()
  const executeHash = keccak256(
    abiCoder.encode(
      ['address', 'uint', 'uint', 'tuple(address, uint, bytes)[]'],
      [smartAcc.addr, network.chainId, nonce, txns]
    )
  )
  const typedData = getTypedData(network.chainId, smartAcc.addr, executeHash)
  const wallet = new Wallet(process.env.METAMASK_PK!)
  const s = wrapStandard(
    await wallet.signTypedData(typedData.domain, typedData.types, typedData.message)
  )
  return s
}

describe('Bundler tests', () => {
  describe('Basic tests', () => {
    test('should check if the network is supported by the bundler', async () => {
      // it supports mantle
      const mantleShouldBeSupported = await Bundler.isNetworkSupported(fetch, 5000n)
      expect(mantleShouldBeSupported).toBe(true)
      // it doesn't support filecoin
      const filecoinShouldNotBeSupported = await Bundler.isNetworkSupported(fetch, 134n)
      expect(filecoinShouldNotBeSupported).toBe(false)
    })
  })
  describe('Estimation tests: arbitrum, biconomy, undeployed account', () => {
    test('should estimate a deploy userOp', async () => {
      const opArb: AccountOp = {
        accountAddr: smartAccNew.addr,
        signingKeyAddr: smartAccNew.associatedKeys[0],
        signingKeyType: null,
        gasLimit: null,
        gasFeePayment: null,
        chainId: arbitrum.chainId,
        nonce: 0n,
        signature: '0x',
        calls: [{ to, value: 10000000000000n, data: '0x' }],
        accountOpToExecuteBefore: null
      }
      const usedNetworks = [arbitrum]
      const providers = {
        [arbitrum.chainId.toString()]: getRpcProvider(arbitrum.rpcUrls, arbitrum.chainId)
      }
      const accountStates = await getAccountsInfo(usedNetworks, providers, [smartAccNew])
      const accountState = accountStates[opArb.accountAddr][opArb.chainId.toString()]
      const bundler = new Biconomy()
      const userOp = getUserOperation(
        smartAccNew,
        accountState,
        opArb,
        bundler.getName(),
        '0x279e2ba17426b50fff124d445629f57b95f59a0a73613a924a1d205d53b67ae44bd5f1f4ae336e1edf396693c22f1d05793d984f7515c691b54b82178364dc911c01'
      )
      const ambireInterface = new Interface(AmbireAccount.abi)
      userOp.callData = ambireInterface.encodeFunctionData('executeBySender', [
        getSignableCalls(opArb)
      ])
      const paymasterAndData = getPaymasterDataForEstimate()
      userOp.paymaster = paymasterAndData.paymaster
      userOp.paymasterVerificationGasLimit = toBeHex(100000)
      userOp.paymasterPostOpGasLimit = toBeHex(0)
      userOp.paymasterData = paymasterAndData.paymasterData
      userOp.nonce = toBeHex(0)
      userOp.signature = getSigForCalculations()
      const bundlerEstimate = await bundler.estimate(userOp, arbitrum)
      expect(bundlerEstimate).toHaveProperty('preVerificationGas')
      expect(bundlerEstimate).toHaveProperty('verificationGasLimit')
      expect(bundlerEstimate).toHaveProperty('callGasLimit')
      expect(bundlerEstimate).toHaveProperty('paymasterVerificationGasLimit')
      expect(bundlerEstimate).toHaveProperty('paymasterPostOpGasLimit')
    })
    test('should fails as the call is not from the entry point with a generic server response 400 Bad Request', async () => {
      expect.assertions(1)
      const opArb: AccountOp = {
        accountAddr: smartAccNew.addr,
        signingKeyAddr: smartAccNew.associatedKeys[0],
        signingKeyType: null,
        gasLimit: null,
        gasFeePayment: null,
        chainId: arbitrum.chainId,
        nonce: 0n,
        signature: '0x',
        calls: [{ to, value: 1n, data: '0x' }],
        accountOpToExecuteBefore: null
      }
      const usedNetworks = [arbitrum]
      const providers = {
        [arbitrum.chainId.toString()]: getRpcProvider(arbitrum.rpcUrls, arbitrum.chainId)
      }
      const accountStates = await getAccountsInfo(usedNetworks, providers, [smartAccNew])
      const accountState = accountStates[opArb.accountAddr][opArb.chainId.toString()]
      const bundler = new Biconomy()
      const userOp = getUserOperation(
        smartAccNew,
        accountState,
        opArb,
        bundler.getName(),
        '0x279e2ba17426b50fff124d445629f57b95f59a0a73613a924a1d205d53b67ae44bd5f1f4ae336e1edf396693c22f1d05793d984f7515c691b54b82178364dc911c01'
      )
      const ambireInterface = new Interface(AmbireAccount.abi)
      userOp.callData = ambireInterface.encodeFunctionData('executeBySender', [
        getSignableCalls(opArb)
      ])
      const paymasterAndData = getPaymasterDataForEstimate()
      userOp.paymaster = paymasterAndData.paymaster
      userOp.paymasterData = paymasterAndData.paymasterData
      userOp.nonce = toBeHex(0)
      userOp.signature = getSigForCalculations()
      // override the factoryData so it deploy without entry point privs
      const factoryInterface = new Interface(AmbireFactory.abi)
      userOp.factoryData = factoryInterface.encodeFunctionData('deploy', [
        smartAccNew.creation!.bytecode,
        smartAccNew.creation!.salt
      ])
      try {
        await bundler.estimate(userOp, arbitrum)
      } catch (e: any) {
        expect(e.message.indexOf('server response 400 Bad Request')).not.toBe(-1)
      }
    })
    test.skip('should revert because we are trying to send USDT and the account does not have USDT with a generic server response 400 Bad Request', async () => {
      expect.assertions(1)
      const ERC20Interface = new Interface(ERC20.abi)
      const opArb: AccountOp = {
        accountAddr: smartAccNew.addr,
        signingKeyAddr: smartAccNew.associatedKeys[0],
        signingKeyType: null,
        gasLimit: null,
        gasFeePayment: null,
        chainId: arbitrum.chainId,
        nonce: 0n,
        signature: '0x',
        calls: [
          // native, passes
          { to, value: 1n, data: '0x' },
          // USDT, reverts
          {
            to: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
            value: 0n,
            data: ERC20Interface.encodeFunctionData('transfer', [FEE_COLLECTOR, 10])
          }
        ],
        accountOpToExecuteBefore: null
      }
      const usedNetworks = [arbitrum]
      const providers = {
        [arbitrum.chainId.toString()]: getRpcProvider(arbitrum.rpcUrls, arbitrum.chainId)
      }
      const accountStates = await getAccountsInfo(usedNetworks, providers, [smartAccNew])
      const accountState = accountStates[opArb.accountAddr][opArb.chainId.toString()]
      const bundler = new Biconomy()
      const userOp = getUserOperation(
        smartAccNew,
        accountState,
        opArb,
        bundler.getName(),
        '0x279e2ba17426b50fff124d445629f57b95f59a0a73613a924a1d205d53b67ae44bd5f1f4ae336e1edf396693c22f1d05793d984f7515c691b54b82178364dc911c01'
      )
      const ambireInterface = new Interface(AmbireAccount.abi)
      userOp.callData = ambireInterface.encodeFunctionData('executeBySender', [
        getSignableCalls(opArb)
      ])
      const paymasterAndData = getPaymasterDataForEstimate()
      userOp.paymaster = paymasterAndData.paymaster
      userOp.paymasterData = paymasterAndData.paymasterData
      userOp.nonce = toBeHex(0)
      userOp.signature = getSigForCalculations()
      try {
        await bundler.estimate(userOp, arbitrum)
      } catch (e: any) {
        expect(e.message.indexOf('server response 400 Bad Request')).not.toBe(-1)
      }
    })
  })
  describe('Estimation tests: optimism, pimlico, undeployed account', () => {
    test('should estimate a deploy userOp', async () => {
      const privs = [
        {
          addr: addrWithDeploySignature,
          hash: dedicatedToOneSAPriv
        }
      ]
      const smartAcc = await getSmartAccount(privs, [])
      const opOptimism: AccountOp = {
        accountAddr: smartAcc.addr,
        signingKeyAddr: smartAcc.associatedKeys[0],
        signingKeyType: null,
        gasLimit: null,
        gasFeePayment: null,
        chainId: optimism.chainId,
        nonce: 0n,
        signature: '0x',
        calls: [{ to, value: 1n, data: '0x' }],
        accountOpToExecuteBefore: null
      }
      const usedNetworks = [optimism]
      const providers = {
        [optimism.chainId.toString()]: getRpcProvider(optimism.rpcUrls, optimism.chainId)
      }
      const accountStates = await getAccountsInfo(usedNetworks, providers, [smartAcc])
      const accountState = accountStates[opOptimism.accountAddr][opOptimism.chainId.toString()]
      const bundler = new Pimlico() // use pimlico for these tests
      const userOp = getUserOperation(
        smartAcc,
        accountState,
        opOptimism,
        bundler.getName(),
        '0x05404ea5dfa13ddd921cda3f587af6927cc127ee174b57c9891491bfc1f0d3d005f649f8a1fc9147405f064507bae08816638cfc441c4d0dc4eb6640e16621991b01'
      )
      const ambireInterface = new Interface(AmbireAccount.abi)
      userOp.callData = ambireInterface.encodeFunctionData('executeBySender', [
        getSignableCalls(opOptimism)
      ])
      const paymasterAndData = getPaymasterDataForEstimate()
      userOp.paymaster = paymasterAndData.paymaster
      userOp.paymasterVerificationGasLimit = toBeHex(100000)
      userOp.paymasterPostOpGasLimit = toBeHex(0)
      userOp.paymasterData = paymasterAndData.paymasterData
      userOp.nonce = toBeHex(0)
      userOp.signature = getSigForCalculations()
      try {
        const bundlerEstimate = await bundler.estimate(userOp, optimism)
        expect(bundlerEstimate).toHaveProperty('preVerificationGas')
        expect(bundlerEstimate).toHaveProperty('verificationGasLimit')
        expect(bundlerEstimate).toHaveProperty('callGasLimit')
        expect(bundlerEstimate).toHaveProperty('paymasterVerificationGasLimit')
        expect(bundlerEstimate).toHaveProperty('paymasterPostOpGasLimit')
      } catch (e: any) {
        console.log(e)
      }
    })
    test('should return an error that the call is not from the entry point', async () => {
      expect.assertions(1)
      const privs = [
        {
          addr: addrWithDeploySignature,
          hash: dedicatedToOneSAPriv
        }
      ]
      const smartAcc = await getSmartAccount(privs, [])
      const opOptimism: AccountOp = {
        accountAddr: smartAcc.addr,
        signingKeyAddr: smartAcc.associatedKeys[0],
        signingKeyType: null,
        gasLimit: null,
        gasFeePayment: null,
        chainId: optimism.chainId,
        nonce: 0n,
        signature: '0x',
        calls: [{ to, value: 1n, data: '0x' }],
        accountOpToExecuteBefore: null
      }
      const usedNetworks = [optimism]
      const providers = {
        [optimism.chainId.toString()]: getRpcProvider(optimism.rpcUrls, optimism.chainId)
      }
      const accountStates = await getAccountsInfo(usedNetworks, providers, [smartAcc])
      const accountState = accountStates[opOptimism.accountAddr][opOptimism.chainId.toString()]
      const bundler = new Pimlico()
      const userOp = getUserOperation(
        smartAcc,
        accountState,
        opOptimism,
        bundler.getName(),
        '0x05404ea5dfa13ddd921cda3f587af6927cc127ee174b57c9891491bfc1f0d3d005f649f8a1fc9147405f064507bae08816638cfc441c4d0dc4eb6640e16621991b01'
      )
      const ambireInterface = new Interface(AmbireAccount.abi)
      userOp.callData = ambireInterface.encodeFunctionData('executeBySender', [
        getSignableCalls(opOptimism)
      ])
      const paymasterAndData = getPaymasterDataForEstimate()
      userOp.paymaster = paymasterAndData.paymaster
      userOp.paymasterData = paymasterAndData.paymasterData
      userOp.nonce = toBeHex(0)
      userOp.signature = getSigForCalculations()
      // override the factoryData so it deploy without entry point privs
      const factoryInterface = new Interface(AmbireFactory.abi)
      userOp.factoryData = factoryInterface.encodeFunctionData('deploy', [
        smartAcc.creation!.bytecode,
        smartAcc.creation!.salt
      ])
      try {
        await bundler.estimate(userOp, optimism)
      } catch (e: any) {
        expect(e.error.message.indexOf('validateUserOp: not from entryPoint')).not.toBe(-1)
      }
    })
    test.skip('should revert because we are trying to send USDT and the account does not have USDT', async () => {
      expect.assertions(1)
      const privs = [
        {
          addr: addrWithDeploySignature,
          hash: dedicatedToOneSAPriv
        }
      ]
      const smartAcc = await getSmartAccount(privs, [])
      const ERC20Interface = new Interface(ERC20.abi)
      const opOptimism: AccountOp = {
        accountAddr: smartAcc.addr,
        signingKeyAddr: smartAcc.associatedKeys[0],
        signingKeyType: null,
        gasLimit: null,
        gasFeePayment: null,
        chainId: optimism.chainId,
        nonce: 0n,
        signature: '0x',
        calls: [
          // native, passes even though no eth
          { to, value: parseEther('10'), data: '0x' },
          // USDT, reverts
          {
            to: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
            value: 0n,
            data: ERC20Interface.encodeFunctionData('transfer', [FEE_COLLECTOR, 10])
          }
        ],
        accountOpToExecuteBefore: null
      }
      const usedNetworks = [optimism]
      const providers = {
        [optimism.chainId.toString()]: getRpcProvider(optimism.rpcUrls, optimism.chainId)
      }
      const accountStates = await getAccountsInfo(usedNetworks, providers, [smartAcc])
      const accountState = accountStates[opOptimism.accountAddr][opOptimism.chainId.toString()]
      const bundler = new Pimlico()
      const userOp = getUserOperation(
        smartAcc,
        accountState,
        opOptimism,
        bundler.getName(),
        '0x05404ea5dfa13ddd921cda3f587af6927cc127ee174b57c9891491bfc1f0d3d005f649f8a1fc9147405f064507bae08816638cfc441c4d0dc4eb6640e16621991b01'
      )
      const ambireInterface = new Interface(AmbireAccount.abi)
      userOp.callData = ambireInterface.encodeFunctionData('executeBySender', [
        getSignableCalls(opOptimism)
      ])
      const paymasterAndData = getPaymasterDataForEstimate()
      userOp.paymaster = paymasterAndData.paymaster
      userOp.paymasterData = paymasterAndData.paymasterData
      userOp.nonce = toBeHex(0)
      userOp.signature = getSigForCalculations()
      try {
        await bundler.estimate(userOp, optimism)
      } catch (e: any) {
        const buffer = Buffer.from(
          e.error.message.substring(e.error.message.indexOf('0x') + 2),
          'hex'
        ).toString()
        expect(buffer.indexOf('transfer amount exceeds balance')).not.toBe(-1)
      }
    })
  })
  describe('Estimation tests: gnosis/baseSepolia, deployed account with no erc-4337', () => {
    // NOTE: we no longer do this
    test.skip('should estimate successfully because of state override on base sepolia', async () => {
      const opBaseSepolia: AccountOp = {
        accountAddr: smartAccDeployedOnGnosisButNo4337.addr,
        signingKeyAddr: smartAccDeployedOnGnosisButNo4337.associatedKeys[0],
        signingKeyType: null,
        gasLimit: null,
        gasFeePayment: null,
        chainId: 84532n,
        nonce: 0n,
        signature: '0x',
        calls: [{ to, value: 1n, data: '0x' }],
        accountOpToExecuteBefore: null
      }
      const usedNetworks = [baseSepolia]
      const providers = {
        [baseSepolia.chainId.toString()]: getRpcProvider(baseSepolia.rpcUrls, baseSepolia.chainId)
      }
      const accountStates = await getAccountsInfo(usedNetworks, providers, [
        smartAccDeployedOnGnosisButNo4337
      ])
      const accountState =
        accountStates[opBaseSepolia.accountAddr][opBaseSepolia.chainId.toString()]
      const bundler = getDefaultBundler(baseSepolia)
      const userOp = getUserOperation(
        smartAccDeployedOnGnosisButNo4337,
        accountState,
        opBaseSepolia,
        bundler.getName()
      )
      const ambireInterface = new Interface(AmbireAccount.abi)
      userOp.callData = ambireInterface.encodeFunctionData('executeBySender', [
        getSignableCalls(opBaseSepolia)
      ])
      const paymasterAndData = getPaymasterDataForEstimate()
      userOp.paymaster = paymasterAndData.paymaster
      userOp.paymasterData = paymasterAndData.paymasterData
      userOp.signature = getSigForCalculations()
      userOp.nonce = '0x0'
      const bundlerEstimate = await bundler.estimate(userOp, baseSepolia)
      expect(bundlerEstimate).toHaveProperty('preVerificationGas')
      expect(bundlerEstimate).toHaveProperty('verificationGasLimit')
      expect(bundlerEstimate).toHaveProperty('callGasLimit')
      expect(bundlerEstimate).toHaveProperty('paymasterVerificationGasLimit')
      expect(bundlerEstimate).toHaveProperty('paymasterPostOpGasLimit')
    })
    test('should revert on gnosis as it does not support state override', async () => {
      const opGnosis: AccountOp = {
        accountAddr: smartAccDeployedOnGnosisButNo4337.addr,
        signingKeyAddr: smartAccDeployedOnGnosisButNo4337.associatedKeys[0],
        signingKeyType: null,
        gasLimit: null,
        gasFeePayment: null,
        chainId: 100n,
        nonce: 0n,
        signature: '0x',
        calls: [{ to, value: 1n, data: '0x' }],
        accountOpToExecuteBefore: null
      }
      const usedNetworks = [gnosis]
      const providers = {
        [gnosis.chainId.toString()]: getRpcProvider(gnosis.rpcUrls, gnosis.chainId)
      }
      const accountStates = await getAccountsInfo(usedNetworks, providers, [
        smartAccDeployedOnGnosisButNo4337
      ])
      const accountState = accountStates[opGnosis.accountAddr][opGnosis.chainId.toString()]
      const bundler = getDefaultBundler(gnosis)
      const userOp = getUserOperation(
        smartAccDeployedOnGnosisButNo4337,
        accountState,
        opGnosis,
        bundler.getName()
      )
      const ambireInterface = new Interface(AmbireAccount.abi)
      userOp.callData = ambireInterface.encodeFunctionData('executeBySender', [
        getSignableCalls(opGnosis)
      ])
      const paymasterAndData = getPaymasterDataForEstimate()
      userOp.paymaster = paymasterAndData.paymaster
      userOp.paymasterData = paymasterAndData.paymasterData
      userOp.signature = getSigForCalculations()
      userOp.nonce = '0x0'
      try {
        await bundler.estimate(userOp, gnosis)
        expect(true).toBe(false)
      } catch (e: any) {
        expect(e.message.includes('AA23 reverted validateUserOp: not from entryPoint')).not.toBe(-1)
      }
    })
  })
  describe('Estimation tests: mantle, undeployed account', () => {
    test.skip('should estimate a deploy userOp', async () => {
      const privs = [
        {
          addr: addrWithDeploySignature,
          hash: dedicatedToOneSAPriv
        }
      ]
      const smartAcc = await getSmartAccount(privs, [])
      const opMantle: AccountOp = {
        accountAddr: smartAcc.addr,
        signingKeyAddr: smartAcc.associatedKeys[0],
        signingKeyType: null,
        gasLimit: null,
        gasFeePayment: null,
        chainId: mantle.chainId,
        nonce: 0n,
        signature: '0x',
        calls: [{ to, value: 1n, data: '0x' }],
        accountOpToExecuteBefore: null
      }
      const usedNetworks = [mantle]
      const providers = {
        [mantle.chainId.toString()]: getRpcProvider(mantle.rpcUrls, mantle.chainId)
      }
      const accountStates = await getAccountsInfo(usedNetworks, providers, [smartAcc])
      const accountState = accountStates[opMantle.accountAddr][opMantle.chainId.toString()]
      const bundler = getDefaultBundler(mantle)
      const userOp = getUserOperation(
        smartAcc,
        accountState,
        opMantle,
        bundler.getName(),
        '0x38d93f334162dbbbf5115b6a73051426663be3083e698ec89f6db4dc520e8029531bbe508ba2461401fb2f39d9cab723c8b1b5e85cd15841cad6615b7107ae351b01'
      )
      const ambireInterface = new Interface(AmbireAccount.abi)
      userOp.callData = ambireInterface.encodeFunctionData('executeBySender', [
        getSignableCalls(opMantle)
      ])
      userOp.nonce = toBeHex(0)
      userOp.signature = getSigForCalculations()
      const bundlerEstimate = await bundler.estimate(userOp, mantle)
      expect(bundlerEstimate).toHaveProperty('preVerificationGas')
      expect(bundlerEstimate).toHaveProperty('verificationGasLimit')
      expect(bundlerEstimate).toHaveProperty('callGasLimit')
      expect(bundlerEstimate).toHaveProperty('paymasterVerificationGasLimit')
      expect(bundlerEstimate).toHaveProperty('paymasterPostOpGasLimit')
    })
    test.skip('should revert because we are trying to send USDT and the account does not have USDT', async () => {
      expect.assertions(1)
      const privs = [
        {
          addr: addrWithDeploySignature,
          hash: dedicatedToOneSAPriv
        }
      ]
      const smartAcc = await getSmartAccount(privs, [])
      const ERC20Interface = new Interface(ERC20.abi)
      const opMantle: AccountOp = {
        accountAddr: smartAcc.addr,
        signingKeyAddr: smartAcc.associatedKeys[0],
        signingKeyType: null,
        gasLimit: null,
        gasFeePayment: null,
        chainId: mantle.chainId,
        nonce: 0n,
        signature: '0x',
        calls: [
          { to, value: 1n, data: '0x' },
          // USDT, reverts
          {
            to: '0x201eba5cc46d216ce6dc03f6a759e8e766e956ae',
            value: 0n,
            data: ERC20Interface.encodeFunctionData('transfer', [FEE_COLLECTOR, 10])
          }
        ],
        accountOpToExecuteBefore: null
      }
      const usedNetworks = [mantle]
      const providers = {
        [mantle.chainId.toString()]: getRpcProvider(mantle.rpcUrls, mantle.chainId)
      }
      const accountStates = await getAccountsInfo(usedNetworks, providers, [smartAcc])
      const accountState = accountStates[opMantle.accountAddr][opMantle.chainId.toString()]
      const bundler = getDefaultBundler(mantle)
      const userOp = getUserOperation(
        smartAcc,
        accountState,
        opMantle,
        bundler.getName(),
        '0x38d93f334162dbbbf5115b6a73051426663be3083e698ec89f6db4dc520e8029531bbe508ba2461401fb2f39d9cab723c8b1b5e85cd15841cad6615b7107ae351b01'
      )
      const ambireInterface = new Interface(AmbireAccount.abi)
      userOp.callData = ambireInterface.encodeFunctionData('executeBySender', [
        getSignableCalls(opMantle)
      ])
      const paymasterAndData = getPaymasterDataForEstimate()
      userOp.paymaster = paymasterAndData.paymaster
      userOp.paymasterData = paymasterAndData.paymasterData
      userOp.nonce = toBeHex(0)
      userOp.signature = getSigForCalculations()
      try {
        await bundler.estimate(userOp, mantle)
      } catch (e: any) {
        const buffer = Buffer.from(
          e.error.message.substring(e.error.message.indexOf('0x') + 2),
          'hex'
        ).toString()
        expect(buffer.indexOf('transfer amount exceeds balance')).not.toBe(-1)
      }
    })
  })
  describe('Estimation tests: base, undeployed account', () => {
    test('should return an error that the call is not from the entry point', async () => {
      expect.assertions(1)
      const privs = [
        {
          addr: addrWithDeploySignature,
          hash: dedicatedToOneSAPriv
        }
      ]
      const smartAcc = await getSmartAccount(privs, [])
      const opBase: AccountOp = {
        accountAddr: smartAcc.addr,
        signingKeyAddr: smartAcc.associatedKeys[0],
        signingKeyType: null,
        gasLimit: null,
        gasFeePayment: null,
        chainId: base.chainId,
        nonce: 0n,
        signature: '0x',
        calls: [{ to, value: 1n, data: '0x' }],
        accountOpToExecuteBefore: null
      }
      const usedNetworks = [base]
      const providers = {
        [base.chainId.toString()]: getRpcProvider(base.rpcUrls, base.chainId)
      }
      const accountStates = await getAccountsInfo(usedNetworks, providers, [smartAcc])
      const accountState = accountStates[opBase.accountAddr][opBase.chainId.toString()]
      const bundler = getDefaultBundler(mantle)
      const userOp = getUserOperation(
        smartAcc,
        accountState,
        opBase,
        bundler.getName(),
        '0x05404ea5dfa13ddd921cda3f587af6927cc127ee174b57c9891491bfc1f0d3d005f649f8a1fc9147405f064507bae08816638cfc441c4d0dc4eb6640e16621991b01'
      )
      const ambireInterface = new Interface(AmbireAccount.abi)
      userOp.callData = ambireInterface.encodeFunctionData('executeBySender', [
        getSignableCalls(opBase)
      ])
      const paymasterAndData = getPaymasterDataForEstimate()
      userOp.paymaster = paymasterAndData.paymaster
      userOp.paymasterData = paymasterAndData.paymasterData
      userOp.nonce = toBeHex(0)
      userOp.signature = getSigForCalculations()
      // override the factoryData so it deploy without entry point privs
      const factoryInterface = new Interface(AmbireFactory.abi)
      userOp.factoryData = factoryInterface.encodeFunctionData('deploy', [
        smartAcc.creation!.bytecode,
        smartAcc.creation!.salt
      ])
      try {
        await bundler.estimate(userOp, base)
      } catch (e: any) {
        expect(e.error.message.indexOf('validateUserOp: not from entryPoint')).not.toBe(-1)
      }
    })
  })
  describe('Estimation tests: base, deployed account', () => {
    test('should estimate successfully', async () => {
      const opBase: AccountOp = {
        accountAddr: smartAccDeployed.addr,
        signingKeyAddr: smartAccDeployed.associatedKeys[0],
        signingKeyType: null,
        gasLimit: null,
        gasFeePayment: null,
        chainId: 8453n,
        nonce: 0n,
        signature: '0x',
        calls: [{ to, value: parseEther('1'), data: '0x' }],
        accountOpToExecuteBefore: null
      }
      const usedNetworks = [base]
      const providers = {
        [base.chainId.toString()]: getRpcProvider(base.rpcUrls, base.chainId)
      }
      const accountStates = await getAccountsInfo(usedNetworks, providers, [smartAccDeployed])
      const accountState = accountStates[opBase.accountAddr][opBase.chainId.toString()]
      const bundler = getDefaultBundler(base)
      const userOp = getUserOperation(smartAccDeployed, accountState, opBase, bundler.getName())
      const ambireInterface = new Interface(AmbireAccount.abi)
      userOp.callData = ambireInterface.encodeFunctionData('executeBySender', [
        getSignableCalls(opBase)
      ])
      userOp.signature = getSigForCalculations()
      const bundlerEstimate = await bundler.estimate(userOp, base)
      expect(bundlerEstimate).toHaveProperty('preVerificationGas')
      expect(bundlerEstimate).toHaveProperty('verificationGasLimit')
      expect(bundlerEstimate).toHaveProperty('callGasLimit')
      expect(bundlerEstimate).toHaveProperty('paymasterVerificationGasLimit')
      expect(bundlerEstimate).toHaveProperty('paymasterPostOpGasLimit')
    })
  })
})

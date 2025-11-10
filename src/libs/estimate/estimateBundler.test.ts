/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable max-classes-per-file */
/* eslint-disable @typescript-eslint/no-unused-vars */

import { parseEther } from 'ethers'
import fetch from 'node-fetch'

import { describe, expect, test } from '@jest/globals'

import { relayerUrl } from '../../../test/config'
import { getAccountsInfo } from '../../../test/helpers'
import { DEFAULT_ACCOUNT_LABEL } from '../../consts/account'
import { BUNDLER, PIMLICO } from '../../consts/bundlers'
import { AMBIRE_ACCOUNT_FACTORY } from '../../consts/deploy'
import { networks } from '../../consts/networks'
import { Account } from '../../interfaces/account'
import { dedicatedToOneSAPriv } from '../../interfaces/keystore'
import { Network } from '../../interfaces/network'
import { BundlerSwitcher } from '../../services/bundlers/bundlerSwitcher'
import { Pimlico } from '../../services/bundlers/pimlico'
import { paymasterFactory } from '../../services/paymaster'
import { getRpcProvider } from '../../services/provider'
import { getSmartAccount } from '../account/account'
import { getBaseAccount } from '../account/getBaseAccount'
import { AccountOp } from '../accountOp/accountOp'
import { UserOperation } from '../userOperation/types'
import { bundlerEstimate } from './estimateBundler'
import { BundlerEstimateResult, Erc4337GasLimits } from './interfaces'

const to = '0x06564FA10c67427a187f90703fD094054f8F0408'

const addrWithDeploySignature = '0x52C37FD54BD02E9240e8558e28b11e0Dc22d8e85'
const optimism = networks.find((n) => n.chainId === 10n)!
const base = networks.find((n) => n.chainId === 8453n)!

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

const areUpdatesForbidden = () => {
  return null
}

paymasterFactory.init(relayerUrl, fetch, () => {})
const errorCallback = () => {}

describe('Bundler estimation tests', () => {
  describe('Estimation tests: optimism, undeployed', () => {
    test('should estimate an userOp', async () => {
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
        calls: [
          // native passes even though native balance is below 10
          { to, value: parseEther('10'), data: '0x' }
        ],
        accountOpToExecuteBefore: null,
        meta: {
          entryPointAuthorization:
            '0x05404ea5dfa13ddd921cda3f587af6927cc127ee174b57c9891491bfc1f0d3d005f649f8a1fc9147405f064507bae08816638cfc441c4d0dc4eb6640e16621991b01'
        }
      }
      const usedNetworks = [optimism]
      const providers = {
        [optimism.chainId.toString()]: getRpcProvider(optimism)
      }
      const accountStates = await getAccountsInfo(usedNetworks, providers, [smartAcc])

      // if the user cannot pay in the fee token, it will revert
      const feeTokens = [
        {
          address: '0x0000000000000000000000000000000000000000',
          amount: 100n,
          symbol: 'ETH',
          name: 'Ether',
          chainId: 10n,
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
      const switcher = new BundlerSwitcher(optimism, areUpdatesForbidden)
      const accountState = accountStates[smartAcc.addr][optimism.chainId.toString()]
      const baseAcc = getBaseAccount(smartAcc, accountState, [], optimism)
      const result = await bundlerEstimate(
        baseAcc,
        accountState,
        opOptimism,
        optimism,
        feeTokens,
        providers[optimism.chainId.toString()],
        switcher,
        errorCallback
      )

      expect(result instanceof Error).toBe(false)
      const bundlerEstimation = result as Erc4337GasLimits
      expect(BigInt(bundlerEstimation.callGasLimit)).toBeGreaterThan(0n)
      expect(BigInt(bundlerEstimation.preVerificationGas)).toBeGreaterThan(0n)
      expect(BigInt(bundlerEstimation.verificationGasLimit)).toBeGreaterThan(0n)
      expect(BigInt(bundlerEstimation.paymasterPostOpGasLimit)).toBeGreaterThan(0n)
      expect(BigInt(bundlerEstimation.paymasterVerificationGasLimit)).toBeGreaterThan(0n)
    })
  })

  describe('Estimation tests: optimism, deployed', () => {
    test('should estimate a valid userOp', async () => {
      const opOptimism: AccountOp = {
        accountAddr: smartAccDeployed.addr,
        signingKeyAddr: smartAccDeployed.associatedKeys[0],
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
        [optimism.chainId.toString()]: getRpcProvider(optimism)
      }
      const accountStates = await getAccountsInfo(usedNetworks, providers, [smartAccDeployed])

      // if the user cannot pay in the fee token, it will revert
      const feeTokens = [
        {
          address: '0x0000000000000000000000000000000000000000',
          amount: 100n,
          symbol: 'ETH',
          name: 'Ether',
          chainId: 10n,
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
      const switcher = new BundlerSwitcher(optimism, areUpdatesForbidden)
      const accountState = accountStates[smartAccDeployed.addr][optimism.chainId.toString()]
      const baseAcc = getBaseAccount(smartAccDeployed, accountState, [], optimism)
      const result = await bundlerEstimate(
        baseAcc,
        accountState,
        opOptimism,
        optimism,
        feeTokens,
        providers[optimism.chainId.toString()],
        switcher,
        errorCallback
      )

      expect(result instanceof Error).toBe(false)
      const bundlerEstimation = result as Erc4337GasLimits
      expect(BigInt(bundlerEstimation.callGasLimit)).toBeGreaterThan(0n)
      expect(BigInt(bundlerEstimation.preVerificationGas)).toBeGreaterThan(0n)
      expect(BigInt(bundlerEstimation.verificationGasLimit)).toBeGreaterThan(0n)
      expect(BigInt(bundlerEstimation.paymasterPostOpGasLimit)).toBeGreaterThan(0n)
      expect(BigInt(bundlerEstimation.paymasterVerificationGasLimit)).toBeGreaterThan(0n)
    })
    test('should try to estimate an userOp with Biconomy by sending more ETH than the account has which is not allowed and should trigger reestimate by Pimlico who will allow it to pass', async () => {
      const opOptimism: AccountOp = {
        accountAddr: smartAccDeployed.addr,
        signingKeyAddr: smartAccDeployed.associatedKeys[0],
        signingKeyType: null,
        gasLimit: null,
        gasFeePayment: null,
        chainId: optimism.chainId,
        nonce: 0n,
        signature: '0x',
        calls: [{ to, value: parseEther('1'), data: '0x' }],
        accountOpToExecuteBefore: null
      }
      const usedNetworks = [optimism]
      const providers = {
        [optimism.chainId.toString()]: getRpcProvider(optimism)
      }
      const accountStates = await getAccountsInfo(usedNetworks, providers, [smartAccDeployed])

      // if the user cannot pay in the fee token, it will revert
      const feeTokens = [
        {
          address: '0x0000000000000000000000000000000000000000',
          amount: 100n,
          symbol: 'ETH',
          name: 'Ether',
          chainId: 10n,
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
      const switcher = new BundlerSwitcher(optimism, areUpdatesForbidden)
      const accountState = accountStates[smartAccDeployed.addr][optimism.chainId.toString()]
      const baseAcc = getBaseAccount(smartAccDeployed, accountState, [], optimism)
      const result = await bundlerEstimate(
        baseAcc,
        accountState,
        opOptimism,
        optimism,
        feeTokens,
        providers[optimism.chainId.toString()],
        switcher,
        errorCallback
      )

      expect(result instanceof Error).toBe(false)
      const bundlerEstimation = result as Erc4337GasLimits
      expect(BigInt(bundlerEstimation.callGasLimit)).toBeGreaterThan(0n)
      expect(BigInt(bundlerEstimation.preVerificationGas)).toBeGreaterThan(0n)
      expect(BigInt(bundlerEstimation.verificationGasLimit)).toBeGreaterThan(0n)
      expect(BigInt(bundlerEstimation.paymasterPostOpGasLimit)).toBeGreaterThan(0n)
      expect(BigInt(bundlerEstimation.paymasterVerificationGasLimit)).toBeGreaterThan(0n)
    })
  })
})

describe('Bundler fallback tests', () => {
  class BrokenPimlico extends Pimlico {
    // eslint-disable-next-line class-methods-use-this
    async estimate(userOperation: UserOperation, network: Network): Promise<BundlerEstimateResult> {
      throw new Error('Internal error from bundler')
    }
  }
  class ExtendedBundlerSwitcher extends BundlerSwitcher {
    constructor(network: Network, areUpdatesForbbiden: Function, usedBundlers: BUNDLER[] = []) {
      super(network, areUpdatesForbbiden)
      this.bundler = new BrokenPimlico()
      this.usedBundlers = usedBundlers
    }
  }

  test('send a valid userOp on base but make the pimlico bundler return an internal server error - the bunlder switcher should switch to biconomy and proceed without the user noticing', async () => {
    const opBase: AccountOp = {
      accountAddr: smartAccDeployed.addr,
      signingKeyAddr: smartAccDeployed.associatedKeys[0],
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
      [base.chainId.toString()]: getRpcProvider(base)
    }
    const accountStates = await getAccountsInfo(usedNetworks, providers, [smartAccDeployed])

    // if the user cannot pay in the fee token, it will revert
    const feeTokens = [
      {
        address: '0x0000000000000000000000000000000000000000',
        amount: 100n,
        symbol: 'ETH',
        name: 'Ether',
        chainId: 8453n,
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
    const switcher = new ExtendedBundlerSwitcher(base, areUpdatesForbidden, [PIMLICO])
    const accountState = accountStates[smartAccDeployed.addr][base.chainId.toString()]
    const baseAcc = getBaseAccount(smartAccDeployed, accountState, [], base)
    const result = await bundlerEstimate(
      baseAcc,
      accountState,
      opBase,
      base,
      feeTokens,
      providers[base.chainId.toString()],
      switcher,
      errorCallback
    )

    expect(result instanceof Error).toBe(false)
    const bundlerEstimation = result as Erc4337GasLimits
    expect(BigInt(bundlerEstimation.callGasLimit)).toBeGreaterThan(0n)
    expect(BigInt(bundlerEstimation.preVerificationGas)).toBeGreaterThan(0n)
    expect(BigInt(bundlerEstimation.verificationGasLimit)).toBeGreaterThan(0n)
    expect(BigInt(bundlerEstimation.paymasterPostOpGasLimit)).toBeGreaterThan(0n)
    expect(BigInt(bundlerEstimation.paymasterVerificationGasLimit)).toBeGreaterThan(0n)
  })
})

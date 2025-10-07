/* eslint-disable @typescript-eslint/no-floating-promises */

import { parseEther } from 'ethers'

import { describe, expect, test } from '@jest/globals'

import { getAccountsInfo } from '../../../test/helpers'
import { DEFAULT_ACCOUNT_LABEL } from '../../consts/account'
import { networks } from '../../consts/networks'
import { Account } from '../../interfaces/account'
import { getRpcProvider } from '../../services/provider'
import { AccountOp } from '../accountOp/accountOp'
import { getUserOperation } from './userOperation'

const to = '0x706431177041C87BEb1C25Fa29b92057Cb3c7089'

const optimism = networks.find((n) => n.chainId === 10n)!

const smartAccDeployed: Account = {
  addr: '0xcb2dF90Fb6b22A87Ce22A0D36f2EcA8ED1DD1A8b',
  initialPrivileges: [
    [
      '0xBd84Cc40a5b5197B5B61919c22A55e1c46d2A3bb',
      '0x0000000000000000000000000000000000000000000000000000000000000002'
    ]
  ],
  creation: {
    factoryAddr: '0x681C1Fd13E45E7C3bfb6288Fd39c0cA552d92561',
    bytecode:
      '0x7f00000000000000000000000000000000000000000000000000000000000000027ff33cc417366b7e38d2706a67ab46f85465661c28b864b521441180d15df82251553d602d80604d3d3981f3363d3d373d3d3d363d7372d91da2b0c316d030e1ed840b80c9cd9ae445b65af43d82803e903d91602b57fd5bf3',
    salt: '0x0000000000000000000000000000000000000000000000000000000000000000'
  },
  associatedKeys: ['0xBd84Cc40a5b5197B5B61919c22A55e1c46d2A3bb'],
  preferences: {
    label: DEFAULT_ACCOUNT_LABEL,
    pfp: '0xcb2dF90Fb6b22A87Ce22A0D36f2EcA8ED1DD1A8b'
  }
}

describe('User Operation tests', () => {
  describe('Basic tests', () => {
    test.skip('should include deploy code if the account is not deployed', async () => {
      const opOptimism: AccountOp = {
        accountAddr: smartAccDeployed.addr,
        signingKeyAddr: smartAccDeployed.associatedKeys[0],
        signingKeyType: null,
        gasLimit: null,
        gasFeePayment: null,
        chainId: optimism.chainId,
        nonce: 0n,
        signature: '0x',
        calls: [{ to, value: parseEther('10'), data: '0x' }],
        accountOpToExecuteBefore: null
      }
      const usedNetworks = [optimism]
      const providers = {
        [optimism.chainId.toString()]: getRpcProvider(optimism.rpcUrls, optimism.chainId)
      }
      const accountStates = await getAccountsInfo(usedNetworks, providers, [smartAccDeployed])
      accountStates[smartAccDeployed.addr][optimism.chainId.toString()].isDeployed = false
      const userOp = getUserOperation(
        smartAccDeployed,
        accountStates[smartAccDeployed.addr][optimism.chainId.toString()],
        opOptimism,
        'pimlico',
        '0x0001'
      )
      expect(userOp).toHaveProperty('factory')
      expect(userOp).toHaveProperty('factoryData')
      expect(userOp.requestType).toBe('standard')
      expect(userOp.activatorCall).toBe(undefined)
    })
    test.skip('should not include deploy code nor the activator call on a deployed account with entry point privs', async () => {
      const opOptimism: AccountOp = {
        accountAddr: smartAccDeployed.addr,
        signingKeyAddr: smartAccDeployed.associatedKeys[0],
        signingKeyType: null,
        gasLimit: null,
        gasFeePayment: null,
        chainId: optimism.chainId,
        nonce: 0n,
        signature: '0x',
        calls: [{ to, value: parseEther('10'), data: '0x' }],
        accountOpToExecuteBefore: null
      }
      const usedNetworks = [optimism]
      const providers = {
        [optimism.chainId.toString()]: getRpcProvider(optimism.rpcUrls, optimism.chainId)
      }
      const accountStates = await getAccountsInfo(usedNetworks, providers, [smartAccDeployed])
      const userOp = getUserOperation(
        smartAccDeployed,
        accountStates[smartAccDeployed.addr][optimism.chainId.toString()],
        opOptimism,
        'pimlico'
      )
      expect(userOp).not.toHaveProperty('factory')
      expect(userOp).not.toHaveProperty('factoryData')
      expect(userOp.requestType).toBe('standard')
      expect(userOp.activatorCall).toBe(undefined)
    })
    test('should include activator call if the account is deployed but does not have entry point privs', async () => {
      const opOptimism: AccountOp = {
        accountAddr: smartAccDeployed.addr,
        signingKeyAddr: smartAccDeployed.associatedKeys[0],
        signingKeyType: null,
        gasLimit: null,
        gasFeePayment: null,
        chainId: optimism.chainId,
        nonce: 0n,
        signature: '0x',
        calls: [{ to, value: parseEther('10'), data: '0x' }],
        accountOpToExecuteBefore: null
      }
      const usedNetworks = [optimism]
      const providers = {
        [optimism.chainId.toString()]: getRpcProvider(optimism.rpcUrls, optimism.chainId)
      }
      const accountStates = await getAccountsInfo(usedNetworks, providers, [smartAccDeployed])
      accountStates[smartAccDeployed.addr][optimism.chainId.toString()].isErc4337Enabled = false
      const userOp = getUserOperation(
        smartAccDeployed,
        accountStates[smartAccDeployed.addr][optimism.chainId.toString()],
        opOptimism,
        'pimlico'
      )
      expect(userOp).not.toHaveProperty('factory')
      expect(userOp).not.toHaveProperty('factoryData')
      expect(userOp.requestType).toBe('standard')
      expect(userOp.activatorCall).toBe(undefined)
    })
  })
})

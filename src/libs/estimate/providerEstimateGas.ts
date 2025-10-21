import { Interface, toBeHex, toQuantity, ZeroAddress } from 'ethers'

import AmbireAccount from '../../../contracts/compiled/AmbireAccount.json'
import { DEPLOYLESS_SIMULATION_FROM } from '../../consts/deploy'
import { Account, AccountOnchainState } from '../../interfaces/account'
import { Hex } from '../../interfaces/hex'
import { Network } from '../../interfaces/network'
import { RPCProvider } from '../../interfaces/provider'
import { isSmartAccount } from '../account/account'
import { AccountOp, getSignableCalls } from '../accountOp/accountOp'
import { getHumanReadableEstimationError } from '../errorHumanizer'
import { TokenResult } from '../portfolio'
import { ProviderEstimation } from './interfaces'

export function getEstimateGasProps(
  op: AccountOp,
  account: Account,
  accountState: AccountOnchainState
): { from: Hex; to: Hex; value: Hex; data: Hex; useStateOverride: boolean } {
  if (accountState.isSmarterEoa) {
    const saAbi = new Interface(AmbireAccount.abi)
    return {
      from: account.addr as Hex,
      to: account.addr as Hex,
      value: '0x00',
      data: saAbi.encodeFunctionData('executeBySender', [getSignableCalls(op)]) as Hex,
      useStateOverride: false
    }
  }

  // normal EOA: a single call
  const call = op.calls[0]
  return {
    from: account.addr as Hex,
    to: call.to as Hex,
    value: toBeHex(call.value) as Hex,
    data: call.data as Hex,
    useStateOverride: false
  }
}

export async function providerEstimateGas(
  account: Account,
  op: AccountOp,
  provider: RPCProvider,
  accountState: AccountOnchainState,
  network: Network,
  feeTokens: TokenResult[]
): Promise<ProviderEstimation | Error | null> {
  // we don't do estimateGas() for smart accounts
  if (isSmartAccount(account)) return null

  const feePaymentOptions = [
    {
      paidBy: account.addr,
      availableAmount: accountState.balance,
      addedNative: 0n,
      token: feeTokens.find((token) => token.address === ZeroAddress && !token.flags.onGasTank)!,
      gasUsed: 0n
    }
  ]
  const properties = getEstimateGasProps(op, account, accountState)

  const txnParams = {
    from: properties.from,
    to: properties.to,
    value: toQuantity(properties.value),
    data: properties.data,
    nonce: toQuantity(accountState.eoaNonce as bigint)
  }
  const blockTag = 'latest'
  const stateOverride = {
    [DEPLOYLESS_SIMULATION_FROM]: {
      balance: '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    }
  }
  const params =
    properties.useStateOverride && !network.rpcNoStateOverride
      ? [txnParams, blockTag, stateOverride]
      : [txnParams, blockTag]

  const gasUsed = await provider
    .send('eth_estimateGas', params)
    .catch(getHumanReadableEstimationError)
  if (gasUsed instanceof Error) return gasUsed
  return {
    gasUsed: BigInt(gasUsed),
    feePaymentOptions
  }
}

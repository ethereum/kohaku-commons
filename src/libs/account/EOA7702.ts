/* eslint-disable class-methods-use-this */
import { Interface } from 'ethers'
import AmbireAccount from '../../../contracts/compiled/AmbireAccount.json'
import AmbireAccount7702 from '../../../contracts/compiled/AmbireAccount7702.json'
import { Hex } from '../../interfaces/hex'
import { AccountOp, getSignableCalls } from '../accountOp/accountOp'
import { BROADCAST_OPTIONS } from '../broadcast/broadcast'
import {
  BundlerStateOverride,
  FeePaymentOption,
  FullEstimation,
  FullEstimationSummary
} from '../estimate/interfaces'
import { getBroadcastGas } from '../gasPrice/gasPrice'
import { TokenResult } from '../portfolio'
import { isNative } from '../portfolio/helpers'
import { UserOperation } from '../userOperation/types'
import { BaseAccount } from './BaseAccount'

// this class describes an EOA that CAN transition to 7702
// even if it is YET to transition to 7702
export class EOA7702 extends BaseAccount {
  // when doing the 7702 activator, we should add the additional gas required
  // for the authorization list:
  // PER_EMPTY_ACCOUNT_COST: 25000
  // access list storage key: 1900
  // access list address: 2400
  ACTIVATOR_GAS_USED = 29300n

  /**
   * Introduce a public variable we can use to make a simple check on the FE
   * whether this account type is 7702.
   * This should only be used in cases where refactoring the logic on the FE
   * would mean a time-consuming event like sorting the fee payment options.
   * Use this as an exception rather than rule. Long term, we should refactor
   */
  is7702 = true

  getEstimationCriticalError(estimation: FullEstimation, op: AccountOp): Error | null {
    // the critical error should be from the provider if we can broadcast in EOA only mode
    if (!this.accountState.isSmarterEoa && op.calls.length === 1) {
      if (estimation.provider instanceof Error) {
        return estimation.ambire instanceof Error ? estimation.ambire : estimation.provider
      }

      return null
    }

    if (estimation.ambire instanceof Error) return estimation.ambire
    return null
  }

  supportsBundlerEstimation() {
    return true
  }

  /*
   * Available options:
   * - Native
   * - Token/Gas tank, if bundler estimation & paymaster
   */
  getAvailableFeeOptions(
    estimation: FullEstimationSummary,
    feePaymentOptions: FeePaymentOption[],
    op: AccountOp
  ): FeePaymentOption[] {
    const isDelegating = op.meta && op.meta.setDelegation !== undefined
    return feePaymentOptions.filter(
      (opt) =>
        opt.paidBy === this.account.addr &&
        (isNative(opt.token) ||
          (!isDelegating &&
            opt.availableAmount > 0n &&
            estimation.bundlerEstimation &&
            estimation.bundlerEstimation.paymaster.isUsable()))
    )
  }

  getGasUsed(
    estimation: FullEstimationSummary | Error,
    options: {
      feeToken: TokenResult
      op: AccountOp
    }
  ): bigint {
    const isError = estimation instanceof Error
    if (isError) return 0n

    if (isNative(options.feeToken)) {
      // if we're delegating, we need to add the gas used for the authorization list
      const isDelegating = options.op.meta && options.op.meta.setDelegation !== undefined
      const revokeGas = isDelegating ? this.ACTIVATOR_GAS_USED : 0n

      if (this.accountState.isSmarterEoa) {
        // smarter EOAs with a failing ambire estimation cannot broadcast
        if (!estimation.ambireEstimation) return 0n

        // paying in native + smartEOA makes the provider estimation more accurate
        if (estimation.providerEstimation) return estimation.providerEstimation.gasUsed + revokeGas

        // trust the ambire estimaton as it's more precise
        // but also add the broadcast gas as it's not included in the ambire estimate
        return estimation.ambireEstimation.gasUsed + getBroadcastGas(this, options.op) + revokeGas
      }

      // if calls are only 1, use the provider if set
      const numberOfCalls = options.op.calls.length
      if (numberOfCalls === 1) {
        if (estimation.providerEstimation) return estimation.providerEstimation.gasUsed + revokeGas
        return estimation.ambireEstimation ? estimation.ambireEstimation.gasUsed + revokeGas : 0n
      }

      // txn type 4
      // play it safe and use the bundler estimation if any
      if (estimation.bundlerEstimation)
        return BigInt(estimation.bundlerEstimation.callGasLimit) + this.ACTIVATOR_GAS_USED

      if (!estimation.ambireEstimation) return 0n
      return BigInt(estimation.ambireEstimation.gasUsed) + this.ACTIVATOR_GAS_USED
    }

    // if we're paying in tokens, we're using the bundler
    if (!estimation.bundlerEstimation) return 0n

    return this.accountState.isSmarterEoa
      ? BigInt(estimation.bundlerEstimation.callGasLimit)
      : BigInt(estimation.bundlerEstimation.callGasLimit) + this.ACTIVATOR_GAS_USED
  }

  getBroadcastOption(
    feeOption: FeePaymentOption,
    options: {
      op: AccountOp
      isSponsored?: boolean
    }
  ): string {
    if (options.op.meta && options.op.meta.setDelegation !== undefined)
      return BROADCAST_OPTIONS.delegation
    if (options.isSponsored) return BROADCAST_OPTIONS.byBundler

    const feeToken = feeOption.token
    if (isNative(feeToken)) {
      // if there's no native in the account, use the bundler as a broadcast method
      if (feeToken.amount === 0n) return BROADCAST_OPTIONS.byBundler

      // if the call is only 1, broadcast normally
      if (options.op.calls.length === 1) return BROADCAST_OPTIONS.bySelf

      // if already smart, executeBySender() on itself
      if (this.accountState.isSmarterEoa) return BROADCAST_OPTIONS.bySelf7702

      // calls are more than 0 and it's not smart, delegation time
      return BROADCAST_OPTIONS.delegation
    }

    // txn type 4 OR paying in token
    return BROADCAST_OPTIONS.byBundler
  }

  // if the EOA is not yet smarter and the broadcast option is a bundler,
  // sign the authorization
  shouldSignAuthorization(broadcastOption: string): boolean {
    return !this.accountState.isSmarterEoa && broadcastOption === BROADCAST_OPTIONS.byBundler
  }

  canUseReceivingNativeForFee(amount: bigint): boolean {
    // when we use the bundler, we can use receiving eth for fee payment
    return !this.accountState.isSmarterEoa || amount === 0n
  }

  getBroadcastCalldata(accountOp: AccountOp): Hex {
    const ambireAccount = new Interface(AmbireAccount.abi)
    return ambireAccount.encodeFunctionData('executeBySender', [getSignableCalls(accountOp)]) as Hex
  }

  getBundlerStateOverride(userOp: UserOperation): BundlerStateOverride | undefined {
    if (this.accountState.isSmarterEoa || !!userOp.eip7702Auth) return undefined

    // if EOA without eip7702Auth, make it look like a smart account so we could
    // do the estimation
    return {
      [this.account.addr]: {
        code: AmbireAccount7702.binRuntime
      }
    }
  }

  isSponsorable(): boolean {
    return this.network.chainId === 100n
  }

  getAtomicStatus(): 'unsupported' | 'supported' | 'ready' {
    return this.accountState.isSmarterEoa ? 'supported' : 'ready'
  }

  getNonceId(): string {
    // 7702 accounts have an execution layer nonce and an entry point nonce
    return `${this.accountState.eoaNonce!.toString()}-${this.accountState.erc4337Nonce.toString()}`
  }
}

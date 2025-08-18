/* eslint-disable class-methods-use-this */
/* eslint-disable @typescript-eslint/no-unused-vars */
import { ZeroAddress } from 'ethers'
import { Hex } from '../../interfaces/hex'
import { AccountOp } from '../accountOp/accountOp'
import { BROADCAST_OPTIONS } from '../broadcast/broadcast'
import {
  AmbireEstimation,
  FeePaymentOption,
  FullEstimation,
  FullEstimationSummary,
  ProviderEstimation
} from '../estimate/interfaces'
import { TokenResult } from '../portfolio'
import { BaseAccount } from './BaseAccount'

// this class describes a plain EOA that cannot transition
// to 7702 either because the network or the hardware wallet doesnt' support it
export class EOA extends BaseAccount {
  providerEstimation?: ProviderEstimation

  ambireEstimation?: AmbireEstimation | Error

  getEstimationCriticalError(estimation: FullEstimation, op: AccountOp): Error | null {
    const numberOfCalls = op.calls.length
    if (numberOfCalls === 1) {
      if (estimation.provider instanceof Error) {
        return estimation.ambire instanceof Error ? estimation.ambire : estimation.provider
      }
    }
    if (numberOfCalls > 1) {
      if (estimation.ambire instanceof Error) return estimation.ambire
    }
    return null
  }

  supportsBundlerEstimation() {
    return false
  }

  getAvailableFeeOptions(
    estimation: FullEstimationSummary,
    feePaymentOptions: FeePaymentOption[]
  ): FeePaymentOption[] {
    const native = feePaymentOptions.find(
      (opt) =>
        opt.paidBy === this.account.addr &&
        opt.token.address === ZeroAddress &&
        !opt.token.flags.onGasTank
    )
    if (!native) throw new Error('no native fee payment option, it should not happen')
    return [native]
  }

  getGasUsed(
    estimation: FullEstimationSummary | Error,
    options: {
      feeToken: TokenResult
      op: AccountOp
    }
  ): bigint {
    const isError = estimation instanceof Error
    if (isError || !estimation.providerEstimation || !options.op) return 0n

    const calls = options.op.calls
    if (calls.length === 1) {
      const call = calls[0]
      // a normal transfer is 21k, so just return the providerEstimation
      if (call.data === '0x') return estimation.providerEstimation.gasUsed
    }

    const ambireGasUsed = estimation.ambireEstimation ? estimation.ambireEstimation.gasUsed : 0n
    return estimation.providerEstimation.gasUsed > ambireGasUsed
      ? estimation.providerEstimation.gasUsed
      : ambireGasUsed
  }

  getBroadcastOption(
    feeOption: FeePaymentOption,
    options: {
      op: AccountOp
    }
  ): string {
    return BROADCAST_OPTIONS.bySelf
  }

  shouldBroadcastCallsSeparately(op: AccountOp): boolean {
    return op.calls.length > 1
  }

  canUseReceivingNativeForFee(): boolean {
    return false
  }

  getBroadcastCalldata(): Hex {
    return '0x'
  }

  getAtomicStatus(): 'unsupported' | 'supported' | 'ready' {
    return 'unsupported'
  }

  getNonceId(): string {
    // EOAs have only an execution layer nonce
    return this.accountState.eoaNonce!.toString()
  }
}

import { ZeroAddress } from 'ethers'

import Estimation from '../../../contracts/compiled/Estimation.json'
import { FEE_COLLECTOR } from '../../consts/addresses'
import { DEPLOYLESS_SIMULATION_FROM, OPTIMISTIC_ORACLE } from '../../consts/deploy'
import { EOA_SIMULATION_NONCE } from '../../consts/deployless'
import { AccountOnchainState } from '../../interfaces/account'
import { Network } from '../../interfaces/network'
import { RPCProvider } from '../../interfaces/provider'
import { BrowserProvider } from '../../services/provider/BrowserProvider'
import { getEoaSimulationStateOverride } from '../../utils/simulationStateOverride'
import { getAccountDeployParams } from '../account/account'
import { BaseAccount } from '../account/BaseAccount'
import { AccountOp, toSingletonCall } from '../accountOp/accountOp'
import { Call } from '../accountOp/types'
import { DeploylessMode, fromDescriptor } from '../deployless/deployless'
import { InnerCallFailureError } from '../errorDecoder/customErrors'
import { getHumanReadableEstimationError } from '../errorHumanizer'
import { getProbableCallData } from '../gasPrice/gasPrice'
import { GasTankTokenResult, TokenResult } from '../portfolio'
import { getActivatorCall, shouldIncludeActivatorCall } from '../userOperation/userOperation'
import { AmbireEstimation, EstimationFlags, FeePaymentOption } from './interfaces'

export function getInnerCallFailure(
  estimationOp: { success: boolean; err: string },
  calls: Call[],
  network: Network,
  portfolioNativeValue?: bigint
): Error | null {
  if (estimationOp.success) return null

  return getHumanReadableEstimationError(
    new InnerCallFailureError(estimationOp.err, calls, network, portfolioNativeValue)
  )
}

// the outcomeNonce should always be equal to the nonce in accountOp + 1
// that's an indication of transaction success
export function getNonceDiscrepancyFailure(
  estimationNonce: bigint,
  outcomeNonce: number
): Error | null {
  if (estimationNonce + 1n === BigInt(outcomeNonce)) return null

  return new Error("Nonce discrepancy, perhaps there's a pending transaction. Retrying...", {
    cause: 'NONCE_FAILURE'
  })
}

export async function ambireEstimateGas(
  baseAcc: BaseAccount,
  accountState: AccountOnchainState,
  op: AccountOp,
  network: Network,
  provider: RPCProvider,
  feeTokens: TokenResult[],
  nativeToCheck: string[]
): Promise<AmbireEstimation | Error> {
  const account = baseAcc.getAccount()

  // Bypass Helios for estimations
  // @TODO this should be removed when Helios supports state overrides
  let estimationProvider = provider
  if (provider instanceof BrowserProvider) {
    estimationProvider = provider.getFallbackProvider()
  }
  
  const isStillPureEoa = accountState.isEOA && !accountState.isSmarterEoa
  // For pure EOAs, we need state override for spoof signatures, so we force supportStateOverride to true
  // This ensures stateOverrideSupported is set to true in the constructor.
  // If the RPC doesn't actually support it, we'll catch the error and fallback gracefully.
  const supportStateOverride = isStillPureEoa ? true : !network.rpcNoStateOverride
  
  // Use 'pending' blockTag only for Ethereum mainnet (chainId === 1n)
  // Use 'latest' for all other networks for better RPC compatibility
  const blockTag = network.chainId === 1n ? 'pending' : 'latest'
  
  const deploylessEstimator = fromDescriptor(
    estimationProvider,
    Estimation,
    supportStateOverride
  )

  // only the activator call is added here as there are cases where it's needed
  const calls = [...op.calls.map(toSingletonCall)]
  if (shouldIncludeActivatorCall(network, account, accountState, true)) {
    calls.push(getActivatorCall(op.accountAddr))
  }

  const checkInnerCallsArgs = [
    account.addr,
    ...getAccountDeployParams(account),
    [
      account.addr,
      op.accountOpToExecuteBefore?.nonce || 0,
      op.accountOpToExecuteBefore?.calls || [],
      op.accountOpToExecuteBefore?.signature || '0x'
    ],
    [account.addr, op.nonce || 1, calls, '0x'],
    getProbableCallData(account, op, accountState, network),
    account.associatedKeys,
    feeTokens.map((feeToken) => feeToken.address),
    FEE_COLLECTOR,
    nativeToCheck,
    network.isOptimistic ? OPTIMISTIC_ORACLE : ZeroAddress
  ]
  
  // For pure EOAs, we need state override for simulation with spoof signatures.
  // We ALWAYS try StateOverride mode first for pure EOAs, regardless of network.rpcNoStateOverride,
  // because we've already forced supportStateOverride: true in the initialization.
  // If the RPC doesn't actually support it, we'll catch the error and fallback gracefully.
  let ambireEstimation
  if (isStillPureEoa) {
    // Try with StateOverride mode first for pure EOAs (required for spoof signatures)
    // We ignore network.rpcNoStateOverride because:
    // 1. We've already initialized with supportStateOverride: true
    // 2. The RPC might actually support it even if the network config says it doesn't
    // 3. We need state override for spoof signatures to work
    try {
      ambireEstimation = await deploylessEstimator.call('estimate', checkInnerCallsArgs, {
        from: DEPLOYLESS_SIMULATION_FROM,
        blockTag,
        mode: DeploylessMode.StateOverride,
        stateToOverride: getEoaSimulationStateOverride(account.addr)
      })
    } catch (error: any) {
      // For any error with StateOverride mode, fallback to Detect mode
      // This handles cases where:
      // 1. State override is explicitly not supported by the RPC
      // 2. The RPC call fails for any other reason (like require(false) revert)
      try {
        ambireEstimation = await deploylessEstimator.call('estimate', checkInnerCallsArgs, {
          from: DEPLOYLESS_SIMULATION_FROM,
          blockTag,
          mode: DeploylessMode.Detect,
          stateToOverride: null
        })
      } catch (fallbackError: any) {
        ambireEstimation = getHumanReadableEstimationError(fallbackError)
      }
    }
  } else {
    // For smart accounts, use Detect mode
    try {
      ambireEstimation = await deploylessEstimator.call('estimate', checkInnerCallsArgs, {
        from: DEPLOYLESS_SIMULATION_FROM,
        blockTag,
        mode: DeploylessMode.Detect,
        stateToOverride: null
      })
    } catch (error: any) {
      ambireEstimation = getHumanReadableEstimationError(error)
    }
  }

  if (ambireEstimation instanceof Error) {
    return ambireEstimation
  }

  const [
    [
      deployment,
      accountOpToExecuteBefore,
      accountOp,
      outcomeNonce,
      feeTokenOutcomes,
      ,
      nativeAssetBalances,
      ,
      l1GasEstimation
    ]
  ] = ambireEstimation

  const ambireEstimationError = getInnerCallFailure(
    accountOp,
    calls,
    network,
    feeTokens.find((token) => token.address === ZeroAddress && !token.flags.onGasTank)?.amount
  )

  if (ambireEstimationError) {
    return ambireEstimationError
  }

  // if there's a nonce discrepancy, it means the portfolio simulation
  // will fail so we need to update the account state and the portfolio
  const opNonce = isStillPureEoa ? BigInt(EOA_SIMULATION_NONCE) : op.nonce!
  const nonceError = getNonceDiscrepancyFailure(opNonce, outcomeNonce)
  const flags: EstimationFlags = {}
  if (nonceError) {
    flags.hasNonceDiscrepancy = true
  }

  const gasUsed = deployment.gasUsed + accountOpToExecuteBefore.gasUsed + accountOp.gasUsed

  const feeTokenOptions: FeePaymentOption[] = feeTokens.map(
    (token: TokenResult | GasTankTokenResult, key: number) => {
      // We are using 'availableAmount' here, because it's possible the 'amount' to contains pending top up amount as well
      let availableAmount =
        token.flags.onGasTank && 'availableAmount' in token
          ? token.availableAmount || token.amount
          : feeTokenOutcomes[key].amount

      // if the token is native and the account type cannot pay for the
      // transaction with the receiving amount from the estimation,
      // override the amount to the original, in-account amount.
      //
      // This isn't true when the amount is decreasing, though
      // We should subtract the amount if it's less the one he
      // currently owns as send all of native and paying in native
      // is impossible
      if (
        !token.flags.onGasTank &&
        token.address === ZeroAddress &&
        !baseAcc.canUseReceivingNativeForFee(token.amount) &&
        feeTokenOutcomes[key].amount > token.amount
      )
        availableAmount = token.amount

      return {
        paidBy: account.addr,
        availableAmount,
        // gasUsed for the gas tank tokens is smaller because of the commitment:
        // ['gasTank', amount, symbol]
        // and this commitment costs onchain:
        // - 1535, if the broadcasting addr is the relayer
        // - 4035, if the broadcasting addr is different
        // currently, there are more than 1 relayer addresses and we cannot
        // be sure which is the one that will broadcast this txn; also, ERC-4337
        // broadcasts will always consume at least 4035.
        // setting it to 5000n just be sure
        gasUsed: token.flags.onGasTank ? 5000n : feeTokenOutcomes[key].gasUsed,
        addedNative:
          token.address === ZeroAddress
            ? l1GasEstimation.feeWithNativePayment
            : l1GasEstimation.feeWithTransferPayment,
        token
      }
    }
  )

  // this is for EOAs paying for SA in native
  const nativeToken = feeTokens.find(
    (token) => token.address === ZeroAddress && !token.flags.onGasTank
  )
  const nativeTokenOptions: FeePaymentOption[] = nativeAssetBalances.map(
    (balance: bigint, key: number) => ({
      paidBy: nativeToCheck[key],
      availableAmount: balance,
      addedNative: l1GasEstimation.fee,
      token: {
        ...nativeToken,
        amount: balance
      }
    })
  )

  return {
    gasUsed,
    deploymentGas: deployment.gasUsed,
    feePaymentOptions: [...feeTokenOptions, ...nativeTokenOptions],
    ambireAccountNonce: accountOp.success ? Number(outcomeNonce - 1n) : Number(outcomeNonce),
    flags
  }
}

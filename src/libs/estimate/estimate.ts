import { BaseAccount } from '../account/BaseAccount'

import { AccountOnchainState } from '../../interfaces/account'
import { Network } from '../../interfaces/network'
import { RPCProvider } from '../../interfaces/provider'
import { BundlerSwitcher } from '../../services/bundlers/bundlerSwitcher'
import { AccountOp } from '../accountOp/accountOp'
import { TokenResult } from '../portfolio'
import { ambireEstimateGas } from './ambireEstimation'
import { bundlerEstimate } from './estimateBundler'
import { estimateWithRetries } from './estimateWithRetries'
import { FullEstimation, FullEstimationSummary } from './interfaces'
import { providerEstimateGas } from './providerEstimateGas'

// get all possible estimation combinations and leave it to the implementation
// to decide which one is relevant depending on the case.
// there are 3 estimations:
// estimateGas(): the rpc method for retrieving gas
// estimateBundler(): ask the 4337 bundler for a gas price
// Estimation.sol: our own implementation
// each has an use case in diff scenarious:
// - EOA: if payment is native, use estimateGas(); otherwise estimateBundler()
// - SA: if ethereum, use Estimation.sol; otherwise estimateBundler()
export async function getEstimation(
  baseAcc: BaseAccount,
  accountState: AccountOnchainState,
  op: AccountOp,
  network: Network,
  provider: RPCProvider,
  feeTokens: TokenResult[],
  nativeToCheck: string[],
  switcher: BundlerSwitcher,
  errorCallback: Function
): Promise<FullEstimation | Error> {
  const ambireEstimation = ambireEstimateGas(
    baseAcc,
    accountState,
    op,
    network,
    provider,
    feeTokens,
    nativeToCheck
  )
  const bundlerEstimation = bundlerEstimate(
    baseAcc,
    accountState,
    op,
    network,
    feeTokens,
    provider,
    switcher,
    errorCallback,
    undefined
  )
  const providerEstimation = providerEstimateGas(
    baseAcc.getAccount(),
    op,
    provider,
    accountState,
    network,
    feeTokens
  )

  const estimations = await estimateWithRetries<
    [FullEstimation['ambire'], FullEstimation['bundler'], FullEstimation['provider']]
  >(
    () => [ambireEstimation, bundlerEstimation, providerEstimation],
    'estimation-deployless',
    errorCallback,
    12000
  )

  // this is only if we hit a timeout 5 consecutive times
  if (estimations instanceof Error) return estimations

  const ambireGas = estimations[0]
  const bundlerGas = estimations[1]
  const providerGas = estimations[2]
  const fullEstimation: FullEstimation = {
    provider: providerGas,
    ambire: ambireGas,
    bundler: bundlerGas,
    flags: {}
  }

  const criticalError = baseAcc.getEstimationCriticalError(fullEstimation, op)
  if (criticalError) return criticalError

  let flags = {}
  if (!(ambireGas instanceof Error) && ambireGas) flags = { ...ambireGas.flags }
  if (!(bundlerGas instanceof Error) && bundlerGas) flags = { ...bundlerGas.flags }
  fullEstimation.flags = flags
  return fullEstimation
}

export function getEstimationSummary(estimation: FullEstimation): FullEstimationSummary {
  return {
    providerEstimation:
      estimation.provider && !(estimation.provider instanceof Error)
        ? estimation.provider
        : undefined,
    ambireEstimation:
      estimation.ambire && !(estimation.ambire instanceof Error) ? estimation.ambire : undefined,
    bundlerEstimation:
      estimation.bundler && !(estimation.bundler instanceof Error) ? estimation.bundler : undefined,
    flags: estimation.flags
  }
}

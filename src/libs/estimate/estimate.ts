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
  console.log('[getEstimation] START - Entry point', {
    accountAddr: op.accountAddr,
    chainId: op.chainId,
    callsCount: op.calls.length,
    networkName: network.name
  })

  console.log('[getEstimation] Initializing all estimation methods')
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

  console.log('[getEstimation] Waiting for all estimations with retries')
  const estimations = await estimateWithRetries<
    [FullEstimation['ambire'], FullEstimation['bundler'], FullEstimation['provider']]
  >(
    () => [ambireEstimation, bundlerEstimation, providerEstimation],
    'estimation-deployless',
    errorCallback,
    12000
  )

  console.log('[getEstimation] Estimations completed', {
    isError: estimations instanceof Error,
    errorMessage: estimations instanceof Error ? estimations.message : undefined,
    resultsCount: Array.isArray(estimations) ? estimations.length : 0
  })

  // this is only if we hit a timeout 5 consecutive times
  if (estimations instanceof Error) {
    console.error('[getEstimation] Retries exhausted - returning error', {
      errorMessage: estimations.message,
      errorName: estimations.name
    })
    return estimations
  }

  const ambireGas = estimations[0]
  const bundlerGas = estimations[1]
  const providerGas = estimations[2]

  console.log('[getEstimation] Individual estimation results', {
    ambireIsError: ambireGas instanceof Error,
    ambireErrorMessage: ambireGas instanceof Error ? ambireGas.message : undefined,
    bundlerIsError: bundlerGas instanceof Error,
    bundlerErrorMessage: bundlerGas instanceof Error ? bundlerGas.message : undefined,
    providerIsError: providerGas instanceof Error,
    providerErrorMessage: providerGas instanceof Error ? providerGas.message : undefined
  })

  const fullEstimation: FullEstimation = {
    provider: providerGas,
    ambire: ambireGas,
    bundler: bundlerGas,
    flags: {}
  }

  const criticalError = baseAcc.getEstimationCriticalError(fullEstimation, op)
  if (criticalError) {
    console.error('[getEstimation] Critical error detected', {
      errorMessage: criticalError.message,
      errorName: criticalError.name
    })
    return criticalError
  }

  let flags = {}
  if (!(ambireGas instanceof Error) && ambireGas) flags = { ...ambireGas.flags }
  if (!(bundlerGas instanceof Error) && bundlerGas) flags = { ...bundlerGas.flags }
  fullEstimation.flags = flags

  console.log('[getEstimation] SUCCESS - Returning full estimation', {
    hasAmbire: !(ambireGas instanceof Error),
    hasBundler: !(bundlerGas instanceof Error),
    hasProvider: !(providerGas instanceof Error),
    flags
  })

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

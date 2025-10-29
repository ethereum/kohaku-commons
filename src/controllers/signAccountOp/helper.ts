import { formatUnits, ZeroAddress } from 'ethers'

import { WARNINGS } from '../../consts/signAccountOp/errorHandling'
import { Price } from '../../interfaces/assets'
import { TraceCallDiscoveryStatus, Warning } from '../../interfaces/signAccountOp'
import { SubmittedAccountOp } from '../../libs/accountOp/submittedAccountOp'
import { FeePaymentOption } from '../../libs/estimate/interfaces'
import { TokenResult } from '../../libs/portfolio'
import { getAccountPortfolioTotal, getTotal } from '../../libs/portfolio/helpers'
import { AccountState } from '../../libs/portfolio/interfaces'
import { safeTokenAmountAndNumberMultiplication } from '../../utils/numbers/formatters'

export const SIGN_ACCOUNT_OP_MAIN = 'signAccountOpMain'
export const SIGN_ACCOUNT_OP_SWAP = 'signAccountOpSwap'
export const SIGN_ACCOUNT_OP_TRANSFER = 'signAccountOpTransfer'
export const SIGN_ACCOUNT_OP_PRIVACY_POOLS = 'signAccountOpPrivacyPools'
export type SignAccountOpType =
  | 'signAccountOpMain'
  | 'signAccountOpSwap'
  | 'signAccountOpTransfer'
  | 'signAccountOpPrivacyPools'

function getFeeSpeedIdentifier(
  option: FeePaymentOption,
  accountAddr: string,
  rbfAccountOp: SubmittedAccountOp | null
) {
  // if the token is native and we're paying with EOA, we do not need
  // a different identifier as the fee speed calculations will be the same
  // regardless of the EOA address
  const paidBy =
    option.token.address === ZeroAddress && option.paidBy !== accountAddr ? 'EOA' : option.paidBy

  return `${paidBy}:${option.token.address}:${option.token.symbol.toLowerCase()}:${
    option.token.flags.onGasTank ? 'gasTank' : 'feeToken'
  }${rbfAccountOp ? `rbf-${option.paidBy}` : ''}`
}

function getTokenUsdAmount(token: TokenResult, gasAmount: bigint): string {
  const isUsd = (price: Price) => price.baseCurrency === 'usd'
  const usdPrice = token.priceIn.find(isUsd)?.price

  if (!usdPrice) return ''

  return safeTokenAmountAndNumberMultiplication(gasAmount, token.decimals, usdPrice)
}

function getSignificantBalanceDecreaseWarning(
  latest: AccountState,
  pending: AccountState,
  chainId: bigint,
  traceCallDiscoveryStatus: TraceCallDiscoveryStatus
): Warning | null {
  const latestNetworkData = latest?.[chainId.toString()]
  const pendingNetworkData = pending?.[chainId.toString()]
  const canDetermineIfBalanceWillDecrease =
    latestNetworkData &&
    !latestNetworkData.isLoading &&
    pendingNetworkData &&
    !pendingNetworkData.isLoading

  if (canDetermineIfBalanceWillDecrease) {
    const latestTotalInUSD = getAccountPortfolioTotal(latest, ['rewards', 'gasTank'], false)
    const latestOnNetworkInUSD = getTotal(latestNetworkData.result?.tokens || []).usd
    const pendingOnNetworkInUSD = getTotal(pendingNetworkData.result?.tokens || []).usd
    const absoluteDecreaseInUSD = latestOnNetworkInUSD - pendingOnNetworkInUSD
    const hasSignificantBalanceDecrease =
      absoluteDecreaseInUSD >= latestTotalInUSD * 0.2 && absoluteDecreaseInUSD >= 1000

    if (!hasSignificantBalanceDecrease) return null

    // We wait for the discovery process (main.traceCall) to complete before showing WARNINGS.significantBalanceDecrease.
    // This is important because, in the case of a SWAP to a new token, the new token is not yet part of the portfolio,
    // which could incorrectly trigger a significant balance drop warning.
    // To prevent this, we ensure the discovery process is completed first.
    if (traceCallDiscoveryStatus === TraceCallDiscoveryStatus.Done) {
      return WARNINGS.significantBalanceDecrease
    }

    // If the discovery process takes too long (more than 2 seconds) or fails,
    // we still show a warning, but we indicate that our balance decrease assumption may be incorrect.
    if (
      traceCallDiscoveryStatus === TraceCallDiscoveryStatus.Failed ||
      traceCallDiscoveryStatus === TraceCallDiscoveryStatus.SlowPendingResponse
    ) {
      return WARNINGS.possibleBalanceDecrease
    }
  }

  return null
}

const getFeeTokenPriceUnavailableWarning = (
  hasSpeed: boolean,
  feeTokenHasPrice: boolean
): Warning | null => {
  if (!hasSpeed || feeTokenHasPrice) return null

  return WARNINGS.feeTokenPriceUnavailable
}

export {
  getFeeSpeedIdentifier,
  getFeeTokenPriceUnavailableWarning,
  getSignificantBalanceDecreaseWarning,
  getTokenUsdAmount
}

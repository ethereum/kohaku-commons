import { ZeroAddress } from 'ethers'

/* eslint-disable class-methods-use-this */
import ErrorHumanizerError from '../../classes/ErrorHumanizerError'
import { RPCProvider } from '../../interfaces/provider'
import { SignAccountOpError, Warning } from '../../interfaces/signAccountOp'
import { BaseAccount } from '../../libs/account/BaseAccount'
import { getBaseAccount } from '../../libs/account/getBaseAccount'
import { AccountOp } from '../../libs/accountOp/accountOp'
import { getEstimation, getEstimationSummary } from '../../libs/estimate/estimate'
import { FeePaymentOption, FullEstimationSummary } from '../../libs/estimate/interfaces'
import { isPortfolioGasTankResult } from '../../libs/portfolio/helpers'
import { BundlerSwitcher } from '../../services/bundlers/bundlerSwitcher'
import { getIsViewOnly } from '../../utils/accounts'
import { AccountsController } from '../accounts/accounts'
import { ActivityController } from '../activity/activity'
import EventEmitter, { ErrorRef } from '../eventEmitter/eventEmitter'
import { KeystoreController } from '../keystore/keystore'
import { NetworksController } from '../networks/networks'
import { PortfolioController } from '../portfolio/portfolio'
import { EstimationStatus } from './types'

export class EstimationController extends EventEmitter {
  #keystore: KeystoreController

  #accounts: AccountsController

  #networks: NetworksController

  #provider: RPCProvider

  #portfolio: PortfolioController

  status: EstimationStatus = EstimationStatus.Initial

  estimation: FullEstimationSummary | null = null

  error: Error | null = null

  /**
   * a boolean to understand if the estimation has been performed
   * at least one indicating clearly that all other are re-estimates
   */
  hasEstimated: boolean = false

  estimationRetryError: ErrorRef | null = null

  availableFeeOptions: FeePaymentOption[] = []

  #bundlerSwitcher: BundlerSwitcher

  #activity: ActivityController

  #notFatalBundlerError?: Error

  constructor(
    keystore: KeystoreController,
    accounts: AccountsController,
    networks: NetworksController,
    provider: RPCProvider,
    portfolio: PortfolioController,
    activity: ActivityController,
    bundlerSwitcher: BundlerSwitcher
  ) {
    super()
    this.#keystore = keystore
    this.#accounts = accounts
    this.#networks = networks
    this.#provider = provider
    this.#portfolio = portfolio
    this.#activity = activity
    this.#bundlerSwitcher = bundlerSwitcher
  }

  #getAvailableFeeOptions(baseAcc: BaseAccount, op: AccountOp): FeePaymentOption[] {
    const estimation = this.estimation as FullEstimationSummary
    const isSponsored = !!estimation.bundlerEstimation?.paymaster.isSponsored()

    if (isSponsored) {
      // if there's no ambireEstimation, it means there's an error
      if (!estimation.ambireEstimation) return []

      // if the txn is sponsored, return the native option only
      const native = estimation.ambireEstimation.feePaymentOptions.find(
        (feeOption) => feeOption.token.address === ZeroAddress
      )
      return native ? [native] : []
    }

    return baseAcc.getAvailableFeeOptions(
      estimation,
      // eslint-disable-next-line no-nested-ternary
      estimation.ambireEstimation
        ? estimation.ambireEstimation.feePaymentOptions
        : estimation.providerEstimation
        ? estimation.providerEstimation.feePaymentOptions
        : [],
      op
    )
  }

  async estimate(op: AccountOp) {
    this.status = EstimationStatus.Loading
    this.emitUpdate()

    const account = this.#accounts.accounts.find((acc) => acc.addr === op.accountAddr)!
    const network = this.#networks.networks.find((net) => net.chainId === op.chainId)!
    const accountState = await this.#accounts.getOrFetchAccountOnChainState(
      op.accountAddr,
      op.chainId
    )
    const baseAcc = getBaseAccount(
      account,
      accountState,
      this.#keystore.getAccountKeys(account),
      network
    )

    // Take the fee tokens from two places: the user's tokens and his gasTank
    // The gasTank tokens participate on each network as they belong everywhere
    // NOTE: at some point we should check all the "?" signs below and if
    // an error pops out, we should notify the user about it
    let networkFeeTokens =
      this.#portfolio.getLatestPortfolioState(op.accountAddr)?.[op.chainId.toString()]?.result
        ?.feeTokens ?? []

    // This could happen only in a race when a NOT currently selected account is
    // requested, switched to and immediately fired a txn request for. In that situation,
    // the portfolio would not be fetched and the estimation would be fired without tokens,
    // resulting in a "nothing to pay the fee with" error which is absolutely wrong
    if (networkFeeTokens.length === 0) {
      await this.#portfolio.updateSelectedAccount(op.accountAddr, [network], undefined, {
        forceUpdate: true
      })
      networkFeeTokens =
        this.#portfolio.getLatestPortfolioState(op.accountAddr)?.[op.chainId.toString()]?.result
          ?.feeTokens ?? []
    }

    const gasTankResult = this.#portfolio.getLatestPortfolioState(op.accountAddr)?.gasTank?.result
    const gasTankFeeTokens = isPortfolioGasTankResult(gasTankResult)
      ? gasTankResult.gasTankTokens
      : []
    const feeTokens =
      [...networkFeeTokens, ...gasTankFeeTokens].filter((t) => t.flags.isFeeToken) || []

    // Here, we list EOA accounts for which you can also obtain an estimation of the AccountOp payment.
    // In the case of operating with a smart account (an account with creation code), all other EOAs can pay the fee.
    //
    // If the current account is an EOA, only this account can pay the fee,
    // and there's no need for checking other EOA accounts native balances.
    // This is already handled and estimated as a fee option in the estimate library, which is why we pass an empty array here.
    //
    // we're excluding the view only accounts from the natives to check
    // in all cases EXCEPT the case where we're making an estimation for
    // the view only account itself. In all other, view only accounts options
    // should not be present as the user cannot pay the fee with them (no key)
    const nativeToCheck = account.creation
      ? this.#accounts.accounts
          .filter(
            (acc) =>
              !acc.creation &&
              (acc.addr === op.accountAddr ||
                !getIsViewOnly(this.#keystore.keys, acc.associatedKeys))
          )
          .map((acc) => acc.addr)
      : []

    const estimation = await getEstimation(
      baseAcc,
      accountState,
      op,
      network,
      this.#provider,
      feeTokens,
      nativeToCheck,
      this.#bundlerSwitcher,
      (e: ErrorRef) => {
        if (!this) return
        this.estimationRetryError = e
        this.emitUpdate()
      }
    ).catch((e) => e)

    const isSuccess = !(estimation instanceof Error)
    if (isSuccess) {
      this.estimation = getEstimationSummary(estimation)
      this.error = null
      this.status = EstimationStatus.Success
      this.estimationRetryError = null
      this.availableFeeOptions = this.#getAvailableFeeOptions(baseAcc, op)
      if (estimation.bundler instanceof Error) {
        this.#notFatalBundlerError = estimation.bundler
      }
    } else {
      this.estimation = null
      this.error = estimation
      this.status = EstimationStatus.Error
      this.availableFeeOptions = []
    }

    // estimation.flags.hasNonceDiscrepancy is a signal from the estimation
    // that the account state is not the latest and needs to be updated
    if (
      this.estimation &&
      (this.estimation.flags.hasNonceDiscrepancy || this.estimation.flags.has4337NonceDiscrepancy)
    )
      // silenly continuing on error here as the flags are more like app helpers
      this.#accounts.updateAccountState(op.accountAddr, 'pending', [op.chainId]).catch((e) => e)

    this.hasEstimated = true
    this.emitUpdate()
  }

  /**
   * it's initialized if it has estimated at least once
   */
  isInitialized() {
    return this.hasEstimated
  }

  /**
   * has it estimated at least once without a failure
   */
  isLoadingOrFailed(): boolean {
    return this.status === EstimationStatus.Loading || this.error instanceof Error
  }

  calculateWarnings() {
    const warnings: Warning[] = []

    if (this.estimationRetryError && this.status === EstimationStatus.Success) {
      warnings.push({
        id: 'estimation-retry',
        title: this.estimationRetryError.message,
        text: 'You can try to broadcast this transaction with the last successful estimation or wait for a new one. Retrying...'
      })
    }

    if (
      this.estimation?.bundlerEstimation?.nonFatalErrors?.find(
        (err) => err.cause === '4337_ESTIMATION'
      )
    ) {
      warnings.push({
        id: 'bundler-failure',
        title:
          'Smart account fee options are temporarily unavailable. You can pay fee with an EOA account or try again later'
      })
    }

    if (this.#notFatalBundlerError?.cause === '4337_INVALID_NONCE') {
      warnings.push({
        id: 'bundler-nonce-discrepancy',
        title:
          'Pending transaction detected! Please wait for its confirmation to have more payment options available'
      })
    }

    return warnings
  }

  get errors(): SignAccountOpError[] {
    const errors: SignAccountOpError[] = []

    if (this.isLoadingOrFailed() && this.estimationRetryError) {
      // If there is a successful estimation we should show this as a warning
      // as the user can use the old estimation to broadcast
      errors.push({
        title: `${this.estimationRetryError.message} ${
          this.error
            ? 'We will continue retrying, but please check your internet connection.'
            : 'Automatically retrying in a few seconds. Please wait...'
        }`
      })

      return errors
    }

    if (!this.isInitialized()) return []

    if (this.error) {
      let code = ''

      if (this.error instanceof ErrorHumanizerError && this.error.isFallbackMessage) {
        code =
          typeof this.error.cause === 'string' && !!this.error.cause
            ? this.error.cause
            : 'ESTIMATION_ERROR'
      }

      errors.push({
        title: this.error.message,
        code
      })
    }

    return errors
  }

  reset() {
    this.estimation = null
    this.error = null
    this.hasEstimated = false
    this.status = EstimationStatus.Initial
    this.estimationRetryError = null
    this.availableFeeOptions = []
  }
}

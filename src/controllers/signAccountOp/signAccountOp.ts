/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable class-methods-use-this */
import {
  AbiCoder,
  formatEther,
  formatUnits,
  getAddress,
  Interface,
  isAddress,
  isBytesLike,
  toBeHex,
  ZeroAddress
} from 'ethers'

import AmbireAccount from '../../../contracts/compiled/AmbireAccount.json'
import ERC20 from '../../../contracts/compiled/IERC20.json'
import { EIP7702Auth } from '../../consts/7702'
import { FEE_COLLECTOR } from '../../consts/addresses'
import { BUNDLER } from '../../consts/bundlers'
import { EIP_7702_AMBIRE_ACCOUNT, SINGLETON } from '../../consts/deploy'
import gasTankFeeTokens from '../../consts/gasTankFeeTokens'
/* eslint-disable no-restricted-syntax */
import {
  ERRORS,
  RETRY_TO_INIT_ACCOUNT_OP_MSG,
  WARNINGS
} from '../../consts/signAccountOp/errorHandling'
import {
  GAS_TANK_TRANSFER_GAS_USED,
  SA_ERC20_TRANSFER_GAS_USED,
  SA_NATIVE_TRANSFER_GAS_USED
} from '../../consts/signAccountOp/gas'
import { Account } from '../../interfaces/account'
import { Price } from '../../interfaces/assets'
import { Hex } from '../../interfaces/hex'
import { ExternalKey, ExternalSignerControllers, InternalKey, Key } from '../../interfaces/keystore'
import { Network } from '../../interfaces/network'
import { RPCProvider } from '../../interfaces/provider'
import {
  SignAccountOpError,
  TraceCallDiscoveryStatus,
  Warning
} from '../../interfaces/signAccountOp'
import { getContractImplementation } from '../../libs/7702/7702'
import { isAmbireV1LinkedAccount, isSmartAccount } from '../../libs/account/account'
/* eslint-disable no-restricted-syntax */
import { BaseAccount } from '../../libs/account/BaseAccount'
import { getBaseAccount } from '../../libs/account/getBaseAccount'
import { AccountOp, GasFeePayment, getSignableCalls } from '../../libs/accountOp/accountOp'
import { SubmittedAccountOp } from '../../libs/accountOp/submittedAccountOp'
import { BROADCAST_OPTIONS } from '../../libs/broadcast/broadcast'
import { PaymasterErrorReponse, PaymasterSuccessReponse, Sponsor } from '../../libs/erc7677/types'
import { getHumanReadableBroadcastError } from '../../libs/errorHumanizer'
import { bundlerEstimate } from '../../libs/estimate/estimateBundler'
import {
  Erc4337GasLimits,
  FeePaymentOption,
  FullEstimationSummary
} from '../../libs/estimate/interfaces'
import {
  Gas1559Recommendation,
  GasPriceRecommendation,
  GasRecommendation
} from '../../libs/gasPrice/gasPrice'
import { humanizeAccountOp } from '../../libs/humanizer'
import { hasRelayerSupport } from '../../libs/networks/networks'
import { AbstractPaymaster } from '../../libs/paymaster/abstractPaymaster'
import { GetOptions, TokenResult } from '../../libs/portfolio'
import {
  adjustEntryPointAuthorization,
  get7702Sig,
  get7702UserOpTypedData,
  getAuthorizationHash,
  getEIP712Signature,
  getEntryPointAuthorization,
  getExecuteSignature,
  getTypedData,
  wrapStandard,
  wrapUnprotected
} from '../../libs/signMessage/signMessage'
import { getGasUsed } from '../../libs/singleton/singleton'
import { UserOperation } from '../../libs/userOperation/types'
import {
  getActivatorCall,
  getPackedUserOp,
  getUserOperation,
  getUserOpHash
} from '../../libs/userOperation/userOperation'
import { BundlerSwitcher } from '../../services/bundlers/bundlerSwitcher'
import { GasSpeeds } from '../../services/bundlers/types'
import { AccountsController } from '../accounts/accounts'
import { AccountOpAction } from '../actions/actions'
import { ActivityController } from '../activity/activity'
import { EstimationController } from '../estimation/estimation'
import { EstimationStatus } from '../estimation/types'
import EventEmitter, { ErrorRef } from '../eventEmitter/eventEmitter'
import { GasPriceController } from '../gasPrice/gasPrice'
import { KeystoreController } from '../keystore/keystore'
import { NetworksController } from '../networks/networks'
import { PortfolioController } from '../portfolio/portfolio'
import {
  getFeeSpeedIdentifier,
  getFeeTokenPriceUnavailableWarning,
  getSignificantBalanceDecreaseWarning,
  getTokenUsdAmount
} from './helper'

export enum SigningStatus {
  EstimationError = 'estimation-error',
  UnableToSign = 'unable-to-sign',
  ReadyToSign = 'ready-to-sign',
  /**
   * Used to prevent state updates while the user is resolving warnings, connecting a hardware wallet, etc.
   * Signing is allowed in this state, but the state of the controller should not change.
   */
  UpdatesPaused = 'updates-paused',
  InProgress = 'in-progress',
  WaitingForPaymaster = 'waiting-for-paymaster-response',
  Done = 'done'
}

export type Status = {
  // @TODO: get rid of the object and just use the type
  type: SigningStatus
}

export enum FeeSpeed {
  Slow = 'slow',
  Medium = 'medium',
  Fast = 'fast',
  Ape = 'ape'
}

export type SpeedCalc = {
  type: FeeSpeed
  amount: bigint
  simulatedGasLimit: bigint
  amountFormatted: string
  amountUsd: string
  gasPrice: bigint
  disabled: boolean
  maxPriorityFeePerGas?: bigint
}

// declare the statuses we don't want state updates on
export const noStateUpdateStatuses = [
  SigningStatus.InProgress,
  SigningStatus.Done,
  SigningStatus.UpdatesPaused,
  SigningStatus.WaitingForPaymaster
]

export type SignAccountOpUpdateProps = {
  gasPrices?: GasRecommendation[] | null
  feeToken?: TokenResult
  paidBy?: string
  speed?: FeeSpeed
  signingKeyAddr?: Key['addr']
  signingKeyType?: InternalKey['type'] | ExternalKey['type']
  calls?: AccountOp['calls']
  rbfAccountOps?: { [key: string]: SubmittedAccountOp | null }
  bundlerGasPrices?: { speeds: GasSpeeds; bundler: BUNDLER }
  blockGasLimit?: bigint
  signedTransactionsCount?: number | null
  hasNewEstimation?: boolean
}

export class SignAccountOpController extends EventEmitter {
  #accounts: AccountsController

  #keystore: KeystoreController

  #portfolio: PortfolioController

  #externalSignerControllers: ExternalSignerControllers

  account: Account

  baseAccount: BaseAccount

  #network: Network

  #blockGasLimit: bigint | undefined = undefined

  // this is not used in the controller directly but it's being read outside
  fromActionId: AccountOpAction['id']

  accountOp: AccountOp

  gasPrices?: GasRecommendation[] | null

  bundlerGasPrices: GasSpeeds | null = null

  feeSpeeds: {
    [identifier: string]: SpeedCalc[]
  } = {}

  paidBy: string | null = null

  feeTokenResult: TokenResult | null = null

  selectedFeeSpeed: FeeSpeed | null = FeeSpeed.Fast

  selectedOption: FeePaymentOption | undefined = undefined

  status: Status | null = null

  #isSignRequestStillActive: Function

  rbfAccountOps: { [key: string]: SubmittedAccountOp | null }

  signedAccountOp: AccountOp | null

  replacementFeeLow: boolean

  warnings: Warning[] = []

  // indicates whether the transaction gas is sponsored or not
  isSponsored: boolean = false

  // the sponsor data to be displayed, if any
  sponsor: Sponsor | undefined = undefined

  bundlerSwitcher: BundlerSwitcher

  signedTransactionsCount: number | null = null

  // We track the status of token discovery logic (main.traceCall)
  // to ensure the "SignificantBalanceDecrease" banner is displayed correctly.
  // The latest/pending portfolio balance is essential for calculating balance differences.
  // However, during a SWAP, the user may receive a new token that isn't yet included (discovered) in the portfolio.
  // If the discovery process is in-process, and we only rely on portfolio balance change,
  // the banner may be incorrectly triggered due to the perceived balance drop.
  // Once discovery completes and updates the portfolio, the banner will be hidden.
  traceCallDiscoveryStatus: TraceCallDiscoveryStatus = TraceCallDiscoveryStatus.NotStarted

  // the calculated gas used for the transaction estimation
  // it now depends on a variety of options and hence the need to move it
  // as its own property
  gasUsed: bigint = 0n

  provider: RPCProvider

  estimation: EstimationController

  gasPrice: GasPriceController

  #traceCall: Function

  shouldSignAuth: {
    type: 'V2Deploy' | '7702'
    text: string
  } | null = null

  /**
   * Should this signAccountOp instance simulate the accountOp it's
   * preparing as well as estimate. Simulaton is required in the
   * original signAccountOp but should be avoided in swap&bridge
   */
  #shouldSimulate: boolean

  #activity: ActivityController

  constructor(
    accounts: AccountsController,
    networks: NetworksController,
    keystore: KeystoreController,
    portfolio: PortfolioController,
    activity: ActivityController,
    externalSignerControllers: ExternalSignerControllers,
    account: Account,
    network: Network,
    provider: RPCProvider,
    fromActionId: AccountOpAction['id'],
    accountOp: AccountOp,
    isSignRequestStillActive: Function,
    shouldSimulate: boolean,
    traceCall?: Function
  ) {
    super()

    this.#accounts = accounts
    this.#keystore = keystore
    this.#portfolio = portfolio
    this.#activity = activity
    this.#externalSignerControllers = externalSignerControllers
    this.account = account
    this.baseAccount = getBaseAccount(
      account,
      accounts.accountStates[account.addr][network.chainId.toString()],
      keystore.keys.filter((key) => account.associatedKeys.includes(key.addr)),
      network
    )
    this.#network = network
    this.fromActionId = fromActionId
    this.accountOp = structuredClone(accountOp)
    this.#isSignRequestStillActive = isSignRequestStillActive

    this.rbfAccountOps = {}
    this.signedAccountOp = null
    this.replacementFeeLow = false
    this.bundlerSwitcher = new BundlerSwitcher(
      network,
      () => {
        return this.status ? noStateUpdateStatuses.indexOf(this.status.type) : false
      },
      { canDelegate: this.baseAccount.shouldSignAuthorization(BROADCAST_OPTIONS.byBundler) }
    )
    this.provider = provider
    this.estimation = new EstimationController(
      keystore,
      accounts,
      networks,
      provider,
      portfolio,
      activity,
      this.bundlerSwitcher
    )
    const emptyFunc = () => {}
    this.#traceCall = traceCall ?? emptyFunc
    this.gasPrice = new GasPriceController(
      network,
      provider,
      this.baseAccount,
      this.bundlerSwitcher,
      () => ({
        estimation: this.estimation,
        readyToSign: this.readyToSign,
        isSignRequestStillActive
      })
    )
    this.#shouldSimulate = shouldSimulate

    this.#load(shouldSimulate)
  }

  #validateAccountOp(): SignAccountOpError | null {
    const invalidAccountOpError =
      'The transaction is missing essential data. Please contact support.'
    if (!this.accountOp.accountAddr || !isAddress(this.accountOp.accountAddr)) {
      return { title: invalidAccountOpError, code: 'INVALID_ACCOUNT_ADDRESS' }
    }
    if (!this.accountOp.chainId || typeof this.accountOp.chainId !== 'bigint') {
      return { title: invalidAccountOpError, code: 'INVALID_CHAIN_ID' }
    }
    if (!this.accountOp.calls || !this.accountOp.calls.length) {
      return { title: invalidAccountOpError, code: 'NO_CALLS' }
    }

    if (
      this.accountOp.calls.some(
        (c) => isAddress(c.to) && getAddress(c.to) === getAddress(this.accountOp.accountAddr)
      )
    )
      return {
        title: 'A malicious transaction found in this batch.',
        code: 'CALL_TO_SELF'
      }

    let callError: SignAccountOpError | null = null

    for (let index = 0; index < this.accountOp.calls.length; index++) {
      const call = this.accountOp.calls[index]

      if (!!call.data && !isBytesLike(call.data)) {
        callError = {
          title: 'Invalid bytes-like string in call data.',
          text: 'Please remove all invalid calls if you want to proceed.'
        }
        call.validationError = 'Invalid bytes-like string in call data'

        // Stop after the first invalid call
        break
      } else if (call.to && !isAddress(call.to)) {
        callError = {
          title: 'Invalid to address in call.',
          text: 'Please remove all invalid calls if you want to proceed.'
        }
        call.validationError = 'Invalid to address in call.'

        // Stop after the first invalid call
        break
      }
    }

    return callError
  }

  #load(shouldSimulate: boolean) {
    this.learnTokensFromCalls()

    this.estimation.onUpdate(() => {
      this.update({ hasNewEstimation: true })
    })
    this.gasPrice.onUpdate(() => {
      this.update({
        gasPrices: this.gasPrice.gasPrices[this.#network.chainId.toString()] || null,
        bundlerGasPrices: this.gasPrice.bundlerGasPrices[this.#network.chainId.toString()],
        blockGasLimit: this.gasPrice.blockGasLimit
      })
    })
    this.gasPrice.onError((error: ErrorRef) => {
      this.emitError(error)
    })

    shouldSimulate ? this.simulate(true) : this.estimate()
    this.gasPrice.fetch()
  }

  learnTokensFromCalls() {
    const humanization = humanizeAccountOp(this.accountOp, {})
    const additionalHints: GetOptions['additionalErc20Hints'] = humanization
      .map((call: any) =>
        !call.fullVisualization
          ? []
          : call.fullVisualization.map((vis: any) =>
              vis.address && isAddress(vis.address) ? getAddress(vis.address) : ''
            )
      )
      .flat()
      .filter((x: any) => isAddress(x))
    this.#portfolio.addTokensToBeLearned(additionalHints, this.#network.chainId)
  }

  get isInitialized(): boolean {
    return this.estimation.isInitialized()
  }

  #setDefaults() {
    // Set the first signer as the default one.
    // If there are more available signers, the user will be able to select a different signer from the application.
    // The main benefit of having a default signer
    // is that it drastically simplifies the logic of determining whether the account is ready for signing.
    // For example, in the `sign` method and on the application screen, we can simply rely on the `this.readyToSign` flag.
    // Otherwise, if we don't have a default value, then `this.readyToSign` will always be false unless we set a signer.
    // In that case, on the application, we want the "Sign" button to be clickable/enabled,
    // and we have to check and expose the `SignAccountOp` controller's inner state to make this check possible.
    if (
      this.accountKeyStoreKeys.length &&
      (!this.accountOp.signingKeyAddr || !this.accountOp.signingKeyType)
    ) {
      this.accountOp.signingKeyAddr = this.accountKeyStoreKeys[0].addr
      this.accountOp.signingKeyType = this.accountKeyStoreKeys[0].type
    }

    // we can set a default paidBy and feeToken here if they aren't any set
  }

  #setGasFeePayment() {
    if (this.isInitialized && this.paidBy && this.selectedFeeSpeed && this.feeTokenResult) {
      this.accountOp.gasFeePayment = this.#getGasFeePayment()
    }
  }

  // check if speeds are set for the given identifier
  hasSpeeds(identifier: string) {
    return this.feeSpeeds[identifier] !== undefined && this.feeSpeeds[identifier].length
  }

  get errors(): SignAccountOpError[] {
    const accountOpValidationError = this.#validateAccountOp()

    if (accountOpValidationError) return [accountOpValidationError]

    const errors: SignAccountOpError[] = []

    const estimationErrors = this.estimation.errors
    if (estimationErrors.length) return estimationErrors

    const isAmbireV1 = isAmbireV1LinkedAccount(this.account?.creation?.factoryAddr)
    const isAmbireV1AndNetworkNotSupported = isAmbireV1 && !hasRelayerSupport(this.#network)

    // This must be the first error check!
    if (isAmbireV1AndNetworkNotSupported) {
      errors.push({
        title:
          'Ambire v1 accounts are not supported on this network. To interact with this network, please use an Ambire Smart Account or an EOA account. You can still use v1 accounts on any network that is natively integrated with the Ambire web and mobile wallets.'
      })

      // Don't show any other errors
      return errors
    }

    /**
     * A big block for logic separation
     * The above errors (estimation & ambireV1) are okay to be shown
     * even if isInitialized hasn't completed. Otherwise, do not load
     * any errors
     */
    if (!this.isInitialized) return []

    const areGasPricesLoading = typeof this.gasPrices === 'undefined'

    if (!areGasPricesLoading && !this.gasPrices?.length) {
      errors.push({
        title:
          'Gas price information is currently unavailable. This may be due to network congestion or connectivity issues. Please try again in a few moments or check your internet connection.'
      })
    }

    if (
      this.#blockGasLimit &&
      this.selectedOption &&
      this.selectedOption.gasUsed > this.#blockGasLimit
    ) {
      errors.push({
        title: 'The transaction gas limit exceeds the network block gas limit.'
      })
    }

    if (
      this.#network.predefined &&
      this.selectedOption &&
      this.selectedOption.gasUsed > 500000000n
    ) {
      errors.push({
        title: 'Unreasonably high estimation. This transaction will probably fail'
      })
    }

    // this error should never happen as availableFeeOptions should always have the native option
    if (!this.isSponsored && !this.estimation.availableFeeOptions.length)
      errors.push({
        title: 'Insufficient funds to cover the fee.'
      })

    // This error should not happen, as in the update method we are always setting a default signer.
    // It may occur, only if there are no available signer.
    if (!this.accountOp.signingKeyType || !this.accountOp.signingKeyAddr)
      errors.push({
        title: 'No signer available'
      })

    const currentPortfolio = this.#portfolio.getLatestPortfolioState(this.accountOp.accountAddr)
    const currentPortfolioNetwork = currentPortfolio[this.accountOp.chainId.toString()]

    const currentPortfolioNetworkNative = currentPortfolioNetwork?.result?.tokens.find(
      (token) => token.address === '0x0000000000000000000000000000000000000000'
    )
    if (!this.isSponsored && !currentPortfolioNetworkNative)
      errors.push({
        title:
          'Unable to estimate the transaction fee as fetching the latest price update for the network native token failed. Please try again later.'
      })

    // if there's no gasFeePayment calculate but there is: 1) feeTokenResult
    // 2) selectedOption and 3) gasSpeeds for selectedOption => return an error
    if (
      !this.isSponsored &&
      !this.accountOp.gasFeePayment &&
      this.feeTokenResult &&
      this.selectedOption
    ) {
      const identifier = getFeeSpeedIdentifier(
        this.selectedOption,
        this.accountOp.accountAddr,
        this.rbfAccountOps[this.selectedOption.paidBy]
      )
      if (this.hasSpeeds(identifier))
        errors.push({
          title: 'Please select a token and an account for paying the gas fee.'
        })
    }

    if (
      !this.isSponsored &&
      this.selectedOption &&
      this.accountOp.gasFeePayment &&
      this.selectedOption.availableAmount < this.accountOp.gasFeePayment.amount
    ) {
      const speedCoverage = []
      const identifier = getFeeSpeedIdentifier(
        this.selectedOption,
        this.accountOp.accountAddr,
        this.rbfAccountOps[this.selectedOption.paidBy]
      )

      if (this.feeSpeeds[identifier]) {
        this.feeSpeeds[identifier].forEach((speed) => {
          if (this.selectedOption && this.selectedOption.availableAmount >= speed.amount)
            speedCoverage.push(speed.type)
        })
      }

      if (speedCoverage.length === 0) {
        const isSA = isSmartAccount(this.account)
        const isUnableToCoverWithAllOtherTokens = this.estimation.availableFeeOptions.every(
          (option) => {
            if (option === this.selectedOption) return true
            const optionIdentifier = getFeeSpeedIdentifier(
              option,
              this.accountOp.accountAddr,
              this.rbfAccountOps[option.paidBy]
            )

            const speedsThatCanCover = this.feeSpeeds[optionIdentifier]?.filter(
              (speed) => speed.amount <= option.availableAmount
            )

            return !speedsThatCanCover?.length
          }
        )
        if (isUnableToCoverWithAllOtherTokens) {
          let skippedTokensCount = 0
          const gasTokenNames = gasTankFeeTokens
            .filter(({ chainId, hiddenOnError }) => {
              if (chainId !== this.accountOp.chainId) return false

              if (hiddenOnError) {
                skippedTokensCount++
                return false
              }

              return true
            })
            .map(({ symbol }) => symbol.toUpperCase())
            .join(', ')

          errors.push({
            title: `${ERRORS.eoaInsufficientFunds}${
              isSA
                ? ` Available fee options: USDC in Gas Tank, ${gasTokenNames}${
                    skippedTokensCount ? ' and others' : ''
                  }`
                : ''
            }`
          })
        } else {
          errors.push({
            title: isSA
              ? "Signing is not possible with the selected account's token as it doesn't have sufficient funds to cover the gas payment fee."
              : ERRORS.eoaInsufficientFunds
          })
        }
      } else {
        errors.push({
          title:
            'The selected speed is not available due to insufficient funds. Please select a slower speed.'
        })
      }
    }

    // The signing might fail, tell the user why but allow the user to retry signing,
    // @ts-ignore fix TODO: type mismatch
    if (this.status?.type === SigningStatus.ReadyToSign && !!this.status.error) {
      // @ts-ignore typescript complains, but the error being present gets checked above
      errors.push(this.status.error)
    }

    if (!this.isSponsored && !this.#feeSpeedsLoading && this.selectedOption) {
      const identifier = getFeeSpeedIdentifier(
        this.selectedOption,
        this.accountOp.accountAddr,
        this.rbfAccountOps[this.selectedOption.paidBy]
      )
      if (!this.hasSpeeds(identifier)) {
        if (!this.feeTokenResult?.priceIn.length) {
          errors.push({
            title: `Currently, ${this.feeTokenResult?.symbol} is unavailable as a fee token as we're experiencing troubles fetching its price. Please select another or contact support`
          })
        } else {
          errors.push({
            title:
              'Unable to estimate the transaction fee. Please try changing the fee token or contact support.'
          })
        }
      }
    }

    return errors
  }

  get readyToSign() {
    return (
      !!this.status &&
      (this.status?.type === SigningStatus.ReadyToSign ||
        this.status?.type === SigningStatus.UpdatesPaused)
    )
  }

  calculateWarnings() {
    const warnings: Warning[] = []

    const latestState = this.#portfolio.getLatestPortfolioState(this.accountOp.accountAddr)
    const pendingState = this.#portfolio.getPendingPortfolioState(this.accountOp.accountAddr)

    const significantBalanceDecreaseWarning = getSignificantBalanceDecreaseWarning(
      latestState,
      pendingState,
      this.accountOp.chainId,
      this.traceCallDiscoveryStatus
    )

    if (this.selectedOption) {
      const identifier = getFeeSpeedIdentifier(
        this.selectedOption,
        this.accountOp.accountAddr,
        this.rbfAccountOps[this.selectedOption.paidBy]
      )
      const feeTokenHasPrice = this.feeSpeeds[identifier]?.every((speed) => !!speed.amountUsd)
      const feeTokenPriceUnavailableWarning = getFeeTokenPriceUnavailableWarning(
        !!this.hasSpeeds(identifier),
        feeTokenHasPrice
      )

      // push the warning only if the txn is not sponsored
      if (!this.isSponsored && feeTokenPriceUnavailableWarning)
        warnings.push(feeTokenPriceUnavailableWarning)
    }

    if (significantBalanceDecreaseWarning) warnings.push(significantBalanceDecreaseWarning)

    // if 7702 EOA that is not ambire
    // and another delegation is there, show the warning
    const broadcastOption = this.selectedOption
      ? this.baseAccount.getBroadcastOption(this.selectedOption, {
          op: this.accountOp,
          isSponsored: this.isSponsored
        })
      : null
    if (
      'is7702' in this.baseAccount &&
      this.baseAccount.is7702 &&
      this.delegatedContract &&
      this.delegatedContract !== ZeroAddress &&
      this.delegatedContract?.toLowerCase() !== EIP_7702_AMBIRE_ACCOUNT.toLowerCase() &&
      (!this.accountOp.meta || this.accountOp.meta.setDelegation === undefined) &&
      (broadcastOption === BROADCAST_OPTIONS.byBundler ||
        broadcastOption === BROADCAST_OPTIONS.delegation)
    ) {
      warnings.push(WARNINGS.delegationDetected)
    }

    const estimationWarnings = this.estimation.calculateWarnings()

    this.warnings = warnings.concat(estimationWarnings)

    this.emitUpdate()
  }

  async simulate(shouldTraceCall: boolean = false) {
    // no simulation / estimation if we're in a signing state
    if (!this.canUpdate()) return

    if (shouldTraceCall) this.#traceCall(this)

    await Promise.all([
      this.#portfolio.simulateAccountOp(this.accountOp),
      this.estimation.estimate(this.accountOp).catch((e) => e)
    ])

    // calculate the warnings after the portfolio is fetched
    this.calculateWarnings()

    const estimation = this.estimation.estimation

    // estimation.flags.hasNonceDiscrepancy is a signal from the estimation
    // that we should update the portfolio to get a correct simulation
    if (estimation && estimation.ambireEstimation && estimation.flags.hasNonceDiscrepancy) {
      this.accountOp.nonce = BigInt(estimation.ambireEstimation.ambireAccountNonce)
      await this.#portfolio.simulateAccountOp(this.accountOp)
    }

    // if the portfolio detects a nonce discrepancy and the estimation is a Success,
    // refetch the account state, resimulate and put the correct nonce in accountOp
    const portfolioState = this.#portfolio.getPendingPortfolioState(this.accountOp.accountAddr)
    const pendingPortfolioState = portfolioState
      ? portfolioState[this.accountOp.chainId.toString()]
      : null
    if (
      this.estimation.status === EstimationStatus.Success &&
      pendingPortfolioState &&
      pendingPortfolioState.criticalError?.simulationErrorMsg &&
      pendingPortfolioState.criticalError?.simulationErrorMsg.indexOf('nonce did not increment') !==
        -1
    ) {
      const pendingAccountState = await this.#accounts.forceFetchPendingState(
        this.accountOp.accountAddr,
        this.accountOp.chainId
      )
      this.accountOp.nonce = pendingAccountState.nonce
      await this.#portfolio.simulateAccountOp(this.accountOp)
    }

    // if there's an estimation error, override the pending results
    if (this.estimation.status === EstimationStatus.Error) {
      this.#portfolio.overridePendingResults(this.accountOp)
    }
  }

  async estimate() {
    await this.estimation.estimate(this.accountOp)
  }

  async portfolioSimulate() {
    await this.#portfolio.simulateAccountOp(this.accountOp)
  }

  update({
    gasPrices,
    feeToken,
    paidBy,
    speed,
    signingKeyAddr,
    signingKeyType,
    calls,
    rbfAccountOps,
    bundlerGasPrices,
    blockGasLimit,
    signedTransactionsCount,
    hasNewEstimation
  }: SignAccountOpUpdateProps) {
    try {
      // This must be at the top, otherwise it won't be updated because
      // most updates are frozen during the signing process
      if (typeof signedTransactionsCount !== 'undefined') {
        this.signedTransactionsCount = signedTransactionsCount
        // If we add other exclusions we should figure out a way to emitUpdate only once
        this.emitUpdate()
        return
      }

      // once the user commits to the things he sees on his screen,
      // we need to be sure nothing changes afterwards.
      // For example, signing can be slow if it's done by a hardware wallet.
      // The estimation gets refreshed on the other hand each 12 seconds (6 on optimism)
      // If we allow the estimation to affect the controller state during sign,
      // there could be discrepancy between what the user has agreed upon and what
      // we broadcast in the end
      if (this.status?.type && noStateUpdateStatuses.indexOf(this.status?.type) !== -1) {
        return
      }

      if (this.estimation.status === EstimationStatus.Success) {
        const estimation = this.estimation.estimation as FullEstimationSummary
        if (estimation.ambireEstimation) {
          this.accountOp.nonce = BigInt(estimation.ambireEstimation.ambireAccountNonce)
        }
        if (estimation.bundlerEstimation) {
          this.bundlerGasPrices = estimation.bundlerEstimation.gasPrice
        }
      }

      if (Array.isArray(calls)) {
        // we should update if the arrays are with diff length
        let shouldUpdate = this.accountOp.calls.length !== calls.length

        if (!shouldUpdate) {
          // if they are with the same length, check if some of
          // their properties differ. If they do, we should update
          this.accountOp.calls.forEach((call, i) => {
            const newCall = calls[i]
            if (
              call.to !== newCall.to ||
              call.data !== newCall.data ||
              call.value !== newCall.value
            )
              shouldUpdate = true
          })
        }

        // update only if there are differences in the calls array
        // we do this to prevent double estimation problems
        if (shouldUpdate) {
          const hasNewCalls = this.accountOp.calls.length < calls.length
          this.accountOp.calls = calls

          if (hasNewCalls) this.learnTokensFromCalls()
          this.#shouldSimulate ? this.simulate(hasNewCalls) : this.estimate()
        }
      }

      if (blockGasLimit) this.#blockGasLimit = blockGasLimit

      if (gasPrices) this.gasPrices = gasPrices

      if (feeToken && paidBy) {
        this.paidBy = paidBy
        this.feeTokenResult = feeToken
      }

      if (speed && this.isInitialized) {
        this.selectedFeeSpeed = speed
      }

      if (signingKeyAddr && signingKeyType && this.isInitialized) {
        this.accountOp.signingKeyAddr = signingKeyAddr
        this.accountOp.signingKeyType = signingKeyType
      }

      // set the rbf is != undefined
      if (rbfAccountOps) this.rbfAccountOps = rbfAccountOps

      // Set defaults, if some of the optional params are omitted
      this.#setDefaults()

      if (
        this.estimation.status === EstimationStatus.Success &&
        this.paidBy &&
        this.feeTokenResult
      ) {
        const selectedOption = this.estimation.availableFeeOptions.find(
          (option) =>
            option.paidBy === this.paidBy &&
            option.token.address === this.feeTokenResult!.address &&
            option.token.symbol.toLocaleLowerCase() ===
              this.feeTokenResult!.symbol.toLocaleLowerCase() &&
            option.token.flags.onGasTank === this.feeTokenResult!.flags.onGasTank
        )
        // <Bobby>: trigger setting the real default speed just before
        // setting the first selectedOption. This way we know all the
        // necessary information like available amount for the selected
        // option so we could calculate the fee speed if he doesn't have
        // enough for fast but has enough for slow/medium
        if (selectedOption) this.#setDefaultFeeSpeed(selectedOption)
        this.selectedOption = selectedOption
      }

      if (
        bundlerGasPrices &&
        bundlerGasPrices.bundler === this.bundlerSwitcher.getBundler().getName()
      ) {
        this.bundlerGasPrices = bundlerGasPrices.speeds
      }

      if (
        this.estimation.estimation &&
        this.estimation.estimation.bundlerEstimation &&
        this.estimation.estimation.bundlerEstimation.paymaster
      ) {
        // if it was sponsored but it no longer is (fallback case),
        // reset the selectedOption option as we use native for the sponsorship
        // but the user might not actually have any native
        const isSponsorshipFallback =
          this.isSponsored && !this.estimation.estimation.bundlerEstimation.paymaster.isSponsored()

        this.isSponsored = this.estimation.estimation.bundlerEstimation.paymaster.isSponsored()
        this.sponsor =
          this.estimation.estimation.bundlerEstimation.paymaster.getEstimationData()?.sponsor

        if (isSponsorshipFallback) {
          this.selectedOption = this.estimation.availableFeeOptions.length
            ? this.estimation.availableFeeOptions[0]
            : undefined
        }
      }

      // calculate the fee speeds if either there are no feeSpeeds
      // or any of properties for update is requested
      if (
        !Object.keys(this.feeSpeeds).length ||
        Array.isArray(calls) ||
        gasPrices ||
        this.paidBy ||
        this.feeTokenResult ||
        hasNewEstimation ||
        bundlerGasPrices
      ) {
        this.#updateFeeSpeeds()
      }

      // Here, we expect to have most of the fields set, so we can safely set GasFeePayment
      this.#setGasFeePayment()
      this.updateStatus()
      this.calculateWarnings()
    } catch (e: any) {
      this.emitError({
        message: 'Error updating the SignAccountOpController',
        error: e,
        level: 'silent'
      })
    }
  }

  updateStatus(forceStatusChange?: SigningStatus, replacementFeeLow = false) {
    // use this to go back to ReadyToSign when a broadcasting error is emitted
    if (forceStatusChange) {
      this.status = { type: forceStatusChange }
      this.emitUpdate()
      return
    }

    // no status updates on these two
    const isInTheMiddleOfSigning =
      this.status?.type === SigningStatus.InProgress ||
      this.status?.type === SigningStatus.WaitingForPaymaster
    const isDone = this.status?.type === SigningStatus.Done
    if (isInTheMiddleOfSigning || isDone) return

    // if we have an estimation error, set the state so and return
    if (this.estimation.error) {
      this.status = { type: SigningStatus.EstimationError }
      this.emitUpdate()
      return
    }

    if (this.errors.length) {
      this.status = { type: SigningStatus.UnableToSign }
      this.emitUpdate()
      return
    }

    if (
      this.isInitialized &&
      this.accountOp.signingKeyAddr &&
      this.accountOp.signingKeyType &&
      this.accountOp.gasFeePayment
    ) {
      this.status = { type: SigningStatus.ReadyToSign }

      // do not reset this once triggered
      if (replacementFeeLow) this.replacementFeeLow = replacementFeeLow
      this.emitUpdate()
      return
    }

    // reset the status if a valid state was not found
    this.status = null
    this.emitUpdate()
  }

  reset() {
    this.estimation.reset()
    this.gasPrice.reset()
    this.gasPrices = undefined
    this.selectedFeeSpeed = FeeSpeed.Fast
    this.paidBy = null
    this.feeTokenResult = null
    this.status = null
    this.signedTransactionsCount = null
    this.emitUpdate()
  }

  resetStatus() {
    this.status = null
    this.emitUpdate()
  }

  /**
   * Obtain the native token ratio in relation to a fee token.
   *
   * By knowing the USD value of the tokens in the portfolio,
   * we can calculate the ratio between a native token and a fee token.
   *
   * For example, 1 ETH = 8 BNB (ratio: 8).
   *
   * We require the ratio to be in a BigInt format since all the application values,
   * such as amount, gasLimit, etc., are also represented as BigInt numbers.
   */
  #getNativeToFeeTokenRatio(feeToken: TokenResult): bigint | null {
    const native = this.#portfolio
      .getLatestPortfolioState(this.accountOp.accountAddr)
      [this.accountOp.chainId.toString()]?.result?.tokens.find(
        (token) => token.address === '0x0000000000000000000000000000000000000000'
      )
    if (!native) return null

    // In case the fee token is the native token we don't want to depend to priceIn, as it might not be available.
    if (native.address === feeToken.address && native.chainId === feeToken.chainId)
      return BigInt(1 * 1e18)

    const isUsd = (price: Price) => price.baseCurrency === 'usd'

    const nativePrice = native.priceIn.find(isUsd)?.price
    const feeTokenPrice = feeToken.priceIn.find(isUsd)?.price

    if (!nativePrice || !feeTokenPrice) return null

    const ratio = nativePrice / feeTokenPrice

    // Here we multiply it by 1e18, in order to keep the decimal precision.
    // Otherwise, passing the ratio to the BigInt constructor, we will lose the numbers after the decimal point.
    // Later, once we need to normalize this ratio, we should not forget to divide it by 1e18.
    const ratio1e18 = ratio * 1e18
    const toBigInt = ratio1e18 % 1 === 0 ? ratio1e18 : ratio1e18.toFixed(0)
    return BigInt(toBigInt)
  }

  static getAmountAfterFeeTokenConvert(
    simulatedGasLimit: bigint,
    gasPrice: bigint,
    nativeRatio: bigint,
    feeTokenDecimals: number,
    addedNative: bigint
  ) {
    const amountInWei = simulatedGasLimit * gasPrice + addedNative

    // Let's break down the process of converting the amount into FeeToken:
    // 1. Initially, we multiply the amount in wei by the native to fee token ratio.
    // 2. Next, we address the decimal places:
    // 2.1. First, we convert wei to native by dividing by 10^18 (representing the decimals).
    // 2.2. Now, with the amount in the native token, we incorporate nativeRatio decimals into the calculation (18 + 18) to standardize the amount.
    // 2.3. At this point, we precisely determine the number of fee tokens. For instance, if the amount is 3 USDC, we must convert it to a BigInt value, while also considering feeToken.decimals.
    const extraDecimals = BigInt(10 ** 18)
    const feeTokenExtraDecimals = BigInt(10 ** (18 - feeTokenDecimals))
    const pow = extraDecimals * feeTokenExtraDecimals
    const result = (amountInWei * nativeRatio) / pow

    // Fixes the edge case where the fee in wei is not zero
    // but the decimals of the token we are converting to
    // cannot represent the amount in wei. Example: 0.(6zeros)1 USDC
    // We are returning 1n which is the smallest possible amount
    // to be represented in USDC
    if (result === 0n && amountInWei !== 0n) {
      return 1n
    }

    return result
  }

  /**
   * Increase the paymaster fee by 10%, the relayer by 5%.
   * This is required because even now, we are broadcasting at a loss
   */
  #increaseFee(amount: bigint, broadcaster: string = 'relayer'): bigint {
    if (broadcaster === 'paymaster') return amount + amount / 10n
    return amount + amount / 20n
  }

  #addExtra(gasInWei: bigint, percentageIncrease: bigint): Hex {
    const percent = 100n / percentageIncrease
    return toBeHex(gasInWei + gasInWei / percent) as Hex
  }

  /**
   * What is a good UX?
   * In the 4337 broadcast model, fee speeds don't make sense. That is
   * because it doesn't matter if you choose slow or fast, if the bundler
   * accepts the userOp, he is obliged to broadcast it as soon as possible.
   * Also, some bundlers return a single value for gas prices, meaning all
   * speed options should have the same cost
   *
   * But Ethereum UX doesn't work liket this.
   * Users expect to see a broadcast speed in the wallet itself and if
   * it's not present, they will find it strange.
   *
   * The soluiton here is to create the illusion of speeds in the 4337
   * broadcast model by increasing them only for the user payment but
   * using the original, bundler provided ones for broadcast.
   * That way we get a better bundler userOp acceptance rate and a
   * normal, intuitive UX
   */
  #getIncreasedBundlerGasPrices(): GasSpeeds | null {
    if (!this.bundlerGasPrices) return null

    return {
      slow: {
        maxFeePerGas: this.#addExtra(BigInt(this.bundlerGasPrices.slow.maxFeePerGas), 5n),
        maxPriorityFeePerGas: this.#addExtra(
          BigInt(this.bundlerGasPrices.slow.maxPriorityFeePerGas),
          5n
        )
      },
      medium: {
        maxFeePerGas: this.#addExtra(BigInt(this.bundlerGasPrices.medium.maxFeePerGas), 7n),
        maxPriorityFeePerGas: this.#addExtra(
          BigInt(this.bundlerGasPrices.medium.maxPriorityFeePerGas),
          7n
        )
      },
      fast: {
        maxFeePerGas: this.#addExtra(BigInt(this.bundlerGasPrices.fast.maxFeePerGas), 10n),
        maxPriorityFeePerGas: this.#addExtra(
          BigInt(this.bundlerGasPrices.fast.maxPriorityFeePerGas),
          10n
        )
      },
      ape: {
        maxFeePerGas: this.#addExtra(BigInt(this.bundlerGasPrices.ape.maxFeePerGas), 20n),
        maxPriorityFeePerGas: this.#addExtra(
          BigInt(this.bundlerGasPrices.ape.maxPriorityFeePerGas),
          20n
        )
      }
    }
  }

  get #feeSpeedsLoading() {
    return !this.isInitialized || !this.gasPrices
  }

  #setDefaultFeeSpeed(feePaymentOption: FeePaymentOption) {
    // don't update if an option is already set
    if (this.selectedOption) return

    const identifier = getFeeSpeedIdentifier(
      feePaymentOption,
      this.account.addr,
      this.rbfAccountOps[feePaymentOption.paidBy]
    )
    const speeds = this.feeSpeeds[identifier]
    if (!speeds) return

    // set fast if available
    if (speeds.find(({ type, disabled }) => type === FeeSpeed.Fast && !disabled)) {
      this.selectedFeeSpeed = FeeSpeed.Fast
      return
    }

    // set at least slow
    const fastestEnabledSpeed = [...speeds].reverse().find(({ disabled }) => !disabled)
    this.selectedFeeSpeed = fastestEnabledSpeed?.type || FeeSpeed.Slow
  }

  #updateFeeSpeeds() {
    if (this.estimation.status !== EstimationStatus.Success || !this.gasPrices) return

    const estimation = this.estimation.estimation as FullEstimationSummary

    // reset the fee speeds at the beginning to avoid duplications
    this.feeSpeeds = {}

    this.estimation.availableFeeOptions.forEach((option) => {
      // if a calculation has been made, do not make it again
      // EOA pays for SA is the most common case for this scenario
      //
      // addition: make sure there's no rbfAccountOps as well
      const identifier = getFeeSpeedIdentifier(
        option,
        this.accountOp.accountAddr,
        this.rbfAccountOps[option.paidBy]
      )
      if (this.hasSpeeds(identifier)) {
        return
      }

      const nativeRatio = this.#getNativeToFeeTokenRatio(option.token)
      if (!nativeRatio) {
        this.feeSpeeds[identifier] = []
        return
      }

      // get the gas used for each payment option
      const gasUsed = this.baseAccount.getGasUsed(estimation, {
        feeToken: option.token,
        op: this.accountOp
      })

      // each available fee option should declare it's estimation method
      const broadcastOption = this.baseAccount.getBroadcastOption(option, {
        op: this.accountOp,
        isSponsored: this.isSponsored
      })
      if (broadcastOption === BROADCAST_OPTIONS.byBundler) {
        const increasedGasPrices = this.#getIncreasedBundlerGasPrices()
        if (!estimation.bundlerEstimation || !increasedGasPrices) return

        const speeds: SpeedCalc[] = []
        const usesPaymaster = estimation.bundlerEstimation?.paymaster.isUsable()

        for (const [speed, speedValue] of Object.entries(increasedGasPrices)) {
          const simulatedGasLimit =
            BigInt(gasUsed) +
            BigInt(estimation.bundlerEstimation.preVerificationGas) +
            BigInt(option.gasUsed)
          const gasPrice = BigInt(speedValue.maxFeePerGas)
          let amount = SignAccountOpController.getAmountAfterFeeTokenConvert(
            simulatedGasLimit,
            gasPrice,
            nativeRatio,
            option.token.decimals,
            0n
          )
          if (usesPaymaster) amount = this.#increaseFee(amount, 'paymaster')

          speeds.push({
            type: speed as FeeSpeed,
            simulatedGasLimit,
            amount,
            amountFormatted: formatUnits(amount, Number(option.token.decimals)),
            amountUsd: getTokenUsdAmount(option.token, amount),
            gasPrice,
            maxPriorityFeePerGas: BigInt(speedValue.maxPriorityFeePerGas),
            disabled: (option.availableAmount || 0n) < amount
          })
        }

        if (this.feeSpeeds[identifier] === undefined) this.feeSpeeds[identifier] = []
        this.feeSpeeds[identifier] = speeds
        return
      }

      ;(this.gasPrices || []).forEach((gasRecommendation) => {
        let amount
        let simulatedGasLimit: bigint

        // get the calculate fees by our script
        let maxPriorityFeePerGas =
          'maxPriorityFeePerGas' in gasRecommendation
            ? gasRecommendation.maxPriorityFeePerGas
            : undefined
        let gasPrice = maxPriorityFeePerGas
          ? (gasRecommendation as Gas1559Recommendation).baseFeePerGas + maxPriorityFeePerGas
          : (gasRecommendation as GasPriceRecommendation).gasPrice

        // the bundler does a better job than us for gas price estimations
        // so we prioritize their estimation over ours if there's any
        if (this.bundlerGasPrices) {
          const increasedGasPrices = this.#getIncreasedBundlerGasPrices()!
          const name = gasRecommendation.name as keyof GasSpeeds
          maxPriorityFeePerGas = BigInt(increasedGasPrices[name].maxPriorityFeePerGas)
          gasPrice = BigInt(increasedGasPrices[name].maxFeePerGas)
        }

        // EOA OR 7702: pays with native by itself
        if (
          broadcastOption === BROADCAST_OPTIONS.bySelf ||
          broadcastOption === BROADCAST_OPTIONS.bySelf7702
        ) {
          simulatedGasLimit = gasUsed

          this.accountOp.calls.forEach((call) => {
            if (call.to && getAddress(call.to) === SINGLETON) {
              simulatedGasLimit = getGasUsed(simulatedGasLimit)
            }
          })

          amount = simulatedGasLimit * gasPrice + option.addedNative
        } else if (broadcastOption === BROADCAST_OPTIONS.byOtherEOA) {
          // Smart account, but EOA pays the fee
          // 7702, and it pays for the fee by itself
          simulatedGasLimit = gasUsed
          amount = simulatedGasLimit * gasPrice + option.addedNative
        } else {
          // Relayer
          simulatedGasLimit = gasUsed + option.gasUsed
          amount = SignAccountOpController.getAmountAfterFeeTokenConvert(
            simulatedGasLimit,
            gasPrice,
            nativeRatio,
            option.token.decimals,
            option.addedNative
          )
          amount = this.#increaseFee(amount)
        }

        const feeSpeed: SpeedCalc = {
          type: gasRecommendation.name as FeeSpeed,
          simulatedGasLimit,
          amount,
          amountFormatted: formatUnits(amount, Number(option.token.decimals)),
          amountUsd: getTokenUsdAmount(option.token, amount),
          gasPrice,
          maxPriorityFeePerGas,
          disabled: option.availableAmount < amount
        }
        if (this.feeSpeeds[identifier] === undefined) this.feeSpeeds[identifier] = []
        this.feeSpeeds[identifier].push(feeSpeed)
      })
    })
  }

  #getGasFeePayment(): GasFeePayment | null {
    if (!this.isInitialized) {
      this.emitError({
        level: 'major',
        message:
          'Something went wrong while setting up the gas fee payment account and token. Please try again, selecting the account and token option. If the problem persists, contact support.',
        error: new Error(
          'SignAccountOpController: The controller is not initialized while we are trying to build GasFeePayment.'
        )
      })

      return null
    }
    if (!this.paidBy) {
      this.emitError({
        level: 'silent',
        message: '',
        error: new Error('SignAccountOpController: paying account not selected')
      })

      return null
    }
    if (!this.feeTokenResult) {
      this.emitError({
        level: 'silent',
        message: '',
        error: new Error('SignAccountOpController: fee token not selected')
      })

      return null
    }

    // if there are no availableFeeOptions, we don't have a gasFee
    // this is normal though as there are such cases:
    // - EOA paying in native but doesn't have any native
    // so no error should pop out because of this
    if (!this.estimation.availableFeeOptions.length) {
      return null
    }

    if (!this.selectedOption) {
      this.emitError({
        level: 'silent',
        message: '',
        error: new Error('SignAccountOpController: paying option not found')
      })

      return null
    }

    // if there are no fee speeds available for the option, it means
    // the nativeRatio could not be calculated. In that case, we do not
    // emit an error here but proceed and show an explanation to the user
    // in get errors()
    // check test: Signing [Relayer]: ... priceIn | native/Ratio
    const identifier = getFeeSpeedIdentifier(
      this.selectedOption,
      this.accountOp.accountAddr,
      this.rbfAccountOps[this.selectedOption.paidBy]
    )
    if (!this.feeSpeeds[identifier] || !this.feeSpeeds[identifier].length) {
      return null
    }

    const chosenSpeed = this.feeSpeeds[identifier].find(
      (speed) => speed.type === this.selectedFeeSpeed
    )
    if (!chosenSpeed) {
      this.emitError({
        level: 'silent',
        message: '',
        error: new Error('SignAccountOpController: fee speed not selected')
      })

      return null
    }

    return {
      paidBy: this.paidBy,
      isGasTank: this.feeTokenResult.flags.onGasTank,
      inToken: this.feeTokenResult.address,
      feeTokenChainId: this.feeTokenResult.chainId,
      amount: chosenSpeed.amount,
      simulatedGasLimit: chosenSpeed.simulatedGasLimit,
      gasPrice: chosenSpeed.gasPrice,
      maxPriorityFeePerGas:
        'maxPriorityFeePerGas' in chosenSpeed ? chosenSpeed.maxPriorityFeePerGas : undefined,
      broadcastOption: this.baseAccount.getBroadcastOption(this.selectedOption, {
        op: this.accountOp,
        isSponsored: this.isSponsored
      })
    }
  }

  get feeToken(): string | null {
    return this.accountOp.gasFeePayment?.inToken || null
  }

  get feePaidBy(): string | null {
    return this.accountOp.gasFeePayment?.paidBy || null
  }

  get accountKeyStoreKeys(): Key[] {
    return this.#keystore.keys.filter((key) => this.account.associatedKeys.includes(key.addr))
  }

  // eslint-disable-next-line class-methods-use-this
  get speedOptions() {
    return Object.values(FeeSpeed) as string[]
  }

  get gasSavedUSD(): number | null {
    if (!this.selectedOption?.token.flags.onGasTank) return null

    const identifier = getFeeSpeedIdentifier(
      this.selectedOption,
      this.accountOp.accountAddr,
      this.rbfAccountOps[this.selectedOption.paidBy]
    )
    const selectedFeeSpeedData = this.feeSpeeds[identifier].find(
      (speed) => speed.type === this.selectedFeeSpeed
    )
    const gasPrice = selectedFeeSpeedData?.gasPrice
    if (!gasPrice) return null

    // get the native token from the portfolio to calculate prices
    const native = this.#portfolio
      .getLatestPortfolioState(this.accountOp.accountAddr)
      [this.accountOp.chainId.toString()]?.result?.tokens.find(
        (token) => token.address === '0x0000000000000000000000000000000000000000'
      )
    if (!native) return null
    const nativePrice = native.priceIn.find((price) => price.baseCurrency === 'usd')?.price
    if (!nativePrice) return null

    // 4337 gasUsed is set to 0 in the estimation as we rely
    // on the bundler for the estimation entirely => use hardcode value
    const gasUsedSelectedOption =
      this.selectedOption.gasUsed > 0n ? this.selectedOption.gasUsed : GAS_TANK_TRANSFER_GAS_USED
    const isNativeSelected = this.selectedOption.token.address === ZeroAddress
    const gasUsedNative =
      this.estimation.availableFeeOptions.find(
        (option) => option.token.address === ZeroAddress && !option.token.flags.onGasTank
      )?.gasUsed || SA_NATIVE_TRANSFER_GAS_USED
    const gasUsedERC20 =
      this.estimation.availableFeeOptions.find(
        (option) => option.token.address !== ZeroAddress && !option.token.flags.onGasTank
      )?.gasUsed || SA_ERC20_TRANSFER_GAS_USED

    const gasUsedWithoutGasTank = isNativeSelected ? gasUsedNative : gasUsedERC20
    const gasSavedInNative = formatEther((gasUsedWithoutGasTank - gasUsedSelectedOption) * gasPrice)

    return Number(gasSavedInNative) * nativePrice
  }

  #emitSigningErrorAndResetToReadyToSign(error: string) {
    this.emitError({ level: 'major', message: error, error: new Error(error) })
    this.status = { type: SigningStatus.ReadyToSign }

    this.emitUpdate()
  }

  #addFeePayment() {
    // In case of gas tank token fee payment, we need to include one more call to account op
    const abiCoder = new AbiCoder()

    if (this.isSponsored) {
      this.accountOp.feeCall = {
        to: FEE_COLLECTOR,
        value: 0n,
        data: abiCoder.encode(['string', 'uint256', 'string'], ['gasTank', 0n, 'USDC'])
      }

      return
    }

    if (this.accountOp.gasFeePayment!.isGasTank) {
      this.accountOp.feeCall = {
        to: FEE_COLLECTOR,
        value: 0n,
        data: abiCoder.encode(
          ['string', 'uint256', 'string'],
          ['gasTank', this.accountOp.gasFeePayment!.amount, this.feeTokenResult?.symbol]
        )
      }

      return
    }

    if (this.accountOp.gasFeePayment!.inToken === '0x0000000000000000000000000000000000000000') {
      // native payment
      this.accountOp.feeCall = {
        to: FEE_COLLECTOR,
        value: this.accountOp.gasFeePayment!.amount,
        data: '0x'
      }
    } else {
      // token payment
      const ERC20Interface = new Interface(ERC20.abi)
      this.accountOp.feeCall = {
        to: this.accountOp.gasFeePayment!.inToken,
        value: 0n,
        data: ERC20Interface.encodeFunctionData('transfer', [
          FEE_COLLECTOR,
          this.accountOp.gasFeePayment!.amount
        ])
      }
    }
  }

  async #getInitialUserOp(
    shouldReestimate: boolean,
    eip7702Auth?: EIP7702Auth
  ): Promise<UserOperation> {
    const gasFeePayment = this.accountOp.gasFeePayment!
    let erc4337Estimation = this.estimation.estimation!.bundlerEstimation as Erc4337GasLimits
    const accountState = await this.#accounts.getOrFetchAccountOnChainState(
      this.accountOp.accountAddr,
      this.accountOp.chainId
    )

    if (shouldReestimate) {
      const newEstimate = await bundlerEstimate(
        this.baseAccount,
        accountState,
        this.accountOp,
        this.#network,
        [this.selectedOption!.token],
        this.provider,
        this.bundlerSwitcher,
        () => {},
        eip7702Auth
      )

      if (!(newEstimate instanceof Error)) {
        erc4337Estimation = newEstimate as Erc4337GasLimits
        this.bundlerGasPrices = erc4337Estimation.gasPrice

        gasFeePayment.gasPrice = BigInt(this.bundlerGasPrices[this.selectedFeeSpeed!].maxFeePerGas)
        gasFeePayment.maxPriorityFeePerGas = BigInt(
          this.bundlerGasPrices[this.selectedFeeSpeed!].maxPriorityFeePerGas
        )
      }
    }

    const userOperation = getUserOperation(
      this.account,
      accountState,
      this.accountOp,
      this.bundlerSwitcher.getBundler().getName(),
      this.accountOp.meta?.entryPointAuthorization,
      eip7702Auth
    )

    userOperation.preVerificationGas = erc4337Estimation.preVerificationGas
    userOperation.callGasLimit = toBeHex(
      BigInt(erc4337Estimation.callGasLimit) + this.selectedOption!.gasUsed
    )
    userOperation.verificationGasLimit = erc4337Estimation.verificationGasLimit

    try {
      // for broadcast, use the original ones provided by the bundler as is
      // wrapping in a try-catch just-in-case as we don't want this to brick
      // the extension if something unexpected occurs
      //
      // why use the original?
      // the 4337 broadcast model depends on taking the original bundler values
      // and not tampering with them
      userOperation.maxFeePerGas = this.bundlerGasPrices![this.selectedFeeSpeed!].maxFeePerGas
      userOperation.maxPriorityFeePerGas =
        this.bundlerGasPrices![this.selectedFeeSpeed!].maxPriorityFeePerGas
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('Unable to set the original bundler gas prices, using the increased ones', e)
      userOperation.maxFeePerGas = toBeHex(gasFeePayment.gasPrice)
      userOperation.maxPriorityFeePerGas = toBeHex(gasFeePayment.maxPriorityFeePerGas!)
    }

    const ambireAccount = new Interface(AmbireAccount.abi)
    userOperation.callData = ambireAccount.encodeFunctionData('executeBySender', [
      getSignableCalls(this.accountOp)
    ])

    return userOperation
  }

  async #getPaymasterUserOp(
    originalUserOp: UserOperation,
    paymaster: AbstractPaymaster,
    eip7702Auth?: EIP7702Auth,
    counter = 0
  ): Promise<{
    required: boolean
    success?: boolean
    userOp?: UserOperation
    errorResponse?: PaymasterErrorReponse
  }> {
    if (!paymaster.isUsable()) return { required: false }

    const localOp = { ...originalUserOp }

    // set the paymaster properties
    const erc4337Estimation = this.estimation.estimation!.bundlerEstimation as Erc4337GasLimits
    localOp.paymasterVerificationGasLimit = erc4337Estimation.paymasterVerificationGasLimit
    localOp.paymasterPostOpGasLimit = erc4337Estimation.paymasterPostOpGasLimit

    // some bundlers (etherspot) don't return values for paymaster gas limits
    // so we need to set them manually
    // other (gelato) may return below the min
    if (paymaster.isEstimateBelowMin(localOp)) {
      const estimationData = paymaster.getEstimationData()!
      localOp.paymasterVerificationGasLimit = estimationData.paymasterVerificationGasLimit
      localOp.paymasterPostOpGasLimit = estimationData.paymasterPostOpGasLimit
    }

    // persist the paymaster properties from the pm_stubData request if any
    if (paymaster.isSponsored() && paymaster.sponsorDataEstimation) {
      if (paymaster.sponsorDataEstimation.paymasterVerificationGasLimit) {
        localOp.paymasterVerificationGasLimit =
          paymaster.sponsorDataEstimation.paymasterVerificationGasLimit
      }
      if (paymaster.sponsorDataEstimation.paymasterPostOpGasLimit) {
        localOp.paymasterPostOpGasLimit = paymaster.sponsorDataEstimation.paymasterPostOpGasLimit
      }
    }
    const response = await paymaster.call(this.account, this.accountOp, localOp, this.#network)

    if (response.success) {
      const paymasterData = response as PaymasterSuccessReponse
      localOp.paymaster = paymasterData.paymaster
      localOp.paymasterData = paymasterData.paymasterData
      return {
        userOp: localOp,
        required: true,
        success: true
      }
    }

    const errorResponse = response as PaymasterErrorReponse
    if (errorResponse.message.indexOf('invalid account nonce') !== -1) {
      // silenly continuing on error as this is an attempt for an UX improvement
      await this.#accounts
        .updateAccountState(this.accountOp.accountAddr, 'pending', [this.accountOp.chainId])
        .catch((e) => e)
    }

    // auto-retry once if it was the ambire paymaster
    if (paymaster.canAutoRetryOnFailure() && counter === 0) {
      const reestimatedUserOp = await this.#getInitialUserOp(true, eip7702Auth)
      return this.#getPaymasterUserOp(reestimatedUserOp, paymaster, eip7702Auth, counter + 1)
    }

    return {
      required: true,
      success: false,
      errorResponse
    }
  }

  async sign() {
    if (!this.readyToSign) {
      const message = `Unable to sign the transaction. During the preparation step, the necessary transaction data was not received. ${RETRY_TO_INIT_ACCOUNT_OP_MSG}`
      return this.#emitSigningErrorAndResetToReadyToSign(message)
    }

    // when signing begings, we stop immediatelly state updates on the controller
    // by changing the status to InProgress. Check update() for more info
    this.status = { type: SigningStatus.InProgress }

    if (!this.accountOp.signingKeyAddr || !this.accountOp.signingKeyType) {
      const message = `Unable to sign the transaction. During the preparation step, required signing key information was found missing. ${RETRY_TO_INIT_ACCOUNT_OP_MSG}`
      return this.#emitSigningErrorAndResetToReadyToSign(message)
    }

    if (!this.accountOp.gasFeePayment || !this.selectedOption) {
      const message = `Unable to sign the transaction. During the preparation step, required information about paying the gas fee was found missing. ${RETRY_TO_INIT_ACCOUNT_OP_MSG}`
      return this.#emitSigningErrorAndResetToReadyToSign(message)
    }

    const signer = await this.#keystore.getSigner(
      this.accountOp.signingKeyAddr,
      this.accountOp.signingKeyType
    )
    if (!signer) {
      const message = `Unable to sign the transaction. During the preparation step, required account key information was found missing. ${RETRY_TO_INIT_ACCOUNT_OP_MSG}`
      return this.#emitSigningErrorAndResetToReadyToSign(message)
    }

    if (!this.estimation.estimation) {
      const message = `Unable to sign the transaction. During the preparation step, required account key information was found missing. ${RETRY_TO_INIT_ACCOUNT_OP_MSG}`
      return this.#emitSigningErrorAndResetToReadyToSign(message)
    }

    const estimation = this.estimation.estimation as FullEstimationSummary
    const broadcastOption = this.accountOp.gasFeePayment.broadcastOption
    const isUsingPaymaster = !!estimation.bundlerEstimation?.paymaster.isUsable()
    const shouldSignDeployAuth = this.baseAccount.shouldSignDeployAuth(broadcastOption)

    // tell the FE where we are
    if (shouldSignDeployAuth) {
      this.shouldSignAuth = {
        type: 'V2Deploy',
        text: 'Step 1/2 preparing account'
      }
    }

    if (
      broadcastOption === BROADCAST_OPTIONS.byBundler &&
      isUsingPaymaster &&
      !shouldSignDeployAuth
    ) {
      this.status = { type: SigningStatus.WaitingForPaymaster }
    } else {
      this.status = { type: SigningStatus.InProgress }
    }

    // we update the FE with the changed status (in progress) only after the checks
    // above confirm everything is okay to prevent two different state updates
    this.emitUpdate()

    if (signer.init) signer.init(this.#externalSignerControllers[this.accountOp.signingKeyType])

    // just in-case: before signing begins, we delete the feeCall;
    // if there's a need for it, it will be added later on in the code.
    // We need this precaution because this could happen:
    // - try to broadcast with the relayer
    // - the feel call gets added
    // - the relayer broadcast fails
    // - the user does another broadcast, this time with EOA pays for SA
    // - the fee call stays, causing a low gas limit revert
    delete this.accountOp.feeCall

    // delete the activatorCall as a precaution that it won't be added twice
    delete this.accountOp.activatorCall

    // @EntryPoint activation for SA
    if (this.baseAccount.shouldIncludeActivatorCall(broadcastOption)) {
      this.accountOp.activatorCall = getActivatorCall(this.accountOp.accountAddr)
    }

    const accountState = await this.#accounts.getOrFetchAccountOnChainState(
      this.accountOp.accountAddr,
      this.accountOp.chainId
    )

    try {
      // plain EOA
      if (
        broadcastOption === BROADCAST_OPTIONS.bySelf ||
        broadcastOption === BROADCAST_OPTIONS.bySelf7702
      ) {
        // rawTxn, No SA signatures
        // or 7702, calling executeBySender(). No SA signatures
        this.accountOp.signature = '0x'
      } else if (broadcastOption === BROADCAST_OPTIONS.byOtherEOA) {
        // SA, EOA pays fee. execute() needs a signature
        this.accountOp.signature = await getExecuteSignature(
          this.#network,
          this.accountOp,
          accountState,
          signer
        )
      } else if (broadcastOption === BROADCAST_OPTIONS.delegation) {
        // a delegation request has been made
        if (!this.accountOp.meta) this.accountOp.meta = {}

        const contract =
          this.accountOp.meta.setDelegation || this.accountOp.calls.length > 1
            ? getContractImplementation(this.#network.chainId)
            : (ZeroAddress as Hex)
        this.accountOp.meta.delegation = get7702Sig(
          this.#network.chainId,
          // because we're broadcasting by ourselves, we need to add 1 to the nonce
          // as the sender nonce (the curr acc) gets incremented before the
          // authrorization validation
          accountState.eoaNonce! + 1n,
          contract,
          signer.sign7702(
            getAuthorizationHash(this.#network.chainId, contract, accountState.eoaNonce! + 1n)
          )
        )
        this.accountOp.signature = '0x'
      } else if (broadcastOption === BROADCAST_OPTIONS.byBundler) {
        const erc4337Estimation = estimation.bundlerEstimation as Erc4337GasLimits

        const paymaster = erc4337Estimation.paymaster
        if (paymaster.shouldIncludePayment()) this.#addFeePayment()

        // fix three problems:
        // 1) when we do eip7702Auth, initial estimation is not enough
        // 2) we estimate with the gas tank but if the user chooses
        // native, it could result in low gas limit => txn price too low.
        // In both cases, we re-estimate before broadcast
        // 3) some bundlers require a re-estimate before broadcast
        let shouldReestimate =
          (!!erc4337Estimation.feeCallType &&
            paymaster.getFeeCallType([this.selectedOption.token]) !==
              erc4337Estimation.feeCallType) ||
          this.bundlerSwitcher.getBundler().shouldReestimateBeforeBroadcast(this.#network)

        // sign the 7702 authorization if needed
        let eip7702Auth
        if (this.baseAccount.shouldSignAuthorization(BROADCAST_OPTIONS.byBundler)) {
          const contract = getContractImplementation(this.#network.chainId)
          eip7702Auth = get7702Sig(
            this.#network.chainId,
            accountState.nonce,
            contract,
            signer.sign7702(
              getAuthorizationHash(this.#network.chainId, contract, accountState.nonce)
            )
          )

          shouldReestimate = true
        }

        if (shouldSignDeployAuth) {
          const epActivatorTypedData = await getEntryPointAuthorization(
            this.account.addr,
            this.#network.chainId,
            accountState.nonce
          )
          const epSignature = await getEIP712Signature(
            epActivatorTypedData,
            this.account,
            accountState,
            signer,
            this.#network
          )
          if (!this.accountOp.meta) this.accountOp.meta = {}
          this.accountOp.meta.entryPointAuthorization = adjustEntryPointAuthorization(epSignature)

          // after signing is complete, go to paymaster mode
          if (isUsingPaymaster) {
            this.shouldSignAuth = {
              type: 'V2Deploy',
              text: 'Step 2/2 signing transaction'
            }
            this.status = { type: SigningStatus.WaitingForPaymaster }
            this.emitUpdate()
          }

          shouldReestimate = true
        }

        const initialUserOp = await this.#getInitialUserOp(shouldReestimate, eip7702Auth)
        const paymasterInfo = await this.#getPaymasterUserOp(initialUserOp, paymaster, eip7702Auth)
        if (paymasterInfo.required) {
          if (paymasterInfo.success) {
            this.accountOp.gasFeePayment.isSponsored = paymaster.isSponsored()
            this.status = { type: SigningStatus.InProgress }
            this.emitUpdate()
          } else {
            const errorResponse = paymasterInfo.errorResponse as PaymasterErrorReponse
            this.emitError({
              level: 'major',
              message: errorResponse.message,
              error: errorResponse.error
            })
            this.status = { type: SigningStatus.ReadyToSign }
            this.emitUpdate()
            this.estimate()
            return
          }
        }

        // query the application state from memory to understand if the user
        // hasn't actually rejected the request while waiting for the
        // paymaster to respond
        if (!this.#isSignRequestStillActive()) return

        const userOperation = paymasterInfo.required ? paymasterInfo.userOp! : initialUserOp
        if (userOperation.requestType === 'standard') {
          const typedData = getTypedData(
            this.#network.chainId,
            this.accountOp.accountAddr,
            getUserOpHash(userOperation, this.#network.chainId)
          )
          const signature = wrapStandard(await signer.signTypedData(typedData))
          userOperation.signature = signature
          this.accountOp.signature = signature
        }
        if (userOperation.requestType === '7702') {
          const typedData = get7702UserOpTypedData(
            this.#network.chainId,
            getSignableCalls(this.accountOp),
            getPackedUserOp(userOperation),
            getUserOpHash(userOperation, this.#network.chainId)
          )
          const signature = wrapUnprotected(await signer.signTypedData(typedData))
          userOperation.signature = signature
          this.accountOp.signature = signature
        }
        this.accountOp.asUserOperation = userOperation
      } else {
        // Relayer
        this.#addFeePayment()

        this.accountOp.signature = await getExecuteSignature(
          this.#network,
          this.accountOp,
          accountState,
          signer
        )
      }

      this.status = { type: SigningStatus.Done }
      this.signedAccountOp = structuredClone(this.accountOp)
      this.emitUpdate()
      return this.signedAccountOp
    } catch (error: any) {
      const { message } = getHumanReadableBroadcastError(error)

      this.#emitSigningErrorAndResetToReadyToSign(message)
    }
  }

  canUpdate(): boolean {
    return !this.status || noStateUpdateStatuses.indexOf(this.status.type) === -1
  }

  setDiscoveryStatus(status: TraceCallDiscoveryStatus) {
    this.traceCallDiscoveryStatus = status
  }

  get delegatedContract(): Hex | null {
    if (!this.#accounts.accountStates[this.account.addr]) return null
    if (!this.#accounts.accountStates[this.account.addr][this.#network.chainId.toString()])
      return null
    return this.#accounts.accountStates[this.account.addr][this.#network.chainId.toString()]
      .delegatedContract
  }

  toJSON() {
    return {
      ...this,
      ...super.toJSON(),
      isInitialized: this.isInitialized,
      readyToSign: this.readyToSign,
      accountKeyStoreKeys: this.accountKeyStoreKeys,
      feeToken: this.feeToken,
      feePaidBy: this.feePaidBy,
      speedOptions: this.speedOptions,
      selectedOption: this.selectedOption,
      account: this.account,
      errors: this.errors,
      gasSavedUSD: this.gasSavedUSD,
      delegatedContract: this.delegatedContract
    }
  }
}

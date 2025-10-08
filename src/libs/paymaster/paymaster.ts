/* eslint-disable no-console */
import { AbiCoder, Contract, Interface, toBeHex, ZeroAddress } from 'ethers'

import AmbireFactory from '../../../contracts/compiled/AmbireFactory.json'
import entryPointAbi from '../../../contracts/compiled/EntryPoint.json'
import { FEE_COLLECTOR } from '../../consts/addresses'
import { AMBIRE_PAYMASTER, ERC_4337_ENTRYPOINT } from '../../consts/deploy'
import { Account } from '../../interfaces/account'
import { Fetch } from '../../interfaces/fetch'
import { Hex } from '../../interfaces/hex'
import { Network } from '../../interfaces/network'
import { RPCProvider } from '../../interfaces/provider'
import { failedPaymasters } from '../../services/paymaster/FailedPaymasters'
import { AccountOp } from '../accountOp/accountOp'
import { Call } from '../accountOp/types'
import { getFeeCall } from '../calls/calls'
import { getPaymasterData, getPaymasterStubData } from '../erc7677/erc7677'
import {
  PaymasterErrorReponse,
  PaymasterEstimationData,
  PaymasterService,
  PaymasterSuccessReponse
} from '../erc7677/types'
import { RelayerPaymasterError, SponsorshipPaymasterError } from '../errorDecoder/customErrors'
import { getHumanReadableBroadcastError } from '../errorHumanizer'
import { getFeeTokenForEstimate } from '../estimate/estimateHelpers'
import { TokenResult } from '../portfolio'
import { relayerCall } from '../relayerCall/relayerCall'
import { UserOperation } from '../userOperation/types'
import { getCleanUserOp, getSigForCalculations } from '../userOperation/userOperation'
import { AbstractPaymaster } from './abstractPaymaster'

type PaymasterType = 'Ambire' | 'ERC7677' | 'None'

export function getPaymasterDataForEstimate(): PaymasterEstimationData {
  const abiCoder = new AbiCoder()
  return {
    paymaster: AMBIRE_PAYMASTER,
    paymasterVerificationGasLimit: toBeHex(42000) as Hex,
    paymasterPostOpGasLimit: toBeHex(0) as Hex,
    paymasterData: abiCoder.encode(
      ['uint48', 'uint48', 'bytes'],
      [0, 0, getSigForCalculations()]
    ) as Hex
  }
}

export class Paymaster extends AbstractPaymaster {
  callRelayer: Function

  type: PaymasterType = 'None'

  paymasterService: PaymasterService | null = null

  network: Network | null = null

  provider: RPCProvider | null = null

  errorCallback: Function | undefined = undefined

  // this is a temporary solution where the live relayer doesn't have
  // a chain id paymaster route open yet as it's not merged
  ambirePaymasterUrl: string | undefined

  constructor(relayerUrl: string, fetch: Fetch, errorCallback: Function) {
    super()
    this.callRelayer = relayerCall.bind({ url: relayerUrl, fetch })
    this.errorCallback = errorCallback
  }

  async init(
    op: AccountOp,
    userOp: UserOperation,
    account: Account,
    network: Network,
    provider: RPCProvider
  ) {
    this.network = network
    this.provider = provider
    this.ambirePaymasterUrl = `/v2/paymaster/${this.network.chainId}/request`

    if (op.meta?.paymasterService && !op.meta?.paymasterService.failed) {
      try {
        this.paymasterService = op.meta.paymasterService

        // when requesting stub data with an empty account, send over
        // the deploy data as per EIP-7677 standard
        const localOp = { ...userOp }
        if (BigInt(localOp.nonce) === 0n && account.creation) {
          const factoryInterface = new Interface(AmbireFactory.abi)
          localOp.factory = account.creation.factoryAddr
          localOp.factoryData = factoryInterface.encodeFunctionData('deploy', [
            account.creation.bytecode,
            account.creation.salt
          ])
        }

        const response = await Promise.race([
          getPaymasterStubData(op.meta.paymasterService, localOp, network),
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error('Sponsorship error, request too slow')), 5000)
          })
        ])
        this.sponsorDataEstimation = response as PaymasterEstimationData
        this.type = 'ERC7677'
        return
      } catch (e) {
        // TODO: error handling
        console.log(e)
      }
    }

    // has the paymaster dried up
    const seenInsufficientFunds =
      failedPaymasters.insufficientFundsNetworks[Number(this.network.chainId)]

    if (network.erc4337.hasPaymaster && !seenInsufficientFunds) {
      this.type = 'Ambire'
      return
    }

    // for custom networks, check if the paymaster there has balance
    if (!network.predefined || seenInsufficientFunds) {
      try {
        const ep = new Contract(ERC_4337_ENTRYPOINT, entryPointAbi, provider)
        const paymasterBalance = await ep.balanceOf(AMBIRE_PAYMASTER)

        // if the network paymaster has failed because of insufficient funds,
        // disable it before getting a top up
        const minBalance = seenInsufficientFunds ? seenInsufficientFunds.lastSeenBalance : 0n
        if (paymasterBalance > minBalance) {
          this.type = 'Ambire'
          if (seenInsufficientFunds) failedPaymasters.removeInsufficientFunds(network)
          return
        }
      } catch (e) {
        console.log('failed to retrieve the balance of the paymaster')
        console.error(e)
      }
    }

    this.type = 'None'
  }

  shouldIncludePayment(): boolean {
    return (
      this.type === 'Ambire' ||
      (this.type === 'ERC7677' && this.sponsorDataEstimation?.paymaster === AMBIRE_PAYMASTER)
    )
  }

  // get the fee call type used in the estimation
  // we use this to understand whether we should re-estimate on broadcast
  getFeeCallType(feeTokens: TokenResult[]): string | undefined {
    if (!this.network) throw new Error('network not set, did you call init?')

    if (this.type === 'Ambire') {
      const feeToken = getFeeTokenForEstimate(feeTokens)
      if (!feeToken) return undefined
      if (feeToken.flags.onGasTank) return 'gasTank'
      if (feeToken.address === ZeroAddress) return 'native'
      return 'erc20'
    }

    if (this.type === 'ERC7677') return 'gasTank'
    return undefined
  }

  getFeeCallForEstimation(feeTokens: TokenResult[]): Call | undefined {
    if (!this.network) throw new Error('network not set, did you call init?')

    if (this.type === 'Ambire') {
      const feeToken = getFeeTokenForEstimate(feeTokens)
      if (!feeToken) return undefined

      return getFeeCall(feeToken)
    }

    // hardcode USDC gas tank 0 for sponsorships
    if (this.type === 'ERC7677') {
      const abiCoder = new AbiCoder()
      return {
        to: FEE_COLLECTOR,
        value: 0n,
        data: abiCoder.encode(['string', 'uint256', 'string'], ['gasTank', 0n, 'USDC'])
      }
    }

    return undefined
  }

  getEstimationData(): PaymasterEstimationData | null {
    if (this.type === 'ERC7677') return this.sponsorDataEstimation as PaymasterEstimationData

    if (this.type === 'Ambire') return getPaymasterDataForEstimate()

    return null
  }

  isSponsored(): boolean {
    return this.type === 'ERC7677'
  }

  isUsable() {
    return this.type !== 'None'
  }

  async #retryPaymasterRequest(
    apiCall: Function,
    counter = 0
  ): Promise<PaymasterSuccessReponse | PaymasterErrorReponse> {
    // retry the request 3 times before declaring it a failure
    if (counter >= 3) {
      const e = new Error('Ambire relayer error timeout')
      const convertedError = new RelayerPaymasterError(e)
      const { message } = getHumanReadableBroadcastError(convertedError)
      return {
        success: false,
        message,
        error: e
      }
    }

    try {
      const response = await Promise.race([
        apiCall(),
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('Ambire relayer error timeout')), 8000)
        })
      ])

      return {
        success: true,
        paymaster: this.type === 'Ambire' ? AMBIRE_PAYMASTER : response.paymaster,
        paymasterData: this.type === 'Ambire' ? response.data.paymasterData : response.paymasterData
      }
    } catch (e: any) {
      if (e.message === 'Ambire relayer error timeout') {
        if (this.errorCallback) {
          this.errorCallback({
            level: 'major',
            message: 'Paymaster is not responding. Retrying...',
            error: new Error('Paymaster call timeout')
          })
        }
        const increment = counter + 1
        return this.#retryPaymasterRequest(apiCall, increment)
      }

      const convertedError =
        this.type === 'ERC7677' ? new SponsorshipPaymasterError() : new RelayerPaymasterError(e)
      const message = convertedError.isHumanized
        ? convertedError.message
        : getHumanReadableBroadcastError(convertedError).message
      return {
        success: false,
        message,
        error: e
      }
    }
  }

  async #ambireCall(
    acc: Account,
    op: AccountOp,
    userOp: UserOperation
  ): Promise<PaymasterSuccessReponse | PaymasterErrorReponse> {
    if (!this.provider) throw new Error('provider not set, did you call init?')
    if (!this.network) throw new Error('network not set, did you call init?')

    // request the paymaster with a timeout window
    const localUserOp = { ...userOp }
    localUserOp.paymaster = AMBIRE_PAYMASTER
    return this.#retryPaymasterRequest(() => {
      return this.callRelayer(this.ambirePaymasterUrl, 'POST', {
        userOperation: getCleanUserOp(localUserOp)[0],
        paymaster: AMBIRE_PAYMASTER,
        bytecode: acc.creation?.bytecode,
        salt: acc.creation?.salt,
        key: acc.associatedKeys[0],
        // eslint-disable-next-line no-underscore-dangle
        rpcUrl: this.provider!._getConnection().url,
        bundler: userOp.bundler
      })
    })
  }

  async #erc7677Call(op: AccountOp, userOp: UserOperation, network: Network) {
    const sponsorData = this.sponsorDataEstimation as PaymasterEstimationData

    // no need to do an extra call if the dapp has already provided sponsorship
    if ('isFinal' in sponsorData && sponsorData.isFinal)
      return {
        success: true,
        paymaster: sponsorData.paymaster,
        paymasterData: sponsorData.paymasterData
      }

    const localUserOp = { ...userOp }
    localUserOp.paymaster = sponsorData.paymaster
    localUserOp.paymasterData = sponsorData.paymasterData
    const response = await this.#retryPaymasterRequest(() => {
      return getPaymasterData(this.paymasterService as PaymasterService, localUserOp, network)
    })

    if (!response.success && op.meta && op.meta.paymasterService) {
      failedPaymasters.addFailedSponsorship(op.meta.paymasterService.id)
    }

    return response
  }

  async call(
    acc: Account,
    op: AccountOp,
    userOp: UserOperation,
    network: Network
  ): Promise<PaymasterSuccessReponse | PaymasterErrorReponse> {
    if (this.type === 'Ambire') return this.#ambireCall(acc, op, userOp)

    if (this.type === 'ERC7677') return this.#erc7677Call(op, userOp, network)

    throw new Error('Paymaster not configured. Please contact support')
  }

  canAutoRetryOnFailure(): boolean {
    return this.type === 'Ambire'
  }

  isEstimateBelowMin(localOp: UserOperation): boolean {
    const min = this.getEstimationData()
    if (!min || !min.paymasterVerificationGasLimit) return false

    return (
      localOp.paymasterVerificationGasLimit === undefined ||
      BigInt(localOp.paymasterVerificationGasLimit) < BigInt(min.paymasterVerificationGasLimit)
    )
  }
}

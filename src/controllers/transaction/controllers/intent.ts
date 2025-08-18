import EventEmitter from '../../eventEmitter/eventEmitter'
import { ControllersTransactionDependencies } from '../dependencies'
import { TransactionFormState } from '../transactionFormState'

export class IntentController extends EventEmitter {
  formPreviousState: any

  publicClient: any | undefined = undefined

  params: any = {}

  quote: any = null

  transactions = []

  constructor(
    private readonly dependencies: ControllersTransactionDependencies,
    private readonly formState: TransactionFormState
  ) {
    super()
  }

  async getProtocolQuote() {
    const currentState = this.formState.state

    // sender: '0x80B7064b28cD538FaD771465984aa799d87A1187',
    // recipient: '0x0000000000000000000000000000000000000000',
    // inputAmount: '10000',
    // inputTokenAddress: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    // outputTokenAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    // inputChainId: 11155111,
    // outputChainId: 84532

    // if (this.shouldRefetchQuotes(currentState)) {
    try {
      const input = {
        inputTokenAddress: currentState.fromSelectedToken?.address,
        outputTokenAddress: currentState.toSelectedToken?.address,
        inputChainId: currentState.fromChainId,
        outputChainId: currentState.toChainId,
        inputAmount: currentState.fromAmount,
        recipient:
          currentState.addressState.ensAddress ||
          currentState.addressState.interopAddress ||
          currentState.addressState.fieldValue,
        sender: this.dependencies.selectedAccount.account?.addr
      }

      this.params = input

      // const options = {
      //   protocol: 'across'
      // }
      //
      // const rawQuote = (await this.getQuotes(input, options)) as any
      //
      // const finalQuote = {
      //   fromAsset: this.formState.portfolioTokenList
      //     .filter((token: TokenResult) => token.chainId === rawQuote.inputChainId)
      //     .find((token: TokenResult) => token.address === rawQuote.inputToken),
      //   fromChainId: rawQuote.inputChainId,
      //   toAsset: this.formState.portfolioTokenList
      //     .filter((token: TokenResult) => token.chainId === rawQuote.outputChainId)
      //     .find((token: TokenResult) => token.address === rawQuote.outputToken),
      //   toChainId: rawQuote.outputChainId,
      //   selectedRouteSteps: [],
      //   routes: [],
      //   selectedRoute: {
      //     toAmount: rawQuote.inputAmount || '0'
      //   }
      // } as unknown as SwapAndBridgeQuote
      //
      // this.formState.quote = finalQuote
      this.emitUpdate()
    } catch (error: any) {
      this.emitError({ error, level: 'silent', message: error?.message })
    }
    // }
  }

  // If we want to track specific changes, uncomment this
  // private shouldRefetchQuotes(state: any): boolean {
  // const relevantFields = ['fromChainId', 'fromSelectedToken', 'toChainId', 'toSelectedToken']
  //
  // if (!this.formPreviousState) {
  //   this.formPreviousState = state
  //   return true
  // }
  //
  // const hasRelevantChanges = relevantFields.some(
  //   (field) => state[field] !== this.formPreviousState[field]
  // )
  // this.formPreviousState = { ...state }
  //
  // return hasRelevantChanges
  // }

  // eslint-disable-next-line class-methods-use-this
  // public async getQuotes(inputs: any, options?: any) {
  //   // await this.dependencies.interopSDK.getQuotes()
  //   return new Promise((resolve) => {
  //     setTimeout(() => {
  //       resolve({
  //         inputToken: '0x0b2c639c533813f4aa9d7837caf62653d097ff85', // USDC in Optimism
  //         outputToken: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', // USDC in Arbitrum
  //         inputChainId: '10',
  //         outputChainId: '42161',
  //         inputAmount: '100',
  //         outputAmount: '98',
  //         fee: '2',
  //         oifParams: {
  //           fillDeadline: 152452345,
  //           orderDataType: 324234234234,
  //           orderData: [234, 24, 24, 52]
  //         }
  //       })
  //     }, 500)
  //   })
  // }

  setQuote(quote: any) {
    this.quote = quote
    this.emitUpdate()
  }

  setTransaction(transactions: any) {
    this.transactions = transactions
    this.emitUpdate()
  }

  setQuoteAndTransaction(quote: any, transactions: any) {
    this.quote = quote
    this.transactions = transactions
    this.emitUpdate()
  }
}

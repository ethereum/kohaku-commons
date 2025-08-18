import assert from 'assert'
import { AbiCoder, concat, getBytes, Interface, JsonRpcProvider, Provider } from 'ethers'

import DeploylessCompiled from '../../../contracts/compiled/Deployless.json'

// this is a magic contract that is constructed like `constructor(bytes memory contractBytecode, bytes memory data)` and returns the result from the call
// compiled from relayer:a7ea373559d8c419577ac05527bd37fbee8856ae/src/velcro-v3/contracts/Deployless.sol with solc 0.8.17
const deploylessProxyBin = DeploylessCompiled.bin
// This is another magic contract that can return the contract code at an address; this is not the deploy bytecode but rather the contract code itself
// see https://gist.github.com/Ivshti/fbcc37c0a8b88d6e51bb30db57f3d50e
const codeOfContractCode =
  '0x608060405234801561001057600080fd5b506004361061002b5760003560e01c80631e05758f14610030575b600080fd5b61004a60048036038101906100459190610248565b61004c565b005b60008151602083016000f0905060008173ffffffffffffffffffffffffffffffffffffffff163b036100aa576040517fb4f5411100000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b60008173ffffffffffffffffffffffffffffffffffffffff16803b806020016040519081016040528181526000908060200190933c90506000815190508060208301f35b6000604051905090565b600080fd5b600080fd5b600080fd5b600080fd5b6000601f19601f8301169050919050565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052604160045260246000fd5b6101558261010c565b810181811067ffffffffffffffff821117156101745761017361011d565b5b80604052505050565b60006101876100ee565b9050610193828261014c565b919050565b600067ffffffffffffffff8211156101b3576101b261011d565b5b6101bc8261010c565b9050602081019050919050565b82818337600083830152505050565b60006101eb6101e684610198565b61017d565b90508281526020810184848401111561020757610206610107565b5b6102128482856101c9565b509392505050565b600082601f83011261022f5761022e610102565b5b813561023f8482602086016101d8565b91505092915050565b60006020828403121561025e5761025d6100f8565b5b600082013567ffffffffffffffff81111561027c5761027b6100fd565b5b6102888482850161021a565b9150509291505056fea2646970667358221220de4923c71abcedf68454c251a9becff7e8a4f8db4adee6fdb16d583f509c63bb64736f6c63430008120033'
const codeOfContractAbi = ['function codeOf(bytes deployCode) external view']

// The custom error that both these contracts will raise in case the deploy process of the contract goes wrong
// error DeployFailed();
const deployErrorSig = '0xb4f54111'
// Signature of Error(string)
const errorSig = '0x08c379a0'
// LBRouter__InvalidTokenPath
const invalidPath = '0x4feac00c'
// Signature of Panic(uint256)
const panicSig = '0x4e487b71'
// uniswap swap expired
const expiredSwap = '0x5bf6f916'
// uniswap signature expired
const expiredSig = '0xcd21db4f'

// any made up addr would work
const arbitraryAddr = '0x0000000000000000000000000000000000696969'
const abiCoder = new AbiCoder()

export enum DeploylessMode {
  Detect,
  ProxyContract,
  StateOverride
}
export type CallOptions = {
  mode: DeploylessMode
  // Note: some RPCs don't seem to like numbers, we can use hex strings for them
  blockTag: string | number
  from?: string
  to?: string
  gasPrice?: string
  gasLimit?: string
  stateToOverride: object | null
}
const defaultOptions: CallOptions = {
  mode: DeploylessMode.Detect,
  blockTag: 'latest',
  from: undefined,
  to: arbitraryAddr,
  stateToOverride: null
}

export class Deployless {
  private iface: Interface

  // the contract deploy (constructor) code: this is the code that tjhe solidity compiler outputs
  private contractBytecode: string

  private provider: JsonRpcProvider | Provider

  private isProviderInvictus: boolean = false

  // We need to detect whether the provider supports state override
  private detectionPromise?: Promise<void>

  private stateOverrideSupported?: boolean

  // the code of the contract after it's actually deployed (or in our case, simulate-deployed)
  // see this: https://medium.com/coinmonks/the-difference-between-bytecode-and-deployed-bytecode-64594db723df
  private contractRuntimeCode?: string

  public get isLimitedAt24kbData() {
    return !this.stateOverrideSupported
  }

  constructor(
    provider: JsonRpcProvider | Provider,
    abi: any[],
    code: string,
    codeAtRuntime?: string
  ) {
    assert.ok(code.startsWith('0x'), 'contract code must start with 0x')
    assert.ok(
      !abi.includes((x: any) => x.type === 'constructor'),
      'contract cannot have a constructor, as it is not supported in state override mode'
    )
    assert.ok(!!provider, 'provider must be provided')
    this.contractBytecode = code
    this.provider = provider
    this.iface = new Interface(abi)

    if (provider && provider instanceof JsonRpcProvider) {
      // eslint-disable-next-line no-underscore-dangle
      this.isProviderInvictus = provider._getConnection().url.includes('invictus')
    }

    if (codeAtRuntime !== undefined) {
      assert.ok(codeAtRuntime.startsWith('0x'), 'contract code (runtime) must start with 0x')
      this.stateOverrideSupported = true
      this.contractRuntimeCode = codeAtRuntime
    }
  }

  // this will detect whether the provider supports state override and also retrieve the actual code of the contract we are using
  private async detectStateOverride(): Promise<void> {
    const isJsonRpcProvider =
      this.provider &&
      typeof (this.provider as JsonRpcProvider).send === 'function' &&
      // eslint-disable-next-line no-underscore-dangle
      typeof (this.provider as JsonRpcProvider)._send === 'function'

    if (!isJsonRpcProvider) {
      throw new Error(
        'state override mode (or auto-detect) not available unless you use JsonRpcProvider'
      )
    }
    const codeOfIface = new Interface(codeOfContractAbi)
    const code = await mapError(
      (this.provider as JsonRpcProvider).send('eth_call', [
        {
          to: arbitraryAddr,
          data: codeOfIface.encodeFunctionData('codeOf', [this.contractBytecode])
        },
        'latest',
        { [arbitraryAddr]: { code: codeOfContractCode } }
      ])
    )
    // any response bigger than 0x is sufficient to know that state override worked
    // the response would be just "0x" if state override doesn't work
    this.stateOverrideSupported = code.startsWith('0x') && code.length > 2
    this.contractRuntimeCode = mapResponse(code)
  }

  async call(methodName: string, args: any[], opts: Partial<CallOptions> = {}): Promise<any> {
    opts = { ...defaultOptions, ...opts }
    const forceProxy = opts.mode === DeploylessMode.ProxyContract

    // First, start by detecting which modes are available, unless we're forcing the proxy mode
    // if we use state override, we do need detection to run still so it can populate contractRuntimeCode
    if (
      this.stateOverrideSupported &&
      !this.detectionPromise &&
      !forceProxy &&
      this.contractRuntimeCode === undefined
    ) {
      this.detectionPromise = this.detectStateOverride()
    }
    await this.detectionPromise

    if (opts.stateToOverride !== null && opts.mode !== DeploylessMode.StateOverride) {
      throw new Error('state override passed but not requested')
    }
    if (opts.mode === DeploylessMode.StateOverride && !this.stateOverrideSupported) {
      throw new Error(`${methodName}: state override requested but not supported`)
    }

    const callData = this.iface.encodeFunctionData(methodName, args)
    const toAddr = opts.to ?? arbitraryAddr
    const callPromise =
      !!this.stateOverrideSupported && !forceProxy
        ? (this.provider as JsonRpcProvider).send('eth_call', [
            {
              to: toAddr,
              data: callData,
              from: opts.from,
              gasPrice: opts?.gasPrice,
              gas: opts?.gasLimit
            },
            opts.blockTag,
            {
              [toAddr]: { code: this.contractRuntimeCode },
              ...(opts.stateToOverride || {})
            }
          ])
        : this.provider.call({
            blockTag: opts.blockTag,
            from: opts.from,
            gasPrice: opts?.gasPrice,
            gasLimit: opts?.gasLimit,
            data: checkDataSize(
              concat([
                deploylessProxyBin,
                abiCoder.encode(['bytes', 'bytes'], [this.contractBytecode, callData])
              ])
            )
          })

    // The ethers' providers retry failed calls every 1 second, making numerous attempts before finally resolving the promise.
    // To prevent prolonged retries, we use Promise.race to set a 10-second timeout. This way, the callPromise will either resolve
    // or the timeout promise will reject after 10 seconds, whichever occurs first.
    const callPromisedWithResolveTimeout = Promise.race([
      callPromise,
      new Promise((_resolve, reject) => {
        // Custom providers may take longer to respond, so we set a longer timeout for them.
        setTimeout(() => reject(new Error('rpc-timeout')), this.isProviderInvictus ? 15000 : 20000)
      })
    ])

    const returnDataRaw = mapResponse(await mapError(callPromisedWithResolveTimeout))
    return this.iface.decodeFunctionResult(methodName, returnDataRaw)
  }
}

export function fromDescriptor(
  provider: JsonRpcProvider | Provider,
  desc: { abi: any; bin: string; binRuntime: string },
  supportStateOverride: boolean
): Deployless {
  return new Deployless(
    provider,
    desc.abi,
    desc.bin,
    supportStateOverride ? desc.binRuntime : undefined
  )
}

async function mapError(callPromise: Promise<string>): Promise<string> {
  try {
    return await callPromise
  } catch (e: any) {
    // ethers v5 provider: e.error.data is usually our eth_call output in case of execution reverted
    if (e.error && e.error.data) return e.error.data
    // ethers v5 provider: unwrap the wrapping that ethers adds to this type of error in case of provider.call
    if (e.code === 'CALL_EXCEPTION' && e.error) throw e.error
    // ethers v6 provider: wrapping the error in case of execution reverted
    if (e.code === 'CALL_EXCEPTION' && e.data) return e.data
    throw e
  }
}

function mapResponse(data: string): string {
  if (data === deployErrorSig) throw new Error('contract deploy failed')
  const err = parseErr(data)
  if (err) throw err
  return data
}

export function parseErr(data: string): string | null {
  const dataNoPrefix = data.slice(10)
  if (data.startsWith(panicSig)) {
    // https://docs.soliditylang.org/en/v0.8.11/control-structures.html#panic-via-assert-and-error-via-require
    const num = parseInt(`0x${dataNoPrefix}`)
    if (num === 0x00) return 'generic compiler error'
    if (num === 0x01) return 'solidity assert error'
    if (num === 0x11) return 'arithmetic error'
    if (num === 0x12) return 'division by zero'
    return `panic error: 0x${num.toString(16)}`
  }
  if (data.startsWith(errorSig)) {
    try {
      return abiCoder.decode(['string'], `0x${dataNoPrefix}`)[0]
    } catch (e: any) {
      if (e.code === 'BUFFER_OVERRUN' || e.code === 'NUMERIC_FAULT') return dataNoPrefix
      return e
    }
  }
  if (data.startsWith(invalidPath)) {
    return 'Transaction cannot be sent due to invalid swap path provided by the app that initiated the request. Please return to the app interface and try again.'
  }
  // uniswap expired error
  if (data === expiredSwap) {
    return 'Transaction cannot be sent because the swap has expired. Please return to the app interface and try again.'
  }
  // uniswap signature expired error
  if (data.startsWith(expiredSig)) {
    return 'Transaction cannot be sent because the signature involved in this swap has expired. Please return to the app interface and try again.'
  }
  return null
}

function checkDataSize(data: string): string {
  if (getBytes(data).length >= 24576)
    throw new Error(
      'Transaction cannot be sent because the 24kb call data size limit has been reached. Please use StateOverride mode instead.'
    )
  return data
}

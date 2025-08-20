import type { Address, Hex } from 'viem'
import type { KeystoreController } from '../keystore/keystore'
import { type ChainData, chainData, whitelistedChains } from './config'
import EventEmitter from '../eventEmitter/eventEmitter'

interface PrivacyPoolsFormUpdate {
  amount?: string
  seedPhrase?: string
  targetAddress?: string
}

type Hash = bigint

type PoolInfo = {
  chainId: number
  address: Hex
  scope: Hash
  deploymentBlock: bigint
}

export class PrivacyPoolsController extends EventEmitter {
  #keystore: KeystoreController | null = null

  #isInitialized: boolean = false

  #initializationError: string | null = null

  #initialPromise: Promise<void> | null = null

  #initialPromiseLoaded: boolean = false

  amount: string = ''

  seedPhrase: string = ''

  targetAddress: Address | string = ''

  selectedToken: string = ''

  poolsByChain: PoolInfo[] = []

  pools: PoolInfo[] = []

  chainDataByWhitelistedChains: ChainData[keyof ChainData][] = []

  chainData: ChainData | null = null

  constructor(keystore: KeystoreController) {
    super()

    this.#keystore = keystore
    this.#initialPromise = this.#load()

    this.emitUpdate()
  }

  async #load() {
    this.chainDataByWhitelistedChains = Object.values(chainData).filter(
      (chain) =>
        chain.poolInfo.length > 0 &&
        whitelistedChains.some((c) => c.id === chain.poolInfo[0].chainId)
    )

    this.poolsByChain = this.chainDataByWhitelistedChains.flatMap((chain) => chain.poolInfo)

    this.pools = this.poolsByChain.map((pool: PoolInfo) => {
      return {
        chainId: pool.chainId,
        address: pool.address,
        scope: pool.scope as Hash,
        deploymentBlock: pool.deploymentBlock
      }
    })

    this.chainData = { ...chainData }
    this.#initialPromiseLoaded = true
  }

  public setSdkInitialized() {
    this.#isInitialized = true
    this.#initializationError = null

    this.emitUpdate()
  }

  public update({ amount, seedPhrase, targetAddress }: PrivacyPoolsFormUpdate) {
    if (amount) {
      this.amount = amount
    }

    if (targetAddress) {
      this.targetAddress = targetAddress
    }

    this.seedPhrase = seedPhrase || ''

    this.emitUpdate()
  }

  public unloadScreen() {
    this.resetForm()
  }

  public resetForm() {
    this.amount = ''
    this.seedPhrase = ''
    this.targetAddress = ''
    this.selectedToken = ''
    this.#isInitialized = false

    this.emitUpdate()
  }

  get isInitialized(): boolean {
    return this.#isInitialized
  }

  get initializationError(): string | null {
    return this.#initializationError
  }

  get initialPromiseLoaded(): boolean {
    return this.#initialPromiseLoaded
  }

  toJSON() {
    return {
      ...this,
      ...super.toJSON(),
      isInitialized: this.isInitialized,
      initialPromiseLoaded: this.initialPromiseLoaded
    }
  }
}

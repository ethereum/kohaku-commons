import {
  type PoolAccount as SDKPoolAccount,
  type AccountCommitment,
  type RagequitEvent
} from '@0xbow/privacy-pools-core-sdk'
import type { Address, Hex } from 'viem'
import type { KeystoreController } from '../keystore/keystore'
import { type ChainData, chainData, whitelistedChains } from './config'
import EventEmitter from '../eventEmitter/eventEmitter'

interface PrivacyFormUpdate {
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

type RagequitEventWithTimestamp = RagequitEvent & {
  timestamp: bigint
}

type PoolAccount = SDKPoolAccount & {
  name: number
  balance: bigint
  isValid: boolean
  reviewStatus: ReviewStatus
  lastCommitment: AccountCommitment
  chainId: number
  scope: Hash
  ragequit?: RagequitEventWithTimestamp
}

export enum ReviewStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  DECLINED = 'declined',
  EXITED = 'exited',
  SPENT = 'spent'
}

export class PrivacyController extends EventEmitter {
  #keystore: KeystoreController | null = null

  #selectedPool: PoolInfo | null = null

  #isInitialized: boolean = false

  #initializationError: string | null = null

  #initialPromise: Promise<void> | null = null

  #initialPromiseLoaded: boolean = false

  amount: string = ''

  seedPhrase: string = ''

  targetAddress: Address | string = ''

  selectedToken: string = ''

  selectedPoolAccount: PoolAccount | null = null

  poolAccounts: PoolAccount[] = [] // TODO: create a setter for this property

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

  public update({ amount, seedPhrase, targetAddress }: PrivacyFormUpdate) {
    if (amount) {
      this.amount = amount
    }

    if (targetAddress) {
      this.targetAddress = targetAddress
    }

    this.seedPhrase = seedPhrase || ''

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

import type {
  CommitmentProof,
  PrivacyPoolSDK as PrivacyPoolSDKType,
  WithdrawalProofInput,
  Withdrawal,
  WithdrawalProof,
  AccountService as AccountServiceType,
  DataService as DataServiceType,
  PoolAccount as SDKPoolAccount,
  AccountCommitment,
  ChainConfig,
  RagequitEvent,
  Hash as SDKHash,
  PoolInfo as SDKPoolInfo
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

  #sdk: PrivacyPoolSDKType | null = null

  #sdkModule: any | null = null

  #accountService: AccountServiceType | null = null

  #dataService: DataServiceType | null = null

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

  public async initSDK(baseUrl: string, { force = false } = {}): Promise<void> {
    if (this.#isInitialized && !force) return

    if (typeof window === 'undefined') {
      this.emitError({
        level: 'major',
        message: 'Cannot initialize SDK in service worker (no window).',
        error: new Error('Cannot initialize SDK in service worker (no window). (initSDK)')
      })
    }

    console.log('Ambire privacy: initializing SDK')

    try {
      const sdkModule = await import('@0xbow/privacy-pools-core-sdk') // webpackChunkName: "privacy-pool-sdk"
      this.#sdkModule = sdkModule

      const { Circuits, PrivacyPoolSDK, DataService } = sdkModule

      const circuits = new Circuits({ baseUrl })

      const dataServiceConfig: ChainConfig[] = this.poolsByChain.map((pool) => {
        return {
          chainId: pool.chainId,
          privacyPoolAddress: pool.address,
          startBlock: pool.deploymentBlock,
          rpcUrl: chainData[pool.chainId].sdkRpcUrl,
          apiKey: 'sdk'
        }
      })

      this.#sdk = new PrivacyPoolSDK(circuits)
      this.#dataService = new DataService(dataServiceConfig)
      this.#isInitialized = true
      this.#initializationError = null

      this.emitUpdate()
    } catch (err: any) {
      this.#initializationError = String(err?.message ?? err)
      this.#isInitialized = false
      throw err
    }
  }

  public update({ amount, seedPhrase, targetAddress }: PrivacyFormUpdate) {
    if (amount) {
      this.amount = amount
    }

    if (seedPhrase) {
      this.seedPhrase = seedPhrase
    }

    if (targetAddress) {
      this.targetAddress = targetAddress
    }

    this.emitUpdate()
  }

  public async generateRagequitProof(commitment: AccountCommitment): Promise<CommitmentProof> {
    this.assertSdkInitialized()

    return this.#sdk!.proveCommitment(
      commitment.value,
      commitment.label,
      commitment.nullifier,
      commitment.secret
    )
  }

  public async verifyRagequitProof({ proof, publicSignals }: CommitmentProof) {
    this.assertSdkInitialized()

    return this.#sdk!.verifyCommitment({ proof, publicSignals })
  }

  public async generateWithdrawalProof(commitment: AccountCommitment, input: WithdrawalProofInput) {
    this.assertSdkInitialized()

    return this.#sdk!.proveWithdrawal(
      {
        preimage: {
          label: commitment.label,
          value: commitment.value,
          precommitment: {
            hash: BigInt('0x1234') as SDKHash,
            nullifier: commitment.nullifier,
            secret: commitment.secret
          }
        },
        hash: commitment.hash,
        nullifierHash: BigInt('0x1234') as SDKHash
      },
      input
    )
  }

  public async verifyWithdrawalProof(proof: WithdrawalProof) {
    this.assertSdkInitialized()

    return this.#sdk!.verifyWithdrawal(proof)
  }

  public async loadAccount(seed: string) {
    if (!this.#dataService || !this.#sdkModule) {
      throw new Error('DataService not initialized. Call initSDK() first.')
    }

    const { AccountService } = this.#sdkModule
    this.#accountService = new AccountService(this.#dataService, { mnemonic: seed })

    if (this.#accountService) {
      await this.#accountService.retrieveHistory(this.pools as SDKPoolInfo[])
    }

    console.log('Ambire ctrl: AccountService initialized', this.#accountService)

    this.emitUpdate()
  }

  public createDepositSecrets(scope: Hash) {
    if (!this.#accountService) throw new Error('AccountService not initialized')

    return this.#accountService.createDepositSecrets(scope as SDKHash)
  }

  public createWithdrawalSecrets(commitment: AccountCommitment) {
    if (!this.#accountService) throw new Error('AccountService not initialized')

    return this.#accountService.createWithdrawalSecrets(commitment)
  }

  public getContext(withdrawal: Withdrawal, scope: Hash) {
    if (!this.#sdkModule) throw new Error('SDK module not loaded')

    const { calculateContext } = this.#sdkModule
    return calculateContext(withdrawal, scope)
  }

  public getMerkleProof(leaves: bigint[], leaf: bigint) {
    if (!this.#sdkModule) throw new Error('SDK module not loaded')

    const { generateMerkleProof } = this.#sdkModule
    return generateMerkleProof(leaves, leaf)
  }

  public async getPoolAccountsFromAccount(chainId: number) {
    if (!this.#accountService) {
      throw new Error('AccountService not initialized')
    }
    return { poolAccounts: [], poolAccountsByChainScope: {} as Record<string, PoolAccount[]> } // placeholder
  }

  private assertSdkInitialized() {
    if (!this.#isInitialized || !this.#sdk || !this.#dataService || !this.#sdkModule) {
      throw new Error('SDK not initialized. Call initSDK() in a window context first.')
    }
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

import { keccak256, parseCompactSignature, toBytes, type Address, type Hex } from 'viem'
import { TypedMessage } from 'interfaces/userRequest'
import { AccountsController } from 'controllers/accounts/accounts'
import type { KeystoreController } from '../keystore/keystore'
import { type ChainData, chainData, whitelistedChains } from './config'
import EventEmitter from '../eventEmitter/eventEmitter'

interface PrivacyPoolsFormUpdate {
  depositAmount?: string
  withdrawalAmount?: string
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
  #accounts: AccountsController | null = null

  #keystore: KeystoreController | null = null

  #isInitialized: boolean = false

  #initializationError: string | null = null

  #initialPromise: Promise<void> | null = null

  #initialPromiseLoaded: boolean = false

  #privacyPoolsAspUrl: string

  #alchemyApiKey: string

  depositAmount: string = ''

  withdrawalAmount: string = ''

  signedTypedData: string | null = null

  seedPhrase: string = ''

  targetAddress: Address | string = ''

  selectedToken: string = ''

  poolsByChain: PoolInfo[] = []

  pools: PoolInfo[] = []

  chainDataByWhitelistedChains: ChainData[keyof ChainData][] = []

  chainData: ChainData | null = null

  constructor(
    keystore: KeystoreController,
    privacyPoolsAspUrl: string,
    accounts: AccountsController,
    alchemyApiKey: string
  ) {
    super()

    this.#keystore = keystore
    this.#privacyPoolsAspUrl = privacyPoolsAspUrl
    this.#alchemyApiKey = alchemyApiKey
    this.#accounts = accounts
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

    this.chainData = Object.fromEntries(
      Object.entries(chainData).map(([chainId, chain]) => [
        chainId,
        {
          ...chain,
          aspUrl: this.#privacyPoolsAspUrl,
          rpcUrl: `${chain.rpcUrl}${this.#alchemyApiKey}`
        }
      ])
    )
    this.#initialPromiseLoaded = true
  }

  public setSdkInitialized() {
    this.#isInitialized = true
    this.#initializationError = null

    this.emitUpdate()
  }

  public update({
    depositAmount,
    withdrawalAmount,
    seedPhrase,
    targetAddress
  }: PrivacyPoolsFormUpdate) {
    if (typeof depositAmount === 'string') {
      this.depositAmount = depositAmount
    }

    if (typeof withdrawalAmount === 'string') {
      this.withdrawalAmount = withdrawalAmount
    }

    if (typeof targetAddress === 'string') {
      this.targetAddress = targetAddress
    }

    this.seedPhrase = seedPhrase || ''

    this.emitUpdate()
  }

  public unloadScreen() {
    this.resetForm()
  }

  public resetForm() {
    this.depositAmount = ''
    this.withdrawalAmount = ''
    this.targetAddress = ''
    this.selectedToken = ''
    this.#isInitialized = false

    this.emitUpdate()
  }

  public async signTypedData() {
    const signer = await this.#keystore?.getSigner(
      this.#accounts?.accounts[0].addr as Address,
      'internal'
    )
    if (!signer) {
      throw new Error('Signer not found')
    }

    const appIdentifier = 'com.example.myapp'

    const addressHash = keccak256(toBytes(this.#accounts?.accounts[0].addr as Address))

    const eip712Payload = {
      kind: 'typedMessage',
      domain: {
        name: 'Standardized Secret Derivation',
        version: '1',
        verifyingContract: '0x0000000000000000000000000000000000000000',
        salt: keccak256(toBytes(appIdentifier))
      },
      message: {
        purpose:
          'This signature is used to deterministically derive application-specific secrets from your master seed. It is not a transaction and will not cost any gas.',
        addressHash
      },
      primaryType: 'SecretDerivation',
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'verifyingContract', type: 'address' },
          { name: 'salt', type: 'bytes32' }
        ],
        SecretDerivation: [
          { name: 'purpose', type: 'string' },
          { name: 'addressHash', type: 'bytes32' }
        ]
      }
    } as TypedMessage

    const signature = await signer.signTypedData(eip712Payload)
    const compactSignature = parseCompactSignature(signature as `0x${string}`)

    this.signedTypedData = compactSignature.r
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

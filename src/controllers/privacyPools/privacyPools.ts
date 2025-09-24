import {
  bytesToHex,
  hexToBytes,
  keccak256,
  parseCompactSignature,
  toBytes,
  type Address,
  type Hex
} from 'viem'
import { HDNodeWallet, Mnemonic } from 'ethers'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha2'
import { TypedMessage } from 'interfaces/userRequest'
import { AccountsController } from 'controllers/accounts/accounts'
import { SelectedAccountController } from 'controllers/selectedAccount/selectedAccount'
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

  #selectedAccount: SelectedAccountController | null = null

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
    accounts: AccountsController,
    selectedAccount: SelectedAccountController,
    privacyPoolsAspUrl: string,
    alchemyApiKey: string
  ) {
    super()

    this.#keystore = keystore
    this.#accounts = accounts
    this.#selectedAccount = selectedAccount
    this.#privacyPoolsAspUrl = privacyPoolsAspUrl
    this.#alchemyApiKey = alchemyApiKey
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

  async #deriveAddressFromArbitraryPath(hdPath: string) {
    try {
      const seedPhrase = await this.#getCurrentAccountSeed()

      if (!seedPhrase) {
        throw new Error('No seed phrase available for address derivation')
      }

      const mnemonic = Mnemonic.fromPhrase(seedPhrase)
      const wallet = HDNodeWallet.fromMnemonic(mnemonic, hdPath)

      return wallet.address as Address
    } catch (error) {
      console.error('Failed to derive address from arbitrary path:', error)
      throw error
    }
  }

  async #getCurrentAccountSeed(): Promise<string | null> {
    try {
      if (!this.#selectedAccount?.account || !this.#keystore?.isUnlocked) {
        return null
      }

      const accountKeys = this.#keystore.getAccountKeys(this.#selectedAccount.account)

      const internalKey = accountKeys.find((key) => key.type === 'internal' && key.meta?.fromSeedId)

      if (!internalKey?.meta?.fromSeedId) {
        return null
      }

      const savedSeed = await this.#keystore.getSavedSeed(internalKey.meta.fromSeedId)
      return savedSeed?.seed || null
    } catch (error) {
      console.error('Failed to get current account seed:', error)
      return null
    }
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

  public async generateAppSecret(appInfo: string = 'Standardized-Secret-Derivation-v1-App') {
    const signer = await this.#keystore?.getSigner(
      this.#accounts?.accounts[0].addr as Address,
      'internal'
    )
    if (!signer) {
      throw new Error('Signer not found')
    }

    const appIdentifier = 'privacypools.com'

    // Step 1: Derive dedicated address
    const coinType = 9001
    const privacyPoolsPath = `m/44'/${coinType}'/0'/0/0`
    const signerAddress = await this.#deriveAddressFromArbitraryPath(privacyPoolsPath)
    const addressHash = keccak256(toBytes(signerAddress))
    console.log('DEBUG: Derived address from arbitrary path:', signerAddress)

    // Step 2: Construct EIP-712 payload
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

    // Step 3: Request signature
    let signature: string | null = await signer.signTypedData(eip712Payload)
    const compactSignature = parseCompactSignature(signature as `0x${string}`)

    const rValue = compactSignature.r
    compactSignature.yParityAndS = '0x' // Destroy s component
    signature = null // Destroy signature component

    // Step 4: Derive root secret
    const rBytes = hexToBytes(rValue)
    const saltBytes = hexToBytes(signerAddress)
    const rootInfoBytes = new TextEncoder().encode('Standardized-Secret-Derivation-v1-Root')

    const rootSecret = hkdf(sha256, rBytes, saltBytes, rootInfoBytes, 32)

    // Step 5: Derive application secret
    const appSaltBytes = new TextEncoder().encode(appIdentifier)
    const appInfoBytes = new TextEncoder().encode(appInfo)

    const appSecretBytes = hkdf(sha256, rootSecret, appSaltBytes, appInfoBytes, 32)
    const appSecret = bytesToHex(appSecretBytes)

    // Securely wipe root secret
    rootSecret.fill(0)

    // TODO: This is a temporary assignation, to be removed later
    this.signedTypedData = appSecret
    console.log('DEBUG: App secret:', appSecret)

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

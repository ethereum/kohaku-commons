import { keccak256, toBytes, type Address, type Hex } from 'viem'
import { HDNodeWallet, Mnemonic } from 'ethers'
import type { KeystoreController } from '../keystore/keystore'
import { type ChainData, chainData, whitelistedChains } from './config'
import EventEmitter from '../eventEmitter/eventEmitter'
import { SignAccountOpController } from '../signAccountOp/signAccountOp'
import { getBaseAccount } from '../../libs/account/getBaseAccount'
import { AccountOp } from '../../libs/accountOp/accountOp'
import { Call } from '../../libs/accountOp/types'
import { KeystoreSigner } from '../../libs/keystoreSigner/keystoreSigner'
import { getAmbirePaymasterService } from '../../libs/erc7677/erc7677'
import { randomId } from '../../libs/humanizer/utils'
import { EstimationStatus } from '../estimation/types'
import { AccountsController } from '../accounts/accounts'
import { ActivityController } from '../activity/activity'
import { NetworksController } from '../networks/networks'
import { PortfolioController } from '../portfolio/portfolio'
import { ProvidersController } from '../providers/providers'
import { SelectedAccountController } from '../selectedAccount/selectedAccount'
import { ExternalSignerControllers, Key } from '../../interfaces/keystore'
import { getAppSecret, getEip712Payload } from './derivation'
import wait from '../../utils/wait'

interface PrivacyPoolsFormUpdate {
  depositAmount?: string
  withdrawalAmount?: string
  seedPhrase?: string
  targetAddress?: string
  importedSecretNote?: string
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

  #signAccountOpSubscriptions: Function[] = []

  #reestimateAbortController: AbortController | null = null

  #networks: NetworksController

  #providers: ProvidersController

  #portfolio: PortfolioController

  #activity: ActivityController

  #externalSignerControllers: ExternalSignerControllers

  #relayerUrl: string

  shouldTrackLatestBroadcastedAccountOp: boolean = true

  signAccountOpController: SignAccountOpController | null = null

  latestBroadcastedAccountOp: AccountOp | null = null

  hasProceeded: boolean = false

  depositAmount: string = ''

  withdrawalAmount: string = ''

  signedTypedData: string | null = null

  seedPhrase: string = ''

  targetAddress: Address | string = ''

  selectedToken: string = ''

  importedSecretNote: string = ''

  poolsByChain: PoolInfo[] = []

  pools: PoolInfo[] = []

  chainDataByWhitelistedChains: ChainData[keyof ChainData][] = []

  chainData: ChainData | null = null

  constructor(
    keystore: KeystoreController,
    accounts: AccountsController,
    networks: NetworksController,
    providers: ProvidersController,
    selectedAccount: SelectedAccountController,
    portfolio: PortfolioController,
    activity: ActivityController,
    externalSignerControllers: ExternalSignerControllers,
    relayerUrl: string,
    privacyPoolsAspUrl: string,
    alchemyApiKey: string
  ) {
    super()

    this.#keystore = keystore
    this.#accounts = accounts
    this.#selectedAccount = selectedAccount
    this.#privacyPoolsAspUrl = privacyPoolsAspUrl
    this.#alchemyApiKey = alchemyApiKey
    this.#accounts = accounts
    this.#networks = networks
    this.#providers = providers
    this.#selectedAccount = selectedAccount
    this.#portfolio = portfolio
    this.#activity = activity
    this.#externalSignerControllers = externalSignerControllers
    this.#relayerUrl = relayerUrl

    this.#initialPromise = this.#load()

    this.emitUpdate()
  }

  async #load() {
    await this.#selectedAccount?.initialLoadPromise

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

  async #generateAppSecretInternal(appInfo: string): Promise<string> {
    const appIdentifier = 'privacypools.com'

    // Step 1: Derive dedicated address and wallet
    const coinType = 9001
    const privacyPoolsPath = `m/44'/${coinType}'/0'/0/0`
    const seedPhrase = await this.#getCurrentAccountSeed()

    if (!seedPhrase) {
      throw new Error('No seed phrase available for key derivation')
    }

    const mnemonic = Mnemonic.fromPhrase(seedPhrase)
    const wallet = HDNodeWallet.fromMnemonic(mnemonic, privacyPoolsPath)
    const signerAddress = wallet.address as Address
    const privateKey = wallet.privateKey

    // Create a temporary Key object
    const tempKey: Key = {
      addr: signerAddress,
      type: 'internal',
      label: 'Privacy Pools Temporary Key',
      dedicatedToOneSA: true,
      isExternallyStored: false,
      meta: {
        createdAt: Date.now(),
        privacyPools: true,
        temporary: true
      }
    }

    const signer = new KeystoreSigner(tempKey, privateKey)

    const addressHash = keccak256(toBytes(signerAddress))

    // Step 2: Construct EIP-712 payload
    const eip712Payload = getEip712Payload(appIdentifier, addressHash)

    // Step 3: Request signature using the wallet directly
    let signature: string | null = await signer.signTypedData(eip712Payload)

    const appSecret = getAppSecret(signature, signerAddress, appIdentifier, appInfo)

    signature = null // Destroy signature component

    return appSecret
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

  async #initSignAccOp(calls: Call[]) {
    if (!this.#selectedAccount?.account || this.signAccountOpController || !this.#accounts) return
    // Use the network from the first call to determine the chainId
    const chainId = calls.length > 0 ? BigInt(11155111) : 11155111n // Default to Sepolia for now
    const network = this.#networks.networks.find((net) => net.chainId === chainId)

    if (!network) return

    const provider = this.#providers.providers[network.chainId.toString()]
    const accountState = await this.#accounts.getOrFetchAccountOnChainState(
      this.#selectedAccount.account.addr,
      network.chainId
    )

    if (!this.#keystore) return

    const baseAcc = getBaseAccount(
      this.#selectedAccount.account,
      accountState,
      this.#keystore.getAccountKeys(this.#selectedAccount.account),
      network
    )

    const accountOp: AccountOp = {
      accountAddr: this.#selectedAccount.account.addr,
      chainId: network.chainId,
      signingKeyAddr: null,
      signingKeyType: null,
      gasLimit: null,
      gasFeePayment: null,
      nonce: accountState.nonce,
      signature: null,
      accountOpToExecuteBefore: null,
      calls,
      meta: {
        paymasterService: getAmbirePaymasterService(baseAcc, this.#relayerUrl)
      }
    }

    this.signAccountOpController = new SignAccountOpController(
      this.#accounts,
      this.#networks,
      this.#keystore,
      this.#portfolio,
      this.#activity,
      this.#externalSignerControllers,
      this.#selectedAccount.account,
      network,
      provider,
      randomId(), // the account op and the action are fabricated
      accountOp,
      () => true,
      false,
      undefined
    )

    // propagate updates from signAccountOp here
    this.#signAccountOpSubscriptions.push(
      this.signAccountOpController.onUpdate(() => {
        this.emitUpdate()
      })
    )
    this.#signAccountOpSubscriptions.push(
      this.signAccountOpController.onError((error) => {
        if (this.signAccountOpController)
          this.#portfolio.overridePendingResults(this.signAccountOpController.accountOp)
        this.emitError(error)
      })
    )

    this.reestimate()
  }

  update({
    depositAmount,
    withdrawalAmount,
    seedPhrase,
    targetAddress,
    importedSecretNote
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
    if (typeof importedSecretNote === 'string') {
      this.importedSecretNote = importedSecretNote
    }

    this.seedPhrase = seedPhrase || ''

    this.emitUpdate()
  }

  unloadScreen(forceUnload?: boolean) {
    if (this.hasPersistedState && !forceUnload) return

    this.destroyLatestBroadcastedAccountOp()
    this.resetForm()
  }

  resetForm() {
    this.depositAmount = ''
    this.withdrawalAmount = ''
    this.targetAddress = ''
    this.selectedToken = ''
    this.#isInitialized = false

    this.emitUpdate()
  }

  destroySignAccountOp() {
    // Unsubscribe from all previous subscriptions
    this.#signAccountOpSubscriptions.forEach((unsubscribe) => unsubscribe())
    this.#signAccountOpSubscriptions = []

    if (this.#reestimateAbortController) {
      this.#reestimateAbortController.abort()
      this.#reestimateAbortController = null
    }

    if (this.signAccountOpController) {
      this.signAccountOpController.reset()
      this.signAccountOpController = null
    }

    this.hasProceeded = false
  }

  destroyLatestBroadcastedAccountOp() {
    this.latestBroadcastedAccountOp = null
    this.emitUpdate()
  }

  setSdkInitialized() {
    this.#isInitialized = true
    this.#initializationError = null

    this.emitUpdate()
  }

  setUserProceeded(hasProceeded: boolean) {
    this.hasProceeded = hasProceeded
    this.emitUpdate()
  }

  async generateKeys() {
    try {
      // Step 1: Generate NullifyingKey
      const nullifyingKey = await this.#generateAppSecretInternal('nullifyingKey')
      console.log('DEBUG: Nullifying key:', nullifyingKey)

      // Step 2: Generate RevocableKey
      const revocableKey = await this.#generateAppSecretInternal('revocableKey')
      console.log('DEBUG: Revocable key:', revocableKey)

      // Step 3: Generate ViewingKey
      const viewingKey = await this.#generateAppSecretInternal('viewingKey')
      console.log('DEBUG: Viewing key:', viewingKey)

      // TODO: Encrypt and store keys in Extension Local Storage

      return {
        nullifyingKey,
        revocableKey,
        viewingKey
      }
    } catch (error) {
      console.error('Failed to generate keys:', error)
      throw error
    }
  }

  async generateSecret(appInfo: string = 'Standardized-Secret-Derivation-v1-App') {
    try {
      const appSecret = await this.#generateAppSecretInternal(appInfo)

      // TODO: Encrypt before saving in this.signedTypedData

      this.signedTypedData = appSecret
      console.log('DEBUG: App secret:', appSecret)

      this.emitUpdate()
    } catch (error) {
      console.error('Failed to generate app secret:', error)
      throw error
    }
  }

  async syncSignAccountOp(calls?: Call[]) {
    if (!this.#selectedAccount?.account) return

    // Build the calls based on your privacy pools operations
    const transactionCalls: Call[] = calls || []

    if (!transactionCalls.length) return

    try {
      // If SignAccountOpController is already initialized, we just update it
      if (this.signAccountOpController) {
        this.signAccountOpController.update({ calls: transactionCalls })
        return
      }

      await this.#initSignAccOp(transactionCalls)
    } catch (error) {
      this.emitError({
        level: 'major',
        message: 'Failed to initialize transaction signing',
        error: error instanceof Error ? error : new Error('Unknown error in syncSignAccountOp')
      })
    }
  }

  async reestimate() {
    // Don't run the estimation loop if there is no SignAccountOpController or if the loop is already running.
    if (!this.signAccountOpController || this.#reestimateAbortController) return

    this.#reestimateAbortController = new AbortController()
    const signal = this.#reestimateAbortController!.signal

    const loop = async () => {
      while (!signal.aborted) {
        // eslint-disable-next-line no-await-in-loop
        await wait(30000)
        if (signal.aborted) break

        if (this.signAccountOpController?.estimation.status !== EstimationStatus.Loading) {
          // eslint-disable-next-line no-await-in-loop
          await this.signAccountOpController?.estimate()
        }

        if (this.signAccountOpController?.estimation.errors.length) {
          console.log(
            'DEBUG: Errors on PrivacyPools re-estimate',
            this.signAccountOpController.estimation.errors
          )
        }
      }
    }

    loop()
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

  get hasPersistedState() {
    return !!(this.depositAmount || this.withdrawalAmount || this.targetAddress)
  }

  toJSON() {
    return {
      ...this,
      ...super.toJSON(),
      isInitialized: this.isInitialized,
      initialPromiseLoaded: this.initialPromiseLoaded,
      hasPersistedState: this.hasPersistedState
    }
  }
}

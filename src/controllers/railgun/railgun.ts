/* eslint-disable no-console */
import type { Hex } from 'viem'
import EventEmitter from '../eventEmitter/eventEmitter'
import { SignAccountOpController } from '../signAccountOp/signAccountOp'
import { AccountOp } from '../../libs/accountOp/accountOp'
import { AddressState } from '../../interfaces/domains'

interface RailgunFormUpdate {
  depositAmount?: string
  privacyProvider?: string
  chainId?: number
}

const DEFAULT_ADDRESS_STATE = {
  fieldValue: '',
  ensAddress: '',
  isDomainResolving: false
}

export class RailgunController extends EventEmitter {
  #initialPromise: Promise<void> | null = null

  #initialPromiseLoaded: boolean = false

  shouldTrackLatestBroadcastedAccountOp: boolean = true

  signAccountOpController: SignAccountOpController | null = null

  latestBroadcastedAccountOp: AccountOp | null = null

  hasProceeded: boolean = false

  depositAmount: string = ''

  privacyProvider: string = 'railgun'

  chainId: number = 11155111 // Default to Sepolia

  addressState: AddressState = { ...DEFAULT_ADDRESS_STATE }

  #selectedToken: any = null

  // Transfer/Withdrawal-specific properties (kept for interface compatibility)
  amountInFiat: string = ''

  amountFieldMode: 'token' | 'fiat' = 'token'

  isRecipientAddressUnknown: boolean = false

  isRecipientAddressUnknownAgreed: boolean = false

  latestBroadcastedToken: any = null

  programmaticUpdateCounter: number = 0

  withdrawalAmount: string = ''

  maxAmount: string = ''

  validationFormMsgs: {
    amount: { success: boolean; message: string }
    recipientAddress: { success: boolean; message: string }
  } = {
    amount: { success: true, message: '' },
    recipientAddress: { success: true, message: '' }
  }

  constructor() {
    super()

    this.#initialPromise = this.#load()

    this.emitUpdate()
  }

  async #load() {
    // Minimal initialization for Railgun
    // Railgun-specific SDK and configuration will be added here later
    this.#initialPromiseLoaded = true
  }


  update({ depositAmount, privacyProvider, chainId }: RailgunFormUpdate) {
    console.log('DEBUG: RAILGUN CONTROLLER UPDATE', { depositAmount, privacyProvider, chainId })

    if (typeof depositAmount === 'string') {
      this.depositAmount = depositAmount
    }

    if (typeof privacyProvider === 'string') {
      this.privacyProvider = privacyProvider
    }

    if (typeof chainId === 'number') {
      this.chainId = chainId
    }

    this.emitUpdate()
  }

  unloadScreen(forceUnload?: boolean) {
    if (this.hasPersistedState && !forceUnload) return

    this.destroyLatestBroadcastedAccountOp()
    this.resetForm()
  }

  resetForm(shouldDestroyAccountOp = true) {
    this.selectedToken = null
    this.depositAmount = ''
    this.withdrawalAmount = ''
    this.addressState = { ...DEFAULT_ADDRESS_STATE }
    this.amountInFiat = ''
    this.amountFieldMode = 'token'
    this.isRecipientAddressUnknown = false
    this.isRecipientAddressUnknownAgreed = false
    this.latestBroadcastedToken = null
    this.programmaticUpdateCounter = 0
    this.validationFormMsgs = {
      amount: { success: true, message: '' },
      recipientAddress: { success: true, message: '' }
    }

    if (shouldDestroyAccountOp) {
      this.destroySignAccountOp()
    }

    this.emitUpdate()
  }

  destroySignAccountOp() {
    if (this.signAccountOpController) {
      this.signAccountOpController.reset()
      this.signAccountOpController = null
    }

    this.hasProceeded = false
  }

  destroyLatestBroadcastedAccountOp() {
    this.shouldTrackLatestBroadcastedAccountOp = false
    this.latestBroadcastedAccountOp = null
    this.emitUpdate()
  }

  setUserProceeded(hasProceeded: boolean) {
    this.hasProceeded = hasProceeded
    this.emitUpdate()
  }

  set selectedToken(token: any) {
    this.#selectedToken = token
  }

  get selectedToken() {
    return this.#selectedToken
  }

  get initialPromiseLoaded(): boolean {
    return this.#initialPromiseLoaded
  }

  get hasPersistedState() {
    return !!this.depositAmount
  }

  get recipientAddress() {
    return this.addressState.ensAddress || this.addressState.fieldValue
  }

  toJSON() {
    return {
      ...this,
      ...super.toJSON(),
      initialPromiseLoaded: this.initialPromiseLoaded,
      hasPersistedState: this.hasPersistedState,
      selectedToken: this.selectedToken,
      recipientAddress: this.recipientAddress
    }
  }
}

/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable class-methods-use-this */
/* eslint-disable @typescript-eslint/no-useless-constructor */
/* eslint-disable max-classes-per-file */

import { hexlify, randomBytes } from 'ethers'
import fetch from 'node-fetch'

import { expect } from '@jest/globals'

import { relayerUrl, velcroUrl } from '../../../test/config'
import { mockInternalKeys, produceMemoryStore } from '../../../test/helpers'
import { mockWindowManager } from '../../../test/helpers/window'
import { EIP7702Auth } from '../../consts/7702'
import { DEFAULT_ACCOUNT_LABEL } from '../../consts/account'
import { FEE_COLLECTOR } from '../../consts/addresses'
import humanizerInfo from '../../consts/humanizer/humanizerInfo.json'
import { networks } from '../../consts/networks'
import { Account } from '../../interfaces/account'
import { Hex } from '../../interfaces/hex'
import { Key, TxnRequest } from '../../interfaces/keystore'
import { EIP7702Signature } from '../../interfaces/signatures'
import { HumanizerMeta } from '../../libs/humanizer/interfaces'
import { Portfolio } from '../../libs/portfolio'
import { relayerCall } from '../../libs/relayerCall/relayerCall'
import { getRpcProvider } from '../../services/provider'
import { AccountsController } from '../accounts/accounts'
import { ActivityController } from '../activity/activity'
import { AddressBookController } from '../addressBook/addressBook'
import { BannerController } from '../banner/banner'
import { KeystoreController } from '../keystore/keystore'
import { NetworksController } from '../networks/networks'
import { PortfolioController } from '../portfolio/portfolio'
import { ProvidersController } from '../providers/providers'
import { SelectedAccountController } from '../selectedAccount/selectedAccount'
import { StorageController } from '../storage/storage'
import { TransferController } from './transfer'

const ethereum = networks.find((x) => x.chainId === 1n)
const polygon = networks.find((x) => x.chainId === 137n)

if (!ethereum || !polygon) throw new Error('Failed to find ethereum in networks')

const provider = getRpcProvider(ethereum.rpcUrls, ethereum.chainId)
const polygonProvider = getRpcProvider(polygon.rpcUrls, polygon.chainId)
const PLACEHOLDER_RECIPIENT = '0xc4A6bB5139123bD6ba0CF387828a9A3a73EF8D1e'
const PLACEHOLDER_SELECTED_ACCOUNT: Account = {
  addr: '0xC2E6dFcc2C6722866aD65F211D5757e1D2879337',
  associatedKeys: ['0xC2E6dFcc2C6722866aD65F211D5757e1D2879337'],
  creation: {
    factoryAddr: '0x00',
    bytecode: '0x000',
    salt: '0x000'
  },
  initialPrivileges: [['0x00', '0x01']],
  preferences: {
    label: DEFAULT_ACCOUNT_LABEL,
    pfp: '0xC2E6dFcc2C6722866aD65F211D5757e1D2879337'
  }
}
const XWALLET_ADDRESS = '0x47Cd7E91C3CBaAF266369fe8518345fc4FC12935'
const STK_WALLET_ADDRESS = '0xE575cC6EC0B5d176127ac61aD2D3d9d19d1aa4a0'

const ethPortfolio = new Portfolio(fetch, provider, ethereum, velcroUrl)
const polygonPortfolio = new Portfolio(fetch, polygonProvider, polygon, velcroUrl)

let transferController: TransferController

const providers = Object.fromEntries(
  networks.map((network) => [network.chainId, getRpcProvider(network.rpcUrls, network.chainId)])
)

let providersCtrl: ProvidersController

const account = {
  addr: '0xB674F3fd5F43464dB0448a57529eAF37F04cceA5',
  initialPrivileges: [],
  associatedKeys: ['0x5Be214147EA1AE3653f289E17fE7Dc17A73AD175'],
  creation: {
    factoryAddr: '0xBf07a0Df119Ca234634588fbDb5625594E2a5BCA',
    bytecode:
      '0x7f00000000000000000000000000000000000000000000000000000000000000017f02c94ba85f2ea274a3869293a0a9bf447d073c83c617963b0be7c862ec2ee44e553d602d80604d3d3981f3363d3d373d3d3d363d732a2b85eb1054d6f0c6c2e37da05ed3e5fea684ef5af43d82803e903d91602b57fd5bf3',
    salt: '0x2ee01d932ede47b0b2fb1b6af48868de9f86bfc9a5be2f0b42c0111cf261d04c'
  },
  preferences: {
    label: DEFAULT_ACCOUNT_LABEL,
    pfp: '0xB674F3fd5F43464dB0448a57529eAF37F04cceA5'
  }
}

const storage = produceMemoryStore()
const storageCtrl = new StorageController(storage)

const accounts = [account]

const mockKeys = mockInternalKeys(accounts as Account[])

storage.set('keystoreKeys', mockKeys)

storageCtrl.set('accounts', accounts)

const networksCtrl = new NetworksController({
  storage: storageCtrl,
  fetch,
  relayerUrl,
  onAddOrUpdateNetworks: (nets) => {
    nets.forEach((n) => {
      providersCtrl.setProvider(n)
    })
  },
  onRemoveNetwork: (id) => {
    providersCtrl.removeProvider(id)
  }
})
providersCtrl = new ProvidersController(networksCtrl)
providersCtrl.providers = providers

// TODO - this mocks are being duplicated across the tests. Should reuse it.
class InternalSigner {
  key

  privKey

  constructor(_key: Key, _privKey?: string) {
    this.key = _key
    this.privKey = _privKey
  }

  signRawTransaction() {
    return Promise.resolve('')
  }

  signTypedData() {
    return Promise.resolve('')
  }

  signMessage() {
    return Promise.resolve('')
  }

  sign7702(hex: string): EIP7702Signature {
    return {
      yParity: '0x00',
      r: hexlify(randomBytes(32)) as Hex,
      s: hexlify(randomBytes(32)) as Hex
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  signTransactionTypeFour(txnRequest: TxnRequest, eip7702Auth: EIP7702Auth): Hex {
    throw new Error('not supported')
  }
}

class LedgerSigner {
  key

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  constructor(_key: Key) {
    this.key = _key
  }

  signRawTransaction() {
    return Promise.resolve('')
  }

  signTypedData() {
    return Promise.resolve('')
  }

  signMessage() {
    return Promise.resolve('')
  }

  sign7702(hex: string): EIP7702Signature {
    return {
      yParity: '0x00',
      r: hexlify(randomBytes(32)) as Hex,
      s: hexlify(randomBytes(32)) as Hex
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  signTransactionTypeFour(txnRequest: TxnRequest, eip7702Auth: EIP7702Auth): Hex {
    throw new Error('not supported')
  }
}

const windowManager = mockWindowManager().windowManager
const keystoreSigners = { internal: InternalSigner, ledger: LedgerSigner }
const keystoreController = new KeystoreController(
  'default',
  storageCtrl,
  keystoreSigners,
  windowManager
)

const accountsCtrl = new AccountsController(
  storageCtrl,
  providersCtrl,
  networksCtrl,
  keystoreController,
  () => {},
  () => {},
  () => {}
)

const selectedAccountCtrl = new SelectedAccountController({
  storage: storageCtrl,
  accounts: accountsCtrl,
  keystore: keystoreController
})

const addressBookController = new AddressBookController(
  storageCtrl,
  accountsCtrl,
  selectedAccountCtrl
)

const callRelayer = relayerCall.bind({ url: '', fetch })

const portfolioController = new PortfolioController(
  storageCtrl,
  fetch,
  providersCtrl,
  networksCtrl,
  accountsCtrl,
  keystoreController,
  relayerUrl,
  velcroUrl,
  new BannerController(storageCtrl)
)
const activity = new ActivityController(
  storageCtrl,
  fetch,
  callRelayer,
  accountsCtrl,
  selectedAccountCtrl,
  providersCtrl,
  networksCtrl,
  portfolioController,
  () => Promise.resolve()
)

const getTokens = async () => {
  const ethAccPortfolio = await ethPortfolio.get(PLACEHOLDER_SELECTED_ACCOUNT.addr)
  const polygonAccPortfolio = await polygonPortfolio.get(PLACEHOLDER_SELECTED_ACCOUNT.addr)

  return [...ethAccPortfolio.tokens, ...polygonAccPortfolio.tokens]
}

describe('Transfer Controller', () => {
  test('should initialize', async () => {
    transferController = new TransferController(
      storageCtrl,
      humanizerInfo as HumanizerMeta,
      selectedAccountCtrl,
      networksCtrl,
      addressBookController,
      accountsCtrl,
      keystoreController,
      portfolioController,
      activity,
      {},
      providersCtrl,
      relayerUrl
    )

    await selectedAccountCtrl.initialLoadPromise
    await selectedAccountCtrl.setAccount(account)

    expect(transferController.isInitialized).toBe(true)
  })
  test('should set address state', async () => {
    await transferController.update({
      addressState: {
        fieldValue: PLACEHOLDER_RECIPIENT,
        ensAddress: '',
        isDomainResolving: false
      }
    })
    expect(transferController.addressState.fieldValue).toBe(PLACEHOLDER_RECIPIENT)
  })
  test('should set recipient address unknown', () => {
    expect(transferController.isRecipientAddressUnknown).toBe(true)
  })
  test('should flag recipient address as a smart contract', async () => {
    await transferController.update({
      addressState: {
        fieldValue: XWALLET_ADDRESS,
        ensAddress: '',
        isDomainResolving: false
      }
    })
    expect(transferController.isRecipientHumanizerKnownTokenOrSmartContract).toBe(true)
  })
  test('should show SW warning', async () => {
    const tokens = await getTokens()
    const polOnPolygon = tokens.find(
      (t) => t.address === '0x0000000000000000000000000000000000000000' && t.chainId === 137n
    )

    await transferController.update({ selectedToken: polOnPolygon })
    expect(transferController.isSWWarningVisible).toBe(true)
  })
  test('should change selected token', async () => {
    const tokens = await getTokens()
    const xwalletOnEthereum = tokens.find(
      (t) => t.address === STK_WALLET_ADDRESS && t.chainId === 1n
    )
    await transferController.update({ selectedToken: xwalletOnEthereum })

    expect(transferController.selectedToken?.address).toBe(STK_WALLET_ADDRESS)
    expect(transferController.selectedToken?.chainId).toBe(1n)
  })

  test('should set amount', async () => {
    await transferController.update({
      amount: '1'
    })
    expect(transferController.amount).toBe('1')
  })
  test('should set sw warning agreed', async () => {
    await transferController.update({
      isSWWarningAgreed: true
    })
    expect(transferController.isSWWarningAgreed).toBe(true)
  })
  test('should set validation form messages', async () => {
    await transferController.update({
      addressState: {
        fieldValue: PLACEHOLDER_RECIPIENT,
        ensAddress: '',
        isDomainResolving: false
      }
    })

    expect(transferController.validationFormMsgs.amount.success).toBe(true)
    expect(transferController.validationFormMsgs.recipientAddress.success).toBe(false)

    // Recipient address
    await transferController.update({
      isRecipientAddressUnknownAgreed: true
    })
    expect(transferController.validationFormMsgs.recipientAddress.success).toBe(true)
    // Amount
    await transferController.update({
      amount: '0'
    })

    expect(transferController.validationFormMsgs.amount.success).toBe(false)

    await transferController.update({
      amount: transferController.maxAmount
    })
    await transferController.update({
      amount: String(Number(transferController.amount) + 1)
    })

    expect(transferController.validationFormMsgs.amount.success).toBe(false)

    // Reset
    await transferController.update({
      amount: transferController.maxAmount
    })
  })
  test("should reject a token that doesn't have amount or amountPostSimulation for transfer", async () => {
    const tokens = await getTokens()
    const zeroAmountToken = tokens.find(
      (t) => t.address === '0x8793Fb615Eb92822F482f88B3137B00aad4C00D2' && t.chainId === 1n
    )
    await transferController.update({ selectedToken: zeroAmountToken })
    expect(transferController.selectedToken?.address).not.toBe(zeroAmountToken?.address)
  })
  test("should accept a token that doesn't have amount but has amountPostSimulation for transfer", async () => {
    const tokens = await getTokens()
    const nativeToken = tokens.find(
      (t) => t.address === '0x0000000000000000000000000000000000000000' && t.chainId === 1n
    )
    nativeToken!.amountPostSimulation = 10n
    await transferController.update({ selectedToken: nativeToken })
    expect(transferController.selectedToken).not.toBe(null)
  })

  test('should detect that the recipient is the fee collector', async () => {
    await transferController.update({
      addressState: {
        fieldValue: FEE_COLLECTOR,
        ensAddress: '',
        isDomainResolving: false
      }
    })
    expect(transferController.isRecipientHumanizerKnownTokenOrSmartContract).toBeFalsy()
    expect(transferController.isRecipientAddressUnknown).toBeFalsy()
  })

  const checkResetForm = () => {
    expect(transferController.amount).toBe('')
    expect(transferController.recipientAddress).toBe('')
    expect(transferController.selectedToken).toBeNull()
    expect(transferController.isRecipientAddressUnknown).toBe(false)
    expect(transferController.addressState).toEqual({
      fieldValue: '',
      ensAddress: '',
      isDomainResolving: false
    })
    expect(transferController.isRecipientAddressUnknownAgreed).toBe(false)
    expect(transferController.isRecipientHumanizerKnownTokenOrSmartContract).toBe(false)
    expect(transferController.isSWWarningVisible).toBe(false)
    expect(transferController.isSWWarningAgreed).toBe(false)
  }

  test('should reset form', () => {
    transferController.resetForm()

    checkResetForm()
  })

  test('should toJSON()', () => {
    const json = transferController.toJSON()
    expect(json).toBeDefined()
  })
})

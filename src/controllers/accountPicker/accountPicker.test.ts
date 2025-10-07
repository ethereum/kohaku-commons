/* eslint-disable @typescript-eslint/no-floating-promises */
import { Wallet } from 'ethers'
import fetch from 'node-fetch'

/* eslint-disable no-new */
import { describe, expect, test } from '@jest/globals'

import { relayerUrl } from '../../../test/config'
import { produceMemoryStore } from '../../../test/helpers'
import { suppressConsoleBeforeEach } from '../../../test/helpers/console'
import { mockWindowManager } from '../../../test/helpers/window'
import { DEFAULT_ACCOUNT_LABEL } from '../../consts/account'
import {
  BIP44_STANDARD_DERIVATION_TEMPLATE,
  DERIVATION_OPTIONS,
  SMART_ACCOUNT_SIGNER_KEY_DERIVATION_OFFSET
} from '../../consts/derivation'
import { networks } from '../../consts/networks'
import { Account } from '../../interfaces/account'
import { Storage } from '../../interfaces/storage'
import { isSmartAccount } from '../../libs/account/account'
import { getPrivateKeyFromSeed, KeyIterator } from '../../libs/keyIterator/keyIterator'
import { getRpcProvider } from '../../services/provider'
import { AccountsController } from '../accounts/accounts'
import { KeystoreController } from '../keystore/keystore'
import { NetworksController } from '../networks/networks'
import { ProvidersController } from '../providers/providers'
import { StorageController } from '../storage/storage'
import { AccountPickerController, DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from './accountPicker'

const windowManager = mockWindowManager().windowManager

const providers = Object.fromEntries(
  networks.map((network) => [network.chainId, getRpcProvider(network.rpcUrls, network.chainId)])
)

const key1to11BasicAccPublicAddresses = Array.from(
  { length: 11 },
  (_, i) =>
    new Wallet(getPrivateKeyFromSeed(process.env.SEED, null, i, BIP44_STANDARD_DERIVATION_TEMPLATE))
      .address
)

const key1to11BasicAccUsedForSmartAccKeysOnlyPublicAddresses = Array.from(
  { length: 11 },
  (_, i) =>
    new Wallet(
      getPrivateKeyFromSeed(
        process.env.SEED,
        null,
        i + SMART_ACCOUNT_SIGNER_KEY_DERIVATION_OFFSET,
        BIP44_STANDARD_DERIVATION_TEMPLATE
      )
    ).address
)

const key1PublicAddress = key1to11BasicAccPublicAddresses[0]

const basicAccount: Account = {
  addr: key1PublicAddress,
  associatedKeys: [key1PublicAddress],
  initialPrivileges: [
    [key1PublicAddress, '0x0000000000000000000000000000000000000000000000000000000000000001']
  ],
  creation: null,
  preferences: {
    label: DEFAULT_ACCOUNT_LABEL,
    pfp: key1PublicAddress
  }
}

describe('AccountPicker', () => {
  let accountPicker: AccountPickerController
  const storage: Storage = produceMemoryStore()
  let providersCtrl: ProvidersController
  const storageCtrl = new StorageController(storage)
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
  const keystoreController = new KeystoreController('default', storageCtrl, {}, windowManager)

  const accountsCtrl = new AccountsController(
    storageCtrl,
    providersCtrl,
    networksCtrl,
    keystoreController,
    () => {},
    () => {},
    () => {}
  )
  beforeEach(() => {
    accountPicker = new AccountPickerController({
      accounts: accountsCtrl,
      keystore: new KeystoreController('default', storageCtrl, {}, windowManager),
      networks: networksCtrl,
      providers: providersCtrl,
      relayerUrl,
      fetch,
      externalSignerControllers: {},
      onAddAccountsSuccessCallback: () => Promise.resolve()
    })
  })

  test.skip('should initialize', async () => {
    const keyIterator = new KeyIterator(process.env.SEED)
    const hdPathTemplate = BIP44_STANDARD_DERIVATION_TEMPLATE
    accountPicker.setInitParams({ keyIterator, hdPathTemplate })
    await accountPicker.init()
    expect(accountPicker.page).toEqual(DEFAULT_PAGE)
    expect(accountPicker.pageSize).toEqual(DEFAULT_PAGE_SIZE)
    expect(accountPicker.isInitialized).toBeTruthy()
    expect(accountPicker.selectedAccounts.length).toEqual(1)
    expect(accountPicker.hdPathTemplate).toEqual(hdPathTemplate)
    expect(accountPicker.shouldGetAccountsUsedOnNetworks).toBeFalsy()
    expect(accountPicker.shouldSearchForLinkedAccounts).toBeFalsy()
  })

  describe('Negative tests', () => {
    suppressConsoleBeforeEach()
    test('should throw if AccountPicker controller method is requested, but the controller was not initialized beforehand', (done) => {
      const unsubscribe = accountPicker.onError(() => {
        const notInitializedErrorsCount = accountPicker.emittedErrors.filter(
          (e) =>
            e.error.message ===
            'accountPicker: requested a method of the AccountPicker controller, but the controller was not initialized'
        ).length

        if (notInitializedErrorsCount === 4) {
          expect(notInitializedErrorsCount).toEqual(4)
          unsubscribe()
          done()
        }
      })

      accountPicker.setPage({ page: 1 })
      accountPicker.selectAccount(basicAccount)
      accountPicker.deselectAccount(basicAccount)
      accountPicker.addAccounts()
    })

    test.skip('should throw if AccountPicker controller gets initialized, but the keyIterator is missing', (done) => {
      const unsubscribe = accountPicker.onError(() => {
        const missingKeyIteratorError = accountPicker.emittedErrors.find(
          (e) => e.error.message === 'accountPicker: missing keyIterator'
        )

        if (missingKeyIteratorError) {
          expect(missingKeyIteratorError).toBeTruthy()
          unsubscribe()
          done()
        }
      })

      accountPicker.setInitParams({
        keyIterator: null,
        hdPathTemplate: BIP44_STANDARD_DERIVATION_TEMPLATE
      })
      accountPicker.init()
    })
  })

  test('should retrieve 5 basic and one smart account on each page', async () => {
    const PAGE_SIZE = 5
    const keyIterator = new KeyIterator(process.env.SEED)
    accountPicker.setInitParams({
      keyIterator,
      pageSize: PAGE_SIZE,
      hdPathTemplate: BIP44_STANDARD_DERIVATION_TEMPLATE,
      shouldGetAccountsUsedOnNetworks: false,
      shouldSearchForLinkedAccounts: false,
      shouldAddNextAccountAutomatically: false
    })
    await accountPicker.init()
    await accountPicker.setPage({ page: 1 })
    expect(accountPicker.accountsOnPage).toHaveLength(6)
    expect(accountPicker.accountsOnPage.filter((a) => isSmartAccount(a.account))).toHaveLength(1)
    expect(accountPicker.accountsOnPage.filter((a) => !isSmartAccount(a.account))).toHaveLength(5)

    await accountPicker.setPage({ page: 2 })
    expect(accountPicker.accountsOnPage).toHaveLength(6)
    expect(accountPicker.accountsOnPage.filter((a) => isSmartAccount(a.account))).toHaveLength(1)
    expect(accountPicker.accountsOnPage.filter((a) => !isSmartAccount(a.account))).toHaveLength(5)
  })

  test.skip('should find linked accounts', async () => {
    const keyIterator = new KeyIterator(process.env.SEED)
    accountPicker.setInitParams({
      keyIterator,
      pageSize: 3,
      hdPathTemplate: BIP44_STANDARD_DERIVATION_TEMPLATE,
      shouldGetAccountsUsedOnNetworks: false,
      shouldAddNextAccountAutomatically: false
    })
    await accountPicker.init()
    await accountPicker.setPage({ page: 1 })
    expect(accountPicker.linkedAccountsLoading).toBe(false)
    const linkedAccountsOnPage = accountPicker.accountsOnPage.filter(({ isLinked }) => isLinked)

    const accountsOnSlot1 = linkedAccountsOnPage
      .filter(({ slot }) => slot === 1)
      .map(({ account }) => account.addr)
    // This account was manually added as a signer to one of our test accounts
    expect(accountsOnSlot1).toContain('0x740523d7876Fbb8AF246c5B307f26d4b2D2BFDA9')

    const accountsOnSlot3 = linkedAccountsOnPage
      .filter(({ slot }) => slot === 3)
      .map(({ account }) => account.addr)
    // These accounts was manually added as signers to our test accounts
    expect(accountsOnSlot3).toContain('0x0ace96748e66F42EBeA22D777C2a99eA2c83D8A6')
    expect(accountsOnSlot3).toContain('0xc583f33d502dE560dd2C60D4103043d5998A98E5')
    expect(accountsOnSlot3).toContain('0x63caaD57Cd66A69A4c56b595E3A4a1e4EeA066d8')
    expect(accountsOnSlot3).toContain('0x619A6a273c628891dD0994218BC0625947653AC7')
    expect(accountsOnSlot3).toContain('0x7ab87ab041EB1c4f0d4f4d1ABD5b0973B331e2E7')
  })

  test('should be able to select and then deselect an account', async () => {
    const keyIterator = new KeyIterator(process.env.SEED)
    accountPicker.setInitParams({
      keyIterator,
      pageSize: 1,
      hdPathTemplate: BIP44_STANDARD_DERIVATION_TEMPLATE,
      shouldSearchForLinkedAccounts: false,
      shouldGetAccountsUsedOnNetworks: false,
      shouldAddNextAccountAutomatically: false
    })
    await accountPicker.init()
    await accountPicker.setPage({ page: 1 })

    accountPicker.selectAccount(basicAccount)
    const selectedAccountAddr = accountPicker.selectedAccounts.map((a) => a.account.addr)
    expect(selectedAccountAddr).toContain(basicAccount.addr)

    accountPicker.deselectAccount(basicAccount)
    expect(accountPicker.selectedAccounts).toHaveLength(0)
  })

  test('should NOT be able to select the same account more than once', async () => {
    const keyIterator = new KeyIterator(process.env.SEED)
    accountPicker.setInitParams({
      keyIterator,
      pageSize: 1,
      hdPathTemplate: BIP44_STANDARD_DERIVATION_TEMPLATE,
      shouldSearchForLinkedAccounts: false,
      shouldGetAccountsUsedOnNetworks: false,
      shouldAddNextAccountAutomatically: false
    })
    await accountPicker.init()
    await accountPicker.setPage({ page: 1 })

    accountPicker.selectAccount(basicAccount)
    accountPicker.selectAccount(basicAccount)
    accountPicker.selectAccount(basicAccount)

    expect(accountPicker.selectedAccounts).toHaveLength(1)
    const selectedAccountAddr = accountPicker.selectedAccounts.map((a) => a.account.addr)
    expect(selectedAccountAddr).toContain(basicAccount.addr)
  })

  test('should be able to select all the keys of a selected EOA (always one key)', async () => {
    const keyIterator = new KeyIterator(process.env.SEED)
    accountPicker.setInitParams({
      keyIterator,
      hdPathTemplate: BIP44_STANDARD_DERIVATION_TEMPLATE,
      shouldSearchForLinkedAccounts: false,
      shouldGetAccountsUsedOnNetworks: false,
      shouldAddNextAccountAutomatically: false
    })
    await accountPicker.init()
    await accountPicker.setPage({ page: 1 })

    accountPicker.selectAccount(basicAccount)

    expect(accountPicker.selectedAccounts[0].accountKeys).toHaveLength(1)
    const keyAddr = accountPicker.selectedAccounts[0].accountKeys[0].addr
    const keyIndex = accountPicker.selectedAccounts[0].accountKeys[0].index
    expect(keyAddr).toEqual(basicAccount.addr)
    expect(keyIndex).toEqual(0)
  })

  test('should be able to select all the keys of a selected smart account (derived key)', async () => {
    const keyIterator = new KeyIterator(process.env.SEED)
    accountPicker.setInitParams({
      keyIterator,
      hdPathTemplate: BIP44_STANDARD_DERIVATION_TEMPLATE,
      shouldSearchForLinkedAccounts: false,
      shouldGetAccountsUsedOnNetworks: false,
      shouldAddNextAccountAutomatically: false
    })
    await accountPicker.init()
    await accountPicker.setPage({ page: 1 })

    const smartAccount = accountPicker.accountsOnPage.find((x) => isSmartAccount(x.account))
    if (smartAccount) accountPicker.selectAccount(smartAccount.account)

    expect(accountPicker.selectedAccounts[0].accountKeys)
      // Might contain other keys too, but this one should be in there,
      // since that's the derived used only for smart account key
      .toContainEqual({
        addr: key1to11BasicAccUsedForSmartAccKeysOnlyPublicAddresses[0],
        index: SMART_ACCOUNT_SIGNER_KEY_DERIVATION_OFFSET,
        slot: 1
      })
  })

  DERIVATION_OPTIONS.forEach(({ label, value }) => {
    test(`should derive correctly ${label}`, async () => {
      const keyIterator = new KeyIterator(process.env.SEED)
      const pageSize = 5
      accountPicker.setInitParams({
        keyIterator,
        hdPathTemplate: value,
        pageSize,
        shouldSearchForLinkedAccounts: false,
        shouldGetAccountsUsedOnNetworks: false,
        shouldAddNextAccountAutomatically: false
      })
      await accountPicker.init()

      // Checks page 1 EOAs
      await accountPicker.setPage({ page: 1 })
      const basicAccountsOnFirstPage = accountPicker.accountsOnPage.filter(
        (x) => !isSmartAccount(x.account)
      )
      const key1to5BasicAccPublicAddresses = Array.from(
        { length: pageSize },
        (_, i) => new Wallet(getPrivateKeyFromSeed(process.env.SEED, null, i, value)).address
      )
      basicAccountsOnFirstPage.forEach((x) => {
        const address = x.account.addr
        expect(address).toBe(key1to5BasicAccPublicAddresses[x.index])
      })

      // Checks page 2 EOAs
      await accountPicker.setPage({ page: 2 })
      const basicAccountsOnSecondPage = accountPicker.accountsOnPage.filter(
        (x) => !isSmartAccount(x.account)
      )
      const key6to10BasicAccPublicAddresses = Array.from(
        { length: pageSize },
        (_, i) =>
          new Wallet(getPrivateKeyFromSeed(process.env.SEED, null, i + pageSize, value)).address
      )
      basicAccountsOnSecondPage.forEach((x) => {
        const address = x.account.addr
        expect(address).toBe(key6to10BasicAccPublicAddresses[x.index - pageSize])
      })
    })
  })
})

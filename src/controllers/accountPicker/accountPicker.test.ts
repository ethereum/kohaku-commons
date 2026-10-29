/* eslint-disable @typescript-eslint/no-floating-promises */
import { Wallet } from 'ethers'
import fetch from 'node-fetch'

/* eslint-disable no-new */
import { describe, expect, jest, test } from '@jest/globals'

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
import { Account, ImportStatus } from '../../interfaces/account'
import { KeyIterator as KeyIteratorInterface } from '../../interfaces/keyIterator'
import { dedicatedToOneSAPriv, Key } from '../../interfaces/keystore'
import { Storage } from '../../interfaces/storage'
import {
  getBasicAccount,
  getSmartAccount,
  isDerivedForSmartAccountKeyOnly,
  isSmartAccount
} from '../../libs/account/account'
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
  networks
    .filter((network) => network.rpcUrls.length)
    .map((network) => [network.chainId, getRpcProvider(network)])
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

  test('should initialize', async () => {
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

    test('should throw if AccountPicker controller gets initialized, but the keyIterator is missing', (done) => {
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

  test('should retrieve 5 basic accounts, one smart account and its key on each page', async () => {
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
    expect(accountPicker.accountsOnPage).toHaveLength(7)
    expect(accountPicker.accountsOnPage.filter((a) => isSmartAccount(a.account))).toHaveLength(1)
    expect(
      accountPicker.accountsOnPage.filter(
        (a) => !isSmartAccount(a.account) && !isDerivedForSmartAccountKeyOnly(a.index)
      )
    ).toHaveLength(5)
    expect(
      accountPicker.accountsOnPage.filter((a) => isDerivedForSmartAccountKeyOnly(a.index))
    ).toHaveLength(1)

    await accountPicker.setPage({ page: 2 })
    expect(accountPicker.accountsOnPage).toHaveLength(7)
    expect(accountPicker.accountsOnPage.filter((a) => isSmartAccount(a.account))).toHaveLength(1)
    expect(
      accountPicker.accountsOnPage.filter(
        (a) => !isSmartAccount(a.account) && !isDerivedForSmartAccountKeyOnly(a.index)
      )
    ).toHaveLength(5)
    expect(
      accountPicker.accountsOnPage.filter((a) => isDerivedForSmartAccountKeyOnly(a.index))
    ).toHaveLength(1)
  })

  test('should find linked accounts', async () => {
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

  describe('on a newly created seed', () => {
    const addressAt = (seed: string, index: number) =>
      new Wallet(getPrivateKeyFromSeed(seed, null, index, BIP44_STANDARD_DERIVATION_TEMPLATE))
        .address

    const pickerWithImported = (importedAccounts: Account[], keys: Key[]) =>
      new AccountPickerController({
        accounts: {
          accounts: importedAccounts,
          onUpdate: () => () => {}
        } as unknown as AccountsController,
        keystore: {
          keys,
          onUpdate: () => () => {}
        } as unknown as KeystoreController,
        networks: networksCtrl,
        providers: providersCtrl,
        relayerUrl,
        fetch,
        externalSignerControllers: {},
        onAddAccountsSuccessCallback: () => Promise.resolve()
      })

    const createFlowParams = (
      seed: string
    ): Parameters<AccountPickerController['setInitParams']>[0] => ({
      keyIterator: new KeyIterator(seed),
      hdPathTemplate: BIP44_STANDARD_DERIVATION_TEMPLATE,
      shouldSearchForLinkedAccounts: false,
      shouldGetAccountsUsedOnNetworks: false,
      shouldAddNextAccountAutomatically: false,
      shouldSelectSmartAccountAutomatically: true
    })

    test('selects the smart account of the next slot and then its controlling key', async () => {
      const seed = Wallet.createRandom().mnemonic!.phrase
      accountPicker.setInitParams(createFlowParams(seed))
      await accountPicker.init()
      await accountPicker.selectNextAccount()

      const keyAddr = addressAt(seed, SMART_ACCOUNT_SIGNER_KEY_DERIVATION_OFFSET)
      const keyEntry = { addr: keyAddr, index: SMART_ACCOUNT_SIGNER_KEY_DERIVATION_OFFSET, slot: 1 }

      expect(accountPicker.selectedAccounts).toHaveLength(2)
      const [smartAcc, key] = accountPicker.selectedAccounts
      expect(isSmartAccount(smartAcc.account)).toBe(true)
      expect(smartAcc.accountKeys).toEqual([keyEntry])
      expect(isSmartAccount(key.account)).toBe(false)
      expect(key.account.addr).toBe(keyAddr)
      expect(key.accountKeys).toEqual([keyEntry])
      // The ordinary basic account of the slot is not selected.
      expect(accountPicker.selectedAccounts.map((a) => a.account.addr)).not.toContain(
        addressAt(seed, 0)
      )
    })

    test('hands the keystore only the controlling key, marked as dedicated to one smart account', async () => {
      const seed = Wallet.createRandom().mnemonic!.phrase
      accountPicker.setInitParams(createFlowParams(seed))
      await accountPicker.init()
      await accountPicker.selectNextAccount()

      const keys = accountPicker.retrieveInternalKeysOfSelectedAccounts()
      expect(keys.length).toBeGreaterThan(0)
      // The key comes once for the smart account and once for itself; the
      // keystore drops the duplicate.
      expect(new Set(keys.map(({ addr }) => addr))).toEqual(
        new Set([addressAt(seed, SMART_ACCOUNT_SIGNER_KEY_DERIVATION_OFFSET)])
      )
      expect(keys.every(({ dedicatedToOneSA }) => dedicatedToOneSA === true)).toBe(true)
    })

    test('lists the controlling key once, right after its smart account, outside the basic slots', async () => {
      const seed = Wallet.createRandom().mnemonic!.phrase
      accountPicker.setInitParams(createFlowParams(seed))
      await accountPicker.init()
      await accountPicker.selectNextAccount()

      const keyAddr = addressAt(seed, SMART_ACCOUNT_SIGNER_KEY_DERIVATION_OFFSET)
      const page = accountPicker.accountsOnPage
      const keyPositions = page
        .map((a, position) => (a.account.addr === keyAddr ? position : -1))
        .filter((position) => position !== -1)

      expect(keyPositions).toHaveLength(1)
      const keyOnPage = page[keyPositions[0]]
      expect(keyOnPage.index).toBe(SMART_ACCOUNT_SIGNER_KEY_DERIVATION_OFFSET)
      expect(keyOnPage.slot).toBe(1)
      const accountBefore = page[keyPositions[0] - 1]
      expect(isSmartAccount(accountBefore.account)).toBe(true)
      expect(accountBefore.slot).toBe(1)

      const basicSlots = page.filter(
        (a) => !isSmartAccount(a.account) && a.index < SMART_ACCOUNT_SIGNER_KEY_DERIVATION_OFFSET
      )
      expect(basicSlots.length).toBeGreaterThan(0)
      expect(basicSlots.map((a) => a.account.addr)).not.toContain(keyAddr)
    })

    test('keeps the smart account selected, still controlled by its key, when the key is deselected', async () => {
      const seed = Wallet.createRandom().mnemonic!.phrase
      accountPicker.setInitParams(createFlowParams(seed))
      await accountPicker.init()
      await accountPicker.selectNextAccount()

      const keyAddr = addressAt(seed, SMART_ACCOUNT_SIGNER_KEY_DERIVATION_OFFSET)
      const key = accountPicker.selectedAccounts.find((a) => a.account.addr === keyAddr)
      expect(key).toBeDefined()
      accountPicker.deselectAccount(key!.account)

      expect(accountPicker.selectedAccounts).toHaveLength(1)
      expect(isSmartAccount(accountPicker.selectedAccounts[0].account)).toBe(true)
      expect(accountPicker.selectedAccounts[0].accountKeys).toEqual([
        { addr: keyAddr, index: SMART_ACCOUNT_SIGNER_KEY_DERIVATION_OFFSET, slot: 1 }
      ])
    })

    test('does not select the controlling key again when it is already imported with the same key', async () => {
      const seed = Wallet.createRandom().mnemonic!.phrase
      const keyAddr = addressAt(seed, SMART_ACCOUNT_SIGNER_KEY_DERIVATION_OFFSET)
      const picker = pickerWithImported(
        [getBasicAccount(keyAddr, [])],
        [{ addr: keyAddr, type: 'internal', dedicatedToOneSA: true } as Key]
      )
      picker.setInitParams(createFlowParams(seed))
      await picker.init()
      await picker.selectNextAccount()

      const keyOnPage = picker.accountsOnPage.filter((a) => a.account.addr === keyAddr)
      expect(keyOnPage).toHaveLength(1)
      expect(keyOnPage[0].importStatus).toBe(ImportStatus.ImportedWithTheSameKeys)

      expect(picker.selectedAccountsFromCurrentSession).toHaveLength(1)
      expect(isSmartAccount(picker.selectedAccountsFromCurrentSession[0].account)).toBe(true)
      expect(picker.selectedAccountsFromCurrentSession[0].accountKeys).toEqual([
        { addr: keyAddr, index: SMART_ACCOUNT_SIGNER_KEY_DERIVATION_OFFSET, slot: 1 }
      ])
      // The key stays listed once among the selected accounts, from its earlier import.
      expect(picker.selectedAccounts.filter((a) => a.account.addr === keyAddr)).toHaveLength(1)
    })

    test('selects the smart account of the first slot and its key when only its ordinary basic account is imported', async () => {
      const seed = Wallet.createRandom().mnemonic!.phrase
      const importedBasicAccAddr = addressAt(seed, 0)
      const keyAddr = addressAt(seed, SMART_ACCOUNT_SIGNER_KEY_DERIVATION_OFFSET)
      const picker = pickerWithImported(
        [getBasicAccount(importedBasicAccAddr, [])],
        [{ addr: importedBasicAccAddr, type: 'internal' } as Key]
      )
      picker.setInitParams({ ...createFlowParams(seed), pageSize: 2 })
      await picker.init()
      await picker.selectNextAccount()

      const keyEntry = { addr: keyAddr, index: SMART_ACCOUNT_SIGNER_KEY_DERIVATION_OFFSET, slot: 1 }
      expect(picker.selectedAccountsFromCurrentSession).toHaveLength(2)
      const [smartAcc, key] = picker.selectedAccountsFromCurrentSession
      expect(isSmartAccount(smartAcc.account)).toBe(true)
      expect(smartAcc.accountKeys).toEqual([keyEntry])
      expect(key.account.addr).toBe(keyAddr)
      expect(key.accountKeys).toEqual([keyEntry])
      // The ordinary basic account stays selected from its earlier import; no
      // other basic account of a slot joins it.
      expect(
        picker.selectedAccounts
          .filter((a) => !isSmartAccount(a.account) && a.account.addr !== keyAddr)
          .map((a) => a.account.addr)
      ).toEqual([importedBasicAccAddr])
      expect(picker.page).toBe(1)
      expect(picker.pageSize).toBe(2)
    })

    test('selects the smart account of the next slot and its key when a larger page starts with an imported smart account', async () => {
      const seed = Wallet.createRandom().mnemonic!.phrase
      const importedKeyAddr = addressAt(seed, SMART_ACCOUNT_SIGNER_KEY_DERIVATION_OFFSET)
      const importedSmartAcc = await getSmartAccount(
        [{ addr: importedKeyAddr, hash: dedicatedToOneSAPriv }],
        []
      )
      const picker = pickerWithImported(
        [importedSmartAcc],
        [{ addr: importedKeyAddr, type: 'internal', dedicatedToOneSA: true } as Key]
      )
      picker.setInitParams({ ...createFlowParams(seed), pageSize: 2 })
      await picker.init()
      await picker.selectNextAccount()

      const nextKeyAddr = addressAt(seed, SMART_ACCOUNT_SIGNER_KEY_DERIVATION_OFFSET + 1)
      const nextKeyEntry = {
        addr: nextKeyAddr,
        index: SMART_ACCOUNT_SIGNER_KEY_DERIVATION_OFFSET + 1,
        slot: 2
      }
      const newlySelected = picker.selectedAccounts.filter(
        (a) => a.account.addr !== importedSmartAcc.addr
      )
      expect(newlySelected).toHaveLength(2)
      const [smartAcc, key] = newlySelected
      expect(isSmartAccount(smartAcc.account)).toBe(true)
      expect(smartAcc.accountKeys).toEqual([nextKeyEntry])
      expect(key.account.addr).toBe(nextKeyAddr)
      expect(key.accountKeys).toEqual([nextKeyEntry])
      expect(picker.selectedAccounts.map((a) => a.account.addr)).not.toContain(importedKeyAddr)
      expect(picker.page).toBe(1)
      expect(picker.pageSize).toBe(2)
    })

    test('selects the smart account of the first slot of the current page and its key when the page is not the first', async () => {
      const seed = Wallet.createRandom().mnemonic!.phrase
      accountPicker.setInitParams({ ...createFlowParams(seed), page: 2, pageSize: 2 })
      await accountPicker.init()
      await accountPicker.selectNextAccount()

      const keyAddr = addressAt(seed, SMART_ACCOUNT_SIGNER_KEY_DERIVATION_OFFSET + 2)
      const keyEntry = {
        addr: keyAddr,
        index: SMART_ACCOUNT_SIGNER_KEY_DERIVATION_OFFSET + 2,
        slot: 3
      }
      expect(accountPicker.selectedAccounts).toHaveLength(2)
      const [smartAcc, key] = accountPicker.selectedAccounts
      expect(isSmartAccount(smartAcc.account)).toBe(true)
      expect(smartAcc.accountKeys).toEqual([keyEntry])
      expect(key.account.addr).toBe(keyAddr)
      expect(key.accountKeys).toEqual([keyEntry])
      expect(accountPicker.page).toBe(2)
      expect(accountPicker.pageSize).toBe(2)
    })
  })

  test('selects only the basic account of the next slot and lists the smart account and its key when importing a seed', async () => {
    const seed = Wallet.createRandom().mnemonic!.phrase
    const keyIterator = new KeyIterator(seed)
    accountPicker.setInitParams({
      keyIterator,
      hdPathTemplate: BIP44_STANDARD_DERIVATION_TEMPLATE,
      shouldSearchForLinkedAccounts: false,
      shouldGetAccountsUsedOnNetworks: false,
      shouldAddNextAccountAutomatically: false,
      shouldSelectSmartAccountAutomatically: false
    })
    await accountPicker.init()
    await accountPicker.selectNextAccount()

    const basicAccAddr = new Wallet(
      getPrivateKeyFromSeed(seed, null, 0, BIP44_STANDARD_DERIVATION_TEMPLATE)
    ).address

    expect(accountPicker.selectedAccounts.filter((a) => isSmartAccount(a.account))).toHaveLength(0)
    expect(accountPicker.selectedAccounts.map((a) => a.account.addr)).toEqual([basicAccAddr])

    const smartAccKeyAddrs = Array.from(
      { length: accountPicker.pageSize },
      (_, i) =>
        new Wallet(
          getPrivateKeyFromSeed(
            seed,
            null,
            i + SMART_ACCOUNT_SIGNER_KEY_DERIVATION_OFFSET,
            BIP44_STANDARD_DERIVATION_TEMPLATE
          )
        ).address
    )
    const keysOnPage = accountPicker.accountsOnPage.filter((a) =>
      smartAccKeyAddrs.includes(a.account.addr)
    )
    expect(keysOnPage.map((a) => a.account.addr)).toEqual([smartAccKeyAddrs[0]])
    expect(keysOnPage[0].index).toBe(SMART_ACCOUNT_SIGNER_KEY_DERIVATION_OFFSET)
    expect(
      accountPicker.accountsOnPage.filter((a) => isSmartAccount(a.account) && a.slot === 1)
    ).toHaveLength(1)
  })

  test('selects the key of a smart account when importing a seed', async () => {
    const seed = Wallet.createRandom().mnemonic!.phrase
    accountPicker.setInitParams({
      keyIterator: new KeyIterator(seed),
      hdPathTemplate: BIP44_STANDARD_DERIVATION_TEMPLATE,
      shouldSearchForLinkedAccounts: false,
      shouldGetAccountsUsedOnNetworks: false,
      shouldAddNextAccountAutomatically: false,
      shouldSelectSmartAccountAutomatically: false
    })
    await accountPicker.init()
    await accountPicker.setPage({ page: 1 })

    const keyAddr = new Wallet(
      getPrivateKeyFromSeed(
        seed,
        null,
        SMART_ACCOUNT_SIGNER_KEY_DERIVATION_OFFSET,
        BIP44_STANDARD_DERIVATION_TEMPLATE
      )
    ).address
    accountPicker.selectAccount(getBasicAccount(keyAddr, []))

    expect(accountPicker.selectedAccounts.map((a) => a.account.addr)).toContain(keyAddr)
    expect(accountPicker.emittedErrors).toHaveLength(0)
  })

  describe('on an imported seed', () => {
    const PAGE_SIZE = 5

    const addressAt = (seed: string, index: number) =>
      new Wallet(getPrivateKeyFromSeed(seed, null, index, BIP44_STANDARD_DERIVATION_TEMPLATE))
        .address

    const importParams = (
      keyIterator: KeyIteratorInterface
    ): Parameters<AccountPickerController['setInitParams']>[0] => ({
      keyIterator,
      pageSize: PAGE_SIZE,
      hdPathTemplate: BIP44_STANDARD_DERIVATION_TEMPLATE,
      shouldSearchForLinkedAccounts: false,
      shouldGetAccountsUsedOnNetworks: false,
      shouldAddNextAccountAutomatically: false
    })

    // Answers the identity creation of every smart account it is sent, as created.
    const relayerThatCreatesIdentities = (async (_url: string, init?: { body?: string }) => {
      const { accounts } = JSON.parse(init?.body || '{"accounts":[]}')
      return {
        status: 200,
        text: async () =>
          JSON.stringify({
            success: true,
            body: accounts.map(({ addr }: { addr: string }) => ({
              identity: addr,
              status: { created: true }
            }))
          })
      }
    }) as unknown as typeof fetch

    const isolatedPicker = (
      importedAccounts: Account[],
      keys: Key[],
      relayerFetch: typeof fetch = relayerThatCreatesIdentities
    ) =>
      new AccountPickerController({
        accounts: {
          accounts: importedAccounts,
          onUpdate: () => () => {}
        } as unknown as AccountsController,
        keystore: {
          keys,
          isReadyToStoreKeys: true,
          onUpdate: () => () => {}
        } as unknown as KeystoreController,
        networks: networksCtrl,
        providers: providersCtrl,
        relayerUrl,
        fetch: relayerFetch,
        externalSignerControllers: {},
        onAddAccountsSuccessCallback: () => Promise.resolve()
      })

    const rowsOf = (picker: AccountPickerController) =>
      picker.accountsOnPage.map(({ account, index, slot }) => ({
        addr: account.addr,
        isSmartAccount: isSmartAccount(account),
        index,
        slot
      }))

    test('lists each page with its basic accounts, then the smart account of its first slot, then that account key', async () => {
      const seed = Wallet.createRandom().mnemonic!.phrase
      const picker = isolatedPicker([], [])
      picker.setInitParams(importParams(new KeyIterator(seed)))
      await picker.init()

      const pages = [1, 2]
      // eslint-disable-next-line no-restricted-syntax
      for (const page of pages) {
        // eslint-disable-next-line no-await-in-loop
        await picker.setPage({ page })
        const firstIndex = (page - 1) * PAGE_SIZE
        const firstSlot = firstIndex + 1
        const keyIndex = firstIndex + SMART_ACCOUNT_SIGNER_KEY_DERIVATION_OFFSET
        const keyAddr = addressAt(seed, keyIndex)
        const rows = rowsOf(picker)

        expect(rows).toHaveLength(PAGE_SIZE + 2)
        expect(rows.slice(0, PAGE_SIZE)).toEqual(
          Array.from({ length: PAGE_SIZE }, (_, i) => ({
            addr: addressAt(seed, firstIndex + i),
            isSmartAccount: false,
            index: firstIndex + i,
            slot: firstSlot + i
          }))
        )
        const [smartAccRow, keyRow] = rows.slice(PAGE_SIZE)
        expect(smartAccRow.isSmartAccount).toBe(true)
        expect(smartAccRow.slot).toBe(firstSlot)
        expect(keyRow).toEqual({
          addr: keyAddr,
          isSmartAccount: false,
          index: keyIndex,
          slot: firstSlot
        })

        expect(picker.accountsOnPage[PAGE_SIZE].account.associatedKeys).toEqual([keyAddr])
        expect(picker.accountsOnPage[PAGE_SIZE + 1].account.creation).toBeNull()
        expect(picker.toJSON().shouldListSmartAccountKeys).toBe(true)
      }
    })

    test('selects only the first basic account by default, never the smart account or its key', async () => {
      const seed = Wallet.createRandom().mnemonic!.phrase
      const picker = isolatedPicker([], [])
      picker.setInitParams(importParams(new KeyIterator(seed)))
      await picker.init()
      await picker.selectNextAccount()

      expect(picker.selectedAccounts.map((a) => a.account.addr)).toEqual([addressAt(seed, 0)])
      expect(picker.selectedAccounts[0].accountKeys).toEqual([
        { addr: addressAt(seed, 0), index: 0, slot: 1 }
      ])
      expect(picker.page).toBe(1)
    })

    test('selects the first basic account of the next page, not the listed key, when every basic account of the page is imported', async () => {
      const seed = Wallet.createRandom().mnemonic!.phrase
      const importedAddrs = Array.from({ length: PAGE_SIZE }, (_, i) => addressAt(seed, i))
      const picker = isolatedPicker(
        importedAddrs.map((addr) => getBasicAccount(addr, [])),
        importedAddrs.map((addr) => ({ addr, type: 'internal' } as Key))
      )
      picker.setInitParams(importParams(new KeyIterator(seed)))
      await picker.init()
      await picker.setPage({ page: 1 })
      const keyAddr = addressAt(seed, SMART_ACCOUNT_SIGNER_KEY_DERIVATION_OFFSET)
      const keyRow = picker.accountsOnPage.find((a) => a.account.addr === keyAddr)
      expect(keyRow?.importStatus).toBe(ImportStatus.NotImported)

      await picker.selectNextAccount()

      expect(picker.selectedAccountsFromCurrentSession.map((a) => a.account.addr)).toEqual([
        addressAt(seed, PAGE_SIZE)
      ])
      expect(picker.selectedAccounts.map((a) => a.account.addr)).not.toContain(keyAddr)
      expect(picker.selectedAccounts.some((a) => isSmartAccount(a.account))).toBe(false)
    })

    test('adds the selected smart account with its key in the keystore as dedicated to that account, and the key as an account of its own', async () => {
      const seed = Wallet.createRandom().mnemonic!.phrase
      const picker = isolatedPicker([], [])
      picker.setInitParams(importParams(new KeyIterator(seed)))
      await picker.init()
      await picker.setPage({ page: 1 })

      const keyAddr = addressAt(seed, SMART_ACCOUNT_SIGNER_KEY_DERIVATION_OFFSET)
      const smartAccRow = picker.accountsOnPage.find((a) => isSmartAccount(a.account))!
      const keyRow = picker.accountsOnPage.find((a) => a.account.addr === keyAddr)!
      picker.selectAccount(smartAccRow.account)
      picker.selectAccount(keyRow.account)
      expect(picker.emittedErrors).toHaveLength(0)

      await picker.addAccounts()

      expect(picker.readyToAddAccounts.map((a) => a.addr)).toEqual([
        smartAccRow.account.addr,
        keyAddr
      ])
      const [addedSmartAcc, addedKey] = picker.readyToAddAccounts
      expect(addedSmartAcc.associatedKeys).toEqual([keyAddr])
      expect(addedKey.creation).toBeNull()
      expect(picker.readyToAddKeys.internal.length).toBeGreaterThan(0)
      expect(new Set(picker.readyToAddKeys.internal.map(({ addr }) => addr))).toEqual(
        new Set([keyAddr])
      )
      expect(picker.readyToAddKeys.internal.every(({ dedicatedToOneSA }) => dedicatedToOneSA)).toBe(
        true
      )
      expect(picker.readyToAddKeys.internal[0].privateKey).toBe(
        getPrivateKeyFromSeed(
          seed,
          null,
          SMART_ACCOUNT_SIGNER_KEY_DERIVATION_OFFSET,
          BIP44_STANDARD_DERIVATION_TEMPLATE
        )
      )
    })

    test('adds the default basic account alone, with a key that is not dedicated to a smart account', async () => {
      const seed = Wallet.createRandom().mnemonic!.phrase
      const picker = isolatedPicker([], [])
      picker.setInitParams(importParams(new KeyIterator(seed)))
      await picker.init()
      await picker.selectNextAccount()
      await picker.addAccounts()

      expect(picker.readyToAddAccounts.map((a) => a.addr)).toEqual([addressAt(seed, 0)])
      expect(
        picker.readyToAddKeys.internal.map(({ addr, dedicatedToOneSA }) => ({
          addr,
          dedicatedToOneSA
        }))
      ).toEqual([{ addr: addressAt(seed, 0), dedicatedToOneSA: false }])
    })

    test('lists no smart account and no key on a private key import', async () => {
      const privateKey = Wallet.createRandom().privateKey
      const picker = isolatedPicker([], [])
      picker.setInitParams(importParams(new KeyIterator(privateKey)))
      await picker.init()
      await picker.setPage({ page: 1 })

      expect(rowsOf(picker)).toEqual([
        { addr: new Wallet(privateKey).address, isSmartAccount: false, index: 0, slot: 1 }
      ])
      expect(picker.toJSON().shouldListSmartAccountKeys).toBe(false)
    })

    test('lists the smart account but not its key on a hardware wallet', async () => {
      const seed = Wallet.createRandom().mnemonic!.phrase
      const seedIterator = new KeyIterator(seed)
      const hardwareIterator: KeyIteratorInterface = {
        type: 'ledger',
        subType: 'hw',
        retrieve: (fromToArr, derivation) => seedIterator.retrieve(fromToArr, derivation)
      }
      const picker = isolatedPicker([], [])
      picker.setInitParams(importParams(hardwareIterator))
      await picker.init()
      await picker.setPage({ page: 1 })

      const rows = rowsOf(picker)
      expect(rows.filter((r) => r.isSmartAccount)).toHaveLength(1)
      expect(rows.some((r) => r.index >= SMART_ACCOUNT_SIGNER_KEY_DERIVATION_OFFSET)).toBe(false)
      expect(rows.map((r) => r.addr)).not.toContain(
        addressAt(seed, SMART_ACCOUNT_SIGNER_KEY_DERIVATION_OFFSET)
      )
      expect(picker.toJSON().shouldListSmartAccountKeys).toBe(false)
    })

    test('lists the same rows as the create door does for the same seed', async () => {
      const seed = Wallet.createRandom().mnemonic!.phrase
      const importPicker = isolatedPicker([], [])
      importPicker.setInitParams(importParams(new KeyIterator(seed)))
      await importPicker.init()
      await importPicker.setPage({ page: 1 })

      const createPicker = isolatedPicker([], [])
      createPicker.setInitParams({
        ...importParams(new KeyIterator(seed)),
        shouldSelectSmartAccountAutomatically: true
      })
      await createPicker.init()
      await createPicker.setPage({ page: 1 })

      expect(rowsOf(importPicker)).toEqual(rowsOf(createPicker))
    })

    test('lists the linked smart account of the first slot and the next one, each with its key, and selects only the first basic account', async () => {
      const seed = Wallet.createRandom().mnemonic!.phrase
      const unlinkedPicker = isolatedPicker([], [])
      unlinkedPicker.setInitParams(importParams(new KeyIterator(seed)))
      await unlinkedPicker.init()
      await unlinkedPicker.setPage({ page: 1 })
      const firstSmartAcc = unlinkedPicker.accountsOnPage.find(
        (a) => isSmartAccount(a.account) && a.slot === 1
      )!.account
      const firstKeyAddr = addressAt(seed, SMART_ACCOUNT_SIGNER_KEY_DERIVATION_OFFSET)
      const secondKeyAddr = addressAt(seed, SMART_ACCOUNT_SIGNER_KEY_DERIVATION_OFFSET + 1)

      // Answers the linked search with the smart account of the first slot.
      const relayerThatLinksTheFirstSlot = (async (url: string, init?: { body?: string }) => {
        if (!url.includes('/linked/accounts')) return relayerThatCreatesIdentities(url, init)
        return {
          status: 200,
          text: async () =>
            JSON.stringify({
              success: true,
              data: {
                accounts: {
                  [firstSmartAcc.addr]: {
                    ...firstSmartAcc.creation,
                    associatedKeys: { [firstKeyAddr]: dedicatedToOneSAPriv },
                    initialPrivilegesAddrs: [firstKeyAddr]
                  }
                }
              }
            })
        }
      }) as unknown as typeof fetch

      const picker = isolatedPicker([], [], relayerThatLinksTheFirstSlot)
      picker.setInitParams({
        ...importParams(new KeyIterator(seed)),
        shouldSearchForLinkedAccounts: true
      })
      await picker.init()
      await picker.setPage({ page: 1 })

      expect(picker.emittedErrors).toHaveLength(0)
      expect(rowsOf(picker).slice(PAGE_SIZE)).toEqual([
        { addr: firstSmartAcc.addr, isSmartAccount: true, index: 0, slot: 1 },
        expect.objectContaining({ isSmartAccount: true, index: 1, slot: 2 }),
        {
          addr: firstKeyAddr,
          isSmartAccount: false,
          index: SMART_ACCOUNT_SIGNER_KEY_DERIVATION_OFFSET,
          slot: 1
        },
        {
          addr: secondKeyAddr,
          isSmartAccount: false,
          index: SMART_ACCOUNT_SIGNER_KEY_DERIVATION_OFFSET + 1,
          slot: 2
        }
      ])

      await picker.selectNextAccount()

      expect(picker.selectedAccounts.map((a) => a.account.addr)).toEqual([addressAt(seed, 0)])
    })

    test('refuses to select the key of a smart account on a hardware wallet', async () => {
      const seed = Wallet.createRandom().mnemonic!.phrase
      const seedIterator = new KeyIterator(seed)
      const hardwareIterator: KeyIteratorInterface = {
        type: 'ledger',
        subType: 'hw',
        retrieve: (fromToArr, derivation) => seedIterator.retrieve(fromToArr, derivation)
      }
      const picker = isolatedPicker([], [])
      picker.setInitParams(importParams(hardwareIterator))
      await picker.init()
      await picker.setPage({ page: 1 })

      const keyAddr = addressAt(seed, SMART_ACCOUNT_SIGNER_KEY_DERIVATION_OFFSET)
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {})
      try {
        picker.selectAccount(getBasicAccount(keyAddr, []))
      } finally {
        consoleError.mockRestore()
      }

      expect(picker.selectedAccounts.map((a) => a.account.addr)).not.toContain(keyAddr)
      expect(
        picker.emittedErrors.some((e) =>
          e.error.message.includes(`Trying to select ${keyAddr} account`)
        )
      ).toBe(true)
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
        (x) => !isSmartAccount(x.account) && !isDerivedForSmartAccountKeyOnly(x.index)
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
        (x) => !isSmartAccount(x.account) && !isDerivedForSmartAccountKeyOnly(x.index)
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

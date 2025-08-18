import fetch from 'node-fetch'

import { expect, jest } from '@jest/globals'

import { relayerUrl } from '../../../test/config'
import { produceMemoryStore } from '../../../test/helpers'
import { mockWindowManager } from '../../../test/helpers/window'
import { DEFAULT_ACCOUNT_LABEL } from '../../consts/account'
import { networks } from '../../consts/networks'
import { Account } from '../../interfaces/account'
import { Storage } from '../../interfaces/storage'
import { getRpcProvider } from '../../services/provider'
import { AccountsController } from '../accounts/accounts'
import { KeystoreController } from '../keystore/keystore'
import { NetworksController } from '../networks/networks'
import { ProvidersController } from '../providers/providers'
import { SelectedAccountController } from '../selectedAccount/selectedAccount'
import { StorageController } from '../storage/storage'
import { AddressBookController } from './addressBook'

const storage: Storage = produceMemoryStore()
const storageCtrl = new StorageController(storage)

let errors = 0

// Mock the emitError method to capture the emitted error
const mockEmitError = jest.fn(() => errors++)

const MOCK_ACCOUNTS: Account[] = [
  {
    addr: '0x598cD170E9b90e9c7E57e18B47D589ceC119744c',
    associatedKeys: [],
    initialPrivileges: [],
    creation: null,
    preferences: {
      label: DEFAULT_ACCOUNT_LABEL,
      pfp: '0x598cD170E9b90e9c7E57e18B47D589ceC119744c'
    }
  },
  {
    addr: '0x66fE93c51726e6FD51668B0B0434ffcedD604d08',
    associatedKeys: [],
    initialPrivileges: [],
    creation: null,
    preferences: {
      label: 'Account 1',
      pfp: '0x66fE93c51726e6FD51668B0B0434ffcedD604d08'
    }
  },
  {
    addr: '0x31800a810A2d9C3315dc714e1Eb988bd6A641eF0',
    associatedKeys: [],
    initialPrivileges: [],
    creation: null,
    preferences: {
      label: 'Account 2',
      pfp: '0x31800a810A2d9C3315dc714e1Eb988bd6A641eF0'
    }
  }
]

storage.set('accounts', MOCK_ACCOUNTS)

const providers = Object.fromEntries(
  networks.map((network) => [network.chainId, getRpcProvider(network.rpcUrls, network.chainId)])
)

describe('AddressBookController', () => {
  let providersCtrl: ProvidersController
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
  const accountsCtrl = new AccountsController(
    storageCtrl,
    providersCtrl,
    networksCtrl,
    new KeystoreController('default', storageCtrl, {}, mockWindowManager().windowManager),
    () => {},
    () => {},
    () => {}
  )
  const selectedAccountCtrl = new SelectedAccountController({
    storage: storageCtrl,
    accounts: accountsCtrl,
    keystore: new KeystoreController('default', storageCtrl, {}, mockWindowManager().windowManager)
  })
  const addressBookController = new AddressBookController(
    storageCtrl,
    accountsCtrl,
    selectedAccountCtrl
  )

  const getContactFromName = (name: string) => {
    return addressBookController.contacts.find((contact) => contact.name === name)
  }

  // 'any' is on purpose, to override 'emitError' prop (which is protected)
  ;(addressBookController as any).emitError = mockEmitError

  it('wallet accounts are in contacts', async () => {
    await selectedAccountCtrl.initialLoadPromise
    await selectedAccountCtrl.setAccount(MOCK_ACCOUNTS[0])
    expect(getContactFromName('Account 1')?.isWalletAccount).toBeTruthy()
    expect(getContactFromName('Account 1')?.address).toEqual(
      '0x66fE93c51726e6FD51668B0B0434ffcedD604d08'
    )
    expect(getContactFromName('Account 2')?.isWalletAccount).toBeTruthy()
    expect(getContactFromName('Account 2')?.address).toEqual(
      '0x31800a810A2d9C3315dc714e1Eb988bd6A641eF0'
    )
  })
  it('add contact', async () => {
    await addressBookController.addContact('vitaly', '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')

    expect(getContactFromName('vitaly')?.address).toEqual(
      '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
    )
  })
  it('rename contact', async () => {
    await addressBookController.renameManuallyAddedContact(
      '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
      'vitalik'
    )

    expect(getContactFromName('vitalik')?.address).toEqual(
      '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
    )
  })
  it('remove contact', async () => {
    await addressBookController.removeManuallyAddedContact(
      '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
    )

    expect(getContactFromName('vitalik')).toBeUndefined()
  })
  it('contact address is checksummed when added', async () => {
    await addressBookController.addContact(
      'Jeff',
      '0x64c5f3c58E024170166F85aFE6e291088a2c2968'.toLowerCase()
    )

    expect(getContactFromName('Jeff')?.address).toEqual(
      '0x64c5f3c58E024170166F85aFE6e291088a2c2968'
    )
  })
  it('error when removing non-existing contact', async () => {
    await addressBookController.removeManuallyAddedContact(
      '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
    )

    expect(mockEmitError).toHaveBeenCalledTimes(errors)
  })
  it('error when adding contact with already existing address', async () => {
    await addressBookController.addContact('tony', '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')
    await addressBookController.addContact('tony', '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')

    expect(mockEmitError).toHaveBeenCalledTimes(errors)
  })
  it('error when adding contact with already existing address but lowercased', async () => {
    await addressBookController.addContact('tony', '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')
    await addressBookController.addContact('tony', '0xd8da6bf26964af9d7eed9e03e53415d37aa96045')

    expect(mockEmitError).toHaveBeenCalledTimes(errors)
  })
  it('error when renaming wallet account contact', async () => {
    await addressBookController.renameManuallyAddedContact(
      '0x66fE93c51726e6FD51668B0B0434ffcedD604d08',
      'Account 2'
    )

    expect(mockEmitError).toHaveBeenCalledTimes(errors)
  })
  it('error when removing wallet account contact', async () => {
    await addressBookController.removeManuallyAddedContact(
      '0x66fE93c51726e6FD51668B0B0434ffcedD604d08'
    )

    expect(mockEmitError).toHaveBeenCalledTimes(errors)
  })
})

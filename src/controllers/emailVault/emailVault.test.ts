/* eslint-disable class-methods-use-this */
import fetch from 'node-fetch'

import { expect } from '@jest/globals'

import { relayerUrl } from '../../../test/config'
import { produceMemoryStore } from '../../../test/helpers'
import { mockWindowManager } from '../../../test/helpers/window'
import { EIP7702Auth } from '../../consts/7702'
import { Hex } from '../../interfaces/hex'
import { Key, KeystoreSignerInterface, TxnRequest } from '../../interfaces/keystore'
import { EIP7702Signature } from '../../interfaces/signatures'
import { Storage } from '../../interfaces/storage'
import { EmailVault } from '../../libs/emailVault/emailVault'
import { requestMagicLink } from '../../libs/magicLink/magicLink'
import { KeystoreController } from '../keystore/keystore'
import { StorageController } from '../storage/storage'
import { EmailVaultController, EmailVaultState } from './emailVault'

class InternalSigner implements KeystoreSignerInterface {
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

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  sign7702(hex: string): EIP7702Signature {
    throw new Error('not supported')
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  signTransactionTypeFour(txnRequest: TxnRequest, eip7702Auth: EIP7702Auth): Hex {
    throw new Error('not supported')
  }
}

const keystoreSigners = { internal: InternalSigner }

const getRandomEmail = () => {
  return `unufri+${Math.random().toString().slice(2)}@ambire.com`
}
let storage: Storage
let storageCtrl: StorageController
let keystore: KeystoreController
let email: string
const testingOptions = { autoConfirmMagicLink: true }

const windowManager = mockWindowManager().windowManager

describe('happy cases', () => {
  beforeEach(() => {
    email = getRandomEmail()
    storage = produceMemoryStore()
    storageCtrl = new StorageController(storage)
    keystore = new KeystoreController('default', storageCtrl, keystoreSigners, windowManager)
  })
  test.skip('login first time', async () => {
    const ev = new EmailVaultController(storageCtrl, fetch, relayerUrl, keystore, testingOptions)
    await ev.getEmailVaultInfo(email)

    expect(ev.emailVaultStates.email[email]).toMatchObject({
      email,
      recoveryKey: expect.stringContaining('0x'),
      availableSecrets: expect.anything(),
      availableAccounts: {},
      operations: []
    })
  })
  test('login into existing', async () => {
    const evLib = new EmailVault(fetch, relayerUrl)
    const ev = new EmailVaultController(storageCtrl, fetch, relayerUrl, keystore, testingOptions)
    const keys = await requestMagicLink(email, relayerUrl, fetch)
    await fetch(`${relayerUrl}/email-vault/confirm-key/${email}/${keys.key}/${keys.secret}`)
    // createing
    await evLib.getEmailVaultInfo(email, keys.key)
    // not logged in
    expect(ev.emailVaultStates.email[email]).toBeUndefined()
    await ev.getEmailVaultInfo(email)
    // after successfuly logged in
    expect(ev.emailVaultStates.email[email]).toMatchObject({
      email,
      recoveryKey: expect.stringContaining('0x'),
      availableSecrets: expect.anything(),
      availableAccounts: {},
      operations: []
    })
  })
  test('upload keystore secret', async () => {
    const ev = new EmailVaultController(storageCtrl, fetch, relayerUrl, keystore, testingOptions)
    await ev.getEmailVaultInfo(email)
    expect(Object.keys(ev.emailVaultStates.email[email].availableSecrets).length).toBe(1)
    await ev.uploadKeyStoreSecret(email)
    const newSecrets = ev.emailVaultStates.email[email].availableSecrets
    expect(Object.keys(newSecrets).length).toBe(2)
    const key = Object.keys(newSecrets).find((k) => newSecrets[k]?.type === 'keyStore')
    expect(key).toBeTruthy()
    expect(newSecrets[key!]).toMatchObject({ key, type: 'keyStore' })
  })
  test('recoverKeyStore', async () => {
    const ev = new EmailVaultController(storageCtrl, fetch, relayerUrl, keystore, testingOptions)

    await ev.getEmailVaultInfo(email)
    expect(Object.keys(ev.emailVaultStates.email[email].availableSecrets).length).toBe(1)
    await ev.uploadKeyStoreSecret(email)
    expect(Object.keys(ev.emailVaultStates.email[email].availableSecrets).length).toBe(2)

    expect(keystore.isUnlocked).toBeFalsy()
    await ev.recoverKeyStore(email, 'new_password')
    await keystore.unlockWithSecret('password', 'new_password')

    expect(keystore.isUnlocked).toBeTruthy()
  })

  // @NOTE this test is supposed to fail because we have a new route for pulling the fulfilled operations
  // once the staging-relayer is updated we can continue with this.
  // (updating the staging would break the old version of the controller, we have to migrate both common and relayer at the same time)
  test('full keystore sync', async () => {
    const storage2 = produceMemoryStore()
    const storageCtrl2 = new StorageController(storage2)
    const keystore2 = new KeystoreController(
      'default',
      storageCtrl2,
      keystoreSigners,
      windowManager
    )

    const keys = [
      {
        address: '0xDba1BA86e823FB82ee6181af6c32811000Ea7139',
        privateKey: '37f5be94ab09ab022f088f02049e3accfe5e451b9a16f0f51da9586244cd5e76'
      },
      {
        address: '0x4076170D9fc785a31452cC5b544B43b3bf5f97E2',
        privateKey: '75331017632eba0405f640655109a5233ac11714577ce95badab22fb63ce6d83'
      }
    ]
    // ev 1
    const ev = new EmailVaultController(storageCtrl2, fetch, relayerUrl, keystore, testingOptions)
    await ev.getEmailVaultInfo(email)
    // used to add keystore uid
    await keystore.addSecret('smth', 'secret', '', false)
    await keystore.unlockWithSecret('smth', 'secret')
    await keystore.addKeys([
      {
        addr: keys[0].address,
        type: 'internal',
        label: 'Key 1',
        privateKey: keys[0].privateKey,
        dedicatedToOneSA: false,
        meta: {
          createdAt: new Date().getTime()
        }
      }
    ])
    await keystore.addKeys([
      {
        addr: keys[1].address,
        type: 'internal',
        label: 'Key 2',
        privateKey: keys[1].privateKey,
        dedicatedToOneSA: false,
        meta: {
          createdAt: new Date().getTime()
        }
      }
    ])

    // ev 2
    const ev2 = new EmailVaultController(storageCtrl2, fetch, relayerUrl, keystore2, testingOptions)
    await ev2.getEmailVaultInfo(email)
    await keystore2.addSecret('smth2', 'secret2', '', false)
    await keystore2.unlockWithSecret('smth2', 'secret2')

    // make two sync requests
    await ev2.requestKeysSync(
      email,
      keys.map((k) => k.address)
    )
    expect(ev2.emailVaultStates.email[email].operations.length).toBe(2)

    await ev.fulfillSyncRequests(email, 'password')
    expect(ev.emailVaultStates.email[email].operations.length).toBe(2)
    await ev2.finalizeSyncKeys(
      email,
      keys.map((k) => k.address),
      'password'
    )
    expect(keystore2.keys.length).toBe(2)
  })

  test('cancel login attempt', (done) => {
    const ev = new EmailVaultController(storageCtrl, fetch, relayerUrl, keystore)

    setTimeout(() => {
      expect(ev.currentState).toBe(EmailVaultState.WaitingEmailConfirmation)
      ev.cancelEmailConfirmation()
      expect(ev.currentState).toBe(EmailVaultState.Ready)
      expect(Object.keys(ev.emailVaultStates.email).length).toBe(0)
      done()
    }, 4000)

    ev.handleMagicLinkKey(email, () => console.log('ready'))
  })
})

/* eslint-disable class-methods-use-this */

import { hexlify, randomBytes } from 'ethers'
import fetch from 'node-fetch'

import { describe, expect, jest, test } from '@jest/globals'

import { relayerUrl } from '../../../test/config'
import { produceMemoryStore, waitForAccountsCtrlFirstLoad } from '../../../test/helpers'
import { mockWindowManager } from '../../../test/helpers/window'
import { EIP7702Auth } from '../../consts/7702'
import { DEFAULT_ACCOUNT_LABEL } from '../../consts/account'
import { networks } from '../../consts/networks'
import { Account } from '../../interfaces/account'
import { Hex } from '../../interfaces/hex'
import { Key, TxnRequest } from '../../interfaces/keystore'
import { EIP7702Signature } from '../../interfaces/signatures'
import { Message } from '../../interfaces/userRequest'
import { getRpcProvider } from '../../services/provider'
import { AccountsController } from '../accounts/accounts'
import { InviteController } from '../invite/invite'
import { KeystoreController } from '../keystore/keystore'
import { NetworksController } from '../networks/networks'
import { ProvidersController } from '../providers/providers'
import { StorageController } from '../storage/storage'
import { SignMessageController } from './signMessage'

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

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  sign7702(hex: string): EIP7702Signature {
    return {
      yParity: '0x00',
      r: hexlify(randomBytes(32)) as Hex,
      s: hexlify(randomBytes(32)) as Hex
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  signTransactionTypeFour(txnRequest: TxnRequest, eip7702Auth: EIP7702Auth): Hex {
    return '0x'
  }
}

const providers = Object.fromEntries(
  networks.map((network) => [network.chainId, getRpcProvider(network)])
)

const account: Account = {
  addr: '0x9188fdd757Df66B4F693D624Ed6A13a15Cf717D7',
  associatedKeys: ['0x9188fdd757Df66B4F693D624Ed6A13a15Cf717D7'],
  initialPrivileges: [
    [
      '0x9188fdd757Df66B4F693D624Ed6A13a15Cf717D7',
      '0x0000000000000000000000000000000000000000000000000000000000000001'
    ]
  ],
  creation: null,
  preferences: {
    label: DEFAULT_ACCOUNT_LABEL,
    pfp: '0x9188fdd757Df66B4F693D624Ed6A13a15Cf717D7'
  }
}

const windowManager = mockWindowManager().windowManager

const messageToSign: Message = {
  fromActionId: 1,
  content: { kind: 'message', message: '0x74657374' },
  accountAddr: account.addr,
  signature: null,
  chainId: 1n
}

describe('SignMessageController', () => {
  let signMessageController: SignMessageController
  let keystoreCtrl: KeystoreController
  let accountsCtrl: AccountsController
  let networksCtrl: NetworksController
  let providersCtrl: ProvidersController
  let inviteCtrl: InviteController

  beforeAll(async () => {
    const storage = produceMemoryStore()
    const storageCtrl = new StorageController(storage)
    await storageCtrl.set('accounts', [account])
    await storageCtrl.set('selectedAccount', account.addr)

    keystoreCtrl = new KeystoreController(
      'default',
      storageCtrl,
      { internal: InternalSigner },
      windowManager
    )
    networksCtrl = new NetworksController({
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

    accountsCtrl = new AccountsController(
      storageCtrl,
      providersCtrl,
      networksCtrl,
      keystoreCtrl,
      () => {},
      () => {},
      () => {}
    )
    inviteCtrl = new InviteController({ relayerUrl, fetch, storage: storageCtrl })

    await waitForAccountsCtrlFirstLoad(accountsCtrl)
  })

  beforeEach(async () => {
    signMessageController = new SignMessageController(
      keystoreCtrl,
      providersCtrl,
      networksCtrl,
      accountsCtrl,
      {},
      inviteCtrl
    )
  })

  test('should initialize with a valid message and then - reset', async () => {
    await signMessageController.init({ messageToSign })
    expect(signMessageController.isInitialized).toBeTruthy()
    expect(signMessageController.messageToSign).toEqual(messageToSign)

    signMessageController.reset()
    expect(signMessageController.isInitialized).toBeFalsy()
    expect(signMessageController.messageToSign).toBeNull()
    expect(signMessageController.signedMessage).toBeNull()
    expect(signMessageController.signingKeyAddr).toBeNull()
    expect(signMessageController.signingKeyType).toBeNull()
  })

  test('should not initialize with an invalid message kind', async () => {
    const invalidMessageToSign: Message = {
      id: 1,
      content: {
        // @ts-ignore that's on purpose, for the test
        kind: 'unsupportedKind',
        message: '0x74657374'
      }
    }

    // Mock the emitError method to capture the emitted error
    const mockEmitError = jest.fn()
    // 'any' is on purpose, to override 'emitError' prop (which is protected)
    ;(signMessageController as any).emitError = mockEmitError

    await signMessageController.init({ messageToSign: invalidMessageToSign })

    expect(signMessageController.isInitialized).toBeFalsy()
    expect(mockEmitError).toHaveBeenCalled()
  })

  test('should set signing key address', async () => {
    const signingKeyAddr = account.addr

    await signMessageController.init({ messageToSign })
    signMessageController.setSigningKey(signingKeyAddr, 'internal')

    expect(signMessageController.signingKeyAddr).toBe(signingKeyAddr)
    expect(signMessageController.signingKeyType).toBe('internal')
  })

  // TODO: Would be better to test the signing via the Main controller -> handleSignMessage instead
  test('should sign a message', async () => {
    const signingKeyAddr = account.addr
    const dummySignature =
      '0x5b2dce98c7179051d21407be04bcd088243cd388ed51c4c64ccae115ca8787d85cff933dcde45220c3adfcc40f7958305e195dbd4c54580dfbf61e43438cbe9a1c'

    const mockSigner = {
      // @ts-ignore for mocking purposes only
      signMessage: jest.fn().mockResolvedValue(dummySignature),
      key: { addr: signingKeyAddr, type: 'internal', dedicatedToOneSA: true, meta: {} }
    }

    // @ts-ignore spy on the getSigner method and mock its implementation
    const getSignerSpy = jest.spyOn(keystoreCtrl, 'getSigner').mockResolvedValue(mockSigner)

    await signMessageController.init({ messageToSign })
    signMessageController.setSigningKey(signingKeyAddr, 'internal')

    await accountsCtrl.updateAccountState(messageToSign.accountAddr, 'latest', [
      messageToSign.chainId
    ])

    await signMessageController.sign()

    signMessageController.onUpdate(() => {
      console.log(signMessageController.statuses)
    })
    console.log(signMessageController.signedMessage)

    // expect(mockSigner.signMessage).toHaveBeenCalledWith(messageToSign.content.message)
    expect(signMessageController.signedMessage?.signature).toBe(dummySignature)

    getSignerSpy.mockRestore() // cleans up the spy
  })
  test('removeAccountData', async () => {
    await signMessageController.init({ messageToSign })
    expect(signMessageController.isInitialized).toBeTruthy()

    signMessageController.removeAccountData(account.addr)
    expect(signMessageController.isInitialized).toBeFalsy()
  })
})

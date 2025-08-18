import fetch from 'node-fetch'

import { describe, expect } from '@jest/globals'

import { relayerUrl, velcroUrl } from '../../../test/config'
import { produceMemoryStore } from '../../../test/helpers'
import { mockWindowManager } from '../../../test/helpers/window'
import { DEFAULT_ACCOUNT_LABEL } from '../../consts/account'
import { networks } from '../../consts/networks'
import { RPCProviders } from '../../interfaces/provider'
import { SubmittedAccountOp } from '../../libs/accountOp/submittedAccountOp'
import { AccountOpStatus } from '../../libs/accountOp/types'
import { relayerCall } from '../../libs/relayerCall/relayerCall'
import { getRpcProvider } from '../../services/provider'
import { AccountsController } from '../accounts/accounts'
import { BannerController } from '../banner/banner'
import { KeystoreController } from '../keystore/keystore'
import { NetworksController } from '../networks/networks'
import { PortfolioController } from '../portfolio/portfolio'
import { ProvidersController } from '../providers/providers'
import { SelectedAccountController } from '../selectedAccount/selectedAccount'
import { StorageController } from '../storage/storage'
import { ActivityController } from './activity'
import { SignedMessage } from './types'

const INIT_PARAMS = {
  account: '0xB674F3fd5F43464dB0448a57529eAF37F04cceA5',
  chainId: 1n
}

const ACCOUNTS = [
  {
    addr: '0xa07D75aacEFd11b425AF7181958F0F85c312f143',
    associatedKeys: ['0xd6e371526cdaeE04cd8AF225D42e37Bc14688D9E'],
    initialPrivileges: [],
    creation: {
      factoryAddr: '0xBf07a0Df119Ca234634588fbDb5625594E2a5BCA',
      bytecode:
        '0x7f28d4ea8f825adb036e9b306b2269570e63d2aa5bd10751437d98ed83551ba1cd7fa57498058891e98f45f8abb85dafbcd30f3d8b3ab586dfae2e0228bbb1de7018553d602d80604d3d3981f3363d3d373d3d3d363d732a2b85eb1054d6f0c6c2e37da05ed3e5fea684ef5af43d82803e903d91602b57fd5bf3',
      salt: '0x0000000000000000000000000000000000000000000000000000000000000001'
    },
    preferences: {
      label: DEFAULT_ACCOUNT_LABEL,
      pfp: '0xa07D75aacEFd11b425AF7181958F0F85c312f143'
    }
  },
  {
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
]

const SUBMITTED_ACCOUNT_OP = {
  accountAddr: '0xB674F3fd5F43464dB0448a57529eAF37F04cceA5',
  signingKeyAddr: '0x5Be214147EA1AE3653f289E17fE7Dc17A73AD175',
  gasLimit: null,
  gasFeePayment: {
    isGasTank: false,
    paidBy: '0xB674F3fd5F43464dB0448a57529eAF37F04cceA5',
    inToken: '0x0000000000000000000000000000000000000000',
    amount: 1n,
    simulatedGasLimit: 1n,
    gasPrice: 1n
  },
  chainId: 1n,
  nonce: 225n,
  signature: '0x0000000000000000000000005be214147ea1ae3653f289e17fe7dc17a73ad17503',
  calls: [
    {
      to: '0x18Ce9CF7156584CDffad05003410C3633EFD1ad0',
      value: BigInt(0),
      data: '0x23b872dd000000000000000000000000b674f3fd5f43464db0448a57529eaf37f04ccea500000000000000000000000077777777789a8bbee6c64381e5e89e501fb0e4c80000000000000000000000000000000000000000000000000000000000000089'
    }
  ],
  txnId: '0x891e12877c24a8292fd73fd741897682f38a7bcd497374a6b68e8add89e1c0fb',
  status: 'broadcasted-but-not-confirmed',
  identifiedBy: {
    type: 'Transaction',
    identifier: '0x891e12877c24a8292fd73fd741897682f38a7bcd497374a6b68e8add89e1c0fb'
  }
} as SubmittedAccountOp

const SIGNED_MESSAGE: SignedMessage = {
  fromActionId: 1,
  accountAddr: '0xB674F3fd5F43464dB0448a57529eAF37F04cceA5',
  dapp: {
    icon: '',
    name: 'dapp-name'
  },
  timestamp: 1701345600000,
  content: {
    kind: 'message',
    message: '0x123456'
  },
  signature: '0x0000000000000000000000005be214147ea1ae3653f289e17fe7dc17a73ad17503',
  chainId: 1n
}

const providers: RPCProviders = {}

networks.forEach((network) => {
  providers[network.chainId.toString()] = getRpcProvider(network.rpcUrls, network.chainId)
  providers[network.chainId.toString()].isWorking = true
})

const callRelayer = relayerCall.bind({ url: '', fetch })

let providersCtrl: ProvidersController
let portfolioCtrl: PortfolioController
let accountsCtrl: AccountsController
let selectedAccountCtrl: SelectedAccountController
let networksCtrl: NetworksController

const storage = produceMemoryStore()
const storageCtrl = new StorageController(storage)

const prepareTest = async () => {
  const controller = new ActivityController(
    storageCtrl,
    fetch,
    callRelayer,
    accountsCtrl,
    selectedAccountCtrl,
    providersCtrl,
    networksCtrl,
    portfolioCtrl,
    () => Promise.resolve()
  )

  const sessionId = Date.now().toString()

  await controller.filterAccountsOps(sessionId, INIT_PARAMS)

  return {
    controller,
    storage,
    sessionId
  }
}

const prepareSignedMessagesTest = async () => {
  const controller = new ActivityController(
    storageCtrl,
    fetch,
    callRelayer,
    accountsCtrl,
    selectedAccountCtrl,
    providersCtrl,
    networksCtrl,
    portfolioCtrl,
    () => Promise.resolve()
  )

  const sessionId = Date.now().toString()

  await controller.filterSignedMessages(sessionId, INIT_PARAMS)

  return { controller, sessionId }
}

describe('Activity Controller ', () => {
  // Setup other controllers only once!
  // Otherwise account states will be fetched in every tests and the RPC may timeout or throw
  // errors
  beforeAll(async () => {
    await storageCtrl.set('accounts', ACCOUNTS)

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
    const windowManager = mockWindowManager().windowManager
    const keystore = new KeystoreController('default', storageCtrl, {}, windowManager)
    portfolioCtrl = new PortfolioController(
      storageCtrl,
      fetch,
      providersCtrl,
      networksCtrl,
      accountsCtrl,
      keystore,
      relayerUrl,
      velcroUrl,
      new BannerController(storageCtrl)
    )
    providersCtrl.providers = providers
    accountsCtrl = new AccountsController(
      storageCtrl,
      providersCtrl,
      networksCtrl,
      keystore,
      () => {},
      () => {},
      () => {}
    )
    selectedAccountCtrl = new SelectedAccountController({
      storage: storageCtrl,
      accounts: accountsCtrl,
      keystore
    })

    await selectedAccountCtrl.initialLoadPromise
    await selectedAccountCtrl.setAccount(ACCOUNTS[1])
  })

  // Clear activity storage after each test
  // but keep accounts, providers etc.
  afterEach(async () => {
    await storageCtrl.remove('accountsOps')
    await storageCtrl.remove('signedMessages')
  })

  describe('AccountsOps', () => {
    test('Retrieved from Controller and persisted in Storage', async () => {
      const { controller, sessionId } = await prepareTest()

      await controller.addAccountOp(SUBMITTED_ACCOUNT_OP)
      const controllerAccountsOps = controller.accountsOps
      const storageAccountsOps = await storage.get('accountsOps', {})

      expect(controllerAccountsOps[sessionId].result).toEqual({
        items: [{ ...SUBMITTED_ACCOUNT_OP, status: 'broadcasted-but-not-confirmed' }], // everytime we add a new AccountOp, it gets broadcasted-but-not-confirmed status
        itemsTotal: 1,
        currentPage: 0,
        maxPages: 1
      })
      expect(storageAccountsOps['0xB674F3fd5F43464dB0448a57529eAF37F04cceA5']['1']).toEqual([
        { ...SUBMITTED_ACCOUNT_OP, status: 'broadcasted-but-not-confirmed' }
      ])
    })

    test('Pagination and filtration handled correctly', async () => {
      const { controller, sessionId } = await prepareTest()

      const accountsOps = [
        {
          accountAddr: '0xB674F3fd5F43464dB0448a57529eAF37F04cceA5',
          signingKeyAddr: '0x5Be214147EA1AE3653f289E17fE7Dc17A73AD175',
          gasLimit: null,
          gasFeePayment: {
            isGasTank: false,
            paidBy: '0xB674F3fd5F43464dB0448a57529eAF37F04cceA5',
            inToken: '0x0000000000000000000000000000000000000000',
            amount: 1n,
            simulatedGasLimit: 1n,
            gasPrice: 1n
          },
          chainId: 1n,
          nonce: 225n,
          signature: '0x0000000000000000000000005be214147ea1ae3653f289e17fe7dc17a73ad17503',
          calls: [
            {
              to: '0x18Ce9CF7156584CDffad05003410C3633EFD1ad0',
              value: BigInt(0),
              data: '0x23b872dd000000000000000000000000b674f3fd5f43464db0448a57529eaf37f04ccea500000000000000000000000077777777789a8bbee6c64381e5e89e501fb0e4c80000000000000000000000000000000000000000000000000000000000000089'
            }
          ],
          txnId: '0x891e12877c24a8292fd73fd741897682f38a7bcd497374a6b68e8add89e1c0fb',
          status: 'broadcasted-but-not-confirmed',
          identifiedBy: {
            type: 'Transaction',
            identifier: '0x891e12877c24a8292fd73fd741897682f38a7bcd497374a6b68e8add89e1c0fb'
          }
        },
        {
          accountAddr: '0x40b38765696e3d5d8d9d834d8aad4bb6e418e489',
          signingKeyAddr: '0x5Be214147EA1AE3653f289E17fE7Dc17A73AD175',
          gasLimit: null,
          gasFeePayment: {
            isGasTank: false,
            paidBy: '0x40b38765696e3d5d8d9d834d8aad4bb6e418e489',
            inToken: '0x0000000000000000000000000000000000000000',
            amount: 1n,
            simulatedGasLimit: 1n,
            gasPrice: 1n
          },
          chainId: 1n,
          nonce: 225n,
          signature: '0x0000000000000000000000005be214147ea1ae3653f289e17fe7dc17a73ad17503',
          calls: [
            {
              to: '0x18Ce9CF7156584CDffad05003410C3633EFD1ad0',
              value: BigInt(0),
              data: '0x23b872dd000000000000000000000000b674f3fd5f43464db0448a57529eaf37f04ccea500000000000000000000000077777777789a8bbee6c64381e5e89e501fb0e4c80000000000000000000000000000000000000000000000000000000000000089'
            }
          ],
          txnId: '0x891e12877c24a8292fd73fd741897682f38a7bcd497374a6b68e8add89e1c0fb',
          status: 'broadcasted-but-not-confirmed',
          identifiedBy: {
            type: 'Transaction',
            identifier: '0x891e12877c24a8292fd73fd741897682f38a7bcd497374a6b68e8add89e1c0fb'
          }
        },
        {
          accountAddr: '0x40b38765696e3d5d8d9d834d8aad4bb6e418e489',
          signingKeyAddr: '0x5Be214147EA1AE3653f289E17fE7Dc17A73AD175',
          gasLimit: null,
          gasFeePayment: {
            isGasTank: false,
            paidBy: '0x40b38765696e3d5d8d9d834d8aad4bb6e418e489',
            inToken: '0x0000000000000000000000000000000000000000',
            amount: 1n,
            simulatedGasLimit: 1n,
            gasPrice: 1n
          },
          chainId: 10n,
          nonce: 225n,
          signature: '0x0000000000000000000000005be214147ea1ae3653f289e17fe7dc17a73ad17503',
          calls: [
            {
              to: '0x18Ce9CF7156584CDffad05003410C3633EFD1ad0',
              value: BigInt(0),
              data: '0x23b872dd000000000000000000000000b674f3fd5f43464db0448a57529eaf37f04ccea500000000000000000000000077777777789a8bbee6c64381e5e89e501fb0e4c80000000000000000000000000000000000000000000000000000000000000089'
            }
          ],
          txnId: '0x891e12877c24a8292fd73fd741897682f38a7bcd497374a6b68e8add89e1c0fb',
          status: 'broadcasted-but-not-confirmed',
          identifiedBy: {
            type: 'Transaction',
            identifier: '0x891e12877c24a8292fd73fd741897682f38a7bcd497374a6b68e8add89e1c0fb'
          }
        },
        {
          accountAddr: '0x40b38765696e3d5d8d9d834d8aad4bb6e418e489',
          signingKeyAddr: '0x5Be214147EA1AE3653f289E17fE7Dc17A73AD175',
          gasLimit: null,
          gasFeePayment: {
            isGasTank: false,
            paidBy: '0x40b38765696e3d5d8d9d834d8aad4bb6e418e489',
            inToken: '0x0000000000000000000000000000000000000000',
            amount: 1n,
            simulatedGasLimit: 1n,
            gasPrice: 1n
          },
          chainId: 10n,
          nonce: 225n,
          signature: '0x0000000000000000000000005be214147ea1ae3653f289e17fe7dc17a73ad17503',
          calls: [
            {
              to: '0x18Ce9CF7156584CDffad05003410C3633EFD1ad0',
              value: BigInt(0),
              data: '0x23b872dd000000000000000000000000b674f3fd5f43464db0448a57529eaf37f04ccea500000000000000000000000077777777789a8bbee6c64381e5e89e501fb0e4c80000000000000000000000000000000000000000000000000000000000000089'
            }
          ],
          txnId: '0x891e12877c24a8292fd73fd741897682f38a7bcd497374a6b68e8add89e1c0fb',
          status: 'broadcasted-but-not-confirmed',
          identifiedBy: {
            type: 'Transaction',
            identifier: '0x891e12877c24a8292fd73fd741897682f38a7bcd497374a6b68e8add89e1c0fb'
          }
        }
      ] as SubmittedAccountOp[]

      // eslint-disable-next-line no-restricted-syntax
      for (const accountOp of accountsOps) {
        // eslint-disable-next-line no-await-in-loop
        await controller.addAccountOp(accountOp)
      }

      // For the following criteria, we have 2 matching AccountsOps, these will be paginated on 2 pages (1 AccountOp per page)
      await controller.filterAccountsOps(
        sessionId,
        {
          account: '0x40b38765696e3d5d8d9d834d8aad4bb6e418e489',
          chainId: 10n
        },
        { fromPage: 1, itemsPerPage: 1 }
      )

      const controllerAccountsOps = controller.accountsOps

      expect(controllerAccountsOps[sessionId].result).toEqual({
        items: [
          {
            accountAddr: '0x40b38765696e3d5d8d9d834d8aad4bb6e418e489',
            signingKeyAddr: '0x5Be214147EA1AE3653f289E17fE7Dc17A73AD175',
            gasLimit: null,
            gasFeePayment: {
              isGasTank: false,
              paidBy: '0x40b38765696e3d5d8d9d834d8aad4bb6e418e489',
              inToken: '0x0000000000000000000000000000000000000000',
              amount: 1n,
              simulatedGasLimit: 1n,
              gasPrice: 1n
            },
            chainId: 10n,
            nonce: 225n,
            signature: '0x0000000000000000000000005be214147ea1ae3653f289e17fe7dc17a73ad17503',
            calls: [
              {
                to: '0x18Ce9CF7156584CDffad05003410C3633EFD1ad0',
                value: BigInt(0),
                data: '0x23b872dd000000000000000000000000b674f3fd5f43464db0448a57529eaf37f04ccea500000000000000000000000077777777789a8bbee6c64381e5e89e501fb0e4c80000000000000000000000000000000000000000000000000000000000000089'
              }
            ],
            status: 'broadcasted-but-not-confirmed', // everytime we add a new AccountOp, it gets broadcasted-but-not-confirmed status
            txnId: '0x891e12877c24a8292fd73fd741897682f38a7bcd497374a6b68e8add89e1c0fb',
            identifiedBy: {
              type: 'Transaction',
              identifier: '0x891e12877c24a8292fd73fd741897682f38a7bcd497374a6b68e8add89e1c0fb'
            }
          }
        ],
        itemsTotal: 2,
        currentPage: 1, // index based
        maxPages: 2
      })
    })

    test('`success` status is set correctly', async () => {
      const { controller, sessionId } = await prepareTest()

      const accountOp = {
        accountAddr: '0xB674F3fd5F43464dB0448a57529eAF37F04cceA5',
        signingKeyAddr: '0x5Be214147EA1AE3653f289E17fE7Dc17A73AD175',
        gasLimit: null,
        gasFeePayment: {
          isGasTank: false,
          paidBy: '0xB674F3fd5F43464dB0448a57529eAF37F04cceA5',
          inToken: '0x0000000000000000000000000000000000000000',
          amount: 1n,
          simulatedGasLimit: 1n,
          gasPrice: 1n
        },
        chainId: 1n,
        nonce: 225n,
        signature: '0x0000000000000000000000005be214147ea1ae3653f289e17fe7dc17a73ad17503',
        calls: [
          {
            to: '0x18Ce9CF7156584CDffad05003410C3633EFD1ad0',
            value: BigInt(0),
            data: '0x23b872dd000000000000000000000000b674f3fd5f43464db0448a57529eaf37f04ccea500000000000000000000000077777777789a8bbee6c64381e5e89e501fb0e4c80000000000000000000000000000000000000000000000000000000000000089'
          }
        ],
        // this txn is already mined and has `success` status
        txnId: '0x891e12877c24a8292fd73fd741897682f38a7bcd497374a6b68e8add89e1c0fb',
        status: 'broadcasted-but-not-confirmed',
        identifiedBy: {
          type: 'Transaction',
          identifier: '0x891e12877c24a8292fd73fd741897682f38a7bcd497374a6b68e8add89e1c0fb'
        }
      } as SubmittedAccountOp

      await controller.addAccountOp(accountOp)
      await controller.updateAccountsOpsStatuses()
      expect(controller.accountsOps[sessionId].result).toEqual({
        items: [{ ...accountOp, status: 'success' }], //  we expect success here
        itemsTotal: 1,
        currentPage: 0,
        maxPages: 1
      })
    })

    test('`failed` status is set correctly', async () => {
      const { controller, sessionId } = await prepareTest()

      const accountOp = {
        accountAddr: '0xB674F3fd5F43464dB0448a57529eAF37F04cceA5',
        signingKeyAddr: '0x5Be214147EA1AE3653f289E17fE7Dc17A73AD175',
        gasLimit: null,
        gasFeePayment: {
          isGasTank: false,
          paidBy: '0xB674F3fd5F43464dB0448a57529eAF37F04cceA5',
          inToken: '0x0000000000000000000000000000000000000000',
          amount: 1n,
          simulatedGasLimit: 1n,
          gasPrice: 1n
        },
        chainId: 1n,
        nonce: 225n,
        signature: '0x0000000000000000000000005be214147ea1ae3653f289e17fe7dc17a73ad17503',
        calls: [
          {
            to: '0x18Ce9CF7156584CDffad05003410C3633EFD1ad0',
            value: BigInt(0),
            data: '0x23b872dd000000000000000000000000b674f3fd5f43464db0448a57529eaf37f04ccea500000000000000000000000077777777789a8bbee6c64381e5e89e501fb0e4c80000000000000000000000000000000000000000000000000000000000000089'
          }
        ],
        // this txn is already mined, but has `fail` status
        txnId: '0x67ec3acc5274a88c50d1e79e9b9d4c2c3d5e0e3ba3cc33b32d65f3fdb3b5a258',
        status: 'broadcasted-but-not-confirmed',
        identifiedBy: {
          type: 'Transaction',
          identifier: '0x67ec3acc5274a88c50d1e79e9b9d4c2c3d5e0e3ba3cc33b32d65f3fdb3b5a258'
        }
      } as SubmittedAccountOp

      await controller.addAccountOp(accountOp)
      await controller.updateAccountsOpsStatuses()
      const controllerAccountsOps = controller.accountsOps

      expect(controllerAccountsOps[sessionId].result).toEqual({
        items: [{ ...accountOp, status: 'failure' }], // we expect failure here
        itemsTotal: 1,
        currentPage: 0,
        maxPages: 1
      })
    })
    test('A banner is displayed for account ops not older than 10 minutes', async () => {
      const { controller } = await prepareTest()

      const accountOp = {
        ...SUBMITTED_ACCOUNT_OP,
        status: AccountOpStatus.BroadcastedButNotConfirmed,
        timestamp: Date.now() - 5 * 60 * 1000 // 5 minutes ago
      }

      await controller.addAccountOp(accountOp)

      expect(controller.banners[0].id).toBe(accountOp.txnId)
    })
    test('A banner is not displayed for account ops older than 10 minutes', async () => {
      const { controller } = await prepareTest()

      const accountOp = {
        ...SUBMITTED_ACCOUNT_OP,
        status: AccountOpStatus.BroadcastedButNotConfirmed,
        timestamp: Date.now() - 11 * 60 * 1000 // 11 minutes ago
      }

      await controller.addAccountOp(accountOp)

      expect(controller.banners.length).toBe(0)
    })
    test('Confirmed banners are automatically hidden when a new account op is added or updated', async () => {
      const { controller } = await prepareTest()

      const accountOp = {
        ...SUBMITTED_ACCOUNT_OP,
        status: AccountOpStatus.Success,
        timestamp: Date.now() - 5 * 60 * 1000 // 5 minutes ago
      }

      await controller.addAccountOp(accountOp)

      expect(controller.banners[0].id).toBe(accountOp.txnId)
      expect(controller.banners.length).toBe(1)

      // Simulate a new account op added
      const newAccountOp = {
        ...SUBMITTED_ACCOUNT_OP,
        id: 'new-account-op',
        status: AccountOpStatus.BroadcastedButNotConfirmed,
        timestamp: Date.now()
      }

      await controller.addAccountOp(newAccountOp)

      expect(controller.banners.length).toBe(1)
    })

    // test('`Unknown but past nonce` status is set correctly', async () => {
    //   await selectedAccountCtrl.setAccount(ACCOUNTS[0])
    //   await accountsCtrl.updateAccountState('0xa07D75aacEFd11b425AF7181958F0F85c312f143')
    //   const controller = new ActivityController(
    //     storageCtrl,
    //     fetch,
    //     callRelayer,
    //     accountsCtrl,
    //     selectedAccountCtrl,
    //     providersCtrl,
    //     networksCtrl,
    //     portfolioCtrl,
    //     () => Promise.resolve()
    //   )

    //   const sessionId = Date.now().toString()

    //   await controller.filterAccountsOps(sessionId, {
    //     account: '0xa07D75aacEFd11b425AF7181958F0F85c312f143',
    //     chainId: 1n
    //   })

    //   const accountOp = {
    //     accountAddr: '0xa07D75aacEFd11b425AF7181958F0F85c312f143',
    //     signingKeyAddr: '0x5Be214147EA1AE3653f289E17fE7Dc17A73AD175',
    //     gasLimit: null,
    //     gasFeePayment: {
    //       isGasTank: false,
    //       paidBy: '0xa07D75aacEFd11b425AF7181958F0F85c312f143',
    //       inToken: '0x0000000000000000000000000000000000000000',
    //       amount: 1n,
    //       simulatedGasLimit: 1n,
    //       gasPrice: 1n
    //     },
    //     chainId: 1n,
    //     nonce: 225n,
    //     signature: '0x0000000000000000000000005be214147ea1ae3653f289e17fe7dc17a73ad17503',
    //     calls: [
    //       {
    //         to: '0x18Ce9CF7156584CDffad05003410C3633EFD1ad0',
    //         value: BigInt(0),
    //         data: '0x23b872dd000000000000000000000000b674f3fd5f43464db0448a57529eaf37f04ccea500000000000000000000000077777777789a8bbee6c64381e5e89e501fb0e4c80000000000000000000000000000000000000000000000000000000000000089'
    //       }
    //     ],
    //     // wrong txn id, so we can simulate nullish getTransactionReceipt()
    //     txnId: '0x0000000000000000000000000000000000000000000000000000000000000001',
    //     status: 'broadcasted-but-not-confirmed',
    //     identifiedBy: {
    //       type: 'Transaction',
    //       identifier: '0x0000000000000000000000000000000000000000000000000000000000000001'
    //     }
    //   } as SubmittedAccountOp
    //   const accountOpCompleted = {
    //     accountAddr: '0xa07D75aacEFd11b425AF7181958F0F85c312f143',
    //     signingKeyAddr: '0x5Be214147EA1AE3653f289E17fE7Dc17A73AD175',
    //     gasLimit: null,
    //     gasFeePayment: {
    //       isGasTank: false,
    //       paidBy: '0xa07D75aacEFd11b425AF7181958F0F85c312f143',
    //       inToken: '0x0000000000000000000000000000000000000000',
    //       amount: 1n,
    //       simulatedGasLimit: 1n,
    //       gasPrice: 1n
    //     },
    //     chainId: 1n,
    //     nonce: 225n,
    //     signature: '0x0000000000000000000000005be214147ea1ae3653f289e17fe7dc17a73ad17503',
    //     calls: [
    //       {
    //         to: '0x18Ce9CF7156584CDffad05003410C3633EFD1ad0',
    //         value: BigInt(0),
    //         data: '0x23b872dd000000000000000000000000b674f3fd5f43464db0448a57529eaf37f04ccea500000000000000000000000077777777789a8bbee6c64381e5e89e501fb0e4c80000000000000000000000000000000000000000000000000000000000000089'
    //       }
    //     ],
    //     // wrong txn id, so we can simulate nullish getTransactionReceipt()
    //     txnId: '0x0000000000000000000000000000000000000000000000000000000000000001',
    //     status: 'success',
    //     identifiedBy: {
    //       type: 'Transaction',
    //       identifier: '0x0000000000000000000000000000000000000000000000000000000000000001'
    //     }
    //   } as SubmittedAccountOp

    //   await controller.addAccountOp(accountOp)
    //   await controller.addAccountOp(accountOpCompleted)
    //   await controller.updateAccountsOpsStatuses()
    //   const controllerAccountsOps = controller.accountsOps

    //   expect(controllerAccountsOps[sessionId].result).toEqual({
    //     items: [accountOpCompleted, { ...accountOp, status: 'unknown-but-past-nonce' }], // we expect unknown-but-past-nonce status here
    //     itemsTotal: 2,
    //     currentPage: 0,
    //     maxPages: 1
    //   })
    // })

    test('Keeps no more than 1000 items', async () => {
      const { controller, sessionId } = await prepareTest()

      const accountOp = {
        accountAddr: '0xB674F3fd5F43464dB0448a57529eAF37F04cceA5',
        signingKeyAddr: '0x5Be214147EA1AE3653f289E17fE7Dc17A73AD175',
        gasLimit: null,
        gasFeePayment: {
          isGasTank: false,
          paidBy: '0xa07D75aacEFd11b425AF7181958F0F85c312f143',
          inToken: '0x0000000000000000000000000000000000000000',
          amount: 1n,
          simulatedGasLimit: 1n,
          gasPrice: 1n
        },
        chainId: 1n,
        nonce: 225n,
        signature: '0x0000000000000000000000005be214147ea1ae3653f289e17fe7dc17a73ad17503',
        calls: [
          {
            to: '0x18Ce9CF7156584CDffad05003410C3633EFD1ad0',
            value: BigInt(0),
            data: '0x23b872dd000000000000000000000000b674f3fd5f43464db0448a57529eaf37f04ccea500000000000000000000000077777777789a8bbee6c64381e5e89e501fb0e4c80000000000000000000000000000000000000000000000000000000000000089'
          }
        ],
        txnId: '0x891e12877c24a8292fd73fd741897682f38a7bcd497374a6b68e8add89e1c0fb',
        status: 'broadcasted-but-not-confirmed',
        identifiedBy: {
          type: 'Transaction',
          identifier: '0x891e12877c24a8292fd73fd741897682f38a7bcd497374a6b68e8add89e1c0fb'
        }
      } as SubmittedAccountOp

      const accountsOps = Array.from(Array(1500).keys()).map((key) => ({
        ...accountOp,
        nonce: BigInt(key)
      }))

      // eslint-disable-next-line no-restricted-syntax
      for (const ao of accountsOps) {
        // eslint-disable-next-line no-await-in-loop
        await controller.addAccountOp(ao)
      }

      await controller.filterAccountsOps(sessionId, INIT_PARAMS, {
        fromPage: 0,
        itemsPerPage: 1000
      })
      const controllerAccountsOps = controller.accountsOps
      expect(controllerAccountsOps[sessionId].result.itemsTotal).toEqual(1000)
      // newest added item will be added to the beginning of the array
      // in this case newest item is with nonce 1499n and should be at index 0
      expect(controllerAccountsOps[sessionId].result.items[0].nonce).toEqual(1499n)
      expect(controllerAccountsOps[sessionId].result.items[999].nonce).toEqual(500n)
    })
  })

  describe('SignedMessages', () => {
    test('Retrieved from Controller and persisted in Storage', async () => {
      const { controller, sessionId } = await prepareSignedMessagesTest()

      const signedMessage: SignedMessage = {
        fromActionId: 1,
        accountAddr: '0xB674F3fd5F43464dB0448a57529eAF37F04cceA5',
        dapp: {
          icon: '',
          name: 'dapp-name'
        },
        timestamp: 1701345600000,
        content: {
          kind: 'message',
          message: '0x74657374'
        },

        signature: '0x0000000000000000000000005be214147ea1ae3653f289e17fe7dc17a73ad17503',
        chainId: 1n
      }

      await controller.addSignedMessage(signedMessage, '0xB674F3fd5F43464dB0448a57529eAF37F04cceA5')
      const controllerSignedMessages = controller.signedMessages
      const storageSignedMessages = await storage.get('signedMessages', {})

      expect(controllerSignedMessages[sessionId].result).toEqual({
        items: [signedMessage],
        itemsTotal: 1,
        currentPage: 0,
        maxPages: 1
      })
      expect(storageSignedMessages['0xB674F3fd5F43464dB0448a57529eAF37F04cceA5']).toEqual([
        signedMessage
      ])
    })

    test('Pagination and filtration handled correctly', async () => {
      const { controller, sessionId } = await prepareSignedMessagesTest()

      await controller.addSignedMessage(
        SIGNED_MESSAGE,
        '0xB674F3fd5F43464dB0448a57529eAF37F04cceA5'
      )
      await controller.addSignedMessage(
        SIGNED_MESSAGE,
        '0xB674F3fd5F43464dB0448a57529eAF37F04cceA5'
      )
      await controller.addSignedMessage(
        SIGNED_MESSAGE,
        '0xB674F3fd5F43464dB0448a57529eAF37F04cceA5'
      )

      // For the following criteria, we have 2 matching SignedMessages, these will be paginated on 2 pages (1 Message per page)
      await controller.filterSignedMessages(
        sessionId,
        {
          account: '0xB674F3fd5F43464dB0448a57529eAF37F04cceA5',
          chainId: 10n
        },
        { fromPage: 1, itemsPerPage: 1 }
      )

      const controllerSignedMessages = controller.signedMessages

      expect(controllerSignedMessages[sessionId].result).toEqual({
        items: [SIGNED_MESSAGE],
        itemsTotal: 3,
        currentPage: 1, // index based
        maxPages: 3
      })
    })

    test('Keeps no more than 1000 items', async () => {
      const { controller, sessionId } = await prepareSignedMessagesTest()

      const signedMessages = Array.from(Array(1500).keys()).map((key) => ({
        ...SIGNED_MESSAGE,
        signature: key.toString()
      }))

      // eslint-disable-next-line no-restricted-syntax
      for (const sm of signedMessages) {
        // eslint-disable-next-line no-await-in-loop
        await controller.addSignedMessage(sm, '0xB674F3fd5F43464dB0448a57529eAF37F04cceA5')
      }

      await controller.filterSignedMessages(sessionId, INIT_PARAMS, {
        fromPage: 0,
        itemsPerPage: 1000
      })
      const controllerSignedMessages = controller.signedMessages

      expect(controllerSignedMessages[sessionId].result.itemsTotal).toEqual(1000)
      // newest added item will be added to the beginning of the array
      // in this case newest item is with signature 1499 and should be at index 0
      expect(controllerSignedMessages[sessionId].result.items[0].signature).toEqual('1499')
      expect(controllerSignedMessages[sessionId].result.items[999].signature).toEqual('500')
    })
  })
  test('removeAccountData', async () => {
    const controller = new ActivityController(
      storageCtrl,
      fetch,
      callRelayer,
      accountsCtrl,
      selectedAccountCtrl,
      providersCtrl,
      networksCtrl,
      portfolioCtrl,
      () => Promise.resolve()
    )

    const sessionId = Date.now().toString()

    // Apply filtration
    await controller.filterAccountsOps(sessionId, INIT_PARAMS)
    await controller.filterSignedMessages(sessionId, INIT_PARAMS)

    // Add an accountOp
    await controller.addAccountOp(SUBMITTED_ACCOUNT_OP)
    // Add a signedMessage
    await controller.addSignedMessage(SIGNED_MESSAGE, INIT_PARAMS.account)

    // Validate that they are in the controller
    expect(controller.accountsOps[sessionId].result.items.length).toEqual(1)
    expect(controller.signedMessages[sessionId].result.items.length).toEqual(1)

    // Remove account data
    await controller.removeAccountData('0xB674F3fd5F43464dB0448a57529eAF37F04cceA5')

    // Validate that the account data is removed
    expect(controller.accountsOps[sessionId].result.items.length).toEqual(0)
    expect(controller.signedMessages[sessionId].result.items.length).toEqual(0)
  })
})

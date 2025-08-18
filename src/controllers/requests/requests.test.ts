import fetch from 'node-fetch'

import { describe, expect, test } from '@jest/globals'

import { relayerUrl, velcroUrl } from '../../../test/config'
import { produceMemoryStore } from '../../../test/helpers'
import { mockWindowManager } from '../../../test/helpers/window'
import { Session } from '../../classes/session'
import humanizerInfo from '../../consts/humanizer/humanizerInfo.json'
import { networks } from '../../consts/networks'
import { RPCProviders } from '../../interfaces/provider'
import { UserRequest } from '../../interfaces/userRequest'
import { HumanizerMeta } from '../../libs/humanizer/interfaces'
import { relayerCall } from '../../libs/relayerCall/relayerCall'
import { getRpcProvider } from '../../services/provider'
import { AccountsController } from '../accounts/accounts'
import { ActivityController } from '../activity/activity'
import { AddressBookController } from '../addressBook/addressBook'
import { BannerController } from '../banner/banner'
import { DappsController } from '../dapps/dapps'
import { InviteController } from '../invite/invite'
import { KeystoreController } from '../keystore/keystore'
import { NetworksController } from '../networks/networks'
import { PortfolioController } from '../portfolio/portfolio'
import { ProvidersController } from '../providers/providers'
import { SelectedAccountController } from '../selectedAccount/selectedAccount'
import { StorageController } from '../storage/storage'
import { SocketAPIMock } from '../swapAndBridge/socketApiMock'
import { SwapAndBridgeController } from '../swapAndBridge/swapAndBridge'
import { TransferController } from '../transfer/transfer'
import { RequestsController } from './requests'

const windowManager = mockWindowManager().windowManager

const notificationManager = {
  create: () => Promise.resolve()
}

const MOCK_SESSION = new Session({ tabId: 1, origin: 'https://test-dApp.com' })

const accounts = [
  {
    addr: '0xa07D75aacEFd11b425AF7181958F0F85c312f143',
    associatedKeys: ['0xd6e371526cdaeE04cd8AF225D42e37Bc14688D9E'],
    creation: {
      factoryAddr: '0xBf07a0Df119Ca234634588fbDb5625594E2a5BCA',
      bytecode:
        '0x7f28d4ea8f825adb036e9b306b2269570e63d2aa5bd10751437d98ed83551ba1cd7fa57498058891e98f45f8abb85dafbcd30f3d8b3ab586dfae2e0228bbb1de7018553d602d80604d3d3981f3363d3d373d3d3d363d732a2b85eb1054d6f0c6c2e37da05ed3e5fea684ef5af43d82803e903d91602b57fd5bf3',
      salt: '0x0000000000000000000000000000000000000000000000000000000000000001'
    }
  },
  {
    addr: '0x6C0937c7a04487573673a47F22E4Af9e96b91ecd',
    associatedKeys: ['0xfF3f6D14DF43c112aB98834Ee1F82083E07c26BF'],
    creation: {
      factoryAddr: '0xBf07a0Df119Ca234634588fbDb5625594E2a5BCA',
      bytecode:
        '0x7f1e7646e4695bead8bb0596679b0caf3a7ff6c4e04d2ad79103c8fa61fb6337f47fa57498058891e98f45f8abb85dafbcd30f3d8b3ab586dfae2e0228bbb1de7018553d602d80604d3d3981f3363d3d373d3d3d363d732a2b85eb1054d6f0c6c2e37da05ed3e5fea684ef5af43d82803e903d91602b57fd5bf3',
      salt: '0x0000000000000000000000000000000000000000000000000000000000000001'
    }
  },
  {
    addr: '0x77777777789A8BBEE6C64381e5E89E501fb0e4c8',
    associatedKeys: [],
    creation: {
      factoryAddr: '0xBf07a0Df119Ca234634588fbDb5625594E2a5BCA',
      bytecode:
        '0x7f00000000000000000000000000000000000000000000000000000000000000017f02c94ba85f2ea274a3869293a0a9bf447d073c83c617963b0be7c862ec2ee44e553d602d80604d3d3981f3363d3d373d3d3d363d732a2b85eb1054d6f0c6c2e37da05ed3e5fea684ef5af43d82803e903d91602b57fd5bf3',
      salt: '0x2ee01d932ede47b0b2fb1b6af48868de9f86bfc9a5be2f0b42c0111cf261d04c'
    }
  }
]

const prepareTest = async () => {
  const storage = produceMemoryStore()
  await storage.set('accounts', accounts)
  await storage.set('selectedAccount', '0x77777777789A8BBEE6C64381e5E89E501fb0e4c8')
  const storageCtrl = new StorageController(storage)
  const keystore = new KeystoreController('default', storageCtrl, {}, windowManager)
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
  const providers: RPCProviders = {}
  networks.forEach((network) => {
    providers[network.chainId.toString()] = getRpcProvider(network.rpcUrls, network.chainId)
    providers[network.chainId.toString()].isWorking = true
  })
  providersCtrl.providers = providers
  const accountsCtrl = new AccountsController(
    storageCtrl,
    providersCtrl,
    networksCtrl,
    keystore,
    () => {},
    () => {},
    () => {}
  )

  const keystoreCtrl = new KeystoreController('default', storageCtrl, {}, windowManager)

  const selectedAccountCtrl = new SelectedAccountController({
    storage: storageCtrl,
    accounts: accountsCtrl,
    keystore: keystoreCtrl
  })

  const dappsCtrl = new DappsController(storageCtrl)

  const addressBookCtrl = new AddressBookController(storageCtrl, accountsCtrl, selectedAccountCtrl)
  const portfolioCtrl = new PortfolioController(
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
  const callRelayer = relayerCall.bind({ url: '', fetch })
  const activityCtrl = new ActivityController(
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
  const transferCtrl = new TransferController(
    storageCtrl,
    humanizerInfo as HumanizerMeta,
    selectedAccountCtrl,
    networksCtrl,
    addressBookCtrl,
    accountsCtrl,
    keystoreCtrl,
    portfolioCtrl,
    activityCtrl,
    {},
    providersCtrl,
    relayerUrl
  )

  const requestsController: RequestsController = {} as RequestsController

  const swapAndBridgeCtrl = new SwapAndBridgeController({
    selectedAccount: selectedAccountCtrl,
    networks: networksCtrl,
    accounts: accountsCtrl,
    activity: activityCtrl,
    storage: storageCtrl,
    serviceProviderAPI: SocketAPIMock as any,
    invite: new InviteController({ relayerUrl: '', fetch, storage: storageCtrl }),
    keystore,
    portfolio: portfolioCtrl,
    providers: providersCtrl,
    externalSignerControllers: {},
    relayerUrl,
    getUserRequests: () => {
      return requestsController?.userRequests || []
    },
    getVisibleActionsQueue: () => {
      return requestsController?.actions?.visibleActionsQueue || []
    }
  })

  return {
    controller: new RequestsController({
      relayerUrl,
      accounts: accountsCtrl,
      networks: networksCtrl,
      providers: providersCtrl,
      selectedAccount: selectedAccountCtrl,
      keystore: keystoreCtrl,
      dapps: dappsCtrl,
      transfer: transferCtrl,
      swapAndBridge: swapAndBridgeCtrl,
      windowManager,
      notificationManager,
      getSignAccountOp: () => null,
      updateSignAccountOp: () => {},
      destroySignAccountOp: () => {},
      updateSelectedAccountPortfolio: () => Promise.resolve(),
      addTokensToBeLearned: () => {},
      guardHWSigning: () => Promise.resolve(false)
    })
  }
}

describe('RequestsController ', () => {
  beforeEach(() => {
    jest.restoreAllMocks()
  })
  test('Init controller', async () => {
    const { controller } = await prepareTest()
    expect(controller.initialLoadPromise).toBeInstanceOf(Promise)
    await expect(controller.initialLoadPromise).resolves.toBeUndefined()
  })

  test('Add and then remove a user request', async () => {
    const { controller } = await prepareTest()
    const req: UserRequest = {
      id: 1,
      action: {
        kind: 'calls',
        calls: [
          {
            to: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
            value: BigInt(0),
            data: '0xa9059cbb000000000000000000000000e5a4dad2ea987215460379ab285df87136e83bea00000000000000000000000000000000000000000000000000000000005040aa'
          }
        ]
      },
      session: new Session(),
      meta: {
        isSignAction: true,
        accountAddr: '0x77777777789A8BBEE6C64381e5E89E501fb0e4c8',
        chainId: 1n
      }
    }

    await controller.addUserRequests([req])
    expect(controller.actions.actionsQueue.length).toBe(1)
    expect(controller.actions.visibleActionsQueue.length).toBe(1)

    await controller.removeUserRequests([req.id])
    expect(controller.actions.actionsQueue.length).toBe(0)
    expect(controller.actions.visibleActionsQueue.length).toBe(0)
  })
  test('build dapp request', async () => {
    const { controller } = await prepareTest()

    await controller.build({
      type: 'dappRequest',
      params: {
        request: {
          method: 'dapp_connect',
          params: {},
          session: MOCK_SESSION,
          origin: 'https://test-dApp.com'
        },
        dappPromise: { resolve: () => {}, reject: () => {}, session: MOCK_SESSION }
      }
    })

    expect(controller.userRequests.length).toBe(1)
    expect(controller.userRequests[0].action.kind).toBe('dappConnect')
  })
  test('build transfer request', async () => {
    const { controller } = await prepareTest()

    await controller.build({
      type: 'transferRequest',
      params: {
        selectedToken: {
          address: '0x0000000000000000000000000000000000000000',
          amount: 1n,
          symbol: 'ETH',
          name: 'Ether',
          chainId: 1n,
          decimals: 18,
          priceIn: [],
          flags: {
            onGasTank: false,
            rewardsType: null,
            canTopUpGasTank: true,
            isFeeToken: true
          }
        },
        amount: '1',
        actionExecutionType: 'open-action-window',
        recipientAddress: '0xa07D75aacEFd11b425AF7181958F0F85c312f143'
      }
    })

    expect(controller.userRequests.length).toBe(1)
    expect(controller.userRequests[0].action.kind).toBe('calls')
  })
  test('resolve user request', async () => {
    const { controller } = await prepareTest()

    const resolveMock = jest.fn()
    const rejectMock = jest.fn()

    const req: UserRequest = {
      id: 1,
      action: {
        kind: 'calls',
        calls: [
          {
            to: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
            value: BigInt(0),
            data: '0xa9059cbb000000000000000000000000e5a4dad2ea987215460379ab285df87136e83bea00000000000000000000000000000000000000000000000000000000005040aa'
          }
        ]
      },
      session: new Session(),
      meta: {
        isSignAction: true,
        accountAddr: '0x77777777789A8BBEE6C64381e5E89E501fb0e4c8',
        chainId: 1n
      },
      dappPromise: { resolve: resolveMock, reject: rejectMock, session: MOCK_SESSION }
    }

    await controller.addUserRequests([req])
    expect(controller.actions.actionsQueue.length).toBe(1)
    expect(controller.actions.visibleActionsQueue.length).toBe(1)

    await controller.resolveUserRequest(null, req.id)
    expect(controller.userRequests.length).toBe(0)
    expect(controller.actions.visibleActionsQueue.length).toBe(0)
    expect(resolveMock).toHaveBeenCalled()
    expect(rejectMock).not.toHaveBeenCalled()
  })
  test('reject user request', async () => {
    const { controller } = await prepareTest()

    const resolveMock = jest.fn()
    const rejectMock = jest.fn()

    const req: UserRequest = {
      id: 1,
      action: {
        kind: 'calls',
        calls: [
          {
            to: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
            value: BigInt(0),
            data: '0xa9059cbb000000000000000000000000e5a4dad2ea987215460379ab285df87136e83bea00000000000000000000000000000000000000000000000000000000005040aa'
          }
        ]
      },
      session: new Session(),
      meta: {
        isSignAction: true,
        accountAddr: '0x77777777789A8BBEE6C64381e5E89E501fb0e4c8',
        chainId: 1n
      },
      dappPromise: { resolve: resolveMock, reject: rejectMock, session: MOCK_SESSION }
    }

    await controller.addUserRequests([req])
    expect(controller.actions.actionsQueue.length).toBe(1)
    expect(controller.actions.visibleActionsQueue.length).toBe(1)

    await controller.rejectUserRequests('User rejected', [req.id])
    expect(controller.userRequests.length).toBe(0)
    expect(controller.actions.visibleActionsQueue.length).toBe(0)
    expect(rejectMock).toHaveBeenCalled()
    expect(resolveMock).not.toHaveBeenCalled()
  })
})

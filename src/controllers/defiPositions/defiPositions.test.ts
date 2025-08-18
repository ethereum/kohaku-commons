import fetch from 'node-fetch'

import { relayerUrl } from '../../../test/config'
import { produceMemoryStore } from '../../../test/helpers'
import { suppressConsole } from '../../../test/helpers/console'
import { mockWindowManager } from '../../../test/helpers/window'
import { networks } from '../../consts/networks'
import { RPCProviders } from '../../interfaces/provider'
import * as defiProviders from '../../libs/defiPositions/providers'
import { getRpcProvider } from '../../services/provider'
import { AccountsController } from '../accounts/accounts'
import { KeystoreController } from '../keystore/keystore'
import { NetworksController } from '../networks/networks'
import { ProvidersController } from '../providers/providers'
import { SelectedAccountController } from '../selectedAccount/selectedAccount'
import { StorageController } from '../storage/storage'
import { DefiPositionsController } from './defiPositions'

global.fetch = fetch as any

const ACCOUNT = {
  addr: '0xC2E6dFcc2C6722866aD65F211D5757e1D2879337',
  initialPrivileges: [],
  associatedKeys: ['0x5Be214147EA1AE3653f289E17fE7Dc17A73AD175'],
  creation: {
    factoryAddr: '0xBf07a0Df119Ca234634588fbDb5625594E2a5BCA',
    bytecode:
      '0x7f00000000000000000000000000000000000000000000000000000000000000017f02c94ba85f2ea274a3869293a0a9bf447d073c83c617963b0be7c862ec2ee44e553d602d80604d3d3981f3363d3d373d3d3d363d732a2b85eb1054d6f0c6c2e37da05ed3e5fea684ef5af43d82803e903d91602b57fd5bf3',
    salt: '0x2ee01d932ede47b0b2fb1b6af48868de9f86bfc9a5be2f0b42c0111cf261d04c'
  },
  preferences: {
    label: 'Test account',
    pfp: '0xC2E6dFcc2C6722866aD65F211D5757e1D2879337'
  }
}

const providers: RPCProviders = {}

networks.forEach((network) => {
  providers[network.chainId.toString()] = getRpcProvider(network.rpcUrls, network.chainId)
  providers[network.chainId.toString()].isWorking = true
})

const prepareTest = async () => {
  const storage = produceMemoryStore()
  await storage.set('accounts', [ACCOUNT])
  const storageCtrl = new StorageController(storage)
  let providersCtrl: ProvidersController

  const windowManager = mockWindowManager().windowManager
  const keystoreCtrl = new KeystoreController('default', storageCtrl, {}, windowManager)

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
    keystoreCtrl,
    () => {},
    () => {},
    () => {}
  )

  const selectedAccountCtrl = new SelectedAccountController({
    storage: storageCtrl,
    accounts: accountsCtrl,
    keystore: keystoreCtrl
  })
  await selectedAccountCtrl.initialLoadPromise
  await networksCtrl.initialLoadPromise
  await providersCtrl.initialLoadPromise

  await selectedAccountCtrl.setAccount(ACCOUNT)
  const controller = new DefiPositionsController({
    fetch: global.fetch as any,
    storage: storageCtrl,
    selectedAccount: selectedAccountCtrl,
    keystore: keystoreCtrl,
    providers: providersCtrl,
    networks: networksCtrl,
    accounts: accountsCtrl
  })

  return {
    controller,
    storage
  }
}

describe('DefiPositionsController', () => {
  beforeEach(() => {
    jest.restoreAllMocks()
  })
  it('should update positions correctly', async () => {
    const { controller } = await prepareTest()

    await controller.updatePositions()
    const selectedAccountState = controller.getDefiPositionsState(ACCOUNT.addr)
    expect(selectedAccountState['137'].updatedAt).toBeDefined()
    expect(selectedAccountState['137'].positionsByProvider.length).toBeGreaterThan(0)
  })

  it('should handle errors in update positions', async () => {
    const consoleSuppressor = suppressConsole()
    jest.spyOn(defiProviders, 'getAAVEPositions').mockImplementation(
      () =>
        new Promise((_, reject) => {
          reject(new Error('AAVE error'))
        })
    )
    jest.spyOn(defiProviders, 'getUniV3Positions').mockImplementation(
      () =>
        new Promise((_, reject) => {
          reject(new Error('Uniswap error'))
        })
    )
    const { controller } = await prepareTest()
    await controller.updatePositions()

    const selectedAccountState = controller.getDefiPositionsState(ACCOUNT.addr)
    expect(selectedAccountState['1'].providerErrors).toEqual([
      { providerName: 'AAVE v3', error: 'AAVE error' },
      { providerName: 'Uniswap V3', error: 'Uniswap error' }
    ])

    consoleSuppressor.restore()
  })

  it('should set asset prices correctly', async () => {
    const { controller } = await prepareTest()
    await controller.updatePositions()

    const selectedAccountState = controller.getDefiPositionsState(ACCOUNT.addr)

    const positions = selectedAccountState['137'].positionsByProvider
    expect(positions.length).toBeGreaterThan(0)
    positions.forEach((provider) => {
      provider.positions.forEach((position) => {
        position.assets.forEach((asset) => {
          expect(asset.value).toBeDefined()
          expect(asset.priceIn).toEqual({ baseCurrency: 'usd', price: expect.any(Number) })
        })
      })
    })
  })

  it('should update networksWithPositionsByAccounts properly', async () => {
    const { controller } = await prepareTest()

    await controller.updatePositions()
    const networksWithPositions = controller.getNetworksWithPositions(ACCOUNT.addr)

    expect(networksWithPositions['137']).toContain('AAVE v3')
  })
  it('should handle provider error and empty state for networksWithPositionsByAccounts', async () => {
    const consoleSuppressor = suppressConsole()

    jest.spyOn(defiProviders, 'getAAVEPositions').mockImplementation(
      () =>
        new Promise((_, reject) => {
          reject(new Error('AAVE error'))
        })
    )
    const { controller } = await prepareTest()

    await controller.updatePositions()
    const accountState = controller.getDefiPositionsState(ACCOUNT.addr)

    expect(accountState['1'].providerErrors!.length).toBeGreaterThan(0)
    expect(accountState['137'].providerErrors!.length).toBeGreaterThan(0)

    const networksWithPositions = controller.getNetworksWithPositions(ACCOUNT.addr)

    // Undefined because there is a provider has an error, so we
    // can't be certain if the account has positions on that network
    expect(networksWithPositions['137']).toBeUndefined()
    expect(networksWithPositions['1']).toBeUndefined()

    consoleSuppressor.restore()
  })
})

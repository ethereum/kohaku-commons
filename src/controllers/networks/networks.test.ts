/* eslint-disable @typescript-eslint/no-floating-promises */

import fetch from 'node-fetch'

import { describe, expect, test } from '@jest/globals'

import { relayerUrl } from '../../../test/config'
import { produceMemoryStore } from '../../../test/helpers'
import { networks as predefinedNetworks } from '../../consts/networks'
import { AddNetworkRequestParams, NetworkInfo } from '../../interfaces/network'
import { StorageController } from '../storage/storage'
import { NetworksController } from './networks'

describe('Networks Controller', () => {
  let networksController: NetworksController
  let skipBeforeEach = false

  beforeEach(async () => {
    if (skipBeforeEach) return

    const storage = produceMemoryStore()
    const storageCtrl = new StorageController(storage)
    networksController = new NetworksController({
      storage: storageCtrl,
      fetch,
      relayerUrl,
      onAddOrUpdateNetworks: () => {},
      onRemoveNetwork: () => {}
    })
  })

  test('should initialize with predefined networks if storage is empty', async () => {
    await networksController.initialLoadPromise // Wait for load to complete

    expect(networksController.networks.length).toEqual(predefinedNetworks.length)
  })

  test('should merge relayer networks correctly, including custom "unichain" network', async () => {
    // Add a custom network "unichain" to the predefined networks
    const customNetwork = {
      chainId: 130n,
      name: 'UniChain',
      nativeAssetSymbol: 'UNI',
      nativeAssetName: 'UniChain Token',
      rpcUrls: ['https://unichain.rpc.url-2'],
      explorerUrl: 'https://unichain.explorer',
      selectedRpcUrl: 'https://unichain.rpc.url-2',
      erc4337: {
        enabled: false,
        hasPaymaster: false
      },
      rpcNoStateOverride: false,
      feeOptions: {
        is1559: false
      },
      isSAEnabled: false,
      areContractsDeployed: false,
      features: [],
      hasRelayer: false,
      hasSingleton: false,
      platformId: 'unichain',
      nativeAssetId: '1234',
      predefined: false,
      has7702: false
    }
    const networksBeforeUpdate = [...predefinedNetworks, customNetwork]

    const finalNetworks = networksBeforeUpdate.reduce(
      (acc: { [key: string]: typeof customNetwork }, network) => {
        acc[network.chainId.toString()] = network as typeof customNetwork
        return acc
      },
      {}
    )

    const { mergedNetworks } = await networksController.mergeRelayerNetworks(finalNetworks)

    // Ensure the merged networks contain "unichain" and other relayer networks
    expect(mergedNetworks).toHaveProperty('130')
    expect(mergedNetworks['130'].rpcUrls).toContain('https://unichain.rpc.url-2') // Ensure the custom "unichain" network is added to rpcUrls array
    expect(mergedNetworks['130'].predefined).toBe(false) // Ensure "unichain" details are correct
  })

  test('should update network preferences', (done) => {
    const preferences = {
      rpcUrls: ['https://eth-mainnet.alchemyapi.io/v2/123abc123abc123abc123abc123abcde'],
      explorerUrl: 'https://etherscan.io/custom'
    }

    let checkComplete = false
    networksController.onUpdate(() => {
      if (networksController.statuses.updateNetwork === 'SUCCESS' && !checkComplete) {
        const modifiedNetwork = networksController.networks.find(({ chainId }) => chainId === 1n)
        expect(modifiedNetwork?.explorerUrl).toEqual('https://etherscan.io/custom')
        expect(modifiedNetwork?.rpcUrls).toEqual([
          'https://eth-mainnet.alchemyapi.io/v2/123abc123abc123abc123abc123abcde'
        ])
        checkComplete = true
        done()
      }
    })

    networksController.updateNetwork(preferences, 1n)
  })

  test('should add the sei network as a custom network', (done) => {
    let checks = 0
    let setNetwork: null | AddNetworkRequestParams = null
    networksController.onUpdate(() => {
      if (checks === 0 || checks === 1) {
        checks++
        return
      }
      if (checks === 2) {
        expect(networksController.networkToAddOrUpdate?.chainId).toBe(1329n)
        const networkInfoLoading = networksController.networkToAddOrUpdate?.info
        if (!networkInfoLoading) return

        const isLoading = Object.values(networkInfoLoading).some((v) => v === 'LOADING')
        if (isLoading) return
        const setNetworkInfo: NetworkInfo = networkInfoLoading as NetworkInfo
        // has smart accounts
        expect(setNetworkInfo?.isSAEnabled).toBe(true)

        // contracts are deployed
        expect(setNetworkInfo?.areContractsDeployed).toBe(true)
        expect(setNetworkInfo?.feeOptions!.is1559).toBe(true)

        // mantle is optimistic
        expect(setNetworkInfo?.isOptimistic).toBe(false)
        // coingecko
        expect(setNetworkInfo?.platformId).toBe('sei-v2')
        expect(setNetworkInfo?.nativeAssetId).toBe('wrapped-sei')
        // simulation is somewhat supported
        expect(setNetworkInfo?.rpcNoStateOverride).toBe(false)
        setNetwork = {
          name: 'Sei',
          rpcUrls: [networksController.networkToAddOrUpdate?.rpcUrl],
          selectedRpcUrl: networksController.networkToAddOrUpdate?.rpcUrl,
          nativeAssetSymbol: 'SEI',
          nativeAssetName: 'Sei',
          explorerUrl: 'https://seitrace.com',
          ...setNetworkInfo,
          feeOptions: setNetworkInfo.feeOptions ?? {
            is1559: false
          },
          iconUrls: []
        } as AddNetworkRequestParams

        checks++
        networksController.addNetwork(setNetwork)
      }

      if (checks === 3) {
        const noUpdate = networksController.networkToAddOrUpdate
        if (noUpdate !== null) return

        checks++
        const sei = networksController.networks.find((n) => n.chainId === 1329n)
        expect(sei).not.toBe(null)
        expect(sei).not.toBe(undefined)

        // contracts are not deployed
        const saSupport = sei?.features.find((feat) => feat.id === 'saSupport')
        expect(saSupport).not.toBe(null)
        expect(saSupport).not.toBe(undefined)
        expect(saSupport!.level).toBe('success')
        expect(saSupport!.title).toBe('Ambire Smart Accounts via ERC-4337 (Account Abstraction)')

        // somewhat simulation
        const simulation = sei?.features.find((feat) => feat.id === 'simulation')
        expect(simulation).not.toBe(null)
        expect(simulation).not.toBe(undefined)
        expect(simulation!.level).toBe('warning')

        // has token prices
        const prices = sei?.features.find((feat) => feat.id === 'prices')
        expect(prices).not.toBe(null)
        expect(prices).not.toBe(undefined)
        expect(prices!.level).toBe('success')

        networksController.updateNetwork({ areContractsDeployed: true }, 1329n)
      }

      // test to see if updateNetwork is working
      if (checks === 4) {
        const sei = networksController.networks.find((n) => n.chainId === 1329n)
        expect(sei?.areContractsDeployed).toBe(true)
        done()
      }
    })

    // TODO: errors
    // let errorEmits = 0
    // networksController.onError(() => {
    //   console.log(networksController.emittedErrors)
    //   if (errorEmits === 0) {
    //     const errors = networksController.emittedErrors
    //     expect(errors.length).toEqual(1)
    //     expect(errors[0].message).toEqual(
    //       'Failed to detect network, perhaps an RPC issue. Please change the RPC and try again'
    //     )
    //   }
    //   if (errorEmits === 1) {
    //     const errors = networksController.emittedErrors
    //     expect(errors.length).toEqual(2)
    //     expect(errors[1].message).toEqual(
    //       'Failed to detect network, perhaps an RPC issue. Please change the RPC and try again'
    //     )
    //   }
    //   errorEmits++
    //   if (errorEmits === 3) {
    //     done()
    //   }
    // })

    networksController.setNetworkToAddOrUpdate({
      rpcUrl: 'https://evm-rpc.sei-apis.com',
      chainId: 1329n
    })
  })

  test('should work in testnet mode', async () => {
    skipBeforeEach = true
    const storage = produceMemoryStore()
    const storageCtrl = new StorageController(storage)
    const testnetNetworksController = new NetworksController({
      defaultNetworksMode: 'testnet',
      storage: storageCtrl,
      fetch,
      relayerUrl,
      onAddOrUpdateNetworks: () => {},
      onRemoveNetwork: () => {}
    })

    await testnetNetworksController.initialLoadPromise
    expect(testnetNetworksController.networks.find((n) => n.chainId === 1n)).toBe(undefined)
    expect(testnetNetworksController.networks.find((n) => n.chainId === 11155111n)).not.toBe(
      undefined
    )
  })

  // TODO: Refactor Fantom test as well
  // test('should add the fantom network as a custom network', (done) => {
  //   let updateEmits = 0
  //   networksController.onUpdate(() => {
  //     if (updateEmits === 0) {
  //       updateEmits++
  //       return
  //     }

  //     if (updateEmits === 1) {
  //       updateEmits++
  //       const fantomNetwork = networksController.networks.find(({ id }) => id === 'fantom')
  //       expect(fantomNetwork).not.toBe(undefined)
  //       expect(fantomNetwork).not.toBe(null)
  //       expect(fantomNetwork?.chainId).toBe(250n)
  //       expect(fantomNetwork?.name).toBe('Fantom')
  //       expect(fantomNetwork?.nativeAssetSymbol).toBe('FTM')

  //       // fantom does not have the entry point
  //       expect(fantomNetwork?.erc4337?.enabled).toBe(false)
  //       expect(fantomNetwork?.erc4337?.hasPaymaster).toBe(false)

  //       // ...nor does it have the singleton
  //       expect(fantomNetwork?.isSAEnabled).toBe(true)

  //       // so contracts are not deployed
  //       expect(fantomNetwork?.areContractsDeployed).toBe(false)

  //       // it is 1559
  //       expect(fantomNetwork?.feeOptions.is1559).toBe(true)

  //       // it is not optimistic
  //       expect(fantomNetwork?.isOptimistic).toBe(false)

  //       // simulation is somewhat supported
  //       expect(fantomNetwork?.rpcNoStateOverride).toBe(false)

  //       // coingecko
  //       expect(fantomNetwork?.platformId).toBe('fantom')
  //       expect(fantomNetwork?.nativeAssetId).toBe('fantom')

  //       // contracts are not deployed
  //       const saSupport = fantomNetwork?.features.find((feat) => feat.id === 'saSupport')
  //       expect(saSupport).not.toBe(null)
  //       expect(saSupport).not.toBe(undefined)
  //       expect(saSupport!.level).toBe('warning')

  //       // no fee tokens
  //       const noFeeTokens = fantomNetwork?.features.find((feat) => feat.id === 'feeTokens')
  //       expect(noFeeTokens).not.toBe(null)
  //       expect(noFeeTokens).not.toBe(undefined)
  //       expect(noFeeTokens!.level).toBe('warning')

  //       // somewhat simulation
  //       const simulation = fantomNetwork?.features.find((feat) => feat.id === 'simulation')
  //       expect(simulation).not.toBe(null)
  //       expect(simulation).not.toBe(undefined)
  //       expect(simulation!.level).toBe('warning')
  //     }

  //     done()
  //   })

  //   networksController.addNetwork({
  //     name: 'Fantom',
  //     chainId: 250n,
  //     explorerUrl: 'https://ftmscan.com/',
  //     nativeAssetSymbol: 'FTM',
  //     rpcUrls: ['https://fantom-pokt.nodies.app']
  //   })
  // })
})

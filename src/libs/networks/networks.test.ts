/* eslint-disable @typescript-eslint/no-use-before-define */
/* eslint-disable @typescript-eslint/no-floating-promises */

import { describe, expect, test } from '@jest/globals'

import { networks as predefinedNetworks } from '../../consts/networks'
import { Network, NetworkInfo, RelayerNetwork } from '../../interfaces/network'
import { getFeaturesByNetworkProperties, getNetworksUpdatedWithRelayerNetworks } from './networks'

describe('Networks lib', () => {
  describe('Network features', () => {
    test('should check if valid messages for smart account support get shown depending on the network properties', async () => {
      const networkInfo: NetworkInfo = {
        chainId: 1n,
        isSAEnabled: false,
        hasSingleton: true,
        isOptimistic: false,
        rpcNoStateOverride: false,
        erc4337: { enabled: true, hasPaymaster: true },
        areContractsDeployed: true,
        feeOptions: { is1559: true },
        platformId: 'ethereum',
        nativeAssetId: 'ethereum',
        flagged: false
      }
      const results = getFeaturesByNetworkProperties(networkInfo, network)
      const saSupport = results.find((sup) => sup.id === 'saSupport')
      expect(saSupport?.msg).toBe(
        'We were unable to detect Smart Account support on the network with the provided RPC. Try choosing a different RPC.'
      )

      networkInfo.hasSingleton = false
      const results2 = getFeaturesByNetworkProperties(networkInfo, network)
      const saSupport2 = results2.find((sup) => sup.id === 'saSupport')
      expect(saSupport2?.msg).toBe(
        "Unfortunately, this network doesn't support Smart Accounts. It can be used only with EOA accounts."
      )
    })
  })
  describe('getNetworksUpdatedWithRelayerNetworks works', () => {
    it('Only predefined networks are stored and so all new relayer networks should be added', () => {
      const { mergedNetworks: result } = getNetworksUpdatedWithRelayerNetworks(
        networksObj,
        MOCK_RELAYER_NETWORKS
      )

      expect(result).toHaveProperty('2')
      expect(result['2'].chainId).toBe(2n)
      expect(result['2'].predefined).toBe(false)
      expect(result['2'].disabled).toBe(true)

      expect(result).toHaveProperty('3')
      expect(result['3'].chainId).toBe(3n)
      expect(result['3'].predefined).toBe(true)
      expect(result['3'].disabled).toBe(false)
    })
    describe('disabledByDefault works as expected', () => {
      it('If the network is not stored, it should be added as disabled', () => {
        const { mergedNetworks: result } = getNetworksUpdatedWithRelayerNetworks(
          networksObj,
          MOCK_RELAYER_NETWORKS
        )

        expect(result).toHaveProperty('2')
        expect(result['2'].disabled).toBe(true)
      })
      it('If the network is stored and enabled, it should remain enabled', () => {
        const relayerNetworksClone = structuredClone(MOCK_RELAYER_NETWORKS)
        relayerNetworksClone['1'].disabledByDefault = true
        const { mergedNetworks: result } = getNetworksUpdatedWithRelayerNetworks(
          networksObj,
          relayerNetworksClone
        )

        expect(result).toHaveProperty('1')
        expect(result['1'].disabled).toBeFalsy()
        expect(result['1'].predefinedConfigVersion).toBe(3)
      })
    })
    it('The stored network should be updated if predefinedConfigVersion is higher in the relayer network', () => {
      const { mergedNetworks: result1 } = getNetworksUpdatedWithRelayerNetworks(
        networksObj,
        MOCK_RELAYER_NETWORKS
      )

      expect(result1).toHaveProperty('1')
      expect(result1['1'].predefinedConfigVersion).toBe(3)
      expect(result1['1'].erc4337.defaultBundler).not.toBe('gelato')

      const relayerNetworksClone = structuredClone(MOCK_RELAYER_NETWORKS)
      relayerNetworksClone['1'].predefinedConfigVersion = 4
      relayerNetworksClone['1'].smartAccounts!.erc4337.defaultBundler = 'gelato'

      const { mergedNetworks: result2 } = getNetworksUpdatedWithRelayerNetworks(
        result1,
        relayerNetworksClone
      )

      expect(result2).toHaveProperty('1')
      expect(result2['1'].predefinedConfigVersion).toBe(4)
      expect(result2['1'].erc4337.defaultBundler).toBe('gelato')
      expect(result2['1'].disabled).toBeFalsy()
    })
    it('Even if predefinedConfigVersion is the same or lower, some properties of the stored network should be updated', () => {
      const { mergedNetworks: result1 } = getNetworksUpdatedWithRelayerNetworks(
        networksObj,
        MOCK_RELAYER_NETWORKS
      )

      expect(result1).toHaveProperty('1')
      expect(result1['1'].rpcUrls).toEqual(networksObj['1'].rpcUrls)
      expect(result1['1'].iconUrls).toEqual(['1', '2'])
      expect(result1['1'].predefined).toBe(true)
      expect(result1['1'].feeOptions.is1559).toBe(true)

      const relayerNetworksClone = structuredClone(MOCK_RELAYER_NETWORKS)
      relayerNetworksClone['1'].rpcUrls = ['https://new-rpc-url.com']
      relayerNetworksClone['1'].iconUrls = ['https://new-icon-url.com']
      // This property shouldn't be updated as predefinedConfigVersion is the same
      relayerNetworksClone['1'].feeOptions.is1559 = false

      const { mergedNetworks: result2 } = getNetworksUpdatedWithRelayerNetworks(
        result1,
        relayerNetworksClone
      )

      expect(result2).toHaveProperty('1')
      // Rpc urls are added to the existing ones
      expect(result2['1'].rpcUrls).toEqual([
        'https://new-rpc-url.com',
        'https://invictus.ambire.com/ethereum'
      ])
      // Icon urls are replaced
      expect(result2['1'].iconUrls).toEqual(['https://new-icon-url.com'])
      expect(result2['1'].predefined).toBe(true)
      // Fee options are not updated as predefinedConfigVersion is the same
      expect(result2['1'].feeOptions.is1559).toBe(true)
    })
    it("Unnecessary properties from the relayer network shouldn't be stored", () => {
      const { mergedNetworks: result } = getNetworksUpdatedWithRelayerNetworks(
        networksObj,
        MOCK_RELAYER_NETWORKS
      )
      const ethereum = result['1']

      expect(ethereum).not.toHaveProperty('disabledByDefault')
      expect(ethereum).not.toHaveProperty('smartAccounts')
      expect(ethereum).not.toHaveProperty('ambireId')
      expect(ethereum).toHaveProperty('predefinedConfigVersion', 3)
      expect(ethereum.chainId).toBe(1n)
    })
    it('If a predefined network is removed by the relayer, some of its properties should be updated', () => {
      const relayerNetworksClone = structuredClone(MOCK_RELAYER_NETWORKS)

      relayerNetworksClone['2'].predefinedConfigVersion = 1
      relayerNetworksClone['2'].disabledByDefault = false
      relayerNetworksClone['2'].smartAccounts!.hasRelayer = true

      const { mergedNetworks: result1 } = getNetworksUpdatedWithRelayerNetworks(
        networksObj,
        relayerNetworksClone
      )

      expect(result1).toHaveProperty('2')
      expect(result1['2'].predefined).toBe(true)
      expect(result1['2'].hasRelayer).toBe(true)

      delete relayerNetworksClone['2']

      const { mergedNetworks: result2 } = getNetworksUpdatedWithRelayerNetworks(
        result1,
        relayerNetworksClone
      )

      expect(result2).toHaveProperty('2')
      expect(result2['2'].predefined).toBe(false)
      expect(result2['2'].hasRelayer).toBe(false)
    })
    it('Disabled networks remain disabled despite updates from the relayer', () => {
      const { mergedNetworks: result1 } = getNetworksUpdatedWithRelayerNetworks(
        networksObj,
        MOCK_RELAYER_NETWORKS
      )

      expect(result1).toHaveProperty('2')
      expect(result1['2'].disabled).toBe(true)

      const relayerNetworksClone = structuredClone(MOCK_RELAYER_NETWORKS)

      relayerNetworksClone['2'].predefinedConfigVersion = 2
      relayerNetworksClone['2'].disabledByDefault = false

      const { mergedNetworks: result2 } = getNetworksUpdatedWithRelayerNetworks(
        result1,
        relayerNetworksClone
      )

      expect(result2).toHaveProperty('2')
      expect(result2['2'].disabled).toBe(true)
      expect(result2['2'].predefinedConfigVersion).toBe(2)
    })
    it('An empty relayer networks object should not change the stored networks', () => {
      const { mergedNetworks: result1 } = getNetworksUpdatedWithRelayerNetworks(networksObj, {})

      expect(result1).toEqual(networksObj)
    })
    it("Custom networks (ones that aren't passed by the relayer) should not be affected", () => {
      const customNetwork: Network = {
        ...network,
        chainId: 999n,
        name: 'Custom Network',
        rpcUrls: ['https://custom-rpc.com'],
        selectedRpcUrl: 'https://custom-rpc.com',
        predefined: false
      }

      const { mergedNetworks: result1 } = getNetworksUpdatedWithRelayerNetworks(
        { ...networksObj, '999': customNetwork },
        MOCK_RELAYER_NETWORKS
      )

      expect(result1).toHaveProperty('999')
      expect(result1['999'].chainId).toBe(999n)
      expect(result1['999'].name).toBe('Custom Network')
      expect(result1['999'].rpcUrls).toEqual(['https://custom-rpc.com'])
    })
    it('networksObj reference should not be modified', () => {
      expect(NEVER_MUTATE_NETWORKS_OBJ).toEqual(networksObj)
    })
  })
})

const network = {
  id: 'ethereum',
  name: 'Ethereum',
  nativeAssetSymbol: 'ETH',
  has7702: false,
  nativeAssetName: 'Ether',
  rpcUrls: ['https://invictus.ambire.com/ethereum'],
  selectedRpcUrl: 'https://invictus.ambire.com/ethereum',
  rpcNoStateOverride: false,
  chainId: 1n,
  explorerUrl: 'https://etherscan.io',
  erc4337: { enabled: false, hasPaymaster: true, hasBundlerSupport: true },
  isSAEnabled: true,
  areContractsDeployed: true,
  hasRelayer: true,
  platformId: 'ethereum',
  nativeAssetId: 'ethereum',
  hasSingleton: true,
  features: [],
  feeOptions: { is1559: true },
  predefined: true,
  wrappedAddr: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  disableEstimateGas: true
}

const networksObj = predefinedNetworks.reduce(
  (acc, n) => {
    acc[n.chainId.toString()] = network
    return acc
  },
  {} as {
    [key: string]: Network
  }
)

const mockRelayerNetworks = () => {
  const clonedNetworksObj = structuredClone(networksObj)
  const relayerNets: {
    [key: string]: RelayerNetwork
  } = {}

  const MOCK_NATIVE = {
    symbol: 'ETH',
    name: 'Ether',
    decimals: 18,
    wrapped: {
      address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      chainId: 1n,
      coingeckoId: 'ethereum',
      name: 'Wrapped Ether',
      symbol: 'WETH',
      decimals: 18,
      icon: ''
    },
    coingeckoId: 'ethereum',
    icon: ''
  } as RelayerNetwork['native']

  relayerNets['1'] = {
    ...clonedNetworksObj['1'],
    predefinedConfigVersion: 3,
    ambireId: 'mock-chain-id-1',
    native: MOCK_NATIVE,
    iconUrls: ['1', '2'],
    chainId: 1,
    smartAccounts: {
      hasRelayer: networksObj['1'].hasRelayer,
      erc4337: networksObj['1'].erc4337
    }
  } as RelayerNetwork

  relayerNets['2'] = {
    ...clonedNetworksObj['1'],
    predefinedConfigVersion: 1,
    disabledByDefault: true,
    ambireId: 'mock-chain-id-2',
    native: MOCK_NATIVE,
    iconUrls: ['1', '2'],
    chainId: 2,
    smartAccounts: {
      hasRelayer: networksObj['1'].hasRelayer,
      erc4337: networksObj['1'].erc4337
    }
  } as RelayerNetwork

  relayerNets['3'] = {
    ...clonedNetworksObj['1'],
    predefinedConfigVersion: 2,
    ambireId: 'mock-chain-id-3',
    native: MOCK_NATIVE,
    iconUrls: ['1', '2'],
    chainId: 3,
    isOptimistic: false
  } as RelayerNetwork

  return relayerNets
}

const MOCK_RELAYER_NETWORKS = mockRelayerNetworks()
const NEVER_MUTATE_NETWORKS_OBJ = structuredClone(networksObj)

import { Account, AccountId } from '../../interfaces/account'
import { Fetch } from '../../interfaces/fetch'
import { Network } from '../../interfaces/network'
import { RPCProvider } from '../../interfaces/provider'
import { getBaseAccount } from '../../libs/account/getBaseAccount'
import { getAssetValue } from '../../libs/defiPositions/helpers'
import { getAAVEPositions, getUniV3Positions } from '../../libs/defiPositions/providers'
import getAccountNetworksWithPositions from '../../libs/defiPositions/providers/helpers/networksWithPositions'
import {
  AccountState,
  DeFiPositionsError,
  DeFiPositionsState,
  NetworksWithPositionsByAccounts,
  PositionsByProvider,
  ProviderName
} from '../../libs/defiPositions/types'
import { AccountsController } from '../accounts/accounts'
import EventEmitter from '../eventEmitter/eventEmitter'
import { KeystoreController } from '../keystore/keystore'
import { NetworksController } from '../networks/networks'
import { ProvidersController } from '../providers/providers'
// eslint-disable-next-line import/no-cycle
import { SelectedAccountController } from '../selectedAccount/selectedAccount'
import { StorageController } from '../storage/storage'

const ONE_MINUTE = 60000
export class DefiPositionsController extends EventEmitter {
  #selectedAccount: SelectedAccountController

  #keystore: KeystoreController

  #accounts: AccountsController

  #networks: NetworksController

  #providers: ProvidersController

  #fetch: Fetch

  #storage: StorageController

  #state: DeFiPositionsState = {}

  #networksWithPositionsByAccounts: NetworksWithPositionsByAccounts = {}

  sessionIds: string[] = []

  constructor({
    fetch,
    storage,
    selectedAccount,
    keystore,
    accounts,
    networks,
    providers
  }: {
    fetch: Fetch
    storage: StorageController
    selectedAccount: SelectedAccountController
    keystore: KeystoreController
    accounts: AccountsController
    networks: NetworksController
    providers: ProvidersController
  }) {
    super()

    this.#fetch = fetch
    this.#storage = storage
    this.#selectedAccount = selectedAccount
    this.#keystore = keystore
    this.#accounts = accounts
    this.#networks = networks
    this.#providers = providers
  }

  #setProviderError(
    accountAddr: string,
    chainId: bigint,
    providerName: ProviderName,
    errorMessage: string
  ) {
    if (!this.#state[accountAddr][chainId.toString()].providerErrors) {
      this.#state[accountAddr][chainId.toString()].providerErrors = []
    }

    this.#state[accountAddr][chainId.toString()].providerErrors!.push({
      providerName,
      error: errorMessage
    })
  }

  #getShouldSkipUpdate(
    accountAddr: string,
    _maxDataAgeMs = ONE_MINUTE,
    forceUpdate: boolean = false
  ) {
    const hasKeys = this.#keystore.keys.some(({ addr }) =>
      this.#selectedAccount.account!.associatedKeys.includes(addr)
    )
    let maxDataAgeMs = _maxDataAgeMs

    // force update the positions if forceUpdate is passed,
    // the account has keys and a session with the DeFi tab is opened
    const shouldForceUpdatePositions = forceUpdate && this.sessionIds.length && hasKeys
    if (shouldForceUpdatePositions) maxDataAgeMs = 30000 // half a min

    let latestUpdatedAt: number | undefined

    const accountState = Object.values(this.#state[accountAddr])
    // eslint-disable-next-line no-restricted-syntax
    for (const network of accountState) {
      if (typeof network.updatedAt === 'number') {
        if (latestUpdatedAt === undefined || network.updatedAt > latestUpdatedAt) {
          latestUpdatedAt = network.updatedAt
        }
      }
    }

    if (!latestUpdatedAt) return false

    if (!forceUpdate && accountState.some((n) => n.providerErrors?.length || n.error)) {
      maxDataAgeMs = ONE_MINUTE
    }

    const isWithinMinUpdateInterval = Date.now() - latestUpdatedAt < maxDataAgeMs

    return isWithinMinUpdateInterval || accountState.some((n) => n.isLoading)
  }

  async #updateNetworksWithPositions(accountId: AccountId, accountState: AccountState) {
    const storageStateByAccount = await this.#storage.get('networksWithPositionsByAccounts', {})

    this.#networksWithPositionsByAccounts[accountId] = getAccountNetworksWithPositions(
      accountId,
      accountState,
      storageStateByAccount,
      this.#providers.providers
    )

    await this.#storage.set(
      'networksWithPositionsByAccounts',
      this.#networksWithPositionsByAccounts
    )
  }

  async updatePositions(opts?: {
    chainIds?: bigint[]
    maxDataAgeMs?: number
    forceUpdate?: boolean
  }) {
    const { chainIds, maxDataAgeMs, forceUpdate } = opts || {}
    const selectedAccount = this.#selectedAccount.account
    if (!selectedAccount) return

    const selectedAccountAddr = selectedAccount.addr
    const networksToUpdate = chainIds
      ? this.#networks.allNetworks.filter((n) => chainIds.includes(n.chainId))
      : this.#networks.allNetworks

    if (!this.#state[selectedAccountAddr]) {
      this.#state[selectedAccountAddr] = {}
    }

    const initNetworkState = (addr: string, chain: string) => {
      if (!this.#state[addr][chain]) {
        this.#state[addr][chain] = { isLoading: false, positionsByProvider: [], providerErrors: [] }
      }
    }

    const prepareNetworks = () => {
      // eslint-disable-next-line no-restricted-syntax
      for (const n of networksToUpdate) {
        const chain = n.chainId.toString()
        initNetworkState(selectedAccountAddr, chain)
      }
    }

    const lower = (s: string) => s.toLowerCase()

    /**
     * Fetches the defi positions of certain protocols using RPC calls and custom logic.
     * Cena is used for most of the positions, but some protocols require additional data
     * that is not available in Cena. This function fetches those positions on ENABLED
     * networks only.
     */
    const fetchCustomPositions = async (
      addr: string,
      provider: RPCProvider,
      network: Network,
      previous: PositionsByProvider[]
    ): Promise<PositionsByProvider[]> => {
      if (network.disabled) return []

      const [aave, uniV3] = await Promise.all([
        getAAVEPositions(addr, provider, network).catch((e: any) => {
          console.error('getAAVEPositions error:', e)
          this.#setProviderError(addr, network.chainId, 'AAVE v3', e?.message || 'Unknown error')
          return previous.find((p) => p.providerName === 'AAVE v3') || null
        }),
        getUniV3Positions(addr, provider, network).catch((e: any) => {
          console.error('getUniV3Positions error:', e)
          this.#setProviderError(addr, network.chainId, 'Uniswap V3', e?.message || 'Unknown error')
          return previous.find((p) => p.providerName === 'Uniswap V3') || null
        })
      ])

      return [aave, uniV3].filter(Boolean) as PositionsByProvider[]
    }

    const updateSingleNetwork = async (
      network: Network,
      debankPositionsByProvider: PositionsByProvider[]
    ) => {
      const chain = network.chainId.toString()
      initNetworkState(selectedAccountAddr, chain)

      const state = this.#state[selectedAccountAddr][chain]
      Object.assign(state, { isLoading: true, providerErrors: [], error: undefined })
      this.emitUpdate()

      const previousPositions = state.positionsByProvider
      let customPositions: PositionsByProvider[] = []

      try {
        customPositions = await fetchCustomPositions(
          selectedAccountAddr,
          this.#providers.providers[chain],
          network,
          previousPositions
        )

        if (customPositions.length) {
          let error: any
          try {
            customPositions =
              (await this.#updatePositionsByProviderAssetPrices(
                customPositions,
                network.chainId
              )) || customPositions
          } catch (e) {
            console.error(`#setAssetPrices error for ${selectedAccountAddr} on ${network.name}:`, e)
            error = DeFiPositionsError.AssetPriceError
          }

          const hasErrors = !!state.providerErrors?.length
          const filteredPrevious = previousPositions.filter(
            (prev) =>
              !customPositions.some((c) => lower(c.providerName) === lower(prev.providerName))
          )

          this.#state[selectedAccountAddr][chain] = {
            ...state,
            isLoading: false,
            positionsByProvider: [...filteredPrevious, ...customPositions],
            updatedAt: hasErrors ? state.updatedAt : Date.now(),
            error,
            nonceId: this.#getNonceId(selectedAccount, chain)
          }
        }
      } catch (e) {
        console.error(`updatePositions error on ${network.name}`, e)
        this.#state[selectedAccountAddr][chain] = {
          providerErrors: this.#state[selectedAccountAddr][chain].providerErrors || [],
          isLoading: false,
          positionsByProvider: previousPositions || [],
          error: DeFiPositionsError.CriticalError,
          nonceId: this.#getNonceId(selectedAccount, chain)
        }
      }

      const positionsByProvider = debankPositionsByProvider.filter(
        (p) => String(p.chainId) === String(network.chainId)
      )

      const positionMap = new Map(positionsByProvider.map((p) => [lower(p.providerName), p]))

      // eslint-disable-next-line no-restricted-syntax
      for (const custom of customPositions) {
        const key = lower(custom.providerName)

        if (custom.providerName === 'Uniswap V3') {
          const debankUni = positionMap.get(key)
          if (debankUni) {
            const merged = {
              ...debankUni,
              positions: debankUni.positions.map((pos) => {
                const match = custom.positions.find(
                  (p) => p.id === pos.additionalData.positionIndex
                )
                return match
                  ? {
                      ...pos,
                      additionalData: {
                        ...pos.additionalData,
                        inRange: match.additionalData.inRange
                      }
                    }
                  : pos
              })
            } as PositionsByProvider

            positionMap.set(key, merged)
            // eslint-disable-next-line no-continue
            continue
          }
        }

        positionMap.set(key, custom)
      }

      this.#state[selectedAccountAddr][chain] = {
        providerErrors: this.#state[selectedAccountAddr][chain].providerErrors || [],
        isLoading: false,
        positionsByProvider: Array.from(positionMap.values()),
        updatedAt: Date.now(),
        nonceId: this.#getNonceId(selectedAccount, chain)
      }
    }

    prepareNetworks()

    if (this.#getShouldSkipUpdate(selectedAccountAddr, maxDataAgeMs, forceUpdate)) {
      // Emit a single update to trigger a calculation in the selected account portfolio
      this.emitUpdate()
    }
    if (this.#getShouldSkipUpdateOnAccountWithNoDefiPositions(selectedAccount, forceUpdate)) {
      // Emit a single update to trigger a calculation in the selected account portfolio
      this.emitUpdate()
    }

    let debankPositions: PositionsByProvider[] = []

    // Skip Debank call in testing mode — only fetch custom DeFi positions
    if (process.env.IS_TESTING !== 'true') {
      try {
        const defiUrl = `https://cena.ambire.com/api/v3/defi/${selectedAccountAddr}`

        const hasKeys = this.#keystore.keys.some(({ addr }) =>
          this.#selectedAccount.account!.associatedKeys.includes(addr)
        )
        const shouldForceUpdatePositions = forceUpdate && this.sessionIds.length && hasKeys

        const resp = await this.#fetch(
          shouldForceUpdatePositions ? `${defiUrl}?update=true` : defiUrl
        )
        const body = await resp.json()
        if (resp.status !== 200 || body?.message || body?.error) throw body

        debankPositions = ((body.data as PositionsByProvider[]) || []).map((p) => ({
          ...p,
          chainId: BigInt(p.chainId)
        }))
      } catch (err) {
        console.error('Debank fetch failed:', err)
        // Proceed with empty debank positions
      }
    }

    await Promise.all(networksToUpdate.map((n) => updateSingleNetwork(n, debankPositions)))
    await this.#updateNetworksWithPositions(selectedAccountAddr, this.#state[selectedAccountAddr])

    this.emitUpdate()
  }

  async #updatePositionsByProviderAssetPrices(
    positionsByProvider: PositionsByProvider[],
    chainId: bigint
  ) {
    const platformId = this.#networks.allNetworks.find((n) => n.chainId === chainId)?.platformId

    // If we can't determine the Gecko platform ID, we shouldn't make a request to price (cena.ambire.com)
    // since it would return nothing.
    // This can happen when adding a custom network that doesn't have a CoinGecko platform ID.
    if (!platformId) return null

    const dedup = (x: any[]) => x.filter((y, i) => x.indexOf(y) === i)

    const addresses: string[] = []

    positionsByProvider.forEach((providerPos) => {
      providerPos.positions.forEach((p) => {
        p.assets.forEach((a) => {
          addresses.push(a.address)
        })
      })
    })

    const cenaUrl = `https://cena.ambire.com/api/v3/simple/token_price/${platformId}?contract_addresses=${dedup(
      addresses
    ).join('%2C')}&vs_currencies=usd`

    const resp = await this.#fetch(cenaUrl)
    const body = await resp.json()
    if (resp.status !== 200) throw body
    // eslint-disable-next-line no-prototype-builtins
    if (body.hasOwnProperty('message')) throw body
    // eslint-disable-next-line no-prototype-builtins
    if (body.hasOwnProperty('error')) throw body

    const positionsByProviderWithPrices = positionsByProvider.map((posByProvider) => {
      if (posByProvider.providerName.toLowerCase().includes('aave')) return posByProvider

      const updatedPositions = posByProvider.positions.map((position) => {
        let positionInUSD = position.additionalData.positionInUSD || 0

        const updatedAssets = position.assets.map((asset) => {
          const priceData = body[asset.address.toLowerCase()]
          if (!priceData) return asset

          const priceIn = Object.entries(priceData).map(([currency, price]) => ({
            baseCurrency: currency,
            price: price as number
          }))

          const value = getAssetValue(asset.amount, asset.decimals, priceIn) || 0

          positionInUSD += value

          return { ...asset, value, priceIn: priceIn[0] }
        })

        return {
          ...position,
          assets: updatedAssets,
          additionalData: { ...position.additionalData, positionInUSD }
        }
      })

      let positionInUSD = posByProvider.positionInUSD

      // Already set in the corresponding lib
      if (!positionInUSD) {
        positionInUSD = updatedPositions.reduce((prevPositionValue, position) => {
          return prevPositionValue + (position.additionalData.positionInUSD || 0)
        }, 0)
      }

      return { ...posByProvider, positions: updatedPositions, positionInUSD }
    })

    return positionsByProviderWithPrices
  }

  #getShouldSkipUpdateOnAccountWithNoDefiPositions(acc: Account, forceUpdate?: boolean) {
    if (forceUpdate) return false
    if (!this.#accounts.accountStates[acc.addr]) return false
    if (!this.#state[acc.addr]) return false
    // Don't skip if the account has any DeFi positions or the account has never been updated
    if (
      Object.values(this.#state[acc.addr]).some(
        (network) => network.positionsByProvider.length || !network.updatedAt
      )
    )
      return false
    const someNonceIdChanged = Object.keys(this.#accounts.accountStates[acc.addr]).some(
      (chainId: string) => {
        const posNonceId = this.#state[acc.addr][chainId]?.nonceId
        const nonceId = this.#getNonceId(acc, chainId)

        if (!nonceId || !posNonceId) return false

        return nonceId !== posNonceId
      }
    )

    // Return false (don’t skip) if any nonceId has changed
    return !someNonceIdChanged
  }

  #getNonceId(acc: Account, chainId: bigint | string) {
    if (!this.#accounts.accountStates) return undefined
    if (!this.#accounts.accountStates[acc.addr]) return undefined

    const networkState = this.#accounts.accountStates[acc.addr][chainId.toString()]
    if (!networkState) return undefined

    const network = this.#networks.allNetworks.find((net) => net.chainId === chainId)
    if (!network) return undefined

    const baseAcc = getBaseAccount(acc, networkState, this.#keystore.getAccountKeys(acc), network)
    return baseAcc.getNonceId()
  }

  removeNetworkData(chainId: bigint) {
    Object.keys(this.#state).forEach((accountId) => {
      delete this.#state[accountId][chainId.toString()]
    })
    this.emitUpdate()
  }

  getDefiPositionsStateForAllNetworks(accountAddr: string) {
    // return defi positions for enabled and disabled networks
    return this.#state[accountAddr] || {}
  }

  getDefiPositionsState(accountAddr: string) {
    // return defi positions only for enabled networks
    return Object.entries(this.#state[accountAddr] || {}).reduce((acc, [chainId, networkState]) => {
      if (this.#networks.networks.find((n) => n.chainId.toString() === chainId)) {
        acc[chainId] = networkState
      }
      return acc
    }, {} as AccountState)
  }

  getNetworksWithPositions(accountAddr: string) {
    return this.#networksWithPositionsByAccounts[accountAddr] || []
  }

  removeAccountData(accountAddr: string) {
    delete this.#state[accountAddr]
    delete this.#networksWithPositionsByAccounts[accountAddr]
    this.#storage.set('networksWithPositionsByAccounts', this.#networksWithPositionsByAccounts)

    this.emitUpdate()
  }

  addSession(sessionId: string) {
    this.sessionIds = [...new Set([...this.sessionIds, sessionId])]
    this.emitUpdate()
  }

  removeSession(sessionId: string) {
    this.sessionIds = this.sessionIds.filter((id) => id !== sessionId)
    this.emitUpdate()
  }

  toJSON() {
    return {
      ...this,
      ...super.toJSON()
    }
  }
}

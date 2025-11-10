/* eslint-disable import/no-cycle */
import { getAddress, isAddress } from 'ethers'

import {
  Account,
  AccountOnchainState,
  AccountPreferences,
  AccountStates
} from '../../interfaces/account'
import { getUniqueAccountsArray } from '../../libs/account/account'
import { getAccountState } from '../../libs/accountState/accountState'
import { getDappIdFromUrl } from '../../libs/dapps/helpers'
import EventEmitter, { Statuses } from '../eventEmitter/eventEmitter'
import { KeystoreController } from '../keystore/keystore'
import { NetworksController } from '../networks/networks'
import { ProvidersController } from '../providers/providers'
import { StorageController } from '../storage/storage'

const STATUS_WRAPPED_METHODS = {
  selectAccount: 'INITIAL',
  addAccounts: 'INITIAL'
} as const

export class AccountsController extends EventEmitter {
  #storage: StorageController

  #networks: NetworksController

  #providers: ProvidersController

  #keystore: KeystoreController

  accounts: Account[] = []

  accountStates: AccountStates = {}

  accountStatesLoadingState: {
    [chainId: string]: Promise<AccountOnchainState[]> | undefined
  } = {}

  statuses: Statuses<keyof typeof STATUS_WRAPPED_METHODS> = STATUS_WRAPPED_METHODS

  #onAddAccounts: (accounts: Account[]) => void

  #updateProviderIsWorking: (chainId: bigint, isWorking: boolean) => void

  #onAccountStateUpdate: () => void

  // Holds the initial load promise, so that one can wait until it completes
  initialLoadPromise: Promise<void>

  constructor(
    storage: StorageController,
    providers: ProvidersController,
    networks: NetworksController,
    keystore: KeystoreController,
    onAddAccounts: (accounts: Account[]) => void,
    updateProviderIsWorking: (chainId: bigint, isWorking: boolean) => void,
    onAccountStateUpdate: () => void
  ) {
    super()
    this.#storage = storage
    this.#providers = providers
    this.#networks = networks
    this.#keystore = keystore
    this.#onAddAccounts = onAddAccounts
    this.#updateProviderIsWorking = updateProviderIsWorking
    this.#onAccountStateUpdate = onAccountStateUpdate

    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this.initialLoadPromise = this.#load()
  }

  #getAccountsToUpdateAccountStatesInBackground(selectedAccountAddr?: string | null): Account[] {
    return this.accounts.filter((account) => {
      // Always update the selected account state in the background
      if (account.addr === selectedAccountAddr) return true

      const accountKeys = this.#keystore.getAccountKeys(account)
      const isViewOnly = accountKeys.length === 0
      // If the account is not selected, update the account state in the background
      // only if it's not view-only. We update the account state
      // in the background so EOAs can be used as a broadcast option.
      return !isViewOnly
    })
  }

  async #load() {
    await this.#networks.initialLoadPromise
    await this.#providers.initialLoadPromise
    const accounts = await this.#storage.get('accounts', [])
    const initialSelectedAccountAddr = await this.#storage.get('selectedAccount', null)
    this.accounts = getUniqueAccountsArray(accounts)

    // Emit an update before updating account states as the first state update may take some time
    this.emitUpdate()
    // Don't await this. Networks should update one by one
    // NOTE: YOU MUST USE waitForAccountsCtrlFirstLoad IN TESTS
    // TO ENSURE ACCOUNT STATE IS LOADED
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this.#updateAccountStates(
      this.#getAccountsToUpdateAccountStatesInBackground(initialSelectedAccountAddr)
    )
  }

  async updateAccountStates(
    selectedAccountAddr: string | undefined,
    blockTag: string | number = 'latest',
    networks: bigint[] = []
  ) {
    await this.initialLoadPromise

    await this.#updateAccountStates(
      this.#getAccountsToUpdateAccountStatesInBackground(selectedAccountAddr),
      blockTag,
      networks
    )
  }

  async updateAccountState(
    accountAddr: Account['addr'],
    blockTag: 'pending' | 'latest' = 'latest',
    networks: bigint[] = []
  ) {
    await this.initialLoadPromise

    const accountData = this.accounts.find((account) => account.addr === accountAddr)
    if (!accountData) return
    await this.#updateAccountStates([accountData], blockTag, networks)
  }

  async #updateAccountStates(
    accounts: Account[],
    blockTag: string | number = 'latest',
    updateOnlyNetworksWithIds: bigint[] = []
  ) {
    if (!accounts.length) return

    // if any, update the account state only for the passed networks; else - all
    const updateOnlyPassedNetworks = updateOnlyNetworksWithIds.length
    const networksToUpdate = this.#networks.networks.filter((network) => {
      if (!updateOnlyPassedNetworks) return true

      return updateOnlyNetworksWithIds.includes(network.chainId)
    })

    this.emitUpdate()

    await Promise.all(
      networksToUpdate.map(async (network) => {
        try {
          if (this.accountStatesLoadingState[network.chainId.toString()]) {
            await this.accountStatesLoadingState[network.chainId.toString()]

            return
          }

          this.accountStatesLoadingState[network.chainId.toString()] = getAccountState(
            this.#providers.providers[network.chainId.toString()],
            network,
            accounts,
            blockTag
          )
          const networkAccountStates = await this.accountStatesLoadingState[
            network.chainId.toString()
          ]!

          this.#updateProviderIsWorking(network.chainId, true)

          networkAccountStates.forEach((accountState) => {
            const addr = accountState.accountAddr
            if (!this.accountStates[addr]) this.accountStates[addr] = {}
            this.accountStates[addr][network.chainId.toString()] = accountState
          })
        } catch (err) {
          console.error(`account state update error for ${network.name}: `, err)
          this.#updateProviderIsWorking(network.chainId, false)
        } finally {
          this.accountStatesLoadingState[network.chainId.toString()] = undefined
        }
        this.emitUpdate()
      })
    )

    this.#onAccountStateUpdate()
  }

  async #addAccounts(accounts: Account[] = []) {
    if (!accounts.length) return
    // eslint-disable-next-line no-param-reassign
    accounts = accounts.map((a) => ({ ...a, addr: getAddress(a.addr) }))
    const alreadyAddedAddressSet = new Set(this.accounts.map((account) => account.addr))
    const newAccountsNotAddedYet = accounts.filter((acc) => !alreadyAddedAddressSet.has(acc.addr))
    const newAccountsAlreadyAdded = accounts.filter((acc) => alreadyAddedAddressSet.has(acc.addr))

    const nextAccounts = [
      ...this.accounts.map((acc) => ({
        ...acc,
        // reset the `newlyCreated` state for all already added accounts
        newlyCreated: false,
        // reset the `newlyAdded` state for all accounts added on prev sessions
        newlyAdded: false,
        // Merge the existing and new associated keys for the account (if the
        // account was already imported). This ensures up-to-date keys,
        // considering changes post-import (associated keys of the smart
        // accounts can change) or incomplete initial data (during the initial
        // import, not all associated keys could have been fetched (for privacy).
        associatedKeys: Array.from(
          new Set([
            ...acc.associatedKeys,
            ...(newAccountsAlreadyAdded.find((x) => x.addr === acc.addr)?.associatedKeys || [])
          ])
        )
      })),
      ...newAccountsNotAddedYet.map((a) => ({ ...a, newlyAdded: true }))
    ]

    this.accounts = getUniqueAccountsArray(nextAccounts)
    await this.#storage.set('accounts', this.accounts)

    this.#onAddAccounts(accounts)

    // update the state of new accounts. Otherwise, the user needs to restart his extension
    this.#updateAccountStates(newAccountsNotAddedYet)

    this.emitUpdate()
  }

  async addAccounts(accounts: Account[] = []) {
    await this.withStatus('addAccounts', async () => this.#addAccounts(accounts), true)
  }

  removeAccountData(address: Account['addr']) {
    this.accounts = this.accounts.filter((acc) => acc.addr !== address)

    delete this.accountStates[address]

    this.#storage.set('accounts', this.accounts)
    this.emitUpdate()
  }

  async updateAccountPreferences(accounts: { addr: string; preferences: AccountPreferences }[]) {
    this.accounts = this.accounts.map((acc) => {
      const account = accounts.find((a) => a.addr === acc.addr)
      if (!account) return acc
      if (isAddress(account.preferences.pfp)) {
        account.preferences.pfp = getAddress(account.preferences.pfp)
      }
      return { ...acc, preferences: account.preferences }
    })

    this.emitUpdate()
    await this.#storage.set('accounts', this.accounts)
  }

  async reorderAccounts({ fromIndex, toIndex }: { fromIndex: number; toIndex: number }) {
    if (
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= this.accounts.length ||
      toIndex >= this.accounts.length
    ) {
      return this.emitError({
        level: 'major',
        message: 'Failed to reorder accounts. Please reload the page and try again.',
        error: new Error('Failed to reorder accounts. Please reload the page and try again.')
      })
    }

    if (fromIndex === toIndex) return

    const updatedAccounts = [...this.accounts]
    const [movedAccount] = updatedAccounts.splice(fromIndex, 1)
    updatedAccounts.splice(toIndex, 0, movedAccount)

    this.accounts = getUniqueAccountsArray(updatedAccounts)

    this.emitUpdate()
    await this.#storage.set('accounts', this.accounts)
  }

  async setAssociatedDapps(addr: string, dappUrls: string[]) {
    let dappIDs = dappUrls.map((url) => getDappIdFromUrl(url))
    dappIDs = Array.from(new Set(dappIDs))
    this.accounts = this.accounts.map((acc) => {
      if (acc.addr !== addr) return acc
      return { ...acc, associatedDappIDs: dappIDs }
    })

    this.emitUpdate()
    await this.#storage.set('accounts', this.accounts)
  }

  get areAccountStatesLoading() {
    return Object.values(this.accountStatesLoadingState).some((isLoading) => isLoading)
  }

  // Get the account states or in the rare case of it being undefined,
  // fetch it.
  // This is a precaution method as we had bugs in the past where we assumed
  // the account state to be fetched only for it to haven't been.
  // This ensures production doesn't blow up and it 99.9% of cases it
  // should not call the promise
  async getOrFetchAccountStates(addr: string): Promise<{ [chainId: string]: AccountOnchainState }> {
    if (!this.accountStates[addr]) await this.updateAccountState(addr, 'latest')
    return this.accountStates[addr]
  }

  // Get the account state or in the rare case of it being undefined,
  // fetch it.
  // This is a precaution method as we had bugs in the past where we assumed
  // the account state to be fetched only for it to haven't been.
  // This ensures production doesn't blow up and it 99.9% of cases it
  // should not call the promise
  async getOrFetchAccountOnChainState(addr: string, chainId: bigint): Promise<AccountOnchainState> {
    if (!this.accountStates[addr]?.[chainId.toString()]) {
      await this.updateAccountState(addr, 'latest', [chainId])
    }

    return this.accountStates[addr][chainId.toString()]
  }

  resetAccountsNewlyAddedState() {
    this.accounts = this.accounts.map((a) => ({ ...a, newlyAdded: false }))
    this.emitUpdate()
  }

  async forceFetchPendingState(addr: string, chainId: bigint): Promise<AccountOnchainState> {
    await this.updateAccountState(addr, 'pending', [chainId])
    return this.accountStates[addr][chainId.toString()]
  }

  toJSON() {
    return {
      ...this,
      ...super.toJSON(),
      areAccountStatesLoading: this.areAccountStatesLoading
    }
  }
}

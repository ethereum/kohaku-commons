/* eslint-disable no-restricted-syntax */
import { DEFAULT_ACCOUNT_LABEL } from '../../consts/account'
import { BIP44_STANDARD_DERIVATION_TEMPLATE } from '../../consts/derivation'
import { StoredKey } from '../../interfaces/keystore'
import { CashbackStatus } from '../../interfaces/selectedAccount'
// eslint-disable-next-line import/no-cycle
import { Storage, StorageProps } from '../../interfaces/storage'
import { getUniqueAccountsArray } from '../../libs/account/account'
import { KeyIterator } from '../../libs/keyIterator/keyIterator'
import { LegacyTokenPreference } from '../../libs/portfolio/customToken'
import {
  getShouldMigrateKeystoreSeedsWithoutHdPath,
  migrateCustomTokens,
  migrateHiddenTokens,
  migrateNetworkPreferencesToNetworks
} from '../../libs/storage/storage'
// eslint-disable-next-line import/no-cycle
import { AccountPickerController } from '../accountPicker/accountPicker'
import EventEmitter, { Statuses } from '../eventEmitter/eventEmitter'
// eslint-disable-next-line import/no-cycle
import { KeystoreController } from '../keystore/keystore'

const STATUS_WRAPPED_METHODS = {
  associateAccountKeysWithLegacySavedSeedMigration: 'INITIAL'
} as const

export class StorageController extends EventEmitter {
  #storage: Storage

  // Holds the initial load promise, so that one can wait until it completes
  #storageMigrationsPromise: Promise<void>

  #storageUpdateQueue: Promise<void> = Promise.resolve()

  #associateAccountKeysWithLegacySavedSeedMigrationPassed: boolean = false

  statuses: Statuses<keyof typeof STATUS_WRAPPED_METHODS> = STATUS_WRAPPED_METHODS

  constructor(storage: Storage) {
    super()

    this.#storage = storage
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this.#storageMigrationsPromise = this.#loadMigrations()
  }

  async #loadMigrations() {
    try {
      // IMPORTANT: should be ordered by versions
      await this.#migrateNetworkPreferencesToNetworks() // As of version 4.24.0
      await this.#migrateAccountPreferencesToAccounts() // As of version 4.25.0
      await this.#migrateKeystoreSeedsWithoutHdPathTemplate() // As of version v4.33.0
      await this.#migrateKeyPreferencesToKeystoreKeys() // As of version v4.33.0
      await this.#migrateKeyMetaNullToKeyMetaCreatedAt() // As of version v4.33.0
      await this.#clearHumanizerMetaObjectFromStorage() // As of version v4.34.0
      await this.#migrateTokenPreferences() // As of version 4.51.0
      await this.#migrateCashbackStatusToNewFormat() // As of version 4.53.0
      await this.#removeIsDefaultWalletStorageIfExist() // As of version 4.57.0
      await this.#removeOnboardingStateStorageIfExist() // As of version 4.59.0
      await this.#migrateNetworkIdToChainId()
    } catch (error) {
      console.error('Storage migration error: ', error)
    }
  }

  // As of version 4.24.0, a new Network interface has been introduced,
  // that replaces the old NetworkDescriptor, NetworkPreference, and CustomNetwork.
  // Previously, only NetworkPreferences were stored, with other network properties
  // being calculated in a getter each time the networks were needed.
  // Now, all network properties are pre-calculated and stored in a structured format: { [key: NetworkId]: Network } in the storage.
  // This function migrates the data from the old NetworkPreferences to the new structure
  // to ensure compatibility and prevent breaking the extension after updating to v4.24.0
  async #migrateNetworkPreferencesToNetworks() {
    const [passedMigrations, networks, networkPreferences] = await Promise.all([
      this.#storage.get('passedMigrations', []),
      this.#storage.get('networks', {}),
      this.#storage.get('networkPreferences')
    ])

    if (passedMigrations.includes('migrateNetworkPreferencesToNetworks')) return

    const storageUpdates = [
      this.#storage.set('passedMigrations', [
        ...new Set([...passedMigrations, 'migrateNetworkPreferencesToNetworks'])
      ])
    ]

    if (!Object.keys(networks).length && networkPreferences) {
      const migratedNetworks = await migrateNetworkPreferencesToNetworks(networkPreferences)

      storageUpdates.push(this.#storage.set('networks', migratedNetworks))
      storageUpdates.push(this.#storage.remove('networkPreferences'))
    }

    await Promise.all(storageUpdates)
  }

  // As of version 4.25.0, a new Account interface has been introduced,
  // merging the previously separate Account and AccountPreferences interfaces.
  // This change requires a migration due to the introduction of a new controller, AccountsController,
  // which now manages both accounts and their preferences.
  async #migrateAccountPreferencesToAccounts() {
    const [passedMigrations, accounts, accountPreferences] = await Promise.all([
      this.#storage.get('passedMigrations', []),
      this.#storage.get('accounts', []),
      this.#storage.get('accountPreferences')
    ])

    if (passedMigrations.includes('migrateAccountPreferencesToAccounts')) return

    const storageUpdates = [
      this.#storage.set('passedMigrations', [
        ...new Set([...passedMigrations, 'migrateAccountPreferencesToAccounts'])
      ])
    ]
    if (accountPreferences) {
      const migratedAccounts = getUniqueAccountsArray(
        accounts.map((a: any) => {
          return {
            ...a,
            // @ts-ignore
            preferences: this.#storage.accountPreferences[a.addr] || {
              label: DEFAULT_ACCOUNT_LABEL,
              pfp: a.addr
            }
          }
        })
      )
      storageUpdates.push(this.#storage.set('accounts', migratedAccounts))
      storageUpdates.push(this.#storage.remove('accountPreferences'))
    }

    await Promise.all(storageUpdates)
  }

  // As of version v4.33.0, user can change the HD path when importing a seed.
  // Migration is needed because previously the HD path was not stored,
  // and the default used was `BIP44_STANDARD_DERIVATION_TEMPLATE`.
  async #migrateKeystoreSeedsWithoutHdPathTemplate() {
    const [passedMigrations, keystoreSeeds] = await Promise.all([
      this.#storage.get('passedMigrations', []),
      this.#storage.get('keystoreSeeds', [])
    ])

    if (passedMigrations.includes('migrateKeystoreSeedsWithoutHdPathTemplate')) return

    const storageUpdates = [
      this.#storage.set('passedMigrations', [
        ...new Set([...passedMigrations, 'migrateKeystoreSeedsWithoutHdPathTemplate'])
      ])
    ]

    if (getShouldMigrateKeystoreSeedsWithoutHdPath(keystoreSeeds)) {
      const migratedKeystoreSeeds = keystoreSeeds.map((seed) => ({
        seed,
        hdPathTemplate: BIP44_STANDARD_DERIVATION_TEMPLATE
      }))

      storageUpdates.push(this.#storage.set('keystoreSeeds', migratedKeystoreSeeds))
    }

    await Promise.all(storageUpdates)
  }

  // As of version 4.33.0, we no longer store the key preferences in a separate object called keyPreferences in the storage.
  // Migration is needed because each preference (like key label)
  // is now part of the Key interface and managed by the KeystoreController.
  async #migrateKeyPreferencesToKeystoreKeys() {
    const [passedMigrations, keyPreferences, keystoreKeys] = await Promise.all([
      this.#storage.get('passedMigrations', []),
      this.#storage.get('keyPreferences', []),
      this.#storage.get('keystoreKeys', [])
    ])

    if (passedMigrations.includes('migrateKeyPreferencesToKeystoreKeys')) return

    const storageUpdates = [
      this.#storage.set('passedMigrations', [
        ...new Set([...passedMigrations, 'migrateKeyPreferencesToKeystoreKeys'])
      ])
    ]
    const shouldMigrateKeyPreferencesToKeystoreKeys = keyPreferences.length > 0

    if (shouldMigrateKeyPreferencesToKeystoreKeys) {
      const migratedKeystoreKeys = keystoreKeys.map((key) => {
        if (key.label) return key

        const keyPref = keyPreferences.find((k) => k.addr === key.addr && k.type === key.type)

        if (keyPref) return { ...key, label: keyPref.label }

        return key
      })

      storageUpdates.push(this.#storage.set('keystoreKeys', migratedKeystoreKeys))
      storageUpdates.push(this.#storage.remove('keyPreferences'))
    }

    await Promise.all(storageUpdates)
  }

  // As of version 4.33.0, we introduced createdAt prop to the Key interface to help with sorting and add more details for the Keys.
  async #migrateKeyMetaNullToKeyMetaCreatedAt() {
    const [passedMigrations, keystoreKeys] = await Promise.all([
      this.#storage.get('passedMigrations', []),
      this.#storage.get('keystoreKeys', [])
    ])

    if (passedMigrations.includes('migrateKeyMetaNullToKeyMetaCreatedAt')) return

    const migratedKeystoreKeys = keystoreKeys.map((key) => {
      if (!key.meta) return { ...key, meta: { createdAt: null } } as StoredKey
      if (!key.meta.createdAt)
        return { ...key, meta: { ...key.meta, createdAt: null } } as StoredKey

      return key
    })
    await Promise.all([
      this.#storage.set('passedMigrations', [
        ...new Set([...passedMigrations, 'migrateKeyMetaNullToKeyMetaCreatedAt'])
      ]),
      this.#storage.set('keystoreKeys', migratedKeystoreKeys)
    ])
  }

  // As of version v4.34.0 HumanizerMetaV2 in storage is no longer needed. It was
  // used for persisting learnt data from async operations, triggered by the
  // humanization process.
  async #clearHumanizerMetaObjectFromStorage() {
    await this.#storage.remove('HumanizerMetaV2')
  }

  // As of version 4.53.0, cashback status information has been introduced.
  // Previously, cashback statuses were stored as separate objects per account.
  // Now, they are normalized under a single structure for simplifying.
  // Migration is needed to transform existing data into the new format.
  async #migrateCashbackStatusToNewFormat() {
    const [passedMigrations, cashbackStatusByAccount] = await Promise.all([
      this.#storage.get('passedMigrations', []),
      this.#storage.get('cashbackStatusByAccount', {})
    ])

    if (passedMigrations.includes('migrateCashbackStatusToNewFormat')) return

    const migratedCashbackStatusByAccount = Object.fromEntries(
      Object.entries(cashbackStatusByAccount).map(([accountId, status]) => {
        if (typeof status === 'string') {
          return [accountId, status as CashbackStatus]
        }

        if (typeof status === 'object' && status !== null) {
          const { cashbackWasZeroAt, firstCashbackReceivedAt, firstCashbackSeenAt } = status

          if (
            cashbackWasZeroAt &&
            firstCashbackReceivedAt === null &&
            firstCashbackSeenAt === null
          ) {
            return [accountId, 'no-cashback']
          }

          if (
            cashbackWasZeroAt === null &&
            firstCashbackReceivedAt &&
            firstCashbackSeenAt === null
          ) {
            return [accountId, 'unseen-cashback']
          }

          if (cashbackWasZeroAt === null && firstCashbackReceivedAt && firstCashbackSeenAt) {
            return [accountId, 'seen-cashback']
          }
        }

        return [accountId, 'seen-cashback']
      })
    )
    await Promise.all([
      this.#storage.set('passedMigrations', [
        ...new Set([...passedMigrations, 'migrateCashbackStatusToNewFormat'])
      ]),
      this.#storage.set('cashbackStatusByAccount', migratedCashbackStatusByAccount)
    ])
  }

  // As of version 4.51.0, migrate legacy token preferences to token preferences and custom tokens
  async #migrateTokenPreferences() {
    const [passedMigrations, tokenPreferences] = await Promise.all([
      this.#storage.get('passedMigrations', []),
      this.#storage.get('tokenPreferences', [])
    ])

    if (passedMigrations.includes('migrateTokenPreferences')) return

    const storageUpdates = [
      this.#storage.set('passedMigrations', [
        ...new Set([...passedMigrations, 'migrateTokenPreferences'])
      ])
    ]

    if (
      (tokenPreferences as LegacyTokenPreference[]).some(
        ({ symbol, decimals }) => !!symbol || !!decimals
      )
    ) {
      storageUpdates.push(
        this.#storage.set(
          'tokenPreferences',
          migrateHiddenTokens(tokenPreferences as LegacyTokenPreference[])
        )
      )
      storageUpdates.push(
        this.#storage.set(
          'customTokens',
          migrateCustomTokens(tokenPreferences as LegacyTokenPreference[])
        )
      )
    }
    await Promise.all(storageUpdates)
  }

  async #migrateNetworkIdToChainId() {
    const [
      passedMigrations,
      networks,
      previousHints,
      customTokens,
      tokenPreferences,
      networksWithAssetsByAccount,
      networksWithPositionsByAccounts,
      accountsOps,
      signedMessages
    ] = await Promise.all([
      this.#storage.get('passedMigrations', []),
      this.#storage.get('networks', {}),
      this.#storage.get('previousHints', []),
      this.#storage.get('customTokens', []),
      this.#storage.get('tokenPreferences', []),
      this.#storage.get('networksWithAssetsByAccount', {}),
      this.#storage.get('networksWithPositionsByAccounts', {}),
      this.#storage.get('accountsOps', {}),
      this.#storage.get('signedMessages', {})
    ])

    if (passedMigrations.includes('migrateNetworkIdToChainId')) return

    if (!Object.keys(networks).length) {
      await this.#storage.set('passedMigrations', [
        ...new Set([...passedMigrations, 'migrateNetworkIdToChainId'])
      ])

      return
    }

    const networkIdToChainId = Object.fromEntries(
      Object.values(networks).map(({ id, chainId }: any) => [id, chainId as bigint])
    )

    const migrateKeys = <T>(obj: Record<string, T>) =>
      Object.fromEntries(
        Object.entries(obj).map(([networkId, value]) => [networkIdToChainId[networkId], value])
      )

    const migratedPreviousHints = {
      learnedTokens: migrateKeys(previousHints.learnedTokens || {}),
      learnedNfts: migrateKeys(previousHints.learnedNfts || {}),
      fromExternalAPI: Object.fromEntries(
        Object.entries(previousHints.fromExternalAPI || {}).map(([networkAndAccountKey, value]) => {
          const [networkId, accountAddr] = networkAndAccountKey.split(':')
          const chainId = networkIdToChainId[networkId]
          return chainId ? [`${chainId}:${accountAddr}`, value] : [networkAndAccountKey, value]
        })
      )
    }

    const migratedCustomTokens = customTokens.map(({ networkId, ...rest }: any) => ({
      ...rest,
      chainId: networkIdToChainId[networkId]
    }))

    const migratedTokenPreferences: { address: string; chainId: string; isHidden?: boolean }[] =
      tokenPreferences.map(({ networkId, ...rest }: any) => ({
        ...rest,
        chainId: networkIdToChainId[networkId]
      }))

    const migratedNetworksWithAssetsByAccount = Object.fromEntries(
      Object.entries(networksWithAssetsByAccount).map(([accountId, assetsState]) => [
        accountId,
        migrateKeys(assetsState)
      ])
    )

    const migratedNetworksWithPositionsByAccounts = Object.fromEntries(
      Object.entries(networksWithPositionsByAccounts).map(([accountId, networksWithPositions]) => [
        accountId,
        migrateKeys(networksWithPositions)
      ])
    )

    const migratedAccountsOps = Object.fromEntries(
      Object.entries(accountsOps).map(([accountId, opsByNetwork]) => [
        accountId,
        Object.fromEntries(
          Object.entries(opsByNetwork).map(([networkId, ops]) => {
            const chainId = networkIdToChainId[networkId]
            return [
              chainId,
              // eslint-disable-next-line @typescript-eslint/no-shadow
              ops.map(({ networkId, ...rest }: any) => ({
                ...rest,
                chainId // Migrate networkId inside SubmittedAccountOp
              }))
            ]
          })
        )
      ])
    )

    const migratedSignedMessages = Object.fromEntries(
      Object.entries(signedMessages).map(([accountId, messages]) => [
        accountId,
        messages.map(({ networkId, ...rest }: any) => ({
          ...rest,
          chainId: networkIdToChainId[networkId] // Migrate networkId inside SignedMessage
        }))
      ])
    )

    const migratedNetworks = Object.fromEntries(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      Object.entries(networks).map(([_, { id, ...rest }]: any) => [rest.chainId.toString(), rest])
    )

    await Promise.all([
      this.#storage.set('passedMigrations', [
        ...new Set([...passedMigrations, 'migrateNetworkIdToChainId'])
      ]),
      this.#storage.set('networks', migratedNetworks),
      this.#storage.set('previousHints', migratedPreviousHints),
      this.#storage.set('customTokens', migratedCustomTokens),
      this.#storage.set('tokenPreferences', migratedTokenPreferences),
      this.#storage.set('networksWithAssetsByAccount', migratedNetworksWithAssetsByAccount),
      this.#storage.set('networksWithPositionsByAccounts', migratedNetworksWithPositionsByAccounts),
      this.#storage.set('accountsOps', migratedAccountsOps),
      this.#storage.set('signedMessages', migratedSignedMessages)
    ])
  }

  // As of version 4.57.0, we the Ambire wallet is always the default wallet, so we no longer need 'isDefaultWallet' in the storage.
  async #removeIsDefaultWalletStorageIfExist() {
    const isDefaultWalletStorageSet = await this.#storage.get('isDefaultWallet', undefined)

    if (isDefaultWalletStorageSet !== undefined) {
      await this.#storage.remove('isDefaultWallet')
    }
  }

  // As of version 4.59.0. the onboarding flow (stories) has been removed, we no longer need 'onboardingState' in the storage.
  async #removeOnboardingStateStorageIfExist() {
    const isOnboardingStateExists = await this.#storage.get('onboardingState', undefined)

    if (isOnboardingStateExists !== undefined) {
      await this.#storage.remove('onboardingState')
    }
  }

  async get<K extends keyof StorageProps | string | undefined>(
    key: K,
    defaultValue?: any
  ): Promise<K extends keyof StorageProps ? StorageProps[K] : any> {
    await this.#storageMigrationsPromise
    await this.#storageUpdateQueue

    return this.#storage.get(key, defaultValue)
  }

  async set(key: string, value: any) {
    await this.#storageMigrationsPromise
    this.#storageUpdateQueue = this.#storageUpdateQueue.then(async () => {
      try {
        await this.#storage.set(key, value)
      } catch (err) {
        console.error(`Failed to set storage key "${key}":`, err)
      }
    })
    await this.#storageUpdateQueue
  }

  async remove(key: string) {
    await this.#storageMigrationsPromise
    this.#storageUpdateQueue = this.#storageUpdateQueue.then(async () => {
      try {
        await this.#storage.remove(key)
      } catch (err) {
        console.error(`Failed to remove storage key "${key}":`, err)
      }
    })
    await this.#storageUpdateQueue
  }

  // As of version 5.1.2, migrate account keys to be associated with the legacy saved seed
  async #associateAccountKeysWithLegacySavedSeedMigration(
    accountPicker: AccountPickerController,
    keystore: KeystoreController,
    onSuccess: () => Promise<void>
  ) {
    if (this.#associateAccountKeysWithLegacySavedSeedMigrationPassed) return

    const [passedMigrations, keystoreSeeds, keystoreKeys] = await Promise.all([
      this.#storage.get('passedMigrations', []),
      this.#storage.get('keystoreSeeds', []),
      this.#storage.get('keystoreKeys', [])
    ])

    if (passedMigrations.includes('associateAccountKeysWithLegacySavedSeedMigration')) return

    const savedSeed = keystoreSeeds.find((s) => !s.id || s.id === 'legacy-saved-seed')

    if (!savedSeed) {
      this.#associateAccountKeysWithLegacySavedSeedMigrationPassed = true
      return
    }

    const keystoreSavedSeed = await keystore.getSavedSeed('legacy-saved-seed')

    const keyIterator = new KeyIterator(keystoreSavedSeed.seed, keystoreSavedSeed.seedPassphrase)
    await accountPicker.setInitParams({
      keyIterator,
      hdPathTemplate: keystoreSavedSeed.hdPathTemplate,
      pageSize: 10,
      shouldAddNextAccountAutomatically: false,
      shouldGetAccountsUsedOnNetworks: false,
      shouldSearchForLinkedAccounts: true
    })
    await accountPicker.init()
    const makeKeyMapId = (k: { addr: string; type: string }) => `${k.addr}:${k.type}`

    // Keep all keys, keyed by composite key
    const updatedKeyMap = new Map(keystoreKeys.map((k) => [makeKeyMapId(k), { ...k }]))

    let page = 1
    while (page <= 10) {
      // eslint-disable-next-line no-await-in-loop
      await accountPicker.setPage({ page })
      // eslint-disable-next-line no-await-in-loop
      await accountPicker.findAndSetLinkedAccountsPromise

      const matchingAddresses = accountPicker.allKeysOnPage.filter((k) =>
        updatedKeyMap.has(`${k}:internal`)
      )

      if (matchingAddresses.length === 0) break

      for (const addr of matchingAddresses) {
        // Only modify keys with type === 'internal' and matching addr
        const matchingInternalKeys = keystoreKeys.filter(
          (k) => k.addr === addr && k.type === 'internal'
        )

        for (const key of matchingInternalKeys) {
          const compositeKey = makeKeyMapId(key)
          const storedKey = updatedKeyMap.get(compositeKey)
          if (storedKey) {
            storedKey.meta = { ...storedKey.meta, fromSeedId: keystoreSavedSeed.id }
            updatedKeyMap.set(compositeKey, storedKey)
          }
        }
      }

      page++
    }

    await accountPicker.reset()

    const updatedKeystoreKeys = Array.from(updatedKeyMap.values())

    const storageUpdates = [
      this.#storage.set('passedMigrations', [
        ...new Set([...passedMigrations, 'associateAccountKeysWithLegacySavedSeedMigration'])
      ]),
      this.#storage.set('keystoreKeys', updatedKeystoreKeys)
    ]

    await Promise.all(storageUpdates)
    this.#associateAccountKeysWithLegacySavedSeedMigrationPassed = true
    await onSuccess()
  }

  async associateAccountKeysWithLegacySavedSeedMigration(
    accountPicker: AccountPickerController,
    keystore: KeystoreController,
    onSuccess: () => Promise<void>
  ) {
    await this.withStatus(
      'associateAccountKeysWithLegacySavedSeedMigration',
      () =>
        this.#associateAccountKeysWithLegacySavedSeedMigration(accountPicker, keystore, onSuccess),
      true
    )
  }

  toJSON() {
    return {
      ...this,
      ...super.toJSON()
    }
  }
}

import { Hex } from './hex'
import { Network } from './network'

export type AccountId = string

export type AccountPreferences = {
  label: string
  pfp: string // profile picture - acc address as default value to display a unique jazz icon
}

export interface Account {
  addr: AccountId
  // Associated keys that can control the account
  // For EOAs this must be set to [account.addr]
  associatedKeys: string[]
  initialPrivileges: [string, string][]
  // Creation data; `null` in case of an EOA
  creation: AccountCreation | null
  preferences: AccountPreferences
  // Associated dapp URLs for which the account will
  // be suggested by default
  associatedDapps: string[]
  email?: string
  newlyCreated?: boolean
  newlyAdded?: boolean
  disable7702Popup?: boolean
  disable7702Banner?: boolean
}

export interface AccountCreation {
  factoryAddr: string
  bytecode: string
  salt: string
  // baseIdentityAddr is intentionally omitted because it's not used anywhere
  // and because it can be retrieved from the bytecode
}

export interface AccountOnchainState {
  accountAddr: string
  isDeployed: boolean
  eoaNonce: bigint | null
  nonce: bigint
  erc4337Nonce: bigint
  associatedKeys: { [key: string]: string }
  deployError: boolean
  balance: bigint
  isEOA: boolean
  isErc4337Enabled: boolean
  isErc4337Nonce: boolean
  isV2: boolean
  currentBlock: bigint
  isSmarterEoa: boolean
  delegatedContract: Hex | null
  delegatedContractName: 'AMBIRE' | 'METAMASK' | 'UNKNOWN' | null
}

export type AccountStates = {
  [accountId: string]: {
    [chainId: string]: AccountOnchainState
  }
}

type AccountDerivationMeta = {
  slot: number // the iteration on which the account is derived, starting from 1
  index: number // the derivation index of the <account> in the slot, starting from 0
  isLinked: boolean // linked accounts are also smart accounts, so use a flag to differentiate
}

export type AccountWithNetworkMeta = Account & { usedOnNetworks: Network[] }

/**
 * The account that is derived programmatically and internally by Ambire.
 * Could be either a basic (EOA) account, a derived with custom derivation
 * basic (EOA) account (used for smart account key only) or a smart account.
 */
export type DerivedAccount = AccountDerivationMeta & { account: AccountWithNetworkMeta }
// Sub-type, used during intermediate step during the deriving accounts process
export type DerivedAccountWithoutNetworkMeta = Omit<DerivedAccount, 'account'> & {
  account: Account
}

/**
 * Enum for tracking the import status of an account during the import process.
 */
export enum ImportStatus {
  NotImported = 'not-imported',
  ImportedWithoutKey = 'imported-without-key', // as a view only account
  ImportedWithSomeOfTheKeys = 'imported-with-some-of-the-keys', // imported with
  // some of the keys (having the same key type), but not all found on the current page
  ImportedWithTheSameKeys = 'imported-with-the-same-keys', // imported with all
  // keys (having the same key type) found on the current page
  ImportedWithDifferentKeys = 'imported-with-different-keys' // different key
  // meaning that could be a key with the same address but different type,
  // or a key with different address altogether.
}

/**
 * All the accounts that should be visible on the current page - the Basic
 * Accounts, Smart Accounts and the linked accounts. Excludes the derived
 * EOA (basic) accounts used for smart account keys only.
 */
export type AccountOnPage = DerivedAccount & { importStatus: ImportStatus }

/**
 * The account that the user has actively chosen (selected) via the app UI.
 * It's always one of the visible accounts returned by the accountsOnPage().
 * Could be either a basic (EOA) account, a smart account or a linked account.
 */
export type SelectedAccountForImport = {
  account: Account
  isLinked: AccountDerivationMeta['isLinked']
  accountKeys: (Omit<AccountDerivationMeta, 'isLinked'> & { addr: Account['addr'] })[]
}

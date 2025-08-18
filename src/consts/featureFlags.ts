export interface FeatureFlags {
  withTransactionManagerController: boolean
  withEmailVaultController: boolean
  testnetMode: boolean
}

export const defaultFeatureFlags: FeatureFlags = {
  withTransactionManagerController: false,
  withEmailVaultController: true,
  testnetMode: false
}

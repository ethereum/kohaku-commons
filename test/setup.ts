// Mock getRpcProvider to bypass Helios branch during tests
// This allows tests to run without Helios by default, but specific tests can unmock it
jest.mock('../src/services/provider/getRpcProvider', () => {
  const originalModule = jest.requireActual('../src/services/provider/getRpcProvider')

  return {
    ...originalModule,
    getRpcProvider: (config: any) => {
      // Force provider to plain RPC during tests to avoid Helios/Colibri branches by default.
      const testConfig = { ...config, rpcProvider: 'rpc' }
      return originalModule.getRpcProvider(testConfig)
    }
  }
})

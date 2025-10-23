// Mock getRpcProvider to bypass Helios branch during tests
// This allows tests to run without Helios by default, but specific tests can unmock it
jest.mock('../src/services/provider/getRpcProvider', () => {
  const originalModule = jest.requireActual('../src/services/provider/getRpcProvider')

  return {
    ...originalModule,
    getRpcProvider: (config: any) => {
      // Force useHelios to false during tests to avoid the Helios branch
      const testConfig = { ...config, useHelios: false }
      return originalModule.getRpcProvider(testConfig)
    }
  }
})

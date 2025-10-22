/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testTimeout: 25000,
  // For services/validate.ts https://stackoverflow.com/a/61785012/13840636
  transform: {
    'node_modules/validator/.+\\.(j|t)sx?$': 'ts-jest'
  },
  transformIgnorePatterns: ['node_modules/(?!validator/.*)'],
  setupFiles: ['dotenv/config', '<rootDir>/test/setup.ts']
}

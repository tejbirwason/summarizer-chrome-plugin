module.exports = {
  testEnvironment: 'jsdom',
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  collectCoverageFrom: [
    'background.js',
    'content.js',
    '!youtube-content.js',
    '!node_modules/**'
  ],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1'
  },
  clearMocks: true,
  restoreMocks: true
};
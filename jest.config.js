/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  setupFilesAfterEnv: [],
  verbose: true,
  testTimeout: 30000,
  maxWorkers: 1,
};

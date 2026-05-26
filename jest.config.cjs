/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/server/tests/**/*.test.cjs'],
  // Exploratory / “expected to fail until fixed” suite — run via `npm run test:bugs`
  testPathIgnorePatterns: [
    '/node_modules/',
    '<rootDir>/server 2 old/',
    'bug-condition-exploration\\.test\\.cjs',
  ],
  transform: {},
  // Increase timeout for async tests
  testTimeout: 30000,
  forceExit: true,
};

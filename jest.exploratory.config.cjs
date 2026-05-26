/** @type {import('jest').Config} */
/** Run bug-condition exploration tests only: `npm run test:bugs` */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/server/tests/bug-condition-exploration.test.cjs'],
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/server 2 old/'],
  transform: {},
  testTimeout: 30000,
  forceExit: true,
};

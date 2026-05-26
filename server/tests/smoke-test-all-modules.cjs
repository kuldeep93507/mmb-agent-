'use strict';

/**
 * Smoke Test — Verifies all profile creation modules load correctly
 * and work together without import/require errors.
 *
 * Tests:
 * 1. All service modules load without errors
 * 2. All provider modules load without errors
 * 3. Provider modules export buildFingerprintPayload
 * 4. ProfileCreator can be instantiated
 * 5. ProfileCreator._validateInputs works correctly
 */

const path = require('path');

// Track results
const results = [];
let passed = 0;
let failed = 0;

function test(description, fn) {
  try {
    fn();
    results.push({ status: 'PASS', description });
    passed++;
  } catch (err) {
    results.push({ status: 'FAIL', description, error: err.message });
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 1. Service Modules
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test('1. fingerprintData.cjs loads without errors', () => {
  const mod = require('../services/fingerprintData.cjs');
  assert(mod !== null && mod !== undefined, 'Module is null/undefined');
  assert(typeof mod === 'object', 'Module should export an object');
});

test('2. FingerprintGenerator.cjs loads without errors', () => {
  const FingerprintGenerator = require('../services/FingerprintGenerator.cjs');
  assert(FingerprintGenerator !== null && FingerprintGenerator !== undefined, 'Module is null/undefined');
  assert(typeof FingerprintGenerator === 'function', 'Should export a class/constructor');
});

test('3. GeoIPResolver.cjs loads without errors', () => {
  const GeoIPResolver = require('../services/GeoIPResolver.cjs');
  assert(GeoIPResolver !== null && GeoIPResolver !== undefined, 'Module is null/undefined');
  assert(typeof GeoIPResolver === 'function', 'Should export a class/constructor');
});

test('4. ProxyRotator.cjs loads without errors', () => {
  const mod = require('../services/ProxyRotator.cjs');
  assert(mod !== null && mod !== undefined, 'Module is null/undefined');
  assert(typeof mod === 'object', 'Should export a singleton object');
  assert(typeof mod.assignProxy === 'function', 'Should have assignProxy method');
});

test('5. UniquenessValidator.cjs loads without errors', () => {
  const mod = require('../services/UniquenessValidator.cjs');
  assert(mod !== null && mod !== undefined, 'Module is null/undefined');
  assert(typeof mod === 'object', 'Should export a singleton object');
  assert(typeof mod.validateFingerprint === 'function', 'Should have validateFingerprint method');
});

test('6. CookieImporter.cjs loads without errors', () => {
  const CookieImporter = require('../services/CookieImporter.cjs');
  assert(CookieImporter !== null && CookieImporter !== undefined, 'Module is null/undefined');
  assert(typeof CookieImporter === 'function', 'Should export a class/constructor');
});

test('7. ProfileCreator.cjs loads without errors', () => {
  const ProfileCreator = require('../services/ProfileCreator.cjs');
  assert(ProfileCreator !== null && ProfileCreator !== undefined, 'Module is null/undefined');
  assert(typeof ProfileCreator === 'function', 'Should export a class/constructor');
});

test('8. RecreateHandler.cjs loads without errors', () => {
  const RecreateHandler = require('../services/RecreateHandler.cjs');
  assert(RecreateHandler !== null && RecreateHandler !== undefined, 'Module is null/undefined');
  assert(typeof RecreateHandler === 'function', 'Should export a class/constructor');
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 2. Provider Modules
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test('9. MoreLoginProvider.cjs loads without errors', () => {
  const mod = require('../providers/MoreLoginProvider.cjs');
  assert(mod !== null && mod !== undefined, 'Module is null/undefined');
  assert(mod.MoreLoginProvider, 'Should export MoreLoginProvider class');
});

test('10. MultiloginProvider.cjs loads without errors', () => {
  const mod = require('../providers/MultiloginProvider.cjs');
  assert(mod !== null && mod !== undefined, 'Module is null/undefined');
  assert(mod.MultiloginProvider, 'Should export MultiloginProvider class');
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 3. Provider buildFingerprintPayload exports
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test('11. MoreLoginProvider exports buildFingerprintPayload', () => {
  const mod = require('../providers/MoreLoginProvider.cjs');
  assert(typeof mod.buildFingerprintPayload === 'function', 'Should export buildFingerprintPayload function');
});

test('12. MultiloginProvider exports buildFingerprintPayload', () => {
  const mod = require('../providers/MultiloginProvider.cjs');
  assert(typeof mod.buildFingerprintPayload === 'function', 'Should export buildFingerprintPayload function');
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 4. ProfileCreator instantiation
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test('13. ProfileCreator can be instantiated', () => {
  const ProfileCreator = require('../services/ProfileCreator.cjs');
  const creator = new ProfileCreator();
  assert(creator !== null && creator !== undefined, 'Instance is null/undefined');
  assert(typeof creator.createProfile === 'function', 'Should have createProfile method');
  assert(typeof creator._validateInputs === 'function', 'Should have _validateInputs method');
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 5. ProfileCreator._validateInputs correctness
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test('14. _validateInputs returns null for valid inputs', () => {
  const ProfileCreator = require('../services/ProfileCreator.cjs');
  const creator = new ProfileCreator();
  const result = creator._validateInputs({ os: 'Windows', browserType: 'multilogin' });
  assert(result === null, `Expected null for valid inputs, got: ${JSON.stringify(result)}`);
});

test('15. _validateInputs returns null for all valid OS values', () => {
  const ProfileCreator = require('../services/ProfileCreator.cjs');
  const creator = new ProfileCreator();
  for (const os of ['Windows', 'macOS', 'Android']) {
    const result = creator._validateInputs({ os, browserType: 'morelogin' });
    assert(result === null, `Expected null for OS="${os}", got: ${JSON.stringify(result)}`);
  }
});

test('16. _validateInputs returns null for all valid browserType values', () => {
  const ProfileCreator = require('../services/ProfileCreator.cjs');
  const creator = new ProfileCreator();
  for (const browserType of ['morelogin', 'multilogin']) {
    const result = creator._validateInputs({ os: 'Windows', browserType });
    assert(result === null, `Expected null for browserType="${browserType}", got: ${JSON.stringify(result)}`);
  }
});

test('17. _validateInputs rejects null options', () => {
  const ProfileCreator = require('../services/ProfileCreator.cjs');
  const creator = new ProfileCreator();
  const result = creator._validateInputs(null);
  assert(result !== null, 'Expected error for null options');
  assert(result.code === -5, `Expected code -5, got ${result.code}`);
});

test('18. _validateInputs rejects invalid browserType', () => {
  const ProfileCreator = require('../services/ProfileCreator.cjs');
  const creator = new ProfileCreator();
  const result = creator._validateInputs({ os: 'Windows', browserType: 'invalid' });
  assert(result !== null, 'Expected error for invalid browserType');
  assert(result.code === -5, `Expected code -5, got ${result.code}`);
});

test('19. _validateInputs rejects missing browserType', () => {
  const ProfileCreator = require('../services/ProfileCreator.cjs');
  const creator = new ProfileCreator();
  const result = creator._validateInputs({ os: 'Windows' });
  assert(result !== null, 'Expected error for missing browserType');
  assert(result.code === -5, `Expected code -5, got ${result.code}`);
});

test('20. _validateInputs rejects invalid OS', () => {
  const ProfileCreator = require('../services/ProfileCreator.cjs');
  const creator = new ProfileCreator();
  const result = creator._validateInputs({ os: 'Linux', browserType: 'morelogin' });
  assert(result !== null, 'Expected error for invalid OS');
  assert(result.code === -5, `Expected code -5, got ${result.code}`);
});

test('21. _validateInputs rejects missing OS', () => {
  const ProfileCreator = require('../services/ProfileCreator.cjs');
  const creator = new ProfileCreator();
  const result = creator._validateInputs({ browserType: 'morelogin' });
  assert(result !== null, 'Expected error for missing OS');
  assert(result.code === -5, `Expected code -5, got ${result.code}`);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 6. Cross-module integration check
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test('22. FingerprintGenerator.generate produces valid output', () => {
  const FingerprintGenerator = require('../services/FingerprintGenerator.cjs');
  const gen = new FingerprintGenerator();
  const geoData = {
    timezone: 'America/New_York',
    language: 'en-US',
    latitude: 40.7128,
    longitude: -74.006,
    country: 'US',
    region: 'NY',
    city: 'New York',
  };
  const result = gen.generate('Windows', geoData);
  assert(result !== null && result !== undefined, 'generate() returned null/undefined');
  assert(typeof result === 'object', 'generate() should return an object');
  assert(result.userAgent, 'Result should have userAgent');
  assert(result.timezone === 'America/New_York', 'Timezone should match geoData');
});

test('23. UniquenessValidator.validateFingerprint works with generated fingerprint', () => {
  const FingerprintGenerator = require('../services/FingerprintGenerator.cjs');
  const validator = require('../services/UniquenessValidator.cjs');
  const gen = new FingerprintGenerator();
  const geoData = {
    timezone: 'America/New_York',
    language: 'en-US',
    latitude: 40.7128,
    longitude: -74.006,
    country: 'US',
    region: 'NY',
    city: 'New York',
  };
  const fingerprint = gen.generate('Windows', geoData);
  const result = validator.validateFingerprint(fingerprint, []);
  assert(result !== null && result !== undefined, 'validateFingerprint returned null/undefined');
  assert(result.unique === true, 'Fingerprint should be unique against empty profiles list');
});

test('24. ProxyRotator.assignProxy returns expected shape', () => {
  const proxyRotator = require('../services/ProxyRotator.cjs');
  const result = proxyRotator.assignProxy();
  assert(result !== null && result !== undefined, 'assignProxy returned null/undefined');
  assert(typeof result === 'object', 'assignProxy should return an object');
  assert('success' in result, 'Result should have success field');
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Print Results
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

console.log('\n' + '═'.repeat(70));
console.log('  SMOKE TEST RESULTS — Full Profile Creation Modules');
console.log('═'.repeat(70) + '\n');

for (const r of results) {
  const icon = r.status === 'PASS' ? '✓' : '✗';
  console.log(`  ${icon} [${r.status}] ${r.description}`);
  if (r.error) {
    console.log(`           Error: ${r.error}`);
  }
}

console.log('\n' + '─'.repeat(70));
console.log(`  Total: ${results.length} | Passed: ${passed} | Failed: ${failed}`);
console.log('─'.repeat(70) + '\n');

if (failed > 0) {
  process.exit(1);
} else {
  console.log('  ✓ All modules load correctly and work together!\n');
  process.exit(0);
}

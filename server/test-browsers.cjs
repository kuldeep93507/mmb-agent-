/**
 * Integration Test Script — Multi-Browser Provider Validation
 * 
 * Tests the full lifecycle for each configured browser provider:
 *   list → create → start → verify cdpPort → stop → delete
 * 
 * Skips unconfigured providers with clear messages.
 * Always attempts cleanup (delete) regardless of intermediate failures.
 * 
 * Usage: node server/test-browsers.cjs
 * 
 * Exit codes:
 *   0 — All tested operations passed
 *   1 — One or more operations failed
 * 
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7
 */

'use strict';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// LOAD ENVIRONMENT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const path = require('path');
const fs = require('fs');

// Load .env file manually (no external dependency required)
function loadEnv() {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) {
    console.log('[env] No .env file found, using existing environment variables');
    return;
  }
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    // Remove surrounding quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // Only set if not already defined in environment
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  console.log('[env] Loaded .env file');
}

loadEnv();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// IMPORTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const { providerFactory } = require('./providers/ProviderFactory.cjs');

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CONSTANTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const OPERATION_TIMEOUT = 30000; // 30 seconds per operation
const PROVIDERS_TO_TEST = ['morelogin', 'multilogin'];

const STATUS_PASS = 'PASS';
const STATUS_FAIL = 'FAIL';
const STATUS_SKIP = 'SKIP';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Run an async operation with a timeout.
 * @param {Function} fn - Async function to execute
 * @param {number} timeoutMs - Timeout in milliseconds
 * @param {string} label - Operation label for error messages
 * @returns {Promise<any>} Result of the function
 */
function withTimeout(fn, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Operation "${label}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    fn()
      .then(result => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch(err => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

/**
 * Check if a provider is configured and potentially reachable.
 * Returns { configured: boolean, reason: string }
 */
function checkProviderConfig(providerName) {
  switch (providerName) {
    case 'morelogin':
      // MORELOGIN_API_KEY has a default, so always considered configured
      return { configured: true, reason: '' };

    case 'multilogin': {
      const missing = [];
      if (!process.env.MULTILOGIN_EMAIL || process.env.MULTILOGIN_EMAIL.trim() === '' ||
          process.env.MULTILOGIN_EMAIL === 'your_multilogin_email@example.com') {
        missing.push('MULTILOGIN_EMAIL');
      }
      if (!process.env.MULTILOGIN_PASSWORD || process.env.MULTILOGIN_PASSWORD.trim() === '' ||
          process.env.MULTILOGIN_PASSWORD === 'your_multilogin_password_here') {
        missing.push('MULTILOGIN_PASSWORD');
      }
      if (!process.env.MULTILOGIN_FOLDER_ID || process.env.MULTILOGIN_FOLDER_ID.trim() === '' ||
          process.env.MULTILOGIN_FOLDER_ID === 'your_folder_id_here') {
        missing.push('MULTILOGIN_FOLDER_ID');
      }
      if (missing.length > 0) {
        return {
          configured: false,
          reason: `Missing env vars: ${missing.join(', ')}`,
        };
      }
      return { configured: true, reason: '' };
    }

    default:
      return { configured: false, reason: `Unknown provider: ${providerName}` };
  }
}

/**
 * Check if an error indicates the provider app is not running (connection refused)
 * or requires authentication that isn't configured (api-key missing).
 */
function isConnectionError(result) {
  if (!result) return false;
  const msg = (result.message || '').toLowerCase();

  // Connection errors (code -1)
  if (result.code === -1) {
    return msg.includes('not running') ||
           msg.includes('must be started') ||
           msg.includes('must be connected') ||
           msg.includes('not reachable') ||
           msg.includes('econnrefused') ||
           msg.includes('etimedout') ||
           msg.includes('timeout') ||
           msg.includes('require api-key') ||
           msg.includes('api-key');
  }

  // Auth errors that indicate the provider isn't properly configured
  if (result.code === -2) {
    return true;
  }

  return false;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TEST RUNNER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Test a single provider through the full lifecycle.
 * Returns an array of result objects: { operation, status, detail }
 */
async function testProvider(providerName) {
  const results = [];
  let createdProfileId = null;
  let createFailed = false;

  // Get provider instance
  let provider;
  try {
    provider = providerFactory.getProvider(providerName);
  } catch (err) {
    // All operations skipped if provider can't be instantiated
    const ops = ['list', 'create', 'start', 'verify_cdp', 'stop', 'delete'];
    for (const op of ops) {
      results.push({ operation: op, status: STATUS_SKIP, detail: err.message });
    }
    return results;
  }

  // ── LIST ──
  try {
    const listResult = await withTimeout(
      () => provider.listProfiles(1, 10),
      OPERATION_TIMEOUT,
      `${providerName}:list`
    );

    if (isConnectionError(listResult)) {
      // Provider app not running or not configured — skip all operations
      const ops = ['list', 'create', 'start', 'verify_cdp', 'stop', 'delete'];
      const skipDetail = `${providerName} not accessible: ${listResult.message}`;
      for (const op of ops) {
        results.push({ operation: op, status: STATUS_SKIP, detail: skipDetail });
      }
      return results;
    }

    if (listResult.code === 0) {
      const count = listResult.data && listResult.data.profiles
        ? listResult.data.profiles.length
        : 0;
      results.push({ operation: 'list', status: STATUS_PASS, detail: `Found ${count} profiles` });
    } else {
      results.push({ operation: 'list', status: STATUS_FAIL, detail: listResult.message });
    }
  } catch (err) {
    const errMsg = err.message || '';
    if (errMsg.includes('ECONNREFUSED') || errMsg.includes('timed out') || errMsg.includes('ETIMEDOUT')) {
      const ops = ['list', 'create', 'start', 'verify_cdp', 'stop', 'delete'];
      for (const op of ops) {
        results.push({
          operation: op,
          status: STATUS_SKIP,
          detail: `${providerName} app not running: ${errMsg}`,
        });
      }
      return results;
    }
    results.push({ operation: 'list', status: STATUS_FAIL, detail: errMsg });
  }

  // ── CREATE ──
  try {
    // Build provider-specific create options
    const createOptions = { name: `test-integration-${Date.now()}` };
    if (providerName === 'morelogin') {
      // MoreLogin requires browserTypeId (1=Chrome, 2=Firefox) and operatorSystemId
      createOptions.browserTypeId = 2;
      createOptions.operatorSystemId = 2;
    }

    const createResult = await withTimeout(
      () => provider.createProfile(createOptions),
      OPERATION_TIMEOUT,
      `${providerName}:create`
    );

    if (isConnectionError(createResult)) {
      results.push({ operation: 'create', status: STATUS_SKIP, detail: createResult.message });
      createFailed = true;
    } else if (createResult.code === 0 && createResult.data) {
      createdProfileId = createResult.data.id || createResult.data.profileId || null;
      if (createdProfileId) {
        results.push({ operation: 'create', status: STATUS_PASS, detail: `ID: ${createdProfileId}` });
      } else {
        results.push({ operation: 'create', status: STATUS_FAIL, detail: 'No profile ID returned' });
        createFailed = true;
      }
    } else {
      results.push({ operation: 'create', status: STATUS_FAIL, detail: createResult.message });
      createFailed = true;
    }
  } catch (err) {
    results.push({ operation: 'create', status: STATUS_FAIL, detail: err.message });
    createFailed = true;
  }

  // ── START (skip if create failed) ──
  let cdpPort = null;
  if (createFailed) {
    results.push({ operation: 'start', status: STATUS_SKIP, detail: 'Skipped: create failed' });
    results.push({ operation: 'verify_cdp', status: STATUS_SKIP, detail: 'Skipped: create failed' });
    results.push({ operation: 'stop', status: STATUS_SKIP, detail: 'Skipped: create failed' });
  } else {
    try {
      const startResult = await withTimeout(
        () => provider.startProfile(createdProfileId),
        OPERATION_TIMEOUT,
        `${providerName}:start`
      );

      if (startResult.code === 0 && startResult.data) {
        cdpPort = startResult.data.cdpPort;
        results.push({ operation: 'start', status: STATUS_PASS, detail: `cdpPort: ${cdpPort}` });
      } else {
        results.push({ operation: 'start', status: STATUS_FAIL, detail: startResult.message });
      }
    } catch (err) {
      results.push({ operation: 'start', status: STATUS_FAIL, detail: err.message });
    }

    // ── VERIFY CDP PORT ──
    if (cdpPort !== null && cdpPort !== undefined) {
      const portNum = parseInt(cdpPort, 10);
      if (!isNaN(portNum) && portNum >= 1024 && portNum <= 65535) {
        results.push({ operation: 'verify_cdp', status: STATUS_PASS, detail: `Port ${portNum} in valid range (1024-65535)` });
      } else {
        results.push({ operation: 'verify_cdp', status: STATUS_FAIL, detail: `Invalid CDP port: ${cdpPort} (expected 1024-65535)` });
      }
    } else {
      results.push({ operation: 'verify_cdp', status: STATUS_SKIP, detail: 'Skipped: start did not return cdpPort' });
    }

    // ── STOP ──
    try {
      const stopResult = await withTimeout(
        () => provider.stopProfile(createdProfileId),
        OPERATION_TIMEOUT,
        `${providerName}:stop`
      );

      if (stopResult.code === 0) {
        results.push({ operation: 'stop', status: STATUS_PASS, detail: 'Profile stopped' });
      } else {
        results.push({ operation: 'stop', status: STATUS_FAIL, detail: stopResult.message });
      }
    } catch (err) {
      results.push({ operation: 'stop', status: STATUS_FAIL, detail: err.message });
    }
  }

  // ── DELETE (always attempt cleanup if profile was created) ──
  if (createdProfileId) {
    try {
      const deleteResult = await withTimeout(
        () => provider.deleteProfile(createdProfileId),
        OPERATION_TIMEOUT,
        `${providerName}:delete`
      );

      if (deleteResult.code === 0) {
        results.push({ operation: 'delete', status: STATUS_PASS, detail: 'Profile deleted (cleanup)' });
      } else {
        results.push({ operation: 'delete', status: STATUS_FAIL, detail: deleteResult.message });
      }
    } catch (err) {
      results.push({ operation: 'delete', status: STATUS_FAIL, detail: err.message });
    }
  } else if (createFailed) {
    results.push({ operation: 'delete', status: STATUS_SKIP, detail: 'Skipped: no profile to delete' });
  }

  return results;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SUMMARY TABLE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Print a formatted summary table to the console.
 */
function printSummary(allResults) {
  console.log('\n');
  console.log('═══════════════════════════════════════════════════════════════════════════');
  console.log('  INTEGRATION TEST SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════════════════');
  console.log('');

  // Column widths
  const colProvider = 14;
  const colOperation = 12;
  const colStatus = 8;
  const colDetail = 50;

  // Header
  const header = [
    'Provider'.padEnd(colProvider),
    'Operation'.padEnd(colOperation),
    'Status'.padEnd(colStatus),
    'Detail',
  ].join(' │ ');

  const separator = [
    '─'.repeat(colProvider),
    '─'.repeat(colOperation),
    '─'.repeat(colStatus),
    '─'.repeat(colDetail),
  ].join('─┼─');

  console.log(`  ${header}`);
  console.log(`  ${separator}`);

  for (const { provider, results } of allResults) {
    for (let i = 0; i < results.length; i++) {
      const { operation, status, detail } = results[i];
      const providerCol = (i === 0 ? provider : '').padEnd(colProvider);
      const opCol = operation.padEnd(colOperation);

      let statusIcon;
      if (status === STATUS_PASS) statusIcon = '✓ PASS';
      else if (status === STATUS_FAIL) statusIcon = '✗ FAIL';
      else statusIcon = '○ SKIP';

      const statusCol = statusIcon.padEnd(colStatus);
      const detailCol = (detail || '').slice(0, colDetail);

      console.log(`  ${providerCol} │ ${opCol} │ ${statusCol} │ ${detailCol}`);
    }
    // Separator between providers
    if (allResults.indexOf({ provider, results }) < allResults.length - 1) {
      console.log(`  ${'─'.repeat(colProvider)}─┼─${'─'.repeat(colOperation)}─┼─${'─'.repeat(colStatus)}─┼─${'─'.repeat(colDetail)}`);
    }
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════════════════');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MAIN
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function main() {
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║  Multi-Browser Provider Integration Test                     ║');
  console.log('║  Testing: list → create → start → verify CDP → stop → delete║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');
  console.log('');

  const allResults = [];
  let hasFailure = false;

  for (const providerName of PROVIDERS_TO_TEST) {
    console.log(`\n── Testing: ${providerName.toUpperCase()} ${'─'.repeat(50)}`);

    // Check configuration
    const config = checkProviderConfig(providerName);
    if (!config.configured) {
      console.log(`   ⊘ SKIPPED: ${config.reason}`);
      const ops = ['list', 'create', 'start', 'verify_cdp', 'stop', 'delete'];
      const results = ops.map(op => ({
        operation: op,
        status: STATUS_SKIP,
        detail: config.reason,
      }));
      allResults.push({ provider: providerName, results });
      continue;
    }

    console.log(`   ✓ Configuration OK, running tests...`);

    // Run the test
    const results = await testProvider(providerName);
    allResults.push({ provider: providerName, results });

    // Check for failures
    for (const r of results) {
      if (r.status === STATUS_FAIL) {
        hasFailure = true;
      }
      // Log each result as it happens
      const icon = r.status === STATUS_PASS ? '✓' : r.status === STATUS_FAIL ? '✗' : '○';
      console.log(`   ${icon} ${r.operation}: ${r.detail || ''}`);
    }
  }

  // Print summary table
  printSummary(allResults);

  // Final verdict
  if (hasFailure) {
    console.log('  RESULT: ✗ SOME TESTS FAILED');
    console.log('');
    process.exit(1);
  } else {
    console.log('  RESULT: ✓ ALL TESTS PASSED (or skipped)');
    console.log('');
    process.exit(0);
  }
}

// Run
main().catch(err => {
  console.error('\n  FATAL ERROR:', err.message);
  console.error(err.stack);
  process.exit(1);
});

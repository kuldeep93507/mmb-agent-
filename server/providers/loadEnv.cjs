/**
 * Loads project root `.env` into process.env via the `dotenv` package.
 * Fallback: lightweight parser does not overwrite values already provided by dotenv/OS.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function loadEnv(envPath) {
  const resolvedPath = envPath || path.resolve(__dirname, '..', '..', '.env');

  try {
    require('dotenv').config({ path: resolvedPath, override: false });
  } catch (err) {
    console.warn('[loadEnv] dotenv failed:', err.message);
  }

  if (!fs.existsSync(resolvedPath)) {
    return { loaded: false, path: resolvedPath, count: 0 };
  }

  const content = fs.readFileSync(resolvedPath, 'utf8');
  let count = 0;

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    // Strip surrounding quotes (single or double)
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Don't overwrite values already set in the environment
    if (process.env[key] === undefined) {
      process.env[key] = value;
      count++;
    }
  }

  return { loaded: true, path: resolvedPath, count };
}

module.exports = loadEnv;

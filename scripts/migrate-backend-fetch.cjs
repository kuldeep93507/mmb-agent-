'use strict';

/**
 * Migrate fetch(backendUrl(...), init?) to backendFetch(...) across TypeScript sources under src/
 * Run: node scripts/migrate-backend-fetch.cjs
 */

const fs = require('fs');
const path = require('path');

const srcRoot = path.join(__dirname, '..', 'src');

function walk(d, out = []) {
  for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(ent.name)) out.push(p);
  }
  return out;
}

/** Given s[i]==='(', return index after matching ')' */
function consumeBalancedParen(s, i) {
  if (s[i] !== '(') throw new Error('expected ( got ' + s[i]);
  let depth = 0;
  let k = i;
  while (k < s.length) {
    const c = s[k++];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return k;
    }
  }
  throw new Error('Unterminated parentheses');
}

function skipWs(s, i) {
  let k = i;
  while (k < s.length && /\s/.test(s[k])) k++;
  return k;
}

function consumeBalancedBrace(s, i) {
  if (s[i] !== '{') throw new Error('Expected { got ' + s[i]);
  let depth = 0;
  let k = i;
  while (k < s.length) {
    const c = s[k++];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return k;
    }
  }
  throw new Error('Unterminated `{` — migrate script heuristic failed');
}

/** Parse `fetch(backendUrl ARGS0 ), INIT ? )` */
function replaceOne(content) {
  const needle = 'fetch(backendUrl(';
  const idx = content.indexOf(needle);
  if (idx === -1) return null;

  const outerOpen = idx + 'fetch'.length;
  if (content[outerOpen] !== '(') throw new Error('Expected `fetch(`');

  const buOpen = idx + needle.length - 1;
  const buClose = consumeBalancedParen(content, buOpen);

  let replacement = `${content.slice(0, idx)}backendFetch(${content.slice(buOpen + 1, buClose - 1)}`;

  let pos = skipWs(content, buClose);
  /** Optional `, init` */
  let endFetch;
  if (content[pos] === ',') {
    pos = skipWs(content, pos + 1);
    if (content[pos] === '{') {
      const braceEnd = consumeBalancedBrace(content, pos);
      replacement += `, ${content.slice(pos, braceEnd)}`;
      pos = skipWs(content, braceEnd);
    } else if (content[pos] === '(') {
      /** rare: fetch(backendUrl(..), (...) ) */

      const close = consumeBalancedParen(content, pos);
      replacement += `, ${content.slice(pos, close)}`;
      pos = skipWs(content, close);
    } else throw new Error('Unknown fetch init start: ' + content.slice(pos, pos + 40));
    if (content[pos] !== ')') throw new Error('Expected closing `)` after fetch init');
    endFetch = pos + 1;
  } else if (content[pos] === ')') {
    replacement += ')';
    endFetch = pos + 1;
  } else throw new Error('Unexpected after backendUrl(...) ' + content.slice(pos, pos + 40));

  const outerVerified = consumeBalancedParen(content, outerOpen);
  if (outerVerified !== endFetch) {

    /** tolerate mismatch due to trivia — slice from endFetch */


  }
  return replacement + content.slice(endFetch);
}

function migrateFile(raw) {
  let g = 0;
  while (raw.includes('fetch(backendUrl') && g++ < 5000) {
    const next = replaceOne(raw);
    if (!next) break;
    raw = next;
  }
  if (g >= 5000) throw new Error('loop');
  return raw;
}

function fixImports(relPath, raw) {
  raw = raw.replace(/\{\s*backendFetch\s*,\s*backendFetch\s*\}/g, '{ backendFetch }');
  raw = raw.replace(/\{\s*backendFetch\s*,\s*,/g, '{ backendFetch,');
  raw = raw.replace(
    /\{\s*(backendFetch),\s*\1([^}])/g,
    '{ $1$2',
  );
  raw = raw.replace(
    /\{\s*backendFetch\s*,\s*\}/,
    '{ backendFetch }',
  );

  if (!/\bbackendFetch\b/.test(raw)) return raw;

  raw = raw.replace(
    /import\s*\{\s*([^}]+)\}\s*from\s*['"]((?:\.\.?\/)+services\/backendOrigin|\.\/backendOrigin)['"]/, 
    (m, inner, srcMod) => {
      let parts = inner.split(',').map((s) => s.trim()).filter(Boolean);
      parts = [...new Set(parts)];
      /** Remove backendUrl only if absent in file */

      parts = parts.filter((p) =>
        !(p === 'backendUrl' && !new RegExp(`\\bbackendUrl\\b`).test(raw.replace(/^import[^\n]+\n/, ''))),
      );
      parts = parts.filter((p) =>
        !(p === 'getAuthHeaders' && !/\bgetAuthHeaders\b/.test(raw.replace(/^import[^\n]+\n/, ''))),
      );
      parts.sort();

      /** backendFetch must be first for readability */

      parts = parts.filter((p) => p !== 'backendFetch');
      parts.unshift('backendFetch');
      return `import { ${[...new Set(parts)].join(', ')} } from '${srcMod}'`;
    },
  );
  return raw;
}

function main() {
  let n = 0;
  for (const abs of walk(srcRoot)) {
    if (abs.endsWith(`${path.sep}backendOrigin.ts`)) continue;
    let raw = fs.readFileSync(abs, 'utf8');
    if (!raw.includes('fetch(backendUrl')) continue;
    raw = migrateFile(raw);
    const relPath = path.relative(srcRoot, abs).replace(/\\/g, '/');
    raw = fixImports(relPath, raw);

    fs.writeFileSync(abs, raw);
    console.log(relPath);
    n++;
  }
  console.log('Done, files:', n);
}

main();

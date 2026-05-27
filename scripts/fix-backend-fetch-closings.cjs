'use strict';

/** Fix malformed `backendFetch(..., {...};` → `...});` after migrate-backend-fetch.cjs */

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

/** Find `backendFetch(` and fix its closing when options end with lone `};` instead of `});` */

function balanceBraces(expr, braceStartIdx) {

  /** braceStartIdx points at first `{` of object */

  let d = 0;
  let k = braceStartIdx;
  while (k < expr.length) {

    const c = expr[k++];

    if (c === '{') d++;

    else if (c === '}') {

      d--;

      if (d === 0) {

        /** expect `)` then optionally `);` */


        let m = k;

        while (m < expr.length && /\s/.test(expr[m])) m++;

        if (expr[m] === ')') return { closeBraceEnd: k, afterParen: m + 1 };

        /** missing `)` before `;` */


        return { closeBraceEnd: k, missingCloseParen: true };
      }


    }


  }


  return null;


}

function fixCalls(s) {


  let out = '';

  let i = 0;

  while (true) {


    const needle = 'backendFetch(';


    const j = s.indexOf(needle, i);


    if (j === -1) {


      out += s.slice(i);


      return out;


    }


    out += s.slice(i, j);


    const openParen = j + needle.length - 1;


    let k = openParen + 1;


    let depth = 0;


    const outerStart = openParen;


    while (k < s.length) {


      const ch = s[k];


      if (ch === '(') depth++;

      else if (ch === ')') {


        if (depth === 0) break;


        depth--;


      }


      k++;


    }


    /** s[openParen] is '(' of backendFetch(, k should sit at ')'. */


    const outerEnd = k;


    /** inner substring without outer parens */


    const inner = s.slice(openParen + 1, outerEnd);


    const commaIdx = inner.lastIndexOf(',');


    if (commaIdx === -1) {


      /** single-arg backendFetch(x) */


      out += s.slice(j, outerEnd + 1);


      i = outerEnd + 1;


      continue;


    }


    const firstArg = inner.slice(0, commaIdx);


    let rest = inner.slice(commaIdx + 1);


    const wsLeading = rest.match(/^\s*/)[0].length;


    const objStartRel = commaIdx + 1 + wsLeading;


    const objStartAbs = openParen + 1 + objStartRel;


    if (s[objStartAbs] !== '{') {


      out += s.slice(j, outerEnd + 1);


      i = outerEnd + 1;


      continue;


    }


    /** Find matching brace for JSON object */


    let bd = 0;


    let p = objStartAbs;


    let closeBraceExclusive = null;


    while (p < s.length) {


      const c = s[p++];


      if (c === '{') bd++;


      else if (c === '}') {


        bd--;


        if (bd === 0) {


          closeBraceExclusive = p;


          break;


        }


      }


    }


    if (!closeBraceExclusive) {


      out += s.slice(j, outerEnd + 1);


      i = outerEnd + 1;


      continue;


    }


    /** After `}`, expect whitespace then `)`. */


    let q = closeBraceExclusive;


    while (q < s.length && /\s/.test(s[q])) q++;


    if (s[q] === ')') {


      out += s.slice(j, q + 1);


      i = q + 1;


      continue;


    }


    /** Missing `)` — insert before next `;` or before junk */


    if (s[q] === ';') {


      out += s.slice(j, closeBraceExclusive) + ')' + s.slice(closeBraceExclusive, q + 1);


      i = q + 1;


      continue;


    }


    /** Sometimes `};` where `});` */


    if (s[q] === '}')


      {


      }


    /** Fallback: splice `)` right after brace */


    out += s.slice(j, closeBraceExclusive) + ')';


    i = closeBraceExclusive;


    continue;


  }


}

function main() {

  let n = 0;

  for (const abs of walk(srcRoot)) {

    let raw = fs.readFileSync(abs, 'utf8');

    if (!raw.includes('backendFetch(')) continue;

    const next = fixCalls(raw);

    if (next !== raw) {

      fs.writeFileSync(abs, next);


      console.log(path.relative(srcRoot, abs));


      n++;

    }


  }


  console.log('Fixed files:', n);


}


main();


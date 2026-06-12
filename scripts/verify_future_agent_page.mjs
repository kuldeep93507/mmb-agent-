import fs from 'fs';
import path from 'path';

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const sidebar = read('src/components/Sidebar.tsx');
const app = read('src/App.tsx');
const store = read('src/store/useStore.ts');
const topbar = read('src/components/TopBar.tsx');
const page = read('src/components/FutureAutonomousAgentPage.tsx');

const navIds = [...sidebar.matchAll(/id: '([^']+)'/g)].map((m) => m[1]);
const cases = [...app.matchAll(/case '([^']+)':/g)].map((m) => m[1]);
const validBlock = store.split('VALID_APP_TABS = new Set([')[1].split(']);')[0];
const validTabs = new Set([...validBlock.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]));

const failures = [];
const warnings = [];

for (const id of navIds) {
  if (!cases.includes(id)) failures.push(`Nav "${id}" has no App.tsx case`);
  if (!validTabs.has(id)) failures.push(`Nav "${id}" missing from VALID_APP_TABS`);
}

for (const c of cases) {
  if (!navIds.includes(c)) warnings.push(`App case "${c}" not in Sidebar (may be redirect-only)`);
}

if (!fs.existsSync(path.join(root, 'src/components/FutureAutonomousAgentPage.tsx'))) {
  failures.push('FutureAutonomousAgentPage.tsx missing');
}
if (!app.includes("import FutureAutonomousAgentPage")) {
  failures.push('App.tsx missing FutureAutonomousAgentPage import');
}
if (!app.includes("case 'future-agent'")) {
  failures.push('App.tsx missing future-agent route');
}
if (!topbar.includes("'future-agent'")) {
  failures.push('TopBar missing future-agent label');
}
if (!fs.existsSync(path.join(root, 'planning/04_future_autonomous_agent.md'))) {
  failures.push('planning/04_future_autonomous_agent.md missing');
}
if (page.includes('backendFetch') || page.includes('fetch(')) {
  failures.push('Page should not call backend (placeholder only)');
}
if (!page.includes('Coming Soon')) {
  failures.push('Page missing Coming Soon badge');
}
if (!page.includes('Full Agentic Loop')) {
  failures.push('Page missing Full Agentic Loop section');
}
if (!page.includes('AI Campaign Strategist')) {
  failures.push('Page missing Campaign Strategist section');
}
if (!page.includes('Daily AI Report')) {
  failures.push('Page missing Daily AI Report section');
}

const dist = path.join(root, 'dist/index.html');
if (fs.existsSync(dist)) {
  const bundle = fs.readFileSync(dist, 'utf8');
  if (!bundle.includes('Future Autonomous Agent')) {
    failures.push('Built bundle missing page title string');
  }
  if (!bundle.includes('Full Agentic Loop')) {
    failures.push('Built bundle missing feature content');
  }
} else {
  warnings.push('dist/index.html not found — run npm run build first');
}

console.log('=== Future Agent Page Verification ===');
console.log(`Nav items: ${navIds.length}`);
console.log(`App routes: ${cases.length}`);
console.log(`VALID_APP_TABS: ${validTabs.size}`);
console.log(`future-agent in nav: ${navIds.includes('future-agent')}`);
console.log(`future-agent in cases: ${cases.includes('future-agent')}`);
console.log(`future-agent in VALID_APP_TABS: ${validTabs.has('future-agent')}`);

if (warnings.length) {
  console.log('\nWarnings:');
  warnings.forEach((w) => console.log('  ⚠', w));
}

if (failures.length) {
  console.log('\nFAILURES:');
  failures.forEach((f) => console.log('  ✗', f));
  process.exit(1);
}

console.log('\n✓ ALL CHECKS PASSED');

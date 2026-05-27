/**
 * Package team release ZIP: Setup.exe + INSTALL.txt
 * Run after: npm run dist:win
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const releaseDir = path.join(root, process.env.RELEASE_DIR || 'release');
const installTxt = path.join(__dirname, 'INSTALL.txt');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const zipName = `MMB-Agent-247-Team-v${version}-FINAL.zip`;
const zipPath = path.join(releaseDir, zipName);

if (!fs.existsSync(releaseDir)) {
  console.error('release/ folder missing — run npm run dist:win first');
  process.exit(1);
}

const exeFiles = fs.readdirSync(releaseDir)
  .filter((f) => f.endsWith('.exe') && !f.includes('unpacked'))
  .map((f) => path.join(releaseDir, f));

if (exeFiles.length === 0) {
  console.error('No Setup .exe found in release/ — run npm run dist:win first');
  process.exit(1);
}

const setupExe = exeFiles.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
const stagingDir = path.join(releaseDir, '_team-staging');
const stagingInstall = path.join(stagingDir, 'INSTALL.txt');
const stagingExe = path.join(stagingDir, path.basename(setupExe));

fs.rmSync(stagingDir, { recursive: true, force: true });
fs.mkdirSync(stagingDir, { recursive: true });
fs.copyFileSync(installTxt, stagingInstall);
fs.copyFileSync(setupExe, stagingExe);

if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

const ps = [
  'Compress-Archive',
  `-Path "${stagingDir}\\*"`,
  `-DestinationPath "${zipPath}"`,
  '-Force',
].join(' ');

execSync(ps, { stdio: 'inherit', shell: 'powershell.exe' });
fs.rmSync(stagingDir, { recursive: true, force: true });

const sizeMb = (fs.statSync(zipPath).size / (1024 * 1024)).toFixed(1);
console.log(`\n✅ Team ZIP ready: ${zipPath} (${sizeMb} MB)`);
console.log(`   Upload to GitHub Release as: ${zipName}`);

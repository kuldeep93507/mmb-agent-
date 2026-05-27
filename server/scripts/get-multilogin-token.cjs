#!/usr/bin/env node
/**
 * Fetch Multilogin automation token using email + password from .env
 * Usage: npm run multilogin:token
 *
 * NOTE: Multilogin X app UI mein token option NAHI hota — sirf API se milta hai.
 */
'use strict';

const path = require('path');
require(path.join(__dirname, '..', 'providers', 'loadEnv.cjs'))();

async function main() {
  const email = (process.env.MULTILOGIN_EMAIL || '').trim();
  const password = (process.env.MULTILOGIN_PASSWORD || '').trim();

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  MMB Agent — Multilogin Token Helper');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  if (!email || !password) {
    console.error('❌ .env mein ye add karo pehle:\n');
    console.error('   MULTILOGIN_EMAIL=your@email.com');
    console.error('   MULTILOGIN_PASSWORD=your_multilogin_password\n');
    console.error('Phir dubara chalao: npm run multilogin:token\n');
    process.exit(1);
  }

  console.log(`Email: ${email}`);
  console.log('Multilogin cloud se sign-in ho raha hai...\n');

  // Force fresh sign-in (ignore old/broken token)
  delete process.env.MULTILOGIN_TOKEN;

  const { MultiloginProvider } = require('../providers/MultiloginProvider.cjs');
  const provider = new MultiloginProvider();
  const result = await provider.authenticate({ skipStaticToken: true });

  if (result.code !== 0) {
    console.error('❌ Failed:', result.message);
    console.error('\nCommon fixes:');
    console.error('  • Email/password sahi hai? (Multilogin X website wala)');
    console.error('  • Paid plan hai? Free plan pe API nahi milti');
    console.error('  • 2FA ON hai? Pehle band karo ya support se API access lo');
    console.error('  • Internet / VPN check karo\n');
    process.exit(1);
  }

  const token = process.env.MULTILOGIN_TOKEN || provider.token || '';
  if (!token) {
    console.error('❌ Sign-in OK but automation token save nahi hua.');
    console.error('   Multilogin plan mein Automation API included hai ya nahi — dashboard check karo.\n');
    process.exit(1);
  }

  console.log('✅ Automation token mil gaya aur .env mein save ho gaya!\n');
  console.log('Token (first 40 chars):', token.slice(0, 40) + '...\n');
  console.log('Ab ye bhi set karo (.env ya Settings):');
  console.log('  MULTILOGIN_FOLDER_ID=<folder uuid from Multilogin app>\n');
  console.log('Folder ID kaise milega:');
  console.log('  Multilogin X → Profiles → apna folder kholo');
  console.log('  URL ya folder info mein UUID dikhega\n');
  console.log('Phir MMB Agent Settings → Multilogin → Test Connection dabao.\n');
}

main().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});

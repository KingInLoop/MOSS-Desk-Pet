'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const appBundle = path.resolve(process.argv[2] || '');
if (!appBundle.endsWith('.app') || !fs.existsSync(appBundle)) {
  throw new Error('Pass an existing packaged .app path.');
}

execFileSync('/usr/bin/xattr', ['-cr', appBundle], { stdio: 'inherit' });
execFileSync('/usr/bin/codesign', [
  '--force', '--deep', '--sign', '-', '--timestamp=none', appBundle
], { stdio: 'inherit' });
execFileSync('/usr/bin/codesign', [
  '--verify', '--deep', '--strict', '--verbose=2', appBundle
], { stdio: 'inherit' });
console.log(`Ad-hoc signed and verified ${appBundle}`);

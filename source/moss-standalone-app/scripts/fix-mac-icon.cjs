'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const appBundle = path.resolve(process.argv[2] || '');
if (!appBundle.endsWith('.app') || !fs.existsSync(appBundle)) {
  throw new Error('Pass an existing packaged .app path.');
}

const projectRoot = path.resolve(__dirname, '..');
const resources = path.join(appBundle, 'Contents', 'Resources');
const plist = path.join(appBundle, 'Contents', 'Info.plist');
fs.copyFileSync(path.join(projectRoot, 'assets', 'icons', 'app.icns'), path.join(resources, 'app.icns'));
execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleIconFile app.icns', plist]);
console.log(`Applied MOSS icon to ${appBundle}`);

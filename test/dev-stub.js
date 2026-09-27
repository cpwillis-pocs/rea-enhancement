'use strict';
// Prints a Tampermonkey script that loads your working copy from disk, so edits show on a
// reload without pasting. Install it as a new script (Tampermonkey → + → paste), and allow
// "file URLs" for Tampermonkey in the browser's extension settings.
// It has its own @name and @namespace, so it never replaces the installed script. Disable the
// installed one while developing: if both run, the second copy warns and stops (double-run guard).
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const FILE = path.join(__dirname, '..', 'rea-availability-filter.user.js');
const src = fs.readFileSync(FILE, 'utf8');
const header = src.match(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/)[0];
const keep = header.split('\n').filter((l) => /@(match|run-at|grant|noframes)\b/.test(l));
process.stdout.write([
  '// ==UserScript==',
  '// @name         REA Availability Filter (dev)',
  '// @namespace    rea-enhancement-dev',
  '// @version      0.0.0-dev',
  '// @description  Loads the working copy from disk. Not for installs.',
  ...keep,
  `// @require      ${pathToFileURL(FILE).href}`,
  '// ==/UserScript==',
  '',
].join('\n'));

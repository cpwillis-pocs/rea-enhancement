'use strict';
// Shared failure handling for the e2e scripts:
// - a watchdog (E2E_TIMEOUT_MS, default 8 min) so a hung wait fails with the last passing section
//   instead of stalling CI until the job timeout;
// - on failure, when E2E_ARTIFACTS is set, a screenshot and the drawer's HTML for every open page,
//   plus a log of the sections that passed, written to that directory for CI to upload.
const fs = require('fs');
const path = require('path');

const started = Date.now();
const passed = []; // console.log lines = one per finished section
const log = console.log.bind(console);
console.log = (...args) => { passed.push(args.join(' ')); log(...args); };

const browsers = [];
const watch = (browser) => { browsers.push(browser); return browser; };

const dir = process.env.E2E_ARTIFACTS ? path.resolve(process.env.E2E_ARTIFACTS) : null;
const name = path.basename(process.argv[1] || 'e2e', '.js');

async function dump(reason) {
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}-log.txt`),
    [`${name}: ${reason}`, `after ${Math.round((Date.now() - started) / 1000)}s`, '', 'passed sections:', ...passed].join('\n') + '\n');
  let n = 0;
  for (const b of browsers) {
    for (const ctx of b.contexts()) {
      for (const page of ctx.pages()) {
        const tag = `${name}-page${++n}`;
        try { await page.screenshot({ path: path.join(dir, `${tag}.png`), fullPage: false, timeout: 5000 }); } catch { /* page gone */ }
        try {
          const html = await page.evaluate(() => (document.getElementById('rf-panel')?.outerHTML || '') + '\n' + location.href);
          fs.writeFileSync(path.join(dir, `${tag}-drawer.html`), html);
        } catch { /* page gone */ }
      }
    }
  }
}

async function fail(err) {
  console.error(err);
  try { await Promise.race([dump(String(err?.message || err).split('\n')[0]), new Promise((r) => setTimeout(r, 20000))]); } catch { /* best effort */ }
  process.exit(1);
}

const limit = +process.env.E2E_TIMEOUT_MS || 8 * 60e3;
setTimeout(() => fail(new Error(`${name} timed out after ${limit / 1000}s; last passing section: ${passed.at(-1) || '(none)'}`)), limit).unref();

module.exports = { watch, fail };

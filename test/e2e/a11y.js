'use strict';
// Accessibility check: axe-core over the drawer in each of its views, in light and dark, plus the
// listing-page bar. Fails on serious or critical findings in the script's own UI (REA's page
// around it is not ours to fix). axe-core is a test-only install, never shipped:
//   npm run e2e:setup   (installs it at the version pinned in package.json)
//   node test/e2e/a11y.js
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const harness = require('./harness');
const { serve, ORIGIN } = require('./fixtures');
let pw;
try { pw = require('playwright'); } catch { pw = require(path.join(execSync('npm root -g').toString().trim(), 'playwright')); }
let AXE;
try { AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); } catch { console.error('a11y: axe-core missing: run npm run e2e:setup'); process.exit(2); }

const SCRIPT = fs.readFileSync(path.join(__dirname, '../../rea-availability-filter.user.js'), 'utf8');
const SEARCH = `${ORIGIN}/rent/in-bondi,+nsw+2026/list-1`;
const FIXED = new Date('2026-09-23T10:00:00+10:00');
const BLOCKING = new Set(['serious', 'critical']);

// Each view: how to get there from a searched drawer, and what to check.
const VIEWS = [
  ['drawer', async () => {}],
  ['filters and settings open', async (p) => { await p.click('#rf-more summary'); await p.click('.rf-settings summary'); }],
  ['help', async (p) => { await p.click('.rf-keys'); }],
  ['market', async (p) => { await p.click('.rf-market-btn'); await p.waitForSelector('.rf-market table'); }],
  ['map', async (p) => { await p.click('.rf-map-btn'); await p.waitForSelector('.rf-map svg'); }],
  ['shortlist', async (p) => {
    for (const n of [1, 2]) { await p.hover(`.rf-item:nth-child(${n})`); await p.click(`.rf-item:nth-child(${n}) >> [data-act=s]`); }
    await p.click('[data-view=shortlist]');
  }],
  ['compare', async (p) => {
    for (const n of [1, 2]) { await p.hover(`.rf-item:nth-child(${n})`); await p.click(`.rf-item:nth-child(${n}) >> [data-act=s]`); }
    await p.click('[data-view=shortlist]'); await p.click('[data-sl=compare]');
  }],
  ['expanded', async (p) => { await p.click('.rf-expand'); }],
];

const check = async (page, include, label, out) => {
  await page.addScriptTag({ content: AXE });
  const res = await page.evaluate(async (sel) => window.axe.run({ include: [sel] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }), include);
  for (const v of res.violations.filter((x) => BLOCKING.has(x.impact))) {
    out.push(`${label}: ${v.id} (${v.impact}) ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join('\n    ')}`);
  }
};

(async () => {
  const browser = harness.watch(await pw.chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined }));
  const found = [];
  for (const scheme of ['light', 'dark']) {
    for (const [name, go] of VIEWS) {
      harness.section(`${scheme} ${name}`);
      const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width: 1280, height: 900 } });
      const page = await ctx.newPage();
      await page.clock.install({ time: FIXED });
      await page.route('**/*', serve([], { extras: true }));
      await page.goto(SEARCH);
      await page.addScriptTag({ content: SCRIPT });
      await page.waitForSelector('#rf-panel[data-rf-ready]', { state: 'attached' });
      await page.click('#rf-launch'); await page.click('#rf-run');
      await page.waitForFunction(() => /listings match/.test(document.querySelector('.rf-status').textContent));
      await go(page);
      await check(page, '#rf-panel', `${scheme} ${name}`, found);
      await ctx.close();
    }
    harness.section(`${scheme} listing bar`);
    const ctx = await browser.newContext({ colorScheme: scheme });
    const page = await ctx.newPage();
    await page.clock.install({ time: FIXED });
    await page.route('**/*', serve());
    await page.goto(`${ORIGIN}/property-unit-nsw-bondi-146500101`);
    await page.addScriptTag({ content: SCRIPT });
    await page.waitForSelector('#rf-lbar');
    await page.click('#rf-lbar [data-l=s]');
    await page.click('#rf-lbar .rf-lbar-more summary');
    await check(page, '#rf-lbar', `${scheme} listing bar`, found);
    await ctx.close();
  }
  await browser.close();
  if (found.length) { console.error(`a11y: ${found.length} serious/critical finding(s):\n  ${found.join('\n  ')}`); process.exit(1); }
  console.log(`a11y: ok (${VIEWS.length + 1} views, light and dark)`);
})().catch((e) => { console.error(e); process.exit(1); });

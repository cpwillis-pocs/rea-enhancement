'use strict';
// Renders README screenshots into docs/screenshots from fixture pages (no network).
// Run: node test/e2e/screenshots.js
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
let pw;
try { pw = require('playwright'); } catch { pw = require(path.join(execSync('npm root -g').toString().trim(), 'playwright')); }
const { ORIGIN, serve } = require('./fixtures');

const SCRIPT = fs.readFileSync(path.join(__dirname, '../../rea-availability-filter.user.js'), 'utf8');
const OUT = path.join(__dirname, '../../docs/screenshots');
const SEARCH = `${ORIGIN}/rent/in-bondi,+nsw+2026/list-1`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await pw.chromium.launch();
  const shot = async (name, { dark = false, width = 1280, height = 860, act }) => {
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme: dark ? 'dark' : 'light', timezoneId: 'Australia/Sydney', locale: 'en-AU' });
    const page = await ctx.newPage();
    await page.route('**/*', serve());
    await page.goto(SEARCH);
    await page.addScriptTag({ content: SCRIPT });
    await page.waitForSelector('article > .rf-badge');
    await act(page);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log('wrote', name);
    await ctx.close();
  };
  const search = async (page) => {
    await page.click('#rf-launch');
    await page.click('#rf-run');
    await page.waitForFunction(() => /listings match/.test(document.querySelector('.rf-status').textContent), null, { timeout: 20000 });
  };
  const setFrom = async (page, v) => { await page.fill('#rf-from', v); await page.dispatchEvent('#rf-from', 'change'); };

  await shot('badges', { act: async (page) => { await page.evaluate(() => window.scrollTo(0, 60)); } });
  await shot('drawer', { act: async (page) => { await search(page); await setFrom(page, '2026-10-10'); } });
  await shot('filters', { act: async (page) => {
    await search(page);
    await page.click('#rf-more summary');
    await page.fill('#rf-bedsMin', '2'); await page.dispatchEvent('#rf-bedsMin', 'change');
    await page.selectOption('#rf-sort', 'ppb');
  } });
  await shot('dimmed', { act: async (page) => {
    await search(page); await setFrom(page, '2026-10-10');
    await page.click('.rf-x');
    await page.evaluate(() => window.scrollTo(0, 60));
  } });
  await shot('drawer-dark', { dark: true, act: async (page) => { await search(page); await setFrom(page, '2026-10-10'); } });
  await shot('mobile', { width: 390, height: 844, act: async (page) => { await search(page); } });
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });

'use strict';
// Chromium smoke test: serves fixture REA pages on the real origin via request
// interception (no network), injects the userscript, drives the drawer.
// Run: node test/e2e/smoke.js   (needs playwright; uses global install if present)
const path = require('path');
const fs = require('fs');
const assert = require('node:assert/strict');
const { execSync } = require('child_process');
let pw;
try { pw = require('playwright'); } catch { pw = require(path.join(execSync('npm root -g').toString().trim(), 'playwright')); }
const { listing, results, exchange } = require('../helpers');

const SCRIPT = fs.readFileSync(path.join(__dirname, '../../rea-availability-filter.user.js'), 'utf8');
const ORIGIN = 'https://www.realestate.com.au';
const SEARCH = `${ORIGIN}/rent/in-bondi,+nsw+2026/list-1`;
const PAGES = 3;

const dates = ['Available now', 'Available 12 Oct 2026', 'Available Mon 2nd Nov', 'Contact agent', 'Available 20/12/2026'];
const pageResults = (n) => results({
  maxPage: PAGES,
  exact: [0, 1].map((i) => listing({
    id: `${n}${i}`,
    availableDate: { display: dates[(n * 2 + i) % dates.length] },
    price: { display: `$${500 + n * 100 + i * 10} per week` },
    title: n === 2 && i === 0 ? 'Renovated with pool' : 'Nice place',
  })),
  surrounding: n === 1 ? [listing({ id: 'near1', address: { suburb: 'Tamarama', display: { fullAddress: '9 Near St, Tamarama' } } })] : [],
});

// Minimal stand-in for REA's markup: <article> cards linking to the canonical listing URL.
const html = (n) => {
  const r = pageResults(n);
  const cards = [...r.exact.items, ...r.surrounding.items].map(({ listing: l }) =>
    `<article class="x1"><a href="${l._links.canonical.href.replace(ORIGIN, '')}"><h2>${l.address.display.fullAddress}</h2></a><div class="x2">${l.price.display}</div></article>`).join('');
  return `<!doctype html><html><head><title>t</title></head><body><main>${cards}</main>` +
    `<script>window.ArgonautExchange=${JSON.stringify(exchange(r))};</script></body></html>`;
};

(async () => {
  const browser = await pw.chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage();
  const hits = [];
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.origin !== ORIGIN) return route.fulfill({ status: 204, body: '' });
    const n = +(u.pathname.match(/list-(\d+)/)?.[1] || 1);
    hits.push(n);
    return route.fulfill({ status: 200, contentType: 'text/html', body: html(n) });
  });
  await page.goto(SEARCH);
  await page.addScriptTag({ content: SCRIPT });

  await page.click('#rf-launch');
  await page.click('#rf-run');
  await page.waitForFunction(() => /listings match/.test(document.querySelector('.rf-status').textContent), null, { timeout: 15000 });
  const status = await page.textContent('.rf-status');
  const cards = await page.$$eval('.rf-card', (els) => els.length);
  console.log('status:', status, '| cards:', cards, '| fetched pages:', hits.join(','));
  assert.equal(cards, PAGES * 2 + 1);
  assert.ok(!hits.slice(1).includes(1), 'page 1 served from seed, not refetched');

  await page.fill('#rf-from', '2026-10-01');
  await page.dispatchEvent('#rf-from', 'change');
  const dated = await page.$$eval('.rf-avail', (els) => els.map((e) => e.textContent));
  console.log('from 2026-10-01:', dated.join(' | '));
  assert.ok(dated.every((t) => !/now|Contact/i.test(t)));

  await page.click('#rf-more summary');
  await page.fill('#rf-keyword', 'pool');
  await page.dispatchEvent('#rf-keyword', 'change');
  assert.equal(await page.$$eval('.rf-card', (els) => els.length), 1);
  await page.fill('#rf-keyword', '');
  await page.dispatchEvent('#rf-keyword', 'change');

  // Export: capture download.
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-export=tsv]')]);
  const body = fs.readFileSync(await dl.path(), 'utf8');
  console.log('export:', dl.suggestedFilename(), body.split('\n').length - 1, 'rows');
  const [csv] = await Promise.all([page.waitForEvent('download'), page.click('[data-export=csv]')]);
  const csvBody = fs.readFileSync(await csv.path(), 'utf8');
  assert.ok(csvBody.startsWith('\ufeffavailable_date,'), 'csv has BOM + header');

  // Reload: rows restored from session cache without refetching.
  const before = hits.length;
  await page.reload();
  await page.addScriptTag({ content: SCRIPT });
  await page.waitForFunction(() => /Cached/.test(document.querySelector('.rf-status')?.textContent || ''), null, { timeout: 5000 });
  assert.equal(hits.length, before + 1, 'only the reloaded document itself was fetched');

  assert.deepEqual(errors, [], 'no page errors');
  await browser.close();
  console.log('e2e smoke: ok');
})().catch((e) => { console.error(e); process.exit(1); });

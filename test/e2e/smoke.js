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
    id: `1465000${n}${i}`,
    availableDate: { display: dates[(n * 2 + i) % dates.length] },
    price: { display: `$${500 + n * 100 + i * 10} per week` },
    title: n === 2 && i === 0 ? 'Renovated with pool' : 'Nice place',
  })),
  surrounding: n === 1 ? [listing({ id: '146599901', address: { suburb: 'Tamarama', display: { fullAddress: '9 Near St, Tamarama' } } })] : [],
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
    if (!u.pathname.startsWith('/rent/')) return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body><main>home</main></body></html>' });
    const n = +(u.pathname.match(/list-(\d+)/)?.[1] || 1);
    hits.push(n);
    return route.fulfill({ status: 200, contentType: 'text/html', body: html(n) });
  });
  // Enter via the homepage: script loads there dormant, then activates on SPA nav to /rent/.
  await page.goto(`${ORIGIN}/`);
  await page.addScriptTag({ content: SCRIPT });
  assert.equal(await page.$eval('#rf-launch', (b) => b.hidden), true, 'launcher hidden off /rent/');
  await page.evaluate((u) => history.pushState({}, '', u), SEARCH);
  assert.equal(await page.$eval('#rf-launch', (b) => b.hidden), false, 'launcher shown after SPA nav');

  await page.goto(SEARCH);
  await page.addScriptTag({ content: SCRIPT });

  // Badges from the boot document, no search run yet.
  await page.waitForFunction(() => document.querySelectorAll('article > .rf-badge').length === 3, null, { timeout: 5000 });
  assert.ok(await page.$$eval('article', (els) => els.every((e) => 'rfPos' in e.dataset)), 'static cards anchored');
  console.log('boot badges:', await page.$$eval('article > .rf-badge', (els) => els.map((e) => e.textContent).join(' | ')));

  // SPA navigation to page 2: REA swaps the cards and pushState()s; script fetches that page once.
  await page.evaluate((cards) => {
    history.pushState({}, '', location.pathname.replace('list-1', 'list-2'));
    document.querySelector('main').innerHTML = cards;
  }, html(2).match(/<main>(.*)<\/main>/s)[1]);
  await page.waitForFunction(() => document.querySelectorAll('article > .rf-badge').length === 2, null, { timeout: 5000 });
  assert.equal(hits.filter((n) => n === 2).length, 1, 'page 2 fetched once for annotation');

  // React-style re-render wiping our badge gets re-annotated.
  await page.evaluate(() => { const a = document.querySelector('article'); a.outerHTML = a.outerHTML.replace(/<div class="rf-badge".*?<\/div>(?=<\/article>)/s, ''); });
  await page.waitForFunction(() => document.querySelectorAll('article > .rf-badge').length === 2, null, { timeout: 5000 });

  // A page that mutates every 50ms (carousel/ad) must not starve annotation.
  await page.evaluate(() => {
    window.__tick = setInterval(() => { const d = document.createElement('i'); document.body.appendChild(d); d.remove(); }, 50);
    document.querySelector('article > .rf-badge')?.remove();
  });
  await page.waitForFunction(() => document.querySelectorAll('article > .rf-badge').length === 2, null, { timeout: 3000 });

  // Agent link (long trailing number) before the listing link doesn't hide the badge.
  await page.evaluate(() => {
    const a = document.querySelector('article');
    a.insertAdjacentHTML('afterbegin', '<a href="/agent/jane-smith-1234567">agent</a>');
  });
  await page.waitForTimeout(700);
  assert.equal(await page.$$eval('article > .rf-badge', (els) => els.length), 2, 'agent link ignored');

  // React reusing the <article> and swapping only href: badge follows the new listing.
  const badgeBefore = await page.$eval('article > .rf-badge', (b) => b.textContent);
  await page.evaluate(() => {
    const [first, second] = document.querySelectorAll('article');
    const other = second.querySelector('a[href*="/property-"]').getAttribute('href');
    first.querySelectorAll('a[href*="/property-"]').forEach((l) => l.setAttribute('href', other));
  });
  await page.waitForFunction((b) => document.querySelector('article > .rf-badge').textContent !== b, badgeBefore, { timeout: 3000 });
  await page.evaluate(() => clearInterval(window.__tick));

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
  await page.waitForFunction(() => [...document.querySelectorAll('article')].some((e) => e.dataset.rfMatch), null, { timeout: 5000 });
  const dim = await page.$$eval('article', (els) => els.map((e) => e.dataset.rfMatch));
  console.log('dim flags on visible page:', dim.join(','));
  assert.ok(dim.every((d) => d === '0' || d === '1'));
  assert.equal(hits.filter((n) => n === 2).length, 1, 'page 2 not refetched by search');
  console.log('from 2026-10-01:', dated.join(' | '));
  assert.ok(dated.every((t) => !/now|Contact/i.test(t)));

  await page.click('#rf-more summary');
  await page.fill('#rf-keyword', 'pool');
  await page.dispatchEvent('#rf-keyword', 'change');
  assert.equal(await page.$$eval('.rf-card', (els) => els.length), 1);
  await page.fill('#rf-keyword', '');
  await page.dispatchEvent('#rf-keyword', 'change');

  await page.fill('#rf-to', '2026-09-01');
  await page.dispatchEvent('#rf-to', 'change');
  assert.match(await page.textContent('.rf-status'), /after/);
  await page.fill('#rf-to', '');
  await page.dispatchEvent('#rf-to', 'change');

  // Shortlist + hide from the drawer; persisted and reflected on REA cards.
  const firstId = await page.$eval('.rf-item', (el) => el.dataset.id);
  await page.hover('.rf-item');
  await page.click('.rf-item >> [data-act=s]');
  assert.equal(await page.$eval(`.rf-item[data-id="${firstId}"] [data-act=s]`, (b) => b.getAttribute('aria-pressed')), 'true');
  const secondId = await page.$eval('.rf-item:nth-child(2)', (el) => el.dataset.id);
  await page.hover('.rf-item:nth-child(2)');
  await page.click('.rf-item:nth-child(2) >> [data-act=h]');
  assert.equal(await page.$(`.rf-item[data-id="${secondId}"]`), null, 'hidden listing removed');
  assert.match(await page.textContent('.rf-status'), /1 hidden/);
  await page.check('#rf-onlyStarred');
  assert.deepEqual(await page.$$eval('.rf-item', (els) => els.map((e) => e.dataset.id)), [firstId]);
  await page.uncheck('#rf-onlyStarred');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('rea-avail-filter/marks/v1')).m);
  assert.equal(stored[firstId].s, 1);
  assert.equal(stored[secondId].h, 1);
  // Unhide via "Show hidden listings".
  await page.check('#rf-showHidden');
  await page.hover(`.rf-item[data-id="${secondId}"]`);
  await page.click(`.rf-item[data-id="${secondId}"] >> [data-act=h]`);
  await page.uncheck('#rf-showHidden');
  assert.ok(await page.$(`.rf-item[data-id="${secondId}"]`), 'unhidden listing back');

  await page.click('.rf-clear');
  assert.equal(await page.inputValue('#rf-from'), '');
  assert.equal(await page.$$eval('.rf-card', (els) => els.length), PAGES * 2 + 1);
  assert.match(await page.textContent('#rf-launch'), /\(7\)/);
  await page.fill('#rf-from', '2026-10-01');
  await page.dispatchEvent('#rf-from', 'change');

  // Export: capture download.
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-export=tsv]')]);
  const body = fs.readFileSync(await dl.path(), 'utf8');
  console.log('export:', dl.suggestedFilename(), body.split('\n').length - 1, 'rows');
  const [csv] = await Promise.all([page.waitForEvent('download'), page.click('[data-export=csv]')]);
  const csvBody = fs.readFileSync(await csv.path(), 'utf8');
  assert.ok(csvBody.startsWith('\ufeffavailable_date,'), 'csv has BOM + header');

  // Refresh bypasses the seed and memo: every page refetched once.
  const pre = hits.length;
  await page.click('#rf-refresh');
  await page.waitForFunction(() => !document.querySelector('#rf-refresh').disabled, null, { timeout: 15000 });
  assert.deepEqual(hits.slice(pre).sort(), [1, 2, 3], 'refresh refetched all pages');

  // Reload: rows restored from session cache without refetching.
  const before = hits.length;
  await page.reload();
  await page.addScriptTag({ content: SCRIPT });
  await page.waitForFunction(() => /Cached/.test(document.querySelector('.rf-status')?.textContent || ''), null, { timeout: 5000 });
  assert.equal(hits.length, before + 1, 'only the reloaded document itself was fetched');

  await page.click('#rf-launch');
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('#rf-panel', (p) => p.hidden), true);
  assert.equal(await page.getAttribute('#rf-launch', 'aria-expanded'), 'false');

  const probed = await page.evaluate(() => window.reaFilter.probe());
  assert.equal(probed['availableDate.display'] !== '(missing)', true);

  // Navigating to another search mid-crawl aborts it: no further page fetches, UI usable.
  {
    const slow = await browser.newPage();
    const got = [];
    await slow.route('**/*', async (route) => {
      const u = new URL(route.request().url());
      if (u.origin !== ORIGIN) return route.fulfill({ status: 204, body: '' });
      got.push(u.pathname);
      if (got.length > 1) await new Promise((r) => setTimeout(r, 400));
      const n = +(u.pathname.match(/list-(\d+)/)?.[1] || 1);
      const r = results({ exact: [listing({ id: `14700000${n}` })], maxPage: 10 });
      return route.fulfill({ status: 200, contentType: 'text/html', body: `<html><body><script>window.ArgonautExchange=${JSON.stringify(exchange(r))};</script></body></html>` }).catch(() => {});
    });
    await slow.goto(SEARCH);
    await slow.addScriptTag({ content: SCRIPT });
    await slow.click('#rf-launch');
    await slow.click('#rf-run');
    await slow.waitForFunction(() => /page 2/.test(document.querySelector('.rf-status').textContent));
    await slow.evaluate(() => history.pushState({}, '', '/rent/in-manly,+nsw+2095/list-1'));
    const at = got.length;
    await slow.waitForTimeout(2500);
    console.log('fetches after nav-abort:', got.length - at, '| status:', await slow.textContent('.rf-status'));
    assert.ok(got.length - at <= 2, 'crawl stopped (annotation may fetch the new page once)');
    assert.equal(await slow.$eval('#rf-run', (b) => b.disabled), false);
    await slow.close();
  }

  assert.deepEqual(errors, [], 'no page errors');
  await browser.close();
  console.log('e2e smoke: ok');
})().catch((e) => { console.error(e); process.exit(1); });

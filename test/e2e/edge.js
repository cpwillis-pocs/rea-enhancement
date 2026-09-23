'use strict';
// Edge paths the main smoke flow doesn't reach: boot fallback, clipboard, mobile focus
// trap, validation messages, crawl failure, cross-tab sync. Fixture pages only.
const path = require('path');
const fs = require('fs');
const assert = require('node:assert/strict');
const { execSync } = require('child_process');
let pw;
try { pw = require('playwright'); } catch { pw = require(path.join(execSync('npm root -g').toString().trim(), 'playwright')); }
const { ORIGIN, serve, reaPage } = require('./fixtures');
const cov = require('./coverage');

const SCRIPT = fs.readFileSync(path.join(__dirname, '../../rea-availability-filter.user.js'), 'utf8').replace('const PAGE_DELAY_MS = 600;', 'const PAGE_DELAY_MS = 0;');
const SEARCH = `${ORIGIN}/rent/in-bondi,+nsw+2026/list-1`;
const FIXED = new Date('2026-09-23T10:00:00+10:00');
const status = (p) => p.textContent('.rf-status');
const waitStatus = (p, re, timeout = 15000) => p.waitForFunction((src) => new RegExp(src).test(document.querySelector('.rf-status').textContent), re.source, { timeout });

(async () => {
  const browser = await pw.chromium.launch();
  const errors = [];
  const open = async (ctx, url = SEARCH, { route = serve() } = {}) => {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.clock.install({ time: FIXED });
    await cov.track(page);
    await page.route('**/*', route);
    await page.goto(url);
    await page.addScriptTag({ content: SCRIPT });
    return page;
  };
  const done = async (page) => { await cov.collect(page, SCRIPT); await page.close(); };

  // 1. Boot fallback: global already consumed by the app, data read from the <script> tag.
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await cov.track(page);
    await page.route('**/*', serve());
    await page.goto(SEARCH);
    await page.evaluate(() => { delete window.ArgonautExchange; });
    await page.addScriptTag({ content: SCRIPT });
    await page.waitForSelector('article > .rf-badge', { timeout: 5000 });
    console.log('boot fallback from <script> tag: ok');
    await done(page); await ctx.close();
  }

  // 2. Clipboard: granted -> async API; denied -> execCommand fallback or clear message.
  {
    const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await open(ctx);
    await page.click('#rf-launch'); await page.click('#rf-run');
    await waitStatus(page, /listings match/);
    await page.click('.rf-exports [data-export=copy]');
    await waitStatus(page, /Copied \d+ rows/);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    assert.ok(clip.startsWith('available_date\tavailable\t'), 'TSV on clipboard');
    await done(page); await ctx.close();

    const ctx2 = await browser.newContext();
    const p2 = await open(ctx2);
    await p2.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) } }); });
    await p2.click('#rf-launch'); await p2.click('#rf-run');
    await waitStatus(p2, /listings match/);
    await p2.click('.rf-exports [data-export=copy]');
    await waitStatus(p2, /Copied|Clipboard blocked/);
    console.log('clipboard fallback:', await status(p2));
    await done(p2); await ctx2.close();
  }

  // 3. Validation messages and the tab switch back with nothing searched.
  {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await page.click('#rf-launch');
    await page.click('[data-view=shortlist]');
    await page.click('[data-view=results]');
    assert.match(await page.textContent('.rf-list'), /Set your dates/);
    await page.click('#rf-run');
    await waitStatus(page, /listings match/);
    await page.selectOption('#rf-withinDays', '14');
    await page.fill('#rf-from', '2026-12-01'); await page.dispatchEvent('#rf-from', 'change');
    assert.match(await status(page), /after the "within" window/);
    await page.selectOption('#rf-withinDays', ''); await page.fill('#rf-from', ''); await page.dispatchEvent('#rf-from', 'change');
    await page.click('#rf-more summary');
    await page.fill('#rf-priceMin', '900'); await page.fill('#rf-priceMax', '500'); await page.dispatchEvent('#rf-priceMax', 'change');
    assert.match(await status(page), /Min \$\/wk is above max/);
    console.log('validation messages: ok');
    await done(page); await ctx.close();
  }

  // 4. Crawl failure: page 2 is a bot-check interstitial.
  {
    const ctx = await browser.newContext();
    const base = serve([], { pages: 3 });
    const page = await open(ctx, SEARCH, { route: (route) => (/list-2/.test(route.request().url())
      ? route.fulfill({ status: 200, contentType: 'text/html', body: '<html>Please verify you are human</html>' }) : base(route)) });
    await page.click('#rf-launch'); await page.click('#rf-run');
    await waitStatus(page, /bot-check/);
    assert.match(await page.textContent('.rf-list'), /Search failed/);
    assert.notEqual(await page.getAttribute('#rf-run', 'aria-disabled'), 'true', 'usable after failure');
    console.log('crawl failure:', await status(page));
    await done(page); await ctx.close();
  }

  // 5. Mobile: drawer is modal and Tab wraps inside it.
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await open(ctx);
    await page.click('#rf-launch');
    assert.equal(await page.getAttribute('#rf-panel', 'aria-modal'), 'true');
    await page.focus('.rf-x');
    await page.keyboard.press('Shift+Tab'); // from first focusable backwards -> wraps to last
    const inside = await page.evaluate(() => document.getElementById('rf-panel').contains(document.activeElement));
    assert.ok(inside, 'focus stays in the drawer');
    for (let i = 0; i < 60; i++) await page.keyboard.press('Tab');
    assert.ok(await page.evaluate(() => document.getElementById('rf-panel').contains(document.activeElement)), 'Tab never leaves');
    console.log('mobile focus trap: ok');
    await done(page); await ctx.close();
  }

  // 6. Cross-tab: starring in one tab updates the other's counts via the storage event.
  {
    const ctx = await browser.newContext();
    const a = await open(ctx), b = await open(ctx);
    for (const p of [a, b]) { await p.click('#rf-launch'); }
    await a.click('#rf-run'); await waitStatus(a, /listings match/);
    const id = await a.$eval('.rf-item', (el) => el.dataset.id);
    await a.hover('.rf-item'); await a.click('.rf-item >> [data-act=s]');
    await b.waitForFunction(() => /\(1\)/.test(document.querySelector('.rf-count').textContent), null, { timeout: 5000 });
    await b.click('[data-view=shortlist]');
    assert.deepEqual(await b.$$eval('.rf-item', (els) => els.map((e) => e.dataset.id)), [id]);
    console.log('cross-tab sync: ok');
    await done(a); await done(b); await ctx.close();
  }

  // 7. Emptying the list via marks must not resurrect stale rows (render([]) keeps ui.rows in sync).
  {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await page.click('#rf-launch'); await page.click('#rf-run'); await waitStatus(page, /listings match/);
    await page.hover('.rf-item'); await page.click('.rf-item >> [data-act=s]');
    await page.click('#rf-more summary'); await page.check('#rf-onlyStarred');
    assert.equal(await page.$$eval('.rf-item', (e) => e.length), 1);
    await page.click('.rf-item >> [data-act=s]'); // unstar the only one
    assert.equal(await page.$$eval('.rf-item', (e) => e.length), 0, 'no stale rows under the empty message');
    assert.match(await page.textContent('.rf-list'), /Nothing matches/);
    console.log('empty after unstar: ok');
    await done(page); await ctx.close();
  }

  // 8. Corrupt saved settings and drifted item shapes don't stop the script.
  {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => localStorage.setItem('rea-avail-filter/v1', JSON.stringify({ keyword: null, sort: 5, from: 7 })));
    const page = await open(ctx);
    await page.click('#rf-launch'); await page.click('#rf-run'); await waitStatus(page, /listings match/);
    assert.equal(await page.evaluate(() => typeof window.reaFilter.probe), 'function');
    console.log('corrupt settings tolerated: ok');
    await done(page); await ctx.close();
  }

  // 9. Touch screens: action buttons visible without hover.
  {
    const ctx = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
    const page = await open(ctx);
    await page.click('#rf-launch'); await page.click('#rf-run'); await waitStatus(page, /listings match/);
    assert.equal(await page.$eval('.rf-acts', (a) => getComputedStyle(a).opacity), '1');
    console.log('touch actions visible: ok');
    await done(page); await ctx.close();
  }

  // 10. Move-in cost shown and filterable; high bond flagged.
  {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await page.click('#rf-launch'); await page.click('#rf-run'); await waitStatus(page, /listings match/);
    const txt = await page.textContent('.rf-list');
    assert.match(txt, /Move-in \$\d/);
    const total = await page.$$eval('.rf-item', (e) => e.length);
    await page.click('#rf-more summary');
    await page.fill('#rf-upfrontMax', '3000'); await page.dispatchEvent('#rf-upfrontMax', 'change');
    const capped = await page.$$eval('.rf-item', (e) => e.length);
    assert.ok(capped < total, `move-in cap filters (${capped} < ${total})`);
    console.log('move-in cost:', capped, 'of', total, 'under $3000');
    await page.fill('#rf-upfrontMax', ''); await page.dispatchEvent('#rf-upfrontMax', 'change');
    const med = await page.$$eval('.rf-med', (e) => e.map((x) => x.textContent));
    assert.ok(med.length > 0 && med.every((t) => /median/.test(t)), 'median comparisons shown');
    await page.selectOption('#rf-sort', 'value');
    const first = await page.textContent('.rf-item .rf-med');
    assert.match(first, /below median/, 'best value first');
    console.log('median:', med.length, 'listings compared; first by value:', first);
    await done(page); await ctx.close();
  }

  // 11. Application status on a shortlisted listing; shortlist filter by status; export column.
  {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await page.click('#rf-launch'); await page.click('#rf-run'); await waitStatus(page, /listings match/);
    const ids = await page.$$eval('.rf-item', (e) => e.slice(0, 2).map((x) => x.dataset.id));
    for (const id of ids) { await page.hover(`.rf-item[data-id="${id}"]`); await page.click(`.rf-item[data-id="${id}"] >> [data-act=s]`); }
    await page.selectOption(`.rf-item[data-id="${ids[0]}"] select[data-app]`, 'applied');
    assert.equal(await page.evaluate(() => document.activeElement.matches('select[data-app]')), true, 'focus kept on the select');
    await page.click('[data-view=shortlist]');
    await page.selectOption('.rf-sl-filter', 'applied');
    assert.deepEqual(await page.$$eval('.rf-item', (e) => e.map((x) => x.dataset.id)), [ids[0]]);
    await page.selectOption('.rf-sl-filter', '-');
    assert.deepEqual(await page.$$eval('.rf-item', (e) => e.map((x) => x.dataset.id)), [ids[1]]);
    await page.selectOption('.rf-sl-filter', '');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.rf-sl-bar [data-export=csv]')]);
    const csv = fs.readFileSync(await dl.path(), 'utf8');
    assert.equal(csv.trim().split('\r\n').length, 3, 'shortlist export = header + 2 shortlisted');
    assert.ok(csv.split('\r\n')[0].includes('application') && csv.includes(',applied,'), 'status in CSV');
    console.log('application tracker: ok');
    await done(page); await ctx.close();
  }

  // 12. Calendar export from results and from the shortlist (inspections kept with the star).
  {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await page.click('#rf-launch'); await page.click('#rf-run'); await waitStatus(page, /listings match/);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.rf-exports [data-export=ics]')]);
    const ics = fs.readFileSync(await dl.path(), 'utf8');
    const n = (ics.match(/BEGIN:VEVENT/g) || []).length;
    assert.ok(dl.suggestedFilename().endsWith('.ics') && n > 0, 'results calendar has events');
    const withInsp = await page.$$eval('.rf-item', (els) => els.find((e) => /Inspect /.test(e.textContent))?.dataset.id);
    await page.hover(`.rf-item[data-id="${withInsp}"]`); await page.click(`.rf-item[data-id="${withInsp}"] >> [data-act=s]`);
    await page.click('[data-view=shortlist]');
    const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('.rf-sl-bar [data-export=ics]')]);
    const ics2 = fs.readFileSync(await dl2.path(), 'utf8');
    assert.equal((ics2.match(/BEGIN:VEVENT/g) || []).length, 1, 'shortlist calendar = the one shortlisted inspection');
    console.log('calendar export:', n, 'events from results, 1 from shortlist');
    await done(page); await ctx.close();
  }

  // 13. Amenity chips: require / exclude cycle, tags shown, REA badge for pets, Clear resets.
  {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await page.click('#rf-launch'); await page.click('#rf-run'); await waitStatus(page, /listings match/);
    const total = await page.$$eval('.rf-item', (e) => e.length);
    await page.click('#rf-more summary');
    await page.click('[data-amen=pets]');
    assert.equal(await page.getAttribute('[data-amen=pets]', 'aria-label'), 'Pets: required');
    const withPets = await page.$$eval('.rf-item', (e) => e.length);
    assert.ok(withPets > 0 && withPets < total, `pets required: ${withPets}/${total}`);
    assert.ok(await page.$$eval('.rf-item .rf-tags', (e) => e.every((t) => /Pets OK/.test(t.textContent))));
    await page.click('[data-amen=pets]');
    assert.equal(await page.getAttribute('[data-amen=pets]', 'aria-label'), 'Pets: excluded');
    const noPets = await page.$$eval('.rf-item', (e) => e.length);
    assert.equal(noPets, total - withPets);
    assert.ok(await page.$('article > .rf-badge .rf-b-pets'), 'Pets OK badge on an REA card');
    await page.click('.rf-clear');
    assert.equal(await page.getAttribute('[data-amen=pets]', 'aria-label'), 'Pets: any');
    assert.equal(await page.$$eval('.rf-item', (e) => e.length), total);
    console.log('amenities:', withPets, 'with pets,', noPets, 'without, of', total);
    await done(page); await ctx.close();
  }

  // 14. Distance: paste coordinates, see km, cap it, sort nearest; bad input explained.
  {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await page.click('#rf-launch'); await page.click('#rf-run'); await waitStatus(page, /listings match/);
    await page.click('#rf-more summary');
    await page.fill('#rf-anchor', 'Somewhere'); await page.dispatchEvent('#rf-anchor', 'change');
    assert.match(await status(page), /coordinates in Australia/);
    await page.fill('#rf-anchor', 'https://www.google.com/maps/@-33.8915,151.2767,15z'); await page.dispatchEvent('#rf-anchor', 'change');
    assert.match(await page.textContent('.rf-list'), /(m|km) away/);
    await page.selectOption('#rf-sort', 'distance');
    const first = await page.textContent('.rf-item .rf-meta:has-text("away")');
    assert.match(first, /^0 m away|^\d+ m away/, `nearest first: ${first}`);
    await page.fill('#rf-maxKm', '2'); await page.dispatchEvent('#rf-maxKm', 'change');
    const n = await page.$$eval('.rf-item', (e) => e.length);
    assert.ok(n > 0 && n < 18, `within 2 km: ${n}`);
    await page.waitForFunction(() => [...document.querySelectorAll('article > .rf-badge')].some((b) => / (k)?m$|\d m|km/.test(b.textContent)), null, { timeout: 3000 });
    console.log('distance:', n, 'within 2 km; nearest', first);
    await done(page); await ctx.close();
  }

  // 15. Agency hide (with undo + unhide chip) and floorplan filter.
  {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await page.click('#rf-launch'); await page.click('#rf-run'); await waitStatus(page, /listings match/);
    const total = await page.$$eval('.rf-item', (e) => e.length);
    await page.hover('.rf-item'); await page.click('.rf-item >> [data-act=ag]');
    assert.match(await status(page), /Hidden all listings from/);
    const after = await page.$$eval('.rf-item', (e) => e.length);
    assert.equal(after, total - 6, 'one of three agencies hidden');
    await page.click('.rf-status .rf-undo');
    assert.equal(await page.$$eval('.rf-item', (e) => e.length), total);
    await page.hover('.rf-item'); await page.click('.rf-item >> [data-act=ag]');
    await page.click('#rf-more summary');
    assert.equal(await page.$eval('.rf-agencies', (b) => b.hidden), false);
    await page.click('[data-unhide-ag]');
    assert.equal(await page.$$eval('.rf-item', (e) => e.length), total);
    assert.equal(await page.$eval('.rf-agencies', (b) => b.hidden), true);
    await page.check('#rf-floorplanOnly');
    assert.equal(await page.$$eval('.rf-item', (e) => e.length), total / 2);
    assert.match(await page.textContent('.rf-item'), /photos · floorplan/);
    console.log('agency hide + floorplan: ok');
    await done(page); await ctx.close();
  }

  assert.deepEqual(errors, [], 'no page errors');
  cov.report(SCRIPT);
  await browser.close();
  console.log('e2e edge: ok');
})().catch((e) => { console.error(e); process.exit(1); });

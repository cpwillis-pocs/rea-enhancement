'use strict';
// Edge paths the main smoke flow doesn't reach: boot fallback, clipboard, mobile focus
// trap, validation messages, crawl failure, cross-tab sync. Fixture pages only.
const path = require('path');
const fs = require('fs');
const assert = require('node:assert/strict');
const { execSync } = require('child_process');
const harness = require('./harness');
const { AsyncLocalStorage } = require('node:async_hooks');
let pw;
try { pw = require('playwright'); } catch { pw = require(path.join(execSync('npm root -g').toString().trim(), 'playwright')); }
const { ORIGIN, serve, reaPage } = require('./fixtures');
const shapeKit = require('../helpers'); // listingFromShape, results, page: e2e from real REA shapes
const cov = require('./coverage');

const SCRIPT = fs.readFileSync(path.join(__dirname, '../../rea-availability-filter.user.js'), 'utf8').replace('const PAGE_DELAY_MS = 600;', 'const PAGE_DELAY_MS = 0;');
const SEARCH = `${ORIGIN}/rent/in-bondi,+nsw+2026/list-1`;
const FIXED = new Date('2026-09-23T10:00:00+10:00');
const status = (p) => p.textContent('.rf-status');
const waitStatus = (p, re, timeout = 15000) => p.waitForFunction((src) => new RegExp(src).test(document.querySelector('.rf-status').textContent), re.source, { timeout });
const run = async (p) => { await p.click('#rf-launch'); await p.click('#rf-run'); await waitStatus(p, /listings match/); await settle(p); }; // open the drawer and search
// One task later: the remembered search is written after the results paint.
const settle = (p) => p.evaluate(() => new Promise((r) => setTimeout(r, 0)));
// Drawer results render synchronously on change; the fixtures (18 rows) stay under one render chunk.
const count = (p, sel = '.rf-item') => p.$$eval(sel, (e) => e.length);
const MARKS_KEY = 'rea-avail-filter/marks/v1';
const marks = (p) => p.evaluate((k) => JSON.parse(localStorage.getItem(k) || '{"m":{}}').m, MARKS_KEY);

(async () => {
  const browser = harness.watch(await pw.chromium.launch());
  // A request no page route answers (a page opened without one, a reload race) gets an empty reply
  // here rather than going out to the real site: it would hang on the network and flake the block.
  // Page routes are consulted before this context-wide one.
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (opts) => {
    const c = await newContext({ timezoneId: 'Australia/Sydney', ...opts }); // FIXED is 10am Sydney: dates asserted as a Sydney renter sees them, whatever TZ the machine is in
    const id = blockOf.getStore();
    if (id != null) (opened.get(id) || opened.set(id, []).get(id)).push(c); // closed if the block fails, before a retry
    await c.route('**/*', (r) => (process.env.E2E_STRAY && console.log(`stray: ${r.request().url()}`), r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>stray</title>' }))); // 200, not 204: a 204 cancels a popup's navigation
    return c;
  };
  const errors = []; // { id, msg }: page errors, tagged with the block that opened the page
  const opened = new Map(); // block id -> its browser contexts
  const blockOf = new AsyncLocalStorage(); // which block is running, even with E2E_JOBS > 1
  // `before` runs after the page loads and before the script is added (eg to consume REA's global).
  const open = async (ctx, url = SEARCH, { route = serve(), before } = {}) => {
    const page = await ctx.newPage();
    const id = blockOf.getStore() ?? current;
    page.on('pageerror', (e) => errors.push({ id, msg: `[${id}] ${e.message}` }));
    await page.clock.install({ time: FIXED });
    await cov.track(page);
    await page.route('**/*', route);
    await page.goto(url);
    if (before) await before(page);
    await page.addScriptTag({ content: SCRIPT });
    await page.waitForSelector('#rf-panel[data-rf-ready]', { state: 'attached', timeout: 5000 }).catch(() => {}); // startup runs over three tasks
    return page;
  };
  // Save a preset: pick Save from the menu, type the name in the field that opens, Enter.
  const presetSave = async (page, kind, name) => { await page.selectOption('.rf-preset', kind); await page.fill('.rf-preset-name', name); await page.press('.rf-preset-name', 'Enter'); };
  const done = async (page) => { await cov.collect(page, SCRIPT); await page.close(); };

  // Each numbered scenario is a block: E2E_ONLY=24l,26 runs just those; a failure (or a page
  // error it caused) names its block, and the run goes on so every failing block is reported at
  // the end. E2E_RETRY=1 runs a failed block once more and reports it as flaky if it then passes
  // (still a failure to fix, not a pass to ignore). E2E_TIMES=1 prints each block's duration; the
  // ten slowest are always listed. E2E_JOBS=n runs n blocks at once (each has its own browser
  // context); CI runs three at a time (ci.yml).
  const only = process.env.E2E_ONLY ? process.env.E2E_ONLY.split(',').map((x) => x.trim()).filter(Boolean) : null;
  const jobs = Math.max(1, Math.min(8, +process.env.E2E_JOBS || 1));
  let current = '', ran = 0;
  const queue = [], failed = [], flaky = [], times = [];
  const attempt = (id, fn) => blockOf.run(id, async () => {
    current = id; harness.section(id);
    await fn();
    assert.deepEqual(errors.filter((e) => e.id === id).map((e) => e.msg), [], `no page errors in block ${id}`);
  });
  const runBlock = async (id, fn) => {
    ran++;
    const t = Date.now();
    try {
      await attempt(id, fn);
    } catch (e) {
      console.error(`block ${id} failed: ${e.stack || e}`);
      let again = null;
      if (process.env.E2E_RETRY) {
        // The failed attempt's pages could still throw and be counted against the retry: close them
        // (without a retry they stay open, for the failure screenshots).
        for (const c of opened.get(id) || []) await c.close().catch(() => {});
        opened.delete(id);
        for (let i = errors.length - 1; i >= 0; i--) if (errors[i].id === id) errors.splice(i, 1);
        try { await attempt(id, fn); } catch (e2) { again = e2; }
      }
      if (process.env.E2E_RETRY && !again) flaky.push(id); else failed.push(`[block ${id}] ${String((again || e).message).split('\n')[0]}`);
    }
    opened.delete(id);
    times.push([id, Date.now() - t]);
    if (process.env.E2E_TIMES) console.log(`  block ${id}: ${Date.now() - t}ms`);
  };
  const block = async (id, fn) => {
    if (only && !only.includes(id)) return;
    if (jobs > 1) queue.push({ id, fn }); else await runBlock(id, fn);
  };
  const drain = () => Promise.all(Array.from({ length: jobs }, async () => { for (let b; (b = queue.shift());) await runBlock(b.id, b.fn); }));

  // 1. Boot fallback: global already consumed by the app, data read from the <script> tag.
  await block('1', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx, SEARCH, { before: (p) => p.evaluate(() => { delete window.ArgonautExchange; }) });
    await page.waitForSelector('article > .rf-badge', { timeout: 5000 });
    console.log('boot fallback from <script> tag: ok');
    await done(page); await ctx.close();
  });

  // 2. Clipboard: granted -> async API; denied -> execCommand fallback or clear message.
  await block('2', async () => {
    const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await open(ctx);
    await run(page);
    await page.click('.rf-exports [data-export=copy]');
    await waitStatus(page, /Copied \d+ rows/);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    assert.ok(clip.startsWith('available_date\tavailable\t'), 'TSV on clipboard');
    await done(page); await ctx.close();

    const ctx2 = await browser.newContext();
    const p2 = await open(ctx2);
    await p2.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) } }); });
    await run(p2);
    await p2.click('.rf-exports [data-export=copy]');
    await waitStatus(p2, /Copied/); // Chromium still has the execCommand fallback
    console.log('clipboard fallback:', await status(p2));
    await done(p2); await ctx2.close();
  });

  // 3. Validation messages and the tab switch back with nothing searched.
  await block('3', async () => {
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
    await page.click('#rf-more summary'); await settle(page); // the press ends a task later (it holds renders until then)
    await page.fill('#rf-priceMin', '900'); await page.fill('#rf-priceMax', '500'); await page.dispatchEvent('#rf-priceMax', 'change');
    assert.match(await status(page), /Min \$\/wk is above max/);
    console.log('validation messages: ok');
    await done(page); await ctx.close();
  });

  // 4. Crawl failure: page 2 is a bot-check interstitial, which also pauses fetching.
  await block('4', async () => {
    const ctx = await browser.newContext();
    const base = serve([], { pages: 3 });
    let blocked = true;
    const hits = [];
    const page = await open(ctx, SEARCH, { route: (route) => {
      const u = route.request().url();
      if (/\/list-\d/.test(u)) hits.push(u.match(/list-(\d)/)[1]);
      return blocked && /list-2/.test(u) ? route.fulfill({ status: 200, contentType: 'text/html', body: '<html>Please verify you are human</html>' }) : base(route);
    } });
    await page.click('#rf-launch'); await page.click('#rf-run');
    await page.waitForSelector('.rf-partial:not([hidden])');
    assert.match(await page.textContent('.rf-partial'), /Read 1 of 3 pages; page 2 failed \(.*bot-check/);
    assert.equal(await count(page), 6, 'page 1 kept');
    assert.equal(await page.evaluate(() => localStorage.getItem('rea-avail-filter/snapshots/v1')), null, 'a partial crawl is not remembered');
    assert.notEqual(await page.getAttribute('#rf-run', 'aria-disabled'), 'true', 'usable after failure');
    assert.match(await page.textContent('.rf-warn-msg'), /bot check, so fetching is paused until/, 'the bot check pauses fetching');
    assert.ok(await page.evaluate(() => +localStorage.getItem('rea-avail-filter/paused') > Date.now()));
    blocked = false; hits.length = 0;
    await page.click('.rf-partial [data-resume]');
    await waitStatus(page, /^Paused:/);
    assert.ok(await page.$('.rf-partial:not([hidden]) [data-resume]'), 'Resume stays offered');
    assert.deepEqual(hits, [], 'nothing fetched while paused');
    await page.evaluate(() => localStorage.removeItem('rea-avail-filter/paused')); // the 10 minutes are up
    await page.click('.rf-partial [data-resume]');
    await waitStatus(page, /18 listings match|of 18 listings match/);
    assert.ok(await page.$('.rf-partial[hidden]'), 'resume clears the notice');
    assert.ok(!hits.includes('1'), `page 1 not fetched again (${hits})`);
    assert.ok(await page.evaluate(() => localStorage.getItem('rea-avail-filter/snapshots/v1')), 'complete crawl remembered');
    console.log('crawl failure keeps page 1, resume completes: ok');
    await done(page); await ctx.close();
  });

  // 5. Mobile: drawer is modal and Tab wraps inside it.
  await block('5', async () => {
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
  });

  // 6. Cross-tab: starring in one tab updates the other's counts via the storage event.
  await block('6', async () => {
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
  });

  // 7. Emptying the list via marks must not resurrect stale rows (render([]) keeps ui.rows in sync).
  await block('7', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await run(page);
    await page.hover('.rf-item'); await page.click('.rf-item >> [data-act=s]');
    await page.click('#rf-more summary'); await settle(page); await page.check('#rf-onlyStarred');
    assert.equal(await count(page), 1);
    await page.click('.rf-item >> [data-act=s]'); // unstar the only one
    assert.equal(await count(page), 0, 'no stale rows under the empty message');
    assert.match(await page.textContent('.rf-list'), /Nothing matches/);
    console.log('empty after unstar: ok');
    await done(page); await ctx.close();
  });

  // 8. Corrupt saved settings and drifted item shapes don't stop the script.
  await block('8', async () => {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => localStorage.setItem('rea-avail-filter/v1', JSON.stringify({ keyword: null, sort: 5, from: 7 })));
    const page = await open(ctx);
    await run(page);
    assert.equal(await page.evaluate(() => typeof window.reaFilter.probe), 'function');
    console.log('corrupt settings tolerated: ok');
    await done(page); await ctx.close();
  });

  // 9. Touch screens: action buttons visible without hover.
  await block('9', async () => {
    const ctx = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
    const page = await open(ctx);
    await run(page);
    assert.equal(await page.$eval('.rf-acts', (a) => getComputedStyle(a).opacity), '1');
    console.log('touch actions visible: ok');
    await done(page); await ctx.close();
  });

  // 10. Move-in cost shown and filterable; high bond flagged.
  await block('10', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await run(page);
    const txt = await page.textContent('.rf-list');
    assert.match(txt, /Move-in \$\d/);
    const total = await count(page);
    // A cap at the median move-in cost must keep some listings and drop others.
    const ups = await page.evaluate(() => window.reaFilter.rows().map((r) => r.upfront).filter(Number.isFinite).sort((a, b) => a - b));
    const cap = ups[Math.floor(ups.length / 2)];
    await page.click('#rf-more summary'); await settle(page);
    await page.fill('#rf-upfrontMax', String(cap)); await page.dispatchEvent('#rf-upfrontMax', 'change');
    const capped = await count(page);
    assert.ok(capped > 0 && capped < total, `move-in cap filters (${capped} of ${total})`);
    console.log('move-in cost:', capped, 'of', total, `under $${cap}`);
    await page.fill('#rf-upfrontMax', ''); await page.dispatchEvent('#rf-upfrontMax', 'change');
    const med = await page.$$eval('.rf-med', (e) => e.map((x) => x.textContent));
    assert.ok(med.length > 0 && med.every((t) => /median/.test(t)), 'median comparisons shown');
    await page.selectOption('#rf-sort', 'value');
    const first = await page.textContent('.rf-item .rf-med');
    assert.match(first, /below [\w -]*median/, 'best value first');
    console.log('median:', med.length, 'listings compared; first by value:', first);
    await done(page); await ctx.close();
  });

  // 11. Application status on a shortlisted listing; shortlist filter by status; export column.
  await block('11', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    const other = await open(ctx); // a second tab on the same site
    await run(page);
    const ids = await page.$$eval('.rf-item', (e) => e.slice(0, 2).map((x) => x.dataset.id));
    for (const id of ids) { await page.hover(`.rf-item[data-id="${id}"]`); await page.click(`.rf-item[data-id="${id}"] >> [data-act=s]`); }
    await page.selectOption(`.rf-item[data-id="${ids[0]}"] select[data-app]`, 'applied');
    assert.equal(await page.evaluate(() => document.activeElement.matches('select[data-app]')), true, 'focus kept on the select');
    await page.waitForFunction(() => [...document.querySelectorAll('.rf-b-star')].some((b) => /Applied/.test(b.textContent)), null, { timeout: 5000 });
    await page.click('[data-view=shortlist]');
    await page.selectOption('.rf-sl-filter', 'applied');
    assert.deepEqual(await page.$$eval('.rf-item', (e) => e.map((x) => x.dataset.id)), [ids[0]]);
    await page.selectOption('.rf-sl-filter', '-');
    assert.deepEqual(await page.$$eval('.rf-item', (e) => e.map((x) => x.dataset.id)), [ids[1]]);
    await page.selectOption('.rf-sl-filter', '');
    const addr = await page.textContent(`.rf-item[data-id="${ids[1]}"] .rf-addr`);
    await page.fill('.rf-sl-q', addr.split(',')[0]);
    await page.waitForFunction((id) => [...document.querySelectorAll('.rf-item')].map((x) => x.dataset.id).join() === id, ids[1], { timeout: 3000 });
    assert.match(await status(page), /1 of 2 shortlisted/);
    await page.fill('.rf-sl-q', 'zzznomatch');
    await page.waitForSelector('.rf-empty:has-text("Nothing on the shortlist matches")');
    await page.focus('.rf-sl-q'); await page.keyboard.press('Escape');
    assert.equal(await page.inputValue('.rf-sl-q'), '', 'Esc clears the search');
    assert.ok(await page.isVisible('#rf-panel'), 'and leaves the drawer open');
    await page.waitForFunction(() => document.querySelectorAll('.rf-item').length === 2);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.rf-menu summary').then(() => page.click('.rf-sl-bar [data-export=csv]'))]);
    const csv = fs.readFileSync(await dl.path(), 'utf8');
    assert.equal(csv.trim().split('\r\n').length, 3, 'shortlist export = header + 2 shortlisted');
    assert.ok(csv.split('\r\n')[0].includes('application') && csv.includes(',applied,'), 'status in CSV');
    console.log('application tracker: ok');
    await done(page); await ctx.close();
  });

  // 12. Calendar export from results and from the shortlist (inspections kept with the star).
  await block('12', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await run(page);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.rf-exports [data-export=ics]')]);
    const ics = fs.readFileSync(await dl.path(), 'utf8');
    const n = (ics.match(/BEGIN:VEVENT/g) || []).length;
    assert.ok(dl.suggestedFilename().endsWith('.ics') && n > 0, 'results calendar has events');
    const withInsp = await page.$$eval('.rf-item', (els) => els.find((e) => /Inspect /.test(e.textContent))?.dataset.id);
    await page.hover(`.rf-item[data-id="${withInsp}"]`); await page.click(`.rf-item[data-id="${withInsp}"] >> [data-act=s]`);
    await page.click('[data-view=shortlist]');
    const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('.rf-menu summary').then(() => page.click('.rf-sl-bar [data-export=ics]'))]);
    const ics2 = fs.readFileSync(await dl2.path(), 'utf8');
    assert.equal((ics2.match(/BEGIN:VEVENT/g) || []).length, 1, 'shortlist calendar = the one shortlisted inspection');
    await page.selectOption(`.rf-item[data-id="${withInsp}"] select[data-app]`, 'applied');
    const [dl3] = await Promise.all([page.waitForEvent('download'), page.click('.rf-menu summary').then(() => page.click('.rf-sl-bar [data-export=ics]'))]);
    assert.match(fs.readFileSync(await dl3.path(), 'utf8'), new RegExp(`UID:${withInsp}-fu@rea-enhancement\\r\\n[\\s\\S]*?DTSTART;VALUE=DATE:\\d{8}`), 'applied: a follow-up reminder rides along');
    console.log('calendar export:', n, 'events from results, 1 from shortlist');
    await done(page); await ctx.close();
  });

  // 13. Amenity chips: require / exclude cycle, tags shown, REA badge for pets, Clear resets.
  await block('13', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await run(page);
    const total = await count(page);
    await page.click('#rf-more summary'); await settle(page);
    await page.click('[data-amen=pets]');
    assert.equal(await page.getAttribute('[data-amen=pets]', 'aria-label'), 'Pets: required');
    const withPets = await count(page);
    assert.ok(withPets > 0 && withPets < total, `pets required: ${withPets}/${total}`);
    assert.ok(await page.$$eval('.rf-item .rf-tags', (e) => e.every((t) => /Pets (OK|welcome|on application)/.test(t.textContent))));
    assert.match(await page.textContent('.rf-list'), /Pets on application/, 'the wording tells considered apart from welcome');
    await page.click('[data-amen=pets]');
    assert.equal(await page.getAttribute('[data-amen=pets]', 'aria-label'), 'Pets: excluded');
    const noPets = await count(page);
    assert.equal(noPets, total - withPets);
    // Badges are drawn asynchronously (debounced annotate): wait rather than check instantly.
    // On failure, dump what the cards and rows actually hold (CI failed here twice, not locally).
    await page.waitForSelector('article > .rf-badge .rf-b-pets', { timeout: 5000 }).catch(async (e) => {
      console.log('DIAG badges:', await page.$$eval('article', (a) => a.map((x) => `${x.dataset.rfId}:${x.querySelector('.rf-badge')?.textContent ?? '(none)'}`)));
      console.log('DIAG rows:', await page.evaluate(() => (window.reaFilter.rows() || []).slice(0, 6).map((r) => `${r.id} pets=${r.amen?.pets} text=${(r.text || '').slice(0, 60)}`)));
      throw e;
    });
    await page.click('.rf-clear');
    assert.equal(await page.getAttribute('[data-amen=pets]', 'aria-label'), 'Pets: any');
    assert.equal(await count(page), total);
    assert.ok(await page.$('.rf-watch span:has-text("Water usage charged")'), 'heads-up tag from description');
    await page.click('[data-nowatch=water]');
    assert.equal(await page.getAttribute('[data-nowatch=water]', 'aria-pressed'), 'true');
    assert.equal(await page.$('.rf-watch span:has-text("Water usage charged")'), null, 'hidden when excluded');
    assert.ok(await page.$('.rf-achip:has-text("No water usage charged")'), 'chip shown');
    await page.click('.rf-achip:has-text("No water usage charged")');
    assert.equal(await page.getAttribute('[data-nowatch=water]', 'aria-pressed'), 'false');
    console.log('amenities:', withPets, 'with pets,', noPets, 'without, of', total);
    await done(page); await ctx.close();
  });

  // 14. Distance: paste coordinates, see km, cap it, sort nearest; bad input explained.
  await block('14', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await run(page);
    await page.click('#rf-more summary'); await settle(page);
    await page.fill('#rf-anchor', 'Somewhere'); await page.dispatchEvent('#rf-anchor', 'change');
    assert.match(await status(page), /coordinates in Australia/);
    await page.fill('#rf-anchor', 'https://www.google.com/maps/@-33.8915,151.2767,15z'); await page.dispatchEvent('#rf-anchor', 'change');
    assert.match(await page.textContent('.rf-list'), /(m|km) away/);
    await page.selectOption('#rf-sort', 'distance');
    const first = await page.textContent('.rf-item .rf-meta:has-text("away")');
    assert.match(first, /^0 m away|^\d+ m away/, `nearest first: ${first}`);
    await page.fill('#rf-maxKm', '2'); await page.dispatchEvent('#rf-maxKm', 'change');
    const n = await count(page);
    assert.ok(n > 0 && n < 18, `within 2 km: ${n}`);
    await page.waitForFunction(() => [...document.querySelectorAll('article > .rf-badge')].some((b) => / (k)?m$|\d m|km/.test(b.textContent)), null, { timeout: 3000 });
    console.log('distance:', n, 'within 2 km; nearest', first);
    await page.fill('#rf-maxKm', ''); await page.dispatchEvent('#rf-maxKm', 'change');
    await page.fill('#rf-priceMax', '1500'); await page.dispatchEvent('#rf-priceMax', 'change');
    await page.selectOption('#rf-sort', 'match');
    // (with a budget + distance there are scores; the "needs two of" hint only shows without)
    const scores = await page.$$eval('.rf-score', (e) => e.map((x) => +x.textContent.replace(/\D/g, '')));
    assert.ok(scores.length > 3 && scores.every((v, i) => i === 0 || v <= scores[i - 1]), `best match sorted desc: ${scores.slice(0, 5)}`);
    assert.match(await page.getAttribute('.rf-score', 'title'), /rent vs budget \d+/);
    await done(page); await ctx.close();
  });

  // 15. Agency hide (with undo + unhide chip) and floorplan filter.
  await block('15', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await run(page);
    const total = await count(page);
    await page.click('.rf-item >> .rf-acts-more summary'); await page.click('.rf-item >> [data-act=ag]');
    assert.match(await status(page), /Hidden all listings from/);
    const after = await count(page);
    assert.equal(after, total - 6, 'one of three agencies hidden');
    await page.click('.rf-status .rf-undo');
    assert.equal(await count(page), total);
    await page.click('.rf-item >> .rf-acts-more summary'); await page.click('.rf-item >> [data-act=ag]');
    await page.click('#rf-more summary'); await settle(page);
    assert.equal(await page.$eval('.rf-agencies', (b) => b.hidden), false);
    await page.click('[data-unhide-ag]');
    assert.equal(await count(page), total);
    assert.equal(await page.$eval('.rf-agencies', (b) => b.hidden), true);
    // With "Show hidden" on, an agency-hidden row is dimmed and offers "Unhide agency".
    await page.click('.rf-item >> .rf-acts-more summary'); await page.click('.rf-item >> [data-act=ag]');
    await page.check('#rf-showHidden');
    const hid = await page.$('.rf-item.rf-hidden [data-act=ag]');
    assert.equal(await hid.textContent(), 'Unhide agency');
    await hid.evaluate((b) => b.click());
    assert.match(await status(page), /Showing .* again/);
    await page.uncheck('#rf-showHidden');
    assert.equal(await count(page), total);
    await page.check('#rf-floorplanOnly');
    assert.equal(await count(page), total / 2);
    assert.match(await page.textContent('.rf-item'), /photos · floorplan/);
    console.log('agency hide + floorplan: ok');
    await done(page); await ctx.close();
  });

  // 16. Compare table: shortlisted side by side, best values highlighted, toggles back.
  await block('16', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await run(page);
    const ids = await page.$$eval('.rf-item', (e) => e.slice(0, 3).map((x) => x.dataset.id));
    for (const id of ids) { await page.hover(`.rf-item[data-id="${id}"]`); await page.click(`.rf-item[data-id="${id}"] >> [data-act=s]`); }
    await page.click('#rf-more summary'); await settle(page);
    await page.fill('#rf-anchor', '-33.8915, 151.2767'); await page.dispatchEvent('#rf-anchor', 'change');
    await page.click('[data-view=shortlist]');
    await page.click('[data-sl=compare]');
    assert.equal(await page.getAttribute('[data-sl=compare]', 'aria-pressed'), 'true');
    assert.equal(await page.$$eval('.rf-compare thead th', (e) => e.length), 3);
    const rowsLabels = await page.$$eval('.rf-compare tbody th', (e) => e.map((x) => x.textContent));
    assert.ok(['Rent', 'Move-in', 'Distance', 'Amenities', 'Status'].every((l) => rowsLabels.includes(l)));
    assert.ok(await page.$$eval('.rf-compare .rf-best', (e) => e.length) >= 3, 'best values highlighted');
    await page.click('[data-sl=compare]');
    assert.equal(await count(page), 3);
    console.log('compare table: ok');
    await done(page); await ctx.close();
  });

  // 17. Star / hide on REA's own cards: stored, reflected, card faded, REA's handlers not reached.
  await block('17', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await page.waitForSelector('article > .rf-badge [data-card-act=s]');
    await page.evaluate(() => { window.__reaClicks = 0; document.querySelector('article').addEventListener('click', () => window.__reaClicks++); });
    const id = await page.$eval('article > .rf-badge [data-card-act=s]', (b) => b.dataset.id);
    assert.match(await page.$eval('article > .rf-badge [data-card-act=s]', (b) => b.getAttribute('aria-label')), /^Shortlist \d+\/\d+ \w+ (St|Ave|Rd)$/, 'named per listing');
    await page.click(`article > .rf-badge [data-card-act=s][data-id="${id}"]`);
    await page.waitForFunction((i) => document.querySelector(`[data-card-act=s][data-id="${i}"]`)?.getAttribute('aria-pressed') === 'true', id);
    assert.equal(await page.evaluate(() => window.__reaClicks), 0, 'click did not reach REA');
    assert.equal(await marks(page).then((m) => m[id].s), 1);
    await page.click(`article > .rf-badge [data-card-act=h][data-id="${id}"]`);
    await page.waitForFunction((i) => document.querySelector(`article[data-rf-id="${i}"]`)?.dataset.rfMatch === '0', id);
    await page.click('#rf-launch');
    assert.match(await page.textContent('.rf-count'), /\(1\)/);
    assert.match(await page.textContent('#rf-launch'), /★1/, 'launcher shows shortlist count');
    console.log('card quick actions: ok');
    await done(page); await ctx.close();
  });

  // 18. Active filter chips: counts, click to remove, summary count; Clear offers undo.
  await block('18', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await run(page);
    await page.click('#rf-more summary'); await settle(page);
    await page.fill('#rf-bedsMin', '3'); await page.dispatchEvent('#rf-bedsMin', 'change');
    await page.click('[data-amen=pets]');
    const chips = await page.$$eval('.rf-achip', (e) => e.map((x) => x.textContent.trim()));
    assert.equal(chips.length, 2);
    assert.match(chips[0], /3\+ bed −\d+ ×/);
    assert.match(await page.textContent('#rf-more summary'), /2 active/);
    const before = await count(page);
    await page.click('.rf-achip >> nth=0');
    assert.equal(await page.inputValue('#rf-bedsMin'), '');
    assert.ok(await count(page) > before, 'removing a chip widens results');
    await page.click('.rf-clear');
    assert.equal(await page.$eval('.rf-active', (b) => b.hidden), true);
    await page.click('.rf-status .rf-undo');
    assert.equal(await page.getAttribute('[data-amen=pets]', 'aria-label'), 'Pets: required', 'undo restores filters');
    console.log('active filter chips + clear undo: ok');
    await done(page); await ctx.close();
  });

  // 19. Keyboard: Alt+Shift+F toggles, j/k move, s shortlists, h hides, ? help, / keyword.
  await block('19', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await page.keyboard.press('Alt+Shift+F');
    assert.equal(await page.$eval('#rf-panel', (p) => p.hidden), false, 'Alt+Shift+F opens');
    await page.click('#rf-run'); await waitStatus(page, /listings match/);
    await page.focus('.rf-list');
    await page.keyboard.press('j');
    const first = await page.evaluate(() => document.activeElement.closest('.rf-item')?.dataset.id);
    await page.keyboard.press('j');
    const second = await page.evaluate(() => document.activeElement.closest('.rf-item')?.dataset.id);
    assert.ok(first && second && first !== second, 'j moves down');
    await page.keyboard.press('k');
    assert.equal(await page.evaluate(() => document.activeElement.closest('.rf-item')?.dataset.id), first, 'k moves up');
    await page.keyboard.press('s');
    await page.waitForFunction((id) => document.querySelector(`.rf-item[data-id="${id}"] [data-act=s]`)?.getAttribute('aria-pressed') === 'true', first);
    await page.keyboard.press('h');
    await page.waitForFunction((id) => !document.querySelector(`.rf-item[data-id="${id}"]`), first);
    await page.focus('.rf-list'); await page.keyboard.press('j');
    await page.keyboard.press('x'); // not a shortcut: no-op
    await page.keyboard.press('n');
    assert.ok(await page.$('.rf-note-edit'), 'n opens the note editor');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.rf-note-edit')); // the item redraws once the editor closes
    await page.focus('.rf-list'); await page.keyboard.press('j');
    await page.waitForFunction(() => document.activeElement?.classList.contains('rf-item'));
    const [pop] = await Promise.all([ctx.waitForEvent('page'), page.keyboard.press('o')]);
    await pop.close();
    await page.keyboard.press('?');
    assert.equal(await page.$eval('.rf-help', (h) => h.hidden), false);
    assert.ok((await page.$$eval('.rf-help dt', (d) => d.map((x) => x.textContent))).includes('Alt+Shift+F'), 'help drawn from KEY_HELP');
    assert.deepEqual(await page.$$eval('.rf-help .rf-about a', (a) => a.map((x) => `${x.textContent} ${x.href} ${x.rel}`)), ['Source https://github.com/cpwillis-pocs/rea-enhancement noopener noreferrer', 'Terms https://cpwillis.dev/terms noopener noreferrer', 'Privacy https://cpwillis.dev/privacy noopener noreferrer'], 'source, terms and privacy linked');
    await page.keyboard.press('Escape');
    assert.equal(await page.$eval('.rf-help', (h) => h.hidden), true, 'Esc closes help first');
    await page.focus('.rf-list');
    await page.keyboard.press('/');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'rf-keyword');
    await page.keyboard.type('s');
    assert.equal(await page.inputValue('#rf-keyword'), 's', 'typing in a field is not a shortcut');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Alt+Shift+F');
    assert.equal(await page.$eval('#rf-panel', (p) => p.hidden), false);
    console.log('keyboard shortcuts: ok');
    await done(page); await ctx.close();
  });

  // 20. Bulk: shortlist all shown / hide all shown with undo; shortlist bulk status + remove declined.
  await block('20', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await run(page);
    await page.click('#rf-more summary'); await settle(page);
    await page.fill('#rf-bedsMin', '3'); await page.dispatchEvent('#rf-bedsMin', 'change');
    const shown = await count(page);
    await page.selectOption('.rf-bulk', 'star');
    assert.match(await status(page), new RegExp(`Shortlisted ${shown}`));
    await page.click('[data-view=shortlist]');
    assert.equal(await count(page), shown);
    await page.selectOption('.rf-sl-bulk', 'status:declined');
    assert.match(await status(page), /Marked \d+ as declined/);
    await page.selectOption('.rf-sl-bulk', 'unstar-declined');
    assert.equal(await count(page), 0);
    await page.click('.rf-status .rf-undo');
    assert.equal(await count(page), shown, 'undo brings them back');
    await page.selectOption('.rf-sl-bulk', 'unstar');
    assert.equal(await count(page), 0);
    await page.click('.rf-status .rf-undo');
    await page.click('[data-view=results]');
    await page.selectOption('.rf-bulk', 'hide');
    assert.equal(await count(page), 0);
    await page.click('.rf-status .rf-undo');
    assert.equal(await count(page), shown);
    console.log('bulk actions:', shown, 'rows, undo ok');
    await done(page); await ctx.close();
  });

  // 21. Presets: save, apply, bind to a search (auto-applies on SPA navigation back), delete.
  await block('21', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await run(page);
    await page.click('#rf-more summary'); await settle(page);
    await page.fill('#rf-bedsMin', '3'); await page.dispatchEvent('#rf-bedsMin', 'change');
    await page.selectOption('.rf-preset', 'c:save');
    assert.equal(await page.getAttribute('.rf-preset-name', 'aria-label'), 'Preset name');
    await page.keyboard.type('nope'); await page.keyboard.press('Escape');
    assert.equal(await page.$('.rf-preset-name'), null, 'Esc cancels');
    assert.ok(await page.isVisible('#rf-panel'), 'without closing the drawer');
    assert.ok(!(await page.$$eval('.rf-preset option', (o) => o.map((x) => x.value))).includes('a:nope'));
    await page.selectOption('.rf-preset', 'c:save');
    await page.keyboard.type('clicked away');
    await page.click('#rf-from');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'rf-from', 'leaving by click keeps focus where it went');
    assert.ok((await page.$$eval('.rf-preset option', (o) => o.map((x) => x.value))).includes('a:clicked away'), 'and saves');
    await page.selectOption('.rf-preset', 'd:clicked away');
    await page.click('.rf-ask [data-ask=yes]'); // deleting asks first
    await presetSave(page, 'c:save', '3-bed');
    assert.match(await status(page), /Saved preset "3-bed"/);
    await page.click('.rf-clear');
    await page.selectOption('.rf-preset', 'a:3-bed');
    assert.equal(await page.inputValue('#rf-bedsMin'), '3', 'preset applied');
    await page.click('.rf-clear');
    await page.click('[data-amen=pets]');
    await presetSave(page, 'c:bind', 'Bondi pets');
    await page.click('.rf-clear');
    await page.evaluate(() => history.pushState({}, '', '/rent/in-manly,+nsw+2095/list-1'));
    await settle(page); // a visit of its own: navigations in one task are one (they're merged)
    await page.evaluate((u) => history.pushState({}, '', u), SEARCH);
    await page.waitForFunction(() => document.querySelector('[data-amen=pets]').getAttribute('aria-label') === 'Pets: required', null, { timeout: 8000 });
    assert.match(await page.textContent('.rf-preset option'), /Preset: Bondi pets/);
    // Through the closed menu by keyboard, both ways browsers do it (a synthetic key has no default
    // action, so this runs the same on any machine). Windows and Linux move the choice with the key:
    // it waits for Enter. macOS opens its own menu instead, and choosing there is the pick.
    const arrow = (moved) => page.$eval('.rf-preset', async (sel, moved) => {
      sel.focus();
      sel.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      if (!moved) await new Promise((r) => setTimeout(r, 0)); // the menu is open: the choice comes later
      sel.selectedIndex = [...sel.options].findIndex((o) => o.value === 'a:3-bed');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }, moved);
    await arrow(true);
    assert.match(await status(page), /Press Enter for "Apply: 3-bed"/);
    await page.keyboard.press('Escape');
    assert.equal(await page.inputValue('.rf-preset'), '', 'Esc leaves it');
    await arrow(false);
    assert.match(await status(page), /Applied preset "3-bed"/, "macOS: chosen in the system's menu, no second Enter");
    assert.equal(await page.inputValue('#rf-bedsMin'), '3');
    await page.selectOption('.rf-preset', 'd:3-bed');
    await page.click('.rf-ask [data-ask=no]');
    assert.ok((await page.$$eval('.rf-preset option', (o) => o.map((x) => x.value))).includes('a:3-bed'), 'Keep it keeps it');
    await page.selectOption('.rf-preset', 'd:3-bed');
    await page.click('.rf-ask [data-ask=yes]');
    assert.ok(!(await page.$$eval('.rf-preset option', (o) => o.map((x) => x.value))).includes('a:3-bed'));
    console.log('presets: ok');
    await done(page); await ctx.close();
  });

  // 21b. Preset names that look like menu commands, bound type across reload, once per visit.
  await block('21b', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await run(page);
    await page.click('#rf-more summary'); await settle(page);
    await page.click('.rf-types [data-ptype="Townhouse"]');
    await presetSave(page, 'c:save', '-3-bed');
    assert.match(await status(page), /Saved preset "-3-bed"/);
    await presetSave(page, 'c:bind', 'd:x');
    assert.match(await status(page), /d:x/);
    const vals = await page.$$eval('.rf-preset option', (o) => o.map((x) => x.value));
    assert.ok(vals.includes('a:-3-bed') && vals.includes('d:-3-bed'), 'command-like name kept as a preset');
    await page.click('.rf-types [data-ptype="Townhouse"]'); // off again
    assert.equal(await page.inputValue('#rf-type'), '');
    await page.selectOption('.rf-preset', 'a:-3-bed');
    assert.equal(await page.inputValue('#rf-type'), 'Townhouse', 'applying a "-" name applies, not deletes');
    await page.evaluate(() => sessionStorage.removeItem('rea-avail-filter/preset-visit'));
    await page.reload(); await page.addScriptTag({ content: SCRIPT }); await page.waitForSelector('#rf-panel[data-rf-ready]', { state: 'attached' });
    assert.equal(await page.inputValue('#rf-type'), 'Townhouse', 'bound type survives page load');
    await page.evaluate(() => { const el = document.querySelector('#rf-type'); el.value = ''; el.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.reload(); await page.addScriptTag({ content: SCRIPT }); await page.waitForSelector('#rf-panel[data-rf-ready]', { state: 'attached' });
    assert.equal(await page.inputValue('#rf-type'), '', 'bound preset applies once per visit, not over edits');
    console.log('presets names/type: ok');
    await done(page); await ctx.close();
  });

  // 21c. A bound preset's "previous filters" survive a reload, so they don't leak to other searches.
  await block('21c', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    const pets = () => page.getAttribute('[data-amen=pets]', 'aria-label');
    await run(page);
    await page.click('#rf-more summary'); await settle(page);
    await page.click('[data-amen=pets]');
    await presetSave(page, 'c:bind', 'Bondi pets');
    await page.click('.rf-clear');
    await page.evaluate(() => history.pushState({}, '', '/rent/in-manly,+nsw+2095/list-1'));
    await settle(page); // a visit of its own: navigations in one task are one (they're merged)
    await page.evaluate((u) => history.pushState({}, '', u), SEARCH);
    await page.waitForFunction(() => document.querySelector('[data-amen=pets]').getAttribute('aria-label') === 'Pets: required', null, { timeout: 8000 });
    await page.reload(); await page.addScriptTag({ content: SCRIPT }); await page.waitForSelector('#rf-panel[data-rf-ready]', { state: 'attached' });
    await page.evaluate(() => history.pushState({}, '', '/rent/in-manly,+nsw+2095/list-1'));
    await page.waitForFunction(() => !/required/.test(document.querySelector('[data-amen=pets]').getAttribute('aria-label')), null, { timeout: 8000 });
    assert.doesNotMatch(await pets(), /required/, 'previous filters restored after reload');
    console.log('preset restore after reload: ok');
    await done(page); await ctx.close();
  });

  // 22. Print: opens a document with one block per shortlisted listing.
  await block('22', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await run(page);
    for (const n of [1, 2]) { await page.hover(`.rf-item:nth-child(${n})`); await page.click(`.rf-item:nth-child(${n}) >> [data-act=s]`); }
    await page.click('[data-view=shortlist]');
    // The print dialog is asked for (Chromium never fires load for a written document).
    await page.evaluate(() => { const o = window.open; window.open = (...a) => { const w = o.apply(window, a); if (w) w.print = () => { window.__printed = (window.__printed || 0) + 1; }; return w; }; });
    const [pop] = await Promise.all([ctx.waitForEvent('page'), page.click('.rf-menu summary').then(() => page.click('[data-sl=print]'))]);
    await pop.waitForLoadState();
    await page.waitForFunction(() => window.__printed === 1, null, { timeout: 4000 });
    assert.equal(await pop.$$eval('.l', (e) => e.length), 2);
    assert.match(await pop.title(), /Rental shortlist/);
    console.log('print shortlist: ok');
    await pop.close();
    await done(page); await ctx.close();
  });

  // 23. Share: copy link from one browser profile, open it in another, import.
  await block('23', async () => {
    const ctxA = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const a = await open(ctxA);
    await run(a);
    for (const n of [1, 2]) { await a.hover(`.rf-item:nth-child(${n})`); await a.click(`.rf-item:nth-child(${n}) >> [data-act=s]`); }
    await a.hover('.rf-item:nth-child(1)'); await a.click('.rf-item:nth-child(1) >> [data-act=n]');
    await a.fill('.rf-note-edit', 'great light'); await a.keyboard.press('Enter');
    await a.click('[data-view=shortlist]');
    const first = await a.getAttribute('.rf-item:nth-child(1)', 'data-id');
    await a.selectOption(`.rf-item[data-id="${first}"] select[data-app]`, 'applied');
    await a.click(`.rf-item[data-id="${first}"] .rf-rate [data-v="4"]`);
    await a.click('.rf-menu summary'); await a.click('[data-sl=share]');
    await a.waitForSelector('.rf-ask');
    assert.equal(await a.evaluate(() => document.activeElement.dataset.ask), 'yes', 'the question takes focus');
    assert.match(await a.textContent('.rf-ask'), /Include your notes and statuses and ratings/);
    await a.keyboard.press('Enter');
    await waitStatus(a, /Share link copied \(2 listings, with your notes and statuses and ratings\)/);
    assert.equal(await a.evaluate(() => document.activeElement.textContent), 'More', 'focus back on the closed menu, not the page');
    const link = await a.evaluate(() => navigator.clipboard.readText());
    await done(a); await ctxA.close();

    const ctxB = await browser.newContext();
    const b = await open(ctxB, link);
    await b.waitForSelector('.rf-share-in:not([hidden])');
    assert.match(await b.textContent('.rf-share-msg'), /2 shared listings/);
    await b.evaluate(() => history.pushState({}, '', '/buy/in-bondi/list-1'));
    assert.ok(await b.isVisible('.rf-share-in'), 'pending share offer survives leaving /rent/');
    assert.equal(await b.evaluate(() => location.hash), '', 'fragment stripped');
    await b.click('[data-share=add]');
    assert.equal(await b.$$eval('.rf-item', (e) => e.length), 2);
    const shared = (await marks(b))[first];
    assert.equal(shared.as, 'applied', 'their status fills in yours');
    assert.equal(shared.rt, undefined, 'their rating is not yours');
    assert.match(shared.n, /^Shared: (great light · )?rated 4\/5$/, 'their rating goes in the note');
    assert.ok(Object.values(await marks(b)).some((e) => /^Shared: great light/.test(e.n || '')), 'their note too');
    const d = await open(ctxB, link); // the same link again, declined this time
    await d.waitForSelector('.rf-share-in:not([hidden])');
    await d.click('[data-share=dismiss]');
    assert.ok(await d.$('.rf-share-in[hidden]'), 'dismissed');
    assert.equal((await marks(d).then((m) => Object.values(m).filter((e) => e.s))).length, 2, 'dismiss adds nothing');
    await done(d);
    const c = await open(ctxB, SEARCH + '#rf-share=eyJhIjoicmVh');
    await waitStatus(c, /incomplete or damaged/, 5000);
    assert.ok(!(await c.evaluate(() => location.hash)), 'broken share stripped from URL');
    await done(c);
    console.log('share link across profiles: ok');
    await done(b); await ctxB.close();
  });

  // 24. Planner: choose a day, see ordered inspections with clashes flagged; day calendar export.
  await block('24', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await run(page);
    await page.click('#rf-more summary'); await settle(page);
    await page.selectOption('#rf-sort', 'inspect');
    for (const n of [1, 2, 3, 4]) { await page.hover(`.rf-item:nth-child(${n})`); await page.click(`.rf-item:nth-child(${n}) >> [data-act=s]`); }
    await page.click('[data-view=shortlist]');
    const days = await page.$$eval('.rf-plan option', (o) => o.map((x) => x.value).filter(Boolean));
    assert.ok(days.length >= 1, 'days offered');
    await page.selectOption('.rf-plan', days[0]);
    const n = await page.$$eval('.rf-planner li', (e) => e.length);
    assert.ok(n > 1, 'several inspections that day');
    assert.ok(await page.$('.rf-planner li.rf-clash'), 'same-time fixtures clash');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-plan-ics=""]')]);
    assert.equal((fs.readFileSync(await dl.path(), 'utf8').match(/BEGIN:VEVENT/g) || []).length, n);
    // Suggested route: the clash means not every listing fits; its calendar has just the route.
    const [visits, of] = (await page.textContent('.rf-plan-route')).match(/(\d+) of (\d+) listings/).slice(1).map(Number);
    assert.ok(visits >= 1 && visits < of, `route ${visits} of ${of}`);
    assert.equal(await count(page, '.rf-planner li .rf-tag.rf-new'), visits, 'route sessions tagged');
    const [dr] = await Promise.all([page.waitForEvent('download'), page.click('[data-plan-ics=route]')]);
    assert.equal((fs.readFileSync(await dr.path(), 'utf8').match(/BEGIN:VEVENT/g) || []).length, visits);
    const planned = await page.$$eval('.rf-planner li a', (a) => new Set(a.map((x) => x.href)).size);
    await page.selectOption('.rf-sl-bulk', 'status:applied');
    assert.match(await status(page), new RegExp(`Marked ${planned} as applied`), 'bulk acts on the planned day only');
    await page.selectOption('.rf-plan', '');
    assert.ok(await count(page) === 4);
    console.log('planner:', days.length, 'days;', n, 'on', days[0]);
    await done(page); await ctx.close();
  });

  // 24b. Market view: rent per bed count and availability by week; clicking a week filters to it.
  await block('24b', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await run(page);
    await page.click('.rf-market-btn');
    await page.waitForSelector('.rf-market table');
    assert.equal(await page.getAttribute('.rf-market-btn', 'aria-pressed'), 'true');
    assert.ok((await page.$$('.rf-market tbody tr')).length >= 2, 'bed groups');
    assert.match(await page.textContent('.rf-market'), /By agency, in these listings/, 'fixture agencies compared');
    const ag = await page.getAttribute('.rf-market [data-market-ag]', 'data-market-ag');
    await page.click('.rf-market [data-market-ag]');
    await waitStatus(page, new RegExp(`^Hid every listing from ${ag}`));
    const hidden = () => page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('rea-avail-filter/marks/v1')).ag || {}));
    assert.deepEqual(await hidden(), [ag], 'agency hidden from the market view');
    await page.click('.rf-status .rf-undo');
    assert.deepEqual(await hidden(), [], 'and Undo brings it back');
    await page.click('.rf-market [data-view-close=market]');
    await page.waitForFunction(() => !document.querySelector('.rf-market'));
    assert.equal(await page.getAttribute('.rf-market-btn', 'aria-pressed'), 'false', '× closes the market view');
    await page.click('.rf-market-btn'); await page.waitForSelector('.rf-market table');
    await page.focus('.rf-market-btn'); await page.keyboard.press('m');
    assert.ok(await page.$('.rf-item'), 'm toggles back to the list');
    await page.keyboard.press('m'); await page.waitForSelector('.rf-market table');
    const bars = await page.$$eval('.rf-bars button[data-week]', (b) => b.map((x) => [x.dataset.week, +x.querySelector('.rf-bar-n').textContent]));
    assert.ok(bars.length >= 1, 'clickable weeks');
    const [wk, n] = bars.find(([w]) => w !== '0') || bars[0];
    await page.click(`.rf-bars button[data-week="${wk}"]`);
    await page.waitForSelector('.rf-item');
    assert.equal(await page.getAttribute('.rf-market-btn', 'aria-pressed'), 'false');
    const shown = await count(page);
    assert.equal(shown, n, 'week filter shows exactly that bucket');
    assert.ok(await page.inputValue('#rf-from') || await page.inputValue('#rf-to'), 'dates set');
    assert.ok(await page.evaluate(() => document.activeElement.matches('.rf-item, .rf-market-btn')), 'focus kept in the drawer');
    // Same week again: the button and the view stay in step.
    await page.click('.rf-market-btn'); await page.click(`.rf-bars button[data-week="${wk}"]`);
    assert.equal(await page.getAttribute('.rf-market-btn', 'aria-pressed'), 'false');
    assert.ok(await page.$('.rf-item') && !(await page.$('.rf-market')), 'list shown');
    // A bar never widens your own window: within 2 weeks + "Later" shows nothing extra.
    await page.click('.rf-clear');
    await page.selectOption('#rf-withinDays', '14');
    const inWindow = await count(page);
    await page.click('.rf-market-btn');
    const last = await page.$$eval('.rf-bars button[data-week]', (b) => b.at(-1).dataset.week); // the latest week in the window
    await page.click(`.rf-bars button[data-week="${last}"]`);
    assert.ok((await count(page)) <= inWindow);
    assert.ok(await page.inputValue('#rf-to') <= await page.evaluate(() => new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10)), 'end date not widened');
    console.log('market view: ok,', bars.length, 'weeks;', n, 'in week', wk);
    await done(page); await ctx.close();
  });

  // 24c. Saved searches: remembered searches listed; Check all fetches each and counts new.
  await block('24c', async () => {
    const ctx = await browser.newContext();
    const other = 'https://www.realestate.com.au/rent/in-manly,+nsw+2095/list-1';
    // Init scripts run before the page's fake clock is installed: stamp from FIXED, not Date.now().
    await ctx.addInitScript(([k, at]) => {
      if (!localStorage.getItem('rea-avail-filter/snapshots/v1')) localStorage.setItem('rea-avail-filter/snapshots/v1', JSON.stringify({ v: 1, s: { [k]: { at, ids: [], rows: [], gone: [] } } }));
    }, [other, +FIXED - 864e5 * 2]);
    const page = await open(ctx);
    await page.click('#rf-launch');
    assert.ok(await page.isVisible('.rf-saved'), 'saved searches shown');
    assert.match(await page.textContent('.rf-saved-list'), /Manly NSW 2095/);
    await page.click('#rf-run'); await waitStatus(page, /listings match/);
    await page.waitForFunction(() => document.querySelectorAll('.rf-saved-list li').length === 2);
    assert.match(await page.textContent('.rf-saved-list'), /this search/);
    await page.click('#rf-more summary'); await settle(page);
    await page.fill('#rf-priceMax', '800'); await page.dispatchEvent('#rf-priceMax', 'change');
    await page.click('.rf-saved summary');
    await page.click('[data-saved-check]');
    await waitStatus(page, /Checked 2 saved searches/, 30000);
    const st = await status(page);
    assert.match(st, /Manly NSW 2095: [1-9]\d* new \(\d+ match your filters\)/, 'all listings new for the empty snapshot, and how many get past the filters');
    assert.match(st, /Bondi[^:]*: 0 new/, 'current search unchanged');
    assert.match(await page.textContent('.rf-saved-list'), /\d+ new/);
    // Opting out mid-check stores nothing more.
    await page.click('[data-saved-check]');
    await page.click('.rf-settings summary'); await page.uncheck('#rf-remember');
    await page.waitForFunction(() => !document.querySelector('[data-saved-check]').hasAttribute('aria-disabled'), null, { timeout: 30000 });
    assert.equal(await page.evaluate(() => localStorage.getItem('rea-avail-filter/snapshots/v1')), null, 'nothing re-saved after opting out');
    console.log('saved searches: ok,', st.slice(0, 90));
    await done(page); await ctx.close();
  });

  // 24d. Availability date change: a stored earlier date shows "was <date>" in the drawer and on the card.
  await block('24d', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await run(page);
    const id = await page.evaluate(() => {
      const it = [...document.querySelectorAll('.rf-item')].find((x) => /\d{4}/.test(x.querySelector('.rf-avail').textContent));
      const key = 'rea-avail-filter/marks/v1';
      const d = JSON.parse(localStorage.getItem(key));
      d.m[it.dataset.id].av -= 3; // pretend it used to be available 3 days earlier
      localStorage.setItem(key, JSON.stringify(d));
      return it.dataset.id;
    });
    await page.click('#rf-refresh'); await waitStatus(page, /listings match/);
    await page.waitForSelector(`.rf-item[data-id="${id}"] .rf-avail .rf-was.up`);
    assert.match(await status(page), /1 date changed/);
    await page.click('#rf-more summary'); await settle(page); await page.check('#rf-changedOnly');
    assert.deepEqual(await page.$$eval('.rf-item', (e) => e.map((x) => x.dataset.id)), [id], 'changed-only filter');
    await page.waitForFunction(() => [...document.querySelectorAll('.rf-badge span')].some((b) => /^Avail was /.test(b.textContent)), null, { timeout: 5000 });
    console.log('availability change: ok,', await page.textContent(`.rf-item[data-id="${id}"] .rf-avail`));
    await done(page); await ctx.close();
  });

  // 24e. Listing page bar: shortlist, status, note and hide from the property page itself.
  await block('24e', async () => {
    const ctx = await browser.newContext();
    const url = `${ORIGIN}/property-unit-nsw-bondi-146500101`;
    const page = await open(ctx, url);
    await page.waitForSelector('#rf-lbar');
    assert.ok(await page.isHidden('#rf-launch'), 'drawer launcher stays off listing pages');
    await page.click('#rf-lbar [data-l=s]');
    assert.match(await page.textContent('#rf-lbar [data-l=s]'), /Shortlisted/);
    await page.selectOption('#rf-lbar [data-l=as]', 'applied');
    await page.click('#rf-lbar [data-l=n]');
    await page.keyboard.type('draft');
    await page.keyboard.press('Escape');
    assert.equal(await page.$('#rf-lbar .rf-lbar-edit'), null, 'Esc cancels');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.l), 'n', 'focus back on Note');
    await page.keyboard.press('Enter');
    assert.equal(await page.getAttribute('#rf-lbar .rf-lbar-edit', 'aria-label'), 'Private note for this listing');
    await page.keyboard.type('ask about');
    await page.keyboard.press('Shift+Enter');
    await page.clock.fastForward(61000); // a redraw doesn't eat what's half-typed
    await page.keyboard.type('parking');
    await page.keyboard.press('Enter');
    assert.match(await page.textContent('#rf-lbar .rf-lbar-note'), /ask about\s+parking/);
    const stored = await marks(page).then((m) => m['146500101']);
    assert.equal(stored.s, 1); assert.equal(stored.as, 'applied'); assert.equal(stored.n, 'ask about\nparking');
    assert.match(stored.d.p, /\$999/, 'summary taken from the listing page');
    const lshape = JSON.parse(await page.evaluate(() => window.reaFilter.shape()));
    assert.equal(lshape.kind, 'listing', 'shape() on a property page is that listing');
    assert.ok(!/Test St|Bondi, NSW/.test(JSON.stringify(lshape)) && /per week/.test(JSON.stringify(lshape)));
    // Checklist and details, folded until opened; a chip cycles its item and stays open.
    await page.click('#rf-lbar .rf-lbar-more summary');
    assert.match(await page.textContent('#rf-lbar .rf-lbar-more .rf-lbar-info'), /move-in \$/);
    await page.click('#rf-lbar [data-ck="Noise"]');
    assert.equal((await marks(page))['146500101'].ck.Noise, 'y');
    assert.ok(await page.$('#rf-lbar .rf-lbar-more[open]'), 'still open after the redraw');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.ck), 'Noise');
    await page.click('#rf-lbar [data-l=min]');
    assert.ok(await page.$('#rf-lbar.rf-lbar-min') && !(await page.$('#rf-lbar [data-l=h]')), 'minimised');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.l), 'min', 'focus stays on the toggle');
    await page.click('#rf-lbar [data-l=min]');
    await page.focus('#rf-lbar [data-l=h]');
    await page.evaluate(() => history.replaceState({}, '', location.pathname + '?gallery=1'));
    await page.clock.runFor(600); // past NAV_SETTLE_MS on the page's own clock
    assert.equal(await page.evaluate(() => document.activeElement.dataset.l), 'h', 'focus kept on replaceState');
    // In-app move to another listing: its own page is read for the summary.
    await page.evaluate(() => history.pushState({}, '', '/property-house-nsw-bondi-146500102'));
    await page.waitForFunction(() => document.getElementById('rf-lbar')?.dataset.id === '146500102', null, { timeout: 3000 });
    await page.waitForFunction(() => document.getElementById('rf-lbar')._row && !document.getElementById('rf-lbar')._row.partial, null, { timeout: 12000 });
    await page.click('#rf-lbar [data-l=s]');
    const second = await marks(page).then((m) => m['146500102'].d);
    assert.match(second.p, /\$999/); assert.match(second.u, /146500102/, 'summary is this listing');
    // Shows up on the Shortlist tab of a search.
    await page.goto(SEARCH); await page.addScriptTag({ content: SCRIPT });
    assert.equal(await page.$('#rf-lbar'), null, 'bar only on listing pages');
    await page.click('#rf-launch'); await page.click('[data-view=shortlist]');
    assert.match(await page.textContent('.rf-list'), /ask about\s+parking/);
    console.log('listing page bar: ok');
    await done(page); await ctx.close();
  });

  // 24f. Storage line and "Delete all my data" (tool keys only).
  await block('24f', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await page.evaluate(() => localStorage.setItem('reaOwnKey', 'keep me'));
    await run(page);
    await page.hover('.rf-item:nth-child(1)'); await page.click('.rf-item:nth-child(1) >> [data-act=s]');
    await page.click('.rf-settings summary');
    await page.waitForFunction(() => document.querySelector('.rf-storage-n').textContent);
    assert.match(await page.textContent('.rf-storage-n'), /Stored in this browser only: \d+ KB \(1 shortlisted, 0 hidden, 1 remembered search\)/);
    assert.match(await page.textContent('.rf-storage-n'), /Remembered: Bondi NSW 2026 \d+ KB\./, 'per-search size');
    await page.click('[data-forget]');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.ask), 'no', 'deleting everything starts on Cancel');
    await page.keyboard.press('Escape');
    assert.equal(await page.$('.rf-ask'), null, 'Esc cancels');
    assert.equal(await page.evaluate(() => document.activeElement.hasAttribute('data-forget')), true, 'focus back on the button');
    await page.click('[data-forget]');
    await Promise.all([page.waitForEvent('load'), page.click('.rf-ask [data-ask=yes]')]);
    const keys = await page.evaluate(() => Object.keys(localStorage).concat(Object.keys(sessionStorage)));
    assert.deepEqual(keys.filter((k) => k.startsWith('rea-avail-filter/')), [], 'tool data gone');
    assert.ok(keys.includes('reaOwnKey'), "REA's own data kept");
    console.log('delete all data: ok');
    await done(page); await ctx.close();
  });

  // 24g. Listing bar when REA's app already consumed the page-data global: read from the <script> tag.
  await block('24g', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx, `${ORIGIN}/property-unit-nsw-bondi-146500104`, { before: (p) => p.evaluate(() => { delete window.ArgonautExchange; }) });
    await page.waitForSelector('#rf-lbar');
    assert.equal(await page.evaluate(() => document.getElementById('rf-lbar')._row.price), '$999 per week');
    console.log('listing bar from script tag: ok');
    await done(page); await ctx.close();
  });

  // 24h. Opened tracking: opening from the drawer or REA's card marks it; Not opened yet filters it out.
  await block('24h', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await run(page);
    const id = await page.getAttribute('.rf-item', 'data-id');
    await page.evaluate(() => window.addEventListener('click', (e) => { if (e.target.closest('a')) e.preventDefault(); })); // no new tab in the test
    await page.click(`.rf-item[data-id="${id}"] .rf-card`);
    assert.ok(await marks(page).then((m) => m[id].o), 'opened stored');
    await page.click('#rf-more summary'); await settle(page); await page.check('#rf-unopenedOnly');
    assert.equal(await page.$(`.rf-item[data-id="${id}"]`), null, 'opened listing filtered out');
    await page.uncheck('#rf-unopenedOnly');
    assert.match(await page.textContent(`.rf-item[data-id="${id}"]`), /opened just now/);
    console.log('opened tracking: ok');
    await done(page); await ctx.close();
  });

  // 24i. A11y: Esc in the ⋯ menu closes only the menu; arrow keys switch tabs; phone modal makes the page inert.
  await block('24i', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await run(page);
    await page.click('.rf-item .rf-acts-more summary');
    await page.focus('.rf-item .rf-acts-more[open] [data-act=ag]');
    await page.keyboard.press('Escape');
    assert.ok(await page.isVisible('#rf-panel'), 'drawer still open');
    assert.equal(await page.$('.rf-acts-more[open]'), null, 'menu closed');
    await page.focus('#rf-tab-results'); await page.keyboard.press('ArrowRight');
    assert.equal(await page.getAttribute('#rf-tab-shortlist', 'aria-selected'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'rf-tab-shortlist');
    assert.equal(await page.getAttribute('#rf-list', 'aria-labelledby'), 'rf-tab-shortlist');
    await page.keyboard.press('ArrowLeft');
    await page.setViewportSize({ width: 390, height: 800 });
    await page.click('.rf-x'); await page.click('#rf-launch');
    assert.equal(await page.evaluate(() => document.querySelector('main, body > div:not(#rf-panel)')?.inert), true, 'page behind is inert');
    await page.click('.rf-x');
    assert.equal(await page.evaluate(() => [...document.body.children].some((el) => el.inert)), false, 'inert removed on close');
    console.log('a11y keys + inert: ok');
    await done(page); await ctx.close();
  });

  // 24j. Hide reason, Copy enquiry, "try dropping" suggestions, bulk counts, application follow-up.
  await block('24j', async () => {
    const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await open(ctx);
    await run(page);
    const n = await count(page);
    assert.equal(await page.textContent('.rf-bulk option[value=star]'), `Shortlist all ${n} shown`);
    const id = await page.getAttribute('.rf-item', 'data-id');
    await page.click(`.rf-item[data-id="${id}"] [data-act=h]`);
    await page.click('.rf-why button:has-text("too small")');
    assert.match(await status(page), /Noted: too small/);
    await page.click('#rf-more summary'); await settle(page); await page.check('#rf-showHidden');
    assert.match(await page.textContent(`.rf-item[data-id="${id}"]`), /hidden: too small/);
    await page.uncheck('#rf-showHidden');
    const other = await page.getAttribute('.rf-item', 'data-id');
    await page.click(`.rf-item[data-id="${other}"] .rf-acts-more summary`);
    await page.click(`.rf-item[data-id="${other}"] [data-act=enq]`);
    await waitStatus(page, /Enquiry copied/);
    assert.match(await page.evaluate(() => navigator.clipboard.readText()), /^Hi, I'm interested in .+\. Is it still available/);
    await page.fill('#rf-bedsMin', '9'); await page.dispatchEvent('#rf-bedsMin', 'change');
    await page.waitForSelector('[data-drop-chip]');
    await page.click('[data-drop-chip]');
    assert.ok((await count(page)) > 0, 'dropping the suggested filter brings listings back');
    // Applied a week ago: follow-up nudge on the shortlist.
    await page.evaluate((i) => { const k = 'rea-avail-filter/marks/v1'; const d = JSON.parse(localStorage.getItem(k)); Object.assign(d.m[i], { as: 'applied', ast: Date.now() - 7 * 864e5 }); localStorage.setItem(k, JSON.stringify(d)); }, other);
    await page.click(`.rf-item[data-id="${other}"] [data-act=s]`);
    await page.click('[data-view=shortlist]');
    assert.match(await page.textContent(`.rf-item[data-id="${other}"]`), /follow up\?/);
    assert.match(await page.textContent(`.rf-item[data-id="${other}"]`), /you: 1 applied/);
    console.log('hide reason / enquiry / drop suggestions / follow-up: ok');
    await done(page); await ctx.close();
  });

  // 24k. Named places, Best match weights, inspection checklist.
  await block('24k', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await run(page);
    await page.click('#rf-more summary'); await settle(page);
    await page.fill('#rf-anchor', '-33.891, 151.274'); await page.dispatchEvent('#rf-anchor', 'change');
    await page.fill('#rf-places', 'Work: -33.8688, 151.2093'); await page.dispatchEvent('#rf-places', 'change');
    await page.waitForFunction(() => /Work \d/.test(document.querySelector('.rf-list').textContent));
    await page.selectOption('#rf-sort', 'allnear');
    assert.match(await page.textContent('.rf-item .rf-meta:has-text("Work")'), /km away · Work [\d.]+ (k)?m/);
    await page.fill('#rf-priceMax', '1500'); await page.dispatchEvent('#rf-priceMax', 'change');
    await page.selectOption('#rf-sort', 'match');
    await page.click('.rf-settings summary');
    await page.selectOption('#rf-wDist', '0');
    assert.doesNotMatch(await page.getAttribute('.rf-score', 'title'), /distance/, 'ignored part left out');
    await page.selectOption('#rf-wRent', '3');
    assert.match(await page.getAttribute('.rf-score', 'title'), /rent vs budget \d+ \(×1.5\)/);
    const id = await page.getAttribute('.rf-item', 'data-id');
    await page.click(`.rf-item[data-id="${id}"] [data-act=s]`);
    await page.click('[data-view=shortlist]');
    const ckOpenNow = () => page.$eval(`.rf-item[data-id="${id}"] .rf-ck-more`, (d) => d.open);
    assert.equal(await ckOpenNow(), false, 'checklist folded until it matters');
    await page.selectOption(`.rf-item[data-id="${id}"] select[data-app]`, 'to inspect');
    await page.waitForFunction((i) => document.querySelector(`.rf-item[data-id="${i}"] .rf-ck-more`)?.open, id);
    await page.selectOption(`.rf-item[data-id="${id}"] select[data-app]`, 'applied');
    await page.waitForFunction((i) => document.querySelector(`.rf-item[data-id="${i}"] .rf-ck-more`)?.open === false, id); // opened by itself, so it folds again
    await page.click(`.rf-item[data-id="${id}"] .rf-ck-more summary`);
    await page.click(`.rf-item[data-id="${id}"] [data-ck="Natural light"]`);
    await page.click(`.rf-item[data-id="${id}"] [data-ck="Noise"]`); await page.click(`.rf-item[data-id="${id}"] [data-ck="Noise"]`);
    assert.equal(await page.getAttribute(`.rf-item[data-id="${id}"] [data-ck="Natural light"]`, 'data-state'), 'yes');
    assert.equal(await page.getAttribute(`.rf-item[data-id="${id}"] [data-ck="Noise"]`, 'data-state'), 'no');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.ck), 'Noise', 'focus kept on the chip');
    await page.click('[data-sl=compare]');
    assert.match(await page.textContent('.rf-compare'), /✓ Natural light, ✗ Noise/);
    assert.match(await page.textContent('.rf-compare'), /Work/);
    console.log('places / weights / checklist: ok');
    await done(page); await ctx.close();
  });

  // 24l. Round 10: text facts (apply portal, lease, availability from text), lease fit, lease/building
  // filters, building + twin listings, measure from a listing, places feedback, inspection prompts,
  // warning banner, saved-search reminder.
  await block('24l', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx, SEARCH, { route: serve([], { extras: true }) });
    await run(page);
    const item = (id) => page.textContent(`.rf-item[data-id="${id}"]`);
    assert.match(await item('146500000'), /Apply: 2Apply/); assert.match(await item('146500000'), /Lease 12 mo/);
    assert.match(await item('146500001'), /\(from text\)/, 'availability read from the description');
    assert.match(await item('146500000'), /3 in this building/);
    assert.match(await item('146500000'), /Also listed by Other Agency/);
    // Lease fit and sort.
    await page.click('.rf-settings summary');
    await page.fill('#rf-leaseEnd', '2026-10-20'); await page.dispatchEvent('#rf-leaseEnd', 'change');
    await page.selectOption('#rf-sort', 'fit');
    const first = await page.textContent('.rf-item .rf-meta:has-text("overlap"), .rf-item .rf-meta:has-text("right after")');
    assert.match(first, /overlap|right after/);
    // Lease and building filters (with chips).
    await page.click('#rf-more summary'); await settle(page);
    await page.selectOption('#rf-leaseMin', '12');
    assert.equal(await page.$('.rf-item[data-id="146500004"]'), null, '6-month-only lease dropped');
    assert.ok(await page.$('.rf-achip:has-text("Lease 12+ mo")'));
    await page.selectOption('#rf-leaseMin', '');
    const before = await count(page);
    await page.check('#rf-onePerBuilding');
    assert.equal(await count(page), before - 2, 'two extra units in one building collapse');
    await page.uncheck('#rf-onePerBuilding');
    await page.click('.rf-item[data-id="146500000"] [data-act=bldg]');
    assert.equal(await count(page), 3, 'only that building');
    assert.match(await status(page), /Showing 3 listings at 2 Curlewis St/);
    assert.ok(!('building' in JSON.parse(await page.evaluate(() => localStorage.getItem('rea-avail-filter/v1')))), 'the building filter is not stored');
    await page.click('.rf-achip:has-text("Building: 2 Curlewis St")');
    assert.equal(await count(page), before, 'chip removes the building filter');
    // Measure from a listing; add it as a place (feedback line).
    await page.click('.rf-item[data-id="146500002"] .rf-acts-more summary');
    await page.click('.rf-item[data-id="146500002"] [data-act=anchor]');
    assert.match(await page.inputValue('#rf-anchor'), /^-33\.\d+, 151\.\d+$/);
    await page.click('.rf-item[data-id="146500003"] .rf-acts-more summary');
    await page.click('.rf-item[data-id="146500003"] [data-act=place]');
    assert.match(await page.inputValue('#rf-places'), /^10\/2 Curlewis St: -33/);
    assert.match(await page.textContent('.rf-places-fb'), /10\/2 Curlewis St ✓/);
    await page.click('.rf-item[data-id="146500003"] .rf-acts-more summary');
    await page.click('.rf-item[data-id="146500003"] [data-act=place]');
    assert.match(await status(page), /Already in Other places/);
    assert.equal((await page.inputValue('#rf-places')).split('\n').length, 1, 'not added twice');
    await page.fill('#rf-places', 'Work: -33.87, 151.21\nnonsense'); await page.dispatchEvent('#rf-places', 'input');
    assert.match(await page.textContent('.rf-places-fb'), /Work ✓ · 1 line not understood/);
    // After-inspection prompt on the shortlist: a past inspection you were down for.
    await page.evaluate(() => document.querySelectorAll('.rf-acts-more[open]').forEach((d) => { d.open = false; }));
    await page.click('.rf-item[data-id="146500000"] [data-act=s]');
    assert.equal(await page.getAttribute('.rf-item[data-id="146500000"] [data-act=s]', 'aria-pressed'), 'true', 'shortlisted');
    await page.evaluate(() => { const k = 'rea-avail-filter/marks/v1'; const d = JSON.parse(localStorage.getItem(k)); d.m['146500000'].d.in = [{ at: Date.now() - 864e5, label: 'yesterday' }]; d.m['146500000'].as = 'to inspect'; d.m['146500000'].ast = Date.now() - 3 * 864e5; localStorage.setItem(k, JSON.stringify(d)); window.dispatchEvent(new StorageEvent('storage', { key: k })); }); // as another tab would
    await page.click('[data-view=shortlist]');
    await page.selectOption('.rf-sl-filter', '!');
    assert.match(await item('146500000'), /Did you inspect\?/);
    await page.click('.rf-item[data-id="146500000"] [data-na=yes]');
    await page.waitForSelector('.rf-item[data-id="146500000"]', { state: 'detached', timeout: 3000 }); // no longer needs action once answered
    await page.selectOption('.rf-sl-filter', '');
    assert.equal(await page.inputValue('.rf-item[data-id="146500000"] select[data-app]'), 'inspected');
    await page.click('[data-view=results]');
    console.log('round 10 features: ok');
    await done(page); await ctx.close();
  });

  // 24m. Saved-search reminder by the launcher (at most daily), Check now runs Check all.
  await block('24m', async () => {
    const ctx = await browser.newContext();
    await ctx.addInitScript((at) => {
      if (!localStorage.getItem('rea-avail-filter/snapshots/v1')) localStorage.setItem('rea-avail-filter/snapshots/v1', JSON.stringify({ v: 1, s: { 'https://www.realestate.com.au/rent/in-manly,+nsw+2095/list-1': { at, ids: [], rows: [], gone: [] } } }));
    }, +FIXED - 3 * 864e5);
    const page = await open(ctx);
    await page.waitForSelector('#rf-remind');
    assert.match(await page.textContent('#rf-remind'), /1 saved search not checked for 3d\./);
    await page.click('#rf-launch'); await page.click('.rf-settings summary');
    await page.uncheck('#rf-remindSaved');
    assert.equal(await page.$('#rf-remind'), null, 'turning reminders off removes the prompt');
    await page.check('#rf-remindSaved');
    await page.evaluate(() => localStorage.removeItem('rea-avail-filter/remind-at'));
    await page.click('#rf-panel .rf-x'); // the prompt sits by the launcher, under the drawer
    await page.evaluate(() => history.pushState(null, '', location.href.replace(/in-[^/]+/, 'in-coogee,+nsw+2034'))); // a different search re-checks
    await page.waitForSelector('#rf-remind');
    await page.click('#rf-remind [data-r=later]');
    assert.equal(await page.$('#rf-remind'), null, 'Later closes it');
    assert.ok(await page.evaluate(() => !document.getElementById('rf-panel') || document.getElementById('rf-panel').hidden), 'Later does not open the drawer');
    await page.evaluate(() => localStorage.removeItem('rea-avail-filter/remind-at'));
    await page.evaluate(() => history.pushState(null, '', location.href.replace(/in-[^/]+/, 'in-bronte,+nsw+2024')));
    await page.waitForSelector('#rf-remind');
    await page.click('#rf-remind [data-r=check]');
    await waitStatus(page, /Checked 1 saved search/, 30000);
    await page.reload(); await page.addScriptTag({ content: SCRIPT }); await page.waitForSelector('#rf-panel[data-rf-ready]', { state: 'attached' });
    await page.clock.runFor(300);
    assert.equal(await page.$('#rf-remind'), null, 'not again the same day');
    console.log('saved-search reminder: ok');
    await done(page); await ctx.close();
  });

  // 29. 2.17: taken listings (tag, filter), per-listing calendar with reminder, pinned saved
  // search, a cancelled open home flagged on the shortlist.
  await block('29', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx, SEARCH, { route: serve([], { extras: true }) });
    const item = (id) => page.textContent(`.rf-item[data-id="${id}"]`);
    await run(page);
    assert.match(await item('146500005'), /Deposit taken/);
    assert.match(await item('146500005'), /Professional clean required/);
    const total = await count(page);
    await page.click('#rf-more summary'); await settle(page);
    await page.check('#rf-hideTaken');
    assert.equal(await count(page), total - 1, 'taken listing hidden');
    assert.ok(await page.$('.rf-achip:has-text("Not taken")'));
    await page.uncheck('#rf-hideTaken');
    // Add to calendar from the ⋯ menu: one listing, with the default 1-hour reminder.
    await page.click('.rf-item[data-id="146500000"] .rf-acts-more summary');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.rf-item[data-id="146500000"] [data-act=ics]')]);
    const ics = fs.readFileSync(await dl.path(), 'utf8');
    assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1);
    assert.match(ics, /TRIGGER:-PT60M/);
    // Pin this search in Saved searches.
    await page.waitForSelector('.rf-saved:not([hidden])');
    await page.click('.rf-saved summary');
    await page.click('.rf-saved-list [data-saved-pin]');
    assert.equal(await page.getAttribute('.rf-saved-list [data-saved-pin]', 'aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('rea-avail-filter/snapshots/v1')).s)[0].pin), 1);
    // Shortlist it, then the next search shows no inspection for it: cancelled.
    await page.evaluate(() => document.querySelectorAll('.rf-acts-more[open]').forEach((d) => { d.open = false; }));
    await page.click('.rf-item[data-id="146500000"] [data-act=s]');
    await done(page);
    const later = await open(ctx, SEARCH, { route: serve([], { extras: true, noInspectFor: ['146500000'] }) });
    await run(later);
    await later.click('[data-view=shortlist]');
    assert.match(await later.textContent('.rf-item[data-id="146500000"]'), /Inspection .+ cancelled/);
    console.log('taken, listing calendar, pinned search, cancelled inspection: ok');
    await done(later); await ctx.close();
  });

  // 30. Expanded drawer: near full screen with filters on the left and results in columns;
  // remembered across reloads; e toggles it; hidden on phones (already full screen).
  await block('30', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await open(ctx);
    await run(page);
    const narrowW = await page.$eval('#rf-panel', (p) => p.getBoundingClientRect().width);
    await page.click('.rf-expand');
    assert.equal(await page.getAttribute('.rf-expand', 'aria-pressed'), 'true');
    const wide = await page.$eval('#rf-panel', (p) => p.getBoundingClientRect().width);
    assert.ok(wide > 1300 && narrowW < 500, `widened ${narrowW} -> ${wide}`);
    const cols = await page.$$eval('.rf-item', (items) => new Set(items.slice(0, 4).map((i) => Math.round(i.getBoundingClientRect().left))).size);
    assert.ok(cols >= 2, 'results in columns');
    const [ctrlRight, listLeft] = await page.evaluate(() => [document.querySelector('.rf-controls').getBoundingClientRect().right, document.querySelector('.rf-list').getBoundingClientRect().left]);
    assert.ok(ctrlRight <= listLeft + 1, 'filters beside the results');
    await page.reload(); await page.addScriptTag({ content: SCRIPT }); await page.waitForSelector('#rf-panel[data-rf-ready]', { state: 'attached' });
    await page.click('#rf-launch');
    assert.ok(await page.$('#rf-panel.rf-full'), 'remembered');
    await page.focus('.rf-tabs [data-view=results]'); await page.keyboard.press('e');
    assert.equal(await page.$('#rf-panel.rf-full'), null, 'e shrinks it');
    await page.setViewportSize({ width: 390, height: 800 });
    assert.equal(await page.isVisible('.rf-expand'), false, 'no expand button on phones');
    console.log('expanded drawer: ok');
    await done(page); await ctx.close();
  });

  // 31. 2.20: inspections I can make (weekends), by-appointment listings, keyword OR, and the
  // note when keywords only searched stored (shortened) text.
  await block('31', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx, SEARCH, { route: serve([], { extras: true }) });
    await run(page);
    const total = await count(page);
    await page.click('#rf-more summary'); await settle(page);
    await page.selectOption('#rf-inspectWhen', 'weekend');
    const labels = await page.$$eval('.rf-item', (items) => items.map((i) => i.textContent.match(/Inspect (\w+)/)?.[1]));
    assert.ok(labels.length > 0 && labels.length < total, `weekend inspections: ${labels.length} of ${total}`);
    assert.ok(labels.every((d) => /^(Sat|Sun)/.test(d)), labels.join(','));
    assert.ok(await page.$('.rf-achip:has-text("Inspect on a weekend")'));
    await page.selectOption('#rf-inspectWhen', '');
    assert.match(await page.textContent('.rf-item[data-id="146500001"]'), /Inspections by appointment/);
    await page.fill('#rf-keyword', 'dishwasher|robes'); await page.dispatchEvent('#rf-keyword', 'change');
    const either = await count(page);
    await page.fill('#rf-keyword', 'dishwasher'); await page.dispatchEvent('#rf-keyword', 'change');
    assert.ok(either > await count(page), 'a|b matches more than a alone');
    assert.doesNotMatch(await status(page), /saved \(shortened\) text/, 'fresh results: no note');
    await page.reload(); await page.addScriptTag({ content: SCRIPT }); await page.waitForSelector('#rf-panel[data-rf-ready]', { state: 'attached' });
    await page.click('#rf-launch');
    await waitStatus(page, /listings match/);
    assert.match(await status(page), /saved \(shortened\) text; Refresh/, 'restored results: note shown');
    console.log('inspect when, by appointment, keyword OR, stored-text note: ok');
    await done(page); await ctx.close();
  });

  // 32. What's new: a welcome on a first install until a search completes (or it's dismissed),
  // then shown once after an update, dismissed for good.
  await block('32', async () => {
    const fresh = await browser.newContext();
    const first = await open(fresh);
    await first.click('#rf-launch');
    await first.waitForSelector('.rf-news:not([hidden])');
    assert.match(await first.textContent('.rf-news'), /Welcome\..*Search all pages.*stays in this browser/);
    assert.equal(await first.evaluate(() => localStorage.getItem('rea-avail-filter/seen-version')), null, 'not seen until used');
    await first.click('#rf-run'); await waitStatus(first, /listings match/);
    assert.ok(await first.$('.rf-news[hidden]'), 'a completed search ends the welcome');
    assert.ok(await first.evaluate(() => localStorage.getItem('rea-avail-filter/seen-version')), 'and records the version');
    await first.reload(); await first.addScriptTag({ content: SCRIPT }); await first.waitForSelector('#rf-launch');
    await first.click('#rf-launch');
    assert.ok(await first.$('.rf-news[hidden]'), 'no welcome the second time');
    await done(first); await fresh.close();
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => { if (!localStorage.getItem('rea-avail-filter/seen-version')) localStorage.setItem('rea-avail-filter/seen-version', '2.17.0'); });
    const page = await open(ctx);
    await page.click('#rf-launch');
    await page.waitForSelector('.rf-news:not([hidden])');
    assert.match(await page.textContent('.rf-news'), /Updated to \d+\.\d+\.\d+\./);
    await page.click('.rf-news button');
    assert.ok(await page.$('.rf-news[hidden]'));
    await page.reload(); await page.addScriptTag({ content: SCRIPT }); await page.waitForSelector('#rf-panel[data-rf-ready]', { state: 'attached' });
    await page.click('#rf-launch');
    assert.ok(await page.$('.rf-news[hidden]'), 'not again');
    console.log("what's new: ok");
    await done(page); await ctx.close();
  });

  // 33. Property type: pick several (any of them matches), one removable chip per type, kept
  // across a reload; a picked type missing from the results still shows as a chip.
  await block('33', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await run(page);
    await page.click('#rf-more summary'); await settle(page);
    const byType = await page.evaluate(() => { const n = {}; for (const r of window.reaFilter.rows()) n[r.type] = (n[r.type] || 0) + 1; return n; });
    const names = await page.$$eval('.rf-types [data-ptype]', (b) => b.map((x) => x.dataset.ptype));
    assert.deepEqual(names, Object.keys(byType).sort(), 'one chip per type in the results');
    await page.click('.rf-types [data-ptype="Apartment"]');
    assert.equal(await count(page), byType.Apartment);
    await page.click('.rf-types [data-ptype="Unit"]');
    assert.equal(await count(page), byType.Apartment + byType.Unit, 'either type matches');
    assert.equal(await page.inputValue('#rf-type'), 'Apartment,Unit');
    assert.equal(await page.getAttribute('.rf-types [data-ptype="Unit"]', 'aria-pressed'), 'true');
    await page.click('.rf-achip:has-text("Apartment")');
    assert.equal(await count(page), byType.Unit, 'removing one chip keeps the other type');
    assert.equal(await page.getAttribute('.rf-types [data-ptype="Apartment"]', 'aria-pressed'), 'false', 'type chip follows');
    await page.reload(); await page.addScriptTag({ content: SCRIPT }); await page.waitForSelector('#rf-panel[data-rf-ready]', { state: 'attached' });
    assert.equal(await page.inputValue('#rf-type'), 'Unit', 'remembered');
    await page.click('#rf-launch');
    assert.ok(await page.$('.rf-types [data-ptype="Unit"][aria-pressed=true]'), 'picked type shown before results load');
    console.log('multi-select type: ok');
    await done(page); await ctx.close();
  });

  // 34. Side drawer scrolls as one page (results aren't a small box of their own) with the header
  // kept in view; REA's CSS can't inflate our card tags or wrap the card buttons in a pill.
  await block('34', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await open(ctx, SEARCH, { before: (p) => p.addStyleTag({ content: 'article span{padding:14px 18px!important;font-size:18px;line-height:2;background:red} article button{padding:12px 20px}' }) });
    await page.waitForSelector('article > .rf-badge');
    const tag = await page.$eval('article > .rf-badge > span', (e) => e.getBoundingClientRect().height);
    assert.ok(tag < 24, `tag height ${tag}`);
    const acts = await page.$eval('article > .rf-badge > .rf-card-acts', (e) => getComputedStyle(e).backgroundColor);
    assert.match(acts, /rgba\(0, 0, 0, 0\)|transparent/, 'button group has no pill of its own');
    await run(page);
    const [panelScrolls, listScrolls] = await page.evaluate(() => {
      const p = document.getElementById('rf-panel'), l = document.querySelector('.rf-list');
      return [p.scrollHeight > p.clientHeight + 100, l.scrollHeight > l.clientHeight + 1];
    });
    assert.ok(panelScrolls && !listScrolls, 'the drawer scrolls, not the list');
    await page.$eval('#rf-panel', (p) => { p.scrollTop = p.scrollHeight; });
    const headTop = await page.$eval('.rf-head', (h) => h.getBoundingClientRect().top);
    assert.equal(Math.round(headTop), 0, 'header stays at the top');
    assert.equal(await page.textContent('.rf-head h2'), 'Rental Toolkit');
    await done(page); await ctx.close();

    // 150 listings: Undo stays in view deep in the list, ↑ Filters goes back up, tabs keep your
    // place, and expanded mode still loads the next chunk before its button is reached.
    const big = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await open(big, SEARCH, { route: serve([], { pages: 10, perPage: 15 }) });
    await p.click('#rf-launch'); await p.click('#rf-run');
    await waitStatus(p, /150 listings match|of 150 listings match/, 20000);
    const id = await p.$$eval('.rf-item', (e) => e[40].dataset.id);
    await p.focus(`.rf-item[data-id="${id}"]`);
    await p.keyboard.press('h');
    const inView = await p.evaluate(() => {
      const u = document.querySelector('.rf-status .rf-undo'), panel = document.getElementById('rf-panel');
      if (!u) return false;
      const r = u.getBoundingClientRect(), head = panel.querySelector('.rf-tabs').getBoundingClientRect();
      return r.top >= head.bottom - 1 && r.bottom <= panel.getBoundingClientRect().bottom;
    });
    assert.ok(inView, 'Undo visible under the header');
    await p.click('.rf-status .rf-undo');
    assert.equal((await marks(p))[id].h, 0, 'undone');
    assert.ok(await p.isVisible('.rf-tofilters'), '↑ Filters offered once they scrolled away');
    const before = await p.$eval('#rf-panel', (el) => el.scrollTop);
    await p.click('[data-view=shortlist]'); await p.click('[data-view=results]');
    { const after = await p.$eval('#rf-panel', (el) => el.scrollTop); assert.ok(Math.abs(after - before) < 5, `tab switch keeps the place (${before} -> ${after})`); }
    await p.click('.rf-tofilters');
    assert.equal(await p.$eval('#rf-panel', (el) => el.scrollTop), 0);
    assert.equal(await p.evaluate(() => document.activeElement.id), 'rf-from');
    assert.ok(!(await p.isVisible('.rf-tofilters')));
    await p.click('.rf-expand');
    const shown = await count(p);
    await p.$eval('.rf-list', (l) => { l.scrollTop = l.querySelector('.rf-more-btn').offsetTop - l.clientHeight - 300; });
    await p.waitForFunction((n) => document.querySelectorAll('.rf-item').length > n, shown, { timeout: 3000 });
    await p.click('.rf-expand');
    // Hide from REA's card with the drawer closed: Undo and reasons appear by the launcher.
    await p.click('#rf-panel .rf-x');
    const card = 'article:has(.rf-badge)';
    await p.hover(card);
    const cid = await p.$eval(`${card} [data-card-act=h]`, (b) => b.dataset.id);
    await p.click(`${card} [data-card-act=h]`);
    await p.waitForSelector('#rf-toast');
    await p.mouse.move(0, 0);
    await p.focus('#rf-toast [data-r=price]');
    await p.clock.fastForward(15000);
    assert.ok(await p.$('#rf-toast'), 'keyboard focus holds the note open');
    await p.keyboard.press('Enter');
    assert.equal((await marks(p))[cid].hr, 'price', 'reason from the note');
    assert.equal(await p.$('#rf-toast'), null);
    assert.equal(await p.evaluate(() => document.activeElement.id), 'rf-launch', 'focus goes to the launcher, not <body>');
    console.log('drawer page scroll, sticky status, filters jump, tab place, card toast: ok');
    await done(p); await big.close();
  });

  // 35. Triage: compact list, photo peek, reviewed marks, extra keys, reverse sort, resizable
  // drawer, list semantics, and a listing hidden for its price coming back cheaper.
  await block('35', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    // Seed: 146500002 hidden for its price at $2000/wk (the fixture rent is lower).
    await ctx.addInitScript(() => {
      if (!localStorage.getItem('rea-avail-filter/marks/v1')) localStorage.setItem('rea-avail-filter/marks/v1', JSON.stringify({ v: 1, m: { 146500002: { f: 1, l: 1, h: 1, hr: 'price', hp: 2000, p: 2000 } } }));
    });
    const page = await open(ctx);
    await run(page);
    const item = (i) => `.rf-item:nth-child(${i})`;
    assert.equal(await page.getAttribute(item(1), 'aria-posinset'), '1');
    assert.equal(await page.getAttribute(item(1), 'aria-setsize'), String(await count(page)));
    assert.match(await page.getAttribute(`${item(1)} .rf-card`, 'aria-label'), /\$\d+ per week, .+ \(opens the listing\)/);
    assert.match(await page.textContent('.rf-item[data-id="146500002"]'), /cheaper since you hid it/, 'price-hidden listing back, tagged');
    assert.match(await page.textContent('.rf-item[data-id="146500002"] [data-act=h]'), /Hide again/);
    // Compact: d halves the height; the action row appears for the focused listing.
    const tall = await page.$eval(item(2), (e) => e.getBoundingClientRect().height);
    await page.focus(item(1)); await page.keyboard.press('d');
    const short = await page.$eval(item(2), (e) => e.getBoundingClientRect().height);
    assert.ok(short < tall * 0.7, `compact ${tall} -> ${short}`);
    assert.ok(await page.isVisible(`${item(1)} .rf-acts`) && !(await page.isVisible(`${item(3)} .rf-acts`)), 'actions on the focused one only');
    await page.keyboard.press('d');
    // Photo peek: p opens a larger image, j flips to the next listing, Esc closes just the photo.
    await page.keyboard.press('p');
    const src1 = await page.getAttribute('.rf-peek img', 'src');
    assert.match(src1, /800x600/);
    await page.keyboard.press('j');
    assert.notEqual(await page.getAttribute('.rf-peek img', 'src'), src1, 'flips with j');
    await page.keyboard.press('Escape');
    assert.ok(await page.$('.rf-peek[hidden]') && await page.isVisible('#rf-panel'), 'Esc closes only the photo');
    // Reviewed: j marked the one it left; r marks and moves; the filter keeps the rest.
    await page.keyboard.press('r');
    const reviewed = Object.values(await marks(page)).filter((e) => e.rv).length;
    assert.equal(reviewed, 2);
    assert.match(await status(page), /listings match/);
    await page.click('#rf-more summary'); await settle(page);
    const total = await count(page);
    await page.check('#rf-unreviewedOnly');
    assert.equal(await count(page), total - 2);
    await page.uncheck('#rf-unreviewedOnly');
    assert.match(await status(page), /reviewed 2 of \d+/);
    // Keys: h then u undoes; G goes to the last listing; t switches tabs; 1-5 set a status.
    await page.focus(item(3)); const hid = await page.getAttribute(item(3), 'data-id');
    await page.keyboard.press('h'); await page.keyboard.press('u');
    assert.equal((await marks(page))[hid].h, 0, 'u undid the hide');
    await page.focus(item(1)); await page.keyboard.press('G');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-posinset')), await page.getAttribute(item(1), 'aria-setsize'));
    await page.focus(item(1)); await page.keyboard.press('s'); await page.keyboard.press('t');
    assert.equal(await page.getAttribute('[data-view=shortlist]', 'aria-selected'), 'true');
    await page.focus('.rf-item'); await page.keyboard.press('3');
    assert.equal(Object.values(await marks(page)).find((e) => e.s).as, 'applied', '3 = applied (1 to inspect … 5 declined)');
    await page.keyboard.press('t');
    // Reverse sort: the first and last prices swap ends ("Contact agent" stays last).
    await page.selectOption('#rf-sort', 'price');
    const prices = async () => page.$$eval('.rf-item .rf-price', (p) => p.map((x) => x.textContent.match(/\$(\d+)/)?.[1]).filter(Boolean).map(Number));
    const asc = await prices();
    await page.click('.rf-sortdir');
    assert.equal(await page.getAttribute('.rf-sortdir', 'aria-pressed'), 'true');
    const desc = await prices();
    assert.equal(desc[0], Math.max(...asc)); assert.equal(desc.at(-1), Math.min(...asc));
    assert.match(await page.textContent('.rf-item:last-child .rf-price'), /Contact agent/);
    await page.click('.rf-sortdir');
    // Resize: drag the left edge; wide enough and results go two per row; remembered.
    const hb = await (await page.$('.rf-resize')).boundingBox();
    await page.mouse.move(hb.x + 4, 400); await page.mouse.down(); await page.mouse.move(1440 - 800, 400, { steps: 4 }); await page.mouse.up();
    assert.ok(Math.abs(await page.$eval('#rf-panel', (p) => p.offsetWidth) - 800) < 3);
    assert.ok(await page.$('#rf-panel.rf-two'));
    await page.focus('.rf-resize'); await page.keyboard.press('ArrowRight');
    assert.ok(Math.abs(await page.$eval('#rf-panel', (p) => p.offsetWidth) - 760) < 3, 'arrow keys resize');
    await page.reload(); await page.addScriptTag({ content: SCRIPT }); await page.waitForSelector('#rf-panel[data-rf-ready]', { state: 'attached' });
    await page.click('#rf-launch');
    assert.ok(Math.abs(await page.$eval('#rf-panel', (p) => p.offsetWidth) - 760) < 3, 'width remembered');
    console.log('compact, peek, reviewed, keys, reverse sort, resize, semantics, cheaper since hidden: ok');
    await done(page); await ctx.close();
  });

  // 36. REA drops <article>: cards are found by climbing from each listing link; badges, card
  // buttons and fading still work, and selfcheck says which way they were found.
  await block('36', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx, SEARCH, { route: serve([], { cardTag: 'div' }) });
    await page.waitForSelector('div.rc > .rf-badge', { timeout: 5000 });
    assert.equal(await count(page, 'div.rc > .rf-badge'), 6, 'one badge per card');
    assert.equal(await count(page, '.rc-body .rf-badge'), 0, 'on the card, not an inner box');
    await page.hover('div.rc'); await page.click('div.rc [data-card-act=s]');
    assert.equal(Object.values(await marks(page)).filter((e) => e.s).length, 1);
    const early = await page.evaluate(() => window.reaFilter.selfcheck());
    assert.match(early, /rows: 6 \(page 1 only: no search run yet\)/, 'selfcheck before a search reads page 1');
    assert.match(early, /price 83%\/\?, .*coordinates 100%/, 'fill rates from page 1, not 0%');
    await run(page);
    await page.click('#rf-more summary'); await settle(page);
    await page.fill('#rf-priceMax', '600'); await page.dispatchEvent('#rf-priceMax', 'change');
    await page.waitForSelector('div.rc[data-rf-match="0"]');
    const report = await page.evaluate(() => window.reaFilter.selfcheck());
    assert.match(report, /cards: 6 found \(fallback: REA no longer uses <article>\)/);
    const shape = await page.evaluate(() => window.reaFilter.shape());
    assert.ok(!/Curlewis|Bondi Realty/.test(shape) && /per week/.test(shape), 'shape(): structure without names or addresses');
    console.log('cards without <article>, shape(): ok');
    await done(page); await ctx.close();
  });

  // 37. Your place survives a reload (same filters): the drawer opens on the listing you were on;
  // with different filters it's a different list, so it opens at the top.
  await block('37', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await open(ctx, SEARCH, { route: serve([], { pages: 4, perPage: 15 }) });
    await page.click('#rf-launch'); await page.click('#rf-run');
    await waitStatus(page, /60 listings match|of 60 listings match/, 20000);
    const id = await page.$$eval('.rf-item', (e) => e[42].dataset.id); // well down the list
    await page.focus(`.rf-item[data-id="${id}"]`);
    await page.clock.runFor(600);
    const reopen = async () => { await page.reload(); await page.addScriptTag({ content: SCRIPT }); await page.waitForSelector('#rf-panel[data-rf-ready]', { state: 'attached' }); await page.click('#rf-launch'); };
    await reopen();
    await page.waitForFunction((i) => document.activeElement?.dataset?.id === i, id, { timeout: 3000 });
    const inView = await page.$eval(`.rf-item[data-id="${id}"]`, (el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight; });
    assert.ok(inView, 'the listing you were on is in view');
    await page.click('#rf-more summary'); await settle(page); await page.fill('#rf-bedsMin', '2'); await page.dispatchEvent('#rf-bedsMin', 'change');
    await reopen();
    await page.clock.runFor(300);
    assert.notEqual(await page.evaluate(() => document.activeElement?.dataset?.id), id, 'different filters: not restored');
    console.log('place kept across reloads: ok');
    await done(page); await ctx.close();
  });

  // 38. Cards REA renders that we can't recognise: after a grace period the drawer says the
  // badges are off; a normal page never shows it.
  await block('38', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx, SEARCH, { route: serve([], { noCardLinks: true }) });
    await page.waitForSelector('#rf-launch');
    await page.clock.runFor(9000);
    await page.click('#rf-launch');
    assert.match(await page.textContent('.rf-warnbar'), /result cards weren't recognised/);
    assert.ok(await page.isVisible('.rf-warnbar'));
    await done(page);
    const ok = await open(ctx);
    await ok.waitForSelector('article > .rf-badge');
    await ok.clock.runFor(9000);
    await ok.click('#rf-launch');
    assert.doesNotMatch(await ok.textContent('.rf-warnbar'), /weren't recognised/);
    console.log('unrecognised cards warning: ok');
    await done(ok); await ctx.close();
  });

  // 39. The Shortlist tab also reopens where you were after a reload.
  await block('39', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 700 } });
    const page = await open(ctx);
    await run(page);
    for (const n of [1, 2, 3, 4, 5, 6]) { await page.hover(`.rf-item:nth-child(${n})`); await page.click(`.rf-item:nth-child(${n}) >> [data-act=s]`); }
    await page.click('[data-view=shortlist]');
    const id = await page.$$eval('.rf-item', (e) => e[4].dataset.id);
    await page.focus(`.rf-item[data-id="${id}"]`);
    await page.clock.runFor(600);
    await page.reload(); await page.addScriptTag({ content: SCRIPT }); await page.waitForSelector('#rf-panel[data-rf-ready]', { state: 'attached' });
    await page.click('#rf-launch');
    await page.click('[data-view=shortlist]');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.id), id, 'the shortlisted listing you were on');
    console.log('shortlist place across reloads: ok');
    await done(page); await ctx.close();
  });

  // 40. Audit fixes: Space presses a focused button (not the photo peek); a sort change deep in
  // the drawer lands the first result below the status line; the first Shortlist visit starts at
  // its top; the peek closes with the drawer; expanding keeps the listing you were on in view.
  await block('40', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await open(ctx, SEARCH, { route: serve([], { pages: 4, perPage: 15 }) });
    await page.click('#rf-launch'); await page.click('#rf-run');
    await waitStatus(page, /60 listings match|of 60 listings match/, 20000);
    await page.focus('.rf-item:nth-child(2) [data-act=s]'); await page.keyboard.press(' ');
    assert.equal(Object.values(await marks(page)).filter((e) => e.s).length, 1, 'Space shortlisted');
    assert.ok(await page.$('.rf-peek[hidden]'), 'no photo opened');
    await page.$eval('#rf-panel', (p) => { p.scrollTop = 3000; });
    await page.selectOption('#rf-sort', 'price');
    const [statusBottom, firstTop] = await page.evaluate(() => [document.querySelector('.rf-status').getBoundingClientRect().bottom, document.querySelector('.rf-item').getBoundingClientRect().top]);
    assert.ok(firstTop >= statusBottom - 1, `first result below the status line (${firstTop} vs ${statusBottom})`);
    await page.selectOption('.rf-bulk', 'star');
    await page.$eval('#rf-panel', (p) => { p.scrollTop = 6000; });
    await page.click('[data-view=shortlist]');
    assert.ok(await page.evaluate(() => { const b = document.querySelector('.rf-sl-bar').getBoundingClientRect(); return b.bottom > 0 && b.top < innerHeight; }), 'shortlist opens at its top');
    await page.click('[data-view=results]');
    await page.focus('.rf-item'); await page.keyboard.press('p');
    await page.click('#rf-panel .rf-x'); await page.click('#rf-launch');
    assert.ok(await page.$('.rf-peek[hidden]'), 'peek closed with the drawer');
    const id = await page.$$eval('.rf-item', (e) => e[30].dataset.id);
    await page.focus(`.rf-item[data-id="${id}"]`); await page.keyboard.press('e');
    assert.ok(await page.$eval(`.rf-item[data-id="${id}"]`, (el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight; }), 'still in view after expanding');
    await page.keyboard.press('e');
    console.log('space, scroll after sort, shortlist top, peek close, expand place: ok');
    await done(page); await ctx.close();
  });

  // 41. A pause from an earlier bot check (this tab) shows at load and stops page 2 being
  // fetched; the drawer still works on page 1, which came with the page.
  await block('41', async () => {
    const ctx = await browser.newContext();
    const base = serve([], { pages: 2 });
    const hits = [];
    await ctx.addInitScript(() => localStorage.setItem('rea-avail-filter/paused', String(Date.now() + 5 * 60 * 1000)));
    const page = await open(ctx, SEARCH, { route: (route) => { const u = route.request().url(); if (/\/list-2/.test(u)) hits.push(u); return base(route); } });
    await page.click('#rf-launch');
    assert.match(await page.textContent('.rf-warn-msg'), /fetching is paused until/);
    await page.click('#rf-run');
    await page.waitForSelector('.rf-partial:not([hidden])');
    assert.match(await page.textContent('.rf-partial'), /page 2 failed \(Paused/);
    assert.equal(await count(page), 6, 'page 1 still shown');
    assert.deepEqual(hits, [], 'page 2 not requested');
    await page.click('#rf-refresh');
    await waitStatus(page, /^Paused:/);
    assert.equal(await count(page), 6, 'Refresh while paused keeps what is shown');
    console.log('bot-check pause: ok');
    await done(page); await ctx.close();
  });

  // 42. Theme: dark follows the system unless Settings says otherwise, and the launcher follows too.
  await block('42', async () => {
    const bg = (p, sel) => p.$eval(sel, (el) => getComputedStyle(el).backgroundColor);
    const ctx = await browser.newContext({ colorScheme: 'dark' });
    const page = await open(ctx);
    await page.click('#rf-launch');
    assert.equal(await bg(page, '#rf-panel'), 'rgb(28, 28, 32)', 'system dark');
    await page.click('.rf-settings summary');
    await page.selectOption('#rf-theme', 'light');
    assert.equal(await bg(page, '#rf-panel'), 'rgb(255, 255, 255)', 'Light overrides a dark system');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.rfTheme), 'light');
    await page.selectOption('#rf-theme', '');
    assert.equal(await bg(page, '#rf-panel'), 'rgb(28, 28, 32)', 'System again');
    assert.equal(await page.evaluate(() => 'rfTheme' in document.documentElement.dataset), false);
    await done(page); await ctx.close();
    const light = await browser.newContext({ colorScheme: 'light' });
    await light.addInitScript(() => localStorage.setItem('rea-avail-filter/v1', JSON.stringify({ theme: 'dark' })));
    const p2 = await open(light);
    await p2.click('#rf-launch');
    assert.equal(await bg(p2, '#rf-panel'), 'rgb(28, 28, 32)', 'Dark overrides a light system, from saved settings');
    assert.equal(await p2.$eval('#rf-panel', (el) => getComputedStyle(el).colorScheme), 'dark');
    await done(p2); await light.close();
    const hc = await browser.newContext({ forcedColors: 'active' });
    const p3 = await open(hc);
    await p3.click('#rf-launch');
    await p3.click('.rf-sortdir');
    assert.equal(await p3.$eval('.rf-sortdir', (el) => getComputedStyle(el).forcedColorAdjust), 'none', 'pressed buttons keep a visible state in High Contrast');
    await done(p3); await hc.close();
    console.log('theme setting, forced colours: ok');
  });

  // 43. Floor size: REA's field shown on the listing, Min m² leaves out listings that don't say,
  // and Price per m² sorts by it.
  await block('43', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx, SEARCH, { route: serve([], { extras: true }) });
    await run(page);
    assert.match(await page.textContent('.rf-item[data-id="146500002"] .rf-meta'), /85 m²/);
    await page.click('.rf-more:not(.rf-settings) summary');
    await page.fill('#rf-sizeMin', '80');
    await waitStatus(page, /^1 of \d+ listings match/);
    assert.match(await page.textContent('.rf-active'), /80\+ m²/);
    assert.match(await page.getAttribute('.rf-tip', 'aria-label'), /most rentals don't.*left out by Min m²/, 'the ⓘ explains missing sizes');
    assert.match(await page.$eval('.rf-achip', (b) => b.title), /left out by Min m²/, 'and so does the chip');
    await page.fill('#rf-sizeMin', '');
    await page.selectOption('#rf-sort', 'ppsqm');
    assert.equal(await page.$eval('.rf-item', (el) => el.dataset.id), '146500002', 'the one listing with a size sorts first');
    await page.hover('.rf-item[data-id="146500002"]'); await page.click('.rf-item[data-id="146500002"] [data-act=s]');
    await page.click('[data-view=shortlist]');
    await page.waitForSelector('.rf-item[data-id="146500002"]');
    assert.match(await page.textContent('.rf-item[data-id="146500002"] .rf-meta'), /85 m²/, 'the Shortlist keeps the size');
    console.log('floor size: ok');
    await done(page); await ctx.close();
  });

  // 44. Double-run guard: a second copy of the script on the same page warns and stops.
  await block('44', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    const warned = [];
    page.on('console', (m) => { if (m.type() === 'warning' && /another copy/.test(m.text())) warned.push(m.text()); });
    await page.addScriptTag({ content: SCRIPT });
    assert.equal(await page.$$eval('#rf-panel', (els) => els.length), 1, 'one drawer');
    assert.equal(await page.$$eval('#rf-launch', (els) => els.length), 1, 'one launcher');
    assert.equal(warned.length, 1, 'the second copy says why it stopped');
    await run(page);
    console.log('double-run guard: ok');
    await done(page); await ctx.close();
  });

  // 45. Settings across tabs: a display setting saved in one tab reaches the other, and the
  // other tab's later filter change doesn't write its stale copy back over it.
  await block('45', async () => {
    const ctx = await browser.newContext();
    const a = await open(ctx), b = await open(ctx);
    await a.click('#rf-launch'); await b.click('#rf-launch');
    await a.click('.rf-settings summary');
    await a.selectOption('#rf-theme', 'dark');
    await b.waitForFunction(() => document.documentElement.dataset.rfTheme === 'dark');
    assert.equal(await b.$eval('#rf-theme', (el) => el.value), 'dark', "the other tab's form follows");
    await b.click('#rf-more summary');
    await b.fill('#rf-priceMax', '900'); await b.dispatchEvent('#rf-priceMax', 'change');
    const saved = await a.evaluate(() => JSON.parse(localStorage.getItem('rea-avail-filter/v1')));
    assert.equal(saved.theme, 'dark', 'theme kept');
    assert.equal(saved.priceMax, '900', 'and the rent change saved');
    // A preset saved in one tab is in the other's menu; a search remembered there is listed here.
    await presetSave(b, 'c:save', 'from B');
    await a.waitForFunction(() => [...document.querySelectorAll('.rf-preset option')].some((o) => /from B/.test(o.textContent)));
    await b.click('#rf-run'); await waitStatus(b, /listings match/);
    await a.waitForFunction(() => document.querySelector('.rf-saved-list li'), null, { timeout: 8000 });
    console.log('settings, presets and saved searches across tabs: ok');
    await done(a); await done(b); await ctx.close();
  });

  // 46. Re-check meets a challenge page: it stops, pauses fetching, and says so.
  await block('46', async () => {
    const ctx = await browser.newContext();
    const base = serve();
    let hits = 0;
    const page = await open(ctx, SEARCH, { route: (route) => {
      if (/\/property-/.test(route.request().url())) { hits++; return route.fulfill({ status: 200, contentType: 'text/html', body: '<html>Please verify you are human</html>' }); }
      return base(route);
    } });
    const other = await open(ctx); // a second tab on the same site
    await run(page);
    const ids = await page.$$eval('.rf-item', (e) => e.slice(0, 2).map((x) => x.dataset.id));
    for (const id of ids) { await page.hover(`.rf-item[data-id="${id}"]`); await page.click(`.rf-item[data-id="${id}"] >> [data-act=s]`); }
    await page.click('[data-view=shortlist]');
    await page.click('[data-sl=recheck]');
    await waitStatus(page, /Re-check stopped after 0 listings\. Paused:/, 20000);
    assert.equal(hits, 1, 'no second listing fetched into the challenge');
    assert.match(await page.textContent('.rf-warn-msg'), /fetching is paused until/);
    await other.click('#rf-launch');
    await other.waitForFunction(() => /fetching is paused until/.test(document.querySelector('.rf-warnbar:not([hidden]) .rf-warn-msg')?.textContent || ''));
    console.log('re-check challenge page pauses, in every tab: ok');
    await done(page); await done(other); await ctx.close();
  });

  // 47. Backups carry your settings (not this search's filters) and restore them; a real
  // shortlist with no backup gets one nudge.
  await block('47', async () => {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => { if (!localStorage.getItem('rea-avail-filter/v1')) localStorage.setItem('rea-avail-filter/v1', JSON.stringify({ theme: 'dark', checklist: 'Damp, Noise', priceMax: '900' })); });
    const page = await open(ctx);
    await run(page);
    await page.hover('.rf-item:nth-child(1)'); await page.click('.rf-item:nth-child(1) >> [data-act=s]');
    await page.click('[data-view=shortlist]');
    const [bk] = await Promise.all([page.waitForEvent('download'), page.click('.rf-menu summary').then(() => page.click('[data-sl=backup]'))]);
    const data = JSON.parse(fs.readFileSync(await bk.path(), 'utf8'));
    assert.equal(data.cfg.theme, 'dark');
    assert.equal(data.cfg.checklist, 'Damp, Noise');
    assert.ok(!('priceMax' in data.cfg), "a search's filters aren't settings");
    assert.ok(await page.evaluate(() => localStorage.getItem('rea-avail-filter/backup-at')), 'backup time recorded');
    await done(page); await ctx.close();
    const fresh = await browser.newContext();
    const p2 = await open(fresh);
    await p2.click('#rf-launch'); await p2.click('[data-view=shortlist]');
    await p2.setInputFiles('.rf-sl-bar input[type=file]', { name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...data, cfg: { ...data.cfg, remember: false } })) });
    await p2.waitForSelector('.rf-restore-in:not([hidden])');
    assert.match(await p2.textContent('.rf-restore-msg'), /1 listing \(1 shortlisted, 0 hidden\), 1 saved search, and replace your theme, checklist\?/);
    assert.equal(Object.values((await marks(p2)) || {}).filter((e) => e.s).length, 0, 'nothing merged before you say so');
    await p2.click('[data-restore=yes]');
    await waitStatus(p2, /Restored 1 listing, 1 saved search and your settings from backup/);
    assert.equal(await p2.evaluate(() => document.documentElement.dataset.rfTheme), 'dark');
    const saved = JSON.parse(await p2.evaluate(() => localStorage.getItem('rea-avail-filter/v1')));
    assert.equal(saved.checklist, 'Damp, Noise');
    assert.notEqual(saved.remember, false, "a backup made with Remember off doesn't turn it off here");
    assert.ok(await p2.evaluate(() => localStorage.getItem('rea-avail-filter/snapshots/v1')), 'remembered searches kept');
    await p2.click('.rf-status .rf-undo');
    await waitStatus(p2, /^Restore undone/);
    assert.equal(await p2.evaluate(() => 'rfTheme' in document.documentElement.dataset), false, 'settings back');
    assert.equal(await p2.$$eval('.rf-item', (e) => e.length), 0, 'shortlist back to empty');
    await done(p2); await fresh.close();
    const many = await browser.newContext();
    await many.addInitScript(() => {
      const m = {};
      for (let i = 0; i < 5; i++) m[146500010 + i] = { f: 1, l: 1, s: 1, st: 1, d: { u: `https://www.realestate.com.au/property-unit-nsw-bondi-${146500010 + i}`, a: `${i} Hall St, Bondi NSW 2026` } };
      if (!localStorage.getItem('rea-avail-filter/marks/v1')) localStorage.setItem('rea-avail-filter/marks/v1', JSON.stringify({ v: 1, m }));
    });
    const lp = await open(many, `${ORIGIN}/property-unit-nsw-bondi-146500101`);
    await lp.waitForSelector('#rf-lbar');
    assert.equal(await lp.evaluate(() => localStorage.getItem('rea-avail-filter/backup-nudge-at')), null, 'not used up on a listing page, where it would not be seen');
    await done(lp);
    const p3 = await open(many);
    assert.equal(await p3.evaluate(() => localStorage.getItem('rea-avail-filter/backup-nudge-at')), null, 'nor before the drawer opens');
    await p3.click('#rf-launch');
    await p3.waitForFunction(() => /5 listings shortlisted and never backed up/.test(document.querySelector('.rf-warnbar:not([hidden])')?.textContent || ''));
    await p3.reload(); await p3.addScriptTag({ content: SCRIPT }); await p3.waitForSelector('#rf-launch');
    await p3.click('#rf-launch');
    assert.ok(!/never backed up/.test(await p3.textContent('.rf-warn-msg')), 'once, not on every page');
    console.log('backup carries settings, nudge: ok');
    await done(p3); await many.close();
  });

  // 48. Why this tag: a tag's tooltip quotes what it was read from, a keyword shows where it
  // matched, and the phrases copy as unit-test rows.
  await block('48', async () => {
    const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await open(ctx, SEARCH, { route: serve([], { extras: true }) });
    await run(page);
    const item = '.rf-item[data-id="146500004"]'; // "6 month lease only. Dishwasher."
    assert.match(await page.$eval(`${item} .rf-watch span`, (el) => el.title), /From the listing text: "[^"]*6 month lease only"/);
    await page.click('#rf-more summary'); await settle(page);
    await page.fill('#rf-keyword', 'lease'); await page.dispatchEvent('#rf-keyword', 'change');
    await page.waitForSelector(`${item} .rf-kwq`);
    assert.match(await page.textContent(`${item} .rf-kwq`), /matched: .*6 month lease only/);
    await page.hover(item); await page.click(`${item} .rf-acts-more summary`); await page.click(`${item} [data-act=case]`);
    await waitStatus(page, /^Tag phrases copied as test cases/);
    assert.match(await page.evaluate(() => navigator.clipboard.readText()), /"[^"]*6 month lease only", 'short'\],/);
    console.log('why this tag: ok');
    await done(page); await ctx.close();
  });

  // 49. Rent trend: each visit adds a point to the remembered search; Saved searches and the
  // market view say how the median and the count moved.
  await block('49', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx, SEARCH, { route: serve([], { pages: 3, perPage: 12 }) });
    await run(page);
    await page.evaluate(() => { // an earlier visit, five weeks ago
      const k = 'rea-avail-filter/snapshots/v1', d = JSON.parse(localStorage.getItem(k));
      for (const e of Object.values(d.s)) e.trend = [{ t: e.at - 35 * 864e5, n: 20, m: { 2: 950 } }, ...e.trend];
      localStorage.setItem(k, JSON.stringify(d));
    });
    await page.click('.rf-market-btn');
    assert.match(await page.textContent('.rf-market .rf-trend'), /^Trend: 2-bed median \$950 → \$\d+ over 5 weeks · 20 → 36 listings$/);
    await page.reload(); await page.addScriptTag({ content: SCRIPT }); await page.waitForSelector('#rf-panel[data-rf-ready]', { state: 'attached' });
    await page.click('#rf-launch'); await page.click('.rf-saved summary');
    assert.match(await page.textContent('.rf-saved .rf-trend'), /2-bed median \$950 → /);
    console.log('rent trend: ok');
    await done(page); await ctx.close();
  });

  // 50. Map view (v): one dot per listing with a location, places as pins; a dot goes back to
  // the list on that listing.
  await block('50', async () => {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => { if (!localStorage.getItem('rea-avail-filter/v1')) localStorage.setItem('rea-avail-filter/v1', JSON.stringify({ places: 'Work: -33.87, 151.21' })); });
    const page = await open(ctx);
    await run(page);
    const n = await count(page);
    await page.focus('.rf-item'); await page.keyboard.press('v');
    await page.waitForSelector('.rf-map svg');
    assert.equal(await page.getAttribute('.rf-map-btn', 'aria-pressed'), 'true');
    assert.equal(await page.$$eval('.rf-map [data-map-id]', (d) => d.length), n, 'every listing shown has a location in the fixtures');
    assert.match(await page.textContent('.rf-map-pin'), /Work/);
    assert.equal(await page.$$eval('.rf-map [data-map-id][tabindex="0"]', (d) => d.length), 1, 'one tab stop for the whole map');
    await page.focus('.rf-map [data-map-id][tabindex="0"]');
    const from = await page.evaluate(() => document.activeElement.dataset.mapId);
    await page.keyboard.press('ArrowDown');
    if (await page.evaluate(() => document.activeElement.dataset.mapId) === from) await page.keyboard.press('ArrowUp'); // it may be the lowest dot
    const to = await page.evaluate(() => document.activeElement.dataset.mapId);
    assert.ok(to && to !== from, 'arrow keys move between dots');
    assert.equal(await page.$eval('.rf-map [data-map-id][tabindex="0"]', (d) => d.dataset.mapId), to, 'and the tab stop follows');
    const id = await page.$eval('.rf-map [data-map-id]:last-of-type', (d) => d.dataset.mapId);
    await page.focus(`.rf-map [data-map-id="${id}"]`); await page.keyboard.press('Enter');
    await page.waitForFunction((i) => document.activeElement?.dataset?.id === i, id);
    assert.equal(await page.getAttribute('.rf-map-btn', 'aria-pressed'), 'false', 'back to the list');
    await page.click('.rf-market-btn'); await page.click('.rf-map-btn');
    assert.equal(await page.getAttribute('.rf-market-btn', 'aria-pressed'), 'false', 'map and market are one at a time');
    console.log('map view: ok');
    await done(page); await ctx.close();
  });

  // 51. The documented list keys nothing else presses: PgDn/PgUp by 5, g/Home and G/End, c copies.
  await block('51', async () => {
    const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await open(ctx);
    await run(page);
    const pos = () => page.evaluate(() => [...document.querySelectorAll('.rf-item')].indexOf(document.activeElement));
    await page.focus('.rf-item');
    await page.keyboard.press('PageDown'); assert.equal(await pos(), 5);
    await page.keyboard.press('PageUp'); assert.equal(await pos(), 0);
    await page.keyboard.press('End'); assert.equal(await pos(), (await count(page)) - 1);
    await page.keyboard.press('g'); assert.equal(await pos(), 0);
    await page.keyboard.press('G'); await page.keyboard.press('Home'); assert.equal(await pos(), 0);
    await page.keyboard.press('c');
    await page.waitForFunction(() => navigator.clipboard.readText().then((t) => t.length > 20));
    assert.match(await page.evaluate(() => navigator.clipboard.readText()), /per week/);
    // AZERTY and similar: "2" is typed with Shift, and must still set the status, not a rating.
    await page.hover('.rf-item'); await page.click('.rf-item >> [data-act=s]');
    const sid = await page.$eval('.rf-item', (el) => el.dataset.id);
    await page.click('[data-view=shortlist]');
    await page.focus(`.rf-item[data-id="${sid}"]`);
    await page.evaluate(() => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: '2', code: 'Digit2', shiftKey: true, bubbles: true })));
    await page.waitForFunction((i) => JSON.parse(localStorage.getItem('rea-avail-filter/marks/v1')).m[i].as === 'inspected', sid);
    assert.equal((await marks(page))[sid].rt, undefined, 'no rating from a typed digit');
    console.log('list keys PgDn/PgUp/Home/End/c, AZERTY digits: ok');
    await done(page); await ctx.close();
  });

  // 52. Your rating: Shift+1-5 on the Shortlist tab, shown in Compare, and set from the
  // listing-page bar.
  await block('52', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await run(page);
    const id = await page.$eval('.rf-item', (el) => el.dataset.id);
    await page.evaluate(() => { document.querySelectorAll('.rf-item')[1]._tag = 1; });
    await page.hover('.rf-item'); await page.click('.rf-item >> [data-act=s]');
    assert.equal(await page.evaluate(() => document.querySelectorAll('.rf-item')[1]._tag), 1, 'a star rebuilds only its own listing');
    await page.click('[data-view=shortlist]');
    await page.focus(`.rf-item[data-id="${id}"]`);
    await page.keyboard.press('Shift+Digit4');
    await waitStatus(page, /^Rated 4 of 5/);
    assert.equal((await marks(page))[id].rt, 4);
    assert.equal(await page.getAttribute(`.rf-item[data-id="${id}"] [data-act=rate][data-v="4"]`, 'aria-pressed'), 'true');
    await page.click('[data-sl=compare]');
    assert.match(await page.textContent('.rf-list'), /My rating.*★★★★ 4\/5/s);
    await page.click('[data-sl=compare]');
    await page.goto(`${ORIGIN}/property-unit-nsw-bondi-${id}`); await page.addScriptTag({ content: SCRIPT });
    await page.waitForSelector('#rf-lbar');
    await page.click('#rf-lbar .rf-lbar-more summary');
    await page.click('#rf-lbar [data-l=rt][data-v="2"]');
    assert.equal((await marks(page))[id].rt, 2, 'rated from the listing page');
    console.log('rating: ok');
    await done(page); await ctx.close();
  });

  // 53. Next stop on the listing-page bar: the next shortlisted inspection today, how far, and
  // when to leave; it links to that listing.
  await block('53', async () => {
    const ctx = await browser.newContext();
    await ctx.addInitScript((t) => {
      if (localStorage.getItem('rea-avail-filter/marks/v1')) return;
      const d = (id, a, la, at) => ({ u: `https://www.realestate.com.au/property-unit-nsw-bondi-${id}`, a, la, ln: 151.2767, in: at ? [{ at, label: 'later today' }] : [] });
      localStorage.setItem('rea-avail-filter/marks/v1', JSON.stringify({ v: 1, m: {
        146500101: { f: 1, l: 1, s: 1, st: 1, d: d(146500101, '1 Hall St, Bondi NSW 2026', -33.8915, 0) },
        146500222: { f: 1, l: 1, s: 1, st: 1, d: d(146500222, '5 Beach Rd, Bondi NSW 2026', -33.9005, t + 75 * 60000) },
        146500333: { f: 1, l: 1, s: 1, st: 1, d: d(146500333, '9 Roscoe St, Bondi NSW 2026', -33.8915, t + 150 * 60000) },
        146500444: { f: 1, l: 1, s: 1, st: 1, as: 'declined', d: d(146500444, '2 Gone Ave, Bondi NSW 2026', -33.8915, t + 100 * 60000) },
      } }));
    }, FIXED.getTime());
    const page = await open(ctx, `${ORIGIN}/property-unit-nsw-bondi-146500101`);
    await page.waitForSelector('#rf-lbar .rf-lbar-next');
    assert.match(await page.textContent('#rf-lbar .rf-lbar-next'), /^Next: 11:15\s?am 5 Beach Rd · 1 km · leave by 11:05\s?am$/i);
    assert.match(await page.getAttribute('#rf-lbar .rf-lbar-next a', 'href'), /146500222$/);
    await page.click('#rf-lbar .rf-lbar-more summary');
    const ck = await page.$eval('#rf-lbar [data-l=ck]:nth-child(3)', (b) => b.dataset.ck);
    await page.focus(`#rf-lbar [data-ck="${ck}"]`);
    await page.clock.fastForward(61000); // the minute redraw keeps focus on the same item
    assert.equal(await page.evaluate(() => document.activeElement.dataset.ck), ck);
    await page.clock.fastForward(80 * 60000); // past 11:15: the bar moves on by itself (a declined one is skipped)
    await page.waitForFunction(() => /9 Roscoe St/.test(document.querySelector('#rf-lbar .rf-lbar-next')?.textContent || ''));
    assert.match(await page.textContent('#rf-lbar .rf-lbar-next'), /^Next: 12:30\s?pm 9 Roscoe St/i);
    console.log('next stop: ok');
    await done(page); await ctx.close();
  });

  // 54. A format change isn't a bot check: page 2 with spaces around the "=" still reads; page 3
  // as a full-size page with no data shows the format warning with Copy report, and nothing pauses.
  await block('54', async () => {
    const ctx = await browser.newContext();
    const base = serve([], { pages: 3 });
    const page = await open(ctx, SEARCH, { route: async (route) => {
      const u = route.request().url();
      if (/list-2/.test(u)) return route.fulfill({ status: 200, contentType: 'text/html', body: reaPage(2, { pages: 3 }).replace('window.ArgonautExchange=', 'window.ArgonautExchange = ') });
      if (/list-3/.test(u)) return route.fulfill({ status: 200, contentType: 'text/html', body: `<html><body>${'<div class="card">listing</div>'.repeat(1000)}</body></html>` });
      return base(route);
    } });
    await page.click('#rf-launch'); await page.click('#rf-run');
    await page.waitForSelector('.rf-partial:not([hidden])');
    assert.match(await page.textContent('.rf-partial'), /Read 2 of 3 pages/, 'page 2 with a spaced blob was read');
    assert.match(await page.textContent('.rf-warn-msg'), /may have changed its format/);
    assert.ok(await page.isVisible('.rf-warnbar .rf-report'), 'Copy report offered');
    assert.equal(await page.evaluate(() => localStorage.getItem('rea-avail-filter/paused')), null, 'not a bot check: nothing paused');
    await page.unroute('**/*'); await page.route('**/*', serve([], { pages: 3 }));
    await page.click('#rf-refresh');
    await page.waitForFunction(() => !/changed its format/.test(document.querySelector('.rf-warnbar:not([hidden])')?.textContent || ''), null, { timeout: 8000 });
    console.log('format change vs bot check: ok');
    await done(page); await ctx.close();
  });

  // 55. The script's own errors in handlers and observers are logged for selfcheck() and, three in
  // a minute, shown with Copy report; they don't escape to REA's page.
  await block('55', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await page.click('#rf-launch');
    await page.evaluate(() => { // break the card badges: every annotate throws
      const qsa = Document.prototype.querySelectorAll;
      Document.prototype.querySelectorAll = function (sel) { if (/article/.test(sel)) throw new Error('boom from a test'); return qsa.call(this, sel); };
    });
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => document.querySelector('main').append(document.createElement('article')));
      await page.clock.runFor(1000);
    }
    await page.waitForFunction(() => /errors in the last minute \(latest: annotate\)/.test(document.querySelector('.rf-warn-msg')?.textContent || ''));
    assert.ok(await page.isVisible('.rf-warnbar .rf-report'), 'Copy report offered');
    assert.match(await page.evaluate(() => window.reaFilter.selfcheck()), /annotate: boom from a test/);
    await page.clock.runFor(61000); // a quiet minute: the warning goes, the log stays
    await page.waitForFunction(() => !/errors in the last minute/.test(document.querySelector('.rf-warnbar:not([hidden])')?.textContent || ''));
    assert.match(await page.evaluate(() => window.reaFilter.selfcheck()), /annotate: boom from a test/);
    console.log('own errors logged and shown: ok');
    await done(page); await ctx.close();
  });

  // 56. Safety copy: choices are mirrored into IndexedDB; after this site's storage is cleared, the
  // drawer offers them back (preview, Restore); Cancel discards the copy for good.
  await block('56', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await run(page);
    const id = await page.$eval('.rf-item', (el) => el.dataset.id);
    await page.hover('.rf-item'); await page.click('.rf-item >> [data-act=s]');
    await page.clock.runFor(2500); // past MIRROR_DELAY_MS
    const copied = () => page.evaluate(() => new Promise((res) => {
      const r = indexedDB.open('rea-avail-filter/mirror', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => { const g = r.result.transaction('kv').objectStore('kv').get('copy'); g.onsuccess = () => { res(g.result ? Object.keys(g.result.data.m) : null); r.result.close(); }; };
    }));
    assert.deepEqual(await copied(), [id], 'the shortlist is mirrored');
    await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('rea-avail-filter/')) localStorage.removeItem(k); });
    await page.reload(); await page.addScriptTag({ content: SCRIPT }); await page.waitForSelector('#rf-panel[data-rf-ready]', { state: 'attached' });
    // A star on REA's card before the offer is answered doesn't replace the copy.
    await page.waitForFunction(() => document.querySelectorAll('article > .rf-badge [data-card-act=s]').length > 1);
    const other = await page.$$eval('article > .rf-badge [data-card-act=s]', (bs, i) => bs.find((b) => b.dataset.id !== i).dataset.id, id);
    await page.click(`article > .rf-badge [data-card-act=s][data-id="${other}"]`);
    await page.clock.runFor(2500);
    assert.deepEqual(await copied(), [id], 'copy held while its offer is unanswered');
    await page.reload(); await page.addScriptTag({ content: SCRIPT }); await page.waitForSelector('#rf-panel[data-rf-ready]', { state: 'attached' });
    await page.click('#rf-launch');
    await page.waitForSelector('.rf-restore-in:not([hidden])');
    assert.match(await page.textContent('.rf-restore-msg'), /^Some of your shortlist in this browser has gone \(its storage was cleared\)\. A safety copy from .* has 1 listing \(1 shortlisted/);
    await page.click('[data-restore=yes]');
    await waitStatus(page, /^Restored 1 listing/);
    assert.equal((await marks(page))[id].s, 1, 'shortlist back');
    // Emptied on purpose: Cancel drops the copy, and it isn't offered again.
    await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('rea-avail-filter/')) localStorage.removeItem(k); });
    await page.reload(); await page.addScriptTag({ content: SCRIPT }); await page.waitForSelector('#rf-panel[data-rf-ready]', { state: 'attached' });
    await page.click('#rf-launch');
    await page.waitForSelector('.rf-restore-in:not([hidden])');
    assert.equal(await page.textContent('[data-restore=no]'), 'Discard copy', 'says what it does');
    await page.click('[data-restore=later]');
    await waitStatus(page, /^The safety copy is kept/);
    await page.reload(); await page.addScriptTag({ content: SCRIPT }); await page.waitForSelector('#rf-panel[data-rf-ready]', { state: 'attached' });
    await page.click('#rf-launch');
    await page.waitForSelector('.rf-restore-in:not([hidden])'); // Not now: offered again
    await page.click('[data-restore=no]');
    await waitStatus(page, /^Safety copy discarded/);
    await page.waitForFunction(() => new Promise((res) => { const r = indexedDB.open('rea-avail-filter/mirror', 1); r.onsuccess = () => { const g = r.result.transaction('kv').objectStore('kv').get('copy'); g.onsuccess = () => { res(!g.result); r.result.close(); }; }; }));
    // Answered: a star from the listing page's bar is copied again.
    await page.goto(`${ORIGIN}/property-unit-nsw-bondi-${id}`); await page.addScriptTag({ content: SCRIPT });
    await page.waitForSelector('#rf-lbar');
    await page.click('#rf-lbar [data-l=s]');
    await page.clock.runFor(2500);
    assert.deepEqual(await copied(), [id], 'listing-bar changes are mirrored');
    console.log('safety copy: ok');
    await done(page); await ctx.close();
  });

  // 25. Drift canary + selfcheck: prime the usual rates, then serve pages without inspections.
  await block('25', async () => {
    const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    await ctx.addInitScript(() => localStorage.setItem('rea-avail-filter/health/v1', JSON.stringify({ n: 5, ema: { inspections: 0.5, availability: 1, price: 0.9 } })));
    const page = await open(ctx, SEARCH, { route: serve([], { pages: 4, perPage: 6, noInspections: true }) });
    await page.click('#rf-launch'); await page.click('#rf-run');
    await page.waitForFunction(() => /REA may have changed its data: inspections on 0%/.test(document.querySelector('.rf-warnbar:not([hidden])')?.textContent || ''), null, { timeout: 15000 });
    assert.match(await status(page), /listings match/, 'status keeps the match count');
    const report = await page.evaluate(() => window.reaFilter.selfcheck());
    assert.match(report, /inspections 0%\/\d+%/);
    assert.match(report, /page: \/rent\//);
    await page.click('.rf-warnbar .rf-report');
    await waitStatus(page, /^Report copied/);
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(copied, /^rea-enhancement .*[\s\S]*listing shape:\n\{/, 'selfcheck and shape in one paste');
    assert.ok(!/Curlewis|Bondi Realty|Pets considered/.test(copied), 'no listing text, names or addresses');
    console.log('drift canary + selfcheck + copy report: ok');
    await done(page); await ctx.close();
  });

  // 26. Re-check: listing pages update price / mark 404s as no longer listed.
  await block('26', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await run(page);
    const ids = await page.$$eval('.rf-item', (e) => e.map((x) => x.dataset.id));
    const pickGone = ids.find((i) => i.endsWith('3')), pickOk = ids.find((i) => !i.endsWith('3'));
    for (const id of [pickGone, pickOk]) { await page.hover(`.rf-item[data-id="${id}"]`); await page.click(`.rf-item[data-id="${id}"] >> [data-act=s]`); }
    await page.click('[data-view=shortlist]');
    await page.click('[data-sl=recheck]');
    await waitStatus(page, /Re-checked 2: 1 updated, 1 no longer listed/, 20000);
    assert.match(await page.textContent(`.rf-item[data-id="${pickGone}"]`), /no longer listed/);
    assert.match(await page.textContent(`.rf-item[data-id="${pickOk}"]`), /\$999 per week/);
    console.log('re-check shortlist: ok');
    await done(page); await ctx.close();
  });

  // 27. Copy summary (button + 'c'), hide suburb with undo, compare only ticked listings.
  await block('27', async () => {
    const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await open(ctx);
    await run(page);
    await page.hover('.rf-item'); await page.click('.rf-item >> [data-act=copy]');
    await waitStatus(page, /summary copied/);
    assert.match(await page.evaluate(() => navigator.clipboard.readText()), /per week - .*\nAvailable|https:\/\/www\.realestate/);
    const total = await count(page);
    await page.click('.rf-item >> .rf-acts-more summary'); await page.click('.rf-item >> [data-act=sb]');
    assert.equal(await count(page), 0, 'every fixture is in Bondi');
    await page.click('.rf-status .rf-undo');
    assert.equal(await count(page), total);
    const ids = await page.$$eval('.rf-item', (e) => e.slice(0, 3).map((x) => x.dataset.id));
    for (const id of ids) { await page.hover(`.rf-item[data-id="${id}"]`); await page.click(`.rf-item[data-id="${id}"] >> [data-act=s]`); }
    await page.click('[data-view=shortlist]');
    await page.hover(`.rf-item[data-id="${ids[2]}"]`); await page.check(`input[data-cmp="${ids[2]}"]`);
    await page.focus(`.rf-item[data-id="${ids[0]}"]`); await page.keyboard.press('x');
    assert.ok(await page.isChecked(`input[data-cmp="${ids[0]}"]`), 'x ticks Compare');
    await page.click('[data-sl=compare]');
    assert.equal(await page.$$eval('.rf-compare thead th', (e) => e.length), 2, 'only ticked listings compared');
    console.log('copy / hide suburb / compare selection: ok');
    await done(page); await ctx.close();
  });

  // 28. Enter on a focused button presses it (no listing tab); Esc outside the drawer isn't ours.
  await block('28', async () => { const ctx = await browser.newContext(); const page = await open(ctx);
    await run(page);
    const id = await page.$eval('.rf-item', (e) => e.dataset.id);
    let popups = 0; ctx.on('page', () => popups++);
    await page.focus(`.rf-item[data-id="${id}"] [data-act=s]`);
    await page.keyboard.press('Enter');
    await page.waitForFunction((i) => document.querySelector(`.rf-item[data-id="${i}"] [data-act=s]`)?.getAttribute('aria-pressed') === 'true', id, { timeout: 2000 });
    assert.equal(popups, 0, 'no listing tab opened');
    await settle(page); // the star's redraw puts focus back a task later (wireFocusKeep): before leaving the drawer
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press('Escape');
    assert.equal(await page.$eval('#rf-panel', (p) => p.hidden), false, "Esc outside the drawer is REA's");
    console.log('enter on buttons + esc scope: ok'); await done(page); await ctx.close(); });

  // 57. Another tab writing marks (a search there records sightings) redraws this tab, but an
  // Undo just offered here stays, with its hide reasons, and still works.
  await block('57', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await run(page);
    const id = await page.getAttribute('.rf-item', 'data-id');
    await page.click(`.rf-item[data-id="${id}"] [data-act=h]`);
    await waitStatus(page, /^Listing hidden/);
    const other = await ctx.newPage();
    await other.route('**/*', serve()); await other.goto(SEARCH);
    await other.evaluate(() => { const k = 'rea-avail-filter/marks/v1', d = JSON.parse(localStorage.getItem(k)); d.m['146599999'] = { f: 1, l: 1, n: 'from the other tab' }; localStorage.setItem(k, JSON.stringify(d)); });
    await page.waitForTimeout(300);
    assert.match(await status(page), /^Listing hidden/, 'the Undo offer survives the redraw');
    assert.ok(await page.$('.rf-status .rf-why'), 'hide reasons too');
    await page.click('.rf-status .rf-undo');
    assert.ok(!(await marks(page))[id]?.h, 'undo still works');
    assert.equal((await marks(page))['146599999']?.n, 'from the other tab', "and keeps the other tab's change");
    console.log('undo across tabs: ok');
    await other.close(); await done(page); await ctx.close();
  });

  // 58. Inspections at my times: "weekends" typed as my times matches the built-in Weekends;
  // unreadable times explain themselves; Clear keeps the times.
  await block('58', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await run(page);
    await page.click('#rf-more summary'); await settle(page);
    await page.selectOption('#rf-inspectWhen', 'weekend');
    const weekend = await count(page);
    assert.equal(await page.isVisible('#rf-inspectFree'), true, 'your times can be set whatever the filter: {mytimes} and the day planner use them too');
    await page.selectOption('#rf-inspectWhen', 'mine');
    await page.fill('#rf-inspectFree', 'weekends'); await page.dispatchEvent('#rf-inspectFree', 'change');
    await page.waitForFunction((n) => document.querySelectorAll('.rf-item').length === n, weekend);
    assert.ok(await page.$$eval('.rf-achip', (cs) => cs.some((c) => /Inspect at my times/.test(c.textContent))), 'chip shown');
    await page.fill('#rf-inspectFree', 'whenever'); await page.dispatchEvent('#rf-inspectFree', 'change');
    await waitStatus(page, /my times/);
    await page.fill('#rf-inspectFree', 'Sat 9-13'); await page.dispatchEvent('#rf-inspectFree', 'change');
    await page.click('.rf-clear');
    assert.equal(await page.inputValue('#rf-inspectWhen'), '');
    assert.equal(await page.inputValue('#rf-inspectFree'), 'Sat 9-13', 'Clear keeps your times');
    console.log('inspections at my times: ok');
    await done(page); await ctx.close();
  });

  // 59. Applications close: a shortlisted listing whose deadline is in two days is under Needs
  // action with a nudge; Mark applied clears it; the calendar carries the deadline.
  await block('59', async () => {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => {
      if (localStorage.getItem('rea-avail-filter/marks/v1')) return;
      localStorage.setItem('rea-avail-filter/marks/v1', JSON.stringify({ v: 1, m: {
        146500101: { f: 1, l: 1, s: 1, st: 1, d: { u: 'https://www.realestate.com.au/property-unit-nsw-bondi-146500101', a: '1 Hall St, Bondi NSW 2026', ab: '2026-09-25' } },
        146500102: { f: 1, l: 1, s: 1, st: 1, d: { u: 'https://www.realestate.com.au/property-unit-nsw-bondi-146500102', a: '2 Hall St, Bondi NSW 2026', ab: '2026-10-20' } },
      } }));
    });
    const page = await open(ctx);
    await page.click('#rf-launch');
    await page.click('.rf-settings > summary');
    await page.fill('#rf-leaseEnd', '2026-10-20'); await page.dispatchEvent('#rf-leaseEnd', 'change');
    await page.fill('#rf-noticeDays', '150'); await page.dispatchEvent('#rf-noticeDays', 'change');
    assert.equal(await page.inputValue('#rf-noticeDays'), '120', 'out of range: clamped, not silently reset later');
    await page.fill('#rf-noticeDays', '21'); await page.dispatchEvent('#rf-noticeDays', 'change');
    await page.click('[data-view=shortlist]');
    await page.selectOption('.rf-sl-filter', '!');
    assert.deepEqual(await page.$$eval('.rf-item', (e) => e.map((x) => x.dataset.id)), ['146500101'], 'only the close deadline needs action');
    const launchText = await page.textContent('#rf-launch'); assert.match(launchText, /· ● 2 to do$/, `the launcher names it: the deadline and your notice date (${launchText})`);
    assert.match(await page.textContent('.rf-item .rf-nudge'), /Applications close Fri,? 25 Sept?: apply\?/);
    assert.match(await page.textContent('.rf-item'), /Apply by Fri,? 25 Sept?/);
    // The application pack: tick what's ready; the apply nudge counts it.
    assert.equal(await page.textContent('.rf-sl-ticks summary'), 'Application pack: 0 of 5 ready');
    await page.click('.rf-sl-ticks summary');
    await page.click('.rf-sl-ticks [data-pack="Payslips"]');
    assert.equal(await page.getAttribute('.rf-sl-ticks [data-pack="Payslips"]', 'aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.pack), 'Payslips', 'focus stays on the chip');
    assert.match(await page.textContent('.rf-item .rf-nudge'), /apply\? Pack: 1 of 5 ready\./);
    await page.click('.rf-sl-ticks [data-edit-list]'); // the list itself is in Settings, on Results
    assert.equal(await page.evaluate(() => document.activeElement.id), 'rf-packList');
    assert.ok(await page.$('.rf-settings[open]'));
    assert.ok(await page.isVisible('[data-backup-here]'), 'Backup beside Last backup');
    await page.click('[data-view=shortlist]');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.rf-menu summary').then(() => page.click('.rf-sl-bar [data-export=ics]'))]);
    const ics = fs.readFileSync(await dl.path(), 'utf8');
    assert.match(ics, /UID:146500101-ab@rea-enhancement\r\n[\s\S]*?DTSTART;VALUE=DATE:20260925/);
    assert.match(ics, /UID:notice@rea-enhancement\r\n[\s\S]*?DTSTART;VALUE=DATE:20260929/, 'your notice period, from Settings');
    // Within two weeks of the notice date: the Shortlist says so, until you say you've given it.
    assert.match(await status(page), /Give notice by 29 Sept? \(6 days\) for your lease ending 20 Oct/);
    // Approved somewhere: that leads, with what's still waiting.
    await page.selectOption('.rf-sl-filter', '');
    await page.selectOption('.rf-item[data-id="146500102"] select[data-app]', 'approved');
    await page.waitForFunction(() => /Approved for 2 Hall St\. Give notice by 29 Sept?/.test(document.querySelector('.rf-status').textContent));
    await page.click('.rf-status button:has-text("I\'ve given notice")');
    await waitStatus(page, /^Noted: notice given/);
    assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('rea-avail-filter/v1')))).noticeGiven, '2026-09-23');
    // Notice given: the moving list takes the pack's place, and its next item leads.
    assert.match(await page.textContent('.rf-sl-ticks summary'), /^Moving list 0\/10 · next: Pay the bond$/);
    assert.equal(await page.$('.rf-sl-ticks > details:first-child > .rf-meta'), null, 'no rent or bond known: nothing claimed as left to pay');
    await page.click('.rf-sl-ticks [data-mv="Pay the bond"]');
    await page.waitForFunction(() => /^Moving list 1\/10 · next: Pay rent in advance$/.test(document.querySelector('.rf-sl-ticks summary')?.textContent));
    assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('rea-avail-filter/v1')))).moveDone, '146500102|Pay the bond');
    // The condition report, room by room, beside it.
    await page.click('.rf-ecr summary');
    await page.click('.rf-ecr [data-ecr="Kitchen"]');
    assert.match(await page.textContent('.rf-ecr summary'), /^Condition report 1\/\d+/);
    assert.match((await page.evaluate(() => JSON.parse(localStorage.getItem('rea-avail-filter/v1')))).ecrDone, /^146500102\|Kitchen$/);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.ecr), 'Kitchen');
    await page.click('.rf-item .rf-nudge [data-na=applied]');
    assert.equal((await marks(page))['146500101'].as, 'applied');
    await page.waitForFunction(() => !document.querySelector('.rf-item .rf-nudge'));
    console.log('applications close: ok');
    await done(page); await ctx.close();
  });

  // 60. Noise heads-ups: said of the home ("above a popular bar, on a busy road"), tagged, and
  // the Busy road chip hides it.
  await block('60', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx, SEARCH, { route: serve([], { extras: true }) });
    await run(page);
    const item = '.rf-item[data-id="146500006"]';
    assert.match(await page.textContent(`${item} .rf-watch`), /Above shops\/bar[\s\S]*Busy road|Busy road[\s\S]*Above shops\/bar/);
    assert.doesNotMatch(await page.textContent(`${item}`), /Next to rail line/, '"walk to the station" is not a rail heads-up');
    // Where each tag came from, reachable without a mouse.
    await page.click(`${item} .rf-acts-more summary`);
    await page.click(`${item} [data-act=whytags]`);
    assert.match(await page.textContent(`${item} .rf-whytags`), /Busy road: From the listing text: ".*busy road/);
    assert.ok(await page.evaluate(() => document.activeElement.classList.contains('rf-whytags')), 'focus moves to the explanation');
    await page.click(`${item} .rf-acts-more summary`);
    assert.equal(await page.getAttribute(`${item} [data-act=whytags]`, 'aria-expanded'), 'true');
    await page.click(`${item} [data-act=whytags]`);
    assert.equal(await page.$(`${item} .rf-whytags`), null, 'toggles closed');
    await page.click('#rf-more summary'); await settle(page);
    await page.click('[data-nowatch=road]');
    await page.waitForFunction((s) => !document.querySelector(s), item);
    assert.ok(await page.$('.rf-achip:has-text("No busy road")'), 'chip shown');
    console.log('noise heads-ups: ok');
    await done(page); await ctx.close();
  });

  // 61. A backup file restored while the safety copy's offer waits doesn't overwrite the copy:
  // the copy is offered again for what the file didn't bring back.
  await block('61', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await run(page);
    const ids = await page.$$eval('.rf-item', (e) => e.slice(0, 2).map((x) => x.dataset.id));
    for (const id of ids) { await page.hover(`.rf-item[data-id="${id}"]`); await page.click(`.rf-item[data-id="${id}"] >> [data-act=s]`); }
    await page.clock.runFor(2500);
    const file = { app: 'rea-enhancement', kind: 'marks', v: 1, m: { [ids[0]]: (await marks(page))[ids[0]] } };
    await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('rea-avail-filter/')) localStorage.removeItem(k); });
    await page.reload(); await page.addScriptTag({ content: SCRIPT }); await page.waitForSelector('#rf-panel[data-rf-ready]', { state: 'attached' });
    await page.click('#rf-launch');
    await page.waitForSelector('.rf-restore-in:not([hidden])');
    assert.match(await page.textContent('.rf-restore-msg'), /safety copy .* has 2 listings/);
    await page.click('[data-view=shortlist]');
    await page.setInputFiles('.rf-sl-bar input[type=file]', { name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
    await page.waitForFunction(() => /^Restore 1 listing/.test(document.querySelector('.rf-restore-msg')?.textContent || ''));
    await page.click('[data-restore=yes]');
    await page.waitForFunction(() => /^Some of your shortlist .* has 2 listings/.test(document.querySelector('.rf-restore-in:not([hidden]) .rf-restore-msg')?.textContent || ''), null, { timeout: 5000 });
    await page.click('[data-restore=yes]');
    await waitStatus(page, /^Restored/);
    const m = await marks(page);
    assert.ok(ids.every((id) => m[id]?.s === 1), 'both back');
    console.log('file restore while the safety copy waits: ok');
    await done(page); await ctx.close();
  });

  // 62. Max cash to move: a chip, fewer listings, and Clear takes it off.
  await block('62', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await run(page);
    const total = await count(page);
    await page.click('#rf-more summary'); await settle(page);
    await page.fill('#rf-cashMax', '4000'); await page.dispatchEvent('#rf-cashMax', 'change');
    await page.waitForFunction((n) => document.querySelectorAll('.rf-item').length < n, total);
    assert.ok(await page.$('.rf-achip:has-text("Cash to move ≤ $4,000")'), 'chip shown');
    await page.click('.rf-clear');
    assert.equal(await page.inputValue('#rf-cashMax'), '');
    assert.equal(await count(page), total);
    console.log('max cash to move: ok');
    await done(page); await ctx.close();
  });

  // 63. From real shapes: every test/shapes/*.json (reaFilter.shape() of REA's own data) is served,
  // search shapes as a results page and listing shapes as a property page, and the drawer and the
  // listing bar read them. A structure change REA ships breaks here in the UI, not only in units.
  await block('63', async () => {
    const dir = path.join(__dirname, '../shapes');
    const shapes = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    const withId = (l, id) => ({ ...l, id, _links: { ...l._links, canonical: { href: `${ORIGIN}/property-apartment-nsw-bondi-${id}` } } });
    const search = shapes.filter((x) => x.kind !== 'listing').flatMap((x, i) => [0, 1, 2].map((k) => withId(shapeKit.listingFromShape(x.listing), String(146700000 + i * 10 + k))));
    const prop = shapes.find((x) => x.kind === 'listing');
    assert.ok(search.length && prop, 'a search and a listing shape to serve');
    const route = (r) => {
      const u = new URL(r.request().url());
      if (u.origin !== ORIGIN) return r.fulfill({ status: 204, body: '' });
      if (/^\/rent\//.test(u.pathname)) return r.fulfill({ status: 200, contentType: 'text/html', body: shapeKit.page(shapeKit.results({ exact: search })) });
      const id = u.pathname.match(/-(\d+)$/)?.[1];
      const data = { details: { listing: withId(shapeKit.listingFromShape(prop.listing), id) } };
      const ex = { 'resi-property_details-web': { urqlClientCache: JSON.stringify({ q1: { data: JSON.stringify(data) } }) } };
      return r.fulfill({ status: 200, contentType: 'text/html', body: `<html><body><script>window.ArgonautExchange=${JSON.stringify(ex)};</script></body></html>` });
    };
    const ctx = await browser.newContext();
    const page = await open(ctx, SEARCH, { route });
    await run(page);
    assert.equal(await count(page), search.length, 'every shaped listing listed');
    const first = await page.textContent('.rf-item');
    assert.match(first, /\$\d[\d,]* per week/, 'rent read');
    assert.match(await page.getAttribute('.rf-item .rf-card', 'href'), /^https:\/\/www\.realestate\.com\.au\/property-/, 'link kept');
    await page.goto(`${ORIGIN}/property-apartment-nsw-bondi-146799999`); await page.addScriptTag({ content: SCRIPT });
    await page.waitForSelector('#rf-lbar');
    await page.click('#rf-lbar [data-l=s]');
    const e = (await marks(page))['146799999'];
    assert.equal(e?.s, 1, 'shortlisted from a listing page built from its shape');
    assert.match(e.d.p, /\$\d/, 'its rent read from the listing shape');
    console.log(`real shapes in the UI (${shapes.length}): ok`);
    await done(page); await ctx.close();
  });

  // 64. On the listing page: a close deadline says so above the fold with Mark applied, and the
  // details carry cash to move and your record with the agency.
  await block('64', async () => {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => {
      if (!localStorage.getItem('rea-avail-filter/v1')) localStorage.setItem('rea-avail-filter/v1', JSON.stringify({ leaseEnd: '2026-10-20' }));
      if (localStorage.getItem('rea-avail-filter/marks/v1')) return;
      localStorage.setItem('rea-avail-filter/marks/v1', JSON.stringify({ v: 1, m: {
        146500101: { f: 1, l: 1, s: 1, st: 1, d: { u: 'https://www.realestate.com.au/property-unit-nsw-bondi-146500101', a: '1 Hall St, Bondi NSW 2026' } },
        146500102: { f: 1, l: 1, s: 1, st: 1, as: 'declined', ast: 1, d: { u: 'https://www.realestate.com.au/property-unit-nsw-bondi-146500102', a: '2 Hall St, Bondi NSW 2026', ag: 'Bondi Realty' } },
      } }));
    });
    const base = serve();
    const route = (r) => {
      if (!/146500101$/.test(new URL(r.request().url()).pathname)) return base(r);
      const l = { ...shapeKit.listing({ id: '146500101' }), description: 'Sunny unit. Applications close Fri 25 Sep.', listingCompany: { name: 'Bondi Realty' },
        _links: { canonical: { href: `${ORIGIN}/property-unit-nsw-bondi-146500101` } } };
      const ex = { 'resi-property_details-web': { urqlClientCache: JSON.stringify({ q1: { data: JSON.stringify({ details: { listing: l } }) } }) } };
      return r.fulfill({ status: 200, contentType: 'text/html', body: `<html><body><script>window.ArgonautExchange=${JSON.stringify(ex)};</script></body></html>` });
    };
    const page = await open(ctx, `${ORIGIN}/property-unit-nsw-bondi-146500101`, { route });
    await page.waitForSelector('#rf-lbar .rf-lbar-due');
    assert.match(await page.textContent('#rf-lbar .rf-lbar-due'), /Apply by Fri,? 25 Sept? · Pack: 0 of 5 ready: Mark applied/);
    await page.click('#rf-lbar .rf-lbar-more summary');
    const info = await page.textContent('#rf-lbar .rf-lbar-more .rf-lbar-info');
    assert.match(info, /cash to move \$[\d,]+/, 'cash to move with the lease overlap');
    assert.match(info, /Bondi Realty: you: 1 applied, 1 declined/, 'your record with this agency');
    await page.click('#rf-lbar [data-l=ap]');
    assert.equal((await marks(page))['146500101'].as, 'applied');
    assert.equal(await page.$('#rf-lbar .rf-lbar-due'), null, 'applied: the nudge goes');
    console.log('listing-page deadline, cash and record: ok');
    await done(page); await ctx.close();
  });

  // 65. REA ignoring /list-N (every page is page 1): the search stops at the repeat and says so,
  // with Copy report, instead of reading page 1 twenty times.
  await block('65', async () => {
    const ctx = await browser.newContext();
    const hits = [];
    const base = serve(hits, { pages: 3 });
    const page = await open(ctx, SEARCH, { route: (r) => (/list-[23]/.test(r.request().url()) ? r.fulfill({ status: 200, contentType: 'text/html', body: reaPage(1, { pages: 3 }) }) : base(r)) });
    await run(page);
    assert.match(await page.textContent('.rf-warn-msg'), /repeated the first, so the search stopped there/);
    assert.equal(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('rea-avail-filter/snapshots/v1') || '{"s":{}}').s || {}).length), 0, 'not remembered as a full crawl (the rest would count as gone)');
    assert.ok(await page.isVisible('.rf-warnbar .rf-report'), 'Copy report offered');
    console.log('pagination change guard: ok');
    await done(page); await ctx.close();
  });

  // 66. A redraw from another tab's change keeps focus where it was: the keyed paint swaps the
  // changed item in place and moves no other node.
  await block('66', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await run(page);
    const ids = await page.$$eval('.rf-item', (e) => e.slice(0, 6).map((x) => x.dataset.id));
    await page.focus(`.rf-item[data-id="${ids[5]}"] [data-act=s]`);
    const other = await ctx.newPage();
    await other.route('**/*', serve()); await other.goto(SEARCH);
    for (const [act, id] of [['star', ids[0]], ['hide', ids[1]]]) {
      await other.evaluate(([a, i]) => { const k = 'rea-avail-filter/marks/v1', d = JSON.parse(localStorage.getItem(k) || '{"v":1,"m":{}}'); d.m[i] = { ...(d.m[i] || { f: 1, l: 1 }), ...(a === 'star' ? { s: 1, st: 1 } : { h: 1 }) }; localStorage.setItem(k, JSON.stringify(d)); }, [act, id]);
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => document.activeElement.closest('.rf-item')?.dataset.id), ids[5], `focus kept after another tab's ${act}`);
    }
    console.log('focus kept across redraws: ok');
    await other.close(); await done(page); await ctx.close();
  });

  // 67. The Shortlist calendar remembers what it sent: unshortlist a listing and the next export
  // sends its open homes cancelled.
  await block('67', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await run(page);
    const ids = await page.$$eval('.rf-item', (els) => els.filter((e) => /Inspect /.test(e.textContent)).slice(0, 2).map((e) => e.dataset.id));
    for (const id of ids) { await page.hover(`.rf-item[data-id="${id}"]`); await page.click(`.rf-item[data-id="${id}"] >> [data-act=s]`); }
    await page.click('[data-view=shortlist]');
    const exportIcs = async () => { const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.rf-menu summary').then(() => page.click('.rf-sl-bar [data-export=ics]'))]); return fs.readFileSync(await dl.path(), 'utf8'); };
    await exportIcs();
    assert.ok(JSON.parse(await page.evaluate(() => localStorage.getItem('rea-avail-filter/ics/v1'))).length >= 2, 'sent events remembered');
    await page.hover(`.rf-item[data-id="${ids[1]}"]`); await page.click(`.rf-item[data-id="${ids[1]}"] >> [data-act=s]`);
    const second = await exportIcs();
    assert.match(second, new RegExp(`UID:${ids[1]}-\\d+@rea-enhancement\\r\\n[\\s\\S]*?STATUS:CANCELLED`), 'the unshortlisted listing is cancelled');
    assert.doesNotMatch(second, new RegExp(`UID:${ids[0]}-\\d+@rea-enhancement\\r\\n(?:(?!END:VEVENT)[\\s\\S])*STATUS:CANCELLED`), 'the other stays live');
    console.log('calendar remembers what it sent: ok');
    await done(page); await ctx.close();
  });

  // 68. A periodic lease: tick it and set your notice, and each listing's fit is worked out
  // against your notice period from today; other moving costs join Cash to move.
  await block('68', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await run(page);
    await page.click('.rf-settings > summary');
    await page.check('#rf-periodic');
    await page.fill('#rf-noticeDays', '21'); await page.dispatchEvent('#rf-noticeDays', 'change');
    await page.fill('#rf-moveCosts', '1500'); await page.dispatchEvent('#rf-moveCosts', 'change');
    await page.selectOption('#rf-sort', 'fit');
    await page.waitForFunction(() => /overlap|gap|starts right after your lease/.test(document.querySelector('.rf-list')?.textContent || ''));
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.rf-exports [data-export=csv]')]);
    const [head, line] = fs.readFileSync(await dl.path(), 'utf8').split('\r\n');
    const col = (h) => line.split(',')[head.split(',').indexOf(h)];
    assert.ok(+col('cash_to_move') >= +col('move_in_cost') + 1500, 'moving costs in cash to move');
    console.log('periodic lease and moving costs: ok');
    await done(page); await ctx.close();
  });

  // 69. On a phone, once there are results the controls fold into one bar, so the list starts at
  // the top; a tap opens them again, with the filter count and sort named on the bar.
  await block('69', async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true }); // not isMobile: the fixture pages have no viewport meta
    const page = await open(ctx);
    await page.click('#rf-launch');
    assert.equal(await page.isVisible('.rf-map-btn') || await page.isVisible('.rf-bulk'), false, 'nothing searched yet: Map and Bulk hidden, from the first open');
    await page.focus('#rf-run');
    await page.keyboard.press('Enter'); // searched from the keyboard: focus doesn't fall to the page when Search folds away
    await waitStatus(page, /listings match/); await settle(page);
    await page.waitForSelector('.rf-controls.rf-folded');
    await page.waitForFunction(() => document.activeElement?.classList.contains('rf-unfold'));
    assert.match(await page.textContent('.rf-unfold'), /^▸ Filters · Sort: Available date$/);
    assert.equal(await page.isVisible('#rf-from'), false, 'folded');
    const top = await page.$eval('.rf-item', (el) => el.getBoundingClientRect().top);
    assert.ok(top < 844 / 2, `first listing high on the screen (${Math.round(top)}px)`);
    await page.tap('.rf-unfold');
    assert.equal(await page.isVisible('#rf-from'), true, 'a tap opens the filters');
    assert.equal(await page.getAttribute('.rf-unfold', 'aria-expanded'), 'true');
    await page.tap('.rf-unfold'); // folded again, then f unfolds and goes to the filters
    await page.locator('.rf-item').first().focus();
    await page.keyboard.press('f');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'rf-from', 'f reaches the filters while folded');
    // Nothing matches: Bulk and Map stay in place, disabled (hidden only before a search).
    await page.fill('#rf-from', '2030-01-01'); await page.dispatchEvent('#rf-from', 'change');
    await waitStatus(page, /0 of 18/);
    assert.ok(await page.isVisible('.rf-map-btn') && await page.isDisabled('.rf-map-btn'), 'Map disabled, not hidden');
    // The Shortlist's tools fold too, behind one button; its search stays.
    await page.fill('#rf-from', ''); await page.dispatchEvent('#rf-from', 'change');
    for (const n of [1, 2]) await page.tap(`.rf-item:nth-child(${n}) [data-act=s]`);
    await page.tap('[data-view=shortlist]');
    assert.ok(await page.isVisible('.rf-sl-q') && !(await page.isVisible('.rf-sl-filter')), 'folded: search only');
    assert.match(await page.textContent('.rf-sl-unfold'), /^▸ Tools · Pack 0 of 5 ready$/);
    await page.tap('.rf-sl-unfold');
    assert.ok(await page.isVisible('.rf-sl-filter'));
    await page.selectOption('.rf-sl-filter', '-');
    await page.tap('.rf-sl-unfold');
    assert.match(await page.textContent('.rf-sl-unfold'), /· Not started/, 'what is set shows on the bar');
    console.log('phone controls fold: ok');
    await done(page); await ctx.close();
  });

  // 70. The Shortlist: approved first (What's next), and what changed since your last visit, with a
  // way to see just those.
  await block('70', async () => {
    const ctx = await browser.newContext();
    const t = FIXED.getTime(), D = 864e5;
    await ctx.addInitScript(([t, D]) => {
      if (localStorage.getItem('rea-avail-filter/marks/v1')) return;
      localStorage.setItem('rea-avail-filter/v1', JSON.stringify({ slSeenAt: String(t - 2 * D) }));
      localStorage.setItem('rea-avail-filter/marks/v1', JSON.stringify({ v: 1, m: {
        146500101: { f: t - 9 * D, l: t, s: 1, st: t - 5 * D, p: 650, pp: 700, pt: t - D, d: { u: 'https://www.realestate.com.au/property-unit-nsw-bondi-146500101', a: '1 Hall St, Bondi NSW 2026', p: '$650 per week', w: 'water' } },
        146500102: { f: t - 9 * D, l: t, s: 1, st: t - 6 * D, as: 'approved', ast: t - D, d: { u: 'https://www.realestate.com.au/property-unit-nsw-bondi-146500102', a: '2 Hall St, Bondi NSW 2026', p: '$700 per week' } },
      } }));
    }, [t, D]);
    const page = await open(ctx);
    await page.click('#rf-launch');
    await page.click('[data-view=shortlist]');
    assert.deepEqual(await page.$$eval('.rf-item', (e) => e.map((x) => x.dataset.id)), ['146500102', '146500101'], 'approved first');
    assert.ok(await page.$('.rf-item.rf-approved[data-id="146500102"]'));
    await waitStatus(page, /Since your last visit \(2d ago\): 1 cheaper\./);
    await page.click('.rf-status button:has-text("Show them")');
    assert.deepEqual(await page.$$eval('.rf-item', (e) => e.map((x) => x.dataset.id)), ['146500101']);
    assert.equal(await page.inputValue('.rf-sl-filter'), '~');
    // Its heads-up is a question to ask; tap once the agent answers.
    const q = '.rf-item[data-id="146500101"] [data-qa="w:water"]';
    await page.click('.rf-item[data-id="146500101"] .rf-ck-more summary');
    await page.click(q);
    assert.equal((await marks(page))['146500101'].qa['w:water'], 'y');
    assert.equal(await page.getAttribute(q, 'data-state'), 'yes');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.qa), 'w:water', 'focus kept');
    assert.match(await page.textContent('.rf-item[data-id="146500101"] .rf-watch .rf-ok'), /^✓ Water usage charged$/, 'the heads-up it answers is muted');
    assert.match(await page.textContent('.rf-item[data-id="146500101"] .rf-ck-more summary'), /Asked 1\/2/, "answered, counted like the checklist");
    await page.selectOption('.rf-sl-filter', '');
    await page.selectOption('.rf-item[data-id="146500101"] select[data-app]', 'declined');
    await page.click('.rf-item[data-id="146500101"] [data-act=dr][data-r="income"]');
    assert.equal((await marks(page))['146500101'].dr, 'income', 'why it was declined (optional)');
    assert.equal(await page.getAttribute('.rf-item[data-id="146500101"] [data-act=dr][data-r="income"]', 'aria-pressed'), 'true');
    await page.selectOption('.rf-item[data-id="146500101"] select[data-app]', '');
    await page.selectOption('#rf-slSort', 'added');
    assert.deepEqual(await page.$$eval('.rf-item', (e) => e.map((x) => x.dataset.id + ':' + x.querySelector('select[data-app]')?.value)), ['146500101:', '146500102:approved'], 'Date added: newest shortlisted first');
    assert.ok(+JSON.parse(await page.evaluate(() => localStorage.getItem('rea-avail-filter/v1'))).slSeenAt >= t, 'this visit stamped');
    console.log('shortlist order and since last visit: ok');
    await done(page); await ctx.close();
  });

  // 71. A search shows each page as it's read: the list grows, the status says "so far" (never
  // "listings match" until the last page is in) and the end keeps your scroll. A Refresh keeps the
  // full list until it's done.
  await block('71', async () => {
    const ctx = await browser.newContext();
    let release = () => {}, gate = Promise.resolve();
    const hold = () => { gate = new Promise((r) => { release = r; }); };
    const base = serve();
    hold();
    const page = await open(ctx, SEARCH, { route: async (r) => { if (/list-3\b/.test(r.request().url())) await gate; return base(r); } });
    await page.click('#rf-launch'); await page.click('#rf-run');
    await waitStatus(page, /^Reading page 3 of 3… \d+ of 12 so far match\.$/);
    assert.equal(await count(page), 12, 'pages 1 and 2 shown while page 3 is read');
    assert.equal(await page.getAttribute('#rf-run', 'aria-disabled'), 'true', 'still busy');
    const stay = await page.evaluate(() => { const p = document.querySelector('#rf-panel'); p.scrollTop = p.scrollHeight; return p.scrollTop; });
    assert.ok(stay > 0, 'the drawer scrolls');
    release();
    await waitStatus(page, /^18 of 18 listings match\./);
    assert.equal(await count(page), 18);
    const after = await page.evaluate(() => document.querySelector('#rf-panel').scrollTop);
    assert.ok(Math.abs(after - stay) < 60, `the last page went in where you were (${stay} -> ${after}), not back at the top`); // scroll anchoring may shift it by the status line
    hold();
    await page.click('#rf-refresh');
    await waitStatus(page, /^Reading page 3 of 3…$/);
    assert.equal(await count(page), 18, 'a Refresh keeps the whole list meanwhile');
    release();
    await waitStatus(page, /^18 of 18 listings match\./);
    console.log('pages shown as they are read: ok');
    await done(page); await ctx.close();
  });

  // 72. With the drawer closed, a star on REA's card updates the launcher, not the hidden list;
  // opening the drawer draws it.
  await block('72', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await run(page);
    await page.click('.rf-x');
    await page.evaluate(() => { for (const el of document.querySelectorAll('.rf-item')) el._old = 1; });
    const id = await page.$eval('article > .rf-badge [data-card-act=s]', (b) => b.dataset.id);
    await page.click(`article > .rf-badge [data-card-act=s][data-id="${id}"]`);
    await page.waitForFunction((i) => document.querySelector(`[data-card-act=s][data-id="${i}"]`)?.getAttribute('aria-pressed') === 'true', id);
    assert.match(await page.textContent('#rf-launch'), /★1/, 'the launcher counts it');
    assert.ok(await page.$$eval('.rf-item', (e) => e.every((x) => x._old)), 'the closed drawer was not redrawn');
    await page.click('#rf-launch');
    assert.ok(await page.$(`.rf-item.rf-starred[data-id="${id}"]`), 'drawn starred on opening');
    await waitStatus(page, /listings match/);
    console.log('closed drawer drawn on opening: ok');
    await done(page); await ctx.close();
  });

  // 73. Another tab writing only sightings (it read a page) doesn't redraw this one; a change of
  // yours there (a star) does.
  await block('73', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await run(page);
    const ids = await page.$$eval('.rf-item', (e) => e.slice(0, 2).map((x) => x.dataset.id));
    await page.hover(`.rf-item[data-id="${ids[0]}"]`); await page.click(`.rf-item[data-id="${ids[0]}"] >> [data-act=s]`);
    const other = await ctx.newPage();
    await other.route('**/*', serve()); await other.goto(SEARCH);
    const write = (choice) => other.evaluate(([c, i]) => {
      const k = 'rea-avail-filter/marks/v1', d = JSON.parse(localStorage.getItem(k));
      if (c) { d.m[i].s = 1; d.m[i].st = 1; d.w += 1; } else d.m[i].l += 1;
      localStorage.setItem(k, JSON.stringify({ w: d.w, ...d })); // as the script writes it: the stamp first
    }, [choice, ids[1]]);
    await page.evaluate(() => { document.querySelector('.rf-status').textContent = 'untouched'; }); // a redraw rewrites it
    await write(false);
    await page.waitForTimeout(300);
    assert.equal(await status(page), 'untouched', 'sightings only: no redraw');
    await write(true);
    await page.waitForSelector(`.rf-item.rf-starred[data-id="${ids[1]}"]`, { timeout: 3000 });
    console.log('other tab: sightings skipped, choices drawn: ok');
    await other.close(); await done(page); await ctx.close();
  });

  // 74. Back to the Results tab with the same filters: the listings' nodes come back as they were
  // (no re-parse), at the same place.
  await block('74', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await run(page);
    await page.evaluate(() => { for (const el of document.querySelectorAll('.rf-item')) el._old = 1; });
    await page.click('[data-view=shortlist]');
    await page.click('[data-view=results]');
    assert.equal(await count(page), 18);
    assert.ok(await page.$$eval('.rf-item', (e) => e.every((x) => x._old)), 'same nodes');
    console.log('tab switch keeps nodes: ok');
    await done(page); await ctx.close();
  });

  // 75. The header's light/dark button: the opposite of what's showing (the system's first), saved
  // as the Theme setting, and its label says what a click does.
  await block('75', async () => {
    const ctx = await browser.newContext({ colorScheme: 'dark' });
    const page = await open(ctx);
    await page.click('#rf-launch');
    assert.equal(await page.getAttribute('.rf-themebtn', 'aria-label'), 'Light mode', 'system dark: offers light');
    await page.click('.rf-themebtn');
    assert.equal(await page.getAttribute('html', 'data-rf-theme'), 'light');
    assert.equal(await page.inputValue('#rf-theme'), 'light', 'shown in Settings');
    assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('rea-avail-filter/v1'))).theme, 'light', 'saved');
    assert.equal(await page.getAttribute('.rf-themebtn', 'aria-label'), 'Dark mode');
    await page.click('.rf-themebtn');
    assert.equal(await page.getAttribute('html', 'data-rf-theme'), 'dark');
    assert.equal(await page.evaluate(() => document.activeElement.className), 'rf-themebtn', 'focus stays on it');
    console.log('light/dark button: ok');
    await done(page); await ctx.close();
  });

  // 76. Search again on the same REA search applies the filters to what's read, however long ago
  // (no page fetched); Refresh reads every page again.
  await block('76', async () => {
    const ctx = await browser.newContext();
    const hits = [];
    const page = await open(ctx, SEARCH, { route: serve(hits) });
    await run(page);
    await page.clock.runFor(11 * 60e3); // past the tab cache's 10 minutes
    const before = hits.length;
    await page.fill('#rf-from', '2026-10-10'); await page.dispatchEvent('#rf-from', 'change');
    await page.click('#rf-run');
    await waitStatus(page, /^\d+ of 18 listings match\..* Refresh fetches current listings\./);
    assert.equal(hits.length, before, 'no page fetched');
    await page.click('#rf-refresh');
    await waitStatus(page, /^\d+ of 18 listings match\./);
    assert.ok(hits.length > before, 'Refresh fetched');
    console.log('search again re-filters, Refresh fetches: ok');
    await done(page); await ctx.close();
  });

  // 77. REA's own filters in its search URL show as "On REA's search", marked where they leave
  // out listings your filters keep; "Use my filters on REA" opens REA's search with yours.
  await block('77', async () => {
    const ctx = await browser.newContext();
    const url = `${ORIGIN}/rent/property-unit+apartment-with-2-bedrooms-between-500-900-in-bondi,+nsw+2026/list-1?maxBeds=3&misc=pets-allowed&source=refinement`;
    const page = await open(ctx, url);
    await page.click('#rf-launch');
    assert.equal(await page.isVisible('.rf-rea'), true);
    assert.deepEqual(await page.$$eval('.rf-rea-chip', (e) => e.map((x) => x.textContent)), [
      'Apartment & Unit (leaves out listings your filters keep)', '$500–$900 (leaves out listings your filters keep)',
      '2–3 beds (leaves out listings your filters keep)', 'pets considered (leaves out listings your filters keep)']);
    await page.click('#rf-more summary'); await settle(page);
    await page.fill('#rf-priceMax', '1050'); await page.dispatchEvent('#rf-priceMax', 'change');
    await page.fill('#rf-bedsMin', '2'); await page.dispatchEvent('#rf-bedsMin', 'change');
    assert.equal(await page.isVisible('.rf-rea-apply'), true, 'yours differ from REA\'s: offered');
    await Promise.all([page.waitForURL(/with-2-bedrooms-between-any-1100-in-bondi/), page.click('.rf-rea-apply')]);
    const to = new URL(page.url());
    assert.equal(decodeURIComponent(to.pathname), '/rent/with-2-bedrooms-between-any-1100-in-bondi,+nsw+2026/list-1', 'rent widened to REA\'s steps, REA\'s type and max beds gone');
    assert.deepEqual(Object.fromEntries(to.searchParams), { misc: 'pets-allowed' }, 'REA\'s own amenity kept, tracking dropped');
    console.log('REA filters read and applied: ok');
    await page.close(); await ctx.close();
  });

  // 78. The same search with REA's tracking fields on (its Filters dialog adds them) is the same
  // search: what's read stays, and searching again fetches nothing.
  await block('78', async () => {
    const ctx = await browser.newContext();
    const hits = [];
    const page = await open(ctx, SEARCH, { route: serve(hits) });
    await run(page);
    const before = hits.length;
    await page.evaluate((u) => history.pushState({}, '', u), `${SEARCH}?source=refinement&sourcePage=rea%3Arent&sourceElement=search-box-search`);
    await settle(page); await settle(page);
    assert.doesNotMatch(await status(page), /Search changed/);
    await page.click('#rf-run');
    await waitStatus(page, /^18 of 18 listings match\..* Refresh fetches current listings\./);
    assert.equal(hits.length, before, 'nothing fetched');
    console.log('tracking fields ignored: ok');
    await done(page); await ctx.close();
  });

  // 79. Restore with "Replace what's here": back to exactly the backup (listings starred since
  // are unstarred), said first, and Undo puts it back.
  await block('79', async () => {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await run(page);
    const ids = await page.$$eval('.rf-item', (e) => e.slice(0, 2).map((x) => x.dataset.id));
    const star = async (id) => { await page.hover(`.rf-item[data-id="${id}"]`); await page.click(`.rf-item[data-id="${id}"] >> [data-act=s]`); await settle(page); };
    await star(ids[0]);
    await page.click('[data-view=shortlist]');
    const [bk] = await Promise.all([page.waitForEvent('download'), page.click('.rf-menu summary').then(() => page.click('[data-sl=backup]'))]);
    const file = fs.readFileSync(await bk.path());
    await page.click('[data-view=results]');
    await star(ids[1]);
    await page.click('[data-view=shortlist]');
    await page.setInputFiles('.rf-sl-bar input[type=file]', { name: 'b.json', mimeType: 'application/json', buffer: file });
    await page.waitForSelector('.rf-restore-in:not([hidden])');
    assert.match(await page.textContent('.rf-restore-msg'), /It merges with what's here/);
    await page.check('[data-restore-replace]');
    assert.match(await page.textContent('.rf-restore-msg'), /It replaces what's here: 1 listing marked here and not in the backup loses its marks, presets are the backup's/);
    await page.click('[data-restore=yes]');
    await waitStatus(page, /^Replaced what was here: restored 1 listing/);
    let m = await marks(page);
    assert.equal(m[ids[0]].s, 1);
    assert.ok(!m[ids[1]]?.s, 'starred since the backup: not any more');
    await page.click('.rf-undo-restore');
    m = await marks(page);
    assert.equal(m[ids[1]].s, 1, 'Undo puts it back');
    console.log('restore replacing what is here: ok');
    await done(page); await ctx.close();
  });

  await drain();
  console.log(`slowest blocks: ${times.sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, ms]) => `${id} ${(ms / 1000).toFixed(1)}s`).join(', ')}`);
  if (flaky.length) console.log(`flaky (failed, then passed on the retry): ${flaky.join(', ')}`);
  if (failed.length) throw new Error(`${failed.length} block(s) failed:\n  ${failed.join('\n  ')}`);
  assert.deepEqual(errors.filter((e) => !flaky.includes(e.id)).map((e) => e.msg), [], 'no page errors');
  if (only && !ran) throw new Error(`E2E_ONLY=${process.env.E2E_ONLY} matched no block`);
  if (!only) cov.report(SCRIPT); // a partial run would under-report coverage
  await browser.close();
  console.log('e2e edge: ok');
})().catch(harness.fail);

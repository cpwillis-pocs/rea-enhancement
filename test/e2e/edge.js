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
    await page.fill('.rf-sl-q', '');
    await page.waitForFunction(() => document.querySelectorAll('.rf-item').length === 2);
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
    // Badges are drawn asynchronously (debounced annotate): wait rather than check instantly.
    // On failure, dump what the cards and rows actually hold (CI failed here twice, not locally).
    await page.waitForSelector('article > .rf-badge .rf-b-pets', { timeout: 5000 }).catch(async (e) => {
      console.log('DIAG badges:', await page.$$eval('article', (a) => a.map((x) => `${x.dataset.rfId}:${x.querySelector('.rf-badge')?.textContent ?? '(none)'}`)));
      console.log('DIAG rows:', await page.evaluate(() => (window.reaFilter.rows() || []).slice(0, 6).map((r) => `${r.id} pets=${r.amen?.pets} text=${(r.text || '').slice(0, 60)}`)));
      throw e;
    });
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
    await page.fill('#rf-maxKm', ''); await page.dispatchEvent('#rf-maxKm', 'change');
    await page.fill('#rf-priceMax', '1500'); await page.dispatchEvent('#rf-priceMax', 'change');
    await page.selectOption('#rf-sort', 'match');
    // (with a budget + distance there are scores; the "needs two of" hint only shows without)
    const scores = await page.$$eval('.rf-score', (e) => e.map((x) => +x.textContent.replace(/\D/g, '')));
    assert.ok(scores.length > 3 && scores.every((v, i) => i === 0 || v <= scores[i - 1]), `best match sorted desc: ${scores.slice(0, 5)}`);
    assert.match(await page.getAttribute('.rf-score', 'title'), /rent vs budget \d+/);
    await done(page); await ctx.close();
  }

  // 15. Agency hide (with undo + unhide chip) and floorplan filter.
  {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await page.click('#rf-launch'); await page.click('#rf-run'); await waitStatus(page, /listings match/);
    const total = await page.$$eval('.rf-item', (e) => e.length);
    await page.click('.rf-item >> .rf-acts-more summary'); await page.click('.rf-item >> [data-act=ag]');
    assert.match(await status(page), /Hidden all listings from/);
    const after = await page.$$eval('.rf-item', (e) => e.length);
    assert.equal(after, total - 6, 'one of three agencies hidden');
    await page.click('.rf-status .rf-undo');
    assert.equal(await page.$$eval('.rf-item', (e) => e.length), total);
    await page.click('.rf-item >> .rf-acts-more summary'); await page.click('.rf-item >> [data-act=ag]');
    await page.click('#rf-more summary');
    assert.equal(await page.$eval('.rf-agencies', (b) => b.hidden), false);
    await page.click('[data-unhide-ag]');
    assert.equal(await page.$$eval('.rf-item', (e) => e.length), total);
    assert.equal(await page.$eval('.rf-agencies', (b) => b.hidden), true);
    // With "Show hidden" on, an agency-hidden row is dimmed and offers "Unhide agency".
    await page.click('.rf-item >> .rf-acts-more summary'); await page.click('.rf-item >> [data-act=ag]');
    await page.check('#rf-showHidden');
    const hid = await page.$('.rf-item.rf-hidden [data-act=ag]');
    assert.equal(await hid.textContent(), 'Unhide agency');
    await hid.evaluate((b) => b.click());
    assert.match(await status(page), /Showing .* again/);
    await page.uncheck('#rf-showHidden');
    assert.equal(await page.$$eval('.rf-item', (e) => e.length), total);
    await page.check('#rf-floorplanOnly');
    assert.equal(await page.$$eval('.rf-item', (e) => e.length), total / 2);
    assert.match(await page.textContent('.rf-item'), /photos · floorplan/);
    console.log('agency hide + floorplan: ok');
    await done(page); await ctx.close();
  }

  // 16. Compare table: shortlisted side by side, best values highlighted, toggles back.
  {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await page.click('#rf-launch'); await page.click('#rf-run'); await waitStatus(page, /listings match/);
    const ids = await page.$$eval('.rf-item', (e) => e.slice(0, 3).map((x) => x.dataset.id));
    for (const id of ids) { await page.hover(`.rf-item[data-id="${id}"]`); await page.click(`.rf-item[data-id="${id}"] >> [data-act=s]`); }
    await page.click('#rf-more summary');
    await page.fill('#rf-anchor', '-33.8915, 151.2767'); await page.dispatchEvent('#rf-anchor', 'change');
    await page.click('[data-view=shortlist]');
    await page.click('[data-sl=compare]');
    assert.equal(await page.getAttribute('[data-sl=compare]', 'aria-pressed'), 'true');
    assert.equal(await page.$$eval('.rf-compare thead th', (e) => e.length), 3);
    const rowsLabels = await page.$$eval('.rf-compare tbody th', (e) => e.map((x) => x.textContent));
    assert.ok(['Rent', 'Move-in', 'Distance', 'Amenities', 'Status'].every((l) => rowsLabels.includes(l)));
    assert.ok(await page.$$eval('.rf-compare .rf-best', (e) => e.length) >= 3, 'best values highlighted');
    await page.click('[data-sl=compare]');
    assert.equal(await page.$$eval('.rf-item', (e) => e.length), 3);
    console.log('compare table: ok');
    await done(page); await ctx.close();
  }

  // 17. Star / hide on REA's own cards: stored, reflected, card faded, REA's handlers not reached.
  {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await page.waitForSelector('article > .rf-badge [data-card-act=s]');
    await page.evaluate(() => { window.__reaClicks = 0; document.querySelector('article').addEventListener('click', () => window.__reaClicks++); });
    const id = await page.$eval('article > .rf-badge [data-card-act=s]', (b) => b.dataset.id);
    await page.click(`article > .rf-badge [data-card-act=s][data-id="${id}"]`);
    await page.waitForFunction((i) => document.querySelector(`[data-card-act=s][data-id="${i}"]`)?.getAttribute('aria-pressed') === 'true', id);
    assert.equal(await page.evaluate(() => window.__reaClicks), 0, 'click did not reach REA');
    assert.equal(await page.evaluate((i) => JSON.parse(localStorage.getItem('rea-avail-filter/marks/v1')).m[i].s, id), 1);
    await page.click(`article > .rf-badge [data-card-act=h][data-id="${id}"]`);
    await page.waitForFunction((i) => document.querySelector(`article[data-rf-id="${i}"]`)?.dataset.rfMatch === '0', id);
    await page.click('#rf-launch');
    assert.match(await page.textContent('.rf-count'), /\(1\)/);
    assert.match(await page.textContent('#rf-launch'), /★1/, 'launcher shows shortlist count');
    console.log('card quick actions: ok');
    await done(page); await ctx.close();
  }

  // 18. Active filter chips: counts, click to remove, summary count; Clear offers undo.
  {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await page.click('#rf-launch'); await page.click('#rf-run'); await waitStatus(page, /listings match/);
    await page.click('#rf-more summary');
    await page.fill('#rf-bedsMin', '3'); await page.dispatchEvent('#rf-bedsMin', 'change');
    await page.click('[data-amen=pets]');
    const chips = await page.$$eval('.rf-achip', (e) => e.map((x) => x.textContent.trim()));
    assert.equal(chips.length, 2);
    assert.match(chips[0], /3\+ bed −\d+ ×/);
    assert.match(await page.textContent('#rf-more summary'), /2 active/);
    const before = await page.$$eval('.rf-item', (e) => e.length);
    await page.click('.rf-achip >> nth=0');
    assert.equal(await page.inputValue('#rf-bedsMin'), '');
    assert.ok(await page.$$eval('.rf-item', (e) => e.length) > before, 'removing a chip widens results');
    await page.click('.rf-clear');
    assert.equal(await page.$eval('.rf-active', (b) => b.hidden), true);
    await page.click('.rf-status .rf-undo');
    assert.equal(await page.getAttribute('[data-amen=pets]', 'aria-label'), 'Pets: required', 'undo restores filters');
    console.log('active filter chips + clear undo: ok');
    await done(page); await ctx.close();
  }

  // 19. Keyboard: Alt+Shift+F toggles, j/k move, s shortlists, h hides, ? help, / keyword.
  {
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
    await page.focus('.rf-list'); await page.keyboard.press('j');
    const [pop] = await Promise.all([ctx.waitForEvent('page'), page.keyboard.press('o')]);
    await pop.close();
    await page.keyboard.press('?');
    assert.equal(await page.$eval('.rf-help', (h) => h.hidden), false);
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
  }

  // 20. Bulk: shortlist all shown / hide all shown with undo; shortlist bulk status + remove declined.
  {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await page.click('#rf-launch'); await page.click('#rf-run'); await waitStatus(page, /listings match/);
    await page.click('#rf-more summary');
    await page.fill('#rf-bedsMin', '3'); await page.dispatchEvent('#rf-bedsMin', 'change');
    const shown = await page.$$eval('.rf-item', (e) => e.length);
    await page.selectOption('.rf-bulk', 'star');
    assert.match(await status(page), new RegExp(`Shortlisted ${shown}`));
    await page.click('[data-view=shortlist]');
    assert.equal(await page.$$eval('.rf-item', (e) => e.length), shown);
    await page.selectOption('.rf-sl-bulk', 'status:declined');
    assert.match(await status(page), /Marked \d+ as declined/);
    await page.selectOption('.rf-sl-bulk', 'unstar-declined');
    assert.equal(await page.$$eval('.rf-item', (e) => e.length), 0);
    await page.click('.rf-status .rf-undo');
    assert.equal(await page.$$eval('.rf-item', (e) => e.length), shown, 'undo brings them back');
    await page.selectOption('.rf-sl-bulk', 'unstar');
    assert.equal(await page.$$eval('.rf-item', (e) => e.length), 0);
    await page.click('.rf-status .rf-undo');
    await page.click('[data-view=results]');
    await page.selectOption('.rf-bulk', 'hide');
    assert.equal(await page.$$eval('.rf-item', (e) => e.length), 0);
    await page.click('.rf-status .rf-undo');
    assert.equal(await page.$$eval('.rf-item', (e) => e.length), shown);
    console.log('bulk actions:', shown, 'rows, undo ok');
    await done(page); await ctx.close();
  }

  // 21. Presets: save, apply, bind to a search (auto-applies on SPA navigation back), delete.
  {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    page.on('dialog', (d) => d.accept(d.message().includes('this search') ? 'Bondi pets' : '3-bed'));
    await page.click('#rf-launch'); await page.click('#rf-run'); await waitStatus(page, /listings match/);
    await page.click('#rf-more summary');
    await page.fill('#rf-bedsMin', '3'); await page.dispatchEvent('#rf-bedsMin', 'change');
    await page.selectOption('.rf-preset', 'c:save');
    assert.match(await status(page), /Saved preset "3-bed"/);
    await page.click('.rf-clear');
    await page.selectOption('.rf-preset', 'a:3-bed');
    assert.equal(await page.inputValue('#rf-bedsMin'), '3', 'preset applied');
    await page.click('.rf-clear');
    await page.click('[data-amen=pets]');
    await page.selectOption('.rf-preset', 'c:bind');
    await page.click('.rf-clear');
    await page.evaluate(() => history.pushState({}, '', '/rent/in-manly,+nsw+2095/list-1'));
    await page.evaluate((u) => history.pushState({}, '', u), SEARCH);
    await page.waitForFunction(() => document.querySelector('[data-amen=pets]').getAttribute('aria-label') === 'Pets: required', null, { timeout: 3000 });
    assert.match(await page.textContent('.rf-preset option'), /Preset: Bondi pets/);
    await page.selectOption('.rf-preset', 'd:3-bed');
    assert.ok(!(await page.$$eval('.rf-preset option', (o) => o.map((x) => x.value))).includes('a:3-bed'));
    console.log('presets: ok');
    await done(page); await ctx.close();
  }

  // 21b. Preset names that look like menu commands, bound type across reload, once per visit.
  {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    page.on('dialog', (d) => d.accept(d.message().includes('this search') ? 'd:x' : '-3-bed'));
    await page.click('#rf-launch'); await page.click('#rf-run'); await waitStatus(page, /listings match/);
    await page.click('#rf-more summary');
    await page.selectOption('#rf-type', 'Townhouse');
    await page.selectOption('.rf-preset', 'c:save');
    assert.match(await status(page), /Saved preset "-3-bed"/);
    await page.selectOption('.rf-preset', 'c:bind');
    assert.match(await status(page), /d:x/);
    const vals = await page.$$eval('.rf-preset option', (o) => o.map((x) => x.value));
    assert.ok(vals.includes('a:-3-bed') && vals.includes('d:-3-bed'), 'command-like name kept as a preset');
    await page.selectOption('#rf-type', '');
    await page.selectOption('.rf-preset', 'a:-3-bed');
    assert.equal(await page.inputValue('#rf-type'), 'Townhouse', 'applying a "-" name applies, not deletes');
    await page.evaluate(() => sessionStorage.removeItem('rea-avail-filter/preset-visit'));
    await page.reload(); await page.addScriptTag({ content: SCRIPT }); await page.waitForSelector('#rf-launch');
    assert.equal(await page.inputValue('#rf-type'), 'Townhouse', 'bound type survives page load');
    await page.evaluate(() => { const el = document.querySelector('#rf-type'); el.value = ''; el.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.reload(); await page.addScriptTag({ content: SCRIPT }); await page.waitForSelector('#rf-launch');
    assert.equal(await page.inputValue('#rf-type'), '', 'bound preset applies once per visit, not over edits');
    console.log('presets names/type: ok');
    await done(page); await ctx.close();
  }

  // 21c. A bound preset's "previous filters" survive a reload, so they don't leak to other searches.
  {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    page.on('dialog', (d) => d.accept('Bondi pets'));
    const pets = () => page.getAttribute('[data-amen=pets]', 'aria-label');
    await page.click('#rf-launch'); await page.click('#rf-run'); await waitStatus(page, /listings match/);
    await page.click('#rf-more summary');
    await page.click('[data-amen=pets]');
    await page.selectOption('.rf-preset', 'c:bind');
    await page.click('.rf-clear');
    await page.evaluate(() => history.pushState({}, '', '/rent/in-manly,+nsw+2095/list-1'));
    await page.evaluate((u) => history.pushState({}, '', u), SEARCH);
    await page.waitForFunction(() => document.querySelector('[data-amen=pets]').getAttribute('aria-label') === 'Pets: required', null, { timeout: 3000 });
    await page.reload(); await page.addScriptTag({ content: SCRIPT }); await page.waitForSelector('#rf-launch');
    await page.evaluate(() => history.pushState({}, '', '/rent/in-manly,+nsw+2095/list-1'));
    await page.waitForFunction(() => !/required/.test(document.querySelector('[data-amen=pets]').getAttribute('aria-label')), null, { timeout: 3000 });
    assert.doesNotMatch(await pets(), /required/, 'previous filters restored after reload');
    console.log('preset restore after reload: ok');
    await done(page); await ctx.close();
  }

  // 22. Print: opens a document with one block per shortlisted listing.
  {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await page.click('#rf-launch'); await page.click('#rf-run'); await waitStatus(page, /listings match/);
    for (const n of [1, 2]) { await page.hover(`.rf-item:nth-child(${n})`); await page.click(`.rf-item:nth-child(${n}) >> [data-act=s]`); }
    await page.click('[data-view=shortlist]');
    const [pop] = await Promise.all([ctx.waitForEvent('page'), page.click('[data-sl=print]')]);
    await pop.waitForLoadState();
    assert.equal(await pop.$$eval('.l', (e) => e.length), 2);
    assert.match(await pop.title(), /Rental shortlist/);
    console.log('print shortlist: ok');
    await pop.close();
    await done(page); await ctx.close();
  }

  // 23. Share: copy link from one browser profile, open it in another, import.
  {
    const ctxA = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const a = await open(ctxA);
    a.on('dialog', (d) => d.accept());
    await a.click('#rf-launch'); await a.click('#rf-run'); await waitStatus(a, /listings match/);
    for (const n of [1, 2]) { await a.hover(`.rf-item:nth-child(${n})`); await a.click(`.rf-item:nth-child(${n}) >> [data-act=s]`); }
    await a.hover('.rf-item:nth-child(1)'); await a.click('.rf-item:nth-child(1) >> [data-act=n]');
    await a.fill('.rf-note-edit', 'great light'); await a.keyboard.press('Enter');
    await a.click('[data-view=shortlist]');
    await a.click('[data-sl=share]');
    await waitStatus(a, /Share link copied \(2 listings, with notes\)/);
    const link = await a.evaluate(() => navigator.clipboard.readText());
    await done(a); await ctxA.close();

    const ctxB = await browser.newContext();
    const b = await ctxB.newPage();
    await cov.track(b);
    await b.route('**/*', serve());
    await b.goto(link);
    await b.addScriptTag({ content: SCRIPT });
    await b.waitForSelector('.rf-share-in:not([hidden])');
    assert.match(await b.textContent('.rf-share-msg'), /2 shared listings/);
    await b.evaluate(() => history.pushState({}, '', '/buy/in-bondi/list-1'));
    assert.ok(await b.isVisible('.rf-share-in'), 'pending share offer survives leaving /rent/');
    assert.equal(await b.evaluate(() => location.hash), '', 'fragment stripped');
    await b.click('[data-share=add]');
    assert.equal(await b.$$eval('.rf-item', (e) => e.length), 2);
    assert.match(await b.textContent('.rf-note'), /Shared: great light/);
    const c = await open(ctxB, SEARCH + '#rf-share=eyJhIjoicmVh');
    await waitStatus(c, /incomplete or damaged/, 5000);
    assert.ok(!(await c.evaluate(() => location.hash)), 'broken share stripped from URL');
    await done(c);
    console.log('share link across profiles: ok');
    await done(b); await ctxB.close();
  }

  // 24. Planner: choose a day, see ordered inspections with clashes flagged; day calendar export.
  {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await page.click('#rf-launch'); await page.click('#rf-run'); await waitStatus(page, /listings match/);
    await page.click('#rf-more summary');
    await page.selectOption('#rf-sort', 'inspect');
    for (const n of [1, 2, 3, 4]) { await page.hover(`.rf-item:nth-child(${n})`); await page.click(`.rf-item:nth-child(${n}) >> [data-act=s]`); }
    await page.click('[data-view=shortlist]');
    const days = await page.$$eval('.rf-plan option', (o) => o.map((x) => x.value).filter(Boolean));
    assert.ok(days.length >= 1, 'days offered');
    await page.selectOption('.rf-plan', days[0]);
    const n = await page.$$eval('.rf-planner li', (e) => e.length);
    assert.ok(n >= 1);
    if (n > 1) assert.ok(await page.$('.rf-planner li.rf-clash'), 'same-time fixtures clash');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-plan-ics]')]);
    assert.equal((fs.readFileSync(await dl.path(), 'utf8').match(/BEGIN:VEVENT/g) || []).length, n);
    const planned = await page.$$eval('.rf-planner li a', (a) => new Set(a.map((x) => x.href)).size);
    await page.selectOption('.rf-sl-bulk', 'status:applied');
    assert.match(await status(page), new RegExp(`Marked ${planned} as applied`), 'bulk acts on the planned day only');
    await page.selectOption('.rf-plan', '');
    assert.ok(await page.$$eval('.rf-item', (e) => e.length) === 4);
    console.log('planner:', days.length, 'days;', n, 'on', days[0]);
    await done(page); await ctx.close();
  }

  // 24b. Market view: rent per bed count and availability by week; clicking a week filters to it.
  {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await page.click('#rf-launch'); await page.click('#rf-run'); await waitStatus(page, /listings match/);
    await page.click('.rf-market-btn');
    await page.waitForSelector('.rf-market table');
    assert.equal(await page.getAttribute('.rf-market-btn', 'aria-pressed'), 'true');
    assert.ok((await page.$$('.rf-market tbody tr')).length >= 2, 'bed groups');
    await page.focus('.rf-market-btn'); await page.keyboard.press('m');
    assert.ok(await page.$('.rf-item'), 'm toggles back to the list');
    await page.keyboard.press('m'); await page.waitForSelector('.rf-market table');
    const bars = await page.$$eval('.rf-bars button[data-week]', (b) => b.map((x) => [x.dataset.week, +x.querySelector('.rf-bar-n').textContent]));
    assert.ok(bars.length >= 1, 'clickable weeks');
    const [wk, n] = bars.find(([w]) => w !== '0') || bars[0];
    await page.click(`.rf-bars button[data-week="${wk}"]`);
    await page.waitForSelector('.rf-item');
    assert.equal(await page.getAttribute('.rf-market-btn', 'aria-pressed'), 'false');
    const shown = await page.$$eval('.rf-item', (e) => e.length);
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
    const inWindow = await page.$$eval('.rf-item', (e) => e.length);
    await page.click('.rf-market-btn');
    const laterBtn = await page.$('.rf-bars button[data-week="9"]');
    if (laterBtn) { await laterBtn.click(); assert.ok((await page.$$eval('.rf-item', (e) => e.length)) <= inWindow); }
    console.log('market view: ok,', bars.length, 'weeks;', n, 'in week', wk);
    await done(page); await ctx.close();
  }

  // 24c. Saved searches: remembered searches listed; Check all fetches each and counts new.
  {
    const ctx = await browser.newContext();
    const other = 'https://www.realestate.com.au/rent/in-manly,+nsw+2095/list-1';
    await ctx.addInitScript((k) => {
      if (!localStorage.getItem('rea-avail-filter/snapshots/v1')) localStorage.setItem('rea-avail-filter/snapshots/v1', JSON.stringify({ v: 1, s: { [k]: { at: Date.now() - 864e5 * 2, ids: [], rows: [], gone: [] } } }));
    }, other);
    const page = await open(ctx);
    await page.click('#rf-launch');
    assert.ok(await page.isVisible('.rf-saved'), 'saved searches shown');
    assert.match(await page.textContent('.rf-saved-list'), /Manly NSW 2095/);
    await page.click('#rf-run'); await waitStatus(page, /listings match/);
    await page.waitForFunction(() => document.querySelectorAll('.rf-saved-list li').length === 2);
    assert.match(await page.textContent('.rf-saved-list'), /this search/);
    await page.click('.rf-saved summary');
    await page.click('[data-saved-check]');
    await waitStatus(page, /Checked 2 saved searches/, 30000);
    const st = await status(page);
    assert.match(st, /Manly NSW 2095: [1-9]\d* new/, 'all listings new for the empty snapshot');
    assert.match(st, /Bondi[^:]*: 0 new/, 'current search unchanged');
    assert.match(await page.textContent('.rf-saved-list'), /\d+ new/);
    // Opting out mid-check stores nothing more.
    await page.click('[data-saved-check]');
    await page.click('.rf-settings summary'); await page.uncheck('#rf-remember');
    await page.waitForFunction(() => !document.querySelector('[data-saved-check]').hasAttribute('aria-disabled'), null, { timeout: 30000 });
    assert.equal(await page.evaluate(() => localStorage.getItem('rea-avail-filter/snapshots/v1')), null, 'nothing re-saved after opting out');
    console.log('saved searches: ok,', st.slice(0, 90));
    await done(page); await ctx.close();
  }

  // 24d. Availability date change: a stored earlier date shows "was <date>" in the drawer and on the card.
  {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await page.click('#rf-launch'); await page.click('#rf-run'); await waitStatus(page, /listings match/);
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
    await page.click('#rf-more summary'); await page.check('#rf-changedOnly');
    assert.deepEqual(await page.$$eval('.rf-item', (e) => e.map((x) => x.dataset.id)), [id], 'changed-only filter');
    await page.waitForFunction(() => [...document.querySelectorAll('.rf-badge span')].some((b) => /^Avail was /.test(b.textContent)), null, { timeout: 5000 });
    console.log('availability change: ok,', await page.textContent(`.rf-item[data-id="${id}"] .rf-avail`));
    await done(page); await ctx.close();
  }

  // 24e. Listing page bar: shortlist, status, note and hide from the property page itself.
  {
    const ctx = await browser.newContext();
    const url = `${ORIGIN}/property-unit-nsw-bondi-146500101`;
    const page = await open(ctx, url);
    page.on('dialog', (d) => d.accept('ask about parking'));
    await page.waitForSelector('#rf-lbar');
    assert.ok(await page.isHidden('#rf-launch'), 'drawer launcher stays off listing pages');
    await page.click('#rf-lbar [data-l=s]');
    assert.match(await page.textContent('#rf-lbar [data-l=s]'), /Shortlisted/);
    await page.selectOption('#rf-lbar [data-l=as]', 'applied');
    await page.click('#rf-lbar [data-l=n]');
    assert.match(await page.textContent('#rf-lbar .rf-lbar-note'), /ask about parking/);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('rea-avail-filter/marks/v1')).m['146500101']);
    assert.equal(stored.s, 1); assert.equal(stored.as, 'applied'); assert.equal(stored.n, 'ask about parking');
    assert.match(stored.d.p, /\$999/, 'summary taken from the listing page');
    // Shows up on the Shortlist tab of a search.
    await page.goto(SEARCH); await page.addScriptTag({ content: SCRIPT });
    assert.equal(await page.$('#rf-lbar'), null, 'bar only on listing pages');
    await page.click('#rf-launch'); await page.click('[data-view=shortlist]');
    assert.match(await page.textContent('.rf-list'), /ask about parking/);
    console.log('listing page bar: ok');
    await done(page); await ctx.close();
  }

  // 24f. Storage line and "Delete all my data" (tool keys only).
  {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    page.on('dialog', (d) => d.accept());
    await page.evaluate(() => localStorage.setItem('reaOwnKey', 'keep me'));
    await page.click('#rf-launch'); await page.click('#rf-run'); await waitStatus(page, /listings match/);
    await page.hover('.rf-item:nth-child(1)'); await page.click('.rf-item:nth-child(1) >> [data-act=s]');
    await page.click('.rf-settings summary');
    await page.waitForFunction(() => document.querySelector('.rf-storage-n').textContent);
    assert.match(await page.textContent('.rf-storage-n'), /Stored in this browser only: \d+ KB \(1 shortlisted, 0 hidden, 1 remembered search\)/);
    await Promise.all([page.waitForEvent('load'), page.click('[data-forget]')]);
    const keys = await page.evaluate(() => Object.keys(localStorage).concat(Object.keys(sessionStorage)));
    assert.deepEqual(keys.filter((k) => k.startsWith('rea-avail-filter/')), [], 'tool data gone');
    assert.ok(keys.includes('reaOwnKey'), "REA's own data kept");
    console.log('delete all data: ok');
    await done(page); await ctx.close();
  }

  // 25. Drift canary + selfcheck: prime the usual rates, then serve pages without inspections.
  {
    const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    await ctx.addInitScript(() => localStorage.setItem('rea-avail-filter/health/v1', JSON.stringify({ n: 5, ema: { inspections: 0.5, availability: 1, price: 0.9 } })));
    const page = await open(ctx, SEARCH, { route: serve([], { pages: 4, perPage: 6, noInspections: true }) });
    await page.click('#rf-launch'); await page.click('#rf-run');
    await waitStatus(page, /REA may have changed its data: inspections on 0%/);
    const report = await page.evaluate(() => window.reaFilter.selfcheck());
    assert.match(report, /inspections 0%\/\d+%/);
    assert.match(report, /page: \/rent\//);
    console.log('drift canary + selfcheck: ok');
    await done(page); await ctx.close();
  }

  // 26. Re-check: listing pages update price / mark 404s as no longer listed.
  {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await page.click('#rf-launch'); await page.click('#rf-run'); await waitStatus(page, /listings match/);
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
  }

  // 27. Copy summary (button + 'c'), hide suburb with undo, compare only ticked listings.
  {
    const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await open(ctx);
    await page.click('#rf-launch'); await page.click('#rf-run'); await waitStatus(page, /listings match/);
    await page.hover('.rf-item'); await page.click('.rf-item >> [data-act=copy]');
    await waitStatus(page, /summary copied/);
    assert.match(await page.evaluate(() => navigator.clipboard.readText()), /per week - .*\nAvailable|https:\/\/www\.realestate/);
    const total = await page.$$eval('.rf-item', (e) => e.length);
    await page.click('.rf-item >> .rf-acts-more summary'); await page.click('.rf-item >> [data-act=sb]');
    assert.equal(await page.$$eval('.rf-item', (e) => e.length), 0, 'every fixture is in Bondi');
    await page.click('.rf-status .rf-undo');
    assert.equal(await page.$$eval('.rf-item', (e) => e.length), total);
    const ids = await page.$$eval('.rf-item', (e) => e.slice(0, 3).map((x) => x.dataset.id));
    for (const id of ids) { await page.hover(`.rf-item[data-id="${id}"]`); await page.click(`.rf-item[data-id="${id}"] >> [data-act=s]`); }
    await page.click('[data-view=shortlist]');
    await page.hover(`.rf-item[data-id="${ids[2]}"]`); await page.check(`input[data-cmp="${ids[2]}"]`);
    await page.hover(`.rf-item[data-id="${ids[0]}"]`); await page.check(`input[data-cmp="${ids[0]}"]`);
    await page.click('[data-sl=compare]');
    assert.equal(await page.$$eval('.rf-compare thead th', (e) => e.length), 2, 'only ticked listings compared');
    console.log('copy / hide suburb / compare selection: ok');
    await done(page); await ctx.close();
  }

  // 28. Enter on a focused button presses it (no listing tab); Esc outside the drawer isn't ours.
  { const ctx = await browser.newContext(); const page = await open(ctx);
    await page.click('#rf-launch'); await page.click('#rf-run'); await waitStatus(page, /listings match/);
    const id = await page.$eval('.rf-item', (e) => e.dataset.id);
    let popups = 0; ctx.on('page', () => popups++);
    await page.focus(`.rf-item[data-id="${id}"] [data-act=s]`);
    await page.keyboard.press('Enter');
    await page.waitForFunction((i) => document.querySelector(`.rf-item[data-id="${i}"] [data-act=s]`)?.getAttribute('aria-pressed') === 'true', id, { timeout: 2000 });
    assert.equal(popups, 0, 'no listing tab opened');
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press('Escape');
    assert.equal(await page.$eval('#rf-panel', (p) => p.hidden), false, "Esc outside the drawer is REA's");
    console.log('enter on buttons + esc scope: ok'); await done(page); await ctx.close(); }

  assert.deepEqual(errors, [], 'no page errors');
  cov.report(SCRIPT);
  await browser.close();
  console.log('e2e edge: ok');
})().catch((e) => { console.error(e); process.exit(1); });

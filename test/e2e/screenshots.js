'use strict';
// Renders README screenshots into docs/screenshots from fixture pages (no network).
// Run: node test/e2e/screenshots.js
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const harness = require('./harness');
let pw;
try { pw = require('playwright'); } catch { pw = require(path.join(execSync('npm root -g').toString().trim(), 'playwright')); }
const { ORIGIN, serve } = require('./fixtures');

const SCRIPT = fs.readFileSync(path.join(__dirname, '../../rea-availability-filter.user.js'), 'utf8');
const OUT = path.join(__dirname, '../../docs/screenshots');
const SEARCH = `${ORIGIN}/rent/in-bondi,+nsw+2026/list-1`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = harness.watch(await pw.chromium.launch());
  const shot = async (name, { dark = false, width = 1280, height = 860, act, seed, url = SEARCH, ready = 'article > .rf-badge', keepFocus = false }) => {
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme: dark ? 'dark' : 'light', timezoneId: 'Australia/Sydney', locale: 'en-AU' });
    const page = await ctx.newPage();
    await page.clock.install({ time: new Date('2026-09-23T10:00:00+10:00') }); // fixture dates stay meaningful
    await page.route('**/*', serve());
    if (seed) await page.addInitScript((v) => localStorage.setItem('rea-avail-filter/marks/v1', v), JSON.stringify(seed()));
    await page.addInitScript(() => localStorage.setItem('rea-avail-filter/seen-version', '99.0.0')); // no welcome or what's-new note in the pictures
    await page.goto(url);
    await page.addScriptTag({ content: SCRIPT });
    await page.waitForSelector(ready);
    await act(page);
    if (!keepFocus) await page.evaluate(() => document.activeElement?.blur()); // no caret or selected text in the picture
    await page.waitForTimeout(300);
    const png = await page.screenshot({ type: 'png' });
    await ctx.close();
    await frame(name, png, { width, height, dark, url });
    console.log('wrote', name);
  };
  // Each shot in a browser window (a phone for narrow ones) on a soft background, for the README.
  const frame = async (name, png, { width, height, dark, url }) => {
    const phone = width < 500, img = `data:image/png;base64,${png.toString('base64')}`;
    const where = decodeURIComponent(new URL(url).host + new URL(url).pathname).replace(/^www\./, '');
    const bg = dark ? 'linear-gradient(135deg,#1d2a2b,#232537)' : 'linear-gradient(135deg,#e6f4ec,#e9eefb)';
    const dot = (c) => `<i style="width:12px;height:12px;border-radius:50%;background:${c};display:inline-block"></i>`;
    const win = phone
      ? `<div style="padding:14px;border-radius:52px;background:#16171a;box-shadow:0 30px 70px -18px rgba(10,20,40,.45)"><div style="border-radius:40px;overflow:hidden;position:relative;background:${dark ? '#1c1c20' : '#fff'}">
          <div style="height:50px;display:flex;align-items:center;justify-content:space-between;padding:0 30px;font:600 15px system-ui,sans-serif;color:${dark ? '#eee' : '#111'}"><span>9:41</span><span style="letter-spacing:2px">▮▮▮</span></div>
          <img src="${img}" style="display:block;width:${width}px;height:${height - 50}px;object-fit:cover;object-position:top"><div style="position:absolute;top:10px;left:50%;width:110px;height:30px;margin-left:-55px;border-radius:16px;background:#16171a"></div></div></div>`
      : `<div style="border-radius:14px;overflow:hidden;background:${dark ? '#1c1c20' : '#fff'};box-shadow:0 30px 70px -22px rgba(10,30,50,.4),0 0 0 1px rgba(0,0,0,${dark ? '.5' : '.07'})">
          <div style="height:42px;display:flex;align-items:center;gap:8px;padding:0 16px;background:${dark ? '#2a2b30' : '#f1f3f5'};border-bottom:1px solid ${dark ? '#3a3b41' : '#e2e5e9'}">
            ${dot('#ff5f57')}${dot('#febc2e')}${dot('#28c840')}
            <div style="margin-left:16px;flex:0 1 560px;height:26px;border-radius:13px;background:${dark ? '#1c1c20' : '#fff'};display:flex;align-items:center;padding:0 14px;font:13px system-ui,sans-serif;color:${dark ? '#b8b8c0' : '#5b5f66'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;line-height:26px">${where}</div>
          </div><img src="${img}" style="display:block;width:${width}px;height:${height}px"></div>`;
    const ctx = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: width + 200, height: height + 300 } });
    const page = await ctx.newPage();
    await page.setContent(`<!doctype html><body style="margin:0;display:inline-block;padding:${phone ? 56 : 60}px;background:${bg}">${win}</body>`);
    await page.locator('body').screenshot({ path: path.join(OUT, `${name}.jpg`), type: 'jpeg', quality: 86 });
    await ctx.close();
  };
  const search = async (page) => {
    await page.click('#rf-launch');
    await page.click('#rf-run');
    await page.waitForFunction(() => /listings match/.test(document.querySelector('.rf-status').textContent), null, { timeout: 20000 });
  };
  const setFrom = async (page, v) => { await page.fill('#rf-from', v); await page.dispatchEvent('#rf-from', 'change'); };

  // Marks as they'd look after a week of use: one shortlisted, one price drop, two new.
  const history = () => {
    const now = new Date('2026-09-23T10:00:00+10:00').getTime(), day = 864e5, m = {};
    for (let k = 0; k < 18; k++) m[146500000 + k] = { f: now - 6 * day, l: now };
    Object.assign(m[146500001], { s: 1 });
    Object.assign(m[146500002], { p: 895, ps: '$895 per week' }); // now $824: a drop
    m[146500004].h = 1;
    m[146500005].f = now - 3600e3; // new today
    return { c: now - 7 * day, m };
  };
  await shot('shortlist', { seed: history, act: async (page) => { await search(page); await page.hover('.rf-item:nth-child(2)'); } });
  await shot('shortlist-tab', { seed: () => {
    const h = history();
    Object.assign(h.m[146500001], { st: new Date('2026-09-23T10:00:00+10:00').getTime(), n: 'Ask agent about pets and the second car space.', d: { u: `${ORIGIN}/property-apartment-nsw-bondi-146500001`, a: '13/3 Hall St, Bondi, NSW 2026', p: '$687 per week', v: '12 Oct 2026', i: 'https://i2.au.reastatic.net/{size}/fixture/1.svg'.replace('{size}', '345x260'), t: 'Apartment', b: 2, ba: 1, c: 1 } });
    Object.assign(h.m[146500009], { s: 1, st: new Date('2026-09-23T10:00:00+10:00').getTime() - 864e5, d: { u: `${ORIGIN}/property-apartment-nsw-manly-146500009`, a: '4/21 The Corso, Manly, NSW 2095', p: '$940 per week', v: 'Sat 7th Nov', i: 'https://i2.au.reastatic.net/345x260/fixture/9.svg', t: 'Apartment', b: 2, ba: 2, c: 1 } });
    return h;
  }, act: async (page) => { await page.click('#rf-launch'); await page.click('[data-view=shortlist]'); } });
  await shot('compare', { act: async (page) => {
    await search(page);
    for (const n of [1, 2, 3]) { await page.hover(`.rf-item:nth-child(${n})`); await page.click(`.rf-item:nth-child(${n}) >> [data-act=s]`); }
    await page.click('#rf-more summary');
    await page.fill('#rf-anchor', '-33.8915, 151.2767'); await page.dispatchEvent('#rf-anchor', 'change');
    await page.click('[data-view=shortlist]');
    await page.selectOption('.rf-item:nth-child(1) select[data-app]', 'applied');
    await page.click('[data-sl=compare]');
  } });
  await shot('badges', { seed: history, act: async (page) => { await page.evaluate(() => window.scrollTo(0, 690)); } });
  await shot('drawer', { act: async (page) => { await search(page); await setFrom(page, '2026-10-10'); } });
  await shot('listing-bar', { url: SEARCH.replace(/\/rent\/.*/, '/property-unit-nsw-bondi-146500101'), ready: '#rf-lbar', width: 900, height: 500,
    seed: () => ({ c: Date.now(), m: { 146500101: { f: Date.now() - 6 * 864e5, l: Date.now(), s: 1, as: 'inspected', n: 'Great light, ask about parking', pp: 1050, pps: '$1,050 per week', p: 999, pt: Date.now() - 864e5 } } }),
    act: async () => {} });
  await shot('market', { act: async (page) => { await search(page); await page.click('.rf-market-btn'); await page.waitForSelector('.rf-market table'); } });
  await shot('map', { act: async (page) => { await search(page); await page.click('.rf-map-btn'); await page.waitForSelector('.rf-map svg'); await page.$eval('.rf-map', (el) => el.scrollIntoView({ block: 'start' })); } });
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
})().catch(harness.fail);

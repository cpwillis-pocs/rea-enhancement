'use strict';
// Accessibility check: axe-core over the drawer in each of its views, in light and dark, plus the
// listing-page bar, then forced colours, reduced motion and small windows. Fails on serious or critical findings in the script's own UI (REA's page
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
  const res = await page.evaluate(async (sel) => window.axe.run({ include: [sel] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } }), include);
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
  // A phone at an inspection: touch, 390px wide; target size counts here.
  for (const [name, url, sel, go] of [
    ['phone drawer', SEARCH, '#rf-panel', async (p) => { await p.click('#rf-launch'); await p.click('#rf-run'); await p.waitForFunction(() => /listings match/.test(document.querySelector('.rf-status').textContent)); }],
    ['phone listing bar', `${ORIGIN}/property-unit-nsw-bondi-146500101`, '#rf-lbar', async (p) => { await p.waitForSelector('#rf-lbar'); await p.tap('#rf-lbar [data-l=s]'); await p.tap('#rf-lbar .rf-lbar-more summary'); }],
  ]) {
    harness.section(name);
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    await page.clock.install({ time: FIXED });
    await page.route('**/*', serve());
    await page.goto(url);
    await page.addScriptTag({ content: SCRIPT });
    await page.waitForSelector('#rf-panel[data-rf-ready]', { state: 'attached' });
    await go(page);
    await check(page, sel, name, found);
    const small = await page.$$eval(`${sel} button, ${sel} select, ${sel} summary`, (els) => els.filter((e) => e.offsetParent && (e.getBoundingClientRect().height < 44 || e.getBoundingClientRect().width < 24))
      .map((e) => `${e.className || e.tagName} "${(e.textContent || '').trim().slice(0, 20)}" ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`));
    if (name === 'phone listing bar' && small.length) found.push(`${name}: touch targets under 44px: ${small.slice(0, 5).join('; ')}`);
    await ctx.close();
  }
  // Other ways people browse: Windows high contrast, reduced motion, a short landscape window and
  // a 320px phone (WCAG 1.4.10 reflow: no sideways scrolling in the drawer).
  const EXTRA = [
    ['forced colours', { forcedColors: 'active' }, true],
    ['reduced motion', { reducedMotion: 'reduce' }, false],
    ['640x450', { viewport: { width: 640, height: 450 } }, false],
    ['320 wide', { viewport: { width: 320, height: 640 }, hasTouch: true }, false],
  ];
  for (const [name, opts, axe] of EXTRA) {
    harness.section(name);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...opts });
    const page = await ctx.newPage();
    await page.clock.install({ time: FIXED });
    await page.route('**/*', serve([], { extras: true }));
    await page.goto(SEARCH);
    await page.addScriptTag({ content: SCRIPT });
    await page.waitForSelector('#rf-panel[data-rf-ready]', { state: 'attached' });
    await page.click('#rf-launch'); await page.click('#rf-run');
    await page.waitForFunction(() => /listings match/.test(document.querySelector('.rf-status').textContent));
    for (const [view, go] of [['results', async () => {}], ['filters open', async (p) => { if (await p.isVisible('.rf-unfold')) await p.click('.rf-unfold'); await p.click('#rf-more summary'); }]]) {
      await go(page);
      if (axe) await check(page, '#rf-panel', `${name} ${view}`, found);
      const wide = await page.evaluate(() => {
        const panel = document.querySelector('#rf-panel'), over = [];
        const edge = panel.getBoundingClientRect().right + 1;
        if (panel.scrollWidth > panel.clientWidth + 1) over.push(`drawer scrolls sideways (${panel.scrollWidth} > ${panel.clientWidth})`);
        for (const el of panel.querySelectorAll('*')) {
          const r = el.getBoundingClientRect();
          if (el.offsetParent && r.width && r.right > edge && !el.closest('.rf-compare, .rf-market, .rf-map')) over.push(`${el.className || el.tagName} ends at ${Math.round(r.right)} > ${Math.round(edge)}`);
        }
        return over.slice(0, 3);
      });
      for (const w of wide) found.push(`${name} ${view}: ${w}`);
      if (opts.reducedMotion) {
        const moving = await page.evaluate(() => [...document.querySelectorAll('#rf-panel, #rf-panel *, #rf-launch, [data-rf-id]')]
          .filter((el) => { const cs = getComputedStyle(el); return parseFloat(cs.transitionDuration) > 0 || (cs.animationName !== 'none' && parseFloat(cs.animationDuration) > 0); })
          .slice(0, 3).map((el) => el.className || el.tagName));
        for (const m of moving) found.push(`${name} ${view}: still animates: ${m}`);
      }
    }
    await ctx.close();
  }
  await browser.close();
  if (found.length) { console.error(`a11y: ${found.length} serious/critical finding(s):\n  ${found.join('\n  ')}`); process.exit(1); }
  console.log(`a11y: ok (${VIEWS.length + 1} views, light and dark, plus phone, forced colours, reduced motion, short and 320px windows)`);
})().catch((e) => { console.error(e); process.exit(1); });

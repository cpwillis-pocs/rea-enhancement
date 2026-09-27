'use strict';
// Live check against the real realestate.com.au: local only, never in CI (it would hit REA from
// shared runners and trip its bot checks). Loads one search, injects the working copy, runs a
// full search, and checks the core paths still read: results found, prices and dates filled,
// REA's cards recognised. Saves the first listing's reaFilter.shape() to test/shapes/ so a
// format change becomes a regression test (see CONTRIBUTING.md).
//
//   LIVE_URL=https://www.realestate.com.au/rent/in-bondi,+nsw+2026/list-1 npm run live
//   LIVE_HEADFUL=1 shows the browser (REA is more likely to serve a headful one); LIVE_SAVE=0 skips the shape.
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
let pw;
try { pw = require('playwright'); } catch { pw = require(path.join(execSync('npm root -g').toString().trim(), 'playwright')); }

const URL_ = process.env.LIVE_URL || 'https://www.realestate.com.au/rent/in-bondi,+nsw+2026/list-1';
const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'rea-availability-filter.user.js'), 'utf8');
const MIN_RATE = { availability: 0.5, price: 0.7 }; // below these, something REA changed is worth a look

(async () => {
  if (process.env.CI) { console.error('live: not run in CI (see the comment at the top)'); process.exit(2); }
  const browser = await pw.chromium.launch({ headless: !process.env.LIVE_HEADFUL });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, locale: 'en-AU', timezoneId: 'Australia/Sydney' });
  const problems = [];
  try {
    await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.addScriptTag({ content: SCRIPT });
    await page.waitForSelector('#rf-launch', { timeout: 15000 });
    const before = await page.evaluate(() => window.reaFilter.selfcheck());
    console.log(`--- before a search\n${before}\n`);
    await page.click('#rf-launch');
    await page.click('#rf-run');
    await page.waitForFunction(() => /listings match|failed|Paused/i.test(document.querySelector('.rf-status')?.textContent || '')
      || !document.querySelector('.rf-partial')?.hidden, null, { timeout: 180000 });
    const status = await page.textContent('.rf-status');
    const report = await page.evaluate(() => window.reaFilter.selfcheck());
    console.log(`--- after the search: ${status}\n${report}\n`);
    const n = +(report.match(/^rows: (\d+)/m) || [])[1] || 0;
    if (!n) problems.push('no listings read');
    const rates = Object.fromEntries([...report.matchAll(/(\w+) (\d+)%\//g)].map(([, k, v]) => [k, +v / 100]));
    for (const [k, min] of Object.entries(MIN_RATE)) if ((rates[k] ?? 0) < min) problems.push(`${k} filled on ${Math.round((rates[k] ?? 0) * 100)}% of listings`);
    if (/cards: 0 found/.test(report)) problems.push("REA's result cards not recognised");
    if (/fallback: REA renamed it/.test(report)) problems.push('results found by shape (REA renamed the path)');
    if (process.env.LIVE_SAVE !== '0') {
      const shape = JSON.parse(await page.evaluate(() => window.reaFilter.shape()));
      const fill = Object.keys(rates).filter((k) => rates[k] === 1 && ['availability', 'price', 'photos', 'agency'].includes(k));
      const file = path.join(__dirname, 'shapes', `live-${new Date().toISOString().slice(0, 10)}.json`);
      fs.writeFileSync(file, `${JSON.stringify({ note: `npm run live on ${URL_.replace(/\?.*/, '')}`, expect: { fill }, ...shape }, null, 1)}\n`);
      console.log(`shape saved: ${path.relative(process.cwd(), file)} (check it has nothing personal before committing)`);
    }
  } catch (e) {
    problems.push(`${e.message.split('\n')[0]}`);
  } finally {
    await browser.close();
  }
  if (problems.length) { console.error(`live: ${problems.length} problem(s):\n  ${problems.join('\n  ')}`); process.exit(1); }
  console.log('live: ok');
})();

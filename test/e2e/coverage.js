'use strict';
// Optional V8 block coverage of the injected userscript across e2e pages (COVERAGE=1).
// Reports source lines no page executed, so untested UI paths are visible.
const fs = require('fs');
const path = require('path');

const enabled = !!process.env.COVERAGE;
const pages = [];
const hits = new Map(); // line -> covered?

async function track(page) {
  if (!enabled) return;
  await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: true });
  pages.push(page);
}

async function collect(page, script) {
  if (!enabled || !pages.includes(page)) return;
  const entries = await page.coverage.stopJSCoverage();
  const lineStart = [0];
  for (let i = 0; i < script.length; i++) if (script[i] === '\n') lineStart.push(i + 1);
  const lineOf = (off) => { let lo = 0, hi = lineStart.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStart[mid] <= off) lo = mid; else hi = mid - 1; } return lo + 1; };
  for (const e of entries.filter((x) => x.source === script)) {
    // Innermost range wins: apply ranges in order (V8 lists outer before inner).
    const counts = new Array(script.length);
    for (const fn of e.functions) for (const r of fn.ranges) counts.fill(r.count, r.startOffset, r.endOffset);
    const perLine = new Map();
    for (let off = 0; off < script.length; off++) {
      if (/\s/.test(script[off]) || counts[off] === undefined) continue;
      const l = lineOf(off);
      perLine.set(l, (perLine.get(l) || false) || counts[off] > 0);
    }
    for (const [l, c] of perLine) hits.set(l, (hits.get(l) || false) || c);
  }
}

// COVERAGE_APPEND=1 merges with the previous run's hits, so several e2e files add up.
const store = path.join(__dirname, '../../coverage-e2e.json');
function report(script, out = path.join(__dirname, '../../coverage-e2e.txt')) {
  if (!enabled) return;
  if (process.env.COVERAGE_APPEND && fs.existsSync(store)) {
    for (const [l, c] of JSON.parse(fs.readFileSync(store, 'utf8'))) hits.set(l, (hits.get(l) || false) || c);
  }
  fs.writeFileSync(store, JSON.stringify([...hits]));
  const lines = script.split('\n');
  const uncovered = [...hits].filter(([, c]) => !c).map(([l]) => l).sort((a, b) => a - b);
  const ui = lines.findIndex((l) => l.includes('// ------------------------------------------------------------------- ui')) + 1;
  const uiUncovered = uncovered.filter((l) => l > ui);
  const uiTotal = [...hits.keys()].filter((l) => l > ui).length;
  const text = [`UI half (line ${ui}+): ${uiTotal - uiUncovered.length}/${uiTotal} executable lines covered`, '',
    ...uiUncovered.map((l) => `${l}: ${lines[l - 1].trim()}`)].join('\n');
  fs.writeFileSync(out, text + '\n');
  console.log(text.split('\n')[0], `-> ${path.relative(process.cwd(), out)}`);
  // COVERAGE_MIN (eg 98) fails the run when UI line coverage drops below it; the on-demand CI coverage job sets 98.
  const pct = uiTotal ? ((uiTotal - uiUncovered.length) / uiTotal) * 100 : 100;
  const min = +process.env.COVERAGE_MIN;
  if (process.env.GITHUB_STEP_SUMMARY && process.env.COVERAGE_APPEND) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### UI line coverage: ${pct.toFixed(2)}%\n\n${uiTotal - uiUncovered.length} of ${uiTotal} executable lines` +
      `${min ? ` (minimum ${min}%)` : ''}.\n\n${uiUncovered.length ? `<details><summary>${uiUncovered.length} uncovered</summary>\n\n\`\`\`\n${uiUncovered.map((l) => `${l}: ${lines[l - 1].trim()}`).join('\n')}\n\`\`\`\n</details>\n` : ''}`);
  }
  // Only the merged total (last file, COVERAGE_APPEND) is held to the minimum.
  if (min && process.env.COVERAGE_APPEND && pct < min) { console.error(`UI line coverage ${pct.toFixed(2)}% is below COVERAGE_MIN ${min}%`); process.exitCode = 1; }
}

module.exports = { track, collect, report };

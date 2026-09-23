// ==UserScript==
// @name         REA Availability Filter
// @namespace    https://github.com/cpwillis-pocs/rea-enhancement
// @version      1.1.0
// @description  Adds available-from/to filtering, availability sorting, cross-page merging and TSV export to realestate.com.au rental searches.
// @author       cpwillis
// @match        https://www.realestate.com.au/rent/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * Why this exists: realestate.com.au exposes availableBefore= (a ceiling) but has no
 * available-from filter and no availability sort. The data is present though - every
 * results page ships a hydration blob containing listing.availableDate.display.
 * This script reads that blob for every page of the current search, then filters and
 * sorts client-side.
 *
 * It never mutates REA's own DOM (obfuscated classes, React re-renders); it renders
 * its own drawer instead.
 */

(() => {
  'use strict';

  const CFG_KEY = 'rea-avail-filter/v1';
  const IMG_SIZE = '345x260';
  const PAGE_DELAY_MS = 600;
  const MAX_PAGES = 20;

  // ---------------------------------------------------------------- config

  const loadCfg = () => {
    try { return JSON.parse(localStorage.getItem(CFG_KEY)) || {}; } catch { return {}; }
  };
  const saveCfg = (cfg) => {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch { /* private mode */ }
  };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const safeUrl = (u) => (/^https:\/\//i.test(u || '') ? u : '');

  // ------------------------------------------------------------ extraction

  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

  // "Available now" -> today, so it survives a from-date of today or earlier
  // and is correctly excluded by a future from-date.
  // Parsed by hand: Date() on "Mon 12th Oct" is engine-specific and, lacking a year,
  // Chrome yields 2001. A year-less date more than ~2 months past rolls to next year.
  const parseAvail = (display, now = new Date()) => {
    if (!display) return null;
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    if (/\bnow\b/i.test(display)) return today;
    // AU numeric order: dd/mm/yyyy, dd-mm-yy
    const num = display.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})\b/);
    if (num) {
      const d = new Date(+num[3] < 100 ? 2000 + +num[3] : +num[3], +num[2] - 1, +num[1]);
      return isNaN(d) || d.getDate() !== +num[1] ? null : d;
    }
    // "12th Oct 2026" or "October 12, 2026"
    const dm = display.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3})[a-z]*\.?(?:,?\s+(\d{4}))?/i);
    const md = !dm && display.match(/\b([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/i);
    const [day, mon, yr] = dm ? [dm[1], dm[2], dm[3]] : md ? [md[2], md[1], md[3]] : [];
    if (!mon || !(mon.toLowerCase() in MONTHS)) return null;
    const month = MONTHS[mon.toLowerCase()];
    let year = yr ? +yr : today.getFullYear();
    let d = new Date(year, month, +day);
    if (!yr && today - d > 60 * 864e5) d = new Date(++year, month, +day);
    return isNaN(d) ? null : d;
  };

  // Weekly rent as a number. Ranges take the lower bound; monthly/annual figures are
  // converted so mixed listings sort and filter on one scale. Unparseable -> Infinity.
  const parsePrice = (display) => {
    const s = (display || '').replace(/,/g, '');
    const m = s.match(/\$\s*(\d+(?:\.\d+)?)\s*(k)?/i);
    if (!m) return Infinity;
    let v = +m[1] * (m[2] ? 1000 : 1);
    if (/\b(per\s*month|p\.?\s*c\.?\s*m|pcm|monthly|\/\s*month|a\s*month)\b/i.test(s)) v = (v * 12) / 52;
    else if (/\b(per\s*(annum|year)|p\.?\s*a\.?|pa|annually|\/\s*year)\b/i.test(s)) v /= 52;
    return Math.round(v);
  };

  function extractResults(html) {
    const m = html.match(/window\.ArgonautExchange=(\{.*?\});?<\/script>/s);
    if (!m) throw new Error('Hydration blob missing - probably a bot-check interstitial. Reload the page and retry.');
    const raw = JSON.parse(m[1])['resi-property_listing-experience-web']?.urqlClientCache;
    if (!raw) throw new Error('Listing cache missing from page markup.');
    const cache = JSON.parse(raw);
    for (const key of Object.keys(cache)) {
      const entry = cache[key];
      const data = typeof entry?.data === 'string' ? JSON.parse(entry.data) : entry?.data;
      if (data?.rentSearch?.results) return data.rentSearch.results;
    }
    throw new Error('No rentSearch results found in cache.');
  }

  const pageUrl = (base, n) => {
    const u = new URL(base);
    u.pathname = /\/(list|map)-\d+/.test(u.pathname)
      ? u.pathname.replace(/\/(list|map)-\d+/, `/list-${n}`)
      : u.pathname.replace(/\/?$/, `/list-${n}`);
    return u.href;
  };

  const toRow = (listing, surrounding) => {
    const display = listing.availableDate?.display || '';
    const price = listing.price?.display || '';
    return {
      avail: parseAvail(display),
      available: display.replace(/^Available\s*/i, '') || '-',
      price,
      priceNum: parsePrice(price),
      bond: listing.bond?.display || '',
      address: listing.address?.display?.fullAddress || listing.address?.display?.shortAddress || '',
      suburb: listing.address?.suburb || '',
      beds: listing.generalFeatures?.bedrooms?.value ?? '',
      baths: listing.generalFeatures?.bathrooms?.value ?? '',
      cars: listing.generalFeatures?.parkingSpaces?.value ?? '',
      type: listing.propertyType?.display || '',
      img: safeUrl(listing.media?.mainImage?.templatedUrl?.replace('{size}', IMG_SIZE)),
      url: safeUrl(listing._links?.canonical?.href),
      surrounding,
    };
  };

  async function fetchAllPages(base, onProgress) {
    const rows = [];
    let page = 1, max = 1, total = 1;
    do {
      onProgress(`Reading page ${page}${max > 1 ? ` of ${max}` : ''}…`);
      const res = await fetch(pageUrl(base, page), { credentials: 'include' });
      if (!res.ok) throw new Error(`Page ${page} returned HTTP ${res.status}${res.status === 429 ? ' (rate limited - wait and retry)' : ''}.`);
      const results = extractResults(await res.text());
      total = results.pagination?.maxPageNumberAvailable || 1;
      max = Math.min(total, MAX_PAGES);
      for (const it of results.exact?.items || []) if (it.listing) rows.push(toRow(it.listing, false));
      for (const it of results.surrounding?.items || []) if (it.listing) rows.push(toRow(it.listing, true));
      page++;
      if (page <= max) await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
    } while (page <= max);
    return { rows, truncated: total > MAX_PAGES };
  }

  // --------------------------------------------------------------- filter

  // Undated listings ("Contact agent") can't satisfy a date bound, but are kept
  // (sorted last) when no bound is set so an empty filter never hides data.
  function applyFilters(rows, cfg) {
    const from = cfg.from ? new Date(cfg.from + 'T00:00:00') : null;
    const to = cfg.to ? new Date(cfg.to + 'T23:59:59') : null;
    const seen = new Set();
    return rows
      .filter((r) => r.url && !seen.has(r.url) && seen.add(r.url))
      .filter((r) => (cfg.exactOnly ? !r.surrounding : true))
      .filter((r) => (r.avail ? (!from || r.avail >= from) && (!to || r.avail <= to) : !from && !to))
      .sort((a, b) => (a.avail ?? Infinity) - (b.avail ?? Infinity) || a.priceNum - b.priceNum);
  }

  const TSV_COLS = ['available', 'price', 'bond', 'address', 'suburb', 'beds', 'baths', 'cars', 'type', 'url'];
  const toTsv = (rows) =>
    [TSV_COLS.join('\t')]
      .concat(rows.map((r) => TSV_COLS.map((c) => String(r[c] ?? '').replace(/\s+/g, ' ')).join('\t')))
      .join('\n');

  function downloadTsv(rows) {
    const blob = new Blob([toTsv(rows)], { type: 'text/tab-separated-values' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `rea-${new Date().toISOString().slice(0, 10)}.tsv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // Node test harness: expose pure functions, skip all DOM work.
  if (typeof window === 'undefined') {
    module.exports = { parseAvail, parsePrice, extractResults, pageUrl, toRow, applyFilters, toTsv, esc, safeUrl };
    return;
  }

  // ------------------------------------------------------------------- ui

  const css = `
  #rf-launch{position:fixed;right:20px;bottom:20px;z-index:2147483000;padding:11px 16px;border:0;border-radius:999px;
    background:#0b7;color:#fff;font:600 13px/1 system-ui,-apple-system,sans-serif;cursor:pointer;
    box-shadow:0 4px 16px rgba(0,0,0,.28)}
  #rf-launch:hover{background:#0a6}
  #rf-panel{position:fixed;top:0;right:0;bottom:0;width:430px;max-width:100vw;z-index:2147483001;background:#fff;
    display:flex;flex-direction:column;box-shadow:-4px 0 24px rgba(0,0,0,.22);
    font:13px/1.45 system-ui,-apple-system,sans-serif;color:#111}
  #rf-panel[hidden]{display:none}
  .rf-head{padding:14px 16px;border-bottom:1px solid #e4e4e7;display:flex;align-items:center;gap:8px}
  .rf-head h2{margin:0;font-size:14px;font-weight:650;flex:1}
  .rf-x{border:0;background:none;font-size:20px;line-height:1;cursor:pointer;color:#666;padding:0 4px}
  .rf-controls{padding:12px 16px;border-bottom:1px solid #e4e4e7;display:grid;gap:10px}
  .rf-dates{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .rf-controls label{display:grid;gap:4px;font-size:11px;font-weight:600;text-transform:uppercase;
    letter-spacing:.04em;color:#666}
  .rf-controls input[type=date]{padding:7px 8px;border:1px solid #cfcfd4;border-radius:6px;font:inherit;color:#111}
  .rf-check{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:500;text-transform:none;
    letter-spacing:0;color:#111}
  .rf-check input{margin:0}
  .rf-actions{display:flex;gap:8px}
  .rf-btn{flex:1;padding:9px 12px;border:0;border-radius:6px;background:#0b7;color:#fff;
    font:600 13px system-ui,sans-serif;cursor:pointer}
  .rf-btn:hover{background:#0a6}
  .rf-btn[disabled]{opacity:.5;cursor:default}
  .rf-btn.sec{background:#f1f1f4;color:#111}
  .rf-btn.sec:hover{background:#e6e6ea}
  .rf-status{padding:8px 16px;font-size:12px;color:#555;border-bottom:1px solid #e4e4e7;min-height:19px}
  .rf-status.err{color:#c00}
  .rf-list{flex:1;overflow-y:auto;padding:8px}
  .rf-card{display:grid;grid-template-columns:104px 1fr;gap:11px;padding:9px;border-radius:8px;
    color:inherit;text-decoration:none}
  .rf-card:hover{background:#f6f6f8}
  .rf-card img{width:104px;height:78px;object-fit:cover;border-radius:6px;background:#eee}
  .rf-avail{font-weight:700;color:#0a6;font-size:12px}
  .rf-price{font-weight:650;margin-top:1px}
  .rf-addr{color:#333;margin-top:1px}
  .rf-meta{color:#767680;font-size:12px;margin-top:3px}
  .rf-tag{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:4px;background:#eee;
    color:#666;font-size:10px;font-weight:600;text-transform:uppercase;vertical-align:1px}
  .rf-empty{padding:28px 16px;text-align:center;color:#767680}
  `;

  let cfg = Object.assign({ from: '', to: '', exactOnly: false }, loadCfg());
  let cache = null; // raw rows for the current search URL
  let cacheUrl = null;
  let truncated = false;
  let runId = 0; // bumped on navigation so an in-flight run can't write stale rows
  let ui = null;

  function build() {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    const launch = document.createElement('button');
    launch.id = 'rf-launch';
    launch.textContent = 'Availability filter';

    const panel = document.createElement('div');
    panel.id = 'rf-panel';
    panel.hidden = true;
    panel.innerHTML = `
      <div class="rf-head">
        <h2>Availability filter</h2>
        <button class="rf-x" title="Close">&times;</button>
      </div>
      <div class="rf-controls">
        <div class="rf-dates">
          <label>Available from<input type="date" id="rf-from"></label>
          <label>Available to<input type="date" id="rf-to"></label>
        </div>
        <label class="rf-check"><input type="checkbox" id="rf-exact">Hide surrounding suburbs</label>
        <div class="rf-actions">
          <button class="rf-btn" id="rf-run">Search all pages</button>
          <button class="rf-btn sec" id="rf-export" disabled>Export TSV</button>
        </div>
      </div>
      <div class="rf-status"></div>
      <div class="rf-list"><div class="rf-empty">Set your dates, then search.<br>Every result page is merged and sorted by availability.</div></div>`;

    document.body.append(launch, panel);

    ui = {
      launch, panel,
      from: panel.querySelector('#rf-from'),
      to: panel.querySelector('#rf-to'),
      exact: panel.querySelector('#rf-exact'),
      run: panel.querySelector('#rf-run'),
      exportBtn: panel.querySelector('#rf-export'),
      status: panel.querySelector('.rf-status'),
      list: panel.querySelector('.rf-list'),
    };

    ui.from.value = cfg.from;
    ui.to.value = cfg.to;
    ui.exact.checked = !!cfg.exactOnly;

    launch.addEventListener('click', () => { panel.hidden = false; });
    panel.querySelector('.rf-x').addEventListener('click', () => { panel.hidden = true; });

    const onChange = () => {
      cfg = { from: ui.from.value, to: ui.to.value, exactOnly: ui.exact.checked };
      saveCfg(cfg);
      if (cache) showResults(); // re-filter without refetching
    };
    ui.from.addEventListener('change', onChange);
    ui.to.addEventListener('change', onChange);
    ui.exact.addEventListener('change', onChange);

    ui.run.addEventListener('click', run);
    ui.exportBtn.addEventListener('click', () => {
      if (cache) downloadTsv(applyFilters(cache, cfg));
    });
  }

  const setStatus = (msg, isErr) => {
    ui.status.textContent = msg;
    ui.status.classList.toggle('err', !!isErr);
  };

  function showResults() {
    const rows = applyFilters(cache, cfg);
    render(rows);
    setStatus(`${rows.length} of ${cache.length} listings match.` +
      (truncated ? ` Only the first ${MAX_PAGES} pages were read - narrow the search for full coverage.` : ''));
  }

  function render(rows) {
    ui.exportBtn.disabled = rows.length === 0;
    if (!rows.length) {
      ui.list.innerHTML = '<div class="rf-empty">Nothing matches those dates.</div>';
      return;
    }
    ui.list.innerHTML = rows.map((r) => `
      <a class="rf-card" href="${esc(r.url)}" target="_blank" rel="noopener">
        ${r.img ? `<img src="${esc(r.img)}" alt="" loading="lazy">` : '<div></div>'}
        <div>
          <div class="rf-avail">${esc(r.available)}${r.surrounding ? '<span class="rf-tag">nearby</span>' : ''}</div>
          <div class="rf-price">${esc(r.price)}</div>
          <div class="rf-addr">${esc(r.address)}</div>
          <div class="rf-meta">${esc([
            r.beds !== '' ? `${r.beds} bed` : '',
            r.baths !== '' ? `${r.baths} bath` : '',
            r.cars !== '' ? `${r.cars} car` : '',
            r.bond ? `bond ${r.bond}` : '',
          ].filter(Boolean).join(' · '))}</div>
        </div>
      </a>`).join('');
    ui.list.scrollTop = 0;
  }

  async function run() {
    const id = ++runId;
    const base = location.href;
    ui.run.disabled = true;
    ui.exportBtn.disabled = true;
    try {
      const res = await fetchAllPages(base, (m) => { if (id === runId) setStatus(m); });
      if (id !== runId) return; // search changed mid-run; navigation handler already reported it
      cache = res.rows;
      truncated = res.truncated;
      cacheUrl = base;
      showResults();
    } catch (err) {
      if (id !== runId) return;
      cache = null;
      setStatus(err.message, true);
      ui.list.innerHTML = '<div class="rf-empty">Search failed.</div>';
    } finally {
      if (id === runId) ui.run.disabled = false;
    }
  }

  // REA is an SPA - invalidate cached rows (and any in-flight run) when the search URL changes.
  function watchNavigation() {
    let lastUrl = location.href;
    const fire = () => window.dispatchEvent(new Event('rf:navigate'));
    for (const fn of ['pushState', 'replaceState']) {
      const orig = history[fn];
      history[fn] = function (...args) { const r = orig.apply(this, args); fire(); return r; };
    }
    window.addEventListener('popstate', fire);
    window.addEventListener('rf:navigate', () => {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      const inFlight = ui.run.disabled;
      if (!cacheUrl && !inFlight) return;
      if (cacheUrl && location.href === cacheUrl) return;
      runId++;
      cache = null;
      cacheUrl = null;
      ui.run.disabled = false;
      ui.exportBtn.disabled = true;
      setStatus('Search changed - run again to refresh.');
    });
  }

  build();
  watchNavigation();
})();

// ==UserScript==
// @name         REA Availability Filter
// @namespace    https://github.com/cpwillis-pocs/rea-enhancement
// @version      1.0.0
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

  // ------------------------------------------------------------ extraction

  // "Available now" -> today, so it survives a from-date of today or earlier
  // and is correctly excluded by a future from-date.
  const parseAvail = (display) => {
    if (!display) return null;
    if (/now/i.test(display)) { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
    const d = new Date(display.replace(/^Available\s+/i, ''));
    return isNaN(d) ? null : d;
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

  const pageUrl = (n) => {
    const u = new URL(location.href);
    u.pathname = /\/(list|map)-\d+/.test(u.pathname)
      ? u.pathname.replace(/\/(list|map)-\d+/, `/list-${n}`)
      : u.pathname.replace(/\/?$/, `/list-${n}`);
    return u.href;
  };

  const toRow = (listing, surrounding) => ({
    avail: parseAvail(listing.availableDate?.display),
    available: (listing.availableDate?.display || '').replace(/^Available\s*/i, '') || '-',
    price: listing.price?.display || '',
    bond: listing.bond?.display || '',
    address: listing.address?.display?.fullAddress || listing.address?.display?.shortAddress || '',
    suburb: listing.address?.suburb || '',
    beds: listing.generalFeatures?.bedrooms?.value ?? '',
    baths: listing.generalFeatures?.bathrooms?.value ?? '',
    cars: listing.generalFeatures?.parkingSpaces?.value ?? '',
    type: listing.propertyType?.display || '',
    img: listing.media?.mainImage?.templatedUrl?.replace('{size}', IMG_SIZE) || '',
    url: listing._links?.canonical?.href || '',
    surrounding,
  });

  async function fetchAllPages(onProgress) {
    const rows = [];
    let page = 1, max = 1;
    do {
      onProgress(`Reading page ${page}${max > 1 ? ` of ${Math.min(max, MAX_PAGES)}` : ''}…`);
      const html = await fetch(pageUrl(page)).then((r) => r.text());
      const results = extractResults(html);
      max = Math.min(results.pagination?.maxPageNumberAvailable || 1, MAX_PAGES);
      for (const it of results.exact?.items || []) if (it.listing) rows.push(toRow(it.listing, false));
      for (const it of results.surrounding?.items || []) if (it.listing) rows.push(toRow(it.listing, true));
      page++;
      if (page <= max) await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
    } while (page <= max);
    return rows;
  }

  // --------------------------------------------------------------- filter

  function applyFilters(rows, cfg) {
    const from = cfg.from ? new Date(cfg.from + 'T00:00:00') : null;
    const to = cfg.to ? new Date(cfg.to + 'T23:59:59') : null;
    const seen = new Set();
    return rows
      .filter((r) => r.url && !seen.has(r.url) && seen.add(r.url))
      .filter((r) => (cfg.exactOnly ? !r.surrounding : true))
      .filter((r) => r.avail && (!from || r.avail >= from) && (!to || r.avail <= to))
      .sort((a, b) => a.avail - b.avail || String(a.price).localeCompare(String(b.price)));
  }

  const TSV_COLS = ['available', 'price', 'bond', 'address', 'beds', 'baths', 'cars', 'type', 'url'];
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
      if (cache) render(applyFilters(cache, cfg)); // re-filter without refetching
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

  function render(rows) {
    ui.exportBtn.disabled = rows.length === 0;
    if (!rows.length) {
      ui.list.innerHTML = '<div class="rf-empty">Nothing matches those dates.</div>';
      return;
    }
    ui.list.innerHTML = rows.map((r) => `
      <a class="rf-card" href="${r.url}" target="_blank" rel="noopener">
        ${r.img ? `<img src="${r.img}" alt="" loading="lazy">` : '<div></div>'}
        <div>
          <div class="rf-avail">${r.available}${r.surrounding ? '<span class="rf-tag">nearby</span>' : ''}</div>
          <div class="rf-price">${r.price}</div>
          <div class="rf-addr">${r.address}</div>
          <div class="rf-meta">${[
            r.beds !== '' ? `${r.beds} bed` : '',
            r.baths !== '' ? `${r.baths} bath` : '',
            r.cars !== '' ? `${r.cars} car` : '',
            r.bond ? `bond ${r.bond}` : '',
          ].filter(Boolean).join(' · ')}</div>
        </div>
      </a>`).join('');
    ui.list.scrollTop = 0;
  }

  async function run() {
    ui.run.disabled = true;
    ui.exportBtn.disabled = true;
    try {
      cache = await fetchAllPages((m) => setStatus(m));
      cacheUrl = location.href;
      const rows = applyFilters(cache, cfg);
      render(rows);
      setStatus(`${rows.length} of ${cache.length} listings match.`);
    } catch (err) {
      cache = null;
      setStatus(err.message, true);
      ui.list.innerHTML = '<div class="rf-empty">Search failed.</div>';
    } finally {
      ui.run.disabled = false;
    }
  }

  // REA is an SPA - invalidate cached rows when the search URL changes.
  function watchNavigation() {
    const fire = () => window.dispatchEvent(new Event('rf:navigate'));
    for (const fn of ['pushState', 'replaceState']) {
      const orig = history[fn];
      history[fn] = function (...args) { const r = orig.apply(this, args); fire(); return r; };
    }
    window.addEventListener('popstate', fire);
    window.addEventListener('rf:navigate', () => {
      if (cacheUrl && location.href !== cacheUrl) {
        cache = null;
        cacheUrl = null;
        ui.exportBtn.disabled = true;
        setStatus('Search changed - run again to refresh.');
      }
    });
  }

  build();
  watchNavigation();
})();

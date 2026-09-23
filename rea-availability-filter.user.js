// ==UserScript==
// @name         REA Availability Filter
// @namespace    https://github.com/cpwillis-pocs/rea-enhancement
// @version      2.0.0
// @description  Availability-date filtering and sorting, extra filters, cross-page merging, on-card availability badges and CSV/TSV export for realestate.com.au rental searches.
// @author       cpwillis
// @match        https://www.realestate.com.au/rent/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/*
 * Why this exists: realestate.com.au exposes availableBefore= (a ceiling) but has no
 * available-from filter and no availability sort. The data is present though - every
 * results page ships a hydration blob containing listing.availableDate.display.
 * This script reads that blob for every page of the current search, then filters and
 * sorts client-side.
 *
 * REA's markup uses obfuscated classes and React re-renders, so the script renders its
 * own drawer and only touches REA's DOM append-only: one badge per <article> result
 * card plus data-rf-* attributes, re-applied idempotently by a MutationObserver.
 *
 * Console: reaFilter.probe() lists which listing fields exist in live data.
 */

(() => {
  'use strict';

  const CFG_KEY = 'rea-avail-filter/v1';
  const IMG_SIZE = '345x260';
  const PAGE_DELAY_MS = 600;
  const MAX_PAGES = 20;
  const RETRIES = 3;
  const RETRY_BASE_MS = 1000;
  const ROWS_PREFIX = 'rea-avail-filter/rows/';
  const ROWS_VERSION = 3; // bump when toRow() shape changes
  const ROW_DATES = ['avail', 'nextInspect', 'listed'];
  const ROWS_TTL_MS = 10 * 60 * 1000;

  // ---------------------------------------------------------------- config

  const loadCfg = () => {
    try { return JSON.parse(localStorage.getItem(CFG_KEY)) || {}; } catch { return {}; }
  };
  const saveCfg = (cfg) => {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch { /* private mode */ }
  };

  // Per-search row cache in sessionStorage (tab-scoped, survives reloads/back-nav).
  // JSON loses Date and Infinity, so both are restored on read.
  const rowStore = (storage, now = () => Date.now()) => ({
    get(key) {
      try {
        const v = JSON.parse(storage.getItem(ROWS_PREFIX + key));
        if (!v || v.v !== ROWS_VERSION || now() - v.at > ROWS_TTL_MS) return null;
        for (const r of v.rows) {
          for (const k of ROW_DATES) r[k] = r[k] == null ? null : new Date(r[k]);
          r.priceNum = r.priceNum ?? Infinity;
          r.ppb = r.ppb ?? Infinity;
        }
        return v;
      } catch { return null; }
    },
    set(key, rows, truncated) {
      const put = () => storage.setItem(ROWS_PREFIX + key, JSON.stringify({ v: ROWS_VERSION, at: now(), truncated, rows }));
      try {
        for (let i = storage.length - 1; i >= 0; i--) {
          const k = storage.key(i);
          if (k?.startsWith(ROWS_PREFIX) && k !== ROWS_PREFIX + key) {
            try { if (now() - JSON.parse(storage.getItem(k)).at > ROWS_TTL_MS) storage.removeItem(k); } catch { storage.removeItem(k); }
          }
        }
        put();
      } catch {
        try { // quota: drop every other cached search and retry once
          for (let i = storage.length - 1; i >= 0; i--) {
            const k = storage.key(i);
            if (k?.startsWith(ROWS_PREFIX)) storage.removeItem(k);
          }
          put();
        } catch { /* unavailable */ }
      }
    },
  });

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

  // REA's SSR payload: ArgonautExchange -> app key -> urqlClientCache (JSON string)
  // -> entries whose `data` is (usually) a further JSON string.
  function parseExchange(exchange) {
    const raw = exchange?.['resi-property_listing-experience-web']?.urqlClientCache;
    if (!raw) throw new Error('Listing cache missing from page markup.');
    const cache = typeof raw === 'string' ? JSON.parse(raw) : raw;
    for (const key of Object.keys(cache)) {
      const entry = cache[key];
      const data = typeof entry?.data === 'string' ? JSON.parse(entry.data) : entry?.data;
      if (data?.rentSearch?.results) return data.rentSearch.results;
    }
    throw new Error('No rentSearch results found in cache.');
  }

  function extractResults(html) {
    const m = html.match(/window\.ArgonautExchange=(\{.*?\});?<\/script>/s);
    if (!m) throw new Error('Hydration blob missing - probably a bot-check interstitial. Reload the page and retry.');
    return parseExchange(JSON.parse(m[1]));
  }

  const pageUrl = (base, n) => {
    const u = new URL(base);
    u.hash = '';
    u.pathname = /\/(list|map)-\d+/.test(u.pathname)
      ? u.pathname.replace(/\/(list|map)-\d+/, `/list-${n}`)
      : u.pathname.replace(/\/?$/, `/list-${n}`);
    return u.href;
  };

  // Identity of a search regardless of which page / view is showing.
  const searchKey = (href) => pageUrl(href, 1);
  const pageNum = (href) => +(new URL(href).pathname.match(/\/(?:list|map)-(\d+)/)?.[1] || 1);

  // Field names below are best-effort: REA's GraphQL shape is undocumented, so several
  // plausible spellings are tried and anything unrecognised degrades to empty.
  const toDate = (v) => {
    if (v == null || v === '') return null;
    const raw = typeof v === 'object' ? v.value ?? v.iso ?? v.dateTime ?? v.date ?? null : v;
    if (raw == null) return null;
    const d = typeof raw === 'number' ? new Date(raw < 1e12 ? raw * 1000 : raw) : new Date(raw);
    return isNaN(d) || !/\d{4}/.test(String(raw)) && typeof raw !== 'number' ? null : d;
  };

  const DT_FMT = { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' };
  const fmtWhen = (d) => d.toLocaleString('en-AU', DT_FMT).replace(/\s?(am|pm)/i, (m) => m.trim().toLowerCase());

  function extractInspections(listing, now = new Date()) {
    const src = listing.inspections ?? listing.inspectionTimes ?? listing.openHomes ?? listing.inspectionsAndAuctions?.inspections;
    const list = Array.isArray(src) ? src : Array.isArray(src?.items) ? src.items : Array.isArray(src?.inspections) ? src.inspections : [];
    const cutoff = now.getTime() - 60 * 60 * 1000; // keep one that started <1h ago
    return list
      .map((it) => {
        const at = toDate(it?.startTime ?? it?.startTimeUtc ?? it?.start ?? it?.dateTime ?? it?.startsAt);
        const label = str(it?.display?.shortLabel) || str(it?.display?.longLabel) || str(it?.display) || str(it?.label) || (at ? fmtWhen(at) : '');
        return { at: at ? at.getTime() : null, label };
      })
      .filter((i) => i.label && (i.at == null || i.at >= cutoff))
      .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
  }

  const extractListed = (listing) =>
    toDate(listing.dateListed ?? listing.listedDate ?? listing.listingDate ?? listing.dateFirstListed ?? listing.listedAt);

  const listingId = (href) => String(href || '').match(/-(\d{6,})(?:[/?#]|$)/)?.[1] || '';

  const toRow = (listing, surrounding) => {
    const display = listing.availableDate?.display || '';
    const price = listing.price?.display || '';
    const row = {
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
      headline: str(listing.title) || str(listing.headline) || '',
      id: String(listing.id ?? '') || listingId(listing._links?.canonical?.href),
      inspections: extractInspections(listing),
      listed: extractListed(listing),
    };
    const next = row.inspections.find((i) => i.at != null);
    row.nextInspect = next ? new Date(next.at) : null;
    row.inspect = row.inspections.map((i) => i.label).join('; ');
    // Studios report 0 beds: price per bed is then the full price.
    row.ppb = isFinite(row.priceNum) ? Math.round(row.priceNum / Math.max(1, +row.beds || 0)) : Infinity;
    row.text = [row.headline, str(listing.description), row.address, row.type].filter(Boolean).join(' ').toLowerCase();
    return row;
  };

  const str = (v) => (typeof v === 'string' ? v : typeof v?.display === 'string' ? v.display : '');

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (ms) => Math.round(ms * (0.75 + Math.random() * 0.75));

  // Retries 429/5xx/network errors with exponential backoff, honouring Retry-After.
  // Any other non-2xx, or a page without the blob (bot check), fails immediately.
  async function fetchResults(url, { fetchImpl = fetch, wait = sleep, onRetry = () => {} } = {}) {
    for (let attempt = 0; ; attempt++) {
      let res, err;
      try { res = await fetchImpl(url, { credentials: 'include' }); } catch (e) { err = e; }
      const retryable = err || res.status === 429 || res.status >= 500;
      if (!retryable) {
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
        return extractResults(await res.text());
      }
      if (attempt >= RETRIES) {
        throw new Error(err ? `Network error: ${err.message}` :
          res.status === 429 ? 'Rate limited by REA (HTTP 429) - wait a minute and retry.' : `HTTP ${res.status} from ${url}`);
      }
      const after = +res?.headers?.get?.('Retry-After');
      const ms = after > 0 ? after * 1000 : jitter(RETRY_BASE_MS * 2 ** attempt);
      onRetry(attempt + 1, ms);
      await wait(ms);
    }
  }

  // `seed` = { key, page, results } from the already-loaded document, reused instead of refetching.
  async function fetchAllPages(base, onProgress, { seed = null, fetchImpl, wait = sleep, getPage = null } = {}) {
    const rows = [];
    const key = searchKey(base);
    let page = 1, max = 1, total = 1, sample = null;
    do {
      const label = `page ${page}${max > 1 ? ` of ${max}` : ''}`;
      onProgress(`Reading ${label}…`);
      const seeded = seed && seed.key === key && seed.page === page;
      const results = seeded ? seed.results : getPage ? await getPage(pageUrl(base, page)) : await fetchResults(pageUrl(base, page), {
        fetchImpl, wait,
        onRetry: (n, ms) => onProgress(`Retrying ${label} in ${Math.round(ms / 1000)}s (attempt ${n}/${RETRIES})…`),
      });
      total = results.pagination?.maxPageNumberAvailable || 1;
      max = Math.min(total, MAX_PAGES);
      for (const it of results.exact?.items || []) if (it.listing) rows.push(toRow(it.listing, false));
      for (const it of results.surrounding?.items || []) if (it.listing) rows.push(toRow(it.listing, true));
      sample ??= results.exact?.items?.find((i) => i.listing)?.listing ?? null;
      page++;
      const nextSeeded = seed && seed.key === key && seed.page === page;
      if (page <= max && !seeded && !nextSeeded) await wait(jitter(PAGE_DELAY_MS));
    } while (page <= max);
    return { rows, truncated: total > MAX_PAGES, sample };
  }

  // --------------------------------------------------------------- filter

  const DEFAULT_CFG = {
    from: '', to: '', exactOnly: false,
    priceMin: '', priceMax: '', bedsMin: '', bathsMin: '', carsMin: '',
    type: '', keyword: '', hideNoImage: false, inspectOn: '', sort: 'avail',
    annotate: true, dimCards: true,
  };

  const num = (v) => (v === '' || v == null || isNaN(+v) ? null : +v);
  const byAvail = (a, b) => (a.avail ?? Infinity) - (b.avail ?? Infinity);
  const byPrice = (a, b) => a.priceNum - b.priceNum;
  const SORTS = {
    avail: (a, b) => byAvail(a, b) || byPrice(a, b),
    price: (a, b) => byPrice(a, b) || byAvail(a, b),
    ppb: (a, b) => a.ppb - b.ppb || byAvail(a, b),
    beds: (a, b) => (+b.beds || 0) - (+a.beds || 0) || byPrice(a, b),
    listed: (a, b) => (b.listed ?? -Infinity) - (a.listed ?? -Infinity) || byAvail(a, b),
    inspect: (a, b) => (a.nextInspect ?? Infinity) - (b.nextInspect ?? Infinity) || byAvail(a, b),
  };
  // NaN from Infinity - Infinity is falsy, so ties on unknowns fall through to the next key.

  // Keyword: space-separated terms, all must match; "-term" excludes; "quoted phrase" kept whole.
  const keywordTest = (q) => {
    const terms = (q || '').toLowerCase().match(/-?"[^"]+"|\S+/g) || [];
    const inc = [], exc = [];
    for (const t of terms) {
      const neg = t.startsWith('-') && t.length > 1;
      const w = (neg ? t.slice(1) : t).replace(/^"|"$/g, '');
      if (w) (neg ? exc : inc).push(w);
    }
    return (text) => inc.every((w) => text.includes(w)) && !exc.some((w) => text.includes(w));
  };

  // Undated listings ("Contact agent") can't satisfy a date bound, but are kept
  // (sorted last) when no bound is set so an empty filter never hides data.
  // Numeric minimums treat unknown values as failing; maximums likewise.
  function applyFilters(rows, cfg) {
    cfg = { ...DEFAULT_CFG, ...cfg };
    const from = cfg.from ? new Date(cfg.from + 'T00:00:00') : null;
    const to = cfg.to ? new Date(cfg.to + 'T23:59:59') : null;
    const pMin = num(cfg.priceMin), pMax = num(cfg.priceMax);
    const mins = [['beds', num(cfg.bedsMin)], ['baths', num(cfg.bathsMin)], ['cars', num(cfg.carsMin)]].filter(([, v]) => v != null);
    const kw = cfg.keyword.trim() ? keywordTest(cfg.keyword) : null;
    const insDay = cfg.inspectOn ? new Date(cfg.inspectOn + 'T00:00:00') : null;
    const sameDay = (ms) => { const d = new Date(ms); return d.getFullYear() === insDay.getFullYear() && d.getMonth() === insDay.getMonth() && d.getDate() === insDay.getDate(); };
    const seen = new Set();
    return rows
      .filter((r) => r.url && !seen.has(r.url) && seen.add(r.url))
      .filter((r) => (cfg.exactOnly ? !r.surrounding : true))
      .filter((r) => (r.avail ? (!from || r.avail >= from) && (!to || r.avail <= to) : !from && !to))
      .filter((r) => (pMin == null || (isFinite(r.priceNum) && r.priceNum >= pMin)) && (pMax == null || r.priceNum <= pMax))
      .filter((r) => mins.every(([k, v]) => r[k] !== '' && +r[k] >= v))
      .filter((r) => !cfg.type || r.type === cfg.type)
      .filter((r) => !cfg.hideNoImage || r.img)
      .filter((r) => !kw || kw(r.text || ''))
      .filter((r) => !insDay || (r.inspections || []).some((i) => i.at != null && sameDay(i.at)))
      .sort(SORTS[cfg.sort] || SORTS.avail);
  }

  const EXPORT_COLS = [
    ['availDate', 'available_date'], ['available', 'available'], ['price', 'price'], ['priceNum', 'weekly_rent'],
    ['ppb', 'rent_per_bed'], ['bond', 'bond'], ['address', 'address'], ['suburb', 'suburb'], ['beds', 'beds'],
    ['baths', 'baths'], ['cars', 'cars'], ['type', 'type'], ['inspect', 'inspections'], ['listed', 'listed'],
    ['surrounding', 'nearby'], ['headline', 'headline'], ['url', 'url'],
  ];
  const ymdLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const cellValue = (r, k) => {
    const v = k === 'availDate' ? r.avail : r[k];
    if (v instanceof Date) return isNaN(v) ? '' : ymdLocal(v);
    if (typeof v === 'number') return isFinite(v) ? String(v) : '';
    if (typeof v === 'boolean') return v ? 'yes' : '';
    return String(v ?? '').replace(/\s+/g, ' ').trim();
  };
  // Spreadsheet formula injection guard (OWASP): neutralise leading = + @ and -<non-numeric>.
  const safeCell = (v) => (/^[=+@\t\r]|^-(?![\d.]|$)/.test(v) ? `'${v}` : v);
  const table = (rows) => [EXPORT_COLS.map(([, h]) => h)].concat(rows.map((r) => EXPORT_COLS.map(([k]) => safeCell(cellValue(r, k)))));

  const toTsv = (rows) => table(rows).map((cols) => cols.map((c) => c.replace(/\t/g, ' ')).join('\t')).join('\n');
  const toCsv = (rows) => table(rows).map((cols) => cols.map((c) => (/[",\n\r]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\r\n');

  function download(name, text, type) {
    const blob = new Blob([text], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  const stamp = () => ymdLocal(new Date());
  // BOM so Excel opens UTF-8 (en dashes, accented suburbs) correctly.
  const downloadCsv = (rows) => download(`rea-${stamp()}.csv`, '\ufeff' + toCsv(rows), 'text/csv;charset=utf-8');
  const downloadTsv = (rows) => download(`rea-${stamp()}.tsv`, toTsv(rows), 'text/tab-separated-values;charset=utf-8');

  // Heuristic drift detection: parsing "worked" but the fields we depend on are gone.
  function schemaWarnings(rows) {
    if (!rows.length) return [];
    const w = [];
    const share = (f) => rows.filter(f).length / rows.length;
    if (share((r) => r.available !== '-') === 0) w.push('no listing has availableDate.display');
    else if (share((r) => r.avail) < 0.5 && share((r) => r.available !== '-') > 0.5) w.push('availability text found but mostly unparseable');
    if (share((r) => r.url) === 0) w.push('no listing has _links.canonical.href');
    if (share((r) => r.price) === 0) w.push('no listing has price.display');
    return w;
  }

  // Paths toRow() reads, for reaFilter.probe() in the console.
  const PROBE_PATHS = [
    'id', 'availableDate.display', 'price.display', 'bond.display', 'address.display.fullAddress', 'address.suburb',
    'generalFeatures.bedrooms.value', 'generalFeatures.bathrooms.value', 'generalFeatures.parkingSpaces.value',
    'propertyType.display', 'media.mainImage.templatedUrl', '_links.canonical.href', 'title', 'headline', 'description',
    'inspections', 'inspectionTimes', 'openHomes', 'inspectionsAndAuctions.inspections',
    'dateListed', 'listedDate', 'listingDate', 'dateFirstListed', 'listedAt',
  ];
  const probe = (listing) => Object.fromEntries(PROBE_PATHS.map((p) => {
    const v = p.split('.').reduce((o, k) => o?.[k], listing);
    return [p, v === undefined ? '(missing)' : typeof v === 'object' ? JSON.stringify(v).slice(0, 160) : v];
  }));

  // Node test harness: expose pure functions, skip all DOM work.
  if (typeof window === 'undefined') {
    module.exports = {
      parseAvail, parsePrice, parseExchange, extractResults, pageUrl, searchKey, pageNum, toRow,
      fetchResults, fetchAllPages, listingId, extractInspections, extractListed, toDate, applyFilters, keywordTest, toTsv, toCsv, schemaWarnings, probe, esc, safeUrl, rowStore, DEFAULT_CFG,
    };
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
  .rf-clear{border:0;background:none;font:600 12px system-ui,sans-serif;color:#0a6;cursor:pointer;padding:2px 6px}
  .rf-x{border:0;background:none;font-size:20px;line-height:1;cursor:pointer;color:#666;padding:0 4px}
  .rf-controls{padding:12px 16px;border-bottom:1px solid #e4e4e7;display:grid;gap:10px}
  .rf-dates{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .rf-controls label{display:grid;gap:4px;font-size:11px;font-weight:600;text-transform:uppercase;
    letter-spacing:.04em;color:#666}
  .rf-controls input:not([type=checkbox]),.rf-controls select{padding:7px 8px;border:1px solid #cfcfd4;border-radius:6px;
    font:inherit;color:#111;background:#fff;min-width:0;width:100%;box-sizing:border-box}
  .rf-grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:8px 10px}
  .rf-more{display:grid;gap:10px}
  .rf-more[open]{padding-bottom:2px}
  .rf-more summary{cursor:pointer;font-size:12px;font-weight:600;color:#0a6;margin-bottom:8px}
  .rf-more>label,.rf-more>.rf-grid3{margin-top:8px}
  .rf-row{display:flex;align-items:center;justify-content:space-between;gap:10px}
  .rf-sort{display:flex !important;align-items:center;gap:6px !important}
  .rf-sort select{width:auto !important}
  .rf-type{font-weight:400;color:#767680;font-size:12px}
  .rf-check{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:500;text-transform:none;
    letter-spacing:0;color:#111}
  .rf-check input{margin:0}
  .rf-actions{display:flex;gap:8px;align-items:center}
  .rf-exports .rf-btn{flex:0 0 auto;padding:6px 11px;font-size:12px}
  .rf-label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:#666;margin-right:auto}
  .rf-btn{flex:1;padding:9px 12px;border:0;border-radius:6px;background:#0b7;color:#fff;
    font:600 13px system-ui,sans-serif;cursor:pointer}
  .rf-btn:hover{background:#0a6}
  .rf-btn[disabled]{opacity:.5;cursor:default}
  .rf-btn[hidden]{display:none}
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
  article[data-rf-id]{position:relative}
  article[data-rf-match="0"]{opacity:.35;transition:opacity .15s}
  article[data-rf-match="0"]:hover{opacity:1}
  .rf-badge{position:absolute;top:10px;left:10px;z-index:5;display:flex;gap:4px;flex-wrap:wrap;pointer-events:none;
    font:600 11px/1 system-ui,-apple-system,sans-serif}
  .rf-badge span{padding:5px 8px;border-radius:999px;background:rgba(0,0,0,.78);color:#fff;white-space:nowrap}
  .rf-badge .rf-b-now{background:#0a6}
  .rf-badge .rf-b-none{background:rgba(90,90,90,.85)}
  `;

  let cfg = { ...DEFAULT_CFG, ...loadCfg() };
  let cache = null; // raw rows for the current search URL
  let cacheKey = null; // searchKey() of the cached rows
  let truncated = false;
  let runId = 0; // bumped on navigation so an in-flight run can't write stale rows
  let ui = null;

  // The document we were loaded with already holds one page of results; after SPA
  // navigation it is stale, which the key/page match in fetchAllPages guards against.
  const boot = (() => {
    try {
      const key = searchKey(location.href), page = pageNum(location.href);
      if (window.ArgonautExchange) return { key, page, results: parseExchange(window.ArgonautExchange) };
      const tag = [...document.scripts].find((sc) => sc.textContent.includes('window.ArgonautExchange='));
      return tag ? { key, page, results: extractResults(tag.textContent + '</script>') } : null;
    } catch { return null; }
  })();

  const store = rowStore(window.sessionStorage);
  let rawSample = boot?.results?.exact?.items?.find((i) => i.listing)?.listing ?? null;

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
        <button class="rf-clear" title="Reset all filters">Clear</button>
        <button class="rf-x" title="Close (Esc)">&times;</button>
      </div>
      <div class="rf-controls">
        <div class="rf-dates">
          <label>Available from<input type="date" id="rf-from"></label>
          <label>Available to<input type="date" id="rf-to"></label>
        </div>
        <details class="rf-more" id="rf-more">
          <summary>More filters</summary>
          <div class="rf-grid3">
            <label>Min $/wk<input type="number" min="0" step="25" id="rf-priceMin" inputmode="numeric"></label>
            <label>Max $/wk<input type="number" min="0" step="25" id="rf-priceMax" inputmode="numeric"></label>
            <label>Min beds<input type="number" min="0" max="9" id="rf-bedsMin" inputmode="numeric"></label>
            <label>Min baths<input type="number" min="0" max="9" id="rf-bathsMin" inputmode="numeric"></label>
            <label>Min cars<input type="number" min="0" max="9" id="rf-carsMin" inputmode="numeric"></label>
            <label>Type<select id="rf-type"><option value="">Any</option></select></label>
          </div>
          <label>Keywords<input type="text" id="rf-keyword" placeholder='eg pool -studio "north facing"'></label>
          <label>Inspection on<input type="date" id="rf-inspectOn"></label>
          <label class="rf-check"><input type="checkbox" id="rf-hideNoImage">Hide listings without a photo</label>
          <label class="rf-check"><input type="checkbox" id="rf-annotate">Show availability on REA's result cards</label>
          <label class="rf-check"><input type="checkbox" id="rf-dimCards">Fade REA cards that don't match filters</label>
        </details>
        <div class="rf-row">
          <label class="rf-check"><input type="checkbox" id="rf-exact">Hide surrounding suburbs</label>
          <label class="rf-sort">Sort<select id="rf-sort">
            <option value="avail">Available date</option>
            <option value="price">Price</option>
            <option value="ppb">Price per bed</option>
            <option value="beds">Most beds</option>
            <option value="inspect">Next inspection</option>
            <option value="listed">Newest listed</option>
          </select></label>
        </div>
        <div class="rf-actions">
          <button class="rf-btn" id="rf-run">Search all pages</button>
          <button class="rf-btn sec" id="rf-refresh" title="Ignore cached results and refetch" hidden>Refresh</button>
        </div>
        <div class="rf-actions rf-exports">
          <span class="rf-label">Export</span>
          <button class="rf-btn sec" data-export="csv" disabled>CSV</button>
          <button class="rf-btn sec" data-export="tsv" disabled>TSV</button>
          <button class="rf-btn sec" data-export="copy" disabled title="Copy as TSV - pastes into Sheets/Excel">Copy</button>
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
      refresh: panel.querySelector('#rf-refresh'),
      exports: [...panel.querySelectorAll('[data-export]')],
      status: panel.querySelector('.rf-status'),
      list: panel.querySelector('.rf-list'),
    };

    // Inputs map 1:1 to cfg keys via their id (rf-<key>); exactOnly keeps its legacy id.
    const fields = Object.keys(DEFAULT_CFG).map((k) => [k, panel.querySelector(`#rf-${k === 'exactOnly' ? 'exact' : k}`)]);
    const read = (el) => (el.type === 'checkbox' ? el.checked : el.value);
    const write = (el, v) => { if (el.type === 'checkbox') el.checked = !!v; else el.value = v ?? ''; };
    for (const [k, el] of fields) write(el, cfg[k]);
    ui.fields = fields;
    ui.type = panel.querySelector('#rf-type');
    ui.annotateBox = panel.querySelector('#rf-annotate');
    ui.more = panel.querySelector('#rf-more');
    ui.more.open = ['priceMin', 'priceMax', 'bedsMin', 'bathsMin', 'carsMin', 'type', 'keyword', 'hideNoImage', 'inspectOn']
      .some((k) => cfg[k] && cfg[k] !== DEFAULT_CFG[k]);

    launch.addEventListener('click', () => { panel.hidden = false; ui.run.focus(); });
    panel.querySelector('.rf-x').addEventListener('click', () => { panel.hidden = true; });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !panel.hidden) { panel.hidden = true; launch.focus(); }
    });
    panel.querySelector('.rf-clear').addEventListener('click', () => {
      // Resets filters only; display preferences (sort, annotate, dim) are kept.
      const keep = { sort: cfg.sort, annotate: cfg.annotate, dimCards: cfg.dimCards };
      for (const [k, el] of fields) write(el, k in keep ? keep[k] : DEFAULT_CFG[k]);
      onChange();
    });

    let t;
    const onChange = (e) => {
      cfg = Object.fromEntries(fields.map(([k, el]) => [k, read(el)]));
      saveCfg(cfg);
      clearTimeout(t);
      scheduleAnnotate();
      if (e?.target === ui.annotateBox && cfg.annotate) ensureVisiblePage();
      if (!cache) return;
      if (e?.type === 'input') t = setTimeout(showResults, 200); // debounce typing
      else showResults(); // re-filter without refetching
    };
    for (const [, el] of fields) {
      el.addEventListener('change', onChange);
      if (el.type === 'text' || el.type === 'number') el.addEventListener('input', onChange);
    }

    ui.run.addEventListener('click', () => run());
    ui.refresh.addEventListener('click', () => run(true));
    for (const b of ui.exports) {
      b.addEventListener('click', async () => {
        if (!cache) return;
        const rows = applyFilters(cache, cfg);
        if (b.dataset.export === 'csv') downloadCsv(rows);
        else if (b.dataset.export === 'tsv') downloadTsv(rows);
        else {
          try { await navigator.clipboard.writeText(toTsv(rows)); setStatus(`Copied ${rows.length} rows.`); }
          catch { setStatus('Clipboard blocked - use TSV download instead.', true); }
        }
      });
    }
  }

  const setExport = (disabled) => { for (const b of ui.exports) b.disabled = disabled; };

  const setStatus = (msg, isErr) => {
    ui.status.textContent = msg;
    ui.status.classList.toggle('err', !!isErr);
  };

  function showResults(note = '') {
    const rows = applyFilters(cache, cfg);
    render(rows);
    setStatus(`${rows.length} of ${cache.length} listings match.` +
      (truncated ? ` Only the first ${MAX_PAGES} pages were read - narrow the search for full coverage.` : '') +
      (note ? ` ${note}` : ''));
    const warn = schemaWarnings(cache);
    if (warn.length) setStatus(`REA's data format may have changed (${warn.join('; ')}). Run reaFilter.probe() in the console and report the output.`, true);
  }

  function render(rows) {
    setExport(rows.length === 0);
    ui.launch.textContent = `Availability filter (${rows.length})`;
    if (!rows.length) {
      ui.list.innerHTML = '<div class="rf-empty">Nothing matches those filters.</div>';
      return;
    }
    ui.list.innerHTML = rows.map((r) => `
      <a class="rf-card" href="${esc(r.url)}" target="_blank" rel="noopener">
        ${r.img ? `<img src="${esc(r.img)}" alt="" loading="lazy">` : '<div></div>'}
        <div>
          <div class="rf-avail">${esc(r.available)}${r.surrounding ? '<span class="rf-tag">nearby</span>' : ''}</div>
          <div class="rf-price">${esc(r.price)}${r.type ? ` <span class="rf-type">${esc(r.type)}</span>` : ''}</div>
          <div class="rf-addr">${esc(r.address)}</div>
          <div class="rf-meta">${esc([
            r.beds !== '' ? `${r.beds} bed` : '',
            r.baths !== '' ? `${r.baths} bath` : '',
            r.cars !== '' ? `${r.cars} car` : '',
            r.bond ? `bond ${r.bond}` : '',
            +r.beds > 1 && isFinite(r.ppb) ? `$${r.ppb}/bed` : '',
          ].filter(Boolean).join(' · '))}</div>
          ${r.inspections?.length || r.listed ? `<div class="rf-meta">${esc([
            r.inspections?.length ? `Inspect ${r.inspections[0].label}${r.inspections.length > 1 ? ` +${r.inspections.length - 1}` : ''}` : '',
            r.listed ? `Listed ${ago(Date.now() - r.listed)}` : '',
          ].filter(Boolean).join(' · '))}</div>` : ''}
        </div>
      </a>`).join('');
    ui.list.scrollTop = 0;
  }

  const ago = (ms) => {
    const m = Math.round(ms / 60e3);
    return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
  };

  function fillTypes(rows) {
    const types = [...new Set(rows.map((r) => r.type).filter(Boolean))].sort();
    if (cfg.type && !types.includes(cfg.type)) types.unshift(cfg.type);
    ui.type.innerHTML = '<option value="">Any</option>' +
      types.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
    ui.type.value = cfg.type;
  }

  function adopt(key, rows, trunc, note) {
    learn(rows);
    scheduleAnnotate();
    fillTypes(rows);
    cache = rows;
    truncated = trunc;
    cacheKey = key;
    ui.refresh.hidden = false;
    showResults(note);
  }

  // Restore rows for the current search from the session cache, if fresh. Returns hit.
  function restore() {
    const key = searchKey(location.href);
    const hit = store.get(key);
    if (hit) adopt(key, hit.rows, hit.truncated, `Cached ${ago(Date.now() - hit.at)}.`);
    return !!hit;
  }

  async function run(force = false) {
    if (!force && restore()) return;
    const id = ++runId;
    const base = location.href;
    const key = searchKey(base);
    ui.run.disabled = ui.refresh.disabled = true;
    setExport(true);
    try {
      if (force) pageMemo.clear();
      const onProgress = (m) => { if (id === runId) setStatus(m); };
      const res = await fetchAllPages(base, onProgress, {
        seed: boot,
        getPage: (url) => getPage(url, { onRetry: (n, ms) => onProgress(`Retrying in ${Math.round(ms / 1000)}s (attempt ${n}/${RETRIES})…`) }),
      });
      if (id !== runId) return; // search changed mid-run; navigation handler already reported it
      if (res.sample) rawSample = res.sample;
      store.set(key, res.rows, res.truncated);
      adopt(key, res.rows, res.truncated);
    } catch (err) {
      if (id !== runId) return;
      cache = null;
      setStatus(err.message, true);
      ui.list.innerHTML = '<div class="rf-empty">Search failed.</div>';
    } finally {
      if (id === runId) ui.run.disabled = ui.refresh.disabled = false;
    }
  }

  // ------------------------------------------------------------ annotate
  // Adds a badge to REA's own result cards. Append-only (never reorders or removes
  // React-owned nodes) and idempotent, so the MutationObserver can't feed back on itself.

  const known = new Map(); // listing id -> row, from any source
  // pageUrl -> Promise<results>; shared by annotation and full searches so a page is
  // fetched once. Failures are evicted so they can be retried.
  const pageMemo = new Map();
  const getPage = (url, opts) => {
    if (!pageMemo.has(url)) {
      pageMemo.set(url, fetchResults(url, opts).catch((e) => { pageMemo.delete(url); throw e; }));
      if (pageMemo.size > 40) pageMemo.delete(pageMemo.keys().next().value);
    }
    return pageMemo.get(url);
  };
  const learn = (rows) => { for (const r of rows) if (r.id) known.set(r.id, r); };
  const rowsOf = (results) => [
    ...(results.exact?.items || []).filter((i) => i.listing).map((i) => toRow(i.listing, false)),
    ...(results.surrounding?.items || []).filter((i) => i.listing).map((i) => toRow(i.listing, true)),
  ];

  const badgeHtml = (r) => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const avail = r.avail
      ? r.avail <= today ? '<span class="rf-b-now">Available now</span>' : `<span>Avail ${esc(r.available.replace(/^(from\s+)/i, ''))}</span>`
      : '<span class="rf-b-none">No date</span>';
    const insp = r.nextInspect ? `<span>Insp ${esc(fmtWhen(r.nextInspect))}</span>` : '';
    const ppb = +r.beds > 1 && isFinite(r.ppb) ? `<span>$${r.ppb}/bed</span>` : '';
    return avail + insp + ppb;
  };

  const filtersActive = () => ['from', 'to', 'priceMin', 'priceMax', 'bedsMin', 'bathsMin', 'carsMin', 'type', 'keyword', 'inspectOn']
    .some((k) => cfg[k]) || cfg.hideNoImage || cfg.exactOnly;

  function annotate() {
    const matches = cfg.dimCards && filtersActive()
      ? new Set(applyFilters([...known.values()], cfg).map((r) => r.id)) : null;
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
      if (a.closest('#rf-panel')) continue;
      const id = listingId(a.getAttribute('href'));
      const card = id && a.closest('article');
      if (!card || seen.has(card)) continue;
      seen.add(card);
      const r = known.get(id);
      let badge = card.querySelector(':scope > .rf-badge');
      if (!cfg.annotate || !r) {
        if (badge) badge.remove();
        if (card.dataset.rfMatch) delete card.dataset.rfMatch;
        continue;
      }
      if (card.dataset.rfId !== id) card.dataset.rfId = id;
      const html = badgeHtml(r);
      if (!badge) { badge = document.createElement('div'); badge.className = 'rf-badge'; card.appendChild(badge); }
      if (badge.innerHTML !== html) badge.innerHTML = html;
      const m = matches ? (matches.has(id) ? '1' : '0') : '';
      if ((card.dataset.rfMatch || '') !== m) { if (m) card.dataset.rfMatch = m; else delete card.dataset.rfMatch; }
    }
  }

  let annotateTimer;
  const scheduleAnnotate = () => { clearTimeout(annotateTimer); annotateTimer = setTimeout(annotate, 120); };

  // Make sure the page currently on screen has rows: session cache, boot doc, or one fetch.
  async function ensureVisiblePage() {
    if (!cfg.annotate) return;
    const href = location.href;
    const key = searchKey(href), n = pageNum(href);
    if (cacheKey === key && cache) return scheduleAnnotate();
    if (boot && boot.key === key && boot.page === n) return scheduleAnnotate();
    try { learn(rowsOf(await getPage(pageUrl(href, n)))); } catch { return; }
    if (location.href === href) scheduleAnnotate();
  }

  function watchCards() {
    new MutationObserver((muts) => {
      // Ignore mutations confined to our own badges/panel.
      if (muts.every((m) => m.target.closest?.('.rf-badge, #rf-panel') || [...m.addedNodes].every((n) => n.classList?.contains('rf-badge')) && m.removedNodes.length === 0)) return;
      scheduleAnnotate();
    }).observe(document.body, { childList: true, subtree: true });
  }

  // REA is an SPA - invalidate cached rows (and any in-flight run) when the search URL changes.
  function watchNavigation() {
    let lastKey = searchKey(location.href);
    const fire = () => window.dispatchEvent(new Event('rf:navigate'));
    for (const fn of ['pushState', 'replaceState']) {
      const orig = history[fn];
      history[fn] = function (...args) { const r = orig.apply(this, args); fire(); return r; };
    }
    window.addEventListener('popstate', fire);
    window.addEventListener('rf:navigate', () => {
      setTimeout(ensureVisiblePage, 400); // let REA render the new page first
      const key = searchKey(location.href);
      if (key === lastKey) return; // same search, different page/view
      lastKey = key;
      if (cacheKey === key) return;
      const hadState = cacheKey || ui.run.disabled;
      runId++;
      cache = null;
      cacheKey = null;
      ui.run.disabled = ui.refresh.disabled = false;
      ui.refresh.hidden = true;
      setExport(true);
      if (restore() || !hadState) return;
      ui.list.innerHTML = '<div class="rf-empty">Search changed.</div>';
      ui.launch.textContent = 'Availability filter';
      setStatus('Search changed - run again to refresh.');
    });
  }

  // Console helpers: reaFilter.probe() shows which listing fields exist in live data.
  window.reaFilter = {
    version: (typeof GM_info !== 'undefined' && GM_info.script?.version) || 'dev',
    rows: () => cache,
    filtered: () => (cache ? applyFilters(cache, cfg) : null),
    cfg: () => ({ ...cfg }),
    probe: () => {
      if (!rawSample) return 'No listing seen yet - load a results page or run a search.';
      const out = probe(rawSample);
      console.table(out);
      console.log('Top-level listing keys:', Object.keys(rawSample).sort().join(', '));
      return out;
    },
    raw: () => rawSample,
  };

  build();
  if (boot) learn(rowsOf(boot.results));
  watchNavigation();
  watchCards();
  restore();
  ensureVisiblePage();
})();

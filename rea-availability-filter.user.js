// ==UserScript==
// @name         REA Availability Filter
// @namespace    https://github.com/cpwillis/rea-enhancement
// @version      2.5.0
// @description  Availability-date filtering and sorting, extra filters, cross-page merging, on-card availability badges and CSV/TSV export for realestate.com.au rental searches.
// @author       cpwillis
// @homepageURL  https://github.com/cpwillis/rea-enhancement
// @supportURL   https://github.com/cpwillis/rea-enhancement/issues
// @license      MIT
// @updateURL    https://raw.githubusercontent.com/cpwillis/rea-enhancement/main/rea-availability-filter.user.js
// @downloadURL  https://raw.githubusercontent.com/cpwillis/rea-enhancement/main/rea-availability-filter.user.js
// @match        https://www.realestate.com.au/*
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
 * Loads on every REA page because REA can reach /rent/ via client-side navigation;
 * the UI only activates on /rent/ search pages.
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
  const RETRY_AFTER_MAX_S = 60;
  const FETCH_TIMEOUT_MS = 20000;
  const ANNOTATE_DEBOUNCE_MS = 120;
  const ANNOTATE_MAX_WAIT_MS = 500;
  const KNOWN_MAX = 2000;
  const RENDER_CHUNK = 100;
  const COMPARE_MAX = 6;
  const PAGE_MEMO_MAX = 12; // raw REA page results are large (~0.3-1MB parsed); keep a few
  const ROWS_PREFIX = 'rea-avail-filter/rows/';
  const ROWS_VERSION = 7; // bump when toRow() shape changes
  const ROW_DATES = ['avail', 'nextInspect', 'listed'];
  const ROWS_TTL_MS = 10 * 60 * 1000;
  const ROWS_KEEP = 2; // searches kept in sessionStorage
  const MARKS_KEY = 'rea-avail-filter/marks/v1';
  const MARKS_MAX = 5000;
  const HOUR_MS = 36e5;
  const DAY_MS = 864e5;
  const MARKS_TTL_MS = 90 * DAY_MS; // unstarred, unhidden listings forgotten after 90 days unseen
  const PRICE_CHANGE_MS = 14 * DAY_MS; // "was $X" shown for two weeks after a change
  const NEW_MS = 48 * HOUR_MS; // a listing REA dates within 48h counts as new even without a baseline
  const ROWS_TEXT_MAX = 600;
  const SNAP_KEY = 'rea-avail-filter/snapshots/v1';
  const SNAP_MAX = 3; // searches remembered across sessions (localStorage is shared with REA)
  const SNAP_VISIT_GAP_MS = HOUR_MS; // runs closer together than this count as one visit
  const SNAP_TEXT_MAX = 300; // per-field text cap in remembered rows (sessionStorage rows: ROWS_TEXT_MAX)
  const GONE_MAX = 200; // no-longer-listed rows kept per search
  const IMPORT_ROWS_MAX = 1000; // rows accepted per search from a backup
  const SEARCH_KEY_MAX = 2000; // longest search URL accepted from a backup
  const YEARLESS_ROLL_MS = 60 * DAY_MS; // "3 Jan" more than this far in the past means next year
  const INSPECT_GRACE_MS = HOUR_MS; // an inspection that started this recently is still shown
  const BACKUP_MAX_BYTES = 5e6;
  const INPUT_DEBOUNCE_MS = 200;
  const NAV_SETTLE_MS = 400; // wait for REA to render after client-side navigation
  const REVOKE_MS = 5000; // keep a download's object URL alive this long
  const NARROW_MQ = '(max-width: 480px)'; // phones: drawer is full-screen (keep in sync with the CSS)

  // ---------------------------------------------------------------- config

  const loadCfg = () => {
    try { return sanitizeCfg(JSON.parse(localStorage.getItem(CFG_KEY))); } catch { return {}; }
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
    // sessionStorage (~5MB) is shared with REA's own code, so keep it small: at most
    // ROWS_KEEP searches, and the keyword blob truncated (full text stays in memory).
    set(key, rows, truncated) {
      const slim = rows.map((r) => (r.text?.length > ROWS_TEXT_MAX ? { ...r, text: r.text.slice(0, ROWS_TEXT_MAX) } : r));
      const put = () => storage.setItem(ROWS_PREFIX + key, JSON.stringify({ v: ROWS_VERSION, at: now(), truncated, rows: slim }));
      const ours = () => {
        const out = [];
        for (let i = 0; i < storage.length; i++) {
          const k = storage.key(i);
          if (k?.startsWith(ROWS_PREFIX) && k !== ROWS_PREFIX + key) {
            let at = 0;
            try { at = JSON.parse(storage.getItem(k)).at || 0; } catch { /* corrupt: evict first */ }
            out.push([k, at]);
          }
        }
        return out.sort((a, b) => b[1] - a[1]); // newest first
      };
      try {
        ours().forEach(([k, at], i) => { if (i >= ROWS_KEEP - 1 || now() - at > ROWS_TTL_MS) storage.removeItem(k); });
        put();
      } catch {
        try { // quota: drop every other cached search and retry once
          for (const [k] of ours()) storage.removeItem(k);
          put();
        } catch { /* unavailable */ }
      }
    },
  });

  // Per-listing memory in localStorage, keyed by listing id: s=shortlisted (st=when),
  // h=hidden, n=note, d=summary kept for shortlisted listings so the shortlist works
  // across searches, f=first seen, l=last seen, p/ps=last weekly price and its display,
  // pp/pps=previous, pt=when it changed, ph=[[at, display]] price history (newest last),
  // as/ast=application status and when it was set, rl=id this listing relists.
  // data.ad maps addressKey -> latest listing id there (relist detection); data.ag = hidden agencies.
  const NOTE_MAX = 500;
  const ADVANCE_WEEKS = 2; // rent usually paid in advance at signing
  const BOND_CAP_WEEKS = 4; // typical state cap on bond for standard rents; above it is flagged, not filtered
  const INSPECT_KEEP = 3; // inspections kept per stored row
  const isListingId = (v) => /^\d{1,15}$/.test(String(v));
  // Studios report 0 beds: price per bed is then the full price.
  // Money needed to move in: bond + ADVANCE_WEEKS of rent. bondWeeks = bond in weeks of rent.
  const moveIn = (bondDisplay, priceNum) => {
    const m = String(bondDisplay || '').replace(/,/g, '').match(/\$\s*(\d+(?:\.\d+)?)/);
    const bondNum = m ? +m[1] : Infinity;
    const ok = isFinite(bondNum) && isFinite(priceNum) && priceNum > 0;
    return {
      bondNum,
      upfront: ok ? Math.round(bondNum + ADVANCE_WEEKS * priceNum) : Infinity,
      bondWeeks: ok ? Math.round((bondNum / priceNum) * 10) / 10 : null,
    };
  };
  const perBed = (priceNum, beds) => (isFinite(priceNum) ? Math.round(priceNum / Math.max(1, +beds || 0)) : Infinity);
  const cleanInspections = (a) => (Array.isArray(a) ? a : []).slice(0, INSPECT_KEEP)
    .map((i) => ({ at: typeof i?.at === 'number' ? i.at : null, label: clip(i?.label, 80) }));
  const clip = (v, n = 300) => (typeof v === 'string' ? v.slice(0, n) : '');
  const summary = (r) => ({
    u: safeUrl(r.url), a: clip(r.address), p: clip(r.price, 80), v: clip(r.available, 80), i: safeUrl(r.img),
    t: clip(r.type, 40), b: scalar(r.beds), ba: scalar(r.baths), c: scalar(r.cars), su: clip(r.suburb, 80),
    in: cleanInspections(r.inspections),
    bo: clip(r.bond, 40), la: typeof r.lat === 'number' ? r.lat : null, ln: typeof r.lng === 'number' ? r.lng : null,
    am: AMENITIES.filter((a) => r.amen?.[a.id] === 'yes').map((a) => a.id), ag: clip(r.agency, 80),
  });
  const APP_STATUSES = ['', 'to inspect', 'inspected', 'applied', 'approved', 'declined'];
  const keep = (e) => e.s || e.h || e.n || e.as;
  // Address identity for relist detection: needs a street number, ignores case/punctuation.
  const addressKey = (a) => {
    const k = String(a || '').toLowerCase().replace(/[^a-z0-9/]+/g, ' ').replace(/\s+/g, ' ').trim();
    return /\d/.test(k) && k.length > 6 ? k : '';
  };
  const PRICE_HISTORY_MAX = 10;
  const RELIST_GAP_MS = HOUR_MS; // old listing unseen at least this long before a same-address one counts as a relist
  const agencyKey = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  // Stored summary <-> row-shaped fields (one mapping for import, shortlist and summary()).
  const fromSummary = (d) => ({
    url: d.u, address: d.a, price: d.p, available: d.v, img: d.i, type: d.t, beds: d.b, baths: d.ba, cars: d.c, suburb: d.su,
    inspections: d.in, bond: d.bo, lat: typeof d.la === 'number' ? d.la : null, lng: typeof d.ln === 'number' ? d.ln : null, agency: d.ag,
    amen: Array.isArray(d.am) ? Object.fromEntries(AMENITIES.map((a) => [a.id, d.am.includes(a.id) ? 'yes' : null])) : {},
  });
  const marksStore = (storage, now = () => Date.now()) => {
    let data = null;
    const load = () => {
      if (data) return data;
      try { data = JSON.parse(storage.getItem(MARKS_KEY)); } catch { data = null; }
      if (!data || typeof data !== 'object' || !data.m || typeof data.m !== 'object' || Array.isArray(data.m)) data = { c: now(), m: {} };
      return data;
    };
    // Writes re-read storage first so another tab's changes aren't overwritten by this
    // tab's stale in-memory copy (last writer wins per call, not per page lifetime).
    const fresh = () => { data = null; return load(); };
    const prune = () => {
      const { m } = data;
      for (const [id, e] of Object.entries(m)) if (!keep(e) && now() - (e.l || e.f || 0) > MARKS_TTL_MS) delete m[id];
      if (data.ad) for (const [k, id] of Object.entries(data.ad)) if (!m[id]) delete data.ad[k];
      const ids = Object.keys(m);
      if (ids.length > MARKS_MAX) {
        ids.filter((id) => !keep(m[id])).sort((a, b) => (m[a].l || 0) - (m[b].l || 0))
          .slice(0, ids.length - MARKS_MAX).forEach((id) => delete m[id]);
      }
    };
    const save = () => { try { prune(); storage.setItem(MARKS_KEY, JSON.stringify(data)); } catch { /* quota/blocked */ } };
    const entry = (m, id) => m[id] || (m[id] = { f: now(), l: now() });
    return {
      invalidate() { data = null; },
      observe(rows) {
        const { m } = fresh();
        const t = now();
        const batch = new Set(rows.map((r) => r.id));
        for (const r of rows) {
          if (!r.id) continue;
          const e = m[r.id] || (m[r.id] = { f: t });
          e.l = t;
          if (e.s) e.d = summary(r); // keep the shortlist's copy current
          if (isFinite(r.priceNum)) {
            if (e.p != null && e.p !== r.priceNum) { e.pp = e.p; e.pps = e.ps; e.pt = t; }
            if (e.p !== r.priceNum) e.ph = [...(Array.isArray(e.ph) ? e.ph : []), [t, clip(r.price, 80)]].slice(-PRICE_HISTORY_MAX);
            e.p = r.priceNum;
            e.ps = r.price;
          }
          // Same address under a new id = relisted: remember which listing it replaces.
          const ak = addressKey(r.address);
          if (ak) {
            const d = data;
            d.ad = d.ad && typeof d.ad === 'object' ? d.ad : {};
            const prev = d.ad[ak];
            // Only a relist if the old listing has stopped appearing: two live listings at one
            // address (units listed without a unit number) are different places.
            if (prev && prev !== r.id && m[prev] && !e.rl && !batch.has(prev) && t - (m[prev].l || 0) > RELIST_GAP_MS) e.rl = prev;
            d.ad[ak] = r.id;
          }
        }
        save();
      },
      decorate(rows) {
        const { m } = load();
        const t = now();
        for (const r of rows) {
          const e = m[r.id];
          const was = e?.rl ? m[e.rl] : null; // the listing this one relists, if any
          r.starred = !!e?.s;
          r.hidden = !!e?.h || !!(was?.h && !e?.s); // ruled out before: stays out when relisted
          r.relisted = was ? { price: was.ps || '', hidden: !!was.h } : null;
          r.priceHistory = Array.isArray(e?.ph) ? e.ph : [];
          r.note = e?.n || '';
          r.appStatus = e?.as || '';
          r.agencyHidden = !!(r.agency && load().ag?.[agencyKey(r.agency)]);
          r.firstSeen = e?.f ? new Date(e.f) : null;
          // "New" is per search (see snapshotStore); here only REA's own listed date counts.
          r.isNew = r.listed instanceof Date && t - r.listed < NEW_MS;
          r.prevPrice = e && e.pp != null && e.pp !== e.p && e.pt && t - e.pt < PRICE_CHANGE_MS ? e.pps || `$${e.pp}` : '';
          r.priceDelta = r.prevPrice ? e.p - e.pp : 0;
        }
        return rows;
      },
      // `row` lets a newly shortlisted listing carry its summary for the cross-search view.
      toggle(id, k, row) {
        const { m } = fresh();
        const e = entry(m, id);
        e[k] = e[k] ? 0 : 1;
        if (k === 's') {
          if (e.s) { e.st = now(); if (row) e.d = summary(row); } else { delete e.st; }
        }
        save();
        return !!e[k];
      },
      note: (id) => load().m[id]?.n || '',
      setStatus(id, status) {
        if (!APP_STATUSES.includes(status)) return;
        const { m } = fresh();
        const e = entry(m, id);
        if (status) { e.as = status; e.ast = now(); } else { delete e.as; delete e.ast; }
        save();
      },
      setNote(id, text) {
        const { m } = fresh();
        const e = entry(m, id);
        const n = clip(String(text ?? '').trim(), NOTE_MAX);
        if (n) e.n = n; else delete e.n;
        save();
      },
      // Shortlisted listings from every search, newest-starred first, as drawer rows.
      shortlist() {
        const { m } = load();
        return Object.entries(m).filter(([, e]) => e.s && e.d?.u)
          .sort(([, a], [, b]) => (b.st || 0) - (a.st || 0))
          .map(([id, e]) => {
            const d = e.d, priceNum = parsePrice(d.p);
            return {
              ...fromSummary(d), id, suburb: d.su || '', priceNum, available: d.v || '-', avail: parseAvail(d.v),
              beds: d.b ?? '', baths: d.ba ?? '', cars: d.c ?? '', bond: d.bo || '', ppb: perBed(priceNum, d.b),
              ...moveIn(d.bo, priceNum), agency: d.ag || '',
              starred: true, hidden: !!e.h, note: e.n || '', appStatus: e.as || '', listed: null,
              inspections: cleanInspections(d.in).filter((i) => i.label && (i.at == null || i.at >= now() - INSPECT_GRACE_MS)),
            };
          });
      },
      // Backup/restore of what the user chose (shortlist, hidden, notes); sighting history is not exported.
      exportData() {
        const { m } = load();
        const out = {};
        for (const [id, e] of Object.entries(m)) {
          if (keep(e)) out[id] = { s: e.s ? 1 : undefined, st: e.st, h: e.h ? 1 : undefined, n: e.n, as: e.as, ast: e.ast, d: e.s ? e.d : undefined };
        }
        return { app: 'rea-enhancement', kind: 'marks', v: 1, exported: new Date(now()).toISOString(), m: out, ag: load().ag || {} };
      },
      exportJson() { return JSON.stringify(this.exportData(), null, 1); },
      // Merges a backup: imported choices win per listing. Untrusted input: ids and
      // fields are validated and strings clipped; URLs pass through safeUrl.
      importJson(input) {
        let src = input;
        if (typeof input === 'string') { try { src = JSON.parse(input); } catch { throw new Error('Not a JSON file.'); } }
        if (src?.app !== 'rea-enhancement' || src?.kind !== 'marks' || typeof src.m !== 'object' || !src.m) throw new Error('Not an rea-enhancement backup.');
        const { m } = fresh();
        let n = 0;
        for (const [id, e] of Object.entries(src.m)) {
          if (!isListingId(id) || !e || typeof e !== 'object') continue;
          const cur = entry(m, id);
          if (e.s) { cur.s = 1; cur.st = +e.st || now(); if (e.d && typeof e.d === 'object') cur.d = summary(fromSummary(e.d)); }
          if (e.h) cur.h = 1;
          if (typeof e.n === 'string' && e.n.trim()) cur.n = clip(e.n.trim(), NOTE_MAX);
          if (APP_STATUSES.includes(e.as) && e.as) { cur.as = e.as; cur.ast = +e.ast || now(); }
          n++;
        }
        if (src.ag && typeof src.ag === 'object') {
          const d = load();
          d.ag = d.ag && typeof d.ag === 'object' ? d.ag : {};
          for (const name of Object.values(src.ag)) if (typeof name === 'string' && agencyKey(name)) d.ag[agencyKey(name)] = clip(name, 80);
        }
        save();
        return n;
      },
      counts() {
        const { m } = load();
        const v = Object.values(m);
        return { starred: v.filter((e) => e.s).length, hidden: v.filter((e) => e.h).length, notes: v.filter((e) => e.n).length };
      },
      // Hidden agencies live beside the per-listing marks: data.ag = { normalisedName: displayName }.
      toggleAgency(name) {
        const k = agencyKey(name);
        if (!k) return false;
        const d = fresh();
        d.ag = d.ag && typeof d.ag === 'object' ? d.ag : {};
        if (d.ag[k]) delete d.ag[k]; else d.ag[k] = clip(name, 80);
        save();
        return !!d.ag[k];
      },
      hiddenAgencies: () => Object.values(load().ag || {}),
    };
  };

  // Remembered results per search, across sessions. Each save diffs against a baseline:
  // the previous *visit's* ids (runs within SNAP_VISIT_GAP_MS of each other share one
  // baseline, so refreshing twice doesn't wipe the "new" tags). `gone` = baseline rows no
  // longer listed.
  const SNAP_FIELDS = ['id', 'url', 'address', 'suburb', 'price', 'priceNum', 'ppb', 'available', 'bond', 'beds', 'baths',
    'cars', 'type', 'img', 'surrounding', 'inspect', 'agency', 'lat', 'lng', 'photos', 'floorplan'];
  const slimRow = (r) => {
    const o = {};
    for (const k of SNAP_FIELDS) o[k] = typeof r[k] === 'string' ? clip(r[k], SNAP_TEXT_MAX) : r[k];
    for (const k of ROW_DATES) o[k] = r[k] instanceof Date && !isNaN(r[k]) ? r[k].getTime() : null;
    o.headline = clip(r.headline, 160);
    o.text = clip(r.text, SNAP_TEXT_MAX);
    o.inspections = cleanInspections(r.inspections);
    o.features = (Array.isArray(r.features) ? r.features : []).slice(0, 40).map((f) => clip(f, 80));
    return o;
  };
  // Also the sanitiser for imported snapshots: every field re-typed, URLs re-checked.
  const fatRow = (o) => {
    const r = {};
    for (const k of SNAP_FIELDS) r[k] = typeof o?.[k] === 'string' ? clip(o[k], SNAP_TEXT_MAX) : typeof o?.[k] === 'number' || typeof o?.[k] === 'boolean' ? o[k] : '';
    for (const k of ROW_DATES) r[k] = typeof o?.[k] === 'number' ? new Date(o[k]) : null;
    r.url = safeUrl(r.url);
    r.img = safeUrl(r.img);
    r.id = isListingId(o?.id) ? String(o.id) : listingId(r.url);
    r.priceNum = typeof o?.priceNum === 'number' ? o.priceNum : parsePrice(r.price);
    r.ppb = typeof o?.ppb === 'number' ? o.ppb : perBed(r.priceNum, r.beds);
    Object.assign(r, moveIn(r.bond, r.priceNum));
    r.surrounding = !!o?.surrounding;
    r.headline = clip(o?.headline, 160);
    r.text = clip(o?.text, SNAP_TEXT_MAX).toLowerCase();
    r.inspections = cleanInspections(o?.inspections).filter((i) => i.label);
    r.features = (Array.isArray(o?.features) ? o.features : []).filter((f) => typeof f === 'string').slice(0, 40).map((f) => clip(f, 80));
    r.lat = typeof o?.lat === 'number' ? o.lat : null;
    r.lng = typeof o?.lng === 'number' ? o.lng : null;
    r.photos = typeof o?.photos === 'number' ? o.photos : null;
    r.floorplan = typeof o?.floorplan === 'boolean' ? o.floorplan : null;
    r.amen = amenitiesOf({ features: r.features, amenText: r.address ? r.text.replace(r.address.toLowerCase(), ' ') : r.text });
    return r;
  };
  const isSearchKey = (k) => typeof k === 'string' && k.startsWith('https://www.realestate.com.au/rent/') && k.length < SEARCH_KEY_MAX;

  const snapshotStore = (storage, now = () => Date.now()) => {
    const load = () => {
      try {
        const d = JSON.parse(storage.getItem(SNAP_KEY));
        if (d && typeof d.s === 'object' && d.s) return d;
      } catch { /* corrupt */ }
      return { v: 1, s: {} };
    };
    // Newest SNAP_MAX kept; on quota, drop older searches, then the gone lists, then give up.
    const persist = (d) => {
      const keys = Object.keys(d.s).sort((a, b) => d.s[b].at - d.s[a].at);
      for (const k of keys.slice(SNAP_MAX)) delete d.s[k];
      for (let attempt = 0; attempt < 3; attempt++) {
        try { storage.setItem(SNAP_KEY, JSON.stringify(d)); return true; } catch {
          const ks = Object.keys(d.s).sort((a, b) => d.s[b].at - d.s[a].at);
          if (attempt === 0 && ks.length > 1) for (const k of ks.slice(1)) delete d.s[k];
          else for (const k of ks) d.s[k].gone = [];
        }
      }
      return false;
    };
    const newSince = (ids, baseIds) => {
      if (!baseIds) return new Set();
      const base = new Set(baseIds);
      return new Set((ids || []).filter((id) => !base.has(id)));
    };
    const view = (e) => ({
      at: e.at, baseAt: e.baseAt ?? null, truncated: !!e.truncated,
      rows: (e.rows || []).map(fatRow).filter((r) => r.url),
      gone: (e.gone || []).map(fatRow).filter((r) => r.url).map((r) => Object.assign(r, { gone: true })),
      newIds: newSince(e.ids, e.baseIds),
    });
    return {
      get(key) {
        const e = load().s[key];
        return e ? view(e) : null;
      },
      save(key, rows, truncated) {
        const d = load();
        const prev = d.s[key];
        const t = now();
        const ids = rows.map((r) => r.id).filter(Boolean);
        const cur = new Set(ids);
        let baseIds = null, baseAt = null, gone = [];
        if (prev && t - prev.at > SNAP_VISIT_GAP_MS) { // new visit: previous run is the baseline
          baseIds = prev.ids || []; baseAt = prev.at;
          gone = (prev.rows || []).filter((r) => !cur.has(String(r.id)));
        } else if (prev) { // same visit: keep its baseline
          baseIds = prev.baseIds || null; baseAt = prev.baseAt ?? null;
          gone = (prev.gone || []).filter((r) => !cur.has(String(r.id)));
          if (baseIds) { // rows that were in the baseline and have since dropped out this visit
            const seen = new Set(gone.map((r) => String(r.id)));
            const base = new Set(baseIds);
            for (const r of prev.rows || []) if (!cur.has(String(r.id)) && base.has(String(r.id)) && !seen.has(String(r.id))) gone.push(r);
          }
        }
        d.s[key] = { at: t, baseAt, baseIds, ids, truncated: !!truncated, rows: rows.map(slimRow), gone: gone.slice(0, GONE_MAX) };
        persist(d);
        return view(d.s[key]);
      },
      clear() { try { storage.removeItem(SNAP_KEY); } catch { /* blocked */ } },
      exportData: () => load().s,
      // Untrusted: keys must be REA rent search URLs; rows round-trip through fatRow/slimRow.
      importData(src) {
        if (!src || typeof src !== 'object') return 0;
        const d = load();
        let n = 0;
        const okIds = (a) => (Array.isArray(a) ? a.map(String).filter(isListingId) : null);
        for (const [k, e] of Object.entries(src)) {
          if (!isSearchKey(k) || !e || typeof e !== 'object' || typeof e.at !== 'number') continue;
          if (d.s[k] && d.s[k].at >= e.at) continue; // keep the newer copy
          const rows = (Array.isArray(e.rows) ? e.rows : []).slice(0, IMPORT_ROWS_MAX).map(fatRow).filter((r) => r.url);
          d.s[k] = {
            at: e.at, baseAt: typeof e.baseAt === 'number' ? e.baseAt : null, baseIds: okIds(e.baseIds),
            ids: rows.map((r) => r.id), truncated: !!e.truncated, rows: rows.map(slimRow),
            gone: (Array.isArray(e.gone) ? e.gone : []).slice(0, GONE_MAX).map(fatRow).filter((r) => r.url).map(slimRow),
          };
          n++;
        }
        persist(d);
        return n;
      },
    };
  };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const safeUrl = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : '');

  // ------------------------------------------------------------ extraction

  const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

  // "Available now" -> today, so it survives a from-date of today or earlier
  // and is correctly excluded by a future from-date.
  // Parsed by hand: Date() on "Mon 12th Oct" is engine-specific and, lacking a year,
  // Chrome yields 2001. A year-less date more than ~2 months past rolls to next year.
  // A date already past means "available now", so it is clamped to today and treated alike.
  const parseAvail = (display, now = new Date()) => {
    if (!display) return null;
    const today = startOfDay(now);
    const clamp = (d) => (d < today ? today : d);
    if (/\bnow\b/i.test(display)) return today;
    // AU numeric order: dd/mm/yyyy, dd-mm-yy
    const num = display.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})\b/);
    if (num) {
      const d = new Date(+num[3] < 100 ? 2000 + +num[3] : +num[3], +num[2] - 1, +num[1]);
      return isNaN(d) || d.getDate() !== +num[1] ? null : clamp(d);
    }
    // "12th Oct 2026", "1st of December", "October 12, 2026". Every candidate is tried so
    // words like "Available" (-> "ava") or weekdays don't shadow the real month.
    const cands = [
      ...[...display.matchAll(/(\d{1,2})(?:st|nd|rd|th)?(?:\s+of)?\s+([a-z]{3,})\.?(?:,?\s+(\d{4}))?/gi)].map((m) => [m[1], m[2], m[3]]),
      ...[...display.matchAll(/\b([a-z]{3,})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4}))?/gi)].map((m) => [m[2], m[1], m[3]]),
    ];
    for (const [day, word, yr] of cands) {
      const w = word.toLowerCase();
      const month = MONTH_NAMES.findIndex((n) => n.startsWith(w));
      if (month < 0) continue;
      let year = yr ? +yr : today.getFullYear();
      let d = new Date(year, month, +day);
      if (!yr && today - d > YEARLESS_ROLL_MS) d = new Date(++year, month, +day);
      if (d.getDate() !== +day) return null; // 31 Feb, 29 Feb in a non-leap year
      return clamp(d);
    }
    return null;
  };

  // Weekly rent as a number. Ranges take the lower bound; monthly/annual figures are
  // converted so mixed listings sort and filter on one scale. Unparseable -> Infinity.
  const parsePrice = (display) => {
    const s = (display || '').replace(/,/g, '');
    const m = s.match(/\$\s*(\d+(?:\.\d+)?)\s*(k\b)?/i);
    if (!m) return Infinity;
    let v = +m[1] * (m[2] ? 1000 : 1);
    // Period is read from the text after this figure, up to the next $ amount, so
    // "$800 pw / $3,466 pcm" and "$600 per week (a month free)" stay weekly.
    const tail = s.slice(m.index + m[0].length).split('$')[0];
    const weekly = /\b(pw|p\/w|per\s*week|weekly|a\s*week)\b|\/\s*w(ee)?k\b/i.test(tail);
    if (!weekly) {
      if (/\b(per\s*month|p\.?\s*c\.?\s*m|pcm|monthly|a\s*month)\b|\/\s*m(on)?th\b/i.test(tail)) v = (v * 12) / 52;
      else if (/\b(per\s*(annum|year)|p\.?\s*a\.?|pa|annually|a\s*year)\b|\/\s*y(ea)?r\b/i.test(tail)) v /= 52;
    }
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

  const PAGE_SEG = /\/(?:list|map)-(\d+)/; // results page segment, eg /list-3 or /map-1
  const pageUrl = (base, n) => {
    const u = new URL(base);
    u.hash = '';
    u.pathname = PAGE_SEG.test(u.pathname)
      ? u.pathname.replace(PAGE_SEG, `/list-${n}`)
      : u.pathname.replace(/\/?$/, `/list-${n}`);
    return u.href;
  };

  // Identity of a search regardless of which page / view is showing.
  const searchKey = (href) => pageUrl(href, 1);
  const isSearchPage = (href) => /^\/rent\/[^/]/.test(new URL(href).pathname);
  const pageNum = (href) => +(new URL(href).pathname.match(PAGE_SEG)?.[1] || 1);

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

  // Field discovery: when none of the known spellings exist, walk the listing (breadth-first,
  // bounded) for a key matching `keyRe` whose value passes `ok`. Returns { path, value } or
  // null. This keeps features working if REA renames a field, and reaFilter.probe() reports
  // where each one was found.
  const DISCOVER_DEPTH = 4;
  const DISCOVER_NODES = 3000;
  const discover = (obj, keyRe, ok = () => true) => {
    const queue = [[obj, '']];
    let seen = 0;
    while (queue.length && seen < DISCOVER_NODES) {
      const [node, path] = queue.shift();
      if (!node || typeof node !== 'object') continue;
      for (const [k, v] of Object.entries(node)) {
        seen++;
        const p = path ? `${path}.${k}` : k;
        if (keyRe.test(k) && ok(v)) return { path: p, value: v };
        if (v && typeof v === 'object' && p.split('.').length < DISCOVER_DEPTH) queue.push([v, p]);
      }
    }
    return null;
  };
  const found = {}; // field -> discovered path, for probe()
  const note = (field, hit) => { if (hit && !found[field]) found[field] = hit.path; return hit?.value; };

  const inspectionList = (src) => (Array.isArray(src) ? src : Array.isArray(src?.items) ? src.items : Array.isArray(src?.inspections) ? src.inspections : null);

  function extractInspections(listing, now = new Date()) {
    let src = listing.inspections ?? listing.inspectionTimes ?? listing.openHomes ?? listing.inspectionsAndAuctions?.inspections;
    if (!inspectionList(src)) src = note('inspections', discover(listing, /inspection|openhome|open_home/i, (v) => !!inspectionList(v)?.length));
    const list = inspectionList(src) || [];
    const cutoff = now.getTime() - INSPECT_GRACE_MS;
    return list
      .map((it) => {
        const at = toDate(it?.startTime ?? it?.startTimeUtc ?? it?.start ?? it?.dateTime ?? it?.startsAt);
        const label = str(it?.display?.shortLabel) || str(it?.display?.longLabel) || str(it?.display) || str(it?.label) || (at ? fmtWhen(at) : '');
        return { at: at ? at.getTime() : null, label };
      })
      .filter((i) => i.label && (i.at == null || i.at >= cutoff))
      .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
  }

  const LISTED_KEY = /^(date)?(first)?listed(at|date|on)?$|^listing(date|start)$|^datefirstlisted$/i;
  const extractListed = (listing) =>
    toDate(listing.dateListed ?? listing.listedDate ?? listing.listingDate ?? listing.dateFirstListed ?? listing.listedAt) ??
    toDate(note('listed', discover(listing, LISTED_KEY, (v) => !!toDate(v))));

  // Coordinates: an object holding lat + lng within Australia's bounding box.
  const LAT_KEYS = ['latitude', 'lat'];
  const LNG_KEYS = ['longitude', 'lng', 'lon', 'long'];
  const inAu = (lat, lng) => lat <= -9 && lat >= -45 && lng >= 110 && lng <= 155;
  const coordsOf = (o) => {
    if (!o || typeof o !== 'object') return null;
    const lat = +LAT_KEYS.map((k) => o[k]).find((v) => v != null && v !== '');
    const lng = +LNG_KEYS.map((k) => o[k]).find((v) => v != null && v !== '');
    return isFinite(lat) && isFinite(lng) && inAu(lat, lng) ? { lat, lng } : null;
  };
  const extractCoords = (listing) =>
    coordsOf(listing.address?.location) || coordsOf(listing.address) || coordsOf(listing.location) ||
    coordsOf(note('coords', discover(listing, /location|geo|coord|address/i, (v) => !!coordsOf(v)))) || null;

  // Agency name: listingCompany/agency objects, else any *agency*/*company* object with a name.
  const nameOf = (o) => str(o?.name) || str(o?.displayName) || str(o?.brandName) || (typeof o === 'string' ? o : '');
  const extractAgency = (listing) => clipText(
    nameOf(listing.listingCompany) || nameOf(listing.agency) || nameOf(listing.agencies?.[0]) ||
    nameOf(note('agency', discover(listing, /agenc|listingcompany|company|brand/i, (v) => !!nameOf(v)))), 80);

  // Feature labels (strings) from any features/amenities arrays.
  const featureLabel = (f) => (typeof f === 'string' ? f : str(f?.displayLabel) || str(f?.label) || str(f?.name) || str(f?.value) || '');
  const extractFeatures = (listing) => {
    const srcs = [listing.propertyFeatures, listing.features, listing.generalFeatures?.features, listing.keyFeatures];
    if (!srcs.some(Array.isArray)) srcs.push(note('features', discover(listing, /feature|amenit/i, (v) => Array.isArray(v) && v.some((x) => featureLabel(x)))));
    const out = [];
    for (const a of srcs) {
      if (!Array.isArray(a)) continue;
      for (const f of a) {
        const l = featureLabel(f) || (Array.isArray(f?.features) ? f.features.map(featureLabel).join(', ') : '');
        if (l) out.push(l.slice(0, 80));
      }
    }
    return [...new Set(out)].slice(0, 40);
  };

  // Photos / floorplan counts; null when REA doesn't say.
  const countOf = (v) => (Array.isArray(v) ? v.length : typeof v === 'number' ? v : null);
  const extractMedia = (listing) => {
    const m = listing.media || {};
    const photos = countOf(m.images) ?? countOf(m.photos) ?? countOf(m.imageCount) ?? countOf(listing.imageCount);
    const plans = countOf(m.floorplans) ?? countOf(m.floorPlans) ?? countOf(listing.floorplans);
    return { photos, floorplan: plans == null ? null : plans > 0 };
  };

  // Amenities from feature labels + description. Negations are checked first, so "no pets"
  // is 'no' rather than matching "pets". State per amenity: 'yes' | 'no' | null (unknown).
  const AMEN_NO = String.raw`\s*[:?\-]\s*(?:no|none|n)\b`; // key/value style: "Pets allowed: No"
  const AMENITIES = [
    { id: 'pets', label: 'Pets', yes: 'Pets OK',
      neg: /\b(?:strictly )?no[- ](?:pets?|animals|dogs?(?: or cats?)?)\b|\bpets? (?:are |is |will )?not (?:be )?(?:allowed|permitted|considered|accepted)\b|\bnot (?:pet[- ]friendly|suitable for pets)\b|\b(?:does|do) not (?:allow|permit|accept) pets\b|\bpet[- ]free\b/,
      pos: /\bpets? (?:are )?(?:allowed|welcome|friendly|considered|ok|okay|negotiable|permitted|accepted)\b|\bpet[- ]friendly\b|\bpets? (?:on|by|upon|subject to) (?:application|approval|request)\b|\bpets?\s*:\s*yes\b/ },
    { id: 'furnished', label: 'Furnished', yes: 'Furnished', neg: /(?<!\bor )\bunfurnished\b(?! or furnished)|\bnot furnished\b/,
      pos: /\b(?:fully |partly |partially |semi[- ])?furnished\b/ },
    { id: 'aircon', label: 'Air con', yes: 'Air con', neg: /\bno (?:air[- ]?con|a\/c)/,
      pos: /\bair[- ]?con(?:ditioning|ditioner)?\b|\bair[- ]conditioned (?!gym|foyer|lobby|common)|\ba\/c\b|\bsplit[- ]system\b|\breverse[- ]cycle\b|\bducted (?:heating (?:and|&) )?(?:cooling|air)\b|\bclimate control\b/ },
    { id: 'dishwasher', label: 'Dishwasher', yes: 'Dishwasher', neg: /\bno dish ?washer\b/, pos: /\bdish ?washer\b/ },
    { id: 'laundry', label: 'Own laundry', yes: 'Own laundry',
      neg: /\b(?:shared|communal|common) laundry\b|\blaundry facilities (?:on (?:each|every|the ground) floor|in (?:the )?building|downstairs)\b/,
      pos: /\b(?:internal|private|separate|own|european) laundry\b|\blaundry (?:room|in unit|facilities)\b|\bin-unit laundry\b|\bwasher\/dryer\b/ },
    { id: 'outdoor', label: 'Outdoor space', yes: 'Outdoor', neg: /\bno (?:balcony|courtyard|outdoor (?:area|space)|yard)\b/,
      pos: /\b(?<!(?:shared|communal|common|rooftop) )(?:balcon(?:y|ies)|courtyard|terrace(?! house| home)|deck(?! chair)|private garden|backyard|outdoor (?:area|space))\b/ },
    { id: 'robes', label: 'Built-in robes', yes: 'BIRs', neg: /\bno (?:built[- ]in )?(?:robes?|wardrobes?|birs?)\b/,
      pos: /\bbuilt[- ]in (?:robes?|wardrobes?)\b|\bbirs?\b|\bwalk[- ]in (?:robe|wardrobe)\b/ },
    { id: 'pool', label: 'Pool', yes: 'Pool', neg: /\bno (?:swimming |lap |plunge )?pool\b/,
      pos: /\b(?<!(?:car|walk to [\w' ]{0,30}|near(?:by)? [\w' ]{0,20}|close to [\w' ]{0,30}) )(?:swimming |lap |plunge )?pool\b(?! tables?|side)/ },
  ];
  // "X: No" per amenity, built once.
  for (const a of AMENITIES) a.kvNo = new RegExp(`(?:${a.pos.source})${AMEN_NO}`);
  // Only what the listing says about itself (features, headline, description), never the
  // address or property type ("North Terrace", type "Terrace" are not outdoor space).
  const amenitiesOf = (row) => {
    const text = `${(row.features || []).join(' | ')} | ${row.amenText ?? row.text ?? ''}`.toLowerCase();
    return Object.fromEntries(AMENITIES.map((a) => [a.id, a.neg.test(text) || a.kvNo.test(text) ? 'no' : a.pos.test(text) ? 'yes' : null]));
  };
  // cfg.amenities is "pets:yes,furnished:no": require / exclude per amenity.
  const parseAmenCfg = (v) => Object.fromEntries(String(v || '').split(',').map((p) => p.split(':'))
    .filter(([id, st]) => AMENITIES.some((a) => a.id === id) && (st === 'yes' || st === 'no')));
  const amenCfgString = (o) => Object.entries(o).map(([id, st]) => `${id}:${st}`).join(',');
  const amenityTags = (r) => AMENITIES.filter((a) => r.amen?.[a.id] === 'yes').map((a) => a.yes);

  // Distance from a user-chosen point. Accepts "-33.87, 151.21" or a Google Maps URL/text
  // containing "@-33.87,151.21" (no geocoding: nothing leaves the browser).
  const parseAnchor = (v) => {
    const m = String(v || '').match(/(-?\d{1,2}\.\d+)\s*,\s*(-?\d{2,3}\.\d+)/);
    if (!m) return null;
    const lat = +m[1], lng = +m[2];
    return inAu(lat, lng) ? { lat, lng } : null;
  };
  const EARTH_KM = 6371;
  const haversineKm = (a, b) => {
    const rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
  };
  const kmLabel = (r) => (r.km == null ? '' : r.km < 1 ? `${Math.round(r.km * 1000)} m away` : `${r.km} km away`);

  const listingId = (href) => String(href || '').match(/-(\d{6,})(?:[/?#]|$)/)?.[1] || '';

  // One malformed listing must not sink a page: rows that throw are dropped.
  const safeRow = (listing, surrounding) => {
    try { return toRow(listing, surrounding); } catch (e) { console.debug?.('[reaFilter] listing skipped:', e); return null; }
  };
  // REA drift guard: `items` that isn't an array reads as empty rather than throwing.
  const itemsOf = (block) => (Array.isArray(block?.items) ? block.items : []);
  const sampleOf = (results) => itemsOf(results?.exact).find((i) => i?.listing)?.listing ?? null;
  const rowsFrom = (results) => [
    ...itemsOf(results?.exact).map((i) => i?.listing && safeRow(i.listing, false)),
    ...itemsOf(results?.surrounding).map((i) => i?.listing && safeRow(i.listing, true)),
  ].filter(Boolean);

  const toRow = (listing, surrounding) => {
    const display = str(listing.availableDate);
    const price = str(listing.price);
    const row = {
      avail: parseAvail(display),
      available: /^\s*(available\s+)?now\b/i.test(display) ? 'Available now' : display.replace(/^Available\s*/i, '') || '-',
      price,
      priceNum: parsePrice(price),
      bond: str(listing.bond),
      address: str(listing.address?.display?.fullAddress) || str(listing.address?.display?.shortAddress),
      suburb: str(listing.address?.suburb),
      beds: scalar(listing.generalFeatures?.bedrooms?.value),
      baths: scalar(listing.generalFeatures?.bathrooms?.value),
      cars: scalar(listing.generalFeatures?.parkingSpaces?.value),
      type: str(listing.propertyType),
      img: safeUrl(str(listing.media?.mainImage?.templatedUrl).replace('{size}', IMG_SIZE)),
      url: safeUrl(str(listing._links?.canonical?.href)),
      surrounding,
      headline: str(listing.title) || str(listing.headline) || '',
      // Cards are matched by the id in their href, so prefer the URL-derived id.
      id: listingId(str(listing._links?.canonical?.href)) || String(listing.id ?? ''),
      inspections: extractInspections(listing),
      listed: extractListed(listing),
      agency: extractAgency(listing),
      features: extractFeatures(listing),
      ...(extractCoords(listing) || { lat: null, lng: null }),
      ...extractMedia(listing),
    };
    const next = row.inspections.find((i) => i.at != null);
    row.nextInspect = next ? new Date(next.at) : null;
    row.inspect = row.inspections.map((i) => i.label).join('; ');
    row.ppb = perBed(row.priceNum, row.beds);
    Object.assign(row, moveIn(row.bond, row.priceNum));
    row.text = [row.headline, str(listing.description), row.address, row.type, ...row.features].filter(Boolean).join(' ').toLowerCase();
    row.amen = amenitiesOf({ features: row.features, amenText: [row.headline, str(listing.description)].filter(Boolean).join(' ') });
    return row;
  };

  // Coercers for fields REA might reshape: anything unexpected becomes ''.
  const str = (v) => (typeof v === 'string' ? v : typeof v?.display === 'string' ? v.display : '');
  const clipText = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  const scalar = (v) => (typeof v === 'number' || typeof v === 'string' ? v : '');

  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => { clearTimeout(t); reject(signal.reason); };
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  // Per-request timeout combined with the caller's cancel signal. Without AbortSignal.any
  // (Chrome < 116) a caller signal wins and the timeout is dropped.
  const withTimeout = (signal, ms) => {
    const t = AbortSignal.timeout?.(ms);
    if (!t) return signal;
    if (!signal) return t;
    return AbortSignal.any ? AbortSignal.any([signal, t]) : signal;
  };
  const jitter = (ms) => Math.round(ms * (0.75 + Math.random() * 0.75));

  // Retries 429/5xx/network errors with exponential backoff, honouring Retry-After.
  // Any other non-2xx, or a page without the blob (bot check), fails immediately.
  // Cancelling via `signal` rejects immediately and is never retried; a timeout is.
  async function fetchResults(url, { fetchImpl = fetch, wait = sleep, onRetry = () => {}, signal } = {}) {
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      let res, err;
      try { res = await fetchImpl(url, { credentials: 'include', signal: withTimeout(signal, FETCH_TIMEOUT_MS) }); } catch (e) { err = e; }
      signal?.throwIfAborted();
      const retryable = err || res.status === 429 || res.status >= 500;
      if (!retryable) {
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
        return extractResults(await res.text());
      }
      if (attempt >= RETRIES) {
        throw new Error(err ? `Network error: ${err.name === 'TimeoutError' ? 'timed out' : err.message}` :
          res.status === 429 ? 'Rate limited by REA (HTTP 429) - wait a minute and retry.' : `HTTP ${res.status} from ${url}`);
      }
      const after = Math.min(+res?.headers?.get?.('Retry-After') || 0, RETRY_AFTER_MAX_S);
      const ms = after > 0 ? after * 1000 : jitter(RETRY_BASE_MS * 2 ** attempt);
      onRetry(attempt + 1, ms);
      await wait(ms, signal);
    }
  }

  // `seed` = { key, page, results } from the already-loaded document, reused instead of refetching.
  async function fetchAllPages(base, onProgress, { seed = null, fetchImpl, wait = sleep, getPage = null, signal } = {}) {
    const rows = [];
    const key = searchKey(base);
    let page = 1, max = 1, total = 1, sample = null;
    do {
      signal?.throwIfAborted();
      const label = `page ${page}${max > 1 ? ` of ${max}` : ''}`;
      onProgress(`Reading ${label}…`);
      const seeded = seed && seed.key === key && seed.page === page;
      const results = seeded ? seed.results : getPage ? await getPage(pageUrl(base, page)) : await fetchResults(pageUrl(base, page), {
        fetchImpl, wait, signal,
        onRetry: (n, ms) => onProgress(`Retrying ${label} in ${Math.round(ms / 1000)}s (attempt ${n}/${RETRIES})…`),
      });
      total = results.pagination?.maxPageNumberAvailable || 1;
      max = Math.min(total, MAX_PAGES);
      rows.push(...rowsFrom(results));
      sample ??= sampleOf(results);
      page++;
      const nextSeeded = seed && seed.key === key && seed.page === page;
      if (page <= max && !seeded && !nextSeeded) await wait(jitter(PAGE_DELAY_MS), signal);
    } while (page <= max);
    return { rows, truncated: total > MAX_PAGES, sample };
  }

  // --------------------------------------------------------------- filter

  const DEFAULT_CFG = {
    from: '', to: '', withinDays: '', exactOnly: false,
    priceMin: '', priceMax: '', upfrontMax: '', bedsMin: '', bathsMin: '', carsMin: '',
    type: '', keyword: '', hideNoImage: false, inspectOn: '', staleOnly: false, amenities: '', anchor: '', maxKm: '', floorplanOnly: false, sort: 'avail',
    annotate: true, dimCards: true, onlyStarred: false, showHidden: false,
    remember: true, newOnly: false, showGone: false,
  };

  // Saved settings are only trusted per key and type: a stale or hand-edited value (eg
  // keyword: null) falls back to the default instead of throwing on every render.
  const sanitizeCfg = (c) => (c && typeof c === 'object'
    ? Object.fromEntries(Object.keys(DEFAULT_CFG).filter((k) => typeof c[k] === typeof DEFAULT_CFG[k]).map((k) => [k, c[k]]))
    : {});

  // cfg keys that narrow results (FILTER_KEYS), live under "More filters" (MORE_KEYS), or
  // are display preferences that Clear keeps (DISPLAY_PREFS).
  const FILTER_KEYS = ['from', 'to', 'withinDays', 'priceMin', 'priceMax', 'upfrontMax', 'bedsMin', 'bathsMin', 'carsMin', 'type', 'keyword',
    'inspectOn', 'hideNoImage', 'exactOnly', 'onlyStarred', 'newOnly', 'staleOnly', 'amenities', 'maxKm', 'floorplanOnly'];
  const MORE_KEYS = ['priceMin', 'priceMax', 'upfrontMax', 'bedsMin', 'bathsMin', 'carsMin', 'type', 'keyword', 'hideNoImage', 'inspectOn',
    'onlyStarred', 'showHidden', 'newOnly', 'showGone', 'staleOnly', 'amenities', 'anchor', 'maxKm', 'floorplanOnly'];
  const DISPLAY_PREFS = ['sort', 'annotate', 'dimCards', 'remember', 'anchor']; // Clear keeps your "from" point

  const num = (v) => (v === '' || v == null || isNaN(+v) ? null : +v);
  const byAvail = (a, b) => (a.avail ?? Infinity) - (b.avail ?? Infinity);
  const byPrice = (a, b) => a.priceNum - b.priceNum;
  const SORTS = {
    avail: (a, b) => byAvail(a, b) || byPrice(a, b),
    price: (a, b) => byPrice(a, b) || byAvail(a, b),
    ppb: (a, b) => a.ppb - b.ppb || byAvail(a, b),
    beds: (a, b) => (+b.beds || 0) - (+a.beds || 0) || byPrice(a, b),
    // Newest first: REA's listed date when present, else when this browser first saw it.
    listed: (a, b) => (b.listed ?? b.firstSeen ?? -Infinity) - (a.listed ?? a.firstSeen ?? -Infinity) || byAvail(a, b),
    inspect: (a, b) => (a.nextInspect ?? Infinity) - (b.nextInspect ?? Infinity) || byAvail(a, b),
    value: (a, b) => (a.vsMedian ?? Infinity) - (b.vsMedian ?? Infinity) || byPrice(a, b),
    distance: (a, b) => (a.km ?? Infinity) - (b.km ?? Infinity) || byAvail(a, b),
    match: (a, b) => (b.score ?? -1) - (a.score ?? -1) || byAvail(a, b),
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

  // Rent vs the median for the same bed count in these results (exact matches only, groups
  // of MEDIAN_MIN or more). vsMedian = % above (+) or below (-); null when not comparable.
  const MEDIAN_MIN = 5;
  const STALE_MS = 21 * DAY_MS; // listed this long ago: rent may be negotiable
  const withMedians = (rows) => {
    const groups = new Map();
    for (const r of dedupe(rows)) {
      if (r.surrounding || !isFinite(r.priceNum) || r.beds === '') continue;
      const k = +r.beds;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r.priceNum);
    }
    const med = new Map();
    for (const [k, v] of groups) {
      if (v.length < MEDIAN_MIN) continue;
      v.sort((a, b) => a - b);
      med.set(k, v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2);
    }
    for (const r of rows) {
      const m = r.beds === '' ? undefined : med.get(+r.beds);
      r.median = m ?? null;
      r.vsMedian = m && isFinite(r.priceNum) ? Math.round(((r.priceNum - m) / m) * 100) : null;
    }
    return rows;
  };
  const medianLabel = (r) => (r.vsMedian == null ? '' : r.vsMedian === 0 ? `at median for ${+r.beds || 'studio'}${+r.beds ? '-bed' : ''}`
    : `${Math.abs(r.vsMedian)}% ${r.vsMedian < 0 ? 'below' : 'above'} median ${+r.beds ? `${r.beds}-bed` : 'studio'}`);

  // "Best match": mean of whichever signals the user has set up, each 0..1 (1 = best).
  // Explainable on purpose: scoreWhy lists the parts. Needs 2+ signals to mean anything.
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const SCORE_AVAIL_DAYS = 30; // this many days away from "from" scores 0 on timing
  const SCORE_KM = 15; // distance that scores 0 when no max km is set
  const median = (v) => { const a = v.filter(isFinite).sort((x, y) => x - y); return a.length ? a[Math.floor((a.length - 1) / 2)] : null; };
  const withScores = (rows, cfg) => {
    const pMax = num(cfg.priceMax), kmMax = num(cfg.maxKm) || SCORE_KM;
    const from = cfg.from ? new Date(cfg.from + 'T00:00:00') : null;
    const upMed = median(rows.map((r) => r.upfront));
    for (const r of rows) {
      const parts = [];
      if (isFinite(r.priceNum)) {
        if (pMax) parts.push(['rent vs budget', clamp01(1 - r.priceNum / pMax + 0.5)]);
        else if (r.vsMedian != null) parts.push(['rent vs median', clamp01(0.5 - r.vsMedian / 50)]);
      }
      if (from && r.avail) parts.push(['timing', clamp01(1 - Math.abs(r.avail - from) / (SCORE_AVAIL_DAYS * DAY_MS))]);
      if (r.km != null) parts.push(['distance', clamp01(1 - r.km / kmMax)]);
      if (upMed && isFinite(r.upfront)) parts.push(['move-in', clamp01(0.5 - (r.upfront - upMed) / (2 * upMed))]);
      r.score = parts.length >= 2 ? Math.round((parts.reduce((t, [, v]) => t + v, 0) / parts.length) * 100) : null;
      r.scoreWhy = r.score == null ? '' : parts.map(([k, v]) => `${k} ${Math.round(v * 100)}`).join(', ');
    }
    return rows;
  };

  // Dedupe by URL, preferring the exact-match copy over a surrounding-suburb one.
  const dedupe = (rows) => {
    const byUrl = new Map();
    for (const r of rows) if (r.url && (!byUrl.has(r.url) || byUrl.get(r.url).surrounding && !r.surrounding)) byUrl.set(r.url, r);
    return [...byUrl.values()];
  };

  // End (23:59:59 local) of a rolling "within N days" window, or null; windowEnd as yyyy-mm-dd.
  const windowEndDate = (days, now = new Date()) => {
    const n = num(days);
    if (n == null) return null;
    const w = new Date(now); w.setHours(23, 59, 59, 0); w.setDate(w.getDate() + n);
    return w;
  };
  const windowEnd = (days, now = new Date()) => { const w = windowEndDate(days, now); return w ? ymdLocal(w) : ''; };

  const startOfDay = (d = new Date()) => { const t = new Date(d); t.setHours(0, 0, 0, 0); return t; };
  const isFresh = (r) => !!(r.isNew || r.sinceLast); // new: REA-dated recently, or since the last visit
  const priceDir = (r) => (r.priceDelta < 0 ? 'down' : 'up');

  // Settings that can't match anything, as a message for the status line ('' if fine).
  const cfgError = (cfg, now = new Date()) => {
    if (cfg.from && cfg.to && cfg.from > cfg.to) return '"Available from" is after "Available to".';
    const wEnd = windowEnd(cfg.withinDays, now);
    if (cfg.from && wEnd && cfg.from > wEnd) return `"Available from" is after the "within" window (ends ${wEnd}).`;
    if (cfg.anchor && !parseAnchor(cfg.anchor)) return 'Distance "from" needs coordinates in Australia, eg -33.87, 151.21 (right-click a spot in Google Maps to copy them).';
    if (cfg.priceMin !== '' && cfg.priceMax !== '' && num(cfg.priceMin) != null && num(cfg.priceMax) != null && +cfg.priceMin > +cfg.priceMax) return 'Min $/wk is above max $/wk.';
    return '';
  };

  // Counts for the status line over the deduped rows.
  const diffStats = (rows) => {
    let fresh = 0, moved = 0, hidden = 0;
    for (const r of dedupe(rows)) { fresh += isFresh(r) ? 1 : 0; moved += r.prevPrice ? 1 : 0; hidden += r.hidden ? 1 : 0; }
    return { fresh, moved, hidden };
  };

  const ago = (ms) => {
    const m = Math.floor(ms / 60e3); // floor: 30s is "just now", not "1 min ago"
    return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
  };

  // Undated listings ("Contact agent") can't satisfy a date bound, but are kept
  // (sorted last) when no bound is set so an empty filter never hides data.
  // Numeric minimums treat unknown values as failing; maximums likewise.
  function applyFilters(rows, cfg, now = new Date()) {
    cfg = { ...DEFAULT_CFG, ...cfg };
    const from = cfg.from ? new Date(cfg.from + 'T00:00:00') : null;
    let to = cfg.to ? new Date(cfg.to + 'T23:59:59') : null;
    // Rolling window ("within 4 weeks") tightens the upper bound relative to today, so a
    // saved setting never goes stale the way a fixed date does.
    const w = windowEndDate(cfg.withinDays, now);
    if (w && (!to || w < to)) to = w;
    const pMin = num(cfg.priceMin), pMax = num(cfg.priceMax), upMax = num(cfg.upfrontMax);
    const mins = [['beds', num(cfg.bedsMin)], ['baths', num(cfg.bathsMin)], ['cars', num(cfg.carsMin)]].filter(([, v]) => v != null);
    const kw = cfg.keyword.trim() ? keywordTest(cfg.keyword) : null;
    const amenReq = Object.entries(parseAmenCfg(cfg.amenities));
    // Distance depends on cfg.anchor, so it is (re)computed here for every caller.
    const anchor = parseAnchor(cfg.anchor), kmMax = num(cfg.maxKm);
    for (const r of rows) r.km = anchor && r.lat != null ? Math.round(haversineKm(anchor, r) * 10) / 10 : null;
    const insDay = cfg.inspectOn ? new Date(cfg.inspectOn + 'T00:00:00') : null;
    const sameDay = (ms) => startOfDay(new Date(ms)).getTime() === insDay.getTime();
    const kept = dedupe(rows)
      .filter((r) => (cfg.exactOnly ? !r.surrounding : true))
      .filter((r) => cfg.showHidden || (!r.hidden && !r.agencyHidden))
      .filter((r) => !cfg.floorplanOnly || r.floorplan === true)
      .filter((r) => cfg.showGone || !r.gone)
      .filter((r) => !cfg.newOnly || isFresh(r))
      .filter((r) => !cfg.staleOnly || (r.listed instanceof Date && now - r.listed > STALE_MS))
      .filter((r) => kmMax == null || !anchor || (r.km != null && r.km <= kmMax)) // no location fails a distance cap
      .filter((r) => amenReq.every(([id, st]) => (st === 'yes' ? r.amen?.[id] === 'yes' : r.amen?.[id] !== 'yes')))
      .filter((r) => !cfg.onlyStarred || r.starred)
      .filter((r) => (r.avail ? (!from || r.avail >= from) && (!to || r.avail <= to) : !from && !to))
      .filter((r) => (pMin == null || (isFinite(r.priceNum) && r.priceNum >= pMin)) && (pMax == null || r.priceNum <= pMax))
      .filter((r) => upMax == null || (r.upfront ?? Infinity) <= upMax) // unknown bond fails a move-in cap
      .filter((r) => mins.every(([k, v]) => r[k] !== '' && +r[k] >= v))
      .filter((r) => !cfg.type || r.type === cfg.type)
      .filter((r) => !cfg.hideNoImage || r.img)
      .filter((r) => !kw || kw(r.text || ''))
      .filter((r) => !insDay || (r.inspections || []).some((i) => i.at != null && sameDay(i.at)));
    return withScores(kept, cfg).sort(SORTS[cfg.sort] || SORTS.avail);
  }

  const historyText = (r) => (r.priceHistory || []).map(([at, p]) => `${ymdLocal(new Date(at))} ${p}`).join(' → ');
  const ppbLabel = (r) => (+r.beds > 1 && isFinite(r.ppb) ? `$${r.ppb}/bed` : '');

  const EXPORT_COLS = [
    ['availDate', 'available_date'], ['available', 'available'], ['price', 'price'], ['priceNum', 'weekly_rent'],
    ['ppb', 'rent_per_bed'], ['bond', 'bond'], ['bondWeeks', 'bond_weeks'], ['upfront', 'move_in_cost'], ['vsMedian', 'vs_median_pct'], ['amenList', 'amenities'], ['km', 'km'], ['score', 'match_score'], ['agency', 'agency'], ['photos', 'photos'], ['floorplan', 'floorplan'], ['address', 'address'], ['suburb', 'suburb'], ['beds', 'beds'],
    ['baths', 'baths'], ['cars', 'cars'], ['type', 'type'], ['inspect', 'inspections'], ['listed', 'listed'],
    ['surrounding', 'nearby'], ['starred', 'shortlisted'], ['isNew', 'new'], ['prevPrice', 'previous_price'], ['priceHistoryText', 'price_history'], ['relistedText', 'relisted_from_price'], ['appStatus', 'application'], ['note', 'note'],
    ['headline', 'headline'], ['url', 'url'],
  ];
  const ymdLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const cellValue = (r, k) => {
    const v = k === 'availDate' ? r.avail : k === 'amenList' ? amenityTags(r).join('; ')
      : k === 'priceHistoryText' ? historyText(r) : k === 'relistedText' ? (r.relisted ? r.relisted.price || 'yes' : '') : r[k];
    if (v instanceof Date) return isNaN(v) ? '' : ymdLocal(v);
    if (typeof v === 'number') return isFinite(v) ? String(v) : '';
    if (typeof v === 'boolean') return v ? 'yes' : '';
    return String(v ?? '').replace(/\s+/g, ' ').trim();
  };
  // Spreadsheet formula injection guard (OWASP): neutralise leading = + @ tab CR, and any
  // leading - that isn't a plain negative number ("-1+1" evaluates in Excel/Sheets).
  const safeCell = (v) => (/^[=+@\t\r]|^-(?!\d+(\.\d+)?$)/.test(v) ? `'${v}` : v);
  const table = (rows) => [EXPORT_COLS.map(([, h]) => h)].concat(rows.map((r) => EXPORT_COLS.map(([k]) => safeCell(cellValue(r, k)))));

  const toTsv = (rows) => table(rows).map((cols) => cols.map((c) => c.replace(/\t/g, ' ')).join('\t')).join('\n');
  const toCsv = (rows) => table(rows).map((cols) => cols.map((c) => (/[",\n\r]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\r\n');


  // Upcoming inspections as an iCalendar file (RFC 5545) for any calendar app. REA gives a
  // start time only, so each event is INSPECT_MINUTES long. '' when there are none.
  const INSPECT_MINUTES = 15;
  const icsText = (v) => String(v ?? '').replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\r?\n/g, '\\n');
  const icsTime = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  // Lines over 75 octets are folded: CRLF + one space, per RFC 5545 3.1.
  const icsFold = (line) => {
    const out = [];
    let cur = '', bytes = 0;
    for (const ch of line) {
      const b = new TextEncoder().encode(ch).length;
      if (bytes + b > 75) { out.push(cur); cur = ' '; bytes = 1; }
      cur += ch; bytes += b;
    }
    out.push(cur);
    return out.join('\r\n');
  };
  const toIcs = (rows, now = Date.now()) => {
    const events = [];
    const seen = new Set();
    for (const r of rows) {
      for (const i of r.inspections || []) {
        if (typeof i.at !== 'number' || i.at < now - INSPECT_GRACE_MS) continue;
        const uid = `${r.id}-${i.at}@rea-enhancement`;
        if (seen.has(uid)) continue;
        seen.add(uid);
        events.push(['BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${icsTime(now)}`, `DTSTART:${icsTime(i.at)}`,
          `DURATION:PT${INSPECT_MINUTES}M`, `SUMMARY:${icsText(`Inspection: ${r.address || 'rental'}`)}`,
          `LOCATION:${icsText(r.address)}`, r.url ? `URL:${r.url}` : '',
          `DESCRIPTION:${icsText([r.price, r.available && `Available ${r.available}`, r.note].filter(Boolean).join(' | '))}`,
          'END:VEVENT'].filter(Boolean));
      }
    }
    if (!events.length) return '';
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//rea-enhancement//EN', 'CALSCALE:GREGORIAN', ...events.flat(), 'END:VCALENDAR']
      .map(icsFold).join('\r\n') + '\r\n';
  };

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
    'address.location', 'listingCompany.name', 'agency.name', 'propertyFeatures', 'features', 'media.images', 'media.floorplans',
  ];
  const probe = (listing) => {
    const out = Object.fromEntries(PROBE_PATHS.map((p) => {
      const v = p.split('.').reduce((o, k) => o?.[k], listing);
      return [p, v === undefined ? '(missing)' : typeof v === 'object' ? JSON.stringify(v).slice(0, 160) : v];
    }));
    // What discovery found for *this* listing where the known spellings were missing.
    for (const k of Object.keys(found)) delete found[k];
    toRow(listing, false);
    for (const [field, path] of Object.entries(found)) out[`discovered ${field}`] = path;
    return out;
  };

  // Node test harness: expose pure functions, skip all DOM work.
  if (typeof window === 'undefined') {
    module.exports = {
      parseAvail, parsePrice, parseExchange, rowsFrom, extractResults, pageUrl, searchKey, isSearchPage, pageNum, toRow,
      fetchResults, fetchAllPages, sleep, discover, extractCoords, extractAgency, extractFeatures, extractMedia, listingId, dedupe, windowEnd, extractInspections, extractListed, toDate, applyFilters, keywordTest, toTsv, toCsv, toIcs, schemaWarnings, probe, esc, safeUrl, rowStore, marksStore, snapshotStore, APP_STATUSES, addressKey, DEFAULT_CFG, withScores, parseAnchor, haversineKm, AMENITIES, amenitiesOf, parseAmenCfg, amenCfgString, moveIn, withMedians, medianLabel, sanitizeCfg, itemsOf, sampleOf, cfgError, diffStats, ago, startOfDay, isFresh,
    };
    return;
  }

  // ------------------------------------------------------------------- ui

  function downloadIcs(rows) {
    const ics = toIcs(rows);
    if (!ics) return setStatus('No upcoming inspection times in these listings.', true);
    download(`rea-inspections-${stamp()}.ics`, ics, 'text/calendar;charset=utf-8');
  }

  function download(name, text, type) {
    const blob = new Blob([text], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), REVOKE_MS);
  }
  const stamp = () => ymdLocal(new Date());
  // BOM so Excel opens UTF-8 (en dashes, accented suburbs) correctly.
  const downloadCsv = (rows) => download(`rea-${stamp()}.csv`, '\ufeff' + toCsv(rows), 'text/csv;charset=utf-8');
  const downloadTsv = (rows) => download(`rea-${stamp()}.tsv`, toTsv(rows), 'text/tab-separated-values;charset=utf-8');

  // Colours are tokens on #rf-panel so the dark scheme only swaps values.
  const css = `
  #rf-panel,#rf-launch{--rf-bg:#fff;--rf-fg:#111;--rf-muted:#666;--rf-soft:#767680;--rf-line:#e4e4e7;--rf-input:#cfcfd4;
    --rf-hover:#f6f6f8;--rf-sec:#f1f1f4;--rf-sec-hover:#e6e6ea;--rf-accent:#087a50;--rf-accent-hover:#06663f;--rf-accent-fg:#087a50;
    --rf-err:#c00;--rf-tag:#eee}
  @media (prefers-color-scheme: dark){
    #rf-panel,#rf-launch{--rf-bg:#1c1c20;--rf-fg:#ececf1;--rf-muted:#a0a0ab;--rf-soft:#8e8e99;--rf-line:#2e2e35;--rf-input:#3a3a43;
      --rf-hover:#26262c;--rf-sec:#2a2a31;--rf-sec-hover:#34343c;--rf-accent-fg:#3ddc9a;--rf-err:#ff6b6b;--rf-tag:#33333b}
  }
  #rf-launch{position:fixed;right:20px;bottom:20px;z-index:2147483000;padding:11px 16px;border:0;border-radius:999px;
    background:var(--rf-accent);color:#fff;font:600 13px/1 system-ui,-apple-system,sans-serif;cursor:pointer;
    box-shadow:0 4px 16px rgba(0,0,0,.28)}
  #rf-launch:hover{background:var(--rf-accent-hover)}
  #rf-launch[hidden]{display:none}
  #rf-panel{position:fixed;top:0;right:0;bottom:0;width:430px;max-width:100vw;z-index:2147483001;background:var(--rf-bg);
    display:flex;flex-direction:column;box-shadow:-4px 0 24px rgba(0,0,0,.22);color-scheme:light dark;
    font:13px/1.45 system-ui,-apple-system,sans-serif;color:var(--rf-fg)}
  #rf-panel[hidden]{display:none}
  #rf-panel *{box-sizing:border-box}
  .rf-head{padding:14px 16px;border-bottom:1px solid var(--rf-line);display:flex;align-items:center;gap:8px}
  .rf-head h2{margin:0;font-size:14px;font-weight:650;flex:1;color:var(--rf-fg)}
  #rf-panel :focus-visible,#rf-launch:focus-visible{outline:2px solid var(--rf-accent-fg);outline-offset:2px}
  .rf-btn[aria-disabled=true]{opacity:.6;cursor:progress}
  .rf-n{font-weight:400;color:var(--rf-soft)}
  .rf-undo{margin-left:8px;border:0;background:none;padding:0;font:600 12px system-ui,sans-serif;color:var(--rf-accent-fg);
    text-decoration:underline;cursor:pointer}
  .rf-clear[hidden]{display:none}
  .rf-clear{border:0;background:none;font:600 12px system-ui,sans-serif;color:var(--rf-accent-fg);cursor:pointer;padding:2px 6px}
  .rf-x{border:0;background:none;font-size:20px;line-height:1;cursor:pointer;color:var(--rf-muted);padding:0 4px}
  .rf-controls{padding:12px 16px;border-bottom:1px solid var(--rf-line);display:grid;gap:10px;max-height:60vh;overflow-y:auto}
  .rf-dates{display:grid;grid-template-columns:1fr 1fr .8fr;gap:10px}
  .rf-controls label{display:grid;gap:4px;font-size:11px;font-weight:600;text-transform:uppercase;
    letter-spacing:.04em;color:var(--rf-muted)}
  .rf-controls input:not([type=checkbox]),.rf-controls select{padding:7px 8px;border:1px solid var(--rf-input);border-radius:6px;
    font:inherit;font-size:13px;text-transform:none;letter-spacing:0;color:var(--rf-fg);background:var(--rf-bg);min-width:0;width:100%}
  .rf-grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:8px 10px}
  .rf-more{display:grid;gap:10px}
  .rf-more summary{cursor:pointer;font-size:12px;font-weight:600;color:var(--rf-accent-fg)}
  .rf-more>label,.rf-more>.rf-grid3{margin-top:8px}
  .rf-row{display:flex;align-items:center;justify-content:space-between;gap:10px}
  .rf-controls .rf-sort{display:flex;align-items:center;gap:6px}
  .rf-controls .rf-sort select{width:auto}
  .rf-type{font-weight:400;color:var(--rf-soft);font-size:12px}
  .rf-controls .rf-check{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:500;text-transform:none;
    letter-spacing:0;color:var(--rf-fg)}
  .rf-check input{margin:0;accent-color:var(--rf-accent)}
  .rf-actions{display:flex;gap:8px;align-items:center}
  .rf-btn{flex:1;padding:9px 12px;border:0;border-radius:6px;background:var(--rf-accent);color:#fff;
    font:600 13px system-ui,sans-serif;cursor:pointer}
  .rf-btn:hover{background:var(--rf-accent-hover)}
  .rf-btn[disabled]{opacity:.5;cursor:default}
  .rf-btn[hidden]{display:none}
  .rf-btn.sec{background:var(--rf-sec);color:var(--rf-fg)}
  .rf-btn.sec:hover{background:var(--rf-sec-hover)}
  .rf-exports .rf-btn{flex:0 0 auto;padding:6px 11px;font-size:12px}
  .rf-label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--rf-muted);margin-right:auto}
  .rf-status{padding:8px 16px;font-size:12px;color:var(--rf-muted);border-bottom:1px solid var(--rf-line);min-height:19px}
  .rf-status.err{color:var(--rf-err)}
  .rf-list{flex:1;overflow-y:auto;padding:8px}
  .rf-card{display:grid;grid-template-columns:104px 1fr;gap:11px;padding:9px;border-radius:8px;
    color:inherit;text-decoration:none}
  .rf-card:hover{background:var(--rf-hover)}
  .rf-card img{width:104px;height:78px;object-fit:cover;border-radius:6px;background:var(--rf-tag)}
  .rf-avail{font-weight:700;color:var(--rf-accent-fg);font-size:12px}
  .rf-price{font-weight:650;margin-top:1px}
  .rf-addr{margin-top:1px}
  .rf-meta{color:var(--rf-soft);font-size:12px;margin-top:3px}
  .rf-tag{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:4px;background:var(--rf-tag);
    color:var(--rf-muted);font-size:10px;font-weight:600;text-transform:uppercase;vertical-align:1px}
  .rf-tabs{display:flex;gap:4px;padding:6px 16px 0;border-bottom:1px solid var(--rf-line)}
  .rf-tabs button{border:0;background:none;padding:8px 10px;font:600 12px system-ui,sans-serif;color:var(--rf-muted);
    cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
  .rf-tabs button[aria-selected=true]{color:var(--rf-fg);border-bottom-color:var(--rf-accent)}
  .rf-sl-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 16px;border-bottom:1px solid var(--rf-line)}
  .rf-sl-bar .rf-label{flex-basis:100%}
  .rf-sl-bar[hidden],.rf-controls[hidden]{display:none}
  .rf-sl-bar .rf-btn{flex:0 0 auto;padding:6px 11px;font-size:12px}
  .rf-note{margin:-2px 9px 8px 124px;padding:6px 8px;border-radius:6px;background:var(--rf-hover);font-size:12px;
    white-space:pre-wrap;overflow-wrap:anywhere}
  .rf-note-edit{display:block;width:calc(100% - 133px);margin:-2px 9px 8px 124px;min-height:54px;padding:6px 8px;
    border:1px solid var(--rf-input);border-radius:6px;font:12px/1.4 system-ui,sans-serif;background:var(--rf-bg);color:var(--rf-fg)}
  .rf-item{position:relative}
  .rf-item.rf-hidden .rf-card{opacity:.45}
  .rf-acts{position:absolute;top:8px;right:8px;display:flex;gap:4px;opacity:0;transition:opacity .12s}
  .rf-item:hover .rf-acts,.rf-acts:focus-within,.rf-starred .rf-acts,.rf-hidden .rf-acts{opacity:1}
  .rf-starred:not(:hover):not(:focus-within) .rf-acts :is([data-act=h],[data-act=n],[data-act=ag]){display:none}
  @media (hover:none){.rf-acts{opacity:1}} /* after the opacity:0 rule so it wins */
  .rf-starred .rf-card{box-shadow:inset 3px 0 0 #e6a700}
  .rf-acts button{border:1px solid var(--rf-line);background:var(--rf-bg);color:var(--rf-fg);border-radius:6px;
    font:600 12px system-ui,sans-serif;padding:3px 7px;cursor:pointer}
  .rf-acts button[data-act=s][aria-pressed=true]{color:#e6a700}
  .rf-tag.rf-new{background:#087a50;color:#fff}
  .rf-tag.rf-gone{background:#8a8a95;color:#fff}
  .rf-was{font-weight:600;font-size:11px;padding:1px 5px;border-radius:4px}
  .rf-was.down{color:#087a50;background:rgba(8,122,80,.12)}
  .rf-was.up{color:#c60;background:rgba(204,102,0,.12)}
  .rf-more-btn{display:block;width:calc(100% - 16px);margin:8px}
  .rf-warn{color:#b45309;font-weight:600}
  .rf-score{font-weight:700;color:var(--rf-fg);cursor:help;border-bottom:1px dotted var(--rf-soft)}
  .rf-agencies{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
  .rf-agencies[hidden]{display:none}
  .rf-agencies .rf-label{margin-right:4px}
  .rf-compare{overflow-x:auto;padding:4px}
  #rf-panel.rf-wide{width:min(960px,100vw)}
  .rf-btn.sec[aria-pressed=true]{background:var(--rf-accent);color:#fff}
  .rf-compare table{border-collapse:collapse;font-size:12px;min-width:100%}
  .rf-compare th,.rf-compare td{border-bottom:1px solid var(--rf-line);padding:6px 8px;text-align:left;vertical-align:top;min-width:110px}
  .rf-compare tbody th{color:var(--rf-muted);font-weight:600;white-space:nowrap;min-width:0;position:sticky;left:0;background:var(--rf-bg)}
  .rf-compare thead a{color:inherit;text-decoration:none;display:grid;gap:4px;font-weight:600}
  .rf-compare thead img{width:100%;height:64px;object-fit:cover;border-radius:6px}
  .rf-compare .rf-best{background:rgba(8,122,80,.12);color:var(--rf-accent-fg);font-weight:700}
  .rf-na{color:var(--rf-soft)}
  .rf-dist{display:grid;grid-template-columns:1fr 90px;gap:10px}
  .rf-amen{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
  .rf-chip{border:1px solid var(--rf-input);background:var(--rf-bg);color:var(--rf-fg);border-radius:999px;padding:4px 10px;
    font:500 12px system-ui,sans-serif;cursor:pointer}
  .rf-chip[data-state=yes]{background:var(--rf-accent);border-color:var(--rf-accent);color:#fff}
  .rf-chip[data-state=no]{background:var(--rf-sec);text-decoration:line-through;color:var(--rf-muted)}
  .rf-tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}
  .rf-tags span{font-size:11px;padding:1px 6px;border-radius:4px;background:var(--rf-hover);color:var(--rf-muted)}
  .rf-med.down{color:var(--rf-accent-fg)}
  .rf-med.up{color:#b45309}
  .rf-app{display:flex;align-items:center;gap:6px;margin:-2px 9px 8px 124px;font-size:12px;color:var(--rf-muted)}
  .rf-app select{font:12px system-ui,sans-serif;padding:3px 6px;border:1px solid var(--rf-input);border-radius:6px;background:var(--rf-bg);color:var(--rf-fg)}
  .rf-sl-filter{font:12px system-ui,sans-serif;padding:4px 6px;border:1px solid var(--rf-input);border-radius:6px;background:var(--rf-bg);color:var(--rf-fg)}
  .rf-empty{padding:28px 16px;text-align:center;color:var(--rf-soft)}
  article[data-rf-pos]{position:relative}
  article[data-rf-match="0"]{opacity:.35;transition:opacity .15s}
  article[data-rf-match="0"]:hover{opacity:1}
  .rf-badge{position:absolute;top:10px;left:10px;z-index:5;display:flex;gap:4px;flex-wrap:wrap;pointer-events:none;
    font:600 11px/1 system-ui,-apple-system,sans-serif}
  .rf-badge span{padding:5px 8px;border-radius:999px;background:rgba(0,0,0,.78);color:#fff;white-space:nowrap}
  .rf-badge .rf-b-pets{background:#7c3aed}
  .rf-badge .rf-b-now{background:#087a50}
  .rf-badge .rf-b-none{background:rgba(90,90,90,.85)}
  .rf-badge .rf-b-star{background:#e6a700;color:#111}
  .rf-badge .rf-b-new{background:#2563eb}
  .rf-badge .rf-b-down{background:#087a50}
  .rf-badge .rf-b-up{background:#c60}
  @media (max-width:480px){ #rf-launch{right:12px;bottom:12px} .rf-grid3{grid-template-columns:repeat(2,1fr)}
    .rf-dates{grid-template-columns:1fr 1fr} .rf-dates>label:last-child{grid-column:1/-1} .rf-controls{max-height:40vh} }
  `;

  const EMPTY_INTRO = 'Set your dates, then search.<br>Every result page is merged and sorted by availability.';
  const setEmpty = (html) => { ui.list.innerHTML = `<div class="rf-empty">${html}</div>`; };
  const setLaunchCount = (n) => { ui.launch.textContent = n == null ? 'Availability filter' : `Availability filter (${n})`; };
  const currentKey = () => (isSearchPage(location.href) ? searchKey(location.href) : null);

  let cfg = { ...DEFAULT_CFG, ...loadCfg() };
  let cache = null; // raw rows for the current search URL
  let cacheKey = null; // searchKey() of the cached rows
  let truncated = false;
  let runId = 0; // bumped on navigation so an in-flight run can't write stale rows
  let ui = null;

  // The document we were loaded with already holds one page of results; after SPA
  // navigation it is stale, which the key/page match in fetchAllPages guards against.
  const boot = (() => {
    if (!isSearchPage(location.href)) return null;
    try {
      const key = searchKey(location.href), page = pageNum(location.href);
      if (window.ArgonautExchange) return { key, page, results: parseExchange(window.ArgonautExchange) };
      const tag = [...document.scripts].find((sc) => sc.textContent.includes('window.ArgonautExchange='));
      return tag ? { key, page, results: extractResults(tag.textContent + '</script>') } : null;
    } catch { return null; }
  })();

  const bootAt = Date.now();
  // Reading window.localStorage/sessionStorage itself throws when site data is blocked;
  // every store then runs on an inert storage and the tool works without persistence.
  const nullStorage = { length: 0, key: () => null, getItem: () => null, setItem() {}, removeItem() {} };
  const storageOr = (name) => { try { return window[name] || nullStorage; } catch { return nullStorage; } };
  const store = rowStore(storageOr('sessionStorage'));
  const snaps = snapshotStore(storageOr('localStorage'));
  let gone = []; // rows from the baseline that are no longer listed (shown when cfg.showGone)
  let baseAt = null; // when the baseline ("last visit") was taken
  const pool = () => (cfg.showGone && gone.length ? cache.concat(gone) : cache);
  const marks = marksStore(storageOr('localStorage'));
  let rawSample = sampleOf(boot?.results);

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
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Availability filter');
    launch.setAttribute('aria-controls', 'rf-panel');
    launch.setAttribute('aria-expanded', 'false');
    panel.innerHTML = `
      <div class="rf-head">
        <h2>Availability filter</h2>
        <button class="rf-clear" title="Reset all filters">Clear</button>
        <button class="rf-x" title="Close (Esc)" aria-label="Close">&times;</button>
      </div>
      <div class="rf-tabs" role="tablist">
        <button role="tab" data-view="results" aria-selected="true">Results</button>
        <button role="tab" data-view="shortlist" aria-selected="false">Shortlist <span class="rf-count"></span></button>
      </div>
      <div class="rf-sl-bar" hidden>
        <span class="rf-label">Shortlist, all searches</span>
        <select class="rf-sl-filter" aria-label="Filter shortlist by application status">
          <option value="">All</option>${APP_STATUSES.filter(Boolean).map((v) => `<option value="${v}">${v[0].toUpperCase() + v.slice(1)}</option>`).join('')}
          <option value="-">Not started</option>
        </select>
        <button class="rf-btn sec" data-export="csv" title="Download the shortlist as CSV">CSV</button>
        <button class="rf-btn sec" data-export="ics" title="Shortlisted inspections as a calendar file">Calendar</button>
        <button class="rf-btn sec" data-sl="backup" title="Download shortlist, hidden listings, notes and remembered searches as JSON">Backup</button>
        <button class="rf-btn sec" data-sl="restore" title="Merge a backup file">Restore</button>
        <button class="rf-btn sec" data-sl="compare" aria-pressed="false" title="Side-by-side table of up to ${COMPARE_MAX}">Compare</button>
        <input type="file" accept="application/json,.json" hidden>
      </div>
      <div class="rf-controls">
        <div class="rf-dates">
          <label>Available from<input type="date" id="rf-from"></label>
          <label>Available to<input type="date" id="rf-to"></label>
          <label>Within<select id="rf-withinDays">
            <option value="">Any time</option><option value="14">2 weeks</option><option value="28">4 weeks</option>
            <option value="56">8 weeks</option><option value="84">12 weeks</option>
          </select></label>
        </div>
        <details class="rf-more" id="rf-more">
          <summary>More filters</summary>
          <div class="rf-grid3">
            <label>Min $/wk<input type="number" min="0" step="25" id="rf-priceMin" inputmode="numeric"></label>
            <label>Max $/wk<input type="number" min="0" step="25" id="rf-priceMax" inputmode="numeric"></label>
            <label title="Bond + 2 weeks' rent">Max move-in $<input type="number" min="0" step="100" id="rf-upfrontMax" inputmode="numeric"></label>
            <label>Min beds<input type="number" min="0" max="9" id="rf-bedsMin" inputmode="numeric"></label>
            <label>Min baths<input type="number" min="0" max="9" id="rf-bathsMin" inputmode="numeric"></label>
            <label>Min cars<input type="number" min="0" max="9" id="rf-carsMin" inputmode="numeric"></label>
            <label>Type<select id="rf-type"><option value="">Any</option></select></label>
          </div>
          <div class="rf-amen" role="group" aria-label="Amenities: click to require, again to exclude, again to clear">
            <input type="hidden" id="rf-amenities">
            ${AMENITIES.map((a) => `<button type="button" class="rf-chip" data-amen="${a.id}">${a.label}</button>`).join('')}
          </div>
          <div class="rf-dist">
            <label>Distance from<input type="text" id="rf-anchor" placeholder="-33.87, 151.21 or a Google Maps link" autocomplete="off"></label>
            <label>Max km<input type="number" min="0" step="1" id="rf-maxKm" inputmode="decimal"></label>
          </div>
          <label>Keywords<input type="text" id="rf-keyword" placeholder='eg pool -studio "north facing"'></label>
          <label>Inspection on<input type="date" id="rf-inspectOn"></label>
          <label class="rf-check" title="Listed over 3 weeks ago: rent may be negotiable"><input type="checkbox" id="rf-staleOnly">Listed over 3 weeks ago</label>
          <label class="rf-check"><input type="checkbox" id="rf-hideNoImage">Hide listings without a photo</label>
          <label class="rf-check"><input type="checkbox" id="rf-newOnly">New since last visit only</label>
          <label class="rf-check"><input type="checkbox" id="rf-showGone">Show listings no longer listed</label>
          <label class="rf-check"><input type="checkbox" id="rf-onlyStarred">Shortlisted only <span class="rf-n" data-count="starred"></span></label>
          <label class="rf-check"><input type="checkbox" id="rf-showHidden">Show hidden listings <span class="rf-n" data-count="hidden"></span></label>
          <label class="rf-check"><input type="checkbox" id="rf-floorplanOnly">Has a floorplan</label>
          <div class="rf-agencies" hidden><span class="rf-label">Hidden agencies</span><span class="rf-ag-list"></span></div>
          <label class="rf-check"><input type="checkbox" id="rf-annotate">Show availability on REA's result cards</label>
          <label class="rf-check"><input type="checkbox" id="rf-dimCards">Fade REA cards that don't match filters</label>
          <label class="rf-check"><input type="checkbox" id="rf-remember">Remember results between visits</label>
        </details>
        <div class="rf-row">
          <label class="rf-check"><input type="checkbox" id="rf-exact">Hide surrounding suburbs</label>
          <label class="rf-sort">Sort<select id="rf-sort">
            <option value="avail">Available date</option>
            <option value="price">Price</option>
            <option value="ppb">Price per bed</option>
            <option value="beds">Most beds</option>
            <option value="inspect">Next inspection</option>
            <option value="listed">Newest first</option>
            <option value="value">Best value vs median</option>
            <option value="distance">Nearest</option>
            <option value="match">Best match</option>
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
          <button class="rf-btn sec" data-export="ics" disabled title="Upcoming inspections as a calendar file">Calendar</button>
        </div>
      </div>
      <div class="rf-status" role="status" aria-live="polite"></div>
      <div class="rf-list"><div class="rf-empty">${EMPTY_INTRO}</div></div>`;

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
      controls: panel.querySelector('.rf-controls'),
      tabs: [...panel.querySelectorAll('[role=tab]')],
      slBar: panel.querySelector('.rf-sl-bar'),
      slCount: panel.querySelector('.rf-count'),
      slFile: panel.querySelector('.rf-sl-bar input[type=file]'),
      slFilter: panel.querySelector('.rf-sl-filter'),
      list: panel.querySelector('.rf-list'),
    };

    // Inputs map 1:1 to cfg keys via their id (rf-<key>); exactOnly keeps its legacy id.
    const fields = Object.keys(DEFAULT_CFG).map((k) => [k, panel.querySelector(`#rf-${k === 'exactOnly' ? 'exact' : k}`)]);
    const read = (el) => (el.type === 'checkbox' ? el.checked : el.value);
    const write = (el, v) => { if (el.type === 'checkbox') el.checked = !!v; else el.value = v ?? ''; };
    for (const [k, el] of fields) write(el, cfg[k]);
    queueMicrotask(() => ui.paintAmen?.());
    ui.fields = fields;
    ui.type = panel.querySelector('#rf-type');
    // Amenity chips cycle any -> require -> exclude, writing the hidden rf-amenities field.
    const amenInput = panel.querySelector('#rf-amenities');
    const paintAmen = () => {
      const st = parseAmenCfg(amenInput.value);
      for (const b of panel.querySelectorAll('[data-amen]')) {
        const a = AMENITIES.find((x) => x.id === b.dataset.amen), v = st[a.id];
        b.dataset.state = v || '';
        b.textContent = v === 'yes' ? `+ ${a.label}` : v === 'no' ? `− ${a.label}` : a.label;
        b.setAttribute('aria-label', `${a.label}: ${v === 'yes' ? 'required' : v === 'no' ? 'excluded' : 'any'}`);
      }
    };
    ui.paintAmen = paintAmen;
    panel.querySelector('.rf-amen').addEventListener('click', (e) => {
      const b = e.target.closest('[data-amen]');
      if (!b) return;
      const st = parseAmenCfg(amenInput.value), id = b.dataset.amen;
      st[id] = !st[id] ? 'yes' : st[id] === 'yes' ? 'no' : undefined;
      if (!st[id]) delete st[id];
      amenInput.value = amenCfgString(st);
      paintAmen();
      amenInput.dispatchEvent(new Event('change'));
    });
    ui.annotateBox = panel.querySelector('#rf-annotate');
    ui.more = panel.querySelector('#rf-more');
    ui.more.open = MORE_KEYS.some((k) => cfg[k] && cfg[k] !== DEFAULT_CFG[k]);

    // Full-screen on phones, so modal there (focus trapped); a side drawer on desktop.
    const narrow = window.matchMedia(NARROW_MQ);
    const setOpen = (open) => {
      panel.hidden = !open;
      launch.setAttribute('aria-expanded', String(open));
      panel.setAttribute('aria-modal', String(open && narrow.matches));
    };
    ui.setOpen = setOpen;
    launch.addEventListener('click', () => { setOpen(true); ui.run.focus(); });
    panel.querySelector('.rf-x').addEventListener('click', () => { setOpen(false); launch.focus(); });
    document.addEventListener('keydown', (e) => {
      if (panel.hidden) return;
      if (e.key === 'Escape') { setOpen(false); launch.focus(); return; }
      if (e.key === 'Tab' && narrow.matches) {
        const f = [...panel.querySelectorAll('button,input,select,textarea,a[href],summary')].filter((el) => el.offsetParent && !el.disabled);
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    });
    panel.querySelector('.rf-clear').addEventListener('click', () => {
      // Resets filters only; display preferences (sort, annotate, dim) are kept.
      for (const [k, el] of fields) write(el, DISPLAY_PREFS.includes(k) ? cfg[k] : DEFAULT_CFG[k]);
      ui.paintAmen();
      onChange();
    });

    let t;
    // The blur after typing fires "change" with nothing new; re-rendering then would
    // replace the list between mousedown and mouseup and swallow the user's click.
    let lastSig = JSON.stringify(cfg);
    const onChange = (e) => {
      const next = Object.fromEntries(fields.map(([k, el]) => [k, read(el)]));
      const sig = JSON.stringify(next);
      if (sig === lastSig) {
        // Same config: only flush a pending debounced render (eg Enter right after typing).
        if (t && e?.type === 'change') { clearTimeout(t); t = null; if (cache) showResults(); }
        return;
      }
      lastSig = sig;
      const wasRemember = cfg.remember;
      cfg = next;
      saveCfg(cfg);
      if (wasRemember && !cfg.remember) { // opting out also forgets what was stored
        snaps.clear();
        applySnap(null);
        setStatus('Saved results cleared; results will no longer be remembered.');
      }
      clearTimeout(t);
      scheduleAnnotate();
      if (e?.target === ui.annotateBox && cfg.annotate) ensureVisiblePage();
      if (!cache) return;
      if (e?.type === 'input') t = setTimeout(() => { t = null; showResults(); }, INPUT_DEBOUNCE_MS); // debounce typing
      else showResults(); // re-filter without refetching
    };
    for (const [, el] of fields) {
      el.addEventListener('change', onChange);
      if (el.type === 'text' || el.type === 'number') el.addEventListener('input', onChange);
    }

    // Shortlist / hide / note: one delegated handler; re-render keeps scroll position.
    ui.list.addEventListener('click', (e) => {
      if (e.target.closest('.rf-more-btn')) return renderMore();
      const b = e.target.closest('.rf-acts button');
      if (!b) return;
      const id = b.closest('.rf-item')?.dataset.id;
      if (!id) return;
      if (b.dataset.act === 'n') return editNote(b.closest('.rf-item'));
      if (b.dataset.act === 'ag') {
        const r = rowById(id);
        if (!r?.agency) return;
        marks.toggleAgency(r.agency);
        refreshMarks();
        ui.list.focus();
        return offerUndo(`Hidden all listings from ${r.agency}.`, () => { marks.toggleAgency(r.agency); refreshMarks(); });
      }
      const act = b.dataset.act;
      const next = b.closest('.rf-item').nextElementSibling?.dataset.id;
      const on = marks.toggle(id, act, rowById(id));
      refreshMarks();
      // Re-render replaced the button: put focus back (or on the next item if this one left the list).
      const q = (i) => ui.list.querySelector(`.rf-item[data-id="${CSS.escape(i)}"] [data-act="${act}"]`);
      (q(id) || (next && q(next)) || ui.list).focus?.();
      if (act === 'h' && on) offerUndo('Listing hidden.', () => { marks.toggle(id, 'h'); refreshMarks(); (q(id) || ui.list).focus(); });
    });
    ui.list.tabIndex = -1;
    ui.list.addEventListener('change', (e) => {
      const sel = e.target.closest('select[data-app]');
      if (!sel) return;
      const id = sel.closest('.rf-item').dataset.id;
      marks.setStatus(id, sel.value);
      refreshMarks();
      ui.list.querySelector(`.rf-item[data-id="${CSS.escape(id)}"] select[data-app]`)?.focus();
    });

    for (const tab of ui.tabs) tab.addEventListener('click', () => setView(tab.dataset.view));
    ui.slFilter.addEventListener('change', () => renderShortlist());
    panel.querySelector('.rf-agencies').addEventListener('click', (e) => {
      const b = e.target.closest('[data-unhide-ag]');
      if (b) { marks.toggleAgency(b.dataset.unhideAg); refreshMarks(); }
    });
    ui.slBar.querySelector('[data-sl=backup]').addEventListener('click', () => {
      const data = marks.exportData();
      if (cfg.remember) data.snapshots = snaps.exportData();
      download(`rea-backup-${stamp()}.json`, JSON.stringify(data), 'application/json');
    });
    ui.slBar.querySelector('[data-sl=restore]').addEventListener('click', () => ui.slFile.click());
    ui.slBar.querySelector('[data-sl=compare]').addEventListener('click', (e) => {
      ui.compare = !ui.compare;
      e.currentTarget.setAttribute('aria-pressed', String(ui.compare));
      ui.panel.classList.toggle('rf-wide', ui.compare);
      renderShortlist();
    });
    ui.slFile.addEventListener('change', async () => {
      const f = ui.slFile.files?.[0];
      ui.slFile.value = '';
      if (!f) return;
      try {
        if (f.size > BACKUP_MAX_BYTES) throw new Error('File too large for a backup.');
        let data;
        try { data = JSON.parse(await f.text()); } catch { throw new Error('Not a JSON file.'); }
        const n = marks.importJson(data);
        const k = cfg.remember ? snaps.importData(data.snapshots) : 0;
        refreshMarks();
        setStatus(`Restored ${n} listing${n === 1 ? '' : 's'}${k ? ` and ${k} saved search${k === 1 ? '' : 'es'}` : ''} from backup.`);
      } catch (err) { setStatus(err.message, true); }
    });

    ui.run.addEventListener('click', () => busy || run());
    ui.refresh.addEventListener('click', () => busy || run(true));
    for (const b of ui.exports) {
      b.addEventListener('click', async () => {
        const rows = ui.view === 'shortlist' ? shortlistRows() : cache ? applyFilters(pool(), cfg) : null;
        if (!rows) return;
        if (b.dataset.export === 'csv') downloadCsv(rows);
        else if (b.dataset.export === 'tsv') downloadTsv(rows);
        else if (b.dataset.export === 'ics') downloadIcs(rows);
        else {
          const text = toTsv(rows);
          let ok = false;
          try { await navigator.clipboard.writeText(text); ok = true; } catch {
            // Async clipboard needs focus/permission; fall back to the legacy copy command.
            const ta = Object.assign(document.createElement('textarea'), { value: text });
            ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
            document.body.appendChild(ta);
            ta.select();
            try { ok = document.execCommand('copy'); } catch { /* unsupported */ }
            ta.remove();
          }
          setStatus(ok ? `Copied ${rows.length} rows.` : 'Clipboard blocked - use TSV download instead.', !ok);
        }
      });
    }
    ui.ready = true; // last: init steps only run against a fully wired drawer
  }

  const rowById = (id) => known.get(id) || cache?.find((r) => r.id === id) || null;

  function setView(view) {
    ui.view = view;
    for (const t of ui.tabs) t.setAttribute('aria-selected', String(t.dataset.view === view));
    const sl = view === 'shortlist';
    ui.controls.hidden = sl;
    ui.slBar.hidden = !sl;
    ui.panel.querySelector('.rf-clear').hidden = sl; // filters don't apply to the shortlist
    ui.panel.classList.toggle('rf-wide', sl && !!ui.compare);
    if (sl) renderShortlist();
    else if (cache) showResults();
    else { setEmpty(EMPTY_INTRO); setStatus(''); setExport(true); }
  }

  const shortlistRows = () => {
    const f = ui.slFilter.value;
    return marks.shortlist().filter((r) => !f || (f === '-' ? !r.appStatus : r.appStatus === f));
  };

  function renderShortlist() {
    const rows = shortlistRows();
    // Distance for the shortlist too (applyFilters isn't run over it).
    const anchor = parseAnchor(cfg.anchor);
    for (const r of rows) r.km = anchor && r.lat != null ? Math.round(haversineKm(anchor, r) * 10) / 10 : null;
    ui.rows = rows;
    setExport(rows.length === 0);
    ui.list.innerHTML = !rows.length ? '<div class="rf-empty">No shortlisted listings yet.<br>Use ☆ on any result to add one.</div>'
      : ui.compare ? compareHtml(rows.slice(0, COMPARE_MAX))
      : itemsHtml(rows.slice(0, RENDER_CHUNK)) + moreHtml(rows.length - RENDER_CHUNK);
    setStatus(rows.length ? `${rows.length} shortlisted across all searches. Details are as last seen.` : '');
  }

  const updateCounts = () => {
    const ags = marks.hiddenAgencies();
    const box = ui.panel.querySelector('.rf-agencies');
    box.hidden = !ags.length;
    box.querySelector('.rf-ag-list').innerHTML = ags.map((a) =>
      `<button type="button" class="rf-chip" data-unhide-ag="${esc(a)}" aria-label="Show ${esc(a)} again">${esc(a)} ×</button>`).join('');
    const c = marks.counts();
    ui.slCount.textContent = `(${c.starred})`;
    for (const el of ui.panel.querySelectorAll('[data-count]')) el.textContent = `(${c[el.dataset.count]})`;
  };

  // Inline note editor; Enter saves, Shift+Enter newline, Esc cancels (without closing the drawer).
  function editNote(item) {
    if (item.querySelector('.rf-note-edit')) return;
    const id = item.dataset.id;
    const ta = document.createElement('textarea');
    ta.className = 'rf-note-edit';
    ta.maxLength = NOTE_MAX;
    ta.placeholder = 'Note (Enter to save, Esc to cancel)';
    ta.setAttribute('aria-label', 'Note for this listing');
    ta.value = marks.note(id);
    item.querySelector('.rf-note')?.remove();
    item.appendChild(ta);
    ta.focus();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      if (save) marks.setNote(id, ta.value);
      refreshMarks();
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
      else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); }
    });
    ta.addEventListener('blur', () => finish(true));
  }

  function refreshMarks() {
    if (cache) marks.decorate(cache);
    marks.decorate([...known.values()]);
    knownVer++;
    updateCounts();
    const top = ui.list.scrollTop;
    const shown = ui.list.querySelectorAll('.rf-item').length;
    if (ui.view === 'shortlist') renderShortlist();
    else if (cache) showResults();
    while (ui.rows && ui.list.querySelectorAll('.rf-item').length < Math.min(shown, ui.rows.length)) renderMore();
    ui.list.scrollTop = top;
    scheduleAnnotate();
  }

  // One-shot Undo link in the status line.
  function offerUndo(msg, undo) {
    setStatus(msg);
    const b = Object.assign(document.createElement('button'), { className: 'rf-undo', textContent: 'Undo' });
    b.addEventListener('click', () => { b.remove(); undo(); }, { once: true });
    ui.status.appendChild(b);
  }

  const setExport = (disabled) => { for (const b of ui.exports) b.disabled = disabled; };

  const setStatus = (msg, isErr) => {
    ui.status.textContent = msg;
    ui.status.classList.toggle('err', !!isErr);
  };

  function showResults(note = '') {
    if (ui.view === 'shortlist') return; // results update in the background; shown on tab switch
    const err = cfgError(cfg);
    if (err) { render([]); return setStatus(err, true); }
    const rows = applyFilters(pool(), cfg);
    render(rows);
    const st = diffStats(cache);
    const since = baseAt ? ` since ${ago(Date.now() - baseAt)}` : '';
    const extra = [st.fresh && `${st.fresh} new${since}`, gone.length && `${gone.length} no longer listed`, st.moved && `${st.moved} price changed`,
      !cfg.showHidden && st.hidden && `${st.hidden} hidden`].filter(Boolean).join(' · ');
    setStatus(`${rows.length} of ${cache.length} listings match.${extra ? ` ${extra}.` : ''}` +
      (truncated ? ` Only the first ${MAX_PAGES} pages were read - narrow the search for full coverage.` : '') +
      (note ? ` ${note}` : ''));
    const warn = schemaWarnings(cache);
    if (warn.length) setStatus(`REA's data format may have changed (${warn.join('; ')}). Run reaFilter.probe() in the console and report the output.`, true);
  }

  function render(rows) {
    ui.rows = rows; // first: renderMore()/refreshMarks() read it even when the list is empty
    setExport(rows.length === 0);
    setLaunchCount(rows.length);
    if (!rows.length) return setEmpty('Nothing matches those filters.');
    ui.list.innerHTML = itemsHtml(rows.slice(0, RENDER_CHUNK)) + moreHtml(rows.length - RENDER_CHUNK);
    ui.list.scrollTop = 0;
  }

  // Side-by-side comparison: one column per listing, best value per row highlighted.
  const COMPARE_ROWS = [
    ['Rent', (r) => r.price, (r) => r.priceNum, 'min'],
    ['Per bed', (r) => ppbLabel(r) || (isFinite(r.ppb) ? `$${r.ppb}` : ''), (r) => r.ppb, 'min'],
    ['Move-in', (r) => (isFinite(r.upfront) ? `$${r.upfront.toLocaleString('en-AU')}` : ''), (r) => r.upfront, 'min'],
    ['Available', (r) => r.available, (r) => (r.avail ? +r.avail : Infinity), 'min'],
    ['Beds · baths · cars', (r) => [r.beds, r.baths, r.cars].map((v) => (v === '' ? '?' : v)).join(' · '), (r) => -(+r.beds || 0), 'min'],
    ['Distance', (r) => kmLabel(r).replace(' away', ''), (r) => r.km ?? Infinity, 'min'],
    ['Next inspection', (r) => r.inspections?.[0]?.label || '', null],
    ['Amenities', (r) => amenityTags(r).join(', '), null],
    ['Agency', (r) => r.agency || '', null],
    ['Status', (r) => (r.appStatus ? r.appStatus[0].toUpperCase() + r.appStatus.slice(1) : 'Not started'), null],
    ['Note', (r) => r.note || '', null],
  ];
  function compareHtml(rows) {
    const best = (score) => {
      const vals = rows.map(score).filter((v) => isFinite(v));
      const min = Math.min(...vals);
      // Only a "best" when it beats something: ties across every listing highlight nothing.
      return vals.length > 1 && vals.some((v) => v !== min) ? min : null;
    };
    const head = rows.map((r) => `<th scope="col"><a href="${esc(r.url)}" target="_blank" rel="noopener">${r.img ? `<img src="${esc(r.img)}" alt="">` : ''}<span>${esc(r.address)}</span></a></th>`).join('');
    const body = COMPARE_ROWS.map(([label, show, score]) => {
      const b = score ? best(score) : null;
      return `<tr><th scope="row">${label}</th>${rows.map((r) => `<td${b != null && score(r) === b ? ' class="rf-best"' : ''}>${esc(show(r)) || '<span class="rf-na">–</span>'}</td>`).join('')}</tr>`;
    }).join('');
    return `<div class="rf-compare"><table><thead><tr><td></td>${head}</tr></thead><tbody>${body}</tbody></table></div>` +
      (ui.rows.length > rows.length ? `<div class="rf-empty">Comparing the first ${rows.length}; filter by status to pick others.</div>` : '');
  }

  // Drawer renders in chunks: 500 cards at once is a ~80ms long task on every filter change.
  const moreHtml = (left) => (left > 0 ? `<button class="rf-btn sec rf-more-btn">Show ${Math.min(left, RENDER_CHUNK)} more (${left} left)</button>` : '');
  function renderMore() {
    const shown = ui.list.querySelectorAll('.rf-item').length;
    ui.list.querySelector('.rf-more-btn')?.remove();
    ui.list.insertAdjacentHTML('beforeend', itemsHtml(ui.rows.slice(shown, shown + RENDER_CHUNK)) + moreHtml(ui.rows.length - shown - RENDER_CHUNK));
  }

  function itemsHtml(rows) {
    return rows.map((r) => `
      <div class="rf-item${r.gone || r.hidden ? ' rf-hidden' : ''}${r.starred ? ' rf-starred' : ''}" data-id="${esc(r.id)}">
      <a class="rf-card" href="${esc(r.url)}" target="_blank" rel="noopener">
        ${r.img ? `<img src="${esc(r.img)}" alt="" loading="lazy">` : '<div></div>'}
        <div>
          <div class="rf-avail">${esc(r.available)}${r.gone ? '<span class="rf-tag rf-gone">no longer listed</span>' : isFresh(r) ? '<span class="rf-tag rf-new">new</span>' : ''}${r.relisted ? `<span class="rf-tag" title="Same address was listed before${r.relisted.price ? ` at ${esc(r.relisted.price)}` : ''}${r.relisted.hidden ? '; you had hidden it' : ''}">relisted</span>` : ''}${r.surrounding ? '<span class="rf-tag">nearby</span>' : ''}</div>
          <div class="rf-price">${esc(r.price)}${r.type ? ` <span class="rf-type">${esc(r.type)}</span>` : ''}${r.prevPrice ? ` <span class="rf-was ${priceDir(r)}" title="${esc(historyText(r))}">was ${esc(r.prevPrice)}</span>` : ''}</div>
          <div class="rf-addr">${esc(r.address)}</div>
          <div class="rf-meta">${esc([
            r.beds !== '' ? `${r.beds} bed` : '',
            r.baths !== '' ? `${r.baths} bath` : '',
            r.cars !== '' ? `${r.cars} car` : '',
            r.bond ? `bond ${r.bond}` : '',
            ppbLabel(r),
          ].filter(Boolean).join(' · '))}</div>
          ${kmLabel(r) || r.score != null ? `<div class="rf-meta">${esc(kmLabel(r))}${r.score != null ? `${kmLabel(r) ? ' · ' : ''}<span class="rf-score" title="${esc(r.scoreWhy)}">Match ${r.score}</span>` : ''}</div>` : ''}
          ${r.agency || r.photos != null || r.floorplan ? `<div class="rf-meta">${esc([r.agency,
            r.photos != null ? `${r.photos} photo${r.photos === 1 ? '' : 's'}` : '', r.floorplan ? 'floorplan' : ''].filter(Boolean).join(' · '))}</div>` : ''}
          ${amenityTags(r).length ? `<div class="rf-tags">${amenityTags(r).map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
          ${medianLabel(r) ? `<div class="rf-meta rf-med ${r.vsMedian < 0 ? 'down' : r.vsMedian > 0 ? 'up' : ''}">${esc(medianLabel(r))}</div>` : ''}
          ${isFinite(r.upfront) ? `<div class="rf-meta">Move-in $${r.upfront.toLocaleString('en-AU')}${r.bondWeeks > BOND_CAP_WEEKS ? ` <span class="rf-warn" title="Bond above ${BOND_CAP_WEEKS} weeks' rent; check your state's cap">bond ${r.bondWeeks} wks</span>` : ''}</div>` : ''}
          ${r.inspections?.length || r.listed ? `<div class="rf-meta">${esc([
            r.inspections?.length ? `Inspect ${r.inspections[0].label}${r.inspections.length > 1 ? ` +${r.inspections.length - 1}` : ''}` : '',
            r.listed ? `Listed ${ago(Date.now() - r.listed)}` : '',
          ].filter(Boolean).join(' · '))}</div>` : ''}
        </div>
      </a>
      ${r.starred ? `<label class="rf-app">Application <select data-app aria-label="Application status">${APP_STATUSES.map((v) =>
        `<option value="${v}"${v === r.appStatus ? ' selected' : ''}>${v ? v[0].toUpperCase() + v.slice(1) : 'Not started'}</option>`).join('')}</select></label>` : ''}
      ${r.note ? `<div class="rf-note">${esc(r.note)}</div>` : ''}
      <div class="rf-acts">
        <button data-act="n" title="${r.note ? 'Edit note' : 'Add a note'}" aria-label="${r.note ? 'Edit note' : 'Add note'}">Note</button>
        <button data-act="s" aria-pressed="${r.starred}" aria-label="Shortlist" title="${r.starred ? 'Remove from shortlist' : 'Add to shortlist'}">${r.starred ? '★' : '☆'}</button>
        <button data-act="h" title="${r.hidden ? 'Unhide' : 'Hide this listing'}">${r.hidden ? 'Unhide' : 'Hide'}</button>
        ${r.agency ? `<button data-act="ag" title="Hide every listing from ${esc(r.agency)}" aria-label="Hide agency ${esc(r.agency)}">Hide agency</button>` : ''}
      </div>
      </div>`).join('');
  }

  function fillTypes(rows) {
    const types = [...new Set(rows.map((r) => r.type).filter(Boolean))].sort();
    if (cfg.type && !types.includes(cfg.type)) types.unshift(cfg.type);
    ui.type.innerHTML = '<option value="">Any</option>' +
      types.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
    ui.type.value = cfg.type;
  }

  function adopt(key, rows, trunc, note, snap = null, observe = false) {
    learn(rows, observe);
    scheduleAnnotate();
    fillTypes(rows);
    cache = rows;
    applySnap(snap);
    withMedians(rows);
    truncated = trunc;
    cacheKey = key;
    ui.refresh.hidden = false;
    showResults(note);
  }

  // Apply a snapshot diff: flag rows new since the baseline, and hold the gone rows.
  function applySnap(info) {
    const ids = info?.newIds || new Set();
    for (const r of cache || []) r.sinceLast = ids.has(r.id);
    for (const r of known.values()) r.sinceLast = ids.has(r.id);
    gone = info?.gone || [];
    baseAt = info?.baseAt ?? null;
    knownVer++;
  }

  // Fresh rows from this tab's session cache. Returns hit.
  function restoreSession() {
    if (!isSearchPage(location.href)) return false;
    const key = searchKey(location.href);
    const hit = store.get(key);
    if (!hit) return false;
    adopt(key, hit.rows, hit.truncated, `Cached ${ago(Date.now() - hit.at)}.`, cfg.remember ? snaps.get(key) : null);
    return true;
  }

  // Session cache first, else the remembered results from a previous visit (no fetch).
  function restore() {
    if (restoreSession()) return true;
    if (!cfg.remember || !isSearchPage(location.href)) return false;
    const key = searchKey(location.href);
    const snap = snaps.get(key);
    if (!snap?.rows.length) return false;
    adopt(key, snap.rows, snap.truncated, `Saved ${ago(Date.now() - snap.at)}. Refresh for current listings.`, snap);
    return true;
  }

  // aria-disabled rather than disabled: a disabled button drops keyboard focus to <body>.
  let busy = false;
  const setBusy = (b) => {
    busy = b;
    for (const el of [ui.run, ui.refresh]) el.setAttribute('aria-disabled', String(b));
    ui.status.setAttribute('aria-busy', String(b)); // screen readers announce the result, not each page
  };

  let runCtrl = null; // AbortController of the in-flight search, aborted on navigation
  async function run(force = false) {
    if (!force && restoreSession()) return;
    runCtrl?.abort();
    const ctrl = runCtrl = new AbortController();
    const id = ++runId;
    const base = location.href;
    const key = searchKey(base);
    setBusy(true);
    setExport(true);
    try {
      if (force) pageMemo.clear();
      const onProgress = (m) => { if (id === runId) setStatus(m); };
      // Refresh means "newer than what I'm looking at", so the load-time seed is skipped too.
      const res = await fetchAllPages(base, onProgress, {
        seed: force || Date.now() - bootAt > ROWS_TTL_MS ? null : boot,
        signal: ctrl.signal,
        getPage: (url) => getPage(url, { signal: ctrl.signal, onRetry: (n, ms) => onProgress(`Retrying in ${Math.round(ms / 1000)}s (attempt ${n}/${RETRIES})…`) }),
      });
      if (id !== runId) return; // search changed mid-run; navigation handler already reported it
      if (res.sample) rawSample = res.sample;
      store.set(key, res.rows, res.truncated);
      adopt(key, res.rows, res.truncated, '', cfg.remember ? snaps.save(key, res.rows, res.truncated) : null, true);
    } catch (err) {
      if (id !== runId || ctrl.signal.aborted) return;
      cache = null;
      cacheKey = null;
      setLaunchCount(null);
      setStatus(err.message, true);
      if (ui.view !== 'shortlist') setEmpty('Search failed.');
    } finally {
      if (id === runId) setBusy(false);
      if (runCtrl === ctrl) runCtrl = null;
    }
  }

  // ------------------------------------------------------------ annotate
  // Adds a badge to REA's own result cards. Append-only (never reorders or removes
  // React-owned nodes) and idempotent, so the MutationObserver can't feed back on itself.

  const known = new Map(); // listing id -> row, from any source
  // pageUrl -> { at, p: Promise<results>, signal }; shared by annotation and full searches so a
  // page is fetched once per ROWS_TTL_MS. Failures are evicted so they can be retried.
  const pageMemo = new Map();
  const getPage = (url, opts) => {
    const hit = pageMemo.get(url);
    // An entry whose run was aborted is about to reject; don't hand it to a new caller.
    if (hit && !hit.signal?.aborted && Date.now() - hit.at < ROWS_TTL_MS) return hit.p;
    const p = fetchResults(url, opts).catch((e) => { if (pageMemo.get(url)?.p === p) pageMemo.delete(url); throw e; });
    pageMemo.delete(url); // re-insert so Map order stays oldest-first for eviction
    pageMemo.set(url, { at: Date.now(), p, signal: opts?.signal });
    if (pageMemo.size > PAGE_MEMO_MAX) pageMemo.delete(pageMemo.keys().next().value);
    return p;
  };
  let knownVer = 0;
  // Insertion-ordered; re-learning an id moves it to the end, oldest evicted past KNOWN_MAX.
  // `observe` = these rows are fresh from REA: record sightings and price changes. Rows
  // replayed from a cache or snapshot are only decorated, or stale prices would register.
  const learn = (rows, observe = true) => {
    if (observe) marks.observe(rows);
    marks.decorate(rows);
    for (const r of rows) if (r.id) { known.delete(r.id); known.set(r.id, r); }
    for (const k of known.keys()) { if (known.size <= KNOWN_MAX) break; known.delete(k); }
    knownVer++;
  };

  const badgeHtml = (r) => {
    const today = startOfDay();
    const avail = r.avail
      ? r.avail <= today ? '<span class="rf-b-now">Available now</span>' : `<span>Avail ${esc(r.available.replace(/^(from\s+)/i, ''))}</span>`
      : '<span class="rf-b-none">No date</span>';
    const insp = r.nextInspect ? `<span>Insp ${esc(fmtWhen(r.nextInspect))}</span>` : '';
    const ppb = ppbLabel(r) ? `<span>${ppbLabel(r)}</span>` : '';
    const star = r.starred ? '<span class="rf-b-star">★ Shortlisted</span>' : '';
    const fresh = isFresh(r) ? '<span class="rf-b-new">New</span>' : '';
    const moved = r.prevPrice ? `<span class="rf-b-${priceDir(r)}">Was ${esc(r.prevPrice)}</span>` : '';
    const pets = r.amen?.pets === 'yes' ? '<span class="rf-b-pets">Pets OK</span>' : '';
    const km = r.km != null ? `<span>${esc(kmLabel(r).replace(' away', ''))}</span>` : '';
    return star + fresh + avail + moved + pets + km + insp + ppb;
  };

  const filtersActive = () => FILTER_KEYS.some((k) => cfg[k]);

  // Match set only changes with cfg or known rows; mutation bursts reuse it.
  let matchMemo = { sig: null, set: null };
  const matchSet = () => {
    if (!cfg.dimCards || !filtersActive()) return null;
    const sig = knownVer + new Date().toDateString() + JSON.stringify(cfg); // day: rolling window moves at midnight
    if (matchMemo.sig !== sig) matchMemo = { sig, set: new Set(applyFilters([...known.values()], cfg).map((r) => r.id)) };
    return matchMemo.set;
  };

  // Card -> listing id. Prefer /property- links: an agent/agency link earlier in the
  // card can also end in a long number.
  function cardsOnPage() {
    const cards = new Map();
    for (const a of document.querySelectorAll('article a[href]')) {
      if (a.closest('#rf-panel')) continue;
      const href = a.getAttribute('href');
      const id = listingId(href);
      if (!id) continue;
      const card = a.closest('article');
      const prop = /\/property-/.test(href);
      const prev = cards.get(card);
      if (!prev || (prop && !prev.prop) || (!prev.known && known.has(id))) cards.set(card, { id, prop, known: known.has(id) });
    }
    return cards;
  }

  function annotate() {
    if (!isSearchPage(location.href)) return;
    const matches = matchSet();
    const anchor = parseAnchor(cfg.anchor);
    const cards = cardsOnPage();
    // Read phase: computed style for newly seen cards, before any writes (avoids layout thrash).
    const statics = new Set();
    for (const [card, { id }] of cards) {
      if (cfg.annotate && known.has(id) && card.dataset.rfId !== id && getComputedStyle(card).position === 'static') statics.add(card);
    }
    // Write phase.
    for (const [card, { id }] of cards) {
      const r = known.get(id);
      let badge = card.querySelector(':scope > .rf-badge');
      if (!cfg.annotate || !r) {
        if (badge) badge.remove();
        if (card.dataset.rfMatch) delete card.dataset.rfMatch;
        continue;
      }
      if (card.dataset.rfId !== id) {
        card.dataset.rfId = id;
        // Anchor the badge without overriding a position REA already set (eg virtualised lists).
        if (statics.has(card)) card.dataset.rfPos = '';
      }
      r.km = anchor && r.lat != null ? Math.round(haversineKm(anchor, r) * 10) / 10 : null;
      const html = badgeHtml(r);
      if (!badge) { badge = document.createElement('div'); badge.className = 'rf-badge'; card.appendChild(badge); }
      // Compare against what we wrote, not innerHTML (browser re-serialises entities).
      if (badge.dataset.rfHtml !== html) { badge.innerHTML = html; badge.dataset.rfHtml = html; }
      const m = (r.hidden || r.agencyHidden) && !cfg.showHidden ? '0' : matches ? (matches.has(id) ? '1' : '0') : '';
      if ((card.dataset.rfMatch || '') !== m) { if (m) card.dataset.rfMatch = m; else delete card.dataset.rfMatch; }
    }
  }

  // Debounced, but with a max wait: a page that mutates constantly (carousels, ad
  // rotators) would otherwise reset the timer forever and badges would never appear.
  let annotateTimer = null, firstPending = 0;
  const scheduleAnnotate = () => {
    const now = Date.now();
    if (!firstPending) firstPending = now;
    clearTimeout(annotateTimer);
    const fire = () => { firstPending = 0; annotateTimer = null; annotate(); };
    if (now - firstPending >= ANNOTATE_MAX_WAIT_MS) return fire();
    annotateTimer = setTimeout(fire, ANNOTATE_DEBOUNCE_MS);
  };

  // Make sure the page currently on screen has rows: session cache, boot doc, or one fetch.
  async function ensureVisiblePage() {
    if (!cfg.annotate || !isSearchPage(location.href)) return;
    const href = location.href;
    const key = searchKey(href), n = pageNum(href);
    if (cacheKey === key && cache) return scheduleAnnotate();
    if (boot && boot.key === key && boot.page === n && Date.now() - bootAt < ROWS_TTL_MS) return scheduleAnnotate();
    try { learn(rowsFrom(await getPage(pageUrl(href, n)))); } catch (e) { console.debug?.('[reaFilter] annotate fetch failed:', e); return; }
    if (location.href === href) scheduleAnnotate();
  }

  function watchCards() {
    new MutationObserver((muts) => {
      if (!isSearchPage(location.href)) return;
      // Ignore mutations confined to our own badges/panel.
      const ours = (m) => m.type === 'childList' && (m.target.closest?.('.rf-badge, #rf-panel, #rf-launch') ||
        m.removedNodes.length === 0 && m.addedNodes.length > 0 && [...m.addedNodes].every((n) => n.classList?.contains('rf-badge')));
      if (muts.every(ours)) return;
      scheduleAnnotate();
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
  }

  // REA is an SPA - invalidate cached rows (and any in-flight run) when the search URL changes.
  function watchNavigation() {
    let lastKey = currentKey();
    const fire = () => window.dispatchEvent(new Event('rf:navigate'));
    for (const fn of ['pushState', 'replaceState']) {
      const orig = history[fn];
      history[fn] = function (...args) { const r = orig.apply(this, args); fire(); return r; };
    }
    window.addEventListener('popstate', fire);
    window.addEventListener('rf:navigate', () => {
      const active = isSearchPage(location.href);
      ui.launch.hidden = !active;
      if (!active) ui.setOpen(false);
      setTimeout(ensureVisiblePage, NAV_SETTLE_MS);
      const key = currentKey();
      if (key === lastKey) return; // same search, different page/view
      lastKey = key;
      if (cacheKey && cacheKey === key) return;
      const hadState = cacheKey || busy;
      runCtrl?.abort(); // stop crawling the old search
      runId++;
      applySnap(null);
      cache = null;
      cacheKey = null;
      setBusy(false);
      ui.refresh.hidden = true;
      setExport(true);
      if (restore() || !hadState) return;
      setLaunchCount(null);
      if (ui.view === 'shortlist') return; // shortlist is search-independent
      setEmpty('Search changed.');
      setStatus('Search changed - run again to refresh.');
    });
  }

  // Console helpers: reaFilter.probe() shows which listing fields exist in live data.
  window.reaFilter = {
    version: (typeof GM_info !== 'undefined' && GM_info.script?.version) || 'dev',
    rows: () => cache,
    marks: () => marks.counts(),
    shortlist: () => marks.shortlist(),
    filtered: () => (cache ? applyFilters(pool(), cfg) : null), // same rows as the drawer
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

  // Each step isolated: a failure in one (eg REA drift) must not take the others down.
  const step = (name, fn) => { try { const r = fn(); if (r?.catch) r.catch((e) => console.warn(`[reaFilter] ${name}:`, e)); } catch (e) { console.warn(`[reaFilter] ${name}:`, e); } };
  step('build', build);
  if (ui?.ready) { // only wire the rest if build() completed
    step('launch', () => { ui.launch.hidden = !isSearchPage(location.href); ui.view = 'results'; updateCounts(); });
    step('boot', () => { if (boot) learn(rowsFrom(boot.results)); });
    step('navigation', watchNavigation);
    step('cards', watchCards);
    step('sync', () => window.addEventListener('storage', (e) => {
      // Another tab changed the shortlist/hidden/notes: pick it up here.
      if (e.key === MARKS_KEY || e.key === null) { marks.invalidate(); refreshMarks(); }
    }));
    step('restore', restore);
    step('annotate', ensureVisiblePage);
  }
})();

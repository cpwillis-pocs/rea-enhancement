// ==UserScript==
// @name         REA Availability Filter
// @namespace    https://github.com/cpwillis/rea-enhancement
// @version      2.13.0
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
  const ROW_INFINITE = ['priceNum', 'ppb', 'upfront', 'bondNum']; // "unknown" numbers held as Infinity
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
          for (const k of ROW_INFINITE) r[k] = r[k] ?? Infinity; // JSON stores Infinity as null
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
  // Past sessions drop out (stored summaries age), so later ones aren't crowded out by the cap.
  const cleanInspections = (a) => (Array.isArray(a) ? a : [])
    .map((i) => ({ at: typeof i?.at === 'number' ? i.at : null, label: clip(i?.label, 80) }))
    .filter((i) => i.label && (i.at == null || i.at >= Date.now() - INSPECT_GRACE_MS)).slice(0, INSPECT_KEEP);
  const clip = (v, n = 300) => (typeof v === 'string' ? v.slice(0, n) : '');
  const summary = (r) => ({
    u: safeUrl(r.url), a: clip(r.address), p: clip(r.price, 80), v: clip(r.available, 80), i: safeUrl(r.img),
    t: clip(r.type, 40), b: scalar(r.beds), ba: scalar(r.baths), c: scalar(r.cars), su: clip(r.suburb, 80),
    in: cleanInspections(r.inspections), w: clip(r.watch, 80),
    bo: clip(r.bond, 40), la: typeof r.lat === 'number' ? r.lat : null, ln: typeof r.lng === 'number' ? r.lng : null,
    am: AMENITIES.filter((a) => r.amen?.[a.id] === 'yes').map((a) => a.id), ag: clip(r.agency, 80),
  });
  const APP_STATUSES = ['', 'to inspect', 'inspected', 'applied', 'approved', 'declined'];
  const MARK_FIELDS = ['s', 'st', 'd', 'h', 'as', 'ast']; // user choices a bulk action can change
  const BULK_STAR_MAX = 50; // "shortlist all shown" cap, so one click can't flood the shortlist
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
    inspections: cleanInspections(d.in), watch: typeof d.w === 'string' ? d.w : '', bond: d.bo, lat: typeof d.la === 'number' ? d.la : null, lng: typeof d.ln === 'number' ? d.ln : null, agency: d.ag,
    amen: Array.isArray(d.am) ? Object.fromEntries(AMENITIES.map((a) => [a.id, d.am.includes(a.id) ? 'yes' : null])) : {},
  });
  const YEARLESS_SKIP_DAYS = 300; // a jump this far out from "now" is a yearless date rolling over
  const dayNum = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS; // local calendar day, DST-proof
  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const marksStore = (storage, now = () => Date.now()) => {
    let data = null;
    const load = () => {
      if (data) return data;
      try { data = JSON.parse(storage.getItem(MARKS_KEY)); } catch { data = null; }
      if (!isObj(data) || !isObj(data.m)) data = { c: now(), m: {} };
      // One bad entry (hand-edited, or a half-written sync) mustn't break every later write.
      for (const [id, e] of Object.entries(data.m)) if (!isObj(e)) delete data.m[id];
      if (data.ad != null && !isObj(data.ad)) delete data.ad;
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
          delete e.x; // seen again, so not gone
          if (e.s) e.d = summary(r); // keep the shortlist's copy current
          if (Number.isFinite(r.priceNum)) {
            if (e.p != null && e.p !== r.priceNum) {
              // History only once the price actually changes (seeded with the previous price), so
              // the thousands of listings that never change cost nothing extra in storage.
              const ph = Array.isArray(e.ph) && e.ph.length ? e.ph : [[e.pt || e.f || t, clip(e.ps, 80)]];
              e.ph = [...ph, [t, clip(r.price, 80)]].slice(-PRICE_HISTORY_MAX);
              e.pp = e.p; e.pps = e.ps; e.pt = t;
            }
            e.p = r.priceNum;
            e.ps = r.price;
          }
          // Availability date as a day number (0 = available now). Moving to "now" once the old
          // date has arrived is just time passing, not a change.
          if (r.avail instanceof Date && !isNaN(r.avail)) {
            const today = dayNum(new Date(t)), day = dayNum(r.avail);
            const av = day <= today ? 0 : day;
            // A yearless date ("20th Jul") that has passed rolls into next year: not a change either.
            const rolled = e.av === 0 && av - today > YEARLESS_SKIP_DAYS;
            if (e.av != null && e.av !== av && !(av === 0 && e.av <= today) && !rolled) { e.pav = e.av; e.avt = t; e.avd = av > (e.av || today) ? 'later' : 'sooner'; }
            if (!rolled) e.av = av;
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
        const { m, ag, sb } = load();
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
          r.agencyHidden = !!(r.agency && ag?.[agencyKey(r.agency)]);
          r.suburbHidden = !!(r.suburb && sb?.[agencyKey(r.suburb)]);
          r.firstSeen = e?.f ? new Date(e.f) : null;
          // "New" is per search (see snapshotStore); here only REA's own listed date counts.
          r.isNew = r.listed instanceof Date && t - r.listed < NEW_MS;
          r.prevPrice = e && e.pp != null && e.pp !== e.p && e.pt && t - e.pt < PRICE_CHANGE_MS ? e.pps || `$${e.pp}` : '';
          r.priceDelta = r.prevPrice ? e.p - e.pp : 0;
          const availMoved = e && e.pav != null && e.avt && t - e.avt < PRICE_CHANGE_MS && e.pav !== e.av;
          r.prevAvail = availMoved ? (e.pav === 0 ? 'now' : new Date(e.pav * DAY_MS).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' })) : '';
          r.availDir = availMoved ? e.avd || ((e.av || 0) > (e.pav || 0) ? 'later' : 'sooner') : '';
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
      // Re-check outcome: gone (REA took it down) or seen again (clears gone).
      setGone(id, gone) {
        const { m } = fresh();
        const e = entry(m, id);
        if (gone) e.x = now(); else delete e.x;
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
            // Hand-edited or half-written summaries: text fields must be strings, numbers stay numbers.
            const NUM = ['b', 'ba', 'c', 'la', 'ln'], KEEP = ['in', 'am'];
            const d = Object.fromEntries(Object.entries(e.d).map(([k, v]) => [k, KEEP.includes(k) ? v
              : NUM.includes(k) ? (typeof v === 'number' || typeof v === 'string' ? v : '') : typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '']));
            const priceNum = parsePrice(clip(d.p, 80));
            return {
              ...fromSummary(d), id, suburb: d.su || '', priceNum, available: d.v || '-', avail: parseAvail(d.v),
              beds: d.b ?? '', baths: d.ba ?? '', cars: d.c ?? '', bond: d.bo || '', ppb: perBed(priceNum, d.b),
              ...moveIn(d.bo, priceNum), agency: d.ag || '',
              starred: true, hidden: !!e.h, note: e.n || '', appStatus: e.as || '', listed: null, lastSeen: e.l || null,
              gone: !!e.x, goneAt: e.x || null,
              inspections: cleanInspections(d.in).filter((i) => i.label && (i.at == null || i.at >= now() - INSPECT_GRACE_MS)),
            };
          });
      },
      // Backup/restore of what the user chose (shortlist, hidden, notes); sighting history is not exported.
      exportData() {
        const { m } = load();
        const out = {};
        for (const [id, e] of Object.entries(m)) {
          if (keep(e)) out[id] = { x: e.x, s: e.s ? 1 : undefined, st: e.st, h: e.h ? 1 : undefined, n: e.n, as: e.as, ast: e.ast, d: e.s ? e.d : undefined };
        }
        return { app: 'rea-enhancement', kind: 'marks', v: 1, exported: new Date(now()).toISOString(), m: out, ag: load().ag || {}, sb: load().sb || {} };
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
          if (typeof e.x === 'number') cur.x = e.x;
          if (typeof e.n === 'string' && e.n.trim()) cur.n = clip(e.n.trim(), NOTE_MAX);
          if (APP_STATUSES.includes(e.as) && e.as) { cur.as = e.as; cur.ast = +e.ast || now(); }
          n++;
        }
        if (src.sb && typeof src.sb === 'object') {
          const d = load();
          d.sb = d.sb && typeof d.sb === 'object' ? d.sb : {};
          for (const raw of Object.values(src.sb)) { const name = clip(raw, 60); if (agencyKey(name)) d.sb[agencyKey(name)] = name; }
        }
        if (src.ag && typeof src.ag === 'object') {
          const d = load();
          d.ag = d.ag && typeof d.ag === 'object' ? d.ag : {};
          for (const raw of Object.values(src.ag)) {
            const name = clip(raw, 80); // key the clipped name, the same one shown and toggled
            if (agencyKey(name)) d.ag[agencyKey(name)] = name;
          }
        }
        save();
        return n;
      },
      counts() {
        const { m } = load();
        let starred = 0, hidden = 0, notes = 0;
        for (const e of Object.values(m)) { if (e.s) starred++; if (e.h) hidden++; if (e.n) notes++; }
        return { starred, hidden, notes };
      },
      // Hidden agencies live beside the per-listing marks: data.ag = { normalisedName: displayName }.
      toggleAgency(raw) {
        const name = clip(raw, 80);
        const k = agencyKey(name);
        if (!k) return false;
        const d = fresh();
        d.ag = d.ag && typeof d.ag === 'object' ? d.ag : {};
        if (d.ag[k]) delete d.ag[k]; else d.ag[k] = name;
        save();
        return !!d.ag[k];
      },
      hiddenAgencies: () => Object.values(load().ag || {}),
      toggleSuburb(raw) {
        const name = clip(raw, 60), k = agencyKey(name);
        if (!k) return false;
        const d = fresh();
        d.sb = d.sb && typeof d.sb === 'object' ? d.sb : {};
        if (d.sb[k]) delete d.sb[k]; else d.sb[k] = name;
        save();
        return !!d.sb[k];
      },
      hiddenSuburbs: () => Object.values(load().sb || {}),
      // Bulk: set s (shortlist) or h (hidden) explicitly on many rows in one write.
      setMany(rows, k, on) {
        const { m } = fresh();
        let n = 0;
        for (const r of rows) {
          if (!r.id) continue;
          const e = entry(m, r.id);
          if (!!e[k] === on) continue;
          e[k] = on ? 1 : 0;
          if (k === 's') { if (on) { e.st = now(); e.d = summary(r); } else delete e.st; }
          n++;
        }
        save();
        return n;
      },
      setStatusMany(ids, status) {
        if (!APP_STATUSES.includes(status)) return 0;
        const { m } = fresh();
        for (const id of ids) { const e = entry(m, id); if (status) { e.as = status; e.ast = now(); } else { delete e.as; delete e.ast; } }
        save();
        return ids.length;
      },
      // Undo for bulk actions: snapshot only the user-choice fields of the listings touched, so
      // restoring can't wipe changes made meanwhile to other listings (eg in another tab).
      dump(ids) {
        const { m } = fresh();
        return JSON.stringify(Object.fromEntries(ids.map((id) => [id, m[id]
          ? Object.fromEntries(MARK_FIELDS.filter((k) => k in m[id]).map((k) => [k, m[id][k]])) : null])));
      },
      restoreDump(json) {
        let snap;
        try { snap = JSON.parse(json); } catch { return; }
        const { m } = fresh();
        for (const [id, old] of Object.entries(snap || {})) {
          if (!old && !m[id]) continue;
          const cur = entry(m, id);
          for (const k of MARK_FIELDS) { if (old && k in old) cur[k] = old[k]; else delete cur[k]; }
        }
        save();
      },
    };
  };

  // Remembered results per search, across sessions. Each save diffs against a baseline:
  // the previous *visit's* ids (runs within SNAP_VISIT_GAP_MS of each other share one
  // baseline, so refreshing twice doesn't wipe the "new" tags). `gone` = baseline rows no
  // longer listed.
  const SNAP_FIELDS = ['id', 'url', 'address', 'suburb', 'price', 'priceNum', 'ppb', 'available', 'bond', 'beds', 'baths',
    'cars', 'type', 'img', 'surrounding', 'inspect', 'agency', 'lat', 'lng', 'photos', 'floorplan', 'watch'];
  const slimRow = (r) => {
    const o = {};
    for (const k of SNAP_FIELDS) o[k] = typeof r[k] === 'string' ? clip(r[k], SNAP_TEXT_MAX) : r[k];
    for (const k of ROW_DATES) o[k] = r[k] instanceof Date && !isNaN(r[k]) ? r[k].getTime() : null;
    o.headline = clip(r.headline, 160);
    o.text = clip(r.text, SNAP_TEXT_MAX);
    o.inspections = cleanInspections(r.inspections);
    o.features = (Array.isArray(r.features) ? r.features : []).slice(0, 40).map((f) => clip(f, 80));
    // Stored as computed: the text kept here is clipped, so recomputing could miss a late "no pets".
    o.amen = Object.fromEntries(AMENITIES.map((a) => [a.id, r.amen?.[a.id] ?? null]));
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
    // Stored next-inspection time and text go stale as sessions pass: derive them again.
    if (Array.isArray(o?.inspections)) {
      const nx = r.inspections.find((i) => i.at != null);
      r.nextInspect = nx ? new Date(nx.at) : null;
      r.inspect = r.inspections.map((i) => i.label).join('; ');
    }
    r.features = (Array.isArray(o?.features) ? o.features : []).filter((f) => typeof f === 'string').slice(0, 40).map((f) => clip(f, 80));
    r.lat = typeof o?.lat === 'number' ? o.lat : null;
    r.lng = typeof o?.lng === 'number' ? o.lng : null;
    r.photos = typeof o?.photos === 'number' ? o.photos : null;
    r.floorplan = typeof o?.floorplan === 'boolean' ? o.floorplan : null;
    const stored = o?.amen && typeof o.amen === 'object'
      ? Object.fromEntries(AMENITIES.map((a) => [a.id, o.amen[a.id] === 'yes' || o.amen[a.id] === 'no' ? o.amen[a.id] : null])) : null;
    r.amen = stored || amenitiesOf({ features: r.features, amenText: r.address ? r.text.replace(r.address.toLowerCase(), ' ') : r.text });
    return r;
  };
  const isSearchKey = (k) => typeof k === 'string' && k.startsWith('https://www.realestate.com.au/rent/') && k.length < SEARCH_KEY_MAX;

  // "property-house-with-2-bedrooms-in-bondi,+nsw+2026;+manly,+nsw+2095" -> "Bondi NSW 2026, Manly NSW 2095 · house, 2 bedrooms"
  const searchLabel = (key) => {
    let seg = '';
    try { seg = decodeURIComponent(new URL(key).pathname.split('/')[2] || '').replace(/\+/g, ' '); } catch { return String(key); }
    const m = seg.match(/^(?:(.*?)-)?in-(.+)$/);
    const title = (w) => w.replace(/\b([a-z])([a-z]*)\b/g, (x, a, b) => (/^(nsw|act|vic|tas|qld|sa|wa|nt)$/.test(x) ? x.toUpperCase() : a.toUpperCase() + b));
    if (!m) return title(seg.replace(/-/g, ' ')) || 'Search';
    const places = m[2].split(';').map((p) => title(p.replace(/,/g, '').trim())).filter(Boolean).join(', ');
    const what = (m[1] || '').replace(/^property-?/, '').replace(/-with-/, ', ').replace(/-/g, ' ').trim();
    return what ? `${places} · ${what}` : places;
  };

  // Everything this tool keeps in a storage area: keys share the prefix, so it can be measured
  // and removed without touching REA's own data. Sizes are UTF-16 (2 bytes a character).
  const TOOL_PREFIX = 'rea-avail-filter/';
  const toolKeys = (storage) => {
    const out = [];
    try { for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k && k.startsWith(TOOL_PREFIX)) out.push(k); } } catch { /* blocked */ }
    return out;
  };
  const toolBytes = (storage) => toolKeys(storage).reduce((n, k) => { try { return n + 2 * (k.length + (storage.getItem(k) || '').length); } catch { return n; } }, 0);
  const fmtBytes = (b) => (b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${Math.round(b / 1024)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);

  const snapshotStore = (storage, now = () => Date.now()) => {
    const load = () => {
      try {
        const d = JSON.parse(storage.getItem(SNAP_KEY));
        if (isObj(d) && isObj(d.s)) {
          for (const [k, e] of Object.entries(d.s)) {
            if (!isSearchKey(k) || !isObj(e) || typeof e.at !== 'number') { delete d.s[k]; continue; }
            for (const f of ['rows', 'gone']) e[f] = Array.isArray(e[f]) ? e[f].filter(isObj) : [];
            for (const f of ['ids', 'baseIds']) if (e[f] != null && !Array.isArray(e[f])) e[f] = f === 'ids' ? [] : null;
          }
          return d;
        }
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

  // Named filter presets; a preset with `key` auto-applies on that search.
  const PRESETS_KEY = 'rea-avail-filter/presets/v1';
  const PRESETS_MAX = 30;
  const presetStore = (storage) => {
    const load = () => {
      try {
        const d = JSON.parse(storage.getItem(PRESETS_KEY));
        if (Array.isArray(d?.list)) { d.list = d.list.filter((p) => isObj(p) && typeof p.name === 'string' && p.name && isObj(p.cfg)); return d; }
      } catch { /* corrupt */ }
      return { v: 1, list: [] };
    };
    const save = (d) => { try { storage.setItem(PRESETS_KEY, JSON.stringify(d)); } catch { /* quota/blocked */ } };
    const pick = (cfg) => Object.fromEntries([...FILTER_KEYS, 'anchor', 'sort'].filter((k) => k in cfg).map((k) => [k, cfg[k]]));
    return {
      list: () => load().list,
      save(name, cfg, key = null) {
        const n = clip(String(name || '').trim(), 60);
        if (!n) return null;
        const d = load();
        d.list = d.list.filter((p) => p.name !== n && !(key && p.key === key)); // one bound preset per search
        d.list.unshift({ name: n, cfg: sanitizeCfg(pick(cfg)), key: key && isSearchKey(key) ? key : null });
        d.list = d.list.slice(0, PRESETS_MAX);
        save(d);
        return n;
      },
      remove(name) { const d = load(); d.list = d.list.filter((p) => p.name !== name); save(d); },
      get: (name) => load().list.find((p) => p.name === name) || null,
      forSearch: (key) => load().list.find((p) => p.key === key) || null,
      exportData: () => load().list,
      importData(list) {
        if (!Array.isArray(list)) return 0;
        // Imported presets win (a restore is deliberate): they go first, replacing same-named
        // ones and any existing preset bound to the same search.
        const d = load();
        const incoming = [];
        for (const p of list.slice(0, PRESETS_MAX)) {
          const name = clip(String(p?.name || '').trim(), 60);
          if (!name || !isObj(p.cfg) || incoming.some((x) => x.name === name)) continue;
          const key = isSearchKey(p.key) && !incoming.some((x) => x.key === p.key) ? p.key : null;
          incoming.push({ name, cfg: sanitizeCfg(pick(p.cfg)), key });
        }
        d.list = [...incoming, ...d.list.filter((x) => !incoming.some((p) => p.name === x.name || (p.key && p.key === x.key)))].slice(0, PRESETS_MAX);
        save(d);
        return incoming.length;
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
    const m = html.match(EXCHANGE_RE);
    if (!m) throw new Error('Hydration blob missing - probably a bot-check interstitial. Reload the page and retry.');
    return parseExchange(JSON.parse(m[1]));
  }

  const PAGE_SEG = /\/(?:list|map)-(\d+)/; // results page segment, eg /list-3 or /map-1
  // Listing (property) pages: their hydration blob belongs to a different REA app whose shape
  // we don't know, so nested JSON strings are unpacked and the listing is found by shape:
  // an object with a price/availability display whose canonical id matches.
  // Two limits: JSON-in-string unpacking (the blob nests 2-3 levels) and plain object nesting.
  const UNPACK_PARSES = 4, UNPACK_NEST = 40;
  const unpackJson = (v, parses = 0, nest = 0) => {
    if (nest > UNPACK_NEST) return v;
    if (typeof v === 'string' && parses < UNPACK_PARSES && /^\s*[[{]/.test(v)) {
      try { return unpackJson(JSON.parse(v), parses + 1, nest + 1); } catch { return v; }
    }
    if (Array.isArray(v)) return v.map((x) => unpackJson(x, parses, nest + 1));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unpackJson(x, parses, nest + 1)]));
    return v;
  };
  const LISTING_SCAN_NODES = 20000;
  function findListing(root, id) {
    const queue = [root];
    for (let qi = 0; qi < queue.length && qi < LISTING_SCAN_NODES; qi++) {
      const o = queue[qi];
      if (!o || typeof o !== 'object') continue;
      const own = listingId(str(o._links?.canonical?.href)) || (o.id != null ? String(o.id) : '');
      if (own === id && (o.price || o.availableDate)) return o;
      for (const v of Object.values(o)) if (v && typeof v === 'object') queue.push(v);
    }
    return null;
  }
  // -> { status: 'ok', listing } | { status: 'gone' } | { status: 'unknown' }
  const EXCHANGE_RE = /window\.ArgonautExchange=(\{.*?\});?<\/script>/s;
  function parseListingPage(html, id, { status = 200, redirectedTo = '' } = {}) {
    if (status === 404 || status === 410) return { status: 'gone' };
    if (redirectedTo && !/\/property-/.test(new URL(redirectedTo).pathname)) return { status: 'gone' }; // bounced to a search
    const m = html.match(EXCHANGE_RE);
    if (!m) return { status: 'unknown' };
    try {
      const listing = findListing(unpackJson(JSON.parse(m[1])), id);
      return listing ? { status: 'ok', listing } : { status: 'unknown' };
    } catch { return { status: 'unknown' }; }
  }

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
    if (typeof raw === 'number' && raw < 1e9) return null; // counts/flags, not epoch times (1e9 s = 2001)
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
  // Subtrees describing other people/places: their coordinates, names and dates aren't the listing's.
  const DISCOVER_SKIP = /lister|agent|agenc|company|brand|advertis|school|nearby|similar|history|related|suggest/i;
  const NO_SKIP = /$^/;
  const discover = (obj, keyRe, ok = () => true, skip = DISCOVER_SKIP, stats = null) => {
    const queue = [[obj, '', 0]];
    let seen = 0;
    for (let qi = 0; qi < queue.length && seen < DISCOVER_NODES; qi++) { // index cursor: shift() is O(n)
      const [node, path, depth] = queue[qi];
      if (!node || typeof node !== 'object') continue;
      for (const k of Object.keys(node)) {
        const v = node[k];
        seen++;
        const p = path ? `${path}.${k}` : k;
        if (keyRe.test(k)) {
          if (ok(v)) return { path: p, value: v };
          if (stats) stats.keyed = true; // the key is there, just empty on this listing
        }
        // A null or empty branch may hold the field on a sibling listing of the same shape.
        if (stats && !skip.test(k) && (v == null || (typeof v === 'object' && !Object.keys(v).length))) stats.empty = true;
        if (v && typeof v === 'object' && depth + 1 < DISCOVER_DEPTH && !skip.test(k)) queue.push([v, p, depth + 1]);
      }
    }
    if (stats && seen >= DISCOVER_NODES) stats.partial = true;
    return null;
  };
  const found = {}; // field -> discovered path, for probe()
  const pathHint = {}; // field -> last discovered path, tried first on the next listing
  const misses = new Map(); // field -> Set of listing shapes where discovery found nothing
  const MISS_SHAPES_MAX = 50;
  const atPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
  // Discovery with two shortcuts: REA listings on a page share a shape, so reuse the path
  // that worked last time, and don't re-walk a shape that already came up empty.
  const find = (field, obj, keyRe, ok, skip) => {
    const hint = pathHint[field];
    if (hint) {
      const v = atPath(obj, hint);
      if (v !== undefined && ok(v)) { if (!found[field]) found[field] = hint; return v; }
    }
    const shape = Object.keys(obj || {}).sort().join(',');
    const miss = misses.get(field) || new Set();
    if (miss.has(shape)) return undefined;
    const stats = {};
    const hit = discover(obj, keyRe, ok, skip, stats);
    if (hit) { pathHint[field] = hit.path; if (!found[field]) found[field] = hit.path; return hit.value; }
    // Only a shape with no matching key at all is a reliable miss for its siblings.
    if (!stats.keyed && !stats.empty && !stats.partial && miss.size < MISS_SHAPES_MAX) miss.add(shape);
    misses.set(field, miss);
    return undefined;
  };

  const startOf = (it) => toDate(it?.startTime ?? it?.startTimeUtc ?? it?.start ?? it?.dateTime ?? it?.startsAt);
  const inspectionList = (src) => (Array.isArray(src) ? src : Array.isArray(src?.items) ? src.items : Array.isArray(src?.inspections) ? src.inspections : null);

  function extractInspections(listing, now = new Date()) {
    let src = listing.inspections ?? listing.inspectionTimes ?? listing.openHomes ?? listing.inspectionsAndAuctions?.inspections;
    // A discovered list must look like times, not eg "Book an inspection" options.
    if (!inspectionList(src)) src = find('inspections', listing, /inspection|openhome|open_home/i,
      (v) => !!inspectionList(v)?.some((it) => startOf(it)));
    const list = inspectionList(src) || [];
    const cutoff = now.getTime() - INSPECT_GRACE_MS;
    return list
      .map((it) => {
        const at = startOf(it);
        const label = str(it?.display?.shortLabel) || str(it?.display?.longLabel) || str(it?.display) || str(it?.label) || (at ? fmtWhen(at) : '');
        return { at: at ? at.getTime() : null, label };
      })
      .filter((i) => i.label && (i.at == null || i.at >= cutoff))
      .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
  }

  const LISTED_KEY = /^(date)?(first)?listed(at|date|on)?$|^listing(date|start)$|^datefirstlisted$/i;
  const extractListed = (listing) =>
    toDate(listing.dateListed ?? listing.listedDate ?? listing.listingDate ?? listing.dateFirstListed ?? listing.listedAt) ??
    toDate(find('listed', listing, LISTED_KEY, (v) => !!toDate(v)));

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
    coordsOf(find('coords', listing, /location|geo|coord|address/i, (v) => !!coordsOf(v))) || null;

  // Agency name: listingCompany/agency objects, else any *agency*/*company* object with a name.
  const nameOf = (o) => str(o?.name) || str(o?.displayName) || str(o?.brandName) || (typeof o === 'string' ? o : '');
  const extractAgency = (listing) => clip(
    nameOf(listing.listingCompany) || nameOf(listing.agency) || nameOf(listing.agencies?.[0]) ||
    // Objects only: a string under an "agency*" key is usually an id, type, colour or URL.
    nameOf(find('agency', listing, /agenc|listingcompany|company|brand/i, (v) => v && typeof v === 'object' && !!nameOf(v), NO_SKIP)), 80);

  // Feature labels (strings) from any features/amenities arrays.
  const featureLabel = (f) => {
    const l = typeof f === 'string' ? f : str(f?.displayLabel) || str(f?.label) || str(f?.name) || str(f?.featureName) || str(f?.value) || '';
    return /^https?:/i.test(l) ? '' : l; // image URLs under "featured*" keys aren't features
  };
  const extractFeatures = (listing) => {
    const srcs = [listing.propertyFeatures, listing.features, listing.generalFeatures?.features, listing.keyFeatures];
    if (!srcs.some(Array.isArray)) srcs.push(find('features', listing, /feature|amenit/i, (v) => Array.isArray(v) && v.some((x) => featureLabel(x))));
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

  // Heads-up: terms in the listing text worth asking the agent about. Plain text matches, so a
  // tag means "mentioned", never a verdict ("no application fee" is not flagged).
  const WATCHOUTS = [
    { id: 'short', label: 'Short lease', re: /\b(?:3|6|three|six)[- ]?months?\s+(?:lease|tenancy)|\bshort[- ]term (?:lease|rental|tenancy)/ },
    { id: 'water', label: 'Water usage charged', re: /water (?:usage|consumption)[^.]{0,30}?\b(?:charged|payable|paid by|extra|additional|on top)/ },
    { id: 'fee', label: 'Fee mentioned', re: /(?<!\bno\s)(?<!\bfree\s)\b(?:application|holding|admin(?:istration)?|reservation) fees?\b(?!\s*(?:free|waived))/ },
    { id: 'bid', label: 'Invites higher offers', re: /\b(?:offers?|bids?) (?:above|over|in excess of)|\brent bidding|\bhighest offer|\bbest offer/ },
    { id: 'strata', label: 'Subject to strata approval', re: /subject to (?:strata|body corporate|owners? corporation) approval/ },
    { id: 'break', label: 'Lease-break terms', re: /\bbreak(?:[- ]lease)? fee|\blease[- ]break (?:fee|cost|clause)/ },
  ];
  const watchOf = (text) => WATCHOUTS.filter((w) => w.re.test(String(text || '').toLowerCase())).map((w) => w.id);
  const watchIds = (v) => String(v || '').split(',').filter((id) => WATCHOUTS.some((w) => w.id === id));
  const watchTags = (r) => String(r.watch || '').split(',').map((id) => WATCHOUTS.find((w) => w.id === id)?.label).filter(Boolean);

  const kmFrom = (anchor, r) => (anchor && r.lat != null ? Math.round(haversineKm(anchor, r) * 10) / 10 : null);

  // Distance from a user-chosen point. Accepts "-33.87, 151.21" or a Google Maps URL/text
  // containing "@-33.87,151.21" (no geocoding: nothing leaves the browser).
  const parseAnchor = (v) => {
    const s = String(v || '').replace(/[−–]/g, '-');
    // Google Maps place URLs: the pin is !3d<lat>!4d<lng>; "@lat,lng" is only the map centre.
    const pin = s.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
    if (pin && inAu(+pin[1], +pin[2])) return { lat: +pin[1], lng: +pin[2] };
    // "lat, lng", "lat lng", "lat;lng", degrees with N/S/E/W, or lng-first.
    for (const m of s.matchAll(/(-?\d{1,3}\.\d+)\s*°?\s*([NS]\b)?\s*(?:[,;]\s*|\s+)(-?\d{1,3}\.\d+)\s*°?\s*([EW]\b)?/gi)) {
      const a = +m[1] * (/s/i.test(m[2] || '') ? -1 : 1), b = +m[3] * (/w/i.test(m[4] || '') ? -1 : 1);
      if (inAu(a, b)) return { lat: a, lng: b };
      if (inAu(b, a)) return { lat: b, lng: a };
    }
    return null;
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
    row.watch = watchOf([row.headline, str(listing.description), ...row.features].join(' ')).join(',');
    row.amen = amenitiesOf({ features: row.features, amenText: [row.headline, str(listing.description)].filter(Boolean).join(' ') });
    return row;
  };

  // Coercers for fields REA might reshape: anything unexpected becomes ''.
  const str = (v) => (typeof v === 'string' ? v : typeof v?.display === 'string' ? v.display : '');
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
    remember: true, newOnly: false, changedOnly: false, noWatch: '', showGone: false, income: '',
  };

  // Saved settings are only trusted per key and type: a stale or hand-edited value (eg
  // keyword: null) falls back to the default instead of throwing on every render.
  const sanitizeCfg = (c) => (c && typeof c === 'object'
    ? Object.fromEntries(Object.keys(DEFAULT_CFG).filter((k) => typeof c[k] === typeof DEFAULT_CFG[k]).map((k) => [k, c[k]]))
    : {});

  // cfg keys that narrow results (FILTER_KEYS), live under "More filters" (MORE_KEYS), or
  // are display preferences that Clear keeps (DISPLAY_PREFS).
  const FILTER_KEYS = ['from', 'to', 'withinDays', 'priceMin', 'priceMax', 'upfrontMax', 'bedsMin', 'bathsMin', 'carsMin', 'type', 'keyword',
    'inspectOn', 'hideNoImage', 'exactOnly', 'onlyStarred', 'newOnly', 'changedOnly', 'staleOnly', 'amenities', 'noWatch', 'maxKm', 'floorplanOnly'];
  const MORE_KEYS = ['priceMin', 'priceMax', 'upfrontMax', 'bedsMin', 'bathsMin', 'carsMin', 'type', 'keyword', 'hideNoImage', 'inspectOn',
    'onlyStarred', 'showHidden', 'newOnly', 'changedOnly', 'noWatch', 'showGone', 'staleOnly', 'amenities', 'anchor', 'maxKm', 'floorplanOnly'];
  const DISPLAY_PREFS = ['sort', 'annotate', 'dimCards', 'remember', 'anchor', 'income']; // Clear keeps your "from" point

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
      if (r.surrounding || !Number.isFinite(r.priceNum) || r.beds === '') continue;
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
      r.vsMedian = m && Number.isFinite(r.priceNum) ? Math.round(((r.priceNum - m) / m) * 100) : null;
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
  // Rent as a share of gross household income; over 30% is the usual "rent stress" line.
  const RENT_STRESS_PCT = 30;
  const incomePct = (r, income) => (num(income) > 0 && Number.isFinite(r.priceNum) ? Math.round((r.priceNum * 52 * 100) / num(income)) : null);

  const withScores = (rows, cfg) => {
    // Budget: your max rent, else what 30% of your income affords.
    const pMax = num(cfg.priceMax) || (num(cfg.income) > 0 ? Math.round((num(cfg.income) * RENT_STRESS_PCT) / 100 / 52) : null), kmMax = num(cfg.maxKm) || SCORE_KM;
    const from = cfg.from ? new Date(cfg.from + 'T00:00:00') : null;
    const upMed = median(rows.map((r) => r.upfront));
    for (const r of rows) {
      const parts = [];
      if (Number.isFinite(r.priceNum)) {
        if (pMax) parts.push(['rent vs budget', clamp01(1 - r.priceNum / pMax + 0.5)]);
        else if (r.vsMedian != null) parts.push(['rent vs median', clamp01(0.5 - r.vsMedian / 50)]);
      }
      if (from && r.avail) parts.push(['timing', clamp01(1 - Math.abs(r.avail - from) / (SCORE_AVAIL_DAYS * DAY_MS))]);
      if (r.km != null) parts.push(['distance', clamp01(1 - r.km / kmMax)]);
      if (upMed && Number.isFinite(r.upfront)) parts.push(['move-in', clamp01(0.5 - (r.upfront - upMed) / (2 * upMed))]);
      r.score = parts.length >= 2 ? Math.round((parts.reduce((t, [, v]) => t + v, 0) / parts.length) * 100) : null;
      r.scoreWhy = r.score == null ? '' : parts.map(([k, v]) => `${k} ${Math.round(v * 100)}`).join(', ');
    }
    return rows;
  };

  // Active filters as removable chips: [{ key, amen?, label }]. `without` gives the cfg with
  // that one chip removed, so the UI can show how many listings each filter is removing.
  const shortDate = (ymd) => new Date(ymd + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  const money = (v) => `$${(+v).toLocaleString('en-AU')}`;
  const statusLabel = (v) => (v ? v[0].toUpperCase() + v.slice(1) : 'Not started');
  const statusOptions = (cur) => APP_STATUSES.map((v) => `<option value="${v}"${v === cur ? ' selected' : ''}>${statusLabel(v)}</option>`).join('');
  const CHIP_LABELS = {
    from: (v) => `From ${shortDate(v)}`, to: (v) => `To ${shortDate(v)}`, withinDays: (v) => `Within ${Math.round(v / 7)} wks`,
    priceMin: (v) => `≥ ${money(v)}/wk`, priceMax: (v) => `≤ ${money(v)}/wk`, upfrontMax: (v) => `Move-in ≤ ${money(v)}`,
    bedsMin: (v) => `${v}+ bed`, bathsMin: (v) => `${v}+ bath`, carsMin: (v) => `${v}+ car`, type: (v) => v,
    keyword: (v) => `"${v}"`, inspectOn: (v) => `Inspecting ${shortDate(v)}`, hideNoImage: () => 'Has photo',
    exactOnly: () => 'No nearby suburbs', onlyStarred: () => 'Shortlisted', newOnly: () => 'New only', changedOnly: () => 'Changed only',
    staleOnly: () => 'Listed 3+ wks', maxKm: (v) => `≤ ${v} km`, floorplanOnly: () => 'Floorplan',
  };
  const activeFilters = (cfg) => {
    const out = [];
    for (const k of FILTER_KEYS) {
      const v = cfg[k];
      if (!v || v === DEFAULT_CFG[k] || (typeof v === 'string' && !v.trim())) continue;
      if (k === 'amenities') {
        for (const [id, st] of Object.entries(parseAmenCfg(v))) {
          const a = AMENITIES.find((x) => x.id === id);
          out.push({ key: k, amen: id, label: `${st === 'yes' ? '+' : '−'} ${a.label}` });
        }
      } else if (k === 'noWatch') {
        for (const id of watchIds(v)) out.push({ key: k, watch: id, label: `No ${WATCHOUTS.find((w) => w.id === id).label.toLowerCase()}` });
      } else if (k !== 'maxKm' || parseAnchor(cfg.anchor)) out.push({ key: k, label: CHIP_LABELS[k] ? CHIP_LABELS[k](v) : k });
    }
    return out;
  };
  const without = (cfg, chip) => {
    if (chip.watch) return { ...cfg, noWatch: watchIds(cfg.noWatch).filter((id) => id !== chip.watch).join(',') };
    if (!chip.amen) return { ...cfg, [chip.key]: DEFAULT_CFG[chip.key] };
    const st = parseAmenCfg(cfg.amenities);
    delete st[chip.amen];
    return { ...cfg, amenities: amenCfgString(st) };
  };
  const removedBy = (rows, cfg, now = new Date()) => {
    const base = filterRows(rows, cfg, now).length;
    return activeFilters(cfg).map((chip) => ({ ...chip, removes: filterRows(rows, without(cfg, chip), now).length - base }));
  };

  // Market view: rent spread per bed count and when listings become available, over the
  // listings currently shown. Quantiles interpolate; groups under MEDIAN_MIN show counts only.
  const MARKET_WEEKS = 8;
  const quantile = (sorted, q) => {
    if (!sorted.length) return null;
    const i = (sorted.length - 1) * q, lo = Math.floor(i);
    return Math.round(sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (i - lo));
  };
  const marketStats = (rows, now = new Date()) => {
    const uniq = dedupe(rows);
    const beds = new Map();
    for (const r of uniq) {
      if (r.beds === '' || r.beds == null) continue;
      const k = Math.min(+r.beds || 0, 5);
      if (!beds.has(k)) beds.set(k, { beds: k, n: 0, rents: [], ppb: [] });
      const g = beds.get(k);
      g.n++;
      if (Number.isFinite(r.priceNum)) g.rents.push(r.priceNum);
      if (Number.isFinite(r.ppb)) g.ppb.push(r.ppb);
    }
    const byBeds = [...beds.values()].sort((a, b) => a.beds - b.beds).map(({ beds: b, n, rents, ppb }) => {
      rents.sort((x, y) => x - y); ppb.sort((x, y) => x - y);
      const enough = rents.length >= MEDIAN_MIN;
      return { beds: b, n, priced: rents.length, min: rents[0] ?? null, max: rents[rents.length - 1] ?? null,
        p25: enough ? quantile(rents, 0.25) : null, median: enough ? quantile(rents, 0.5) : null, p75: enough ? quantile(rents, 0.75) : null,
        ppb: ppb.length >= MEDIAN_MIN ? quantile(ppb, 0.5) : null };
    });
    const today = startOfDay(now);
    const weeks = [{ label: 'Now', from: null, n: 0 }];
    for (let w = 0; w < MARKET_WEEKS; w++) {
      const from = new Date(today); from.setDate(from.getDate() + 1 + w * 7);
      weeks.push({ from: ymdLocal(from), to: ymdLocal(new Date(from.getFullYear(), from.getMonth(), from.getDate() + 6)), n: 0 });
    }
    const later = { label: 'Later', n: 0 }, unknown = { label: 'Unknown', n: 0 };
    for (const r of uniq) {
      if (!(r.avail instanceof Date) || isNaN(r.avail)) { unknown.n++; continue; }
      const days = Math.round((startOfDay(r.avail) - today) / 864e5);
      if (days <= 0) weeks[0].n++;
      else if (days <= MARKET_WEEKS * 7) weeks[Math.ceil(days / 7)].n++;
      else later.n++;
    }
    const all = uniq.map((r) => r.priceNum).filter(Number.isFinite).sort((a, b) => a - b);
    return { n: uniq.length, median: all.length >= MEDIAN_MIN ? quantile(all, 0.5) : null, byBeds, byWeek: [...weeks, later, unknown] };
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
    let fresh = 0, moved = 0, redated = 0, hidden = 0;
    for (const r of dedupe(rows)) { fresh += isFresh(r) ? 1 : 0; moved += r.prevPrice ? 1 : 0; redated += r.prevAvail ? 1 : 0; hidden += r.hidden ? 1 : 0; }
    return { fresh, moved, redated, hidden };
  };

  const ago = (ms) => {
    const m = Math.floor(ms / 60e3); // floor: 30s is "just now", not "1 min ago"
    return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
  };

  // Undated listings ("Contact agent") can't satisfy a date bound, but are kept
  // (sorted last) when no bound is set so an empty filter never hides data.
  // Numeric minimums treat unknown values as failing; maximums likewise.
  // Filter + score + sort. filterRows alone has no side effects on scores, so counting
  // ("how many would this chip let back in?") can't disturb what's on screen.
  function applyFilters(rows, cfg, now = new Date()) {
    cfg = { ...DEFAULT_CFG, ...cfg };
    return withScores(filterRows(rows, cfg, now), cfg).sort(SORTS[cfg.sort] || SORTS.avail);
  }

  function filterRows(rows, cfg, now = new Date()) {
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
    const noWatch = watchIds(cfg.noWatch);
    // Distance depends on cfg.anchor, so it is (re)computed here for every caller.
    const anchor = parseAnchor(cfg.anchor), kmMax = num(cfg.maxKm);
    // Memoised per anchor: removedBy() re-filters once per chip with the same point.
    for (const r of rows) if (r._kmFor !== cfg.anchor) { r.km = kmFrom(anchor, r); r._kmFor = cfg.anchor; }
    const insDay = cfg.inspectOn ? new Date(cfg.inspectOn + 'T00:00:00') : null;
    const sameDay = (ms) => startOfDay(new Date(ms)).getTime() === insDay.getTime();
    const kept = dedupe(rows)
      .filter((r) => (cfg.exactOnly ? !r.surrounding : true))
      .filter((r) => cfg.showHidden || (!r.hidden && !r.agencyHidden && !r.suburbHidden))
      .filter((r) => !cfg.floorplanOnly || r.floorplan === true)
      .filter((r) => cfg.showGone || !r.gone)
      .filter((r) => !cfg.newOnly || isFresh(r))
      .filter((r) => !cfg.changedOnly || !!(r.prevPrice || r.prevAvail))
      .filter((r) => !noWatch.length || !String(r.watch || '').split(',').some((id) => noWatch.includes(id)))
      .filter((r) => !cfg.staleOnly || (r.listed instanceof Date && now - r.listed > STALE_MS))
      .filter((r) => kmMax == null || !anchor || (r.km != null && r.km <= kmMax)) // no location fails a distance cap
      .filter((r) => amenReq.every(([id, st]) => (st === 'yes' ? r.amen?.[id] === 'yes' : r.amen?.[id] !== 'yes')))
      .filter((r) => !cfg.onlyStarred || r.starred)
      .filter((r) => (r.avail ? (!from || r.avail >= from) && (!to || r.avail <= to) : !from && !to))
      .filter((r) => (pMin == null || (Number.isFinite(r.priceNum) && r.priceNum >= pMin)) && (pMax == null || r.priceNum <= pMax))
      .filter((r) => upMax == null || (r.upfront ?? Infinity) <= upMax) // unknown bond fails a move-in cap
      .filter((r) => mins.every(([k, v]) => r[k] !== '' && +r[k] >= v))
      .filter((r) => !cfg.type || r.type === cfg.type)
      .filter((r) => !cfg.hideNoImage || r.img)
      .filter((r) => !kw || kw(r.text || ''))
      .filter((r) => !insDay || (r.inspections || []).some((i) => i.at != null && sameDay(i.at)));
    return kept;
  }

  const historyText = (r) => (r.priceHistory || []).map(([at, p]) => `${ymdLocal(new Date(at))} ${p}`).join(' → ');
  const ppbLabel = (r) => (+r.beds > 1 && Number.isFinite(r.ppb) ? `$${r.ppb}/bed` : '');

  const EXPORT_COLS = [
    ['availDate', 'available_date'], ['available', 'available'], ['price', 'price'], ['priceNum', 'weekly_rent'],
    ['ppb', 'rent_per_bed'], ['bond', 'bond'], ['bondWeeks', 'bond_weeks'], ['upfront', 'move_in_cost'], ['vsMedian', 'vs_median_pct'], ['amenList', 'amenities'], ['watchList', 'heads_up'], ['km', 'km'], ['score', 'match_score'], ['agency', 'agency'], ['photos', 'photos'], ['floorplan', 'floorplan'], ['address', 'address'], ['suburb', 'suburb'], ['beds', 'beds'],
    ['baths', 'baths'], ['cars', 'cars'], ['type', 'type'], ['inspect', 'inspections'], ['listed', 'listed'],
    ['surrounding', 'nearby'], ['starred', 'shortlisted'], ['isNew', 'new'], ['prevPrice', 'previous_price'], ['prevAvail', 'previous_available'], ['priceHistoryText', 'price_history'], ['relistedText', 'relisted_from_price'], ['appStatus', 'application'], ['note', 'note'],
    ['headline', 'headline'], ['url', 'url'],
  ];
  const ymdLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const cellValue = (r, k) => {
    const v = k === 'availDate' ? r.avail : k === 'amenList' ? amenityTags(r).join('; ') : k === 'watchList' ? watchTags(r).join('; ')
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

  // Share a shortlist as a link: the data rides in the URL fragment (after #), which browsers
  // never send to the server. Decoding is untrusted input: every field is re-validated.
  const SHARE_MAX = 30;
  const SHARE_PARAM = 'rf-share';
  const b64url = (str) => btoa(String.fromCharCode(...new TextEncoder().encode(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64url = (b) => new TextDecoder().decode(Uint8Array.from(atob(b.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));
  const encodeShare = (rows, { notes = false } = {}) => b64url(JSON.stringify({ a: 'rea-enhancement', v: 1,
    l: rows.slice(0, SHARE_MAX).map((r) => ({ i: r.id, u: r.url, a: clip(r.address, 120), p: clip(r.price, 60), v: clip(r.available, 40),
      b: scalar(r.beds), ba: scalar(r.baths), c: scalar(r.cars), ...(notes && r.note ? { n: clip(r.note, NOTE_MAX) } : {}) })) }));
  const decodeShare = (b) => {
    let d;
    try { d = JSON.parse(unb64url(String(b || ''))); } catch { return null; }
    if (d?.a !== 'rea-enhancement' || !Array.isArray(d.l)) return null;
    return d.l.slice(0, SHARE_MAX).map((x) => ({
      id: isListingId(x?.i) ? String(x.i) : '', url: safeUrl(x?.u), address: clip(x?.a, 120), price: clip(x?.p, 60),
      available: clip(x?.v, 40), beds: scalar(x?.b), baths: scalar(x?.ba), cars: scalar(x?.c), note: clip(x?.n, NOTE_MAX),
    })).filter((r) => r.id && r.url && /^https:\/\/www\.realestate\.com\.au\//.test(r.url));
  };
  const shareUrl = (rows, opts) => `https://www.realestate.com.au/rent/#${SHARE_PARAM}=${encodeShare(rows, opts)}`;
  const shareFromHash = (hash) => { const m = String(hash || '').match(new RegExp(`[#&]${SHARE_PARAM}=([A-Za-z0-9_-]+)`)); return m ? decodeShare(m[1]) : null; };

  // Inspection planner: one day's shortlisted inspections in order, with clashes and gaps too
  // short for the straight-line distance flagged. A rough guide, not a route planner.
  const PLAN_MIN_PER_KM = 2; // ~30 km/h door to door in traffic
  const PLAN_MIN_GAP = 10; // minutes between inspections below which it's "tight" regardless of distance
  // Inspection times are the listing's local time: group and show them in its state's zone
  // (from the address), so a Perth listing planned from Sydney lands on the right day.
  const STATE_TZ = { NSW: 'Australia/Sydney', ACT: 'Australia/Sydney', VIC: 'Australia/Melbourne', TAS: 'Australia/Hobart',
    QLD: 'Australia/Brisbane', SA: 'Australia/Adelaide', WA: 'Australia/Perth', NT: 'Australia/Darwin' };
  const tzOf = (r) => STATE_TZ[String(r.state || (String(r.address || '').match(/\b(NSW|ACT|VIC|TAS|QLD|SA|WA|NT)\b(?!.*\b(NSW|ACT|VIC|TAS|QLD|SA|WA|NT)\b)/) || [])[1] || '').toUpperCase()] || null;
  const dayFmts = new Map();
  const ymdIn = (ms, tz) => {
    if (!tz) return ymdLocal(new Date(ms));
    let f = dayFmts.get(tz);
    if (!f) dayFmts.set(tz, (f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })));
    return f.format(ms);
  };
  const inspectDays = (rows) => {
    const days = new Map();
    for (const r of rows) for (const i of r.inspections || []) if (typeof i.at === 'number') {
      const k = ymdIn(i.at, tzOf(r));
      days.set(k, (days.get(k) || 0) + 1);
    }
    return [...days].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, n]) => ({ day, n }));
  };
  const planDay = (rows, day) => {
    const slots = [];
    for (const r of rows) for (const i of r.inspections || []) {
      const tz = tzOf(r);
      if (typeof i.at === 'number' && ymdIn(i.at, tz) === day) slots.push({ r, tz, at: i.at, end: i.at + INSPECT_MINUTES * 60e3, label: i.label });
    }
    slots.sort((a, b) => a.at - b.at);
    for (let k = 1; k < slots.length; k++) {
      const prev = slots[k - 1], cur = slots[k];
      cur.gapMin = Math.round((cur.at - prev.end) / 60e3);
      cur.km = prev.r.lat != null && cur.r.lat != null ? Math.round(haversineKm(prev.r, cur.r) * 10) / 10 : null;
      // Two sessions at one listing are alternatives, not a clash.
      cur.same = prev.r.id === cur.r.id;
      cur.flag = cur.same ? '' : cur.at < prev.end ? 'clash' : cur.gapMin < Math.max(PLAN_MIN_GAP, (cur.km ?? 0) * PLAN_MIN_PER_KM) ? 'tight' : '';
    }
    return slots;
  };

  const orQ = (v) => (v === '' || v == null ? '?' : v);

  // Shortlist search: every word must appear in the address, note, agency, suburb, price or status.
  const textMatch = (r, q) => {
    const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return true;
    const hay = [r.address, r.note, r.agency, r.suburb, r.price, r.appStatus, r.type].filter(Boolean).join(' ').toLowerCase();
    return terms.every((t) => hay.includes(t));
  };

  // One listing as plain text for a message.
  const summaryText = (r) => [
    `${r.price || 'Price on request'} - ${r.address}`,
    [r.available && r.available !== '-' ? `Available ${r.available}` : '', [r.beds, r.baths, r.cars].some((v) => v !== '' && v != null) ? `${orQ(r.beds)} bed, ${orQ(r.baths)} bath, ${orQ(r.cars)} car` : '',
      Number.isFinite(r.upfront) ? `move-in ${money(r.upfront)}` : ''].filter(Boolean).join(' · '),
    r.inspections?.length ? `Inspections: ${r.inspections.map((i) => i.label).join('; ')}` : '',
    r.url,
  ].filter(Boolean).join('\n');

  // Printable shortlist: a standalone HTML document (all text escaped), light theme forced.
  const printHtml = (rows, now = new Date()) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Rental shortlist ${ymdLocal(now)}</title><style>
body{font:13px/1.45 system-ui,-apple-system,sans-serif;color:#111;background:#fff;margin:24px}
h1{font-size:18px;margin:0 0 4px}.sub{color:#555;margin-bottom:16px}
.l{display:grid;grid-template-columns:150px 1fr;gap:14px;padding:12px 0;border-top:1px solid #ddd;break-inside:avoid}
.l img{width:150px;height:110px;object-fit:cover;border-radius:6px;background:#eee}
.p{font-weight:700;font-size:15px}.a{font-weight:600}.m{color:#444;margin-top:2px}.n{margin-top:6px;padding:6px 8px;background:#f4f4f6;border-radius:4px;white-space:pre-wrap}
.box{margin-top:8px;height:64px;border:1px dashed #aaa;border-radius:4px;color:#999;font-size:11px;padding:4px}
.u{color:#666;font-size:11px;word-break:break-all}@media print{body{margin:10mm}}
</style></head><body><h1>Rental shortlist</h1><div class="sub">${rows.length} listing${rows.length === 1 ? '' : 's'} · printed ${esc(now.toLocaleDateString('en-AU'))}</div>
${rows.map((r) => `<div class="l">${r.img ? `<img src="${esc(r.img)}" alt="">` : '<div></div>'}<div>
<div class="p">${esc(r.price)}</div><div class="a">${esc(r.address)}</div>
<div class="m">${esc([r.available && r.available !== '-' ? `Available ${r.available}` : '', [r.beds, r.baths, r.cars].some((v) => v !== '' && v != null) ? `${orQ(r.beds)} bed · ${orQ(r.baths)} bath · ${orQ(r.cars)} car` : '',
  Number.isFinite(r.upfront) ? `move-in ${money(r.upfront)}` : ''].filter(Boolean).join(' · '))}</div>
${(r.inspections || []).length ? `<div class="m">Inspections: ${esc(r.inspections.map((i) => i.label).join('; '))}</div>` : ''}
${r.agency ? `<div class="m">${esc(r.agency)}</div>` : ''}${r.appStatus ? `<div class="m">Status: ${esc(r.appStatus)}</div>` : ''}
${r.note ? `<div class="n">${esc(r.note)}</div>` : ''}<div class="box">Notes at inspection</div><div class="u">${esc(r.url)}</div>
</div></div>`).join('')}</body></html>`;

  // Drift canary: share of rows with each field, tracked as an average over searches. A field
  // that's usually there but suddenly isn't means REA probably renamed or moved it.
  const HEALTH_KEY = 'rea-avail-filter/health/v1';
  const HEALTH_MIN_ROWS = 20; // smaller searches are too noisy to judge
  const HEALTH_ALPHA = 0.3; // weight of the newest search in the running average
  const HEALTH_FIELDS = {
    availability: (r) => !!r.avail, price: (r) => Number.isFinite(r.priceNum), inspections: (r) => !!r.inspections?.length,
    coordinates: (r) => r.lat != null, agency: (r) => !!r.agency, features: (r) => !!r.features?.length,
    listed: (r) => r.listed instanceof Date, photos: (r) => r.photos != null,
  };
  const fillRates = (rows) => Object.fromEntries(Object.entries(HEALTH_FIELDS).map(([k, f]) => [k, rows.length ? rows.filter(f).length / rows.length : 0]));
  const healthStore = (storage) => {
    const load = () => {
      try {
        const d = JSON.parse(storage.getItem(HEALTH_KEY));
        if (d && d.ema && typeof d.ema === 'object' && !Array.isArray(d.ema)) {
          const ema = Object.fromEntries(Object.entries(d.ema).filter(([, v]) => Number.isFinite(v)));
          return { ema, n: Number.isFinite(d.n) ? d.n : 0 };
        }
      } catch { /* corrupt */ }
      return { ema: {}, n: 0 };
    };
    return {
      // Returns fields that dropped: [{ field, now, usual }]. Updates the average afterwards,
      // except for a dropped field: one broken search shouldn't teach it that absence is usual.
      record(rows) {
        if (rows.length < HEALTH_MIN_ROWS) return [];
        const d = load(), rates = fillRates(rows), drops = [];
        for (const [k, v] of Object.entries(rates)) {
          const usual = d.ema[k];
          if (d.n >= 2 && usual >= 0.3 && v < usual * 0.3) { drops.push({ field: k, now: v, usual }); continue; }
          d.ema[k] = usual == null ? v : usual * (1 - HEALTH_ALPHA) + v * HEALTH_ALPHA;
        }
        d.n++;
        try { storage.setItem(HEALTH_KEY, JSON.stringify(d)); } catch { /* quota/blocked */ }
        return drops;
      },
      usual: () => load(),
    };
  };
  const pct = (v) => `${Math.round(v * 100)}%`;

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
      fetchResults, fetchAllPages, sleep, unpackJson, findListing, parseListingPage, discover, extractCoords, extractAgency, extractFeatures, extractMedia, listingId, dedupe, windowEnd, extractInspections, extractListed, toDate, applyFilters, filterRows, keywordTest, toTsv, toCsv, toIcs, printHtml, summaryText, inspectDays, planDay, tzOf, textMatch, watchOf, watchTags, marketStats, searchLabel, incomePct, toolKeys, toolBytes, fmtBytes, encodeShare, decodeShare, shareUrl, shareFromHash, schemaWarnings, probe, esc, safeUrl, rowStore, marksStore, snapshotStore, presetStore, healthStore, fillRates, APP_STATUSES, addressKey, DEFAULT_CFG, activeFilters, removedBy, withScores, parseAnchor, haversineKm, AMENITIES, amenitiesOf, parseAmenCfg, amenCfgString, moveIn, withMedians, medianLabel, sanitizeCfg, itemsOf, sampleOf, cfgError, diffStats, ago, startOfDay, isFresh,
    };
    return;
  }

  // ------------------------------------------------------------------- ui

  // Clipboard with a fallback: the async API needs focus/permission, execCommand doesn't.
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch {
      const ta = Object.assign(document.createElement('textarea'), { value: text });
      ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { /* unsupported */ }
      ta.remove();
      return ok;
    }
  }

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
  #rf-panel,#rf-launch,#rf-lbar{--rf-bg:#fff;--rf-fg:#111;--rf-muted:#666;--rf-soft:#767680;--rf-line:#e4e4e7;--rf-input:#cfcfd4;
    --rf-hover:#f6f6f8;--rf-sec:#f1f1f4;--rf-sec-hover:#e6e6ea;--rf-accent:#087a50;--rf-accent-hover:#06663f;--rf-accent-fg:#087a50;
    --rf-err:#c00;--rf-tag:#eee}
  @media (prefers-color-scheme: dark){
    #rf-panel,#rf-launch,#rf-lbar{--rf-bg:#1c1c20;--rf-fg:#ececf1;--rf-muted:#a0a0ab;--rf-soft:#8e8e99;--rf-line:#2e2e35;--rf-input:#3a3a43;
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
  .rf-keys{border:1px solid var(--rf-line);background:none;border-radius:999px;width:22px;height:22px;font:600 12px system-ui,sans-serif;
    color:var(--rf-muted);cursor:pointer;padding:0}
  .rf-help{padding:10px 16px;border-bottom:1px solid var(--rf-line);font-size:12px;background:var(--rf-hover)}
  .rf-help[hidden]{display:none}
  .rf-help dl{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;margin:6px 0 0}
  .rf-help dt{font:600 11px ui-monospace,monospace;color:var(--rf-fg)}
  .rf-help dd{margin:0;color:var(--rf-muted)}
  .rf-item:focus{outline:2px solid var(--rf-accent-fg);outline-offset:-2px;border-radius:8px}
  .rf-x{border:0;background:none;font-size:20px;line-height:1;cursor:pointer;color:var(--rf-muted);padding:0 4px}
  .rf-controls{padding:12px 16px;border-bottom:1px solid var(--rf-line);display:grid;grid-template-columns:minmax(0,1fr);gap:10px;overflow-x:hidden;max-height:60vh;overflow-y:auto}
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
  .rf-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
  .rf-controls>.rf-actions:not(.rf-exports){position:sticky;bottom:-12px;background:var(--rf-bg);padding:6px 0;z-index:1}
  .rf-btn{flex:1;padding:9px 12px;border:0;border-radius:6px;background:var(--rf-accent);color:#fff;
    font:600 13px system-ui,sans-serif;cursor:pointer}
  .rf-btn:hover{background:var(--rf-accent-hover)}
  .rf-btn[disabled]{opacity:.5;cursor:default}
  .rf-btn[hidden]{display:none}
  .rf-btn.sec{background:var(--rf-sec);color:var(--rf-fg)}
  .rf-btn.sec:hover{background:var(--rf-sec-hover)}
  .rf-bulk,.rf-sl-bulk{flex:0 0 auto;font:12px system-ui,sans-serif;padding:7px 6px;border:1px solid var(--rf-input);border-radius:6px;
    background:var(--rf-bg);color:var(--rf-fg);width:auto!important}
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
  /* In the flow under each listing (not overlaid): always visible, so keyboard, touch and new users find them. */
  .rf-acts{display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin:-4px 9px 8px 124px}
  .rf-acts-more{position:relative}
  .rf-acts-more summary{list-style:none;cursor:pointer;border:1px solid var(--rf-line);border-radius:6px;padding:2px 8px;font:600 12px system-ui,sans-serif;color:var(--rf-muted)}
  .rf-acts-more summary::-webkit-details-marker{display:none}
  .rf-acts-more>div{position:absolute;right:0;top:calc(100% + 4px);z-index:3;display:grid;gap:4px;padding:6px;background:var(--rf-bg);
    border:1px solid var(--rf-line);border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.15);white-space:nowrap}
  .rf-cmp{display:inline-flex;align-items:center;gap:3px;font:600 11px system-ui,sans-serif;background:var(--rf-bg);border:1px solid var(--rf-line);border-radius:6px;padding:2px 6px}
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
  .rf-active{display:flex;flex-wrap:wrap;gap:6px;padding:8px 16px;border-bottom:1px solid var(--rf-line)}
  .rf-active[hidden]{display:none}
  .rf-achip{font-size:11px;padding:3px 8px}
  .rf-achip span{color:var(--rf-soft);font-weight:400}
  .rf-preset{font:12px system-ui,sans-serif;padding:6px;border:1px solid var(--rf-input);border-radius:6px;background:var(--rf-bg);color:var(--rf-fg);width:100%}
  .rf-share-in{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 16px;background:var(--rf-hover);border-bottom:1px solid var(--rf-line)}
  .rf-share-in[hidden]{display:none}
  .rf-share-in .rf-btn{flex:0 0 auto;padding:6px 11px;font-size:12px}
  .rf-share-msg{font-weight:600;margin-right:auto}
  .rf-plan{font:12px system-ui,sans-serif;padding:4px 6px;border:1px solid var(--rf-input);border-radius:6px;background:var(--rf-bg);color:var(--rf-fg)}
  .rf-plan[hidden]{display:none}
  .rf-planner{padding:8px 12px}
  .rf-tags.rf-watch span{background:rgba(204,102,0,.16);color:var(--rf-fg)}
  .rf-storage{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
  #rf-lbar{position:fixed;left:16px;bottom:16px;z-index:2147483000;display:flex;flex-wrap:wrap;gap:6px;align-items:center;max-width:min(420px,calc(100vw - 32px));
    padding:8px;border-radius:10px;background:var(--rf-bg);color:var(--rf-fg);border:1px solid var(--rf-line);box-shadow:0 4px 18px rgba(0,0,0,.18);font:13px system-ui,sans-serif}
  #rf-lbar button,#rf-lbar select{font:600 13px system-ui,sans-serif;padding:6px 10px;border-radius:6px;border:1px solid var(--rf-line);background:var(--rf-sec);color:var(--rf-fg);cursor:pointer}
  #rf-lbar button[aria-pressed=true]{background:var(--rf-accent);border-color:var(--rf-accent);color:#fff}
  #rf-lbar button:focus-visible,#rf-lbar select:focus-visible{outline:2px solid var(--rf-accent);outline-offset:2px}
  .rf-lbar-note,.rf-lbar-info{flex:1 1 100%;font-size:12px;color:var(--rf-muted);white-space:pre-wrap;overflow-wrap:anywhere}
  .rf-warn-t{color:var(--rf-err)}
  .rf-saved-list{list-style:none;margin:6px 0;padding:0;display:grid;gap:6px;font-size:13px}
  .rf-saved-list a{color:inherit;font-weight:600}
  .rf-market{padding:8px 12px;font-size:12px;min-width:0}
  .rf-market-t{overflow-x:auto;max-width:100%}
  .rf-market table{border-collapse:collapse;width:100%;margin:6px 0 12px}
  .rf-market caption{text-align:left;font-weight:600;padding:4px 0}
  .rf-market th,.rf-market td{border-bottom:1px solid var(--rf-line);padding:5px 4px;text-align:right}
  .rf-market td{white-space:nowrap}
  .rf-market th:first-child{text-align:left}
  .rf-market h3{font-size:12px;margin:8px 0 4px}
  .rf-bars{list-style:none;margin:0;padding:0;display:grid;gap:3px}
  .rf-bars button,.rf-bars div{all:unset;box-sizing:border-box;display:grid;grid-template-columns:64px 1fr 28px;align-items:center;gap:8px;width:100%;padding:2px 4px;border-radius:4px}
  .rf-bars button{cursor:pointer}
  .rf-bars button:hover,.rf-bars button:focus-visible{background:var(--rf-line);outline:2px solid var(--rf-accent);outline-offset:-2px}
  .rf-bar{display:block;height:12px;min-width:2px;background:var(--rf-accent);border-radius:3px}
  .rf-bar-n{text-align:right;font-variant-numeric:tabular-nums}
  .rf-plan-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-weight:600;margin-bottom:6px}
  .rf-plan-head .rf-btn{flex:0 0 auto;margin-left:auto;padding:5px 10px;font-size:12px}
  .rf-planner ol{list-style:none;margin:0;padding:0}
  .rf-planner li{padding:8px 0;border-top:1px solid var(--rf-line)}
  .rf-planner li a{color:inherit;font-weight:600}
  .rf-plan-t{display:inline-block;min-width:64px;font-weight:700;color:var(--rf-accent-fg)}
  .rf-planner li.rf-clash .rf-meta,.rf-planner li.rf-tight .rf-meta{color:#b45309;font-weight:600}
  .rf-dist{display:grid;grid-template-columns:1fr 90px;gap:10px}
  .rf-amen{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
  .rf-nowatch .rf-label{flex:1 1 100%}
  #rf-lbar.rf-lbar-min{padding:4px;gap:4px}
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
  .rf-sl-q{font:12px system-ui,sans-serif;padding:4px 6px;border:1px solid var(--rf-input);border-radius:6px;background:var(--rf-bg);color:var(--rf-fg);width:130px}
  .rf-sl-filter{font:12px system-ui,sans-serif;padding:4px 6px;border:1px solid var(--rf-input);border-radius:6px;background:var(--rf-bg);color:var(--rf-fg)}
  .rf-empty{padding:28px 16px;text-align:center;color:var(--rf-soft)}
  article[data-rf-pos]{position:relative}
  article[data-rf-match="0"]{opacity:.35;transition:opacity .15s}
  article[data-rf-match="0"]:hover{opacity:1}
  .rf-badge{position:absolute;top:10px;left:10px;right:10px;z-index:5;display:flex;gap:4px;flex-wrap:wrap;pointer-events:none;
    font:600 11px/1 system-ui,-apple-system,sans-serif}
  .rf-badge span{padding:5px 8px;border-radius:999px;background:rgba(0,0,0,.78);color:#fff;white-space:nowrap}
  .rf-badge .rf-b-pets{background:#7c3aed}
  .rf-card-acts{display:inline-flex;gap:4px;margin-left:auto;pointer-events:auto}
  .rf-badge .rf-card-acts button{pointer-events:auto;border:0;border-radius:999px;padding:5px 9px;cursor:pointer;
    font:600 11px/1 system-ui,-apple-system,sans-serif;background:rgba(255,255,255,.92);color:#111;box-shadow:0 1px 3px rgba(0,0,0,.25)}
  .rf-badge .rf-card-acts button[aria-pressed=true]{background:#e6a700}
  .rf-badge .rf-card-acts button:focus-visible{outline:2px solid #087a50;outline-offset:1px}
  .rf-badge .rf-b-now{background:#087a50}
  .rf-badge .rf-b-none{background:rgba(90,90,90,.85)}
  .rf-badge .rf-b-star{background:#e6a700;color:#111}
  .rf-badge .rf-b-new{background:#2563eb}
  .rf-badge .rf-b-down{background:#087a50}
  .rf-badge .rf-b-up{background:#c60}
  @media (max-width:480px){ #rf-launch{right:12px;bottom:12px} .rf-grid3{grid-template-columns:repeat(2,1fr)}
    .rf-dates{grid-template-columns:1fr 1fr} .rf-dates>label:last-child{grid-column:1/-1} .rf-controls{max-height:48vh}
    .rf-actions{flex-wrap:wrap} .rf-actions .rf-bulk{flex:1 1 100%}
    .rf-acts,.rf-note,.rf-note-edit,.rf-app{margin-left:9px} .rf-note-edit{width:calc(100% - 18px)}
    .rf-card{grid-template-columns:88px 1fr} .rf-card img{width:88px;height:66px} }
  .rf-btn{white-space:nowrap}
  `;

  const EMPTY_INTRO = 'Set your dates, then search.<br>Every result page is merged and sorted by availability.';
  const setEmpty = (html) => { ui.list.innerHTML = `<div class="rf-empty">${html}</div>`; };
  const setLaunchCount = (n) => {
    ui.launchN = n;
    const star = marks.counts().starred;
    ui.launch.textContent = `Availability filter${n == null ? '' : ` (${n})`}${star ? ` · ★${star}` : ''}`;
  };
  const currentKey = () => (isSearchPage(location.href) ? searchKey(location.href) : null);

  let cfg = { ...DEFAULT_CFG, ...loadCfg() };
  let cache = null; // raw rows for the current search URL
  let cacheKey = null; // searchKey() of the cached rows
  let truncated = false;
  let runId = 0; // bumped on navigation so an in-flight run can't write stale rows
  let ui = null;

  const exchangeScript = () => [...document.scripts].find((sc) => sc.textContent.includes('window.ArgonautExchange='));

  // The document we were loaded with already holds one page of results; after SPA
  // navigation it is stale, which the key/page match in fetchAllPages guards against.
  const boot = (() => {
    if (!isSearchPage(location.href)) return null;
    try {
      const key = searchKey(location.href), page = pageNum(location.href);
      if (window.ArgonautExchange) return { key, page, results: parseExchange(window.ArgonautExchange) };
      const tag = exchangeScript();
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
  const health = healthStore(storageOr('localStorage'));
  const errorLog = []; // last few errors, for reaFilter.selfcheck()
  const logError = (msg) => { errorLog.push(`${new Date().toISOString()} ${String(msg).slice(0, 200)}`); if (errorLog.length > 10) errorLog.shift(); };
  const presets = presetStore(storageOr('localStorage'));
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
        <button class="rf-keys" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" aria-expanded="false">?</button>
        <button class="rf-x" title="Close (Esc)" aria-label="Close">&times;</button>
      </div>
      <div class="rf-tabs" role="tablist">
        <button role="tab" data-view="results" aria-selected="true">Results</button>
        <button role="tab" data-view="shortlist" aria-selected="false">Shortlist <span class="rf-count"></span></button>
      </div>
      <div class="rf-sl-bar" hidden>
        <span class="rf-label">Shortlist, all searches</span>
        <select class="rf-sl-bulk" aria-label="Bulk action on the shortlist shown">
          <option value="">Bulk…</option>${APP_STATUSES.filter(Boolean).map((v) => `<option value="status:${v}">Mark shown: ${v}</option>`).join('')}
          <option value="unstar-declined">Remove declined</option><option value="unstar">Remove all shown</option>
        </select>
        <select class="rf-plan" aria-label="Plan an inspection day"></select>
        <input type="search" class="rf-sl-q" placeholder="Search shortlist" aria-label="Search the shortlist by address, note, agency or suburb">
        <select class="rf-sl-filter" aria-label="Filter shortlist by application status">
          <option value="">All</option>${APP_STATUSES.filter(Boolean).map((v) => `<option value="${v}">${statusLabel(v)}</option>`).join('')}
          <option value="-">Not started</option>
        </select>
        <button class="rf-btn sec" data-export="csv" title="Download the shortlist as CSV">CSV</button>
        <button class="rf-btn sec" data-export="ics" title="Shortlisted inspections as a calendar file">Calendar</button>
        <button class="rf-btn sec" data-sl="backup" title="Download shortlist, hidden listings, notes and remembered searches as JSON">Backup</button>
        <button class="rf-btn sec" data-sl="restore" title="Merge a backup file">Restore</button>
        <button class="rf-btn sec" data-sl="recheck" title="Fetch each shortlisted listing's page for current price, availability and inspections">Re-check</button>
        <button class="rf-btn sec" data-sl="share" title="Copy a link that shares these listings (no server involved)">Share</button>
        <button class="rf-btn sec" data-sl="print" title="Printable shortlist (or Save as PDF)">Print</button>
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
          <div class="rf-amen rf-nowatch" role="group" aria-label="Hide listings whose text mentions">
            <span class="rf-label">Hide if mentioned</span><input type="hidden" id="rf-noWatch">
            ${WATCHOUTS.map((w) => `<button type="button" class="rf-chip" data-nowatch="${w.id}" aria-pressed="false">${w.label}</button>`).join('')}
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
          <label class="rf-check"><input type="checkbox" id="rf-changedOnly">Price or date changed recently</label>
          <label class="rf-check"><input type="checkbox" id="rf-showGone">Show listings no longer listed</label>
          <label class="rf-check"><input type="checkbox" id="rf-onlyStarred">Shortlisted only <span class="rf-n" data-count="starred"></span></label>
          <label class="rf-check"><input type="checkbox" id="rf-showHidden">Show hidden listings <span class="rf-n" data-count="hidden"></span></label>
          <label class="rf-check"><input type="checkbox" id="rf-floorplanOnly">Has a floorplan</label>
          <div class="rf-agencies" hidden><span class="rf-label">Hidden agencies / suburbs</span><span class="rf-ag-list"></span></div>
        </details>
        <details class="rf-more rf-settings">
          <summary>Settings</summary>
          <label class="rf-check"><input type="checkbox" id="rf-annotate">Show badges and buttons on REA's result cards</label>
          <label class="rf-check"><input type="checkbox" id="rf-dimCards">Fade REA cards that don't match filters</label>
          <label class="rf-check"><input type="checkbox" id="rf-remember">Remember results between visits</label>
          <div class="rf-meta rf-storage"><span class="rf-storage-n"></span>
            <button type="button" class="rf-btn sec" data-forget title="Remove everything this script stored in this browser (not REA's own data)">Delete all my data</button></div>
          <label>Household income, $ a year before tax (optional)<input type="number" id="rf-income" min="0" step="1000" inputmode="numeric" placeholder="eg 120000"
            title="Shows rent as a share of income (over ${RENT_STRESS_PCT}% is flagged) and sets Best match's budget when no max rent is set. Stays in this browser."></label>
        </details>
        <details class="rf-more rf-saved" hidden>
          <summary>Saved searches</summary>
          <ul class="rf-saved-list"></ul>
          <button type="button" class="rf-btn sec" data-saved-check title="Fetch each remembered search (one page at a time) and count what's new">Check all for new listings</button>
        </details>
        <div class="rf-row rf-presets">
          <select class="rf-preset" aria-label="Filter presets"></select>
        </div>
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
          <select class="rf-bulk" aria-label="Bulk action on the listings shown" disabled>
            <option value="">Bulk…</option><option value="star">Shortlist all shown</option><option value="hide">Hide all shown</option>
          </select>
          <button class="rf-btn sec rf-market-btn" aria-pressed="false" disabled title="Rent spread per bed count and when the listings shown become available">Market</button>
        </div>
        <div class="rf-actions rf-exports">
          <span class="rf-label">Export</span>
          <button class="rf-btn sec" data-export="csv" disabled>CSV</button>
          <button class="rf-btn sec" data-export="tsv" disabled>TSV</button>
          <button class="rf-btn sec" data-export="copy" disabled title="Copy as TSV - pastes into Sheets/Excel">Copy</button>
          <button class="rf-btn sec" data-export="ics" disabled title="Upcoming inspections as a calendar file">Calendar</button>
        </div>
      </div>
      <div class="rf-help" hidden>
        <strong>Keyboard</strong>
        <dl><dt>j / ↓, k / ↑</dt><dd>next / previous listing</dd><dt>s</dt><dd>shortlist</dd><dt>h</dt><dd>hide</dd>
        <dt>n</dt><dd>note</dd><dt>c</dt><dd>copy summary</dd><dt>m</dt><dd>market view on/off</dd><dt>x</dt><dd>tick for Compare (shortlist)</dd><dt>o / Enter</dt><dd>open listing</dd><dt>/</dt><dd>keyword filter (shortlist: search)</dd>
        <dt>?</dt><dd>this help</dd><dt>Esc</dt><dd>close</dd><dt>Alt+Shift+F</dt><dd>open / close from anywhere on REA</dd></dl>
      </div>
      <div class="rf-share-in" hidden role="region" aria-label="Shared listings">
        <span class="rf-share-msg"></span>
        <button class="rf-btn" data-share="add">Add to my shortlist</button>
        <button class="rf-btn sec" data-share="dismiss">Dismiss</button>
      </div>
      <div class="rf-status" role="status" aria-live="polite"></div>
      <div class="rf-active" hidden aria-label="Active filters"></div>
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
      active: panel.querySelector('.rf-active'),
      controls: panel.querySelector('.rf-controls'),
      tabs: [...panel.querySelectorAll('[role=tab]')],
      slBar: panel.querySelector('.rf-sl-bar'),
      slCount: panel.querySelector('.rf-count'),
      slFile: panel.querySelector('.rf-sl-bar input[type=file]'),
      slFilter: panel.querySelector('.rf-sl-filter'),
      slQuery: panel.querySelector('.rf-sl-q'),
      plan: panel.querySelector('.rf-plan'),
      bulk: panel.querySelector('.rf-bulk'),
      preset: panel.querySelector('.rf-preset'),
      slBulk: panel.querySelector('.rf-sl-bulk'),
      market: panel.querySelector('.rf-market-btn'),
      list: panel.querySelector('.rf-list'),
    };

    // Inputs map 1:1 to cfg keys via their id (rf-<key>); exactOnly keeps its legacy id.
    const fields = Object.keys(DEFAULT_CFG).map((k) => [k, panel.querySelector(`#rf-${k === 'exactOnly' ? 'exact' : k}`)]);
    const read = (el) => (el.type === 'checkbox' ? el.checked : el.value);
    const write = (el, v) => { if (el.type === 'checkbox') el.checked = !!v; else { ensureOption(el, v); el.value = v ?? ''; } };
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
    const noWatchInput = panel.querySelector('#rf-noWatch');
    const paintNoWatch = () => {
      const on = watchIds(noWatchInput.value);
      for (const b of panel.querySelectorAll('[data-nowatch]')) { b.setAttribute('aria-pressed', String(on.includes(b.dataset.nowatch))); b.dataset.state = on.includes(b.dataset.nowatch) ? 'no' : ''; }
    };
    panel.querySelector('.rf-nowatch').addEventListener('click', (e) => {
      const b = e.target.closest('[data-nowatch]');
      if (!b) return;
      const on = watchIds(noWatchInput.value), id = b.dataset.nowatch;
      noWatchInput.value = (on.includes(id) ? on.filter((x) => x !== id) : [...on, id]).join(',');
      paintNoWatch();
      noWatchInput.dispatchEvent(new Event('change'));
    });
    ui.paintAmen = () => { paintAmen(); paintNoWatch(); };
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
    ui.moreSummary = ui.more.querySelector('summary');
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
    const help = panel.querySelector('.rf-help'), helpBtn = panel.querySelector('.rf-keys');
    const toggleHelp = () => { help.hidden = !help.hidden; helpBtn.setAttribute('aria-expanded', String(!help.hidden)); };
    helpBtn.addEventListener('click', toggleHelp);
    const typing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
    // List shortcuts: act on the focused listing (or the first one).
    const listKeys = (e) => {
      const items = [...ui.list.querySelectorAll('.rf-item')];
      if (!items.length) return false;
      const cur = document.activeElement?.closest?.('.rf-item');
      const i = cur ? items.indexOf(cur) : -1;
      const move = (d) => { const n = items[Math.max(0, Math.min(items.length - 1, i + d))] || items[0]; n.focus(); n.scrollIntoView({ block: 'nearest' }); };
      const act = (a) => (cur || items[0]).querySelector(`[data-act="${a}"]`)?.click();
      switch (e.key) {
        case 'j': case 'ArrowDown': move(i < 0 ? 0 : 1); return true;
        case 'k': case 'ArrowUp': move(i < 0 ? 0 : -1); return true;
        case 's': act('s'); return true;
        case 'h': act('h'); return true;
        case 'n': act('n'); return true;
        case 'c': act('copy'); return true;
        case 'x': { const box = (cur || items[0]).querySelector('input[data-cmp]'); box?.click(); return !!box; }
        // Enter opens only when the item itself is focused; on a button it presses the button.
        case 'o': case 'Enter': if (!cur || (e.key === 'Enter' && document.activeElement !== cur)) return false; cur.querySelector('.rf-card')?.click(); return true;
        default: return false;
      }
    };
    document.addEventListener('keydown', (e) => {
      if (e.altKey && e.shiftKey && (e.key === 'F' || e.key === 'f' || e.code === 'KeyF') && isSearchPage(location.href)) {
        e.preventDefault();
        setOpen(panel.hidden);
        if (!panel.hidden) ui.run.focus(); else launch.focus();
        return;
      }
      if (panel.hidden) return;
      // Esc is ours only when focus is in the drawer (or it's full-screen): REA's own viewers use it too.
      if (e.key === 'Escape' && !e.defaultPrevented && (panel.contains(document.activeElement) || narrow.matches)) {
        if (!help.hidden) { toggleHelp(); return; }
        setOpen(false); launch.focus(); return;
      }
      const inPanel = panel.contains(document.activeElement);
      if (inPanel && !typing(document.activeElement) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === '?') { e.preventDefault(); toggleHelp(); return; }
        if (e.key === 'm' && ui.view !== 'shortlist' && !ui.market.disabled) { e.preventDefault(); ui.market.click(); ui.market.focus(); return; }
        if (e.key === '/' && ui.view === 'shortlist') { e.preventDefault(); ui.slQuery.focus(); return; }
        if (e.key === '/' && ui.view !== 'shortlist') { e.preventDefault(); ui.more.open = true; panel.querySelector('#rf-keyword').focus(); return; }
        if (!document.activeElement.closest('button, a, summary') || document.activeElement.closest('.rf-item')) {
          if (listKeys(e)) { e.preventDefault(); return; }
        }
      }
      if (e.key === 'Tab' && narrow.matches) {
        const f = [...panel.querySelectorAll('button,input,select,textarea,a[href],summary')].filter((el) => el.offsetParent && !el.disabled);
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    });
    panel.querySelector('.rf-clear').addEventListener('click', () => {
      const before = { ...cfg };
      // Resets filters only; display preferences (sort, annotate, dim) are kept.
      for (const [k, el] of fields) write(el, DISPLAY_PREFS.includes(k) ? cfg[k] : DEFAULT_CFG[k]);
      ui.paintAmen();
      queueMicrotask(() => offerUndo('Filters cleared.', () => {
        for (const [k, el] of fields) write(el, before[k]);
        ui.paintAmen();
        onChange({ type: 'change' });
      }));
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
        ui.savedCtrl?.abort();
        snaps.clear();
        applySnap(null);
        renderSaved();
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
      if (b.dataset.act === 'copy') {
        const r = rowById(id) || ui.rows?.find((x) => x.id === id);
        if (r) copyText(summaryText(r)).then((ok) => setStatus(ok ? 'Listing summary copied.' : 'Clipboard blocked.', !ok));
        return;
      }
      if (b.dataset.act === 'sb') {
        const r = rowById(id);
        if (!r?.suburb) return;
        const on = marks.toggleSuburb(r.suburb);
        refreshMarks();
        ui.list.focus();
        return offerUndo(on ? `Hidden all listings in ${r.suburb}.` : `Showing ${r.suburb} again.`, () => { marks.toggleSuburb(r.suburb); refreshMarks(); });
      }
      if (b.dataset.act === 'ag') {
        const r = rowById(id);
        if (!r?.agency) return;
        const on = marks.toggleAgency(r.agency);
        refreshMarks();
        ui.list.focus();
        return offerUndo(on ? `Hidden all listings from ${r.agency}.` : `Showing ${r.agency} again.`, () => { marks.toggleAgency(r.agency); refreshMarks(); });
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
      const cmp = e.target.closest('input[data-cmp]');
      if (cmp) {
        ui.cmpSel = ui.cmpSel || new Set();
        if (cmp.checked) ui.cmpSel.add(cmp.dataset.cmp); else ui.cmpSel.delete(cmp.dataset.cmp);
        return;
      }
      const sel = e.target.closest('select[data-app]');
      if (!sel) return;
      const id = sel.closest('.rf-item').dataset.id;
      marks.setStatus(id, sel.value);
      refreshMarks();
      ui.list.querySelector(`.rf-item[data-id="${CSS.escape(id)}"] select[data-app]`)?.focus();
    });

    for (const tab of ui.tabs) tab.addEventListener('click', () => setView(tab.dataset.view));
    ui.slFilter.addEventListener('change', () => renderShortlist());
    let slqT = null;
    ui.slQuery.addEventListener('input', () => { clearTimeout(slqT); slqT = setTimeout(renderShortlist, 150); });
    ui.plan.addEventListener('change', () => {
      ui.planDay = ui.plan.value || null;
      if (ui.planDay && ui.compare) ui.slBar.querySelector('[data-sl=compare]').click(); // one view at a time
      renderShortlist();
    });
    ui.preset.addEventListener('change', () => {
      const v = ui.preset.value;
      ui.preset.value = '';
      if (v === 'c:save' || v === 'c:bind') {
        const key = v === 'c:bind' ? currentKey() : null;
        const name = window.prompt(key ? 'Preset name (auto-applies on this search):' : 'Preset name:', '');
        const saved = name && presets.save(name, cfg, key);
        if (saved) setStatus(`Saved preset "${saved}"${key ? ' for this search' : ''}.`);
      } else if (v.startsWith('d:')) {
        presets.remove(v.slice(2));
        setStatus(`Deleted preset "${v.slice(2)}".`);
      } else if (v.startsWith('a:')) applyPreset(presets.get(v.slice(2)));
      fillPresets();
    });
    // Bulk actions: one write, one re-render, one undo that restores the exact previous state.
    const bulk = (sel, fn) => sel.addEventListener('change', () => {
      const v = sel.value;
      sel.value = '';
      const rows = (sel === ui.slBulk && ui.view === 'shortlist' && ui.bulkRows) || ui.rows;
      if (!v || !rows?.length) return;
      const before = marks.dump(rows.map((r) => r.id));
      const msg = fn(v, rows);
      refreshMarks();
      if (msg) offerUndo(msg, () => { marks.restoreDump(before); refreshMarks(); });
    });
    bulk(ui.bulk, (v, rows) => {
      if (v === 'star') {
        const n = marks.setMany(rows.slice(0, BULK_STAR_MAX), 's', true);
        return `Shortlisted ${n}${rows.length > BULK_STAR_MAX ? ` (first ${BULK_STAR_MAX} shown)` : ''}.`;
      }
      if (v === 'hide') return `Hid ${marks.setMany(rows, 'h', true)} listings.`;
      return '';
    });
    bulk(ui.slBulk, (v, rows) => {
      if (v.startsWith('status:')) return `Marked ${marks.setStatusMany(rows.map((r) => r.id), v.slice(7))} as ${v.slice(7)}.`;
      if (v === 'unstar-declined') return `Removed ${marks.setMany(rows.filter((r) => r.appStatus === 'declined'), 's', false)} declined.`;
      if (v === 'unstar') return `Removed ${marks.setMany(rows, 's', false)} from the shortlist.`;
      return '';
    });
    ui.market.addEventListener('click', () => {
      ui.marketOn = !ui.marketOn;
      ui.market.setAttribute('aria-pressed', String(ui.marketOn));
      showResults();
    });
    ui.list.addEventListener('click', (e) => {
      const b = e.target.closest('[data-week]');
      if (!b || !ui.rows) return;
      const w = marketStats(ui.rows).byWeek[+b.dataset.week];
      const later = new Date(); later.setDate(later.getDate() + 1 + MARKET_WEEKS * 7);
      const range = w.label === 'Now' ? { from: '', to: ymdLocal(new Date()) } : w.label === 'Later' ? { from: ymdLocal(later), to: '' } : { from: w.from, to: w.to };
      // Narrow within your own dates (a "within" window becomes its end date), never widen them.
      const tos = [range.to, cfg.to, windowEnd(cfg.withinDays)].filter(Boolean).sort();
      const next = { ...cfg, from: [range.from, cfg.from].filter(Boolean).sort().pop() || '', to: tos[0] || '', withinDays: '' };
      for (const [k, el] of fields) if (next[k] !== cfg[k]) write(el, next[k]);
      ui.marketOn = false;
      ui.market.setAttribute('aria-pressed', 'false');
      onChange({ type: 'change' });
      showResults(); // also when the dates didn't change (same week again)
      (ui.list.querySelector('.rf-item') || ui.market).focus();
    });
    ui.active.addEventListener('click', (e) => {
      const b = e.target.closest('[data-chip]');
      const chip = b && ui.activeChips?.[+b.dataset.chip];
      if (!chip) return;
      const next = without(cfg, chip);
      for (const [k, el] of fields) if (next[k] !== cfg[k]) write(el, next[k]);
      ui.paintAmen();
      onChange({ type: 'change' });
    });
    panel.querySelector('.rf-agencies').addEventListener('click', (e) => {
      const b = e.target.closest('[data-unhide-ag]');
      if (b) { marks.toggleAgency(b.dataset.unhideAg); refreshMarks(); }
      const sb = e.target.closest('[data-unhide-sb]');
      if (sb) { marks.toggleSuburb(sb.dataset.unhideSb); refreshMarks(); }
    });
    ui.slBar.querySelector('[data-sl=backup]').addEventListener('click', () => {
      const data = marks.exportData();
      data.presets = presets.exportData();
      if (cfg.remember) data.snapshots = snaps.exportData();
      download(`rea-backup-${stamp()}.json`, JSON.stringify(data), 'application/json');
    });
    ui.slBar.querySelector('[data-sl=restore]').addEventListener('click', () => ui.slFile.click());
    ui.slBar.querySelector('[data-sl=share]').addEventListener('click', async () => {
      const rows = shortlistRows();
      if (!rows.length) return setStatus('Nothing on the shortlist to share.', true);
      const notes = rows.some((r) => r.note) && window.confirm('Include your notes in the share link?');
      const url = shareUrl(rows, { notes });
      const ok = await copyText(url);
      setStatus(ok ? `Share link copied (${Math.min(rows.length, SHARE_MAX)} listings${notes ? ', with notes' : ''}). Anyone with this script can open it.`
        : 'Clipboard blocked - could not copy the share link.', !ok);
    });
    // Incoming share (#rf-share=...): offer to import, then strip it from the URL.
    const shareIn = panel.querySelector('.rf-share-in');
    ui.offerShare = (rows) => {
      if (!rows?.length) return;
      shareIn.hidden = false;
      shareIn.querySelector('.rf-share-msg').textContent = `${rows.length} shared listing${rows.length === 1 ? '' : 's'}:`;
      ui.pendingShare = rows;
      launch.hidden = false;
      setOpen(true);
    };
    shareIn.addEventListener('click', (e) => {
      const b = e.target.closest('[data-share]');
      if (!b) return;
      const rows = ui.pendingShare || [];
      if (b.dataset.share === 'add') {
        const n = marks.setMany(rows, 's', true);
        for (const r of rows) if (r.note && !marks.note(r.id)) marks.setNote(r.id, `Shared: ${r.note}`);
        refreshMarks();
        setView('shortlist');
        setStatus(`Added ${n} shared listing${n === 1 ? '' : 's'} to your shortlist.`);
      }
      shareIn.hidden = true;
      ui.pendingShare = null;
    });
    ui.list.addEventListener('click', (e) => {
      if (!e.target.closest('[data-plan-ics]') || !ui.planDay) return;
      const day = ui.planDay;
      const rows = shortlistRows().map((r) => ({ ...r, inspections: (r.inspections || []).filter((i) => typeof i.at === 'number' && ymdIn(i.at, tzOf(r)) === day) }));
      downloadIcs(rows);
    });
    ui.slBar.querySelector('[data-sl=recheck]').addEventListener('click', (e) => recheckShortlist(e.currentTarget));
    const storageLine = panel.querySelector('.rf-storage-n');
    const paintStorage = () => {
      const ls = storageOr('localStorage'), ss = storageOr('sessionStorage');
      const c = marks.counts(), n = Object.keys(snaps.exportData()).length;
      storageLine.textContent = `Stored in this browser only: ${fmtBytes(toolBytes(ls) + toolBytes(ss))} (${c.starred} shortlisted, ${c.hidden} hidden, ${n} remembered search${n === 1 ? '' : 'es'}).`;
    };
    panel.querySelector('.rf-settings').addEventListener('toggle', (e) => { if (e.currentTarget.open) paintStorage(); });
    panel.querySelector('[data-forget]').addEventListener('click', () => {
      if (!window.confirm('Delete your shortlist, notes, hidden listings, presets, remembered searches and settings from this browser? Download a Backup first if you might want them back.')) return;
      for (const st of [storageOr('localStorage'), storageOr('sessionStorage')]) for (const k of toolKeys(st)) { try { st.removeItem(k); } catch { /* blocked */ } }
      marks.invalidate();
      location.reload();
    });
    ui.saved = panel.querySelector('.rf-saved');
    ui.savedResult = new Map();
    ui.saved.querySelector('[data-saved-check]').addEventListener('click', (e) => checkSaved(e.currentTarget));
    ui.slBar.querySelector('[data-sl=print]').addEventListener('click', () => {
      const rows = shortlistRows();
      if (!rows.length) return setStatus('Nothing on the shortlist to print.', true);
      const w = window.open('', '_blank');
      if (!w) return setStatus('Pop-up blocked - allow pop-ups for realestate.com.au to print.', true);
      w.document.open();
      w.document.write(printHtml(rows));
      w.document.close();
      w.addEventListener('load', () => w.print(), { once: true });
    });
    ui.slBar.querySelector('[data-sl=compare]').addEventListener('click', (e) => {
      ui.compare = !ui.compare;
      if (ui.compare) { ui.planDay = null; ui.plan.value = ''; }
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
        presets.importData(data.presets);
        fillPresets();
        renderSaved();
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
          const ok = await copyText(toTsv(rows));
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
    ui.active.hidden = true; // results view re-shows it via renderActive()
    ui.slBar.hidden = !sl;
    ui.panel.querySelector('.rf-clear').hidden = sl; // filters don't apply to the shortlist
    ui.panel.classList.toggle('rf-wide', sl && !!ui.compare);
    if (sl) renderShortlist();
    else if (cache) showResults();
    else { setEmpty(EMPTY_INTRO); setStatus(''); setExport(true); }
  }

  const shortlistRows = () => {
    const f = ui.slFilter.value, q = ui.slQuery.value;
    return marks.shortlist().filter((r) => (!f || (f === '-' ? !r.appStatus : r.appStatus === f)) && textMatch(r, q));
  };

  // Re-check shortlisted listings one at a time (user-initiated, polite delay, abortable).
  const RECHECK_MAX = 30;
  // User-started background jobs (re-check, check all) share the search's abort/busy slot.
  const startJob = (btn) => { runCtrl?.abort(); const c = runCtrl = new AbortController(); setBusy(true); btn.setAttribute('aria-disabled', 'true'); return c; };
  const endJob = (c, btn) => { if (runCtrl === c) { runCtrl = null; setBusy(false); } btn.removeAttribute('aria-disabled'); }; // a search that took over owns busy now

  async function recheckShortlist(btn) {
    if (busy) return;
    const rows = shortlistRows().slice(0, RECHECK_MAX);
    if (!rows.length) return setStatus('Nothing on the shortlist to re-check.', true);
    const ctrl = startJob(btn);
    const tally = { ok: 0, gone: 0, unknown: 0 };
    try {
      for (const [i, r] of rows.entries()) {
        setStatus(`Re-checking ${i + 1} of ${rows.length}…`);
        let res, html;
        try { // body read inside too: a reset mid-download is one unreadable listing, not the end
          res = await fetch(r.url, { credentials: 'include', signal: withTimeout(ctrl.signal, FETCH_TIMEOUT_MS) });
          html = res.ok ? await res.text() : '';
        } catch (err) {
          if (ctrl.signal.aborted) throw err;
          tally.unknown++; continue;
        }
        const out = parseListingPage(html, r.id, { status: res.status, redirectedTo: res.redirected ? res.url : '' });
        tally[out.status]++;
        if (out.status === 'gone') marks.setGone(r.id, true);
        if (out.status === 'ok') { const row = safeRow(out.listing, false); if (row) learn([row]); }
        if (i < rows.length - 1) await sleep(jitter(PAGE_DELAY_MS), ctrl.signal);
      }
      refreshMarks();
      setStatus(`Re-checked ${rows.length}: ${tally.ok} updated, ${tally.gone} no longer listed${tally.unknown ? `, ${tally.unknown} couldn't be read` : ''}.`);
    } catch {
      setStatus('Re-check stopped.');
    } finally {
      endJob(ctrl, btn);
    }
  }

  // Remembered searches, newest first, with what the last "Check all" found.
  function renderSaved() {
    const entries = cfg.remember ? Object.entries(snaps.exportData()).sort(([, a], [, b]) => b.at - a.at) : [];
    ui.saved.hidden = !entries.length;
    const here = currentKey();
    ui.saved.querySelector('.rf-saved-list').innerHTML = entries.map(([k, e]) => {
      const r = ui.savedResult.get(k);
      const found = r ? ` · <strong>${r.added} new</strong>${r.gone ? `, ${r.gone} gone` : ''}` : '';
      return `<li><a href="${esc(safeUrl(k))}">${esc(searchLabel(k))}</a>${k === here ? ' <span class="rf-tag">this search</span>' : ''}
        <div class="rf-meta">${(e.ids || e.rows || []).length} listings · checked ${esc(ago(Date.now() - e.at))}${found}</div></li>`;
    }).join('');
  }

  async function checkSaved(btn) {
    if (busy) return;
    const keys = Object.entries(snaps.exportData()).sort(([, a], [, b]) => b.at - a.at).map(([k]) => k);
    if (!keys.length) return;
    const ctrl = ui.savedCtrl = startJob(btn);
    pageMemo.clear(); // "new since" must mean now, not the pages cached a few minutes ago
    const out = [];
    try {
      for (const [i, key] of keys.entries()) {
        const label = searchLabel(key);
        const before = new Set(snaps.exportData()[key]?.ids || []);
        const res = await fetchAllPages(key, (m) => setStatus(`Checking ${label} (${i + 1} of ${keys.length}): ${m}`), {
          signal: ctrl.signal, getPage: (url) => getPage(url, { signal: ctrl.signal }),
        });
        const ids = new Set(res.rows.map((r) => r.id));
        const found = { added: res.rows.filter((r) => !before.has(r.id)).length, gone: [...before].filter((id) => !ids.has(id)).length };
        if (!cfg.remember) throw new DOMException('remember turned off', 'AbortError'); // opted out mid-check: store nothing
        store.set(key, res.rows, res.truncated);
        const snap = snaps.save(key, res.rows, res.truncated);
        if (key === currentKey()) adopt(key, res.rows, res.truncated, '', snap, true);
        else learn(res.rows, true);
        ui.savedResult.set(key, found);
        out.push(`${label}: ${found.added} new${found.gone ? `, ${found.gone} gone` : ''}`);
        if (i < keys.length - 1) await sleep(jitter(PAGE_DELAY_MS), ctrl.signal);
      }
      setStatus(`Checked ${keys.length} saved search${keys.length === 1 ? '' : 'es'}. ${out.join(' · ')}.`);
    } catch (err) {
      // Aborted by navigation or opting out: whoever aborted has already said why.
      if (!ctrl.signal.aborted && err?.name !== 'AbortError') { setStatus(`Check failed: ${err.message}`, true); logError(`saved: ${err.message}`); }
    } finally {
      endJob(ctrl, btn);
      if (ui.savedCtrl === ctrl) ui.savedCtrl = null;
      renderSaved();
    }
  }

  function renderShortlist() {
    const rows = shortlistRows();
    // Distance for the shortlist too (applyFilters isn't run over it).
    const anchor = parseAnchor(cfg.anchor);
    for (const r of rows) r.km = kmFrom(anchor, r);
    ui.rows = rows;
    setExport(rows.length === 0);
    const days = inspectDays(rows);
    ui.plan.innerHTML = `<option value="">Plan a day…</option>` + days.map(({ day, n }) =>
      `<option value="${day}">${esc(shortDate(day))} (${n} inspection${n === 1 ? '' : 's'})</option>`).join('');
    if (ui.planDay && !days.some((d) => d.day === ui.planDay)) ui.planDay = null;
    ui.plan.value = ui.planDay || '';
    ui.plan.hidden = !days.length;
    const slots = ui.planDay ? planDay(rows, ui.planDay) : null;
    const picked = ui.cmpSel?.size ? rows.filter((r) => ui.cmpSel.has(r.id)) : [];
    // A selection hidden by the status filter falls back to the first listings shown.
    const cmp = ui.compare && !slots ? (picked.length ? picked : rows).slice(0, COMPARE_MAX) : null;
    ui.cmpPicked = picked.length > 0;
    // Bulk actions act on what's on screen: the planned day's or compared listings when those views are up.
    ui.bulkRows = slots ? [...new Set(slots.map((x) => x.r))] : cmp || null;
    const total = marks.counts().starred;
    ui.list.innerHTML = !rows.length ? (total ? '<div class="rf-empty">Nothing on the shortlist matches.</div>' : '<div class="rf-empty">No shortlisted listings yet.<br>Use ☆ on any result to add one.</div>')
      : slots ? planHtml(slots, ui.planDay)
      : cmp ? compareHtml(cmp)
      : itemsHtml(rows.slice(0, RENDER_CHUNK)) + moreHtml(rows.length - RENDER_CHUNK);
    setStatus(rows.length ? `${rows.length < total ? `${rows.length} of ${total}` : rows.length} shortlisted across all searches. Details are as last seen.` : '');
  }

  const updateCounts = () => {
    if (ui.launch) setLaunchCount(ui.launchN ?? null);
    const ags = marks.hiddenAgencies();
    const sbs = marks.hiddenSuburbs();
    const box = ui.panel.querySelector('.rf-agencies');
    box.hidden = !ags.length && !sbs.length;
    box.querySelector('.rf-ag-list').innerHTML = ags.map((a) =>
      `<button type="button" class="rf-chip" data-unhide-ag="${esc(a)}" aria-label="Show ${esc(a)} again">${esc(a)} ×</button>`).join('') +
      sbs.map((a) => `<button type="button" class="rf-chip" data-unhide-sb="${esc(a)}" aria-label="Show suburb ${esc(a)} again">${esc(a)} (suburb) ×</button>`).join('');
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

  const setExport = (disabled) => { for (const b of ui.exports) b.disabled = disabled; ui.bulk.disabled = disabled; ui.market.disabled = disabled; };

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
    renderActive();
    const st = diffStats(cache);
    const matchHint = cfg.sort === 'match' && !rows.some((r) => r.score != null)
      ? ' Best match needs two of: a max rent (or enough listings for a median), a "from" date, a distance point, known bonds.' : '';
    const since = baseAt ? ` since ${ago(Date.now() - baseAt)}` : '';
    const extra = [st.fresh && `${st.fresh} new${since}`, gone.length && `${gone.length} no longer listed`, st.moved && `${st.moved} price changed`, st.redated && `${st.redated} date changed`,
      !cfg.showHidden && st.hidden && `${st.hidden} hidden`].filter(Boolean).join(' · ');
    setStatus(`${rows.length} of ${cache.length} listings match.${extra ? ` ${extra}.` : ''}` +
      (truncated ? ` Only the first ${MAX_PAGES} pages were read - narrow the search for full coverage.` : '') +
      (note ? ` ${note}` : '') + matchHint);
    const warn = schemaWarnings(cache);
    if (warn.length) setStatus(`REA's data format may have changed (${warn.join('; ')}). Run reaFilter.probe() in the console and report the output.`, true);
  }

  // Chips for active filters with how many listings each removes; click to drop that filter.
  function renderActive() {
    const chips = cache ? removedBy(pool(), cfg) : [];
    ui.active.hidden = !chips.length || ui.view === 'shortlist';
    ui.active.innerHTML = chips.map((c, i) => `<button type="button" class="rf-chip rf-achip" data-chip="${i}"
      aria-label="Remove filter ${esc(c.label)}${c.removes ? `, hiding ${c.removes}` : ''}">${esc(c.label)}${c.removes ? ` <span>−${c.removes}</span>` : ''} ×</button>`).join('');
    ui.activeChips = chips;
    ui.moreSummary.textContent = `More filters${chips.length ? ` (${chips.length} active)` : ''}`;
  }

  function render(rows) {
    ui.rows = rows; // first: renderMore()/refreshMarks() read it even when the list is empty
    setExport(rows.length === 0);
    setLaunchCount(rows.length);
    if (!rows.length) return setEmpty('Nothing matches those filters.');
    ui.list.innerHTML = ui.marketOn ? marketHtml(marketStats(rows)) : itemsHtml(rows.slice(0, RENDER_CHUNK)) + moreHtml(rows.length - RENDER_CHUNK);
    ui.list.scrollTop = 0;
  }

  function planHtml(slots, day) {
    // Zone name only when the listing's clock differs from yours (Melbourne from Sydney doesn't).
    const clock = (ms, tz) => new Date(ms).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) });
    const t = (ms, tz) => (tz && clock(ms, tz) !== clock(ms) ? new Date(ms).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', timeZone: tz, timeZoneName: 'short' }) : clock(ms, tz))
      .replace(/\s?(am|pm)/i, (m) => m.trim().toLowerCase());
    const clashes = slots.filter((x) => x.flag).length;
    return `<div class="rf-planner"><div class="rf-plan-head">${esc(shortDate(day))}: ${slots.length} inspection${slots.length === 1 ? '' : 's'}${clashes ? `, <strong>${clashes} to check</strong>` : ''}
      <button class="rf-btn sec" data-plan-ics>Calendar for this day</button></div>
      <ol>${slots.map((x) => `<li class="${x.flag ? `rf-${x.flag}` : ''}"><span class="rf-plan-t">${t(x.at, x.tz)}</span>
        <a href="${esc(x.r.url)}" target="_blank" rel="noopener">${esc(x.r.address)}</a> <span class="rf-type">${esc(x.r.price)}</span>
        ${x.gapMin != null ? `<div class="rf-meta">${x.same ? 'Another time for the same listing' : x.flag === 'clash' ? 'Overlaps the previous inspection' : `${x.gapMin} min after the previous${x.km != null ? `, ${x.km} km away` : ''}${x.flag === 'tight' ? ' — tight' : ''}`}</div>` : ''}
      </li>`).join('')}</ol><div class="rf-meta">Assumes ${INSPECT_MINUTES} min per inspection and straight-line distance.</div></div>`;
  }

  function marketHtml(m) {
    const $ = (v) => (v == null ? '–' : money(v));
    const range = (a, b) => (a == null ? '–' : a === b ? $(a) : `${$(a)}–${$(b)}`);
    const top = Math.max(1, ...m.byWeek.map((w) => w.n));
    const weekLabel = (w) => w.label || shortDate(w.from);
    return `<div class="rf-market"><div class="rf-plan-head">${m.n} listing${m.n === 1 ? '' : 's'} shown${m.median != null ? ` · median ${$(m.median)}/wk` : ''}</div>
      <div class="rf-market-t"><table><caption>Weekly rent by bedrooms</caption><thead><tr><th scope="col">Beds</th><th scope="col">Listings</th><th scope="col">Median</th><th scope="col">Middle half</th><th scope="col">Range</th><th scope="col">Per bed</th></tr></thead>
      <tbody>${m.byBeds.map((g) => `<tr><th scope="row">${g.beds === 0 ? 'Studio' : g.beds === 5 ? '5+' : g.beds}</th><td>${g.n}</td><td>${$(g.median)}</td>
        <td>${range(g.p25, g.p75)}</td><td>${range(g.min, g.max)}</td><td>${$(g.ppb)}</td></tr>`).join('')}</tbody></table></div>
      <h3>Available</h3><ul class="rf-bars">${m.byWeek.map((w, i) => [w, i]).filter(([w]) => w.n || w.from).map(([w, i]) => {
        const data = w.label === 'Unknown' ? '' : ` data-week="${i}"`;
        const inner = `<span class="rf-bar-l">${esc(weekLabel(w))}</span><span class="rf-bar" style="width:${Math.round((w.n / top) * 100)}%"></span><span class="rf-bar-n">${w.n}</span>`;
        return `<li>${data && w.n ? `<button type="button"${data} title="Show listings available ${w.from ? `${esc(shortDate(w.from))} to ${esc(shortDate(w.to))}` : esc(w.label.toLowerCase())}">${inner}</button>` : `<div>${inner}</div>`}</li>`;
      }).join('')}</ul>
      <div class="rf-meta">Over the listings your filters show. Medians need ${MEDIAN_MIN}+ priced listings. Click a week to filter to it.</div></div>`;
  }

  // Side-by-side comparison: one column per listing, best value per row highlighted.
  const COMPARE_ROWS = [
    ['Rent', (r) => r.price, (r) => r.priceNum, 'min'],
    ['Per bed', (r) => ppbLabel(r) || (Number.isFinite(r.ppb) ? `$${r.ppb}` : ''), (r) => r.ppb, 'min'],
    ['Move-in', (r) => (Number.isFinite(r.upfront) ? money(r.upfront) : ''), (r) => r.upfront, 'min'],
    ['Available', (r) => r.available, (r) => (r.avail ? +r.avail : Infinity), 'min'],
    ['Beds · baths · cars', (r) => [r.beds, r.baths, r.cars].map((v) => (v === '' ? '?' : v)).join(' · '), (r) => -(+r.beds || 0), 'min'],
    ['Distance', (r) => kmLabel(r).replace(' away', ''), (r) => r.km ?? Infinity, 'min'],
    ['Of income', (r) => (incomePct(r, cfg.income) != null ? `${incomePct(r, cfg.income)}%` : ''), (r) => incomePct(r, cfg.income) ?? Infinity, 'min'],
    ['Next inspection', (r) => r.inspections?.[0]?.label || '', null],
    ['Amenities', (r) => amenityTags(r).join(', '), null],
    ['Heads-up', (r) => watchTags(r).join(', '), null],
    ['Agency', (r) => r.agency || '', null],
    ['Status', (r) => statusLabel(r.appStatus), null],
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
    const body = COMPARE_ROWS.filter(([label]) => label !== 'Of income' || num(cfg.income) > 0).map(([label, show, score]) => {
      const b = score ? best(score) : null;
      return `<tr><th scope="row">${label}</th>${rows.map((r) => `<td${b != null && score(r) === b ? ' class="rf-best"' : ''}>${esc(show(r)) || '<span class="rf-na">–</span>'}</td>`).join('')}</tr>`;
    }).join('');
    return `<div class="rf-compare"><table><thead><tr><td></td>${head}</tr></thead><tbody>${body}</tbody></table></div>` +
      (ui.rows.length > rows.length ? `<div class="rf-empty">Comparing ${ui.cmpPicked ? 'your selection' : `the first ${rows.length}`}; tick "Compare" on listings to choose.</div>` : '');
  }

  // Drawer renders in chunks: 500 cards at once is a ~80ms long task on every filter change.
  const moreHtml = (left) => (left > 0 ? `<button class="rf-btn sec rf-more-btn">Show ${Math.min(left, RENDER_CHUNK)} more (${left} left)</button>` : '');
  function renderMore() {
    const shown = ui.list.querySelectorAll('.rf-item').length;
    ui.list.querySelector('.rf-more-btn')?.remove();
    ui.list.insertAdjacentHTML('beforeend', itemsHtml(ui.rows.slice(shown, shown + RENDER_CHUNK)) + moreHtml(ui.rows.length - shown - RENDER_CHUNK));
  }

  function itemsHtml(rows) {
    return rows.map((r) => {
      const am = amenityTags(r), wt = watchTags(r), km = kmLabel(r), inc = incomePct(r, cfg.income), med = medianLabel(r);
      return `
      <div tabindex="-1" class="rf-item${r.gone || r.hidden || r.agencyHidden || r.suburbHidden ? ' rf-hidden' : ''}${r.starred ? ' rf-starred' : ''}" data-id="${esc(r.id)}">
      <a class="rf-card" href="${esc(r.url)}" target="_blank" rel="noopener">
        ${r.img ? `<img src="${esc(r.img)}" alt="" loading="lazy">` : '<div></div>'}
        <div>
          <div class="rf-avail">${esc(r.available)}${r.prevAvail ? ` <span class="rf-was ${r.availDir === 'later' ? 'up' : 'down'}" title="Availability date changed">was ${esc(r.prevAvail)}</span>` : ''}${r.gone ? `<span class="rf-tag rf-gone"${r.goneAt ? ` title="Found gone ${esc(ago(Date.now() - r.goneAt))}"` : ''}>no longer listed</span>` : isFresh(r) ? '<span class="rf-tag rf-new">new</span>' : ''}${r.relisted ? `<span class="rf-tag" title="Same address was listed before${r.relisted.price ? ` at ${esc(r.relisted.price)}` : ''}${r.relisted.hidden ? '; you had hidden it' : ''}">relisted</span>` : ''}${r.surrounding ? '<span class="rf-tag">nearby</span>' : ''}</div>
          <div class="rf-price">${esc(r.price)}${r.type ? ` <span class="rf-type">${esc(r.type)}</span>` : ''}${r.prevPrice ? ` <span class="rf-was ${priceDir(r)}" title="${esc(historyText(r))}">was ${esc(r.prevPrice)}</span>` : ''}</div>
          <div class="rf-addr">${esc(r.address)}</div>
          <div class="rf-meta">${esc([
            r.beds !== '' ? `${r.beds} bed` : '',
            r.baths !== '' ? `${r.baths} bath` : '',
            r.cars !== '' ? `${r.cars} car` : '',
            r.bond ? `bond ${r.bond}` : '',
            ppbLabel(r),
          ].filter(Boolean).join(' · '))}</div>
          ${km || r.score != null ? `<div class="rf-meta">${esc(km)}${r.score != null ? `${km ? ' · ' : ''}<span class="rf-score" title="${esc(r.scoreWhy)}">Match ${r.score}</span>` : ''}</div>` : ''}
          ${r.agency || r.photos != null || r.floorplan ? `<div class="rf-meta">${esc([r.agency,
            r.photos != null ? `${r.photos} photo${r.photos === 1 ? '' : 's'}` : '', r.floorplan ? 'floorplan' : ''].filter(Boolean).join(' · '))}</div>` : ''}
          ${am.length ? `<div class="rf-tags">${am.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
          ${wt.length ? `<div class="rf-tags rf-watch" title="Mentioned in the listing text: worth asking the agent">${wt.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
          ${med ? `<div class="rf-meta rf-med ${r.vsMedian < 0 ? 'down' : r.vsMedian > 0 ? 'up' : ''}">${esc(med)}</div>` : ''}
          ${inc != null ? `<div class="rf-meta${inc > RENT_STRESS_PCT ? ' rf-warn-t' : ''}">${inc}% of income</div>` : ''}
          ${Number.isFinite(r.upfront) ? `<div class="rf-meta">Move-in ${money(r.upfront)}${r.bondWeeks > BOND_CAP_WEEKS ? ` <span class="rf-warn" title="Bond above ${BOND_CAP_WEEKS} weeks' rent; check your state's cap">bond ${r.bondWeeks} wks</span>` : ''}</div>` : ''}
          ${r.inspections?.length || r.listed || r.lastSeen ? `<div class="rf-meta">${esc([
            r.lastSeen && ui.view === 'shortlist' ? `seen ${ago(Date.now() - r.lastSeen)}` : '',
            r.inspections?.length ? `Inspect ${r.inspections[0].label}${r.inspections.length > 1 ? ` +${r.inspections.length - 1}` : ''}` : '',
            r.listed ? `Listed ${ago(Date.now() - r.listed)}` : '',
          ].filter(Boolean).join(' · '))}</div>` : ''}
        </div>
      </a>
      ${r.starred ? `<label class="rf-app">Application <select data-app aria-label="Application status">${statusOptions(r.appStatus)}</select></label>` : ''}
      ${r.note ? `<div class="rf-note">${esc(r.note)}</div>` : ''}
      <div class="rf-acts">
        <button data-act="s" aria-pressed="${r.starred}" aria-label="Shortlist" title="${r.starred ? 'Remove from shortlist' : 'Add to shortlist'}">${r.starred ? '★ Shortlisted' : '☆ Shortlist'}</button>
        <button data-act="h" title="${r.hidden ? 'Unhide' : 'Hide this listing'}">${r.hidden ? 'Unhide' : 'Hide'}</button>
        <button data-act="n" title="${r.note ? 'Edit note' : 'Add a note'}" aria-label="${r.note ? 'Edit note' : 'Add note'}">Note</button>
        <button data-act="copy" title="Copy a text summary of this listing" aria-label="Copy summary">Copy</button>
        ${ui.view === 'shortlist' ? `<label class="rf-cmp"><input type="checkbox" data-cmp="${esc(r.id)}"${ui.cmpSel?.has(r.id) ? ' checked' : ''}>Compare</label>` : ''}
        ${(r.suburb && ui.view !== 'shortlist') || r.agency ? `<details class="rf-acts-more"><summary aria-label="More actions" title="More actions">⋯</summary><div>
          ${r.suburb && ui.view !== 'shortlist' ? `<button data-act="sb" title="${r.suburbHidden ? 'Show' : 'Hide'} every listing in ${esc(r.suburb)}" aria-label="${r.suburbHidden ? 'Unhide' : 'Hide'} suburb ${esc(r.suburb)}">${r.suburbHidden ? 'Unhide suburb' : 'Hide suburb'}</button>` : ''}
          ${r.agency ? `<button data-act="ag" title="${r.agencyHidden ? 'Show' : 'Hide'} every listing from ${esc(r.agency)}" aria-label="${r.agencyHidden ? 'Unhide' : 'Hide'} agency ${esc(r.agency)}">${r.agencyHidden ? 'Unhide agency' : 'Hide agency'}</button>` : ''}
        </div></details>` : ''}
      </div>
      </div>`;
    }).join('');
  }

  function fillPresets() {
    const list = presets.list();
    const bound = presets.forSearch(currentKey());
    ui.preset.innerHTML = `<option value="">${bound ? `Preset: ${esc(bound.name)}` : 'Presets…'}</option>` +
      list.map((p) => `<option value="a:${esc(p.name)}">Apply: ${esc(p.name)}${p.key ? (p.key === currentKey() ? ' (this search)' : ' (another search)') : ''}</option>`).join('') +
      '<option value="c:save">Save current filters…</option><option value="c:bind">Save for this search…</option>' +
      list.map((p) => `<option value="d:${esc(p.name)}">Delete: ${esc(p.name)}</option>`).join('');
  }

  // A search's bound preset applies once per visit in this tab (a reload doesn't re-apply it
  // over your edits). Leaving for a search without one puts back the filters you had before.
  // The filters from before a bound preset live in localStorage (like cfg), so a reload or a
  // new tab still puts them back when you leave the preset's search.
  const PRESET_VISIT_KEY = 'rea-avail-filter/preset-visit';
  const PRESET_PREV_KEY = 'rea-avail-filter/preset-prev/v1';
  const prevStore = {
    get() { try { const v = JSON.parse(window.localStorage.getItem(PRESET_PREV_KEY)); return isObj(v) ? sanitizeCfg(v) : null; } catch { return null; } },
    set(v) { try { window.localStorage.setItem(PRESET_PREV_KEY, JSON.stringify(v)); } catch { /* quota/blocked */ } },
    clear() { try { window.localStorage.removeItem(PRESET_PREV_KEY); } catch { /* blocked */ } },
  };
  function enterSearchPresets(key) {
    const bound = key && presets.forSearch(key);
    let visited = null;
    try { visited = window.sessionStorage.getItem(PRESET_VISIT_KEY); } catch { /* blocked */ }
    if (bound) {
      if (visited === key) return;
      if (!prevStore.get()) prevStore.set(Object.fromEntries([...FILTER_KEYS, 'anchor', 'sort'].map((k) => [k, cfg[k]])));
      applyPreset(bound);
      try { window.sessionStorage.setItem(PRESET_VISIT_KEY, key); } catch { /* blocked */ }
      return;
    }
    if (!key) return; // a listing page or other REA page between searches isn't "leaving"
    try { window.sessionStorage.removeItem(PRESET_VISIT_KEY); } catch { /* blocked */ }
    const before = prevStore.get();
    if (before) {
      prevStore.clear();
      applyPreset({ name: 'your previous filters', cfg: before });
    }
  }

  // Apply a preset's filters through the normal field path (so everything stays in sync).
  function applyPreset(p) {
    if (!p) return;
    const next = { ...cfg, ...Object.fromEntries(FILTER_KEYS.map((k) => [k, DEFAULT_CFG[k]])), ...p.cfg };
    for (const [k, el] of ui.fields) {
      ensureOption(el, next[k]);
      if (el.value !== String(next[k] ?? '') || el.type === 'checkbox') (el.type === 'checkbox' ? (el.checked = !!next[k]) : (el.value = next[k] ?? ''));
    }
    ui.paintAmen();
    ui.fields[0][1].dispatchEvent(new Event('change'));
    setStatus(`Applied preset "${p.name}".`);
  }

  // A select can't take a value it has no option for yet (eg type before results load).
  function ensureOption(el, v) {
    if (el.tagName === 'SELECT' && v && ![...el.options].some((o) => o.value === v)) el.add(new Option(v, v));
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
    if (snap) queueMicrotask(renderSaved);
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
      let drops = [];
      try { drops = health.record(res.rows); } catch (e) { logError(`health: ${e.message}`); }
      if (drops.length) queueMicrotask(() => setStatus(`REA may have changed its data: ${drops.map((d) => `${d.field} on ${pct(d.now)} of listings (usually ${pct(d.usual)})`).join('; ')}. Run reaFilter.selfcheck() in the console and report it.`, true));
      store.set(key, res.rows, res.truncated);
      adopt(key, res.rows, res.truncated, '', cfg.remember ? snaps.save(key, res.rows, res.truncated) : null, true);
    } catch (err) {
      if (id !== runId || ctrl.signal.aborted) return;
      cache = null;
      cacheKey = null;
      setLaunchCount(null);
      setStatus(err.message, true);
      logError(`search: ${err.message}`);
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
    // Shortlisted cards show where you're up to (applied, inspected...) and your note on hover.
    const star = r.starred ? `<span class="rf-b-star"${r.note ? ` title="${esc(r.note)}"` : ''}>★ ${r.appStatus ? esc(statusLabel(r.appStatus)) : 'Shortlisted'}${r.note ? ' ✎' : ''}</span>` : '';
    const fresh = isFresh(r) ? '<span class="rf-b-new">New</span>' : '';
    const moved = r.prevPrice ? `<span class="rf-b-${priceDir(r)}">Was ${esc(r.prevPrice)}</span>` : '';
    const availMoved = r.prevAvail ? `<span title="Availability date changed">Avail was ${esc(r.prevAvail)}</span>` : '';
    const pets = r.amen?.pets === 'yes' ? '<span class="rf-b-pets">Pets OK</span>' : '';
    const km = r.km != null ? `<span>${esc(kmLabel(r).replace(' away', ''))}</span>` : '';
    return star + fresh + avail + availMoved + moved + pets + km + insp + ppb;
  };

  // Listing (property) page: a small bar to shortlist, set status, note or hide this listing
  // without going back to the results. Same marks store, so everything stays in sync.
  const isListingPage = (href) => /^\/property-[^/]*-\d{6,}\/?$/.test(new URL(href).pathname);
  function listingPageRow(id) {
    if (known.has(id)) return known.get(id);
    let ex = window.ArgonautExchange;
    if (!isObj(ex)) {
      const tag = exchangeScript();
      ex = tag ? parseListingPage(tag.outerHTML, id).listing ?? null : null;
      if (ex) return safeRow(ex, false);
    }
    const l = ex ? findListing(unpackJson(ex), id) : null;
    return (l && safeRow(l, false)) || { id, url: location.origin + location.pathname, address: '', price: '', inspections: [], partial: true };
  }
  // Minimised state is remembered: the bar can sit over REA's own buttons on small screens.
  const LBAR_MIN_KEY = 'rea-avail-filter/lbar-min';
  const lbarMin = {
    get() { try { return window.localStorage.getItem(LBAR_MIN_KEY) === '1'; } catch { return false; } },
    set(v) { try { if (v) window.localStorage.setItem(LBAR_MIN_KEY, '1'); else window.localStorage.removeItem(LBAR_MIN_KEY); } catch { /* blocked */ } },
  };
  function renderListingBar({ onlyIfMoved = false } = {}) {
    let bar = document.getElementById('rf-lbar');
    const id = isListingPage(location.href) ? listingId(location.pathname) : '';
    if (!id) { bar?.remove(); return; }
    if (onlyIfMoved && bar?.dataset.id === id) return; // same listing (eg a gallery ?query): keep focus
    const focusKey = bar?.contains(document.activeElement) ? document.activeElement.dataset.l : null;
    if (!bar) {
      bar = Object.assign(document.createElement('div'), { id: 'rf-lbar' });
      bar.setAttribute('role', 'region');
      bar.setAttribute('aria-label', 'Shortlist this listing');
      document.body.appendChild(bar);
      bar.addEventListener('click', onListingBar);
      bar.addEventListener('change', onListingBar);
    }
    const r = bar._row?.id === id ? bar._row : listingPageRow(id);
    marks.decorate([r]);
    bar.dataset.id = id;
    bar._row = r;
    const info = [r.prevPrice && `was ${r.prevPrice}`, r.prevAvail && `available was ${r.prevAvail}`, r.relisted && 'relisted',
      r.firstSeen && `first seen ${ago(Date.now() - r.firstSeen)}`].filter(Boolean).join(' · ');
    const small = lbarMin.get();
    bar.classList.toggle('rf-lbar-min', small);
    bar.innerHTML = small ? `<button type="button" data-l="s" aria-pressed="${r.starred}" aria-label="${r.starred ? 'Shortlisted' : 'Shortlist'}">${r.starred ? '★' : '☆'}</button>
      <button type="button" data-l="min" aria-expanded="false" aria-label="Show listing tools">⋯</button>` : `<button type="button" data-l="s" aria-pressed="${r.starred}">${r.starred ? '★ Shortlisted' : '☆ Shortlist'}</button>
      ${r.starred ? `<select data-l="as" aria-label="Application status">${statusOptions(r.appStatus)}</select>` : ''}
      <button type="button" data-l="n">${r.note ? 'Edit note' : 'Note'}</button>
      <button type="button" data-l="h" aria-pressed="${r.hidden}">${r.hidden ? 'Unhide' : 'Hide'}</button>
      <button type="button" data-l="min" aria-expanded="true" aria-label="Minimise listing tools" title="Minimise">–</button>
      ${r.note ? `<div class="rf-lbar-note">${esc(r.note)}</div>` : ''}${info ? `<div class="rf-lbar-info">${esc(info)}</div>` : ''}`;
    if (focusKey) bar.querySelector(`[data-l="${focusKey}"]`)?.focus();
    // Reached by in-app navigation: the page's data is the previous listing's, so read this one's page.
    if (r.partial && !bar._fetching) {
      bar._fetching = id;
      fetch(location.href, { credentials: 'include', signal: withTimeout(null, FETCH_TIMEOUT_MS) }).then((res) => (res.ok ? res.text() : ''))
        .then((html) => { const out = parseListingPage(html, id); if (out.status === 'ok' && bar.dataset.id === id) { const row = safeRow(out.listing, false); if (row) { bar._row = row; renderListingBar(); } } })
        .catch(() => {}).finally(() => { bar._fetching = null; });
    }
  }
  function onListingBar(e) {
    const bar = e.currentTarget, id = bar.dataset.id, r = bar._row;
    const el = e.target.closest('[data-l]');
    if (!el || (e.type === 'click' && el.tagName === 'SELECT')) return;
    const k = el.dataset.l;
    if (k === 'min') lbarMin.set(!lbarMin.get());
    else if (k === 's' || k === 'h') marks.toggle(id, k, r);
    else if (k === 'as') marks.setStatus(id, el.value);
    else if (k === 'n') {
      const text = window.prompt('Private note for this listing:', r.note || '');
      if (text == null) return;
      marks.setNote(id, text);
    }
    renderListingBar();
    bar.querySelector(`[data-l="${k}"]`)?.focus();
  }

  // Star / hide right on REA's card. Buttons live inside our badge (append-only), and the
  // click is stopped in the capture phase so REA's card link doesn't navigate.
  const cardActsHtml = (r) => `<span class="rf-card-acts">` +
    `<button type="button" data-card-act="s" data-id="${esc(r.id)}" aria-pressed="${!!r.starred}" aria-label="${r.starred ? 'Remove from shortlist' : 'Shortlist'}" title="${r.starred ? 'Remove from shortlist' : 'Shortlist'}">${r.starred ? '★' : '☆'}</button>` +
    `<button type="button" data-card-act="h" data-id="${esc(r.id)}" aria-label="${r.hidden ? 'Unhide' : 'Hide'} listing" title="${r.hidden ? 'Unhide' : 'Hide'} listing">${r.hidden ? 'Unhide' : 'Hide'}</button></span>`;

  function watchCardActions() {
    const onAct = (e) => {
      const b = e.target.closest?.('[data-card-act]');
      if (!b) return;
      e.stopPropagation();
      if (e.type === 'touchend') return; // cancelling it would also cancel the click
      e.preventDefault();
      if (e.type !== 'click') return; // press/release events only swallowed, so REA sees nothing
      const id = b.dataset.id, act = b.dataset.cardAct;
      const on = marks.toggle(id, act, rowById(id));
      refreshMarks();
      if (act === 'h' && on) offerUndo('Listing hidden.', () => { marks.toggle(id, 'h'); refreshMarks(); });
      else if (act === 's') setStatus(on ? 'Added to shortlist.' : 'Removed from shortlist.');
    };
    for (const type of ['click', 'auxclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchend']) document.addEventListener(type, onAct, true);
  }

  const filtersActive = () => activeFilters(cfg).length > 0;

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
      r.km = kmFrom(anchor, r);
      const html = badgeHtml(r) + cardActsHtml(r);
      if (!badge) { badge = document.createElement('div'); badge.className = 'rf-badge'; card.appendChild(badge); }
      // Compare against what we wrote, not innerHTML (browser re-serialises entities).
      if (badge.dataset.rfHtml !== html) { badge.innerHTML = html; badge.dataset.rfHtml = html; }
      const m = (r.hidden || r.agencyHidden || r.suburbHidden) && !cfg.showHidden ? '0' : matches ? (matches.has(id) ? '1' : '0') : '';
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
      ui.launch.hidden = !active && !ui.pendingShare; // an unanswered share offer stays reachable
      if (!active && !ui.pendingShare) ui.setOpen(false);
      setTimeout(ensureVisiblePage, NAV_SETTLE_MS);
      const key = currentKey();
      if (key === lastKey) return; // same search, different page/view
      fillPresets();
      renderSaved();
      setTimeout(() => enterSearchPresets(key), 0); // after the old search's state is cleared below
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
    // Copyable diagnostics for a bug report: no listing text, no search terms beyond the path.
    selfcheck: () => {
      const rows = cache || [];
      const rates = fillRates(rows), usual = health.usual();
      const report = [
        `rea-enhancement ${window.reaFilter.version}`, `page: ${location.pathname}`, `rows: ${rows.length}${truncated ? ' (truncated)' : ''}`,
        `fields (this search / usual): ${Object.keys(HEALTH_FIELDS).map((k) => `${k} ${pct(rates[k])}/${usual.ema[k] == null ? '?' : pct(usual.ema[k])}`).join(', ')}`,
        `discovered paths: ${Object.entries(found).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`,
        `schema warnings: ${schemaWarnings(rows).join('; ') || 'none'}`,
        `recent errors: ${errorLog.length ? `\n  ${errorLog.join('\n  ')}` : 'none'}`,
      ].join('\n');
      console.log(report);
      copyText(report).catch(() => {});
      return report;
    },
  };

  // Each step isolated: a failure in one (eg REA drift) must not take the others down.
  const step = (name, fn) => {
    const fail = (e) => { console.warn(`[reaFilter] ${name}:`, e); logError(`${name}: ${e?.message || e}`); };
    try { const r = fn(); if (r?.catch) r.catch(fail); } catch (e) { fail(e); }
  };
  step('build', build);
  if (ui?.ready) { // only wire the rest if build() completed
    step('launch', () => { ui.launch.hidden = !isSearchPage(location.href); ui.view = 'results'; updateCounts(); });
    step('boot', () => { if (boot) learn(rowsFrom(boot.results)); });
    step('navigation', watchNavigation);
    step('cards', watchCards);
    step('card actions', watchCardActions);
    step('sync', () => window.addEventListener('storage', (e) => {
      // Another tab changed the shortlist/hidden/notes: pick it up here.
      if (e.key === MARKS_KEY || e.key === null) { marks.invalidate(); refreshMarks(); }
    }));
    step('presets', () => { fillPresets(); enterSearchPresets(currentKey()); });
    step('share', () => {
      if (!new RegExp(`[#&]${SHARE_PARAM}=`).test(location.hash)) return;
      const rows = shareFromHash(location.hash);
      history.replaceState(history.state, '', location.pathname + location.search); // don't keep it in history
      if (rows?.length) { ui.offerShare(rows); return; }
      ui.launch.hidden = false;
      ui.setOpen(true);
      setStatus('This share link is incomplete or damaged (it may have been cut off when pasted). Ask for it again.', true);
    });
    step('restore', restore);
    step('listing bar', () => {
      renderListingBar();
      window.addEventListener('rf:navigate', () => setTimeout(() => renderListingBar({ onlyIfMoved: true }), NAV_SETTLE_MS));
      window.addEventListener('storage', (e) => { if ((e.key === MARKS_KEY || e.key === null) && document.getElementById('rf-lbar')) { marks.invalidate(); renderListingBar(); } });
    });
    step('saved', renderSaved);
    step('annotate', ensureVisiblePage);
  }
})();

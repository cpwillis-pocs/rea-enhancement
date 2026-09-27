// ==UserScript==
// @name         REA Availability Filter
// @namespace    https://github.com/cpwillis-pocs/rea-enhancement
// @version      2.25.0
// @description  Availability-date filtering and sorting, extra filters, cross-page merging, on-card availability badges and CSV/TSV export for realestate.com.au rental searches.
// @author       cpwillis
// @homepageURL  https://github.com/cpwillis-pocs/rea-enhancement
// @supportURL   https://github.com/cpwillis-pocs/rea-enhancement/issues
// @license      MIT
// @updateURL    https://raw.githubusercontent.com/cpwillis-pocs/rea-enhancement/main/rea-availability-filter.user.js
// @downloadURL  https://raw.githubusercontent.com/cpwillis-pocs/rea-enhancement/main/rea-availability-filter.user.js
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

  // Every storage key starts with this, so Settings can measure and delete only our data.
  const TOOL_PREFIX = 'rea-avail-filter/';
  const CFG_KEY = `${TOOL_PREFIX}v1`;
  const IMG_SIZE = '345x260';
  const PEEK_SIZE = '800x600'; // photo peek: the same REA image at a larger size
  const bigImg = (url) => (String(url || '').includes(`/${IMG_SIZE}/`) ? url.replace(`/${IMG_SIZE}/`, `/${PEEK_SIZE}/`) : url || '');
  const PAGE_DELAY_MS = 600;
  const MAX_PAGES = 20;
  const RETRIES = 3;
  const RETRY_BASE_MS = 1000;
  const RETRY_AFTER_MAX_S = 60;
  const FETCH_TIMEOUT_MS = 20000;
  const PAUSE_MS = 10 * 60 * 1000; // after a bot check, nothing is fetched for this long
  const ANNOTATE_DEBOUNCE_MS = 120;
  const ANNOTATE_MAX_WAIT_MS = 500;
  const KNOWN_MAX = 2000;
  const RENDER_CHUNK = 50; // items per render; the next chunk loads on scroll
  const COMPARE_MAX = 6;
  const PAGE_MEMO_MAX = 12; // raw REA page results are large (~0.3-1MB parsed); keep a few
  const ROWS_PREFIX = `${TOOL_PREFIX}rows/`;
  const ROWS_VERSION = 12;
  // Row fields derived at runtime (marks, scores, distances, medians): not worth caching.
  const ROW_RUNTIME = ['starred', 'hidden', 'relisted', 'priceHistory', 'note', 'appStatus', 'appAt', 'agencyHidden', 'suburbHidden', 'firstSeen',
    'openedAt', 'reviewedAt', 'hideReason', 'cheaperBy', 'resurfaced', 'checks', 'isNew', 'prevPrice', 'priceDelta', 'prevAvail', 'availDir', 'featChange', 'sinceLast', 'score', 'scoreWhy',
    'km', 'placeKm', '_kmFor', 'median', 'vsMedian', 'medianScope']; // bump when toRow() shape changes
  const ROW_DATES = ['avail', 'nextInspect', 'listed'];
  const ROW_INFINITE = ['priceNum', 'ppb', 'upfront', 'bondNum']; // "unknown" numbers held as Infinity
  const ROWS_TTL_MS = 10 * 60 * 1000;
  const ROWS_KEEP = 2; // searches kept in sessionStorage
  const MARKS_KEY = `${TOOL_PREFIX}marks/v1`;
  const MARKS_MAX = 5000;
  const HOUR_MS = 36e5;
  const DAY_MS = 864e5;
  const MARKS_TTL_MS = 90 * DAY_MS; // unstarred, unhidden listings forgotten after 90 days unseen
  const PRICE_CHANGE_MS = 14 * DAY_MS; // "was $X" shown for two weeks after a change
  const NEW_MS = 48 * HOUR_MS; // a listing REA dates within 48h counts as new even without a baseline
  const ROWS_TEXT_MAX = 600;
  const SNAP_KEY = `${TOOL_PREFIX}snapshots/v1`;
  const SNAP_MAX = 3; // searches remembered across sessions (localStorage is shared with REA)
  const SNAP_VISIT_GAP_MS = HOUR_MS; // runs closer together than this count as one visit
  const SNAP_TEXT_MAX = 300; // per-field text cap in remembered rows (sessionStorage rows: ROWS_TEXT_MAX)
  const GONE_MAX = 200; // no-longer-listed rows kept per search
  const IMPORT_ROWS_MAX = 1000; // rows accepted per search from a backup
  const SEARCH_KEY_MAX = 2000; // longest search URL accepted from a backup
  const YEARLESS_ROLL_MS = 60 * DAY_MS; // "3 Jan" more than this far in the past means next year
  const YEARLESS_BACK_MS = 300 * DAY_MS; // and more than this far ahead means last year
  const INSPECT_GRACE_MS = HOUR_MS; // an inspection that started this recently is still shown
  const BACKUP_MAX_BYTES = 5e6;
  const INPUT_DEBOUNCE_MS = 200;
  const NAV_SETTLE_MS = 400; // wait for REA to render after client-side navigation
  const REVOKE_MS = 5000; // keep a download's object URL alive this long
  const NARROW_MQ = '(max-width: 480px)'; // phones: drawer is full-screen (keep in sync with the CSS)

  // ---------------------------------------------------------------- config

  // `building` narrows one search's results, so it is never stored (or carried to the next search).
  // Outcome of the last write of something you chose (shortlist/notes, settings, presets): the UI
  // warns while writes fail (browser storage full; REA's own code shares it) and clears on success.
  const writeState = {
    ok: true, listeners: new Set(),
    report(ok) { if (ok === this.ok) return; this.ok = ok; for (const f of this.listeners) f(ok); },
  };
  const loadCfg = () => {
    try { const { building, ...c } = sanitizeCfg(JSON.parse(localStorage.getItem(CFG_KEY))); return c; } catch { return {}; }
  };
  const saveCfg = (cfg) => {
    try { const { building, ...c } = cfg; localStorage.setItem(CFG_KEY, JSON.stringify(c)); writeState.report(true); } catch { writeState.report(false); }
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
      const slim = rows.map((r) => {
        const o = { ...r, text: r.text?.length > ROWS_TEXT_MAX ? r.text.slice(0, ROWS_TEXT_MAX) : r.text };
        for (const k of ROW_RUNTIME) delete o[k]; // rebuilt by decorate/score/distance after restore
        if (o.amen) o.amen = Object.fromEntries(Object.entries(o.amen).filter(([, v]) => v === 'yes' || v === 'no'));
        return o;
      });
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
  // A sparser source (eg a property page without agency or inspections) updates what it has
  // and keeps the rest of the stored summary.
  const mergeSummary = (old, next) => ({ ...(isObj(old) ? old : {}),
    ...Object.fromEntries(Object.entries(next).filter(([, v]) => v !== '' && v != null && !(Array.isArray(v) && !v.length))) });
  const summary = (r) => ({
    u: safeUrl(r.url), a: clip(r.address), p: clip(r.price, 80), v: clip(r.available, 80), i: safeUrl(r.img),
    t: clip(r.type, 40), b: scalar(r.beds), ba: scalar(r.baths), c: scalar(r.cars), su: clip(r.suburb, 80),
    in: cleanInspections(r.inspections), w: clip(r.watch, 80), ap: clip(r.applyVia, 30), le: clip(r.lease, 10), tk: clip(r.taken, 12), bp: r.byAppt ? 1 : 0,
    bo: clip(r.bond, 40), la: typeof r.lat === 'number' ? r.lat : null, ln: typeof r.lng === 'number' ? r.lng : null,
    am: AMENITIES.filter((a) => r.amen?.[a.id] === 'yes').map((a) => a.id), ag: clip(r.agency, 80),
  });
  // Summary fields a search result always carries in full (empty means none, not unknown).
  const SEARCH_COMPLETE = ['in', 'w', 'ap', 'le', 'am', 'tk', 'bp'];
  // The upcoming stored inspection missing from the fresh list (null if none went). A session
  // still listed by label only (no time) is not missing.
  const cancelledInspection = (old, next, t) => {
    const keep = new Set((next || []).flatMap((i) => [i.at, i.label]).filter((x) => x != null && x !== ''));
    return (Array.isArray(old) ? old : []).find((i) => typeof i?.at === 'number' && i.at > t && !keep.has(i.at) && !keep.has(i.label)) || null;
  };
  const CANCEL_SHOW_MS = 7 * DAY_MS;
  const APP_STATUSES = ['', 'to inspect', 'inspected', 'applied', 'approved', 'declined'];
  const CHECKLIST_DEFAULT = 'Damp or mould, Water pressure, Phone signal, Natural light, Noise, Storage';
  const checklistItems = (v) => [...new Set(String(v || CHECKLIST_DEFAULT).split(/[,\n]/).map((x) => clip(x.trim(), 30)).filter(Boolean))].slice(0, CHECK_MAX);
  const checkSummary = (r, items) => items.filter((k) => r.checks?.[k]).map((k) => `${r.checks[k] === 'y' ? '✓' : '✗'} ${k}`).join(', ');
  const HIDE_REASONS = ['too small', 'location', 'condition', 'price', 'other'];
  const FOLLOW_UP_DAYS = 5;
  // After an inspection you were down for: "Inspected?"; inspected a while ago but not applied: "Apply?".
  const ACTION_WINDOW_DAYS = 7, APPLY_NUDGE_DAYS = 2;
  const needsAction = (r, now = Date.now()) => {
    if (r.lastInspect && now - r.lastInspect < ACTION_WINDOW_DAYS * DAY_MS && (!r.appStatus || r.appStatus === 'to inspect') &&
      !(r.inspectAnswered >= r.lastInspect) && !(r.appAt >= r.lastInspect)) return 'inspected';
    if (r.appStatus === 'inspected' && r.appAt && now - r.appAt > APPLY_NUDGE_DAYS * DAY_MS) return 'apply';
    return '';
  }; // an application with no answer after this long gets a "follow up?" nudge
  const needsFollowUp = (r, now = Date.now()) => r.appStatus === 'applied' && !!r.appAt && now - r.appAt > FOLLOW_UP_DAYS * DAY_MS;
  // Your track record per agency across the shortlist: { applied, approved, declined } by agency name.
  const agencyRecord = (rows) => {
    const out = new Map();
    for (const r of rows) {
      if (!r.agency || !['applied', 'approved', 'declined'].includes(r.appStatus)) continue;
      const k = agencyKey(r.agency);
      const v = out.get(k) || { applied: 0, approved: 0, declined: 0 };
      v.applied++; if (r.appStatus !== 'applied') v[r.appStatus]++;
      out.set(k, v);
    }
    return out;
  };
  const recordText = (v) => (v ? `you: ${v.applied} applied${v.approved ? `, ${v.approved} approved` : ''}${v.declined ? `, ${v.declined} declined` : ''}` : '');
  const MARK_FIELDS = ['s', 'st', 'd', 'h', 'hr', 'ht', 'hp', 'as', 'ast', 'ck', 'rv']; // user choices a bulk action can change
  const BULK_STAR_MAX = 50; // "shortlist all shown" cap, so one click can't flood the shortlist
  const PRUNE_EVERY = 20;
  const keep = (e) => e.s || e.h || e.n || e.as;
  // Inspection checklist answers: { label: 'y' | 'n' }, labels clipped, at most CHECK_MAX of them.
  const CHECK_MAX = 12;
  const cleanChecks = (o) => (isObj(o) ? Object.fromEntries(Object.entries(o).filter(([k, v]) => k && (v === 'y' || v === 'n')).slice(0, CHECK_MAX).map(([k, v]) => [clip(k, 30), v])) : {});
  // Address identity for relist detection: needs a street number, ignores case/punctuation.
  // Needs a street number in the street part ("Address available on request, Bondi NSW 2026" has
  // only the postcode, so two such listings aren't the same place).
  const addressKey = (a) => {
    const street = String(a || '').split(',')[0];
    if (!/\d/.test(street) || /\brequest\b/i.test(a)) return '';
    const k = String(a).toLowerCase().replace(/[^a-z0-9/]+/g, ' ').replace(/\s+/g, ' ').trim();
    return k.length > 6 ? k : '';
  };
  const PRICE_HISTORY_MAX = 10;
  const RELIST_GAP_MS = HOUR_MS; // old listing unseen at least this long before a same-address one counts as a relist
  const agencyKey = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  // Stored summary <-> row-shaped fields (one mapping for import, shortlist and summary()).
  const fromSummary = (d) => ({
    url: d.u, address: d.a, price: d.p, available: d.v, img: d.i, type: d.t, beds: d.b, baths: d.ba, cars: d.c, suburb: d.su,
    inspections: cleanInspections(d.in), watch: typeof d.w === 'string' ? d.w : '', applyVia: typeof d.ap === 'string' ? d.ap : '', lease: typeof d.le === 'string' ? d.le : '', taken: TAKEN_LABELS[d.tk] ? d.tk : '', byAppt: d.bp === 1, bond: d.bo, lat: typeof d.la === 'number' ? d.la : null, lng: typeof d.ln === 'number' ? d.ln : null, agency: d.ag,
    amen: Array.isArray(d.am) ? Object.fromEntries(AMENITIES.map((a) => [a.id, d.am.includes(a.id) ? 'yes' : null])) : {},
  });
  // Feature signature: "<detector version>:<amenities yes bitmask>:<heads-up bitmask>" in base 36.
  const FEAT_V = 5; // bump when AMENITIES/WATCHOUTS detection changes, so old signatures aren't compared
  const featSig = (r) => {
    let a = 0, w = 0;
    AMENITIES.forEach((x, i) => { if (r.amen?.[x.id] === 'yes') a |= 1 << i; });
    const ws = String(r.watch || '').split(',');
    WATCHOUTS.forEach((x, i) => { if (ws.includes(x.id)) w |= 1 << i; });
    return `${FEAT_V}:${a.toString(36)}:${w.toString(36)}`;
  };
  const featDiff = (from, to) => {
    const [, a0, w0] = String(from).split(':').map((v, i) => (i ? parseInt(v, 36) || 0 : v));
    const [, a1, w1] = String(to).split(':').map((v, i) => (i ? parseInt(v, 36) || 0 : v));
    const out = [];
    AMENITIES.forEach((x, i) => { const b = 1 << i; if ((a1 & b) && !(a0 & b)) out.push(`now ${x.yes}`); else if ((a0 & b) && !(a1 & b)) out.push(`no longer ${x.yes}`); });
    WATCHOUTS.forEach((x, i) => { const b = 1 << i; if ((w1 & b) && !(w0 & b)) out.push(`${x.label.toLowerCase()} added`); else if ((w0 & b) && !(w1 & b)) out.push(`${x.label.toLowerCase()} removed`); });
    return out.join(', ');
  };
  const YEARLESS_SKIP_DAYS = 300; // a jump this far out from "now" is a yearless date rolling over
  const dayNum = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS; // local calendar day, DST-proof
  // h: 1 hidden, 0 explicitly shown (overrides an inherited hide), absent: inherit from a relisted-from listing.
  // When hidden, and at what weekly rent: a listing hidden for its price comes back if it drops.
  const stampHide = (e, t) => { if (e.h) { e.ht = t; if (typeof e.p === 'number') e.hp = e.p; else delete e.hp; } else { delete e.ht; delete e.hp; delete e.hr; } }; // unhiding drops the reason too
  // Hidden for its price and cheaper now: shown again, so "hide" means hide it again at this rent.
  const resurfacedEntry = (e) => !!e?.h && e.hr === 'price' && typeof e.hp === 'number' && typeof e.p === 'number' && e.p < e.hp;
  const hiddenOf = (e, was) => e?.h === 1 || (e?.h !== 0 && !!was?.h && !e?.s);
  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const marksStore = (storage, now = () => Date.now()) => {
    let data = null, raw = null, writes = 0, countMemo = null;
    const load = () => {
      if (data) return data;
      countMemo = null;
      try { raw = storage.getItem(MARKS_KEY); data = JSON.parse(raw); } catch { data = null; raw = null; }
      if (!isObj(data) || !isObj(data.m)) data = { c: now(), m: {} };
      // One bad entry (hand-edited, or a half-written sync) mustn't break every later write.
      for (const [id, e] of Object.entries(data.m)) if (!isObj(e)) delete data.m[id];
      if (data.ad != null && !isObj(data.ad)) delete data.ad;
      return data;
    };
    // Writes re-read storage first so another tab's changes aren't overwritten by this
    // tab's stale in-memory copy (last writer wins per call, not per page lifetime).
    // Unchanged storage string (no other tab wrote) means the parsed copy is still current.
    const fresh = () => {
      let cur = null;
      try { cur = storage.getItem(MARKS_KEY); } catch { /* blocked */ }
      if (data && raw != null && cur === raw) return data;
      data = null;
      return load();
    };
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
    // Pruning walks everything, so it runs every PRUNE_EVERY writes (or when over the cap).
    const save = () => {
      countMemo = null;
      try {
        if (writes++ % PRUNE_EVERY === 0 || Object.keys(data.m).length > MARKS_MAX) prune();
        const out = JSON.stringify(data);
        storage.setItem(MARKS_KEY, out);
        raw = out;
        writeState.report(true);
      } catch { raw = null; writeState.report(false); /* quota/blocked: re-read next time */ }
    };
    const SUM_NUM = ['b', 'ba', 'c', 'la', 'ln', 'bp'], SUM_KEEP = ['in', 'am']; // summary fields kept as numbers / as given
    const entry = (m, id) => m[id] || (m[id] = { f: now(), l: now() });
    const bag = (d, f) => (d[f] = isObj(d[f]) ? d[f] : {});
    const setAs = (e, status) => { if (status) { e.as = status; e.ast = now(); } else { delete e.as; delete e.ast; } };
    // Hidden agencies (ag) and suburbs (sb): name -> shown name, keyed case/space-insensitively.
    const NAMED = { ag: 80, sb: 60 };
    const toggleNamed = (f) => (raw) => {
      const name = clip(raw, NAMED[f]), k = agencyKey(name);
      if (!k) return false;
      const b = bag(fresh(), f);
      if (b[k]) delete b[k]; else b[k] = name;
      save();
      return !!b[k];
    };
    return {
      invalidate() { data = null; raw = null; },
      // `full`: rows from a complete crawl of a search. Only then is a missing listing evidence of
      // a relist; one page (annotate, boot, re-check) says nothing about the rest.
      observe(rows, { full = false, features = true } = {}) {
        const { m } = fresh();
        const t = now();
        const batch = new Set(rows.map((r) => r.id));
        const anyInspections = rows.some((r) => r.inspections?.length);
        for (const r of rows) {
          if (!r.id) continue;
          const e = m[r.id] || (m[r.id] = { f: t });
          e.l = t;
          delete e.x; // seen again, so not gone
          if (e.s) {
            const li = Math.max(e.li || 0, lastPast(e.d?.in, t)); // REA drops an inspection once it's over
            const next = summary(r);
            if (features) {
              // Search results are complete for these, so an empty value is news: a cancelled
              // inspection or a dropped clause leaves the shortlist too. (Property pages merge.)
              // A batch with no inspections at all may mean REA stopped sending them: keep what's stored.
              const fields = anyInspections ? SEARCH_COMPLETE : SEARCH_COMPLETE.filter((k) => k !== 'in');
              const gone = anyInspections ? cancelledInspection(e.d?.in, next.in, t) : null;
              if (gone) e.ic = [t, clip(gone.label, 80), gone.at];
              else if (Array.isArray(e.ic) && next.in.some((i) => i.at === e.ic[2] || i.label === e.ic[1])) delete e.ic; // it came back
              e.d = { ...mergeSummary(e.d, next), ...Object.fromEntries(fields.map((k) => [k, next[k]])) };
            } else e.d = mergeSummary(e.d, next); // keep the shortlist's copy current, never poorer
            if (li) e.li = li;
          }
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
          // Amenities / heads-up as a compact signature; a change ("now pets OK", "fee now mentioned")
          // is kept like a price change. Only compared between search results (features: false for
          // property pages, whose fuller text would read as changes), and only with the same detector.
          if (features && r.amen) {
            const sig = featSig(r);
            if (e.fs && e.fs !== sig && e.fs.startsWith(`${FEAT_V}:`)) { e.pfs = e.fs; e.fst = t; }
            e.fs = sig;
          }
          // Same address under a new id = relisted: remember which listing it replaces.
          const ak = addressKey(r.address);
          if (ak) {
            const d = data;
            bag(d, 'ad');
            const prev = d.ad[ak];
            // Only a relist if the old listing has stopped appearing: two live listings at one
            // address (units listed without a unit number) are different places.
            if (full && prev && prev !== r.id && m[prev] && !e.rl && !batch.has(prev) && t - (m[prev].l || 0) > RELIST_GAP_MS) e.rl = prev;
            if (e.rl && batch.has(e.rl)) delete e.rl; // the "old" listing is live again: two places, not a relist
            if (full || !prev || batch.has(prev) || !m[prev]) d.ad[ak] = r.id; // a partial view doesn't move the address on
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
          r.hidden = hiddenOf(e, was); // ruled out before: stays out when relisted, unless you unhid it
          r.relisted = was ? { price: was.ps || '', hidden: !!was.h } : null;
          r.priceHistory = Array.isArray(e?.ph) ? e.ph : [];
          r.note = e?.n || '';
          r.appStatus = e?.as || '';
          r.appAt = e?.as && e.ast ? e.ast : null;
          r.agencyHidden = !!(r.agency && ag?.[agencyKey(r.agency)]);
          r.suburbHidden = !!(r.suburb && sb?.[agencyKey(r.suburb)]);
          r.firstSeen = e?.f ? new Date(e.f) : null;
          r.openedAt = e?.o ? new Date(e.o) : null;
          r.reviewedAt = e?.rv ? new Date(e.rv) : null;
          r.hideReason = r.hidden && e?.hr ? e.hr : '';
          r.cheaperBy = r.hidden && typeof e?.hp === 'number' && typeof e.p === 'number' && e.p < e.hp ? e.hp - e.p : 0;
          r.resurfaced = resurfacedEntry(e); // hidden for its price, and it dropped
          r.checks = cleanChecks(e?.ck);
          // "New" is per search (see snapshotStore); here only REA's own listed date counts.
          r.isNew = r.listed instanceof Date && t - r.listed < NEW_MS;
          r.prevPrice = e && e.pp != null && e.pp !== e.p && e.pt && t - e.pt < PRICE_CHANGE_MS ? e.pps || `$${e.pp}` : '';
          r.priceDelta = r.prevPrice ? e.p - e.pp : 0;
          const availMoved = e && e.pav != null && e.avt && t - e.avt < PRICE_CHANGE_MS && e.pav !== e.av;
          r.prevAvail = availMoved ? (e.pav === 0 ? 'now' : dtf({ day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(e.pav * DAY_MS))) : '';
          r.availDir = availMoved ? e.avd || ((e.av || 0) > (e.pav || 0) ? 'later' : 'sooner') : '';
          r.featChange = e?.pfs && e.fs && e.fst && t - e.fst < PRICE_CHANGE_MS ? featDiff(e.pfs, e.fs) : '';
        }
        return rows;
      },
      // `row` lets a newly shortlisted listing carry its summary for the cross-search view.
      toggle(id, k, row) {
        const { m } = fresh();
        const e = entry(m, id);
        // Hide flips what you see, including a hide inherited from the listing this one relists.
        if (k === 'h' && resurfacedEntry(e)) stampHide(e, now()); // Hide again, from any button
        else if (k === 'h') { e.h = hiddenOf(e, e.rl ? m[e.rl] : null) ? 0 : 1; stampHide(e, now()); }
        else e[k] = e[k] ? 0 : 1;
        e.rv = now(); // deciding on it counts as having reviewed it
        if (k === 's') {
          if (e.s) { e.st = now(); delete e.ic; if (row) e.d = summary(row); } else { delete e.st; }
        }
        save();
        return !!e[k];
      },
      note: (id) => load().m[id]?.n || '',
      setStatus(id, status) {
        if (!APP_STATUSES.includes(status)) return;
        const { m } = fresh();
        const e = entry(m, id);
        setAs(e, status);
        save();
      },
      // Re-check outcome: gone (REA took it down) or seen again (clears gone).
      setGone(id, gone) {
        const { m } = fresh();
        const e = entry(m, id);
        if (gone) e.x = now(); else delete e.x;
        save();
      },
      // Cycle one checklist item: unknown -> yes -> no -> unknown.
      cycleCheck(id, label) {
        const { m } = fresh();
        const e = entry(m, id), k = clip(String(label || ''), 30);
        if (!k) return '';
        const ck = cleanChecks(e.ck), next = !ck[k] ? 'y' : ck[k] === 'y' ? 'n' : '';
        if (next) ck[k] = next; else delete ck[k];
        if (Object.keys(ck).length) e.ck = ck; else delete e.ck;
        save();
        return next;
      },
      // "Didn't go" on the after-inspection prompt: don't ask again for inspections up to now.
      answerInspect(id) { const { m } = fresh(); entry(m, id).nd = now(); save(); },
      // Still not interested at the new price: hidden again from here.
      rehide(id) { const { m } = fresh(); const e = entry(m, id); e.h = 1; stampHide(e, now()); save(); },
      setHideReason(id, reason) {
        const { m } = fresh();
        const e = entry(m, id);
        if (HIDE_REASONS.includes(reason)) e.hr = reason; else delete e.hr;
        save();
      },
      // You opened the listing (from the drawer, a card or its page): "opened 2d ago", Not-opened filter.
      setOpened(id) {
        if (!isListingId(id)) return;
        const { m } = fresh();
        entry(m, id).o = now();
        save();
      },
      setNote(id, text) {
        const { m } = fresh();
        const e = entry(m, id);
        const n = clip(String(text ?? '').trim(), NOTE_MAX);
        if (n) e.n = n; else delete e.n;
        e.rv = now();
        save();
      },
      // Triage progress that survives visits (unlike "new since last visit"): looked at and moved on.
      setReviewed(ids, on = true) {
        const { m } = fresh();
        let n = 0;
        for (const id of ids) { if (!isListingId(id)) continue; const e = entry(m, id); if (!!e.rv === on) continue; if (on) e.rv = now(); else delete e.rv; n++; }
        if (n) save();
        return n;
      },
      // Shortlisted listings from every search, newest-starred first, as drawer rows.
      shortlist() {
        const { m } = load();
        return Object.entries(m).filter(([, e]) => e.s && e.d?.u)
          .sort(([, a], [, b]) => (b.st || 0) - (a.st || 0))
          .map(([id, e]) => {
            // Hand-edited or half-written summaries: text fields must be strings, numbers stay numbers.
            const d = Object.fromEntries(Object.entries(e.d).map(([k, v]) => [k, SUM_KEEP.includes(k) ? v
              : SUM_NUM.includes(k) ? (typeof v === 'number' || typeof v === 'string' ? v : '') : typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '']));
            const priceNum = parsePrice(clip(d.p, 80));
            return {
              ...fromSummary(d), id, suburb: d.su || '', priceNum, available: d.v || '-', avail: parseAvail(d.v),
              beds: d.b ?? '', baths: d.ba ?? '', cars: d.c ?? '', bond: d.bo || '', ppb: perBed(priceNum, d.b),
              ...moveIn(d.bo, priceNum), agency: d.ag || '',
              starred: true, hidden: !!e.h, note: e.n || '', appStatus: e.as || '', appAt: e.as && e.ast ? e.ast : null, listed: null, lastSeen: e.l || null,
              gone: !!e.x, goneAt: e.x || null, checks: cleanChecks(e.ck),
              // The latest inspection that has already happened (the display list drops past ones).
              lastInspect: Math.max(typeof e.li === 'number' ? e.li : 0, lastPast(d.in, now())) || null,
              inspectAnswered: typeof e.nd === 'number' ? e.nd : 0,
              inspectCancelled: Array.isArray(e.ic) && now() - e.ic[0] < CANCEL_SHOW_MS ? clip(e.ic[1], 80) : '',
            };
          });
      },
      // Backup/restore of what the user chose (shortlist, hidden, notes); sighting history is not exported.
      exportData() {
        const { m } = load();
        const out = {};
        for (const [id, e] of Object.entries(m)) {
          if (keep(e)) out[id] = { x: e.x, s: e.s ? 1 : undefined, st: e.st, h: e.h ? 1 : undefined, n: e.n, as: e.as, ast: e.ast, hr: e.hr, ck: e.ck, o: e.o, nd: e.nd, li: e.li, ic: e.ic, ht: e.ht, hp: e.hp, rv: e.rv, d: e.s ? e.d : undefined };
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
          if (e.h) { cur.h = 1; if (HIDE_REASONS.includes(e.hr)) cur.hr = e.hr; }
          if (typeof e.x === 'number') cur.x = e.x;
          if (typeof e.n === 'string' && e.n.trim()) cur.n = clip(e.n.trim(), NOTE_MAX);
          if (APP_STATUSES.includes(e.as) && e.as) { cur.as = e.as; cur.ast = +e.ast || now(); }
          const ck = cleanChecks(e.ck); if (Object.keys(ck).length) cur.ck = ck;
          if (typeof e.o === 'number') cur.o = Math.max(cur.o || 0, e.o);
          for (const k of ['nd', 'li', 'rv']) if (typeof e[k] === 'number') cur[k] = Math.max(cur[k] || 0, e[k]);
          if (e.h && typeof e.ht === 'number') { cur.ht = e.ht; if (typeof e.hp === 'number') cur.hp = e.hp; }
          if (Array.isArray(e.ic) && typeof e.ic[0] === 'number' && typeof e.ic[1] === 'string') cur.ic = [e.ic[0], clip(e.ic[1], 80), typeof e.ic[2] === 'number' ? e.ic[2] : null];
          n++;
        }
        for (const f of Object.keys(NAMED)) {
          if (!isObj(src[f])) continue;
          const b = bag(load(), f);
          for (const raw of Object.values(src[f])) { const name = clip(raw, NAMED[f]); if (agencyKey(name)) b[agencyKey(name)] = name; } // keyed by the clipped name, as toggled
        }
        save();
        return n;
      },
      counts() {
        const { m } = load();
        if (countMemo) return countMemo;
        let starred = 0, hidden = 0, notes = 0;
        for (const e of Object.values(m)) { if (e.s) starred++; if (e.h) hidden++; if (e.n) notes++; }
        return (countMemo = { starred, hidden, notes });
      },
      // Hidden agencies live beside the per-listing marks: data.ag = { normalisedName: displayName }.
      toggleAgency: toggleNamed('ag'),
      hiddenAgencies: () => Object.values(load().ag || {}),
      toggleSuburb: toggleNamed('sb'),
      hiddenSuburbs: () => Object.values(load().sb || {}),
      // Bulk: set s (shortlist) or h (hidden) explicitly on many rows in one write.
      setMany(rows, k, on) {
        const { m } = fresh();
        let n = 0;
        for (const r of rows) {
          if (!r.id) continue;
          const e = entry(m, r.id);
          if (!!e[k] === on && !(k === 'h' && on && resurfacedEntry(e))) continue;
          e[k] = on ? 1 : 0;
          if (k === 's') { if (on) { e.st = now(); e.d = summary(r); } else delete e.st; }
          if (k === 'h') stampHide(e, now());
          n++;
        }
        save();
        return n;
      },
      setStatusMany(ids, status) {
        if (!APP_STATUSES.includes(status)) return 0;
        const { m } = fresh();
        for (const id of ids) setAs(entry(m, id), status);
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
    'cars', 'type', 'img', 'surrounding', 'agency', 'lat', 'lng', 'photos', 'floorplan', 'watch', 'applyVia', 'lease', 'availFromText', 'taken', 'byAppt', 'sqm', 'sqmFromText']; // inspect/nextInspect: re-derived on load
  const slimRow = (r) => {
    const o = {};
    for (const k of SNAP_FIELDS) o[k] = typeof r[k] === 'string' ? clip(r[k], SNAP_TEXT_MAX) : r[k];
    for (const k of ROW_DATES) if (k !== 'nextInspect') o[k] = r[k] instanceof Date && !isNaN(r[k]) ? r[k].getTime() : null;
    o.headline = clip(r.headline, 160);
    o.text = clip(r.text, SNAP_TEXT_MAX);
    o.inspections = cleanInspections(r.inspections);
    o.features = (Array.isArray(r.features) ? r.features : []).slice(0, 40).map((f) => clip(f, 80));
    // Stored as computed: the text kept here is clipped, so recomputing could miss a late "no pets".
    // Only known answers are kept (most are unknown): about a fifth of a remembered search's size.
    o.amen = Object.fromEntries(AMENITIES.map((a) => [a.id, r.amen?.[a.id]]).filter(([, v]) => v === 'yes' || v === 'no'));
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
    r.text = fold(clip(o?.text, SNAP_TEXT_MAX));
    r.inspections = cleanInspections(o?.inspections).filter((i) => i.label);
    if (typeof o?.taken !== 'string') r.taken = takenOf(r.headline, r.text); // saved before this was detected
    if (typeof o?.watch !== 'string') r.watch = watchOf([r.headline, r.text, ...(Array.isArray(o?.features) ? o.features : [])].join(' ')).join(','); // saved before heads-up existed
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
    r.sqm = typeof o?.sqm === 'number' ? sqmOk(o.sqm) : o && 'sqm' in o ? null : sqmFromText([r.headline, r.text].join(' . ')); // saved before sizes were read
    r.sqmFromText = r.sqm != null && (typeof o?.sqmFromText === 'boolean' ? o.sqmFromText : !(o && 'sqm' in o));
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
  // One string value in a storage area; blocked or full storage just means no value.
  const keyStore = (storage, key) => ({
    get() { try { return storage.getItem(key); } catch { return null; } },
    set(v) { try { storage.setItem(key, v); } catch { /* quota/blocked */ } },
    clear() { try { storage.removeItem(key); } catch { /* blocked */ } },
  });
  const toolKeys = (storage) => {
    const out = [];
    try { for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k && k.startsWith(TOOL_PREFIX)) out.push(k); } } catch { /* blocked */ }
    return out;
  };
  const toolBytes = (storage) => toolKeys(storage).reduce((n, k) => { try { return n + 2 * (k.length + (storage.getItem(k) || '').length); } catch { return n; } }, 0);
  const fmtBytes = (b) => (b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${Math.round(b / 1024)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);

  const snapshotStore = (storage, now = () => Date.now()) => {
    // Parsed copy reused while the stored string is unchanged (several reads per navigation).
    let memo = null, memoRaw = null;
    const load = () => {
      let raw = null;
      try { raw = storage.getItem(SNAP_KEY); } catch { /* blocked */ }
      if (memo && raw != null && raw === memoRaw) return memo;
      memo = parse(raw); memoRaw = raw;
      return memo;
    };
    const parse = (raw) => {
      try {
        const d = JSON.parse(raw);
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
    // SNAP_MAX kept, pinned first then newest; on quota, drop older searches, then the gone
    // lists, then give up. Returns the keys it stopped remembering.
    const persist = (d) => {
      const order = () => Object.keys(d.s).sort((a, b) => (d.s[b].pin ? 1 : 0) - (d.s[a].pin ? 1 : 0) || d.s[b].at - d.s[a].at);
      const evicted = order().slice(SNAP_MAX);
      for (const k of evicted) delete d.s[k];
      for (let attempt = 0; attempt < 3; attempt++) {
        try { const out = JSON.stringify(d); storage.setItem(SNAP_KEY, out); memo = d; memoRaw = out; return { evicted, ok: true }; } catch {
          memo = null;
          const ks = order(); // pinned first here too, and whatever goes is reported
          if (attempt === 0 && ks.length > 1) for (const k of ks.slice(1)) { delete d.s[k]; evicted.push(k); }
          else for (const k of ks) d.s[k].gone = [];
        }
      }
      return { evicted, ok: false };
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
        const entry = d.s[key] = { at: t, baseAt, baseIds, ids, truncated: !!truncated, rows: rows.map(slimRow), gone: gone.slice(0, GONE_MAX), ...(prev?.pin ? { pin: 1 } : {}) };
        const { evicted } = persist(d);
        // `refused`: every slot is pinned, so this search wasn't kept (its diff still applies to this run).
        return { ...view(entry), evicted: evicted.filter((k) => k !== key), refused: evicted.includes(key) };
      },
      // Pinned searches are the last to be forgotten when a new one is remembered.
      pin(key, on) {
        const d = load();
        if (!d.s[key]) return false;
        if (on) d.s[key].pin = 1; else delete d.s[key].pin;
        return persist(d).ok;
      },
      clear() { memo = null; try { storage.removeItem(SNAP_KEY); } catch { /* blocked */ } },
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
            ...(e.pin ? { pin: 1 } : {}),
          };
          n++;
        }
        persist(d);
        return n;
      },
    };
  };

  // Named filter presets; a preset with `key` auto-applies on that search.
  const PRESETS_KEY = `${TOOL_PREFIX}presets/v1`;
  const PRESETS_MAX = 30;
  const presetStore = (storage) => {
    const load = () => {
      try {
        const d = JSON.parse(storage.getItem(PRESETS_KEY));
        if (Array.isArray(d?.list)) { d.list = d.list.filter((p) => isObj(p) && typeof p.name === 'string' && p.name && isObj(p.cfg)); return d; }
      } catch { /* corrupt */ }
      return { v: 1, list: [] };
    };
    const save = (d) => { try { storage.setItem(PRESETS_KEY, JSON.stringify(d)); writeState.report(true); } catch { writeState.report(false); } };
    const pick = (cfg) => Object.fromEntries(PRESET_KEYS.filter((k) => k in cfg).map((k) => [k, cfg[k]]));
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

  const safeUrl = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) && !/[\s\u0000-\u001f"<>]/.test(u) ? u : ''); // no CR/LF smuggling into ICS/CSV

  // ------------------------------------------------------------ extraction

  const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

  // "Available now" -> today, so it survives a from-date of today or earlier
  // and is correctly excluded by a future from-date.
  // Parsed by hand: Date() on "Mon 12th Oct" is engine-specific and, lacking a year,
  // Chrome yields 2001. A year-less date more than ~2 months past rolls to next year.
  // A date already past means "available now", so it is clamped to today and treated alike.
  // A day and month with no year: this year, next if it's well past, last if it's far ahead.
  const yearless = (day, month, today, clamp) => {
    if (month < 0 || month > 11) return null;
    let year = today.getFullYear(), d = new Date(year, month, day);
    if (today - d > YEARLESS_ROLL_MS) d = new Date(++year, month, day);
    else if (d - today > YEARLESS_BACK_MS) d = new Date(--year, month, day); // "20 Dec" read on 5 Jan: last month
    return d.getDate() !== day ? null : clamp(d); // 31 Feb, 29 Feb in a non-leap year
  };
  const parseAvail = (display, now = new Date()) => {
    if (!display) return null;
    const today = startOfDay(now);
    const clamp = (d) => (d < today ? today : d);
    if (/\b(?:now|immediately|immediate|vacant)\b/i.test(display)) return today;
    const iso = display.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    if (iso) {
      const d = new Date(+iso[1], +iso[2] - 1, +iso[3]);
      return d.getDate() !== +iso[3] || d.getMonth() !== +iso[2] - 1 ? null : clamp(d);
    }
    // "early December", "mid Nov", "end of October": the 1st, 15th or 25th of that month.
    const part = display.match(/\b(early|beginning of|start of|mid|middle of|late|end of)[\s-]+([a-z]{3,})\.?\b(?:\s+(\d{4}))?/i);
    const pm = part ? MONTH_NAMES.findIndex((n) => n.startsWith(part[2].toLowerCase())) : -1;
    if (pm >= 0) {
      const day = /^(?:mid|middle)/i.test(part[1]) ? 15 : /^(?:late|end)/i.test(part[1]) ? 25 : 1;
      return part[3] ? clamp(new Date(+part[3], pm, day)) : yearless(day, pm, today, clamp);
    }
    // AU numeric order: dd/mm/yyyy, dd-mm-yy
    const num = display.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})\b/);
    if (num) {
      const d = new Date(+num[3] < 100 ? 2000 + +num[3] : +num[3], +num[2] - 1, +num[1]);
      return isNaN(d) || d.getDate() !== +num[1] || d.getMonth() !== +num[2] - 1 ? null : clamp(d); // 31/13 is not 31 Jan
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
      if (!yr) return yearless(+day, month, today, clamp);
      const d = new Date(+yr, month, +day);
      return d.getDate() !== +day ? null : clamp(d); // 31 Feb, 29 Feb in a non-leap year
    }
    // Last resort, yearless "1/11" (d/m) and only at the start: slash only ("6-12" is a lease,
    // "1.5" a bathroom count), not "x/7" (a schedule), and not "2/3 bed", "1/2 price", "12/7 days".
    const dm = display.match(/^\W*(?:available\s*)?(?:from\s+|on\s+|date:?\s*)?(\d{1,2})\/(\d{1,2})\b(?![/.-]?\d)(?!\s*(?:days?|price|bed|bath|car|br|off)\b)/i);
    if (dm && dm[2] !== '7') return yearless(+dm[1], +dm[2] - 1, today, clamp);
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
    // "$800 pw / $3,466 pcm" and "$600 per week (a month free)" stay weekly. A range
    // ("$2,600 - $2,800 per month") takes the period after its second figure.
    const parts = s.slice(m.index + m[0].length).split('$');
    const tail = /^\s*(?:-|–|—|to)\s*$/i.test(parts[0]) && parts.length > 1 ? parts[1] : parts[0];
    const weekly = /\b(pw|p\/w|per\s*week|weekly|a\s*week)\b|\/\s*w(ee)?k\b/i.test(tail);
    if (!weekly) {
      if (/\b(per\s*(?:calendar\s*)?month|p\.?\s*c\.?\s*m|pcm|pm|p\/m|monthly|a\s*month)\b|\/\s*m(on)?(th)?\b/i.test(tail)) v = (v * 12) / 52;
      else if (/\b(per\s*(annum|year)|p\.?\s*a\.?|pa|annually|a\s*year)\b|\/\s*y(ea)?r\b/i.test(tail)) v /= 52;
      else if (/\b(per\s*fortnight|p\.?\s*f\.?|pf|fortnightly|a\s*fortnight)\b|\/\s*f(ort)?n(igh)?t\b/i.test(tail)) v /= 2;
      else if (/\b(per\s*night|p\.?\s*n\.?|pn|nightly|a\s*night)\b|\/\s*n(igh)?t\b/i.test(tail)) v *= 7; // short stays
    }
    return Math.round(v);
  };

  // REA's SSR payload: ArgonautExchange -> app key -> urqlClientCache (JSON string)
  // -> entries whose `data` is (usually) a further JSON string.
  // Known path first: app key -> urqlClientCache -> entry.data.rentSearch.results. If REA renames
  // the app key or the query field, any app with a urql cache is tried and any data field whose
  // value looks like search results (exact.items + pagination) is taken. `resultsPath` says which.
  const APP_KEY = 'resi-property_listing-experience-web';
  const looksLikeResults = (v) => isObj(v) && Array.isArray(v.exact?.items) && isObj(v.pagination);
  const resultsPath = { key: '', field: '', fallback: false };
  function parseExchange(exchange) {
    const apps = [APP_KEY, ...Object.keys(isObj(exchange) ? exchange : {}).filter((k) => k !== APP_KEY)].filter((k) => exchange?.[k]?.urqlClientCache);
    if (!apps.length) throw new Error('Listing cache missing from page markup.');
    for (const pass of ['known', 'shape']) {
      for (const app of apps) {
        const raw = exchange[app].urqlClientCache;
        let cache;
        try { cache = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { continue; }
        for (const entry of Object.values(isObj(cache) ? cache : {})) {
          let data;
          try { data = typeof entry?.data === 'string' ? JSON.parse(entry.data) : entry?.data; } catch { continue; }
          if (!isObj(data)) continue;
          if (pass === 'known' && app === APP_KEY && data.rentSearch?.results) { Object.assign(resultsPath, { key: app, field: 'rentSearch', fallback: false }); return data.rentSearch.results; }
          if (pass === 'shape') {
            const field = Object.keys(data).find((f) => looksLikeResults(data[f]?.results));
            if (field) { Object.assign(resultsPath, { key: app, field, fallback: app !== APP_KEY || field !== 'rentSearch' }); return data[field].results; }
          }
        }
      }
    }
    throw new Error('No rentSearch results found in cache.');
  }

  // A refusal that looks like REA's bot protection: the caller pauses all fetching (pauseGate).
  const botCheck = (msg) => Object.assign(new Error(msg), { botCheck: true });
  // sessionStorage `paused` = when fetching may resume. Per tab, so a new tab can try again.
  const pauseGate = (storage, now = () => Date.now()) => {
    const k = keyStore(storage, `${TOOL_PREFIX}paused`);
    const until = () => { const t = +k.get() || 0; return t > now() ? t : 0; };
    return { until, trip(ms = PAUSE_MS) { const t = now() + ms; k.set(String(t)); return t; }, clear: () => k.clear() };
  };

  function extractResults(html) {
    const m = html.match(EXCHANGE_RE);
    if (!m) throw botCheck('Hydration blob missing - probably a bot-check interstitial. Reload the page and retry.');
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

  // Intl formatters are costly to build (~0.1 ms each); toLocale*(…, opts) builds one per call.
  const fmts = new Map();
  const dtf = (opts) => { const k = JSON.stringify(opts); let f = fmts.get(k); if (!f) fmts.set(k, (f = new Intl.DateTimeFormat('en-AU', opts))); return f; };
  const DT_FMT = { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' };
  // In the listing's zone when known: a Perth open home reads 10:00am from Sydney too.
  const fmtWhen = (d, tz) => dtf(tz ? { ...DT_FMT, timeZone: tz } : DT_FMT).format(d).replace(/\s?(am|pm)/i, (m) => m.trim().toLowerCase());

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

  function extractInspections(listing, now = new Date(), tz = null) {
    let src = listing.inspections ?? listing.inspectionTimes ?? listing.openHomes ?? listing.inspectionsAndAuctions?.inspections;
    // A discovered list must look like times, not eg "Book an inspection" options.
    if (!inspectionList(src)) src = find('inspections', listing, /inspection|openhome|open_home/i,
      (v) => !!inspectionList(v)?.some((it) => startOf(it)));
    const list = inspectionList(src) || [];
    const cutoff = now.getTime() - INSPECT_GRACE_MS;
    return list
      .map((it) => {
        const at = startOf(it);
        const label = str(it?.display?.shortLabel) || str(it?.display?.longLabel) || str(it?.display) || str(it?.label) || (at ? fmtWhen(at, tz) : '');
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

  // Internal floor area in m²: REA's field when there is one, else the listing text. Land,
  // balcony, courtyard, garage and similar areas are skipped, so "85sqm internal + 12sqm
  // balcony" is 85 and "on a 600sqm block" is nothing.
  const SQM_MIN = 15, SQM_MAX = 2000;
  const sqmOk = (n) => (Number.isFinite(n) && n >= SQM_MIN && n <= SQM_MAX ? Math.round(n) : null);
  const extractSqm = (listing) => {
    const s = listing.propertySizes || listing.propertySize || {};
    for (const v of [s.building, s.internal, s.floor, s.floorArea, listing.buildingSize, listing.floorArea, listing.floorSize, listing.internalArea]) {
      if (v == null) continue;
      const unit = String(v?.sizeUnit?.displayValue ?? v?.sizeUnit?.id ?? v?.unit ?? (typeof v === 'string' ? v : 'm2')).toLowerCase();
      if (!/m2|m²|sqm|sq\s*m|square met/.test(unit)) continue; // hectares, acres, ft² are not converted
      const n = sqmOk(parseFloat(String(v?.displayValue ?? v?.value ?? v).replace(/,/g, '')));
      if (n != null) return n;
    }
    return null;
  };
  const SQM_RE = /(\d{2,4}(?:\.\d+)?)\s*(?:sq\.?\s*m(?:etres?|eters?)?(?![a-z])|m2(?![a-z\d])|m²|square\s*met(?:re|er)s?)/gi;
  const SQM_NOT = /\b(?:land|block|lot|site|balcon(?:y|ies)|courtyard|terrace|garden|yard|backyard|garage|carport|deck|patio|outdoor|alfresco|rooftop|storage|storeroom|shed|pool)\b/;
  const SQM_SPLIT = /[,.;+&()]|\band\b|\bplus\b|\bwith\b/;
  const sqmFromText = (text) => {
    const t = String(text || '');
    for (const m of t.matchAll(SQM_RE)) {
      const n = sqmOk(+m[1]);
      if (n == null) continue;
      // The words right next to the number say what was measured: "12sqm balcony", "balcony 12sqm", "600sqm block".
      const after = t.slice(m.index + m[0].length, m.index + m[0].length + 30).toLowerCase().split(SQM_SPLIT)[0];
      const before = t.slice(Math.max(0, m.index - 30), m.index).toLowerCase().split(SQM_SPLIT).pop();
      if (!SQM_NOT.test(after) && !SQM_NOT.test(before)) return n;
    }
    return null;
  };
  const perSqm = (r) => (Number.isFinite(r.priceNum) && r.sqm > 0 ? Math.round((r.priceNum / r.sqm) * 100) / 100 : null);
  const sqmLabel = (r) => (r.sqm ? `${r.sqm} m²${r.sqmFromText ? ' (from text)' : ''}` : '');

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
    // gate: every pool pattern contains the word, so the costly lookbehind is skipped when it's absent.
    { id: 'pool', label: 'Pool', yes: 'Pool', gate: 'pool', neg: /\bno (?:swimming |lap |plunge )?pool\b/,
      // The lookahead first: the costly lookbehind then only runs where a pool actually starts.
      pos: /\b(?=(?:swimming |lap |plunge )?pool\b)(?<!(?:car|walk to [\w' ]{0,30}|near(?:by)? [\w' ]{0,20}|close to [\w' ]{0,30}) )(?:swimming |lap |plunge )?pool\b(?! tables?|side)/ },
    { id: 'study', label: 'Study', yes: 'Study', neg: /\bno (?:study|home office)\b/,
      pos: /\b(?<!\b(?:to|and|or|while you|students who) )(?:study(?: room| nook| area)?|home office)\b(?! (?:at|nearby|precinct|centre))/ },
    { id: 'ensuite', label: 'Ensuite', yes: 'Ensuite', neg: /\bno en[- ]?suite\b/, pos: /\ben[- ]?suited?\b/ },
    { id: 'heating', label: 'Heating', yes: 'Heating', neg: /\bno heat(?:ing|er)\b/,
      pos: /\b(?<!water )(?:ducted |gas |hydronic |underfloor |floor |split[- ]system |panel )?heat(?:ing|ers?)\b(?! (?:bill|costs?))|\b(?:open |gas |wood )?fireplace\b|\breverse[- ]cycle\b/ },
    { id: 'gas', label: 'Gas cooking', yes: 'Gas cooking', neg: /\bno gas\b|\belectric (?:cooking|cooktop|stove) only\b/,
      pos: /\bgas (?:cooking|cook ?top|stove|hob|oven|burners?|kitchen|appliances)\b/ },
    { id: 'lift', label: 'Lift', yes: 'Lift', neg: /\bno (?:lift|elevator)\b|\bwalk[- ]up\b|\bstairs only\b/,
      pos: /\blift (?:access|in (?:the )?building|to all (?:levels|floors)|serviced)\b|\blift[- ]serviced\b|\belevators?\b/ },
    { id: 'parking', label: 'Secure parking', yes: 'Secure parking', neg: /\bno (?:off[- ]street |secure )?parking\b|\bstreet parking only\b/,
      pos: /\bsecure(?:d)? (?:car ?park(?:ing|s)?|parking|garage|basement(?: parking)?|car ?space)\b|\b(?:remote|lock)[- ]up garage\b|\bremote[- ]controlled? garage\b|\bsecurity (?:car ?park|parking|garage)\b/ },
    // Appended only (featSig bit order). Energy bills, working from home, access.
    { id: 'solar', label: 'Solar', yes: 'Solar', neg: /\bno solar\b/,
      pos: /\bsolar[- ](?:panels?|power(?:ed)?|system|pv|electricity|energy|hot water|array)\b/ },
    { id: 'fibre', label: 'NBN fibre', yes: 'NBN fibre', neg: /\bno nbn\b|\bnbn (?:is )?not (?:yet )?(?:available|connected)\b/,
      pos: /\bfttp\b|\bfttb\b|\bfib(?:re|er) to the (?:premises|home|building)\b|\b(?:nbn )?fib(?:re|er) (?:nbn|internet|broadband|connection)\b|\bnbn fib(?:re|er)\b/ },
    { id: 'ev', label: 'EV charging', yes: 'EV charging', neg: /\bno ev charg/,
      pos: /\bev[- ]charg(?:er|ers|ing)\b|\belectric (?:vehicle|car) charg(?:er|ers|ing)\b|\bcar charging (?:point|station|bay)s?\b/ },
    { id: 'stepfree', label: 'Step-free', yes: 'Step-free', neg: /\bwalk[- ]up\b|\bstairs only\b|\bno lift\b|\bsplit[- ]level\b/,
      pos: /\bstep[- ]free\b|\bwheelchair (?:access(?:ible)?|friendly)\b|\blevel (?:entry|access)\b|\bno (?:stairs|steps)\b|\bsingle[- ](?:level|storey)\b/ },
    // Where tenants can only be charged for water if the home is water efficient (eg NSW, VIC).
    { id: 'watereff', label: 'Water efficient', yes: 'Water efficient', neg: /\b(?:not|non)[- ]water[- ]efficien|\b(?:does not|doesn't|do not|don't|fails? to|is not|isn't) (?:meet|comply with|compliant with|in compliance with)[^.]{0,30}water[- ]efficien|\bnot (?:compliant|in compliance) with[^.]{0,20}water[- ]efficien/,
      pos: /\bwater[- ]efficien(?:t|cy)(?: (?:compliant|standards|certified|devices|fixtures))?\b|\b(?:[3-6]|three|four|five|six)[- ]star (?:wels|water)\b|\bwater[- ]saving (?:fixtures|devices|shower ?heads?|taps)\b/ },
  ];
  // "X: No" per amenity, built once.
  for (const a of AMENITIES) a.kvNo = new RegExp(`(?:${a.pos.source})${AMEN_NO}`);
  const KV_NO_GATE = /[:?\-]\s*n/;
  // Only what the listing says about itself (features, headline, description), never the
  // address or property type ("North Terrace", type "Terrace" are not outdoor space).
  const amenitiesOf = (row) => {
    const text = `${(row.features || []).join(' | ')} | ${row.amenText ?? row.text ?? ''}`.toLowerCase();
    const kv = KV_NO_GATE.test(text); // every kvNo needs this, and most listings have none
    return Object.fromEntries(AMENITIES.map((a) => [a.id, a.gate && !text.includes(a.gate) ? null
      : a.neg.test(text) ? 'no' : !a.pos.test(text) ? null : kv && a.kvNo.test(text) ? 'no' : 'yes'])); // kvNo only matches where pos does
  };
  // cfg.amenities is "pets:yes,furnished:no": require / exclude per amenity.
  const parseAmenCfg = (v) => Object.fromEntries(String(v || '').split(',').map((p) => p.split(':'))
    .filter(([id, st]) => AMENITIES.some((a) => a.id === id) && (st === 'yes' || st === 'no')));
  const amenCfgString = (o) => Object.entries(o).map(([id, st]) => `${id}:${st}`).join(',');
  // Finer detail read from the text for a few amenities, shown in the tag ("Pets on application",
  // "Heating: ducted"). Shortlisted rows from other searches have no text, so they keep the plain tag.
  const PETS_ASK = /\bpets? (?:(?:are |will be )?considered|negotiable|(?:on|by|upon|subject to) (?:application|approval|request))\b/;
  const PETS_WELCOME = /\bpets? (?:are )?(?:welcome|allowed|permitted|ok|okay|accepted)\b|\bpet[- ]friendly\b/;
  const HEAT_TYPES = [['ducted', /\bducted (?:gas )?heat/], ['split system', /\bsplit[- ]system|\breverse[- ]cycle/], ['hydronic', /\bhydronic/],
    ['underfloor', /\b(?:underfloor|in[- ]floor) heat/], ['gas', /\bgas (?:space |wall )?heat/], ['fireplace', /\bfireplace\b|\bwood (?:fire|heater)/]];
  const amenDetail = (id, text) => {
    const t = String(text || '');
    if (!t) return '';
    if (id === 'pets') return PETS_ASK.test(t) ? 'Pets on application' : PETS_WELCOME.test(t) ? 'Pets welcome' : '';
    if (id === 'heating') { const kinds = HEAT_TYPES.filter(([, re]) => re.test(t)).map(([k]) => k).slice(0, 2); return kinds.length ? `Heating: ${kinds.join(', ')}` : ''; }
    return '';
  };
  const amenityTags = (r) => AMENITIES.filter((a) => r.amen?.[a.id] === 'yes').map((a) => amenDetail(a.id, r.text) || a.yes);

  // Heads-up: terms in the listing text worth asking the agent about. Plain text matches, so a
  // tag means "mentioned", never a verdict ("no application fee" is not flagged).
  const WATCHOUTS = [
    { id: 'short', label: 'Short lease', re: /\b(?:3|6|three|six)\s*(?:months?|mths?)\b[^.;]{0,20}?\b(?:lease|tenancy|term)\b|\b(?:3|6)\s*(?:-|to|or)\s*12\s*months?|\bshort[- ]term (?:lease|rental|tenancy|stay)|\blease term:?\s*(?:3|6)\s*months?/ },
    { id: 'water', label: 'Water usage charged', re: /\bwater (?:usage|consumption)\b[^;]{0,50}?\b(?:charged|charges apply|payable|paid by (?:the )?tenants?|billed|invoiced|extra|additional|on top|at (?:the )?tenants?'?s? (?:cost|expense))|\btenants? (?:pays?|to pay|responsible for) (?:all |the )?water/ },
    { id: 'fee', label: 'Fee mentioned', re: /\b(?:application|holding|admin(?:istration)?|reservation) fees?\b/ },
    { id: 'bid', label: 'Invites higher offers', re: /\b(?:offers?|bids?) (?:above|over|in excess of)\b|\bhighest offer|\bbest offer/ },
    { id: 'strata', label: 'Subject to strata approval', re: /\bsubject to (?:strata|body corporate|owners? corporation)\b[^.;]{0,25}?\bapproval/ },
    { id: 'break', label: 'Lease-break terms', re: /\bbreak(?:[- ]lease)?[- ]fees?\b|\blease[- ]break (?:fee|cost|clause)|\bbreaking (?:the|your) lease (?:incurs|costs|will)/ },
    // Appended only: signatures are bitmasks by position (featSig).
    { id: 'clean', label: 'Professional clean required', re: /\b(?:professional(?:ly)?|carpets?|steam)(?: end[- ]of[- ]lease| bond)? clean(?:ing)?\b[^.;]{0,30}?\b(?:required|must be|on vacating|upon vacating|at (?:the )?end of)|\bmust be (?:professionally|steam) cleaned\b|\bprofessionally cleaned (?:on|upon|when) vacating\b/ },
    // Charges for paying the rent itself, not application or bond paperwork.
    { id: 'payfee', label: 'Rent payment fee', re: /(?<!\b(?:application|bond|lodgement|holding|admin)\s(?:and\s)?)\b(?:rent )?(?:payment|processing|transaction|convenience) fees?\b/ },
    { id: 'garden', label: 'You maintain garden/pool', re: /\btenants? (?:is |are |will be )?(?:responsible for|to maintain|must maintain|maintains?) (?:the |all )?(?:gardens?|lawns?|yard|pool)\b/ },
  ];
  // A mention right next to a negation ("no application fee", "water usage not charged", "rent
  // bidding is prohibited", "fee: nil") is the good news, not a heads-up. Checked per clause.
  const WATCH_NEG = /\b(?:no|not|nil|zero|none|never|without|free|waived|prohibited|n\/a)\b|n't\b|\$0(?![.\d]*[1-9])|paid by (?:the )?(?:owner|landlord|lessor)|fee-free/;
  const WATCH_BEFORE = 22, WATCH_AFTER = 14;
  for (const w of WATCHOUTS) w.reG = new RegExp(w.re.source, 'g'); // compiled once; lastIndex reset per use
  const watchOf = (text) => {
    const lower = String(text || '').toLowerCase();
    let clauses = null; // split only once some pattern hits: most listings mention none
    return WATCHOUTS.filter((w) => w.re.test(lower) && (clauses ??= lower.split(/(?<=[.!?;])\s+|\n+/)).some((c) => { // whole-text test first: most listings mention none
      const re = w.reG;
      re.lastIndex = 0;
      for (let m; (m = re.exec(c));) {
        if (!WATCH_NEG.test(c.slice(Math.max(0, m.index - WATCH_BEFORE), m.index + m[0].length + WATCH_AFTER))) return true;
        if (!m[0]) re.lastIndex++;
      }
      return false;
    })).map((w) => w.id);
  };
  // Availability from the description when REA's field is missing: "Available from 1st Nov",
  // "available now", "Availability: 12/11/2026". Not "available for inspection", "available to view".
  const AVAIL_TEXT = /\bavailab(?:le|ility)\b\s*(?:(?:from|on|date)\b\s*)?:?\s*(?!for\b|to\b|by\b|upon\b|with\b|in\b|at\b|until\b|soon\b|as\b|if\b|and\b|or\b|the\b)((?:now|immediately)\b|[^.;,\n()]{3,32})/i;
  // Something else being available (an inspection, the agent, parking) isn't the move-in date.
  const AVAIL_NOT_HOME = /\b(?:inspections?|agents?|viewings?|appointments?|parking|car ?spaces?|garages?|storage|lock-?up|keys?|furniture|nbn|internet)\s*(?:is|are)?\s*$/i;
  const AVAIL_TEXT_G = new RegExp(AVAIL_TEXT.source, 'gi');
  const availFromText = (text, now = new Date()) => {
    const src = String(text || '');
    AVAIL_TEXT_G.lastIndex = 0;
    for (let m; (m = AVAIL_TEXT_G.exec(src));) {
      if (AVAIL_NOT_HOME.test(src.slice(Math.max(0, m.index - 24), m.index))) continue;
      const d = /^(now|immediately)$/i.test(m[1].trim()) ? startOfDay(now) : parseAvail(`Available ${m[1]}`, now);
      if (d) return d;
    }
    return null;
  };

  // How the agent takes applications, when the text names a portal (display only, never contacted).
  const APPLY_VIA = [
    ['2Apply', /\b2apply\b/],
    ['Snug', /\bsnug\.com\b|\b(?:apply|application)s?\b[^.;]{0,24}\b(?:via|through|on|with|using)\s+snug\b/],
    ['Ignite', /\bignite\.com\b|\b(?:apply|application)s?\b[^.;]{0,24}\b(?:via|through|on|with|using)\s+(?:rea\s+)?ignite\b/],
    ['tApp', /\btapp\b/],
    ['Inspect Real Estate', /\binspect\s?real\s?estate\b/],
  ];
  // Listings agents leave up once taken: "DEPOSIT TAKEN", "Under application", "LEASED".
  // "Leased" only counts in the headline (descriptions say "leased parking", "previously leased").
  // Headlines are terse ("DEPOSIT TAKEN"); descriptions also carry process boilerplate ("a holding
  // deposit paid within 24 hours secures it", "pets considered under application"), so the text
  // needs a statement that it has already happened.
  const TAKEN = [
    ['deposit', /\bunder deposit\b|\b(?:holding )?deposit (?:has been |now |already )?(?:taken|received|paid)\b/,
      /\b(?:holding )?deposit (?:has (?:now |already )?been|is now|was|now|already) (?:taken|received|paid)\b/],
    ['application', /\bunder application\b|\bapplications? (?:(?:now|are) )?closed\b|\bapplication (?:received|approved|accepted)\b/,
      /(?<!\b(?:pets?|considered|allowed|permitted|accepted|welcome)\s)\bunder application\b|\bapplications (?:are |have )?(?:now )?closed\b|\ban application has (?:now )?been (?:approved|accepted)\b/],
    ['leased', /^\W*(?:leased|let agreed)\b|\b(?:now|just|has been) leased\b/, null],
  ];
  const TAKEN_LABELS = { deposit: 'Deposit taken', application: 'Under application', leased: 'Leased' };
  // No open-home times because the agent books private inspections instead.
  const BY_APPT = /\b(?:inspections?|viewings?) (?:are |is )?(?:strictly |only )?by (?:private )?appointment\b|\bby appointment only\b|\bprivate (?:inspections?|viewings?) (?:available|welcome|on request|by request)\b|\bcontact (?:the |our )?(?:agent|office) to (?:arrange|book) (?:an? |your )?(?:private )?(?:inspection|viewing)\b/;
  const byApptOf = (text) => BY_APPT.test(String(text || '').toLowerCase());
  const takenOf = (headline, text) => {
    const h = String(headline || '').toLowerCase(), t = String(text || '').toLowerCase();
    return TAKEN.find(([, head, body]) => head.test(h) || (body && body.test(t)))?.[0] || '';
  };
  const applyViaOf = (text) => { const t = String(text || '').toLowerCase(); return APPLY_VIA.find(([, re]) => re.test(t))?.[0] || ''; };

  // Lease term in months from the text: { min, max } or { flexible }; null when not stated.
  // The number must sit next to "lease"/"term": the gap can't cross a comma, a full stop or another number
  // ("available in 2 months, 12 month lease" is 12; "renovated 3 months ago, lease..." is nothing).
  const LEASE_RES = (() => {
    const mo = '\\s*-?\\s*(?:months?|mths?|mo)\\b', gap = '[^.;,\\d]{0,20}?', word = '\\b(?:lease|tenancy|term)', range = '(\\d{1,2})\\s*(?:-|–|to|or)\\s*(\\d{1,2})';
    return [`\\b${range}${mo}${gap}${word}`, `${word}\\b${gap}\\b${range}${mo}`, `\\b(\\d{1,2})${mo}${gap}${word}`, `${word}\\b${gap}\\b(\\d{1,2})${mo}`].map((p) => new RegExp(p));
  })();
  const leaseTermOf = (text) => {
    const t = String(text || '').toLowerCase();
    if (/\bflexible (?:lease|term)s?\b|\blease (?:terms?|length) (?:is )?(?:flexible|negotiable)\b/.test(t)) return { flexible: true };
    const [rangeA, rangeB, oneA, oneB] = LEASE_RES;
    let m = t.match(rangeA) || t.match(rangeB);
    if (m) return { min: Math.min(+m[1], +m[2]), max: Math.max(+m[1], +m[2]) };
    m = t.match(oneA) || t.match(oneB);
    if (m && +m[1] >= 1 && +m[1] <= 60) return { min: +m[1], max: +m[1] };
    m = t.match(/\b(\d)\s*-?\s*(?:years?|yrs?)\b[^.;,\d]{0,12}?\b(?:lease|tenancy|term)/) || t.match(/\b(?:lease|tenancy|term)\b[^.;,\d]{0,12}?\b(\d)\s*-?\s*(?:years?|yrs?)\b/);
    return m ? { min: +m[1] * 12, max: +m[1] * 12 } : null;
  };
  // Compact form for rows and storage: "6-12", "12", "flex" or "".
  const leaseCode = (l) => (!l ? '' : l.flexible ? 'flex' : l.min === l.max ? String(l.min) : `${l.min}-${l.max}`);
  const leaseFromCode = (c) => { const v = String(c || ''); if (v === 'flex') return { flexible: true }; const m = v.match(/^(\d+)(?:-(\d+))?$/); return m ? { min: +m[1], max: +(m[2] || m[1]) } : null; };
  const leaseLabel = (l) => (!l ? '' : l.flexible ? 'Flexible lease' : l.min === l.max ? `Lease ${l.min} mo` : `Lease ${l.min}–${l.max} mo`);
  const leaseText = (code) => leaseLabel(leaseFromCode(code));

  const watchIds = (v) => String(v || '').split(',').filter((id) => WATCHOUTS.some((w) => w.id === id));
  const watchTags = (r) => String(r.watch || '').split(',').map((id) => WATCHOUTS.find((w) => w.id === id)?.label).filter(Boolean);

  // Extra named places ("Work: -33.87,151.21", one per line, up to 3) shown beside the main point.
  const PLACES_MAX = 3;
  const parsePlaces = (v) => String(v || '').split(/\n+/).map((line, i) => {
    const m = line.match(/^\s*([^:]{1,24}?)\s*:\s*(.+)$/);
    const at = parseAnchor(m ? m[2] : line);
    return at ? { label: (m ? m[1] : `Place ${i + 1}`).trim(), ...at } : null;
  }).filter(Boolean).slice(0, PLACES_MAX);
  // Distances for one row: main point (r.km) and each place (r.placeKm), memoised per settings + position.
  const setDistances = (r, cfg, anchor = parseAnchor(cfg.anchor), places = parsePlaces(cfg.places)) => {
    const k = `${cfg.anchor}|${cfg.places}|${r.lat}|${r.lng}`;
    if (r._kmFor === k) return;
    r.km = kmFrom(anchor, r);
    r.placeKm = places.map((p) => ({ label: p.label, km: kmFrom(p, r) })).filter((p) => p.km != null);
    r._kmFor = k;
  };
  // Worst of all distances: "nearest to all" means the longest trip is shortest.
  const worstKm = (r) => { const all = [r.km, ...(r.placeKm || []).map((p) => p.km)].filter((v) => v != null); return all.length ? Math.max(...all) : null; };
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
  const kmShort = (km) => (km < 1 ? `${Math.round(km * 1000)} m` : `${km} km`);
  const placesLabel = (r) => (r.placeKm || []).map((p) => `${p.label} ${kmShort(p.km)}`).join(' · ');
  const kmLabel = (r) => (r.km == null ? '' : r.km < 1 ? `${Math.round(r.km * 1000)} m away` : `${r.km} km away`);

  const listingId = (href) => String(href || '').match(/-(\d{6,})(?:[/?#]|$)/)?.[1] || '';

  // One malformed listing must not sink a page: rows that throw are dropped.
  const safeRow = (listing, surrounding) => {
    try { return toRow(listing, surrounding); } catch (e) { console.debug?.('[reaFilter] listing skipped:', e); return null; }
  };
  // REA drift guard: `items` that isn't an array reads as empty rather than throwing.
  const itemsOf = (block) => (Array.isArray(block?.items) ? block.items : []);
  // A listing's structure with its words taken out, for reporting format changes: keys and
  // types everywhere; short display strings (dates, prices, labels) kept as they read, since
  // they are what the parsers look at; agent text, names, addresses and ids replaced by their type.
  const SHAPE_KEEP = /^(?:display|shortLabel|longLabel|label|value|unit|type|__typename|propertyType|state|currency|period|frequency)$/;
  const shapeOf = (v, key = '', depth = 0) => {
    if (depth > 8) return '…';
    if (v == null) return v;
    if (Array.isArray(v)) return v.length ? [shapeOf(v[0], key, depth + 1), `(${v.length} items)`] : [];
    if (typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shapeOf(v[k], k, depth + 1)]));
    if (typeof v === 'string') {
      if (/^https?:\/\//.test(v)) return 'url';
      if (/^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d\d:?\d\d)?)?$/.test(v)) return 'iso-date';
      const personal = /\d{3,}\s*\w+\s+(?:st|street|rd|road|ave|avenue)\b|@|(?:\+?61|\b0)[\s-]?\d(?:[\s-]?\d){7,}|\b\d{4}[\s-]?\d{3}[\s-]?\d{3}\b/i.test(v); // addresses, emails, phone numbers
      return SHAPE_KEEP.test(key) && v.length <= 40 && !personal ? v : `string(${v.length})`;
    }
    return typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : typeof v;
  };
  const sampleOf = (results) => itemsOf(results?.exact).find((i) => i?.listing)?.listing ?? null;
  const rowsFrom = (results) => [
    ...itemsOf(results?.exact).map((i) => i?.listing && safeRow(i.listing, false)),
    ...itemsOf(results?.surrounding).map((i) => i?.listing && safeRow(i.listing, true)),
  ].filter(Boolean);

  const toRow = (listing, surrounding) => {
    const display = str(listing.availableDate);
    const price = str(listing.price);
    const address = str(listing.address?.display?.fullAddress) || str(listing.address?.display?.shortAddress);
    const row = {
      avail: parseAvail(display),
      available: /^\s*(available\s+)?now\b/i.test(display) ? 'Available now' : display.replace(/^Available\s*/i, '') || '-',
      price,
      priceNum: parsePrice(price),
      bond: str(listing.bond),
      address,
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
      inspections: extractInspections(listing, new Date(), tzOf({ address, state: str(listing.address?.state) })),
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
    row.text = fold([row.headline, str(listing.description), row.address, row.type, ...row.features].filter(Boolean).join(' '));
    const said = [row.headline, str(listing.description), ...row.features].join(' ');
    row.watch = watchOf(said).join(',');
    row.applyVia = applyViaOf(said);
    row.taken = takenOf(row.headline, str(listing.description));
    row.byAppt = !row.inspections.length && byApptOf(said);
    row.lease = leaseCode(leaseTermOf(said));
    const field = extractSqm(listing);
    row.sqm = field ?? sqmFromText([row.headline, str(listing.description), ...row.features].join(' . '));
    row.sqmFromText = field == null && row.sqm != null;
    if (!row.avail) { // REA's field missing or unreadable: the description often says it
      const t = availFromText(said);
      if (t) { row.avail = t; row.available = `${dtf({ day: 'numeric', month: 'short', year: 'numeric' }).format(t)} (from text)`; row.availFromText = true; }
    }
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
        if (res.status === 403) throw botCheck(`REA refused the request (HTTP 403) - probably a bot check.`);
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
        return extractResults(await res.text());
      }
      if (attempt >= RETRIES) {
        if (err) throw new Error(`Network error: ${err.name === 'TimeoutError' ? 'timed out' : err.message}`);
        throw res.status === 429 ? botCheck('Rate limited by REA (HTTP 429), even after waiting - probably a bot check.') : new Error(`HTTP ${res.status} from ${url}`);
      }
      const after = Math.min(+res?.headers?.get?.('Retry-After') || 0, RETRY_AFTER_MAX_S);
      const ms = after > 0 ? after * 1000 : jitter(RETRY_BASE_MS * 2 ** attempt);
      onRetry(attempt + 1, ms);
      await wait(ms, signal);
    }
  }

  // `seed` = { key, page, results } from the already-loaded document, reused instead of refetching.
  // `keepPartial`: a page after the first that fails (not a cancel) ends the crawl with what was
  // read, plus `failed: { page, max, message }`, instead of throwing it all away. `isCached(url)`
  // skips the polite pause before a page that won't be fetched (eg on Resume).
  async function fetchAllPages(base, onProgress, { seed = null, fetchImpl, wait = sleep, getPage = null, signal, keepPartial = false, isCached = () => false } = {}) {
    const rows = [];
    const key = searchKey(base);
    let page = 1, max = 1, total = 1, sample = null;
    do {
      signal?.throwIfAborted();
      const label = `page ${page}${max > 1 ? ` of ${max}` : ''}`;
      onProgress(`Reading ${label}…`);
      const seeded = seed && seed.key === key && seed.page === page;
      let results;
      try {
        results = seeded ? seed.results : getPage ? await getPage(pageUrl(base, page)) : await fetchResults(pageUrl(base, page), {
          fetchImpl, wait, signal,
          onRetry: (n, ms) => onProgress(`Retrying ${label} in ${Math.round(ms / 1000)}s (attempt ${n}/${RETRIES})…`),
        });
      } catch (err) {
        if (!keepPartial || page === 1 || signal?.aborted || err?.name === 'AbortError') throw err;
        return { rows, truncated: total > MAX_PAGES, sample, failed: { page, max, message: String(err?.message || err) } };
      }
      total = results.pagination?.maxPageNumberAvailable || 1;
      max = Math.min(total, MAX_PAGES);
      rows.push(...rowsFrom(results));
      sample ??= sampleOf(results);
      page++;
      const nextSeeded = seed && seed.key === key && seed.page === page;
      if (page <= max && !seeded && !nextSeeded && !isCached(pageUrl(base, page))) await wait(jitter(PAGE_DELAY_MS), signal);
    } while (page <= max);
    return { rows, truncated: total > MAX_PAGES, sample };
  }

  // --------------------------------------------------------------- filter

  const DEFAULT_CFG = {
    from: '', to: '', withinDays: '', exactOnly: false,
    priceMin: '', priceMax: '', upfrontMax: '', bedsMin: '', bathsMin: '', carsMin: '', sizeMin: '',
    type: '', keyword: '', hideNoImage: false, hideTaken: false, inspectOn: '', inspectWhen: '', staleOnly: false, amenities: '', anchor: '', maxKm: '', floorplanOnly: false, sort: 'avail', sortDesc: false,
    annotate: true, dimCards: true, compact: false, onlyStarred: false, showHidden: false,
    remember: true, remindSaved: true, enquiry: '', places: '', checklist: '', wRent: '2', wTiming: '2', wDist: '2', wMovein: '2', icsAlarm: '60', newOnly: false, changedOnly: false, unopenedOnly: false, unreviewedOnly: false, noWatch: '', leaseMin: '', onePerBuilding: false, building: '', leaseEnd: '', showGone: false, income: '', theme: '',
  };

  // Saved settings are only trusted per key and type: a stale or hand-edited value (eg
  // keyword: null) falls back to the default instead of throwing on every render.
  const sanitizeCfg = (c) => (c && typeof c === 'object'
    ? Object.fromEntries(Object.keys(DEFAULT_CFG).filter((k) => typeof c[k] === typeof DEFAULT_CFG[k] && (k !== 'sort' || Object.hasOwn(SORTS, c[k]))).map((k) => [k, c[k]]))
    : {});

  // cfg keys that narrow results (FILTER_KEYS), live under "More filters" (MORE_KEYS), or
  // are display preferences that Clear keeps (DISPLAY_PREFS).
  const FILTER_KEYS = ['from', 'to', 'withinDays', 'priceMin', 'priceMax', 'upfrontMax', 'bedsMin', 'bathsMin', 'carsMin', 'sizeMin', 'type', 'keyword',
    'inspectOn', 'inspectWhen', 'hideNoImage', 'hideTaken', 'exactOnly', 'onlyStarred', 'newOnly', 'changedOnly', 'unopenedOnly', 'unreviewedOnly', 'staleOnly', 'amenities', 'noWatch', 'maxKm', 'floorplanOnly', 'leaseMin', 'onePerBuilding', 'building'];
  const MORE_KEYS = [...FILTER_KEYS.filter((k) => !['from', 'to', 'withinDays', 'exactOnly'].includes(k)), 'showHidden', 'showGone', 'anchor', 'places'];
  const PRESET_KEYS = [...FILTER_KEYS.filter((k) => k !== 'building'), 'anchor', 'sort', 'sortDesc']; // what a preset saves and restores
  const DISPLAY_PREFS = ['sort', 'sortDesc', 'annotate', 'dimCards', 'compact', 'remember', 'remindSaved', 'anchor', 'places', 'checklist', 'leaseEnd', 'income', 'enquiry', 'wRent', 'wTiming', 'wDist', 'wMovein', 'icsAlarm', 'theme']; // Clear keeps your "from" point

  const num = (v) => (v === '' || v == null || isNaN(+v) ? null : +v);
  const byAvail = (a, b) => (a.avail ?? Infinity) - (b.avail ?? Infinity);
  const byPrice = (a, b) => a.priceNum - b.priceNum;
  const SORTS = {
    avail: (a, b) => byAvail(a, b) || byPrice(a, b),
    price: (a, b) => byPrice(a, b) || byAvail(a, b),
    ppb: (a, b) => a.ppb - b.ppb || byAvail(a, b),
    ppsqm: (a, b) => (perSqm(a) ?? Infinity) - (perSqm(b) ?? Infinity) || byAvail(a, b),
    beds: (a, b) => (+b.beds || 0) - (+a.beds || 0) || byPrice(a, b),
    // Newest first: REA's listed date when present, else when this browser first saw it.
    listed: (a, b) => (b.listed ?? b.firstSeen ?? -Infinity) - (a.listed ?? a.firstSeen ?? -Infinity) || byAvail(a, b),
    inspect: (a, b) => (a.nextInspect ?? Infinity) - (b.nextInspect ?? Infinity) || byAvail(a, b),
    value: (a, b) => (a.vsMedian ?? Infinity) - (b.vsMedian ?? Infinity) || byPrice(a, b),
    distance: (a, b) => (a.km ?? Infinity) - (b.km ?? Infinity) || byAvail(a, b),
    fit: (a, b) => fitKey(a.fit) - fitKey(b.fit) || (a.priceNum ?? Infinity) - (b.priceNum ?? Infinity) || byAvail(a, b),
    allnear: (a, b) => (worstKm(a) ?? Infinity) - (worstKm(b) ?? Infinity) || byAvail(a, b),
    match: (a, b) => (b.score ?? -1) - (a.score ?? -1) || byAvail(a, b),
  };
  // NaN from Infinity - Infinity is falsy, so ties on unknowns fall through to the next key.
  // Reversed sorts keep listings without the value last (a "Contact agent" rent isn't the dearest).
  const SORT_UNKNOWN = {
    avail: (r) => !(r.avail instanceof Date), price: (r) => !Number.isFinite(r.priceNum), ppb: (r) => !Number.isFinite(r.ppb), ppsqm: (r) => perSqm(r) == null, beds: (r) => r.beds === '',
    listed: (r) => r.listed == null && r.firstSeen == null, inspect: (r) => r.nextInspect == null, value: (r) => r.vsMedian == null,
    distance: (r) => r.km == null, fit: (r) => !r.fit, allnear: (r) => worstKm(r) == null, match: (r) => r.score == null,
  };
  const sorter = (key, desc) => {
    const cmp = Object.hasOwn(SORTS, key) ? SORTS[key] : SORTS.avail;
    if (!desc) return cmp;
    const unknown = SORT_UNKNOWN[key] || SORT_UNKNOWN.avail;
    return (a, b) => (unknown(a) - unknown(b)) || cmp(b, a);
  };

  // Keyword: space-separated terms, all must match; "-term" excludes; "quoted phrase" kept whole.
  // Lowercase without accents, so "cafe" finds "café" (row text is stored folded).
  const fold = (v) => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  // Every term must appear; -term must not; "a phrase" as typed; a|b means either.
  // "Inspections I can make": a weekend, or 5pm or later, in the listing's own time zone.
  const INSPECT_WHEN = { weekend: 'Inspect on a weekend', evening: 'Inspect after 5pm', either: 'Weekend or after 5pm' };
  const inspectFits = (at, tz, when) => {
    const parts = Object.fromEntries(dtf({ weekday: 'short', hour: 'numeric', hourCycle: 'h23', ...(tz ? { timeZone: tz } : {}) }).formatToParts(at).map((p) => [p.type, p.value]));
    const weekend = parts.weekday === 'Sat' || parts.weekday === 'Sun', evening = +parts.hour >= 17;
    return when === 'weekend' ? weekend : when === 'evening' ? evening : weekend || evening;
  };
  const keywordTest = (q) => {
    const terms = fold(q).match(/-?"[^"]+"|\S+/g) || [];
    const inc = [], exc = [];
    for (const t of terms) {
      const neg = t.startsWith('-') && t.length > 1;
      const alts = (neg ? t.slice(1) : t).replace(/^"|"$/g, '').split('|').filter(Boolean);
      if (alts.length) (neg ? exc : inc).push(alts);
    }
    const has = (text, alts) => alts.some((w) => text.includes(w));
    return (text) => inc.every((a) => has(text, a)) && !exc.some((a) => has(text, a));
  };

  // Rent vs the median for the same bed count in these results (exact matches only, groups
  // of MEDIAN_MIN or more). vsMedian = % above (+) or below (-); null when not comparable.
  const MEDIAN_MIN = 5;
  const STALE_MS = 21 * DAY_MS; // listed this long ago: rent may be negotiable
  // Median rent per bed count. When the search spans suburbs, a listing is compared with its own
  // suburb's median for that bed count (when that has MEDIAN_MIN listings), so a cheaper suburb
  // doesn't read as a bargain against a dearer one.
  const withMedians = (rows) => {
    const priced = dedupe(rows).filter((r) => Number.isFinite(r.priceNum) && r.beds !== '');
    const subKey = (r) => (r.suburb ? `${String(r.suburb).toLowerCase()}|${+r.beds}` : null);
    // Same grouping and median as the market view, so a card's "x% below" agrees with its table.
    const medians = (groups) => new Map(groups.map((g) => [g.key, medianOf(g.rents)]).filter(([, m]) => m != null));
    const med = medians(groupRents(priced, (r) => (r.surrounding ? null : +r.beds)));
    const multi = new Set(priced.map((r) => String(r.suburb).toLowerCase())).size > 1;
    const sub = multi ? medians(groupRents(priced, subKey)) : new Map();
    for (const r of rows) {
      const sm = r.beds === '' ? undefined : sub.get(subKey(r));
      const m = sm ?? (r.beds === '' ? undefined : med.get(+r.beds));
      r.median = m ?? null;
      r.medianScope = sm != null ? r.suburb : '';
      r.vsMedian = m && Number.isFinite(r.priceNum) ? Math.round(((r.priceNum - m) / m) * 100) : null;
    }
    return rows;
  };
  const medianLabel = (r) => {
    if (r.vsMedian == null) return '';
    const what = `${r.medianScope ? `${r.medianScope} ` : ''}${+r.beds ? `${r.beds}-bed` : 'studio'}`;
    return r.vsMedian === 0 ? `at median for ${what}` : `${Math.abs(r.vsMedian)}% ${r.vsMedian < 0 ? 'below' : 'above'} ${what} median`;
  };

  // "Best match": mean of whichever signals the user has set up, each 0..1 (1 = best).
  // Explainable on purpose: scoreWhy lists the parts. Needs 2+ signals to mean anything.
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const SCORE_AVAIL_DAYS = 30; // this many days away from "from" scores 0 on timing
  const SCORE_KM = 15; // distance that scores 0 when no max km is set
  // Rent as a share of gross household income; over 30% is the usual "rent stress" line.
  const RENT_STRESS_PCT = 30;
  const incomePct = (r, income) => (num(income) > 0 && Number.isFinite(r.priceNum) ? Math.round((r.priceNum * 52 * 100) / num(income)) : null);

  // Best match weights (0 = ignore, 1-3 = importance), set under Settings.
  const SCORE_WEIGHTS = [['rent', 'wRent'], ['timing', 'wTiming'], ['distance', 'wDist'], ['move-in', 'wMovein']];
  const withScores = (rows, cfg) => {
    // Budget: your max rent, else what 30% of your income affords.
    const pMax = num(cfg.priceMax) || (num(cfg.income) > 0 ? Math.round((num(cfg.income) * RENT_STRESS_PCT) / 100 / 52) : null), kmMax = num(cfg.maxKm) || SCORE_KM;
    const from = cfg.from ? new Date(cfg.from + 'T00:00:00') : null;
    const upMed = quantile(rows.map((r) => r.upfront).filter(Number.isFinite).sort(asc), 0.5);
    const w = Object.fromEntries(SCORE_WEIGHTS.map(([k, key]) => { const v = num(cfg[key]); return [k, v == null ? 2 : Math.max(0, Math.min(3, v))]; }));
    for (const r of rows) {
      const parts = [];
      const dist = worstKm(r);
      if (Number.isFinite(r.priceNum)) {
        if (pMax) parts.push(['rent vs budget', clamp01(1 - r.priceNum / pMax + 0.5), w.rent]);
        else if (r.vsMedian != null) parts.push(['rent vs median', clamp01(0.5 - r.vsMedian / 50), w.rent]);
      }
      if (from && r.avail) parts.push(['timing', clamp01(1 - Math.abs(r.avail - from) / (SCORE_AVAIL_DAYS * DAY_MS)), w.timing]);
      if (dist != null) parts.push(['distance', clamp01(1 - dist / kmMax), w.distance]);
      if (upMed && Number.isFinite(r.upfront)) parts.push(['move-in', clamp01(0.5 - (r.upfront - upMed) / (2 * upMed)), w['move-in']]);
      const used = parts.filter(([, , wt]) => wt > 0);
      const total = used.reduce((t, [, , wt]) => t + wt, 0);
      r.score = used.length >= 2 ? Math.round((used.reduce((t, [, v, wt]) => t + v * wt, 0) / total) * 100) : null;
      r.scoreWhy = r.score == null ? '' : used.map(([k, v, wt]) => `${k} ${Math.round(v * 100)}${wt !== 2 ? ` (×${wt / 2})` : ''}`).join(', ');
    }
    return rows;
  };

  // Active filters as removable chips: [{ key, amen?, label }]. `without` gives the cfg with
  // that one chip removed, so the UI can show how many listings each filter is removing.
  const shortDate = (ymd) => dtf({ day: 'numeric', month: 'short' }).format(new Date(ymd + 'T00:00:00'));
  const NUM_FMT = new Intl.NumberFormat('en-AU');
  const money = (v) => `$${NUM_FMT.format(+v)}`;
  const statusLabel = (v) => (v ? v[0].toUpperCase() + v.slice(1) : 'Not started');
  const statusOptions = (cur) => APP_STATUSES.map((v) => `<option value="${v}"${v === cur ? ' selected' : ''}>${statusLabel(v)}</option>`).join('');
  const CHIP_LABELS = {
    from: (v) => `From ${shortDate(v)}`, to: (v) => `To ${shortDate(v)}`, withinDays: (v) => `Within ${Math.round(v / 7)} wks`,
    priceMin: (v) => `≥ ${money(v)}/wk`, priceMax: (v) => `≤ ${money(v)}/wk`, upfrontMax: (v) => `Move-in ≤ ${money(v)}`,
    bedsMin: (v) => `${v}+ bed`, bathsMin: (v) => `${v}+ bath`, carsMin: (v) => `${v}+ car`, sizeMin: (v) => `${v}+ m²`, type: (v) => v,
    keyword: (v) => `"${v}"`, inspectOn: (v) => `Inspecting ${shortDate(v)}`, inspectWhen: (v) => INSPECT_WHEN[v] || '', hideNoImage: () => 'Has a photo', hideTaken: () => 'Not taken',
    exactOnly: () => 'No surrounding suburbs', onlyStarred: () => 'Shortlisted', newOnly: () => 'New only', changedOnly: () => 'Changed only', unopenedOnly: () => 'Not opened yet', unreviewedOnly: () => 'Not reviewed', leaseMin: (v) => `Lease ${v}+ mo`, onePerBuilding: () => 'One per building', building: (v) => `Building: ${v.split('|')[1] || 'one building'}`,
    staleOnly: () => 'Listed 3+ wks', maxKm: (v) => `≤ ${v} km`, floorplanOnly: () => 'Floorplan',
  };
  const NUM_KEYS = ['priceMin', 'priceMax', 'upfrontMax', 'bedsMin', 'bathsMin', 'carsMin', 'sizeMin', 'maxKm', 'withinDays', 'leaseMin'];
  const activeFilters = (cfg) => {
    const out = [];
    for (const k of FILTER_KEYS) {
      const v = cfg[k];
      if (!v || v === DEFAULT_CFG[k] || (typeof v === 'string' && !v.trim())) continue;
      if (NUM_KEYS.includes(k) && num(v) == null) continue; // a stray non-number is ignored by the filter too
      if (k === 'amenities') {
        for (const [id, st] of Object.entries(parseAmenCfg(v))) {
          const a = AMENITIES.find((x) => x.id === id);
          out.push({ key: k, amen: id, label: `${st === 'yes' ? '+' : '−'} ${a.label}` });
        }
      } else if (k === 'type') {
        for (const t of typeList(v)) out.push({ key: k, ptype: t, label: t });
      } else if (k === 'noWatch') {
        for (const id of watchIds(v)) out.push({ key: k, watch: id, label: `No ${WATCHOUTS.find((w) => w.id === id).label.toLowerCase()}` });
      } else if (k !== 'maxKm' || parseAnchor(cfg.anchor)) out.push({ key: k, label: CHIP_LABELS[k] ? CHIP_LABELS[k](v) : k });
    }
    return out;
  };
  // cfg.type: one or more property types, comma-separated ("Apartment,Unit"); '' is any.
  const typeList = (v) => [...new Set(String(v || '').split(',').map((t) => t.trim()).filter(Boolean))];
  const without = (cfg, chip) => {
    if (chip.ptype) return { ...cfg, type: typeList(cfg.type).filter((t) => t !== chip.ptype).join(',') };
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
  // Rent and $/bed per group (bed count, suburb), sorted ascending, for the quantiles below.
  const asc = (x, y) => x - y;
  const medianOf = (a) => (a.length >= MEDIAN_MIN ? quantile(a, 0.5) : null);
  const groupRents = (rows, keyOf) => {
    const m = new Map();
    for (const r of rows) {
      const k = keyOf(r);
      if (k == null || k === '') continue;
      let g = m.get(k);
      if (!g) m.set(k, (g = { key: k, n: 0, rents: [], ppb: [] }));
      g.n++;
      if (Number.isFinite(r.priceNum)) g.rents.push(r.priceNum);
      if (Number.isFinite(r.ppb)) g.ppb.push(r.ppb);
    }
    for (const g of m.values()) { g.rents.sort(asc); g.ppb.sort(asc); }
    return [...m.values()];
  };
  const marketStats = (rows, now = new Date()) => {
    const uniq = dedupe(rows);
    const byBeds = groupRents(uniq, (r) => (r.beds === '' || r.beds == null ? null : Math.min(+r.beds || 0, 5))).sort((a, b) => a.key - b.key)
      .map(({ key, n, rents, ppb }) => {
        const enough = rents.length >= MEDIAN_MIN;
        return { beds: key, n, priced: rents.length, min: rents[0] ?? null, max: rents[rents.length - 1] ?? null,
          p25: enough ? quantile(rents, 0.25) : null, median: medianOf(rents), p75: enough ? quantile(rents, 0.75) : null, ppb: medianOf(ppb) };
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
      const days = Math.round((startOfDay(r.avail) - today) / DAY_MS);
      if (days <= 0) weeks[0].n++;
      else if (days <= MARKET_WEEKS * 7) weeks[Math.ceil(days / 7)].n++;
      else later.n++;
    }
    const all = uniq.map((r) => r.priceNum).filter(Number.isFinite).sort(asc);
    // Per suburb, only worth showing when the search spans several.
    const subs = groupRents(uniq, (r) => String(r.suburb || '').trim());
    const bySuburb = subs.length > 1 ? subs.sort((a, b) => b.n - a.n || a.key.localeCompare(b.key))
      .map(({ key, n, rents, ppb }) => ({ suburb: key, n, median: medianOf(rents), ppb: medianOf(ppb) })) : [];
    return { n: uniq.length, median: medianOf(all), byBeds, bySuburb, byWeek: [...weeks, later, unknown] };
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
    let fresh = 0, moved = 0, redated = 0, featured = 0, hidden = 0, cheaperHidden = 0, reviewed = 0, total = 0;
    for (const r of dedupe(rows)) {
      hidden += r.hidden && !r.resurfaced ? 1 : 0; // a resurfaced one is on show
      cheaperHidden += r.hidden && !r.resurfaced && r.cheaperBy > 0 ? 1 : 0; // hidden for another reason, and cheaper now
      if (ruledOut(r)) continue; // changes are counted over what you could still pick, as "Changed recently" shows
      total++; reviewed += r.reviewedAt ? 1 : 0;
      fresh += isFresh(r) ? 1 : 0; moved += r.prevPrice ? 1 : 0; redated += r.prevAvail ? 1 : 0; featured += r.featChange ? 1 : 0;
    }
    return { fresh, moved, redated, featured, hidden, cheaperHidden, reviewed, total };
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
    const kept = filterRows(rows, cfg, now);
    for (const r of kept) r.fit = leaseFit(r, cfg.leaseEnd, now);
    return withScores(kept, cfg).sort(sorter(cfg.sort, cfg.sortDesc));
  }

  function filterRows(rows, cfg, now = new Date()) {
    cfg = { ...DEFAULT_CFG, ...cfg };
    const from = cfg.from ? new Date(cfg.from + 'T00:00:00') : null;
    let to = cfg.to ? new Date(cfg.to + 'T23:59:59') : null;
    // Rolling window ("within 4 weeks") tightens the upper bound relative to today, so a
    // saved setting never goes stale the way a fixed date does.
    const w = windowEndDate(cfg.withinDays, now);
    if (w && (!to || w < to)) to = w;
    const pMin = num(cfg.priceMin), pMax = num(cfg.priceMax), upMax = num(cfg.upfrontMax), sizeMin = num(cfg.sizeMin);
    const mins = [['beds', num(cfg.bedsMin)], ['baths', num(cfg.bathsMin)], ['cars', num(cfg.carsMin)]].filter(([, v]) => v != null);
    const kw = cfg.keyword.trim() ? keywordTest(cfg.keyword) : null;
    const amenReq = Object.entries(parseAmenCfg(cfg.amenities));
    const noWatch = watchIds(cfg.noWatch);
    const bKey = cfg.building.split('|')[0], leaseNeed = num(cfg.leaseMin), types = typeList(cfg.type); // building is "key|label" from "N in this building"
    // Distance depends on cfg.anchor, so it is (re)computed here for every caller.
    const anchor = parseAnchor(cfg.anchor), kmMax = num(cfg.maxKm);
    // Memoised per anchor: removedBy() re-filters once per chip with the same point.
    const places = parsePlaces(cfg.places);
    for (const r of rows) setDistances(r, cfg, anchor, places);
    const insDay = !!cfg.inspectOn;
    const sameDay = (ms, r) => ymdIn(ms, tzOf(r)) === cfg.inspectOn; // the listing's calendar day, like the planner
    const kept = dedupe(rows)
      .filter((r) => (cfg.exactOnly ? !r.surrounding : true))
      .filter((r) => cfg.showHidden || !ruledOut(r))
      .filter((r) => !cfg.floorplanOnly || r.floorplan === true)
      .filter((r) => cfg.showGone || !r.gone)
      .filter((r) => !cfg.newOnly || isFresh(r))
      .filter((r) => !cfg.changedOnly || !!(r.prevPrice || r.prevAvail || r.featChange))
      .filter((r) => !cfg.unopenedOnly || !r.openedAt)
      .filter((r) => !cfg.unreviewedOnly || !r.reviewedAt)
      .filter((r) => !noWatch.length || !String(r.watch || '').split(',').some((id) => noWatch.includes(id)))
      .filter((r) => !cfg.staleOnly || (r.listed instanceof Date && now - r.listed > STALE_MS))
      .filter((r) => kmMax == null || !anchor || (r.km != null && r.km <= kmMax)) // no location fails a distance cap
      .filter((r) => amenReq.every(([id, st]) => (st === 'yes' ? r.amen?.[id] === 'yes' : r.amen?.[id] !== 'yes')))
      .filter((r) => !cfg.onlyStarred || r.starred)
      .filter((r) => (r.avail ? (!from || r.avail >= from) && (!to || r.avail <= to) : !from && !to))
      .filter((r) => (pMin == null || (Number.isFinite(r.priceNum) && r.priceNum >= pMin)) && (pMax == null || r.priceNum <= pMax))
      .filter((r) => upMax == null || (r.upfront ?? Infinity) <= upMax) // unknown bond fails a move-in cap
      .filter((r) => mins.every(([k, v]) => r[k] !== '' && +r[k] >= v))
      .filter((r) => sizeMin == null || (r.sqm != null && r.sqm >= sizeMin)) // unknown size fails a minimum
      .filter((r) => !types.length || types.includes(r.type))
      .filter((r) => !cfg.hideNoImage || r.img)
      .filter((r) => !cfg.hideTaken || !r.taken)
      .filter((r) => !kw || kw(r.text || ''))
      .filter((r) => !insDay || (r.inspections || []).some((i) => i.at != null && sameDay(i.at, r)))
      .filter((r) => !INSPECT_WHEN[cfg.inspectWhen] || (r.inspections || []).some((i) => i.at != null && i.at >= +now - INSPECT_GRACE_MS && inspectFits(i.at, tzOf(r), cfg.inspectWhen)))
      .filter((r) => !bKey || buildingKey(r.address) === bKey)
      .filter((r) => { const l = leaseNeed ? leaseFromCode(r.lease) : null; return !l || l.flexible || l.max >= leaseNeed; }); // a stated lease too short; unstated or flexible passes
    return cfg.onePerBuilding && !cfg.building ? onePerBuilding(kept) : kept;
  }

  // Same building: a unit address without its unit ("5/12 Hall St, Bondi" -> "12 hall st bondi").
  const UNIT_PREFIX = /^\s*(?:(?:(?:unit|apartment|apt|flat|suite|villa|townhouse|lot|shop|studio|penthouse|room)\s*[\w-]+|level\s*\d+)\s*[,\/]?\s*)+|^\s*(?:(?:shop|studio|penthouse|suite)\s+)?[\w-]+\s*\/\s*/i;
  const bKeys = new Map(); // address -> building key: withBuildings/onePerBuilding/filterRows ask per row, per render
  const buildingKey = (address) => {
    const a = String(address || '');
    let k = bKeys.get(a);
    if (k === undefined) { if (bKeys.size > 20000) bKeys.clear(); bKeys.set(a, (k = UNIT_PREFIX.test(a) ? addressKey(a.replace(UNIT_PREFIX, '')) : '')); }
    return k;
  };
  // One per building keeps the cheapest unit; houses and unit-less addresses always stay.
  const onePerBuilding = (rows) => {
    const best = new Map();
    for (const r of rows) {
      const k = buildingKey(r.address);
      if (k && (!best.has(k) || (r.priceNum ?? Infinity) < (best.get(k).priceNum ?? Infinity))) best.set(k, r);
    }
    return rows.filter((r) => { const k = buildingKey(r.address); return !k || best.get(k) === r; });
  };
  // Per row: how many listings share its building, and other listings at the exact same address
  // (the same place listed twice, eg by two agencies).
  const withBuildings = (rows) => {
    const byB = new Map(), byA = new Map();
    const add = (m, k, r) => { if (k) { if (!m.has(k)) m.set(k, []); m.get(k).push(r); } };
    for (const r of dedupe(rows)) if (!r.gone && !ruledOut(r)) { add(byB, buildingKey(r.address), r); add(byA, addressKey(r.address), r); } // count what you could still pick
    for (const r of rows) {
      const b = buildingKey(r.address), same = b ? byB.get(b) || [] : [];
      r.buildingN = same.length > 1 ? same.length : 0;
      r.buildingAddr = r.buildingN ? String(r.address).replace(UNIT_PREFIX, '').split(',')[0].trim() : '';
      r.alsoListed = (byA.get(addressKey(r.address)) || []).filter((x) => x.id !== r.id).map((x) => ({ id: x.id, agency: x.agency || '', price: x.price || '' }));
    }
    return rows;
  };

  // Moving from your current lease: nights paying two rents (overlap) or with nowhere (gap).
  // Your lease covers through `leaseEnd`; the new one starts on its available date (today if now).
  const leaseFit = (r, leaseEnd, now = new Date()) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(leaseEnd || '')) || !(r.avail instanceof Date) || isNaN(r.avail)) return null;
    const end = dayNum(new Date(`${leaseEnd}T00:00:00`)), start = Math.max(dayNum(r.avail), dayNum(now));
    if (end < dayNum(now)) return null; // your lease already ended: nothing to fit
    const overlap = Math.max(0, end - start + 1), gap = Math.max(0, start - end - 1);
    return { overlap, gap, cost: overlap && Number.isFinite(r.priceNum) ? Math.round((overlap * r.priceNum) / 7) : 0 };
  };
  const fitLabel = (f) => (!f ? '' : f.overlap ? `${plural(f.overlap, 'day')} overlap${f.cost ? ` ≈ ${money(f.cost)}` : ''}` : f.gap ? `${plural(f.gap, 'night')} gap` : 'starts right after your lease');
  const fitKey = (f) => (!f ? Infinity : f.gap ? 1e9 + f.gap : f.cost + f.overlap / 100);

  const historyText = (r) => (r.priceHistory || []).map(([at, p]) => `${ymdLocal(new Date(at))} ${p}`).join(' → ');
  const ppbLabel = (r) => (+r.beds > 1 && Number.isFinite(r.ppb) ? `$${r.ppb}/bed` : '');

  const EXPORT_COLS = [
    ['availDate', 'available_date'], ['available', 'available'], ['price', 'price'], ['priceNum', 'weekly_rent'],
    ['ppb', 'rent_per_bed'], ['bond', 'bond'], ['bondWeeks', 'bond_weeks'], ['upfront', 'move_in_cost'], ['vsMedian', 'vs_median_pct'], ['amenList', 'amenities'], ['watchList', 'heads_up'], ['leaseText', 'lease'], ['applyVia', 'apply_via'], ['takenText', 'taken'], ['byAppt', 'by_appointment'], ['fitText', 'lease_fit'], ['km', 'km'], ['score', 'match_score'], ['agency', 'agency'], ['photos', 'photos'], ['floorplan', 'floorplan'], ['sqm', 'floor_m2'], ['perSqmVal', 'rent_per_m2'], ['address', 'address'], ['suburb', 'suburb'], ['beds', 'beds'],
    ['baths', 'baths'], ['cars', 'cars'], ['type', 'type'], ['inspect', 'inspections'], ['listed', 'listed'],
    ['surrounding', 'nearby'], ['starred', 'shortlisted'], ['isNew', 'new'], ['prevPrice', 'previous_price'], ['prevAvail', 'previous_available'], ['priceHistoryText', 'price_history'], ['relistedText', 'relisted_from_price'], ['appStatus', 'application'], ['appDate', 'application_date'], ['checksText', 'checklist'], ['hideReason', 'hide_reason'], ['note', 'note'],
    ['headline', 'headline'], ['url', 'url'], ['id', 'id'], ['lat', 'lat'], ['lng', 'lng'], // last: lat/lng let Google My Maps plot the file
  ];
  const ymdLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const cellValue = (r, k) => {
    const v = k === 'availDate' ? r.avail : k === 'amenList' ? amenityTags(r).join('; ') : k === 'watchList' ? watchTags(r).join('; ')
      : k === 'takenText' ? TAKEN_LABELS[r.taken] || '' : k === 'appDate' ? (r.appAt ? new Date(r.appAt) : '') : k === 'checksText' ? Object.entries(r.checks || {}).map(([c, v]) => `${v === 'y' ? '✓' : '✗'} ${c}`).join('; ') : k === 'leaseText' ? leaseText(r.lease) : k === 'fitText' ? fitLabel(r.fit) : k === 'priceHistoryText' ? historyText(r) : k === 'relistedText' ? (r.relisted ? r.relisted.price || 'yes' : '') : k === 'perSqmVal' ? perSqm(r) : r[k];
    if (v instanceof Date) return isNaN(v) ? '' : ymdLocal(v);
    if (typeof v === 'number') return isFinite(v) ? String(v) : '';
    if (typeof v === 'boolean') return v ? 'yes' : '';
    return String(v ?? '').replace(/\s+/g, ' ').trim();
  };
  // Spreadsheet formula injection guard (OWASP): neutralise leading = + @ tab CR, and any
  // leading - that isn't a plain negative number ("-1+1" evaluates in Excel/Sheets).
  const safeCell = (v) => (/^[=+@\t\r]|^-(?!\d+(\.\d+)?$|$)/.test(v) ? `'${v}` : v); // a bare "-" (no date) is harmless
  const table = (rows) => [EXPORT_COLS.map(([, h]) => h)].concat(rows.map((r) => EXPORT_COLS.map(([k]) => safeCell(cellValue(r, k)))));

  const toTsv = (rows) => table(rows).map((cols) => cols.map((c) => c.replace(/\t/g, ' ')).join('\t')).join('\n');
  const toCsv = (rows) => table(rows).map((cols) => cols.map((c) => (/[",\n\r]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\r\n');


  // Upcoming inspections as an iCalendar file (RFC 5545) for any calendar app. REA gives a
  // start time only, so each event is INSPECT_MINUTES long. '' when there are none.
  const INSPECT_MINUTES = 15;
  // Start of the latest inspection in `ins` that has finished by `t` (0 if none).
  const lastPast = (ins, t) => Math.max(0, ...(Array.isArray(ins) ? ins : []).map((i) => i?.at).filter((at) => typeof at === 'number' && at + INSPECT_MINUTES * 60e3 < t));
  const icsText = (v) => String(v ?? '').replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\r\n?|\n/g, '\\n');
  const icsTime = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  // Lines over 75 octets are folded: CRLF + one space, per RFC 5545 3.1.
  const icsFold = (line) => {
    const out = [];
    let cur = '', bytes = 0;
    if (line.length <= 75 && /^[\x00-\x7f]*$/.test(line)) return line; // ASCII: one octet a character
    for (const ch of line) {
      const c = ch.codePointAt(0), b = c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
      if (bytes + b > 75) { out.push(cur); cur = ' '; bytes = 1; }
      cur += ch; bytes += b;
    }
    out.push(cur);
    return out.join('\r\n');
  };
  // `alarm`: minutes before each inspection for a reminder (0 = none; some calendars ignore
  // reminders in imported files).
  const toIcs = (rows, now = Date.now(), { alarm = 0 } = {}) => {
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
          `DESCRIPTION:${icsText([r.price, r.available && `Available ${r.available}`, r.agency, r.applyVia && `Apply via ${r.applyVia}`, leaseText(r.lease), r.appStatus && `Status: ${r.appStatus}`, r.note].filter(Boolean).join(' | '))}`,
          ...(alarm > 0 ? ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(`Inspection: ${r.address || 'rental'}`)}`, `TRIGGER:-PT${Math.round(alarm)}M`, 'END:VALARM'] : []),
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

  // Suggested route through a day's slots (planDay order): at most one session per listing,
  // each reachable from the last (its end + max(PLAN_MIN_GAP, km × PLAN_MIN_PER_KM) minutes).
  // Most listings wins, "to inspect" ones counting double; ties go to less travel, then an
  // earlier finish. Exact up to ROUTE_EXACT_MAX listings, earliest-finish greedy above.
  const ROUTE_EXACT_MAX = 16;
  const reachable = (a, b) => {
    const km = a.r.lat != null && b.r.lat != null ? haversineKm(a.r, b.r) : 0;
    return b.at >= a.end + Math.max(PLAN_MIN_GAP, km * PLAN_MIN_PER_KM) * 60e3 ? km : -1;
  };
  const bestRoute = (slots) => {
    const ids = [...new Set(slots.map((x) => x.r.id))];
    const bit = new Map(ids.map((id, i) => [id, i]));
    const weight = (x) => (x.r.appStatus === 'to inspect' ? 2 : 1);
    const better = (a, b) => !b || a.w > b.w || (a.w === b.w && (a.km < b.km - 1e-9 || (Math.abs(a.km - b.km) <= 1e-9 && a.end < b.end)));
    let best;
    if (ids.length <= ROUTE_EXACT_MAX) {
      const n = slots.length, memo = new Map();
      const bits = slots.map((x) => 1 << bit.get(x.r.id));
      const kmTo = slots.map((a, i) => slots.map((b, j) => (j > i ? reachable(a, b) : -1))); // once per pair, not per visited-set
      // Listings with a slot after i: only those bits of `mask` can change what follows, so
      // states differing in earlier-only listings share one memo entry.
      const later = new Array(n + 1).fill(0);
      for (let i = n - 1; i >= 0; i--) later[i] = later[i + 1] | bits[i];
      // Best continuation after slot `i` (-1: start of day), having visited `mask`; path as a linked list.
      const go = (i, mask) => {
        mask &= later[i + 1];
        const key = mask * (n + 1) + i + 1;
        const hit = memo.get(key);
        if (hit) return hit;
        let out = { w: 0, km: 0, end: i < 0 ? 0 : slots[i].end, j: -1, next: null };
        for (let j = i + 1; j < n; j++) {
          if (mask & bits[j]) continue;
          const km = i < 0 ? 0 : kmTo[i][j];
          if (km < 0) continue;
          const rest = go(j, mask | bits[j]);
          const cand = { w: rest.w + weight(slots[j]), km: rest.km + km, end: rest.end, j, next: rest };
          if (better(cand, out)) out = cand;
        }
        memo.set(key, out);
        return out;
      };
      const path = [];
      for (let c = go(-1, 0); c.j >= 0; c = c.next) path.push(c.j);
      best = { path };
    } else {
      const path = [], seen = new Set();
      for (;;) {
        const last = path.length ? slots[path.at(-1)] : null;
        let pick = -1;
        for (let j = last ? path.at(-1) + 1 : 0; j < slots.length; j++) {
          if (seen.has(slots[j].r.id) || (last && reachable(last, slots[j]) < 0)) continue;
          if (pick < 0 || slots[j].end < slots[pick].end) pick = j;
        }
        if (pick < 0) break;
        path.push(pick); seen.add(slots[pick].r.id);
      }
      best = { path };
    }
    return { picked: new Set(best.path.map((j) => slots[j])), visits: best.path.length, listings: ids.length };
  };

  const plural = (n, word, suffix = 's') => `${n} ${word}${n === 1 ? '' : suffix}`;
  const ruledOut = (r) => !!((r.hidden && !r.resurfaced) || r.agencyHidden || r.suburbHidden); // you hid it (unless it got cheaper), its agency or its suburb
  const orQ = (v) => (v === '' || v == null ? '?' : v);

  // Shortlist search: every word must appear in the address, note, agency, suburb, price or status.
  const textMatch = (r, q) => {
    const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return true;
    const hay = [r.address, r.note, r.agency, r.suburb, r.price, r.appStatus, r.type].filter(Boolean).join(' ').toLowerCase();
    return terms.every((t) => hay.includes(t));
  };

  // Enquiry message from a template: {address} {price} {available} {inspection} {link}.
  const ENQUIRY_DEFAULT = 'Hi, I\'m interested in {address} ({price}). Is it still available{available}? {inspection}Thanks.';
  const enquiryText = (r, template) => String(template || ENQUIRY_DEFAULT)
    .replace(/\{address\}/g, r.address || 'this property').replace(/\{price\}/g, r.price || 'price on request')
    .replace(/\{available\}/g, () => {
      const a = String(r.available && r.available !== '-' ? r.available : '').replace(/^available\s*(from\s*)?/i, '').trim();
      return !a ? '' : /^now$/i.test(a) ? ' now' : ` from ${a}`;
    })
    .replace(/\{inspection\}/g, r.inspections?.[0]?.label ? `I'd like to come to the inspection on ${r.inspections[0].label}. ` : r.byAppt ? 'Could I book a private inspection? ' : 'Could I arrange an inspection? ')
    .replace(/\{link\}/g, r.url || '').replace(/\s+\n/g, '\n').trim();

  // One listing as plain text for a message.
  // "Available 12 Oct · 2 bed, 1 bath, ? car · move-in $3,300": shared by Copy and Print.
  const factsLine = (r, sep) => [r.available && r.available !== '-' ? `Available ${r.available}` : '',
    [r.beds, r.baths, r.cars].some((v) => v !== '' && v != null) ? [`${orQ(r.beds)} bed`, `${orQ(r.baths)} bath`, `${orQ(r.cars)} car`].join(sep) : '',
    Number.isFinite(r.upfront) ? `move-in ${money(r.upfront)}` : ''].filter(Boolean).join(' · ');
  const summaryText = (r) => [
    `${r.price || 'Price on request'} - ${r.address}`,
    factsLine(r, ', '),
    r.inspections?.length ? `Inspections: ${r.inspections.map((i) => i.label).join('; ')}` : '',
    r.url,
  ].filter(Boolean).join('\n');

  // Printable shortlist: a standalone HTML document (all text escaped), light theme forced.
  const printHtml = (rows, now = new Date(), checklist = []) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Rental shortlist ${ymdLocal(now)}</title><style>
body{font:13px/1.45 system-ui,-apple-system,sans-serif;color:#111;background:#fff;margin:24px}
h1{font-size:18px;margin:0 0 4px}.sub{color:#555;margin-bottom:16px}
.l{display:grid;grid-template-columns:150px 1fr;gap:14px;padding:12px 0;border-top:1px solid #ddd;break-inside:avoid}
.l img{width:150px;height:110px;object-fit:cover;border-radius:6px;background:#eee}
.p{font-weight:700;font-size:15px}.a{font-weight:600}.m{color:#444;margin-top:2px}.n{margin-top:6px;padding:6px 8px;background:#f4f4f6;border-radius:4px;white-space:pre-wrap}
.box{margin-top:8px;height:64px;border:1px dashed #aaa;border-radius:4px;color:#999;font-size:11px;padding:4px}
.u{color:#666;font-size:11px;word-break:break-all}@media print{body{margin:10mm}}
</style></head><body><h1>Rental shortlist</h1><div class="sub">${plural(rows.length, 'listing')} · printed ${esc(now.toLocaleDateString('en-AU'))}</div>
${rows.map((r) => `<div class="l">${r.img ? `<img src="${esc(r.img)}" alt="">` : '<div></div>'}<div>
<div class="p">${esc(r.price)}</div><div class="a">${esc(r.address)}</div>
<div class="m">${esc(factsLine(r, ' · '))}</div>
${(r.inspections || []).length ? `<div class="m">Inspections: ${esc(r.inspections.map((i) => i.label).join('; '))}</div>` : ''}
${r.agency ? `<div class="m">${esc(r.agency)}</div>` : ''}${r.appStatus ? `<div class="m">Status: ${esc(r.appStatus)}</div>` : ''}
${r.note ? `<div class="n">${esc(r.note)}</div>` : ''}${checklist.length ? `<div class="m">${checklist.map((k) => `${r.checks?.[k] === 'y' ? '☑' : r.checks?.[k] === 'n' ? '☒' : '☐'} ${esc(k)}`).join('  ')}</div>` : ''}<div class="box">Notes at inspection</div><div class="u">${esc(r.url)}</div>
</div></div>`).join('')}</body></html>`;

  // Drift canary: share of rows with each field, tracked as an average over searches. A field
  // that's usually there but suddenly isn't means REA probably renamed or moved it.
  const HEALTH_KEY = `${TOOL_PREFIX}health/v1`;
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
    'propertySizes', 'buildingSize', 'floorArea',
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
      fetchResults, fetchAllPages, sleep, pauseGate, sqmFromText, extractSqm, perSqm, PAUSE_MS, unpackJson, findListing, parseListingPage, discover, extractCoords, extractAgency, extractFeatures, extractMedia, listingId, dedupe, windowEnd, extractInspections, extractListed, toDate, applyFilters, filterRows, keywordTest, toTsv, toCsv, toIcs, printHtml, summaryText, inspectDays, planDay, bestRoute, tzOf, textMatch, availFromText, needsAction, applyViaOf, leaseTermOf, leaseLabel, leaseCode, leaseFromCode, buildingKey, onePerBuilding, withBuildings, leaseFit, fitLabel, checklistItems, checkSummary, parsePlaces, setDistances, worstKm, featSig, featDiff, enquiryText, HIDE_REASONS, agencyRecord, needsFollowUp, recordText, watchOf, watchTags, marketStats, searchLabel, incomePct, toolKeys, toolBytes, fmtBytes, encodeShare, decodeShare, shareUrl, shareFromHash, schemaWarnings, probe, esc, safeUrl, rowStore, marksStore, snapshotStore, presetStore, writeState, typeList, bigImg, shapeOf, amenityTags, resultsPath, healthStore, fillRates, APP_STATUSES, addressKey, DEFAULT_CFG, activeFilters, removedBy, withScores, parseAnchor, haversineKm, AMENITIES, amenitiesOf, parseAmenCfg, amenCfgString, moveIn, withMedians, medianLabel, sanitizeCfg, itemsOf, sampleOf, cfgError, diffStats, ago, startOfDay, isFresh,
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
    const ics = toIcs(rows, Date.now(), { alarm: num(cfg.icsAlarm) || 0 });
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

  // Colours are tokens on #rf-panel so the dark scheme only swaps values. The Theme setting
  // (data-rf-theme on <html>) overrides the system choice either way.
  const RF_ROOTS = ':is(#rf-panel,#rf-launch,#rf-lbar,#rf-remind,#rf-toast)';
  const DARK_TOKENS = '--rf-bg:#1c1c20;--rf-fg:#ececf1;--rf-muted:#a0a0ab;--rf-soft:#8e8e99;--rf-line:#2e2e35;--rf-input:#6a6a75;'
    + '--rf-hover:#26262c;--rf-sec:#2a2a31;--rf-sec-hover:#34343c;--rf-accent-fg:#3ddc9a;--rf-err:#ff6b6b;--rf-tag:#33333b;--rf-up:#ff9f4a;--rf-star-fg:#f2c14e';
  const css = `
  #rf-panel,#rf-launch,#rf-lbar,#rf-remind,#rf-toast{--rf-bg:#fff;--rf-fg:#111;--rf-muted:#666;--rf-soft:#6e6e78;--rf-line:#e4e4e7;--rf-input:#8f8f98;
    --rf-hover:#f6f6f8;--rf-sec:#f1f1f4;--rf-sec-hover:#e6e6ea;--rf-accent:#087a50;--rf-accent-hover:#06663f;--rf-accent-fg:#087a50;
    --rf-err:#c00;--rf-tag:#eee;--rf-up:#b34700;--rf-star-fg:#8a6100}
  @media (prefers-color-scheme: dark){ :root:not([data-rf-theme=light]) ${RF_ROOTS}{${DARK_TOKENS}} }
  :root[data-rf-theme=dark] ${RF_ROOTS}{${DARK_TOKENS};color-scheme:dark} :root[data-rf-theme=light] ${RF_ROOTS}{color-scheme:light}
  #rf-launch{position:fixed;right:20px;bottom:20px;z-index:2147483000;padding:11px 16px;border:0;border-radius:999px;
    background:var(--rf-accent);color:#fff;font:600 13px/1 system-ui,-apple-system,sans-serif;cursor:pointer;
    box-shadow:0 4px 16px rgba(0,0,0,.28)}
  #rf-launch:hover{background:var(--rf-accent-hover)}
  /* hidden always wins over our display rules */
  #rf-launch[hidden],#rf-panel[hidden],#rf-panel [hidden],#rf-lbar [hidden]{display:none!important}
  #rf-panel{position:fixed;top:0;right:0;bottom:0;width:430px;max-width:100vw;z-index:2147483001;background:var(--rf-bg);
    display:flex;flex-direction:column;box-shadow:-4px 0 24px rgba(0,0,0,.22);color-scheme:light dark;
    font:13px/1.45 system-ui,-apple-system,sans-serif;color:var(--rf-fg)}
  #rf-panel *{box-sizing:border-box}
  /* Side drawer: the whole drawer scrolls as one page (filters, then results) under a sticky
     header, instead of the results getting a small scroll box of their own. */
  #rf-panel:not(.rf-full){overflow-y:auto;overscroll-behavior:contain}
  .rf-resize{position:fixed;top:0;bottom:0;width:8px;cursor:ew-resize;z-index:5;touch-action:none}
  .rf-resize:hover,.rf-resize:focus-visible{background:var(--rf-accent);opacity:.5;outline:none}
  #rf-panel.rf-full>.rf-resize{display:none}
  #rf-panel.rf-two>.rf-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 12px;align-content:start}
  #rf-panel.rf-two>.rf-list>:not(.rf-item){grid-column:1/-1}
  #rf-panel:not(.rf-full)>*{flex-shrink:0}
  #rf-panel:not(.rf-full)>.rf-head{position:sticky;top:0;z-index:4;background:var(--rf-bg)}
  #rf-panel:not(.rf-full)>.rf-controls{max-height:none;overflow:visible}
  #rf-panel:not(.rf-full)>.rf-controls>.rf-actions{position:static}
  #rf-panel:not(.rf-full)>.rf-list{flex:1 0 auto;overflow:visible}
  #rf-panel:not(.rf-full)>.rf-tabs{position:sticky;top:var(--rf-head-h,51px);z-index:4;background:var(--rf-bg)}
  #rf-panel:not(.rf-full)>.rf-status{position:sticky;top:calc(var(--rf-head-h,51px) + var(--rf-tabs-h,38px));z-index:3;background:var(--rf-bg)}
  #rf-panel:not(.rf-full) .rf-item{scroll-margin-top:calc(var(--rf-head-h,51px) + var(--rf-tabs-h,38px) + var(--rf-status-h,40px) + 4px)}
  /* Expanded: near full-screen. Filters become a left column and results a grid on the right. */
  @media (min-width:481px){ #rf-panel.rf-full{width:calc(100vw - 32px);max-width:1600px} }
  @media (min-width:760px){
    #rf-panel.rf-full{display:grid;grid-template-columns:minmax(340px,420px) minmax(0,1fr);
      grid-template-rows:auto auto auto auto auto auto auto auto minmax(0,1fr);
      grid-template-areas:"head head" "tabs status" "ctrl news" "ctrl partial" "ctrl warn" "ctrl share" "ctrl help" "ctrl active" "ctrl list"}
    .rf-full>.rf-head{grid-area:head} .rf-full>.rf-tabs{grid-area:tabs} .rf-full>.rf-sl-bar{grid-area:ctrl;align-self:stretch;align-content:flex-start} /* one of the two shows */
    .rf-full>.rf-controls{grid-area:ctrl;max-height:none;min-height:0;align-content:start;border-bottom:0;border-right:1px solid var(--rf-line)}
    .rf-full>.rf-help{grid-area:help} .rf-full>.rf-share-in{grid-area:share} .rf-full>.rf-warnbar{grid-area:warn}
    .rf-full>.rf-status{grid-area:status;display:flex;align-items:center} .rf-full>.rf-partial{grid-area:partial} .rf-full>.rf-news{grid-area:news} .rf-full>.rf-active{grid-area:active} .rf-full>.rf-list{grid-area:list;min-height:0}
    .rf-full>.rf-tabs,.rf-full>.rf-sl-bar{border-right:1px solid var(--rf-line)}
    .rf-full .rf-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(400px,1fr));align-content:start;gap:4px 12px;padding:8px 12px}
    .rf-full .rf-list>:not(.rf-item){grid-column:1/-1}
  }
  .rf-head{padding:14px 16px;border-bottom:1px solid var(--rf-line);display:flex;align-items:center;gap:8px}
  .rf-head h2{margin:0;font-size:14px;font-weight:650;flex:1;color:var(--rf-fg)}
  #rf-panel :focus-visible,#rf-launch:focus-visible{outline:2px solid var(--rf-accent-fg);outline-offset:2px}
  .rf-btn[aria-disabled=true]{opacity:.6;cursor:progress}
  .rf-n{font-weight:400;color:var(--rf-soft)}
  .rf-undo{margin-left:8px;border:0;background:none;padding:0;font:600 12px system-ui,sans-serif;color:var(--rf-accent-fg);
    text-decoration:underline;cursor:pointer}
  .rf-clear,.rf-tofilters{border:0;background:none;font:600 12px system-ui,sans-serif;color:var(--rf-accent-fg);cursor:pointer;padding:2px 6px}
  .rf-keys,.rf-expand{border:1px solid var(--rf-line);background:none;border-radius:999px;width:22px;height:22px;font:600 12px system-ui,sans-serif;
    color:var(--rf-muted);cursor:pointer;padding:0}
  .rf-help{padding:10px 16px;border-bottom:1px solid var(--rf-line);font-size:12px;background:var(--rf-hover)}
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
  .rf-sl-bar .rf-btn{flex:0 0 auto;padding:6px 11px;font-size:12px}
  .rf-note{margin:-2px 9px 8px 124px;padding:6px 8px;border-radius:6px;background:var(--rf-hover);font-size:12px;
    white-space:pre-wrap;overflow-wrap:anywhere}
  .rf-note-edit{display:block;width:calc(100% - 133px);margin:-2px 9px 8px 124px;min-height:54px;padding:6px 8px;
    border:1px solid var(--rf-input);border-radius:6px;font:12px/1.4 system-ui,sans-serif;background:var(--rf-bg);color:var(--rf-fg)}
  .rf-item{position:relative;content-visibility:auto;contain-intrinsic-size:auto 220px}
  .rf-item:has(details[open]),.rf-item:focus-within{content-visibility:visible} /* containment would clip the ⋯ menu */
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
  .rf-item[data-rv="1"]:not(.rf-starred) .rf-card{box-shadow:inset 3px 0 0 var(--rf-line)} /* reviewed: a quiet edge mark */
  /* Compact list: key facts only; the action row shows for the listing you point at or focus. */
  .rf-compact .rf-sec{display:none}
  .rf-compact .rf-card{grid-template-columns:64px 1fr;gap:9px;padding:6px 9px}
  .rf-compact .rf-card img,.rf-compact .rf-card>div:first-child:empty{width:64px;height:48px}
  .rf-compact .rf-item{contain-intrinsic-size:auto 96px}
  .rf-compact .rf-acts{margin-left:82px}
  @media (hover:hover){ .rf-compact .rf-item:not(:hover):not(:focus-within) .rf-acts{display:none} }
  .rf-full.rf-compact .rf-list{grid-template-columns:repeat(auto-fill,minmax(320px,1fr))}
  .rf-acts button{border:1px solid var(--rf-line);background:var(--rf-bg);color:var(--rf-fg);border-radius:6px;
    font:600 12px system-ui,sans-serif;padding:3px 7px;cursor:pointer}
  .rf-acts button[data-act=s][aria-pressed=true]{color:var(--rf-star-fg)}
  .rf-tag.rf-new{background:#087a50;color:#fff}
  .rf-tag.rf-gone{background:#6b6b75;color:#fff}
  .rf-tag.rf-taken{background:#b42318;color:#fff}
  .rf-was{font-weight:600;font-size:11px;padding:1px 5px;border-radius:4px}
  .rf-was.down{color:var(--rf-accent-fg);background:rgba(8,122,80,.12)}
  .rf-was.up{color:var(--rf-up);background:rgba(204,102,0,.12)}
  .rf-more-btn{display:block;width:calc(100% - 16px);margin:8px}
  .rf-warn{color:var(--rf-up);font-weight:600}
  .rf-score{font-weight:700;color:var(--rf-fg);cursor:help;border-bottom:1px dotted var(--rf-soft)}
  .rf-agencies{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
  .rf-agencies .rf-label{margin-right:4px}
  .rf-compare{overflow-x:auto;padding:4px}
  #rf-panel.rf-wide:not(.rf-full){width:min(960px,100vw)} /* Compare */
  .rf-btn.sec[aria-pressed=true]{background:var(--rf-accent);color:#fff}
  .rf-compare table{border-collapse:collapse;font-size:12px;min-width:100%}
  .rf-compare th,.rf-compare td{border-bottom:1px solid var(--rf-line);padding:6px 8px;text-align:left;vertical-align:top;min-width:110px}
  .rf-compare tbody th{color:var(--rf-muted);font-weight:600;white-space:nowrap;min-width:0;position:sticky;left:0;background:var(--rf-bg)}
  .rf-compare thead a{color:inherit;text-decoration:none;display:grid;gap:4px;font-weight:600}
  .rf-compare thead img{width:100%;height:64px;object-fit:cover;border-radius:6px}
  .rf-compare .rf-best{background:rgba(8,122,80,.12);color:var(--rf-accent-fg);font-weight:700}
  .rf-na{color:var(--rf-soft)}
  .rf-active{display:flex;flex-wrap:wrap;gap:6px;padding:8px 16px;border-bottom:1px solid var(--rf-line)}
  .rf-achip{font-size:11px;padding:3px 8px}
  .rf-achip span{color:var(--rf-soft);font-weight:400}
  .rf-preset{font:12px system-ui,sans-serif;padding:6px;border:1px solid var(--rf-input);border-radius:6px;background:var(--rf-bg);color:var(--rf-fg);width:100%}
  .rf-share-in{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 16px;background:var(--rf-hover);border-bottom:1px solid var(--rf-line)}
  .rf-share-in .rf-btn{flex:0 0 auto;padding:6px 11px;font-size:12px}
  .rf-share-msg{font-weight:600;margin-right:auto}
  .rf-plan{font:12px system-ui,sans-serif;padding:4px 6px;border:1px solid var(--rf-input);border-radius:6px;background:var(--rf-bg);color:var(--rf-fg)}
  .rf-planner{padding:8px 12px}
  .rf-peek{position:fixed;top:72px;z-index:6;pointer-events:none;padding:8px;border-radius:10px;background:var(--rf-bg);border:1px solid var(--rf-line);box-shadow:0 8px 32px rgba(0,0,0,.35)}
  .rf-peek img{display:block;width:100%;max-height:calc(100vh - 160px);object-fit:contain;border-radius:6px;background:var(--rf-tag)}
  .rf-peek-cap{padding:6px 2px 0;font-size:12px;color:var(--rf-fg)}
  .rf-peek.rf-peek-over{left:50%;right:auto;transform:translateX(-50%);width:min(800px,calc(100vw - 32px))}
  .rf-news{display:flex;gap:8px;align-items:flex-start;padding:8px 16px;font-size:12px;background:var(--rf-hover);border-bottom:1px solid var(--rf-line)}
  .rf-news-msg{flex:1}
  .rf-types{align-items:center} .rf-types-list{display:contents} .rf-types .rf-label{margin-right:4px}
  .rf-types .rf-chip[aria-pressed=true]{background:var(--rf-accent);color:#fff;border-color:var(--rf-accent)}
  .rf-sortdir{flex:none!important;padding:6px 10px!important;min-width:36px}
  .rf-partial{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px 16px;font-size:12px;background:var(--rf-hover);border-bottom:1px solid var(--rf-line)}
  .rf-partial .rf-btn{flex:none;padding:4px 12px}
  .rf-warnbar{display:flex;gap:8px;align-items:flex-start;padding:8px 16px;font-size:12px;color:var(--rf-err);background:var(--rf-hover);border-bottom:1px solid var(--rf-line)}
  .rf-warnbar .rf-warn-msg{flex:1}
  .rf-warn-x{border:0;background:none;color:inherit;font-size:16px;line-height:1;cursor:pointer;min-width:24px;min-height:24px}
  .rf-group,.rf-nudge{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:-2px 9px 8px 124px;font-size:12px}
  .rf-nudge{padding:6px 8px;border-radius:6px;background:var(--rf-hover)}
  @media (max-width:480px){ .rf-group,.rf-nudge{margin-left:9px} }
  .rf-checks{display:flex;flex-wrap:wrap;gap:4px;margin:6px 9px 0 124px}
  .rf-checks .rf-chip{font-size:11px;padding:2px 7px}
  .rf-checks .rf-chip[data-state=no]{text-decoration:none;background:transparent;color:var(--rf-err);border-color:var(--rf-err)}
  @media (max-width:480px){ .rf-checks{margin-left:9px} }
  .rf-weights{border:1px solid var(--rf-line);border-radius:8px;padding:6px 10px;margin:6px 0;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}
  .rf-weights legend{font-size:12px;color:var(--rf-muted);padding:0 4px}
  @media (max-width:480px){ .rf-weights{grid-template-columns:repeat(2,minmax(0,1fr))} }
  .rf-menu{position:relative}
  .rf-menu>summary{list-style:none;cursor:pointer}
  .rf-menu>summary::-webkit-details-marker{display:none}
  .rf-menu>summary::after{content:' ▾'}
  .rf-menu-list{position:absolute;right:0;top:calc(100% + 4px);z-index:5;display:grid;gap:4px;min-width:150px;padding:6px;
    background:var(--rf-bg);border:1px solid var(--rf-line);border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.18)}
  .rf-tags.rf-watch span{background:rgba(204,102,0,.16);color:var(--rf-fg)}
  .rf-storage{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
  /* Floating notes on REA's page: undo toast and saved-search reminder by the launcher, listing bar. */
  #rf-toast,#rf-remind,#rf-lbar{position:fixed;z-index:2147483000;display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:10px 12px;border-radius:10px;
    background:var(--rf-bg);color:var(--rf-fg);border:1px solid var(--rf-line);box-shadow:0 4px 18px rgba(0,0,0,.18);font:13px system-ui,sans-serif}
  #rf-toast{right:20px;bottom:72px;max-width:min(360px,calc(100vw - 32px))}
  #rf-toast button{font:600 12px system-ui,sans-serif;padding:4px 8px;border-radius:6px;border:1px solid var(--rf-line);background:var(--rf-bg);color:var(--rf-fg);cursor:pointer}
  #rf-remind{right:20px;bottom:72px;gap:8px;max-width:min(340px,calc(100vw - 32px))}
  #rf-lbar{left:16px;bottom:16px;padding:8px;max-width:min(420px,calc(100vw - 32px))}
  #rf-lbar button,#rf-lbar select{font:600 13px system-ui,sans-serif;padding:6px 10px;border-radius:6px;border:1px solid var(--rf-line);background:var(--rf-sec);color:var(--rf-fg);cursor:pointer}
  #rf-lbar button[aria-pressed=true]{background:var(--rf-accent);border-color:var(--rf-accent);color:#fff}
  #rf-lbar button:focus-visible,#rf-lbar select:focus-visible{outline:2px solid var(--rf-accent);outline-offset:2px}
  .rf-lbar-note,.rf-lbar-info{flex:1 1 100%;font-size:12px;color:var(--rf-muted);white-space:pre-wrap;overflow-wrap:anywhere}
  .rf-warn-t{color:var(--rf-err)}
  .rf-saved-list{list-style:none;margin:6px 0;padding:0;display:grid;gap:6px;font-size:13px}
  .rf-saved-list a{color:inherit;font-weight:600}
  .rf-saved-list .rf-pin{margin-left:6px;font-size:11px;padding:1px 8px}
  .rf-saved-list .rf-pin[aria-pressed=true]{background:var(--rf-accent);color:#fff;border-color:var(--rf-accent)}
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
  .rf-planner li.rf-clash .rf-meta,.rf-planner li.rf-tight .rf-meta{color:var(--rf-up);font-weight:600}
  .rf-planner li.rf-off-route>a,.rf-planner li.rf-off-route>.rf-plan-t{opacity:.6}
  .rf-plan-route{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;margin:6px 0 8px;font-size:13px}
  .rf-plan-route>span{flex:1 1 200px}.rf-plan-route .rf-btn{flex:none}
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
  .rf-med.up{color:var(--rf-up)}
  .rf-app{display:flex;align-items:center;gap:6px;margin:-2px 9px 8px 124px;font-size:12px;color:var(--rf-muted)}
  .rf-app select{font:12px system-ui,sans-serif;padding:3px 6px;border:1px solid var(--rf-input);border-radius:6px;background:var(--rf-bg);color:var(--rf-fg)}
  .rf-sl-q{font:12px system-ui,sans-serif;padding:4px 6px;border:1px solid var(--rf-input);border-radius:6px;background:var(--rf-bg);color:var(--rf-fg);width:130px}
  .rf-sl-filter{font:12px system-ui,sans-serif;padding:4px 6px;border:1px solid var(--rf-input);border-radius:6px;background:var(--rf-bg);color:var(--rf-fg)}
  .rf-empty{padding:28px 16px;text-align:center;color:var(--rf-soft)}
  [data-rf-id][data-rf-pos]{position:relative}
  [data-rf-id][data-rf-match="0"]{opacity:.35;transition:opacity .15s}
  [data-rf-id][data-rf-match="0"]:hover{opacity:1}
  /* On REA's cards: its own CSS (which may load after ours) mustn't size or pad our tags: reset, then !important. */
  .rf-badge,.rf-badge *{all:unset!important;box-sizing:border-box!important}
  .rf-badge{position:absolute!important;top:10px!important;left:10px!important;right:10px!important;z-index:5!important;display:flex!important;gap:4px!important;flex-wrap:wrap!important;align-items:center!important;pointer-events:none!important;
    font:600 11px/1.2 system-ui,-apple-system,sans-serif!important;color:#fff!important;text-align:left!important}
  .rf-badge>span{display:inline-block!important;padding:4px 8px!important;border-radius:999px!important;background:rgba(0,0,0,.78)!important;color:#fff!important;white-space:nowrap!important}
  .rf-badge .rf-b-pets{background:#7c3aed!important}
  .rf-badge>.rf-card-acts{display:inline-flex!important;gap:4px!important;margin-left:auto!important;padding:0!important;background:none!important;border-radius:0!important;pointer-events:auto!important}
  .rf-badge .rf-card-acts button{display:inline-block!important;pointer-events:auto!important;border-radius:999px!important;padding:4px 9px!important;cursor:pointer!important;
    font:600 11px/1.2 system-ui,-apple-system,sans-serif!important;background:rgba(255,255,255,.95)!important;color:#111!important;box-shadow:0 1px 3px rgba(0,0,0,.3)!important}
  .rf-badge .rf-card-acts button:hover{background:#fff!important}
  .rf-badge .rf-card-acts button[aria-pressed=true]{background:#e6a700!important}
  /* Windows High Contrast drops backgrounds: pressed chips and buttons use system colours instead. */
  @media (forced-colors: active){
    #rf-panel [aria-pressed=true],#rf-lbar [aria-pressed=true],.rf-badge [aria-pressed=true]{forced-color-adjust:none;background:Highlight!important;color:HighlightText!important;border:1px solid Highlight!important}
    #rf-panel :focus-visible,#rf-lbar :focus-visible,.rf-badge :focus-visible{outline:2px solid Highlight!important;outline-offset:1px}
    #rf-launch{border:1px solid ButtonText}
  }
  .rf-badge .rf-card-acts button:focus-visible{outline:2px solid #087a50!important;outline-offset:1px!important}
  .rf-badge .rf-b-now{background:#087a50!important}
  .rf-badge .rf-b-none{background:rgba(90,90,90,.85)!important}
  .rf-badge .rf-b-star{background:#e6a700!important;color:#111!important}
  .rf-badge .rf-b-new{background:#2563eb!important}
  .rf-badge .rf-b-taken{background:#b42318!important}
  .rf-badge .rf-b-down{background:#087a50!important}
  .rf-badge .rf-b-up{background:#a84f00!important}
  @media (max-width:480px){ #rf-launch{right:12px;bottom:12px} .rf-grid3{grid-template-columns:repeat(2,1fr)}
    .rf-dates{grid-template-columns:1fr 1fr} .rf-dates>label:last-child{grid-column:1/-1} .rf-controls{max-height:48vh}
    .rf-actions{flex-wrap:wrap} .rf-actions .rf-bulk{flex:1 1 100%}
    .rf-acts,.rf-note,.rf-note-edit,.rf-app{margin-left:9px} .rf-note-edit{width:calc(100% - 18px)}
    .rf-card{grid-template-columns:88px 1fr} .rf-card img{width:88px;height:66px}
    .rf-controls .rf-row{flex-wrap:wrap} .rf-controls .rf-sort{flex:1 1 100%}
    .rf-x,.rf-keys,.rf-clear,.rf-acts button,.rf-acts-more summary{min-height:32px;min-width:32px} .rf-expand,.rf-resize{display:none} }
  @media (max-height:600px){ .rf-controls{max-height:38vh} } /* short windows / zoomed in: keep room for the list */
  .rf-btn{white-space:nowrap}
  `;

  const EMPTY_INTRO = 'Set your dates, then search.<br>Every result page is merged and sorted by availability.';
  // What scrolls the results: the list itself when expanded, else the whole drawer.
  // A listing (or a control inside it) found again after a re-render, by id.
  const itemEl = (id, inner = '') => ui.list.querySelector(`.rf-item[data-id="${CSS.escape(id)}"]${inner ? ` ${inner}` : ''}`);
  const listScroller = () => (ui.panel.classList.contains('rf-full') ? ui.list : ui.panel);
  // New results start at their top; in the side drawer only scroll up if the list's top has
  // gone above the header (a filter change near the top of the drawer stays put).
  const toListTop = () => {
    if (ui.panel.classList.contains('rf-full')) { ui.list.scrollTop = 0; return; }
    // Header and tabs stick, then the (sticky) status line; the Resume notice and filter chips sit
    // between it and the list. The list isn't sticky, so its offsetTop is its real place.
    const head = ui.panel.querySelector('.rf-head').offsetHeight + ui.panel.querySelector('.rf-tabs').offsetHeight;
    const between = [ui.partial, ui.active].filter((el) => el && !el.hidden).reduce((n, el) => n + el.offsetHeight, 0);
    if (ui.list.getBoundingClientRect().top < ui.status.getBoundingClientRect().bottom + between) {
      ui.panel.scrollTop = Math.max(0, ui.list.offsetTop - between - ui.status.offsetHeight - head);
    }
  };
  const setEmpty = (html) => { ui.list.innerHTML = `<div class="rf-empty">${html}</div>`; };
  const setLaunchCount = (n) => {
    ui.launchN = n;
    const star = marks.counts().starred;
    ui.launch.textContent = `Availability Filter${n == null ? '' : ` (${n})`}${star ? ` · ★${star}` : ''}`;
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

  // The drawer's markup. Only module constants go in, so it is built once and wired up by build().
  const panelHtml = () => `
    <div class="rf-resize" role="separator" aria-orientation="vertical" aria-label="Drawer width: drag, or use the left and right arrow keys" tabindex="0" aria-valuemin="${DRAWER_MIN}" aria-valuemax="${DRAWER_MAX}"></div>
    <div class="rf-head">
      <h2>Availability Filter</h2>
      <button type="button" class="rf-tofilters" hidden title="Back up to the filters (f)">↑ Filters</button>
      <button class="rf-clear" title="Reset all filters">Clear</button>
      <button class="rf-expand" title="Expand to near full screen (e)" aria-label="Expand drawer" aria-pressed="false">⤢</button>
      <button class="rf-keys" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" aria-expanded="false" aria-controls="rf-help">?</button>
      <button class="rf-x" title="Close (Esc)" aria-label="Close">&times;</button>
    </div>
    <div class="rf-tabs" role="tablist">
      <button role="tab" id="rf-tab-results" data-view="results" aria-selected="true" aria-controls="rf-list">Results</button>
      <button role="tab" id="rf-tab-shortlist" data-view="shortlist" aria-selected="false" aria-controls="rf-list" tabindex="-1">Shortlist <span class="rf-count"></span></button>
    </div>
    <div class="rf-sl-bar" hidden>
      <span class="rf-label">Shortlist, all searches</span>
      <select class="rf-sl-bulk" aria-label="Bulk action on the shortlist shown">
        <option value="">Bulk…</option>${APP_STATUSES.filter(Boolean).map((v) => `<option value="status:${v}" data-label="Mark {n} shown: ${v}">Mark shown: ${v}</option>`).join('')}
        <option value="unstar-declined" data-label="Remove declined">Remove declined</option><option value="unstar" data-label="Remove all {n} shown">Remove all shown</option>
      </select>
      <select class="rf-plan" aria-label="Plan an inspection day"></select>
      <input type="search" class="rf-sl-q" placeholder="Search shortlist" aria-label="Search the shortlist by address, note, agency or suburb">
      <select class="rf-sl-filter" aria-label="Filter shortlist by application status">
        <option value="">All</option>${APP_STATUSES.filter(Boolean).map((v) => `<option value="${v}">${statusLabel(v)}</option>`).join('')}
        <option value="-">Not started</option><option value="!">Needs action</option>
      </select>
      <button class="rf-btn sec" data-sl="compare" aria-pressed="false" title="Side-by-side table of up to ${COMPARE_MAX}">Compare</button>
      <button class="rf-btn sec" data-sl="recheck" title="Fetch each shortlisted listing's page for current price, availability and inspections">Re-check</button>
      <details class="rf-menu"><summary class="rf-btn sec" title="Export, share, print, backup">More</summary><div class="rf-menu-list">
        <button class="rf-btn sec" data-export="csv" title="Download the shortlist as CSV">CSV</button>
        <button class="rf-btn sec" data-export="ics" title="Shortlisted inspections as a calendar file">Calendar</button>
        <button class="rf-btn sec" data-sl="share" title="Copy a link that shares these listings (no server involved)">Share link</button>
        <button class="rf-btn sec" data-sl="print" title="Printable shortlist (or Save as PDF)">Print</button>
        <button class="rf-btn sec" data-sl="backup" title="Download shortlist, hidden listings, notes and remembered searches as JSON">Backup</button>
        <button class="rf-btn sec" data-sl="restore" title="Merge a backup file">Restore</button>
      </div></details>
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
          <label title="Internal floor area, from REA's details or the listing text; listings that don't say are left out">Min m²<input type="number" min="0" max="2000" step="5" id="rf-sizeMin" inputmode="numeric"></label>
        </div>
        <div class="rf-amen rf-types" role="group" aria-label="Property type: pick any number (none picked means any)">
          <span class="rf-label">Type</span><input type="hidden" id="rf-type"><span class="rf-types-list"><span class="rf-meta">Search to see the types</span></span>
        </div>
        <div class="rf-amen rf-amen-req" role="group" aria-label="Amenities: click to require, again to exclude, again to clear">
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
        <div class="rf-grid3">
          <label>Lease at least<select id="rf-leaseMin"><option value="">Any</option><option value="6">6 months</option><option value="12">12 months</option><option value="24">24 months</option></select></label>
        </div>
        <label class="rf-check" title="Several units in one building: keep the cheapest"><input type="checkbox" id="rf-onePerBuilding">One listing per building</label>
        <input type="hidden" id="rf-building">
        <label>Other places (optional, one per line)<textarea id="rf-places" rows="2" placeholder="Work: -33.87, 151.21&#10;Uni: Google Maps link"
          title="Up to ${PLACES_MAX}. Straight-line km to each shows on listings; sort by 'Nearest to all places'."></textarea></label>
        <div class="rf-meta rf-places-fb" aria-live="polite"></div>
        <label>Keywords<input type="text" id="rf-keyword" placeholder='eg pool|balcony -studio "north facing"' title="All words must appear; -word must not; a|b means either; accents don't matter"></label>
        <label>Inspection on<input type="date" id="rf-inspectOn"></label>
        <label title="Keeps listings with at least one upcoming inspection you can get to, in the listing's local time">Inspections I can make<select id="rf-inspectWhen">
          <option value="">Any time</option><option value="weekend">Weekends</option><option value="evening">After 5pm</option><option value="either">Weekends or after 5pm</option></select></label>
        <label class="rf-check" title="Listed over 3 weeks ago: rent may be negotiable"><input type="checkbox" id="rf-staleOnly">Only listed 3+ weeks ago (may negotiate)</label>
        <label class="rf-check"><input type="checkbox" id="rf-hideNoImage">Has a photo</label>
        <label class="rf-check" title="Deposit taken, under application or leased, going by the headline and description"><input type="checkbox" id="rf-hideTaken">Hide listings already taken</label>
        <label class="rf-check"><input type="checkbox" id="rf-newOnly">New since last visit only</label>
        <label class="rf-check"><input type="checkbox" id="rf-changedOnly">Price, date or details changed recently</label>
        <label class="rf-check"><input type="checkbox" id="rf-unopenedOnly">Not opened yet</label>
        <label class="rf-check" title="Listings you haven't gone past with j, marked with r, shortlisted, hidden or noted"><input type="checkbox" id="rf-unreviewedOnly">Not reviewed yet</label>
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
        <label class="rf-check" title="Small photos and the key facts only, so about twice as many listings fit on screen (d)"><input type="checkbox" id="rf-compact">Compact list</label>
        <label>Theme<select id="rf-theme"><option value="">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
        <label class="rf-check"><input type="checkbox" id="rf-remember">Remember results between visits</label>
        <label class="rf-check"><input type="checkbox" id="rf-remindSaved">Remind me to check saved searches (at most daily)</label>
        <div class="rf-meta rf-storage"><span class="rf-storage-n"></span>
          <button type="button" class="rf-btn sec" data-forget title="Remove everything this script stored in this browser (not REA's own data)">Delete all my data</button></div>
        <fieldset class="rf-weights"><legend>Best match: how much each counts</legend>
          ${[['wRent', 'Rent'], ['wTiming', 'Timing'], ['wDist', 'Distance'], ['wMovein', 'Move-in']].map(([id, label]) => `<label>${label}<select id="rf-${id}">
            <option value="0">Ignore</option><option value="1">Less</option><option value="2">Normal</option><option value="3">More</option></select></label>`).join('')}
        </fieldset>
        <label title="Some calendar apps ignore reminders in imported files">Calendar reminder<select id="rf-icsAlarm">
          ${[['0', 'None'], ['30', '30 min before'], ['60', '1 hour before'], ['120', '2 hours before']].map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
        <label>My current lease ends (optional)<input type="date" id="rf-leaseEnd" title="Shows the overlap you'd pay, or the gap you'd need to cover, for each listing; sort by Least overlap"></label>
        <label>Inspection checklist (comma-separated)<input type="text" id="rf-checklist" maxlength="400" placeholder="${esc(CHECKLIST_DEFAULT)}"></label>
        <label>Enquiry message (Copy enquiry)<textarea id="rf-enquiry" rows="3" maxlength="600" placeholder="${esc(ENQUIRY_DEFAULT)}"
          title="Placeholders: {address} {price} {available} {inspection} {link}. Keep personal details out: this is stored in your browser on REA's site."></textarea></label>
        <label>Household income, $ a year before tax (optional)<input type="number" id="rf-income" min="0" step="1000" inputmode="numeric" placeholder="eg 120000"
          title="Shows rent as a share of income (over ${RENT_STRESS_PCT}% is flagged) and sets Best match's budget when no max rent is set. Stays in this browser."></label>
      </details>
      <details class="rf-more rf-saved" hidden>
        <summary>Saved searches</summary>
        <ul class="rf-saved-list"></ul>
        <button type="button" class="rf-btn sec" data-saved-check title="Fetch each remembered search (one page at a time) and count what's new">Check all for new listings</button>
      </details>
      <div class="rf-row">
        <select class="rf-preset" aria-label="Filter presets"></select>
      </div>
      <div class="rf-row">
        <label class="rf-check"><input type="checkbox" id="rf-exact">Hide surrounding suburbs</label>
        <label class="rf-sort">Sort<select id="rf-sort">
          <option value="avail">Available date</option>
          <option value="price">Price</option>
          <option value="ppb">Price per bed</option>
          <option value="ppsqm">Price per m²</option>
          <option value="beds">Most beds</option>
          <option value="inspect">Next inspection</option>
          <option value="listed">Newest first</option>
          <option value="value">Best value vs median</option>
          <option value="distance">Nearest</option>
          <option value="allnear">Nearest to all places</option>
          <option value="fit">Least overlap with my lease</option>
          <option value="match">Best match</option>
        </select></label>
        <input type="checkbox" id="rf-sortDesc" hidden><button type="button" class="rf-btn sec rf-sortdir" aria-pressed="false" aria-label="Reverse the sort order" title="Reverse the sort order (unknown values stay last)">⇅</button>
      </div>
      <div class="rf-actions">
        <button class="rf-btn" id="rf-run">Search all pages</button>
        <button class="rf-btn sec" id="rf-refresh" title="Ignore cached results and refetch" hidden>Refresh</button>
        <select class="rf-bulk" aria-label="Bulk action on the listings shown" disabled>
          <option value="">Bulk…</option><option value="star" data-label="Shortlist all {n} shown">Shortlist all shown</option><option value="hide" data-label="Hide all {n} shown">Hide all shown</option><option value="reviewed" data-label="Mark all {n} shown reviewed">Mark all shown reviewed</option>
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
    <div class="rf-help" id="rf-help" hidden>
      <strong>Keyboard</strong>
      <dl><dt>j / ↓, k / ↑</dt><dd>next / previous listing</dd><dt>s</dt><dd>shortlist</dd><dt>h</dt><dd>hide</dd>
      <dt>n</dt><dd>note</dd><dt>c</dt><dd>copy summary</dd><dt>m</dt><dd>market view on/off</dd><dt>x</dt><dd>tick for Compare (shortlist)</dd><dt>1–5</dt><dd>application status (shortlisted)</dd><dt>u</dt><dd>undo</dd><dt>r</dt><dd>mark reviewed and move on (j also marks the one you leave)</dd><dt>g / G, Home / End</dt><dd>first / last listing</dd><dt>PgUp / PgDn</dt><dd>5 up / down</dd><dt>t</dt><dd>Results / Shortlist</dd><dt>o / Enter</dt><dd>open listing</dd><dt>p / Space</dt><dd>large photo (j / k flip through)</dd><dt>/</dt><dd>keyword filter (shortlist: search)</dd>
      <dt>e</dt><dd>expand / shrink the drawer</dd><dt>f</dt><dd>back to the filters</dd><dt>d</dt><dd>compact list on/off</dd><dt>?</dt><dd>this help</dd><dt>Esc</dt><dd>close</dd><dt>Alt+Shift+F</dt><dd>open / close from anywhere on REA</dd></dl>
    </div>
    <div class="rf-share-in" hidden role="region" aria-label="Shared listings">
      <span class="rf-share-msg"></span>
      <button class="rf-btn" data-share="add">Add to my shortlist</button>
      <button class="rf-btn sec" data-share="dismiss">Dismiss</button>
    </div>
    <div class="rf-warnbar" role="alert" hidden><span class="rf-warn-msg"></span><button type="button" class="rf-warn-x" aria-label="Dismiss warning">×</button></div>
    <div class="rf-peek" hidden role="dialog" aria-label="Photo"><img alt=""><div class="rf-peek-cap"></div></div>
    <div class="rf-news" hidden role="note"><span class="rf-news-msg"></span><button type="button" class="rf-warn-x" aria-label="Dismiss what's new">×</button></div>
    <div class="rf-status" role="status" aria-live="polite"></div>
    <div class="rf-partial" hidden><span class="rf-partial-msg"></span> <button type="button" class="rf-btn sec" data-resume>Resume</button></div>
    <div class="rf-active" hidden aria-label="Active filters"></div>
    <div class="rf-list" id="rf-list" role="tabpanel" aria-labelledby="rf-tab-results"><div class="rf-empty">${EMPTY_INTRO}</div></div>`;

  // Wiring kept out of build(): each only needs the panel (and the phone media query).
  function wireResize(panel, narrow) {
  // Side drawer width: dragged from its left edge (or arrow keys on the handle), remembered;
  // wide enough and results go two per row. Expanded mode and phones ignore it.
  const widthKey = keyStore(storageOr('localStorage'), WIDTH_KEY), handle = panel.querySelector('.rf-resize');
  const clampW = (w) => Math.round(Math.max(DRAWER_MIN, Math.min(DRAWER_MAX, window.innerWidth - 40, w)));
  ui.applyWidth = (w = +widthKey.get() || 0) => {
    const side = !panel.classList.contains('rf-full') && !narrow.matches;
    panel.style.width = side && w ? `${clampW(w)}px` : '';
    panel.classList.toggle('rf-two', side && panel.offsetWidth >= DRAWER_TWO_COL);
    handle.setAttribute('aria-valuenow', String(Math.round(panel.offsetWidth)));
    handle.style.left = `${Math.round(window.innerWidth - panel.offsetWidth) - 4}px`; // on the drawer's left edge
  };
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const move = (ev) => ui.applyWidth(window.innerWidth - ev.clientX);
    const up = () => { handle.removeEventListener('pointermove', move); widthKey.set(String(Math.round(panel.offsetWidth))); ui.watchMore?.(); };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up, { once: true });
  });
  handle.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const w = clampW(panel.offsetWidth + (e.key === 'ArrowLeft' ? 40 : -40));
    widthKey.set(String(w));
    ui.applyWidth(w);
  });
  window.addEventListener('resize', () => ui.applyWidth());
  }

  function wirePeek(panel) {
  // Photo peek: beside the side drawer when there's room, else over it; hovering a thumbnail
  // for a moment shows it too.
  const peek = panel.querySelector('.rf-peek'), peekImg = peek.querySelector('img'), peekCap = peek.querySelector('.rf-peek-cap');
  let peekHover = false, hoverTimer = null;
  ui.showPeek = (item) => {
    const r = item && rowOf(item.dataset.id);
    if (!r?.img) { ui.closePeek(); return; }
    peekImg.onerror = () => { peekImg.onerror = null; peekImg.src = r.img; }; // that size may not exist
    peekImg.src = bigImg(r.img);
    peekCap.textContent = [r.price, r.address, r.available && r.available !== '-' ? r.available : ''].filter(Boolean).join(' · ');
    const room = window.innerWidth - panel.offsetWidth - 32;
    peek.classList.toggle('rf-peek-over', panel.classList.contains('rf-full') || room < 320);
    peek.style.right = peek.classList.contains('rf-peek-over') ? '' : `${panel.offsetWidth + 16}px`;
    peek.style.width = peek.classList.contains('rf-peek-over') ? '' : `${Math.min(800, room)}px`;
    peek.hidden = false;
    ui.peekId = r.id;
  };
  ui.closePeek = () => { clearTimeout(hoverTimer); peek.hidden = true; ui.peekId = null; peekHover = false; };
  ui.list.addEventListener('mouseover', (e) => {
    const img = e.target.closest('.rf-card img');
    if (!img || ui.peekId) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => { ui.showPeek(img.closest('.rf-item')); peekHover = true; }, 400);
  });
  ui.list.addEventListener('mouseout', (e) => {
    if (!e.target.closest('.rf-card img')) return;
    clearTimeout(hoverTimer);
    if (peekHover) ui.closePeek();
  });
  }

  // Keyboard: list keys (j/k, s, h, r, p, 1-5…) and drawer keys (Esc, ?, e, f, t, d, m, /), plus
  // the focus trap on phones. Needs the drawer pieces build() made.
  function wireKeys(panel, { launch, narrow, help, toggleHelp, setOpen, expandBtn }) {
  const typing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  // List shortcuts: act on the focused listing (or the first one).
  // Reviewed: stored at once, shown on the item without a re-render (so a "Not reviewed" list
  // doesn't jump under you); counts and the filter catch up on the next render.
  const markReviewed = (item, on = true) => {
    const id = item.dataset.id;
    marks.setReviewed([id], on);
    const r = rowOf(id);
    if (r) r.reviewedAt = on ? new Date() : null;
    item.dataset.rv = on ? '1' : '';
  };
  const listKeys = (e) => {
    const items = [...ui.list.querySelectorAll('.rf-item')];
    if (!items.length) return false;
    const cur = document.activeElement?.closest?.('.rf-item');
    const i = cur ? items.indexOf(cur) : -1;
    const move = (d) => { const n = items[Math.max(0, Math.min(items.length - 1, i + d))] || items[0]; n.focus(); n.scrollIntoView({ block: 'nearest' }); if (ui.peekId) ui.showPeek(n); };
    const act = (a) => (cur || items[0]).querySelector(`[data-act="${a}"]`)?.click();
    switch (e.key) {
      case 'j': case 'ArrowDown': if (cur && e.key === 'j' && ui.view !== 'shortlist') markReviewed(cur); move(i < 0 ? 0 : 1); return true;
      case 'r': { const it = cur || items[0]; markReviewed(it, !rowOf(it.dataset.id)?.reviewedAt || it.dataset.rv !== '1'); move(i < 0 ? 0 : 1); return true; }
      case 'k': case 'ArrowUp': move(i < 0 ? 0 : -1); return true;
      case 's': act('s'); return true;
      case 'h': act('h'); return true;
      case 'n': act('n'); return true;
      case 'c': act('copy'); return true;
      case 'x': { const box = (cur || items[0]).querySelector('input[data-cmp]'); box?.click(); return !!box; }
      case 'PageDown': move(i < 0 ? 0 : 5); return true;
      case 'PageUp': move(i < 0 ? 0 : -5); return true;
      case 'g': case 'Home': items[0].focus(); items[0].scrollIntoView({ block: 'nearest' }); return true;
      case 'G': case 'End': { // the rest render first (capped), then the last listing
        for (let n = 0; n < 20 && ui.list.querySelector(':scope > .rf-more-btn'); n++) renderMore();
        const all = ui.list.querySelectorAll('.rf-item'), last = all[all.length - 1];
        last.focus(); last.scrollIntoView({ block: 'nearest' }); return true;
      }
      case '1': case '2': case '3': case '4': case '5': { // application status of a shortlisted listing
        const it = cur || items[0], sel = it.querySelector('select[data-app]');
        if (!sel) return false;
        sel.value = APP_STATUSES[+e.key];
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        itemEl(it.dataset.id)?.focus(); // after the re-render
        return true;
      }
      // Space on a button inside the listing presses the button; on the listing itself it's the photo.
      case 'p': case ' ': if (e.key === ' ' && document.activeElement !== cur) return false; if (ui.peekId) ui.closePeek(); else ui.showPeek(cur || items[0]); return true;
      case 'u': { const undo = ui.status.querySelector('.rf-undo'); if (!undo || undo.textContent !== 'Undo') return false; undo.click(); return true; }
      // Enter opens only when the item itself is focused; on a button it presses the button.
      case 'o': case 'Enter': if (!cur || (e.key === 'Enter' && document.activeElement !== cur)) return false; cur.querySelector('.rf-card')?.click(); return true;
      default: return false;
    }
  };
  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && (e.key === 'F' || e.key === 'f' || e.code === 'KeyF') && isSearchPage(location.href) && !typing(e.target)) {
      e.preventDefault();
      setOpen(panel.hidden);
      if (!panel.hidden) { if (!ui.placedNow) ui.run.focus(); } else launch.focus();
      return;
    }
    if (panel.hidden) return;
    // Esc is ours only when focus is in the drawer (or it's full-screen): REA's own viewers use it too.
    if (e.key === 'Escape' && ui.peekId) { ui.closePeek(); return; } // closes just the photo
    const menu = document.activeElement?.closest?.('.rf-acts-more[open], .rf-menu[open]');
    if (e.key === 'Escape' && menu && panel.contains(menu)) { menu.open = false; menu.querySelector('summary').focus(); return; } // closes just the ⋯ menu
    if (e.key === 'Escape' && !e.defaultPrevented && (panel.contains(document.activeElement) || narrow.matches)) {
      if (!help.hidden) { toggleHelp(); return; }
      setOpen(false); launch.focus(); return;
    }
    const inPanel = panel.contains(document.activeElement);
    if (inPanel && !typing(document.activeElement) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (e.key === '?') { e.preventDefault(); toggleHelp(); return; }
      if (e.key === 'e' && !narrow.matches) { e.preventDefault(); expandBtn.click(); return; }
      if (e.key === 'f') { e.preventDefault(); ui.toFilters(); return; }
      if (e.key === 't') { e.preventDefault(); const other = panel.querySelector(`.rf-tabs [data-view="${ui.view === 'shortlist' ? 'results' : 'shortlist'}"]`); other.click(); other.focus(); return; }
      if (e.key === 'd') { // re-renders, so focus goes back to the same listing
        e.preventDefault();
        const at = document.activeElement.closest?.('.rf-item')?.dataset.id, c = panel.querySelector('#rf-compact');
        c.checked = !c.checked;
        c.dispatchEvent(new Event('change', { bubbles: true }));
        if (at) itemEl(at)?.focus();
        return;
      }
      if (e.key === 'm' && ui.view !== 'shortlist' && !ui.market.disabled) { e.preventDefault(); ui.market.click(); ui.market.focus(); return; }
      if (e.key === '/' && ui.view === 'shortlist') { e.preventDefault(); ui.slQuery.focus(); return; }
      if (e.key === '/' && ui.view !== 'shortlist') { e.preventDefault(); ui.more.open = true; panel.querySelector('#rf-keyword').focus(); return; }
      if (!document.activeElement.closest('button, a, summary') || document.activeElement.closest('.rf-item')) {
        if (listKeys(e)) { e.preventDefault(); return; }
      }
    }
    if (e.key === 'Tab' && narrow.matches) {
      const f = [...panel.querySelectorAll('button,input,select,textarea,a[href],summary')].filter((el) => el.offsetParent && !el.disabled &&
        !el.closest('details:not([open]) > :not(summary)') && (el.checkVisibility?.({ contentVisibilityAuto: true }) ?? true));
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  });
  }

  // Clicks inside a listing (shortlist, hide, note, status, checklist, ⋯ menu…), delegated from the
  // list. `write`/`onChange` put a setting into the form and apply it (building, anchor, places).
  function wireList(panel, { write, onChange }) {
  ui.list.addEventListener('click', (e) => {
    if (e.target.closest('.rf-more-btn')) return renderMore();
    const ck = e.target.closest('[data-ck]');
    if (ck) {
      const id = ck.closest('.rf-item').dataset.id, label = ck.dataset.ck;
      marks.cycleCheck(id, label);
      refreshMarks();
      itemEl(id, `[data-ck="${CSS.escape(label)}"]`)?.focus();
      return;
    }
    const drop = e.target.closest('[data-drop-chip]');
    if (drop) return ui.active.querySelector(`[data-chip="${drop.dataset.dropChip}"]`)?.click();
    const na = e.target.closest('[data-na]');
    if (na) { // after-inspection prompt
      const id = na.closest('.rf-item').dataset.id;
      if (na.dataset.na === 'yes') marks.setStatus(id, 'inspected');
      else if (na.dataset.na === 'applied') marks.setStatus(id, 'applied');
      else marks.answerInspect(id);
      refreshMarks();
      setStatus(na.dataset.na === 'no' ? 'Noted.' : `Marked ${na.dataset.na === 'yes' ? 'inspected: tick the checklist while it\'s fresh' : 'applied'}.`);
      return;
    }
    const bldg = e.target.closest('[data-act=bldg]');
    if (bldg) { // same building: keyword on the street address (the listing text includes it)
      const r = rowById(bldg.closest('.rf-item').dataset.id);
      if (!r?.buildingAddr) return;
      write(panel.querySelector('#rf-building'), `${buildingKey(r.address)}|${r.buildingAddr}`);
      onChange({ type: 'change' });
      return setStatus(`Showing ${plural(ui.rows?.length ?? r.buildingN, 'listing')} at ${r.buildingAddr}. Remove the Building chip to go back.`);
    }
    const b = e.target.closest('.rf-acts button');
    if (!b) return;
    const id = b.closest('.rf-item')?.dataset.id;
    if (!id) return;
    if (b.dataset.act === 'n') return editNote(b.closest('.rf-item'));
    if (b.dataset.act === 'anchor' || b.dataset.act === 'place') {
      const r = rowOf(id);
      if (r?.lat == null) return;
      const at = `${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}`;
      let msg = `Measuring from ${r.address}.`;
      if (b.dataset.act === 'anchor') write(panel.querySelector('#rf-anchor'), at);
      else {
        const lines = String(cfg.places || '').split('\n').filter((l) => l.trim());
        if (parsePlaces(cfg.places).some((p) => Math.abs(p.lat - r.lat) < 1e-4 && Math.abs(p.lng - r.lng) < 1e-4)) return setStatus('Already in Other places.');
        if (lines.length >= PLACES_MAX) return setStatus(`Other places holds ${PLACES_MAX}; remove one first.`, true);
        write(panel.querySelector('#rf-places'), [...lines, `${clip(String(r.address).split(',')[0], 24).replace(/:/g, '')}: ${at}`].join('\n'));
        msg = 'Added to Other places (under More filters).';
        ui.paintPlaces();
      }
      onChange({ type: 'change' });
      return setStatus(msg);
    }
    if (b.dataset.act === 'why') { marks.setHideReason(id, b.dataset.r); refreshMarks(); return setStatus(`Hide reason: ${b.dataset.r}.`); }
    if (b.dataset.act === 'h' && rowOf(id)?.resurfaced) { marks.rehide(id); refreshMarks(); return setStatus('Hidden again; it comes back if the rent drops further.'); }
    if (b.dataset.act === 'ics') { const r = rowOf(id); if (r) downloadIcs([r]); return; }
    if (b.dataset.act === 'enq') {
      const r = rowOf(id);
      if (r) copyText(enquiryText(r, cfg.enquiry)).then((ok) => setStatus(ok ? 'Enquiry copied: paste it into the agent\'s contact form.' : 'Clipboard blocked.', !ok));
      return;
    }
    if (b.dataset.act === 'copy') {
      const r = rowOf(id);
      if (r) copyText(summaryText(r)).then((ok) => setStatus(ok ? 'Listing summary copied.' : 'Clipboard blocked.', !ok));
      return;
    }
    const bulk = BULK_HIDE[b.dataset.act];
    if (bulk) { // hide a whole suburb or agency
      const [field, toggle, prep] = bulk, name = rowOf(id)?.[field];
      if (!name) return;
      const on = toggle(name);
      refreshMarks();
      ui.list.focus();
      return offerUndo(on ? `Hidden all listings ${prep} ${name}.` : `Showing ${name} again.`, () => { toggle(name); refreshMarks(); });
    }
    const act = b.dataset.act;
    const next = b.closest('.rf-item').nextElementSibling?.dataset.id;
    const on = marks.toggle(id, act, rowById(id));
    refreshMarks();
    // Re-render replaced the button: put focus back (or on the next item if this one left the list).
    const q = (i) => itemEl(i, `[data-act="${act}"]`);
    (q(id) || (next && q(next)) || ui.list).focus?.();
    if (act === 'h' && on) offerHideUndo(id, () => { marks.toggle(id, 'h'); refreshMarks(); (q(id) || ui.list).focus(); });
  });
  }

  function build() {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    const launch = document.createElement('button');
    launch.id = 'rf-launch';
    launch.textContent = 'Availability Filter';

    const panel = document.createElement('div');
    panel.id = 'rf-panel';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Availability Filter');
    launch.setAttribute('aria-controls', 'rf-panel');
    launch.setAttribute('aria-expanded', 'false');
    panel.innerHTML = panelHtml();

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
      partial: panel.querySelector('.rf-partial'),
      warnbar: panel.querySelector('.rf-warnbar'),
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
    // Put `next` into the form (only what changed) and apply it as if typed.
    function applyCfg(next) {
      for (const [k, el] of fields) if (next[k] !== cfg[k]) write(el, next[k]);
      ui.paintAmen?.();
      onChange({ type: 'change' });
    }
    queueMicrotask(() => ui.paintAmen?.());
    ui.fields = fields;
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
    const typeInput = panel.querySelector('#rf-type');
    // Chips for the types in these results, plus any picked type they lack (eg from a preset).
    ui.typeNames = [];
    const paintTypes = () => {
      const on = typeList(typeInput.value), names = [...new Set([...ui.typeNames, ...on])].sort();
      const list = panel.querySelector('.rf-types-list');
      const focused = list.contains(document.activeElement) ? document.activeElement.dataset.ptype : null;
      list.innerHTML = names.length ? names.map((t) => `<button type="button" class="rf-chip" data-ptype="${esc(t)}" aria-pressed="${on.includes(t)}">${esc(t)}</button>`).join('')
        : '<span class="rf-meta">Search to see the types</span>';
      if (focused) list.querySelector(`[data-ptype="${CSS.escape(focused)}"]`)?.focus();
    };
    panel.querySelector('.rf-types').addEventListener('click', (e) => {
      const b = e.target.closest('[data-ptype]');
      if (!b) return;
      const on = typeList(typeInput.value), t = b.dataset.ptype;
      typeInput.value = (on.includes(t) ? on.filter((x) => x !== t) : [...on, t]).join(',');
      paintTypes();
      typeInput.dispatchEvent(new Event('change'));
    });
    ui.paintTypes = paintTypes;
    ui.paintAmen = () => { paintAmen(); paintNoWatch(); paintTypes(); };
    panel.querySelector('.rf-amen-req').addEventListener('click', (e) => {
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
    // Full-screen on phones is a real modal: the page behind is inert, so Tab can't wander there.
    const setInert = (on) => {
      for (const el of document.body.children) {
        if (el === panel || el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
        if (on && !el.inert) { el.inert = true; el.dataset.rfInert = '1'; }
        else if (!on && el.dataset.rfInert) { el.inert = false; delete el.dataset.rfInert; }
      }
    };
    const setOpen = (open) => {
      if (!open) ui.closePeek?.();
      panel.hidden = !open;
      launch.setAttribute('aria-expanded', String(open));
      panel.setAttribute('aria-modal', String(open && narrow.matches));
      setInert(open && narrow.matches);
      if (!open) for (const d of panel.querySelectorAll('.rf-acts-more[open], .rf-menu[open]')) d.open = false;
      else { ui.applyWidth?.(); ui.syncSticky?.(); ui.placedNow = !!ui.applyPlace?.(); } // sizes are only known once it's shown
    };
    narrow.addEventListener?.('change', () => { if (!panel.hidden) setOpen(true); });
    ui.setOpen = setOpen;
    launch.addEventListener('click', () => { setOpen(true); if (!ui.placedNow) ui.run.focus(); }); // back where you were, else on Search
    panel.querySelector('.rf-x').addEventListener('click', () => { setOpen(false); launch.focus(); });
    const help = panel.querySelector('.rf-help'), helpBtn = panel.querySelector('.rf-keys');
    const toggleHelp = () => {
      help.hidden = !help.hidden;
      helpBtn.setAttribute('aria-expanded', String(!help.hidden));
      if (!help.hidden) help.scrollIntoView({ block: 'nearest' });
    };
    // Expanded drawer, remembered per browser. Phones are already full screen, so the button is hidden there.
    const expandBtn = panel.querySelector('.rf-expand');
    const setWide = (on, save = true) => {
      // The element that scrolls changes (drawer ↔ list): carry the listing you're on across.
      const edge = panel.querySelector('.rf-status').getBoundingClientRect().bottom;
      const cur = document.activeElement?.closest?.('.rf-item');
      const keep = cur && panel.contains(cur) ? cur : [...panel.querySelectorAll('.rf-list > .rf-item')].find((el) => el.getBoundingClientRect().bottom > edge + 8);
      const wasTop = !keep || keep === panel.querySelector('.rf-list > .rf-item');
      panel.classList.toggle('rf-full', on);
      expandBtn.setAttribute('aria-pressed', String(on));
      expandBtn.setAttribute('aria-label', on ? 'Shrink drawer' : 'Expand drawer');
      expandBtn.title = on ? 'Back to the side drawer (e)' : 'Expand to near full screen (e)';
      expandBtn.textContent = on ? '⤡' : '⤢';
      if (save) { if (on) wideKey.set('1'); else wideKey.clear(); }
      ui.applyWidth?.();
      ui.watchMore?.();
      ui.syncSticky?.();
      if (!panel.hidden && !wasTop) keep.scrollIntoView({ block: 'start' });
    };
    wireResize(panel, narrow);
    setWide(wideKey.get() === '1', false);
    panel.classList.toggle('rf-compact', !!cfg.compact);
    applyTheme();
    const sortDir = panel.querySelector('.rf-sortdir'), sortDesc = panel.querySelector('#rf-sortDesc');
    sortDir.setAttribute('aria-pressed', String(!!cfg.sortDesc));
    sortDir.addEventListener('click', () => { sortDesc.checked = !sortDesc.checked; sortDesc.dispatchEvent(new Event('change', { bubbles: true })); });
    expandBtn.addEventListener('click', () => setWide(!panel.classList.contains('rf-full')));
    // A first install gets a welcome until it's dismissed or a search completes; after that,
    // what's new since the version you last saw.
    const seen = keyStore(storageOr('localStorage'), SEEN_KEY);
    const news = panel.querySelector('.rf-news');
    const showNews = (title, items) => {
      news.querySelector('.rf-news-msg').innerHTML = `<strong>${esc(title)}</strong> ${items.map(esc).join(' ')}`;
      news.hidden = false;
    };
    if (!seen.get()) showNews('Welcome.', WELCOME);
    else if (verNum(seen.get()) < verNum(WHATS_NEW.version)) showNews(`Updated to ${WHATS_NEW.version}.`, WHATS_NEW.items);
    const welcomed = !seen.get();
    ui.newsSeen = () => { if (!seen.get()) { seen.set(WHATS_NEW.version); if (welcomed) news.hidden = true; } };
    news.querySelector('button').addEventListener('click', () => { news.hidden = true; seen.set(WHATS_NEW.version); });
    helpBtn.addEventListener('click', toggleHelp);
    wireKeys(panel, { launch, narrow, help, toggleHelp, setOpen, expandBtn });
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
    // Leaving a typed field mid-click (mousedown -> blur -> change) must not re-render the list
    // under the pointer, or the click is lost: renders asked for during a press wait for its end.
    let pressing = false, renderAfterPress = false;
    const typed = (el) => el?.tagName === 'TEXTAREA' || el?.type === 'text' || el?.type === 'number' || el?.type === 'date';
    const renderNow = (defer) => { if (defer && pressing) renderAfterPress = true; else showResults(); };
    panel.addEventListener('pointerdown', () => { pressing = true; }, true);
    // A press that never got its pointerup can't hold renders: a key ends it, and flushes what it held.
    panel.addEventListener('keydown', () => { if (pressing) { pressing = false; if (renderAfterPress) { renderAfterPress = false; if (cache) showResults(); } } }, true);
    const endPress = () => pressing && setTimeout(() => { pressing = false; if (renderAfterPress) { renderAfterPress = false; if (cache) showResults(); } }, 0);
    for (const type of ['pointerup', 'pointercancel', 'click']) document.addEventListener(type, endPress, true); // pointerup's timeout runs after its click
    const onChange = (e) => {
      const next = Object.fromEntries(fields.map(([k, el]) => [k, read(el)]));
      const sig = JSON.stringify(next);
      if (sig === lastSig) {
        // Same config: only flush a pending debounced render (eg Enter right after typing).
        if (t && e?.type === 'change') { clearTimeout(t); t = null; if (cache) renderNow(typed(e.target)); }
        return;
      }
      lastSig = sig;
      const wasRemember = cfg.remember;
      cfg = next;
      panel.classList.toggle('rf-compact', !!cfg.compact);
      applyTheme();
      sortDir.setAttribute('aria-pressed', String(!!cfg.sortDesc));
      saveCfg(cfg);
      if (!cfg.remember || !cfg.remindSaved) document.getElementById('rf-remind')?.remove();
      if (wasRemember && !cfg.remember) { // opting out also forgets what was stored
        setWarn('saved', '');
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
      if (e?.type === 'input') t = setTimeout(() => { t = null; renderNow(true); }, INPUT_DEBOUNCE_MS); // debounce typing
      else renderNow(typed(e?.target)); // re-filter without refetching
    };
    for (const [, el] of fields) {
      el.addEventListener('change', onChange);
      // Typed fields (textareas too) apply as you type, so blurring one doesn't re-render mid-click.
      if (typed(el) && el.type !== 'date') el.addEventListener('input', onChange);
    }

    // Shortlist / hide / note: one delegated handler; re-render keeps scroll position.
    wireList(panel, { write, onChange });
    ui.list.tabIndex = -1;
    // Other places: say what was understood, so a mistyped line isn't silently ignored.
    const placesBox = panel.querySelector('#rf-places'), placesFb = panel.querySelector('.rf-places-fb');
    const paintPlaces = () => {
      const lines = placesBox.value.split('\n').filter((l) => l.trim());
      const ok = parsePlaces(placesBox.value);
      placesFb.textContent = !lines.length ? '' : `${ok.map((p) => `${p.label} ✓`).join(' · ')}${lines.length > ok.length ? `${ok.length ? ' · ' : ''}${plural(lines.length - ok.length, 'line')} not understood${lines.length > PLACES_MAX ? ` (at most ${PLACES_MAX})` : ''}` : ''}`;
      placesFb.classList.toggle('rf-warn-t', lines.length > ok.length);
    };
    placesBox.addEventListener('input', paintPlaces);
    ui.paintPlaces = paintPlaces;
    paintPlaces();
    // Side drawer: the status line (count, Undo, "Why?") sticks under the header, and once the
    // filters have scrolled away the header offers a way back to them.
    const head = panel.querySelector('.rf-head'), toFilters = panel.querySelector('.rf-tofilters');
    ui.syncSticky = () => {
      panel.style.setProperty('--rf-head-h', `${head.offsetHeight}px`);
      panel.style.setProperty('--rf-status-h', `${ui.status.offsetHeight}px`);
      const tabs = panel.querySelector('.rf-tabs');
      panel.style.setProperty('--rf-tabs-h', `${tabs.offsetHeight}px`);
      const top = ui.view === 'shortlist' ? ui.slBar : ui.controls;
      toFilters.hidden = panel.classList.contains('rf-full') || top.getBoundingClientRect().bottom > tabs.getBoundingClientRect().bottom;
    };
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => ui.syncSticky()).observe(ui.status);
    panel.addEventListener('scroll', () => { ui.syncSticky(); notePlace(); }, { passive: true });
    ui.list.addEventListener('scroll', () => notePlace(), { passive: true });
    ui.list.addEventListener('focusin', () => notePlace());
    ui.applyPlace = () => applyPlace();
    ui.toFilters = () => {
      panel.scrollTop = 0;
      (ui.view === 'shortlist' ? ui.slBar.querySelector('select, input, button') : panel.querySelector('#rf-from'))?.focus({ preventScroll: true });
      ui.syncSticky();
    };
    toFilters.addEventListener('click', () => ui.toFilters());
    wirePeek(panel);
    ui.warnbar.querySelector('.rf-warn-x').addEventListener('click', () => { ui.warnDismissed = ui.warnbar.querySelector('.rf-warn-msg').textContent; ui.warnbar.hidden = true; });
    // Next chunk loads as the "Show more" button nears view (the button stays for keyboard use).
    // Its root is whatever scrolls the results (the drawer, or the list when expanded), so it is
    // rebuilt when that changes.
    if (typeof IntersectionObserver === 'function') {
      let io = null;
      const observeMore = () => { if (!io) return; io.disconnect(); const b = ui.list.querySelector(':scope > .rf-more-btn'); if (b) io.observe(b); };
      ui.watchMore = () => {
        io?.disconnect();
        io = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting && x.target.isConnected)) renderMore(); }, { root: listScroller(), rootMargin: '600px 0px' });
        observeMore();
      };
      ui.watchMore();
      new MutationObserver(observeMore).observe(ui.list, { childList: true });
    }
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
      itemEl(id, 'select[data-app]')?.focus();
    });

    for (const tab of ui.tabs) {
      tab.addEventListener('click', () => setView(tab.dataset.view));
      // Tabs pattern: arrows move between the two tabs; only the selected one is in the Tab order.
      tab.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault();
        const next = ui.tabs[(ui.tabs.indexOf(tab) + 1) % ui.tabs.length];
        setView(next.dataset.view); next.focus();
      });
    }
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
      if (v === 'reviewed') return `Marked ${marks.setReviewed(rows.map((r) => r.id))} reviewed.`;
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
      ui.marketOn = false;
      ui.market.setAttribute('aria-pressed', 'false');
      applyCfg(next);
      showResults(); // also when the dates didn't change (same week again)
      (ui.list.querySelector('.rf-item') || ui.market).focus();
    });
    ui.active.addEventListener('click', (e) => {
      const b = e.target.closest('[data-chip]');
      const chip = b && ui.activeChips?.[+b.dataset.chip];
      if (!chip) return;
      const next = without(cfg, chip);
      applyCfg(next);
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
      shareIn.querySelector('.rf-share-msg').textContent = `${plural(rows.length, 'shared listing')}:`;
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
        setStatus(`Added ${plural(n, 'shared listing')} to your shortlist.`);
      }
      shareIn.hidden = true;
      ui.pendingShare = null;
    });
    ui.list.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-plan-ics]');
      if (!btn || !ui.planDay) return;
      const day = ui.planDay;
      let rows = shortlistRows().map((r) => ({ ...r, inspections: (r.inspections || []).filter((i) => typeof i.at === 'number' && ymdIn(i.at, tzOf(r)) === day) }));
      if (btn.dataset.planIcs === 'route') { // just the suggested sessions
        const picked = [...bestRoute(planDay(rows, day)).picked];
        rows = rows.map((r) => ({ ...r, inspections: r.inspections.filter((i) => picked.some((x) => x.r.id === r.id && x.at === i.at)) })).filter((r) => r.inspections.length);
      }
      downloadIcs(rows);
    });
    // The More menu closes once an item is chosen (or on a click elsewhere).
    const slMenu = ui.slBar.querySelector('.rf-menu');
    slMenu.addEventListener('click', (e) => { if (e.target.closest('.rf-menu-list button')) slMenu.open = false; });
    document.addEventListener('click', (e) => { if (slMenu.open && !slMenu.contains(e.target)) slMenu.open = false; });
    ui.slBar.querySelector('[data-sl=recheck]').addEventListener('click', (e) => recheckShortlist(e.currentTarget));
    const storageLine = panel.querySelector('.rf-storage-n');
    const paintStorage = () => {
      const ls = storageOr('localStorage'), ss = storageOr('sessionStorage');
      const c = marks.counts(), n = Object.keys(snaps.exportData()).length;
      storageLine.textContent = `Stored in this browser only: ${fmtBytes(toolBytes(ls) + toolBytes(ss))} (${c.starred} shortlisted, ${c.hidden} hidden, ${plural(n, 'remembered search', 'es')}).`;
    };
    ui.paintStorage = () => { if (panel.querySelector('.rf-settings').open) paintStorage(); };
    panel.querySelector('.rf-settings').addEventListener('toggle', (e) => { if (e.currentTarget.open) paintStorage(); });
    panel.querySelector('[data-forget]').addEventListener('click', () => {
      if (!window.confirm('Delete your shortlist, notes, hidden listings, presets, remembered searches and settings from this browser? Download a Backup first if you might want them back.')) return;
      for (const st of [storageOr('localStorage'), storageOr('sessionStorage')]) for (const k of toolKeys(st)) { try { st.removeItem(k); } catch { /* blocked */ } }
      document.getElementById('rf-remind')?.remove();
      marks.invalidate();
      location.reload();
    });
    ui.saved = panel.querySelector('.rf-saved');
    ui.savedResult = new Map();
    ui.saved.querySelector('[data-saved-check]').addEventListener('click', (e) => checkSaved(e.currentTarget));
    ui.saved.querySelector('.rf-saved-list').addEventListener('click', (e) => {
      const b = e.target.closest('[data-saved-pin]');
      if (!b) return;
      const on = b.getAttribute('aria-pressed') !== 'true';
      const ok = snaps.pin(b.dataset.savedPin, on);
      setWarn('saved', '');
      renderSaved();
      if (!ok) return setStatus("Couldn't save that: browser storage is full.", true);
      ui.saved.querySelector(`[data-saved-pin="${CSS.escape(b.dataset.savedPin)}"]`)?.focus();
      setStatus(on ? `Pinned ${searchLabel(b.dataset.savedPin)}.` : `Unpinned ${searchLabel(b.dataset.savedPin)}.`);
    });
    ui.slBar.querySelector('[data-sl=print]').addEventListener('click', () => {
      const rows = shortlistRows();
      if (!rows.length) return setStatus('Nothing on the shortlist to print.', true);
      const w = window.open('', '_blank');
      if (!w) return setStatus('Pop-up blocked - allow pop-ups for realestate.com.au to print.', true);
      w.document.open();
      w.document.write(printHtml(rows, new Date(), checklistItems(cfg.checklist)));
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
        setStatus(`Restored ${plural(n, 'listing')}${k ? ` and ${plural(k, 'saved search', 'es')}` : ''} from backup.`);
      } catch (err) { setStatus(err.message, true); }
    });

    ui.run.addEventListener('click', () => busy || run());
    ui.partial.querySelector('[data-resume]').addEventListener('click', () => busy || run(true, { resume: true }));
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
  const rowOf = (id) => rowById(id) || ui.rows?.find((x) => x.id === id); // also shortlist-only rows
  const BULK_HIDE = { sb: ['suburb', (n) => marks.toggleSuburb(n), 'in'], ag: ['agency', (n) => marks.toggleAgency(n), 'from'] };

  // Where you were in each tab (and for which search + filters), so switching tabs keeps it.
  const placeSig = (view) => (view === 'shortlist' ? 'sl' : `${cacheKey}|${JSON.stringify(cfg)}`);
  function setView(view) {
    ui.closePeek?.();
    const place = (ui.place ||= {});
    if (ui.view && ui.view !== view) place[ui.view] = { top: listScroller().scrollTop, shown: ui.list.querySelectorAll('.rf-item').length, sig: placeSig(ui.view) };
    const back = place[view]?.sig === placeSig(view) ? place[view] : null;
    if (back) ui.keepShown = back.shown;
    ui.view = view;
    for (const t of ui.tabs) { const on = t.dataset.view === view; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; }
    ui.list.setAttribute('aria-labelledby', `rf-tab-${view}`);
    const sl = view === 'shortlist';
    ui.controls.hidden = sl;
    ui.active.hidden = true; // results view re-shows it via renderActive()
    ui.slBar.hidden = !sl;
    ui.panel.querySelector('.rf-clear').hidden = sl; // filters don't apply to the shortlist
    ui.panel.classList.toggle('rf-wide', sl && !!ui.compare);
    if (sl) renderShortlist();
    else if (cache) showResults();
    else { setEmpty(EMPTY_INTRO); setStatus(''); setExport(true); }
    ui.keepShown = 0;
    if (back) listScroller().scrollTop = back.top;
    else if (!(sl && shortlistPlace()) && sl) toListTop(); // not the Results tab's scroll offset
    ui.syncSticky?.();
  }

  const shortlistRows = (all = marks.shortlist()) => {
    const f = ui.slFilter.value, q = ui.slQuery.value;
    return all.filter((r) => (!f || (f === '-' ? !r.appStatus : f === '!' ? !!(needsAction(r) || needsFollowUp(r)) : r.appStatus === f)) && textMatch(r, q));
  };

  // Re-check shortlisted listings one at a time (user-initiated, polite delay, abortable).
  const RECHECK_MAX = 30;
  // User-started background jobs (re-check, check all) share the search's abort/busy slot.
  const startJob = (btn) => { runCtrl?.abort(); const c = runCtrl = new AbortController(); setBusy(true); btn.setAttribute('aria-disabled', 'true'); return c; };
  const endJob = (c, btn) => { if (runCtrl === c) { runCtrl = null; setBusy(false); } btn.removeAttribute('aria-disabled'); }; // a search that took over owns busy now

  async function recheckShortlist(btn) {
    if (busy) return;
    // Least recently seen first, so repeated runs work through a long shortlist.
    const all = shortlistRows().sort((a, b) => (a.lastSeen || 0) - (b.lastSeen || 0));
    const rows = all.slice(0, RECHECK_MAX);
    if (!rows.length) return setStatus('Nothing on the shortlist to re-check.', true);
    const ctrl = startJob(btn);
    const tally = { ok: 0, gone: 0, unknown: 0 };
    try {
      for (const [i, r] of rows.entries()) {
        if (pause.until()) throw pausedErr(pause.until());
        setStatus(`Re-checking ${i + 1} of ${rows.length}…`);
        let res, html;
        try { // body read inside too: a reset mid-download is one unreadable listing, not the end
          res = await fetch(r.url, { credentials: 'include', signal: withTimeout(ctrl.signal, FETCH_TIMEOUT_MS) });
          html = res.ok ? await res.text() : '';
        } catch (err) {
          if (ctrl.signal.aborted) throw err;
          tally.unknown++; continue;
        }
        if (res.status === 403 || res.status === 429) { tripPause(botCheck(`Re-check: HTTP ${res.status}`)); throw pausedErr(pause.until()); }
        const out = parseListingPage(html, r.id, { status: res.status, redirectedTo: res.redirected ? res.url : '' });
        tally[out.status]++;
        if (out.status === 'gone') marks.setGone(r.id, true);
        if (out.status === 'ok') { const row = safeRow(out.listing, false); if (row) learn([row], true, false, false); }
        if (i < rows.length - 1) await sleep(jitter(PAGE_DELAY_MS), ctrl.signal);
      }
      refreshMarks();
      setStatus(`Re-checked ${rows.length < all.length ? `${rows.length} of ${all.length} (least recently seen)` : rows.length}: ${tally.ok} updated, ${tally.gone} no longer listed${tally.unknown ? `, ${tally.unknown} couldn't be read` : ''}.${rows.length < all.length ? ' Run again for the rest.' : ''}`);
    } catch (err) {
      refreshMarks();
      setStatus(err?.paused ? `Re-check stopped after ${plural(tally.ok + tally.gone + tally.unknown, 'listing')}. ${err.message}` : 'Re-check stopped.', !!err?.paused);
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
      const found = r?.error ? ' · <span class="rf-warn-t">couldn\'t be read</span>' : r ? ` · <strong>${r.added} new</strong>${r.gone ? `, ${r.gone} gone` : ''}` : '';
      return `<li><a href="${esc(safeUrl(k))}">${esc(searchLabel(k))}</a>${k === here ? ' <span class="rf-tag">this search</span>' : ''}
        <button type="button" class="rf-chip rf-pin" data-saved-pin="${esc(k)}" aria-pressed="${!!e.pin}" title="${e.pin ? 'Pinned: kept when you open other searches' : `Keep this one when more than ${SNAP_MAX} searches are opened`}">${e.pin ? 'Pinned' : 'Pin'}</button>
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
        let res;
        try {
          res = await fetchAllPages(key, (m) => setStatus(`Checking ${label} (${i + 1} of ${keys.length}): ${m}`), {
            signal: ctrl.signal, getPage: (url) => getPage(url, { signal: ctrl.signal }),
          });
        } catch (err) { // one failing search doesn't stop the rest; a bot check stops them all
          if (ctrl.signal.aborted || err?.name === 'AbortError' || err?.paused || err?.botCheck) throw err;
          logError(`saved ${label}: ${err.message}`);
          ui.savedResult.set(key, { error: true });
          out.push(`${label}: couldn't be read`);
          continue;
        }
        const ids = new Set(res.rows.map((r) => r.id));
        const found = { added: res.rows.filter((r) => !before.has(r.id)).length, gone: [...before].filter((id) => !ids.has(id)).length };
        if (!cfg.remember) throw new DOMException('remember turned off', 'AbortError'); // opted out mid-check: store nothing
        store.set(key, res.rows, res.truncated);
        const snap = snaps.save(key, res.rows, res.truncated);
        if (key === currentKey()) adopt(key, res.rows, res.truncated, '', snap, true);
        else learn(res.rows, true, true);
        ui.savedResult.set(key, found);
        out.push(`${label}: ${found.added} new${found.gone ? `, ${found.gone} gone` : ''}`);
        if (i < keys.length - 1) await sleep(jitter(PAGE_DELAY_MS), ctrl.signal);
      }
      setStatus(`Checked ${plural(keys.length, 'saved search', 'es')}. ${out.join(' · ')}.`);
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
    const all = marks.shortlist();
    const rows = shortlistRows(all);
    ui.agencyRec = agencyRecord(all); // over the whole shortlist, not just what the search box shows
    // Distance for the shortlist too (applyFilters isn't run over it).
    const anchor = parseAnchor(cfg.anchor), places = parsePlaces(cfg.places);
    for (const r of rows) { setDistances(r, cfg, anchor, places); r.fit = leaseFit(r, cfg.leaseEnd); }
    ui.rows = rows;
    setExport(rows.length === 0);
    const days = inspectDays(rows);
    ui.plan.innerHTML = `<option value="">Plan a day…</option>` + days.map(({ day, n }) =>
      `<option value="${day}">${esc(shortDate(day))} (${plural(n, 'inspection')})</option>`).join('');
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
    labelBulk(ui.slBulk, (ui.bulkRows || rows).length);
    const total = marks.counts().starred;
    if (rows.length && !slots && !cmp) paintList(rows);
    else ui.list.innerHTML = !rows.length ? (total ? '<div class="rf-empty">Nothing on the shortlist matches.</div>' : '<div class="rf-empty">No shortlisted listings yet.<br>Use ☆ on any result to add one.</div>')
      : slots ? planHtml(slots, ui.planDay) : compareHtml(cmp);
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
    ui.paintStorage?.();
    marks.decorate([...known.values()]); // cache rows are mostly these same objects (learn)
    if (cache) marks.decorate(cache.filter((r) => known.get(r.id) !== r));
    if (gone.length) marks.decorate(gone);
    if (cache) withBuildings(cache); // hiding one changes "N in this building"
    knownVer++;
    updateCounts();
    const scroller = listScroller(), top = scroller.scrollTop;
    const shown = ui.list.querySelectorAll('.rf-item').length;
    ui.keepShown = shown; // re-render as many as were showing, in one pass
    if (ui.view === 'shortlist') renderShortlist();
    else if (cache) showResults();
    ui.keepShown = 0;
    scroller.scrollTop = top;
    scheduleAnnotate();
  }

  // After a hide: Undo plus one-tap reasons, so "why did I rule this out?" has an answer later.
  // Hidden from REA's card with the drawer closed: the drawer's status line can't be seen, so
  // Undo and the reasons go in a small note by the launcher for a few seconds.
  const TOAST_MS = 10000;
  function toastHideUndo(id, undo) {
    document.getElementById('rf-toast')?.remove();
    const t = Object.assign(document.createElement('div'), { id: 'rf-toast' });
    t.setAttribute('role', 'status');
    t.innerHTML = `<span>Listing hidden.</span><button type="button" data-t="undo">Undo</button><span>Why?</span>${HIDE_REASONS.map((r) => `<button type="button" data-t="why" data-r="${esc(r)}">${esc(r)}</button>`).join('')}`;
    let timer = setTimeout(() => t.remove(), TOAST_MS);
    t.addEventListener('mouseenter', () => clearTimeout(timer));
    t.addEventListener('mouseleave', () => { timer = setTimeout(() => t.remove(), TOAST_MS / 2); });
    t.addEventListener('click', (e) => {
      const b = e.target.closest('[data-t]');
      if (!b) return;
      if (b.dataset.t === 'undo') undo();
      else { marks.setHideReason(id, b.dataset.r); if (cache) marks.decorate(cache); }
      t.remove();
    });
    document.body.appendChild(t);
  }
  function offerHideUndo(id, undo) {
    if (ui.panel.hidden) return toastHideUndo(id, undo);
    offerUndo('Listing hidden.', undo);
    const why = document.createElement('span');
    why.className = 'rf-why';
    why.append(' Why? ');
    for (const reason of HIDE_REASONS) {
      const b = Object.assign(document.createElement('button'), { className: 'rf-undo', textContent: reason, type: 'button' });
      // No re-render: the listing is hidden, and re-rendering would replace this status line.
      b.addEventListener('click', () => { marks.setHideReason(id, reason); if (cache) marks.decorate(cache); why.replaceChildren(` Noted: ${reason}.`); }, { once: true });
      why.append(b, ' ');
    }
    ui.status.append(why);
  }

  // A search that stopped partway: say how far it got, offer to pick up from there.
  function showPartial(failed) {
    if (!ui.partial) return;
    ui.partial.hidden = !failed;
    if (failed) ui.partial.querySelector('.rf-partial-msg').textContent = `Read ${failed.page - 1} of ${failed.max} pages; page ${failed.page} failed (${failed.message}). Showing the listings read so far.`;
  }

  // One-shot Undo link in the status line.
  function offerUndo(msg, undo) {
    setStatus(msg);
    const b = Object.assign(document.createElement('button'), { className: 'rf-undo', textContent: 'Undo' });
    b.addEventListener('click', () => { b.remove(); undo(); }, { once: true });
    ui.status.append(' ', b); // space: screen readers read "hidden. Undo", not "hidden.Undo"
  }

  const setExport = (disabled) => { for (const b of ui.exports) b.disabled = disabled; ui.bulk.disabled = disabled; ui.market.disabled = disabled; };

  // Data-format warnings sit in their own banner, so the status line keeps "N of M match".
  const warnings = {};
  // On <html> so the launcher, notes and listing bar follow it too (a data-rf-* attribute only).
  const applyTheme = () => {
    const root = document.documentElement;
    if (cfg.theme === 'light' || cfg.theme === 'dark') root.dataset.rfTheme = cfg.theme; else delete root.dataset.rfTheme;
  };
  const setWarn = (kind, msg) => {
    if (msg) warnings[kind] = msg; else delete warnings[kind];
    const text = Object.values(warnings).join(' ');
    ui.warnbar.hidden = !text || ui.warnDismissed === text;
    ui.warnbar.querySelector('.rf-warn-msg').textContent = text;
  };
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
    if (!rows.length) suggestDrops();
    const st = diffStats(cache);
    const matchHint = (cfg.sort === 'match' && !rows.some((r) => r.score != null)
      ? ' Best match needs two of: a max rent (or enough listings for a median), a "from" date, a distance point, known bonds.' : '')
      + (textClipped && cfg.keyword.trim() ? ' Keywords searched the saved (shortened) text; Refresh to search full descriptions.' : '');
    const since = baseAt ? ` since ${ago(Date.now() - baseAt)}` : '';
    const extra = [st.fresh && `${st.fresh} new${since}`, gone.length && `${gone.length} no longer listed`, st.moved && `${st.moved} price changed`, st.redated && `${st.redated} date changed`, st.featured && `${st.featured} details changed`,
      !cfg.showHidden && st.hidden && `${st.hidden} hidden`, st.cheaperHidden && `${st.cheaperHidden} hidden now cheaper`, st.reviewed && `reviewed ${st.reviewed} of ${st.total}`].filter(Boolean).join(' · ');
    setStatus(`${rows.length} of ${cache.length} listings match.${extra ? ` ${extra}.` : ''}` +
      (truncated ? ` Only the first ${MAX_PAGES} pages were read - narrow the search for full coverage.` : '') +
      (note ? ` ${note}` : '') + matchHint);
    const warn = schemaWarnings(cache);
    setWarn('schema', warn.length ? `REA's data format may have changed (${warn.join('; ')}). Run reaFilter.probe() in the console and report the output.` : '');
  }

  // Nothing matches: offer the filters whose removal brings back the most listings.
  function suggestDrops() {
    const top = (ui.activeChips || []).map((c, i) => ({ c, i })).filter((x) => x.c.removes > 0).sort((a, b) => b.c.removes - a.c.removes).slice(0, 3);
    if (!top.length) return;
    setEmpty(`Nothing matches those filters. Try dropping one:<br>${top.map(({ c, i }) =>
      `<button type="button" class="rf-chip" data-drop-chip="${i}">${esc(c.label)} <span>+${c.removes}</span></button>`).join(' ')}`);
  }

  // Chips for active filters with how many listings each removes; click to drop that filter.
  function renderActive() {
    const chips = cache ? removedBy(pool(), cfg) : [];
    ui.active.hidden = !chips.length || ui.view === 'shortlist';
    ui.active.innerHTML = chips.map((c, i) => `<button type="button" class="rf-chip rf-achip" data-chip="${i}"
      aria-label="Remove filter ${esc(c.label)}${c.removes > 0 ? `, hiding ${c.removes}` : ''}">${esc(c.label)}${c.removes > 0 ? ` <span>−${c.removes}</span>` : ''} ×</button>`).join('');
    ui.activeChips = chips;
    ui.moreSummary.textContent = `More filters${chips.length ? ` (${chips.length} active)` : ''}`;
  }

  // Bulk menus say how many listings they will touch.
  const labelBulk = (sel, n) => { for (const o of sel.options) if (o.value) o.textContent = o.dataset.label.replace('{n}', n); };

  function render(rows) {
    ui.rows = rows; // first: renderMore()/refreshMarks() read it even when the list is empty
    labelBulk(ui.bulk, rows.length);
    setExport(rows.length === 0);
    setLaunchCount(rows.length);
    if (!rows.length) return setEmpty('Nothing matches those filters.');
    if (ui.marketOn) ui.list.innerHTML = marketHtml(marketStats(rows)); else paintList(rows);
    toListTop();
  }

  function planHtml(slots, day) {
    // Zone name only when the listing's clock differs from yours (Melbourne from Sydney doesn't).
    const clock = (ms, tz) => dtf({ hour: 'numeric', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) }).format(ms);
    const t = (ms, tz) => (tz && clock(ms, tz) !== clock(ms) ? dtf({ hour: 'numeric', minute: '2-digit', timeZone: tz, timeZoneName: 'short' }).format(ms) : clock(ms, tz))
      .replace(/\s?(am|pm)/i, (m) => m.trim().toLowerCase());
    const clashes = slots.filter((x) => x.flag).length;
    const route = bestRoute(slots);
    const partial = route.listings > 1 && route.visits < route.listings;
    const inRoute = new Set([...route.picked].map((x) => x.r.id));
    return `<div class="rf-planner"><div class="rf-plan-head">${esc(shortDate(day))}: ${plural(slots.length, 'inspection')}${clashes ? `, <strong>${clashes} to check</strong>` : ''}
      <button class="rf-btn sec" data-plan-ics>Calendar for this day</button></div>
      ${route.listings > 1 ? `<div class="rf-plan-route"><span>Suggested route: <strong>${route.visits} of ${plural(route.listings, 'listing')}</strong>${partial ? ' (the rest clash or are too far to reach in time)' : ''}</span>${partial || route.picked.size < slots.length ? ' <button class="rf-btn sec" data-plan-ics="route">Calendar for the route</button>' : ''}</div>` : ''}
      <ol>${slots.map((x) => {
        const tag = route.listings < 2 ? '' : route.picked.has(x) ? '<span class="rf-tag rf-new">route</span>'
          : inRoute.has(x.r.id) ? '<span class="rf-tag">other time</span>' : '<span class="rf-tag">skip</span>';
        return `<li class="${[x.flag ? `rf-${x.flag}` : '', route.listings > 1 && !route.picked.has(x) ? 'rf-off-route' : ''].filter(Boolean).join(' ')}"><span class="rf-plan-t">${t(x.at, x.tz)}</span>
        <a href="${esc(x.r.url)}" target="_blank" rel="noopener">${esc(x.r.address)}</a> <span class="rf-type">${esc(x.r.price)}</span>${tag}
        ${x.gapMin != null ? `<div class="rf-meta">${x.same ? 'Another time for the same listing' : x.flag === 'clash' ? 'Overlaps the previous inspection' : `${x.gapMin} min after the previous${x.km != null ? `, ${x.km} km away` : ''}${x.flag === 'tight' ? ' — tight' : ''}`}</div>` : ''}
      </li>`;
      }).join('')}</ol><div class="rf-meta">Assumes ${INSPECT_MINUTES} min per inspection and straight-line distance (about ${60 / PLAN_MIN_PER_KM} km/h, at least ${PLAN_MIN_GAP} min between); "to inspect" listings are favoured. A guide, not a timetable.</div></div>`;
  }

  function marketHtml(m) {
    const $ = (v) => (v == null ? '–' : money(v));
    const range = (a, b) => (a == null ? '–' : a === b ? $(a) : `${$(a)}–${$(b)}`);
    const top = Math.max(1, ...m.byWeek.map((w) => w.n));
    const weekLabel = (w) => w.label || shortDate(w.from);
    return `<div class="rf-market"><div class="rf-plan-head">${plural(m.n, 'listing')} shown${m.median != null ? ` · median ${$(m.median)}/wk` : ''}</div>
      <div class="rf-market-t"><table><caption>Weekly rent by bedrooms</caption><thead><tr><th scope="col">Beds</th><th scope="col">Listings</th><th scope="col">Median</th><th scope="col">Middle half</th><th scope="col">Range</th><th scope="col">Per bed</th></tr></thead>
      <tbody>${m.byBeds.map((g) => `<tr><th scope="row">${g.beds === 0 ? 'Studio' : g.beds === 5 ? '5+' : g.beds}</th><td>${g.n}</td><td>${$(g.median)}</td>
        <td>${range(g.p25, g.p75)}</td><td>${range(g.min, g.max)}</td><td>${$(g.ppb)}</td></tr>`).join('')}</tbody></table></div>
      ${m.bySuburb.length ? `<div class="rf-market-t"><table><caption>By suburb</caption><thead><tr><th scope="col">Suburb</th><th scope="col">Listings</th><th scope="col">Median</th><th scope="col">Per bed</th></tr></thead>
      <tbody>${m.bySuburb.map((g) => `<tr><th scope="row">${esc(g.suburb)}</th><td>${g.n}</td><td>${$(g.median)}</td><td>${$(g.ppb)}</td></tr>`).join('')}</tbody></table></div>` : ''}
      <h3>Available</h3><ul class="rf-bars">${m.byWeek.map((w, i) => [w, i]).filter(([w]) => w.n || w.from).map(([w, i]) => {
        const data = w.label === 'Unknown' ? '' : ` data-week="${i}"`;
        const inner = `<span>${esc(weekLabel(w))}</span><span class="rf-bar" style="width:${Math.round((w.n / top) * 100)}%"></span><span class="rf-bar-n">${w.n}</span>`;
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
    ['Size', (r) => sqmLabel(r).replace(' (from text)', ''), (r) => -(r.sqm || 0), 'min'],
    ['Per m²', (r) => (perSqm(r) != null ? `$${perSqm(r)}` : ''), (r) => perSqm(r) ?? Infinity, 'min'],
    ['Beds · baths · cars', (r) => [r.beds, r.baths, r.cars].map((v) => (v === '' ? '?' : v)).join(' · '), (r) => -(+r.beds || 0), 'min'],
    ['Distance', (r) => kmLabel(r).replace(' away', ''), (r) => r.km ?? Infinity, 'min'],
    ['Places', (r) => placesLabel(r), (r) => worstKm(r) ?? Infinity, 'min'],
    ['Of income', (r) => (incomePct(r, cfg.income) != null ? `${incomePct(r, cfg.income)}%` : ''), (r) => incomePct(r, cfg.income) ?? Infinity, 'min'],
    ['Next inspection', (r) => r.inspections?.[0]?.label || '', null],
    ['Amenities', (r) => amenityTags(r).join(', '), null],
    ['Heads-up', (r) => watchTags(r).join(', '), null],
    ['Agency', (r) => r.agency || '', null],
    ['Lease', (r) => leaseText(r.lease).replace(/^Lease /, ''), null],
    ['Your lease', (r) => fitLabel(r.fit), (r) => fitKey(r.fit), 'min'],
    ['Apply via', (r) => r.applyVia || '', null],
    ['Status', (r) => statusLabel(r.appStatus), null],
    ['Checklist', (r) => checkSummary(r, checklistItems(cfg.checklist)), (r) => -Object.values(r.checks || {}).filter((v) => v === 'y').length, 'min'],
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
    const body = COMPARE_ROWS.filter(([label]) => (label !== 'Of income' || num(cfg.income) > 0) && (label !== 'Places' || parsePlaces(cfg.places).length) && (label !== 'Your lease' || !!cfg.leaseEnd)).map(([label, show, score]) => {
      const b = score ? best(score) : null;
      return `<tr><th scope="row">${label}</th>${rows.map((r) => `<td${b != null && score(r) === b ? ' class="rf-best"' : ''}>${esc(show(r)) || '<span class="rf-na">–</span>'}</td>`).join('')}</tr>`;
    }).join('');
    return `<div class="rf-compare"><table><thead><tr><td></td>${head}</tr></thead><tbody>${body}</tbody></table></div>` +
      (ui.rows.length > rows.length ? `<div class="rf-empty">Comparing ${ui.cmpPicked ? 'your selection' : `the first ${rows.length}`}; tick "Compare" on listings to choose.</div>` : '');
  }

  // Drawer renders in chunks: 500 cards at once is a ~80ms long task on every filter change.
  const moreHtml = (left) => (left > 0 ? `<button class="rf-btn sec rf-more-btn">Show ${Math.min(left, RENDER_CHUNK)} more (${left} left)</button>` : '');
  // First chunk (or as many as were showing, on a re-render) plus the "Show more" button.
  // Same listings in the same order as on screen (a shortlist/hide/note/status click, most
  // re-renders): only the items whose markup changed are swapped, so the rest keep their nodes
  // (and focus). Anything else, or most items changed, is one innerHTML.
  const paintList = (rows) => {
    const n = Math.max(RENDER_CHUNK, ui.keepShown || 0), parts = itemParts(rows.slice(0, n), 0, rows.length);
    const els = ui.list.querySelectorAll(':scope > .rf-item');
    const same = els.length === parts.length && parts.every((p, i) => els[i]._rf?.id === p.id);
    const changed = same ? parts.filter((p, i) => els[i]._rf.html !== p.html).length : Infinity;
    if (changed > parts.length / 2) {
      ui.list.innerHTML = parts.map((p) => p.html).join('') + moreHtml(rows.length - n);
      ui.list.querySelectorAll(':scope > .rf-item').forEach((el, i) => { el._rf = parts[i]; });
      return;
    }
    const tpl = document.createElement('template');
    parts.forEach((p, i) => {
      if (els[i]._rf.html === p.html) return;
      tpl.innerHTML = p.html;
      const el = tpl.content.firstElementChild;
      el._rf = p;
      els[i].replaceWith(el);
    });
    ui.list.querySelector(':scope > .rf-more-btn')?.remove();
    ui.list.insertAdjacentHTML('beforeend', moreHtml(rows.length - n));
  };
  function renderMore() {
    const shown = ui.list.querySelectorAll('.rf-item').length;
    ui.list.querySelector('.rf-more-btn')?.remove();
    const parts = itemParts(ui.rows.slice(shown, shown + RENDER_CHUNK), shown, ui.rows.length);
    ui.list.insertAdjacentHTML('beforeend', parts.map((p) => p.html).join('') + moreHtml(ui.rows.length - shown - RENDER_CHUNK));
    const els = ui.list.querySelectorAll(':scope > .rf-item');
    parts.forEach((p, i) => { if (els[shown + i]) els[shown + i]._rf = p; });
  }

  // Money facts in one line: move-in (bond flag), lease overlap/gap, share of income, vs median.
  function moneyLine(r, inc, med) {
    const parts = [
      Number.isFinite(r.upfront) ? `Move-in ${money(r.upfront)}${r.bondWeeks > BOND_CAP_WEEKS ? ` <span class="rf-warn" title="Bond above ${BOND_CAP_WEEKS} weeks' rent; check your state's cap">bond ${r.bondWeeks} wks</span>` : ''}` : '',
      r.fit ? `<span title="Against your current lease end (Settings)"${r.fit.gap ? ' class="rf-warn"' : ''}>${esc(fitLabel(r.fit))}</span>` : '',
      inc != null ? `<span${inc > RENT_STRESS_PCT ? ' class="rf-warn-t"' : ''}>${inc}% of income</span>` : '',
      med ? `<span class="rf-med ${r.vsMedian < 0 ? 'down' : r.vsMedian > 0 ? 'up' : ''}">${esc(med)}</span>` : '',
    ].filter(Boolean);
    return parts.length ? `<div class="rf-meta">${parts.join(' · ')}</div>` : '';
  }

  const tagsHtml = (tags, cls = '', title = '') => (tags.length ? `<div class="rf-tags${cls}"${title ? ` title="${esc(title)}"` : ''}>${tags.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : '');
  const metaLine = (parts, cls = '') => { const t = parts.filter(Boolean).join(' · '); return t ? `<div class="rf-meta${cls}">${esc(t)}</div>` : ''; };
  // `offset`/`total`: this chunk's place in the whole list, for screen readers ("12 of 150").
  const itemsHtml = (rows, offset, total) => itemParts(rows, offset, total).map((p) => p.html).join('');
  function itemParts(rows, offset = 0, total = rows.length) {
    const now = Date.now(), sl = ui.view === 'shortlist', checks = checklistItems(cfg.checklist);
    return rows.map((r, i) => ({ id: r.id, html: itemHtml(r, i) }));
    function itemHtml(r, i) {
      const name = [r.price, r.address, r.available && r.available !== '-' ? `available ${r.available.replace(/^available\s*/i, '')}` : ''].filter(Boolean).join(', ');
      const am = amenityTags(r), wt = watchTags(r), km = kmLabel(r), pk = placesLabel(r), inc = incomePct(r, cfg.income), med = medianLabel(r);
      const na = sl ? needsAction(r, now) : '';
      return `
      <div tabindex="-1" role="article" aria-posinset="${offset + i + 1}" aria-setsize="${total}" aria-label="${esc(`${offset + i + 1} of ${total}: ${name}`)}" class="rf-item${r.gone || ruledOut(r) ? ' rf-hidden' : ''}${r.starred ? ' rf-starred' : ''}" data-id="${esc(r.id)}"${r.reviewedAt ? ' data-rv="1"' : ''}>
      <a class="rf-card" href="${esc(r.url)}" target="_blank" rel="noopener" aria-label="${esc(`${name} (opens the listing)`)}">
        ${r.img ? `<img src="${esc(r.img)}" alt="" loading="lazy">` : '<div></div>'}
        <div>
          <div class="rf-avail">${esc(r.available)}${r.prevAvail ? ` <span class="rf-was ${r.availDir === 'later' ? 'up' : 'down'}" title="Availability date changed">was ${esc(r.prevAvail)}</span>` : ''}${r.featChange ? ` <span class="rf-tag" title="The listing's details changed recently">${esc(r.featChange)}</span>` : ''}${r.gone ? `<span class="rf-tag rf-gone"${r.goneAt ? ` title="Found gone ${esc(ago(now - r.goneAt))}"` : ''}>no longer listed</span>` : isFresh(r) ? '<span class="rf-tag rf-new">new</span>' : ''}${r.relisted ? `<span class="rf-tag" title="Same address was listed before${r.relisted.price ? ` at ${esc(r.relisted.price)}` : ''}${r.relisted.hidden ? '; you had hidden it' : ''}">relisted</span>` : ''}${r.surrounding ? '<span class="rf-tag">nearby</span>' : ''}${r.taken ? `<span class="rf-tag rf-taken" title="Going by the listing text">${esc(TAKEN_LABELS[r.taken])}</span>` : ''}${r.cheaperBy ? `<span class="rf-tag rf-new" title="You hid it at a higher rent">$${r.cheaperBy} cheaper since you hid it</span>` : ''}</div>
          <div class="rf-price">${esc(r.price)}${r.type ? ` <span class="rf-type">${esc(r.type)}</span>` : ''}${r.prevPrice ? ` <span class="rf-was ${priceDir(r)}" title="${esc(historyText(r))}">was ${esc(r.prevPrice)}</span>` : ''}</div>
          <div class="rf-addr">${esc(r.address)}</div>
          ${metaLine([r.beds !== '' ? `${r.beds} bed` : '', r.baths !== '' ? `${r.baths} bath` : '', r.cars !== '' ? `${r.cars} car` : '', sqmLabel(r), r.bond ? `bond ${r.bond}` : '', ppbLabel(r)])}
          ${km || pk || r.score != null ? `<div class="rf-meta">${esc([km, pk].filter(Boolean).join(' · '))}${r.score != null ? `${km || pk ? ' · ' : ''}<span class="rf-score" title="${esc(r.scoreWhy)}">Match ${r.score}</span>` : ''}</div>` : ''}
          ${metaLine([r.agency, sl && r.agency ? recordText(ui.agencyRec?.get(agencyKey(r.agency))) : '', r.photos != null ? plural(r.photos, 'photo') : '', r.floorplan ? 'floorplan' : ''], ' rf-sec')}
          ${tagsHtml([...am, r.lease ? leaseText(r.lease) : '', r.applyVia ? `Apply: ${r.applyVia}` : ''].filter(Boolean), ' rf-sec')}
          ${tagsHtml(wt, ' rf-watch rf-sec', 'Mentioned in the listing text: worth asking the agent')}
          ${moneyLine(r, inc, med)}
          ${metaLine([
            r.lastSeen && sl ? `seen ${ago(now - r.lastSeen)}` : '',
            r.inspectCancelled && sl ? `Inspection ${r.inspectCancelled} cancelled` : '',
            !r.inspections?.length && r.byAppt ? 'Inspections by appointment' : '',
            r.inspections?.length ? `Inspect ${r.inspections[0].label}${r.inspections.length > 1 ? ` +${r.inspections.length - 1}` : ''}` : '',
            r.listed ? `Listed ${ago(now - r.listed)}` : '',
            r.openedAt ? `opened ${ago(now - r.openedAt)}` : '',
            r.hideReason ? `hidden: ${r.hideReason}` : '',
          ], ' rf-sec')}
        </div>
      </a>
      ${r.buildingN || r.alsoListed?.length ? `<div class="rf-group rf-sec">${r.buildingN ? `<button type="button" class="rf-chip" data-act="bldg" title="Show only listings at ${esc(r.buildingAddr)}">${r.buildingN} in this building</button>` : ''}${r.alsoListed?.length
        ? ` <span class="rf-meta">Also listed ${r.alsoListed.map((x) => `${x.agency ? `by ${esc(x.agency)} ` : ''}${x.price ? `at ${esc(x.price)}` : ''}`).join('; ')}</span>` : ''}</div>` : ''}
      ${na === 'inspected' ? `<div class="rf-nudge">Did you inspect? <button type="button" class="rf-chip" data-na="yes">Yes, inspected</button> <button type="button" class="rf-chip" data-na="no">Didn't go</button></div>` : ''}
      ${na === 'apply' ? `<div class="rf-nudge">Inspected ${esc(ago(now - r.appAt))}: apply? <button type="button" class="rf-chip" data-na="applied">Mark applied</button></div>` : ''}
      ${r.starred && sl ? `<div class="rf-checks" role="group" aria-label="Inspection checklist">${checks.map((k) => {
        const v = r.checks?.[k];
        return `<button type="button" class="rf-chip" data-ck="${esc(k)}" data-state="${v === 'y' ? 'yes' : v === 'n' ? 'no' : ''}" aria-label="${esc(k)}: ${v === 'y' ? 'good' : v === 'n' ? 'problem' : 'not checked'}">${v === 'y' ? '✓ ' : v === 'n' ? '✗ ' : ''}${esc(k)}</button>`;
      }).join('')}</div>` : ''}
      ${r.starred ? `<label class="rf-app">Application <select data-app aria-label="Application status">${statusOptions(r.appStatus)}</select>${r.appAt ? ` <span class="rf-meta">${esc(ago(now - r.appAt))}</span>` : ''}${needsFollowUp(r) ? ' <span class="rf-warn-t">follow up?</span>' : ''}</label>` : ''}
      ${r.note ? `<div class="rf-note">${esc(r.note)}</div>` : ''}
      <div class="rf-acts">
        <button data-act="s" aria-pressed="${r.starred}" title="${r.starred ? 'Remove from shortlist' : 'Add to shortlist'}">${r.starred ? '★ Shortlisted' : '☆ Shortlist'}</button>
        <button data-act="h" title="${r.resurfaced ? 'Still not for you at this price: hide again' : r.hidden ? 'Unhide' : 'Hide this listing'}">${r.resurfaced ? 'Hide again' : r.hidden ? 'Unhide' : 'Hide'}</button>
        <button data-act="n" title="${r.note ? 'Edit note' : 'Add a note'}" aria-label="${r.note ? 'Edit note' : 'Add note'}">Note</button>
        <button data-act="copy" title="Copy a text summary of this listing" aria-label="Copy summary">Copy</button>
        ${sl ? `<label class="rf-cmp"><input type="checkbox" data-cmp="${esc(r.id)}"${ui.cmpSel?.has(r.id) ? ' checked' : ''}>Compare</label>` : ''}
        ${`<details class="rf-acts-more"><summary aria-label="More actions" title="More actions">⋯</summary><div>
          <button data-act="enq" title="Copy an enquiry message for the agent (template in Settings)">Copy enquiry</button>
          ${r.hidden ? `<span class="rf-meta">Why hidden?</span>${HIDE_REASONS.map((x) => `<button data-act="why" data-r="${x}" aria-pressed="${r.hideReason === x}">${x}</button>`).join('')}` : ''}
          ${r.inspections?.some((i) => typeof i.at === 'number' && i.at > now) ? '<button data-act="ics" title="Download this listing\'s inspection times for your calendar">Add to calendar</button>' : ''}
          ${r.lat != null ? `<button data-act="anchor" title="Measure distances from this listing">Measure from here</button><button data-act="place" title="Add this listing's location to Other places">Add as a place</button>` : ''}
          ${r.suburb && !sl ? `<button data-act="sb" title="${r.suburbHidden ? 'Show' : 'Hide'} every listing in ${esc(r.suburb)}" aria-label="${r.suburbHidden ? 'Unhide' : 'Hide'} suburb ${esc(r.suburb)}">${r.suburbHidden ? 'Unhide suburb' : 'Hide suburb'}</button>` : ''}
          ${r.agency ? `<button data-act="ag" title="${r.agencyHidden ? 'Show' : 'Hide'} every listing from ${esc(r.agency)}" aria-label="${r.agencyHidden ? 'Unhide' : 'Hide'} agency ${esc(r.agency)}">${r.agencyHidden ? 'Unhide agency' : 'Hide agency'}</button>` : ''}
        </div></details>`}
      </div>
      </div>`.trim();
    }
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
  const PRESET_VISIT_KEY = `${TOOL_PREFIX}preset-visit`;
  const PLACE_KEY = `${TOOL_PREFIX}place`; // sessionStorage: where you were in each search's results
  const PRESET_PREV_KEY = `${TOOL_PREFIX}preset-prev/v1`;
  const prevKey = keyStore(storageOr('localStorage'), PRESET_PREV_KEY), visitKey = keyStore(storageOr('sessionStorage'), PRESET_VISIT_KEY);
  const prevStore = {
    get() { try { const v = JSON.parse(prevKey.get()); return isObj(v) ? sanitizeCfg(v) : null; } catch { return null; } },
    set: (v) => prevKey.set(JSON.stringify(v)),
    clear: () => prevKey.clear(),
  };
  function enterSearchPresets(key) {
    const bound = key && presets.forSearch(key);
    const visited = visitKey.get();
    if (bound) {
      if (visited === key) return;
      if (!prevStore.get()) prevStore.set(Object.fromEntries(PRESET_KEYS.map((k) => [k, cfg[k]])));
      applyPreset(bound);
      visitKey.set(key);
      return;
    }
    if (!key) return; // a listing page or other REA page between searches isn't "leaving"
    visitKey.clear();
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
    ui.typeNames = [...new Set(rows.map((r) => r.type).filter(Boolean))];
    ui.paintTypes();
  }

  let textClipped = false; // rows came from storage, whose listing text is shortened
  function adopt(key, rows, trunc, note, snap = null, observe = false) {
    textClipped = !observe;
    learn(rows, observe, observe); // adopt observes only fresh full crawls
    if (snap) queueMicrotask(renderSaved);
    scheduleAnnotate();
    fillTypes(rows);
    cache = rows;
    applySnap(snap);
    withMedians(rows);
    withBuildings(rows);
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
    marks.decorate(gone); // shortlist, notes and hides apply to "no longer listed" rows too
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
    if (restoreSession()) { returnToPlace(); return true; }
    if (!cfg.remember || !isSearchPage(location.href)) return false;
    const key = searchKey(location.href);
    const snap = snaps.get(key);
    if (!snap?.rows.length) return false;
    adopt(key, snap.rows, snap.truncated, `Saved ${ago(Date.now() - snap.at)}. Refresh for current listings.`, snap);
    returnToPlace();
    return true;
  }

  // Your place in a search's results (the listing you were on), per tab, so a reload or coming
  // back to the search opens there. Only with the same filters and sort: otherwise it's a
  // different list and the top is the right place.
  const PLACE_MAX = 10;
  const placeKey = keyStore(storageOr('sessionStorage'), PLACE_KEY);
  // Results: per search, for these filters and sort. Shortlist: one place, for its own filter
  // and search box (not while planning a day or comparing).
  const SL_PLACE = 'shortlist';
  const placeFor = (view = ui.view) => (view === 'shortlist' ? JSON.stringify([ui.slFilter?.value, ui.slQuery?.value]) : JSON.stringify(PRESET_KEYS.map((k) => cfg[k])));
  const placeSlot = (view = ui.view) => (view === 'shortlist' ? SL_PLACE : cacheKey);
  const readPlaces = () => { try { const p = JSON.parse(placeKey.get() || '{}'); return isObj(p) ? p : {}; } catch { return {}; } };
  let placeTimer = null;
  function notePlace() {
    clearTimeout(placeTimer);
    placeTimer = setTimeout(() => {
      const slot = placeSlot();
      if (!slot || ui.panel.hidden || (ui.view === 'shortlist' && (ui.planDay || ui.compare))) return;
      const items = [...ui.list.querySelectorAll('.rf-item')];
      const cur = document.activeElement?.closest?.('.rf-item');
      const edge = ui.panel.classList.contains('rf-full') ? ui.list.getBoundingClientRect().top : ui.status.getBoundingClientRect().bottom;
      const at = cur && ui.list.contains(cur) ? cur : items.find((el) => el.getBoundingClientRect().bottom > edge + 8);
      const places = readPlaces();
      if (!at || items.indexOf(at) === 0) delete places[slot];
      else places[slot] = { id: at.dataset.id, shown: items.length, sig: placeFor(), t: Date.now() };
      const keep = Object.entries(places).sort(([, a], [, b]) => b.t - a.t).slice(0, PLACE_MAX);
      placeKey.set(JSON.stringify(Object.fromEntries(keep)));
    }, 400);
  }
  let pendingPlace = null;
  function returnToPlace() {
    const p = readPlaces()[cacheKey];
    pendingPlace = p && p.sig === placeFor() ? p : null;
    if (!ui.panel.hidden) applyPlace();
  }
  function applyPlace() {
    const p = pendingPlace;
    pendingPlace = null;
    if (!p || ui.view === 'shortlist') return false;
    return goToPlace(p);
  }
  // The Shortlist tab, opened for the first time since the page loaded: back where you were.
  function shortlistPlace() {
    const p = readPlaces()[SL_PLACE];
    return !!p && p.sig === placeFor('shortlist') && goToPlace(p);
  }
  function goToPlace(p) {
    for (let n = 0; n < 20 && ui.list.querySelectorAll('.rf-item').length < p.shown && ui.list.querySelector(':scope > .rf-more-btn'); n++) renderMore();
    const el = itemEl(p.id);
    if (!el) return false;
    el.scrollIntoView({ block: 'start' });
    el.focus({ preventScroll: true });
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
  // `resume`: after a search stopped partway, fetch from where it failed (pages already read
  // come from pageMemo, without a pause).
  async function run(force = false, { resume = false } = {}) {
    if (!force && restoreSession()) return;
    showPartial(null);
    runCtrl?.abort();
    const ctrl = runCtrl = new AbortController();
    const id = ++runId;
    const base = location.href;
    const key = searchKey(base);
    setBusy(true);
    setExport(true);
    try {
      if (force && !resume) pageMemo.clear();
      const onProgress = (m) => { if (id === runId) setStatus(m); };
      // Refresh means "newer than what I'm looking at", so the load-time seed is skipped too.
      const res = await fetchAllPages(base, onProgress, {
        seed: (force && !resume) || Date.now() - bootAt > ROWS_TTL_MS ? null : boot,
        signal: ctrl.signal, keepPartial: true, isCached: memoFresh,
        getPage: (url) => getPage(url, { signal: ctrl.signal, onRetry: (n, ms) => onProgress(`Retrying in ${Math.round(ms / 1000)}s (attempt ${n}/${RETRIES})…`) }),
      });
      if (id !== runId) return; // search changed mid-run; navigation handler already reported it
      if (res.failed) {
        // Show what was read, but don't let a part stand for the whole: no remembered snapshot
        // (unread listings would count as gone), no tab cache, no health sample, not a full crawl.
        learn(res.rows, true, false);
        adopt(key, res.rows, res.truncated, '', null, false);
        textClipped = false; // fresh text, just not every page
        showPartial(res.failed);
        logError(`search: page ${res.failed.page}: ${res.failed.message}`);
        return;
      }
      if (res.sample) rawSample = res.sample;
      let drops = [];
      try { drops = health.record(res.rows); } catch (e) { logError(`health: ${e.message}`); }
      const moved = resultsPath.fallback ? [`results are now under ${resultsPath.key}.${resultsPath.field}`] : [];
      const drift = [...moved, ...drops.map((d) => `${d.field} on ${pct(d.now)} of listings (usually ${pct(d.usual)})`)];
      setWarn('drift', drift.length ? `REA may have changed its data: ${drift.join('; ')}. Run reaFilter.selfcheck() in the console and report it.` : '');
      store.set(key, res.rows, res.truncated);
      const snap = cfg.remember ? snaps.save(key, res.rows, res.truncated) : null;
      setWarn('saved', snap?.refused ? `Not remembered: all ${SNAP_MAX} saved searches are pinned (unpin one under Saved searches).`
        : snap?.evicted.length ? `Stopped remembering ${snap.evicted.map(searchLabel).join(', ')} (${SNAP_MAX} searches at most; pin one to keep it).` : '');
      adopt(key, res.rows, res.truncated, '', snap, true);
      ui.newsSeen?.();
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
  const memoFresh = (url) => { const hit = pageMemo.get(url); return !!hit && !hit.signal?.aborted && Date.now() - hit.at < ROWS_TTL_MS; };
  // Bot check: every fetch (search, Check all, Re-check, card annotation) stops until PAUSE_MS
  // has passed, so retrying doesn't make a block worse. Pages already read are still served.
  const pause = pauseGate(storageOr('sessionStorage'));
  let pauseTimer = 0;
  const pauseMsg = (t) => `REA showed a bot check, so fetching is paused until ${dtf({ hour: 'numeric', minute: '2-digit' }).format(t)}. Browse REA normally for a while; the drawer still works on what's already read.`;
  const pausedErr = (t) => Object.assign(new Error(`Paused: ${pauseMsg(t)}`), { paused: true });
  const showPause = () => {
    const t = pause.until();
    setWarn('paused', t ? pauseMsg(t) : '');
    clearTimeout(pauseTimer);
    if (t) pauseTimer = setTimeout(showPause, t - Date.now() + 1000);
  };
  const tripPause = (e) => { if (!e?.botCheck) return; pause.trip(); logError(`paused: ${e.message}`); showPause(); };
  const getPage = (url, opts) => {
    const hit = pageMemo.get(url);
    // An entry whose run was aborted is about to reject; don't hand it to a new caller.
    if (hit && !hit.signal?.aborted && Date.now() - hit.at < ROWS_TTL_MS) return hit.p;
    const until = pause.until();
    if (until) return Promise.reject(pausedErr(until));
    const p = fetchResults(url, opts).catch((e) => { if (pageMemo.get(url)?.p === p) pageMemo.delete(url); tripPause(e); throw e; });
    pageMemo.delete(url); // re-insert so Map order stays oldest-first for eviction
    pageMemo.set(url, { at: Date.now(), p, signal: opts?.signal });
    if (pageMemo.size > PAGE_MEMO_MAX) pageMemo.delete(pageMemo.keys().next().value);
    return p;
  };
  let knownVer = 0;
  // Insertion-ordered; re-learning an id moves it to the end, oldest evicted past KNOWN_MAX.
  // `observe` = these rows are fresh from REA: record sightings and price changes. Rows
  // replayed from a cache or snapshot are only decorated, or stale prices would register.
  const learn = (rows, observe = true, full = false, features = true) => {
    if (observe) marks.observe(rows, { full, features });
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
    const insp = r.nextInspect ? `<span>Insp ${esc(fmtWhen(r.nextInspect, tzOf(r)))}</span>` : '';
    const ppb = ppbLabel(r) ? `<span>${ppbLabel(r)}</span>` : '';
    // Shortlisted cards show where you're up to (applied, inspected...) and your note on hover.
    const star = r.starred ? `<span class="rf-b-star"${r.note ? ` title="${esc(r.note)}"` : ''}>★ ${r.appStatus ? esc(statusLabel(r.appStatus)) : 'Shortlisted'}${r.note ? ' ✎' : ''}</span>` : '';
    const fresh = isFresh(r) ? '<span class="rf-b-new">New</span>' : '';
    const moved = r.prevPrice ? `<span class="rf-b-${priceDir(r)}">Was ${esc(r.prevPrice)}</span>` : '';
    const availMoved = r.prevAvail ? `<span title="Availability date changed">Avail was ${esc(r.prevAvail)}</span>` : '';
    const pets = r.amen?.pets === 'yes' ? '<span class="rf-b-pets">Pets OK</span>' : '';
    const km = r.km != null ? `<span>${esc(kmLabel(r).replace(' away', ''))}</span>` : '';
    const taken = r.taken ? `<span class="rf-b-taken">${esc(TAKEN_LABELS[r.taken])}</span>` : '';
    return star + taken + fresh + avail + availMoved + moved + pets + km + insp + ppb;
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
  const LBAR_MIN_KEY = `${TOOL_PREFIX}lbar-min`;
  const WIDE_KEY = `${TOOL_PREFIX}wide`;
  const WIDTH_KEY = `${TOOL_PREFIX}width`; // side drawer width you dragged it to
  const DRAWER_MIN = 360, DRAWER_MAX = 900, DRAWER_TWO_COL = 760;
  // Installs auto-update silently, so the drawer says once what changed (lint keeps this in step
  // with @version and the changelog). A first install gets WELCOME instead.
  const WHATS_NEW = { version: '2.23.0', items: [
    'The drawer reopens on the listing you were on after a reload.',
    'Tags say "Pets welcome" or "Pets on application", the heating type, and "Water efficient".',
    'Compact list (d), photo peek (p), resizable drawer and reviewed marks arrived in 2.22.',
  ] };
  const WELCOME = [
    'Set a date (or leave it blank) and press Search all pages to read every page of this search.',
    "Star and hide work here and on REA's own cards.",
    'Everything stays in this browser.',
  ];
  const SEEN_KEY = `${TOOL_PREFIX}seen-version`;
  const verNum = (v) => String(v || '0').split('.').reduce((n, x) => n * 1000 + (+x || 0), 0);
  const wideKey = keyStore(storageOr('localStorage'), WIDE_KEY);
  // Once a day at most, on a search page: saved searches not checked for a day get a small
  // prompt by the launcher. Nothing is fetched unless you click "Check now".
  const REMIND_KEY = `${TOOL_PREFIX}remind-at`;
  const REMIND_EVERY_MS = DAY_MS;
  function remindSaved() {
    const old = document.getElementById('rf-remind');
    if (!cfg.remember || !cfg.remindSaved) { old?.remove(); return; }
    if (old || !isSearchPage(location.href)) return;
    const stale = Object.values(snaps.exportData()).filter((e) => Date.now() - e.at >= REMIND_EVERY_MS);
    const remind = keyStore(storageOr('localStorage'), REMIND_KEY);
    if (!stale.length || Date.now() - (+remind.get() || 0) < REMIND_EVERY_MS) return;
    remind.set(String(Date.now()));
    const oldest = Math.min(...stale.map((e) => e.at));
    const tip = Object.assign(document.createElement('div'), { id: 'rf-remind' });
    tip.setAttribute('role', 'status');
    tip.innerHTML = `${esc(plural(stale.length, 'saved search', 'es'))} not checked for ${esc(ago(Date.now() - oldest).replace(/ ago$/, ''))}.
      <button type="button" data-r="check" class="rf-btn">Check now</button><button type="button" data-r="later" class="rf-btn sec">Later</button>`;
    tip.addEventListener('click', (e) => {
      const b = e.target.closest('[data-r]');
      if (!b) return;
      tip.remove();
      if (b.dataset.r !== 'check') return;
      ui.setOpen(true);
      ui.saved.open = true;
      checkSaved(ui.saved.querySelector('[data-saved-check]'));
    });
    document.body.appendChild(tip);
  }
  const lbarKey = keyStore(storageOr('localStorage'), LBAR_MIN_KEY);
  const lbarMin = { get: () => lbarKey.get() === '1', set: (v) => (v ? lbarKey.set('1') : lbarKey.clear()) };
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
    if (bar._opened !== id) { bar._opened = id; marks.setOpened(id); } // being here is opening it
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
      <button type="button" data-l="h" aria-pressed="${r.hidden && !r.resurfaced}">${hideWord(r)}</button>
      <button type="button" data-l="min" aria-expanded="true" aria-label="Minimise listing tools" title="Minimise">–</button>
      ${r.note ? `<div class="rf-lbar-note">${esc(r.note)}</div>` : ''}${info ? `<div class="rf-lbar-info">${esc(info)}</div>` : ''}`;
    if (focusKey) bar.querySelector(`[data-l="${focusKey}"]`)?.focus();
    // Reached by in-app navigation: the page's data is the previous listing's, so read this one's page.
    if (r.partial && bar._fetching !== id) {
      bar._fetching = id;
      fetch(location.href, { credentials: 'include', signal: withTimeout(null, FETCH_TIMEOUT_MS) }).then((res) => (res.ok ? res.text() : ''))
        .then((html) => { const out = parseListingPage(html, id); if (out.status === 'ok' && bar.dataset.id === id) { const row = safeRow(out.listing, false); if (row) { bar._row = row; renderListingBar(); } } })
        .catch(() => {}).finally(() => { if (bar._fetching === id) bar._fetching = null; if (bar.dataset.id !== id && bar._row?.partial) renderListingBar(); });
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
  const hideWord = (r) => (r.resurfaced ? 'Hide again' : r.hidden ? 'Unhide' : 'Hide');
  // Named per listing, so a screen reader's button list isn't 25 identical "Shortlist"s.
  const cardActsHtml = (r) => {
    const where = esc(String(r.address || '').split(',')[0].trim() || 'listing');
    return `<span class="rf-card-acts">` +
      `<button type="button" data-card-act="s" data-id="${esc(r.id)}" aria-pressed="${!!r.starred}" aria-label="Shortlist ${where}" title="${r.starred ? 'Remove from shortlist' : 'Shortlist'}">${r.starred ? '★' : '☆'}</button>` +
      `<button type="button" data-card-act="h" data-id="${esc(r.id)}" aria-label="${hideWord(r)} ${where}" title="${hideWord(r)} listing">${hideWord(r)}</button></span>`;
  };

  // Opening a listing (drawer card or REA's card; left, middle or ctrl click) marks it opened.
  function watchOpens() {
    const onOpen = (e) => {
      if (e.type === 'auxclick' && e.button !== 1) return;
      if (e.target.closest?.('[data-card-act], .rf-acts, button, select, input')) return;
      const a = e.target.closest?.('a[href]');
      const id = a && (a.closest('.rf-item')?.dataset.id || (/\/property-/.test(a.href) ? listingId(a.href) : ''));
      if (!id) return;
      marks.setOpened(id);
      if (cache) marks.decorate(cache); // so "Not opened yet" and "opened …" reflect it on the next render
      knownVer++;
    };
    document.addEventListener('click', onOpen, true);
    document.addEventListener('auxclick', onOpen, true);
  }

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
      if (act === 'h' && on) offerHideUndo(id, () => { marks.toggle(id, 'h'); refreshMarks(); });
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
  // Cards are REA's <article>s. If REA stops using them, a card is the largest ancestor of a
  // /property- link (up to CARD_CLIMB levels) that still holds links to one listing only.
  const CARD_CLIMB = 8;
  const cardInfo = { mode: 'none', found: 0 }; // for selfcheck()
  // One pass up from every listing link: each ancestor learns the one listing it holds ('' for
  // several), instead of each climb re-querying ever larger subtrees.
  const climber = (links) => {
    const owner = new Map();
    for (const a of links) {
      const id = listingId(a.getAttribute('href'));
      if (!id) continue;
      for (let el = a.parentElement; el; el = el.parentElement) {
        const o = owner.get(el);
        if (o === '') break; // already shared: so are its ancestors
        owner.set(el, o === undefined || o === id ? id : '');
      }
    }
    return (a) => {
      let el = a, best = null;
      for (let d = 0; d < CARD_CLIMB && el.parentElement && el.parentElement !== document.body; d++) {
        el = el.parentElement;
        if (!owner.get(el)) break;
        best = el;
      }
      return best;
    };
  };
  function cardsOnPage() {
    const collect = (links, cardOf) => {
      const cards = new Map();
      for (const a of links) {
        if (a.closest('#rf-panel, #rf-lbar, #rf-toast, #rf-remind')) continue;
        const href = a.getAttribute('href');
        const id = listingId(href);
        if (!id) continue;
        const card = cardOf(a);
        if (!card) continue;
        const prop = /\/property-/.test(href);
        const prev = cards.get(card);
        if (!prev || (prop && !prev.prop) || (!prev.known && known.has(id))) cards.set(card, { id, prop, known: known.has(id) });
      }
      return cards;
    };
    let cards = collect(document.querySelectorAll('article a[href]'), (a) => a.closest('article'));
    cardInfo.mode = 'article';
    if (!cards.size) { const links = document.querySelectorAll('a[href*="/property-"]'); cards = collect(links, climber(links)); cardInfo.mode = cards.size ? 'fallback' : 'none'; }
    cardInfo.found = cards.size;
    return cards;
  }

  // No card recognised on a list page that has listings: say so (after a grace period, since
  // REA renders its cards after the page data arrives), and clear it once cards show up.
  const CARD_WARN_MS = 8000;
  let cardWarnTimer = null;
  const checkCards = (found) => {
    if (found || !cfg.annotate || !known.size || !PAGE_SEG.test(location.pathname) || /\/map-/.test(location.pathname)) {
      clearTimeout(cardWarnTimer); cardWarnTimer = null;
      if (found) setWarn('cards', '');
      return;
    }
    if (cardWarnTimer) return;
    cardWarnTimer = setTimeout(() => {
      cardWarnTimer = null;
      if (isSearchPage(location.href) && !cardsOnPage().size) setWarn('cards', "REA's result cards weren't recognised, so the badges and card buttons are off (the drawer still works). Run reaFilter.selfcheck() in the console and report it.");
    }, CARD_WARN_MS);
  };
  function annotate() {
    if (!isSearchPage(location.href)) return;
    const matches = matchSet();
    const anchor = parseAnchor(cfg.anchor), places = parsePlaces(cfg.places);
    const cards = cardsOnPage();
    checkCards(cards.size > 0);
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
      setDistances(r, cfg, anchor, places);
      const html = badgeHtml(r) + cardActsHtml(r);
      if (!badge) { badge = document.createElement('div'); badge.className = 'rf-badge'; card.appendChild(badge); }
      // Compare against what we wrote, not innerHTML (browser re-serialises entities).
      if (badge.dataset.rfHtml !== html) { badge.innerHTML = html; badge.dataset.rfHtml = html; }
      const m = ruledOut(r) && !cfg.showHidden ? '0' : matches ? (matches.has(id) ? '1' : '0') : '';
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
        m.removedNodes.length === 0 && m.addedNodes.length > 0 && [...m.addedNodes].every((n) => n.classList?.contains('rf-badge')) ||
        [...m.addedNodes, ...m.removedNodes].every((n) => /^rf-(?:toast|remind|lbar)$/.test(n.id || '')) && m.addedNodes.length + m.removedNodes.length > 0); // our own notes on <body>
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
      setWarn('saved', ''); // about the previous search
      fillPresets();
      renderSaved();
      setTimeout(() => enterSearchPresets(key), 0); // after the old search's state is cleared below
      lastKey = key;
      if (cfg.building) { cfg.building = ''; const b = document.getElementById('rf-building'); if (b) b.value = ''; }
      remindSaved();
      if (cacheKey && cacheKey === key) return;
      const hadState = cacheKey || busy;
      runCtrl?.abort(); // stop crawling the old search
      runId++;
      applySnap(null);
      showPartial(null);
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
    // Paste-safe structure of one listing (no descriptions, names or addresses) for issues.
    shape: () => {
      if (!rawSample) return 'No listing seen yet - load a results page or run a search.';
      const out = JSON.stringify({ script: window.reaFilter.version, resultsPath: `${resultsPath.key}.${resultsPath.field}`, listing: shapeOf(rawSample) }, null, 1);
      console.log(out);
      copyText(out).catch(() => {});
      return out;
    },
    // Copyable diagnostics for a bug report: no listing text, no search terms beyond the path.
    selfcheck: () => {
      const rows = cache || [];
      const rates = fillRates(rows), usual = health.usual();
      const report = [
        `rea-enhancement ${window.reaFilter.version}`, `page: ${location.pathname}`, `rows: ${rows.length}${truncated ? ' (truncated)' : ''}`,
        `fields (this search / usual): ${Object.keys(HEALTH_FIELDS).map((k) => `${k} ${pct(rates[k])}/${usual.ema[k] == null ? '?' : pct(usual.ema[k])}`).join(', ')}`,
        `cards: ${cardInfo.found} found (${cardInfo.mode === 'fallback' ? 'fallback: REA no longer uses <article>' : cardInfo.mode})`,
        `results path: ${resultsPath.key ? `${resultsPath.key}.${resultsPath.field}${resultsPath.fallback ? ' (fallback: REA renamed it)' : ''}` : 'not read yet'}`,
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
    step('pause', showPause);
    step('navigation', watchNavigation);
    step('cards', watchCards);
    step('card actions', watchCardActions);
    step('opens', watchOpens);
    step('storage warning', () => writeState.listeners.add((ok) => setWarn('storage', ok ? ''
      : `Couldn't save your last change: this site's browser storage is full (this script uses ${fmtBytes(toolBytes(storageOr('localStorage')))}). Delete saved searches or turn off Remember results in Settings, then try again.`)));
    step('sync', () => window.addEventListener('storage', (e) => {
      // Another tab changed the shortlist/hidden/notes: pick it up here.
      if (e.key === MARKS_KEY || e.key === null) { marks.invalidate(); if (document.getElementById('rf-lbar')) renderListingBar(); refreshMarks(); }
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
    });
    step('saved', renderSaved);
    step('remind', remindSaved);
    step('annotate', ensureVisiblePage);
  }
})();

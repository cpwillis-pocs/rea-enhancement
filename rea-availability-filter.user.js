// ==UserScript==
// @name         REA Availability Filter
// @namespace    https://github.com/cpwillis-pocs/rea-enhancement
// @version      2.36.1
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
  const ROWS_VERSION = 15; // bump when toRow() shape changes
  // Row fields derived at runtime (marks, scores, distances, medians): not worth caching.
  const ROW_RUNTIME = ['_worst', '_worstFor', 'rating', 'fit', 'moveExtra', 'rentNow', 'starred', 'hidden', 'relisted', 'priceHistory', 'note', 'appStatus', 'appAt', 'agencyHidden', 'suburbHidden', 'firstSeen',
    'openedAt', 'reviewedAt', 'hideReason', 'cheaperBy', 'resurfaced', 'checks', 'isNew', 'prevPrice', 'priceDelta', 'prevAvail', 'availDir', 'featChange', 'sinceLast', 'score', 'scoreWhy',
    'km', 'placeKm', '_kmFor', 'median', 'vsMedian', 'medianScope', 'buildingN', 'buildingAddr', 'alsoListed'];
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
  // Characters per remembered search. localStorage (~5M characters) is shared with REA, and three
  // 500-listing searches would take about a third of it; past this the rows furthest down lose
  // their text (amenities are stored computed, so their tags and filters still work).
  const SNAP_ENTRY_BUDGET = 400000;
  const LITE_HEADLINE = 60;
  // Rent trend per remembered search: one point per visit {t, n, m: {beds: median weekly rent}}.
  const TREND_MAX = 12;
  const trendPoint = (rows, t) => {
    const by = new Map();
    for (const r of rows) {
      if (!Number.isFinite(r.priceNum) || r.beds === '' || r.surrounding) continue;
      const b = Math.min(5, Math.max(0, +r.beds || 0));
      if (!by.has(b)) by.set(b, []);
      by.get(b).push(r.priceNum);
    }
    const m = {};
    for (const [b, a] of by) if (a.length >= MEDIAN_MIN) m[b] = quantile(a.sort((x, y) => x - y), 0.5);
    return { t, n: rows.length, m };
  };
  const cleanTrend = (a) => (Array.isArray(a) ? a : []).filter((p) => isObj(p) && typeof p.t === 'number' && typeof p.n === 'number')
    .map((p) => ({ t: p.t, n: p.n, m: Object.fromEntries(Object.entries(isObj(p.m) ? p.m : {}).filter(([b, v]) => /^[0-5]$/.test(b) && Number.isFinite(v))) }))
    .slice(-TREND_MAX);
  // "2-bed median $720 → $690 over 5 weeks · 42 → 55 listings": 2-bed if it has a median at both
  // ends, else 1, 3, studio, 4, 5+. Needs two visits.
  const trendText = (trend) => {
    const a = cleanTrend(trend);
    if (a.length < 2) return '';
    const first = a[0], last = a[a.length - 1];
    const days = Math.round((last.t - first.t) / DAY_MS);
    const span = days >= 14 ? `${Math.round(days / 7)} weeks` : plural(Math.max(1, days), 'day');
    const beds = ['2', '1', '3', '0', '4', '5'].find((b) => b in first.m && b in last.m); // the commonest rental sizes first
    const bedLabel = (b) => (+b === 0 ? 'Studio' : +b === 5 ? '5+ bed' : `${b}-bed`);
    const rent = beds != null ? `${bedLabel(beds)} median ${money(first.m[beds])} → ${money(last.m[beds])} over ${span}` : `over ${span}`;
    return `${rent} · ${first.n} → ${last.n} listings`;
  };
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
  // #region config

  // `building` narrows one search's results, so it is never stored (or carried to the next search).
  // Outcome of the last write of something you chose (shortlist/notes, settings, presets): the UI
  // warns while writes fail (browser storage full; REA's own code shares it) and clears on success.
  const writeState = {
    ok: true, listeners: new Set(),
    report(ok) { if (ok === this.ok) return; this.ok = ok; for (const f of this.listeners) f(ok); },
  };
  // Reading window.localStorage/sessionStorage itself throws when site data is blocked: then
  // every store (settings too) runs in memory, one per name: this page keeps what you do, it just isn't saved.
  const memStore = () => {
    const m = new Map();
    return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, clear: () => m.clear() };
  };
  const memStores = {};
  const storageOr = (name) => { try { return window[name] || (memStores[name] ||= memStore()); } catch { return (memStores[name] ||= memStore()); } };
  const loadCfg = () => {
    try { const { building, ...c } = sanitizeCfg(JSON.parse(storageOr('localStorage').getItem(CFG_KEY))); return c; } catch { return {}; }
  };
  // Another tab may have saved settings since this one loaded: write only the keys this tab
  // changed (after vs before) over what is stored now, so an older tab can't undo them.
  const mergeCfg = (stored, before, after) => {
    const out = { ...stored };
    for (const k of Object.keys(after)) if (after[k] !== before[k]) out[k] = after[k];
    return out;
  };
  // A write of something you chose: success or failure goes to writeState (the storage-full banner).
  const persistJson = (storage, key, value) => {
    try { storage.setItem(key, JSON.stringify(value)); writeState.report(true); return true; } catch { writeState.report(false); return false; }
  };
  const saveCfg = (cfg) => { const { building, ...c } = cfg; persistJson(storageOr('localStorage'), CFG_KEY, c); };

  // Only the amenities the listing answered (most are unknown): what caches and snapshots keep.
  const knownAmen = (amen) => Object.fromEntries(AMENITIES.map((a) => [a.id, amen?.[a.id]]).filter(([, v]) => v === 'yes' || v === 'no'));
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
    // `later(fn)` runs the write: the UI passes a next-task scheduler, so the results paint
    // before this tab's cache is written. The rows are copied now, as they are.
    set(key, rows, truncated, later = (fn) => fn()) {
      const slim = rows.map((r) => {
        const o = { ...r, text: r.text?.length > ROWS_TEXT_MAX ? r.text.slice(0, ROWS_TEXT_MAX) : r.text };
        for (const k of ROW_RUNTIME) delete o[k]; // rebuilt by decorate/score/distance after restore
        if (o.amen) o.amen = knownAmen(o.amen);
        return o;
      });
      const put = () => storage.setItem(ROWS_PREFIX + key, JSON.stringify({ v: ROWS_VERSION, at: now(), truncated, rows: slim }));
      const ours = () => {
        const out = [];
        for (let i = 0; i < storage.length; i++) {
          const k = storage.key(i);
          if (k?.startsWith(ROWS_PREFIX) && k !== ROWS_PREFIX + key) {
            let at = 0;
            // Only `at` is needed, and it is written near the start: no need to parse a 1.5 MB entry.
            try { at = +(String(storage.getItem(k)).slice(0, 80).match(/"at":(\d+)/) || [])[1] || 0; } catch { /* blocked: evict first */ }
            out.push([k, at]);
          }
        }
        return out.sort((a, b) => b[1] - a[1]); // newest first
      };
      later(() => {
        try {
          ours().forEach(([k, at], i) => { if (i >= ROWS_KEEP - 1 || now() - at > ROWS_TTL_MS) storage.removeItem(k); });
          put();
        } catch {
          try { // quota: drop every other cached search and retry once
            for (const [k] of ours()) storage.removeItem(k);
            put();
          } catch { /* unavailable */ }
        }
      });
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
  // `max`: the shortlist copy keeps INSPECT_KEEP; remembered searches and comparisons keep more.
  const MAX_TIME = 8.64e15; // the furthest a Date can hold
  const okTime = (v) => (typeof v === 'number' && Math.abs(v) <= MAX_TIME ? v : null);
  const cleanInspections = (a, max = INSPECT_KEEP) => (Array.isArray(a) ? a : [])
    .map((i) => ({ at: okTime(i?.at), label: clip(i?.label, 80) }))
    .filter((i) => i.label && (i.at == null || i.at >= Date.now() - INSPECT_GRACE_MS)).slice(0, max);
  const SNAP_INSPECT_MAX = 12; // sessions a remembered search keeps per listing
  const clip = (v, n = 300) => (typeof v === 'string' ? v.slice(0, n) : '');
  // A sparser source (eg a property page without agency or inspections) updates what it has
  // and keeps the rest of the stored summary.
  const mergeSummary = (old, next) => ({ ...(isObj(old) ? old : {}),
    ...Object.fromEntries(Object.entries(next).filter(([, v]) => v !== '' && v != null && !(Array.isArray(v) && !v.length))) });
  // Stored and restored links are REA's and images REA's CDN only, so a crafted backup can't make
  // the shortlist, Compare or a printout load anything from elsewhere.
  const reaUrl = (u) => (/^https:\/\/www\.realestate\.com\.au\//.test(safeUrl(u)) ? u : '');
  const reaImg = (u) => (/^https:\/\/([\w-]+\.)*reastatic\.net\//.test(safeUrl(u)) ? u : '');
  const summary = (r) => ({
    u: reaUrl(r.url), a: clip(r.address), p: clip(r.price, 80), v: clip(r.available, 80), i: reaImg(r.img),
    t: clip(r.type, 40), b: scalar(r.beds), ba: scalar(r.baths), c: scalar(r.cars), su: clip(r.suburb, 80),
    in: cleanInspections(r.inspections), w: clip(r.watch, 80), ap: clip(r.applyVia, 30), ab: isYmd(r.applyBy || '') ? r.applyBy : '', le: clip(r.lease, 10), tk: clip(r.taken, 12), bp: r.byAppt ? 1 : 0,
    bo: clip(r.bond, 40), la: typeof r.lat === 'number' ? r.lat : null, ln: typeof r.lng === 'number' ? r.lng : null,
    am: AMENITIES.filter((a) => r.amen?.[a.id] === 'yes').map((a) => a.id), an: AMENITIES.filter((a) => r.amen?.[a.id] === 'no').map((a) => a.id), ag: clip(r.agency, 80),
    sq: typeof r.sqm === 'number' ? sqmOk(r.sqm) : null, sqt: r.sqm != null && r.sqmFromText ? 1 : null,
  });
  // Summary fields a search result always carries in full (empty means none, not unknown).
  const SEARCH_COMPLETE = ['in', 'w', 'ap', 'ab', 'le', 'am', 'an', 'tk', 'bp']; // a deadline the agent took out goes too
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
  // An object's own value only: a checklist item called "constructor" isn't Object.prototype's.
  const own = (o, k) => (o && Object.hasOwn(o, k) ? o[k] : undefined);
  const checkSummary = (r, items) => items.filter((k) => own(r.checks, k)).map((k) => `${r.checks[k] === 'y' ? '✓' : '✗'} ${k}`).join(', ');
  const HIDE_REASONS = ['too small', 'location', 'condition', 'price', 'other'];
  // Why an application was declined (optional, your guess or what the agent said): counted per agency.
  const DECLINE_REASONS = ['another applicant', 'income', 'rental history', 'pets', 'no reply'];
  const FOLLOW_UP_DAYS = 5;
  // After an inspection you were down for: "Inspected?"; inspected a while ago but not applied: "Apply?".
  const ACTION_WINDOW_DAYS = 7, APPLY_NUDGE_DAYS = 2;
  // Taken down, hidden, declined or already taken: nothing left to nudge, route or remind.
  const deadEnd = (r) => !!(r.gone || (r.hidden && !r.resurfaced) || r.appStatus === 'declined' || r.taken);
  const needsAction = (r, now = Date.now()) => {
    if (deadEnd(r)) return '';
    if (r.lastInspect && now - r.lastInspect < ACTION_WINDOW_DAYS * DAY_MS && (!r.appStatus || r.appStatus === 'to inspect') &&
      !(r.inspectAnswered >= r.lastInspect) && !(r.appAt >= r.lastInspect)) return 'inspected';
    if (r.appStatus === 'inspected' && r.appAt && now - r.appAt > APPLY_NUDGE_DAYS * DAY_MS) return 'apply';
    if (r.applyBy && !['applied', 'approved', 'declined'].includes(r.appStatus)) { // the deadline is close and you haven't applied
      const left = (ymdEnd(r.applyBy) - now) / DAY_MS;
      if (left >= 0 && left <= APPLY_BY_SOON_DAYS) return 'applyby';
    }
    return '';
  }; // an application with no answer after this long gets a "follow up?" nudge
  const needsFollowUp = (r, now = Date.now()) => !deadEnd(r) && r.appStatus === 'applied' && !!r.appAt && now - r.appAt > FOLLOW_UP_DAYS * DAY_MS;
  // The Shortlist's "What's next" order: approved first, then what needs doing (soonest deadline
  // first), then the next inspection, then the rest by your rating; ruled out and dead ends last.
  const nextKey = (r, now = Date.now()) => {
    if (r.appStatus === 'approved') return [0, 0];
    if (deadEnd(r)) return [4, 0];
    if (needsAction(r, now) || needsFollowUp(r, now)) return [1, r.applyBy ? +ymdEnd(r.applyBy) : r.appAt || now];
    const next = (r.inspections || []).map((i) => i?.at).filter((at) => typeof at === 'number' && at > now).sort((a, b) => a - b)[0];
    if (next) return [2, next];
    return [3, -(r.rating || 0)];
  };
  // Indexes of the longest strictly increasing run in `seq` (negatives skipped): the listings
  // already in order, so a redraw moves only the rest.
  const inOrder = (seq) => {
    const tails = [], prev = seq.map(() => -1);
    seq.forEach((v, i) => {
      if (v < 0) return;
      let lo = 0, hi = tails.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (seq[tails[mid]] < v) lo = mid + 1; else hi = mid; }
      if (lo) prev[i] = tails[lo - 1];
      tails[lo] = i;
    });
    const out = new Set();
    for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) out.add(i);
    return out;
  };
  const byNext = (rows, now = Date.now()) => rows.map((r) => [nextKey(r, now), r]).sort(([a], [b]) => a[0] - b[0] || a[1] - b[1]).map(([, r]) => r);
  // What changed on the Shortlist since `since` (your last visit): counts, the listings, and a line.
  const sinceChanges = (rows, since, now = Date.now()) => {
    const after = (t) => typeof t === 'number' && t > since;
    const today = ymdLocal(new Date(now)), tomorrow = addDaysYmd(today, 1); // by the calendar: the night clocks change is 23 or 25 hours
    const c = { cheaper: [], dearer: [], gone: [], cancelled: [], changed: [], closing: [] };
    for (const r of rows) {
      if (after(r.priceAt) && r.priceDir) c[r.priceDir === 'down' ? 'cheaper' : 'dearer'].push(r);
      if (after(r.goneAt)) c.gone.push(r);
      if (after(r.cancelledAt)) c.cancelled.push(r);
      if (after(r.availAt) || after(r.featAt)) c.changed.push(r);
      if (r.applyBy && !deadEnd(r) && !['applied', 'approved', 'declined'].includes(r.appStatus) && r.applyBy >= today && r.applyBy <= tomorrow) c.closing.push(r);
    }
    const parts = [[c.cheaper, 'cheaper'], [c.dearer, 'dearer'], [c.gone, 'no longer listed'], [c.cancelled, (n) => `${n === 1 ? 'inspection' : 'inspections'} cancelled`],
      [c.changed, 'date or details changed'], [c.closing, (n) => `${n === 1 ? 'closes' : 'close'} by tomorrow`]].filter(([l]) => l.length).map(([l, w]) => `${l.length} ${typeof w === 'function' ? w(l.length) : w}`);
    return { ...c, ids: new Set(Object.values(c).flat().map((r) => r.id)), text: parts.join(', ') };
  };
  // Your track record per agency across the shortlist: { applied, approved, declined } by agency name.
  const agencyRecord = (rows) => {
    const out = new Map();
    for (const r of rows) {
      if (!r.agency || !['applied', 'approved', 'declined'].includes(r.appStatus)) continue;
      const k = agencyKey(r.agency);
      const v = out.get(k) || { applied: 0, approved: 0, declined: 0, why: {} };
      v.applied++; if (r.appStatus !== 'applied') v[r.appStatus]++;
      if (r.appStatus === 'declined' && r.declineReason) v.why[r.declineReason] = (v.why[r.declineReason] || 0) + 1;
      out.set(k, v);
    }
    return out;
  };
  const recordText = (v) => {
    if (!v) return '';
    const why = Object.entries(v.why || {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(', ');
    return `you: ${v.applied} applied${v.approved ? `, ${v.approved} approved` : ''}${v.declined ? `, ${v.declined} declined${why ? ` (${why})` : ''}` : ''}`;
  };
  const MARK_FIELDS = ['s', 'st', 'd', 'h', 'hr', 'ht', 'hp', 'as', 'ast', 'dr', 'ck', 'qa', 'rv', 'rt']; // user choices a bulk action can change
  const BULK_STAR_MAX = 50; // "shortlist all shown" cap, so one click can't flood the shortlist
  const PRUNE_EVERY = 20;
  const keep = (e) => e.s || e.h || e.n || e.as;
  // Inspection checklist answers: { label: 'y' | 'n' }, labels clipped, at most CHECK_MAX of them.
  const CHECK_MAX = 12;
  // The agent's answers to What to ask: question id ("w:water", "a:pets", "avail") -> y (fine) / n (a problem).
  const QA_ID = /^(?:[wa]:[a-z]{2,12}|avail)$/;
  const cleanQa = (o) => (isObj(o) ? Object.fromEntries(Object.entries(o).filter(([k, v]) => QA_ID.test(k) && (v === 'y' || v === 'n')).slice(0, 40)) : {});
  const cleanChecks = (o) => (isObj(o) ? Object.fromEntries(Object.entries(o).filter(([k, v]) => k && (v === 'y' || v === 'n')).slice(0, CHECK_MAX).map(([k, v]) => [clip(k, 30), v])) : {});
  // Cycle one answer in the entry's map `field` (cleaned first): unset -> y -> n -> unset. An
  // empty map is dropped from the entry. Returns the new answer ('' when unset).
  const cycleTri = (e, field, clean, k) => {
    const o = clean(e[field]), next = !o[k] ? 'y' : o[k] === 'y' ? 'n' : '';
    if (next) o[k] = next; else delete o[k];
    if (Object.keys(o).length) e[field] = o; else delete e[field];
    return next;
  };
  // Address identity for relist detection: needs a street number, ignores case/punctuation.
  // Needs a street number in the street part ("Address available on request, Bondi NSW 2026" has
  // only the postcode, so two such listings aren't the same place).
  const aKeys = new Map(); // address -> key: withBuildings asks twice per row on every refresh
  const addressKey = (a) => {
    a = String(a || '');
    let k = aKeys.get(a);
    if (k !== undefined) return k;
    const street = a.split(',')[0];
    k = !/\d/.test(street) || /\brequest\b/i.test(a) ? '' : a.toLowerCase().replace(/[^a-z0-9/]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (k.length <= 6) k = '';
    if (aKeys.size > 20000) aKeys.clear();
    aKeys.set(a, k);
    return k;
  };
  const PRICE_HISTORY_MAX = 10;
  const SEEN_STEP_MS = 10 * 60e3; // last seen / opened kept to 10 minutes: seeing a listing again sooner writes nothing
  const RELIST_GAP_MS = HOUR_MS; // old listing unseen at least this long before a same-address one counts as a relist
  const agencyKey = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  // Stored summary <-> row-shaped fields (one mapping for import, shortlist and summary()).
  const fromSummary = (d) => ({
    url: reaUrl(d.u), address: d.a, price: d.p, available: d.v, img: reaImg(d.i), type: d.t, beds: d.b, baths: d.ba, cars: d.c, suburb: d.su,
    inspections: cleanInspections(d.in), watch: typeof d.w === 'string' ? d.w : '', applyVia: typeof d.ap === 'string' ? d.ap : '', applyBy: typeof d.ab === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.ab) ? d.ab : '', lease: typeof d.le === 'string' ? d.le : '', taken: typeof d.tk === 'string' && Object.hasOwn(TAKEN_LABELS, d.tk) ? d.tk : '', byAppt: d.bp === 1, bond: d.bo, lat: typeof d.la === 'number' ? d.la : null, lng: typeof d.ln === 'number' ? d.ln : null, agency: d.ag,
    // `an`: what the listing said it doesn't have (kept since 2.35; older summaries read those as unknown).
    amen: Array.isArray(d.am) ? Object.fromEntries(AMENITIES.map((a) => [a.id, d.am.includes(a.id) ? 'yes' : Array.isArray(d.an) && d.an.includes(a.id) ? 'no' : null])) : {},
    sqm: typeof d.sq === 'number' ? sqmOk(d.sq) : null, sqmFromText: d.sq != null && d.sqt === 1,
  });
  // Feature signature: "<detector version>:<amenities yes bitmask>:<heads-up bitmask>" in base 36.
  const FEAT_V = 9; // bump when AMENITIES/WATCHOUTS detection changes, so old signatures aren't compared
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
  // #endregion
  // #region stores
  const marksStore = (storage, now = () => Date.now()) => {
    // `wiped`: storage held marks and now holds none, without this script removing them (site
    // data cleared, or a cleaner extension): the safety copy must not be overwritten then.
    let data = null, raw = null, writes = 0, countMemo = null, had = false, wiped = false;
    const load = () => {
      if (data) return data;
      countMemo = null;
      try { raw = storage.getItem(MARKS_KEY); data = JSON.parse(raw); } catch { data = null; raw = null; }
      if (raw == null && had) wiped = true;
      had = raw != null;
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
    // `choice`: a change you made (not a sighting from a page read), stamped for the safety copy.
    const save = (choice = true) => {
      countMemo = null;
      try {
        if (writes++ % PRUNE_EVERY === 0 || Object.keys(data.m).length > MARKS_MAX) prune();
        if (choice) data.w = now(); // when you last changed these marks (the safety copy compares with it)
        // `w` leads, so another tab can tell a write of sightings only from the first bytes (sameChoices).
        const out = JSON.stringify(data.w ? { w: data.w, ...data } : data);
        storage.setItem(MARKS_KEY, out);
        raw = out;
        writeState.report(true);
      } catch { raw = null; writeState.report(false); /* quota/blocked: re-read next time */ }
    };
    const SUM_NUM = ['b', 'ba', 'c', 'la', 'ln', 'bp', 'sq', 'sqt'], SUM_KEEP = ['in', 'am', 'an']; // summary fields kept as numbers / as given
    const entry = (m, id) => m[id] || (m[id] = { f: now(), l: now() });
    const rowMemo = new Map();
    let listMemo = null; // the whole list, for the stored string it was read from
    const shortlistRow = (id, e) => {
      // Hand-edited or half-written summaries: text fields must be strings, numbers stay numbers.
      const d = Object.fromEntries(Object.entries(e.d).map(([k, v]) => [k, SUM_KEEP.includes(k) ? v
        : SUM_NUM.includes(k) ? (typeof v === 'number' || typeof v === 'string' ? v : '') : typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '']));
      const priceNum = parsePrice(clip(d.p, 80));
      return {
        ...fromSummary(d), id, suburb: d.su || '', priceNum, available: d.v || '-', avail: parseAvail(d.v),
        beds: d.b ?? '', baths: d.ba ?? '', cars: d.c ?? '', bond: d.bo || '', ppb: perBed(priceNum, d.b),
        ...moveIn(d.bo, priceNum), agency: d.ag || '',
        starred: true, hidden: !!e.h, note: e.n || '', appStatus: e.as || '', appAt: e.as && e.ast ? e.ast : null, declineReason: e.as === 'declined' && DECLINE_REASONS.includes(e.dr) ? e.dr : '', listed: null, lastSeen: e.l || null,
        gone: !!e.x, goneAt: e.x || null, checks: cleanChecks(e.ck), answers: cleanQa(e.qa), rating: e.rt >= 1 && e.rt <= 5 ? e.rt : 0,
        // The latest inspection that has already happened (the display list drops past ones).
        lastInspect: Math.max(typeof e.li === 'number' ? e.li : 0, lastPast(d.in, now())) || null,
        inspectAnswered: typeof e.nd === 'number' ? e.nd : 0,
        inspectCancelled: Array.isArray(e.ic) && now() - e.ic[0] < CANCEL_SHOW_MS ? clip(e.ic[1], 80) : '',
        inspectCancelledAt: Array.isArray(e.ic) ? okTime(e.ic[2]) : null, // so a calendar can cancel it
        // When it last changed, for "since your last visit": price (and which way), availability, features, cancellation.
        priceAt: typeof e.pt === 'number' ? e.pt : null, priceDir: typeof e.p === 'number' && typeof e.pp === 'number' && e.p !== e.pp ? (e.p < e.pp ? 'down' : 'up') : '',
        availAt: typeof e.avt === 'number' ? e.avt : null, featAt: typeof e.fst === 'number' ? e.fst : null, cancelledAt: Array.isArray(e.ic) && typeof e.ic[0] === 'number' ? e.ic[0] : null,
      };
    };
    // Read-modify-write of one listing's entry: fn(entry, all marks) returns what the setter returns.
    const edit = (id, fn) => { const { m } = fresh(); const out = fn(entry(m, id), m); save(); return out; };
    const bag = (d, f) => (d[f] = isObj(d[f]) ? d[f] : {});
    const setAs = (e, status) => { if (status) { e.as = status; e.ast = now(); } else { delete e.as; delete e.ast; } if (status !== 'declined') delete e.dr; }; // a reason only while declined
    // Hidden agencies (ag) and suburbs (sb): name -> shown name, keyed case/space-insensitively.
    const NAMED = { ag: 80, sb: 60 };
    const toggleNamed = (f) => (raw) => {
      const name = clip(raw, NAMED[f]), k = agencyKey(name);
      if (!k) return false;
      const b = bag(fresh(), f);
      if (Object.hasOwn(b, k)) delete b[k]; else b[k] = name;
      save();
      return Object.hasOwn(b, k);
    };
    return {
      // `expected`: this script is emptying storage itself (Undo of a restore), not a wipe.
      invalidate(expected = false) { data = null; raw = null; if (expected) had = false; },
      takeWiped() { const w = wiped; wiped = false; return w; },
      // `full`: rows from a complete crawl of a search. Only then is a missing listing evidence of
      // a relist; one page (annotate, boot, re-check) says nothing about the rest.
      observe(rows, { full = false, features = true } = {}) {
        const { m } = fresh();
        const t = now();
        const batch = new Set(rows.map((r) => r.id));
        const anyInspections = rows.some((r) => r.inspections?.length);
        let changed = false;
        for (const r of rows) {
          if (!r.id) continue;
          const was = m[r.id] ? JSON.stringify(m[r.id]) : '';
          const e = m[r.id] || (m[r.id] = { f: t });
          if (!(t - e.l < SEEN_STEP_MS)) e.l = t; // last seen to the step: a reload a minute later writes nothing
          delete e.x; // seen again, so not gone
          if (e.s) {
            const li = Math.max(e.li || 0, lastPast(e.d?.in, t)); // REA drops an inspection once it's over
            const next = summary(r);
            if (features) {
              // Search results are complete for these, so an empty value is news: a cancelled
              // inspection or a dropped clause leaves the shortlist too. (Property pages merge.)
              // A batch with no inspections at all may mean REA stopped sending them: keep what's stored.
              const fields = anyInspections ? SEARCH_COMPLETE : SEARCH_COMPLETE.filter((k) => k !== 'in');
              // Compared with every session REA lists now, not the few kept: an earlier one added would
              // push a later one out of the kept list, and it would look cancelled.
              const all = cleanInspections(r.inspections, Infinity);
              const gone = anyInspections ? cancelledInspection(e.d?.in, all, t) : null;
              if (gone) e.ic = [t, clip(gone.label, 80), gone.at];
              else if (Array.isArray(e.ic) && all.some((i) => i.at === e.ic[2] || i.label === e.ic[1])) delete e.ic; // it came back
              e.d = { ...mergeSummary(e.d, next), ...Object.fromEntries(fields.map((k) => [k, next[k]])) };
            } else e.d = mergeSummary(e.d, next); // keep the shortlist's copy current, never poorer
            if (li) e.li = li;
          }
          if (Number.isFinite(r.priceNum)) {
            if (e.p != null && e.p !== r.priceNum && r.price !== e.ps) { // the same price text read differently (a parser change) isn't a price change
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
            const rolled = av - today > YEARLESS_SKIP_DAYS && (e.av === 0 || e.av <= today); // its date passed (seen as now or not)
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
            if (d.ad[ak] !== prev) changed = true;
          }
          if (!changed && JSON.stringify(e) !== was) changed = true;
        }
        // Sightings, not your choices; nothing new (a reload, the same page again) is no write, so
        // no rewrite of every mark here and no storage event in REA's other tabs.
        if (changed) save(false);
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
          r.rating = e?.rt >= 1 && e.rt <= 5 ? e.rt : 0;
          r.appAt = e?.as && e.ast ? e.ast : null;
          r.declineReason = e?.as === 'declined' && DECLINE_REASONS.includes(e.dr) ? e.dr : '';
          r.agencyHidden = !!(r.agency && ag && Object.hasOwn(ag, agencyKey(r.agency))); // own keys: "Constructor" isn't Object.prototype's
          r.suburbHidden = !!(r.suburb && sb && Object.hasOwn(sb, agencyKey(r.suburb)));
          r.firstSeen = e?.f ? new Date(e.f) : null;
          r.openedAt = e?.o ? new Date(e.o) : null;
          r.reviewedAt = e?.rv ? new Date(e.rv) : null;
          r.hideReason = r.hidden && e?.hr ? e.hr : '';
          r.cheaperBy = r.hidden && typeof e?.hp === 'number' && typeof e.p === 'number' && e.p < e.hp ? e.hp - e.p : 0;
          r.resurfaced = resurfacedEntry(e); // hidden for its price, and it dropped
          r.checks = cleanChecks(e?.ck);
          r.answers = cleanQa(e?.qa);
          // "New" is per search (see snapshotStore); here only REA's own listed date counts.
          r.isNew = r.listed instanceof Date && t - r.listed < NEW_MS;
          r.prevPrice = e && e.pp != null && e.pp !== e.p && e.pt && t - e.pt < PRICE_CHANGE_MS ? e.pps || `$${e.pp}` : '';
          r.priceDelta = r.prevPrice ? e.p - e.pp : 0;
          const availMoved = e && e.pav != null && e.avt && t - e.avt < PRICE_CHANGE_MS && e.pav !== e.av;
          r.prevAvail = availMoved ? (e.pav === 0 ? 'now' : dtf({ day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(e.pav * DAY_MS))) : '';
          r.availDir = availMoved ? e.avd || ((e.av || 0) > (e.pav || 0) ? 'later' : 'sooner') : '';
          r.featChange = e?.pfs && e.fs && e.fst && t - e.fst < PRICE_CHANGE_MS && e.pfs.split(':')[0] === e.fs.split(':')[0] ? featDiff(e.pfs, e.fs) : ''; // same detector only
        }
        return rows;
      },
      // `row` lets a newly shortlisted listing carry its summary for the cross-search view.
      toggle(id, k, row) {
        return edit(id, (e, m) => {
          // Hide flips what you see, including a hide inherited from the listing this one relists.
          if (k === 'h' && resurfacedEntry(e)) stampHide(e, now()); // Hide again, from any button
          else if (k === 'h') { e.h = hiddenOf(e, e.rl ? m[e.rl] : null) ? 0 : 1; stampHide(e, now()); }
          else e[k] = e[k] ? 0 : 1;
          e.rv = now(); // deciding on it counts as having reviewed it
          if (k === 's') {
            if (e.s) { e.st = now(); delete e.ic; if (row) e.d = summary(row); } else { delete e.st; }
          }
          return !!e[k];
        });
      },
      note: (id) => load().m[id]?.n || '',
      setStatus(id, status) {
        if (APP_STATUSES.includes(status)) edit(id, (e) => setAs(e, status));
      },
      // Re-check outcome: gone (REA took it down) or seen again (clears gone).
      setGone(id, gone) {
        edit(id, (e) => { if (gone) { if (typeof e.x !== 'number') e.x = now(); } else delete e.x; }); // gone since it was first found gone
      },
      // Cycle one checklist item: unknown -> yes -> no -> unknown.
      cycleCheck(id, label) {
        const k = clip(String(label || ''), 30);
        return k ? edit(id, (e) => cycleTri(e, 'ck', cleanChecks, k)) : '';
      },
      // Cycle an answer to a What to ask question: unasked -> fine -> a problem -> unasked.
      cycleAnswer(id, qid) {
        return QA_ID.test(qid) ? edit(id, (e) => cycleTri(e, 'qa', cleanQa, qid)) : '';
      },
      // "Didn't go" on the after-inspection prompt: don't ask again for inspections up to now.
      answerInspect(id) { edit(id, (e) => { e.nd = now(); }); },
      // Still not interested at the new price: hidden again from here.
      rehide(id) { edit(id, (e) => { e.h = 1; stampHide(e, now()); }); },
      // The same reason again clears it.
      setDeclineReason(id, reason) {
        edit(id, (e) => { if (DECLINE_REASONS.includes(reason) && e.dr !== reason) e.dr = reason; else delete e.dr; });
      },
      setHideReason(id, reason) {
        edit(id, (e) => { if (HIDE_REASONS.includes(reason)) e.hr = reason; else delete e.hr; });
      },
      // You opened the listing (from the drawer, a card or its page): "opened 2d ago", Not-opened filter.
      // Opened and reviewed are what you looked at, not choices: they don't redraw other tabs
      // (sameChoices), and opening the same listing again within a few minutes writes nothing.
      setOpened(id) {
        if (!isListingId(id)) return;
        const e = entry(fresh().m, id);
        if (now() - e.o < SEEN_STEP_MS) return;
        e.o = now();
        save(false);
      },
      // Your 1-5 after an inspection; the same number again clears it.
      setRating(id, n) {
        return edit(id, (e) => { if (Number.isInteger(n) && n >= 1 && n <= 5 && e.rt !== n) e.rt = n; else delete e.rt; e.rv = now(); return e.rt || 0; });
      },
      setNote(id, text) {
        const n = clip(String(text ?? '').trim(), NOTE_MAX);
        edit(id, (e) => { if (n) e.n = n; else delete e.n; e.rv = now(); });
      },
      // Triage progress that survives visits (unlike "new since last visit"): looked at and moved on.
      setReviewed(ids, on = true) {
        const { m } = fresh();
        let n = 0;
        for (const id of ids) { if (!isListingId(id)) continue; const e = entry(m, id); if (!!e.rv === on) continue; if (on) e.rv = now(); else delete e.rv; n++; }
        if (n) save(false);
        return n;
      },
      // Shortlisted listings from every search, newest-starred first, as drawer rows.
      // Rows are reused while their stored mark is unchanged (and within the same minute, since
      // "past" inspections depend on the time): the Shortlist tab and the listing bar ask often.
      writtenAt: () => +load().w || 0,
      // Another tab's write (its stored string) with the same "you changed" stamp as this copy:
      // sightings only, nothing to redraw for. Unknown (no stamp, an older version's write) is no.
      sameChoices(raw) { const w = /^\{"w":(\d+)[,}]/.exec(raw || '')?.[1]; return w != null && +w === (+load().w || 0); },
      createdAt: () => +load().c || 0,
      shortlist() {
        const { m } = load();
        const minute = Math.floor(now() / 60000), seen = new Set();
        // Same stored marks in the same minute: the same list (a render asks two or three times).
        if (listMemo && raw != null && listMemo.raw === raw && listMemo.minute === minute) return listMemo.out.slice();
        const out = Object.entries(m).filter(([, e]) => e.s && e.d?.u)
          .sort(([, a], [, b]) => (b.st || 0) - (a.st || 0))
          .map(([id, e]) => {
            seen.add(id);
            const sig = `${minute}|${JSON.stringify(e)}`, hit = rowMemo.get(id);
            if (hit?.sig === sig) return hit.row;
            const row = shortlistRow(id, e);
            rowMemo.set(id, { sig, row });
            return row;
          });
        for (const id of rowMemo.keys()) if (!seen.has(id)) rowMemo.delete(id);
        listMemo = raw != null ? { raw, minute, out } : null;
        return out.slice();
      },
      // Backup/restore of what the user chose (shortlist, hidden, notes); sighting history is not exported.
      exportData() {
        const { m } = load();
        const out = {};
        for (const [id, e] of Object.entries(m)) {
          if (keep(e)) out[id] = { x: e.x, s: e.s ? 1 : undefined, st: e.st, h: e.h ? 1 : undefined, n: e.n, as: e.as, ast: e.ast, dr: e.dr, hr: e.hr, ck: e.ck, qa: e.qa, o: e.o, nd: e.nd, li: e.li, ic: e.ic, ht: e.ht, hp: e.hp, rv: e.rv, rt: e.rt, d: e.s ? e.d : undefined };
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
          const seenHere = m[id]?.l; // before entry() creates it: a new entry isn't a sighting
          const cur = entry(m, id);
          if (e.s) { cur.s = 1; cur.st = okTime(e.st) || now(); if (e.d && typeof e.d === 'object') cur.d = summary(fromSummary(e.d)); }
          if (e.h) { cur.h = 1; if (HIDE_REASONS.includes(e.hr)) cur.hr = e.hr; }
          if (okTime(e.x) != null && !(seenHere > e.x)) cur.x = e.x; // seen live here since: not gone
          if (typeof e.n === 'string' && e.n.trim()) cur.n = clip(e.n.trim(), NOTE_MAX);
          if (APP_STATUSES.includes(e.as) && e.as) { cur.as = e.as; cur.ast = okTime(e.ast) || now(); }
          if (cur.as === 'declined' && DECLINE_REASONS.includes(e.dr)) cur.dr = e.dr; else if (cur.as !== 'declined') delete cur.dr;
          if (Number.isInteger(e.rt) && e.rt >= 1 && e.rt <= 5) cur.rt = e.rt;
          const ck = cleanChecks(e.ck); if (Object.keys(ck).length) cur.ck = ck;
          const qa = cleanQa(e.qa); if (Object.keys(qa).length) cur.qa = { ...cleanQa(cur.qa), ...qa };
          if (okTime(e.o) != null) cur.o = Math.max(cur.o || 0, e.o);
          for (const k of ['nd', 'li', 'rv']) if (okTime(e[k]) != null) cur[k] = Math.max(cur[k] || 0, e[k]);
          if (e.h && okTime(e.ht) != null) { cur.ht = e.ht; if (typeof e.hp === 'number') cur.hp = e.hp; }
          if (Array.isArray(e.ic) && okTime(e.ic[0]) != null && typeof e.ic[1] === 'string') cur.ic = [e.ic[0], clip(e.ic[1], 80), okTime(e.ic[2])];
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
    'cars', 'type', 'img', 'surrounding', 'agency', 'lat', 'lng', 'photos', 'floorplan', 'watch', 'applyVia', 'lease', 'availFromText', 'taken', 'byAppt', 'sqm', 'sqmFromText', 'applyBy']; // inspect/nextInspect: re-derived on load
  // Not text: `count` is a number or REA's own text for it ("4+").
  const SNAP_TYPES = { priceNum: 'number', ppb: 'number', lat: 'number', lng: 'number', photos: 'number', sqm: 'number', beds: 'count', baths: 'count', cars: 'count',
    surrounding: 'boolean', floorplan: 'boolean', byAppt: 'boolean', sqmFromText: 'boolean', availFromText: 'boolean', id: 'count' };
  const slimRow = (r) => {
    const o = {};
    for (const k of SNAP_FIELDS) o[k] = typeof r[k] === 'string' ? clip(r[k], SNAP_TEXT_MAX) : r[k];
    for (const k of ROW_DATES) if (k !== 'nextInspect') o[k] = r[k] instanceof Date && !isNaN(r[k]) ? r[k].getTime() : null;
    o.headline = clip(r.headline, 160);
    o.text = clip(r.text, SNAP_TEXT_MAX);
    o.inspections = cleanInspections(r.inspections, SNAP_INSPECT_MAX);
    o.features = (Array.isArray(r.features) ? r.features : []).slice(0, 40).map((f) => clip(f, 80));
    // Stored as computed: the text kept here is clipped, so recomputing could miss a late "no pets".
    // Only known answers are kept (most are unknown): about a fifth of a remembered search's size.
    o.amen = knownAmen(r.amen);
    return o;
  };
  // Also the sanitiser for imported snapshots: every field re-typed, URLs re-checked.
  const fatRow = (o) => {
    const r = {};
    // Each field its own type: a number where text is read (a crafted or broken backup) would
    // throw in every later draw of that search.
    for (const k of SNAP_FIELDS) {
      const v = o?.[k], t = SNAP_TYPES[k] || 'string';
      r[k] = typeof v === 'string' && (t === 'string' || t === 'count') ? clip(v, SNAP_TEXT_MAX)
        : typeof v === 'number' && Number.isFinite(v) && (t === 'number' || t === 'count') ? v
          : typeof v === 'boolean' && t === 'boolean' ? v : '';
    }
    for (const k of ROW_DATES) r[k] = typeof o?.[k] === 'number' ? new Date(o[k]) : null;
    if (r.avail && r.avail < startOfDay(new Date())) r.avail = startOfDay(new Date()); // "now" on the day it was saved is now today
    r.url = reaUrl(r.url); // REA's links and REA's CDN only: a crafted backup can't link or load elsewhere
    r.img = reaImg(r.img);
    r.id = isListingId(o?.id) ? String(o.id) : listingId(r.url);
    r.priceNum = typeof o?.priceNum === 'number' ? o.priceNum : parsePrice(r.price);
    r.ppb = typeof o?.ppb === 'number' ? o.ppb : perBed(r.priceNum, r.beds);
    Object.assign(r, moveIn(r.bond, r.priceNum));
    r.surrounding = !!o?.surrounding;
    r.headline = clip(o?.headline, 160);
    r.text = fold(clip(o?.text, SNAP_TEXT_MAX));
    r.inspections = cleanInspections(o?.inspections, SNAP_INSPECT_MAX).filter((i) => i.label);
    if (!isYmd(r.applyBy || '')) r.applyBy = ''; // a calendar date or nothing (it goes into calendar files)
    if (!Object.hasOwn(TAKEN_LABELS, r.taken || '')) r.taken = ''; // a known code, not "toString"
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
    set(v) { try { storage.setItem(key, v); return true; } catch { return false; /* quota/blocked */ } },
    clear() { try { storage.removeItem(key); } catch { /* blocked */ } },
    // Parsed value, or null when missing or corrupt; callers still check its shape.
    getJson() { try { return JSON.parse(this.get()); } catch { return null; } },
    setJson(v) { this.set(JSON.stringify(v)); },
  });
  const toolKeys = (storage) => {
    const out = [];
    try { for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k && k.startsWith(TOOL_PREFIX)) out.push(k); } } catch { /* blocked */ }
    return out;
  };
  const toolBytes = (storage) => toolKeys(storage).reduce((n, k) => { try { return n + 2 * (k.length + (storage.getItem(k) || '').length); } catch { return n; } }, 0);
  const fmtBytes = (b) => (b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${Math.round(b / 1024)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);

  // Remembered rows as stored (entry flag f:3; f:2 still reads): column names once per search (`rk`), each row an
  // array of values, and REA's URL prefixes dropped. About half the characters of one object per
  // row. In memory and in backups they are plain objects; old unflagged entries still read.
  const REA_ORIGIN = 'https://www.realestate.com.au', IMG_ORIGIN = 'https://i2.au.reastatic.net';
  const ABSENT = '\u0001'; // a key this row didn't have (as distinct from null)
  // f:3 also stores known amenities as "pets,!gas" and coordinates to 5 decimals (about a metre).
  const packUrl = (k, v) => {
    if (k === 'amen' && isObj(v)) return Object.entries(v).filter(([, x]) => x === 'yes' || x === 'no').map(([id, x]) => (x === 'no' ? `!${id}` : id)).join(',');
    if ((k === 'lat' || k === 'lng') && typeof v === 'number') return Math.round(v * 1e5) / 1e5;
    if (typeof v !== 'string') return v;
    return k === 'url' && v.startsWith(`${REA_ORIGIN}/`) ? v.slice(REA_ORIGIN.length) : k === 'img' && v.startsWith(`${IMG_ORIGIN}/`) ? `~${v.slice(IMG_ORIGIN.length)}` : v;
  };
  const unpackUrl = (k, v) => {
    if (k === 'amen' && typeof v === 'string') return Object.fromEntries(v.split(',').filter(Boolean).map((x) => (x[0] === '!' ? [x.slice(1), 'no'] : [x, 'yes'])));
    if (typeof v !== 'string') return v;
    return k === 'url' && v.startsWith('/') ? REA_ORIGIN + v : k === 'img' && v.startsWith('~/') ? IMG_ORIGIN + v.slice(1) : v;
  };
  const packRows = (rows, keys) => rows.map((r) => keys.map((k) => (k in r ? packUrl(k, r[k] === undefined ? null : r[k]) : ABSENT)));
  const unpackRows = (rows, keys) => (Array.isArray(rows) ? rows : []).filter(Array.isArray).map((a) => {
    const o = {};
    keys.forEach((k, i) => { if (i < a.length && a[i] !== ABSENT) o[k] = unpackUrl(k, a[i]); });
    return o;
  });
  const rowKeys = (e) => [...new Set([...(e.rows || []), ...(e.gone || [])].flatMap((r) => Object.keys(r)))];
  const packEntry = (e) => {
    const keys = rowKeys(e);
    return { ...e, f: 3, rk: keys, rows: packRows(e.rows || [], keys), gone: packRows(e.gone || [], keys) };
  };
  const unpackEntry = (e) => {
    if (e.f !== 2 && e.f !== 3) return e; // f:2 (2.28) differs only in keeping amenities as an object
    const keys = Array.isArray(e.rk) ? e.rk.filter((k) => typeof k === 'string') : [];
    const out = { ...e, rows: unpackRows(e.rows, keys), gone: unpackRows(e.gone, keys) };
    delete out.f; delete out.rk;
    return out;
  };
  const snapshotStore = (storage, now = () => Date.now()) => {
    // Parsed copy reused while the stored string is unchanged (several reads per navigation).
    let memo = null, memoRaw = null, sizesMemo = null;
    const load = () => {
      let raw = null;
      try { raw = storage.getItem(SNAP_KEY); } catch { /* blocked */ }
      if (memo && raw != null && raw === memoRaw) return memo;
      memo = parse(raw); memoRaw = raw;
      if (pending) memo.s[pending.key] = pending.entry; // written meanwhile by another tab: this save still wins
      return memo;
    };
    // A save whose trimming and write wait for its `later`: done first by any call that writes or measures.
    let pending = null;
    const flush = () => {
      const p = pending;
      if (!p) return;
      const d = load(); // with this entry in it
      pending = null;
      p.resolve(p.done(d));
    };
    const parse = (raw) => {
      try {
        const d = JSON.parse(raw);
        if (isObj(d) && isObj(d.s)) {
          for (const [k, raw] of Object.entries(d.s)) {
            if (!isSearchKey(k) || !isObj(raw) || okTime(raw.at) == null) { delete d.s[k]; continue; }
            const e = d.s[k] = lazyEntry(raw);
            for (const f of ['ids', 'baseIds']) if (e[f] != null && !Array.isArray(e[f])) e[f] = f === 'ids' ? [] : null;
          }
          return d;
        }
      } catch { /* corrupt */ }
      return { v: 1, s: {} };
    };
    // An entry as read, its rows unpacked only when something reads them (opening one search
    // needn't unpack the other two), and its stored JSON kept for writing it back untouched.
    const lazyEntry = (raw) => {
      const e = { ...raw };
      for (const f of ['rows', 'gone', 'f', 'rk']) delete e[f];
      let full = null;
      const unpacked = () => (full ||= unpackEntry(raw));
      for (const f of ['rows', 'gone']) {
        const own = (v) => Object.defineProperty(e, f, { value: v, writable: true, enumerable: true, configurable: true });
        Object.defineProperty(e, f, { enumerable: true, configurable: true, get: () => { const v = unpacked()[f]; return own(Array.isArray(v) ? v.filter(isObj) : [])[f]; }, set: own });
      }
      entryJson.set(e, () => JSON.stringify(raw)); // as read, worked out only if it's written back
      return e;
    };
    // The stored string, built from each entry's cached JSON: a pin or a second save of one
    // search doesn't re-stringify the other two. Entries are stored packed (packEntry).
    const entryJson = new WeakMap();
    const jsonOf = (e) => {
      let j = entryJson.get(e);
      if (typeof j === 'string') return j;
      j = j ? j() : JSON.stringify(packEntry(e)); // an entry as read (lazyEntry), or built
      entryJson.set(e, j);
      return j;
    };
    const stringify = (d) => `{"v":${JSON.stringify(d.v ?? 1)},"s":{${Object.entries(d.s).map(([k, e]) => `${JSON.stringify(k)}:${jsonOf(e)}`).join(',')}}}`;
    // SNAP_MAX kept, pinned first then newest; on quota, drop older searches, then the gone
    // lists, then give up. Returns the keys it stopped remembering.
    // `evict`: false for a pin, which may trim gone rows to fit but never drops another search.
    const persist = (d, evict = true) => {
      const order = () => Object.keys(d.s).sort((a, b) => (d.s[b].pin ? 1 : 0) - (d.s[a].pin ? 1 : 0) || d.s[b].at - d.s[a].at);
      const evicted = order().slice(SNAP_MAX), removed = {}, goneWas = new Map();
      for (const k of evicted) { removed[k] = d.s[k]; delete d.s[k]; }
      // Storage full: give up the cheapest first, one step at a time: gone rows, then unpinned
      // searches (oldest first, the one just saved last), then pinned ones. `quota` says it was
      // storage, not the 3-search limit.
      let quota = false;
      for (let attempt = 0; attempt < SNAP_MAX + 3; attempt++) {
        try { const out = stringify(d); storage.setItem(SNAP_KEY, out); memo = d; memoRaw = out; return { evicted, ok: true, quota }; } catch {
          memo = null;
          quota = true;
          const ks = Object.keys(d.s), newest = ks.reduce((a, k) => (!a || d.s[k].at > d.s[a].at ? k : a), '');
          const withGone = ks.filter((k) => d.s[k].gone?.length);
          if (withGone.length) { for (const k of withGone) { goneWas.set(d.s[k], d.s[k].gone); d.s[k].gone = []; entryJson.delete(d.s[k]); } continue; }
          if (!evict) break;
          const k = ks.sort((a, b) => (d.s[a].pin ? 1 : 0) - (d.s[b].pin ? 1 : 0) || (a === newest) - (b === newest) || d.s[a].at - d.s[b].at)[0];
          // Down to the one just saved: it can't fit even alone, so nothing is written and what's
          // stored (the others, and its own last copy) stays as it was.
          if (!k) break;
          if (k === newest) {
            // `d` is put back as it came, so a caller can drop that one and try the rest again.
            Object.assign(d.s, removed);
            for (const [e, g] of goneWas) { e.gone = g; entryJson.delete(e); }
            return { evicted: [], ok: false, quota, kept: false };
          }
          removed[k] = d.s[k]; delete d.s[k]; evicted.push(k);
        }
      }
      return { evicted, ok: false, quota };
    };
    // Trims until the entry fits SNAP_ENTRY_BUDGET, cheapest loss first and furthest down first:
    // row text, gone rows' text, then row features and headlines, then gone rows themselves.
    // Each packed row is stringified once; only the rows it trims are stringified again, and the
    // stored string is assembled from the pieces (persist reuses it). Sets `lite` if it trimmed.
    const fitBudget = (entry) => {
      const keys = rowKeys(entry);
      const piece = (r) => JSON.stringify(packRows([r], keys)[0]);
      const rowJ = entry.rows.map(piece), goneJ = entry.gone.map(piece);
      const shell = () => JSON.stringify({ ...entry, f: 3, rk: keys, rows: [], gone: [] });
      const join = () => shell().replace('"rows":[]', () => `"rows":[${rowJ.join(',')}]`).replace('"gone":[]', () => `"gone":[${goneJ.join(',')}]`);
      const lens = (a) => a.reduce((n, j) => n + j.length + 1, a.length ? -1 : 0);
      let size = shell().length + lens(rowJ) + lens(goneJ); // what storage will hold
      if (size <= SNAP_ENTRY_BUDGET) { entryJson.set(entry, join()); return false; }
      const dirtyRows = new Set(), dirtyGone = new Set();
      const len = (r) => JSON.stringify([r.text, r.headline, r.features]).length;
      const trim = (list, dirty, fn) => {
        for (let i = list.length - 1; i >= 0 && size > SNAP_ENTRY_BUDGET; i--) { const was = len(list[i]); fn(list[i]); size -= was - len(list[i]); dirty.add(i); }
      };
      trim(entry.rows, dirtyRows, (r) => { r.text = ''; r.headline = clip(r.headline, LITE_HEADLINE); r.features = r.features.slice(0, 8); });
      trim(entry.gone, dirtyGone, (g) => { g.text = ''; g.features = []; });
      trim(entry.rows, dirtyRows, (r) => { r.features = []; r.headline = ''; });
      for (const i of dirtyGone) goneJ[i] = piece(entry.gone[i]);
      // Stored sizes are packed sizes: measure a gone row the way it will be stored.
      while (entry.gone.length && size > SNAP_ENTRY_BUDGET) { entry.gone.pop(); size -= goneJ.pop().length + 1; }
      for (const i of dirtyRows) rowJ[i] = piece(entry.rows[i]);
      entry.lite = 1;
      // A column only a dropped gone row had: the pieces no longer match, stringify afresh.
      const now = rowKeys(entry);
      if (now.length === keys.length) entryJson.set(entry, join());
      return true;
    };
    const newSince = (ids, baseIds) => {
      if (!baseIds) return new Set();
      const base = new Set(baseIds);
      return new Set((ids || []).filter((id) => !base.has(id)));
    };
    // `rows` is built on first read: save()'s callers only need the diff, and rebuilding every
    // row it just slimmed was a third of the end-of-search work.
    const view = (e) => Object.defineProperty({
      at: e.at, baseAt: e.baseAt ?? null, truncated: !!e.truncated, lite: !!e.lite, trend: cleanTrend(e.trend),
      gone: (e.gone || []).map(fatRow).filter((r) => r.url).map((r) => Object.assign(r, { gone: true })),
      newIds: newSince(e.ids, e.baseIds),
    }, 'rows', { enumerable: true, configurable: true, get() {
      const rows = (e.rows || []).map(fatRow).filter((r) => r.url);
      Object.defineProperty(this, 'rows', { value: rows, enumerable: true });
      return rows;
    } });
    return {
      get(key) {
        const e = load().s[key];
        return e ? view(e) : null;
      },
      save(key, rows, truncated, later = null) {
        flush();
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
        // A new visit adds a trend point; a refresh within the visit replaces the last one.
        const trend = cleanTrend(prev?.trend);
        if (trend.length && !(prev && t - prev.at > SNAP_VISIT_GAP_MS)) trend.pop();
        trend.push(trendPoint(rows, t));
        const entry = d.s[key] = { at: t, baseAt, baseIds, ids, truncated: !!truncated, rows: rows.map(slimRow), gone: gone.slice(0, GONE_MAX), trend: trend.slice(-TREND_MAX), ...(prev?.pin ? { pin: 1 } : {}) };
        // Trimming and writing wait for `later` when given: the diff is all this run needs now.
        const done = (d2) => {
          fitBudget(entry);
          const { evicted, quota, ok, kept } = persist(d2);
          // `refused`: every slot is pinned, or storage is full even for this search alone, so it
          // wasn't kept (its diff still applies to this run).
          return { evicted: evicted.filter((k) => k !== key), refused: evicted.includes(key) || (!ok && kept === false), quota };
        };
        if (!later) { const res = done(d); return Object.assign(view(entry), res); }
        const out = view(entry);
        let resolve;
        out.saved = new Promise((r) => { resolve = r; });
        pending = { key, entry, done, resolve };
        later(flush);
        return out;
      },
      // Pinned searches are the last to be forgotten when a new one is remembered.
      pin(key, on) {
        flush();
        const d = load();
        if (!d.s[key]) return false;
        if (on) d.s[key].pin = 1; else delete d.s[key].pin;
        entryJson.delete(d.s[key]);
        return persist(d, false).ok;
      },
      clear() { flush(); memo = null; try { storage.removeItem(SNAP_KEY); } catch { /* blocked */ } },
      exportData: () => { flush(); return load().s; },
      // Per search: characters stored (as localStorage counts them) and whether it was trimmed.
      // Memoised on the stored string: Settings repaints this on every star or hide.
      sizes() {
        flush();
        const d = load();
        if (sizesMemo && memoRaw != null && sizesMemo.raw === memoRaw) return sizesMemo.out;
        const out = Object.entries(d.s).map(([key, e]) => ({ key, bytes: 2 * jsonOf(e).length, lite: !!e.lite })).sort((a, b) => b.bytes - a.bytes);
        sizesMemo = { raw: memoRaw, out };
        return out;
      },
      // Untrusted: keys must be REA rent search URLs; rows round-trip through fatRow/slimRow.
      importData(src) {
        if (!src || typeof src !== 'object') return 0;
        flush();
        const d = load();
        const got = [];
        const okIds = (a) => (Array.isArray(a) ? a.map(String).filter(isListingId) : null);
        for (const [k, raw] of Object.entries(src)) {
          if (!isSearchKey(k) || !raw || typeof raw !== 'object' || okTime(raw.at) == null) continue;
          const e = unpackEntry(raw); // a pasted stored copy is packed
          if (d.s[k] && d.s[k].at >= e.at) continue; // keep the newer copy
          const rows = (Array.isArray(e.rows) ? e.rows : []).slice(0, IMPORT_ROWS_MAX).map(fatRow).filter((r) => r.url);
          d.s[k] = {
            at: Math.min(e.at, now()), baseAt: okTime(e.baseAt), baseIds: okIds(e.baseIds), // a clock far ahead elsewhere isn't "checked just now" for ever
            ids: rows.map((r) => r.id), truncated: !!e.truncated, rows: rows.map(slimRow),
            gone: (Array.isArray(e.gone) ? e.gone : []).slice(0, GONE_MAX).map(fatRow).filter((r) => r.url).map(slimRow),
            ...(e.pin ? { pin: 1 } : {}), ...(e.lite ? { lite: 1 } : {}), trend: cleanTrend(e.trend), // lite: its text was trimmed before
          };
          fitBudget(d.s[k]);
          got.push(k);
        }
        // Counted as kept: one storage had no room for (evicted at once, or refused) wasn't restored.
        // A refused one is the newest: it's dropped and the rest tried again, so a smaller one still fits.
        let res = persist(d);
        const notKept = [];
        while (res.kept === false) {
          const newest = Object.keys(d.s).reduce((a, k) => (!a || d.s[k].at > d.s[a].at ? k : a), '');
          if (!newest || !got.includes(newest)) break; // one of ours already stored: leave storage as it is
          delete d.s[newest]; notKept.push(newest);
          res = persist(d);
        }
        return got.filter((k) => !res.evicted.includes(k) && !notKept.includes(k)).length;
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
    const save = (d) => persistJson(storage, PRESETS_KEY, d);
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
  // #endregion
  // #region extraction

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
  // `keepPast`: a date already gone stays as it is (a deadline), instead of meaning "now".
  const parseAvail = (display, now = new Date(), { keepPast = false } = {}) => {
    if (!display) return null;
    const today = startOfDay(now);
    const clamp = (d) => (d < today && !keepPast ? today : d);
    // "Available now" up front is today; a "now" later on ("14th Nov - apply now!", "6 weeks from
    // now") is a call to action, so a date in the phrase wins and "now" is only the fallback.
    const NOW = /\b(?:now|immediately|immediate|vacant)\b/i;
    // ("Vacant possession 1st Nov" is the date: vacant on its own is only the fallback.)
    if (/^\W*(?:available\s*|availability\s*)?(?:from\s*|:\s*)?(?:now|immediately|immediate)\b/i.test(display)) return today;
    const d = parseAvailDate(display, today, clamp);
    return d !== undefined ? d : NOW.test(display) && !/\bfrom now\b/i.test(display) ? today : null;
  };
  const parseAvailDate = (display, today, clamp) => {
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
      // "1-Nov-2026", "01-Nov-26": a two-digit year only after a dash ("1 Nov 12 month lease" isn't 2012).
      ...[...display.matchAll(/(\d{1,2})(?:st|nd|rd|th)?(?:\s+of)?(?:\s+|-)([a-z]{3,})\.?(?:,?\s+(\d{4})|-(\d{4}|\d{2})\b(?!\s*-?\s*(?:months?|mths?|weeks?|wks?|years?|yrs?)\b))?/gi)].map((m) => [m[1], m[2], m[3] || (m[4] && (m[4].length === 2 ? `20${m[4]}` : m[4]))]),
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
    // A month alone ("Available from December", "available Jan 2027"): its 1st.
    for (const mo of display.matchAll(/\b(?:available|availability|avail\.|from|in)(?:\s+(?:from|in))?\s*:?\s+([a-z]{3,9})\.?(?:\s+(\d{4}))?\b/gi)) {
      const w = mo[1].toLowerCase();
      // Only as the phrase's last word (or before a year, "onwards", "and"/"or"): "in May", not
      // "in may be", "in Jan Juc", "in Mar St".
      if (!mo[2] && !/^\s*(?:$|[.,;:!?)\-–—]|(?:onwards?|and|or)\b)/i.test(display.slice(mo.index + mo[0].length))) continue;
      const mi = MONTH_NAMES.findIndex((n) => n.startsWith(w) && (w.length === 3 || n === w || (w === 'sept' && n === 'september')));
      if (mi >= 0) return mo[2] ? clamp(new Date(+mo[2], mi, 1)) : yearless(1, mi, today, clamp);
    }
    // Last resort, yearless "1/11" (d/m) and only at the start: slash only ("6-12" is a lease,
    // "1.5" a bathroom count), not "x/7" (a schedule), and not "2/3 bed", "1/2 price", "12/7 days".
    const dm = display.match(/^\W*(?:available\s*)?(?:from\s+|on\s+|date:?\s*)?(\d{1,2})\/(\d{1,2})\b(?![/.-]?\d)(?!\s*(?:days?|price|bed|bath|car|br|off)\b)/i);
    if (dm && dm[2] !== '7') return yearless(+dm[1], +dm[2] - 1, today, clamp);
    return undefined; // no date in it (null: one that isn't a real date)
  };

  // Period words and what they make a weekly figure. A bare "month" / "fortnight" counts only right
  // after the figure ("$2,600 month"): later on it's a lease or a promotion ("- 12 month lease").
  const PRICE_PERIODS = [
    [/\b(?:pw|p\/w|per\s*week|weekly|a\s*week)\b|\/\s*w(?:ee)?k\b/i, 1],
    [/\b(?:per\s*(?:calend[ae]r\s*)?(?:month|mth|mnth|mo)|every\s*month|p\.?\s*c\.?\s*m|pcm|p\.?m\.?|p\/m|monthly|a\s*month)(?![a-z])|\/\s*m(?:on)?(?:th)?\b|\/\s*mo\b|^\s*(?:\/|each)?\s*(?:calend[ae]r\s*)?(?:month|mth)\b/i, 12 / 52],
    [/\b(?:per\s*(?:annum|year)|p\.?\s*a\.?|pa|annually|a\s*year)\b|\/\s*y(?:ea)?r\b/i, 1 / 52],
    [/\b(?:per\s*fortnight|(?:per|every)\s*(?:2|two)\s*weeks|every\s*fortnight|p\.?\s*f\.?|p\/f|pf|fortnightly|a\s*fortnight)\b|\/\s*f(?:ort)?n(?:igh)?t\b|^\s*(?:\/|each)?\s*fortnight\b/i, 1 / 2],
    [/\b(?:per\s*night|p\.?\s*n\.?|pn|nightly|a\s*night)\b|\/\s*n(?:igh)?t\b/i, 7], // short stays
    [/\bper\s*day\b|\/\s*day\b/i, 7],
  ];
  // A promotion or a service isn't the rent's period: "a month free", "monthly cleaning".
  const PERIOD_NOT = /^\s*(?:rent\s*)?(?:free|clean|cleaning|cleans|service|servicing|gardening|inspection|increase|rent\s*free)\b/i;
  // Weekly rent as a number. Ranges take the lower bound; monthly/annual figures are
  // converted so mixed listings sort and filter on one scale. Unparseable -> Infinity.
  const parsePrice = (display) => {
    const s = (display || '').replace(/,/g, '');
    // A figure with "$", or one with a period right after it ("650 per week", "Rent: 650pw").
    const m = s.match(/\$\s*(\d+(?:\.\d+)?)\s*(k\b)?/i) || s.match(/(?<![\d.:/])(\d{2,5}(?:\.\d+)?)()(?=\s*(?:pw|p\/w|per\s*(?:week|month|calend[ae]r|fortnight)|pcm|weekly|\/\s*w(?:ee)?k))/i);
    if (!m) return Infinity;
    let v = +m[1] * (m[2] ? 1000 : 1);
    // Period is read from the text after this figure, up to the next $ amount, so
    // "$800 pw / $3,466 pcm" and "$600 per week (a month free)" stay weekly. A range
    // ("$2,600 - $2,800 per month") takes the period after its second figure.
    const parts = s.slice(m.index + m[0].length).split('$');
    // A time ("open Sat 1 pm") isn't a period: taken out before "pm" can read as per month.
    const tail = (/^\s*(?:-|–|—|to)\s*$/i.test(parts[0]) && parts.length > 1 ? parts[1] : parts[0]).replace(/\b\d{1,2}(?:[:.]\d\d)?\s*[ap]\.?m\b\.?/gi, ' ');
    // The first period named wins: "$2,600 pcm (600 pw)" is monthly, "$600 pw, 1 month free" weekly.
    let at = Infinity, f = 1;
    for (const [re, k] of PRICE_PERIODS) {
      const g = new RegExp(re.source, 'gi');
      for (let m; (m = g.exec(tail));) {
        if (m.index >= at) break;
        if (PERIOD_NOT.test(tail.slice(m.index + m[0].length))) { if (!m[0]) g.lastIndex++; continue; }
        at = m.index; f = k; break;
      }
    }
    v *= f;
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
  // localStorage `paused` = when fetching may resume, for every tab: a second tab fetching into
  // an active bot check would make it worse. An expired value is removed when read.
  const PAUSE_KEY = `${TOOL_PREFIX}paused`;
  const pauseGate = (storage, now = () => Date.now()) => {
    const k = keyStore(storage, PAUSE_KEY);
    // With storage full the write fails: this tab's own pause is then kept in memory, so it still
    // stops (other tabs can't hear of it). A stored pause stays the one truth otherwise.
    let local = 0;
    const until = () => {
      const raw = k.get(), t = Math.max(+raw || 0, local);
      if (t > now()) return t;
      if (raw != null) k.clear();
      local = 0;
      return 0;
    };
    return { until, trip(ms = PAUSE_MS) { const t = now() + ms; local = k.set(String(t)) ? 0 : t; return t; }, clear: () => { local = 0; k.clear(); } };
  };

  // No page data: a bot check (a short interstitial, or one that says so) pauses fetching; a
  // full-size REA page without it means REA changed its format, which pausing would only hide.
  // A full-size page that says it's a check, in its title or its text (scripts left out: a real
  // page may load reCAPTCHA or a bot-protection script, and listings say "just a moment's walk").
  const CHALLENGE_TITLE = /just a moment|attention required|access denied|captcha|robot|security check|verify/i;
  const CHALLENGE_WORDS = /\bcaptcha\b|verify (?:that )?you(?:'re| are) (?:a )?human|are you a robot|access denied|unusual traffic|incapsula|perimeterx|cf-chl/i;
  const FORMAT_MIN_CHARS = 20000; // REA's real pages are hundreds of KB; interstitials a few KB
  const saysChallenge = (html) => CHALLENGE_TITLE.test(html.match(/<title[^>]*>([^<]*)/i)?.[1] || '')
    || CHALLENGE_WORDS.test(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>/gi, ' '));
  const looksLikeFormatChange = (html) => String(html).length >= FORMAT_MIN_CHARS && !saysChallenge(String(html));
  const formatChange = (msg) => Object.assign(new Error(msg), { format: true });
  function extractResults(html) {
    const m = html.match(EXCHANGE_RE);
    if (!m && looksLikeFormatChange(html)) throw formatChange("REA's results page loaded, but its data isn't where the script reads it: REA may have changed its format.");
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
  // Page data as REA ships it (JSON nested in strings): a string is parsed only if it holds the id
  // (digits are never escaped), and only the listing found is unpacked, not the whole page's data.
  function findListing(root, id) {
    const queue = [[root, 0]];
    const packed = (v, parses) => typeof v === 'string' && parses < UNPACK_PARSES && v.includes(id) && /^\s*[[{]/.test(v);
    for (let qi = 0; qi < queue.length && qi < LISTING_SCAN_NODES; qi++) {
      let [o, parses] = queue[qi];
      if (typeof o === 'string') { try { o = JSON.parse(o); parses++; } catch { continue; } }
      if (!o || typeof o !== 'object') continue;
      const own = listingId(str(o._links?.canonical?.href)) || (o.id != null ? String(o.id) : '');
      if (own === id && (o.price || o.availableDate)) return unpackJson(o, parses);
      for (const v of Object.values(o)) if (v && typeof v === 'object' || packed(v, parses)) queue.push([v, parses]);
    }
    return null;
  }
  // -> { status: 'ok', listing } | { status: 'gone' } | { status: 'unknown' }
  const EXCHANGE_RE = /window\.ArgonautExchange\s*=\s*(\{.*?\})\s*;?\s*<\/script>/s; // spacing tolerated
  // What a fetched REA page is, for every fetcher alike: 'ok', 'gone' (removed, or bounced off
  // /property- for a listing), 'forbidden' (403) or 'rate' (429): bot checks; 'challenge': a 200
  // without REA's page data; 'error': anything else. A redirect off the listing is checked before
  // the page data, since REA's home page has none either.
  const classifyPage = ({ status = 200, html = '', redirectedTo = '', listing = false } = {}) => {
    if (status === 403) return 'forbidden';
    if (status === 429) return 'rate';
    if (listing && (status === 404 || status === 410)) return 'gone';
    if (listing && redirectedTo) { try { if (!/\/property-/.test(new URL(redirectedTo).pathname)) return 'gone'; } catch { return 'gone'; } }
    if (status < 200 || status >= 300) return 'error';
    return EXCHANGE_RE.test(html) ? 'ok' : looksLikeFormatChange(html) ? 'format' : 'challenge';
  };
  const BOT_KINDS = new Set(['forbidden', 'rate', 'challenge']);
  function parseListingPage(html, id, { status = 200, redirectedTo = '' } = {}) {
    if (status === 404 || status === 410) return { status: 'gone' };
    if (redirectedTo) { let path = ''; try { path = new URL(redirectedTo).pathname; } catch { /* not a URL: treat as bounced */ } if (!/\/property-/.test(path)) return { status: 'gone' }; } // bounced to a search
    const m = html.match(EXCHANGE_RE);
    if (!m) return { status: 'unknown' };
    try {
      const listing = findListing(JSON.parse(m[1]), id);
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
    // A bare date is that local day (new Date('2026-10-03') is UTC midnight: the 2nd west of it).
    const ymd = typeof raw === 'string' && raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const d = ymd ? new Date(+ymd[1], +ymd[2] - 1, +ymd[3]) : typeof raw === 'number' ? new Date(raw < 1e12 ? raw * 1000 : raw) : new Date(raw);
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
  const SQM_RE = /(?<![\d,.])(\d{1,2},\d{3}|\d{2,4})(?:\.\d+)?\s*(?:sq\.?\s*m(?:etres?|eters?)?(?![a-z])|m2(?![a-z\d])|m²|square\s*met(?:re|er)s?)/gi;
  const SQM_NOT = /\b(?:land|block|lot|site|allotment|parcel|grounds|acreage|balcon(?:y|ies)|courtyard|terrace|garden|yard|backyard|garage|carport|deck|patio|outdoor|alfresco|rooftop|storage|storeroom|shed|pool)\b/;
  // A room's size isn't the home's ("master bedroom 16sqm", "kitchen 20 sqm"), but a bedroom count
  // ("2 bed apartment of 85sqm") is about the home.
  const SQM_ROOM = /(?<!\b(?:\d+|one|two|three|four|five|six)[\s-]*)\b(?:master|bed(?:room)?|kitchen|bath(?:room)?|ensuite|study|laundry|dining)\b/;
  const SQM_ON = /\bon\s+(?:an?\s+)?(?:approx(?:imately|\.)?\s+|about\s+|over\s+)?$/;
  const SQM_SPLIT = /[,.;+&()|/]|\s[-–—]\s|\band\b|\bplus\b|\bwith\b/;
  const sqmFromText = (text) => {
    const t = String(text || '');
    for (const m of t.matchAll(SQM_RE)) {
      const n = sqmOk(parseFloat(m[0].replace(/,/g, '')));
      if (n == null) continue;
      // The words right next to the number say what was measured: "12sqm balcony", "balcony 12sqm", "600sqm block".
      const after = t.slice(m.index + m[0].length, m.index + m[0].length + 30).toLowerCase().split(SQM_SPLIT)[0];
      const before = t.slice(Math.max(0, m.index - 30), m.index).toLowerCase().split(SQM_SPLIT).pop();
      // "set on 650sqm", "house on a 556 m2": a figure the home sits on is land.
      if (!SQM_NOT.test(after) && !SQM_NOT.test(before) && !SQM_ON.test(before) && !SQM_ROOM.test(before) && !SQM_ROOM.test(after.slice(0, 12))) return n;
    }
    return null;
  };
  // Shown wherever floor size filters or sorts: most rentals don't state it, and text reading can misfire.
  const SQM_NOTE = "Floor size is only known when REA's details or the listing text state it, and most rentals don't. Listings without a size are left out by Min m² and go last in the Price per m² sort. Sizes read from the text can be wrong (eg a total that includes a balcony).";
  const perSqm = (r) => (Number.isFinite(r.priceNum) && r.sqm > 0 ? Math.round((r.priceNum / r.sqm) * 100) / 100 : null);
  // The availability as said to someone else (enquiry, copy, calendar, share): without the
  // drawer's "(from text)" marker.
  const availOut = (r) => String(r.available || '').replace(/\s*\(from text\)$/, '');
  const sqmLabel = (r) => (r.sqm ? `${r.sqm} m²${r.sqmFromText ? ' (from text)' : ''}` : '');

  // Amenities from feature labels + description. Negations are checked first, so "no pets"
  // is 'no' rather than matching "pets". State per amenity: 'yes' | 'no' | null (unknown).
  const AMEN_NO = String.raw`\s*[:?\-]\s*(?:no|none|n)\b`; // key/value style: "Pets allowed: No"
  // #endregion
  // #region text heuristics
  const AMENITIES = [
    { id: 'pets', label: 'Pets', yes: 'Pets OK',
      neg: /\bpets?\s*(?:allowed\s*)?(?:[:?]|\s[-–]|\s=)\s*no\b(?! (?:problems?|worries|issues?))|\b(?:strictly )?no[- ](?:pets?|animals|dogs?(?: or cats?)?)\b|\bno (?:smoking|parties)(?:,? or|,? and|,)? pets\b(?!,? (?:are |is )?(?:allowed|welcome|considered|negotiable|ok|okay|permitted|accepted|friendly|on|by|upon|subject)\b)|\bpets? (?:are |is |will )?not (?:be )?(?:allowed|permitted|considered|accepted)\b|\bnot (?:pet[- ]friendly|suitable for pets)\b|\b(?:does|do) not (?:allow|permit|accept) pets\b|\bpet[- ]free\b|\bpets?\s*[-–:]\s*not (?:allowed|permitted|accepted)\b/,
      pos: /\bpets? (?:are )?(?:allowed|welcome|friendly|considered|ok|okay|negotiable|permitted|accepted)\b|\bpet[- ]friendly\b|\bpets? (?:on|by|upon|subject to) (?:application|approval|request)\b|\bpets?\s*(?:[-–:]|\s=)\s*(?:yes|negotiable|allowed|welcome|considered|ok|okay)\b/ },
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
    { id: 'heating', label: 'Heating', yes: 'Heating', neg: /\bno heat(?:ing|ers?)\b(?! (?:bills?|costs?|charges?))/,
      pos: /\b(?<!water )(?:ducted |gas |hydronic |underfloor |floor |split[- ]system |panel )?heat(?:ing|ers?)\b(?! (?:bills?|costs?|charges?))|\b(?:open |gas |wood )?fireplace\b|\breverse[- ]cycle\b/ },
    { id: 'gas', label: 'Gas cooking', yes: 'Gas cooking', neg: /\bno gas\b(?! (?:bills?|costs?|charges?|connection|heating|heaters?|hot water))|\belectric (?:cooking|cooktop|stove) only\b/,
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
    { id: 'watereff', label: 'Water efficient', yes: 'Water efficient', gate: ['water', 'wels'], neg: /\b(?:not|non)[- ]water[- ]efficien|\b(?:does not|doesn't|do not|don't|fails? to|is not|isn't) (?:meet|comply with|compliant with|in compliance with)[^.]{0,30}water[- ]efficien|\bnot (?:compliant|in compliance) with[^.]{0,20}water[- ]efficien/,
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
    return Object.fromEntries(AMENITIES.map((a) => [a.id, a.gate && ![].concat(a.gate).some((g) => text.includes(g)) ? null
      : a.neg.test(text) ? 'no' : !a.pos.test(text) ? null : kv && a.kvNo.test(text) ? 'no' : amenAfter(a, text)])); // kvNo only matches where pos does
  };
  // What follows the mention: "Air-conditioning not included" is a no, "dishwasher space" a maybe.
  const AMEN_EXCLUDED = /^[\s-]*(?:is |are )?(?:not (?:included|provided|supplied)|excluded)\b/, AMEN_ONLY_ROOM = /^[\s-]*(?:space|provision|ready|plumbing|connection)\b/;
  const amenAfter = (a, text) => {
    const m = text.match(a.pos), after = m ? text.slice(m.index + m[0].length, m.index + m[0].length + 30) : '';
    return AMEN_EXCLUDED.test(after) ? 'no' : AMEN_ONLY_ROOM.test(after) ? null : 'yes';
  };
  // cfg.amenities is "pets:yes,furnished:no": require / exclude per amenity.
  const parseAmenCfg = (v) => Object.fromEntries(String(v || '').split(',').map((p) => p.split(':'))
    .filter(([id, st]) => AMENITIES.some((a) => a.id === id) && (st === 'yes' || st === 'no')));
  const AMEN_BY_ID = new Map(AMENITIES.map((a) => [a.id, a]));
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
    { id: 'short', ask: 'Can the lease be 12 months or longer?', label: 'Short lease', re: /\b(?:3|6|three|six)\s*(?:months?|mths?)\b[^.;]{0,20}?\b(?:lease|tenancy|term)\b|\b(?:3|6)\s*(?:-|to|or)\s*12\s*months?|\bshort[- ]term (?:lease|rental|tenancy|stay)|\blease term:?\s*(?:3|6)\s*months?/ },
    { id: 'water', ask: 'How is water usage billed, and is the home water efficient?', gate: ['water'], label: 'Water usage charged', re: /\bwater (?:usage|consumption)\b[^;]{0,50}?\b(?:charged|charges apply|payable|paid by (?:the )?tenants?|billed|invoiced|extra|additional|on top|at (?:the )?tenants?'?s? (?:cost|expense))|\btenants? (?:pays?|to pay|responsible for) (?:all |the )?water/ },
    { id: 'fee', ask: 'Which fees apply, and what are they for?', gate: ['fee'], label: 'Fee mentioned', re: /\b(?:application|holding|admin(?:istration)?|reservation) fees?\b/ },
    { id: 'bid', ask: 'Is the advertised rent the rent you will accept?', gate: ['offer', 'bid'], label: 'Invites higher offers', re: /\b(?:offers?|bids?) (?:above|over|in excess of)\b|\bhighest offer|\bbest offer/ },
    { id: 'strata', ask: 'When will strata approval be known?', gate: ['subject to'], label: 'Subject to strata approval', re: /\bsubject to (?:strata|body corporate|owners? corporation)\b[^.;]{0,25}?\bapproval/ },
    { id: 'break', ask: 'What does breaking the lease cost?', gate: ['break'], label: 'Lease-break terms', re: /\bbreak(?:[- ]lease)?[- ]fees?\b|\blease[- ]break (?:fee|cost|clause)|\bbreaking (?:the|your) lease (?:incurs|costs|will)/ },
    // Appended only: signatures are bitmasks by position (featSig).
    { id: 'clean', ask: 'Is a professional clean required at the end, and is it in the lease?', gate: ['clean'], label: 'Professional clean required', re: /\b(?:professional(?:ly)?|carpets?|steam)(?: end[- ]of[- ]lease| bond)? clean(?:ing)?\b[^.;]{0,30}?\b(?:required|must be|on vacating|upon vacating|at (?:the )?end of)|\bmust be (?:professionally|steam) cleaned\b|\bprofessionally cleaned (?:on|upon|when) vacating\b/ },
    // Charges for paying the rent itself, not application or bond paperwork.
    { id: 'payfee', ask: 'Is there a fee-free way to pay the rent?', gate: ['fee'], label: 'Rent payment fee', re: /(?<!\b(?:application|bond|lodgement|holding|admin)\s(?:and\s)?)\b(?:rent )?(?:payment|processing|transaction|convenience) fees?\b/ },
    { id: 'garden', ask: 'What garden or pool upkeep is expected of you?', gate: ['tenant'], label: 'You maintain garden/pool', re: /\btenants? (?:is |are |will be )?(?:responsible for|to maintain|must maintain|maintains?) (?:the |all )?(?:gardens?|lawns?|yard|pool)\b/ },
    // Noise: said of the home itself ("on a busy road", "above the shops"), not of what's nearby
    // ("close to Parramatta Rd shops", "walk to the station").
    { id: 'road', ask: 'How loud is the road inside with the windows shut?', label: 'Busy road', re: /\b(?:(?:is|sits|located|situated|positioned|set|right)\s+on|fronting|facing|faces|overlook(?:s|ing))\s+(?:a\s+|the\s+)?(?:busy|main|major|arterial)\s+(?:road|rd|highway|hwy)\b|\bon (?:a |the )?(?:busy|major|arterial) (?:road|rd|street|highway|hwy)\b|\b(?:main|busy) road frontage\b/ },
    { id: 'above', ask: 'When is the business below open, and how loud is it?', gate: ['above'], label: 'Above shops/bar', re: /\b(?:located |situated |set |sits |positioned )?above (?:a |the |an? )?(?:local |busy |popular )?(?:shops?|shopfronts?|retail|commercial|bar|pub|hotel|restaurants?|caf[eé]s?|nightclub|club)\b/ },
    { id: 'rail', ask: 'How often do trains pass, including at night?', gate: ['rail', 'train'], label: 'Next to rail line', re: /\b(?:backs? (?:on)?to|backing (?:on)?to|adjacent to|next to|beside|alongside|overlook(?:s|ing))\s+(?:the\s+)?(?:railway|rail(?:way)? (?:line|corridor|tracks?)|train (?:line|tracks?))\b/ },
    { id: 'flight', ask: 'How often do planes fly over, and when?', gate: ['flight'], label: 'Flight path', re: /\b(?:under|on|beneath) (?:the |a )?flight ?path\b/ },
    { id: 'build', ask: 'How long will the construction nearby go on?', gate: ['construct', 'building work', 'develop', 'demoli'], label: 'Construction nearby', re: /\b(?:construction|building works?|demolition)\s+(?:next door|nearby|adjacent|opposite|across the (?:road|street)|on the (?:neighbouring|adjoining) (?:block|site|lot))\b|\bdevelopment (?:next door|on the (?:neighbouring|adjoining) (?:block|site|lot))\b|\bconstruction (?:site|works?) (?:next door|nearby|adjacent)\b/ },
  ];
  // A mention right next to a negation ("no application fee", "water usage not charged", "rent
  // bidding is prohibited", "fee: nil") is the good news, not a heads-up. Checked per clause.
  const WATCH_NEG = /\b(?:no|not|nil|zero|none|never|without|free|waived|prohibited|n\/a)\b|n't\b|\$0(?![.\d]*[1-9])|paid by (?:the )?(?:owner|landlord|lessor)|fee-free/;
  const WATCH_BEFORE = 22, WATCH_AFTER = 14;
  for (const w of WATCHOUTS) w.reG = new RegExp(w.re.source, 'g'); // compiled once; lastIndex reset per use
  const watchOf = (text) => {
    const lower = String(text || '').toLowerCase();
    let clauses = null; // split only once some pattern hits: most listings mention none
    return WATCHOUTS.filter((w) => (!w.gate || w.gate.some((g) => lower.includes(g))) && w.re.test(lower) && (clauses ??= lower.split(/(?<=[.!?;])\s+|\n+/)).some((c) => { // whole-text test first: most listings mention none
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
  // "available now", "Availability: 12/11/2026", "available for lease from 1 Nov". Not "available for
  // inspection", "available to view" (the lookahead also refuses a space, so the gap can't shrink past it).
  const AVAIL_TEXT = /\b(?:availab(?:le|ility)\b|avail\.)\s*(?:for\s+(?:lease|rent(?:al)?|occupancy)\b\s*)?(?:(?:from|on|date|as\s+(?:of|from)|in(?=\s+(?:(?:early|mid|late)\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:\s+\d{4})?\s*(?:$|[.,;!)])))\b\s*)?[:\-–—]?\s*(?![\s:\-–—]|for\b|to\b|by\b|upon\b|with\b|in\b|at\b|until\b|soon\b|as\b|if\b|and\b|or\b|the\b)((?:now|immediately)\b|(?:[^.;,\n()]|\.(?=\d|\s\d{4}\b)){3,32})/i; // a dot between digits is a date ("12.11.2026"), one before a year an abbreviation ("Sept. 2027")
  // Something else being available (an inspection, the agent, parking) isn't the move-in date.
  const AVAIL_NOT_HOME = /\b(?:inspections?(?: times?)?|open homes?|open for inspection|agents?|viewings?|appointments?|parking|car ?spaces?|garages?|storage|lock-?up|keys?|furniture|nbn|internet)\s*(?:is|are)?\s*$/i;
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

  // "Applications close Fri 3 Oct", "closing date for applications: 3/10": the deadline as
  // YYYY-MM-DD ('' when the text doesn't give one). Not "close to shops": the word must follow
  // "applications", or be "closing date".
  const APPLY_BY_G = /\b(?:applications?|apps)\s+(?:(?:now|will)\s+)?(?:close[sd]?|closing|are due|due|must be (?:in|submitted|received|lodged))\b|\bclosing date(?:\s+for\s+applications?)?\b/gi;
  // A weekday alone ("due by 5pm Friday") is the first such day on or after `listedAt` (REA's
  // listed date): never counted from today, which would slide the deadline forward every week.
  const WEEKDAY_ONLY = /^(?:(?:\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)|cob|close of business|midday|noon)\s+)?(?:on\s+|this\s+)?(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?\s*(?:(?:at\s+)?\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm))?\s*$/i;
  const applyByOf = (text, now = new Date(), { listedAt = null } = {}) => {
    const src = String(text || '');
    APPLY_BY_G.lastIndex = 0;
    for (let m; (m = APPLY_BY_G.exec(src));) {
      const tail = src.slice(m.index + m[0].length, m.index + m[0].length + 48).replace(/^[\s:,-]*(?:(?:by|on|is|at|before|this|the|of)\s+)*/i, '');
      if (!/^\d|^(?:mon|tue|wed|thu|fri|sat|sun|cob\b|close of business|midday|noon)/i.test(tail)) continue;
      // This clause only (not "…, lease starts 20 October"), but a comma after a weekday is part of
      // the date ("Fri, 3 Oct"), and a dot between digits is a time or date ("5.30pm", "3.10.2026").
      const clause = tail.replace(/^((?:\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)|noon|midday|cob)),\s*(?=(?:mon|tue|wed|thu|fri|sat|sun|\d))/i, '$1 ') // "5pm, Thursday 8 October"
        .replace(/^((?:\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)\s+|noon\s+|midday\s+|cob\s+)?(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*)\.?,?(?=\s+\d)/i, '$1') // "Thu. 8 Oct", "Fri, 3 Oct" (a date follows)
        .split(/\.(?!\d)|[;,\n]|\s[-–]\s|\s(?:for\s+(?:a\s+)?|with\s+)?(?:lease|tenancy|move|moving|start|starting|from)\b/i)[0].trim(); // not "…, lease from 1/12/2026"
      // A weekday before a yearless d/m ("Tues 6/10"): the d/m form is only read at the start.
      let d = parseAvail(`Available ${clause.replace(/^(?:(?:\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)|noon|midday|cob)\s+)?(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+(?=\d{1,2}\/\d{1,2}\b)/i, '')}`, now, { keepPast: true });
      const wd = !d && clause.match(WEEKDAY_ONLY);
      if (wd && listedAt instanceof Date && !isNaN(listedAt)) {
        d = startOfDay(listedAt);
        d.setDate(d.getDate() + ((dayOf(wd[1]) - d.getDay() + 7) % 7));
      }
      if (d && d < startOfDay(now)) continue; // closed already: a later "now close …" may follow
      // A date with no year rolled far ahead (an old "Friday 3rd October" read in December) isn't
      // this listing's deadline. (A weekday that doesn't match is kept: agents get those wrong.)
      if (d && !/\b20\d\d\b|\d[./]\d{1,2}[./]\d{2,4}/.test(clause) && d - startOfDay(now) > 90 * DAY_MS) continue;
      if (d) return ymdLocal(d);
    }
    return '';
  };
  const APPLY_BY_SOON_DAYS = 3; // the shortlist nudges this close to the deadline
  const applyByLabel = (ymd) => (ymd ? `Apply by ${dtf({ weekday: 'short', day: 'numeric', month: 'short' }).format(ymdStart(ymd))}` : '');

  // How the agent takes applications, when the text names a portal (display only, never contacted).
  const APPLY_VIA = [
    ['2Apply', '2apply', /\b2apply\b/],
    ['Snug', 'snug', /\bsnug\.com\b|\b(?:apply|application)s?\b[^.;]{0,24}\b(?:via|through|on|with|using)\s+snug\b/],
    ['Ignite', 'ignite', /\bignite\.com\b|\b(?:apply|application)s?\b[^.;]{0,24}\b(?:via|through|on|with|using)\s+(?:rea\s+)?ignite\b/],
    ['tApp', 'tapp', /\btapp\b/],
    ['Inspect Real Estate', 'inspect', /\binspect\s?real\s?estate\b/],
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
  // [name, gate, pattern]: the gate word is in every match, so the regex only runs when it's there.
  const applyViaOf = (text) => { const t = String(text || '').toLowerCase(); return APPLY_VIA.find(([, gate, re]) => t.includes(gate) && re.test(t))?.[0] || ''; };

  // Lease term in months from the text: { min, max } or { flexible }; null when not stated.
  // The number must sit next to "lease"/"term": the gap can't cross a comma, a full stop or another number
  // ("available in 2 months, 12 month lease" is 12; "renovated 3 months ago, lease..." is nothing).
  const LEASE_RES = (() => {
    const mo = '\\s*-?\\s*(?:months?|mths?|mo)\\b', gap = '[^.;,\\d]{0,20}?', word = '\\b(?:lease|tenancy|term)', range = '(\\d{1,2})\\s*(?:-|–|to|or|\\/)\\s*(\\d{1,2})';
    // Lists: "6 month or 12 month lease", "6, 12 or 24 month lease"; "Lease: 6 months, 12 months".
    // A bare "N," counts only before more of the list and its "or" ("6, 12 or 24"; not "Level 3, 6 month").
    const n = '\\d{1,2}', item = `(?:${n}\\s*,\\s*)*${n}(?:${mo})?\\s*(?:or|\\/)\\s*`, after = `${n}(?:${mo})?\\s*(?:,|or|and|\\/)\\s*`;
    return [`\\b${range}${mo}${gap}${word}`, `${word}\\b${gap}\\b${range}${mo}`, `\\b(\\d{1,2})${mo}${gap}${word}`, `${word}\\b${gap}\\b(\\d{1,2})${mo}`,
      `\\b((?:${item})+${n})${mo}${gap}${word}`, `${word}(?:\\s+terms?)?\\s*:?\\s*((?:${after})+${n})${mo}`, `\\b(\\d{2,3})\\s*-?\\s*weeks?\\b(?![^.;,\\d]{0,20}?\\b(?:free|rent[- ]free)\\b)${gap}${word}`].map((p) => new RegExp(p));
  })();
  const leaseTermOf = (text) => {
    const t = String(text || '').toLowerCase();
    if (/\bflexible (?:lease|term)s?\b|\blease (?:terms?|length) (?:is )?(?:flexible|negotiable)\b/.test(t)) return { flexible: true };
    const [rangeA, rangeB, oneA, oneB, listA, listB, weeks] = LEASE_RES;
    let m = t.match(listA) || t.match(listB);
    if (m) { const v = m[1].match(/\d+/g).map(Number).filter((x) => x >= 1 && x <= 60); if (v.length) return { min: Math.min(...v), max: Math.max(...v) }; }
    m = t.match(rangeA) || t.match(rangeB);
    if (m) return { min: Math.min(+m[1], +m[2]), max: Math.max(+m[1], +m[2]) };
    m = t.match(oneA) || t.match(oneB);
    if (m && +m[1] >= 1 && +m[1] <= 60) return { min: +m[1], max: +m[1] };
    m = t.match(weeks); // "52 week lease"
    if (m && +m[1] >= 4 && +m[1] <= 260) { const v = Math.round(+m[1] / (52 / 12)); return { min: v, max: v }; }
    m = t.match(/\b(\d)\s*(?:-|–|to|or|\/)\s*(\d)\s*-?\s*(?:years?|yrs?)\b[^.;,\d]{0,12}?\b(?:lease|tenancy|term)/); // "1-2 year lease"
    if (m) return { min: Math.min(+m[1], +m[2]) * 12, max: Math.max(+m[1], +m[2]) * 12 };
    m = t.match(/\b(\d)\s*-?\s*(?:years?|yrs?)\b[^.;,\d]{0,12}?\b(?:lease|tenancy|term)/) || t.match(/\b(?:lease|tenancy|term)\b[^.;,\d]{0,12}?\b(\d)\s*-?\s*(?:years?|yrs?)\b/);
    return m ? { min: +m[1] * 12, max: +m[1] * 12 } : null;
  };
  // Compact form for rows and storage: "6-12", "12", "flex" or "".
  const leaseCode = (l) => (!l ? '' : l.flexible ? 'flex' : l.min === l.max ? String(l.min) : `${l.min}-${l.max}`);
  const leaseFromCode = (c) => { const v = String(c || ''); if (v === 'flex') return { flexible: true }; const m = v.match(/^(\d+)(?:-(\d+))?$/); return m ? { min: +m[1], max: +(m[2] || m[1]) } : null; };
  const leaseLabel = (l) => (!l ? '' : l.flexible ? 'Flexible lease' : l.min === l.max ? `Lease ${l.min} mo` : `Lease ${l.min}–${l.max} mo`);
  const leaseText = (code) => leaseLabel(leaseFromCode(code));

  const WATCH_BY_ID = new Map(WATCHOUTS.map((w) => [w.id, w]));
  const watchIds = (v) => String(v || '').split(',').filter((id) => WATCH_BY_ID.has(id));
  const watchList = (r) => watchIds(r.watch).map((id) => WATCH_BY_ID.get(id));
  const watchTags = (r) => watchList(r).map((w) => w.label);
  // What to ask the agent at an inspection: each heads-up, then each amenity you filter on that
  // the listing doesn't mention, then an unknown availability. Plain questions, no listing text.
  const AMEN_ASK = { pets: 'Are pets allowed?', furnished: 'Is it furnished?', laundry: 'Is the laundry inside the home?', outdoor: 'Is there a balcony, courtyard or yard?',
    robes: 'Are there built-in robes?', stepfree: 'Is there step-free access?', watereff: 'Is the home water efficient?', gas: 'Is the cooking gas?', parking: 'Is the parking secure?' };
  // A listing-page stand-in not read yet (`partial`) knows nothing: only its heads-ups are asked.
  const askItems = (r, amenities = '') => r.partial ? watchList(r).map((w) => ({ id: `w:${w.id}`, q: w.ask })) : [
    ...watchList(r).map((w) => ({ id: `w:${w.id}`, q: w.ask })),
    ...Object.keys(parseAmenCfg(amenities)).filter((id) => r.amen?.[id] == null).map((id) => ({ id: `a:${id}`, q: AMEN_ASK[id] || `Does it have ${AMEN_BY_ID.get(id).label.toLowerCase()}?` })),
    ...(!r.avail && !r.gone ? [{ id: 'avail', q: 'When is it available?' }] : []),
  ].map((x) => ({ ...x, a: r.answers?.[x.id] || '' }));
  // `open`: only what the agent hasn't answered yet (for the enquiry).
  const askList = (r, amenities = '', { open = false } = {}) => askItems(r, amenities).filter((x) => !open || !x.a).map((x) => x.q);
  const questionOf = (id) => (id === 'avail' ? 'When is it available?' : id.startsWith('w:') ? WATCH_BY_ID.get(id.slice(2))?.ask
    : AMEN_ASK[id.slice(2)] || (AMEN_BY_ID.get(id.slice(2)) ? `Does it have ${AMEN_BY_ID.get(id.slice(2)).label.toLowerCase()}?` : '')) || '';
  const answersText = (r) => Object.entries(r.answers || {}).filter(([id]) => questionOf(id)).map(([id, v]) => `${v === 'y' ? '✓' : '✗'} ${questionOf(id)}`).join('; ');
  // A question with its answer mark, for Compare, print and the spreadsheet: "✓ Is there…?".
  const ynMark = (v) => (v === 'y' ? '✓ ' : v === 'n' ? '✗ ' : ''); // a checklist item's or answer's mark, before its text
  const askMarked = (r, amenities = '') => askItems(r, amenities).map((x) => `${ynMark(x.a)}${x.q}`);

  // "Why this tag?": the words around the first match, so a wrong tag can be seen for what it
  // read (and turned into a test case). Text is the row's folded text, so quotes are lowercase.
  const EVIDENCE_W = 30;
  const evidenceOf = (text, re) => {
    const t = String(text || '');
    if (!t || !re) return '';
    const m = new RegExp(re.source, re.flags.replace('g', '')).exec(t.toLowerCase());
    if (!m) return '';
    // The sentence it sits in, clipped to EVIDENCE_W either side at a word boundary.
    let a = Math.max(0, m.index - EVIDENCE_W), b = Math.min(t.length, m.index + m[0].length + EVIDENCE_W);
    const stop = t.slice(a, m.index).search(/[.!?;](?=[^.!?;]*$)/);
    if (stop >= 0) a += stop + 1;
    else if (a > 0) { const ws = t.slice(a, m.index).search(/\s/); if (ws >= 0) a += ws + 1; } // a word boundary, never past the match
    a = Math.min(a, m.index);
    const end = t.slice(m.index + m[0].length, b).search(/[.!?;]/);
    const after = m.index + m[0].length;
    if (end >= 0) b = after + end;
    else if (b < t.length) { const tail = t.slice(after, b), ws = Math.max(tail.lastIndexOf(' '), tail.lastIndexOf('\n'), tail.lastIndexOf('\t')); if (ws >= 0) b = after + ws; }
    const cut = /[.!?;]\s*$/.test(t.slice(0, a)) || a === 0 ? '' : '…', more = b >= t.length || /^[.!?;]/.test(t.slice(b)) ? '' : '…';
    return `${cut}${t.slice(a, b).replace(/\s+/g, ' ').trim()}${more}`;
  };
  const NO_PHRASE = 'Read from the listing text (the saved copy is shortened: Refresh to see the phrase)';
  // [label, why] per tag, in the order amenityTags / watchTags give them.
  const amenityTagItems = (r) => AMENITIES.filter((a) => r.amen?.[a.id] === 'yes').map((a) => {
    const feat = (r.features || []).find((f) => a.pos.test(String(f).toLowerCase()));
    const quote = feat ? '' : evidenceOf(r.text, a.pos);
    return [amenDetail(a.id, r.text) || a.yes, feat ? `From REA's feature list: ${feat}` : quote ? `From the listing text: "${quote}"` : r.text ? NO_PHRASE : '', a.id, quote];
  });
  const watchTagItems = (r) => watchList(r).map((w) => {
    const quote = evidenceOf(r.text, w.re);
    return [w.label, quote ? `From the listing text: "${quote}". Worth asking the agent.` : r.text ? NO_PHRASE : '', w.id, quote];
  });
  // With a keyword filter on: where the first wanted term was found.
  const keywordEvidence = (text, keyword) => {
    const terms = fold(keyword).match(/-?"[^"]+"|\S+/g) || []; // tokenised as keywordTest does, so -"no pets" is one exclusion
    for (const term of terms) {
      if (term.startsWith('-')) continue;
      for (const alt of term.replace(/"/g, '').split('|')) {
        const w = fold(alt).trim();
        if (w && String(text || '').includes(w)) return evidenceOf(text, new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      }
    }
    return '';
  };
  // Per row, reused while its text and tags are unchanged: tooltips were 60% of rendering a listing.
  const tagMemo = new WeakMap();
  const tagItemsOf = (r) => {
    let m = tagMemo.get(r);
    if (!m || m.text !== r.text || m.amen !== r.amen || m.watch !== r.watch || m.features !== r.features) {
      tagMemo.set(r, (m = { text: r.text, amen: r.amen, watch: r.watch, features: r.features, am: amenityTagItems(r), wt: watchTagItems(r) }));
    }
    return m;
  };
  // "Copy as test case": each tag's phrase in the unit tests' table format.
  const testCaseText = (r) => [...amenityTagItems(r), ...watchTagItems(r)].filter(([, , , q]) => q)
    .map(([, , id, q]) => `[${JSON.stringify(q.replace(/^…|…$/g, ''))}, '${id}'],`).join('\n');

  // Extra named places ("Work: -33.87,151.21", one per line, up to 3) shown beside the main point.
  const PLACES_MAX = 3;
  const parsePlaces = (v) => String(v || '').split(/\n+/).map((line, i) => {
    const m = line.match(/^\s*([^:]{1,24}?)\s*:(?!\/\/)\s*(.+)$/); // a link's "://" isn't a label
    const at = parseAnchor(m ? m[2] : line);
    return at ? { label: (m ? m[1] : `Place ${i + 1}`).trim(), ...at } : null;
  }).filter(Boolean).slice(0, PLACES_MAX);
  // Distances for one row: main point (r.km) and each place (r.placeKm), memoised per settings + position.
  const setDistances = (r, cfg, anchor = parseAnchor(cfg.anchor), places = parsePlaces(cfg.places)) => {
    const k = `${cfg.anchor}|${cfg.places}|${r.lat}|${r.lng}`;
    if (r._kmFor === k) return;
    r.km = kmBetween(anchor, r);
    r.placeKm = places.map((p) => ({ label: p.label, km: kmBetween(p, r) })).filter((p) => p.km != null);
    r._kmFor = k;
  };
  // Worst of all distances: "nearest to all" means the longest trip is shortest.
  // Cached per distance set (setDistances' key): the "nearest to all" sort asks it per comparison.
  const worstKm = (r) => {
    if (r._kmFor != null && r._worstFor === r._kmFor) return r._worst;
    let w = r.km ?? null;
    for (const p of r.placeKm || []) if (p.km != null && (w == null || p.km > w)) w = p.km;
    if (r._kmFor != null) { r._worst = w; r._worstFor = r._kmFor; }
    return w;
  };
  // Straight-line km between two points to one decimal, or null when either has no location.
  const kmBetween = (a, b) => (a && b && Number.isFinite(a.lat) && Number.isFinite(b.lat) ? Math.round(haversineKm(a, b) * 10) / 10 : null);

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
  const kmLabel = (r) => (r.km == null ? '' : `${kmShort(r.km)} away`);

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
      // Addresses (any street number, most street types), emails, phone numbers (incl. "(02) 5550 0123").
      const personal = /\b\d{1,5}[a-z]?\s+(?:[\w'-]+\s+){1,3}(?:st|street|rd|road|ave|avenue|pde|parade|cres|crescent|dr|drive|ln|lane|pl|place|ct|court|hwy|highway|tce|terrace|way|cl|close|bvd|boulevarde?|blvd|esplanade|esp|grove|gr|rise|circuit|cct|walk|square|sq|mews|row|loop|link|vista|parkway|pkwy)\b|@|\b\d{4}\s\d{4}\b|(?:\+?61|\b0|\(0\d\))[\s-]?\d(?:[\s-]?\d){7,}|\(0\d\)\s*\d{4}\s*\d{4}|\b\d{4}[\s-]?\d{3}[\s-]?\d{3}\b/i.test(v);
      return SHAPE_KEEP.test(key) && v.length <= 40 && !personal ? v : `string(${v.length})`;
    }
    return typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : typeof v;
  };
  const sampleOf = (results) => itemsOf(results?.exact).find((i) => i?.listing)?.listing ?? null;
  const rowsFrom = (results) => [
    ...itemsOf(results?.exact).map((i) => i?.listing && safeRow(i.listing, false)),
    ...itemsOf(results?.surrounding).map((i) => i?.listing && safeRow(i.listing, true)),
  ].filter(Boolean);

  // #endregion
  // #region rows
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
    // Curly apostrophes straightened: every "n't" negation is written with a straight one.
    const said = [row.headline, str(listing.description), ...row.features].join(' ').replace(/[\u2018\u2019\u02bc]/g, "'");
    row.watch = watchOf(said).join(',');
    row.applyVia = applyViaOf(said);
    row.applyBy = applyByOf(said, undefined, { listedAt: row.listed });
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
    row.amen = amenitiesOf({ features: row.features, amenText: [row.headline, str(listing.description)].filter(Boolean).join(' ').replace(/[\u2018\u2019\u02bc]/g, "'") });
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
      let res, err, body;
      // The body too: a download that breaks off or times out is retried like a failed request.
      try { res = await fetchImpl(url, { credentials: 'include', signal: withTimeout(signal, FETCH_TIMEOUT_MS) }); if (res.ok) body = await res.text(); } catch (e) { err = e; }
      signal?.throwIfAborted();
      const retryable = err || res.status === 429 || res.status >= 500;
      if (!retryable) {
        if (res.status === 403) throw botCheck(`REA refused the request (HTTP 403) - probably a bot check.`);
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
        return extractResults(body);
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
  // skips the polite pause before a page that won't be fetched (eg on Resume). `onPage(rows, page, max)`
  // after each page read, with the rows so far, so a caller can show them before the last page.
  // `lastFetchAt()`: when the caller's last real request ended; the pause counts from then (a page
  // served from memory isn't a request to space out from).
  async function fetchAllPages(base, onProgress, { seed = null, fetchImpl, wait = sleep, getPage = null, signal, keepPartial = false, isCached = () => false, onPage = null, lastFetchAt = null } = {}) {
    const rows = [];
    const key = searchKey(base);
    let page = 1, max = 1, total = 1, sample = null, paging = '';
    const ids = new Set();
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
      // Guards against REA changing how it pages: a page count gone missing reads one page and
      // says so; a later page that repeats what came before (REA ignoring /list-N) stops there
      // rather than reading page 1 twenty times.
      const got = rowsFrom(results);
      if (page > 1 && got.length && got.every((r) => ids.has(r.id))) { paging = 'repeat'; break; }
      if (page > 1 && !got.length) { paging = 'empty'; break; } // the page count promised more: don't read on through blanks
      const pages = results.pagination?.maxPageNumberAvailable;
      if (page === 1 && !pages && got.length >= PAGE_FULL) paging = 'missing';
      total = pages || 1;
      max = Math.min(total, MAX_PAGES);
      for (const r of got) ids.add(r.id);
      rows.push(...got);
      sample ??= sampleOf(results);
      onPage?.(rows, page, max);
      page++;
      const nextSeeded = seed && seed.key === key && seed.page === page;
      if (page <= max && !seeded && !nextSeeded && !isCached(pageUrl(base, page))) {
        const gap = jitter(PAGE_DELAY_MS) - (lastFetchAt ? Date.now() - lastFetchAt() : 0);
        if (gap > 0) await wait(gap, signal);
      }
    } while (page <= max);
    return { rows, truncated: total > MAX_PAGES, sample, ...(paging ? { paging } : {}) };
  }
  const PAGING_MSG = {
    repeat: 'A later results page repeated the first, so the search stopped there: REA may have changed how it pages results.',
    empty: 'A later results page came back empty, so the search stopped there: REA may have changed how it pages results.',
    missing: "REA's page count wasn't found, so only the first page was read: REA may have changed how it pages results.",
  };
  const PAGE_FULL = 20; // a results page this full with no page count is probably not the last

  // --------------------------------------------------------------- filter
  // #endregion
  // #region filters and sorts

  // The drawer's Settings section, one entry per setting: it draws the markup (settingsHtml),
  // gives the default, the name a restore preview uses, whether a backup carries it, and which
  // values sanitizeCfg accepts. kind: check | select | date | int | text | textarea. `group`
  // gathers entries into a fieldset; `after` names fixed markup drawn after the entry.
  const WEIGHT_OPTS = [['0', 'Ignore'], ['1', 'Less'], ['2', 'Normal'], ['3', 'More']];
  const NOTICE_MAX = 120; // days: the longest notice period Settings takes
  const SETTINGS = [
    { key: 'annotate', section: 'Display', kind: 'check', def: true, label: "Show badges and buttons on REA's result cards", name: 'card badges' },
    { key: 'dimCards', section: 'Display', kind: 'check', def: true, label: "Fade REA cards that don't match filters", name: 'card fading' },
    { key: 'compact', section: 'Display', kind: 'check', def: false, label: 'Compact list', help: 'Small photos and the key facts only, so about twice as many listings fit on screen (d).', name: 'compact list' },
    { key: 'theme', section: 'Display', kind: 'select', def: '', label: 'Theme', options: [['', 'System'], ['light', 'Light'], ['dark', 'Dark']], name: 'theme' },
    ...[['wRent', 'Rent'], ['wTiming', 'Timing'], ['wDist', 'Distance'], ['wMovein', 'Move-in']].map(([key, label]) => ({ key, kind: 'select', def: '2', label, options: WEIGHT_OPTS, group: 'How much each counts', name: 'weights', section: 'Best match' })),
    { key: 'periodic', section: 'Your move', kind: 'check', def: false, label: 'My lease is periodic (month to month, no end date)', name: 'periodic lease',
      help: "A periodic lease ends one notice period after you give notice. Until you do, it's counted from today, so set your notice period below." },
    { key: 'leaseEnd', section: 'Your move', kind: 'date', def: '', label: 'My current lease ends (optional)', name: 'lease end',
      help: "Shows the overlap you'd pay, or the gap you'd need to cover, for each listing (sort: Least overlap)." },
    { key: 'noticeDays', section: 'Your move', kind: 'int', def: '', min: 1, max: NOTICE_MAX, label: 'Notice I must give (days, optional)', placeholder: "check your state's rules", name: 'notice period',
      help: "Days before your lease ends that you must tell your landlord or agent. It depends on your state and your lease, so check them. Needs your lease end above; the Shortlist and the calendar export then remind you." },
    { key: 'noticeGiven', section: 'Your move', kind: 'date', def: '', label: 'Notice given on (optional)', name: 'notice given',
      help: 'Once you have given notice: the reminders stop.' },
    { key: 'moveDate', section: 'Your move', kind: 'date', def: '', label: 'Moving day (optional)', name: 'moving day',
      help: "Once you're approved somewhere: the Shortlist shows your moving list, and the calendar export adds moving day and when the condition report is due." },
    { key: 'ecrDays', section: 'Your move', kind: 'int', def: '', min: 1, max: 30, label: 'Days to return the condition report (optional)', placeholder: "check your state's rules", name: 'condition report days',
      help: "After you move in, you have a set number of days to return the entry condition report. It depends on your state, so check its rules. Needs your moving day." },
    { key: 'moveCosts', section: 'Your move', kind: 'int', def: '', min: 0, max: 100000, step: 50, label: 'Other moving costs, $ (optional)', placeholder: 'eg 1500', name: 'moving costs',
      help: 'Removalists, cleaning, connections: added to Cash to move, its sort and its filter.' },
    { key: 'rentNow', section: 'Your move', kind: 'int', def: '', min: 0, max: 20000, step: 10, label: 'My current rent, $ a week (optional)', placeholder: 'eg 650', name: 'current rent',
      help: 'Shows how much more or less a week each listing costs than now, in the list, Compare and the spreadsheet export.' },
    { key: 'income', section: 'Your move', kind: 'int', def: '', min: 0, max: 99999999, step: 1000, label: 'Household income, $ a year before tax (optional)', placeholder: 'eg 120000', name: 'income',
      help: () => `Shows rent as a share of income (over ${RENT_STRESS_PCT}% is flagged) and sets Best match's budget when no max rent is set. Stays in this browser.` },
    { key: 'icsAlarm', section: 'Reminders & templates', kind: 'select', def: '60', label: 'Calendar reminder', help: 'Some calendar apps ignore reminders in imported files.', options: [['0', 'None'], ['30', '30 min before'], ['60', '1 hour before'], ['120', '2 hours before']], name: 'calendar reminder' },
    { key: 'checklist', section: 'Reminders & templates', kind: 'textarea', rows: 2, def: '', maxLength: 400, label: 'Inspection checklist (comma-separated)', placeholder: () => CHECKLIST_DEFAULT, name: 'checklist' },
    { key: 'packList', section: 'Reminders & templates', kind: 'textarea', rows: 2, def: '', maxLength: 300, label: 'Application pack (comma-separated)', placeholder: () => PACK_DEFAULT, name: 'application pack',
      help: 'What agents usually ask for when you apply. Tick what you have ready on the Shortlist; the apply reminders say how much is. Names only: no documents are stored.' },
    { key: 'movingList', section: 'Reminders & templates', kind: 'textarea', rows: 2, def: '', maxLength: 400, label: 'Moving list (comma-separated)', placeholder: () => MOVING_DEFAULT, name: 'moving list' },
    { key: 'enquiry', section: 'Reminders & templates', kind: 'textarea', def: '', maxLength: 600, rows: 3, label: 'Enquiry message (Copy enquiry)', placeholder: () => `eg ${enquiryText({ address: '10 Example St, Bondi', price: '$650 per week', available: 'Available now', inspections: [{ label: 'Sat 11 Oct, 10:00am' }] }, '')}`, name: 'enquiry template',
      help: 'Placeholders: {address} {price} {available} {inspection} {link}, {questions} for what to ask (heads-ups, features you filter on it doesn\'t mention), and {mytimes} for your inspection times. Keep personal details out: this is stored in your browser on REA\'s site.' },
    { key: 'remember', section: 'Your data', kind: 'check', def: true, label: 'Remember results between visits', backup: false }, // a backup made with it off mustn't delete remembered searches
    { key: 'remindSaved', section: 'Your data', kind: 'check', def: true, label: 'Remind me to check saved searches (at most daily)', backup: false, after: 'storage' },
  ];
  const SETTING_BY_KEY = new Map(SETTINGS.map((x) => [x.key, x]));
  const settingOk = (k, v) => {
    if (k === 'packDone' || k === 'moveDone' || k === 'ecrDone') return v.length <= 2000; // ticks: item names, a listing id
    const x = SETTING_BY_KEY.get(k);
    if (!x) return true;
    if (x.kind === 'select') return x.options.some(([o]) => o === v);
    if (x.kind === 'int') return v === '' || (/^\d+$/.test(v) && +v >= x.min && +v <= x.max);
    if (x.kind === 'text' || x.kind === 'textarea') return v.length <= x.maxLength;
    return true; // checks by type; dates by CFG_DATES
  };
  const settingsHtml = (fixed = {}) => {
    const val = (v) => esc(typeof v === 'function' ? v() : v);
    const one = (x) => {
      const t = x.title ? ` title="${val(x.title)}"` : '', it = x.inputTitle ? ` title="${val(x.inputTitle)}"` : '';
      const ph = x.placeholder ? ` placeholder="${val(x.placeholder)}"` : '', id = `rf-${x.key}`;
      // Explanations are text on the page (tied to the field for screen readers), not a hover-only title.
      const db = x.help ? ` aria-describedby="${id}-help"` : '', help = x.help ? `<small class="rf-set-help" id="${id}-help">${val(x.help)}</small>` : '';
      if (x.kind === 'check') return `<label class="rf-check"${t}><input type="checkbox" id="${id}"${db}>${esc(x.label)}</label>${help}`;
      if (x.kind === 'select') return `<label${t}>${esc(x.label)}<select id="${id}"${db}>${x.options.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select></label>${help}`;
      if (x.kind === 'textarea') return `<label${t}>${esc(x.label)}<textarea id="${id}" rows="${x.rows}" maxlength="${x.maxLength}"${ph}${it}${db}></textarea></label>${help}`;
      const input = x.kind === 'date' ? 'type="date"' : x.kind === 'int' ? `type="number" min="${x.min}"${x.max < 99999999 ? ` max="${x.max}"` : ''} step="${x.step || 1}" inputmode="numeric"` : `type="text" maxlength="${x.maxLength}"`;
      return `<label${t}>${esc(x.label)}<input ${input} id="${id}"${ph}${it}${db}></label>${help}`;
    };
    let out = '', section = '';
    for (let i = 0; i < SETTINGS.length; i++) {
      const x = SETTINGS[i];
      if (x.section && x.section !== section) { section = x.section; out += `<h3 class="rf-sect">${esc(section)}</h3>`; }
      if (x.group) {
        const g = [];
        while (SETTINGS[i]?.group === x.group) g.push(SETTINGS[i++]);
        i--;
        out += `<fieldset class="rf-weights"><legend>${esc(x.group)}</legend>${g.map(one).join('')}</fieldset>`;
      } else out += one(x);
      if (x.after) out += fixed[x.after] || '';
    }
    return out;
  };
  const DEFAULT_CFG = {
    from: '', to: '', withinDays: '', exactOnly: false,
    priceMin: '', priceMax: '', upfrontMax: '', cashMax: '', bedsMin: '', bathsMin: '', carsMin: '', sizeMin: '',
    type: '', keyword: '', hideNoImage: false, hideTaken: false, inspectOn: '', inspectWhen: '', inspectFree: '', staleOnly: false, amenities: '', anchor: '', maxKm: '', floorplanOnly: false, sort: 'avail', sortDesc: false,
    onlyStarred: false, showHidden: false, places: '', newOnly: false, changedOnly: false, unopenedOnly: false, unreviewedOnly: false, noWatch: '', leaseMin: '', onePerBuilding: false, building: '', showGone: false, packDone: '', moveDone: '', ecrDone: '', slSort: '', slSeenAt: '',
    ...Object.fromEntries(SETTINGS.map((x) => [x.key, x.def])),
  };

  // Settings a backup carries: your own setup (places, checklist, template, weights, theme…),
  // not this search's filters. Restored through sanitizeCfg, so a hand-edited file can't break it.
  // Not `remember`/`remindSaved`: restoring a backup made with Remember off must not delete this
  // browser's remembered searches.
  const BACKUP_CFG_SKIP = new Set([...SETTINGS.filter((x) => x.backup === false).map((x) => x.key), 'slSeenAt']); // the visit stamp is this browser's
  const backupCfg = (c) => { const ok = sanitizeCfg(c); return Object.fromEntries(DISPLAY_PREFS.filter((k) => k in ok && !BACKUP_CFG_SKIP.has(k)).map((k) => [k, ok[k]])); };
  // What a restore would do, shown before anything is merged.
  const SETTING_NAMES = { ...Object.fromEntries(SETTINGS.filter((x) => x.name).map((x) => [x.key, x.name])),
    places: 'places', inspectFree: 'inspection times', packDone: 'application pack', moveDone: 'moving list', ecrDone: 'condition report', slSort: 'Shortlist order', slSeenAt: 'last Shortlist visit', anchor: 'distance point', sort: 'sort', sortDesc: 'sort' };
  const backupSummary = (data, cur) => {
    const m = isObj(data?.m) ? Object.entries(data.m).filter(([id, e]) => isListingId(id) && isObj(e)) : [];
    const c = backupCfg(data?.cfg);
    return {
      listings: m.length, shortlisted: m.filter(([, e]) => e.s).length, hidden: m.filter(([, e]) => e.h).length,
      searches: isObj(data?.snapshots) ? Object.keys(data.snapshots).filter(isSearchKey).length : 0,
      presets: Array.isArray(data?.presets) ? data.presets.filter((p) => isObj(p) && typeof p.name === 'string').length : 0,
      settings: [...new Set(Object.keys(c).filter((k) => c[k] !== cur[k]).map((k) => SETTING_NAMES[k] || k))],
    };
  };
  // Types, plus values a hand-edited file could get wrong: a sort that exists, real calendar dates.
  const CFG_DATES = new Set(['from', 'to', 'inspectOn', 'leaseEnd', 'noticeGiven', 'moveDate']);
  // Last answer kept: leaseFit asks about the same lease end once per listing on every filter.
  let ymdLast = null, ymdOk = false;
  const isYmd = (v) => {
    if (typeof v === 'string' && v === ymdLast) return ymdOk;
    const d = /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(v + 'T00:00:00Z'), ok = !!d && !isNaN(d) && d.toISOString().startsWith(v);
    if (typeof v === 'string') { ymdLast = v; ymdOk = ok; }
    return ok;
  };
  // Saved settings are only trusted per key and type: a stale or hand-edited value (eg
  // keyword: null) falls back to the default instead of throwing on every render.
  const sanitizeCfg = (c) => (c && typeof c === 'object'
    ? Object.fromEntries(Object.keys(DEFAULT_CFG).filter((k) => typeof c[k] === typeof DEFAULT_CFG[k] && (k !== 'sort' || Object.hasOwn(SORTS, c[k]))
      && (!CFG_DATES.has(k) || c[k] === '' || isYmd(c[k])) && settingOk(k, c[k])).map((k) => [k, c[k]]))
    : {});

  // cfg keys that narrow results (FILTER_KEYS), live under "More filters" (MORE_KEYS), or
  // are display preferences that Clear keeps (DISPLAY_PREFS).
  const FILTER_KEYS = ['from', 'to', 'withinDays', 'priceMin', 'priceMax', 'upfrontMax', 'cashMax', 'bedsMin', 'bathsMin', 'carsMin', 'sizeMin', 'type', 'keyword',
    'inspectOn', 'inspectWhen', 'hideNoImage', 'hideTaken', 'exactOnly', 'onlyStarred', 'newOnly', 'changedOnly', 'unopenedOnly', 'unreviewedOnly', 'staleOnly', 'amenities', 'noWatch', 'maxKm', 'floorplanOnly', 'leaseMin', 'onePerBuilding', 'building'];
  const MORE_KEYS = [...FILTER_KEYS.filter((k) => !['from', 'to', 'withinDays', 'exactOnly'].includes(k)), 'showHidden', 'showGone', 'anchor', 'places'];
  const PRESET_KEYS = [...FILTER_KEYS.filter((k) => k !== 'building'), 'anchor', 'sort', 'sortDesc']; // what a preset saves and restores
  const DISPLAY_PREFS = ['sort', 'sortDesc', 'anchor', 'places', 'inspectFree', 'packDone', 'moveDone', 'ecrDone', 'slSort', 'slSeenAt', ...SETTINGS.map((x) => x.key)]; // Clear keeps your settings, "from" point, places and free times

  const num = (v) => (v === '' || v == null || isNaN(+v) ? null : +v);
  // getTime(): subtracting Dates goes through valueOf, several times slower in a 1000-listing sort.
  const availMs = (d) => (d instanceof Date ? d.getTime() : d ?? Infinity);
  const byAvail = (a, b) => availMs(a.avail) - availMs(b.avail);
  const byPrice = (a, b) => a.priceNum - b.priceNum;
  // Each sort: how two listings compare, and which listings have no value for it (kept last, even
  // reversed: a "Contact agent" rent isn't the dearest). NaN from Infinity - Infinity is falsy, so
  // ties on unknowns fall through to the next key.
  const SORT_SPEC = {
    avail: [(a, b) => byAvail(a, b) || byPrice(a, b), (r) => !(r.avail instanceof Date)],
    price: [(a, b) => byPrice(a, b) || byAvail(a, b), (r) => !Number.isFinite(r.priceNum)],
    ppb: [(a, b) => a.ppb - b.ppb || byAvail(a, b), (r) => !Number.isFinite(r.ppb)],
    ppsqm: [(a, b) => (perSqm(a) ?? Infinity) - (perSqm(b) ?? Infinity) || byAvail(a, b), (r) => perSqm(r) == null],
    beds: [(a, b) => (+b.beds || 0) - (+a.beds || 0) || byPrice(a, b), (r) => r.beds === ''],
    // Newest first: REA's listed date when present, else when this browser first saw it.
    listed: [(a, b) => (b.listed ?? b.firstSeen ?? -Infinity) - (a.listed ?? a.firstSeen ?? -Infinity) || byAvail(a, b), (r) => r.listed == null && r.firstSeen == null],
    inspect: [(a, b) => (a.nextInspect ?? Infinity) - (b.nextInspect ?? Infinity) || byAvail(a, b), (r) => r.nextInspect == null],
    value: [(a, b) => (a.vsMedian ?? Infinity) - (b.vsMedian ?? Infinity) || byPrice(a, b), (r) => r.vsMedian == null],
    distance: [(a, b) => (a.km ?? Infinity) - (b.km ?? Infinity) || byAvail(a, b), (r) => r.km == null],
    fit: [(a, b) => fitKey(a.fit) - fitKey(b.fit) || (a.priceNum ?? Infinity) - (b.priceNum ?? Infinity) || byAvail(a, b), (r) => !r.fit],
    allnear: [(a, b) => (worstKm(a) ?? Infinity) - (worstKm(b) ?? Infinity) || byAvail(a, b), (r) => worstKm(r) == null],
    match: [(a, b) => (b.score ?? -1) - (a.score ?? -1) || byAvail(a, b), (r) => r.score == null],
    cash: [(a, b) => (cashToMove(a) ?? Infinity) - (cashToMove(b) ?? Infinity) || byAvail(a, b), (r) => cashToMove(r) == null],
  };
  const SORTS = Object.fromEntries(Object.entries(SORT_SPEC).map(([k, [cmp]]) => [k, cmp]));
  const SORT_UNKNOWN = Object.fromEntries(Object.entries(SORT_SPEC).map(([k, [, unknown]]) => [k, unknown]));
  const sorter = (key, desc) => {
    const cmp = Object.hasOwn(SORTS, key) ? SORTS[key] : SORTS.avail;
    if (!desc) return cmp;
    const unknown = SORT_UNKNOWN[key] || SORT_UNKNOWN.avail;
    return (a, b) => (unknown(a) - unknown(b)) || cmp(b, a);
  };

  // Keyword: space-separated terms, all must match; "-term" excludes; "quoted phrase" kept whole.
  // Lowercase without accents, so "cafe" finds "café" (row text is stored folded).
  // Accents off and curly quotes straight: "O’Connell" matches o'connell.
  const fold = (v) => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\u2018\u2019\u02bc`]/g, "'").toLowerCase();
  // "Inspections I can make": a weekend, or 5pm or later, in the listing's own time zone.
  const INSPECT_WHEN = { weekend: 'Inspect on a weekend', evening: 'Inspect after 5pm', either: 'Weekend or after 5pm', mine: 'Inspect at my times' };
  // "My times": comma- or line-separated entries of days and an optional time range, eg
  // "Sat 9-13, Sun, weekdays 17:30-, Mon-Wed 7am-8:30am". No days means every day; no range
  // means all day; an open end runs to midnight (or from it). null when an entry can't be read.
  const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dayOf = (w) => WEEKDAYS.indexOf(String(w).slice(0, 3).toLowerCase());
  const isDayName = (x) => x.length >= 3 && DAY_NAMES.some((n) => n.startsWith(x) || `${n}s` === x); // sat, satur, saturday; not "sunburn"
  const clockMin = (t, fallback) => {
    if (!t) return fallback;
    const m = t.match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/i);
    if (!m || +m[1] > 24 || +(m[2] || 0) > 59) return NaN;
    const h = (+m[1] % 12) + (m[3] ? (m[3].toLowerCase() === 'pm' ? 12 : 0) : +m[1] >= 12 ? 12 : 0);
    return Math.min(1440, (m[3] ? h : +m[1]) * 60 + +(m[2] || 0));
  };
  const TIME_RANGE = /(\d[\d:.]*\s*(?:am|pm)?)?\s*-\s*(\d[\d:.]*\s*(?:am|pm)?)?\s*$/;
  const dayToken = (w, days) => {
    const [a, b] = w.split('-'), all = WEEKDAYS.map((_, d) => d);
    const one = (x) => (/^(weekdays?|workdays?)$/.test(x) ? [1, 2, 3, 4, 5] : /^weekends?$/.test(x) ? [0, 6]
      : /^(daily|any|every|everyday|day)$/.test(x) ? all : isDayName(x) ? [dayOf(x)] : null);
    if (b == null) { const ds = one(a); ds?.forEach((d) => days.add(d)); return !!ds; }
    const x = dayOf(a), y = dayOf(b);
    if (x < 0 || y < 0 || one(a)?.length !== 1 || one(b)?.length !== 1) return false;
    for (let d = x; ; d = (d + 1) % 7) { days.add(d); if (d === y) return true; }
  };
  const parseFreeTimes = (text) => {
    const out = [];
    // En and em dashes and "to" are ranges too ("Sat 9am–1pm", "Mon to Fri", what {mytimes} writes).
    // Also what freeTimesText writes back: "noon", "after 5:30pm", "before 6am", "Sat 9am-1pm or Sun"
    // ("or" after a time starts another slot; between days it's "and").
    const norm = String(text || '').replace(/[–—−]/g, '-').replace(/\s+to\s+/gi, '-')
      .replace(/\b(?:12\s*)?(?:noon|midday)\b/gi, '12pm').replace(/\b(?:12\s*)?midnight\b/gi, '12am')
      .replace(/\bafter\s+(\d[\d:.]*\s*(?:am|pm)?)/gi, '$1-').replace(/\bbefore\s+(\d[\d:.]*\s*(?:am|pm)?)/gi, '-$1')
      .replace(/(\d\s*(?:am|pm)?|-)\s+or\s+/gi, '$1,')
      // "Weekends or weekdays after 5pm" (what freeTimesText writes): after a group of days, "or" and
      // days with their own time are another slot. "Sat or Sun after 2pm" stays one slot.
      .replace(/(\b(?:weekends?|weekdays?|any day|daily|every ?day))\s+or\s+(?=[a-z]+\s*\d)/gi, '$1,')
      .replace(/(\d[\d:.]*\s*(?:am|pm)?)\s*onwards?\b/gi, '$1-');
    let lastDays = null;
    for (const raw of norm.split(/[,;\n]/).map((x) => x.trim().toLowerCase()).filter(Boolean)) {
      const t = raw.match(TIME_RANGE), hasRange = !!t && !!(t[1] || t[2]);
      const dayText = (hasRange ? raw.slice(0, t.index) : raw).replace(/\s*-\s*/g, '-').trim();
      const days = new Set();
      for (const w of dayText.split(/\s*(?:&|\/|\band\b|\bor\b|\s)\s*/).filter(Boolean)) if (!dayToken(w, days)) return null;
      let from = hasRange ? clockMin(t[1]?.trim(), 0) : 0;
      let to = hasRange ? clockMin(t[2]?.trim(), 1440) : 1440;
      if (to === 0) to = 1440; // "6pm-12am" ends at midnight
      if (hasRange && t[2] && !/[ap]m/.test(t[2]) && (/[ap]m/.test(t[1] || '') || from <= 720) && to <= from && to + 720 > from) to += 720; // "10am-2", "6pm-9": the end is later the same day
      if (hasRange && t[1] && !/[ap]m/.test(t[1]) && /pm/.test(t[2] || '') && from < 720 && from + 720 < to) from += 720; // "6-8pm" is 6pm to 8pm
      // Bare small hours ("2-4", "1-3") are the afternoon: nobody inspects at 2am.
      if (hasRange && t[1] && t[2] && !/[ap]m/.test(t[1] + t[2]) && from >= 60 && from < 420 && to > from && to + 720 <= 1440) { from += 720; to += 720; }
      if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || (!days.size && !hasRange)) return null;
      // A time alone after another slot ("Sat 9-11 or 2-4") is on that slot's days.
      out.push({ days: days.size ? days : lastDays ? new Set(lastDays) : new Set(WEEKDAYS.map((_, d) => d)), from, to });
      if (days.size) lastDays = days;
    }
    return out.length ? out : null;
  };
  // [weekday 0-6, minute of the day] of an instant in a zone: memoised, as every filter pass
  // (and each chip's re-run in removedBy) asks again for the same inspections.
  const clockMemo = new Map();
  const clockIn = (at, tz) => {
    const k = `${tz || ''}|${at}`;
    let v = clockMemo.get(k);
    if (!v) {
      const parts = Object.fromEntries(dtf({ weekday: 'short', hour: 'numeric', minute: '2-digit', hourCycle: 'h23', ...(tz ? { timeZone: tz } : {}) }).formatToParts(at).map((p) => [p.type, p.value]));
      if (clockMemo.size > 20000) clockMemo.clear();
      clockMemo.set(k, (v = [dayOf(parts.weekday), (+parts.hour % 24) * 60 + +parts.minute]));
    }
    return v;
  };
  const inspectFits = (at, tz, when, free = null) => {
    const [d, min] = clockIn(at, tz);
    if (when === 'mine') return !!free?.some((w) => w.days.has(d) && min >= w.from && min < w.to);
    const weekend = d === 0 || d === 6, evening = min >= 17 * 60;
    return when === 'weekend' ? weekend : when === 'evening' ? evening : weekend || evening;
  };
  // Every term must appear; -term must not; "a phrase" as typed; a|b means either.
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
    const bedKey = (r) => Math.min(+r.beds || 0, 5); // 5+ together, as the market table groups them
    const med = medians(groupRents(priced, (r) => (r.surrounding ? null : bedKey(r))));
    const multi = new Set(priced.map((r) => String(r.suburb).toLowerCase())).size > 1;
    const sub = multi ? medians(groupRents(priced, subKey)) : new Map();
    for (const r of rows) {
      const sm = r.beds === '' ? undefined : sub.get(subKey(r));
      const m = sm ?? (r.beds === '' ? undefined : med.get(bedKey(r)));
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
  // `all`: the whole search, for the move-in median, so hiding or filtering out one listing doesn't
  // shift every other listing's score (and redraw it).
  const withScores = (rows, cfg, all = rows) => {
    // Budget: your max rent, else what 30% of your income affords.
    const pMax = num(cfg.priceMax) || (num(cfg.income) > 0 ? Math.round((num(cfg.income) * RENT_STRESS_PCT) / 100 / 52) : null), kmMax = num(cfg.maxKm) || SCORE_KM;
    const from = cfg.from ? ymdStart(cfg.from) : null;
    const upMed = quantile(all.map((r) => r.upfront).filter(Number.isFinite).sort(asc), 0.5);
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

  const shortDate = (ymd) => dtf({ day: 'numeric', month: 'short' }).format(ymdStart(ymd));
  const NUM_FMT = new Intl.NumberFormat('en-AU');
  const money = (v) => `$${NUM_FMT.format(+v)}`;
  const statusLabel = (v) => (v ? v[0].toUpperCase() + v.slice(1) : 'Not started');
  const statusOptions = (cur) => APP_STATUSES.map((v) => `<option value="${v}"${v === cur ? ' selected' : ''}>${statusLabel(v)}</option>`).join('');
  const CHIP_LABELS = {
    from: (v) => `From ${shortDate(v)}`, to: (v) => `To ${shortDate(v)}`, withinDays: (v) => `Within ${Math.round(v / 7)} wks`,
    priceMin: (v) => `≥ ${money(v)}/wk`, priceMax: (v) => `≤ ${money(v)}/wk`, upfrontMax: (v) => `Move-in ≤ ${money(v)}`, cashMax: (v) => `Cash to move ≤ ${money(v)}`,
    bedsMin: (v) => `${v}+ bed`, bathsMin: (v) => `${v}+ bath`, carsMin: (v) => `${v}+ car`, sizeMin: (v) => `${v}+ m²`, type: (v) => v,
    keyword: (v) => `"${v}"`, inspectOn: (v) => `Inspecting ${shortDate(v)}`, inspectWhen: (v) => INSPECT_WHEN[v] || '', hideNoImage: () => 'Has a photo', hideTaken: () => 'Not taken',
    exactOnly: () => 'No surrounding suburbs', onlyStarred: () => 'Shortlisted', newOnly: () => 'New only', changedOnly: () => 'Changed only', unopenedOnly: () => 'Not opened yet', unreviewedOnly: () => 'Not reviewed', leaseMin: (v) => `Lease ${v}+ mo`, onePerBuilding: () => 'One per building', building: (v) => `Building: ${v.split('|')[1] || 'one building'}`,
    staleOnly: () => 'Listed 3+ wks', maxKm: (v) => `≤ ${v} km`, floorplanOnly: () => 'Floorplan',
  };
  const NUM_KEYS = ['priceMin', 'priceMax', 'upfrontMax', 'cashMax', 'bedsMin', 'bathsMin', 'carsMin', 'sizeMin', 'maxKm', 'withinDays', 'leaseMin'];
  // Active filters as removable chips: [{ key, amen?, label }]. `without` gives the cfg with
  // that one chip removed, so the UI can show how many listings each filter is removing.
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
        for (const id of watchIds(v)) out.push({ key: k, watch: id, label: `No ${WATCH_BY_ID.get(id).label.toLowerCase()}` });
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
  // How many more listings each chip's removal would show. One pass over the rows: a listing
  // counts for a chip when that chip's test is the only one it fails. Chips whose removal
  // changes other tests (dates, types) or a set-level step (one per building) re-filter instead.
  const REFILTER_TAGS = new Set(['from', 'to', 'withinDays', 'type', 'building', 'onePerBuilding']);
  const chipTag = (chip) => (chip.amen ? `amen:${chip.amen}` : chip.watch ? `watch:${chip.watch}` : chip.key);
  const removedBy = (rows, cfg, now = new Date()) => {
    cfg = { ...DEFAULT_CFG, ...cfg };
    const chips = activeFilters(cfg);
    const setLevel = cfg.onePerBuilding && !cfg.building;
    const tests = rowTests(cfg, now);
    const only = new Map(), prepped = prepRows(rows, cfg);
    let base = 0;
    if (!setLevel) {
      for (const r of prepped) {
        let failed = null, many = false;
        for (const [tag, t] of tests) {
          if (t(r)) continue;
          if (failed != null && failed !== tag) { many = true; break; }
          failed = tag;
        }
        if (failed == null) base++;
        else if (!many) only.set(failed, (only.get(failed) || 0) + 1);
      }
    } else base = filterPrepped(prepped, cfg, now).length;
    return chips.map((chip) => {
      const tag = chipTag(chip);
      const removes = setLevel || REFILTER_TAGS.has(tag) ? filterPrepped(prepped, without(cfg, chip), now).length - base : only.get(tag) || 0;
      return { ...chip, removes };
    });
  };

  // Map view without map tiles: listings placed by their coordinates on a flat projection (fine
  // at suburb scale), places and the distance point as pins, a scale bar and suburb names.
  const MAP_W = 400, MAP_H = 300, MAP_PAD = 18, MAP_LABELS = 8;
  const NICE_KM = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200];
  const mapLayout = (rows, pins = [], w = MAP_W, h = MAP_H) => {
    const has = (p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lng);
    const pts = rows.filter(has);
    if (!pts.length) return null;
    // Bounds from the listings; a place counts only if it is near them (within their span again
    // on each side, or about 7 km). One in another city would squash every listing into a corner, so
    // it becomes an arrow at the edge with its distance instead.
    const la0 = Math.min(...pts.map((p) => p.lat)), la1 = Math.max(...pts.map((p) => p.lat));
    const ln0 = Math.min(...pts.map((p) => p.lng)), ln1 = Math.max(...pts.map((p) => p.lng));
    const padLa = Math.max(la1 - la0, 0.06), padLn = Math.max(ln1 - ln0, 0.07); // about 7 km at least
    const near = (p) => p.lat >= la0 - padLa && p.lat <= la1 + padLa && p.lng >= ln0 - padLn && p.lng <= ln1 + padLn;
    const ps = pins.filter(has).filter(near), far = pins.filter(has).filter((p) => !near(p));
    const lats = [...pts, ...ps].map((p) => p.lat), lngs = [...pts, ...ps].map((p) => p.lng);
    const minLa = Math.min(...lats), maxLa = Math.max(...lats), minLn = Math.min(...lngs), maxLn = Math.max(...lngs);
    const kx = Math.cos(((minLa + maxLa) / 2) * Math.PI / 180);
    const spanX = Math.max((maxLn - minLn) * kx, 0.002), spanY = Math.max(maxLa - minLa, 0.002);
    const s = Math.min((w - 2 * MAP_PAD) / spanX, (h - 2 * MAP_PAD) / spanY); // pixels per degree of latitude
    const ox = (w - (maxLn - minLn) * kx * s) / 2, oy = (h - (maxLa - minLa) * s) / 2;
    const round = (v) => Math.round(v * 10) / 10;
    const xy = (p) => ({ x: round(ox + (p.lng - minLn) * kx * s), y: round(oy + (maxLa - p.lat) * s) });
    const seen = new Map();
    const dots = pts.map((r) => { // listings at the same spot (a block of units) spiral out so each can be clicked
      const at = xy(r), k = `${Math.round(at.x / 4)},${Math.round(at.y / 4)}`, n = seen.get(k) || 0;
      seen.set(k, n + 1);
      if (n) { const a = n * 2.4, d = 5 * Math.sqrt(n); at.x = round(at.x + Math.cos(a) * d); at.y = round(at.y + Math.sin(a) * d); }
      return { r, ...at };
    });
    const kmPerPx = 111.32 / s, want = (kmPerPx * w) / 4;
    const km = NICE_KM.reduce((best, k) => (Math.abs(Math.log(k / want)) < Math.abs(Math.log(best / want)) ? k : best));
    const bySub = new Map();
    for (const d of dots) { const k = d.r.suburb; if (!k) continue; const g = bySub.get(k) || { name: k, x: 0, y: 0, n: 0 }; g.x += d.x; g.y += d.y; g.n++; bySub.set(k, g); }
    const labels = [...bySub.values()].sort((a, b) => b.n - a.n).slice(0, MAP_LABELS).map((g) => ({ name: g.name, x: round(g.x / g.n), y: round(g.y / g.n), n: g.n }));
    const c = { lat: (la0 + la1) / 2, lng: (ln0 + ln1) / 2 }, mid = xy(c);
    const edges = far.map((p) => { // where the line from the listings' middle to the place leaves the box
      const vx = (p.lng - c.lng) * kx * s, vy = (c.lat - p.lat) * s;
      const tx = vx > 0 ? (w - MAP_PAD - mid.x) / vx : vx < 0 ? (MAP_PAD - mid.x) / vx : Infinity;
      const ty = vy > 0 ? (h - MAP_PAD - mid.y) / vy : vy < 0 ? (MAP_PAD - mid.y) / vy : Infinity;
      const t = Math.min(1, tx, ty);
      return { label: p.label, km: Math.round(haversineKm(c, p)), x: round(mid.x + vx * t), y: round(mid.y + vy * t), angle: Math.round((Math.atan2(-vy, vx) * 180) / Math.PI) };
    });
    return { w, h, dots, pins: ps.map((p) => ({ label: p.label, ...xy(p) })), far: edges, scale: { km, px: round(km / kmPerPx) }, labels, skipped: rows.length - pts.length };
  };
  const mapTone = (r) => (r.vsMedian == null ? 'na' : r.vsMedian <= -5 ? 'lo' : r.vsMedian >= 5 ? 'hi' : 'mid');

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
    // The search's own listings (not surrounding suburbs), as cards' medians are.
    const byBeds = groupRents(uniq, (r) => (r.beds === '' || r.beds == null || r.surrounding ? null : Math.min(+r.beds || 0, 5))).sort((a, b) => a.key - b.key)
      .map(({ key, n, rents, ppb }) => {
        const enough = rents.length >= MEDIAN_MIN;
        return { beds: key, n, priced: rents.length, min: rents[0] ?? null, max: rents[rents.length - 1] ?? null,
          p25: enough ? quantile(rents, 0.25) : null, median: medianOf(rents), p75: enough ? quantile(rents, 0.75) : null, ppb: medianOf(ppb) };
      });
    const today = startOfDay(now);
    const weeks = [{ label: 'Now', from: null, n: 0 }];
    for (let w = 0; w < MARKET_WEEKS; w++) {
      const from = new Date(today); from.setDate(from.getDate() + 1 + w * 7);
      weeks.push({ from: ymdLocal(from), to: addDaysYmd(ymdLocal(from), 6), n: 0 });
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
    return { n: uniq.length, median: medianOf(all), byBeds, bySuburb, byAgency: agencyPatterns(uniq, now), byWeek: [...weeks, later, unknown] };
  };
  // Per agency, over the listings shown: how many, how many dropped their rent, relisted, or say
  // they're taken while still up, and the median days listed. Counts, not a rating; only with
  // two or more agencies, each with AGENCY_MIN+ listings.
  const AGENCY_MIN = 2, AGENCY_ROWS = 10;
  // Room to negotiate? Facts only, no suggested offer (rent bidding rules differ by state): how long
  // it's been listed, a price drop, and how often its agency dropped a price in these results.
  // Shown only when at least two agree.
  const agencyDrops = (rows) => {
    const out = new Map();
    for (const r of rows) {
      const k = agencyKey(r.agency);
      if (!k) continue;
      const g = out.get(k) || { n: 0, dropped: 0 };
      g.n++;
      if (r.priceDelta < 0) g.dropped++;
      out.set(k, g);
    }
    return out;
  };
  const negotiateFacts = (r, drops = null, now = Date.now()) => {
    const since = +(r.listed ?? r.firstSeen ?? NaN), weeks = Number.isFinite(since) ? Math.floor((now - since) / (7 * DAY_MS)) : 0;
    const g = drops?.get(agencyKey(r.agency));
    const facts = [
      since && now - since >= STALE_MS ? `listed ${weeks} weeks` : '',
      r.priceDelta < 0 ? `dropped $${-r.priceDelta}` : '',
      g && g.n >= 3 && g.dropped / g.n >= 0.25 && !(g.dropped === 1 && r.priceDelta < 0) ? `this agency dropped ${g.dropped} of ${g.n}` : '',
    ].filter(Boolean);
    return facts.length >= 2 ? `Room to negotiate? ${facts.join(' · ')}` : '';
  };
  const agencyPatterns = (rows, now = new Date()) => {
    const groups = new Map();
    for (const r of rows) {
      const k = agencyKey(r.agency);
      if (!k) continue;
      const g = groups.get(k) || { agency: r.agency, n: 0, dropped: 0, relisted: 0, taken: 0, days: [] };
      g.n++;
      const was = r.prevPrice ? parsePrice(r.prevPrice) : null;
      if (Number.isFinite(was) && Number.isFinite(r.priceNum) && r.priceNum < was) g.dropped++;
      if (r.relisted) g.relisted++;
      if (r.taken) g.taken++;
      const since = +(r.listed ?? r.firstSeen ?? NaN); // Dates on real rows, numbers from a summary
      if (Number.isFinite(since) && since <= +now) g.days.push(Math.floor((+now - since) / DAY_MS));
      groups.set(k, g);
    }
    const out = [...groups.values()].filter((g) => g.n >= AGENCY_MIN);
    if (out.length < 2) return [];
    return out.sort((a, b) => b.n - a.n || a.agency.localeCompare(b.agency)).slice(0, AGENCY_ROWS)
      .map(({ days, ...g }) => ({ ...g, medianDays: days.length ? Math.round(quantile(days.sort(asc), 0.5)) : null }));
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

  // REA's own search filters, read from its search URL and written back (docs/REA-SEARCH-URLS.md).
  // Undocumented: anything not recognised is kept as it was, never dropped or guessed at.
  const steps = (from, to, by) => Array.from({ length: (to - from) / by + 1 }, (_, i) => from + i * by);
  const REA_RENT_STEPS = [...steps(50, 750, 25), ...steps(800, 1000, 50), ...steps(1100, 2000, 100), ...steps(2500, 5000, 500)];
  const REA_TYPES = { house: 'House', townhouse: 'Townhouse', 'unit+apartment': 'Apartment & Unit', villa: 'Villa' };
  const TYPE_TO_REA = { House: 'house', Townhouse: 'townhouse', Villa: 'villa', Apartment: 'unit+apartment', Unit: 'unit+apartment' }; // REA's listing type names
  const REA_MISC = { 'pets-allowed': 'pets considered', furnished: 'furnished', 'ex-deposit-taken': 'no deposit taken' };
  const REA_TRACKING = ['source', 'sourcePage', 'sourceElement'];
  const REA_MAX_COUNT = 6, REA_BEFORE_DAYS = 42; // REA's dropdowns: 6+ rooms, about six weeks of dates
  const REA_SEG = /^(?:property-(.+?)-)?(?:with-(studio|\d+)(?:-bedrooms?)?-)?(?:between-(any|\d+)-(any|\d+)-)?in-(.+)$/;
  const reaFiltersOf = (href) => {
    let u, seg;
    try { u = new URL(href); seg = decodeURIComponent(u.pathname.split('/')[2] || ''); } catch { return null; }
    const m = /^\/rent\//.test(u.pathname) && seg.match(REA_SEG);
    if (!m) return null;
    const q = u.searchParams, n = (k) => (/^\d+$/.test(q.get(k) || '') ? +q.get(k) : null);
    const list = (k) => (q.get(k) || '').split(',').map((x) => x.trim()).filter(Boolean);
    const types = m[1] ? m[1].split('-') : [];
    const end = (v) => (v && v !== 'any' ? +v : null);
    return {
      places: m[5], typesRaw: m[1] || '', types: types.every((t) => REA_TYPES[t]) ? types : null, // null: a type this doesn't know
      bedsMin: m[2] == null ? null : m[2] === 'studio' ? 0 : +m[2], bedsMax: n('maxBeds'),
      priceMin: end(m[3]), priceMax: end(m[4]), baths: n('numBaths'), cars: n('numParkingSpaces'),
      before: /^\d{4}-\d{2}-\d{2}$/.test(q.get('availableBefore') || '') ? q.get('availableBefore') : '',
      surrounding: q.get('includeSurrounding') !== 'false',
      misc: list('misc'), features: list('checkedFeatures'), keywords: list('keywords').filter((k) => !list('checkedFeatures').includes(k)),
    };
  };
  // The toolkit's types as REA's slugs; null when one has no REA equivalent (REA's are then kept).
  const reaTypeSlugs = (type) => { const t = typeList(type).map((x) => TYPE_TO_REA[x]); return t.every(Boolean) ? [...new Set(t)] : null; };
  // The last day the toolkit's "to" or "within" lets in (the earlier of the two), or ''.
  const toolkitEnd = (cfg, now) => [cfg.to, windowEnd(cfg.withinDays, now)].filter(Boolean).sort()[0] || '';
  // What REA's search narrows by, each with whether it hides listings your own filters would keep
  // (REA has dropped them before the toolkit sees them).
  const reaChips = (f, cfg = {}, now = new Date()) => {
    if (!f) return [];
    const c = { ...DEFAULT_CFG, ...cfg }, mine = (k) => num(c[k]) || 0, out = [];
    const add = (key, label, narrower) => out.push({ key, label, narrower: !!narrower });
    if (f.typesRaw) {
      const slugs = reaTypeSlugs(c.type);
      add('type', f.types ? f.types.map((t) => REA_TYPES[t]).join(', ') : f.typesRaw.replace(/-/g, ', '), !f.types || !slugs || !slugs.length || slugs.some((t) => !f.types.includes(t)));
    }
    if (f.priceMin != null || f.priceMax != null) {
      const $ = (v) => money(v);
      add('price', f.priceMin != null && f.priceMax != null ? `${$(f.priceMin)}–${$(f.priceMax)}` : f.priceMin != null ? `${$(f.priceMin)}+` : `up to ${$(f.priceMax)}`,
        (f.priceMin || 0) > mine('priceMin') || (f.priceMax != null && (!mine('priceMax') || f.priceMax < mine('priceMax'))));
    }
    if (f.bedsMin != null || f.bedsMax != null) {
      const b = (v) => (v === 0 ? 'studio' : String(v));
      add('beds', f.bedsMin != null && f.bedsMax != null ? `${b(f.bedsMin)}–${b(f.bedsMax)} beds` : f.bedsMin != null ? `${b(f.bedsMin)}+ beds` : `up to ${b(f.bedsMax)} beds`,
        (f.bedsMin || 0) > mine('bedsMin') || f.bedsMax != null);
    }
    if (f.baths) add('baths', `${f.baths}+ bath`, f.baths > mine('bathsMin'));
    if (f.cars) add('cars', `${f.cars}+ car`, f.cars > mine('carsMin'));
    if (f.before) { const end = toolkitEnd(c, now); add('before', `available before ${shortDate(f.before)}`, !end || end >= f.before); }
    if (!f.surrounding) add('surrounding', 'no surrounding suburbs', !c.exactOnly);
    for (const k of f.misc) add(`misc:${k}`, REA_MISC[k] || k, !(k === 'ex-deposit-taken' && c.hideTaken));
    for (const k of [...f.features, ...f.keywords]) add(`kw:${k}`, k, true); // REA's matching isn't the toolkit's: always its own narrowing
    return out;
  };
  // REA's URL for this search with the toolkit's filters that REA can apply itself: rent (widened
  // to REA's steps, so nothing the toolkit keeps is lost), beds, baths, cars, type, available-to,
  // surrounding suburbs and taken listings. The rest of REA's own filters (amenities, keywords,
  // sort) are kept. Page 1, REA's tracking left off. null when the URL isn't a search this reads.
  const reaUrlFor = (href, cfg, now = new Date()) => {
    const f = reaFiltersOf(href);
    if (!f) return null;
    const c = { ...DEFAULT_CFG, ...cfg }, u = new URL(href);
    const lo = num(c.priceMin), hi = num(c.priceMax);
    const pMin = lo > 0 ? [...REA_RENT_STEPS].reverse().find((v) => v <= lo) ?? null : null;
    const pMax = hi > 0 ? REA_RENT_STEPS.find((v) => v >= hi) ?? null : null;
    const slugs = reaTypeSlugs(c.type), beds = Math.min(num(c.bedsMin) || 0, REA_MAX_COUNT);
    const types = slugs === null ? f.typesRaw : slugs.join('-');
    u.pathname = `/rent/${[types && `property-${types}`, beds && `with-${beds}-bedrooms`, (pMin || pMax) && `between-${pMin ?? 'any'}-${pMax ?? 'any'}`, `in-${f.places}`].filter(Boolean).join('-')}/list-1`;
    const q = u.searchParams;
    for (const k of [...REA_TRACKING, 'maxBeds', 'numBaths', 'numParkingSpaces', 'availableBefore', 'includeSurrounding']) q.delete(k);
    for (const [k, key] of [['numBaths', 'bathsMin'], ['numParkingSpaces', 'carsMin']]) { const v = Math.min(num(c[key]) || 0, REA_MAX_COUNT); if (v) q.set(k, String(v)); }
    // REA's "before" a day after your last day (whether REA counts the day itself isn't known), and
    // only within the dates its own menu offers.
    const end = toolkitEnd(c, now);
    if (end) { const d = ymdStart(end); d.setDate(d.getDate() + 1); if ((d - now) / DAY_MS <= REA_BEFORE_DAYS) q.set('availableBefore', ymdLocal(d)); }
    if (c.exactOnly) q.set('includeSurrounding', 'false');
    const misc = f.misc.filter((k) => k !== 'ex-deposit-taken').concat(c.hideTaken ? ['ex-deposit-taken'] : []);
    if (misc.length) q.set('misc', misc.join(',')); else q.delete('misc');
    return u.href;
  };
  // Same REA search either way (REA's tracking fields aside).
  const sameReaSearch = (a, b) => { const k = (h) => { const u = new URL(h); for (const t of REA_TRACKING) u.searchParams.delete(t); u.searchParams.sort(); return pageUrl(u.href, 1); }; try { return k(a) === k(b); } catch { return false; } };

  const startOfDay = (d = new Date()) => { const t = new Date(d); t.setHours(0, 0, 0, 0); return t; };
  const isFresh = (r) => !!(r.isNew || r.sinceLast); // new: REA-dated recently, or since the last visit
  const priceDir = (r) => (r.priceDelta < 0 ? 'down' : 'up');

  // Settings that can't match anything, as a message for the status line ('' if fine).
  const cfgError = (cfg, now = new Date()) => {
    if (cfg.from && cfg.to && cfg.from > cfg.to) return '"Available from" is after "Available to".';
    const wEnd = windowEnd(cfg.withinDays, now);
    if (cfg.from && wEnd && cfg.from > wEnd) return `"Available from" is after the "within" window (ends ${wEnd}).`;
    if (cfg.inspectWhen === 'mine' && !parseFreeTimes(cfg.inspectFree)) return 'Inspections at "my times" needs times it can read, eg Sat 9-13, weekdays 17:30-.';
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
    const leaseEnd = leaseEndOf(cfg, now);
    for (const r of kept) { r.fit = leaseFit(r, leaseEnd, now); r.moveExtra = num(cfg.moveCosts) || 0; r.rentNow = num(cfg.rentNow) || 0; }
    return withScores(kept, cfg, rows).sort(sorter(cfg.sort, cfg.sortDesc));
  }

  // Every per-row test filterRows applies, tagged with the filter it belongs to (a cfg key, or
  // amen:<id> / watch:<id> for one amenity or heads-up chip), so removedBy can count in one pass.
  const rowTests = (cfg, now) => {
    const from = cfg.from ? ymdStart(cfg.from) : null;
    let to = cfg.to ? ymdEnd(cfg.to) : null;
    // Rolling window ("within 4 weeks") tightens the upper bound relative to today, so a
    // saved setting never goes stale the way a fixed date does.
    const w = windowEndDate(cfg.withinDays, now);
    if (w && (!to || w < to)) to = w;
    const pMin = num(cfg.priceMin), pMax = num(cfg.priceMax), upMax = num(cfg.upfrontMax), sizeMin = num(cfg.sizeMin);
    const kw = cfg.keyword.trim() ? keywordTest(cfg.keyword) : null;
    const bKey = cfg.building.split('|')[0], leaseNeed = num(cfg.leaseMin), types = typeList(cfg.type); // building is "key|label" from "N in this building"
    const anchor = parseAnchor(cfg.anchor), kmMax = num(cfg.maxKm);
    const insDay = !!cfg.inspectOn;
    const sameDay = (ms, r) => ymdIn(ms, tzOf(r)) === cfg.inspectOn; // the listing's calendar day, like the planner
    const tests = [];
    const add = (tag, on, fn) => { if (on) tests.push([tag, fn]); };
    add('exactOnly', cfg.exactOnly, (r) => !r.surrounding);
    add('showHidden', !cfg.showHidden, (r) => !ruledOut(r));
    add('floorplanOnly', cfg.floorplanOnly, (r) => r.floorplan === true);
    add('showGone', !cfg.showGone, (r) => !r.gone);
    add('newOnly', cfg.newOnly, (r) => isFresh(r));
    add('changedOnly', cfg.changedOnly, (r) => !!(r.prevPrice || r.prevAvail || r.featChange));
    add('unopenedOnly', cfg.unopenedOnly, (r) => !r.openedAt);
    add('unreviewedOnly', cfg.unreviewedOnly, (r) => !r.reviewedAt);
    for (const id of watchIds(cfg.noWatch)) add(`watch:${id}`, true, (r) => !watchIds(r.watch).includes(id));
    add('staleOnly', cfg.staleOnly, (r) => r.listed instanceof Date && now - r.listed > STALE_MS);
    add('maxKm', kmMax != null && anchor, (r) => r.km != null && r.km <= kmMax); // no location fails a distance cap
    for (const [id, st] of Object.entries(parseAmenCfg(cfg.amenities))) add(`amen:${id}`, true, st === 'yes' ? (r) => r.amen?.[id] === 'yes' : (r) => r.amen?.[id] !== 'yes');
    add('onlyStarred', cfg.onlyStarred, (r) => r.starred);
    add('date', true, (r) => (r.avail ? (!from || r.avail >= from) && (!to || r.avail <= to) : !from && !to));
    add('priceMin', pMin != null, (r) => Number.isFinite(r.priceNum) && r.priceNum >= pMin);
    add('priceMax', pMax != null, (r) => r.priceNum <= pMax);
    add('upfrontMax', upMax != null, (r) => (r.upfront ?? Infinity) <= upMax); // unknown bond fails a move-in cap
    // Move-in plus rent paid twice while your lease overlaps (the fit is worked out here: rows
    // get theirs only after filtering).
    const cashMax = num(cfg.cashMax);
    add('cashMax', cashMax != null, (r) => (Number.isFinite(r.upfront) ? r.upfront + (leaseFit(r, leaseEndOf(cfg, now), now)?.cost || 0) + (num(cfg.moveCosts) || 0) : Infinity) <= cashMax);
    for (const [k, key] of [['beds', 'bedsMin'], ['baths', 'bathsMin'], ['cars', 'carsMin']]) {
      const v = num(cfg[key]);
      add(key, v != null, (r) => r[k] !== '' && +r[k] >= v);
    }
    add('sizeMin', sizeMin != null, (r) => r.sqm != null && r.sqm >= sizeMin); // unknown size fails a minimum
    add('type', types.length, (r) => types.includes(r.type));
    add('hideNoImage', cfg.hideNoImage, (r) => r.img);
    add('hideTaken', cfg.hideTaken, (r) => !r.taken);
    add('keyword', kw, (r) => kw(r.text || ''));
    add('inspectOn', insDay, (r) => (r.inspections || []).some((i) => i.at != null && sameDay(i.at, r)));
    const free = cfg.inspectWhen === 'mine' ? parseFreeTimes(cfg.inspectFree) : null;
    add('inspectWhen', INSPECT_WHEN[cfg.inspectWhen] && (cfg.inspectWhen !== 'mine' || free), (r) => (r.inspections || []).some((i) => i.at != null && i.at >= +now - INSPECT_GRACE_MS && inspectFits(i.at, tzOf(r), cfg.inspectWhen, free)));
    add('building', bKey, (r) => buildingKey(r.address) === bKey);
    add('leaseMin', leaseNeed, (r) => { const l = leaseFromCode(r.lease); return !l || l.flexible || l.max >= leaseNeed; }); // a stated lease too short; unstated or flexible passes
    return tests;
  };
  // Distance depends on cfg.anchor, so it is (re)computed for every caller (memoised per anchor).
  const prepRows = (rows, cfg) => {
    const anchor = parseAnchor(cfg.anchor), places = parsePlaces(cfg.places);
    for (const r of rows) setDistances(r, cfg, anchor, places);
    return dedupe(rows);
  };
  // Rows already through prepRows (removedBy reuses them: no chip changes the anchor or places).
  const filterPrepped = (prepped, cfg, now) => {
    const tests = rowTests(cfg, now);
    const kept = prepped.filter((r) => tests.every(([, t]) => t(r)));
    return cfg.onePerBuilding && !cfg.building ? onePerBuilding(kept) : kept;
  };
  function filterRows(rows, cfg, now = new Date()) {
    cfg = { ...DEFAULT_CFG, ...cfg };
    return filterPrepped(prepRows(rows, cfg), cfg, now);
  }

  // Same building: a unit address without its unit ("5/12 Hall St, Bondi" -> "12 hall st bondi").
  const UNIT_PREFIX = /^\s*(?:(?:(?:unit|apartment|apt|flat|suite|villa|townhouse|lot|shop|studio|penthouse|room)\s*[\w-]+|level\s*\d+)\s*[,\/]?\s*)+|^\s*(?:(?:shop|studio|penthouse|suite)\s+)?[\w-]+\s*\/\s*/i;
  const STREET_SHORT = { street: 'st', road: 'rd', avenue: 'ave', parade: 'pde', crescent: 'cres', drive: 'dr', place: 'pl', court: 'ct', terrace: 'tce', highway: 'hwy', lane: 'ln', close: 'cl', boulevard: 'bvd', boulevarde: 'bvd' };
  const bKeys = new Map(); // address -> building key: withBuildings/onePerBuilding/filterRows ask per row, per render
  const buildingKey = (address) => {
    const a = String(address || '');
    let k = bKeys.get(a);
    if (k === undefined) {
      if (bKeys.size > 20000) bKeys.clear();
      // Every unit prefix off ("Level 2, 6/12 …"), and street types said one way ("Street" = "St").
      let rest = a;
      for (let i = 0; i < 3 && UNIT_PREFIX.test(rest); i++) rest = rest.replace(UNIT_PREFIX, '');
      k = rest !== a ? addressKey(rest.replace(/\b(street|road|avenue|parade|crescent|drive|place|court|terrace|highway|lane|close|boulevarde?)\b/gi, (w) => STREET_SHORT[w.toLowerCase()])) : '';
      bKeys.set(a, k);
    }
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
  let endMemo = null; // the lease end's day number: the same for every listing in a filter pass
  const leaseEndDay = (ymd) => (endMemo?.k === ymd ? endMemo.v : (endMemo = { k: ymd, v: dayNum(ymdStart(ymd)) }).v);
  const leaseFit = (r, leaseEnd, now = new Date()) => {
    if (!isYmd(String(leaseEnd || '')) || !(r.avail instanceof Date) || isNaN(r.avail)) return null;
    const end = leaseEndDay(leaseEnd), today = dayNum(now), start = Math.max(dayNum(r.avail), today);
    if (end < today) return null; // your lease already ended: nothing to fit
    const overlap = Math.max(0, end - start + 1), gap = Math.max(0, start - end - 1);
    // An overlap at an unknown rent has an unknown cost (null), not a free one.
    return { overlap, gap, cost: !overlap ? 0 : Number.isFinite(r.priceNum) ? Math.round((overlap * r.priceNum) / 7) : null };
  };
  const fitLabel = (f) => (!f ? '' : f.overlap ? `${plural(f.overlap, 'day')} overlap${f.cost ? ` ≈ ${money(f.cost)}` : ''}` : f.gap ? `${plural(f.gap, 'night')} gap` : 'starts right after your lease');
  const fitKey = (f) => (!f ? Infinity : f.gap ? 1e9 + f.gap : f.cost == null ? 5e8 + f.overlap : f.cost + f.overlap / 100); // unknown cost after every known one
  // Cash on day one: the move-in cost plus any rent paid twice while your lease overlaps.
  // Your lease's last day: the date you set, or on a periodic (month-to-month) lease, your notice
  // period from the day you gave notice (or from today, if you haven't yet). '' when unknown.
  const leaseEndOf = (cfg, now = new Date()) => {
    if (!cfg.periodic) return cfg.leaseEnd || '';
    const n = Math.round(+cfg.noticeDays);
    if (!(n >= 1 && n <= NOTICE_MAX)) return '';
    return addDaysYmd(isYmd(cfg.noticeGiven || '') ? cfg.noticeGiven : ymdLocal(now), n);
  };
  // `moveExtra`: your own other moving costs (Settings), set beside `fit` when rows are filtered.
  // `rentNow`: the weekly rent you pay now (Settings), set beside `moveExtra`. Positive: dearer.
  const vsNow = (r) => (r.rentNow > 0 && Number.isFinite(r.priceNum) ? r.priceNum - r.rentNow : null);
  const vsNowLabel = (r) => { const d = vsNow(r); return d == null ? '' : d === 0 ? 'same as now' : `${d > 0 ? '+' : '−'}$${Math.abs(d)}/wk vs now`; };
  const cashToMove = (r) => (Number.isFinite(r.upfront) ? r.upfront + (r.fit?.cost || 0) + (r.moveExtra || 0) : null);

  const historyText = (r) => (r.priceHistory || []).map(([at, p]) => `${ymdLocal(new Date(at))} ${p}`).join(' → ');
  // REA's bond text ("$2200") in the same money format as move-in ("$2,200"), when it's one amount.
  const bondLabel = (r) => { const n = parsePrice(r.bond); return /^\$?\s*[\d,]+(?:\.\d+)?$/.test(String(r.bond).trim()) && Number.isFinite(n) ? money(n) : r.bond; };
  const ppbLabel = (r) => (+r.beds > 1 && Number.isFinite(r.ppb) ? `$${r.ppb}/bed` : '');

  // #endregion
  // #region exports
  const EXPORT_COLS = [
    ['availDate', 'available_date'], ['available', 'available'], ['price', 'price'], ['priceNum', 'weekly_rent'],
    ['ppb', 'rent_per_bed'], ['bond', 'bond'], ['bondWeeks', 'bond_weeks'], ['upfront', 'move_in_cost'], ['cashToMove', 'cash_to_move'], ['vsMedian', 'vs_median_pct'], ['vsNow', 'vs_current_rent'], ['amenList', 'amenities'], ['watchList', 'heads_up'], ['leaseText', 'lease'], ['applyVia', 'apply_via'], ['applyBy', 'apply_by'], ['takenText', 'taken'], ['byAppt', 'by_appointment'], ['fitText', 'lease_fit'], ['km', 'km'], ['score', 'match_score'], ['agency', 'agency'], ['photos', 'photos'], ['floorplan', 'floorplan'], ['sqm', 'floor_m2'], ['perSqmVal', 'rent_per_m2'], ['address', 'address'], ['suburb', 'suburb'], ['beds', 'beds'],
    ['baths', 'baths'], ['cars', 'cars'], ['type', 'type'], ['inspect', 'inspections'], ['listed', 'listed'],
    ['surrounding', 'nearby'], ['starred', 'shortlisted'], ['isNew', 'new'], ['prevPrice', 'previous_price'], ['prevAvail', 'previous_available'], ['priceHistoryText', 'price_history'], ['relistedText', 'relisted_from_price'], ['appStatus', 'application'], ['appDate', 'application_date'], ['declineReason', 'decline_reason'], ['rating', 'my_rating'], ['checksText', 'checklist'], ['answersText', 'agent_answers'], ['hideReason', 'hide_reason'], ['note', 'note'],
    ['headline', 'headline'], ['url', 'url'], ['id', 'id'], ['lat', 'lat'], ['lng', 'lng'], // last: lat/lng let Google My Maps plot the file
  ];
  const ymdLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const addDaysYmd = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return ymdLocal(new Date(y, m - 1, d + n)); }; // by the calendar, DST-proof
  // A "YYYY-MM-DD" day's first and last second, local time (deadlines run to the end of the day).
  const ymdStart = (ymd) => new Date(`${ymd}T00:00:00`), ymdEnd = (ymd) => new Date(`${ymd}T23:59:59`);
  const cellValue = (r, k) => {
    const v = k === 'availDate' ? r.avail : k === 'amenList' ? amenityTags(r).join('; ') : k === 'watchList' ? watchTags(r).join('; ')
      : k === 'takenText' ? TAKEN_LABELS[r.taken] || '' : k === 'appDate' ? (r.appAt ? new Date(r.appAt) : '') : k === 'checksText' ? Object.entries(r.checks || {}).map(([c, v]) => `${v === 'y' ? '✓' : '✗'} ${c}`).join('; ') : k === 'leaseText' ? leaseText(r.lease) : k === 'fitText' ? fitLabel(r.fit) : k === 'priceHistoryText' ? historyText(r) : k === 'relistedText' ? (r.relisted ? r.relisted.price || 'yes' : '') : k === 'perSqmVal' ? perSqm(r) : k === 'rating' ? r.rating || '' : k === 'cashToMove' ? cashToMove(r) ?? '' : k === 'vsNow' ? vsNow(r) ?? '' : k === 'answersText' ? answersText(r) : r[k];
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
  const geo = (r) => (Number.isFinite(r.lat) && Number.isFinite(r.lng) ? `GEO:${r.lat.toFixed(6)};${r.lng.toFixed(6)}` : '');
  // The last day to give notice: your lease end less the notice period you set ('' without both).
  const noticeBy = (leaseEnd, days) => {
    const n = Math.round(+days);
    if (!isYmd(leaseEnd || '') || !(n >= 1 && n <= NOTICE_MAX)) return '';
    return addDaysYmd(leaseEnd, -n);
  };
  // Within NOTICE_NUDGE_DAYS of the last day to give notice (and not given): { by, days } for the
  // Shortlist's nudge, days < 0 once that day has passed while the lease still runs.
  const NOTICE_NUDGE_DAYS = 14;
  // "Notice given on" counts only for this lease: a date from a lease a year or more back
  // (left in Settings) mustn't silence the next one.
  const noticeGivenFor = (leaseEnd, given) => {
    if (!isYmd(given || '') || !isYmd(leaseEnd || '')) return false;
    const [y, m, d] = leaseEnd.split('-').map(Number);
    return given >= ymdLocal(new Date(y - 1, m - 1, d));
  };
  const noticeDue = (cfg, now = new Date()) => {
    if (cfg.periodic) return null; // no fixed end: your notice sets the date, there's no deadline to miss
    const by = noticeBy(cfg.leaseEnd, cfg.noticeDays), today = ymdLocal(now);
    if (!by || noticeGivenFor(cfg.leaseEnd, cfg.noticeGiven) || cfg.leaseEnd < today) return null;
    const days = Math.round((ymdStart(by) - startOfDay(now)) / DAY_MS);
    return days <= NOTICE_NUDGE_DAYS ? { by, days } : null;
  };
  const ICS_SENT_MAX = 300; // events remembered from the last shortlist export (uid and start only)
  // Approved somewhere and not yet given notice: what's next (your notice date, whatever the
  // two-week window, and the other applications still waiting). null otherwise.
  const nextSteps = (rows, cfg, now = new Date()) => {
    const won = rows.find((r) => r.appStatus === 'approved'); // REA often takes it down once you're approved: still yours
    if (!won) return null;
    const end = leaseEndOf(cfg, now) || cfg.leaseEnd, today = ymdLocal(now);
    // Given notice: for this lease, or (no lease end to tell by) within the last year.
    const yearAgo = ymdLocal(new Date(now.getFullYear() - 1, now.getMonth(), now.getDate()));
    if (end ? noticeGivenFor(end, cfg.noticeGiven) : isYmd(cfg.noticeGiven || '') && cfg.noticeGiven >= yearAgo) return null;
    if (!cfg.periodic && cfg.leaseEnd && cfg.leaseEnd < today) return null; // your lease is already over: no notice to give
    const by = cfg.periodic ? '' : noticeBy(cfg.leaseEnd, cfg.noticeDays);
    const pending = rows.filter((r) => r !== won && r.appStatus === 'applied' && !deadEnd(r)).length;
    return { r: won, by, days: cfg.periodic ? Math.round(+cfg.noticeDays) || 0 : 0, pending };
  };
  // Tick lists kept in settings: your application pack (what you have ready to send) and, once
  // approved, your moving list. Ticks are item names; the moving list's are for one listing
  // ("id|item,item"), so moving again starts afresh.
  const PACK_DEFAULT = 'Photo ID, Payslips, Rental ledger, References, Bank statement';
  const MOVING_DEFAULT = 'Pay the bond, Pay rent in advance, Book removalists, Connect power and gas, Connect internet, Redirect mail, Update your address, Book the end-of-lease clean, Hand back the old keys, Claim your old bond back';
  const PAY_BOND = 'Pay the bond', PAY_ADVANCE = 'Pay rent in advance'; // moving-list items that are money: "left to pay"
  // The entry condition report, room by room (from the approved listing's bedrooms and bathrooms):
  // ticked once checked and photographed. What to look at in each room is on its printout.
  const ECR_ITEMS = ['Walls and ceiling', 'Floors', 'Windows and screens', 'Doors and locks', 'Lights and power points', 'Fixtures and fittings', 'Marks or damage'];
  const ecrRooms = (r) => {
    const beds = Math.min(6, Math.max(0, Math.round(+r.beds) || 0)), baths = Math.min(4, Math.max(1, Math.round(+r.baths) || 1));
    return [...(beds ? Array.from({ length: beds }, (_, i) => (beds > 1 ? `Bedroom ${i + 1}` : 'Bedroom')) : ['Main room']),
      ...Array.from({ length: baths }, (_, i) => (baths > 1 ? `Bathroom ${i + 1}` : 'Bathroom')), 'Kitchen', 'Living', 'Laundry', 'Entry and hall', 'Outside'];
  };
  const tickItems = (v, def) => [...new Set(String(v || def).split(/[,\n]/).map((x) => clip(x.replace(/\|/g, '/').trim(), 40)).filter(Boolean))].slice(0, CHECK_MAX); // | separates the listing id in moveDone
  const tickSet = (v) => new Set(String(v || '').split(',').filter(Boolean));
  const toggleIn = (set, x) => { if (set.has(x)) set.delete(x); else set.add(x); return set; };
  // A per-listing tick list stored as "id|item,item": its ticks when stored for `id`, else none.
  const idTicks = (v, id) => { const s = String(v || ''), bar = s.indexOf('|'); return bar >= 0 && s.slice(0, bar) === id ? tickSet(s.slice(bar + 1)) : new Set(); };
  // `done` with `x` flipped, stored for `id` in `items`' order ('' once nothing is ticked).
  const idTicksToggle = (id, items, done, x) => { const d = toggleIn(new Set(done), x); return d.size ? `${id}|${items.filter((i) => d.has(i)).join(',')}` : ''; };
  // `portals`: the apply portals your shortlisted listings name (2Apply, Snug…): each needs its
  // profile set up, so each is a pack item ("2Apply profile") while one is on the shortlist.
  const portalItem = (p) => `${p} profile`;
  const packPortals = (rows) => [...new Set(rows.filter((r) => r.applyVia && !deadEnd(r)).map((r) => r.applyVia))].sort();
  const packState = (cfg, portals = []) => { const items = [...new Set([...tickItems(cfg.packList, PACK_DEFAULT), ...portals.map(portalItem)])], done = tickSet(cfg.packDone); return { items, done: items.filter((i) => done.has(i)) }; };
  const packLabel = (cfg, portals = []) => { const { items, done } = packState(cfg, portals); return done.length === items.length ? 'Application pack ready' : `Pack: ${done.length} of ${items.length} ready`; };
  const packToggle = (cfg, item, portals = []) => { const { items } = packState(cfg, portals); return [...toggleIn(tickSet(cfg.packDone), item)].filter((i) => items.includes(i) || /\sprofile$/.test(i)).join(','); }; // a portal's tick outlives its listing
  // The apply-by nudge: how ready you are, and whether this listing's portal is set up.
  const applyReady = (r, cfg, portals = []) => `${packLabel(cfg, portals)}${r.applyVia && !tickSet(cfg.packDone).has(portalItem(r.applyVia)) ? ` · ${r.applyVia} profile not ready` : ''}`;
  // Approved somewhere: the moving list, what's next on it, moving day and when the entry
  // condition report is due (moving day plus your state's days). null otherwise.
  const movePlan = (rows, cfg) => {
    const won = rows.find((r) => r.appStatus === 'approved');
    if (!won) return null;
    const items = tickItems(cfg.movingList, MOVING_DEFAULT);
    const d = idTicks(cfg.moveDone, won.id);
    const moveDate = isYmd(cfg.moveDate || '') ? cfg.moveDate : '', days = Math.round(+cfg.ecrDays);
    // Money still to pay: the bond and rent in advance (from the listing), until ticked off.
    const bond = Number.isFinite(won.bondNum) ? won.bondNum : null, advance = Number.isFinite(won.priceNum) ? ADVANCE_WEEKS * won.priceNum : null;
    const owed = [[PAY_BOND, bond, 'bond'], [PAY_ADVANCE, advance, 'rent in advance']].filter(([item, amt]) => items.includes(item) && !d.has(item) && amt != null);
    const rooms = ecrRooms(won), er = idTicks(cfg.ecrDone, won.id);
    return { r: won, items, done: items.filter((i) => d.has(i)), next: items.find((i) => !d.has(i)) || '', moveDate, ecrBy: moveDate && days >= 1 && days <= 30 ? addDaysYmd(moveDate, days) : '',
      owed: owed.map(([, amt, what]) => ({ amt, what })), rooms, roomsDone: rooms.filter((x) => er.has(x)) };
  };
  const owedLabel = (plan) => (plan.owed.length ? `Left to pay: ${money(plan.owed.reduce((n, x) => n + x.amt, 0))} (${plan.owed.map((x) => `${x.what} ${money(x.amt)}`).join(', ')})` : '');
  const ecrToggle = (plan, room) => idTicksToggle(plan.r.id, plan.rooms, plan.roomsDone, room);
  // The condition report as a printable checklist: each room, what to look at, room to write.
  const ecrPrintHtml = (plan, now = new Date()) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Condition report checklist</title><style>
body{font:13px/1.45 system-ui,-apple-system,sans-serif;color:#111;background:#fff;margin:24px}h1{font-size:18px;margin:0 0 4px}.sub{color:#555;margin-bottom:12px}
h2{font-size:14px;margin:16px 0 4px;break-after:avoid}table{width:100%;border-collapse:collapse;break-inside:avoid}td,th{border:1px solid #bbb;padding:4px 6px;text-align:left;vertical-align:top}
th{background:#f4f4f6;font-weight:600}td.w{width:45%}td.c{width:12%;text-align:center}@media print{body{margin:10mm}}
</style></head><body><h1>Condition report checklist</h1><div class="sub">${esc(plan.r.address || '')}${plan.ecrBy ? ` · return the report by ${esc(plan.ecrBy)}` : ''} · printed ${esc(now.toLocaleDateString('en-AU'))}</div>
<p>Before you sign the agent's report, check each item, note anything worn or damaged, and take dated photos: the report is what your bond is judged against.</p>
${plan.rooms.map((room) => `<h2>${esc(room)}</h2><table><tr><th>Item</th><th>Condition and notes</th><th>Photo</th><th>Agrees with agent</th></tr>${ECR_ITEMS.map((i) => `<tr><td>${esc(i)}</td><td class="w"></td><td class="c">☐</td><td class="c">☐</td></tr>`).join('')}</table>`).join('')}
</body></html>`;
  const moveToggle = (cfg, plan, item) => idTicksToggle(plan.r.id, plan.items, plan.done, item); // `cfg`: unused, kept for callers
  const toIcs = (rows, now = Date.now(), { alarm = 0, leaseEnd = '', noticeDays = 0, noticeGiven = '', followUps = false, move = null, prev = null, sent = null } = {}) => {
    // Minutes since 1970: each export's events outrank the last one's, so a session cancelled
    // and then reinstated is live again when the newer file is imported.
    const seq = Math.floor(now / 60000);
    const events = [];
    const seen = new Set();
    for (const r of rows) {
      for (const i of r.inspections || []) {
        if (typeof i.at !== 'number' || i.at < now - INSPECT_GRACE_MS) continue;
        const uid = `${r.id}-${i.at}@rea-enhancement`;
        if (seen.has(uid)) continue;
        seen.add(uid);
        // A dead end (declined, taken, hidden, gone): its sessions go out cancelled, like a
        // session REA cancelled, so re-importing takes them out of the calendar.
        if (deadEnd(r)) {
          events.push(['BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${icsTime(now)}`, `DTSTART:${icsTime(i.at)}`, `DURATION:PT${INSPECT_MINUTES}M`,
            `SEQUENCE:${seq}`, 'STATUS:CANCELLED', `SUMMARY:${icsText(`Cancelled: inspection ${r.address || 'rental'}`)}`, `LOCATION:${icsText(r.address)}`, 'END:VEVENT']);
          continue;
        }
        events.push(['BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${icsTime(now)}`, `DTSTART:${icsTime(i.at)}`,
          `DURATION:PT${INSPECT_MINUTES}M`, `SEQUENCE:${seq}`, `SUMMARY:${icsText(`Inspection: ${r.address || 'rental'}`)}`,
          `LOCATION:${icsText(r.address)}`, geo(r), r.url ? `URL:${r.url}` : '',
          `DESCRIPTION:${icsText([r.price, r.available && `Available ${availOut(r)}`, r.agency, r.applyVia && `Apply via ${r.applyVia}`, leaseText(r.lease), r.appStatus && `Status: ${r.appStatus}`, r.note].filter(Boolean).join(' | '))}`,
          ...(alarm > 0 ? ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(`Inspection: ${r.address || 'rental'}`)}`, `TRIGGER:-PT${Math.round(alarm)}M`, 'END:VALARM'] : []),
          'END:VEVENT'].filter(Boolean));
      }
    }
    // A session REA cancelled goes out again with the same UID and STATUS:CANCELLED, so importing
    // the file again takes it out of the calendar (where the app honours it).
    for (const r of rows) {
      const at = r.inspectCancelledAt;
      if (typeof at !== 'number' || at < now - INSPECT_GRACE_MS) continue;
      const uid = `${r.id}-${at}@rea-enhancement`;
      if (seen.has(uid)) continue;
      seen.add(uid);
      events.push(['BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${icsTime(now)}`, `DTSTART:${icsTime(at)}`, `DURATION:PT${INSPECT_MINUTES}M`,
        `SEQUENCE:${seq}`, 'STATUS:CANCELLED', `SUMMARY:${icsText(`Cancelled: inspection ${r.address || 'rental'}`)}`, `LOCATION:${icsText(r.address)}`, geo(r), 'END:VEVENT'].filter(Boolean));
    }
    // All-day reminders: chase an application with no answer (on the day the drawer starts
    // nudging, or today once that's passed), and your own lease end. Fixed UIDs, so a later
    // export moves them rather than adding a second one.
    // A reminder no longer needed (you applied, heard back, or the listing is gone or taken) goes
    // out again cancelled under its UID, like a cancelled inspection, so re-importing removes it.
    // With a calendar reminder set, live ones alert at 9am the day before.
    const allDay = (uid, ymd, summary, extra = [], { cancel = false, alarm: wantAlarm = true } = {}) => events.push(['BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${icsTime(now)}`,
      `DTSTART;VALUE=DATE:${ymd.replace(/-/g, '')}`, `SEQUENCE:${seq}`, 'TRANSP:TRANSPARENT', cancel ? 'STATUS:CANCELLED' : '', `SUMMARY:${icsText(cancel ? `Cancelled: ${summary}` : summary)}`, ...extra,
      ...(alarm > 0 && !cancel && wantAlarm ? ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(summary)}`, 'TRIGGER:-PT15H', 'END:VALARM'] : []), 'END:VEVENT'].filter(Boolean));
    const today = ymdLocal(new Date(now));
    for (const r of followUps ? rows : []) {
      if (typeof r.appAt !== 'number' || !['applied', 'approved', 'declined'].includes(r.appStatus) || seen.has(`${r.id}-fu`)) continue;
      seen.add(`${r.id}-fu`);
      const due = ymdLocal(new Date(r.appAt + FOLLOW_UP_DAYS * DAY_MS)), cancel = r.appStatus !== 'applied' || deadEnd(r);
      if (cancel && due < today) continue; // long past: nothing in the calendar worth taking out
      allDay(`${r.id}-fu@rea-enhancement`, due < today ? today : due, `Follow up: ${r.address || 'rental application'}`,
        [r.url ? `URL:${r.url}` : '', `DESCRIPTION:${icsText([`Applied ${ymdLocal(new Date(r.appAt))}`, r.agency, r.applyVia && `via ${r.applyVia}`].filter(Boolean).join(' | '))}`], { cancel, alarm: due >= today }); // moved to today: an alarm the day before would be in the past
    }
    for (const r of followUps ? rows : []) {
      if (!r.applyBy || r.applyBy < today || seen.has(`${r.id}-ab`)) continue;
      seen.add(`${r.id}-ab`);
      allDay(`${r.id}-ab@rea-enhancement`, r.applyBy, `Applications close: ${r.address || 'rental'}`, [r.url ? `URL:${r.url}` : ''],
        { cancel: ['applied', 'approved', 'declined'].includes(r.appStatus) || deadEnd(r), alarm: r.applyBy > today }); // today's: the day-before alarm has gone
    }
    if (isYmd(leaseEnd || '') && leaseEnd >= today) {
      allDay('lease-end@rea-enhancement', leaseEnd, 'My current lease ends', [], { alarm: leaseEnd > today });
      // Your own notice period (it varies by state and lease, so it's yours to enter): the last
      // day to give notice, or today if that's already passed.
      const by = noticeBy(leaseEnd, noticeDays);
      if (by) {
        allDay('notice@rea-enhancement', by < today ? today : by, `Give notice to vacate (lease ends ${leaseEnd})`,
          [`DESCRIPTION:${icsText(`${Math.round(+noticeDays)} days' notice, as you set it. Check your lease and your state's tenancy rules.`)}`], { cancel: noticeGivenFor(leaseEnd, noticeGiven), alarm: by >= today });
      }
    }
    // Your move (`move`: movePlan's result): moving day, with what's left on the moving list, and
    // the day the entry condition report is due.
    if (move?.moveDate && move.moveDate >= today) {
      const addr = move.r.address || 'your new place', left = move.items.filter((i) => !move.done.includes(i));
      allDay('move@rea-enhancement', move.moveDate, `Moving day: ${addr}`, left.length ? [`DESCRIPTION:${icsText(`Still to do: ${left.join(', ')}`)}`] : [], { alarm: move.moveDate > today });
    }
    if (move?.ecrBy && move.ecrBy >= today) {
      allDay('ecr@rea-enhancement', move.ecrBy, `Return the condition report: ${move.r.address || 'new place'}`,
        [`DESCRIPTION:${icsText("Note and photograph anything worn or damaged before you send it back: it's what your bond is judged against.")}`], { alarm: move.ecrBy > today });
    }
    // `prev`: what the last shortlist export sent ([{ u: uid, s: DTSTART line }]). Anything upcoming
    // that isn't in this one (unshortlisted, a deadline the agent removed, a lease end cleared)
    // goes out cancelled; `sent` gets this export's live events for next time.
    const uidOf = (e) => e.find((l) => l.startsWith('UID:')).slice(4), startOf = (e) => e.find((l) => l.startsWith('DTSTART'));
    const live = events.filter((e) => !e.includes('STATUS:CANCELLED'));
    if (Array.isArray(prev)) {
      const here = new Set(events.map(uidOf)), todayIcs = ymdLocal(new Date(now)).replace(/-/g, '');
      for (const p of prev) {
        // Only what this script writes (nothing a same-page script could slip a line break into).
        if (!p || typeof p.u !== 'string' || !/^[\w.-]+@rea-enhancement$/.test(p.u) || here.has(p.u)) continue;
        const t = String(p.s || '').match(/^DTSTART(?:;VALUE=DATE:(\d{8})|:(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z)$/);
        if (!t) continue;
        // Past: leave it be. A timed one is compared as the instant it is (its stamp is UTC, so its
        // date isn't today's local date before 10am in Sydney); an all-day one by date.
        if (t[1] ? t[1] < todayIcs : Date.UTC(+t[2], +t[3] - 1, +t[4], +t[5], +t[6], +t[7]) < now - INSPECT_GRACE_MS) continue;
        here.add(p.u);
        events.push(['BEGIN:VEVENT', `UID:${p.u}`, `DTSTAMP:${icsTime(now)}`, p.s, `SEQUENCE:${seq}`, 'STATUS:CANCELLED', 'SUMMARY:Cancelled: no longer on your shortlist', 'END:VEVENT']);
      }
    }
    // Over the cap, the few reminders (lease end, notice, follow-ups, deadlines) are kept before inspections.
    if (Array.isArray(sent)) sent.push(...live.map((e) => ({ u: uidOf(e), s: startOf(e) })).sort((a, b) => /;VALUE=DATE:/.test(b.s) - /;VALUE=DATE:/.test(a.s)).slice(0, ICS_SENT_MAX));
    if (!events.length) return '';
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//rea-enhancement//EN', 'CALSCALE:GREGORIAN', ...events.flat(), 'END:VCALENDAR']
      .map(icsFold).join('\r\n') + '\r\n';
  };

  // #endregion
  // #region share links
  // Share a shortlist as a link: the data rides in the URL fragment (after #), which browsers
  // never send to the server. Decoding is untrusted input: every field is re-validated.
  const SHARE_MAX = 30;
  const SHARE_PARAM = 'rf-share';
  const b64url = (str) => btoa(String.fromCharCode(...new TextEncoder().encode(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64url = (b) => new TextDecoder().decode(Uint8Array.from(atob(b.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));
  // `notes`: your notes, application statuses and ratings go too (opt-in: for a partner you're
  // searching with). Links made before these existed decode the same.
  const encodeShare = (rows, { notes = false } = {}) => b64url(JSON.stringify({ a: 'rea-enhancement', v: 1,
    l: rows.slice(0, SHARE_MAX).map((r) => ({ i: r.id, u: r.url, a: clip(r.address, 120), p: clip(r.price, 60), v: clip(availOut(r), 40),
      b: scalar(r.beds), ba: scalar(r.baths), c: scalar(r.cars), ...(notes && r.note ? { n: clip(r.note, NOTE_MAX) } : {}),
      ...(notes && r.appStatus ? { s: r.appStatus } : {}), ...(notes && r.rating ? { r: r.rating } : {}) })) }));
  const decodeShare = (b) => {
    let d;
    try { d = JSON.parse(unb64url(String(b || ''))); } catch { return null; }
    if (d?.a !== 'rea-enhancement' || !Array.isArray(d.l)) return null;
    return d.l.slice(0, SHARE_MAX).map((x) => ({
      id: isListingId(x?.i) ? String(x.i) : '', url: safeUrl(x?.u), address: clip(x?.a, 120), price: clip(x?.p, 60),
      available: clip(x?.v, 40), beds: scalar(x?.b), baths: scalar(x?.ba), cars: scalar(x?.c), note: clip(x?.n, NOTE_MAX),
      status: x?.s && APP_STATUSES.includes(x.s) ? x.s : '', rating: Number.isInteger(x?.r) && x.r >= 1 && x.r <= 5 ? x.r : 0,
    })).filter((r) => r.id && r.url && /^https:\/\/www\.realestate\.com\.au\//.test(r.url));
  };
  const shareUrl = (rows, opts) => `https://www.realestate.com.au/rent/#${SHARE_PARAM}=${encodeShare(rows, opts)}`;
  const shareFromHash = (hash) => { const m = String(hash || '').match(new RegExp(`[#&]${SHARE_PARAM}=([A-Za-z0-9_-]+)`)); return m ? decodeShare(m[1]) : null; };

  // Inspection planner: one day's shortlisted inspections in order, with clashes and gaps too
  // short for the straight-line distance flagged. A rough guide, not a route planner.
  const PLAN_MIN_PER_KM = 2; // ~30 km/h door to door in traffic
  // At an inspection, on the listing page: the next shortlisted inspection today (the listing's
  // own day), how far it is from here and when to leave. Null when there's none left today.
  const nextStop = (rows, here, now = Date.now()) => {
    const tz = tzOf(here), day = ymdIn(now, tz);
    let best = null;
    for (const r of rows) {
      // Not this one, and not a dead end: taken down, hidden, declined or already taken.
      if (r.id === here.id || deadEnd(r)) continue;
      for (const i of r.inspections || []) {
        if (typeof i.at !== 'number' || i.at <= now || ymdIn(i.at, tzOf(r)) !== day) continue;
        if (!best || i.at < best.at) best = { r, at: i.at, label: i.label };
      }
    }
    if (!best) return null;
    const km = kmBetween(here, best.r);
    return { ...best, km, leaveBy: km == null ? null : best.at - Math.max(PLAN_MIN_GAP, Math.round(km * PLAN_MIN_PER_KM)) * 60000 };
  };
  const PLAN_MIN_GAP = 10; // minutes between inspections below which it's "tight" regardless of distance
  // Inspection times are the listing's local time: group and show them in its state's zone
  // (from the address), so a Perth listing planned from Sydney lands on the right day.
  const STATE_TZ = { NSW: 'Australia/Sydney', ACT: 'Australia/Sydney', VIC: 'Australia/Melbourne', TAS: 'Australia/Hobart',
    QLD: 'Australia/Brisbane', SA: 'Australia/Adelaide', WA: 'Australia/Perth', NT: 'Australia/Darwin' };
  const tzMemo = new Map();
  const tzOf = (r) => {
    const k = `${r.state || ''}|${r.address || ''}`;
    if (tzMemo.has(k)) return tzMemo.get(k);
    // Broken Hill (NSW 2880) keeps South Australian time.
    const v = /\b2880\b/.test(String(r.address || '')) ? 'Australia/Broken_Hill'
      : STATE_TZ[String(r.state || (String(r.address || '').match(/\b(NSW|ACT|VIC|TAS|QLD|SA|WA|NT)\b(?!.*\b(NSW|ACT|VIC|TAS|QLD|SA|WA|NT)\b)/) || [])[1] || '').toUpperCase()] || null;
    if (tzMemo.size > 20000) tzMemo.clear();
    tzMemo.set(k, v);
    return v;
  };
  const dayFmts = new Map();
  const ymdMemo = new Map();
  const ymdIn = (ms, tz) => {
    if (!tz) return ymdLocal(new Date(ms));
    const k = `${tz}|${ms}`, hit = ymdMemo.get(k);
    if (hit) return hit;
    let f = dayFmts.get(tz);
    if (!f) dayFmts.set(tz, (f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })));
    if (ymdMemo.size > 20000) ymdMemo.clear();
    const v = f.format(ms);
    ymdMemo.set(k, v);
    return v;
  };
  const inspectDays = (rows) => {
    const days = new Map();
    for (const r of rows) for (const i of r.inspections || []) if (typeof i.at === 'number') {
      const k = ymdIn(i.at, tzOf(r));
      days.set(k, (days.get(k) || 0) + 1);
    }
    return [...days].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, n]) => ({ day, n }));
  };
  // Dead ends (declined, taken, gone, hidden) are left out and counted in `skipped`; with your
  // own inspection times (`free`), a session outside them is marked and never routed.
  const planDay = (rows, day, { free = null } = {}) => {
    const slots = [];
    let skipped = 0;
    for (const r of rows) for (const i of r.inspections || []) {
      const tz = tzOf(r);
      if (typeof i.at !== 'number' || ymdIn(i.at, tz) !== day) continue;
      if (deadEnd(r)) { skipped++; continue; }
      slots.push({ r, tz, at: i.at, end: i.at + INSPECT_MINUTES * 60e3, label: i.label, outside: !!free && !inspectFits(i.at, tz, 'mine', free) });
    }
    slots.skipped = skipped;
    slots.sort((a, b) => a.at - b.at);
    for (let k = 1; k < slots.length; k++) {
      const prev = slots[k - 1], cur = slots[k];
      cur.gapMin = Math.round((cur.at - prev.end) / 60e3);
      cur.km = kmBetween(prev.r, cur.r);
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
  const bestRoute = (all) => {
    const slots = all.filter((x) => !x.outside);
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
    const norm = fold; // "cafe" finds "Café", "o'connell" finds "O’Connell"
    const terms = norm(q).split(/\s+/).filter(Boolean);
    if (!terms.length) return true;
    const hay = norm([r.address, r.note, r.agency, r.suburb, r.price, r.appStatus, r.type].filter(Boolean).join(' '));
    return terms.every((t) => hay.includes(t));
  };

  // Enquiry message from a template: {address} {price} {available} {inspection} {link} {questions}.
  const ENQUIRY_DEFAULT = 'Hi, I\'m interested in {address} ({price}). Is it still available{available}? {inspection}Thanks.';
  // Your inspection times (Settings) as a sentence for {mytimes}: "I can inspect Sat 9am–1pm, Sun, or weekdays after 5:30pm."
  const clock12 = (m) => { const h = Math.floor(m / 60) % 24, mm = m % 60; return `${h % 12 || 12}${mm ? `:${String(mm).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`; };
  const freeTimesText = (v) => {
    const slots = parseFreeTimes(v);
    if (!slots?.length) return '';
    const days = (set) => {
      const d = [...set].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)); // Monday first
      const k = [...d].sort().join();
      return k === '0,1,2,3,4,5,6' ? 'any day' : k === '1,2,3,4,5' ? 'weekdays' : k === '0,6' ? 'weekends' : d.map((x) => DAY_NAMES[x].charAt(0).toUpperCase() + DAY_NAMES[x].slice(1, 3)).join('/');
    };
    const parts = slots.map(({ days: ds, from, to }) => `${days(ds)}${from <= 0 && to >= 1440 ? '' : from <= 0 ? ` before ${clock12(to)}` : to >= 1440 ? ` after ${clock12(from)}` : ` ${clock12(from)}–${clock12(to)}`}`);
    return `I can inspect ${parts.length > 1 ? `${parts.slice(0, -1).join(', ')} or ${parts.at(-1)}` : parts[0]}.`;
  };
  // A by-appointment listing: ask for a viewing at your times.
  const VIEWING_TEMPLATE = "Hi, could I arrange a viewing of {address} ({price})? {mytimes} Thanks.";
  const enquiryText = (r, template, amenities = '', free = '') => String(template || ENQUIRY_DEFAULT)
    .replace(/\{address\}/g, () => r.address || 'this property').replace(/\{price\}/g, () => r.price || 'price on request') // functions: a $ in the text isn't a pattern
    .replace(/\{available\}/g, () => {
      const a = String(r.available && r.available !== '-' ? availOut(r) : '').replace(/^available\s*(from\s*)?/i, '').trim();
      return !a ? '' : /^now$/i.test(a) ? ' now' : ` from ${a}`;
    })
    .replace(/\{inspection\}/g, () => (r.inspections?.[0]?.label ? `I'd like to come to the inspection on ${r.inspections[0].label}. ` : r.byAppt ? 'Could I book a private inspection? ' : 'Could I arrange an inspection? '))
    .replace(/\{link\}/g, () => r.url || '').replace(/\{questions\}/g, () => askList(r, amenities, { open: true }).join(' ')).replace(/\{mytimes\}/g, () => freeTimesText(free))
    .replace(/ {2,}/g, ' ').replace(/\s+\n/g, '\n').trim(); // an empty placeholder leaves no double space

  // One listing as plain text for a message.
  // "Available 12 Oct · 2 bed, 1 bath, ? car · move-in $3,300": shared by Copy and Print.
  const factsLine = (r, sep) => [r.available && r.available !== '-' ? `Available ${availOut(r)}` : '',
    [r.beds, r.baths, r.cars].some((v) => v !== '' && v != null) ? [`${orQ(r.beds)} bed`, `${orQ(r.baths)} bath`, `${orQ(r.cars)} car`].join(sep) : '',
    Number.isFinite(r.upfront) ? `move-in ${money(r.upfront)}` : ''].filter(Boolean).join(' · ');
  const summaryText = (r) => [
    `${r.price || 'Price on request'} - ${r.address}`,
    factsLine(r, ', '),
    r.inspections?.length ? `Inspections: ${r.inspections.map((i) => i.label).join('; ')}` : '',
    r.url,
  ].filter(Boolean).join('\n');

  // Printable shortlist: a standalone HTML document (all text escaped), light theme forced.
  const printHtml = (rows, now = new Date(), checklist = [], amenities = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Rental shortlist ${ymdLocal(now)}</title><style>
body{font:13px/1.45 system-ui,-apple-system,sans-serif;color:#111;background:#fff;margin:24px}
h1{font-size:18px;margin:0 0 4px}.sub{color:#555;margin-bottom:16px}
.l{display:grid;grid-template-columns:150px 1fr;gap:14px;padding:12px 0;border-top:1px solid #ddd;break-inside:avoid}
.l img{width:150px;height:110px;object-fit:cover;border-radius:6px;background:#eee}
.p{font-weight:700;font-size:15px}.a{font-weight:600}.m{color:#444;margin-top:2px}.n{margin-top:6px;padding:6px 8px;background:#f4f4f6;border-radius:4px;white-space:pre-wrap}
.box{margin-top:8px;height:64px;border:1px dashed #aaa;border-radius:4px;color:#999;font-size:11px;padding:4px}
.u{color:#666;font-size:11px;word-break:break-all}.q{margin:4px 0 0;padding-left:18px}@media print{body{margin:10mm}}
</style></head><body><h1>Rental shortlist</h1><div class="sub">${plural(rows.length, 'listing')} · printed ${esc(now.toLocaleDateString('en-AU'))}</div>
${rows.map((r) => `<div class="l">${r.img ? `<img src="${esc(r.img)}" alt="">` : '<div></div>'}<div>
<div class="p">${esc(r.price)}</div><div class="a">${esc(r.address)}</div>
<div class="m">${esc(factsLine(r, ' · '))}</div>
${(r.inspections || []).length ? `<div class="m">Inspections: ${esc(r.inspections.map((i) => i.label).join('; '))}</div>` : ''}
${r.agency ? `<div class="m">${esc(r.agency)}</div>` : ''}${r.appStatus ? `<div class="m">Status: ${esc(r.appStatus)}</div>` : ''}${r.rating ? `<div class="m">My rating: ${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</div>` : ''}
${r.note ? `<div class="n">${esc(r.note)}</div>` : ''}${askItems(r, amenities).length ? `<div class="m">Ask:</div><ul class="q">${askItems(r, amenities).map((x) => `<li>${x.a === 'y' ? '☑ ' : x.a === 'n' ? '☒ ' : '☐ '}${esc(x.q)}</li>`).join('')}</ul>` : ''}${checklist.length ? `<div class="m">${checklist.map((k) => `${own(r.checks, k) === 'y' ? '☑' : own(r.checks, k) === 'n' ? '☒' : '☐'} ${esc(k)}`).join('  ')}</div>` : ''}<div class="box">Notes at inspection</div><div class="u">${esc(r.url)}</div>
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
  // #endregion
  // #region health
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

  // #endregion
  // #region views
  // Node test harness: expose pure functions, skip all DOM work.
  // Views drawn in place of the list (day planner, map, market, compare): pure, so unit-tested.
  // Each view drawn in place of the list has its own way back (not only its toggle up top).
  const viewClose = (view, label) => `<button type="button" class="rf-view-x" data-view-close="${view}" aria-label="${label}" title="${label}">×</button>`;
  function planHtml(slots, day) {
    // Zone name only when the listing's clock differs from yours (Melbourne from Sydney doesn't).
    const clock = (ms, tz) => dtf({ hour: 'numeric', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) }).format(ms);
    const t = (ms, tz) => (tz && clock(ms, tz) !== clock(ms) ? dtf({ hour: 'numeric', minute: '2-digit', timeZone: tz, timeZoneName: 'short' }).format(ms) : clock(ms, tz))
      .replace(/\s?(am|pm)/i, (m) => m.trim().toLowerCase());
    const clashes = slots.filter((x) => x.flag).length;
    const route = bestRoute(slots);
    const partial = route.listings > 1 && route.visits < route.listings;
    const inRoute = new Set([...route.picked].map((x) => x.r.id));
    return `<div class="rf-planner"><div class="rf-plan-head">${viewClose('plan', 'Close the day plan')}${esc(shortDate(day))}: ${plural(slots.length, 'inspection')}${clashes ? `, <strong>${clashes} to check</strong>` : ''}
      <button class="rf-btn sec" data-plan-ics>Calendar for this day</button></div>
      ${route.listings > 1 ? `<div class="rf-plan-route"><span>Suggested route: <strong>${route.visits} of ${plural(route.listings, 'listing')}</strong>${partial ? ' (the rest clash or are too far to reach in time)' : ''}</span>${partial || route.picked.size < slots.length ? ' <button class="rf-btn sec" data-plan-ics="route">Calendar for the route</button>' : ''}</div>` : ''}
      <ol>${slots.map((x) => {
        const tag = x.outside ? '<span class="rf-tag">outside your times</span>' : route.listings < 2 ? '' : route.picked.has(x) ? '<span class="rf-tag rf-new">route</span>'
          : inRoute.has(x.r.id) ? '<span class="rf-tag">other time</span>' : '<span class="rf-tag">skip</span>';
        return `<li class="${[x.flag ? `rf-${x.flag}` : '', route.listings > 1 && !route.picked.has(x) ? 'rf-off-route' : ''].filter(Boolean).join(' ')}"><span class="rf-plan-t">${t(x.at, x.tz)}</span>
        <a href="${esc(x.r.url)}" target="_blank" rel="noopener">${esc(x.r.address)}</a> <span class="rf-type">${esc(x.r.price)}</span>${tag}
        ${x.gapMin != null ? `<div class="rf-meta">${x.same ? 'Another time for the same listing' : x.flag === 'clash' ? 'Overlaps the previous inspection' : `${x.gapMin} min after the previous${x.km != null ? `, ${x.km} km away` : ''}${x.flag === 'tight' ? ' — tight' : ''}`}</div>` : ''}
      </li>`;
      }).join('')}</ol>${slots.skipped ? `<div class="rf-meta">${plural(slots.skipped, 'session')} left out: declined, taken, hidden or no longer listed.</div>` : ''}<div class="rf-meta">Assumes ${INSPECT_MINUTES} min per inspection and straight-line distance (about ${60 / PLAN_MIN_PER_KM} km/h, at least ${PLAN_MIN_GAP} min between); "to inspect" listings are favoured. A guide, not a timetable.</div></div>`;
  }

  function mapHtml(rows, cfg) {
    const pins = [...parsePlaces(cfg.places), ...(parseAnchor(cfg.anchor) ? [{ label: 'From', ...parseAnchor(cfg.anchor) }] : [])];
    const m = mapLayout(rows, pins);
    if (!m) return `<div class="rf-market"><div class="rf-plan-head">${viewClose('map', 'Close the map')}None of these listings has a location, so there is nothing to map.</div></div>`;
    const first = m.dots.find((d) => d.r.starred) || m.dots[0]; // one tab stop; arrows move between dots
    const dot = (d) => { const med = medianLabel(d.r); return `<circle cx="${d.x}" cy="${d.y}" r="${d.r.starred ? 6 : 4.5}" class="rf-dot rf-dot-${mapTone(d.r)}${d.r.starred ? ' rf-dot-star' : ''}" data-map-id="${esc(d.r.id)}" tabindex="${d === first ? 0 : -1}" role="button"
      aria-label="${esc(`${d.r.price}, ${d.r.address}${d.r.starred ? ', shortlisted' : ''}${med ? `, ${med}` : ''}`)}"><title>${esc(`${d.r.price} · ${d.r.address}${med ? ` · ${med}` : ''}`)}</title></circle>`; };
    return `<div class="rf-market rf-map"><div class="rf-plan-head">${viewClose('map', 'Close the map')}${plural(m.dots.length, 'listing')} on the map${m.skipped ? ` (${m.skipped} without a location not shown)` : ''}. Click one to go to it.</div>
      <svg viewBox="0 0 ${m.w} ${m.h}" role="group" aria-label="Map of the listings shown">
        ${m.labels.map((l) => `<text x="${l.x}" y="${l.y - 8}" class="rf-map-sub" text-anchor="middle">${esc(l.name)}</text>`).join('')}
        ${m.dots.filter((d) => !d.r.starred).map(dot).join('')}${m.dots.filter((d) => d.r.starred).map(dot).join('')}
        ${m.pins.map((p) => `<g class="rf-map-pin"><rect x="${p.x - 4}" y="${p.y - 4}" width="8" height="8"/><text x="${p.x + 7}" y="${p.y + 4}">${esc(p.label)}</text></g>`).join('')}
        ${m.far.map((p) => `<g class="rf-map-pin rf-map-far"><path d="M0,-5 L9,0 L0,5 z" transform="translate(${p.x},${p.y}) rotate(${-p.angle})"/><text x="${p.x}" y="${p.y + (p.y > m.h / 2 ? -8 : 14)}" text-anchor="${p.x > m.w * 0.66 ? 'end' : p.x < m.w * 0.33 ? 'start' : 'middle'}">${esc(p.label)} ${p.km} km</text></g>`).join('')}
        <g class="rf-map-scale"><line x1="10" y1="${m.h - 10}" x2="${10 + m.scale.px}" y2="${m.h - 10}"/><text x="10" y="${m.h - 14}">${m.scale.km < 1 ? `${m.scale.km * 1000} m` : `${m.scale.km} km`}</text></g>
      </svg>
      <div class="rf-meta rf-map-key"><span class="rf-dot-lo">●</span> below the median · <span class="rf-dot-mid">●</span> near it · <span class="rf-dot-hi">●</span> above · <span class="rf-dot-na">●</span> no median · larger: shortlisted · ■ your places. Straight lines, no streets.</div></div>`;
  }

  // `records`: your own applications per agency (agencyRecord), shown beside the counts.
  function marketHtml(m, trend = '', { records = null, hiddenAg = new Set() } = {}) {
    const $ = (v) => (v == null ? '–' : money(v));
    const range = (a, b) => (a == null ? '–' : a === b ? $(a) : `${$(a)}–${$(b)}`);
    const top = Math.max(1, ...m.byWeek.map((w) => w.n));
    const weekLabel = (w) => w.label || shortDate(w.from);
    return `<div class="rf-market"><div class="rf-plan-head">${viewClose('market', 'Close the market view')}${plural(m.n, 'listing')} shown${m.median != null ? ` · median ${$(m.median)}/wk` : ''}</div>
      ${trend ? `<div class="rf-meta rf-trend" title="This whole search, one point per visit (up to ${TREND_MAX})">Trend: ${esc(trend)}</div>` : ''}
      <div class="rf-market-t"><table><caption>Weekly rent by bedrooms</caption><thead><tr><th scope="col">Beds</th><th scope="col">Listings</th><th scope="col">Median</th><th scope="col">Middle half</th><th scope="col">Range</th><th scope="col">Per bed</th></tr></thead>
      <tbody>${m.byBeds.map((g) => `<tr><th scope="row">${g.beds === 0 ? 'Studio' : g.beds === 5 ? '5+' : g.beds}</th><td>${g.n}</td><td>${$(g.median)}</td>
        <td>${range(g.p25, g.p75)}</td><td>${range(g.min, g.max)}</td><td>${$(g.ppb)}</td></tr>`).join('')}</tbody></table></div>
      ${m.bySuburb.length ? `<div class="rf-market-t"><table><caption>By suburb</caption><thead><tr><th scope="col">Suburb</th><th scope="col">Listings</th><th scope="col">Median</th><th scope="col">Per bed</th></tr></thead>
      <tbody>${m.bySuburb.map((g) => `<tr><th scope="row">${esc(g.suburb)}</th><td>${g.n}</td><td>${$(g.median)}</td><td>${$(g.ppb)}</td></tr>`).join('')}</tbody></table></div>` : ''}
      ${m.byAgency?.length ? `<div class="rf-market-t"><table><caption>By agency, in these listings</caption><thead><tr><th scope="col">Agency</th><th scope="col">Listings</th><th scope="col">Rent dropped</th><th scope="col">Relisted</th><th scope="col">Says taken</th><th scope="col">Median days listed</th>${records ? '<th scope="col">Your applications</th>' : ''}<th scope="col"><span class="rf-sr">Hide</span></th></tr></thead>
      <tbody>${m.byAgency.map((g) => `<tr><th scope="row">${esc(g.agency)}</th><td>${g.n}</td><td>${g.dropped}</td><td>${g.relisted}</td><td>${g.taken}</td><td>${g.medianDays ?? '–'}</td>${records ? `<td>${esc(recordText(records.get(agencyKey(g.agency)))) || '–'}</td>` : ''}<td><button type="button" class="rf-btn sec" data-market-ag="${esc(g.agency)}" aria-label="${hiddenAg.has(agencyKey(g.agency)) ? 'Show' : 'Hide'} every listing from ${esc(g.agency)}">${hiddenAg.has(agencyKey(g.agency)) ? 'Unhide' : 'Hide'}</button></td></tr>`).join('')}</tbody></table>
      <div class="rf-meta">Counts from the listings shown, not a rating of the agency. Days listed are from REA's listed date, or when this browser first saw the listing.</div></div>` : ''}
      <h3>Available</h3><ul class="rf-bars">${m.byWeek.map((w, i) => [w, i]).filter(([w]) => w.n || w.from).map(([w, i]) => {
        const data = w.label === 'Unknown' ? '' : ` data-week="${i}"`;
        const inner = `<span>${esc(weekLabel(w))}</span><span class="rf-bar" style="width:${Math.round((w.n / top) * 100)}%"></span><span class="rf-bar-n">${w.n}</span>`;
        return `<li>${data && w.n ? `<button type="button"${data} title="Show listings available ${w.from ? `${esc(shortDate(w.from))} to ${esc(shortDate(w.to))}` : esc(w.label.toLowerCase())}">${inner}</button>` : `<div>${inner}</div>`}</li>`;
      }).join('')}</ul>
      <div class="rf-meta">Over the listings your filters show. Medians need ${MEDIAN_MIN}+ priced listings. Click a week to filter to it.</div></div>`;
  }

  // Side-by-side comparison: one column per listing, best value per row highlighted.
  const compareRows = (cfg) => [
    ['Rent', (r) => r.price, (r) => r.priceNum, 'min'],
    ['Per bed', (r) => ppbLabel(r) || (Number.isFinite(r.ppb) ? `$${r.ppb}${+r.beds === 0 ? ' (studio)' : ''}` : ''), (r) => r.ppb, 'min'],
    ['Move-in', (r) => (Number.isFinite(r.upfront) ? money(r.upfront) : ''), (r) => r.upfront, 'min'],
    ['Available', (r) => r.available, (r) => (r.avail ? +r.avail : Infinity), 'min'],
    ['Size', (r) => sqmLabel(r).replace(' (from text)', ''), (r) => -(r.sqm || 0), 'min'],
    ['Per m²', (r) => (perSqm(r) != null ? `$${perSqm(r)}` : ''), (r) => perSqm(r) ?? Infinity, 'min'],
    ['Beds · baths · cars', (r) => [r.beds, r.baths, r.cars].map((v) => (v === '' ? '?' : v)).join(' · '), (r) => -(+r.beds || 0), 'min'],
    ['Distance', (r) => kmLabel(r).replace(' away', ''), (r) => r.km ?? Infinity, 'min'],
    ['Places', (r) => placesLabel(r), (r) => worstKm(r) ?? Infinity, 'min'],
    ['Vs my rent', (r) => vsNowLabel(r).replace(' vs now', ''), (r) => vsNow(r) ?? Infinity, 'min'],
    ['Of income', (r) => (incomePct(r, cfg.income) != null ? `${incomePct(r, cfg.income)}%` : ''), (r) => incomePct(r, cfg.income) ?? Infinity, 'min'],
    ['My rating', (r) => (r.rating ? `${'★'.repeat(r.rating)} ${r.rating}/5` : ''), (r) => -(r.rating || 0), 'min'],
    ['Next inspection', (r) => r.inspections?.[0]?.label || '', null],
    ['Amenities', (r) => amenityTags(r).join(', '), null],
    ['Heads-up', (r) => watchTags(r).join(', '), null],
    ['Ask', (r) => askMarked(r, cfg.amenities).join(' '), null],
    ['Agency', (r) => r.agency || '', null],
    ['Lease', (r) => leaseText(r.lease).replace(/^Lease /, ''), null],
    ['Your lease', (r) => fitLabel(r.fit), (r) => fitKey(r.fit), 'min'],
    ['Cash to move', (r) => (cashToMove(r) != null ? money(cashToMove(r)) : ''), (r) => cashToMove(r) ?? Infinity, 'min'],
    ['Apply via', (r) => r.applyVia || '', null],
    ['Applications close', (r) => applyByLabel(r.applyBy).replace(/^Apply by /, ''), null],
    ['Status', (r) => statusLabel(r.appStatus), null],
    ['Checklist', (r) => checkSummary(r, checklistItems(cfg.checklist)), (r) => -Object.values(r.checks || {}).filter((v) => v === 'y').length, 'min'],
    ['Note', (r) => r.note || '', null],
  ];
  // The ? help, one row per shortcut: [keys shown, what it does, e.key values the handler
  // matches]. A unit test checks each is handled and that the README lists it.
  const KEY_HELP = [
    ['j / ↓, k / ↑', 'next / previous listing', ['j', 'ArrowDown', 'k', 'ArrowUp']], ['s', 'shortlist', ['s']], ['h', 'hide', ['h']],
    ['n', 'note', ['n']], ['c', 'copy summary', ['c']], ['m', 'market view on/off', ['m']], ['v', 'map on/off', ['v']],
    ['x', 'tick for Compare (shortlist)', ['x']], ['1–5', 'application status (shortlisted)', ['1', '5']], ['Shift+1–5', 'your rating (Shortlist tab)', []],
    ['u', 'undo', ['u']], ['r', 'mark reviewed and move on (j also marks the one you leave)', ['r']], ['g / G, Home / End', 'first / last listing', ['g', 'G', 'Home', 'End']],
    ['PgUp / PgDn', '5 up / down', ['PageUp', 'PageDown']], ['t', 'Results / Shortlist', ['t']], ['o / Enter', 'open listing', ['o', 'Enter']],
    ['p / Space', 'large photo (j / k flip through)', ['p', ' ']], ['/', 'keyword filter (shortlist: search)', ['/']],
    ['e', 'expand / shrink the drawer', ['e']], ['f', 'back to the filters', ['f']], ['d', 'compact list on/off', ['d']], ['?', 'this help', ['?']],
    ['Esc', 'close', ['Escape']], ['Alt+Shift+F', 'open / close from anywhere on REA', []],
  ];
  // Plain links at the foot of the drawer and in the help panel; the script never fetches them (lint allows exactly these).
  const ABOUT_LINKS = [
    ['Source', 'https://github.com/cpwillis-pocs/rea-enhancement'], ['Terms', 'https://cpwillis.dev/terms'], ['Privacy', 'https://cpwillis.dev/privacy'],
  ];
  const aboutHtml = () => ABOUT_LINKS.map(([t, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(t)}</a>`).join(' · ');
  // `total`: listings on the list (to say when only some are compared); `picked`: ticked ones.
  function compareHtml(rows, cfg, { total = rows.length, picked = false } = {}) {
    const best = (score) => {
      const vals = rows.map(score).filter((v) => isFinite(v));
      const min = Math.min(...vals);
      // Only a "best" when it beats something: ties across every listing highlight nothing.
      return vals.length > 1 && vals.some((v) => v !== min) ? min : null;
    };
    const head = rows.map((r) => `<th scope="col"><a href="${esc(r.url)}" target="_blank" rel="noopener">${r.img ? `<img src="${esc(r.img)}" alt="">` : ''}<span>${esc(r.address)}</span></a></th>`).join('');
    const body = compareRows(cfg).filter(([label, show]) => (label !== 'Of income' || num(cfg.income) > 0) && (label !== 'Vs my rent' || num(cfg.rentNow) > 0) && (label !== 'Places' || parsePlaces(cfg.places).length) && (label !== 'Your lease' || !!leaseEndOf(cfg)) && (label !== 'Cash to move' || !!leaseEndOf(cfg) || num(cfg.moveCosts) > 0)
      && (['My rating', 'Status', 'Note'].includes(label) || rows.some((r) => show(r)))).map(([label, show, score]) => { // a row blank for all says nothing
      const b = score ? best(score) : null;
      return `<tr><th scope="row">${label}</th>${rows.map((r) => `<td${b != null && score(r) === b ? ' class="rf-best"' : ''}>${esc(show(r)) || '<span class="rf-na">–</span>'}</td>`).join('')}</tr>`;
    }).join('');
    return `<div class="rf-compare"><table><thead><tr><td></td>${head}</tr></thead><tbody>${body}</tbody></table></div>` +
      (total > rows.length ? `<div class="rf-empty">Comparing ${picked ? 'your selection' : `the first ${rows.length}`}; tick "Compare" on listings to choose.</div>` : '');
  }

  if (typeof window === 'undefined') {
    module.exports = {
      reaFiltersOf, reaChips, reaUrlFor, sameReaSearch,
      parseAvail, parsePrice, parseExchange, rowsFrom, extractResults, pageUrl, searchKey, isSearchPage, pageNum, toRow,
      fetchResults, fetchAllPages, sleep, planHtml, mapHtml, marketHtml, compareHtml, nextStop, PROBE_PATHS, classifyPage, backupSummary, mapLayout, trendPoint, trendText, evidenceOf, keywordEvidence, testCaseText, amenityTagItems, mergeCfg, backupCfg, WATCHOUTS, SNAP_ENTRY_BUDGET, pauseGate, sqmFromText, extractSqm, perSqm, PAUSE_MS, unpackJson, findListing, parseListingPage, discover, extractCoords, extractAgency, extractFeatures, extractMedia, listingId, dedupe, windowEnd, extractInspections, extractListed, toDate, applyFilters, filterRows, keywordTest, toTsv, toCsv, toIcs, printHtml, summaryText, inspectDays, parseFreeTimes, inspectFits, planDay, bestRoute, tzOf, textMatch, availFromText, needsAction, applyViaOf, applyByOf, leaseTermOf, leaseLabel, leaseCode, leaseFromCode, buildingKey, withBuildings, FILTER_KEYS, rowTests, without, leaseFit, fitLabel, checklistItems, checkSummary, parsePlaces, setDistances, worstKm, featSig, featDiff, enquiryText, HIDE_REASONS, agencyRecord, needsFollowUp, recordText, watchOf, watchTags, marketStats, searchLabel, incomePct, KEY_HELP, SETTINGS, settingsHtml, toolKeys, toolBytes, fmtBytes, encodeShare, decodeShare, shareUrl, shareFromHash, schemaWarnings, probe, esc, safeUrl, rowStore, marksStore, snapshotStore, presetStore, writeState, typeList, bigImg, shapeOf, amenityTags, resultsPath, healthStore, fillRates, APP_STATUSES, addressKey, DEFAULT_CFG, activeFilters, removedBy, withScores, cashToMove, vsNow, vsNowLabel, agencyDrops, negotiateFacts, inOrder, owedLabel, ecrToggle, ecrPrintHtml, askList, freeTimesText, byNext, sinceChanges, packPortals, applyReady, packState, packLabel, packToggle, movePlan, moveToggle, noticeBy, noticeDue, leaseEndOf, nextSteps, deadEnd, parseAnchor, haversineKm, AMENITIES, amenitiesOf, parseAmenCfg, amenCfgString, moveIn, withMedians, medianLabel, sanitizeCfg, itemsOf, sampleOf, cfgError, diffStats, ago, startOfDay, isFresh,
    };
    return;
  }

  // ------------------------------------------------------------------- ui
  // #endregion
  // #region ui state

  // Double-run guard: a second copy (an installed and a dev copy, or a fork) would draw a second
  // drawer and fight over storage. The first one to load wins; the flag is set before any await.
  if (window.__reaFilterLoaded || document.getElementById('rf-panel')) {
    console.warn(`[reaFilter] another copy (${window.__reaFilterLoaded || 'unknown version'}) is already running on this page, so this one stops. Disable one of them in Tampermonkey.`);
    return;
  }
  window.__reaFilterLoaded = (typeof GM_info !== 'undefined' && GM_info.script?.version) || 'dev';

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
  // A standalone document (all text escaped by its builder) in a window we open, then printed.
  function printDoc(html) {
    const w = window.open('', '_blank');
    if (!w) return setStatus('Pop-up blocked - allow pop-ups for realestate.com.au to print.', true);
    w.document.open(); w.document.write(html); w.document.close();
    // Chromium finishes a written document at close() and never fires its load: print once its
    // photos are in (or after 2 s), rather than waiting for a load that doesn't come.
    const imgs = [...w.document.images].filter((i) => !i.complete);
    let printed = false;
    const go = () => { if (printed) return; printed = true; try { w.focus(); w.print(); } catch { /* the window was closed */ } };
    if (!imgs.length) return setTimeout(go, 0);
    let left = imgs.length;
    const one = () => { if (--left === 0) { clearTimeout(t); go(); } };
    const t = setTimeout(go, 2000);
    for (const i of imgs) { i.addEventListener('load', one, { once: true }); i.addEventListener('error', one, { once: true }); }
  }

  // `reminders`: the whole-list export also carries follow-ups and your lease end (not one
  // listing's or one day's file).
  // `track`: the Shortlist's whole export remembers what it sent (uid and start, no addresses), so
  // the next one cancels what dropped out. Results exports aren't tracked: they're a different set.
  const ICS_SENT_KEY = `${TOOL_PREFIX}ics/v1`;
  const icsSent = () => keyStore(storageOr('localStorage'), ICS_SENT_KEY); // lazy: storageOr is defined further down
  function downloadIcs(rows, { reminders = false, track = false } = {}) {
    const sent = [];
    const ics = toIcs(rows, Date.now(), { alarm: num(cfg.icsAlarm) || 0, ...(reminders ? { leaseEnd: cfg.periodic ? (cfg.noticeGiven ? leaseEndOf(cfg) : '') : cfg.leaseEnd, noticeDays: cfg.periodic ? 0 : num(cfg.noticeDays) || 0, noticeGiven: cfg.noticeGiven, followUps: true, move: movePlan(marks.shortlist(), cfg) } : {}),
      ...(track ? { prev: icsSent().getJson() || [], sent } : {}) });
    if (!ics) return setStatus('No upcoming inspection times or follow-ups in these listings.', true);
    download(`rea-inspections-${stamp()}.ics`, ics, 'text/calendar;charset=utf-8');
    if (track) icsSent().setJson(sent);
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

  // #endregion
  // #region styles
  // Colours are tokens on #rf-panel so the dark scheme only swaps values. The Theme setting
  // (data-rf-theme on <html>) overrides the system choice either way.
  const RF_ROOTS = ':is(#rf-panel,#rf-launch,#rf-lbar,#rf-remind,#rf-toast)';
  const DARK_TOKENS = '--rf-bg:#1c1c20;--rf-fg:#ececf1;--rf-muted:#a0a0ab;--rf-soft:#8e8e99;--rf-line:#2e2e35;--rf-input:#6a6a75;'
    + '--rf-hover:#26262c;--rf-sec:#34343c;--rf-sec-hover:#3e3e47;--rf-accent-fg:#3ddc9a;--rf-err:#ff6b6b;--rf-tag:#33333b;--rf-up:#ff9f4a;--rf-star-fg:#f2c14e';
  const css = `
  #rf-panel,#rf-launch,#rf-lbar,#rf-remind,#rf-toast{--rf-bg:#fff;--rf-fg:#111;--rf-muted:#666;--rf-soft:#6e6e78;--rf-line:#e4e4e7;--rf-input:#8f8f98;
    --rf-hover:#f6f6f8;--rf-sec:#f1f1f4;--rf-sec-hover:#e6e6ea;--rf-accent:#087a50;--rf-accent-hover:#06663f;--rf-accent-fg:#087a50;
    --rf-err:#c00;--rf-tag:#eee;--rf-up:#b34700;--rf-star-fg:#8a6100}
  @media (prefers-color-scheme: dark){ :root:not([data-rf-theme=light]) ${RF_ROOTS}{${DARK_TOKENS}} }
  :root[data-rf-theme=dark] ${RF_ROOTS}{${DARK_TOKENS};color-scheme:dark} :root[data-rf-theme=light] ${RF_ROOTS}{color-scheme:light}
  #rf-launch .rf-launch-due{color:#fde68a}
  #rf-launch{position:fixed;right:20px;bottom:20px;z-index:2147483000;padding:11px 16px;border:0;border-radius:999px;
    background:var(--rf-accent);color:#fff;font:600 13px/1 system-ui,-apple-system,sans-serif;cursor:pointer;
    box-shadow:0 4px 16px rgba(0,0,0,.28)}
  #rf-launch:hover{background:var(--rf-accent-hover)}
  /* hidden always wins over our display rules */
  #rf-launch[hidden],#rf-panel[hidden],#rf-panel [hidden],#rf-lbar [hidden],#rf-remind[hidden]{display:none!important}
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
  /* Sticky offsets: defaults here, measured by syncSticky. The tabs' and status line's are plain pixels
     on them; the listings' scroll margin is one variable that only grows with the status line, so a
     status change doesn't re-style every listing (it's inherited by all of them). */
  #rf-panel:not(.rf-full)>.rf-tabs{position:sticky;top:51px;z-index:4;background:var(--rf-bg)}
  #rf-panel:not(.rf-full)>.rf-status{position:sticky;top:89px;z-index:3;background:var(--rf-bg)}
  #rf-panel:not(.rf-full) .rf-item{scroll-margin-top:var(--rf-item-top,133px)}
  /* Expanded: near full-screen. Filters become a left column and results a grid on the right. */
  @media (min-width:481px){ #rf-panel.rf-full{width:calc(100vw - 32px);max-width:1600px} }
  @media (min-width:760px){
    #rf-panel.rf-full{display:grid;grid-template-columns:minmax(340px,420px) minmax(0,1fr);
      grid-template-rows:auto auto auto auto auto auto auto auto minmax(0,1fr) auto;
      grid-template-areas:"head head" "tabs status" "ctrl news" "ctrl partial" "ctrl warn" "ctrl share" "ctrl help" "ctrl active" "ctrl list" "foot list"}
    .rf-full>.rf-head{grid-area:head} .rf-full>.rf-tabs{grid-area:tabs} .rf-full>.rf-sl-bar{grid-area:ctrl;align-self:stretch;align-content:flex-start} /* one of the two shows */
    .rf-full>.rf-controls{grid-area:ctrl;max-height:none;min-height:0;align-content:start;border-bottom:0;border-right:1px solid var(--rf-line)}
    .rf-full>.rf-help{grid-area:help} .rf-full>.rf-share-in,.rf-full>.rf-restore-in{grid-area:share} .rf-full>.rf-warnbar{grid-area:warn}
    .rf-full>.rf-status{grid-area:status;display:flex;align-items:center} .rf-full>.rf-partial{grid-area:partial} .rf-full>.rf-news{grid-area:news} .rf-full>.rf-active{grid-area:active} .rf-full>.rf-list{grid-area:list;min-height:0}
    .rf-full>.rf-tabs,.rf-full>.rf-sl-bar{border-right:1px solid var(--rf-line)}
    .rf-full>.rf-foot{grid-area:foot;border-right:1px solid var(--rf-line)}
    .rf-full .rf-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(400px,1fr));align-content:start;gap:4px 12px;padding:8px 12px}
    .rf-full .rf-list>:not(.rf-item){grid-column:1/-1}
  }
  .rf-head{padding:14px 16px;border-bottom:1px solid var(--rf-line);display:flex;align-items:center;gap:8px}
  .rf-head h2{margin:0;font-size:14px;font-weight:650;flex:1;color:var(--rf-fg);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap} /* gives way to the buttons on a narrow phone */
  #rf-panel :focus-visible,#rf-launch:focus-visible{outline:2px solid var(--rf-accent-fg);outline-offset:2px}
  .rf-btn[aria-disabled=true]{opacity:.6;cursor:progress}
  .rf-n{font-weight:400;color:var(--rf-soft)}
  /* Undo and the hide reasons are buttons, as in the note by the launcher (they were bare links). */
  .rf-undo{margin-left:8px;border:1px solid var(--rf-line);border-radius:6px;background:var(--rf-bg);padding:2px 8px;font:600 12px system-ui,sans-serif;color:var(--rf-accent-fg);cursor:pointer}
  .rf-clear,.rf-tofilters{border:0;background:none;font:600 12px system-ui,sans-serif;color:var(--rf-accent-fg);cursor:pointer;padding:2px 6px}
  .rf-keys,.rf-expand,.rf-themebtn{border:1px solid var(--rf-line);background:none;border-radius:999px;width:22px;height:22px;font:600 12px system-ui,sans-serif;
    color:var(--rf-muted);cursor:pointer;padding:0}
  .rf-help{padding:10px 16px;border-bottom:1px solid var(--rf-line);font-size:12px;background:var(--rf-hover)}
  .rf-help dl{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;margin:6px 0 0}
  .rf-help dt{font:600 11px ui-monospace,monospace;color:var(--rf-fg)}
  .rf-help dd{margin:0;color:var(--rf-muted)}
  .rf-about{margin:8px 0 0;color:var(--rf-muted)} .rf-about a{color:inherit;text-decoration:underline}
  .rf-foot{margin:0;padding:8px 16px 12px;font-size:12px;text-align:center}
  .rf-item:focus{outline:2px solid var(--rf-accent-fg);outline-offset:-2px;border-radius:8px}
  .rf-x{border:0;background:none;font-size:20px;line-height:1;cursor:pointer;color:var(--rf-muted);padding:0 4px}
  .rf-controls{padding:12px 16px;border-bottom:1px solid var(--rf-line);display:grid;grid-template-columns:minmax(0,1fr);gap:10px;overflow-x:hidden;max-height:60vh;overflow-y:auto}
  .rf-dates{display:grid;grid-template-columns:1fr 1fr .8fr;gap:10px}
  .rf-controls label{display:grid;gap:4px;font-size:11px;font-weight:600;text-transform:uppercase;
    letter-spacing:.04em;color:var(--rf-muted)}
  .rf-controls input:not([type=checkbox]),.rf-controls select,.rf-controls textarea{padding:7px 8px;border:1px solid var(--rf-input);border-radius:6px;
    font:inherit;font-size:13px;text-transform:none;letter-spacing:0;color:var(--rf-fg);background:var(--rf-bg);min-width:0;width:100%}
  .rf-grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:8px 10px;align-items:end} /* a label on two lines keeps the inputs level */
  .rf-more{display:grid;gap:10px}
  .rf-more:not([open]){display:block} /* a closed section leaves no gap */
  .rf-controls textarea{resize:vertical}
  .rf-controls .rf-row{flex-wrap:wrap} .rf-controls .rf-sort{flex:1;min-width:0} .rf-controls .rf-sort select{flex:1;min-width:11em}
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
  .rf-btn.sec{background:var(--rf-sec);color:var(--rf-fg);box-shadow:inset 0 0 0 1px var(--rf-line)}
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
  .rf-rea{display:flex;flex-wrap:wrap;align-items:center;gap:4px 6px;margin:0 0 8px;font-size:12px} .rf-rea .rf-label{margin-right:2px} .rf-rea-chips{display:contents}
  .rf-rea-chip{padding:1px 7px;border-radius:999px;border:1px solid var(--rf-line);color:var(--rf-fg)} .rf-rea-chip.rf-rea-narrow{border-color:var(--rf-up);color:var(--rf-up)}
  .rf-rea-apply{font-size:12px;padding:3px 10px}
  .rf-tag{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:4px;background:var(--rf-tag);
    color:var(--rf-muted);font-size:10px;font-weight:600;text-transform:uppercase;vertical-align:1px}
  .rf-tabs{display:flex;gap:4px;padding:6px 16px 0;border-bottom:1px solid var(--rf-line)}
  .rf-tabs button{border:0;background:none;padding:8px 10px;font:600 12px system-ui,sans-serif;color:var(--rf-muted);
    cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
  .rf-tabs button[aria-selected=true]{color:var(--rf-fg);border-bottom-color:var(--rf-accent)}
  .rf-sl-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 16px;border-bottom:1px solid var(--rf-line)}
  .rf-sl-ticks{flex-basis:100%} .rf-sl-ticks summary{cursor:pointer;font-size:12px;font-weight:600;color:var(--rf-accent-fg)} .rf-sl-ticks .rf-checks{margin:6px 0 0}
  .rf-item.rf-approved{box-shadow:inset 0 0 0 2px var(--rf-accent);border-radius:8px}
  .rf-sl-bar .rf-label{flex-basis:100%;order:-2} /* the bar's name, above its search */
  .rf-sl-unfold{flex:1 1 100%;order:-1;text-align:left} .rf-sl-bar.rf-folded>:not(.rf-label):not(.rf-sl-q):not(.rf-sl-unfold){display:none!important}
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
  .rf-acts-more>div{width:max-content;max-width:calc(100vw - 32px);position:absolute;right:0;top:calc(100% + 4px);z-index:3;display:grid;gap:4px;padding:6px;background:var(--rf-bg);
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
  @media (hover:hover){ .rf-compact .rf-acts{position:absolute;right:6px;bottom:4px;margin:0;padding:2px 4px;border-radius:6px;background:var(--rf-bg);box-shadow:0 1px 4px rgba(0,0,0,.18)}
    .rf-compact .rf-item:not(:hover):not(:focus-within) .rf-acts{visibility:hidden} } /* over the card, not below it: hovering a listing doesn't push the rest down */
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
  /* A view that's on (Market, Map, Compare): tinted and outlined, not the solid fill of the main action. */
  .rf-btn.sec[aria-pressed=true]{background:color-mix(in srgb,var(--rf-accent) 12%,var(--rf-bg));color:var(--rf-fg);box-shadow:inset 0 0 0 2px var(--rf-accent)}
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
  .rf-share-in,.rf-restore-in{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 16px;background:var(--rf-hover);border-bottom:1px solid var(--rf-line)}
  .rf-share-in .rf-btn,.rf-restore-in .rf-btn{flex:0 0 auto;padding:6px 11px;font-size:12px}
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
  .rf-warnbar{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start;padding:8px 16px;font-size:12px;color:var(--rf-err);background:var(--rf-hover);border-bottom:1px solid var(--rf-line)}
  .rf-warnbar .rf-warn-msg{flex:1}
  .rf-warn-x{border:0;background:none;color:inherit;font-size:16px;line-height:1;cursor:pointer;min-width:24px;min-height:24px}
  .rf-group,.rf-nudge{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:-2px 9px 8px 124px;font-size:12px}
  .rf-nudge{padding:6px 8px;border-radius:6px;background:var(--rf-hover)}
  .rf-checks{display:flex;flex-wrap:wrap;gap:4px;margin:6px 9px 0 124px}
  .rf-checks .rf-chip{font-size:11px;padding:2px 7px} .rf-checks{margin-bottom:6px;row-gap:6px}
  .rf-checks .rf-chip[data-state=no]{text-decoration:none;background:transparent;color:var(--rf-err);border-color:var(--rf-err)}
  .rf-weights{border:1px solid var(--rf-line);border-radius:8px;padding:6px 10px;margin:6px 0;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}
  .rf-tip{margin-left:4px;color:var(--rf-muted);font-weight:400;text-transform:none;cursor:help;border-radius:50%} .rf-tip:focus-visible{outline:2px solid var(--rf-accent)}
  .rf-weights legend{font-size:12px;color:var(--rf-muted);padding:0 4px}
  .rf-menu{position:relative}
  .rf-menu>summary{list-style:none;cursor:pointer}
  .rf-menu>summary::-webkit-details-marker{display:none}
  .rf-menu>summary::after{content:' ▾'}
  .rf-menu-list{position:absolute;right:0;top:calc(100% + 4px);z-index:5;display:grid;gap:4px;min-width:150px;padding:6px;
    background:var(--rf-bg);border:1px solid var(--rf-line);border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.18)}
  .rf-tags.rf-watch span{background:rgba(204,102,0,.16);color:var(--rf-fg)} .rf-tags.rf-watch span.rf-ok{background:none;color:var(--rf-muted);text-decoration:line-through} .rf-tags.rf-watch span.rf-bad{font-weight:700}
  .rf-storage{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
  /* Floating notes on REA's page: undo toast and saved-search reminder by the launcher, listing bar. */
  #rf-toast,#rf-remind,#rf-lbar{box-sizing:border-box;position:fixed;z-index:2147483000;display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:10px 12px;border-radius:10px;
    background:var(--rf-bg);color:var(--rf-fg);border:1px solid var(--rf-line);box-shadow:0 4px 18px rgba(0,0,0,.18);font:13px system-ui,sans-serif}
  #rf-toast{right:20px;bottom:72px;max-width:min(360px,calc(100vw - 32px))}
  #rf-toast button{font:600 12px system-ui,sans-serif;padding:4px 8px;border-radius:6px;border:1px solid var(--rf-line);background:var(--rf-bg);color:var(--rf-fg);cursor:pointer}
  #rf-remind{right:20px;bottom:72px;gap:8px;max-width:min(340px,calc(100vw - 32px))}
  .rf-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
  .rf-whytags{margin:0 9px 8px 124px}.rf-whytags ul{margin:0;padding-left:18px}.rf-whytags li{margin:2px 0}
  .rf-ask{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:6px 0;padding:8px 10px;border:1px solid var(--rf-line);border-radius:8px;background:var(--rf-sec)}
  .rf-ask>span{flex:1 1 100%}
  .rf-check+.rf-set-help{padding-left:20px}
  .rf-warnbar .rf-warn-msg{flex:1 1 60%;min-width:0}
  .rf-compare th[scope=row],.rf-market-t th[scope=row]{position:sticky;left:0;z-index:1;background:var(--rf-bg)} /* the label stays as the table scrolls sideways */
  @media (max-width:480px){ .rf-compare th[scope=row]{max-width:96px;white-space:normal} }
  .rf-more [data-forget]{color:var(--rf-err)}
  .rf-more .rf-sect{margin:10px 0 0;padding-top:8px;border-top:1px solid var(--rf-line);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--rf-fg)}
  .rf-more .rf-sect:first-of-type{border-top:0;padding-top:0}
  .rf-ck-more{margin:0 9px 6px 124px} .rf-ck-more>summary{cursor:pointer;font-size:12px;font-weight:600;color:var(--rf-accent-fg)}
  .rf-ck-more .rf-checks{margin-left:0}
  .rf-unfold{width:100%;text-align:left;margin-bottom:6px}
  .rf-controls.rf-folded>:not(.rf-unfold){display:none!important}
  .rf-controls.rf-folded{padding-bottom:6px}
  .rf-plan-head{position:relative;padding-right:34px!important} .rf-view-x{position:absolute;top:0;right:0;min-width:28px;min-height:28px;border:0;background:none;color:var(--rf-muted);font-size:18px;cursor:pointer}
  @media (pointer: coarse){ .rf-view-x{min-width:44px;min-height:44px} .rf-plan-head{padding-right:48px!important} }
  @media (pointer: coarse){ .rf-map .rf-dot{r:8px} .rf-map .rf-dot-star{r:9px} } /* big enough to tap */
  .rf-set-help{display:block;margin:2px 0 8px;font-size:12px;font-weight:400;color:var(--rf-muted);text-transform:none;letter-spacing:0}
  .rf-preset-name{flex:1 1 160px;min-width:0}
  .rf-lbar-edit{flex-basis:100%;min-height:54px;padding:6px 8px;font:inherit;color:var(--rf-fg);background:var(--rf-bg);border:1px solid var(--rf-line);border-radius:6px;resize:vertical}
  /* The minimise control is a small corner button, so it isn't read as a fifth action next to Hide. */
  #rf-lbar:not(.rf-lbar-min){padding-right:34px}
  #rf-lbar:not(.rf-lbar-min)>[data-l=min]{position:absolute;top:4px;right:4px;min-width:26px;min-height:26px;padding:0 6px;border:0;background:none;color:var(--rf-muted);font-size:16px;line-height:1}
  @media (pointer: coarse){ #rf-lbar:not(.rf-lbar-min){padding-right:52px} #rf-lbar:not(.rf-lbar-min)>[data-l=min]{min-width:44px;min-height:44px;top:0;right:0} }
  #rf-lbar .rf-lbar-due{flex-basis:100%;font-weight:700;color:var(--rf-err)}
  #rf-lbar .rf-lbar-lab{font-size:12px;color:var(--rf-muted);margin-right:6px}
  #rf-lbar .rf-lbar-ask .rf-lbar-checks button{text-align:left;white-space:normal} .rf-asks .rf-chip{text-align:left;white-space:normal}
  #rf-lbar [data-qa][data-state=yes],.rf-asks [data-state=yes]{border-color:var(--rf-accent);color:var(--rf-accent-fg)} #rf-lbar [data-qa][data-state=no],.rf-asks [data-state=no]{border-color:var(--rf-err);color:var(--rf-err)}
  #rf-lbar .rf-lbar-more summary::before{content:'▸ '} #rf-lbar .rf-lbar-more[open] summary::before{content:'▾ '}
  #rf-lbar .rf-lbar-more summary{list-style:none} #rf-lbar .rf-lbar-more summary::-webkit-details-marker{display:none}
  #rf-lbar{left:16px;bottom:16px;padding:8px;max-width:min(420px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto}
  #rf-lbar button,#rf-lbar select{font:600 13px system-ui,sans-serif;padding:6px 10px;border-radius:6px;border:1px solid var(--rf-line);background:var(--rf-sec);color:var(--rf-fg);cursor:pointer}
  #rf-lbar button[aria-pressed=true]{background:var(--rf-accent);border-color:var(--rf-accent);color:#fff}
  #rf-lbar button:focus-visible,#rf-lbar select:focus-visible{outline:2px solid var(--rf-accent);outline-offset:2px}
  .rf-lbar-more{flex:1 1 100%;font-size:12px} .rf-lbar-more summary{cursor:pointer;color:var(--rf-accent-fg);font-weight:600}
  .rf-lbar-checks{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px} #rf-lbar .rf-lbar-checks button{font-size:12px;padding:3px 8px}
  #rf-lbar .rf-lbar-checks button[data-state=yes]{border-color:var(--rf-accent);color:var(--rf-accent-fg)} #rf-lbar .rf-lbar-checks button[data-state=no]{border-color:var(--rf-err);color:var(--rf-err)}
  .rf-lbar-note,.rf-lbar-info{flex:1 1 100%;font-size:12px;color:var(--rf-muted);white-space:pre-wrap;overflow-wrap:anywhere}
  .rf-warn-t{color:var(--rf-err)}
  .rf-saved-list{list-style:none;margin:6px 0;padding:0;display:grid;gap:6px;font-size:13px}
  .rf-saved-list a{color:inherit;font-weight:600}
  .rf-saved-list .rf-pin{margin-left:6px;font-size:11px;padding:1px 8px}
  .rf-saved-list .rf-pin[aria-pressed=true]{background:var(--rf-accent);color:#fff;border-color:var(--rf-accent)}
  .rf-market{padding:8px 12px;font-size:12px;min-width:0}
  .rf-map svg{width:100%;height:auto;max-height:70vh;background:var(--rf-hover);border:1px solid var(--rf-line);border-radius:8px;margin:6px 0}
  .rf-dot{stroke:var(--rf-bg);stroke-width:1;cursor:pointer} .rf-dot:hover,.rf-dot:focus{stroke:var(--rf-fg);stroke-width:2;outline:none}
  .rf-dot-star{stroke:var(--rf-fg);stroke-width:1.5}
  .rf-dot-lo{fill:var(--rf-accent);color:var(--rf-accent)} .rf-dot-mid{fill:#6b7cb3;color:#6b7cb3} .rf-dot-hi{fill:var(--rf-up);color:var(--rf-up)} .rf-dot-na{fill:var(--rf-soft);color:var(--rf-soft)}
  .rf-map-sub{font-size:10px;fill:var(--rf-muted);paint-order:stroke;stroke:var(--rf-hover);stroke-width:3px} .rf-map-pin rect{fill:var(--rf-fg)} .rf-map-pin text,.rf-map-scale text{font-size:10px;fill:var(--rf-fg)}
  .rf-rate button{border:0;background:none;padding:0 1px;font-size:15px;line-height:1;color:var(--rf-star-fg);cursor:pointer} .rf-rate button[aria-pressed=true]{font-weight:700}
  #rf-lbar .rf-rate button{border:0;background:none;padding:2px;font-size:18px}
  .rf-map-far path{fill:var(--rf-fg)}
  .rf-map-scale line{stroke:var(--rf-fg);stroke-width:2}
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
  .rf-sl-q{font:13px system-ui,sans-serif;padding:7px 8px;border:1px solid var(--rf-input);border-radius:6px;background:var(--rf-bg);color:var(--rf-fg);flex:1 1 100%;min-width:0;order:-1} /* first and full width: the bar's other controls wrap under it */
  .rf-sl-filter{font:12px system-ui,sans-serif;padding:4px 6px;border:1px solid var(--rf-input);border-radius:6px;background:var(--rf-bg);color:var(--rf-fg)}
  .rf-empty{padding:28px 16px;text-align:center;color:var(--rf-soft)}
  [data-rf-id][data-rf-pos]{position:relative}
  [data-rf-id][data-rf-match="0"]{opacity:.35;transition:opacity .15s}
  /* Every control at least 24px to hit, with a mouse too (WCAG 2.2 target size). */
  #rf-panel summary,.rf-checks .rf-chip,.rf-rate button,.rf-lbar-checks button,.rf-acts button,.rf-acts-more summary{min-height:24px}
  .rf-checks .rf-chip,.rf-rate button,.rf-lbar-checks button{min-width:24px} .rf-rate button{display:inline-flex;align-items:center;justify-content:center}
  /* Fingers, not a mouse: every control at least 44px to hit (WCAG 2.2 target size), most of all
     on the listing bar and checklist used standing in an inspection. */
  @media (pointer: coarse){
    #rf-lbar button,#rf-lbar select,#rf-lbar .rf-lbar-more summary,.rf-checks .rf-chip,.rf-lbar-checks button,.rf-rate button,.rf-acts button,.rf-acts-more summary,.rf-chip{min-height:44px;min-width:44px}
    .rf-lbar-more summary{display:flex;align-items:center}
    /* Every control in the drawer (the a11y check measures them all on a touch phone). */
    #rf-panel button,#rf-panel select{min-height:44px} #rf-panel button{min-width:44px}
    #rf-panel summary{min-height:44px;box-sizing:border-box;padding-top:12px;padding-bottom:12px} /* stays a list item: keeps its ▸ marker */
  }
  @media (prefers-reduced-motion: reduce){ [data-rf-id][data-rf-match="0"],#rf-panel *,#rf-lbar *{transition:none!important;animation:none!important} }
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
  @media (pointer: coarse){ .rf-badge .rf-card-acts button{min-height:44px!important;min-width:44px!important;display:inline-flex!important;align-items:center!important;justify-content:center!important} }
  .rf-badge .rf-card-acts button[aria-pressed=true]{background:#e6a700!important}
  /* Windows High Contrast drops backgrounds: pressed chips and buttons use system colours instead. */
  @media (forced-colors: active){
    #rf-panel [aria-pressed=true],#rf-lbar [aria-pressed=true],.rf-badge [aria-pressed=true]{forced-color-adjust:none;background:Highlight!important;color:HighlightText!important;border:1px solid Highlight!important}
    #rf-panel :focus-visible,#rf-lbar :focus-visible,.rf-badge :focus-visible{outline:2px solid Highlight!important;outline-offset:1px}
    #rf-launch{border:1px solid ButtonText}
    .rf-bar{forced-color-adjust:none;background:Highlight!important} /* the market bars are drawn only with a background */
    /* Which tab is open, and shortlisted / approved listings: borders, since shadows aren't drawn here. */
    .rf-tabs button{border-bottom-color:Canvas!important} .rf-tabs button[aria-selected=true]{border-bottom-color:Highlight!important;color:Highlight!important}
    .rf-item.rf-starred{border-left:3px solid Highlight} .rf-item.rf-approved{outline:2px solid Highlight;outline-offset:-2px}
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
    .rf-acts,.rf-note,.rf-note-edit,.rf-app,.rf-group,.rf-nudge,.rf-checks,.rf-whytags,.rf-ck-more{margin-left:9px} .rf-note-edit{width:calc(100% - 18px)}
    .rf-weights{grid-template-columns:repeat(2,minmax(0,1fr))}
    .rf-card{grid-template-columns:88px 1fr} .rf-card img{width:88px;height:66px}
    .rf-controls .rf-sort{flex:1 1 100%} .rf-menu-list{left:0;right:auto}
    .rf-expand,.rf-resize{display:none} }
  /* Narrow but with a mouse: 32px. Touch screens keep the 44px set above (this used to win over it). */
  @media (max-width:480px) and (pointer: fine){ .rf-x,.rf-keys,.rf-themebtn,.rf-clear,.rf-acts button,.rf-acts-more summary{min-height:32px;min-width:32px} }
  @media (max-height:600px){ .rf-controls{max-height:38vh} } /* short windows / zoomed in: keep room for the list */
  .rf-btn{white-space:nowrap}
  `;

  const EMPTY_INTRO = 'Set your dates, then search.<br>Every result page is merged and sorted by availability.';
  // What scrolls the results: the list itself when expanded, else the whole drawer.
  // A listing (or a control inside it) found again after a re-render, by id.
  const attrSel = (attr, v) => `[${attr}="${CSS.escape(v)}"]`; // finds a control again after a redraw, to keep focus on it
  // Listings are the list's own children: a walk of those, not a selector over every node inside them.
  const itemEl = (id, inner = '') => {
    for (const el of ui.list.children) if (el.dataset.id === id && el.classList.contains('rf-item')) return inner ? el.querySelector(inner) : el;
    return null;
  };
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
    ui.launch.textContent = `Rental Toolkit${n == null ? '' : ` (${n})`}${star ? ` · ★${star}` : ''}`;
    // Shortlisted listings that need something from you (a deadline, a follow-up, did you inspect?)
    // and your own notice date: named on the launcher, so they're seen without opening the drawer.
    // Counted from startup's last task on (ui.countTodo): building the shortlist's rows in page
    // load's first task made it longer, and the restore that follows rebuilt most of them.
    const todo = !ui.countTodo ? 0 : (star ? marks.shortlist().filter((r) => needsAction(r) || needsFollowUp(r)).length : 0) + (noticeDue(cfg) ? 1 : 0);
    if (todo) ui.launch.append(' · ', Object.assign(document.createElement('span'), { className: 'rf-launch-due', textContent: `● ${todo} to do` }));
  };
  const currentKey = () => (isSearchPage(location.href) ? searchKey(location.href) : null);

  let cfg = { ...DEFAULT_CFG, ...loadCfg() };
  let cfgBase = { ...cfg }; // what this tab last loaded or saved, for mergeCfg
  let cache = null; // raw rows for the current search URL
  let cacheKey = null; // searchKey() of the cached rows
  let truncated = false;
  let runId = 0; // bumped on navigation so an in-flight run can't write stale rows
  let ui = null;

  const exchangeScript = () => [...document.scripts].find((sc) => /window\.ArgonautExchange\s*=/.test(sc.textContent));

  // The document we were loaded with already holds one page of results; after SPA
  // navigation it is stale, which the key/page match in fetchAllPages guards against.
  const boot = (() => {
    if (!isSearchPage(location.href)) return null;
    try {
      const key = searchKey(location.href), page = pageNum(location.href);
      if (window.ArgonautExchange) { try { return { key, page, results: parseExchange(window.ArgonautExchange) }; } catch { /* emptied by REA's app: the page's own script tag next */ } }
      const tag = exchangeScript();
      return tag ? { key, page, results: extractResults(tag.textContent + '</script>') } : null;
    } catch { return null; }
  })();

  const bootAt = Date.now();
  const store = rowStore(storageOr('sessionStorage'));
  const snaps = snapshotStore(storageOr('localStorage'));
  let gone = []; // rows from the baseline that are no longer listed (shown when cfg.showGone)
  let baseAt = null; // when the baseline ("last visit") was taken
  const pool = () => (cfg.showGone && gone.length ? cache.concat(gone) : cache);
  const marks = marksStore(storageOr('localStorage'));
  const health = healthStore(storageOr('localStorage'));
  const errorLog = []; // last few errors, for reaFilter.selfcheck()
  const logError = (msg) => { errorLog.push(`${new Date().toISOString()} ${String(msg).slice(0, 200)}`); if (errorLog.length > 10) errorLog.shift(); };
  // Errors in event handlers and observers (card badges, keys, the listing bar, other tabs)
  // otherwise only reach the console: log them for selfcheck(), and after ERROR_WARN_N in a
  // minute say so, with Copy report. The handler's error doesn't escape to REA's page.
  const ERROR_WARN_N = 3, ERROR_WARN_MS = 60000;
  const recentErrors = [];
  const noteError = (name, e) => {
    console.warn(`[reaFilter] ${name}:`, e);
    logError(`${name}: ${e?.message || e}`);
    const t = Date.now();
    recentErrors.push(t);
    while (recentErrors.length && t - recentErrors[0] > ERROR_WARN_MS) recentErrors.shift();
    if (recentErrors.length >= ERROR_WARN_N) setWarn('errors', `The script hit ${recentErrors.length} errors in the last minute (latest: ${name}). Copy report, then paste it into an issue on the script's GitHub page.`);
    clearTimeout(errorsQuiet); // a quiet minute takes the warning down (the log keeps them for the report)
    errorsQuiet = setTimeout(() => setWarn('errors', ''), ERROR_WARN_MS);
  };
  let errorsQuiet = 0;
  const guard = (name, fn) => function guarded(...args) { try { return fn.apply(this, args); } catch (e) { noteError(name, e); return undefined; } };
  const presets = presetStore(storageOr('localStorage'));
  let rawSample = sampleOf(boot?.results);
  let rawListingSample = null; // a property page's listing, for shape() there (it is shaped differently)

  // The drawer's markup. Only module constants go in, so it is built once and wired up by build().
  const panelHtml = () => `
    <div class="rf-resize" role="separator" aria-orientation="vertical" aria-label="Drawer width: drag, or use the left and right arrow keys" tabindex="0" aria-valuemin="${DRAWER_MIN}" aria-valuemax="${DRAWER_MAX}"></div>
    <div class="rf-head">
      <h2>Rental Toolkit</h2>
      <button type="button" class="rf-tofilters" hidden title="Back up to the filters (f)">↑ Filters</button>
      <button class="rf-clear" title="Reset all filters (your settings, places and times stay)">Reset</button>
      <button class="rf-themebtn" title="Dark mode" aria-label="Dark mode">☾︎</button>
      <button class="rf-expand" title="Expand to near full screen (e)" aria-label="Expand drawer" aria-pressed="false">⤢</button>
      <button class="rf-keys" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" aria-expanded="false" aria-controls="rf-help">?</button>
      <button class="rf-x" title="Close (Esc)" aria-label="Close">&times;</button>
    </div>
    <div class="rf-tabs" role="tablist">
      <button role="tab" id="rf-tab-results" data-view="results" aria-selected="true" aria-controls="rf-list">Results</button>
      <button role="tab" id="rf-tab-shortlist" data-view="shortlist" aria-selected="false" aria-controls="rf-list" tabindex="-1">Shortlist <span class="rf-count"></span></button>
    </div>
    <div class="rf-warnbar" role="alert" hidden><span class="rf-warn-msg"></span><button type="button" class="rf-btn sec rf-report" data-report hidden>Copy report</button><button type="button" class="rf-warn-x" aria-label="Dismiss warning">×</button></div>
    <div class="rf-restore-in" hidden role="region" aria-label="Restore a backup"><span class="rf-restore-msg"></span><button class="rf-btn" data-restore="yes">Restore</button><button class="rf-btn sec" data-restore="later" hidden>Not now</button><button class="rf-btn sec" data-restore="no">Cancel</button></div>
    <div class="rf-share-in" hidden role="region" aria-label="Shared listings">
      <span class="rf-share-msg"></span>
      <button class="rf-btn" data-share="add">Add to my shortlist</button>
      <button class="rf-btn sec" data-share="dismiss">Dismiss</button>
    </div>
    <div class="rf-news" hidden role="note"><span class="rf-news-msg"></span><button type="button" class="rf-warn-x" aria-label="Dismiss what's new">×</button></div>
    <div class="rf-sl-bar" hidden>
      <span class="rf-label">Shortlist, all searches</span>
      <select class="rf-sl-bulk" aria-label="Bulk action on the shortlist shown">
        <option value="">Bulk…</option>${APP_STATUSES.filter(Boolean).map((v) => `<option value="status:${v}" data-label="Mark {n} shown: ${v}">Mark shown: ${v}</option>`).join('')}
        <option value="unstar-declined" data-label="Remove declined">Remove declined</option><option value="unstar" data-label="Remove all {n} shown">Remove all shown</option>
      </select>
      <select class="rf-plan" aria-label="Plan an inspection day"></select>
      <input type="search" class="rf-sl-q" placeholder="Search shortlist" aria-label="Search the shortlist by address, note, agency or suburb">
      <button type="button" class="rf-btn sec rf-sl-unfold" hidden aria-expanded="true"></button>
      <select class="rf-sl-filter" aria-label="Filter shortlist by application status">
        <option value="">Any status</option>${APP_STATUSES.filter(Boolean).map((v) => `<option value="${v}">${statusLabel(v)}</option>`).join('')}
        <option value="-">Not started</option><option value="!">Needs action</option><option value="~">Changed since last visit</option>
      </select>
      <select class="rf-sl-filter" id="rf-slSort" aria-label="Order of the shortlist"><option value="">What's next</option><option value="added">Date added</option></select>
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
      <div class="rf-sl-ticks" hidden></div>
      <input type="file" accept="application/json,.json" hidden>
    </div>
    <div class="rf-controls">
      <button type="button" class="rf-btn sec rf-unfold" aria-expanded="false" hidden></button>
      <div class="rf-rea" hidden><span class="rf-label">On REA's search</span><span class="rf-rea-chips"></span>
        <button type="button" class="rf-btn sec rf-rea-apply" hidden title="Opens REA's search with your rent, rooms, type, dates, surrounding-suburb and taken filters, so REA has fewer pages to read">Use my filters on REA</button></div>
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
        <h3 class="rf-sect">Rent &amp; size</h3>
        <div class="rf-grid3">
          <label>Min $/wk<input type="number" min="0" step="25" id="rf-priceMin" inputmode="numeric"></label>
          <label>Max $/wk<input type="number" min="0" step="25" id="rf-priceMax" inputmode="numeric"></label>
          <label title="Bond + 2 weeks' rent">Max move-in $<input type="number" min="0" step="100" id="rf-upfrontMax" inputmode="numeric"></label>
          <label title="Move-in plus any rent you'd pay twice while your current lease overlaps (set its end in Settings)">Max cash to move $<input type="number" min="0" step="100" id="rf-cashMax" inputmode="numeric"></label>
          <label>Min beds<input type="number" min="0" max="9" id="rf-bedsMin" inputmode="numeric"></label>
          <label>Min baths<input type="number" min="0" max="9" id="rf-bathsMin" inputmode="numeric"></label>
          <label>Min cars<input type="number" min="0" max="9" id="rf-carsMin" inputmode="numeric"></label>
          <label title="${esc(SQM_NOTE)}"><span>Min m²<span class="rf-tip" tabindex="0" role="note" aria-label="${esc(SQM_NOTE)}">ⓘ</span></span><input type="number" min="0" max="2000" step="5" id="rf-sizeMin" inputmode="numeric" aria-label="Min m²"></label>
        </div>
        <h3 class="rf-sect">Type &amp; features</h3>
        <div class="rf-amen rf-types" role="group" aria-label="Property type: pick any number (none picked means any)">
          <span class="rf-label">Type</span><input type="hidden" id="rf-type"><span class="rf-types-list"><span class="rf-meta">Search to see the types</span></span>
        </div>
        <div class="rf-amen rf-amen-req" role="group" aria-label="Amenities: click to require, again to exclude, again to clear">
          <input type="hidden" id="rf-amenities"><span class="rf-label">Features</span><small class="rf-set-help">Tap once to require, again to exclude, again to clear.</small>
          ${AMENITIES.map((a) => `<button type="button" class="rf-chip" data-amen="${a.id}">${a.label}</button>`).join('')}
        </div>
        <label>Keywords<input type="text" id="rf-keyword" placeholder='eg pool|balcony -studio "north facing"' title="All words must appear; -word must not; a|b means either; accents don't matter"></label>
        <div class="rf-amen rf-nowatch" role="group" aria-label="Hide listings whose text mentions">
          <span class="rf-label">Hide if mentioned</span><input type="hidden" id="rf-noWatch">
          ${WATCHOUTS.map((w) => `<button type="button" class="rf-chip" data-nowatch="${w.id}" aria-pressed="false">${w.label}</button>`).join('')}
        </div>
        <h3 class="rf-sect">Location</h3>
        <div class="rf-dist">
          <label>Distance from<input type="text" id="rf-anchor" placeholder="-33.87, 151.21 or a Google Maps link" autocomplete="off"></label>
          <label>Max km<input type="number" min="0" step="1" id="rf-maxKm" inputmode="decimal"></label>
        </div>
        <label>Other places (optional, one per line)<textarea id="rf-places" rows="2" placeholder="Work: -33.87, 151.21&#10;Uni: Google Maps link"
          title="Up to ${PLACES_MAX}. Straight-line km to each shows on listings; sort by 'Nearest to all places'."></textarea></label>
        <div class="rf-meta rf-places-fb" aria-live="polite"></div>
        <label class="rf-check" title="Several units in one building: keep the cheapest"><input type="checkbox" id="rf-onePerBuilding">One listing per building</label>
        <input type="hidden" id="rf-building"><input type="hidden" id="rf-packDone"><input type="hidden" id="rf-moveDone"><input type="hidden" id="rf-ecrDone"><input type="hidden" id="rf-slSeenAt">
        <h3 class="rf-sect">Lease &amp; inspections</h3>
        <div class="rf-grid3">
          <label>Lease at least<select id="rf-leaseMin"><option value="">Any</option><option value="6">6 months</option><option value="12">12 months</option><option value="24">24 months</option></select></label>
        </div>
        <label>Inspection on<input type="date" id="rf-inspectOn"></label>
        <label title="Keeps listings with at least one upcoming inspection you can get to, in the listing's local time">Inspections I can make<select id="rf-inspectWhen">
          <option value="">Any time</option><option value="weekend">Weekends</option><option value="evening">After 5pm</option><option value="either">Weekends or after 5pm</option><option value="mine">At my times…</option></select></label>
        <label title="Days and times you can get to an inspection, in the listing's local time. Used by Inspections I can make: At my times">My inspection times<input type="text" id="rf-inspectFree" placeholder="eg Sat 9-13, Sun, weekdays 17:30-" spellcheck="false"></label>
        <h3 class="rf-sect">Show only</h3>
        <label class="rf-check"><input type="checkbox" id="rf-onlyStarred">Shortlisted only <span class="rf-n" data-count="starred"></span></label>
        <label class="rf-check"><input type="checkbox" id="rf-newOnly">New since last visit only</label>
        <label class="rf-check"><input type="checkbox" id="rf-changedOnly">Price, date or details changed recently</label>
        <label class="rf-check"><input type="checkbox" id="rf-unopenedOnly">Not opened yet</label>
        <label class="rf-check" title="Listings you haven't gone past with j, marked with r, shortlisted, hidden or noted"><input type="checkbox" id="rf-unreviewedOnly">Not reviewed yet</label>
        <label class="rf-check" title="Listed over 3 weeks ago: rent may be negotiable"><input type="checkbox" id="rf-staleOnly">Only listed 3+ weeks ago (may negotiate)</label>
        <label class="rf-check"><input type="checkbox" id="rf-hideNoImage">Has a photo</label>
        <label class="rf-check"><input type="checkbox" id="rf-floorplanOnly">Has a floorplan</label>
        <h3 class="rf-sect">Also show or hide</h3>
        <label class="rf-check" title="Deposit taken, under application or leased, going by the headline and description"><input type="checkbox" id="rf-hideTaken">Hide listings already taken</label>
        <label class="rf-check"><input type="checkbox" id="rf-showHidden">Show hidden listings <span class="rf-n" data-count="hidden"></span></label>
        <label class="rf-check"><input type="checkbox" id="rf-showGone">Show listings no longer listed</label>
        <div class="rf-agencies" hidden><span class="rf-label">Hidden agencies / suburbs</span><span class="rf-ag-list"></span></div>
      </details>
      <details class="rf-more rf-settings">
        <summary>Settings</summary>
        ${settingsHtml({ storage: `<div class="rf-meta rf-storage"><span class="rf-storage-n"></span>
          <button type="button" class="rf-btn sec" data-backup-here>Backup</button><button type="button" class="rf-btn sec" data-restore-here>Restore</button>
          <button type="button" class="rf-btn sec" data-report title="Diagnostics for a bug report: fields found, recent errors and one listing's structure (no listing text, names or addresses)">Copy report</button>
          <button type="button" class="rf-btn sec" data-forget title="Remove everything this script stored in this browser (not REA's own data)">Delete all my data</button></div>` })}
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
          <option value="ppsqm" title="${esc(SQM_NOTE)}">Price per m²</option>
          <option value="beds">Most beds</option>
          <option value="inspect">Next inspection</option>
          <option value="listed">Newest first</option>
          <option value="value">Best value vs median</option>
          <option value="distance">Nearest</option>
          <option value="allnear">Nearest to all places</option>
          <option value="fit">Least overlap with my lease</option>
          <option value="cash" title="Move-in cost plus any rent paid twice while your lease overlaps">Least cash to move</option>
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
        <button class="rf-btn sec rf-map-btn" aria-pressed="false" disabled title="The listings shown on a simple map, coloured by rent vs the median (v)">Map</button>
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
      <dl>${KEY_HELP.map(([k, what]) => `<dt>${esc(k)}</dt><dd>${esc(what)}</dd>`).join('')}</dl>
      <p class="rf-about">rea-enhancement: ${aboutHtml()}. Provided as is, without warranty or support; how you use it is up to you.</p>
    </div>
    <div class="rf-peek" hidden role="dialog" aria-label="Photo"><img alt=""><div class="rf-peek-cap"></div></div>
    <div class="rf-status" role="status" aria-live="polite"></div>
    <div class="rf-partial" hidden><span class="rf-partial-msg"></span> <button type="button" class="rf-btn sec" data-resume>Resume</button></div>
    <div class="rf-active" hidden aria-label="Active filters"></div>
    <div class="rf-list" id="rf-list" role="tabpanel" aria-labelledby="rf-tab-results"><div class="rf-empty">${EMPTY_INTRO}</div></div>
    <p class="rf-about rf-foot">${aboutHtml()}</p>`;

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
  window.addEventListener('resize', () => { if (!panel.hidden) ui.applyWidth(); }); // opening sizes it (setOpen)
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

  // Safety copy: localStorage is shared with REA's own code, and whatever clears it takes the
  // shortlist with it. What a backup would hold (your choices, presets, settings) is mirrored into
  // IndexedDB a moment after each change; if this browser's marks come back empty and a copy
  // exists, the drawer offers to restore it (same preview and undo as a backup file).
  const MIRROR_DB = `${TOOL_PREFIX}mirror`, MIRROR_DELAY_MS = 2000;
  const idbOpen = () => new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(MIRROR_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => { req.result.onversionchange = () => req.result.close(); resolve(req.result); }; // don't block a delete from another tab
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('blocked'));
    } catch (e) { reject(e); }
  });
  const idbDo = async (mode, fn) => {
    const db = await idbOpen();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('kv', mode), req = fn(tx.objectStore('kv'));
        tx.oncomplete = () => resolve(req?.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('aborted')); // a quota error at commit aborts, it doesn't error
      });
    } finally { db.close(); }
  };
  // What the copy holds that this browser doesn't (listings, hidden agencies and suburbs). Every
  // change here is copied within seconds, so anything missing went without this script.
  const mirrorLost = (copy, here) => ['m', 'ag', 'sb'].reduce((n, f) => n + (isObj(copy?.[f]) ? Object.keys(copy[f]).filter((k) => !Object.hasOwn(here[f] || {}, k)).length : 0), 0);
  const mirrorWeight = (d) => ['m', 'ag', 'sb'].reduce((n, f) => n + (isObj(d?.[f]) ? Object.keys(d[f]).length : 0), 0);
  // Held (no writes) until startup has compared the copy with what's here, and while an offer to
  // restore it is unanswered: otherwise the first star after a wipe replaces the copy with one listing.
  let mirrorTimer = 0, mirrorHeld = true;
  const mirrorWrite = () => {
    clearTimeout(mirrorTimer); mirrorTimer = 0;
    if (marks.takeWiped()) { mirrorHeld = true; offerMirror(); } // storage emptied mid-visit
    if (mirrorHeld) return;
    const data = marks.exportData(); // empty too: you emptied it here, so it isn't offered back as "gone"
    data.presets = presets.exportData();
    data.cfg = backupCfg(cfg);
    idbDo('readwrite', (st) => st.put({ at: Date.now(), data }, 'copy')).catch(() => { /* private window, blocked */ });
  };
  const mirrorSoon = () => { clearTimeout(mirrorTimer); mirrorTimer = setTimeout(mirrorWrite, MIRROR_DELAY_MS); };
  // Leaving the tab: write now, so a change just made isn't later mistaken for a loss.
  document.addEventListener('visibilitychange', () => { if (document.hidden && mirrorTimer) mirrorWrite(); });
  // A failed read isn't "no copy": stay held and try again a little later.
  let mirrorRetries = 0;
  const offerMirror = async () => {
    let failed = false;
    const rec = await idbDo('readonly', (st) => st.get('copy')).catch(() => { failed = true; return null; });
    if (failed) { mirrorHeld = true; if (mirrorRetries++ < 3) setTimeout(offerMirror, 30000); return; }
    const here = marks.exportData(), lost = mirrorLost(rec?.data, here);
    // Marks you changed since the copy was (a change just made, then a reload before the copy caught
    // up) mean the difference is yours, not a loss. Only an emptied or older store is offered it.
    // (A store made after the copy, ie storage cleared and then a new star, is still a loss.)
    const ownChange = marks.createdAt() && marks.createdAt() < (rec?.at || 0) && marks.writtenAt() > (rec?.at || 0);
    if (!lost || ownChange) { if (mirrorHeld) releaseMirror(rec); return; }
    mirrorHeld = true;
    if (!isSearchPage(location.href) || !ui.offerRestore) return; // the offer lives in the drawer: the next search page asks
    ui.offerRestore(rec.data, `${mirrorWeight(here) ? 'Some of your shortlist in this browser has' : 'Your shortlist in this browser has'} gone (its storage was cleared). A safety copy from ${ago(Date.now() - rec.at)} has`);
    ui.restoreFromMirror = true; // Discard then drops the copy, so emptying the shortlist on purpose isn't asked about again
    // Say what the second button does: it throws the copy away for good. Not now just waits.
    const restoreIn = ui.panel.querySelector('.rf-restore-in');
    restoreIn.querySelector('[data-restore=no]').textContent = 'Discard copy';
    restoreIn.querySelector('[data-restore=later]').hidden = false;
  };
  // The copy already holds what's here (nothing chosen since it, the same presets and settings):
  // not written again on every page view.
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const releaseMirror = (rec = null) => {
    mirrorHeld = false;
    if (rec && marks.writtenAt() <= rec.at && same(rec.data?.presets, presets.exportData()) && same(rec.data?.cfg, backupCfg(cfg))) { clearTimeout(mirrorTimer); mirrorTimer = 0; return; }
    mirrorSoon();
  };
  const dropMirror = () => idbDo('readwrite', (st) => st.delete('copy')).catch(() => {});


  // The presets menu: apply, delete, and save under a name typed next to it.
  function wirePresets() {
  // The name is typed in a field next to the menu (themed and labelled, unlike a prompt):
  // Enter saves, Esc cancels, leaving it saves what's typed; focus goes back to the menu.
  const askPresetName = (key) => {
    ui.preset.parentElement.querySelector('.rf-preset-name')?.remove();
    const input = Object.assign(document.createElement('input'), { type: 'text', className: 'rf-preset-name', maxLength: 40,
      placeholder: key ? 'Name (applies on this search); Enter saves' : 'Preset name; Enter saves' });
    input.setAttribute('aria-label', key ? 'Preset name (auto-applies on this search)' : 'Preset name');
    ui.preset.after(input);
    input.focus();
    let done = false;
    // `refocus`: Enter / Esc return to the menu; leaving by click or Tab keeps focus where it went
    // (pulling it back to the menu let one typed letter pick "Delete: …").
    const finish = (save, refocus) => {
      if (done) return;
      done = true;
      const saved = save && input.value.trim() && presets.save(input.value, cfg, key);
      if (saved && key) visitKey.set(key); // it's applied already: a reload here keeps your later edits
      input.remove();
      if (saved) setStatus(`Saved preset "${saved}"${key ? ' for this search' : ''}.`);
      fillPresets();
      if (refocus) ui.preset.focus();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // typing a name isn't a shortcut, and Esc doesn't close the drawer
      if (e.key === 'Enter') { e.preventDefault(); finish(true, true); } else if (e.key === 'Escape') finish(false, true);
    });
    input.addEventListener('blur', () => finish(true, false));
  };
  onPick(ui.preset, async () => {
    const v = ui.preset.value;
    ui.preset.value = '';
    if (v === 'c:save' || v === 'c:bind') return askPresetName(v === 'c:bind' ? currentKey() : null);
    else if (v.startsWith('d:')) {
      const name = v.slice(2);
      if (!await askInline(ui.status, `Delete the preset "${name}"?`, 'Delete', 'Keep it', { safe: true })) return;
      presets.remove(name);
      setStatus(`Deleted preset "${name}".`);
    } else if (v.startsWith('a:')) applyPreset(presets.get(v.slice(2)));
    fillPresets();
  });
  }
  // #endregion
  // #region shortlist bar
  // An action menu (a select that acts, then resets): only a chosen item acts. Arrow keys and
  // type-ahead on a closed select change it, and fire change, as you move through it (Windows,
  // Linux): those wait for Enter. A mouse or touch pick acts at once; Esc, Tab or leaving cancels.
  // Opening the drawer with nowhere saved to go back to: Search, or (folded on a phone, or on the
  // Shortlist where Search is hidden) the first of these that can be seen.
  function focusOnOpen() {
    const p = ui.panel, sl = ui.view === 'shortlist';
    const to = [sl ? ui.slQuery : ui.run, p.querySelector('.rf-unfold:not([hidden])'), p.querySelector('.rf-sl-unfold:not([hidden])'), ui.list.querySelector('.rf-item'), p.querySelector('.rf-x')]
      .find((el) => el && el.checkVisibility?.() !== false && el.offsetParent !== null);
    (to || p).focus({ preventScroll: true });
  }
  function onPick(sel, fn) {
    let browsing = false;
    sel.addEventListener('pointerdown', () => { browsing = false; });
    sel.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && browsing) { e.preventDefault(); browsing = false; if (sel.value) fn(); return; }
      if (e.key === 'Escape' && (browsing || sel.value)) e.stopPropagation(); // leaves the menu, not the drawer
      if (e.key === 'Escape' || e.key === 'Tab') { browsing = false; if (sel.value) sel.value = ''; return; }
      if (/^(?:Arrow(?:Up|Down)|Home|End|Page(?:Up|Down))$/.test(e.key) || (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey)) browsing = true;
    });
    sel.addEventListener('change', () => {
      if (!browsing) return fn();
      if (sel.value) setStatus(`Press Enter for "${sel.selectedOptions[0]?.textContent || ''}", or Esc to leave it.`);
    });
    sel.addEventListener('blur', () => { if (browsing) { browsing = false; sel.value = ''; } });
  }
  // A question asked in the drawer (not a browser dialog, which is clumsy on touch and screen
  // readers): the message and two buttons after `before`'s place; Enter / the first button says
  // yes, Esc or the second says no, and focus returns where it was. `safe`: focus starts on no.
  function askInline(anchor, message, yes, no, { safe = false } = {}) {
    document.querySelector('.rf-ask')?._cancel?.(); // a new question calls off an open one (it resolves null: do nothing)
    const back = document.activeElement;
    const box = Object.assign(document.createElement('div'), { className: 'rf-ask' });
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', message);
    box.innerHTML = `<span>${esc(message)}</span> <button type="button" class="rf-btn${safe ? ' sec' : ''}" data-ask="yes">${esc(yes)}</button> <button type="button" class="rf-btn${safe ? '' : ' sec'}" data-ask="no">${esc(no)}</button>`;
    anchor.before(box);
    return new Promise((resolve) => {
      // Focus goes back where it was, or to its menu's toggle when a closed menu has hidden it.
      const done = (v, refocus = true) => {
        box.remove();
        const to = back?.isConnected && back.checkVisibility?.() === false ? back.closest('details')?.querySelector('summary') || back : back;
        if (refocus && to?.isConnected) to.focus();
        resolve(v);
      };
      box._cancel = () => done(null, false);
      box.addEventListener('click', (e) => { const b = e.target.closest('[data-ask]'); if (b) done(b.dataset.ask === 'yes'); });
      box.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } }); // Esc calls the whole thing off
      box.querySelector(`[data-ask=${safe ? 'no' : 'yes'}]`).focus();
    });
  }
  // Shortlist bar: Backup, Restore (preview, then undo), Share, Re-check, Print and the More menu,
  // plus the incoming-share offer. Needs the drawer pieces build() made.
  function wireShortlistBar(panel) {
  ui.slBar.querySelector('[data-sl=backup]').addEventListener('click', () => {
    const data = marks.exportData();
    data.presets = presets.exportData();
    if (cfg.remember) data.snapshots = snaps.exportData();
    data.cfg = backupCfg(cfg);
    download(`rea-backup-${stamp()}.json`, JSON.stringify(data), 'application/json');
    backupAt.set(String(Date.now()));
    setWarn('backup', '');
    ui.paintStorage?.();
  });
  ui.slBar.querySelector('[data-sl=restore]').addEventListener('click', () => ui.slFile.click());
  ui.slBar.querySelector('[data-sl=share]').addEventListener('click', async () => {
    const rows = shortlistRows();
    if (!rows.length) return setStatus('Nothing on the shortlist to share.', true);
    const has = [rows.some((r) => r.note) && 'notes', rows.some((r) => r.appStatus || r.rating) && 'statuses and ratings'].filter(Boolean);
    const notes = has.length > 0 && await askInline(ui.status, `Include your ${has.join(' and ')} in the share link (eg for a partner)?`, 'Include them', 'Just the listings');
    if (notes === null) return setStatus('Share link not copied.');
    const url = shareUrl(rows, { notes });
    const ok = await copyText(url);
    setStatus(ok ? `Share link copied (${Math.min(rows.length, SHARE_MAX)} listings${notes ? `, with your ${has.join(' and ')}` : ''}). Anyone with this script can open it.`
      : 'Clipboard blocked - could not copy the share link.', !ok);
  });
  // Incoming share (#rf-share=...): offer to import, then strip it from the URL.
  const shareIn = panel.querySelector('.rf-share-in');
  ui.offerShare = (rows) => {
    if (!rows?.length) return;
    shareIn.hidden = false;
    shareIn.querySelector('.rf-share-msg').textContent = `${plural(rows.length, 'shared listing')}:`;
    ui.pendingShare = rows;
    ui.launch.hidden = false;
    ui.setOpen(true);
  };
  shareIn.addEventListener('click', (e) => {
    const b = e.target.closest('[data-share]');
    if (!b) return;
    const rows = ui.pendingShare || [];
    if (b.dataset.share === 'add') {
      const n = marks.setMany(rows, 's', true);
      // Their status fills in where you have none (an application you're making together); their
      // rating is theirs, so it goes in the note beside theirs rather than over yours.
      const mine = new Map(marks.shortlist().map((x) => [x.id, x]));
      for (const r of rows) {
        const theirs = [r.note, r.rating ? `rated ${r.rating}/5` : ''].filter(Boolean).join(' · ');
        if (theirs && !marks.note(r.id)) marks.setNote(r.id, `Shared: ${theirs}`);
        if (r.status && !mine.get(r.id)?.appStatus) marks.setStatus(r.id, r.status);
      }
      refreshMarks();
      setView('shortlist');
      setStatus(`Added ${plural(n, 'shared listing')} to your shortlist.`);
    }
    shareIn.hidden = true;
    ui.pendingShare = null;
  });
  ui.planIcs = (btn) => {
    if (!ui.planDay) return;
    const day = ui.planDay;
    let rows = shortlistRows().map((r) => ({ ...r, inspections: (r.inspections || []).filter((i) => typeof i.at === 'number' && ymdIn(i.at, tzOf(r)) === day),
      inspectCancelledAt: typeof r.inspectCancelledAt === 'number' && ymdIn(r.inspectCancelledAt, tzOf(r)) === day ? r.inspectCancelledAt : null })); // this day's cancellations only
    if (btn.dataset.planIcs === 'route') { // just the suggested sessions
      const picked = [...bestRoute(planDay(rows, day, { free: parseFreeTimes(cfg.inspectFree) })).picked];
      rows = rows.map((r) => ({ ...r, inspections: r.inspections.filter((i) => picked.some((x) => x.r.id === r.id && x.at === i.at)) })).filter((r) => r.inspections.length);
    }
    downloadIcs(rows);
  };
  // The More menu closes once an item is chosen (or on a click elsewhere).
  const slMenu = ui.slBar.querySelector('.rf-menu');
  slMenu.addEventListener('click', (e) => { if (e.target.closest('.rf-menu-list button')) slMenu.open = false; });
  document.addEventListener('click', (e) => { if (slMenu.open && !slMenu.contains(e.target)) slMenu.open = false; });
  ui.slBar.querySelector('[data-sl=recheck]').addEventListener('click', (e) => recheckShortlist(e.currentTarget));
  const storageLine = panel.querySelector('.rf-storage-n');
  const paintStorage = () => {
    const ls = storageOr('localStorage'), ss = storageOr('sessionStorage');
    const c = marks.counts(), n = Object.keys(snaps.exportData()).length;
    const per = snaps.sizes().map((x) => `${searchLabel(x.key)} ${fmtBytes(x.bytes)}${x.lite ? ' (text trimmed to fit)' : ''}`);
    const last = +backupAt.get() || 0;
    storageLine.textContent = `Last backup: ${last ? ago(Date.now() - last) : 'never'}. Stored in this browser only: ${fmtBytes(toolBytes(ls) + toolBytes(ss))} (${c.starred} shortlisted, ${c.hidden} hidden, ${plural(n, 'remembered search', 'es')}).`
      + (per.length ? ` Remembered: ${per.join(' · ')}.` : '');
  };
  ui.paintStorage = () => { if (panel.querySelector('.rf-settings').open) paintStorage(); };
  // The same Backup and Restore as the Shortlist's More menu, beside "Last backup".
  panel.querySelector('[data-backup-here]').addEventListener('click', () => ui.slBar.querySelector('[data-sl=backup]').click());
  panel.querySelector('[data-restore-here]').addEventListener('click', () => ui.slFile.click());
  panel.querySelector('.rf-settings').addEventListener('toggle', (e) => { if (e.currentTarget.open) paintStorage(); });
  panel.querySelector('[data-forget]').addEventListener('click', async (e) => {
    if (!await askInline(e.currentTarget.parentElement, 'Delete your shortlist, notes, hidden listings, presets, remembered searches and settings from this browser? Download a Backup first if you might want them back.',
      'Delete everything', 'Cancel', { safe: true })) return;
    ui.forgetting = true; clearTimeout(placeTimer); // nothing is written back before the reload
    for (const st of [storageOr('localStorage'), storageOr('sessionStorage')]) for (const k of toolKeys(st)) { try { st.removeItem(k); } catch { /* blocked */ } }
    clearTimeout(mirrorTimer); mirrorTimer = 0; mirrorHeld = true;
    try { indexedDB.deleteDatabase(MIRROR_DB); } catch { /* blocked */ }
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
    ui.saved.querySelector(attrSel('data-saved-pin', b.dataset.savedPin))?.focus();
    setStatus(on ? `Pinned ${searchLabel(b.dataset.savedPin)}.` : `Unpinned ${searchLabel(b.dataset.savedPin)}.`);
  });
  ui.slBar.querySelector('[data-sl=print]').addEventListener('click', () => {
    const rows = shortlistRows();
    if (!rows.length) return setStatus('Nothing on the shortlist to print.', true);
    printDoc(printHtml(rows, new Date(), checklistItems(cfg.checklist), cfg.amenities));
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
      if (data?.app !== 'rea-enhancement' || data?.kind !== 'marks' || !isObj(data.m)) throw new Error('Not an rea-enhancement backup.');
      ui.offerRestore(data);
    } catch (err) { setStatus(err.message, true); }
  });
  const restoreIn = panel.querySelector('.rf-restore-in');
  // Say what it will do first: a restore merges into what's here and can change settings.
  // `lead` opens the sentence ("Restore …", or where a safety copy came from).
  ui.offerRestore = (data, lead = 'Restore') => {
    ui.restoreFromMirror = false;
    const sm = backupSummary(data, cfg);
    const parts = [plural(sm.listings, 'listing') + (sm.listings ? ` (${sm.shortlisted} shortlisted, ${sm.hidden} hidden)` : ''),
      cfg.remember && sm.searches ? plural(sm.searches, 'saved search', 'es') : '', sm.presets ? plural(sm.presets, 'preset') : ''].filter(Boolean);
    restoreIn.querySelector('.rf-restore-msg').textContent = `${lead} ${parts.join(', ')}${sm.settings.length ? `, and replace your ${sm.settings.join(', ')}` : ''}? It merges with what's here; you can undo it.`;
    restoreIn.hidden = false;
    ui.pendingRestore = data;
    restoreIn.querySelector('[data-restore=no]').textContent = 'Cancel'; // a file's offer; the safety copy's relabels it
    restoreIn.querySelector('[data-restore=later]').hidden = true;
    if (!ui.panel.hidden) restoreIn.querySelector('[data-restore=yes]').focus();
  };
  restoreIn.addEventListener('click', (e) => {
    const b = e.target.closest('[data-restore]');
    if (!b) return;
    const data = ui.pendingRestore, fromMirror = ui.restoreFromMirror;
    if (b.dataset.restore === 'later') { restoreIn.hidden = true; return setStatus('The safety copy is kept: it will be offered again next time.'); } // held, untouched
    restoreIn.hidden = true;
    ui.pendingRestore = null;
    ui.restoreFromMirror = false;
    if (b.dataset.restore !== 'yes' || !data) {
      if (fromMirror) { dropMirror().then(releaseMirror); return setStatus('Safety copy discarded.'); }
      if (mirrorHeld) offerMirror(); // a file's offer had replaced the safety copy's: bring it back
      return setStatus('Restore cancelled.');
    }
    // Undo puts the three stores and the settings back exactly as they were.
    const ls = storageOr('localStorage'), keys = [MARKS_KEY, SNAP_KEY, PRESETS_KEY];
    const before = keys.map((k) => { try { return ls.getItem(k); } catch { return null; } }), cfgBefore = { ...cfg };
    const putBack = () => {
      keys.forEach((k2, i) => { try { if (before[i] == null) ls.removeItem(k2); else ls.setItem(k2, before[i]); } catch { /* blocked */ } });
      marks.invalidate(true);
      ui.applyCfg(cfgBefore);
      fillPresets(); renderSaved(); refreshMarks();
    };
    try {
      const n = marks.importJson(data);
      // The copy's own offer answered: copies resume (refreshMarks below writes one). A file restored
      // while that offer waits leaves the copy alone, and it's offered again for what's still missing.
      if (fromMirror) mirrorHeld = false; else if (mirrorHeld) setTimeout(offerMirror, 0);
      const c = backupCfg(data.cfg);
      if (Object.keys(c).length) ui.applyCfg({ ...cfg, ...c });
      const localKeys = Object.keys(snaps.exportData());
      const k = cfg.remember ? snaps.importData(data.snapshots) : 0;
      const pushedOut = localKeys.filter((key) => !snaps.exportData()[key]); // made room for the backup's
      presets.importData(data.presets);
      fillPresets();
      renderSaved();
      refreshMarks();
      offerUndo(`Restored ${plural(n, 'listing')}${k ? `, ${plural(k, 'saved search', 'es')}` : ''}${Object.keys(c).length ? ' and your settings' : ''} from backup.${pushedOut.length ? ` No longer remembered here: ${pushedOut.map(searchLabel).join(', ')}.` : ''}`, () => {
        if (fromMirror) mirrorHeld = true; // the copy still holds what the undo took away: offer it again
        putBack();
        setStatus('Restore undone.');
        if (fromMirror) offerMirror();
      }, 'rf-undo-restore');
    } catch (err) { // merging a checked backup failed: nothing half-restored is kept, and it's worth a report
      if (fromMirror) mirrorHeld = true; // the copy is still the only record of what was lost: not overwritten
      try { putBack(); } catch { /* the error below is the news */ }
      setStatus(`Restore failed, nothing was changed: ${err.message}`, true); logError(`restore: ${err.message}`);
    }
  });
  }

  // #endregion
  // #region keys
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
    const items = listItems();
    if (!items.length && e.key !== 'u') return false; // Undo still works when the action emptied the list
    const cur = document.activeElement?.closest?.('.rf-item');
    const i = cur ? items.indexOf(cur) : -1;
    const move = (d) => { const n = items[Math.max(0, Math.min(items.length - 1, i + d))] || items[0]; n.focus(); n.scrollIntoView({ block: 'nearest' }); if (ui.peekId) ui.showPeek(n); };
    const act = (a) => (cur || items[0]).querySelector(`[data-act="${a}"]`)?.click();
    // Shift+1-5 rates a shortlisted listing, but only where Shift+digit doesn't type the digit:
    // on AZERTY and similar layouts that is how 1-5 (application status) are typed.
    if (e.shiftKey && /^Digit[1-5]$/.test(e.code) && !/^[0-9]$/.test(e.key)) {
      const it = cur || items[0], b = it?.querySelector(`[data-act=rate][data-v="${e.code.slice(5)}"]`);
      if (b) { b.click(); return true; }
    }
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
        for (let n = 0; n < 20 && moreBtn(); n++) renderMore();
        const all = listItems(), last = all[all.length - 1];
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
      case 'u': { const undo = ui.status.querySelector('[data-undo]'); if (!undo) return false; undo.click(); return true; }
      // Enter opens only when the item itself is focused; on a button it presses the button.
      case 'o': case 'Enter': if (!cur || (e.key === 'Enter' && document.activeElement !== cur)) return false; cur.querySelector('.rf-card')?.click(); return true;
      default: return false;
    }
  };
  document.addEventListener('keydown', guard('keys', (e) => {
    if (e.altKey && e.shiftKey && (e.key === 'F' || e.key === 'f' || e.code === 'KeyF') && isSearchPage(location.href) && !typing(e.target)) {
      e.preventDefault();
      if (!panel.dataset.rfReady) { ui.openWhenReady = true; return; } // like the launcher: open once restored
      setOpen(panel.hidden);
      if (!panel.hidden) { if (!ui.placedNow) focusOnOpen(); } else launch.focus();
      return;
    }
    if (panel.hidden) return;
    // Esc is ours only when focus is in the drawer (or it's full-screen): REA's own viewers use it too.
    if (e.key === 'Escape' && ui.peekId) { ui.closePeek(); return; } // closes just the photo
    const menu = document.activeElement?.closest?.('.rf-acts-more[open], .rf-menu[open]');
    if (e.key === 'Escape' && menu && panel.contains(menu)) { menu.open = false; menu.querySelector('summary').focus(); return; } // closes just the ⋯ menu
    // In a search box with something typed, Esc clears it (not every browser does); a second Esc closes.
    if (e.key === 'Escape' && document.activeElement?.matches?.('#rf-panel input[type=search]') && document.activeElement.value) {
      e.preventDefault();
      document.activeElement.value = '';
      document.activeElement.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
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
      if (e.key === 'v' && ui.view !== 'shortlist' && !ui.map.disabled) { e.preventDefault(); ui.map.click(); ui.map.focus(); return; }
      if (e.key === '/' && ui.view === 'shortlist') { e.preventDefault(); ui.slQuery.focus(); return; }
      if (e.key === '/' && ui.view !== 'shortlist') { e.preventDefault(); ui.fold?.(false); ui.more.open = true; panel.querySelector('#rf-keyword').focus(); return; }
      if (!document.activeElement.closest('button, a, summary') || document.activeElement.closest('.rf-item') || (e.key === 'u' && ui.status.contains(document.activeElement))) {
        if (listKeys(e)) { e.preventDefault(); return; }
      }
    }
    if (e.key === 'Tab' && narrow.matches) {
      // Only the first and last focusable that can be seen matter: looked for from each end (each
      // check reads layout, and a long list has thousands of buttons in between).
      const all = panel.querySelectorAll('button,input,select,textarea,a[href],summary');
      const ok = (el) => el.offsetParent && !el.disabled && !el.closest('details:not([open]) > :not(summary)') && (el.checkVisibility?.({ contentVisibilityAuto: true }) ?? true);
      const end = (from, step) => { for (let i = from; i >= 0 && i < all.length; i += step) if (ok(all[i])) return all[i]; return null; };
      const [edge, wrap] = e.shiftKey ? [end(0, 1), () => end(all.length - 1, -1)] : [end(all.length - 1, -1), () => end(0, 1)];
      if (edge && document.activeElement === edge) { e.preventDefault(); wrap().focus(); }
    }
  }));
  }

  // Clicks inside a listing (shortlist, hide, note, status, checklist, ⋯ menu…), delegated from the
  // list. `write`/`onChange` put a setting into the form and apply it (building, anchor, places).
  function wireList(panel, { write, onChange }) {
  // Which checklists you opened or closed yourself (a click on its summary, mouse or keyboard):
  // the browser opening one as it's drawn isn't a choice, so it can still fold away later.
  ui.list.addEventListener('click', (e) => {
    const sum = e.target.closest?.('.rf-ck-more > summary');
    const id = sum?.closest('.rf-item')?.dataset.id;
    if (id) (ui.ckOpen ||= new Map()).set(id, !sum.parentElement.open); // the click runs before the toggle
  }, true);
  ui.list.addEventListener('click', (e) => {
    if (e.target.closest('.rf-more-btn')) return renderMore();
    const pin = e.target.closest('[data-map-id]');
    if (pin) return ui.mapPick?.(pin.dataset.mapId);
    const vx = e.target.closest('[data-view-close]');
    if (vx) { // back to the list
      const v = vx.dataset.viewClose;
      if (v === 'plan') { ui.plan.value = ''; ui.plan.dispatchEvent(new Event('change')); return ui.plan.focus(); }
      const btn = v === 'map' ? ui.map : ui.market;
      btn.click(); return btn.focus();
    }
    const hideAg = e.target.closest('[data-market-ag]');
    if (hideAg) { // market view: hide an agency's listings, with Undo
      const name = hideAg.dataset.marketAg, was = marks.hiddenAgencies().some((a) => agencyKey(a) === agencyKey(name)); // shown with Show hidden on
      marks.toggleAgency(name);
      refreshMarks();
      return offerUndo(`${was ? 'Showing' : 'Hid'} every listing from ${name}.`, () => { marks.toggleAgency(name); refreshMarks(); });
    }
    const week = e.target.closest('[data-week]'); // market view, map and the inspection planner live in the list too
    if (week) return ui.pickWeek?.(week);
    const plan = e.target.closest('[data-plan-ics]');
    if (plan) return ui.planIcs?.(plan);
    const tri = e.target.closest('.rf-item [data-qa]') || e.target.closest('[data-ck]'); // a What to ask answer, or a checklist item
    if (tri) {
      const qa = tri.dataset.qa != null, attr = qa ? 'data-qa' : 'data-ck', v = tri.getAttribute(attr), id = tri.closest('.rf-item').dataset.id;
      if (qa) marks.cycleAnswer(id, v); else marks.cycleCheck(id, v);
      refreshMarks([id]);
      itemEl(id, attrSel(attr, v))?.focus();
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
    const b = e.target.closest('.rf-acts button, .rf-rate button');
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
    // A decline reason shows in the agency's record on its other listings too: all redraw.
    if (b.dataset.act === 'dr') { marks.setDeclineReason(id, b.dataset.r); refreshMarks(); itemEl(id, `[data-act=dr][data-r="${CSS.escape(b.dataset.r)}"]`)?.focus(); return; }
    if (b.dataset.act === 'why') { marks.setHideReason(id, b.dataset.r); refreshMarks(touched(id)); return setStatus(`Hide reason: ${b.dataset.r}.`); }
    if (b.dataset.act === 'h' && rowOf(id)?.resurfaced) { marks.rehide(id); refreshMarks(touched(id, 'h')); return setStatus('Hidden again; it comes back if the rent drops further.'); }
    if (b.dataset.act === 'ics') { const r = rowOf(id); if (r) downloadIcs([r]); return; }
    if (b.dataset.act === 'rate') {
      const n = marks.setRating(id, +b.dataset.v);
      refreshMarks([id]);
      itemEl(id, `[data-act=rate][data-v="${b.dataset.v}"]`)?.focus();
      return setStatus(n ? `Rated ${n} of 5.` : 'Rating cleared.');
    }
    // Where each tag was read from, as text under the listing: the tags' own tooltips can't be
    // reached by keyboard, touch or a screen reader.
    if (b.dataset.act === 'whytags') {
      const item = b.closest('.rf-item'), open = item.querySelector('.rf-whytags'), r = rowOf(id);
      b.setAttribute('aria-expanded', String(!open));
      if (open) { open.remove(); return; }
      if (!r) return;
      const { am, wt } = tagItemsOf(r);
      const box = Object.assign(document.createElement('div'), { className: 'rf-whytags rf-meta', tabIndex: -1 });
      box.setAttribute('role', 'note');
      box.setAttribute('aria-label', 'Why these tags');
      box.innerHTML = `<ul>${[...am, ...wt].filter((t) => t[1]).map((t) => `<li><strong>${esc(t[0])}</strong>: ${esc(t[1])}</li>`).join('')}</ul>`;
      item.querySelector('.rf-card').after(box);
      item.querySelector('.rf-acts-more')?.removeAttribute('open');
      box.focus();
      return;
    }
    if (b.dataset.act === 'case') {
      const r = rowOf(id);
      if (r) copyText(testCaseText(r)).then((ok) => setStatus(ok ? 'Tag phrases copied as test cases (the tables in test/amenities.test.js): paste them into an issue or a fix.' : 'Clipboard blocked.', !ok));
      return;
    }
    if (b.dataset.act === 'enq') {
      const r = rowOf(id);
      if (r) copyText(enquiryText(r, cfg.enquiry, cfg.amenities, cfg.inspectFree)).then((ok) => setStatus(ok ? 'Enquiry copied: paste it into the agent\'s contact form.' : 'Clipboard blocked.', !ok));
      return;
    }
    if (b.dataset.act === 'viewing') {
      const r = rowOf(id);
      if (r) copyText(enquiryText(r, VIEWING_TEMPLATE, cfg.amenities, cfg.inspectFree)).then((ok) => setStatus(ok ? `Viewing request copied${freeTimesText(cfg.inspectFree) ? ', with your inspection times' : ' (set My inspection times under More filters to include them)'}.` : 'Clipboard blocked.', !ok));
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
    refreshMarks(touched(id, act)); // see touched()
    // Re-render replaced the button: put focus back (or on the next item if this one left the list).
    const q = (i) => itemEl(i, `[data-act="${act}"]`);
    (q(id) || (next && q(next)) || ui.list).focus?.();
    if (act === 'h' && on) offerHideUndo(id, () => { marks.toggle(id, 'h'); refreshMarks(touched(id, 'h')); (q(id) || ui.list).focus(); });
  });
  }

  // #endregion
  // #region build
  function build() {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    const launch = document.createElement('button');
    launch.id = 'rf-launch';
    launch.textContent = 'Rental Toolkit';

    const panel = document.createElement('div');
    panel.id = 'rf-panel';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Rental Toolkit');
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
      map: panel.querySelector('.rf-map-btn'),
      list: panel.querySelector('.rf-list'),
      reaBox: panel.querySelector('.rf-rea'),
      reaApply: panel.querySelector('.rf-rea-apply'),
    };
    ui.reaApply.addEventListener('click', () => { if (!ui.reaTo) return; setStatus("Opening REA's search with your filters…"); location.assign(ui.reaTo); });

    // Inputs map 1:1 to cfg keys via their id (rf-<key>); exactOnly keeps its legacy id.
    const fields = Object.keys(DEFAULT_CFG).map((k) => [k, panel.querySelector(`#rf-${k === 'exactOnly' ? 'exact' : k}`)]);
    // A whole-number setting typed out of range (notice 150, income 5.5) is clamped to what
    // sanitizeCfg keeps, so it isn't silently reset on the next load; the field shows it.
    const read = (el) => {
      if (el.type === 'checkbox') return el.checked;
      const spec = SETTING_BY_KEY.get(el.id.slice(3));
      if (spec?.kind !== 'int' || el.value.trim() === '') return spec?.kind === 'int' ? '' : el.value;
      const n = Math.round(+el.value);
      return Number.isFinite(n) ? String(Math.min(spec.max, Math.max(spec.min, n))) : '';
    };
    const write = (el, v) => { if (el.type === 'checkbox') el.checked = !!v; else { ensureOption(el, v); el.value = v ?? ''; } };
    for (const [k, el] of fields) write(el, cfg[k]);
    // The field shows the clamped number once you leave it (not while typing "0…" on the way to "05").
    for (const [k, el] of fields) if (SETTING_BY_KEY.get(k)?.kind === 'int') el.addEventListener('change', () => { const v = read(el); if (el.value !== v) el.value = v; });
    // Put `next` into the form (only what changed) and apply it as if typed.
    function applyCfg(next) {
      for (const [k, el] of fields) if (next[k] !== cfg[k]) write(el, next[k]);
      ui.paintAmen?.();
      onChange({ type: 'change' });
    }
    queueMicrotask(() => ui.paintAmen?.());
    ui.fields = fields;
    ui.applyCfg = applyCfg;
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
      if (focused) list.querySelector(attrSel('data-ptype', focused))?.focus();
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
    wireFold(panel, narrow);
    const setOpen = (open) => {
      if (open && ui.backupNudge) { ui.backupNudge(); ui.backupNudge = null; }
      if (!open) ui.closePeek?.();
      panel.hidden = !open;
      if (open && ui.savedStale) renderSaved();
      if (open && ui.listStale) { const note = ui.listStale; ui.listStale = false; if (cache) inPlace(() => showResults(note === true ? '' : note)); }
      launch.setAttribute('aria-expanded', String(open));
      panel.setAttribute('aria-modal', String(open && narrow.matches));
      setInert(open && narrow.matches);
      if (!open) for (const d of panel.querySelectorAll('.rf-acts-more[open], .rf-menu[open]')) d.open = false;
      else { ui.applyWidth?.(); ui.syncSticky?.(); ui.placedNow = !!ui.applyPlace?.(); } // sizes are only known once it's shown
    };
    narrow.addEventListener?.('change', () => { if (!panel.hidden) setOpen(true); });
    ui.setOpen = setOpen;
    launch.addEventListener('click', () => {
      // Clicked in the moment before startup has restored this search: open once it has, so the
      // drawer lands on the listing you were on rather than on an empty list.
      if (!panel.dataset.rfReady) { ui.openWhenReady = true; return; }
      setOpen(true); if (!ui.placedNow) focusOnOpen(); // back where you were, else on Search (or the first thing that's there)
    });
    panel.querySelector('.rf-x').addEventListener('click', () => { setOpen(false); launch.focus(); });
    const help = panel.querySelector('.rf-help'), helpBtn = panel.querySelector('.rf-keys');
    const toggleHelp = () => {
      help.hidden = !help.hidden;
      helpBtn.setAttribute('aria-expanded', String(!help.hidden));
      if (!help.hidden) help.scrollIntoView({ block: 'nearest' });
    };
    // Light / dark in one click: the opposite of what's showing (the system's until you pick), set
    // through the Theme setting so it's saved, synced to other tabs and shown in Settings too.
    const themeBtn = panel.querySelector('.rf-themebtn'), darkMq = window.matchMedia?.('(prefers-color-scheme: dark)');
    const isDark = () => cfg.theme === 'dark' || (cfg.theme !== 'light' && !!darkMq?.matches);
    ui.paintThemeBtn = () => { const d = isDark(), l = d ? 'Light mode' : 'Dark mode'; themeBtn.textContent = d ? '☀︎' : '☾︎'; themeBtn.title = l; themeBtn.setAttribute('aria-label', l); };
    themeBtn.addEventListener('click', () => { const sel = panel.querySelector('#rf-theme'); sel.value = isDark() ? 'light' : 'dark'; sel.dispatchEvent(new Event('change', { bubbles: true })); });
    darkMq?.addEventListener?.('change', () => ui.paintThemeBtn());
    ui.paintThemeBtn();
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
    // Compared with the live config, not the last one typed here: another tab, or a search change,
    // can set cfg quietly, and changing the field back must still count.
    const cfgSig = () => JSON.stringify(Object.fromEntries(fields.map(([k]) => [k, cfg[k]])));
    // Leaving a typed field mid-click (mousedown -> blur -> change) must not re-render the list
    // under the pointer, or the click is lost: renders asked for during a press wait for its end.
    let pressing = false, renderAfterPress = false;
    const typed = (el) => el?.tagName === 'TEXTAREA' || el?.type === 'text' || el?.type === 'number' || el?.type === 'date';
    const renderNow = (defer) => { if (defer && pressing) renderAfterPress = true; else showResults(); };
    panel.addEventListener('pointerdown', () => { pressing = true; }, true);
    // A press that never got its pointerup can't hold renders: a key ends it, and flushes what it held.
    // Other redraws (a note editor closing on blur) can wait for the press the same way.
    let held = [];
    const flushPress = () => { pressing = false; if (renderAfterPress) { renderAfterPress = false; if (cache) showResults(); } const fns = held; held = []; for (const fn of fns) fn(); };
    ui.afterPress = (fn) => { if (pressing) held.push(fn); else fn(); };
    panel.addEventListener('keydown', () => { if (pressing) flushPress(); }, true);
    const endPress = () => pressing && setTimeout(flushPress, 0);
    for (const type of ['pointerup', 'pointercancel', 'click']) document.addEventListener(type, endPress, true); // pointerup's timeout runs after its click
    const onChange = (e) => {
      const next = Object.fromEntries(fields.map(([k, el]) => [k, read(el)]));
      const sig = JSON.stringify(next);
      if (sig === cfgSig()) {
        // Same config: only flush a pending debounced render (eg Enter right after typing).
        if (t && e?.type === 'change') { clearTimeout(t); t = null; if (cache) renderNow(typed(e.target)); }
        return;
      }
      const wasRemember = cfg.remember;
      cfg = next;
      paintRea();
      panel.classList.toggle('rf-compact', !!cfg.compact);
      applyTheme();
      sortDir.setAttribute('aria-pressed', String(!!cfg.sortDesc));
      saveCfg(mergeCfg({ ...DEFAULT_CFG, ...loadCfg() }, cfgBase, cfg));
      mirrorSoon();
      cfgBase = { ...cfg };
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
      if (!cache) { if (ui.view === 'shortlist') renderShortlist(); return; } // no search: the Shortlist still follows settings
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
    wireSticky(panel); wireFocusKeep(panel);
    wirePeek(panel);
    for (const b of panel.querySelectorAll('[data-report]')) b.addEventListener('click', async () => {
      const ok = await copyText(reportText());
      setStatus(ok ? 'Report copied: paste it into an issue ("REA data format changed"). It has no listing text, names or addresses.' : 'Clipboard blocked - run reaFilter.selfcheck() in the console instead.', !ok);
    });
    ui.warnbar.querySelector('.rf-warn-x').addEventListener('click', () => { ui.warnDismissed = ui.warnbar.querySelector('.rf-warn-msg').textContent; ui.warnbar.hidden = true; });
    // Next chunk loads as the "Show more" button nears view (the button stays for keyboard use).
    // Its root is whatever scrolls the results (the drawer, or the list when expanded), so it is
    // rebuilt when that changes.
    if (typeof IntersectionObserver === 'function') {
      let io = null;
      const observeMore = () => { if (!io) return; io.disconnect(); const b = moreBtn(); if (b) io.observe(b); };
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
      // On Results a status shows on its own listing and, as your record, on its agency's others:
      // only those redraw (the Shortlist's pack and order follow every status, so all of it does).
      const ak = agencyKey(rowById(id)?.agency);
      refreshMarks(ui.view === 'shortlist' ? null : [id, ...(ak && cache ? cache.filter((r) => agencyKey(r.agency) === ak).map((r) => r.id) : [])]);
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
    panel.querySelector('#rf-slSort').addEventListener('change', () => { if (!cache) renderShortlist(); }); // with results, the settings change redraws it
    let slqT = null;
    ui.slQuery.addEventListener('input', () => { clearTimeout(slqT); slqT = setTimeout(() => { if (ui.view === 'shortlist') renderShortlist(); }, 150); }); // not into Results if the tab changed meanwhile
    ui.plan.addEventListener('change', () => {
      ui.planDay = ui.plan.value || null;
      if (ui.planDay && ui.compare) ui.slBar.querySelector('[data-sl=compare]').click(); // one view at a time
      renderShortlist();
    });
    wirePresets();
    // Bulk actions: one write, one re-render, one undo that restores the exact previous state.
    const bulk = (sel, fn) => onPick(sel, () => {
      const v = sel.value;
      sel.value = '';
      const rows = (sel === ui.slBulk && ui.view === 'shortlist' && ui.bulkRows) || ui.rows;
      if (!v || !rows?.length) return;
      const before = marks.dump(rows.map((r) => r.id));
      const msg = fn(v, rows);
      refreshMarks();
      if (msg) offerUndo(msg, () => { marks.restoreDump(before); refreshMarks(); }, 'rf-undo-restore'); // puts entries back wholesale: gone once another tab writes
      if (sel.disabled && [ui.status, document.body].includes(document.activeElement)) ui.status.querySelector('[data-undo]')?.focus({ preventScroll: true }); // emptied the list: Undo is next
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
    // Market and Map replace the list; at most one at a time.
    const setView2 = (market, map) => {
      ui.marketOn = market; ui.mapOn = map;
      ui.market.setAttribute('aria-pressed', String(market)); ui.map.setAttribute('aria-pressed', String(map));
    };
    ui.market.addEventListener('click', () => { setView2(!ui.marketOn, false); showResults(); });
    ui.map.addEventListener('click', () => { setView2(false, !ui.mapOn); showResults(); });
    // A dot: back to the list, on that listing (rendering more of the list if it is further down).
    ui.mapPick = (id) => {
      setView2(false, false);
      const at = (ui.rows || []).findIndex((r) => r.id === id); // render down to it in one pass
      ui.keepShown = at >= 0 ? Math.ceil((at + 1) / RENDER_CHUNK) * RENDER_CHUNK : 0;
      showResults();
      ui.keepShown = 0;
      const el = itemEl(id);
      if (el) { el.focus(); el.scrollIntoView({ block: 'center' }); }
    };
    const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    ui.list.addEventListener('keydown', (e) => {
      const dot = e.target.closest?.('[data-map-id]');
      if (!dot) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); ui.mapPick(dot.dataset.mapId); return; }
      const dir = ARROWS[e.key];
      if (!dir) return;
      e.preventDefault(); e.stopPropagation();
      // The nearest dot that way, favouring ones straight ahead over ones off to the side.
      const x0 = +dot.getAttribute('cx'), y0 = +dot.getAttribute('cy');
      let best = null, bestD = Infinity;
      for (const d of ui.list.querySelectorAll('[data-map-id]')) {
        const dx = +d.getAttribute('cx') - x0, dy = +d.getAttribute('cy') - y0, ahead = dx * dir[0] + dy * dir[1];
        if (d === dot || ahead <= 0) continue;
        const dist = ahead + 2 * Math.abs(dx * dir[1] + dy * dir[0]);
        if (dist < bestD) { bestD = dist; best = d; }
      }
      if (!best) return;
      dot.setAttribute('tabindex', '-1'); best.setAttribute('tabindex', '0'); best.focus();
    });
    ui.pickWeek = (b) => {
      if (!ui.rows) return;
      const w = marketStats(ui.rows).byWeek[+b.dataset.week];
      const later = new Date(); later.setDate(later.getDate() + 1 + MARKET_WEEKS * 7);
      const range = w.label === 'Now' ? { from: '', to: ymdLocal(new Date()) } : w.label === 'Later' ? { from: ymdLocal(later), to: '' } : { from: w.from, to: w.to };
      // Narrow within your own dates (a "within" window becomes its end date), never widen them.
      const tos = [range.to, cfg.to, windowEnd(cfg.withinDays)].filter(Boolean).sort();
      const next = { ...cfg, from: [range.from, cfg.from].filter(Boolean).sort().pop() || '', to: tos[0] || '', withinDays: '' };
      setView2(false, false);
      applyCfg(next);
      showResults(); // also when the dates didn't change (same week again)
      (ui.list.querySelector('.rf-item') || ui.market).focus();
    };
    ui.active.addEventListener('click', (e) => {
      const b = e.target.closest('[data-chip]');
      const chip = b && ui.activeChips?.[+b.dataset.chip];
      if (!chip) return;
      const i = +b.dataset.chip, wasFocused = document.activeElement === b;
      const next = without(cfg, chip);
      applyCfg(next);
      // The chip went with its filter: the one now in its place, the list, or More filters.
      if (wasFocused) (ui.active.querySelector(`[data-chip="${i}"]`) || ui.active.querySelector(`[data-chip="${i - 1}"]`) || ui.list.querySelector('.rf-item') || ui.more.querySelector('summary'))?.focus();
    });
    panel.querySelector('.rf-agencies').addEventListener('click', (e) => {
      const b = e.target.closest('[data-unhide-ag]');
      if (b) { marks.toggleAgency(b.dataset.unhideAg); refreshMarks(); }
      const sb = e.target.closest('[data-unhide-sb]');
      if (sb) { marks.toggleSuburb(sb.dataset.unhideSb); refreshMarks(); }
    });
    wireShortlistBar(panel);
    wireTicks();
    ui.run.addEventListener('click', () => (busy && !runCtrl?.job) || run()); // a search here takes over from Check all / Re-check
    ui.partial.querySelector('[data-resume]').addEventListener('click', () => busy || run(true, { resume: true }));
    ui.refresh.addEventListener('click', () => busy || run(true));
    wireExports();
    ui.ready = true; // last: init steps only run against a fully wired drawer
  }

  // Phones: once there are results, the controls fold into one bar ("Filters · 2 active · Sort:
  // Price ▾"); a tap opens them again. Wider screens never fold.
  // The side drawer's sticky header, tabs and status line, and the way back to the filters.
  function wireSticky(panel) {
  // Side drawer: the status line (count, Undo, "Why?") sticks under the header, and once the
  // filters have scrolled away the header offers a way back to them.
  const head = panel.querySelector('.rf-head'), toFilters = panel.querySelector('.rf-tofilters');
  // Every height is read before any is written, so no write forces a layout before the next read.
  const tabs = panel.querySelector('.rf-tabs');
  ui.syncSticky = () => {
    const hh = head.offsetHeight, th = tabs.offsetHeight, sh = ui.status.offsetHeight;
    const full = panel.classList.contains('rf-full');
    const set = (el, prop, v) => { if (el.style[prop] !== v) el.style[prop] = v; };
    set(tabs, 'top', full ? '' : `${hh}px`);
    set(ui.status, 'top', full ? '' : `${hh + th}px`);
    // Listings scrolled into view clear all three: the tallest status line seen since the header
    // or tabs last changed height (rather than re-styling every listing each time it changes).
    const base = hh + th;
    if (ui.stickyBase !== base) { ui.stickyBase = base; ui.stickyStatus = 0; }
    ui.stickyStatus = Math.max(ui.stickyStatus || 0, sh);
    const it = `${base + ui.stickyStatus + 4}px`;
    if (panel.style.getPropertyValue('--rf-item-top') !== it) panel.style.setProperty('--rf-item-top', it);
    const top = ui.view === 'shortlist' ? ui.slBar : ui.controls;
    const off = panel.classList.contains('rf-full') || top.getBoundingClientRect().bottom > tabs.getBoundingClientRect().bottom;
    if (toFilters.hidden !== off) toFilters.hidden = off; // runs on every scroll event
  };
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => ui.syncSticky()).observe(ui.status);
  panel.addEventListener('scroll', () => { ui.syncSticky(); notePlace(); }, { passive: true });
  ui.list.addEventListener('scroll', () => notePlace(), { passive: true });
  ui.list.addEventListener('focusin', () => notePlace());
  ui.applyPlace = () => applyPlace();
  ui.toFilters = () => {
    ui.fold?.(false);
    panel.scrollTop = 0;
    (ui.view === 'shortlist' ? ui.slQuery : panel.querySelector('#rf-from'))?.focus({ preventScroll: true }); // the search stays when the bar folds
    ui.syncSticky();
  };
  toFilters.addEventListener('click', () => ui.toFilters());
  }
  // Whatever removes or hides the control that has focus (Undo, an offer's buttons, a banner's ×,
  // a status button that redraws), focus stays in the drawer: on the status line, else the list,
  // so the shortcuts and Esc keep working. Clicking elsewhere on the page leaves focus alone.
  function wireFocusKeep(panel) {
    ui.status.tabIndex = -1;
    panel.addEventListener('focusout', (e) => {
      const was = e.target;
      setTimeout(() => {
        if (panel.hidden || (document.activeElement && document.activeElement !== document.body)) return;
        if (was.isConnected && was.checkVisibility?.() !== false) return; // it's still there: you went elsewhere
        [ui.status, ui.list.querySelector('.rf-item'), ui.list].find((el) => el?.isConnected && el.checkVisibility?.() !== false)?.focus({ preventScroll: true });
      }, 0);
    });
  }
  function wireFold(panel, narrow) {
  const foldBtn = panel.querySelector('.rf-unfold'), controls = panel.querySelector('.rf-controls');
  ui.fold = (on) => {
    const can = narrow.matches && !!cache;
    // Folding away what has focus (Search, after a search) would drop it to the page: the bar takes it.
    if (can && on && controls.contains(document.activeElement)) queueMicrotask(() => foldBtn.focus({ preventScroll: true }));
    controls.classList.toggle('rf-folded', can && on);
    foldBtn.hidden = !can;
    foldBtn.setAttribute('aria-expanded', String(!(can && on)));
    const n = activeFilters(cfg).length, sort = panel.querySelector('#rf-sort');
    foldBtn.textContent = `${can && on ? '▸' : '▾'} Filters${n ? ` · ${n} active` : ''} · Sort: ${sort.selectedOptions[0]?.textContent || ''}`;
  };
  foldBtn.addEventListener('click', () => ui.fold(!controls.classList.contains('rf-folded')));
  narrow.addEventListener?.('change', () => { ui.fold(controls.classList.contains('rf-folded')); ui.slFold(ui.slFolded ?? true); });
  // The Shortlist's bar too: its search stays, the tools fold behind one button that says what's set.
  const slBtn = ui.slBar.querySelector('.rf-sl-unfold');
  ui.slFold = (on) => {
    const can = narrow.matches && marks.counts().starred > 0;
    if (can && on && ui.slBar.contains(document.activeElement) && document.activeElement !== ui.slQuery && document.activeElement !== slBtn) queueMicrotask(() => slBtn.focus({ preventScroll: true }));
    ui.slBar.classList.toggle('rf-folded', can && on);
    slBtn.hidden = !can;
    slBtn.setAttribute('aria-expanded', String(!(can && on)));
    const f = ui.slFilter.selectedOptions[0], pack = ui.slBar.querySelector('.rf-sl-ticks:not([hidden]) summary')?.textContent;
    slBtn.textContent = `${can && on ? '▸' : '▾'} Tools${ui.slFilter.value ? ` · ${f?.textContent}` : ''}${pack ? ` · ${pack.replace(/^Application pack: /, 'Pack ')}` : ''}`;
  };
  slBtn.addEventListener('click', () => { ui.slFolded = !ui.slBar.classList.contains('rf-folded'); ui.slFold(ui.slFolded); });
  }
  // Export buttons (Results bar and Shortlist menu): what's on screen, as CSV, TSV, a copy or a calendar.
  function wireExports() {
    for (const b of ui.exports) {
      b.addEventListener('click', async () => {
        const rows = ui.view === 'shortlist' ? shortlistRows() : cache ? applyFilters(pool(), cfg) : null;
        if (!rows) return;
        if (b.dataset.export === 'csv') downloadCsv(rows);
        else if (b.dataset.export === 'tsv') downloadTsv(rows);
        else if (b.dataset.export === 'ics') downloadIcs(rows, { reminders: true, track: ui.view === 'shortlist' && !shortlistNarrowed() }); // a narrowed list isn't "what's on the shortlist"
        else {
          const ok = await copyText(toTsv(rows));
          setStatus(ok ? `Copied ${rows.length} rows.` : 'Clipboard blocked - use TSV download instead.', !ok);
        }
      });
    }
  }

  const rowById = (id) => known.get(id) || cache?.find((r) => r.id === id) || null;
  const rowOf = (id) => rowById(id) || ui.rows?.find((x) => x.id === id); // also shortlist-only rows
  const BULK_HIDE = { sb: ['suburb', (n) => marks.toggleSuburb(n), 'in'], ag: ['agency', (n) => marks.toggleAgency(n), 'from'] };

  // Where you were in each tab (and for which search + filters), so switching tabs keeps it.
  // Shortlist-only settings (ticks, its order, the visit stamp) don't move your place on Results.
  const SL_ONLY = ['packDone', 'moveDone', 'ecrDone', 'slSort', 'slSeenAt'];
  const placeSig = (view) => (view === 'shortlist' ? 'sl' : `${cacheKey}|${JSON.stringify({ ...cfg, ...Object.fromEntries(SL_ONLY.map((k) => [k, ''])) })}`);
  // Settings live on Results: switch there, open them and go to one field (from the Shortlist's
  // "set your notice period", or a tick list's "Edit this list").
  function openSetting(key) {
    if (ui.view !== 'results') setView('results');
    ui.fold?.(false);
    const det = ui.panel.querySelector('.rf-settings');
    det.open = true;
    const el = ui.panel.querySelector(`#rf-${key}`);
    el?.scrollIntoView({ block: 'center' });
    el?.focus({ preventScroll: true });
  }
  function setView(view) {
    ui.closePeek?.();
    const place = (ui.place ||= {});
    // The tab left keeps its nodes: coming back to the same list, they go back in and the redraw's
    // keyed diff reuses them instead of parsing every listing's markup again.
    const kept = (ui.viewNodes ||= {});
    if (ui.view && ui.view !== view) { place[ui.view] = { top: listScroller().scrollTop, shown: listItems().length, sig: placeSig(ui.view) }; kept[ui.view] = [...ui.list.childNodes]; }
    const back = place[view]?.sig === placeSig(view) ? place[view] : null;
    if (back) { ui.keepShown = back.shown; if (kept[view]) ui.list.replaceChildren(...kept[view]); }
    delete kept[view];
    ui.view = view;
    for (const t of ui.tabs) { const on = t.dataset.view === view; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; }
    ui.list.setAttribute('aria-labelledby', `rf-tab-${view}`);
    const sl = view === 'shortlist';
    ui.controls.hidden = sl;
    ui.active.hidden = true; // results view re-shows it via renderActive()
    ui.slBar.hidden = !sl;
    ui.panel.querySelector('.rf-clear').hidden = sl; // filters don't apply to the shortlist
    ui.panel.classList.toggle('rf-wide', sl && !!ui.compare);
    if (sl && ui.slSince == null) { // this page's first Shortlist visit: changes since the last one (an hour or more ago) are named
      const last = +cfg.slSeenAt || 0;
      ui.slSince = last && Date.now() - last > HOUR_MS ? last : 0; // back within the hour, or a first visit: no "since" line
      ui.slPrev = last; // the Changed since last visit filter still compares with the last visit
      if (Date.now() - last > HOUR_MS) { // stored quietly: nothing to redraw
        cfg = { ...cfg, slSeenAt: String(Date.now()) };
        cfgBase = { ...cfgBase, slSeenAt: cfg.slSeenAt };
        const el = ui.panel.querySelector('#rf-slSeenAt'); if (el) el.value = cfg.slSeenAt;
        saveCfg({ ...DEFAULT_CFG, ...loadCfg(), slSeenAt: cfg.slSeenAt }); // only the stamp: another tab's saved settings stay
      }
    }
    if (sl) renderShortlist();
    else if (cache) showResults();
    else { setEmpty(EMPTY_INTRO); setStatus(''); setExport(true); }
    ui.keepShown = 0;
    if (back) listScroller().scrollTop = back.top;
    else if (!(sl && shortlistPlace()) && sl) toListTop(); // not the Results tab's scroll offset
    ui.syncSticky?.();
  }

  // What the Shortlist shows (its status filter and search box applied), with distances, lease fit
  // and moving costs worked out: exports and print get them too, not only the list (the rows are
  // fresh objects once a minute).
  const shortlistRows = (all = marks.shortlist()) => {
    const f = ui.slFilter.value, q = ui.slQuery.value;
    const changed = f === '~' ? sinceChanges(all, ui.slSince || ui.slPrev || +cfg.slSeenAt || Date.now()).ids : null;
    const kept = all.filter((r) => (!f || (f === '-' ? !r.appStatus : f === '!' ? !!(needsAction(r) || needsFollowUp(r)) : f === '~' ? changed.has(r.id) : r.appStatus === f)) && textMatch(r, q));
    const rows = cfg.slSort === 'added' ? kept : byNext(kept);
    const anchor = parseAnchor(cfg.anchor), places = parsePlaces(cfg.places), end = leaseEndOf(cfg), extra = num(cfg.moveCosts) || 0, rentNow = num(cfg.rentNow) || 0;
    for (const r of rows) { setDistances(r, cfg, anchor, places); r.fit = leaseFit(r, end); r.moveExtra = extra; r.rentNow = rentNow; }
    return rows;
  };
  const shortlistNarrowed = () => !!(ui.slFilter.value || ui.slQuery.value.trim());

  // Re-check shortlisted listings one at a time (user-initiated, polite delay, abortable).
  const RECHECK_MAX = 30;
  // User-started background jobs (re-check, check all) share the search's abort/busy slot.
  const startJob = (btn) => { runCtrl?.abort(); const c = runCtrl = new AbortController(); c.job = true; setBusy(true); btn.setAttribute('aria-disabled', 'true'); return c; };
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
        let res, html, kind;
        try { ({ res, html, kind } = await fetchListingPage(r.url, ctrl.signal)); } catch (err) { // a reset mid-download is one unreadable listing, not the end
          if (ctrl.signal.aborted) throw err;
          tally.unknown++; continue;
        }
        // A 403, a second 429, or a page with no data that isn't a removed listing stops everything.
        if (BOT_KINDS.has(kind)) {
          tripPause(botCheck(`Re-check: ${kind === 'challenge' ? 'challenge page' : `HTTP ${res.status}`}`));
          throw pausedErr(pause.until());
        }
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
      if (!err?.paused && err?.name !== 'AbortError') logError(`re-check: ${err?.message || err}`); // a bug, not a Stop or a bot check
      setStatus(err?.paused ? `Re-check stopped after ${plural(tally.ok + tally.gone + tally.unknown, 'listing')}. ${err.message}` : 'Re-check stopped.', !!err?.paused);
    } finally {
      endJob(ctrl, btn);
    }
  }

  // Remembered searches, newest first, with what the last "Check all" found.
  function renderSaved() {
    // Drawn once it can be seen: reading remembered searches is ~10 ms each, on every listing page.
    if (ui.panel.hidden) { ui.savedStale = true; return; }
    ui.savedStale = false;
    const entries = cfg.remember ? Object.entries(snaps.exportData()).sort(([, a], [, b]) => b.at - a.at) : [];
    ui.saved.hidden = !entries.length;
    const here = currentKey();
    ui.saved.querySelector('.rf-saved-list').innerHTML = entries.map(([k, e]) => {
      const r = ui.savedResult.get(k);
      const found = r?.error ? ' · <span class="rf-warn-t">couldn\'t be read</span>' : r ? ` · <strong>${r.added} new</strong>${r.match != null ? ` (${r.match} match)` : ''}${r.gone ? `, ${r.gone} gone` : ''}` : '';
      return `<li><a href="${esc(safeUrl(k))}">${esc(searchLabel(k))}</a>${k === here ? ' <span class="rf-tag">this search</span>' : ''}
        <button type="button" class="rf-chip rf-pin" data-saved-pin="${esc(k)}" aria-pressed="${!!e.pin}" title="${e.pin ? 'Pinned: kept when you open other searches' : `Keep this one when more than ${SNAP_MAX} searches are opened`}">${e.pin ? 'Pinned' : 'Pin'}</button>
        <div class="rf-meta">${(e.ids || e.rows || []).length} listings · checked ${esc(ago(Date.now() - e.at))}${found}</div>${trendText(e.trend) ? `<div class="rf-meta rf-trend">${esc(trendText(e.trend))}</div>` : ''}</li>`;
    }).join('');
  }

  async function checkSaved(btn) {
    if (busy) return;
    const keys = Object.entries(snaps.exportData()).sort(([, a], [, b]) => b.at - a.at).map(([k]) => k);
    if (!keys.length) return;
    if (pause.until()) return setStatus(pausedErr(pause.until()).message, true);
    const ctrl = ui.savedCtrl = startJob(btn);
    pageMemo.clear(); // "new since" must mean now, not the pages cached a few minutes ago
    const out = [], dropped = [];
    // Every baseline read first: near the quota, one search's save can evict one not checked yet.
    const base = snaps.exportData();
    let full = false;
    try {
      for (const [i, key] of keys.entries()) {
        if (full) break; // storage full: checking the rest would only push out more of them
        const label = searchLabel(key);
        const before = new Set(base[key]?.ids || []);
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
        if (res.paging) { // not every page read: saving it would count the rest as gone
          formatWarn(PAGING_MSG[res.paging]);
          ui.savedResult.set(key, { error: true });
          out.push(`${label}: stopped early (REA's paging may have changed)`);
          continue;
        }
        const ids = new Set(res.rows.map((r) => r.id));
        const added = res.rows.filter((r) => !before.has(r.id));
        // How many of the new ones get past the filters: the search's own preset if it has one, else yours.
        const bound = presets.forSearch(key), fcfg = { ...cfg, building: '', ...(bound ? bound.cfg : {}) }; // this tab's building focus is about another search
        let match = null;
        if (added.length && activeFilters(fcfg).length) {
          const copies = marks.decorate(added.map((r) => ({ ...r, sinceLast: true }))), anchor = parseAnchor(fcfg.anchor), places = parsePlaces(fcfg.places);
          for (const r of copies) setDistances(r, fcfg, anchor, places);
          match = filterRows(copies, fcfg).length;
        }
        const found = { added: added.length, gone: [...before].filter((id) => !ids.has(id)).length, match, by: bound ? `its preset ${bound.name}` : 'your filters' };
        if (!cfg.remember) throw new DOMException('remember turned off', 'AbortError'); // opted out mid-check: store nothing
        store.set(key, res.rows, res.truncated);
        const snap = snaps.save(key, res.rows, res.truncated);
        // Only a save that gave something up stops the check (trimming gone rows to fit doesn't);
        // a refused one keeps its last copy, so it isn't "no longer remembered".
        if (snap.quota && (snap.evicted.length || snap.refused)) { full = true; dropped.push(...snap.evicted.map(searchLabel)); }
        if (key === (currentKey() ?? cacheKey)) adopt(key, res.rows, res.truncated, '', snap, true);
        else learn(res.rows, true, true);
        ui.savedResult.set(key, found);
        out.push(`${label}: ${found.added} new${found.match != null ? ` (${found.match} match ${found.by})` : ''}${found.gone ? `, ${found.gone} gone` : ''}`);
        if (i < keys.length - 1) await sleep(jitter(PAGE_DELAY_MS), ctrl.signal);
      }
      setStatus(`Checked ${plural(out.length, 'saved search', 'es')}. ${out.join(' · ')}.`);
      if (full) setWarn('saved', `This browser's storage is full: ${dropped.length ? `stopped remembering ${[...new Set(dropped)].join(', ')}, and ` : ''}the check stopped there. Delete saved searches or turn off Remember results to make room.`);
    } catch (err) {
      // Aborted by navigation or opting out: whoever aborted has already said why.
      if (!ctrl.signal.aborted && err?.name !== 'AbortError') { setStatus(`Check failed: ${err.message}`, true); logError(`saved: ${err.message}`); }
    } finally {
      endJob(ctrl, btn);
      if (ui.savedCtrl === ctrl) ui.savedCtrl = null;
      renderSaved();
    }
  }

  // Somewhere on the Shortlist bar that's still there: its status filter, or (folded, on a phone) the bar's button.
  const slFocus = () => (ui.slBar.classList.contains('rf-folded') ? ui.slBar.querySelector('.rf-sl-unfold') : ui.slFilter).focus();
  function renderShortlist() {
    const all = marks.shortlist();
    const rows = shortlistRows(all);
    ui.portals = packPortals(all);
    setLaunchCount(ui.launchN ?? null); // its to-do count follows the statuses and your notice settings
    renderTicks(all);
    ui.slFold?.(ui.slFolded ?? true); // on a phone: folded until you open it
    ui.agencyRec = agencyRecord(all); // over the whole shortlist, not just what the search box shows
    ui.rows = rows;
    setExport(rows.length === 0);
    const days = inspectDays(rows);
    ui.plan.innerHTML = `<option value="">Plan a day…</option>` + days.map(({ day, n }) =>
      `<option value="${day}">${esc(shortDate(day))} (${plural(n, 'inspection')})</option>`).join('');
    if (ui.planDay && !days.some((d) => d.day === ui.planDay)) ui.planDay = null;
    ui.plan.value = ui.planDay || '';
    ui.plan.hidden = !days.length;
    const slots = ui.planDay ? planDay(rows, ui.planDay, { free: parseFreeTimes(cfg.inspectFree) }) : null;
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
      : slots ? planHtml(slots, ui.planDay) : compareHtml(cmp, cfg, { total: ui.rows.length, picked: ui.cmpPicked });
    setStatus(rows.length ? `${rows.length < total ? `${rows.length} of ${total}` : rows.length} shortlisted across all searches. Details are as last seen.` : '');
    const since = ui.slSince ? sinceChanges(all, ui.slSince) : null;
    if (since?.text && ui.slFilter.value !== '~') { // since your last visit, with a way to see just those
      const b = statusBtn('Show them', () => { ui.slFilter.value = '~'; renderShortlist(); slFocus(); });
      ui.status.append(` Since your last visit (${ago(Date.now() - ui.slSince)}): ${since.text}. `, b);
    }
    const won = nextSteps(all, cfg), due = noticeDue(cfg);
    if (won || due) { // your own lease: tell the landlord in time
      const b = statusBtn("I've given notice", () => { ui.applyCfg({ ...cfg, noticeGiven: ymdLocal(new Date()) }); if (!cache) renderShortlist(); setStatus('Noted: notice given. The calendar export takes its reminder out.'); slFocus(); }, { once: true }); // the button goes with the redraw: focus somewhere that stays
      const addr = won ? String(won.r.address || 'a listing').split(',')[0] : '';
      const notice = due ? (due.days < 0 ? `Your notice date (${shortDate(due.by)}) has passed.` : `Give notice by ${shortDate(due.by)}${due.days ? ` (${plural(due.days, 'day')})` : ' (today)'} for your lease ending ${shortDate(cfg.leaseEnd)}.`)
        : won?.by ? `Give notice by ${shortDate(won.by)}.` : won?.days ? `Give ${won.days} days' notice when you're ready.` : won ? 'Set your notice period in Settings for its date.' : '';
      const toSet = won && !won.by && !won.days && !due ? statusBtn('Open Settings', () => openSetting(cfg.leaseEnd || cfg.periodic ? 'noticeDays' : 'leaseEnd')) : null; // a periodic lease has no end to set
      ui.status.append(` ${won ? `Approved for ${addr}. ` : ''}${notice}${won?.pending ? ` ${plural(won.pending, 'other application')} still waiting.` : ''} `, ...(toSet ? [toSet, ' '] : []), b);
    }
  }

  // Above the Shortlist: your application pack while you're applying, your moving list once approved.
  function renderTicks(all) {
    const plan = movePlan(all, cfg), box = ui.slBar.querySelector('.rf-sl-ticks');
    const applying = !plan && all.some((r) => !deadEnd(r) && ['', 'to inspect', 'inspected'].includes(r.appStatus || ''));
    box.hidden = !plan && !applying;
    if (box.hidden) return;
    const chips = (items, done, attr, label) => `<div class="rf-checks" role="group" aria-label="${label}">${items.map((i) => {
      const on = done.includes(i);
      return `<button type="button" class="rf-chip" ${attr}="${esc(i)}" aria-pressed="${on}">${on ? '✓ ' : ''}${esc(i)}</button>`;
    }).join('')}</div>`;
    const { items, done } = plan || packState(cfg, packPortals(all));
    const head = plan ? `Moving list ${done.length}/${items.length}${plan.next ? ` · next: ${plan.next}` : ''}${plan.moveDate ? ` · moving ${shortDate(plan.moveDate)}` : ''}` : packLabel(cfg, packPortals(all)).replace(/^Pack:/, 'Application pack:');
    const open = ui.ticksOpen ?? false;
    const owed = plan ? owedLabel(plan) : '';
    box.innerHTML = `<details${open ? ' open' : ''}><summary>${esc(head)}</summary>${owed ? `<div class="rf-meta">${esc(owed)}</div>` : ''}${plan ? chips(items, done, 'data-mv', 'Moving list') : chips(items, done, 'data-pack', 'Application pack')}<button type="button" class="rf-undo" data-edit-list="${plan ? 'movingList' : 'packList'}">Edit this list</button></details>`
      + (plan ? `<details class="rf-ecr"${ui.ecrOpen ? ' open' : ''}><summary>${esc(`Condition report ${plan.roomsDone.length}/${plan.rooms.length}${plan.ecrBy ? ` · due ${shortDate(plan.ecrBy)}` : ''}`)}</summary><div class="rf-meta">Tick each room once it's checked and photographed.</div>${chips(plan.rooms, plan.roomsDone, 'data-ecr', 'Condition report rooms')}<button type="button" class="rf-undo" data-ecr-print>Print the checklist</button></details>` : '');
    box.firstChild.addEventListener('toggle', (e) => { ui.ticksOpen = e.currentTarget.open; });
    box.querySelector('.rf-ecr')?.addEventListener('toggle', (e) => { ui.ecrOpen = e.currentTarget.open; });
  }
  function wireTicks() {
    ui.slBar.querySelector('.rf-sl-ticks').addEventListener('click', (e) => {
      const ed = e.target.closest('[data-edit-list]');
      if (ed) return openSetting(ed.dataset.editList);
      const plan0 = e.target.closest('[data-ecr],[data-ecr-print]') ? movePlan(marks.shortlist(), cfg) : null;
      if (plan0 && e.target.closest('[data-ecr-print]')) return printDoc(ecrPrintHtml(plan0));
      const room = e.target.closest('[data-ecr]')?.dataset.ecr;
      if (plan0 && room != null) {
        ui.ecrOpen = true;
        ui.applyCfg({ ...cfg, ecrDone: ecrToggle(plan0, room) });
        if (!cache) renderShortlist();
        return ui.slBar.querySelector(attrSel('data-ecr', room))?.focus();
      }
      const b = e.target.closest('[data-pack],[data-mv]');
      if (!b) return;
      const pack = b.dataset.pack != null, item = pack ? b.dataset.pack : b.dataset.mv;
      const plan = pack ? null : movePlan(marks.shortlist(), cfg);
      if (!pack && !plan) return;
      ui.ticksOpen = true; // before the redraw applyCfg makes
      ui.applyCfg(pack ? { ...cfg, packDone: packToggle(cfg, item, packPortals(marks.shortlist())) } : { ...cfg, moveDone: moveToggle(cfg, plan, item) });
      if (!cache) renderShortlist(); // with results, applying the settings has redrawn the Shortlist already
      ui.slBar.querySelector(attrSel(pack ? 'data-pack' : 'data-mv', item))?.focus();
    });
  }

  const updateCounts = () => {
    if (ui.launch) setLaunchCount(ui.launchN ?? null);
    const ags = marks.hiddenAgencies();
    const sbs = marks.hiddenSuburbs();
    const box = ui.panel.querySelector('.rf-agencies');
    box.hidden = !ags.length && !sbs.length;
    setHtml(box.querySelector('.rf-ag-list'), ags.map((a) =>
      `<button type="button" class="rf-chip" data-unhide-ag="${esc(a)}" aria-label="Show ${esc(a)} again">${esc(a)} ×</button>`).join('') +
      sbs.map((a) => `<button type="button" class="rf-chip" data-unhide-sb="${esc(a)}" aria-label="Show suburb ${esc(a)} again">${esc(a)} (suburb) ×</button>`).join(''));
    const c = marks.counts();
    for (const [el, t] of [[ui.slCount, `(${c.starred})`], ...(ui.countEls ||= [...ui.panel.querySelectorAll('[data-count]')]).map((el) => [el, `(${c[el.dataset.count]})`])]) if (el.textContent !== t) el.textContent = t;
  };
  // innerHTML only when the markup is new: a redraw that changes nothing keeps the nodes (and focus).
  const setHtml = (el, html) => { if (el._html !== html || el.childNodes.length !== el._n) { el.innerHTML = html; el._html = html; el._n = el.childNodes.length; } };

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
    // `refocus`: Enter / Esc go back to the listing's Note button (the editor is gone).
    const finish = (save, refocus = false) => {
      if (done) return;
      done = true;
      if (save) marks.setNote(id, ta.value);
      ta.remove(); // the keyed paint keeps an unchanged item's node, so the editor goes here
      if (item._rf) item._rf = { ...item._rf, html: '' }; // and the item is drawn again (its note line)
      refreshMarks(touched(id));
      if (refocus) (itemEl(id, '[data-act=n]') || ui.list).focus();
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); finish(false, true); }
      else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true, true); }
    });
    // A task later: a blur from a redraw in progress (another tab's change) mustn't redraw inside it.
    // Saved at once; the redraw waits for a press under way (a click on this listing's Shortlist).
    ta.addEventListener('blur', () => setTimeout(() => {
      if (!done) marks.setNote(id, ta.value);
      // What the press said (Hidden + Undo, Rated…) outlives the redraw that closes the note.
      const said = ui.status.textContent;
      (ui.afterPress || ((fn) => fn()))(() => (ui.status.textContent !== said ? keepingStatus(() => finish(true)) : finish(true)));
    }, 0));
  }

  // `only`: the listings whose marks changed, when nothing else on screen can (a star, rating,
  // checklist tick): the list then rebuilds just those, if its order is unchanged.
  // A listing and those whose markup names it: the same building ("N in this building") and the
  // same place listed twice ("Also listed by…").
  // What one listing's change redraws on Results: a star, a note or a hide reason only its own
  // listing (unless a filter drops it); a hide, its own and its building's ("N in this building");
  // a star with an application status, the agency's record on its other listings too, so all.
  // On the Shortlist a change touches others (the agency record, the pack's portals): all redraw.
  const touched = (id, act = '') => (ui.view === 'shortlist' ? null : act === 'h' ? withMates(id) : act === 's' ? (rowById(id)?.appStatus ? null : [id]) : act ? null : [id]);
  const withMates = (id) => {
    const a = rowById(id)?.address, k = buildingKey(a), ak = addressKey(a);
    return cache && (k || ak) ? [id, ...cache.filter((r) => r.id !== id && ((k && buildingKey(r.address) === k) || (ak && addressKey(r.address) === ak))).map((r) => r.id)] : [id];
  };
  function refreshMarks(only = null) {
    ui.onlyIds = only ? new Set(only) : null;
    mirrorSoon();
    ui.paintStorage?.();
    marks.decorate([...known.values()]); // cache rows are mostly these same objects (learn)
    if (cache) marks.decorate(cache.filter((r) => known.get(r.id) !== r));
    if (gone.length) marks.decorate(gone);
    if (cache) withBuildings(cache); // hiding one changes "N in this building"
    knownVer++;
    updateCounts();
    inPlace(() => { if (ui.view === 'shortlist') renderShortlist(); else if (cache) showResults(); });
    ui.onlyIds = null;
    scheduleAnnotate();
  }
  // Redraw without moving: as many listings as were showing, in one pass, at the same scroll.
  function inPlace(fn) {
    const scroller = listScroller(), top = scroller.scrollTop;
    ui.keepShown = listItems().length;
    try { fn(); } finally { ui.keepShown = 0; scroller.scrollTop = top; }
  }

  // After a hide: Undo plus one-tap reasons, so "why did I rule this out?" has an answer later.
  // Hidden from REA's card with the drawer closed: the drawer's status line can't be seen, so
  // Undo and the reasons go in a small note by the launcher for a few seconds.
  const TOAST_MS = 10000;
  function toastHideUndo(id, undo) {
    document.getElementById('rf-toast')?.remove();
    const t = Object.assign(document.createElement('div'), { id: 'rf-toast' });
    t.setAttribute('role', 'status');
    t.innerHTML = `<span>Listing hidden.</span><button type="button" data-t="undo">Undo</button><span>Why?</span>${HIDE_REASONS.map((r) => `<button type="button" data-t="why" data-r="${esc(r)}">${esc(reasonLabel(r))}</button>`).join('')}`;
    // Paused while the pointer or keyboard focus is on it (WCAG 2.2.1).
    let timer = setTimeout(() => t.remove(), TOAST_MS);
    const hold = () => clearTimeout(timer);
    const resume = () => { clearTimeout(timer); if (!t.matches(':hover') && !t.contains(document.activeElement)) timer = setTimeout(() => t.remove(), TOAST_MS / 2); };
    t.addEventListener('mouseenter', hold);
    t.addEventListener('focusin', hold);
    t.addEventListener('mouseleave', resume);
    t.addEventListener('focusout', () => setTimeout(resume, 0));
    t.addEventListener('click', (e) => {
      const b = e.target.closest('[data-t]');
      if (!b) return;
      if (b.dataset.t === 'undo') undo();
      else { marks.setHideReason(id, b.dataset.r); mirrorSoon(); if (cache) marks.decorate(cache); }
      const had = t.contains(document.activeElement);
      clearTimeout(timer);
      t.remove();
      if (had && !ui.launch.hidden) ui.launch.focus(); // not lost to <body>
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
      // No re-render: the listing is hidden, and re-rendering would replace this status line.
      const b = statusBtn(reasonLabel(reason), () => { marks.setHideReason(id, reason); mirrorSoon(); if (cache) marks.decorate(cache); why.replaceChildren(` Noted: ${reason}.`); }, { once: true });
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

  // A link-styled button for the status line (class rf-undo), wired to `onClick`.
  function statusBtn(text, onClick, opts, cls = '') {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: `rf-undo ${cls}`.trim(), textContent: text });
    b.addEventListener('click', onClick, opts);
    return b;
  }
  // One-shot Undo link in the status line.
  function offerUndo(msg, undo, cls = '') {
    setStatus(msg);
    const b = statusBtn('Undo', () => { b.remove(); undo(); }, { once: true }, cls);
    b.dataset.undo = '1'; // what keepingUndo and the u key look for (other status buttons share the look)
    ui.status.append(' ', b); // space: screen readers read "hidden. Undo", not "hidden.Undo"
    ui.undoAt = Date.now();
  }
  // Another tab's write redraws this one: an Undo offered in the last UNDO_KEEP_MS stays put
  // (with its hide reasons) instead of turning into "N of M match".
  const UNDO_KEEP_MS = 30000;
  // Keeps whatever the status line says now through `fn` (and focus on it).
  const keepingStatus = (fn) => {
    const keep = [...ui.status.childNodes], err = ui.status.classList.contains('err'), had = ui.status.contains(document.activeElement) ? document.activeElement : null;
    fn();
    ui.status.replaceChildren(...keep); ui.status.classList.toggle('err', err);
    if (had && document.activeElement !== had) had.focus({ preventScroll: true });
  };
  const keepingUndo = (fn) => {
    const keep = ui.status.querySelector('[data-undo]') && Date.now() - (ui.undoAt || 0) < UNDO_KEEP_MS ? [...ui.status.childNodes] : null;
    const err = ui.status.classList.contains('err'), had = keep && ui.status.contains(document.activeElement) ? document.activeElement : null;
    fn();
    if (keep) { ui.status.replaceChildren(...keep); ui.status.classList.toggle('err', err); }
    if (had && document.activeElement !== had) had.focus({ preventScroll: true }); // the same node, put back: so is focus
  };

  // Before there's anything to act on, these aren't shown at all (a row of greyed-out buttons on
  // first open said little); the Shortlist's own export menu is separate.
  const setExport = (disabled) => {
    const f = document.activeElement; // before disabling it moves focus to the page
    for (const b of ui.exports) b.disabled = disabled;
    ui.bulk.disabled = disabled; ui.market.disabled = disabled; ui.map.disabled = disabled;
    ui.panel.querySelector('.rf-controls .rf-exports').hidden = disabled && !cache && ui.view !== 'shortlist';
    for (const el of [ui.bulk, ui.market, ui.map]) el.hidden = disabled && !cache; // nothing searched yet: hidden; an empty result: disabled, in place
    // Disabling the focused control (Bulk hid every listing) would drop focus to the page.
    if (disabled && f && f !== document.activeElement && ui.panel.contains(f) && (f.disabled || f.hidden)) (ui.status.querySelector('[data-undo]') || ui.status).focus({ preventScroll: true });
  };

  // Data-format warnings sit in their own banner, so the status line keeps "N of M match".
  const warnings = {};
  // On <html> so the launcher, notes and listing bar follow it too (a data-rf-* attribute only).
  const applyTheme = () => {
    const root = document.documentElement;
    if (cfg.theme === 'light' || cfg.theme === 'dark') root.dataset.rfTheme = cfg.theme; else delete root.dataset.rfTheme;
    ui?.paintThemeBtn?.();
  };
  const setWarn = (kind, msg) => {
    if (msg) warnings[kind] = msg; else delete warnings[kind];
    const text = Object.values(warnings).join(' ');
    ui.warnbar.hidden = !text || ui.warnDismissed === text;
    ui.warnbar.querySelector('.rf-report').hidden = !(warnings.drift || warnings.cards || warnings.schema || warnings.format || warnings.errors);
    ui.warnbar.querySelector('.rf-warn-msg').textContent = text;
  };
  const setStatus = (msg, isErr) => {
    ui.status.textContent = msg;
    ui.status.classList.toggle('err', !!isErr);
  };

  function showResults(note = '') {
    if (ui.view === 'shortlist') return renderShortlist(); // its fit, cash and nudges follow the settings too
    const err = cfgError(cfg);
    // Drawer closed (a star on REA's card, another tab's change, the restore at load): only the
    // launcher's count is seen, so the list is drawn when the drawer opens (setOpen).
    if (ui.panel.hidden) { ui.rows = err ? [] : applyFilters(pool(), cfg); setLaunchCount(ui.rows.length); ui.listStale = note || ui.listStale || true; return; }
    if (err) { render([]); return setStatus(err, true); }
    const rows = applyFilters(pool(), cfg);
    render(rows);
    ui.fold?.(ui.panel.querySelector('.rf-controls').classList.contains('rf-folded')); // keep its count and sort current
    renderActive();
    if (!rows.length) suggestDrops();
    // To the top of the new list once the chips and status above it are drawn (one layout, measured
    // right); a redraw in place (refreshMarks) keeps the scroll.
    const top = () => { if (rows.length && !ui.keepShown) toListTop(); };
    if (crawl?.id === runId) { setStatus(partialStatus()); return top(); } // still reading: not "N of M match" until every page is in
    const st = diffStats(cache);
    const matchHint = (cfg.sort === 'match' && !rows.some((r) => r.score != null)
      ? ' Best match needs two of: a max rent (or enough listings for a median), a "from" date, a distance point, known bonds.' : '')
      + (textClipped && cfg.keyword.trim() ? (textClipped === 'lite'
        ? ' Keywords searched the saved text, which is left out for listings further down in a search this big; Refresh to search full descriptions.'
        : ' Keywords searched the saved (shortened) text; Refresh to search full descriptions.') : '');
    const since = baseAt ? ` since ${ago(Date.now() - baseAt)}` : '';
    const extra = [st.fresh && `${st.fresh} new${since}`, gone.length && `${gone.length} no longer listed`, st.moved && `${st.moved} price changed`, st.redated && `${st.redated} date changed`, st.featured && `${st.featured} details changed`,
      !cfg.showHidden && st.hidden && `${st.hidden} hidden`, st.cheaperHidden && `${st.cheaperHidden} hidden now cheaper`, st.reviewed && `reviewed ${st.reviewed} of ${st.total}`].filter(Boolean).join(' · ');
    setStatus(`${rows.length} of ${cache.length} listings match.${extra ? ` ${extra}.` : ''}` +
      (truncated ? ` Only the first ${MAX_PAGES} pages were read - narrow the search for full coverage.` : '') +
      (note ? ` ${note}` : '') + matchHint);
    const warn = schemaWarnings(cache);
    setWarn('schema', warn.length ? `REA's data format may have changed (${warn.join('; ')}). Copy report, then paste it into an issue on the script's GitHub page.` : '');
    top();
  }

  // Nothing matches: offer the filters whose removal brings back the most listings.
  function suggestDrops() {
    const top = (ui.activeChips || []).map((c, i) => ({ c, i })).filter((x) => x.c.removes > 0).sort((a, b) => b.c.removes - a.c.removes).slice(0, 3);
    if (!top.length) return;
    setEmpty(`Nothing matches those filters. Try dropping one:<br>${top.map(({ c, i }) =>
      `<button type="button" class="rf-chip" data-drop-chip="${i}">${esc(c.label)} <span>+${c.removes}</span></button>`).join(' ')}`);
  }

  // REA's own filters for this search (docs/REA-SEARCH-URLS.md): marked where REA leaves out
  // listings your filters here would keep, and a way to put yours on REA's search instead.
  function paintRea() {
    const f = reaFiltersOf(location.href), chips = reaChips(f, cfg);
    const to = f ? reaUrlFor(location.href, cfg) : null;
    ui.reaTo = to && !sameReaSearch(to, location.href) ? to : null;
    ui.reaApply.hidden = !ui.reaTo;
    ui.reaBox.hidden = !chips.length && !ui.reaTo;
    setHtml(ui.reaBox.querySelector('.rf-rea-chips'), chips.length ? chips.map((c) => (c.narrower
      ? `<span class="rf-rea-chip rf-rea-narrow" title="REA leaves out listings your filters here would keep">${esc(c.label)}<span class="rf-sr"> (leaves out listings your filters keep)</span></span>`
      : `<span class="rf-rea-chip">${esc(c.label)}</span>`)).join('') : '<span class="rf-rea-chip">none</span>');
  }

  // Chips for active filters with how many listings each removes; click to drop that filter.
  function renderActive() {
    const chips = cache ? removedBy(pool(), cfg) : [];
    ui.active.hidden = !chips.length || ui.view === 'shortlist';
    setHtml(ui.active, chips.map((c, i) => `<button type="button" class="rf-chip rf-achip" data-chip="${i}"${c.key === 'sizeMin' ? ` title="${esc(SQM_NOTE)}"` : ''}
      aria-label="Remove filter ${esc(c.label)}${c.removes > 0 ? `, hiding ${c.removes}` : ''}">${esc(c.label)}${c.removes > 0 ? ` <span>−${c.removes}</span>` : ''} ×</button>`).join(''));
    ui.activeChips = chips;
    const inMore = chips.filter((c) => MORE_KEYS.includes(c.key)).length; // not the dates or suburbs above it
    ui.moreSummary.textContent = `More filters${inMore ? ` (${inMore} active)` : ''}`;
  }

  // Bulk menus say how many listings they will touch.
  const labelBulk = (sel, n) => { for (const o of sel.options) if (o.value) { const t = o.dataset.label.replace('{n}', n); if (o.textContent !== t) o.textContent = t; } };

  // #endregion
  // #region list
  function render(rows) {
    ui.rows = rows; // first: renderMore()/refreshMarks() read it even when the list is empty
    if (ui.view !== 'shortlist') ui.agencyRec = agencyRecord(marks.shortlist()); // your record per agency, on Results too
    labelBulk(ui.bulk, rows.length);
    setExport(rows.length === 0);
    setLaunchCount(rows.length);
    if (!rows.length) return setEmpty('Nothing matches those filters.');
    if (ui.mapOn) { const h = mapHtml(rows, cfg); if (h !== ui.mapDrawn || !ui.list.querySelector(':scope > .rf-map')) { ui.list.innerHTML = h; ui.mapDrawn = h; } } // the same map: kept (and its focus)
    else if (ui.marketOn) ui.list.innerHTML = marketHtml(marketStats(rows), cfg.remember ? trendText(snaps.exportData()[currentKey()]?.trend) : '', { records: agencyRecord(marks.shortlist()), hiddenAg: new Set(marks.hiddenAgencies().map(agencyKey)) }); else paintList(rows);
  }

  // Drawer renders in chunks: 500 cards at once is a ~80ms long task on every filter change.
  const moreHtml = (left) => (left > 0 ? `<button class="rf-btn sec rf-more-btn">Show ${Math.min(left, RENDER_CHUNK)} more (${left} left)</button>` : '');
  // First chunk (or as many as were showing, on a re-render) plus the "Show more" button.
  // Same listings in the same order as on screen (a shortlist/hide/note/status click, most
  // re-renders): only the items whose markup changed are swapped, so the rest keep their nodes
  // (and focus). Anything else, or most items changed, is one innerHTML.
  // A redraw that swaps or moves the focused listing (another tab's change, a reorder) would drop
  // focus to the page: put it back on the same control in the new node.
  const FOCUS_KEYS = ['act', 'v', 'r', 'ck', 'qa', 'app', 'cmp'];
  const paintList = (rows) => {
    const a = document.activeElement, it = a && ui.list.contains(a) ? a.closest('.rf-item') : null;
    const sel = it && a !== it ? [...FOCUS_KEYS].filter((k) => a.dataset[k] != null).map((k) => `[data-${k}="${CSS.escape(a.dataset[k])}"]`).join('') : '';
    const opened = it ? [...it.querySelectorAll('details[open]')].filter((d) => d.contains(a) && !d.matches('.rf-acts-more')).map((d) => d.className).filter(Boolean) : []; // only the one focus is in (the ⋯ menu closes after its action): others fold as drawn
    paintRows(rows);
    if (!it || document.activeElement === a && a.isConnected) return;
    const id = it.dataset.id, el = itemEl(id);
    // A folded part it was in (the checklist's "more") is opened again first, so it can take focus.
    for (const c of opened) { const d = el?.querySelector(`details.${CSS.escape(c.split(' ')[0])}`); if (d) d.open = true; }
    const to = (sel && itemEl(id, sel)) || el;
    to?.focus({ preventScroll: true });
    if (to && document.activeElement !== to) el?.focus({ preventScroll: true });
  };
  const paintRows = (rows) => {
    const n = Math.max(RENDER_CHUNK, ui.keepShown || 0);
    const els = listItems();
    const only = ui.onlyIds;
    if (only && els.length === Math.min(n, rows.length) && rows.length === ui.lastPaintTotal && [...els].every((el, i) => el._rf?.id === rows[i].id)) {
      els.forEach((el, i) => {
        if (!only.has(rows[i].id)) return;
        const [p] = itemParts([rows[i]]);
        if (el._rf.html === p.html) return;
        const tpl = document.createElement('template');
        tpl.innerHTML = p.html;
        tpl.content.firstElementChild._rf = p;
        el.replaceWith(tpl.content.firstElementChild);
      });
      return numberItems(rows.length);
    }
    // Only these changed and some left the list (a hide): drop their nodes, redraw the rest of
    // them, and top up from below, instead of rebuilding every listing's markup.
    if (only && els.length && rows.length < (ui.lastPaintTotal ?? -1) && ui.lastPaintTotal - rows.length <= only.size) {
      const at = new Map(rows.map((r, i) => [r.id, i]));
      const stay = [...els].filter((el) => at.has(el._rf?.id));
      if (stay.length >= els.length - only.size && stay.every((el, i) => at.get(el._rf.id) === i)) {
        ui.lastPaintTotal = rows.length;
        for (const el of els) if (!at.has(el._rf?.id)) el.remove();
        for (const el of stay) {
          const r = rows[at.get(el._rf.id)];
          if (!only.has(r.id)) continue;
          const [p] = itemParts([r]);
          if (el._rf.html === p.html) continue;
          const tpl = document.createElement('template');
          tpl.innerHTML = p.html;
          tpl.content.firstElementChild._rf = p;
          el.replaceWith(tpl.content.firstElementChild);
        }
        moreBtn()?.remove();
        const add = itemParts(rows.slice(stay.length, n));
        ui.list.insertAdjacentHTML('beforeend', add.map((p) => p.html).join('') + moreHtml(rows.length - Math.min(n, rows.length)));
        const all = listItems();
        add.forEach((p, i) => { const el = all[stay.length + i]; if (el) el._rf = p; });
        return numberItems(rows.length);
      }
    }
    ui.lastPaintTotal = rows.length;
    const parts = itemParts(rows.slice(0, n));
    // Keyed: an item whose markup is unchanged keeps its node wherever it moved (a hide drops one
    // node instead of redrawing everything below it). Mostly new markup is one innerHTML.
    const byId = new Map([...els].map((el) => [el._rf?.id, el]));
    const kept = parts.filter((p) => byId.get(p.id)?._rf.html === p.html).length;
    if (kept < parts.length / 2) {
      ui.list.innerHTML = parts.map((p) => p.html).join('') + moreHtml(rows.length - n);
      listItems().forEach((el, i) => { el._rf = parts[i]; });
      return numberItems(rows.length);
    }
    moreBtn()?.remove();
    // Gone ones out and changed ones swapped where they stand first, so the walk below moves
    // nothing when the order is unchanged (moving a node would blur what's focused in it).
    const tpl = document.createElement('template');
    const want = new Set(parts.map((p) => p.id)), node = new Map();
    for (const [id, el] of byId) if (!want.has(id)) el.remove();
    for (const p of parts) {
      const old = byId.get(p.id);
      if (old && old._rf.html === p.html) { node.set(p.id, old); continue; }
      tpl.innerHTML = p.html;
      const el = tpl.content.firstElementChild;
      el._rf = p;
      if (old) old.replaceWith(el);
      node.set(p.id, el);
    }
    // Only the nodes outside the longest run already in order move: one listing going down the
    // list (a What's next reorder) moves that node, not every node it passes.
    const pos = new Map([...ui.list.children].map((el, i) => [el, i]));
    const stay = inOrder(parts.map((p) => pos.get(node.get(p.id)) ?? -1));
    let at = ui.list.firstElementChild;
    parts.forEach((p, i) => {
      const el = node.get(p.id);
      if (el === at) at = at.nextElementSibling;
      else if (stay.has(i)) at = el.nextElementSibling; // what's between moves later
      else ui.list.insertBefore(el, at);
    });
    numberItems(rows.length);
    ui.list.insertAdjacentHTML('beforeend', moreHtml(rows.length - n));
  };
  // The list's items and its "more" button are its direct children (the button last): walking the
  // children beats a selector query over every listing's subtree on each click.
  const listItems = () => { const out = []; for (const el of ui.list.children) if (el.classList.contains('rf-item')) out.push(el); return out; };
  const moreBtn = () => { const el = ui.list.lastElementChild; return el?.classList.contains('rf-more-btn') ? el : null; };
  // Position in the list is set here, after the markup lands, so an item's markup doesn't change
  // when one above it goes (and the keyed paint can keep its node).
  // `from`: items above it are already numbered for this total (a chunk added below them).
  const numberItems = (total, from = 0) => listItems().forEach((el, i) => {
    if (i < from) return;
    const pos = String(i + 1), set = String(total);
    if (el.getAttribute('aria-posinset') !== pos) el.setAttribute('aria-posinset', pos);
    if (el.getAttribute('aria-setsize') !== set) el.setAttribute('aria-setsize', set);
    const old = el.getAttribute('aria-label') || '', lab = old.replace(/^\d+ of \d+: /, `${pos} of ${set}: `);
    if (old !== lab) el.setAttribute('aria-label', lab);
  });
  function renderMore() {
    const shown = listItems().length;
    moreBtn()?.remove();
    const parts = itemParts(ui.rows.slice(shown, shown + RENDER_CHUNK));
    ui.list.insertAdjacentHTML('beforeend', parts.map((p) => p.html).join('') + moreHtml(ui.rows.length - shown - RENDER_CHUNK));
    const els = listItems();
    parts.forEach((p, i) => { if (els[shown + i]) els[shown + i]._rf = p; });
    numberItems(ui.rows.length, ui.lastPaintTotal === ui.rows.length ? shown : 0);
  }

  // Money facts in one line: move-in (bond flag), lease overlap/gap, vs your rent now, share of income, vs median.
  function moneyLine(r, inc, med) {
    const parts = [
      Number.isFinite(r.upfront) ? `Move-in ${money(r.upfront)}${r.bondWeeks > BOND_CAP_WEEKS ? ` <span class="rf-warn" title="Bond above ${BOND_CAP_WEEKS} weeks' rent; check your state's cap">bond ${r.bondWeeks} wks</span>` : ''}` : '',
      r.fit ? `<span title="Against your current lease end (Settings)"${r.fit.gap ? ' class="rf-warn"' : ''}>${esc(fitLabel(r.fit))}</span>` : '',
      vsNow(r) != null ? `<span${vsNow(r) > 0 ? ' class="rf-warn-t"' : ''}>${esc(vsNowLabel(r))}</span>` : '',
      inc != null ? `<span${inc > RENT_STRESS_PCT ? ' class="rf-warn-t"' : ''}>${inc}% of income</span>` : '',
      med ? `<span class="rf-med ${r.vsMedian < 0 ? 'down' : r.vsMedian > 0 ? 'up' : ''}">${esc(med)}</span>` : '',
    ].filter(Boolean);
    return parts.length ? `<div class="rf-meta">${parts.join(' · ')}</div>` : '';
  }

  // A shortlisted listing's checklist folds away until it matters: open around an inspection, once
  // ticked, or when you opened it (kept across redraws).
  const ckOpen = (r) => (ui.ckOpen?.has(r.id) ? ui.ckOpen.get(r.id) : r.appStatus === 'to inspect' || r.appStatus === 'inspected' || !!(r.checks && Object.keys(r.checks).length));
  // Tags are labels, or [label, why, id, quote, class] (a class marks a heads-up the agent answered).
  const tagsHtml = (tags, cls = '', title = '') => (tags.length ? `<div class="rf-tags${cls}"${title ? ` title="${esc(title)}"` : ''}>${tags.map((t) => (Array.isArray(t)
    ? `<span${t[1] ? ` title="${esc(t[1])}"` : ''}${t[4] ? ` class="${t[4]}"` : ''}>${esc(t[0])}</span>` : `<span>${esc(t)}</span>`)).join('')}</div>` : '');
  // A heads-up the agent has answered: muted and ticked when fine, marked when it's a problem.
  const answeredTags = (wt, r) => wt.map((t) => {
    const a = r.answers?.[`w:${t[2]}`];
    return !a ? t : a === 'y' ? [`✓ ${t[0]}`, 'The agent says this is fine (your answer, under What to ask)', t[2], t[3], 'rf-ok'] : [`✗ ${t[0]}`, 'The agent confirmed this (your answer, under What to ask)', t[2], t[3], 'rf-bad'];
  });
  const metaLine = (parts, cls = '') => { const t = parts.filter(Boolean).join(' · '); return t ? `<div class="rf-meta${cls}">${esc(t)}</div>` : ''; };
  // Markup per listing, without its place in the list (numberItems sets "12 of 150" afterwards).
  // Each agency's price drops over this search, for "Room to negotiate?": worked out once per
  // search and marks version, not on every paint, chunk and one-listing redraw.
  const cacheDrops = () => {
    if (ui.drops?.rows !== cache || ui.drops.ver !== knownVer) ui.drops = { rows: cache, ver: knownVer, m: agencyDrops(cache || []) };
    return ui.drops.m;
  };
  function itemParts(rows) {
    const now = Date.now(), sl = ui.view === 'shortlist', checks = checklistItems(cfg.checklist), drops = sl ? null : cacheDrops();
    return rows.map((r) => ({ id: r.id, html: itemHtml(r) }));
    function itemHtml(r) {
      const kq = cfg.keyword.trim() ? keywordEvidence(r.text, cfg.keyword) : '';
      const name = [r.price, r.address, r.available && r.available !== '-' ? `available ${r.available.replace(/^available\s*/i, '')}` : ''].filter(Boolean).join(', ');
      const { am, wt } = tagItemsOf(r), km = kmLabel(r), pk = placesLabel(r), inc = incomePct(r, cfg.income), med = medianLabel(r);
      const na = sl ? needsAction(r, now) : '', asks = r.starred && sl ? askItems(r, cfg.amenities) : [];
      return `
      <div tabindex="-1" role="article" aria-posinset="0" aria-setsize="0" aria-label="${esc(`0 of 0: ${name}`)}" class="rf-item${r.gone || ruledOut(r) ? ' rf-hidden' : ''}${r.starred ? ' rf-starred' : ''}${sl && r.appStatus === 'approved' ? ' rf-approved' : ''}" data-id="${esc(r.id)}"${r.reviewedAt ? ' data-rv="1"' : ''}>
      <a class="rf-card" href="${esc(r.url)}" target="_blank" rel="noopener" aria-label="${esc(`${name} (opens the listing)`)}">
        ${r.img ? `<img src="${esc(r.img)}" alt="" loading="lazy">` : '<div></div>'}
        <div>
          <div class="rf-avail">${esc(r.available === r.price && !r.avail ? 'Available: ask the agent' : r.available)}${r.prevAvail ? ` <span class="rf-was ${r.availDir === 'later' ? 'up' : 'down'}" title="Availability date changed">was ${esc(r.prevAvail)}</span>` : ''}${r.featChange ? ` <span class="rf-tag" title="The listing's details changed recently">${esc(r.featChange)}</span>` : ''}${r.gone ? `<span class="rf-tag rf-gone"${r.goneAt ? ` title="Found gone ${esc(ago(now - r.goneAt))}"` : ''}>no longer listed</span>` : isFresh(r) ? '<span class="rf-tag rf-new">new</span>' : ''}${r.relisted ? `<span class="rf-tag" title="Same address was listed before${r.relisted.price ? ` at ${esc(r.relisted.price)}` : ''}${r.relisted.hidden ? '; you had hidden it' : ''}">relisted</span>` : ''}${r.surrounding ? '<span class="rf-tag">nearby</span>' : ''}${r.taken ? `<span class="rf-tag rf-taken" title="Going by the listing text">${esc(TAKEN_LABELS[r.taken])}</span>` : ''}${r.cheaperBy ? `<span class="rf-tag rf-new" title="You hid it at a higher rent">$${r.cheaperBy} cheaper since you hid it</span>` : ''}</div>
          <div class="rf-price">${esc(r.price)}${r.type ? ` <span class="rf-type">${esc(r.type)}</span>` : ''}${r.prevPrice ? ` <span class="rf-was ${priceDir(r)}" title="${esc(historyText(r))}">was ${esc(r.prevPrice)}</span>` : ''}</div>
          <div class="rf-addr">${esc(r.address)}</div>
          ${metaLine([r.beds !== '' ? `${r.beds} bed` : '', r.baths !== '' ? `${r.baths} bath` : '', r.cars !== '' ? `${r.cars} car` : '', sqmLabel(r), r.bond ? `bond ${bondLabel(r)}` : '', ppbLabel(r)])}
          ${km || pk || r.score != null ? `<div class="rf-meta">${esc([km, pk].filter(Boolean).join(' · '))}${r.score != null ? `${km || pk ? ' · ' : ''}<span class="rf-score" title="${esc(r.scoreWhy)}">Match ${r.score}</span>` : ''}</div>` : ''}
          ${metaLine([r.agency, r.agency ? recordText(ui.agencyRec?.get(agencyKey(r.agency))) : '', r.photos != null ? plural(r.photos, 'photo') : '', r.floorplan ? 'floorplan' : ''], ' rf-sec')}
          ${tagsHtml([...am, r.lease ? leaseText(r.lease) : '', r.applyVia ? `Apply: ${r.applyVia}` : '', applyByLabel(r.applyBy)].filter(Boolean), ' rf-sec')}
          ${tagsHtml(answeredTags(wt, r), ' rf-watch rf-sec', 'Mentioned in the listing text: worth asking the agent')}
          ${kq ? `<div class="rf-meta rf-sec rf-kwq">matched: ${esc(kq)}</div>` : ''}
          ${moneyLine(r, inc, med)}${metaLine([negotiateFacts(r, drops, now)])}
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
      ${na === 'applyby' ? `<div class="rf-nudge">Applications close ${esc(applyByLabel(r.applyBy).replace(/^Apply by /, ''))}: apply? ${esc(applyReady(r, cfg, ui.portals || []))}. <button type="button" class="rf-chip" data-na="applied">Mark applied</button></div>` : ''}
      ${na === 'apply' ? `<div class="rf-nudge">Inspected ${esc(ago(now - r.appAt))}: apply? <button type="button" class="rf-chip" data-na="applied">Mark applied</button></div>` : ''}
      ${r.starred && sl ? `<details class="rf-ck-more"${ckOpen(r) ? ' open' : ''}><summary>Checklist ${checks.filter((k) => own(r.checks, k)).length}/${checks.length}${asks.length ? ` · Asked ${asks.filter((x) => x.a).length}/${asks.length}` : ''}</summary><div class="rf-checks" role="group" aria-label="Inspection checklist">${checks.map((k) => checkBtn(k, own(r.checks, k), 'class="rf-chip"')).join('')}</div>${asks.length ? `<div class="rf-checks rf-asks" role="group" aria-label="What to ask the agent (tap once the agent answers: fine, then a problem)">${asks.map((x) => qaBtn(x, 'class="rf-chip"')).join('')}</div>` : ''}</details>` : ''}
      ${r.starred && sl ? `<div class="rf-app"><span class="rf-meta" aria-hidden="true">My rating</span> ${ratingHtml(r, 'data-act="rate"')}</div>` : ''}
      ${r.starred ? `<label class="rf-app">Application <select data-app aria-label="Application status">${statusOptions(r.appStatus)}</select>${r.appAt ? ` <span class="rf-meta">${esc(ago(now - r.appAt))}</span>` : ''}${needsFollowUp(r) ? ' <span class="rf-warn-t">follow up?</span>' : ''}</label>` : ''}
      ${sl && r.appStatus === 'declined' ? `<div class="rf-acts rf-why"><span class="rf-meta">Why declined? (optional)</span>${DECLINE_REASONS.map((x) => `<button data-act="dr" data-r="${x}" aria-pressed="${r.declineReason === x}">${reasonLabel(x)}</button>`).join('')}</div>` : ''}
      ${r.note ? `<div class="rf-note">${esc(r.note)}</div>` : ''}
      <div class="rf-acts">
        <button data-act="s" aria-pressed="${r.starred}" title="${r.starred ? 'Remove from shortlist' : 'Add to shortlist'}">${r.starred ? '★ Shortlisted' : '☆ Shortlist'}</button>
        <button data-act="h" title="${r.resurfaced ? 'Still not for you at this price: hide again' : r.hidden ? 'Unhide' : 'Hide this listing'}">${hideWord(r)}</button>
        <button data-act="n" title="${r.note ? 'Edit note' : 'Add a note'}" aria-label="${r.note ? 'Edit note' : 'Add note'}">Note</button>
        <button data-act="copy" title="Copy a text summary of this listing">Copy details</button>
        ${sl ? `<label class="rf-cmp"><input type="checkbox" data-cmp="${esc(r.id)}"${ui.cmpSel?.has(r.id) ? ' checked' : ''}>Compare</label>` : ''}
        ${`<details class="rf-acts-more"><summary aria-label="More actions" title="More actions">⋯</summary><div>
          <button data-act="enq" title="Copy an enquiry message for the agent (template in Settings)">Copy enquiry</button>
          ${r.byAppt ? '<button data-act="viewing" title="Inspections are by appointment: copy a request for a viewing, with your inspection times">Ask for a viewing</button>' : ''}
          ${am.some((t) => t[1]) || wt.some((t) => t[1]) ? '<button data-act="whytags" aria-expanded="false">Why these tags?</button>' : ''}
          ${am.some((t) => t[3]) || wt.some((t) => t[3]) ? '<button data-act="case" title="A wrong tag? Copy the phrases each tag was read from, in the unit-test table format, for a bug report or a fix">Report a wrong tag…</button>' : ''}
          ${r.hidden ? `<span class="rf-meta">Why hidden?</span>${HIDE_REASONS.map((x) => `<button data-act="why" data-r="${x}" aria-pressed="${r.hideReason === x}">${reasonLabel(x)}</button>`).join('')}` : ''}
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
    mirrorSoon(); // called after every preset save and delete (and restores): the copy carries them
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
    get() { const v = prevKey.getJson(); return isObj(v) ? sanitizeCfg(v) : null; },
    set: (v) => prevKey.setJson(v),
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
  // `clipped`: how short the rows' text is (restore() passes the snapshot's: 'lite' when trimmed to fit).
  function adopt(key, rows, trunc, note, snap = null, observe = false, clipped = !observe) {
    textClipped = clipped; // before the first render reads it
    learn(rows, observe, observe); // adopt observes only fresh full crawls
    // A task later, not a microtask: reading the list writes a deferred snapshot save (snaps.save's
    // `later`), which would then land in this task after all instead of after the results paint.
    if (snap) setTimeout(renderSaved, 0);
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
    ui.fold?.(true); // on a phone, the results start at the top instead of under the controls
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
    adopt(key, snap.rows, snap.truncated, `Saved ${ago(Date.now() - snap.at)}. Refresh for current listings.`, snap, false, snap.lite ? 'lite' : true);
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
  const readPlaces = () => { const p = placeKey.getJson(); return isObj(p) ? p : {}; };
  let placeTimer = null;
  function notePlace() {
    clearTimeout(placeTimer);
    placeTimer = setTimeout(() => {
      const slot = placeSlot();
      if (!slot || ui.forgetting || ui.panel.hidden || (ui.view === 'shortlist' && (ui.planDay || ui.compare))) return;
      const items = listItems();
      const cur = document.activeElement?.closest?.('.rf-item');
      const edge = ui.panel.classList.contains('rf-full') ? ui.list.getBoundingClientRect().top : ui.status.getBoundingClientRect().bottom;
      const at = cur && ui.list.contains(cur) ? cur : items.find((el) => el.getBoundingClientRect().bottom > edge + 8);
      const places = readPlaces();
      if (!at || items.indexOf(at) === 0) delete places[slot];
      else places[slot] = { id: at.dataset.id, shown: items.length, sig: placeFor(), t: Date.now() };
      const keep = Object.entries(places).sort(([, a], [, b]) => b.t - a.t).slice(0, PLACE_MAX);
      placeKey.setJson(Object.fromEntries(keep));
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
    for (let n = 0; n < 20 && listItems().length < p.shown && moreBtn(); n++) renderMore();
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
  // A search still reading, with the pages read so far shown: { id: its runId, note: progress }.
  // Stale once runId moves on (navigation, another run), so it can't outlive its search.
  let crawl = null;
  const partialStatus = () => `${crawl.note} ${ui.rows?.length ?? 0} of ${cache?.length ?? 0} so far match.`;
  // The rows read so far, shown but not taken in: no sightings, tab cache or remembered search
  // until the crawl is done (adopt), so a crawl that stops partway changes nothing it shouldn't.
  function showSoFar(key, rows, page, max) {
    const first = !(cache && cacheKey === key);
    crawl = { id: runId, note: `Reading page ${page + 1} of ${max}…` };
    learn(rows, false);
    fillTypes(rows);
    cache = rows.slice();
    cacheKey = key;
    truncated = false;
    textClipped = false;
    withMedians(cache);
    withBuildings(cache);
    if (!first) return inPlace(() => showResults()); // later pages: the list grows under you, scroll kept
    showResults();
    ui.fold?.(true);
  }
  // #endregion
  // #region search
  // `resume`: after a search stopped partway, fetch from where it failed (pages already read
  // come from pageMemo, without a pause).
  async function run(force = false, { resume = false } = {}) {
    // This search's results already shown (whole, not a part-read): Search applies the filters to
    // them at once, however old they are; only Refresh reads every page again.
    if (!force && cache && cacheKey === searchKey(location.href) && ui.partial.hidden) return showResults('Refresh fetches current listings.');
    if (!force && restoreSession()) return;
    // Refresh or Resume during a bot-check pause would drop what's read (and the Resume notice)
    // and then fail: keep them.
    if (force && pause.until()) return setStatus(pausedErr(pause.until()).message, true);
    showPartial(null);
    runCtrl?.abort();
    const ctrl = runCtrl = new AbortController();
    const id = ++runId;
    const base = location.href;
    const key = searchKey(base);
    setBusy(true);
    setExport(true);
    // Nothing shown for this search yet: show each page as it's read. A Refresh keeps what's shown
    // until the new crawl is done (a list shrinking to page 1 and growing back would only jump).
    const preview = !(cache && cacheKey === key);
    try {
      if (force && !resume) pageMemo.clear();
      const onProgress = (m) => { if (id !== runId) return; if (crawl?.id !== id) return setStatus(m); crawl.note = m; setStatus(partialStatus()); };
      const onPage = (rows, page, max) => { if (id === runId && preview && page < max) showSoFar(key, rows, page, max); };
      // Refresh means "newer than what I'm looking at", so the load-time seed is skipped too.
      const res = await fetchAllPages(base, onProgress, {
        seed: (force && !resume) || Date.now() - bootAt > ROWS_TTL_MS ? null : boot,
        signal: ctrl.signal, keepPartial: true, isCached: memoFresh, onPage, lastFetchAt: () => lastFetchEnd,
        getPage: (url) => getPage(url, { signal: ctrl.signal, onRetry: (n, ms) => onProgress(`Retrying in ${Math.round(ms / 1000)}s (attempt ${n}/${RETRIES})…`) }),
      });
      if (id !== runId) return; // search changed mid-run; navigation handler already reported it
      // Pages were shown as they came: the whole list goes in where you are, not back at the top.
      const shown = crawl?.id === id;
      crawl = null;
      const take = (...a) => (shown ? inPlace(() => adopt(...a)) : adopt(...a));
      if (res.failed) {
        // Show what was read, but don't let a part stand for the whole: no remembered snapshot
        // (unread listings would count as gone), no tab cache, no health sample, not a full crawl.
        learn(res.rows, true, false);
        take(key, res.rows, res.truncated, '', null, false, false); // fresh text, just not every page
        showPartial(res.failed);
        logError(`search: page ${res.failed.page}: ${res.failed.message}`);
        return;
      }
      if (res.paging) { // a paging guard stopped it: shown, but like a part-read, not a full crawl
        formatWarn(PAGING_MSG[res.paging]);
        learn(res.rows, true, false);
        take(key, res.rows, res.truncated, '', null, false, false);
        textClipped = false;
        return;
      }
      if (res.sample) rawSample = res.sample;
      let drops = [];
      try { drops = health.record(res.rows); } catch (e) { logError(`health: ${e.message}`); }
      const moved = resultsPath.fallback ? [`results are now under ${resultsPath.key}.${resultsPath.field}`] : [];
      const drift = [...moved, ...drops.map((d) => `${d.field} on ${pct(d.now)} of listings (usually ${pct(d.usual)})`)];
      setWarn('drift', drift.length ? `REA may have changed its data: ${drift.join('; ')}. Copy report, then paste it into an issue on the script's GitHub page.` : '');
      setWarn('format', ''); // every page read: an earlier odd page was a one-off
      store.set(key, res.rows, res.truncated, (fn) => setTimeout(fn, 0));
      // Written in the next task, so the results paint first; the warning follows the write.
      const snap = cfg.remember ? snaps.save(key, res.rows, res.truncated, (fn) => setTimeout(fn, 0)) : null;
      if (!snap) setWarn('saved', '');
      snap?.saved.then(({ evicted, refused, quota }) => setWarn('saved', quota ? `This browser's storage is full: ${refused ? 'this search wasn\'t remembered' : 'kept this search'}${evicted.filter((k) => k !== key).length ? `, stopped remembering ${evicted.filter((k) => k !== key).map(searchLabel).join(', ')}` : ''}. Delete saved searches or turn off Remember results to make room.`
        : refused ? `Not remembered: all ${SNAP_MAX} saved searches are pinned (unpin one under Saved searches).`
        : evicted.length ? `Stopped remembering ${evicted.map(searchLabel).join(', ')} (${SNAP_MAX} searches at most; pin one to keep it).` : ''));
      take(key, res.rows, res.truncated, '', snap, true);
      ui.newsSeen?.();
    } catch (err) {
      if (id !== runId || ctrl.signal.aborted) return;
      if (err?.paused && cache) { setStatus(err.message, true); return; } // what's shown stays usable
      cache = null;
      cacheKey = null;
      setLaunchCount(null);
      setStatus(err.message, true);
      logError(`search: ${err.message}`);
      if (ui.view !== 'shortlist') setEmpty('Search failed.');
    } finally {
      if (id === runId) { setBusy(false); crawl = null; } // however it ended, it isn't reading any more
      if (runCtrl === ctrl) runCtrl = null;
    }
  }

  // #endregion
  // #region fetching and notes
  // Adds a badge to REA's own result cards. Append-only (never reorders or removes
  // React-owned nodes) and idempotent, so the MutationObserver can't feed back on itself.

  const known = new Map(); // listing id -> row, from any source
  // pageUrl -> { at, p: Promise<results>, signal }; shared by annotation and full searches so a
  // page is fetched once per ROWS_TTL_MS. Failures are evicted so they can be retried.
  const pageMemo = new Map();
  const memoFresh = (url) => { const hit = pageMemo.get(url); return !!hit && !hit.signal?.aborted && Date.now() - hit.at < ROWS_TTL_MS; };
  // Bot check: every fetch (search, Check all, Re-check, card annotation) stops until PAUSE_MS
  // has passed, so retrying doesn't make a block worse. Pages already read are still served.
  const pause = pauseGate(storageOr('localStorage'));
  let pauseTimer = 0;
  const pauseMsg = (t) => `REA showed a bot check, so fetching is paused until ${dtf({ hour: 'numeric', minute: '2-digit' }).format(t)}. Browse REA normally for a while; the drawer still works on what's already read.`;
  const pausedErr = (t) => Object.assign(new Error(`Paused: ${pauseMsg(t)}`), { paused: true });
  const showPause = () => {
    const t = pause.until();
    setWarn('paused', t ? pauseMsg(t) : '');
    clearTimeout(pauseTimer);
    if (t) pauseTimer = setTimeout(showPause, t - Date.now() + 1000);
  };
  const tripPause = (e) => {
    if (e?.format) return formatWarn(e.message);
    if (!e?.botCheck) return;
    pause.trip(); logError(`paused: ${e.message}`); showPause();
  };
  // A page that loaded but has no data where the script reads it: say so (with Copy report)
  // rather than pause, which would look like a bot check and never get reported.
  const formatWarn = (msg) => { logError(`format: ${msg}`); setWarn('format', `${msg} Copy report, then paste it into an issue on the script's GitHub page.`); };
  let lastFetchEnd = 0; // when REA last answered a request of ours (fetchAllPages spaces requests from it)
  const getPage = (url, opts) => {
    const hit = pageMemo.get(url);
    // An entry whose run was aborted is about to reject; don't hand it to a new caller.
    if (hit && !hit.signal?.aborted && Date.now() - hit.at < ROWS_TTL_MS) return hit.p;
    const until = pause.until();
    if (until) return Promise.reject(pausedErr(until));
    const p = fetchResults(url, opts).finally(() => { lastFetchEnd = Date.now(); }).catch((e) => { if (pageMemo.get(url)?.p === p) pageMemo.delete(url); tripPause(e); throw e; });
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
    const pets = r.amen?.pets === 'yes' ? `<span class="rf-b-pets">${esc(amenDetail('pets', r.text) || 'Pets OK')}</span>` : ''; // the drawer's wording
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
      if (ex) { rawListingSample = ex; return safeRow(ex, false); }
    }
    const l = ex ? findListing(ex, id) : null;
    if (l) rawListingSample = l;
    return (l && safeRow(l, false)) || { id, url: location.origin + location.pathname, address: '', price: '', inspections: [], partial: true };
  }
  // Minimised state is remembered: the bar can sit over REA's own buttons on small screens.
  const LBAR_MIN_KEY = `${TOOL_PREFIX}lbar-min`;
  const WIDE_KEY = `${TOOL_PREFIX}wide`;
  const WIDTH_KEY = `${TOOL_PREFIX}width`; // side drawer width you dragged it to
  const DRAWER_MIN = 360, DRAWER_MAX = 900, DRAWER_TWO_COL = 760;
  // Installs auto-update silently, so the drawer says once what changed (lint keeps this in step
  // with @version and the changelog). A first install gets WELCOME instead.
  const WHATS_NEW = { version: '2.36.1', items: [
    'Availability Filter is now Rental Toolkit. Search all pages shows listings as each page is read.',
    'Search all pages on the same search filters what you already have, instantly; Refresh reads every page again.',
    "Light / dark from the drawer's header; everything is faster, on REA's other pages too.",
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
  // Browser storage can be cleared (and REA's page shares it): with a real shortlist and no
  // backup for a month, say so once a month.
  const BACKUP_KEY = `${TOOL_PREFIX}backup-at`, BACKUP_NUDGE_KEY = `${TOOL_PREFIX}backup-nudge-at`;
  const BACKUP_NUDGE_MIN = 5, BACKUP_NUDGE_DAYS = 30;
  const backupAt = keyStore(storageOr('localStorage'), BACKUP_KEY);
  const nudgeBackup = () => {
    const now = Date.now(), gap = BACKUP_NUDGE_DAYS * DAY_MS, nudged = keyStore(storageOr('localStorage'), BACKUP_NUDGE_KEY);
    const n = marks.counts().starred;
    if (!isSearchPage(location.href) || n < BACKUP_NUDGE_MIN || now - (+backupAt.get() || 0) < gap || now - (+nudged.get() || 0) < gap) return;
    ui.backupNudge = () => nudged.set(String(Date.now())); // counted as shown once the drawer is open
    if (!ui.panel.hidden) ui.backupNudge();
    setWarn('backup', `${n} listings shortlisted and ${backupAt.get() ? `last backed up ${ago(now - +backupAt.get())}` : 'never backed up'}. Browser storage can be cleared: Shortlist → More → Backup keeps a copy.`);
  };
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
  // #endregion
  // #region listing bar
  // One listing page for Re-check and the listing bar: a 429 gets one wait and retry before it
  // counts as a bot check; the body is read here too; a format change is reported once here.
  async function fetchListingPage(url, signal) {
    let res;
    for (let attempt = 0; ; attempt++) {
      res = await fetch(url, { credentials: 'include', signal: withTimeout(signal, FETCH_TIMEOUT_MS) });
      if (res.status !== 429 || attempt) break;
      const after = Math.min(+res.headers?.get?.('Retry-After') || 0, RETRY_AFTER_MAX_S);
      await sleep(after > 0 ? after * 1000 : jitter(RETRY_BASE_MS * 2), signal);
    }
    const html = res.ok ? await res.text() : '';
    const kind = classifyPage({ status: res.status, html, redirectedTo: res.redirected ? res.url : '', listing: true });
    if (kind === 'format') formatWarn("A listing page loaded, but its data isn't where the script reads it: REA may have changed its format.");
    return { res, html, kind };
  }
  function renderListingBar({ onlyIfMoved = false } = {}) {
    let bar = document.getElementById('rf-lbar');
    const id = isListingPage(location.href) ? listingId(location.pathname) : '';
    if (bar?._editing && bar.dataset.id === id) return; // a note half-typed isn't redrawn away
    // Moved to another listing (or off listings) mid-note: keep the draft. Not every browser fires
    // blur on removal, and one that does would remove the bar again from inside this remove().
    if (bar?._editing) { bar._finishEdit?.(true, false); bar = document.getElementById('rf-lbar'); }
    if (!id) { bar?.remove(); return; }
    if (onlyIfMoved && bar?.dataset.id === id) return; // same listing (eg a gallery ?query): keep focus
    const focusSel = bar?.contains(document.activeElement) ? lbarFocusSel(document.activeElement) : null;
    if (!bar) {
      bar = Object.assign(document.createElement('div'), { id: 'rf-lbar' });
      bar.setAttribute('role', 'region');
      bar.setAttribute('aria-label', 'Shortlist this listing');
      document.body.appendChild(bar);
      bar.addEventListener('click', guard('listing bar', onListingBar));
      bar.addEventListener('change', guard('listing bar', onListingBar));
    }
    if (bar._opened !== id) { bar._opened = id; marks.setOpened(id); } // being here is opening it
    const r = bar._row?.id === id ? bar._row : listingPageRow(id);
    marks.decorate([r]);
    bar.dataset.id = id;
    bar._row = r;
    const info = [bar._goneId === id && 'REA says this listing is no longer listed', r.prevPrice && `was ${r.prevPrice}`, r.prevAvail && `available was ${r.prevAvail}`, r.relisted && 'relisted',
      r.firstSeen && `first seen ${ago(Date.now() - r.firstSeen)}`].filter(Boolean).join(' · ');
    const small = lbarMin.get();
    bar.classList.toggle('rf-lbar-min', small);
    bar.innerHTML = small ? `<button type="button" data-l="s" aria-pressed="${r.starred}" aria-label="${r.starred ? 'Shortlisted' : 'Shortlist'}">${r.starred ? '★' : '☆'}</button>
      <button type="button" data-l="min" aria-expanded="false" aria-label="Show listing tools">⋯</button>` : `<button type="button" data-l="s" aria-pressed="${r.starred}">${r.starred ? '★ Shortlisted' : '☆ Shortlist'}</button>
      ${r.starred ? `<select data-l="as" aria-label="Application status">${statusOptions(r.appStatus)}</select>` : ''}
      <button type="button" data-l="n">${r.note ? 'Edit note' : 'Note'}</button>
      <button type="button" data-l="h" aria-pressed="${r.hidden && !r.resurfaced}">${hideWord(r)}</button>
      <button type="button" data-l="min" aria-expanded="true" aria-label="Minimise listing tools" title="Minimise">▾</button>
      ${r.note ? `<div class="rf-lbar-note">${esc(r.note)}</div>` : ''}${info ? `<div class="rf-lbar-info">${esc(info)}</div>` : ''}${r.starred ? lbarDetails(r, bar._details) : ''}`;
    if (!r.starred || small) lbarTick(false); // no next stop shown: stop the minute redraws
    if (focusSel) bar.querySelector(focusSel)?.focus();
    bar.querySelector('.rf-lbar-more')?.addEventListener('toggle', (e) => { bar._details = e.currentTarget.open; });
    // Reached by in-app navigation: the page's data is the previous listing's, so read this one's page.
    // Each listing is fetched once per visit (a page that can't be read isn't asked for again on
    // every click); one REA says is gone is marked so, if you'd marked it.
    if (r.partial && bar._fetching !== id && !(bar._tried ||= new Set()).has(id) && !pause.until()) {
      bar._fetching = id;
      bar._tried.add(id);
      fetchListingPage(location.href, null)
        .then(({ html, kind }) => {
          if (BOT_KINDS.has(kind)) { bar._tried.delete(id); tripPause(botCheck(`listing page: ${kind}`)); } // after the pause, it may try again
          if (kind === 'gone' && bar.dataset.id === id) {
            bar._goneId = id;
            if (marks.shortlist().some((x) => x.id === id) || marks.note(id)) marks.setGone(id, true);
            renderListingBar();
          }
          return kind === 'ok' ? html : '';
        })
        .then((html) => { const out = parseListingPage(html, id); if (out.status === 'ok') rawListingSample = out.listing; if (out.status === 'ok' && bar.dataset.id === id) { const row = safeRow(out.listing, false); if (row) { bar._row = row; if (marks.shortlist().some((x) => x.id === id)) learn([row], true, false, false); renderListingBar(); } } })
        .catch((e) => { if (e?.name !== 'AbortError') logError(`listing bar: ${e?.message || e}`); }).finally(() => { if (bar._fetching === id) bar._fetching = null; if (bar.dataset.id !== id && bar._row?.partial) renderListingBar(); });
    }
  }
  // At an inspection, with the listing open on your phone: the checklist and the facts worth
  // checking, folded away until opened (the bar stays the size it is).
  // While there is a next stop, redraw the bar each minute (and on coming back to the tab), so
  // "leave by" and the next listing stay current while you stand in an inspection.
  // Put focus back on the same control after a redraw: checklist items and stars share data-l.
  const lbarFocusSel = (el) => (el.dataset.ck ? `[data-ck="${CSS.escape(el.dataset.ck)}"]` : el.dataset.qa ? `[data-qa="${CSS.escape(el.dataset.qa)}"]`
    : el.dataset.v ? `[data-l="${CSS.escape(el.dataset.l)}"][data-v="${CSS.escape(el.dataset.v)}"]`
      : el.tagName === 'SUMMARY' ? '.rf-lbar-more > summary' : el.dataset.l ? `[data-l="${CSS.escape(el.dataset.l)}"]` : null);
  let lbarTimer = 0;
  const lbarTick = (on) => {
    clearInterval(lbarTimer);
    lbarTimer = on ? setInterval(() => { if (!document.hidden && document.getElementById('rf-lbar')) renderListingBar(); }, 60000) : 0;
  };
  document.addEventListener('visibilitychange', () => { if (!document.hidden && lbarTimer && document.getElementById('rf-lbar')) renderListingBar(); });
  function lbarDetails(r, open) {
    setDistances(r, cfg, parseAnchor(cfg.anchor), parsePlaces(cfg.places));
    const fit = leaseEndOf(cfg) ? leaseFit(r, leaseEndOf(cfg)) : null, extra = (fit?.cost || 0) + (num(cfg.moveCosts) || 0);
    const cash = Number.isFinite(r.upfront) && extra ? r.upfront + extra : null;
    const rec = r.agency ? recordText(agencyRecord(marks.shortlist()).get(agencyKey(r.agency))) : '';
    const facts = [Number.isFinite(r.upfront) ? `move-in ${money(r.upfront)}${r.bondWeeks > BOND_CAP_WEEKS ? ` (bond ${r.bondWeeks} wks)` : ''}` : '',
      cash != null ? `cash to move ${money(cash)}` : '', applyByLabel(r.applyBy), rec ? `${r.agency}: ${rec}` : '', sqmLabel(r), r.lease ? leaseText(r.lease) : '', r.applyVia ? `apply via ${r.applyVia}` : '', r.taken ? TAKEN_LABELS[r.taken] : '',
      ...watchTags(r), placesLabel(r) || kmLabel(r), negotiateFacts(r, cache ? cacheDrops() : null)].filter(Boolean);
    const checks = checklistItems(cfg.checklist).map((k) => checkBtn(k, own(r.checks, k), 'data-l="ck"')).join('');
    const sl = marks.shortlist(), mine = sl.find((x) => x.id === r.id);
    const nx = nextStop(sl, Number.isFinite(r.lat) || !mine ? r : { ...r, lat: mine.lat, lng: mine.lng }); // the page may not say where it is; the shortlist copy does
    const clockAt = (ms) => dtf({ hour: 'numeric', minute: '2-digit', ...(tzOf(r) ? { timeZone: tzOf(r) } : {}) }).format(ms);
    const leave = nx?.leaveBy == null ? '' : nx.leaveBy <= Date.now() ? ' · leave now' : ` · leave by ${esc(clockAt(nx.leaveBy))}`;
    const next = nx ? `<div class="rf-lbar-info rf-lbar-next">Next: <a href="${esc(safeUrl(nx.r.url))}">${esc(clockAt(nx.at))} ${esc(String(nx.r.address || '').split(',')[0])}</a>${nx.km != null ? ` · ${nx.km} km` : ''}${leave}</div>` : '';
    lbarTick(!!nx);
    // Applications close soon and you haven't applied: say so above the fold, with a one-tap fix.
    const asks = askItems(r, cfg.amenities);
    const due = needsAction(r) === 'applyby' ? `<div class="rf-lbar-info rf-lbar-due">${esc(applyByLabel(r.applyBy))} · ${esc(applyReady(r, cfg, packPortals(sl)))}: <button type="button" data-l="ap">Mark applied</button></div>` : '';
    return `${due}${next}<details class="rf-lbar-more"${open ? ' open' : ''}><summary>Checklist, rating and details</summary>
      <div class="rf-lbar-checks"><span class="rf-lbar-lab" aria-hidden="true">My rating</span>${ratingHtml(r, 'data-l="rt"')}</div>
      ${facts.length ? `<div class="rf-lbar-info">${esc(facts.join(' · '))}</div>` : ''}<div class="rf-lbar-checks" role="group" aria-label="Inspection checklist">${checks}</div>${asks.length ? `<div class="rf-lbar-info rf-lbar-ask"><span class="rf-lbar-lab">Ask the agent (tap once answered)</span><div class="rf-lbar-checks" role="group" aria-label="What to ask the agent">${asks.map((x) => qaBtn(x, 'data-l="qa"')).join('')}</div></div>` : ''}</details>`;
  }
  // The note is edited in the bar (multi-line, themed, read by screen readers as a labelled
  // field): Enter saves, Shift+Enter is a new line, Esc cancels; focus goes back to Note.
  // Redraws (the minute tick, another tab) wait until it's closed.
  function editBarNote(bar, id, r) {
    const open = bar.querySelector('.rf-lbar-edit');
    if (open) return open.focus();
    const ta = Object.assign(document.createElement('textarea'), { className: 'rf-lbar-edit', maxLength: NOTE_MAX, value: r.note || '',
      placeholder: 'Enter to save, Shift+Enter for a new line, Esc to cancel' });
    ta.setAttribute('aria-label', 'Private note for this listing');
    bar.querySelector('.rf-lbar-note')?.remove();
    bar.querySelector('[data-l=min]').after(ta);
    bar._editing = true;
    ta.focus();
    // :active isn't set yet when the press's blur runs: the press is noted here instead.
    // `held`: the pointer is still down (on touch, pointerup comes before the blur).
    let pressed = false, held = false;
    const down = (e) => { pressed = e.target !== ta; held = true; };
    const up = () => { held = false; };
    bar.addEventListener('pointerdown', down, true);
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', up, true);
    const finish = (save, refocus) => {
      if (!bar._editing) return;
      bar._editing = false;
      bar._finishEdit = null;
      bar.removeEventListener('pointerdown', down, true);
      document.removeEventListener('pointerup', up, true);
      document.removeEventListener('pointercancel', up, true);
      if (save && ta.value !== (r.note || '')) { marks.setNote(id, ta.value); mirrorSoon(); }
      renderListingBar();
      if (refocus) bar.querySelector('[data-l=n]')?.focus(); // not when you clicked away
    };
    bar._finishEdit = finish;
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation(); // typing isn't a shortcut
      if (e.key === 'Escape') finish(false, true);
      else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true, true); }
    });
    // Clicked another of the bar's buttons: save now, but redraw after that click lands, or the
    // redraw replaces the button under the pointer and the click is lost.
    ta.addEventListener('blur', () => {
      if (!pressed) return finish(true, false);
      if (ta.value !== (r.note || '')) { marks.setNote(id, ta.value); mirrorSoon(); }
      if (!held) return setTimeout(() => finish(true, false), 0); // already up: after this tap's click
      const later = () => { document.removeEventListener('pointerup', later, true); document.removeEventListener('pointercancel', later, true); setTimeout(() => finish(true, false), 0); };
      document.addEventListener('pointerup', later, true);
      document.addEventListener('pointercancel', later, true);
    });
  }
  function onListingBar(e) {
    const bar = e.currentTarget, id = bar.dataset.id, r = bar._row;
    const el = e.target.closest('[data-l]');
    if (!el || (e.type === 'click' && el.tagName === 'SELECT')) return;
    const k = el.dataset.l;
    if (k !== 'min') mirrorSoon(); // the bar's changes don't pass through refreshMarks
    if (k === 'min') lbarMin.set(!lbarMin.get());
    else if (k === 's' || k === 'h') marks.toggle(id, k, r);
    else if (k === 'as') marks.setStatus(id, el.value);
    else if (k === 'ap') { marks.setStatus(id, 'applied'); renderListingBar(); return bar.querySelector('[data-l=as]')?.focus(); }
    else if (k === 'rt') {
      marks.setRating(id, +el.dataset.v);
      renderListingBar();
      return bar.querySelector(`[data-l="rt"][data-v="${el.dataset.v}"]`)?.focus();
    }
    else if (k === 'qa' || k === 'ck') {
      const attr = `data-${k}`, v = el.getAttribute(attr);
      if (k === 'qa') marks.cycleAnswer(id, v); else marks.cycleCheck(id, v);
      renderListingBar();
      return bar.querySelector(attrSel(attr, v))?.focus();
    }
    else if (k === 'n') return editBarNote(bar, id, r);
    renderListingBar();
    bar.querySelector(`[data-l="${k}"]`)?.focus();
  }

  // #endregion
  // #region card badges
  // Star / hide right on REA's card. Buttons live inside our badge (append-only), and the
  // click is stopped in the capture phase so REA's card link doesn't navigate.
  // Your 1-5 rating: five buttons, the current one pressed; pressing it again clears it.
  const ratingHtml = (r, attr) => `<span class="rf-rate" role="group" aria-label="My rating">${[1, 2, 3, 4, 5].map((n) =>
    `<button type="button" ${attr} data-v="${n}" aria-pressed="${r.rating === n}" aria-label="Rate ${n} of 5" title="Rate ${n} of 5 (Shift+${n})">${n <= (r.rating || 0) ? '★' : '☆'}</button>`).join('')}</span>`;
  // One What to ask question, answered in place: unasked -> ✓ fine -> ✗ a problem.
  // A three-state button (unset -> y -> n): `data` is its key attribute, `aria` its full label.
  const triBtn = (attrs, data, key, v, text, aria) => `<button type="button" ${attrs} ${data}="${esc(key)}" data-state="${v === 'y' ? 'yes' : v === 'n' ? 'no' : ''}" aria-label="${esc(aria)}">${ynMark(v)}${esc(text)}</button>`;
  const qaBtn = (x, attrs) => triBtn(attrs, 'data-qa', x.id, x.a, x.q, `${x.q} ${x.a === 'y' ? 'Answered: fine' : x.a === 'n' ? 'Answered: a problem' : 'Not answered'}`);
  // One checklist item: unknown -> ✓ good -> ✗ problem.
  const checkBtn = (k, v, attrs) => triBtn(attrs, 'data-ck', k, v, k, `${k}: ${v === 'y' ? 'good' : v === 'n' ? 'problem' : 'not checked'}`);
  const reasonLabel = (x) => x.charAt(0).toUpperCase() + x.slice(1); // shown capitalised; stored as is (backups carry it)
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
      refreshMarks(touched(id, act));
      if (act === 'h' && on) offerHideUndo(id, () => { marks.toggle(id, 'h'); refreshMarks(touched(id, 'h')); });
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
    if (matchMemo.sig !== sig) matchMemo = { sig, set: new Set(filterRows([...known.values()], cfg).map((r) => r.id)) }; // no scoring: it would overwrite the drawer's Match scores
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
      if (isSearchPage(location.href) && !cardsOnPage().size) setWarn('cards', "REA's result cards weren't recognised, so the badges and card buttons are off (the drawer still works). Copy report, then paste it into an issue on the script's GitHub page.");
    }, CARD_WARN_MS);
  };
  function annotate() { try { annotateNow(); } catch (e) { noteError('annotate', e); } }
  function annotateNow() {
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
    try {
      const res = await getPage(pageUrl(href, n));
      if (!learnedPages.has(res)) { learnedPages.add(res); learn(rowsFrom(res)); } // a page served again from pageMemo: already in
    } catch (e) { console.debug?.('[reaFilter] annotate fetch failed:', e); return; }
    if (location.href === href) scheduleAnnotate();
  }
  const learnedPages = new WeakSet(); // results objects ensureVisiblePage has taken in
  let ensureT = 0;

  function watchCards() {
    new MutationObserver(guard('cards', (muts) => {
      if (!isSearchPage(location.href)) return;
      // Ignore mutations confined to our own badges/panel.
      const ours = (m) => m.type === 'childList' && (m.target.closest?.('.rf-badge, #rf-panel, #rf-launch') ||
        m.removedNodes.length === 0 && m.addedNodes.length > 0 && [...m.addedNodes].every((n) => n.classList?.contains('rf-badge')) ||
        [...m.addedNodes, ...m.removedNodes].every((n) => /^rf-(?:toast|remind|lbar)$/.test(n.id || '')) && m.addedNodes.length + m.removedNodes.length > 0); // our own notes on <body>
      if (muts.every(ours)) return;
      scheduleAnnotate();
    })).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
  }

  // REA is an SPA - invalidate cached rows (and any in-flight run) when the search URL changes.
  function watchNavigation() {
    let lastKey = currentKey();
    // A task after REA's pushState returns (restoring a search parses and draws: not inside REA's
    // route change), and a burst of history calls is one event.
    let navT = 0;
    const fire = () => { navT ||= setTimeout(() => { navT = 0; window.dispatchEvent(new Event('rf:navigate')); }, 0); };
    for (const fn of ['pushState', 'replaceState']) {
      const orig = history[fn];
      history[fn] = function (...args) { const r = orig.apply(this, args); fire(); return r; };
    }
    window.addEventListener('popstate', fire);
    window.addEventListener('rf:navigate', () => {
      const active = isSearchPage(location.href);
      if (active && mirrorHeld && !ui.pendingRestore && typeof indexedDB !== 'undefined') offerMirror(); // started on a listing page: ask here
      ui.launch.hidden = !active && !ui.pendingShare; // an unanswered share offer stays reachable
      paintRea(); // another search, or REA's filters changed
      if (!active && !ui.pendingShare) ui.setOpen(false);
      const tip = document.getElementById('rf-remind');
      if (tip) tip.hidden = !active; // the reminder is about searches: back when one is
      clearTimeout(ensureT);
      ensureT = setTimeout(ensureVisiblePage, NAV_SETTLE_MS);
      const key = currentKey();
      if (key === lastKey) return; // same search, different page/view
      if (!key) return; // a listing (or another REA page) between searches isn't leaving: the search keeps running, and what's read stays
      setWarn('saved', ''); // about the previous search
      fillPresets();
      renderSaved();
      setTimeout(() => enterSearchPresets(key), 0); // after the old search's state is cleared below
      lastKey = key;
      if (cfg.building) { cfg.building = ''; const b = document.getElementById('rf-building'); if (b) b.value = ''; }
      remindSaved();
      if (cacheKey && cacheKey === key) return;
      const hadState = cacheKey || busy;
      // Stop crawling the old search; Check all and Re-check aren't about this search, so they go on.
      const job = runCtrl?.job;
      if (!job) runCtrl?.abort();
      runId++;
      applySnap(null);
      showPartial(null);
      cache = null;
      cacheKey = null;
      renderActive(); // the old search's filter chips (eg a Building one) go with it
      if (!job) setBusy(false);
      else ui.run.setAttribute('aria-disabled', 'false'); // Check all goes on, but Run here can stop it
      ui.refresh.hidden = true;
      setExport(true);
      ui.fold?.(false); // Search is needed again: not folded away
      if (restore() || !hadState) return;
      setLaunchCount(null);
      if (ui.view === 'shortlist') return; // shortlist is search-independent
      setEmpty('Search changed.');
      setStatus('Search changed - run again to refresh.');
    });
  }

  // Console helpers: reaFilter.probe() shows which listing fields exist in live data.
  // Copyable diagnostics for a bug report: no listing text, no search terms beyond the path.
  const selfcheckText = () => {
    // Before any search, page 1's own data stands in, so the fill rates aren't all 0%.
    const early = !cache && !!boot && boot.key === searchKey(location.href); // not another search's page 1 after in-app navigation
    const rows = cache || (early ? rowsFrom(boot.results) : []);
    const rates = fillRates(rows), usual = health.usual();
    const report = [
      `rea-enhancement ${window.reaFilter.version}`, `page: ${location.pathname}`, `rows: ${rows.length}${early ? ' (page 1 only: no search run yet)' : truncated ? ' (truncated)' : ''}`,
      `fields (this search / usual): ${Object.keys(HEALTH_FIELDS).map((k) => `${k} ${pct(rates[k])}/${usual.ema[k] == null ? '?' : pct(usual.ema[k])}`).join(', ')}`,
      `cards: ${cardInfo.found} found (${cardInfo.mode === 'fallback' ? 'fallback: REA no longer uses <article>' : cardInfo.mode})`,
      `results path: ${resultsPath.key ? `${resultsPath.key}.${resultsPath.field}${resultsPath.fallback ? ' (fallback: REA renamed it)' : ''}` : 'not read yet'}`,
      `discovered paths: ${Object.entries(found).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`,
      `schema warnings: ${schemaWarnings(rows).join('; ') || 'none'}`,
      `recent errors: ${errorLog.length ? `\n  ${errorLog.join('\n  ')}` : 'none'}`,
    ].join('\n');
    return report;
  };
  // Paste-safe structure of one listing (no descriptions, names or addresses) for issues.
  // A search's listing, or on a property page that page's (kind: "listing"): REA shapes them differently.
  const shapeText = () => {
    const onListing = isListingPage(location.href) && rawListingSample;
    const l = onListing ? rawListingSample : rawSample;
    return l ? JSON.stringify({ script: window.reaFilter.version, kind: onListing ? 'listing' : 'search', ...(onListing ? {} : { resultsPath: `${resultsPath.key}.${resultsPath.field}` }), listing: shapeOf(l) }, null, 1) : '';
  };
  // Both, for the Copy report buttons: what an "REA data format changed" issue asks for.
  const reportText = () => [selfcheckText(), shapeText()].filter(Boolean).join('\n\nlisting shape:\n');
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
    shape: () => {
      const out = shapeText();
      if (!out) return 'No listing seen yet - load a results page or run a search.';
      console.log(out);
      copyText(out).catch(() => {});
      return out;
    },
    selfcheck: () => {
      const report = selfcheckText();
      console.log(report);
      copyText(report).catch(() => {});
      return report;
    },
  };

  // #endregion
  // #region startup
  // Each step isolated: a failure in one (eg REA drift) must not take the others down.
  const step = (name, fn) => {
    const fail = (e) => { console.warn(`[reaFilter] ${name}:`, e); logError(`${name}: ${e?.message || e}`); };
    try { const r = fn(); if (r?.catch) r.catch(fail); } catch (e) { fail(e); }
  };
  // REA pages that aren't a rent search, a listing or a share link (home, buy, agents) only get a
  // history hook: the drawer, its styles and the stores are built on the first navigation to one.
  const wanted = (href) => { const u = new URL(href); return /^\/rent\//.test(u.pathname) || isListingPage(href) || new RegExp(`[#&]${SHARE_PARAM}=`).test(u.hash); };
  function start() {
    step('build', build);
    if (ui?.ready) { // only wire the rest if build() completed
      step('launch', () => { paintRea(); ui.launch.hidden = !isSearchPage(location.href); ui.view = 'results'; updateCounts(); setExport(!cache); }); // nothing searched: Bulk, Market, Map and exports hidden
      // The rest in a second task, so page load isn't one long (50 ms+) task: reading page 1's
      // listings and your marks is most of it. Order within is unchanged.
      setTimeout(() => {
        step('boot', () => { if (boot) learn(rowsFrom(boot.results)); });
        step('pause', showPause);
        step('navigation', watchNavigation);
        step('cards', watchCards);
        step('card actions', watchCardActions);
        step('opens', watchOpens);
        // REA's cards for the page as loaded are there already: badge them now, not after restore.
        step('first badges', () => { if (boot && cfg.annotate) annotate(); });
        step('storage warning', () => writeState.listeners.add((ok) => setWarn('storage', ok ? ''
          : `Couldn't save your last change: this site's browser storage is full (this script uses ${fmtBytes(toolBytes(storageOr('localStorage')))}). Delete saved searches or turn off Remember results in Settings, then try again.`)));
        const syncMarks = () => {
          ui.marksStale = false;
          if (document.getElementById('rf-lbar')) renderListingBar();
          // A note being typed in the drawer: its save redraws everything, so wait for it.
          if (!ui.list.querySelector('.rf-note-edit')) keepingUndo(() => refreshMarks());
        };
        step('sync stale', () => document.addEventListener('visibilitychange', guard('other tab', () => { if (!document.hidden && ui.marksStale) syncMarks(); })));
        step('sync', () => window.addEventListener('storage', guard('other tab', (e) => {
          // Another tab changed the shortlist/hidden/notes: pick it up here.
          if (e.key === PAUSE_KEY) showPause(); // another tab hit a bot check (or its pause ended)
          if (e.key === PRESETS_KEY || e.key === null) fillPresets(); // a preset saved in another tab
          if (e.key === SNAP_KEY || e.key === null) renderSaved(); // another tab's search or Check all
        // A restore's Undo puts back what was stored before it: after another tab has written, that
        // would silently undo the other tab too, so the offer goes.
        if (e.key === MARKS_KEY || e.key === SNAP_KEY || e.key === PRESETS_KEY || e.key === null) ui.status.querySelector('.rf-undo-restore')?.remove();
        // Sightings only (another tab read a page, opened a listing): nothing of yours changed, so no
        // re-read or redraw here; this tab's next write still re-reads storage first (fresh()).
        if (e.key === MARKS_KEY && marks.sameChoices(e.newValue)) return;
        if (e.key === MARKS_KEY || e.key === null) {
          marks.invalidate();
          // A tab in the background redraws once when it's looked at again, not on every change made elsewhere.
          if (document.hidden) ui.marksStale = true; else syncMarks();
        }
          // Settings saved in another tab: take its display settings (places, checklist, weights,
          // theme…). Filters and sort stay per tab, so two searches can be narrowed differently.
          if (e.key === CFG_KEY) {
            const stored = { ...DEFAULT_CFG, ...loadCfg() };
            const moved = DISPLAY_PREFS.filter((k) => k !== 'sort' && k !== 'sortDesc' && stored[k] !== cfg[k]); // each tab keeps its own sort
            if (!moved.length) return;
            for (const k of moved) cfgBase[k] = stored[k];
            if (moved.length === 1 && moved[0] === 'theme') { // nothing to re-render
              cfg = { ...cfg, theme: stored.theme };
              const sel = ui.panel.querySelector('#rf-theme'); if (sel) sel.value = stored.theme;
              return applyTheme();
            }
            // Shortlist-only (ticks, its order, the visit stamp): taken quietly, redrawn only on the Shortlist,
            // so another tab's tick doesn't move this tab's Results.
            if (moved.every((k) => SL_ONLY.includes(k))) {
              cfg = { ...cfg, ...Object.fromEntries(moved.map((k) => [k, stored[k]])) };
              for (const k of moved) { const el = ui.panel.querySelector(`#rf-${k}`); if (el) el.value = stored[k]; }
              if (ui.view === 'shortlist') renderShortlist();
              return;
            }
            ui.applyCfg({ ...cfg, ...Object.fromEntries(moved.map((k) => [k, stored[k]])) });
            if (document.getElementById('rf-lbar')) renderListingBar(); // its checklist, deadline and notice follow too
          }
        })));
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
        // Restoring remembered results (parse, rebuild rows, render) is the rest of the cost: its own task too.
        setTimeout(() => {
          step('restore', restore);
          step('launch to-do', () => { ui.countTodo = true; setLaunchCount(ui.launchN ?? null); });
          step('listing bar', () => {
            renderListingBar();
            window.addEventListener('rf:navigate', () => setTimeout(() => renderListingBar({ onlyIfMoved: true }), NAV_SETTLE_MS));
          });
          step('saved', renderSaved);
          step('remind', remindSaved);
          step('backup nudge', nudgeBackup);
          step('safety copy', () => (typeof indexedDB === 'undefined' ? null : offerMirror()));
          step('annotate', ensureVisiblePage);
          ui.panel.dataset.rfReady = '1'; // every startup step has run (tests wait on it)
          if (ui.openWhenReady) { ui.openWhenReady = false; ui.launch.click(); }
        }, 0);
      }, 0);
    }
  }
  if (wanted(location.href)) start();
  else {
    let awake = false;
    // After REA's own pushState returns, not inside it: building is the heavy part.
    const wake = () => { if (awake || !wanted(location.href)) return; awake = true; window.removeEventListener('popstate', wake); setTimeout(start, 0); };
    for (const fn of ['pushState', 'replaceState']) {
      const orig = history[fn];
      history[fn] = function (...args) { const r = orig.apply(this, args); wake(); return r; };
    }
    window.addEventListener('popstate', wake);
  }
  // #endregion
})();

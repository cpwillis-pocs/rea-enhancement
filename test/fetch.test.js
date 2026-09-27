'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./clock');
const core = require('../rea-availability-filter.user.js');
const { listing, results, page, memStorage } = require('./helpers');

const BASE = 'https://www.realestate.com.au/rent/in-bondi/list-1';
const resp = (status, body = '', headers = {}) => ({
  status, ok: status >= 200 && status < 300,
  text: async () => body,
  headers: { get: (h) => headers[h] ?? null },
});
const noWait = async () => {};

test('fetchResults: retries 429 then succeeds, honours Retry-After', async () => {
  const waits = [];
  const seq = [resp(429, '', { 'Retry-After': '2' }), resp(503), resp(200, page(results({ exact: [listing()] })))];
  const r = await core.fetchResults(BASE, { fetchImpl: async () => seq.shift(), wait: async (ms) => waits.push(ms) });
  assert.equal(r.exact.items.length, 1);
  assert.equal(waits[0], 2000);
  assert.equal(waits.length, 2);
});

test('fetchResults: gives up after retries with rate-limit message', async () => {
  await assert.rejects(core.fetchResults(BASE, { fetchImpl: async () => resp(429), wait: noWait }), /Rate limited/);
});

test('fetchResults: 404 fails without retry', async () => {
  let calls = 0;
  await assert.rejects(core.fetchResults(BASE, { fetchImpl: async () => (calls++, resp(404)), wait: noWait }), /HTTP 404/);
  assert.equal(calls, 1);
});

test('fetchResults: network error retried', async () => {
  let calls = 0;
  const fetchImpl = async () => { if (calls++ === 0) throw new Error('reset'); return resp(200, page(results())); };
  await core.fetchResults(BASE, { fetchImpl, wait: noWait });
  assert.equal(calls, 2);
});

test('fetchAllPages: walks pages, reuses seed, flags truncation', async () => {
  const urls = [];
  const fetchImpl = async (u) => {
    urls.push(u);
    const n = +u.match(/list-(\d+)/)[1];
    return resp(200, page(results({ exact: [listing({ id: `p${n}` })], maxPage: 25 })));
  };
  const seed = { key: core.searchKey(BASE), page: 2, results: results({ exact: [listing({ id: 'seed' })], maxPage: 25 }) };
  const r = await core.fetchAllPages(BASE, () => {}, { seed, fetchImpl, wait: noWait });
  assert.equal(r.rows.length, 20);
  assert.equal(r.truncated, true);
  assert.ok(!urls.some((u) => /list-2$/.test(u)), 'seeded page not refetched');
  assert.ok(r.rows[1].url.endsWith('seed'));
});

test('fetchAllPages: ignores seed from a different search', async () => {
  const urls = [];
  const fetchImpl = async (u) => (urls.push(u), resp(200, page(results({ exact: [listing()] }))));
  const seed = { key: core.searchKey('https://www.realestate.com.au/rent/in-manly/list-1'), page: 1, results: results() };
  await core.fetchAllPages(BASE, () => {}, { seed, fetchImpl, wait: noWait });
  assert.equal(urls.length, 1);
});

test('searchKey / pageNum', () => {
  assert.equal(core.searchKey('https://www.realestate.com.au/rent/in-bondi/map-4?x=1#top'), 'https://www.realestate.com.au/rent/in-bondi/list-1?x=1');
  assert.equal(core.pageNum('https://www.realestate.com.au/rent/in-bondi/list-4'), 4);
  assert.equal(core.pageNum('https://www.realestate.com.au/rent/in-bondi/'), 1);
});

test('fetchResults: abort is not retried; Retry-After capped', async () => {
  const ctrl = new AbortController();
  let calls = 0;
  const fetchImpl = async () => { calls++; ctrl.abort(); throw new DOMException('aborted', 'AbortError'); };
  await assert.rejects(core.fetchResults(BASE, { fetchImpl, wait: noWait, signal: ctrl.signal }));
  assert.equal(calls, 1);
  const waits = [];
  const seq = [resp(429, '', { 'Retry-After': '3600' }), resp(200, page(results()))];
  await core.fetchResults(BASE, { fetchImpl: async () => seq.shift(), wait: async (ms) => waits.push(ms) });
  assert.equal(waits[0], 60000);
});

test('fetchAllPages: abort mid-crawl stops further fetches', async () => {
  const ctrl = new AbortController();
  const urls = [];
  const fetchImpl = async (u) => { urls.push(u); if (urls.length === 2) ctrl.abort(); return resp(200, page(results({ exact: [listing()], maxPage: 10 }))); };
  await assert.rejects(core.fetchAllPages(BASE, () => {}, { fetchImpl, wait: noWait, signal: ctrl.signal }));
  assert.equal(urls.length, 2);
});

test('sleep: aborts early and when already aborted', async () => {
  const ctrl = new AbortController();
  const p = core.sleep(10000, ctrl.signal);
  ctrl.abort(new Error('stop'));
  await assert.rejects(p, /stop/);
  await assert.rejects(core.sleep(1, ctrl.signal), /stop/);
  await core.sleep(1); // no signal resolves
});

test('parseExchange: falls back to a renamed app key or query field by shape, and says so', () => {
  const { exchange, results, listing } = require('./helpers');
  const res = results({ exact: [listing({ id: '146500001' })], maxPage: 1 });
  const known = exchange(res);
  assert.equal(core.parseExchange(known).exact.items.length, 1);
  assert.equal(core.resultsPath.fallback, false);
  const cache = known['resi-property_listing-experience-web'].urqlClientCache;
  const renamedApp = { 'resi-rent-web-v2': { urqlClientCache: cache } };
  assert.equal(core.parseExchange(renamedApp).exact.items.length, 1);
  assert.deepEqual([core.resultsPath.key, core.resultsPath.fallback], ['resi-rent-web-v2', true]);
  const renamedField = { 'resi-property_listing-experience-web': { urqlClientCache: JSON.stringify({ 1: { data: JSON.stringify({ rentalSearch: { results: res } }) } }) } };
  assert.equal(core.parseExchange(renamedField).exact.items.length, 1);
  assert.equal(core.resultsPath.field, 'rentalSearch');
  const lookalike = { other: { urqlClientCache: JSON.stringify({ 1: { data: JSON.stringify({ agents: { results: { items: [] } } }) } }) } };
  assert.throws(() => core.parseExchange(lookalike), /No rentSearch results/);
});

test('fetchAllPages keepPartial: a later page failing returns what was read; page 1 or a cancel still throws', async () => {
  const { results, listing } = require('./helpers');
  const pages = (fail) => async (url) => {
    const n = +url.match(/list-(\d+)/)[1];
    if (n === fail) throw new Error('bot-check');
    return results({ exact: [listing({ id: String(146500100 + n) })], maxPage: 4 });
  };
  const base = 'https://www.realestate.com.au/rent/in-bondi/list-1';
  const out = await core.fetchAllPages(base, () => {}, { getPage: pages(3), keepPartial: true, wait: async () => {} });
  assert.equal(out.rows.length, 2);
  assert.deepEqual([out.failed.page, out.failed.max], [3, 4]);
  await assert.rejects(core.fetchAllPages(base, () => {}, { getPage: pages(3), wait: async () => {} }), /bot-check/, 'default still throws');
  await assert.rejects(core.fetchAllPages(base, () => {}, { getPage: pages(1), keepPartial: true, wait: async () => {} }), /bot-check/);
  let waits = 0;
  await core.fetchAllPages(base, () => {}, { getPage: pages(0), wait: async () => { waits++; }, isCached: (u) => /list-[23]/.test(u) });
  assert.equal(waits, 1, 'no pause before cached pages');
});

test('bot checks are flagged for pausing: 403, 429 after every retry, a page without results; 404 and network errors are not', async () => {
  const flag = async (fetchImpl) => { try { await core.fetchResults(BASE, { fetchImpl, wait: noWait }); } catch (e) { return !!e.botCheck; } return null; };
  assert.equal(await flag(async () => resp(403)), true);
  assert.equal(await flag(async () => resp(429)), true);
  assert.equal(await flag(async () => resp(200, '<html>Please verify you are a human</html>')), true);
  assert.equal(await flag(async () => resp(404)), false);
  assert.equal(await flag(async () => { throw new Error('reset'); }), false);
});

test('pauseGate: trips for PAUSE_MS, then lifts; bad or past values mean not paused', () => {
  const m = memStorage();
  let now = 1000;
  const g = core.pauseGate(m, () => now);
  assert.equal(g.until(), 0);
  const t = g.trip();
  assert.equal(t, 1000 + core.PAUSE_MS);
  assert.equal(g.until(), t);
  assert.equal(m.getItem('rea-avail-filter/paused'), String(t));
  now = t - 1; assert.equal(g.until(), t, 'still paused a moment before');
  now = t; assert.equal(g.until(), 0, 'lifted at the time');
  m.setItem('rea-avail-filter/paused', 'junk'); assert.equal(g.until(), 0);
  now = 5000; m.setItem('rea-avail-filter/paused', '4000'); assert.equal(g.until(), 0); assert.equal(m.getItem('rea-avail-filter/paused'), null, 'expired value removed');
  g.trip(5); g.clear(); assert.equal(g.until(), 0);
});

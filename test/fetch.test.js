'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./clock');
const core = require('../rea-availability-filter.user.js');
const { listing, results, page } = require('./helpers');

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

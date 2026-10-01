'use strict';
// Catches a forgotten version bump. ROWS_VERSION must move when toRow()'s output changes shape
// (old tab caches would be read as the new shape); FEAT_V when amenity or heads-up detection
// changes (old feature signatures would be compared as if new). test/versions.json records what
// each version was set for. When this fails: bump the constant in the script (see
// docs/ARCHITECTURE.md "Versions that must move"), then `UPDATE_VERSIONS=1 node --test test/versions.test.js`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('./clock');
const core = require('../rea-enhancement.user.js');
const { listing } = require('./helpers');

const FILE = path.join(__dirname, 'versions.json');
const src = fs.readFileSync(path.join(__dirname, '..', 'rea-enhancement.user.js'), 'utf8');
const constant = (name) => +(src.match(new RegExp(`const ${name} = (\\d+);`)) || [])[1];
const hash = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);
const rx = (r) => (r instanceof RegExp ? [r.source, r.flags] : r ?? null);

const now = {
  ROWS_VERSION: constant('ROWS_VERSION'),
  rowKeys: Object.keys(core.toRow(listing({ id: '146500001' }), false)).sort(),
  FEAT_V: constant('FEAT_V'),
  amenityIds: core.AMENITIES.map((a) => a.id),
  watchIds: core.WATCHOUTS.map((w) => w.id),
  detection: hash([core.AMENITIES.map((a) => [a.id, rx(a.yes), rx(a.neg), rx(a.pos), rx(a.kvNo)]), core.WATCHOUTS.map((w) => [w.id, rx(w.re), rx(w.neg)])]),
};

if (process.env.UPDATE_VERSIONS) fs.writeFileSync(FILE, `${JSON.stringify(now, null, 1)}\n`);
const was = JSON.parse(fs.readFileSync(FILE, 'utf8'));

test('ROWS_VERSION moves when toRow() output changes shape', () => {
  if (now.ROWS_VERSION === was.ROWS_VERSION) assert.deepEqual(now.rowKeys, was.rowKeys, 'toRow() fields changed: bump ROWS_VERSION');
  else assert.ok(now.ROWS_VERSION > was.ROWS_VERSION, 'ROWS_VERSION only goes up');
});

test('FEAT_V moves when detection changes; amenities and heads-up are only appended', () => {
  if (now.FEAT_V === was.FEAT_V) assert.equal(now.detection, was.detection, 'amenity or heads-up patterns changed: bump FEAT_V');
  else assert.ok(now.FEAT_V > was.FEAT_V, 'FEAT_V only goes up');
  // Signatures are bit positions: an id inserted or removed anywhere but the end shifts every later one.
  assert.deepEqual(now.amenityIds.slice(0, was.amenityIds.length), was.amenityIds, 'AMENITIES: only append');
  assert.deepEqual(now.watchIds.slice(0, was.watchIds.length), was.watchIds, 'WATCHOUTS: only append');
});

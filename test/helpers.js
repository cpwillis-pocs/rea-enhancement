'use strict';
// Builds a results page shaped like REA's SSR markup: urqlClientCache is a JSON
// string whose entries carry `data` as a further JSON string.
const listing = (over = {}) => ({
  id: over.id || '1001',
  availableDate: { display: 'Available 12 Oct 2026' },
  price: { display: '$750 per week' },
  bond: { display: '$3,000' },
  address: { suburb: 'Bondi', display: { fullAddress: '1 Test St, Bondi, NSW 2026' } },
  generalFeatures: { bedrooms: { value: 2 }, bathrooms: { value: 1 }, parkingSpaces: { value: 1 } },
  propertyType: { display: 'Apartment' },
  media: { mainImage: { templatedUrl: 'https://i2.au.reastatic.net/{size}/x/main.jpg' } },
  _links: { canonical: { href: `https://www.realestate.com.au/property-apartment-nsw-bondi-${over.id || '1001'}` } },
  ...over,
});

const results = ({ exact = [], surrounding = [], maxPage = 1 } = {}) => ({
  pagination: { maxPageNumberAvailable: maxPage },
  exact: { items: exact.map((l) => ({ listing: l })) },
  surrounding: { items: surrounding.map((l) => ({ listing: l })) },
});

const exchange = (res) => ({
  'resi-property_listing-experience-web': {
    urqlClientCache: JSON.stringify({ 123: { data: JSON.stringify({ rentSearch: { results: res } }) } }),
  },
});

const page = (res) => `<html><script>window.ArgonautExchange=${JSON.stringify(exchange(res))};</script></html>`;

// localStorage stand-in: string values, length/key/removeItem, and an optional byte quota.
const memStorage = (quota = Infinity) => {
  const m = new Map();
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => {
      const size = [...m.entries()].reduce((n, [a, b]) => (a === k ? n : n + b.length), 0) + v.length;
      if (size > quota) throw new Error('QuotaExceededError');
      m.set(k, String(v));
    },
    removeItem: (k) => m.delete(k),
    _m: m,
  };
};

// Turns reaFilter.shape() output back into a listing parseRows can read: placeholders become
// plausible values (kept strings such as "$750 per week" stay as they are), so a drift report
// pasted into test/shapes/ becomes a parsing test. Values are made up; only the structure is REA's.
const SHAPE_NUM = { latitude: -33.8915, longitude: 151.2767, lat: -33.8915, lng: 151.2767, lon: 151.2767 };
let shapeSeq = 0;
const listingFromShape = (v, key = '', path = '') => {
  if (Array.isArray(v)) { // [element shape, "(n items)"]
    const n = Math.min(+(String(v[1] || '').match(/^\((\d+) items\)$/) || [])[1] || 1, 20);
    return v.length ? Array.from({ length: n }, () => listingFromShape(v[0], key, path)) : [];
  }
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, listingFromShape(x, k, `${path}.${k}`)]));
  if (v === 'url') {
    if (/templated|image|photo|media/i.test(path)) return 'https://i2.au.reastatic.net/{size}/shape/main.jpg';
    return `https://www.realestate.com.au/property-apartment-nsw-bondi-${146600000 + (shapeSeq++ % 1000)}`;
  }
  if (v === 'iso-date') return /inspect|start|open/i.test(path) ? '2026-10-03T00:30:00.000Z' : '2026-09-01T00:00:00.000Z';
  if (v === 'number') return SHAPE_NUM[key] ?? (/^id$/i.test(key) ? 146600000 : 1);
  if (v === 'boolean') return true;
  if (v === '…') return null;
  const m = typeof v === 'string' && v.match(/^string\((\d+)\)$/);
  if (m) return /^id$/i.test(key) ? '146600000' : 'x'.repeat(Math.max(1, Math.min(+m[1], 400)));
  return v;
};

module.exports = { listing, results, exchange, page, memStorage, listingFromShape };

'use strict';
// Realistic-looking stand-in for an REA results page: <article> cards with photo,
// price, address, features. Fictional data only; images are generated SVGs.
const { listing, results, exchange } = require('../helpers');

const ORIGIN = 'https://www.realestate.com.au';
const SUBURB = 'Bondi, NSW 2026';
const streets = ['Curlewis St', 'Hall St', 'Glenayr Ave', 'Warners Ave', 'Beach Rd', 'Roscoe St', 'Gould St', 'Lamrock Ave', 'Blair St', 'Wairoa Ave'];
const dates = ['Available now', 'Available 12 Oct 2026', 'Available Mon 2nd Nov', 'Contact agent', 'Available 20/12/2026',
  'Available 28 Oct 2026', 'Available Sat 7th Nov', 'Available 1 Dec 2026', 'Available 15 Oct 2026', 'Available now'];
const types = ['Apartment', 'Apartment', 'House', 'Unit', 'Townhouse', 'Studio'];
const hue = (i) => [200, 28, 150, 265, 340, 90, 180, 10, 230, 50][i % 10];

const photo = (i) => `<svg xmlns="http://www.w3.org/2000/svg" width="690" height="520" viewBox="0 0 690 520">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue(i)},45%,72%)"/><stop offset="1" stop-color="hsl(${hue(i) + 30},40%,48%)"/></linearGradient></defs>
<rect width="690" height="520" fill="url(#g)"/><rect x="180" y="190" width="330" height="230" fill="rgba(255,255,255,.55)"/>
<polygon points="150,200 345,90 540,200" fill="rgba(255,255,255,.7)"/><rect x="310" y="310" width="70" height="110" fill="rgba(0,0,0,.25)"/></svg>`;

// extras: a few listings carry text-only facts (apply portal, lease terms, availability in the
// description) and share buildings/addresses, for the tests of those features.
const EXTRAS = {
  0: { description: 'Pets considered on application. Apply via 2Apply. 12 month lease.' },
  1: { availableDate: null, description: 'Sorry, no pets. Available from 1st December 2026. Inspections strictly by appointment.' },
  2: { address: '7/2 Curlewis St' }, // same building as listing 0 (10/2 Curlewis St)
  3: { address: '10/2 Curlewis St', listingCompany: { name: 'Other Agency' } }, // same unit, second agency
  4: { description: '6 month lease only. Dishwasher.' },
  5: { title: 'DEPOSIT TAKEN - Bright 2 bed', description: 'Professional clean required on vacating.' },
};
// noInspectFor: ids whose open homes were cancelled (the rest keep theirs).
function pageResults(n, { pages = 3, perPage = 6, noInspections = false, extras = false, noInspectFor = [] } = {}) {
  const items = [];
  for (let i = 0; i < perPage; i++) {
    const k = (n - 1) * perPage + i;
    const beds = [1, 2, 2, 3, 0, 4][k % 6];
    const id = String(146500000 + k);
    const x = extras ? EXTRAS[k] || {} : {};
    items.push(listing({
      id,
      availableDate: 'availableDate' in x ? x.availableDate : { display: dates[k % dates.length] },
      price: { display: k % 7 === 3 ? 'Contact agent' : `$${550 + ((k * 137) % 900)} per week` },
      bond: { display: `$${(550 + ((k * 137) % 900)) * 4}` },
      address: { suburb: 'Bondi', display: { fullAddress: `${x.address || `${10 + k * 3}/${k + 2} ${streets[k % streets.length]}`}, ${SUBURB}` },
        location: { latitude: -33.8915 + k * 0.004, longitude: 151.2767 - k * 0.006 } },
      generalFeatures: { bedrooms: { value: beds }, bathrooms: { value: Math.max(1, beds - 1) }, parkingSpaces: { value: k % 3 } },
      propertyType: { display: beds === 0 ? 'Studio' : types[k % 5] },
      media: { mainImage: { templatedUrl: `https://i2.au.reastatic.net/{size}/fixture/${k}.svg` }, images: new Array(4 + (k % 9)).fill(0),
        floorplans: k % 2 ? [] : [0] },
      listingCompany: x.listingCompany || { name: ['Bondi Realty', 'Harbour Property Co', 'Eastside Agents'][k % 3] },
      _links: { canonical: { href: `${ORIGIN}/property-apartment-nsw-bondi-${id}` } },
      title: x.title || ['Light-filled with harbour glimpses', 'Renovated with pool', 'Moments to the beach', 'Quiet leafy street'][k % 4],
      inspections: noInspections || k % 2 || noInspectFor.includes(id) ? [] : [{ startTime: new Date(Date.UTC(2026, 8, 26 + (k % 3), 0, 30)).toISOString() }],
      description: x.description || ['Pets considered on application. Split system air conditioning.', 'Sorry, no pets. Dishwasher and sunny balcony.',
        'Offered unfurnished. Built-in robes throughout. Water usage charged to tenant.'][k % 3],
    }));
  }
  return results({ exact: items, maxPage: pages });
}

const reaPage = (n, opts) => {
  const r = pageResults(n, opts);
  const tag = opts?.cardTag || 'article'; // cardTag: 'div' mimics REA dropping <article>
  const cards = r.exact.items.map(({ listing: l }, i) => `
    <${tag} class="rc">
      <a class="rc-img" href="${l._links.canonical.href.replace(ORIGIN, '')}"><img src="${l.media.mainImage.templatedUrl.replace('{size}', '800x600')}" alt=""></a>
      <div class="rc-body">
        <div class="rc-price">${l.price.display}</div>
        <a class="rc-addr" href="${l._links.canonical.href.replace(ORIGIN, '')}">${l.address.display.fullAddress}</a>
        <div class="rc-feat">${l.generalFeatures.bedrooms.value} bed · ${l.generalFeatures.bathrooms.value} bath · ${l.generalFeatures.parkingSpaces.value} car · ${l.propertyType.display}</div>
      </div>
    </${tag}>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Real Estate & Property for Rent in ${SUBURB}</title>
<style>
body{margin:0;font:14px/1.4 Helvetica,Arial,sans-serif;background:#f3f3f5;color:#3b3b45}
header{height:64px;background:#fff;border-bottom:1px solid #e0e0e6;display:flex;align-items:center;padding:0 32px;gap:24px}
.logo{width:120px;height:26px;border-radius:4px;background:#e4002b;opacity:.85}
.search{flex:0 1 520px;height:40px;border:1px solid #ccc;border-radius:20px;padding:0 16px;display:flex;align-items:center;color:#777}
main{max-width:760px;margin:24px auto;padding:0 16px;display:grid;gap:20px}
h1{font-size:20px;margin:0;color:#222}
.rc{background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.rc-img img{display:block;width:100%;height:300px;object-fit:cover}
.rc-body{padding:14px 18px}.rc-price{font-size:18px;font-weight:700;color:#222}
.rc-addr{display:block;color:#3b3b45;text-decoration:none;margin-top:2px}.rc-feat{color:#777;margin-top:6px}
</style></head><body>
<header><div class="logo"></div><div class="search">${SUBURB}</div></header>
<main><h1>Rental properties in ${SUBURB}</h1>${cards}</main>
<script>window.ArgonautExchange=${JSON.stringify(exchange(r))};</script></body></html>`;
};

// Route handler for page.route('**/*').
const serve = (hits = [], opts) => (route) => {
  const u = new URL(route.request().url());
  if (u.hostname.endsWith('reastatic.net')) {
    const i = +(u.pathname.match(/(\d+)\.svg$/)?.[1] || 0);
    return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: photo(i) });
  }
  if (u.origin !== ORIGIN) return route.fulfill({ status: 204, body: '' });
  // Listing pages: a different app key and nested JSON strings, as a real property page may use.
  // Ids ending in 3 are gone (404); others report a new price.
  const prop = u.pathname.match(/^\/property-.*-(\d+)$/);
  if (prop) {
    const id = prop[1];
    if (id.endsWith('3')) return route.fulfill({ status: 404, contentType: 'text/html', body: 'Not found' });
    const l = pageResults(1, { pages: 4, perPage: 24 }).exact.items.map((i) => i.listing).find((x) => x.id === id) || listing({ id });
    const data = { details: { listing: { ...l, price: { display: '$999 per week' } } } };
    const ex = { 'resi-property_details-web': { urqlClientCache: JSON.stringify({ q1: { data: JSON.stringify(data) } }) } };
    return route.fulfill({ status: 200, contentType: 'text/html', body: `<html><body><script>window.ArgonautExchange=${JSON.stringify(ex)};</script></body></html>` });
  }
  if (!u.pathname.startsWith('/rent/')) return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><main>home</main>' });
  const n = +(u.pathname.match(/list-(\d+)/)?.[1] || 1);
  hits.push(n);
  return route.fulfill({ status: 200, contentType: 'text/html', body: reaPage(n, opts) });
};

module.exports = { ORIGIN, pageResults, reaPage, serve };

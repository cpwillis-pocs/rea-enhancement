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

// A drawn street scene per listing (house, apartment block or terrace row), so screenshots look
// like listings without using anyone's photos. Deterministic per index.
const photo = (i) => {
  const h = hue(i), kind = i % 3, wall = `hsl(${(h + 20) % 360},28%,${kind === 1 ? 88 : 82}%)`, trim = `hsl(${h},30%,34%)`;
  const win = (x, y, w = 46, ht = 54) => `<rect x="${x}" y="${y}" width="${w}" height="${ht}" rx="3" fill="#cfe6f5" stroke="${trim}" stroke-width="5"/><line x1="${x + w / 2}" y1="${y}" x2="${x + w / 2}" y2="${y + ht}" stroke="${trim}" stroke-width="3"/>`;
  const tree = (x, s) => `<rect x="${x - 6}" y="${430 - 70 * s}" width="12" height="${70 * s}" fill="#7a5a3a"/><circle cx="${x}" cy="${430 - 80 * s}" r="${46 * s}" fill="hsl(120,32%,${36 + (i % 4) * 4}%)"/><circle cx="${x - 26 * s}" cy="${430 - 58 * s}" r="${30 * s}" fill="hsl(118,30%,${33 + (i % 3) * 4}%)"/>`;
  const house = `<polygon points="160,250 345,120 530,250" fill="${trim}"/><rect x="190" y="245" width="310" height="185" fill="${wall}"/>
    ${win(220, 290)}${win(424, 290)}<rect x="318" y="320" width="54" height="110" rx="4" fill="hsl(${h},45%,40%)"/><circle cx="360" cy="378" r="4" fill="#f4d58d"/>`;
  const block = `<rect x="200" y="96" width="290" height="334" fill="${wall}"/><rect x="200" y="88" width="290" height="16" fill="${trim}"/>
    ${[0, 1, 2, 3].map((r) => [0, 1, 2].map((c) => win(222 + c * 92, 120 + r * 72, 64, 44)).join('') + `<rect x="210" y="${168 + r * 72}" width="270" height="7" fill="${trim}" opacity=".55"/>`).join('')}`;
  const terrace = [0, 1, 2].map((k) => `<rect x="${150 + k * 130}" y="210" width="130" height="220" fill="hsl(${(h + k * 25) % 360},30%,${80 - k * 4}%)" stroke="${trim}" stroke-width="2"/>
    <polygon points="${150 + k * 130},212 ${215 + k * 130},160 ${280 + k * 130},212" fill="${trim}"/>${win(165 + k * 130, 240, 40, 50)}${win(225 + k * 130, 240, 40, 50)}<rect x="${195 + k * 130}" y="335" width="40" height="95" rx="3" fill="hsl(${h},40%,38%)"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="690" height="520" viewBox="0 0 690 520">
<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${200 + (i % 4) * 6},70%,${70 + (i % 3) * 4}%)"/><stop offset="1" stop-color="hsl(${30 + (i % 5) * 8},80%,90%)"/></linearGradient></defs>
<rect width="690" height="520" fill="url(#sky)"/><circle cx="${560 - (i % 4) * 90}" cy="${86 + (i % 3) * 14}" r="34" fill="#fff4c9" opacity=".9"/>
<path d="M0 360 Q170 300 345 345 T690 330 V520 H0 Z" fill="hsl(130,24%,${62 + (i % 3) * 4}%)"/>
${tree(80, 1)}${[house, block, terrace][kind]}${tree(612, 0.85)}
<rect y="430" width="690" height="90" fill="hsl(105,34%,${44 + (i % 4) * 3}%)"/><rect x="${kind === 1 ? 300 : 318}" y="430" width="${kind === 1 ? 90 : 54}" height="90" fill="#d9d4c7"/></svg>`;
};

// extras: a few listings carry text-only facts (apply portal, lease terms, availability in the
// description) and share buildings/addresses, for the tests of those features.
const EXTRAS = {
  0: { description: 'Pets considered on application. Apply via 2Apply. 12 month lease.' },
  1: { availableDate: null, description: 'Sorry, no pets. Available from 1st December 2026. Inspections strictly by appointment.' },
  2: { address: '7/2 Curlewis St', propertySizes: { building: { displayValue: '85', sizeUnit: { displayValue: 'm²' } } } }, // same building as listing 0 (10/2 Curlewis St); REA's floor size
  3: { address: '10/2 Curlewis St', listingCompany: { name: 'Other Agency' } }, // same unit, second agency
  4: { description: '6 month lease only. Dishwasher.' },
  5: { title: 'DEPOSIT TAKEN - Bright 2 bed', description: 'Professional clean required on vacating.' },
  6: { description: 'Apartment above a popular bar, on a busy road. Walk to the station.' },
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
      ...(x.propertySizes ? { propertySizes: x.propertySizes } : {}),
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
  const href = (l) => (opts?.noCardLinks ? '#' : l._links.canonical.href.replace(ORIGIN, '')); // noCardLinks: cards we can't recognise
  const cards = r.exact.items.map(({ listing: l }, i) => `
    <${tag} class="rc">
      <a class="rc-img" href="${href(l)}"><img src="${l.media.mainImage.templatedUrl.replace('{size}', '800x600')}" alt=""></a>
      <div class="rc-body">
        <div class="rc-price">${l.price.display}</div>
        <a class="rc-addr" href="${href(l)}">${l.address.display.fullAddress}</a>
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

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

module.exports = { listing, results, exchange, page };

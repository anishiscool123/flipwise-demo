const EBAY_API = 'https://api.ebay.com';
const EBAY_SCOPE = 'https://api.ebay.com/oauth/api_scope';
const BRAVE_API = 'https://api.search.brave.com/res/v1/web/search';
const MAX_QUERY_LENGTH = 120;
const MAX_IMAGE_BASE64 = 6_000_000;
const MARKETPLACES = [
  { name: 'Depop', host: 'depop.com' },
  { name: 'eBay', host: 'ebay.com' },
  { name: 'Poshmark', host: 'poshmark.com' },
  { name: 'Mercari', host: 'mercari.com' },
  { name: 'Vinted', host: 'vinted.com' },
  { name: 'Grailed', host: 'grailed.com' },
  { name: 'Etsy · vintage', host: 'etsy.com' }
];

function json(body, status, origin, env) {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin'
  });
  const allowed = env.ALLOWED_ORIGIN || '*';
  if (allowed === '*' || origin === allowed) headers.set('Access-Control-Allow-Origin', allowed === '*' ? '*' : origin);
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
}

function siteFor(urlString) {
  try {
    const pageUrl = new URL(urlString);
    if (pageUrl.protocol !== 'https:') return null;
    const host = pageUrl.hostname.toLowerCase();
    return MARKETPLACES.find(m => host === m.host || host.endsWith(`.${m.host}`)) || null;
  } catch {
    return null;
  }
}

function extractPrice(result) {
  const walk = value => {
    if (!value || typeof value !== 'object') return null;
    if (!Array.isArray(value) && value.price != null && /product|offer/i.test(String(value['@type'] || value.type || ''))) {
      const amount = Number(String(value.price).replace(/[^\d.]/g, ''));
      if (Number.isFinite(amount) && amount > 0) return { value: amount, quality: 'structured' };
    }
    for (const child of Object.values(value)) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  for (const schema of result.schemas || []) {
    const structured = walk(schema);
    if (structured) return structured;
  }
  const text = [result.title, result.description, ...(result.extra_snippets || [])].join(' ');
  const match = text.match(/(?:US\s*)?\$\s?([0-9][0-9,]*(?:\.\d{1,2})?)/i);
  if (match) {
    const amount = Number(match[1].replace(/,/g, ''));
    if (Number.isFinite(amount) && amount > 0) return { value: amount, quality: 'snippet' };
  }
  return { value: null, quality: 'unavailable' };
}

async function ebayToken(env) {
  if (!env.EBAY_CLIENT_ID || !env.EBAY_CLIENT_SECRET) return null;
  const credentials = btoa(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`);
  const res = await fetch(`${EBAY_API}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: EBAY_SCOPE })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(`eBay authentication failed (${res.status})`);
  return data.access_token;
}

async function searchEbay(token, query, imageBase64 = '') {
  const endpoint = imageBase64 ? 'search_by_image' : 'search';
  const url = new URL(`${EBAY_API}/buy/browse/v1/item_summary/${endpoint}`);
  url.searchParams.set('limit', '30');
  if (query && !imageBase64) url.searchParams.set('q', query);
  const res = await fetch(url, {
    method: imageBase64 ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
      'Accept-Language': 'en-US',
      ...(imageBase64 ? { 'Content-Type': 'application/json' } : {})
    },
    ...(imageBase64 ? { body: JSON.stringify({ image: imageBase64 }) } : {})
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`eBay listing search failed (${res.status}); check production API access.`);
  return (data.itemSummaries || []).flatMap(item => {
    const price = Number(item.price?.value);
    let url;
    try { url = new URL(item.itemWebUrl); } catch { return []; }
    if (!Number.isFinite(price) || price <= 0 || url.protocol !== 'https:' || !/(^|\.)ebay\.com$/i.test(url.hostname)) return [];
    return [{
      id: item.itemId || item.legacyItemId || url.href,
      title: item.title || 'eBay listing',
      price,
      priceQuality: 'structured',
      currency: item.price?.currency || 'USD',
      url: url.href,
      condition: item.condition || 'Condition not specified',
      age: [item.itemLocation?.city, item.buyingOptions?.join(', ')].filter(Boolean).join(' · '),
      marketplace: 'eBay',
      sourceKind: 'official-api'
    }];
  });
}

async function searchBrave(env, query, marketplace) {
  const url = new URL(BRAVE_API);
  url.searchParams.set('q', `${query} site:${marketplace.host}`);
  url.searchParams.set('country', 'US');
  url.searchParams.set('search_lang', 'en');
  url.searchParams.set('count', '5');
  const res = await fetch(url, { headers: { Accept: 'application/json', 'X-Subscription-Token': env.BRAVE_API_KEY } });
  if (!res.ok) throw new Error(`Web search for ${marketplace.name} failed (${res.status})`);
  const data = await res.json();
  return (data.web?.results || []).flatMap(result => {
    const source = siteFor(result.url);
    if (!source) return [];
    const price = extractPrice(result);
    return [{
      id: result.url,
      title: result.title || `${source.name} result`,
      price: price.value,
      priceQuality: price.quality,
      currency: 'USD',
      url: result.url,
      condition: 'Check listing',
      age: result.age || result.page_age || 'Web result',
      marketplace: source.name,
      snippet: result.description || '',
      sourceKind: 'web-index'
    }];
  });
}

async function runSearch({ query, imageBase64 }, env) {
  if (!env.BRAVE_API_KEY) throw new Error('Add a Brave Search API key to search the resale sites.');
  let ebayItems = [];
  let ebayWarning = '';
  let searchTerms = query ? [query] : [];
  if (env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET) {
    try {
      const token = await ebayToken(env);
      ebayItems = await searchEbay(token, query, imageBase64);
      if (imageBase64 && !query) searchTerms = ebayItems.slice(0, 1).map(item => item.title);
    } catch (error) {
      ebayWarning = error instanceof Error ? error.message : 'eBay API search failed.';
      if (imageBase64 && !query) throw error;
    }
  } else if (imageBase64 && !query) {
    throw new Error('Photo-only search needs eBay Browse API credentials to identify a starting item. Enter a brand or model to search all resale sites by text.');
  }
  if (!searchTerms.length) throw new Error('No item description was found. Enter a brand or model and try again.');
  const webResults = await Promise.allSettled(searchTerms.slice(0, 3).flatMap(term =>
    MARKETPLACES.filter(m => m.name !== 'eBay' || !ebayItems.length).map(marketplace => searchBrave(env, term, marketplace))
  ));
  const items = [...ebayItems];
  const failures = [];
  for (const result of webResults) {
    if (result.status === 'fulfilled') items.push(...result.value);
    else failures.push(result.reason?.message || 'Some marketplace results were unavailable.');
  }
  const unique = [...new Map(items.map(item => [item.url, item])).values()];
  if (!unique.length && failures.length) throw new Error('Marketplace search failed. Check your API access and try again.');
  return {
    provider: 'Marketplace search',
    query: query || 'Photo match candidates',
    searchType: imageBase64 ? 'image + marketplace keywords' : 'marketplace keywords',
    count: unique.length,
    pricedCount: unique.filter(item => item.price).length,
    searchedAt: new Date().toISOString(),
    marketplaces: MARKETPLACES.map(m => m.name),
    pricingNote: 'eBay prices come from structured active listings. Other prices are parsed from indexed page data or snippets when found; confirm each listing. Active asking prices are not sold prices.',
    warning: [failures.length ? `${failures.length} marketplace searches did not return results.` : '', ebayWarning].filter(Boolean).join(' '),
    items: unique
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return json({}, 204, origin, env);
    if (url.pathname !== '/health' && (!env.ALLOWED_ORIGIN || origin !== env.ALLOWED_ORIGIN)) {
      return json({ error: 'This Flipwise site is not allowed to use the search service.' }, 403, origin, env);
    }
    if (url.pathname === '/health') return json({ ok: true, provider: 'Marketplace search' }, 200, origin, env);
    let query = '';
    let imageBase64 = '';
    if (url.pathname === '/search' && request.method === 'GET') {
      query = (url.searchParams.get('q') || '').trim().replace(/\s+/g, ' ');
      if (query.length < 2 || query.length > MAX_QUERY_LENGTH) return json({ error: `Search text must be between 2 and ${MAX_QUERY_LENGTH} characters.` }, 400, origin, env);
    } else if (url.pathname === '/search-by-image' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      query = typeof body.query === 'string' ? body.query.trim().replace(/\s+/g, ' ') : '';
      imageBase64 = typeof body.imageBase64 === 'string' ? body.imageBase64 : '';
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64) || imageBase64.length > MAX_IMAGE_BASE64) {
        return json({ error: 'Upload a JPG photo smaller than 4 MB to search by image.' }, 400, origin, env);
      }
      if (query.length > MAX_QUERY_LENGTH) return json({ error: `Search text must be at most ${MAX_QUERY_LENGTH} characters.` }, 400, origin, env);
    } else {
      return json({ error: 'Use GET /search?q=brand%20item or POST /search-by-image.' }, 404, origin, env);
    }
    try {
      const results = await runSearch({ query, imageBase64 }, env);
      return json(results, 200, origin, env);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Marketplace search is unavailable.' }, 502, origin, env);
    }
  }
};

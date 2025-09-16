// Cloudflare Worker: iPhone 17 pickup availability for Apple Taiwan
// - Scrapes part numbers from the official /tw buy page (script#metrics)
// - Calls Apple's fulfillment-messages API to retrieve in-store pickup windows
// - Serves a Tailwind mobile-first UI and a JSON API

const DEFAULT_APPLE_BASE = "https://www.apple.com";
const DEFAULT_REGION_PATH = "/tw";
const DEFAULT_LOCATION_SEEDS = ["Taiwan"];
const DEFAULT_FAMILIES = ["iphone-17", "iphone-17-pro", "iphone-air"];

function getConfig(env) {
  return {
    APPLE_BASE: (env?.APPLE_BASE || DEFAULT_APPLE_BASE),
    REGION_PATH: (env?.REGION_PATH || DEFAULT_REGION_PATH),
    LOCATION_SEEDS: (env?.LOCATION_SEEDS || DEFAULT_LOCATION_SEEDS.join(",")).split(",").map(s => s.trim()).filter(Boolean),
    FAMILIES: (env?.FAMILIES || DEFAULT_FAMILIES.join(",")).split(",").map(s => s.trim()).filter(Boolean)
  };
}

function buildURL(base, params) {
  const url = new URL(base);
  Object.entries(params).forEach(([k, v]) => {
    if (Array.isArray(v)) {
      v.forEach((vv, idx) => url.searchParams.set(`${k}.${idx}`, vv));
    } else if (v !== undefined && v !== null) {
      url.searchParams.set(k, String(v));
    }
  });
  return url;
}

async function fetchPartsFromBuyPage(conf, familySlug) {
  const buyUrl = `${conf.APPLE_BASE}${conf.REGION_PATH}/shop/buy-iphone/${familySlug}`;
  const res = await fetch(buyUrl, { headers: { "User-Agent": "Mozilla/5.0 (compatible; iPhoneAvailabilityWorker/1.0)" } });
  if (!res.ok) throw new Error(`Failed to fetch buy page ${familySlug}: ${res.status}`);
  const html = await res.text();
  const m = html.match(/<script[^>]*id=\"metrics\"[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) throw new Error(`metrics script not found on ${familySlug}`);
  let metrics;
  try { metrics = JSON.parse(m[1]); } catch { throw new Error(`failed to parse metrics JSON for ${familySlug}`); }
  const products = (metrics?.data?.products || []).filter(p => p?.partNumber && p?.category === "iphone");
  // Trim to only the fields the UI needs
  return products.map(p => ({ name: p.name || p.sku || p.partNumber, partNumber: p.partNumber, price: p.price?.fullPrice }));
}

async function fetchIphonePartsForFamilies(conf, families) {
  const seen = new Set();
  const parts = [];
  // Fetch all family buy pages in parallel, but keep merge order by families[]
  const results = await Promise.all(
    families.map(slug =>
      fetchPartsFromBuyPage(conf, slug).catch(() => []) // swallow per-family errors
    )
  );
  for (const list of results) {
    for (const p of list) {
      if (!seen.has(p.partNumber)) {
        seen.add(p.partNumber);
        parts.push(p);
      }
    }
  }
  if (!parts.length) throw new Error("no iPhone family parts discovered");
  return parts;
}

async function fetchFulfillmentForSeed(conf, partNumbers, seed) {
  const url = buildURL(`${conf.APPLE_BASE}${conf.REGION_PATH}/shop/fulfillment-messages`, {
    pl: true,
    mt: "regular",
    searchNearby: true,
    location: seed,
    parts: partNumbers,
  });
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; iPhoneAvailabilityWorker/1.0)" } });
  if (!res.ok) throw new Error(`fulfillment API failed (${seed}): ${res.status}`);
  const json = await res.json();
  return json?.body?.content?.pickupMessage?.stores || [];
}

function mergeStores(storesArr) {
  const map = new Map();
  for (const list of storesArr) {
    for (const s of list) {
      const key = s.storeNumber || `${s.country}:${s.city}:${s.storeName}`;
      if (!map.has(key)) map.set(key, s);
    }
  }
  return Array.from(map.values());
}

function normalizeAvailability(stores, parts) {
  const out = [];
  for (const s of stores) {
    const baseStore = {
      storeNumber: s.storeNumber,
      storeName: s.storeName,
      city: s.city,
      url: s.hoursUrl || s.makeReservationUrl || s.reservationUrl,
    };

    for (const part of parts) {
      const pa = s.partsAvailability?.[part.partNumber];
      if (!pa) continue;
      const msg = pa.messageTypes?.regular;
      const pickupQuote = pa.pickupSearchQuote || msg?.storePickupQuote || "Not currently available";
      out.push({
        store: baseStore,
        part: part,
        status: pa.pickupDisplay || (pa.buyability?.isBuyable ? "available" : "unavailable"),
        isBuyable: !!pa.buyability?.isBuyable,
        pickupType: pa.pickupType || "In-store pickup",
        pickupQuote: pickupQuote,
      });
    }
  }
  return out;
}

async function fetchAvailabilitySnapshot(env) {
  const conf = getConfig(env);
  const parts = await fetchIphonePartsForFamilies(conf, conf.FAMILIES);
  const storesLists = [];
  for (const seed of conf.LOCATION_SEEDS) {
    try {
      const stores = await fetchFulfillmentForSeed(conf, parts.map(p => p.partNumber), seed);
      if (stores?.length) storesLists.push(stores);
    } catch (e) {
      // swallow seed errors
    }
  }
  const stores = mergeStores(storesLists);
  const availability = normalizeAvailability(stores, parts);
  // Return compact top-level store list alongside models and availability
  const compactStores = stores.map(s => ({
    storeNumber: s.storeNumber,
    storeName: s.storeName,
    city: s.city,
    url: s.hoursUrl || s.makeReservationUrl || s.reservationUrl,
  }));
  return { generatedAt: new Date().toISOString(), models: parts, stores: compactStores, availability };
}

async function putKV(env, key, json, ttlSeconds) {
  const opts = ttlSeconds ? { expirationTtl: ttlSeconds } : undefined;
  await env.AVAIL_KV.put(key, JSON.stringify(json), opts);
}

async function getKV(env, key) {
  const v = await env.AVAIL_KV.get(key);
  return v ? JSON.parse(v) : null;
}

function makeJSON(data, { browserMaxAge = 0, edgeMaxAge = 20, swr = 90 } = {}) {
  const res = new Response(JSON.stringify(data), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      // Browser uses max-age; edge (Cloudflare) honors s-maxage; include SWR hint
      "cache-control": `public, max-age=${browserMaxAge}, s-maxage=${edgeMaxAge}, stale-while-revalidate=${swr}`
    }
  });
  return res;
}

function availabilityCacheKey(url) {
  const keyUrl = new URL(url);
  keyUrl.searchParams.delete('force');
  return new Request(keyUrl.toString(), { method: 'GET', headers: { 'accept': 'application/json' } });
}

async function refreshAvailabilityKV(env) {
  const payload = await fetchAvailabilitySnapshot(env);
  await putKV(env, 'availability.latest', payload, 60 * 15); // 15 min safety TTL
  return payload;
}

async function handleApiAvailability(env, ctx, url) {
  const force = url.searchParams.get('force') === '1';
  const cache = caches.default;
  const cacheKey = availabilityCacheKey(url);

  function computeTtls(payload){
    const hasAvail = Array.isArray(payload?.availability) && payload.availability.some(a => a?.isBuyable || a?.status === 'available');
    return { browserMaxAge: 0, edgeMaxAge: hasAvail ? 10 : 20, swr: hasAvail ? 60 : 90 };
  }

  if (!force) {
    // 1) Try edge cache first
    const edgeHit = await cache.match(cacheKey);
    if (edgeHit) {
      return edgeHit;
    }
    // 2) Fall back to KV snapshot (instant), and refresh in background
    const cached = await getKV(env, 'availability.latest');
    if (cached) {
      const payload = { source: 'kv', ...cached };
      const res = makeJSON(payload, computeTtls(payload));
      ctx.waitUntil((async () => {
        try {
          const fresh = await refreshAvailabilityKV(env);
          const freshPayload = { source: 'fresh', ...fresh };
          const freshRes = makeJSON(freshPayload, computeTtls(freshPayload));
          await cache.put(cacheKey, freshRes.clone());
        } catch {}
      })());
      // Seed edge cache with KV data so subsequent hits are instant from edge
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    }
    // 3) Warm start: trigger background build and return placeholder
    ctx.waitUntil((async () => {
      try {
        const fresh = await refreshAvailabilityKV(env);
        const freshRes = makeJSON({ source: 'fresh', ...fresh }, { browserMaxAge: 5, edgeMaxAge: 60, swr: 300 });
        await cache.put(cacheKey, freshRes.clone());
      } catch {}
    })());
    const warm = { source: 'warmup', generatedAt: new Date().toISOString(), models: [], stores: [], availability: [] };
    return makeJSON(warm, computeTtls(warm));
  }

  // Force: compute fresh, update KV and edge cache, return now
  const fresh = await refreshAvailabilityKV(env);
  const freshPayload = { source: 'fresh', ...fresh };
  const freshRes = makeJSON(freshPayload, computeTtls(freshPayload));
  ctx.waitUntil(cache.put(cacheKey, freshRes.clone()));
  return freshRes;
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, OPTIONS',
          'access-control-allow-headers': 'Content-Type'
        }});
      }
      if (url.pathname === "/api/availability") {
        return await handleApiAvailability(env, ctx, url);
      }
      return new Response("Not Found", { status: 404 });
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { "content-type": "application/json", "access-control-allow-origin": "*" }
      });
    }
  },
  async scheduled(event, env, ctx) {
    await refreshAvailabilityKV(env);
  }
};

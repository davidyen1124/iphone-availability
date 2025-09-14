// Cloudflare Worker: iPhone 17 pickup availability for Apple Taiwan
// - Scrapes part numbers from the official /tw buy page (script#metrics)
// - Calls Apple's fulfillment-messages API to retrieve in-store pickup windows
// - Serves a Tailwind mobile-first UI and a JSON API

const DEFAULT_APPLE_BASE = "https://www.apple.com";
const DEFAULT_REGION_PATH = "/tw"; // e.g., /tw
const DEFAULT_LOCATION_SEEDS = ["Taiwan"];
const DEFAULT_FAMILIES = ["iphone-17", "iphone-17-pro", "iphone-air"]; // auto-merge across these pages

function getConfig(env) {
  return {
    APPLE_BASE: (env?.APPLE_BASE || DEFAULT_APPLE_BASE),
    REGION_PATH: (env?.REGION_PATH || DEFAULT_REGION_PATH),
    LOCATION_SEEDS: (env?.LOCATION_SEEDS || DEFAULT_LOCATION_SEEDS.join(",")).split(",").map(s => s.trim()).filter(Boolean),
    FAMILIES: (env?.FAMILIES || DEFAULT_FAMILIES.join(",")).split(",").map(s => s.trim()).filter(Boolean)
  };
}

/**
 * Utility: build URL with query string params
 */
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

/**
 * Extract part numbers for iPhone 17 models from the buy page.
 * Returns an array of { name, partNumber, sku }.
 */
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
  return products.map(p => ({ name: p.name || p.sku || p.partNumber, partNumber: p.partNumber, sku: p.sku || null, family: familySlug, price: p.price?.fullPrice }));
}

async function fetchIphonePartsForFamilies(conf, families) {
  const seen = new Set();
  const parts = [];
  for (const slug of families) {
    try {
      const list = await fetchPartsFromBuyPage(conf, slug);
      for (const p of list) {
        if (!seen.has(p.partNumber)) { seen.add(p.partNumber); parts.push(p); }
      }
    } catch (e) {
      // ignore missing family pages
    }
  }
  if (!parts.length) throw new Error("no iPhone 17 family parts discovered");
  return parts;
}

/**
 * Call Apple fulfillment API for the given partNumbers and seed location.
 */
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

/**
 * Merge stores from multiple seeds by unique storeNumber.
 */
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

/**
 * Normalize availability entries into a compact structure per store per part.
 */
function normalizeAvailability(stores, parts) {
  const out = [];
  // Helpers for hours/open status in Asia/Taipei
  const zhDays = ['週日','週一','週二','週三','週四','週五','週六'];
  function getTaipeiNow() {
    const fmt = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', weekday: 'short' });
    const parts = fmt.formatToParts(new Date());
    const hh = parts.find(p=>p.type==='hour')?.value || '00';
    const mm = parts.find(p=>p.type==='minute')?.value || '00';
    const weekday = parts.find(p=>p.type==='weekday')?.value || '週日';
    const minutes = parseInt(hh,10)*60 + parseInt(mm,10);
    return { weekday, minutes };
  }
  const nowTW = getTaipeiNow();

  function expandChineseDays(str) {
    if (!str) return new Set();
    const clean = String(str).replace(/：|:/g,'').replace(/\s+/g,'');
    const tokens = clean.split(/,|，|、/).filter(Boolean);
    const set = new Set();
    for (const tk of tokens) {
      const m = tk.match(/(週[一二三四五六日])(?:-(週[一二三四五六日]))?/);
      if (m) {
        const a = zhDays.indexOf(m[1]);
        const b = m[2] ? zhDays.indexOf(m[2]) : -1;
        if (a >= 0 && b >= 0) {
          for (let i=a;i<=b;i++) set.add(zhDays[i]);
        } else if (a >= 0) {
          set.add(zhDays[a]);
        }
      }
    }
    return set;
  }

  function parseCNTimeToken(tok) {
    if (!tok) return null;
    const t = tok.replace(/\s+/g,'');
    const am = t.includes('上午') || t.toLowerCase().includes('am');
    const pm = t.includes('下午') || t.toLowerCase().includes('pm');
    const hm = t.replace('上午','').replace('下午','').replace(/am|pm/ig,'');
    const [hStr,mStr] = hm.split(':');
    let h = parseInt(hStr,10);
    let m = parseInt(mStr||'0',10);
    if (pm && h < 12) h += 12;
    if (am && h === 12) h = 0;
    return h*60 + m;
  }

  function computeOpenNow(hoursRows) {
    let todayHours = null;
    let isOpen = false;
    for (const row of hoursRows) {
      const daysSet = expandChineseDays(row.storeDays || row.days);
      if (!daysSet.size || !daysSet.has(nowTW.weekday)) continue;
      const [startRaw, endRaw] = String(row.storeTimings || row.timings || '').split('-').map(s=>s.trim());
      const startMin = parseCNTimeToken(startRaw);
      const endMin = parseCNTimeToken(endRaw);
      if (startMin != null && endMin != null) {
        todayHours = `${startRaw} - ${endRaw}`;
        let end = endMin;
        let now = nowTW.minutes;
        if (end < startMin) end += 1440;
        if (now < startMin && (end - startMin) > 720) now += 1440;
        if (now >= startMin && now <= end) isOpen = true;
        break;
      }
    }
    return { isOpen, todayHours };
  }

  for (const s of stores) {
    const baseStore = {
      storeNumber: s.storeNumber,
      storeName: s.storeName,
      city: s.city,
      phoneNumber: s.phoneNumber || s.retailStore?.phoneNumber,
      address: s.address?.address2 ? `${s.address.address2}${s.address.address3 ? " " + s.address.address3 : ""}` : s.retailStore?.address?.street,
      url: s.hoursUrl || s.makeReservationUrl || s.reservationUrl,
      latitude: s.storelatitude || s.retailStore?.latitude,
      longitude: s.storelongitude || s.retailStore?.longitude,
      image: s.storeImageUrl,
      hoursRows: (() => {
        const rows = [];
        if (Array.isArray(s.storeHours?.hours)) rows.push(...s.storeHours.hours);
        if (Array.isArray(s.storeHours)) rows.push(...s.storeHours);
        if (Array.isArray(s.retailStore?.storeHours)) rows.push(...s.retailStore.storeHours);
        return rows.map(r => ({ storeDays: r.storeDays || r.days, storeTimings: r.storeTimings || r.timings }));
      })(),
    };

    const oc = computeOpenNow(baseStore.hoursRows || []);
    baseStore.isOpen = oc.isOpen;
    baseStore.todayHours = oc.todayHours;
    const lat = baseStore.latitude, lon = baseStore.longitude;
    if (lat && lon) {
      baseStore.mapsUrl = `https://maps.apple.com/?ll=${encodeURIComponent(lat+','+lon)}&q=${encodeURIComponent(baseStore.storeName || 'Apple Store')}`;
    } else if (baseStore.address || baseStore.storeName) {
      baseStore.mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent((baseStore.storeName||'Apple Store') + ' ' + (baseStore.address||''))}`;
    }
    if (baseStore.phoneNumber) {
      const digits = String(baseStore.phoneNumber).replace(/[^+\d]/g,'');
      baseStore.phoneHref = `tel:${digits}`;
    }

    for (const part of parts) {
      const pa = s.partsAvailability?.[part.partNumber];
      if (!pa) continue;
      const msg = pa.messageTypes?.regular;
      const pickupQuote = pa.pickupSearchQuote || msg?.storePickupQuote || "目前無法提供";
      out.push({
        store: baseStore,
        part: part,
        status: pa.pickupDisplay || (pa.buyability?.isBuyable ? "available" : "unavailable"),
        isBuyable: !!pa.buyability?.isBuyable,
        pickupType: pa.pickupType || "店內取貨",
        pickupQuote: pickupQuote,
      });
    }
  }
  return out;
}

/**
 * Render the HTML UI (Tailwind CDN, mobile-first)
 */

/**
 * API handler: GET /api/availability
 */
async function buildAvailabilityPayload(env) {
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
  return { generatedAt: new Date().toISOString(), models: parts, stores: stores.map(s => ({ storeNumber: s.storeNumber, storeName: s.storeName, city: s.city })), availability };
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
  keyUrl.searchParams.delete('refresh');
  return new Request(keyUrl.toString(), { method: 'GET', headers: { 'accept': 'application/json' } });
}

async function refreshAvailabilityKV(env) {
  const payload = await buildAvailabilityPayload(env);
  await putKV(env, 'availability.latest', payload, 60 * 15); // 15 min safety TTL
  return payload;
}

async function handleApiAvailability(env, ctx, url) {
  const force = url.searchParams.get('force') === '1' || url.searchParams.get('refresh') === '1';
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
      // Static site (/) is served from public/ by Wrangler assets.
      if (url.pathname === "/api/availability") {
        return await handleApiAvailability(env, ctx, url);
      }
      if (url.pathname === "/healthz") {
        return new Response("ok", { status: 200 });
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
  // Cron job to refresh KV
  async scheduled(event, env, ctx) {
    await refreshAvailabilityKV(env);
  }
};

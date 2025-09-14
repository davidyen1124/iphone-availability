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
function renderIndexHtml() {
  const html = `<!doctype html>
<html lang="zh-Hant-TW">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>iPhone 17 系列台灣門市供貨</title>
    <meta name="description" content="自動擷取 apple.com/tw 的 iPhone 17 門市取貨可用日。" />
    <link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
      tailwind.config = {
        theme: {
          extend: {
            colors: {
              brand: {
                50: '#eef2ff', 100: '#e0e7ff', 200: '#c7d2fe', 300: '#a5b4fc', 400: '#818cf8', 500: '#6366f1', 600: '#4f46e5', 700: '#4338ca', 800: '#3730a3', 900: '#312e81'
              }
            }
          }
        }
      }
    </script>
    <style>
      .glass { backdrop-filter: blur(10px); background: rgba(255,255,255,0.65); }
      .dark .glass { background: rgba(23,23,23,0.55); }
    </style>
  </head>
  <body class="min-h-dvh bg-gradient-to-b from-brand-50 to-white text-gray-900">
    <header class="sticky top-0 z-30 border-b bg-white/70 backdrop-blur supports-[backdrop-filter]:glass">
      <div class="mx-auto max-w-5xl px-4 py-3 flex items-center gap-3">
        <div>
          <h1 class="text-lg font-semibold leading-tight">iPhone 17 系列台灣門市供貨</h1>
          <p id="subtitle" class="text-xs text-gray-500">即時擷取 Apple 官網資料</p>
        </div>
        <div class="ml-auto flex items-center gap-2">
          <button id="refreshBtn" class="rounded-lg bg-brand-600 text-white px-3 py-1.5 text-sm hover:bg-brand-700 active:scale-[.98] transition">重新整理</button>
          <button id="toggleOnlyAvail" class="rounded-lg border px-3 py-1.5 text-sm">只看可取貨</button>
        </div>
      </div>
    </header>

    <main class="mx-auto max-w-5xl px-4 pb-20 pt-4">
      <section class="mb-4">
        <div class="rounded-2xl bg-white shadow-sm ring-1 ring-black/5 overflow-hidden">
          <div class="p-4 sm:p-6">
            <h2 class="font-semibold">所有 iPhone 17 系列機型</h2>
            <p id="updated" class="text-sm text-gray-500">載入中…</p>
            <div id="models" class="mt-2 flex flex-wrap gap-2"></div>
            <div class="mt-3 flex flex-wrap items-center gap-2" id="familyFilters">
              <span class="text-xs text-gray-500 mr-1">快速篩選：</span>
              <button data-family="all" class="rounded-full border px-3 py-1 text-xs">全部</button>
              <button data-family="Standard" class="rounded-full border px-3 py-1 text-xs">標準款</button>
              <button data-family="Pro" class="rounded-full border px-3 py-1 text-xs">Pro</button>
              <button data-family="Pro Max" class="rounded-full border px-3 py-1 text-xs">Pro Max</button>
              <button data-family="Air" class="rounded-full border px-3 py-1 text-xs">Air</button>
            </div>
            <div class="mt-3 flex flex-wrap items-center gap-2" id="controls">
              <div class="relative grow sm:w-72">
                <input id="q" type="text" placeholder="搜尋：顏色 / 容量 / 關鍵字" class="w-full rounded-lg border px-3 py-2 text-sm pl-9" />
                <span class="absolute left-3 top-2.5 text-gray-400">🔎</span>
              </div>
              <label class="text-sm text-gray-600 hidden sm:inline">排序</label>
              <select id="sortBy" class="rounded-lg border px-2 py-1.5 text-sm">
                <option value="store">門市名稱</option>
                <option value="available">可取貨優先</option>
              </select>
              <button id="resetFilters" class="rounded-lg border px-3 py-1.5 text-sm">重設</button>
            </div>
          </div>
        </div>
      </section>

      <section>
        <div id="stores" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4"></div>
      </section>
    </main>

    <template id="store-card">
      <article class="rounded-2xl bg-white shadow-sm ring-1 ring-black/5 overflow-hidden flex flex-col">
        <div class="p-4">
          <h3 class="font-semibold text-base"></h3>
          <p class="text-sm text-gray-500"></p>
          <div class="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <span data-status class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"></span>
            <span data-hours class="text-gray-600"></span>
          </div>
          <div class="mt-2 flex flex-wrap gap-2">
            <a data-map class="rounded-lg border px-2 py-1 text-sm hover:bg-gray-50" target="_blank" rel="noreferrer">地圖</a>
            <a data-phone class="rounded-lg border px-2 py-1 text-sm hover:bg-gray-50">撥打電話</a>
          </div>
          <a class="mt-2 inline-block text-brand-700 text-sm hover:underline" target="_blank" rel="noreferrer">門市資訊 →</a>
        </div>
        <div class="border-t">
          <table class="w-full text-sm">
            <thead class="bg-gray-50 text-gray-600">
              <tr>
                <th class="text-left px-3 py-2">機型</th>
                <th class="text-right px-3 py-2">取貨日</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
      </article>
    </template>

    <script>
      const state = { onlyAvail: false, data: null, families: new Set(), q: '', sortBy: 'store' };
      const elUpdated = document.getElementById('updated');
      const elModels = document.getElementById('models');
      const elStores = document.getElementById('stores');
      const tmplStore = document.getElementById('store-card');
      const btnRefresh = document.getElementById('refreshBtn');
      const btnOnly = document.getElementById('toggleOnlyAvail');
      const elFamilyFilters = document.getElementById('familyFilters');
      const elQ = document.getElementById('q');
      const elSort = document.getElementById('sortBy');
      const btnReset = document.getElementById('resetFilters');

      btnRefresh.addEventListener('click', load);
      btnOnly.addEventListener('click', () => { state.onlyAvail = !state.onlyAvail; btnOnly.classList.toggle('bg-gray-900'); btnOnly.classList.toggle('text-white'); render(); });
      elQ.addEventListener('input', () => { state.q = elQ.value.trim(); render(); });
      elSort.addEventListener('change', () => { state.sortBy = elSort.value; render(); });
      btnReset.addEventListener('click', () => { state.q=''; elQ.value=''; state.families.clear(); elFamilyFilters.querySelectorAll('button').forEach(b=>b.classList.remove('bg-gray-900','text-white')); elFamilyFilters.querySelector('[data-family=all]')?.classList.add('bg-gray-900','text-white'); state.onlyAvail=false; btnOnly.classList.remove('bg-gray-900','text-white'); state.sortBy='store'; elSort.value='store'; render(); });

      function familyOf(part){
        const slug = (part.family||'').toLowerCase();
        const name = part.name||'';
        if (slug.includes('iphone-air') || /\bAir\b/i.test(name)) return 'Air';
        if (slug.includes('iphone-17-pro')) {
          if (/Pro Max/i.test(name)) return 'Pro Max';
          return 'Pro';
        }
        return 'Standard';
      }

      function withFamilyTag(text, fam){
        const span = document.createElement('span');
        span.className = 'ml-1 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ' + (fam==='Standard' ? 'bg-gray-100 text-gray-700' : fam==='Air' ? 'bg-sky-100 text-sky-800' : fam==='Pro' ? 'bg-purple-100 text-purple-800' : 'bg-indigo-100 text-indigo-800');
        span.textContent = fam;
        return span;
      }

      async function load(){
        try {
          btnRefresh.disabled = true; btnRefresh.textContent = '更新中…';
          const res = await fetch('/api/availability');
          const json = await res.json();
          state.data = json;
          elUpdated.textContent = '資料更新時間：' + new Date(json.generatedAt).toLocaleString('zh-TW');
          renderModels(json.models);
          render();
        } catch(e) {
          elUpdated.textContent = '載入失敗，請稍後重試。';
        } finally {
          btnRefresh.disabled = false; btnRefresh.textContent = '重新整理';
        }
      }

      function renderModels(models){
        elModels.innerHTML = '';
        for (const m of models){
          const chip = document.createElement('span');
          chip.className = 'text-xs rounded-full border px-2 py-1';
          const fam = familyOf(m);
          chip.textContent = m.name;
          chip.appendChild(withFamilyTag('', fam));
          elModels.appendChild(chip);
        }
        // Init family filter buttons
        elFamilyFilters.querySelectorAll('button').forEach(btn => {
          btn.addEventListener('click', () => {
            const f = btn.getAttribute('data-family');
            if (f === 'all') {
              state.families.clear();
              elFamilyFilters.querySelectorAll('button').forEach(b=>b.classList.remove('bg-gray-900','text-white'));
              btn.classList.add('bg-gray-900','text-white');
            } else {
              // toggle selection
              if (state.families.has(f)) {
                state.families.delete(f);
                btn.classList.remove('bg-gray-900','text-white');
              } else {
                state.families.add(f);
                btn.classList.add('bg-gray-900','text-white');
                // clear "全部" highlight
                elFamilyFilters.querySelector('[data-family=all]')?.classList.remove('bg-gray-900','text-white');
              }
            }
            render();
          });
        });
        // Highlight "全部" initially
        elFamilyFilters.querySelector('[data-family=all]')?.classList.add('bg-gray-900','text-white');
      }

      function render(){
        if (!state.data) return;
        elStores.innerHTML = '';

        // group availability by store with filters/search
        const byStore = new Map();
        for (const a of state.data.availability){
          if (state.onlyAvail && a.status !== 'available') continue;
          const fam = familyOf(a.part);
          if (state.families.size && !state.families.has(fam)) continue;
          if (state.q) {
            const hay = (a.part.name + ' ' + (a.part.partNumber||'')).toLowerCase();
            if (!hay.includes(state.q.toLowerCase())) continue;
          }
          const key = a.store.storeNumber || a.store.storeName;
          if (!byStore.has(key)) byStore.set(key, { store: a.store, list: [] });
          byStore.get(key).list.push(a);
        }

        let stores = Array.from(byStore.values());
        if (state.sortBy === 'available') {
          stores.sort((a,b)=> {
            const aa = a.list.some(x=>x.status==='available' || x.isBuyable);
            const bb = b.list.some(x=>x.status==='available' || x.isBuyable);
            if (aa!==bb) return aa? -1: 1;
            return (a.store.storeName||'').localeCompare(b.store.storeName||'');
          });
        } else {
          stores.sort((a,b)=> (a.store.storeName||'').localeCompare(b.store.storeName||''));
        }
        for (const g of stores){
          const node = tmplStore.content.cloneNode(true);
          const h3 = node.querySelector('h3');
          const p = node.querySelector('p');
          const link = node.querySelector('a');
          h3.textContent = g.store.storeName;
          p.textContent = (g.store.city || '') + ' · ' + (g.store.address || '');
          link.href = g.store.url || '#';
          const st = node.querySelector('[data-status]');
          const hr = node.querySelector('[data-hours]');
          const map = node.querySelector('[data-map]');
          const phone = node.querySelector('[data-phone]');
          if (st) {
            st.textContent = g.store.isOpen ? '營業中' : '已打烊';
            st.className = 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ' + (g.store.isOpen ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-700');
          }
          if (hr) {
            hr.textContent = g.store.todayHours ? ('今日營業：' + g.store.todayHours) : '營業時間請見門市頁面';
          }
          if (map && g.store.mapsUrl) {
            map.href = g.store.mapsUrl;
          } else if (map) {
            map.style.display = 'none';
          }
          if (phone && g.store.phoneHref) {
            phone.href = g.store.phoneHref;
          } else if (phone) {
            phone.style.display = 'none';
          }

          // Build family summaries and grouped rows
          const famOrder = ['Air','Pro Max','Pro','Standard'];
          const groups = new Map();
          for (const item of g.list){
            const fam = familyOf(item.part);
            if (!groups.has(fam)) groups.set(fam, []);
            groups.get(fam).push(item);
          }
          // summary chips
          const card = node.querySelector('article');
          const summary = document.createElement('div');
          summary.className = 'px-4 pb-2 flex flex-wrap gap-2 text-xs';
          for (const fam of famOrder){
            const list = groups.get(fam)||[];
            if (!list.length) continue;
            const avail = list.filter(x=>x.status==='available' || x.isBuyable).length;
            const chip = document.createElement('span');
            chip.className = 'rounded-full border px-2 py-1';
            chip.textContent = fam + '：' + avail + '/' + list.length;
            summary.appendChild(chip);
          }
          card.insertBefore(summary, card.children[1]);

          const tbody = node.querySelector('tbody');
          tbody.innerHTML = '';
          for (const fam of famOrder){
            const list = groups.get(fam)||[];
            if (!list.length) continue;
            const trh = document.createElement('tr');
            const th = document.createElement('td'); th.colSpan=2; th.className='bg-gray-50 px-3 py-2 text-xs text-gray-600'; th.textContent = fam;
            trh.appendChild(th); tbody.appendChild(trh);
            for (const item of list){
              const tr = document.createElement('tr');
              tr.className = 'border-t';
              const td1 = document.createElement('td');
              td1.className = 'px-3 py-2 text-gray-900';
              td1.textContent = item.part.name;
              const price = item.part.price ? ('NT$' + Number(item.part.price).toLocaleString('zh-TW')) : '';
              if (price){ const pz = document.createElement('span'); pz.className='ml-2 text-xs text-gray-500'; pz.textContent=price; td1.appendChild(pz); }
              const td2 = document.createElement('td');
              td2.className = 'px-3 py-2 text-right';
              const badge = document.createElement('span');
              badge.className = 'inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium ' + (item.status === 'available' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-700');
              badge.textContent = item.pickupQuote || (item.status === 'available' ? '可取貨' : '暫無供貨');
              td2.appendChild(badge);
              tr.appendChild(td1); tr.appendChild(td2);
              tbody.appendChild(tr);
            }
          }
          elStores.appendChild(node);
        }
      }

      load();
    </script>
  </body>
  </html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

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
      if (url.pathname === "/" || url.pathname === "/index.html") {
        // Edge cache the static shell so it serves fast world-wide
        const cache = caches.default;
        const cacheKey = new Request(url.origin + "/", { method: 'GET', headers: { 'accept': 'text/html' } });
        let hit = await cache.match(cacheKey);
        if (hit) return hit;
        const res = renderIndexHtml();
        // Add SWR style headers for the HTML shell (longer edge TTL)
        const r2 = new Response(res.body, res);
        r2.headers.set('Cache-Control', 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400');
        ctx.waitUntil(cache.put(cacheKey, r2.clone()));
        return r2;
      }
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

/* Good Finds - the app. Pins live on the phone; the Google Sheet is the shared copy. */
(() => {
  // Bump this on every deploy, and bump VERSION in sw.js to match. That pair is what makes phones update.
  const APP_VERSION = 'v1.6', APP_DATE = 'Oct 7 2026';
  const { CATS, parseGoogleCsv, toCsv, solveOrder, googleLinks, appleLinks } = window.GF;
  const CAT = Object.fromEntries(CATS.map((c) => [c.id, c]));
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const LS = {
    get(k, d) { try { const v = localStorage.getItem('gf.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('gf.' + k, JSON.stringify(v)); } catch (e) {} }
  };

  let places = LS.get('places', {});
  let api = LS.get('api', '');
  let me = LS.get('me', '');
  let hybrid = LS.get('hybrid', false);
  let route = Object.assign({ ids: [], loop: false, done: [], plan: null }, LS.get('route', {})); // this phone only
  let filter = 'all';
  let selected = null;
  let myLoc = null;
  let syncing = false, syncState = 'idle', oldScript = false;
  let listFrom = null;   // a pin to measure distances from ("what's around here")
  let listSort = 'near'; // near | name | stale
  let placing = null;    // {id} when moving an existing pin, {} when adding
  let found = null;      // an address search result shown on the map
  // Spots this phone has already seen. Anything that arrives from the other phone and is not in here is "new".
  // Whatever is already on this phone counts as seen, and so does everything in the first sync with a sheet.
  let seen = new Set(LS.get('seen', Object.keys(places)));
  let seenSynced = LS.get('seenSynced', false);
  const saveSeen = () => { if (seen) LS.set('seen', [...seen]); };
  const isNew = (p) => !!seen && !p.deleted && !seen.has(p.id);
  const announced = new Set();

  // A setup link (?sync=...) configures the shared sheet on a new phone.
  const qsSync = new URLSearchParams(location.search).get('sync');
  if (qsSync && qsSync !== api) { api = qsSync; LS.set('api', api); }

  /* ---------- map ---------- */
  const view = LS.get('view', null);
  const map = L.map('map', { zoomControl: false, maxZoom: 19 }).setView(view ? [view.lat, view.lng] : [39.5, -89], view ? view.z : 4);
  map.createPane('labels'); map.getPane('labels').style.zIndex = 250; map.getPane('labels').style.pointerEvents = 'none';
  const STYLE = 'https://tiles.openfreemap.org/styles/positron';
  const OFM = '<a href="https://openfreemap.org">OpenFreeMap</a> &copy; OpenMapTiles &copy; OpenStreetMap contributors';
  const canGL = (() => { try { const c = document.createElement('canvas'); return !!(window.maplibregl && L.maplibreGL && (c.getContext('webgl2') || c.getContext('webgl'))); } catch (e) { return false; } })();
  // Clean map: streets, towns and water, no businesses. No account, no key.
  const base = canGL ? L.maplibreGL({ style: STYLE, attribution: OFM })
    : L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, crossOrigin: true, attribution: '&copy; OpenStreetMap contributors' });
  // Hybrid: USGS aerial photos (public domain, US only) with road and town names laid over the top.
  const imagery = L.tileLayer.wms('https://imagery.nationalmap.gov/arcgis/services/USGSNAIPPlus/ImageServer/WMSServer', {
    layers: 'USGSNAIPPlus', format: 'image/jpeg', version: '1.1.1', tileSize: 512, maxZoom: 19, crossOrigin: true, attribution: 'Aerial photos: USGS NAIP' });
  let labels = null, labelsWanted = false;
  async function addLabels() {
    if (!canGL) return;
    labelsWanted = true;
    if (!labels) {
      try {
        const st = await (await fetch(STYLE)).json();
        const roads = ['highway_minor', 'highway_major_inner', 'highway_motorway_inner', 'highway_motorway_bridge_inner'];
        delete st.sources.ne2_shaded;
        st.layers = st.layers.filter((l) => l.type === 'symbol' || roads.includes(l.id)).map((l) => {
          l = JSON.parse(JSON.stringify(l)); l.paint = l.paint || {};
          if (l.type === 'line') { l.paint['line-color'] = '#ffffff'; l.paint['line-opacity'] = 0.4; }
          else if (!(l.layout && l.layout['icon-image'])) { l.paint['text-color'] = '#ffffff'; l.paint['text-halo-color'] = 'rgba(0,0,0,0.85)'; l.paint['text-halo-width'] = 1.6; }
          return l;
        });
        labels = L.maplibreGL({ style: st, pane: 'labels', interactive: false, attribution: 'Names: ' + OFM });
      } catch (e) { return; } // no signal and nothing saved: photos only
    }
    if (labelsWanted && hybrid && !map.hasLayer(labels)) labels.addTo(map);
  }
  function setBase() {
    if (hybrid) { if (map.hasLayer(base)) map.removeLayer(base); imagery.addTo(map); addLabels(); }
    else { labelsWanted = false; if (labels && map.hasLayer(labels)) map.removeLayer(labels); if (map.hasLayer(imagery)) map.removeLayer(imagery); base.addTo(map); }
    const b = $('[data-act=layer]'); if (b) b.textContent = hybrid ? '🗺️' : '🛰️';
    document.body.classList.toggle('hybrid', hybrid);
  }
  setBase();

  const routeLayer = L.layerGroup().addTo(map);
  const pins = L.layerGroup().addTo(map);
  let meMarker = null, foundMarker = null;
  map.on('moveend', () => { const c = map.getCenter(); LS.set('view', { lat: c.lat, lng: c.lng, z: map.getZoom() }); });
  map.on('click', () => { if (!placing && ['detail', 'found'].includes($('#sheet').dataset.mode)) closeSheet(); });
  map.on('contextmenu', (e) => { if (!placing) openForm(blank(e.latlng.lat, e.latlng.lng), true); }); // long-press

  /* ---------- rummage sales: dates, hours, and dropping off when they are over ---------- */
  const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
  const lastDay = (p) => (isDay(p.ends) && p.ends > p.date ? p.ends : p.date);
  const hoursOf = (p) => { const m = /^(\d{2}:\d{2})?-(\d{2}:\d{2})?$/.exec(p.hours || ''); return { open: (m && m[1]) || '', close: (m && m[2]) || '' }; };
  const at = (day, hm) => { const [y, mo, d] = day.split('-').map(Number), [h, mi] = (hm || '0:0').split(':').map(Number); return new Date(y, mo - 1, d, h, mi).getTime(); };
  const isSale = (p) => p.category === 'rummage' && isDay(p.date);
  // The moment a sale is over: closing time on its last day, or the end of that day if no closing time was given.
  const saleEnd = (p) => (isSale(p) ? (hoursOf(p).close ? at(lastDay(p), hoursOf(p).close) : at(lastDay(p), '23:59') + 60000) : null);
  const expired = (p) => { const e = saleEnd(p); return e != null && Date.now() >= e; };
  const gone = (p) => !!p.deleted || expired(p);
  const live = () => Object.values(places).filter((p) => !gone(p));
  const past = () => Object.values(places).filter((p) => !p.deleted && expired(p));
  const fmtTime = (hm) => { const [h, m] = hm.split(':').map(Number); return (h % 12 || 12) + (m ? ':' + String(m).padStart(2, '0') : '') + (h < 12 ? ' AM' : ' PM'); };
  const dayShort = (d) => { const [y, mo, dd] = d.split('-').map(Number); return new Date(y, mo - 1, dd).toLocaleDateString(undefined, Object.assign({ weekday: 'short', month: 'short', day: 'numeric' }, y === new Date().getFullYear() ? {} : { year: 'numeric' })); };
  function saleWhen(p) {
    const h = hoursOf(p), end = lastDay(p);
    return dayShort(p.date) + (end > p.date ? ' to ' + dayShort(end) : '') +
      (h.open && h.close ? ', ' + fmtTime(h.open) + ' to ' + fmtTime(h.close) : h.open ? ', opens ' + fmtTime(h.open) : h.close ? ', until ' + fmtTime(h.close) : '');
  }
  function saleStatus(p) {
    if (expired(p)) return 'over';
    const now = Date.now(), t = today(), h = hoursOf(p), end = lastDay(p);
    if (t < p.date) { const n = dayNum(p.date) - dayNum(t); return n === 1 ? 'tomorrow' : 'in ' + n + ' days'; }
    if (h.open && now < at(t, h.open)) return 'today, opens ' + fmtTime(h.open);
    if (h.close && now >= at(t, h.close)) return t < end ? 'closed for today, back tomorrow' : 'over';
    return 'on now' + (h.close ? ', until ' + fmtTime(h.close) : '') + (t < end ? '' : ', last day');
  }
  const fits = (p) => filter === 'all' || (filter === 'new' ? isNew(p) : p.category === filter);
  const shown = () => live().filter(fits);
  const filterLabel = () => (filter === 'new' ? 'New spots' : CAT[filter] ? CAT[filter].label : 'All spots');
  const catOf = (p) => CAT[p.category] || CAT.other;
  const inRoute = (id) => route.ids.includes(id);
  const stopNum = (id) => (route.plan ? route.plan.order.indexOf(id) + 1 : 0);

  function save() { LS.set('places', places); }
  function saveRoute() { LS.set('route', route); }

  function render() {
    pins.clearLayers();
    for (const p of live().filter((q) => fits(q) || inRoute(q.id))) {
      const c = catOf(p), n = stopNum(p.id), done = route.done.includes(p.id);
      const icon = L.divIcon({ className: '', iconSize: [34, 42], iconAnchor: [17, 40],
        html: `<div class="pin${p.id === selected ? ' sel' : ''}${inRoute(p.id) ? ' rt' : ''}${done ? ' done' : ''}" style="--c:${c.color}"><span>${c.icon}</span></div>${n ? `<b class="num">${n}</b>` : ''}${isNew(p) ? '<i class="nw"></i>' : ''}` });
      L.marker([p.lat, p.lng], { icon, title: p.name, zIndexOffset: n ? 500 : 0 }).on('click', () => openDetail(p.id)).addTo(pins);
    }
    const all = live(), counts = {};
    all.forEach((p) => { const k = catOf(p).id; counts[k] = (counts[k] || 0) + 1; });
    const fresh = all.filter(isNew).length;
    if (filter === 'new' && !fresh) filter = 'all';
    const nb = $('#ncount'); nb.textContent = fresh || ''; nb.hidden = !fresh;
    $('#chips').innerHTML = (fresh ? `<button class="chip fresh${filter === 'new' ? ' on' : ''}" data-filter="new">🔴 New<b>${fresh}</b></button>` : '') +
      `<button class="chip${filter === 'all' ? ' on' : ''}" data-filter="all">All<b>${all.length}</b></button>` +
      CATS.map((c) => `<button class="chip${filter === c.id ? ' on' : ''}" data-filter="${c.id}">${c.icon} ${esc(c.label)}<b>${counts[c.id] || 0}</b></button>`).join('');
    const rb = $('#rcount'); rb.textContent = route.ids.length || ''; rb.hidden = !route.ids.length;
    renderStatus();
  }

  function drawRoute() {
    routeLayer.clearLayers();
    const pl = route.plan; if (!pl || !pl.geo || pl.geo.length < 2) return;
    L.polyline(pl.geo, { color: '#fff', weight: 8, opacity: 0.9, interactive: false }).addTo(routeLayer);
    L.polyline(pl.geo, { color: '#b4532a', weight: 4.5, opacity: 0.95, dashArray: pl.road ? null : '8 8', interactive: false }).addTo(routeLayer);
  }

  function renderStatus() {
    const el = $('#status');
    const waiting = Object.values(places).filter((p) => p._dirty).length;
    let t, cls = '';
    if (!api) { t = 'This phone only'; }
    else if (syncing) { t = 'Syncing…'; }
    else if (!navigator.onLine) { t = waiting ? waiting + ' waiting for signal' : 'Offline'; cls = waiting ? 'warn' : ''; }
    else if (oldScript) { t = 'Sheet script needs update'; cls = 'warn'; }
    else if (waiting) { t = waiting + ' waiting to sync'; cls = 'warn'; }
    else if (syncState === 'error') { t = 'Sync failed'; cls = 'warn'; }
    else { t = 'Synced'; cls = 'ok'; }
    el.textContent = t; el.className = cls;
  }

  function fitAll() {
    const pts = shown().map((p) => [p.lat, p.lng]);
    if (pts.length) map.fitBounds(pts, { padding: [50, 50], maxZoom: 14 });
  }

  /* ---------- visits ---------- */
  const pad = (n) => String(n).padStart(2, '0');
  const today = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const visitsOf = (p) => [...new Set(String(p.visits || '').split(',').map((s) => s.trim()).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s)))].sort();
  const lastVisit = (p) => { const v = visitsOf(p); return v[v.length - 1] || ''; };
  const dayNum = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d); return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5); };
  function ago(d) {
    const n = dayNum(today()) - dayNum(d);
    if (n < 0) return 'upcoming'; if (n === 0) return 'today'; if (n === 1) return 'yesterday';
    if (n < 60) return n + ' days ago'; if (n < 730) return Math.round(n / 30.4) + ' months ago';
    return Math.round(n / 365.25) + ' years ago';
  }
  function setVisit(p, d, on) {
    const v = new Set(visitsOf(p)); on ? v.add(d) : v.delete(d);
    p.visits = [...v].sort().join(',');
  }

  /* ---------- sync with the Google Sheet ---------- */
  const wire = (p) => ({ id: p.id, name: p.name, lat: p.lat, lng: p.lng, category: p.category, note: p.note || '', rating: p.rating || '',
    date: p.date || '', addedBy: p.addedBy || '', updated: p.updated, deleted: p.deleted ? '1' : '', visits: p.visits || '', city: p.city || '', ends: p.ends || '', hours: p.hours || '' });
  const unwire = (s) => ({ id: String(s.id), name: String(s.name || ''), lat: Number(s.lat), lng: Number(s.lng), category: String(s.category || 'other'),
    note: String(s.note || ''), rating: Number(s.rating) || 0, date: String(s.date || ''), addedBy: String(s.addedBy || ''),
    updated: Number(s.updated) || 0, deleted: ['1', 'true', 'TRUE'].includes(String(s.deleted)), visits: String(s.visits || ''), city: String(s.city || ''), ends: String(s.ends || ''), hours: String(s.hours || '') });

  async function sync(loud) {
    if (!api || syncing) return;
    if (!navigator.onLine) { renderStatus(); if (loud) toast('No signal. It will sync when you have bars.'); return; }
    syncing = true; renderStatus();
    const sent = Object.values(places).filter((p) => p._dirty).map(wire);
    const first = !live().length;
    const openWas = selected && places[selected] ? JSON.stringify(wire(places[selected])) : '';
    try {
      const res = await fetch(api, { method: 'POST', body: JSON.stringify({ action: 'sync', changes: sent }) });
      const j = await res.json();
      if (!j.ok || !Array.isArray(j.places)) throw new Error(j.error || 'Unexpected reply');
      const sentAt = Object.fromEntries(sent.map((p) => [p.id, p.updated]));
      LS.set('scriptV', Number(j.v) || 1);
      // Which fields this sheet script stores. Older scripts do not say, so work it out from the version.
      const has = (f) => (Array.isArray(j.cols) ? j.cols.includes(f) : f === 'visits' && Number(j.v) >= 2);
      const next = {}; let held = 0, pushTowns = 0;
      for (const s of j.places) {
        const p = unwire(s); if (!p.id || !isFinite(p.lat) || !isFinite(p.lng)) continue;
        // An older sheet script has no visits column: hold visit stamps on this phone until it is updated.
        const mine = places[p.id];
        if (mine && !has('visits') && mine.visits) { p.visits = mine.visits; p._dirty = true; held++; }
        if (mine) for (const k of ['ends', 'hours']) if (!has(k) && mine[k]) { p[k] = mine[k]; p._dirty = true; }
        // Town names are looked up on the phone. Keep ours if the sheet has none for this exact pin, and share it if the sheet can hold it.
        if (mine && mine.city && !p.city && mine.lat === p.lat && mine.lng === p.lng) { p.city = mine.city; if (has('city')) { p._dirty = true; pushTowns++; } }
        next[p.id] = p;
      }
      // keep anything edited on this phone while the request was in the air
      for (const p of Object.values(places)) if (p._dirty && sentAt[p.id] !== p.updated) next[p.id] = p;
      places = next; save(); syncState = 'ok'; oldScript = held > 0; LS.set('lastSync', Date.now());
      // First sync on this phone: everything already there counts as seen. After that, arrivals get flagged.
      let arrived = [];
      if (!seenSynced) { Object.keys(places).forEach((id) => seen.add(id)); saveSeen(); seenSynced = true; LS.set('seenSynced', true); }
      else { arrived = live().filter((p) => isNew(p) && !announced.has(p.id)); arrived.forEach((p) => announced.add(p.id)); }
      syncing = false; render();
      if (first && !view) fitAll();
      const mode = $('#sheet').dataset.mode;
      if (mode === 'detail' && selected) {
        if (!places[selected] || places[selected].deleted) closeSheet();
        else if (!$('#sheet .arm') && JSON.stringify(wire(places[selected])) !== openWas) openDetail(selected, true); // only redraw if this spot actually changed
      }
      if (arrived.length) {
        const who = [...new Set(arrived.map((p) => p.addedBy).filter(Boolean))].join(' and ') || 'Someone';
        toast(`${who} added ${arrived.length === 1 ? '“' + arrived[0].name + '”' : arrived.length + ' new spots'}. Tap the red New chip to see.`, 5500);
        refreshOpen();
      } else if (loud) toast(oldScript ? 'Synced, but visit stamps need the updated sheet script.' : 'Synced. ' + live().length + ' spots.');
      if (pushTowns && townPushes++ < 3) setTimeout(() => sync(), 2000);
      fillTowns();
    } catch (e) {
      syncing = false; syncState = 'error'; renderStatus();
      if (loud) toast('Could not reach the sheet. Check the link in Settings.');
    }
  }

  function commit(p) {
    p.updated = Date.now(); p._dirty = true;
    if (seen && !seen.has(p.id)) { seen.add(p.id); saveSeen(); } // our own additions are never "new" to us
    places[p.id] = p; save(); render(); sync(); fillTowns();
  }

  /* ---------- town names ---------- */
  // Each pin gets its mailing town: the US Census says which ZIP code area the pin is in, and zips.txt names the town.
  const STATES = { Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA', Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE', 'District of Columbia': 'DC', Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN', Mississippi: 'MS', Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT', Vermont: 'VT', Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY' };
  const ZCTA = '2020 Census ZIP Code Tabulation Areas';
  let zipTable = null, filling = false, townPushes = 0;
  const noTown = new Set();
  async function zipTown(z) {
    if (!zipTable) {
      const t = await (await fetch('zips.txt')).text(), tbl = {};
      for (const line of t.split('\n')) if (line.length > 6) tbl[line.slice(0, 5)] = line.slice(5).replace(/,([A-Z]{2})$/, ', $1');
      zipTable = tbl;
    }
    return zipTable[z] || '';
  }
  // Returns 'Town, ST', or '' when there is nothing to name. Throws when the lookup cannot be reached.
  async function townOf(p) {
    const j = await jsonp('https://geocoding.geo.census.gov/geocoder/geographies/coordinates?benchmark=Public_AR_Current&vintage=Current_Current&layers=' + encodeURIComponent(ZCTA) + '&x=' + p.lng + '&y=' + p.lat, 12000);
    const g = (((j || {}).result || {}).geographies || {})[ZCTA] || [];
    if (g.length) { const t = await zipTown(g[0].ZCTA5 || g[0].BASENAME); if (t) return t; }
    // Outside the US, or somewhere with no ZIP area (deep woods, open water): ask OpenStreetMap.
    const k = await getJson('https://photon.komoot.io/reverse?lang=en&lat=' + p.lat + '&lon=' + p.lng, 9000);
    const q = (k.features && k.features[0] && k.features[0].properties) || {}, us = q.countrycode === 'US';
    const town = q.city || q.town || q.village || (q.county ? q.county + (us && !/county|parish|borough/i.test(q.county) ? ' County' : '') : '');
    const st = us ? STATES[q.state] || q.state : q.state || q.country;
    return town ? town + (st ? ', ' + st : '') : '';
  }
  async function fillTowns() {
    if (filling || !navigator.onLine) return;
    filling = true; let n = 0;
    try {
      for (;;) {
        const p = live().find((q) => !q.city && !noTown.has(q.id));
        if (!p) break;
        let t; try { t = await townOf(p); } catch (e) { break; } // no signal: try again later
        const cur = places[p.id];
        if (cur && !cur.city && cur.lat === p.lat && cur.lng === p.lng) {
          if (t) { cur.city = t; cur._dirty = true; n++; if (n % 8 === 0) { save(); render(); refreshOpen(); } } // same edit time on purpose: a looked-up town must never beat a real edit
          else noTown.add(p.id);
        }
        await new Promise((r) => setTimeout(r, 350));
      }
    } finally { filling = false; if (n) { save(); render(); refreshOpen(); sync(); } }
  }
  function refreshOpen() {
    const m = $('#sheet').dataset.mode;
    if (!$('#sheet').classList.contains('open')) return;
    // Never redraw under someone's finger: not while they are typing in the panel, and not between the two taps of a delete.
    if ($('#sheet .arm') || $('#sheet').contains(document.activeElement) && /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if (m === 'list' || (m === 'route' && !route.plan)) { const y = $('#sheet').scrollTop; reopenList(); $('#sheet').scrollTop = y; }
    else if (m === 'route') { const y = $('#sheet').scrollTop; openPlan(); $('#sheet').scrollTop = y; }
    else if (m === 'detail' && selected && places[selected]) openDetail(selected, true);
  }
  const townTag = (p) => (p.city ? '<b class="town">' + esc(p.city) + '</b> · ' : '');

  /* ---------- sheet (bottom panel) ---------- */
  function openSheet(mode, html) {
    const s = $('#sheet');
    s.dataset.mode = mode;
    s.innerHTML = '<div class="grab"></div><button class="x" data-act="close" aria-label="Close">×</button>' + html;
    s.classList.add('open'); s.scrollTop = 0;
  }
  function closeSheet() {
    listFrom = null; $('#sheet').classList.remove('open'); $('#sheet').dataset.mode = '';
    if (foundMarker) { map.removeLayer(foundMarker); foundMarker = null; found = null; }
    if (selected) { selected = null; render(); }
  }

  const stars = (n) => (n ? '★'.repeat(n) + '☆'.repeat(5 - n) : '');
  const niceDate = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : (d || ''); };

  function distMi(a, b) {
    const R = 3958.8, r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  const fmtMi = (d) => (d < 10 ? d.toFixed(1) : Math.round(d)) + ' mi';
  const fmtMin = (m) => { m = Math.round(m); return m < 60 ? m + ' min' : Math.floor(m / 60) + ' hr ' + (m % 60) + ' min'; };
  const appleTo = (p) => `https://maps.apple.com/?daddr=${p.lat},${p.lng}&q=${encodeURIComponent(p.name || 'Dropped pin')}`;

  function visitLine(p) {
    const v = visitsOf(p), lv = v[v.length - 1];
    return lv ? `Last stop: ${esc(niceDate(lv))} (${ago(lv)}) · ${v.length} ${v.length === 1 ? 'visit' : 'visits'}` : 'No stops logged yet';
  }

  function openDetail(id, quiet) {
    const p = places[id]; if (!p) return;
    const fresh = isNew(p);
    if (fresh) { seen.add(id); saveSeen(); } // looking at it is what clears the flag
    selected = id; render();
    const c = catOf(p), here = visitsOf(p).includes(today()), n = stopNum(id);
    openSheet('detail', `
      <h2>${esc(p.name)}</h2>
      ${p.city ? `<p class="meta where">${esc(p.city)}</p>` : ''}
      <p class="meta"><span class="badge" style="--c:${c.color}">${c.icon} ${esc(c.label)}</span>
        ${myLoc ? ' &nbsp;' + fmtMi(distMi(myLoc, p)) + ' away' : ''}${n ? ' &nbsp;Stop ' + n + ' on the route' : ''}</p>
      ${p.rating ? `<div class="stars">${stars(p.rating)}</div>` : ''}
      ${isSale(p) ? `<p class="meta when">📅 ${esc(saleWhen(p))} <b class="st ${expired(p) ? 'over' : ''}">${esc(saleStatus(p))}</b></p>` : p.date ? `<p class="meta">📅 ${esc(niceDate(p.date))}</p>` : ''}
      ${expired(p) ? '<div class="note">This sale is over, so it is off the map and out of the lists. Edit the dates to bring it back, or delete it.</div>' : ''}
      <p class="meta" id="d-visit">🕘 ${visitLine(p)}</p>
      ${p.note ? `<div class="note">${esc(p.note)}</div>` : ''}
      ${p.addedBy ? `<p class="meta">${fresh ? '<u class="newtag">NEW</u> ' : ''}Flagged by ${esc(p.addedBy)}</p>` : fresh ? '<p class="meta"><u class="newtag">NEW</u></p>' : ''}
      <div class="row">
        <button class="btn ${here ? '' : 'stamp'}" data-act="stamp">${here ? '✓ Stopped here today (undo)' : '🕘 Stopped here today'}</button>
      </div>
      <div class="row">
        <a class="btn go" href="${appleTo(p)}" target="_blank" rel="noopener">Directions</a>
        <button class="btn" data-act="toggle-route">${inRoute(id) ? 'Remove from route' : 'Add to route'}</button>
      </div>
      <div class="row">
        <button class="btn" data-act="around">What's around here</button>
        <button class="btn" data-act="edit">Edit</button>
      </div>
      <div class="row">
        <button class="btn" data-act="move">Move pin</button>
        <button class="btn danger" data-act="delete">Delete</button>
      </div>`);
    if (!quiet) map.panTo([p.lat, p.lng]);
  }

  const blank = (lat, lng) => ({ id: 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: '', lat: +lat.toFixed(6), lng: +lng.toFixed(6),
    category: CAT[filter] ? filter : 'thrift', note: '', rating: 0, date: '', ends: '', hours: '', visits: '', city: '', addedBy: me });

  let draft = null, draftNew = false;
  const visitChips = () => visitsOf(draft).reverse().map((d) => `<button type="button" class="vchip" data-unvisit="${d}">${esc(niceDate(d))} ×</button>`).join('') || '<span class="hint">None yet.</span>';
  function openForm(p, isNew) {
    draft = Object.assign({}, p); draftNew = isNew;
    openSheet('form', `
      <h2>${isNew ? 'New spot' : 'Edit spot'}</h2>
      <label for="f-name">Name</label><input id="f-name" type="text" value="${esc(draft.name)}" placeholder="What is it?" autocomplete="off">
      <label for="f-city">Town</label><input id="f-city" type="text" value="${esc(draft.city || '')}" placeholder="Fills itself in when there is signal" autocomplete="off">
      <label>Category</label>
      <div class="cats">${CATS.map((c) => `<button type="button" data-cat="${c.id}" class="${draft.category === c.id ? 'on' : ''}">${c.icon} ${esc(c.label)}</button>`).join('')}</div>
      <label>Worth the stop?</label>
      <div class="stars" id="f-stars">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-star="${n}" class="${n <= draft.rating ? 'on' : ''}">★</button>`).join('')}</div>
      <label for="f-date" id="f-date-l">${draft.category === 'rummage' ? 'First day of the sale' : 'Date (optional)'}</label><input id="f-date" type="date" value="${esc(draft.date)}">
      <div id="f-sale" ${draft.category === 'rummage' ? '' : 'hidden'}>
        <label for="f-ends">Last day (leave blank for a one-day sale)</label><input id="f-ends" type="date" value="${esc(draft.ends || '')}">
        <div class="row" style="margin-top:0"><div style="flex:1"><label for="f-open">Opens</label><input id="f-open" type="time" value="${hoursOf(draft).open}"></div>
          <div style="flex:1"><label for="f-close">Closes</label><input id="f-close" type="time" value="${hoursOf(draft).close}"></div></div>
        <p class="hint">Once the sale is over it drops off the map by itself. Nothing is deleted: it waits under Settings, Past sales.</p>
      </div>
      <label for="f-note">Notes</label><textarea id="f-note" placeholder="Good tool section, cash only, closed Mondays…">${esc(draft.note)}</textarea>
      <label for="f-visit">Stops we have made here</label>
      <div id="f-visits" class="vchips">${visitChips()}</div>
      <div class="row" style="margin-top:8px"><input id="f-visit" type="date" value="${today()}" style="flex:2"><button type="button" class="btn" data-act="addvisit" style="flex:1">Add this date</button></div>
      <div class="row"><button class="btn" data-act="close">Cancel</button><button class="btn go" data-act="save">Save</button></div>`);
  }
  function readForm() {
    draft.name = $('#f-name').value.trim(); draft.city = $('#f-city').value.trim(); draft.date = $('#f-date').value; draft.note = $('#f-note').value.trim();
    draft.ends = $('#f-ends').value; { const o = $('#f-open').value, c = $('#f-close').value; draft.hours = o || c ? o + '-' + c : ''; }
  }

  function sortedList(list, from) {
    if (from) list.forEach((p) => { p._d = distMi(from, p); });
    if (listSort === 'stale') {
      list.sort((a, b) => { const x = lastVisit(a), y = lastVisit(b); return x && y ? x.localeCompare(y) || a.name.localeCompare(b.name) : x ? -1 : y ? 1 : a.name.localeCompare(b.name); });
    } else if (listSort === 'near' && from) list.sort((a, b) => a._d - b._d);
    else list.sort((a, b) => a.name.localeCompare(b.name));
    return list;
  }
  const subline = (p, from) => { const c = catOf(p), lv = lastVisit(p);
    return townTag(p) + esc(c.label) + (isSale(p) ? ' · 📅 ' + esc(saleWhen(p)) + ' (' + esc(saleStatus(p)) + ')' : '') + (p.rating ? ' · ' + stars(p.rating) : '') + (from ? ' · ' + fmtMi(p._d) : '') + (lv ? ' · last stop ' + ago(lv) : ''); };
  const sortChips = () => `<div class="seg">${[['near', 'Nearest'], ['name', 'A to Z'], ['stale', 'Longest since a stop']].map(([k, t]) => `<button data-sort="${k}" class="${listSort === k ? 'on' : ''}">${t}</button>`).join('')}</div>`;

  function openList(q) {
    const from = listFrom || myLoc;
    const list = sortedList(shown().filter((p) => !listFrom || p.id !== listFrom.id), from);
    openSheet('list', `
      <h2>${listFrom ? 'Around ' + esc(listFrom.name) : esc(filterLabel())} <small class="cnt">${list.length}</small></h2>
      ${filter === 'new' && !listFrom ? '<div class="row" style="margin:6px 0 10px"><button class="btn" data-act="seen-all">Mark all as seen</button></div>' : ''}
      <input id="l-q" type="search" placeholder="Search names, towns and notes" value="${esc(q || '')}">
      ${sortChips()}
      <p class="hint">${listSort === 'stale' ? 'Longest since we stopped first; never-visited at the bottom.' : listSort === 'name' ? 'Alphabetical.' : listFrom ? 'Closest to this pin first' + (filter === 'all' ? '.' : ', ' + esc(filterLabel()) + ' only.') : myLoc ? 'Closest to you first.' : 'Tap ◎ on the map to sort these by distance.'}</p>
      <div id="l-items"></div>`);
    const draw = () => {
      const needle = $('#l-q').value.trim().toLowerCase();
      const rows = list.filter((p) => !needle || (p.name + ' ' + (p.city || '') + ' ' + p.note).toLowerCase().includes(needle));
      $('#l-items').innerHTML = rows.map((p) => { const c = catOf(p);
        return `<button class="item" data-open="${esc(p.id)}"><span class="dot" style="--c:${c.color}">${c.icon}</span>
          <span class="t"><div>${esc(p.name)}${isNew(p) ? ' <u class="newtag">NEW</u>' : ''}</div><small>${subline(p, from)}${isNew(p) && p.addedBy ? ' · added by ' + esc(p.addedBy) : ''}</small></span></button>`; }).join('') ||
        '<p class="hint">Nothing here yet.</p>';
    };
    $('#l-q').addEventListener('input', draw); draw();
  }

  /* ---------- address search ---------- */
  function jsonp(url, ms) {
    return new Promise((res, rej) => {
      const cb = 'gfcb' + Date.now() + Math.random().toString(36).slice(2, 7), s = document.createElement('script');
      const clean = () => { clearTimeout(t); delete window[cb]; s.remove(); };
      const t = setTimeout(() => { clean(); rej(new Error('timeout')); }, ms);
      window[cb] = (d) => { clean(); res(d); };
      s.onerror = () => { clean(); rej(new Error('network')); };
      s.src = url + '&format=jsonp&callback=' + cb; document.head.appendChild(s);
    });
  }
  async function getJson(url, ms) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
    try { const r = await fetch(url, { signal: ctl.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); } finally { clearTimeout(t); }
  }
  const title = (s) => String(s || '').toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
  async function geocode(q) {
    const c = map.getCenter(), jobs = [];
    // US Census: exact street addresses (needs town and state, or a zip).
    if (/^\d+\s+\S+/.test(q)) jobs.push(jsonp('https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&address=' + encodeURIComponent(q), 9000)
      .then((j) => ((j.result || {}).addressMatches || []).slice(0, 3).map((m) => {
        const a = m.matchedAddress.split(','); return { name: title(a[0]), sub: [title(a[1]), a[2], a[3]].filter(Boolean).join(', ').replace(/\s+/g, ' ').trim(), lat: +m.coordinates.y, lng: +m.coordinates.x, exact: true }; })));
    // Photon (OpenStreetMap): towns, streets, and whatever businesses are mapped.
    jobs.push(getJson('https://photon.komoot.io/api/?limit=6&lang=en&q=' + encodeURIComponent(q) + '&lat=' + c.lat.toFixed(3) + '&lon=' + c.lng.toFixed(3), 9000)
      .then((j) => (j.features || []).map((f) => { const p = f.properties || {}, g = f.geometry.coordinates;
        const street = [p.housenumber, p.street].filter(Boolean).join(' ');
        return { name: p.name || street || p.city || 'Unnamed', sub: [p.name ? street : '', p.city || p.county, p.state, p.countrycode !== 'US' ? p.country : ''].filter(Boolean).join(', '), lat: g[1], lng: g[0] }; })));
    const out = [], seen = new Set(); let failed = 0;
    for (const r of await Promise.allSettled(jobs)) {
      if (r.status !== 'fulfilled') { failed++; continue; }
      for (const x of r.value) { const k = x.lat.toFixed(4) + ',' + x.lng.toFixed(4); if (isFinite(x.lat) && isFinite(x.lng) && !seen.has(k)) { seen.add(k); out.push(x); } }
    }
    if (!out.length && failed === jobs.length) throw new Error('offline');
    return out;
  }
  let hits = [];
  function openSearch() {
    openSheet('search', `
      <h2>Find a place</h2>
      <form id="q-form" class="row" style="margin-top:6px"><input id="q" type="search" placeholder="123 Main St, Maggie Valley NC" autocomplete="off" style="flex:3" enterkeyhint="search">
        <button class="btn go" style="flex:1;min-width:0">Search</button></form>
      <p class="hint">Street addresses work best with the town and state. Town names and bigger businesses work too. Needs signal.</p>
      <div id="q-out"></div>`);
    $('#q-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const q = $('#q').value.trim(); if (q.length < 3) return;
      const out = $('#q-out'); $('#q').blur();
      const needle = q.toLowerCase();
      const mine = live().filter((p) => (p.name + ' ' + (p.city || '') + ' ' + p.note).toLowerCase().includes(needle)).slice(0, 5);
      const mineHtml = mine.length ? '<label>Already on our map</label>' + mine.map((p) => { const c = catOf(p);
        return `<button class="item" data-open="${esc(p.id)}"><span class="dot" style="--c:${c.color}">${c.icon}</span><span class="t"><div>${esc(p.name)}</div><small>${townTag(p)}${esc(c.label)}</small></span></button>`; }).join('') : '';
      out.innerHTML = mineHtml + '<p class="hint">Looking…</p>';
      try {
        hits = await geocode(q);
        out.innerHTML = mineHtml + (hits.length ? '<label>Addresses and places</label>' + hits.map((h, i) =>
          `<button class="item" data-hit="${i}"><span class="dot" style="--c:#8a8273">📌</span><span class="t"><div>${esc(h.name)}</div><small>${esc(h.sub)}${h.exact ? ' · address match' : ''}</small></span></button>`).join('')
          : '<p class="hint">No match. Try adding the town and state, or drop the pin by hand with +.</p>');
      } catch (err) { out.innerHTML = mineHtml + '<p class="hint">Could not search right now. No signal?</p>'; }
    });
    setTimeout(() => { const i = $('#q'); if (i) i.focus(); }, 250);
  }
  function showHit(h) {
    found = h;
    if (foundMarker) map.removeLayer(foundMarker);
    foundMarker = L.marker([h.lat, h.lng], { interactive: false, zIndexOffset: 900, icon: L.divIcon({ className: '', iconSize: [34, 42], iconAnchor: [17, 40], html: '<div class="pin tmp" style="--c:#8a8273"><span>📌</span></div>' }) }).addTo(map);
    map.setView([h.lat, h.lng], Math.max(map.getZoom(), 17));
    const s = $('#sheet'); s.dataset.mode = 'found';
    s.innerHTML = `<div class="grab"></div><button class="x" data-act="close" aria-label="Close">×</button>
      <h2>${esc(h.name)}</h2><p class="meta">${esc(h.sub)}</p>
      <p class="hint">${h.exact ? 'Address matches land on the right stretch of road, not always the exact door.' : 'Check the pin against the map before trusting it.'}</p>
      <div class="row"><a class="btn go" href="${appleTo(h)}" target="_blank" rel="noopener">Directions</a><button class="btn" data-act="save-hit">Save as a spot</button></div>`;
    s.scrollTop = 0;
  }

  /* ---------- route ---------- */
  const getLoc = () => new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('none'));
    navigator.geolocation.getCurrentPosition((pos) => {
      myLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      if (!meMarker) meMarker = L.marker([myLoc.lat, myLoc.lng], { icon: L.divIcon({ className: '', html: '<div class="medot"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }), interactive: false, zIndexOffset: -100 }).addTo(map);
      meMarker.setLatLng([myLoc.lat, myLoc.lng]); res(myLoc);
    }, rej, { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
  });
  function locate() {
    toast('Finding you…');
    getLoc().then((l) => map.setView([l.lat, l.lng], Math.max(map.getZoom(), 14))).catch(() => toast('Could not get a location fix.'));
  }

  const OSRM = 'https://router.project-osrm.org/';
  const lnglat = (pts) => pts.map((p) => (+p.lng).toFixed(6) + ',' + (+p.lat).toFixed(6)).join(';');
  async function buildRoute() {
    const stops = route.ids.map((id) => places[id]).filter((p) => p && !gone(p));
    if (!stops.length) return toast('Tick at least one stop.');
    if (stops.length > 25) return toast('That is ' + stops.length + ' stops. Keep it to 25 or fewer.');
    toast('Finding you…');
    let start; try { start = await getLoc(); } catch (e) { return toast('Need your location to start the route. Check location permission.'); }
    toast('Working out the best order…');
    const pts = [start].concat(stops), n = pts.length;
    let road = true, dur, dist;
    try {
      const j = await getJson(OSRM + 'table/v1/driving/' + lnglat(pts) + '?annotations=duration,distance', 15000);
      if (j.code !== 'Ok' || j.durations.some((r) => r.some((v) => v == null))) throw new Error('no table');
      dur = j.durations; dist = j.distances;
    } catch (e) { // no signal or no road answer: fall back to straight lines
      road = false; dist = pts.map((a) => pts.map((b) => distMi(a, b) * 1609.344)); dur = dist;
    }
    const order = solveOrder(dur, route.loop), seq = [0].concat(order, route.loop ? [0] : []);
    let legs = seq.slice(1).map((k, i) => ({ mi: dist[seq[i]][k] / 1609.344, min: road ? dur[seq[i]][k] / 60 : null }));
    let geo = seq.map((k) => [pts[k].lat, pts[k].lng]);
    if (road) {
      try {
        const j = await getJson(OSRM + 'route/v1/driving/' + lnglat(seq.map((k) => pts[k])) + '?overview=full&geometries=geojson&steps=false', 15000);
        if (j.code === 'Ok') { geo = j.routes[0].geometry.coordinates.map((c) => [c[1], c[0]]); legs = j.routes[0].legs.map((l) => ({ mi: l.distance / 1609.344, min: l.duration / 60 })); }
      } catch (e) { /* keep straight segments with the table numbers */ }
    }
    const back = route.loop ? legs.pop() : null;
    route.plan = { order: order.map((k) => pts[k].id), legs, back, road, geo, start, at: Date.now(),
      mi: legs.concat(back || []).reduce((s, l) => s + l.mi, 0), min: road ? legs.concat(back || []).reduce((s, l) => s + l.min, 0) : null };
    route.done = route.done.filter((id) => route.plan.order.includes(id));
    saveRoute(); render(); drawRoute();
    map.fitBounds(L.latLngBounds(geo), { paddingTopLeft: [30, 120], paddingBottomRight: [30, 60] });
    openRoute();
    toast(road ? 'Route ready.' : 'No road data right now, so this is a straight-line guess.');
  }
  function clearRoute(keepIds) {
    route = { ids: keepIds ? route.ids : [], loop: route.loop, done: [], plan: null };
    saveRoute(); routeLayer.clearLayers(); render();
  }

  function openRoute() {
    route.ids = route.ids.filter((id) => places[id] && !gone(places[id]));
    if (route.plan) return openPlan();
    const list = sortedList(shown(), myLoc);
    openSheet('route', `
      <h2>Plan a route <small class="cnt" id="r-n">${route.ids.length} picked</small></h2>
      <p class="hint">Tick the stops. The route starts from where you are standing and puts them in the best driving order. Use the category chips up top to narrow the list.</p>
      ${sortChips()}
      <label class="check"><input type="checkbox" id="r-loop" ${route.loop ? 'checked' : ''}> End back where we start</label>
      <div class="row" style="margin-top:8px"><button class="btn go" data-act="r-build">Build route</button><button class="btn" data-act="r-clear" style="flex:0 0 auto">Clear</button></div>
      <div id="r-items">${list.map((p) => { const c = catOf(p);
        return `<button class="item pick${inRoute(p.id) ? ' on' : ''}" data-pick="${esc(p.id)}"><span class="box"></span><span class="dot" style="--c:${c.color}">${c.icon}</span>
          <span class="t"><div>${esc(p.name)}${isNew(p) ? ' <u class="newtag">NEW</u>' : ''}</div><small>${subline(p, myLoc)}</small></span></button>`; }).join('') || '<p class="hint">Nothing in this category.</p>'}</div>`);
    $('#r-loop').addEventListener('change', (e) => { route.loop = e.target.checked; saveRoute(); });
  }
  function openPlan() {
    const pl = route.plan, stops = pl.order.map((id) => places[id]).filter((p) => p && !gone(p));
    const todo = stops.filter((p) => !route.done.includes(p.id)), next = todo[0];
    const backTo = pl.back ? pl.start : null;
    const g = googleLinks(todo, backTo), a = appleLinks(todo, backTo);
    openSheet('route', `
      <h2>Route <small class="cnt">${stops.length} ${stops.length === 1 ? 'stop' : 'stops'} · ${fmtMi(pl.mi)}${pl.min != null ? ' · ' + fmtMin(pl.min) + ' driving' : ''}</small></h2>
      <p class="hint">${pl.road ? 'Ordered by drive time from where you were standing.' : 'Straight-line guess (no road data when this was built). Rebuild when you have signal.'}${pl.back ? ' Ends back at the start.' : ''}</p>
      ${next ? `<div class="row"><a class="btn go" href="${appleTo(next)}" target="_blank" rel="noopener">Next stop in Apple Maps: ${esc(next.name)}</a></div>` : '<p class="note">Every stop is checked off. Nice haul.</p>'}
      ${todo.length ? g.map((x) => `<div class="row"><a class="btn" href="${x.url}" target="_blank" rel="noopener">Whole route in Google Maps${g.length > 1 ? ' (stops ' + (x.from || '') + (x.count > 1 ? ' to ' + (x.to || 'start') : '') + ')' : ''}</a></div>`).join('') : ''}
      ${todo.length > 1 ? `<div class="row"><a class="btn" href="${a.a}" target="_blank" rel="noopener">Whole route in Apple Maps${todo.length + (backTo ? 1 : 0) > 14 ? ' (first 14 stops)' : ''}</a></div>` : ''}
      <div id="p-items">${stops.map((p, i) => { const c = catOf(p), l = pl.legs[i] || {}, done = route.done.includes(p.id);
        return `<div class="stop${done ? ' done' : ''}"><b class="n">${i + 1}</b>
          <button class="t" data-open="${esc(p.id)}"><div>${esc(p.name)}</div><small>${townTag(p)}${l.mi != null ? fmtMi(l.mi) + (l.min != null ? ' · ' + fmtMin(l.min) : '') + (i ? '' : ' from start') : ''}</small></button>
          <a class="mini" href="${appleTo(p)}" target="_blank" rel="noopener">Go</a>
          <button class="mini${done ? ' on' : ''}" data-done="${esc(p.id)}">${done ? '✓' : 'Stopped'}</button></div>`; }).join('')}
        ${pl.back ? `<div class="stop"><b class="n">↩</b><span class="t"><div>Back to the start</div><small>${fmtMi(pl.back.mi)}${pl.back.min != null ? ' · ' + fmtMin(pl.back.min) : ''}</small></span></div>` : ''}</div>
      <p class="hint">"Stopped" checks it off and stamps today's visit on the pin. Google links start from wherever the phone is when you tap them and skip checked-off stops.</p>
      <div class="row"><button class="btn" data-act="r-rebuild">Rebuild from here</button><button class="btn" data-act="r-edit">Change stops</button><button class="btn danger" data-act="r-clear">Clear route</button></div>`);
  }

  function openPast() {
    const list = past().sort((a, b) => saleEnd(b) - saleEnd(a));
    openSheet('past', `
      <h2>Past sales <small class="cnt">${list.length}</small></h2>
      <p class="hint">Sales that are over. They are off the map but nothing is lost. Open one and edit the dates if it runs again, like a yearly church sale.</p>
      ${list.map((p) => `<button class="item" data-open="${esc(p.id)}"><span class="dot" style="--c:${catOf(p).color};opacity:.55">${catOf(p).icon}</span>
        <span class="t"><div>${esc(p.name)}</div><small>${townTag(p)}${esc(saleWhen(p))}</small></span></button>`).join('') || '<p class="hint">None.</p>'}
      ${list.length ? '<div class="row"><button class="btn danger" data-act="past-clear">Delete all past sales</button></div>' : ''}`);
  }

  // Sales end while the app is open: check twice a minute and take them off the map when they do.
  let pastN = past().length;
  function tick() {
    const n = past().length;
    if (n !== pastN) { pastN = n; route.ids = route.ids.filter((id) => places[id] && !gone(places[id])); saveRoute(); render(); refreshOpen(); }
  }
  setInterval(tick, 30000);

  function openSettings(welcome) {
    const n = live().length, waiting = Object.values(places).filter((p) => p._dirty).length, last = LS.get('lastSync', 0);
    openSheet('settings', `
      <h2>${welcome ? 'Welcome aboard' : 'Settings'}</h2>
      ${welcome ? '<p class="hint">Two quick things and you are in business.</p>' : ''}
      <label for="s-me">Who is holding this phone?</label>
      <input id="s-me" type="text" value="${esc(me)}" placeholder="Your name" autocomplete="off">
      <label for="s-api">Shared sheet link</label>
      <input id="s-api" type="url" value="${esc(api)}" placeholder="https://script.google.com/macros/s/…/exec" autocomplete="off" autocapitalize="off">
      <p class="hint">${api ? (last ? 'Last synced ' + new Date(last).toLocaleString() + '.' : 'Not synced yet.') + (waiting ? ' ' + waiting + ' change(s) waiting.' : '')
        + (oldScript ? ' The Google Sheet script is the older version: visit stamps stay on this phone until it is updated.' : '')
        : 'Without this, spots stay on this phone only. Paste the web app link from the Google Sheet script.'}</p>
      <div class="row"><button class="btn go" data-act="s-save">Save &amp; sync</button>
        ${api ? '<button class="btn" data-act="s-share">Send setup link</button>' : ''}</div>
      <label>Your ${n} spots</label>
      <div class="row" style="margin-top:0"><button class="btn" data-act="s-import">Import Google list</button><button class="btn" data-act="s-export">Export backup</button>
        <button class="btn" data-act="s-fit">Show all</button>${past().length ? `<button class="btn" data-act="s-past">Past sales (${past().length})</button>` : ''}</div>
      <input id="s-file" type="file" accept=".csv,text/csv" multiple hidden>
      <p class="hint">Import takes the CSV files from Google Takeout (Saved). Spots already on the map are skipped.</p>
      <p class="hint">Town names come from the US Census ZIP areas and the GeoNames postal table (CC BY 4.0).</p>
      <label>App version</label>
      <p class="hint" style="margin-top:0">Good Finds ${APP_VERSION} — ${APP_DATE}${api ? ' · sheet script v' + LS.get('scriptV', '?') : ''}</p>
      <div class="row" style="margin-top:8px"><button class="btn" data-act="s-update">Check for update</button><button class="btn" data-act="s-reload">Reload app files</button></div>
      <p class="hint">The app checks by itself whenever it opens. "Reload app files" is the big hammer if a phone ever looks stuck; your spots are not touched.</p>`);
    $('#s-file').addEventListener('change', importFiles);
  }

  async function importFiles(e) {
    let added = 0, dupes = 0, bad = 0;
    for (const f of e.target.files) {
      const r = parseGoogleCsv(await f.text()); bad += r.unreadable;
      for (const it of r.items) {
        if (places[it.id]) { dupes++; continue; }
        places[it.id] = Object.assign({ rating: 0, date: '', visits: '', addedBy: me || 'Google import', updated: Date.now(), _dirty: true }, it); added++;
      }
    }
    if (seen) { Object.keys(places).forEach((id) => seen.add(id)); saveSeen(); }
    save(); render(); sync(); closeSheet(); if (added) fitAll();
    toast(`Added ${added}. Skipped ${dupes} already here${bad ? ', ' + bad + ' unreadable' : ''}.`);
  }

  async function exportCsv() {
    const rows = [['name', 'town', 'category', 'lat', 'lng', 'rating', 'date', 'last day', 'hours', 'last stop', 'all stops', 'note', 'addedBy']].concat(
      live().sort((a, b) => a.name.localeCompare(b.name)).map((p) => [p.name, p.city || '', catOf(p).label, p.lat, p.lng, p.rating || '', p.date, p.ends || '', p.hours || '', lastVisit(p), visitsOf(p).join(' '), p.note, p.addedBy]));
    const name = 'good-finds-' + new Date().toISOString().slice(0, 10) + '.csv';
    const file = new File([toCsv(rows)], name, { type: 'text/csv' });
    try { if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file] }); return; } } catch (e) { if (e.name === 'AbortError') return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  }

  function startPlacing(p) {
    placing = p || {}; closeSheet();
    $('#placemsg').textContent = p ? 'Slide the map until the crosshair sits where “' + p.name + '” really is.' : 'Slide the map until the crosshair sits on the spot.';
    document.body.classList.add('placing');
  }
  function stopPlacing() { placing = null; document.body.classList.remove('placing'); }
  function finishPlacing() {
    const c = map.getCenter(), was = placing; stopPlacing();
    if (was.id && places[was.id]) { const p = places[was.id]; p.lat = +c.lat.toFixed(6); p.lng = +c.lng.toFixed(6); p.city = ''; noTown.delete(p.id); commit(p); openDetail(p.id, true); toast('Pin moved.'); }
    else openForm(blank(c.lat, c.lng), true);
  }

  let toastT;
  function toast(msg, ms) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms || 2800); }

  function reopenList() { const m = $('#sheet').dataset.mode; if (m === 'list') openList($('#l-q') ? $('#l-q').value : ''); else if (m === 'route' && !route.plan) openRoute(); }

  /* ---------- taps ---------- */
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act],[data-filter],[data-cat],[data-star],[data-open],[data-sort],[data-pick],[data-done],[data-hit],[data-unvisit]');
    if (!el) return;
    const d = el.dataset;
    if (d.filter) { filter = d.filter; render(); reopenList(); return; }
    if (d.sort) { listSort = d.sort; reopenList(); return; }
    if (d.cat) { readForm(); draft.category = d.cat; document.querySelectorAll('[data-cat]').forEach((b) => b.classList.toggle('on', b === el));
      $('#f-sale').hidden = d.cat !== 'rummage'; $('#f-date-l').textContent = d.cat === 'rummage' ? 'First day of the sale' : 'Date (optional)'; return; }
    if (d.star) { const n = +d.star; draft.rating = draft.rating === n ? 0 : n; document.querySelectorAll('[data-star]').forEach((b) => b.classList.toggle('on', +b.dataset.star <= draft.rating)); return; }
    if (d.unvisit) { setVisit(draft, d.unvisit, false); $('#f-visits').innerHTML = visitChips(); return; }
    if (d.open) { const p = places[d.open]; if (p) { map.setView([p.lat, p.lng], Math.max(map.getZoom(), 15)); openDetail(p.id, true); } return; }
    if (d.hit) { if (hits[+d.hit]) showHit(hits[+d.hit]); return; }
    if (d.pick) {
      const i = route.ids.indexOf(d.pick); i >= 0 ? route.ids.splice(i, 1) : route.ids.push(d.pick);
      saveRoute(); el.classList.toggle('on', i < 0); $('#r-n').textContent = route.ids.length + ' picked'; render(); return;
    }
    if (d.done) {
      const p = places[d.done], i = route.done.indexOf(d.done);
      if (i >= 0) route.done.splice(i, 1);
      else { route.done.push(d.done); if (p && !visitsOf(p).includes(today())) { setVisit(p, today(), true); commit(p); } }
      saveRoute(); render(); openPlan(); return;
    }
    switch (d.act) {
      case 'close': closeSheet(); break;
      case 'seen-all': live().forEach((p) => seen.add(p.id)); saveSeen(); filter = 'all'; render(); closeSheet(); toast('All caught up.'); break;
      case 'add': startPlacing(); break;
      case 'list': listFrom = null; openList(); break;
      case 'around': if (places[selected]) { const p = places[selected]; listFrom = { id: p.id, name: p.name, lat: p.lat, lng: p.lng }; listSort = 'near'; selected = null; render(); openList(); } break;
      case 'settings': openSettings(); break;
      case 'locate': locate(); break;
      case 'layer': hybrid = !hybrid; LS.set('hybrid', hybrid); setBase(); toast(hybrid ? 'Hybrid view. Aerial photos load slower than the plain map.' : 'Plain map.'); break;
      case 'search': openSearch(); break;
      case 'route': selected = null; openRoute(); break;
      case 'place-ok': finishPlacing(); break;
      case 'place-cancel': stopPlacing(); break;
      case 'place-me': locate(); break;
      case 'edit': if (places[selected]) openForm(places[selected], false); break;
      case 'move': if (places[selected]) { const p = places[selected]; map.setView([p.lat, p.lng], Math.max(map.getZoom(), 17)); startPlacing(p); } break;
      case 'stamp': if (places[selected]) { const p = places[selected], on = !visitsOf(p).includes(today()); setVisit(p, today(), on); commit(p); openDetail(p.id, true); toast(on ? 'Stamped for today.' : 'Today\'s stamp removed.'); } break;
      case 'toggle-route': if (places[selected]) {
        const id = selected, i = route.ids.indexOf(id);
        if (i >= 0) { route.ids.splice(i, 1); if (route.plan) { route.plan = null; routeLayer.clearLayers(); toast('Removed. Rebuild the route to reorder.'); } }
        else { route.ids.push(id); if (route.plan) { route.plan = null; routeLayer.clearLayers(); } toast('Added. ' + route.ids.length + ' on the route list. Tap 🧭 to build it.'); }
        saveRoute(); openDetail(id, true);
      } break;
      case 'addvisit': { const v = $('#f-visit').value; if (v) { setVisit(draft, v, true); $('#f-visits').innerHTML = visitChips(); } break; }
      case 'delete':
        if (!el.classList.contains('arm')) { el.classList.add('arm'); el.textContent = 'Tap again to delete'; break; }
        if (places[selected]) { const p = places[selected]; p.deleted = true; selected = null; route.ids = route.ids.filter((x) => x !== p.id); saveRoute(); commit(p); closeSheet(); toast('Deleted.'); }
        break;
      case 'save':
        readForm();
        if (!draft.name) { toast('Give it a name first.'); $('#f-name').focus(); break; }
        if (draft.category === 'rummage' && draft.ends && !draft.date) { toast('Set the first day of the sale too.'); break; }
        if (draft.category === 'rummage' && draft.ends && draft.ends < draft.date) { toast('The last day is before the first day.'); break; }
        if (draftNew && !draft.addedBy) draft.addedBy = me;
        if (foundMarker) { map.removeLayer(foundMarker); foundMarker = null; found = null; }
        commit(draft); pastN = past().length; openDetail(draft.id, !draftNew); toast(expired(draft) ? 'Saved, but that sale is already over, so it went to Past sales.' : draftNew ? 'On the map.' : 'Saved.', expired(draft) ? 5000 : 0);
        break;
      case 'save-hit': if (found) { const b = blank(found.lat, found.lng); b.name = found.name; b.note = found.sub || ''; openForm(b, true); } break;
      case 'r-build': case 'r-rebuild':
        if (d.act === 'r-rebuild') { route.ids = route.plan.order.filter((id) => !route.done.includes(id)); route.done = []; if (!route.ids.length) { toast('Nothing left to visit.'); break; } }
        closeSheet(); buildRoute(); break;
      case 'r-edit': route.plan = null; saveRoute(); routeLayer.clearLayers(); render(); openRoute(); break;
      case 'r-clear': clearRoute(false); closeSheet(); toast('Route cleared.'); break;
      case 's-save':
        me = $('#s-me').value.trim(); LS.set('me', me);
        { const was = api; api = $('#s-api').value.trim(); LS.set('api', api); if (api !== was) { seenSynced = false; LS.set('seenSynced', false); } }
        closeSheet(); render();
        if (api) sync(true); else toast('Saved. Spots stay on this phone until you add the sheet link.');
        break;
      case 's-share': {
        const link = location.origin + location.pathname + '?sync=' + encodeURIComponent(api);
        try { if (navigator.share) { await navigator.share({ title: 'Good Finds setup', text: 'Open this in Safari, then Share > Add to Home Screen.', url: link }); break; } } catch (err) { if (err.name === 'AbortError') break; }
        try { await navigator.clipboard.writeText(link); toast('Setup link copied.'); } catch (err) { prompt('Copy this link:', link); }
        break;
      }
      case 's-import': $('#s-file').click(); break;
      case 's-export': exportCsv(); break;
      case 's-fit': closeSheet(); fitAll(); break;
      case 's-past': openPast(); break;
      case 's-update': closeSheet(); checkUpdate('manual'); break;
      case 's-reload': closeSheet(); applyUpdate(null); break;
      case 'do-update': applyUpdate(latestV); break;
      case 'past-clear':
        if (!el.classList.contains('arm')) { el.classList.add('arm'); el.textContent = 'Tap again to delete them all'; break; }
        { const list = past(), now = Date.now(); list.forEach((p) => { p.deleted = true; p.updated = now; p._dirty = true; }); pastN = 0; save(); render(); sync(); closeSheet(); toast('Deleted ' + list.length + ' past ' + (list.length === 1 ? 'sale' : 'sales') + '.'); }
        break;
    }
  });

  /* ---------- keeping the app itself up to date ---------- */
  const swOK = 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost');
  let latestV = null, lastCheck = 0, updating = false;
  const ss = { get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} } };
  // Asks the server (never the saved copy) which version is live. how: 'launch' | 'resume' | 'manual'
  async function checkUpdate(how) {
    if (!swOK || updating) return;
    if (!navigator.onLine) { if (how === 'manual') toast('No signal, so I cannot check right now.'); return; }
    if (how === 'manual') toast('Checking…');
    lastCheck = Date.now();
    try {
      const txt = await (await fetch('sw.js?check=' + Date.now(), { cache: 'no-store' })).text();
      const m = /VERSION = '(v[\d.]+)'/.exec(txt) || /gf-shell-(v[\d.]+)/.exec(txt);
      if (!m) throw new Error('no version');
      latestV = m[1];
      if (latestV === APP_VERSION) { $('#upd').hidden = true; if (how === 'manual') toast('You are on the latest version, ' + APP_VERSION + '.'); return; }
      // Update by itself at launch or when asked. If someone is mid-task (a panel is open), or it already tried once, show the banner instead.
      const busy = $('#sheet').classList.contains('open') || !!placing;
      if (how === 'manual' || (how === 'launch' && !busy && ss.get('gf.upd') !== latestV)) return applyUpdate(latestV);
      $('#upd').textContent = 'Version ' + latestV.slice(1) + ' is ready. Tap here to update.'; $('#upd').hidden = false;
    } catch (e) { if (how === 'manual') toast('Could not check right now.'); }
  }
  // Swaps in the new set of app files and restarts. Spots, settings and unsynced changes live elsewhere and are not touched.
  async function applyUpdate(v) {
    if (!swOK || updating) return;
    if (!navigator.onLine) return toast('No signal. Try again when you have bars.');
    updating = true; if (v) ss.set('gf.upd', v);
    $('#upd').textContent = v ? 'Updating to version ' + v.slice(1) + '…' : 'Reloading app files…'; $('#upd').hidden = false;
    try {
      if (!v) { const ks = await caches.keys(); await Promise.all(ks.filter((k) => k.startsWith('gf-shell-')).map((k) => caches.delete(k))); }
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) {
        await reg.update().catch(() => {});
        const w = reg.installing || reg.waiting;
        if (w) await new Promise((res) => { const t = setTimeout(res, 20000); w.addEventListener('statechange', () => { if (w.state === 'activated' || w.state === 'redundant') { clearTimeout(t); res(); } }); });
      }
      if (v) { const ks = await caches.keys(); if (ks.includes('gf-shell-' + v)) await Promise.all(ks.filter((k) => k.startsWith('gf-shell-') && k !== 'gf-shell-' + v).map((k) => caches.delete(k))); }
    } catch (e) { /* reload anyway */ }
    location.reload();
  }

  /* ---------- go ---------- */
  $('#ver').textContent = APP_VERSION;
  render(); drawRoute();
  if (!view && live().length) fitAll();
  if (!me) openSettings(true);
  sync();
  window.addEventListener('online', () => { sync(); fillTowns(); });
  setTimeout(fillTowns, 2500);
  window.addEventListener('offline', renderStatus);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { sync(); if (Date.now() - lastCheck > 120000) checkUpdate('resume'); } });
  setInterval(() => { if (!document.hidden) sync(); }, 60000);
  if (swOK) { navigator.serviceWorker.register('sw.js').catch(() => {}); setTimeout(() => checkUpdate('launch'), 1200); }
  window.GFapp = { version: APP_VERSION, checkUpdate, tick, sync, get places() { return places; }, get route() { return route; } }; // for troubleshooting from the console
})();

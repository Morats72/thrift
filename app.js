/* Good Finds - the app. Pins live on the phone; the Google Sheet is the shared copy. */
(() => {
  const { CATS, parseGoogleCsv, toCsv } = window.GF;
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
  let filter = 'all';
  let selected = null;
  let myLoc = null;
  let syncing = false, syncState = 'idle';
  let placing = null; // {id} when moving an existing pin, {} when adding

  // A setup link (?sync=...) configures the shared sheet on a new phone.
  const qsSync = new URLSearchParams(location.search).get('sync');
  if (qsSync && qsSync !== api) { api = qsSync; LS.set('api', api); }

  /* ---------- map ---------- */
  const view = LS.get('view', null);
  const map = L.map('map', { zoomControl: false, maxZoom: 19 }).setView(view ? [view.lat, view.lng] : [39.5, -89], view ? view.z : 4);
  // Basemap: OpenFreeMap "Positron" - streets, towns and water, no businesses. No account, no key.
  // If the phone cannot draw it, fall back to the standard OpenStreetMap tiles.
  let base = null;
  try {
    const gl = document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl');
    if (gl && window.maplibregl && L.maplibreGL) {
      base = L.maplibreGL({ style: 'https://tiles.openfreemap.org/styles/positron',
        attribution: '<a href="https://openfreemap.org">OpenFreeMap</a> &copy; OpenMapTiles &copy; OpenStreetMap contributors' });
    }
  } catch (e) { base = null; }
  if (!base) base = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, crossOrigin: true, attribution: '&copy; OpenStreetMap contributors' });
  base.addTo(map);
  const pins = L.layerGroup().addTo(map);
  let meMarker = null;
  map.on('moveend', () => { const c = map.getCenter(); LS.set('view', { lat: c.lat, lng: c.lng, z: map.getZoom() }); });
  map.on('click', () => { if (!placing && $('#sheet').dataset.mode === 'detail') closeSheet(); });
  map.on('contextmenu', (e) => { if (!placing) openForm(blank(e.latlng.lat, e.latlng.lng), true); }); // long-press

  const live = () => Object.values(places).filter((p) => !p.deleted);
  const shown = () => live().filter((p) => filter === 'all' || p.category === filter);
  const catOf = (p) => CAT[p.category] || CAT.other;

  function save() { LS.set('places', places); }

  function render() {
    pins.clearLayers();
    for (const p of shown()) {
      const c = catOf(p);
      const icon = L.divIcon({ className: '', iconSize: [34, 42], iconAnchor: [17, 40],
        html: `<div class="pin${p.id === selected ? ' sel' : ''}" style="--c:${c.color}"><span>${c.icon}</span></div>` });
      L.marker([p.lat, p.lng], { icon, title: p.name }).on('click', () => openDetail(p.id)).addTo(pins);
    }
    const all = live(), counts = {};
    all.forEach((p) => { const k = catOf(p).id; counts[k] = (counts[k] || 0) + 1; });
    $('#chips').innerHTML = `<button class="chip${filter === 'all' ? ' on' : ''}" data-filter="all">All<b>${all.length}</b></button>` +
      CATS.map((c) => `<button class="chip${filter === c.id ? ' on' : ''}" data-filter="${c.id}">${c.icon} ${esc(c.label)}<b>${counts[c.id] || 0}</b></button>`).join('');
    renderStatus();
  }

  function renderStatus() {
    const el = $('#status');
    const waiting = Object.values(places).filter((p) => p._dirty).length;
    let t, cls = '';
    if (!api) { t = 'This phone only'; }
    else if (syncing) { t = 'Syncing…'; }
    else if (!navigator.onLine) { t = waiting ? waiting + ' waiting for signal' : 'Offline'; cls = waiting ? 'warn' : ''; }
    else if (waiting) { t = waiting + ' waiting to sync'; cls = 'warn'; }
    else if (syncState === 'error') { t = 'Sync failed'; cls = 'warn'; }
    else { t = 'Synced'; cls = 'ok'; }
    el.textContent = t; el.className = cls;
  }

  function fitAll() {
    const pts = shown().map((p) => [p.lat, p.lng]);
    if (pts.length) map.fitBounds(pts, { padding: [50, 50], maxZoom: 14 });
  }

  /* ---------- sync with the Google Sheet ---------- */
  const wire = (p) => ({ id: p.id, name: p.name, lat: p.lat, lng: p.lng, category: p.category, note: p.note || '', rating: p.rating || '',
    date: p.date || '', addedBy: p.addedBy || '', updated: p.updated, deleted: p.deleted ? '1' : '' });
  const unwire = (s) => ({ id: String(s.id), name: String(s.name || ''), lat: Number(s.lat), lng: Number(s.lng), category: String(s.category || 'other'),
    note: String(s.note || ''), rating: Number(s.rating) || 0, date: String(s.date || ''), addedBy: String(s.addedBy || ''),
    updated: Number(s.updated) || 0, deleted: ['1', 'true', 'TRUE'].includes(String(s.deleted)) });

  async function sync(loud) {
    if (!api || syncing) return;
    if (!navigator.onLine) { renderStatus(); if (loud) toast('No signal. It will sync when you have bars.'); return; }
    syncing = true; renderStatus();
    const sent = Object.values(places).filter((p) => p._dirty).map(wire);
    const first = !live().length;
    try {
      const res = await fetch(api, { method: 'POST', body: JSON.stringify({ action: 'sync', changes: sent }) });
      const j = await res.json();
      if (!j.ok || !Array.isArray(j.places)) throw new Error(j.error || 'Unexpected reply');
      const sentAt = Object.fromEntries(sent.map((p) => [p.id, p.updated]));
      const next = {};
      for (const s of j.places) { const p = unwire(s); if (p.id && isFinite(p.lat) && isFinite(p.lng)) next[p.id] = p; }
      // keep anything edited on this phone while the request was in the air
      for (const p of Object.values(places)) if (p._dirty && sentAt[p.id] !== p.updated) next[p.id] = p;
      places = next; save(); syncState = 'ok'; LS.set('lastSync', Date.now());
      syncing = false; render();
      if (first && !view) fitAll();
      if ($('#sheet').dataset.mode === 'detail' && selected) { places[selected] && !places[selected].deleted ? openDetail(selected, true) : closeSheet(); }
      if (loud) toast('Synced. ' + live().length + ' spots.');
    } catch (e) {
      syncing = false; syncState = 'error'; renderStatus();
      if (loud) toast('Could not reach the sheet. Check the link in Settings.');
    }
  }

  function commit(p) {
    p.updated = Date.now(); p._dirty = true;
    places[p.id] = p; save(); render(); sync();
  }

  /* ---------- sheet (bottom panel) ---------- */
  function openSheet(mode, html) {
    const s = $('#sheet');
    s.dataset.mode = mode;
    s.innerHTML = '<div class="grab"></div><button class="x" data-act="close" aria-label="Close">×</button>' + html;
    s.classList.add('open'); s.scrollTop = 0;
  }
  function closeSheet() { $('#sheet').classList.remove('open'); $('#sheet').dataset.mode = ''; if (selected) { selected = null; render(); } }

  const stars = (n) => (n ? '★'.repeat(n) + '☆'.repeat(5 - n) : '');
  const niceDate = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : (d || ''); };

  function distMi(a, b) {
    const R = 3958.8, r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  const fmtMi = (d) => (d < 10 ? d.toFixed(1) : Math.round(d)) + ' mi';

  function openDetail(id, quiet) {
    const p = places[id]; if (!p) return;
    selected = id; render();
    const c = catOf(p);
    openSheet('detail', `
      <h2>${esc(p.name)}</h2>
      <p class="meta"><span class="badge" style="--c:${c.color}">${c.icon} ${esc(c.label)}</span>
        ${myLoc ? ' &nbsp;' + fmtMi(distMi(myLoc, p)) + ' away' : ''}</p>
      ${p.rating ? `<div class="stars">${stars(p.rating)}</div>` : ''}
      ${p.date ? `<p class="meta">📅 ${esc(niceDate(p.date))}</p>` : ''}
      ${p.note ? `<div class="note">${esc(p.note)}</div>` : ''}
      ${p.addedBy ? `<p class="meta">Flagged by ${esc(p.addedBy)}</p>` : ''}
      <div class="row">
        <a class="btn go" href="https://maps.apple.com/?daddr=${p.lat},${p.lng}&q=${encodeURIComponent(p.name)}" target="_blank" rel="noopener">Directions</a>
        <button class="btn" data-act="edit">Edit</button>
      </div>
      <div class="row">
        <button class="btn" data-act="move">Move pin</button>
        <button class="btn danger" data-act="delete">Delete</button>
      </div>`);
    if (!quiet) map.panTo([p.lat, p.lng]);
  }

  const blank = (lat, lng) => ({ id: 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: '', lat: +lat.toFixed(6), lng: +lng.toFixed(6),
    category: filter !== 'all' ? filter : 'thrift', note: '', rating: 0, date: '', addedBy: me });

  let draft = null, draftNew = false;
  function openForm(p, isNew) {
    draft = Object.assign({}, p); draftNew = isNew;
    openSheet('form', `
      <h2>${isNew ? 'New spot' : 'Edit spot'}</h2>
      <label for="f-name">Name</label><input id="f-name" type="text" value="${esc(draft.name)}" placeholder="What is it?" autocomplete="off">
      <label>Category</label>
      <div class="cats">${CATS.map((c) => `<button type="button" data-cat="${c.id}" class="${draft.category === c.id ? 'on' : ''}">${c.icon} ${esc(c.label)}</button>`).join('')}</div>
      <label>Worth the stop?</label>
      <div class="stars" id="f-stars">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-star="${n}" class="${n <= draft.rating ? 'on' : ''}">★</button>`).join('')}</div>
      <label for="f-date">Date (optional, handy for rummage sales)</label><input id="f-date" type="date" value="${esc(draft.date)}">
      <label for="f-note">Notes</label><textarea id="f-note" placeholder="Good tool section, cash only, closed Mondays…">${esc(draft.note)}</textarea>
      <div class="row"><button class="btn" data-act="close">Cancel</button><button class="btn go" data-act="save">Save</button></div>`);
  }
  function readForm() {
    draft.name = $('#f-name').value.trim(); draft.date = $('#f-date').value; draft.note = $('#f-note').value.trim();
  }

  function openList(q) {
    let list = shown();
    if (myLoc) list.forEach((p) => { p._d = distMi(myLoc, p); });
    list.sort((a, b) => (myLoc ? a._d - b._d : a.name.localeCompare(b.name)));
    openSheet('list', `
      <h2>${filter === 'all' ? 'All spots' : esc(CAT[filter].label)} <small style="font:14px var(--sans);color:var(--soft)">${list.length}</small></h2>
      <input id="l-q" type="search" placeholder="Search names and notes" value="${esc(q || '')}">
      <p class="hint">${myLoc ? 'Closest first.' : 'Tap ◎ on the map to sort these by distance.'}</p>
      <div id="l-items"></div>`);
    const draw = () => {
      const needle = $('#l-q').value.trim().toLowerCase();
      const rows = list.filter((p) => !needle || (p.name + ' ' + p.note).toLowerCase().includes(needle));
      $('#l-items').innerHTML = rows.map((p) => { const c = catOf(p);
        return `<button class="item" data-open="${esc(p.id)}"><span class="dot" style="--c:${c.color}">${c.icon}</span>
          <span class="t"><div>${esc(p.name)}</div><small>${esc(c.label)}${p.rating ? ' · ' + stars(p.rating) : ''}${myLoc ? ' · ' + fmtMi(p._d) : ''}</small></span></button>`; }).join('') ||
        '<p class="hint">Nothing here yet.</p>';
    };
    $('#l-q').addEventListener('input', draw); draw();
  }

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
        : 'Without this, spots stay on this phone only. Paste the web app link from the Google Sheet script.'}</p>
      <div class="row"><button class="btn go" data-act="s-save">Save &amp; sync</button>
        ${api ? '<button class="btn" data-act="s-share">Send setup link</button>' : ''}</div>
      <label>Your ${n} spots</label>
      <div class="row" style="margin-top:0"><button class="btn" data-act="s-import">Import Google list</button><button class="btn" data-act="s-export">Export backup</button>
        <button class="btn" data-act="s-fit">Show all</button></div>
      <input id="s-file" type="file" accept=".csv,text/csv" multiple hidden>
      <p class="hint">Import takes the CSV files from Google Takeout (Saved). Spots already on the map are skipped.</p>`);
    $('#s-file').addEventListener('change', importFiles);
  }

  async function importFiles(e) {
    let added = 0, dupes = 0, bad = 0;
    for (const f of e.target.files) {
      const r = parseGoogleCsv(await f.text()); bad += r.unreadable;
      for (const it of r.items) {
        if (places[it.id]) { dupes++; continue; }
        places[it.id] = Object.assign({ rating: 0, date: '', addedBy: me || 'Google import', updated: Date.now(), _dirty: true }, it); added++;
      }
    }
    save(); render(); sync(); closeSheet(); if (added) fitAll();
    toast(`Added ${added}. Skipped ${dupes} already here${bad ? ', ' + bad + ' unreadable' : ''}.`);
  }

  async function exportCsv() {
    const rows = [['name', 'category', 'lat', 'lng', 'rating', 'date', 'note', 'addedBy']].concat(
      live().sort((a, b) => a.name.localeCompare(b.name)).map((p) => [p.name, catOf(p).label, p.lat, p.lng, p.rating || '', p.date, p.note, p.addedBy]));
    const name = 'good-finds-' + new Date().toISOString().slice(0, 10) + '.csv';
    const file = new File([toCsv(rows)], name, { type: 'text/csv' });
    try { if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file] }); return; } } catch (e) { if (e.name === 'AbortError') return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  }

  function locate(then) {
    if (!navigator.geolocation) return toast('This phone will not share its location.');
    toast('Finding you…');
    navigator.geolocation.getCurrentPosition((pos) => {
      myLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      if (!meMarker) meMarker = L.marker([myLoc.lat, myLoc.lng], { icon: L.divIcon({ className: '', html: '<div class="medot"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }), interactive: false, zIndexOffset: -100 }).addTo(map);
      meMarker.setLatLng([myLoc.lat, myLoc.lng]);
      map.setView([myLoc.lat, myLoc.lng], Math.max(map.getZoom(), 14));
      if (then) then();
    }, () => toast('Could not get a location fix.'), { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
  }

  function startPlacing(p) {
    placing = p || {}; closeSheet();
    $('#placemsg').textContent = p ? 'Slide the map until the crosshair sits where “' + p.name + '” really is.' : 'Slide the map until the crosshair sits on the spot.';
    document.body.classList.add('placing');
  }
  function stopPlacing() { placing = null; document.body.classList.remove('placing'); }
  function finishPlacing() {
    const c = map.getCenter(), was = placing; stopPlacing();
    if (was.id && places[was.id]) { const p = places[was.id]; p.lat = +c.lat.toFixed(6); p.lng = +c.lng.toFixed(6); commit(p); openDetail(p.id, true); toast('Pin moved.'); }
    else openForm(blank(c.lat, c.lng), true);
  }

  let toastT;
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600); }

  /* ---------- taps ---------- */
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act],[data-filter],[data-cat],[data-star],[data-open]');
    if (!el) return;
    if (el.dataset.filter) { filter = el.dataset.filter; render(); if ($('#sheet').dataset.mode === 'list') openList(); return; }
    if (el.dataset.cat) { readForm(); draft.category = el.dataset.cat; document.querySelectorAll('[data-cat]').forEach((b) => b.classList.toggle('on', b === el)); return; }
    if (el.dataset.star) { const n = +el.dataset.star; draft.rating = draft.rating === n ? 0 : n; document.querySelectorAll('[data-star]').forEach((b) => b.classList.toggle('on', +b.dataset.star <= draft.rating)); return; }
    if (el.dataset.open) { const p = places[el.dataset.open]; if (p) { map.setView([p.lat, p.lng], Math.max(map.getZoom(), 15)); openDetail(p.id, true); } return; }
    switch (el.dataset.act) {
      case 'close': closeSheet(); break;
      case 'add': startPlacing(); break;
      case 'list': openList(); break;
      case 'settings': openSettings(); break;
      case 'locate': locate(); break;
      case 'place-ok': finishPlacing(); break;
      case 'place-cancel': stopPlacing(); break;
      case 'place-me': locate(); break;
      case 'edit': if (places[selected]) openForm(places[selected], false); break;
      case 'move': if (places[selected]) { const p = places[selected]; map.setView([p.lat, p.lng], Math.max(map.getZoom(), 17)); startPlacing(p); } break;
      case 'delete':
        if (!el.classList.contains('arm')) { el.classList.add('arm'); el.textContent = 'Tap again to delete'; break; }
        if (places[selected]) { const p = places[selected]; p.deleted = true; selected = null; commit(p); closeSheet(); toast('Deleted.'); }
        break;
      case 'save':
        readForm();
        if (!draft.name) { toast('Give it a name first.'); $('#f-name').focus(); break; }
        if (draftNew && !draft.addedBy) draft.addedBy = me;
        commit(draft); openDetail(draft.id, !draftNew); toast(draftNew ? 'On the map.' : 'Saved.');
        break;
      case 's-save':
        me = $('#s-me').value.trim(); LS.set('me', me);
        api = $('#s-api').value.trim(); LS.set('api', api);
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
    }
  });

  /* ---------- go ---------- */
  render();
  if (!view && live().length) fitAll();
  if (!me) openSettings(true);
  sync();
  window.addEventListener('online', () => sync());
  window.addEventListener('offline', renderStatus);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
  setInterval(() => { if (!document.hidden) sync(); }, 60000);
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => {});
  window.GFapp = { sync, get places() { return places; } }; // for troubleshooting from the console
})();

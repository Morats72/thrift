/* Good Finds - offline support.
   The app files are saved on the phone as one matched set per version, so the app opens instantly and works with no signal.
   A new version is picked up when VERSION below changes: the app checks this file for it every time it opens or comes back
   to the front, then swaps the whole set at once. Bump VERSION here and APP_VERSION in app.js together on every deploy.
   Map tiles you have already looked at are kept so the map still draws with no signal. */
const VERSION = 'v1.6';
const SHELL = 'gf-shell-' + VERSION, TILES = 'gf-tiles-v1', MAX_TILES = 4000;
const FILES = ['./', 'index.html', 'app.js', 'lib.js', 'leaflet.js', 'leaflet.css', 'maplibre-gl.js', 'maplibre-gl.css', 'leaflet-maplibre-gl.js', 'manifest.json', 'icon-180.png', 'icon-192.png', 'icon-512.png'];

// cache: 'reload' makes the phone fetch real copies from the server instead of reusing ones it downloaded a few minutes ago.
self.addEventListener('install', (e) => { e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== SHELL && k !== TILES).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

async function trimTiles() {
  const c = await caches.open(TILES), ks = await c.keys();
  if (ks.length > MAX_TILES) await Promise.all(ks.slice(0, ks.length - MAX_TILES + 400).map((k) => c.delete(k)));
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname === 'tiles.openfreemap.org' || url.hostname === 'tile.openstreetmap.org' || url.hostname === 'imagery.nationalmap.gov') {
    // Map pieces (tiles, fonts, icons) never change: keep them. The small style files refresh when there is signal.
    const keep = url.hostname === 'imagery.nationalmap.gov' || /\.(pbf|png)$/.test(url.pathname) || url.pathname.startsWith('/fonts/') || url.pathname.startsWith('/sprites/');
    e.respondWith(caches.open(TILES).then(async (c) => {
      const hit = await c.match(req);
      if (hit && keep) return hit;
      const fresh = fetch(req).then((res) => { if (res.ok) { c.put(req, res.clone()); if (Math.random() < 0.02) trimTiles(); } return res; });
      return hit ? (fresh.catch(() => {}), hit) : fresh;
    }));
    return;
  }
  if (url.origin === location.origin) {
    if (url.searchParams.has('check')) return; // the app's "is there a newer version?" question always goes to the server
    e.respondWith(caches.open(SHELL).then(async (c) => {
      const hit = await c.match(req, { ignoreSearch: true });
      if (hit) return hit; // the saved set is never mixed with newer files; a new VERSION replaces all of it at once
      const res = await fetch(req.mode === 'navigate' ? req.url : req, { cache: 'no-cache' });
      if (res.ok) c.put(url.pathname, res.clone()); // extras outside the set, like the town table
      return res;
    }));
  }
});

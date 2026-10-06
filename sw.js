/* Good Finds - offline support. App files load from the phone first and refresh in the background.
   Map tiles you have already looked at are kept so the map still draws with no signal. */
const SHELL = 'gf-shell-v2', TILES = 'gf-tiles-v1', MAX_TILES = 4000;
const FILES = ['./', 'index.html', 'app.js', 'lib.js', 'leaflet.js', 'leaflet.css', 'maplibre-gl.js', 'maplibre-gl.css', 'leaflet-maplibre-gl.js', 'manifest.json', 'icon-180.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
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
  if (url.hostname === 'tiles.openfreemap.org' || url.hostname === 'tile.openstreetmap.org') {
    // Map pieces (tiles, fonts, icons) never change: keep them. The small style files refresh when there is signal.
    const keep = /\.(pbf|png)$/.test(url.pathname) || url.pathname.startsWith('/fonts/') || url.pathname.startsWith('/sprites/');
    e.respondWith(caches.open(TILES).then(async (c) => {
      const hit = await c.match(req);
      if (hit && keep) return hit;
      const fresh = fetch(req).then((res) => { if (res.ok) { c.put(req, res.clone()); if (Math.random() < 0.02) trimTiles(); } return res; });
      return hit ? (fresh.catch(() => {}), hit) : fresh;
    }));
    return;
  }
  if (url.origin === location.origin) {
    e.respondWith(caches.open(SHELL).then(async (c) => {
      const hit = await c.match(req, { ignoreSearch: true });
      const fresh = fetch(req).then((res) => { if (res.ok) c.put(url.pathname, res.clone()); return res; }).catch(() => hit);
      return hit || fresh;
    }));
  }
});

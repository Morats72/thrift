/* Good Finds - shared helpers (categories, Google export decoding, CSV). */
(function (root) {
  const CATS = [
    { id: 'thrift', label: 'Thrift', icon: '🧥', color: '#2f6b4f' },
    { id: 'flea', label: 'Flea market', icon: '🎪', color: '#b4532a' },
    { id: 'antique', label: 'Antique', icon: '🕰️', color: '#7a5a2b' },
    { id: 'consignment', label: 'Consignment', icon: '🏷️', color: '#7b4a86' },
    { id: 'rummage', label: 'Rummage sale', icon: '🪧', color: '#c98a12' },
    { id: 'food', label: 'Food', icon: '🍔', color: '#b23a48' },
    { id: 'stay', label: 'Stayed here', icon: '🏠', color: '#1f7a8c' },
    { id: 'other', label: 'Other', icon: '📍', color: '#47607a' }
  ];

  // Google's place links carry an ID whose first half is a location code
  // (an S2 cell). This turns that code into a latitude and longitude.
  function s2ToLatLng(hex) {
    let id;
    try { id = BigInt('0x' + String(hex).replace(/^0x/i, '')); } catch (e) { return null; }
    const face = Number(id >> 61n);
    if (face > 5 || id === 0n) return null;
    const P2IJ = [[0, 1, 3, 2], [0, 2, 3, 1], [3, 2, 0, 1], [3, 1, 0, 2]];
    const P2O = [1, 0, 0, 3];
    let o = face & 1, i = 0, j = 0;
    for (let k = 29; k >= 0; k--) {
      const pos = Number((id >> BigInt(2 * k + 1)) & 3n);
      const ij = P2IJ[o][pos];
      i = i * 2 + (ij >> 1);
      j = j * 2 + (ij & 1);
      o ^= P2O[pos];
    }
    const st = (x) => {
      const s = (2 * x + 1) / 2147483648;
      return s >= 0.5 ? (4 * s * s - 1) / 3 : (1 - 4 * (1 - s) * (1 - s)) / 3;
    };
    const u = st(i), v = st(j);
    const p = [[1, u, v], [-u, 1, v], [-u, -v, 1], [-1, -v, -u], [v, -1, -u], [v, u, -1]][face];
    const deg = 180 / Math.PI;
    return {
      lat: round6(Math.atan2(p[2], Math.hypot(p[0], p[1])) * deg),
      lng: round6(Math.atan2(p[1], p[0]) * deg)
    };
  }
  function round6(n) { return Math.round(n * 1e6) / 1e6; }

  function guessCat(name) {
    const n = String(name || '').toLowerCase();
    if (/subway|coffee|cafe|café|diner|grill|bbq|restaurant|pizza|bakery|burger|tavern|brewery/.test(n)) return 'food';
    if (/airbnb|vrbo|\bcabins?\b|hotel|motel|\binn\b|\blodge\b|campground|\bresort\b/.test(n)) return 'stay';
    if (/rummage|yard sale|garage sale|estate sale/.test(n)) return 'rummage';
    if (/flea|trading post|swap meet/.test(n)) return 'flea';
    if (/consign/.test(n)) return 'consignment';
    if (/thrift|goodwill|karm\b|habitat|restore|amvets|salvation|family store|st\.? vincent|resale|second (season|chance)|community chest/.test(n)) return 'thrift';
    if (/antique|vintage|collectible/.test(n)) return 'antique';
    return 'other';
  }

  function parseCsv(text) {
    const rows = []; let row = [], cur = '', q = false;
    text = String(text).replace(/^﻿/, '');
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cur); rows.push(row); row = []; cur = '';
      } else cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }

  // Reads a Google Maps "Saved" list export. Returns {items, unreadable}.
  function parseGoogleCsv(text) {
    const rows = parseCsv(text);
    if (!rows.length) return { items: [], unreadable: 0 };
    const head = rows[0].map((h) => h.trim().toLowerCase());
    const col = (n) => head.indexOf(n);
    const cT = col('title'), cN = col('note'), cU = col('url'), cC = col('comment');
    const items = []; let unreadable = 0;
    for (const r of rows.slice(1)) {
      const url = cU >= 0 ? (r[cU] || '').trim() : '';
      const title = cT >= 0 ? (r[cT] || '').trim() : '';
      if (!url && !title) continue;               // blank spacer row
      let id = null, ll = null, m;
      if ((m = url.match(/!1s0x([0-9a-f]+):0x([0-9a-f]+)/i))) {
        ll = s2ToLatLng(m[1]); id = 'g_' + m[2].toLowerCase();
      } else if ((m = url.match(/(?:search\/|@|q=|ll=)(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/))) {
        ll = { lat: round6(+m[1]), lng: round6(+m[2]) };
        id = 'c_' + ll.lat.toFixed(5) + '_' + ll.lng.toFixed(5);
      }
      if (!ll || Math.abs(ll.lat) > 90 || Math.abs(ll.lng) > 180) { unreadable++; continue; }
      const note = [cN >= 0 ? r[cN] : '', cC >= 0 ? r[cC] : ''].map((s) => (s || '').trim()).filter(Boolean).join(' / ');
      items.push({ id, name: title || 'Mystery spot', lat: ll.lat, lng: ll.lng, note, category: guessCat(title) });
    }
    return { items, unreadable };
  }

  function toCsv(rows) {
    return rows.map((r) => r.map((v) => {
      v = v == null ? '' : String(v);
      return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    }).join(',')).join('\r\n');
  }


  // Best visiting order. c is a cost table where row/column 0 is the starting point.
  // Returns the stop numbers (1..n) in driving order. Exact up to 12 stops, very good beyond that.
  function solveOrder(c, loop) {
    const n = c.length - 1;
    if (n <= 0) return [];
    if (n === 1) return [1];
    if (n <= 12) {
      const N = 1 << n, dp = new Float64Array(N * n).fill(Infinity), par = new Int8Array(N * n).fill(-1);
      for (let j = 0; j < n; j++) dp[(1 << j) * n + j] = c[0][j + 1];
      for (let m = 1; m < N; m++) for (let j = 0; j < n; j++) {
        if (!((m >> j) & 1)) continue;
        const cur = dp[m * n + j];
        if (cur === Infinity) continue;
        for (let k = 0; k < n; k++) {
          if ((m >> k) & 1) continue;
          const m2 = m | (1 << k), v = cur + c[j + 1][k + 1];
          if (v < dp[m2 * n + k]) { dp[m2 * n + k] = v; par[m2 * n + k] = j; }
        }
      }
      let best = Infinity, end = 0;
      for (let j = 0; j < n; j++) { const v = dp[(N - 1) * n + j] + (loop ? c[j + 1][0] : 0); if (v < best) { best = v; end = j; } }
      const out = []; let m = N - 1, j = end;
      while (j >= 0) { out.push(j + 1); const pj = par[m * n + j]; m ^= 1 << j; j = pj; }
      return out.reverse();
    }
    const cost = (o) => { let s = c[0][o[0]]; for (let i = 1; i < o.length; i++) s += c[o[i - 1]][o[i]]; return s + (loop ? c[o[o.length - 1]][0] : 0); };
    let o = []; const left = new Set(); for (let i = 1; i <= n; i++) left.add(i);
    let cur = 0;
    while (left.size) { let bk = -1, bv = Infinity; for (const k of left) if (c[cur][k] < bv) { bv = c[cur][k]; bk = k; } o.push(bk); left.delete(bk); cur = bk; }
    let best = cost(o), improved = true;
    while (improved) {
      improved = false;
      for (let i = 0; i < n - 1; i++) for (let j = i + 1; j < n; j++) {
        const cand = o.slice(0, i).concat(o.slice(i, j + 1).reverse(), o.slice(j + 1)), v = cost(cand);
        if (v < best - 1e-9) { o = cand; best = v; improved = true; }
      }
      for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) {
        if (i === k) continue;
        const cand = o.slice(); const [x] = cand.splice(i, 1); cand.splice(k, 0, x); const v = cost(cand);
        if (v < best - 1e-9) { o = cand; best = v; improved = true; }
      }
    }
    return o;
  }
  function routeCost(c, order, loop) {
    if (!order.length) return 0;
    let s = c[0][order[0]]; for (let i = 1; i < order.length; i++) s += c[order[i - 1]][order[i]];
    return s + (loop ? c[order[order.length - 1]][0] : 0);
  }

  // Hand-off links. stops = [{lat,lng}] in driving order; backTo = {lat,lng} to finish where you started, or null.
  // Each link starts from wherever the phone is when it is tapped. Google takes 10 stops per link.
  const ll = (p) => (+p.lat).toFixed(6) + ',' + (+p.lng).toFixed(6);
  function googleLinks(stops, backTo) {
    const seq = stops.map((p, i) => ({ p, n: i + 1 })); if (backTo) seq.push({ p: backTo, n: 0 });
    const out = [];
    for (let i = 0; i < seq.length; i += 10) {
      const part = seq.slice(i, i + 10), dest = part[part.length - 1], way = part.slice(0, -1);
      out.push({ from: part[0].n, to: dest.n, count: part.filter((x) => x.n).length,
        url: 'https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=' + encodeURIComponent(ll(dest.p)) +
          (way.length ? '&waypoints=' + encodeURIComponent(way.map((x) => ll(x.p)).join('|')) : '') });
    }
    return out;
  }
  function appleLinks(stops, backTo) {
    const seq = stops.concat(backTo ? [backTo] : []).slice(0, 14).map(ll);
    if (!seq.length) return { a: '', b: '' };
    return {
      a: 'https://maps.apple.com/directions?mode=driving' + seq.slice(0, -1).map((s) => '&waypoint=' + encodeURIComponent(s)).join('') + '&destination=' + encodeURIComponent(seq[seq.length - 1]),
      b: 'https://maps.apple.com/?dirflg=d&daddr=' + seq.join('+to:')
    };
  }

  const api = { CATS, s2ToLatLng, guessCat, parseCsv, parseGoogleCsv, toCsv, solveOrder, routeCost, googleLinks, appleLinks };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GF = api;
})(typeof self !== 'undefined' ? self : this);

/* Good Finds - shared helpers (categories, Google export decoding, CSV). */
(function (root) {
  const CATS = [
    { id: 'thrift', label: 'Thrift', icon: '🧥', color: '#2f6b4f' },
    { id: 'flea', label: 'Flea market', icon: '🎪', color: '#b4532a' },
    { id: 'antique', label: 'Antique', icon: '🕰️', color: '#7a5a2b' },
    { id: 'consignment', label: 'Consignment', icon: '🏷️', color: '#7b4a86' },
    { id: 'rummage', label: 'Rummage sale', icon: '🪧', color: '#c98a12' },
    { id: 'food', label: 'Food', icon: '🍔', color: '#b23a48' },
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

  const api = { CATS, s2ToLatLng, guessCat, parseCsv, parseGoogleCsv, toCsv };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GF = api;
})(typeof self !== 'undefined' ? self : this);

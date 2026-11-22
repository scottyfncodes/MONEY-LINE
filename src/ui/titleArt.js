// Title-screen artwork: the Pay Streak core sample (canvas 2D painter and its noon palette), from the approved design.
/* eslint-disable */
/* MONEY LINE design-frame diorama painter: a 2:1 isometric miniature valley (canvas 2D). Design frame only, not the game. */
(function () {
  'use strict';
  // ---------- small maths ----------
  function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function hash2(x, y, s) { let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0; h = (h ^ (h >>> 13)) * 1274126177 | 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
  function vnoise(x, y, s) { const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash2(xi, yi, s), b = hash2(xi + 1, yi, s), c = hash2(xi, yi + 1, s), d = hash2(xi + 1, yi + 1, s); return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v; }
  function fbm(x, y, s) { return vnoise(x, y, s) * 0.55 + vnoise(x * 2.1, y * 2.1, s + 7) * 0.3 + vnoise(x * 4.3, y * 4.3, s + 13) * 0.15; }
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v, lerp = (a, b, t) => a + (b - a) * t;
  const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  function hex(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
  function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function css(c, a) { return a === undefined ? `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})` : `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`; }

  // ---------- the world (designed centre 0..48, procedural beyond) ----------
  function catmull(P, per) { const out = []; for (let i = 0; i < P.length - 1; i++) { const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)];
      for (let k = 0; k < per; k++) { const t = k / per, t2 = t * t, t3 = t2 * t;
        out.push([0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
          0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)]); } }
    out.push(P[P.length - 1].slice()); return out; }
  const RIVER = catmull([[44, -30], [38, -18], [34, -8], [30, 0], [27, 6], [23.4, 10.5], [21.6, 15], [20.8, 20], [19, 25], [15.6, 29.5], [13, 35], [11, 44], [6, 56], [0, 70]], 14);
  const RAILXY = catmull([[80, 30], [66, 27.5], [54, 25.6], [44, 24.4], [36, 24], [32, 24], [28, 24], [25, 23.8], [22.6, 22.8], [20.2, 21.5], [17.4, 20.4], [14.2, 19.5], [11.2, 17.8], [9.7, 14.8], [10.6, 12], [12.8, 10.3], [14.5, 8.8]], 16);
  const ANCH = [28, 24], CITY = [28, 25], MINE = [14.9, 8.3];
  function distPoly(P, x, y) { let best = 1e9, bi = 0; for (let i = 0; i < P.length; i++) { const dx = P[i][0] - x, dy = P[i][1] - y, d = dx * dx + dy * dy; if (d < best) { best = d; bi = i; } } return [Math.sqrt(best), bi]; }
  function peak(x, y, px, py, H, r) { const d = Math.hypot(x - px, y - py); return H * Math.pow(Math.max(0, 1 - d / r), 1.55); }
  function rawH(x, y) {
    let h = 0.35 + 1.5 * fbm(x * 0.075, y * 0.075, 3);
    const crag = 0.78 + 0.5 * fbm(x * 0.2, y * 0.2, 21);
    h += (peak(x, y, 6.5, 5, 11.5, 13.5) + peak(x, y, 17, -3, 6, 8.5) + peak(x, y, -2, 15, 6, 9) + peak(x, y, -9, -8, 12, 15) + peak(x, y, 30, -16, 10, 13) + peak(x, y, -14, 9, 9, 12) + peak(x, y, 2, 31, 3.2, 7)) * crag;
    const far = sstep(38, 50, Math.max(x, y)) + sstep(2, -10, Math.min(x, y));            // rougher country past the sheet
    h += far * 5 * Math.max(0, fbm(x * 0.06, y * 0.06, 41) - 0.38);
    const dr = distPoly(RIVER, x, y)[0];
    h = h * sstep(1.0, 7.5, dr) + 0.22 * sstep(1.0, 2.4, dr);
    const dc = Math.hypot(x - CITY[0], y - CITY[1]); h = lerp(h, 0.42, 1 - sstep(6.2, 9.5, dc));
    return [h, dr, dc];
  }
  // the rail profile follows the smoothed ground; the ground is then graded (cut and fill) to it
  let RAIL = null;
  function buildRail() { if (RAIL) return RAIL; const n = RAILXY.length, raw = RAILXY.map(p => rawH(p[0], p[1])), z = new Array(n);
    for (let i = 0; i < n; i++) { let s = 0, c = 0; for (let k = -26; k <= 26; k++) { const j = clamp(i + k, 0, n - 1); s += Math.max(0.45, raw[j][0]); c++; } z[i] = s / c; }
    for (let i = 0; i < n; i++) if (raw[i][1] < 4.2) z[i] = Math.max(z[i], lerp(1.0, z[i], sstep(2.4, 4.2, raw[i][1])));
    for (let i = 0; i < n; i++) { const d = Math.hypot(RAILXY[i][0] - CITY[0], RAILXY[i][1] - CITY[1]); z[i] = lerp(0.45, z[i], sstep(6, 9.5, d)); }   // lift over the river
    let s = 0; RAIL = RAILXY.map((p, i) => { if (i) s += Math.hypot(p[0] - RAILXY[i - 1][0], p[1] - RAILXY[i - 1][1]); return { x: p[0], y: p[1], z: z[i], s, river: raw[i][1] }; });
    RAIL.len = s; return RAIL; }
  function railAt(s) { const R = buildRail(); s = clamp(s, 0, R.len - 0.001); let lo = 0, hi = R.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (R[m].s <= s) lo = m; else hi = m; }
    const a = R[lo], b = R[hi], t = (s - a.s) / (b.s - a.s || 1); return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t), dx: b.x - a.x, dy: b.y - a.y, dz: b.z - a.z, river: a.river }; }
  function ground(x, y) {     // -> {h, water, dr, dc, dp}
    const r = rawH(x, y); let h = r[0]; const R = buildRail(); const dp = distPoly(R, x, y) ; // R items are objects: adapt
    return { h, dr: r[1], dc: r[2] }; }
  function groundFull(x, y) {
    const r = rawH(x, y); let h = r[0]; const R = buildRail(); let best = 1e9, bi = 0;
    for (let i = 0; i < R.length; i += 2) { const dx = R[i].x - x, dy = R[i].y - y, d = dx * dx + dy * dy; if (d < best) { best = d; bi = i; } }
    const dp = Math.sqrt(best), dm = Math.hypot(x - MINE[0], y - MINE[1]);
    if (r[1] > 2.0) h = lerp(h, R[bi].z - 0.06, (1 - sstep(0.75, 2.7, dp)) * sstep(1.9, 3.2, r[1]));
    h = lerp(h, R[R.length - 1].z - 0.06, 1 - sstep(1.7, 3.3, dm));
    const water = r[1] < 1.3; if (water) h = 0;
    return { h, water, dr: r[1], dc: r[2], dp, dm };
  }

  // ---------- painter ----------
  function paint(canvas, o) {
    const pal = {}; for (const k in o.pal) { const v = o.pal[k]; pal[k] = Array.isArray(v) ? v.map(hex) : (typeof v === 'string' && v[0] === '#') ? hex(v) : v; }
    const dpr = o.dpr || window.devicePixelRatio || 1, W = canvas.clientWidth, H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    const g = canvas.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H); g.lineJoin = 'round';
    const tw = o.tw, zs = tw * 0.55, f = o.focus, ax = W * o.at[0], ay = H * o.at[1];
    const ox = ax - (f[0] - f[1]) * tw / 2, oy = ay - (f[0] + f[1]) * tw / 4 + (f[2] || 0) * zs;
    const P = (x, y, z) => [ox + (x - y) * tw / 2, oy + (x + y) * tw / 4 - z * zs];
    const R = buildRail(), rnd = rng(o.seed || 9), dusk = !!o.dusk;
    const L = (() => { const v = o.light || [0.2, 0.62, 0.76], n = Math.hypot(v[0], v[1], v[2]); return [v[0] / n, v[1] / n, v[2] / n]; })();
    const amb = o.ambient === undefined ? 0.5 : o.ambient;
    function lit(base, n) { const lam = Math.max(0, n[0] * L[0] + n[1] * L[1] + n[2] * L[2]), fl = (amb + (1 - amb) * lam) / (amb + (1 - amb) * L[2]);
      let c = [base[0] * fl, base[1] * fl, base[2] * fl];
      if (fl < 1) c = mix(c, pal.shade, clamp((1 - fl) * (pal.shadeAmt || 0.55), 0, 0.6)); else c = mix(c, pal.sun, clamp((fl - 1) * (pal.sunAmt || 0.8), 0, pal.sunMax || 0.5));
      return [clamp(c[0], 0, 255), clamp(c[1], 0, 255), clamp(c[2], 0, 255)]; }
    function poly(pts, col, a, stroke) { g.beginPath(); for (let i = 0; i < pts.length; i++) { const p = P(pts[i][0], pts[i][1], pts[i][2]); if (i) g.lineTo(p[0], p[1]); else g.moveTo(p[0], p[1]); } g.closePath();
      g.fillStyle = css(col, a); g.fill(); if (stroke !== false) { g.strokeStyle = css(col, a); g.lineWidth = 0.6; g.stroke(); } }
    function line(a, b, col, w, alpha) { const p = P(a[0], a[1], a[2]), q = P(b[0], b[1], b[2]); g.beginPath(); g.moveTo(p[0], p[1]); g.lineTo(q[0], q[1]); g.strokeStyle = css(col, alpha); g.lineWidth = w; g.stroke(); }
    function nrm(a, b, c) { const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      let n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]; const l = Math.hypot(n[0], n[1], n[2]) || 1; return [n[0] / l, n[1] / l, n[2] / l]; }
    const CAM = [1, 1, 0.909];
    // a convex solid from faces (each a list of 3D points, outward winding either way: normal is flipped toward its centre's outside)
    function solid(faces, col, centre, opt) { opt = opt || {};
      const fs = []; for (const F of faces) { let n = nrm(F[0], F[1], F[2]); const cx = F.reduce((s, p) => s + p[0], 0) / F.length, cy = F.reduce((s, p) => s + p[1], 0) / F.length, cz = F.reduce((s, p) => s + p[2], 0) / F.length;
        if ((cx - centre[0]) * n[0] + (cy - centre[1]) * n[1] + (cz - centre[2]) * n[2] < 0) n = [-n[0], -n[1], -n[2]];
        if (n[0] * CAM[0] + n[1] * CAM[1] + n[2] * CAM[2] <= 0.001) continue; fs.push([F, n, cx + cy + cz * 0.5]); }
      fs.sort((a, b) => a[2] - b[2]); for (const [F, n] of fs) poly(F, opt.flat ? col : lit(col, n), opt.alpha); }
    function frame(x, y, ang) { const c = Math.cos(ang), s = Math.sin(ang); return (u, v, w) => [x + c * u - s * v, y + s * u + c * v, w]; }   // u along, v across, w up
    function obox(T, u0, u1, v0, v1, w0, w1, col, opt) { const c = [T(u0, v0, w0), T(u1, v0, w0), T(u1, v1, w0), T(u0, v1, w0), T(u0, v0, w1), T(u1, v0, w1), T(u1, v1, w1), T(u0, v1, w1)];
      solid([[c[0], c[1], c[2], c[3]], [c[4], c[5], c[6], c[7]], [c[0], c[1], c[5], c[4]], [c[1], c[2], c[6], c[5]], [c[2], c[3], c[7], c[6]], [c[3], c[0], c[4], c[7]]], col, T((u0 + u1) / 2, (v0 + v1) / 2, (w0 + w1) / 2), opt); }
    function prism(T, u0, u1, sect, col, opt) { const a = sect.map(p => T(u0, p[0], p[1])), b = sect.map(p => T(u1, p[0], p[1])), n = sect.length, faces = [a, b];
      for (let i = 0; i < n; i++) faces.push([a[i], a[(i + 1) % n], b[(i + 1) % n], b[i]]);
      let mv = 0, mw = 0; for (const p of sect) { mv += p[0] / n; mw += p[1] / n; } solid(faces, col, T((u0 + u1) / 2, mv, mw), opt); }
    function cyl(x, y, z, r, h, col, capCol) { const b = P(x, y, z), t = P(x, y, z + h), rx = 0.7071 * r * tw, ry = rx / 2;
      const gr = g.createLinearGradient(b[0] - rx, 0, b[0] + rx, 0); gr.addColorStop(0, css(lit(col, [0, 1, 0.1]))); gr.addColorStop(0.45, css(lit(col, [0.6, 0.7, 0.3]))); gr.addColorStop(1, css(lit(col, [1, -0.3, 0])));
      g.beginPath(); g.ellipse(b[0], b[1], rx, ry, 0, 0, Math.PI); g.lineTo(t[0] - rx, t[1]); g.ellipse(t[0], t[1], rx, ry, 0, Math.PI, 0, true); g.closePath(); g.fillStyle = gr; g.fill();
      g.beginPath(); g.ellipse(t[0], t[1], rx, ry, 0, 0, 7); g.fillStyle = css(lit(capCol || col, [0, 0, 1])); g.fill(); }
    function glow(x, y, z, r, col, a) { if (!dusk && !o.glows) return; const p = P(x, y, z), rr = r * tw; const gr = g.createRadialGradient(p[0], p[1], 0, p[0], p[1], rr);
      gr.addColorStop(0, css(col, a)); gr.addColorStop(0.35, css(col, a * 0.35)); gr.addColorStop(1, css(col, 0)); g.save(); g.globalCompositeOperation = 'lighter'; g.fillStyle = gr; g.fillRect(p[0] - rr, p[1] - rr, rr * 2, rr * 2); g.restore(); }

    // ----- extent and height field -----
    let X0, Y0, X1, Y1; const E = o.extent;
    if (E) { X0 = E[0]; Y0 = E[1]; X1 = E[2]; Y1 = E[3]; }
    else { // every tile that can reach the canvas
      const inv = (sx, sy) => { const a = (sx - ox) / (tw / 2), b = (sy - oy) / (tw / 4); return [(a + b) / 2, (b - a) / 2]; };
      const c = [inv(0, 0), inv(W, 0), inv(0, H + 16 * zs), inv(W, H + 16 * zs)]; X0 = Math.floor(Math.min(...c.map(p => p[0]))) - 1; X1 = Math.ceil(Math.max(...c.map(p => p[0]))) + 1; Y0 = Math.floor(Math.min(...c.map(p => p[1]))) - 1; Y1 = Math.ceil(Math.max(...c.map(p => p[1]))) + 1; }
    const nx = X1 - X0, ny = Y1 - Y0, G = new Array((nx + 1) * (ny + 1));
    for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) G[j * (nx + 1) + i] = groundFull(X0 + i, Y0 + j);
    const V = (x, y) => G[(y - Y0) * (nx + 1) + (x - X0)];
    function hAt(x, y) { const xi = clamp(Math.floor(x), X0, X1 - 1), yi = clamp(Math.floor(y), Y0, Y1 - 1), u = x - xi, v = y - yi; const a = V(xi, yi).h, b = V(xi + 1, yi).h, c = V(xi, yi + 1).h, d = V(xi + 1, yi + 1).h; return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v; }
    const inExt = (x, y) => x >= X0 + 0.15 && x <= X1 - 0.15 && y >= Y0 + 0.15 && y <= Y1 - 0.15;

    // ----- things, keyed by the diagonal they stand on -----
    const things = new Map(); const put = (x, y, fn) => { const k = Math.floor(x) + Math.floor(y); (things.get(k) || things.set(k, []).get(k)).push([x + y, fn]); };
    const fields = [[30, 12.5, 34.5, 16, 'wheat'], [25.5, 11.5, 29.5, 15, 'till'], [21.5, 31.5, 26, 35, 'wheat'], [36, 29, 40, 33, 'till']];
    const fieldAt = (x, y) => { for (const F of fields) if (x > F[0] && x < F[2] && y > F[1] && y < F[3]) return F[4]; return null; };
    const forest = (x, y) => vnoise(x * 0.15 + 4, y * 0.15 + 9, 5) * 0.75 + vnoise(x * 0.45, y * 0.45, 15) * 0.25;

    function tri(a, b, c, cx, cy) { const n = nrm(a.p, b.p, c.p); if (n[2] < 0) { n[0] = -n[0]; n[1] = -n[1]; n[2] = -n[2]; }
      const h = (a.p[2] + b.p[2] + c.p[2]) / 3, q = a.g, jit = hash2(Math.floor(cx * 3), Math.floor(cy * 3), 77); let col;
      const wet = (a.g.water ? 1 : 0) + (b.g.water ? 1 : 0) + (c.g.water ? 1 : 0);
      if (wet === 3) { col = mix(pal.water, pal.waterHi, 0.15 + 0.5 * vnoise(cx * 0.6, cy * 0.6, 8)); poly([a.p, b.p, c.p], col); return; }
      const dr = (a.g.dr + b.g.dr + c.g.dr) / 3, dc = (a.g.dc + b.g.dc + c.g.dc) / 3, dp = (a.g.dp + b.g.dp + c.g.dp) / 3, dm = (a.g.dm + b.g.dm + c.g.dm) / 3;
      const fo = forest(cx, cy), fld = fieldAt(cx, cy);
      if (wet) col = pal.bank;
      else if (dp < 0.62 && dr > 2) col = pal.ballast;
      else if (dm < 2.7) col = mix(pal.tailings, pal.earth, 0.25 + jit * 0.5);
      else if (dc < 6.9) col = mix(pal.town, pal.earth, jit * 0.25);
      else if (n[2] < 0.79 + sstep(4, 7, h) * 0.12 || h > 7.2) col = h > 10.2 && n[2] > 0.6 ? pal.snow : mix(pal.rockLo, pal.rockHi, clamp((h - 2) / 8, 0, 1) * 0.8 + jit * 0.2);
      else if (dr < 2.1) col = pal.bank;
      else if (dp < 1.1) col = mix(pal.earth, pal.meadow[0], 0.6 + jit * 0.2);
      else if (fld) col = fld === 'wheat' ? mix(pal.wheat, pal.meadow[1], jit * 0.18) : mix(pal.earth, pal.tailings, 0.2 + ((Math.floor(cx * 2) % 2) ? 0.18 : 0));
      else if (fo > 0.5 && h > 0.5 && dc > 10.5) col = mix(pal.forestFloor, pal.meadow[0], jit * 0.25);
      else col = mix(mix(pal.meadow[0], pal.meadow[1], sstep(0.3, 0.7, vnoise(cx * 0.16, cy * 0.16, 31)) * 0.8 + jit * 0.2), pal.rockLo, clamp((h - 3.5) / 6, 0, 0.45));
      poly([a.p, b.p, c.p], lit(col, n)); }

    // trees
    function conifer(x, y, z, s, tone) { const b = P(x, y, z), k = s * tw; const dark = lit(pal.tree[tone], [0.9, -0.2, 0.3]), lite = lit(pal.tree[tone], [0, 0.9, 0.6]);
      g.fillStyle = css(pal.trunk); g.fillRect(b[0] - k * 0.035, b[1] - k * 0.2, k * 0.07, k * 0.22);
      for (let i = 0; i < 3; i++) { const w = k * (0.3 - i * 0.07), y0 = b[1] - k * (0.14 + i * 0.26), y1 = y0 - k * (0.42 - i * 0.03);
        g.beginPath(); g.moveTo(b[0], y1); g.lineTo(b[0] - w, y0); g.quadraticCurveTo(b[0] - w * 0.4, y0 + w * 0.3, b[0], y0 + w * 0.22); g.closePath(); g.fillStyle = css(lite); g.fill();
        g.beginPath(); g.moveTo(b[0], y1); g.lineTo(b[0] + w, y0); g.quadraticCurveTo(b[0] + w * 0.4, y0 + w * 0.3, b[0], y0 + w * 0.22); g.closePath(); g.fillStyle = css(dark); g.fill(); } }
    function broadleaf(x, y, z, s, col) { const b = P(x, y, z), k = s * tw * 0.8, dk = lit(col, [0.9, -0.2, 0.3]), lt = lit(col, [0, 0.9, 0.6]); g.fillStyle = css(pal.trunk); g.fillRect(b[0] - k * 0.03, b[1] - k * 0.26, k * 0.06, k * 0.28);
      const bl = (dx, dy, r, c) => { g.beginPath(); g.ellipse(b[0] + dx * k, b[1] + dy * k, r * k, r * k * 0.86, 0, 0, 7); g.fillStyle = css(c); g.fill(); };
      bl(0.1, -0.4, 0.2, dk); bl(-0.1, -0.38, 0.2, dk); bl(0.02, -0.56, 0.2, dk); bl(-0.13, -0.43, 0.15, lt); bl(-0.03, -0.6, 0.15, lt); }
    const tsz = o.treeScale || 1;
    for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) { const q = V(x, y); if (q.water || q.dp < 1.5 || q.dm < 3.7 || fieldAt(x + 0.5, y + 0.5) || (x < 6 && y < 6)) continue;
      if (q.dc < 11.5 || q.dr < 3.1) { if (q.dc > 8.2 && q.dr > 2.2 && hash2(x, y, 3) < (q.dr < 3.1 ? 0.2 : 0.1)) { const tx = x + 0.2 + hash2(x, y, 5) * 0.6, ty = y + 0.2 + hash2(x, y, 6) * 0.6; put(tx, ty, () => broadleaf(tx, ty, hAt(tx, ty), (1.3 + hash2(x, y, 9) * 0.5) * tsz, pal.leaf)); } continue; }
      const fo = forest(x + 0.5, y + 0.5), slope = Math.abs(V(x + 1, y).h - q.h) + Math.abs(V(x, y + 1).h - q.h);
      if (q.h > 6.6 || slope > 1.5) continue; const dens = fo > 0.56 ? 0.62 : fo > 0.5 ? 0.3 : 0.02;
      if (hash2(x, y, 1) < dens) { const tx = x + 0.2 + hash2(x, y, 5) * 0.6, ty = y + 0.2 + hash2(x, y, 6) * 0.6, s = (1.45 + hash2(x, y, 8) * 0.8) * tsz, r = hash2(x, y, 12);
        const tone = r < 0.045 && pal.tree[3] ? 3 : r < 0.4 ? 0 : r < 0.75 ? 1 : 2; put(tx, ty, () => conifer(tx, ty, hAt(tx, ty), s, tone)); } }

    // buildings: gable-roofed box. (x,y) back corner, w along x, d along y
    function gable(x, y, z, w, d, h, rh, axis, wall, roof, op) { op = op || {}; const e = 0.09, x1 = x + w, y1 = y + d, zt = z + h;
      poly([[x, y1, z], [x1, y1, z], [x1, y1, zt], [x, y1, zt]], lit(wall, [0, 1, 0])); poly([[x1, y, z], [x1, y1, z], [x1, y1, zt], [x1, y, zt]], lit(wall, [1, 0, 0]));
      const win = pal.window, wn = op.win === undefined ? Math.max(1, Math.round(w * 1.6)) : op.win;
      const wq = (pts, on) => poly(pts, on ? win : mix(wall, pal.shade, 0.55), 1, false);
      for (let i = 0; i < wn; i++) { const u = x + (i + 0.5) * w / wn, on = dusk ? hash2(i, Math.floor(x * 7 + y * 3), 5) < 0.75 : false; wq([[u - 0.09, y1, z + h * 0.42], [u + 0.09, y1, z + h * 0.42], [u + 0.09, y1, z + h * 0.78], [u - 0.09, y1, z + h * 0.78]], on); if (on) put(x + w, y + d + 0.01, () => glow(u, y1, z + h * 0.6, 0.55, pal.window, 0.5)); }
      const dn = Math.max(1, Math.round(d * 1.6)); for (let i = 0; i < dn; i++) { const v = y + (i + 0.5) * d / dn, on = dusk ? hash2(i, Math.floor(x * 5 + y * 9), 6) < 0.6 : false; wq([[x1, v - 0.09, z + h * 0.42], [x1, v + 0.09, z + h * 0.42], [x1, v + 0.09, z + h * 0.78], [x1, v - 0.09, z + h * 0.78]], on); }
      if (axis === 'x') { const ym = y + d / 2, zr = zt + rh; poly([[x1, y, zt], [x1, y1, zt], [x1, ym, zr]], lit(wall, [1, 0, 0]));
        poly([[x - e, y - e, zt - e * 0.5], [x1 + e, y - e, zt - e * 0.5], [x1 + e, ym, zr], [x - e, ym, zr]], lit(roof, [0, -rh, d / 2]));
        poly([[x - e, y1 + e, zt - e * 0.6], [x1 + e, y1 + e, zt - e * 0.6], [x1 + e, ym, zr], [x - e, ym, zr]], lit(roof, [0, rh, d / 2])); }
      else { const xm = x + w / 2, zr = zt + rh; poly([[x, y1, zt], [x1, y1, zt], [xm, y1, zr]], lit(wall, [0, 1, 0]));
        poly([[x - e, y - e, zt - e * 0.5], [x - e, y1 + e, zt - e * 0.5], [xm, y1 + e, zr], [xm, y - e, zr]], lit(roof, [-rh, 0, w / 2]));
        poly([[x1 + e, y - e, zt - e * 0.6], [x1 + e, y1 + e, zt - e * 0.6], [xm, y1 + e, zr], [xm, y - e, zr]], lit(roof, [rh, 0, w / 2])); } }
    function box(x, y, z, w, d, h, col, top) { poly([[x, y + d, z], [x + w, y + d, z], [x + w, y + d, z + h], [x, y + d, z + h]], lit(col, [0, 1, 0])); poly([[x + w, y, z], [x + w, y + d, z], [x + w, y + d, z + h], [x + w, y, z + h]], lit(col, [1, 0, 0]));
      poly([[x, y, z + h], [x + w, y, z + h], [x + w, y + d, z + h], [x, y + d, z + h]], lit(top || col, [0, 0, 1])); }
    const smokes = [];
    function B(x, y, w, d, h, rh, axis, wall, roof, op) { if (!inExt(x, y) || !inExt(x + w, y + d)) return; put(x + w - 0.01, y + d - 0.01, () => gable(x, y, hAt(x + w / 2, y + d / 2), w, d, h, rh, axis, wall, roof, op)); }

    // --- the city terminal ---
    const Wc = pal.wall, Rf = pal.roof;
    const cx0 = ANCH[0], cy0 = ANCH[1], C = (dx, dy, w, d, h, rh, axis, wall, roof, op) => B(cx0 + dx, cy0 + dy, w, d, h, rh, axis, wall, roof, op);
    C(-2.4, -2.75, 4.6, 1.25, 0.62, 0.42, 'x', Wc[0], Rf[0], { win: 7 });                       // the depot
    if (inExt(cx0, cy0 - 2)) put(cx0 + 0.9, cy0 - 1.46, () => { const x = cx0 - 0.3, y = cy0 - 2.9, z = hAt(cx0, cy0 - 2); box(x, y, z, 0.8, 0.8, 1.55, Wc[0]); poly([[x - 0.08, y + 0.88, z + 1.55], [x + 0.88, y + 0.88, z + 1.55], [x + 0.4, y + 0.4, z + 2.35]], lit(Rf[0], [0, 1, 0.8])); poly([[x + 0.88, y - 0.08, z + 1.55], [x + 0.88, y + 0.88, z + 1.55], [x + 0.4, y + 0.4, z + 2.35]], lit(Rf[0], [1, 0, 0.8]));
      const c = P(x + 0.4, y + 0.81, z + 1.2); g.beginPath(); g.ellipse(c[0], c[1], tw * 0.13, tw * 0.15, -0.46, 0, 7); g.fillStyle = css(dusk ? pal.window : pal.snow); g.fill(); glow(x + 0.4, y + 0.85, z + 1.2, 0.7, pal.window, 0.6); });
    if (inExt(cx0, cy0 - 1)) put(cx0 + 2.6, cy0 - 0.9, () => box(cx0 - 2.7, cy0 - 1.32, hAt(cx0, cy0 - 1), 5.2, 0.5, 0.1, pal.timber, mix(pal.timber, pal.town, 0.5)));   // platform
    C(3.3, -2.9, 2.6, 1.5, 0.85, 0.5, 'x', Wc[2], Rf[1], { win: 3 });                         // freight house
    C(-6.9, -4.6, 2.0, 1.5, 0.8, 0.55, 'x', pal.timber, Rf[2], { win: 2 });                    // engine shed
    C(-4.6, 1.5, 2.0, 1.7, 1.05, 0.3, 'y', pal.stone, Rf[1], { win: 3 });                      // the bank
    C(-1.7, 1.5, 1.5, 1.3, 0.8, 0.5, 'y', Wc[2], Rf[0]); C(0.4, 1.5, 1.7, 1.3, 0.95, 0.45, 'x', Wc[1], Rf[1]); C(2.8, 1.6, 1.3, 1.3, 0.7, 0.5, 'y', Wc[0], Rf[2]);
    C(-3.8, 4.2, 1.3, 1.2, 0.6, 0.48, 'x', Wc[1], Rf[0]); C(-1.8, 4.0, 1.6, 1.4, 0.75, 0.5, 'y', Wc[0], Rf[1]); C(0.6, 4.2, 1.3, 1.2, 0.6, 0.48, 'x', Wc[2], Rf[2]); C(2.6, 4.3, 1.2, 1.2, 0.6, 0.45, 'y', Wc[1], Rf[0]);
    C(-0.9, 6.3, 1.2, 1.1, 0.55, 0.45, 'y', Wc[0], Rf[2]); C(1.2, 6.2, 1.3, 1.1, 0.55, 0.45, 'x', Wc[1], Rf[1]);
    C(-3.6, -5.3, 1.2, 1.1, 0.55, 0.45, 'x', Wc[1], Rf[1]); C(-1.4, -5.6, 1.3, 1.2, 0.6, 0.48, 'y', Wc[0], Rf[0]); C(1.0, -5.4, 1.2, 1.1, 0.55, 0.45, 'x', Wc[2], Rf[2]); C(3.6, -5.2, 1.2, 1.2, 0.6, 0.45, 'y', Wc[0], Rf[1]);
    if (inExt(cx0 + 5, cy0 + 2)) { put(cx0 + 5.6, cy0 + 2.5, () => { const z = hAt(cx0 + 5, cy0 + 1.9); box(cx0 + 4.4, cy0 + 1.3, z, 1.3, 1.2, 0.8, pal.brick, Rf[1]); }); put(cx0 + 5.9, cy0 + 1.3, () => { const z = hAt(cx0 + 5.8, cy0 + 1.2); cyl(cx0 + 5.85, cy0 + 1.05, z, 0.2, 2.6, pal.brick, pal.iron); }); smokes.push([cx0 + 5.85, cy0 + 1.05, 3.1, 1.0]); }
    if (inExt(cx0 - 3.6, cy0 - 1.2)) put(cx0 - 3.2, cy0 - 0.8, () => { const X = cx0 - 3.7, Y = cy0 - 1.3, z = hAt(X, Y); for (const [a, b] of [[-0.28, -0.28], [0.28, -0.28], [-0.28, 0.28], [0.28, 0.28]]) line([X + a, Y + b, z], [X + a * 0.8, Y + b * 0.8, z + 0.75], pal.timber, Math.max(1, tw * 0.05)); cyl(X, Y, z + 0.72, 0.42, 0.62, pal.timber, mix(pal.timber, pal.shade, 0.3));
      const t = P(X, Y, z + 1.34); g.beginPath(); g.moveTo(t[0] - 0.33 * tw, t[1]); g.lineTo(t[0], t[1] - 0.3 * tw); g.lineTo(t[0] + 0.33 * tw, t[1]); g.ellipse(t[0], t[1], 0.33 * tw, 0.165 * tw, 0, 0, Math.PI); g.fillStyle = css(lit(Rf[1], [0.3, 0.5, 0.8])); g.fill(); });
    // --- the mine camp ---
    const mz = R[R.length - 1].z - 0.06;
    if (inExt(MINE[0], MINE[1])) {
      for (let i = 0; i < 3; i++) { const bx = MINE[0] - 1.5 + i * 0.95, by = MINE[1] - 2.3 + i * 0.2; put(bx + 1.2, by + 1.5 + i * 0.01, () => { const z = Math.max(hAt(bx + 0.6, by + 1.4), mz - 0.2) + 0.0; const hh = 1.9 - i * 0.5;
        poly([[bx, by + 1.5, z], [bx + 1.2, by + 1.5, z], [bx + 1.2, by + 1.5, z + hh], [bx, by + 1.5, z + hh + 0.5]], lit(pal.timber, [0, 1, 0])); poly([[bx + 1.2, by, z], [bx + 1.2, by + 1.5, z], [bx + 1.2, by + 1.5, z + hh], [bx + 1.2, by, z + hh]], lit(pal.timber, [1, 0, 0]));
        poly([[bx - 0.08, by - 0.08, z + hh + 0.55], [bx + 1.3, by - 0.08, z + hh], [bx + 1.3, by + 1.6, z + hh], [bx - 0.08, by + 1.6, z + hh + 0.55]], lit(Rf[2], [0.42, 0, 0.9]));
        const on = dusk; poly([[bx + 0.3, by + 1.5, z + hh * 0.45], [bx + 0.52, by + 1.5, z + hh * 0.45], [bx + 0.52, by + 1.5, z + hh * 0.7], [bx + 0.3, by + 1.5, z + hh * 0.7]], on ? pal.window : mix(pal.timber, pal.shade, 0.6), 1, false); if (on) glow(bx + 0.4, by + 1.5, z + hh * 0.6, 0.6, pal.window, 0.5); }); }
      smokes.push([MINE[0] - 1.2, MINE[1] - 1.7, mz + 2.6, 0.8]);
      put(MINE[0] - 2.4, MINE[1] + 0.9, () => { const x = MINE[0] - 2.9, y = MINE[1] + 0.4, z = hAt(x, y), w = Math.max(1.1, tw * 0.055); // headframe
        line([x - 0.35, y + 0.35, z], [x - 0.12, y + 0.12, z + 2.1], pal.timber, w); line([x + 0.35, y + 0.35, z], [x + 0.12, y + 0.12, z + 2.1], pal.timber, w); line([x - 0.35, y - 0.35, z], [x - 0.12, y - 0.12, z + 2.1], pal.timber, w); line([x + 0.35, y - 0.35, z], [x + 0.12, y - 0.12, z + 2.1], pal.timber, w);
        line([x - 0.27, y + 0.27, z + 0.7], [x + 0.27, y + 0.27, z + 0.7], pal.timber, w * 0.8); line([x - 0.2, y + 0.2, z + 1.4], [x + 0.2, y + 0.2, z + 1.4], pal.timber, w * 0.8); line([x - 0.27, y + 0.27, z + 0.7], [x + 0.2, y + 0.2, z + 1.4], pal.timber, w * 0.6);
        line([x + 1.6, y + 0.1, z], [x + 0.1, y + 0.1, z + 2.1], pal.timber, w); box(x - 0.2, y - 0.2, z + 2.05, 0.4, 0.4, 0.12, pal.iron);
        const c = P(x, y + 0.2, z + 2.3); g.beginPath(); g.ellipse(c[0], c[1], tw * 0.17, tw * 0.2, -0.46, 0, 7); g.strokeStyle = css(pal.iron); g.lineWidth = w * 1.2; g.stroke(); });
      B(MINE[0] + 1.3, MINE[1] + 0.9, 1.1, 0.9, 0.5, 0.4, 'x', pal.timber, Rf[0], { win: 1 }); B(MINE[0] + 1.9, MINE[1] - 1.3, 1.0, 0.9, 0.48, 0.38, 'y', Wc[0], Rf[2], { win: 1 });
      put(MINE[0] - 0.4, MINE[1] + 2.3, () => { const fx = MINE[0] - 0.7, fy = MINE[1] + 2.0, z = hAt(fx, fy), p = P(fx, fy, z); g.strokeStyle = css(pal.timber); g.lineWidth = Math.max(1, tw * 0.04); g.beginPath(); g.moveTo(p[0], p[1]); g.lineTo(p[0], p[1] - tw * 0.7); g.stroke();
        g.beginPath(); g.moveTo(p[0], p[1] - tw * 0.7); g.lineTo(p[0] + tw * 0.34, p[1] - tw * 0.6); g.lineTo(p[0], p[1] - tw * 0.46); g.closePath(); g.fillStyle = css(pal.gold); g.fill(); glow(fx, fy, z + 0.3, 0.9, pal.gold, 0.35); });
    }
    if (o.props !== false) { // a few cabins and a sawmill out in the country
      B(15.4, 22.2, 1.1, 0.9, 0.48, 0.4, 'x', pal.timber, Rf[0], { win: 1 }); B(27.2, 12.2, 1.2, 1.0, 0.5, 0.42, 'y', Wc[0], Rf[2], { win: 1 }); B(23.2, 30.2, 1.0, 0.9, 0.46, 0.4, 'x', pal.timber, Rf[1], { win: 1 }); }

    // --- track, trestle ---
    const tieW = Math.max(0.8, tw * 0.035), railW = Math.max(0.7, tw * 0.028);
    for (let i = 0; i < R.length - 1; i++) { const a = R[i], b = R[i + 1]; if (!inExt(a.x, a.y) || !inExt(b.x, b.y)) continue; const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1, nxv = -dy / l * 0.2, nyv = dx / l * 0.2;
      if (o.railTo !== undefined && a.s > o.railTo * R.len) continue; const bridge = a.river < 2.7; const key = Math.max(Math.floor(a.x + nxv) + Math.floor(a.y + nyv), Math.floor(a.x - nxv) + Math.floor(a.y - nyv), Math.floor(b.x + nxv) + Math.floor(b.y + nyv), Math.floor(b.x - nxv) + Math.floor(b.y - nyv));
      const fn = () => { const za = a.z + 0.02, zb = b.z + 0.02;
        if (bridge) { const gz = Math.max(0, hAt(a.x, a.y)); if (i % 3 === 0) { for (const sgn of [-1, 1]) line([a.x + nxv * sgn * 1.1, a.y + nyv * sgn * 1.1, gz], [a.x + nxv * sgn * 0.8, a.y + nyv * sgn * 0.8, za], pal.timber, Math.max(1, tw * 0.05));
            line([a.x - nxv * 1.1, a.y - nyv * 1.1, gz + (za - gz) * 0.1], [a.x + nxv, a.y + nyv, gz + (za - gz) * 0.8], pal.timber, Math.max(0.7, tw * 0.03)); }
          poly([[a.x + nxv * 1.15, a.y + nyv * 1.15, za - 0.1], [b.x + nxv * 1.15, b.y + nyv * 1.15, zb - 0.1], [b.x + nxv * 1.15, b.y + nyv * 1.15, zb], [a.x + nxv * 1.15, a.y + nyv * 1.15, za]], lit(pal.timber, [0, 1, 0]));
          poly([[a.x + nxv * 1.15, a.y + nyv * 1.15, za], [b.x + nxv * 1.15, b.y + nyv * 1.15, zb], [b.x - nxv * 1.15, b.y - nyv * 1.15, zb], [a.x - nxv * 1.15, a.y - nyv * 1.15, za]], lit(mix(pal.timber, pal.town, 0.25), [0, 0, 1])); }
        else poly([[a.x + nxv * 1.3, a.y + nyv * 1.3, za - 0.02], [b.x + nxv * 1.3, b.y + nyv * 1.3, zb - 0.02], [b.x - nxv * 1.3, b.y - nyv * 1.3, zb - 0.02], [a.x - nxv * 1.3, a.y - nyv * 1.3, za - 0.02]], lit(pal.ballast, [0, 0, 1]));
        line([a.x + nxv, a.y + nyv, za], [a.x - nxv, a.y - nyv, za], pal.tie, tieW); const mxv = (a.x + b.x) / 2, myv = (a.y + b.y) / 2, mzv = (za + zb) / 2; line([mxv + nxv, myv + nyv, mzv], [mxv - nxv, myv - nyv, mzv], pal.tie, tieW);
        for (const sgn of [-0.62, 0.62]) line([a.x + nxv * sgn, a.y + nyv * sgn, za + 0.02], [b.x + nxv * sgn, b.y + nyv * sgn, zb + 0.02], pal.rail, railW); };
      (things.get(key) || things.set(key, []).get(key)).push([a.x + a.y - 0.5, fn]); }

    // --- the train ---
    function wheels(T, u, r, v, col) { for (const u0 of u) { g.beginPath(); for (let k = 0; k <= 16; k++) { const t = k / 16 * Math.PI * 2, p3 = T(u0 + Math.cos(t) * r, v, r + Math.sin(t) * r + 0.02), p = P(p3[0], p3[1], p3[2]); if (k) g.lineTo(p[0], p[1]); else g.moveTo(p[0], p[1]); } g.fillStyle = css(col); g.fill();
        g.beginPath(); for (let k = 0; k <= 12; k++) { const t = k / 12 * Math.PI * 2, p3 = T(u0 + Math.cos(t) * r * 0.45, v, r + Math.sin(t) * r * 0.45 + 0.02), p = P(p3[0], p3[1], p3[2]); if (k) g.lineTo(p[0], p[1]); else g.moveTo(p[0], p[1]); } g.fillStyle = css(pal.wheelHub); g.fill(); } }
    function car(s, kind, dir) { const q = railAt(s); if (!inExt(q.x, q.y)) return; let ang = Math.atan2(q.dy, q.dx); if (dir < 0) ang += Math.PI; const ts = o.trainScale || 1.3, T0 = frame(q.x, q.y, ang), z = q.z + 0.04, T = (u, v, w) => { const p = T0(u * ts, v * ts, 0); return [p[0], p[1], z + w * ts]; };
      const vis = ((-Math.sin(ang)) + Math.cos(ang)) > 0 ? 1 : -1;   // which side faces the camera
      put(q.x + 0.35, q.y + 0.35, () => {
        const body = (u0, u1, v, w0, w1, col, op) => obox(T, u0, u1, -v, v, w0, w1, col, op);
        if (kind === 'loco') { const oct = (r, cz) => { const a = []; for (let k = 0; k < 10; k++) { const t = k / 10 * Math.PI * 2 + Math.PI / 10; a.push([Math.cos(t) * r, cz + Math.sin(t) * r]); } return a; };
          wheels(T, [-0.52, -0.2, 0.12], 0.15, -vis * 0.2, pal.iron); wheels(T, [0.52, 0.72], 0.085, -vis * 0.2, pal.iron);
          body(-0.75, 0.82, 0.17, 0.13, 0.24, pal.iron);                                  // frame
          const front = Math.cos(ang) + Math.sin(ang) > 0;                               // drawing order along the engine
          const parts = [
            () => { body(-0.95, -0.38, 0.24, 0.24, 0.72, pal.loco); poly([T(-0.62, vis * 0.245, 0.48), T(-0.46, vis * 0.245, 0.48), T(-0.46, vis * 0.245, 0.64), T(-0.62, vis * 0.245, 0.64)].map(p => p), dusk ? pal.window : pal.cabWin, 1, false); body(-1.02, -0.32, 0.28, 0.72, 0.77, pal.locoRoof); },   // cab
            () => { prism(T, -0.4, 0.62, oct(0.185, 0.45), pal.boiler); for (const u of [-0.12, 0.2, 0.5]) prism(T, u, u + 0.03, oct(0.19, 0.45), mix(pal.brass, pal.boiler, dusk ? 0.6 : 0.15)); body(-0.05, 0.1, 0.07, 0.6, 0.74, pal.brass); body(0.26, 0.36, 0.05, 0.6, 0.7, pal.boiler); },
            () => { prism(T, 0.62, 0.74, oct(0.2, 0.45), pal.iron); body(0.4, 0.7, 0.21, 0.2, 0.36, pal.loco);
              const st = T(0.5, 0, 0.62); cyl(st[0], st[1], st[2], 0.062, 0.2, pal.iron); const tp = P(st[0], st[1], st[2] + 0.2), rx = 0.7071 * 0.12 * tw; g.beginPath(); g.moveTo(tp[0] - rx * 0.55, tp[1]); g.lineTo(tp[0] - rx, tp[1] - 0.2 * zs); g.lineTo(tp[0] + rx, tp[1] - 0.2 * zs); g.lineTo(tp[0] + rx * 0.55, tp[1]); g.closePath(); g.fillStyle = css(lit(pal.iron, [0.3, 0.6, 0.5])); g.fill(); g.beginPath(); g.ellipse(tp[0], tp[1] - 0.2 * zs, rx, rx / 2, 0, 0, 7); g.fillStyle = css(mix(pal.iron, [0, 0, 0], 0.4)); g.fill(); },
            () => { solid([[T(0.82, -0.2, 0.06), T(0.82, 0.2, 0.06), T(1.08, 0, 0.06)], [T(0.82, -0.2, 0.06), T(0.82, -0.2, 0.3), T(1.08, 0, 0.06)], [T(0.82, 0.2, 0.06), T(0.82, 0.2, 0.3), T(1.08, 0, 0.06)], [T(0.82, -0.2, 0.3), T(0.82, 0.2, 0.3), T(1.08, 0, 0.06)], [T(0.82, -0.2, 0.06), T(0.82, 0.2, 0.06), T(0.82, 0.2, 0.3), T(0.82, -0.2, 0.3)]], pal.cow, T(0.9, 0, 0.14));
              const hl = T(0.76, 0, 0.7); body(0.7, 0.8, 0.055, 0.64, 0.76, pal.brass); glow(hl[0], hl[1], hl[2], dusk ? 1.0 : 0.5, pal.lamp, dusk ? 0.85 : 0.5); }];
          if (!front) parts.reverse(); parts.forEach(fn => fn());
          const stp = T(0.5, 0, 0.9); smokes.push([stp[0], stp[1], stp[2], 1.5, -Math.cos(ang), -Math.sin(ang)]); const cy1 = T(0.6, vis * 0.26, 0.2); smokes.push([cy1[0], cy1[1], cy1[2], 0.35, 0, 0, 'steam']);
          if (dusk) { const a0 = T(0.85, 0, 0.6), b1 = T(4.6, -0.9, 0.1), b2 = T(4.6, 0.9, 0.1), pa = P(a0[0], a0[1], a0[2]), p1 = P(b1[0], b1[1], b1[2]), p2 = P(b2[0], b2[1], b2[2]); const gr = g.createLinearGradient(pa[0], pa[1], (p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2); gr.addColorStop(0, css(pal.lamp, 0.55)); gr.addColorStop(1, css(pal.lamp, 0));
            g.save(); g.globalCompositeOperation = 'lighter'; g.beginPath(); g.moveTo(pa[0], pa[1]); g.lineTo(p1[0], p1[1]); g.lineTo(p2[0], p2[1]); g.closePath(); g.fillStyle = gr; g.fill(); g.restore(); } }
        else if (kind === 'tender') { wheels(T, [-0.3, 0.3], 0.1, -vis * 0.2, pal.iron); body(-0.5, 0.5, 0.17, 0.13, 0.22, pal.iron); body(-0.5, 0.5, 0.23, 0.22, 0.56, pal.loco); body(-0.42, 0.3, 0.17, 0.56, 0.62, pal.coal); }
        else if (kind === 'ore') { wheels(T, [-0.3, 0.3], 0.1, -vis * 0.19, pal.iron); body(-0.5, 0.5, 0.16, 0.13, 0.22, pal.iron); body(-0.47, 0.47, 0.22, 0.22, 0.5, pal.oreCar); body(-0.4, 0.4, 0.16, 0.5, 0.57, pal.ore);
          prism(T, -0.3, 0.3, [[-0.14, 0.57], [0.14, 0.57], [0, 0.66]], pal.ore); }
        else { wheels(T, [-0.32, 0.32], 0.1, -vis * 0.2, pal.iron); body(-0.55, 0.55, 0.17, 0.13, 0.22, pal.iron); body(-0.53, 0.53, 0.23, 0.22, 0.6, pal.caboose);
          for (const u of [-0.3, 0.05]) poly([T(u, vis * 0.235, 0.36), T(u + 0.14, vis * 0.235, 0.36), T(u + 0.14, vis * 0.235, 0.5), T(u, vis * 0.235, 0.5)], dusk ? pal.window : pal.cabWin, 1, false);
          body(-0.58, 0.58, 0.26, 0.6, 0.64, pal.locoRoof); body(-0.16, 0.16, 0.15, 0.64, 0.76, pal.caboose); body(-0.2, 0.2, 0.18, 0.76, 0.79, pal.locoRoof); } }); }
    if (o.train) { const t = o.train, dir = t.dir || 1; let s = t.s * R.len; const order = ['loco', 'tender'].concat(new Array(t.cars === undefined ? 4 : t.cars).fill('ore'), ['caboose']); const gap = { loco: 1.75, tender: 1.1, ore: 1.08, caboose: 1.2 };
      const ts = o.trainScale || 1.3; for (let i = 0; i < order.length; i++) { car(s, order[i], dir); if (i < order.length - 1) s -= dir * (gap[order[i]] + gap[order[i + 1]]) / 2 * ts; } }

    // ----- draw: shadow, far-to-near tiles with their things, cut faces -----
    const D = o.depth || 0; if (o.before) o.before(g, P, W, H);
    if (E && o.shadow) { g.save(); g.filter = `blur(${o.shadow.blur || 14}px)`; const sh = o.shadow, k = sh.offset || 1.2; g.beginPath(); [[X0, Y1], [X1, Y1], [X1, Y0], [X0 + k, Y0 - k * 0 + 0], [X0, Y0]].forEach((p, i) => { const q = P(p[0] + k, p[1] + k, -D); if (i) g.lineTo(q[0], q[1]); else g.moveTo(q[0], q[1]); }); g.closePath(); g.fillStyle = sh.color; g.fill(); g.restore(); }
    for (let d = X0 + Y0; d <= X1 + Y1 - 2; d++) {
      for (let x = Math.max(X0, d - (Y1 - 1)); x <= Math.min(X1 - 1, d - Y0); x++) { const y = d - x;
        const a = { p: [x, y, V(x, y).h], g: V(x, y) }, b = { p: [x + 1, y, V(x + 1, y).h], g: V(x + 1, y) }, c = { p: [x + 1, y + 1, V(x + 1, y + 1).h], g: V(x + 1, y + 1) }, e = { p: [x, y + 1, V(x, y + 1).h], g: V(x, y + 1) };
        if (!E) { const q = P(x, y, 0); if (q[0] < -tw * 2 || q[0] > W + tw * 2 || q[1] > H + 16 * zs || q[1] < -tw) continue; }
        if ((x + y) & 1) { tri(a, b, c, x + 0.67, y + 0.33); tri(a, c, e, x + 0.33, y + 0.67); } else { tri(a, b, e, x + 0.33, y + 0.33); tri(b, c, e, x + 0.67, y + 0.67); } }
      const th = things.get(d); if (th) { th.sort((p, q) => p[0] - q[0]); for (const t of th) t[1](); }
    }
    if (E && D) { // the cut faces of the block
      const face = (pts, side) => { const top = pts.map(p => [p[0], p[1], V(p[0], p[1]).h]), base = side === 'L' ? pal.cutL : pal.cutR;
        const path = (zOf, zLow) => { g.beginPath(); top.forEach((p, i) => { const q = P(p[0], p[1], zOf(p, i)); if (i) g.lineTo(q[0], q[1]); else g.moveTo(q[0], q[1]); }); for (let i = top.length - 1; i >= 0; i--) { const q = P(top[i][0], top[i][1], zLow(top[i], i)); g.lineTo(q[0], q[1]); } g.closePath(); };
        const wave = (p, k) => 0.22 * Math.sin((p[0] + p[1]) * 0.33 + k * 1.7) + 0.12 * Math.sin((p[0] - p[1]) * 0.9 + k);
        path(p => p[2], () => -D); g.fillStyle = css(base[0]); g.fill();
        const bands = o.strata || [0.5, 1.3]; let prev = null;
        bands.forEach((dz, k) => { const zTop = (p) => k === 0 ? Math.min(p[2] - 0.28, -0.12) : -bands[k - 1] + wave(p, k), zLow = (p) => k === bands.length - 1 ? -D : -dz + wave(p, k + 1); path(zTop, zLow); g.fillStyle = css(base[(k + 1) % base.length]); g.fill(); });
      };
      const Lp = [], Rp = []; for (let x = X0; x <= X1; x++) Lp.push([x, Y1]); for (let y = Y0; y <= Y1; y++) Rp.push([X1, y]); face(Lp, 'L'); face(Rp, 'R');
      if (o.underground) underground();
      const c0 = P(X1, Y1, V(X1, Y1).h), c1 = P(X1, Y1, -D); g.beginPath(); g.moveTo(c0[0], c0[1]); g.lineTo(c1[0], c1[1]); g.strokeStyle = css(pal.shade, 0.25); g.lineWidth = 1; g.stroke();
    }
    function underground() { // galleries, a shaft and a gold seam on the cut faces
      const u = o.underground, gold = pal.gold, dark = pal.tunnel;
      const Lpt = (x, z) => P(x, Y1, z), Rpt = (y, z) => P(X1, y, z);
      const seam = (pt, a, b, ph) => { g.beginPath(); for (let i = 0; i <= 40; i++) { const t = i / 40, s = lerp(a[0], b[0], t), z = lerp(a[1], b[1], t) + 0.35 * Math.sin(t * 9 + ph) + 0.18 * Math.sin(t * 23 + ph * 2); const p = pt(s, z); if (i) g.lineTo(p[0], p[1]); else g.moveTo(p[0], p[1]); } g.strokeStyle = css(gold); g.lineWidth = Math.max(1.6, tw * 0.11); g.lineCap = 'round'; g.stroke();
        g.strokeStyle = css(pal.goldHi); g.lineWidth = Math.max(0.8, tw * 0.035); g.stroke();
        for (let i = 0; i < 7; i++) { const t = (i + 0.5) / 7, s = lerp(a[0], b[0], t), z = lerp(a[1], b[1], t) + 0.35 * Math.sin(t * 9 + ph) + 0.18 * Math.sin(t * 23 + ph * 2); const p = pt(s, z); g.beginPath(); g.ellipse(p[0], p[1], tw * (0.12 + 0.08 * hash2(i, 3, 9)), tw * 0.09, 0.4, 0, 7); g.fillStyle = css(i % 2 ? gold : pal.goldHi); g.fill(); } };
      const gallery = (pt, s0, s1, z, hgt) => { g.beginPath(); const a = pt(s0, z), b = pt(s1, z), c = pt(s1, z + hgt), d = pt(s0, z + hgt); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.lineTo(c[0], c[1]); g.lineTo(d[0], d[1]); g.closePath(); g.fillStyle = css(dark); g.fill();
        const n = Math.round(Math.abs(s1 - s0) / 0.9); for (let i = 0; i <= n; i++) { const s = lerp(s0, s1, i / n), p = pt(s, z), q = pt(s, z + hgt); g.beginPath(); g.moveTo(p[0], p[1]); g.lineTo(q[0], q[1]); g.strokeStyle = css(pal.timber); g.lineWidth = Math.max(1, tw * 0.05); g.stroke(); }
        const p = pt(s0, z + hgt), q = pt(s1, z + hgt); g.beginPath(); g.moveTo(p[0], p[1]); g.lineTo(q[0], q[1]); g.stroke(); };
      const lamp = (pt, s, z) => { const p = pt(s, z); g.save(); g.globalCompositeOperation = 'lighter'; const gr = g.createRadialGradient(p[0], p[1], 0, p[0], p[1], tw * 0.9); gr.addColorStop(0, css(pal.lamp, 0.85)); gr.addColorStop(0.3, css(pal.lamp, 0.25)); gr.addColorStop(1, css(pal.lamp, 0)); g.fillStyle = gr; g.fillRect(p[0] - tw, p[1] - tw, tw * 2, tw * 2); g.restore(); };
      seam(Lpt, [X0 + 0.6, -u.seam[0]], [X1 - 0.2, -u.seam[1]], 1); seam(Rpt, [Y1 - 0.2, -u.seam[1]], [Y0 + 1, -u.seam[2]], 4);
      const sx = u.shaftX; { const a = Lpt(sx - 0.3, V(Math.round(sx), Y1).h - 0.05), b = Lpt(sx + 0.3, V(Math.round(sx), Y1).h - 0.05), c = Lpt(sx + 0.3, -u.levels[u.levels.length - 1] + 0.1), d = Lpt(sx - 0.3, -u.levels[u.levels.length - 1] + 0.1); g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.lineTo(c[0], c[1]); g.lineTo(d[0], d[1]); g.closePath(); g.fillStyle = css(dark); g.fill();
        for (let z = -0.6; z > -u.levels[u.levels.length - 1]; z -= 0.8) { const p = Lpt(sx - 0.3, z), q = Lpt(sx + 0.3, z); g.beginPath(); g.moveTo(p[0], p[1]); g.lineTo(q[0], q[1]); g.strokeStyle = css(pal.timber, 0.8); g.lineWidth = Math.max(0.8, tw * 0.03); g.stroke(); } }
      u.levels.forEach((dz, i) => { const dirn = i % 2 ? -1 : 1, len = u.reach[i]; gallery(Lpt, sx + dirn * 0.3, sx + dirn * len, -dz, 0.62); lamp(Lpt, sx + dirn * (len - 0.5), -dz + 0.35); });
      if (u.right) u.right.forEach(([y0, y1, dz]) => { gallery(Rpt, y0, y1, -dz, 0.62); lamp(Rpt, (y0 + y1) / 2, -dz + 0.35); });
    }
    // ----- air: haze, smoke, steam -----
    if (o.haze) { const gr = g.createLinearGradient(0, 0, 0, H * o.haze.to); gr.addColorStop(0, o.haze.color); gr.addColorStop(1, o.haze.clear); g.fillStyle = gr; g.fillRect(0, 0, W, H * o.haze.to); }
    for (const sm of smokes) { const [x, y, z, k, wx, wy, kind] = sm; const steam = kind === 'steam', n = steam ? 3 : 10; const col = steam ? pal.steam : pal.smoke, hi = steam ? pal.steam : pal.smokeHi;
      for (let i = n - 1; i >= 0; i--) { const t = (i + 0.3) / n, drift = (wx || wy) ? 2.6 : 0.5, px = x + (wx || -0.5) * t * drift * k + Math.sin(i * 2.3) * 0.1 * k, py = y + (wy || -0.5) * t * drift * k + Math.cos(i * 1.9) * 0.1 * k, pz = z + Math.sqrt(t) * (steam ? 0.35 : 1.9) * k,
          p = P(px, py, pz), r = tw * (0.13 + t * (steam ? 0.16 : 0.4)) * k * (0.85 + 0.35 * hash2(i, 5, 2)), a = (steam ? 0.75 : (pal.smokeA || 0.95)) * (1 - t * 0.75);
        g.beginPath(); g.arc(p[0], p[1], r, 0, 7); g.fillStyle = css(col, a); g.fill(); g.beginPath(); g.arc(p[0] - r * 0.2, p[1] - r * 0.24, r * 0.7, 0, 7); g.fillStyle = css(hi, a * 0.8); g.fill(); } }
    return { project: P, hAt, rail: R, railAt, extent: [X0, Y0, X1, Y1] };
  }
  window.Diorama = { paint, railAt, buildRail };
})();

/* World palettes for the three designs (day survey tint, dusk, bright noon). */
window.WORLD = {
  day: { water: '#4d8683', waterHi: '#86b3a6', bank: '#c2ad80', meadow: ['#93a25a', '#a9a862'], forestFloor: '#5d7a45', rockLo: '#8d877b', rockHi: '#aaa59b', snow: '#efe8d6',
    earth: '#8b6a47', tailings: '#c79b55', town: '#c9b48a', ballast: '#8c7c68', wheat: '#d3ae52', tree: ['#2c5638', '#38683e', '#4f7b45', '#b98a2e'], leaf: '#5d8444', trunk: '#5a4230',
    wall: ['#e2d3ad', '#c9a77a', '#b9c0b0'], roof: ['#8e4a33', '#585d61', '#6e7f6a'], brick: '#9a5a40', stone: '#b9b3a2', timber: '#7b5a3b', iron: '#2b2e30', brass: '#c99b3d', gold: '#e2b23a', goldHi: '#f6dc86',
    window: '#f4cf7a', cabWin: '#22282b', loco: '#26382f', locoRoof: '#7a2f22', boiler: '#22272a', cow: '#8b2f22', coal: '#17191a', oreCar: '#6b4a34', ore: '#c9a24a', caboose: '#9a3b27', wheelHub: '#8b2f22',
    tie: '#4a3a2c', rail: '#d9d3c6', lamp: '#ffd98a', smoke: '#d9d2c2', smokeHi: '#f6f1e4', steam: '#fbf8ef', shade: '#2e3b4a', sun: '#ffe9b0', shadeAmt: 0.5, sunAmt: 0.9,
    cutL: ['#7a5a3e', '#9a7650', '#8a8072', '#6f6a62'], cutR: ['#5f4631', '#7a5c3f', '#6d655a', '#57534d'], tunnel: '#1d1713' },
  dusk: { water: '#2a4f5c', waterHi: '#d98a4e', bank: '#5d5546', meadow: ['#3f5540', '#4a5a3e'], forestFloor: '#263f33', rockLo: '#4a4a52', rockHi: '#6a6266', snow: '#c9a48f',
    earth: '#4a3a2e', tailings: '#7a5a34', town: '#5d5142', ballast: '#4b4640', wheat: '#8a6a34', tree: ['#14302a', '#1b3a2e', '#24463a', '#7a5a22'], leaf: '#2f4a33', trunk: '#2a211b',
    wall: ['#7d6f5c', '#6b5644', '#5f665f'], roof: ['#5a2f24', '#33373c', '#3c4a40'], brick: '#5e372a', stone: '#6f6a62', timber: '#4a3626', iron: '#15171a', brass: '#d9a441', gold: '#f0b93a', goldHi: '#ffe08a',
    window: '#ffc861', cabWin: '#ffc861', loco: '#1a2a24', locoRoof: '#4f2018', boiler: '#14181b', cow: '#6e241a', coal: '#0c0d0e', oreCar: '#3f2c20', ore: '#9a7a34', caboose: '#6e2a1c', wheelHub: '#6e241a',
    tie: '#241c16', rail: '#b9a58a', lamp: '#ffd27a', smokeA: 0.8, smoke: '#3d3f47', smokeHi: '#5b5557', steam: '#e9d6c0', shade: '#0d1a26', sun: '#f0a05c', shadeAmt: 0.7, sunAmt: 0.7, sunMax: 0.28,
    cutL: ['#3a2c20', '#4a3a2a', '#44403a', '#35322e'], cutR: ['#2a2018', '#352a1f', '#32302b', '#262422'], tunnel: '#0a0807' },
  noon: { water: '#3f8f8c', waterHi: '#8fc3b4', bank: '#d0b986', meadow: ['#87a552', '#a2ad5a'], forestFloor: '#4f7a40', rockLo: '#949088', rockHi: '#b6b2aa', snow: '#f6f1e2',
    earth: '#946c44', tailings: '#d1a04e', town: '#d3bd90', ballast: '#94836c', wheat: '#dcb44e', tree: ['#23543a', '#2f6a40', '#478044', '#c9952a'], leaf: '#55863c', trunk: '#5a4230',
    wall: ['#ecdcb4', '#d0aa78', '#bcc6b4'], roof: ['#9a4a30', '#565c62', '#5f7f66'], brick: '#a25a3c', stone: '#c4bdaa', timber: '#80592f', iron: '#272a2c', brass: '#d6a43a', gold: '#ecb92e', goldHi: '#ffe590',
    window: '#f4cf7a', cabWin: '#1c2326', loco: '#1f4a37', locoRoof: '#7f2c1e', boiler: '#1f2427', cow: '#9a2f1f', coal: '#141617', oreCar: '#70482e', ore: '#d6a83e', caboose: '#a63a22', wheelHub: '#9a2f1f',
    tie: '#4a3828', rail: '#e4ded0', lamp: '#ffd98a', smoke: '#e2dccd', smokeHi: '#fbf7ec', steam: '#ffffff', shade: '#243a44', sun: '#fff0c0', shadeAmt: 0.5, sunAmt: 0.9,
    cutL: ['#7c5634', '#a17a4a', '#8b8172', '#6b655c', '#94683c', '#5d5650'], cutR: ['#5e4128', '#7c5d38', '#6b6357', '#524d46', '#724f2d', '#474240'], tunnel: '#1a130e' }
};

/*
 * Retrace vectorization engine (VTrace)
 * --------------------------------------
 * Turns a raster image (RGBA pixels) into filled vector shapes made of lines and cubic Bezier curves.
 * It has no dependencies and runs in the browser or in Node.
 *
 * Pipeline, in the order trace() runs it:
 *   1. Colors      - pixels are converted to CIE Lab; "flat" (solid) pixels define the palette
 *                    (buildPalette), and thin dark keylines can add a line color.
 *   2. Labels      - every pixel gets a palette color. Edge pixels are judged as blends of the
 *                    colors around them, so anti-aliasing doesn't create in-between colors.
 *   3. Cleanup     - anti-aliasing slivers, stray specks and broken-off hairlines are folded into
 *                    the right neighbors; thin diagonal lines are kept joined.
 *   4. Boundaries  - each edge between two colored regions is traced once and shared by both
 *                    sides (no gaps or overlaps), with sub-pixel positions from the anti-aliasing.
 *   5. Fitting     - each edge is fitted with corners, straight runs and Bezier curves
 *                    (fitChain). Hard-edged pixel art uses a Potrace-style polygon instead
 *                    (potraceClosed). "Thorough" mode fits each edge several ways and keeps the
 *                    best-graded one (gradeCandidates).
 *   6. Finishing   - straighten near-axis edges, merge nodes, smooth 3-way junctions,
 *                    detect gradients and even-width outlines.
 *
 * Public API:
 *   await VTrace.trace(imageData, options, onProgress) -> result
 *   VTrace.shapes(result, mode, hiddenColors, scale, hiddenRegions, {gradients, outlines}) -> shape list
 *   VTrace.toSVG(result, shapes, width, height, {w, h} inches) -> SVG string
 *   result.refit(rect, 'smoother' | 'sharper' | 'closer' | 'straighter') re-fits edges inside a box.
 */
const VTrace = (() => {
  // ---------- color ----------
  const LIN = new Float32Array(256);
  for (let i = 0; i < 256; i++) { const c = i / 255; LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  const labF = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  function rgb2lab(r, g, b, out, o) {
    const R = LIN[r], G = LIN[g], B = LIN[b];
    const x = labF((R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047);
    const y = labF(R * 0.2126729 + G * 0.7151522 + B * 0.072175);
    const z = labF((R * 0.0193339 + G * 0.119192 + B * 0.9503041) / 1.08883);
    out[o] = 116 * y - 16; out[o + 1] = 500 * (x - y); out[o + 2] = 200 * (y - z);
  }
  const hex2 = v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  const toHex = (r, g, b) => '#' + hex2(r) + hex2(g) + hex2(b);

  const tick = () => new Promise(r => setTimeout(r, 0));

  // ---------- components ----------
  function components(lbl, W, H) {
    const N = W * H, comp = new Int32Array(N).fill(-1), stack = new Int32Array(N);
    const cLabel = [], cArea = [];
    let nc = 0;
    for (let s = 0; s < N; s++) {
      if (comp[s] !== -1) continue;
      const L = lbl[s]; let sp = 0, area = 0;
      stack[sp++] = s; comp[s] = nc;
      while (sp) {
        const i = stack[--sp]; area++;
        const x = i % W;
        if (x > 0 && comp[i - 1] === -1 && lbl[i - 1] === L) { comp[i - 1] = nc; stack[sp++] = i - 1; }
        if (x < W - 1 && comp[i + 1] === -1 && lbl[i + 1] === L) { comp[i + 1] = nc; stack[sp++] = i + 1; }
        if (i >= W && comp[i - W] === -1 && lbl[i - W] === L) { comp[i - W] = nc; stack[sp++] = i - W; }
        if (i < N - W && comp[i + W] === -1 && lbl[i + W] === L) { comp[i + W] = nc; stack[sp++] = i + W; }
      }
      cLabel.push(L); cArea.push(area); nc++;
    }
    return { comp, nc, cLabel, cArea };
  }

  // ---------- palette ----------
  // near black, tint differences are barely visible: weigh chroma down when both colours are very dark
  const darkW = (a, c) => { const L = Math.max(a.L, c.L); return L >= 25 ? 1 : 0.35 + 0.65 * (L / 25); };
  function buildPalette(d, lab, flat, opaque, N, opts) {
    const cnt = new Float64Array(32768), sr = new Float64Array(32768), sg = new Float64Array(32768), sb = new Float64Array(32768);
    let flatN = 0, opN = 0;
    for (let i = 0; i < N; i++) if (opaque[i]) { opN++; if (flat[i]) flatN++; }
    const useAll = flatN < opN * 0.05;
    let total = 0;
    for (let i = 0; i < N; i++) {
      if (!opaque[i] || (!useAll && !flat[i])) continue;
      const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
      const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      cnt[k]++; sr[k] += r; sg[k] += g; sb[k] += b; total++;
    }
    const bins = [];
    for (let k = 0; k < 32768; k++) if (cnt[k] > 0) bins.push(k);
    bins.sort((a, b) => cnt[b] - cnt[a]);
    const minCount = Math.max(3, total * 0.00008);
    let cands = [];
    const tmp = new Float32Array(3);
    for (const k of bins) {
      if (cnt[k] < minCount) break;
      const w = cnt[k], r = sr[k] / w, g = sg[k] / w, b = sb[k] / w;
      rgb2lab(Math.round(r), Math.round(g), Math.round(b), tmp, 0);
      let best = -1, bd = 1e9;
      for (let j = 0; j < cands.length; j++) {
        const c = cands[j], dl = c.L - tmp[0], da = c.A - tmp[1], db = c.B - tmp[2];
        const dd = dl * dl + da * da + db * db; if (dd < bd) { bd = dd; best = j; }
      }
      if (best >= 0 && bd < 25) {
        const c = cands[best], t = c.w + w;
        c.r = (c.r * c.w + r * w) / t; c.g = (c.g * c.w + g * w) / t; c.b = (c.b * c.w + b * w) / t;
        c.L = (c.L * c.w + tmp[0] * w) / t; c.A = (c.A * c.w + tmp[1] * w) / t; c.B = (c.B * c.w + tmp[2] * w) / t; c.w = t;
      } else if (cands.length < 300) {
        cands.push({ r, g, b, L: tmp[0], A: tmp[1], B: tmp[2], w });
      }
    }
    if (!cands.length) cands.push({ r: 0, g: 0, b: 0, L: 0, A: 0, B: 0, w: 1 });
    // agglomerative merge of closest pair
    const target = opts.colors > 0 ? opts.colors : 0;
    const sep = opts.separation || 12;
    while (cands.length > 1) {
      let bi = 0, bj = 1, bd = 1e18;
      for (let i = 0; i < cands.length; i++) for (let j = i + 1; j < cands.length; j++) {
        const a = cands[i], c = cands[j];
        const dk = darkW(a, c), dl = a.L - c.L, da = (a.A - c.A) * dk, db = (a.B - c.B) * dk;
        // Ward-like: small clusters merge more readily
        let dd = (dl * dl + da * da + db * db) * Math.sqrt((a.w * c.w) / (a.w + c.w) / total * 2000 + 1);
        // two large solid areas in clearly different shades (gold vs lemon yellow) are both design colours
        if (!target && a.w > total * 0.01 && c.w > total * 0.01 && dl * dl + da * da + db * db >= 10 * 10) dd = 1e17 + dd;
        if (dd < bd) { bd = dd; bi = i; bj = j; }
      }
      const a = cands[bi], c = cands[bj];
      const dk = darkW(a, c), dl = a.L - c.L, da = (a.A - c.A) * dk, db = (a.B - c.B) * dk, plain = Math.sqrt(dl * dl + da * da + db * db);
      if (target) { if (cands.length <= target) break; }
      else if ((plain >= sep || bd >= 1e17) && cands.length <= 40) break;
      const t = a.w + c.w;
      a.r = (a.r * a.w + c.r * c.w) / t; a.g = (a.g * a.w + c.g * c.w) / t; a.b = (a.b * a.w + c.b * c.w) / t;
      a.L = (a.L * a.w + c.L * c.w) / t; a.A = (a.A * a.w + c.A * c.w) / t; a.B = (a.B * a.w + c.B * c.w) / t; a.w = t;
      cands.splice(bj, 1);
    }
    // k-means refinement on flat pixels
    const K = cands.length;
    const step = Math.max(1, Math.floor(total / 250000));
    for (let it = 0; it < 6; it++) {
      const acc = new Float64Array(K * 7);
      let idx = 0;
      for (let i = 0; i < N; i++) {
        if (!opaque[i] || (!useAll && !flat[i])) continue;
        if ((idx++ % step) !== 0) continue;
        const L = lab[i * 3], A = lab[i * 3 + 1], B = lab[i * 3 + 2];
        let best = 0, bd = 1e18;
        for (let j = 0; j < K; j++) {
          const c = cands[j], dl = c.L - L, da = c.A - A, db = c.B - B, dd = dl * dl + da * da + db * db;
          if (dd < bd) { bd = dd; best = j; }
        }
        const o = best * 7;
        acc[o] += L; acc[o + 1] += A; acc[o + 2] += B; acc[o + 3] += d[i * 4]; acc[o + 4] += d[i * 4 + 1]; acc[o + 5] += d[i * 4 + 2]; acc[o + 6]++;
      }
      for (let j = 0; j < K; j++) {
        const o = j * 7, w = acc[o + 6]; if (!w) continue;
        const c = cands[j];
        c.L = acc[o] / w; c.A = acc[o + 1] / w; c.B = acc[o + 2] / w; c.r = acc[o + 3] / w; c.g = acc[o + 4] / w; c.b = acc[o + 5] / w; c.w = w;
      }
    }
    // a barely-used colour sitting right next to a major one is compression noise or edge tint, not a design colour
    for (let pass = 0; pass < 8; pass++) {
      const tot = cands.reduce((a, c) => a + c.w, 0);
      let drop = -1;
      for (let i = 0; i < cands.length && drop < 0; i++) for (let j = 0; j < cands.length; j++) {
        if (i === j) continue;
        const a = cands[i], c = cands[j]; if (a.w > c.w || a.w > tot * 0.003) continue;
        const dk = darkW(a, c), dd = Math.hypot(a.L - c.L, (a.A - c.A) * dk, (a.B - c.B) * dk);
        if (dd < 18) { drop = i; break; }
      }
      if (drop < 0 || cands.length < 2) break;
      cands.splice(drop, 1);
    }
    return cands;
  }

  // ---------- geometry helpers ----------
  const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

  function smoothPts(P, closed, passes) {
    let n = P.length; if (n < 3) return P.map(p => [p[0], p[1]]);
    let A = P.map(p => [p[0], p[1]]);
    for (let k = 0; k < passes; k++) {
      const B = A.map(p => [p[0], p[1]]);
      for (let i = 0; i < n; i++) {
        if (!closed && (i === 0 || i === n - 1)) continue;
        const a = A[(i - 1 + n) % n], b = A[(i + 1) % n];
        B[i][0] = (a[0] + 2 * A[i][0] + b[0]) / 4; B[i][1] = (a[1] + 2 * A[i][1] + b[1]) / 4;
      }
      A = B;
    }
    return A;
  }

  // index stepping by arc length; returns index or -1 if not reachable (open)
  function arcIndex(P, i, dir, r, closed) {
    const n = P.length; let s = 0, j = i;
    for (let guard = 0; guard < n; guard++) {
      let k = j + dir;
      if (closed) k = (k + n) % n; else if (k < 0 || k >= n) return j === i ? -1 : j;
      s += dist(P[j][0], P[j][1], P[k][0], P[k][1]); j = k;
      if (s >= r) return j;
    }
    return j;
  }

  function turnAngle(P, i, r, closed) {
    const a = arcIndex(P, i, -1, r, closed), b = arcIndex(P, i, 1, r, closed);
    if (a < 0 || b < 0 || a === i || b === i) return 0;
    const ux = P[i][0] - P[a][0], uy = P[i][1] - P[a][1], vx = P[b][0] - P[i][0], vy = P[b][1] - P[i][1];
    const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy); if (lu < 1e-9 || lv < 1e-9) return 0;
    return Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv))));
  }

  function detectCorners(P, closed, thr, passes, r) {
    const n = P.length;
    if (n < 5) return [];
    const S = smoothPts(P, closed, passes || 1);
    const strong = Math.max(thr + 0.45, 1.4);
    const ang = new Float32Array(n), cand = [];
    // arc positions for endpoint exclusion
    const s = new Float32Array(n);
    for (let i = 1; i < n; i++) s[i] = s[i - 1] + dist(S[i - 1][0], S[i - 1][1], S[i][0], S[i][1]);
    const total = s[n - 1];
    for (let i = 0; i < n; i++) {
      if (!closed && (s[i] < 1.6 || total - s[i] < 1.6)) continue;
      const a1 = turnAngle(S, i, r, closed);
      if (a1 < thr) continue;
      const a2 = turnAngle(S, i, r * 2, closed);
      if ((a1 >= strong || a1 >= 0.72 * a2) && a2 >= thr * 0.8) { ang[i] = a1; cand.push(i); }
    }
    // non-max suppression within arc r
    const out = [];
    for (const i of cand) {
      let keep = true;
      for (const j of cand) {
        if (j === i) continue;
        let dd = Math.abs(s[i] - s[j]); if (closed) dd = Math.min(dd, total - dd);
        if (dd <= r && (ang[j] > ang[i] || (ang[j] === ang[i] && j < i))) { keep = false; break; }
      }
      if (keep) out.push(i);
    }
    return out.sort((a, b) => a - b);
  }

  function fitLine(pts) {
    const n = pts.length; if (n < 2) return null;
    let mx = 0, my = 0; for (const p of pts) { mx += p[0]; my += p[1]; } mx /= n; my /= n;
    let sxx = 0, sxy = 0, syy = 0;
    for (const p of pts) { const dx = p[0] - mx, dy = p[1] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return { x: mx, y: my, dx: Math.cos(th), dy: Math.sin(th) };
  }

  function refineCorner(P, i, closed, lo, hi, U, check) {
    U = U || 1;
    // lo/hi: allowed index range (open sequence), lines fitted to legs
    const n = P.length, before = [], after = [];
    let s = 0, j = i;
    while (true) {
      let k = j - 1; if (closed) k = (k + n) % n; else if (k < lo) break;
      if (!closed && k < lo) break;
      s += dist(P[j][0], P[j][1], P[k][0], P[k][1]); j = k;
      if (s > 5 * U || j === i) break;
      if (s >= 0.8 * U) before.push(P[j]);
      if (closed && j === lo && lo !== i) break;
    }
    s = 0; j = i;
    while (true) {
      let k = j + 1; if (closed) k = k % n; else if (k > hi) break;
      s += dist(P[j][0], P[j][1], P[k][0], P[k][1]); j = k;
      if (s > 5 * U || j === i) break;
      if (s >= 0.8 * U) after.push(P[j]);
      if (closed && j === hi && hi !== i) break;
    }
    const p = P[i];
    if (before.length < 2 || after.length < 2) return [p[0], p[1]];
    const L1 = fitLine(before), L2 = fitLine(after);
    // orient leg directions away from the corner
    let d1 = [L1.dx, L1.dy], d2 = [L2.dx, L2.dy];
    const b0 = before[before.length - 1], a0 = after[after.length - 1];
    if ((b0[0] - p[0]) * d1[0] + (b0[1] - p[1]) * d1[1] < 0) d1 = [-d1[0], -d1[1]];
    if ((a0[0] - p[0]) * d2[0] + (a0[1] - p[1]) * d2[1] < 0) d2 = [-d2[0], -d2[1]];
    const den = d1[0] * d2[1] - d1[1] * d2[0];
    const acute = Math.max(0, d1[0] * d2[0] + d1[1] * d2[1]); // 1 = needle tip
    if (Math.abs(den) < 0.05) return [p[0], p[1]];
    const t = ((L2.x - L1.x) * d2[1] - (L2.y - L1.y) * d2[0]) / den;
    const X = L1.x + d1[0] * t, Y = L1.y + d1[1] * t;
    // the apex must lie ahead of the data (outside the rounded tip), not behind it
    const mx = (b0[0] + a0[0]) / 2, my = (b0[1] + a0[1]) / 2;
    const ahead = ((X - p[0]) * (p[0] - mx) + (Y - p[1]) * (p[1] - my)) >= -0.3 * U;
    const cap = (1.5 + 1.5 * acute) * U;
    let res = (!ahead || dist(X, Y, p[0], p[1]) > cap) ? [p[0], p[1]] : [X, Y];
    // reaching more than a pixel past the data needs the image to back it up
    if (res !== null && dist(res[0], res[1], p[0], p[1]) > 1.2 * U && check) {
      const f = check(p[0], p[1], res[0], res[1]);
      if (f < 0.999) { const keep = Math.max(1.2 * U / dist(res[0], res[1], p[0], p[1]), f); res = [p[0] + (res[0] - p[0]) * keep, p[1] + (res[1] - p[1]) * keep]; }
    }
    // slender tip: the pixels lose the last stretch of a taper, so extend the two edges to where they meet
    if (acute > 0.7 && check) {
      const legs = dir => {
        const out = []; let s2 = 0, jj = i;
        while (true) {
          let k = jj + dir; if (closed) k = (k + n) % n; else if (k < lo || k > hi) break;
          s2 += dist(P[jj][0], P[jj][1], P[k][0], P[k][1]); jj = k;
          if (s2 > 14 * U || jj === i) break;
          if (s2 >= 2 * U) out.push(P[jj]);
        }
        return out;
      };
      const B = legs(-1), A = legs(1);
      if (B.length >= 3 && A.length >= 3) {
        const M1 = fitLine(B), M2 = fitLine(A);
        let e1 = [M1.dx, M1.dy], e2 = [M2.dx, M2.dy];
        if ((p[0] - B[B.length - 1][0]) * e1[0] + (p[1] - B[B.length - 1][1]) * e1[1] < 0) e1 = [-e1[0], -e1[1]];
        if ((p[0] - A[A.length - 1][0]) * e2[0] + (p[1] - A[A.length - 1][1]) * e2[1] < 0) e2 = [-e2[0], -e2[1]];
        const conv = e1[0] * e2[0] + e1[1] * e2[1];
        const dn = e1[0] * e2[1] - e1[1] * e2[0];
        if (conv > 0.6 && Math.abs(dn) > 0.02) {
          const tt = ((M2.x - M1.x) * e2[1] - (M2.y - M1.y) * e2[0]) / dn;
          const TX = M1.x + e1[0] * tt, TY = M1.y + e1[1] * tt;
          const bis = norm([e1[0] + e2[0], e1[1] + e2[1]]);
          const fwd = (TX - p[0]) * bis[0] + (TY - p[1]) * bis[1];
          const far = dist(TX, TY, p[0], p[1]);
          if (fwd > 0 && far > dist(res[0], res[1], p[0], p[1]) && far < 16 * U) {
            const f = check(p[0], p[1], TX, TY);
            if (f > 0.999) res = [TX, TY, 2.2 * U];
            else if (f * far > dist(res[0], res[1], p[0], p[1]) + 0.5 * U) res = [p[0] + (TX - p[0]) * f, p[1] + (TY - p[1]) * f, 2.2 * U];
          }
        }
      }
    }
    return res;
  }

  // ---------- Schneider cubic fitting ----------
  function bezPt(b, t) {
    const mt = 1 - t, a = mt * mt * mt, c = 3 * mt * mt * t, d = 3 * mt * t * t, e = t * t * t;
    return [a * b[0] + c * b[2] + d * b[4] + e * b[6], a * b[1] + c * b[3] + d * b[5] + e * b[7]];
  }
  function bezD1(b, t) {
    const mt = 1 - t;
    return [3 * (mt * mt * (b[2] - b[0]) + 2 * mt * t * (b[4] - b[2]) + t * t * (b[6] - b[4])),
            3 * (mt * mt * (b[3] - b[1]) + 2 * mt * t * (b[5] - b[3]) + t * t * (b[7] - b[5]))];
  }
  function bezD2(b, t) {
    const mt = 1 - t;
    return [6 * (mt * (b[4] - 2 * b[2] + b[0]) + t * (b[6] - 2 * b[4] + b[2])),
            6 * (mt * (b[5] - 2 * b[3] + b[1]) + t * (b[7] - 2 * b[5] + b[3]))];
  }
  function chordParam(P, f, l) {
    const u = [0];
    for (let i = f + 1; i <= l; i++) u.push(u[u.length - 1] + dist(P[i][0], P[i][1], P[i - 1][0], P[i - 1][1]));
    const T = u[u.length - 1] || 1; return u.map(v => v / T);
  }
  function genBez(P, f, l, u, t1, t2) {
    const p0 = P[f], p3 = P[l];
    let C00 = 0, C01 = 0, C11 = 0, X0 = 0, X1 = 0;
    for (let i = 0; i < u.length; i++) {
      const t = u[i], mt = 1 - t, b0 = mt * mt * mt, b1 = 3 * mt * mt * t, b2 = 3 * mt * t * t, b3 = t * t * t;
      const A1x = t1[0] * b1, A1y = t1[1] * b1, A2x = t2[0] * b2, A2y = t2[1] * b2;
      C00 += A1x * A1x + A1y * A1y; C01 += A1x * A2x + A1y * A2y; C11 += A2x * A2x + A2y * A2y;
      const tx = P[f + i][0] - (p0[0] * (b0 + b1) + p3[0] * (b2 + b3));
      const ty = P[f + i][1] - (p0[1] * (b0 + b1) + p3[1] * (b2 + b3));
      X0 += A1x * tx + A1y * ty; X1 += A2x * tx + A2y * ty;
    }
    const det = C00 * C11 - C01 * C01;
    let al = 0, ar = 0;
    if (Math.abs(det) > 1e-12) { al = (X0 * C11 - X1 * C01) / det; ar = (C00 * X1 - C01 * X0) / det; }
    const seg = dist(p0[0], p0[1], p3[0], p3[1]), eps = 1e-6 * seg;
    if (al < eps || ar < eps || al > seg * 1.6 || ar > seg * 1.6) { al = ar = seg / 3; }
    return [p0[0], p0[1], p0[0] + t1[0] * al, p0[1] + t1[1] * al, p3[0] + t2[0] * ar, p3[1] + t2[1] * ar, p3[0], p3[1]];
  }
  function maxErr(P, f, l, b, u) {
    let m = 0, sp = Math.floor((l - f + 1) / 2) + f;
    for (let i = f + 1; i < l; i++) {
      const q = bezPt(b, u[i - f]), dd = (q[0] - P[i][0]) ** 2 + (q[1] - P[i][1]) ** 2;
      if (dd >= m) { m = dd; sp = i; }
    }
    return [m, sp];
  }
  function reparam(P, f, l, u, b) {
    return u.map((t, k) => {
      const p = P[f + k], q = bezPt(b, t), d1 = bezD1(b, t), d2 = bezD2(b, t);
      const num = (q[0] - p[0]) * d1[0] + (q[1] - p[1]) * d1[1];
      const den = d1[0] * d1[0] + d1[1] * d1[1] + (q[0] - p[0]) * d2[0] + (q[1] - p[1]) * d2[1];
      if (Math.abs(den) < 1e-12) return t;
      return Math.max(0, Math.min(1, t - num / den));
    });
  }
  const norm = v => { const L = Math.hypot(v[0], v[1]) || 1; return [v[0] / L, v[1] / L]; };
  function fitCubic(P, f, l, t1, t2, tol2, out, depth) {
    const n = l - f + 1;
    if (n === 2) {
      const d = dist(P[f][0], P[f][1], P[l][0], P[l][1]) / 3;
      out.push([P[f][0], P[f][1], P[f][0] + t1[0] * d, P[f][1] + t1[1] * d, P[l][0] + t2[0] * d, P[l][1] + t2[1] * d, P[l][0], P[l][1]]);
      return;
    }
    let u = chordParam(P, f, l), b = genBez(P, f, l, u, t1, t2), [e, sp] = maxErr(P, f, l, b, u);
    // limit the sweep of a single cubic: big arcs in one segment drift visibly
    const turn = Math.acos(Math.max(-1, Math.min(1, -(t1[0] * t2[0] + t1[1] * t2[1]))));
    if (turn > 1.75 && n > 6 && depth < 40) {
      let half = 0; for (let k = 0; k < u.length; k++) if (u[k] <= 0.5) half = k;
      sp = Math.max(f + 2, Math.min(l - 2, f + half));
      const fw = midTangent(P, sp, f, l), tc = [-fw[0], -fw[1]];
      fitCubic(P, f, sp, t1, tc, tol2, out, depth + 1);
      fitCubic(P, sp, l, fw, t2, tol2, out, depth + 1);
      return;
    }
    if (e < tol2) { out.push(b); return; }
    if (e < tol2 * 16) {
      for (let it = 0; it < 10; it++) {
        const u2 = reparam(P, f, l, u, b); b = genBez(P, f, l, u2, t1, t2);[e, sp] = maxErr(P, f, l, b, u2); u = u2;
        if (e < tol2) { out.push(b); return; }
      }
    }
    if (depth > 40) { out.push(b); return; }
    sp = Math.max(f + 1, Math.min(l - 1, sp));
    const fw = midTangent(P, sp, f, l);
    const tc = [-fw[0], -fw[1]];
    fitCubic(P, f, sp, t1, tc, tol2, out, depth + 1);
    fitCubic(P, sp, l, [-tc[0], -tc[1]], t2, tol2, out, depth + 1);
  }
  // one-sided tangent at P[i] heading in direction dir, from a quadratic fit through P[i]
  function endTangent(P, i, dir) {
    const n = P.length; let s = 0, j = i;
    const idx = [];
    while (true) {
      const k = j + dir; if (k < 0 || k >= n) break;
      s += dist(P[j][0], P[j][1], P[k][0], P[k][1]); j = k; idx.push(k);
      if (s >= 6) break;
    }
    if (!idx.length) return [1, 0];
    const far = P[idx[idx.length - 1]], o = P[i];
    let ux = far[0] - o[0], uy = far[1] - o[1]; const L = Math.hypot(ux, uy) || 1; ux /= L; uy /= L;
    if (idx.length < 3) return [ux, uy];
    // v = b u + c u^2 least squares
    let A11 = 0, A12 = 0, A22 = 0, B1 = 0, B2 = 0;
    for (const k of idx) {
      const px = P[k][0] - o[0], py = P[k][1] - o[1];
      const u = px * ux + py * uy, v = -px * uy + py * ux, u2 = u * u;
      A11 += u2; A12 += u2 * u; A22 += u2 * u2; B1 += u * v; B2 += u2 * v;
    }
    const det = A11 * A22 - A12 * A12;
    if (Math.abs(det) < 1e-9) return [ux, uy];
    let bb = (B1 * A22 - B2 * A12) / det;
    bb = Math.max(-1.5, Math.min(1.5, bb));
    return norm([ux - bb * uy, uy + bb * ux]);
  }
  // symmetric tangent at an interior index (forward direction)
  function midTangent(P, i, lo, hi) {
    let k = 6; while (k > 1 && (i - k < lo || i + k > hi)) k--;
    const a = P[Math.max(lo, i - k)], c = P[Math.min(hi, i + k)];
    return norm([c[0] - a[0], c[1] - a[1]]);
  }
  function lineDev(P) {
    const a = P[0], b = P[P.length - 1], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
    if (L < 1e-9) return 1e9;
    let m = 0;
    for (const p of P) { const d = Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / L; if (d > m) m = d; }
    return m;
  }
  // straightness stats of P[i..j]: [max deviation from chord, implied sagitta of a quadratic fit, chord length]
  function runStats(P, i, j) {
    const n = j - i + 1;
    if (n < 2) return [0, 0, 0];
    let mx0 = 0, my0 = 0;
    for (let k = i; k <= j; k++) { mx0 += P[k][0]; my0 += P[k][1]; }
    mx0 /= n; my0 /= n;
    let sxx = 0, sxy = 0, syy = 0;
    for (let k = i; k <= j; k++) { const dx = P[k][0] - mx0, dy = P[k][1] - my0; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), ux = Math.cos(th), uy = Math.sin(th);
    const L = dist(P[i][0], P[i][1], P[j][0], P[j][1]);
    let mx = 0, S0 = 0, S1 = 0, S2 = 0, S3 = 0, S4 = 0, T0 = 0, T1 = 0, T2 = 0;
    for (let k = i; k <= j; k++) {
      const px = P[k][0] - mx0, py = P[k][1] - my0, u = px * ux + py * uy, v = -px * uy + py * ux;
      if (Math.abs(v) > mx) mx = Math.abs(v);
      const u2 = u * u; S0++; S1 += u; S2 += u2; S3 += u2 * u; S4 += u2 * u2; T0 += v; T1 += u * v; T2 += u2 * v;
    }
    const det = S0 * (S2 * S4 - S3 * S3) - S1 * (S1 * S4 - S3 * S2) + S2 * (S1 * S3 - S2 * S2);
    let c = 0;
    if (Math.abs(det) > 1e-9) c = (S0 * (S2 * T2 - T1 * S3) - S1 * (S1 * T2 - T1 * S2) + T0 * (S1 * S3 - S2 * S2)) / det;
    return [mx, Math.abs(c) * L * L / 4, L];
  }
  function findRuns(P, lt, minLen, sagTol) {
    const n = P.length, runs = [];
    let i = 0;
    while (i < n - 2) {
      let j = i + 2, best = -1;
      while (j < n) {
        const [mx, sag, L] = runStats(P, i, j);
        if (mx > lt || (j - i > 4 && sag > sagTol)) break;
        if (L >= minLen) best = j;
        j++;
      }
      if (best > 0) {
        let a = i;
        const floor = runs.length ? runs[runs.length - 1][1] : 0;
        while (a > floor) { const [mx, sag] = runStats(P, a - 1, best); if (mx > lt || sag > sagTol) break; a--; }
        runs.push([a, best]); i = best;
      } else i++;
    }
    // snap runs that nearly reach the piece ends (corners) onto them
    const arcTo = (x, y) => { let s = 0; for (let k = Math.min(x, y); k < Math.max(x, y); k++) s += dist(P[k][0], P[k][1], P[k + 1][0], P[k + 1][1]); return s; };
    for (const r of runs) { if (r[0] > 0 && arcTo(0, r[0]) < 2.2) r[0] = 0; if (r[1] < n - 1 && arcTo(r[1], n - 1) < 2.2) r[1] = n - 1; }
    // runs tend to creep into the tangent arcs they meet; pull interior ends back
    const out = [];
    for (let [i, j] of runs) {
      const i0 = i, j0 = j;
      if (i > 0) { let s = 0; while (i < j - 1 && s < 2.5) { s += dist(P[i][0], P[i][1], P[i + 1][0], P[i + 1][1]); i++; } }
      if (j < n - 1) { let s = 0; while (j > i + 1 && s < 2.5) { s += dist(P[j][0], P[j][1], P[j - 1][0], P[j - 1][1]); j--; } }
      if (dist(P[i][0], P[i][1], P[j][0], P[j][1]) < minLen * 0.6) continue;
      // a "line" that is really the flat spot of a gentle curve: the surrounding curve explains it
      const len = dist(P[i0][0], P[i0][1], P[j0][0], P[j0][1]);
      const ext = Math.max(4, 0.6 * len);
      let a = i0, sA = 0; while (a > 0 && sA < ext) { sA += dist(P[a][0], P[a][1], P[a - 1][0], P[a - 1][1]); a--; }
      let b = j0, sB = 0; while (b < n - 1 && sB < ext) { sB += dist(P[b][0], P[b][1], P[b + 1][0], P[b + 1][1]); b++; }
      if (sA >= ext * 0.8 && sB >= ext * 0.8) {
        const [, sag] = runStats(P, a, b);
        let mxr = 0;
        const span = b - a;
        if (sag > sagTol * 1.5) {
          // residual of a quadratic over the extended window
          const pa = P[a], pb = P[b], dx = pb[0] - pa[0], dy = pb[1] - pa[1], Lw = Math.hypot(dx, dy) || 1, ux = dx / Lw, uy = dy / Lw;
          const us = [], vs = [];
          for (let k = a; k <= b; k++) { const px = P[k][0] - pa[0], py = P[k][1] - pa[1]; us.push(px * ux + py * uy - Lw / 2); vs.push(-px * uy + py * ux); }
          let S0 = 0, S1 = 0, S2 = 0, S3 = 0, S4 = 0, T0 = 0, T1 = 0, T2 = 0;
          for (let k = 0; k <= span; k++) { const u = us[k], v = vs[k], u2 = u * u; S0++; S1 += u; S2 += u2; S3 += u2 * u; S4 += u2 * u2; T0 += v; T1 += u * v; T2 += u2 * v; }
          const d3 = (a1, a2, a3, b1, b2, b3, c1, c2, c3) => a1 * (b2 * c3 - b3 * c2) - a2 * (b1 * c3 - b3 * c1) + a3 * (b1 * c2 - b2 * c1);
          const D = d3(S0, S1, S2, S1, S2, S3, S2, S3, S4);
          if (Math.abs(D) > 1e-9) {
            const c0 = d3(T0, S1, S2, T1, S2, S3, T2, S3, S4) / D, c1 = d3(S0, T0, S2, S1, T1, S3, S2, T2, S4) / D, c2 = d3(S0, S1, T0, S1, S2, T1, S2, S3, T2) / D;
            for (let k = 0; k <= span; k++) mxr = Math.max(mxr, Math.abs(vs[k] - (c0 + c1 * us[k] + c2 * us[k] * us[k])));
            if (mxr <= lt) continue;
          }
        }
      }
      out.push([i, j]);
    }
    return out;
  }
  function fitCurveRun(P, tol, out, t1, t2) {
    const n = P.length;
    if (n < 2) return;
    if (!t1) t1 = endTangent(P, 0, 1);
    if (!t2) t2 = endTangent(P, n - 1, -1);
    if (n === 2 && dist(P[0][0], P[0][1], P[1][0], P[1][1]) < 1e-6) return;
    const segs = [];
    fitCubic(P, 0, n - 1, t1, t2, tol * tol, segs, 0);
    for (const b of segs) out.push(straighten(b));
  }
  // fit an open piece whose endpoints are fixed; optional end tangents
  // P: smoothed points for curve fitting; PL: lightly smoothed points (same indexing) for line detection
  function fitPiece(P, tol, out, tStart, tEnd, o, PL) {
    const n = P.length;
    if (n <= 2 || (!tStart && !tEnd && lineDev(PL) <= o.lineTol)) { out.push([P[0][0], P[0][1], P[n - 1][0], P[n - 1][1]]); return; }
    const runs = findRuns(PL, o.lineTol, 7 * (o.unit || 1), o.sagTol);
    if (!runs.length) { fitCurveRun(P, tol, out, tStart, tEnd); return; }
    // project run ends onto their fitted lines
    const R = runs.map(([i, j]) => {
      const L = fitLine(PL.slice(i, j + 1));
      const proj = p => { const t = (p[0] - L.x) * L.dx + (p[1] - L.y) * L.dy; return [L.x + L.dx * t, L.y + L.dy * t]; };
      const A = i === 0 ? [P[0][0], P[0][1]] : proj(P[i]);
      const B = j === n - 1 ? [P[n - 1][0], P[n - 1][1]] : proj(P[j]);
      return { i, j, A, B, dir: norm([B[0] - A[0], B[1] - A[1]]) };
    });
    let prevPt = [P[0][0], P[0][1]], prevIdx = 0, prevTan = tStart || null;
    for (const r of R) {
      if (r.i > prevIdx) {
        const pts = [prevPt].concat(P.slice(prevIdx + 1, r.i), [r.A]);
        fitCurveRun(pts, tol, out, prevTan, [-r.dir[0], -r.dir[1]]);
      } else if (dist(prevPt[0], prevPt[1], r.A[0], r.A[1]) > 1e-6) {
        out.push([prevPt[0], prevPt[1], r.A[0], r.A[1]]);
      }
      out.push([r.A[0], r.A[1], r.B[0], r.B[1]]);
      prevPt = r.B; prevIdx = r.j; prevTan = r.dir;
    }
    if (prevIdx < n - 1) {
      const pts = [prevPt].concat(P.slice(prevIdx + 1, n));
      fitCurveRun(pts, tol, out, prevTan, tEnd);
    }
  }
  function fitClosedSmooth(P, tol, out, o, PL) {
    const n = P.length;
    // start at the most curved point so straight runs are not split
    let s0 = 0, best = -1;
    for (let i = 0; i < n; i += 1) { const a = turnAngle(P, i, 3, true); if (a > best) { best = a; s0 = i; } }
    const Q = P.slice(s0).concat(P.slice(0, s0));
    const QL = PL.slice(s0).concat(PL.slice(0, s0));
    const k = Math.min(6, Math.floor(n / 4)), a = Q[n - k], c = Q[k];
    const t = norm([c[0] - a[0], c[1] - a[1]]);
    fitPiece(Q.concat([Q[0]]), tol, out, t, [-t[0], -t[1]], o, QL.concat([QL[0]]));
  }
  function straighten(b) {
    const dx = b[6] - b[0], dy = b[7] - b[1], L = Math.hypot(dx, dy);
    if (L < 1e-9) return b;
    const d1 = Math.abs((b[2] - b[0]) * dy - (b[3] - b[1]) * dx) / L, d2 = Math.abs((b[4] - b[0]) * dy - (b[5] - b[1]) * dx) / L;
    const t1 = ((b[2] - b[0]) * dx + (b[3] - b[1]) * dy) / (L * L), t2 = ((b[4] - b[0]) * dx + (b[5] - b[1]) * dy) / (L * L);
    if (d1 < 0.12 && d2 < 0.12 && t1 >= -0.01 && t1 <= 1.01 && t2 >= -0.01 && t2 <= 1.01) return [b[0], b[1], b[6], b[7]];
    return b;
  }

  // perpendicular residual of P[i] against a quadratic through P[i-k..i+k]
  function quadResid(P, i, k) {
    const a = P[i - k], b = P[i + k], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
    if (L < 1e-6) return -1;
    const ux = dx / L, uy = dy / L;
    let S0 = 0, S1 = 0, S2 = 0, S3 = 0, S4 = 0, T0 = 0, T1 = 0, T2 = 0, uc = 0, vc = 0;
    for (let j = i - k; j <= i + k; j++) {
      const px = P[j][0] - a[0], py = P[j][1] - a[1], u = px * ux + py * uy - L / 2, v = -px * uy + py * ux, u2 = u * u;
      if (j === i) { uc = u; vc = v; }
      S0++; S1 += u; S2 += u2; S3 += u2 * u; S4 += u2 * u2; T0 += v; T1 += u * v; T2 += u2 * v;
    }
    const d3 = (a1, a2, a3, b1, b2, b3, c1, c2, c3) => a1 * (b2 * c3 - b3 * c2) - a2 * (b1 * c3 - b3 * c1) + a3 * (b1 * c2 - b2 * c1);
    const D = d3(S0, S1, S2, S1, S2, S3, S2, S3, S4); if (Math.abs(D) < 1e-9) return -1;
    const c0 = d3(T0, S1, S2, T1, S2, S3, T2, S3, S4) / D, c1 = d3(S0, T0, S2, S1, T1, S3, S2, T2, S4) / D, c2 = d3(S0, S1, T0, S1, S2, T1, S2, S3, T2) / D;
    return Math.abs(vc - (c0 + c1 * uc + c2 * uc * uc));
  }
  // fit a whole chain; segments are [x0,y0,x1,y1] lines or 8-number cubics
  function fitChain(P, closed, o) {
    const tol = o.tol, thr = o.cornerAngle * Math.PI / 180;
    const n = P.length, out = [];
    if (!closed && n <= 3) { out.push([P[0][0], P[0][1], P[n - 1][0], P[n - 1][1]]); return out; }
    const corners = detectCorners(P, closed, thr, o.cornerPasses, (o.cornerR || 2.5) * (o.unit || 1));
    if (closed && corners.length === 0) {
      fitClosedSmooth(smoothPts(P, true, o.smoothPasses), tol, out, o, smoothPts(P, true, 1)); return out;
    }
    let Q = P, cs = corners;
    if (closed) {
      const r0 = corners[0];
      Q = P.slice(r0).concat(P.slice(0, r0)).concat([P[r0]]);
      cs = corners.map(c => c - r0);
      cs = cs.slice(1); // interior corners in the rotated open sequence
    }
    const m = Q.length;
    const breaks = [0, ...cs, m - 1];
    // refined points at breaks
    const refined = breaks.map((bi, k) => {
      if (closed && (k === 0 || k === breaks.length - 1)) {
        // corner at the wrap point: refine using the closed original
        return refineCorner(P, corners[0], true, corners[0], corners[0], o.unit, o.tipCheck);
      }
      if (!closed && (k === 0 || k === breaks.length - 1)) return [Q[bi][0], Q[bi][1]];
      return refineCorner(Q, bi, false, breaks[k - 1], breaks[k + 1], o.unit, o.tipCheck);
    });
    const arc = new Float64Array(m);
    for (let i = 1; i < m; i++) arc[i] = arc[i - 1] + dist(Q[i - 1][0], Q[i - 1][1], Q[i][0], Q[i][1]);
    for (let k = 0; k < breaks.length - 1; k++) {
      const a = breaks[k], b = breaks[k + 1];
      const isCornerA = true, isCornerB = true;
      const ra = refined[k], rb = refined[k + 1];
      let pts = [[ra[0], ra[1]]];
      for (let i = a + 1; i < b; i++) {
        const p = Q[i];
        if (isCornerA && dist(p[0], p[1], ra[0], ra[1]) < 0.9) continue;
        if (isCornerB && dist(p[0], p[1], rb[0], rb[1]) < 0.9) continue;
        if (ra[2] && arc[i] - arc[a] < ra[2]) continue;
        if (rb[2] && arc[b] - arc[i] < rb[2]) continue;
        pts.push(p);
      }
      pts.push([rb[0], rb[1]]);
      fitPiece(smoothPts(pts, false, o.smoothPasses), tol, out, null, null, o, smoothPts(pts, false, o.cornerPasses));
    }
    return out;
  }

  // On a pixel staircase the true edge passes through the short 1px "risers"; the long flat treads only
  // wobble around it. Keep riser midpoints, drop treads that sit between same-direction risers, then resample.
  function dealias(pts, mv, closed) {
    const n = mv.length;
    let start = 0;
    if (closed) { start = -1; for (let k = 0; k < n; k++) if (mv[k] !== mv[(k - 1 + n) % n]) { start = k; break; } if (start < 0) return pts; }
    const runs = [];
    for (let c = 0; c < n;) {
      const k0 = (start + c) % n, dd = mv[k0]; let len = 0;
      while (c < n && mv[(start + c) % n] === dd) { len++; c++; }
      runs.push({ s: k0, len, dir: dd });
    }
    const R = runs.length; if (R < 3) return pts;
    const keep = [];
    const turn = (p, q) => ((q - p + 4) & 3) === 1 ? 1 : -1;
    // 1px bumps/dents on an otherwise straight edge (scan noise, distressed type): flatten them away
    const drop = new Uint8Array(R);
    for (let t = 0; t < R; t++) {
      const at = q => (closed ? runs[((t + q) % R + R) % R] : runs[t + q]);
      const r = runs[t], p1 = at(-1), n1 = at(1), p2 = at(-2), n2 = at(2);
      if (!p1 || !n1 || !p2 || !n2 || R < 5) continue;
      if (p1.len !== 1 || n1.len !== 1 || r.len > 12) continue;
      if (Math.min(p2.len, n2.len) < 3 * r.len) continue; // short edges around it: probably a real nub (serif, flag), keep it
      if (p2.dir !== r.dir || n2.dir !== r.dir || p1.dir === n1.dir) continue; // out-and-back, edge resumes on its line
      if (p2.len < Math.max(4, r.len) || n2.len < Math.max(4, r.len)) continue;
      drop[t] = 1; drop[(t - 1 + R) % R] = 1; drop[(t + 1) % R] = 1;
    }
    for (let t = 0; t < R; t++) {
      const r = runs[t];
      if (drop[t]) continue;
      const pr = closed || t > 0 ? runs[(t - 1 + R) % R] : null, nx = closed || t < R - 1 ? runs[(t + 1) % R] : null;
      if (r.len === 1) { keep.push(r.s); continue; }
      // staircase: turns alternate left/right around a run, and the edge crosses the run at its centre
      // only collapse runs flanked by 1-2px risers; long neighbours mean real geometry (stems, notches, corners)
      const shortNbrs = pr && nx && pr.len <= 2 && nx.len <= 2;
      const stair = shortNbrs && turn(pr.dir, r.dir) !== turn(r.dir, nx.dir);
      const bump = shortNbrs && !stair && r.len <= 8;
      if (stair || bump) {
        if (r.len & 1) keep.push((r.s + (r.len >> 1)) % n);
        else keep.push({ a: (r.s + (r.len >> 1) - 1) % n, b: (r.s + (r.len >> 1)) % n });
        continue;
      }
      for (let q = 0; q < r.len; q++) keep.push((r.s + q) % n);
    }
    if (keep.length < 4 || keep.length > n * 0.9) return pts;
    const idx = k => typeof k === 'number' ? k : k.a;
    const K0 = keep.map(k => typeof k === 'number' ? pts[k] : [(pts[k.a][0] + pts[k.b][0]) / 2, (pts[k.a][1] + pts[k.b][1]) / 2]);
    if (!closed) { if (idx(keep[0]) !== 0) K0.unshift(pts[0]); if (idx(keep[keep.length - 1]) !== n - 1) K0.push(pts[n - 1]); }
    // resample to ~1px spacing
    const out = [];
    const m = K0.length, segs = closed ? m : m - 1;
    for (let k = 0; k < segs; k++) {
      const a = K0[k], b = K0[(k + 1) % m], L = dist(a[0], a[1], b[0], b[1]), steps = Math.max(1, Math.round(L));
      for (let q = 0; q < steps; q++) out.push([a[0] + (b[0] - a[0]) * q / steps, a[1] + (b[1] - a[1]) * q / steps]);
    }
    if (!closed) out.push(K0[m - 1]);
    return out;
  }

  // ---------- Potrace-style reconstruction for hard-edged closed outlines ----------
  // (after P. Selinger's Potrace: longest straight subpaths -> optimal polygon -> vertex adjustment -> corner/curve smoothing)
  function potraceClosed(xs, ys, alphamax, snapDeg, minDefl, rmax) {
    const n = xs.length;
    if (n < 4) return null;
    const mod = (a, m) => ((a % m) + m) % m;
    const sign = v => (v > 0 ? 1 : v < 0 ? -1 : 0);
    const xprod = (ax, ay, bx, by) => ax * by - ay * bx;
    const cyclic = (a, b, c) => (a <= c ? a <= b && b < c : a <= b || b < c);
    const x0 = xs[0], y0 = ys[0];
    // sums
    const SX = new Float64Array(n + 1), SY = new Float64Array(n + 1), SXY = new Float64Array(n + 1), SX2 = new Float64Array(n + 1), SY2 = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      const x = xs[i] - x0, y = ys[i] - y0;
      SX[i + 1] = SX[i] + x; SY[i + 1] = SY[i] + y; SXY[i + 1] = SXY[i] + x * y; SX2[i + 1] = SX2[i] + x * x; SY2[i + 1] = SY2[i] + y * y;
    }
    // lon
    const nc = new Int32Array(n), pivk = new Int32Array(n), lon = new Int32Array(n), ct = [0, 0, 0, 0];
    let k = 0;
    for (let i = n - 1; i >= 0; i--) { if (xs[i] !== xs[k] && ys[i] !== ys[k]) k = i + 1; nc[i] = k; }
    // nc[i] may be n -> wrap
    for (let i = 0; i < n; i++) nc[i] = mod(nc[i], n);
    for (let i = n - 1; i >= 0; i--) {
      ct[0] = ct[1] = ct[2] = ct[3] = 0;
      let dir = (3 + 3 * (xs[mod(i + 1, n)] - xs[i]) + (ys[mod(i + 1, n)] - ys[i])) / 2;
      ct[dir]++;
      let c0x = 0, c0y = 0, c1x = 0, c1y = 0;
      k = nc[i]; let k1 = i, found = false;
      while (true) {
        dir = (3 + 3 * sign(xs[k] - xs[k1]) + sign(ys[k] - ys[k1])) / 2;
        ct[dir]++;
        if (ct[0] && ct[1] && ct[2] && ct[3]) { pivk[i] = k1; found = true; break; }
        const cx = xs[k] - xs[i], cy = ys[k] - ys[i];
        if (xprod(c0x, c0y, cx, cy) < 0 || xprod(c1x, c1y, cx, cy) > 0) break;
        if (!(Math.abs(cx) <= 1 && Math.abs(cy) <= 1)) {
          let ox = cx + ((cy >= 0 && (cy > 0 || cx < 0)) ? 1 : -1), oy = cy + ((cx <= 0 && (cx < 0 || cy < 0)) ? 1 : -1);
          if (xprod(c0x, c0y, ox, oy) >= 0) { c0x = ox; c0y = oy; }
          ox = cx + ((cy <= 0 && (cy < 0 || cx < 0)) ? 1 : -1); oy = cy + ((cx >= 0 && (cx > 0 || cy < 0)) ? 1 : -1);
          if (xprod(c1x, c1y, ox, oy) <= 0) { c1x = ox; c1y = oy; }
        }
        k1 = k; k = nc[k1];
        if (!cyclic(k, i, k1)) break;
      }
      if (!found) {
        const dkx = sign(xs[k] - xs[k1]), dky = sign(ys[k] - ys[k1]);
        const cx = xs[k1] - xs[i], cy = ys[k1] - ys[i];
        const a = xprod(c0x, c0y, cx, cy), b = xprod(c0x, c0y, dkx, dky), c = xprod(c1x, c1y, cx, cy), d = xprod(c1x, c1y, dkx, dky);
        let j = 10000000;
        if (b < 0) j = Math.floor(a / -b);
        if (d > 0) j = Math.min(j, Math.floor(-c / d));
        pivk[i] = mod(k1 + j, n);
      }
    }
    let j = pivk[n - 1]; lon[n - 1] = j;
    for (let i = n - 2; i >= 0; i--) { if (cyclic(i + 1, pivk[i], j)) j = pivk[i]; lon[i] = j; }
    for (let i = n - 1; cyclic(mod(i + 1, n), j, lon[i]); i--) lon[i] = j;
    // penalty3
    const penalty3 = (i, j) => {
      let r = 0; if (j >= n) { j -= n; r = 1; }
      let x, y, x2, xy, y2, kk;
      if (!r) { x = SX[j + 1] - SX[i]; y = SY[j + 1] - SY[i]; x2 = SX2[j + 1] - SX2[i]; xy = SXY[j + 1] - SXY[i]; y2 = SY2[j + 1] - SY2[i]; kk = j + 1 - i; }
      else { x = SX[j + 1] - SX[i] + SX[n]; y = SY[j + 1] - SY[i] + SY[n]; x2 = SX2[j + 1] - SX2[i] + SX2[n]; xy = SXY[j + 1] - SXY[i] + SXY[n]; y2 = SY2[j + 1] - SY2[i] + SY2[n]; kk = j + 1 - i + n; }
      const px = (xs[i] + xs[j]) / 2 - x0, py = (ys[i] + ys[j]) / 2 - y0, ey = xs[j] - xs[i], ex = -(ys[j] - ys[i]);
      const a = (x2 - 2 * x * px) / kk + px * px, b = (xy - x * py - y * px) / kk + px * py, c = (y2 - 2 * y * py) / kk + py * py;
      return Math.sqrt(Math.max(0, ex * ex * a + 2 * ex * ey * b + ey * ey * c));
    };
    // best polygon
    const pen = new Float64Array(n + 1), prev = new Int32Array(n + 1), clip0 = new Int32Array(n), clip1 = new Int32Array(n + 1), seg0 = new Int32Array(n + 1), seg1 = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) { let c = mod(lon[mod(i - 1, n)] - 1, n); if (c === i) c = mod(i + 1, n); clip0[i] = c < i ? n : c; }
    j = 1;
    for (let i = 0; i < n; i++) while (j <= clip0[i]) { clip1[j] = i; j++; }
    let i2 = 0; j = 0;
    for (; i2 < n; j++) { seg0[j] = i2; i2 = clip0[i2]; }
    seg0[j] = n; const m = j;
    i2 = n;
    for (j = m; j > 0; j--) { seg1[j] = i2; i2 = clip1[i2]; }
    seg1[0] = 0; pen[0] = 0;
    for (j = 1; j <= m; j++) for (let i = seg1[j]; i <= seg0[j]; i++) {
      let best = -1;
      for (let kq = seg0[j - 1]; kq >= clip1[i]; kq--) { const tp = penalty3(kq, i) + pen[kq]; if (best < 0 || tp < best) { prev[i] = kq; best = tp; } }
      pen[i] = best;
    }
    const po = new Int32Array(m);
    for (let i = n, jj = m - 1; i > 0; jj--) { i = prev[i]; po[jj] = i; }
    if (m < 3) return null;
    // adjust vertices
    const ctr = [], dir = [], q = [];
    const pointslope = (i, j) => {
      let r = 0;
      while (j >= n) { j -= n; r++; } while (i >= n) { i -= n; r--; } while (j < 0) { j += n; r--; } while (i < 0) { i += n; r++; }
      const x = SX[j + 1] - SX[i] + r * SX[n], y = SY[j + 1] - SY[i] + r * SY[n], x2 = SX2[j + 1] - SX2[i] + r * SX2[n], xy = SXY[j + 1] - SXY[i] + r * SXY[n], y2 = SY2[j + 1] - SY2[i] + r * SY2[n];
      const kk = j + 1 - i + r * n;
      let a = (x2 - x * x / kk) / kk, b = (xy - x * y / kk) / kk, c = (y2 - y * y / kk) / kk;
      const l2 = (a + c + Math.sqrt((a - c) * (a - c) + 4 * b * b)) / 2; a -= l2; c -= l2;
      let dx = 0, dy = 0, l;
      if (Math.abs(a) >= Math.abs(c)) { l = Math.sqrt(a * a + b * b); if (l) { dx = -b / l; dy = a / l; } }
      else { l = Math.sqrt(c * c + b * b); if (l) { dx = -c / l; dy = b / l; } }
      return [[x / kk, y / kk], [dx, dy]];
    };
    for (let i = 0; i < m; i++) {
      let jj = po[mod(i + 1, m)]; jj = mod(jj - po[i], n) + po[i];
      const [cc, dd] = pointslope(po[i], jj); ctr.push(cc); dir.push(dd);
      const Q = new Float64Array(9), d = dd[0] * dd[0] + dd[1] * dd[1];
      if (d) { const v = [dd[1], -dd[0], 0]; v[2] = -v[1] * cc[1] - v[0] * cc[0]; for (let l = 0; l < 3; l++) for (let kq = 0; kq < 3; kq++) Q[l * 3 + kq] = v[l] * v[kq] / d; }
      q.push(Q);
    }
    const quadform = (Q, x, y) => { const v = [x, y, 1]; let s = 0; for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) s += v[a] * Q[a * 3 + b] * v[b]; return s; };
    const vert = [];
    for (let i = 0; i < m; i++) {
      const Q = new Float64Array(9), jq = mod(i - 1, m);
      for (let t = 0; t < 9; t++) Q[t] = q[jq][t] + q[i][t];
      const sx = xs[po[i]] - x0, sy = ys[po[i]] - y0;
      let wx = 0, wy = 0;
      for (let guard = 0; guard < 4; guard++) {
        const det = Q[0] * Q[4] - Q[1] * Q[3];
        if (det !== 0) { wx = (-Q[2] * Q[4] + Q[5] * Q[1]) / det; wy = (Q[2] * Q[3] - Q[5] * Q[0]) / det; break; }
        let v0, v1;
        if (Q[0] > Q[4]) { v0 = -Q[1]; v1 = Q[0]; } else if (Q[4]) { v0 = -Q[4]; v1 = Q[3]; } else { v0 = 1; v1 = 0; }
        const d = v0 * v0 + v1 * v1, v = [v0, v1, -v1 * sy - v0 * sx];
        for (let l = 0; l < 3; l++) for (let kq = 0; kq < 3; kq++) Q[l * 3 + kq] += v[l] * v[kq] / d;
      }
      if (Math.abs(wx - sx) <= 0.5 && Math.abs(wy - sy) <= 0.5) { vert.push([wx + x0, wy + y0]); continue; }
      let min = quadform(Q, sx, sy), xmin = sx, ymin = sy;
      if (Q[0] !== 0) for (let z = 0; z < 2; z++) { const yy = sy - 0.5 + z, xx = -(Q[1] * yy + Q[2]) / Q[0]; const c = quadform(Q, xx, yy); if (Math.abs(xx - sx) <= 0.5 && c < min) { min = c; xmin = xx; ymin = yy; } }
      if (Q[4] !== 0) for (let z = 0; z < 2; z++) { const xx = sx - 0.5 + z, yy = -(Q[3] * xx + Q[5]) / Q[4]; const c = quadform(Q, xx, yy); if (Math.abs(yy - sy) <= 0.5 && c < min) { min = c; xmin = xx; ymin = yy; } }
      for (let l = 0; l < 2; l++) for (let kq = 0; kq < 2; kq++) { const xx = sx - 0.5 + l, yy = sy - 0.5 + kq, c = quadform(Q, xx, yy); if (c < min) { min = c; xmin = xx; ymin = yy; } }
      vert.push([xmin + x0, ymin + y0]);
    }
    // design regularisation on the polygon: drop near-collinear vertices (1px jogs in a stem), then square up near-axis edges
    let V = vert.map(p => [p[0], p[1]]);
    const defl = (A, B, C) => { const u = norm([B[0] - A[0], B[1] - A[1]]), w = norm([C[0] - B[0], C[1] - B[1]]); return Math.acos(Math.max(-1, Math.min(1, u[0] * w[0] + u[1] * w[1]))); };
    if (minDefl > 0) {
      for (let pass = 0; pass < 3 && V.length > 3; pass++) {
        let best = -1, bd = minDefl;
        for (let i = 0; i < V.length; i++) {
          const A = V[(i - 1 + V.length) % V.length], B = V[i], C = V[(i + 1) % V.length];
          const d = defl(A, B, C);
          if (!(d < bd && Math.hypot(B[0] - A[0], B[1] - A[1]) + Math.hypot(C[0] - B[0], C[1] - B[1]) > 6)) continue;
          // only a wiggle (turns back the other way) or a vertex that hardly sits off the chord; never flatten a steady curve
          const Lc = Math.hypot(C[0] - A[0], C[1] - A[1]) || 1;
          const dev = Math.abs((B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0])) / Lc;
          const tn = (P, Q, R) => sign((Q[0] - P[0]) * (R[1] - Q[1]) - (Q[1] - P[1]) * (R[0] - Q[0]));
          const L = V.length, Z = V[(i - 2 + L) % L], D = V[(i + 2) % L];
          const t0 = tn(A, B, C), wiggle = t0 !== 0 && (tn(Z, A, B) === -t0 || tn(B, C, D) === -t0);
          if (dev < 0.35 || (wiggle && dev < 0.75)) { bd = d; best = i; }
        }
        if (best < 0) break;
        V.splice(best, 1); pass--; if (V.length <= 3) break;
        if (pass > 400) break;
      }
    }
    if (snapDeg > 0) {
      const lim = Math.tan(snapDeg * Math.PI / 180), M = V.length;
      const tx = new Array(M).fill(null), ty = new Array(M).fill(null);
      const cornerAt = i => defl(V[(i - 1 + M) % M], V[i], V[(i + 1) % M]) >= 25 * Math.PI / 180;
      for (let i = 0; i < M; i++) {
        const A = V[i], B = V[(i + 1) % M], dx = B[0] - A[0], dy = B[1] - A[1];
        if (Math.hypot(dx, dy) < 3) continue;
        if (!cornerAt(i) && !cornerAt((i + 1) % M)) continue; // part of a flowing curve: leave its angle alone
        if (dx !== 0 && Math.abs(dy / dx) <= lim) { const y = (A[1] + B[1]) / 2; ty[i] = ty[i] == null ? y : (ty[i] + y) / 2; ty[(i + 1) % M] = ty[(i + 1) % M] == null ? y : (ty[(i + 1) % M] + y) / 2; }
        else if (dy !== 0 && Math.abs(dx / dy) <= lim) { const x = (A[0] + B[0]) / 2; tx[i] = tx[i] == null ? x : (tx[i] + x) / 2; tx[(i + 1) % M] = tx[(i + 1) % M] == null ? x : (tx[(i + 1) % M] + x) / 2; }
      }
      V = V.map((p, i) => [tx[i] != null ? tx[i] : p[0], ty[i] != null ? ty[i] : p[1]]);
    }
    // smooth: each vertex is a sharp corner or a rounded bend; a bend only eats into long edges up to rmax,
    // so long edges stay genuinely straight (flat stems, crisp terminals) and curves stay local
    const M = V.length, segs = [];
    const lerp = (t, a, b) => [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    const treat = [];
    // pre-pass: which vertices bend (vs corner) and which way, so runs of same-direction bends stay one flowing curve
    const kind = [];
    for (let jv = 0; jv < M; jv++) {
      const P0 = V[(jv - 1 + M) % M], P1 = V[jv], P2 = V[(jv + 1) % M];
      const rx = -sign(P2[1] - P0[1]), ry = sign(P2[0] - P0[0]);
      const denom = ry * (P2[0] - P0[0]) - rx * (P2[1] - P0[1]);
      let al = 4 / 3;
      if (denom !== 0) { const dd = Math.abs(((P1[0] - P0[0]) * (P2[1] - P0[1]) - (P2[0] - P0[0]) * (P1[1] - P0[1])) / denom); al = (dd > 1 ? 1 - 1 / dd : 0) / 0.75; }
      kind.push({ bend: al < alphamax, turn: sign((P1[0] - P0[0]) * (P2[1] - P1[1]) - (P1[1] - P0[1]) * (P2[0] - P1[0])) });
    }
    const flowing = (a, b, L) => kind[a].bend && kind[b].bend && kind[a].turn === kind[b].turn && L < 12 * rmax / 2.5;
    for (let jv = 0; jv < M; jv++) {
      const P0 = V[(jv - 1 + M) % M], P1 = V[jv], P2 = V[(jv + 1) % M];
      const rx = -sign(P2[1] - P0[1]), ry = sign(P2[0] - P0[0]);
      const denom = ry * (P2[0] - P0[0]) - rx * (P2[1] - P0[1]);
      let alpha;
      if (denom !== 0) { const dd = Math.abs(((P1[0] - P0[0]) * (P2[1] - P0[1]) - (P2[0] - P0[0]) * (P1[1] - P0[1])) / denom); alpha = (dd > 1 ? 1 - 1 / dd : 0) / 0.75; }
      else alpha = 4 / 3;
      if (alpha >= alphamax) { treat.push({ corner: true, P: P1 }); continue; }
      alpha = Math.max(0.55, Math.min(1, alpha));
      const L0 = Math.hypot(P1[0] - P0[0], P1[1] - P0[1]), L2 = Math.hypot(P2[0] - P1[0], P2[1] - P1[1]);
      const dA = flowing((jv - 1 + M) % M, jv, L0) ? L0 / 2 : Math.min(L0 / 2, rmax), dB = flowing(jv, (jv + 1) % M, L2) ? L2 / 2 : Math.min(L2 / 2, rmax);
      const A = lerp(dA / (L0 || 1), P1, P0), B = lerp(dB / (L2 || 1), P1, P2);
      const c1 = lerp(1 - alpha, P1, A), c2 = lerp(1 - alpha, P1, B);
      treat.push({ corner: false, A, B, c1, c2 });
    }
    const startOf = t => (t.corner ? t.P : t.A), endOf = t => (t.corner ? t.P : t.B);
    let cur = endOf(treat[M - 1]);
    for (let jv = 0; jv < M; jv++) {
      const t = treat[jv], st = startOf(t);
      if (Math.hypot(st[0] - cur[0], st[1] - cur[1]) > 1e-6) segs.push([cur[0], cur[1], st[0], st[1]]);
      if (!t.corner) segs.push([t.A[0], t.A[1], t.c1[0], t.c1[1], t.c2[0], t.c2[1], t.B[0], t.B[1]]);
      cur = endOf(t);
    }
    return mergeSegs(segs);
  }
  // join consecutive straight segments that are collinear, and pairs of gentle curves that one cubic can carry
  function mergeSegs(segs) {
    const out = [];
    for (const s of segs) {
      const last = out[out.length - 1];
      if (last && s.length === 4 && last.length === 4) {
        const ax = last[2] - last[0], ay = last[3] - last[1], bx = s[2] - s[0], by = s[3] - s[1];
        const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
        if (la > 1e-9 && lb > 1e-9 && Math.abs(ax * by - ay * bx) / (la * lb) < 0.02 && ax * bx + ay * by > 0) { last[2] = s[2]; last[3] = s[3]; continue; }
      }
      out.push(s.slice());
    }
    return out;
  }

  // ---------- post-processing: node reduction and edge regularisation ----------
  const segEnd = s => [s[s.length - 2], s[s.length - 1]];
  function tanStart(s) {
    if (s.length === 4) return norm([s[2] - s[0], s[3] - s[1]]);
    let v = [s[2] - s[0], s[3] - s[1]]; if (Math.hypot(v[0], v[1]) < 1e-6) v = [s[4] - s[0], s[5] - s[1]]; if (Math.hypot(v[0], v[1]) < 1e-6) v = [s[6] - s[0], s[7] - s[1]];
    return norm(v);
  }
  function tanEnd(s) { // direction of travel at the end
    if (s.length === 4) return norm([s[2] - s[0], s[3] - s[1]]);
    let v = [s[6] - s[4], s[7] - s[5]]; if (Math.hypot(v[0], v[1]) < 1e-6) v = [s[6] - s[2], s[7] - s[3]]; if (Math.hypot(v[0], v[1]) < 1e-6) v = [s[6] - s[0], s[7] - s[1]];
    return norm(v);
  }
  function sampleSeg(s, k, out, skipFirst) {
    for (let q = skipFirst ? 1 : 0; q <= k; q++) {
      const t = q / k;
      out.push(s.length === 4 ? [s[0] + (s[2] - s[0]) * t, s[1] + (s[3] - s[1]) * t] : bezPt(s, t));
    }
  }
  // merge neighbouring segments whenever one segment can carry both within tol
  function simplifySegs(S, tol, U) {
    if (S.length < 2) return S;
    let segs = S.map(s => {
      // a cubic that barely bows is a straight edge in disguise
      if (s.length === 8 && U) {
        const dx = s[6] - s[0], dy = s[7] - s[1], L = Math.hypot(dx, dy);
        if (L >= 2 * U) {
          const d1 = Math.abs((s[2] - s[0]) * dy - (s[3] - s[1]) * dx) / L, d2 = Math.abs((s[4] - s[0]) * dy - (s[5] - s[1]) * dx) / L;
          if (Math.max(d1, d2) <= 0.4 * U) return [s[0], s[1], s[6], s[7]];
        }
      }
      return s.slice();
    });
    for (let pass = 0; pass < 4; pass++) {
      let changed = false;
      const out = [segs[0]];
      for (let k = 1; k < segs.length; k++) {
        const a = out[out.length - 1], b = segs[k];
        const ta = tanEnd(a), tb = tanStart(b);
        const cosJ = ta[0] * tb[0] + ta[1] * tb[1];
        let merged = null;
        if (cosJ > 0.97) { // smooth join, not a corner
          const p0 = [a[0], a[1]], p3 = segEnd(b);
          if ((a.length === 4) !== (b.length === 4)) merged = null;
          else if (a.length === 4 && b.length === 4) {
            const dx = p3[0] - p0[0], dy = p3[1] - p0[1], L = Math.hypot(dx, dy);
            if (L > 1e-6 && Math.abs((a[2] - p0[0]) * dy - (a[3] - p0[1]) * dx) / L <= Math.max(tol * 0.6, cosJ > 0.996 ? 0.55 * (U || 1) : 0)) merged = [p0[0], p0[1], p3[0], p3[1]]; // stair-stepped straight edges become one line
          } else {
            const pts = []; sampleSeg(a, 14, pts, false); sampleSeg(b, 14, pts, true);
            const t1 = tanStart(a), te = tanEnd(b), t2 = [-te[0], -te[1]];
            let u = chordParam(pts, 0, pts.length - 1), bz = genBez(pts, 0, pts.length - 1, u, t1, t2), [e] = maxErr(pts, 0, pts.length - 1, bz, u);
            for (let it = 0; it < 6 && e > tol * tol; it++) { u = reparam(pts, 0, pts.length - 1, u, bz); bz = genBez(pts, 0, pts.length - 1, u, t1, t2);[e] = maxErr(pts, 0, pts.length - 1, bz, u); }
            if (e <= tol * tol) merged = bz;
          }
        }
        if (merged) { out[out.length - 1] = merged; changed = true; } else out.push(b);
      }
      segs = out;
      if (!changed) break;
    }
    return segs;
  }
  // snap nearly horizontal/vertical straight edges to exact, keeping neighbours attached and joins smooth
  function regularizeSegs(S, closed, maxDeg, minLen, flatTol) {
    const n = S.length; if (!n || maxDeg <= 0) return S;
    const segs = S.map(s => s.slice());
    // nearly straight curves become lines first
    for (let k = 0; k < n; k++) {
      const s = segs[k]; if (s.length !== 8) continue;
      const dx = s[6] - s[0], dy = s[7] - s[1], L = Math.hypot(dx, dy); if (L < minLen) continue;
      const d1 = Math.abs((s[2] - s[0]) * dy - (s[3] - s[1]) * dx) / L, d2 = Math.abs((s[4] - s[0]) * dy - (s[5] - s[1]) * dx) / L;
      if (d1 <= flatTol && d2 <= flatTol) segs[k] = [s[0], s[1], s[6], s[7]];
    }
    const lim = Math.tan(maxDeg * Math.PI / 180);
    const moveStart = (k, ax, v) => { // set coordinate ax (0=x,1=y) of seg k's start, and the previous seg's end
      const s = segs[k], d = v - s[ax]; s[ax] = v; if (s.length === 8) s[2 + ax] += d;
      const pk = k > 0 ? k - 1 : (closed ? n - 1 : -1); if (pk < 0) return;
      const p = segs[pk], e = p.length - 2 + ax; p[e] = v; if (p.length === 8) p[4 + ax] += d;
    };
    const moveEnd = (k, ax, v) => {
      const s = segs[k], e = s.length - 2 + ax, d = v - s[e]; s[e] = v; if (s.length === 8) s[4 + ax] += d;
      const nk = k < n - 1 ? k + 1 : (closed ? 0 : -1); if (nk < 0) return;
      const q = segs[nk]; q[ax] = v; if (q.length === 8) q[2 + ax] += d;
    };
    for (let k = 0; k < n; k++) {
      const s = segs[k]; if (s.length !== 4) continue;
      const dx = s[2] - s[0], dy = s[3] - s[1];
      if (Math.hypot(dx, dy) < minLen) continue;
      const sFix = !closed && k === 0, eFix = !closed && k === n - 1;
      if (sFix && eFix) continue;
      // only square up real straight edges: at least one end must meet a corner. A line that flows smoothly into
      // curves on both sides is just the straightest stretch of a curve, and snapping it would put kinks in the curve.
      {
        const pk = k > 0 ? k - 1 : (closed ? n - 1 : -1), nk = k < n - 1 ? k + 1 : (closed ? 0 : -1);
        const dir = norm([dx, dy]), cosLim = Math.cos(25 * Math.PI / 180);
        const smoothIn = pk >= 0 && (() => { const t = tanEnd(segs[pk]); return t[0] * dir[0] + t[1] * dir[1] > cosLim; })();
        const smoothOut = nk >= 0 && (() => { const t = tanStart(segs[nk]); return t[0] * dir[0] + t[1] * dir[1] > cosLim; })();
        if ((pk < 0 || smoothIn) && (nk < 0 || smoothOut) && (pk >= 0 || nk >= 0)) continue;
      }
      let ax = -1;
      if (dx !== 0 && Math.abs(dy / dx) <= lim && dy !== 0) ax = 1;        // nearly horizontal: equalise y
      else if (dy !== 0 && Math.abs(dx / dy) <= lim && dx !== 0) ax = 0;   // nearly vertical: equalise x
      if (ax < 0) continue;
      const v = sFix ? s[ax] : eFix ? s[2 + ax] : (s[ax] + s[2 + ax]) / 2;
      moveStart(k, ax, v); moveEnd(k, ax, v);
    }
    // keep joins between a straight edge and a curve smooth
    for (let k = 0; k < n; k++) {
      const s = segs[k]; if (s.length !== 4) continue;
      const dir = norm([s[2] - s[0], s[3] - s[1]]);
      const pk = k > 0 ? k - 1 : (closed ? n - 1 : -1), nk = k < n - 1 ? k + 1 : (closed ? 0 : -1);
      if (pk >= 0 && segs[pk].length === 8) {
        const p = segs[pk], hx = p[6] - p[4], hy = p[7] - p[5], hl = Math.hypot(hx, hy);
        if (hl > 1e-6 && (hx * dir[0] + hy * dir[1]) / hl > 0.94) { p[4] = p[6] - dir[0] * hl; p[5] = p[7] - dir[1] * hl; }
      }
      if (nk >= 0 && segs[nk].length === 8) {
        const q = segs[nk], hx = q[2] - q[0], hy = q[3] - q[1], hl = Math.hypot(hx, hy);
        if (hl > 1e-6 && (hx * dir[0] + hy * dir[1]) / hl > 0.94) { q[2] = q[0] + dir[0] * hl; q[3] = q[1] + dir[1] * hl; }
      }
    }
    return segs;
  }

  // ---------- multi-candidate grading ----------
  // Each candidate is scored on: fidelity to the boundary data (both ways, beyond a noise dead-band),
  // economy (nodes per length), and calm (no extra turning - hooks, wiggles - beyond what the data itself turns).
  function samplePolyline(segs, step) {
    const out = [];
    for (const s of segs) {
      const L = s.length === 4 ? dist(s[0], s[1], s[2], s[3]) : dist(s[0], s[1], s[2], s[3]) + dist(s[2], s[3], s[4], s[5]) + dist(s[4], s[5], s[6], s[7]);
      const k = Math.max(1, Math.ceil(L / step));
      for (let q = out.length ? 1 : 0; q <= k; q++) { const t = q / k; out.push(s.length === 4 ? [s[0] + (s[2] - s[0]) * t, s[1] + (s[3] - s[1]) * t] : bezPt(s, t)); }
    }
    return out;
  }
  function makeGrid(pts, cell) {
    const g = new Map();
    pts.forEach((p, i) => { const k = Math.floor(p[0] / cell) + ',' + Math.floor(p[1] / cell); let b = g.get(k); if (!b) g.set(k, b = []); b.push(i); });
    return { g, cell, pts };
  }
  function nearestDist(G, p) {
    const cx = Math.floor(p[0] / G.cell), cy = Math.floor(p[1] / G.cell);
    let best = Infinity;
    for (let r = 1; r <= 3 && best === Infinity; r++)
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
        const b = G.g.get((cx + dx) + ',' + (cy + dy)); if (!b) continue;
        for (const i of b) { const q = G.pts[i], d2 = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2; if (d2 < best) best = d2; }
      }
    return Math.sqrt(best === Infinity ? 1e6 : best);
  }
  function turning(pts, closed) {
    let t = 0; const n = pts.length;
    for (let i = 1; i < n - 1 + (closed ? 1 : 0); i++) {
      const a = pts[i - 1], b = pts[i % n], c = pts[(i + 1) % n];
      const ux = b[0] - a[0], uy = b[1] - a[1], vx = c[0] - b[0], vy = c[1] - b[1];
      const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy); if (lu < 1e-6 || lv < 1e-6) continue;
      t += Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv))));
    }
    return t;
  }
  function resampleBy(pts, step) {
    const out = [pts[0]]; let acc = 0;
    for (let i = 1; i < pts.length; i++) { acc += dist(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]); if (acc >= step) { out.push(pts[i]); acc = 0; } }
    if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
    return out;
  }
  function gradeCandidates(cands, P, closed, U, noise, rough) {
    const dataG = makeGrid(P, 2 * U);
    const ref = resampleBy(smoothPts(P, closed, 4), 2 * U);
    const refTurn = turning(ref, closed);
    let len = 0; for (let i = 1; i < P.length; i++) len += dist(P[i - 1][0], P[i - 1][1], P[i][0], P[i][1]);
    const db = (0.35 + 0.5 * (rough || 0)) * U; // deviations inside the image's own edge noise are not errors
    let best = 0, bestS = Infinity;
    cands.forEach((segs, ci) => {
      const S = samplePolyline(segs, 0.5 * U), sG = makeGrid(S, 2 * U);
      let sum = 0, n = 0, worst = 0;
      for (const p of P) { const e = Math.max(0, nearestDist(sG, p) - db); sum += e * e; n++; if (e > worst) worst = e; }
      for (let i = 0; i < S.length; i += 2) { const e = Math.max(0, nearestDist(dataG, S[i]) - db); sum += e * e; n++; if (e > worst) worst = e; }
      const fid = Math.sqrt(sum / Math.max(1, n)) / U + 0.25 * worst / U;
      const nodes = segs.length / Math.max(1, len / (20 * U));
      const extraTurn = Math.max(0, turning(resampleBy(S, 2 * U), closed) - refTurn);
      const score = fid * 4 + nodes * 0.08 + extraTurn * 0.6;
      if (score < bestS) { bestS = score; best = ci; }
    });
    return cands[best];
  }

  // runs of short lines and slight bends that together hug one straight chord become a single line
  function consolidateLines(S, U, rough) {
    const tolC = (0.5 + 0.4 * (rough || 0)) * U;
    const n = S.length; if (n < 3) return S;
    const segLen = s => s.length === 4 ? dist(s[0], s[1], s[2], s[3]) : dist(s[0], s[1], s[6], s[7]);
    const out = []; let i = 0;
    while (i < n) {
      let best = -1;
      let lineLen = 0, total = 0, pos = 0, neg = 0;
      for (let j = i; j < n; j++) {
        if (j > i) {
          const a = tanEnd(S[j - 1]), b = tanStart(S[j]);
          if (a[0] * b[0] + a[1] * b[1] < Math.cos(12 * Math.PI / 180)) break;
          const t = Math.asin(Math.max(-1, Math.min(1, a[0] * b[1] - a[1] * b[0])));
          if (t > 0) pos += t; else neg -= t;
        }
        // a steady bend one way is an arc, not a stair-stepped straight edge: leave arcs alone
        if (Math.min(pos, neg) < 0.3 * Math.max(pos, neg) && pos + neg > 0.07) break;
        const L = segLen(S[j]); total += L; if (S[j].length === 4) lineLen += L;
        if (j - i < 1) continue;
        const p0 = [S[i][0], S[i][1]], p1 = segEnd(S[j]);
        const dx = p1[0] - p0[0], dy = p1[1] - p0[1], C = Math.hypot(dx, dy);
        if (C < 12 * U || lineLen < 0.3 * total) continue;
        const pts = samplePolyline(S.slice(i, j + 1), 0.5 * U);
        let mx = 0; for (const p of pts) { const d = Math.abs((p[0] - p0[0]) * dy - (p[1] - p0[1]) * dx) / C; if (d > mx) mx = d; }
        if (mx <= tolC) best = j; else if (mx > 2.2 * tolC) break;
      }
      if (best > i) { out.push([S[i][0], S[i][1], segEnd(S[best])[0], segEnd(S[best])[1]]); i = best + 1; }
      else { out.push(S[i]); i++; }
    }
    return out;
  }

  // ---------- main ----------
  async function trace(img, opts, progress) {
    const o = Object.assign({ colors: 0, separation: 12, minArea: 6, smoothness: 1, cornerAngle: 32, flatThr: 9 }, opts || {});
    const W = img.width, H = img.height, N = W * H, d = img.data;
    const say = async m => { if (o.isCancelled && o.isCancelled()) throw Object.assign(new Error('cancelled'), { cancelled: true }); if (progress) progress(m); await tick(); };

    await say('Reading colors');
    const lab = new Float32Array(N * 3), opaque = new Uint8Array(N);
    let anyT = false;
    for (let i = 0; i < N; i++) {
      if (d[i * 4 + 3] >= 128) { opaque[i] = 1; rgb2lab(d[i * 4], d[i * 4 + 1], d[i * 4 + 2], lab, i * 3); } else anyT = true;
    }
    const flat = new Uint8Array(N), T2 = o.flatThr * o.flatThr, FK = Math.max(1, Math.round((o.unit || 1) * 0.67));
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x; if (!opaque[i]) continue;
      let m = 0, ok = true;
      const nb = [x >= FK ? i - FK : -1, x < W - FK ? i + FK : -1, y >= FK ? i - FK * W : -1, y < H - FK ? i + FK * W : -1,
        x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1];
      for (const j of nb) {
        if (j < 0) continue; if (!opaque[j]) { ok = false; break; }
        const dl = lab[i * 3] - lab[j * 3], da = lab[i * 3 + 1] - lab[j * 3 + 1], db = lab[i * 3 + 2] - lab[j * 3 + 2];
        const dd = dl * dl + da * da + db * db; if (dd > m) m = dd;
      }
      flat[i] = ok && m < T2 ? 1 : 0;
    }

    await say('Finding palette');
    const pal = buildPalette(d, lab, flat, opaque, N, o);
    // line colours: a thin outline (e.g. a black keyline 2-4 px wide) never has "flat" pixels, so the palette misses it
    // and its pixels get split between whatever colours are nearest. Find the cores of thin dark/light lines whose colour
    // is far from every palette entry and, if there are enough of them, give that colour its own palette entry.
    if (!o.colors) {
      const U = o.unit || 1, reach = [2, 3, 4].map(r => Math.max(r, Math.round(r * U)));
      const ridge = [];
      const Lc = i => lab[i * 3];
      for (let y = 4 * U; y < H - 4 * U; y++) for (let x = 4 * U; x < W - 4 * U; x++) {
        const i = y * W + x; if (!opaque[i]) continue;
        const v = Lc(i); let isR = false;
        for (const r of reach) {
          for (const st of [1, W]) {
            const a = i - r * st, b = i + r * st; if (!opaque[a] || !opaque[b]) continue;
            const sameSides = (lab[a * 3] - lab[b * 3]) ** 2 + (lab[a * 3 + 1] - lab[b * 3 + 1]) ** 2 + (lab[a * 3 + 2] - lab[b * 3 + 2]) ** 2 < 15 * 15; // a line drawn on one background
            if (sameSides && ((Lc(a) - v > 18 && Lc(b) - v > 18) || (v - Lc(a) > 18 && v - Lc(b) > 18))) isR = true;
          }
          if (isR) break;
        }
        if (!isR) continue;
        let bd = 1e9; for (const c of pal) { const dd = (c.L - v) ** 2 + (c.A - lab[i * 3 + 1]) ** 2 + (c.B - lab[i * 3 + 2]) ** 2; if (dd < bd) bd = dd; }
        if (bd >= 22 * 22) ridge.push(i);
      }
      // cluster the ridge colours
      const cl = [];
      for (const i of ridge) {
        const L = lab[i * 3], A = lab[i * 3 + 1], B = lab[i * 3 + 2];
        let best = null, bd = 15 * 15;
        for (const c of cl) { const dd = (c.L - L) ** 2 + (c.A - A) ** 2 + (c.B - B) ** 2; if (dd < bd) { bd = dd; best = c; } }
        if (!best) { best = { L, A, B, n: 0, sL: 0, sA: 0, sB: 0, r: 0, g: 0, b: 0, px: [] }; cl.push(best); }
        best.n++; best.sL += L; best.sA += A; best.sB += B; best.r += d[i * 4]; best.g += d[i * 4 + 1]; best.b += d[i * 4 + 2]; best.px.push(i);
        best.L = best.sL / best.n; best.A = best.sA / best.n; best.B = best.sB / best.n;
      }
      let opN = 0; for (let i = 0; i < N; i++) if (opaque[i]) opN++;
      const need = Math.max(100 * U, opN * 0.00002);
      cl.sort((a, b) => b.n - a.n);
      for (const c of cl.slice(0, 3)) {
        if (c.n < need || c.n < 0.6 * cl[0].n) break;
        let bd = 1e9; for (const p of pal) { const dd = (c.L - p.L) ** 2 + (c.A - p.A) ** 2 + (c.B - p.B) ** 2; if (dd < bd) bd = dd; }
        if (bd < 20 * 20) continue;
        if (c.L > 30 || Math.hypot(c.A, c.B) > 25) continue; // keylines are dark and near-neutral; anything else is a tint
        // a colour that is just a mix of two palette colours (anti-aliasing of a thin shape) is not a line colour
        const Mc = [c.r / c.n, c.g / c.n, c.b / c.n]; let mixR = 1e9;
        for (let p1 = 0; p1 < pal.length; p1++) for (let p2 = p1 + 1; p2 < pal.length; p2++) {
          const A = [pal[p1].r, pal[p1].g, pal[p1].b], B = [pal[p2].r, pal[p2].g, pal[p2].b], vx = B[0] - A[0], vy = B[1] - A[1], vz = B[2] - A[2], vv = vx * vx + vy * vy + vz * vz; if (vv < 1) continue;
          const t = Math.max(0, Math.min(1, ((Mc[0] - A[0]) * vx + (Mc[1] - A[1]) * vy + (Mc[2] - A[2]) * vz) / vv));
          mixR = Math.min(mixR, Math.hypot(Mc[0] - A[0] - t * vx, Mc[1] - A[1] - t * vy, Mc[2] - A[2] - t * vz));
        }
        if (mixR < 30) continue;
        pal.push({ r: c.r / c.n, g: c.g / c.n, b: c.b / c.n, L: c.L, A: c.A, B: c.B, w: c.n });
        for (const i of c.px) flat[i] = 1; // line cores seed this colour for the context classification
      }
    }
    const K = pal.length, TL = K; // TL = transparent label
    const PR = pal.map(c => [c.r, c.g, c.b]);

    await say('Classifying pixels');
    const lbl = new Int32Array(N).fill(-2);
    const nearest = i => {
      const L = lab[i * 3], A = lab[i * 3 + 1], B = lab[i * 3 + 2];
      let best = 0, bd = 1e18;
      for (let j = 0; j < K; j++) { const c = pal[j], dd = (c.L - L) ** 2 + (c.A - A) ** 2 + (c.B - B) ** 2; if (dd < bd) { bd = dd; best = j; } }
      return best;
    };
    for (let i = 0; i < N; i++) {
      if (!opaque[i]) lbl[i] = TL; else if (flat[i]) {
        // a smooth patch that matches no palette colour well (e.g. a thin stroke washed out by JPEG) is decided from context instead
        const k = nearest(i), c = pal[k];
        const dd = (c.L - lab[i * 3]) ** 2 + (c.A - lab[i * 3 + 1]) ** 2 + (c.B - lab[i * 3 + 2]) ** 2;
        if (dd < 324) lbl[i] = k; else flat[i] = 0;
      }
    }
    const pen = 38, BR = o.blendRadius || 2;
    // distance (px, capped) from every pixel to the nearest solid patch of each colour, and to transparency
    const RF = Math.min(250, 4 * BR);
    const distTo = new Array(K + 1);
    for (let k = 0; k <= K; k++) {
      const D = new Uint8Array(N).fill(255); let any = false;
      for (let i = 0; i < N; i++) if (k === K ? !opaque[i] : (flat[i] && lbl[i] === k)) { D[i] = 0; any = true; }
      if (!any) { distTo[k] = null; continue; }
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x; let v = D[i];
        if (x > 0 && D[i - 1] + 1 < v) v = D[i - 1] + 1;
        if (y > 0 && D[i - W] + 1 < v) v = D[i - W] + 1;
        if (x > 0 && y > 0 && D[i - W - 1] + 1 < v) v = D[i - W - 1] + 1;
        if (x < W - 1 && y > 0 && D[i - W + 1] + 1 < v) v = D[i - W + 1] + 1;
        D[i] = v;
      }
      for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
        const i = y * W + x; let v = D[i];
        if (x < W - 1 && D[i + 1] + 1 < v) v = D[i + 1] + 1;
        if (y < H - 1 && D[i + W] + 1 < v) v = D[i + W] + 1;
        if (x < W - 1 && y < H - 1 && D[i + W + 1] + 1 < v) v = D[i + W + 1] + 1;
        if (x > 0 && y < H - 1 && D[i + W - 1] + 1 < v) v = D[i + W - 1] + 1;
        D[i] = v;
      }
      distTo[k] = D;
    }
    const cands = [], cpen = [];
    for (let i = 0; i < N; i++) {
      if (lbl[i] !== -2) continue;
      cands.length = 0; cpen.length = 0;
      // colours present nearby are cheap to choose; ones further away cost more; absent ones cost the full penalty
      for (let k = 0; k < K; k++) {
        const D = distTo[k]; if (!D) continue; const dk = D[i];
        if (dk <= RF) { cands.push(k); cpen.push(pen * Math.max(0, Math.min(1, (dk - BR) / (RF - BR)))); }
      }
      const nearT = distTo[K] && distTo[K][i] <= BR;
      if (nearT && cands.length) {
        // edge against transparency: colours there are matte-tinted, so only trust colours seen close by
        let bl = cands[0], bd = 1e18;
        for (let q = 0; q < cands.length; q++) { const c = pal[cands[q]], dd = (c.L - lab[i * 3]) ** 2 + (c.A - lab[i * 3 + 1]) ** 2 + (c.B - lab[i * 3 + 2]) ** 2 + cpen[q] * cpen[q] * 4; if (dd < bd) { bd = dd; bl = cands[q]; } }
        lbl[i] = bl; continue;
      }
      const nr = nearest(i);
      if (cands.indexOf(nr) < 0) { cands.push(nr); cpen.push(pen); }
      const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
      let bestL = nr, bestS = 1e18;
      for (let a = 0; a < cands.length; a++) {
        const ca = PR[cands[a]];
        const s1 = Math.hypot(r - ca[0], g - ca[1], b - ca[2]) + cpen[a];
        if (s1 < bestS) { bestS = s1; bestL = cands[a]; }
        for (let c = a + 1; c < cands.length; c++) {
          const cb = PR[cands[c]];
          const vx = cb[0] - ca[0], vy = cb[1] - ca[1], vz = cb[2] - ca[2], vv = vx * vx + vy * vy + vz * vz;
          if (vv < 1) continue;
          const t = Math.max(0, Math.min(1, ((r - ca[0]) * vx + (g - ca[1]) * vy + (b - ca[2]) * vz) / vv));
          const res = Math.hypot(r - ca[0] - t * vx, g - ca[1] - t * vy, b - ca[2] - t * vz) + 0.5 + Math.max(cpen[a], cpen[c]);
          if (res < bestS) { bestS = res; bestL = t < 0.5 ? cands[a] : cands[c]; }
        }
      }
      lbl[i] = bestL;
    }

    if (o.onLabels) o.onLabels(lbl.slice(), 'classified', pal);
    await say('Cleaning up specks');
    const palLabD = (a, b) => {
      if (a === TL || b === TL) return a === b ? 0 : 100;
      const p = pal[a], q = pal[b]; return Math.sqrt((p.L - q.L) ** 2 + (p.A - q.A) ** 2 + (p.B - q.B) ** 2);
    };
    // thin slivers whose colour is just a blend of the two shapes they separate (anti-aliasing bands)
    {
      const C0 = components(lbl, W, H), comp = C0.comp, U = o.unit || 1;
      const per = new Int32Array(C0.nc);
      for (let i = 0; i < N; i++) {
        const c = comp[i], x = i % W;
        if (x === 0 || comp[i - 1] !== c) per[c]++; if (x === W - 1 || comp[i + 1] !== c) per[c]++;
        if (i < W || comp[i - W] !== c) per[c]++; if (i >= N - W || comp[i + W] !== c) per[c]++;
      }
      const thin = new Int32Array(C0.nc).fill(-1), maps = [], sums = [];
      for (let c = 0; c < C0.nc; c++) if (C0.cLabel[c] !== TL && C0.cArea[c] < per[c] * 1.0 * U) { thin[c] = maps.length; maps.push(new Map()); }
      if (maps.length) {
        for (let i = 0; i < N; i++) {
          const c = comp[i], ti = thin[c]; if (ti < 0) continue;
          const x = i % W, mp = maps[ti];
          if (!sums[ti]) sums[ti] = [0, 0, 0, 0]; const sm = sums[ti]; sm[0] += d[i * 4]; sm[1] += d[i * 4 + 1]; sm[2] += d[i * 4 + 2]; sm[3]++;
          for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W]) {
            if (j < 0 || j >= N) continue; const cj = comp[j]; if (cj === c) continue;
            if (C0.cArea[cj] < 60 * U * U) continue; // a few stray pixels can't be one side of an anti-aliasing band
            const L = lbl[j]; mp.set(L, (mp.get(L) || 0) + 1);
          }
        }
        const pairOf = new Array(maps.length).fill(null);
        for (let c = 0; c < C0.nc; c++) {
          const ti = thin[c]; if (ti < 0) continue;
          const top = [...maps[ti].entries()].filter(e => e[0] !== C0.cLabel[c] && e[0] !== TL).sort((a, b) => b[1] - a[1]);
          if (!top.length) continue;
          const M = PR[C0.cLabel[c]];
          let bestPair = null, bestRes = 1e9;
          const cand = top.slice(0, 5).map(e => e[0]);
          for (let p1 = 0; p1 < cand.length; p1++) for (let p2 = p1 + 1; p2 < cand.length; p2++) {
            const A = PR[cand[p1]], B = PR[cand[p2]];
            const vx = B[0] - A[0], vy = B[1] - A[1], vz = B[2] - A[2], vv = vx * vx + vy * vy + vz * vz; if (vv < 1) continue;
            const t = ((M[0] - A[0]) * vx + (M[1] - A[1]) * vy + (M[2] - A[2]) * vz) / vv;
            if (t < 0.05 || t > 0.95) continue;
            const r = Math.hypot(M[0] - A[0] - t * vx, M[1] - A[1] - t * vy, M[2] - A[2] - t * vz);
            if (r < Math.max(22, 0.25 * Math.sqrt(vv)) && r < bestRes) { bestRes = r; bestPair = [cand[p1], cand[p2]]; }
          }
          if (bestPair) { pairOf[ti] = bestPair; continue; }
          // not a clean blend (e.g. a tinted edge line): fold into the closest-coloured neighbour
          let nl = -1, nd = 35;
          for (const L of cand) { const p = pal[C0.cLabel[c]], q = pal[L], dd = Math.sqrt((p.L - q.L) ** 2 + (p.A - q.A) ** 2 + (p.B - q.B) ** 2); if (dd < nd) { nd = dd; nl = L; } }
          if (nl >= 0) { pairOf[ti] = [nl, nl]; continue; }
          // a faint hairline: its pixels are a neighbour's colour washed with some palette colour X (a 1 px grey edge
          // between whites is a thin black line seen through anti-aliasing), so it belongs to X
          const sm = sums[ti]; if (!sm || !sm[3]) continue;
          const Mp = [sm[0] / sm[3], sm[1] / sm[3], sm[2] / sm[3]];
          let fx = -1, fr = 20;
          for (const A0 of cand) for (let X = 0; X < K; X++) {
            if (X === A0) continue;
            const A = PR[A0], B = PR[X], vx = B[0] - A[0], vy = B[1] - A[1], vz = B[2] - A[2], vv = vx * vx + vy * vy + vz * vz; if (vv < 900) continue;
            const t = ((Mp[0] - A[0]) * vx + (Mp[1] - A[1]) * vy + (Mp[2] - A[2]) * vz) / vv;
            if (t < 0.3 || t > 1.1) continue;
            const r = Math.hypot(Mp[0] - A[0] - t * vx, Mp[1] - A[1] - t * vy, Mp[2] - A[2] - t * vz);
            if (r < fr) { fr = r; fx = X; }
          }
          if (fx >= 0 && fx !== C0.cLabel[c]) pairOf[ti] = [fx, fx];
        }
        for (let i = 0; i < N; i++) {
          const ti = thin[comp[i]]; if (ti < 0 || !pairOf[ti]) continue;
          const [a, b] = pairOf[ti]; if (a === b) { lbl[i] = a; continue; }
          const A = PR[a], B = PR[b];
          const vx = B[0] - A[0], vy = B[1] - A[1], vz = B[2] - A[2], vv = vx * vx + vy * vy + vz * vz;
          const t = ((d[i * 4] - A[0]) * vx + (d[i * 4 + 1] - A[1]) * vy + (d[i * 4 + 2] - A[2]) * vz) / vv;
          lbl[i] = t < 0.5 ? a : b;
        }
      }
    }
    // foreign specks: a small patch whose colour has no real presence nearby (e.g. the tinted tip of a highlight that
    // happens to match the grey of a far-away ball) is folded into the neighbour colours that explain its pixels.
    {
      const U = o.unit || 1, A_s = 60 * U * U, A_big = 120 * U * U, Rr = Math.min(250, Math.round(15 * U));
      const C1 = components(lbl, W, H), comp = C1.comp, nc1 = C1.nc;
      const small = [];
      for (let c = 0; c < nc1; c++) if (C1.cArea[c] < A_s && C1.cLabel[c] !== TL) small.push(c);
      if (small.length) {
        const need = new Set(C1.cLabel.filter(L => L !== TL)), bigDist = new Map();
        for (const L of need) {
          const D = new Uint8Array(N).fill(255); let any = false;
          for (let i = 0; i < N; i++) if (lbl[i] === L && C1.cArea[comp[i]] >= A_big) { D[i] = 0; any = true; }
          if (!any) { bigDist.set(L, null); continue; }
          for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; let v = D[i]; if (x > 0 && D[i - 1] + 1 < v) v = D[i - 1] + 1; if (y > 0 && D[i - W] + 1 < v) v = D[i - W] + 1; D[i] = v; }
          for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) { const i = y * W + x; let v = D[i]; if (x < W - 1 && D[i + 1] + 1 < v) v = D[i + 1] + 1; if (y < H - 1 && D[i + W] + 1 < v) v = D[i + W] + 1; D[i] = v; }
          bigDist.set(L, D);
        }
        const isSmall = new Uint8Array(nc1); small.forEach(c => isSmall[c] = 1);
        const info = new Map(); small.forEach(c => info.set(c, { px: [], nb: new Map(), r: 0, g: 0, b: 0, near: 255 }));
        for (let i = 0; i < N; i++) {
          const c = comp[i]; if (!isSmall[c]) continue;
          const f = info.get(c), x = i % W; f.px.push(i); f.r += d[i * 4]; f.g += d[i * 4 + 1]; f.b += d[i * 4 + 2];
          const D = bigDist.get(lbl[i]); if (D && D[i] < f.near) f.near = D[i];
          for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i >= W ? i - W : -1, i < N - W ? i + W : -1]) {
            if (j < 0 || comp[j] === c || lbl[j] === TL || (C1.cArea[comp[j]] < A_s && !(bigDist.get(lbl[j]) && bigDist.get(lbl[j])[j] <= Rr))) continue; f.nb.set(lbl[j], (f.nb.get(lbl[j]) || 0) + 1); // only established neighbours can take it over
          }
        }
        const rgbD = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
        for (const c of small) {
          const f = info.get(c); if (f.near <= Rr || !f.nb.size) continue;
          const n = f.px.length, M = [f.r / n, f.g / n, f.b / n], own = rgbD(M, PR[C1.cLabel[c]]);
          const nbs = [...f.nb.keys()];
          let best = null, bestS = Infinity;
          // its own colour is far away, so a close-enough established neighbour wins even if it fits a little worse
          for (const a of nbs) { const s1 = rgbD(M, PR[a]); if (s1 < (n < 20 * U * U ? Math.min(95, own + 70) : Math.min(75, own + 30)) && s1 < bestS) { bestS = s1; best = [a, a]; } }
          for (let p = 0; p < nbs.length; p++) for (let q = p + 1; q < nbs.length; q++) {
            const A = PR[nbs[p]], B = PR[nbs[q]], vx = B[0] - A[0], vy = B[1] - A[1], vz = B[2] - A[2], vv = vx * vx + vy * vy + vz * vz; if (vv < 1) continue;
            const t = Math.max(0, Math.min(1, ((M[0] - A[0]) * vx + (M[1] - A[1]) * vy + (M[2] - A[2]) * vz) / vv));
            const r = Math.hypot(M[0] - A[0] - t * vx, M[1] - A[1] - t * vy, M[2] - A[2] - t * vz);
            if (r < Math.min(40, own) && r < bestS) { bestS = r; best = [nbs[p], nbs[q]]; }
          }
          if (!best && n < 12 * U * U) { let mb = -1; for (const [L, cnt] of f.nb) if (cnt > mb) { mb = cnt; best = [L, L]; } } // a few stray pixels: join the main neighbour
          if (!best) continue;
          const [a, b] = best;
          for (const i of f.px) {
            if (a === b) { lbl[i] = a; continue; }
            const P = [d[i * 4], d[i * 4 + 1], d[i * 4 + 2]];
            lbl[i] = rgbD(P, PR[a]) <= rgbD(P, PR[b]) ? a : b;
          }
        }
      }
    }
    // diagonal bridges: a thin taper drawn as a 1px staircase only touches itself at pixel corners, so its pieces look
    // like specks and get erased. Join a small piece to a same-colour piece it touches diagonally by filling the
    // corner pixel that best matches that colour.
    for (let pass = 0; pass < 3; pass++) {
      const U = o.unit || 1, C2 = components(lbl, W, H), comp = C2.comp; let changed = 0;
      for (let i = 0; i < N; i++) {
        const c = comp[i], L = lbl[i]; if (L === TL || C2.cArea[c] >= 60 * U * U) continue;
        const x = i % W, y = (i - x) / W;
        for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
          const j = Y * W + X; if (lbl[j] !== L || comp[j] === c) continue;
          const a = y * W + X, b = Y * W + x; if (lbl[a] === L || lbl[b] === L || lbl[a] === TL || lbl[b] === TL) continue;
          const P = PR[L], da = Math.hypot(d[a * 4] - P[0], d[a * 4 + 1] - P[1], d[a * 4 + 2] - P[2]), db = Math.hypot(d[b * 4] - P[0], d[b * 4 + 1] - P[1], d[b * 4 + 2] - P[2]);
          lbl[da <= db ? a : b] = L; changed++;
        }
      }
      if (!changed) break;
    }
    let C;
    for (let iter = 0; iter < 6; iter++) {
      C = components(lbl, W, H);
      if (o.minArea <= 1) break;
      const small = new Int32Array(C.nc).fill(-1); let ns = 0;
      const maps = [];
      // hairline fragments (≤ ~1.6 px wide, a few px long, e.g. the broken-off tip of a taper) count as specks too
      const U = o.unit || 1, bx0 = new Int32Array(C.nc).fill(1e9), bx1 = new Int32Array(C.nc).fill(-1), by0 = new Int32Array(C.nc).fill(1e9), by1 = new Int32Array(C.nc).fill(-1);
      for (let i = 0; i < N; i++) { const c = C.comp[i]; if (C.cArea[c] >= 16 * U * U) continue; const x = i % W, y = (i - x) / W; if (x < bx0[c]) bx0[c] = x; if (x > bx1[c]) bx1[c] = x; if (y < by0[c]) by0[c] = y; if (y > by1[c]) by1[c] = y; }
      const hair = c => C.cArea[c] < 16 * U * U && C.cLabel[c] !== TL && C.cArea[c] <= 1.6 * U * Math.hypot(bx1[c] - bx0[c] + 1, by1[c] - by0[c] + 1);
      for (let c = 0; c < C.nc; c++) if ((C.cArea[c] < o.minArea || hair(c)) && C.nc > 1) { small[c] = ns++; maps.push(new Map()); }
      if (!ns) break;
      const comp = C.comp;
      for (let i = 0; i < N; i++) {
        const c = comp[i], si = small[c]; if (si < 0) continue;
        const x = i % W, mp = maps[si];
        if (x > 0 && comp[i - 1] !== c) mp.set(comp[i - 1], (mp.get(comp[i - 1]) || 0) + 1);
        if (x < W - 1 && comp[i + 1] !== c) mp.set(comp[i + 1], (mp.get(comp[i + 1]) || 0) + 1);
        if (i >= W && comp[i - W] !== c) mp.set(comp[i - W], (mp.get(comp[i - W]) || 0) + 1);
        if (i < N - W && comp[i + W] !== c) mp.set(comp[i + W], (mp.get(comp[i + W]) || 0) + 1);
      }
      const newL = new Int32Array(C.nc).fill(-1);
      for (let c = 0; c < C.nc; c++) {
        const si = small[c]; if (si < 0) continue;
        let best = -1, bs = -1;
        for (const [nc, cnt] of maps[si]) {
          const sc = cnt / (1 + palLabD(C.cLabel[c], C.cLabel[nc]) / 25) * (small[nc] >= 0 ? 0.6 : 1) * (1 + Math.min(C.cArea[nc], 400) / 400);
          if (sc > bs) { bs = sc; best = nc; }
        }
        if (best >= 0) newL[c] = C.cLabel[best];
      }
      let changed = false;
      for (let i = 0; i < N; i++) { const nl = newL[comp[i]]; if (nl >= 0 && nl !== lbl[i]) { lbl[i] = nl; changed = true; } }
      if (!changed) break;
    }
    if (o.onLabels) o.onLabels(lbl.slice(), 'final', pal);
    const comp = C.comp, nc = C.nc, cLabel = C.cLabel;

    await say('Tracing boundaries');
    const W1 = W + 1, NH = (H + 1) * W;
    const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
    const px = (x, y) => (x < 0 || y < 0 || x >= W || y >= H) ? -1 : comp[y * W + x];
    const rightOf = (x, y, dd) => dd === 0 ? px(x, y) : dd === 1 ? px(x - 1, y) : dd === 2 ? px(x - 1, y - 1) : px(x, y - 1);
    const leftOf = (x, y, dd) => dd === 0 ? px(x, y - 1) : dd === 1 ? px(x, y) : dd === 2 ? px(x - 1, y) : px(x - 1, y - 1);
    const valid = (x, y, dd) => { const nx = x + DX[dd], ny = y + DY[dd]; return nx >= 0 && ny >= 0 && nx <= W && ny <= H; };
    const isB = (x, y, dd) => valid(x, y, dd) && rightOf(x, y, dd) !== leftOf(x, y, dd);
    const edgeId = (x, y, dd) => dd === 0 ? y * W + x : dd === 2 ? y * W + x - 1 : dd === 1 ? NH + y * W1 + x : NH + (y - 1) * W1 + x;
    const NV = (H + 1) * W1;
    const junc = new Uint8Array(NV);
    for (let y = 0; y <= H; y++) for (let x = 0; x <= W; x++) {
      let deg = 0; for (let dd = 0; dd < 4; dd++) if (isB(x, y, dd)) deg++;
      if (deg >= 3) junc[y * W1 + x] = 1;
    }
    junc[0] = junc[W] = junc[H * W1] = junc[H * W1 + W] = 1;
    const edgeChain = new Int32Array(NH + H * W1).fill(-1);
    const chains = [];
    const walk = (sx, sy, d0, closed) => {
      const cid = chains.length, xs = [sx], ys = [sy], mv = [];
      let x = sx, y = sy, dd = d0;
      const right = rightOf(x, y, dd), left = leftOf(x, y, dd);
      const firstEdge = edgeId(x, y, dd);
      let lastEdge = firstEdge;
      for (let guard = 0; guard < 4 * NV; guard++) {
        const e = edgeId(x, y, dd); edgeChain[e] = cid; lastEdge = e; mv.push(dd);
        x += DX[dd]; y += DY[dd]; xs.push(x); ys.push(y);
        if (closed ? (x === sx && y === sy) : junc[y * W1 + x]) break;
        let nd = -1;
        for (const c of [(dd + 1) & 3, dd, (dd + 3) & 3]) if (isB(x, y, c)) { nd = c; break; }
        if (nd < 0) break;
        dd = nd;
      }
      chains.push({ xs, ys, mv, right, left, closed, firstEdge, lastEdge, sv: sy * W1 + sx, ev: y * W1 + x });
    };
    for (let y = 0; y <= H; y++) for (let x = 0; x <= W; x++) {
      if (!junc[y * W1 + x]) continue;
      for (let dd = 0; dd < 4; dd++) if (isB(x, y, dd) && edgeChain[edgeId(x, y, dd)] === -1) walk(x, y, dd, false);
    }
    for (let y = 0; y <= H; y++) for (let x = 0; x < W; x++) {
      const e = y * W + x;
      if (edgeChain[e] === -1 && isB(x, y, 0)) walk(x, y, 0, true);
    }

    await say('Measuring edges');
    // palette colour per component (transparent handled)
    const NRM = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    const pixOf = (x, y, dd, side) => {
      // side 0 = right pixel, 1 = left pixel; returns flat index or -1
      let X, Y;
      if (side === 0) { if (dd === 0) { X = x; Y = y; } else if (dd === 1) { X = x - 1; Y = y; } else if (dd === 2) { X = x - 1; Y = y - 1; } else { X = x; Y = y - 1; } }
      else { if (dd === 0) { X = x; Y = y - 1; } else if (dd === 1) { X = x; Y = y; } else if (dd === 2) { X = x - 1; Y = y; } else { X = x - 1; Y = y - 1; } }
      return (X < 0 || Y < 0 || X >= W || Y >= H) ? -1 : Y * W + X;
    };
    const coverOffset = (x, y, dd, cR, cL) => {
      if (cR < 0 || cL < 0) return 0;
      const iR = pixOf(x, y, dd, 0), iL = pixOf(x, y, dd, 1);
      const lR = cLabel[cR], lL = cLabel[cL];
      let alpha, beta; // alpha: fraction of L-colour inside right pixel; beta: fraction of R-colour inside left pixel
      if (lR === TL && lL === TL) return 0;
      if (lR === TL) { alpha = d[iR * 4 + 3] / 255; beta = 1 - d[iL * 4 + 3] / 255; }
      else if (lL === TL) { alpha = 1 - d[iR * 4 + 3] / 255; beta = d[iL * 4 + 3] / 255; }
      else {
        const A = PR[lR], B = PR[lL];
        const vx = B[0] - A[0], vy = B[1] - A[1], vz = B[2] - A[2], vv = vx * vx + vy * vy + vz * vz;
        if (vv < 900) return 0;
        alpha = ((d[iR * 4] - A[0]) * vx + (d[iR * 4 + 1] - A[1]) * vy + (d[iR * 4 + 2] - A[2]) * vz) / vv;
        beta = ((d[iL * 4] - B[0]) * -vx + (d[iL * 4 + 1] - B[1]) * -vy + (d[iL * 4 + 2] - B[2]) * -vz) / vv;
      }
      alpha = Math.max(0, Math.min(1, alpha)); beta = Math.max(0, Math.min(1, beta));
      return Math.max(-0.5, Math.min(0.5, beta - alpha));
    };
    const jsum = new Map();
    const chainPts = chains.map(ch => {
      const pts = []; let aaCount = 0;
      for (let k = 0; k < ch.mv.length; k++) {
        const x = ch.xs[k], y = ch.ys[k], dd = ch.mv[k];
        const off = coverOffset(x, y, dd, ch.right, ch.left);
        const mx = x + DX[dd] * 0.5 + NRM[dd][0] * off, my = y + DY[dd] * 0.5 + NRM[dd][1] * off;
        pts.push([mx, my]); if (Math.abs(off) > 0.03) aaCount++;
        if (!ch.closed && (k === 0 || k === ch.mv.length - 1)) {
          const v = k === 0 ? ch.sv : ch.ev;
          let s = jsum.get(v); if (!s) { s = [0, 0, 0]; jsum.set(v, s); }
          s[0] += NRM[dd][0] * off; s[1] += NRM[dd][1] * off; s[2]++;
          if (ch.mv.length === 1 && k === 0) { // single-edge chain: also contributes to end
            let s2 = jsum.get(ch.ev); if (!s2) { s2 = [0, 0, 0]; jsum.set(ch.ev, s2); }
            s2[0] += NRM[dd][0] * off; s2[1] += NRM[dd][1] * off; s2[2]++;
          }
        }
      }
      // hard-edged (no anti-aliasing) boundary: rebuild it from the staircase risers
      if (ch.mv.length >= 6 && aaCount < ch.mv.length * 0.4 && ch.right >= 0 && ch.left >= 0) { ch.dealiased = true; return dealias(pts, ch.mv, ch.closed); }
      return pts;
    });
    const jOver = new Map(); // junction positions moved onto the smooth outline passing through them
    const jpos = v => {
      if (jOver.has(v)) return jOver.get(v);
      const x = v % W1, y = (v - x) / W1, s = jsum.get(v);
      let ox = 0, oy = 0;
      if (s && s[2]) { ox = s[0] / s[2]; oy = s[1] / s[2]; }
      if (x === 0 || x === W) ox = 0; if (y === 0 || y === H) oy = 0;
      return [x + ox, y + oy];
    };

    await say('Fitting curves');
    // estimate how clean the edges are: anti-aliased art gives near-exact boundaries, hard-edged pixels need smoothing
    let rsum = 0, rcnt = 0;
    chainPts.forEach((P, ci) => {
      const ch = chains[ci]; if (ch.right < 0 || ch.left < 0) return;
      const st = Math.max(1, Math.floor(P.length / 200));
      for (let i = 4; i < P.length - 4; i += st) { const v = quadResid(P, i, 4); if (v >= 0) { rsum += Math.min(v, 1); rcnt++; } }
    });
    const noise = rcnt ? rsum / rcnt : 0;
    const rough = o.roughOverride != null ? o.roughOverride : Math.max(0, Math.min(1, (noise - 0.025) / 0.05)); // 0 = clean AA, 1 = aliased
    const sm = o.smoothness;
    const U = o.unit || 1;
    o.tol = (0.22 + 0.25 * rough + 0.35 * rough * (1 - rough)) * sm * U; // mid roughness = compressed AA edges: extra slack so noise is not followed
    o.lineTol = (0.2 + 0.4 * rough + 0.35 * rough * (1 - rough)) * Math.sqrt(sm) * U;
    o.sagTol = 0.06 + 0.08 * rough;
    o.smoothPasses = Math.round((1 + 5 * rough + 10 * rough * (1 - rough)) * sm * U * U);
    o.cornerPasses = Math.round((1 + rough) * U * U);
    const chainSegs = new Array(chains.length);
    let lastT = Date.now();
    const fitOne = c => {
      const ch = chains[c];
      // how far (0..1) toward the extrapolated apex the image still shows a trace of the tapering shape
      if (!o._base) o._base = { smoothPasses: o.smoothPasses, cornerPasses: o.cornerPasses, lineTol: o.lineTol, sagTol: o.sagTol };
      if (ch.dealiased) {
        // the staircase is already gone: light smoothing keeps corners crisp, generous line tolerance keeps diagonals straight
        o.smoothPasses = Math.max(1, Math.round(o.smoothness * (o.unit || 1) ** 2));
        o.cornerPasses = Math.max(1, Math.round((o.unit || 1) ** 2));
        o.lineTol = 0.6 * Math.sqrt(o.smoothness) * (o.unit || 1);
        o.sagTol = 0.14; o.cornerR = 1.8;
      } else { Object.assign(o, o._base); o.cornerR = 2.5; }
      o.tipCheck = (x0, y0, x1, y1) => {
        const L = Math.hypot(x1 - x0, y1 - y0), steps = Math.max(1, Math.ceil(L / 0.5));
        const ux = (x1 - x0) / L, uy = (y1 - y0) / L;
        const inC = px(Math.floor(x0 - ux * 1.5 * (o.unit || 1)), Math.floor(y0 - uy * 1.5 * (o.unit || 1)));
        if (inC !== ch.right && inC !== ch.left) return 0;
        const outC = inC === ch.right ? ch.left : ch.right;
        if (outC < 0) return 0;
        const la = cLabel[inC], lb = cLabel[outC];
        let ok = 0;
        const U1 = o.unit || 1;
        const cov = (X, Y) => {
          const xi = Math.floor(X), yi = Math.floor(Y);
          if (xi < 0 || yi < 0 || xi >= W || yi >= H) return 0;
          const cc = px(xi, yi); if (cc === inC) return 1;
          if (cc !== outC) return -1;
          const i4 = (yi * W + xi) * 4;
          if (la !== TL && lb !== TL) {
            const A = PR[la], B = PR[lb], vx = A[0] - B[0], vy = A[1] - B[1], vz = A[2] - B[2], vv = vx * vx + vy * vy + vz * vz;
            return Math.max(0, Math.min(1, ((d[i4] - B[0]) * vx + (d[i4 + 1] - B[1]) * vy + (d[i4 + 2] - B[2]) * vz) / (vv || 1)));
          }
          const a = d[i4 + 3] / 255; return la === TL ? 1 - a : a;
        };
        for (let q = 1; q <= steps; q++) {
          const X = x0 + (x1 - x0) * q / steps, Y = y0 + (y1 - y0) * q / steps;
          const c0 = cov(X, Y); if (c0 < 0) break;
          if (c0 < 1) {
            // the taper must show as a faint ridge: clearly tinted here, and no more tinted beside the path than on it
            if (c0 < 0.25) break;
            const cl = cov(X - uy * 1.2 * U1, Y + ux * 1.2 * U1), cr = cov(X + uy * 1.2 * U1, Y - ux * 1.2 * U1);
            if (Math.max(cl, cr) > c0 + 0.05) break;
          }
          ok = q / steps;
        }
        return ok;
      };
      let P = chainPts[c];
      if (!ch.closed) P = [jpos(ch.sv)].concat(P, [jpos(ch.ev)]);
      let pt = null;
      if (ch.closed && ch.dealiased && o.potrace !== false) {
        try { pt = potraceClosed(ch.xs.slice(0, -1), ch.ys.slice(0, -1), o.alphamax || 1.0, o.straighten || 0, (o.straighten > 0 ? 9 : 0) * Math.PI / 180, 2.5 * (o.unit || 1)); } catch (e) { pt = null; }
      }
      {
        const cands = [];
        if (pt) cands.push(pt);
        cands.push(fitChain(P, ch.closed, o));
        if ((o.passes || 1) > 1 && P.length >= 8) {
          const keys = ['tol', 'lineTol', 'sagTol', 'smoothPasses', 'cornerPasses', 'cornerAngle', 'cornerR'];
          const save = {}; keys.forEach(k => save[k] = o[k]);
          const variants = [
            v => { v.smoothPasses = v.smoothPasses * 2 + 1; v.tol *= 1.4; v.lineTol *= 1.3; },            // calmer
            v => { v.lineTol *= 1.8; v.sagTol *= 1.6; v.cornerAngle -= 6; },                              // straighter, crisper corners
            v => { v.tol *= 0.7; v.smoothPasses = Math.max(1, Math.ceil(v.smoothPasses / 2)); },          // tighter
            v => { v.lineTol *= 1.6; v.sagTol *= 1.4; v.smoothPasses = v.smoothPasses * 2 + 1; v.tol *= 1.3; v.cornerAngle += 8; }, // smooth + straight
            v => { v.lineTol *= 2.6; v.sagTol *= 2.5; v.smoothPasses = v.smoothPasses * 3 + 1; v.tol *= 1.6; v.cornerAngle -= 4; }, // bold geometric
          ].slice(0, o.passes - 1);
          for (const f of variants) {
            f(o);
            try { cands.push(fitChain(P, ch.closed, o)); } catch (e) { }
            keys.forEach(k => o[k] = save[k]);
          }
        }
        let S = cands.length > 1 ? gradeCandidates(cands, P, ch.closed, o.unit || 1, noise, rough) : cands[0];
        // design cleanup: merge segments (node reduction), then square up near-straight edges
        const U = o.unit || 1;
        S = consolidateLines(S, U, rough);
        if (o.straighten > 0) S = regularizeSegs(S, ch.closed, o.straighten, 3 * U, 0.35 * U);
        S = simplifySegs(S, Math.max(0.05, (o.reduce || 0)) * U, U);
        if (o.straighten > 0 && o.reduce > 0) S = regularizeSegs(S, ch.closed, o.straighten, 3 * U, 0.35 * U);
        return S;
      }
    };
    for (let c = 0; c < chains.length; c++) {
      chainSegs[c] = fitOne(c);
      if (Date.now() - lastT > 60) { await say('Fitting curves ' + Math.round(100 * c / chains.length) + '%'); lastT = Date.now(); }
    }
    // ---- smooth junctions: where three edges meet and two of them continue each other (one shape's outline running
    // past the point where a third colour starts or ends), give them one shared tangent so the outline flows through
    // without a bump, and let a tapering third edge arrive along that same tangent ----
    const smoothJunctions = () => {
      const ends = new Map();
      chains.forEach((ch, c) => {
        if (ch.closed || !chainSegs[c] || !chainSegs[c].length) return;
        for (const atStart of [true, false]) { const v = atStart ? ch.sv : ch.ev; let L = ends.get(v); if (!L) ends.set(v, L = []); L.push({ c, atStart }); }
      });
      const cos35 = Math.cos(35 * Math.PI / 180);
      const outTan = e => { const S = chainSegs[e.c]; if (e.atStart) return tanStart(S[0]); const t = tanEnd(S[S.length - 1]); return [-t[0], -t[1]]; };
      // point the end of chain e (at the junction) along direction t (pointing away from the junction)
      const setTan = (e, t) => {
        const S = chainSegs[e.c], k = e.atStart ? 0 : S.length - 1; let g = S[k];
        const P0 = e.atStart ? [g[0], g[1]] : [g[g.length - 2], g[g.length - 1]];
        // only nudge: a big turn would swing the whole edge (long straight stripes bowed out this way)
        const cur = outTan(e); if (cur[0] * t[0] + cur[1] * t[1] < Math.cos(20 * Math.PI / 180)) return;
        if (g.length === 4) { // a short line: turn it into a cubic that leaves along t and arrives as the line did
          const Q = e.atStart ? [g[2], g[3]] : [g[0], g[1]], L = dist(P0[0], P0[1], Q[0], Q[1]); if (L < 1e-6 || L > 10 * (o.unit || 1)) return;
          const near = [P0[0] + t[0] * L / 3, P0[1] + t[1] * L / 3], far = [Q[0] + (P0[0] - Q[0]) / 3, Q[1] + (P0[1] - Q[1]) / 3];
          g = e.atStart ? [P0[0], P0[1], near[0], near[1], far[0], far[1], Q[0], Q[1]] : [Q[0], Q[1], far[0], far[1], near[0], near[1], P0[0], P0[1]];
        } else {
          g = g.slice(); const hi = e.atStart ? 2 : 4, chord = dist(g[0], g[1], g[6], g[7]);
          const hl = Math.min(chord / 3, dist(P0[0], P0[1], g[hi], g[hi + 1]));
          g[hi] = P0[0] + t[0] * hl; g[hi + 1] = P0[1] + t[1] * hl;
        }
        S[k] = g;
      };
      for (const [v, E] of ends) {
        if (E.length !== 3) continue;
        const T = E.map(outTan);
        let bp = null, bd = -cos35;
        for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) { const dd = T[a][0] * T[b][0] + T[a][1] * T[b][1]; if (dd < bd) { bd = dd; bp = [a, b]; } }
        if (!bp) continue;
        const [a, b] = bp, c3 = 3 - a - b;
        let t = norm([T[a][0] - T[b][0], T[a][1] - T[b][1]]);
        // where does the through-outline really pass? fit a parabola to its pixels on both sides of the junction
        {
          const U = o.unit || 1, J = jpos(v), near = [];
          for (const e of [E[a], E[b]]) {
            const P = chainPts[e.c], n = P.length; let s2 = 0;
            for (let q = 0; q < n; q++) { const i = e.atStart ? q : n - 1 - q, pp = P[i]; const dd = dist(pp[0], pp[1], J[0], J[1]); if (dd > 9 * U) break; if (dd > 0.8 * U) near.push(pp); s2++; }
          }
          if (near.length >= 6) {
            const ux = t[0], uy = t[1];
            let S0 = 0, S1 = 0, S2 = 0, S3 = 0, S4 = 0, T0 = 0, T1 = 0, T2 = 0;
            for (const pp of near) { const px = pp[0] - J[0], py = pp[1] - J[1], uu = px * ux + py * uy, vv = -px * uy + py * ux, u2 = uu * uu; S0++; S1 += uu; S2 += u2; S3 += u2 * uu; S4 += u2 * u2; T0 += vv; T1 += uu * vv; T2 += u2 * vv; }
            const d3 = (a1, a2, a3, b1, b2, b3, c1, c2, c3_) => a1 * (b2 * c3_ - b3 * c2) - a2 * (b1 * c3_ - b3 * c1) + a3 * (b1 * c2 - b2 * c1);
            const D = d3(S0, S1, S2, S1, S2, S3, S2, S3, S4);
            if (Math.abs(D) > 1e-9) {
              const k0 = d3(T0, S1, S2, T1, S2, S3, T2, S3, S4) / D, k1 = d3(S0, T0, S2, S1, T1, S3, S2, T2, S4) / D;
              if (Math.abs(k0) <= 2 * U) {
                const NJ = [J[0] - uy * k0, J[1] + ux * k0]; // J moved across onto the parabola
                t = norm([ux - uy * k1, uy + ux * k1]);
                if (Math.abs(k0) > 0.1 * U) { jOver.set(v, NJ); for (const e of E) chainSegs[e.c] = fitOne(e.c); }
              }
            }
          }
          T[c3] = outTan(E[c3]);
        }
        setTan(E[a], t); setTan(E[b], [-t[0], -t[1]]);
        const dc = T[c3][0] * t[0] + T[c3][1] * t[1];
        if (Math.abs(dc) > cos35) setTan(E[c3], dc > 0 ? t : [-t[0], -t[1]]); // a taper sliding into the outline
      }
    };
    smoothJunctions();
    await say('Building shapes');
    // chain shoelace partial sums (pixel-corner polygon) for loop areas
    const chainArea = chains.map(ch => { let s = 0; for (let k = 0; k + 1 < ch.xs.length; k++) s += ch.xs[k] * ch.ys[k + 1] - ch.xs[k + 1] * ch.ys[k]; return s; });
    const regionDir = Array.from({ length: nc }, () => []);
    chains.forEach((ch, c) => { if (ch.right >= 0) regionDir[ch.right].push(c * 2); if (ch.left >= 0) regionDir[ch.left].push(c * 2 + 1); });
    const used = new Uint8Array(chains.length * 2);
    const regions = [];
    for (let R = 0; R < nc; R++) {
      const loops = [];
      for (const start of regionDir[R]) {
        if (used[start]) continue;
        const seq = []; let cur = start;
        for (let guard = 0; guard <= regionDir[R].length; guard++) {
          seq.push(cur); used[cur] = 1;
          const c = cur >> 1, fwd = (cur & 1) === 0, ch = chains[c];
          if (ch.closed) break;
          const v = fwd ? ch.ev : ch.sv, x = v % W1, y = (v - x) / W1;
          const inDir = fwd ? ch.mv[ch.mv.length - 1] : (ch.mv[0] + 2) & 3;
          let nd = -1;
          for (const t of [(inDir + 1) & 3, inDir, (inDir + 3) & 3]) {
            if (valid(x, y, t) && rightOf(x, y, t) === R && leftOf(x, y, t) !== R) { nd = t; break; }
          }
          if (nd < 0) break;
          const e = edgeId(x, y, nd), c2 = edgeChain[e], ch2 = chains[c2];
          const f2 = e === ch2.firstEdge && v === ch2.sv && ch2.mv[0] === nd;
          const nxt = c2 * 2 + (f2 ? 0 : 1);
          if (nxt === start) break;
          cur = nxt;
        }
        let area = 0, border = false;
        for (const s of seq) { const c = s >> 1; area += (s & 1) ? -chainArea[c] : chainArea[c]; }
        loops.push({ seq, area: area / 2 });
      }
      let oi = 0; loops.forEach((L, i) => { if (Math.abs(L.area) > Math.abs(loops[oi].area)) oi = i; });
      const edge = regionDir[R].some(dc => { const ch = chains[dc >> 1]; return ch.right < 0 || ch.left < 0; });
      regions.push({ edge, label: cLabel[R], loops, outer: oi, outerArea: loops.length ? Math.abs(loops[oi].area) : 0, area: C.cArea[R] });
    }

    // border colour counts for background detection
    const borderCount = new Float64Array(K + 1);
    for (let x = 0; x < W; x++) { borderCount[lbl[x]]++; borderCount[lbl[(H - 1) * W + x]]++; }
    for (let y = 0; y < H; y++) { borderCount[lbl[y * W]]++; borderCount[lbl[y * W + W - 1]]++; }
    let bg = 0; for (let k = 0; k <= K; k++) if (borderCount[k] > borderCount[bg]) bg = k;

    const palArea = new Float64Array(K);
    regions.forEach(r => { if (r.label < K) palArea[r.label] += r.area; });
    const palette = pal.map((c, i) => ({ hex: toHex(c.r, c.g, c.b), r: c.r, g: c.g, b: c.b, area: palArea[i] }));

    await say('Looking for gradients');
    // ---- gradient groups: neighbouring bands whose shared edge is soft in the image (no real edge, just quantisation) ----
    const NR = regions.length, par = Int32Array.from({ length: NR }, (_, i) => i);
    const find = a => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
    const U0 = o.unit || 1;
    const pixAt = (X, Y) => { const xi = Math.floor(X), yi = Math.floor(Y); return (xi < 0 || yi < 0 || xi >= W || yi >= H) ? -1 : yi * W + xi; };
    chains.forEach(ch => {
      if (ch.right < 0 || ch.left < 0) return;
      const la = cLabel[ch.right], lb = cLabel[ch.left];
      if (la === TL || lb === TL || la === lb) return;
      if (C.cArea[ch.right] < 30 * U0 * U0 || C.cArea[ch.left] < 30 * U0 * U0 || ch.mv.length < 6 * U0) return;
      const pd = Math.hypot(PR[la][0] - PR[lb][0], PR[la][1] - PR[lb][1], PR[la][2] - PR[lb][2]);
      if (pd > 110 || pd < 4) return;
      let sum = 0, n = 0; const stp = Math.max(1, Math.floor(ch.mv.length / 150));
      for (let k = 0; k < ch.mv.length; k += stp) {
        const dd = ch.mv[k], mx = ch.xs[k] + DX[dd] * 0.5, my = ch.ys[k] + DY[dd] * 0.5, nx = NRM[dd][0], ny = NRM[dd][1];
        const a = pixAt(mx - nx * 2.5 * U0, my - ny * 2.5 * U0), b = pixAt(mx + nx * 2.5 * U0, my + ny * 2.5 * U0);
        if (a < 0 || b < 0 || !opaque[a] || !opaque[b]) continue;
        sum += Math.hypot(d[a * 4] - d[b * 4], d[a * 4 + 1] - d[b * 4 + 1], d[a * 4 + 2] - d[b * 4 + 2]); n++;
      }
      if (n >= 4 && sum / n < 0.5 * pd) { const A = find(ch.right), B = find(ch.left); if (A !== B) par[A] = B; }
    });
    const groupIdx = new Map(), regionGroup = new Int32Array(NR).fill(-1), groups = [];
    { const cnt = new Map(); for (let r = 0; r < NR; r++) { const k = find(r); cnt.set(k, (cnt.get(k) || 0) + 1); }
      for (let r = 0; r < NR; r++) { const k = find(r); if (cnt.get(k) < 2) continue; if (!groupIdx.has(k)) { groupIdx.set(k, groups.length); groups.push({ members: [] }); } const g = groupIdx.get(k); regionGroup[r] = g; groups[g].members.push(r); } }
    if (groups.length) {
      const G = groups.length, A = new Float64Array(G * 12), stride = Math.max(1, Math.floor(N / 1500000));
      const compArr = C.comp;
      for (let i = 0; i < N; i += stride) { const g = regionGroup[compArr[i]]; if (g < 0) continue; const x = i % W, y = (i - x) / W, o4 = g * 12;
        A[o4] += 1; A[o4 + 1] += x; A[o4 + 2] += y; A[o4 + 3] += x * x; A[o4 + 4] += x * y; A[o4 + 5] += y * y;
        for (let c = 0; c < 3; c++) { const v = d[i * 4 + c]; A[o4 + 6 + c] += v; A[o4 + 9 + c] += 0; } }
      // second pass: covariances of colour with position
      const CV = new Float64Array(G * 6);
      groups.forEach((g, gi) => { const o4 = gi * 12, n = A[o4]; g.n = n; g.cx = A[o4 + 1] / n; g.cy = A[o4 + 2] / n; g.mean = [A[o4 + 6] / n, A[o4 + 7] / n, A[o4 + 8] / n]; });
      for (let i = 0; i < N; i += stride) { const gi = regionGroup[compArr[i]]; if (gi < 0) continue; const g = groups[gi], x = i % W - g.cx, y = (i - (i % W)) / W - g.cy;
        for (let c = 0; c < 3; c++) { const v = d[i * 4 + c] - g.mean[c]; CV[gi * 6 + c * 2] += v * x; CV[gi * 6 + c * 2 + 1] += v * y; } }
      groups.forEach((g, gi) => {
        const o4 = gi * 12, n = g.n, sxx = A[o4 + 3] / n - g.cx * g.cx, sxy = A[o4 + 4] / n - g.cx * g.cy, syy = A[o4 + 5] / n - g.cy * g.cy;
        const det = sxx * syy - sxy * sxy || 1e-9; let m11 = 0, m12 = 0, m22 = 0; g.B = [];
        for (let c = 0; c < 3; c++) { const cx = CV[gi * 6 + c * 2] / n, cy = CV[gi * 6 + c * 2 + 1] / n; const bx = (cx * syy - cy * sxy) / det, by = (cy * sxx - cx * sxy) / det; g.B.push([bx, by]); m11 += bx * bx; m12 += bx * by; m22 += by * by; }
        const th = 0.5 * Math.atan2(2 * m12, m11 - m22); g.dir = [Math.cos(th), Math.sin(th)]; g.tmin = Infinity; g.tmax = -Infinity;
      });
      // a real gradient is smooth: a plane through position explains most of its colour variation.
      // Textured areas (fur, photos, noise) also have soft band edges but fail this test; they keep their bands.
      { const RS = new Float64Array(G * 2);
        for (let i = 0; i < N; i += stride) { const gi = regionGroup[compArr[i]]; if (gi < 0) continue; const g = groups[gi], x = i % W - g.cx, y = (i - (i % W)) / W - g.cy;
          for (let c = 0; c < 3; c++) { const v = d[i * 4 + c] - g.mean[c], p = g.B[c][0] * x + g.B[c][1] * y; RS[gi * 2] += v * v; RS[gi * 2 + 1] += (v - p) * (v - p); } }
        groups.forEach((g, gi) => { const tv = RS[gi * 2], rv = RS[gi * 2 + 1], r2 = tv > 0 ? 1 - rv / tv : 0, rstd = Math.sqrt(rv / Math.max(1, g.n) / 3); g.valid = r2 >= 0.7 && rstd <= 14; });
        for (let r = 0; r < NR; r++) { const gi = regionGroup[r]; if (gi >= 0 && !groups[gi].valid) regionGroup[r] = -1; } }
      for (let i = 0; i < N; i += stride) { const gi = regionGroup[compArr[i]]; if (gi < 0) continue; const g = groups[gi], t = (i % W - g.cx) * g.dir[0] + ((i - (i % W)) / W - g.cy) * g.dir[1]; if (t < g.tmin) g.tmin = t; if (t > g.tmax) g.tmax = t; }
      const NB = 48, HB = new Float64Array(G * NB * 4);
      for (let i = 0; i < N; i += stride) { const gi = regionGroup[compArr[i]]; if (gi < 0) continue; const g = groups[gi], t = (i % W - g.cx) * g.dir[0] + ((i - (i % W)) / W - g.cy) * g.dir[1];
        const b = Math.min(NB - 1, Math.max(0, Math.floor((t - g.tmin) / ((g.tmax - g.tmin) || 1) * NB))), q = (gi * NB + b) * 4; HB[q]++; HB[q + 1] += d[i * 4]; HB[q + 2] += d[i * 4 + 1]; HB[q + 3] += d[i * 4 + 2]; }
      groups.forEach((g, gi) => {
        // trim the sparse tails, then average colour in six slices along the gradient direction
        let tot = 0; for (let b = 0; b < NB; b++) tot += HB[(gi * NB + b) * 4];
        let acc = 0, b0 = 0, b1 = NB - 1;
        for (let b = 0; b < NB; b++) { acc += HB[(gi * NB + b) * 4]; if (acc >= tot * 0.02) { b0 = b; break; } }
        acc = 0; for (let b = NB - 1; b >= 0; b--) { acc += HB[(gi * NB + b) * 4]; if (acc >= tot * 0.02) { b1 = b; break; } }
        const span = (g.tmax - g.tmin) || 1, t0 = g.tmin + b0 / NB * span, t1 = g.tmin + (b1 + 1) / NB * span, stops = [];
        const K = 6;
        for (let k = 0; k < K; k++) {
          const lo = b0 + Math.floor(k * (b1 - b0 + 1) / K), hi = Math.max(lo, b0 + Math.floor((k + 1) * (b1 - b0 + 1) / K) - 1);
          let n = 0, r = 0, gg = 0, bb = 0; for (let b = lo; b <= hi; b++) { const q = (gi * NB + b) * 4; n += HB[q]; r += HB[q + 1]; gg += HB[q + 2]; bb += HB[q + 3]; }
          if (n) stops.push([(k + 0.5) / K, toHex(r / n, gg / n, bb / n), [r / n, gg / n, bb / n]]);
        }
        const first = stops[0], last = stops[stops.length - 1];
        const spanC = first && last ? Math.hypot(first[2][0] - last[2][0], first[2][1] - last[2][1], first[2][2] - last[2][2]) : 0;
        g.meanHex = toHex(g.mean[0], g.mean[1], g.mean[2]);
        { const L = new Float32Array(3); rgb2lab(Math.round(g.mean[0]), Math.round(g.mean[1]), Math.round(g.mean[2]), L, 0); let bi = 0, bd = Infinity;
          pal.forEach((p, k) => { const dd = (p.L - L[0]) ** 2 + (p.A - L[1]) ** 2 + (p.B - L[2]) ** 2; if (dd < bd) { bd = dd; bi = k; } }); g.flatLabel = bi; }
        g.grad = spanC > 30 && stops.length >= 2 ? { x1: g.cx + g.dir[0] * t0, y1: g.cy + g.dir[1] * t0, x2: g.cx + g.dir[0] * t1, y2: g.cy + g.dir[1] * t1, stops: stops.map(s => [s[0], s[1]]) } : null;
      });
    }

    groups.forEach(g => { if (g.valid === false) g.members = []; });
    await say('Looking for outlines');
    // ---- clean outlines: ring-shaped regions of near-constant thickness become a single stroked centreline ----
    const loopPoints = L => { const out = []; for (const ds of L.seq) { const P = chainPts[ds >> 1]; if (ds & 1) for (let k = P.length - 1; k >= 0; k--) out.push(P[k]); else for (const p of P) out.push(p); } return out; };
    regions.forEach(r => {
      if (r.loops.length !== 2 || r.label === TL) return;
      const outer = loopPoints(r.loops[r.outer]), inner = loopPoints(r.loops[1 - r.outer]);
      if (outer.length < 40 || inner.length < 0.5 * outer.length) return;
      const G = makeGrid(inner, 3 * U0), stp = Math.max(1, Math.floor(outer.length / 400)), ds = [], mids = [];
      for (let k = 0; k < outer.length; k += stp) {
        const p = outer[k], cx = Math.floor(p[0] / G.cell), cy = Math.floor(p[1] / G.cell); let best = Infinity, bq = null;
        for (let rr = 1; rr <= 12 && !bq; rr++) for (let ax = -rr; ax <= rr; ax++) for (let ay = -rr; ay <= rr; ay++) { const bkt = G.g.get((cx + ax) + ',' + (cy + ay)); if (!bkt) continue; for (const ii of bkt) { const q = inner[ii], dd = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2; if (dd < best) { best = dd; bq = q; } } }
        if (!bq) return; ds.push(Math.sqrt(best)); mids.push([(p[0] + bq[0]) / 2, (p[1] + bq[1]) / 2]);
      }
      const m = ds.reduce((a, b) => a + b, 0) / ds.length, sd = Math.sqrt(ds.reduce((a, b) => a + (b - m) ** 2, 0) / ds.length);
      if (m < 1.5 * U0 || m > 40 * U0 || sd / m > 0.2) return;
      // a keyline frames something much larger than its own thickness; small rings (letter counters, dots) stay filled
      const holeArea = Math.abs(r.loops[1 - r.outer].area);
      if (holeArea < 64 * m * m || holeArea < 2 * r.area) return;
      // resample the centreline to ~1px spacing and fit it as a closed curve
      const cl = []; for (let k = 0; k < mids.length; k++) { const a = mids[k], b = mids[(k + 1) % mids.length], L = Math.max(1, Math.round(dist(a[0], a[1], b[0], b[1]) / U0)); for (let q = 0; q < L; q++) cl.push([a[0] + (b[0] - a[0]) * q / L, a[1] + (b[1] - a[1]) * q / L]); }
      try { r.outline = { segs: fitChain(smoothPts(cl, true, 2), true, o), width: m }; } catch (e) { }
    });

    // ---- re-fit the edges inside a rectangle with adjusted settings (keeps every shared boundary consistent) ----
    const MODES = {
      smoother: v => { v.smoothPasses = v.smoothPasses * 2 + 2; v.tol *= 1.7; v.cornerAngle += 12; v.alphamax = (v.alphamax || 1) + 0.3; },
      sharper: v => { v.cornerAngle = Math.max(12, v.cornerAngle - 12); v.alphamax = Math.max(0.3, (v.alphamax || 1) - 0.3); v.cornerR = 1.6; },
      closer: v => { v.tol *= 0.5; v.smoothPasses = Math.max(1, Math.floor(v.smoothPasses / 2)); v.lineTol *= 0.7; v.reduce = 0.05; },
      straighter: v => { v.lineTol *= 2.2; v.sagTol *= 2.2; v.straighten = Math.max(8, v.straighten || 0); },
    };
    const refit = (rect, mode) => {
      const f = MODES[mode]; if (!f) return 0;
      const keys = ['tol', 'lineTol', 'sagTol', 'smoothPasses', 'cornerPasses', 'cornerAngle', 'cornerR', 'alphamax', 'straighten', 'reduce'];
      const inR = p => p[0] >= rect.x0 && p[0] <= rect.x1 && p[1] >= rect.y0 && p[1] <= rect.y1;
      let changed = 0;
      chains.forEach((ch, c) => {
        const P = chainPts[c]; let k = 0; for (const p of P) if (inR(p)) k++;
        if (!k || (k < 0.5 * P.length && k < 30 * U0)) return;
        const save = {}; keys.forEach(q => save[q] = o[q]); const sb = o._base; o._base = null;
        f(o); try { chainSegs[c] = fitOne(c); changed++; } catch (e) { }
        keys.forEach(q => o[q] = save[q]); o._base = sb;
      });
      if (changed) smoothJunctions();
      return changed;
    };

    return { chainPts, noise, rough, W, H, palette, transparentLabel: TL, hasTransparency: anyT, background: bg, chains, chainSegs, regions, groups, regionGroup, refit };
  }

  // ---------- path building ----------
  const f2 = v => { const r = Math.round(v * 100) / 100; return Object.is(r, -0) ? '0' : String(r); };
  function loopD(res, loop, scale) {
    const sc = scale || 1;
    let s = '', started = false;
    for (const ds of loop.seq) {
      const segs = res.chainSegs[ds >> 1], rev = (ds & 1) === 1;
      const n = segs.length;
      for (let k = 0; k < n; k++) {
        const b = segs[rev ? n - 1 - k : k];
        if (!started) { s += 'M' + f2((rev ? b[b.length - 2] : b[0]) * sc) + ' ' + f2((rev ? b[b.length - 1] : b[1]) * sc); started = true; }
        if (b.length === 4) s += 'L' + (rev ? f2(b[0] * sc) + ' ' + f2(b[1] * sc) : f2(b[2] * sc) + ' ' + f2(b[3] * sc));
        else if (rev) s += 'C' + [b[4], b[5], b[2], b[3], b[0], b[1]].map(v => f2(v * sc)).join(' ');
        else s += 'C' + [b[2], b[3], b[4], b[5], b[6], b[7]].map(v => f2(v * sc)).join(' ');
      }
    }
    return s + 'Z';
  }
  function loopNodes(res, loop) { let n = 0; for (const ds of loop.seq) n += res.chainSegs[ds >> 1].length; return n; }

  // Build drawable shape list. hidden: Set of palette indices to omit.
  function segsD(segs, sc) {
    if (!segs.length) return '';
    let s = 'M' + f2(segs[0][0] * sc) + ' ' + f2(segs[0][1] * sc);
    for (const b of segs) s += b.length === 4 ? 'L' + f2(b[2] * sc) + ' ' + f2(b[3] * sc) : 'C' + [b[2], b[3], b[4], b[5], b[6], b[7]].map(v => f2(v * sc)).join(' ');
    return s + 'Z';
  }
  // opts: { gradients: bool, outlines: bool }
  function shapes(res, mode, hidden, scale, hiddenRegions, opts) {
    const TL = res.transparentLabel, sc = scale || 1, op = opts || {};
    const isHidden = lab => lab === TL || hidden.has(lab);
    const hr = hiddenRegions || new Set();
    const regionHidden = i => isHidden(res.regions[i].label) || hr.has(i);
    // a hole must be cut through a stacked shape if anything nested inside it is hidden or transparent, otherwise
    // the lower shape shows through where the image is empty (e.g. a see-through eye inside a white ring)
    const across = ds => { const ch = res.chains[ds >> 1]; return (ds & 1) ? ch.right : ch.left; };
    const hiddenInside = new Map();
    const hasHiddenInside = (i, depth) => {
      if (i < 0) return false;
      if (hiddenInside.has(i)) return hiddenInside.get(i);
      hiddenInside.set(i, false);
      let v = regionHidden(i);
      if (!v && depth < 64) { const R = res.regions[i]; R.loops.forEach((L, li) => { if (!v && li !== R.outer) v = L.seq.some(ds => hasHiddenInside(across(ds), depth + 1)); }); }
      hiddenInside.set(i, v); return v;
    };
    const groups = res.groups || [], rg = res.regionGroup;
    // paint for a region: its palette colour, or for a gradient band the group's average / true gradient
    const paint = (r, i) => {
      const g = rg && rg[i] >= 0 ? groups[rg[i]] : null;
      if (!g) return { fill: res.palette[r.label].hex, grad: null, key: 'c' + r.label };
      const flat = res.palette[g.flatLabel != null ? g.flatLabel : r.label].hex; // always an existing palette colour
      if (op.gradients && g.grad) return { fill: flat, key: 'g' + rg[i], grad: { x1: g.grad.x1 * sc, y1: g.grad.y1 * sc, x2: g.grad.x2 * sc, y2: g.grad.y2 * sc, stops: g.grad.stops } };
      return { fill: flat, grad: null, key: 'f' + rg[i] };
    };
    const outlineOf = r => (op.outlines && r.outline ? r.outline : null);
    const out = [];
    const regs = res.regions.map((r, i) => ({ r, i })).filter(o => !regionHidden(o.i) && o.r.loops.length);
    if (mode === 'stacked') {
      regs.sort((a, b) => b.r.outerArea - a.r.outerArea);
      const doneGroup = new Set(), visible = new Set(regs.map(o => o.i));
      for (const { r, i } of regs) {
        const pt = paint(r, i), ol = outlineOf(r);
        if (ol) { out.push({ fill: pt.fill, label: r.label, d: segsD(ol.segs, sc), nodes: ol.segs.length, stroke: ol.width * sc }); continue; }
        const gi = rg ? rg[i] : -1;
        if (gi >= 0) {
          // a gradient (or flattened gradient) is one shape: the union of its bands, so no seams show between them
          if (doneGroup.has(gi)) continue; doneGroup.add(gi);
          let d = '', nodes = 0;
          for (const m of groups[gi].members) { if (!visible.has(m)) continue; const R = res.regions[m]; d += loopD(res, R.loops[R.outer], sc); nodes += loopNodes(res, R.loops[R.outer]); }
          out.push({ fill: pt.fill, grad: pt.grad, label: r.label, d, nodes, evenodd: false });
          continue;
        }
        let d = loopD(res, r.loops[r.outer], sc), nodes = loopNodes(res, r.loops[r.outer]), cut = false;
        r.loops.forEach((L, li) => {
          if (li === r.outer) return;
          // cut the hole if any neighbour across it is hidden
          const needs = L.seq.some(ds => hasHiddenInside(across(ds), 0));
          if (needs) { d += loopD(res, L, sc); nodes += loopNodes(res, L); cut = true; }
        });
        out.push({ fill: pt.fill, grad: pt.grad, label: r.label, d, nodes, evenodd: cut });
      }
    } else {
      // cutouts: merge regions that share a paint into one path (a whole gradient becomes one shape)
      const byKey = new Map();
      for (const { r, i } of regs) {
        const pt = paint(r, i), ol = outlineOf(r);
        if (ol) { out.push({ fill: pt.fill, label: r.label, d: segsD(ol.segs, sc), nodes: ol.segs.length, stroke: ol.width * sc, area: r.area }); continue; }
        let e = byKey.get(pt.key); if (!e) { e = { fill: pt.fill, grad: pt.grad, label: r.label, d: '', nodes: 0, evenodd: true, area: 0 }; byKey.set(pt.key, e); }
        e.area += r.area;
        r.loops.forEach(L => { e.d += loopD(res, L, sc); e.nodes += loopNodes(res, L); });
      }
      out.push(...[...byKey.values()].sort((a, b) => b.area - a.area));
      out.sort((a, b) => (a.stroke ? 1 : 0) - (b.stroke ? 1 : 0));
    }
    return out;
  }

  // phys: optional { w, h } physical size in inches for the artboard
  function toSVG(res, shapeList, outW, outH, phys) {
    const defs = [], lines = [];
    shapeList.forEach((s, k) => {
      let fill = s.fill;
      if (s.grad) {
        const id = 'g' + k;
        defs.push(`    <linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${f2(s.grad.x1)}" y1="${f2(s.grad.y1)}" x2="${f2(s.grad.x2)}" y2="${f2(s.grad.y2)}">` + s.grad.stops.map(st => `<stop offset="${f2(st[0])}" stop-color="${st[1]}"/>`).join('') + '</linearGradient>');
        fill = `url(#${id})`;
      }
      if (s.stroke) lines.push(`  <path fill="none" stroke="${s.fill}" stroke-width="${f2(s.stroke)}" stroke-linejoin="round" d="${s.d}"/>`);
      else lines.push(`  <path fill="${fill}"${s.evenodd ? ' fill-rule="evenodd"' : ''} d="${s.d}"/>`);
    });
    const size = phys ? `width="${f2(phys.w)}in" height="${f2(phys.h)}in"` : `width="${Math.round(outW)}" height="${Math.round(outH)}"`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f2(outW)} ${f2(outH)}" ${size}>\n${defs.length ? '  <defs>\n' + defs.join('\n') + '\n  </defs>\n' : ''}${lines.join('\n')}\n</svg>\n`;
  }

  return { trace, shapes, toSVG, _detectCorners: detectCorners, _turnAngle: turnAngle, _smooth: smoothPts };
})();
if (typeof module !== 'undefined') module.exports = VTrace;

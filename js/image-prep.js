/*
 * Image preparation helpers used before tracing.
 *   edgeBlendRatio(imageData) - how anti-aliased the artwork is (about 0 for hard pixel art,
 *                               0.4 or more for smooth artwork). Hard-edged art is traced at its
 *                               own size because enlarging it blurs the pixel staircase.
 *   upscale(imageData, factor) - Catmull-Rom enlargement in premultiplied alpha, so transparent
 *                               edges don't pick up dark fringes. Small logos are enlarged so
 *                               thin details survive tracing.
 */
const RetraceImage = (() => {
function edgeBlendRatio(img) {
  const { width: W, height: H, data: d } = img;
  const col = i => { const a = d[i + 3] / 255; return [d[i] * a + 128 * (1 - a), d[i + 1] * a + 128 * (1 - a), d[i + 2] * a + 128 * (1 - a)]; };
  const df = (p, q) => Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]);
  let trans = 0, between = 0;
  const stepY = Math.max(1, Math.floor(H / 400));
  for (let y = 0; y < H; y += stepY) for (let x = 1; x < W - 1; x++) {
    const i = (y * W + x) * 4, L = col(i - 4), M = col(i), R = col(i + 4);
    if (df(L, R) > 150) { trans++; if (df(M, L) > 40 && df(M, R) > 40) between++; }
  }
  return trans ? between / trans : 1;
}
function upscale(src, s) {
  const W0 = src.width, H0 = src.height, W = W0 * s, H = H0 * s, d = src.data;
  const pm = new Float32Array(W0 * H0 * 4);
  for (let i = 0; i < W0 * H0; i++) { const a = d[i * 4 + 3] / 255; pm[i * 4] = d[i * 4] * a; pm[i * 4 + 1] = d[i * 4 + 1] * a; pm[i * 4 + 2] = d[i * 4 + 2] * a; pm[i * 4 + 3] = d[i * 4 + 3]; }
  const wts = t => { const t2 = t * t, t3 = t2 * t; return [(-t3 + 2 * t2 - t) / 2, (3 * t3 - 5 * t2 + 2) / 2, (-3 * t3 + 4 * t2 + t) / 2, (t3 - t2) / 2]; };
  const taps = n => { const T = []; for (let o = 0; o < n * s; o++) { const f = (o + 0.5) / s - 0.5, i0 = Math.floor(f); T.push([i0, wts(f - i0)]); } return T; };
  const TX = taps(W0), TY = taps(H0), cl = (v, m) => v < 0 ? 0 : v > m ? m : v;
  const mid = new Float32Array(W * H0 * 4);
  for (let y = 0; y < H0; y++) for (let x = 0; x < W; x++) {
    const [i0, w] = TX[x], o = (y * W + x) * 4;
    for (let k = 0; k < 4; k++) { const sx = cl(i0 - 1 + k, W0 - 1), si = (y * W0 + sx) * 4; for (let c = 0; c < 4; c++) mid[o + c] += w[k] * pm[si + c]; }
  }
  const out = new ImageData(W, H), od = out.data;
  for (let y = 0; y < H; y++) { const [i0, w] = TY[y]; for (let x = 0; x < W; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let k = 0; k < 4; k++) { const si = (cl(i0 - 1 + k, H0 - 1) * W + x) * 4; r += w[k] * mid[si]; g += w[k] * mid[si + 1]; b += w[k] * mid[si + 2]; a += w[k] * mid[si + 3]; }
    const o = (y * W + x) * 4; a = Math.max(0, Math.min(255, a));
    if (a > 0.5) { const f = 255 / a; od[o] = r * f; od[o + 1] = g * f; od[o + 2] = b * f; }
    od[o + 3] = a;
  } }
  return out;
}

return { edgeBlendRatio, upscale };
})();

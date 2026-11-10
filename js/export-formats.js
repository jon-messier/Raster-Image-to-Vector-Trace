/*
 * File writers for the shapes Retrace produces. They have no dependencies.
 *   buildPDF(shapes, W, H, art) -> Uint8Array   single-page PDF; gradients become PDF shadings
 *   buildEPS(shapes, W, H, art) -> string       EPS (PostScript level 3)
 *   makeZip([{name, data}])     -> Uint8Array   uncompressed ZIP, used for batch downloads
 * W/H are the drawing size in pixels; art.k is inches per pixel (the artboard scale).
 * Shapes are {d, fill, evenodd?, grad?, stroke?}, where d is SVG path data using only absolute M, L, C, Z.
 */
const RetraceExport = (() => {
function shapeOps(d) {
  const t = d.match(/[MLCZ]|-?\d*\.?\d+(?:e-?\d+)?/g) || [], ops = []; let i = 0;
  while (i < t.length) { const c = t[i++]; if (c === 'Z') { ops.push(['Z']); continue; } const n = c === 'C' ? 6 : 2, a = []; for (let k = 0; k < n; k++) a.push(+t[i++]); ops.push([c, a]); }
  return ops;
}
const rgb01 = hex => [1, 3, 5].map(i => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(4));
const n2 = v => (Math.round(v * 100) / 100).toString();
const fullStops = g => { const s = g.stops.map(x => [x[0], x[1]]); if (s[0][0] > 0) s.unshift([0, s[0][1]]); if (s[s.length - 1][0] < 1) s.push([1, s[s.length - 1][1]]); return s; };
function shadingFn(g) { // stitched linear interpolation between stops
  const s = fullStops(g), fns = [], bounds = [], enc = [];
  for (let i = 0; i < s.length - 1; i++) { fns.push(`<< /FunctionType 2 /Domain [0 1] /C0 [${rgb01(s[i][1]).join(' ')}] /C1 [${rgb01(s[i + 1][1]).join(' ')}] /N 1 >>`); enc.push('0 1'); if (i > 0) bounds.push(n2(s[i][0])); }
  return `<< /FunctionType 3 /Domain [0 1] /Functions [${fns.join(' ')}] /Bounds [${bounds.join(' ')}] /Encode [${enc.join(' ')}] >>`;
}
function pathOps(d, style) { // style: 'pdf' | 'ps'
  let s = '';
  for (const [c, a] of shapeOps(d)) {
    if (c === 'Z') s += 'h\n';
    else s += a.map(n2).join(' ') + ' ' + (style === 'pdf' ? { M: 'm', L: 'l', C: 'c' }[c] : c.toLowerCase()) + '\n';
  }
  return s;
}
function buildPDF(shapes, W, H, a) {
  const k = a.k * 72, PW = W * k, PH = H * k, sh = [];
  let body = `${n2(k)} 0 0 ${n2(-k)} 0 ${n2(PH)} cm\n1 j\n`;
  shapes.forEach(s => {
    if (s.stroke) { body += rgb01(s.fill).join(' ') + ` RG\n${n2(s.stroke)} w\n` + pathOps(s.d, 'pdf') + 'S\n'; return; }
    if (s.grad) { const id = 'Sh' + sh.length; sh.push(`/${id} << /ShadingType 2 /ColorSpace /DeviceRGB /Coords [${[s.grad.x1, s.grad.y1, s.grad.x2, s.grad.y2].map(n2).join(' ')}] /Extend [true true] /Function ${shadingFn(s.grad)} >>`); body += 'q\n' + pathOps(s.d, 'pdf') + (s.evenodd ? 'W* n\n' : 'W n\n') + `/${id} sh\nQ\n`; return; }
    body += rgb01(s.fill).join(' ') + ' rg\n' + pathOps(s.d, 'pdf') + (s.evenodd ? 'f*\n' : 'f\n');
  });
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n2(PW)} ${n2(PH)}] /Contents 4 0 R /Resources << ${sh.length ? '/Shading << ' + sh.join(' ') + ' >>' : ''} >> >>`,
    `<< /Length ${body.length} >>\nstream\n${body}endstream`, '<< /Producer (Retrace) >>'];
  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(out.length); for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 255; return bytes;
}
function buildEPS(shapes, W, H, a) {
  const k = a.k * 72, PW = W * k, PH = H * k;
  let s = `%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 ${Math.ceil(PW)} ${Math.ceil(PH)}\n%%HiResBoundingBox: 0 0 ${n2(PW)} ${n2(PH)}\n%%Creator: Retrace\n%%LanguageLevel: 3\n%%Pages: 1\n%%EndComments\n`;
  s += '/m {moveto} bind def /l {lineto} bind def /c {curveto} bind def /h {closepath} bind def\n';
  s += `gsave 0 ${n2(PH)} translate ${n2(k)} ${n2(-k)} scale 1 setlinejoin\n`;
  for (const sh of shapes) {
    if (sh.stroke) { s += rgb01(sh.fill).join(' ') + ` setrgbcolor ${n2(sh.stroke)} setlinewidth newpath\n` + pathOps(sh.d, 'ps') + 'stroke\n'; continue; }
    if (sh.grad) { s += 'gsave newpath\n' + pathOps(sh.d, 'ps') + (sh.evenodd ? 'eoclip\n' : 'clip\n') + `<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [${[sh.grad.x1, sh.grad.y1, sh.grad.x2, sh.grad.y2].map(n2).join(' ')}] /Extend [true true] /Function ${shadingFn(sh.grad)} >> shfill grestore\n`; continue; }
    s += rgb01(sh.fill).join(' ') + ' setrgbcolor newpath\n' + pathOps(sh.d, 'ps') + (sh.evenodd ? 'eofill\n' : 'fill\n');
  }
  return s + 'grestore\nshowpage\n%%EOF\n';
}

// minimal ZIP (stored, no compression)
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function makeZip(files) {
  const enc = new TextEncoder(), parts = [], central = []; let off = 0;
  const used = new Set();
  for (const f of files) {
    let name = f.name, n = 2; while (used.has(name)) name = f.name.replace(/(\.[^.]+)$/, `-${n++}$1`); used.add(name);
    const nb = enc.encode(name), data = typeof f.data === 'string' ? enc.encode(f.data) : f.data, crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, nb.length, true);
    parts.push(new Uint8Array(lh.buffer), nb, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, nb.length, true); ch.setUint32(42, off, true);
    central.push(new Uint8Array(ch.buffer), nb); off += 30 + nb.length + data.length;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0), end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, off, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)], out = new Uint8Array(all.reduce((s, p) => s + p.length, 0)); let p = 0;
  for (const a of all) { out.set(a, p); p += a.length; } return out;
}

return { buildPDF, buildEPS, makeZip };
})();

/*
 * Retrace user interface: opening images, settings, the side-by-side preview, area fixes,
 * batch mode and downloads. The tracing itself lives in vtrace-engine.js (VTrace).
 */
(() => {
const { edgeBlendRatio, upscale } = RetraceImage;
const { buildPDF, buildEPS, makeZip } = RetraceExport;
const $ = id => document.getElementById(id);
const MAX_WORK = 1400, MAX_DIM = 2800;
const ART_W = 10, ART_H = 8; // standard artboard, inches (width x height)

// ---------- state ----------
// items: one per opened logo. Each keeps its own trace and edits; settings are shared.
const st = {
  items: [], cur: -1, mode: 'stacked', view: 'split', passes: 6, outlines: false, gradients: false,
  zoom: 1, tx: 0, ty: 0, busy: false, job: 0, fix: null, shapes: [], paths: [], nodes: null, svg: ''
};
const item = () => st.items[st.cur] || null;

function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), 2600); }

// ---------- busy / cancel: lock the controls while work runs ----------
let cancelFlag = false;
function setBusy(msg) {
  st.busy = !!msg; document.body.classList.toggle('locked', st.busy);
  $('busy').classList.toggle('on', st.busy); if (msg) $('busyText').textContent = msg;
}
$('cancelBtn').onclick = () => { cancelFlag = true; $('busyText').textContent = 'Cancelling…'; };

// ---------- hints that follow the selection ----------
const HINTS = {
  quality: { '6': 'Thorough: every edge is traced six ways and the best-scoring version is kept. Slower, cleaner.', '1': 'Fast: a single pass per edge. Good for quick previews; use Thorough for final files.' },
  layering: { stacked: 'Stacked: shapes sit on top of each other, so no hairline gaps show between colors.', cutout: 'Cutouts: shapes are cut to fit exactly, with no overlaps. Best for vinyl cutting and separations.' },
  outlines: { filled: 'Filled shapes: every area, including thin rings, is a filled shape.', clean: 'Clean outlines: even-width rings (like a keyline around a badge) become a single stroked path you can resize.' },
  gradients: { flat: 'Flat color: gradient areas are filled with their average color.', true: 'True gradient: gradient areas are exported as real linear gradients.' },
};
function syncHints() {
  const pressed = id => ([...$(id).children].find(b => b.getAttribute('aria-pressed') === 'true') || {}).dataset?.v;
  for (const k in HINTS) { const v = pressed(k); const el = $(k + 'Hint'); if (el && v != null) el.textContent = HINTS[k][v]; }
}

// ---------- settings ----------
function settings() {
  const auto = $('autoColors').checked, cs = +$('corner').value;
  return { colors: auto ? 0 : +$('colors').value, speck: +$('speck').value, smoothness: +$('smooth').value, cornerAngle: 55 - cs * 0.35,
    alphamax: 1.3 - cs * 0.009, straighten: +$('straight').value, reduce: +$('reduce').value / 100 * 1.5, passes: st.passes };
}
const settingsKey = () => JSON.stringify(settings());
function syncLabels() {
  $('colorsOut').textContent = $('colors').value;
  $('speckOut').textContent = $('speck').value + ' px²';
  $('smoothOut').textContent = (+$('smooth').value).toFixed(1) + '×';
  $('cornerOut').textContent = $('corner').value;
  $('straightOut').textContent = $('straight').value + '°';
  $('reduceOut').textContent = $('reduce').value;
  $('colors').disabled = $('autoColors').checked;
}
let retraceTimer = 0;
// Changing a setting never starts a trace by itself: it marks the logo as out of date and offers Apply / Revert.
// (Only a brand-new logo traces automatically.)
const UI_KEYS = ['speck', 'smooth', 'corner', 'colors', 'straight', 'reduce'];
function uiSnapshot() { const o = { autoColors: $('autoColors').checked, passes: st.passes }; UI_KEYS.forEach(k => o[k] = $(k).value); return o; }
function restoreUI(o) { if (!o) return; $('autoColors').checked = o.autoColors; UI_KEYS.forEach(k => $(k).value = o[k]); st.passes = o.passes; setSeg('quality', String(o.passes)); syncLabels(); syncHints(); }
function updateApplyBar() {
  const it = item();
  const show = !!it && !st.busy && (it.key !== settingsKey() || !it.res);
  $('applyBar').hidden = !show;
  if (show) {
    $('applyMsg').textContent = !it.res ? 'Not traced yet.' : (it.fixes && it.fixes.length ? 'Settings changed. Applying clears area fixes.' : 'Settings changed.');
    $('applyBtn').textContent = it.res ? 'Apply changes' : 'Trace now';
    $('revertBtn').hidden = !it.res || !it.ui;
  }
}
function scheduleTrace() { syncLabels(); updateApplyBar(); }
$('applyBtn').onclick = () => { if (!st.busy) traceCurrent(); };
$('revertBtn').onclick = () => { const it = item(); if (it && it.ui && !st.busy) { restoreUI(it.ui); updateApplyBar(); } };
document.addEventListener('keydown', e => { if (e.key === 'Enter' && !$('applyBar').hidden && !st.busy && !/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(e.target.tagName || '')) traceCurrent(); });
['speck', 'smooth', 'corner', 'colors', 'straight', 'reduce'].forEach(id => $(id).addEventListener('input', scheduleTrace));
$('autoColors').addEventListener('change', () => { const it = item(); if (!$('autoColors').checked && it && it.res) $('colors').value = it.res.palette.length; scheduleTrace(); });

function segGroup(id, cb) {
  $(id).addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || st.busy) return;
    [...$(id).children].forEach(x => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
    syncHints(); cb(b.dataset.v);
  });
}
function setSeg(id, v) { [...$(id).children].forEach(b => b.setAttribute('aria-pressed', b.dataset.v === v ? 'true' : 'false')); }
segGroup('layering', v => { st.mode = v; rebuildShapes(); });
segGroup('quality', v => { st.passes = +v; scheduleTrace(); });
segGroup('outlines', v => { st.outlines = v === 'clean'; rebuildShapes(); });
segGroup('gradients', v => { st.gradients = v === 'true'; rebuildShapes(); });
segGroup('viewMode', v => { st.view = v; layoutPanes(); requestAnimationFrame(fit); });
$('showNodes').addEventListener('change', draw);
$('outline').addEventListener('change', draw);

// ---------- opening files (one or many) ----------
$('openBtn').onclick = $('openBtn2').onclick = () => { if (!st.busy) $('file').click(); };
$('file').addEventListener('change', e => { openFiles([...e.target.files]); e.target.value = ''; });
const drop = $('drop');
['dragenter', 'dragover'].forEach(t => document.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => document.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
document.addEventListener('drop', e => { if (!st.busy) openFiles([...(e.dataTransfer?.files || [])]); });
document.addEventListener('paste', e => { if (st.busy) return; const fs = [...(e.clipboardData?.items || [])].filter(i => i.type.startsWith('image/')).map(i => i.getAsFile()); if (fs.length) openFiles(fs); });

const readImage = f => new Promise((ok, bad) => {
  const r = new FileReader();
  r.onload = () => { const im = new Image(); im.onload = () => ok(im); im.onerror = bad; im.src = r.result; };
  r.onerror = bad; r.readAsDataURL(f);
});
async function openFiles(files) {
  files = files.filter(f => f && f.type && f.type.startsWith('image/'));
  if (!files.length) return;
  const items = [];
  for (const f of files) {
    try { const im = await readImage(f); items.push({ name: f.name || 'logo.png', img: im, w: im.naturalWidth, h: im.naturalHeight, res: null, key: '', hidden: new Set(), bgOn: false, fixes: [] }); }
    catch (e) { toast('Skipped ' + (f.name || 'a file') + ': it could not be read as an image.'); }
  }
  if (!items.length) return;
  st.items = items; st.cur = 0;
  $('empty').hidden = true; $('clearBtn').disabled = false;
  updateBatchNav(); showItem(true);
}
function updateBatchNav() {
  const n = st.items.length;
  $('batchNav').hidden = n < 2;
  $('batchCount').textContent = (st.cur + 1) + ' / ' + n;
  $('prevBtn').disabled = st.cur <= 0; $('nextBtn').disabled = st.cur >= n - 1;
}
$('prevBtn').onclick = () => { if (st.cur > 0 && !st.busy) { st.cur--; updateBatchNav(); showItem(true); } };
$('nextBtn').onclick = () => { if (st.cur < st.items.length - 1 && !st.busy) { st.cur++; updateBatchNav(); showItem(true); } };
function showItem(refit) {
  exitFix();
  const it = item(); if (!it) return;
  st.needsFit = false;
  layoutPanes();
  if (refit) requestAnimationFrame(fit); // the original shows right away, fitted, while the trace runs
  if (!it.res && !it.cancelled) { st.shapes = []; st.paths = []; st.nodes = null; traceCurrent(); } // first look at a new logo: trace right away
  else if (it.res) { renderPalette(); rebuildShapes(); updateApplyBar(); }
  else { st.shapes = []; st.paths = []; st.nodes = null; draw(); updateApplyBar(); }
}
// ---------- tracing ----------
function prepareData(it) {
  const W0 = it.w, H0 = it.h, m = Math.max(W0, H0);
  let up = Math.max(1, Math.min(3, Math.round(MAX_WORK / m)));
  if (up > 1) {
    const c0 = document.createElement('canvas'); c0.width = W0; c0.height = H0;
    const x0 = c0.getContext('2d', { willReadFrequently: true }); x0.drawImage(it.img, 0, 0);
    const d0 = x0.getImageData(0, 0, W0, H0);
    if (edgeBlendRatio(d0) < 0.25) up = 1; else return { data: upscale(d0, up), up };
  }
  if (m > MAX_DIM) up = MAX_DIM / m;
  const W = Math.round(W0 * up), H = Math.round(H0 * up);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const cx = c.getContext('2d', { willReadFrequently: true });
  cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high'; cx.drawImage(it.img, 0, 0, W, H);
  return { data: cx.getImageData(0, 0, W, H), up };
}
// trace one item with the current settings; resolves true when done, false if cancelled
async function traceItem(it, label) {
  const { data, up } = prepareData(it), s = settings(), u = Math.max(1, up);
  const res = await VTrace.trace(data, {
    colors: s.colors, minArea: Math.max(1, Math.round(s.speck * u * u)), smoothness: s.smoothness, cornerAngle: s.cornerAngle,
    alphamax: s.alphamax, straighten: s.straighten, reduce: s.reduce, passes: s.passes, unit: u, blendRadius: Math.round(2 * u),
    isCancelled: () => cancelFlag
  }, msg => $('busyText').textContent = (label ? label + ': ' : '') + msg + '…');
  if (it.res && it.res.palette.length !== res.palette.length) it.hidden = new Set();
  it.res = res; it.up = up; it.key = settingsKey(); it.fixes = []; it.cancelled = false; it.ui = uiSnapshot();
  return true;
}
async function traceCurrent() {
  const it = item(); if (!it) return;
  if (st.busy) { clearTimeout(retraceTimer); retraceTimer = setTimeout(traceCurrent, 300); return; }
  cancelFlag = false; $('applyBar').hidden = true; setBusy('Tracing…');
  try {
    await traceItem(it);
    if ($('autoColors').checked) { $('colors').value = it.res.palette.length; $('colorsOut').textContent = it.res.palette.length; }
    renderPalette(); rebuildShapes();
    if (st.needsFit) { st.needsFit = false; requestAnimationFrame(fit); }
  } catch (err) {
    if (err && err.cancelled) { if (!it.res) it.cancelled = true; toast(it.res ? 'Cancelled. Showing the previous trace. Adjust settings, then Apply.' : 'Cancelled. Adjust settings, then press Trace now.'); if (it.res) { renderPalette(); rebuildShapes(); } else draw(); }
    else { console.error(err); toast('Tracing failed on this image: ' + (err.message || err)); }
  } finally { setBusy(null); updateApplyBar(); }
}

// ---------- shapes and preview ----------
function bgRegions(it) {
  const res = it.res, bg = res.background, out = new Set();
  if (!it.bgOn || bg >= res.palette.length) return out;
  res.regions.forEach((r, i) => { if (r.label === bg && r.edge) out.add(i); });
  return out;
}
function shapesFor(it) { return VTrace.shapes(it.res, st.mode, it.hidden, 1 / it.up, bgRegions(it), { gradients: st.gradients, outlines: st.outlines }); }
function artSize(it) { const k = Math.min(ART_W / it.w, ART_H / it.h); return { w: it.w * k, h: it.h * k, k }; }
function rebuildShapes() {
  const it = item(); if (!it || !it.res) return;
  st.shapes = shapesFor(it);
  st.paths = st.shapes.map(sh => ({ p: new Path2D(sh.d), fill: sh.fill, grad: sh.grad, stroke: sh.stroke, rule: sh.evenodd ? 'evenodd' : 'nonzero' }));
  const a = artSize(it);
  st.svg = VTrace.toSVG(it.res, st.shapes, it.w, it.h, { w: a.w, h: a.h });
  const nodes = st.shapes.reduce((s, x) => s + x.nodes, 0), kb = (new Blob([st.svg]).size / 1024).toFixed(1);
  $('stats').textContent = `${st.shapes.length} shapes, ${nodes.toLocaleString()} nodes, ${kb} KB. Output size ${a.w.toFixed(2)} × ${a.h.toFixed(2)} in.`;
  $('dlBtn').disabled = $('copyBtn').disabled = $('fixBtn').disabled = false;
  $('undoFixBtn').hidden = !it.fixes.length;
  buildNodeCache(it); draw();
}
function renderPalette() {
  const it = item(), res = it.res, el = $('palette'); el.innerHTML = '';
  const total = res.palette.reduce((a, p) => a + p.area, 0) || 1;
  res.palette.map((p, i) => ({ p, i })).sort((a, b) => b.p.area - a.p.area).forEach(({ p, i }) => {
    const row = document.createElement('div'); row.className = 'chip' + (it.hidden.has(i) ? ' off' : '');
    const sw = document.createElement('label'); sw.className = 'sw'; sw.style.background = p.hex; sw.title = 'Change this color';
    const inp = document.createElement('input'); inp.type = 'color'; inp.value = p.hex;
    const hx = document.createElement('span'); hx.className = 'hex'; hx.textContent = p.hex;
    inp.addEventListener('input', () => { p.hex = inp.value; sw.style.background = inp.value; hx.textContent = inp.value; rebuildShapes(); });
    sw.appendChild(inp);
    const sh = document.createElement('span'); sh.className = 'share'; sh.textContent = (100 * p.area / total < 1 ? '<1' : Math.round(100 * p.area / total)) + '%';
    const eye = document.createElement('button'); eye.className = 'eye'; const on = !it.hidden.has(i);
    eye.textContent = on ? 'Hide' : 'Show'; eye.setAttribute('aria-label', (on ? 'Hide ' : 'Show ') + p.hex);
    eye.onclick = () => { it.hidden.has(i) ? it.hidden.delete(i) : it.hidden.add(i); renderPalette(); rebuildShapes(); };
    row.append(sw, hx, sh, eye); el.appendChild(row);
  });
  const bb = $('bgBtn');
  if (res.background >= res.palette.length) { bb.disabled = true; bb.textContent = 'Background is already transparent'; }
  else { bb.disabled = false; bb.textContent = it.bgOn ? 'Restore background' : 'Remove background'; }
}
$('bgBtn').onclick = () => { const it = item(); if (!it || st.busy) return; it.bgOn = !it.bgOn; renderPalette(); rebuildShapes(); };

function buildNodeCache(it) {
  const res = it.res, k = 1 / it.up, TL = res.transparentLabel, bgr = bgRegions(it);
  const vis = r => r >= 0 && res.regions[r].label !== TL && !it.hidden.has(res.regions[r].label) && !bgr.has(r);
  const anchors = [], handles = [], segs = new Path2D();
  res.chains.forEach((ch, ci) => {
    if (!vis(ch.right) && !vis(ch.left)) return;
    res.chainSegs[ci].forEach((b, j) => {
      if (j === 0) { anchors.push(b[0] * k, b[1] * k); segs.moveTo(b[0] * k, b[1] * k); }
      if (b.length === 4) segs.lineTo(b[2] * k, b[3] * k);
      else { segs.bezierCurveTo(b[2] * k, b[3] * k, b[4] * k, b[5] * k, b[6] * k, b[7] * k); handles.push(b[0] * k, b[1] * k, b[2] * k, b[3] * k, b[6] * k, b[7] * k, b[4] * k, b[5] * k); }
      anchors.push(b[b.length - 2] * k, b[b.length - 1] * k);
    });
  });
  st.nodes = { anchors, handles, segs };
}

const panes = [$('paneOrig'), $('paneVec')];
function layoutPanes() {
  const v = st.view;
  $('paneOrig').hidden = v === 'vector'; $('paneVec').hidden = v === 'original';
  $('panes').classList.toggle('single', v !== 'split');
  requestAnimationFrame(draw);
}
function activeSize() { const p = panes.find(p => !p.hidden && p.offsetWidth) || panes[1]; return [p.clientWidth, p.clientHeight]; }
function fit() {
  const it = item(); if (!it) return;
  const [w, h] = activeSize();
  st.zoom = Math.min((w - 40) / it.w, (h - 40) / it.h);
  st.tx = (w - it.w * st.zoom) / 2; st.ty = (h - it.h * st.zoom) / 2; draw();
}
function zoomAt(f, sx, sy) { const z = Math.max(0.05, Math.min(200, st.zoom * f)); f = z / st.zoom; st.tx = sx - (sx - st.tx) * f; st.ty = sy - (sy - st.ty) * f; st.zoom = z; draw(); }
$('zoomIn').onclick = () => { const [w, h] = activeSize(); zoomAt(1.5, w / 2, h / 2); };
$('zoomOut').onclick = () => { const [w, h] = activeSize(); zoomAt(1 / 1.5, w / 2, h / 2); };
$('fitBtn').onclick = fit;

const ptrs = new Map(); let pinch = null;
const toImg = (p, e) => { const r = p.getBoundingClientRect(); return [(e.clientX - r.left - st.tx) / st.zoom, (e.clientY - r.top - st.ty) / st.zoom]; };
panes.forEach(p => {
  p.addEventListener('wheel', e => { e.preventDefault(); const r = p.getBoundingClientRect(); zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
  p.addEventListener('pointerdown', e => {
    p.setPointerCapture(e.pointerId);
    if (st.fix && st.fix.stage === 'pick' && p.id === 'paneVec') { const q = toImg(p, e); st.fix.a = q; st.fix.b = q; st.fix.dragging = true; draw(); return; }
    ptrs.set(e.pointerId, [e.clientX, e.clientY]); p.classList.add('dragging'); pinch = null;
  });
  p.addEventListener('pointermove', e => {
    if (st.fix && st.fix.dragging) { st.fix.b = toImg(p, e); draw(); return; }
    if (!ptrs.has(e.pointerId)) return;
    const prev = ptrs.get(e.pointerId); ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]), r = p.getBoundingClientRect();
      const mx = (a[0] + b[0]) / 2 - r.left, my = (a[1] + b[1]) / 2 - r.top;
      if (pinch) { st.tx += mx - pinch.mx; st.ty += my - pinch.my; zoomAt(d / pinch.d, mx, my); }
      pinch = { d, mx, my };
    } else { st.tx += e.clientX - prev[0]; st.ty += e.clientY - prev[1]; draw(); }
  });
  const end = e => {
    if (st.fix && st.fix.dragging) {
      st.fix.dragging = false;
      const [a, b] = [st.fix.a, st.fix.b];
      if (Math.abs(a[0] - b[0]) * st.zoom < 8 || Math.abs(a[1] - b[1]) * st.zoom < 8) { st.fix.a = null; draw(); return; }
      st.fix.stage = 'choose'; $('fixOpts').hidden = false; $('fixMsg').textContent = 'How should this area change?';
      return;
    }
    ptrs.delete(e.pointerId); pinch = null; if (!ptrs.size) p.classList.remove('dragging');
  };
  p.addEventListener('pointerup', end); p.addEventListener('pointercancel', end);
  p.addEventListener('dblclick', () => { if (!st.fix) fit(); });
});
new ResizeObserver(() => draw()).observe($('panes'));

// ---------- fix an area (explicit mode: button, drag a box, choose a fix) ----------
$('fixBtn').onclick = () => {
  const it = item(); if (!it || !it.res || st.busy) return;
  if (st.view === 'original') { st.view = 'vector'; setSeg('viewMode', 'vector'); layoutPanes(); }
  st.fix = { stage: 'pick', a: null, b: null };
  $('fixBar').hidden = false; $('fixOpts').hidden = true; $('fixMsg').textContent = 'Drag a box around the area to fix. Press Esc to cancel.';
  $('paneVec').classList.add('fixing'); draw();
};
function exitFix() { st.fix = null; $('fixBar').hidden = true; $('paneVec').classList.remove('fixing'); draw(); }
$('fixCancel').onclick = exitFix;
document.addEventListener('keydown', e => { if (e.key === 'Escape' && st.fix) exitFix(); });
$('fixOpts').addEventListener('click', e => {
  const b = e.target.closest('button'); const it = item(); if (!b || !st.fix || !it) return;
  const [a, c] = [st.fix.a, st.fix.b], u = it.up;
  const rect = { x0: Math.min(a[0], c[0]) * u, y0: Math.min(a[1], c[1]) * u, x1: Math.max(a[0], c[0]) * u, y1: Math.max(a[1], c[1]) * u };
  const before = it.res.chainSegs.slice();
  const n = it.res.refit(rect, b.dataset.m);
  if (!n) { toast('No edges in that box to adjust. Try a bigger box.'); return; }
  it.fixes.push(before);
  exitFix(); rebuildShapes();
  toast(`Adjusted ${n} edge${n === 1 ? '' : 's'}. Use Undo fix to revert.`);
});
$('undoFixBtn').onclick = () => {
  const it = item(); if (!it || !it.fixes.length || st.busy) return;
  const prev = it.fixes.pop(); prev.forEach((s, i) => it.res.chainSegs[i] = s); rebuildShapes();
};

let raf = 0;
function draw() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; paint(); }); }
function prep(pane) {
  const c = pane.querySelector('canvas'), dpr = window.devicePixelRatio || 1, w = pane.clientWidth, h = pane.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const x = c.getContext('2d'); x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, c.width, c.height);
  x.setTransform(dpr * st.zoom, 0, 0, dpr * st.zoom, dpr * st.tx, dpr * st.ty); return x;
}
function paint() {
  $('zoomOutLbl').textContent = Math.round(st.zoom * 100) + '%';
  const it = item(); if (!it) return;
  if (!$('paneOrig').hidden) { const x = prep($('paneOrig')); x.imageSmoothingEnabled = st.zoom < 2; x.drawImage(it.img, 0, 0, it.w, it.h); }
  if (!$('paneVec').hidden) {
    const x = prep($('paneVec')), outline = $('outline').checked, px = 1 / st.zoom, css = getComputedStyle(document.documentElement);
    const ink = css.getPropertyValue('--ink').trim();
    if (!outline && it.res) for (const s of st.paths) {
      let paintStyle = s.fill;
      if (s.grad) { const g = x.createLinearGradient(s.grad.x1, s.grad.y1, s.grad.x2, s.grad.y2); s.grad.stops.forEach(t => g.addColorStop(t[0], t[1])); paintStyle = g; }
      if (s.stroke) { x.lineWidth = s.stroke; x.lineJoin = 'round'; x.strokeStyle = paintStyle; x.stroke(s.p); }
      else { x.fillStyle = paintStyle; x.fill(s.p, s.rule); }
    }
    if ((outline || $('showNodes').checked) && st.nodes) {
      const N = st.nodes; x.lineWidth = px; x.strokeStyle = outline ? ink : 'rgba(23,152,193,.9)'; x.stroke(N.segs);
      if ($('showNodes').checked) {
        const hc = css.getPropertyValue('--handle').trim(), ac = css.getPropertyValue('--anchor').trim();
        if (st.zoom > 1.2) {
          x.strokeStyle = hc; x.fillStyle = hc; x.beginPath();
          for (let i = 0; i < N.handles.length; i += 4) { x.moveTo(N.handles[i], N.handles[i + 1]); x.lineTo(N.handles[i + 2], N.handles[i + 3]); } x.stroke();
          const r = 2.2 * px; x.beginPath(); for (let i = 0; i < N.handles.length; i += 4) { x.moveTo(N.handles[i + 2] + r, N.handles[i + 3]); x.arc(N.handles[i + 2], N.handles[i + 3], r, 0, 6.2832); } x.fill();
        }
        const a = 3.2 * px; x.fillStyle = ac; x.strokeStyle = '#fff'; x.lineWidth = px * 0.8;
        x.beginPath(); for (let i = 0; i < N.anchors.length; i += 2) x.rect(N.anchors[i] - a / 2, N.anchors[i + 1] - a / 2, a, a); x.fill(); x.stroke();
      }
    }
    if (st.fix && st.fix.a) {
      const [a, b] = [st.fix.a, st.fix.b];
      x.lineWidth = 2 * px; x.setLineDash([6 * px, 4 * px]); x.strokeStyle = css.getPropertyValue('--handle').trim();
      x.fillStyle = 'rgba(214,36,110,.08)'; x.fillRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
      x.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])); x.setLineDash([]);
    }
  }
}

// ---------- export: SVG / PDF / EPS, sized to fit a 10 x 8 in artboard ----------
function fileFor(it, fmt) {
  const shapes = shapesFor(it), a = artSize(it), base = it.name.replace(/\.[^.]+$/, '') + '-vector';
  if (fmt === 'pdf') return { name: base + '.pdf', data: buildPDF(shapes, it.w, it.h, a), type: 'application/pdf' };
  if (fmt === 'eps') return { name: base + '.eps', data: buildEPS(shapes, it.w, it.h, a), type: 'application/postscript' };
  return { name: base + '.svg', data: VTrace.toSVG(it.res, shapes, it.w, it.h, { w: a.w, h: a.h }), type: 'image/svg+xml' };
}
// When the page runs inside Claude, downloads go through the host's save prompt. On a normal
// website (e.g. Netlify) window.claude doesn't exist and an ordinary browser download is used.
let dl = null;
(async () => { try { if (window.claude && window.claude.use) dl = await window.claude.use('downloads'); } catch (e) { dl = null; } })();
async function saveFile(name, data, type) {
  if (dl) { try { await dl.save({ filename: name, data }); toast('Downloaded ' + name); } catch (e) { if (e && e.code !== 'declined') toast('Download unavailable here. Use Copy SVG instead.'); } return; }
  try { const url = URL.createObjectURL(new Blob([data], { type })); const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000); }
  catch (e) { toast('Download is not available in this view. Use Copy SVG instead.'); }
}
$('dlBtn').onclick = async () => {
  if (st.busy || !item()) return;
  const fmt = $('fmt').value;
  if (st.items.length === 1) { const f = fileFor(item(), fmt); return saveFile(f.name, f.data, f.type); }
  // batch: make sure every logo is traced with the current settings, then zip them all
  cancelFlag = false; setBusy('Preparing…');
  try {
    const key = settingsKey(), files = [];
    for (let i = 0; i < st.items.length; i++) {
      const it = st.items[i];
      if (!it.res || it.key !== key) { $('busyText').textContent = `Tracing ${i + 1} of ${st.items.length}…`; await traceItem(it, `${i + 1} of ${st.items.length}`); }
      files.push(fileFor(it, fmt));
    }
    setBusy(null);
    await saveFile(`retrace-${fmt}-${st.items.length}-logos.zip`, makeZip(files), 'application/zip');
  } catch (err) {
    if (err && err.cancelled) toast('Batch download cancelled.'); else { console.error(err); toast('Batch export failed: ' + (err.message || err)); }
  } finally { setBusy(null); const it = item(); if (it && it.res) { renderPalette(); rebuildShapes(); } updateApplyBar(); }
};
$('copyBtn').onclick = async () => {
  if (!st.svg) return;
  try { await navigator.clipboard.writeText(st.svg); toast('Copied SVG to clipboard'); }
  catch (e) { const t = document.createElement('textarea'); t.value = st.svg; document.body.appendChild(t); t.select(); let ok = false; try { ok = document.execCommand('copy'); } catch (_) {} t.remove(); toast(ok ? 'Copied SVG to clipboard' : 'Copying is blocked here. Use Download.'); }
};

// ---------- clear workspace ----------
const DEFAULTS = { colors: 6, speck: 4, smooth: 1, corner: 66, straight: 3, reduce: 30 };
$('clearBtn').onclick = () => {
  if (st.busy) return;
  clearTimeout(retraceTimer); exitFix();
  Object.assign(st, { items: [], cur: -1, mode: 'stacked', view: 'split', passes: 6, outlines: false, gradients: false, shapes: [], paths: [], nodes: null, svg: '', zoom: 1, tx: 0, ty: 0 });
  $('autoColors').checked = true; for (const k in DEFAULTS) $(k).value = DEFAULTS[k];
  $('showNodes').checked = false; $('outline').checked = false;
  setSeg('layering', 'stacked'); setSeg('viewMode', 'split'); setSeg('quality', '6'); setSeg('outlines', 'filled'); setSeg('gradients', 'flat');
  $('palette').innerHTML = '<div class="hint">Open an image to see its colors.</div>';
  $('bgBtn').disabled = true; $('bgBtn').textContent = 'Remove background'; $('stats').textContent = '';
  $('dlBtn').disabled = $('copyBtn').disabled = $('clearBtn').disabled = $('fixBtn').disabled = true; $('undoFixBtn').hidden = true;
  panes.forEach(p => { const c = p.querySelector('canvas'); c.getContext('2d').clearRect(0, 0, c.width, c.height); });
  updateBatchNav(); $('batchNav').hidden = true; $('applyBar').hidden = true; syncHints(); syncLabels(); layoutPanes(); $('empty').hidden = false;
};
syncHints(); syncLabels(); layoutPanes();
})();

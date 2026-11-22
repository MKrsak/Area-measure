'use strict';

/* =========================================================================
   Area Measure – measure object area in a photo using a ruler as scale.
   - Optional: Chrome built-in AI (Prompt API / Gemini Nano with image input)
     locates the ruler and the main object.
   - Classic image analysis segments the object; the user can correct
     everything by hand.
   ========================================================================= */

const MAX_WORK = 1000; // long side of the processing image (px)

const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const ctx = canvas.getContext('2d');

const state = {
  W: 0, H: 0,
  workCanvas: null,   // image at processing resolution
  lab: null,          // Float32Array W*H*3, blurred CIELAB
  mask: null,         // Uint8Array W*H
  maskCanvas: null,
  ruler: null,        // {a:{x,y}, b:{x,y}}
  box: null,          // {x0,y0,x1,y1}
  seed: null,         // {x,y}
  lastMethod: 'box',  // 'box' | 'seed'
  mode: 'ruler',
  drag: null,
  objectName: '',
  pointer: null,
  src: null,          // original image
  G: null,            // grayscale for ruler analysis (lazy)
  periodPx: 0,        // detected tick spacing (work px)
  rulerSource: '',    // text describing where the scale came from
  objectSource: '',   // text describing how the object was found
  boxFromAI: false,
  busy: '',           // message shown over the image while working
};

/* ------------------------------------------------------------------ input */

$('cameraInput').addEventListener('change', onFile);
$('fileInput').addEventListener('change', onFile);

async function onFile(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    bmp = await loadViaImg(file);
  }
  await processPhoto(bmp, null);
}

// shared by the file inputs and the level camera (camera.js)
// tilt: degrees off level when the photo was taken (level camera), else null
async function processPhoto(bmp, tilt) {
  state.captureTilt = tilt;
  loadImage(bmp);
  await findRulerAuto();
  if (ai.status === 'available') await runAI();
}

function loadViaImg(file) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = URL.createObjectURL(file);
  });
}

function loadImage(src) {
  const sw = src.width, sh = src.height;
  const s = Math.min(1, MAX_WORK / Math.max(sw, sh));
  const W = Math.round(sw * s), H = Math.round(sh * s);
  const wc = document.createElement('canvas');
  wc.width = W; wc.height = H;
  const wctx = wc.getContext('2d', { willReadFrequently: true });
  wctx.drawImage(src, 0, 0, W, H);
  const data = wctx.getImageData(0, 0, W, H).data;

  Object.assign(state, {
    W, H, workCanvas: wc,
    lab: blurLab(toLab(data, W, H), W, H),
    feat: blurLab(toFeat(data, W, H), W, H),
    mask: new Uint8Array(W * H),
    maskCanvas: document.createElement('canvas'),
    seed: null, objectName: '', src, G: null, periodPx: 0, tickPx: 0, perTick: 1, persp: null, gmag: null, quad: null,
    rulerSource: 'not set – place the red handles on the ruler', boxFromAI: false,
    objectSource: 'image analysis (whole photo)',
  });
  state.maskCanvas.width = W; state.maskCanvas.height = H;

  // Default ruler: horizontal line in the lower part; default box: most of the image
  state.ruler = { a: { x: W * 0.3, y: H * 0.88 }, b: { x: W * 0.7, y: H * 0.88 } };
  const m = 0.04;
  state.box = { x0: W * m, y0: H * m, x1: W * (1 - m), y1: H * (1 - m) };

  canvas.width = W; canvas.height = H;
  $('workCard').classList.remove('hidden');
  $('aiResult').textContent = '';
  view.s = 1; view.ox = view.oy = 0;
  clearUndo();
  setMode('move');
  segmentBox();
}

/* ----------------------------------------------------------------- ruler */

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const autoScale = () => $('autoScale').checked;
const srcToWork = () => state.W / state.src.width;

function gray() {
  if (!state.G) state.G = Ruler.makeGray(state.src);
  return state.G;
}

// result from Ruler.* (source-image px) → handles + length
function applyRuler(res, how) {
  const k = srcToWork();
  state.ruler = { a: { x: res.a.x * k, y: res.a.y * k }, b: { x: res.b.x * k, y: res.b.y * k } };
  state.periodPx = res.periodPx * k;       // work px per mm (or 1/16 in)
  state.tickPx = res.tickPx * k;           // work px per visible tick
  state.perTick = res.perTick;             // mm per visible tick (1 or 5)
  state.rulerKind = res.kind;
  // how the scale changes along the ruler (tilted camera) – used per pixel
  state.persp = res.grad ? {
    cx: res.grad.c.x * k, cy: res.grad.c.y * k, dx: res.grad.d.x, dy: res.grad.d.y, rel: res.grad.rel / k,
  } : null;
  if (res.kind === 'unknown') {
    // ticks found, but not whether they are 1 mm, 5 mm or 1 cm apart
    state.rulerSource = `${how}: handles placed on tick marks, but their spacing is unclear – type the real distance between the handles`;
    return;
  }
  if (autoScale()) setLengthFromTicks(res.ticks);
  state.rulerSource = `${how}: ${res.kind} ticks, ${res.tickPx.toFixed(1)} px apart in the photo – check the handles`;
}

const imperial = () => $('unit').value === 'in';
const maxSide = () => Math.max(state.src.width, state.src.height);

// assumes 1 mm ticks (metric) or 1/16 in ticks (inch)
function setLengthFromTicks(n) {
  const unit = $('unit').value;
  const v = unit === 'in' ? n / 16 : unit === 'mm' ? n : n / 10;
  $('rulerLen').value = +v.toFixed(4);
}

async function findRulerAuto() {
  setBusy('📏 Reading the ruler tick marks…');
  await nextFrame();
  try {
    // 1. rough location on a reduced image, 2. zoom in on it at full resolution
    const coarse = Ruler.detect(gray());
    let res = null;
    if (coarse) {
      setBusy('🔍 Zooming in on the ruler…');
      await nextFrame();
      res = Ruler.zoomRefine(state.src, coarse.a, coarse.b,
        { hintPx: coarse.tickPx, half: Math.max(15, coarse.tickPx * 4), imperial: imperial() });
    }
    res = res || coarse;
    if (res) applyRuler(res, 'Found automatically');
    else state.rulerSource = 'ruler not found automatically – drag the red line roughly onto the ruler (it zooms in and reads the ticks), or set the handles and length by hand';
  } catch (err) {
    console.error(err);
    state.rulerSource = `ruler detection failed (${err && err.message ? err.message : err}) – place the handles by hand`;
  }
  setBusy('');
  resegment();
  if (rulerOnObject()) resegment();
}

// A ruler lying on the object (and hanging over its edge) is only flat and at
// the right height on the object: read the scale from that part alone.
function rulerOnObject() {
  if (!state.tickPx || !state.ruler || !autoScale()) return false;
  const { a, b } = state.ruler, { W, H, mask } = state;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 10) return false;
  // extend a little beyond the handles: the ticks often continue
  const ext = len * 0.1, dx = (b.x - a.x) / len, dy = (b.y - a.y) / len;
  let run = 0, best = [0, 0], start = 0;
  const T0 = -ext, T1 = len + ext;
  for (let t = T0; t <= T1 + 1; t++) {
    const x = Math.round(a.x + dx * t), y = Math.round(a.y + dy * t);
    const inside = t <= T1 && x >= 0 && y >= 0 && x < W && y < H && mask[y * W + x];
    if (inside) { if (!run) start = t; run++; }
    else { if (run > best[1] - best[0]) best = [start, t - 1]; run = 0; }
  }
  const mm = state.periodPx, inLen = (best[1] - best[0]) / mm, total = (T1 - T0) / mm;
  if (inLen < 100 || total - inLen < 20) return false;   // ≥ 10 cm on the object, ≥ 2 cm off it
  const k = srcToWork(), m = 3 * mm;                     // stay 3 mm away from the object's edge
  const A = { x: (a.x + dx * (best[0] + m)) / k, y: (a.y + dy * (best[0] + m)) / k };
  const B = { x: (a.x + dx * (best[1] - m)) / k, y: (a.y + dy * (best[1] - m)) / k };
  let res = null;
  try {
    res = Ruler.zoomRefine(state.src, A, B, { hintPx: state.tickPx / k, half: Math.max(15, state.tickPx / k * 4), imperial: imperial(), exact: true });
  } catch (err) { console.error(err); }
  if (!res || res.kind === 'unknown' || res.ticks < 80) return false;
  applyRuler(res, 'Read on the part of the ruler lying on the object');
  return true;
}

// after the user moved the ruler: re-read ticks near the new position
function rulerAfterUserMove(d) {
  if (!autoScale()) { state.rulerSource = 'set manually'; return; }
  const k = srcToWork();
  const toSrc = (p) => ({ x: p.x / k, y: p.y / k });
  try {
    if (d.type === 'handle' && state.tickPx) {
      const other = d.h === state.ruler.a ? state.ruler.b : state.ruler.a;
      const s = Ruler.snap(state.src, toSrc(d.h), toSrc(other), state.tickPx / k);
      d.h.x = s.x * k; d.h.y = s.y * k;
      if (state.rulerKind === 'unknown') { state.rulerSource = 'handle snapped to a tick – type the real distance between the handles'; return; }
      const n = ticksBetweenHandles();
      setLengthFromTicks(n);
      state.rulerSource = `handle snapped to the nearest tick: ${n} ${imperial() ? '× 1/16 in' : 'mm'} – check it`;
      return;
    }
    const res = Ruler.zoomRefine(state.src, toSrc(state.ruler.a), toSrc(state.ruler.b),
      { half: Math.max(15, maxSide() * 0.015), imperial: imperial() });
    if (res) applyRuler(res, 'Ticks read along your line');
    else state.persp = null, state.rulerSource = 'no tick marks recognised along the line – set the handles on two marks and type their distance';
  } catch (err) {
    console.error(err);
    state.rulerSource = `reading the ticks failed (${err && err.message ? err.message : err}) – type the length by hand`;
  }
}

function ticksBetweenHandles() {
  const r = state.ruler;
  return Math.round(Math.hypot(r.b.x - r.a.x, r.b.y - r.a.y) / state.tickPx) * (state.perTick || 1);
}

function resegment() {
  if (state.lastMethod === 'seed' && state.seed) segmentSeed(); else segmentBox();
}

/* ------------------------------------------------------------ color math */

function toLab(rgba, W, H) {
  const n = W * H;
  const out = new Float32Array(n * 3);
  const lin = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    lin[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  for (let i = 0; i < n; i++) {
    const r = lin[rgba[i * 4]], g = lin[rgba[i * 4 + 1]], b = lin[rgba[i * 4 + 2]];
    const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
    const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
    const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
    const fx = f(x), fy = f(y), fz = f(z);
    out[i * 3] = 116 * fy - 16;
    out[i * 3 + 1] = 500 * (fx - fy);
    out[i * 3 + 2] = 200 * (fy - fz);
  }
  return out;
}

// Chromaticity (which color, independent of brightness) and log brightness.
// Shadows and the light/dark relief of a textured cloth change brightness but
// hardly the chromaticity.
const CHROMA = 600, BRIGHT = 40;
function toFeat(rgba, W, H) {
  const n = W * H, out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4] + 3, g = rgba[i * 4 + 1] + 3, b = rgba[i * 4 + 2] + 3, s = r + g + b;
    out[i * 3] = CHROMA * r / s;
    out[i * 3 + 1] = CHROMA * g / s;
    out[i * 3 + 2] = BRIGHT * Math.log(s / 3);
  }
  return out;
}

// local standard deviation of brightness (texture measure), window (2r+1)²
function localStd(lab, W, H, r) {
  const S = new Float64Array((W + 1) * (H + 1)), S2 = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let a = 0, b = 0;
    for (let x = 0; x < W; x++) {
      const v = lab[(y * W + x) * 3];
      a += v; b += v * v;
      const k = (y + 1) * (W + 1) + x + 1;
      S[k] = S[k - W - 1] + a; S2[k] = S2[k - W - 1] + b;
    }
  }
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const ya = Math.max(0, y - r), yb = Math.min(H, y + r + 1), xa = Math.max(0, x - r), xb = Math.min(W, x + r + 1);
    const n = (yb - ya) * (xb - xa);
    const q = (A) => A[yb * (W + 1) + xb] - A[ya * (W + 1) + xb] - A[yb * (W + 1) + xa] + A[ya * (W + 1) + xa];
    const m = q(S) / n;
    out[y * W + x] = Math.sqrt(Math.max(0, q(S2) / n - m * m));
  }
  return out;
}

// separable box blur, radius 2, to reduce noise / texture
function blurLab(src, W, H) {
  const r = 2;
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s0 = 0, s1 = 0, s2 = 0, c = 0;
      for (let k = -r; k <= r; k++) {
        const xx = x + k;
        if (xx < 0 || xx >= W) continue;
        const j = (y * W + xx) * 3;
        s0 += src[j]; s1 += src[j + 1]; s2 += src[j + 2]; c++;
      }
      const i = (y * W + x) * 3;
      tmp[i] = s0 / c; tmp[i + 1] = s1 / c; tmp[i + 2] = s2 / c;
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s0 = 0, s1 = 0, s2 = 0, c = 0;
      for (let k = -r; k <= r; k++) {
        const yy = y + k;
        if (yy < 0 || yy >= H) continue;
        const j = (yy * W + x) * 3;
        s0 += tmp[j]; s1 += tmp[j + 1]; s2 += tmp[j + 2]; c++;
      }
      const i = (y * W + x) * 3;
      out[i] = s0 / c; out[i + 1] = s1 / c; out[i + 2] = s2 / c;
    }
  }
  return out;
}

/* ---------------------------------------------------------- segmentation */

function sensitivity() { return parseFloat($('sensitivity').value) || 1; }

// Object inside a box: background model from a ring around the box,
// Otsu threshold on color distance, best connected component, holes filled.

// shadowMode: 2 = ignore shadows, 1 = only light shadows, 0 = off (fallbacks
// for dark grey objects on a grey background, which look like a shadow)
function segmentBox(shadowMode = 2) {
  state.lastMethod = 'box';
  const { W, H, lab } = state;
  // an AI box is only approximate: analyse the whole photo and use the box
  // just to pick the right shape; a box drawn by the user limits the analysis
  const hint = normBox(state.box);
  const b = state.boxFromAI ? { x0: 0, y0: 0, x1: W - 1, y1: H - 1 } : hint;
  const x0 = Math.max(0, Math.floor(b.x0)), y0 = Math.max(0, Math.floor(b.y0));
  const x1 = Math.min(W - 1, Math.ceil(b.x1)), y1 = Math.min(H - 1, Math.ceil(b.y1));
  if (x1 - x0 < 4 || y1 - y0 < 4) return;

  // 1. background samples: ring just outside the box (or inside if at the image edge)
  const ring = Math.max(4, Math.round(0.03 * Math.max(x1 - x0, y1 - y0)));
  const samples = [], fsamples = [];
  const feat = state.feat;
  const step = Math.max(1, Math.round(Math.sqrt(((x1 - x0) + (y1 - y0)) * 2 * ring / 3000)));
  const addSample = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 3;
    samples.push(lab[i], lab[i + 1], lab[i + 2]);
    fsamples.push(feat[i], feat[i + 1], feat[i + 2]);
  };
  // sides where the box touches the image edge have no outside ring:
  // there, sample a thin band just inside the box instead
  const edgeL = x0 < ring, edgeT = y0 < ring, edgeR = x1 > W - 1 - ring, edgeB = y1 > H - 1 - ring;
  for (let y = y0 - ring; y <= y1 + ring; y += step) {
    for (let x = x0 - ring; x <= x1 + ring; x += step) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const outside = x < x0 || x > x1 || y < y0 || y > y1;
      const band = (edgeL && x < x0 + ring) || (edgeR && x > x1 - ring) ||
                   (edgeT && y < y0 + ring) || (edgeB && y > y1 - ring);
      if (outside || band) addSample(x, y);
    }
  }
  if (samples.length < 30) {
    for (let x = x0; x <= x1; x += step) { addSample(x, y0); addSample(x, y1); }
    for (let y = y0; y <= y1; y += step) { addSample(x0, y); addSample(x1, y); }
  }
  // drop rare colors at the border (other objects cut by the image edge)
  const km = kmeans(samples, 8, 12);
  const nS = samples.length / 3;
  const keep = [];
  for (let j = 0; j < km.counts.length; j++)
    if (km.counts[j] >= nS * 0.06) keep.push(km.centers[j * 3], km.centers[j * 3 + 1], km.centers[j * 3 + 2]);
  const centers = keep.length ? keep : Array.from(km.centers);
  // 2. distance of each box pixel to the nearest background cluster
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const dist = new Float32Array(bw * bh);
  let maxD = 0;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const i = ((y + y0) * W + (x + x0)) * 3;
      let best = Infinity;
      for (let c = 0; c < centers.length; c += 3) {
        const d0 = lab[i] - centers[c], d1 = lab[i + 1] - centers[c + 1], d2 = lab[i + 2] - centers[c + 2];
        const d = d0 * d0 + d1 * d1 + d2 * d2;
        if (d < best) best = d;
      }
      const d = Math.sqrt(best);
      dist[y * bw + x] = d;
      if (d > maxD) maxD = d;
    }
  }

  // 3. Otsu threshold
  let thr = Math.max(4, otsu(dist, maxD)) / sensitivity();
  // two levels: clear object colors start the object, weaker differences
  // (pale rim of a box, light parts of the print) join when connected to it
  const bgD = [];
  for (let i = 0; i < samples.length; i += 3) {
    let best = Infinity;
    for (let c = 0; c < centers.length; c += 3)
      best = Math.min(best, (samples[i] - centers[c]) ** 2 + (samples[i + 1] - centers[c + 1]) ** 2 + (samples[i + 2] - centers[c + 2]) ** 2);
    bgD.push(Math.sqrt(best));
  }
  bgD.sort((a, b) => a - b);
  const bgP97 = bgD[Math.floor(bgD.length * 0.97)] || 0;
  const thrLow = Math.min(thr, Math.max(4, bgP97 * 1.3, thr * 0.4) / sensitivity());
  let fg = new Uint8Array(bw * bh);
  for (let i = 0; i < fg.length; i++) fg[i] = dist[i] > thr ? 1 : 0;
  // background-likeness of every pixel, for the rectangle fitting
  state.bgLike = new Uint8Array(W * H);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++)
    if (dist[y * bw + x] <= thrLow) state.bgLike[(y + y0) * W + x + x0] = 1;

  // 3b. ignore background that only looks different because of light:
  //     same chromaticity as the background, but darker (shadow) or brighter
  //     and textured (relief of the cloth, glare on a rough surface)
  const bgVar = shadowMode ? backgroundVariation(fsamples, x0, y0, bw, bh, shadowMode) : new Uint8Array(bw * bh);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++)
    if (bgVar[y * bw + x]) state.bgLike[(y + y0) * W + x + x0] = 1;
  for (let i = 0; i < fg.length; i++) if (fg[i] && bgVar[i]) fg[i] = 0;
  {
    const stack = new Int32Array(bw * bh);
    let sp = 0;
    for (let i = 0; i < fg.length; i++) if (fg[i]) stack[sp++] = i;
    while (sp) {
      const i = stack[--sp], x = i % bw, y = (i / bw) | 0;
      for (const j of [x > 0 ? i - 1 : -1, x < bw - 1 ? i + 1 : -1, y > 0 ? i - bw : -1, y < bh - 1 ? i + bw : -1]) {
        if (j < 0 || fg[j] || bgVar[j] || dist[j] <= thrLow) continue;
        fg[j] = 1; stack[sp++] = j;
      }
    }
  }

  // 4. add strong edges – they close the outline where the object's color
  //    is similar to the background (e.g. a light part of a book cover)
  const edges = edgeMap(x0, y0, bw, bh);
  for (let i = 0; i < fg.length; i++) if (edges[i]) fg[i] = 1;

  // the ruler itself is never the object (it often lies right next to it)
  const rm = rulerMask();
  if (rm) for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++)
    if (rm[(y + y0) * W + (x + x0)]) fg[y * bw + x] = 0;
  if (rm) fillUnderRuler(fg, rm, x0, y0, bw, bh);

  // 5. close small gaps in the outline, fill everything enclosed by it,
  //    then open to cut thin bridges (background texture, the ruler …)
  const rc = Math.max(2, Math.round(Math.max(bw, bh) * 0.006));
  fg = erode(dilate(fg, bw, bh, rc), bw, bh, rc);
  fillHoles(fg, bw, bh);
  fg = dropBorderPattern(fg, x0, y0, bw, bh) || fg;
  const ro = Math.max(2, Math.round(Math.max(bw, bh) * 0.008));
  fg = dilate(erode(fg, bw, bh, ro), bw, bh, ro);

  // 6. pick the most "obvious" component: large and near the box center
  const local = { x0: hint.x0 - x0, y0: hint.y0 - y0, x1: hint.x1 - x0, y1: hint.y1 - y0 };
  let comp = bestComponent(fg, bw, bh, state.boxFromAI ? local : null);
  if (!comp) { state.mask.fill(0); update(); return; }

  fillHoles(comp, bw, bh);
  // edges/closing make the outline a few px too fat: in a thin band along the
  // border, drop pixels whose color matches the background
  const inner = erode(comp, bw, bh, 3);
  for (let i = 0; i < comp.length; i++)
    if (comp[i] && !inner[i] && (dist[i] <= thr || bgVar[i])) comp[i] = 0;
  comp = bestComponent(comp, bw, bh, state.boxFromAI ? local : null) || comp;
  fillHoles(comp, bw, bh);
  if ($('convex').checked) comp = convexFill(comp, bw, bh);
  if (rm) for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++)
    if (rm[(y + y0) * W + (x + x0)]) comp[y * bw + x] = 0;
  if (rm) fillUnderRuler(comp, rm, x0, y0, bw, bh);

  // (almost) nothing left? the object probably looked like a shadow – retry milder
  let cnt = 0;
  for (const v of comp) cnt += v;
  if (shadowMode && cnt < bw * bh * 0.01) return segmentBox(shadowMode - 1);

  state.mask.fill(0);
  for (let y = 0; y < bh; y++)
    for (let x = 0; x < bw; x++)
      if (comp[y * bw + x]) state.mask[(y + y0) * W + (x + x0)] = 1;

  // boxes, books, paper …: straighten the outline to a quadrilateral whose
  // sides sit on the photo's edges (exact corners, tape / glare / bumps ignored)
  state.quad = null;
  state.objectSource = state.objectSource.replace(/ · straightened.*$/, '');
  if ($('rectFit').checked) {
    const q = fitQuad(state.mask, W, H);
    if (q) {
      state.quad = q;
      state.mask = polygonMask(q, W, H);
      state.objectSource += ' · straightened to a rectangle';
    }
  }
  update();
}

/* ------------------------------------------------- rectangle fitting */

function polygonMask(pts, W, H) {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.fillStyle = '#fff'; x.beginPath();
  pts.forEach((p, i) => (i ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y)));
  x.closePath(); x.fill();
  const d = x.getImageData(0, 0, W, H).data;
  c.width = c.height = 0;
  const m = new Uint8Array(W * H);
  for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3] > 127 ? 1 : 0;
  return m;
}

function polyArea(p) {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i].x * q.y - q.x * p[i].y; }
  return Math.abs(a) / 2;
}

// color gradient magnitude of the whole working image (cached)
function gradMag() {
  if (state.gmag) return state.gmag;
  const { W, H, lab } = state, g = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    let s = 0;
    for (let c = 0; c < 3; c++) {
      const at = (dx, dy) => lab[((y + dy) * W + x + dx) * 3 + c];
      const gx = at(1, -1) + 2 * at(1, 0) + at(1, 1) - at(-1, -1) - 2 * at(-1, 0) - at(-1, 1);
      const gy = at(-1, 1) + 2 * at(0, 1) + at(1, 1) - at(-1, -1) - 2 * at(0, -1) - at(1, -1);
      s += (c ? 0.8 : 1) * (gx * gx + gy * gy);
    }
    g[y * W + x] = Math.sqrt(s);
  }
  return (state.gmag = g);
}

function fitQuad(mask, W, H) {
  // convex hull of the shape
  const pts = [];
  let area = 0;
  for (let y = 0; y < H; y++) {
    let l = -1, r = -1;
    for (let x = 0; x < W; x++) if (mask[y * W + x]) { area++; if (l < 0) l = x; r = x; }
    if (l >= 0) { pts.push({ x: l, y }); if (r !== l) pts.push({ x: r + 1, y }); }
  }
  if (pts.length < 8 || area < 500) return null;
  pts.sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo = [], up = [];
  for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  let hull = lo.slice(0, -1).concat(up.slice(0, -1));
  if (hull.length < 4) return null;
  // simplify the hull to 4 corners (drop the vertex that matters least)
  while (hull.length > 4) {
    let bi = 0, ba = Infinity;
    for (let i = 0; i < hull.length; i++) {
      const a = hull[(i + hull.length - 1) % hull.length], b = hull[i], c = hull[(i + 1) % hull.length];
      const t = Math.abs(cross(a, b, c));
      if (t < ba) { ba = t; bi = i; }
    }
    hull.splice(bi, 1);
  }
  // is the shape really a quadrilateral?
  const qa = polyArea(hull);
  if (area / qa < 0.93 || area / qa > 1.06) return null;
  // corners must be clearly separated (no triangles / slivers)
  for (let i = 0; i < 4; i++) {
    const a = hull[i], b = hull[(i + 1) % 4];
    if (Math.hypot(b.x - a.x, b.y - a.y) < Math.sqrt(qa) * 0.25) return null;
  }
  // move every side onto the strongest nearby edge and fit a straight line
  const g = gradMag(), bgL = state.bgLike;
  const cx = hull.reduce((s, p) => s + p.x, 0) / 4, cy = hull.reduce((s, p) => s + p.y, 0) / 4;
  const R = Math.max(4, Math.round(Math.max(W, H) * 0.012));
  const lines = [];
  for (let i = 0; i < 4; i++) {
    const P = hull[i], Q = hull[(i + 1) % 4];
    const len = Math.hypot(Q.x - P.x, Q.y - P.y);
    const d = { x: (Q.x - P.x) / len, y: (Q.y - P.y) / len };
    let n = { x: -d.y, y: d.x };
    if ((P.x + Q.x) / 2 * n.x + (P.y + Q.y) / 2 * n.y < cx * n.x + cy * n.y) n = { x: -n.x, y: -n.y };   // outward
    const found = [];
    const N = Math.max(20, Math.round(len / 3));
    for (let k = 0; k <= N; k++) {
      const t = 0.08 + 0.84 * k / N;
      const bx = P.x + (Q.x - P.x) * t, by = P.y + (Q.y - P.y) * t;
      // edge candidates along the normal; prefer the outermost clear edge
      // with background right outside it (not the inner border of a print)
      const prof = [];
      for (let s2 = -R; s2 <= R; s2++) {
        const X = Math.round(bx + n.x * s2), Y = Math.round(by + n.y * s2);
        prof.push(X < 1 || Y < 1 || X >= W - 1 || Y >= H - 1 ? 0 : g[Y * W + X]);
      }
      let mx = 0;
      for (const v of prof) mx = Math.max(mx, v);
      if (!mx) continue;
      const bgAt = (s2) => {
        const X = Math.round(bx + n.x * s2), Y = Math.round(by + n.y * s2);
        return X >= 0 && Y >= 0 && X < W && Y < H && bgL && bgL[Y * W + X] === 1;
      };
      let bs = null, bw2 = 0;
      for (let j = prof.length - 2; j >= 1; j--) {
        const v = prof[j];
        if (v < mx * 0.3 || v < prof[j - 1] || v < prof[j + 1]) continue;   // local maximum, strong enough
        const s2 = j - R;
        if (bgAt(s2 + 2) && bgAt(s2 + 3)) { bs = s2; bw2 = v; break; }
      }
      if (bs === null) {                                     // fall back: strongest edge near the outline
        let best = 0;
        for (let j = 0; j < prof.length; j++) {
          const v = prof[j] * Math.exp(-0.5 * ((j - R) / (R * 0.7)) ** 2);
          if (v > best) { best = v; bs = j - R; bw2 = prof[j]; }
        }
      }
      if (bs !== null) found.push({ x: bx + n.x * bs, y: by + n.y * bs, w: bw2 });
    }
    if (found.length < 8) return null;
    const ws = found.map((f) => f.w).sort((a, b) => a - b), wMed = ws[ws.length >> 1];
    let use = found.filter((f) => f.w > wMed * 0.4);
    let L = null;
    for (let it = 0; it < 3; it++) {
      L = fitLine(use);
      if (!L) return null;
      const res = use.map((f) => Math.abs((f.x - L.px) * L.nx + (f.y - L.py) * L.ny));
      const sr = res.slice().sort((a, b) => a - b), mr = sr[sr.length >> 1];
      const keep = use.filter((f, j) => res[j] <= Math.max(1.5, mr * 2.5));
      if (keep.length < 6 || keep.length === use.length) break;
      use = keep;
    }
    lines.push(L);
  }
  const corners = [];
  for (let i = 0; i < 4; i++) {
    const a = lines[(i + 3) % 4], b = lines[i];
    const det = a.nx * b.ny - a.ny * b.nx;
    if (Math.abs(det) < 0.2) return null;                  // sides nearly parallel
    const ca = a.nx * a.px + a.ny * a.py, cb = b.nx * b.px + b.ny * b.py;
    corners.push({ x: (ca * b.ny - cb * a.ny) / det, y: (a.nx * cb - b.nx * ca) / det });
  }
  const na = polyArea(corners);
  if (na / qa < 0.9 || na / qa > 1.12) return null;
  for (const c of corners) if (c.x < -2 || c.y < -2 || c.x > W + 1 || c.y > H + 1) return null;
  return corners;
}

// total least squares line through points → point (px,py) and unit normal
function fitLine(ps) {
  if (ps.length < 2) return null;
  let mx = 0, my = 0;
  for (const p of ps) { mx += p.x; my += p.y; }
  mx /= ps.length; my /= ps.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of ps) { sxx += (p.x - mx) ** 2; syy += (p.y - my) ** 2; sxy += (p.x - mx) * (p.y - my); }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);          // direction of the line
  return { px: mx, py: my, nx: -Math.sin(ang), ny: Math.cos(ang) };
}

// Pixels of the ruler/tape body: walk across the ruler from the tick line
// while pixels look like the ruler (its body color, or dark ticks/digits),
// and along it beyond the detected ticks.
function rulerMask() {
  if (!state.periodPx || !state.ruler) return null;
  const { W, H, lab } = state;
  const { a, b } = state.ruler;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 10) return null;
  const d = { x: (b.x - a.x) / len, y: (b.y - a.y) / len }, n = { x: -d.y, y: d.x };
  const mm = state.periodPx;
  const px = (t, o) => {
    const x = Math.round(a.x + d.x * t + n.x * o), y = Math.round(a.y + d.y * t + n.y * o);
    return x < 0 || y < 0 || x >= W || y >= H ? -1 : (y * W + x) * 3;
  };
  // body color: brighter half of the pixels around the tick line
  const cs = [];
  for (let t = 0; t <= len; t += 2) for (let o = -2 * mm; o <= 2 * mm; o += 2) {
    const i = px(t, o);
    if (i >= 0) cs.push([lab[i], lab[i + 1], lab[i + 2]]);
  }
  if (cs.length < 10) return null;
  cs.sort((p, q) => p[0] - q[0]);
  const bright = cs.slice(cs.length >> 1);
  const med = (k) => bright.map((c) => c[k]).sort((p, q) => p - q)[bright.length >> 1];
  const body = [med(0), med(1), med(2)];
  // 2 = ruler body color, 1 = dark (ticks, digits), 0 = something else
  const kind = (i) => {
    if (i < 0) return 0;
    const dL = lab[i] - body[0], dA = lab[i + 1] - body[1], dB = lab[i + 2] - body[2];
    if (dL * dL + dA * dA + dB * dB < 18 * 18) return 2;
    return lab[i] < body[0] - 25 ? 1 : 0;
  };
  const like = (i) => kind(i) === 2;
  const maxO = 45 * mm, gapMax = Math.max(3, 2 * mm);
  // width on both sides
  const ext = {};
  for (const side of [1, -1]) {
    const v = [];
    for (let t = 0; t <= len; t += Math.max(3, 5 * mm)) {
      // dark pixels count only in short runs (ticks, digits) – a long dark run
      // is a neighbouring object, not the ruler
      let last = 0, gap = 0, dark = 0;
      for (let o = 0; o <= maxO; o++) {
        const kd = kind(px(t, side * o));
        if (kd === 2) { last = o; gap = 0; dark = 0; }
        else if (kd === 1 && ++dark <= 4 * mm) { gap = 0; }
        else if (++gap > gapMax) break;
      }
      v.push(last);
    }
    v.sort((p, q) => p - q);
    ext[side] = v[v.length >> 1] || 0;
  }
  const pad = 2 + 3 * mm;                 // plus the shadow / gap next to it, and a bent tape
  const o0 = -ext[-1] - pad, o1 = ext[1] + pad;
  // extend along the ruler while a cross-section still looks like the ruler
  const along = (dir) => {
    let last = dir > 0 ? len : 0, gap = 0;
    for (let t = last; t > -2 * (W + H) && t < 2 * (W + H); t += dir) {
      let c = 0, all = 0;
      for (let o = o0; o <= o1; o += 2) { const i = px(t, o); if (i >= 0) { all++; if (like(i)) c++; } }
      if (!all) break;
      if (c / all > 0.5) { last = t; gap = 0; } else if (++gap > 4 * mm + 3) break;
    }
    return last;
  };
  const tA = along(-1) - 2, tB = along(1) + 2;
  const m = new Uint8Array(W * H);
  for (let t = tA; t <= tB; t += 0.5) for (let o = o0; o <= o1; o += 0.5) {
    const i = px(t, o);
    if (i >= 0) m[i / 3] = 1;
  }
  m.geom = { a, d, n, o0, o1 };
  return m;
}

// The ruler may lie ON the object (best for thick objects): where the object
// continues on both sides of the ruler strip, the strip belongs to the object.
function fillUnderRuler(comp, rm, x0, y0, bw, bh) {
  const { W, H } = state, g = rm.geom, gap = 4;
  const inRm = (X, Y) => {
    const x = Math.round(X), y = Math.round(Y);
    return x >= 0 && y >= 0 && x < W && y < H && rm[y * W + x] === 1;
  };
  const inC = (X, Y) => {
    const x = Math.round(X) - x0, y = Math.round(Y) - y0;
    return x >= 0 && y >= 0 && x < bw && y < bh && comp[y * bw + x] === 1;
  };
  // from a strip pixel, walk across to the local edge of the strip, look just beyond
  const side = (X, Y, sx, sy) => {
    let k = 0;
    const maxK = (g.o1 - g.o0) + 2;
    while (k < maxK && inRm(X + sx * k, Y + sy * k)) k++;
    for (let j = 1; j <= gap; j++) if (inC(X + sx * (k + j), Y + sy * (k + j))) return true;
    return false;
  };
  const add = [];
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    if (!rm[(y + y0) * W + x + x0] || comp[y * bw + x]) continue;
    const X = x + x0, Y = y + y0;
    if (side(X, Y, g.n.x, g.n.y) && side(X, Y, -g.n.x, -g.n.y)) add.push(y * bw + x);
  }
  for (const i of add) comp[i] = 1;
}

// 1 where a pixel is background seen in different light (see segmentBox 3b)
function backgroundVariation(fsamples, x0, y0, bw, bh, mode) {
  const { W, feat, lab } = state;
  const km = kmeans(fsamples, 6, 10);
  const nS = fsamples.length / 3, cs = [];
  for (let j = 0; j < km.counts.length; j++)
    if (km.counts[j] >= nS * 0.06) cs.push(km.centers[j * 3], km.centers[j * 3 + 1], km.centers[j * 3 + 2]);
  if (!cs.length) return new Uint8Array(bw * bh);
  const nearest = (a, b) => {
    let bd = Infinity, bc = 0;
    for (let c = 0; c < cs.length; c += 3) {
      const d = (a - cs[c]) ** 2 + (b - cs[c + 1]) ** 2;
      if (d < bd) { bd = d; bc = c; }
    }
    return [Math.sqrt(bd), bc];
  };
  // how much the background's chromaticity scatters by itself
  const sd = [];
  for (let i = 0; i < fsamples.length; i += 3) sd.push(nearest(fsamples[i], fsamples[i + 1])[0]);
  sd.sort((a, b) => a - b);
  const thrC = Math.max(4, 1.8 * (sd[Math.floor(sd.length * 0.9)] || 0)) * sensitivity();
  const std = localStd(lab, state.W, state.H, 3);
  const DARKER = BRIGHT * Math.log(0.95), DARKEST = BRIGHT * Math.log(mode === 2 ? 0.3 : 0.8);
  const BRIGHTER = BRIGHT * Math.log(1.05), TEXTURE = 3;
  const out = new Uint8Array(bw * bh);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const p = (y + y0) * W + x + x0, i = p * 3;
    const [dc, c] = nearest(feat[i], feat[i + 1]);
    if (dc > thrC) continue;
    const db = feat[i + 2] - cs[c + 2];
    if ((db < DARKER && db > DARKEST) || (db > BRIGHTER && std[p] > TEXTURE)) out[y * bw + x] = 1;
  }
  return out;
}

// A background pattern (a stripe of a tablecloth …) that touches the object
// usually also runs off the edge of the analysed area. Starting at the border,
// remove the part of the shape that is reachable through similar colors; an
// object with a clearly different color stops it.
function dropBorderPattern(comp, x0, y0, bw, bh, tol = 7) {
  const { W, lab } = state;
  const seeds = [];
  for (let x = 0; x < bw; x++) seeds.push(x, (bh - 1) * bw + x);
  for (let y = 1; y < bh - 1; y++) seeds.push(y * bw, y * bw + bw - 1);
  const s0 = seeds.filter((i) => comp[i]);
  let total = 0;
  for (const v of comp) total += v;
  if (s0.length < 5 || !total) return null;
  const L = (i) => (((i / bw) | 0) + y0) * W + (i % bw) + x0;
  // colors of the shape where it touches the border
  const smp = [];
  for (const i of s0) { const p = L(i) * 3; smp.push(lab[p], lab[p + 1], lab[p + 2]); }
  const km = kmeans(smp, Math.min(4, s0.length), 8), cs = km.centers;
  const TOL2 = (tol * sensitivity()) ** 2, STEP2 = (tol * 0.57) ** 2;
  const near = (p) => {
    for (let c = 0; c < cs.length; c += 3) {
      const d = (lab[p] - cs[c]) ** 2 + (lab[p + 1] - cs[c + 1]) ** 2 + (lab[p + 2] - cs[c + 2]) ** 2;
      if (d < TOL2) return true;
    }
    return false;
  };
  const seen = new Uint8Array(bw * bh), stack = new Int32Array(bw * bh);
  let sp = 0, removed = 0;
  for (const i of s0) if (near(L(i) * 3)) { seen[i] = 1; stack[sp++] = i; }
  while (sp) {
    const i = stack[--sp], x = i % bw, y = (i / bw) | 0, p = L(i) * 3;
    removed++;
    for (const j of [x > 0 ? i - 1 : -1, x < bw - 1 ? i + 1 : -1, y > 0 ? i - bw : -1, y < bh - 1 ? i + bw : -1]) {
      if (j < 0 || seen[j] || !comp[j]) continue;
      const q = L(j) * 3;
      const st = (lab[q] - lab[p]) ** 2 + (lab[q + 1] - lab[p + 1]) ** 2 + (lab[q + 2] - lab[p + 2]) ** 2;
      if (st < STEP2 && near(q)) { seen[j] = 1; stack[sp++] = j; }
    }
  }
  // nearly everything reachable → it is the object itself, cut by the border
  if (!removed) return null;
  if (removed > total * 0.7) return tol > 4 ? dropBorderPattern(comp, x0, y0, bw, bh, tol * 0.6) : null;
  const out = comp.slice();
  for (let i = 0; i < out.length; i++) if (seen[i]) out[i] = 0;
  return out;
}

// Region growing from a tapped point
function segmentSeed() {
  state.lastMethod = 'seed';
  const { W, H, lab } = state;
  const sx = Math.round(state.seed.x), sy = Math.round(state.seed.y);
  if (sx < 0 || sy < 0 || sx >= W || sy >= H) return;
  // mean color around seed
  let m0 = 0, m1 = 0, m2 = 0, c = 0;
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    const x = sx + dx, y = sy + dy;
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const i = (y * W + x) * 3;
    m0 += lab[i]; m1 += lab[i + 1]; m2 += lab[i + 2]; c++;
  }
  m0 /= c; m1 /= c; m2 /= c;
  const tol = 14 * sensitivity();
  const tol2 = tol * tol;
  const localTol2 = (tol * 0.45) ** 2;

  const mask = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  let sp = 0;
  stack[sp++] = sy * W + sx;
  mask[sy * W + sx] = 1;
  while (sp > 0) {
    const p = stack[--sp];
    const px = p % W, py = (p / W) | 0;
    const pi = p * 3;
    const nbs = [px > 0 ? p - 1 : -1, px < W - 1 ? p + 1 : -1, py > 0 ? p - W : -1, py < H - 1 ? p + W : -1];
    for (const q of nbs) {
      if (q < 0 || mask[q]) continue;
      const qi = q * 3;
      const g0 = lab[qi] - m0, g1 = lab[qi + 1] - m1, g2 = lab[qi + 2] - m2;
      const l0 = lab[qi] - lab[pi], l1 = lab[qi + 1] - lab[pi + 1], l2 = lab[qi + 2] - lab[pi + 2];
      if (g0 * g0 + g1 * g1 + g2 * g2 < tol2 && l0 * l0 + l1 * l1 + l2 * l2 < localTol2) {
        mask[q] = 1;
        stack[sp++] = q;
      }
    }
  }
  const cleaned = dilate(erode(mask, W, H, 1), W, H, 1);
  // keep the component containing the seed
  const comp = componentAt(cleaned, W, H, sx, sy) || mask;
  fillHoles(comp, W, H);
  state.mask = comp;
  update();
}

function kmeans(samples, k, iters) {
  const n = samples.length / 3;
  k = Math.min(k, n);
  const c = new Float32Array(k * 3);
  for (let j = 0; j < k; j++) {
    const s = Math.floor((j + 0.5) * n / k) * 3;
    c[j * 3] = samples[s]; c[j * 3 + 1] = samples[s + 1]; c[j * 3 + 2] = samples[s + 2];
  }
  const sum = new Float64Array(k * 3), cnt = new Uint32Array(k);
  for (let it = 0; it < iters; it++) {
    sum.fill(0); cnt.fill(0);
    for (let i = 0; i < n; i++) {
      let best = 0, bd = Infinity;
      for (let j = 0; j < k; j++) {
        const d0 = samples[i * 3] - c[j * 3], d1 = samples[i * 3 + 1] - c[j * 3 + 1], d2 = samples[i * 3 + 2] - c[j * 3 + 2];
        const d = d0 * d0 + d1 * d1 + d2 * d2;
        if (d < bd) { bd = d; best = j; }
      }
      sum[best * 3] += samples[i * 3]; sum[best * 3 + 1] += samples[i * 3 + 1]; sum[best * 3 + 2] += samples[i * 3 + 2];
      cnt[best]++;
    }
    for (let j = 0; j < k; j++) if (cnt[j]) {
      c[j * 3] = sum[j * 3] / cnt[j]; c[j * 3 + 1] = sum[j * 3 + 1] / cnt[j]; c[j * 3 + 2] = sum[j * 3 + 2] / cnt[j];
    }
  }
  return { centers: c, counts: cnt };
}

// strong color edges (Sobel on blurred Lab), threshold relative to the box
function edgeMap(x0, y0, bw, bh) {
  const { W, H, lab } = state;
  const g = new Float32Array(bw * bh);
  let maxG = 0;
  const at = (x, y, c) => lab[(Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))) * 3 + c];
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const X = x + x0, Y = y + y0;
    let s = 0;
    for (let c = 0; c < 3; c++) {
      const w = c === 0 ? 1 : 0.7;
      const gx = at(X + 1, Y - 1, c) + 2 * at(X + 1, Y, c) + at(X + 1, Y + 1, c) - at(X - 1, Y - 1, c) - 2 * at(X - 1, Y, c) - at(X - 1, Y + 1, c);
      const gy = at(X - 1, Y + 1, c) + 2 * at(X, Y + 1, c) + at(X + 1, Y + 1, c) - at(X - 1, Y - 1, c) - 2 * at(X, Y - 1, c) - at(X + 1, Y - 1, c);
      s += w * (gx * gx + gy * gy);
    }
    const v = Math.sqrt(s);
    g[y * bw + x] = v;
    if (v > maxG) maxG = v;
  }
  // threshold: well above typical texture (90th percentile), scaled by sensitivity
  const sorted = Float32Array.from(g).sort();
  const p90 = sorted[Math.floor(sorted.length * 0.9)];
  const thr = Math.max(25, p90 * 1.6) / sensitivity();
  const e = new Uint8Array(bw * bh);
  for (let i = 0; i < g.length; i++) e[i] = g[i] > thr ? 1 : 0;
  return e;
}

// replace a mask with its convex hull (for books, boxes, cards …)
function convexFill(m, W, H) {
  const pts = [];
  for (let y = 0; y < H; y++) {
    let l = -1, r = -1;
    for (let x = 0; x < W; x++) if (m[y * W + x]) { if (l < 0) l = x; r = x; }
    if (l >= 0) { pts.push([l, y]); if (r !== l) pts.push([r, y]); }
  }
  if (pts.length < 3) return m;
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.fillStyle = '#fff'; x.beginPath();
  hull.forEach(([px, py], i) => (i ? x.lineTo(px + 0.5, py + 0.5) : x.moveTo(px + 0.5, py + 0.5)));
  x.closePath(); x.fill();
  const d = x.getImageData(0, 0, W, H).data;
  c.width = c.height = 0;
  const out = new Uint8Array(W * H);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4 + 3] > 127 ? 1 : 0;
  return out;
}

function otsu(values, maxV) {
  const bins = 256;
  const hist = new Float64Array(bins);
  const scale = (bins - 1) / (maxV || 1);
  for (let i = 0; i < values.length; i++) hist[Math.round(values[i] * scale)]++;
  const total = values.length;
  let sumAll = 0;
  for (let i = 0; i < bins; i++) sumAll += i * hist[i];
  let wB = 0, sumB = 0, best = 0, bestT = 0;
  for (let t = 0; t < bins; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; bestT = t; }
  }
  return (bestT + 0.5) / scale;
}

function erode(m, W, H, r) { return morph(m, W, H, r, true); }
function dilate(m, W, H, r) { return morph(m, W, H, r, false); }
function morph(m, W, H, r, isErode) {
  // separable square structuring element
  const tmp = new Uint8Array(m.length), out = new Uint8Array(m.length);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = isErode ? 1 : 0;
    for (let k = -r; k <= r; k++) {
      const xx = x + k;
      if (xx < 0 || xx >= W) continue;          // outside the image does not erode
      const s = m[y * W + xx];
      if (isErode && !s) { v = 0; break; }
      if (!isErode && s) { v = 1; break; }
    }
    tmp[y * W + x] = v;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = isErode ? 1 : 0;
    for (let k = -r; k <= r; k++) {
      const yy = y + k;
      if (yy < 0 || yy >= H) continue;
      const s = tmp[yy * W + x];
      if (isErode && !s) { v = 0; break; }
      if (!isErode && s) { v = 1; break; }
    }
    out[y * W + x] = v;
  }
  return out;
}

function labelComponents(m, W, H) {
  const labels = new Int32Array(W * H);
  const comps = [];
  const stack = new Int32Array(W * H);
  let next = 1;
  for (let s = 0; s < m.length; s++) {
    if (!m[s] || labels[s]) continue;
    let sp = 0, size = 0, sx = 0, sy = 0;
    stack[sp++] = s; labels[s] = next;
    while (sp) {
      const p = stack[--sp];
      const x = p % W, y = (p / W) | 0;
      size++; sx += x; sy += y;
      if (x > 0 && m[p - 1] && !labels[p - 1]) { labels[p - 1] = next; stack[sp++] = p - 1; }
      if (x < W - 1 && m[p + 1] && !labels[p + 1]) { labels[p + 1] = next; stack[sp++] = p + 1; }
      if (y > 0 && m[p - W] && !labels[p - W]) { labels[p - W] = next; stack[sp++] = p - W; }
      if (y < H - 1 && m[p + W] && !labels[p + W]) { labels[p + W] = next; stack[sp++] = p + W; }
    }
    comps.push({ id: next, size, cx: sx / size, cy: sy / size });
    next++;
  }
  return { labels, comps };
}

function bestComponent(m, W, H, hint) {
  const { labels, comps } = labelComponents(m, W, H);
  if (!comps.length) return null;
  const diag = Math.hypot(W, H);
  let best = null, bestScore = -1;
  if (hint) {
    // the shape that best matches the hint box: pixels inside count,
    // pixels far outside the box count against it
    const inside = new Float64Array(comps.length + 1), outside = new Float64Array(comps.length + 1);
    const mx = (hint.x1 - hint.x0) * 0.25, my = (hint.y1 - hint.y0) * 0.25;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const l = labels[y * W + x];
      if (!l) continue;
      if (x >= hint.x0 && x <= hint.x1 && y >= hint.y0 && y <= hint.y1) inside[l]++;
      else if (x < hint.x0 - mx || x > hint.x1 + mx || y < hint.y0 - my || y > hint.y1 + my) outside[l]++;
    }
    for (const c of comps) {
      const score = inside[c.id] - 2 * outside[c.id];
      if (c.size >= 20 && score > bestScore) { bestScore = score; best = c; }
    }
  } else {
    for (const c of comps) {
      if (c.size < 20) continue;
      const d = Math.hypot(c.cx - W / 2, c.cy - H / 2) / diag;
      const score = c.size * Math.exp(-4 * d * d);
      if (score > bestScore) { bestScore = score; best = c; }
    }
  }
  if (!best) return null;
  const out = new Uint8Array(W * H);
  for (let i = 0; i < out.length; i++) if (labels[i] === best.id) out[i] = 1;
  return out;
}

function componentAt(m, W, H, x, y) {
  if (!m[y * W + x]) return null;
  const { labels } = labelComponents(m, W, H);
  const id = labels[y * W + x];
  const out = new Uint8Array(W * H);
  for (let i = 0; i < out.length; i++) if (labels[i] === id) out[i] = 1;
  return out;
}

// any background region not connected to the border becomes foreground
function fillHoles(m, W, H) {
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  let sp = 0;
  const push = (p) => { if (!m[p] && !seen[p]) { seen[p] = 1; stack[sp++] = p; } };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (sp) {
    const p = stack[--sp];
    const x = p % W, y = (p / W) | 0;
    if (x > 0) push(p - 1);
    if (x < W - 1) push(p + 1);
    if (y > 0) push(p - W);
    if (y < H - 1) push(p + W);
  }
  for (let i = 0; i < m.length; i++) if (!m[i] && !seen[i]) m[i] = 1;
}

function normBox(b) {
  return { x0: Math.min(b.x0, b.x1), y0: Math.min(b.y0, b.y1), x1: Math.max(b.x0, b.x1), y1: Math.max(b.y0, b.y1) };
}

/* ------------------------------------------------------------ rendering */

let busyAnim = 0;
function setBusy(msg) {
  state.busy = msg;
  cancelAnimationFrame(busyAnim);
  if (msg) {
    const loop = () => { draw(); busyAnim = requestAnimationFrame(loop); };
    loop();
  } else if (state.W) draw();
}

function drawBusy(ui) {
  const { W } = state;
  const hgt = 40 * ui;
  ctx.fillStyle = 'rgba(0,0,0,.65)';
  ctx.fillRect(0, 0, W, hgt);
  const t = performance.now() / 1000;
  const cx = 22 * ui, cy = hgt / 2, r = 9 * ui;
  ctx.lineWidth = 3 * ui; ctx.strokeStyle = '#8ab4f8';
  ctx.beginPath(); ctx.arc(cx, cy, r, t * 6, t * 6 + 4.2); ctx.stroke();
  ctx.fillStyle = '#fff';
  let fs = 14;
  ctx.font = `600 ${fs * ui}px system-ui, sans-serif`;
  while (fs > 9 && ctx.measureText(state.busy).width > W - 50 * ui) {
    fs -= 1; ctx.font = `600 ${fs * ui}px system-ui, sans-serif`;
  }
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(state.busy, 40 * ui, cy);
  // scanning line effect
  const y = (Math.sin(t * 2) * 0.5 + 0.5) * state.H;
  ctx.fillStyle = 'rgba(138,180,248,.35)';
  ctx.fillRect(0, y - 2 * ui, W, 4 * ui);
}

function update() {
  // rebuild overlay
  const { W, H, mask } = state;
  const mctx = state.maskCanvas.getContext('2d');
  const img = mctx.createImageData(W, H);
  const d = img.data;
  for (let i = 0; i < W * H; i++) {
    if (!mask[i]) continue;
    const x = i % W, y = (i / W) | 0;
    const edge = x === 0 || y === 0 || x === W - 1 || y === H - 1 ||
      !mask[i - 1] || !mask[i + 1] || !mask[i - W] || !mask[i + W];
    const j = i * 4;
    if (edge) { d[j] = 255; d[j + 1] = 230; d[j + 2] = 0; d[j + 3] = 255; }
    else { d[j] = 0; d[j + 1] = 200; d[j + 2] = 120; d[j + 3] = 95; }
  }
  mctx.putImageData(img, 0, 0);
  computeArea();
  draw();
}

function computeArea() {
  const { ruler, mask } = state;
  const len = parseFloat($('rulerLen').value);
  const unit = $('unit').value;
  let count = 0;
  for (let i = 0; i < mask.length; i++) count += mask[i];
  const rulerPx = Math.hypot(ruler.b.x - ruler.a.x, ruler.b.y - ruler.a.y);
  if (!(len > 0) || rulerPx < 2) {
    $('areaValue').textContent = '–';
    $('areaDetail').textContent = 'Set the ruler handles and their real distance.';
    return;
  }
  const pxPerUnit = rulerPx / len;
  // tilted camera: the scale changes across the photo. The ruler shows how it
  // changes along its direction; every object pixel is weighted with the
  // scale at its own position (relative to the scale between the handles).
  let weighted = count, tiltNote = '';
  const P = state.persp;
  if (P && count) {
    const f = (x, y) => Math.min(2, Math.max(0.5, 1 + P.rel * ((x - P.cx) * P.dx + (y - P.cy) * P.dy)));
    const fm = f((ruler.a.x + ruler.b.x) / 2, (ruler.a.y + ruler.b.y) / 2);
    weighted = 0;
    const W = state.W;
    for (let i = 0; i < mask.length; i++) if (mask[i]) {
      const r = fm / f(i % W, (i / W) | 0);
      weighted += r * r;
    }
    const change = Math.abs(P.rel) * rulerPx * 100;
    if (change >= 0.5) tiltNote = ` · tilt corrected (scale changes ${change.toFixed(1)} % along the ruler)`;
  }
  const area = weighted / (pxPerUnit * pxPerUnit);
  // convert to cm² as the main readout, plus the chosen unit
  const toCm = { cm: 1, mm: 0.1, in: 2.54 }[unit];
  const areaCm2 = area * toCm * toCm;
  const name = state.objectName ? `${state.objectName}: ` : '';
  let main = `${name}${fmt(areaCm2)} cm²`;
  if (unit === 'in') main += ` (${fmt(area)} in²)`;
  if (unit === 'mm' || areaCm2 < 1) main += ` (${fmt(areaCm2 * 100)} mm²)`;
  $('areaValue').textContent = count ? main : '–';
  $('areaBadge').textContent = count ? `${fmt(areaCm2)} cm²` : '–';
  $('areaDetail').textContent = count ? '' : 'No object found – drag a box around it or tap on it.';
  $('srcObject').textContent = state.objectSource;
  const t = state.captureTilt;
  $('srcPhotoRow').hidden = t == null;
  if (t != null) $('srcPhoto').textContent = `taken with the level camera, ${t.toFixed(1)}° off level` + (t > 2 ? ' – tilted, the result may be less accurate' : '');
  $('srcRuler').textContent = `${state.rulerSource} → ${len} ${unit} = ${rulerPx.toFixed(0)} px${tiltNote}`;
}

function fmt(v) {
  if (v >= 100) return v.toFixed(0);
  if (v >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

// view (zoom / pan): work-image point (x, y) is drawn at ((x - ox) * s, (y - oy) * s)
const view = { s: 1, ox: 0, oy: 0 };
const cssPx = () => state.W / (canvas.getBoundingClientRect().width || state.W);   // canvas px per CSS px

function clampView() {
  view.s = Math.max(1, Math.min(10, view.s));
  view.ox = Math.max(0, Math.min(state.W - state.W / view.s, view.ox));
  view.oy = Math.max(0, Math.min(state.H - state.H / view.s, view.oy));
}

function zoomAt(factor, cx, cy) {          // cx, cy: canvas px that stays in place
  const wx = view.ox + cx / view.s, wy = view.oy + cy / view.s;
  view.s *= factor;
  clampView();
  view.ox = wx - cx / view.s; view.oy = wy - cy / view.s;
  clampView();
  draw();
}

function draw() {
  const { W, H, ruler } = state;
  const css = cssPx(), { s: vs, ox, oy } = view;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = true;
  if (vs > 1.01) {                         // zoomed: draw from the full-resolution photo
    const k = srcToWork();
    ctx.drawImage(state.src, ox / k, oy / k, W / vs / k, H / vs / k, 0, 0, W, H);
  } else ctx.drawImage(state.workCanvas, 0, 0);
  ctx.setTransform(vs, 0, 0, vs, -ox * vs, -oy * vs);
  const ui = css / vs;                     // work px per CSS px
  ctx.imageSmoothingEnabled = vs < 2;
  ctx.drawImage(state.maskCanvas, 0, 0);
  ctx.imageSmoothingEnabled = true;

  // box
  if (state.box && (state.mode === 'box' || state.lastMethod === 'box')) {
    const b = normBox(state.box);
    ctx.save();
    ctx.setLineDash([6 * ui, 4 * ui]);
    ctx.lineWidth = 2 * ui;
    ctx.strokeStyle = state.mode === 'box' ? '#4fc3f7' : 'rgba(79,195,247,.5)';
    ctx.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    if (state.boxFromAI) {
      const label = `✨ AI: ${state.objectName || 'object'}`;
      ctx.setLineDash([]);
      ctx.font = `600 ${13 * ui}px system-ui, sans-serif`;
      const tw = ctx.measureText(label).width;
      const ly = Math.max(b.y0, 20 * ui);
      ctx.fillStyle = '#4fc3f7';
      ctx.fillRect(b.x0, ly - 20 * ui, tw + 12 * ui, 20 * ui);
      ctx.fillStyle = '#002';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, b.x0 + 6 * ui, ly - 10 * ui);
    }
    ctx.restore();
  }

  // seed
  if (state.seed && state.lastMethod === 'seed') {
    ctx.beginPath();
    ctx.arc(state.seed.x, state.seed.y, 6 * ui, 0, Math.PI * 2);
    ctx.fillStyle = '#ff4081'; ctx.fill();
    ctx.lineWidth = 2 * ui; ctx.strokeStyle = '#fff'; ctx.stroke();
  }

  // brush stroke in progress
  const g = gesture;
  if (g && g.type === 'brush' && g.pts.length) {
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.lineWidth = g.r * 2;
    ctx.strokeStyle = brush.erase ? 'rgba(255,60,60,.55)' : 'rgba(60,200,120,.6)';
    ctx.beginPath();
    g.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    if (g.pts.length === 1) ctx.lineTo(g.pts[0].x + 0.01, g.pts[0].y);
    ctx.stroke();
    ctx.restore();
  }

  // ruler
  ctx.save();
  ctx.lineWidth = 3 * ui;
  ctx.strokeStyle = '#ff5252';
  ctx.beginPath(); ctx.moveTo(ruler.a.x, ruler.a.y); ctx.lineTo(ruler.b.x, ruler.b.y); ctx.stroke();
  for (const p of [ruler.a, ruler.b]) {
    ctx.beginPath(); ctx.arc(p.x, p.y, 13 * ui, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,82,82,.22)'; ctx.fill();
    ctx.lineWidth = 2 * ui; ctx.stroke();
    ctx.beginPath(); ctx.arc(p.x, p.y, 1.5 * ui, 0, Math.PI * 2);
    ctx.fillStyle = '#ff5252'; ctx.fill();
  }
  const label = `${$('rulerLen').value} ${$('unit').value}`;
  ctx.font = `bold ${14 * ui}px system-ui, sans-serif`;
  const mx = (ruler.a.x + ruler.b.x) / 2, my = (ruler.a.y + ruler.b.y) / 2 - 14 * ui;
  const tw = ctx.measureText(label).width;
  ctx.fillStyle = 'rgba(0,0,0,.6)';
  ctx.fillRect(mx - tw / 2 - 5 * ui, my - 13 * ui, tw + 10 * ui, 19 * ui);
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center';
  ctx.fillText(label, mx, my);
  ctx.restore();

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // magnifier while dragging a ruler handle
  if (g && g.type === 'handle') drawLoupe(g.h, css);
  if (state.busy) drawBusy(css);
}

// p: work coords; drawn in canvas (screen) coords
function drawLoupe(p, css) {
  const { W } = state;
  const R = 70 * css;
  // about ±8 mm around the handle (if the scale is known), from the full-resolution photo
  const zoomW = state.periodPx ? Math.max(3, Math.min(30, R / (state.periodPx * 8))) : 5;  // canvas px per work px
  const ps = (p.x - view.ox) * view.s;
  const cx = ps < W / 2 ? W - R - 10 * css : R + 10 * css;
  const cy = R + 10 * css;
  const k = srcToWork(), sr = R / zoomW;              // work px shown around p
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
  ctx.fillStyle = '#000'; ctx.fillRect(cx - R, cy - R, 2 * R, 2 * R);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(state.src, (p.x - sr) / k, (p.y - sr) / k, 2 * sr / k, 2 * sr / k, cx - R, cy - R, 2 * R, 2 * R);
  ctx.strokeStyle = '#ff5252'; ctx.lineWidth = 1.5 * css;
  ctx.beginPath();
  ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
  ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
  ctx.stroke();
  ctx.restore();
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.lineWidth = 3 * css; ctx.strokeStyle = '#fff'; ctx.stroke();
}

/* ------------------------------------------------------------ interaction */

const hints = {
  move: 'Pinch or use ＋/－ to zoom, drag to move the zoomed photo. The ruler moves only when you grab a red handle or the red line. Use Outline －/＋ to shrink or grow the selected area step by step.',
  fix: 'Paint over parts to remove from the area (e.g. a shadow) – or switch to Add and paint parts that are missing. Zoom in for precision; ↶ undoes.',
  box: 'Drag a rectangle around the object. Everything outside is ignored. Two fingers zoom/move.',
  seed: 'Tap on the object. The connected area of similar color is selected. Dragging moves the zoomed photo.',
};

document.querySelectorAll('.mode').forEach((b) =>
  b.addEventListener('click', () => setMode(b.dataset.mode)));

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('modeHint').textContent = hints[mode];
  $('brushBar').hidden = mode !== 'fix';
  if (state.W) draw();
}

/* ---- undo ---- */
const undoStack = [];
function snapshot() {
  return {
    mask: state.mask.slice(), ruler: { a: { ...state.ruler.a }, b: { ...state.ruler.b } },
    len: $('rulerLen').value, unit: $('unit').value, auto: $('autoScale').checked,
    periodPx: state.periodPx, tickPx: state.tickPx, perTick: state.perTick, rulerKind: state.rulerKind,
    persp: state.persp, rulerSource: state.rulerSource, objectSource: state.objectSource,
    box: state.box && { ...state.box }, seed: state.seed && { ...state.seed }, lastMethod: state.lastMethod,
    boxFromAI: state.boxFromAI, quad: state.quad, sens: $('sensitivity').value,
  };
}
function pushUndo() {
  if (!state.W) return;
  undoStack.push(snapshot());
  if (undoStack.length > 20) undoStack.shift();
  $('undoBtn').disabled = false;
}
function undo() {
  const u = undoStack.pop();
  $('undoBtn').disabled = !undoStack.length;
  if (!u) return;
  state.mask = u.mask; state.ruler = u.ruler;
  $('rulerLen').value = u.len; $('unit').value = u.unit; $('autoScale').checked = u.auto;
  Object.assign(state, {
    periodPx: u.periodPx, tickPx: u.tickPx, perTick: u.perTick, rulerKind: u.rulerKind, persp: u.persp,
    rulerSource: u.rulerSource, objectSource: u.objectSource, box: u.box, seed: u.seed,
    lastMethod: u.lastMethod, boxFromAI: u.boxFromAI, quad: u.quad,
  });
  setSens(parseFloat(u.sens), false);
  update();
}
function clearUndo() { undoStack.length = 0; $('undoBtn').disabled = true; }

/* ---- outline: shrink / grow by one pixel ---- */
let morphStep = 0;
function morphMask(grow) {
  const { W, H } = state, m = state.mask, out = new Uint8Array(m.length);
  const diag = (morphStep++ & 1) === 1;      // alternate + and □ neighbourhoods → roughly round
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    let v = m[i];
    const nb = [x > 0 ? m[i - 1] : 0, x < W - 1 ? m[i + 1] : 0, y > 0 ? m[i - W] : 0, y < H - 1 ? m[i + W] : 0];
    if (diag) nb.push(x > 0 && y > 0 ? m[i - W - 1] : 0, x < W - 1 && y > 0 ? m[i - W + 1] : 0,
      x > 0 && y < H - 1 ? m[i + W - 1] : 0, x < W - 1 && y < H - 1 ? m[i + W + 1] : 0);
    if (grow) { if (!v) for (const n of nb) if (n) { v = 1; break; } }
    else if (v) { for (const n of nb) if (!n) { v = 0; break; } }
    out[i] = v;
  }
  state.mask = out;
}
$('shrinkBtn').addEventListener('click', () => { if (!state.W) return; pushUndo(); morphMask(false); markEdited(); update(); });
$('growBtn').addEventListener('click', () => { if (!state.W) return; pushUndo(); morphMask(true); markEdited(); update(); });
$('undoBtn').addEventListener('click', undo);
function markEdited() {
  if (!/adjusted by hand/.test(state.objectSource)) state.objectSource += ' · adjusted by hand';
}

/* ---- brush ---- */
const BRUSH = [{ n: 'S', r: 8 }, { n: 'M', r: 16 }, { n: 'L', r: 28 }, { n: 'XL', r: 44 }];   // radius in CSS px
const brush = { erase: true, size: 1 };
function setBrush() {
  $('brushErase').classList.toggle('on', brush.erase);
  $('brushAdd').classList.toggle('on', !brush.erase);
  $('brushSizeVal').textContent = BRUSH[brush.size].n;
}
$('brushErase').addEventListener('click', () => { brush.erase = true; setBrush(); });
$('brushAdd').addEventListener('click', () => { brush.erase = false; setBrush(); });
$('brushSmaller').addEventListener('click', () => { brush.size = Math.max(0, brush.size - 1); setBrush(); });
$('brushBigger').addEventListener('click', () => { brush.size = Math.min(BRUSH.length - 1, brush.size + 1); setBrush(); });

function applyBrush(pts, r) {
  const { W, H } = state, m = state.mask, v = brush.erase ? 0 : 1, r2 = r * r;
  const stamp = (cx, cy) => {
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(H - 1, Math.ceil(cy + r)); y++)
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(W - 1, Math.ceil(cx + r)); x++)
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r2) m[y * W + x] = v;
  };
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[i + 1] || p;
    const n = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / Math.max(1, r / 2)));
    for (let k = 0; k <= n; k++) stamp(p.x + (q.x - p.x) * k / n, p.y + (q.y - p.y) * k / n);
  }
}

/* ---- zoom buttons, wheel ---- */
$('zoomIn').addEventListener('click', () => state.W && zoomAt(1.6, state.W / 2, state.H / 2));
$('zoomOut').addEventListener('click', () => state.W && zoomAt(1 / 1.6, state.W / 2, state.H / 2));
$('zoomFit').addEventListener('click', () => { view.s = 1; view.ox = view.oy = 0; if (state.W) draw(); });
canvas.addEventListener('wheel', (e) => {
  if (!state.W) return;
  e.preventDefault();
  const c = toCanvas(e);
  zoomAt(Math.exp(-e.deltaY * 0.0015), c.x, c.y);
}, { passive: false });

/* ---- pointer gestures (touch & mouse) ----
   one finger: depends on the mode; two fingers: always zoom + move.
   A second finger cancels a stroke / box that has just started, so a pinch
   never leaves an accidental edit behind. */
const pointers = new Map();
let gesture = null;

function toCanvas(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) * state.W / r.width, y: (e.clientY - r.top) * state.H / r.height };
}
function toWork(e) {
  const c = toCanvas(e);
  return { x: view.ox + c.x / view.s, y: view.oy + c.y / view.s };
}
function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
  return { d: Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy), t };
}

function startPinch() {
  const [p1, p2] = [...pointers.values()];
  gesture = {
    type: 'pinch', d0: Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1, s0: view.s,
    w: { x: view.ox + (p1.x + p2.x) / 2 / view.s, y: view.oy + (p1.y + p2.y) / 2 / view.s },
  };
}

canvas.addEventListener('pointerdown', (e) => {
  if (!state.W || state.busy) return;
  try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
  pointers.set(e.pointerId, toCanvas(e));
  if (pointers.size === 2) {
    // second finger: drop what the first finger started (nothing was applied yet)
    if (gesture && gesture.type === 'handle') Object.assign(gesture.h, gesture.h0);
    if (gesture && gesture.type === 'line') { state.ruler.a = gesture.a0; state.ruler.b = gesture.b0; }
    if (gesture && gesture.type === 'box') state.box = gesture.box0;
    startPinch();
    draw();
    return;
  }
  if (pointers.size > 2) return;
  const p = toWork(e), c = toCanvas(e), ui = cssPx() / view.s;
  const { a, b } = state.ruler;
  const da = Math.hypot(p.x - a.x, p.y - a.y), db = Math.hypot(p.x - b.x, p.y - b.y);
  if (state.mode === 'move' && Math.min(da, db) < 26 * ui) {
    const h = da < db ? a : b;
    pushUndo();
    gesture = { type: 'handle', h, h0: { ...h }, off: { x: h.x - p.x, y: h.y - p.y } };
  } else if (state.mode === 'move' && distToSegment(p, a, b).d < 14 * ui) {
    pushUndo();
    gesture = { type: 'line', start: p, a0: { ...a }, b0: { ...b } };
  } else if (state.mode === 'fix') {
    gesture = { type: 'brush', pts: [p], r: BRUSH[brush.size].r * ui };
  } else if (state.mode === 'box') {
    gesture = { type: 'box', start: p, box0: state.box && { ...state.box }, moved: false };
  } else {
    gesture = { type: 'pan', c0: c, ox: view.ox, oy: view.oy, moved: false, tap: state.mode === 'seed' };
  }
  draw();
});

canvas.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId) || !gesture) return;
  pointers.set(e.pointerId, toCanvas(e));
  const g = gesture;
  if (g.type === 'pinch') {
    if (pointers.size < 2) return;
    const [p1, p2] = [...pointers.values()];
    view.s = g.s0 * Math.hypot(p2.x - p1.x, p2.y - p1.y) / g.d0;
    clampView();
    view.ox = g.w.x - (p1.x + p2.x) / 2 / view.s;
    view.oy = g.w.y - (p1.y + p2.y) / 2 / view.s;
    clampView();
    draw();
    return;
  }
  const p = toWork(e), c = toCanvas(e);
  const clampX = (v) => Math.max(0, Math.min(state.W - 1, v));
  const clampY = (v) => Math.max(0, Math.min(state.H - 1, v));
  if (g.type === 'handle') {
    g.h.x = clampX(p.x + g.off.x); g.h.y = clampY(p.y + g.off.y);
    computeArea();
  } else if (g.type === 'line') {
    const dx = p.x - g.start.x, dy = p.y - g.start.y;
    state.ruler.a = { x: clampX(g.a0.x + dx), y: clampY(g.a0.y + dy) };
    state.ruler.b = { x: clampX(g.b0.x + dx), y: clampY(g.b0.y + dy) };
  } else if (g.type === 'brush') {
    g.pts.push(p);
  } else if (g.type === 'box') {
    if (!g.moved && Math.hypot(p.x - g.start.x, p.y - g.start.y) * view.s / cssPx() < 10) return;
    g.moved = true;
    state.box = { x0: g.start.x, y0: g.start.y, x1: clampX(p.x), y1: clampY(p.y) };
  } else if (g.type === 'pan') {
    if (!g.moved && Math.hypot(c.x - g.c0.x, c.y - g.c0.y) / cssPx() < 10) return;
    g.moved = true;
    view.ox = g.ox - (c.x - g.c0.x) / view.s;
    view.oy = g.oy - (c.y - g.c0.y) / view.s;
    clampView();
  }
  draw();
});

function endPointer(e, cancelled) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  const g = gesture;
  if (!g) return;
  if (g.type === 'pinch') {
    if (pointers.size === 0) gesture = null;      // lifting the fingers one by one does nothing else
    return;
  }
  gesture = null;
  if (cancelled) { draw(); return; }
  if (g.type === 'brush') {
    pushUndo();
    applyBrush(g.pts, g.r);
    markEdited();
    update();
  } else if (g.type === 'box') {
    const b = state.box && normBox(state.box);
    if (!g.moved || !b || (b.x1 - b.x0) < 8 || (b.y1 - b.y0) < 8) { state.box = g.box0; draw(); return; }
    pushUndo();
    state.boxFromAI = false;
    state.objectSource = 'your box + image analysis';
    segmentBox();
  } else if (g.type === 'pan') {
    if (g.tap && !g.moved) {
      pushUndo();
      state.seed = toWork(e);
      state.objectSource = 'region grown from the point you tapped';
      segmentSeed();
    } else draw();
  } else {                                        // handle / line
    rulerAfterUserMove(g);
    update();
  }
}
canvas.addEventListener('pointerup', (e) => endPointer(e, false));
canvas.addEventListener('pointercancel', (e) => endPointer(e, true));

/* ---- other controls ---- */
$('rulerLen').addEventListener('change', () => pushUndoOnce());
$('rulerLen').addEventListener('input', () => {
  $('autoScale').checked = false;
  state.rulerSource = 'length entered manually';
  computeArea(); draw();
});
let lenUndoArmed = true;
function pushUndoOnce() { lenUndoArmed = true; }
$('rulerLen').addEventListener('focus', () => { if (lenUndoArmed) { pushUndo(); lenUndoArmed = false; } });
$('unit').addEventListener('change', () => {
  if (autoScale() && state.tickPx && state.rulerKind !== 'unknown') setLengthFromTicks(ticksBetweenHandles());
  computeArea(); draw();
});
$('autoScale').addEventListener('change', () => {
  if (autoScale() && state.W) { pushUndo(); rulerAfterUserMove({ type: 'line' }); update(); }
});
$('rulerBtn').addEventListener('click', async () => {
  if (!state.W) return;
  pushUndo();
  $('autoScale').checked = true;
  await findRulerAuto();
});

// detection sensitivity: − / + steps instead of a slider (easier on a phone)
function setSens(v, rerun = true) {
  v = Math.round(Math.max(0.4, Math.min(1.8, v)) * 10) / 10;
  $('sensitivity').value = v;
  $('sensVal').textContent = v.toFixed(1);
  $('sensDown').disabled = v <= 0.4; $('sensUp').disabled = v >= 1.8;
  if (rerun && state.W) { pushUndo(); resegment(); }
}
$('sensDown').addEventListener('click', () => setSens(sensitivity() - 0.1));
$('sensUp').addEventListener('click', () => setSens(sensitivity() + 0.1));
$('rectFit').addEventListener('change', () => { pushUndo(); resegment(); });
$('convex').addEventListener('change', () => { pushUndo(); resegment(); });
$('autoBtn').addEventListener('click', () => {
  if (!state.W) return;
  pushUndo();
  const m = 0.04, { W, H } = state;
  state.box = { x0: W * m, y0: H * m, x1: W * (1 - m), y1: H * (1 - m) };
  state.objectName = '';
  state.boxFromAI = false;
  state.objectSource = 'image analysis (whole photo)';
  segmentBox();
});
window.addEventListener('resize', () => state.W && draw());
setBrush();

/* ------------------------------------------------- Chrome built-in AI */

const ai = { status: 'unavailable', session: null };
const AI_OPTS = {
  expectedInputs: [{ type: 'text', languages: ['en'] }, { type: 'image' }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
};

async function checkAI() {
  const el = $('aiStatus');
  if (!('LanguageModel' in self)) {
    el.innerHTML = 'Chrome built-in AI is not available in this browser – using built-in image analysis. ' +
      '<span class="small">(Use desktop Chrome with Gemini Nano and image input enabled to get AI detection.)</span>';
    return;
  }
  try {
    ai.status = await LanguageModel.availability(AI_OPTS);
  } catch (err) {
    ai.status = 'unavailable';
  }
  const btn = $('aiBtn');
  switch (ai.status) {
    case 'available':
      el.textContent = '✨ Chrome built-in AI (Gemini Nano) is ready – the ruler and object will be detected automatically.';
      btn.disabled = false; break;
    case 'downloadable':
    case 'downloading':
      el.textContent = '✨ Chrome built-in AI can be used. The model will be downloaded the first time you press “Detect with Chrome AI”.';
      btn.disabled = false; break;
    default:
      el.textContent = 'Chrome built-in AI with image input is not available on this device – using built-in image analysis.';
  }
}

async function getSession() {
  if (ai.session) return ai.session;
  ai.session = await LanguageModel.create({
    ...AI_OPTS,
    monitor(m) {
      m.addEventListener('downloadprogress', (e) => {
        $('aiResult').textContent = `Downloading AI model… ${Math.round(e.loaded * 100)}%`;
        if (state.busy) state.busy = `✨ Downloading Chrome AI model… ${Math.round(e.loaded * 100)}%`;
      });
    },
  });
  ai.status = 'available';
  return ai.session;
}

const AI_SCHEMA = {
  type: 'object',
  properties: {
    object_name: { type: 'string' },
    object_box: {
      type: 'object',
      properties: { x_min: { type: 'number' }, y_min: { type: 'number' }, x_max: { type: 'number' }, y_max: { type: 'number' } },
      required: ['x_min', 'y_min', 'x_max', 'y_max'],
    },
    ruler_found: { type: 'boolean' },
    ruler_point_1: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
    ruler_value_1: { type: 'number' },
    ruler_point_2: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
    ruler_value_2: { type: 'number' },
    ruler_unit: { type: 'string', enum: ['cm', 'mm', 'in'] },
  },
  required: ['object_name', 'object_box', 'ruler_found', 'ruler_point_1', 'ruler_value_1',
    'ruler_point_2', 'ruler_value_2', 'ruler_unit'],
};

const AI_PROMPT = `You are analysing a photo used to measure the area of an object.
The photo contains a ruler (or measuring tape) and one main object (the most obvious object that is not the ruler).
Use normalized image coordinates from 0 to 1000, where (0,0) is the top-left corner and (1000,1000) is the bottom-right corner.
Return JSON with:
- object_name: short name of the main object (not the ruler)
- object_box: tight bounding box of the main object (exclude the ruler)
- ruler_found: whether a ruler is visible
- ruler_point_1 / ruler_value_1: position of a clearly labelled tick mark on the ruler and the number printed at it (e.g. 0 or 1)
- ruler_point_2 / ruler_value_2: position of another labelled tick mark far from the first one and its number
- ruler_unit: unit of the printed numbers (cm, mm or in)`;

$('aiBtn').addEventListener('click', runAI);

async function runAI() {
  if (!state.W) { $('aiResult').textContent = 'Take or choose a photo first.'; return; }
  const btn = $('aiBtn'), out = $('aiResult');
  btn.disabled = true;
  out.textContent = '✨ Asking Chrome AI to find the ruler and the object…';
  setBusy('✨ AI is finding the object and ruler…');
  try {
    const session = await getSession();
    const s = await session.clone();
    const raw = await s.prompt([{
      role: 'user',
      content: [
        { type: 'text', value: AI_PROMPT },
        { type: 'image', value: state.workCanvas },
      ],
    }], { responseConstraint: AI_SCHEMA });
    s.destroy && s.destroy();
    applyAI(JSON.parse(raw));
  } catch (err) {
    console.error(err);
    out.textContent = `Chrome AI failed (${err && err.message ? err.message : err}). Using built-in image analysis – adjust manually if needed.`;
  } finally {
    btn.disabled = false;
    setBusy('');
    update();
  }
}

function applyAI(r) {
  const { W, H } = state;
  const sx = (v) => Math.max(0, Math.min(W - 1, (v / 1000) * W));
  const sy = (v) => Math.max(0, Math.min(H - 1, (v / 1000) * H));
  const msgs = [];

  state.objectName = (r.object_name || '').slice(0, 40);
  const b = r.object_box;
  if (b && b.x_max > b.x_min && b.y_max > b.y_min) {
    // the AI box is approximate – it is only used to pick the right shape
    const pw = (b.x_max - b.x_min) * 0.04, ph = (b.y_max - b.y_min) * 0.04;
    state.box = { x0: sx(b.x_min - pw), y0: sy(b.y_min - ph), x1: sx(b.x_max + pw), y1: sy(b.y_max + ph) };
    state.boxFromAI = true;
    state.objectSource = `✨ AI found “${state.objectName || 'object'}” (blue box), outline traced by image analysis`;
    msgs.push(`Object: “${state.objectName || 'unknown'}” – shown with the blue box.`);
  } else {
    msgs.push('AI did not return an object box – using image analysis of the whole photo.');
  }

  const dv = Math.abs((r.ruler_value_2 ?? 0) - (r.ruler_value_1 ?? 0));
  const p1 = r.ruler_point_1, p2 = r.ruler_point_2;
  const aiRuler = r.ruler_found && p1 && p2 && dv > 0 && Math.hypot(p2.x - p1.x, p2.y - p1.y) > 30;
  if (state.periodPx) {
    msgs.push('Ruler: tick marks were already measured automatically.');
  } else if (aiRuler) {
    const unit = ['cm', 'mm', 'in'].includes(r.ruler_unit) ? r.ruler_unit : 'cm';
    $('unit').value = unit === 'mm' ? 'cm' : unit;
    const k = srcToWork();
    const A = { x: sx(p1.x) / k, y: sy(p1.y) / k }, B = { x: sx(p2.x) / k, y: sy(p2.y) / k };
    let res = null;
    try {
      if (autoScale()) res = Ruler.zoomRefine(state.src, A, B, { half: maxSide() * 0.05, imperial: unit === 'in' });
    } catch (err) { console.error(err); }
    if (res) {
      applyRuler(res, '✨ AI located the ruler, tick marks measured');
      msgs.push('Ruler: located by AI, scale measured from the tick marks.');
    } else {
      state.ruler = { a: { x: sx(p1.x), y: sy(p1.y) }, b: { x: sx(p2.x), y: sy(p2.y) } };
      const len = unit === 'mm' ? dv / 10 : dv;
      $('rulerLen').value = +len.toFixed(3);
      state.rulerSource = `✨ AI estimate: marks ${r.ruler_value_1} → ${r.ruler_value_2} ${unit} – check the handles!`;
      msgs.push(`Ruler: AI read the marks ${r.ruler_value_1} → ${r.ruler_value_2} ${unit}. Please check the red handles sit exactly on those marks.`);
    }
  } else {
    msgs.push('Ruler not found by AI – place the red handles manually.');
  }
  $('aiResult').textContent = '✨ ' + msgs.join(' ');
  segmentBox();
}

checkAI();

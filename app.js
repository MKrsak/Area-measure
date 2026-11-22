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
  loadImage(bmp);
  if (ai.status === 'available') runAI();
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
    mask: new Uint8Array(W * H),
    maskCanvas: document.createElement('canvas'),
    seed: null, objectName: '',
  });
  state.maskCanvas.width = W; state.maskCanvas.height = H;

  // Default ruler: horizontal line in the lower part; default box: most of the image
  state.ruler = { a: { x: W * 0.3, y: H * 0.88 }, b: { x: W * 0.7, y: H * 0.88 } };
  const m = 0.04;
  state.box = { x0: W * m, y0: H * m, x1: W * (1 - m), y1: H * (1 - m) };

  canvas.width = W; canvas.height = H;
  $('workCard').classList.remove('hidden');
  $('aiResult').textContent = '';
  setMode('ruler');
  segmentBox();
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
function segmentBox() {
  state.lastMethod = 'box';
  const { W, H, lab } = state;
  const b = normBox(state.box);
  const x0 = Math.max(0, Math.floor(b.x0)), y0 = Math.max(0, Math.floor(b.y0));
  const x1 = Math.min(W - 1, Math.ceil(b.x1)), y1 = Math.min(H - 1, Math.ceil(b.y1));
  if (x1 - x0 < 4 || y1 - y0 < 4) return;

  // 1. background samples: ring just outside the box (or inside if at the image edge)
  const ring = Math.max(4, Math.round(0.03 * Math.max(x1 - x0, y1 - y0)));
  const samples = [];
  const step = Math.max(1, Math.round(Math.sqrt(((x1 - x0) + (y1 - y0)) * 2 * ring / 3000)));
  const addSample = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 3;
    samples.push(lab[i], lab[i + 1], lab[i + 2]);
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
  const centers = kmeans(samples, 6, 10);

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
  let thr = otsu(dist, maxD);
  thr = Math.max(4, thr) / sensitivity();
  let fg = new Uint8Array(bw * bh);
  for (let i = 0; i < fg.length; i++) fg[i] = dist[i] > thr ? 1 : 0;

  // 4. morphological opening to cut thin bridges (e.g. touching the ruler)
  fg = dilate(erode(fg, bw, bh, 2), bw, bh, 2);

  // 5. pick the most "obvious" component: large and near the box center
  const comp = bestComponent(fg, bw, bh);
  if (!comp) { state.mask.fill(0); update(); return; }
  fillHoles(comp, bw, bh);

  state.mask.fill(0);
  for (let y = 0; y < bh; y++)
    for (let x = 0; x < bw; x++)
      if (comp[y * bw + x]) state.mask[(y + y0) * W + (x + x0)] = 1;
  update();
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
  return c;
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
      const s = xx < 0 || xx >= W ? (isErode ? 0 : 0) : m[y * W + xx];
      if (isErode && !s) { v = 0; break; }
      if (!isErode && s) { v = 1; break; }
    }
    tmp[y * W + x] = v;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = isErode ? 1 : 0;
    for (let k = -r; k <= r; k++) {
      const yy = y + k;
      const s = yy < 0 || yy >= H ? 0 : tmp[yy * W + x];
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

function bestComponent(m, W, H) {
  const { labels, comps } = labelComponents(m, W, H);
  if (!comps.length) return null;
  const diag = Math.hypot(W, H);
  let best = null, bestScore = -1;
  for (const c of comps) {
    if (c.size < 20) continue;
    const d = Math.hypot(c.cx - W / 2, c.cy - H / 2) / diag;
    const score = c.size * Math.exp(-4 * d * d);
    if (score > bestScore) { bestScore = score; best = c; }
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
  const area = count / (pxPerUnit * pxPerUnit);
  // convert to cm² as the main readout, plus the chosen unit
  const toCm = { cm: 1, mm: 0.1, in: 2.54 }[unit];
  const areaCm2 = area * toCm * toCm;
  const name = state.objectName ? `${state.objectName}: ` : '';
  let main = `${name}${fmt(areaCm2)} cm²`;
  if (unit === 'in') main += ` (${fmt(area)} in²)`;
  if (unit === 'mm' || areaCm2 < 1) main += ` (${fmt(areaCm2 * 100)} mm²)`;
  $('areaValue').textContent = count ? main : '–';
  $('areaDetail').textContent = count
    ? `Object: ${count.toLocaleString()} px · Scale: ${(pxPerUnit).toFixed(2)} px/${unit} (in processing image)`
    : 'No object found – drag a box around it or tap on it.';
}

function fmt(v) {
  if (v >= 100) return v.toFixed(0);
  if (v >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

function draw() {
  const { W, H, ruler } = state;
  const ui = W / canvas.getBoundingClientRect().width || 1; // work px per CSS px
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(state.workCanvas, 0, 0);
  ctx.drawImage(state.maskCanvas, 0, 0);

  // box
  if (state.box && (state.mode === 'box' || state.lastMethod === 'box')) {
    const b = normBox(state.box);
    ctx.save();
    ctx.setLineDash([6 * ui, 4 * ui]);
    ctx.lineWidth = 2 * ui;
    ctx.strokeStyle = state.mode === 'box' ? '#4fc3f7' : 'rgba(79,195,247,.5)';
    ctx.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    ctx.restore();
  }

  // seed
  if (state.seed && state.lastMethod === 'seed') {
    ctx.beginPath();
    ctx.arc(state.seed.x, state.seed.y, 6 * ui, 0, Math.PI * 2);
    ctx.fillStyle = '#ff4081'; ctx.fill();
    ctx.lineWidth = 2 * ui; ctx.strokeStyle = '#fff'; ctx.stroke();
  }

  // ruler
  ctx.save();
  ctx.lineWidth = 3 * ui;
  ctx.strokeStyle = '#ff5252';
  ctx.beginPath(); ctx.moveTo(ruler.a.x, ruler.a.y); ctx.lineTo(ruler.b.x, ruler.b.y); ctx.stroke();
  for (const p of [ruler.a, ruler.b]) {
    ctx.beginPath(); ctx.arc(p.x, p.y, 10 * ui, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,82,82,.25)'; ctx.fill();
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

  // magnifier while dragging a ruler handle
  if (state.drag && state.drag.type === 'handle' && state.pointer) drawLoupe(state.pointer, ui);
}

function drawLoupe(p, ui) {
  const { W } = state;
  const R = 70 * ui, zoom = 4;
  const cx = p.x < W / 2 ? W - R - 10 * ui : R + 10 * ui;
  const cy = R + 10 * ui;
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
  ctx.fillStyle = '#000'; ctx.fillRect(cx - R, cy - R, 2 * R, 2 * R);
  const sr = R / zoom;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(state.workCanvas, p.x - sr, p.y - sr, 2 * sr, 2 * sr, cx - R, cy - R, 2 * R, 2 * R);
  ctx.strokeStyle = '#ff5252'; ctx.lineWidth = 1.5 * ui;
  ctx.beginPath();
  ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
  ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
  ctx.stroke();
  ctx.restore();
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.lineWidth = 3 * ui; ctx.strokeStyle = '#fff'; ctx.stroke();
}

/* ------------------------------------------------------------ interaction */

const hints = {
  ruler: 'Drag the two red handles onto two tick marks of the ruler (the magnifier helps), then enter their real distance below.',
  box: 'Drag a rectangle around the object. Everything outside is ignored.',
  seed: 'Tap on the object. Similar-colored connected area is selected; adjust sensitivity if needed.',
};

document.querySelectorAll('.mode').forEach((b) =>
  b.addEventListener('click', () => setMode(b.dataset.mode)));

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('modeHint').textContent = hints[mode];
  if (state.W) draw();
}

function toWork(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) * state.W / r.width, y: (e.clientY - r.top) * state.H / r.height };
}

canvas.addEventListener('pointerdown', (e) => {
  if (!state.W) return;
  const p = toWork(e);
  const ui = state.W / canvas.getBoundingClientRect().width;
  canvas.setPointerCapture(e.pointerId);
  state.pointer = p;
  // ruler handles can always be grabbed
  const { a, b } = state.ruler;
  const da = Math.hypot(p.x - a.x, p.y - a.y), db = Math.hypot(p.x - b.x, p.y - b.y);
  const grab = 28 * ui;
  if (Math.min(da, db) < grab && (state.mode === 'ruler' || Math.min(da, db) < grab / 2)) {
    const h = da < db ? a : b;
    state.drag = { type: 'handle', h, off: { x: h.x - p.x, y: h.y - p.y } };
  } else if (state.mode === 'ruler') {
    state.drag = { type: 'line', start: p, a0: { ...a }, b0: { ...b } };
  } else if (state.mode === 'box') {
    state.drag = { type: 'box' };
    state.box = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  } else if (state.mode === 'seed') {
    state.seed = p;
    segmentSeed();
    state.drag = null;
  }
  draw();
});

canvas.addEventListener('pointermove', (e) => {
  if (!state.drag) return;
  const p = toWork(e);
  state.pointer = p;
  const d = state.drag;
  const clampX = (v) => Math.max(0, Math.min(state.W - 1, v));
  const clampY = (v) => Math.max(0, Math.min(state.H - 1, v));
  if (d.type === 'handle') {
    d.h.x = clampX(p.x + d.off.x); d.h.y = clampY(p.y + d.off.y);
    state.pointer = { x: d.h.x, y: d.h.y };
    computeArea();
  } else if (d.type === 'line') {
    const dx = p.x - d.start.x, dy = p.y - d.start.y;
    state.ruler.a = { x: clampX(d.a0.x + dx), y: clampY(d.a0.y + dy) };
    state.ruler.b = { x: clampX(d.b0.x + dx), y: clampY(d.b0.y + dy) };
  } else if (d.type === 'box') {
    state.box.x1 = clampX(p.x); state.box.y1 = clampY(p.y);
  }
  draw();
});

const endDrag = () => {
  if (!state.drag) return;
  const d = state.drag;
  state.drag = null;
  if (d.type === 'box') segmentBox();
  else update();
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

$('rulerLen').addEventListener('input', () => { computeArea(); draw(); });
$('unit').addEventListener('change', () => { computeArea(); draw(); });
let sensTimer;
$('sensitivity').addEventListener('input', () => {
  clearTimeout(sensTimer);
  sensTimer = setTimeout(() => (state.lastMethod === 'seed' && state.seed ? segmentSeed() : segmentBox()), 120);
});
$('autoBtn').addEventListener('click', () => {
  const m = 0.04, { W, H } = state;
  state.box = { x0: W * m, y0: H * m, x1: W * (1 - m), y1: H * (1 - m) };
  state.objectName = '';
  segmentBox();
});
window.addEventListener('resize', () => state.W && draw());

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
  }
}

function applyAI(r) {
  const { W, H } = state;
  const sx = (v) => Math.max(0, Math.min(W - 1, (v / 1000) * W));
  const sy = (v) => Math.max(0, Math.min(H - 1, (v / 1000) * H));
  const msgs = [];

  const b = r.object_box;
  if (b && b.x_max > b.x_min && b.y_max > b.y_min) {
    // pad the AI box a bit – its coordinates are approximate
    const pw = (b.x_max - b.x_min) * 0.08 + 10, ph = (b.y_max - b.y_min) * 0.08 + 10;
    state.box = { x0: sx(b.x_min - pw), y0: sy(b.y_min - ph), x1: sx(b.x_max + pw), y1: sy(b.y_max + ph) };
  }
  state.objectName = (r.object_name || '').slice(0, 40);
  msgs.push(`Object: ${state.objectName || 'unknown'}.`);

  const dv = Math.abs((r.ruler_value_2 ?? 0) - (r.ruler_value_1 ?? 0));
  const p1 = r.ruler_point_1, p2 = r.ruler_point_2;
  if (r.ruler_found && p1 && p2 && dv > 0 && Math.hypot(p2.x - p1.x, p2.y - p1.y) > 30) {
    state.ruler = { a: { x: sx(p1.x), y: sy(p1.y) }, b: { x: sx(p2.x), y: sy(p2.y) } };
    $('rulerLen').value = +dv.toFixed(3);
    $('unit').value = ['cm', 'mm', 'in'].includes(r.ruler_unit) ? r.ruler_unit : 'cm';
    msgs.push(`Ruler: marks ${r.ruler_value_1} → ${r.ruler_value_2} ${$('unit').value}. Please check the red handles sit exactly on those marks.`);
  } else {
    msgs.push('Ruler not reliably found – please place the red handles manually.');
  }
  $('aiResult').textContent = '✨ ' + msgs.join(' ');
  segmentBox();
}

checkAI();

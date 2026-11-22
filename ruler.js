'use strict';

/* =========================================================================
   Ruler detection without AI.
   A ruler has many thin tick marks with a constant spacing (1 mm, or 1/16 in).
   1. Split the image into tiles and look for a strong periodic pattern
      (2-D FFT) → tiles lying on the ruler's tick marks.
   2. Fit a line through those tiles → ruler direction and position.
   3. Sample the brightness along lines parallel to it, pick the one that
      crosses all small ticks, and measure the tick period very precisely
      with autocorrelation over many ticks.
   4. Find the tick positions (phase) and place the two handles exactly on
      ticks; the distance = number of tick intervals.
   ========================================================================= */

const Ruler = (() => {
  const T = 64;               // FFT tile size
  const MAX_SIDE = 2400;      // resolution used for ruler analysis

  function makeGray(src) {
    const s = Math.min(1, MAX_SIDE / Math.max(src.width, src.height));
    const w = Math.round(src.width * s), h = Math.round(src.height * s);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(src, 0, 0, w, h);
    const d = x.getImageData(0, 0, w, h).data;
    const g = new Float32Array(w * h);
    for (let i = 0; i < g.length; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    return { g, w, h, scale: s };
  }

  /* ---------- FFT (radix-2, in place) ---------- */
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2;
          const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
          const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }

  const hann = new Float32Array(T).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (T - 1)));

  // returns tiles with a strong single-frequency periodic pattern
  function scanTiles(G) {
    const { g, w, h } = G;
    const re = new Float64Array(T * T), im = new Float64Array(T * T);
    const rr = new Float64Array(T), ri = new Float64Array(T);
    const tiles = [];
    for (let ty = 0; ty + T <= h; ty += T / 2) {
      for (let tx = 0; tx + T <= w; tx += T / 2) {
        let mean = 0;
        for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) mean += g[(ty + y) * w + tx + x];
        mean /= T * T;
        let v = 0;
        for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
          const d = g[(ty + y) * w + tx + x] - mean;
          v += d * d;
          re[y * T + x] = d * hann[x] * hann[y]; im[y * T + x] = 0;
        }
        if (Math.sqrt(v / (T * T)) < 12) continue; // too flat
        for (let y = 0; y < T; y++) {
          for (let x = 0; x < T; x++) { rr[x] = re[y * T + x]; ri[x] = im[y * T + x]; }
          fft(rr, ri);
          for (let x = 0; x < T; x++) { re[y * T + x] = rr[x]; im[y * T + x] = ri[x]; }
        }
        for (let x = 0; x < T; x++) {
          for (let y = 0; y < T; y++) { rr[y] = re[y * T + x]; ri[y] = im[y * T + x]; }
          fft(rr, ri);
          for (let y = 0; y < T; y++) { re[y * T + x] = rr[y]; im[y * T + x] = ri[y]; }
        }
        // peak in the band of periods 2.8 … 24 px (half plane)
        let best = 0, bu = 0, bv = 0, sum = 0, cnt = 0;
        for (let v2 = 0; v2 < T / 2; v2++) for (let u2 = -T / 2 + 1; u2 < T / 2; u2++) {
          const r = Math.hypot(u2, v2);
          if (r < T / 24 || r > T / 2.8) continue;
          if (v2 === 0 && u2 < 0) continue;
          const idx = v2 * T + ((u2 + T) % T);
          // ×r² whitens the spectrum: straight edges (∝1/r²) no longer look periodic
          const p = (re[idx] * re[idx] + im[idx] * im[idx]) * r * r;
          sum += p; cnt++;
          if (p > best) { best = p; bu = u2; bv = v2; }
        }
        const score = best / (sum / cnt);
        if (score < 18) continue;

        const r = Math.hypot(bu, bv);
        tiles.push({
          cx: tx + T / 2, cy: ty + T / 2,
          ang: ((Math.atan2(bv, bu) % Math.PI) + Math.PI) % Math.PI, // wave direction = ruler direction
          period: T / r, score,
        });
      }
    }
    return tiles;
  }

  /* ---------- sampling along a line ---------- */
  function sample(G, x, y) {
    const { g, w, h } = G;
    if (x < 0 || y < 0 || x > w - 2 || y > h - 2) return NaN;
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * w + x0;
    return (g[i] * (1 - fx) + g[i + 1] * fx) * (1 - fy) + (g[i + w] * (1 - fx) + g[i + w + 1] * fx) * fy;
  }

  // profile along origin + t*d, t in [t0, t1], averaged over ±1 px across
  function profile(G, o, d, t0, t1) {
    const n = Math.max(0, Math.floor(t1 - t0));
    const nx = -d.y, ny = d.x;
    const p = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = t0 + i;
      let s = 0, c = 0;
      for (let k = -1; k <= 1; k++) {
        const v = sample(G, o.x + d.x * t + nx * k, o.y + d.y * t + ny * k);
        if (!isNaN(v)) { s += v; c++; }
      }
      p[i] = c ? s / c : NaN;
    }
    return p;
  }

  // remove slow brightness changes (numbers, shadows) – keep the ticks
  function detrend(p, win) {
    const n = p.length, out = new Float32Array(n);
    const half = Math.max(2, Math.round(win));
    const pre = new Float64Array(n + 1);
    let last = 0;
    for (let i = 0; i < n; i++) { const v = isNaN(p[i]) ? last : p[i]; last = v; pre[i + 1] = pre[i] + v; }
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - half), b = Math.min(n, i + half + 1);
      out[i] = (isNaN(p[i]) ? 0 : p[i]) - (pre[b] - pre[a]) / (b - a);
    }
    return out;
  }

  function corr(x, L, a = 0, b = x.length) {
    let s = 0, s1 = 0, s2 = 0;
    for (let i = a; i + L < b; i++) { s += x[i] * x[i + L]; s1 += x[i] * x[i]; s2 += x[i + L] * x[i + L]; }
    return s1 && s2 ? s / Math.sqrt(s1 * s2) : 0;
  }

  // best periodic lag in [pMin, pMax] → {P, r}
  function bestLag(x, pMin, pMax) {
    const lo = Math.max(2, Math.floor(pMin)), hi = Math.min(Math.ceil(pMax), (x.length / 3) | 0);
    if (hi <= lo + 1) return null;
    const r = [];
    for (let L = lo - 1; L <= hi + 1; L++) r[L] = corr(x, L);
    let best = -1, bL = 0;
    for (let L = lo; L <= hi; L++) if (r[L] > r[L - 1] && r[L] >= r[L + 1] && r[L] > best) { best = r[L]; bL = L; }
    if (!bL) return null;
    // prefer the smallest lag that is almost as strong (fundamental, not a multiple)
    for (let L = lo; L < bL; L++)
      if (r[L] > r[L - 1] && r[L] >= r[L + 1] && r[L] > 0.75 * best && Math.abs(bL / L - Math.round(bL / L)) < 0.15) { best = r[L]; bL = L; break; }
    return { P: refinePeak(r, bL), r: best };
  }

  function refinePeak(r, L) {
    const a = r[L - 1], b = r[L], c = r[L + 1];
    const den = a - 2 * b + c;
    return den < 0 ? L + 0.5 * (a - c) / den : L;
  }

  // precise period using correlation peaks at large multiples of P
  function refinePeriod(x, P) {
    for (const k of [5, 10, 20, 50, 100, 200]) {
      if (k * P > x.length * 0.6) break;
      const c = Math.round(k * P), r = [];
      let bL = c, best = -Infinity;
      for (let L = c - Math.ceil(P / 2) - 1; L <= c + Math.ceil(P / 2) + 1; L++) r[L] = corr(x, L);
      for (let L = c - Math.ceil(P / 2); L <= c + Math.ceil(P / 2); L++) if (r[L] > best) { best = r[L]; bL = L; }
      if (best < 0.2) break;
      P = refinePeak(r, bL) / k;
    }
    return P;
  }

  // along a candidate ruler axis: find the parallel line with the clearest ticks
  function refineLine(G, o, d, t0, t1, offRange, pMin, pMax) {
    const n = { x: -d.y, y: d.x };
    let best = null;
    const step = Math.max(1, offRange / 16);
    for (let off = -offRange; off <= offRange; off += step) {
      const oo = { x: o.x + n.x * off, y: o.y + n.y * off };
      const raw = profile(G, oo, d, t0, t1);
      const x = detrend(raw, pMax * 0.75);
      const bl = bestLag(x, pMin, pMax);
      if (bl && (!best || bl.r > best.r)) best = { ...bl, off, o: oo, x };
    }
    if (!best || best.r < 0.3) return null;
    best.P = refinePeriod(best.x, best.P);
    return best;
  }

  // the initial direction may be a few degrees off: find the best offset near
  // both ends separately and fit the line through them, then measure along the
  // whole line (clipped to the image)
  function fitLine(G, o, d, t0, t1, offRange, pMin, pMax) {
    for (let it = 0; it < 2; it++) {
      const L = t1 - t0, seg = Math.max(pMax * 8, L / 3);
      const n = { x: -d.y, y: d.x };
      const ends = [];
      for (const [a, b] of [[t0, t0 + seg], [t1 - seg, t1]]) {
        const r = refineLine(G, { x: o.x + d.x * a, y: o.y + d.y * a }, d, 0, b - a, offRange, pMin, pMax);
        if (!r) return null;
        const tc = (a + b) / 2;
        ends.push({ x: o.x + d.x * tc + n.x * r.off, y: o.y + d.y * tc + n.y * r.off, tc });
      }
      const len = Math.hypot(ends[1].x - ends[0].x, ends[1].y - ends[0].y);
      if (len < 1) return null;
      const nd = { x: (ends[1].x - ends[0].x) / len, y: (ends[1].y - ends[0].y) / len };
      o = ends[0]; d = nd;
      t0 = t0 - ends[0].tc; t1 = t1 - ends[0].tc;
      offRange = Math.max(4, offRange / 3);
    }
    // extend along the line to the image border – the ruler may be longer
    const lim = (v, dv, max) => dv > 1e-6 ? [(-v) / dv, (max - 2 - v) / dv] : dv < -1e-6 ? [(max - 2 - v) / dv, (-v) / dv] : [-Infinity, Infinity];
    const [ax, bx] = lim(o.x, d.x, G.w), [ay, by] = lim(o.y, d.y, G.h);
    const T0 = Math.max(ax, ay, -1e5), T1 = Math.min(bx, by, 1e5);
    const line = refineLine(G, o, d, T0, T1, 3, pMin, pMax);
    if (!line) return null;
    line.t0 = T0; line.d = d;
    return line;
  }

  // extent of the periodic part and tick positions
  function locateTicks(x, P, minRun = 6) {
    const n = x.length, Pi = Math.round(P);
    // local periodicity score
    const loc = new Float32Array(n);
    const win = Math.round(P * 3);
    for (let i = 0; i < n; i++) {
      let s = 0, s1 = 0, s2 = 0;
      for (let k = Math.max(0, i - win); k <= Math.min(n - 1 - Pi, i + win); k++) {
        s += x[k] * x[k + Pi]; s1 += x[k] * x[k]; s2 += x[k + Pi] * x[k + Pi];
      }
      loc[i] = s1 && s2 ? s / Math.sqrt(s1 * s2) : 0;
    }
    // longest run with good local periodicity (short gaps – e.g. a digit – allowed)
    const good = new Uint8Array(n);
    for (let i = 0; i < n; i++) good[i] = loc[i] > 0.35 ? 1 : 0;
    const gap = Math.round(P * 2.5);
    for (let i = 0, last = -1; i < n; i++) if (good[i]) {
      if (last >= 0 && i - last > 1 && i - last <= gap) for (let k = last; k < i; k++) good[k] = 1;
      last = i;
    }
    let bs = 0, be = 0, cs = -1;
    for (let i = 0; i <= n; i++) {
      const ok = i < n && good[i];
      if (ok && cs < 0) cs = i;
      if (!ok && cs >= 0) { if (i - cs > be - bs) { bs = cs; be = i; } cs = -1; }
    }
    if (be - bs < P * minRun) return null;
    // tick polarity from skewness (thin dark ticks on a light ruler → negative),
    // tick position from the phase of the fundamental frequency
    let m = 0;
    for (let i = bs; i < be; i++) m += x[i];
    m /= be - bs;
    let m2 = 0, m3 = 0, C = 0, S = 0;
    for (let i = bs; i < be; i++) {
      const v = x[i] - m;
      m2 += v * v; m3 += v * v * v;
      const w = 2 * Math.PI * i / P;
      C += v * Math.cos(w); S += v * Math.sin(w);
    }
    m2 /= be - bs; m3 /= be - bs;
    const skew = m2 > 0 ? m3 / Math.pow(m2, 1.5) : 0;
    const dark = skew < 0.3;            // most rulers: dark ticks; only flip on clear evidence
    let phase = Math.atan2(S, C) / (2 * Math.PI) * P;   // brightest point of the wave
    if (dark) phase += P / 2;
    phase = ((phase % P) + P) % P;
    const sharp = 1 + Math.abs(skew);
    let k0 = Math.ceil((bs - phase) / P), k1 = Math.floor((be - 1 - phase) / P);
    // drop phantom ticks at the ends (the periodicity window reaches a bit past the ruler)
    const val = (t) => {
      const i = Math.floor(t), f = t - i;
      return i >= 0 && i + 1 < n ? x[i] * (1 - f) + x[i + 1] * f : 0;
    };
    const contrast = (k) => {
      const t = phase + k * P;
      const c = val(t) - (val(t - P / 2) + val(t + P / 2)) / 2;
      return dark ? -c : c;
    };
    const cs2 = [];
    for (let k = k0; k <= k1; k++) cs2.push(contrast(k));
    const medC = cs2.slice().sort((p, q) => p - q)[cs2.length >> 1] || 0;
    while (k1 > k0 && contrast(k0) < medC * 0.4) k0++;
    while (k1 > k0 && contrast(k1) < medC * 0.4) k1--;
    return { first: phase + k0 * P, count: k1 - k0, start: bs, end: be, sharp };
  }

  function finish(G, line, P) {
    const tk = locateTicks(line.x, P);
    if (!tk || tk.count < 5) return null;
    let N = tk.count;
    if (N >= 20) N -= N % 10;         // whole centimetres look nicer
    else if (N >= 10) N -= N % 5;
    // center the chosen span within the detected ticks
    const shift = Math.floor((tk.count - N) / 2);
    const tA = line.t0 + tk.first + shift * P, tB = tA + N * P;
    const { o, d } = line;
    return {
      a: { x: (o.x + d.x * tA) / G.scale, y: (o.y + d.y * tA) / G.scale },
      b: { x: (o.x + d.x * tB) / G.scale, y: (o.y + d.y * tB) / G.scale },
      ticks: N, periodPx: P / G.scale, strength: line.r,
    };
  }

  /* ---------- public ---------- */

  // full automatic search. Coordinates returned in source-image pixels.
  function detect(G) {
    const tiles = scanTiles(G);
    if (tiles.length < 3) return null;
    // vote: orientation (6° bins) × period (log bins)
    const AB = 30, votes = new Map();
    const key = (t) => {
      const a = Math.round(t.ang / Math.PI * AB) % AB;
      const p = Math.round(Math.log(t.period) / Math.log(1.25));
      return a + ':' + p;
    };
    for (const t of tiles) {
      const [a, p] = key(t).split(':').map(Number);
      for (let da = -1; da <= 1; da++) for (let dp = -1; dp <= 1; dp++) {
        const k = ((a + da + AB) % AB) + ':' + (p + dp);
        votes.set(k, (votes.get(k) || 0) + Math.log(t.score) * (da || dp ? 0.5 : 1));
      }
    }
    // pre-rank every orientation/period bin by its most "ruler-like" band:
    // many tiles in one narrow strip, few similar tiles beside it
    const cands = [];
    for (const [k] of votes) {
      const [a, p] = k.split(':').map(Number);
      const ang = a / AB * Math.PI, per = Math.pow(1.25, p);
      const sel = tiles.filter((t) => {
        let da = Math.abs(t.ang - ang); da = Math.min(da, Math.PI - da);
        return da < Math.PI / AB * 1.6 && Math.abs(Math.log(t.period / per)) < Math.log(1.25) * 1.6;
      });
      if (sel.length < 4) continue;
      const n = { x: -Math.sin(ang), y: Math.cos(ang) };
      const offs = sel.map((t) => t.cx * n.x + t.cy * n.y);
      let bestQ = 0;
      for (let i = 0; i < offs.length; i++) {
        let inB = 0, side = 0;
        for (let j = 0; j < offs.length; j++) {
          const dd = Math.abs(offs[j] - offs[i]);
          if (dd < T * 0.75) inB++; else if (dd < T * 3) side++;
        }
        bestQ = Math.max(bestQ, inB / (1 + side / 3) * Math.sqrt(inB));
      }
      cands.push([k, bestQ]);
    }
    const candidates = cands.sort((a, b) => b[1] - a[1]).slice(0, 10);
    let best = null;
    const tried = new Set();
    for (const [k] of candidates) {
      const [a, p] = k.split(':').map(Number);
      const ang = a / AB * Math.PI, per = Math.pow(1.25, p);
      const sel = tiles.filter((t) => {
        let da = Math.abs(t.ang - ang); da = Math.min(da, Math.PI - da);
        return da < Math.PI / AB * 1.6 && Math.abs(Math.log(t.period / per)) < Math.log(1.25) * 1.6;
      });
      if (sel.length < 3) continue;
      const d = { x: Math.cos(ang), y: Math.sin(ang) }, n = { x: -d.y, y: d.x };
      const offs = sel.map((t) => t.cx * n.x + t.cy * n.y);
      const along0 = sel.map((t) => t.cx * d.x + t.cy * d.y);
      // a ruler is a narrow strip: look for bands with many tiles in a row
      // and few similar tiles beside them (unlike a textured background)
      const bands = [];
      for (let i = 0; i < offs.length; i++) {
        const inB = [], side = [];
        for (let j = 0; j < offs.length; j++) {
          const dd = Math.abs(offs[j] - offs[i]);
          if (dd < T * 0.75) inB.push(j);
          else if (dd < T * 3) side.push(j);
        }
        bands.push({ bo: offs[i], inB, iso: inB.length / (1 + side.length / 3) });
      }
      bands.sort((x, y) => y.iso * Math.sqrt(y.inB.length) - x.iso * Math.sqrt(x.inB.length));
      for (const band of bands.slice(0, 3)) {
        if (band.inB.length < 3) continue;
        const along = band.inB.map((j) => along0[j]);
        const t0 = Math.min(...along) - T, t1 = Math.max(...along) + T;
        if (t1 - t0 < T * 4) continue;
        const sig = a + ':' + Math.round(band.bo / T) + ':' + Math.round(t0 / T);
        if (tried.has(sig)) continue;
        tried.add(sig);
        const o = { x: n.x * band.bo, y: n.y * band.bo };
        const line = fitLine(G, o, d, t0, t1, T * 0.75, per * 0.75, per * 1.35);
        if (!line) continue;
        const tk = locateTicks(line.x, line.P);

        if (!tk || tk.count < 15 || line.r < 0.5) continue;
        const score = line.r * tk.count * Math.min(2, tk.sharp) * Math.min(4, band.iso);
        if (!best || score > best.score) best = { line, score };
      }
    }
    if (!best) return null;
    return finish(G, best.line, best.line.P);
  }

  // refine around an approximate ruler line (from AI or from the user)
  function refine(G, a, b, searchFrac = 0.04) {
    const A = { x: a.x * G.scale, y: a.y * G.scale }, B = { x: b.x * G.scale, y: b.y * G.scale };
    const len = Math.hypot(B.x - A.x, B.y - A.y);
    if (len < 40) return null;
    const d = { x: (B.x - A.x) / len, y: (B.y - A.y) / len };
    const ext = len * 0.15;
    const off = Math.max(8, Math.max(G.w, G.h) * searchFrac);
    const line = fitLine(G, A, d, -ext, len + ext, off, 2.8, 30);
    if (!line) return null;
    return finish(G, line, line.P);
  }

  // snap one point to the nearest tick along the ruler direction
  function snap(G, p, other, periodPx) {
    const P = { x: p.x * G.scale, y: p.y * G.scale }, Q = { x: other.x * G.scale, y: other.y * G.scale };
    const len = Math.hypot(Q.x - P.x, Q.y - P.y);
    if (len < 10) return p;
    const d = { x: (Q.x - P.x) / len, y: (Q.y - P.y) / len };
    const per = periodPx * G.scale;
    const R = per * 5;
    const x = detrend(profile(G, P, d, -R, R), per * 0.75);
    const tk = locateTicks(x, per, 3);
    if (!tk) return p;
    const k = Math.round((R - tk.first) / per);
    const t = -R + tk.first + k * per;
    return { x: (P.x + d.x * t) / G.scale, y: (P.y + d.y * t) / G.scale };
  }

  return { makeGray, detect, refine, snap };
})();

// แบบจำลองพื้นที่น้ำท่วมจากแบบจำลองระดับสูงภูมิประเทศ (DEM)
// วิธี: HAND (Height Above Nearest Drainage) + flood-fill ที่เชื่อมต่อกับลำน้ำ
//  1) ลากแนวแม่น้ำปิงตามท้องหุบเขาใน DEM (เส้นทางต้นทุนต่ำสุดผ่านสถานีวัดน้ำ)
//  2) HAND = ความสูงของแต่ละพิกเซลเหนือระดับพื้นริมตลิ่ง (ใน DEM) ของจุดลำน้ำที่ใกล้ที่สุด
//  3) ระดับน้ำเหนือตลิ่งที่แต่ละจุดของลำน้ำ ประมาณจากสถานีอ้างอิง (ระดับน้ำ − ระดับตลิ่งที่สำรวจจริง)
//  4) ท่วมเมื่อ HAND < ระดับน้ำเหนือตลิ่ง และเชื่อมต่อกับลำน้ำ ภายในระยะที่กำหนด
// ข้อจำกัด: DEM ความละเอียด ~30 ม. (SRTM) ไม่รวมคันกั้นน้ำ/ท่อระบายน้ำ — ใช้เพื่อการเฝ้าระวังเบื้องต้นเท่านั้น
import { CONFIG } from './config.js';

const lon2x = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const lat2y = (lat, z) => ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z;
const x2lon = (x, z) => (x / 2 ** z) * 360 - 180;
const y2lat = (y, z) => { const n = Math.PI - (2 * Math.PI * y) / 2 ** z; return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); };

function loadImg(url) {
  return new Promise((res, rej) => {
    const im = new Image(); im.crossOrigin = 'anonymous';
    im.onload = () => res(im); im.onerror = () => rej(new Error('tile ' + url)); im.src = url;
  });
}

// ตัวกรอง min/max แบบแยกแกน (separable) รัศมี r พิกเซล
function filter2D(src, W, H, r, op) {
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    let v = src[j * W + i];
    for (let k = Math.max(0, i - r); k <= Math.min(W - 1, i + r); k++) v = op(v, src[j * W + k]);
    tmp[j * W + i] = v;
  }
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    let v = tmp[j * W + i];
    for (let k = Math.max(0, j - r); k <= Math.min(H - 1, j + r); k++) v = op(v, tmp[k * W + i]);
    out[j * W + i] = v;
  }
  return out;
}
function boxFilter(src, W, H, r) {
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    let s = 0, n = 0;
    for (let k = Math.max(0, i - r); k <= Math.min(W - 1, i + r); k++) { s += src[j * W + k]; n++; }
    tmp[j * W + i] = s / n;
  }
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    let s = 0, n = 0;
    for (let k = Math.max(0, j - r); k <= Math.min(H - 1, j + r); k++) { s += tmp[k * W + i]; n++; }
    out[j * W + i] = s / n;
  }
  return out;
}

export class FloodModel {
  async loadDEM(onProgress = () => {}) {
    const z = CONFIG.floodZoom, b = CONFIG.floodBBox;
    const x0 = Math.floor(lon2x(b.west, z)), x1 = Math.floor(lon2x(b.east, z));
    const y0 = Math.floor(lat2y(b.north, z)), y1 = Math.floor(lat2y(b.south, z));
    const nx = x1 - x0 + 1, ny = y1 - y0 + 1, T = 256;
    const W = nx * T, Hh = ny * T;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = Hh;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    let done = 0;
    await Promise.all([...Array(nx * ny)].map(async (_, i) => {
      const tx = x0 + (i % nx), ty = y0 + Math.floor(i / nx);
      const im = await loadImg(CONFIG.terrainTiles.replace('{z}', z).replace('{x}', tx).replace('{y}', ty));
      ctx.drawImage(im, (tx - x0) * T, (ty - y0) * T);
      onProgress(`โหลด DEM ${++done}/${nx * ny}`);
    }));
    const px = ctx.getImageData(0, 0, W, Hh).data;
    const dem = new Float32Array(W * Hh);
    for (let i = 0; i < W * Hh; i++) dem[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
    // SRTM เป็นแบบจำลองพื้นผิว (รวมอาคาร/ต้นไม้) → ประมาณพื้นดินจริงด้วย morphological opening
    // (min แล้ว max ที่รัศมี ~55 ม. ตัดสิ่งปลูกสร้างที่แคบกว่า ~110 ม.) แล้วปรับให้เรียบด้วยค่าเฉลี่ย
    const ground = boxFilter(filter2D(filter2D(dem, W, Hh, 3, Math.min), W, Hh, 3, Math.max), W, Hh, 2);
    Object.assign(this, { z, x0, y0, W, H: Hh, dem: ground, rawDem: dem });
    this.coords = [
      [x2lon(x0, z), y2lat(y0, z)], [x2lon(x1 + 1, z), y2lat(y0, z)],
      [x2lon(x1 + 1, z), y2lat(y1 + 1, z)], [x2lon(x0, z), y2lat(y1 + 1, z)],
    ];
    this.mPerPx = (40075016.7 * Math.cos((18.8 * Math.PI) / 180)) / (2 ** z * T);
    return this;
  }

  pix(lon, lat) {
    return [Math.floor((lon2x(lon, this.z) - this.x0) * 256), Math.floor((lat2y(lat, this.z) - this.y0) * 256)];
  }
  lonlat(i, j) { return [x2lon(this.x0 + (i + 0.5) / 256, this.z), y2lat(this.y0 + (j + 0.5) / 256, this.z)]; }

  elevationAt(lon, lat) {
    const [i, j] = this.pix(lon, lat);
    if (i < 0 || j < 0 || i >= this.W || j >= this.H) return null;
    return this.dem[j * this.W + i];
  }

  // กำหนดสถานีอ้างอิง (จากข้อมูลสด) แล้วลากแนวลำน้ำตามท้องหุบเขาใน DEM
  setAnchors(stations) {
    const anchors = [];
    for (const code of CONFIG.riverAnchors) {
      const s = stations.find((x) => x.code === code);
      if (!s || s.msl === null || s.bank === null) continue;
      anchors.push({ code, lat: s.lat, lon: s.lon, msl: s.msl, bank: s.bank });
    }
    anchors.sort((a, b) => b.lat - a.lat);
    this.anchors = anchors;
    if (!this.riverPx) this._traceRiver();
    return anchors;
  }

  // แนวลำน้ำ = เส้นทางต้นทุนต่ำสุด (Dijkstra) ผ่านพิกเซลที่ต่ำ ระหว่างขอบบน → สถานีในกริด → ขอบล่าง
  _traceRiver() {
    const { W, H, dem } = this;
    const pts = this.anchors.map((a) => this.pix(a.lon, a.lat)).filter(([i, j]) => i >= 0 && j >= 0 && i < W && j < H);
    let lo = Infinity, hi = -Infinity;
    for (const v of dem) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const cost = (p) => 1 + ((dem[p] - lo) / 2) ** 3;
    const path = [];
    // ขอบบน → สถานีแรก, สถานี → สถานี, สถานีสุดท้าย → ขอบล่าง
    const legs = [['top', pts[0]], ...pts.slice(1).map((p, k) => [pts[k], p]), [pts[pts.length - 1], 'bottom']];
    for (const [a, b] of legs) path.push(...this._dijkstra(a, b, cost));
    this.riverPx = path;
    this._nearestRiver();
  }

  _dijkstra(from, to, cost) {
    const { W, H } = this, N = W * H;
    const dist = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1);
    const heap = []; // binary heap ของ [d, p]
    const push = (d, p) => { heap.push([d, p]); let i = heap.length - 1; while (i) { const q = (i - 1) >> 1; if (heap[q][0] <= heap[i][0]) break; [heap[q], heap[i]] = [heap[i], heap[q]]; i = q; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    const isTarget = to === 'bottom' ? (p) => ((p / W) | 0) === H - 1 : (p) => p === to[1] * W + to[0];
    if (from === 'top') for (let i = 0; i < W; i++) { dist[i] = cost(i); push(dist[i], i); }
    else { const s = from[1] * W + from[0]; dist[s] = 0; push(0, s); }
    // จำกัดให้ค้นหาในแนวที่ไม่ห่างจากเส้นตรงระหว่างจุดเกิน ~3 กม.
    const marg = 3000 / this.mPerPx;
    const fi = from === 'top' ? null : from, ti = to === 'bottom' ? null : to;
    const jMin = Math.max(0, Math.min(fi ? fi[1] : 0, ti ? ti[1] : H) - marg), jMax = Math.min(H - 1, Math.max(fi ? fi[1] : 0, ti ? ti[1] : H - 1) + marg);
    const anchorI = fi || ti;
    let end = -1;
    while (heap.length) {
      const [d, p] = pop();
      if (d > dist[p]) continue;
      if (isTarget(p)) { end = p; break; }
      const i = p % W, j = (p / W) | 0;
      for (const [di, dj, w] of [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [-1, 1, 1.414], [1, -1, 1.414], [-1, -1, 1.414]]) {
        const a = i + di, b = j + dj;
        if (a < 0 || b < 0 || a >= W || b >= H || b < jMin || b > jMax || Math.abs(a - anchorI[0]) > marg * 1.5) continue;
        const n = b * W + a, nd = d + w * cost(n);
        if (nd < dist[n]) { dist[n] = nd; prev[n] = p; push(nd, n); }
      }
    }
    const out = [];
    for (let p = end; p !== -1; p = prev[p]) out.push([p % W, (p / W) | 0]);
    return out.reverse();
  }

  // สำหรับทุกพิกเซล: ระยะถึงลำน้ำ และลำน้ำจุดที่ใกล้ที่สุด (BFS หลายต้นทาง)
  _nearestRiver() {
    const { W, H, dem } = this, N = W * H;
    const d = new Float32Array(N).fill(Infinity), src = new Int32Array(N).fill(-1), q = [];
    for (const [i, j] of this.riverPx) { const p = j * W + i; if (d[p]) { d[p] = 0; src[p] = p; q.push(p); } }
    for (let h = 0; h < q.length; h++) {
      const p = q[h], i = p % W, j = (p / W) | 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const a = i + di, b = j + dj;
        if (a < 0 || b < 0 || a >= W || b >= H) continue;
        const n = b * W + a;
        if (d[n] === Infinity) { d[n] = d[p] + 1; src[n] = src[p]; q.push(n); }
      }
    }
    // ระดับอ้างอิงของลำน้ำ ณ แต่ละจุด = เปอร์เซ็นไทล์ที่ 10 ของ DEM ในรัศมี ~250 ม. (≈ ระดับตลิ่ง/ที่ราบริมน้ำใน DEM)
    const r = Math.round(250 / this.mPerPx), ref = new Map();
    for (const [i, j] of this.riverPx) {
      const vals = [];
      for (let y = j - r; y <= j + r; y += 2) for (let x = i - r; x <= i + r; x += 2) if (x >= 0 && y >= 0 && x < W && y < H) vals.push(dem[y * W + x]);
      vals.sort((a, b) => a - b);
      ref.set(j * W + i, vals[Math.floor(vals.length * 0.1)]);
    }
    // HAND = ความสูงเหนือระดับอ้างอิงของลำน้ำที่ใกล้ที่สุด
    const hand = new Float32Array(N);
    for (let p = 0; p < N; p++) hand[p] = src[p] >= 0 ? dem[p] - ref.get(src[p]) : 99;
    Object.assign(this, { dist: d, src, hand });
  }

  // ระดับน้ำเหนือตลิ่ง (ม.) ตามละติจูด ประมาณจากสถานีอ้างอิง เมื่อ P.1 เปลี่ยนไป delta ม.
  _excessAtLat(lat, delta) {
    const A = this.anchors.map((a) => ({ lat: a.lat, e: a.msl - a.bank + delta }));
    if (lat >= A[0].lat) return A[0].e;
    if (lat <= A[A.length - 1].lat) return A[A.length - 1].e;
    for (let n = 1; n < A.length; n++) if (lat >= A[n].lat) {
      const a = A[n - 1], b = A[n], f = (lat - b.lat) / (a.lat - b.lat);
      return b.e + f * (a.e - b.e);
    }
    return A[0].e;
  }

  // คำนวณพื้นที่น้ำท่วมเมื่อระดับที่ P.1 = gaugeLevel (ม.)
  compute(gaugeLevel, p1CurrentGauge) {
    const { W, H, hand, dist, src } = this;
    const delta = gaugeLevel - p1CurrentGauge;
    const exRow = new Float32Array(H);
    for (let j = 0; j < H; j++) exRow[j] = this._excessAtLat(this.lonlat(0, j)[1], delta);
    const excess = (p) => exRow[(src[p] / W) | 0]; // ระดับเหนือตลิ่งของลำน้ำจุดที่ใกล้ที่สุด
    const maxD = (CONFIG.floodMaxDistKm * 1000) / this.mPerPx;
    const depth = new Float32Array(W * H), seen = new Uint8Array(W * H), q = [];
    for (const [i, j] of this.riverPx) {
      const p = j * W + i;
      if (!seen[p] && hand[p] < excess(p)) { seen[p] = 1; q.push(p); }
    }
    for (let h = 0; h < q.length; h++) {
      const p = q[h], i = p % W, j = (p / W) | 0;
      depth[p] = excess(p) - hand[p];
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const a = i + di, b = j + dj;
        if (a < 0 || b < 0 || a >= W || b >= H) continue;
        const n = b * W + a;
        if (!seen[n] && dist[n] <= maxD && hand[n] < excess(n)) { seen[n] = 1; q.push(n); }
      }
    }
    // สถิติไม่นับแนวลำน้ำเอง (±80 ม. จากแนวร่องน้ำ)
    const chan = 80 / this.mPerPx;
    let area = 0, maxDepth = 0, sumDepth = 0;
    for (let p = 0; p < W * H; p++) if (depth[p] > 0.05 && dist[p] > chan) {
      area++; sumDepth += depth[p]; if (depth[p] > maxDepth) maxDepth = depth[p];
    }
    const km2 = (area * this.mPerPx ** 2) / 1e6;
    this.last = { depth, gaugeLevel };
    return { depth, km2, maxDepth, meanDepth: area ? sumDepth / area : 0 };
  }

  riverGeoJSON() {
    const c = this.riverPx.filter((_, k) => k % 3 === 0).map(([i, j]) => this.lonlat(i, j));
    return { type: 'Feature', geometry: { type: 'LineString', coordinates: c }, properties: {} };
  }

  depthAt(lon, lat) {
    if (!this.last) return null;
    const [i, j] = this.pix(lon, lat);
    if (i < 0 || j < 0 || i >= this.W || j >= this.H) return null;
    const d = this.last.depth[j * this.W + i];
    return d > 0 ? d : 0;
  }

  // เรนเดอร์ความลึกน้ำเป็นภาพ (data URL) สำหรับ MapLibre image source
  render(depth) {
    const { W, H } = this;
    const cv = this._cv || (this._cv = Object.assign(document.createElement('canvas'), { width: W, height: H }));
    const ctx = cv.getContext('2d'), img = ctx.createImageData(W, H), px = img.data;
    const ramp = [[0.3, [158, 202, 225]], [0.8, [107, 174, 214]], [1.5, [49, 130, 189]], [2.5, [8, 81, 156]], [99, [8, 48, 107]]];
    for (let p = 0; p < W * H; p++) {
      const d = depth[p];
      if (!(d > 0.05)) continue;
      const c = ramp.find((r) => d < r[0])[1];
      px[p * 4] = c[0]; px[p * 4 + 1] = c[1]; px[p * 4 + 2] = c[2]; px[p * 4 + 3] = 200;
    }
    ctx.putImageData(img, 0, 0);
    return cv.toDataURL();
  }
}

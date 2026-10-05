// โมเดล AI คาดการณ์ระดับน้ำที่ P.1 ล่วงหน้า 3–72 ชม.
// วิธี: Ridge regression แบบ direct multi-horizon (หนึ่งโมเดลต่อหนึ่งช่วงเวลาคาดการณ์)
// ฟีเจอร์: ระดับน้ำ P.1 + แนวโน้ม, ระดับน้ำต้นน้ำ P.67 + แนวโน้ม, ฝนสะสมย้อนหลัง, ฝนคาดการณ์ข้างหน้า
// ฝึกบนข้อมูลจริงรายชั่วโมงฤดูฝน 2567–2568 (รวมเหตุการณ์น้ำท่วมใหญ่ ต.ค. 2567)
import { CONFIG, p1Gauge } from './config.js';
import { fetchStationHistory, fetchCatchmentRainArchive } from './api.js';

const H = 3600e3;
const hourKey = (t) => Math.round(t / H);

// ---------- อนุกรมเวลารายชั่วโมง ----------
export function toHourly(rows, field = 'v') {
  const m = new Map();
  for (const r of rows) if (r[field] !== null && r[field] !== undefined) m.set(hourKey(r.t), r[field]);
  // เติมช่องว่างไม่เกิน 6 ชม. ด้วยการประมาณค่าเชิงเส้น
  const keys = [...m.keys()].sort((a, b) => a - b);
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1], b = keys[i];
    if (b - a > 1 && b - a <= 6) for (let k = a + 1; k < b; k++) m.set(k, m.get(a) + ((m.get(b) - m.get(a)) * (k - a)) / (b - a));
  }
  return m;
}

function rainSum(rain, k0, k1) { // ผลรวมฝนชั่วโมง (k0, k1]
  let s = 0;
  for (let k = k0 + 1; k <= k1; k++) { const v = rain.get(k); if (v === undefined) return null; s += v; }
  return s;
}

function features(k, Hh, p1, up, rain) {
  const h = p1.get(k), h6 = p1.get(k - 6), h24 = p1.get(k - 24);
  const u = up.get(k), u6 = up.get(k - 6);
  if ([h, h6, h24, u, u6].some((x) => x === undefined)) return null;
  const rp6 = rainSum(rain, k - 6, k), rp24 = rainSum(rain, k - 24, k), rp72 = rainSum(rain, k - 72, k);
  const split = Math.min(Hh, 12);
  const rfA = rainSum(rain, k, k + split), rfB = Hh > 12 ? rainSum(rain, k + 12, k + Hh) : 0;
  if ([rp6, rp24, rp72, rfA, rfB].some((x) => x === null)) return null;
  return [
    h, h - h6, h - h24, u, u - u6,
    rp6, rp24, rp72, rfA, rfB,
    h * h, Math.sqrt(rp24 + rfA + rfB), h * (rfA + rfB) / 50,
  ];
}
export const FEATURE_NAMES = [
  'ระดับ P.1', 'แนวโน้ม 6 ชม.', 'แนวโน้ม 24 ชม.', 'ระดับต้นน้ำ P.67', 'แนวโน้ม P.67 6 ชม.',
  'ฝน 6 ชม.ก่อน', 'ฝน 24 ชม.ก่อน', 'ฝน 72 ชม.ก่อน', 'ฝนคาดการณ์ 0–12 ชม.', 'ฝนคาดการณ์ 12 ชม.+',
  'ระดับ²', '√ฝนรวม', 'ระดับ×ฝนข้างหน้า',
];

// ---------- Ridge regression ----------
function fitRidge(X, y, lambda) {
  const n = X.length, d = X[0].length;
  const mu = Array(d).fill(0), sd = Array(d).fill(0);
  for (const r of X) r.forEach((v, j) => (mu[j] += v / n));
  for (const r of X) r.forEach((v, j) => (sd[j] += (v - mu[j]) ** 2 / n));
  for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  const ym = y.reduce((a, b) => a + b, 0) / n;
  const A = Array.from({ length: d }, () => Array(d + 1).fill(0));
  for (let i = 0; i < n; i++) {
    const z = X[i].map((v, j) => (v - mu[j]) / sd[j]);
    for (let a = 0; a < d; a++) {
      for (let b = 0; b < d; b++) A[a][b] += z[a] * z[b];
      A[a][d] += z[a] * (y[i] - ym);
    }
  }
  for (let a = 0; a < d; a++) A[a][a] += lambda;
  // Gauss-Jordan
  for (let c = 0; c < d; c++) {
    let p = c;
    for (let r = c + 1; r < d; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < d; r++) if (r !== c) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k <= d; k++) A[r][k] -= f * A[c][k];
    }
  }
  const w = A.map((row, j) => row[d] / row[j]);
  return { w, mu, sd, b: ym };
}
const predictRidge = (m, x) => m.b + x.reduce((s, v, j) => s + m.w[j] * ((v - m.mu[j]) / m.sd[j]), 0);

function dataset(seasons, Hh) {
  const X = [], y = [], seg = [];
  seasons.forEach((s, si) => {
    for (const k of s.p1.keys()) {
      const f = features(k, Hh, s.p1, s.up, s.rain);
      const target = s.p1.get(k + Hh);
      if (!f || target === undefined) continue;
      X.push(f); y.push(target - s.p1.get(k)); seg.push(si);
    }
  });
  return { X, y, seg };
}

const rmse = (a, b) => Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0) / a.length);

// ---------- โค้งความสัมพันธ์ระดับน้ำ–อัตราการไหล (rating curve) ----------
function fitRating(rows) {
  const pts = rows.filter((r) => r.q > 0).map((r) => [r.q, p1Gauge(r.v)]).sort((a, b) => a[0] - b[0]);
  const bins = 40, out = [];
  for (let i = 0; i < bins; i++) {
    const s = pts.slice(Math.floor((i * pts.length) / bins), Math.floor(((i + 1) * pts.length) / bins));
    if (!s.length) continue;
    out.push([s.reduce((a, p) => a + p[0], 0) / s.length, s.reduce((a, p) => a + p[1], 0) / s.length]);
  }
  for (let i = 1; i < out.length; i++) out[i][1] = Math.max(out[i][1], out[i - 1][1]);
  return out;
}
export function stageFromQ(rating, q) {
  if (!rating?.length || q === null) return null;
  if (q <= rating[0][0]) return rating[0][1];
  for (let i = 1; i < rating.length; i++) if (q <= rating[i][0]) {
    const [q0, h0] = rating[i - 1], [q1, h1] = rating[i];
    return h0 + ((h1 - h0) * (q - q0)) / (q1 - q0 || 1);
  }
  const [qa, ha] = rating[rating.length - 4] || rating[0], [qb, hb] = rating[rating.length - 1];
  return hb + ((hb - ha) / (qb - qa || 1)) * (q - qb);
}

// ---------- การฝึกโมเดล ----------
export async function trainModel(upBank, onProgress = () => {}) {
  const cacheKey = `cmflood:${CONFIG.modelVersion}`;
  try {
    const c = JSON.parse(localStorage.getItem(cacheKey) || 'null');
    if (c && Date.now() - c.trainedAt < 30 * 864e5) { onProgress('ใช้โมเดลที่ฝึกไว้ (แคช)'); return c; }
  } catch { /* ไม่มี storage ก็ฝึกใหม่ */ }

  const seasons = [], ratingRows = [];
  for (const [start, end] of CONFIG.trainingSeasons) {
    onProgress(`กำลังโหลดข้อมูลฝึก ${start.slice(0, 4)}…`);
    try {
      const [p1, up, rain] = await Promise.all([
        fetchStationHistory(CONFIG.p1.id, start, end),
        fetchStationHistory(CONFIG.p67.id, start, end),
        fetchCatchmentRainArchive(start, end),
      ]);
      ratingRows.push(...p1);
      seasons.push({
        name: start.slice(0, 4),
        p1: toHourly(p1.map((r) => ({ t: r.t, v: p1Gauge(r.v) }))),
        up: toHourly(up.map((r) => ({ t: r.t, v: r.v - upBank }))),
        rain: new Map(rain.map((r) => [hourKey(r.t), r.r])),
      });
    } catch (e) { console.warn('training season failed', start, e); }
  }
  if (!seasons.length) throw new Error('โหลดข้อมูลฝึกโมเดลไม่สำเร็จ');

  onProgress('กำลังฝึกโมเดล…');
  const models = {}, metrics = {};
  for (const Hh of CONFIG.horizons) {
    const { X, y, seg } = dataset(seasons, Hh);
    // ตรวจสอบความแม่น: ฝึกปีแรก ทดสอบปีหลัง (ถ้ามี 2 ปี) — ไม่งั้นแบ่ง 80/20 ตามเวลา
    const testIdx = seasons.length > 1 ? seg.map((s) => s === seasons.length - 1) : y.map((_, i) => i >= y.length * 0.8);
    const Xtr = X.filter((_, i) => !testIdx[i]), ytr = y.filter((_, i) => !testIdx[i]);
    const Xte = X.filter((_, i) => testIdx[i]), yte = y.filter((_, i) => testIdx[i]);
    let best = null;
    for (const lambda of [0.3, 3, 30, 300]) {
      const m = fitRidge(Xtr, ytr, lambda);
      const e = rmse(Xte.map((x) => predictRidge(m, x)), yte);
      if (!best || e < best.e) best = { lambda, e };
    }
    const persistence = rmse(yte.map(() => 0), yte); // เทียบกับการเดาว่า "ระดับคงที่"
    models[Hh] = fitRidge(X, y, best.lambda);
    // ความแม่นในช่วงน้ำสูง (≥ 3.2 ม.)
    const hiI = Xte.map((x, i) => (x[0] >= 3.2 ? i : -1)).filter((i) => i >= 0);
    const mTr = fitRidge(Xtr, ytr, best.lambda);
    const hiRmse = hiI.length > 10 ? rmse(hiI.map((i) => predictRidge(mTr, Xte[i])), hiI.map((i) => yte[i])) : null;
    metrics[Hh] = { rmse: best.e, persistence, hiRmse, n: X.length, nTest: yte.length, lambda: best.lambda };
  }
  const out = {
    trainedAt: Date.now(), models, metrics,
    rating: fitRating(ratingRows),
    seasons: seasons.map((s) => s.name),
  };
  try { localStorage.setItem(cacheKey, JSON.stringify(out)); } catch { /* ignore */ }
  return out;
}

// ---------- คาดการณ์จากสภาพปัจจุบัน ----------
// p1Rows/upRows: ประวัติล่าสุด (ม.รทก.), rainRows: ฝนเฉลี่ยลุ่มน้ำรายชั่วโมง (ย้อนหลัง+คาดการณ์)
export function forecast(model, p1Rows, upRows, upBank, rainRows, rainScale = 1) {
  const p1 = toHourly(p1Rows.map((r) => ({ t: r.t, v: p1Gauge(r.v) })));
  const up = toHourly(upRows.map((r) => ({ t: r.t, v: r.v - upBank })));
  const rain = new Map(rainRows.map((r) => [hourKey(r.t), r.r]));
  const k0 = Math.max(...p1.keys());
  // ใช้ชั่วโมงล่าสุดที่ทั้งสองสถานีมีข้อมูล
  let k = k0;
  while (k > k0 - 6 && (up.get(k) === undefined)) k--;
  if (rainScale !== 1) for (const [kk, v] of rain) if (kk > k) rain.set(kk, v * rainScale);
  const h0 = p1.get(k);
  const pts = [{ t: k * H, h: h0, lo: h0, hi: h0 }];
  for (const Hh of CONFIG.horizons) {
    const f = features(k, Hh, p1, up, rain);
    if (!f) continue;
    const d = predictRidge(model.models[Hh], f);
    const e = 1.28 * (model.metrics[Hh].hiRmse ?? model.metrics[Hh].rmse); // ช่วงความเชื่อมั่น ~80%
    const h = Math.max(0, h0 + d);
    pts.push({ t: (k + Hh) * H, h, lo: Math.max(0, h - e), hi: h + e, Hh });
  }
  return { start: k * H, h0, points: pts };
}

export function interpForecast(fc, t) {
  const p = fc.points;
  if (t <= p[0].t) return p[0];
  for (let i = 1; i < p.length; i++) if (t <= p[i].t) {
    const a = p[i - 1], b = p[i], f = (t - a.t) / (b.t - a.t);
    return { t, h: a.h + f * (b.h - a.h), lo: a.lo + f * (b.lo - a.lo), hi: a.hi + f * (b.hi - a.hi) };
  }
  return p[p.length - 1];
}

// GloFAS ปรับแก้ค่าเอนเอียงด้วยค่าที่วัดจริงที่ P.1 แล้วแปลงเป็นระดับน้ำ
export function glofasStage(glofas, p1Rows, rating) {
  const daily = new Map();
  for (const r of p1Rows) if (r.q > 0) {
    const d = new Date(r.t + 7 * H).toISOString().slice(0, 10);
    const a = daily.get(d) || [0, 0]; a[0] += r.q; a[1]++; daily.set(d, a);
  }
  let so = 0, sg = 0;
  for (const g of glofas) {
    const d = new Date(g.t + 7 * H).toISOString().slice(0, 10);
    const o = daily.get(d);
    if (o && g.t < Date.now() && g.q > 0) { so += o[0] / o[1]; sg += g.q; }
  }
  const ratio = sg > 0 ? so / sg : 1;
  return {
    ratio,
    series: glofas.map((g) => ({
      t: g.t, q: g.q * ratio,
      h: stageFromQ(rating, g.q * ratio),
      hmax: g.qmax ? stageFromQ(rating, g.qmax * ratio) : null,
      hmin: g.qmin ? stageFromQ(rating, g.qmin * ratio) : null,
    })),
  };
}

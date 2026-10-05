// กราฟระดับน้ำ/ฝน/อัตราการไหล (Chart.js)
import { p1Gauge } from './config.js';

const H = 3600e3;
const charts = {};
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

const timeTick = (span) => (v) => new Date(v).toLocaleString('th-TH', span > 4 * 864e5
  ? { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short' }
  : { timeZone: 'Asia/Bangkok', day: 'numeric', hour: '2-digit' });

function base(xmin, xmax, yTitle) {
  const grid = css('--border'), text = css('--muted');
  return {
    responsive: true, maintainAspectRatio: false, animation: false, parsing: false, normalized: true,
    interaction: { mode: 'nearest', axis: 'x', intersect: false },
    plugins: {
      legend: { labels: { color: text, boxWidth: 12, font: { family: 'IBM Plex Sans Thai', size: 11 }, filter: (l) => !l.text.startsWith('_') } },
      tooltip: { callbacks: { title: (it) => new Date(it[0].parsed.x).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' }) } },
    },
    scales: {
      x: { type: 'linear', min: xmin, max: xmax, grid: { color: grid }, ticks: { color: text, maxTicksLimit: 7, callback: timeTick(xmax - xmin) } },
      y: { grid: { color: grid }, ticks: { color: text }, title: { display: !!yTitle, text: yTitle, color: text } },
    },
  };
}

function upsert(id, cfg) {
  const el = document.getElementById(id);
  if (!el || !el.offsetParent) { charts[id]?.destroy(); delete charts[id]; return; } // แท็บที่ซ่อนอยู่: วาดใหม่เมื่อเปิด
  charts[id]?.destroy();
  charts[id] = new Chart(el, cfg);
}

const hline = (label, y, x0, x1, color, dash = [4, 4]) => ({
  label, data: [{ x: x0, y }, { x: x1, y }], borderColor: color, borderWidth: 1, borderDash: dash, pointRadius: 0, fill: false,
});

function p1Datasets(S, cfg, x0, x1) {
  const obs = S.p1.filter((r) => r.t >= x0).map((r) => ({ x: r.t, y: p1Gauge(r.v) }));
  const ds = [{ label: 'วัดจริง', data: obs, borderColor: css('--accent'), borderWidth: 2, pointRadius: 0 }];
  if (S.fc) {
    const p = S.fc.points;
    ds.push({ label: '_hi', data: p.map((q) => ({ x: q.t, y: q.hi })), borderWidth: 0, pointRadius: 0, fill: '+1', backgroundColor: 'rgba(232,89,12,.18)' });
    ds.push({ label: '_lo', data: p.map((q) => ({ x: q.t, y: q.lo })), borderWidth: 0, pointRadius: 0, fill: false });
    ds.push({ label: 'คาดการณ์ AI', data: p.map((q) => ({ x: q.t, y: q.h })), borderColor: css('--fc'), borderWidth: 2.5, pointRadius: 2 });
  }
  if (S.glo) {
    const g = S.glo.series.filter((q) => q.h !== null && q.t >= x0 && q.t <= x1);
    ds.push({ label: `GloFAS (×${S.glo.ratio.toFixed(2)})`, data: g.map((q) => ({ x: q.t, y: q.h })), borderColor: '#7b4fc9', borderDash: [6, 4], borderWidth: 1.5, pointRadius: 1.5 });
  }
  for (const t of cfg.thresholds.slice(1)) ds.push(hline(`_${t.th}`, t.level, x0, x1, t.color));
  ds.push(hline('_2567', 5.3, x0, x1, '#8b0000', [2, 3]));
  return ds;
}

export function renderCharts(S, cfg) {
  const now = S.fc?.start ?? Date.now();
  // กราฟย่อในหน้าภาพรวม: 3 วันย้อนหลัง + 3 วันข้างหน้า
  {
    const x0 = now - 3 * 864e5, x1 = now + 3 * 864e5;
    const o = base(x0, x1);
    o.plugins.legend.display = false;
    o.scales.y.suggestedMin = 0; o.scales.y.suggestedMax = 4;
    upsert('miniChart', { type: 'line', data: { datasets: p1Datasets(S, cfg, x0, x1) }, options: o });
  }
  const r = S.range;
  const x0 = now - r * 864e5, x1 = now + (r === 7 ? 3 : 30) * 864e5;
  const o = base(x0, x1, 'ม. (เสาวัด P.1)');
  o.scales.y.suggestedMin = 0; o.scales.y.suggestedMax = 5.5;
  upsert('p1Chart', { type: 'line', data: { datasets: p1Datasets(S, cfg, x0, x1) }, options: o });

  if (S.rain) {
    const rx0 = now - 3 * 864e5, rx1 = now + 7 * 864e5;
    const ro = base(rx0, rx1);
    ro.plugins.legend.display = false;
    upsert('rainChart', { type: 'bar', data: { datasets: [{
      label: 'ฝน', data: S.rain.map((q) => ({ x: q.t, y: q.r * (q.t > now ? S.rainScale : 1) })),
      backgroundColor: S.rain.map((q) => (q.t > now ? 'rgba(232,89,12,.7)' : 'rgba(49,130,189,.85)')),
      barPercentage: 1, categoryPercentage: 1,
    }] }, options: ro });
  }

  const qx0 = now - r * 864e5, qx1 = now + (r === 7 ? 3 : 30) * 864e5;
  const qo = base(qx0, qx1);
  const qds = [{ label: 'วัดจริง P.1', data: S.p1.filter((q) => q.q && q.t >= qx0).map((q) => ({ x: q.t, y: q.q })), borderColor: css('--accent'), pointRadius: 0, borderWidth: 2 }];
  if (S.glo) qds.push({ label: 'GloFAS ปรับแก้', data: S.glo.series.filter((q) => q.t >= qx0 && q.t <= qx1).map((q) => ({ x: q.t, y: q.q })), borderColor: '#7b4fc9', borderDash: [6, 4], pointRadius: 1.5, borderWidth: 1.5 });
  upsert('qChart', { type: 'line', data: { datasets: qds }, options: qo });
}

export function updateChartTheme() { /* วาดใหม่ทั้งหมดผ่าน renderCharts เมื่อสลับธีม */ }

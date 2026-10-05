import { CONFIG, p1Gauge, levelStatus } from './config.js';
import * as api from './api.js';
import { FloodMap, situationColor, situationText } from './map.js';
import { FloodModel } from './flood.js';
import { trainModel, forecast, interpForecast, glofasStage, FEATURE_NAMES } from './model.js';
import { renderCharts, updateChartTheme } from './charts.js';

const $ = (id) => document.getElementById(id);
const H = 3600e3;
const S = { mode: 'forecast', hour: 0, rainScale: 1, range: 7 };
const fmt = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v) ? '–' : Number(v).toFixed(d));
const thTime = (t, withDate = true) => new Date(t).toLocaleString('th-TH', {
  timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', ...(withDate ? { day: 'numeric', month: 'short' } : {}),
});

// ---------- ธีม ----------
try { const th = localStorage.getItem('cmflood:theme'); if (th) document.documentElement.dataset.theme = th; } catch { /* */ }
$('btnTheme').onclick = () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('cmflood:theme', document.documentElement.dataset.theme); } catch { /* */ }
  updateChartTheme(); draw();
};

// ---------- แท็บ ----------
document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('.tab-body > section').forEach((s) => s.classList.toggle('on', s.dataset.pane === b.dataset.tab));
  if (b.dataset.tab === 'chart') draw();
}));

const loader = (txt) => { $('loaderText').textContent = txt; $('loader').classList.toggle('hide', !txt); };

// ---------- แผนที่ ----------
const fmap = new FloodMap('map');
const flood = new FloodModel();
window.__cmflood = { fmap, flood, S }; // สำหรับดีบักในคอนโซล
$('btn2d').onclick = () => { fmap.set3D(false); $('btn2d').classList.add('on'); $('btn3d').classList.remove('on'); };
$('btn3d').onclick = () => { fmap.set3D(true); $('btn3d').classList.add('on'); $('btn2d').classList.remove('on'); };
document.querySelectorAll('[data-layer]').forEach((cb) => (cb.onchange = () => {
  fmap.toggle(cb.dataset.layer, cb.checked);
  if (cb.dataset.layer === 'radar' && cb.checked && !fmap.map.getSource('radar')) loadRadar();
}));

// ---------- โหลดข้อมูล ----------
async function loadAll() {
  loader('กำลังโหลดข้อมูลระดับน้ำ…');
  const today = new Date(Date.now() + 7 * H);
  const d = (off) => new Date(today - off * 864e5).toISOString().slice(0, 10);
  const tasks = {
    stations: api.fetchWaterLevels(),
    p1: api.fetchStationHistory(CONFIG.p1.id, d(30), d(-1)),
    p67: api.fetchStationHistory(CONFIG.p67.id, d(10), d(-1)),
    weather: api.fetchWeather(),
    rain: api.fetchCatchmentRain(3, 7),
    glofas: api.fetchGlofas(),
    rainGrid: api.fetchRainGrid(),
    damsRain: api.fetchDamsAndRain(),
  };
  const keys = Object.keys(tasks);
  const res = await Promise.allSettled(Object.values(tasks));
  res.forEach((r, i) => {
    if (r.status === 'fulfilled') S[keys[i]] = r.value;
    else console.warn('load failed:', keys[i], r.reason);
  });
  const failed = keys.filter((_, i) => res[i].status === 'rejected');
  $('updated').textContent = `อัปเดต ${thTime(Date.now())}` + (failed.length ? ` · โหลดไม่ได้: ${failed.join(', ')}` : '');
  if (!S.stations || !S.p1) throw new Error('โหลดข้อมูลระดับน้ำ (ThaiWater) ไม่สำเร็จ');
  S.p1Now = S.p1[S.p1.length - 1];
  S.p1Station = S.stations.find((s) => s.code === 'P.1');
  S.p67Station = S.stations.find((s) => s.code === 'P.67');
}

async function loadRadar() {
  try {
    const r = await api.fetchRadar();
    const last = [...r.radar.past, ...(r.radar.nowcast || [])].filter((f) => f.time * 1000 <= Date.now()).pop() || r.radar.past.at(-1);
    fmap.setRadar(r.host, last.path);
  } catch (e) { console.warn('radar', e); }
}

async function runModel(force = false) {
  const upBank = S.p67Station?.bank ?? 318.93;
  if (force) try { localStorage.removeItem(`cmflood:${CONFIG.modelVersion}`); } catch { /* */ }
  $('aiStatus').textContent = 'กำลังเตรียมโมเดล…';
  try {
    S.model = await trainModel(upBank, (t) => { loader(t); $('aiStatus').textContent = t; });
    $('aiStatus').textContent = `ฝึกเมื่อ ${thTime(S.model.trainedAt)} · ข้อมูล ${S.model.metrics[24].n.toLocaleString()} ชั่วโมง`;
    $('aiSeasons').textContent = S.model.seasons.map((y) => +y + 543).join(', ');
    recomputeForecast();
    renderMetrics();
  } catch (e) {
    console.error(e);
    $('aiStatus').textContent = 'ฝึกโมเดลไม่สำเร็จ: ' + e.message;
  }
}

function recomputeForecast() {
  if (!S.model || !S.p67 || !S.rain) return;
  S.fc = forecast(S.model, S.p1, S.p67, S.p67Station?.bank ?? 318.93, S.rain, S.rainScale);
  if (S.glofas) S.glo = glofasStage(S.glofas, S.p1, S.model.rating);
}

// ---------- น้ำท่วม ----------
async function initFlood() {
  loader('กำลังโหลดแบบจำลองภูมิประเทศ…');
  await flood.loadDEM((t) => loader(t));
  flood.setAnchors(S.stations);
  fmap.ready.then(() => fmap.setData('river', [flood.riverGeoJSON()]));
  fmap.map.on('click', (e) => {
    if (fmap.map.queryRenderedFeatures(e.point, { layers: ['wl', 'dam', 'rain'].filter((l) => fmap.map.getLayer(l)) }).length) return;
    const { lng, lat } = e.lngLat, dep = flood.depthAt(lng, lat), el = flood.elevationAt(lng, lat);
    if (el === null) return;
    $('probe').hidden = false;
    $('probe').innerHTML = `<b>จุดที่เลือก</b><br>ระดับพื้นดิน (DEM) ≈ ${fmt(el, 1)} ม.<br>` +
      (dep > 0.05 ? `<span style="color:#0b6fbf">น้ำท่วมลึก ≈ <b>${fmt(dep, 2)} ม.</b></span>` : 'ไม่ท่วมในสถานการณ์นี้') +
      `<br><span class="muted small">ที่ระดับ P.1 = ${fmt(flood.last?.gaugeLevel)} ม.</span>`;
  });
}

let floodTimer = null;
function scheduleFlood(level) {
  clearTimeout(floodTimer);
  floodTimer = setTimeout(() => {
    if (!flood.dem || !S.p1Now) return;
    const r = flood.compute(level, p1Gauge(S.p1Now.v));
    const img = flood.render(r.depth);
    fmap.ready.then(() => fmap.setFloodImage(img, flood.coords));
    const txt = r.km2 > 0.01 ? `${fmt(r.km2, 2)} ตร.กม.` : 'ไม่มี';
    $('floodArea').textContent = txt;
    $('floodDepth').textContent = r.km2 > 0.01 ? `ลึกเฉลี่ย ${fmt(r.meanDepth, 2)} ม. · สูงสุด ${fmt(r.maxDepth, 1)} ม.` : 'น้ำอยู่ในลำน้ำ';
    $('tlArea').textContent = `พื้นที่ท่วมจำลอง: ${txt}`;
  }, 120);
}

// ---------- แถบเวลา ----------
function currentLevel() {
  if (S.mode === 'scenario') return { h: +$('scSlider').value, t: Date.now() };
  if (!S.fc) return { h: p1Gauge(S.p1Now.v), t: S.p1Now.t };
  return interpForecast(S.fc, S.fc.start + S.hour * H);
}

function updateTimeline() {
  const c = currentLevel(), st = levelStatus(c.h);
  if (S.mode === 'scenario') {
    $('tlTime').textContent = 'จำลอง';
    $('tlLevel').innerHTML = `P.1 = <b style="color:${st.color}">${fmt(c.h)} ม.</b> (${st.th})`;
  } else {
    $('tlTime').textContent = S.hour === 0 ? 'ตอนนี้' : `+${S.hour} ชม. · ${thTime(c.t)}`;
    $('tlLevel').innerHTML = `P.1 ≈ <b style="color:${st.color}">${fmt(c.h)} ม.</b>` + (S.hour && c.hi ? ` <span class="small">(${fmt(c.lo)}–${fmt(c.hi)})</span>` : '');
  }
  scheduleFlood(c.h);
  updateRainForecastLayer();
}

function updateRainForecastLayer() {
  const g = S.rainGrid;
  if (!g) return;
  const t0 = (S.fc?.start ?? Date.now()) + S.hour * H;
  let i0 = g.times.findIndex((t) => t >= t0 - 1);
  if (i0 < 0) i0 = 0;
  fmap.setData('rainfc', g.points.map((p) => {
    let mm = 0;
    for (let i = i0; i < Math.min(i0 + 3, p.p.length); i++) mm += p.p[i] || 0; // ฝนสะสม 3 ชม.
    return { type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: { mm } };
  }));
}

$('tlSlider').oninput = (e) => { S.hour = +e.target.value; updateTimeline(); };
$('scSlider').oninput = () => updateTimeline();
$('modeForecast').onclick = () => setMode('forecast');
$('modeScenario').onclick = () => setMode('scenario');
function setMode(m) {
  S.mode = m;
  $('modeForecast').classList.toggle('on', m === 'forecast');
  $('modeScenario').classList.toggle('on', m === 'scenario');
  $('tlSlider').hidden = m !== 'forecast';
  $('scSlider').hidden = m !== 'scenario';
  $('btnPlay').hidden = m !== 'forecast';
  $('tlTicks').innerHTML = m === 'forecast'
    ? ['ตอนนี้', '+12', '+24', '+36', '+48', '+60', '+72 ชม.'].map((x) => `<span>${x}</span>`).join('')
    : ['2.0', '3.2 เฝ้าระวัง', '3.7 ตลิ่ง', '4.2 วิกฤต', '5.3 (ปี 67)', '6.5 ม.'].map((x) => `<span>${x}</span>`).join('');
  updateTimeline();
}
let playT = null;
$('btnPlay').onclick = () => {
  if (playT) { clearInterval(playT); playT = null; $('btnPlay').textContent = '▶'; return; }
  $('btnPlay').textContent = '❚❚';
  playT = setInterval(() => {
    S.hour = (S.hour + 3) % 75; $('tlSlider').value = S.hour; updateTimeline();
  }, 700);
};

$('rainScale').oninput = (e) => {
  S.rainScale = +e.target.value; $('rainScaleVal').textContent = '×' + S.rainScale.toFixed(2).replace(/0$/, '');
  recomputeForecast(); draw(); updateTimeline();
};
$('btnRetrain').onclick = async () => { await runModel(true); loader(''); draw(); updateTimeline(); };
$('btnRefresh').onclick = () => boot(true);
$('rangeSeg').querySelectorAll('button').forEach((b) => (b.onclick = () => {
  S.range = +b.dataset.r;
  $('rangeSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  draw();
}));
$('stFilter').oninput = () => renderStations();

// ---------- การแสดงผลแผง ----------
function renderOverview() {
  const g = p1Gauge(S.p1Now.v), st = levelStatus(g);
  $('p1Level').textContent = fmt(g);
  $('p1Badge').textContent = st.th; $('p1Badge').style.background = st.color;
  const h6 = S.p1.find((r) => r.t >= S.p1Now.t - 6 * H);
  const tr = h6 ? g - p1Gauge(h6.v) : 0;
  $('p1Sub').innerHTML = `${fmt(S.p1Now.v)} ม.รทก. · ${tr >= 0 ? '▲' : '▼'} ${fmt(Math.abs(tr))} ม./6 ชม. · ` +
    `${g < CONFIG.p1.bank ? 'ต่ำกว่าตลิ่ง ' + fmt(CONFIG.p1.bank - g) : 'สูงกว่าตลิ่ง ' + fmt(g - CONFIG.p1.bank)} ม. · Q ≈ ${fmt(S.p1Now.q, 0)} ลบ.ม./วิ<br>${thTime(S.p1Now.t)}`;

  // มาตรวัด
  const max = 6.5, pos = (v) => `${Math.min(100, (v / max) * 100)}%`, T = CONFIG.thresholds;
  const segs = T.map((t, i) => `<span style="width:${(((T[i + 1]?.level ?? max) - t.level) / max) * 100}%;background:${t.color}"></span>`).join('');
  const peak = S.fc ? S.fc.points.reduce((a, b) => (b.h > a.h ? b : a)) : null;
  $('p1Gauge').innerHTML = `<div class="bar">${segs}</div><div class="mark" style="left:${pos(g)}" title="ตอนนี้"></div>` +
    (peak ? `<div class="mark fc" style="left:${pos(peak.h)}" title="คาดการณ์สูงสุด"></div>` : '') +
    T.slice(1).map((t) => `<div class="lbl" style="left:${pos(t.level)}">${t.level}</div>`).join('') +
    `<div class="lbl" style="left:${pos(5.3)}">5.3 (67)</div>`;

  if (peak) {
    const ps = levelStatus(peak.h);
    $('fcPeak').innerHTML = `<span style="color:${ps.color}">${fmt(peak.h)} ม.</span>`;
    $('fcPeakTime').textContent = peak.Hh ? `${thTime(peak.t)} (±${fmt(peak.hi - peak.h)})` : 'ระดับน้ำทรงตัว/ลดลง';
  }
  if (S.rain) {
    const now = Date.now();
    const sum = (a, b) => S.rain.filter((r) => r.t > a && r.t <= b).reduce((s, r) => s + r.r, 0);
    $('rainNext').textContent = `${fmt(sum(now, now + 24 * H) * S.rainScale, 1)} มม.`;
    $('rainPast').textContent = `24 ชม.ที่ผ่านมา ${fmt(sum(now - 24 * H, now), 1)} มม.`;
  }
  if (S.weather) {
    const c = S.weather.current;
    $('wxNow').textContent = `${wxIcon(c.weather_code)} ${fmt(c.temperature_2m, 0)}°C`;
    $('wxNowSub').textContent = `${wxText(c.weather_code)} · ความชื้น ${c.relative_humidity_2m}%`;
  }
  // การแจ้งเตือน
  const msgs = [];
  if (peak && peak.h >= 3.7) msgs.push(`⚠️ AI คาดว่าระดับน้ำที่ P.1 อาจสูงถึง <b>${fmt(peak.h)} ม.</b> (เกินตลิ่ง 3.70 ม.) ช่วง ${thTime(peak.t)}`);
  else if (peak && peak.h >= 3.2) msgs.push(`🔶 ระดับน้ำอาจเข้าเกณฑ์เฝ้าระวัง (${fmt(peak.h)} ม.) ภายใน 72 ชม.`);
  const hiDam = (S.damsRain?.dams || []).filter((d) => d.pct >= 90);
  hiDam.forEach((d) => msgs.push(`💧 ${d.name} เก็บกัก ${fmt(d.pct, 1)}% ของความจุ (เฝ้าระวังการระบาย)`));
  const heavy = (S.damsRain?.rain || []).filter((r) => r.rain24 >= 90);
  if (heavy.length) msgs.push(`🌧️ ฝนตกหนักมาก (≥90 มม./24 ชม.) ${heavy.length} สถานี เช่น ${heavy.slice(0, 3).map((r) => `${r.name} ${r.rain24} มม.`).join(', ')}`);
  if (!msgs.length) msgs.push('✅ ยังไม่พบสัญญาณน้ำล้นตลิ่งในตัวเมืองภายใน 72 ชม. ตามข้อมูลและแบบจำลองปัจจุบัน');
  $('alertBox').innerHTML = msgs.join('<br>');
  $('alertBox').classList.toggle('warn', !!(peak && peak.h >= 3.7));
}

function renderStations() {
  const q = $('stFilter').value.trim();
  const rows = S.stations.filter((s) => s.msl !== null && (!q || `${s.code} ${s.name} ${s.river}`.includes(q)))
    .sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0));
  $('stationList').innerHTML = rows.map((s) => {
    const diff = s.bank !== null ? s.bank - s.msl : null;
    return `<div class="st-row" data-lon="${s.lon}" data-lat="${s.lat}">
      <span class="dot" style="background:${situationColor(s.situation)}"></span>
      <div><b>${s.code}</b> ${s.name}<div class="muted small">${s.river || ''} · ${situationText(s.situation)}</div></div>
      <div class="r">${fmt(s.pct, 0)}%<div class="muted small">${diff === null ? '' : diff >= 0 ? `ต่ำกว่าตลิ่ง ${fmt(diff)} ม.` : `<b style="color:#c92a2a">เกินตลิ่ง ${fmt(-diff)} ม.</b>`}</div></div>
    </div>`;
  }).join('');
  $('stationList').querySelectorAll('.st-row').forEach((r) => (r.onclick = () => fmap.map.flyTo({ center: [+r.dataset.lon, +r.dataset.lat], zoom: 13.5 })));
}

function renderDams() {
  const dams = S.damsRain?.dams || [];
  const html = dams.map((d) => {
    const c = d.pct >= 100 ? '#c92a2a' : d.pct >= 80 ? '#e8590c' : d.pct >= 50 ? '#2e9e5b' : '#e0a100';
    return `<div class="card dam-card"><h3>เขื่อน${d.name}</h3>
      <div class="muted small">ข้อมูลวันที่ ${d.date}</div>
      <div style="display:flex;justify-content:space-between;margin-top:6px"><span>ปริมาณน้ำเก็บกัก</span><b>${fmt(d.pct, 1)}%</b></div>
      <div class="pbar"><span style="width:${Math.min(100, d.pct)}%;background:${c}"></span></div>
      <div class="kv">
        <span>ปริมาณน้ำ</span><span>${fmt(d.storage, 2)} / ${d.normal ?? d.max} ล้าน ลบ.ม.</span>
        <span>น้ำใช้การได้</span><span>${fmt(d.usable, 2)} ล้าน ลบ.ม. (${fmt(d.usablePct, 1)}%)</span>
        <span>น้ำไหลเข้า</span><span>${fmt(d.inflow, 2)} ล้าน ลบ.ม./วัน</span>
        <span>น้ำระบาย</span><span>${fmt(d.released, 2)} ล้าน ลบ.ม./วัน</span>
        <span>น้ำล้นทางระบายน้ำล้น</span><span>${fmt(d.spilled, 2)}</span>
        <span>รองรับน้ำได้อีก</span><span>${fmt((d.normal ?? d.max) - d.storage, 2)} ล้าน ลบ.ม.</span>
      </div></div>`;
  }).join('');
  $('damList').innerHTML = html || '<div class="card muted">ไม่มีข้อมูลเขื่อน</div>';
  $('damMini').innerHTML = '<div class="card-title">เขื่อนเหนือเมืองเชียงใหม่</div>' + (dams.map((d) =>
    `<div style="margin:6px 0"><div style="display:flex;justify-content:space-between" class="small"><span>${d.name}</span><b>${fmt(d.pct, 1)}%</b></div>
     <div class="pbar"><span style="width:${Math.min(100, d.pct)}%;background:${d.pct >= 90 ? '#e8590c' : '#3182bd'}"></span></div>
     <div class="muted small">เข้า ${fmt(d.inflow, 2)} · ระบาย ${fmt(d.released, 2)} ล้าน ลบ.ม./วัน</div></div>`).join('') || '<span class="muted">–</span>');
}

const WX = { 0: ['☀️', 'ท้องฟ้าแจ่มใส'], 1: ['🌤️', 'มีเมฆบางส่วน'], 2: ['⛅', 'มีเมฆบางส่วน'], 3: ['☁️', 'มีเมฆมาก'], 45: ['🌫️', 'หมอก'], 48: ['🌫️', 'หมอก'],
  51: ['🌦️', 'ฝนปรอย'], 53: ['🌦️', 'ฝนปรอย'], 55: ['🌦️', 'ฝนปรอย'], 61: ['🌧️', 'ฝนเล็กน้อย'], 63: ['🌧️', 'ฝนปานกลาง'], 65: ['🌧️', 'ฝนหนัก'],
  80: ['🌦️', 'ฝนซู่'], 81: ['🌧️', 'ฝนซู่ปานกลาง'], 82: ['⛈️', 'ฝนซู่หนัก'], 95: ['⛈️', 'พายุฝนฟ้าคะนอง'], 96: ['⛈️', 'พายุฝนฟ้าคะนอง'], 99: ['⛈️', 'พายุฝนฟ้าคะนองรุนแรง'] };
const wxIcon = (c) => (WX[c] || ['🌡️'])[0];
const wxText = (c) => (WX[c] || ['', '–'])[1];

function renderWeather() {
  const w = S.weather; if (!w) return;
  const c = w.current;
  $('wxCard').innerHTML = `<div class="card-title">สภาพอากาศตอนนี้ · ตัวเมืองเชียงใหม่</div>
    <div class="wx-now"><div class="ico">${wxIcon(c.weather_code)}</div>
    <div><div class="big" style="font-size:32px">${fmt(c.temperature_2m, 1)}°C</div><div>${wxText(c.weather_code)}</div></div></div>
    <div class="kv"><span>ความชื้นสัมพัทธ์</span><span>${c.relative_humidity_2m}%</span>
    <span>ฝนชั่วโมงนี้</span><span>${fmt(c.precipitation, 1)} มม.</span>
    <span>ลม</span><span>${fmt(c.wind_speed_10m, 0)} กม./ชม.</span>
    <span>เมฆปกคลุม</span><span>${c.cloud_cover}%</span></div>`;
  const D = w.daily, today = D.time.indexOf(new Date(Date.now() + 7 * H).toISOString().slice(0, 10));
  $('wxDaily').innerHTML = D.time.slice(today, today + 7).map((t, k) => {
    const i = today + k;
    return `<div class="d"><div class="small">${new Date(t + 'T12:00:00+07:00').toLocaleDateString('th-TH', { weekday: 'short' })}</div>
      <div class="ico">${wxIcon(D.weather_code[i])}</div>
      <div class="small"><b>${fmt(D.temperature_2m_max[i], 0)}°</b>/${fmt(D.temperature_2m_min[i], 0)}°</div>
      <div class="small" style="color:#3182bd">${fmt(D.precipitation_sum[i], 0)} มม.</div>
      <div class="muted small">${D.precipitation_probability_max[i] ?? '–'}%</div></div>`;
  }).join('');
}

function renderMetrics() {
  const M = S.model.metrics;
  $('aiMetrics').innerHTML = '<tr><th>ล่วงหน้า</th><th>RMSE AI</th><th>คงที่</th><th>น้ำสูง</th></tr>' +
    CONFIG.horizons.map((h) => `<tr><td>${h} ชม.</td><td><b>${fmt(M[h].rmse, 3)}</b></td><td>${fmt(M[h].persistence, 3)}</td><td>${M[h].hiRmse === null ? '–' : fmt(M[h].hiRmse, 3)}</td></tr>`).join('');
  const w = S.model.models[24].w.map((v, i) => [FEATURE_NAMES[i], v]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 5);
  $('aiMetrics').insertAdjacentHTML('afterend', `<p class="small" id="aiFeat"><b>ปัจจัยที่มีผลมากที่สุด (24 ชม.):</b> ${w.map((x) => x[0]).join(' · ')}</p>`);
  document.querySelectorAll('#aiFeat').forEach((el, i, all) => i < all.length - 1 && el.remove());
}

function renderMapData() {
  fmap.setData('wl', S.stations.filter((s) => s.msl !== null).map((s) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
    properties: { ...s, color: situationColor(s.situation), key: CONFIG.riverAnchors.includes(s.code),
      label: s.bank !== null ? `${s.bank - s.msl >= 0 ? '-' : '+'}${fmt(Math.abs(s.bank - s.msl))} m` : '' },
  })));
  fmap.setData('dam', (S.damsRain?.dams || []).map((d) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [d.lon, d.lat] }, properties: { ...d, pctTxt: `${fmt(d.pct, 0)}%` },
  })));
  fmap.setData('rain', (S.damsRain?.rain || []).filter((r) => r.rain24 !== null).map((r) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [r.lon, r.lat] }, properties: r,
  })));
}

function bindPopups() {
  const m = fmap.map;
  m.on('click', 'wl', (e) => {
    const s = e.features[0].properties;
    const diff = s.bank === 'null' || s.bank === null ? null : s.bank - s.msl;
    fmap.popup(e.lngLat, `<div class="pop"><h4>${s.code} ${s.name}</h4>${s.river || ''}<br>
      ระดับน้ำ <b>${fmt(s.msl)}</b> ม.รทก. ${s.code === 'P.1' ? `(<b>${fmt(p1Gauge(s.msl))}</b> ม. ที่เสาวัด)` : ''}<br>
      ${diff === null ? '' : diff >= 0 ? `ต่ำกว่าตลิ่ง ${fmt(diff)} ม.` : `<b style="color:#c92a2a">สูงกว่าตลิ่ง ${fmt(-diff)} ม.</b>`}<br>
      ความจุลำน้ำ ${fmt(s.pct, 0)}% · ${situationText(s.situation)}<br><span class="muted small">${s.time} · ${s.agency || ''}</span></div>`);
  });
  m.on('click', 'dam', (e) => {
    const d = e.features[0].properties;
    fmap.popup(e.lngLat, `<div class="pop"><h4>เขื่อน${d.name}</h4>ปริมาณน้ำ ${fmt(d.storage)} ล้าน ลบ.ม. (<b>${fmt(d.pct, 1)}%</b>)<br>
      ไหลเข้า ${fmt(d.inflow)} · ระบาย ${fmt(d.released)} ล้าน ลบ.ม./วัน<br><span class="muted small">${d.date}</span></div>`);
  });
  m.on('click', 'rain', (e) => {
    const r = e.features[0].properties;
    fmap.popup(e.lngLat, `<div class="pop"><h4>${r.name}</h4>ฝน 24 ชม. <b>${fmt(r.rain24, 1)}</b> มม.<br>ฝน 1 ชม. ${fmt(r.rain1, 1)} มม.<br><span class="muted small">อ.${r.amphoe || ''} · ${r.time}</span></div>`);
  });
}

function draw() {
  if (!S.p1Now) return;
  renderOverview();
  renderCharts(S, CONFIG);
}

// ---------- เริ่มทำงาน ----------
let bound = false;
async function boot(refresh = false) {
  try {
    await loadAll();
    renderStations(); renderDams(); renderWeather();
    draw();
    // ส่วนที่ต้องรอแผนที่พร้อม ทำคู่ขนานกับการโหลด DEM/โมเดล
    fmap.ready.then(() => {
      renderMapData();
      if (!bound) { bindPopups(); bound = true; }
    });
    if (!refresh) await initFlood(); else flood.setAnchors(S.stations);
    setMode(S.mode);
    loader('กำลังเตรียมโมเดล AI…');
    await runModel();
    draw(); updateTimeline();
    loader('');
  } catch (e) {
    console.error(e);
    loader('⚠️ ' + e.message);
  }
}
boot();
setInterval(() => boot(true), 15 * 60e3); // อัปเดตทุก 15 นาที

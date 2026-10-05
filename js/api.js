// ตัวดึงข้อมูลจากแหล่งอ้างอิงภายนอก (ThaiWater/สสน., Open-Meteo, GloFAS, RainViewer)
import { CONFIG } from './config.js';

async function getJSON(url, timeoutMs = 60000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

const isCM = (x) => x?.geocode?.province_code === '50';
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

// ระดับน้ำทุกสถานีใน จ.เชียงใหม่ (ล่าสุด)
export async function fetchWaterLevels() {
  const j = await getJSON(`${CONFIG.thaiwater}/waterlevel_load`);
  return j.waterlevel_data.data.filter(isCM).map((x) => ({
    id: x.station.id,
    code: x.station.tele_station_oldcode,
    name: x.station.tele_station_name?.th || x.station.tele_station_name?.en,
    river: x.river_name,
    lat: x.station.tele_station_lat,
    lon: x.station.tele_station_long,
    msl: num(x.waterlevel_msl),
    prev: num(x.waterlevel_msl_previous),
    bank: num(x.station.min_bank),
    ground: num(x.station.ground_level),
    pct: num(x.storage_percent),
    situation: x.situation_level,
    discharge: num(x.discharge),
    time: x.waterlevel_datetime,
    agency: x.agency?.agency_shortname?.th,
  })).filter((s) => s.lat && s.lon);
}

// เขื่อน + ฝน 24 ชม. (endpoint รวม)
export async function fetchDamsAndRain() {
  const j = await getJSON(`${CONFIG.thaiwater}/thailand_main`, 90000);
  const dams = j.dam.data.data.filter(isCM).map((d) => ({
    name: d.dam.dam_name.th,
    lat: d.dam.dam_lat, lon: d.dam.dam_long,
    date: d.dam_date,
    storage: d.dam_storage, pct: d.dam_storage_percent,
    max: d.dam.max_storage, normal: d.dam.normal_storage,
    inflow: d.dam_inflow, released: d.dam_released, spilled: d.dam_spilled,
    usable: d.dam_uses_water, usablePct: d.dam_uses_water_percent,
  }));
  const rain = j.rain.data.data.filter(isCM).map((r) => ({
    name: r.station.tele_station_name?.th,
    lat: r.station.tele_station_lat, lon: r.station.tele_station_long,
    rain24: num(r.rain_24h), rain1: num(r.rain_1h),
    time: r.rainfall_datetime,
    amphoe: r.geocode?.amphoe_name?.th,
  })).filter((r) => r.lat && r.lon);
  return { dams, rain };
}

// กราฟระดับน้ำรายชั่วโมงของสถานี (ม.รทก. + อัตราการไหล)
export async function fetchStationHistory(stationId, start, end) {
  const url = `${CONFIG.thaiwater}/waterlevel_graph?station_type=tele_waterlevel&station_id=${stationId}&start_date=${start}&end_date=${end}`;
  const j = await getJSON(url, 90000);
  if (j.result !== 'OK') throw new Error(j.data);
  return j.data.graph_data
    .filter((g) => g.value !== null)
    .map((g) => ({ t: parseLocal(g.datetime), v: g.value, q: g.discharge }));
}

// "2026-10-06 01:00" (เวลาไทย) → epoch ms
export function parseLocal(s) {
  const [d, hm] = s.split(/[ T]/);
  const [Y, M, D] = d.split('-').map(Number);
  const [h, m] = (hm || '00:00').split(':').map(Number);
  return Date.UTC(Y, M - 1, D, h - 7, m);
}

// สภาพอากาศเมืองเชียงใหม่ (ปัจจุบัน + รายชั่วโมง + รายวัน)
export async function fetchWeather() {
  const [lon, lat] = CONFIG.center;
  const p = new URLSearchParams({
    latitude: lat, longitude: lon, timezone: 'Asia/Bangkok', past_days: 3, forecast_days: 7,
    current: 'temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m,cloud_cover',
    hourly: 'temperature_2m,precipitation,precipitation_probability,weather_code',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max',
  });
  return getJSON(`${CONFIG.openMeteo}?${p}`);
}

// ฝนรายชั่วโมงเฉลี่ยพื้นที่รับน้ำ (ย้อนหลัง 3 วัน + คาดการณ์ 7 วัน) — จากแบบจำลองพยากรณ์อากาศ (Open-Meteo best match)
export async function fetchCatchmentRain(pastDays = 3, forecastDays = 7) {
  const pts = CONFIG.catchment;
  const p = new URLSearchParams({
    latitude: pts.map((x) => x.lat).join(','), longitude: pts.map((x) => x.lon).join(','),
    hourly: 'precipitation', timezone: 'GMT', past_days: pastDays, forecast_days: forecastDays,
  });
  return averageHourly(await getJSON(`${CONFIG.openMeteo}?${p}`));
}

export async function fetchCatchmentRainArchive(start, end) {
  const pts = CONFIG.catchment;
  const p = new URLSearchParams({
    latitude: pts.map((x) => x.lat).join(','), longitude: pts.map((x) => x.lon).join(','),
    hourly: 'precipitation', timezone: 'GMT', start_date: start, end_date: end,
  });
  return averageHourly(await getJSON(`${CONFIG.openMeteoArchive}?${p}`, 90000));
}

function averageHourly(j) {
  const arr = Array.isArray(j) ? j : [j];
  const times = arr[0].hourly.time;
  return times.map((t, i) => {
    let s = 0, n = 0;
    for (const a of arr) { const v = a.hourly.precipitation[i]; if (v !== null) { s += v; n++; } }
    return { t: Date.parse(t + 'Z'), r: n ? s / n : 0 };
  });
}

// ตารางจุดฝนคาดการณ์ (ใช้แสดงบนแผนที่ตามแถบเวลา)
export async function fetchRainGrid() {
  const lats = [], lons = [];
  for (let la = 18.55; la <= 19.45; la += 0.09) for (let lo = 98.70; lo <= 99.30; lo += 0.09) { lats.push(la.toFixed(3)); lons.push(lo.toFixed(3)); }
  const p = new URLSearchParams({
    latitude: lats.join(','), longitude: lons.join(','), hourly: 'precipitation',
    timezone: 'GMT', past_days: 0, forecast_days: 4,
  });
  const j = await getJSON(`${CONFIG.openMeteo}?${p}`);
  const arr = Array.isArray(j) ? j : [j];
  return {
    times: arr[0].hourly.time.map((t) => Date.parse(t + 'Z')),
    points: arr.map((a, i) => ({ lat: +lats[i], lon: +lons[i], p: a.hourly.precipitation })),
  };
}

// GloFAS (Copernicus) อัตราการไหลรายวันของแม่น้ำปิง ย้อนหลัง 30 วัน + คาดการณ์ 30 วัน
export async function fetchGlofas() {
  const { lat, lon } = CONFIG.glofasCell;
  const p = new URLSearchParams({
    latitude: lat, longitude: lon, past_days: 30, forecast_days: 30,
    daily: 'river_discharge,river_discharge_max,river_discharge_min',
  });
  const j = await getJSON(`${CONFIG.glofas}?${p}`);
  return j.daily.time.map((t, i) => ({
    t: Date.parse(t + 'T05:00:00Z'), // ~เที่ยงวันเวลาไทย
    q: j.daily.river_discharge[i], qmax: j.daily.river_discharge_max?.[i], qmin: j.daily.river_discharge_min?.[i],
  }));
}

export async function fetchRadar() {
  return getJSON(CONFIG.rainviewer);
}

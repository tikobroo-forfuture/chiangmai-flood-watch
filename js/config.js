// ค่าตั้งต้นของระบบ — ปรับเกณฑ์/สถานีได้ที่ไฟล์นี้ที่เดียว
export const CONFIG = {
  center: [98.99, 18.79],
  zoom: 12.3,

  // บนเซิร์ฟเวอร์จริงเรียกผ่าน proxy ที่มีแคช (api/tw.js) — ตอนพัฒนาบน localhost เรียกตรง
  thaiwater: /^(localhost|127.0.0.1)$/.test(location.hostname) ? 'https://api-v3.thaiwater.net/api/v1/thaiwater30/public' : '/tw',
  openMeteo: 'https://api.open-meteo.com/v1/forecast',
  openMeteoArchive: 'https://archive-api.open-meteo.com/v1/archive',
  glofas: 'https://flood-api.open-meteo.com/v1/flood',
  rainviewer: 'https://api.rainviewer.com/public/weather-maps.json',
  basemap: 'https://tiles.openfreemap.org/styles/liberty',
  terrainTiles: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',

  // สถานีหลัก P.1 สะพานนวรัฐ: ระดับตลิ่ง 304.20 ม.รทก. = 3.70 ม. (ระดับเสาวัด) → ศูนย์เสาวัด ≈ 300.50 ม.รทก.
  // ตรวจยืนยัน: ปี 2567 สูงสุด 305.80 ม.รทก. = 5.30 ม. ตรงกับรายงานทางการ
  p1: { id: 3226, code: 'P.1', datum: 300.5, bank: 3.70 },
  p67: { id: 3247, code: 'P.67' },
  // เกณฑ์เตือนภัยที่ P.1 (ระดับเสาวัด, เมตร) — ควรตรวจสอบกับ สชป.1 / ศูนย์ป้องกันวิกฤติน้ำ จ.เชียงใหม่
  thresholds: [
    { level: 0,    key: 'normal',   th: 'ปกติ',            color: '#2e9e5b' },
    { level: 3.20, key: 'watch',    th: 'เฝ้าระวัง',        color: '#e0a100' },
    { level: 3.70, key: 'warning',  th: 'ล้นตลิ่ง / เตือนภัย', color: '#e8590c' },
    { level: 4.20, key: 'critical', th: 'วิกฤต',            color: '#c92a2a' },
  ],
  historicPeaks: [
    { label: 'สูงสุดปี 2567', level: 5.30 },
    { label: 'สูงสุดปี 2554', level: 4.94 },
  ],

  // สถานีที่ใช้เป็นจุดอ้างอิงระดับผิวน้ำแม่น้ำปิง (เรียงจากต้นน้ำ → ท้ายน้ำ)
  riverAnchors: ['P.67', 'P.103', 'P.1', 'TB0006'],

  // จุดตัวแทนพื้นที่รับน้ำปิงตอนบน (เหนือ P.1) สำหรับฝนเฉลี่ยลุ่มน้ำ
  catchment: [
    { name: 'เชียงดาว', lat: 19.37, lon: 98.96 },
    { name: 'แม่แตง', lat: 19.12, lon: 98.94 },
    { name: 'เขื่อนแม่งัด', lat: 19.16, lon: 99.04 },
    { name: 'พร้าว', lat: 19.36, lon: 99.20 },
    { name: 'แม่ริม', lat: 18.93, lon: 98.90 },
    { name: 'สะเมิง', lat: 18.85, lon: 98.73 },
    { name: 'ดอยสุเทพ', lat: 18.80, lon: 98.92 },
    { name: 'สันทราย', lat: 18.90, lon: 99.05 },
  ],

  // จุด GloFAS ที่ตรงกับลำน้ำปิงสายหลัก (ตรวจสอบแล้วว่าให้ค่าอัตราการไหลระดับแม่น้ำปิง)
  glofasCell: { lat: 18.825, lon: 98.975 },

  // ขอบเขตการคำนวณพื้นที่น้ำท่วม (DEM)
  floodBBox: { west: 98.92, south: 18.68, east: 99.09, north: 18.95 },
  floodZoom: 13,
  floodMaxDistKm: 4,

  // ช่วงข้อมูลฝึกโมเดล AI (ฤดูฝนที่มีน้ำหลาก)
  trainingSeasons: [
    ['2024-07-15', '2024-11-15'],
    ['2025-07-15', '2025-11-15'],
  ],
  horizons: [3, 6, 12, 18, 24, 36, 48, 60, 72],
  modelVersion: 'ridge-v1',
};

export function p1Gauge(msl) { return msl - CONFIG.p1.datum; }
export function levelStatus(g) {
  let s = CONFIG.thresholds[0];
  for (const t of CONFIG.thresholds) if (g >= t.level) s = t;
  return s;
}

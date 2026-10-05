// Proxy + แคชสำหรับ ThaiWater API (Vercel Serverless Function)
// - ผู้ใช้ทุกคนใช้แคชร่วมกันที่ edge → ลดการเรียก ThaiWater (ป้องกัน 429 rate limit)
// - กรองเหลือเฉพาะ จ.เชียงใหม่ → ลดขนาดข้อมูลจาก ~10 MB เหลือไม่กี่ร้อย KB
const BASE = 'https://api-v3.thaiwater.net/api/v1/thaiwater30/public/';
const ALLOWED = new Set(['waterlevel_load', 'thailand_main', 'waterlevel_graph']);
const isCM = (x) => x?.geocode?.province_code === '50';

module.exports = async (req, res) => {
  const { path, ...query } = req.query;
  if (!ALLOWED.has(path)) return res.status(400).json({ error: 'path not allowed' });
  const qs = new URLSearchParams(query).toString();
  try {
    const r = await fetch(BASE + path + (qs ? `?${qs}` : ''), { headers: { 'User-Agent': 'chiangmai-flood-watch' } });
    if (!r.ok) return res.status(r.status).json({ error: `upstream ${r.status}` });
    let j = await r.json();
    if (path === 'waterlevel_load') {
      j = { waterlevel_data: { data: j.waterlevel_data.data.filter(isCM) } };
    } else if (path === 'thailand_main') {
      j = {
        dam: { data: { data: j.dam.data.data.filter(isCM) } },
        rain: { data: { data: j.rain.data.data.filter(isCM) } },
      };
    }
    // ข้อมูลสด: แคช 10 นาที / ข้อมูลย้อนหลังช่วงฤดูที่จบไปแล้ว: แคช 1 วัน
    const historic = path === 'waterlevel_graph' && query.end_date && query.end_date < new Date().toISOString().slice(0, 10);
    res.setHeader('Cache-Control', historic
      ? 'public, s-maxage=86400, stale-while-revalidate=604800'
      : 'public, s-maxage=600, stale-while-revalidate=3600');
    res.status(200).json(j);
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
};

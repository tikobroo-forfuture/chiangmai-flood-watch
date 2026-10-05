// แผนที่ 2D / 3D (MapLibre GL + ภูมิประเทศ Terrarium + อาคาร 3D จาก OpenStreetMap)
import { CONFIG } from './config.js';

const SITUATION = { 1: ['#db802b', 'น้อยวิกฤต'], 2: ['#ffc000', 'น้อย'], 3: ['#00b050', 'ปกติ'], 4: ['#003cfa', 'มาก'], 5: ['#ff0000', 'ล้นตลิ่ง'] };
export const situationColor = (s) => (SITUATION[s] || ['#999', '–'])[0];
export const situationText = (s) => (SITUATION[s] || ['#999', 'ไม่มีข้อมูล'])[1];

export class FloodMap {
  constructor(el) {
    this.map = new maplibregl.Map({
      container: el, style: CONFIG.basemap, center: CONFIG.center, zoom: CONFIG.zoom,
      maxPitch: 75, attributionControl: { compact: true },
    });
    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    this.map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
    this.is3D = false;
    this.ready = new Promise((res) => this.map.on('load', () => { this._init(); res(); }));
  }

  _init() {
    const m = this.map;
    m.addSource('dem', {
      type: 'raster-dem', tiles: [CONFIG.terrainTiles], encoding: 'terrarium', tileSize: 256, maxzoom: 14,
      attribution: 'Terrain: <a href="https://registry.opendata.aws/terrain-tiles/">Mapzen/AWS</a>',
    });
    const firstSymbol = m.getStyle().layers.find((l) => l.type === 'symbol')?.id;
    m.addLayer({ id: 'hillshade', type: 'hillshade', source: 'dem', layout: { visibility: 'none' },
      paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#3b4a5a' } }, firstSymbol);
    // ชั้นแสดงพื้นที่น้ำท่วม — อยู่ใต้อาคาร 3D เพื่อให้อาคารโผล่พ้นน้ำ
    this.bldgLayer = m.getStyle().layers.find((l) => l.type === 'fill-extrusion')?.id;
    this.beforeFlood = this.bldgLayer || firstSymbol;
    if (this.bldgLayer) m.setLayoutProperty(this.bldgLayer, 'visibility', 'none');

    const empty = { type: 'FeatureCollection', features: [] };
    for (const id of ['wl', 'dam', 'rain', 'rainfc', 'river']) m.addSource(id, { type: 'geojson', data: empty });

    m.addLayer({ id: 'rainfc', type: 'circle', source: 'rainfc', layout: { visibility: 'none' }, paint: {
      'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 8, 18, 12, 260],
      'circle-blur': 1, 'circle-opacity': 0.55,
      'circle-color': ['interpolate', ['linear'], ['get', 'mm'], 0, 'rgba(0,0,0,0)', 1, '#a6dba0', 5, '#5aae61', 10, '#fee08b', 20, '#f46d43', 40, '#a50026'],
    } });
    m.addLayer({ id: 'river', type: 'line', source: 'river', paint: { 'line-color': '#1c7ed6', 'line-width': 2, 'line-opacity': 0.55, 'line-dasharray': [2, 2] } });
    m.addLayer({ id: 'rain', type: 'circle', source: 'rain', layout: { visibility: 'none' }, paint: {
      'circle-radius': ['interpolate', ['linear'], ['get', 'rain24'], 0, 3, 35, 7, 90, 12, 150, 16],
      'circle-color': ['interpolate', ['linear'], ['get', 'rain24'], 0, '#cfe3f3', 10, '#74add1', 35, '#4575b4', 90, '#a50f15', 150, '#67000d'],
      'circle-stroke-color': '#fff', 'circle-stroke-width': 1, 'circle-opacity': 0.9,
    } });
    m.addLayer({ id: 'wl', type: 'circle', source: 'wl', paint: {
      'circle-radius': ['case', ['get', 'key'], 9, 6],
      'circle-color': ['get', 'color'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2,
    } });
    m.addLayer({ id: 'wl-label', type: 'symbol', source: 'wl', minzoom: 10, layout: {
      'text-field': ['concat', ['get', 'code'], '\n', ['get', 'label']], 'text-size': 11,
      'text-offset': [0, 1.3], 'text-anchor': 'top', 'text-font': ['Noto Sans Regular'],
    }, paint: { 'text-halo-color': '#fff', 'text-halo-width': 1.5, 'text-color': '#123' } });
    m.addLayer({ id: 'dam', type: 'circle', source: 'dam', paint: {
      'circle-radius': 11, 'circle-color': '#6a3d9a', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2,
    } });
    m.addLayer({ id: 'dam-label', type: 'symbol', source: 'dam', layout: {
      'text-field': ['concat', ['get', 'name'], ' ', ['get', 'pctTxt']], 'text-size': 12, 'text-offset': [0, 1.4],
      'text-anchor': 'top', 'text-font': ['Noto Sans Regular'],
    }, paint: { 'text-halo-color': '#fff', 'text-halo-width': 1.5, 'text-color': '#4a1f7a' } });

    for (const id of ['wl', 'dam', 'rain']) {
      m.on('mouseenter', id, () => (m.getCanvas().style.cursor = 'pointer'));
      m.on('mouseleave', id, () => (m.getCanvas().style.cursor = ''));
    }
  }

  setData(id, features) {
    this.map.getSource(id)?.setData({ type: 'FeatureCollection', features });
  }

  setFloodImage(url, coords) {
    const m = this.map, src = m.getSource('flood');
    if (src) { src.updateImage({ url, coordinates: coords }); return; }
    m.addSource('flood', { type: 'image', url, coordinates: coords });
    m.addLayer({ id: 'flood', type: 'raster', source: 'flood', paint: { 'raster-opacity': 0.78, 'raster-fade-duration': 0, 'raster-resampling': 'linear' } }, this.beforeFlood);
  }

  setRadar(host, path) {
    const m = this.map, tiles = [`${host}${path}/256/{z}/{x}/{y}/2/1_1.png`];
    if (m.getLayer('radar')) m.removeLayer('radar');
    if (m.getSource('radar')) m.removeSource('radar');
    m.addSource('radar', { type: 'raster', tiles, tileSize: 256, maxzoom: 7, attribution: 'Radar: <a href="https://www.rainviewer.com">RainViewer</a>' });
    m.addLayer({ id: 'radar', type: 'raster', source: 'radar', layout: { visibility: this._radarOn ? 'visible' : 'none' }, paint: { 'raster-opacity': 0.6 } }, this.beforeFlood);
  }

  toggle(layer, on) {
    const m = this.map, vis = on ? 'visible' : 'none';
    const ids = { wl: ['wl', 'wl-label'], dam: ['dam', 'dam-label'], rain: ['rain'], rainfc: ['rainfc'], flood: ['flood'], radar: ['radar'], bldg: [this.bldgLayer] }[layer] || [];
    if (layer === 'radar') this._radarOn = on;
    if (layer === 'bldg') this._bldgOn = on;
    for (const id of ids) if (id && m.getLayer(id)) m.setLayoutProperty(id, 'visibility', layer === 'bldg' && !this.is3D ? 'none' : vis);
  }

  set3D(on) {
    const m = this.map;
    this.is3D = on;
    if (on) {
      m.setTerrain({ source: 'dem', exaggeration: 1.6 });
      m.setLayoutProperty('hillshade', 'visibility', 'visible');
      if (this.bldgLayer && this._bldgOn !== false) m.setLayoutProperty(this.bldgLayer, 'visibility', 'visible');
      m.easeTo({ pitch: 62, bearing: -20, zoom: Math.max(m.getZoom(), 13.2), duration: 1200 });
    } else {
      m.setTerrain(null);
      m.setLayoutProperty('hillshade', 'visibility', 'none');
      if (this.bldgLayer) m.setLayoutProperty(this.bldgLayer, 'visibility', 'none');
      m.easeTo({ pitch: 0, bearing: 0, duration: 900 });
    }
  }

  popup(lngLat, html) {
    new maplibregl.Popup({ maxWidth: '300px' }).setLngLat(lngLat).setHTML(html).addTo(this.map);
  }
}

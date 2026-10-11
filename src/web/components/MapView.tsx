import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { type GeoJSONSource, type Map as MlMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { TripOption } from '../../shared/api.ts';
import { decodePolyline } from '../../shared/polyline.ts';
import { clock, tokyoInstant, tokyoParts } from '../format.ts';
import { useT, type Lang } from '../i18n.ts';
import { Icon } from './Icon.tsx';

const STYLE = { light: 'https://tiles.openfreemap.org/styles/positron', dark: 'https://tiles.openfreemap.org/styles/dark' };
const TOKYO: [number, number] = [139.74, 35.69];
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
const SHADE_MIN_ZOOM = 14.5;

interface Props {
  option: TripOption | null;
  /** Date of the sun shown: the replay day, or the trip's own date. */
  sunDate: string | null;
  theme: 'light' | 'dark';
  focus?: { lat: number; lon: number; n: number } | null;
}

/** Walks coloured by sun along each stretch, rides in their line colour. */
function routeFeatures(o: TripOption): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const l of o.legs) {
    if (l.kind === 'walk') {
      for (const s of l.segments) {
        const kind = s.shelter ? 'covered' : s.sun === null ? 'unknown' : s.sun < 0.25 ? 'shade' : s.sun < 0.65 ? 'partly' : 'sun';
        features.push({ type: 'Feature', properties: { kind }, geometry: { type: 'LineString', coordinates: s.line } });
      }
      if (l.entrance) {
        features.push({ type: 'Feature', properties: { kind: 'entrance', label: l.entrance.exit ?? '' }, geometry: { type: 'Point', coordinates: [l.entrance.lon, l.entrance.lat] } });
      }
      for (const r of l.rest) {
        features.push({ type: 'Feature', properties: { kind: `rest-${r.kind}` }, geometry: { type: 'Point', coordinates: [r.lon, r.lat] } });
      }
    } else {
      const coords = l.line5 ? decodePolyline(l.line5).map(([la, lo]) => [lo, la]) : [[l.from.lon, l.from.lat], [l.to.lon, l.to.lat]];
      features.push({ type: 'Feature', properties: { kind: 'ride', color: l.line.color }, geometry: { type: 'LineString', coordinates: coords } });
      for (const s of [l.from, l.to]) features.push({ type: 'Feature', properties: { kind: 'stop', color: l.line.color }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } });
    }
  }
  return { type: 'FeatureCollection', features };
}

function bounds(fc: GeoJSON.FeatureCollection): maplibregl.LngLatBounds | null {
  const b = new maplibregl.LngLatBounds();
  let any = false;
  for (const f of fc.features) {
    const g = f.geometry;
    const pts = g.type === 'LineString' ? g.coordinates : g.type === 'Point' ? [g.coordinates] : [];
    for (const p of pts) {
      b.extend(p as [number, number]);
      any = true;
    }
  }
  return any ? b : null;
}

function localiseLabels(map: MlMap, lang: Lang) {
  const field = ['coalesce', ['get', lang === 'ja' ? 'name:ja' : 'name:en'], ['get', 'name']];
  for (const layer of map.getStyle().layers ?? []) {
    if (layer.type !== 'symbol') continue;
    const tf = map.getLayoutProperty(layer.id, 'text-field');
    if (tf && JSON.stringify(tf).includes('name')) map.setLayoutProperty(layer.id, 'text-field', field);
  }
}

export default function MapView({ option, sunDate, theme, focus }: Props) {
  const { t, lang } = useT();
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const [ready, setReady] = useState(0);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(12);
  const [showShade, setShowShade] = useState(true);
  // Minute of day for the shade layer; starts at the trip's departure.
  const startMinute = option ? tokyoParts(Date.parse(option.leave)).minute : 12 * 60;
  const [minute, setMinute] = useState(startMinute);
  useEffect(() => setMinute(startMinute), [startMinute]);

  const shadeDate = sunDate ?? (option ? tokyoParts(Date.parse(option.leave)).date : tokyoParts(Date.now()).date);
  const sunMs = Date.parse(tokyoInstant(shadeDate, minute));
  const fc = useMemo(() => (option ? routeFeatures(option) : EMPTY), [option]);

  useEffect(() => {
    if (!box.current) return;
    let m: MlMap;
    try {
      m = new maplibregl.Map({ container: box.current, style: STYLE[theme], center: TOKYO, zoom: 11, attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false });
    } catch {
      setFailed(true);
      return;
    }
    m.touchZoomRotate.disableRotation();
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    m.on('style.load', () => setReady((n) => n + 1));
    m.on('zoomend', () => setZoom(m.getZoom()));
    map.current = m;
    const ro = new ResizeObserver(() => m.resize());
    ro.observe(box.current);
    return () => {
      ro.disconnect();
      m.remove();
      map.current = null;
    };
  }, []);

  const appliedTheme = useRef(theme);
  useEffect(() => {
    if (appliedTheme.current === theme) return;
    appliedTheme.current = theme;
    map.current?.setStyle(STYLE[theme]);
  }, [theme]);

  // Layers, re-added after each style load.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    localiseLabels(m, lang);
    const firstLabel = m.getStyle().layers?.find((l) => l.type === 'symbol')?.id;
    if (!m.getSource('shade')) {
      m.addSource('shade', { type: 'raster', tiles: [`/api/shade/{z}/{x}/{y}.png?t=${sunMs}`], tileSize: 256, minzoom: 15, maxzoom: 18 });
      m.addLayer({ id: 'shade', type: 'raster', source: 'shade', minzoom: SHADE_MIN_ZOOM, paint: { 'raster-opacity': 0.9, 'raster-fade-duration': 150 } }, firstLabel);
    }
    if (!m.getSource('route')) {
      m.addSource('route', { type: 'geojson', data: fc });
      m.addLayer({ id: 'ride-casing', type: 'line', source: 'route', filter: ['==', ['get', 'kind'], 'ride'], paint: { 'line-color': '#ffffff', 'line-width': 9 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
      m.addLayer({ id: 'ride', type: 'line', source: 'route', filter: ['==', ['get', 'kind'], 'ride'], paint: { 'line-color': ['get', 'color'], 'line-width': 6 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
      m.addLayer({ id: 'walk-casing', type: 'line', source: 'route', filter: ['in', ['get', 'kind'], ['literal', ['sun', 'partly', 'shade', 'covered', 'unknown']]], paint: { 'line-color': '#ffffff', 'line-width': 10 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
      m.addLayer({
        id: 'walk',
        type: 'line',
        source: 'route',
        filter: ['in', ['get', 'kind'], ['literal', ['sun', 'partly', 'shade', 'covered', 'unknown']]],
        paint: {
          'line-color': ['match', ['get', 'kind'], 'sun', '#ef7d00', 'partly', '#d9a400', 'shade', '#0f7c84', 'covered', '#5a6170', '#8a8f98'],
          'line-width': 6,
        },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      });
      m.addLayer({ id: 'stops', type: 'circle', source: 'route', filter: ['==', ['get', 'kind'], 'stop'], paint: { 'circle-radius': 7, 'circle-color': '#ffffff', 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 4 } });
      m.addLayer({ id: 'entrances', type: 'circle', source: 'route', filter: ['==', ['get', 'kind'], 'entrance'], paint: { 'circle-radius': 6, 'circle-color': '#1f2937', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } });
      m.addLayer({
        id: 'rest',
        type: 'circle',
        source: 'route',
        filter: ['in', ['get', 'kind'], ['literal', ['rest-cooling', 'rest-konbini', 'rest-water', 'rest-toilet', 'rest-library']]],
        paint: {
          'circle-radius': 6,
          'circle-color': ['match', ['get', 'kind'], 'rest-cooling', '#1d8cf8', 'rest-water', '#0ea5e9', 'rest-toilet', '#7c3aed', '#16a34a'],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
      });
    }
  }, [ready, lang]);

  // Route data and framing.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    (m.getSource('route') as GeoJSONSource | undefined)?.setData(fc);
    const b = bounds(fc);
    if (b) m.fitBounds(b, { padding: 56, maxZoom: 17, duration: 600 });
  }, [fc, ready]);

  // Shade tiles for the chosen minute.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const src = m.getSource('shade') as maplibregl.RasterTileSource | undefined;
    const url = `/api/shade/{z}/{x}/{y}.png?t=${sunMs}`;
    if (src && src.tiles?.[0] !== url) src.setTiles([url]);
    if (m.getLayer('shade')) m.setLayoutProperty('shade', 'visibility', showShade ? 'visible' : 'none');
  }, [sunMs, showShade, ready]);

  useEffect(() => {
    if (focus && map.current) map.current.flyTo({ center: [focus.lon, focus.lat], zoom: 17.5, duration: 700 });
  }, [focus]);

  if (failed) return <p className="map-failed">{t('mapUnavailable')}</p>;
  return (
    <div className="map-wrap">
      <div ref={box} className="map" role="region" aria-label={t('showMap')} />
      <div className="map-panel">
        <label className="switch">
          <input type="checkbox" checked={showShade} onChange={(e) => setShowShade(e.target.checked)} />
          <span>
            <Icon name="tree" size={20} /> {t('mapShade')}
          </span>
        </label>
        {showShade && (
          <>
            <label className="slider-label" htmlFor="shade-time">
              {t('mapShadeTime', { time: clock(new Date(sunMs).toISOString()) })}
            </label>
            <input
              id="shade-time"
              type="range"
              min={5 * 60}
              max={19 * 60}
              step={10}
              value={minute}
              onChange={(e) => setMinute(Number(e.target.value))}
              aria-valuetext={clock(new Date(sunMs).toISOString())}
            />
            {zoom < SHADE_MIN_ZOOM && <p className="map-hint">{t('mapNeedsZoom')}</p>}
          </>
        )}
        <ul className="legend compact">
          <li>
            <span className="swatch sun" /> {t('mapLegendSun')}
          </li>
          <li>
            <span className="swatch shade" /> {t('mapLegendShade')}
          </li>
          <li>
            <span className="swatch covered" /> {t('mapLegendCovered')}
          </li>
        </ul>
      </div>
    </div>
  );
}

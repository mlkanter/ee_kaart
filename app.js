'use strict';

// Register Estonian national coordinate system
proj4.defs('EPSG:3301',
  '+proj=lcc +lat_1=59.33333333333334 +lat_2=58 +lat_0=57.51755393055556 ' +
  '+lon_0=24 +x_0=500000 +y_0=6375000 +ellps=GRS80 ' +
  '+towgs84=0,0,0,0,0,0,0 +units=m +no_defs');
ol.proj.proj4.register(proj4);

const WMS_URL = 'https://gsavalik.envir.ee/geoserver/metsaregister/wms';
const WFS_URL = 'https://gsavalik.envir.ee/geoserver/metsaregister/ows';
const OSRM_BASE = 'https://router.project-osrm.org/route/v1';
let routeMode = 'driving'; // 'driving' | 'walking'

// ── WFS vector layer styles ────────────────────────────────────────────────
const TEATIS_COLORS = { LR: '#ef4444', HR: '#f59e0b', SR: '#3b82f6', TR: '#8b5cf6', VR: '#10b981' };
const OMAND_COLORS  = { R: '#60a5fa', T: '#60a5fa', F: '#f97316', J: '#f97316', Y: '#f97316', X: '#f97316', E: '#f97316', M: '#4ade80', A: '#a78bfa' };

// ── Map-wide palette intent ────────────────────────────────────────────────
// Warm red/yellow .......... forest-type (Pesitsusrahu) fill — Metsavärvid ONLY
// Neutral grey ............. compartment boundaries (Metsaeraldised)
// White-cased coloured line  metsateatised (readable on top of any fill)
// One thematic FILL on at a time (see FILL_GROUP in buildLayersPanel).

// ── Pesitsusrahu (Metsavärvid 2026) classification ─────────────────────────
// P = Punane (red, raie keelatud pesitsusrahu ajal), K = Kollane (yellow).
// Looked up by site-type code (WFS kasvukoht_kood == file "Lühend") ×
// stand-age bucket of keskm_vanus: [<40, 40–59, 60–79, 80–99, ≥100].
// Source: Keskkonnaamet "Metsavärvid 2026" / Pesitsusrahu kontrolli juhis.
const PESITSUS_COLORS = { P: '#d64545', K: '#e8b53c' };
const PESITSUS_TABLE = {
  LL:['K','K','K','P','P'], KL:['K','K','K','P','P'], LU:['K','K','K','P','P'],
  SM:['K','K','K','K','K'], KN:['K','K','K','K','K'],
  PH:['K','K','K','K','P'], JP:['K','K','K','K','P'], MS:['K','K','K','K','P'],
  KM:['K','K','K','K','P'], JM:['K','K','K','K','P'],
  JK:['K','K','P','P','P'], SL:['K','K','P','P','P'],
  ND:['K','K','P','P','P'], SJ:['K','K','P','P','P'],
  OS:['K','K','K','P','P'], TR:['K','K','K','P','P'], AN:['K','K','K','P','P'], TA:['K','K','K','P','P'],
  SN:['K','K','K','K','K'], KR:['K','K','K','K','K'],
  LD:['K','K','K','P','P'], MD:['K','K','K','K','P'],
  SS:['K','K','K','K','K'], RB:['K','K','K','K','K'],
  MKS:['K','K','K','K','K'], JKS:['K','K','K','P','P'],
};
function ageBucket(v) {
  // Strict number check: '' or other non-numbers must classify as unknown ('?'),
  // not coerce to 0 and come out as a confident 'K'.
  if (typeof v !== 'number' || isNaN(v)) return -1;
  if (v < 40) return 0;
  if (v < 60) return 1;
  if (v < 80) return 2;
  if (v < 100) return 3;
  return 4;
}
// Returns 'P', 'K', or null (unknown site type / missing age). Accepts a plain
// props object or anything with .kasvukoht_kood / .keskm_vanus.
function classifyPK(props) {
  const code = String(props.kasvukoht_kood || '').toUpperCase();
  const row = PESITSUS_TABLE[code];
  const b = ageBucket(props.keskm_vanus);
  if (!row || b < 0) return null;
  return row[b];
}

// A ~1%-alpha fill keeps polygon interiors clickable (hit-testable) without
// showing any colour. Shared by all outline-only styles.
const CLICKABLE_FILL = new ol.style.Fill({ color: 'rgba(255,255,255,0.01)' });

// Style functions run per feature per render frame, so they must not allocate.
// All variants are precomputed/cached and the functions return shared instances.
const _teatisStyleCache = {};
function teatisStyleFn(feature) {
  // Hide expired metsateatised (>24 months since approval).
  if (!teatisIsActive(feature)) return null;
  const code = feature.get('too_kood');
  const key = TEATIS_COLORS[code] ? code : '_';
  if (disabledTypes.teatis.has(key)) return null;
  // "Cased" outline: white halo + coloured core, readable on top of the
  // Metsavärvid red/yellow fill. One cached two-style array per type code.
  return _teatisStyleCache[key] ??= [
    new ol.style.Style({ stroke: new ol.style.Stroke({ color: '#ffffff', width: 4 }) }),
    new ol.style.Style({
      stroke: new ol.style.Stroke({ color: TEATIS_COLORS[code] || '#94a3b8', width: 2 }),
      fill: CLICKABLE_FILL,
    }),
  ];
}

function omandivormStyleFn(feature) {
  const code = feature.get('omandivorm_kood');
  const key = OMAND_COLORS[code] ? code : '_';
  if (disabledTypes.omandivorm.has(key)) return null;
  const c = OMAND_COLORS[code] || '#94a3b8';
  return new ol.style.Style({
    fill: new ol.style.Fill({ color: c + '8c' }),
    // no stroke — fill only
  });
}

// Metsavärvid: colour ONLY compartments that have an active metsateatis.
// P = red, K = yellow (per PESITSUS_TABLE); compartments with no usable data
// (e.g. missing keskm_vanus) show a neutral grey "?". Other compartments render
// nothing here (their boundary still comes from the Metsaeraldised layer).
// P/K labels appear from zoom 14 in; resolution is the styleFn's 2nd argument.
const PESITSUS_LABEL_MAX_RES = 156543.03392804097 / Math.pow(2, 14); // EPSG:3857 res at z14
const _pesitsusStyleCache = {};
function pesitsusStyle(pk, withLabel) {
  const key = `${pk || '?'}|${withLabel ? 'L' : ''}`;
  if (_pesitsusStyleCache[key]) return _pesitsusStyleCache[key];
  const c = pk ? PESITSUS_COLORS[pk] : '#9ca3af';   // grey = under teatis, unclassifiable
  const styles = [new ol.style.Style({
    fill: new ol.style.Fill({ color: c + '8c' }),
    stroke: new ol.style.Stroke({ color: c, width: 0.8 }),
  })];
  if (withLabel) {
    styles.push(new ol.style.Style({ text: new ol.style.Text({
      text: pk || '?',
      font: 'bold 13px sans-serif',
      fill: new ol.style.Fill({ color: '#fff' }),
      stroke: new ol.style.Stroke({ color: '#000', width: 2.5 }),
      overflow: true,
    }) }));
  }
  return (_pesitsusStyleCache[key] = styles);
}
function pesitsusStyleFn(feature, resolution) {
  // Per-feature compartment keys and P/K class are computed once and cached on
  // the feature (silent set — no change events) — this fn runs per render frame.
  let keys = feature.get('_ckeys');
  if (keys === undefined) {
    keys = compartmentKeys(feature);
    feature.set('_ckeys', keys, true);
  }
  if (!keys.some(k => activeTeatisKeys.has(k))) return null;
  let pk = feature.get('_pk');
  if (pk === undefined) {
    pk = classifyPK(feature.getProperties());
    feature.set('_pk', pk, true);
  }
  if (pk && disabledTypes.metsavarvid.has(pk)) return null;
  return pesitsusStyle(pk, resolution <= PESITSUS_LABEL_MAX_RES);
}

// Metsaeraldised: colourless boundary lines only.
const eraldisOutlineStyle = new ol.style.Style({
  fill: CLICKABLE_FILL,
  stroke: new ol.style.Stroke({ color: '#374151', width: 0.8 }),
});
function eraldisStyleFn() { return eraldisOutlineStyle; }

// Metsateatis is legally valid for 24 months from otsus_kinnitatud_kp
// (Metsaseadus §41). The WFS field `kehtiv_kuni` stores +12 months and is
// unreliable, so we compute validity ourselves.
const TEATIS_VALIDITY_MONTHS = 24;
function teatisIsActive(feature) {
  const approved = feature.get('otsus_kinnitatud_kp');
  if (!approved) return true; // be permissive if data is missing
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - TEATIS_VALIDITY_MONTHS);
  return new Date(approved) >= cutoff;
}

// Client-side disabled-types maps. Keys are layer ids; values are Sets of codes
// to hide. Clicking a legend item toggles entries here.
const disabledTypes = { teatis: new Set(), omandivorm: new Set(), metsavarvid: new Set() };

// Index of compartments (katastri_nr/eraldise_nr) that currently have an ACTIVE
// metsateatis. Metsavärvid colours only these. Grown incrementally as teatis
// bbox loads arrive (loaded features are never evicted, so no removal pass).
const activeTeatisKeys = new Set();
// A compartment is matched to a teatis by ONE id, in precedence order:
// cadastral number when present, else the state-forest quarter (state forest
// has no katastri_nr). Never both — private-land kvartali_nr values are
// management-plan numbers that repeat across properties (and the register
// holds placeholder values like '-' shared by thousands of compartments), so
// quarter matching while a cadastral id exists creates false positives.
function compartmentKeysProps(p) {
  const er = p.eraldise_nr;
  if (er == null) return [];
  if (p.katastri_nr) return [`K:${p.katastri_nr}/${er}`];
  const kv = p.kvartali_nr;
  if (kv && kv !== '-') return [`Q:${kv}/${er}`];
  return [];
}
function compartmentKeys(f) {
  return compartmentKeysProps({
    eraldise_nr: f.get('eraldise_nr'),
    katastri_nr: f.get('katastri_nr'),
    kvartali_nr: f.get('kvartali_nr'),
  });
}
// Add keys for newly loaded teatis features only (O(new), not O(all loaded)).
// Returns true if anything new was added (caller then repaints Metsavärvid).
function addTeatisKeys(features) {
  let added = false;
  for (const f of features) {
    if (!teatisIsActive(f)) continue;
    for (const k of compartmentKeys(f)) {
      if (!activeTeatisKeys.has(k)) { activeTeatisKeys.add(k); added = true; }
    }
  }
  return added;
}

function makeWFSSource(typeName) {
  return new ol.source.Vector({
    format: new ol.format.GeoJSON(),
    url: extent => {
      const bbox = ol.proj.transformExtent(extent, 'EPSG:3857', 'EPSG:4326');
      return `${WFS_URL}?service=WFS&version=2.0.0&request=GetFeature` +
        `&typeName=${typeName}&outputFormat=application/json` +
        `&srsName=EPSG:4326&bbox=${bbox.join(',')},EPSG:4326`;
    },
    strategy: ol.loadingstrategy.bbox,
  });
}

// ── Layer definitions ──────────────────────────────────────────────────────
const LAYER_DEFS = [
  {
    id: 'eraldis',
    label: 'Metsaeraldised (piirid)',
    type: 'wfs',
    typeName: 'metsaregister:eraldis',
    styleFn: eraldisStyleFn,
    visible: true,
    opacity: 1,
    queryable: true,
    minZoom: 11,
    zIndex: 20,
  },
  {
    id: 'teatis',
    label: 'Metsateatised (kehtivad, tüübi järgi)',
    type: 'wfs',
    typeName: 'metsaregister:teatis',
    styleFn: teatisStyleFn,
    visible: true,
    opacity: 1,
    queryable: true,
    minZoom: 11,
    zIndex: 30,
    legend: [
      { code: 'LR', color: '#ef4444', label: 'LR – lageraie' },
      { code: 'HR', color: '#f59e0b', label: 'HR – harvendusraie' },
      { code: 'SR', color: '#3b82f6', label: 'SR – sanitaarraie' },
      { code: 'TR', color: '#8b5cf6', label: 'TR – turberaie' },
      { code: 'VR', color: '#10b981', label: 'VR – valikraie' },
      { code: '_',  color: '#94a3b8', label: 'Muu' },
    ],
  },
  {
    id: 'raie_taius',
    label: 'Raieküpsed – täius',
    wmsLayer: 'metsaregister:mr__teema_raie_taius',
    visible: false,
    opacity: 0.75,
    queryable: false,
  },
  {
    id: 'raie_vanus',
    label: 'Raieküpsed – vanus',
    wmsLayer: 'metsaregister:mr__teema_raie_vanus',
    visible: false,
    opacity: 0.75,
    queryable: false,
  },
  {
    id: 'raie_liik',
    label: 'Raieküpsed – liik',
    wmsLayer: 'metsaregister:mr__teema_raie_liik',
    visible: false,
    opacity: 0.75,
    queryable: false,
  },
  {
    id: 'raie_diameeter',
    label: 'Raieküpsed – diameeter',
    wmsLayer: 'metsaregister:mr__teema_raie_diameeter',
    visible: false,
    opacity: 0.75,
    queryable: false,
  },
  {
    id: 'omandivorm',
    label: 'Omandivorm',
    type: 'wfs',
    typeName: 'metsaregister:eraldis',
    styleFn: omandivormStyleFn,
    visible: false,
    opacity: 1,
    queryable: false,
    legend: [
      { codes: ['R', 'T'],                 color: '#60a5fa', label: 'Riigiomand (R, T)' },
      { codes: ['F', 'J', 'Y', 'X', 'E'],  color: '#f97316', label: 'Eraomand (F, J, Y, X, E)' },
      { codes: ['M'],                      color: '#4ade80', label: 'Munitsipaalomand (M)' },
      { codes: ['A'],                      color: '#a78bfa', label: 'Avalik-õiguslik (A)' },
      { codes: ['_'],                      color: '#94a3b8', label: 'Muu' },
    ],
  },
  {
    id: 'metsavarvid',
    label: 'Metsavärvid (pesitsusrahu)',
    type: 'wfs',
    typeName: 'metsaregister:eraldis',
    styleFn: pesitsusStyleFn,
    visible: true,
    opacity: 0.85,
    queryable: true,
    minZoom: 12,
    zIndex: 10,
    legend: [
      { code: 'P', color: '#d64545', label: 'P – Punane (raie keelatud pes.rahu ajal)' },
      { code: 'K', color: '#e8b53c', label: 'K – Kollane' },
    ],
  },
];

// ── Layer visibility gateway ───────────────────────────────────────────────
// ALL layer-visibility changes go through setLayerVisible so its invariants
// hold no matter who toggles (checkbox, session restore, future code):
//   1. Thematic fills all paint the same compartments → only one on at a time.
//   2. Metsavärvid colours only active-teatis compartments, and a hidden vector
//      layer stops loading data — so metsavarvid requires teatis, BOTH ways:
//      enabling metsavarvid enables teatis; disabling teatis disables metsavarvid
//      (otherwise the P/K colouring would silently go stale in new areas).
const FILL_GROUP = ['metsavarvid', 'omandivorm', 'raie_taius', 'raie_vanus', 'raie_liik', 'raie_diameeter'];
function setLayerVisible(id, on) {
  wmsLayers[id]?.setVisible(on);
  const cb = document.querySelector(`input[type=checkbox][data-id="${id}"]`);
  if (cb) cb.checked = on;
  const leg = document.getElementById(`legend-${id}`);
  if (leg) leg.style.display = on ? '' : 'none';
  if (on && FILL_GROUP.includes(id)) {
    FILL_GROUP.forEach(other => {
      if (other !== id && wmsLayers[other]?.getVisible()) setLayerVisible(other, false);
    });
  }
  if (on && id === 'metsavarvid' && !wmsLayers.teatis?.getVisible()) setLayerVisible('teatis', true);
  if (!on && id === 'teatis' && wmsLayers.metsavarvid?.getVisible()) setLayerVisible('metsavarvid', false);
}

// ── Session state ──────────────────────────────────────────────────────────
// v2: bumped when the layer model changed (eraldis WMS-fill → outline vector,
// new metsavarvid layer) — v1 state carries stale opacities/visibility combos.
const STATE_KEY = 'mr_ui_state_v2';
// One-time cleanup of keys from removed features / old versions. The old Gist
// token is a credential and must not linger in storage. metsaregister_visits
// (user's old field records) is deliberately left untouched.
['mr_ui_state', 'mr_gist_token', 'mr_gist_id'].forEach(k => localStorage.removeItem(k));

function saveUIState() {
  if (!map) return;
  const layers = {};
  LAYER_DEFS.forEach(def => {
    layers[def.id] = { visible: wmsLayers[def.id]?.getVisible(), opacity: wmsLayers[def.id]?.getOpacity() };
  });
  const center = ol.proj.toLonLat(map.getView().getCenter());
  localStorage.setItem(STATE_KEY, JSON.stringify({ layers, center, zoom: map.getView().getZoom(), routeMode }));
}

function loadUIState() {
  try {
    const state = JSON.parse(localStorage.getItem(STATE_KEY));
    if (!state) return;
    if (state.layers) {
      LAYER_DEFS.forEach(def => {
        const s = state.layers[def.id];
        if (!s) return;
        setLayerVisible(def.id, !!s.visible);
        wmsLayers[def.id]?.setOpacity(s.opacity ?? 1);
        const slider = document.querySelector(`.opacity-slider[data-id="${def.id}"]`);
        if (slider) slider.value = Math.round((s.opacity ?? 1) * 100);
      });
    }
    if (state.center && state.zoom) {
      map.getView().setCenter(ol.proj.fromLonLat(state.center));
      map.getView().setZoom(state.zoom);
    }
    if (state.routeMode) {
      routeMode = state.routeMode;
      const btn = document.getElementById('mode-toggle');
      if (btn) { btn.textContent = routeMode === 'driving' ? '🚗' : '🚶'; btn.title = routeMode === 'driving' ? 'Liikumisviis: auto' : 'Liikumisviis: jalgsi'; }
    }
  } catch (e) { /* silent */ }
}

// ── App state ──────────────────────────────────────────────────────────────
let map, routeSource, locationFeature, clickMarkerFeature;
let wmsLayers = {};
let userLocation = null; // [lon, lat] EPSG:4326
let lastClickedLonLat = null;

// ── Map initialisation ─────────────────────────────────────────────────────
function initMap() {
  // Background OSM
  const osm = new ol.layer.Tile({ source: new ol.source.OSM() });

  // WMS / WFS layers. Layers sharing a typeName (eraldis / omandivorm /
  // metsavarvid all draw metsaregister:eraldis) share ONE vector source, so the
  // data is downloaded and held in memory once, not per layer.
  const wfsSources = {};
  const wmsLayerObjects = LAYER_DEFS.map(def => {
    let layer;
    if (def.type === 'wfs') {
      layer = new ol.layer.Vector({
        source: wfsSources[def.typeName] ??= makeWFSSource(def.typeName),
        style: def.styleFn,
        visible: def.visible,
        opacity: def.opacity,
        minZoom: def.minZoom,        // undefined → no lower bound
        zIndex: def.zIndex ?? 10,    // fills default to 10 (below eraldis 20 / teatis 30)
        properties: { id: def.id, queryable: def.queryable },
      });
    } else {
      layer = new ol.layer.Tile({
        visible: def.visible,
        opacity: def.opacity,
        minZoom: def.minZoom,
        zIndex: def.zIndex ?? 10,
        source: new ol.source.TileWMS({
          url: WMS_URL,
          params: { LAYERS: def.wmsLayer, STYLES: '', TILED: true, FORMAT: 'image/png', TRANSPARENT: true },
          serverType: 'geoserver',
          crossOrigin: 'anonymous',
        }),
        properties: { id: def.id, wmsLayer: def.wmsLayer, queryable: def.queryable },
      });
    }
    wmsLayers[def.id] = layer;
    return layer;
  });

  // Index newly loaded teatis features into activeTeatisKeys, then re-render
  // Metsavärvid so it colours the matching compartments. Incremental: only the
  // batch in e.features is processed, and repaint is skipped when nothing new.
  wmsLayers.teatis?.getSource().on('featuresloadend', e => {
    if (addTeatisKeys(e.features || [])) wmsLayers.metsavarvid?.changed();
  });

  // Route layer
  routeSource = new ol.source.Vector();
  const routeLayer = new ol.layer.Vector({
    source: routeSource,
    style: new ol.style.Style({
      stroke: new ol.style.Stroke({ color: '#818cf8', width: 4, lineDash: [8, 4] }),
    }),
    zIndex: 90,
  });

  // GPS location dot
  locationFeature = new ol.Feature();
  locationFeature.setStyle(new ol.style.Style({
    image: new ol.style.Circle({
      radius: 8,
      fill: new ol.style.Fill({ color: '#60a5fa' }),
      stroke: new ol.style.Stroke({ color: '#fff', width: 2.5 }),
    }),
  }));
  const locationLayer = new ol.layer.Vector({
    source: new ol.source.Vector({ features: [locationFeature] }),
    zIndex: 200,
  });

  // Click marker (dark green ring) — shows the exact point the user clicked
  clickMarkerFeature = new ol.Feature();
  clickMarkerFeature.setStyle(new ol.style.Style({
    image: new ol.style.Circle({
      radius: 9,
      fill: new ol.style.Fill({ color: 'rgba(20, 83, 45, 0.25)' }),
      stroke: new ol.style.Stroke({ color: '#14532d', width: 2.5 }),
    }),
  }));
  const clickMarkerLayer = new ol.layer.Vector({
    source: new ol.source.Vector({ features: [clickMarkerFeature] }),
    zIndex: 210,
  });

  map = new ol.Map({
    target: 'map',
    layers: [osm, ...wmsLayerObjects, routeLayer, locationLayer, clickMarkerLayer],
    view: new ol.View({
      center: ol.proj.fromLonLat([25.0, 58.6]),
      zoom: 7,
    }),
    controls: ol.control.defaults.defaults().extend([
      new ol.control.ScaleLine({ units: 'metric', bar: true, steps: 4, text: true, minWidth: 100 }),
    ]),
  });

  // Floating popup above the click marker (for metsateatis hits)
  const popupEl = document.createElement('div');
  popupEl.className = 'map-popup';
  popupEl.style.display = 'none';
  clickPopupOverlay = new ol.Overlay({
    element: popupEl,
    positioning: 'bottom-center',
    offset: [0, -16],
    stopEvent: false,
  });
  map.addOverlay(clickPopupOverlay);

  map.on('singleclick', onMapClick);
  map.on('moveend', saveUIState);
}

// ── Map click handler ──────────────────────────────────────────────────────
function onMapClick(evt) {
  lastClickedLonLat = ol.proj.toLonLat(evt.coordinate);
  // Drop a visible marker at the clicked point
  clickMarkerFeature?.setGeometry(new ol.geom.Point(evt.coordinate));
  refreshNavHere();
  queryLayerInfo(evt);
}

// Enable/disable the persistent "Navigeeri siia" button based on whether a
// point is currently chosen on the map (clicked or coordinate-searched).
function refreshNavHere() {
  const b = document.getElementById('nav-here-btn');
  if (b) b.disabled = !lastClickedLonLat;
}

function queryLayerInfo(evt) {
  const queryableDefs = LAYER_DEFS.filter(
    def => def.queryable && wmsLayers[def.id]?.getVisible()
  );
  if (!queryableDefs.length) {
    hideClickPopup();
    renderFeatureInfo(null);
    return;
  }

  // 1. Check WFS (vector) layers first — they hold features client-side.
  //    Metsateatis is the priority overlay, so check it before the compartment
  //    layers (eraldis / metsavarvid), which otherwise intercept the click.
  const wfsDefs = queryableDefs
    .filter(def => def.type === 'wfs')
    .sort((a, b) => (a.id === 'teatis' ? -1 : b.id === 'teatis' ? 1 : 0));
  for (const def of wfsDefs) {
    const layer = wmsLayers[def.id];
    const hit = map.forEachFeatureAtPixel(
      evt.pixel,
      f => f,
      { layerFilter: l => l === layer, hitTolerance: 5 }
    );
    if (hit) {
      const props = hit.getProperties();
      // Strip OL's internal geometry property
      delete props.geometry;
      // For teatis: replace the unreliable `kehtiv_kuni` (registry stores +12
      // months) with one computed correctly from `otsus_kinnitatud_kp` + 24 months.
      // Also show a compact popup above the click marker.
      if (def.id === 'teatis') {
        if (props.otsus_kinnitatud_kp) {
          const approved = new Date(props.otsus_kinnitatud_kp);
          const validUntil = new Date(approved);
          validUntil.setMonth(validUntil.getMonth() + TEATIS_VALIDITY_MONTHS);
          props.kehtiv_kuni = validUntil.toISOString().split('T')[0];
        }
        showClickPopup(evt.coordinate, props, pkForTeatis(props));
      } else {
        hideClickPopup();
      }
      renderFeatureInfo({ features: [{ properties: props }] });
      return;
    }
  }
  // 2. No client-side hit (e.g. zoomed out below the layers' minZoom, where no
  //    vector data is loaded) — ask the WFS directly which compartment contains
  //    the clicked point, so clicks keep working at any zoom.
  hideClickPopup();
  const [lon, lat] = ol.proj.toLonLat(evt.coordinate);
  const url = `${WFS_URL}?service=WFS&version=2.0.0&request=GetFeature` +
    `&typeName=metsaregister:eraldis&count=1&outputFormat=application/json` +
    `&srsName=EPSG:4326&CQL_FILTER=` +
    encodeURIComponent(`INTERSECTS(shape, SRID=4326;POINT(${lon} ${lat}))`);
  fetch(url)
    .then(r => r.json())
    .then(data => renderFeatureInfo(data))
    .catch(() => renderFeatureInfo(null));
}

function formatDateDMY(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  if (isNaN(d)) return esc(String(iso));
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()}`;
}

// Compact on-map popup shown above the click marker for metsateatis hits.
let clickPopupOverlay = null;
function showClickPopup(coordinate, props, pk) {
  if (!clickPopupOverlay) return;
  const loc = lastClickedLonLat
    ? `${lastClickedLonLat[1].toFixed(5)}°N, ${lastClickedLonLat[0].toFixed(5)}°E`
    : '–';
  const el = clickPopupOverlay.getElement();
  // State forest has no katastri_nr — fall back to the quarter id (kvartali_nr).
  const idLabel = props.katastri_nr ? 'Katastri nr' : 'Kvartal';
  const idVal = props.katastri_nr ?? props.kvartali_nr ?? '–';
  let html = `
    <div class="map-popup-row"><span class="map-popup-key">Asukoht:</span> ${esc(loc)}</div>
    <div class="map-popup-row"><span class="map-popup-key">${idLabel}:</span> ${esc(idVal)}</div>
    <div class="map-popup-row"><span class="map-popup-key">Otsus kinnitatud:</span> ${formatDateDMY(props.otsus_kinnitatud_kp)}</div>`;
  if (props.too_kood) {
    // Full work-type name from the teatis legend (LR – lageraie, …).
    const legend = LAYER_DEFS.find(d => d.id === 'teatis')?.legend || [];
    const entry = legend.find(e => e.code === props.too_kood);
    const text = entry ? entry.label : props.too_kood;
    const color = TEATIS_COLORS[props.too_kood] || '#94a3b8';
    html += `
    <div class="map-popup-row"><span class="map-popup-key">Töö kood:</span>
      <span style="color:${color};font-weight:bold">${esc(text)}</span></div>`;
  }
  if (pk) {
    const label = pk === 'P' ? 'Punane' : 'Kollane';
    html += `
    <div class="map-popup-row"><span class="map-popup-key">Metsavärv:</span>
      <span style="background:${PESITSUS_COLORS[pk]};color:#fff;font-weight:bold;padding:1px 6px;border-radius:3px">${pk} – ${label}</span></div>`;
  }
  el.innerHTML = html;
  clickPopupOverlay.setPosition(coordinate);
  el.style.display = 'block';
}

// Forest-type (P/K) of the compartment a metsateatis applies to, matched by the
// teatis's own katastri_nr/kvartali_nr + eraldise_nr against the loaded eraldis
// features (a pixel hit-test could return the NEIGHBOURING compartment near a
// boundary). null if the compartment isn't loaded client-side.
function pkForTeatis(props) {
  const src = wmsLayers.eraldis?.getSource();
  if (!src) return null;
  // Same exclusive key logic as the Metsavärvid layer, so popup and map agree.
  const wanted = compartmentKeysProps(props);
  if (!wanted.length) return null;
  const match = src.getFeatures().find(f =>
    compartmentKeys(f).some(k => wanted.includes(k)));
  return match ? classifyPK(match.getProperties()) : null;
}
function hideClickPopup() {
  if (!clickPopupOverlay) return;
  clickPopupOverlay.getElement().style.display = 'none';
  clickPopupOverlay.setPosition(undefined);
}

function renderFeatureInfo(geojson) {
  const el = document.getElementById('feature-info');
  let html = '';
  if (geojson?.features?.length) {
    const props = geojson.features[0].properties;
    // Forest-type (Pesitsusrahu) badge — only for compartments under an ACTIVE
    // metsateatis, matching what the Metsavärvid layer colours on the map.
    const underTeatis = props.kasvukoht_kood &&
      compartmentKeysProps(props).some(k => activeTeatisKeys.has(k));
    const pk = underTeatis ? classifyPK(props) : null;
    if (pk) {
      const label = pk === 'P' ? 'Punane' : 'Kollane';
      html += `<div style="background:${PESITSUS_COLORS[pk]};color:#fff;font-weight:bold;` +
        `padding:4px 8px;border-radius:4px;margin-bottom:6px;display:inline-block">` +
        `${pk} – ${label} mets <small style="font-weight:normal">(${esc(String(props.kasvukoht_kood).toLowerCase())}, ` +
        `${esc(String(props.keskm_vanus))} a)</small></div>`;
    }
    const rows = Object.entries(props)
      .filter(([k, v]) => v !== null && v !== '' && !k.startsWith('_')) // _-prefixed = internal caches
      .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(String(v))}</td></tr>`)
      .join('');
    html += `<table>${rows}</table>`;
  } else {
    html += '<p class="empty">Antud kohas infot ei leitud.</p>';
  }
  el.innerHTML = html;
}

// ── Layer panel ────────────────────────────────────────────────────────────
function buildLayersPanel() {
  const container = document.getElementById('layers-list');

  LAYER_DEFS.forEach(def => {
    // Filterable layers: each legend item becomes a clickable toggle (hides
    // features of that type without re-fetching).
    const filterable = (def.id === 'teatis' || def.id === 'omandivorm' || def.id === 'metsavarvid');
    const legendHTML = def.legend ? `
      <div class="layer-legend" id="legend-${def.id}" style="${def.visible ? '' : 'display:none'}">
        ${def.legend.map(e => {
          const codes = e.codes ? e.codes : (e.code ? [e.code] : []);
          const codesAttr = codes.length ? ` data-codes="${codes.join(',')}"` : '';
          const cls = `legend-item${filterable ? ' legend-item-toggle' : ''}`;
          const titleAttr = filterable ? ' title="Klõpsa, et peita/näidata"' : '';
          return `
          <span class="${cls}" data-layer="${def.id}"${codesAttr}${titleAttr}>
            <span class="legend-swatch" style="background:${e.color}"></span>
            ${e.label}
          </span>`;
        }).join('')}
      </div>` : '';

    const row = document.createElement('div');
    row.className = 'layer-row';
    row.innerHTML = `
      <label class="layer-toggle">
        <input type="checkbox" data-id="${def.id}" ${def.visible ? 'checked' : ''}>
        <span>${def.label}</span>
      </label>
      <input type="range" class="opacity-slider" min="0" max="100"
        value="${Math.round(def.opacity * 100)}" data-id="${def.id}">
      ${legendHTML}
    `;
    container.appendChild(row);
  });

  // All visibility invariants (fill exclusivity, metsavarvid↔teatis dependency)
  // live in setLayerVisible — the checkbox just routes through it.
  container.addEventListener('change', e => {
    if (e.target.type === 'checkbox') {
      setLayerVisible(e.target.dataset.id, e.target.checked);
      saveUIState();
    }
  });
  container.addEventListener('input', e => {
    if (e.target.classList.contains('opacity-slider')) {
      wmsLayers[e.target.dataset.id]?.setOpacity(e.target.value / 100);
      saveUIState();
    }
  });

  // Legend sub-filter clicks (teatis / omandivorm)
  container.addEventListener('click', e => {
    const item = e.target.closest('.legend-item-toggle');
    if (!item) return;
    const layerId = item.dataset.layer;
    const codes = (item.dataset.codes || '').split(',').filter(Boolean);
    if (!codes.length || !disabledTypes[layerId]) return;
    // All codes currently disabled? Then enable them. Else disable them.
    const allDisabled = codes.every(c => disabledTypes[layerId].has(c));
    codes.forEach(c => {
      if (allDisabled) disabledTypes[layerId].delete(c);
      else disabledTypes[layerId].add(c);
    });
    item.classList.toggle('legend-item-off', !allDisabled);
    wmsLayers[layerId]?.changed(); // re-evaluate style for all features
  });
}

// ── Dialogs ────────────────────────────────────────────────────────────────
function openDialog(html) {
  document.getElementById('dialog-inner').innerHTML = html;
  document.getElementById('visit-dialog').classList.remove('hidden');
}

function closeDialog() {
  document.getElementById('visit-dialog').classList.add('hidden');
}

// ── Routing ────────────────────────────────────────────────────────────────
let lastRouteTarget = null; // { toLonLat, label } — remembered so a mode switch re-routes

const mapCenterLonLat = () => ol.proj.toLonLat(map.getView().getCenter());

// Resolve a routing start point: live GPS → one-shot GPS → map centre fallback,
// so routing always works even without a GPS fix.
function resolveRouteStart() {
  if (userLocation) return Promise.resolve({ from: userLocation, fallback: false });
  return new Promise(resolve => {
    if (!navigator.geolocation) { resolve({ from: mapCenterLonLat(), fallback: true }); return; }
    navigator.geolocation.getCurrentPosition(
      pos => {
        userLocation = [pos.coords.longitude, pos.coords.latitude];
        locationFeature.setGeometry(new ol.geom.Point(ol.proj.fromLonLat(userLocation)));
        resolve({ from: userLocation, fallback: false });
      },
      () => resolve({ from: mapCenterLonLat(), fallback: true }),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  });
}

// Monotonic id for route requests: a response only applies if it is still the
// latest (guards against out-of-order resolution when the GPS wait or network
// is slow, and against clear-route/mode-switch racing an in-flight request).
let routeSeq = 0;

function fetchRoute(toLonLat, label) {
  lastRouteTarget = { toLonLat, label };
  const seq = ++routeSeq;
  // Capture the mode once — URL, line colour and dialog label must all agree
  // even if the user toggles the mode while we wait for GPS/network.
  const mode = routeMode;
  const isWalking = mode === 'walking';
  resolveRouteStart().then(({ from, fallback }) => {
    if (seq !== routeSeq) return; // superseded or cleared while waiting for GPS
    const [fLon, fLat] = from;
    const [tLon, tLat] = toLonLat;
    const url = `${OSRM_BASE}/${mode}/${fLon},${fLat};${tLon},${tLat}?overview=full&geometries=geojson`;
    fetch(url)
      .then(r => r.json())
      .then(data => {
        if (seq !== routeSeq) return; // superseded or cleared while fetching
        if (!data.routes?.[0]) { alert('Marsruuti ei leitud.'); return; }
        routeSource.clear();
        const features = new ol.format.GeoJSON().readFeatures(data.routes[0].geometry, {
          dataProjection: 'EPSG:4326',
          featureProjection: 'EPSG:3857',
        });
        routeSource.addFeatures(features);
        // Update route line colour based on mode
        routeSource.getFeatures().forEach(f => f.setStyle(new ol.style.Style({
          stroke: new ol.style.Stroke({
            color: isWalking ? '#22c55e' : '#818cf8',
            width: 4,
            lineDash: [8, 4],
          }),
        })));
        map.getView().fit(routeSource.getExtent(), { padding: [60, 60, 60, 60], duration: 600 });
        document.getElementById('clear-route-btn').classList.remove('hidden');

        const km = (data.routes[0].distance / 1000).toFixed(1);
        const min = Math.round(data.routes[0].duration / 60);
        const modeLabel = isWalking ? 'jalgsi' : 'autoga';
        const startNote = fallback
          ? '<br><em>Algus: kaardi keskpunkt (GPS puudub)</em>' : '';
        openDialog(`
          <h3>Marsruut</h3>
          <div class="dialog-meta">
            <strong>Sihtpunkt:</strong> ${esc(label)}<br>
            <strong>Kaugus:</strong> ${km} km<br>
            <strong>Aeg (${modeLabel}):</strong> ~${min} min${startNote}
          </div>
          <div class="dialog-btns"><button onclick="closeDialog()">Sulge</button></div>
        `);
      })
      .catch(() => alert('Marsruudi arvutamine ebaõnnestus. Kontrolli internetiühendust.'));
  });
}

window.navigateToCoord = function() {
  if (!lastClickedLonLat) return;
  const label = `${lastClickedLonLat[1].toFixed(5)}°N, ${lastClickedLonLat[0].toFixed(5)}°E`;
  fetchRoute(lastClickedLonLat, label);
};

// ── GPS ────────────────────────────────────────────────────────────────────
// The locate button doubles as the GPS status indicator: dimmed with a warning
// title while no fix is available (denied/unavailable), normal once a fix lands.
function setGPSAvailable(ok) {
  const btn = document.getElementById('locate-btn');
  if (!btn) return;
  btn.classList.toggle('gps-off', !ok);
  btn.title = ok ? 'Mine minu asukohta'
    : 'GPS pole saadaval — kontrolli, et asukohaluba on brauseris lubatud';
}

function startGPS() {
  if (!navigator.geolocation) { setGPSAvailable(false); return; }
  navigator.geolocation.watchPosition(
    pos => {
      userLocation = [pos.coords.longitude, pos.coords.latitude];
      locationFeature.setGeometry(new ol.geom.Point(ol.proj.fromLonLat(userLocation)));
      setGPSAvailable(true);
    },
    () => setGPSAvailable(false),
    { enableHighAccuracy: true, maximumAge: 5000 }
  );
}

// ── Coordinate search box ──────────────────────────────────────────────────
// Parse "lat, lon" (also accepts space-separated, °N/E suffixes, comma decimals).
// Returns [lon, lat] or null. Auto-swaps if the pair looks reversed for Estonia.
// Requires EXACTLY two decimal numbers, both inside Estonia's coordinate bands —
// DMS input (58°42'30") or stray values are rejected rather than misread.
function parseLatLon(str) {
  const nums = (str || '').replace(/[°ºnesw]/gi, ' ').match(/-?\d+(?:[.,]\d+)?/g);
  if (!nums || nums.length !== 2) return null;
  const a = parseFloat(nums[0].replace(',', '.'));
  const b = parseFloat(nums[1].replace(',', '.'));
  if (isNaN(a) || isNaN(b)) return null;
  const inLat = v => v >= 57.0 && v <= 60.0;   // Estonia latitude band
  const inLon = v => v >= 21.0 && v <= 29.0;   // Estonia longitude band
  if (inLat(a) && inLon(b)) return [b, a];     // lat, lon (the documented order)
  if (inLat(b) && inLon(a)) return [a, b];     // user typed lon, lat — swap
  return null;
}

// Cadastral number, e.g. 88401:004:0185
const CADASTRAL_RE = /^\s*(\d{5}:\d{3}:\d{4})\s*$/;

// Estonian Land Board In-ADS gazetteer search: addresses, place names, streets,
// buildings and cadastral units, nationwide. Returns a list of
// {label, tunnus, point: [lon,lat], extent: EPSG:3857 | null}.
// In-ADS coordinates are L-EST97 (EPSG:3301) easting/northing.
function inAdsSearch(query, results = 8) {
  const url = 'https://inaadress.maaamet.ee/inaadress/gazetteer?of=json' +
    `&address=${encodeURIComponent(query)}&results=${results}`;
  return fetch(url)
    .then(r => r.json())
    .then(data => (data.addresses || []).map(a => {
      const point = ol.proj.transform(
        [parseFloat(a.viitepunkt_x), parseFloat(a.viitepunkt_y)],
        'EPSG:3301', 'EPSG:4326');
      let extent = null;
      const corners = (a.boundingbox || '').trim().split(/\s+/)
        .map(p => p.split(',').map(Number))
        .filter(c => c.length === 2 && c.every(isFinite));
      if (corners.length >= 2) {
        const xs = corners.map(c => c[0]), ys = corners.map(c => c[1]);
        extent = ol.proj.transformExtent(
          [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
          'EPSG:3301', 'EPSG:3857');
      }
      return {
        label: a.pikkaadress || a.taisaadress || a.aadresstekst || '',
        tunnus: CADASTRAL_RE.test(a.tunnus || '') ? a.tunnus : null,
        point, extent,
      };
    }).filter(r => r.point.every(isFinite)));
}

// Fly to a gazetteer result and surface it in the info panel.
function goToPlace(res) {
  if (res.extent) {
    map.getView().fit(res.extent, { padding: [60, 60, 60, 60], maxZoom: 16, duration: 500 });
  } else {
    map.getView().animate({ center: ol.proj.fromLonLat(res.point), zoom: 15, duration: 500 });
  }
  lastClickedLonLat = res.point;
  clickMarkerFeature?.setGeometry(new ol.geom.Point(ol.proj.fromLonLat(res.point)));
  refreshNavHere();
  const props = { aadress: res.label };
  if (res.tunnus) props.katastri_nr = res.tunnus;
  renderFeatureInfo({ features: [{ properties: props }] });
}

function goToCoord(lonLat) {
  const coord = ol.proj.fromLonLat(lonLat);
  map.getView().animate({ center: coord, zoom: Math.max(map.getView().getZoom() ?? 0, 14), duration: 500 });
  lastClickedLonLat = lonLat;
  clickMarkerFeature?.setGeometry(new ol.geom.Point(coord));
  refreshNavHere();
  // Show the searched point in the info panel.
  renderFeatureInfo({ features: [{ properties: {
    laius: lonLat[1].toFixed(6), pikkus: lonLat[0].toFixed(6),
  } }] });
}

function initCoordSearch() {
  const input = document.getElementById('coord-input');
  if (!input) return;
  // While empty/unfocused, the placeholder shows the live map-centre coordinates.
  const updatePlaceholder = () => {
    if (input.value || document.activeElement === input) return;
    const [lon, lat] = mapCenterLonLat();
    input.placeholder = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  };
  map.on('moveend', updatePlaceholder);
  updatePlaceholder();

  const resultsEl = document.getElementById('coord-results');
  const flashError = () => {
    input.classList.add('coord-error');
    setTimeout(() => input.classList.remove('coord-error'), 1200);
  };
  const hideResults = () => { resultsEl.classList.add('hidden'); resultsEl.innerHTML = ''; };
  const finishSearch = () => {
    input.value = '';
    input.blur();
    hideResults();
    updatePlaceholder();
  };
  // One result → go straight there; several → let the user pick from a list.
  const showResults = list => {
    resultsEl.innerHTML = list.map((r, i) =>
      `<div class="coord-result" data-i="${i}">${esc(r.label)}</div>`).join('');
    resultsEl.classList.remove('hidden');
    // mousedown (not click): fires before the input's blur hides the list.
    resultsEl.querySelectorAll('.coord-result').forEach(el => {
      el.addEventListener('mousedown', ev => {
        ev.preventDefault();
        goToPlace(list[Number(el.dataset.i)]);
        finishSearch();
      });
    });
  };

  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { hideResults(); input.blur(); return; }
    if (e.key !== 'Enter') return;
    hideResults();
    const q = input.value.trim();
    if (!q) return;

    // 1. Cadastral number → resolve the exact parcel.
    const cad = q.match(CADASTRAL_RE);
    if (cad) {
      inAdsSearch(cad[1], 5)
        .then(list => {
          const hit = list.find(r => r.tunnus === cad[1]);
          if (!hit) { flashError(); return; }
          goToPlace(hit);
          finishSearch();
        })
        .catch(flashError);
      return;
    }
    // 2. Coordinates.
    const lonLat = parseLatLon(q);
    if (lonLat) { goToCoord(lonLat); finishSearch(); return; }
    // 3. Free-text address / place-name search.
    if (q.length < 3) { flashError(); return; }
    inAdsSearch(q)
      .then(list => {
        if (!list.length) { flashError(); return; }
        if (list.length === 1) { goToPlace(list[0]); finishSearch(); return; }
        showResults(list);
      })
      .catch(flashError);
  });
  input.addEventListener('blur', () => setTimeout(hideResults, 150));
}

// ── Utilities ──────────────────────────────────────────────────────────────
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Bootstrap ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  buildLayersPanel();
  loadUIState();
  startGPS();
  initCoordSearch();

  // Navigate to the currently chosen point (click or coordinate search).
  document.getElementById('nav-here-btn').addEventListener('click', () => navigateToCoord());

  // Transport mode toggle
  document.getElementById('mode-toggle').addEventListener('click', () => {
    routeMode = routeMode === 'driving' ? 'walking' : 'driving';
    const btn = document.getElementById('mode-toggle');
    btn.textContent = routeMode === 'driving' ? '🚗' : '🚶';
    btn.title = routeMode === 'driving' ? 'Liikumisviis: auto' : 'Liikumisviis: jalgsi';
    saveUIState();
    // If a route is currently shown, recompute it for the new mode.
    if (lastRouteTarget && routeSource.getFeatures().length) {
      fetchRoute(lastRouteTarget.toLonLat, lastRouteTarget.label);
    }
  });

  // Go to my location (single-click pan + zoom). Falls back to a one-shot
  // getCurrentPosition if watchPosition hasn't reported yet.
  document.getElementById('locate-btn').addEventListener('click', () => {
    const goTo = (lon, lat) => {
      map.getView().animate({ center: ol.proj.fromLonLat([lon, lat]), zoom: 14, duration: 600 });
    };
    if (userLocation) {
      goTo(userLocation[0], userLocation[1]);
      return;
    }
    if (!navigator.geolocation) {
      alert('GPS pole toetatud.');
      return;
    }
    const btn = document.getElementById('locate-btn');
    btn.disabled = true;
    btn.textContent = '⏳';
    navigator.geolocation.getCurrentPosition(
      pos => {
        userLocation = [pos.coords.longitude, pos.coords.latitude];
        locationFeature.setGeometry(new ol.geom.Point(ol.proj.fromLonLat(userLocation)));
        goTo(userLocation[0], userLocation[1]);
        btn.disabled = false;
        btn.textContent = '📍';
      },
      () => {
        alert('GPS asukoht pole saadaval. Kontrolli, et asukohaluba on lubatud.');
        btn.disabled = false;
        btn.textContent = '📍';
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  // Clear route (routeSeq bump cancels any in-flight route request)
  document.getElementById('clear-route-btn').addEventListener('click', () => {
    routeSeq++;
    routeSource.clear();
    lastRouteTarget = null;
    document.getElementById('clear-route-btn').classList.add('hidden');
  });

  // Sidebar toggle (both the header button and the floating reopen button)
  function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('collapsed');
    setTimeout(() => map.updateSize(), 220);
  }
  document.getElementById('sidebar-toggle').addEventListener('click', toggleSidebar);
  document.getElementById('sidebar-float-btn').addEventListener('click', toggleSidebar);

  // Close dialog on overlay click
  document.getElementById('visit-dialog').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeDialog();
  });
});

'use strict';

// Register Estonian national coordinate system
proj4.defs('EPSG:3301',
  '+proj=lcc +lat_1=59.33333333333334 +lat_2=58 +lat_0=57.51755393055556 ' +
  '+lon_0=24 +x_0=500000 +y_0=6375000 +ellps=GRS80 ' +
  '+towgs84=0,0,0,0,0,0,0 +units=m +no_defs');
ol.proj.proj4.register(proj4);

const WMS_URL = 'https://gsavalik.envir.ee/geoserver/metsaregister/wms';
const WFS_URL = 'https://gsavalik.envir.ee/geoserver/metsaregister/ows';
const OSRM_URL = 'https://router.project-osrm.org/route/v1/driving';

// ── WFS vector layer styles ────────────────────────────────────────────────
const TEATIS_COLORS = { LR: '#ef4444', HR: '#f59e0b', SR: '#3b82f6', TR: '#8b5cf6', VR: '#10b981' };
const OMAND_COLORS  = { R: '#60a5fa', T: '#60a5fa', F: '#f97316', J: '#f97316', Y: '#f97316', X: '#f97316', E: '#f97316', M: '#4ade80', A: '#a78bfa' };

// Canvas hatch patterns — one canvas per colour+type, cached
const _hatchCache = {};
function hatchPattern(color, type) {
  const key = `${type}|${color}`;
  if (_hatchCache[key]) return _hatchCache[key];
  const sz = 10;
  const c = Object.assign(document.createElement('canvas'), { width: sz, height: sz });
  const ctx = c.getContext('2d');
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'square';
  const line = (x1, y1, x2, y2) => { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); };
  if (type === 'diag')  { line(0, sz, sz, 0); line(-sz, sz, 0, 0); line(sz, sz*2, sz*2, sz); }
  if (type === 'diag2') { line(0, 0, sz, sz); line(0, -sz, sz*2, sz); line(-sz, 0, sz, sz*2); }
  if (type === 'horiz') { line(0, sz/2, sz, sz/2); }
  if (type === 'vert')  { line(sz/2, 0, sz/2, sz); }
  if (type === 'cross') { line(0, sz/2, sz, sz/2); line(sz/2, 0, sz/2, sz); }
  if (type === 'dot')   { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(sz/2, sz/2, 2, 0, Math.PI*2); ctx.fill(); }
  const pat = ctx.createPattern(c, 'repeat');
  _hatchCache[key] = pat;
  return pat;
}

const TEATIS_HATCH = { LR: 'diag', HR: 'cross', SR: 'horiz', TR: 'vert', VR: 'diag2', _: 'dot' };

function teatisStyleFn(feature) {
  const code = feature.get('too_kood');
  const color = TEATIS_COLORS[code] || '#94a3b8';
  const pattern = hatchPattern(color, TEATIS_HATCH[code] || TEATIS_HATCH._);
  return new ol.style.Style({
    fill: new ol.style.Fill({ color: pattern }),
    stroke: new ol.style.Stroke({ color, width: 1.5 }),
  });
}

function omandivormStyleFn(feature) {
  const c = OMAND_COLORS[feature.get('omandivorm_kood')] || '#94a3b8';
  return new ol.style.Style({
    fill: new ol.style.Fill({ color: c + '8c' }),
    // no stroke — fill only
  });
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
    label: 'Metsaeraldised',
    wmsLayer: 'metsaregister:eraldis',
    visible: true,
    opacity: 0.7,
    queryable: true,
  },
  {
    id: 'teatis',
    label: 'Metsateatised (tüübi järgi)',
    type: 'wfs',
    typeName: 'metsaregister:teatis',
    styleFn: teatisStyleFn,
    visible: false,
    opacity: 1,
    queryable: true,
    legend: [
      { color: '#ef4444', label: 'LR – lageraie' },
      { color: '#f59e0b', label: 'HR – harvendusraie' },
      { color: '#3b82f6', label: 'SR – sanitaarraie' },
      { color: '#8b5cf6', label: 'TR – turberaie' },
      { color: '#10b981', label: 'VR – valikraie' },
      { color: '#94a3b8', label: 'Muu' },
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
      { color: '#60a5fa', label: 'Riigiomand (R, T)' },
      { color: '#f97316', label: 'Eraomand (F, J, Y, X, E)' },
      { color: '#4ade80', label: 'Munitsipaalomand (M)' },
      { color: '#a78bfa', label: 'Avalik-õiguslik (A)' },
      { color: '#94a3b8', label: 'Muu' },
    ],
  },
];

// ── Priority colours ───────────────────────────────────────────────────────
const P_COLORS = ['#64748b', '#3b82f6', '#f59e0b', '#f97316', '#ef4444'];
function pColor(p) { return P_COLORS[Math.min((p || 1) - 1, 4)]; }

// ── Data layer (localStorage) ──────────────────────────────────────────────
const DB = {
  KEY: 'metsaregister_visits',

  all() {
    try { return JSON.parse(localStorage.getItem(this.KEY)) || []; }
    catch { return []; }
  },

  save(visits) { localStorage.setItem(this.KEY, JSON.stringify(visits)); },

  add(data) {
    const visits = this.all();
    const visit = { ...data, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
    visits.push(visit);
    this.save(visits);
    return visit;
  },

  update(id, changes) {
    const visits = this.all();
    const i = visits.findIndex(v => v.id === id);
    if (i < 0) return null;
    visits[i] = { ...visits[i], ...changes };
    this.save(visits);
    return visits[i];
  },

  remove(id) { this.save(this.all().filter(v => v.id !== id)); },

  exportJSON() { return JSON.stringify(this.all(), null, 2); },

  importJSON(json) {
    const data = JSON.parse(json);
    if (!Array.isArray(data)) throw new Error('Vigane formaat: oodati massiivi');
    // Merge: keep existing ids, add new ones
    const existing = this.all();
    const existingIds = new Set(existing.map(v => v.id));
    const merged = [...existing, ...data.filter(v => !existingIds.has(v.id))];
    this.save(merged);
    return merged.length;
  },
};

// ── App state ──────────────────────────────────────────────────────────────
let map, visitsSource, routeSource, locationFeature;
let wmsLayers = {};
let addMode = false;
let userLocation = null; // [lon, lat] EPSG:4326
let lastClickedLonLat = null;

// ── Map initialisation ─────────────────────────────────────────────────────
function initMap() {
  // Background OSM
  const osm = new ol.layer.Tile({ source: new ol.source.OSM() });

  // WMS / WFS layers
  const wmsLayerObjects = LAYER_DEFS.map(def => {
    let layer;
    if (def.type === 'wfs') {
      layer = new ol.layer.Vector({
        source: makeWFSSource(def.typeName),
        style: def.styleFn,
        visible: def.visible,
        opacity: def.opacity,
        properties: { id: def.id, queryable: def.queryable },
      });
    } else {
      layer = new ol.layer.Tile({
        visible: def.visible,
        opacity: def.opacity,
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

  // Route layer
  routeSource = new ol.source.Vector();
  const routeLayer = new ol.layer.Vector({
    source: routeSource,
    style: new ol.style.Style({
      stroke: new ol.style.Stroke({ color: '#818cf8', width: 4, lineDash: [8, 4] }),
    }),
    zIndex: 90,
  });

  // Visit markers layer
  visitsSource = new ol.source.Vector();
  const visitsLayer = new ol.layer.Vector({
    source: visitsSource,
    zIndex: 100,
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

  map = new ol.Map({
    target: 'map',
    layers: [osm, ...wmsLayerObjects, routeLayer, visitsLayer, locationLayer],
    view: new ol.View({
      center: ol.proj.fromLonLat([25.0, 58.6]),
      zoom: 7,
    }),
  });

  map.on('singleclick', onMapClick);
}

// ── Map click handler ──────────────────────────────────────────────────────
function onMapClick(evt) {
  // Check visit marker hit first
  const feature = map.forEachFeatureAtPixel(evt.pixel, f => f, {
    layerFilter: l => l.get('id') === undefined && l.getSource() === visitsSource,
  });

  if (feature) {
    showVisitDetail(feature.get('visitId'));
    return;
  }

  if (addMode) {
    showAddVisitDialog(ol.proj.toLonLat(evt.coordinate));
    return;
  }

  lastClickedLonLat = ol.proj.toLonLat(evt.coordinate);
  queryWMSInfo(evt);
}

function queryWMSInfo(evt) {
  const view = map.getView();
  const queryableLayers = LAYER_DEFS.filter(
    def => def.queryable && wmsLayers[def.id]?.getVisible()
  );
  if (!queryableLayers.length) {
    renderFeatureInfo(null);
    return;
  }

  const def = queryableLayers[0];
  const layer = wmsLayers[def.id];
  const source = layer.getSource();
  const url = source.getFeatureInfoUrl(
    evt.coordinate,
    view.getResolution(),
    view.getProjection(),
    { INFO_FORMAT: 'application/json', FEATURE_COUNT: 5 }
  );
  if (!url) { renderFeatureInfo(null); return; }

  fetch(url)
    .then(r => r.json())
    .then(data => renderFeatureInfo(data))
    .catch(() => renderFeatureInfo(null));
}

function renderFeatureInfo(geojson) {
  const el = document.getElementById('feature-info');
  let html = '';
  if (geojson?.features?.length) {
    const props = geojson.features[0].properties;
    const rows = Object.entries(props)
      .filter(([, v]) => v !== null && v !== '')
      .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(String(v))}</td></tr>`)
      .join('');
    html += `<table>${rows}</table>`;
  } else {
    html += '<p class="empty">Antud kohas infot ei leitud.</p>';
  }
  html += `<button class="btn-sm nav-here-btn" onclick="navigateToCoord()">&#9655; Navigeeri siia</button>`;
  el.innerHTML = html;
}

// ── Layer panel ────────────────────────────────────────────────────────────
function buildLayersPanel() {
  const container = document.getElementById('layers-list');

  LAYER_DEFS.forEach(def => {
    const legendHTML = def.legend ? `
      <div class="layer-legend" id="legend-${def.id}" style="${def.visible ? '' : 'display:none'}">
        ${def.legend.map(e => `
          <span class="legend-item">
            <span class="legend-swatch ${def.type === 'wfs' && def.id === 'teatis' ? 'hatch' : ''}"
              style="color:${e.color};background:${def.id === 'teatis' ? 'transparent' : e.color}"></span>
            ${e.label}
          </span>`).join('')}
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

  container.addEventListener('change', e => {
    if (e.target.type === 'checkbox') {
      const id = e.target.dataset.id;
      wmsLayers[id]?.setVisible(e.target.checked);
      const leg = document.getElementById(`legend-${id}`);
      if (leg) leg.style.display = e.target.checked ? '' : 'none';
    }
  });
  container.addEventListener('input', e => {
    if (e.target.classList.contains('opacity-slider')) {
      wmsLayers[e.target.dataset.id]?.setOpacity(e.target.value / 100);
    }
  });
}

// ── Visit markers ──────────────────────────────────────────────────────────
function makeVisitFeature(visit) {
  const f = new ol.Feature({
    geometry: new ol.geom.Point(ol.proj.fromLonLat(visit.coords)),
    visitId: visit.id,
  });
  f.setStyle(new ol.style.Style({
    image: new ol.style.Circle({
      radius: 11,
      fill: new ol.style.Fill({ color: visit.visited ? '#22c55e' : pColor(visit.priority) }),
      stroke: new ol.style.Stroke({ color: '#fff', width: 2 }),
    }),
    text: new ol.style.Text({
      text: String(visit.priority || '?'),
      fill: new ol.style.Fill({ color: '#fff' }),
      font: 'bold 11px system-ui,sans-serif',
    }),
  }));
  return f;
}

function refreshMarkers() {
  visitsSource.clear();
  DB.all().forEach(v => visitsSource.addFeature(makeVisitFeature(v)));
}

// ── Visits list UI ─────────────────────────────────────────────────────────
function renderVisitsList() {
  const visits = DB.all().sort((a, b) => (b.priority || 0) - (a.priority || 0));
  document.getElementById('visit-count').textContent = visits.length;
  const el = document.getElementById('visits-list');

  if (!visits.length) {
    el.innerHTML = '<p class="empty">Külastusi pole. Lülita sisse lisa-režiim ja klõpsa kaardil.</p>';
    return;
  }

  el.innerHTML = visits.map(v => `
    <div class="visit-item ${v.visited ? 'visited' : ''}">
      <div class="visit-header">
        <span class="visit-priority" style="background:${pColor(v.priority)}">${v.priority || '?'}</span>
        <strong class="visit-name">${esc(v.name || 'Nimetu')}</strong>
        ${v.visited ? '<span class="badge-visited">✓</span>' : ''}
      </div>
      ${v.comment ? `<p class="visit-comment">${esc(v.comment)}</p>` : ''}
      <div class="visit-actions">
        <button class="btn-sm" onclick="zoomTo('${v.id}')">Näita</button>
        <button class="btn-sm" onclick="navigateTo('${v.id}')">Navigeeri</button>
        <button class="btn-sm" onclick="openEdit('${v.id}')">Muuda</button>
        <button class="btn-sm btn-danger" onclick="removeVisit('${v.id}')">Kustuta</button>
      </div>
    </div>
  `).join('');
}

function refresh() {
  refreshMarkers();
  renderVisitsList();
}

// ── Dialogs ────────────────────────────────────────────────────────────────
function openDialog(html) {
  document.getElementById('dialog-inner').innerHTML = html;
  document.getElementById('visit-dialog').classList.remove('hidden');
}

function closeDialog() {
  document.getElementById('visit-dialog').classList.add('hidden');
}

function priorityPickerHTML(selected = 3) {
  return `
    <label>Prioriteet
      <div class="priority-picker" id="p-picker">
        ${[1,2,3,4,5].map(n =>
          `<button type="button" class="priority-btn${n === selected ? ' selected' : ''}"
            data-p="${n}" style="background:${pColor(n)}">${n}</button>`
        ).join('')}
      </div>
    </label>`;
}

function bindPriorityPicker(initial = 3) {
  let val = initial;
  document.getElementById('p-picker').addEventListener('click', e => {
    const btn = e.target.closest('.priority-btn');
    if (!btn) return;
    val = parseInt(btn.dataset.p);
    document.querySelectorAll('.priority-btn').forEach(b => b.classList.toggle('selected', b === btn));
  });
  return { get: () => val };
}

function showAddVisitDialog(lonLat) {
  openDialog(`
    <h3>Lisa asukoht</h3>
    <label>Nimi <input type="text" id="v-name" placeholder="Metsakvartal vms"></label>
    <label>Kommentaar <textarea id="v-comment" rows="3" placeholder="Märkmed..."></textarea></label>
    ${priorityPickerHTML(3)}
    <p style="font-size:11px;color:var(--text-muted)">
      ${lonLat[1].toFixed(5)}°N, ${lonLat[0].toFixed(5)}°E
    </p>
    <div class="dialog-btns">
      <button class="primary" id="v-save">Salvesta</button>
      <button onclick="closeDialog()">Tühista</button>
    </div>
  `);

  const picker = bindPriorityPicker(3);

  document.getElementById('v-save').addEventListener('click', () => {
    DB.add({
      coords: lonLat,
      name: document.getElementById('v-name').value.trim() || 'Nimetu',
      comment: document.getElementById('v-comment').value.trim(),
      priority: picker.get(),
      visited: false,
      visitedAt: null,
    });
    closeDialog();
    refresh();
  });
}

function showVisitDetail(id) {
  const v = DB.all().find(x => x.id === id);
  if (!v) return;
  openDialog(`
    <h3>${esc(v.name || 'Nimetu')}</h3>
    <div class="dialog-meta">
      <strong>Prioriteet:</strong>
        <span style="color:${pColor(v.priority)};font-weight:700">${v.priority || '?'}</span><br>
      <strong>Kommentaar:</strong> ${esc(v.comment || '–')}<br>
      <strong>Koordinaadid:</strong> ${v.coords[1].toFixed(5)}°N, ${v.coords[0].toFixed(5)}°E<br>
      <strong>Lisatud:</strong> ${fmtDate(v.createdAt)}<br>
      ${v.visited ? `<strong>Külastatud:</strong> ${fmtDate(v.visitedAt)}` : ''}
    </div>
    <div class="dialog-btns">
      ${!v.visited ? `<button class="primary" onclick="markVisited('${id}')">Märgi külastatuks</button>` : ''}
      <button onclick="navigateTo('${id}');closeDialog()">Navigeeri</button>
      <button onclick="openEdit('${id}')">Muuda</button>
      <button class="danger" onclick="removeVisit('${id}')">Kustuta</button>
      <button onclick="closeDialog()">Sulge</button>
    </div>
  `);
}

window.openEdit = function(id) {
  const v = DB.all().find(x => x.id === id);
  if (!v) return;
  openDialog(`
    <h3>Muuda</h3>
    <label>Nimi <input type="text" id="v-name" value="${esc(v.name || '')}"></label>
    <label>Kommentaar <textarea id="v-comment" rows="3">${esc(v.comment || '')}</textarea></label>
    ${priorityPickerHTML(v.priority || 3)}
    <label style="flex-direction:row;align-items:center;gap:8px;font-size:13px;color:var(--text)">
      <input type="checkbox" id="v-visited" ${v.visited ? 'checked' : ''}> Külastatud
    </label>
    <div class="dialog-btns">
      <button class="primary" id="v-save">Salvesta</button>
      <button onclick="closeDialog()">Tühista</button>
    </div>
  `);

  const picker = bindPriorityPicker(v.priority || 3);

  document.getElementById('v-save').addEventListener('click', () => {
    const wasVisited = v.visited;
    const isVisited = document.getElementById('v-visited').checked;
    DB.update(id, {
      name: document.getElementById('v-name').value.trim() || 'Nimetu',
      comment: document.getElementById('v-comment').value.trim(),
      priority: picker.get(),
      visited: isVisited,
      visitedAt: isVisited && !wasVisited ? new Date().toISOString() : v.visitedAt,
    });
    closeDialog();
    refresh();
  });
};

window.markVisited = function(id) {
  DB.update(id, { visited: true, visitedAt: new Date().toISOString() });
  closeDialog();
  refresh();
};

window.removeVisit = function(id) {
  if (!confirm('Kustuta see asukoht?')) return;
  DB.remove(id);
  closeDialog();
  refresh();
};

window.zoomTo = function(id) {
  const v = DB.all().find(x => x.id === id);
  if (!v) return;
  map.getView().animate({ center: ol.proj.fromLonLat(v.coords), zoom: 14, duration: 600 });
};

// ── Routing ────────────────────────────────────────────────────────────────
function fetchRoute(toLonLat, label) {
  if (!userLocation) {
    alert('GPS asukoht pole saadaval. Luba brauseris asukoha kasutamine.');
    return;
  }
  const [fLon, fLat] = userLocation;
  const [tLon, tLat] = toLonLat;
  const url = `${OSRM_URL}/${fLon},${fLat};${tLon},${tLat}?overview=full&geometries=geojson`;

  fetch(url)
    .then(r => r.json())
    .then(data => {
      if (!data.routes?.[0]) { alert('Marsruuti ei leitud.'); return; }
      routeSource.clear();
      const features = new ol.format.GeoJSON().readFeatures(data.routes[0].geometry, {
        dataProjection: 'EPSG:4326',
        featureProjection: 'EPSG:3857',
      });
      routeSource.addFeatures(features);
      map.getView().fit(routeSource.getExtent(), { padding: [60, 60, 60, 60], duration: 600 });
      document.getElementById('clear-route-btn').classList.remove('hidden');

      const km = (data.routes[0].distance / 1000).toFixed(1);
      const min = Math.round(data.routes[0].duration / 60);
      openDialog(`
        <h3>Marsruut</h3>
        <div class="dialog-meta">
          <strong>Sihtpunkt:</strong> ${esc(label)}<br>
          <strong>Kaugus:</strong> ${km} km<br>
          <strong>Aeg (autoga):</strong> ~${min} min
        </div>
        <div class="dialog-btns"><button onclick="closeDialog()">Sulge</button></div>
      `);
    })
    .catch(() => alert('Marsruudi arvutamine ebaõnnestus. Kontrolli internetiühendust.'));
}

window.navigateTo = function(id) {
  const v = DB.all().find(x => x.id === id);
  if (!v) return;
  fetchRoute(v.coords, v.name || 'Nimetu');
};

window.navigateToCoord = function() {
  if (!lastClickedLonLat) return;
  const label = `${lastClickedLonLat[1].toFixed(5)}°N, ${lastClickedLonLat[0].toFixed(5)}°E`;
  fetchRoute(lastClickedLonLat, label);
};

// ── GPS ────────────────────────────────────────────────────────────────────
function startGPS() {
  if (!navigator.geolocation) {
    document.getElementById('gps-status').textContent = 'GPS: pole toetatud';
    return;
  }
  navigator.geolocation.watchPosition(
    pos => {
      userLocation = [pos.coords.longitude, pos.coords.latitude];
      locationFeature.setGeometry(new ol.geom.Point(ol.proj.fromLonLat(userLocation)));
      const acc = Math.round(pos.coords.accuracy);
      document.getElementById('gps-status').textContent =
        `GPS: ${pos.coords.latitude.toFixed(4)}°N, ${pos.coords.longitude.toFixed(4)}°E  ±${acc}m`;
    },
    () => { document.getElementById('gps-status').textContent = 'GPS: juurdepääs keelatud'; },
    { enableHighAccuracy: true, maximumAge: 5000 }
  );
}

// ── Data panel ─────────────────────────────────────────────────────────────
function bindDataPanel() {
  document.getElementById('export-btn').addEventListener('click', () => {
    const blob = new Blob([DB.exportJSON()], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: `metsaregister-${new Date().toISOString().slice(0, 10)}.json`,
    });
    a.click();
    URL.revokeObjectURL(a.href);
  });

  document.getElementById('import-file').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const count = DB.importJSON(ev.target.result);
        refresh();
        alert(`Imporditud! Kokku ${count} külastust.`);
      } catch (err) {
        alert('Import ebaõnnestus: ' + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });
}

// ── Utilities ──────────────────────────────────────────────────────────────
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(iso) {
  if (!iso) return '–';
  return new Date(iso).toLocaleString('et-EE', { dateStyle: 'short', timeStyle: 'short' });
}

// ── Bootstrap ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  buildLayersPanel();
  refresh();
  startGPS();
  bindDataPanel();

  // Add mode toggle
  document.getElementById('add-mode-btn').addEventListener('click', () => {
    addMode = !addMode;
    const btn = document.getElementById('add-mode-btn');
    btn.textContent = addMode ? '✕ Lisa-režiim sees' : '+ Lisa asukoht';
    btn.classList.toggle('active', addMode);
    map.getTargetElement().style.cursor = addMode ? 'crosshair' : '';
  });

  // Locate me
  document.getElementById('locate-btn').addEventListener('click', () => {
    if (userLocation) {
      map.getView().animate({ center: ol.proj.fromLonLat(userLocation), zoom: 14, duration: 600 });
    } else {
      alert('GPS asukoht pole veel saadaval.');
    }
  });

  // Clear route
  document.getElementById('clear-route-btn').addEventListener('click', () => {
    routeSource.clear();
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

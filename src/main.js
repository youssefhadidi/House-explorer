import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import initialModels from 'virtual:house-models';
import { analyzeHouse, levelAtHeight } from './house.js';
import { Collider, Walker, BODY, findSpot, bestYaw } from './physics.js';
import { PERIODS, solarPosition, sunTimes, sunVector, azimuthOf, cardinal, formatHour } from './sun.js';
import './style.css';

// ---------------------------------------------------------------------------
// État
// ---------------------------------------------------------------------------
const STORE_KEY = 'house-explorer:v1';
const saved = (() => {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
  } catch {
    return {};
  }
})();

const state = {
  mode: 'orbit', // 'orbit' | 'walk'
  level: -1, // étage affiché en mode maquette (-1 = tous)
  cut: saved.cut ?? true,
  cutHeight: saved.cutHeight ?? 1.2,
  labels: saved.labels ?? true,
  sun: {
    period: PERIODS.some((p) => p.id === saved.sun?.period) ? saved.sun.period : 'ete',
    hour: Number.isFinite(saved.sun?.hour) ? saved.sun.hour : 15,
    collapsed: saved.sun?.collapsed ?? false,
    playing: false,
  },
  lat: Number.isFinite(saved.lat) ? saved.lat : 46.0, // centre de la France par défaut
  lon: Number.isFinite(saved.lon) ? saved.lon : 2.0,
  orientation: Number.isFinite(saved.orientation) ? saved.orientation : 0, // azimut du haut du plan (-Z)
  models: initialModels,
  current: null, // { name, url?, file? }
  house: null,
  collider: null,
  walker: null,
  loadToken: 0,
};

function persist() {
  try {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        cut: state.cut,
        cutHeight: state.cutHeight,
        labels: state.labels,
        model: state.current?.url ?? saved.model,
        sun: { period: state.sun.period, hour: state.sun.hour, collapsed: state.sun.collapsed },
        lat: state.lat,
        lon: state.lon,
        orientation: state.orientation,
      }),
    );
  } catch {
    /* stockage indisponible : sans importance */
  }
}

const $ = (id) => document.getElementById(id);
const fmt = (n, d = 2) => n.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });

// ---------------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 0.92;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false;
$('viewport').appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(window.innerWidth, window.innerHeight);
labelRenderer.domElement.className = 'labels-layer';
$('viewport').appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
const SKY_DAY = new THREE.Color(0xe8edf1);
const SKY_DUSK = new THREE.Color(0xf1d0b0);
const SKY_NIGHT = new THREE.Color(0x1c2431);
const skyColor = SKY_DAY.clone();
const PAPER = new THREE.Color(0xf6f4ef);
scene.background = skyColor;
scene.fog = new THREE.Fog(skyColor, 60, 200);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.45;

const HEMI_DAY = new THREE.Color(0xffffff);
const HEMI_NIGHT = new THREE.Color(0x8fa3c7);
const SUN_WHITE = new THREE.Color(0xfff3e3);
const SUN_WARM = new THREE.Color(0xffa25a);
const hemi = new THREE.HemisphereLight(0xffffff, 0xc4bcae, 0.45);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff1dc, 1.9);
const sunDir = new THREE.Vector3(0.55, 0.75, -0.4).normalize(); // direction vers le soleil (calculée)
const frame = { center: new THREE.Vector3(), radius: 10 }; // emprise de la maquette, pour placer la lumière
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);

// terrain + quadrillage métrique
const ground = new THREE.Mesh(
  new THREE.CircleGeometry(1, 96),
  new THREE.MeshStandardMaterial({ color: 0xb9c2ae, roughness: 1 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
let grid = null;

// « poché » : l'intérieur des murs coupés apparaît plein et sombre, comme sur un plan
const pocheMaterial = new THREE.MeshBasicMaterial({
  color: 0x30353d,
  side: THREE.BackSide,
  polygonOffset: true,
  polygonOffsetFactor: -1,
  polygonOffsetUnits: -1,
});
let pocheMeshes = []; // affichés seulement pour les objets traversés par le plan de coupe
const cutPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);

// caméras
const orbitCam = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.05, 2000);
orbitCam.position.set(20, 16, 20);
const walkCam = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.03, 1000);
walkCam.rotation.order = 'YXZ';
const mapCam = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 200);
mapCam.up.set(0, 0, -1);
mapCam.layers.enable(1);

const controls = new OrbitControls(orbitCam, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = false; // le pan glisse sur le plan horizontal
controls.maxPolarAngle = Math.PI * 0.495;
controls.minDistance = 0.5;
controls.maxDistance = 400;

// repère du visiteur sur la mini-carte (couche 1 : invisible dans la vue principale)
const marker = new THREE.Group();
{
  const cone = new THREE.Mesh(
    new THREE.CircleGeometry(3.2, 24, Math.PI / 2 - 0.55, 1.1),
    new THREE.MeshBasicMaterial({ color: 0x2563eb, transparent: true, opacity: 0.22, depthTest: false }),
  );
  const shape = new THREE.Shape();
  shape.moveTo(0, 0.55);
  shape.lineTo(0.38, -0.4);
  shape.lineTo(0, -0.2);
  shape.lineTo(-0.38, -0.4);
  shape.closePath();
  const arrow = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ color: 0x2563eb, depthTest: false }));
  const ring = new THREE.Mesh(new THREE.CircleGeometry(0.62, 32), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
  arrow.position.z = 0.01;
  for (const m of [cone, ring, arrow]) {
    m.rotation.x = -Math.PI / 2;
    m.renderOrder = 1000;
    m.layers.set(1);
    marker.add(m);
  }
  marker.layers.set(1);
  scene.add(marker);
}

let labelsGroup = new THREE.Group();
scene.add(labelsGroup);

// ---------------------------------------------------------------------------
// Chargement des maquettes
// ---------------------------------------------------------------------------
const loader = new GLTFLoader();

function setStatus(text, loading = false) {
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('loading', loading);
}

let toastTimer;
function toast(text, error = false) {
  const el = $('toast');
  el.textContent = text;
  el.classList.toggle('error', error);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), error ? 5000 : 2600);
}

function renderModelSelect() {
  const sel = $('model-select');
  sel.innerHTML = '';
  const entries = [...state.models];
  if (state.current?.file && !entries.some((m) => m.name === state.current.name)) entries.push(state.current);
  if (!entries.length) {
    const o = document.createElement('option');
    o.textContent = 'Aucune maquette';
    o.disabled = true;
    o.selected = true;
    sel.appendChild(o);
    return;
  }
  for (const m of entries) {
    const o = document.createElement('option');
    o.value = m.url ?? `file:${m.name}`;
    o.textContent = m.file ? `${m.name} (fichier local)` : m.name;
    sel.appendChild(o);
  }
  sel.value = state.current ? (state.current.url ?? `file:${state.current.name}`) : '';
}

async function loadModel(entry, { keepView = false } = {}) {
  const token = ++state.loadToken;
  setStatus('Chargement…', true);
  try {
    let gltf;
    if (entry.file) {
      const data = await entry.file.arrayBuffer();
      gltf = await loader.parseAsync(data, '');
    } else {
      gltf = await loader.loadAsync(`${entry.url}?v=${Date.now()}`);
    }
    if (token !== state.loadToken) return; // un chargement plus récent a eu lieu
    const first = !state.house;
    state.current = entry;
    setHouse(gltf.scene, { keepView: keepView && !first });
    renderModelSelect();
    persist();
    setStatus('');
    return true;
  } catch (err) {
    console.error(err);
    if (token !== state.loadToken) return false;
    setStatus('');
    toast(`Impossible de lire ${entry.name} : ${err.message ?? err}`, true);
    return false;
  }
}

function disposeObject(root) {
  root.traverse((o) => {
    if (o.isMesh && !o.userData.poche) {
      o.geometry?.dispose();
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) m?.dispose();
    }
  });
}

function setHouse(root, { keepView }) {
  // nettoyage de la maquette précédente
  if (state.house) {
    scene.remove(state.house.root);
    disposeObject(state.house.root);
  }
  state.collider?.dispose();
  scene.remove(labelsGroup);
  labelsGroup.traverse((o) => o.isCSS2DObject && o.element.remove());

  const prevKey = state.house?.levels[state.level]?.key;
  scene.add(root);
  const house = analyzeHouse(root);
  state.house = house;

  if (!house.meshes.length) {
    toast('Cette maquette ne contient aucun objet 3D.', true);
  }

  pocheMeshes = [];
  for (const mesh of house.meshes) {
    const glass = house.info.get(mesh).kind === 'glass';
    mesh.castShadow = !glass;
    mesh.receiveShadow = true;
    if (!glass) {
      const back = new THREE.Mesh(mesh.geometry, pocheMaterial);
      back.userData.poche = true;
      back.userData.box = house.info.get(mesh).box;
      back.visible = false;
      pocheMeshes.push(back);
      back.raycast = () => {};
      mesh.add(back);
    }
  }

  // collisions
  state.collider = new Collider(house.meshes, { groundY: house.groundY });
  const walkerPos = state.walker?.feet.clone();
  const walkerYaw = state.walker?.yaw;
  const walkerPitch = state.walker?.pitch ?? 0;
  state.walker = new Walker(state.collider, BODY);

  // environnement à l'échelle de la maquette
  const box = house.box.isEmpty() ? new THREE.Box3(new THREE.Vector3(-5, 0, -5), new THREE.Vector3(5, 3, 5)) : house.box;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z, 4);
  ground.position.set(center.x, house.groundY - 0.004, center.z);
  ground.scale.setScalar(radius * 12);
  scene.fog.near = radius * 3;
  scene.fog.far = radius * 11;
  if (grid) {
    scene.remove(grid);
    grid.geometry.dispose();
    grid.material.dispose();
  }
  const gridSize = Math.ceil(Math.max(size.x, size.z) + 8);
  grid = new THREE.GridHelper(gridSize, gridSize, 0xb2b9a6, 0xbfc6b3);
  grid.material.transparent = true;
  grid.material.opacity = 0.55;
  grid.position.set(Math.round(center.x), house.groundY - 0.002, Math.round(center.z));
  scene.add(grid);

  frame.center.copy(center);
  frame.radius = radius;
  const sc = sun.shadow.camera;
  const r = size.length() / 2 + 1;
  sc.left = -r;
  sc.right = r;
  sc.top = r;
  sc.bottom = -r;
  sc.near = 0.1;
  sc.far = radius * 4 + r;
  sc.updateProjectionMatrix();

  // orientation / lieu enregistrés dans la maquette (extras de la scène glTF)
  const extras = root.userData ?? {};
  if (Number.isFinite(extras.azimut_haut)) state.orientation = extras.azimut_haut;
  if (Number.isFinite(extras.latitude)) state.lat = extras.latitude;
  if (Number.isFinite(extras.longitude)) state.lon = extras.longitude;
  syncPlaceInputs();
  applySun();

  // mini-carte : cadrée sur l'emprise de la maison
  const half = Math.max(size.x, size.z) / 2 + 1;
  mapCam.left = -half;
  mapCam.right = half;
  mapCam.top = half;
  mapCam.bottom = -half;
  mapCam.position.set(center.x, box.max.y + 20, center.z);
  mapCam.near = 1;
  mapCam.far = box.max.y - box.min.y + 60;
  mapCam.lookAt(center.x, box.min.y, center.z);
  mapCam.updateProjectionMatrix();
  const markerScale = half / 9;
  marker.scale.setScalar(Math.max(0.6, markerScale));

  // étiquettes des pièces
  labelsGroup = new THREE.Group();
  scene.add(labelsGroup);
  for (const f of house.floors) {
    const el = document.createElement('div');
    el.className = 'room-label' + (f.exterior ? ' exterior' : '');
    el.innerHTML = `<span class="name"></span><span class="area"></span>`;
    el.querySelector('.name').textContent = f.label;
    el.querySelector('.area').textContent = `${fmt(f.area, 1)} m²`;
    const obj = new CSS2DObject(el);
    obj.position.copy(f.labelPoint).add(new THREE.Vector3(0, 0.05, 0));
    obj.userData.level = f.level;
    labelsGroup.add(obj);
  }

  buildLevelButtons();

  // restaurer la vue
  const keyIndex = house.levels.findIndex((lv) => lv.key === prevKey);
  if (keepView) {
    state.level = prevKey === undefined ? -1 : keyIndex;
    if (state.mode === 'walk' && walkerPos) {
      const lvl = levelAtHeight(house, walkerPos.y);
      const spot = state.collider.isFree(walkerPos, BODY) ? walkerPos : findSpot(state.collider, house, lvl, walkerPos);
      if (spot) {
        state.walker.teleport(spot, walkerYaw);
        state.walker.pitch = walkerPitch;
      } else {
        setMode('orbit');
      }
    }
  } else {
    if (state.mode === 'walk') setMode('orbit');
    state.level = -1;
    tween = null;
    frameView(-1, false);
  }
  applyView();
}

// ---------------------------------------------------------------------------
// Étages
// ---------------------------------------------------------------------------
function buildLevelButtons() {
  const nav = $('levels');
  nav.innerHTML = '';
  const house = state.house;
  if (!house || !house.levels.length) return;
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = 'Étages';
  nav.appendChild(title);

  const all = document.createElement('button');
  all.className = 'all';
  all.dataset.level = '-1';
  all.innerHTML = '<span class="name">Toute la maison</span>';
  all.title = 'Afficher tous les étages';
  nav.appendChild(all);
  const sep = document.createElement('div');
  sep.className = 'sep';
  nav.appendChild(sep);

  for (let i = house.levels.length - 1; i >= 0; i--) {
    const lv = house.levels[i];
    const b = document.createElement('button');
    b.dataset.level = String(i);
    const sign = lv.elevation >= 0 ? '+' : '−';
    b.innerHTML = `<span class="name"></span><span class="elev">${sign}${fmt(Math.abs(lv.elevation))} m</span>`;
    b.querySelector('.name').textContent = lv.label;
    nav.appendChild(b);
  }
}

$('levels').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-level]');
  if (b) selectLevel(Number(b.dataset.level));
});

function selectLevel(i) {
  const house = state.house;
  if (!house) return;
  if (state.mode === 'walk') {
    if (i < 0) return;
    teleportToLevel(i);
    return;
  }
  state.level = Math.max(-1, Math.min(i, house.levels.length - 1));
  frameView(state.level, true);
  applyView();
}

function stepLevel(delta) {
  const house = state.house;
  if (!house) return;
  if (state.mode === 'walk') {
    const cur = currentWalkLevel();
    const next = cur + delta;
    if (next >= 0 && next < house.levels.length) teleportToLevel(next);
    return;
  }
  // maquette : « Toute la maison » est au-dessus du dernier étage
  const n = house.levels.length;
  const order = [...Array(n).keys(), -1];
  const pos = order.indexOf(state.level);
  const next = order[Math.max(0, Math.min(order.length - 1, pos + delta))];
  if (next !== state.level) selectLevel(next);
}

function setLevelVisible(lv, visible) {
  for (const o of lv.objects) o.visible = visible;
}

/** Applique la visibilité des étages, la coupe, les étiquettes et l'état de l'interface. */
function applyView() {
  const house = state.house;
  const walk = state.mode === 'walk';
  document.body.classList.toggle('mode-walk', walk);
  document.body.classList.toggle('mode-orbit', !walk);
  $('mode-orbit').classList.toggle('active', !walk);
  $('mode-walk').classList.toggle('active', walk);
  $('mode-orbit').setAttribute('aria-selected', String(!walk));
  $('mode-walk').setAttribute('aria-selected', String(walk));
  $('cut-range').classList.toggle('disabled', !state.cut);
  $('cut-value').textContent = `${fmt(state.cutHeight)} m`;
  renderHelp();
  if (!house) return;

  const sel = state.level;
  house.levels.forEach((lv, i) => setLevelVisible(lv, walk || sel < 0 || i <= sel));
  const cutOn = !walk && sel >= 0 && state.cut;
  setCut(cutOn ? house.levels[sel].elevation + state.cutHeight : null);

  const basement = !walk && sel >= 0 && house.levels[sel].elevation < house.groundY - 0.01;
  ground.visible = !basement;
  grid.visible = !walk && !basement;

  for (const obj of labelsGroup.children) {
    obj.visible = !walk && state.labels && sel >= 0 && obj.userData.level === sel;
  }
  labelRenderer.domElement.style.display = walk ? 'none' : '';

  const active = walk ? currentWalkLevel() : sel;
  for (const b of $('levels').querySelectorAll('button[data-level]')) {
    const i = Number(b.dataset.level);
    b.classList.toggle('active', i === active);
    b.hidden = walk && i < 0;
  }
  $('levels').querySelector('.sep')?.toggleAttribute('hidden', walk);
  updateHud(true);
}

function setCut(height) {
  if (height === null) {
    renderer.clippingPlanes = [];
  } else {
    cutPlane.constant = height;
    renderer.clippingPlanes = [cutPlane];
  }
  // un objet entièrement sous la coupe reste fermé : pas de remplissage (évite les
  // artefacts sur les maillages faits de morceaux superposés, comme les pans de toit)
  for (const p of pocheMeshes) {
    const b = p.userData.box;
    p.visible = height !== null && b.min.y < height && b.max.y > height;
  }
}

// ---------------------------------------------------------------------------
// Caméra maquette
// ---------------------------------------------------------------------------
let tween = null;
controls.addEventListener('start', () => (tween = null));

function frameView(levelIndex, animate) {
  const house = state.house;
  if (!house || house.box.isEmpty()) return;
  const box = house.box;
  let target;
  let extent;
  if (levelIndex < 0) {
    target = box.getCenter(new THREE.Vector3());
    extent = box.getSize(new THREE.Vector3()).length();
  } else {
    const lv = house.levels[levelIndex];
    const c = lv.box.getCenter(new THREE.Vector3());
    const s = lv.box.getSize(new THREE.Vector3());
    target = new THREE.Vector3(c.x, lv.elevation, c.z);
    extent = Math.hypot(s.x, s.z) + 1.5;
  }
  const dir = orbitCam.position.clone().sub(controls.target);
  if (dir.lengthSq() < 1e-6) dir.set(1, 1, 1);
  dir.normalize();
  const minUp = levelIndex < 0 ? 0.45 : 0.75; // vue plus plongeante pour lire un étage
  if (dir.y < minUp) {
    const h = Math.hypot(dir.x, dir.z) || 1;
    const k = Math.sqrt(1 - minUp * minUp) / h;
    dir.set(dir.x * k, minUp, dir.z * k);
  }
  const fov = THREE.MathUtils.degToRad(orbitCam.fov);
  const fit = Math.min(fov, fov * orbitCam.aspect);
  const dist = (extent * 0.55) / Math.tan(fit / 2);
  const position = target.clone().addScaledVector(dir, dist);
  if (!animate) {
    orbitCam.position.copy(position);
    controls.target.copy(target);
    controls.update();
    return;
  }
  tween = {
    t0: performance.now(),
    dur: 650,
    fromPos: orbitCam.position.clone(),
    fromTarget: controls.target.clone(),
    toPos: position,
    toTarget: target,
  };
}

function updateTween(now) {
  if (!tween) return;
  const t = Math.min(1, (now - tween.t0) / tween.dur);
  const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  orbitCam.position.lerpVectors(tween.fromPos, tween.toPos, e);
  controls.target.lerpVectors(tween.fromTarget, tween.toTarget, e);
  if (t >= 1) tween = null;
}

// ---------------------------------------------------------------------------
// Visite
// ---------------------------------------------------------------------------
let savedOrbit = null;

function currentWalkLevel() {
  const house = state.house;
  const w = state.walker;
  if (!house || !w) return 0;
  const info = w.groundMesh && house.info.get(w.groundMesh);
  if (info && info.kind === 'floor') return info.level;
  return levelAtHeight(house, w.feet.y);
}

function enterWalk(at = null) {
  const house = state.house;
  if (!house || state.collider.empty) return;
  const levelIndex = at ? levelAtHeight(house, at.feet.y) : state.level >= 0 ? state.level : house.defaultLevel;
  const spot = findSpot(state.collider, house, levelIndex, at?.feet ?? null);
  if (!spot) {
    toast('Pas de place libre pour se poser ici.', true);
    return;
  }
  savedOrbit = { pos: orbitCam.position.clone(), target: controls.target.clone(), level: state.level };
  state.walker.teleport(spot, at?.yaw ?? bestYaw(state.collider, spot));
  state.walker.pitch = 0;
  setMode('walk');
}

function teleportToLevel(i) {
  const spot = findSpot(state.collider, state.house, i);
  if (!spot) {
    toast(`Aucun sol praticable trouvé au niveau ${state.house.levels[i].label}.`, true);
    return;
  }
  state.walker.teleport(spot, bestYaw(state.collider, spot));
  state.walker.pitch = 0;
  applyView();
}

function setMode(mode) {
  if (mode === state.mode) return;
  if (mode === 'walk') {
    state.mode = 'walk';
    controls.enabled = false;
    tween = null;
    requestLock();
  } else {
    state.mode = 'orbit';
    controls.enabled = true;
    if (document.pointerLockElement) document.exitPointerLock();
    keys.clear();
    // on revient sur l'étage où l'on se trouvait
    const lvl = state.house ? currentWalkLevel() : -1;
    if (savedOrbit) {
      orbitCam.position.copy(savedOrbit.pos);
      controls.target.copy(savedOrbit.target);
    }
    state.level = lvl;
    frameView(lvl, true);
  }
  applyView();
}

function toggleMode() {
  if (state.mode === 'walk') setMode('orbit');
  else enterWalk();
}

$('mode-orbit').addEventListener('click', () => setMode('orbit'));
$('mode-walk').addEventListener('click', () => state.mode !== 'walk' && enterWalk());

// --- souris : regard ------------------------------------------------------
function requestLock() {
  const p = renderer.domElement.requestPointerLock?.();
  if (p && typeof p.catch === 'function') p.catch(() => {}); // refus : on reste en « glisser pour regarder »
}

let unlockedAt = 0;
document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === renderer.domElement;
  document.body.classList.toggle('locked', locked);
  if (!locked) unlockedAt = performance.now();
});

let dragLook = false;
renderer.domElement.addEventListener('pointerdown', (e) => {
  // un curseur ou bouton du panneau garde sinon le focus et capterait les flèches
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  if (state.mode !== 'walk') return;
  if (!document.pointerLockElement) {
    requestLock();
    dragLook = true;
  }
});
window.addEventListener('pointerup', () => (dragLook = false));
window.addEventListener('mousemove', (e) => {
  if (state.mode !== 'walk') return;
  const locked = document.pointerLockElement === renderer.domElement;
  if (!locked && !dragLook) return;
  const w = state.walker;
  w.yaw -= e.movementX * 0.0022;
  w.pitch = THREE.MathUtils.clamp(w.pitch - e.movementY * 0.0022, -1.45, 1.45);
});

// --- clavier ---------------------------------------------------------------
const keys = new Set();
const isTyping = (e) => /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== 'checkbox' && e.target.type !== 'range';

window.addEventListener('keydown', (e) => {
  if (isTyping(e)) return;
  if (e.code === 'Tab') {
    e.preventDefault();
    toggleMode();
    return;
  }
  if (e.code === 'PageUp') {
    e.preventDefault();
    stepLevel(+1);
    return;
  }
  if (e.code === 'PageDown') {
    e.preventDefault();
    stepLevel(-1);
    return;
  }
  // 1er Échap : le navigateur libère la souris ; 2e Échap : retour à la maquette
  if (e.key === '+' || e.key === '-') {
    if (state.sun.playing) setPlaying(false);
    setSunHour(state.sun.hour + (e.key === '+' ? 0.5 : -0.5));
    return;
  }
  if (e.key.toLowerCase() === 'h' && !e.ctrlKey && !e.metaKey) {
    $('help').hidden = !$('help').hidden;
    return;
  }
  if (e.key === 'Escape' && state.mode === 'walk' && !document.pointerLockElement && performance.now() - unlockedAt > 400) {
    setMode('orbit');
    return;
  }
  if (state.mode === 'walk') {
    if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    keys.add(e.code);
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

function readInput() {
  const k = (...codes) => codes.some((c) => keys.has(c));
  // e.code = position physique : ZQSD sur AZERTY, WASD sur QWERTY
  return {
    forward: (k('KeyW', 'ArrowUp') ? 1 : 0) - (k('KeyS', 'ArrowDown') ? 1 : 0),
    right: (k('KeyD') ? 1 : 0) - (k('KeyA') ? 1 : 0),
    turn: (k('ArrowLeft') ? 1 : 0) - (k('ArrowRight') ? 1 : 0),
    run: k('ShiftLeft', 'ShiftRight'),
  };
}

// --- double-clic sur un sol en maquette : on entre en visite à cet endroit ---
const raycaster = new THREE.Raycaster();
function isShown(o) {
  for (let p = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}
renderer.domElement.addEventListener('dblclick', (e) => {
  if (state.mode !== 'orbit' || !state.house) return;
  const ndc = new THREE.Vector2((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, orbitCam);
  const cutY = renderer.clippingPlanes.length ? cutPlane.constant : Infinity;
  const hits = raycaster
    .intersectObjects(state.house.meshes, false)
    .filter((h) => h.point.y <= cutY && isShown(h.object) && state.house.info.get(h.object).kind !== 'glass');
  const hit = hits[0];
  const normal = hit?.face?.normal.clone().transformDirection(hit.object.matrixWorld);
  if (!hit || Math.abs(normal.y) < 0.7) {
    toast('Double-cliquez sur un sol pour commencer la visite à cet endroit.');
    return;
  }
  const look = new THREE.Vector3();
  orbitCam.getWorldDirection(look);
  enterWalk({ feet: hit.point.clone(), yaw: Math.atan2(-look.x, -look.z) });
});

// --- mini-carte -------------------------------------------------------------
$('minimap').addEventListener('click', (e) => {
  if (state.mode !== 'walk' || !state.house) return;
  const r = e.currentTarget.getBoundingClientRect();
  const u = (e.clientX - r.left) / r.width;
  const v = (e.clientY - r.top) / r.height;
  const x = mapCam.position.x + mapCam.left + u * (mapCam.right - mapCam.left);
  const z = mapCam.position.z - mapCam.top + v * (mapCam.top - mapCam.bottom);
  const lvl = currentWalkLevel();
  const near = new THREE.Vector3(x, state.house.levels[lvl].elevation, z);
  const spot = findSpot(state.collider, state.house, lvl, near);
  if (!spot) {
    toast('Endroit inaccessible.');
    return;
  }
  state.walker.teleport(spot);
});

function minimapRect() {
  const el = $('minimap');
  const r = el.getBoundingClientRect();
  return { x: r.left, y: window.innerHeight - r.bottom, w: r.width, h: r.height };
}

function renderMinimap() {
  const house = state.house;
  const w = state.walker;
  const lvl = currentWalkLevel();
  const lv = house.levels[lvl];
  const rect = minimapRect();
  if (rect.w < 10) return;

  marker.position.set(w.feet.x, lv.elevation + 0.3, w.feet.z);
  marker.rotation.y = w.yaw;

  house.levels.forEach((l, i) => setLevelVisible(l, i <= lvl));
  setCut(lv.elevation + 1.2);
  const groundWas = ground.visible;
  ground.visible = lv.elevation >= house.groundY - 0.01;
  scene.background = PAPER;
  // le plan reste lisible même la nuit
  const hemiWas = hemi.intensity;
  const envWas = scene.environmentIntensity;
  hemi.intensity = Math.max(hemiWas, 0.45);
  scene.environmentIntensity = Math.max(envWas, 0.45);

  renderer.setScissorTest(true);
  renderer.setViewport(rect.x, rect.y, rect.w, rect.h);
  renderer.setScissor(rect.x, rect.y, rect.w, rect.h);
  renderer.render(scene, mapCam);
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);

  scene.background = skyColor;
  hemi.intensity = hemiWas;
  scene.environmentIntensity = envWas;
  ground.visible = groundWas;
  house.levels.forEach((l) => setLevelVisible(l, true));
  setCut(null);
  $('minimap-label').textContent = lv.label;
}

// --- HUD ----------------------------------------------------------------------
let hudKey = '';
function updateHud(force = false) {
  if (state.mode !== 'walk' || !state.house) return;
  const house = state.house;
  const w = state.walker;
  const lvl = currentWalkLevel();
  const info = w.groundMesh ? house.info.get(w.groundMesh) : null;
  const room = info ? info.label : 'Extérieur';
  const key = `${lvl}|${room}`;
  if (!force && key === hudKey) return;
  const levelChanged = hudKey.split('|')[0] !== String(lvl);
  hudKey = key;
  $('hud-level').textContent = house.levels[lvl]?.label ?? '';
  $('hud-room').textContent = room;
  if (levelChanged) {
    for (const b of $('levels').querySelectorAll('button[data-level]')) b.classList.toggle('active', Number(b.dataset.level) === lvl);
  }
}

// --- aide contextuelle --------------------------------------------------------
function renderHelp() {
  const help = $('help');
  help.innerHTML =
    state.mode === 'walk'
      ? `<b>Visite</b> · <kbd>Z</kbd><kbd>Q</kbd><kbd>S</kbd><kbd>D</kbd> (WASD) ou <kbd>↑</kbd><kbd>↓</kbd> se déplacer · <kbd>←</kbd><kbd>→</kbd> tourner · souris : regarder<br>
         <kbd>Maj</kbd> courir · <kbd>PgPréc</kbd>/<kbd>PgSuiv</kbd> changer d'étage · clic sur le plan : s'y rendre<br>
         <kbd>Échap</kbd> libérer la souris, 2<sup>e</sup> <kbd>Échap</kbd> ou <kbd>Tab</kbd> : retour à la maquette<br>
         <kbd>+</kbd>/<kbd>−</kbd> heure du soleil · <kbd>H</kbd> masquer l'aide`
      : `<b>Maquette</b> · glisser : tourner · clic droit : déplacer · molette : zoom<br>
         <b>Double-clic sur un sol</b> : visiter depuis cet endroit · <kbd>Tab</kbd> visite<br>
         <kbd>PgPréc</kbd>/<kbd>PgSuiv</kbd> changer d'étage · <kbd>+</kbd>/<kbd>−</kbd> heure du soleil · <kbd>H</kbd> masquer l'aide<br>
         glissez un .glb ici pour l'ouvrir`;
}

// ---------------------------------------------------------------------------
// Soleil : période de l'année + heure légale -> position, couleur et intensité
// ---------------------------------------------------------------------------
const HOUR_MIN = 5;
const HOUR_MAX = 22.5;
let sunState = { altitude: 45, azimuth: 180 };
let compassKey = '';

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const currentPeriod = () => PERIODS.find((p) => p.id === state.sun.period) ?? PERIODS[2];

function applySun() {
  const p = currentPeriod();
  const pos = solarPosition({ day: p.day, utc: p.utc, lat: state.lat, lon: state.lon, hour: state.sun.hour });
  sunState = pos;
  const alt = pos.altitude;
  // sous l'horizon la lumière est éteinte ; on garde une direction rasante valide pour l'ombre
  sunVector(Math.max(alt, 2), pos.azimuth, state.orientation, sunDir);

  const day = smoothstep(-6, 8, alt); // lumière du ciel (crépuscule -> jour)
  const low = 1 - smoothstep(4, 28, alt); // soleil bas : teinte chaude
  sun.intensity = 2.0 * smoothstep(-0.5, 10, alt);
  sun.color.copy(SUN_WHITE).lerp(SUN_WARM, low);
  hemi.intensity = 0.18 + 0.27 * day;
  hemi.color.copy(HEMI_NIGHT).lerp(HEMI_DAY, day);
  scene.environmentIntensity = 0.15 + 0.3 * day;
  skyColor.copy(SKY_NIGHT).lerp(SKY_DAY, day).lerp(SKY_DUSK, low * day * 0.55);
  scene.fog.color.copy(skyColor);
  if (grid) grid.material.opacity = 0.1 + 0.45 * day; // les lignes ne sont pas éclairées : on les estompe la nuit
  sun.position.copy(frame.center).addScaledVector(sunDir, frame.radius * 2);
  sun.target.position.copy(frame.center);
  updateSunUi();
}

function updateSunUi() {
  const p = currentPeriod();
  const { altitude, azimuth } = sunState;
  const up = altitude > -0.833; // bord supérieur du disque au-dessus de l'horizon
  $('sun-time').textContent = formatHour(state.sun.hour);
  const slider = $('sun-hour');
  if (document.activeElement !== slider || state.sun.playing) slider.value = String(state.sun.hour);
  slider.classList.toggle('night', !up);
  for (const b of $('sun-periods').children) b.setAttribute('aria-checked', String(b.dataset.period === p.id));

  // piste du curseur : nuit / jour, plus lumineuse vers midi
  const t = sunTimes({ day: p.day, utc: p.utc, lat: state.lat, lon: state.lon });
  const pct = (h) => Math.min(100, Math.max(0, ((h - HOUR_MIN) / (HOUR_MAX - HOUR_MIN)) * 100)).toFixed(1);
  const NIGHT = '#475569';
  if (t.polar === 'jour') slider.style.background = '#fcd34d';
  else if (t.polar === 'nuit') slider.style.background = NIGHT;
  else {
    const a = pct(t.sunrise);
    const n = pct(t.noon);
    const b = pct(t.sunset);
    slider.style.background = `linear-gradient(90deg, ${NIGHT} 0%, ${NIGHT} ${a}%, #fde68a ${a}%, #fbbf24 ${n}%, #fde68a ${b}%, ${NIGHT} ${b}%, ${NIGHT} 100%)`;
  }

  const line1 = up
    ? `Hauteur <b>${fmt(altitude, 0)}°</b> · direction <b>${cardinal(azimuth)}</b> (${Math.round(azimuth)}°)`
    : `<b>Nuit</b> · soleil sous l'horizon`;
  const line2 = t.polar
    ? t.polar === 'jour'
      ? 'Soleil toute la journée'
      : 'Pas de lever de soleil'
    : `Lever <b>${formatHour(t.sunrise)}</b> · midi <b>${formatHour(t.noon)}</b> · coucher <b>${formatHour(t.sunset)}</b>`;
  $('sun-info').innerHTML = `${line1}<br>${line2}`;
  $('minimap-north').style.transform = `rotate(${-state.orientation}deg)`;
  compassKey = '';
}

function setSunHour(h) {
  state.sun.hour = Math.min(HOUR_MAX, Math.max(HOUR_MIN, h));
  persist();
  applySun();
}

function setPlaying(on) {
  state.sun.playing = on;
  $('sun-play').classList.toggle('playing', on);
  $('sun-play').title = on ? 'Arrêter' : 'Animer la journée';
  if (!on) {
    state.sun.hour = Math.round(state.sun.hour * 4) / 4;
    persist();
    applySun();
  }
}

function syncPlaceInputs() {
  const set = (id, v) => {
    if (document.activeElement !== $(id)) $(id).value = String(Math.round(v * 100) / 100);
  };
  set('sun-lat', state.lat);
  set('sun-lon', state.lon);
  set('sun-orient', state.orientation);
}

for (const p of PERIODS) {
  const b = document.createElement('button');
  b.setAttribute('role', 'radio');
  b.dataset.period = p.id;
  b.innerHTML = `<span class="p">${p.label}</span><span class="d">${p.date}</span>`;
  b.title = `${p.label} — ${p.date} (heure légale UTC+${p.utc})`;
  b.addEventListener('click', () => {
    state.sun.period = p.id;
    persist();
    applySun();
  });
  $('sun-periods').appendChild(b);
}
$('sun-hour').addEventListener('input', (e) => {
  if (state.sun.playing) setPlaying(false);
  setSunHour(Number(e.target.value));
});
$('sun-play').addEventListener('click', () => setPlaying(!state.sun.playing));
$('sun-toggle').addEventListener('click', () => {
  state.sun.collapsed = !state.sun.collapsed;
  $('sun-panel').classList.toggle('collapsed', state.sun.collapsed);
  $('sun-toggle').setAttribute('aria-expanded', String(!state.sun.collapsed));
  persist();
});
$('sun-panel').classList.toggle('collapsed', state.sun.collapsed);
$('sun-toggle').setAttribute('aria-expanded', String(!state.sun.collapsed));

for (const [id, key, min, max] of [
  ['sun-lat', 'lat', -89, 89],
  ['sun-lon', 'lon', -180, 180],
  ['sun-orient', 'orientation', -360, 360],
]) {
  $(id).addEventListener('change', (e) => {
    const v = parseFloat(String(e.target.value).replace(',', '.'));
    if (Number.isFinite(v)) state[key] = key === 'orientation' ? ((v % 360) + 360) % 360 : Math.min(max, Math.max(min, v));
    syncPlaceInputs();
    persist();
    applySun();
  });
}

// --- boussole : nord et soleil vus depuis la caméra active ------------------
const _look = new THREE.Vector3();
function updateCompass() {
  const cam = state.mode === 'walk' && state.house ? walkCam : orbitCam;
  cam.getWorldDirection(_look);
  // regard presque vertical : on prend le haut de l'écran comme cap
  if (Math.hypot(_look.x, _look.z) < 0.08) _look.set(0, 1, 0).applyQuaternion(cam.quaternion);
  const heading = azimuthOf(_look.x, _look.z, state.orientation);
  const below = sunState.altitude <= -0.833;
  const key = `${heading.toFixed(1)}|${sunState.azimuth.toFixed(1)}|${below}`;
  if (key === compassKey) return;
  compassKey = key;
  $('compass-rose').setAttribute('transform', `rotate(${(-heading).toFixed(2)})`);
  $('compass-sun').setAttribute('transform', `rotate(${sunState.azimuth.toFixed(2)})`);
  $('compass-sun').classList.toggle('below', below);
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------
$('opt-cut').checked = state.cut;
$('opt-labels').checked = state.labels;
$('opt-cut-height').value = String(state.cutHeight);
$('opt-cut').addEventListener('change', (e) => {
  state.cut = e.target.checked;
  persist();
  applyView();
});
$('opt-cut-height').addEventListener('input', (e) => {
  state.cutHeight = Number(e.target.value);
  persist();
  applyView();
});
$('opt-labels').addEventListener('change', (e) => {
  state.labels = e.target.checked;
  persist();
  applyView();
});

// ---------------------------------------------------------------------------
// Choix de la maquette, ouverture de fichier, glisser-déposer, rechargement auto
// ---------------------------------------------------------------------------
$('model-select').addEventListener('change', (e) => {
  const v = e.target.value;
  const entry = state.models.find((m) => m.url === v) ?? (state.current?.file && `file:${state.current.name}` === v ? state.current : null);
  if (entry) loadModel(entry);
  e.target.blur();
});
$('open-file').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) loadModel({ name: file.name, file });
  e.target.value = '';
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('dragging');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const file = [...(e.dataTransfer?.files ?? [])].find((f) => /\.(glb|gltf)$/i.test(f.name));
  if (!file) {
    toast('Seuls les fichiers .glb et .gltf sont pris en charge.', true);
    return;
  }
  loadModel({ name: file.name, file });
});

if (import.meta.hot) {
  import.meta.hot.on('house:models', ({ kind, changed, list }) => {
    state.models = list;
    renderModelSelect();
    if (kind === 'change' && state.current?.url === changed) {
      loadModel(state.current, { keepView: true }).then((ok) => ok && toast(`${state.current.name} mis à jour`));
    } else if (kind === 'add' && !state.current) {
      const entry = list.find((m) => m.url === changed);
      if (entry) loadModel(entry);
    }
  });
}

// ---------------------------------------------------------------------------
// Boucle
// ---------------------------------------------------------------------------
window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  labelRenderer.setSize(w, h);
  for (const cam of [orbitCam, walkCam]) {
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
  }
});

let last = performance.now();
renderer.setAnimationLoop((now) => {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const walk = state.mode === 'walk' && state.house;

  if (state.sun.playing) {
    // ~1 h 12 de journée par seconde, en boucle
    let h = state.sun.hour + dt * 1.2;
    if (h > HOUR_MAX) h = HOUR_MIN;
    state.sun.hour = h;
    applySun();
  }

  if (walk) {
    const w = state.walker;
    w.update(dt, readInput());
    if (w.feet.y < state.house.box.min.y - 20) teleportToLevel(state.house.defaultLevel); // chute dans le vide
    walkCam.position.set(w.feet.x, w.eyeY, w.feet.z);
    walkCam.rotation.set(w.pitch, w.yaw, 0);
    updateHud();
  } else {
    updateTween(now);
    controls.update();
  }

  renderer.shadowMap.needsUpdate = true;
  renderer.render(scene, walk ? walkCam : orbitCam);
  if (walk) renderMinimap();
  else labelRenderer.render(scene, orbitCam);
  updateCompass();
});

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------
renderModelSelect();
syncPlaceInputs();
applySun();
applyView();
{
  const preferred = state.models.find((m) => m.url === saved.model) ?? state.models[0];
  if (preferred) loadModel(preferred);
  else setStatus('Glissez un fichier .glb ou .gltf dans la fenêtre');
}

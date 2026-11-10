// Analyse d'une maquette glTF : niveaux, sols / pièces, escaliers, vitrages.
// Aucune dépendance au DOM (testable sous Node).
//
// Conventions reconnues (celles de maison.gltf) :
//   - un nœud par niveau nommé `niveau-<clé>`  (niveau-S, niveau-0, niveau-1…)
//   - les sols d'un niveau sont nommés `<clé>-<pièce>`  (0-salon, 1-suite-parentale…)
//   - escaliers : nom ou matériau contenant « escalier »
//   - vitrages : matériau transparent
// Sans ces conventions, la maquette est traitée comme un niveau unique et les
// sols sont devinés par leur forme (dalles fines et larges).

import * as THREE from 'three';

const LEVEL_RE = /^niveau[\s_-]*(.+)$/i;
const STAIR_RE = /escalier|stair/i;
const EXTERIOR_RE = /toit|terrasse|balcon|loggia|ext[ée]rieur|jardin|cour\b|pergola/i;
const ANNEX_RE = /garage|cave|local|cellier|buanderie|annexe|chaufferie|grenier/i;

export function levelLabel(key) {
  const k = String(key).trim();
  if (/^(s|ss|sous[\s_-]?sol)$/i.test(k)) return 'Sous-sol';
  if (/^(0|rdc|r0)$/i.test(k)) return 'RDC';
  if (/^\d+$/.test(k)) return `R+${k}`;
  if (/^-\d+$/.test(k)) return `R${k}`;
  if (/^(c|combles?)$/i.test(k)) return 'Combles';
  if (/^(t|toit|toiture)$/i.test(k)) return 'Toiture';
  return k.toUpperCase();
}

export function prettyName(raw) {
  const s = String(raw).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function materialsOf(mesh) {
  return (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).filter(Boolean);
}

export function isGlass(mesh) {
  const mats = materialsOf(mesh);
  return mats.length > 0 && mats.every((m) => m.transparent || m.opacity < 0.99);
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

/** Appelle cb(a, b, c) pour chaque triangle du mesh, en coordonnées monde (vecteurs réutilisés). */
export function forEachWorldTriangle(mesh, cb) {
  const geo = mesh.geometry;
  const pos = geo?.attributes?.position;
  if (!pos) return;
  const index = geo.index;
  const count = index ? index.count : pos.count;
  const m = mesh.matrixWorld;
  for (let i = 0; i + 2 < count; i += 3) {
    const ia = index ? index.getX(i) : i;
    const ib = index ? index.getX(i + 1) : i + 1;
    const ic = index ? index.getX(i + 2) : i + 2;
    _a.fromBufferAttribute(pos, ia).applyMatrix4(m);
    _b.fromBufferAttribute(pos, ib).applyMatrix4(m);
    _c.fromBufferAttribute(pos, ic).applyMatrix4(m);
    cb(_a, _b, _c);
  }
}

/**
 * Surface du dessus d'une dalle ou d'un pan de toit (m², pente comprise) et point d'étiquette.
 * L'emprise est quadrillée (~3 cm) ; pour chaque case on garde la face la plus haute.
 * Robuste aux pièces en L, aux pans inclinés, aux morceaux superposés et au sens des faces.
 */
function topSurface(mesh, box) {
  const tris = [];
  forEachWorldTriangle(mesh, (a, b, c) => {
    const e1x = b.x - a.x, e1y = b.y - a.y, e1z = b.z - a.z;
    const e2x = c.x - a.x, e2y = c.y - a.y, e2z = c.z - a.z;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) return;
    const k = Math.abs(ny) / len;
    if (k < 0.5) return; // faces verticales ou trop pentues (> 60°)
    tris.push([a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, 1 / k]);
  });

  const x0 = box.min.x;
  const z0 = box.min.z;
  const sx = box.max.x - x0;
  const sz = box.max.z - z0;
  let cell = 0.03;
  while ((sx / cell) * (sz / cell) > 4e5) cell *= 1.5;
  const nx = Math.max(1, Math.ceil(sx / cell));
  const nz = Math.max(1, Math.ceil(sz / cell));
  const top = new Float32Array(nx * nz).fill(-Infinity);
  const weight = new Float32Array(nx * nz); // 1/cos(pente) de la face la plus haute

  for (const [ax, ay, az, bx, by, bz, cx, cy, cz, inv] of tris) {
    const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(det) < 1e-12) continue;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - x0) / cell));
    const i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx, cx) - x0) / cell));
    const j0 = Math.max(0, Math.floor((Math.min(az, bz, cz) - z0) / cell));
    const j1 = Math.min(nz - 1, Math.floor((Math.max(az, bz, cz) - z0) / cell));
    for (let j = j0; j <= j1; j++) {
      const pz = z0 + (j + 0.5) * cell;
      for (let i = i0; i <= i1; i++) {
        const px = x0 + (i + 0.5) * cell;
        const l1 = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / det;
        const l2 = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / det;
        const l3 = 1 - l1 - l2;
        if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
        const y = l1 * ay + l2 * by + l3 * cy;
        const idx = j * nx + i;
        if (y > top[idx]) {
          top[idx] = y;
          weight[idx] = inv;
        }
      }
    }
  }

  let area = 0;
  let sumX = 0;
  let sumZ = 0;
  let count = 0;
  for (let idx = 0; idx < weight.length; idx++) {
    if (!weight[idx]) continue;
    area += weight[idx];
    sumX += idx % nx;
    sumZ += Math.floor(idx / nx);
    count++;
  }
  area *= cell * cell;
  if (!count) return { area: 0, label: box.getCenter(new THREE.Vector3()).setY(box.max.y) };

  // étiquette au barycentre ; s'il tombe hors de la dalle (pièce en L), case couverte la plus proche
  let ci = Math.round(sumX / count - 0.5);
  let cj = Math.round(sumZ / count - 0.5);
  if (!weight[cj * nx + ci]) {
    let best = Infinity;
    for (let idx = 0; idx < weight.length; idx++) {
      if (!weight[idx]) continue;
      const d = (idx % nx - ci) ** 2 + (Math.floor(idx / nx) - cj) ** 2;
      if (d < best) {
        best = d;
        ci = idx % nx;
        cj = Math.floor(idx / nx);
      }
    }
  }
  const label = new THREE.Vector3(x0 + (ci + 0.5) * cell, top[cj * nx + ci], z0 + (cj + 0.5) * cell);
  return { area, label };
}

/**
 * @returns {{
 *   root: THREE.Object3D, box: THREE.Box3, groundY: number, defaultLevel: number,
 *   meshes: THREE.Mesh[], floors: object[],
 *   levels: {key:string,label:string,objects:THREE.Object3D[],meshes:THREE.Mesh[],box:THREE.Box3,elevation:number,floors:object[]}[],
 *   info: Map<THREE.Mesh, {kind:'floor'|'stair'|'glass'|'wall', label:string, level:number, area?:number, labelPoint?:THREE.Vector3}>
 * }}
 */
export function analyzeHouse(root) {
  root.updateMatrixWorld(true);

  const meshes = [];
  root.traverse((o) => {
    if (o.isMesh) meshes.push(o);
  });

  // --- niveaux -------------------------------------------------------------
  const levelNodes = new Map(); // node -> key
  root.traverse((o) => {
    const m = o.name && o.name.match(LEVEL_RE);
    if (!m) return;
    for (let p = o.parent; p; p = p.parent) if (levelNodes.has(p)) return; // niveau imbriqué : ignoré
    levelNodes.set(o, m[1]);
  });

  const levels = [];
  const levelOfMesh = new Map();
  if (levelNodes.size === 0) {
    levels.push({ key: '', label: 'Maison', objects: [root], meshes: [...meshes] });
    meshes.forEach((m) => levelOfMesh.set(m, levels[0]));
  } else {
    for (const [node, key] of levelNodes) {
      const lv = { key, label: levelLabel(key), objects: [node], meshes: [] };
      node.traverse((o) => {
        if (o.isMesh) {
          lv.meshes.push(o);
          levelOfMesh.set(o, lv);
        }
      });
      levels.push(lv);
    }
  }

  // --- classification des meshes --------------------------------------------
  const conventionUsed = meshes.some((m) => {
    const lv = levelOfMesh.get(m);
    const nm = m.name.match(/^([^-_\s]+)[-_](.+)$/);
    return lv && lv.key && nm && nm[1].toLowerCase() === lv.key.toLowerCase();
  });

  const info = new Map();
  const box = new THREE.Box3();
  const size = new THREE.Vector3();
  for (const mesh of meshes) {
    const lv = levelOfMesh.get(mesh);
    const mbox = new THREE.Box3().setFromObject(mesh);
    mbox.getSize(size);
    const name = mesh.name || '';
    const nm = name.match(/^([^-_\s]+)[-_](.+)$/);
    const prefixOk = !!(lv && lv.key && nm && nm[1].toLowerCase() === lv.key.toLowerCase());
    const rest = prefixOk ? nm[2] : name;
    const matNames = materialsOf(mesh).map((m) => m.name || '').join(' ');

    let entry;
    if (isGlass(mesh)) {
      entry = { kind: 'glass', label: prettyName(rest || 'Vitrage') };
    } else if (STAIR_RE.test(matNames) || (STAIR_RE.test(name) && size.y > 0.6)) {
      // une dalle fine nommée « …escalier-sol » reste un sol
      entry = { kind: 'stair', label: STAIR_RE.test(rest) ? prettyName(rest) : `Escalier (${rest.replace(/[-_]+/g, ' ')})` };
    } else if (
      (prefixOk && size.y <= 0.6) ||
      (!conventionUsed && size.y <= 0.35 && size.x >= 1 && size.z >= 1)
    ) {
      const top = topSurface(mesh, mbox);
      const tag = `${name} ${matNames}`;
      entry = {
        kind: 'floor',
        label: prettyName(rest || 'Sol'),
        area: top.area,
        labelPoint: top.label,
        topY: mbox.max.y,
        exterior: EXTERIOR_RE.test(tag),
        annex: ANNEX_RE.test(tag),
      };
    } else {
      entry = { kind: 'wall', label: name };
    }
    entry.mesh = mesh;
    entry.box = mbox;
    info.set(mesh, entry);
  }

  // --- géométrie des niveaux --------------------------------------------------
  for (const lv of levels) {
    lv.box = new THREE.Box3();
    lv.meshes.forEach((m) => lv.box.union(info.get(m).box));
    lv.floors = lv.meshes.map((m) => info.get(m)).filter((e) => e.kind === 'floor').sort((a, b) => b.area - a.area);
    // altitude du plancher = dessus de la plus grande dalle intérieure (pas une terrasse ni un toit)
    const interior = lv.floors.filter((f) => !f.exterior);
    const ref = interior[0] ?? lv.floors[0];
    lv.elevation = ref ? ref.topY : lv.box.min.y;
    // ordre de préférence pour apparaître : pièces de vie, puis annexes, puis extérieur
    const rank = (f) => (f.exterior ? 2 : f.annex ? 1 : 0);
    lv.spawnFloors = [...lv.floors].sort((a, b) => rank(a) - rank(b) || b.area - a.area);
    box.union(lv.box);
  }
  levels.sort((a, b) => a.elevation - b.elevation);
  levels.forEach((lv, i) => {
    lv.index = i;
    lv.meshes.forEach((m) => (info.get(m).level = i));
  });

  // niveau par défaut : RDC, sinon celui dont le plancher est le plus proche de 0
  let defaultLevel = levels.findIndex((lv) => /^(0|rdc|r0)$/i.test(lv.key));
  if (defaultLevel < 0) {
    defaultLevel = 0;
    levels.forEach((lv, i) => {
      if (Math.abs(lv.elevation) < Math.abs(levels[defaultLevel].elevation)) defaultLevel = i;
    });
  }

  // terrain naturel : sous-face des dalles du RDC
  const rdc = levels[defaultLevel];
  const groundY = rdc && rdc.floors.length ? Math.min(...rdc.floors.map((f) => f.box.min.y)) : box.isEmpty() ? 0 : box.min.y;

  const floors = levels.flatMap((lv) => lv.floors);
  return { root, box, groundY, defaultLevel, meshes, floors, levels, info };
}

/** Index du niveau dans lequel se trouve un point (altitude des pieds). */
export function levelAtHeight(house, y) {
  let idx = 0;
  house.levels.forEach((lv, i) => {
    if (y >= lv.elevation - 0.35) idx = i;
  });
  return idx;
}

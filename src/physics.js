// Déplacement à la première personne : collisions capsule/maquette (three-mesh-bvh),
// suivi du sol (marches d'escalier), gravité. Aucune dépendance au DOM.

import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import { forEachWorldTriangle } from './house.js';

/** Gabarit du visiteur (mètres). La capsule commence à `stepUp` au-dessus des pieds :
 *  tout obstacle plus bas (marche, seuil) est franchi, le reste bloque. */
export const BODY = {
  radius: 0.22,
  height: 1.7,
  eye: 1.6,
  stepUp: 0.45, // permet d'aborder un escalier par le côté (2e marche)
  stepDown: 0.5,
  walkSpeed: 1.4, // pas normal à l'intérieur (m/s)
  runSpeed: 3.6,
  turnSpeed: 2.0,
  gravity: 9.81,
};

const DOWN = new THREE.Vector3(0, -1, 0);

export class Collider {
  /** @param {THREE.Mesh[]} meshes  @param {{groundY?: number|null}} opts */
  constructor(meshes, { groundY = null } = {}) {
    this.groundY = groundY;
    this.ranges = []; // plages de sommets -> mesh d'origine
    const chunks = [];
    let vertexCount = 0;
    for (const mesh of meshes) {
      if (!mesh.isMesh || mesh.isInstancedMesh || mesh.isSkinnedMesh) continue;
      const arr = [];
      forEachWorldTriangle(mesh, (a, b, c) => arr.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z));
      if (!arr.length) continue;
      this.ranges.push({ start: vertexCount, end: vertexCount + arr.length / 3, mesh });
      vertexCount += arr.length / 3;
      chunks.push(arr);
    }
    const positions = new Float32Array(vertexCount * 3);
    let offset = 0;
    for (const c of chunks) {
      positions.set(c, offset);
      offset += c.length;
    }
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.empty = vertexCount === 0;
    if (!this.empty) {
      this.bvh = new MeshBVH(this.geometry);
      this.geometry.boundsTree = this.bvh;
    }
    this.mesh = new THREE.Mesh(this.geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    this.mesh.raycast = acceleratedRaycast;
    this.raycaster = new THREE.Raycaster();
    this.raycaster.firstHitOnly = true;

    this._seg = new THREE.Line3();
    this._box = new THREE.Box3();
    this._triPoint = new THREE.Vector3();
    this._capPoint = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._origin = new THREE.Vector3();
  }

  dispose() {
    this.geometry.dispose();
    this.mesh.material.dispose();
  }

  meshForVertex(v) {
    let lo = 0;
    let hi = this.ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = this.ranges[mid];
      if (v < r.start) hi = mid - 1;
      else if (v >= r.end) lo = mid + 1;
      else return r.mesh;
    }
    return null;
  }

  /** Premier impact d'un rayon : { point, distance, mesh } ou null. */
  raycast(origin, dir, far = Infinity) {
    if (this.empty) return null;
    this.raycaster.set(origin, dir);
    this.raycaster.near = 0;
    this.raycaster.far = far;
    const hit = this.raycaster.intersectObject(this.mesh, false)[0];
    if (!hit) return null;
    return { point: hit.point, distance: hit.distance, mesh: this.meshForVertex(hit.face.a) };
  }

  /** Sol sous (x, z) en partant de yFrom vers le bas. Le terrain naturel sert de sol
   *  par défaut là où il n'y a rien (à l'extérieur de la maison). */
  groundBelow(x, yFrom, z) {
    const hit = this.raycast(this._origin.set(x, yFrom, z), DOWN);
    if (hit) return { y: hit.point.y, mesh: hit.mesh };
    if (this.groundY !== null && yFrom >= this.groundY) return { y: this.groundY, mesh: null };
    return null;
  }

  _setCapsule(feet, body) {
    const r = body.radius;
    const seg = this._seg;
    seg.start.set(feet.x, feet.y + body.stepUp + r, feet.z);
    seg.end.set(feet.x, Math.max(feet.y + body.height - r, seg.start.y), feet.z);
    this._box.makeEmpty();
    this._box.expandByPoint(seg.start);
    this._box.expandByPoint(seg.end);
    this._box.min.addScalar(-r);
    this._box.max.addScalar(r);
    return seg;
  }

  /** Repousse horizontalement la capsule hors des murs. Écrit la correction dans `out`. */
  pushOut(feet, body, out) {
    out.set(0, 0, 0);
    if (this.empty) return out;
    const r = body.radius;
    const seg = this._setCapsule(feet, body);
    const sx = seg.start.x;
    const sz = seg.start.z;
    const { _triPoint: tp, _capPoint: cp, _dir: dir, _box: box } = this;
    this.bvh.shapecast({
      intersectsBounds: (b) => b.intersectsBox(box),
      intersectsTriangle: (tri) => {
        const d = tri.closestPointToSegment(seg, tp, cp);
        if (d >= r || d < 1e-6) return false;
        dir.subVectors(cp, tp).divideScalar(d);
        // seule la composante horizontale compte : plafonds et sous-faces sont ignorés
        const depth = r - d;
        seg.start.x += dir.x * depth;
        seg.start.z += dir.z * depth;
        seg.end.x += dir.x * depth;
        seg.end.z += dir.z * depth;
        return false;
      },
    });
    out.set(seg.start.x - sx, 0, seg.start.z - sz);
    return out;
  }

  /** Vrai si la capsule posée en `feet` ne touche rien. */
  isFree(feet, body, margin = 0.02) {
    if (this.empty) return true;
    const seg = this._setCapsule(feet, body);
    const limit = body.radius - margin;
    const box = this._box;
    return !this.bvh.shapecast({
      intersectsBounds: (b) => b.intersectsBox(box),
      intersectsTriangle: (tri) => tri.closestPointToSegment(seg) < limit,
    });
  }
}

export class Walker {
  constructor(collider, body = BODY) {
    this.collider = collider;
    this.body = { ...body };
    this.feet = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.vy = 0;
    this.yaw = 0;
    this.pitch = 0;
    this.grounded = true;
    this.groundMesh = null;
    this.eyeY = 0;
    this._move = new THREE.Vector3();
    this._want = new THREE.Vector3();
    this._fix = new THREE.Vector3();
  }

  teleport(feet, yaw) {
    this.feet.copy(feet);
    this.vel.set(0, 0, 0);
    this.vy = 0;
    this.grounded = true;
    if (yaw !== undefined) this.yaw = yaw;
    this._vertical(0);
    this.eyeY = this.feet.y + this.body.eye;
  }

  /** @param {{forward:number, right:number, turn:number, run:boolean}} input */
  update(dt, input) {
    dt = Math.min(dt, 0.05);
    const b = this.body;
    this.yaw += (input.turn || 0) * b.turnSpeed * dt;

    // vitesse souhaitée dans le repère du regard (yaw = 0 -> on regarde vers -Z)
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const f = input.forward || 0;
    const s = input.right || 0;
    this._want.set(-sin * f + cos * s, 0, -cos * f - sin * s);
    if (this._want.lengthSq() > 1) this._want.normalize();
    this._want.multiplyScalar(input.run ? b.runSpeed : b.walkSpeed);
    this.vel.lerp(this._want, 1 - Math.exp(-(this.grounded ? 12 : 2) * dt));

    // sous-pas pour ne jamais traverser une cloison fine
    this._move.copy(this.vel).multiplyScalar(dt);
    const steps = Math.max(1, Math.ceil(this._move.length() / (b.radius * 0.5)));
    this._move.divideScalar(steps);
    for (let i = 0; i < steps; i++) {
      this.feet.add(this._move);
      for (let k = 0; k < 3; k++) {
        const fix = this.collider.pushOut(this.feet, b, this._fix);
        if (fix.lengthSq() < 1e-10) break;
        this.feet.add(fix);
      }
      this._vertical(dt / steps);
    }

    // l'œil suit les marches en douceur, la physique reste exacte
    const eyeTarget = this.feet.y + b.eye;
    const gap = eyeTarget - this.eyeY;
    this.eyeY = Math.abs(gap) > 1.2 ? eyeTarget : this.eyeY + gap * (1 - Math.exp(-14 * dt));
  }

  _vertical(dt) {
    const b = this.body;
    const g = this.collider.groundBelow(this.feet.x, this.feet.y + b.stepUp, this.feet.z);
    const gy = g ? g.y : -Infinity;
    if (this.grounded && gy >= this.feet.y - b.stepDown) {
      // marche montante ou descendante : on se cale dessus
      this.feet.y = gy;
      this.vy = 0;
      this.groundMesh = g.mesh;
      return;
    }
    this.grounded = false;
    this.vy -= b.gravity * dt;
    this.feet.y += this.vy * dt;
    if (this.feet.y <= gy) {
      this.feet.y = gy;
      this.vy = 0;
      this.grounded = true;
      this.groundMesh = g.mesh;
    }
  }
}

/** Cherche une position libre : autour de `near` si fourni, sinon au centre des pièces du niveau. */
export function findSpot(collider, house, levelIndex, near = null, body = BODY) {
  const lv = house.levels[levelIndex];
  const centers = near
    ? [{ x: near.x, z: near.z, y: near.y }]
    : (lv?.spawnFloors ?? []).map((f) => ({ x: f.labelPoint.x, z: f.labelPoint.z, y: f.topY }));
  if (!near && lv && !centers.length) {
    const c = lv.box.getCenter(new THREE.Vector3());
    centers.push({ x: c.x, z: c.z, y: lv.elevation });
  }
  const p = new THREE.Vector3();
  for (const c of centers) {
    for (let ring = 0; ring <= 12; ring++) {
      const radius = ring * 0.25;
      const n = ring === 0 ? 1 : ring * 6;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        const x = c.x + Math.cos(a) * radius;
        const z = c.z + Math.sin(a) * radius;
        const g = collider.groundBelow(x, c.y + 1.0, z);
        if (!g || Math.abs(g.y - c.y) > 0.6) continue;
        p.set(x, g.y, z);
        if (collider.isFree(p, body)) return p.clone();
      }
    }
  }
  return null;
}

/** Orientation qui regarde vers l'espace le plus dégagé autour du point. */
export function bestYaw(collider, feet, body = BODY) {
  const origin = new THREE.Vector3(feet.x, feet.y + body.eye, feet.z);
  const dir = new THREE.Vector3();
  let best = 0;
  let bestDist = -1;
  for (let i = 0; i < 16; i++) {
    const yaw = (i / 16) * Math.PI * 2;
    dir.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    const hit = collider.raycast(origin, dir, 30);
    const d = hit ? hit.distance : 30;
    if (d > bestDist) {
      bestDist = d;
      best = yaw;
    }
  }
  return best;
}

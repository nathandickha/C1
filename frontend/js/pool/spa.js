// js/pool/spa.js
import * as THREE from "https://esm.sh/three@0.158.0";
import { updateGroundVoid } from "../scene.js"; // kept for compatibility if used
import { createPoolWater } from "./water.js";

// --- SPA Constants ---
const SPA_WALL_THICKNESS = 0.2;

// Snap logic:
// - If SPA_TOP_OFFSET <= 0.05 → spa ON wall (no extra offset)
// - If SPA_TOP_OFFSET > 0.05  → spa offset 0.35m outward
const SNAP_HEIGHT_THRESHOLD = 0.05; // 50mm
const SNAP_OFFSET_RAISED = 0.35;    // 350mm
const SPA_CENTER_SNAP_THRESHOLD = 0.35; // 350mm along-wall snap tolerance
const SPA_WALL_CENTER_SNAP_THRESHOLD = 0.35; // 350mm normal-to-wall tolerance
// Rectangle and freeform pools need a shape-specific snap correction.
// Negative values move the spa further into the pool/wall direction; positive
// values move it further outward.
const SHAPE_SNAP_NUDGE = {
  rectangular: -0.15,
  freeform: -0.15
};

// Fine adjustment for the extra outer snap point where the spa wall closest
// to the pool centre aligns to the pool wall. Positive values push that outer
// snap slightly further away from the pool so the wall face does not stick in.
const SPA_OUTER_WALL_ALIGN_OFFSET = 0.1;

const SPA_SEAT_DEPTH = 0.45;
const SPA_SEAT_TOP_OFFSET = 0.5;
const SPA_SEAT_THICKNESS = 2.18;
const CIRCULAR_SPA_SEGMENTS = 48;
let SPA_TOP_OFFSET = 0.0;
const SPA_TOP_OFFSET_STEP = 0.05;

function roundSpaTopOffset(value) {
  const n = Number.isFinite(value) ? value : 0;
  return Math.round(n / SPA_TOP_OFFSET_STEP) * SPA_TOP_OFFSET_STEP;
}

function getSpaTopOffsetFloor(spa) {
  return spa?.userData?.isHalfwayInWall ? 0.05 : 0.0;
}

function applySpaTopOffsetRules(spa, requestedValue = SPA_TOP_OFFSET) {
  const minTop = getSpaTopOffsetFloor(spa);
  const clamped = Math.max(minTop, roundSpaTopOffset(requestedValue));
  SPA_TOP_OFFSET = clamped;

  if (spa) {
    spa.userData.topOffset = clamped;
    spa.userData.minTopOffset = minTop;
    spa.userData.orangeOnlyVoidMode = !spa.userData.isHalfwayInWall;
  }

  return clamped;
}

// --- Water control ---
const SPA_WATER_BOTTOM_WORLD = -0.1;   // must match pool water level
const SPA_WATER_TOP_FINE_ADJUST = 0.01; // adjust top independently (+ up / - down)

// --- Water tuning ---
const WATER_OVERFLOW = 0.015;
const ENABLE_SPA_SPILLOVER_SHEET = false;

// --- SPA storage ---
export let spas = [];
export let selectedSpa = null;

// Allow external code (PoolApp) to change current selected spa
export function setSelectedSpa(spa) {
  selectedSpa = spa;
}

function disposeMaterial(material) {
  if (!material) return;
  const mats = Array.isArray(material) ? material : [material];
  mats.forEach((m) => m?.dispose?.());
}

function disposeHierarchy(root) {
  if (!root) return;
  root.traverse?.((obj) => {
    if (obj?.geometry) obj.geometry.dispose?.();
    if (obj?.material) disposeMaterial(obj.material);
  });
}

function isDescendantOf(obj, ancestor) {
  let cur = obj;
  while (cur) {
    if (cur === ancestor) return true;
    cur = cur.parent || null;
  }
  return false;
}


function polygonSignedArea2D(points) {
  if (!Array.isArray(points) || points.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    const px = Number.isFinite(p?.x) ? p.x : 0;
    const py = Number.isFinite(p?.y) ? p.y : 0;
    const qx = Number.isFinite(q?.x) ? q.x : 0;
    const qy = Number.isFinite(q?.y) ? q.y : 0;
    area += px * qy - qx * py;
  }
  return area * 0.5;
}

function normalizePlanPoint(p) {
  if (!p) return null;
  if (p.isVector2) return p.clone();
  const x = Number.isFinite(p.x) ? p.x : 0;
  const y = Number.isFinite(p.y) ? p.y : 0;
  return new THREE.Vector2(x, y);
}

function buildSpaSnapEdgesFromPoints(points) {
  if (!Array.isArray(points) || points.length < 2) return [];
  const pts = points.map(normalizePlanPoint).filter(Boolean);
  if (pts.length < 2) return [];

  const area = polygonSignedArea2D(pts);
  const ccw = area >= 0;
  const edges = [];

  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[i];
    const p1 = pts[(i + 1) % pts.length];
    if (!p0 || !p1) continue;
    if (p0.distanceToSquared(p1) <= 1e-10) continue;

    const tangent = p1.clone().sub(p0);
    const length = tangent.length();
    if (length <= 1e-6) continue;
    tangent.divideScalar(length);

    const inwardNormal = ccw
      ? new THREE.Vector2(-tangent.y, tangent.x)
      : new THREE.Vector2(tangent.y, -tangent.x);

    edges.push({
      p0: p0.clone(),
      p1: p1.clone(),
      center: p0.clone().add(p1).multiplyScalar(0.5),
      tangent,
      normal: inwardNormal.normalize(),
      length
    });
  }

  return edges;
}

function getFallbackRectangleSnapEdges(poolParams = {}) {
  const halfL = (poolParams.length || 0) * 0.5;
  const halfW = (poolParams.width || 0) * 0.5;
  return buildSpaSnapEdgesFromPoints([
    new THREE.Vector2(-halfL, -halfW),
    new THREE.Vector2( halfL, -halfW),
    new THREE.Vector2( halfL,  halfW),
    new THREE.Vector2(-halfL,  halfW)
  ]);
}

function getPoolSnapEdges(poolGroup, poolParams = {}) {
  const rawEdges = poolGroup?.userData?.spaSnapEdges;
  if (Array.isArray(rawEdges) && rawEdges.length) {
    const normalized = rawEdges
      .map((edge) => {
        const p0 = normalizePlanPoint(edge?.p0);
        const p1 = normalizePlanPoint(edge?.p1);
        if (!p0 || !p1 || p0.distanceToSquared(p1) <= 1e-10) return null;

        const tangent = p1.clone().sub(p0);
        const length = tangent.length();
        if (length <= 1e-6) return null;
        tangent.divideScalar(length);

        let normal = normalizePlanPoint(edge?.normal);
        if (!normal || normal.lengthSq() <= 1e-10) {
          normal = new THREE.Vector2(-tangent.y, tangent.x);
        } else {
          normal.normalize();
        }

        return {
          p0,
          p1,
          center: edge?.center ? normalizePlanPoint(edge.center) : p0.clone().add(p1).multiplyScalar(0.5),
          tangent,
          normal,
          length
        };
      })
      .filter(Boolean);

    if (normalized.length) return normalized;
  }

  const outerPts = poolGroup?.userData?.outerPts;
  if (Array.isArray(outerPts) && outerPts.length >= 2) {
    const generated = buildSpaSnapEdgesFromPoints(outerPts);
    if (generated.length) return generated;
  }

  return getFallbackRectangleSnapEdges(poolParams);
}

function projectPointToSegment(point, a, b) {
  const ab = b.clone().sub(a);
  const lenSq = ab.lengthSq();
  if (lenSq <= 1e-10) {
    return { point: a.clone(), t: 0, distanceSq: point.distanceToSquared(a) };
  }

  let t = point.clone().sub(a).dot(ab) / lenSq;
  t = THREE.MathUtils.clamp(t, 0, 1);
  const projected = a.clone().add(ab.multiplyScalar(t));
  return {
    point: projected,
    t,
    distanceSq: point.distanceToSquared(projected)
  };
}

function getPoolPlanCenter(poolGroup, poolParams = {}) {
  const outerPts = poolGroup?.userData?.outerPts;
  if (Array.isArray(outerPts) && outerPts.length) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of outerPts) {
      const pt = normalizePlanPoint(p);
      if (!pt) continue;
      minX = Math.min(minX, pt.x);
      maxX = Math.max(maxX, pt.x);
      minY = Math.min(minY, pt.y);
      maxY = Math.max(maxY, pt.y);
    }
    if (Number.isFinite(minX) && Number.isFinite(maxX) && Number.isFinite(minY) && Number.isFinite(maxY)) {
      return new THREE.Vector2((minX + maxX) * 0.5, (minY + maxY) * 0.5);
    }
  }
  return new THREE.Vector2(0, 0);
}

function getCardinalSnapSideFromNormal(normal) {
  const n = normalizePlanPoint(normal) || new THREE.Vector2(1, 0);
  if (Math.abs(n.x) >= Math.abs(n.y)) {
    return n.x >= 0 ? "left" : "right";
  }
  return n.y >= 0 ? "front" : "back";
}


export function purgeDetachedSpaArtifacts(scene, activeSpa = null) {
  if (!scene?.traverse) return;
  const stale = [];
  scene.traverse((obj) => {
    if (!obj?.isMesh) return;
    const isSpaArtifact = !!(
      obj.userData?.isSpaWall ||
      obj.userData?.isSpaSeat ||
      obj.userData?.isSpaFloor ||
      obj.userData?.isSpaWater ||
      obj.userData?.isSpaSpillover
    );
    if (!isSpaArtifact) return;
    if (activeSpa && isDescendantOf(obj, activeSpa)) return;
    stale.push(obj);
  });
  stale.forEach((obj) => {
    obj.parent?.remove?.(obj);
    obj.geometry?.dispose?.();
    disposeMaterial(obj.material);
  });
}

export function disposeSpa(spa, scene = null) {
  if (!spa) return;
  disposeHierarchy(spa);
  spa.parent?.remove?.(spa);
  if (scene) purgeDetachedSpaArtifacts(scene, null);
}

// --- Top offset setter ---
export function setSpaTopOffset(val) {
  applySpaTopOffsetRules(selectedSpa, val);
  if (selectedSpa) {
    updateSpaWalls(selectedSpa);
    updateSpaSeats(selectedSpa);
    snapToPool(selectedSpa);
  }
}

export function getSpaTopOffsetConstraints(spa = selectedSpa) {
  const targetSpa = spa || null;
  const value = targetSpa?.userData?.topOffset ?? SPA_TOP_OFFSET;
  const min = getSpaTopOffsetFloor(targetSpa);
  return {
    step: SPA_TOP_OFFSET_STEP,
    min,
    value,
    isHalfwayInWall: !!targetSpa?.userData?.isHalfwayInWall,
    orangeOnlyVoidMode: !!targetSpa?.userData?.orangeOnlyVoidMode
  };
}

// --- Helpers ---
function getDeepFloorZ(poolParams) {
  return -poolParams.deep;
}



// --- Tile UV helpers (match pool tile density) ---
// Pool uses meter-based UVs so tile textures keep real-world size.
// We replicate the same UV strategy here for spa meshes.
function generateMeterUVsForBoxGeometry(geo, tileSize) {
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  const uvs = new Float32Array(pos.count * 2);

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);

    const ax = Math.abs(nrm.getX(i));
    const ay = Math.abs(nrm.getY(i));
    const az = Math.abs(nrm.getZ(i));

    let u = 0, v = 0;

    // Project onto the dominant axis plane
    if (az >= ax && az >= ay) {
      u = x / tileSize;
      v = y / tileSize;
    } else if (ay >= ax && ay >= az) {
      u = x / tileSize;
      v = z / tileSize;
    } else {
      u = y / tileSize;
      v = z / tileSize;
    }

    uvs[i * 2] = u;
    uvs[i * 2 + 1] = v;
  }

  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  // Keep AO workflows happy if present
  if (!geo.attributes.uv2) {
    geo.setAttribute("uv2", new THREE.BufferAttribute(uvs.slice(), 2));
  }
}



function generateMeterUVsForCircularDiscGeometry(geo, tileSize) {
  const pos = geo?.attributes?.position;
  if (!pos) return;
  const uvs = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    // After rotateX(Math.PI * 0.5) the disc's plan lives on XY and thickness on Z.
    const usePlanar = Math.abs(z) <= Math.abs(y);
    const u = x / tileSize;
    const v = (usePlanar ? y : z) / tileSize;
    uvs[i * 2] = u;
    uvs[i * 2 + 1] = v;
  }
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  if (!geo.attributes.uv2) {
    geo.setAttribute("uv2", new THREE.BufferAttribute(uvs.slice(), 2));
  }
}

function generateMeterUVsForCircularRingGeometry(geo, tileSize) {
  let target = geo;
  if (target?.index) target = target.toNonIndexed();
  const pos = target?.attributes?.position;
  const nrm = target?.attributes?.normal;
  if (!pos || !nrm) return target;

  const uvs = new Float32Array(pos.count * 2);

  for (let i = 0; i < pos.count; i += 3) {
    const tri = [];
    for (let k = 0; k < 3; k++) {
      const idx = i + k;
      const x = pos.getX(idx);
      const y = pos.getY(idx);
      const z = pos.getZ(idx);
      const ax = Math.abs(nrm.getX(idx));
      const ay = Math.abs(nrm.getY(idx));
      const az = Math.abs(nrm.getZ(idx));

      if (az >= ax && az >= ay) {
        tri.push({ idx, u: x / tileSize, v: y / tileSize, side: false });
      } else {
        let angle = Math.atan2(y, x);
        if (angle < 0) angle += Math.PI * 2;
        const radius = Math.sqrt(x * x + y * y);
        tri.push({ idx, angle, radius, v: z / tileSize, side: true });
      }
    }

    const sideVerts = tri.filter((v) => v.side);
    if (sideVerts.length) {
      const minA = Math.min(...sideVerts.map((v) => v.angle));
      const maxA = Math.max(...sideVerts.map((v) => v.angle));
      if ((maxA - minA) > Math.PI) {
        sideVerts.forEach((v) => {
          if (v.angle < Math.PI) v.angle += Math.PI * 2;
        });
      }
      sideVerts.forEach((v) => {
        v.u = (v.angle * v.radius) / tileSize;
      });
    }

    tri.forEach((v) => {
      uvs[v.idx * 2] = v.u;
      uvs[v.idx * 2 + 1] = v.v;
    });
  }

  target.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  if (!target.attributes.uv2) {
    target.setAttribute("uv2", new THREE.BufferAttribute(uvs.slice(), 2));
  }
  return target;
}

function lineIntersection2D(a1, a2, b1, b2) {
  const dax = a2.x - a1.x;
  const day = a2.y - a1.y;
  const dbx = b2.x - b1.x;
  const dby = b2.y - b1.y;
  const denom = dax * dby - day * dbx;
  if (Math.abs(denom) < 1e-8) return null;
  const dx = b1.x - a1.x;
  const dy = b1.y - a1.y;
  const t = (dx * dby - dy * dbx) / denom;
  return new THREE.Vector2(a1.x + dax * t, a1.y + day * t);
}

function createMiteredWallGeometry(points, index, halfThickness, height) {
  const n = points.length;
  const pPrev = points[(index - 1 + n) % n];
  const p0 = points[index];
  const p1 = points[(index + 1) % n];
  const pNext = points[(index + 2) % n];

  const dir = p1.clone().sub(p0);
  if (dir.lengthSq() < 1e-10) return null;
  dir.normalize();

  const prevDir = p0.clone().sub(pPrev);
  if (prevDir.lengthSq() < 1e-10) prevDir.copy(dir);
  else prevDir.normalize();

  const nextDir = pNext.clone().sub(p1);
  if (nextDir.lengthSq() < 1e-10) nextDir.copy(dir);
  else nextDir.normalize();

  const leftNormal = (v) => new THREE.Vector2(-v.y, v.x);
  const curIn = leftNormal(dir);
  const prevIn = leftNormal(prevDir);
  const nextIn = leftNormal(nextDir);
  const curOut = curIn.clone().multiplyScalar(-1);
  const prevOut = prevIn.clone().multiplyScalar(-1);
  const nextOut = nextIn.clone().multiplyScalar(-1);

  const offsetLine = (a, b, nrm, d) => [a.clone().addScaledVector(nrm, d), b.clone().addScaledVector(nrm, d)];
  const [curInnerA, curInnerB] = offsetLine(p0, p1, curIn, halfThickness);
  const [curOuterA, curOuterB] = offsetLine(p0, p1, curOut, halfThickness);
  const [prevInnerA, prevInnerB] = offsetLine(pPrev, p0, prevIn, halfThickness);
  const [prevOuterA, prevOuterB] = offsetLine(pPrev, p0, prevOut, halfThickness);
  const [nextInnerA, nextInnerB] = offsetLine(p1, pNext, nextIn, halfThickness);
  const [nextOuterA, nextOuterB] = offsetLine(p1, pNext, nextOut, halfThickness);

  const innerStart = lineIntersection2D(prevInnerA, prevInnerB, curInnerA, curInnerB) || curInnerA.clone();
  const outerStart = lineIntersection2D(prevOuterA, prevOuterB, curOuterA, curOuterB) || curOuterA.clone();
  const innerEnd = lineIntersection2D(curInnerA, curInnerB, nextInnerA, nextInnerB) || curInnerB.clone();
  const outerEnd = lineIntersection2D(curOuterA, curOuterB, nextOuterA, nextOuterB) || curOuterB.clone();

  const shape = new THREE.Shape([innerStart, innerEnd, outerEnd, outerStart]);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: false,
    steps: 1,
    curveSegments: 1
  });
  geo.computeVertexNormals();
  return geo;
}



function createCircularShape(radius) {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, radius, 0, Math.PI * 2, false);
  return shape;
}
function createCircularHole(radius) {
  const hole = new THREE.Path();
  hole.absarc(0, 0, radius, 0, Math.PI * 2, true);
  return hole;
}
function createCircularRingGeometry(outerRadius, innerRadius, height) {
  const shape = createCircularShape(Math.max(0.01, outerRadius));
  if (innerRadius > 0.005 && innerRadius < outerRadius - 0.005) shape.holes.push(createCircularHole(innerRadius));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.01, height), bevelEnabled: false, steps: 1, curveSegments: CIRCULAR_SPA_SEGMENTS });
  geo.computeVertexNormals();
  return geo;
}
function createCircularDiscGeometry(radius, height) {
  const geo = new THREE.CylinderGeometry(Math.max(0.01, radius), Math.max(0.01, radius), Math.max(0.01, height), CIRCULAR_SPA_SEGMENTS, 1, false);
  geo.rotateX(Math.PI * 0.5); geo.computeVertexNormals(); return geo;
}
function createWaterSurfaceGeometry(spaShape, xSize, ySize, segments = 96) {
  if (spaShape === 'circular') {
    return new THREE.CircleGeometry(Math.max(0.01, xSize * 0.5), Math.max(24, segments));
  }
  return new THREE.PlaneGeometry(Math.max(0.01, xSize), Math.max(0.01, ySize), Math.max(1, Math.floor(segments * Math.max(1, xSize) / Math.max(1, Math.max(xSize, ySize)))), Math.max(1, Math.floor(segments * Math.max(1, ySize) / Math.max(1, Math.max(xSize, ySize)))));
}
function getSpaPlanDimensions(spa) {
  const length = spa?.userData?.spaLength ?? 2, width = spa?.userData?.spaWidth ?? 2, spaShape = spa?.userData?.spaShape || 'square';
  if (spaShape === 'circular') { const d = Math.max(1, Math.min(length, width)); return { spaShape, length: d, width: d, radius: d * 0.5 }; }
  return { spaShape, length, width, radius: Math.min(length, width) * 0.5 };
}
function updateSpaOutlinePoints(spa) {
  const { spaShape, length, width, radius } = getSpaPlanDimensions(spa);
  if (spaShape === 'circular') {
    const pts=[]; for(let i=0;i<CIRCULAR_SPA_SEGMENTS;i++){ const a=(i/CIRCULAR_SPA_SEGMENTS)*Math.PI*2; pts.push(new THREE.Vector2(Math.cos(a)*radius, Math.sin(a)*radius)); }
    spa.userData.outerPts = pts; return;
  }
  spa.userData.outerPts = [new THREE.Vector2(-length*0.5,-width*0.5),new THREE.Vector2(length*0.5,-width*0.5),new THREE.Vector2(length*0.5,width*0.5),new THREE.Vector2(-length*0.5,width*0.5)];
}

// --- Seats ---
function updateSpaSeats(spa) {
  const { spaShape, length: l, width: w, radius } = getSpaPlanDimensions(spa);
  const h = spa.userData.height;
  const spaTop = spa.position.z + h / 2;
  const seatTopAbs = spaTop - SPA_SEAT_TOP_OFFSET;
  const seatCenterAbs = seatTopAbs - SPA_SEAT_THICKNESS / 2;
  const seatCenterLocal = seatCenterAbs - spa.position.z;
  const seats = spa.userData.seats; const tileSize = spa.userData.tileSize || 0.3; const seatHalfDepth = SPA_SEAT_DEPTH * 0.5;
  if (spaShape === 'circular') {
    [seats.front,seats.back,seats.left,seats.right].forEach((s)=>s.visible=false);
    if (seats.ring) {
      // Lock the seat outer edge to the spa wall inner face so there is no
      // visible annular gap between the seat and the circular wall.
      const wallInnerRadius = Math.max(0.12, radius - SPA_WALL_THICKNESS * 0.5);
      const outerR = wallInnerRadius;
      const innerR = Math.max(0.05, outerR - SPA_SEAT_DEPTH);
      seats.ring.geometry.dispose();
      const seatGeo = createCircularRingGeometry(outerR, innerR, SPA_SEAT_THICKNESS);
      seats.ring.geometry = generateMeterUVsForCircularRingGeometry(seatGeo, tileSize);
      seats.ring.position.set(0, 0, seatCenterLocal - SPA_SEAT_THICKNESS / 2);
      seats.ring.visible = true;
    }
  } else {
    if (seats.ring) seats.ring.visible=false;
    const centerline=[new THREE.Vector2(-l/2+seatHalfDepth,-w/2+seatHalfDepth),new THREE.Vector2(l/2-seatHalfDepth,-w/2+seatHalfDepth),new THREE.Vector2(l/2-seatHalfDepth,w/2-seatHalfDepth),new THREE.Vector2(-l/2+seatHalfDepth,w/2-seatHalfDepth)];
    const seatOrder=[seats.front,seats.right,seats.back,seats.left];
    for(let i=0;i<seatOrder.length;i++){ const seat=seatOrder[i]; const geo=createMiteredWallGeometry(centerline,i,seatHalfDepth,SPA_SEAT_THICKNESS); if(!geo) continue; generateMeterUVsForBoxGeometry(geo,tileSize); seat.geometry.dispose(); seat.geometry=geo; seat.position.set(0,0,seatCenterLocal-SPA_SEAT_THICKNESS/2); seat.scale.set(1,1,1); seat.visible=true; }
  }
}

// --- Walls & water ---
function updateSpaWalls(spa) {
  const water = spa.userData.waterMesh, walls = spa.userData.walls, poolParams = spa.userData.poolParams;
  const { spaShape, length: l, width: w, radius } = getSpaPlanDimensions(spa);
  spa.userData.spaShape = spaShape; spa.userData.spaLength = l; spa.userData.spaWidth = w; updateSpaOutlinePoints(spa);
  const bottomZ=getDeepFloorZ(poolParams), topZ=SPA_TOP_OFFSET, h=topZ-bottomZ; spa.userData.height=h; spa.position.z=bottomZ+h/2;
  const t=SPA_WALL_THICKNESS, overflow=WATER_OVERFLOW, tileSize=spa.userData.tileSize||0.3;
  if (spaShape === 'circular') {
    [walls.front,walls.right,walls.back,walls.left].forEach((m)=>m.visible=false);
    if (walls.ring){ walls.ring.geometry.dispose(); const wallGeo=createCircularRingGeometry(radius+t*0.5,Math.max(0.05,radius-t*0.5),h); walls.ring.geometry=generateMeterUVsForCircularRingGeometry(wallGeo, tileSize); walls.ring.position.set(0,0,-h/2); walls.ring.visible=true; }
    const waterHeight = Math.max(0.01, (SPA_TOP_OFFSET + SPA_WATER_TOP_FINE_ADJUST) - SPA_WATER_BOTTOM_WORLD); const waterRadius = Math.max(0.05, radius + 0.5 * (t + overflow)); water.geometry.dispose(); water.geometry = createCircularDiscGeometry(waterRadius, waterHeight); water.position.set(0,0,SPA_WATER_BOTTOM_WORLD + waterHeight * 0.5 - spa.position.z); water.rotation.set(0,0,0);
  } else {
    if (walls.ring) walls.ring.visible=false;
    const footprint=[new THREE.Vector2(-l*0.5,-w*0.5),new THREE.Vector2(l*0.5,-w*0.5),new THREE.Vector2(l*0.5,w*0.5),new THREE.Vector2(-l*0.5,w*0.5)];
    const wallOrder=[walls.front,walls.right,walls.back,walls.left]; for(let i=0;i<wallOrder.length;i++){ const wall=wallOrder[i]; const geo=createMiteredWallGeometry(footprint,i,t*0.5,h); generateMeterUVsForBoxGeometry(geo,tileSize); wall.geometry.dispose(); wall.geometry=geo; wall.position.set(0,0,-h/2); wall.visible=true; }
    const waterHeight = Math.max(0.01, (SPA_TOP_OFFSET + SPA_WATER_TOP_FINE_ADJUST) - SPA_WATER_BOTTOM_WORLD); const waterLen = l + 1.0 * (t + overflow); const waterWid = w + 1.0 * (t + overflow); water.geometry.dispose(); water.geometry = new THREE.BoxGeometry(waterLen, waterWid, waterHeight); water.position.set(0,0,SPA_WATER_BOTTOM_WORLD + waterHeight * 0.5 - spa.position.z); water.rotation.set(0,0,0);
  }
  if (water?.userData?.waterUniforms) { const u=water.userData.waterUniforms; const spaDepth=(SPA_TOP_OFFSET-getDeepFloorZ(poolParams)); const poolDepth=Math.max(0.1,poolParams?.deep||spaDepth||2.0); if(u.thicknessDeep)u.thicknessDeep.value=poolDepth; if(u.thicknessShallow)u.thicknessShallow.value=0.30; if(u.alphaShallow)u.alphaShallow.value=0.18; if(u.alphaDeep)u.alphaDeep.value=0.88; }
  updateSpillover(spa);
  const floor=spa.userData.floor; if(floor){ const floorHeight=0.2; let geo; if(spaShape==='circular') { geo=createCircularDiscGeometry(Math.max(0.05,radius-t),floorHeight); generateMeterUVsForCircularDiscGeometry(geo,tileSize); } else { geo=new THREE.BoxGeometry(l,w,floorHeight); generateMeterUVsForBoxGeometry(geo,tileSize);} floor.geometry.dispose(); floor.geometry=geo; floor.scale.set(1,1,1); const spaTopWorld=spa.position.z+spa.userData.height/2; const floorCenterZ=spaTopWorld-1-floorHeight/2; floor.position.set(0,0,floorCenterZ-spa.position.z);} }


function updateSpillover(spa) {
  const spill = spa.userData.spilloverMesh;
  if (!spill) return;
  if (!ENABLE_SPA_SPILLOVER_SHEET) {
    spill.visible = false;
    return;
  }

  const side = spa.userData.snapSide || "left";
  const l = spa.userData.spaLength;
  const w = spa.userData.spaWidth;
  const t = SPA_WALL_THICKNESS;

  // Pool water top is assumed at world Z = 0.0 (matches V7 pool water)
  const poolTopWorld = 0.0;
  const spaTopWorld = SPA_TOP_OFFSET;

  const height = Math.max(0.0, spaTopWorld - poolTopWorld);
  if (height < 0.01) {
    spill.visible = false;
    return;
  }

  spill.visible = true;

  const widthAlong = (side === "left" || side === "right") ? w : l;

  // Plane is rotated so its Y axis becomes world Z (Z-up project)
  spill.rotation.set(-Math.PI / 2, 0, 0);

  // Face toward pool interior based on snap side
  if (side === "left")  spill.rotation.z = -Math.PI / 2; // normal +X
  if (side === "right") spill.rotation.z =  Math.PI / 2; // normal -X
  if (side === "front") spill.rotation.z =  0;           // normal +Y
  if (side === "back")  spill.rotation.z =  Math.PI;     // normal -Y

  spill.scale.set(widthAlong, height, 1);

  const centerWorldZ = (poolTopWorld + spaTopWorld) * 0.5;
  const centerLocalZ = centerWorldZ - spa.position.z;

  // Place at the inner edge facing the pool
  const edge = (Math.max(l, w) * 0.0); // placeholder for clarity
  if (side === "left")  spill.position.set( l / 2 + t / 2 + 0.002, 0, centerLocalZ);
  if (side === "right") spill.position.set(-l / 2 - t / 2 - 0.002, 0, centerLocalZ);
  if (side === "front") spill.position.set(0,  w / 2 + t / 2 + 0.002, centerLocalZ);
  if (side === "back")  spill.position.set(0, -w / 2 - t / 2 - 0.002, centerLocalZ);
}

// --- Snap SPA to pool wall or offset ---
export function snapToPool(spa) {
  const poolParams = spa.userData.poolParams || {};
  const poolGroup = spa.userData.poolGroup || null;
  const { spaShape, length: l, width: w } = getSpaPlanDimensions(spa);
  const disableExternalSnap = spaShape === "circular";

  const halfSpan = spaShape === "circular"
    ? Math.max(l, w) * 0.5
    : null;

  const spaPos2 = new THREE.Vector2(spa.position.x, spa.position.y);
  const poolCenter = getPoolPlanCenter(poolGroup, poolParams);
  const wallNudge = SHAPE_SNAP_NUDGE[poolParams.shape] || 0.0;
  const dynamicSnap = SPA_TOP_OFFSET <= SNAP_HEIGHT_THRESHOLD ? 0.0 : SNAP_OFFSET_RAISED;
  const snapEdges = getPoolSnapEdges(poolGroup, poolParams);

  if (!snapEdges.length) {
    applySpaTopOffsetRules(spa, SPA_TOP_OFFSET);
    return;
  }

  let best = null;
  for (const edge of snapEdges) {
    const projected = projectPointToSegment(spaPos2, edge.p0, edge.p1);
    if (!best || projected.distanceSq < best.projected.distanceSq) {
      best = { edge, projected };
    }
  }

  if (!best) {
    applySpaTopOffsetRules(spa, SPA_TOP_OFFSET);
    return;
  }

  const edge = best.edge;
  const projected = best.projected;
  const centerProjected = projectPointToSegment(poolCenter, edge.p0, edge.p1);
  const alongPoint = projected.point.distanceTo(centerProjected.point) <= SPA_CENTER_SNAP_THRESHOLD
    ? centerProjected.point
    : projected.point;

  const inwardNormal = normalizePlanPoint(edge.normal) || new THREE.Vector2(1, 0);
  inwardNormal.normalize();
  const tangent = edge.tangent?.clone?.() || edge.p1.clone().sub(edge.p0);
  if (tangent.lengthSq() <= 1e-10) tangent.set(0, 1);
  tangent.normalize();
  const toSpa = spaPos2.clone().sub(alongPoint);
  const normalDistance = toSpa.dot(inwardNormal);

  const spanAlongNormal = halfSpan ?? (Math.abs(inwardNormal.x) * (l * 0.5) + Math.abs(inwardNormal.y) * (w * 0.5));
  const innerDistance = spanAlongNormal + dynamicSnap + wallNudge;
  const centerDistance = 0.0;
  const outerDistance = -spanAlongNormal - SPA_OUTER_WALL_ALIGN_OFFSET;

  let chosenDistance = innerDistance;
  let isHalfwayInWall = false;
  let snapVariant = "inner-flush";

  const snapToOuter = !disableExternalSnap && Math.abs(normalDistance - outerDistance) <= SPA_WALL_CENTER_SNAP_THRESHOLD;
  const snapToCenter = Math.abs(normalDistance - centerDistance) <= SPA_WALL_CENTER_SNAP_THRESHOLD;

  if (snapToOuter) {
    chosenDistance = outerDistance;
    isHalfwayInWall = true;
    snapVariant = "inner-wall-align";
  } else if (snapToCenter) {
    chosenDistance = centerDistance;
    isHalfwayInWall = true;
    snapVariant = "center-wall";
  }

  const snappedPos = alongPoint.clone().add(inwardNormal.multiplyScalar(chosenDistance));
  spa.position.x = snappedPos.x;
  spa.position.y = snappedPos.y;

  spa.userData.snapSide = getCardinalSnapSideFromNormal(edge.normal);
  spa.userData.snapEdge = {
    p0: edge.p0.clone(),
    p1: edge.p1.clone(),
    center: (edge.center?.clone?.() || edge.p0.clone().add(edge.p1).multiplyScalar(0.5)),
    tangent: tangent.clone(),
    normal: edge.normal.clone(),
    length: edge.length ?? edge.p0.distanceTo(edge.p1)
  };
  spa.userData.isHalfwayInWall = isHalfwayInWall;
  spa.userData.snapVariant = snapVariant;

  applySpaTopOffsetRules(spa, SPA_TOP_OFFSET);
}

// --- Create SPA ---
export function createSpa(poolParams, scene, options = {}) {
  const loader = new THREE.TextureLoader();
  const spaShape = options.shape === "circular" ? "circular" : "square";
  const spaLength = options.length || 2.0;
  const spaWidth = options.width || 2.0;

  const spa = new THREE.Group();
  spa.userData.poolParams = poolParams;
  spa.userData.poolGroup = options.poolGroup || null;
  spa.userData.tileSize = options.tileSize ?? poolParams?.tileSize ?? 0.3;
  spa.userData.spaShape = spaShape;
  spa.userData.spaLength = spaShape === "circular" ? Math.min(spaLength, spaWidth) : spaLength;
  spa.userData.spaWidth = spaShape === "circular" ? Math.min(spaLength, spaWidth) : spaWidth;

  // Walls
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xffffff });
  const walls = {
    left: new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), wallMat.clone()),
    right: new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), wallMat.clone()),
    front: new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), wallMat.clone()),
    back: new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), wallMat.clone())
  };
  Object.values(walls).forEach((w) => {
    w.castShadow = true;
    w.receiveShadow = true;
    w.userData.isSpaWall = true;
    spa.add(w);
  });
  walls.ring = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), wallMat.clone());
  walls.ring.castShadow = true; walls.ring.receiveShadow = true; walls.ring.userData.isSpaWall = true; spa.add(walls.ring);
  spa.userData.walls = walls;

  // Seats
  const seatMat = new THREE.MeshStandardMaterial({ color: 0x777777 });
  const seats = {
    front: new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), seatMat.clone()),
    back: new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), seatMat.clone()),
    left: new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), seatMat.clone()),
    right: new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), seatMat.clone())
  };
  Object.values(seats).forEach((s) => {
    s.castShadow = s.receiveShadow = true;
    s.userData.isSpaSeat = true;
    spa.add(s);
  });
  seats.ring = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), seatMat.clone());
  seats.ring.castShadow = seats.ring.receiveShadow = true; seats.ring.userData.isSpaSeat = true; spa.add(seats.ring);
  spa.userData.seats = seats;

  // Floor
  const floorMat = new THREE.MeshStandardMaterial({ color: 0xaaaaaa });
  const floor = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 0.1), floorMat);
  floor.receiveShadow = true;
  floor.userData.isSpaFloor = true;
  spa.add(floor);
  spa.userData.floor = floor;

// Water (reuse pool water system, but keep the original spa water volume)
const water = createPoolWater(new THREE.BoxGeometry(1, 1, 1));
water.userData.isSpaWater = true; // so PBR won't tile over this
water.name = "SpaWaterVolume";

spa.add(water);
spa.userData.waterMesh = water;

// Spillover / overflow sheet (spa → pool)
const spillMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  side: THREE.DoubleSide,
  uniforms: {
    uTime: { value: 0.0 },
    strength: { value: 1.0 },
    foam: { value: 0.65 },
    lipFoam: { value: 1.25 },
    lipWidth: { value: 0.18 },
    flicker: { value: 0.25 }
  },
  vertexShader: `
    varying vec2 vUv;
    void main(){
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    precision highp float;
    varying vec2 vUv;
    uniform float uTime;
    uniform float strength;
    uniform float foam;
uniform float lipFoam;
uniform float lipWidth;
uniform float flicker;

    float hash(vec2 p){
      p = fract(p*vec2(123.34, 345.45));
      p += dot(p, p+34.345);
      return fract(p.x*p.y);
    }

    float noise(vec2 p){
      vec2 i = floor(p);
      vec2 f = fract(p);
      float a = hash(i);
      float b = hash(i+vec2(1.0,0.0));
      float c = hash(i+vec2(0.0,1.0));
      float d = hash(i+vec2(1.0,1.0));
      vec2 u = f*f*(3.0-2.0*f);
      return mix(a,b,u.x) + (c-a)*u.y*(1.0-u.x) + (d-b)*u.x*u.y;
    }

    void main(){
      float t = uTime;

      // Downward flow + lateral wobble
      vec2 uv = vUv;
      uv.y = fract(uv.y + t*0.85);
      uv.x += sin((vUv.y*8.0) + t*3.0) * 0.03;

      float n = noise(uv*vec2(6.0, 18.0));
      float streak = smoothstep(0.35, 1.0, n);

      // Edge foam (stronger near top lip)
      float edge = smoothstep(1.0 - lipWidth, 1.0, vUv.y) * foam;

        // extra froth right at the lip
        float lip = smoothstep(0.92, 1.0, vUv.y) * lipFoam;

      // Fade in/out vertically (avoid hard rectangle)
      float fadeTop = smoothstep(0.98, 0.80, vUv.y);
      float fadeBot = smoothstep(0.02, 0.18, vUv.y);

      float flick = 1.0 + (noise(vUv*vec2(14.0, 6.0) + vec2(t*0.6, -t*0.2)) - 0.5) * 2.0 * flicker;
        float a = (0.12 + 0.55*streak + 0.35*edge + 0.55*lip) * fadeTop * fadeBot * strength * flick;

      vec3 col = mix(vec3(0.70, 0.88, 0.98), vec3(1.0), clamp(edge + lip, 0.0, 1.0));
      gl_FragColor = vec4(col, a);
    }
  `
});

const spill = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 1, 1), spillMat);
spill.frustumCulled = false;
spill.visible = false;
spill.userData.isSpaSpillover = true;
spill.userData.animate = (delta, clock) => {
  spillMat.uniforms.uTime.value = clock.getElapsedTime();
};
spa.add(spill);
spa.userData.spilloverMesh = spill;
  // Initial placement: start at deep end floor
  spa.position.z = getDeepFloorZ(poolParams) + (poolParams?.deep || 2) / 2;

  if (spa.userData.poolGroup) {
    snapToPool(spa);
  }
  updateSpaWalls(spa);
  updateSpaSeats(spa);
  if (spa.userData.poolGroup) {
    snapToPool(spa);
  }

  scene.add(spa);
  purgeDetachedSpaArtifacts(scene, spa);
  spas.push(spa);
  setSelectedSpa(spa);

  return spa;
}

// --- Update SPA ---
export function updateSpa(spa) {
  if (!spa) return;
  snapToPool(spa);
  updateSpaWalls(spa);
  updateSpaSeats(spa);
  snapToPool(spa);
  purgeDetachedSpaArtifacts(spa.parent || null, spa);
}

// --- Update SPA dimensions ---
export function updateSpaDimensions(length, width) {
  if (!selectedSpa) return;
  selectedSpa.userData.spaLength = length;
  selectedSpa.userData.spaWidth = width;
  updateSpa(selectedSpa);
}

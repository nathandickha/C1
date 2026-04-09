// frontend/js/scene.js
// Safe override: no world-axis flips; HDRI aligned via sky-dome; ground void preserved
import * as THREE from "https://esm.sh/three@0.158.0";
import { OrbitControls } from "https://esm.sh/three@0.158.0/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "https://esm.sh/three@0.158.0/examples/jsm/environments/RoomEnvironment.js";
import { createPoolWater } from "./pool/water.js";

let dirLight;

const FAST_STARTUP = true;
const ENABLE_SPA_DEBUG_VOIDS = true;
const ENABLE_ORANGE_INTERIOR_DEBUG = false;
const ENABLE_ROOM_ENVIRONMENT = false;
const SHADOW_MAP_SIZE = FAST_STARTUP ? 1024 : 2048;

const RAISED_SPA_CHANNEL_GAP = 0.15; // 150mm clear gap from spa outer wall
const RAISED_SPA_CHANNEL_WALL_OFFSET = 0.45; // inner face of channel wall sits 450mm off spa
const RAISED_SPA_THRESHOLD_Z = 0.05; // 50mm above pool/ground
const SPA_GROUND_CLIP_MARGIN_REDUCTION = 0.20; // shrink magenta XY clip by 100mm per active side
const SPA_THROAT_ALONG_PAD = 0.12; // extend yellow throat clip 100mm+ past spa extents along the wall
const SPA_THROAT_WIDTH_EXTRA = 0.10; // widen yellow throat clip by 100mm across the wall opening

// Independent debug controls for the two throat void boxes shown in the scene.
// Yellow = existing spa-top-referenced throat void.
const SPA_THROAT_DEBUG_YELLOW_COLOR = 0xffdd00;
const SPA_THROAT_DEBUG_YELLOW_DEPTH = 0.30;
const SPA_THROAT_DEBUG_YELLOW_BOTTOM_PAD = 0.01;
const SPA_THROAT_DEBUG_YELLOW_TOP_PAD = 0.01;

// Blue = duplicate throat void locked to pool wall height / coping underside.
const SPA_THROAT_DEBUG_BLUE_COLOR = 0x00b7ff;
const SPA_THROAT_DEBUG_BLUE_DEPTH = 0.15;
const SPA_THROAT_DEBUG_BLUE_BOTTOM_PAD = 0.050;
const SPA_THROAT_DEBUG_BLUE_TOP_PAD = 0.01;

// Independent throat shortening along the wall (positive values shrink).
const SPA_THROAT_YELLOW_LENGTH_SHRINK = 0.02;
const SPA_THROAT_BLUE_LENGTH_SHRINK = 0.00;
const SPA_THROAT_BLUE_LENGTH_EXTRA = 0.035; // positive value extends blue throat further along wall

// Orange interior spa void debug box (separate from blue/yellow).
const SPA_INTERIOR_CLEAR_WALL_INSET_XY = 0.01;
const SPA_INTERIOR_CLEAR_EXTRA_INSET_XY = 0.00;
const SPA_INTERIOR_CLEAR_EXTRA_INSET_Z = 0.02;
const SPA_INTERIOR_CLEAR_DEBUG_COLOR = 0xff6600;
const SPA_CHANNEL_BRIDGE_EXTRA = 0.08; // extend the halfway-in-wall channel 80mm to close visual seams
const CIRCULAR_CHANNEL_COPING_WIDTH = 0.25; // circular spa coping rebuild width (250mm)

function getPoolFootprintWorldPts(poolGroup) {
  const outerPts = poolGroup?.userData?.outerPts;
  if (!Array.isArray(outerPts) || !outerPts.length) return null;

  const sx = (poolGroup.scale && isFinite(poolGroup.scale.x)) ? poolGroup.scale.x : 1;
  const sy = (poolGroup.scale && isFinite(poolGroup.scale.y)) ? poolGroup.scale.y : 1;
  const px = (poolGroup.position && isFinite(poolGroup.position.x)) ? poolGroup.position.x : 0;
  const py = (poolGroup.position && isFinite(poolGroup.position.y)) ? poolGroup.position.y : 0;

  return outerPts.map((v) => ({ x: v.x * sx + px, y: v.y * sy + py }));
}

function getPoolFootprintBoundsWorld(poolGroup) {
  const pts = getPoolFootprintWorldPts(poolGroup);
  if (!pts?.length) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (!p) continue;
    const x = Number.isFinite(p.x) ? p.x : 0;
    const y = Number.isFinite(p.y) ? p.y : 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY) || !Number.isFinite(maxY)) return null;
  return { minX, maxX, minY, maxY };
}

function isPointInsidePolygon2D(point, polygon) {
  if (!polygon || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    const intersects = ((yi > point.y) !== (yj > point.y)) &&
      (point.x < (xj - xi) * (point.y - yi) / ((yj - yi) || 1e-9) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function isPointInsidePoolFootprint(poolGroup, point) {
  const poly = getPoolFootprintWorldPts(poolGroup);
  if (!poly) return false;
  return isPointInsidePolygon2D(point, poly);
}

function getOutsideIntervalsAlongSide(center, axisAlong, axisAcross, acrossLocal, alongMin, alongMax, poolGroup) {
  const poly = getPoolFootprintWorldPts(poolGroup);
  if (!poly) return [[alongMin, alongMax]];

  const origin = center.clone().add(axisAcross.clone().multiplyScalar(acrossLocal));
  const ox = origin.x;
  const oy = origin.y;
  const dx = axisAlong.x;
  const dy = axisAlong.y;
  const denomEps = 1e-9;
  const pointEps = 1e-5;
  const rangeEps = 1e-4;

  const tValues = [alongMin, alongMax];

  const addT = (t) => {
    if (!isFinite(t) || t < alongMin - rangeEps || t > alongMax + rangeEps) return;
    const clamped = Math.max(alongMin, Math.min(alongMax, t));
    if (!tValues.some((v) => Math.abs(v - clamped) < 1e-5)) tValues.push(clamped);
  };

  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j];
    const b = poly[i];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const det = dx * (-ey) - dy * (-ex);

    if (Math.abs(det) < denomEps) continue;

    const rx = a.x - ox;
    const ry = a.y - oy;
    const t = (rx * (-ey) - ry * (-ex)) / det;
    const u = (dx * ry - dy * rx) / det;
    if (u >= -pointEps && u <= 1 + pointEps) addT(t);
  }

  tValues.sort((a, b) => a - b);

  const sampleOutside = (t) => {
    const p = {
      x: ox + dx * t,
      y: oy + dy * t
    };
    return !isPointInsidePolygon2D(p, poly);
  };

  const intervals = [];
  for (let i = 0; i < tValues.length - 1; i++) {
    const a = tValues[i];
    const b = tValues[i + 1];
    if (b - a <= rangeEps) continue;
    const mid = (a + b) * 0.5;
    if (sampleOutside(mid)) intervals.push([a, b]);
  }

  const startOutside = sampleOutside(alongMin + rangeEps);
  const endOutside = sampleOutside(alongMax - rangeEps);
  if (!intervals.length && (startOutside || endOutside)) return [[alongMin, alongMax]];

  return intervals;
}

function getSpaChannelMargin(spaGroup) {
  if (!spaGroup) return 0;
  spaGroup.updateMatrixWorld?.(true);
  const box = new THREE.Box3().setFromObject(spaGroup);
  return box.max.z > RAISED_SPA_THRESHOLD_Z ? RAISED_SPA_CHANNEL_WALL_OFFSET : 0;
}

function getSpaChannelMargins(spaGroup, poolGroup = null) {
  const channel = getSpaChannelMargin(spaGroup);
  const margins = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  if (!channel) return margins;
  if (!spaGroup || !poolGroup) {
    margins.minX = channel;
    margins.maxX = channel;
    margins.minY = channel;
    margins.maxY = channel;
    return margins;
  }

  const snapSide = spaGroup?.userData?.snapSide || null;
  const snapVariant = spaGroup?.userData?.snapVariant || null;
  const bounds = getPoolFootprintBoundsWorld(poolGroup);
  const spaBox = new THREE.Box3().setFromObject(spaGroup);
  const bridgeToPoolWall = {
    left: bounds ? Math.max(0, bounds.minX - spaBox.max.x) : 0,
    right: bounds ? Math.max(0, spaBox.min.x - bounds.maxX) : 0,
    front: bounds ? Math.max(0, bounds.minY - spaBox.max.y) : 0,
    back: bounds ? Math.max(0, spaBox.min.y - bounds.maxY) : 0
  };

  if (snapSide === 'left') {
    margins.minX = channel;
    margins.minY = channel;
    margins.maxY = channel;
    if (snapVariant === 'inner-wall-align') margins.maxX = Math.max(0, bridgeToPoolWall.left + SPA_CHANNEL_BRIDGE_EXTRA);
    return margins;
  }
  if (snapSide === 'right') {
    margins.maxX = channel;
    margins.minY = channel;
    margins.maxY = channel;
    if (snapVariant === 'inner-wall-align') margins.minX = Math.max(0, bridgeToPoolWall.right + SPA_CHANNEL_BRIDGE_EXTRA);
    return margins;
  }
  if (snapSide === 'front') {
    margins.minY = channel;
    margins.minX = channel;
    margins.maxX = channel;
    if (snapVariant === 'inner-wall-align') margins.maxY = Math.max(0, bridgeToPoolWall.front + SPA_CHANNEL_BRIDGE_EXTRA);
    return margins;
  }
  if (snapSide === 'back') {
    margins.maxY = channel;
    margins.minX = channel;
    margins.maxX = channel;
    if (snapVariant === 'inner-wall-align') margins.minY = Math.max(0, bridgeToPoolWall.back + SPA_CHANNEL_BRIDGE_EXTRA);
    return margins;
  }

  spaGroup.updateMatrixWorld?.(true);
  poolGroup.updateMatrixWorld?.(true);

  const center = new THREE.Vector3();
  spaGroup.getWorldPosition(center);

  const quat = new THREE.Quaternion();
  spaGroup.getWorldQuaternion(quat);

  const axisX = new THREE.Vector3(1, 0, 0).applyQuaternion(quat).normalize();
  const axisY = new THREE.Vector3(0, 1, 0).applyQuaternion(quat).normalize();

  const halfX = Math.max(0.005, (spaGroup.userData?.spaLength || 0.01) * 0.5);
  const halfY = Math.max(0.005, (spaGroup.userData?.spaWidth || 0.01) * 0.5);
  const sampleInset = 0.01;
  const sampleOut = 0.04;

  const isOutsidePool = (point) => !isPointInsidePoolFootprint(poolGroup, point);
  const samplePoint = (ax, dist) => center.clone().add(ax.clone().multiplyScalar(dist));

  if (isOutsidePool(samplePoint(axisX, -(halfX + sampleOut))) || isOutsidePool(samplePoint(axisX, -(halfX - sampleInset)))) margins.minX = channel;
  if (isOutsidePool(samplePoint(axisX, +(halfX + sampleOut))) || isOutsidePool(samplePoint(axisX, +(halfX - sampleInset)))) margins.maxX = channel;
  if (isOutsidePool(samplePoint(axisY, -(halfY + sampleOut))) || isOutsidePool(samplePoint(axisY, -(halfY - sampleInset)))) margins.minY = channel;
  if (isOutsidePool(samplePoint(axisY, +(halfY + sampleOut))) || isOutsidePool(samplePoint(axisY, +(halfY - sampleInset)))) margins.maxY = channel;

  return margins;
}

function getExpandedSpaWorldAABB(spaGroup, margins = null, pad = 0, marginReduction = 0) {
  if (!spaGroup) return null;

  spaGroup.updateMatrixWorld?.(true);

  const center = new THREE.Vector3();
  spaGroup.getWorldPosition(center);

  const quat = new THREE.Quaternion();
  spaGroup.getWorldQuaternion(quat);

  const axisX = new THREE.Vector3(1, 0, 0).applyQuaternion(quat).normalize();
  const axisY = new THREE.Vector3(0, 1, 0).applyQuaternion(quat).normalize();

  const halfX = Math.max(0.005, (spaGroup.userData?.spaLength || 0.01) * 0.5 + pad);
  const halfY = Math.max(0.005, (spaGroup.userData?.spaWidth || 0.01) * 0.5 + pad);
  const reducedMinX = Math.max(0, (margins?.minX || 0) - marginReduction);
  const reducedMaxX = Math.max(0, (margins?.maxX || 0) - marginReduction);
  const reducedMinY = Math.max(0, (margins?.minY || 0) - marginReduction);
  const reducedMaxY = Math.max(0, (margins?.maxY || 0) - marginReduction);

  const minX = -halfX - reducedMinX;
  const maxX =  halfX + reducedMaxX;
  const minY = -halfY - reducedMinY;
  const maxY =  halfY + reducedMaxY;

  const corners = [
    center.clone().add(axisX.clone().multiplyScalar(minX)).add(axisY.clone().multiplyScalar(minY)),
    center.clone().add(axisX.clone().multiplyScalar(minX)).add(axisY.clone().multiplyScalar(maxY)),
    center.clone().add(axisX.clone().multiplyScalar(maxX)).add(axisY.clone().multiplyScalar(minY)),
    center.clone().add(axisX.clone().multiplyScalar(maxX)).add(axisY.clone().multiplyScalar(maxY))
  ];

  const aabb = new THREE.Box3();
  corners.forEach((c) => aabb.expandByPoint(c));
  return { aabb, center, axisX, axisY, minX, maxX, minY, maxY };
}



function getAllPoolCopingMeshes(poolGroup) {
  const copingSegments = poolGroup?.userData?.copingSegments;
  if (!copingSegments) return [];
  if (Array.isArray(copingSegments)) return copingSegments.filter(Boolean);
  if (typeof copingSegments === 'object') return Object.values(copingSegments).filter(Boolean);
  return [];
}

function buildBulletproofCopingMeshSet(poolGroup) {
  const set = new Set();
  const direct = getAllPoolCopingMeshes(poolGroup);

  // 1) Add direct coping segment refs and all descendant meshes.
  direct.forEach((entry) => {
    if (!entry) return;
    if (entry.isMesh) set.add(entry);
    entry.traverse?.((child) => {
      if (child?.isMesh) set.add(child);
    });
  });

  // 2) Fallback by naming / userData conventions.
  poolGroup?.traverse?.((obj) => {
    if (!obj?.isMesh) return;
    const n = String(obj.name || '').toLowerCase();
    if (n.includes('coping')) set.add(obj);
    if (obj.userData?.isCoping || obj.userData?.coping === true) set.add(obj);
  });

  // 3) Fallback by shared material identity with known coping segments.
  const copingMaterials = new Set();
  direct.forEach((entry) => {
    entry?.traverse?.((child) => {
      if (!child?.isMesh) return;
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach((m) => { if (m) copingMaterials.add(m); });
    });
    if (entry?.isMesh) {
      const mats = Array.isArray(entry.material) ? entry.material : [entry.material];
      mats.forEach((m) => { if (m) copingMaterials.add(m); });
    }
  });

  if (copingMaterials.size) {
    poolGroup?.traverse?.((obj) => {
      if (!obj?.isMesh) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      if (mats.some((m) => copingMaterials.has(m))) set.add(obj);
    });
  }

  return set;
}

function shrinkThroatBoxAlongWall(throat, spaGroup, shrink = 0) {
  if (!throat) return null;

  const out = { ...throat };
  const amount = Math.max(0, shrink || 0);

  if (Number.isFinite(out.halfAlong)) {
    out.halfAlong = Math.max(0.005, out.halfAlong - amount);
    return out;
  }

  const snapSide = spaGroup?.userData?.snapSide || null;
  if (snapSide === 'left' || snapSide === 'right') {
    const maxShrink = Math.max(0, (out.maxY - out.minY - 0.01) * 0.5);
    const s = Math.min(amount, maxShrink);
    out.minY += s;
    out.maxY -= s;
  } else if (snapSide === 'front' || snapSide === 'back') {
    const maxShrink = Math.max(0, (out.maxX - out.minX - 0.01) * 0.5);
    const s = Math.min(amount, maxShrink);
    out.minX += s;
    out.maxX -= s;
  }

  return out;
}

function extendThroatBoxAlongWall(throat, spaGroup, extra = 0) {
  if (!throat) return null;

  const out = { ...throat };
  const amount = Math.max(0, extra || 0);

  if (Number.isFinite(out.halfAlong)) {
    out.halfAlong = Math.max(0.005, out.halfAlong + amount);
    return out;
  }

  const snapSide = spaGroup?.userData?.snapSide || null;
  if (snapSide === 'left' || snapSide === 'right') {
    out.minY -= amount;
    out.maxY += amount;
  } else if (snapSide === 'front' || snapSide === 'back') {
    out.minX -= amount;
    out.maxX += amount;
  }

  return out;
}

function getSpaInteriorClearBox(spaGroup) {
  if (!spaGroup) return null;
  spaGroup.updateMatrixWorld?.(true);

  const box = new THREE.Box3().setFromObject(spaGroup);
  if (!isFinite(box.min.x) || !isFinite(box.max.x)) return null;

  const insetXY = Math.max(0, SPA_INTERIOR_CLEAR_WALL_INSET_XY + SPA_INTERIOR_CLEAR_EXTRA_INSET_XY);
  const insetZ = Math.max(0, SPA_INTERIOR_CLEAR_EXTRA_INSET_Z);
  const minZ = box.min.z + insetZ;
  const maxZ = box.max.z - insetZ;
  if (!(maxZ > minZ)) return null;

  if (spaGroup?.userData?.spaShape === 'circular') {
    const center = new THREE.Vector3();
    spaGroup.getWorldPosition(center);
    const baseRadius = Math.max(0.01, (spaGroup.userData?.spaLength || spaGroup.userData?.spaWidth || 0.01) * 0.5);
    const radius = baseRadius - insetXY;
    if (!(radius > 0.01)) return null;
    return {
      shape: 'circular',
      centerX: center.x,
      centerY: center.y,
      radius,
      minZ,
      maxZ
    };
  }

  const minX = box.min.x + insetXY;
  const maxX = box.max.x - insetXY;
  const minY = box.min.y + insetXY;
  const maxY = box.max.y - insetXY;

  if (!(maxX > minX && maxY > minY)) return null;
  return { shape: 'rect', minX, maxX, minY, maxY, minZ, maxZ };
}

function getSpaPoolWallSamplePoint(poolGroup, spaGroup) {
  if (!spaGroup) return null;
  spaGroup.updateMatrixWorld?.(true);
  const quat = new THREE.Quaternion();
  spaGroup.getWorldQuaternion(quat);
  const center = new THREE.Vector3();
  spaGroup.getWorldPosition(center);
  const axisX = new THREE.Vector3(1, 0, 0).applyQuaternion(quat).normalize();
  const axisY = new THREE.Vector3(0, 1, 0).applyQuaternion(quat).normalize();
  const halfX = Math.max(0.005, (spaGroup.userData?.spaLength || 0.01) * 0.5);
  const halfY = Math.max(0.005, (spaGroup.userData?.spaWidth || 0.01) * 0.5);
  const snapSide = spaGroup?.userData?.snapSide || null;
  if (snapSide === 'left') return center.clone().add(axisX.multiplyScalar(-halfX));
  if (snapSide === 'right') return center.clone().add(axisX.multiplyScalar(halfX));
  if (snapSide === 'front') return center.clone().add(axisY.multiplyScalar(-halfY));
  if (snapSide === 'back') return center.clone().add(axisY.multiplyScalar(halfY));
  return center;
}

function getAdjacentPoolCopingBounds(poolGroup, spaGroup) {
  const copingMeshes = getAllPoolCopingMeshes(poolGroup);
  if (!copingMeshes.length) return null;

  const sample = getSpaPoolWallSamplePoint(poolGroup, spaGroup);
  let best = null;
  let bestDistSq = Infinity;

  for (const mesh of copingMeshes) {
    if (!mesh) continue;
    mesh.updateMatrixWorld?.(true);
    const box = new THREE.Box3().setFromObject(mesh);
    if (!isFinite(box.min.z) || !isFinite(box.max.z)) continue;

    if (!sample) {
      const zSpan = box.max.z - box.min.z;
      if (!best || zSpan > (best.max.z - best.min.z)) best = box.clone();
      continue;
    }

    const clampedX = Math.max(box.min.x, Math.min(sample.x, box.max.x));
    const clampedY = Math.max(box.min.y, Math.min(sample.y, box.max.y));
    const dx = sample.x - clampedX;
    const dy = sample.y - clampedY;
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      best = box.clone();
    }
  }

  return best;
}

function getPoolCopingUndersideZ(poolGroup, spaGroup) {
  const box = getAdjacentPoolCopingBounds(poolGroup, spaGroup);
  if (box && isFinite(box.min.z)) return box.min.z;
  return -0.05;
}

function getPoolCopingTopZ(poolGroup, spaGroup) {
  const box = getAdjacentPoolCopingBounds(poolGroup, spaGroup);
  if (box && isFinite(box.max.z)) return box.max.z;
  return 0.05;
}


function transformPoolPlanPointToWorld(poolGroup, point) {
  const p = point?.isVector2 ? point : new THREE.Vector2(Number(point?.x) || 0, Number(point?.y) || 0);
  const sx = (poolGroup?.scale && isFinite(poolGroup.scale.x)) ? poolGroup.scale.x : 1;
  const sy = (poolGroup?.scale && isFinite(poolGroup.scale.y)) ? poolGroup.scale.y : 1;
  const px = (poolGroup?.position && isFinite(poolGroup.position.x)) ? poolGroup.position.x : 0;
  const py = (poolGroup?.position && isFinite(poolGroup.position.y)) ? poolGroup.position.y : 0;
  return new THREE.Vector2(p.x * sx + px, p.y * sy + py);
}

function projectPointToSegment2D(point, a, b) {
  const ab = b.clone().sub(a);
  const lenSq = ab.lengthSq();
  if (lenSq <= 1e-10) return a.clone();
  let t = point.clone().sub(a).dot(ab) / lenSq;
  t = THREE.MathUtils.clamp(t, 0, 1);
  return a.clone().add(ab.multiplyScalar(t));
}

function getSpaWorldSnapEdge(poolGroup, spaGroup) {
  const edge = spaGroup?.userData?.snapEdge;
  if (!edge?.p0 || !edge?.p1) return null;

  const p0 = transformPoolPlanPointToWorld(poolGroup, edge.p0);
  const p1 = transformPoolPlanPointToWorld(poolGroup, edge.p1);
  const tangent = p1.clone().sub(p0);
  const length = tangent.length();
  if (length <= 1e-6) return null;
  tangent.divideScalar(length);

  let normal = edge?.normal?.isVector2 ? edge.normal.clone() : null;
  if (!normal || normal.lengthSq() <= 1e-10) {
    normal = new THREE.Vector2(-tangent.y, tangent.x);
  }
  normal.normalize();

  return {
    p0,
    p1,
    tangent,
    normal,
    length
  };
}

function makeOrientedThroatVolume(poolGroup, spaGroup, pad = 0.01) {
  const snapEdge = getSpaWorldSnapEdge(poolGroup, spaGroup);
  if (!snapEdge) return null;

  spaGroup.updateMatrixWorld?.(true);
  const spaCenter3 = new THREE.Vector3();
  spaGroup.getWorldPosition(spaCenter3);
  const spaCenter = new THREE.Vector2(spaCenter3.x, spaCenter3.y);
  const edgePoint = projectPointToSegment2D(spaCenter, snapEdge.p0, snapEdge.p1);

  const halfX = Math.max(0.005, (spaGroup.userData?.spaLength || 0.01) * 0.5);
  const halfY = Math.max(0.005, (spaGroup.userData?.spaWidth || 0.01) * 0.5);
  const spanAlong = spaGroup?.userData?.spaShape === 'circular'
    ? Math.max(halfX, halfY)
    : Math.abs(snapEdge.tangent.x) * halfX + Math.abs(snapEdge.tangent.y) * halfY;

  const insidePad = (0.05 + pad) * 3.0 + 0.30;
  const outsideDepth = (0.21 + pad) * 3.0;
  const alongPad = SPA_THROAT_ALONG_PAD + SPA_THROAT_WIDTH_EXTRA;
  const halfAlong = Math.max(0.01, spanAlong + alongPad);
  const halfDepth = Math.max(0.01, (insidePad + outsideDepth) * 0.5);
  const center2 = edgePoint.clone().add(snapEdge.normal.clone().multiplyScalar((insidePad - outsideDepth) * 0.5));
  const angle = Math.atan2(snapEdge.tangent.y, snapEdge.tangent.x);
  const quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), angle);

  return {
    center2,
    tangent: snapEdge.tangent.clone(),
    normal: snapEdge.normal.clone(),
    halfAlong,
    halfDepth,
    quat
  };
}

function makeAabbFromOrientedVolume(volume) {
  if (!volume) return null;
  const t = volume.tangent.clone().multiplyScalar(volume.halfAlong);
  const n = volume.normal.clone().multiplyScalar(volume.halfDepth);
  const pts = [
    volume.center2.clone().add(t).add(n),
    volume.center2.clone().add(t).sub(n),
    volume.center2.clone().sub(t).add(n),
    volume.center2.clone().sub(t).sub(n)
  ];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, maxX, minY, maxY };
}

function makeClipPlanesFromOrientedVolume(volume, minZ, maxZ) {
  if (!volume) return null;
  const center3 = new THREE.Vector3(volume.center2.x, volume.center2.y, 0);
  const tangent3 = new THREE.Vector3(volume.tangent.x, volume.tangent.y, 0).normalize();
  const normal3 = new THREE.Vector3(volume.normal.x, volume.normal.y, 0).normalize();

  const pTNeg = center3.clone().addScaledVector(tangent3, -volume.halfAlong);
  const pTPos = center3.clone().addScaledVector(tangent3, volume.halfAlong);
  const pNNeg = center3.clone().addScaledVector(normal3, -volume.halfDepth);
  const pNPos = center3.clone().addScaledVector(normal3, volume.halfDepth);

  return [
    new THREE.Plane().setFromNormalAndCoplanarPoint(tangent3.clone().negate(), pTNeg),
    new THREE.Plane().setFromNormalAndCoplanarPoint(tangent3.clone(), pTPos),
    new THREE.Plane().setFromNormalAndCoplanarPoint(normal3.clone().negate(), pNNeg),
    new THREE.Plane().setFromNormalAndCoplanarPoint(normal3.clone(), pNPos),
    new THREE.Plane(new THREE.Vector3(0, 0, -1), minZ),
    new THREE.Plane(new THREE.Vector3(0, 0, 1), -maxZ)
  ];
}


function createDebugTransparentMaterial(color, opacity = 0.22) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide
  });
}

function ensureSpaDebugGroup(scene) {
  if (!scene) return null;
  if (scene.userData?.spaVoidDebugGroup) return scene.userData.spaVoidDebugGroup;
  const group = new THREE.Group();
  group.name = 'SpaVoidDebugGroup';
  scene.add(group);
  scene.userData = scene.userData || {};
  scene.userData.spaVoidDebugGroup = group;
  return group;
}

function clearSpaDebugGroup(scene) {
  const group = scene?.userData?.spaVoidDebugGroup;
  if (!group) return;
  while (group.children.length) {
    const child = group.children.pop();
    child.geometry?.dispose?.();
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    mats.forEach((m) => m?.dispose?.());
    group.remove(child);
  }
}

function addDebugBox(group, sizeX, sizeY, sizeZ, worldCenter, quat, color, name) {
  if (!group || !(sizeX > 1e-4) || !(sizeY > 1e-4) || !(sizeZ > 1e-4)) return;
  const fill = new THREE.Mesh(
    new THREE.BoxGeometry(sizeX, sizeY, sizeZ),
    createDebugTransparentMaterial(color, 0.18)
  );
  fill.position.copy(worldCenter);
  if (quat) fill.quaternion.copy(quat);
  fill.renderOrder = 999;
  fill.name = name;
  group.add(fill);

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(sizeX, sizeY, sizeZ)),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 })
  );
  edges.position.copy(worldCenter);
  if (quat) edges.quaternion.copy(quat);
  edges.renderOrder = 1000;
  edges.name = `${name}_edges`;
  group.add(edges);
}


function addDebugCircularDisc(group, radius, worldCenter, quat, color, name, opacity = 0.18, radialSegments = 96) {
  if (!group || !(radius > 1e-4)) return;
  const geo = new THREE.CircleGeometry(radius, radialSegments);
  const mesh = new THREE.Mesh(geo, createDebugTransparentMaterial(color, opacity));
  mesh.position.copy(worldCenter);
  if (quat) mesh.quaternion.copy(quat);
  mesh.renderOrder = 999;
  mesh.name = name;
  group.add(mesh);

  const edgeGeo = new THREE.EdgesGeometry(geo);
  const edges = new THREE.LineSegments(
    edgeGeo,
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 })
  );
  edges.position.copy(worldCenter);
  if (quat) edges.quaternion.copy(quat);
  edges.renderOrder = 1000;
  edges.name = `${name}_edges`;
  group.add(edges);
}

function addDebugCircularRing(group, innerRadius, outerRadius, worldCenter, quat, color, name, opacity = 0.18, radialSegments = 96) {
  if (!group || !(outerRadius > innerRadius) || !(outerRadius > 1e-4)) return;
  const shape = new THREE.Shape();
  shape.absarc(0, 0, outerRadius, 0, Math.PI * 2, false);
  const hole = new THREE.Path();
  hole.absarc(0, 0, Math.max(0.0001, innerRadius), 0, Math.PI * 2, true);
  shape.holes.push(hole);
  const geo = new THREE.ShapeGeometry(shape, radialSegments);
  const mesh = new THREE.Mesh(geo, createDebugTransparentMaterial(color, opacity));
  mesh.position.copy(worldCenter);
  if (quat) mesh.quaternion.copy(quat);
  mesh.renderOrder = 999;
  mesh.name = name;
  group.add(mesh);

  const outerPts = [];
  const innerPts = [];
  for (let i = 0; i <= radialSegments; i++) {
    const a = (i / radialSegments) * Math.PI * 2;
    outerPts.push(new THREE.Vector3(Math.cos(a) * outerRadius, Math.sin(a) * outerRadius, 0));
    innerPts.push(new THREE.Vector3(Math.cos(a) * innerRadius, Math.sin(a) * innerRadius, 0));
  }
  for (const [pts, suffix] of [[outerPts, 'outer'], [innerPts, 'inner']]) {
    const lineGeo = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.Line(
      lineGeo,
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 })
    );
    line.position.copy(worldCenter);
    if (quat) line.quaternion.copy(quat);
    line.renderOrder = 1000;
    line.name = `${name}_${suffix}`;
    group.add(line);
  }
}

function addDebugCylinder(group, radius, height, worldCenter, quat, color, name, opacity = 0.18, radialSegments = 96) {
  if (!group || !(radius > 1e-4) || !(height > 1e-4)) return;
  const geo = new THREE.CylinderGeometry(radius, radius, height, radialSegments, 1, false);
  geo.rotateX(Math.PI * 0.5);
  const mesh = new THREE.Mesh(geo, createDebugTransparentMaterial(color, opacity));
  mesh.position.copy(worldCenter);
  if (quat) mesh.quaternion.copy(quat);
  mesh.renderOrder = 999;
  mesh.name = name;
  group.add(mesh);

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geo),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 })
  );
  edges.position.copy(worldCenter);
  if (quat) edges.quaternion.copy(quat);
  edges.renderOrder = 1000;
  edges.name = `${name}_edges`;
  group.add(edges);
}

function addDebugPoolVoidMesh(group, holePts, groundZ = 0) {
  if (!group || !Array.isArray(holePts) || holePts.length < 3) return;
  const shape = new THREE.Shape(holePts);
  const geo = new THREE.ShapeGeometry(shape);
  const mesh = new THREE.Mesh(geo, createDebugTransparentMaterial(0x00d0ff, 0.16));
  mesh.position.z = groundZ + 0.003;
  mesh.renderOrder = 998;
  mesh.name = 'PoolVoidDebug';
  group.add(mesh);

  const pts = [...holePts, holePts[0]].map((v) => new THREE.Vector3(v.x, v.y, groundZ + 0.01));
  const lineGeo = new THREE.BufferGeometry().setFromPoints(pts);
  const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0x00d0ff, transparent: true, opacity: 0.95 }));
  line.renderOrder = 1001;
  line.name = 'PoolVoidDebugOutline';
  group.add(line);
}

function updateSpaVoidDebug(scene, ground, poolGroup, spaGroup, holePts = null) {
  if (!ENABLE_SPA_DEBUG_VOIDS && !ENABLE_ORANGE_INTERIOR_DEBUG) {
    clearSpaDebugGroup(scene || ground?.parent);
    return;
  }
  const group = ensureSpaDebugGroup(scene || ground?.parent);
  if (!group) return;
  clearSpaDebugGroup(scene || ground?.parent);

  const debugScene = scene || ground?.parent;
  const groundZ = ground?.position?.z ?? 0;

  if (ENABLE_SPA_DEBUG_VOIDS) {
    // 1) Pool footprint void (cyan)
    if (holePts?.length) addDebugPoolVoidMesh(group, holePts, groundZ);
  }

  if (!spaGroup) return;

  spaGroup.updateMatrixWorld?.(true);
  const quat = new THREE.Quaternion();
  spaGroup.getWorldQuaternion(quat);
  const center = new THREE.Vector3();
  spaGroup.getWorldPosition(center);
  const axisX = new THREE.Vector3(1, 0, 0).applyQuaternion(quat).normalize();
  const axisY = new THREE.Vector3(0, 1, 0).applyQuaternion(quat).normalize();

  if (ENABLE_SPA_DEBUG_VOIDS) {
  // 2) Ground material spa clip region (magenta)
  const margins = getSpaChannelMargins(spaGroup, poolGroup);
  const expanded = getExpandedSpaWorldAABB(spaGroup, margins, 0.02, SPA_GROUND_CLIP_MARGIN_REDUCTION);
  if (expanded) {
    const offsetX = (expanded.maxX + expanded.minX) * 0.5;
    const offsetY = (expanded.maxY + expanded.minY) * 0.5;
    const clipCenter = expanded.center.clone()
      .add(expanded.axisX.clone().multiplyScalar(offsetX))
      .add(expanded.axisY.clone().multiplyScalar(offsetY));
    const debugCenter = new THREE.Vector3(clipCenter.x, clipCenter.y, groundZ + 0.015);
    if (spaGroup?.userData?.spaShape === 'circular') {
      const clipRadius = Math.max(0.01, (spaGroup.userData?.spaLength || 0.01) * 0.5 + Math.max(margins.minX, margins.maxX, margins.minY, margins.maxY) - SPA_GROUND_CLIP_MARGIN_REDUCTION + 0.02);
      addDebugCircularDisc(group, clipRadius, debugCenter, quat, 0xff00aa, 'SpaGroundClipDebug');
    } else {
      addDebugBox(
        group,
        Math.max(0.01, expanded.maxX - expanded.minX),
        Math.max(0.01, expanded.maxY - expanded.minY),
        0.03,
        debugCenter,
        quat,
        0xff00aa,
        'SpaGroundClipDebug'
      );
    }
  }

  // 3) Pool throat / wall clip region (yellow + blue with independent length shrink)
  const clipVolumes = getSpaClipVolumes(poolGroup, spaGroup, 0.01);
  if (clipVolumes) {
    const {
      yellowClipBox,
      blueClipBox,
      yellowMinZ,
      yellowMaxZ,
      blueMinZ,
      blueMaxZ
    } = clipVolumes;

    const yellowCenter = clipVolumes.yellowOriented
      ? new THREE.Vector3(clipVolumes.yellowOriented.center2.x, clipVolumes.yellowOriented.center2.y, (yellowMinZ + yellowMaxZ) * 0.5)
      : new THREE.Vector3(
          (yellowClipBox.minX + yellowClipBox.maxX) * 0.5,
          (yellowClipBox.minY + yellowClipBox.maxY) * 0.5,
          (yellowMinZ + yellowMaxZ) * 0.5
        );
    addDebugBox(
      group,
      clipVolumes.yellowOriented ? Math.max(0.01, clipVolumes.yellowOriented.halfAlong * 2) : Math.max(0.01, yellowClipBox.maxX - yellowClipBox.minX),
      clipVolumes.yellowOriented ? Math.max(0.01, clipVolumes.yellowOriented.halfDepth * 2) : Math.max(0.01, yellowClipBox.maxY - yellowClipBox.minY),
      Math.max(0.01, yellowMaxZ - yellowMinZ),
      yellowCenter,
      clipVolumes.yellowOriented ? clipVolumes.yellowOriented.quat : null,
      SPA_THROAT_DEBUG_YELLOW_COLOR,
      'SpaThroatClipDebug'
    );

    const blueCenter = clipVolumes.blueOriented
      ? new THREE.Vector3(clipVolumes.blueOriented.center2.x, clipVolumes.blueOriented.center2.y, (blueMinZ + blueMaxZ) * 0.5)
      : new THREE.Vector3(
          (blueClipBox.minX + blueClipBox.maxX) * 0.5,
          (blueClipBox.minY + blueClipBox.maxY) * 0.5,
          (blueMinZ + blueMaxZ) * 0.5
        );
    addDebugBox(
      group,
      clipVolumes.blueOriented ? Math.max(0.01, clipVolumes.blueOriented.halfAlong * 2) : Math.max(0.01, blueClipBox.maxX - blueClipBox.minX),
      clipVolumes.blueOriented ? Math.max(0.01, clipVolumes.blueOriented.halfDepth * 2) : Math.max(0.01, blueClipBox.maxY - blueClipBox.minY),
      Math.max(0.01, blueMaxZ - blueMinZ),
      blueCenter,
      clipVolumes.blueOriented ? clipVolumes.blueOriented.quat : null,
      SPA_THROAT_DEBUG_BLUE_COLOR,
      'SpaThroatClipDebugUnderCoping'
    );
  }
  }

  if (ENABLE_ORANGE_INTERIOR_DEBUG) {
    const interiorClear = getSpaInteriorClearBox(spaGroup);
    if (interiorClear) {
      if (spaGroup?.userData?.spaShape === 'circular') {
        const interiorCenter = new THREE.Vector3(
          interiorClear.centerX,
          interiorClear.centerY,
          (interiorClear.minZ + interiorClear.maxZ) * 0.5
        );
        addDebugCylinder(group, Math.max(0.01, interiorClear.radius), Math.max(0.01, interiorClear.maxZ - interiorClear.minZ), interiorCenter, quat, SPA_INTERIOR_CLEAR_DEBUG_COLOR, 'SpaInteriorClearDebug');
      } else {
        const interiorCenter = new THREE.Vector3(
          (interiorClear.minX + interiorClear.maxX) * 0.5,
          (interiorClear.minY + interiorClear.maxY) * 0.5,
          (interiorClear.minZ + interiorClear.maxZ) * 0.5
        );
        addDebugBox(
          group,
          Math.max(0.01, interiorClear.maxX - interiorClear.minX),
          Math.max(0.01, interiorClear.maxY - interiorClear.minY),
          Math.max(0.01, interiorClear.maxZ - interiorClear.minZ),
          interiorCenter,
          null,
          SPA_INTERIOR_CLEAR_DEBUG_COLOR,
          'SpaInteriorClearDebug'
        );
      }
    }
  }

  // 4) Actual spa body extents (green) for reference only
  const spaBox = new THREE.Box3().setFromObject(spaGroup);
  const spaSize = spaBox.getSize(new THREE.Vector3());
  const spaCenter = spaBox.getCenter(new THREE.Vector3());
  if (ENABLE_SPA_DEBUG_VOIDS) addDebugBox(group, spaSize.x, spaSize.y, Math.max(0.01, spaSize.z), spaCenter, quat, 0x00ff66, 'SpaBodyDebug');
}

function disposeObject3D(obj) {
  if (!obj) return;
  obj.traverse?.((child) => {
    if (child?.geometry) child.geometry.dispose?.();
    const mats = Array.isArray(child?.material) ? child.material : [child?.material];
    mats.forEach((m) => m?.dispose?.());
  });
}

function clearSpaChannelMeshes(ground) {
  const parent = ground?.parent;
  const group = ground?.userData?.spaChannelGroup;
  const waterGroup = ground?.userData?.spaChannelWaterGroup;
  if (group && parent) parent.remove(group);
  if (waterGroup && parent) parent.remove(waterGroup);
  disposeObject3D(group);
  disposeObject3D(waterGroup);
  if (ground?.userData) {
    ground.userData.spaChannelGroup = null;
    ground.userData.spaChannelWaterGroup = null;
  }
}

function isDescendantOf(obj, ancestor) {
  let cur = obj;
  while (cur) {
    if (cur === ancestor) return true;
    cur = cur.parent || null;
  }
  return false;
}

export function purgeDetachedSpaChannelArtifacts(scene, activeGroup = null, activeWaterGroup = null) {
  if (!scene?.traverse) return;
  const staleMeshes = [];
  const staleGroups = [];
  scene.traverse((obj) => {
    if (obj?.userData?.isSpaChannel) {
      if (!activeGroup || !isDescendantOf(obj, activeGroup)) staleMeshes.push(obj);
    }
    if (obj?.userData?.isSpaChannelWater) {
      if (!activeWaterGroup || !isDescendantOf(obj, activeWaterGroup)) staleMeshes.push(obj);
    }
    if (obj?.type === 'Group' && obj?.name === 'SpaChannelGroup' && obj !== activeGroup) {
      staleGroups.push(obj);
    }
    if (obj?.type === 'Group' && obj?.name === 'SpaChannelWaterGroup' && obj !== activeWaterGroup) {
      staleGroups.push(obj);
    }
  });

  staleMeshes.forEach((obj) => {
    obj.parent?.remove?.(obj);
    obj.geometry?.dispose?.();
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    mats.forEach((m) => m?.dispose?.());
  });

  staleGroups.forEach((group) => {
    group.parent?.remove?.(group);
    disposeObject3D(group);
  });
}

function generateMeterUVsForBoxGeometry(geo, tileSize = 0.3) {
  const pos = geo?.attributes?.position;
  const nrm = geo?.attributes?.normal;
  if (!pos || !nrm) return;
  const uvs = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const ax = Math.abs(nrm.getX(i));
    const ay = Math.abs(nrm.getY(i));
    const az = Math.abs(nrm.getZ(i));
    let u = 0, v = 0;
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
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  if (!geo.attributes.uv2) geo.setAttribute('uv2', new THREE.BufferAttribute(uvs.slice(), 2));
}

function generateMeterUVsForCircularDiscGeometry(geo, tileSize = 0.3) {
  const pos = geo?.attributes?.position;
  if (!pos) return;
  const uvs = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const usePlanar = Math.abs(z) <= Math.abs(y);
    uvs[i * 2] = x / tileSize;
    uvs[i * 2 + 1] = (usePlanar ? y : z) / tileSize;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  if (!geo.attributes.uv2) geo.setAttribute('uv2', new THREE.BufferAttribute(uvs.slice(), 2));
}

function generateMeterUVsForCircularRingGeometry(geo, tileSize = 0.3) {
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

  target.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  if (!target.attributes.uv2) target.setAttribute('uv2', new THREE.BufferAttribute(uvs.slice(), 2));
  return target;
}

function createSpaChannelMaterial(spaGroup) {
  const source = spaGroup?.userData?.floor?.material || spaGroup?.userData?.walls?.front?.material || null;
  if (source?.clone) {
    const cloned = source.clone();
    cloned.transparent = false;
    cloned.opacity = 1;
    return cloned;
  }
  return new THREE.MeshStandardMaterial({
    color: 0xa9bcc8,
    roughness: 0.85,
    metalness: 0.0
  });
}

function createCopingRebuildMaterial(poolGroup) {
  const source = poolGroup?.userData?.copingSegments?.[0]?.material || null;
  if (source?.clone) {
    const cloned = source.clone();
    cloned.transparent = false;
    cloned.opacity = 1;
    return cloned;
  }
  return new THREE.MeshStandardMaterial({
    color: 0xe5e0d8,
    roughness: 0.9,
    metalness: 0.0
  });
}

function getForcedSpaChannelFullSpanSides(spaGroup) {
  const snapSide = spaGroup?.userData?.snapSide || null;
  if (snapSide === 'left') return new Set(['minX', 'minY', 'maxY']);
  if (snapSide === 'right') return new Set(['maxX', 'minY', 'maxY']);
  if (snapSide === 'front') return new Set(['minY', 'minX', 'maxX']);
  if (snapSide === 'back') return new Set(['maxY', 'minX', 'maxX']);
  return new Set();
}

function addChannelBox(group, sizeX, sizeY, sizeZ, localX, localY, center, axisX, axisY, quat, material, zCenter, tileSize = 0.3) {
  if (!(sizeX > 1e-4 && sizeY > 1e-4 && sizeZ > 1e-4)) return;
  const geo = new THREE.BoxGeometry(sizeX, sizeY, sizeZ);
  generateMeterUVsForBoxGeometry(geo, tileSize);
  const mesh = new THREE.Mesh(geo, material.clone());
  const worldPos = center.clone().add(axisX.clone().multiplyScalar(localX)).add(axisY.clone().multiplyScalar(localY));
  mesh.position.set(worldPos.x, worldPos.y, zCenter); mesh.quaternion.copy(quat); mesh.castShadow = true; mesh.receiveShadow = true; mesh.userData.isSpaChannel = true; group.add(mesh);
}
function createCircularArcBandShape(innerRadius, outerRadius, startAngle, endAngle) {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, Math.max(0.01, outerRadius), startAngle, endAngle, false);
  shape.absarc(0, 0, Math.max(0.005, innerRadius), endAngle, startAngle, true);
  shape.closePath();
  return shape;
}
function addCircularChannelExtrude(group, shape, depth, localZ, center, quat, material, tileSize = 0.3) {
  if (!group || !shape || !(depth > 1e-4)) return;
  const baseGeo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, steps: 1, curveSegments: 48 }); baseGeo.computeVertexNormals();
  const geo = generateMeterUVsForCircularRingGeometry(baseGeo, tileSize);
  const mesh = new THREE.Mesh(geo, material.clone()); mesh.position.set(center.x, center.y, localZ); mesh.quaternion.copy(quat); mesh.castShadow = true; mesh.receiveShadow = true; mesh.userData.isSpaChannel = true; group.add(mesh);
}

function createSpaChannelWaterMesh(geometry) {
  const water = createPoolWater(geometry);
  water.userData.isSpaChannelWater = true;
  return water;
}

function addChannelWaterPlane(group, sizeX, sizeY, localX, localY, center, axisX, axisY, quat, zWorld) {
  if (!group || !(sizeX > 1e-4 && sizeY > 1e-4)) return;
  const segX = Math.max(12, Math.ceil(sizeX * 24));
  const segY = Math.max(12, Math.ceil(sizeY * 24));
  const geo = new THREE.PlaneGeometry(sizeX, sizeY, segX, segY);
  const mesh = createSpaChannelWaterMesh(geo);
  const worldPos = center.clone().add(axisX.clone().multiplyScalar(localX)).add(axisY.clone().multiplyScalar(localY));
  mesh.position.set(worldPos.x, worldPos.y, zWorld + 0.001);
  mesh.quaternion.copy(quat);
  group.add(mesh);
}

function addCircularChannelWaterArc(group, innerRadius, outerRadius, startAngle, endAngle, center, quat, zWorld) {
  if (!group || !(outerRadius > innerRadius)) return;
  const thetaLength = Math.max(0.01, endAngle - startAngle);
  const geo = new THREE.RingGeometry(Math.max(0.01, innerRadius), Math.max(0.02, outerRadius), 96, 12, startAngle, thetaLength);
  const mesh = createSpaChannelWaterMesh(geo);
  mesh.position.set(center.x, center.y, zWorld + 0.001);
  mesh.quaternion.copy(quat);
  group.add(mesh);
}

function updateSpaChannelMeshes(ground, poolGroup, spaGroup) {
  if (!ground || !poolGroup || !spaGroup) {
    clearSpaChannelMeshes(ground);
    return;
  }

  if (!spaGroup.userData?.isHalfwayInWall) {
    clearSpaChannelMeshes(ground);
    return;
  }

  const margins = getSpaChannelMargins(spaGroup, poolGroup);
  if (!(margins.minX > 0 || margins.maxX > 0 || margins.minY > 0 || margins.maxY > 0)) {
    clearSpaChannelMeshes(ground);
    return;
  }

  spaGroup.updateMatrixWorld?.(true);
  const quat = new THREE.Quaternion();
  spaGroup.getWorldQuaternion(quat);
  const center = new THREE.Vector3();
  spaGroup.getWorldPosition(center);
  const axisX = new THREE.Vector3(1, 0, 0).applyQuaternion(quat).normalize();
  const axisY = new THREE.Vector3(0, 1, 0).applyQuaternion(quat).normalize();
  const halfX = Math.max(0.005, (spaGroup.userData?.spaLength || 0.01) * 0.5);
  const halfY = Math.max(0.005, (spaGroup.userData?.spaWidth || 0.01) * 0.5);

  const minX = -halfX - (margins.minX || 0);
  const maxX =  halfX + (margins.maxX || 0);
  const minY = -halfY - (margins.minY || 0);
  const maxY =  halfY + (margins.maxY || 0);

  const snapSide = spaGroup.userData?.snapSide || null;
  const snapVariant = spaGroup.userData?.snapVariant || null;
  const suppressPoolFacingBridgeWall = snapVariant === 'inner-wall-align';

  const copingUnderZ = getPoolCopingUndersideZ(poolGroup, spaGroup);
  const copingTopZ = getPoolCopingTopZ(poolGroup, spaGroup);
  const copingDepth = Math.max(0.05, copingTopZ - copingUnderZ);
  const channelFloorTopZ = copingTopZ - 0.3;
  const channelFloorThickness = 0.02;
  const wallHeight = Math.max(0.02, copingUnderZ - channelFloorTopZ);
  const wallThickness = 0.20;
  const copingRebuildWidth = 0.25;
  const tileSize = spaGroup?.userData?.tileSize || poolGroup?.userData?.tileSize || 0.3;
  const waterLevelZ = copingUnderZ - 0.10;

  clearSpaChannelMeshes(ground);
  const group = new THREE.Group();
  group.name = 'SpaChannelGroup';
  const waterGroup = new THREE.Group();
  waterGroup.name = 'SpaChannelWaterGroup';
  const mat = createSpaChannelMaterial(spaGroup);
  const copingMat = createCopingRebuildMaterial(poolGroup);
  const floorZCenter = channelFloorTopZ - channelFloorThickness * 0.5;
  const wallZCenter = channelFloorTopZ + wallHeight * 0.5;
  const copingZCenter = copingUnderZ + copingDepth * 0.5;

  if (spaGroup?.userData?.spaShape === 'circular') {
    const radius = Math.max(0.05, (spaGroup.userData?.spaLength || 0.1) * 0.5);
    const channelMargin = Math.max(margins.minX, margins.maxX, margins.minY, margins.maxY, 0.2);
    const outerRadius = radius + channelMargin;
    const wallInnerRadius = Math.max(radius, outerRadius - wallThickness);
    const copingInnerRadius = Math.max(radius, outerRadius - Math.min(channelMargin, CIRCULAR_CHANNEL_COPING_WIDTH));
    const radialMid = radius + channelMargin * 0.5;
    const segments = 96;
    const step = (Math.PI * 2) / segments;
    const isOutsideAtAngle = (angle) => {
      const localX = Math.cos(angle) * radialMid;
      const localY = Math.sin(angle) * radialMid;
      const worldPoint = center.clone()
        .add(axisX.clone().multiplyScalar(localX))
        .add(axisY.clone().multiplyScalar(localY));
      return !isPointInsidePoolFootprint(poolGroup, worldPoint);
    };

    let arcStart = null;
    for (let i = 0; i <= segments; i++) {
      const a0 = i * step;
      const outside = i < segments ? isOutsideAtAngle(a0 + step * 0.5) : false;
      if (outside && arcStart === null) {
        arcStart = a0;
      } else if (!outside && arcStart !== null) {
        const arcEnd = a0;
        if (arcEnd - arcStart > 0.01) {
          const floorBand = createCircularArcBandShape(radius, wallInnerRadius, arcStart, arcEnd);
          const wallBand = createCircularArcBandShape(wallInnerRadius, outerRadius, arcStart, arcEnd);
          const copingBand = createCircularArcBandShape(copingInnerRadius, outerRadius, arcStart, arcEnd);
          addCircularChannelExtrude(group, floorBand, channelFloorThickness, channelFloorTopZ - channelFloorThickness, center, quat, mat, tileSize);
          addCircularChannelExtrude(group, wallBand, wallHeight, channelFloorTopZ, center, quat, mat, tileSize);
          addCircularChannelExtrude(group, copingBand, copingDepth, copingUnderZ, center, quat, copingMat, tileSize);
          addCircularChannelWaterArc(waterGroup, radius, wallInnerRadius, arcStart, arcEnd, center, quat, waterLevelZ);
        }
        arcStart = null;
      }
    }

    const bridgeWidth = Math.max(0.35, radius * 1.2);
    const addBridge = (sx, sy, lx, ly) => {
      addChannelBox(group, sx, sy, channelFloorThickness, lx, ly, center, axisX, axisY, quat, mat, floorZCenter, tileSize);
      addChannelBox(group, sx, sy, wallHeight, lx, ly, center, axisX, axisY, quat, mat, wallZCenter, tileSize);
      addChannelBox(group, sx, sy, copingDepth, lx, ly, center, axisX, axisY, quat, copingMat, copingZCenter, tileSize);
      addChannelWaterPlane(waterGroup, sx, sy, lx, ly, center, axisX, axisY, quat, waterLevelZ);
    };
    if (snapVariant === 'inner-wall-align') {
      if (snapSide === 'left' && margins.maxX > 0) addBridge(Math.max(0.01, margins.maxX), bridgeWidth, radius + margins.maxX * 0.5, 0);
      if (snapSide === 'right' && margins.minX > 0) addBridge(Math.max(0.01, margins.minX), bridgeWidth, -(radius + margins.minX * 0.5), 0);
      if (snapSide === 'front' && margins.maxY > 0) addBridge(bridgeWidth, Math.max(0.01, margins.maxY), 0, radius + margins.maxY * 0.5);
      if (snapSide === 'back' && margins.minY > 0) addBridge(bridgeWidth, Math.max(0.01, margins.minY), 0, -(radius + margins.minY * 0.5));
    }

    ground.parent?.add(group);
    ground.parent?.add(waterGroup);
    if (ground.userData) { ground.userData.spaChannelGroup = group; ground.userData.spaChannelWaterGroup = waterGroup; }
    return;
  }

  const getSideIntervals = (_sideKey, axisAlong, axisAcross, stripCenter, alongMin, alongMax) => {
    return getOutsideIntervalsAlongSide(center, axisAlong, axisAcross, stripCenter, alongMin, alongMax, poolGroup);
  };

  const addFloorStrip = (sx, sy, lx, ly) => {
    addChannelBox(group, sx, sy, channelFloorThickness, lx, ly, center, axisX, axisY, quat, mat, floorZCenter, tileSize);
    addChannelWaterPlane(waterGroup, sx, sy, lx, ly, center, axisX, axisY, quat, waterLevelZ);
  };
  const addWallStrip = (sx, sy, lx, ly) => {
    addChannelBox(group, sx, sy, wallHeight, lx, ly, center, axisX, axisY, quat, mat, wallZCenter, tileSize);
  };
  const addCopingStrip = (sx, sy, lx, ly) => {
    addChannelBox(group, sx, sy, copingDepth, lx, ly, center, axisX, axisY, quat, copingMat, copingZCenter, tileSize);
  };

  if (margins.minX > 0) {
    const wallInnerX = minX + wallThickness;
    const floorWidth = Math.max(0.01, (-halfX) - wallInnerX);
    const floorCenterX = (wallInnerX + (-halfX)) * 0.5;
    const stripCenterX = -halfX - margins.minX * 0.5;
    const wallX = minX + wallThickness * 0.5;
    const copingX = minX + copingRebuildWidth * 0.5;
    const intervals = getSideIntervals('minX', axisY, axisX, stripCenterX, minY, maxY);
    intervals.forEach(([a, b]) => {
      const span = b - a;
      const mid = (a + b) * 0.5;
      addFloorStrip(floorWidth, span, floorCenterX, mid);
      const suppressBridgeFace = suppressPoolFacingBridgeWall && snapSide === 'right';
      if (!suppressBridgeFace) addWallStrip(wallThickness, span, wallX, mid);
      if (!suppressBridgeFace) addCopingStrip(copingRebuildWidth, span, copingX, mid);
    });
  }
  if (margins.maxX > 0) {
    const wallInnerX = maxX - wallThickness;
    const floorWidth = Math.max(0.01, wallInnerX - halfX);
    const floorCenterX = (wallInnerX + halfX) * 0.5;
    const stripCenterX = halfX + margins.maxX * 0.5;
    const wallX = maxX - wallThickness * 0.5;
    const copingX = maxX - copingRebuildWidth * 0.5;
    const intervals = getSideIntervals('maxX', axisY, axisX, stripCenterX, minY, maxY);
    intervals.forEach(([a, b]) => {
      const span = b - a;
      const mid = (a + b) * 0.5;
      addFloorStrip(floorWidth, span, floorCenterX, mid);
      const suppressBridgeFace = suppressPoolFacingBridgeWall && snapSide === 'left';
      if (!suppressBridgeFace) addWallStrip(wallThickness, span, wallX, mid);
      if (!suppressBridgeFace) addCopingStrip(copingRebuildWidth, span, copingX, mid);
    });
  }
  if (margins.minY > 0) {
    const wallInnerY = minY + wallThickness;
    const floorWidth = Math.max(0.01, (-halfY) - wallInnerY);
    const floorCenterY = (wallInnerY + (-halfY)) * 0.5;
    const stripCenterY = -halfY - margins.minY * 0.5;
    const wallY = minY + wallThickness * 0.5;
    const copingY = minY + copingRebuildWidth * 0.5;
    const intervals = getSideIntervals('minY', axisX, axisY, stripCenterY, minX, maxX);
    intervals.forEach(([a, b]) => {
      const span = b - a;
      const mid = (a + b) * 0.5;
      addFloorStrip(span, floorWidth, mid, floorCenterY);
      const suppressBridgeFace = suppressPoolFacingBridgeWall && snapSide === 'back';
      if (!suppressBridgeFace) addWallStrip(span, wallThickness, mid, wallY);
      if (!suppressBridgeFace) addCopingStrip(span, copingRebuildWidth, mid, copingY);
    });
  }
  if (margins.maxY > 0) {
    const wallInnerY = maxY - wallThickness;
    const floorWidth = Math.max(0.01, wallInnerY - halfY);
    const floorCenterY = (wallInnerY + halfY) * 0.5;
    const stripCenterY = halfY + margins.maxY * 0.5;
    const wallY = maxY - wallThickness * 0.5;
    const copingY = maxY - copingRebuildWidth * 0.5;
    const intervals = getSideIntervals('maxY', axisX, axisY, stripCenterY, minX, maxX);
    intervals.forEach(([a, b]) => {
      const span = b - a;
      const mid = (a + b) * 0.5;
      addFloorStrip(span, floorWidth, mid, floorCenterY);
      const suppressBridgeFace = suppressPoolFacingBridgeWall && snapSide === 'front';
      if (!suppressBridgeFace) addWallStrip(span, wallThickness, mid, wallY);
      if (!suppressBridgeFace) addCopingStrip(span, copingRebuildWidth, mid, copingY);
    });
  }

  ground.parent?.add(group);
  ground.parent?.add(waterGroup);
  if (ground.userData) { ground.userData.spaChannelGroup = group; ground.userData.spaChannelWaterGroup = waterGroup; }
}


function ensureOrangeInteriorClipMaterial(material) {
  if (!material) return;
  material.userData = material.userData || {};
  if (material.userData.orangeInteriorClipPatched) return;

  material.userData.orangeInteriorClipPatched = true;
  material.userData.orangeInteriorClipUniforms = {
    orangeInteriorClipEnabled: { value: 0 },
    orangeInteriorClipShape: { value: 0 },
    orangeInteriorClipMin: { value: new THREE.Vector3() },
    orangeInteriorClipMax: { value: new THREE.Vector3() },
    orangeInteriorClipCenter: { value: new THREE.Vector2() },
    orangeInteriorClipRadius: { value: 0 }
  };

  const previousOnBeforeCompile = material.onBeforeCompile;

  material.onBeforeCompile = (shader) => {
    if (typeof previousOnBeforeCompile === "function") previousOnBeforeCompile(shader);

    Object.assign(shader.uniforms, material.userData.orangeInteriorClipUniforms);

    if (!shader.vertexShader.includes('vOrangeInteriorWorldPos')) {
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nvarying vec3 vOrangeInteriorWorldPos;'
        )
        .replace(
          '#include <worldpos_vertex>',
          '#include <worldpos_vertex>\n  vOrangeInteriorWorldPos = worldPosition.xyz;'
        );
    }

    if (!shader.fragmentShader.includes('orangeInteriorClipEnabled')) {
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nvarying vec3 vOrangeInteriorWorldPos;\nuniform int orangeInteriorClipEnabled;\nuniform int orangeInteriorClipShape;\nuniform vec3 orangeInteriorClipMin;\nuniform vec3 orangeInteriorClipMax;\nuniform vec2 orangeInteriorClipCenter;\nuniform float orangeInteriorClipRadius;'
        )
        .replace(
          '#include <clipping_planes_fragment>',
          `#include <clipping_planes_fragment>
  if (orangeInteriorClipEnabled == 1 &&
      vOrangeInteriorWorldPos.z >= orangeInteriorClipMin.z && vOrangeInteriorWorldPos.z <= orangeInteriorClipMax.z) {
    bool insideOrangeInteriorClip = false;
    if (orangeInteriorClipShape == 1) {
      vec2 orangeInteriorDelta = vOrangeInteriorWorldPos.xy - orangeInteriorClipCenter;
      insideOrangeInteriorClip = dot(orangeInteriorDelta, orangeInteriorDelta) <= orangeInteriorClipRadius * orangeInteriorClipRadius;
    } else {
      insideOrangeInteriorClip =
        vOrangeInteriorWorldPos.x >= orangeInteriorClipMin.x && vOrangeInteriorWorldPos.x <= orangeInteriorClipMax.x &&
        vOrangeInteriorWorldPos.y >= orangeInteriorClipMin.y && vOrangeInteriorWorldPos.y <= orangeInteriorClipMax.y;
    }
    if (insideOrangeInteriorClip) discard;
  }`
        );
    }
  };

  const previousCacheKey = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => {
    const prev = previousCacheKey ? previousCacheKey() : '';
    return `${prev}|orange-interior-clip-v3`;
  };

  material.needsUpdate = true;
}

function setOrangeInteriorClipOnMaterial(material, box) {
  if (!material) return;
  ensureOrangeInteriorClipMaterial(material);

  const uniforms = material.userData?.orangeInteriorClipUniforms;
  if (!uniforms) return;

  if (box) {
    uniforms.orangeInteriorClipEnabled.value = 1;
    uniforms.orangeInteriorClipMin.value.set(box.minX ?? 0, box.minY ?? 0, box.minZ ?? 0);
    uniforms.orangeInteriorClipMax.value.set(box.maxX ?? 0, box.maxY ?? 0, box.maxZ ?? 0);
    if (box.shape === 'circular') {
      uniforms.orangeInteriorClipShape.value = 1;
      uniforms.orangeInteriorClipCenter.value.set(box.centerX ?? 0, box.centerY ?? 0);
      uniforms.orangeInteriorClipRadius.value = Math.max(0, box.radius ?? 0);
    } else {
      uniforms.orangeInteriorClipShape.value = 0;
      uniforms.orangeInteriorClipCenter.value.set(0, 0);
      uniforms.orangeInteriorClipRadius.value = 0;
    }
  } else {
    uniforms.orangeInteriorClipEnabled.value = 0;
    uniforms.orangeInteriorClipShape.value = 0;
    uniforms.orangeInteriorClipRadius.value = 0;
  }

  material.needsUpdate = true;
}

function ensureGroundSpaClipMaterial(ground) {
  const mat = ground?.material;
  if (!mat || mat.userData?.spaClipPatched) return;

  mat.userData.spaClipPatched = true;
  mat.userData.spaClipUniforms = {
    spaClipEnabled: { value: 0 },
    spaClipCenter: { value: new THREE.Vector3() },
    spaClipAxisX: { value: new THREE.Vector3(1, 0, 0) },
    spaClipAxisY: { value: new THREE.Vector3(0, 1, 0) },
    spaClipHalfSize: { value: new THREE.Vector2(0.5, 0.5) },
    spaClipShape: { value: 0 },
    spaClipRadius: { value: 0.5 },
    yellowClipEnabled: { value: 0 },
    yellowClipMin: { value: new THREE.Vector3() },
    yellowClipMax: { value: new THREE.Vector3() }
  };

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, mat.userData.spaClipUniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vSpaClipWorldPos;`
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
         vSpaClipWorldPos = worldPosition.xyz;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vSpaClipWorldPos;
         uniform int spaClipEnabled;
         uniform vec3 spaClipCenter;
         uniform vec3 spaClipAxisX;
         uniform vec3 spaClipAxisY;
         uniform vec2 spaClipHalfSize;
         uniform int spaClipShape;
         uniform float spaClipRadius;
         uniform int yellowClipEnabled;
         uniform vec3 yellowClipMin;
         uniform vec3 yellowClipMax;`
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
         if (spaClipEnabled == 1) {
           vec3 d = vSpaClipWorldPos - spaClipCenter;
           float lx = dot(d, normalize(spaClipAxisX));
           float ly = dot(d, normalize(spaClipAxisY));
           if (spaClipShape == 1) {
             if ((lx * lx + ly * ly) <= (spaClipRadius * spaClipRadius)) discard;
           } else {
             if (abs(lx) <= spaClipHalfSize.x && abs(ly) <= spaClipHalfSize.y) discard;
           }
         }
         if (yellowClipEnabled == 1) {
           if (vSpaClipWorldPos.x >= yellowClipMin.x && vSpaClipWorldPos.x <= yellowClipMax.x &&
               vSpaClipWorldPos.y >= yellowClipMin.y && vSpaClipWorldPos.y <= yellowClipMax.y &&
               vSpaClipWorldPos.z >= yellowClipMin.z && vSpaClipWorldPos.z <= yellowClipMax.z) discard;
         }`
      );
  };

  mat.customProgramCacheKey = () => 'ground-spa-clip-v4';
  mat.needsUpdate = true;
}

function updateGroundMaterialSpaClip(ground, spaGroup = null, poolGroup = null) {
  const mat = ground?.material;
  const uniforms = mat?.userData?.spaClipUniforms;
  if (!uniforms) return;

  if (!spaGroup) {
    uniforms.spaClipEnabled.value = 0;
    uniforms.spaClipShape.value = 0;
    uniforms.spaClipRadius.value = 0.5;
    uniforms.yellowClipEnabled.value = 0;
    return;
  }

  if (spaGroup.userData?.orangeOnlyVoidMode) {
    uniforms.spaClipEnabled.value = 0;
    uniforms.spaClipShape.value = 0;
    uniforms.spaClipRadius.value = 0.5;
    uniforms.yellowClipEnabled.value = 0;
    return;
  }

  spaGroup.updateMatrixWorld?.(true);
  const box = new THREE.Box3().setFromObject(spaGroup);
  const minZ = box.min.z;
  const maxZ = box.max.z;
  const groundZ = ground?.position?.z ?? 0;

  if (!(minZ <= groundZ + 0.02 && maxZ >= groundZ - 0.02)) {
    uniforms.spaClipEnabled.value = 0;
    uniforms.spaClipShape.value = 0;
    uniforms.spaClipRadius.value = 0.5;
    uniforms.yellowClipEnabled.value = 0;
    return;
  }

  const pad = 0.02;
  const margins = getSpaChannelMargins(spaGroup, poolGroup);
  const expanded = getExpandedSpaWorldAABB(spaGroup, margins, pad, SPA_GROUND_CLIP_MARGIN_REDUCTION);
  if (!expanded) {
    uniforms.spaClipEnabled.value = 0;
    uniforms.spaClipShape.value = 0;
    uniforms.spaClipRadius.value = 0.5;
    uniforms.yellowClipEnabled.value = 0;
    return;
  }

  const isCircularSpa = spaGroup?.userData?.spaShape === 'circular';
  const offsetX = (expanded.maxX + expanded.minX) * 0.5;
  const offsetY = (expanded.maxY + expanded.minY) * 0.5;
  const clipCenter = expanded.center.clone().add(expanded.axisX.clone().multiplyScalar(offsetX)).add(expanded.axisY.clone().multiplyScalar(offsetY));
  const halfX = Math.max(0.01, (expanded.maxX - expanded.minX) * 0.5);
  const halfY = Math.max(0.01, (expanded.maxY - expanded.minY) * 0.5);
  uniforms.spaClipEnabled.value = 1; uniforms.spaClipCenter.value.copy(clipCenter); uniforms.spaClipAxisX.value.copy(expanded.axisX); uniforms.spaClipAxisY.value.copy(expanded.axisY); uniforms.spaClipHalfSize.value.set(halfX, halfY); uniforms.spaClipShape.value = isCircularSpa ? 1 : 0; uniforms.spaClipRadius.value = isCircularSpa ? Math.max(0.01, (spaGroup.userData?.spaLength || 0.01) * 0.5 + Math.max(margins.minX, margins.maxX, margins.minY, margins.maxY) - SPA_GROUND_CLIP_MARGIN_REDUCTION + pad) : Math.max(halfX, halfY);

  const volumes = getSpaClipVolumes(poolGroup, spaGroup, 0.01);
  if (volumes?.yellowClipBox) {
    uniforms.yellowClipEnabled.value = 1;
    uniforms.yellowClipMin.value.set(volumes.yellowClipBox.minX, volumes.yellowClipBox.minY, volumes.yellowMinZ);
    uniforms.yellowClipMax.value.set(volumes.yellowClipBox.maxX, volumes.yellowClipBox.maxY, volumes.yellowMaxZ);
  } else {
    uniforms.yellowClipEnabled.value = 0;
  }
}

export async function initScene() {
  const container = document.getElementById("three-root") || document.body;

  const scene = new THREE.Scene();

  // IMPORTANT: Do NOT touch THREE.Object3D.DEFAULT_UP here.
  // Your app already has an established axis convention; changing DEFAULT_UP will flip everything.
  // We only set camera.up to match the rest of your app (Z-up in your pool code).
  const camera = new THREE.PerspectiveCamera(
    60,
    container.clientWidth / container.clientHeight,
    0.1,
    500
  );
  camera.up.set(0, 0, 1);
  camera.position.set(12, -16, 10);
  camera.lookAt(0, 0, 0);
  scene.userData.camera = camera;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.localClippingEnabled = true;

  // Modern color pipeline + PBR-friendly tone mapping
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95; // slightly lower to reduce washed-out grass
  container.appendChild(renderer.domElement);

  // -------------------------
  // Lighting: key/fill/rim
  // -------------------------
  const ambient = new THREE.AmbientLight(0xffffff, 0.22);
  scene.add(ambient);

  dirLight = new THREE.DirectionalLight(0xffffff, 2.8);
  dirLight.position.set(18, -22, 30);
  dirLight.castShadow = true;

  // If you want extra FPS, drop to 1024:
  dirLight.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
  dirLight.shadow.normalBias = 0.02;
  dirLight.shadow.bias = -0.0002;

  const d = 20;
  dirLight.shadow.camera = new THREE.OrthographicCamera(-d, d, d, -d, 0.5, 150);
  scene.add(dirLight);
  scene.add(dirLight.target);

  const fillLight = new THREE.DirectionalLight(0xffffff, 0.75);
  fillLight.position.set(-20, 20, 18);
  fillLight.castShadow = false;
  scene.add(fillLight);

  const rimLight = new THREE.DirectionalLight(0xffffff, 0.55);
  rimLight.position.set(25, 25, 12);
  rimLight.castShadow = false;
  scene.add(rimLight);

  // Controls
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI / 2.05;
  controls.target.set(0, 0, 0);
  controls.update();
  scene.userData.controls = controls;

  // -------------------------
  // Ground plane
  // NOTE: Your app cuts the void using updateGroundVoid(). Keep this mesh stable.
  // -------------------------
  const groundGeo = new THREE.PlaneGeometry(200, 200, 1, 1);

  // -------------------------
  // Ground material: Studio floor (neutral, slightly rough)
  // Keep this mesh stable: updateGroundVoid() will replace the geometry to cut the pool footprint hole.
  // -------------------------
  const groundMat = new THREE.MeshStandardMaterial({
    color: 0xf3f5f7,
    roughness: 0.96,
    metalness: 0.0,
    envMapIntensity: 0.25
  });

  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.position.set(0, 0, 0);
  ground.receiveShadow = true;
  ensureGroundSpaClipMaterial(ground);
  scene.add(ground);
  scene.userData.ground = ground;

  // -------------------------
  // Studio environment (no external HDRI): neutral reflections + soft ambient feel
  // -------------------------
  if (ENABLE_ROOM_ENVIRONMENT) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
  } else {
    scene.environment = null;
  }

  // -------------------------
  // Background: subtle vertical gradient sky-dome (clean showroom look)
  // -------------------------
  const skyGeo = new THREE.SphereGeometry(500, 48, 32);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      topColor: { value: new THREE.Color(0xf7f9fc) },
      bottomColor: { value: new THREE.Color(0xe7edf5) }
    },
    vertexShader: `
      varying vec3 vPos;
      void main(){
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vPos;
      uniform vec3 topColor;
      uniform vec3 bottomColor;
      void main(){
        float h = normalize(vPos).y * 0.5 + 0.5;
        h = smoothstep(0.0, 1.0, h);
        gl_FragColor = vec4(mix(bottomColor, topColor, h), 1.0);
      }
    `
  });

  const skyDome = new THREE.Mesh(skyGeo, skyMat);
  skyDome.frustumCulled = false;
  skyDome.onBeforeRender = (_r, _s, cam) => {
    skyDome.position.copy(cam.position);
  };

  // Remove any previous background objects
  if (scene.userData.skyDome) {
    scene.remove(scene.userData.skyDome);
    scene.userData.skyDome.geometry.dispose();
    scene.userData.skyDome.material.dispose();
  }
  scene.add(skyDome);
  scene.userData.skyDome = skyDome;

  // Background is provided by geometry
  scene.background = null;

  // Resize
  window.addEventListener("resize", () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  });

  return { scene, camera, renderer, ground, controls };
}

// --------------------------------------------------------
// Ground void update (cut footprint hole)
// --------------------------------------------------------
export function updateGroundVoid(ground, poolGroup, spaGroup = null) {
  if (!ground || !poolGroup || !poolGroup.userData || !poolGroup.userData.outerPts) return;

  const scene = ground.parent || null;
  purgeDetachedSpaChannelArtifacts(scene, ground?.userData?.spaChannelGroup || null, ground?.userData?.spaChannelWaterGroup || null);
  ensureGroundSpaClipMaterial(ground);

  const outerPts = poolGroup.userData.outerPts;

  // Apply poolGroup transform (so live preview scaling updates the void correctly)
  const sx = (poolGroup.scale && isFinite(poolGroup.scale.x)) ? poolGroup.scale.x : 1;
  const sy = (poolGroup.scale && isFinite(poolGroup.scale.y)) ? poolGroup.scale.y : 1;
  const px = (poolGroup.position && isFinite(poolGroup.position.x)) ? poolGroup.position.x : 0;
  const py = (poolGroup.position && isFinite(poolGroup.position.y)) ? poolGroup.position.y : 0;

  const holePts = outerPts.map((v) => new THREE.Vector2(v.x * sx + px, v.y * sy + py));

  // Big outer rectangle (ground boundary)
  const groundShape = new THREE.Shape([
    new THREE.Vector2(-100, -100),
    new THREE.Vector2(100, -100),
    new THREE.Vector2(100, 100),
    new THREE.Vector2(-100, 100)
  ]);

  // Only cut the pool footprint in the ground geometry.
  // Spa cutout is handled in the ground material so overlapping/intersecting
  // spa placements do not create invalid ShapeGeometry holes across the pool.
  groundShape.holes = [new THREE.Path(holePts)];

  const newGeo = new THREE.ShapeGeometry(groundShape);
  ground.geometry.dispose();
  ground.geometry = newGeo;

  updateGroundMaterialSpaClip(ground, spaGroup, poolGroup);
  updateSpaChannelMeshes(ground, poolGroup, spaGroup);
  purgeDetachedSpaChannelArtifacts(scene, ground?.userData?.spaChannelGroup || null, ground?.userData?.spaChannelWaterGroup || null);
  updateSpaVoidDebug(ground?.parent, ground, poolGroup, spaGroup, holePts);
  updateShadowBounds(poolGroup);
}


// --------------------------------------------------------
// Update directional light shadow box to fit pool
// --------------------------------------------------------
export function updateShadowBounds(poolGroup) {
  if (!dirLight || !poolGroup) return;

  const box = new THREE.Box3().setFromObject(poolGroup);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  const cam = dirLight.shadow.camera;

  // Expand a bit so wall shadows look stable and don't clip while orbiting
  const pad = 6;
  cam.left = -(size.x / 1.4 + pad);
  cam.right = (size.x / 1.4 + pad);
  cam.top = (size.y / 1.4 + pad);
  cam.bottom = -(size.y / 1.4 + pad);

  cam.near = 0.5;
  cam.far = size.z + 120;
  cam.updateProjectionMatrix();

  dirLight.target.position.copy(center);
  dirLight.target.updateMatrixWorld();
}

// --------------------------------------------------------
// Update spa void uniforms on water shader
// and clip any pool geometry that passes through the spa volume.
// --------------------------------------------------------
function getSpaWallThroatClipBox(poolGroup, spaGroup, pad = 0.01) {
  if (!poolGroup || !spaGroup) return null;

  const oriented = makeOrientedThroatVolume(poolGroup, spaGroup, pad);
  if (oriented) return oriented;

  const bounds = getPoolFootprintBoundsWorld(poolGroup);
  if (!bounds) return null;

  spaGroup.updateMatrixWorld?.(true);
  const center = new THREE.Vector3();
  spaGroup.getWorldPosition(center);

  const halfX = Math.max(0.005, (spaGroup.userData?.spaLength || 0.01) * 0.5);
  const halfY = Math.max(0.005, (spaGroup.userData?.spaWidth || 0.01) * 0.5);
  const snapSide = spaGroup?.userData?.snapSide || null;

  const insidePad = (0.05 + pad) * 3.0 + 0.30;
  const outsideDepth = (0.21 + pad) * 3.0;
  const alongPad = SPA_THROAT_ALONG_PAD;
  const extraAlongWall = SPA_THROAT_WIDTH_EXTRA;

  let minX = center.x - halfX;
  let maxX = center.x + halfX;
  let minY = center.y - halfY;
  let maxY = center.y + halfY;

  if (snapSide === 'left') {
    minX = bounds.minX - outsideDepth;
    maxX = bounds.minX + insidePad;
    minY = center.y - halfY - alongPad - extraAlongWall;
    maxY = center.y + halfY + alongPad + extraAlongWall;
  } else if (snapSide === 'right') {
    minX = bounds.maxX - insidePad;
    maxX = bounds.maxX + outsideDepth;
    minY = center.y - halfY - alongPad - extraAlongWall;
    maxY = center.y + halfY + alongPad + extraAlongWall;
  } else if (snapSide === 'front') {
    minY = bounds.minY - outsideDepth;
    maxY = bounds.minY + insidePad;
    minX = center.x - halfX - alongPad - extraAlongWall;
    maxX = center.x + halfX + alongPad + extraAlongWall;
  } else if (snapSide === 'back') {
    minY = bounds.maxY - insidePad;
    maxY = bounds.maxY + outsideDepth;
    minX = center.x - halfX - alongPad - extraAlongWall;
    maxX = center.x + halfX + alongPad + extraAlongWall;
  } else {
    return null;
  }

  return { minX, maxX, minY, maxY };
}

function getSpaClipVolumes(poolGroup, spaGroup, pad = 0.01) {
  const throat = getSpaWallThroatClipBox(poolGroup, spaGroup, pad);
  if (!throat) return null;

  const poolTopZ = getPoolCopingTopZ(poolGroup, spaGroup) ?? 0.0;
  const copingUnderZ = getPoolCopingUndersideZ(poolGroup, spaGroup) ?? (poolTopZ - 0.05);

  const blueClipBoxBase0 = shrinkThroatBoxAlongWall(throat, spaGroup, SPA_THROAT_BLUE_LENGTH_SHRINK) || throat;
  const blueClipBoxBase = extendThroatBoxAlongWall(blueClipBoxBase0, spaGroup, SPA_THROAT_BLUE_LENGTH_EXTRA) || blueClipBoxBase0;
  // Match yellow coping throat XY footprint to the blue wall throat exactly.
  const yellowClipBoxBase = { ...blueClipBoxBase };

  const yellowMinZ = copingUnderZ - 0.02;
  const yellowMaxZ = poolTopZ + 0.02;

  const blueMinZ = copingUnderZ - SPA_THROAT_DEBUG_BLUE_DEPTH - SPA_THROAT_DEBUG_BLUE_BOTTOM_PAD;
  const blueMaxZ = copingUnderZ + SPA_THROAT_DEBUG_BLUE_TOP_PAD;

  const yellowOriented = Number.isFinite(yellowClipBoxBase?.halfAlong) ? yellowClipBoxBase : null;
  const blueOriented = Number.isFinite(blueClipBoxBase?.halfAlong) ? blueClipBoxBase : null;

  const yellowClipBox = yellowOriented ? makeAabbFromOrientedVolume(yellowOriented) : yellowClipBoxBase;
  const blueClipBox = blueOriented ? makeAabbFromOrientedVolume(blueOriented) : blueClipBoxBase;

  return {
    throat,
    poolTopZ,
    copingUnderZ,
    yellowClipBox,
    blueClipBox,
    yellowMinZ,
    yellowMaxZ,
    blueMinZ,
    blueMaxZ,
    yellowOriented,
    blueOriented,
    yellowPlanes: yellowOriented ? makeClipPlanesFromOrientedVolume(yellowOriented, yellowMinZ, yellowMaxZ) : null,
    bluePlanes: blueOriented ? makeClipPlanesFromOrientedVolume(blueOriented, blueMinZ, blueMaxZ) : null
  };
}

export function updatePoolWaterVoid(poolGroup, spaGroup) {
  if (!poolGroup) return;

  const poolWater = poolGroup.userData?.waterMesh || null;
  const mat = poolWater?.material || null;
  const uniforms = mat ? mat.uniforms : null;

  const applyClipToMaterial = (material, planes) => {
    if (!material) return;
    material.clippingPlanes = planes;
    material.clipIntersection = !!planes?.length;
    material.needsUpdate = true;
  };

  const applyOrangeClipToPoolWater = (box) => {
    if (typeof poolWater?.userData?.setOrangeClipBox === "function") {
      poolWater.userData.setOrangeClipBox(box);
    }
  };

  const updatePoolGeometryClip = (spa) => {
    if (!poolGroup) return;

    let yellowPlanes = null; // coping void
    let bluePlanes = null;   // pool wall void
    let copingMeshSet = null;

    if (spa) {
      const orangeOnlyVoidMode = !!spa.userData?.orangeOnlyVoidMode;
      if (!orangeOnlyVoidMode) {
        const volumes = getSpaClipVolumes(poolGroup, spa, 0.01);
        if (!volumes) return;

        yellowPlanes = volumes.yellowPlanes || [
          new THREE.Plane(new THREE.Vector3(-1, 0, 0), volumes.yellowClipBox.minX),
          new THREE.Plane(new THREE.Vector3( 1, 0, 0), -volumes.yellowClipBox.maxX),
          new THREE.Plane(new THREE.Vector3( 0,-1, 0), volumes.yellowClipBox.minY),
          new THREE.Plane(new THREE.Vector3( 0, 1, 0), -volumes.yellowClipBox.maxY),
          new THREE.Plane(new THREE.Vector3( 0, 0,-1), volumes.yellowMinZ),
          new THREE.Plane(new THREE.Vector3( 0, 0, 1), -volumes.yellowMaxZ)
        ];

        bluePlanes = volumes.bluePlanes || [
          new THREE.Plane(new THREE.Vector3(-1, 0, 0), volumes.blueClipBox.minX),
          new THREE.Plane(new THREE.Vector3( 1, 0, 0), -volumes.blueClipBox.maxX),
          new THREE.Plane(new THREE.Vector3( 0,-1, 0), volumes.blueClipBox.minY),
          new THREE.Plane(new THREE.Vector3( 0, 1, 0), -volumes.blueClipBox.maxY),
          new THREE.Plane(new THREE.Vector3( 0, 0,-1), volumes.blueMinZ),
          new THREE.Plane(new THREE.Vector3( 0, 0, 1), -volumes.blueMaxZ)
        ];

        copingMeshSet = buildBulletproofCopingMeshSet(poolGroup);
      }
    }

    poolGroup.traverse((obj) => {
      if (!obj?.isMesh) return;
      if (obj === poolWater) return;
      if (obj.userData?.isSpaWater) return;
      if (obj.userData?.waterUniforms) return;
      if (typeof obj.userData?.setSimParams === "function") return;

      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      const planes = copingMeshSet?.has(obj) ? yellowPlanes : bluePlanes;
      const interiorBox = getSpaInteriorClearBox(spa);
      mats.forEach((m) => {
        applyClipToMaterial(m, planes);
        if (!copingMeshSet?.has(obj)) {
          setOrangeInteriorClipOnMaterial(m, interiorBox);
        } else {
          setOrangeInteriorClipOnMaterial(m, null);
        }
      });
    });
  };

  // Clear void if no spa provided
  if (!spaGroup) {
    if (uniforms?.spaSize?.value) uniforms.spaSize.value.set(0, 0);
    if (uniforms?.spaRadius) uniforms.spaRadius.value = 0.0;
    applyOrangeClipToPoolWater(null);
    updatePoolGeometryClip(null);
    return;
  }

  // World-space bounds (shader uses vWorld.xy)
  const spaBoxWorld = new THREE.Box3().setFromObject(spaGroup);
  const spaCenterWorld = spaBoxWorld.getCenter(new THREE.Vector3());
  const spaSizeWorld = spaBoxWorld.getSize(new THREE.Vector3());
  const orangeOnlyVoidMode = !!spaGroup.userData?.orangeOnlyVoidMode;

  // Small padding so the cutout doesn't clip the spa walls
  const pad = 0.05;

  if (uniforms?.spaCenter?.value) uniforms.spaCenter.value.set(spaCenterWorld.x, spaCenterWorld.y);
  if (uniforms?.spaSize?.value) {
    if (orangeOnlyVoidMode) uniforms.spaSize.value.set(0, 0);
    else uniforms.spaSize.value.set(spaSizeWorld.x + pad, spaSizeWorld.y + pad);
  }

  // Rounded void + edge polish tuning (meters)
  if (uniforms?.spaRadius) {
    if (orangeOnlyVoidMode) {
      uniforms.spaRadius.value = 0.0;
    } else {
      const r = 0.15 * Math.min(spaSizeWorld.x, spaSizeWorld.y);
      uniforms.spaRadius.value = Math.max(
        0.0,
        Math.min(r, Math.min(spaSizeWorld.x, spaSizeWorld.y) * 0.5)
      );
    }
  }
  if (uniforms?.spaFeather) uniforms.spaFeather.value = 0.03;
  if (uniforms?.spaEdgeWidth) uniforms.spaEdgeWidth.value = 0.08;
  if (uniforms?.spaEdgeFoam) uniforms.spaEdgeFoam.value = 0.55;
  if (uniforms?.spaEdgeDarken) uniforms.spaEdgeDarken.value = 0.25;

  const interiorBox = getSpaInteriorClearBox(spaGroup);
  applyOrangeClipToPoolWater(interiorBox);

  updatePoolGeometryClip(spaGroup);
}

// --------------------------------------------------------
// Rebuild grass overlay after pool rebuild
// --------------------------------------------------------
export function updateGrassForPool(scene, poolGroup) {
  // Instanced grass removed — keep function for compatibility with PoolApp
  return;
}
// OPTION A: joined coping


// ===== PATCH: remove coping segments intersecting spa throat =====
function removeCopingInsideThroat(group, throatBox){
  if (!group || !throatBox) return;

  group.traverse(obj=>{
    if (!obj.isMesh) return;

    const box = new THREE.Box3().setFromObject(obj);
    if (box.intersectsBox(throatBox)){
      obj.visible = false;
    }
  });
}

window.__applyCopingFix = function(){
  if (window.__copingGroup && window.__throatBox){
    removeCopingInsideThroat(window.__copingGroup, window.__throatBox);
  }
};

// js/pool/shapes/ovalPool.js
import * as THREE from "https://esm.sh/three@0.158.0";
import { createPoolWater } from "../water.js";

export function createOvalPool(params, tileSize = 0.3) {
  const {
    length,
    width,
    shallow,
    deep,
    shallowFlat,
    deepFlat,
    stepCount,
    stepDepth
  } = params;

  const group = new THREE.Group();
  const loader = new THREE.TextureLoader();

  const clampedShallow = Math.max(0.5, shallow);
  const clampedDeep = Math.max(clampedShallow, deep);

  group.userData.poolParams = {
    length,
    width,
    shallow,
    deep,
    shallowFlat,
    deepFlat,
    stepCount,
    stepDepth
  };

  // Live-preview source params used by previewUpdateDepths()
  group.userData.params = { ...group.userData.poolParams };

  const L = length;
  const W = width;

  /* -------------------------------------------------------
     OUTLINE (ellipse-like polyline)
  ------------------------------------------------------- */
  const outline = [];
  const segs = 96;
  const a = L * 0.5;
  const b = W * 0.5;

  for (let i = 0; i < segs; i++) {
    const t = (i / segs) * Math.PI * 2;
    outline.push(new THREE.Vector2(Math.cos(t) * a, Math.sin(t) * b));
  }

  const shape = new THREE.Shape(outline);

  const STEP_LENGTH = 0.3;
  const STEP_TOP_OFFSET = 0.25;

  /* -------------------------------------------------------
   FLOOR  (BBOX-RECTANGLE PLANE)
------------------------------------------------------- */
const bb2 = new THREE.Box2();
for (const p of outline) bb2.expandByPoint(p);

const wallMinX = bb2.min.x;
const wallMaxX = bb2.max.x;
const wallMinY = bb2.min.y;
const wallMaxY = bb2.max.y;

const bbLen = Math.max(0.01, wallMaxX - wallMinX);
const bbWid = Math.max(0.01, wallMaxY - wallMinY);
const cx = (wallMinX + wallMaxX) * 0.5;
const cy = (wallMinY + wallMaxY) * 0.5;

const segX = Math.max(2, Math.min(240, Math.ceil(bbLen / tileSize)));
const segY = Math.max(2, Math.min(240, Math.ceil(bbWid / tileSize)));

const floorGeo = new THREE.PlaneGeometry(bbLen, bbWid, segX, segY);
const pos = floorGeo.attributes.position;

let originX = wallMinX;
if (stepCount > 0) originX = wallMinX + STEP_LENGTH * stepCount;

const fullLen = wallMaxX - originX;

let sFlat = shallowFlat || 0;
let dFlat = deepFlat || 0;

const maxFlats = Math.max(0, fullLen - 0.1);
if (sFlat + dFlat > maxFlats) {
  const scale = maxFlats / (sFlat + dFlat);
  sFlat *= scale;
  dFlat *= scale;
}

const slopeLen = Math.max(0.01, fullLen - sFlat - dFlat);

for (let i = 0; i < pos.count; i++) {
  const worldX = pos.getX(i) + cx;

  let dx = worldX - originX;
  if (dx < 0) dx = 0;

  let z;
  if (dx <= sFlat) {
    z = -clampedShallow;
  } else if (dx >= fullLen - dFlat) {
    z = -clampedDeep;
  } else {
    const t = (dx - sFlat) / slopeLen;
    z = -(clampedShallow + t * (clampedDeep - clampedShallow));
  }

  pos.setZ(i, z);
}

pos.needsUpdate = true;
floorGeo.computeVertexNormals();

const floor = new THREE.Mesh(
  floorGeo,
  new THREE.MeshStandardMaterial({ color: 0xffffff })
);
floor.receiveShadow = true;
floor.position.set(cx, cy, 0);
floor.userData.isFloor = true;
floor.userData.type = "floor";
group.add(floor);

/* -------------------------------------------------------
     STEPS
  ------------------------------------------------------- */
  if (stepCount > 0) {
    const shallowDepth = clampedShallow;

    // Reuse bbox extents from FLOOR section (bb2)
    let stepWidth = wallMaxY - wallMinY;
    if (!isFinite(stepWidth) || stepWidth < 0.05) stepWidth = W * 0.6;

    for (let s = 0; s < stepCount; s++) {
      let h = stepDepth;

      if (s === stepCount - 1) {
        const used = stepDepth * (stepCount - 1);
        h = shallowDepth - STEP_TOP_OFFSET - used;
        if (h < 0.05) h = 0.05;
      }

      const geo = new THREE.BoxGeometry(STEP_LENGTH, stepWidth, h);
      const mat = new THREE.MeshStandardMaterial({ color: 0xaaaaaa });
      const step = new THREE.Mesh(geo, mat);

      const x = wallMinX + STEP_LENGTH * (s + 0.5);
      const z =
        s === stepCount - 1
          ? -(shallowDepth - h / 2)
          : -(STEP_TOP_OFFSET + stepDepth * (s + 0.5));

      step.position.set(x, 0, z);
      step.userData.isStep = true;
      step.userData.stepIndex = s;
      step.userData.baseHeight = h;
      step.castShadow = true;
      step.receiveShadow = true;

      group.add(step);
    }
  }

  /* -------------------------------------------------------
     WATER
  ------------------------------------------------------- */
  const water = createPoolWater(L, W);
  const waterGeo = new THREE.ShapeGeometry(shape, 64);
  if (water.geometry) water.geometry.dispose();
  water.geometry = waterGeo;

  water.position.set(0, 0, -0.15);
  water.receiveShadow = true;
  if (water.material) water.material.depthWrite = false;
  water.renderOrder = 1;
  group.add(water);

  /* -------------------------------------------------------
     WALLS (CONTINUOUS CURVED EXTRUDE)
  ------------------------------------------------------- */
  const wallThickness = 0.2;
  const wallDepth = clampedDeep;

  const pts2D = outline.map(p => new THREE.Vector2(p.x, p.y));

  function polygonSignedArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      a += p.x * q.y - q.x * p.y;
    }
    return a * 0.5;
  }

  function computeOutwardVertexNormals(pts) {
    const n = pts.length;
    const area = polygonSignedArea(pts);
    const ccw = area > 0;
    const normals = [];

    for (let i = 0; i < n; i++) {
      const p0 = pts[(i - 1 + n) % n];
      const p1 = pts[i];
      const p2 = pts[(i + 1) % n];

      const ePrev = p1.clone().sub(p0);
      const eNext = p2.clone().sub(p1);

      const nPrev = ccw
        ? new THREE.Vector2(ePrev.y, -ePrev.x)
        : new THREE.Vector2(-ePrev.y, ePrev.x);
      const nNext = ccw
        ? new THREE.Vector2(eNext.y, -eNext.x)
        : new THREE.Vector2(-eNext.y, eNext.x);

      nPrev.normalize();
      nNext.normalize();

      normals.push(nPrev.add(nNext).normalize());
    }

    return normals;
  }

  const normals = computeOutwardVertexNormals(pts2D);

  const wallOuterPts = pts2D.map((p, i) =>
    p.clone().add(normals[i].clone().multiplyScalar(wallThickness))
  );

  const wallShape = new THREE.Shape(wallOuterPts);
  const holePath = new THREE.Path(pts2D.slice().reverse());
  wallShape.holes.push(holePath);

  const wallGeo = new THREE.ExtrudeGeometry(wallShape, {
    depth: wallDepth,
    bevelEnabled: false,
    curveSegments: 96
  });

  wallGeo.translate(0, 0, -wallDepth * 0.5);
  wallGeo.computeVertexNormals();

  const wallMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    side: THREE.DoubleSide
  });

  const wallMesh = new THREE.Mesh(wallGeo, wallMat);
  wallMesh.position.z = -wallDepth * 0.5;
  wallMesh.castShadow = true;
  wallMesh.receiveShadow = true;
  wallMesh.userData.isWall = true;
  wallMesh.userData.baseHeight = wallDepth;
  wallMesh.userData.currentHeight = wallDepth;
  wallMesh.userData.extraHeight = 0;

  group.add(wallMesh);

  /* -------------------------------------------------------
     COPING (UNCHANGED RULES)
  ------------------------------------------------------- */
  const copingOverhang = 0.05;
  const copingDepth = 0.05;
  const zOffset = 0.001;

  const outerPts = wallOuterPts;
  const innerPts = pts2D.map((p, i) =>
    p.clone().add(normals[i].clone().multiplyScalar(-copingOverhang))
  );

  const copingShape = new THREE.Shape(outerPts);
  const innerPath = new THREE.Path(innerPts.slice().reverse());
  copingShape.holes.push(innerPath);

  const copingGeo = new THREE.ExtrudeGeometry(copingShape, {
    depth: copingDepth,
    bevelEnabled: false,
    curveSegments: 48
  });

  const copingCol = loader.load("textures/Coping/TilesTravertine001_COL_4K.jpg");
  copingCol.wrapS = copingCol.wrapT = THREE.RepeatWrapping;
  copingCol.repeat.set(1.5, 1.5);

  const copingMat = new THREE.MeshStandardMaterial({
    map: copingCol,
    roughness: 0.8,
    metalness: 0.05,
    side: THREE.DoubleSide
  });

  const copingMesh = new THREE.Mesh(copingGeo, copingMat);
  copingMesh.position.z = zOffset;
  copingMesh.castShadow = true;
  copingMesh.receiveShadow = true;
  copingMesh.userData.isCoping = true;
  copingMesh.renderOrder = 3;

  group.add(copingMesh);

  /* -------------------------------------------------------
     USERDATA
  ------------------------------------------------------- */
  group.userData.wallMeshes = [wallMesh];
  group.userData.wallThickness = wallThickness;
  group.userData.floorMesh = floor;
  group.userData.water = water;
  group.userData.waterMesh = water;
  group.userData.copingMesh = copingMesh;
  group.userData.outerPts = pts2D;

  if (water.userData && typeof water.userData.animate === "function") {
    group.userData.animatables = [water];
  }

  if (water.userData && typeof water.userData.triggerRipple === "function") {
    group.userData.triggerRipple = water.userData.triggerRipple;
  }

  return group;
}

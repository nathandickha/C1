// js/pool/shapes/lshapePool.js
import * as THREE from "https://esm.sh/three@0.158.0";
import { createPoolWater } from "../water.js";

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

    let u = 0;
    let v = 0;
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
  if (!geo.attributes.uv2) {
    geo.setAttribute("uv2", new THREE.BufferAttribute(uvs.slice(), 2));
  }
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

function createMiteredWallPrism(points, index, halfThickness, height) {
  const count = points.length;
  const pPrev = points[(index - 1 + count) % count];
  const p0 = points[index];
  const p1 = points[(index + 1) % count];
  const pNext = points[(index + 2) % count];

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

  const offsetLine = (a, b, normal, dist) => [
    a.clone().addScaledVector(normal, dist),
    b.clone().addScaledVector(normal, dist)
  ];

  const [curInnerA, curInnerB] = offsetLine(p0, p1, curIn, halfThickness);
  const [curOuterA, curOuterB] = offsetLine(p0, p1, curOut, halfThickness);
  const [prevInnerA, prevInnerB] = offsetLine(pPrev, p0, prevIn, halfThickness);
  const [prevOuterA, prevOuterB] = offsetLine(pPrev, p0, prevOut, halfThickness);
  const [nextInnerA, nextInnerB] = offsetLine(p1, pNext, nextIn, halfThickness);
  const [nextOuterA, nextOuterB] = offsetLine(p1, pNext, nextOut, halfThickness);

  let innerStart = lineIntersection2D(prevInnerA, prevInnerB, curInnerA, curInnerB) || curInnerA.clone();
  let outerStart = lineIntersection2D(prevOuterA, prevOuterB, curOuterA, curOuterB) || curOuterA.clone();
  let innerEnd = lineIntersection2D(curInnerA, curInnerB, nextInnerA, nextInnerB) || curInnerB.clone();
  let outerEnd = lineIntersection2D(curOuterA, curOuterB, nextOuterA, nextOuterB) || curOuterB.clone();

  const maxMiter = halfThickness * 8;
  if (innerStart.distanceTo(p0) > maxMiter) innerStart = curInnerA.clone();
  if (outerStart.distanceTo(p0) > maxMiter) outerStart = curOuterA.clone();
  if (innerEnd.distanceTo(p1) > maxMiter) innerEnd = curInnerB.clone();
  if (outerEnd.distanceTo(p1) > maxMiter) outerEnd = curOuterB.clone();

  const wallShape = new THREE.Shape([
    new THREE.Vector2(innerStart.x, innerStart.y),
    new THREE.Vector2(innerEnd.x, innerEnd.y),
    new THREE.Vector2(outerEnd.x, outerEnd.y),
    new THREE.Vector2(outerStart.x, outerStart.y)
  ]);

  const geo = new THREE.ExtrudeGeometry(wallShape, {
    depth: height,
    bevelEnabled: false,
    steps: 1,
    curveSegments: 1
  });
  // Match the stable wall-raise transform used by the custom/freeform pool walls:
  // keep the wall geometry centred on local Z so scaling raises the wall upward
  // without shearing or dropping the bottom anchor.
  geo.translate(0, 0, -height * 0.5);
  geo.computeVertexNormals();
  return geo;
}

export function createLShapePool(params, tileSize = 0.3) {
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

  const notchLengthX = Number.isFinite(params?.notchLengthX) ? params.notchLengthX : 0.4;
  const notchWidthY = Number.isFinite(params?.notchWidthY) ? params.notchWidthY : 0.45;

  const group = new THREE.Group();

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
    stepDepth,
    notchLengthX,
    notchWidthY
  };

  // Live-preview source params used by previewUpdateDepths()
  group.userData.params = { ...group.userData.poolParams };

  /* -------------------------------------------------------
     OUTLINE (L-shape)
  ------------------------------------------------------- */
  const halfL = length / 2;
  const halfW = width / 2;

  const notchFracL = notchLengthX;
  const notchFracW = notchWidthY;

  const notchL = THREE.MathUtils.clamp(length * notchFracL, 0.6, Math.max(0.6, length - 0.6));
  const notchW = THREE.MathUtils.clamp(width * notchFracW, 0.6, Math.max(0.6, width - 0.6));

  const borderPts = [
    new THREE.Vector2(-halfL, -halfW),
    new THREE.Vector2(halfL, -halfW),
    new THREE.Vector2(halfL, halfW),
    new THREE.Vector2(halfL - notchL, halfW),
    new THREE.Vector2(halfL - notchL, halfW - notchW),
    new THREE.Vector2(-halfL, halfW - notchW)
  ];

  const shape = new THREE.Shape(borderPts);

  const STEP_LENGTH = 0.3;
  const STEP_TOP_OFFSET = 0.25;

  /* -------------------------------------------------------
     FLOOR  (BBOX-RECTANGLE PLANE)
  ------------------------------------------------------- */
  const bb2 = new THREE.Box2();
  for (const p of borderPts) bb2.expandByPoint(p);

  const wallMinX = bb2.min.x;
  const wallMaxX = bb2.max.x;
  const wallMinY = bb2.min.y;
  const wallMaxY = bb2.max.y;

  const bbLen = Math.max(0.01, wallMaxX - wallMinX);
  const bbWid = Math.max(0.01, wallMaxY - wallMinY);
  const cx = (wallMinX + wallMaxX) * 0.5;
  const cy = (wallMinY + wallMaxY) * 0.5;

  const segX = Math.max(2, Math.min(200, Math.ceil(bbLen / tileSize)));
  const segY = Math.max(2, Math.min(200, Math.ceil(bbWid / tileSize)));

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
  floor.userData.isFloor = true;
  floor.userData.type = "floor";
  floor.position.set(cx, cy, 0);
  group.add(floor);

/* -------------------------------------------------------
     STEPS
  ------------------------------------------------------- */
  if (stepCount > 0) {
    const shallowDepth = clampedShallow;

    let stepWidth = wallMaxY - wallMinY;
    if (!isFinite(stepWidth) || stepWidth < 0.05) stepWidth = width * 0.6;

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
  const water = createPoolWater(length, width);
  const waterGeo = new THREE.ShapeGeometry(shape, 64);
  if (water.geometry) water.geometry.dispose();
  water.geometry = waterGeo;

  water.position.set(0, 0, -0.15);
  water.receiveShadow = true;
  if (water.material) water.material.depthWrite = false;
  water.renderOrder = 1;
  group.add(water);

  /* -------------------------------------------------------
     WALLS (200mm)
  ------------------------------------------------------- */
  const wallMeshes = [];
  const wallThickness = 0.2;

  for (let i = 0; i < borderPts.length; i++) {
    const wallGeo = createMiteredWallPrism(borderPts, i, wallThickness * 0.5, clampedDeep);
    if (!wallGeo) continue;

    generateMeterUVsForBoxGeometry(wallGeo, tileSize);

    const wall = new THREE.Mesh(
      wallGeo,
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        side: THREE.DoubleSide
      })
    );

    wall.position.z = -clampedDeep * 0.5;
    wall.castShadow = true;
    wall.receiveShadow = true;

    wall.userData.isWall = true;
    wall.userData.baseHeight = clampedDeep;
    wall.userData.currentHeight = clampedDeep;
    wall.userData.extraHeight = 0;
    wall.userData.edgeIndex = i;
    wall.userData.copingIndex = i;

    wallMeshes.push(wall);
    group.add(wall);
  }

  /* -------------------------------------------------------
     COPING SEGMENTS (one per wall, same linkage model as custom shapes)
  ------------------------------------------------------- */
  const pts2D = borderPts.map((p) => new THREE.Vector2(p.x, p.y));

  function polygonSignedArea(pts) {
    let a = 0;
    for (let i = 0, n = pts.length; i < n; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % n];
      a += p.x * q.y - q.x * p.y;
    }
    return a * 0.5;
  }

  const isCCW = polygonSignedArea(pts2D) > 0;
  const copingDepth = 0.05;
  const zOffset = 0.001;

  const copingTexLoader = new THREE.TextureLoader();
  const copingCol = copingTexLoader.load(new URL("../../textures/Coping/TilesTravertine001_COL_4K.jpg", import.meta.url).href);
  copingCol.wrapS = copingCol.wrapT = THREE.RepeatWrapping;
  copingCol.repeat.set(1.5, 1.5);

  const copingMat = new THREE.MeshStandardMaterial({
    map: copingCol,
    color: 0xffffff,
    roughness: 0.8,
    metalness: 0.05,
    side: THREE.DoubleSide
  });

  const copingMeshes = [];
  for (let i = 0; i < pts2D.length; i++) {
    const count = pts2D.length;
    const pPrev = pts2D[(i - 1 + count) % count];
    const p0 = pts2D[i];
    const p1 = pts2D[(i + 1) % count];
    const pNext = pts2D[(i + 2) % count];
    const copingGeo = createMiteredWallPrism(pts2D, i, wallThickness, copingDepth);
    if (!copingGeo) continue;
    generateMeterUVsForBoxGeometry(copingGeo, tileSize);

    const copingMesh = new THREE.Mesh(copingGeo, copingMat.clone());
    copingMesh.castShadow = true;
    copingMesh.receiveShadow = true;
    copingMesh.position.z = zOffset;
    copingMesh.renderOrder = 3;
    copingMesh.userData.isCoping = true;
    copingMesh.userData.baseZ = zOffset;
    copingMesh.userData.edgeIndex = i;
    group.add(copingMesh);
    copingMeshes.push(copingMesh);
  }
  group.userData.copingSegments = copingMeshes;

  /* -------------------------------------------------------
     METADATA / ANIMATION
  ------------------------------------------------------- */
  const animatables = [];
  if (water.userData && typeof water.userData.animate === "function") {
    animatables.push(water);
  }

  group.userData.animatables = animatables;
  group.userData.water = water;
  group.userData.waterMesh = water;
  group.userData.floorMesh = floor;
  group.userData.wallMeshes = wallMeshes;
  group.userData.wallThickness = wallThickness;
  group.userData.outerPts = borderPts;

  if (water.userData && typeof water.userData.triggerRipple === "function") {
    group.userData.triggerRipple = water.userData.triggerRipple;
  }

  return group;
}

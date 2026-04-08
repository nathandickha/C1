// js/pool/shapes/kidneyPool.js
import * as THREE from "https://esm.sh/three@0.158.0";
import { createPoolWater } from "../water.js";

/* -------------------------------------------------------
   UV GENERATOR
------------------------------------------------------- */
function generateUVsForShapeGeometry(geo) {
  geo.computeBoundingBox();
  const pos = geo.attributes.position;
  const bbox = geo.boundingBox;

  const minX = bbox.min.x;
  const minY = bbox.min.y;
  const sizeX = Math.max(1e-6, bbox.max.x - bbox.min.x);
  const sizeY = Math.max(1e-6, bbox.max.y - bbox.min.y);

  const uvs = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    uvs[i * 2] = (x - minX) / sizeX;
    uvs[i * 2 + 1] = (y - minY) / sizeY;
  }
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
}

/* -------------------------------------------------------
   CHAIKIN SMOOTHING
------------------------------------------------------- */
function chaikinSmooth(points, iterations = 2) {
  let pts = points.map((p) => p.clone());

  for (let it = 0; it < iterations; it++) {
    const newPts = [];
    const n = pts.length;

    for (let i = 0; i < n; i++) {
      const p0 = pts[i];
      const p1 = pts[(i + 1) % n];

      newPts.push(
        new THREE.Vector2(0.75 * p0.x + 0.25 * p1.x, 0.75 * p0.y + 0.25 * p1.y),
        new THREE.Vector2(0.25 * p0.x + 0.75 * p1.x, 0.25 * p0.y + 0.75 * p1.y)
      );
    }
    pts = newPts;
  }

  return pts;
}

/* -------------------------------------------------------
   KIDNEY OUTLINE
------------------------------------------------------- */
function generateKidneyOutline(L, W, params) {
  const leftR = THREE.MathUtils.clamp((params.kidneyLeftRadius ?? 2.0) / W, 0.02, 4.0);
  const rightR = THREE.MathUtils.clamp((params.kidneyRightRadius ?? 3.0) / W, 0.02, 5.0);
  const neck = THREE.MathUtils.clamp((params.kidneyOffset ?? 1.0) / L, 0.0, 2.0);

  const leftInfl = (leftR - 0.33) * 0.4;
  const rightInfl = (rightR - 0.5) * 0.4;
  const neckInfl = (neck - 0.45) * 0.5;

  const base = [
    new THREE.Vector2(-1.05, 0.25),
    new THREE.Vector2(-0.35, 0.52),
    new THREE.Vector2(0.55, 0.55),
    new THREE.Vector2(1.05, 0.3),
    new THREE.Vector2(1.1, 0.0),
    new THREE.Vector2(0.8, -0.38),
    new THREE.Vector2(0.35, -0.48),
    new THREE.Vector2(-0.1, -0.4),
    new THREE.Vector2(-0.85, -0.3),
    new THREE.Vector2(-1.1, -0.05)
  ];

  const adjusted = base.map((p, idx) => {
    const v = p.clone();
    if ([0, 1, 8, 9].includes(idx)) {
      v.x *= 1.0 + leftInfl * 0.6;
      v.y *= 1.0 + leftInfl * 0.4;
    }
    if ([2, 3, 4, 5, 6].includes(idx)) {
      v.x *= 1.0 + rightInfl * 0.7;
      v.y *= 1.0 + rightInfl * 0.4;
    }
    if (idx === 7) {
      v.y = -0.4 + -0.35 * neckInfl;
      v.x += neckInfl * 0.35;
    }
    return v;
  });

  const smoothed = chaikinSmooth(adjusted, 2);

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  smoothed.forEach(p => {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  });

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const sx = L / (maxX - minX || 1);
  const sy = W / (maxY - minY || 1);

  smoothed.forEach(p => {
    p.x = (p.x - cx) * sx;
    p.y = (p.y - cy) * sy;
  });

  return smoothed;
}

/* -------------------------------------------------------
   MAIN BUILDER
------------------------------------------------------- */
export function createKidneyPool(params, tileSize = 0.3) {
  const {
    length: L,
    width: W,
    shallow,
    deep,
    shallowFlat,
    deepFlat,
    stepCount,
    stepDepth
  } = params;

  const STEP_LENGTH = 0.3;
  const STEP_TOP_OFFSET = 0.25;

  const group = new THREE.Group();
  group.userData.poolParams = { ...params };
  group.userData.params = { ...group.userData.poolParams };

  const shallowZ = Math.max(0.5, shallow);
  const deepZ = Math.max(shallowZ, deep);

  /* -------------------------------------------------------
     OUTLINE
  ------------------------------------------------------- */
  const outline = generateKidneyOutline(L, W, params);
  const shape = new THREE.Shape(outline);
  // -------------------------------------------------------
  // OUTLINE EXTENTS (for bbox-based floor + steps)
  // -------------------------------------------------------
  let minXOutline = Infinity;
  let maxXOutline = -Infinity;
  let minYOutline = Infinity;
  let maxYOutline = -Infinity;

  for (const p of outline) {
    if (p.x < minXOutline) minXOutline = p.x;
    if (p.x > maxXOutline) maxXOutline = p.x;
    if (p.y < minYOutline) minYOutline = p.y;
    if (p.y > maxYOutline) maxYOutline = p.y;
  }



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

  const segX = Math.max(2, Math.min(260, Math.ceil(bbLen / tileSize)));
  const segY = Math.max(2, Math.min(260, Math.ceil(bbWid / tileSize)));

  const floorGeo = new THREE.PlaneGeometry(bbLen, bbWid, segX, segY);
  const pos = floorGeo.attributes.position;

  let originX = wallMinX;
  if (stepCount > 0) originX += STEP_LENGTH * stepCount;

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
    if (dx <= sFlat) z = -shallowZ;
    else if (dx >= fullLen - dFlat) z = -deepZ;
    else {
      const t = (dx - sFlat) / slopeLen;
      z = -(shallowZ + t * (deepZ - shallowZ));
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
     STEPS (RESTORED)
  ------------------------------------------------------- */
  if (stepCount > 0) {
        const stepWidth = Math.max(0.05, wallMaxY - wallMinY);

    for (let s = 0; s < stepCount; s++) {
      let h = stepDepth;
      if (s === stepCount - 1) {
        const used = stepDepth * (stepCount - 1);
        h = shallowZ - STEP_TOP_OFFSET - used;
        if (h < 0.05) h = 0.05;
      }

      const geo = new THREE.BoxGeometry(STEP_LENGTH, stepWidth, h);
      const step = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xaaaaaa }));

      const x = wallMinX + STEP_LENGTH * (s + 0.5);
      const z = s === stepCount - 1
        ? -(shallowZ - h / 2)
        : -(STEP_TOP_OFFSET + stepDepth * (s + 0.5));

      step.position.set(x, 0, z);
      step.userData.isStep = true;
      step.userData.stepIndex = s;
      step.userData.baseHeight = h;
      step.userData.stepIndex = s;
      step.userData.minXStep = minXOutline;

      step.castShadow = true;
      step.receiveShadow = true;
      group.add(step);
    }
  }

  /* -------------------------------------------------------
     WATER
  ------------------------------------------------------- */
  const water = createPoolWater(L, W);
  const waterGeo = new THREE.ShapeGeometry(shape, 96);
  generateUVsForShapeGeometry(waterGeo);
  water.geometry = waterGeo;
  water.position.z = -0.15;
  water.renderOrder = 1;
  if (water.material) water.material.depthWrite = false;
  group.add(water);

  /* -------------------------------------------------------
     WALLS (CONTINUOUS)
  ------------------------------------------------------- */
  const wallThickness = 0.2;
  const pts2D = outline.map(p => new THREE.Vector2(p.x, p.y));

  function polygonSignedArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      a += p.x * q.y - q.x * p.y;
    }
    return a * 0.5;
  }

  function outwardNormals(pts) {
    const ccw = polygonSignedArea(pts) > 0;
    return pts.map((p, i) => {
      const p0 = pts[(i - 1 + pts.length) % pts.length];
      const p2 = pts[(i + 1) % pts.length];
      const e0 = p.clone().sub(p0);
      const e1 = p2.clone().sub(p);
      const n0 = ccw ? new THREE.Vector2(e0.y, -e0.x) : new THREE.Vector2(-e0.y, e0.x);
      const n1 = ccw ? new THREE.Vector2(e1.y, -e1.x) : new THREE.Vector2(-e1.y, e1.x);
      n0.normalize(); n1.normalize();
      return n0.add(n1).normalize();
    });
  }

  const normals = outwardNormals(pts2D);
  const outerPts = pts2D.map((p, i) =>
    p.clone().add(normals[i].clone().multiplyScalar(wallThickness))
  );

  const wallShape = new THREE.Shape(outerPts);
  wallShape.holes.push(new THREE.Path(pts2D.slice().reverse()));

  const wallGeo = new THREE.ExtrudeGeometry(wallShape, {
    depth: deepZ,
    bevelEnabled: false,
    curveSegments: 96
  });

  wallGeo.translate(0, 0, -deepZ * 0.5);
  wallGeo.computeVertexNormals();

  const wallMesh = new THREE.Mesh(
    wallGeo,
    new THREE.MeshStandardMaterial({ color: 0xffffff, side: THREE.DoubleSide })
  );

  wallMesh.position.z = -deepZ * 0.5;
  wallMesh.castShadow = true;
  wallMesh.receiveShadow = true;
  wallMesh.userData.isWall = true;
  wallMesh.userData.baseHeight = deepZ;
  wallMesh.userData.currentHeight = deepZ;
  wallMesh.userData.extraHeight = 0;

  group.add(wallMesh);

  /* -------------------------------------------------------
     COPING
  ------------------------------------------------------- */
  const copingOverhang = 0.05;
  const copingDepth = 0.05;
  const zOffset = 0.001;

  const innerPts = pts2D.map((p, i) =>
    p.clone().add(normals[i].clone().multiplyScalar(-copingOverhang))
  );

  const copingShape = new THREE.Shape(outerPts);
  copingShape.holes.push(new THREE.Path(innerPts.slice().reverse()));

  const copingGeo = new THREE.ExtrudeGeometry(copingShape, {
    depth: copingDepth,
    bevelEnabled: false,
    curveSegments: 48
  });

  const tex = new THREE.TextureLoader().load(
    "textures/Coping/TilesTravertine001_COL_4K.jpg"
  );
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1.5, 1.5);

  const copingMesh = new THREE.Mesh(
    copingGeo,
    new THREE.MeshStandardMaterial({
      map: tex,
      roughness: 0.8,
      metalness: 0.05,
      side: THREE.DoubleSide
    })
  );

  copingMesh.position.z = zOffset;
  copingMesh.renderOrder = 3;
  copingMesh.userData.isCoping = true;
  group.add(copingMesh);

  /* -------------------------------------------------------
     USERDATA (RESTORED)
  ------------------------------------------------------- */
  group.userData.wallMeshes = [wallMesh];
  group.userData.wallThickness = wallThickness;
  group.userData.floorMesh = floor;
  group.userData.water = water;
  group.userData.waterMesh = water;
  group.userData.copingMesh = copingMesh;
  group.userData.outerPts = outline;

  if (water.userData?.animate) {
    group.userData.animatables = [water];
  }

  if (water.userData?.triggerRipple) {
    group.userData.triggerRipple = water.userData.triggerRipple;
  }

  return group;
}

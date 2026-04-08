// js/pool/shapes/rectanglePool.js
import * as THREE from "https://esm.sh/three@0.158.0";
import { createPoolWater } from "../water.js";

export function createRectanglePool(params, tileSize = 0.3) {
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

  /* -------------------------------------------------------
     FLOOR
  ------------------------------------------------------- */
  const segmentsX = Math.max(2, Math.floor(length * 10));
  const segmentsY = Math.max(2, Math.floor(width * 10));
  const floorGeo = new THREE.PlaneGeometry(
    length,
    width,
    segmentsX,
    segmentsY
  );

  const pos = floorGeo.attributes.position;

  const axisStartWallX = -length / 2;
  const axisEndX = length / 2;

  const STEP_LENGTH = 0.3;
  const STEP_TOP_OFFSET = 0.25;

// Shared source of truth: how far the steps run into the pool
const stepFootprintLen = (stepCount > 0 ? STEP_LENGTH * stepCount : 0);

// Slope + flats begin AFTER the steps
const originX = axisStartWallX + stepFootprintLen;

// Persist for downstream systems / debugging
group.userData.stepFootprintLen = stepFootprintLen;
group.userData.originX = originX;

  const fullLen = axisEndX - originX;

  let sFlat = shallowFlat || 0;
  let dFlat = deepFlat || 0;

  const maxFlats = Math.max(0, fullLen - 0.01);
  if (sFlat + dFlat > maxFlats) {
    const scale = maxFlats / (sFlat + dFlat);
    sFlat *= scale;
    dFlat *= scale;
  }

  const slopeLen = Math.max(0.01, fullLen - sFlat - dFlat);

  for (let i = 0; i < pos.count; i++) {
    const worldX = pos.getX(i);
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

  floorGeo.computeVertexNormals();
  const floor = new THREE.Mesh(
    floorGeo,
    new THREE.MeshStandardMaterial({ color: 0xffffff })
  );
  floor.receiveShadow = true;
  floor.userData.isFloor = true;
floor.userData.type = "floor";

  group.add(floor);

  /* -------------------------------------------------------
     STEPS
  ------------------------------------------------------- */
  if (stepCount > 0) {
    const shallowDepth = clampedShallow;

    for (let s = 0; s < stepCount; s++) {
      let h = stepDepth;

      // Last step auto-fills remaining depth down to shallow floor
      if (s === stepCount - 1) {
        const used = stepDepth * (stepCount - 1);
        h = shallowDepth - STEP_TOP_OFFSET - used;
        if (h < 0.05) h = 0.05;
      }

      const geo = new THREE.BoxGeometry(STEP_LENGTH, width, h);
      const mat = new THREE.MeshStandardMaterial({ color: 0xaaaaaa });

      const step = new THREE.Mesh(geo, mat);

      const x = -length / 2 + STEP_LENGTH * (s + 0.5);
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
  const waterGeo = floorGeo.clone();
  for (let i = 0; i < waterGeo.attributes.position.count; i++) {
    waterGeo.attributes.position.setZ(i, -0.1);
  }
  waterGeo.computeVertexNormals();

  const water = createPoolWater(length, width, waterGeo);
  water.receiveShadow = true;
  if (water.material) {
    water.material.depthWrite = false;
  }
  water.renderOrder = 1;
  group.add(water);

  /* -------------------------------------------------------
     WALLS
  ------------------------------------------------------- */
  const wallThickness = 0.2; // fixed wall thickness
  const wallMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    side: THREE.DoubleSide
  });

  const walls = [
    new THREE.Mesh(
      new THREE.BoxGeometry(length, wallThickness, clampedDeep),
      wallMat.clone()
    ), // 0: south
    new THREE.Mesh(
      new THREE.BoxGeometry(length, wallThickness, clampedDeep),
      wallMat.clone()
    ), // 1: north
    new THREE.Mesh(
      new THREE.BoxGeometry(wallThickness, width, clampedDeep),
      wallMat.clone()
    ), // 2: east
    new THREE.Mesh(
      new THREE.BoxGeometry(wallThickness, width, clampedDeep),
      wallMat.clone()
    ) // 3: west
  ];

  // Top of walls is at z = 0 (center at -clampedDeep/2 with height clampedDeep)
  walls[0].position.set(0, -width / 2 - wallThickness / 2, -clampedDeep / 2); // south
  walls[1].position.set(0, width / 2 + wallThickness / 2, -clampedDeep / 2);  // north
  walls[2].position.set(length / 2 + wallThickness / 2, 0, -clampedDeep / 2); // east
  walls[3].position.set(-length / 2 - wallThickness / 2, 0, -clampedDeep / 2); // west

  const wallSides = ["south", "north", "east", "west"];
  const wallEdgeIndices = [0, 2, 1, 3];

  walls.forEach((w, idx) => {
    w.castShadow = true;
    w.receiveShadow = true;

    w.userData.isWall = true;
    w.userData.baseHeight = clampedDeep;
    w.userData.extraHeight = 0;
    w.userData.side = wallSides[idx];
    w.userData.copingKey = wallSides[idx];
    w.userData.edgeIndex = wallEdgeIndices[idx];

    group.add(w);
  });

  /* -------------------------------------------------------
     COPING – 4 SEPARATE SEGMENTS (one per wall)
     PBR Travertine from textures/Coping/
  ------------------------------------------------------- */
  const poolPts = [
    new THREE.Vector2(-length / 2, -width / 2),
    new THREE.Vector2(length / 2, -width / 2),
    new THREE.Vector2(length / 2, width / 2),
    new THREE.Vector2(-length / 2, width / 2)
  ];
  group.userData.outerPts = poolPts; // used by ground void etc.

  const copingOverhang = 0.05;  // inward overhang toward water
  const copingDepth = 0.1;      // vertical thickness of coping
  const zOffset = 0.001;        // small lift to avoid z-fighting

  const halfL = length / 2;
  const halfW = width / 2;

  const outerHalfL = halfL + wallThickness;
  const outerHalfW = halfW + wallThickness;

  const longX = outerHalfL * 2;
  const longY = outerHalfW * 2;
  const short = wallThickness + copingOverhang;

  // PBR textures
  const baseColorMap = loader.load(
    "textures/Coping/TilesTravertine001_COL_4K.jpg"
  );
  const normalMap = loader.load(
    "textures/Coping/TilesTravertine001_NRM_4K.jpg"
  );
  const roughnessMap = loader.load(
    "textures/Coping/TilesTravertine001_GLOSS_4K.jpg"
  );
  const aoMap = loader.load(
    "textures/Coping/TilesTravertine001_AO_4K.jpg"
  );

  [baseColorMap, normalMap, roughnessMap, aoMap].forEach((tex) => {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(2, 2);
  });

  function makeCopingMat() {
    return new THREE.MeshStandardMaterial({
      map: baseColorMap,
      normalMap,
      roughnessMap,
      aoMap,
      metalness: 0.0,
      roughness: 1.0
    });
  }

  function addUV2(geo) {
    if (geo.attributes && geo.attributes.uv && !geo.attributes.uv2) {
      geo.setAttribute(
        "uv2",
        new THREE.BufferAttribute(geo.attributes.uv.array, 2)
      );
    }
  }

  // SOUTH coping segment
  const copingSouthGeo = new THREE.BoxGeometry(longX, short, copingDepth);
  addUV2(copingSouthGeo);
  const copingSouth = new THREE.Mesh(copingSouthGeo, makeCopingMat());
  copingSouth.position.set(
    0,
    -halfW - wallThickness / 2 + copingOverhang / 2,
    copingDepth / 2 + zOffset
  );
  copingSouth.castShadow = true;
  copingSouth.receiveShadow = true;
  copingSouth.userData.isCoping = true;
  copingSouth.userData.baseZ = copingSouth.position.z;
  copingSouth.userData.side = "south";
  group.add(copingSouth);

  // NORTH coping segment
  const copingNorthGeo = new THREE.BoxGeometry(longX, short, copingDepth);
  addUV2(copingNorthGeo);
  const copingNorth = new THREE.Mesh(copingNorthGeo, makeCopingMat());
  copingNorth.position.set(
    0,
    halfW + wallThickness / 2 - copingOverhang / 2,
    copingDepth / 2 + zOffset
  );
  copingNorth.castShadow = true;
  copingNorth.receiveShadow = true;
  copingNorth.userData.isCoping = true;
  copingNorth.userData.baseZ = copingNorth.position.z;
  copingNorth.userData.side = "north";
  group.add(copingNorth);

  // EAST coping segment
  const copingEastGeo = new THREE.BoxGeometry(short, longY, copingDepth);
  addUV2(copingEastGeo);
  const copingEast = new THREE.Mesh(copingEastGeo, makeCopingMat());
  copingEast.position.set(
    halfL + wallThickness / 2 - copingOverhang / 2,
    0,
    copingDepth / 2 + zOffset
  );
  copingEast.castShadow = true;
  copingEast.receiveShadow = true;
  copingEast.userData.isCoping = true;
  copingEast.userData.baseZ = copingEast.position.z;
  copingEast.userData.side = "east";
  group.add(copingEast);

  // WEST coping segment
  const copingWestGeo = new THREE.BoxGeometry(short, longY, copingDepth);
  addUV2(copingWestGeo);
  const copingWest = new THREE.Mesh(copingWestGeo, makeCopingMat());
  copingWest.position.set(
    -halfL - wallThickness / 2 + copingOverhang / 2,
    0,
    copingDepth / 2 + zOffset
  );
  copingWest.castShadow = true;
  copingWest.receiveShadow = true;
  copingWest.userData.isCoping = true;
  copingWest.userData.baseZ = copingWest.position.z;
  copingWest.userData.side = "west";
  group.add(copingWest);

  group.userData.copingSegments = {
    south: copingSouth,
    north: copingNorth,
    east: copingEast,
    west: copingWest
  };

  /* -------------------------------------------------------
     METADATA / ANIMATION
  ------------------------------------------------------- */
  const animatables = [];
  group.traverse((o) => {
    if (o.userData && typeof o.userData.animate === "function") {
      animatables.push(o);
    }
  });

  group.userData.floorMesh = floor;
  group.userData.waterMesh = water;
  group.userData.water = water;
  group.userData.wallMeshes = walls;
  group.userData.wallThickness = wallThickness;
  group.userData.animatables = animatables;

  return group;
}

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

const SPA_SEAT_DEPTH = 0.45;
const SPA_SEAT_TOP_OFFSET = 0.5;
const SPA_SEAT_THICKNESS = 2.18;
let SPA_TOP_OFFSET = 0.0;

// --- Water tuning ---
const WATER_OVERFLOW = 0.015;

// --- SPA storage ---
export let spas = [];
export let selectedSpa = null;

// Allow external code (PoolApp) to change current selected spa
export function setSelectedSpa(spa) {
  selectedSpa = spa;
}

// --- Top offset setter ---
export function setSpaTopOffset(val) {
  SPA_TOP_OFFSET = val;
  if (selectedSpa) {
    updateSpaWalls(selectedSpa);
    updateSpaSeats(selectedSpa);
  }
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


// --- Seats ---
function updateSpaSeats(spa) {
  const l = spa.userData.spaLength;
  const w = spa.userData.spaWidth;
  const h = spa.userData.height;

  const spaTop = spa.position.z + h / 2;
  const seatTopAbs = spaTop - SPA_SEAT_TOP_OFFSET;
  const seatCenterAbs = seatTopAbs - SPA_SEAT_THICKNESS / 2;
  const seatCenterLocal = seatCenterAbs - spa.position.z;

const seats = spa.userData.seats;
const tileSize = spa.userData.tileSize || 0.3;

function rebuildSeat(mesh, sx, sy, sz) {
  const geo = new THREE.BoxGeometry(sx, sy, sz);
  generateMeterUVsForBoxGeometry(geo, tileSize);
  mesh.geometry.dispose();
  mesh.geometry = geo;
  mesh.scale.set(1, 1, 1);
}

rebuildSeat(seats.front, l, SPA_SEAT_DEPTH, SPA_SEAT_THICKNESS);
seats.front.position.set(0, -w / 2 + SPA_SEAT_DEPTH / 2, seatCenterLocal);

rebuildSeat(seats.back, l, SPA_SEAT_DEPTH, SPA_SEAT_THICKNESS);
seats.back.position.set(0, w / 2 - SPA_SEAT_DEPTH / 2, seatCenterLocal);

rebuildSeat(seats.left, SPA_SEAT_DEPTH, w, SPA_SEAT_THICKNESS);
seats.left.position.set(-l / 2 + SPA_SEAT_DEPTH / 2, 0, seatCenterLocal);

rebuildSeat(seats.right, SPA_SEAT_DEPTH, w, SPA_SEAT_THICKNESS);
seats.right.position.set(l / 2 - SPA_SEAT_DEPTH / 2, 0, seatCenterLocal);


  // Prevent seats from going below spa floor
  const bottom = spa.position.z - h / 2;
  if (seatTopAbs < bottom + 0.05) {
    const adjTop = bottom + 0.05;
    const adjCenterLocal = adjTop - SPA_SEAT_THICKNESS / 2 - spa.position.z;
    [seats.front, seats.back, seats.left, seats.right].forEach(
      (s) => (s.position.z = adjCenterLocal)
    );
  }
}

// --- Walls & water ---
function updateSpaWalls(spa) {
  const water = spa.userData.waterMesh;
  const walls = spa.userData.walls;
  const poolParams = spa.userData.poolParams;

  // Vertical: bottom at deep floor, top at SPA_TOP_OFFSET
  const bottomZ = getDeepFloorZ(poolParams);
  const topZ = SPA_TOP_OFFSET;
  const h = topZ - bottomZ;
  spa.userData.height = h;
  spa.position.z = bottomZ + h / 2;

  const l = spa.userData.spaLength;
  const w = spa.userData.spaWidth;
  const t = SPA_WALL_THICKNESS;
  const overflow = WATER_OVERFLOW;

  // Knife-edge walls
  const knifeOffset = 0.05;
  const wallHeightOuter = h;
  const knifeDirections = { left: 1, right: -1, front: 1, back: -1 };

  function setKnifeWall(wall, width, depth, horizontal = true, knifeDir = 1) {
    const geometry = new THREE.BoxGeometry(width, depth, wallHeightOuter);
    const tileSize = spa.userData.tileSize || 0.3;
    generateMeterUVsForBoxGeometry(geometry, tileSize);
    const pos = geometry.attributes.position;

    for (let i = 0; i < pos.count; i++) {
      const z = pos.getZ(i);
      if (z > 0) {
        if (horizontal) {
          if (knifeDir > 0 && pos.getY(i) > 0) pos.setZ(i, z - knifeOffset);
          if (knifeDir < 0 && pos.getY(i) < 0) pos.setZ(i, z - knifeOffset);
        } else {
          if (knifeDir > 0 && pos.getX(i) > 0) pos.setZ(i, z - knifeOffset);
          if (knifeDir < 0 && pos.getX(i) < 0) pos.setZ(i, z - knifeOffset);
        }
      }
    }

    geometry.computeVertexNormals();
    wall.geometry.dispose();
    wall.geometry = geometry;
  }

  // Left / right / front / back walls
  setKnifeWall(walls.left, t, w + 2 * t, false, knifeDirections.left);
  walls.left.position.set(-l / 2 - t / 2, 0, 0);

  setKnifeWall(walls.right, t, w + 2 * t, false, knifeDirections.right);
  walls.right.position.set(l / 2 + t / 2, 0, 0);

  setKnifeWall(walls.front, l + 2 * t, t, true, knifeDirections.front);
  walls.front.position.set(0, -w / 2 - t / 2, 0);

  setKnifeWall(walls.back, l + 2 * t, t, true, knifeDirections.back);
  walls.back.position.set(0, w / 2 + t / 2, 0);

  // --- Water ---
  // Pool water bottom is fixed at -0.1 → spa water bottom must match it
  const waterBottomWorld = -0.1;
  const poolWaterTop = SPA_TOP_OFFSET;
  const waterHeight = poolWaterTop - waterBottomWorld;

  water.scale.set(
    l + 2 * (t + overflow),
    w + 2 * (t + overflow),
    waterHeight
  );

  const waterCenterLocal =
    waterBottomWorld + waterHeight / 2 - spa.position.z;
  water.position.set(0, 0, waterCenterLocal);

// Sync depth falloff mapping to pool depth
if (water?.userData?.waterUniforms) {
  const u = water.userData.waterUniforms;
  const spaDepth = (SPA_TOP_OFFSET - getDeepFloorZ(poolParams));
  const poolDepth = Math.max(0.1, poolParams?.deep || spaDepth || 2.0);
  if (u.thicknessDeep) u.thicknessDeep.value = poolDepth;
  if (u.thicknessToT)  u.thicknessToT.value  = 0.45 * (poolDepth / Math.max(0.1, spaDepth));
}

updateSpillover(spa);

// --- Floor slab inside spa ---
const floor = spa.userData.floor;
if (floor) {
  const tileSize = spa.userData.tileSize || 0.3;
  const floorHeight = 0.1;

  // Rebuild geometry so UV density matches the pool (meter UVs)
  const geo = new THREE.BoxGeometry(l, w, floorHeight);
  generateMeterUVsForBoxGeometry(geo, tileSize);
  floor.geometry.dispose();
  floor.geometry = geo;
  floor.scale.set(1, 1, 1);

  const spaTopWorld = spa.position.z + spa.userData.height / 2;
  const floorCenterZ = spaTopWorld - 1 - floorHeight / 2;
  floor.position.set(0, 0, floorCenterZ - spa.position.z);
}
}


function updateSpillover(spa) {
  const spill = spa.userData.spilloverMesh;
  if (!spill) return;

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
  const poolParams = spa.userData.poolParams;
  const halfL = poolParams.length / 2;
  const halfW = poolParams.width / 2;
  const l = spa.userData.spaLength;
  const w = spa.userData.spaWidth;

  const x = spa.position.x;
  const y = spa.position.y;

  // Below threshold → "on wall" → no extra gap
  // Above threshold → raised spa → 350mm out from wall
  const dynamicSnap =
    SPA_TOP_OFFSET <= SNAP_HEIGHT_THRESHOLD ? 0.0 : SNAP_OFFSET_RAISED;

  const dist = {
    left: Math.abs(x + halfL),
    right: Math.abs(x - halfL),
    front: Math.abs(y + halfW),
    back: Math.abs(y - halfW)
  };

  const close = Object.entries(dist).sort((a, b) => a[1] - b[1])[0][0];
  spa.userData.snapSide = close;

  if (close === "left") spa.position.x = -halfL + l / 2 + dynamicSnap;
  if (close === "right") spa.position.x = halfL - l / 2 - dynamicSnap;
  if (close === "front") spa.position.y = -halfW + w / 2 + dynamicSnap;
  if (close === "back") spa.position.y = halfW - w / 2 - dynamicSnap;
}

// --- Create SPA ---
export function createSpa(poolParams, scene, options = {}) {
  const loader = new THREE.TextureLoader();
  const spaLength = options.length || 2.0;
  const spaWidth = options.width || 2.0;

  const spa = new THREE.Group();
  spa.userData.poolParams = poolParams;
  spa.userData.tileSize = options.tileSize ?? poolParams?.tileSize ?? 0.3;
  spa.userData.spaLength = spaLength;
  spa.userData.spaWidth = spaWidth;

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
  spa.userData.seats = seats;

  // Floor
  const floorMat = new THREE.MeshStandardMaterial({ color: 0xaaaaaa });
  const floor = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 0.1), floorMat);
  floor.receiveShadow = true;
  floor.userData.isSpaFloor = true;
  spa.add(floor);
  spa.userData.floor = floor;

// Water (reuse pool water system)
const water = createPoolWater(new THREE.BoxGeometry(1, 1, 1));
water.userData.isSpaWater = true; // so PBR won't tile over this

// Spa-only tuning (slightly more lively than pool)
if (water.userData?.waterUniforms) {
  const u = water.userData.waterUniforms;
  if (u.microStrength) u.microStrength.value *= 1.25;
  if (u.microScale)    u.microScale.value    *= 1.10;
  if (u.microSpeed)    u.microSpeed.value    *= 1.10;
}
water.userData.setSimParams?.({ viscosity: 0.989, waveSpeed: 0.52, drive: 0.004 });

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
    foam: { value: 0.65 }
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
      float edge = smoothstep(0.85, 1.0, vUv.y) * foam;

      // Fade in/out vertically (avoid hard rectangle)
      float fadeTop = smoothstep(0.98, 0.80, vUv.y);
      float fadeBot = smoothstep(0.02, 0.18, vUv.y);

      float a = (0.12 + 0.55*streak + 0.35*edge) * fadeTop * fadeBot * strength;

      vec3 col = mix(vec3(0.75, 0.90, 0.98), vec3(1.0), edge);
      gl_FragColor = vec4(col, a);
    }
  `
});

const spill = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 1, 1), spillMat);
spill.frustumCulled = false;
spill.visible = false;
spill.userData.animate = (delta, clock) => {
  spillMat.uniforms.uTime.value = clock.getElapsedTime();
};
spa.add(spill);
spa.userData.spilloverMesh = spill;
  // Initial placement: start at deep end floor
  spa.position.z = getDeepFloorZ(poolParams) + (poolParams?.deep || 2) / 2;

  updateSpaWalls(spa);
  updateSpaSeats(spa);
  snapToPool(spa);

  scene.add(spa);
  spas.push(spa);
  setSelectedSpa(spa);

  return spa;
}

// --- Update SPA ---
export function updateSpa(spa) {
  if (!spa) return;
  updateSpaWalls(spa);
  updateSpaSeats(spa);
  snapToPool(spa);
}

// --- Update SPA dimensions ---
export function updateSpaDimensions(length, width) {
  if (!selectedSpa) return;
  selectedSpa.userData.spaLength = length;
  selectedSpa.userData.spaWidth = width;
  updateSpa(selectedSpa);
}

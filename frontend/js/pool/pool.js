// js/pool/pool.js
import * as THREE from "https://esm.sh/three@0.158.0";
import { createPoolWater } from "./water.js";
import { EditablePolygon } from "./editing/polygon.js";

/* =====================================================
   UV HELPERS
   ===================================================== */

function generateMeterUVsForShapeGeometry(geo, tileSize) {
  const pos = geo.attributes.position;
  const uvs = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uvs[i * 2] = pos.getX(i) / tileSize;
    uvs[i * 2 + 1] = pos.getY(i) / tileSize;
  }
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
}

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
}

function addUV2(geo) {
  if (geo?.attributes?.uv && !geo.attributes.uv2) {
    geo.setAttribute("uv2", geo.attributes.uv.clone());
  }
}

/* =====================================================
   RECTANGLE POOL DEPTH LOGIC (ported verbatim style)
   ===================================================== */

function computeRectangleDepthAtX(worldX, params, axisStartX, axisEndX, originX) {
  const clampedShallow = Math.max(0.5, params.shallow);
  const clampedDeep = Math.max(clampedShallow, params.deep);

  let sFlat = params.shallowFlat || 0;
  let dFlat = params.deepFlat || 0;

  const fullLen = axisEndX - originX;
  const maxFlats = Math.max(0, fullLen - 0.01);

  if (sFlat + dFlat > maxFlats) {
    const scale = maxFlats / (sFlat + dFlat);
    sFlat *= scale;
    dFlat *= scale;
  }

  const slopeLen = Math.max(0.01, fullLen - sFlat - dFlat);

  // dx measured from "originX" (which accounts for steps region)
  let dx = worldX - originX;
  if (dx < 0) dx = 0;

  if (dx <= sFlat) return -clampedShallow;
  if (dx >= fullLen - dFlat) return -clampedDeep;

  const t = (dx - sFlat) / slopeLen;
  return -(clampedShallow + t * (clampedDeep - clampedShallow));
}

/* =====================================================
   CURVE SAMPLING (FOR WALL BENDING)
   ===================================================== */

function sampleQuadratic(v1, c, v2, segments) {
  const pts = [];
  const n = Math.max(2, segments | 0);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const it = 1 - t;
    pts.push(
      new THREE.Vector2(
        it * it * v1.x + 2 * it * t * c.x + t * t * v2.x,
        it * it * v1.y + 2 * it * t * c.y + t * t * v2.y
      )
    );
  }
  return pts;
}



function polygonSignedArea(points) {
  if (!Array.isArray(points) || points.length < 3) return 0;
  let area = 0;
  const n = points.length;
  const limit = points[0].distanceToSquared(points[n - 1]) < 1e-10 ? n - 1 : n;
  for (let i = 0; i < limit; i++) {
    const a = points[i];
    const b = points[(i + 1) % limit];
    area += a.x * b.y - b.x * a.y;
  }
  return area * 0.5;
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

function createMiteredWallPrism(pPrev, p0, p1, pNext, halfThickness, height, isCCW) {
  const dir = p1.clone().sub(p0);
  const len = dir.length();
  if (len < 1e-6) return null;
  dir.multiplyScalar(1 / len);

  const prevDir = p0.clone().sub(pPrev);
  if (prevDir.lengthSq() > 1e-10) prevDir.normalize();
  else prevDir.copy(dir);

  const nextDir = pNext.clone().sub(p1);
  if (nextDir.lengthSq() > 1e-10) nextDir.normalize();
  else nextDir.copy(dir);

  const leftNormal = (v) => new THREE.Vector2(-v.y, v.x);
  const inwardFor = (v) => (isCCW ? leftNormal(v) : leftNormal(v).multiplyScalar(-1));

  const curIn = inwardFor(dir);
  const prevIn = inwardFor(prevDir);
  const nextIn = inwardFor(nextDir);

  const curOut = curIn.clone().multiplyScalar(-1);
  const prevOut = prevIn.clone().multiplyScalar(-1);
  const nextOut = nextIn.clone().multiplyScalar(-1);

  const offsetLine = (a, b, n, d) => [a.clone().addScaledVector(n, d), b.clone().addScaledVector(n, d)];

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
  // Center the wall depth around the local origin so wall raising can use the
  // same stable transform behaviour as the older v7.1 box-based walls:
  // scale local Z, then shift the mesh by half the extra height.
  geo.translate(0, 0, -height * 0.5);
  geo.computeVertexNormals();
  return geo;
}

function makeShapeFromClosedPoints(points) {
  const shape = new THREE.Shape();
  if (!points || points.length < 3) return shape;

  const first = points[0];
  shape.moveTo(first.x, first.y);
  for (let i = 1; i < points.length; i++) {
    shape.lineTo(points[i].x, points[i].y);
  }

  const last = points[points.length - 1];
  if (last.distanceToSquared(first) > 1e-10) {
    shape.lineTo(first.x, first.y);
  }
  return shape;
}

/* =====================================================
   COPING MATERIAL (restore travertine PBR)
   ===================================================== */

const _copingTexCache = { loaded: false, maps: null };
function getCopingMaps() {
  if (_copingTexCache.loaded) return _copingTexCache.maps;

  const loader = new THREE.TextureLoader();
  const baseColorMap = loader.load("textures/Coping/TilesTravertine001_COL_4K.jpg");
  const normalMap = loader.load("textures/Coping/TilesTravertine001_NRM_4K.jpg");
  const roughnessMap = loader.load("textures/Coping/TilesTravertine001_GLOSS_4K.jpg");
  const aoMap = loader.load("textures/Coping/TilesTravertine001_AO_4K.jpg");

  [baseColorMap, normalMap, roughnessMap, aoMap].forEach((tex) => {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(2, 2);
  });

  _copingTexCache.loaded = true;
  _copingTexCache.maps = { baseColorMap, normalMap, roughnessMap, aoMap };
  return _copingTexCache.maps;
}

function makeCopingMat() {
  const maps = getCopingMaps();
  return new THREE.MeshStandardMaterial({
    map: maps.baseColorMap,
    normalMap: maps.normalMap,
    roughnessMap: maps.roughnessMap,
    aoMap: maps.aoMap,
    metalness: 0.0,
    roughness: 1.0
  });
}

/* =====================================================
   POOL BUILDER
   ===================================================== */

class PoolBuilder {
  constructor(polygon, params, tileSize) {
    this.polygon = polygon;
    this.params = params;
    this.tileSize = tileSize;

    this.group = new THREE.Group();

    // Keep datum at z=0 (coping / top of wall)
    this.group.position.set(0, 0, 0);

    this.group.userData.poolParams = { ...params };

    // PoolApp expects copingSegments array + wall.copingIndex mapping
    this.copingMeshes = [];

    this.build();
  }

  clearGroup() {
    while (this.group.children.length) {
      const c = this.group.children.pop();
      if (c?.geometry) c.geometry.dispose();
      // Do not dispose materials here (PBRManager swaps materials a lot).
    }
  }

  build() {
    this.clearGroup();
    this.copingMeshes.length = 0;

    // Build the visible/water footprint from the fully sampled perimeter so
    // freeform curves and edited edges fill the actual pool shape.
    let shape = null;

    // We will build:
    //  - CURVE-AWARE perimeter for walls/coping + outerPts (void cutting)
    //  - RECTANGULAR footprint (bounding box) for floor + rectangle steps
    const perimeter2D = [];
    const perimeterSourceEdgeIndices = [];
    const vCount = this.polygon.vertexCount();

    for (let i = 0; i < vCount; i++) {
      const v1 = this.polygon.getVertex(i);
      const v2 = this.polygon.getVertex(this.polygon.nextIndex(i));
      const e = this.polygon.getEdge(i);

      const pts =
        e?.isCurved && e.control
          ? sampleQuadratic(v1, e.control, v2, 24)
          : [v1.clone(), v2.clone()];

      for (let j = 0; j < pts.length - 1; j++) {
        const p1 = pts[j];
        // avoid duplicates
        if (
          perimeter2D.length === 0 ||
          perimeter2D[perimeter2D.length - 1].distanceToSquared(p1) > 1e-10
        ) {
          perimeter2D.push(p1.clone());
          perimeterSourceEdgeIndices.push(i);
        }
      }
    }

    // close loop with last vertex
    if (perimeter2D.length) {
      const last = perimeter2D[perimeter2D.length - 1];
      const first = perimeter2D[0];
      if (last.distanceToSquared(first) > 1e-10) perimeter2D.push(first.clone());
    }

    shape = makeShapeFromClosedPoints(perimeter2D);

    // Expose outerPts for ground void cutting (PoolApp/scene.js uses this)
    this.group.userData.outerPts = perimeter2D.map(
      (v) => new THREE.Vector2(v.x, v.y)
    );

    // Bounding box footprint for rectangle-style floor/steps
    const bb = new THREE.Box2();
    for (const p of perimeter2D) bb.expandByPoint(p);

    const bbLen = Math.max(0.1, bb.max.x - bb.min.x);
    const bbWid = Math.max(0.1, bb.max.y - bb.min.y);

    const cx = (bb.min.x + bb.max.x) * 0.5;
    const cy = (bb.min.y + bb.max.y) * 0.5;

    /* =====================================================
       FLOOR (RECTANGLE-POOL LOGIC, FIT TO BBOX)
       ===================================================== */

    const segmentsX = Math.max(2, Math.floor(bbLen * 10));
    const segmentsY = Math.max(2, Math.floor(bbWid * 10));

    const floorGeo = new THREE.PlaneGeometry(bbLen, bbWid, segmentsX, segmentsY);

    // PlaneGeometry is centered at origin; shift it to bbox center in world
    // (we keep it as mesh.position, not baking into vertices)
    // Apply depth to vertices using "worldX"
    const floorPos = floorGeo.attributes.position;

    const STEP_LENGTH = 0.3;
    const STEP_TOP_OFFSET = 0.25;

    const stepCount = Math.max(0, this.params.stepCount | 0);
    const stepDepth = Math.max(0.01, this.params.stepDepth ?? 0.2);

    const axisStartWallX = cx - bbLen / 2;
    const axisEndX = cx + bbLen / 2;

    // originX is shifted past the step run (exactly like rectanglePool.js)
    let originX = axisStartWallX;
    if (stepCount > 0) {
      const stepEdgeX = axisStartWallX + STEP_LENGTH * stepCount;
      originX = stepEdgeX;
    }

    for (let i = 0; i < floorPos.count; i++) {
      // local x -> world x
      const localX = floorPos.getX(i);
      const worldX = localX + cx;

      const z = computeRectangleDepthAtX(
        worldX,
        this.params,
        axisStartWallX,
        axisEndX,
        originX
      );

      floorPos.setZ(i, z);
    }

    floorGeo.computeVertexNormals();
    generateMeterUVsForShapeGeometry(floorGeo, this.tileSize);

    const floor = new THREE.Mesh(floorGeo, new THREE.MeshStandardMaterial());
    floor.position.set(cx, cy, 0);
    floor.receiveShadow = true;
    floor.userData.isFloor = true;
    floor.userData.type = "floor";
    this.group.add(floor);

    
    this.group.userData.floorMesh = floor;
    this.group.userData.floorMeta = {
      cx, cy,
      bbLen, bbWid,
      axisStartWallX,
      axisEndX,
      originX,
    };

/* =====================================================
       STEPS (RECTANGLE-POOL LOGIC, FIT TO BBOX WIDTH)
       ===================================================== */

    if (stepCount > 0) {
      const clampedShallow = Math.max(0.5, this.params.shallow);
      const width = bbWid;

      for (let s = 0; s < stepCount; s++) {
        let h = stepDepth;

        // last step auto-fills remaining down to shallow floor
        if (s === stepCount - 1) {
          const used = stepDepth * (stepCount - 1);
          h = clampedShallow - STEP_TOP_OFFSET - used;
          if (h < 0.05) h = 0.05;
        }

        const geo = new THREE.BoxGeometry(STEP_LENGTH, width, h);
        const step = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());

        const x = axisStartWallX + STEP_LENGTH * (s + 0.5);
        const z =
          s === stepCount - 1
            ? -(clampedShallow - h / 2)
            : -(STEP_TOP_OFFSET + stepDepth * (s + 0.5));

        step.position.set(x, cy, z);
        step.userData.isStep = true;
        step.userData.type = "step";
        step.userData.stepIndex = s;
        step.userData.baseHeight = h;
        step.castShadow = true;
        step.receiveShadow = true;

        this.group.add(step);
      }
    }

    /* =====================================================
       WALLS + COPING (CURVE-AWARE, BENDS WITH BLUE HANDLES)
       ===================================================== */
    const wallHeight = Math.max(this.params.deep, this.params.shallow);
    const wallThickness = 0.05;
    const isCCW = polygonSignedArea(perimeter2D) >= 0;

    // We build walls from perimeter2D segments using mitered joins so corners do not overlap/flicker.
    for (let i = 0; i < perimeter2D.length - 1; i++) {
      const p0 = perimeter2D[i];
      const p1 = perimeter2D[i + 1];
      const pPrev = perimeter2D[(i - 1 + (perimeter2D.length - 1)) % (perimeter2D.length - 1)];
      const pNext = perimeter2D[(i + 2) % (perimeter2D.length - 1)];

      const len = p0.distanceTo(p1);
      if (len < 1e-6) continue;

      const wallGeo = createMiteredWallPrism(pPrev, p0, p1, pNext, wallThickness * 0.5, wallHeight, isCCW);
      if (!wallGeo) continue;
      generateMeterUVsForBoxGeometry(wallGeo, this.tileSize);
      addUV2(wallGeo);

      const wall = new THREE.Mesh(wallGeo, new THREE.MeshStandardMaterial());
      wall.position.z = -wallHeight / 2;
      wall.castShadow = true;
      wall.receiveShadow = true;
      wall.userData.isWall = true;
      wall.userData.baseHeight = wallHeight;
      wall.userData.currentHeight = wallHeight;
      wall.userData.extraHeight = 0;
      const sourceEdgeIndex = perimeterSourceEdgeIndices[i] ?? i;
      wall.userData.copingIndex = this.copingMeshes.length;
      wall.userData.edgeIndex = i;
      wall.userData.sourceEdgeIndex = sourceEdgeIndex;
      wall.userData.sourceEdgeCurved = !!this.polygon.getEdge(sourceEdgeIndex)?.isCurved;
      this.group.add(wall);

      const copingDepth = 0.1;
      const copingGeo = createMiteredWallPrism(pPrev, p0, p1, pNext, wallThickness, copingDepth, isCCW);
      if (!copingGeo) continue;
      generateMeterUVsForBoxGeometry(copingGeo, this.tileSize);
      addUV2(copingGeo);

      const coping = new THREE.Mesh(copingGeo, makeCopingMat());
      coping.position.z = 0.001;
      coping.castShadow = true;
      coping.receiveShadow = true;
      coping.userData.isCoping = true;
      coping.userData.baseZ = coping.position.z;
      this.group.add(coping);
      this.copingMeshes.push(coping);
    }

    this.group.userData.copingSegments = this.copingMeshes;

    /* =====================================================
       WATER (FOLLOW FREEFORM SHAPE, NOT THE RECT FLOOR)
       ===================================================== */

    const water = createPoolWater(this.params.length, this.params.width);
    const waterGeo = new THREE.ShapeGeometry(shape, 256);

    if (water.geometry) water.geometry.dispose();
    water.geometry = waterGeo;

    water.position.set(0, 0, -0.1);
    this.group.userData.waterMesh = water;
    this.group.add(water);

    
    // ------------------------------------------------------------
    // Caustics overlay (projected onto pool floor) driven by ripple sim gradient
    // ------------------------------------------------------------
    if (false && !this.group.userData.causticsOverlay && this.group.userData.floorMesh) { // disabled: using CausticsSystem RT injection
      const floorMesh = this.group.userData.floorMesh;

      const causticsUniforms = {
        time: { value: 0 },
        heightTex: { value: (water.material?.uniforms?.heightTex?.value || water.material?.uniforms?.heightmap?.value || null) },
        texel: { value: new THREE.Vector2(1 / 512, 1 / 512) },
        poolCenter: { value: new THREE.Vector2(floorMesh.position.x, floorMesh.position.y) },
        poolSize: { value: new THREE.Vector2(this.params.length, this.params.width) },
        strength: { value: 1.25 },
        scale: { value: 2.6 },
        speed: { value: 0.42 }
      };

      const causticsMat = new THREE.ShaderMaterial({
        uniforms: causticsUniforms,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
        vertexShader: `
          varying vec2 vUv;
          varying vec3 vPosW;
          void main(){
            vUv = uv;
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vPosW = wp.xyz;
            gl_Position = projectionMatrix * viewMatrix * wp;
          }
        `,
        fragmentShader: `
          precision highp float;

          uniform float time;
          uniform sampler2D heightTex;
          uniform vec2 texel;

          uniform vec2 poolCenter;
          uniform vec2 poolSize;

          uniform float strength;
          uniform float scale;
          uniform float speed;

          varying vec2 vUv;
          varying vec3 vPosW;

          float hmap(vec2 uv){ return texture2D(heightTex, uv).r; }

          void main(){
            // Map world XY to 0..1 over pool footprint
            vec2 rel = (vPosW.xy - poolCenter) / max(poolSize, vec2(0.001));
            vec2 cuv = rel + 0.5;

            // Animated caustics UV (Water.zip style drift)
            cuv = fract(cuv * scale + vec2(0.09, -0.06) * time * speed);

            float h0 = hmap(cuv);
            float hx = hmap(cuv + vec2(texel.x, 0.0));
            float hy = hmap(cuv + vec2(0.0, texel.y));
            vec2 g = vec2(hx - h0, hy - h0);

            float focus = 1.0 - smoothstep(0.0, 0.03, length(g));
            float ca = pow(focus, 6.0);

            float flow = 0.5 + 0.5 * sin((cuv.x + cuv.y) * 12.0 + time * 1.5);
            ca *= (0.55 + 0.65 * flow);

            float a = ca * strength;

            // Warm/cyan caustics tint (subtle)
            vec3 col = vec3(0.85, 0.95, 1.00) * a;

            // Fade toward edges so it doesn't hit the coping
            float edgeX = smoothstep(0.0, 0.06, cuv.x) * smoothstep(1.0, 0.94, cuv.x);
            float edgeY = smoothstep(0.0, 0.06, cuv.y) * smoothstep(1.0, 0.94, cuv.y);
            float edge = edgeX * edgeY;

            gl_FragColor = vec4(col, a * edge);
          }
        `
      });

      const causticsGeo = floorMesh.geometry.clone();
      const caustics = new THREE.Mesh(causticsGeo, causticsMat);
      caustics.position.copy(floorMesh.position);
      caustics.position.z += 0.02; // lift slightly above floor (Z-up)
      caustics.renderOrder = 5;

      // Animate hook (PoolApp animatables)
      caustics.userData.animate = (delta, clock, camera, dirLight, renderer) => {
        const t = clock.getElapsedTime();
        causticsMat.uniforms.time.value = t;

        // Keep sampling the latest heightmap texture from water sim
        const hm = water.material?.uniforms?.heightTex?.value || water.material?.uniforms?.heightmap?.value;
        if (hm) causticsMat.uniforms.heightTex.value = hm;
      };

      this.group.userData.causticsOverlay = caustics;
      this.group.userData.animatables = this.group.userData.animatables || [];
      this.group.userData.animatables.push(caustics);
      this.group.add(caustics);
    }
// Restore ripple hook expected by PoolApp
    const rippler =
      water?.userData?.triggerRipple ||
      water?.userData?.water?.userData?.triggerRipple ||
      water?.userData?.ripple?.triggerRipple;

    if (typeof rippler === "function") {
      this.group.userData.triggerRipple = (...args) => rippler(...args);
    }
  }

  getGroup() {
    return this.group;
  }
}

/* =====================================================
   EXPORT
   ===================================================== */

export function createPoolGroup(params, tileSize = 0.3, editablePolygon = null) {
  const polygon =
    editablePolygon || EditablePolygon.fromRectangle(params.length, params.width);

  const builder = new PoolBuilder(polygon, params, tileSize);
  const group = builder.getGroup();
  // Persist the latest full params on the group for lightweight live updates.
  group.userData.params = { ...params };
  return group;
}


// ------------------------------------------------------------
// Live preview: update floor vertex Z + wall height without rebuilding geometry.
// Safe for slider-drag; does NOT touch coping/steps/water sim.
// Requires: group.userData.floorMesh + group.userData.floorMeta
export function previewUpdateDepths(group, paramsPatch = {}) {
  if (!group?.userData?.floorMesh?.geometry) return false;

  // Merge patch onto last-known params (stored on group by creator)
  group.userData.params = group.userData.params || {};
  const params = Object.assign({}, group.userData.params, paramsPatch);

  // Keep semantics: deep >= shallow, both >= 0.5
  const shallow = Math.max(0.5, params.shallow ?? 1.2);
  const deep = Math.max(shallow, params.deep ?? shallow);
  params.shallow = shallow;
  params.deep = deep;

  const STEP_LENGTH = 0.3;
  const STEP_TOP_OFFSET = 0.25;

  // Some shapes don't store floorMeta. Fallback: derive an X-axis span directly
  // from the current floor geometry so we can still preview depth changes live.
  let meta = group.userData.floorMeta;
  if (!meta) {
    const floor = group.userData.floorMesh;
    const geo = floor.geometry;
    const pos = geo.attributes.position;

    let minX = Infinity, maxX = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }

    const cx = floor.position?.x || 0;
    const cy = floor.position?.y || 0;

    const axisStartWallX = minX + cx;
    const axisEndX = maxX + cx;

    // Make shallowFlat start AFTER the steps run (so sFlat=0 begins at last-step end).
    const stepCount = Math.max(0, (params.stepCount | 0));
    const originX = Math.min(axisEndX, axisStartWallX + STEP_LENGTH * stepCount);

    meta = { cx, cy, axisStartWallX, axisEndX, originX };
  }

  // Update floor vertices (z only)
  const floor = group.userData.floorMesh;
  const geo = floor.geometry;
  const pos = geo.attributes.position;
  const cx = meta.cx || 0;

  for (let i = 0; i < pos.count; i++) {
    const worldX = pos.getX(i) + cx; // local x + mesh center x
    const z = computeRectangleDepthAtX(
      worldX,
      params,
      meta.axisStartWallX || meta.originX,
      meta.axisEndX,
      meta.originX
    );
    pos.setZ(i, z);
  }

  pos.needsUpdate = true;

  // Normals: recompute (caller may throttle this by calling less often)
  geo.computeVertexNormals();
  if (geo.attributes.normal) geo.attributes.normal.needsUpdate = true;

  // Update wall height (uniform max depth; top stays at z=0)
  const wallHeight = Math.max(params.deep, params.shallow);
  group.traverse((obj) => {
    if (!obj?.isMesh) return;

    if (obj.userData?.isWall) {
      const baseH = obj.userData.baseHeight || 1;
      const extraH = Math.max(0, Number(obj.userData?.extraHeight) || 0);
      const totalH = wallHeight + extraH;
      obj.scale.z = totalH / baseH;
      obj.position.z = -(wallHeight / 2) + extraH / 2;
      obj.userData.currentHeight = totalH;
      return;
    }

    // Steps: keep all step tops fixed; last step grows/shrinks so its bottom stays
    // attached to the shallow floor when shallow changes.
    if (obj.userData?.isStep) {
      const stepCount = Math.max(0, (params.stepCount | 0));
      if (stepCount <= 0) return;

      const idx = obj.userData.stepIndex;
      if (idx == null) return;

      const stepDepth = Math.max(0.01, params.stepDepth ?? 0.2);

      // Default step height is stepDepth; last step auto-fills to shallow floor.
      let h = stepDepth;

      if (idx === stepCount - 1) {
        const used = stepDepth * (stepCount - 1);
        h = params.shallow - STEP_TOP_OFFSET - used;
        if (h < 0.05) h = 0.05;

        // Top of last step should match the top plane of the step stack:
        // topZ = -(STEP_TOP_OFFSET + stepDepth * idx)
        const topZ = -(STEP_TOP_OFFSET + stepDepth * idx);
        const baseH = obj.userData.baseHeight || h;
        obj.scale.z = h / baseH;
        obj.position.z = topZ - h / 2;
      } else {
        // Non-last steps keep standard center position; update if stepDepth changes.
        const topZ = -(STEP_TOP_OFFSET + stepDepth * idx);
        const baseH = obj.userData.baseHeight || h;
        obj.scale.z = h / baseH;
        obj.position.z = topZ - h / 2;
      }
    }
  });

  // Persist merged params for next patch
  group.userData.params = params;

  return true;
}
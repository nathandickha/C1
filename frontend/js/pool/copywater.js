import * as THREE from 'https://esm.sh/three@0.158.0';
import { WaterSim } from './waterSim.js';

/**
 * Compatible with V7:
 * - createPoolWater(length, width, geometryOverride)
 * - or createPoolWater(geometryOverride) (fallback)
 */
export function createPoolWater(a, b, geometryOverride = null) {
  const SIM_SIZE = 512;

  // --- Resolve geometry ---
  let geom = null;

  // Case 1: createPoolWater(geometry)
  if (a && typeof a === 'object' && a.isBufferGeometry) {
    geom = a;
  }
  // Case 2: createPoolWater(length, width, geometryOverride?)
  else {
    const length = typeof a === 'number' ? a : 10;
    const width  = typeof b === 'number' ? b : 6;

    if (geometryOverride && geometryOverride.isBufferGeometry) {
      geom = geometryOverride;
    } else {
      // Needs tessellation for vertex displacement to be visible
      geom = new THREE.PlaneGeometry(length, width, 256, 256);
    }
  }

  // If still null, fail loudly but safely
  if (!geom || !geom.isBufferGeometry) {
    console.error('createPoolWater: invalid geometry args:', a, b, geometryOverride);
    geom = new THREE.PlaneGeometry(10, 6, 1, 1);
  }

  // Dummy 1x1 texture to avoid null sampler compile issues
  const dummy = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
  dummy.needsUpdate = true;

  // --- Real normal maps
  const _loader = new THREE.TextureLoader();
  const normal1 = _loader.load('./textures/water/Water_1_M_Normal.png');
  const normal2 = _loader.load('./textures/water/Water_2_M_Normal.png');
  for (const t of [normal1, normal2]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.NoColorSpace; // normal maps are data
    t.anisotropy = 8;
  }

  const uniforms = {
    heightTex: { value: dummy },
    interiorTex: { value: dummy },
    depthTex: { value: dummy },
    depthTexValid: { value: 0.0 }, // 0 = no real depth prepass texture

    resolution: { value: new THREE.Vector2(1, 1) },

    poolMin: { value: new THREE.Vector2(0, 0) },
    poolSize: { value: new THREE.Vector2(1, 1) },


  // Spa void cutout (world-space)
    spaCenter: { value: new THREE.Vector2(0, 0) },
    spaSize:   { value: new THREE.Vector2(0, 0) }, // set to 0 to disable
    // Time (for micro ripples + subtle animation)
    uTime: { value: 0.0 },

    // Surface shape (calmer)
    heightScale: { value: 0.07 },
    dispScale:   { value: 0.03 },
    normalScale: { value: 0.22 }, // calmer sim gradient

    refractStrength: { value: 0.024 },
    chroma: { value: 0.8 },

    // Micro ripples (reduced to avoid blotchiness)
    microStrength: { value: 0.08 },
    microScale:    { value: 12.0 },
    microSpeed:    { value: 0.70 },

    // Real normal maps (reduced)
    normalMap1: { value: normal1 },
    normalMap2: { value: normal2 },
    normalMapStrength: { value: 0.55 },
    normalTiling1: { value: 0.21 },
    normalTiling2: { value: 0.13 },
    normalSpeed1: { value: 0.015 },
    normalSpeed2: { value: -0.011 },

    // Depth/thickness
    cameraNear: { value: 0.1 },
    cameraFar: { value: 200.0 },
    thicknessStrength: { value: 1.0 },

    // Fresnel/spec (softer highlights, reflection mostly at grazing angles)
    fresnelPower: { value: 4.2 },
    reflectStrength: { value: 0.85 },

    specPower: { value: 75.0 },
    specStrength: { value: 0.70 },
    lightDir: { value: new THREE.Vector3(0.3, 0.8, 0.5).normalize() },

    // Beer–Lambert absorption (aqua shallow)
    absorption: { value: new THREE.Color(1.15, 0.52, 0.20) },
    absorptionStrength: { value: 0.18 },

    // Shallow/deep look controls
    shallowColor: { value: new THREE.Color(0.55, 0.92, 0.96) }, // brighter aqua
    deepColor:    { value: new THREE.Color(0.06, 0.22, 0.35) }, // dark

    alphaShallow: { value: 0.18 },
    alphaDeep:    { value: 0.88 },

    // UV fallback depth (meters-ish thickness)
    thicknessShallow: { value: 0.30 },
    thicknessDeep:    { value: 2.40 },

    // Flip which end is deep in UV fallback (0 = vSimUV.y deepwards, 1 = flipped)
    deepFlip: { value: 0.0 },
  };

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms,
    vertexShader: `
uniform sampler2D heightTex;
uniform vec2 poolMin;
uniform vec2 poolSize;
uniform float heightScale;
uniform float dispScale;

varying vec3 vWorld;
varying vec2 vSimUV;

void main(){
  vec4 w0 = modelMatrix * vec4(position, 1.0);

  // sim UV from world XY (water plane is XY; Z-up)
  vec2 simUV = (w0.xy - poolMin) / poolSize;
  simUV = clamp(simUV, 0.001, 0.999);
  vSimUV = simUV;

  float h = texture2D(heightTex, simUV).r;

  // sim baseline is 0.5
  float hh = clamp((h - 0.5) * 2.0, -1.0, 1.0);

  vec3 p = position;
  p.z += hh * heightScale * dispScale;

  vec4 w = modelMatrix * vec4(p, 1.0);
  vWorld = w.xyz;

  gl_Position = projectionMatrix * viewMatrix * w;
}
    `,
    fragmentShader: `
precision highp float;

uniform sampler2D heightTex;
uniform sampler2D interiorTex;
uniform sampler2D depthTex;

uniform float depthTexValid;

uniform sampler2D normalMap1;
uniform sampler2D normalMap2;
uniform float normalMapStrength;
uniform float normalTiling1;
uniform float normalTiling2;
uniform float normalSpeed1;
uniform float normalSpeed2;

uniform vec2 resolution;
uniform float uTime;

uniform float normalScale;
uniform float refractStrength;
uniform float chroma;

uniform float microStrength;
uniform float microScale;
uniform float microSpeed;

uniform float fresnelPower;
uniform float reflectStrength;

uniform vec3 lightDir;
uniform float specPower;
uniform float specStrength;

uniform vec3 absorption;
uniform float absorptionStrength;

uniform float cameraNear;
uniform float cameraFar;
uniform float thicknessStrength;

uniform vec3 shallowColor;
uniform vec3 deepColor;

uniform float alphaShallow;
uniform float alphaDeep;

uniform float thicknessShallow;
uniform float thicknessDeep;

uniform float deepFlip;

uniform vec2 spaCenter;
uniform vec2 spaSize;

varying vec3 vWorld;
varying vec2 vSimUV;

float perspectiveDepthToViewZ(const in float invClipZ, const in float near, const in float far) {
  return (near * far) / ((far - near) * invClipZ - far);
}

// Small procedural height field for micro ripples
float microH(vec2 p, float t){
  float a = sin(p.x + t*microSpeed) * cos(p.y*1.17 - t*microSpeed*1.2);
  float b = sin(p.x*1.9 - t*microSpeed*0.8) * cos(p.y*2.3 + t*microSpeed*1.1);
  float c = sin(p.x*3.1 + t*microSpeed*0.6) * cos(p.y*2.7 - t*microSpeed*0.7);
  return (a + 0.5*b + 0.25*c);
}

vec2 flowWarp(vec2 p, float t){
  float w1 = sin(p.x*0.9 + t*0.8) * cos(p.y*1.1 - t*0.6);
  float w2 = sin(p.x*1.7 - t*0.35) * cos(p.y*1.3 + t*0.55);
  return vec2(w1 + 0.6*w2, w2 - 0.4*w1);
}

void main(){
  // Spa void cutout (world-space X/Y). Set spaSize to 0 to disable.
  if (spaSize.x > 0.0 && spaSize.y > 0.0) {
    vec2 d = abs(vWorld.xy - spaCenter);
    if (d.x < spaSize.x * 0.5 && d.y < spaSize.y * 0.5) discard;
  }
  vec2 simUV = clamp(vSimUV, 0.001, 0.999);

  // gradient for normal from sim
  vec2 texel = vec2(1.0/512.0, 1.0/512.0);

  float hL = texture2D(heightTex, simUV - vec2(texel.x, 0.0)).r;
  float hR = texture2D(heightTex, simUV + vec2(texel.x, 0.0)).r;
  float hD = texture2D(heightTex, simUV - vec2(0.0, texel.y)).r;
  float hU = texture2D(heightTex, simUV + vec2(0.0, texel.y)).r;

  float dx = (hR - hL) * normalScale;
  float dy = (hU - hD) * normalScale;

  // micro ripples (rotated + jittered to avoid grid moire)
  float ang = 0.63;
  mat2 rot = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
  vec2 p = rot * (vWorld.xy * microScale + vec2(13.7, 9.2));

  float eps = 0.015;
  float mC = microH(p, uTime);
  float mX = microH(p + vec2(eps, 0.0), uTime);
  float mY = microH(p + vec2(0.0, eps), uTime);

  float mdx = (mX - mC) / eps;
  float mdy = (mY - mC) / eps;

  dx += mdx * microStrength * 0.15;
  dy += mdy * microStrength * 0.15;

  // normal maps
  float hC = texture2D(heightTex, simUV).r;
  vec2 wuv = vWorld.xy;

  vec2 warp = (hC - 0.5) * vec2(0.08, 0.06);
  vec2 uv1 = wuv * normalTiling1 + warp
           + vec2(uTime * normalSpeed1, uTime * normalSpeed1 * 0.65)
           + flowWarp(vWorld.xy*0.35, uTime)*0.045;

  vec2 uv2 = wuv * normalTiling2 - warp
           + vec2(uTime * normalSpeed2, uTime * normalSpeed2 * 0.92)
           + flowWarp(vWorld.xy*0.55 + 7.3, uTime)*0.03;

  vec3 n1 = texture2D(normalMap1, uv1).xyz * 2.0 - 1.0;
  vec3 n2 = texture2D(normalMap2, uv2).xyz * 2.0 - 1.0;
  vec2 nm = normalize(n1.xy + n2.xy);

  dx += nm.x * normalMapStrength * 0.35;
  dy += nm.y * normalMapStrength * 0.35;

  // View-angle fade of high-frequency normal detail (reduces shimmer / blotches)
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 N = normalize(vec3(-dx, -dy, 1.0));

  float viewFade = clamp(dot(N, V), 0.0, 1.0);
  float fadeAmt = mix(0.35, 1.0, viewFade);

  dx *= fadeAmt;
  dy *= fadeAmt;

  // Recompute N after modifying dx/dy
  N = normalize(vec3(-dx, -dy, 1.0));

  vec2 screenUV = gl_FragCoord.xy / resolution;

  // refraction (RGB split)
  vec2 off = N.xy * refractStrength;
  vec2 offR = off * (1.0 + 0.015 * chroma);
  vec2 offG = off;
  vec2 offB = off * (1.0 - 0.015 * chroma);

  vec3 col;
  col.r = texture2D(interiorTex, screenUV + offR).r;
  col.g = texture2D(interiorTex, screenUV + offG).g;
  col.b = texture2D(interiorTex, screenUV + offB).b;

  // Fresnel reflection: mostly at grazing angles (less blotchy)
  float NdV = max(dot(N, V), 0.0);
  float fresnel = pow(1.0 - NdV, fresnelPower);
  float reflectAmt = fresnel * reflectStrength * smoothstep(0.15, 0.65, 1.0 - NdV);
  col = mix(col, vec3(1.0), reflectAmt);

  // Specular (softer)
  vec3 L = normalize(lightDir);
  vec3 R = reflect(-L, N);
  float spec = pow(max(dot(R, V), 0.0), specPower);
  col += spec * specStrength;

  // ----- depth/thickness factor -----
  float tUV = clamp(vSimUV.y, 0.0, 1.0);
  if (deepFlip > 0.5) tUV = 1.0 - tUV;

  float thicknessUV = mix(thicknessShallow, thicknessDeep, tUV);

  float thickness = thicknessUV;
  float t = tUV;

  if (depthTexValid > 0.5) {
    float sceneDepth = texture2D(depthTex, screenUV).x;
    float waterDepth = gl_FragCoord.z;

    float sceneViewZ = perspectiveDepthToViewZ(sceneDepth, cameraNear, cameraFar);
    float waterViewZ = perspectiveDepthToViewZ(waterDepth, cameraNear, cameraFar);

    thickness = max(0.0, abs(sceneViewZ - waterViewZ));
    t = clamp(thickness * 0.45, 0.0, 1.0);
  }

  // Beer–Lambert transmission
  vec3 sigma = absorption * absorptionStrength * thicknessStrength;
  vec3 trans = exp(-sigma * thickness);

  // Shallow/deep colour blend
  vec3 waterColor = mix(shallowColor, deepColor, t);

  // Refracted scene through water + in-scatter
  col = col * trans + waterColor * (1.0 - trans);

  // Slightly flatten chroma so caustics/floor read cleaner (reduces blotchy look)
  float luma = dot(col, vec3(0.3333333));
  col = mix(col, vec3(luma), 0.08);

  // Alpha: shallow clearer, deep denser
  float alpha = mix(alphaShallow, alphaDeep, t);

  gl_FragColor = vec4(col, alpha);
}
    `,
  });

  const mesh = new THREE.Mesh(geom, mat);
  mesh.frustumCulled = false;

  // --- Simulation instance ---
  let sim = null;

  mesh.userData.setInteriorTex = (tex) => {
    uniforms.interiorTex.value = tex || dummy;
  };

  mesh.userData.setDepthTex = (tex) => {
    uniforms.depthTex.value = tex || dummy;
    uniforms.depthTexValid.value = tex ? 1.0 : 0.0;
  };

  mesh.userData.setWaterTuning = (t = {}) => {
    if (typeof t.heightScale === 'number') uniforms.heightScale.value = t.heightScale;
    if (typeof t.normalScale === 'number') uniforms.normalScale.value = t.normalScale;
    if (typeof t.refractStrength === 'number') uniforms.refractStrength.value = t.refractStrength;
    if (typeof t.dispScale === 'number') uniforms.dispScale.value = t.dispScale;
    if (typeof t.chroma === 'number') uniforms.chroma.value = t.chroma;
    if (typeof t.thicknessStrength === 'number') uniforms.thicknessStrength.value = t.thicknessStrength;

    if (typeof t.microStrength === 'number') uniforms.microStrength.value = t.microStrength;
    if (typeof t.microScale === 'number') uniforms.microScale.value = t.microScale;
    if (typeof t.microSpeed === 'number') uniforms.microSpeed.value = t.microSpeed;

    if (typeof t.fresnelPower === 'number') uniforms.fresnelPower.value = t.fresnelPower;
    if (typeof t.reflectStrength === 'number') uniforms.reflectStrength.value = t.reflectStrength;

    if (typeof t.specPower === 'number') uniforms.specPower.value = t.specPower;
    if (typeof t.specStrength === 'number') uniforms.specStrength.value = t.specStrength;

    if (t.absorption && (t.absorption.isColor || Array.isArray(t.absorption))) {
      if (t.absorption.isColor) uniforms.absorption.value.copy(t.absorption);
      else uniforms.absorption.value.setRGB(t.absorption[0], t.absorption[1], t.absorption[2]);
    }
    if (typeof t.absorptionStrength === 'number') uniforms.absorptionStrength.value = t.absorptionStrength;

    if (t.shallowColor && t.shallowColor.isColor) uniforms.shallowColor.value.copy(t.shallowColor);
    if (t.deepColor && t.deepColor.isColor) uniforms.deepColor.value.copy(t.deepColor);

    if (typeof t.alphaShallow === 'number') uniforms.alphaShallow.value = t.alphaShallow;
    if (typeof t.alphaDeep === 'number') uniforms.alphaDeep.value = t.alphaDeep;

    if (typeof t.thicknessShallow === 'number') uniforms.thicknessShallow.value = t.thicknessShallow;
    if (typeof t.thicknessDeep === 'number') uniforms.thicknessDeep.value = t.thicknessDeep;

    if (typeof t.deepFlip === 'number') uniforms.deepFlip.value = t.deepFlip;

    if (sim && (typeof t.viscosity === 'number' || typeof t.waveSpeed === 'number' || typeof t.drive === 'number')) {
      sim.setParams({ viscosity: t.viscosity, waveSpeed: t.waveSpeed, drive: t.drive });
    }
  };

  mesh.userData.triggerRipple = (xWorld, yWorld) => {
    if (!sim) return;

    const min = uniforms.poolMin.value;
    const size = uniforms.poolSize.value;

    const u = (xWorld - min.x) / size.x;
    const v = (yWorld - min.y) / size.y;

    sim.splash(new THREE.Vector2(
      THREE.MathUtils.clamp(u, 0.001, 0.999),
      THREE.MathUtils.clamp(v, 0.001, 0.999)
    ), 0.65, 0.03);
  };

  // animate(delta, clock, camera, dirLight, renderer)
  mesh.userData.animate = (delta, clock, camera, dirLight, renderer) => {
    const r = renderer && renderer.isWebGLRenderer ? renderer :
              (clock && clock.isWebGLRenderer ? clock : null);

    if (!r) return;

    if (!sim) {
      sim = new WaterSim(r, SIM_SIZE);
      // Default motion (subtle)
      sim.setParams({ viscosity: 0.992, waveSpeed: 0.45, drive: 0.003 });
    }

    const dt = (typeof delta === 'number' ? delta : 1 / 60);
    uniforms.uTime.value += dt;

    sim.update(dt);
    uniforms.heightTex.value = sim.texture;

    uniforms.resolution.value.set(r.domElement.width, r.domElement.height);

    if (dirLight && dirLight.position) {
      uniforms.lightDir.value.copy(dirLight.position).normalize();
    }

    const box = new THREE.Box3().setFromObject(mesh);
    uniforms.poolMin.value.set(box.min.x, box.min.y);
    uniforms.poolSize.value.set(
      Math.max(0.001, box.max.x - box.min.x),
      Math.max(0.001, box.max.y - box.min.y)
    );
  };

  return mesh;
}

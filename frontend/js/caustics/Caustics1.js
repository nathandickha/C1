// frontend/js/caustics/Caustics.js
import * as THREE from "https://esm.sh/three@0.158.0";
console.log("✅ Caustics.js loaded");
/**
 * CausticsSystem
 * - Procedural caustics "light" injected into MeshStandard/Physical materials via onBeforeCompile
 * - API matches what PoolApp.js and PBRManager expect in your V7 project:
 *    - addToMaterial(mat)
 *    - attachToGroup(group)
 *    - update(dt, lightPosOrNull)
 *    - reset()
 *    - setEnabled(bool), setIntensity(x), setSizeMultiplier(x), setSpeedMultiplier(x)
 */
export class CausticsSystem {
  constructor() {
    console.log("✅ CausticsSystem constructed");
    this.enabled = true;

    // Animation state
    this.time = 0;

    // Artistic controls
    this.baseStrength = 1.05;  // boosted default intensity
    this.baseScale = 1.0;     // boosted default scale (denser webbing)
    this.baseSpeed = 0.8;     // slightly faster default

    this.intensityMul = 1.0;
    this.sizeMul = 1.0;
    this.speedMul = 1.0;

    // Sun direction (world space). If PoolApp passes a directional light position,
    // we derive dir = normalize(lightPos - origin). Otherwise keep default.
    this.sunDir = new THREE.Vector3(0.3, 0.8, 0.5).normalize();

    // Track materials we’ve patched so we can update uniforms every frame
    this._materials = new Set();

    // Optional: drive caustics from the water GPU heightmap (WaterSim)
    this.waterHeightTex = null;
    this.waterTexel = new THREE.Vector2(1.0/512.0, 1.0/512.0);

  }

  // ---------- Public controls (called by UI / app) ----------
  setEnabled(v) {
    this.enabled = !!v;
    // Keep uniforms in sync immediately
    this._materials.forEach((m) => this._syncUniforms(m));
  }

  setIntensity(v) {
    this.intensityMul = (v == null) ? 1.0 : Number(v);
    this._materials.forEach((m) => this._syncUniforms(m));
  }

  setSizeMultiplier(v) {
    this.sizeMul = (v == null) ? 1.0 : Number(v);
    this._materials.forEach((m) => this._syncUniforms(m));
  }

  setSpeedMultiplier(v) {
    this.speedMul = (v == null) ? 1.0 : Number(v);
    this._materials.forEach((m) => this._syncUniforms(m));
  }

  setSunDirection(v) {
    if (v) this.sunDir.copy(v).normalize();
    this._materials.forEach((m) => this._syncUniforms(m));
  }

  /**
   * Provide the WaterSim height texture (R=height, baseline ~0.5).
   * If tex is null, caustics fall back to procedural only.
   */
  setWaterHeightTexture(tex, simSize = 512) {
    this.waterHeightTex = tex || null;
    const s = (typeof simSize === 'number' && simSize > 0) ? simSize : 512;
    this.waterTexel.set(1.0 / s, 1.0 / s);
    this._materials.forEach((m) => this._syncUniforms(m));
  }

  reset() {
    this.time = 0;
    this._materials.forEach((m) => this._syncUniforms(m, true));
  }

  // ---------- API expected by PBRManager ----------
  addToMaterial(mat) {
    // Alias for applyToMaterial
    this.applyToMaterial(mat);
  }

  // ---------- API expected by PoolApp ----------
  attachToGroup(group) {
    if (!group) { console.warn('[Caustics] attachToGroup called with null group'); return; }
    let _meshCount = 0; let _matCount = 0;
    if (!group) return;
    group.traverse((obj) => {
      if (!obj || !obj.isMesh) return;
      _meshCount++;
      if (!obj || !obj.isMesh) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach((m) => { _matCount++; this.applyToMaterial(m); });
    });
    console.log(`✅ [Caustics] attached to ${_meshCount} meshes / ${_matCount} materials`);
  }

  update(dt, lightPosOrNull) {
    const delta = (dt == null) ? 0.016 : Number(dt);
    this.time += delta * (this.baseSpeed * this.speedMul);

    // If a directional light position is provided, derive direction.
    // (DirectionalLight in three uses position to indicate direction toward target.)
    if (lightPosOrNull && lightPosOrNull.isVector3) {
      const d = new THREE.Vector3().copy(lightPosOrNull).normalize();
      if (d.lengthSq() > 1e-8) this.sunDir.copy(d);
    }

    this._materials.forEach((m) => this._syncUniforms(m));
  }

  // ---------- Internal: patch standard/physical shader ----------
  applyToMaterial(mat) {
    // Debug: show first few materials that get skipped
    if (mat && !mat.isMeshStandardMaterial && !mat.isMeshPhysicalMaterial) {
      if (!this._warnedNonStandard) this._warnedNonStandard = 0;
      if (this._warnedNonStandard < 5) {
        console.warn('[Caustics] skipped non-Standard/Physical material:', mat.type);
        this._warnedNonStandard++;
      }
      return;
    }
    if (!mat) return;

    // Avoid patching same material multiple times
    if (mat.userData && mat.userData.__causticsPatched) {
      this._materials.add(mat);
      this._syncUniforms(mat);
      return;
    }
    mat.userData = mat.userData || {};
    mat.userData.__causticsPatched = true;

    mat.onBeforeCompile = (shader) => {
      // Uniforms
      shader.uniforms.uCausticsEnabled  = { value: this.enabled ? 1.0 : 0.0 };
      shader.uniforms.uCausticsTime     = { value: this.time };
      shader.uniforms.uCausticsStrength = { value: this.baseStrength * this.intensityMul };
      shader.uniforms.uCausticsScale    = { value: this.baseScale * this.sizeMul };
      shader.uniforms.uSunDir           = { value: this.sunDir.clone() };

      

// Vertex: provide world position to fragment (GLSL1/GLSL3 safe)
shader.vertexShader = shader.vertexShader.replace(
  "#include <common>",
  "#include <common>\nvarying vec3 vCausticsWorldPos;\n"
);
shader.vertexShader = shader.vertexShader.replace(
  "#include <worldpos_vertex>",
  "#include <worldpos_vertex>\nvCausticsWorldPos = worldPosition.xyz;\n"
);
// Inject helpers
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <common>",
        `#include <common>
uniform float uCausticsEnabled;
uniform float uCausticsTime;
uniform float uCausticsStrength;
uniform float uCausticsScale;
uniform vec3  uSunDir;

uniform sampler2D uWaterHeightTex;
uniform float     uWaterHeightTexValid;
uniform vec2      uWaterTexel;

varying vec3 vCausticsWorldPos;

// --- small helpers ---
float hash21(vec2 p){
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
vec2 hash22(vec2 p){
  float n = hash21(p);
  return vec2(n, hash21(p + n + 19.19));
}
float noise2(vec2 p){
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  vec2 u = f*f*(3.0-2.0*f);
  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}

// Worley / cellular: returns (F1, F2) distances to nearest + 2nd nearest feature point
vec2 worley2(vec2 p){
  vec2 i = floor(p);
  vec2 f = fract(p);

  float F1 = 1e9;
  float F2 = 1e9;

  for (int y = -1; y <= 1; y++){
    for (int x = -1; x <= 1; x++){
      vec2 g = vec2(float(x), float(y));
      vec2 o = hash22(i + g);         // random point in cell
      vec2 r = g + o - f;             // vector from p to feature point
      float d = dot(r, r);            // squared distance
      if (d < F1){
        F2 = F1;
        F1 = d;
      } else if (d < F2){
        F2 = d;
      }
    }
  }
  return vec2(sqrt(F1), sqrt(F2));
}

// Caustics based on Voronoi cell borders (thin bright web like your reference image)
// Bright where distances to 1st and 2nd nearest are similar => border => (F2-F1) small.

float caustics(vec2 p){
  float t = uCausticsTime;

  // Scale controlled by your UI (Caustics Size)
  p *= uCausticsScale;

  // Slow rotation avoids "sliding texture" look
  float ang = t * 0.06;
  mat2 R = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
  p = R * p;

  // Domain warp (adds organic variation)
  vec2 w;
  w.x = noise2(p*0.35 + t*0.22);
  w.y = noise2(p*0.35 - t*0.19);
  p += (w - 0.5) * 0.75;

  // Gentle drift
  p += vec2(t*0.10, -t*0.075);

  // Worley borders
  vec2 F = worley2(p);
  float edge = F.y - F.x;

  // --- Variable width + soft edges (matches ref: bright lines, blurred edges) ---
  float n1 = noise2(p*0.22 + 7.1);
  float n2 = noise2(p*0.45 - 3.7);

  // width in "edge" units; smaller => thinner core
  float coreW = mix(0.020, 0.050, n1);
  // halo width; larger => blurrier edges / less polygonal
  float haloW = coreW + mix(0.060, 0.180, n2);

  // --- Breakup so cells don't close perfectly (ref has gaps) ---
  float b1 = noise2(p*0.85 + 11.3);
  float b2 = noise2(p*1.70 - 5.2);
  float breakup = smoothstep(0.18, 0.86, b1) * smoothstep(0.10, 0.96, b2);
  breakup = mix(breakup, pow(breakup, 1.8), 0.55);

  // Soft-only caustic: use halo, but also a thin "hot core" for sparkle points
  float halo = 1.0 - smoothstep(0.0, haloW, edge);
  float core = 1.0 - smoothstep(0.0, coreW, edge);

  float c = halo * 0.85 + core * 0.55;
  c *= breakup;

  // Contrast shaping: bright filaments but soft mids (closer to photo)
  c = clamp(c, 0.0, 1.0);
  c = pow(c, 2.0);

  // Hot spots at intersections (photo has bright star-ish nodes)
  float spark = noise2(p*2.6 + t*0.30);
  c += 0.18 * pow(core, 2.6) * smoothstep(0.70, 0.98, spark);

  return clamp(c, 0.0, 1.0);
}

// Heightmap-driven caustics (matches WaterSim-style look)
float heightCaustics(vec2 p){
  // Map world-space tri-planar coords into sim UV space.
  // Tweak these to match your pool scale / tile scale.
  vec2 uv = fract(p * 0.12 + vec2(uCausticsTime * 0.02, -uCausticsTime * 0.015));

  float h0  = texture2D(uWaterHeightTex, uv).r;
  float hx1 = texture2D(uWaterHeightTex, uv + vec2(uWaterTexel.x, 0.0)).r;
  float hx2 = texture2D(uWaterHeightTex, uv - vec2(uWaterTexel.x, 0.0)).r;
  float hy1 = texture2D(uWaterHeightTex, uv + vec2(0.0, uWaterTexel.y)).r;
  float hy2 = texture2D(uWaterHeightTex, uv - vec2(0.0, uWaterTexel.y)).r;

  // Curvature proxy (Laplacian) -> bright filaments where the surface bends.
  float lap = abs(hx1 + hx2 + hy1 + hy2 - 4.0 * h0);

  // Shape into caustic intensity. Higher gain => stronger filaments.
  float c = clamp(lap * 18.0, 0.0, 1.0);
  c = pow(c, 0.75);

  // Slight softening
  c = smoothstep(0.08, 0.95, c);
  return c;
}
`
      );

      // Apply as extra diffuse light
shader.fragmentShader = shader.fragmentShader.replace(
  "#include <output_fragment>",
  `#include <output_fragment>

if (uCausticsEnabled > 0.5) {
  vec3 wp = vCausticsWorldPos;

  // Tri-planar mapping (same as before)
  float worldToUv = 2.2;
  vec3 n = normalize(normal);
  vec3 an = abs(n) + 1e-4;
  an /= (an.x + an.y + an.z);

  vec2 px = wp.zy * worldToUv;
  vec2 py = wp.xz * worldToUv;
  vec2 pz = wp.xy * worldToUv;

  float cx = caustics(px);
  float cy = caustics(py);
  float cz = caustics(pz);

  float c = cx*an.x + cy*an.y + cz*an.z;

  // Stronger shaping so it reads clearly
  c = smoothstep(0.03, 0.92, c);

  // Optional: keep some directional bias, but don’t let it kill visibility
  float ndl = clamp(dot(normalize(normal), normalize(uSunDir)), 0.2, 1.0);

  float ca = c * uCausticsStrength * pow(ndl, 0.6);

  // “Projected light” look (Water.zip style): modulate final color
  // This makes dark/bright ripples show even if lighting is flat.
  vec3 tint = vec3(0.90, 0.97, 1.0);
  gl_FragColor.rgb *= (1.0 + tint * ca);
}
`
);

      // Keep handle for updates
      mat.userData._causticsShader = shader;
    };

    mat.needsUpdate = true;
    this._materials.add(mat);
  }

  _syncUniforms(mat, force = false) {
    const shader = mat?.userData?._causticsShader;
    if (!shader || !shader.uniforms) return;

    shader.uniforms.uCausticsEnabled.value  = this.enabled ? 1.0 : 0.0;
    shader.uniforms.uCausticsTime.value     = this.time;
    shader.uniforms.uCausticsStrength.value = this.baseStrength * this.intensityMul;
    shader.uniforms.uCausticsScale.value    = this.baseScale * this.sizeMul;
    shader.uniforms.uSunDir.value.copy(this.sunDir);
  }
}

import * as THREE from 'https://esm.sh/three@0.158.0';
import { GPUComputationRenderer } from 'https://esm.sh/three@0.158.0/examples/jsm/misc/GPUComputationRenderer.js';

export class WaterSim {
  constructor(renderer, size = (window.__POOL_PERF?.waterSimSize ?? 256)) {
    this.renderer = renderer;
    this.size = size;

    this.gpu = new GPUComputationRenderer(size, size, renderer);

    // Float type for GPGPU textures
    const type = renderer.capabilities.isWebGL2 ? THREE.HalfFloatType : THREE.FloatType;
    this.gpu.setDataType(type);

    // state texture: R = height, G = velocity
    const initTex = this.gpu.createTexture();
    this._clear(initTex);

    this.varState = this.gpu.addVariable('texState', this._frag(), initTex);
    this.gpu.setVariableDependencies(this.varState, [this.varState]);

    const u = this.varState.material.uniforms;
    u.uDt = { value: 1 / 60 };
    u.uTime = { value: 0 };
    u.uViscosity = { value: 0.990 };   // closer to 1 = longer lasting ripples
    u.uWaveSpeed = { value: 0.45 };    // smaller = slower propagation
    u.uDrive = { value: 0.003 };       // ambient sine amplitude

    // splash/impulse (one-shot)
    u.uSplashPos = { value: new THREE.Vector2(-10, -10) };
    u.uSplashRadius = { value: 0.03 };
    u.uSplashStrength = { value: 0.0 };

    const err = this.gpu.init();
    if (err) console.error('WaterSim init error:', err);
  }

  // baseline at 0.5 because water shader expects (h - 0.5)
  _clear(tex) {
    const d = tex.image.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i + 0] = 0.5; // height baseline
      d[i + 1] = 0.0; // velocity
      d[i + 2] = 0.0;
      d[i + 3] = 1.0;
    }
  }

  update(dt) {
    const u = this.varState.material.uniforms;

    const clamped = Math.max(0.0, Math.min(dt || 0, 1 / 20));
    u.uDt.value = clamped > 0 ? clamped : 1 / 60;
    u.uTime.value += u.uDt.value;

    this.gpu.compute();

    // consume splash (one frame)
    if (u.uSplashStrength.value !== 0.0) {
      u.uSplashStrength.value = 0.0;
      u.uSplashPos.value.set(-10, -10);
    }
  }

  get texture() {
    return this.gpu.getCurrentRenderTarget(this.varState).texture;
  }

  /**
   * uv in [0..1] sim space.
   */
  splash(uv, strength = 0.6, radius = 0.03) {
    const u = this.varState.material.uniforms;
    u.uSplashPos.value.copy(uv);
    u.uSplashStrength.value = strength;
    u.uSplashRadius.value = radius;
  }

  setParams({ viscosity, waveSpeed, drive } = {}) {
    const u = this.varState.material.uniforms;
    if (typeof viscosity === 'number') u.uViscosity.value = viscosity;
    if (typeof waveSpeed === 'number') u.uWaveSpeed.value = waveSpeed;
    if (typeof drive === 'number') u.uDrive.value = drive;
  }

  _frag() {
    return `
      uniform float uDt;
      uniform float uTime;
      uniform float uViscosity;
      uniform float uWaveSpeed;
      uniform float uDrive;

      uniform vec2  uSplashPos;
      uniform float uSplashRadius;
      uniform float uSplashStrength;

      void main() {
        vec2 uv = gl_FragCoord.xy / resolution.xy;

        vec4 c = texture2D(texState, uv);
        float h = c.r;  // height (0..1, baseline ~0.5)
        float v = c.g;  // velocity

        // Laplacian (4-neighbor)
        float hx1 = texture2D(texState, uv + vec2(1.0/resolution.x, 0.0)).r;
        float hx2 = texture2D(texState, uv - vec2(1.0/resolution.x, 0.0)).r;
        float hy1 = texture2D(texState, uv + vec2(0.0, 1.0/resolution.y)).r;
        float hy2 = texture2D(texState, uv - vec2(0.0, 1.0/resolution.y)).r;

        float lap = (hx1 + hx2 + hy1 + hy2 - 4.0*h);

        // shallow-water-ish update
        v += lap * uWaveSpeed;
        v *= uViscosity;
        h += v * uDt;

        // ambient “alive” motion (simulation-driven sine)
        h += sin(uTime * 0.9 + uv.x * 8.0 + uv.y * 6.0) * uDrive;

        // splash impulse
        if (uSplashStrength != 0.0) {
          float d = distance(uv, uSplashPos);
          float imp = exp(-(d*d) / max(1e-6, uSplashRadius*uSplashRadius));
          h += imp * uSplashStrength;
        }

        gl_FragColor = vec4(h, v, 0.0, 1.0);
      }
    `;
  }
}

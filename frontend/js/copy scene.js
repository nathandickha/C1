// frontend/js/scene.js
// Safe override: no world-axis flips; HDRI aligned via sky-dome; ground void preserved
import * as THREE from "https://esm.sh/three@0.158.0";
import { OrbitControls } from "https://esm.sh/three@0.158.0/examples/jsm/controls/OrbitControls.js";
import { RGBELoader } from "https://esm.sh/three@0.158.0/examples/jsm/loaders/RGBELoader.js";
import { GrassInstanced } from "./grass/GrassInstanced.js";

let dirLight;

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

  dirLight.shadow.mapSize.set(2048, 2048);
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
  // Ground material: PBR grass (albedo + normal + roughness + height as BUMP)
  //
  // Your textures folder contains .jpg files (per your tree).
  // -------------------------
  const GRASS_ALBEDO = "./textures/grass.png";
  const GRASS_NORMAL = "./textures/grass_normal.png";
  const GRASS_ROUGH  = "./textures/grass_rough.png";
  const GRASS_HEIGHT = "./textures/grass_height.png";

  const texLoader = new THREE.TextureLoader();

  const grassColor = texLoader.load(GRASS_ALBEDO);
  grassColor.colorSpace = THREE.SRGBColorSpace;
  grassColor.wrapS = grassColor.wrapT = THREE.RepeatWrapping;

  const grassNormal = texLoader.load(GRASS_NORMAL);
  grassNormal.wrapS = grassNormal.wrapT = THREE.RepeatWrapping;

  const grassRough = texLoader.load(GRASS_ROUGH);
  grassRough.wrapS = grassRough.wrapT = THREE.RepeatWrapping;

  const grassHeight = texLoader.load(GRASS_HEIGHT);
  grassHeight.wrapS = grassHeight.wrapT = THREE.RepeatWrapping;

  // Tile density:
  // - Larger numbers = smaller repeated pattern = less obvious tiling
  // - 14–24 is a good range for a "lawn" feel on a large ground plane
  const grassRepeat = 1;
  grassColor.repeat.set(grassRepeat, grassRepeat);
  grassNormal.repeat.set(grassRepeat, grassRepeat);
  grassRough.repeat.set(grassRepeat, grassRepeat);
  grassHeight.repeat.set(grassRepeat, grassRepeat);

  // Improve grazing-angle sharpness
  const maxAniso = renderer.capabilities.getMaxAnisotropy?.() || 1;
  grassColor.anisotropy = maxAniso;
  grassNormal.anisotropy = maxAniso;
  grassRough.anisotropy = maxAniso;
  grassHeight.anisotropy = maxAniso;

  const groundMat = new THREE.MeshStandardMaterial({
    map: grassColor,
    normalMap: grassNormal,
    roughnessMap: grassRough,
    bumpMap: grassHeight,
    bumpScale: 0.06,   // keep subtle; high values brighten and look "noisy"
    roughness: 0.95,
    metalness: 0.0
  });

  // Perceptual match: PBR response often looks lighter than the texture.
  groundMat.color.setScalar(0.85);

  // Soften microfacet light catch
  groundMat.normalScale = new THREE.Vector2(0.55, 0.55);

  // Reduce HDRI reflections contribution on grass
  groundMat.envMapIntensity = 0.7;

  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.position.set(0, 0, 0);
  ground.receiveShadow = true;
  scene.add(ground);
  scene.userData.ground = ground;

  // -------------------------
  // Real grass overlay (instanced cards) - high realism near pool
  // -------------------------
  const grassSystem = new GrassInstanced(renderer, {
    radius: 50,
    count: 3000000,
    bladeHeight: 0.05,
    bladeWidth: 0.1,
    fadeNear: 7,
    fadeFar: 80
  });
  grassSystem.addTo(scene);
  scene.userData.grassSystem = grassSystem;

  // -------------------------
  // HDRI: keep lighting via PMREM, but show background via a SKY-DOME.
  // -------------------------
  const rgbeLoader = new RGBELoader();
  rgbeLoader.load(
    "./textures/hdri/rustig_koppie_puresky_1k.hdr",
    (texture) => {
      texture.mapping = THREE.EquirectangularReflectionMapping;

      // Lighting/reflections
      const pmrem = new THREE.PMREMGenerator(renderer);
      pmrem.compileEquirectangularShader();
      const envMap = pmrem.fromEquirectangular(texture).texture;
      pmrem.dispose();
      scene.environment = envMap;

      // Visible background: sky-dome with the ORIGINAL equirect texture.
      // Align horizon to your ground plane (Z-up) + rotate LEFT 90° as requested.
      const skyGeo = new THREE.SphereGeometry(500, 48, 32);
      const skyMat = new THREE.MeshBasicMaterial({ map: texture, side: THREE.BackSide });
      const skyDome = new THREE.Mesh(skyGeo, skyMat);
      skyDome.frustumCulled = false;

      const PITCH = -Math.PI / 2;  // fixes "horizon 90° out" relative to ground plane
      const YAW   = -Math.PI / 2;  // rotate left 90°
      skyDome.rotation.set(PITCH, 0, 0);
      skyDome.rotateOnWorldAxis(new THREE.Vector3(0, 0, 1), YAW);

      // Keep it centered on the camera automatically (no render-loop edits needed)
      skyDome.onBeforeRender = (_r, _s, cam) => {
        skyDome.position.copy(cam.position);
      };

      // Replace any previous background with the sky dome
      if (scene.userData.skyDome) {
        scene.remove(scene.userData.skyDome);
        scene.userData.skyDome.geometry.dispose();
        scene.userData.skyDome.material.dispose();
      }
      scene.add(skyDome);
      scene.userData.skyDome = skyDome;

      // Ensure the renderer still clears; background is provided by geometry
      scene.background = null;

      scene.userData.hdriEnvMap = envMap;
    },
    undefined,
    (err) => console.warn("HDRI load error:", err)
  );

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
export function updateGroundVoid(ground, poolGroup) {
  if (!poolGroup?.userData?.outerPts) return;

  const outerPts = poolGroup.userData.outerPts;

  // Big outer rectangle (ground boundary)
  const groundShape = new THREE.Shape([
    new THREE.Vector2(-100, -100),
    new THREE.Vector2(100, -100),
    new THREE.Vector2(100, 100),
    new THREE.Vector2(-100, 100)
  ]);

  // Pool footprint hole
  const hole = new THREE.Path(outerPts);
  groundShape.holes = [hole];

  const newGeo = new THREE.ShapeGeometry(groundShape);
  ground.geometry.dispose();
  ground.geometry = newGeo;

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
// --------------------------------------------------------
export function updatePoolWaterVoid(poolGroup, spaGroup) {
  if (!poolGroup?.userData?.waterMesh) return;

  const poolWater = poolGroup.userData.waterMesh;
  const mat = poolWater.material;
  const uniforms = mat?.uniforms;
  if (!uniforms?.spaCenter || !uniforms?.spaSize) return;

  // Clear void if no spa provided
  if (!spaGroup) {
    uniforms.spaSize.value.set(0, 0, 0);
    return;
  }

  // World-space bounds (shader uses vWorld.xy)
  const spaBoxWorld = new THREE.Box3().setFromObject(spaGroup);
  const spaCenterWorld = spaBoxWorld.getCenter(new THREE.Vector3());
  const spaSizeWorld = spaBoxWorld.getSize(new THREE.Vector3());

  // Small padding so the cutout doesn't clip the spa walls
  const pad = 0.05;

  uniforms.spaCenter.value.copy(spaCenterWorld);
  uniforms.spaSize.value.set(spaSizeWorld.x + pad, spaSizeWorld.y + pad, 0);
}

// --------------------------------------------------------
// Rebuild grass overlay after pool rebuild
// --------------------------------------------------------
export function updateGrassForPool(scene, poolGroup) {
  const gs = scene?.userData?.grassSystem;
  if (!gs || !poolGroup) return;

  // Use pool footprint to avoid spawning inside pool void
  gs.setPoolPolygon(poolGroup.userData?.outerPts || null);

  // Center around pool bounds
  const box = new THREE.Box3().setFromObject(poolGroup);
  const center = box.getCenter(new THREE.Vector3());
  gs.setCenter(center);

  gs.ensureBuilt();
}

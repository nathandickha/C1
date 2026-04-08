// js/pbr/copingMaterial.js
import * as THREE from "https://esm.sh/three@0.158.0";

let cachedMaterial = null;

export async function loadCopingMaterial(scene) {
  if (cachedMaterial) return cachedMaterial;

  const texLoader = new THREE.TextureLoader();

    /* -------------------------------------------------------
     ENVIRONMENT
     Environment is configured in scene.js (PMREM + background).
  ------------------------------------------------------- */


  /* -------------------------------------------------------
     LOAD PBR COPING TEXTURES
  ------------------------------------------------------- */
  const baseColor    = texLoader.load("textures/Coping/TilesTravertine001_COL_4K.jpg");
  const normalMap    = texLoader.load("textures/Coping/TilesTravertine001_NRM_4K.jpg");
  const aoMap        = texLoader.load("textures/Coping/TilesTravertine001_AO_4K.jpg");
  const roughnessMap = texLoader.load("textures/Coping/TilesTravertine001_GLOSS_4K.jpg");
  const heightMap    = texLoader.load("textures/Coping/TilesTravertine001_DISP_4K.jpg");

  // Proper wrapping for tiled surfaces
  [
    baseColor,
    normalMap,
    aoMap,
    roughnessMap,
    heightMap
  ].forEach((t) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(2, 2);
  });

  /* -------------------------------------------------------
     MATERIAL SETTINGS
  ------------------------------------------------------- */
  cachedMaterial = new THREE.MeshStandardMaterial({
    map: baseColor,
    normalMap,
    aoMap,
    roughnessMap,
    displacementMap: heightMap,

    displacementScale: 0.005,   // small relief
    roughness: 0.6,
    metalness: 0.0,

    envMapIntensity: 1.2,

    color: 0xffffff
  });

  cachedMaterial.userData.isCoping = true;

  return cachedMaterial;
}

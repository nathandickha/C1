// js/app/PoolApp.js
import * as THREE from "https://esm.sh/three@0.158.0";
import { TransformControls } from "https://esm.sh/three@0.158.0/examples/jsm/controls/TransformControls.js";

import {
  initScene,
  updateGroundVoid,
  updatePoolWaterVoid,
  updateGrassForPool
} from "../scene.js";

import { createPoolGroup, previewUpdateDepths } from "../pool/pool.js";
import { EditablePolygon } from "../pool/editing/polygon.js";

import {
  createSpa,
  spas,
  setSelectedSpa,
  setSpaTopOffset,
  getSpaTopOffsetConstraints,
  updateSpa,
  snapToPool
} from "../pool/spa.js";

import { PoolEditor } from "../pool/pool-editor.js";

import { setupSidePanels } from "../ui/UI.js";
import { PBRManager } from "../pbr/PBR.js";
import { CausticsSystem } from "../caustics/Caustics.js";
import { createRectanglePool } from "../pool/shapes/rectanglePool.js";
import { createOvalPool } from "../pool/shapes/ovalPool.js";
import { createKidneyPool } from "../pool/shapes/kidneyPool.js";
import { createLShapePool } from "../pool/shapes/lshapePool.js";

export class PoolApp {
    constructor() {
    this.poolParams = {
      length: 10,
      width: 5,
      shallow: 1.2,
      deep: 2.5,
      shape: "rectangular",
      shallowFlat: 2,
      deepFlat: 2,
      stepCount: 3,
      stepDepth: 0.2,

      notchLengthX: 0.4,
      notchWidthY: 0.45,

      kidneyLeftRadius: 2.0,
      kidneyRightRadius: 3.0,
      kidneyOffset: 1.0
    };

    this.tileSize = 0.3;

    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.ground = null;
    this.controls = null;
    this.clock = null;

    this.editablePolygon = null;
    this.poolGroup = null;

    this.clearSpaHoverHighlight();
    this.clearSpaSelectedHighlight();
    this.spa = null;
    this.transformControls = null;
    this.selectedSpa = null;
    this.hoveredSpa = null;
    this.hoverSpaHighlight = null;
    this.selectedSpaHighlight = null;

    this.poolEditor = null;
    this.pbrManager = null;
    this.caustics = null;

    // Step interaction state
    this.selectedStep = null;
    this.hoveredStep = null;
    this.hoverHighlightMesh = null;
    this.selectedHighlightMesh = null;

    // Wall interaction state
    this.selectedWall = null;
    this.hoveredWall = null;
    this.hoverWallHighlightMesh = null;
    this.selectedWallHighlightMesh = null;

    this.customizeMode = false;
    this.customizeWallSelections = [];
    this.customizeSelectionHighlightMeshes = [];
    this.customizePreview = null;
    this.customizePreviewLine = null;
    this.customizeEditEdgeIndex = null;
    this.customizeRadius = 1.0;
    this.customizeRadiusBounds = { min: 1.0, max: 4.0 };

    this.undoStack = [];
    this.redoStack = [];
    this.undoLimit = 50;
    this.wallRaiseBySourceEdge = {};
    this.__buildTag = "confirm-undo-patched";

    this.baseShapeType = this.poolParams.shape;
    this.isCustomShape = false;


    // -----------------------------
    // Live preview + debounced rebuild (performance)
    // -----------------------------
    this._live = {
      dragging: false,
      // throttle preview to ~20fps by default
      previewFps: 20,
      lastPreviewTs: 0,
      previewRaf: 0,
      lastInputTs: 0,
      previewStreamMs: 200,
      // debounce rebuild (ms)
      rebuildDebounceMs: 200,
      rebuildTimer: 0,
      // accurate live rebuilds for shapes whose topology changes during drag
      accuratePreviewFps: 12,
      lastAccuratePreviewTs: 0,
      accuratePreviewInFlight: false,
      accuratePreviewQueued: false,
      // dirty params since last preview/rebuild
      dirty: new Set(),
      // snapshot of params at time poolGroup was (last) rebuilt
      baseParams: null
    };
  }

  // -----------------------------
  // Caustics controls (called by UI)
  // -----------------------------
  setCausticsEnabled(enabled) {
    this.caustics?.setEnabled?.(enabled);
    // Re-attach (in case materials were rebuilt while disabled)
    if (enabled) this.caustics?.attachToGroup?.(this.poolGroup);
  }


  animateCameraTo(newPos, newTarget, duration = 0.8) {
    const cam = this.camera;
    const ctrl = this.controls;
    if (!cam || !ctrl || !newPos || !newTarget) return;

    const startPos = cam.position.clone();
    const startTarget = ctrl.target.clone();
    const startTime = performance.now();

    const animateCam = (now) => {
      const t = Math.min(1, (now - startTime) / (duration * 1000));
      const k = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

      cam.position.lerpVectors(startPos, newPos, k);
      ctrl.target.lerpVectors(startTarget, newTarget, k);
      ctrl.update();

      if (t < 1) requestAnimationFrame(animateCam);
    };

    requestAnimationFrame(animateCam);
  }

  focusCameraOnPoolShape() {
    if (!this.poolGroup || !this.camera || !this.controls) return;

    const bounds = new THREE.Box3().setFromObject(this.poolGroup);
    if (bounds.isEmpty()) return;

    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());

    const halfVFov = THREE.MathUtils.degToRad(this.camera.fov * 0.5);
    const halfHFov = Math.atan(Math.tan(halfVFov) * this.camera.aspect);

    const fitX = (size.x * 0.5) / Math.max(Math.tan(halfHFov), 0.01);
    const fitY = (size.y * 0.5) / Math.max(Math.tan(halfVFov), 0.01);
    const distance = Math.max(fitX, fitY) * 1.3 + Math.max(size.z, 1.5);
    const tinyYOffset = Math.max(size.y * 0.002, 0.01);

    const target = center.clone();
    const newPos = new THREE.Vector3(center.x, center.y - tinyYOffset, center.z + distance);

    this.animateCameraTo(newPos, target, 0.8);
  }


  focusCameraOnWall(wall) {
    if (!wall || !this.poolGroup || !this.camera || !this.controls) return;

    const wallBounds = new THREE.Box3().setFromObject(wall);
    const poolBounds = new THREE.Box3().setFromObject(this.poolGroup);
    if (wallBounds.isEmpty() || poolBounds.isEmpty()) return;

    const wallCenter = wallBounds.getCenter(new THREE.Vector3());
    const wallSize = wallBounds.getSize(new THREE.Vector3());
    const poolCenter = poolBounds.getCenter(new THREE.Vector3());

    const posAttr = wall.geometry?.attributes?.position;
    let tangent2 = null;
    if (posAttr && posAttr.count >= 2) {
      let meanX = 0;
      let meanY = 0;
      for (let i = 0; i < posAttr.count; i++) {
        const wp = new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(wall.matrixWorld);
        meanX += wp.x;
        meanY += wp.y;
      }
      meanX /= posAttr.count;
      meanY /= posAttr.count;

      let xx = 0;
      let xy = 0;
      let yy = 0;
      for (let i = 0; i < posAttr.count; i++) {
        const wp = new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(wall.matrixWorld);
        const dx = wp.x - meanX;
        const dy = wp.y - meanY;
        xx += dx * dx;
        xy += dx * dy;
        yy += dy * dy;
      }

      const trace = xx + yy;
      const det = xx * yy - xy * xy;
      const disc = Math.max(0, trace * trace * 0.25 - det);
      const lambda = trace * 0.5 + Math.sqrt(disc);
      tangent2 = Math.abs(xy) > 1e-8
        ? new THREE.Vector2(lambda - yy, xy)
        : (xx >= yy ? new THREE.Vector2(1, 0) : new THREE.Vector2(0, 1));

      if (tangent2.lengthSq() > 1e-8) tangent2.normalize();
      else tangent2 = null;
    }

    if (!tangent2) {
      const dx = wallSize.x;
      const dy = wallSize.y;
      tangent2 = dx >= dy ? new THREE.Vector2(1, 0) : new THREE.Vector2(0, 1);
    }

    let inward2 = new THREE.Vector2(-tangent2.y, tangent2.x);
    const toPoolCenter2 = new THREE.Vector2(poolCenter.x - wallCenter.x, poolCenter.y - wallCenter.y);
    if (toPoolCenter2.lengthSq() > 1e-8 && inward2.dot(toPoolCenter2) < 0) {
      inward2.multiplyScalar(-1);
    }
    if (inward2.lengthSq() < 1e-8) inward2.set(0, -1);
    inward2.normalize();

    const poolSize = poolBounds.getSize(new THREE.Vector3());

    // Estimate the visible wall span in plan from the tangent direction
    const wallSpan =
      Math.abs(tangent2.x) * wallSize.x +
      Math.abs(tangent2.y) * wallSize.y;

    // Camera-fit distance from FOV so the full wall is visible
    const halfVFov = THREE.MathUtils.degToRad(this.camera.fov * 0.5);
    const halfHFov = Math.atan(Math.tan(halfVFov) * this.camera.aspect);

    const fitByWidth = (wallSpan * 0.5) / Math.max(Math.tan(halfHFov), 0.01);
    const fitByHeight = (Math.max(wallSize.z, 1.2) * 0.5) / Math.max(Math.tan(halfVFov), 0.01);

    // Match the wider full-wall framing from the 2.8 reference, but keep a slightly raised viewpoint
    const standoff = Math.max(
      6.5,
      Math.min(Math.max(fitByWidth, fitByHeight) * 2.2, 14.0)
    );

    // Slightly higher camera with a gentle downward look
    const eyeHeight = Math.max(0.90, Math.min(1.45, wallSize.z * 0.38));
    const targetHeight = Math.max(
      wallBounds.min.z + wallSize.z * 0.20,
      Math.min(wallBounds.min.z + wallSize.z * 0.30, 0.70)
    );

    const target = new THREE.Vector3(wallCenter.x, wallCenter.y, targetHeight);
    const newPos = new THREE.Vector3(
      wallCenter.x + inward2.x * standoff,
      wallCenter.y + inward2.y * standoff,
      eyeHeight
    );

    this.animateCameraTo(newPos, target, 0.55);
  }

  setCausticsSizeMultiplier(mult) {
    this.caustics?.setSizeMultiplier?.(mult);
  }

  setCausticsSpeedMultiplier(mult) {
    this.caustics?.setSpeedMultiplier?.(mult);
  }

  setCausticsIntensity(intensity) {
    this.caustics?.setIntensity?.(intensity);
  }


  // --------------------------------------------------------------
  // INTERNAL: remove poolGroup safely without disposing PBR-managed textures
  // (dispose geometry only; PBRManager owns texture/material lifecycle)
  // --------------------------------------------------------------
  _removePoolGroupSafely(group) {
    if (!group) return;

    try {
      if (group.parent) group.parent.remove(group);
      else if (this.scene) this.scene.remove(group);
    } catch (_) {}

    // Dispose geometries only (avoid disposing materials/textures that may be re-used)
    group.traverse((o) => {
      if (!o || !o.isMesh) return;
      try { o.geometry?.dispose?.(); } catch (_) {}
    });
  }

  // --------------------------------------------------------------
  // INTERNAL: coalesce expensive PBR re-application so we do not race
  // against rapid polygon edits (prevents tiles disappearing after edits)
  // --------------------------------------------------------------
  _schedulePBRApply() {
    if (!this.pbrManager || !this.poolGroup) return;

    const token = (this._pbrApplyToken = (this._pbrApplyToken || 0) + 1);
    const targetGroup = this.poolGroup;

    requestAnimationFrame(async () => {
      if (token !== this._pbrApplyToken) return;
      if (!this.pbrManager || this.poolGroup !== targetGroup) return;

      this.pbrManager.setPoolGroup(this.poolGroup);
      this.pbrManager.updatePoolParamsRef(this.poolParams);

      try {
        await this.pbrManager.applyCurrentToGroup();
      
        // Ensure caustics are attached after PBR materials are created/updated
        this.caustics?.attachToGroup?.(this.poolGroup);
} catch (_) {}

      if (token !== this._pbrApplyToken) return;

      if (this.spa) {
        try {
          this.spa.userData.poolGroup = this.poolGroup || null;
          snapToPool(this.spa);
          updateSpa(this.spa);
          await this.pbrManager.applyTilesToSpa(this.spa);
      // Attach caustics to spa interior too
      try { this.caustics?.attachToGroup?.(this.spa); } catch (e) {}
          
        // Ensure caustics are attached to spa materials as well
        this.caustics?.attachToGroup?.(this.spa);
updatePoolWaterVoid(this.poolGroup, this.spa);
          updateGroundVoid(this.ground || this.scene?.userData?.ground, this.poolGroup, this.spa);
        } catch (_) {}
      }
    });
  }


  
  // --------------------------------------------------------------
  // UV / GROUT ALIGNMENT HELPERS
  //  - Keeps tile density fixed when meshes are scaled (steps/walls)
  //  - Snaps step grout across treads + risers
  //  - Snaps floor grout to a stable origin per-shape rebuild
  // --------------------------------------------------------------
  computeAndStoreUVOrigins() {
    if (!this.poolGroup) return;

    // Ensure matrices are up to date
    this.poolGroup.updateMatrixWorld?.(true);

    // Floor origin: prefer the tagged floor mesh, else use poolGroup bounds
    let floorOrigin = null;

    const floors = [];
    this.poolGroup.traverse((o) => o.userData?.isFloor && floors.push(o));

    const tmpBox = new THREE.Box3();

    if (floors.length) {
      tmpBox.setFromObject(floors[0]);
      floorOrigin = { x: tmpBox.min.x, y: tmpBox.min.y };
    } else {
      tmpBox.setFromObject(this.poolGroup);
      floorOrigin = { x: tmpBox.min.x, y: tmpBox.min.y };
    }

    this.poolGroup.userData.floorUVOrigin = floorOrigin;

    // Step origin: left-most edge across all step meshes (treads/risers)
    const steps = [];
    this.poolGroup.traverse((o) => o.userData?.isStep && steps.push(o));

    if (steps.length) {
      let minEdgeX = Infinity;

      steps.forEach((s) => {
        if (!s.geometry?.boundingBox) s.geometry?.computeBoundingBox?.();
        const bb = s.geometry?.boundingBox;
        if (!bb) return;

        const baseLen = (bb.max.x - bb.min.x) || 0;
        const len = baseLen * (s.scale?.x || 1);
        const left = (s.position?.x || 0) - len * 0.5;
        if (left < minEdgeX) minEdgeX = left;
      });

      if (isFinite(minEdgeX)) {
        this.poolGroup.userData.stepUVOriginX = minEdgeX;
        // z=0 is the pool datum (coping level) in your builders
        this.poolGroup.userData.stepUVOriginZ = 0;
      }
    }
  }

  rebakePoolTilingUVs() {
    if (!this.poolGroup) return;

    // Recompute origins each rebuild (shape changes shift bounds)
    this.computeAndStoreUVOrigins();

    // Update UVs on any mesh that relies on fixed-density tiling
    this.poolGroup.traverse((o) => {
      if (!o?.isMesh) return;

      // Floors, walls, steps (treads + risers) are the main targets
      if (o.userData?.isFloor || o.userData?.isWall || o.userData?.isStep || o.userData?.forceVerticalUV) {
        this.updateScaledBoxTilingUVs(o);
      }
    });
  }

  updateScaledBoxTilingUVs(mesh) {
    if (!mesh?.isMesh || !mesh.geometry?.attributes?.position) return;

    const geo = mesh.geometry;
    const pos = geo.attributes.position;
    const nrm = geo.attributes.normal;
    if (!nrm) return;

    const tile = this.tileSize || 0.3;

    // Per-group origins for grout snapping
    const g = mesh.parent?.userData || this.poolGroup?.userData || {};
    const stepOriginX = (g.stepUVOriginX ?? 0);
    const stepOriginZ = (g.stepUVOriginZ ?? 0);
    const floorOrigin = g.floorUVOrigin ?? { x: 0, y: 0 };

    // Effective scale relative to the pool group.
    // This keeps tile density stable during live preview when the whole
    // poolGroup is scaled for length/width dragging, while still respecting
    // per-mesh scaling for step extension / wall raise.
    let sx = 1, sy = 1, sz = 1;
    let cur = mesh;
    while (cur) {
      sx *= cur.scale?.x ?? 1;
      sy *= cur.scale?.y ?? 1;
      sz *= cur.scale?.z ?? 1;
      if (cur === this.poolGroup) break;
      cur = cur.parent;
    }

    const uvs = new Float32Array(pos.count * 2);

    for (let i = 0; i < pos.count; i++) {
      // Local vertex scaled to match world-space tiling density
      const lx = pos.getX(i) * sx;
      const ly = pos.getY(i) * sy;
      const lz = pos.getZ(i) * sz;

      const ax = Math.abs(nrm.getX(i));
      const ay = Math.abs(nrm.getY(i));
      const az = Math.abs(nrm.getZ(i));

      let u = 0, v = 0;

      // RISERS: vertical faces must use Z for vertical grout density
      // (older mapping used Y, which collapses grout on risers)
      if (mesh.userData?.forceVerticalUV || mesh.userData?.isRiser) {
        if (ax >= ay && ax >= az) {
          // normal ~X => plane is YZ
          u = (ly + (mesh.position?.y || 0) - floorOrigin.y) / tile;
          v = (lz + (mesh.position?.z || 0) - stepOriginZ) / tile;
        } else if (ay >= ax && ay >= az) {
          // normal ~Y => plane is XZ
          u = (lx + (mesh.position?.x || 0) - stepOriginX) / tile;
          v = (lz + (mesh.position?.z || 0) - stepOriginZ) / tile;
        } else {
          // fallback
          u = (lx + (mesh.position?.x || 0) - stepOriginX) / tile;
          v = (ly + (mesh.position?.y || 0) - floorOrigin.y) / tile;
        }

      // STEP TREADS: align along X from step origin, and along Y from floor origin
      } else if (mesh.userData?.isStep && az >= ax && az >= ay) {
        u = (lx + (mesh.position?.x || 0) - stepOriginX) / tile;
        v = (ly + (mesh.position?.y || 0) - floorOrigin.y) / tile;

      // POOL FLOOR: align to floor origin in XY
      } else if (mesh.userData?.isFloor && az >= ax && az >= ay) {
        u = (lx + (mesh.position?.x || 0) - floorOrigin.x) / tile;
        v = (ly + (mesh.position?.y || 0) - floorOrigin.y) / tile;

      // WALLS (vertical): lock grout to floor origin horizontally, and Z vertically
      } else if (mesh.userData?.isWall) {
        if (ax >= ay && ax >= az) {
          // plane YZ
          u = (ly + (mesh.position?.y || 0) - floorOrigin.y) / tile;
          v = (lz + (mesh.position?.z || 0)) / tile;
        } else {
          // plane XZ
          u = (lx + (mesh.position?.x || 0) - floorOrigin.x) / tile;
          v = (lz + (mesh.position?.z || 0)) / tile;
        }

      // Fallback triplanar-ish projection
      } else {
        if (az >= ax && az >= ay) {
          u = (lx + (mesh.position?.x || 0)) / tile;
          v = (ly + (mesh.position?.y || 0)) / tile;
        } else if (ay >= ax && ay >= az) {
          u = (lx + (mesh.position?.x || 0)) / tile;
          v = (lz + (mesh.position?.z || 0)) / tile;
        } else {
          u = (ly + (mesh.position?.y || 0)) / tile;
          v = (lz + (mesh.position?.z || 0)) / tile;
        }
      }

      uvs[i * 2] = u;
      uvs[i * 2 + 1] = v;
    }

    geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));

    // If a material uses uv2 (AO), keep it in sync
    if (geo.attributes.uv2) {
      geo.setAttribute("uv2", geo.attributes.uv.clone());
    }

    geo.attributes.uv.needsUpdate = true;
  }

// --------------------------------------------------------------
  // WATER GHOST MODE

  // --------------------------------------------------------------
  // FLOOR REPROFILE AFTER STEP EXTENSION
  // - Moves slope origin to the runtime end of steps run
  // - Raises (cuts out) the floor under step footprints to meet step bottoms
  // --------------------------------------------------------------
  updateFloorAfterStepExtension(steps, originX) {
    if (!this.poolGroup || !Array.isArray(steps) || steps.length === 0) return;
    if (!isFinite(originX)) return;

    // Find the floor mesh (prefer tagged isFloor)
    let floor = null;
    this.poolGroup.traverse((o) => {
      if (!floor && o?.isMesh && o.userData?.isFloor) floor = o;
    });
    floor = floor || this.poolGroup.userData?.floorMesh;
    if (!floor?.geometry?.attributes?.position) return;

    const params = this.poolGroup.userData?.poolParams || {};
    const clampedShallow = Math.max(0.5, Number(params.shallow) || 0.5);
    const clampedDeep = Math.max(clampedShallow, Number(params.deep) || clampedShallow);

    // Determine pool axis start/end from outerPts bbox if available
    let axisStartX = 0;
    let axisEndX = 1;

    const outerPts = this.poolGroup.userData?.outerPts;
    if (Array.isArray(outerPts) && outerPts.length) {
      let minX = Infinity;
      let maxX = -Infinity;
      for (const p of outerPts) {
        const x = p?.x;
        if (!isFinite(x)) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
      if (isFinite(minX) && isFinite(maxX) && maxX > minX) {
        axisStartX = minX;
        axisEndX = maxX;
      }
    } else {
      // fallback: floor bbox in world
      if (!floor.geometry.boundingBox) floor.geometry.computeBoundingBox();
      const bb = floor.geometry.boundingBox;
      const fx = floor.position?.x || 0;
      axisStartX = bb.min.x + fx;
      axisEndX = bb.max.x + fx;
    }

    // If originX is outside the pool span, clamp defensively
    originX = THREE.MathUtils.clamp(originX, axisStartX, axisEndX);

    const fullLen = axisEndX - originX;

    let sFlat = Number(params.shallowFlat) || 0;
    let dFlat = Number(params.deepFlat) || 0;

    const maxFlats = Math.max(0, fullLen - 0.01);
    if (sFlat + dFlat > maxFlats) {
      const scale = (sFlat + dFlat) > 0 ? (maxFlats / (sFlat + dFlat)) : 0;
      sFlat *= scale;
      dFlat *= scale;
    }

    const slopeLen = Math.max(0.01, fullLen - sFlat - dFlat);

    // Build step footprints (world-space AABBs + bottom z)
    const stepBoxes = [];
    for (const step of steps) {
      const geo = step?.geometry;
      if (!geo?.attributes?.position) continue;
      if (!geo.boundingBox) geo.computeBoundingBox();
      const bb = geo.boundingBox;

      const sx = step.scale?.x ?? 1;
      const sy = step.scale?.y ?? 1;
      const sz = step.scale?.z ?? 1;

      const lenX = (bb.max.x - bb.min.x) * sx;
      const lenY = (bb.max.y - bb.min.y) * sy;
      const lenZ = (bb.max.z - bb.min.z) * sz;

      const cx = step.position?.x ?? 0;
      const cy = step.position?.y ?? 0;
      const cz = step.position?.z ?? 0;

      const minX = cx - lenX * 0.5;
      const maxX = cx + lenX * 0.5;
      const minY = cy - lenY * 0.5;
      const maxY = cy + lenY * 0.5;

      const bottomZ = cz - lenZ * 0.5;

      stepBoxes.push({ minX, maxX, minY, maxY, bottomZ });
    }

    const pos = floor.geometry.attributes.position;
    const fx = floor.position?.x || 0;
    const fy = floor.position?.y || 0;

    for (let i = 0; i < pos.count; i++) {
      const worldX = pos.getX(i) + fx;
      const worldY = pos.getY(i) + fy;

      // Base rectangle-style floor depth at X (with new originX)
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

      // Cutout/raise under steps: raise floor to meet step bottoms
      // (raise = move toward 0 => max() in negative Z space)
      for (const b of stepBoxes) {
        if (worldX >= b.minX && worldX <= b.maxX && worldY >= b.minY && worldY <= b.maxY) {
          z = Math.max(z, b.bottomZ);
        }
      }

      pos.setZ(i, z);
    }

    pos.needsUpdate = true;
    floor.geometry.computeVertexNormals();

    // Persist for debugging / other systems
    this.poolGroup.userData.originX = originX;
    this.poolGroup.userData.stepFootprintLen = Math.max(0, originX - axisStartX);

    // Re-UV floor too (slope moved, and floor changed under steps)
    this.updateScaledBoxTilingUVs(floor);
  }

  // --------------------------------------------------------------
  ghostifyWater() {
    if (!this.poolGroup) return;
    const water = this.poolGroup.userData?.waterMesh;
    if (water) water.visible = false;
  }

  restoreWater() {
    if (!this.poolGroup) return;
    const water = this.poolGroup.userData?.waterMesh;
    if (water) water.visible = true;
  }

  // --------------------------------------------------------------
  // STEP HIGHLIGHT HELPERS
  // --------------------------------------------------------------
  updateHighlightForStep(step, isSelected) {
    if (!this.scene || !step) return;

    const scaleFactor = isSelected ? 1.12 : 1.06;
    const opacity = isSelected ? 0.45 : 0.3;

    let highlightMesh = isSelected
      ? this.selectedHighlightMesh
      : this.hoverHighlightMesh;

    if (!highlightMesh) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffff66,
        transparent: true,
        opacity,
        depthWrite: false
      });

      highlightMesh = new THREE.Mesh(step.geometry.clone(), mat);
      highlightMesh.renderOrder = 999;
      this.scene.add(highlightMesh);

      if (isSelected) this.selectedHighlightMesh = highlightMesh;
      else this.hoverHighlightMesh = highlightMesh;
    } else {
      if (highlightMesh.geometry) highlightMesh.geometry.dispose();
      highlightMesh.geometry = step.geometry.clone();
      highlightMesh.material.opacity = opacity;
    }

    step.updateWorldMatrix?.(true, false);
    const _stepPos = new THREE.Vector3();
    const _stepQuat = new THREE.Quaternion();
    const _stepScale = new THREE.Vector3();
    step.matrixWorld.decompose(_stepPos, _stepQuat, _stepScale);

    highlightMesh.position.copy(_stepPos);
    highlightMesh.quaternion.copy(_stepQuat);
    highlightMesh.scale.copy(_stepScale).multiplyScalar(scaleFactor);
    highlightMesh.visible = true;
  }

  clearHoverHighlight() {
    if (this.hoverHighlightMesh) this.hoverHighlightMesh.visible = false;
    this.hoveredStep = null;
  }

  clearSelectedHighlight() {
    if (this.selectedHighlightMesh) this.selectedHighlightMesh.visible = false;
    this.selectedStep = null;
  }

  // --------------------------------------------------------------
  // WALL HIGHLIGHT HELPERS (blue)
  // --------------------------------------------------------------
  updateHighlightForWall(wall, isSelected) {
    if (!this.scene || !wall) return;

    const scaleFactor = isSelected ? 1.08 : 1.04;
    const opacity = isSelected ? 0.5 : 0.3;

    let highlightMesh = isSelected
      ? this.selectedWallHighlightMesh
      : this.hoverWallHighlightMesh;

    if (!highlightMesh) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0x66aaff,
        transparent: true,
        opacity,
        depthWrite: false
      });

      highlightMesh = new THREE.Mesh(wall.geometry.clone(), mat);
      highlightMesh.renderOrder = 998;
      this.scene.add(highlightMesh);

      if (isSelected) this.selectedWallHighlightMesh = highlightMesh;
      else this.hoverWallHighlightMesh = highlightMesh;
    } else {
      if (highlightMesh.geometry) highlightMesh.geometry.dispose();
      highlightMesh.geometry = wall.geometry.clone();
      highlightMesh.material.opacity = opacity;
    }

    wall.updateWorldMatrix?.(true, false);
    const _wallPos = new THREE.Vector3();
    const _wallQuat = new THREE.Quaternion();
    const _wallScale = new THREE.Vector3();
    wall.matrixWorld.decompose(_wallPos, _wallQuat, _wallScale);

    highlightMesh.position.copy(_wallPos);
    highlightMesh.quaternion.copy(_wallQuat);
    highlightMesh.scale.copy(_wallScale).multiplyScalar(scaleFactor);
    highlightMesh.visible = true;
  }

  clearWallHoverHighlight() {
    if (this.hoverWallHighlightMesh) {
      this.hoverWallHighlightMesh.visible = false;
    }
    this.hoveredWall = null;
  }

  clearWallSelectedHighlight() {
    if (this.selectedWallHighlightMesh) {
      this.selectedWallHighlightMesh.visible = false;
    }
    this.selectedWall = null;

    // Also reset wall UI slider directly (defensive, in case UI.js
    // is not listening to events)
    const row = document.getElementById("wallRaiseRow");
    const slider = document.getElementById("wallRaise");
    const val = document.getElementById("wallRaise-val");

    if (row) row.style.display = "none";
    if (slider) {
      slider.disabled = true;
      slider.value = "0";
    }
    if (val) val.textContent = "0.00 m";
  }


  updateCustomizeSelectionHighlights() {
    if (!this.scene) return;

    while (this.customizeSelectionHighlightMeshes.length < this.customizeWallSelections.length) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0x66aaff,
        transparent: true,
        opacity: 0.45,
        depthWrite: false
      });
      const mesh = new THREE.Mesh(undefined, mat);
      mesh.renderOrder = 999;
      mesh.visible = false;
      this.scene.add(mesh);
      this.customizeSelectionHighlightMeshes.push(mesh);
    }

    this.customizeSelectionHighlightMeshes.forEach((mesh, index) => {
      const sel = this.customizeWallSelections[index];
      if (!sel?.wall) {
        mesh.visible = false;
        return;
      }
      if (mesh.geometry) mesh.geometry.dispose();
      mesh.geometry = sel.wall.geometry.clone();
      mesh.position.copy(sel.wall.position);
      mesh.rotation.copy(sel.wall.rotation);
      mesh.scale.copy(sel.wall.scale).multiplyScalar(1.08);
      mesh.visible = true;
    });
  }

  clearCustomizeWallSelectionHighlights() {
    this.customizeSelectionHighlightMeshes.forEach((mesh) => {
      if (mesh) mesh.visible = false;
    });
  }

  clearCustomizePreview() {
    this.customizePreview = null;
    if (this.customizePreviewLine) {
      this.customizePreviewLine.visible = false;
    }
    const confirmBtn = document.getElementById("customizeConfirmBtn");
    if (confirmBtn) confirmBtn.style.display = "none";
  }

  // --------------------------------------------------------------
  // STEP SELECTION (hover + double-click)
  // --------------------------------------------------------------
  setupStepSelection() {
    if (!this.renderer || !this.camera) return;
    const dom = this.renderer.domElement;

    // Hover – highlight only, do not open panel
    dom.addEventListener("pointermove", (event) => {
      if (!this.poolGroup || this.customizeMode) return;

      if (this.poolEditor?.isDragging) return;

      const rect = dom.getBoundingClientRect();
      const mouse = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
      );

      const ray = new THREE.Raycaster();
      ray.setFromCamera(mouse, this.camera);

      const steps = [];
      this.poolGroup.traverse((o) => o.userData?.isStep && steps.push(o));

      if (!steps.length) {
        this.clearHoverHighlight();
        return;
      }

      const hit = ray.intersectObjects(steps, true);
      if (!hit.length) {
        this.clearHoverHighlight();
        return;
      }

      const step = hit[0].object;

      if (step === this.selectedStep) {
        this.clearHoverHighlight();
        return;
      }

      if (step !== this.hoveredStep) {
        this.hoveredStep = step;
        this.updateHighlightForStep(step, false);
      }
    });

    // Select – pick step, ghost water, open Steps panel
    dom.addEventListener("dblclick", (event) => {
      if (!this.poolGroup) return;

      const rect = dom.getBoundingClientRect();
      const mouse = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
      );

      const ray = new THREE.Raycaster();
      ray.setFromCamera(mouse, this.camera);

      const steps = [];
      this.poolGroup.traverse((o) => o.userData?.isStep && steps.push(o));

      const hit = steps.length ? ray.intersectObjects(steps, true) : [];

      // If a step is hit, consume this event so wall selection / ripple do not also fire
      if (hit.length) {
        event.stopImmediatePropagation();
      }
      if (!hit.length) {
        const hadSel = !!this.selectedStep;
        this.clearSelectedHighlight();
        if (hadSel) {
          document.dispatchEvent(new CustomEvent("stepSelectionCleared"));
          document.dispatchEvent(new CustomEvent("stepsPanelClosed"));
          this.restoreWater();
        }
        return;
      }

      const step = hit[0].object;
      this.selectedStep = step;

      this.updateHighlightForStep(step, true);
      this.clearHoverHighlight();

      // Open Steps panel via UI helper (if present)
      if (window.openPanelFromCode) {
        window.openPanelFromCode("steps");
      }

      // Fire panel-open event so existing listeners (camera zoom, ghost)
      // continue to work as before
      document.dispatchEvent(new CustomEvent("stepsPanelOpened"));

      // ghost water for clearer view of steps
      this.ghostifyWater();

      document.dispatchEvent(new CustomEvent("stepSelected"));
    });
  }

  // --------------------------------------------------------------
  // STEP EXTENSION SLIDER (CHAIN PUSH, ALL SHAPES)
  // --------------------------------------------------------------
  setupStepExtensionSlider() {
    const slider = document.getElementById("stepExtension");
    const output = document.getElementById("stepExtension-val");
    if (!slider) return;

    if (output) {
      output.textContent = parseFloat(slider.value).toFixed(2) + " m";
    }

    slider.addEventListener("pointerdown", () => this.captureUndoState("Step extension"));

    slider.addEventListener("input", () => {
      if (!this.selectedStep || !this.poolGroup) return;

      const val = parseFloat(slider.value);
      if (!isFinite(val)) return;

      if (output) {
        output.textContent = val.toFixed(2) + " m";
      }

      const steps = [];
      this.poolGroup.traverse((o) => {
        if (o.userData && o.userData.isStep) steps.push(o);
      });
      if (!steps.length) return;

      steps.forEach((step) => {
        if (!step.geometry.boundingBox) {
          step.geometry.computeBoundingBox();
        }
      });

      const selGeo = this.selectedStep.geometry;
      if (!selGeo.boundingBox) selGeo.computeBoundingBox();
      const selBBox = selGeo.boundingBox;
      let selBaseLength = selBBox.max.x - selBBox.min.x;
      if (!isFinite(selBaseLength) || selBaseLength <= 0) {
        selBaseLength = 0.3;
      }

      const newScaleX = val / selBaseLength;
      this.selectedStep.scale.x = newScaleX;

      // compute left-most edge among all steps
      let minEdgeX = Infinity;
      steps.forEach((step) => {
        const geo = step.geometry;
        const bbox = geo.boundingBox;
        const baseLen = bbox.max.x - bbox.min.x;
        const length = baseLen * step.scale.x;
        const leftEdge = step.position.x - length * 0.5;
        if (leftEdge < minEdgeX) minEdgeX = leftEdge;
      });
      if (!isFinite(minEdgeX)) return;

      // chain them left to right
      let runX = minEdgeX;
      steps
        .sort((a, b) => a.position.x - b.position.x)
        .forEach((step) => {
          const geo = step.geometry;
          const bbox = geo.boundingBox;
          const baseLen = bbox.max.x - bbox.min.x;
          const length = baseLen * step.scale.x;

          const centerX = runX + length * 0.5;
          step.position.x = centerX;

          runX += length;
        });

            // Rebake UVs so tile density stays fixed after scaling/position changes
      steps.forEach((s) => this.updateScaledBoxTilingUVs(s));

      // Reprofile floor: move slope origin + cut out under steps
      this.updateFloorAfterStepExtension(steps, runX);

      this.updateHighlightForStep(this.selectedStep, true);
      this.ghostifyWater();
    });
  }

  // --------------------------------------------------------------
  // WALL SELECTION (hover + double-click) – opens Features panel
  // --------------------------------------------------------------
  setupWallSelection() {
    if (!this.renderer || !this.camera) return;
    const dom = this.renderer.domElement;

    // Hover: always allowed, independent of panel state
    dom.addEventListener("pointermove", (event) => {
      if (!this.poolGroup) return;

      if (this.poolEditor?.isDragging) return;

      const rect = dom.getBoundingClientRect();
      const mouse = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
      );

      const ray = new THREE.Raycaster();
      ray.setFromCamera(mouse, this.camera);

      const walls = [];
      this.poolGroup.traverse((o) => o.userData?.isWall && walls.push(o));

      if (!walls.length) {
        this.clearWallHoverHighlight();
        return;
      }

      const hit = ray.intersectObjects(walls, true);
      if (!hit.length) {
        this.hoveredCustomizeCurveEdgeIndex = null;
        this.clearWallHoverHighlight();
        if (this.customizeMode && !this.customizePreview) this.refreshCustomizeHint();
        return;
      }

      const wall = hit[0].object;
      const hoveredCurveEdge = (() => {
        if (!this.customizeMode) return null;
        const idx = wall?.userData?.sourceEdgeIndex;
        if (!Number.isInteger(idx)) return null;
        const curvedFromWall = !!wall?.userData?.sourceEdgeCurved;
        const curvedFromPolygon = !!this.editablePolygon?.getEdge?.(idx)?.isCurved;
        return (curvedFromWall || curvedFromPolygon) ? idx : null;
      })();

      if (wall === this.selectedWall && !Number.isInteger(hoveredCurveEdge)) {
        this.clearWallHoverHighlight();
        return;
      }

      if (Number.isInteger(hoveredCurveEdge) && this.isPolygonShape()) {
        if (this.hoveredCustomizeCurveEdgeIndex !== hoveredCurveEdge) {
          this.hoveredCustomizeCurveEdgeIndex = hoveredCurveEdge;
          this.hoveredWall = wall;
          this.updateHighlightForWall(wall, false);
          this.refreshCustomizeHint("Click the curved wall to edit its radius or revert it back to a square corner.");
        }
        return;
      }

      this.hoveredCustomizeCurveEdgeIndex = null;
      if (wall !== this.hoveredWall) {
        this.hoveredWall = wall;
        this.updateHighlightForWall(wall, false);
      }
    });

    // Single-click curved walls to jump straight into customise mode, or pick walls while customising
    dom.addEventListener("click", (event) => {
      if (!this.poolGroup) return;

      const rect = dom.getBoundingClientRect();
      const mouse = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
      );

      const ray = new THREE.Raycaster();
      ray.setFromCamera(mouse, this.camera);

      const walls = [];
      this.poolGroup.traverse((o) => o.userData?.isWall && walls.push(o));

      const hit = walls.length ? ray.intersectObjects(walls, true) : [];
      if (!hit.length) return;

      const pickedWall = hit[0].object;
      const curvedSourceEdge = (() => {
        const idx = pickedWall?.userData?.sourceEdgeIndex;
        if (!Number.isInteger(idx)) return null;
        const curvedFromWall = !!pickedWall?.userData?.sourceEdgeCurved;
        const curvedFromPolygon = !!this.editablePolygon?.getEdge?.(idx)?.isCurved;
        return (curvedFromWall || curvedFromPolygon) ? idx : null;
      })();

      if (Number.isInteger(curvedSourceEdge) && this.isPolygonShape()) {
        if (!this.customizeMode) {
          this.setCustomizeMode(true);
        }
        this.selectExistingCurvedEdgeForCustomize(curvedSourceEdge, pickedWall);
        return;
      }

      if (!this.customizeMode) return;
      this.handleCustomizeWallPick(pickedWall, hit[0].point);
    });

    // Select: pick wall, open Features panel, sync slider
    dom.addEventListener("dblclick", (event) => {
      if (!this.poolGroup) return;

      const rect = dom.getBoundingClientRect();
      const mouse = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
      );

      const ray = new THREE.Raycaster();
      ray.setFromCamera(mouse, this.camera);

      const walls = [];
      this.poolGroup.traverse((o) => o.userData?.isWall && walls.push(o));

      const hit = walls.length ? ray.intersectObjects(walls, true) : [];
      if (!hit.length) {
        const hadSel = !!this.selectedWall;
        this.clearWallSelectedHighlight();
        if (hadSel) {
          document.dispatchEvent(new CustomEvent("wallSelectionCleared"));
        }
        return;
      }

      const wall = hit[0].object;
      this.selectedWall = wall;

      this.updateHighlightForWall(wall, true);
      this.clearWallHoverHighlight();
      this.focusCameraOnWall(wall);

      // Open Features panel via UI helper, if available
      if (window.openPanelFromCode) {
        window.openPanelFromCode("features");
      }

      // initialise slider UI from wall meta
      const row = document.getElementById("wallRaiseRow");
      const slider = document.getElementById("wallRaise");
      const valSpan = document.getElementById("wallRaise-val");

      if (row) row.style.display = "block";

      if (slider) {
        let baseHeight = wall.userData?.baseHeight;
        if (!isFinite(baseHeight) || baseHeight <= 0) {
          const params = wall.geometry?.parameters;
          baseHeight =
            (params && typeof params.depth === "number" && params.depth > 0)
              ? params.depth
              : 1;
          wall.userData.baseHeight = baseHeight;
        }

        const currentHeight =
          wall.userData?.currentHeight ?? baseHeight * (wall.scale?.z || 1);
        const savedExtra = this.wallRaiseBySourceEdge?.[this._getWallRaiseKey(wall)] ?? null;
        const extra = Math.max(0, Number.isFinite(savedExtra) ? savedExtra : (currentHeight - baseHeight));

        slider.disabled = false;
        slider.value = extra.toFixed(2);

        if (valSpan) {
          valSpan.textContent = extra.toFixed(2) + " m";
        }
      }

      document.dispatchEvent(new CustomEvent("wallSelected"));
    });
  }

  // --------------------------------------------------------------
  // WALL RAISE SLIDER
  //  - raises selected wall
  //  - raises coping:
  //      * per-wall, if copingSegments + wall.copingIndex exist
  //      * otherwise, global ring coping using max extra
  // --------------------------------------------------------------
  setupWallRaiseSlider() {
    const slider = document.getElementById("wallRaise");
    const output = document.getElementById("wallRaise-val");
    if (!slider) return;

    if (output) {
      output.textContent = parseFloat(slider.value || "0").toFixed(2) + " m";
    }

    slider.addEventListener("pointerdown", () => this.captureUndoState("Wall raise"));

    slider.addEventListener("input", () => {
      if (!this.selectedWall || !this.poolGroup) return;

      const extra = parseFloat(slider.value || "0");
      if (!isFinite(extra)) return;

      if (output) {
        output.textContent = extra.toFixed(2) + " m";
      }

      const key = this._getWallRaiseKey(this.selectedWall);
      if (key == null) return;

      this.wallRaiseBySourceEdge[key] = Math.max(0, extra);
      this._applyWallExtraToMeshesFromKey(key, extra);
      this.updateHighlightForWall(this.selectedWall, true);
    });
  }


  _clonePoolParams() {
    return JSON.parse(JSON.stringify(this.poolParams));
  }

  _serializeEditablePolygon() {
    if (!this.editablePolygon) return null;
    return {
      vertices: this.editablePolygon.vertices.map((v) => ({ x: v.x, y: v.y })),
      edges: this.editablePolygon.edges.map((e) => ({
        isCurved: !!e?.isCurved,
        control: e?.control ? { x: e.control.x, y: e.control.y } : null
      })),
      minVertices: this.editablePolygon.minVertices,
      isRectangular: !!this.editablePolygon.isRectangular
    };
  }

  _restoreEditablePolygon(data) {
    if (!data) {
      this.editablePolygon = null;
      return;
    }

    const poly = new EditablePolygon(
      (data.vertices || []).map((v) => new THREE.Vector2(v.x, v.y))
    );

    if (Array.isArray(data.edges) && data.edges.length === poly.edges.length) {
      poly.edges = data.edges.map((e) => ({
        isCurved: !!e?.isCurved,
        control: e?.control ? new THREE.Vector2(e.control.x, e.control.y) : null
      }));
    }

    poly.minVertices = data.minVertices ?? 3;
    poly.isRectangular = !!data.isRectangular;
    this.editablePolygon = poly;
  }

  captureUndoState(_reason = "") {
    if (this.isRestoringUndo) return;

    const stack = Array.isArray(this.undoStack) ? this.undoStack : [];
    const redo = Array.isArray(this.redoStack) ? this.redoStack : [];
    const limit = Number.isFinite(this.undoLimit) ? this.undoLimit : 50;

    this.undoStack = stack;
    this.redoStack = redo;
    this.undoLimit = limit;

    const snapshot = {
      poolParams: this._clonePoolParams(),
      editablePolygon: this._serializeEditablePolygon(),
      baseShapeType: this.baseShapeType,
      isCustomShape: !!this.isCustomShape,
      wallRaiseBySourceEdge: JSON.parse(JSON.stringify(this.wallRaiseBySourceEdge || {})),
      hasSpa: !!this.spa,
      spa: this.spa ? {
        spaShape: this.spa.userData?.spaShape ?? "square",
        spaLength: this.spa.userData?.spaLength ?? 2,
        spaWidth: this.spa.userData?.spaWidth ?? 2,
        topHeight: this.spa.userData?.spaTopHeight ?? 0,
        position: this.spa?.position ? {
          x: this.spa.position.x,
          y: this.spa.position.y,
          z: this.spa.position.z
        } : null
      } : null
    };

    let serialized = "";
    try {
      serialized = JSON.stringify(snapshot);
    } catch (_err) {
      serialized = "";
    }

    const last = stack.length ? stack[stack.length - 1] : null;
    if (last && serialized) {
      try {
        if (JSON.stringify(last) === serialized) return;
      } catch (_err) {}
    }

    stack.push(snapshot);
    if (stack.length > limit) {
      stack.shift();
    }
    redo.length = 0;
    this.updateUndoButtonState();
  }

  updateUndoButtonState() {
    const btn = document.getElementById("undoBtn");
    if (!btn) return;
    const undoCount = Array.isArray(this.undoStack) ? this.undoStack.length : 0;
    btn.disabled = undoCount === 0;
  }

  async undoLastChange() {
    if (!Array.isArray(this.undoStack) || !this.undoStack.length) return;

    const snapshot = this.undoStack.pop();
    this.updateUndoButtonState();
    if (!snapshot) return;

    this.isRestoringUndo = true;
    try {
      this.poolParams = JSON.parse(JSON.stringify(snapshot.poolParams || this.poolParams));
      this.baseShapeType = snapshot.baseShapeType || this.poolParams.shape;
      this.isCustomShape = !!snapshot.isCustomShape;
      this.wallRaiseBySourceEdge = JSON.parse(JSON.stringify(snapshot.wallRaiseBySourceEdge || {}));
      this._restoreEditablePolygon(snapshot.editablePolygon || null);

      const shapeSelect = document.getElementById("shape");
      if (shapeSelect) shapeSelect.value = this.poolParams.shape;

      this.updateShapeUIVisibility();
    this.refreshDisplayedShapeLabel();
      this.refreshDisplayedShapeLabel();
      this.syncSlidersFromParams();

      if (snapshot.hasSpa) {
        if (!this.spa) {
          this.spa = createSpa(this.poolParams, this.scene, {
            tileSize: this.tileSize,
            shape: snapshot?.spa?.spaShape || this.getSelectedSpaShape()
          });
    this.spa.userData.poolGroup = this.poolGroup || null;
          this.spa.userData.poolGroup = this.poolGroup || null;
        }
        if (snapshot.spa) {
          this.spa.userData.spaShape = snapshot.spa.spaShape || "square";
          const spaShapeSelect = document.getElementById("spaShape");
          if (spaShapeSelect) spaShapeSelect.value = this.spa.userData.spaShape;
          this.spa.userData.spaLength = snapshot.spa.spaLength;
          this.spa.userData.spaWidth = snapshot.spa.spaWidth;
          this.spa.userData.spaTopHeight = snapshot.spa.topHeight ?? 0;
          if (snapshot.spa.position) {
            this.spa.position.set(snapshot.spa.position.x, snapshot.spa.position.y, snapshot.spa.position.z ?? 0);
          }
          setSpaTopOffset(snapshot.spa.topHeight ?? 0);
          updateSpa(this.spa);
          snapToPool(this.spa);
          await this.pbrManager?.applyTilesToSpa?.(this.spa);
          this.setSpaSlidersEnabled(true);
          this.refreshSpaTopOffsetSlider();
          const spaBtn = document.getElementById("addRemoveSpa");
          if (spaBtn) spaBtn.textContent = "Remove Spa";
        }
      } else if (this.spa) {
        this.removeSpa();
        const spaBtn = document.getElementById("addRemoveSpa");
        if (spaBtn) spaBtn.textContent = "Add Spa";
        this.refreshSpaDimensionLabels();
      }

      await this.rebuildPoolForCurrentShape();
      this.focusCameraOnPoolShape();
      window.openPanelFromCode?.("shape");
    } finally {
      this.isRestoringUndo = false;
    }
  }

  setupGlobalActionButtons() {
    const undoBtn = document.getElementById("undoBtn");
    const screenshotBtn = document.getElementById("screenshotBtn");

    undoBtn?.addEventListener("click", async () => {
      await this.undoLastChange();
    });

    screenshotBtn?.addEventListener("click", () => {
      if (!this.renderer) return;
      try {
        this.renderer.render(this.scene, this.camera);
        const link = document.createElement("a");
        link.href = this.renderer.domElement.toDataURL("image/png");
        link.download = `pool-designer-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
        link.click();
      } catch (err) {
        console.error("[PoolApp] Screenshot failed.", err);
      }
    });

    this.updateUndoButtonState();
  }

  // --------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------
  isPolygonShape() {
    return this.poolParams.shape === "freeform" || (!!this.editablePolygon && !!this.isCustomShape);
  }

  destroyPoolEditor() {
    if (this.poolEditor) {
      this.poolEditor.dispose?.();
      this.poolEditor = null;
    }
    this._purgePoolEditorHandles();
  }

  _purgePoolEditorHandles() {
    if (!this.scene) return;
    const stale = [];
    this.scene.traverse((o) => {
      if (o?.userData?.kind === "vertex" || o?.userData?.kind === "edge") stale.push(o);
    });
    stale.forEach((o) => {
      try { o.parent?.remove(o); } catch (_) {}
      try { o.geometry?.dispose?.(); } catch (_) {}
      try { o.material?.dispose?.(); } catch (_) {}
    });
  }

  _getWallRaiseKey(wall) {
    if (!wall?.userData) return null;
    if (Number.isInteger(wall.userData.sourceEdgeIndex)) return `src:${wall.userData.sourceEdgeIndex}`;
    if (Number.isInteger(wall.userData.edgeIndex)) return `edge:${wall.userData.edgeIndex}`;
    return null;
  }

  _applyWallExtraToMeshesFromKey(key, extra = 0) {
    if (!this.poolGroup || key == null) return;

    const walls = [];
    this.poolGroup.traverse((o) => {
      if (o?.userData?.isWall && this._getWallRaiseKey(o) === key) walls.push(o);
    });
    if (!walls.length) return;

    const safeExtra = Math.max(0, Number.isFinite(extra) ? extra : 0);
    const copingSegments = this.poolGroup.userData?.copingSegments;
    const resolveCopingSegmentForWall = (wall) => {
      if (!copingSegments) return null;
      if (Array.isArray(copingSegments)) {
        const idx = wall?.userData?.copingIndex;
        return (idx != null) ? copingSegments[idx] : null;
      }
      const key = wall?.userData?.copingKey ?? wall?.userData?.side;
      if (key != null && typeof copingSegments === "object") {
        return copingSegments[key] || null;
      }
      return null;
    };

    walls.forEach((wall) => {
      let baseHeight = wall.userData?.baseHeight;
      if (!isFinite(baseHeight) || baseHeight <= 0) {
        const params = wall.geometry?.parameters;
        baseHeight = (params && typeof params.depth === "number" && params.depth > 0) ? params.depth : 1;
        wall.userData.baseHeight = baseHeight;
      }

      const newHeight = baseHeight + safeExtra;
      const scaleZ = newHeight / baseHeight;
      wall.scale.z = scaleZ;
      // v7.1-style wall raise behaviour: keep the bottom anchored at the pool
      // floor depth while the top rises by half of the added height.
      wall.position.z = -(baseHeight / 2) + safeExtra / 2;
      wall.userData.currentHeight = newHeight;
      wall.userData.extraHeight = safeExtra;
      try { this.updateScaledBoxTilingUVs(wall); } catch (_) {}

      const seg = resolveCopingSegmentForWall(wall);
      if (seg) {
        if (!seg.userData) seg.userData = {};
        if (seg.userData.baseZ == null) seg.userData.baseZ = seg.position.z;
        seg.position.z = seg.userData.baseZ + safeExtra;
      }
    });

    const copingRing = this.poolGroup.userData?.copingMesh;
    if (!copingSegments && copingRing) {
      if (!copingRing.userData) copingRing.userData = {};
      if (copingRing.userData.baseZ == null) copingRing.userData.baseZ = copingRing.position.z;
      let maxExtra = 0;
      this.poolGroup.traverse((o) => {
        if (!o?.userData?.isWall) return;
        const e = o.userData?.extraHeight || 0;
        if (e > maxExtra) maxExtra = e;
      });
      copingRing.position.z = copingRing.userData.baseZ + maxExtra;
    }
  }

  _reapplySavedWallRaiseState() {
    if (!this.poolGroup) return;
    const entries = Object.entries(this.wallRaiseBySourceEdge || {});
    entries.forEach(([key, extra]) => {
      if (Number.isFinite(extra) && extra > 0) {
        this._applyWallExtraToMeshesFromKey(key, extra);
      }
    });
  }

  // --------------------------------------------------------------
  // REBUILD POOL
  // --------------------------------------------------------------
  async rebuildPoolForCurrentShape() {
    if (this.poolGroup) {
      this._removePoolGroupSafely(this.poolGroup);
    }

    let group;

    if (this.isPolygonShape()) {
      if (!this.editablePolygon) {
        this.editablePolygon = EditablePolygon.fromRectangle(
          this.poolParams.length,
          this.poolParams.width
        );
        this.editablePolygon.isRectangular = true;
        this.editablePolygon.minVertices = 3;
      }

      group = createPoolGroup(
        this.poolParams,
        this.tileSize,
        this.editablePolygon
      );
    } else {
      this.editablePolygon = null;
      this.destroyPoolEditor();

      const shape = this.poolParams.shape;

      if (shape === "rectangular")
        group = createRectanglePool(this.poolParams, this.tileSize);
      else if (shape === "oval")
        group = createOvalPool(this.poolParams, this.tileSize);
      else if (shape === "kidney")
        group = createKidneyPool(this.poolParams, this.tileSize);
      else if (shape === "L")
        group = createLShapePool(this.poolParams, this.tileSize);
      else group = createRectanglePool(this.poolParams, this.tileSize);
    }

    this.poolGroup = group;

    // Ensure fixed tile density + snapped grout after any rebuild (shape/params)
    this.rebakePoolTilingUVs();

    if (this.scene && this.poolGroup) {
      this.scene.add(this.poolGroup);
updateGroundVoid(this.ground || this.scene.userData.ground, this.poolGroup, this.spa);
      updateGrassForPool(this.scene, this.poolGroup);
    }

    if (this.pbrManager && this.poolGroup) {
      this.pbrManager.setPoolGroup(this.poolGroup);
      this.pbrManager.updatePoolParamsRef(this.poolParams);
      await this.pbrManager.applyCurrentToGroup();
    }

    if (this.spa && this.poolGroup && this.pbrManager) {
      snapToPool(this.spa);
      updateSpa(this.spa);
      await this.pbrManager.applyTilesToSpa(this.spa);
      updatePoolWaterVoid(this.poolGroup, this.spa);
      updateGroundVoid(this.ground || this.scene?.userData?.ground, this.poolGroup, this.spa);
    }

    this._reapplySavedWallRaiseState();

    if (this.poolParams.shape === "freeform" && this.editablePolygon) {
      this.setupPoolEditor();
    } else {
      this.destroyPoolEditor();
    }

    // Clear step selection and notify UI
    const hadSelection = !!this.selectedStep;
    this.clearHoverHighlight();
    this.clearSelectedHighlight();
    if (hadSelection) {
      document.dispatchEvent(new CustomEvent("stepSelectionCleared"));
      document.dispatchEvent(new CustomEvent("stepsPanelClosed"));
      this.restoreWater();
    }

    // Clear wall selection and notify UI
    const hadWallSel = !!this.selectedWall;
    this.clearWallHoverHighlight();
    this.clearWallSelectedHighlight();
    if (hadWallSel) {
      document.dispatchEvent(new CustomEvent("wallSelectionCleared"));
    }

    if (!this.spa) {
      this.selectedSpa = null;
    this.hoveredSpa = null;
    this.hoverSpaHighlight = null;
    this.selectedSpaHighlight = null;
      setSelectedSpa(null);
    }

    // If steps panel currently open (from UI), keep water ghosted
    const stepsPanel = document.getElementById("panel-steps");
    if (stepsPanel?.classList.contains("open")) this.ghostifyWater();

    // Reset any preview scaling and capture baseline params after an expensive rebuild
    try { this.poolGroup.scale.set(1, 1, 1); } catch (_) {}
    this._live.baseParams = { ...this.poolParams };
    this._live.dirty.clear();
  }

  // --------------------------------------------------------------
  // START
  // --------------------------------------------------------------
  async start() {
    setupSidePanels();

    const { scene, camera, renderer, ground, controls } = await initScene();
    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
    this.ground = ground;
    this.controls = controls;
    this.clock = new THREE.Clock();

    this.setupGlobalActionButtons();

    // Water interior prepass render target (used by stylized water refraction)
    const _sz = new THREE.Vector2();
    this.renderer.getSize(_sz);
    this._waterInteriorRT = new THREE.WebGLRenderTarget(_sz.x, _sz.y, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat
    });
    // Water depth prepass (packed RGBA depth) for thickness/absorption in water shader
    this._waterDepthRT = new THREE.WebGLRenderTarget(_sz.x, _sz.y, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat
    });
    this._waterDepthMat = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking
    });
    this._waterDepthMat.blending = THREE.NoBlending;


    // Keep RT in sync with window resize (scene.js also resizes renderer/camera)
    window.addEventListener("resize", () => {
      const s = new THREE.Vector2();
      this.renderer.getSize(s);
      this._waterInteriorRT.setSize(s.x, s.y);
      this._waterDepthRT?.setSize(s.x, s.y);

      const wm = this.poolGroup?.userData?.waterMesh;
      const u = wm?.material?.uniforms;
      if (u?.resolution) u.resolution.value.set(s.x, s.y);
    });


    this.caustics = new CausticsSystem();
    // NOTE: poolGroup is built in rebuildPoolForCurrentShape(); we attach after that.
    console.log('✅ PoolApp created CausticsSystem:', this.caustics);
// PBR / Caustics integration should never hard-crash the app if a module fails
    // to load or throws during initialization. If it fails, we continue without PBR.
    try {
      this.pbrManager = new PBRManager(this.poolParams, this.tileSize, this.caustics);
    } catch (err) {
      console.error("[PoolApp] PBRManager init failed; continuing without PBR.", err);
      this.pbrManager = null;
    }

    await this.rebuildPoolForCurrentShape();

    // Final defensive attach (in case materials changed during rebuild)
    try { this.caustics?.attachToGroup?.(this.poolGroup); } catch (_) {}

    // Guard all calls: if PBR is unavailable (or poolGroup not yet built), keep running.
    if (this.poolGroup && this.pbrManager && typeof this.pbrManager.setPoolGroup === "function") {
      this.pbrManager.setPoolGroup(this.poolGroup);
      if (typeof this.pbrManager.initButtons === "function") {
        await this.pbrManager.initButtons(this.poolGroup);
      }
    }

    this.setupSpaSystem();
    this.setupSpaSelection();
    this.setupShapeDropdown();
    this.setupSpaSliders();
    this.setupPoolSliders();
    this.setupRippleClick();

    this.updateShapeUIVisibility();

    // steps
    this.setupStepSelection();
    this.setupStepExtensionSlider();

    // walls
    this.setupWallSelection();
    this.setupWallRaiseSlider();
    this.setupCustomizeCurveTool();

    // Make sure UI sliders reflect the current poolParams
    this.syncSlidersFromParams();

    document.addEventListener("shapePanelOpened", () => {
      this.focusCameraOnPoolShape();
    });

    // CAMERA ZOOM WHEN STEPS PANEL OPENS
    document.addEventListener("stepsPanelOpened", () => {
      this.ghostifyWater();

      if (!this.poolGroup) return;

      const steps = [];
      this.poolGroup.traverse((o) => o.userData?.isStep && steps.push(o));
      if (!steps.length) return;

      const firstStep = steps[0];
      const target = firstStep.position.clone();
      target.z += 0.3;

      const offset = new THREE.Vector3(3, 2, 2);
      const newPos = target.clone().add(offset);

      this.animateCameraTo(newPos, target, 0.8);
    });

    document.addEventListener("stepsPanelClosed", () => {
      this.restoreWater();
      const hadSel = !!this.selectedStep;
      this.clearHoverHighlight();
      this.clearSelectedHighlight();
      if (hadSel)
        document.dispatchEvent(new CustomEvent("stepSelectionCleared"));
    });

    window.openPanelFromCode?.("shape");

    this.animate();
  }


  updateHighlightForSpa(spa, isSelected) {
    if (!this.scene || !spa) return;

    const highlight = isSelected ? (this.selectedSpaHighlight || new THREE.Group()) : (this.hoverSpaHighlight || new THREE.Group());
    if (!highlight.parent) this.scene.add(highlight);

    while (highlight.children.length) {
      const child = highlight.children.pop();
      child.geometry?.dispose?.();
      child.material?.dispose?.();
    }

    spa.updateMatrixWorld(true);
    const selectable = [];
    spa.traverse((o) => {
      if (!o.isMesh) return;
      if (o.userData?.ignoreClickSelect || o.userData?.isSpaWater) return;
      selectable.push(o);
    });

    const opacity = isSelected ? 0.35 : 0.22;
    const scale = isSelected ? 1.025 : 1.012;
    for (const mesh of selectable) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xd37cff,
        transparent: true,
        opacity,
        depthWrite: false
      });
      const clone = new THREE.Mesh(mesh.geometry.clone(), mat);
      clone.renderOrder = isSelected ? 997 : 996;
      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      const scl = new THREE.Vector3();
      mesh.updateMatrixWorld(true);
      mesh.matrixWorld.decompose(pos, quat, scl);
      clone.position.copy(pos);
      clone.quaternion.copy(quat);
      clone.scale.copy(scl).multiplyScalar(scale);
      highlight.add(clone);
    }

    highlight.visible = true;
    if (isSelected) this.selectedSpaHighlight = highlight;
    else this.hoverSpaHighlight = highlight;
  }

  clearSpaHoverHighlight() {
    if (this.hoverSpaHighlight) this.hoverSpaHighlight.visible = false;
    this.hoveredSpa = null;
  }

  clearSpaSelectedHighlight() {
    if (this.selectedSpaHighlight) this.selectedSpaHighlight.visible = false;
    this.selectedSpa = null;
  }

  // --------------------------------------------------------------
  // SPA SYSTEM
  // --------------------------------------------------------------
  setupCustomizeCurveTool() {
    const btn = document.getElementById("customizeShapeBtn");
    const confirmBtn = document.getElementById("customizeConfirmBtn");
    const revertBtn = document.getElementById("revertCornerBtn");
    const radiusSlider = document.getElementById("customizeRadius");
    if (!btn) return;

    btn.addEventListener("click", () => {
      this.setCustomizeMode(!this.customizeMode);
    });

    confirmBtn?.addEventListener("click", async () => {
      try {
        this.captureUndoState("Apply curve");
      } catch (err) {
        console.warn("Undo snapshot failed before applying curve", err);
      }
      await this.applyCurveFromPreview();
    });

    revertBtn?.addEventListener("click", async () => {
      try {
        this.captureUndoState("Revert curve");
      } catch (err) {
        console.warn("Undo snapshot failed before reverting curve", err);
      }
      await this.revertSelectedCurveToSquare();
    });

    radiusSlider?.addEventListener("input", () => {
      const value = Number(radiusSlider.value);
      if (!Number.isFinite(value)) return;
      this.customizeRadius = value;
      this.updateCustomizeRadiusUI();

      if (Number.isInteger(this.customizeEditEdgeIndex)) {
        this.selectExistingCurvedEdgeForCustomize(
          this.customizeEditEdgeIndex,
          this.customizeWallSelections[0]?.wall || null
        );
      } else if (this.customizeWallSelections.length >= 2) {
        this.refreshCustomizePreviewFromSelections();
      }
    });

    document.addEventListener("shapePanelClosed", () => {
      this.setCustomizeMode(false);
    });
  }

  showCustomizeRevertButton(show) {
    const revertBtn = document.getElementById("revertCornerBtn");
    if (!revertBtn) return;
    revertBtn.style.display = show ? "inline-flex" : "none";
  }

  setCustomizeMode(active) {
    const unsupported = this.poolParams.shape === "oval" || this.poolParams.shape === "kidney";
    if (active && unsupported) {
      this.customizeMode = false;
      this.customizeWallSelections = [];
      this.customizeEditEdgeIndex = null;
      this.hoveredCustomizeCurveEdgeIndex = null;
      this.clearCustomizeWallSelectionHighlights();
      this.clearCustomizePreview();
      this.showCustomizeRevertButton(false);
      this.refreshCustomizeHint("Customise currently works with rectangular, freeform, and L-shape pools.");
      return;
    }

    this.customizeMode = !!active;
    this.customizeWallSelections = [];
    this.customizeEditEdgeIndex = null;
    this.hoveredCustomizeCurveEdgeIndex = null;
    this.clearCustomizeWallSelectionHighlights();
    this.clearCustomizePreview();
    this.customizeRadiusBounds = { min: 1.0, max: 4.0 };

    this.showCustomizeRevertButton(false);

    const btn = document.getElementById("customizeShapeBtn");
    const confirmBtn = document.getElementById("customizeConfirmBtn");

    if (btn) {
      btn.textContent = this.customizeMode ? "Cancel Customise" : "Customise";
      btn.classList.toggle("primary", this.customizeMode);
    }
    if (confirmBtn) confirmBtn.style.display = "none";

    this.updateCustomizeRadiusUI();
    this.refreshCustomizeHint();

    if (!this.customizeMode) {
      this.clearWallSelectedHighlight();
    }
  }

  refreshCustomizeHint(message = "") {
    const hint = document.getElementById("customizeShapeHint");
    if (!hint) return;

    if (!this.customizeMode && !message) {
      hint.style.display = "none";
      hint.textContent = "Select 2 adjacent walls where you want the curved edge.";
      return;
    }

    hint.style.display = "block";
    hint.textContent = message || (
      Number.isInteger(this.customizeEditEdgeIndex)
        ? "Curved wall selected. Adjust the radius slider, press Confirm to update it, or press Revert to Square Corner to change it back to a square corner."
        : this.customizeWallSelections.length === 0
          ? "Select the first adjacent wall where you want the curved edge, or click an existing curved wall to edit it."
          : "Select the second adjacent wall. A preview will appear before you confirm."
    );
  }

  updateCustomizeRadiusUI(bounds = null) {
    const wrap = document.getElementById("customizeRadiusWrap");
    const slider = document.getElementById("customizeRadius");
    const valueLabel = document.getElementById("customizeRadius-val");
    if (!wrap || !slider || !valueLabel) return;

    if (bounds) {
      this.customizeRadiusBounds = {
        min: Number.isFinite(bounds.min) ? bounds.min : this.customizeRadiusBounds.min,
        max: Number.isFinite(bounds.max) ? bounds.max : this.customizeRadiusBounds.max
      };
    }

    const min = 1.0;
    const max = 4.0;

    this.customizeRadiusBounds = { min, max };
    this.customizeRadius = THREE.MathUtils.clamp(
      Number.isFinite(this.customizeRadius) ? this.customizeRadius : min,
      min,
      max
    );

    slider.min = min.toFixed(2);
    slider.max = max.toFixed(2);
    slider.step = "0.05";
    slider.value = this.customizeRadius.toFixed(2);
    slider.disabled = !(
      this.customizeMode &&
      (this.customizeWallSelections.length >= 2 || Number.isInteger(this.customizeEditEdgeIndex))
    );
    wrap.style.display = this.customizeMode ? "block" : "none";
    valueLabel.textContent = `${this.customizeRadius.toFixed(2)} m`;
  }

  refreshCustomizePreviewFromSelections() {
    const preview = this.computeCustomizePreviewData(this.customizeWallSelections, this.customizeRadius);
    const confirmBtn = document.getElementById("customizeConfirmBtn");

    if (!preview) {
      this.customizePreview = null;
      this.clearCustomizePreview();
      if (confirmBtn) confirmBtn.style.display = "none";
      this.showCustomizeRevertButton(false);
      this.updateCustomizeRadiusUI();
      this.refreshCustomizeHint("The selected walls could not form a curved corner. Pick 2 adjacent walls.");
      return;
    }

    this.customizeRadius = preview.radius;
    this.customizePreview = preview;
    this.showCustomizeCurvePreview(preview);

    if (confirmBtn) confirmBtn.style.display = "inline-flex";
    this.showCustomizeRevertButton(false);
    this.updateCustomizeRadiusUI({ min: preview.minRadius, max: preview.maxRadius });
    this.refreshCustomizeHint("Preview ready. Adjust the radius slider, then press Confirm.");
  }

  selectExistingCurvedEdgeForCustomize(edgeIndex, wall = null) {
    if (!this.customizeMode || !this.editablePolygon) return;

    const preview = this.computeExistingCurvePreviewData(edgeIndex, this.customizeRadius);
    const confirmBtn = document.getElementById("customizeConfirmBtn");

    this.customizeWallSelections = wall ? [{ wall, edgeIndex, hitPoint: null }] : [];
    this.updateCustomizeSelectionHighlights();
    this.customizeEditEdgeIndex = edgeIndex;

    if (!preview) {
      this.customizePreview = null;
      this.clearCustomizePreview();
      if (confirmBtn) confirmBtn.style.display = "none";
      this.showCustomizeRevertButton(false);
      this.updateCustomizeRadiusUI({ min: 1.0, max: 4.0 });
      this.refreshCustomizeHint("That curved wall cannot be resized from this shape.");
      return;
    }

    this.customizeRadius = preview.radius;
    this.customizePreview = preview;
    this.showCustomizeCurvePreview(preview);

    if (confirmBtn) confirmBtn.style.display = "inline-flex";
    this.showCustomizeRevertButton(true);
    this.updateCustomizeRadiusUI({ min: preview.minRadius, max: preview.maxRadius });
    this.refreshCustomizeHint("Curved wall selected. Adjust the radius slider, press Confirm to update it, or press Revert to Square Corner to change it back to a square corner.");
  }

  computeExistingCurvePreviewData(edgeIndex, radiusOverride = null) {
    const polygon = this.editablePolygon;
    if (!polygon?.vertices?.length || !Number.isInteger(edgeIndex)) return null;

    const edge = polygon.getEdge(edgeIndex);
    if (!edge?.isCurved || !edge.control) return null;

    const n = polygon.vertexCount();
    if (n < 4) return null;

    const control = edge.control.clone();
    const startVertex = polygon.getVertex(edgeIndex)?.clone();
    const endVertex = polygon.getVertex(polygon.nextIndex(edgeIndex))?.clone();
    const prevVertex = polygon.getVertex(polygon.prevIndex(edgeIndex))?.clone();
    const nextVertex = polygon.getVertex((edgeIndex + 2) % n)?.clone();
    if (!startVertex || !endVertex || !prevVertex || !nextVertex) return null;

    const inVec = prevVertex.clone().sub(control);
    const outVec = nextVertex.clone().sub(control);
    const inLen = inVec.length();
    const outLen = outVec.length();
    if (inLen < 1e-4 || outLen < 1e-4) return null;

    inVec.normalize();
    outVec.normalize();

    const minRadius = 1.0;
    const maxRadius = Math.min(4.0, Math.min(inLen, outLen) - 0.02);
    if (maxRadius < minRadius) return null;

    const currentRadius = Math.min(
      control.distanceTo(startVertex),
      control.distanceTo(endVertex)
    );

    const defaultRadius = THREE.MathUtils.clamp(
      currentRadius || minRadius,
      minRadius,
      maxRadius
    );

    const radius = THREE.MathUtils.clamp(
      Number.isFinite(radiusOverride) ? radiusOverride : defaultRadius,
      minRadius,
      maxRadius
    );

    const start = control.clone().addScaledVector(inVec, radius);
    const end = control.clone().addScaledVector(outVec, radius);

    const points = [];
    for (let i = 0; i <= 48; i++) {
      const t = i / 48;
      const inv = 1 - t;
      points.push(new THREE.Vector3(
        inv * inv * start.x + 2 * inv * t * control.x + t * t * end.x,
        inv * inv * start.y + 2 * inv * t * control.y + t * t * end.y,
        0.06
      ));
    }

    return {
      mode: "edit-existing",
      edgeIndex,
      control,
      start,
      end,
      radius,
      minRadius,
      maxRadius,
      points
    };
  }

  getCurrentOutlineVertices() {
    if ((this.poolParams.shape === "freeform" || this.isCustomShape) && this.editablePolygon?.vertices?.length) {
      return this.editablePolygon.vertices.map((v) => v.clone());
    }

    if (this.poolParams.shape === "L") {
      const halfL = this.poolParams.length / 2;
      const halfW = this.poolParams.width / 2;

      const notchL = THREE.MathUtils.clamp(
        this.poolParams.length * (Number.isFinite(this.poolParams.notchLengthX) ? this.poolParams.notchLengthX : 0.4),
        0.6,
        Math.max(0.6, this.poolParams.length - 0.6)
      );

      const notchW = THREE.MathUtils.clamp(
        this.poolParams.width * (Number.isFinite(this.poolParams.notchWidthY) ? this.poolParams.notchWidthY : 0.45),
        0.6,
        Math.max(0.6, this.poolParams.width - 0.6)
      );

      return [
        new THREE.Vector2(-halfL, -halfW),
        new THREE.Vector2(halfL, -halfW),
        new THREE.Vector2(halfL, halfW),
        new THREE.Vector2(halfL - notchL, halfW),
        new THREE.Vector2(halfL - notchL, halfW - notchW),
        new THREE.Vector2(-halfL, halfW - notchW)
      ];
    }

    return [
      new THREE.Vector2(-this.poolParams.length / 2, -this.poolParams.width / 2),
      new THREE.Vector2(this.poolParams.length / 2, -this.poolParams.width / 2),
      new THREE.Vector2(this.poolParams.length / 2, this.poolParams.width / 2),
      new THREE.Vector2(-this.poolParams.length / 2, this.poolParams.width / 2)
    ];
  }

  ensureEditablePolygonForCustomization() {
    if (!this.isCustomShape) {
      this.baseShapeType = this.poolParams.shape;
    }

    if (this.editablePolygon?.vertices?.length) {
      return this.editablePolygon;
    }

    const vertices = this.getCurrentOutlineVertices();
    this.editablePolygon = new EditablePolygon(vertices);
    this.editablePolygon.minVertices = 3;
    this.editablePolygon.isRectangular = this.baseShapeType === "rectangular";

    this.isCustomShape = true;

    this.updateShapeUIVisibility();
    this.syncSlidersFromParams();
    this.refreshDisplayedShapeLabel();
    return this.editablePolygon;
  }

  handleCustomizeWallPick(wall, hitPoint) {
    if (!wall || !this.customizeMode) return;

    this.customizeEditEdgeIndex = null;
    this.showCustomizeRevertButton(false);

    const edgeIndex = wall.userData?.edgeIndex;
    if (!Number.isInteger(edgeIndex)) {
      this.refreshCustomizeHint("This shape cannot be customised from wall picks yet.");
      return;
    }

    if (this.customizeWallSelections.length >= 2) {
      this.customizeWallSelections = [];
      this.clearCustomizeWallSelectionHighlights();
      this.clearCustomizePreview();
    }

    if (this.customizeWallSelections.some((sel) => sel.wall === wall)) {
      this.refreshCustomizeHint("That wall is already selected. Pick the adjacent wall next.");
      return;
    }

    this.customizeWallSelections.push({ wall, edgeIndex, hitPoint: hitPoint.clone() });
    this.updateCustomizeSelectionHighlights();
    this.clearWallHoverHighlight();

    if (this.customizeWallSelections.length < 2) {
      this.updateCustomizeRadiusUI();
      this.refreshCustomizeHint();
      return;
    }

    const autoPreview = this.computeCustomizePreviewData(this.customizeWallSelections);
    if (!autoPreview) {
      this.customizeWallSelections = [this.customizeWallSelections[1]];
      this.updateCustomizeSelectionHighlights();
      this.clearCustomizePreview();
      this.updateCustomizeRadiusUI();
      this.refreshCustomizeHint("Select 2 adjacent walls that meet at the corner you want curved.");
      return;
    }

    this.customizeRadius = autoPreview.radius;
    this.updateCustomizeRadiusUI({ min: autoPreview.minRadius, max: autoPreview.maxRadius });
    this.refreshCustomizePreviewFromSelections();
  }

  computeCustomizePreviewData(selections = [], radiusOverride = null) {
    const vertices = this.getCurrentOutlineVertices();
    if (!vertices || vertices.length < 3 || selections.length < 2) return null;

    const n = vertices.length;
    const firstEdge = selections[0].edgeIndex;
    const secondEdge = selections[1].edgeIndex;

    let sharedVertexIndex = -1;
    let incomingEdgeIndex = -1;
    let outgoingEdgeIndex = -1;

    if ((firstEdge + 1) % n === secondEdge) {
      sharedVertexIndex = secondEdge;
      incomingEdgeIndex = firstEdge;
      outgoingEdgeIndex = secondEdge;
    } else if ((secondEdge + 1) % n === firstEdge) {
      sharedVertexIndex = firstEdge;
      incomingEdgeIndex = secondEdge;
      outgoingEdgeIndex = firstEdge;
    } else {
      return null;
    }

    const shared = vertices[sharedVertexIndex];
    const prev = vertices[incomingEdgeIndex];
    const next = vertices[(outgoingEdgeIndex + 1) % n];
    if (!shared || !prev || !next) return null;

    const inVec = prev.clone().sub(shared);
    const outVec = next.clone().sub(shared);
    const inLen = inVec.length();
    const outLen = outVec.length();
    if (inLen < 0.05 || outLen < 0.05) return null;

    inVec.normalize();
    outVec.normalize();

    const minRadius = 1.0;
    const maxRadius = Math.min(4.0, Math.min(inLen, outLen) - 0.02);
    if (maxRadius < minRadius) return null;

    const defaultRadius = THREE.MathUtils.clamp(
      Math.min(inLen, outLen) * 0.35,
      minRadius,
      maxRadius
    );

    const radius = THREE.MathUtils.clamp(
      Number.isFinite(radiusOverride) ? radiusOverride : defaultRadius,
      minRadius,
      maxRadius
    );

    const start = shared.clone().addScaledVector(inVec, radius);
    const end = shared.clone().addScaledVector(outVec, radius);
    const control = shared.clone();

    const points = [];
    for (let i = 0; i <= 48; i++) {
      const t = i / 48;
      const inv = 1 - t;
      points.push(new THREE.Vector3(
        inv * inv * start.x + 2 * inv * t * control.x + t * t * end.x,
        inv * inv * start.y + 2 * inv * t * control.y + t * t * end.y,
        0.06
      ));
    }

    return {
      vertices,
      sharedVertexIndex,
      incomingEdgeIndex,
      outgoingEdgeIndex,
      start,
      end,
      control,
      radius,
      minRadius,
      maxRadius,
      points
    };
  }

  showCustomizeCurvePreview(preview) {
    if (!this.scene || !preview?.points?.length) return;

    if (!this.customizePreviewLine) {
      const geom = new THREE.BufferGeometry();
      const mat = new THREE.LineBasicMaterial({
        color: 0xbfe8ff,
        transparent: true,
        opacity: 0.85,
        depthWrite: false
      });
      this.customizePreviewLine = new THREE.Line(geom, mat);
      this.customizePreviewLine.renderOrder = 1000;
      this.scene.add(this.customizePreviewLine);
    }

    this.customizePreviewLine.geometry.dispose();
    this.customizePreviewLine.geometry = new THREE.BufferGeometry().setFromPoints(preview.points);
    this.customizePreviewLine.visible = true;
  }

  async revertSelectedCurveToSquare() {
    if (!Number.isInteger(this.customizeEditEdgeIndex)) {
      this.refreshCustomizeHint("Select an existing curved wall first.");
      return;
    }

    const polygon = this.ensureEditablePolygonForCustomization();
    const edgeIndex = this.customizeEditEdgeIndex;
    const edge = polygon.getEdge?.(edgeIndex);

    if (!edge?.isCurved || !edge.control) {
      this.refreshCustomizeHint("That curved wall can’t be reverted.");
      return;
    }

    const originalCorner = edge.control.clone();
    const nextIndex = polygon.nextIndex(edgeIndex);

    if (!polygon.vertices?.[edgeIndex] || !polygon.vertices?.[nextIndex]) {
      this.refreshCustomizeHint("That curved wall can’t be reverted.");
      return;
    }

    polygon.vertices[edgeIndex].copy(originalCorner);
    polygon.vertices.splice(nextIndex, 1);

    if (Array.isArray(polygon.edges)) {
      polygon.edges.splice(nextIndex, 1);
      if (!polygon.edges[edgeIndex]) {
        polygon.edges[edgeIndex] = { isCurved: false, control: null };
      } else {
        polygon.edges[edgeIndex].isCurved = false;
        polygon.edges[edgeIndex].control = null;
      }
    }

    polygon.isRectangular = false;
    polygon._emitChange?.();

    await this.rebuildPoolForCurrentShape();
    this.focusCameraOnPoolShape();
    window.openPanelFromCode?.("shape");
    this.setCustomizeMode(true);
    this.normalizeShapeLabelIfNeeded();
    this.refreshCustomizeHint("Curve removed. The corner is square again.");
  }

  async applyCurveFromPreview() {
    const preview = this.customizePreview;
    if (!preview) {
      this.refreshCustomizeHint("Select 2 adjacent walls first so the preview can be confirmed.");
      return;
    }

    const polygon = this.ensureEditablePolygonForCustomization();

    if (preview.mode === "edit-existing") {
      const edgeIndex = preview.edgeIndex;
      if (!Number.isInteger(edgeIndex) || !polygon.vertices?.[edgeIndex]) {
        this.refreshCustomizeHint("The curved wall could not be updated.");
        return;
      }

      polygon.vertices[edgeIndex].copy(preview.start);
      polygon.vertices[polygon.nextIndex(edgeIndex)].copy(preview.end);
      polygon.moveCurveControl(edgeIndex, preview.control);
      polygon.isRectangular = false;
      polygon._emitChange?.();

      await this.rebuildPoolForCurrentShape();
      this.focusCameraOnPoolShape();
      window.openPanelFromCode?.("shape");
      this.isCustomShape = true;
      this.refreshDisplayedShapeLabel();
      this.setCustomizeMode(false);
      return;
    }

    const sharedIndex = preview.sharedVertexIndex;
    if (!Number.isInteger(sharedIndex) || !polygon.vertices?.[sharedIndex]) {
      this.refreshCustomizeHint("The curved corner could not be applied to this shape.");
      return;
    }

    polygon.vertices[sharedIndex].copy(preview.start);
    polygon.addVertexAtEdge(sharedIndex, preview.end);
    polygon.moveCurveControl(sharedIndex, preview.control);
    polygon.isRectangular = false;
    polygon._emitChange?.();

    await this.rebuildPoolForCurrentShape();
    this.focusCameraOnPoolShape();
    window.openPanelFromCode?.("shape");
    this.isCustomShape = true;
    this.refreshDisplayedShapeLabel();
    this.setCustomizeMode(false);
  }

  setupSpaSelection() {
    if (!this.renderer || !this.camera) return;
    const dom = this.renderer.domElement;

    dom.addEventListener("pointermove", (event) => {
      if (!this.spa || this.poolEditor?.isDragging) return;
      if (this.transformControls?.dragging) return;

      const rect = dom.getBoundingClientRect();
      const mouse = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
      );

      const ray = new THREE.Raycaster();
      ray.setFromCamera(mouse, this.camera);

      const spaMeshes = [];
      this.spa.traverse((o) => {
        if (o.isMesh && !o.userData?.ignoreClickSelect && !o.userData?.isSpaWater) spaMeshes.push(o);
      });

      const hit = spaMeshes.length ? ray.intersectObjects(spaMeshes, true) : [];
      if (!hit.length) {
        this.clearSpaHoverHighlight();
        return;
      }

      if (this.selectedSpa === this.spa) {
        this.clearSpaHoverHighlight();
        return;
      }

      if (this.hoveredSpa !== this.spa) {
        this.hoveredSpa = this.spa;
        this.updateHighlightForSpa(this.spa, false);
      }
    });

    dom.addEventListener("click", (event) => {
      if (!this.spa || this.poolEditor?.isDragging) return;
      if (this.transformControls?.dragging) return;

      const rect = dom.getBoundingClientRect();
      const mouse = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
      );

      const ray = new THREE.Raycaster();
      ray.setFromCamera(mouse, this.camera);

      const spaMeshes = [];
      this.spa.traverse((o) => {
        if (o.isMesh && !o.userData?.ignoreClickSelect && !o.userData?.isSpaWater) spaMeshes.push(o);
      });

      const hit = spaMeshes.length ? ray.intersectObjects(spaMeshes, true) : [];
      if (!hit.length) {
        this.clearSpaSelectedHighlight();
        this.clearSpaHoverHighlight();
        return;
      }

      event.stopImmediatePropagation();
      this.selectedSpa = this.spa;
      setSelectedSpa(this.spa);
      this.updateHighlightForSpa(this.spa, true);
      this.clearSpaHoverHighlight();

      if (this.transformControls && this.transformControls.object !== this.spa) {
        this.transformControls.attach(this.spa);
      }

      window.openPanelFromCode?.("spa");
      document.dispatchEvent(new CustomEvent("spaSelected"));
    });
  }

  getSelectedSpaShape() {
    const select = document.getElementById("spaShape");
    return select?.value === "circular" ? "circular" : "square";
  }

  refreshSpaDimensionLabels() {
    const shape = this.spa?.userData?.spaShape || this.getSelectedSpaShape();
    const allSpans = Array.from(document.querySelectorAll('#panel-spa label > span'));
    if (allSpans[1]) allSpans[1].textContent = shape === "circular" ? "Diameter (m)" : "Width (m)";
    if (allSpans[2]) allSpans[2].textContent = shape === "circular" ? "Diameter (m)" : "Length (m)";
  }

  setupSpaSystem() {
    const btn = document.getElementById("addRemoveSpa");
    if (!btn) return;

    const spaShapeSelect = document.getElementById("spaShape");

    this.setSpaSlidersEnabled(false);
    this.refreshSpaDimensionLabels();

    spaShapeSelect?.addEventListener("change", async () => {
      this.refreshSpaDimensionLabels();
      if (!this.spa) return;
      this.captureUndoState("Spa shape change");
      this.spa.userData.spaShape = this.getSelectedSpaShape();
      if (this.spa.userData.spaShape === "circular") {
        const diameter = Math.min(this.spa.userData.spaLength || 2, this.spa.userData.spaWidth || 2);
        this.spa.userData.spaLength = diameter;
        this.spa.userData.spaWidth = diameter;
        const lengthSlider = document.getElementById("spaLength");
        const widthSlider = document.getElementById("spaWidth");
        const lengthOutput = document.getElementById("spaLength-val");
        const widthOutput = document.getElementById("spaWidth-val");
        if (lengthSlider) lengthSlider.value = String(diameter);
        if (widthSlider) widthSlider.value = String(diameter);
        if (lengthOutput) lengthOutput.textContent = diameter.toFixed(2) + " m";
        if (widthOutput) widthOutput.textContent = diameter.toFixed(2) + " m";
      }
      updateSpa(this.spa);
      this.refreshSpaTopOffsetSlider();
      await this.pbrManager.applyTilesToSpa(this.spa);
      if (this.poolGroup) {
        updatePoolWaterVoid(this.poolGroup, this.spa);
        updateGroundVoid(this.ground || this.scene?.userData?.ground, this.poolGroup, this.spa);
      }
    });

    btn.addEventListener("click", () => {
      this.captureUndoState("Spa toggle");
      if (!this.spa) {
        this.addSpa();
        btn.textContent = "Remove Spa";
      } else {
        this.removeSpa();
        btn.textContent = "Add Spa";
      }
    });
  }

  async addSpa() {
    this.spa = createSpa(this.poolParams, this.scene, {
      tileSize: this.tileSize,
      shape: this.getSelectedSpaShape()
    });
    this.spa.userData.poolGroup = this.poolGroup || null;

    snapToPool(this.spa);
    updateSpa(this.spa);

    await this.pbrManager.applyTilesToSpa(this.spa);

    if (this.poolGroup) {
      updatePoolWaterVoid(this.poolGroup, this.spa);
      updateGroundVoid(this.ground || this.scene?.userData?.ground, this.poolGroup, this.spa);
    }

    if (!this.transformControls) {
      this.transformControls = new TransformControls(
        this.camera,
        this.renderer.domElement
      );
      this.transformControls.setMode("translate");

      this.transformControls.addEventListener("change", () => {
        if (this.spa && this.poolGroup) {
          updatePoolWaterVoid(this.poolGroup, this.spa);
          updateGroundVoid(this.ground || this.scene?.userData?.ground, this.poolGroup, this.spa);
        }
      });

      this.transformControls.addEventListener(
        "dragging-changed",
        async (e) => {
          this.controls.enabled = !e.value;

          if (!e.value && this.spa) {
            snapToPool(this.spa);
            updateSpa(this.spa);

            await this.pbrManager.applyTilesToSpa(this.spa);
            this.refreshSpaTopOffsetSlider();

            updatePoolWaterVoid(this.poolGroup, this.spa);
            updateGroundVoid(this.ground || this.scene?.userData?.ground, this.poolGroup, this.spa);
          }
        }
      );

      this.scene.add(this.transformControls);
    }

    this.transformControls.attach(this.spa);
    this.selectedSpa = this.spa;
    setSelectedSpa(this.spa);
    this.setSpaSlidersEnabled(true);
    this.refreshSpaDimensionLabels();
    this.refreshSpaTopOffsetSlider();
  }

  removeSpa() {
    if (!this.spa) return;

    this.scene.remove(this.spa);

    const index = spas.indexOf(this.spa);
    if (index !== -1) spas.splice(index, 1);

    this.clearSpaHoverHighlight();
    this.clearSpaSelectedHighlight();
    this.spa = null;
    this.hoverSpaHighlight = null;
    this.selectedSpaHighlight = null;
    setSelectedSpa(null);

    if (this.transformControls) this.transformControls.detach();

    this.setSpaSlidersEnabled(false);

    if (this.poolGroup) {
      updatePoolWaterVoid(this.poolGroup, null);
      updateGroundVoid(this.ground || this.scene?.userData?.ground, this.poolGroup, null);
    }
  }

  setSpaSlidersEnabled(state) {
    ["spaLength", "spaWidth", "spaTopHeight"].forEach((id) => {
      const slider = document.getElementById(id);
      if (slider) slider.disabled = !state;
    });
  }


  refreshSpaTopOffsetSlider() {
    const slider = document.getElementById("spaTopHeight");
    const output = document.getElementById("spaTopHeight-val");
    if (!slider) return;

    const constraints = getSpaTopOffsetConstraints(this.spa);
    slider.step = String(constraints.step ?? 0.05);
    slider.min = String(constraints.min ?? 0);
    slider.value = Number(constraints.value ?? 0).toFixed(2);

    if (output) {
      output.textContent = Number(constraints.value ?? 0).toFixed(2) + " m";
    }
  }

// --------------------------------------------------------------
// FREEFORM POLYGON EDITOR
// --------------------------------------------------------------
setupPoolEditor() {
  this.destroyPoolEditor();
  if (this.poolParams.shape !== "freeform" || !this.editablePolygon) return;

  this.poolEditor = new PoolEditor(
    this.scene,
    this.editablePolygon,
    this.renderer.domElement,
    {
      handleSize: 0.15,

      onEditStart: () => {
        this.captureUndoState("Freeform edit");
      },

      onPolygonChange: () => {
        if (!this.isPolygonShape()) return;
        if (!this.scene || !this.editablePolygon) return;

        this.editablePolygon.isRectangular = false;
        this.isCustomShape = true;
        this.refreshDisplayedShapeLabel();

        // Remove old pool
        if (this.poolGroup) {
          this._removePoolGroupSafely(this.poolGroup);
        }

        // Full rebuild required so floor, walls, steps, coping and water all
        // follow the edited freeform outline.
        this.poolGroup = createPoolGroup(
          this.poolParams,
          this.tileSize,
          this.editablePolygon
        );

        this.scene.add(this.poolGroup);

        // Keep all dependent systems in sync immediately.
        updateGroundVoid(this.ground, this.poolGroup, this.spa);
        updateGrassForPool(this.scene, this.poolGroup);
        if (this.spa) {
          updatePoolWaterVoid(this.poolGroup, this.spa);
          updateGroundVoid(this.ground || this.scene?.userData?.ground, this.poolGroup, this.spa);
        }

        // Keep tile density / grout alignment stable after each edit.
        this.rebakePoolTilingUVs();
        this._reapplySavedWallRaiseState();

        // Re-attach caustics after the freeform rebuild swaps meshes/materials.
        try { this.caustics?.attachToGroup?.(this.poolGroup); } catch (_) {}

        // Defer expensive PBR + spa logic (prevents tile popping)
        this._schedulePBRApply();
      }
    }
  );
}

  // --------------------------------------------------------------
  // SHAPE UI
  // --------------------------------------------------------------
  setupShapeDropdown() {
    const select = document.getElementById("shape");
    if (!select) return;

    select.value = this.poolParams.shape;
    this.refreshDisplayedShapeLabel();

    select.addEventListener("change", async (e) => {
      this.captureUndoState("Shape change");
      this.destroyPoolEditor();
      this.poolParams.shape = e.target.value;
      this.baseShapeType = this.poolParams.shape;
      this.isCustomShape = false;

      this.updateShapeUIVisibility();

      if (this.poolParams.shape === "freeform") {
        this.editablePolygon = EditablePolygon.fromRectangle(
          this.poolParams.length,
          this.poolParams.width
        );
        this.editablePolygon.isRectangular = true;
        this.editablePolygon.minVertices = 3;
      } else {
        this.editablePolygon = null;
        this.destroyPoolEditor();
        this._purgePoolEditorHandles();
      }

      // keep UI in sync with current params, including shape
      this.syncSlidersFromParams();

      await this.rebuildPoolForCurrentShape();
      if (this.poolParams.shape !== "freeform") {
        this.destroyPoolEditor();
        this._purgePoolEditorHandles();
      }

      // Final defensive attach (in case materials changed during rebuild)
      try { this.caustics?.attachToGroup?.(this.poolGroup); } catch (_) {}
      this.refreshDisplayedShapeLabel();
    });
  }

  formatShapeLabel(shape) {
    if (shape === "rectangular") return "Rectangular";
    if (shape === "L") return "L-Shape";
    if (shape === "oval") return "Oval";
    if (shape === "kidney") return "Kidney";
    if (shape === "freeform") return "Freeform (editable)";
    return shape;
  }

  _polygonHasCurves() {
    return !!this.editablePolygon?.edges?.some?.((e) => !!e?.isCurved && !!e?.control);
  }

  _isAxisAlignedRectangle(verts = []) {
    if (!Array.isArray(verts) || verts.length !== 4) return false;
    const xs = [...new Set(verts.map((v) => Number(v.x.toFixed(4))))];
    const ys = [...new Set(verts.map((v) => Number(v.y.toFixed(4))))];
    return xs.length === 2 && ys.length === 2;
  }

  refreshDisplayedShapeLabel() {
    const select = document.getElementById("shape");
    if (!select) return;

    const base = this.baseShapeType || this.poolParams.shape;

    Array.from(select.options).forEach((opt) => {
      opt.textContent = this.formatShapeLabel(opt.value);
    });

    const activeValue = this.isCustomShape ? base : this.poolParams.shape;
    const activeOption = Array.from(select.options).find((opt) => opt.value === activeValue);

    if (activeOption) {
      const baseLabel = this.formatShapeLabel(base);
      activeOption.textContent = this.isCustomShape ? `Custom ${baseLabel}` : baseLabel;
      select.value = activeValue;
    }
  }

  checkIfPolygonReturnedToBaseShape() {
    if (!this.editablePolygon?.vertices?.length) return false;
    if (this._polygonHasCurves()) return false;

    const verts = this.editablePolygon.vertices;

    if (this.baseShapeType === "rectangular") {
      return this._isAxisAlignedRectangle(verts);
    }

    if (this.baseShapeType === "L") {
      return verts.length === 6;
    }

    return false;
  }

  normalizeShapeLabelIfNeeded() {
    if (this.checkIfPolygonReturnedToBaseShape()) {
      this.isCustomShape = false;
      this.poolParams.shape = this.baseShapeType;
      this.destroyPoolEditor();
    }
    this.refreshDisplayedShapeLabel();
    this.updateShapeUIVisibility();
  }

  updateShapeUIVisibility() {
    const shape = this.poolParams.shape;

    const kidney = document.getElementById("kidney-controls");
    const lshape = document.getElementById("lshape-controls");
    const freeform = document.getElementById("freeform-hint");

    if (kidney) kidney.style.display = shape === "kidney" ? "block" : "none";
    if (lshape) lshape.style.display = shape === "L" ? "block" : "none";
    if (freeform) {
      freeform.style.display = (shape === "freeform" || this.isCustomShape) ? "block" : "none";
    }
  }

  // --------------------------------------------------------------
  // SPA SLIDERS
  // --------------------------------------------------------------
  setupSpaSliders() {
    this.refreshSpaDimensionLabels();
    ["spaLength", "spaWidth", "spaTopHeight"].forEach((id) => {
      const slider = document.getElementById(id);
      const output = document.getElementById(`${id}-val`);
      if (!slider) return;

      slider.addEventListener("pointerdown", () => this.captureUndoState("Spa edit"));

      slider.addEventListener("input", async (e) => {
        if (!this.spa) return;

        const val = parseFloat(e.target.value);
        if (output) output.textContent = val.toFixed(2) + " m";

        const isCircularSpa = (this.spa?.userData?.spaShape || "square") === "circular";
        if (id === "spaLength") {
          this.spa.userData.spaLength = val;
          if (isCircularSpa) {
            this.spa.userData.spaWidth = val;
            const widthSlider = document.getElementById("spaWidth");
            const widthOutput = document.getElementById("spaWidth-val");
            if (widthSlider) widthSlider.value = String(val);
            if (widthOutput) widthOutput.textContent = val.toFixed(2) + " m";
          }
        } else if (id === "spaWidth") {
          this.spa.userData.spaWidth = val;
          if (isCircularSpa) {
            this.spa.userData.spaLength = val;
            const lengthSlider = document.getElementById("spaLength");
            const lengthOutput = document.getElementById("spaLength-val");
            if (lengthSlider) lengthSlider.value = String(val);
            if (lengthOutput) lengthOutput.textContent = val.toFixed(2) + " m";
          }
        } else if (id === "spaTopHeight") {
          setSpaTopOffset(val);
        }

        updateSpa(this.spa);
        this.refreshSpaTopOffsetSlider();
        await this.pbrManager.applyTilesToSpa(this.spa);

        if (this.poolGroup) {
          updatePoolWaterVoid(this.poolGroup, this.spa);
          updateGroundVoid(this.ground || this.scene?.userData?.ground, this.poolGroup, this.spa);
        }
      });
    });
  }

  // --------------------------------------------------------------
  // POOL SLIDERS
  // --------------------------------------------------------------
  // --------------------------------------------------------------
  // PERFORMANCE: live preview (cheap) + debounced rebuild (expensive)
  // --------------------------------------------------------------
  _setLiveDragging(isDragging) {
    this._live.dragging = !!isDragging;

    // When the user releases the slider, force an immediate accurate rebuild
    // (also cancels any pending debounce)
    if (!this._live.dragging) {
      this._flushRebuildNow();
    }
  }

  _scheduleRebuildDebounced() {
    // Always debounce rebuilds on rapid slider changes
    if (this._live.rebuildTimer) clearTimeout(this._live.rebuildTimer);

    this._live.rebuildTimer = setTimeout(() => {
      this._live.rebuildTimer = 0;
      // If still dragging, keep it debounced (don’t rebuild mid-drag unless they pause)
      if (this._live.dragging) return;
      this._flushRebuildNow();
    }, this._live.rebuildDebounceMs);
  }

  async _flushRebuildNow() {
    if (this._live.rebuildTimer) {
      clearTimeout(this._live.rebuildTimer);
      this._live.rebuildTimer = 0;
    }

    // If nothing changed, skip
    if (!this._live.dirty.size) return;

    // Clear any live preview scaling before rebuilding for real
    try { this.poolGroup?.scale?.set?.(1, 1, 1); } catch (_) {}

    await this.rebuildPoolForCurrentShape();

    // Defensive caustics re-attach (materials may be swapped)
    try { this.caustics?.attachToGroup?.(this.poolGroup); } catch (_) {}
  }

  async _runAccurateLiveRebuild() {
    if (this._live.accuratePreviewInFlight) {
      this._live.accuratePreviewQueued = true;
      return;
    }

    this._live.accuratePreviewInFlight = true;
    this._live.accuratePreviewQueued = false;

    try {
      await this.rebuildPoolForCurrentShape();
      try { this.caustics?.attachToGroup?.(this.poolGroup); } catch (_) {}
    } finally {
      this._live.accuratePreviewInFlight = false;

      if (this._live.accuratePreviewQueued && this._live.dragging) {
        this._schedulePreviewTick();
      }
    }
  }

  _scheduleAccurateLiveRebuild() {
    const now = performance.now ? performance.now() : Date.now();
    const minDt = 1000 / Math.max(1, this._live.accuratePreviewFps || 12);

    if ((now - (this._live.lastAccuratePreviewTs || 0)) < minDt) {
      this._live.accuratePreviewQueued = true;
      return;
    }

    this._live.lastAccuratePreviewTs = now;
    this._runAccurateLiveRebuild();
  }

  _schedulePreviewTick() {
    if (this._live.previewRaf) return;

    const tick = (ts) => {
      this._live.previewRaf = 0;

      const minDt = 1000 / Math.max(1, this._live.previewFps);
      if (ts - this._live.lastPreviewTs < minDt) {
        this._live.previewRaf = requestAnimationFrame(tick);
        return;
      }
      this._live.lastPreviewTs = ts;

      // Do live preview while dragging OR while input events are streaming in (e.g. keyboard/scroll updates).
      const streaming = (ts - (this._live.lastInputTs || 0)) < (this._live.previewStreamMs || 200);
      if (this._live.dirty.size && (this._live.dragging || streaming)) {
        this._applyLivePreviewFromDirty();
        this._live.previewRaf = requestAnimationFrame(tick);
      }
    };

    this._live.previewRaf = requestAnimationFrame(tick);
  }

  _applyLivePreviewFromDirty() {
    if (!this.poolGroup) return;

    const base = this._live.baseParams || this.poolGroup.userData?.poolParams || this.poolParams;
    const p = this.poolParams;

    // Hybrid lightweight preview:
    // - length/width: scale X/Y (keeps meshes/materials/sims intact)
    // - shallow/deep/shallowFlat/deepFlat: vertex-only floor Z updates + wall height (no group Z scaling)
    // - everything else: rely on debounced rebuild
    let sx = 1, sy = 1;

    const footprintDirty = this._live.dirty.has("length") || this._live.dirty.has("width");
    const notchDirty = this._live.dirty.has("notchLengthX") || this._live.dirty.has("notchWidthY");
    const isLShape = (p.shape || base.shape || this.poolGroup?.userData?.poolParams?.shape) === "L";

    if (footprintDirty && !isLShape) {
      const baseL = Math.max(0.001, base.length ?? 1);
      const baseW = Math.max(0.001, base.width ?? 1);
      sx = Math.max(0.01, (p.length ?? baseL) / baseL);
      sy = Math.max(0.01, (p.width ?? baseW) / baseW);
    } else {
      // Preserve current X/Y scaling if only depth is changing.
      sx = this.poolGroup.scale.x || 1;
      sy = this.poolGroup.scale.y || 1;
    }

    // Apply footprint scaling preview (NO Z scaling — keeps coping/steps semantics correct)
    this.poolGroup.scale.set(sx, sy, 1);

    if (footprintDirty || (isLShape && notchDirty)) {
      if (isLShape) {
        // L-shape footprint edits change the notch/coping topology, so a simple
        // scale preview is visually wrong. Run throttled accurate rebuilds while
        // the slider is moving so the footprint updates live. This also applies
        // to notch length/width, because they change the actual footprint.
        this.poolGroup.scale.set(1, 1, 1);
        this._scheduleAccurateLiveRebuild();
      } else {
        // Rebake UVs during live footprint preview so tile density updates live
        // instead of stretching until the debounced rebuild completes.
        this.rebakePoolTilingUVs();
      }
    }

    const depthDirty =
      this._live.dirty.has("shallow") ||
      this._live.dirty.has("deep") ||
      this._live.dirty.has("shallowFlat") ||
      this._live.dirty.has("deepFlat") ||
      this._live.dirty.has("stepDepth");

    if (depthDirty) {
      const useAccurateDepthRebuild = !!this.isCustomShape || this.poolParams.shape === "freeform";

      if (useAccurateDepthRebuild) {
        // Custom / editable outlines don’t respond safely to the lightweight wall-height
        // preview because segmented wall pieces can drift above the coping while dragging.
        // Force accurate rebuilds instead.
        this.poolGroup.scale.set(1, 1, 1);
        this._scheduleAccurateLiveRebuild();
      } else {
        // Update only what’s needed for a convincing live preview:
        // floor vertex Z + wall height (top stays at z=0) + step height/position.
        previewUpdateDepths(this.poolGroup, {
          shallow: p.shallow,
          deep: p.deep,
          shallowFlat: p.shallowFlat,
          deepFlat: p.deepFlat,
          stepCount: p.stepCount,
          stepDepth: p.stepDepth,
        });

        // Rebake UVs during live depth preview so deep-end walls and the last step
        // keep fixed tile density while their Z scale/position changes.
        this.rebakePoolTilingUVs();
      }
    }

    // Void/cutout should follow live footprint scaling.
    try { updateGroundVoid(this.ground || this.scene?.userData?.ground, this.poolGroup, this.spa); } catch (_) {}
    try { updatePoolWaterVoid(this.poolGroup, this.spa); } catch (_) {}

    // Clear only the params we handled for preview; keep L-shape footprint dirty
    // until the throttled accurate rebuild has actually run.
    if (!isLShape) {
      this._live.dirty.delete("length");
      this._live.dirty.delete("width");
    }
    this._live.dirty.delete("shallow");
    this._live.dirty.delete("deep");
    this._live.dirty.delete("shallowFlat");
    this._live.dirty.delete("deepFlat");
    this._live.dirty.delete("stepDepth");
  }


  setupPoolSliders() {
    const ids = [
      "length",
      "width",
      "shallow",
      "deep",
      "shallowFlat",
      "deepFlat",
      "stepCount",
      "stepDepth",
      "notchLengthX",
      "notchWidthY",
      "kidneyLeftRadius",
      "kidneyRightRadius",
      "kidneyOffset"
    ];

    const setOutput = (id, val, output) => {
      if (!output) return;
      if (
        id === "length" ||
        id === "width" ||
        id === "shallow" ||
        id === "deep" ||
        id === "shallowFlat" ||
        id === "deepFlat" ||
        id === "stepDepth" ||
        id === "kidneyLeftRadius" ||
        id === "kidneyRightRadius" ||
        id === "kidneyOffset"
      ) {
        output.textContent = Number(val).toFixed(2) + " m";
      } else if (id === "notchLengthX" || id === "notchWidthY") {
        output.textContent = Number(val).toFixed(2);
      } else {
        output.textContent = String(val);
      }
    };

    const markDirty = (id) => {
      this._live.dirty.add(id);
      this._live.lastInputTs = performance.now ? performance.now() : Date.now();
      // Live preview is throttled; we run it while dragging OR while input events are streaming.
      this._schedulePreviewTick();
      // Accurate rebuild is always debounced (or forced on release)
      this._scheduleRebuildDebounced();
    };

    ids.forEach((id) => {
      const slider = document.getElementById(id);
      const output = document.getElementById(`${id}-val`);
      if (!slider) return;

      // Detect "dragging" for mouse + touch
      const onDown = () => {
        this.captureUndoState(`Slider:${id}`);
        // capture baseline for preview scaling (only if we have a pool)
        if (!this._live.baseParams) this._live.baseParams = { ...(this.poolGroup?.userData?.poolParams || this.poolParams) };
        this._setLiveDragging(true);
      };
      const onUp = () => this._setLiveDragging(false);

      slider.addEventListener("pointerdown", onDown);
      slider.addEventListener("pointerup", onUp);
      slider.addEventListener("touchstart", onDown, { passive: true });
      slider.addEventListener("touchend", onUp, { passive: true });
      slider.addEventListener("mousedown", onDown);
      window.addEventListener("mouseup", onUp);

      // Continuous updates (cheap preview + debounced rebuild)
      slider.addEventListener("input", (e) => {
        let val = parseFloat(e.target.value);
        if (id === "stepCount") val = Math.floor(val);

        this.poolParams[id] = val;
        setOutput(id, val, output);

        // For polygon shapes, allow the editor polygon to rescale live (cheap),
        // but do not rebuild full geometry each tick.
        if ((id === "length" || id === "width") && this.isPolygonShape()) {
          try {
            this.editablePolygon?.rescaleTo?.(this.poolParams.length, this.poolParams.width);
            if (this.poolParams.shape === "freeform" && this.editablePolygon) {
              this.editablePolygon.isRectangular = false;
            }
          } catch (_) {}
        }

        markDirty(id);
      });

      // Change event (fires on release in many browsers) forces rebuild now
      slider.addEventListener("change", () => {
        this._setLiveDragging(false);
      });
    });
  }

// --------------------------------------------------------------
// RIPPLE
  // --------------------------------------------------------------
  setupRippleClick() {
    this.renderer.domElement.addEventListener("dblclick", (event) => {
      if (this.poolEditor?.isDragging) return;
      if (!this.poolGroup?.userData?.waterMesh) return;

      const rect = this.renderer.domElement.getBoundingClientRect();
      const mouseX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      const mouseY = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(mouseX, mouseY), this.camera);

      const blockers = [];
      this.poolGroup?.traverse((o) => {
        if (o.userData?.isStep || o.userData?.isWall) blockers.push(o);
      });
      this.spa?.traverse((o) => {
        if (o.isMesh && !o.userData?.ignoreClickSelect) blockers.push(o);
      });
      if (blockers.length && ray.intersectObjects(blockers, true).length) {
        return;
      }

      const hit = ray.intersectObject(this.poolGroup.userData.waterMesh);
      if (!hit.length) return;

      const p = hit[0].point;

      // ✅ SAFE GUARD (RESTORES OLD FREEFORM BEHAVIOUR)
      if (typeof this.poolGroup.userData.triggerRipple === "function") {
        this.poolGroup.userData.triggerRipple(
          p.x,
          p.y,
          this.poolParams.length,
          this.poolParams.width
        );
      }
    });
  }

  // --------------------------------------------------------------
  // NEW: keep UI sliders in sync with poolParams
  // --------------------------------------------------------------
  syncSlidersFromParams() {
    const ids = [
      "length",
      "width",
      "shallow",
      "deep",
      "shallowFlat",
      "deepFlat",
      "stepCount",
      "stepDepth",
      "notchLengthX",
      "notchWidthY",
      "kidneyLeftRadius",
      "kidneyRightRadius",
      "kidneyOffset"
    ];

    ids.forEach((id) => {
      const slider = document.getElementById(id);
      const output = document.getElementById(`${id}-val`);
      if (!slider) return;
      if (!(id in this.poolParams)) return;

      const val = this.poolParams[id];
      slider.value = val;

      if (output) {
        if (
          id === "length" ||
          id === "width" ||
          id === "shallow" ||
          id === "deep" ||
          id === "shallowFlat" ||
          id === "deepFlat" ||
          id === "stepDepth" ||
          id === "kidneyLeftRadius" ||
          id === "kidneyRightRadius" ||
          id === "kidneyOffset"
        ) {
          output.textContent = Number(val).toFixed(2) + " m";
        } else {
          output.textContent = val.toString();
        }
      }
    });

    // shape dropdown
    const shapeSelect = document.getElementById("shape");
    if (shapeSelect && this.poolParams.shape) {
      shapeSelect.value = this.poolParams.shape;
    }
  }

  // --------------------------------------------------------------
  // LOOP
  // --------------------------------------------------------------
  animate() {
    requestAnimationFrame(() => this.animate());

    const delta = this.clock.getDelta();

const dirLight = this.scene?.userData?.dirLight || null;

if (this.poolGroup?.userData?.animatables) {
  this.poolGroup.userData.animatables.forEach((obj) => {
    obj.userData.animate?.(delta, this.clock, this.camera, dirLight, this.renderer);
  });
}

spas.forEach((spaItem) => {
  spaItem.userData.waterMesh?.userData.animate?.(delta, this.clock, this.camera, dirLight, this.renderer);
  spaItem.userData.spilloverMesh?.userData.animate?.(delta, this.clock, this.camera, dirLight, this.renderer);
});


    // Pool water animation (GPU sim)
    this.poolGroup?.userData?.waterMesh?.userData?.animate?.(delta, this.clock, this.camera, dirLight, this.renderer);

    if (this.caustics) {
      if (!this._loggedCausticsTick) { console.log('✅ Caustics update ticking'); this._loggedCausticsTick = true; }
      const wm = this.poolGroup?.userData?.waterMesh;
      const ht = wm?.material?.uniforms?.heightTex?.value || null;
      this.caustics.setWaterHeightTexture?.(ht, 512);
      this.caustics.update(delta, (dirLight && dirLight.position) ? dirLight.position : null);
    }
// Keep freeform handles screen-aligned and interactive
    if (this.poolParams.shape === "freeform") {
      this.poolEditor?.update?.();
    } else if (this.poolEditor) {
      this.destroyPoolEditor();
      this._purgePoolEditorHandles();
    }

    this.scene?.userData?.grassSystem?.update?.(this.camera);

    // Keep selection/hover highlight meshes locked to the live world-space
    // transforms of their targets while the pool is being preview-scaled or rebuilt.
    if (this.selectedWall && this.selectedWallHighlightMesh?.visible) {
      this.updateHighlightForWall(this.selectedWall, true);
    }
    if (this.hoveredWall && this.hoverWallHighlightMesh?.visible) {
      this.updateHighlightForWall(this.hoveredWall, false);
    }
    if (this.selectedStep && this.selectedHighlightMesh?.visible) {
      this.updateHighlightForStep(this.selectedStep, true);
    }
    if (this.hoveredStep && this.hoverHighlightMesh?.visible) {
      this.updateHighlightForStep(this.hoveredStep, false);
    }

    // Stylized water prepass:
// Render scene WITHOUT any water meshes into offscreen RTs, then let the water shader
// sample those textures for refraction + thickness absorption.
const _poolWater = this.poolGroup?.userData?.waterMesh || null;
const _poolU = _poolWater?.material?.uniforms || null;
const _spaWaters = spas
  .map((s) => s?.userData?.waterMesh)
  .filter((wm) => !!wm && wm !== _poolWater);

// Collect all water meshes (pool + spas) so none of them contaminate the prepasses
const _hiddenWater = [];
if (_poolWater) _hiddenWater.push(_poolWater);
_spaWaters.forEach((wm) => _hiddenWater.push(wm));

if (_poolWater && _poolU && this._waterInteriorRT) {
  // Use drawing-buffer size (accounts for devicePixelRatio), because gl_FragCoord is in buffer pixels
  const _buf = new THREE.Vector2();
  this.renderer.getDrawingBufferSize(_buf);

  // Keep RT sizes synced (defensive: resize handler covers most cases, but DPR can change)
  if (this._waterInteriorRT.width !== _buf.x || this._waterInteriorRT.height !== _buf.y) {
    this._waterInteriorRT.setSize(_buf.x, _buf.y);
  }
  if (this._waterDepthRT && (this._waterDepthRT.width !== _buf.x || this._waterDepthRT.height !== _buf.y)) {
    this._waterDepthRT.setSize(_buf.x, _buf.y);
  }

  if (_poolU.resolution) _poolU.resolution.value.set(_buf.x, _buf.y);
  if (_poolU.interiorTex) _poolU.interiorTex.value = this._waterInteriorRT.texture;

  _spaWaters.forEach((wm) => {
    const u = wm?.material?.uniforms || null;
    if (!u) return;
    if (u.resolution) u.resolution.value.set(_buf.x, _buf.y);
    if (u.cameraNear) u.cameraNear.value = this.camera.near;
    if (u.cameraFar)  u.cameraFar.value  = this.camera.far;
  });

  // Hide water meshes for BOTH passes
  _hiddenWater.forEach((m) => (m.visible = false));

  // Depth prepass (DepthTexture) – must not contain water
  if (this._waterDepthRT && _poolU.depthTex) {
    _poolU.depthTex.value = this._waterDepthRT.depthTexture;
    if (_poolU.cameraNear) _poolU.cameraNear.value = this.camera.near;
    if (_poolU.cameraFar)  _poolU.cameraFar.value  = this.camera.far;

    // Render scene depth into the DepthTexture target
    this.renderer.setRenderTarget(this._waterDepthRT);
    this.renderer.clear(true, true, true);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);

    // Re-bind (defensive) – in case a rebuild replaced water material/uniforms
    if (_poolWater?.userData?.setDepthTex) _poolWater.userData.setDepthTex(this._waterDepthRT.depthTexture);
    _spaWaters.forEach((wm) => wm?.userData?.setDepthTex?.(this._waterDepthRT.depthTexture));
  }

  // Color prepass (scene without water) for refraction
  this.renderer.setRenderTarget(this._waterInteriorRT);
  this.renderer.clear(true, true, true);
  this.renderer.render(this.scene, this.camera);
  this.renderer.setRenderTarget(null);

  if (_poolWater?.userData?.setInteriorTex) _poolWater.userData.setInteriorTex(this._waterInteriorRT.texture);
  _spaWaters.forEach((wm) => wm?.userData?.setInteriorTex?.(this._waterInteriorRT.texture));

  // Restore visibility
  _hiddenWater.forEach((m) => (m.visible = true));
}

this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
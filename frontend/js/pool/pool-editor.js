// js/pool/pool-editor.js
import * as THREE from "https://esm.sh/three@0.158.0";

/**
 * PoolEditor – CAD-style:
 *  • Vertex handles = red 2D circles
 *  • Edge arc handles = blue 2D circles
 *  • Handles always face camera (screen-aligned)
 *  • Editing on XY plane (z = 0), exactly like original project
 */
export class PoolEditor {
  constructor(scene, editablePolygon, domElement, options = {}) {
    this.scene = scene;
    this.camera = scene?.userData?.camera;
    this.controls = scene?.userData?.controls;

    if (!this.camera)
      throw new Error("PoolEditor requires scene.userData.camera");

    this.domElement = domElement;
    this.polygon = editablePolygon;

    this.options = Object.assign(
      {
        handleSize: 0.14,
        vertexColor: 0xff3b3b, // red
        edgeColor: 0x3ba0ff,   // blue
        onPolygonChange: null,
        onEditStart: null
      },
      options
    );

    this.vertexHandles = [];
    this.edgeHandles = [];
    this.handleMeshes = [];

    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();
    this.offset = new THREE.Vector3();

    this.selectedHandle = null;
    this.isDragging = false;

    this._createHandleMeshes();
    this.update();

    // Refresh when polygon changes
    this.polygon.onChange(() => {
      if (!this.isDragging) this.refresh();
  });

    // Bind events
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);

    domElement.addEventListener("pointerdown", this._onPointerDown);
    window.addEventListener("pointermove", this._onPointerMove);
    window.addEventListener("pointerup", this._onPointerUp);
  }

  dispose() {
    this.domElement.removeEventListener("pointerdown", this._onPointerDown);
    window.removeEventListener("pointermove", this._onPointerMove);
    window.removeEventListener("pointerup", this._onPointerUp);

    this.handleMeshes.forEach((h) => this.scene.remove(h));
  }

  // ------------------------------------------------------------
  // Create a CAD-style flat 2D circle (face camera)
  // ------------------------------------------------------------
  _makeCircle(size, color) {
    const circle = new THREE.Mesh(
      new THREE.CircleGeometry(size, 32),
      new THREE.MeshBasicMaterial({
        color,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        side: THREE.DoubleSide
      })
    );

    // Face camera at all times
    circle.userData.billboard = true;
    circle.renderOrder = 2000;
    circle.frustumCulled = false;
    return circle;
  }

  // ------------------------------------------------------------
  // Create handles
  // ------------------------------------------------------------
  _createHandleMeshes() {
    this.handleMeshes.forEach((h) => this.scene.remove(h));
    this.vertexHandles = [];
    this.edgeHandles = [];
    this.handleMeshes = [];

    const r = this.options.handleSize;

    // ----- VERTEX HANDLES (RED CIRCLES) -----
    for (let i = 0; i < this.polygon.vertexCount(); i++) {
      const v = this.polygon.getVertex(i);

      const h = this._makeCircle(r, this.options.vertexColor);
      h.position.set(v.x, v.y, 0);

      h.userData.kind = "vertex";
      h.userData.vertexIndex = i;

      this.scene.add(h);
      this.vertexHandles.push(h);
      this.handleMeshes.push(h);
    }

    // ----- EDGE ARC HANDLES (BLUE CIRCLES) -----
    for (let i = 0; i < this.polygon.vertexCount(); i++) {
      const v1 = this.polygon.getVertex(i);
      const v2 = this.polygon.getVertex(this.polygon.nextIndex(i));
      const e = this.polygon.getEdge(i);

      const isCurved = e.isCurved && e.control;
      const pos2D = isCurved
        ? e.control.clone()
        : new THREE.Vector2().addVectors(v1, v2).multiplyScalar(0.5);

      const h = this._makeCircle(r * 0.8, this.options.edgeColor);
      h.position.set(pos2D.x, pos2D.y, 0);

      h.userData.kind = "edge";
      h.userData.edgeIndex = i;

      this.scene.add(h);
      this.edgeHandles.push(h);
      this.handleMeshes.push(h);
    }
  }

  // ------------------------------------------------------------
  // Convert pointer → NDC
  // ------------------------------------------------------------
  _pointerToNDC(e) {
    const rect = this.domElement.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
      y: -((e.clientY - rect.top) / rect.height) * 2 + 1
    };
  }

  // ------------------------------------------------------------
  // Raycast onto XY plane (z = 0)
  // ------------------------------------------------------------
  _intersectPlane(e) {
    const ndc = this._pointerToNDC(e);
    this.mouse.set(ndc.x, ndc.y);

    this.raycaster.setFromCamera(this.mouse, this.camera);

    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0); // z=0
    const p = new THREE.Vector3();
    this.raycaster.ray.intersectPlane(plane, p);

    return p;
  }

  // ------------------------------------------------------------
  // Pointer down
  // ------------------------------------------------------------
  _onPointerDown(e) {
    const ndc = this._pointerToNDC(e);
    this.mouse.set(ndc.x, ndc.y);
    this.raycaster.setFromCamera(this.mouse, this.camera);

    const hits = this.raycaster.intersectObjects(this.handleMeshes, false);
    if (hits.length === 0) return;

    this.selectedHandle = hits[0].object;
    this.isDragging = true;

    if (this.options.onEditStart) this.options.onEditStart(this.selectedHandle);

    if (this.controls) this.controls.enabled = false;

    const worldPos = this._intersectPlane(e);
    this.offset.copy(worldPos).sub(this.selectedHandle.position);
  }

  // ------------------------------------------------------------
  // Pointer move
  // ------------------------------------------------------------
  _onPointerMove(e) {
    if (!this.selectedHandle) return;

    const worldPos = this._intersectPlane(e);
    const np = worldPos.clone().sub(this.offset);

    this.selectedHandle.position.set(np.x, np.y, 0);

    const kind = this.selectedHandle.userData.kind;

    if (kind === "vertex") {
      const idx = this.selectedHandle.userData.vertexIndex;
      this.polygon.moveVertex(idx, new THREE.Vector2(np.x, np.y));
    }

    if (kind === "edge") {
      const idx = this.selectedHandle.userData.edgeIndex;
      this.polygon.moveCurveControl(idx, new THREE.Vector2(np.x, np.y));
    }

    if (this.options.onPolygonChange) this.options.onPolygonChange();
  }

  // ------------------------------------------------------------
  // Pointer up
  // ------------------------------------------------------------
  _onPointerUp() {
    this.selectedHandle = null;
    this.isDragging = false;

    if (this.controls) this.controls.enabled = true;

    this.refresh();
  }

  
// ------------------------------------------------------------
// Per-frame update (billboard handles to camera)
// ------------------------------------------------------------
update() {
  if (!this.camera) return;
  for (const h of this.handleMeshes) {
    if (h?.userData?.billboard) {
      h.quaternion.copy(this.camera.quaternion);
    }
  }
}

// ------------------------------------------------------------
  // Refresh (rebuild handles)
  // ------------------------------------------------------------
  refresh() {
    this._createHandleMeshes();
    this.update();
    this.update();
  }
}

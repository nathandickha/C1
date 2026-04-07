// js/pool/editing/handles.js
// Renders 2D overlay handles for editable polygons.
// Handles both vertex handles and curve control handles.

import * as THREE from "https://esm.sh/three@0.158.0";

export class PolygonHandles {
  constructor(renderer, camera, polygon, options = {}) {
    this.renderer = renderer;
    this.camera = camera;
    this.polygon = polygon;

    this.options = {
      vertexSize: 12,
      curveSize: 10,
      hitPadding: 4,
      vertexColor: "#4bacff",
      vertexActiveColor: "#ffffff",
      curveColor: "#ff8c00",
      curveActiveColor: "#ffffff",
      ...options
    };

    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d");
    this.canvas.style.position = "absolute";
    this.canvas.style.top = "0";
    this.canvas.style.left = "0";
    this.canvas.style.pointerEvents = "none";
    document.body.appendChild(this.canvas);

    this.pixelRatio = window.devicePixelRatio || 1;
    this._resizeCanvas();

    this.handleRects = []; // { type, index, x, y, size }
    this.handleActives = {}; // track active handle for highlighting

    this.dragging = null; // { type, index, startMouse, startWorld }
    this.mouse = new THREE.Vector2();

    this._bindEvents();
    this._updateHandleRects();
  }

  // ---------------------------------------------------------------------
  // Canvas resize
  // ---------------------------------------------------------------------
  _resizeCanvas() {
    const w = window.innerWidth;
    const h = window.innerHeight;

    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;

    this.canvas.width = w * this.pixelRatio;
    this.canvas.height = h * this.pixelRatio;

    this.ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
  }

  // ---------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------
  _bindEvents() {
    window.addEventListener("resize", () => this._resizeCanvas());
    window.addEventListener("pointerdown", (e) => this._onPointerDown(e));
    window.addEventListener("pointermove", (e) => this._onPointerMove(e));
    window.addEventListener("pointerup", (e) => this._onPointerUp(e));
  }

  _screenToNDC(x, y) {
    return new THREE.Vector2(
      (x / window.innerWidth) * 2 - 1,
      -(y / window.innerHeight) * 2 + 1
    );
  }

  _screenToWorld(x, y, planeY = 0) {
    const ndc = this._screenToNDC(x, y);

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, this.camera);

    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -planeY);
    const p = new THREE.Vector3();
    raycaster.ray.intersectPlane(plane, p);
    return p;
  }

  // ---------------------------------------------------------------------
  // Hit testing
  // ---------------------------------------------------------------------
  _hitTest(x, y) {
    for (let i = this.handleRects.length - 1; i >= 0; i--) {
      const h = this.handleRects[i];
      const pad = this.options.hitPadding;

      if (
        x >= h.x - pad &&
        x <= h.x + h.size + pad &&
        y >= h.y - pad &&
        y <= h.y + h.size + pad
      ) {
        return h;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Pointer events
  // ---------------------------------------------------------------------
  _onPointerDown(e) {
    const hit = this._hitTest(e.clientX, e.clientY);
    if (!hit) return;

    this.dragging = {
      type: hit.type,
      index: hit.index,
      startMouse: new THREE.Vector2(e.clientX, e.clientY),
      startWorld: this._screenToWorld(e.clientX, e.clientY)
    };

    this.canvas.style.pointerEvents = "auto";
  }

  _onPointerMove(e) {
    if (!this.dragging) return;

    const worldPos = this._screenToWorld(e.clientX, e.clientY);

    if (this.dragging.type === "vertex") {
      this.polygon.moveVertex(
        this.dragging.index,
        new THREE.Vector2(worldPos.x, worldPos.z)
      );
    }

    if (this.dragging.type === "curve") {
      // ⭐ Use moveCurveControl which now auto-enables curvature
      this.polygon.moveCurveControl(
        this.dragging.index,
        new THREE.Vector2(worldPos.x, worldPos.z)
      );
    }

    this._updateHandleRects();
    this.polygon._emitChange && this.polygon._emitChange();
  }

  _onPointerUp() {
    this.dragging = null;
    this.canvas.style.pointerEvents = "none";
  }

  // ---------------------------------------------------------------------
  // Screen projection
  // ---------------------------------------------------------------------
  _project(v2) {
    const v3 = new THREE.Vector3(v2.x, 0, v2.y);
    v3.project(this.camera);

    return new THREE.Vector2(
      (v3.x * 0.5 + 0.5) * window.innerWidth,
      (-v3.y * 0.5 + 0.5) * window.innerHeight
    );
  }

  // ---------------------------------------------------------------------
  // Handle rectangle update
  // ---------------------------------------------------------------------
  _updateHandleRects() {
    this.handleRects = [];

    const count = this.polygon.vertexCount();

    // Vertices
    for (let i = 0; i < count; i++) {
      const p = this.polygon.getVertex(i);
      const s = this._project(p);

      this.handleRects.push({
        type: "vertex",
        index: i,
        x: s.x - this.options.vertexSize / 2,
        y: s.y - this.options.vertexSize / 2,
        size: this.options.vertexSize
      });
    }

    // ⭐ Curve handles (midpoint "pull" handle for *every* edge)
    for (let i = 0; i < count; i++) {
      const edge = this.polygon.getEdge(i);

      // Where should the handle be?
      // - If curved: at control point
      // - If straight: at edge midpoint
      let handlePos2;
      if (edge && edge.isCurved && edge.control) {
        handlePos2 = edge.control;
      } else {
        handlePos2 = this.polygon.getEdgeMidpoint(i);
      }

      const s = this._project(handlePos2);

      this.handleRects.push({
        type: "curve",
        index: i,
        x: s.x - this.options.curveSize / 2,
        y: s.y - this.options.curveSize / 2,
        size: this.options.curveSize
      });
    }
  }

  // ---------------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------------
  draw() {
    this._updateHandleRects();

    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    for (const h of this.handleRects) {
      const active =
        this.dragging &&
        this.dragging.type === h.type &&
        this.dragging.index === h.index;

      if (h.type === "vertex") {
        ctx.fillStyle = active
          ? this.options.vertexActiveColor
          : this.options.vertexColor;
        ctx.fillRect(h.x, h.y, h.size, h.size);
      }

      if (h.type === "curve") {
        ctx.fillStyle = active
          ? this.options.curveActiveColor
          : this.options.curveColor;
        ctx.beginPath();
        ctx.arc(
          h.x + h.size / 2,
          h.y + h.size / 2,
          h.size / 2,
          0,
          Math.PI * 2
        );
        ctx.fill();
      }
    }
  }
}

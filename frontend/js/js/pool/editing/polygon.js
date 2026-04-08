import * as THREE from "https://esm.sh/three@0.158.0";

export class EditablePolygon {
  constructor(points = []) {
    this.vertices = points.map((p) => p.clone());
    this.edges = [];

    for (let i = 0; i < this.vertices.length; i++) {
      this.edges.push({ isCurved: false, control: null });
    }

    this.listeners = { change: [] };
    this.minVertices = 3;
    this.isRectangular = false;
  }

  // -------------------------------------------------------
  // Events
  // -------------------------------------------------------
  onChange(callback) {
    this.listeners.change.push(callback);
  }

  _emitChange() {
    this.listeners.change.forEach((cb) => cb(this));
  }

  // -------------------------------------------------------
  // Basic accessors
  // -------------------------------------------------------
  vertexCount() {
    return this.vertices.length;
  }

  getVertex(i) {
    return this.vertices[i];
  }

  getEdge(i) {
    return this.edges[i];
  }

  nextIndex(i) {
    return (i + 1) % this.vertices.length;
  }

  prevIndex(i) {
    return (i - 1 + this.vertices.length) % this.vertices.length;
  }

  // ⭐ NEW: helper → midpoint of edge in polygon space (x,y)
  getEdgeMidpoint(edgeIndex) {
    const v1 = this.vertices[edgeIndex];
    const v2 = this.vertices[this.nextIndex(edgeIndex)];
    if (!v1 || !v2) return new THREE.Vector2(0, 0);
    return new THREE.Vector2(
      (v1.x + v2.x) * 0.5,
      (v1.y + v2.y) * 0.5
    );
  }

  // -------------------------------------------------------
  // Vertex operations
  // -------------------------------------------------------
  moveVertex(index, newPos) {
    if (!this.vertices[index]) return;
    this.vertices[index].copy(newPos);

    this._autoUpdateAdjacentControls(index);
    this._emitChange();
  }

  addVertexAtEdge(edgeIndex, newPos) {
    const insertIndex = edgeIndex + 1;

    this.vertices.splice(
      insertIndex,
      0,
      new THREE.Vector2(newPos.x, newPos.y)
    );
    this.edges.splice(insertIndex, 0, { isCurved: false, control: null });

    this._emitChange();
    return insertIndex;
  }

  deleteVertex(index) {
    if (this.vertices.length <= (this.minVertices || 3)) return false;

    this.vertices.splice(index, 1);
    this.edges.splice(index, 1);

    this._emitChange();
    return true;
  }

  // -------------------------------------------------------
  // Curves
  // -------------------------------------------------------
  toggleEdgeCurved(edgeIndex) {
    const e = this.edges[edgeIndex];
    if (!e) return;

    if (!e.isCurved) {
      const v1 = this.vertices[edgeIndex];
      const v2 = this.vertices[this.nextIndex(edgeIndex)];

      const mid = new THREE.Vector2()
        .addVectors(v1, v2)
        .multiplyScalar(0.5);

      const dir = new THREE.Vector2().subVectors(v2, v1);
      const perp = new THREE.Vector2(-dir.y, dir.x).normalize();
      const offsetAmount = dir.length() * 0.2;

      const ctrl = mid.clone().addScaledVector(perp, offsetAmount);

      e.isCurved = true;
      e.control = ctrl;
    } else {
      e.isCurved = false;
      e.control = null;
    }

    this._emitChange();
  }

  // ⭐ UPDATED: now always enables curvature + sets control
  moveCurveControl(edgeIndex, newPos) {
    const e = this.edges[edgeIndex];
    if (!e) return;

    if (!e.isCurved || !e.control) {
      e.isCurved = true;
      e.control = new THREE.Vector2(newPos.x, newPos.y);
    } else {
      e.control.copy(newPos);
    }

    this._emitChange();
  }

  _autoUpdateAdjacentControls(_vertexIndex) {
    // Reserved for future improvements
  }

  // -------------------------------------------------------
  // Sampling & Shape conversion
  // -------------------------------------------------------
  sample(edgeResolution = 16) {
    const result = [];

    for (let i = 0; i < this.vertices.length; i++) {
      const v1 = this.vertices[i];
      const v2 = this.vertices[this.nextIndex(i)];
      const e = this.edges[i];

      if (!e.isCurved) {
        result.push(v1.clone());
      } else {
        for (let t = 0; t < 1; t += 1 / edgeResolution) {
          result.push(this._quadraticBezier(v1, e.control, v2, t));
        }
      }
    }

    return result;
  }

  _quadraticBezier(p0, p1, p2, t) {
    const inv = 1 - t;
    return new THREE.Vector2(
      inv * inv * p0.x + 2 * inv * t * p1.x + t * t * p2.x,
      inv * inv * p0.y + 2 * inv * t * p1.y + t * t * p2.y
    );
  }

  toShape(curveResolution = 24) {
    // Use sampled points so curved edges are reflected in the actual pool mesh.
    // The previous implementation only emitted the raw polygon vertices, which
    // meant edge control points could preview in the editor but not affect the
    // rebuilt geometry.
    const sampled = this.sample(Math.max(4, curveResolution));
    const verts = this._cleanPointList(sampled);
    if (verts.length < 3) return new THREE.Shape();

    let v = verts.slice();

    // Ensure CCW winding
    if (this._signedArea(v) < 0) v.reverse();

    // If the outline is self-intersecting, fall back to a stable simple ordering.
    if (this._isSelfIntersecting(v)) {
      const c = this._centroid(v);
      v = v
        .slice()
        .sort(
          (a, b) =>
            Math.atan2(a.y - c.y, a.x - c.x) -
            Math.atan2(b.y - c.y, b.x - c.x)
        );

      if (this._signedArea(v) < 0) v.reverse();
    }

    const shape = new THREE.Shape();
    shape.moveTo(v[0].x, v[0].y);
    for (let i = 1; i < v.length; i++) {
      shape.lineTo(v[i].x, v[i].y);
    }
    shape.lineTo(v[0].x, v[0].y);

    return shape;
  }

  // ------------------------------------------------------------
  // Internal helpers for polygon robustness
  // ------------------------------------------------------------
  _cleanPointList(points = [], eps = 1e-5) {
    const out = [];
    for (const p of points) {
      if (!p) continue;
      const x = p.x;
      const y = p.y;
      if (!isFinite(x) || !isFinite(y)) continue;

      if (!out.length) {
        out.push(new THREE.Vector2(x, y));
        continue;
      }

      const last = out[out.length - 1];
      if (Math.hypot(x - last.x, y - last.y) > eps) {
        out.push(new THREE.Vector2(x, y));
      }
    }

    if (out.length > 2) {
      const a = out[0];
      const b = out[out.length - 1];
      if (Math.hypot(a.x - b.x, a.y - b.y) <= eps) out.pop();
    }

    return out;
  }

  _getCleanVertices(eps = 1e-5) {
    const out = [];
    for (let i = 0; i < this.vertices.length; i++) {
      const p = this.vertices[i];
      if (!p) continue;
      const x = p.x;
      const y = p.y;
      if (!isFinite(x) || !isFinite(y)) continue;

      if (!out.length) {
        out.push(new THREE.Vector2(x, y));
        continue;
      }
      const last = out[out.length - 1];
      if (Math.hypot(x - last.x, y - last.y) > eps) {
        out.push(new THREE.Vector2(x, y));
      }
    }

    // remove duplicate closure point if present
    if (out.length > 2) {
      const a = out[0];
      const b = out[out.length - 1];
      if (Math.hypot(a.x - b.x, a.y - b.y) <= eps) out.pop();
    }

    // remove obvious collinear points (keeps earcut happier)
    if (out.length > 3) {
      const cleaned = [];
      for (let i = 0; i < out.length; i++) {
        const p0 = out[(i - 1 + out.length) % out.length];
        const p1 = out[i];
        const p2 = out[(i + 1) % out.length];
        const cross =
          (p1.x - p0.x) * (p2.y - p1.y) -
          (p1.y - p0.y) * (p2.x - p1.x);
        if (Math.abs(cross) > eps) cleaned.push(p1);
      }
      if (cleaned.length >= 3) return cleaned;
    }

    return out;
  }

  _signedArea(v) {
    let a = 0;
    for (let i = 0; i < v.length; i++) {
      const p = v[i];
      const q = v[(i + 1) % v.length];
      a += p.x * q.y - q.x * p.y;
    }
    return 0.5 * a;
  }

  _centroid(v) {
    let x = 0,
      y = 0;
    for (const p of v) {
      x += p.x;
      y += p.y;
    }
    return { x: x / v.length, y: y / v.length };
  }

  _isSelfIntersecting(v) {
    const n = v.length;
    if (n < 4) return false;

    const orient = (p, q, r) =>
      (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);

    const segIntersects = (a, b, c, d) => {
      // Proper segment intersection excluding collinear overlaps.
      const o1 = orient(a, b, c);
      const o2 = orient(a, b, d);
      const o3 = orient(c, d, a);
      const o4 = orient(c, d, b);
      return o1 * o2 < 0 && o3 * o4 < 0;
    };

    for (let i = 0; i < n; i++) {
      const a = v[i];
      const b = v[(i + 1) % n];

      for (let j = i + 1; j < n; j++) {
        // skip adjacent edges and wrap-around adjacency
        if (Math.abs(i - j) <= 1) continue;
        if (i === 0 && j === n - 1) continue;

        const c = v[j];
        const d = v[(j + 1) % n];

        if (segIntersects(a, b, c, d)) return true;
      }
    }
    return false;
  }


  // -------------------------------------------------------
  // RESCALING (updated)
  // -------------------------------------------------------
  rescaleTo(targetLength, targetWidth) {
    if (this.isRectangular) {
      // --- RECTANGLE MODE: Force perfect axis-alignment ---
      this.setFromRectangle(targetLength, targetWidth);
      return;
    }

    // --- Freeform/Oval mode: normal bounding-box scale ---
    const bbox = this.vertices.reduce(
      (acc, v) => {
        acc.minX = Math.min(acc.minX, v.x);
        acc.maxX = Math.max(acc.maxX, v.x);
        acc.minY = Math.min(acc.minY, v.y);
        acc.maxY = Math.max(acc.maxY, v.y);
        return acc;
      },
      {
        minX: Infinity,
        maxX: -Infinity,
        minY: Infinity,
        maxY: -Infinity
      }
    );

    const currentLength = bbox.maxX - bbox.minX;
    const currentWidth = bbox.maxY - bbox.minY;

    if (currentLength <= 1e-6 || currentWidth <= 1e-6) return;

    const centerX = (bbox.minX + bbox.maxX) / 2;
    const centerY = (bbox.minY + bbox.maxY) / 2;

    const scaleX = targetLength / currentLength;
    const scaleY = targetWidth / currentWidth;

    this.vertices.forEach((v) => {
      v.x = centerX + (v.x - centerX) * scaleX;
      v.y = centerY + (v.y - centerY) * scaleY;
    });

    this._emitChange();
  }

  // -------------------------------------------------------
  // Rectangle / Oval presets (updated rectangle)
  // -------------------------------------------------------
  setFromRectangle(length, width) {
    this.vertices = [
      new THREE.Vector2(-length / 2, -width / 2),
      new THREE.Vector2(length / 2, -width / 2),
      new THREE.Vector2(length / 2,  width / 2),
      new THREE.Vector2(-length / 2,  width / 2)
    ];

    this.edges = [
      { isCurved: false, control: null },
      { isCurved: false, control: null },
      { isCurved: false, control: null },
      { isCurved: false, control: null }
    ];

    this.isRectangular = true;
    this.minVertices = 4;

    this._emitChange();
  }

  setFromOval(length, width, segments = 24) {
    const pts = [];
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      pts.push(
        new THREE.Vector2(
          Math.cos(a) * length / 2,
          Math.sin(a) * width / 2
        )
      );
    }

    this.vertices = pts;
    this.edges = pts.map(() => ({ isCurved: false, control: null }));

    this.isRectangular = false;
    this.minVertices = 3;

    this._emitChange();
  }

  // -------------------------------------------------------
  // Static factories
  // -------------------------------------------------------
  static fromRectangle(length, width) {
    const poly = new EditablePolygon([
      new THREE.Vector2(-length / 2, -width / 2),
      new THREE.Vector2(length / 2, -width / 2),
      new THREE.Vector2(length / 2,  width / 2),
      new THREE.Vector2(-length / 2,  width / 2)
    ]);

    poly.isRectangular = true;
    poly.minVertices = 4;
    poly.edges = [
      { isCurved: false, control: null },
      { isCurved: false, control: null },
      { isCurved: false, control: null },
      { isCurved: false, control: null }
    ];

    return poly;
  }

  static fromOval(length, width, segments = 24) {
    const pts = [];
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      pts.push(
        new THREE.Vector2(
          Math.cos(a) * length / 2,
          Math.sin(a) * width / 2
        )
      );
    }

    const poly = new EditablePolygon(pts);

    poly.isRectangular = false;
    poly.minVertices = 3;
    poly.edges = pts.map(() => ({ isCurved: false, control: null }));

    return poly;
  }
}

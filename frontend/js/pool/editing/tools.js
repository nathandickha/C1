// js/pool/editing/tools.js
// Manages user interactions: context menu, add/remove vertices, toggle curves,
// and enabling/disabling the editing mode.

import * as THREE from "https://esm.sh/three@0.158.0";

export class PolygonEditorTools {
    constructor(renderer, camera, polygon, handles, options = {}) {
        this.renderer = renderer;
        this.camera = camera;
        this.polygon = polygon;
        this.handles = handles;

        this.options = {
            contextMenuWidth: 160,
            colors: {
                menuBg: '#1e1e1e',
                menuBorder: '#444',
                menuText: '#fff',
            },
            ...options
        };

        this.enabled = false;
        this.contextMenu = null;
        this.lastRightClick = null;

        this._bindEvents();
    }

    // ---------------------------------------------------------------------
    // PUBLIC API
    // ---------------------------------------------------------------------
    enable() {
        this.enabled = true;
    }

    disable() {
        this.enabled = false;
        this._destroyMenu();
    }

    // Called from main.js, supplies click position and index info
    screenToWorld(screenX, screenY) {
        const ndc = new THREE.Vector2(
            (screenX / window.innerWidth) * 2 - 1,
            -(screenY / window.innerHeight) * 2 + 1
        );

        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(ndc, this.camera);

        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
        const p = new THREE.Vector3();
        raycaster.ray.intersectPlane(plane, p);
        return p;
    }

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------
    _bindEvents() {
        window.addEventListener('contextmenu', (e) => {
            if (!this.enabled) return;

            e.preventDefault();

            // Store screen click
            this.lastRightClick = {
                x: e.clientX,
                y: e.clientY
            };

            const hit = this.handles._hitTest(e.clientX, e.clientY);

            if (hit) {
                if (hit.type === 'vertex') {
                    this._openVertexMenu(hit.index, e.clientX, e.clientY);
                } else if (hit.type === 'curve') {
                    this._openCurveMenu(hit.index, e.clientX, e.clientY);
                }
            } else {
                // Right-clicked on empty area → edge insertion?
                const edgeIndex = this._findClosestEdge(e.clientX, e.clientY);
                if (edgeIndex !== null) {
                    this._openEdgeMenu(edgeIndex, e.clientX, e.clientY);
                }
            }
        });
    }

    // ---------------------------------------------------------------------
    // Menu creation
    // ---------------------------------------------------------------------
    _openMenu(items, x, y) {
        this._destroyMenu();

        const menu = document.createElement('div');
        menu.style.position = 'absolute';
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';
        menu.style.background = this.options.colors.menuBg;
        menu.style.border = `1px solid ${this.options.colors.menuBorder}`;
        menu.style.color = this.options.colors.menuText;
        menu.style.padding = '4px 0';
        menu.style.zIndex = 99999;
        menu.style.fontFamily = 'sans-serif';
        menu.style.fontSize = '13px';
        menu.style.width = this.options.contextMenuWidth + 'px';

        for (const item of items) {
            const entry = document.createElement('div');
            entry.textContent = item.label;
            entry.style.padding = '6px 12px';
            entry.style.cursor = 'pointer';

            entry.addEventListener('click', () => {
                this._destroyMenu();
                item.action();
            });

            entry.addEventListener('mouseenter', () => {
                entry.style.background = '#333';
            });
            entry.addEventListener('mouseleave', () => {
                entry.style.background = 'none';
            });

            menu.appendChild(entry);
        }

        document.body.appendChild(menu);
        this.contextMenu = menu;

        // Close on click anywhere else
        setTimeout(() => {
            const close = () => this._destroyMenu();
            window.addEventListener('click', close, { once: true });
        }, 0);
    }

    _destroyMenu() {
        if (this.contextMenu) {
            this.contextMenu.remove();
            this.contextMenu = null;
        }
    }

    // ---------------------------------------------------------------------
    // Vertex Menu
    // ---------------------------------------------------------------------
    _openVertexMenu(index, x, y) {
        const items = [
            {
                label: 'Delete Vertex',
                action: () => {
                    this.polygon.deleteVertex(index);
                }
            },
        ];

        this._openMenu(items, x, y);
    }

    // ---------------------------------------------------------------------
    // Curve Control Menu
    // ---------------------------------------------------------------------
    _openCurveMenu(edgeIndex, x, y) {
        const items = [
            {
                label: 'Make Edge Straight',
                action: () => {
                    this.polygon.toggleEdgeCurved(edgeIndex);
                }
            }
        ];
        this._openMenu(items, x, y);
    }

    // ---------------------------------------------------------------------
    // Edge Menu (Add vertex / Toggle curve)
    // ---------------------------------------------------------------------
    _openEdgeMenu(edgeIndex, x, y) {
        const edge = this.polygon.getEdge(edgeIndex);

        const items = [
            {
                label: 'Add Vertex Here',
                action: () => {
                    const worldPos = this.screenToWorld(x, y);
                    const pos2 = new THREE.Vector2(worldPos.x, worldPos.z);
                    this.polygon.addVertexAtEdge(edgeIndex, pos2);
                }
            },
            {
                label: edge.isCurved ? 'Make Straight' : 'Make Curved',
                action: () => {
                    this.polygon.toggleEdgeCurved(edgeIndex);
                }
            }
        ];

        this._openMenu(items, x, y);
    }

    // ---------------------------------------------------------------------
    // Utility: find closest edge in screen space to cursor
    // ---------------------------------------------------------------------
    _findClosestEdge(screenX, screenY, threshold = 20) {
        let closest = null;
        let minDist = threshold;

        const count = this.polygon.vertexCount();
        for (let i = 0; i < count; i++) {
            const v1 = this.polygon.getVertex(i);
            const v2 = this.polygon.getVertex((i + 1) % count);

            const p1 = this.handles._project(v1);
            const p2 = this.handles._project(v2);

            const dist = this._distPointToSegment(
                { x: screenX, y: screenY },
                { x: p1.x, y: p1.y },
                { x: p2.x, y: p2.y }
            );

            if (dist < minDist) {
                closest = i;
                minDist = dist;
            }
        }

        return closest;
    }

    _distPointToSegment(p, a, b) {
        const ab = { x: b.x - a.x, y: b.y - a.y };
        const ap = { x: p.x - a.x, y: p.y - a.y };
        const abLenSq = ab.x * ab.x + ab.y * ab.y;

        const t = Math.max(0, Math.min(1, (ap.x * ab.x + ap.y * ab.y) / abLenSq));
        const closest = { x: a.x + ab.x * t, y: a.y + ab.y * t };

        const dx = p.x - closest.x;
        const dy = p.y - closest.y;
        return Math.sqrt(dx * dx + dy * dy);
    }
}

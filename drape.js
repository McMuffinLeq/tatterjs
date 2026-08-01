/*!
 * Drape.js — fabric physics for Three.js
 * https://github.com/McMuffinLeq/drapejs
 * MIT License
 *
 * Verlet-integration cloth simulation in 3D. Give it a THREE.Scene
 * and it hands you back a mesh you can drop into your scene, with
 * pinning, wind, and box-collision built in.
 *
 * Requires THREE as a peer dependency (global THREE or passed in).
 */
(function (global, factory) {
  typeof exports === 'object' && typeof module !== 'undefined'
    ? (module.exports = factory())
    : typeof define === 'function' && define.amd
    ? define(factory)
    : (global.Drape = factory());
})(this, function () {
  'use strict';

  function resolveThree(explicit) {
    var THREE = explicit || (typeof window !== 'undefined' ? window.THREE : null);
    if (!THREE) {
      throw new Error('Drape.js: THREE.js not found. Load Three.js before Drape.js, or pass { THREE } in options.');
    }
    return THREE;
  }

  /**
   * A single cloth simulation. Not usually constructed directly —
   * use Drape.cloth(scene, options) instead, which also builds and
   * attaches the mesh for you.
   */
  function Cloth(opts) {
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.spacing = opts.spacing;
    this.origin = opts.origin; // {x, y, z}
    this.gravity = opts.gravity != null ? opts.gravity : -0.012;
    this.drag = opts.drag != null ? opts.drag : 0.985;
    this.iterations = opts.iterations || 6;
    this.tearSensitivity = opts.tear === false ? 0 : (opts.tearSensitivity || 2.6);

    var n = this.cols * this.rows;
    this.pos = new Float32Array(n * 3);
    this.prev = new Float32Array(n * 3);
    this.pinned = new Uint8Array(n);
    this.constraints = []; // [iA, iB, restLength, broken(0/1)]

    var self = this;
    function idx(x, y) { return y * self.cols + x; }
    this.idx = idx;

    for (var y = 0; y < this.rows; y++) {
      for (var x = 0; x < this.cols; x++) {
        var i = idx(x, y);
        var px = this.origin.x + x * this.spacing;
        var py = this.origin.y;
        var pz = this.origin.z + y * this.spacing;
        this.pos[i * 3] = px; this.pos[i * 3 + 1] = py; this.pos[i * 3 + 2] = pz;
        this.prev[i * 3] = px; this.prev[i * 3 + 1] = py; this.prev[i * 3 + 2] = pz;
      }
    }

    for (var y2 = 0; y2 < this.rows; y2++) {
      for (var x2 = 0; x2 < this.cols; x2++) {
        if (x2 < this.cols - 1) this._addConstraint(idx(x2, y2), idx(x2 + 1, y2));
        if (y2 < this.rows - 1) this._addConstraint(idx(x2, y2), idx(x2, y2 + 1));
        // shear constraints — keeps the mesh from collapsing into a diamond, reads as real fabric
        if (opts.shear !== false && x2 < this.cols - 1 && y2 < this.rows - 1) {
          this._addConstraint(idx(x2, y2), idx(x2 + 1, y2 + 1));
          this._addConstraint(idx(x2 + 1, y2), idx(x2, y2 + 1));
        }
      }
    }

    // pinning
    if (opts.pin === 'top') {
      this.pinRow(0, opts.pinEvery || 1);
    } else if (opts.pin === 'corners') {
      this.pinned[idx(0, 0)] = 1;
      this.pinned[idx(this.cols - 1, 0)] = 1;
    } else if (typeof opts.pin === 'function') {
      for (var yy = 0; yy < this.rows; yy++) {
        for (var xx = 0; xx < this.cols; xx++) {
          if (opts.pin(xx, yy, this.cols, this.rows)) this.pinned[idx(xx, yy)] = 1;
        }
      }
    }
  }

  Cloth.prototype._addConstraint = function (a, b) {
    var ax = this.pos[a * 3], ay = this.pos[a * 3 + 1], az = this.pos[a * 3 + 2];
    var bx = this.pos[b * 3], by = this.pos[b * 3 + 1], bz = this.pos[b * 3 + 2];
    var dx = bx - ax, dy = by - ay, dz = bz - az;
    var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    this.constraints.push([a, b, len, 0]);
  };

  Cloth.prototype.pinRow = function (rowIndex, every) {
    every = every || 1;
    for (var x = 0; x < this.cols; x += every) {
      this.pinned[this.idx(x, rowIndex)] = 1;
    }
    return this;
  };

  Cloth.prototype.pinPoint = function (x, y) {
    this.pinned[this.idx(x, y)] = 1;
    return this;
  };

  Cloth.prototype.unpinPoint = function (x, y) {
    this.pinned[this.idx(x, y)] = 0;
    return this;
  };

  Cloth.prototype.setPinPosition = function (x, y, px, py, pz) {
    var i = this.idx(x, y) * 3;
    this.pos[i] = px; this.pos[i + 1] = py; this.pos[i + 2] = pz;
    this.prev[i] = px; this.prev[i + 1] = py; this.prev[i + 2] = pz;
    return this;
  };

  /**
   * Advance the simulation by one step.
   * colliders: optional array of { pos: {x,y,z}, half: {x,y,z} } box colliders
   * wind: optional { x, y, z } force applied every unpinned point
   */
  Cloth.prototype.step = function (colliders, wind) {
    var n = this.cols * this.rows;
    var pos = this.pos, prev = this.prev, pinned = this.pinned;
    var g = this.gravity, drag = this.drag;
    var wx = wind ? (wind.x || 0) : 0;
    var wy = wind ? (wind.y || 0) : 0;
    var wz = wind ? (wind.z || 0) : 0;

    for (var i = 0; i < n; i++) {
      if (pinned[i]) continue;
      var ix = i * 3, iy = ix + 1, iz = ix + 2;
      var x = pos[ix], y = pos[iy], z = pos[iz];
      var vx = (x - prev[ix]) * drag + wx;
      var vy = (y - prev[iy]) * drag + g + wy;
      var vz = (z - prev[iz]) * drag + wz;
      prev[ix] = x; prev[iy] = y; prev[iz] = z;
      pos[ix] = x + vx; pos[iy] = y + vy; pos[iz] = z + vz;
    }

    var constraints = this.constraints;
    var tearSens = this.tearSensitivity;

    for (var iter = 0; iter < this.iterations; iter++) {
      for (var c = 0; c < constraints.length; c++) {
        var con = constraints[c];
        if (con[3]) continue; // broken
        var a = con[0], b = con[1], restLen = con[2];
        var ax = a * 3, bx = b * 3;
        var dx = pos[bx] - pos[ax];
        var dy = pos[bx + 1] - pos[ax + 1];
        var dz = pos[bx + 2] - pos[ax + 2];
        var dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.0001;

        if (tearSens && dist > restLen * tearSens) {
          con[3] = 1;
          continue;
        }

        var diff = (restLen - dist) / dist * 0.5;
        var offx = dx * diff, offy = dy * diff, offz = dz * diff;
        if (!pinned[a]) { pos[ax] -= offx; pos[ax + 1] -= offy; pos[ax + 2] -= offz; }
        if (!pinned[b]) { pos[bx] += offx; pos[bx + 1] += offy; pos[bx + 2] += offz; }
      }

      if (colliders && colliders.length) {
        this._resolveColliders(colliders);
      }
    }
  };

  Cloth.prototype._resolveColliders = function (colliders) {
    var n = this.cols * this.rows;
    var pos = this.pos, pinned = this.pinned;
    var skin = 0.06;

    for (var p = 0; p < n; p++) {
      if (pinned[p]) continue;
      var pxI = p * 3;
      var px = pos[pxI], py = pos[pxI + 1], pz = pos[pxI + 2];

      for (var cIdx = 0; cIdx < colliders.length; cIdx++) {
        var col = colliders[cIdx];
        var half = col.half;
        var cx = col.pos.x, cy = col.pos.y, cz = col.pos.z;
        var lx = px - cx, ly = py - cy, lz = pz - cz;

        if (Math.abs(lx) < half.x + skin && Math.abs(ly) < half.y + skin && Math.abs(lz) < half.z + skin) {
          var ox = half.x + skin - Math.abs(lx);
          var oy = half.y + skin - Math.abs(ly);
          var oz = half.z + skin - Math.abs(lz);
          if (ox < oy && ox < oz) {
            pos[pxI] = cx + (lx < 0 ? -1 : 1) * (half.x + skin);
          } else if (oy < oz) {
            pos[pxI + 1] = cy + (ly < 0 ? -1 : 1) * (half.y + skin);
          } else {
            pos[pxI + 2] = cz + (lz < 0 ? -1 : 1) * (half.z + skin);
          }
        }
      }
    }
  };

  /** Simple ground-plane clamp at y = floorY (default 0). Call after step() if desired. */
  Cloth.prototype.clampFloor = function (floorY) {
    floorY = floorY || 0;
    var n = this.cols * this.rows;
    for (var p = 0; p < n; p++) {
      var iy = p * 3 + 1;
      if (this.pos[iy] < floorY) this.pos[iy] = floorY;
    }
    return this;
  };

  // ---- Three.js mesh binding ----

  function buildGeometry(THREE, cloth) {
    var geo = new THREE.BufferGeometry();
    var n = cloth.cols * cloth.rows;
    var positions = new Float32Array(n * 3);
    var uvs = new Float32Array(n * 2);
    var indices = [];

    for (var y = 0; y < cloth.rows; y++) {
      for (var x = 0; x < cloth.cols; x++) {
        var i = cloth.idx(x, y);
        uvs[i * 2] = x / (cloth.cols - 1);
        uvs[i * 2 + 1] = y / (cloth.rows - 1);
      }
    }

    for (var yy = 0; yy < cloth.rows - 1; yy++) {
      for (var xx = 0; xx < cloth.cols - 1; xx++) {
        var a = cloth.idx(xx, yy), b = cloth.idx(xx + 1, yy),
            c = cloth.idx(xx, yy + 1), d = cloth.idx(xx + 1, yy + 1);
        indices.push(a, c, b);
        indices.push(b, c, d);
      }
    }

    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }

  function syncGeometry(cloth, mesh) {
    var attr = mesh.geometry.getAttribute('position');
    attr.array.set(cloth.pos);
    attr.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
  }

  /**
   * DrapeMesh — a Cloth simulation bound to a THREE.Mesh, ready to add
   * to a scene. Call .update(colliders, wind) each frame.
   */
  function DrapeMesh(opts) {
    var THREE = resolveThree(opts.THREE);
    this.THREE = THREE;

    this.cloth = new Cloth({
      cols: opts.cols || 16,
      rows: opts.rows || 16,
      spacing: opts.spacing != null ? opts.spacing : 0.25,
      origin: opts.origin || { x: 0, y: 0, z: 0 },
      gravity: opts.gravity,
      drag: opts.drag,
      iterations: opts.iterations,
      tear: opts.tear,
      tearSensitivity: opts.tearSensitivity,
      shear: opts.shear,
      pin: opts.pin != null ? opts.pin : 'top',
      pinEvery: opts.pinEvery
    });

    this.geometry = buildGeometry(THREE, this.cloth);

    var material = opts.material;
    if (!material) {
      material = new THREE.MeshStandardMaterial({
        color: opts.color != null ? opts.color : 0xffffff,
        map: opts.map || null,
        side: THREE.DoubleSide,
        roughness: opts.roughness != null ? opts.roughness : 0.8,
        metalness: opts.metalness != null ? opts.metalness : 0.05
      });
    }
    this.material = material;

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.castShadow = opts.castShadow !== false;
    this.mesh.receiveShadow = opts.receiveShadow !== false;

    syncGeometry(this.cloth, this.mesh);
  }

  /** Advance physics and sync the mesh geometry. Call once per frame. */
  DrapeMesh.prototype.update = function (colliders, wind) {
    this.cloth.step(colliders, wind);
    if (this._floorY != null) this.cloth.clampFloor(this._floorY);
    syncGeometry(this.cloth, this.mesh);
    return this;
  };

  /** Enable a floor clamp at the given Y (default 0) applied every update(). */
  DrapeMesh.prototype.withFloor = function (y) {
    this._floorY = y == null ? 0 : y;
    return this;
  };

  DrapeMesh.prototype.pinRow = function (rowIndex, every) {
    this.cloth.pinRow(rowIndex, every);
    return this;
  };

  DrapeMesh.prototype.pinPoint = function (x, y) {
    this.cloth.pinPoint(x, y);
    return this;
  };

  DrapeMesh.prototype.unpinPoint = function (x, y) {
    this.cloth.unpinPoint(x, y);
    return this;
  };

  DrapeMesh.prototype.setPinPosition = function (x, y, px, py, pz) {
    this.cloth.setPinPosition(x, y, px, py, pz);
    return this;
  };

  DrapeMesh.prototype.addTo = function (scene) {
    scene.add(this.mesh);
    return this;
  };

  DrapeMesh.prototype.removeFrom = function (scene) {
    scene.remove(this.mesh);
    return this;
  };

  DrapeMesh.prototype.dispose = function () {
    this.geometry.dispose();
    if (this.material && this.material.dispose) this.material.dispose();
  };

  /** Convenience: build a { pos, half } collider from a THREE.Mesh with BoxGeometry. */
  function boxCollider(mesh) {
    var params = mesh.geometry.parameters || {};
    var w = (params.width || 1) / 2 * mesh.scale.x;
    var h = (params.height || 1) / 2 * mesh.scale.y;
    var d = (params.depth || 1) / 2 * mesh.scale.z;
    return { pos: mesh.position, half: { x: w, y: h, z: d } };
  }

  return {
    Cloth: Cloth,
    DrapeMesh: DrapeMesh,
    cloth: function (opts) { return new DrapeMesh(opts); },
    boxCollider: boxCollider
  };
});

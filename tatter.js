/*!
 * Tatter.js — fabric physics for Three.js
 * https://github.com/McMuffinLeq/tatterjs
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
    : (global.Tatter = factory());
})(this, function () {
  'use strict';

  function resolveThree(explicit) {
    var THREE = explicit || (typeof window !== 'undefined' ? window.THREE : null);
    if (!THREE) {
      throw new Error('Tatter.js: THREE.js not found. Load Three.js before Tatter.js, or pass { THREE } in options.');
    }
    return THREE;
  }

  /**
   * A single cloth simulation. Not usually constructed directly —
   * use Tatter.cloth(scene, options) instead, which also builds and
   * attaches the mesh for you.
   */
  function Cloth(opts) {
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.spacing = opts.spacing;
    this.origin = opts.origin; // {x, y, z}
    this.gravity = opts.gravity != null ? opts.gravity : -0.012;
    this.drag = opts.drag != null ? opts.drag : 0.985;
    this.iterations = opts.iterations || 12;
    // collision resolution is the expensive part of each iteration
    // (every point x every collider). Constraints benefit from more
    // iterations for stiffness, but collision converges fine with fewer —
    // running it every single constraint iteration was the biggest single
    // cost in the whole step() call. Default: roughly a third of the
    // constraint iterations, minimum 3.
    this.collisionIterations = opts.collisionIterations != null
      ? opts.collisionIterations
      : Math.max(2, Math.round(this.iterations / 4));
    this.tearSensitivity = opts.tear === false ? 0 : (opts.tearSensitivity || 2.6);
    // stretchiness: 0 = rigid (old behavior, constraints correct at full
    // strength every iteration). Higher = softer/springier — constraints
    // only partially correct each pass, so under real tension (a pinned
    // point holding up fabric that's also resting against a floor/collider,
    // for example) the unpinned area visibly stretches beyond rest length
    // instead of snapping rigidly taut. 0.35–0.6 reads as cloth-like give;
    // near 1 gets rubbery.
    this.stretchiness = opts.stretchiness != null
      ? Math.max(0, Math.min(0.95, opts.stretchiness))
      : 0.15;

    // point-vs-point thickness collision: keeps cloth from clipping
    // through itself (folds passing through nearby parts of the same
    // sheet) and, when crossCollision is on, through OTHER Tatter cloths
    // in the scene too. Off by default costs nothing; on, it's an
    // additional spatial-hash pass alongside collider resolution.
    this.selfCollision = opts.selfCollision !== false;
    this.crossCollision = opts.crossCollision !== false;
    // minimum allowed distance between two non-adjacent points before
    // they're pushed apart — defaults to a fraction of point spacing,
    // since that's the natural "thickness" scale of this grid
    this.thickness = opts.thickness != null ? opts.thickness : opts.spacing * 0.85;

    var n = this.cols * this.rows;
    this.pos = new Float32Array(n * 3);
    this.prev = new Float32Array(n * 3);
    this.pinned = new Uint8Array(n);
    this.constraints = []; // [iA, iB, restLength, broken(0/1)]
    // adjacency lookup (built as constraints are added, see
    // _addConstraint) so self-collision can skip directly-constrained
    // point pairs, which are expected to be close and shouldn't be
    // pushed apart by the thickness pass
    this._adjacencySets = [];

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

    // register with the global active-cloth list so other cloths can
    // find and collide against this one (crossCollision). See dispose().
    Cloth._active.push(this);
  }

  // global list of live Cloth instances, used for crossCollision so one
  // cloth can find and push against every other cloth currently in play
  Cloth._active = [];

  Cloth.prototype._addConstraint = function (a, b) {
    var ax = this.pos[a * 3], ay = this.pos[a * 3 + 1], az = this.pos[a * 3 + 2];
    var bx = this.pos[b * 3], by = this.pos[b * 3 + 1], bz = this.pos[b * 3 + 2];
    var dx = bx - ax, dy = by - ay, dz = bz - az;
    var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    this.constraints.push([a, b, len, 0]);
    // adjacency set used by self-collision to skip pairs that are
    // supposed to be close together (directly connected by a constraint)
    (this._adjacencySets[a] || (this._adjacencySets[a] = {}))[b] = 1;
    (this._adjacencySets[b] || (this._adjacencySets[b] = {}))[a] = 1;
  };

  /** Stop simulating and remove this cloth from the crossCollision registry.
   *  TatterMesh.dispose() calls this for you. */
  Cloth.prototype.disposeCloth = function () {
    var i = Cloth._active.indexOf(this);
    if (i !== -1) Cloth._active.splice(i, 1);
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
   * colliders: optional array of collider objects (box/sphere/cylinder/cone)
   * wind: optional { x, y, z } force applied every unpinned point
   * floorY: optional ground-plane height; if set, cloth collides with it
   *         through the same iteration loop as everything else (real
   *         stretch/tension against pins instead of a post-hoc snap)
   */
  Cloth.prototype.step = function (colliders, wind, floorY) {
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
    var stiffness = 1 - this.stretchiness; // 1 = old rigid behavior
    var collisionStartIter = this.iterations - this.collisionIterations;

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

        if (tearSens && dist > restLen * tearSens && !pinned[a] && !pinned[b]) {
          con[3] = 1;
          continue;
        }

        // a constraint touching a pinned point acts as a rigid rod (full
        // correction, ignores stretchiness) instead of the softer cloth-wide
        // stiffness — pins should feel like anchors, not like they're on
        // the end of a soft spring
        var conStiffness = (pinned[a] || pinned[b]) ? 1 : stiffness;
        var diff = (restLen - dist) / dist * 0.5 * conStiffness;
        // clamp the correction so one relaxation pass can't overshoot
        // wildly (this is what produces spikes near sparse pins, where a
        // point gets yanked hard toward a far-away anchor in one step)
        var maxCorrection = restLen * 0.5;
        if (diff > maxCorrection) diff = maxCorrection;
        else if (diff < -maxCorrection) diff = -maxCorrection;
        var offx = dx * diff, offy = dy * diff, offz = dz * diff;
        if (!pinned[a]) { pos[ax] -= offx; pos[ax + 1] -= offy; pos[ax + 2] -= offz; }
        if (!pinned[b]) { pos[bx] += offx; pos[bx + 1] += offy; pos[bx + 2] += offz; }
      }

      // collision only needs to run on the LAST few iterations, after
      // structural constraints have mostly settled — running it on every
      // single pass (the old behavior) was the single biggest cost in
      // this loop for no real accuracy gain, since early iterations get
      // overwritten by later constraint passes anyway.
      if (iter >= collisionStartIter && ((colliders && colliders.length) || floorY != null)) {
        this._resolveColliders(colliders || [], floorY);
      }
      // thickness collision: stops fabric from clipping through itself
      // (self-folding) and, if other Tatter cloths are active, through
      // them too. Also only needs the last few iterations — it's a
      // correction pass, same reasoning as collider resolution above.
      if (iter >= collisionStartIter && (this.selfCollision || this.crossCollision)) {
        this._resolveThickness();
      }
    }
  };

  Cloth.prototype._resolveColliders = function (colliders, floorY) {
    var n = this.cols * this.rows;
    var pos = this.pos, prev = this.prev, pinned = this.pinned;

    for (var p = 0; p < n; p++) {
      if (pinned[p]) continue;
      if (floorY != null) this._resolveFloor(p, floorY);
      for (var cIdx = 0; cIdx < colliders.length; cIdx++) {
        var col = colliders[cIdx];
        // set collider.enabled = false to switch collision off for that
        // object without removing it from the array (e.g. UI toggle) —
        // any collider NOT present in the colliders array passed to
        // update()/step() is already ignored by definition, since cloth
        // only tests against what you hand it. This flag is for cases
        // where you keep a stable colliders array and just want an
        // on/off switch per-object at runtime.
        if (col.enabled === false) continue;
        var type = col.type || 'box';
        if (type === 'sphere') this._resolveSphere(p, col);
        else if (type === 'cylinder') this._resolveCylinder(p, col);
        else if (type === 'cone') this._resolveCone(p, col);
        else this._resolveBox(p, col);
      }
    }
  };

  // ---- thickness collision: point-vs-point repulsion so cloth doesn't
  // clip through itself (self-collision) or through other active Tatter
  // cloths (crossCollision). Uses a spatial hash so it stays roughly
  // O(n) instead of testing every pair — only points that land in the
  // same or neighboring grid cell are ever compared.
  Cloth.prototype._buildSpatialHash = function () {
    var n = this.cols * this.rows;
    var pos = this.pos;
    var cell = this.thickness || this.spacing;
    var map = {};
    for (var i = 0; i < n; i++) {
      var ix = i * 3;
      var cx = Math.floor(pos[ix] / cell);
      var cy = Math.floor(pos[ix + 1] / cell);
      var cz = Math.floor(pos[ix + 2] / cell);
      var key = cx + ',' + cy + ',' + cz;
      (map[key] || (map[key] = [])).push(i);
    }
    this._hashCell = cell;
    return map;
  };

  Cloth.prototype._resolveThickness = function () {
    var n = this.cols * this.rows;
    var pos = this.pos, pinned = this.pinned;
    var cell = this.thickness || this.spacing;
    var minDist = this.thickness;
    var minDistSq = minDist * minDist;
    var adjacency = this._adjacencySets || [];

    var selfMap = this.selfCollision ? this._buildSpatialHash() : null;

    // gather other active cloths once per pass, if crossCollision is on
    var others = null;
    if (this.crossCollision) {
      others = [];
      for (var oc = 0; oc < Cloth._active.length; oc++) {
        var otherCloth = Cloth._active[oc];
        if (otherCloth !== this) others.push(otherCloth);
      }
    }

    for (var p = 0; p < n; p++) {
      var pxI = p * 3, pyI = pxI + 1, pzI = pxI + 2;
      var px = pos[pxI], py = pos[pyI], pz = pos[pzI];
      var pPinned = pinned[p];

      var cx = Math.floor(px / cell);
      var cy = Math.floor(py / cell);
      var cz = Math.floor(pz / cell);

      // self-collision: check the 27 neighboring cells in this cloth's hash
      if (selfMap) {
        for (var dx = -1; dx <= 1; dx++) {
          for (var dy = -1; dy <= 1; dy++) {
            for (var dz = -1; dz <= 1; dz++) {
              var bucket = selfMap[(cx + dx) + ',' + (cy + dy) + ',' + (cz + dz)];
              if (!bucket) continue;
              for (var bi = 0; bi < bucket.length; bi++) {
                var q = bucket[bi];
                if (q <= p) continue; // each pair handled once
                if (adjacency[p] && adjacency[p][q]) continue; // structurally connected, expected to be close
                this._pushApart(p, q, minDist, minDistSq, pPinned, pinned[q]);
              }
            }
          }
        }
      }

      // cross-collision: check this cloth's point against nearby points
      // in every other active cloth, using each other cloth's own
      // spatial hash (built lazily, cached for this pass) instead of a
      // brute O(n*m) scan across all of its points.
      if (others) {
        for (var oi = 0; oi < others.length; oi++) {
          var other = others[oi];
          var opos = other.pos, opinned = other.pinned;
          var otherCell = other.thickness || other.spacing;
          var crossMinDist = (minDist + otherCell) * 0.5;
          var crossMinDistSq = crossMinDist * crossMinDist;
          var otherHash = other._buildSpatialHash();
          var ocx = Math.floor(px / otherCell);
          var ocy = Math.floor(py / otherCell);
          var ocz = Math.floor(pz / otherCell);
          for (var odx = -1; odx <= 1; odx++) {
            for (var ody = -1; ody <= 1; ody++) {
              for (var odz = -1; odz <= 1; odz++) {
                var obucket = otherHash[(ocx + odx) + ',' + (ocy + ody) + ',' + (ocz + odz)];
                if (!obucket) continue;
                for (var obi = 0; obi < obucket.length; obi++) {
                  var oq = obucket[obi];
                  var oqI = oq * 3;
                  var ddx = opos[oqI] - px, ddy = opos[oqI + 1] - py, ddz = opos[oqI + 2] - pz;
                  var dSq = ddx * ddx + ddy * ddy + ddz * ddz;
                  if (dSq >= crossMinDistSq) continue;
                  var d, nx2, ny2, nz2;
                  if (dSq < 1e-12) {
                    // coincident points: same deterministic fallback as
                    // self-collision, otherwise they'd stay stuck at
                    // zero distance forever instead of separating
                    var seed2 = (p * 928371 + oq * 51749 + oi * 7919) % 1000 / 1000;
                    var theta2 = seed2 * Math.PI * 2;
                    var phi2 = ((p ^ oq) % 997) / 997 * Math.PI;
                    nx2 = Math.sin(phi2) * Math.cos(theta2);
                    ny2 = Math.cos(phi2);
                    nz2 = Math.sin(phi2) * Math.sin(theta2);
                    d = 0;
                  } else {
                    d = Math.sqrt(dSq);
                    nx2 = ddx / d; ny2 = ddy / d; nz2 = ddz / d;
                  }
                  var push2 = (crossMinDist - d) * 0.5;
                  if (!pPinned) { pos[pxI] -= nx2 * push2; pos[pyI] -= ny2 * push2; pos[pzI] -= nz2 * push2; }
                  if (!opinned[oq]) { opos[oqI] += nx2 * push2; opos[oqI + 1] += ny2 * push2; opos[oqI + 2] += nz2 * push2; }
                }
              }
            }
          }
        }
      }
    }
  };

  // shared pair-separation used by self-collision
  Cloth.prototype._pushApart = function (p, q, minDist, minDistSq, pPinned, qPinned) {
    var pos = this.pos;
    var pxI = p * 3, qxI = q * 3;
    var dx = pos[qxI] - pos[pxI];
    var dy = pos[qxI + 1] - pos[pxI + 1];
    var dz = pos[qxI + 2] - pos[pxI + 2];
    var distSq = dx * dx + dy * dy + dz * dz;
    if (distSq >= minDistSq) return;
    var dist, nx, ny, nz;
    if (distSq < 1e-12) {
      // exactly (or near-exactly) coincident points have no defined
      // direction to separate along — division by dist would be 0/0.
      // Fall back to a small deterministic offset derived from the point
      // indices so the pair still separates instead of sitting stuck at
      // zero distance forever (which is what silently caused visible
      // clipping in this exact case before).
      var seed = (p * 928371 + q * 51749) % 1000 / 1000;
      var theta = seed * Math.PI * 2;
      var phi = ((p ^ q) % 997) / 997 * Math.PI;
      nx = Math.sin(phi) * Math.cos(theta);
      ny = Math.cos(phi);
      nz = Math.sin(phi) * Math.sin(theta);
      dist = 0;
    } else {
      dist = Math.sqrt(distSq);
      nx = dx / dist; ny = dy / dist; nz = dz / dist;
    }
    var push = (minDist - dist) * 0.5;
    if (!pPinned) { pos[pxI] -= nx * push; pos[pxI + 1] -= ny * push; pos[pxI + 2] -= nz * push; }
    if (!qPinned) { pos[qxI] += nx * push; pos[qxI + 1] += ny * push; pos[qxI + 2] += nz * push; }
  };

  // ---- sphere collider: { type:'sphere', pos:{x,y,z}, radius } ----
  Cloth.prototype._resolveSphere = function (p, col) {
    var pos = this.pos, prev = this.prev;
    var skin = 0.06, friction = this.collisionFriction;
    var pxI = p * 3, pyI = pxI + 1, pzI = pxI + 2;
    var cx = col.pos.x, cy = col.pos.y, cz = col.pos.z;
    var r = col.radius + skin;

    var lx = pos[pxI] - cx, ly = pos[pyI] - cy, lz = pos[pzI] - cz;
    var distSq = lx * lx + ly * ly + lz * lz;

    if (distSq >= r * r) {
      // swept guard: sample several points along prev->pos so a fast-moving
      // point can't skip clean through the sphere in one step (a single
      // midpoint sample can still miss on a sharp near-tangent pass)
      var ppx = prev[pxI], ppy = prev[pyI], ppz = prev[pzI];
      var px0 = pos[pxI], py0 = pos[pyI], pz0 = pos[pzI];
      var hitSphere = false;
      var SPH_SAMPLES = 4;
      for (var ss = 1; ss <= SPH_SAMPLES && !hitSphere; ss++) {
        var st = ss / (SPH_SAMPLES + 1);
        var sx = (ppx + (px0 - ppx) * st) - cx;
        var sy = (ppy + (py0 - ppy) * st) - cy;
        var sz = (ppz + (pz0 - ppz) * st) - cz;
        if (sx * sx + sy * sy + sz * sz < r * r) hitSphere = true;
      }
      if (!hitSphere) return;
    }
    if (distSq < 1e-12) return;

    var dist = Math.sqrt(distSq) || 0.0001;
    var nx = lx / dist, ny = ly / dist, nz = lz / dist;
    pos[pxI] = cx + nx * r;
    pos[pyI] = cy + ny * r;
    pos[pzI] = cz + nz * r;

    this._dampTangential(pxI, pyI, pzI, nx, ny, nz, friction);
  };

  // ---- cylinder collider: { type:'cylinder', pos:{x,y,z}, radius, height }
  // axis-aligned to Y (upright), pos is the center ----
  Cloth.prototype._resolveCylinder = function (p, col) {
    var pos = this.pos, prev = this.prev;
    var skin = 0.06, friction = this.collisionFriction;
    var pxI = p * 3, pyI = pxI + 1, pzI = pxI + 2;
    var cx = col.pos.x, cy = col.pos.y, cz = col.pos.z;
    var r = col.radius + skin;
    var halfH = col.height / 2 + skin;

    var lx = pos[pxI] - cx, ly = pos[pyI] - cy, lz = pos[pzI] - cz;
    var radialSq = lx * lx + lz * lz;

    var inside = Math.abs(ly) < halfH && radialSq < r * r;

    // swept tunneling guard: sample several points along prev->pos so
    // fast motion can't skip through the cylinder entirely — a single
    // midpoint sample can still miss near the rim/cap edges
    if (!inside) {
      var ppx = prev[pxI], ppy2 = prev[pyI], ppz = prev[pzI];
      var px0 = pos[pxI], py0 = pos[pyI], pz0 = pos[pzI];
      var CYL_SAMPLES = 4;
      for (var cs = 1; cs <= CYL_SAMPLES && !inside; cs++) {
        var ct = cs / (CYL_SAMPLES + 1);
        var sy = (ppy2 + (py0 - ppy2) * ct) - cy;
        if (Math.abs(sy) >= halfH) continue;
        var sx = (ppx + (px0 - ppx) * ct) - cx;
        var sz = (ppz + (pz0 - ppz) * ct) - cz;
        if (sx * sx + sz * sz < r * r) inside = true;
      }
      if (!inside) return;
    }

    var radial = Math.sqrt(radialSq) || 0.0001;
    var overRadial = r - radial;   // how far inside the round wall
    var overTop = halfH - Math.abs(ly); // how far inside the height band

    // rim/corner case (near BOTH the cap and the wall at once): the old
    // "pick whichever is smaller" approach snapped only one axis and left
    // the point still outside the other bound — a leak exactly at the rim,
    // same failure mode as the box's flat-corner bug. Fix: when both are
    // small/close, push out along the true nearest point on the rim edge
    // (radial direction clamped to r, height clamped to halfH) instead of
    // picking a single axis.
    var nearRim = overRadial < r * 0.25 && overTop < halfH * 0.25;

    var nx = 0, ny = 0, nz = 0;
    if (nearRim) {
      var rnx = lx / radial, rnz = lz / radial;
      var capY = ly < 0 ? -halfH : halfH;
      var ddx = lx - rnx * r, ddy = ly - capY, ddz = lz - rnz * r;
      var dlen = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
      if (dlen < 1e-6) {
        nx = rnx; nz = rnz;
        pos[pxI] = cx + rnx * r; pos[pzI] = cz + rnz * r;
      } else {
        nx = ddx / dlen; ny = ddy / dlen; nz = ddz / dlen;
        pos[pxI] = cx + rnx * r + nx * skin;
        pos[pyI] = cy + capY + ny * skin;
        pos[pzI] = cz + rnz * r + nz * skin;
      }
    } else if (overTop < overRadial) {
      ny = ly < 0 ? -1 : 1;
      pos[pyI] = cy + ny * halfH;
    } else {
      nx = lx / radial; nz = lz / radial;
      pos[pxI] = cx + nx * r;
      pos[pzI] = cz + nz * r;
    }

    this._dampTangential(pxI, pyI, pzI, nx, ny, nz, friction);
  };

  // ---- cone collider: { type:'cone', pos:{x,y,z}, radius, height }
  // apex points up: base (widest, radius) at pos.y - height/2, apex (point)
  // at pos.y + height/2 ----
  Cloth.prototype._resolveCone = function (p, col) {
    var pos = this.pos, prev = this.prev;
    var skin = 0.06, friction = this.collisionFriction;
    var pxI = p * 3, pyI = pxI + 1, pzI = pxI + 2;
    var cx = col.pos.x, cy = col.pos.y, cz = col.pos.z;
    var baseR = col.radius, h = col.height;
    var baseY = cy - h / 2 - skin, apexY = cy + h / 2;
    var slope = baseR / h;
    var nlen = Math.sqrt(1 + slope * slope);

    function radiusAt(y) {
      var t = Math.max(0, Math.min(1, (apexY - y) / h));
      return baseR * t;
    }

    var px = pos[pxI], py = pos[pyI], pz = pos[pzI];
    var lx = px - cx, lz = pz - cz;
    var radial = Math.sqrt(lx * lx + lz * lz) || 0.0001;
    var rAtHeight = radiusAt(py) + skin;

    var insideSlant = py >= baseY && py <= apexY + skin && radial < rAtHeight;
    // the cone's own flat bottom face — without this, cloth slides under
    // the base and clips straight through since only the slanted surface
    // was ever tested before
    var insideBase = py < cy - h / 2 + skin && py > baseY && radial < baseR + skin;

    var inside = insideSlant || insideBase;

    // swept guard for fast motion skipping through in one step. A single
    // midpoint sample isn't enough near the apex, where the cone's radius
    // shrinks to nearly nothing — a point moving fast relative to that
    // narrow region can cross in and out between the start and the
    // midpoint alone. Sample several points along prev->pos instead.
    if (!inside) {
      var ppx = prev[pxI], ppy = prev[pyI], ppz = prev[pzI];
      var SWEEP_SAMPLES = 4;
      for (var s = 1; s <= SWEEP_SAMPLES && !inside; s++) {
        var t = s / (SWEEP_SAMPLES + 1);
        var sx = ppx + (px - ppx) * t;
        var sy = ppy + (py - ppy) * t;
        var sz = ppz + (pz - ppz) * t;
        if (sy < baseY || sy > apexY + skin) continue;
        var slx = sx - cx, slz = sz - cz;
        var sRadial = Math.sqrt(slx * slx + slz * slz);
        if (sRadial < radiusAt(sy) + skin) inside = true;
      }
      if (!inside) return;
    }

    var nx = 0, ny = 0, nz = 0;

    if (insideBase && !insideSlant) {
      // resolve straight down through the flat base
      ny = -1;
      pos[pyI] = baseY;
    } else {
      var rnx = lx / radial, rnz = lz / radial;
      var nearBaseEdge = (py - (cy - h / 2)) < h * 0.15 && (rAtHeight - radial) < rAtHeight * 0.3;
      if (nearBaseEdge) {
        // rim between the slant and the flat base — push out to the
        // nearest point on that rim circle rather than picking one axis,
        // same corner-leak fix as the box/cylinder cases
        var edgeY = cy - h / 2;
        var ddx = lx - rnx * baseR, ddy = py - edgeY, ddz = lz - rnz * baseR;
        var dlen = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
        if (dlen < 1e-6) {
          nx = rnx; nz = rnz;
          pos[pxI] = cx + rnx * baseR; pos[pzI] = cz + rnz * baseR;
        } else {
          nx = ddx / dlen; ny = ddy / dlen; nz = ddz / dlen;
          pos[pxI] = cx + rnx * baseR + nx * skin;
          pos[pyI] = edgeY + ny * skin;
          pos[pzI] = cz + rnz * baseR + nz * skin;
        }
      } else {
        nx = rnx / nlen; nz = rnz / nlen; ny = slope / nlen;
        pos[pxI] = cx + rnx * rAtHeight;
        pos[pzI] = cz + rnz * rAtHeight;
      }
    }

    this._dampTangential(pxI, pyI, pzI, nx, ny, nz, friction);
  };

  // shared: split velocity into normal/tangential, kill normal (no bounce),
  // damp tangential (lets cloth slide/slump off instead of sticking)
  Cloth.prototype._dampTangential = function (pxI, pyI, pzI, nx, ny, nz, friction) {
    var pos = this.pos, prev = this.prev;
    var vx = pos[pxI] - prev[pxI];
    var vy = pos[pyI] - prev[pyI];
    var vz = pos[pzI] - prev[pzI];
    var vn = vx * nx + vy * ny + vz * nz;
    var tx = vx - vn * nx;
    var ty = vy - vn * ny;
    var tz = vz - vn * nz;
    prev[pxI] = pos[pxI] - tx * friction;
    prev[pyI] = pos[pyI] - ty * friction;
    prev[pzI] = pos[pzI] - tz * friction;
  };

  // friction applied to tangential (in-surface) velocity when a point rests
  // on a collider; lower = slides off more readily
  Cloth.prototype.collisionFriction = 0.35;

  Cloth.prototype._resolveBox = function (p, col) {
    var pos = this.pos, prev = this.prev;
    var skin = 0.06;
    var friction = this.collisionFriction;

    var pxI = p * 3, pyI = pxI + 1, pzI = pxI + 2;

    var half = col.half;
    var cx = col.pos.x, cy = col.pos.y, cz = col.pos.z;

    var px = pos[pxI], py = pos[pyI], pz = pos[pzI];
    var ppx = prev[pxI], ppy = prev[pyI], ppz = prev[pzI];

    var hx = half.x + skin, hy = half.y + skin, hz = half.z + skin;

    var lx = px - cx, ly = py - cy, lz = pz - cz;
    var inside = Math.abs(lx) < hx && Math.abs(ly) < hy && Math.abs(lz) < hz;

    // if not resolved as "inside" this frame, still check whether the
    // point tunneled straight through the box between prev and pos
    // (fast wind/gravity/collider motion can skip a thin box entirely
    // in one step, or skin-boundary rounding can leave a point sitting
    // exactly on the edge). Always run a swept AABB test against the
    // prev->pos segment rather than gating on a "was outside" check,
    // since that boundary comparison is float-precision-fragile.
    if (!inside) {
      var plx = ppx - cx, ply = ppy - cy, plz = ppz - cz;
      var dx = px - ppx, dy = py - ppy, dz = pz - ppz;
      var tmin = 0, tmax = 1;
      var axes = [[plx, dx, hx], [ply, dy, hy], [plz, dz, hz]];
      var hit = true;
      for (var ai = 0; ai < 3; ai++) {
        var o = axes[ai][0], d = axes[ai][1], h = axes[ai][2];
        if (Math.abs(d) < 1e-8) {
          if (o < -h || o > h) { hit = false; break; }
        } else {
          var t1 = (-h - o) / d, t2 = (h - o) / d;
          if (t1 > t2) { var tmp = t1; t1 = t2; t2 = tmp; }
          if (t1 > tmin) tmin = t1;
          if (t2 < tmax) tmax = t2;
          if (tmin > tmax) { hit = false; break; }
        }
      }
      if (hit) {
        // pull the point back to just before it entered the box,
        // then let normal resolution below push it out from there
        px = ppx + dx * tmin; py = ppy + dy * tmin; pz = ppz + dz * tmin;
        pos[pxI] = px; pos[pyI] = py; pos[pzI] = pz;
        lx = px - cx; ly = py - cy; lz = pz - cz;
        inside = true;
      }
    }

    if (!inside) return;

    var ox = hx - Math.abs(lx);
    var oy = hy - Math.abs(ly);
    var oz = hz - Math.abs(lz);

    // resting on top but near the edge (within ~15% of the far side)?
    // taper the vertical support so the point tips and slides off
    // instead of getting a hard clamp all the way to the corner.
    var onTop = oy < oz && oy < ox && ly > 0;
    if (onTop) {
      var edgeMarginX = half.x * 0.15;
      var edgeMarginZ = half.z * 0.15;
      var pastEdge = Math.abs(lx) > half.x - edgeMarginX || Math.abs(lz) > half.z - edgeMarginZ;
      if (pastEdge) return; // no support here — try next collider / let gravity take it
    }

    // corner case: when two or more penetration depths are close
    // together, snapping to a single axis (the old behavior) shoves
    // the point onto the WRONG face near true 3D corners, producing
    // visible clipping/poking-through right at box edges. Detect that
    // near-tie and push out along the true nearest-point direction
    // instead, which is always correct at corners and edges alike.
    var minO = Math.min(ox, oy, oz);
    var closeCount = (ox - minO < minO * 0.6 ? 1 : 0) +
                      (oy - minO < minO * 0.6 ? 1 : 0) +
                      (oz - minO < minO * 0.6 ? 1 : 0);
    var nearCorner = closeCount >= 2;

    var nx = 0, ny = 0, nz = 0;
    if (nearCorner) {
      // clamp to the box surface point closest to the cloth point,
      // then push out along that direction — correct at edges/corners
      var cxp = Math.max(-hx, Math.min(hx, lx));
      var cyp = Math.max(-hy, Math.min(hy, ly));
      var czp = Math.max(-hz, Math.min(hz, lz));
      var ddx = lx - cxp, ddy = ly - cyp, ddz = lz - czp;
      var dlen = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
      if (dlen < 1e-6) {
        // dead center of an edge/corner region — fall back to the
        // single largest-penetration axis rather than divide by zero
        if (ox <= oy && ox <= oz) { nx = lx < 0 ? -1 : 1; pos[pxI] = cx + nx * hx; }
        else if (oy <= oz) { ny = ly < 0 ? -1 : 1; pos[pyI] = cy + ny * hy; }
        else { nz = lz < 0 ? -1 : 1; pos[pzI] = cz + nz * hz; }
      } else {
        nx = ddx / dlen; ny = ddy / dlen; nz = ddz / dlen;
        pos[pxI] = cx + cxp + nx * skin;
        pos[pyI] = cy + cyp + ny * skin;
        pos[pzI] = cz + czp + nz * skin;
      }
    } else if (ox < oy && ox < oz) {
      nx = lx < 0 ? -1 : 1;
      pos[pxI] = cx + nx * hx;
    } else if (oy < oz) {
      ny = ly < 0 ? -1 : 1;
      pos[pyI] = cy + ny * hy;
    } else {
      nz = lz < 0 ? -1 : 1;
      pos[pzI] = cz + nz * hz;
    }

    this._dampTangential(pxI, pyI, pzI, nx, ny, nz, friction);
  };

  /** Ground-plane collision at y = floorY (default 0). Unlike the old
   *  clampFloor (a single hard Y-snap run once after all constraints
   *  settled, which is why cloth resting on the floor looked disconnected
   *  from pin tension), this now runs as a proper collider inside the same
   *  constraint/collision iteration loop as boxes/spheres/etc — so the
   *  floor and pin tension interact correctly and you get real elastic
   *  stretch in the unpinned area instead of a silent teleport. */
  Cloth.prototype._resolveFloor = function (p, floorY) {
    var pos = this.pos;
    var skin = 0.02, friction = this.collisionFriction;
    var pyI = p * 3 + 1;
    if (pos[pyI] >= floorY + skin) return;
    pos[pyI] = floorY + skin;
    this._dampTangential(p * 3, pyI, p * 3 + 2, 0, 1, 0, friction);
  };

  /** Legacy hard clamp, kept for compatibility — prefer withFloor() on
   *  TatterMesh, which now uses the proper collider path above. */
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

  // ---- optional smoothing: render at higher resolution than the physics
  // grid, interpolating the coarse simulated points with Catmull-Rom
  // splines. Physics stays cheap; the visible mesh looks dense and smooth.

  function catmullRom1D(p0, p1, p2, p3, t) {
    var t2 = t * t, t3 = t2 * t;
    return 0.5 * (
      (2 * p1) +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3
    );
  }

  // sample the coarse cloth grid at fractional (gx, gy) grid coordinates
  function sampleCloth(cloth, gx, gy, outIdx, out) {
    var cols = cloth.cols, rows = cloth.rows, pos = cloth.pos;
    var x0 = Math.floor(gx), y0 = Math.floor(gy);
    var tx = gx - x0, ty = gy - y0;

    function clampX(x) { return x < 0 ? 0 : (x > cols - 1 ? cols - 1 : x); }
    function clampY(y) { return y < 0 ? 0 : (y > rows - 1 ? rows - 1 : y); }

    var rowVals = [0, 0, 0, 0]; // per-axis interpolated rows, filled 3x below
    for (var axis = 0; axis < 3; axis++) {
      var cx = [];
      for (var iy = -1; iy <= 2; iy++) {
        var yy = clampY(y0 + iy);
        var vals = [];
        for (var ix = -1; ix <= 2; ix++) {
          var xx = clampX(x0 + ix);
          vals.push(pos[cloth.idx(xx, yy) * 3 + axis]);
        }
        cx.push(catmullRom1D(vals[0], vals[1], vals[2], vals[3], tx));
      }
      out[outIdx + axis] = catmullRom1D(cx[0], cx[1], cx[2], cx[3], ty);
    }
  }

  function buildSmoothGeometry(THREE, cloth, factor) {
    var geo = new THREE.BufferGeometry();
    var subCols = (cloth.cols - 1) * factor + 1;
    var subRows = (cloth.rows - 1) * factor + 1;
    var n = subCols * subRows;
    var positions = new Float32Array(n * 3);
    var uvs = new Float32Array(n * 2);
    var indices = [];

    for (var y = 0; y < subRows; y++) {
      for (var x = 0; x < subCols; x++) {
        var i = y * subCols + x;
        uvs[i * 2] = x / (subCols - 1);
        uvs[i * 2 + 1] = y / (subRows - 1);
      }
    }

    for (var yy = 0; yy < subRows - 1; yy++) {
      for (var xx = 0; xx < subCols - 1; xx++) {
        var a = yy * subCols + xx, b = yy * subCols + (xx + 1),
            c = (yy + 1) * subCols + xx, d = (yy + 1) * subCols + (xx + 1);
        indices.push(a, c, b);
        indices.push(b, c, d);
      }
    }

    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    geo._subCols = subCols;
    geo._subRows = subRows;
    geo._smoothFactor = factor;
    return geo;
  }

  function syncSmoothGeometry(cloth, mesh) {
    var geo = mesh.geometry;
    var subCols = geo._subCols, subRows = geo._subRows, factor = geo._smoothFactor;
    var attr = geo.getAttribute('position');
    var arr = attr.array;

    for (var y = 0; y < subRows; y++) {
      var gy = y / factor;
      for (var x = 0; x < subCols; x++) {
        var gx = x / factor;
        sampleCloth(cloth, gx, gy, (y * subCols + x) * 3, arr);
      }
    }

    attr.needsUpdate = true;
    geo.computeVertexNormals();
  }

  function syncMeshGeometry(cloth, mesh, skip) {
    // skip: recompute the visible mesh only every Nth call (default 1 = every
    // frame). Physics still steps every call — only the expensive smoothing
    // resample + normal recalculation is throttled. Cloth moves slowly
    // enough that skip 2-3 is visually indistinguishable but roughly
    // halves/thirds the CPU cost of the sync step, which is usually the
    // actual bottleneck on mobile, not the physics itself.
    skip = skip || 1;
    mesh._tatterFrame = (mesh._tatterFrame || 0) + 1;
    if (skip > 1 && (mesh._tatterFrame % skip) !== 0) return;

    if (mesh.geometry._smoothFactor) {
      syncSmoothGeometry(cloth, mesh);
    } else {
      syncGeometry(cloth, mesh);
    }
  }

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
   * TatterMesh — a Cloth simulation bound to a THREE.Mesh, ready to add
   * to a scene. Call .update(colliders, wind) each frame.
   */
  function TatterMesh(opts) {
    var THREE = resolveThree(opts.THREE);
    this.THREE = THREE;

    this.cloth = new Cloth({
      cols: opts.cols || 24,
      rows: opts.rows || 24,
      spacing: opts.spacing != null ? opts.spacing : 0.25,
      origin: opts.origin || { x: 0, y: 0, z: 0 },
      gravity: opts.gravity,
      drag: opts.drag,
      iterations: opts.iterations,
      collisionIterations: opts.collisionIterations,
      stretchiness: opts.stretchiness,
      tear: opts.tear,
      tearSensitivity: opts.tearSensitivity,
      shear: opts.shear,
      pin: opts.pin != null ? opts.pin : 'top',
      pinEvery: opts.pinEvery,
      selfCollision: opts.selfCollision,
      crossCollision: opts.crossCollision,
      thickness: opts.thickness
    });

    // smooth: N (integer >= 2) renders a Catmull-Rom-interpolated mesh
    // at N times the density, so the surface looks smooth and dense
    // without making the physics simulation itself more expensive.
    // Defaults ON at 3x so cloth looks smooth even if the caller
    // doesn't pass the option. Pass smooth: false or smooth: 1 to
    // render at raw physics-grid resolution instead.
    this.smoothFactor = (opts.smooth === false || opts.smooth === 1)
      ? 0
      : Math.floor(opts.smooth && opts.smooth > 1 ? opts.smooth : 3);
    this.geometry = this.smoothFactor
      ? buildSmoothGeometry(THREE, this.cloth, this.smoothFactor)
      : buildGeometry(THREE, this.cloth);

    var material = opts.material;
    if (!material) {
      material = new THREE.MeshStandardMaterial({
        color: opts.color != null ? opts.color : 0xffffff,
        map: opts.map || null,
        side: THREE.DoubleSide,
        roughness: opts.roughness != null ? opts.roughness : 0.65,
        metalness: opts.metalness != null ? opts.metalness : 0.05,
        flatShading: false
      });
    } else if ('flatShading' in material) {
      // shade-smooth guarantee: even a caller-supplied material won't
      // render faceted, since normals are always smoothed below anyway
      material.flatShading = false;
      material.needsUpdate = true;
    }
    this.material = material;

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.castShadow = opts.castShadow !== false;
    this.mesh.receiveShadow = opts.receiveShadow !== false;
    // Throttles the smoothing resample + normal recompute (the expensive
    // per-frame CPU work) to every Nth update() call. Physics still steps
    // every call regardless. Default 2 — halves that cost with motion
    // still reading as smooth. Set to 1 for max fidelity, higher (3-4) if
    // it's still choppy on your device.
    this.meshSkip = opts.meshSkip != null ? opts.meshSkip : 2;
    // NOTE: cloth folds onto itself constantly. If it receives its own
    // shadow with no bias, you'll see a fine rippled/striped artifact
    // under directional light ("shadow acne"). Fix this on your light,
    // not here: light.shadow.bias = -0.002 (and/or
    // light.shadow.normalBias = 0.02) typically clears it up.

    syncMeshGeometry(this.cloth, this.mesh);
  }

  /** Advance physics and sync the mesh geometry. Call once per frame.
   *  Set tatter.meshSkip = N to throttle the expensive smoothing/normals
   *  resync to every Nth call (physics itself still steps every call).
   *  Default 1 (every frame).
   */
  TatterMesh.prototype.update = function (colliders, wind) {
    this.cloth.step(colliders, wind, this._floorY);
    syncMeshGeometry(this.cloth, this.mesh, this.meshSkip || 1);
    return this;
  };

  /** Enable floor collision at the given Y (default 0), applied every
   *  update(). Runs as a proper collider inside the physics iteration
   *  loop, so cloth resting on it shows real elastic stretch against
   *  whatever's pinning it, instead of a disconnected hard snap. */
  TatterMesh.prototype.withFloor = function (y) {
    this._floorY = y == null ? 0 : y;
    return this;
  };

  TatterMesh.prototype.pinRow = function (rowIndex, every) {
    this.cloth.pinRow(rowIndex, every);
    return this;
  };

  TatterMesh.prototype.pinPoint = function (x, y) {
    this.cloth.pinPoint(x, y);
    return this;
  };

  TatterMesh.prototype.unpinPoint = function (x, y) {
    this.cloth.unpinPoint(x, y);
    return this;
  };

  TatterMesh.prototype.setPinPosition = function (x, y, px, py, pz) {
    this.cloth.setPinPosition(x, y, px, py, pz);
    return this;
  };

  TatterMesh.prototype.addTo = function (scene) {
    scene.add(this.mesh);
    return this;
  };

  TatterMesh.prototype.removeFrom = function (scene) {
    scene.remove(this.mesh);
    return this;
  };

  TatterMesh.prototype.dispose = function () {
    this.cloth.disposeCloth();
    this.geometry.dispose();
    if (this.material && this.material.dispose) this.material.dispose();
  };

  /** Convenience: build a { pos, half } collider from a THREE.Mesh with BoxGeometry. */
  function boxCollider(mesh) {
    var params = mesh.geometry.parameters || {};
    var w = (params.width || 1) / 2 * mesh.scale.x;
    var h = (params.height || 1) / 2 * mesh.scale.y;
    var d = (params.depth || 1) / 2 * mesh.scale.z;
    return { type: 'box', pos: mesh.position, half: { x: w, y: h, z: d } };
  }

  /** Convenience: build a { pos, radius } collider from a THREE.Mesh with SphereGeometry. */
  function sphereCollider(mesh) {
    var params = mesh.geometry.parameters || {};
    var r = (params.radius != null ? params.radius : 1) *
      Math.max(mesh.scale.x, mesh.scale.y, mesh.scale.z);
    return { type: 'sphere', pos: mesh.position, radius: r };
  }

  /** Convenience: build a { pos, radius, height } collider from a THREE.Mesh
   *  with CylinderGeometry (upright, Y-axis). Uses radiusTop for the radius. */
  function cylinderCollider(mesh) {
    var params = mesh.geometry.parameters || {};
    var r = (params.radiusTop != null ? params.radiusTop : 1) * mesh.scale.x;
    var h = (params.height != null ? params.height : 1) * mesh.scale.y;
    return { type: 'cylinder', pos: mesh.position, radius: r, height: h };
  }

  /** Convenience: build a { pos, radius, height } collider from a THREE.Mesh
   *  with ConeGeometry (apex up, Y-axis). */
  function coneCollider(mesh) {
    var params = mesh.geometry.parameters || {};
    var r = (params.radius != null ? params.radius : 1) * mesh.scale.x;
    var h = (params.height != null ? params.height : 1) * mesh.scale.y;
    return { type: 'cone', pos: mesh.position, radius: r, height: h };
  }

  /**
   * Turbulent air wind helper — call once per frame with a running time
   * value and get back a { x, y, z } force to pass into update()/step(),
   * instead of hand-rolling sine waves. Layers a few different-frequency
   * sines per axis plus occasional random gusts so it reads as air
   * moving, not a metronome.
   *
   * wind(t, opts) opts:
   *   strength   base force magnitude (default 0.006)
   *   direction  primary push direction, normalized internally (default {x:1,y:0,z:0.3})
   *   gustiness  0-1, how much random gust variance on top of the base (default 0.4)
   *   turbulence 0-1, how much extra high-frequency wobble (default 0.5)
   */
  function wind(t, opts) {
    opts = opts || {};
    var strength = opts.strength != null ? opts.strength : 0.006;
    var dir = opts.direction || { x: 1, y: 0, z: 0.3 };
    var gustiness = opts.gustiness != null ? opts.gustiness : 0.4;
    var turbulence = opts.turbulence != null ? opts.turbulence : 0.5;

    var dlen = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z) || 1;
    var dx = dir.x / dlen, dy = dir.y / dlen, dz = dir.z / dlen;

    // layered sines: slow gust envelope + faster turbulent wobble
    var gust = 1 + gustiness * (
      Math.sin(t * 0.7) * 0.5 +
      Math.sin(t * 0.23 + 1.7) * 0.35 +
      Math.sin(t * 1.9 + 4.1) * 0.15
    );
    var turbX = turbulence * Math.sin(t * 2.3 + 0.5) * 0.4;
    var turbY = turbulence * Math.sin(t * 3.1 + 2.2) * 0.15; // gentle vertical flutter
    var turbZ = turbulence * Math.cos(t * 1.7 + 1.1) * 0.4;

    var mag = strength * Math.max(0, gust);
    return {
      x: dx * mag + turbX * strength,
      y: dy * mag + turbY * strength,
      z: dz * mag + turbZ * strength
    };
  }

  return {
    Cloth: Cloth,
    TatterMesh: TatterMesh,
    cloth: function (opts) { return new TatterMesh(opts); },
    boxCollider: boxCollider,
    sphereCollider: sphereCollider,
    cylinderCollider: cylinderCollider,
    coneCollider: coneCollider,
    wind: wind
  };
});

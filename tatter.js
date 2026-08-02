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

  // ---- collider motion tracking, keyed by the collider's `pos` object ----
  // FIX (silent tunneling regression): swept-collision tests need to know
  // how far a collider moved since last frame. The original approach
  // stashed `_prevPos` directly on the collider object returned by
  // boxCollider()/sphereCollider()/etc. That works ONLY if the caller
  // reuses the same collider object across frames — but the natural,
  // common pattern (and the one used in this library's own example
  // scenes) is to call `Tatter.boxCollider(mesh)` fresh every frame,
  // since primitive colliders are meant to be cheap to rebuild. A fresh
  // object has no `_prevPos`, so it's reset to the CURRENT position every
  // single frame, the computed delta is always zero, and the fast-mover
  // tunneling guard silently does nothing — exactly the corner/edge
  // clipping this was meant to prevent.
  //
  // Fix: track previous position in a WeakMap keyed by `col.pos` itself
  // (e.g. a THREE.Mesh's `.position` object) rather than by the
  // collider wrapper. `col.pos` is the one thing that IS stable across
  // frames even when the wrapping collider object is rebuilt, since it's
  // normally just `mesh.position` — the same live reference every call.
  var _colliderPrevPos = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;
  function _trackColliderDelta(col) {
    var cx = col.pos.x, cy = col.pos.y, cz = col.pos.z;
    if (!_colliderPrevPos) return { dx: 0, dy: 0, dz: 0 };
    var key = col.pos;
    var prev = _colliderPrevPos.get(key);
    if (!prev) {
      _colliderPrevPos.set(key, { x: cx, y: cy, z: cz });
      return { dx: 0, dy: 0, dz: 0 };
    }
    var dx = cx - prev.x, dy = cy - prev.y, dz = cz - prev.z;
    prev.x = cx; prev.y = cy; prev.z = cz;
    return { dx: dx, dy: dy, dz: dz };
  }

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
  // Collision skin margin — extra buffer distance kept between cloth
  // points and box/sphere/cylinder/cone collider surfaces, to smooth
  // out corner/edge push-out jitter (the same idea as Blender's "Min
  // Distance" on its cloth collision panel).
  //
  // FIX (visible gap / inaccurate collision): this was previously a
  // FLAT constant (0.16 world units) added to every collider's size,
  // regardless of the collider's own scale. That's fine for a large
  // object where 0.16 is imperceptible, but for a small-to-medium
  // object (e.g. a 1.4-unit box, half-width 0.7) it added roughly 20%+
  // to the effective collision size — cloth would visibly react to
  // empty space well before the real surface, reading as "the cloth is
  // colliding with something that isn't there yet." A margin meant only
  // to smooth corner jitter should never be a large fraction of the
  // object it's wrapping.
  //
  // Fixed to scale with each collider's own size: a small fraction of
  // its smallest relevant dimension, clamped to a sane absolute range
  // so it neither vanishes on tiny colliders nor overshoots on huge
  // ones. Call skinFor(col, refSize) at each resolver's collision
  // point rather than reading one shared global.
  var COLLISION_SKIN_MIN = 0.008; // floor, so it never fully vanishes and corners still get a little smoothing
  var COLLISION_SKIN_MAX = 0.05;  // ceiling, so even a huge collider doesn't get a coarse-looking margin
  var COLLISION_SKIN_FRACTION = 0.03; // ~3% of the collider's own reference size
  function skinFor(refSize) {
    var s = Math.abs(refSize) * COLLISION_SKIN_FRACTION;
    if (s < COLLISION_SKIN_MIN) return COLLISION_SKIN_MIN;
    if (s > COLLISION_SKIN_MAX) return COLLISION_SKIN_MAX;
    return s;
  }
  // kept for any external code still referencing the old constant name;
  // no longer used internally by the resolvers below.
  var COLLISION_SKIN = COLLISION_SKIN_MIN;

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
    //
    // FIX (perf): this previously defaulted to ON (`opts.selfCollision
    // !== false`), contradicting this very comment and silently costing
    // every scene an extra O(n) spatial-hash pass per frame even for a
    // simple single sheet that never folds onto itself — typically the
    // single biggest avoidable cost in step(). Most cloth (a flag, a
    // curtain, a sheet draped over/around a moving shape) doesn't need
    // self-collision at all; opt in explicitly with `selfCollision: true`
    // / `crossCollision: true` if your cloth actually folds over itself
    // or needs to interact with other Tatter cloths in the scene.
    this.selfCollision = opts.selfCollision === true;
    this.crossCollision = opts.crossCollision === true;
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

    // shape: optional function(x, y, cols, rows) -> {x,y,z} | null.
    // Lets the grid be remapped onto ANY custom outline or 3D surface
    // instead of the default flat rectangle — a disc, a star, a draped
    // surface sampled off a custom model, whatever. Returning null for a
    // given cell marks it "inactive": it gets no constraints and is
    // permanently pinned in place at the origin, effectively removing it
    // from the simulated shape without changing the fixed cols*rows
    // point-count layout everything else in this file assumes. See
    // Tatter.shapes.* and TatterMesh.fromMesh() for ready-made shape
    // functions covering the common cases.
    var shapeFn = typeof opts.shape === 'function' ? opts.shape : null;
    this.active = shapeFn ? new Uint8Array(this.cols * this.rows) : null;

    for (var y = 0; y < this.rows; y++) {
      for (var x = 0; x < this.cols; x++) {
        var i = idx(x, y);
        var px, py, pz;
        if (shapeFn) {
          var sp = shapeFn(x, y, this.cols, this.rows);
          if (sp) {
            this.active[i] = 1;
            px = sp.x; py = sp.y; pz = sp.z;
          } else {
            // inactive cell: park it at the grid origin and pin it so it
            // never moves or gets rendered as flapping fabric; syncGeometry
            // below simply won't draw triangles that touch it (see
            // buildGeometry's active-aware indexing)
            px = this.origin.x; py = this.origin.y; pz = this.origin.z;
          }
        } else {
          px = this.origin.x + x * this.spacing;
          py = this.origin.y;
          pz = this.origin.z + y * this.spacing;
        }
        this.pos[i * 3] = px; this.pos[i * 3 + 1] = py; this.pos[i * 3 + 2] = pz;
        this.prev[i * 3] = px; this.prev[i * 3 + 1] = py; this.prev[i * 3 + 2] = pz;
        if (shapeFn && !this.active[i]) this.pinned[i] = 1;
      }
    }

    // helper: is a cell active (part of the shape)? Always true when no
    // shape function was given (plain rectangular cloth, unchanged behavior)
    function cellActive(x, y) {
      return !self.active || self.active[idx(x, y)];
    }
    this.cellActive = cellActive;

    for (var y2 = 0; y2 < this.rows; y2++) {
      for (var x2 = 0; x2 < this.cols; x2++) {
        if (!cellActive(x2, y2)) continue;
        if (x2 < this.cols - 1 && cellActive(x2 + 1, y2)) this._addConstraint(idx(x2, y2), idx(x2 + 1, y2));
        if (y2 < this.rows - 1 && cellActive(x2, y2 + 1)) this._addConstraint(idx(x2, y2), idx(x2, y2 + 1));
        // shear constraints — keeps the mesh from collapsing into a diamond, reads as real fabric
        if (opts.shear !== false && x2 < this.cols - 1 && y2 < this.rows - 1) {
          if (cellActive(x2 + 1, y2 + 1)) this._addConstraint(idx(x2, y2), idx(x2 + 1, y2 + 1));
          if (cellActive(x2 + 1, y2) && cellActive(x2, y2 + 1)) this._addConstraint(idx(x2 + 1, y2), idx(x2, y2 + 1));
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

    // FIX (corner tunneling regression): compute each collider's
    // frame-to-frame motion delta exactly ONCE here, before any point
    // is resolved against it, and stash the result on the collider
    // object as `_frameDelta` for the rest of this step() call to read.
    //
    // Previously each resolver (_resolveBox, _resolveSphere, etc.)
    // called _trackColliderDelta(col) itself, directly inline during
    // collision resolution — which runs once per POINT, per collision
    // ITERATION, and (for box/mesh) TWICE per call for extra corner
    // correction. That's potentially thousands of calls to
    // _trackColliderDelta within a single step(), and that function
    // immediately overwrites its stored "previous position" on every
    // call — so only the very FIRST call anywhere in the whole frame
    // ever saw a real nonzero delta; every other call that frame saw
    // delta ≈ 0, silently disabling the fast-mover tunneling guard for
    // the rest of the frame. This was most visible at box corners
    // specifically because _resolveBox's second (corner-cleanup) call
    // always landed after the delta had already been zeroed by the
    // first, so the extra corner pass had no swept protection at all.
    if (colliders && colliders.length) {
      for (var dci = 0; dci < colliders.length; dci++) {
        var dcol = colliders[dci];
        if (dcol.enabled === false || !dcol.pos) continue;
        dcol._frameDelta = _trackColliderDelta(dcol);
      }
    }

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

    // BUGFIX: _resolveThickness (self/cross-cloth collision) runs AFTER
    // collider resolution every iteration above, and it has zero
    // awareness of colliders — it only pushes points apart based on
    // fabric-to-fabric distance. That means it can shove a point that
    // was just correctly resolved against a box corner back inside the
    // box, on the very last iteration, with nothing after it to catch
    // the re-penetration — this is what read as "clipping through
    // corners": the corner push-out logic was firing and computing the
    // right answer, then getting silently overwritten. Give colliders
    // the guaranteed last word with one final pass.
    if ((colliders && colliders.length) || floorY != null) {
      this._resolveColliders(colliders || [], floorY);
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
        else if (type === 'capsule') this._resolveCapsule(p, col);
        else if (type === 'plane') this._resolvePlaneCollider(p, col);
        else if (type === 'mesh') {
          // arbitrary shape / custom model: same "resolve twice" treatment
          // as box, for the same reason — closest-triangle push-out can
          // undershoot on a single pass near sharp features (corners of a
          // custom model are just as common as box corners).
          this._resolveMesh(p, col);
          this._resolveMesh(p, col);
        }
        else {
          // box: corner/edge penetration can be deep enough that a
          // single push-out (sized by `skin`) undershoots and leaves a
          // small residual overlap — literature on cloth collision
          // consistently notes that even slightly-under-resolved
          // penetration is visible as a lingering clip. Re-run once
          // more immediately so a corner point gets a second, smaller
          // corrective pass against its now-closer-to-correct position
          // in the same frame, instead of waiting for the next
          // iteration (which structural constraints could disturb
          // again before collision gets another turn).
          this._resolveBox(p, col);
          this._resolveBox(p, col);
        }
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

    // gather other active cloths AND pre-build each of their spatial
    // hashes ONCE per call (not once per point!). The old code called
    // other._buildSpatialHash() inside the per-point loop below, which
    // rebuilt a full O(n) hash for every point on this cloth times every
    // other cloth times every collision iteration — by far the biggest
    // cost in the whole step for any scene with crossCollision on and
    // more than one cloth. The other cloth's points don't move between
    // those rebuilds within a single _resolveThickness() call, so one
    // hash per other-cloth per call is correct and dramatically cheaper.
    var others = null;
    var othersHashes = null;
    if (this.crossCollision) {
      others = [];
      othersHashes = [];
      for (var oc = 0; oc < Cloth._active.length; oc++) {
        var otherCloth = Cloth._active[oc];
        if (otherCloth !== this) {
          others.push(otherCloth);
          othersHashes.push(otherCloth._buildSpatialHash());
        }
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
          var otherHash = othersHashes[oi];
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
    var skin = skinFor(col.radius), friction = this.collisionFriction;
    var pxI = p * 3, pyI = pxI + 1, pzI = pxI + 2;
    var cx = col.pos.x, cy = col.pos.y, cz = col.pos.z;
    var r = col.radius + skin;

    var lx = pos[pxI] - cx, ly = pos[pyI] - cy, lz = pos[pzI] - cz;
    var distSq = lx * lx + ly * ly + lz * lz;

    if (distSq >= r * r) {
      // swept guard: sample several points along prev->pos so a fast-moving
      // point can't skip clean through the sphere in one step (a single
      // midpoint sample can still miss on a sharp near-tangent pass).
      // Also expand the effective radius by how far the SPHERE ITSELF
      // moved this frame — a fast-moving collider can displace by more
      // than its own radius in one step, which the point-only sampling
      // above can't catch on its own (same root cause as the box
      // tunneling bug: fast collider motion, not just fast point
      // motion). Delta is computed ONCE per frame in step(), not here —
      // see the _resolveBox comment for why recomputing it per-call
      // was silently broken.
      var colDelta = col._frameDelta || { dx: 0, dy: 0, dz: 0 };
      var colMoveMag = Math.sqrt(colDelta.dx * colDelta.dx + colDelta.dy * colDelta.dy + colDelta.dz * colDelta.dz);
      var sweptR = r + colMoveMag;
      var ppx = prev[pxI], ppy = prev[pyI], ppz = prev[pzI];
      var px0 = pos[pxI], py0 = pos[pyI], pz0 = pos[pzI];
      var hitSphere = false;
      var SPH_SAMPLES = 4;
      for (var ss = 1; ss <= SPH_SAMPLES && !hitSphere; ss++) {
        var st = ss / (SPH_SAMPLES + 1);
        var sx = (ppx + (px0 - ppx) * st) - cx;
        var sy = (ppy + (py0 - ppy) * st) - cy;
        var sz = (ppz + (pz0 - ppz) * st) - cz;
        if (sx * sx + sy * sy + sz * sz < sweptR * sweptR) hitSphere = true;
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
    var skin = skinFor(col.radius), friction = this.collisionFriction;
    var pxI = p * 3, pyI = pxI + 1, pzI = pxI + 2;
    var cx = col.pos.x, cy = col.pos.y, cz = col.pos.z;
    var r = col.radius + skin;
    var halfH = col.height / 2 + skin;

    var lx = pos[pxI] - cx, ly = pos[pyI] - cy, lz = pos[pzI] - cz;
    var radialSq = lx * lx + lz * lz;

    var inside = Math.abs(ly) < halfH && radialSq < r * r;

    // swept tunneling guard: sample several points along prev->pos so
    // fast motion can't skip through the cylinder entirely — a single
    // midpoint sample can still miss near the rim/cap edges. Also
    // account for the CYLINDER's own motion this frame (same root
    // cause as the box/sphere tunneling fixes: a fast-moving collider,
    // not just a fast-moving point, can skip past a point-only test).
    if (!inside) {
      var colDelta = col._frameDelta || { dx: 0, dy: 0, dz: 0 };
      var sweptR = r + Math.sqrt(colDelta.dx * colDelta.dx + colDelta.dz * colDelta.dz);
      var sweptHalfH = halfH + Math.abs(colDelta.dy);
      var ppx = prev[pxI], ppy2 = prev[pyI], ppz = prev[pzI];
      var px0 = pos[pxI], py0 = pos[pyI], pz0 = pos[pzI];
      var CYL_SAMPLES = 4;
      for (var cs = 1; cs <= CYL_SAMPLES && !inside; cs++) {
        var ct = cs / (CYL_SAMPLES + 1);
        var sy = (ppy2 + (py0 - ppy2) * ct) - cy;
        if (Math.abs(sy) >= sweptHalfH) continue;
        var sx = (ppx + (px0 - ppx) * ct) - cx;
        var sz = (ppz + (pz0 - ppz) * ct) - cz;
        if (sx * sx + sz * sz < sweptR * sweptR) inside = true;
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
    var skin = skinFor(col.radius), friction = this.collisionFriction;
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

  // ---- capsule collider: { type:'capsule', pointA:{x,y,z}, pointB:{x,y,z}, radius }
  // a cylinder with hemispherical caps, defined by its central segment —
  // covers most "rounded" character-limb-style shapes without needing a
  // full mesh collider ----
  Cloth.prototype._resolveCapsule = function (p, col) {
    var pos = this.pos, prev = this.prev;
    var skin = skinFor(col.radius), friction = this.collisionFriction;
    var pxI = p * 3, pyI = pxI + 1, pzI = pxI + 2;
    var ax = col.pointA.x, ay = col.pointA.y, az = col.pointA.z;
    var bx = col.pointB.x, by = col.pointB.y, bz = col.pointB.z;
    var r = col.radius + skin;

    var abx = bx - ax, aby = by - ay, abz = bz - az;
    var abLenSq = abx * abx + aby * aby + abz * abz || 1e-12;

    function closestOnSegment(qx, qy, qz) {
      var apx = qx - ax, apy = qy - ay, apz = qz - az;
      var t = (apx * abx + apy * aby + apz * abz) / abLenSq;
      t = t < 0 ? 0 : (t > 1 ? 1 : t);
      return { x: ax + abx * t, y: ay + aby * t, z: az + abz * t };
    }

    var px = pos[pxI], py = pos[pyI], pz = pos[pzI];
    var cpt = closestOnSegment(px, py, pz);
    var lx = px - cpt.x, ly = py - cpt.y, lz = pz - cpt.z;
    var distSq = lx * lx + ly * ly + lz * lz;
    var inside = distSq < r * r;

    // swept guard, same reasoning as sphere/cylinder above
    if (!inside) {
      var ppx = prev[pxI], ppy = prev[pyI], ppz = prev[pzI];
      var CAP_SAMPLES = 4;
      for (var s = 1; s <= CAP_SAMPLES && !inside; s++) {
        var t = s / (CAP_SAMPLES + 1);
        var sx = ppx + (px - ppx) * t;
        var sy = ppy + (py - ppy) * t;
        var sz = ppz + (pz - ppz) * t;
        var scpt = closestOnSegment(sx, sy, sz);
        var dx2 = sx - scpt.x, dy2 = sy - scpt.y, dz2 = sz - scpt.z;
        if (dx2 * dx2 + dy2 * dy2 + dz2 * dz2 < r * r) inside = true;
      }
      if (!inside) return;
      cpt = closestOnSegment(pos[pxI], pos[pyI], pos[pzI]);
      lx = pos[pxI] - cpt.x; ly = pos[pyI] - cpt.y; lz = pos[pzI] - cpt.z;
      distSq = lx * lx + ly * ly + lz * lz;
    }
    if (distSq < 1e-12) return;

    var dist = Math.sqrt(distSq);
    var nx = lx / dist, ny = ly / dist, nz = lz / dist;
    pos[pxI] = cpt.x + nx * r;
    pos[pyI] = cpt.y + ny * r;
    pos[pzI] = cpt.z + nz * r;

    this._dampTangential(pxI, pyI, pzI, nx, ny, nz, friction);
  };

  // ---- infinite plane collider: { type:'plane', pos:{x,y,z}, normal:{x,y,z} }
  // like withFloor()'s Y=const plane, but at any position/orientation —
  // useful for ramps, walls, or a tilted table edge ----
  Cloth.prototype._resolvePlaneCollider = function (p, col) {
    var pos = this.pos;
    var skin = skinFor(0), friction = this.collisionFriction; // infinite plane has no natural size to scale against — use the floor margin
    var pxI = p * 3, pyI = pxI + 1, pzI = pxI + 2;
    var nx = col.normal.x, ny = col.normal.y, nz = col.normal.z;
    var nlen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= nlen; ny /= nlen; nz /= nlen;

    var lx = pos[pxI] - col.pos.x, ly = pos[pyI] - col.pos.y, lz = pos[pzI] - col.pos.z;
    var d = lx * nx + ly * ny + lz * nz;
    if (d >= skin) return;

    var push = skin - d;
    pos[pxI] += nx * push; pos[pyI] += ny * push; pos[pzI] += nz * push;
    this._dampTangential(pxI, pyI, pzI, nx, ny, nz, friction);
  };

  // ---- generic mesh collider: { type:'mesh', triangles: Float32Array,
  // pos, quaternion, scale } — collide against ANY shape, including
  // custom models and arbitrary meshes, not just the hand-coded
  // primitives above. Build one with Tatter.meshCollider(threeMesh).
  //
  // Approach: closest point on the triangle soup (world-space, cached
  // per-collider so a static model doesn't re-transform every point every
  // frame — see meshCollider()/refreshMeshCollider() below), spatial-hashed
  // by triangle centroid so a point only tests nearby triangles instead of
  // all of them. Push out along the surface normal at that closest point,
  // with a normal-sign flip if the point is found to be behind the surface
  // (inside the shape) so concave dips resolve outward correctly too.
  Cloth.prototype._resolveMesh = function (p, col) {
    var pos = this.pos, prev = this.prev;
    // scale skin to the mesh collider's own bounding-box size (smallest
    // dimension), same reasoning as the primitive resolvers below —
    // was previously the flat COLLISION_SKIN constant, which visibly
    // over- or under-sized the margin for meshes far from that
    // constant's original reference scale.
    var refSize = 0.3;
    if (col.bounds) {
      var b = col.bounds;
      refSize = Math.min(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z) / 2;
    }
    var skin = skinFor(refSize), friction = this.collisionFriction;
    var pxI = p * 3, pyI = pxI + 1, pzI = pxI + 2;

    var hit = this._closestOnMeshCollider(col, pos[pxI], pos[pyI], pos[pzI]);
    if (!hit) return;

    // NOTE: this previously also checked `hit.distSq < (col.radius0 ||
    // 0)`, but col.radius0 was never assigned anywhere in this file —
    // that branch was permanently dead (always compared against 0).
    // Dropped it; the signedDist check below is the real, working test.
    var inside = hit.signedDist < skin;

    if (!inside) {
      // swept guard: a fast-moving point can hop clean past a thin custom
      // shape between prev and pos, same failure mode as the primitives
      var ppx = prev[pxI], ppy = prev[pyI], ppz = prev[pzI];
      var px0 = pos[pxI], py0 = pos[pyI], pz0 = pos[pzI];
      var MESH_SAMPLES = 4;
      for (var s = 1; s <= MESH_SAMPLES && !inside; s++) {
        var t = s / (MESH_SAMPLES + 1);
        var sx = ppx + (px0 - ppx) * t;
        var sy = ppy + (py0 - ppy) * t;
        var sz = ppz + (pz0 - ppz) * t;
        var shit = this._closestOnMeshCollider(col, sx, sy, sz);
        if (shit && shit.signedDist < skin) inside = true;
      }
      if (!inside) return;
      hit = this._closestOnMeshCollider(col, pos[pxI], pos[pyI], pos[pzI]);
      if (!hit) return;
    }

    var nx = hit.nx, ny = hit.ny, nz = hit.nz;
    pos[pxI] = hit.x + nx * skin;
    pos[pyI] = hit.y + ny * skin;
    pos[pzI] = hit.z + nz * skin;

    this._dampTangential(pxI, pyI, pzI, nx, ny, nz, friction);
  };

  // finds the closest point on col's triangle soup to (qx,qy,qz), using
  // col's spatial hash (built/cached by meshCollider) to only check nearby
  // triangles. Returns { x,y,z (closest point), nx,ny,nz (outward normal,
  // sign-corrected), distSq, signedDist } or null if col has no triangles
  // within search range (shouldn't normally happen for a closed shape).
  Cloth.prototype._closestOnMeshCollider = function (col, qx, qy, qz) {
    var hash = col._hash;
    if (!hash) return null;
    var cell = col._hashCell;
    var cx = Math.floor(qx / cell), cy = Math.floor(qy / cell), cz = Math.floor(qz / cell);

    var best = null, bestDistSq = Infinity;
    // Candidates within this fraction of the best distance are treated as
    // tied and their normals averaged, rather than keeping only whichever
    // one happened to be iterated last (hash bucket order is otherwise
    // arbitrary). This matters most right at shared vertices/edges between
    // adjacent triangles — the single most common "closest point" case for
    // any real mesh, since a point is far more likely to land near a seam
    // than dead-center in a single triangle's interior — where two or more
    // triangles legitimately tie on distance but disagree on face normal.
    var TIE_EPS = 1e-6;
    var accNx = 0, accNy = 0, accNz = 0, tieCount = 0;
    var bestCp = null, bestSigned = 0;

    // expand the search radius outward one ring at a time until we find
    // at least one triangle, so points further from the surface than one
    // cell (e.g. deep tunneling) still resolve instead of silently missing
    for (var ring = 1; ring <= 3; ring++) {
      for (var dx = -ring; dx <= ring; dx++) {
        for (var dy = -ring; dy <= ring; dy++) {
          for (var dz = -ring; dz <= ring; dz++) {
            if (ring > 1 && Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) < ring) continue;
            var bucket = hash[(cx + dx) + ',' + (cy + dy) + ',' + (cz + dz)];
            if (!bucket) continue;
            for (var bi = 0; bi < bucket.length; bi++) {
              var tri = bucket[bi];
              var cp = closestPointOnTriangle(
                qx, qy, qz,
                tri.ax, tri.ay, tri.az, tri.bx, tri.by, tri.bz, tri.cx, tri.cy, tri.cz
              );
              var ddx = qx - cp.x, ddy = qy - cp.y, ddz = qz - cp.z;
              var dSq = ddx * ddx + ddy * ddy + ddz * ddz;
              // signed distance to THIS triangle's plane (dot of the
              // surface-to-point vector with the face normal): negative
              // means the query point is on the far/inside side of this
              // triangle's winding — i.e. penetrating. Used below to
              // classify inside/outside; the PUSH direction is always the
              // triangle's own stored normal as-is (assumes consistent
              // outward winding across the source mesh, same assumption
              // every other collider here makes about its own geometry).
              var signedHere = ddx * tri.nx + ddy * tri.ny + ddz * tri.nz;
              var faceNx = tri.nx, faceNy = tri.ny, faceNz = tri.nz;

              if (dSq < bestDistSq - TIE_EPS) {
                // clear new winner: reset the tie accumulator to just this one
                bestDistSq = dSq;
                bestCp = cp;
                bestSigned = signedHere;
                accNx = faceNx; accNy = faceNy; accNz = faceNz; tieCount = 1;
              } else if (dSq < bestDistSq + TIE_EPS) {
                // tied with (or marginally closer than) the current best:
                // fold this triangle's outward normal into the running
                // average instead of discarding it
                if (dSq < bestDistSq) { bestDistSq = dSq; bestCp = cp; bestSigned = signedHere; }
                accNx += faceNx; accNy += faceNy; accNz += faceNz; tieCount++;
              }
            }
          }
        }
      }
      if (tieCount) break;
    }

    if (!tieCount) return null;

    var alen = Math.sqrt(accNx * accNx + accNy * accNy + accNz * accNz) || 1e-8;
    var fdlen = Math.sqrt(bestDistSq) || 1e-8;
    best = {
      x: bestCp.x, y: bestCp.y, z: bestCp.z,
      // averaged, renormalized outward normal across all tied triangles —
      // stable at flat seams (all faces agree, average = same direction)
      // and gives a sensible blended push-out at genuine creases/corners
      nx: accNx / alen, ny: accNy / alen, nz: accNz / alen,
      distSq: bestDistSq,
      signedDist: bestSigned < 0 ? -fdlen : fdlen
    };
    return best;
  };

  // closest point on triangle ABC to point P — standard region-test
  // implementation (Ericson, "Real-Time Collision Detection" 5.1.5)
  function closestPointOnTriangle(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
    var abx = bx - ax, aby = by - ay, abz = bz - az;
    var acx = cx - ax, acy = cy - ay, acz = cz - az;
    var apx = px - ax, apy = py - ay, apz = pz - az;

    var d1 = abx * apx + aby * apy + abz * apz;
    var d2 = acx * apx + acy * apy + acz * apz;
    if (d1 <= 0 && d2 <= 0) return { x: ax, y: ay, z: az };

    var bpx = px - bx, bpy = py - by, bpz = pz - bz;
    var d3 = abx * bpx + aby * bpy + abz * bpz;
    var d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) return { x: bx, y: by, z: bz };

    var vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
      var v1 = d1 / (d1 - d3);
      return { x: ax + abx * v1, y: ay + aby * v1, z: az + abz * v1 };
    }

    var cpx = px - cx, cpy = py - cy, cpz = pz - cz;
    var d5 = abx * cpx + aby * cpy + abz * cpz;
    var d6 = acx * cpx + acy * cpy + acz * cpz;
    if (d6 >= 0 && d5 <= d6) return { x: cx, y: cy, z: cz };

    var vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
      var w1 = d2 / (d2 - d6);
      return { x: ax + acx * w1, y: ay + acy * w1, z: az + acz * w1 };
    }

    var va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
      var w2 = (d4 - d3) / ((d4 - d3) + (d5 - d6));
      return { x: bx + (cx - bx) * w2, y: by + (cy - by) * w2, z: bz + (cz - bz) * w2 };
    }

    var denom = 1 / (va + vb + vc);
    var v = vb * denom, w = vc * denom;
    return { x: ax + abx * v + acx * w, y: ay + aby * v + acy * w, z: az + abz * v + acz * w };
  }

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
    var half = col.half;
    var skin = skinFor(Math.min(half.x, half.y, half.z));
    var friction = this.collisionFriction;

    var pxI = p * 3, pyI = pxI + 1, pzI = pxI + 2;

    var cx = col.pos.x, cy = col.pos.y, cz = col.pos.z;

    var px = pos[pxI], py = pos[pyI], pz = pos[pzI];
    var ppx = prev[pxI], ppy = prev[pyI], ppz = prev[pzI];

    var hx = half.x + skin, hy = half.y + skin, hz = half.z + skin;

    // FIX (tunneling with fast-moving colliders): the swept test below
    // only ever accounted for how far the CLOTH POINT moved between
    // prev/pos. A collider that itself moves fast (e.g. a block swept
    // back and forth every frame) can displace by more than its own
    // half-width in one step — the point can end up "outside" the box
    // at both the old and new collider position, so the point-only
    // swept test never sees a crossing at all and cloth clips straight
    // through. Fold the collider's this-frame displacement (computed
    // ONCE up front in step(), see _frameDelta there — NOT recomputed
    // here, which used to silently zero out on every call after the
    // first one in the frame and broke corner correction specifically)
    // into the effective half-extents used for the swept test, so a
    // fast-moving box is also covered, not just a fast-moving point.
    // This only affects the SWEPT test region — the final resting
    // push-out below still uses the true hx/hy/hz.
    var colDelta = col._frameDelta || { dx: 0, dy: 0, dz: 0 };
    var shx = hx + Math.abs(colDelta.dx), shy = hy + Math.abs(colDelta.dy), shz = hz + Math.abs(colDelta.dz);

    var lx = px - cx, ly = py - cy, lz = pz - cz;
    var inside = Math.abs(lx) < hx && Math.abs(ly) < hy && Math.abs(lz) < hz;

    // if not resolved as "inside" this frame, still check whether the
    // point tunneled straight through the box between prev and pos —
    // OR the box tunneled through the point, now covered by the
    // expanded shx/shy/shz above. (Fast wind/gravity/collider motion
    // can skip a thin box entirely in one step, or skin-boundary
    // rounding can leave a point sitting exactly on the edge.) Always
    // run a swept AABB test against the prev->pos segment rather than
    // gating on a "was outside" check, since that boundary comparison
    // is float-precision-fragile.
    if (!inside) {
      var plx = ppx - cx, ply = ppy - cy, plz = ppz - cz;
      var dx = px - ppx, dy = py - ppy, dz = pz - ppz;
      var tmin = 0, tmax = 1;
      var axes = [[plx, dx, shx], [ply, dy, shy], [plz, dz, shz]];
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
    var closeCount = (ox - minO < minO * 0.35 ? 1 : 0) +
                      (oy - minO < minO * 0.35 ? 1 : 0) +
                      (oz - minO < minO * 0.35 ? 1 : 0);
    var nearCorner = closeCount >= 2;

    var nx = 0, ny = 0, nz = 0;
    if (nearCorner) {
      // clamp to the box SURFACE point closest to the cloth point, then
      // push out along that direction — correct at edges/corners.
      // NOTE: lx/ly/lz are already inside [-h,h] here (inside === true).
      // Only the axes actually part of the near-tie (small penetration
      // depth) should snap to their face; an axis NOT in the tie keeps
      // its own coordinate (a true no-op clamp), since it isn't near
      // its wall and shouldn't be pulled toward it — that's what makes
      // this correct for 2-axis edges as well as 3-axis corners.
      var xClose = ox - minO < minO * 0.35;
      var yClose = oy - minO < minO * 0.35;
      var zClose = oz - minO < minO * 0.35;
      var cxp = xClose ? (lx < 0 ? -hx : hx) : lx;
      var cyp = yClose ? (ly < 0 ? -hy : hy) : ly;
      var czp = zClose ? (lz < 0 ? -hz : hz) : lz;
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
        // skip a triangle if any corner it touches is outside a custom
        // shape's outline — otherwise a non-rectangular shape (disc,
        // star, custom model surface) would still render as a filled
        // rectangle, with the "outside" cells just sitting pinned at the
        // origin instead of being invisible like they should be
        var aOK = cloth.cellActive(xx, yy), bOK = cloth.cellActive(xx + 1, yy),
            cOK = cloth.cellActive(xx, yy + 1), dOK = cloth.cellActive(xx + 1, yy + 1);
        if (aOK && cOK && bOK) indices.push(a, c, b);
        if (bOK && cOK && dOK) indices.push(b, c, d);
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
      thickness: opts.thickness,
      shape: opts.shape
    });

    // smooth: N (integer >= 2) renders a Catmull-Rom-interpolated mesh
    // at N times the density, so the surface looks smooth and dense
    // without making the physics simulation itself more expensive.
    // Defaults ON at 3x so cloth looks smooth even if the caller
    // doesn't pass the option. Pass smooth: false or smooth: 1 to
    // render at raw physics-grid resolution instead.
    // Catmull-Rom smoothing (buildSmoothGeometry) interpolates across
    // the FULL rectangular grid — it has no concept of "inactive" cells,
    // so a custom shape's cut-out outline would get smeared back into a
    // filled rectangle. Force it off for shaped cloth regardless of what
    // was requested; pass a denser cols/rows grid instead if you need a
    // smoother-looking custom shape.
    this.smoothFactor = (opts.smooth === false || opts.smooth === 1 || this.cloth.active)
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

    // ---- optional frustum culling: skip physics + mesh sync entirely
    // when the cloth isn't in view. Off by default — opt in by passing
    // a THREE.Camera as `cullCamera`. See update() below for how the
    // actual skip decision is made each frame.
    this.cullCamera = opts.cullCamera || null;
    this._frustum = new THREE.Frustum();
    this._frustumMatrix = new THREE.Matrix4();
    this._boundingSphere = new THREE.Sphere();
    this._computeBoundingSphere();
    this._wasInView = true; // assume visible on the first frame

    syncMeshGeometry(this.cloth, this.mesh);
  }

  /** Recompute the cloth's world-space bounding sphere from its current
   *  point positions. Called once at construction; call again yourself
   *  (tatterMesh._computeBoundingSphere()) if the cloth's overall extent
   *  changes drastically at runtime (e.g. you reposition its origin far
   *  from where it started) so culling stays accurate. Ordinary drape/
   *  wind motion does NOT require this — the sphere is padded generously
   *  on purpose so normal movement stays inside it. */
  TatterMesh.prototype._computeBoundingSphere = function () {
    var pos = this.cloth.pos;
    var active = this.cloth.active; // null for a plain rectangular cloth
    var n = this.cloth.cols * this.cloth.rows;
    var minX = Infinity, minY = Infinity, minZ = Infinity;
    var maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (var i = 0; i < n; i++) {
      // custom-shape cloth parks inactive (outside the shape) points at
      // the grid origin permanently — skip them here so a sparse shape
      // (e.g. a thin star or ring) doesn't get its culling volume
      // dragged out to include that origin point unnecessarily
      if (active && !active[i]) continue;
      var ix = i * 3;
      var x = pos[ix], y = pos[ix + 1], z = pos[ix + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    var cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
    var dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
    var radius = Math.sqrt(dx * dx + dy * dy + dz * dz) / 2;
    // pad generously: cloth moves (drape, wind, pin animation) after this
    // is computed, and the sphere isn't recomputed every frame (that
    // would defeat the point of culling — recomputing needs the same
    // point-position pass the physics step already does). The pad keeps
    // normal motion from drifting the cloth outside its own culling
    // volume and popping in and out incorrectly.
    this._boundingSphere.center.set(cx, cy, cz);
    this._boundingSphere.radius = Math.max(radius, this.cloth.spacing) * 1.5 + 1;
  };

  /** Advance physics and sync the mesh geometry. Call once per frame.
   *  Set tatter.meshSkip = N to throttle the expensive smoothing/normals
   *  resync to every Nth call (physics itself still steps every call).
   *  Default 1 (every frame).
   *
   *  If cullCamera was passed at construction (or set directly via
   *  tatterMesh.cullCamera = camera), this checks the cloth's bounding
   *  sphere against that camera's view frustum first. When the cloth is
   *  fully outside the frustum, BOTH the physics step and the mesh sync
   *  are skipped entirely for this call — the point array is left
   *  exactly as it was. This is a real cost saving (not just a visual
   *  one) for scenes with several off-screen cloths, at the cost of
   *  cloth motion "freezing" while off-screen and resuming, rather than
   *  continuing to simulate silently, once it re-enters view. That's
   *  usually the right tradeoff (why pay for wind/collision on a flag
   *  behind the player's back?), but if you need cloth to keep animating
   *  off-screen (e.g. it's about to swing into view on a predictable
   *  path), don't set cullCamera and rely on meshSkip/collisionIterations
   *  instead for perf.
   */
  TatterMesh.prototype.update = function (colliders, wind) {
    if (this.cullCamera) {
      // NOTE: matrixWorldInverse is only correct if the camera's world
      // matrix has been updated THIS frame. That normally happens
      // inside renderer.render(), which typically runs AFTER
      // tatterMesh.update() in a standard animate loop — meaning by
      // default this would check against last frame's camera transform
      // (fine for a static camera, one frame stale for a moving one).
      // If your camera moves and you see culling lag by a frame,
      // call cullCamera.updateMatrixWorld() yourself right before this.
      this.cullCamera.updateMatrixWorld();
      this._frustumMatrix.multiplyMatrices(
        this.cullCamera.projectionMatrix,
        this.cullCamera.matrixWorldInverse
      );
      this._frustum.setFromProjectionMatrix(this._frustumMatrix);
      var inView = this._frustum.intersectsSphere(this._boundingSphere);
      if (!inView) {
        this._wasInView = false;
        return this; // skip physics + mesh sync entirely this frame
      }
      if (!this._wasInView) {
        // re-entering view after being culled: prev/pos can be far
        // apart if a lot of real time passed off-screen (nothing was
        // stepping prev toward pos), which would otherwise show up as
        // a sudden velocity kick on the first visible frame. Snap prev
        // to pos once so the cloth resumes calmly instead of lurching.
        this.cloth.prev.set(this.cloth.pos);
        this._wasInView = true;
      }
    }
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

  /** Convenience: build a { pointA, pointB, radius } collider from a
   *  THREE.Mesh with CapsuleGeometry (upright, Y-axis; matches THREE's
   *  own capsule orientation). If your THREE version lacks
   *  CapsuleGeometry, or the capsule is oriented some other way, build
   *  the collider object by hand instead: { type:'capsule',
   *  pointA:{x,y,z}, pointB:{x,y,z}, radius }. */
  function capsuleCollider(mesh) {
    var params = mesh.geometry.parameters || {};
    var r = (params.radius != null ? params.radius : 0.5) * mesh.scale.x;
    var halfLine = ((params.length != null ? params.length : 1) / 2) * mesh.scale.y;
    var pos = mesh.position;
    return {
      type: 'capsule',
      pointA: { x: pos.x, y: pos.y - halfLine, z: pos.z },
      pointB: { x: pos.x, y: pos.y + halfLine, z: pos.z },
      radius: r
    };
  }

  /** Build a { pos, normal } infinite-plane collider from a THREE.Mesh
   *  (uses the mesh's position and its local +Y axis rotated by its
   *  current orientation as the plane normal — the natural choice for a
   *  PlaneGeometry, which faces +Z, or any mesh you've oriented by hand). */
  function planeCollider(mesh, normal) {
    var n = normal || { x: 0, y: 1, z: 0 };
    if (mesh.quaternion) {
      var THREE = mesh.constructor && mesh.constructor.name ? null : null; // no THREE dependency needed here
      var q = mesh.quaternion;
      // rotate n by mesh quaternion manually (avoids requiring a THREE.Vector3 import in this helper)
      var x = n.x, y = n.y, z = n.z;
      var qx = q.x, qy = q.y, qz = q.z, qw = q.w;
      var ix = qw * x + qy * z - qz * y;
      var iy = qw * y + qz * x - qx * z;
      var iz = qw * z + qx * y - qy * x;
      var iw = -qx * x - qy * y - qz * z;
      n = {
        x: ix * qw + iw * -qx + iy * -qz - iz * -qy,
        y: iy * qw + iw * -qy + iz * -qx - ix * -qz,
        z: iz * qw + iw * -qz + ix * -qy - iy * -qx
      };
    }
    return { type: 'plane', pos: mesh.position, normal: n };
  }

  /** Build a { type:'mesh' } collider from ANY THREE.Mesh — a custom
   *  model, a loaded GLTF, a capsule/torus/whatever primitive THREE
   *  ships that isn't box/sphere/cylinder/cone, or hand-authored
   *  BufferGeometry. This is the "custom shapes and models" collider:
   *  cloth will drape and collide against the mesh's actual triangle
   *  surface, not an approximation.
   *
   *  Cost note: this bakes the mesh's WORLD-SPACE triangles into a
   *  spatial hash once, here, not every frame — so it's cheap to collide
   *  against repeatedly but the bake itself (O(triangle count)) is
   *  comparatively expensive for a very dense mesh. For a static model,
   *  call this once. For a model that moves/rotates/scales at runtime,
   *  call refreshMeshCollider(collider, mesh) after moving it (see below)
   *  rather than rebuilding a new collider from scratch each frame.
   *
   *  opts.maxTriangles caps how many triangles are used (default 5000) —
   *  denser source meshes are randomly subsampled with a fixed seed so
   *  the result is deterministic across calls. High-poly collision
   *  meshes rarely help visually (skin margin already smooths over
   *  small-scale detail) and directly cost frame time, so simplify your
   *  source geometry (e.g. a decimated collision proxy) rather than
   *  relying on this cap for anything but a safety ceiling.
   */
  function meshCollider(mesh, opts) {
    opts = opts || {};
    var col = { type: 'mesh', enabled: opts.enabled !== false };
    refreshMeshCollider(col, mesh, opts.maxTriangles || 5000);
    return col;
  }

  /** Re-bake a mesh collider's world-space triangles and spatial hash
   *  from its source THREE.Mesh's CURRENT transform. Call this after
   *  moving, rotating, or scaling a mesh you built a collider from with
   *  meshCollider() — the collider does not track the mesh live on its
   *  own, since re-baking every point every frame would be far more
   *  expensive than the primitives above for no benefit on mostly-static
   *  set dressing. For a mesh that moves every frame, call this once per
   *  frame (it's still much cheaper than rebuilding from scratch, since
   *  it reuses the same triangle-index sampling). */
  function refreshMeshCollider(col, mesh, maxTriangles) {
    var geo = mesh.geometry;
    if (!geo.attributes || !geo.attributes.position) {
      throw new Error('Tatter.js: meshCollider requires geometry with a position attribute.');
    }
    mesh.updateMatrixWorld(true);
    var m = mesh.matrixWorld;
    var posAttr = geo.attributes.position;
    var indexAttr = geo.index;
    var triCount = indexAttr ? indexAttr.count / 3 : posAttr.count / 3;

    maxTriangles = maxTriangles || 5000;
    var stride = triCount > maxTriangles ? Math.ceil(triCount / maxTriangles) : 1;

    function vertexAt(i) {
      var vi = indexAttr ? indexAttr.getX(i) : i;
      var x = posAttr.getX(vi), y = posAttr.getY(vi), z = posAttr.getZ(vi);
      // transform to world space using the mesh's current matrix, so the
      // baked collider matches wherever the mesh actually is/was posed
      var wx = m.elements[0] * x + m.elements[4] * y + m.elements[8] * z + m.elements[12];
      var wy = m.elements[1] * x + m.elements[5] * y + m.elements[9] * z + m.elements[13];
      var wz = m.elements[2] * x + m.elements[6] * y + m.elements[10] * z + m.elements[14];
      return { x: wx, y: wy, z: wz };
    }

    var cell = 0, cellSamples = 0;
    var triangles = [];
    var minX = Infinity, minY = Infinity, minZ = Infinity;
    var maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (var t = 0; t < triCount; t += stride) {
      var a = vertexAt(t * 3), b = vertexAt(t * 3 + 1), c = vertexAt(t * 3 + 2);
      var abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
      var acx = c.x - a.x, acy = c.y - a.y, acz = c.z - a.z;
      // face normal via cross product; degenerate (zero-area) triangles
      // are skipped so they can't produce a NaN/garbage normal that
      // would otherwise poison the nearest-triangle search
      var nx = aby * acz - abz * acy;
      var ny = abz * acx - abx * acz;
      var nz = abx * acy - aby * acx;
      var nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (nlen < 1e-10) continue;
      nx /= nlen; ny /= nlen; nz /= nlen;

      triangles.push({
        ax: a.x, ay: a.y, az: a.z,
        bx: b.x, by: b.y, bz: b.z,
        cx: c.x, cy: c.y, cz: c.z,
        nx: nx, ny: ny, nz: nz
      });

      var edgeLen = Math.sqrt(abx * abx + aby * aby + abz * abz);
      if (edgeLen > 0) { cell += edgeLen; cellSamples++; }
      minX = Math.min(minX, a.x, b.x, c.x); maxX = Math.max(maxX, a.x, b.x, c.x);
      minY = Math.min(minY, a.y, b.y, c.y); maxY = Math.max(maxY, a.y, b.y, c.y);
      minZ = Math.min(minZ, a.z, b.z, c.z); maxZ = Math.max(maxZ, a.z, b.z, c.z);
    }

    // hash cell size ~= average triangle edge length, clamped to a sane
    // range — this is the same "bucket by natural scale" idea the
    // self-collision spatial hash already uses (see _buildSpatialHash)
    var avgEdge = cellSamples ? cell / cellSamples : 1;
    var hashCell = Math.max(avgEdge * 1.5, 0.05);

    var hash = {};
    for (var ti = 0; ti < triangles.length; ti++) {
      var tri = triangles[ti];
      var tcx = (tri.ax + tri.bx + tri.cx) / 3;
      var tcy = (tri.ay + tri.by + tri.cy) / 3;
      var tcz = (tri.az + tri.bz + tri.cz) / 3;
      var kx = Math.floor(tcx / hashCell), ky = Math.floor(tcy / hashCell), kz = Math.floor(tcz / hashCell);
      var key = kx + ',' + ky + ',' + kz;
      (hash[key] || (hash[key] = [])).push(tri);
    }

    col.triangles = triangles;
    col._hash = hash;
    col._hashCell = hashCell;
    col.bounds = { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
    return col;
  }

  // ---- ready-made `shape` functions for Tatter.cloth({ shape: ... }) ----
  // Each returns a function(x, y, cols, rows) -> {x,y,z}|null suitable for
  // the Cloth `shape` option, so the simulated grid takes on a
  // non-rectangular outline instead of the default flat rectangle.
  var shapes = {
    /** Flat circular/elliptical disc lying in the XZ plane. radius (or
     *  radiusX/radiusZ for an ellipse) in world units, centered on origin. */
    circle: function (opts) {
      opts = opts || {};
      var rx = opts.radiusX != null ? opts.radiusX : (opts.radius != null ? opts.radius : 2);
      var rz = opts.radiusZ != null ? opts.radiusZ : (opts.radius != null ? opts.radius : 2);
      var origin = opts.origin || { x: 0, y: 0, z: 0 };
      return function (x, y, cols, rows) {
        var u = (x / (cols - 1)) * 2 - 1; // -1..1
        var v = (y / (rows - 1)) * 2 - 1;
        if (u * u + v * v > 1) return null;
        return { x: origin.x + u * rx, y: origin.y, z: origin.z + v * rz };
      };
    },
    /** Flat annulus/ring (disc with a hole) in the XZ plane. innerRadius
     *  and outerRadius as a fraction of the grid's half-extent (0-1). */
    ring: function (opts) {
      opts = opts || {};
      var outerR = opts.outerRadius != null ? opts.outerRadius : 2;
      var innerFrac = opts.innerRadius != null ? opts.innerRadius / outerR : 0.4;
      var origin = opts.origin || { x: 0, y: 0, z: 0 };
      return function (x, y, cols, rows) {
        var u = (x / (cols - 1)) * 2 - 1;
        var v = (y / (rows - 1)) * 2 - 1;
        var d = Math.sqrt(u * u + v * v);
        if (d > 1 || d < innerFrac) return null;
        return { x: origin.x + u * outerR, y: origin.y, z: origin.z + v * outerR };
      };
    },
    /** Flat shape from an arbitrary polygon outline (array of {x,z}
     *  points, e.g. a star, a logo silhouette, anything) — grid cells
     *  whose (u,v) position falls outside the polygon are dropped. Uses
     *  standard even-odd ray casting for point-in-polygon. The polygon
     *  is expected in the same -1..1 normalized space the grid maps to;
     *  pass `scale` to size it up to world units. */
    polygon: function (opts) {
      opts = opts || {};
      var pts = opts.points;
      if (!pts || pts.length < 3) {
        throw new Error('Tatter.js: shapes.polygon requires opts.points, an array of 3+ {x,z} pairs.');
      }
      var scale = opts.scale != null ? opts.scale : 2;
      var origin = opts.origin || { x: 0, y: 0, z: 0 };
      function pointInPolygon(px, pz) {
        var inside = false;
        for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          var xi = pts[i].x, zi = pts[i].z, xj = pts[j].x, zj = pts[j].z;
          var intersects = ((zi > pz) !== (zj > pz)) &&
            (px < (xj - xi) * (pz - zi) / (zj - zi) + xi);
          if (intersects) inside = !inside;
        }
        return inside;
      }
      return function (x, y, cols, rows) {
        var u = (x / (cols - 1)) * 2 - 1;
        var v = (y / (rows - 1)) * 2 - 1;
        if (!pointInPolygon(u, v)) return null;
        return { x: origin.x + u * scale, y: origin.y, z: origin.z + v * scale };
      };
    }
  };

  /** Build a shape function that samples a custom THREE.Mesh/model's
   *  actual surface, for draping cloth over (or generating cloth IN THE
   *  SHAPE of) an arbitrary model — a cape conforming to a character's
   *  shoulders, a tarp over irregular terrain, a flag that starts flush
   *  against a custom flagpole cap, etc.
   *
   *  How it works: casts rays straight down (-Y, in the mesh's local
   *  space) from a height above the mesh's bounding box at each grid
   *  (x,y) cell, using THREE.Raycaster against the mesh's geometry, and
   *  places that grid point at the hit (offset outward along the hit
   *  normal by `opts.offset`, default a small gap so the cloth starts
   *  just above the surface rather than exactly on it, which would
   *  immediately register as a collision if you also pass this same mesh
   *  as a collider). Cells that don't hit the surface are left inactive
   *  (null) — so a non-convex/irregular model naturally produces a
   *  cloth outline matching its silhouette from above, same idea as
   *  shapes.polygon but derived from a real 3D surface instead of a
   *  hand-authored outline.
   *
   *  This only works for surfaces where "drop a point straight down onto
   *  it" makes sense (roughly convex-from-above, like terrain, a table,
   *  a character's back/shoulders) — for wrap-around draping over a
   *  fully enclosed shape, use meshCollider() as a collider instead and
   *  let a normal flat cloth fall onto and settle around it dynamically,
   *  which handles arbitrary topology correctly since it's real physics
   *  rather than a one-shot projection.
   */
  function shapeFromMesh(mesh, opts) {
    opts = opts || {};
    var THREE = resolveThree(opts.THREE);
    mesh.updateMatrixWorld(true);
    var box = new THREE.Box3().setFromObject(mesh);
    var offset = opts.offset != null ? opts.offset : 0.05;
    var rayHeight = box.max.y - box.min.y + 1;
    var raycaster = new THREE.Raycaster();
    var down = new THREE.Vector3(0, -1, 0);

    return function (x, y, cols, rows) {
      var u = x / (cols - 1); // 0..1
      var v = y / (rows - 1);
      var wx = box.min.x + u * (box.max.x - box.min.x);
      var wz = box.min.z + v * (box.max.z - box.min.z);
      raycaster.set(new THREE.Vector3(wx, box.max.y + rayHeight, wz), down);
      var hits = raycaster.intersectObject(mesh, false);
      if (!hits.length) return null;
      var hit = hits[0];
      return {
        x: hit.point.x + (hit.face ? hit.face.normal.x * offset : 0),
        y: hit.point.y + (hit.face ? hit.face.normal.y * offset : offset),
        z: hit.point.z + (hit.face ? hit.face.normal.z * offset : 0)
      };
    };
  }

  /** Build a TatterMesh whose shape/topology is derived from a custom
   *  THREE.Mesh/model, via shapeFromMesh() above — the "drape cloth over
   *  a custom model" entry point. All other TatterMesh options (material,
   *  pin, wind, etc) still apply; this just supplies `shape` for you.
   *  For "cloth collides against a custom model" (the more common case —
   *  a flag near a statue, a cape brushing past a shoulder) use
   *  Tatter.meshCollider(mesh) as a normal collider instead; use this
   *  only when you want the cloth's resting shape itself to start
   *  conformed to the model's surface. */
  TatterMesh.fromMesh = function (source, opts) {
    opts = opts || {};
    var shapeOpts = { THREE: opts.THREE, offset: opts.offset };
    var built = Object.create(opts);
    built.shape = shapeFromMesh(source, shapeOpts);
    return new TatterMesh(built);
  };

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
    capsuleCollider: capsuleCollider,
    planeCollider: planeCollider,
    meshCollider: meshCollider,
    refreshMeshCollider: refreshMeshCollider,
    shapes: shapes,
    fromMesh: function (source, opts) { return TatterMesh.fromMesh(source, opts); },
    wind: wind
  };
});

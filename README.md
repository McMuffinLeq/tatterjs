# Tatter.js

Fabric physics for Three.js. Verlet-integration cloth simulation in a single JS file — give it a scene, get back a mesh with real gravity, wind, rigid pinning, tearing, elastic stretch, self-collision, cross-cloth collision, and collision (box, sphere, cylinder, cone, and floor) with realistic sliding, edge falloff, and tunneling-proof, corner-accurate resolution.

## Requirements

Three.js, loaded before tatter.js (as a global `THREE`, or passed in explicitly). No other dependencies.

## Usage

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
<script src="tatter.js"></script>
<script>
  const flag = Tatter.cloth({
    cols: 24,
    rows: 24,
    spacing: 0.18,
    origin: { x: 0, y: 3, z: 0 },
    pin: 'top',       // pin the whole top row
    color: 0xff5c7a,
    smooth: 3,         // smooth Catmull-Rom mesh, on by default
    stretchiness: 0.3  // elastic give under tension, see below
  });

  flag.addTo(scene);
  flag.withFloor(0);   // collide with a ground plane at y = 0

  let t = 0;
  function animate() {
    requestAnimationFrame(animate);
    t += 0.016;
    const wind = Tatter.wind(t, { strength: 0.007 }); // turbulent air wind
    flag.update(null, wind); // colliders, wind
    renderer.render(scene, camera);
  }
  animate();
</script>
```

Collide against other meshes in your scene:

```js
const colliders = [
  Tatter.boxCollider(myBoxMesh),
  Tatter.sphereCollider(mySphereMesh),
  Tatter.cylinderCollider(myCylinderMesh),
  Tatter.coneCollider(myConeMesh)
];
flag.update(colliders, wind);
```

Three more collider types beyond the primitives above:

```js
Tatter.capsuleCollider(myCapsuleMesh); // from THREE.CapsuleGeometry (upright, Y-axis)
Tatter.planeCollider(myPlaneMesh);     // infinite plane, normal from the mesh's orientation
Tatter.meshCollider(myCustomMesh);     // any mesh — custom models, loaded GLTFs, decimated proxies
```

- **`capsuleCollider(mesh)`** — reads `radius`/`length` off `CapsuleGeometry`. If your THREE version lacks `CapsuleGeometry`, or the capsule needs a different orientation, build the collider object by hand instead: `{ type: 'capsule', pointA: {x,y,z}, pointB: {x,y,z}, radius }`.
- **`planeCollider(mesh, normal)`** — an infinite plane at the mesh's position. `normal` defaults to `{x:0,y:1,z:0}` and is rotated by the mesh's current quaternion, so a rotated `PlaneGeometry` collides along the direction it's actually facing.
- **`meshCollider(mesh, opts)`** — collides against a mesh's real triangle surface instead of an approximation: custom models, loaded GLTFs, or any non-primitive geometry. World-space triangles are baked into a spatial hash once at call time, not every frame, so it's cheap to collide against repeatedly. `opts.maxTriangles` (default `5000`) caps how many triangles are used — denser meshes are deterministically subsampled; simplify your source geometry (a decimated collision proxy) rather than relying on this as anything but a safety ceiling. For a mesh that moves, rotates, or scales at runtime, call `Tatter.refreshMeshCollider(collider, mesh)` after moving it each frame, rather than rebuilding a new collider from scratch — the collider does not track the source mesh's transform on its own.

Turn collision off for one object at runtime without removing it from the array:

```js
someCollider.enabled = false; // cloth passes straight through until re-enabled
```

## Options

| Option                         | Default            | Description                                                                              |
| ------------------------------- | ------------------ | ----------------------------------------------------------------------------------------- |
| `cols` / `rows`                | `24`                | Grid resolution of the cloth (physics grid — see `smooth` for render density)             |
| `spacing`                      | `0.25`              | Distance between physics points                                                          |
| `origin`                       | `{x:0,y:0,z:0}`     | World position of the cloth's top-left point                                             |
| `gravity`                      | `-0.012`            | Downward force per step                                                                   |
| `drag`                         | `0.985`             | Velocity damping                                                                          |
| `iterations`                   | `12`                | Constraint solver passes per step (higher = stiffer cloth)                                |
| `collisionIterations`          | `~iterations / 4`   | How many of the *last* constraint iterations also resolve collision. Lower = faster, less accurate against fast motion. See **Performance** below. |
| `stretchiness`                 | `0.15`              | `0` = rigid (old behavior). Higher = softer/springier constraints, so fabric under real tension (e.g. pinned at the top, resting on a floor below) visibly stretches instead of snapping taut or teleporting. `0.3–0.6` reads as cloth-like give. Only affects constraints between two unpinned points — see **Pinning** below. |
| `shear`                        | `true`              | Diagonal constraints for a fabric-like drape instead of a diamond collapse                |
| `tear`                         | `true`              | Whether constraints can break under stress                                                |
| `tearSensitivity`              | `2.6`               | Stretch multiplier before a constraint tears                                              |
| `selfCollision`                | `true`              | Point-vs-point thickness collision within this cloth, so folds don't clip through nearby parts of the same sheet. See **Self- and cross-cloth collision** below. |
| `crossCollision`               | `true`              | Point-vs-point thickness collision against every other active `Tatter.cloth()` in the scene, so two separate cloths don't pass through each other. See **Self- and cross-cloth collision** below. |
| `thickness`                    | `spacing * 0.85`    | Minimum allowed distance between two non-adjacent points before `selfCollision`/`crossCollision` push them apart. Roughly "how thick the fabric feels." |
| `pin`                          | `'top'`             | `'top'`, `'corners'`, a function `(x, y, cols, rows) => bool`, or `false` for no pinning. Pinned points connect to their neighbors as rigid rods — see **Pinning** below. |
| `pinEvery`                     | `1`                 | With `pin: 'top'`, pin every Nth point along the row                                     |
| `smooth`                       | `3`                 | Renders a Catmull-Rom-smoothed mesh at N× the physics grid density. Pass `false` or `1` for raw grid-resolution rendering. |
| `meshSkip`                     | `2`                 | Only resync/re-smooth the visible mesh every Nth `update()` call; physics still steps every call. Raise for more FPS, lower (`1`) for max fidelity. |
| `cullCamera`                   | `null`              | Opt-in frustum culling. Pass a `THREE.Camera` and `update()` skips BOTH the physics step and mesh sync entirely whenever the cloth's bounding sphere is outside that camera's view — a real cost saving for off-screen cloth, not just a visual one. See **Frustum culling** below. |
| `color` / `map`                | `0xffffff`          | Material color or texture                                                                 |
| `roughness` / `metalness`      | `0.65` / `0.05`     | Material PBR params                                                                       |
| `castShadow` / `receiveShadow` | `true`              | Shadow settings on the generated mesh                                                     |

## Collision behavior

All collider types (box, sphere, cylinder, cone, floor) share the same collision core:

- **Tunneling-proof**: if a point would move straight through a collider in a single step (fast wind, gravity, a fast-moving collider, or just a low frame rate producing big per-step jumps), a swept check samples several points along that step's motion so the crossing can't be skipped. The box collider uses an exact swept-AABB test; sphere, cylinder, and cone use multi-sample sweeps tuned for their curved/tapered surfaces (the cone especially needs this near its narrow apex, where a single midpoint sample isn't enough).
- **Corner/rim-accurate**: near a box corner, a cylinder's rim (where the cap meets the wall), or a cone's rim (where the slant meets the base), the resolver pushes to the true nearest surface point instead of snapping to a single axis — this is what fixes fabric visibly poking through corners.
- **Sliding, not sticking**: a point that hits a collider keeps its tangential velocity instead of freezing in place, so cloth visibly slides across the surface. That slide is damped by `collisionFriction` (default `0.35` — lower slides more, higher grips more), set via `cloth.collisionFriction = 0.6` (or `flag.cloth.collisionFriction` on a `TatterMesh`).
- **Edge falloff (box only)**: a point resting on top of a box loses vertical support once it's within ~15% of the box's edge, so cloth naturally tips and falls off corners instead of wrapping the box like shrink-wrap.
- **Cone base cap**: the cone's flat bottom face collides too — earlier versions only tested the slanted surface, so cloth could slip underneath and clip straight through.

### Floor collision

```js
flag.withFloor(0); // enable, at y = 0
```

Runs as a proper collider *inside* the same physics iteration loop as everything else, not a separate hard Y-snap applied after the fact. This matters: cloth pinned at the top and resting on the floor now shows real elastic tension between the pins and the floor (especially with `stretchiness` turned up) instead of the unpinned area looking disconnected or silently teleporting onto the floor each frame.

### Self- and cross-cloth collision

Every collider check above is cloth-vs-*shape*. Separately, `selfCollision` and `crossCollision` (both on by default) stop cloth from clipping through *fabric* — the same sheet folding onto itself, or two different `Tatter.cloth()` instances passing through each other:

```js
const flag = Tatter.cloth({
  // ...
  selfCollision: true,   // default — fabric won't clip through its own folds
  crossCollision: true,  // default — fabric won't clip through OTHER Tatter cloths
  thickness: 0.05        // optional — minimum gap enforced between non-adjacent points, default spacing * 0.85
});
```

Implementation: each collision pass builds a spatial hash of the cloth's own points, then for every point checks the ~27 neighboring hash cells for any *non-adjacent* point (points directly joined by a structural constraint are expected to be close and are skipped) closer than `thickness`, and pushes the pair apart. `crossCollision` does the same lookup against every other currently-active `Tatter.cloth()`/`Tatter.Cloth` instance. Cost stays roughly linear in point count either way, since only nearby cells are ever compared — not every pair.

A pinned point never moves for this either, same as with shape colliders — if two pinned points from different cloths are placed overlapping in the scene, that's a scene setup issue neither cloth can resolve on its own.

Turn it off per-cloth if you don't need it and want the extra iterations back:

```js
const backdrop = Tatter.cloth({ selfCollision: false, crossCollision: false, /* ... */ });
```

`Cloth` instances unregister themselves from the cross-collision registry automatically when you call `dispose()`.

## Shapes (non-rectangular cloth)

By default a cloth is a flat rectangle. Pass `shape` to `Tatter.cloth()` to remap the grid onto any outline or surface instead — the point count (`cols * rows`) stays fixed, but cells outside the shape are marked inactive: permanently pinned in place and skipped when the mesh is rendered, so no stray triangles or flapping geometry show up outside the outline.

```js
const disc = Tatter.cloth({
  cols: 30, rows: 30,
  shape: Tatter.shapes.circle({ radius: 2 }),
  pin: false
});
```

Three ready-made shape functions:

```js
Tatter.shapes.circle({ radius: 2 });                          // or radiusX/radiusZ for an ellipse
Tatter.shapes.ring({ outerRadius: 2, innerRadius: 0.8 });      // annulus — a disc with a hole
Tatter.shapes.polygon({ points: [{x,z}, {x,z}, ...] });        // any outline — star, logo silhouette, custom shape
```

- `circle` / `ring` take `origin` (world position) plus their radius options.
- `polygon` needs `points`, an array of 3+ `{x, z}` pairs in normalized -1..1 space, plus `scale` (default `2`, world-unit size) and `origin`. Uses standard even-odd ray casting for point-in-polygon.

You can also write your own shape function directly — `(x, y, cols, rows) => {x, y, z} | null` — for anything the built-ins don't cover, like sampling a surface programmatically.

### Draping onto a custom model

```js
const cape = Tatter.fromMesh(myCharacterMesh, { offset: 0.05 });
cape.addTo(scene);
```

`Tatter.fromMesh(mesh, opts)` builds a cloth whose *starting shape* conforms to a custom `THREE.Mesh`'s actual surface — a cape draped over a character's shoulders, a tarp over irregular terrain, a flag flush against a custom flagpole cap. It works by raycasting straight down (`-Y`) onto the mesh at each grid cell and placing that point at the hit, offset outward along the surface normal by `opts.offset` (default a small gap, so the cloth doesn't immediately register as colliding if you also pass the same mesh in as a collider). Cells that don't hit the surface are left inactive, so an irregular model naturally produces a cloth outline matching its silhouette from above.

This only makes sense for surfaces that are roughly convex from above (terrain, a tabletop, a character's back). For wrap-around draping over a fully enclosed shape, use a normal flat cloth with `Tatter.meshCollider(mesh)` and let it fall and settle dynamically instead — that handles arbitrary topology correctly since it's real physics rather than a one-shot projection.

All other `Tatter.cloth()` options (material, pin, wind, collision) still apply on top of `shape` or `fromMesh` — they only affect the resting outline/topology.

## Pinning

```js
flag.pinPoint(x, y);
flag.unpinPoint(x, y);
flag.pinRow(0, 2);   // pin every 2nd point in row 0
flag.setPinPosition(x, y, worldX, worldY, worldZ); // move a pin, e.g. attach to a flagpole
```

Any constraint with a pinned point at one end acts as a rigid rod: full-strength correction every iteration and immune to tearing, regardless of `stretchiness` or `tearSensitivity`. This makes pins feel like anchors — the fabric hangs and stretches, but the geometry right at a pin stays taut and doesn't rip loose under stress. `stretchiness` and tearing still apply normally everywhere else in the cloth, i.e. to constraints between two unpinned points.

## Wind

```js
const wind = Tatter.wind(t, {
  strength: 0.007,               // base force magnitude
  direction: { x: 1, y: 0, z: 0.3 }, // primary push direction (normalized internally)
  gustiness: 0.5,                 // 0–1, random gust variance layered on the base
  turbulence: 0.5                 // 0–1, extra high-frequency wobble
});
flag.update(colliders, wind);
```

Layers a few different-frequency sines per axis plus gust variance so it reads as moving air rather than a metronome. You can still pass a plain `{x,y,z}` object to `update()`/`step()` directly if you want to drive wind yourself.

## Frustum culling

```js
flag.cullCamera = camera; // opt in — off by default
flag.update(colliders, wind); // now skips physics+mesh sync when off-screen
```

When `cullCamera` is set, `update()` checks the cloth's bounding sphere against that camera's view frustum before doing anything else. If the cloth is fully outside the frustum, **both the physics step and the mesh sync are skipped entirely** for that call — the point array is left exactly as it was. This is a real cost saving, not just a visual one: a flag behind the player, a banner in a room the camera isn't looking at, etc. cost nothing per frame while off-screen.

Tradeoffs:

- Cloth motion **freezes** while off-screen rather than continuing to simulate silently — it resumes from wherever it was when it re-enters view, not from where it "would have been." For most cases (why pay for wind/collision on something nobody's looking at?) that's the right call. If you need off-screen cloth to keep animating on a predictable path — e.g. it's about to swing into frame — don't set `cullCamera`, and lean on `meshSkip`/`collisionIterations` for perf instead.
- The bounding sphere is computed once at construction from the cloth's starting extent, padded generously, and NOT recomputed every frame (recomputing it costs the same point-position scan the physics step already does, which would defeat the purpose). Normal drape/wind motion stays inside the padded sphere. If you reposition the cloth's origin drastically at runtime, call `flag.cloth ? tatterMesh._computeBoundingSphere() : null` yourself afterward (or just re-create the cloth) so culling stays accurate.
- `camera.matrixWorldInverse` must reflect the camera's current transform. `update()` calls `cullCamera.updateMatrixWorld()` itself, so this works correctly regardless of whether you call `update()` before or after `renderer.render()` in your loop.
- On re-entering view after being culled, `prev` is snapped to `pos` internally so the cloth doesn't visibly "lurch" from an unsimulated velocity gap — it resumes calmly rather than catching up all at once.

## Performance

Three knobs matter most on mobile:

- **`meshSkip`** (default `2`): the smoothing resample + normal recomputation is the most expensive part of the render side. Throttling it to every 2nd–4th frame is visually indistinguishable for cloth (it moves slowly) but cuts that cost proportionally. `flag.meshSkip = 3` to try a higher value.
- **`collisionIterations`** (default ~1/4 of `iterations`, minimum 2): collision resolution runs against every point × every collider, every active iteration — the most expensive part of the physics side. It only needs to run on the last few passes after structural constraints have mostly settled; running it on all 12 iterations (the old behavior) was the single biggest cost in the whole step.
- **`selfCollision` / `crossCollision`** (default `true`): the spatial-hash thickness pass runs alongside collider resolution on the same last-few iterations. It's cheap per point (only nearby hash cells are checked), but on very dense grids or scenes with many cloths it adds up. Set either to `false` on cloths where clipping isn't visually noticeable (e.g. a backdrop banner far from anything else) to skip that pass entirely.

If it's still slow after tuning those, drop `cols`/`rows` or the `smooth` factor next — a true GPU-driven solver (compute shaders / transform feedback) would be a much larger rewrite than this library targets; the constraint solver is inherently sequential per relaxation pass, which doesn't parallelize onto the GPU without changing the algorithm itself.

## API

```js
const cloth = Tatter.cloth(options);   // returns a TatterMesh

cloth.addTo(scene);
cloth.removeFrom(scene);
cloth.update(colliders, wind);        // step physics + sync mesh geometry, call once per frame
cloth.withFloor(y);                   // collide with a floor plane (default y = 0), see above
cloth.pinRow(rowIndex, every);
cloth.pinPoint(x, y);
cloth.unpinPoint(x, y);
cloth.setPinPosition(x, y, worldX, worldY, worldZ); // move a pinned point (e.g. attach to a flagpole)
cloth.dispose();                      // free geometry/material, unregister from crossCollision

Tatter.boxCollider(mesh);             // build a collider from a THREE.Mesh with BoxGeometry
Tatter.sphereCollider(mesh);          // ...with SphereGeometry
Tatter.cylinderCollider(mesh);        // ...with CylinderGeometry (upright, Y-axis)
Tatter.coneCollider(mesh);            // ...with ConeGeometry (apex up, Y-axis)
Tatter.capsuleCollider(mesh);         // ...with CapsuleGeometry (upright, Y-axis)
Tatter.planeCollider(mesh, normal);   // infinite plane at the mesh's position/orientation
Tatter.meshCollider(mesh, opts);      // any mesh's real triangle surface, spatial-hashed
Tatter.refreshMeshCollider(col, mesh, maxTriangles); // re-bake a meshCollider after moving/rotating/scaling it
Tatter.shapes.circle(opts);           // non-rectangular cloth outline: disc/ellipse — see Shapes above
Tatter.shapes.ring(opts);             // ...annulus (disc with a hole)
Tatter.shapes.polygon(opts);          // ...arbitrary outline from points
Tatter.fromMesh(mesh, opts);          // cloth shaped by raycasting onto a custom model's surface
Tatter.wind(t, opts);                 // turbulent air wind force generator, see Wind above
```

The underlying simulation (`Tatter.Cloth`) is also exported directly if you want to drive your own mesh/rendering instead of using `TatterMesh`. Its `step(colliders, wind, floorY)` takes the same collider array, wind vector, and an optional floor height. Every `new Tatter.Cloth(...)` registers itself in a shared list for `crossCollision`; call `cloth.disposeCloth()` when you're done with a raw `Cloth` instance so other cloths stop checking against it.

## Files

- `tatter.js` — the library

## License

MIT

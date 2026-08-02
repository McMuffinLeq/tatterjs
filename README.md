THIS PROJECT IS SCRAPPED BECAUSE I CANT FIX THIS GLITCH.


# Tatter.js

Fabric physics for Three.js. Verlet-integration cloth simulation in a single JS file — give it a scene, get back a mesh with real gravity, wind, pinning, tearing, self-collision, and collision against boxes, spheres, cylinders, cones, capsules, planes, and arbitrary meshes.

## Requirements

Three.js, loaded before tatter.js (as a global `THREE`, or passed in explicitly via `{ THREE }` where noted). No other dependencies.

## Usage

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
<script src="tatter.js"></script>
<script>
  const flag = Tatter.cloth({
    cols: 16,
    rows: 16,
    spacing: 0.25,
    origin: { x: 0, y: 3, z: 0 },
    pin: 'top',       // pin the whole top row
    color: 0xff5c7a
  });

  flag.addTo(scene);

  function animate(t) {
    requestAnimationFrame(animate);
    flag.update(null, Tatter.wind(t * 0.001)); // colliders, wind
    renderer.render(scene, camera);
  }
  animate();
</script>
```

Collide against other meshes in your scene:

```js
const colliders = [Tatter.boxCollider(myBoxMesh)];
flag.update(colliders, wind);
```

### ES modules

`tatter.esm.js` is a thin ESM entry point that loads `tatter.js` (the one real implementation) and re-exports the resulting global, so there's nothing to keep in sync between builds:

```js
import Tatter from "https://cdn.jsdelivr.net/gh/McMuffinLeq/tatterjs@v1.0.7/tatter.esm.js";

const flag = Tatter.cloth({ cols: 16, rows: 16, spacing: 0.25 });
```

Only a default export is available (no named imports) — everything hangs off the `Tatter` object, same as the global build. `tatter.js` itself still works as a plain `<script>` tag (UMD: global `Tatter`, or CommonJS/AMD if detected); use whichever entry point fits your setup, but `tatter.js` remains the source of truth for the actual physics code.

## Options

| Option                          | Default          | Description                                                                              |
| -------------------------------- | ---------------- | ----------------------------------------------------------------------------------------- |
| `cols` / `rows`                  | `16`              | Grid resolution of the cloth                                                              |
| `spacing`                        | `0.25`            | Distance between points                                                                   |
| `origin`                         | `{x:0,y:0,z:0}`   | World position of the cloth's top-left point                                              |
| `gravity`                        | `-0.012`          | Downward force per step                                                                   |
| `drag`                           | `0.985`           | Velocity damping                                                                          |
| `iterations`                     | `12`              | Constraint solver passes per step (higher = stiffer cloth)                                |
| `collisionIterations`            | `~iterations / 4` | Collision-resolution passes per step, separate from constraint iterations (min 2)         |
| `stretchiness`                   | `0.15`            | 0 = rigid, higher = softer/springier give under tension (clamped 0–0.95)                  |
| `shear`                          | `true`            | Diagonal constraints for a fabric-like drape instead of a diamond collapse                |
| `tear`                           | `true`            | Whether constraints can break under stress                                                |
| `tearSensitivity`                | `2.6`             | Stretch multiplier before a constraint tears                                              |
| `selfCollision`                  | `false`           | Point-vs-point thickness collision so cloth doesn't clip through its own folds            |
| `crossCollision`                 | `false`           | Also collide against every other live Tatter cloth in the scene                           |
| `thickness`                      | `spacing * 0.85`  | Minimum distance kept between non-adjacent points when self/cross-collision is on         |
| `shape`                          | `null`            | `function(x, y, cols, rows) -> {x,y,z}\|null` — remaps the grid onto a custom outline/surface (see [Shapes](#shapes)) |
| `pin`                            | `'top'`           | `'top'`, `'corners'`, a function `(x, y, cols, rows) => bool`, or `false` for no pinning   |
| `pinEvery`                       | `1`               | With `pin: 'top'`, pin every Nth point along the row                                      |
| `color` / `map`                  | `0xffffff`        | Material color or texture                                                                 |
| `roughness` / `metalness`        | `0.8` / `0.05`    | Material PBR params                                                                       |
| `castShadow` / `receiveShadow`   | `true`            | Shadow settings on the generated mesh                                                     |

## Collision behavior

Collision handles fast motion and edges properly, not just a naive point-in-shape check:

- **Tunneling-proof**: if a point would move straight through a collider in a single step (fast wind, gravity, or a fast-moving collider), a swept test catches the crossing and stops the point at the surface instead of letting it fall through. Collider motion is tracked automatically frame-to-frame — safe to build a fresh collider (e.g. `Tatter.boxCollider(mesh)`) every frame rather than caching it yourself.
- **Sliding, not sticking**: a point that hits a collider keeps its tangential velocity instead of freezing in place, so cloth visibly slides across the surface. That slide is damped by `collisionFriction` (default `0.35` — lower slides more, higher grips more), set via `cloth.collisionFriction = 0.6` (or `flag.cloth.collisionFriction` on a `TatterMesh`).
- **Edge falloff**: a point resting on top of a box loses vertical support once it's within ~15% of the box's edge, so cloth naturally tips and falls off corners/edges instead of wrapping the box like shrink-wrap.
- **Scaled collision skin**: the small buffer margin kept between cloth and a collider's surface (to smooth corner/edge jitter) scales with that collider's own size, instead of a flat distance that could visibly float cloth off a small object.

## Colliders

Beyond `boxCollider`, every primitive THREE geometry type has a matching builder, plus a general mesh collider for anything else:

```js
Tatter.boxCollider(mesh);        // BoxGeometry
Tatter.sphereCollider(mesh);     // SphereGeometry
Tatter.cylinderCollider(mesh);   // CylinderGeometry (upright, Y-axis)
Tatter.coneCollider(mesh);       // ConeGeometry (apex up, Y-axis)
Tatter.capsuleCollider(mesh);    // CapsuleGeometry (upright, Y-axis)
Tatter.planeCollider(mesh, normal); // infinite plane; normal defaults to {x:0,y:1,z:0} rotated by the mesh's orientation
Tatter.meshCollider(mesh, opts); // any mesh — collides against its actual triangle surface
```

`meshCollider(mesh, { maxTriangles })` bakes the mesh's world-space triangles into a spatial hash once, at call time — cheap to collide against every frame afterward, but the bake itself is relatively expensive for a dense mesh. `maxTriangles` (default `5000`) caps and deterministically subsamples denser source meshes. For a static model, call it once; for a model that moves at runtime, call `Tatter.refreshMeshCollider(collider, mesh)` after moving it instead of rebuilding from scratch.

## Shapes

`Tatter.shapes` has ready-made `shape` functions for non-rectangular cloth outlines, passed as the `shape` option:

```js
Tatter.shapes.circle(opts);   // flat disc/ellipse — radius or radiusX/radiusZ, origin
Tatter.shapes.ring(opts);     // flat annulus — innerRadius, outerRadius, origin
Tatter.shapes.polygon(opts);  // flat arbitrary outline — opts.points: [{x,z}, ...], scale, origin
```

For draping cloth onto (or generating it in the shape of) a custom 3D surface — a cape conforming to a character's shoulders, a tarp over terrain — use `Tatter.fromMesh(sourceMesh, opts)`, which builds a `TatterMesh` whose shape is sampled from the source mesh's surface via downward raycasts. For cloth that simply *collides* against a custom model (more common — a flag near a statue), use `Tatter.meshCollider(mesh)` as a normal collider instead and let a flat cloth fall and settle around it dynamically.

## Wind

`Tatter.wind(t, opts)` generates a layered, non-repetitive wind force instead of hand-rolling sine waves — call it once per frame with a running time value:

```js
flag.update(colliders, Tatter.wind(t, {
  strength: 0.006,                    // base force magnitude
  direction: { x: 1, y: 0, z: 0.3 },  // primary push direction (normalized internally)
  gustiness: 0.4,                     // 0-1, random gust variance on top of the base
  turbulence: 0.5                     // 0-1, extra high-frequency wobble
}));
```

## API

```js
const cloth = Tatter.cloth(options);   // returns a TatterMesh

cloth.addTo(scene);
cloth.removeFrom(scene);
cloth.update(colliders, wind);        // step physics + sync mesh geometry, call once per frame
cloth.withFloor(y);                   // clamp cloth to a floor plane (default y = 0)
cloth.pinRow(rowIndex, every);
cloth.pinPoint(x, y);
cloth.unpinPoint(x, y);
cloth.setPinPosition(x, y, worldX, worldY, worldZ); // move a pinned point (e.g. attach to a flagpole)
cloth.dispose();                      // free geometry/material

Tatter.boxCollider(mesh);
Tatter.sphereCollider(mesh);
Tatter.cylinderCollider(mesh);
Tatter.coneCollider(mesh);
Tatter.capsuleCollider(mesh);
Tatter.planeCollider(mesh, normal);
Tatter.meshCollider(mesh, opts);
Tatter.refreshMeshCollider(collider, mesh, maxTriangles);

Tatter.shapes.circle(opts);
Tatter.shapes.ring(opts);
Tatter.shapes.polygon(opts);
Tatter.fromMesh(sourceMesh, opts);    // TatterMesh draped onto a custom surface

Tatter.wind(t, opts);                 // layered wind-force helper
```

The underlying simulation (`Tatter.Cloth`) is also exported directly if you want to drive your own mesh/rendering instead of using `TatterMesh`.

## Files

- `tatter.js` — the library (UMD: global `Tatter`, CommonJS, or AMD). This is the only real implementation.
- `tatter.esm.js` — thin ES module entry point that loads `tatter.js` and re-exports it as `export default Tatter`

## License

MIT

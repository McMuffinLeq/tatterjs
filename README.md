# Swathe.js

Fabric physics for Three.js. Verlet-integration cloth simulation in a single JS file — give it a scene, get back a mesh with real gravity, wind, pinning, tearing, and box collision with realistic sliding/edge falloff.

## Requirements

Three.js, loaded before swathe.js (as a global `THREE`, or passed in explicitly). No other dependencies.

## Usage

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
<script src="swathe.js"></script>
<script>
  const flag = Swathe.cloth({
    cols: 16,
    rows: 16,
    spacing: 0.25,
    origin: { x: 0, y: 3, z: 0 },
    pin: 'top',       // pin the whole top row
    color: 0xff5c7a
  });

  flag.addTo(scene);

  function animate() {
    requestAnimationFrame(animate);
    flag.update(null, { x: 0.004, y: 0, z: 0 }); // colliders, wind
    renderer.render(scene, camera);
  }
  animate();
</script>
```

Collide against other meshes in your scene:

```js
const colliders = [Swathe.boxCollider(myBoxMesh)];
flag.update(colliders, wind);
```

## Options

| Option | Default | Description |
|---|---|---|
| `cols` / `rows` | `16` | Grid resolution of the cloth |
| `spacing` | `0.25` | Distance between points |
| `origin` | `{x:0,y:0,z:0}` | World position of the cloth's top-left point |
| `gravity` | `-0.012` | Downward force per step |
| `drag` | `0.985` | Velocity damping |
| `iterations` | `6` | Constraint solver passes per step (higher = stiffer cloth) |
| `shear` | `true` | Diagonal constraints for a fabric-like drape instead of a diamond collapse |
| `tear` | `true` | Whether constraints can break under stress |
| `tearSensitivity` | `2.6` | Stretch multiplier before a constraint tears |
| `pin` | `'top'` | `'top'`, `'corners'`, a function `(x, y, cols, rows) => bool`, or `false` for no pinning |
| `pinEvery` | `1` | With `pin: 'top'`, pin every Nth point along the row |
| `color` / `map` | `0xffffff` | Material color or texture |
| `roughness` / `metalness` | `0.8` / `0.05` | Material PBR params |
| `castShadow` / `receiveShadow` | `true` | Shadow settings on the generated mesh |

## Collision behavior

Collision against `boxCollider`s is no longer a hard clamp. Each point that penetrates a box now:

- gets pushed out along the shallowest penetration axis (nearest face), like before
- keeps its tangential velocity instead of freezing in place, so it visibly slides across the surface instead of sticking
- has that tangential slide damped by `collisionFriction` (default `0.35` — lower slides more, higher grips more), set via `cloth.collisionFriction = 0.6` (or `flag.cloth.collisionFriction` on a `DrapeMesh`/`SwatheMesh`)
- loses vertical support once it's within ~15% of a box's top edge, so cloth naturally tips and falls off corners/edges instead of wrapping the box like shrink-wrap

## API

```js
const cloth = Swathe.cloth(options);   // returns a SwatheMesh

cloth.addTo(scene);
cloth.removeFrom(scene);
cloth.update(colliders, wind);        // step physics + sync mesh geometry, call once per frame
cloth.withFloor(y);                   // clamp cloth to a floor plane (default y = 0)
cloth.pinRow(rowIndex, every);
cloth.pinPoint(x, y);
cloth.unpinPoint(x, y);
cloth.setPinPosition(x, y, worldX, worldY, worldZ); // move a pinned point (e.g. attach to a flagpole)
cloth.dispose();                      // free geometry/material

Swathe.boxCollider(mesh);             // build a collider from any THREE.Mesh with BoxGeometry
```

The underlying simulation (`Swathe.Cloth`) is also exported directly if you want to drive your own mesh/rendering instead of using `SwatheMesh`.

## Files

- `swathe.js` — the library

## License

MIT

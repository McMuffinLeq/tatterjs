# Tatter.js

Fabric physics for Three.js. Verlet-integration cloth simulation in a single JS file — give it a scene, get back a mesh with real gravity, wind, pinning, tearing, and box collision with realistic sliding, edge falloff, and tunneling-proof collision.

## Requirements

Three.js, loaded before tatter.js (as a global `THREE`, or passed in explicitly). No other dependencies.

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
const colliders = [Tatter.boxCollider(myBoxMesh)];
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

Collision against `boxCollider`s handles fast motion and edges properly, not just a naive point-in-box check:

- **Tunneling-proof**: if a point would move straight through a box in a single step (fast wind, gravity, or a fast-moving collider), a swept segment test catches the crossing and stops the point at the surface instead of letting it fall through.
- **Sliding, not sticking**: a point that hits a box keeps its tangential velocity instead of freezing in place, so cloth visibly slides across the surface. That slide is damped by `collisionFriction` (default `0.35` — lower slides more, higher grips more), set via `cloth.collisionFriction = 0.6` (or `flag.cloth.collisionFriction` on a `TatterMesh`).
- **Edge falloff**: a point resting on top of a box loses vertical support once it's within ~15% of the box's edge, so cloth naturally tips and falls off corners/edges instead of wrapping the box like shrink-wrap.

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

Tatter.boxCollider(mesh);             // build a collider from any THREE.Mesh with BoxGeometry
```

The underlying simulation (`Tatter.Cloth`) is also exported directly if you want to drive your own mesh/rendering instead of using `TatterMesh`.

## Files

- `tatter.js` — the library

## License

MIT

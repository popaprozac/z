# Z Lang

Z is an experimental native systems language with TypeScript-inspired syntax,
safe value semantics, deterministic cleanup, typed errors, and first-class
interop with C-family platform APIs.

The bootstrap compiler currently implements a deliberately small vertical
slice: imports, functions, local bindings, primitive expressions, calls, name
resolution, primitive type checking, and C emission. It has no third-party
dependencies and runs directly on Bun.

```z
import stdio from "stdio.h";

function add(a: i32, b: i32): i32 {
  return a + b;
}

function main(): i32 {
  const answer: i32 = add(20, 22);
  stdio.printf("Z says %d\n", answer);
  return 0;
}
```

Structs are value types with fields, literals, and methods:

```z
struct Point {
  x: i32;
  y: i32;

  function translated(dx: i32, dy: i32): Point {
    return Point { x: this.x + dx, y: this.y + dy };
  }
}
```

```sh
bun run z check examples/first.z
bun run z emit examples/first.z
bun run z run examples/first.z
bun run z run examples/structs.z
bun test
```

The current header import proves the intended source experience and delegates
foreign-symbol checking to Clang. Z declarations are checked before emission;
imported signatures are not yet known to Z. This is not yet the safe Clang-AST
importer described in the design documents.

See [DESIGN.md](DESIGN.md) for the language charter and roadmap.

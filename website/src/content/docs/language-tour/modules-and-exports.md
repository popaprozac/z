---
title: Modules and exports
description: Build explicit source graphs with namespace imports, selective imports, aliases, and immutable module constants.
sidebar:
  order: 9
---

Every `.zs` file is a module. Declarations are private unless marked `export`,
and an export-only module does not need `function main()`.

```z
// geometry.zs
export struct Point {
  x: i32;
  y: i32;
}

export function total(in point: Point): i32 {
  return point.x + point.y;
}

function internalAudit(in point: Point): void {
  // private to this module
}
```

## Package-internal APIs

`internal` exposes implementation declarations to sibling modules in the same
manifest-defined package without publishing them to consumers:

```zs
// src/window-state.zs
internal struct WindowRecord {
  id: String;
}

export class WindowManager {
  internal function publish(inout this, in record: WindowRecord): void {}
}
```

Sibling modules use ordinary relative imports. A dependent package cannot
import `WindowRecord` or call `publish`, and those names are omitted from its
completion and public metadata. The owning `z.json` must declare
`package.name`; directory proximity or presence in one linked graph does not
grant access. `internal` and `export` are mutually exclusive.

## Namespace imports

A namespace import keeps the source module visible at use sites:

```z
import geometry from "./geometry.zs";

const point = geometry.Point({ x: 20, y: 22 });
const answer = geometry.total(point);
```

This form is useful when a module exports several related names or when
qualification makes code easier to read.

## Selective imports and aliases

Import only the declarations a module needs:

```z
import { Point, total } from "./geometry.zs";
import { translate as movePoint } from "./geometry.zs";
```

Aliases are ordinary local module bindings. Hover and definition navigation
should show both the local alias and original exported declaration.

Z ownership words are contextual, so an imported declaration may still use a
name such as `move` when the surrounding grammar is unambiguous:

```z
import { translate as move } from "./geometry.zs";
const shifted = move(point, 1, -1);
```

## Module constants

Modules may publish immutable compile-time values:

```z
// app-config.zs
export const APP_NAME: String = "Z Notes";
export const DEFAULT_PORT: u16 = 34115;
export const ENABLE_METRICS: boolean = true;

const CONFIG_REVISION = 1;
```

An exported or internal constant requires an explicit type so its cross-module
contract cannot change when the initializer is edited. A module-private
constant may infer its type.

Module storage is immutable: there is module-level `const`, not module-level
`let`. Importing a Z module does not execute a hidden initializer. Runtime
application roots use explicit ownership mechanisms such as `Once<T>` rather
than depending on initialization order.

The current executable constant tier accepts cleanup-free literals and owned
literal `String` values. General constant evaluation and ownership-bearing
runtime globals remain separate future work.

## One import surface, different producers

The same source shape names three kinds of module:

```z
import console from "std/console";       // standard library
import geometry from "./geometry.zs";   // Z source
import sqlite from "sqlite3.h";         // native header
```

Resolution is not the same behind the scenes:

- Relative `.zs` paths join the checked Z source graph.
- `std/...` resolves a standard-library module.
- Header imports ask Clang for native ABI declarations and layouts.

Source libraries declare their package identity and public entry points in
`z.json`:

```json
{
  "package": {
    "name": "zapp",
    "version": "0.1.0"
  },
  "library": {
    "entry": "src/zapp.zs",
    "exports": {
      "./window": "src/window.zs"
    }
  }
}
```

The consumer declares one dependency alongside its target:

```json
{
  "dependencies": {
    "zapp": { "path": "../zapp" }
  },
  "target": {
    "name": "notes",
    "entry": "main.zs"
  }
}
```

The compiler and editor then resolve `import { Application } from "zapp";`
without source rewriting. The library entry supplies the package root and only
exact exported subpaths are public. Local path dependencies work transitively
in Stage 0 and the native driver; registry versions, downloads, and lockfiles
remain future layers.

Systems packages can own their native implementation requirements alongside
their public source surface:

```json
{
  "package": { "name": "desktop", "version": "0.1.0" },
  "library": {
    "entry": "src/desktop.zs",
    "native": {
      "includeDirectories": ["include"],
      "link": {
        "directories": ["lib"],
        "libraries": ["desktop_native"],
        "frameworks": ["AppKit"]
      }
    }
  }
}
```

Those paths resolve from the package's own manifest and compose transitively
with the consumer target. Applications select deployment policy; they do not
repeat a dependency's headers, native libraries, or frameworks. Package-native
requirements are unconditional in the first tier; platform clauses follow the
language's target/comptime design later.

A native import does not introduce an automatic wrapper call. See
[Native interop](/interop/) for header and `.zd` behavior.

## Graph rules

Z resolves an acyclic source-module graph and reports missing modules,
duplicate bindings, unavailable exports, and cycles directly. It does not use a
separate `import type` syntax to paper over runtime module cycles: Z imports do
not execute JavaScript-style module initialization, and accepted source graphs
remain statically resolvable.

Project entry points, artifact kinds, native include paths, libraries,
frameworks, and target settings belong in `z.json`. Application-specific facts
live under `target`; reusable implementation requirements live under
`library.native`. Source modules stay focused on declarations and imports.

:::note[Cost model]
Source imports and aliases are compile-time graph relationships. They do not
create runtime namespace objects or wrapper calls. Literal module constants
lower to static storage rather than runtime initialization functions.
:::

See the complete runnable
[module example](https://github.com/popaprozac/z/tree/main/examples/language/modules).

Next: [Closures and function values](/language-tour/closures-and-function-values/).

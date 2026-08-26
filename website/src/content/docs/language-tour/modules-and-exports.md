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

An exported constant requires an explicit type so its public contract cannot
change when the initializer is edited. A private constant may infer its type.

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

A native import does not introduce an automatic wrapper call. See
[Native interop](/interop/) for header and `.zd` behavior.

## Graph rules

Z resolves an acyclic source-module graph and reports missing modules,
duplicate bindings, unavailable exports, and cycles directly. It does not use a
separate `import type` syntax to paper over runtime module cycles: Z imports do
not execute JavaScript-style module initialization, and accepted source graphs
remain statically resolvable.

Project entry points, artifact kinds, native include paths, libraries,
frameworks, and target settings belong in `z.json`; source modules stay focused
on declarations and imports.

:::note[Cost model]
Source imports and aliases are compile-time graph relationships. They do not
create runtime namespace objects or wrapper calls. Literal module constants
lower to static storage rather than runtime initialization functions.
:::

See the complete runnable
[module example](https://github.com/popaprozac/z/tree/main/examples/language/modules).

Next: [Closures and function values](/language-tour/closures-and-function-values/).

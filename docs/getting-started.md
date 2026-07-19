# Getting started

This guide gets the stage-0 Z compiler, native toolchain, and editor support
running. Z is pre-alpha; commands are repository-local and there is not yet a
versioned compiler distribution or package manager.

## Requirements

- [Bun](https://bun.sh/) matching the repository's `packageManager` version as
  closely as practical;
- Clang on `PATH` for native C-family compilation;
- macOS plus Xcode Command Line Tools for AppKit, Objective-C, and Swift probes.

The compiler has no third-party package dependencies. From the repository root,
confirm the toolchain with:

```sh
bun --version
clang --version
bun test
```

## Your first Z program

Create `hello.z`:

```z
import console from "std/console";

function main(): i32 {
  const answer = 20 + 22;
  console.log(`answer=${answer}`);
  return 0;
}
```

Run it through the bootstrap CLI:

```sh
bun run z run hello.z
```

`main` is required for an executable entry point and returns the native process
exit code. Export-only `.z` files are valid modules and can be checked without a
`main` function.

## CLI commands

```text
usage: z <check|emit|run> <file.z>
```

| Command | Purpose |
| --- | --- |
| `bun run z check file.z` | Parse, type-check, and validate ownership without producing a binary |
| `bun run z emit file.z` | Print the generated C-family source for inspection |
| `bun run z run file.z` | Generate, compile, link, and execute a native binary |

`z run` streams stdout and stderr while the program is alive, including during
a native GUI event loop.

## Source modules

Declarations are private to a source file unless exported:

```z
// geometry.z
export struct Point {
  x: i32;
  y: i32;
}

export function total(in point: Point): i32 {
  return point.x + point.y;
}
```

Import a namespace, selected declarations, or an alias:

```z
import geometry from "./geometry.z";
import { total as sum } from "./geometry.z";

function main(): i32 {
  const point = geometry.Point({ x: 20, y: 22 });
  return sum(point) == 42 ? 0 : 1;
}
```

Run the repository version with:

```sh
bun run z run examples/modules/main.z
```

## Native modules

Native headers use the same import surface. The header remains the ABI source
of truth:

```z
import stdio from "stdio.h";
import { sqlite3_open, sqlite3_close as closeDatabase } from "sqlite3.h";
```

Namespace and selective imports do not introduce wrapper calls. Project-authored
pointer ownership and callback lifetime/context/release/threading contracts use
adjacent `<header>.zd` Z declaration files. See
[the interop model](interop-model.md).

## Editor setup

Install the repository's development extension:

```sh
./scripts/install-editor-extension.sh
```

Reload VS Code or Cursor, then open a `.z` source or `.zd` declaration file.
The extension provides TextMate highlighting immediately and starts the
compiler-backed language server. Z source receives diagnostics, semantic
highlighting, hover, completion, and definitions. `.zd` files receive
declaration-aware highlighting and diagnostics, plus header-backed completion
for native functions, parameter names, and `deinit` targets. Hovering a native
declaration, parameter, inferred `_` type, or `deinit` target shows the resolved
Clang type or signature.
Definitions include Z modules plus imported project, SDK, and generated native
headers when the toolchain reports a concrete declaration location.

The extension watches `compiler/src` and restarts its language server after
compiler changes. Grammar or extension-host changes still require an editor
reload. Bun must be discoverable on the editor's `PATH`; the extension also
checks the standard `~/.bun/bin/bun` installation and supports the `z.bunPath`
setting.

Another LSP client can start the server directly:

```sh
bun run lsp
```

## Where to continue

- Run the curated programs in [the examples guide](examples.md).
- Read [the language reference](language-reference.md) for accepted syntax and
  semantics.
- Check [bootstrap status](bootstrap-status.md) before assuming a designed form
  is executable in stage 0.
- Use `bun run z emit ...` when learning how a Z construct maps to native code.

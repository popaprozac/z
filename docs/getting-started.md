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

Create `hello.zs`:

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
bun run z run hello.zs
```

`main` is required for an executable entry point and returns the native process
exit code. Export-only `.zs` files are valid modules and can be checked without a
`main` function.

Z uses `.zs` for source modules and `.zd` for foreign declaration contracts.
The project intentionally does not associate `.z` with Z source because Unix
tooling commonly recognizes it as a compressed archive.

## CLI commands

```text
usage: z <check|emit|run> <file.zs>
```

| Command | Purpose |
| --- | --- |
| `bun run z check file.zs` | Parse, type-check, and validate ownership without producing a binary |
| `bun run z check file.zs --native-frontend --timings` | Run the opt-in hybrid native frontend and report parity timings |
| `bun run z emit file.zs` | Print the generated C-family source for inspection |
| `bun run z run file.zs` | Generate, compile, link, and execute a native binary |

`z run` streams stdout and stderr while the program is alive, including during
a native GUI event loop.

## Local native compiler

The repository can turn the self-hosting fixed-point proof into a directly
usable native compiler:

```sh
bun run bootstrap
.z-cache/bootstrap/z check hello.zs
.z-cache/bootstrap/z run hello.zs
```

The bootstrap command asks the trusted Stage 0 seed to emit generation one,
strict-compiles it, then asks that native compiler to build generation two in
release mode. It refuses publication unless generation-two C is byte-identical
to the seed emission. The resulting executable is named `z`, retains its
generated `.c` sidecar for inspection, and does not invoke Bun for ordinary
pure-Z `check`, `emit`, `build`, or cached `run` commands.

This is a reproducible local bootstrap procedure, not a versioned compiler
distribution. Bun remains necessary to create the first generation, and the
current `z-foreign-adapter` metadata producer still uses the TypeScript seed
when a native-header import requires fresh Clang evidence. A future release
will ship trusted platform bootstrap artifacts and the complete adapter
toolchain so end users do not perform this seed ceremony.

The native-frontend flag enables a deliberately narrow hybrid mode. Stage 0
still produces the user-facing diagnostics first; after it succeeds, the native frontend
receives the same canonical source-module batch, and its validated semantic
graph must match before the check can succeed. The compiler indexes native local,
selective-import, and namespace symbols from that graph; parity reuses the
batch's existing stage-0 ASTs rather than parsing each module again. It also
executes and checks every indexed binding/signature query; `--timings` reports
that compiler-owned parity separately from native execution. During stage-zero
semantic analysis, successful non-generic Z function, method, and explicit class
constructor calls use their native callable contracts after source-level names
are rebased onto the linked lowering declarations. For methods, that includes
static/instance identity, visibility, and the `in`/`inout`/`move this` receiver
capability enforced by the ordinary ownership engine. Non-generic aggregate
construction, field access, and source enum variants likewise take their kind,
field type/visibility/readonly state, and payload shape from native metadata.
Explicit non-generic Z types nested inside closures, arrays, slices, `Option`,
`Weak`, views, and `Task` annotations are recursively rebuilt through the native
type index before becoming semantic local or block contracts.
Stage zero independently verifies each contract. Direct generic functions,
methods on generic owners, separately generic instance methods, separately
generic static methods on non-generic owners, and generic constructors now share
the native resolver's concrete substitution evidence. Native failures are held
until stage zero succeeds, so enabling the hybrid does not displace the existing
diagnostic.

## Source modules

Declarations are private to a source file unless exported:

```z
// geometry.zs
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
import geometry from "./geometry.zs";
import { total as sum } from "./geometry.zs";

function main(): i32 {
  const point = geometry.Point({ x: 20, y: 22 });
  return sum(point) == 42 ? 0 : 1;
}
```

Run the repository version with:

```sh
bun run z run examples/language/modules/main.zs
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
[the Z declaration reference](z-declarations.md) for the current grammar and
[the interop model](interop-model.md) for its lowering and cost model.

For native projects, `z.json` can declare one explicit host deployment target
and the system libraries the final binary must link:

```json
{
  "target": {
    "entry": "main.zs",
    "platform": "macos",
    "minimumVersion": "13.0",
    "includeDirectories": ["vendor/include"],
    "link": {
      "directories": ["vendor/lib"],
      "libraries": ["sqlite3"]
    }
  }
}
```

The compiler applies that minimum version consistently while importing headers,
checking native availability, compiling generated source, and building a local
Swift target. APIs introduced after the minimum or obsoleted by it fail at the Z
use site; applicable deprecations are warnings. Omitting both fields leaves
versioned availability unchecked rather than guessing a target. Stage 0 accepts
only the host platform and does not cross-compile.

`target.link.libraries` contains portable library names rather than raw linker
flags: `"sqlite3"` becomes `-lsqlite3` for the current native toolchain. Names
are validated and deduplicated. `target.includeDirectories` supplies header
search paths to both compiler and editor analysis, while
`target.link.directories` supplies native library search paths. Relative paths
resolve from the `z.json` directory; absolute paths remain absolute. Every
configured path must name an existing directory. Importing a header describes
the API; selecting a library describes where its implementation comes from, so
the two concerns remain explicit and independent. Run the macOS probe with:

```sh
bun run z run examples/interop/c/deployment-target/main.zs
```

## Editor setup

Install the repository's development extension:

```sh
./scripts/install-editor-extension.sh
```

Reload VS Code or Cursor, then open a `.zs` source or `.zd` declaration file.
The extension provides TextMate highlighting immediately and starts the
compiler-backed language server. Z source receives diagnostics, semantic
highlighting, hover, completion, and definitions. Completion is contextual:
selective imports suggest exported Z, standard-library, or native symbols;
typed object construction suggests remaining fields as `field: value`; and
enum payload destructuring suggests remaining field bindings. Value-struct
declaration and `for...of` object patterns suggest fields while they are typed,
then provide semantic highlighting, binding hover, and local completion. `.zd` files receive
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

# Z

Z is an experimental native systems language with TypeScript-inspired syntax,
deterministic cleanup, typed errors, memory-safe ownership, and direct interop
with C-family platform APIs.

> Z is pre-alpha. The repository is a language-design laboratory and working
> stage-0 compiler, not yet a production toolchain.

```z
import stdio from "stdio.h";

function add(a: i32, b: i32): i32 {
  return a + b;
}

function main(): i32 {
  const answer = add(20, 22);
  stdio.printf("Z says %d\n", answer);
  return 0;
}
```

```sh
bun run z run examples/language/basics/first.z
```

The stage-0 compiler is written in TypeScript, runs on Bun, and emits readable
C, C++20, Objective-C ARC, or Objective-C++ before the platform compiler
produces a native binary:

```text
Z source -> parser and semantic model -> ownership/async lowering
         -> C-family source -> Clang -> native binary
```

Self-hosting is the goal. TypeScript is the bootstrap implementation, not Z's
runtime model.

## Why Z

Z is exploring a specific combination:

- TypeScript-shaped source syntax without JavaScript semantics;
- value-oriented structs and ARC-managed classes;
- inferred lexical borrows with explicit `in`, `inout`, `out`, and `move`
  capabilities;
- deterministic `deinit`, owned closures, and weak references;
- `return` for success, `throw` for typed failure, and `Result<T, E>` through
  `attempt`;
- exhaustive expression-oriented pattern matching;
- structured async tasks with hot `spawn`, lexical joins, cancellation,
  scheduler-aware delay, and an initial explicit native-thread launcher;
- header-first C and Objective-C imports, plus staged C++ and Swift interop.

The wager is not that familiar syntax makes systems semantics disappear. It is
that explicit ownership and native boundaries can be made readable without
requiring lifetime syntax throughout ordinary application code.

## Current shape

| Area | Implemented stage-0 slice |
| --- | --- |
| Values | Structs, classes, traits, generics, arrays, slices, owned strings |
| Standard library | Explicit console/time/text/memory plus initial `std/fs`, `std/process`, owned program arguments, move-only `TextBuffer`, and `Arena` region storage |
| Ownership | Lexical borrows, moves, deterministic cleanup, ARC, `Weak<T>`, receiver-tied views, and synchronous arena regions |
| Errors | Typed `throws`, `try` propagation, `attempt`, `Result<T, E>` |
| Control flow | Checked arithmetic, loops, ternaries, value `if`, exhaustive `match` |
| Async | Stackless tasks, FIFO executor, spawn/join scopes, cancellation, delay, and `thread.spawn` Copy snapshots or unique Array-owner moves on one native thread |
| C | Header imports, functions, records, enums, constants, pointers with `.zd` contracts, callbacks, target-aware availability |
| Objective-C | ARC objects, nullability, selectors, blocks, persistent observers, AppKit |
| C++ | Hierarchical functions/types, overload selection, records, `.zd`-contracted copyable and move-only RAII values, constructors, methods, named-value references, and receiver qualifiers |
| Swift | Generated Objective-C compatibility headers plus generated C++ values, methods, copying, cleanup, and exact owned `String` returns |
| Editor | VS Code/Cursor highlighting, diagnostics, hover, completion, and definitions |

This table is intentionally summarized. The precise implemented boundary and
known gaps live in [the bootstrap status](docs/bootstrap-status.md).

## Interop as ordinary source

Native declarations come from their real headers rather than handwritten Z
FFI declarations:

```z
import sqlite from "sqlite3.h";
import { sqlite3_open, sqlite3_close as closeDatabase } from "sqlite3.h";
import AppKit from "AppKit/AppKit.h";
```

Supported calls lower to their native ABI. Z adds ownership, pointer, callback,
and threading facts only where the header cannot express them. The target is no
interop tax beyond the semantics requested at the boundary—not a claim that
copies, ARC traffic, closure environments, or dynamic dispatch are free.

The current AppKit event probe registers persistent native notification blocks,
weakly captures ARC-managed Z state, receives repeated callbacks, and explicitly
removes the returned observer tokens:

```sh
bun run z run examples/interop/objc/appkit-events.z
```

See [the interop model](docs/interop-model.md) for the cost model and
[the Foreign Interface IR](docs/foreign-interface-ir.md) for how native facts
are normalized.

## Try the compiler

Z currently requires Bun and a working Clang toolchain. On macOS, Xcode Command
Line Tools provide Clang, Apple frameworks, and Swift for the interop probes.

```sh
bun test
bun run z check examples/language/basics/first.z
bun run z emit examples/language/basics/first.z
bun run z run examples/language/basics/first.z
bun run z run examples/applications/source-stager/main.z -- examples/language/basics/first.z
```

Install the development editor extension for VS Code and Cursor:

```sh
./scripts/install-editor-extension.sh
```

Then reload the editor window and open a `.z` source or `.zd` declaration file.
The extension starts the Bun-based language server automatically.

Continue with [Getting started](docs/getting-started.md), then use the
[examples guide](docs/examples.md) to explore the implemented language in small
runnable slices.

## Documentation

Each document has one job:

| Document | Purpose |
| --- | --- |
| [Getting started](docs/getting-started.md) | Toolchain, CLI, first program, editor setup |
| [Examples](docs/examples.md) | Curated runnable programs by language area |
| [Language reference](docs/language-reference.md) | Accepted source semantics |
| [Design charter](DESIGN.md) | Rationale, tradeoffs, intended direction, open questions |
| [Bootstrap status](docs/bootstrap-status.md) | What the stage-0 implementation supports now |
| [Async model](docs/async-model.md) | Structured concurrency semantics and lowering phases |
| [Interop model](docs/interop-model.md) | Native boundary contracts and cost model |
| [Foreign Interface IR](docs/foreign-interface-ir.md) | Backend-neutral foreign declaration model |
| [Diagnostics](docs/diagnostics.md) | Diagnostic structure and authoring conventions |
| [Ownership pressure log](docs/ownership-pressure.md) | Evidence from application-shaped ownership probes |
| [Design checkpoint — 2026-07-19](docs/design-checkpoint-2026-07-19.md) | Dated thesis, performance target, risks, and validation sequence |

Temporary compiler limitations belong in bootstrap status, not the language
contract. New language decisions should update the reference and design charter;
new implementation slices should update status and a runnable example.

## Repository layout

```text
compiler/src/     stage-0 compiler and language server
runtime/          native runtime support
editors/vscode/   VS Code/Cursor extension
examples/         categorized language, async, and interop probes
tests/fixtures/   deterministic native integration fixtures
docs/             focused reference, model, and status documents
```

The integration suite is the executable truth for the bootstrap. Before a
change lands, run `bun test` and keep generated native code readable enough to
inspect with `bun run z emit <file.z>`.

Browse the categorized runnable index in [`examples/README.md`](examples/README.md).

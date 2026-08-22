# Z

[![CI](https://github.com/popaprozac/z/actions/workflows/ci.yml/badge.svg)](https://github.com/popaprozac/z/actions/workflows/ci.yml)

Z is an experimental native systems language with TypeScript-inspired syntax,
deterministic cleanup, typed errors, memory-safe ownership, and direct interop
with C-family platform APIs.

> Z is pre-alpha. The repository is a language-design laboratory with a working
> Stage-0 compiler and a fixed-point native compiler, not yet a production
> toolchain.

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
bun run z run examples/language/basics/first.zs
```

The Stage-0 compiler is written in TypeScript, runs on Bun, and emits readable
C, C++20, Objective-C ARC, or Objective-C++ before the platform compiler
produces a native binary:

```text
Z source -> parser and semantic model -> ownership/async lowering
         -> C-family source -> Clang -> native binary
```

Self-hosting is underway. TypeScript remains the bootstrap seed and production
CLI, but the standalone Z driver can already discover, compile, and rebuild its
own 39-module source graph to byte-identical C without Bun in the recursive
compilation path. `bun run bootstrap` turns that fixed-point proof into a local
native executable named `z` and packages its foreign-metadata adapter beside
it, together with source-backed standard-library modules such as `std/json`.
The native compiler currently accepts the deliberately constrained Z
subset used by its frontend and demonstrated native applications; Stage 0
remains authoritative for the complete language. A versioned trusted bootstrap
artifact is not shipped yet. TypeScript is not Z's runtime model.

Z source modules use `.zs` (Z source), while foreign declaration contracts use
`.zd` (Z declaration). The compiler intentionally does not claim `.z`, which is
already conventionally used for compressed archives on Unix systems.

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
- structured async tasks with hot `task`, lexical joins, cancellation,
  scheduler-aware delay and cooperative yield, plus an initial explicit
  native-thread launcher;
- header-first C and Objective-C imports, plus staged C++ and Swift interop.

The wager is not that familiar syntax makes systems semantics disappear. It is
that explicit ownership and native boundaries can be made readable without
requiring lifetime syntax throughout ordinary application code.

## Influences and acknowledgements

Z is deliberately a synthesis, not a claim to have invented ownership,
TypeScript-shaped native code, ARC, structured concurrency, or header-first
interop. Its most important influences include TypeScript and JavaScript for
surface familiarity; BorrowScript and Rust for readable ownership and borrowing;
Hylo for mutable value semantics, access capabilities, and projections; Swift
and Objective-C for the value/reference split, ARC, `Weak<T>`, `deinit`, typed
errors, and executor isolation; Nim for C-family interop and ARC/ORC experience;
and Zig for explicit-cost systems design, inline tests, and compile-time
experimentation.

[BorrowScript](https://github.com/alshdavid-public/BorrowScript) deserves
particular credit as clear prior art for combining TypeScript-inspired syntax
with a borrow checker. Its public design includes readable ownership operators
such as `move` and `copy`. Z has a different type system, capability vocabulary,
memory model, interop architecture, and concurrency model, but the shared thesis
and overlapping surface should be acknowledged directly.

Z also draws on the broader ML-family lineage of algebraic data types and
pattern matching, C++ RAII, structured-concurrency work across several
ecosystems, Clang/Swift API metadata, and Zen-C's exploration of direct header
imports and raw native escape hatches. Ante's work on blending borrowing with
reference counting and shape-stable mutation informs bounded Z experiments.
Known local ARC aliases, explicit direct class fields in local value structs,
and direct fixed-layout field projections are now implemented without new
syntax or runtime checks; broader stable-reference semantics remain research
rather than a general Z guarantee.

See [Influences and lineage](docs/influences.md) for a feature-by-feature account,
deliberate divergences, links to upstream work, and the distinction between
design influence and source-code provenance.

## Current shape

| Area | Current implemented slice |
| --- | --- |
| Values | Structs, classes, traits, generics, arrays, slices, owned strings |
| Standard library | Explicit console/time/test/text/memory/collections plus source-backed `std/json` with recursive DOM values, lossless nominal numbers, and first-tier compiler-derived struct codecs, initial `std/fs`, `std/process`, `std/objc`, owned program arguments, move-only `TextBuffer`, RAII interprocess `fs.Lock`, same-filesystem atomic replacement, `Arena` region storage, ownership-aware `Map<K, V>` / `Set<T>`, and cleanup-preserving `expect(...).toEqual(...)` / `fail(...)` |
| Tests | Inline top-level `test "name" {}` declarations, project-import-graph discovery, production erasure, native execution, statement-bounded expectations, deterministic cleanup on failure, and continuation through later tests |
| Ownership | Lexical borrows, readable `copy` / `move` / `view` expressions, deterministic cleanup, ARC, `Weak<T>`, field-level and whole-aggregate `readonly`, zero-copy `freeze()` into type-position `readonly Array`/`Map`/`Set`, inferred shareable classes, direct/optional/aggregate owner-tied view returns, synchronous arena regions, and move-only returned `readonly struct` bundles that close one Arena over a proven internal graph |
| Errors | Typed `throws`, `try` propagation, `attempt`, `Result<T, E>` |
| Control flow | Checked arithmetic, loops, ternaries, value `if`, exhaustive `match`, selected-branch suspension across logical/ternary/value-`if`/owned-match expressions, custom iterators, cold synchronous `Generator<Yield, Return?, Error?>`, cold awaited `AsyncGenerator<Yield, Return?, Error?>` frames, sequential `for await...of`, and explicit `try for await` propagation |
| Async | Stackless tasks, FIFO executors, task/join scopes, cancellation, timer-backed delay, timer-free `scheduler.yield()`, reusable async-generator advancement, declaration-header `on thread.main` isolation with transitive stored-field affinity and hover, synchronous `on thread.any` callable contracts with atomic captured environments and frozen-router publication, explicit placed-block `using (in value, inout state, move owner)` capture contracts, Clang actor-metadata import plus `.zd` native-affinity fallbacks, exactly-once native callback-to-task projection with owned Objective-C errors, and nonblocking `thread.spawn` joins with synchronous or thread-affine async closures, Copy snapshots, unique-owner moves, atomic-ARC readonly sharing, opaque main-isolated Z class transport with main-executor release, owned typed worker errors, `await on thread.main` resumption back on the same worker, and bounded `if`/`match`/`while` state machines across placed suspension |
| C | Header imports, functions, records, canonical-alias-aware move-only value resources with owned/non-escaping-borrowed `.zd` results, ABI-preserving union output storage with checked borrowed discriminated matching, pointer-bearing view-only union payloads with lifetime-bound `const char *` field projections, nominal enums with explicit integer conversion, constants, scalar/record/owner pointers and typed status errors with `.zd` contracts, callbacks, target-aware availability |
| Escape hatches | Typed synchronous `unsafe { ... }` blocks for local `cstring` assertions, scope-confined exact-identity opaque pointer pass-through, and imported-union scalar active-member reads, plus isolated `raw c` / `raw cpp` / `raw objc` helpers with explicit `in` / `inout` / `out` operands, whole-function native bodies, and source-mapped diagnostics |
| Objective-C | ARC objects, nullability, selectors, blocks, persistent observers, imported property ownership, lifetime-safe target/action connections, checked Z-class protocol adapters, weak-property bindings, retained method-registration guards, AppKit |
| C++ | Hierarchical functions/types, overload selection, records, `.zd`-contracted copyable and move-only RAII values, constructors, methods, named-value references, and receiver qualifiers |
| Swift | Generated Objective-C compatibility headers, declared-target symbol-graph import for `@MainActor`, arbitrary-thread ARC blocks, exactly-once callback-to-`Task<T, E>` synthesis, plus generated C++ values, associated-value enum cases, methods, copying, cleanup, and exact owned `String` returns |
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

const rowStatus: i32 = sqlite.SQLITE_ROW;
```

Supported calls lower to their native ABI. Z adds ownership, pointer, callback,
and threading facts only where the header cannot express them. The target is no
interop tax beyond the semantics requested at the boundary—not a claim that
copies, ARC traffic, closure environments, or dynamic dispatch are free.

The current AppKit event probe registers persistent native notification blocks,
weakly captures ARC-managed Z state, receives repeated callbacks, and explicitly
removes the returned observer tokens:

```sh
bun run z run examples/interop/objc/appkit-events.zs
```

See [the interop model](docs/interop-model.md) for the cost model and
[the Foreign Interface IR](docs/foreign-interface-ir.md) for how native facts
are normalized.

The reverse boundary now has an executable value-ABI compiler slice:
`export c function` remains callable from Z while publishing an exact checked
C ABI symbol and generated C/C++-compatible header. Checked `c struct` values
and fixed-representation `c enum` values can cross that boundary by value;
owned `String` inputs project from validated `const char *` host arguments.
Strict handwritten C consumers are compiled and linked against both emitted
static and shared libraries:

```sh
bun run z build examples/interop/c/z-export
bun run z build examples/interop/c/z-shared-export
```

These publish guarded headers beside their selected host-native artifacts. See
[the static example](examples/interop/c/z-export),
[the shared example](examples/interop/c/z-shared-export), and
[the C export design](docs/c-exports.md) for the implemented boundary and its
ownership-aware growth path.

Stateful libraries may additionally select one cleanup-bearing runtime root in
`z.json`. The [`z-runtime-export`](examples/interop/c/z-runtime-export) example
has generated initialization retain a main-bound `OnceLifetime<Application>`
and generated shutdown destroy it after native callers have joined.

The first native application composition probe is Z Notes:

```sh
bun run z run examples/applications/z-notes
bun run z run examples/applications/z-notes/smoke.zs
bun run z run examples/applications/z-notes/persistence-smoke.zs
```

It combines AppKit, an ARC-managed Z notes model, optional selection, direct
`sqlite3.h` import, adjacent ownership contracts for SQLite databases and
prepared statements, zero-allocation projection of native status codes into
typed errors, typed SQLite integer macros, borrowed nullable SQLite text views,
explicit `target.link.libraries` configuration, and an interactive Add Note
control through `std/objc` target/action. Notes load from
`.z-cache/z-notes.sqlite3`, and each added note is persisted before the model
and AppKit UI are updated. The smoke entries run without opening a GUI.
Its deployment target is macOS 14 because it uses `NSApplication.activate()`;
lower targets receive a Z-source availability diagnostic.

## Try the compiler

Developing from source currently requires Bun and a working Clang toolchain.
On macOS, Xcode Command Line Tools provide Clang, Apple frameworks, and Swift
for the interop probes.

```sh
bun run test
bun run z check examples/language/basics/first.zs
bun run z emit examples/language/basics/first.zs
bun run z emit path/to/project
bun run z run examples/language/basics/first.zs
bun run z check path/to/project
bun run z run path/to/project
bun run z build path/to/project
bun run z test path/to/module.test.zs
bun run z run examples/applications/source-stager/main.zs -- examples/language/basics/first.zs
bun run bootstrap
.z-cache/bootstrap/z test path/to/module.test.zs
```

The bootstrap suite is split into independently runnable language, native
interop, Objective-C, Swift, self-hosting, and async tiers. See
[`docs/testing.md`](docs/testing.md) for the commands and CI architecture.
The `.test.zs` suffix shown above is an optional organization convention; tests
are ordinary top-level declarations and may live beside the source they cover.

`bun run bootstrap` additionally produces `.z-cache/bootstrap/z` and an
adjacent standalone foreign-metadata adapter. That native toolchain runs its
supported `check`, `test`, `emit`, `build`, and cached `run` paths without Bun on
`PATH`; Bun remains the trusted local seed and powers the development language
server until versioned native toolchain artifacts are distributed.

Install the development editor extension for VS Code and Cursor:

```sh
./scripts/install-editor-extension.sh
```

Then reload the editor window and open a `.zs` source or `.zd` declaration file.
The extension starts the Bun-based language server automatically and provides
schema-backed completion and validation in project `z.json` files.

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
| [Influences and lineage](docs/influences.md) | Feature ancestry, explicit acknowledgements, and deliberate divergences |
| [Bootstrap status](docs/bootstrap-status.md) | Exact Stage-0 and fixed-point native implementation coverage |
| [Async model](docs/async-model.md) | Structured concurrency semantics and lowering phases |
| [Interop model](docs/interop-model.md) | Native boundary contracts and cost model |
| [C export design](docs/c-exports.md) | Implemented scalar functions, C-layout value structs, generated headers, and the native-consumer growth path |
| [Z declaration files](docs/z-declarations.md) | `.zd` grammar, capability dictionary, and C/C++/Objective-C mapping |
| [Foreign Interface IR](docs/foreign-interface-ir.md) | Backend-neutral foreign declaration model |
| [Diagnostics](docs/diagnostics.md) | Diagnostic structure and authoring conventions |
| [Performance](docs/performance.md) | Repeatable release benchmarks, methodology, and current evidence |
| [Ownership pressure log](docs/ownership-pressure.md) | Evidence from application-shaped ownership probes |
| [Design checkpoint — 2026-07-19](docs/design-checkpoint-2026-07-19.md) | Dated thesis, performance target, risks, and validation sequence |

Read the language reference for accepted semantics, then consult bootstrap
status for the exact executable boundary. The design charter may describe
accepted direction that has not landed yet, while dated checkpoints and
performance reports preserve historical evidence rather than silently
rewriting it as the compiler changes.

Temporary compiler limitations belong in bootstrap status, not the language
contract. New language decisions should update the reference and design charter;
new implementation slices should update status and a runnable example.

## Repository layout

```text
compiler/src/      Stage-0 compiler and language server
compiler/frontend/ native Z frontend, semantic analysis, lowering, and emitter
compiler/driver/   standalone native Z compiler command
editors/vscode/    VS Code/Cursor extension
examples/          categorized language, async, and interop probes
benchmarks/        repeatable release-mode performance probes
tests/fixtures/    deterministic native integration fixtures
docs/              focused reference, model, and status documents
```

The integration suite is the executable truth for the bootstrap. Before a
change lands, run `bun run test` and keep generated native code readable enough
to inspect with `bun run z emit <file.zs | project-directory | z.json>`.

Browse the categorized runnable index in [`examples/README.md`](examples/README.md).

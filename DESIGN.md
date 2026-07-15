# Z Language Charter

## Thesis

Z is a memory-safe native language with TypeScript-like syntax and
compiler-understood interoperability across C-family platform APIs.

The defining user experience is:

```z
import sqlite from "sqlite3.h";
import webview from "WebView2.h";

const database = try sqlite.open("app.db");
const environment = try await webview.createEnvironment();
```

Header imports are progressively parsed through Clang into cached, typed foreign
modules. The bootstrap begins with C functions and a small set of scalar types.
Sidecar API notes will supply ownership, lifetime, nullability, callback, and
async semantics that are absent from the header itself.

## Core semantics

- TypeScript-inspired syntax does not imply JavaScript semantics.
- `struct` is a value type and may contain fields, methods, computed properties,
  static functions, and deterministic cleanup.
- `class` is an ARC-managed reference type with identity.
- `trait` describes behavior independently of storage and allocation.
- `enum` supports finite values and tagged unions.
- Safe code cannot perform unchecked pointer operations.
- Native operations that the compiler cannot verify require `unsafe`.
- Unique values, inferred borrows, managed references, and safe arenas serve
  different ownership needs.
- `deinit` is deterministic, exactly-once, synchronous, and infallible.
- Fallible cleanup is expressed by an explicit operation such as `close()`.

## Bindings and mutation

`const` declares immutable storage and `let` declares mutable, lexically scoped
storage. Z has no `var`: function-scoped declarations and hoisting do not belong
in the language. For value structs, immutability applies through their fields.

```z
const origin = Point { x: 1, y: 2 };
let position = origin;
position.x = 10;
position = Point { x: position.x, y: 20 };
```

Assignment is a statement, not an expression. Its target must be a mutable
binding or a field path rooted in one, and its value must have the target's
static type. Parameters and pattern bindings begin immutable.

Methods borrow `this` immutably by default. Receiver mutation is part of the
typed method interface and uses an explicit receiver capability:

```z
function current(): i32                         // implicit `this: in`
function add(this: inout, amount: i32): void   // exclusive mutable borrow
```

An `inout` method requires addressable storage rooted in a `let`; it cannot be
called through a `const`, immutable parameter, immutable receiver, or temporary.
The borrow lasts for the call and does not transfer ownership. A future
`this: move` can represent consuming methods without adding lifetime syntax.
`out` is not meaningful for an already-existing receiver.

Attribute syntax remains deliberately open. A future declaration attribute may
provide sugar for a receiver capability, while an `@{ ... }` form may describe
scoped effects such as unsafe operations, executor affinity, or allocator
selection. Any sugar must still lower to the same receiver capability in method
and trait signatures.

Replacing cleanup-bearing storage has additional semantics: the old value must
be destroyed exactly once before the new value becomes live, including when
evaluation fails. The bootstrap rejects that case until ownership-aware
replacement lowering is implemented.

Lifecycle cleanup is declared as a compiler-only block rather than a callable
method:

```z
struct File {
  handle: c.FILE;

  deinit {
    c.fclose(this.handle);
  }
}
```

The body runs before fields are cleaned up in reverse declaration order. It
cannot accept parameters, return, throw, suspend, or be called directly.
Cleanup is inserted on every path that leaves ownership, including normal
scope exit, `return`, `throw`, and error propagation through `try`.

Cleanup-bearing values are non-copyable by default. Assignment, owned argument
passing, return, and owning field initialization move the value. The compiler
tracks available, moved, and possibly-moved states through branches and matches;
using a value after ownership may have left is an error. Backend live flags
preserve exactly-once cleanup when runtime branches move different values.

## Numeric types

Z names exact signed and unsigned integer widths as `i8`, `u8`, `i16`, `u16`,
`i32`, `u32`, `i64`, and `u64`; `isize` and `usize` track pointer width. Integer
literals are contextually typed and must fit their destination. Variables do
not silently change signedness or width, and binary arithmetic currently
requires matching integer types.

The final overflow policy still needs an explicit language-design decision.
Generated C behavior in the bootstrap is not the semantic contract: safe Z
must not inherit C signed-overflow undefined behavior. Default trapping,
explicit checked results, and separately named wrapping or saturating operations
should be evaluated before this surface is frozen.

## Errors

Recoverable failures are typed values. Surface syntax exposes the two outcomes
without requiring Rust-style constructors:

```z
function load(path: string): Config throws ConfigError {
  if (!File.exists(path)) {
    throw ConfigError.notFound(path);
  }

  return try Config.parse(try File.readText(path));
}
```

- `return value` produces success.
- `throw error` produces failure; it does not perform exception unwinding.
- `try operation()` obtains success or propagates failure.
- `attempt operation()` retains `Result<T, E>` as a value.
- `panic` is reserved for violated invariants and programmer defects.
- Foreign exceptions are caught and converted at explicit interop boundaries.

## Pattern matching

Result matching preserves the success/failure tag, including when its two
payload types happen to be identical:

```z
match attempt getUser(id) {
  success user => show(user),
  failure error => showError(error),
}
```

Direct type patterns belong to union values:

```z
match event {
  User user => show(user),
  UserError error => showError(error),
}
```

The intended pattern system is exhaustive and eventually includes enum
variants, type patterns, destructuring, guards, literals, and wildcards.

`match` is also an expression. Concise arms provide their expression value;
multi-statement arms use `yield` to explicitly provide a value to the nearest
enclosing value-producing construct:

```z
const name: string = match result {
  success user => {
    log(user);
    yield user.name;
  }
  failure error => throw error;
};
```

`return` and `throw` still exit the enclosing function. They have the bottom
type, so an arm that exits does not need to agree with the other arms' value
type. A future generator may use the same `yield` keyword; lexical nesting
selects the nearest yield target, allowing a match expression inside a
generator to intercept its own yields without ambiguity.

## Strings, formatting, and diagnostics

Z should preserve the convenience of logging arbitrary values without giving
up static types:

```z
console.log(`{someInt} with text in between, struct: {someStruct}`);
```

An interpolated string evaluates expressions once from left to right. Primitive
types have standard formatting, while structs receive a useful derived debug
representation by default and may override an eventual formatting trait. The
compiler can lower interpolation to typed formatter operations without runtime
reflection or C-style variadic unsafety. `console.log` belongs to the standard
library; interpolation should remain a reusable value for logging, errors, and
string construction rather than console-specific syntax. Exact formatting
traits and format-specifier syntax remain to be designed.

## Async and concurrency

Z keeps suspension explicit. Full colorless async is not a goal because hidden
suspension obscures reentrancy, executor changes, borrow validity, cleanup, and
foreign thread-affinity requirements.

The intended model combines:

- `async` and `await` for suspension;
- `try await` and `attempt await` for typed outcomes;
- structured `async scope` and `spawn` for task lifetime;
- typed, bounded, move-aware channels for communication;
- actors for long-lived isolated mutable state;
- pluggable native executors;
- structural cancellation and deterministic task-frame cleanup.

Async functions lower to stackless state machines. Async-free programs do not
link an async runtime. Apple executors may integrate with Dispatch and the main
run loop; Windows executors may integrate with the thread pool and IOCP.

## Interop and backends

Z lowers through a shared typed IR. Native source backends may emit C, C++, or
Objective-C++ depending on the imported APIs and target. Swift interop should
use interfaces generated by the Swift toolchain rather than a home-grown Swift
ABI.

Clang supplies ABI identity and signatures but cannot generally say whether a C
pointer is nullable, borrowed, transferred, retained, or consumed. Z therefore
uses API notes as compiler input and rejects pointer boundaries whose safety
contract is incomplete. An owned opaque return names its release operation and
enters the ordinary move/cleanup system; a consuming parameter moves it, while
a borrowed parameter guarantees the callee does not retain it. Nullable handles
must be narrowed before a non-null borrow or consume, and generated cleanup is
conditional on both ownership liveness and non-nullness. Borrowed returns remain
unsupported until their lifetime can be tied to static storage or an input
owner.

Pointers to complete imported records use a separate, non-escaping call
contract. API notes classify `const T *` as `in` and writable `T *` as `out` or
`inout`. An `in` call implicitly borrows a stored Z value. Writable calls require
initialized mutable storage and spell the capability at the call site:

```z
let point = geometry.Point { x: 1, y: 2 };
geometry.translate(inout point, 3, 4);
geometry.reset(out point);
```

`in` forbids mutation and retention, `inout` allows the callee to read and
mutate, and `out` additionally promises complete initialization before return.
These modes authorize a compiler-generated address for one call; they do not
introduce a general safe-code address-of operator. The first bootstrap requires
even `out` bindings to have an initializer, deferring uninitialized storage and
definite-initialization analysis.

The Bun bootstrap currently represents project notes as adjacent
`<header>.zapi.json` files and can ship notes for platform headers. That file
format is an implementation scaffold, not the final authoring experience. Over
time, Clang attributes, Apple's API notes, Windows SAL annotations, package
metadata, and generated bindings should populate the same semantic model so the
common case remains simply:

```z
import platform from "platform.h";
```

Selective imports keep large headers out of local scope without changing the
boundary model:

```z
import { sqlite3_open, sqlite3_close as closeDatabase } from "sqlite3.h";
```

This binds only those C functions. Namespace imports remain useful when
provenance and breadth matter. The bootstrap implements selective functions
first; imported types and constants will join the same binding model later.

Imported C data remains namespaced but otherwise follows Z expression syntax:
typedef-named records can appear in signatures, are built with checked struct
literals, and expose imported fields; C enum constants become typed module
values. The native compiler still includes the original header, so it does not
redeclare layouts or guess padding and calling conventions. A future
`unsafe raw { ... }` facility may cover operations the semantic importer cannot
represent, but routine function and data interop must not require it.

Interop work proceeds in layers:

1. Direct header syntax with native compilation.
2. Clang-AST symbol and layout import.
3. Ownership and lifetime API notes.
4. Objective-C methods, properties, protocols, blocks, and ARC conventions.
5. C++ values, RAII, overloads, and selected templates.
6. Callback-to-async synthesis.
7. Swift generated-interface import.

## Initial non-goals

- inheritance;
- async implementation;
- ORC cycle collection;
- macros and compile-time execution;
- direct LLVM or machine-code generation;
- a package registry;
- complete C++ template support;
- direct implementation of the Swift ABI.

## Self-hosting strategy

The TypeScript/Bun compiler is stage 0 and is intentionally disposable. Compiler
phases communicate through explicit Z-oriented data structures so they can be
ported independently rather than translated as one monolith.

1. **Stage 0:** Bun runs the bootstrap lexer, parser, semantic analysis, IR, and
   native-source backend.
2. **Stage 1:** Once Z has structs, tagged enums, matching, collections, and safe
   file/process APIs, reimplement the frontend in the supported Z subset.
3. **Stage 2:** Compile the Z compiler with stage 0, then use that result to
   compile itself.
4. **Bootstrap verification:** Compare generated native source and compiler test
   results across consecutive self-hosted generations.

Self-hosting is not allowed to block early experimentation, but every bootstrap
feature should have a plausible representation in the intended Z language.

## Editor tooling

Editor support grows from the compiler frontend rather than reimplementing the
language. An early TextMate grammar can provide immediate syntax highlighting.
The language server should then reuse source files, tokens, syntax trees,
symbols, types, and diagnostics from a compiler-service API for semantic
highlighting, completion, hover, navigation, references, and rename operations.

## Bootstrap milestones

### 0.1: Native vertical slice

- lexer and parser;
- useful source diagnostics;
- functions and primitive expressions;
- local bindings and return statements;
- direct header import syntax;
- readable C emission;
- `check`, `emit`, and `run` commands;
- parser, diagnostic, and native execution tests.

### 0.2: Values and errors

- structs with methods;
- name resolution and static type checking;
- moves and deterministic `deinit`;
- tagged enums and exhaustive `match`;
- typed `throws`, `try`, and `attempt`;
- cleanup lowering across every exit path.

### 0.3: Safe native import

- Clang-backed header modules;
- target layout and calling conventions;
- nullability and ownership contracts;
- typed callbacks and generated adapters.

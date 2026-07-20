# Z language charter and design

This document owns the rationale, tradeoffs, intended architecture, and open
design questions behind Z. Accepted source semantics are summarized in
[`docs/language-reference.md`](docs/language-reference.md). Temporary stage-0
implementation coverage belongs in
[`docs/bootstrap-status.md`](docs/bootstrap-status.md), not in the language
contract.

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
modules. Adjacent `.zd` declarations supply ownership, lifetime, nullability,
callback, and async semantics that are absent from the header itself.

## Core semantics

- TypeScript-inspired syntax does not imply JavaScript semantics.
- `struct` is a value type and may contain fields, methods, computed properties,
  static functions, and deterministic cleanup.
- `class` is an ARC-managed reference type with identity.
- `trait` describes behavior independently of storage and allocation.
- `enum` supports finite values and tagged unions.
- Copyable enums compose by value inside struct fields, fixed arrays, and other
  enum payloads; mixed recursive value layouts are rejected.
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
For classes, `const` fixes the reference binding but does not make the shared
instance deeply immutable.

```z
const origin = Point({ x: 1, y: 2 });
let position = origin;
position.x = 10;
position = Point({ x: position.x, y: 20 });
```

## Type inference boundary

Z uses inference to remove repetition inside an implementation, not to hide an
API contract. Initializers determine local binding types; object fields,
constructor arguments, and static-factory arguments infer aggregate parameters;
ordinary call arguments infer function parameters; and an explicit destination
function type supplies omitted closure parameter and result types:

```z
const answer = 42;
const doubled: (value: i32) => i32 = (value) => value * 2;
const describe: (value: i32) => String = (value) => {
  return `${value}`;
};
const pair = Pair({ first: 20, second: 22 }); // Pair<i32>
const envelope = new Envelope(42);           // Envelope<i32>
const wrapped = Container.wrap(42);          // Container<i32>
```

Expected binding and return types participate when a factory has no inferable
value parameter. Explicit aggregate-factory arguments follow the method name,
as in `Container.wrap<i32>(42)`, while `Container<i32>` remains type-position
syntax. This keeps type namespaces TypeScript-shaped rather than requiring a
specialized type expression before the member access.

Function parameters, exported return types, struct and class fields, FFI
boundaries, empty collections, and uninitialized storage remain explicit.
Capabilities describe ownership and access rather than ordinary value types,
so they are not inferred from the closure body. For example, a closure assigned
to `(inout value: Counter) => void` must still spell `(inout value) => ...`.
An untyped closure without a destination contract receives a diagnostic asking
for either `parameter: Type` or an explicit function value type.

Function and imported callback parameters are contextual destinations too, so
closures may be written inline:

```z
apply((value) => value * 2, 21);
applyWithContext(40, (value) => value + offset);
mutate((inout value) => { value = value + 1; }, inout counter);
```

The parameter contract determines capture storage. An explicit `in` function
parameter or call-scoped foreign callback cannot retain the closure, so captures
borrow through an allocation-free stack environment. Owned/value and escaping
parameters require `move` and use the ordinary ARC function-value environment;
escaping callbacks transfer a retained value through the imported API's
compiler-validated release hook. A receiver- or region-tied `view` may be read
through the former nonescaping inline closure; its pointer is copied into the
stack environment and the owner loan ends after the call. It remains illegal in
a stored, owned, or escaping closure. Noncapturing closures need no environment.

Assignment is a statement, not an expression. Its target must be a mutable
binding or a field path rooted in one, and its value must have the target's
static type. Parameters and pattern bindings begin immutable.

Methods borrow `this` immutably by default. Receiver mutation is part of the
typed method interface and uses an explicit receiver capability:

```z
function current(): i32                         // implicit `in this`
function add(inout this, amount: i32): void    // exclusive mutable borrow
function close(move this): void                 // ownership transfer
```

On a struct, an `inout` method requires addressable storage rooted in a `let`;
it cannot be called through a `const`, immutable parameter, immutable receiver,
or temporary. On a class, `inout this` mutates the referenced instance and may
be called through a `const` reference binding.
The borrow lasts for the call and does not transfer ownership. `move this`
passes the receiver by value and transfers ownership to the method. The owned
receiver may be mutated and is cleaned up on every exit unless returned or
forwarded. Copyable receivers copy instead of invalidating the caller. `move`
is contextual in this position, so it remains available as an ordinary name.
`out` is not meaningful for an already-existing receiver.

Whether explicit `move this` should always invalidate even a copyable source is
deliberately open. The bootstrap currently follows ordinary owned-parameter
semantics and copies copyable receivers. Forced invalidation, or rejecting
`move this` when a borrow would suffice, may better match the explicit spelling;
real APIs should drive that decision before traits and generics freeze it.

Attribute syntax remains deliberately open. A future declaration attribute may
provide sugar for a receiver capability, while an `@{ ... }` form may describe
scoped effects such as unsafe operations, executor affinity, or allocator
selection. Any sugar must still lower to the same receiver capability in method
and trait signatures.

Native parameters are owned/by-value by default: copyable values copy and
cleanup-bearing values move. Borrowing is the non-default declaration:

| Shape | Declaration | Call | Contract |
|---|---|---|---|
| owned/value | `value: T` | `use(value)` | Callee owns the parameter; copy or move follows the type. |
| immutable borrow | `in value: T` | `inspect(value)` | Read-only, non-escaping borrow for the call. |
| mutable borrow | `inout value: T` | `update(inout value)` | Exclusive read/write borrow for the call. |
| output | `out value: T` | `create(out value)` | Callee fully initializes storage. |
| consuming receiver | `move this` | `value.consume()` | Receiver ownership transfers; copyable values copy. |

Capabilities precede parameter bindings because they modify access to storage,
not the value's type. The annotation after `:` is always a type.

`in` stays quiet at the call site because it cannot change ownership or caller
storage. `inout` and `out` remain explicit at free-function calls because their
effects are externally visible. Borrowed bindings cannot move into returns,
owned parameters, or owning fields. Borrowed cleanup-bearing parameters do not
run cleanup; their owner remains responsible.

The bootstrap requires `inout` to name direct initialized mutable storage.
Immutable borrows accept stored expressions and non-cleanup struct literals;
general temporary materialization follows later. An `out` parameter begins
uninitialized and write-only, becomes readable after assignment, and must be
initialized along every successful return path. Uninitialized typed `let`
bindings use the same flow-sensitive analysis. Multiple `in` uses may share one
root in a call; uses involving writable access or ownership must not overlap it.

These rules are one loan system, not separate synchronous and asynchronous
ownership models. Each active access is identified by its root storage,
capability (`in`, `inout`, `out`, or `move`), lifetime (call, task, or lexical
scope), and release event (return, join/cancel, or scope exit). The stage-0
compiler uses one access-loan representation and capability compatibility
checker for call-lifetime overlaps and task-lifetime borrows. Task-to-loan maps
are lifecycle indexes only: they identify which loans a join or cancellation
releases rather than defining another aliasing policy. Spawned `out`, suspended
Slice borrowing, regions, and cross-thread loans must extend this same checker
rather than adding parallel rules.

Task loans merge by control-flow reachability. Each `if` branch begins from the
same incoming loan set. A loan is absent after the merge only when every branch
that reaches it has joined or cancelled the corresponding task; terminating
branches do not constrain an unreachable merge. Loop-carried task loans remain
conservative until the ownership fixed-point and loan fixed-point are unified.

Replacing cleanup-bearing storage evaluates the new value into owned temporary
storage before destroying the old value and installing the replacement. If
evaluation propagates an error, the old value remains governed by ordinary
scope cleanup. A whole binding may move through its own replacement expression
and becomes live again only after successful installation.

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

Classes are the managed-reference exception to move-only cleanup. Class
construction with `new` creates one instance and its initial owning strong
reference. Binding, passing,
storing, or returning an existing reference retains it; every owning scope and
field releases it. The user `deinit` body and reverse-order field cleanup run
when the last strong reference is released, followed by storage reclamation.
The bootstrap counter is single-threaded; atomicity and actor/executor rules
must be designed with concurrency rather than accidentally frozen now.

## Allocation families

Borrow analysis and allocation policy remain separate. Stack/value storage,
deterministic native RAII, ARC/ORC identity, arena regions, and unique manual
allocations can all use the same ownership vocabulary without making one
allocator the language model.

An arena is the owner of its region. The implemented first tier uses the same
receiver provenance as value-struct views without adding syntax:

```z
import { Arena } from "std/memory";

let arena = Arena({ initialCapacity: 65536 });
const document = arena.create(Document({ title: "Draft" }));
inspect(document);
arena.reset(); // legal after document's last use
```

`create` preserves existing allocation addresses, so several read-only views
may coexist while the arena grows. `reset`, moving the arena, and scope
destruction invalidate the region and are rejected while a view has a later
use. Cleanup runs newest-first before pages are released. Cleanup-free values
avoid per-allocation destructor records; Z `deinit`, ARC-containing structs,
owned native handles, and C++ RAII values are tracked. Arena views may enter a
synchronous `in T` parameter or a proven nonescaping inline closure but cannot
yet be stored, returned, captured by stored or escaping closures, mutably
borrowed, or held across suspension. The tier is single-threaded and allocation
failure traps.
The optional `initialCapacity` field sizes the first page; it is not a hard
limit and does not change growable-arena exhaustion semantics. Fixed-buffer
arenas remain a separate future ownership shape.

Unique manual allocation can remain safe while ownership is tracked:

```z
let block = Memory.allocate(4096);
use(inout block);
Memory.free(move block); // consumes the owner
```

Arbitrary raw pointers, untracked aliases, pointer arithmetic, and freeing
foreign storage require an explicit `unsafe` boundary. Later arena work must
decide how mutable/stored projections carry provenance, whether pages are
reused, whether arenas can be sendable, and where allocator parameters belong
on collections and APIs.

Native aggregate construction intentionally distinguishes values from identity:

```z
const point = Point({ x: 20, y: 22 });
const session = new Session({ id: 42 });
```

Struct declarations and class declarations retain brace-delimited bodies, while
initialization data is an object expression inside call parentheses. `new` is
reserved for native class construction and is not a general allocation operator.
It promises reference identity and an initial owning reference, not a particular
physical heap strategy. A class with no constructor receives synthesized
fieldwise initialization through `new Type({ ... })`. A declared constructor
changes the call shape to `new Type(arguments...)` and is the only construction
path for that class.

Field visibility is independent of value or reference semantics: struct and
class fields default to `public`, and `private` fields are visible only within
their declaring aggregate. A class with private state requires an explicit
constructor. Constructor analysis tracks definite initialization across
successful branches, rejects reads of uninitialized fields and escape of
incomplete `this`, and returns the completed instance implicitly. Throwing
constructors use `Result<Class, Error>` through ordinary `try` and `attempt`.
Lowering maintains per-field liveness so failure destroys only initialized
cleanup-bearing fields before reclaiming incomplete class storage.

`static function` is the type-scoped factory and utility surface on structs and
classes. It is invoked as `Type.method()`, performs no implicit allocation, and
has no `this` receiver. Methods default to `public`; `private` static and
instance methods are visible only inside their declaring aggregate. Static
methods participate in ordinary `throws`, inferred generic-owner specialization, source
modules, completion, hover, and readable native lowering. Calling one through
an instance, calling an instance method through its type, or declaring a
receiver capability on a static method is rejected. Static fields remain
deferred until a concrete initialization and concurrency model justifies them.

Static membership is independent of storage. A struct is a value type whose
physical storage may be a local slot, registers, inline aggregate storage,
caller-provided return storage, or explicitly managed memory; it is not defined
as “always stack allocated.” A static struct method lowers to a namespaced native
function with no receiver, dynamic dispatch, or implicit allocation.

Explicit `Weak<T>` handles provide the first cycle-breaking tier for classes.
`weak owner` borrows stored class identity without incrementing its strong
count. The first weak operation lazily allocates a separate control block; final
strong release clears its object pointer before `deinit`, and the block remains
until its final weak handle is released. `upgrade()` returns a retained strong
reference through the ordinary typed throwing model or `WeakExpired` when the
object has begun destruction:

```z
const observer = weak owner;
const result = attempt observer.upgrade();
match (result) {
  success(owner) => use(owner);
  failure(expired) => recover();
}
```

Cleanup ownership is uniform across generated results and user enums. An enum
is cleanup-bearing when any reachable payload is cleanup-bearing. Construction
moves a single-owner payload or retains a managed class reference; an
uninspected enum destroys only the active payload; and exhaustive matching
transfers that payload into the selected arm binding. This covers
`Result<Class, WeakExpired>`, option-like class enums, resources nested through
enums and structs, and owned enum captures without a weak-specific exception.
An owned closure breaks a class/closure cycle by capturing a `Weak<T>` value.

`Option<T>` is compiler-provided sugar over that same enum representation:

```z
const present = Option.some(value);
const absent: Option<Value> = Option.none;
```

`some` carries exactly one `T`; `none` carries no payload. `some` infers `T` from
its argument. `none` requires contextual typing or the explicit spelling
`Option<T>.none`. Matching uses the ordinary `some(value)` and bare `none`
patterns, including the existing borrow and move rules. This keeps optional
class references non-null and gives optional single-owner values deterministic
cleanup without a second ownership model.

`T | null` is the TypeScript-shaped spelling for the same optionality concept;
`null` is contextual and never inhabits plain `T`. The first executable
specialization accepts imported Objective-C reference types, preserves their
native one-pointer null niche, and narrows after explicit comparison with
`null`. General `T | null` normalization to `Option<T>` and `some`/`none`
matching remains the next representation-unification layer rather than a
second nullable-value model.

`Option.fromNullable(reference)` is the explicit bridge from an imported
nullable Objective-C reference to the ordinary Z enum API. The bootstrap
already niche-lowers `Option<ObjC reference>` into the original pointer word:
`nil` represents `none`, a non-null pointer represents `some`, and matching is a
null comparison. General `Option<T>` remains tag-plus-payload when the compiler
has no proven invalid representation to reuse.

Capture-list sugar, automatic ORC cycle collection, and atomic cross-thread
weak upgrades remain separate future layers.

Pattern matching exposes ownership explicitly. `match (value)` consumes a
cleanup-bearing enum and transfers its active payload to the arm binding.
`match (in value)` requires stable stored enum storage, leaves the owner alive,
and presents cleanup-bearing payloads as immutable borrows for the duration of
the arm. Borrowed payloads cannot move out, and the matched root cannot be
mutated while an arm is inspecting its storage. Copyable payloads may still be
copied from the borrowed union.

`trait` declarations contain method signatures, including receiver capability,
parameter capability, return type, and error type. `struct T implements X` and
`class T implements X` are checked explicitly and nominally. Generic parameters
may require this conformance with `T: X` or multiple constraints such as
`T: X & Y`; every concrete specialization is checked before monomorphization.
This remains static conformance only: concrete values call their concrete
methods, while trait-typed storage, existential representation, generic traits,
and dynamic dispatch remain later design work. Z-defined classes intentionally
do not have inheritance.

## Control flow

Conditions are statically typed `bool` expressions. `if`/`else` and `while`
retain TypeScript-like spelling, while `break` and `continue` target the nearest
enclosing loop. A control transfer first cleans every local scope it exits, so
deterministic destruction is preserved on normal iteration, `break`,
`continue`, `return`, `throw`, and `try` propagation.

Statement `if` and `else` bodies may be either blocks or one statement. `else`
binds to the nearest unmatched `if`, following TypeScript. Value-producing `if`
expressions continue to require blocks and explicit `select` values.

Ownership analysis computes a fixed state across loop back-edges. An owned value
that may move during one iteration cannot be reused during a later iteration
unless every continuing path restores ownership. State after a loop merges the
zero-iteration path with every reachable `break` path.

The first collection iteration tier uses TypeScript-style `for...of` over fixed
arrays, `Array<T>`, and `Slice<T>`:

```z
for (const value of values) {
  use(value);
}
```

Primitive and other copyable elements copy into the immutable loop binding.
Cleanup-bearing elements remain borrowed from their collection and cannot move
out. The collection is structurally borrowed for the loop, so an `Array.push`
that could reallocate storage is rejected until iteration ends. `break` and
`continue` retain cleanup-aware loop semantics. Mutable element iteration,
custom iteration traits, consuming iterators, and async iteration remain later
layers; the built-in lowering must be expressible through that eventual trait
model rather than contradict it.

## Arrays and views

`T[N]` is a fixed-size inline value whose length participates in its type. Array
literals use `[a, b, c]`, indexing uses `values[index]`, and `.length` produces
`usize`. A `let` array permits element replacement; a `const` array is immutable
through its elements. Nested arrays and arrays inside structs retain value
semantics.

Safe indexing performs a bounds check and traps on failure. A future explicitly
unsafe indexing operation may remove that check when the programmer assumes the
proof obligation. Ordinary optimization should eliminate checks proven
redundant by loop and range analysis.

Cleanup-bearing arrays own every initialized element and destroy them in reverse
index order. Moving an individual cleanup-bearing element out is initially
rejected because it would create partially initialized storage; whole arrays
follow ordinary move rules.

`Slice<T>` is a non-owning contiguous pointer/length view. Its first supported
shape is parameter-only and non-escaping: a compatible fixed array converts to
a slice for one call, but slices cannot yet be returned, stored in aggregates or
enums, or captured by local bindings. This makes the source lifetime obvious to
the compiler without requiring a source-level lifetime name.

A plain `values: Slice<T>` parameter is an immutable element borrow; spelling
`in` would be redundant and is rejected. `inout values: Slice<T>` creates an
exclusive mutable element borrow and requires `inout` at the call. Multiple
read-only slices may share one array in a call, while any overlap involving an
`inout` slice is rejected. The slice descriptor owns neither its buffer nor its
elements and performs no cleanup.

An async Slice parameter copies that two-word descriptor into the task frame
while keeping a loan on the backing collection. Direct await bounds the loan to
the join. Spawn requires `async scope`; immutable Slice tasks may share the
backing array, while an `inout Slice<T>` task has exclusive access until join,
cancellation, or scope exit. The first executable backing-storage tier is a
cleanup-free fixed array in an async frame. Growable arrays and cleanup-bearing
fixed-array elements require their own async-frame cleanup lowering.

`Array<T>()` explicitly creates a growable owned buffer; array literals remain
fixed inline arrays. `Array<T>` carries its allocation, initialized length, and
capacity as one move-only value. `push` requires addressable `let` storage,
checks capacity arithmetic, grows geometrically, and transfers or copies the
element according to its ordinary ownership rules. Safe indexing uses the same
bounds check as fixed arrays. Destruction walks initialized elements in reverse
order before freeing the buffer.

A growable array can be borrowed as `Slice<T>` for a non-escaping call. A
value-struct method may also return a direct element as `view T`; the compiler
ties that read-only projection to the receiver and prevents invalidating
mutation until last use. The first slice intentionally omits removal,
reservation, fallible allocation, escaping slices, subslices, class-owned
views, and general lifetime parameters. Allocation failure currently traps.
`T[]` remains unassigned until those broader contracts are proven.

## Generics

Generic aggregates and functions use `Name<T>` declarations. Function calls
infer concrete type arguments from their arguments, while `Name<Concrete>`
remains available for explicit specialization. The compiler monomorphizes every
reachable concrete instance into an ordinary Z declaration before semantic
analysis.
Ownership, cleanup, ARC, layout, and ABI checking therefore operate on concrete
types rather than a parallel erased-generic runtime.

The initial inference implementation is argument-directed. Type parameters that
appear only in a return type require explicit arguments. Outer aggregate
parameters are supported inside fields and methods. Constraints use nominal
traits and are checked on every inferred or explicit instance. Generic traits,
separately generic methods, specialization policy, and cross-module instance
ownership remain future layers. Generated instance names are backend details and
do not form part of Z's source or ABI contract.

## Numeric types

Z names exact signed and unsigned integer widths as `i8`, `u8`, `i16`, `u16`,
`i32`, `u32`, `i64`, and `u64`; `isize` and `usize` track pointer width. `f32`
and `f64` map to native IEEE-754 `float` and `double` storage. Numeric literals
are contextually typed and must fit their destination. Variables do not
silently change numeric width or category, and binary arithmetic currently
requires matching numeric types. Bitwise `&`, `|`, `^`, `~`, `<<`, and `>>`
remain integer-only; this directly supports typed foreign option masks.
Unary signs remain part of the contextual literal for range checking, so exact
minimum values such as `const minimum: i8 = -128` are valid without first
constructing the out-of-range positive value `128` as an `i8`.

Ordinary integer addition, subtraction, multiplication, division, remainder,
negation, and shifts are checked in every build mode. Overflow, division or
remainder by zero, and an out-of-range shift count trap instead of inheriting C
undefined behavior. Left shift also traps when its mathematical result does not
fit the destination type. Constant expressions report `Z0101` through `Z0103`
during compilation rather than emitting a program that must trap.

Intentional modular or clamped arithmetic is explicit and discoverable on every
integer type:

```z
const wrapped = sequence.wrappingAdd(1);
const clamped = volume.saturatingMultiply(scale);
```

The initial explicit surface includes `wrappingAdd`, `wrappingSubtract`,
`wrappingMultiply`, and their `saturating` counterparts. These operations retain
the receiver's exact integer type. A future checked-result surface should be
designed with Z's optional-value type rather than inventing a sentinel.

`null` has no independently inferable storage type. It is accepted only when a
destination explicitly carries nullable foreign-reference semantics; it cannot
silently enter ordinary values or non-null foreign boundaries.

## Errors

Recoverable failures are typed values. Surface syntax exposes the two outcomes
without requiring Rust-style constructors:

```z
function load(path: String): Config throws ConfigError {
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
- Cleanup-bearing error values move through `throw`, `try`, and consuming
  `match`; synchronous error messages can therefore be owned `String` values.
- `panic` is reserved for violated invariants and programmer defects.
- Foreign exceptions are caught and converted at explicit interop boundaries.

## Pattern matching

Each enum variant currently has zero or one payload. Payload patterns use the
constructor-shaped spelling `success(user) => ...`; payloadless variants remain
bare, as in `stopped => ...`. Struct payloads support contextual construction
with `Enum.variant({ field })` and named destructuring with
`variant({ field, other: alias })`.

Result matching preserves the success/failure tag, including when its two
payload types happen to be identical:

```z
match (attempt getUser(id)) {
  success(user) => show(user);
  failure(error) => showError(error);
}
```

Direct type patterns belong to union values:

```z
match (event) {
  User user => show(user);
  UserError error => showError(error);
}
```

The intended pattern system is exhaustive and eventually includes enum
variants, type patterns, destructuring, guards, literals, and wildcards.

`match` is also an expression. Concise arms provide their expression value;
multi-statement arms use `select` to explicitly provide a value to the nearest
enclosing value-producing construct:

```z
const name: String = match (result) {
  success(user) => {
    log(user);
    select user.name;
  }
  failure(error) => throw error;
};
```

`return` and `throw` still exit the enclosing function. They have the bottom
type, so an arm that exits does not need to agree with the other arms' value
type. `select` belongs to local value-producing control flow; `yield` is
reserved for producing values from a future generator.

`if` is also an expression. Its statement blocks use the same explicit
`select` operation, while conventional ternaries remain available for small
conditions:

```z
const label = ready ? "Ready" : "Waiting";
const detailed = if (ready) {
  log("ready");
  select "Ready";
} else {
  log("waiting");
  select "Waiting";
};
```

## Closures

Closures use TypeScript arrow syntax. Expression bodies infer their return
type; statement bodies keep ordinary explicit `return` semantics:

```z
const add = (value: i32): i32 => value + offset;
const describe = (value: i32): String => {
  log(value);
  return `${value}`;
};
```

The compiler infers read-only and mutable captures. The initial implementation
keeps closure bindings non-escaping and lowers captures to hidden borrowed
parameters, so calls do not allocate or increment reference counts. `move`
snapshots copyable captures at closure creation:

```z
let total = 0;
const accumulate = (value: i32): i32 => {
  total = total + value;
  return total;
};

const snapshot = move (value: i32): i32 => seed + value;
```

Explicit function types use TypeScript arrow spelling:

```z
const operation: (left: i32, right: i32) => i32 = add;

function apply(
  operation: (left: i32, right: i32) => i32,
  left: i32,
  right: i32
): i32 {
  return operation(left, right);
}
```

Named functions and non-capturing closures can be stored, passed, returned, and
placed in aggregate fields without allocation. Function values have a uniform
internal shape containing a call entry, an optional environment, and
retain/release hooks. Parameter names are documentary and do not affect
function type compatibility; parameter capabilities and value types do.

A capturing closure becomes storable when it uses `move` and initializes an
explicit function type:

```z
const counter: () => i32 = move (): i32 => {
  current = current + 1;
  return current;
};
```

Its heap environment uses ARC. Copyable captures are snapshotted, classes and
function values retain their managed identity, and unique cleanup-bearing
captures move out of the enclosing scope. Function-value copies share the
environment, including mutable captured state. The final release destroys
captured fields in reverse order and frees the environment. Borrowing closures
remain non-escaping and allocation-free.

The bootstrap reference count is single-threaded, matching the first class ARC
tier. Explicit weak values can now be captured to break class/closure cycles.
Inferred single-parameter syntax, weak capture-list sugar, direct strong
capturing of `this`, atomic cross-thread environments, and automatic cycle
handling remain later tiers.

## Strings, formatting, and diagnostics

Z preserves the convenience of logging arbitrary values without giving up
static types:

```z
import console from "std/console";

console.log(`${someInt} with text in between, struct: ${someStruct}`);
```

`console` is imported explicitly; `import { console } from "std";` is the
equivalent facade spelling. The bootstrap implements
`log` and `write` on stdout plus `error` and `debug` on stderr. `log`, `error`,
and `debug` append a newline; `write` does not. This namespaced surface remains
the canonical logging API instead of reserving competing global `print` and
`println` functions.

The focused time module keeps blocking and suspending delays distinct:

```z
import { sleep, delay } from "std/time";

sleep(100);

async function wait(): void {
  await delay(100);
}
```

`sleep(milliseconds: u64): void` blocks the current OS thread and lowers to
`Sleep` on Windows or interruption-safe `nanosleep` on POSIX platforms.
`delay(milliseconds: u64): void` is async and backed by the executor's
monotonic timer queue. It suspends only the current task; cancellation removes
its pending timer. The separate names ensure `sleep` never changes behavior
based on calling context.

An interpolated template evaluates expressions exactly once from left to right.
Interpolation uses TypeScript's `${expression}` spelling. Plain braces remain
literal text, and `\${expression}` writes a literal `${expression}` sequence.
Primitive types have standard formatting; structs and imported records receive
derived field formatting; arrays format their elements; enums show their active
variant and payload; and classes initially show type plus reference identity.
The compiler lowers these operations to typed native output without runtime
reflection or exposing C-style variadic unsafety to Z.

An interpolated template produces an owned `String`. The bootstrap representation
is a growable, NUL-terminated byte buffer carrying its length and capacity;
deterministic cleanup releases that allocation. `String` is cleanup-bearing and
therefore move-only under the same ownership rules as arrays and value structs.
It can be stored, returned, moved through value parameters, nested in owning
struct fields, and logged. Single- and double-quoted literals are zero-allocation
`String` values backed by static program bytes. Their zero capacity distinguishes
static storage from allocated template buffers during deterministic cleanup.
Direct console templates retain a typed allocation-free lowering.
Statement-producing expression lowering
materializes owned templates into native temporaries when they appear directly
inside calls, aggregate fields, array elements, or ternary branches. Those
temporaries transfer into the enclosing owner, and call arguments containing
templates are evaluated once from left to right before the native call. A
template passed to an `in` parameter remains caller-owned for the duration of
the call and is cleaned immediately after the returned value is secured.
At C-family boundaries, an imported `cstring` parameter may borrow a `String`'s
NUL-terminated data for the duration of that call. This conversion cannot
initialize stored `cstring` state or escape through an ordinary Z call. A quoted
literal may explicitly initialize `cstring` because its bytes have static
lifetime. `String.from(value)` performs the reverse operation by copying a
borrowed `cstring` into owned storage.

`String` distinguishes text length from representation length. `byteLength` is
the constant-time UTF-8 storage size, `byteAt(index)` is checked byte access,
and `copyBytes(start, end)` creates an owned half-open-range copy after checking
bounds and UTF-8 boundaries. The name `copyBytes` is intentional: `slice` in Z
denotes a borrowed view, while this operation allocates independent ownership.
`String.length` is reserved for Unicode extended-grapheme counting rather than
inheriting JavaScript's UTF-16 code-unit behavior. It may be linear-time. Stage
0 validates native C-string copies and text files before they enter owned Z
`String` storage; a future `Bytes`, `OsString`, and path layer will represent
data that is not necessarily UTF-8.

Incremental UTF-8 construction is provided by the explicitly imported
`TextBuffer` value type from `std/text`. The name is deliberately
domain-specific: Z does not establish a pervasive Java-style `Builder`
convention, and the type is mutable value storage rather than a heap class
created with `new`. `append(String)` borrows complete text,
`appendBytes(String, start, end)` borrows a checked UTF-8-boundary range without
allocating a substring, and `appendAscii(u8)` admits only ASCII. `finish()`
consumes the buffer into its owned immutable `String`, so no final byte copy is
required. Chained mutation and Unicode-scalar append remain deferred until Z
has the corresponding mutable-view and character-model designs. Stage 0 lowers
this type intrinsically; the portable implementation should eventually move
into Z's standard library over a thin allocation substrate.

Formatting traits, format specifiers, release-build debug behavior, and
structured logging remain later design work.

Diagnostics are part of the language contract. Ownership and capability errors
carry stable `Z02xx`/`Z03xx` codes, retain the source location where a move or
closure borrow began, and provide notes and safe, actionable help. CLI output
renders primary and secondary source spans; the language server exposes the
same information as diagnostic codes and related locations. Suggestions must
not advertise an unimplemented ownership shape. The current code catalog is in
[`docs/diagnostics.md`](docs/diagnostics.md).

## Source modules

Z declarations are private to their source module unless marked `export`.
Relative source imports use TypeScript-shaped namespace or selective bindings:

```z
// geometry.z
export struct Point { x: i32; y: i32; }
export function total(in point: Point): i32 { return point.x + point.y; }
```

```z
import geometry from "./geometry.z";
import { total as sum } from "./geometry.z";
```

The bootstrap recognizes explicit relative paths ending in `.z`, recursively
loads an acyclic dependency graph, and links it into one native translation
unit. Each dependency receives private compiler identities so unrelated files
may reuse ordinary declaration and native-import names without collision.
Those identities are backend details: diagnostics, formatting, hover,
completion, semantic highlighting, and cross-file definitions retain source
names and source locations. Selective imports require an explicit export;
namespace access exposes the same export set. Re-exports, directory indexes,
package resolution, separate compilation, and a package registry remain later
layers.

A source file does not need a module declaration or a `main` function. Checking
and editor analysis accept declaration-only and export-only modules. Executable
context supplies the distinction: a file selected by `z run`, the current
executable-oriented `z emit`, or as a manifest entry must declare
`function main(): i32`. This keeps module identity in the
import/build graph rather than duplicating it in source syntax.

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

Async calls never start implicitly. A direct call must be covered by `await`
for sequential work or by `spawn` for concurrent work. Every async function
body is an implicit root task scope; an explicit `async scope` creates a
narrower child lifetime. `spawn` produces a scope-bound `Task<T>` or `Task<T,
E>`; child handles and work cannot escape their owning scope. Detached work
requires an explicitly owned supervisor. `await spawn operation()` is rejected
as redundant; an immediately joined child creates no interval of concurrency.
Spawned children are scheduled immediately. Awaiting a task joins already-hot
work: it returns an available outcome or suspends the current task without
blocking the executor thread.

An async function continues to declare its domain contract as `T throws E`.
`spawn` preserves that contract as `Task<T, E>`, `try await` propagates `E`, and
`attempt await` materializes `Result<T, E>`. Suspension composes with the
existing error model rather than adding a second Result-shaped return layer.

Cancellation is a structural third task outcome rather than an error silently
added to every `throws E` contract. It propagates down the task tree and
unwinds frames through ordinary synchronous cleanup. `deinit` cannot suspend;
fallible or suspending shutdown remains an explicit async operation. The
consuming async method `await task.cancel()` requests cancellation and joins the
task's complete descendant cleanup before the caller resumes. It returns `void`,
not `T`, `E`, or a manufactured cancellation error. If completion wins the race,
the same operation joins and discards the unclaimed result or domain error. A
plain `await task` continues to observe the task's declared success/error
contract; cancellation is never smuggled into `throws E`.

The first ownership tier supports immutable `in` value/native parameters across
suspension. A direct await stores a pointer into its stable suspended caller
frame. A spawned immutable borrow requires an explicit `async scope`; its owner
cannot move or mutate until every borrowing child joins. Multiple immutable
child borrows may share the same owner. A consuming `await task` or `await
task.cancel()` releases that child's borrow early; otherwise the scope's implicit
join releases it. Borrowed ARC class parameters intentionally use the ordinary
owned parameter form instead, which retains identity while preserving caller
access. A direct-awaited `inout` parameter stores a mutable pointer into the same
stable caller frame; the caller cannot resume until the callee finishes. A
spawned `inout` borrow requires an explicit async scope and grants one child
exclusive access until its explicit or implicit join. Mutations completed before
an error or cancellation remain visible—`inout` is not transactional. A non-throwing,
direct-awaited `out` parameter may similarly initialize cleanup-free caller
storage; every successful path must assign it before returning. Ownership-bearing
output waits for completion-time live-storage handoff lowering. Spawned `out`,
ARC-reference rebinding, borrowed struct receivers, growable-array-backed Slice,
and other live borrows remain rejected across suspension. Cross-thread executors
must prove sendability before any pointer-backed borrow can leave its originating
thread.
Owned values, ARC class references, owned closures, direct move-only native
values, and whole Z value structs or enums containing them may be stored in task
frames. Native
storage is aligned, placement-constructed, and destroyed exactly once according
to its semantic live flag. A typed take operation move-constructs the destination
and ends the moved-from object's C++ lifetime before its raw frame storage is
released. Owned call arguments use the same operation and placement-construct
their child-frame parameter slots when `await` or `spawn` creates the task;
`spawn` therefore owns its arguments before the child is first polled. Results
move through `return`, `return await`, and awaited caller bindings. Fallible
native tasks preserve that storage through `try await`, while
`attempt await` placement-constructs a non-trivial `Result<T, E>` in either a
named local or hidden expression slot; borrowed and consuming matches retain or
transfer the active payload accordingly. Cancellation destroys a completed
result if it was never claimed and destroys owned parameters even when a child
is cancelled before its body is polled. Cancellation of a scoped borrowing child
joins it before owner cleanup. Mutable scoped borrowing can grow from this
foundation without exposing general lifetime syntax.

An explicit async scope requires an async parent because scope exit implicitly
joins its children and may suspend. Async function exit does the same for root
children. `return` inside a nested scope exits the enclosing function after
structured child teardown. Async class methods retain `this` in their frame;
async struct methods initially require `move this`; static async methods have
no receiver.

The intended lowering uses typed heap frames, explicit poll states, and live
flags that preserve moves, ARC copies, and active enum payload destruction.
Direct awaits suspend their parent; hot `spawn` enqueues children immediately;
task handles join already-running frames. Class receiver frames retain `this`,
consuming struct receiver frames move it, and static methods carry no receiver.
Propagation redirects live siblings and descendants through their cleanup
states, while handled `attempt await` failures remain values and do not cancel
siblings. Awaited subexpressions normalize into hidden frame slots in
left-to-right evaluation order. Async-free programs should not link an async
runtime. Apple executors may integrate with Dispatch and the main run loop;
Windows executors may integrate with the thread pool and IOCP. Exact stage-0
lowering coverage is tracked separately in
[`docs/bootstrap-status.md`](docs/bootstrap-status.md#async-and-concurrency).

## Interop and backends

Z lowers through a shared typed IR. Native source backends may emit C, C++, or
Objective-C++ depending on the imported APIs and target. Swift interop should
use interfaces generated by the Swift toolchain rather than a home-grown Swift
ABI.

A JavaScript backend is a plausible future portability target, not a current
requirement or promise. It would reuse the frontend, type system, ownership
analysis, and backend-neutral IR rather than transpile generated C. JavaScript
lowering would need explicit representations for fixed-width integers, pointers,
deterministic cleanup, ARC and weak references, native imports, and structured
async. The native C-family path remains Z's systems-performance and deep-interop
target; a JavaScript backend must not weaken or redefine those language
semantics merely to imitate the JS runtime.

All native metadata producers normalize into the
[`Foreign Interface IR`](docs/foreign-interface-ir.md) before Z semantic
analysis. Clang declarations, API notes, Swift interfaces, and future package
metadata may differ as inputs, but ownership, nullability, lifetime, callback,
and native-identity contracts must have one validated representation. The
bootstrap now makes that boundary executable: Clang first emits raw declaration
records, API-note sources are parsed and conflict-checked independently, and a
contract normalizer is the only path to the FIIR consumed by sema, codegen, and
editor services. Native declaration locations and availability facts cross that
boundary as backend-neutral metadata: editor definitions can open project, SDK,
and generated headers, while explicit unavailability is diagnosed at the Z use
site. The first deployment-target slice is explicit project configuration:
`target.platform` and `target.minimumVersion` in `z.json` drive FIIR availability
checks and the matching native/Swift compiler flags. Introduced and obsoleted
APIs fail at the Z use site, deprecations warn, and an omitted target remains
unknown rather than inheriting an accidental host default. Cross-compilation and
runtime availability guards remain open design work.

Core language behavior and standard-library contracts remain target-neutral.
Compile-time target metadata will live behind an explicit `std/target` module
rather than magical platform globals. It will describe the selected OS,
architecture, ABI, pointer width, endianness, and toolchain environment so the
same frontend can support native and cross compilation. The exact enum and
compile-time-branch spelling remains deliberately open until that module lands.
Platform APIs continue to require explicit native imports; portable `std` APIs
may provide common contracts over them without erasing platform differences.

A `.hpp`, `.hh`, `.hxx`, or `.h++` import selects C++20 emission. The first C++
tier preserves native namespace paths and full free-function overload sets.
Unique leaf functions receive a convenient module-level alias, while qualified
access such as `library.desktop.calculate(...)` is always available. Colliding
leaf names are not flattened. Calls select a unique viable overload from
argument shape and type; `Z0803` reports no-match and genuine ambiguity with the
native candidates. Imported record and value types use the same hierarchy and
alias rule: `library.desktop.Point` is canonical, while `library.Point` exists
only when the leaf type name is unique across the module. Plain aggregate
structs import as Z value records. An ordinary selective import may bind a
top-level native namespace, as in
`import { desktop as ui } from "library.hpp";`; `ui.Point` and
`ui.calculate(...)` preserve the original C++ namespace and add no runtime
wrapper. The
original header remains the ABI declaration and the generated artifact builds
with `clang++`. The first RAII slice also imports opaque copyable values returned
by and passed to those functions. An adjacent `.zd` contract names an existing
native type without redeclaring layout and may constrain the lifecycle Clang
proves:

```z
declare module "library.hpp" {
  export type desktop.ManagedValue {
    copy;
    deinit;
  }
}
```

Omitting a capability denies it, and a contract cannot grant a capability the
native interface does not provide. FIIR records `copy`, `move`, and `deinit`
separately. Copyable RAII values use native copy construction and assignment.
Move-only RAII values participate in Z's single-owner analysis and lower owned
transfers to native C++ moves; moved-from storage remains valid for its ordinary
C++ destructor. Both forms may be nested in synchronously moved Z value structs.
Public C++ constructors plus static and instance
methods retain overload, availability, and source metadata in FIIR. Native value
construction uses `Type(args)`; `new` remains the signal for ARC-managed Z class
identity. Const instance methods borrow their receiver, non-const methods require
mutable addressable storage, and every supported call lowers directly to its
native C++ form. Move-only values are supported in synchronous locals, owned
parameters and returns, whole Z value structs, growable `Array<T>` buffers, and
named Z enum payloads. Native arrays allocate raw aligned storage, move-construct
elements during growth, destroy the old objects, and destroy initialized
elements in reverse order. Named enums use an explicit tagged-union lifetime
wrapper with deleted copying, native move construction/assignment, and active
payload destruction. These paths also compose with Z-managed fields: Z cleanup
runs before the enclosing C++ object's destructor. Compiler-provided
`Option<T>`/`Result<T, E>` reuse that non-trivial tagged-union lifetime wrapper.
ARC fields and owned closure environments remain separate storage tiers. Direct
move-only native locals and whole Z value aggregates containing them use aligned
placement storage inside async locals, owned parameter slots, and task results;
fallible results compose with `try await`, `attempt await`, hidden expression
slots, and match. Immutable scoped async parameters, direct-awaited or
scope-bounded spawned mutable parameters, and cleanup-free direct-awaited output
parameters borrow without a wrapper, retain, or copy; spawned output and
ownership-bearing output remain deferred.
Named-value `const T&`, `T&`, and move-only `T&&` parameters reuse Z's `in`,
`inout`, and owned-value capabilities. Receiver-qualified `const &`, `&`, and
move-only `&&` methods likewise map to borrowed, mutable, and consuming
receivers. C++ references are treated as call-scoped borrows across a trusted
native boundary; they do not themselves prove non-escape behavior. Reference
returns, copyable rvalue references, argument or receiver overload sets whose
selection changes capability, inheritance, user-defined conversions, and
templates remain later tiers.

On macOS, an installed framework header such as `AppKit/AppKit.h` selects the
Objective-C ARC backend and adds its framework to the native link plan. Imported
interfaces are ARC-managed reference values; superclass metadata is used for
foreign method lookup without adding inheritance to Z's own type system. The
bootstrap supports class and instance messages, property getters and setters,
`instancetype`, object nullability, contextual Objective-C string literals,
and an autorelease pool around `main`. Positional calls resolve a selector by
its first component and arity. A call may label every argument after the first
to spell the complete selector shape without repeating the first component:

```z
window.initWithContentRect(
  frame,
  styleMask: style,
  backing: AppKit.NSBackingStoreBuffered,
  defer: false
);
```

The first selector component remains the TypeScript-style method name. Labeled
calls resolve exact selector components and remove ambiguity. For now labels are
reserved for imported Objective-C methods so the bootstrap does not prematurely
freeze named-argument semantics for ordinary Z functions.

Imported nullable Objective-C references preserve their native one-pointer
representation and are displayed as `T | null`. Accessing a property or method
requires an explicit comparison with `null`; flow analysis narrows the non-null
branch (including the path after an early null return) and restores nullability
when branches rejoin. The spelling is accepted in imported Objective-C
reference fields, parameters, returns, and locals. It is the first restricted
optional form, not a commitment to arbitrary source-level unions.

An immutable binding to an Objective-C object fixes the reference but does not
claim that the foreign object is deeply immutable. Assignment to a writable
imported property therefore sends its Clang-declared setter, including custom
accessor names, while rebinding the local remains forbidden. A string literal
is emitted as an Objective-C `NSString` literal only when the receiving
parameter or property accepts `NSString` (or a compatible supertype). Otherwise
the literal is a Z `String`; raw Objective-C/C `cstring` parameters receive the
same call-scoped byte borrow used by C interop.

The first application-shaped ownership probe combines an ARC Z `Workspace`, an
owned growable array of move-only documents and strings, and a native AppKit
window. Its ongoing findings live in
[`docs/ownership-pressure.md`](docs/ownership-pressure.md). Imported non-null
Objective-C classes are nominal Z types and can be stored in ARC-managed Z
aggregates. General borrowed fields or slices still cannot escape; that
ownership question remains separate from the now-resolved foreign type-surface
gap.

The first empirical scoped-view experiment is
`eachDocument(in visit: (in document: Document) => void)`. It lowers each array
element to a `const Document *` for the duration of a contextual closure call,
so owned strings are inspected without copies or source lifetime syntax. This
is a good fit for enumeration, but its inversion of control is not treated as a
universal replacement for future retained or receiver-tied views.

The follow-up lookup probe compares `withDocument(id, callback)`,
`documentAt(index): view Document`, `document(id): Option<view Document>`, and
an owned `documentSnapshot(id)`. Generated C confirms every borrowed shape uses
`const Document *` without a string copy, while the snapshot allocates and
copies the selected title. Optional views niche-lower to that same pointer:
`NULL` is `none`, and `some(document)` inherits the receiver provenance during
`match (in result)`. This is a constrained borrowed container, not permission
for general view-bearing enum storage. The implemented `view` tier has one
provenance source: a synchronous borrowed value-struct receiver returning one
of its direct fields or indexed elements.
Last use ends the borrow; the view cannot be stored, returned again, or held
across receiver mutation or suspension. It can enter a synchronous `in T` call
or be read by an inline closure whose `in` destination proves it cannot escape;
neither form extends provenance beyond that call. Stored, owned, and escaping
captures remain rejected. ARC class
owners are excluded because aliases could invalidate projected growable
storage. This does not introduce general lifetime parameters or views that
survive backing-array reallocation.

Imported Objective-C block parameters contextually type Z closures. An escaping
block requires an owned `move` closure; a generated Objective-C ARC box retains
and releases the Z closure environment with the copied native block. The
desktop probe uses `NSOpenPanel.beginWithCompletionHandler` to mutate its owned
`Workspace` from a real AppKit completion event. This validates the first block
shape without prematurely choosing target/action or delegate syntax.

The next validated shape is a persistent `NSNotificationCenter` observer. Z
keeps the returned native token, weakly captures its ARC-managed application
state, handles repeated notifications, and explicitly removes the observer at
the end of the event-loop lifetime. Imported external Objective-C object
constants such as AppKit notification names retain their nominal interface
types in Z. Persistent callbacks do not imply detached lifetime: native token
ownership and unregistration remain visible in source.

Computed Z `String` values bridge contextually to Objective-C `NSString`
arguments and properties through their exact byte length, not `strlen`.
Converting a non-null `NSString` to an explicitly typed Z `String` always makes
a fresh owned UTF-8 copy; it never borrows `UTF8String` storage. The native
round-trip fixture preserves an embedded NUL byte and the desktop probe sets and
reads back a computed AppKit window title.

A conventional local `Module-Swift.h` compatibility header also selects the
Objective-C ARC backend. The bootstrap has an end-to-end fixture in which
`swiftc` builds a Swift dylib and generated header, Z imports its class,
initializer, method, and property, and the native executable links and runs.
This tier intentionally sees only declarations representable to Objective-C.
A nearby `z.json` may declare one Swift module, its sources, and required Apple
frameworks. Compiler and language-server analysis share the cached generated
header directory, and native runs link the produced dylib automatically. This
is the first build-manifest slice; dependency resolution and general Swift
Package integration remain separate from native Swift module import.
Manifest paths are relative to `z.json`, generated products live in a local
ignored `.z-cache`, and manifest or Swift-source modification times invalidate
both the Swift build and imported Clang metadata.

A Swift manifest may select `interop: "cxx"`. In that mode `swiftc` emits its
generated C++ compatibility header as `Module-Swift.hpp`, Z selects C++20, and
Swift-native copyable structs cross the boundary as ordinary native values. The
ownership probe uses a Swift struct containing a Swift class reference: Z
constructs it through its generated static `init`, calls const and mutable
instance methods, copies it, stores and copies it inside a Z struct, round-trips
it through Swift, and releases the shared reference exactly once after all
generated C++ wrappers leave scope. These calls reuse the existing C++ surface:
const methods borrow their receiver, mutating methods require addressable `let`
storage, and calls lower directly to generated C++ members. This validates a
thin native-value ownership and behavior path without a handwritten shim or a
home-grown Swift ABI. The current Swift toolchain deletes C++ move assignment
for these wrappers, so FIIR records `copy + deinit` and Z does not describe this
as Swift move support. A `swift::String` return may initialize an explicitly
typed Z `String`; lowering converts through Swift's generated C++ overlay and
makes an exact owned UTF-8 copy. The explicit destination makes the copy cost
visible and the length-aware conversion preserves embedded NUL bytes. Swift
`String` parameters remain unsupported because the current generated overlay's
C++ input constructor uses a null-terminated path; Z will not silently truncate
an owned string. Swift property sugar, generics, noncopyable values, protocols,
errors, async, and package import remain open vertical slices.

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
mutable storage and spell the capability at the call site:

```z
let point: geometry.Point;
geometry.reset(out point);
geometry.translate(inout point, 3, 4);
```

`in` forbids mutation and retention, `inout` requires initialized storage and
allows the callee to read and mutate, and `out` promises complete initialization
before return. These modes authorize a compiler-generated address for one call;
they do not introduce a general safe-code address-of operator.

The toolchain may ship internal notes for platform headers. Project-authored
contracts use adjacent `<header>.zd` Z declaration files with `declare module`;
there is no second project-sidecar format to keep synchronized.
Over time, Clang attributes, Apple's API notes, Windows SAL
annotations, package metadata, and generated bindings should populate the same
semantic model so the common case remains simply:

```z
import platform from "platform.h";
```

Selective imports keep large headers out of local scope without changing the
boundary model:

```z
import { sqlite3_open, sqlite3_close as closeDatabase } from "sqlite3.h";
import { sqlite3 as Database } from "sqlite3.h";
```

This binds only those C declarations. Functions, supported typedef-named
records, enums, scalar typedefs, and enum constants can share the same import
list and can each be aliased. Aliases affect only Z source: generated C uses the
original declaration spelling, and aliases preserve C type identity across
selective and namespace imports. Namespace imports remain useful when
provenance and breadth matter.

Imported C data follows Z expression syntax whether it is namespaced or
selective: typedef-named records can appear in signatures, are built with
checked struct literals, and expose imported fields; C enum constants become
typed values. The native compiler still includes the original header, so it
does not redeclare layouts or guess padding and calling conventions. A future
explicit contract uses a TypeScript-shaped ambient declaration:

```z
declare module "vendor.h" {
  export function vendor_version(): i32;
}
```

The declaration describes an externally implemented module; a normal `import`
still chooses its local namespace or selective bindings. Header-backed
declarations augment Clang's raw facts and must agree with every ABI property Z
can verify. They may supply missing ownership, lifetime, release, and callback
facts, but cannot override contradictory native facts. Operations whose memory
or lifetime safety remains unverifiable require the separate `unsafe` boundary.
`extern` is not currently part of the accepted user-facing grammar; ABI and
linkage remain inferred contract metadata unless a future binary-only boundary
needs them explicitly. Handwritten declarations and raw operations remain
escape hatches rather than the routine function and data interop path.

Interop work proceeds in architectural layers:

1. Direct header syntax with native compilation.
2. Clang-AST symbol and layout import.
3. Ownership and lifetime API notes.
4. Objective-C methods, properties, protocols, blocks, and ARC conventions
5. C++ namespaces, records, RAII values, overloads, methods, and selected
   templates.
6. Callback-to-async synthesis.
7. Swift-authored Objective-C compatibility-header import through the
   Objective-C path.
8. Swift-native copyable value ownership through the generated C++ interface.
9. Broader Swift module/interface and Swift Package import for Swift-only APIs,
   methods, strings, protocols, generics, errors, and concurrency.

Completed slices and precise unsupported boundaries are tracked in
[`docs/bootstrap-status.md`](docs/bootstrap-status.md#foreign-interfaces).

## Initial non-goals

- inheritance for Z-defined types (foreign superclass metadata is imported);
- production async scheduling, cancellation, I/O reactors, and CPU-parallel execution;
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
2. **Stage 1:** With source modules and the first safe file/process/argv
   contracts now implemented, move portable standard-library behavior and a
   small frontend component into the supported Z subset of structs, tagged
   enums, matching, generics, and collections. Keep OS/ABI calls behind a thin
   platform substrate.
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
Document diagnostics should be debounced because importing a large SDK header
must not run once per keystroke. Imported-header definitions should use Clang
declaration source locations rather than text-searching SDK headers. Current
editor coverage is tracked in
[`docs/bootstrap-status.md`](docs/bootstrap-status.md#modules-and-tooling).

## Bootstrap implementation status

The stage-0 capability matrix, temporary lowering limits, validation probes, and
near-term implementation order live in
[`docs/bootstrap-status.md`](docs/bootstrap-status.md). Keeping that report
separate prevents current compiler breadth from silently becoming language
semantics.

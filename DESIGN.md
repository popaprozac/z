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
compiler-validated release hook. Noncapturing closures need no environment.

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

Fields default to `public`; `private` fields are visible only within the
declaring class and require an explicit constructor. Constructor analysis tracks
definite initialization across successful branches, rejects reads of
uninitialized fields and escape of incomplete `this`, and returns the completed
instance implicitly. Throwing constructors use `Result<Class, Error>` through
ordinary `try` and `attempt`. Lowering maintains per-field liveness so failure
destroys only initialized cleanup-bearing fields before reclaiming incomplete
class storage.

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
Capture-list sugar, automatic ORC cycle collection, and atomic cross-thread
weak upgrades remain separate future layers.

Pattern matching exposes ownership explicitly. `match value` consumes a
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

`Array<T>()` explicitly creates a growable owned buffer; array literals remain
fixed inline arrays. `Array<T>` carries its allocation, initialized length, and
capacity as one move-only value. `push` requires addressable `let` storage,
checks capacity arithmetic, grows geometrically, and transfers or copies the
element according to its ordinary ownership rules. Safe indexing uses the same
bounds check as fixed arrays. Destruction walks initialized elements in reverse
order before freeing the buffer.

A growable array can be borrowed as `Slice<T>` for a non-escaping call. The
first slice intentionally omits removal, reservation, and fallible allocation;
those APIs need an optional/result and allocator policy rather than sentinel
values. Allocation failure currently traps. Escaping slices, subslices, and
returned views require an explicit inferred or declared lifetime contract
informed by real APIs. `T[]` remains unassigned until those contracts are proven.

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

The focused time module provides an explicitly blocking delay:

```z
import { sleep } from "std/time";

sleep(100);
```

`sleep(milliseconds: u64): void` blocks the current OS thread and lowers to
`Sleep` on Windows or interruption-safe `nanosleep` on POSIX platforms.
Async delay remains a separate scheduler-aware operation so this synchronous
API never changes behavior based on calling context.

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
fallible or suspending shutdown remains an explicit async operation.

The first ownership tier rejects borrowed async parameters and borrowed struct
receivers, and rejects suspension while any other borrow is live. Owned values,
ARC class references, and owned closures may be stored in task frames. This
conservative boundary can later grow scoped async borrowing without exposing
general lifetime syntax.

An explicit async scope requires an async parent because scope exit implicitly
joins its children and may suspend. Async function exit does the same for root
children. `return` inside a nested scope exits the enclosing function after
structured child teardown. Async class methods retain `this` in their frame;
async struct methods initially require `move this`; static async methods have
no receiver.

Phase 0 implements syntax, typing, ownership diagnostics, and editor services.
Phase 1 lowers owned async functions and methods to typed heap frames and
explicit poll states, driven by a deterministic single-thread FIFO executor.
Direct awaits suspend their parent; hot `spawn` enqueues children immediately;
task handles join an already-running frame. Scalars, value structs, ARC class
references, and enums with cleanup-bearing payloads may be parameters, locals,
and success values; errors are currently cleanup-free. Frame live flags
preserve moves and ARC copies, while tag-directed destruction handles active
`Option<T>` and `Result<T, E>` payloads. Class receiver frames retain `this`,
consuming struct receiver frames move it, and static methods carry no receiver.
Function exit implicitly joins non-throwing root children; throwing children
must be acknowledged explicitly. Frames lower `throw`, `try await`, `attempt
await`, and payloadless `void` success. Valid shapes beyond the active native
tier report `Z0700`. Async-free programs do not link an async runtime. Apple
executors may integrate with Dispatch and the main run loop; Windows executors
may integrate with the thread pool and IOCP.

## Interop and backends

Z lowers through a shared typed IR. Native source backends may emit C, C++, or
Objective-C++ depending on the imported APIs and target. Swift interop should
use interfaces generated by the Swift toolchain rather than a home-grown Swift
ABI.

Core language behavior and standard-library contracts remain target-neutral.
Compile-time target metadata will live behind an explicit `std/target` module
rather than magical platform globals. It will describe the selected OS,
architecture, ABI, pointer width, endianness, and toolchain environment so the
same frontend can support native and cross compilation. The exact enum and
compile-time-branch spelling remains deliberately open until that module lands.
Platform APIs continue to require explicit native imports; portable `std` APIs
may provide common contracts over them without erasing platform differences.

A `.hpp`, `.hh`, `.hxx`, or `.h++` import selects C++20 emission. The first C++
tier preserves namespace-qualified names for uniquely named free functions and
imports plain aggregate structs as Z value records. The original header remains
the ABI declaration and the generated artifact builds with `clang++`. Overload
selection, constructors, methods, references, RAII values, inheritance, and
templates remain explicit later tiers; an ambiguous function name is rejected
rather than silently choosing a declaration.
The next namespace tier should preserve the native hierarchy at the Z surface,
for example `library.desktop.calculate`, before overload resolution is added.

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

An immutable binding to an Objective-C object fixes the reference but does not
claim that the foreign object is deeply immutable. Assignment to a writable
imported property therefore sends its Clang-declared setter, including custom
accessor names, while rebinding the local remains forbidden. A string literal
is emitted as an Objective-C `NSString` literal only when the receiving
parameter or property accepts `NSString` (or a compatible supertype). Otherwise
the literal is a Z `String`; raw Objective-C/C `cstring` parameters receive the
same call-scoped byte borrow used by C interop.

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
`unsafe raw { ... }` facility may cover operations the semantic importer cannot
represent, but routine function and data interop must not require it.

Interop work proceeds in layers:

1. Direct header syntax with native compilation.
2. Clang-AST symbol and layout import.
3. Ownership and lifetime API notes.
   Call-only C function-pointer parameters with ABI-compatible scalar/value
   signatures are implemented; unannotated or escaping callbacks remain
   rejected.
4. Objective-C methods, properties, protocols, blocks, and ARC conventions
   (ARC methods, labeled selectors, properties, and contextual string literals
   implemented).
5. C++ namespace functions and plain value records (first tier implemented),
   followed by RAII, overloads, methods, and selected templates.
6. Callback-to-async synthesis.
7. Swift-authored Objective-C compatibility-header import through the existing
   Objective-C path (generated-header compiler/runtime probe and initial
   `z.json` Swift build/link plan implemented).
8. Native Swift module/interface and Swift Package import for Swift-only APIs,
   value types, protocols, generics, errors, and concurrency.

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
2. **Stage 1:** With source modules now implemented, once Z also has safe
   file/process APIs, reimplement the frontend in the supported Z subset of
   structs, tagged enums, matching, generics, and collections.
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
The initial Bun stdio server now shares compiler diagnostics and analyzed
expression types, and exposes imported namespace members, type-directed Z and
Objective-C members, selector snippets and labels, hover, and same-file
definitions. It also publishes compiler-backed semantic tokens and completes
bare local bindings, so editor symbol awareness does not begin only after a
member-access dot. Document diagnostics are debounced because importing a large SDK
header must not run once per keystroke. Imported-header definitions will use
Clang declaration source locations rather than text-searching SDK headers.

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
- cleanup-aware `while`, `break`, and `continue` with loop ownership analysis.
- fixed arrays with checked indexing and deterministic element cleanup.
- non-escaping `Slice<T>` parameters with shared and exclusive borrow checking.
- argument-inferred generic function calls and explicit generic aggregates with
  C monomorphization.
- statically dispatched nominal trait constraints on generic parameters.
- growable owned `Array<T>` buffers with checked indexing and deterministic
  element cleanup.
- enum-valued fields, fixed arrays of enums, and nested copyable or
  cleanup-bearing enum payloads with dependency-ordered native layouts and
  active-variant destruction.
- explicit source-module exports, selective and namespace imports, recursive
  graph loading, private symbol identities, and cross-file editor navigation.
- checked integer arithmetic with constant diagnostics plus explicit wrapping
  and saturating operations.

### 0.25: Portable object model

- ARC-managed classes with reference identity;
- definite, optionally throwing class constructors with partial-initialization cleanup;
- public and private class fields with compiler and editor enforcement;
- public and private type-scoped static methods on structs and classes;
- class lifecycle lowering and deterministic final `deinit`;
- zeroing `Weak<T>` handles with typed upgrade failure and weak closure capture;
- traits with explicit, statically checked `implements` conformance;
- compiler and editor awareness for class and trait declarations;
- trait values and dynamic dispatch deferred until real APIs shape them.

### 0.3: Safe native import

- Clang-backed header modules;
- target layout and calling conventions;
- nullability and ownership contracts;
- typed synchronous call-only C callbacks (first ABI-compatible tier
  implemented);
- ARC-owned Z closure environments (implemented);
- generated call-only C context adapters (implemented);
- caller-thread escaping C callbacks with native destroy notification
  (implemented);
- calling-convention, unregister-token, cross-thread, and async adapters.

### 0.4: Async frontend and structured runtime

- Phase 0 async syntax, typing, task handles, ownership restrictions,
  diagnostics, and editor services (implemented);
- scalar sequential stackless state-machine lowering and deterministic root
  runner (implemented);
- Result-carrying scalar task frames (implemented);
- cleanup-free aggregate task frames (implemented);
- cleanup-bearing struct, enum, and ARC class frames (implemented);
- receiver-aware async method frames (implemented);
- ready-queue executor, executable `spawn`, and implicit root joins (implemented);
- structured task scopes, cancellation, and deterministic frame cleanup;
- scheduler-aware delay and bounded move-aware channels;
- sendability, atomic ARC, and pluggable native executors;
- callback-to-async synthesis and actor isolation.

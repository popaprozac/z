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
callback, native-status error projection, and async semantics that are absent
from the header itself.

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

Object binding patterns follow TypeScript's field and alias spelling:

```z
const { path, revision } = record;
const { path: localPath } = record;
```

The first tier is deliberately ownership-visible. Cleanup-free structs may be
destructured directly. A named cleanup-bearing struct requires `copy record`
to retain the source or `move record` to consume it. Pattern bindings receive
the selected fields, while unselected fields are destroyed. Types with custom
`deinit`, foreign owned-handle cleanup, or embedded C++/Swift value storage are
rejected until partial relocation can preserve their exact cleanup contract.
Classes, nested/rest/default/array patterns, and parameter patterns remain later
extensions.

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

Expected types also flow inward through direct generic function arguments and
through ternary, value-producing `if`, and expression-`match` branches. This
lets `const value: Option<i32> = preserve(absent());` infer both calls without
explicit type arguments while retaining left-to-right argument checking.

Function parameters, exported return types, struct and class fields, FFI
boundaries, empty collections, and uninitialized storage remain explicit.
Capabilities describe ownership and access rather than ordinary value types,
so they are not inferred from the closure body. For example, a closure assigned
to `(inout value: Counter) => void` must still spell `(inout value) => ...`.
An untyped closure without a destination contract receives a diagnostic asking
for either `parameter: Type` or an explicit function value type.

Integer value conversion uses target-type construction rather than assertion
syntax:

```z
const nativeCount = isize(values.length);
```

This is an executable conversion, analogous to JavaScript's `Number(value)`,
not TypeScript's erased `value as number` assertion. Non-literal integer widths
do not convert implicitly. Construction preserves the mathematical value or
traps; a source range wholly contained by the target lowers to a direct cast,
while narrowing and signedness-risk conversions receive a runtime range check.
Intentional truncation/saturation and floating-point conversion remain separate
operations so neither bit loss nor rounding hides behind the ordinary form.

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
| immutable borrow | `in value: T` | `inspect(value)` or `inspect(in value)` | Read-only, non-escaping borrow for the call. |
| mutable borrow | `inout value: T` | `update(inout value)` | Exclusive read/write borrow for the call. |
| output | `out value: T` | `create(out value)` | Callee fully initializes storage. |
| consuming receiver | `move this` | `value.consume()` | Receiver ownership transfers; copyable values copy. |

Capabilities precede parameter bindings because they modify access to storage,
not the value's type. The annotation after `:` is always a type.

`in` is inferred at the call site because it cannot change ownership or caller
storage, but `inspect(in value)` is accepted as an equivalent explicit spelling.
`inout` and `out` remain required at free-function calls because their effects
are externally visible. Borrowed bindings cannot move into returns, owned
parameters, or owning fields. Borrowed cleanup-bearing parameters do not run
cleanup; their owner remains responsible.

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
releases rather than defining another aliasing policy. Child-task `out`, suspended
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

Value-struct fields may carry ordinary Z default expressions:

```zs
struct RequestOptions {
  retries: i32 = 3;
  labels: Array<String> = Array<String>();
}

const defaults = RequestOptions();
const explicitEmpty = RequestOptions({});
const custom = RequestOptions({ retries: 5 });
```

An omitted field evaluates its default independently at the construction site;
an explicit initializer suppresses that default. Consequently cleanup-bearing
defaults create fresh owners rather than shared template storage, flow through
ordinary move/deinit analysis, and are destroyed with the containing value.
`Type()` means zero-argument value construction and is accepted only when all
fields have defaults. Defaults are checked even if the type is never
constructed, cannot refer to `this` or sibling fields in the first tier, and
specialize with their generic aggregate. C-layout records cannot attach Z
defaults. Class-field defaults remain deferred until synthesized and declared
constructors share one cleanup-safe initialization rule.

Optional presence on a value struct uses `field?: T`. It preserves that source
fact for tooling and foreign adapters while storing an ordinary `Option<T>`.
Omission initializes `Option.none`; a supplied `T` is contextually lifted to
`Option.some(T)`, and an explicit `Option<T>` remains valid. This differs from
`field: Option<T>`, which is still required unless it declares a default.
Cleanup-bearing direct values move through the same enum-payload ownership path
as an explicit `Option.some`. Optional fields cannot also declare an explicit
default, and the first tier excludes class and C-layout fields. Native Z
optionality remains distinct from nullable foreign references.

Optional chaining uses `receiver?.member` and `receiver?.method()` for
conditional immutable access through either `Option<T>` or a nullable foreign
reference. A value result becomes `Option<U>`, an existing `Option<U>` result
flattens, and `void` performs a no-op when absent. Nested chains therefore
compose without creating `Option<Option<U>>`. A stored cleanup-bearing field
projects as `Option<view U>` tied to a named receiver owner; a method-created
owned result remains `Option<U>`. The receiver is evaluated once.

`throws E` remains an independent effect: an absent receiver is successful
`none`, while a present receiver may still produce `failure E`, so `try` and
`attempt` remain explicit at the call site. The first tier rejects `inout this`
and `move this` methods through `?.`; an explicit `match` must expose mutation
or ownership transfer. This keeps optional chaining as compact control-flow
sugar rather than a hidden capability-changing operation.

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

`readonly` fields may be initialized by synthesized construction or assigned
once by an explicit constructor, but cannot be replaced or mutated afterward.
The compiler infers a class as cross-thread shareable only when its complete
reachable graph is readonly, has no mutable receiver methods, contains no
mutable collection storage or uncontracted native identity, and has no custom
`deinit`. Shareable classes use atomic strong ARC operations; ordinary mutable
classes keep lower-cost local ARC. This is structural compiler evidence rather
than a user-asserted `Send` or `Sync` marker.

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
Traits may introduce type parameters, such as `Iterator<T>`, and concrete
conformance is checked against the specialized contract. This remains static
conformance only: concrete values call their concrete methods, while trait-typed
storage, existential representation, and dynamic dispatch remain later design
work. Z-defined classes intentionally do not have inheritance.

The keyword remains `trait`, not TypeScript's `interface`, deliberately. Z uses
TypeScript-inspired surface syntax, but its behavior contracts are nominal and
apply equally to value structs and ARC classes. `interface` would imply
TypeScript's structural compatibility, object-shape typing, and declaration
merging where Z provides none. The word remains available if a future,
separately designed structural boundary type proves useful; foreign Objective-C,
Swift, and C++ interface metadata continues to enter through FIIR rather than
changing this source-level contract.

## Control flow

Conditions are statically typed `boolean` expressions. `if`/`else` and `while`
retain TypeScript-like spelling, while `break` and `continue` target the nearest
enclosing loop. A control transfer first cleans every local scope it exits, so
deterministic destruction is preserved on normal iteration, `break`,
`continue`, `return`, `throw`, and `try` propagation.

Statement `if` and `else` bodies may be either blocks or one statement. `else`
binds to the nearest unmatched `if`, following TypeScript. Value-producing `if`
expressions continue to require blocks and explicit `select` values.

`while` and `for...of` also have value-producing forms. Their required `else`
block supplies the natural-exhaustion value, while `select` exits the loop
expression with a value:

```z
const firstEven: Option<i32> = for (const value of values) {
  if (value % 2 == 0) {
    select Option.some(value);
  }
} else {
  select Option.none;
};
```

Every reachable `select` and the exhaustion block must agree on one result
type. `continue` starts the next iteration. A plain `break` is rejected in a
value-producing loop because it would not supply a value; `return` and `throw`
retain their function-level meanings. The initial executable tier is
synchronous. Async iteration and suspension inside a value-producing loop
remain separate design work.

Ownership analysis computes a fixed state across loop back-edges. An owned value
that may move during one iteration cannot be reused during a later iteration
unless every continuing path restores ownership. State after a loop merges the
zero-iteration path with every reachable `break` path.

Collection iteration uses TypeScript-style `for...of` over fixed arrays,
`Array<T>`, `Slice<T>`, `Map<K, V>`, and `Set<T>`:

```z
for (const value of values) {
  use(value);
}
```

Primitive and other copyable elements copy into the immutable loop binding.
Cleanup-bearing elements remain borrowed from their collection and cannot move
out. The collection is structurally borrowed for the loop, so an `Array.push`
that could reallocate storage is rejected until iteration ends. `break` and
`continue` retain cleanup-aware loop semantics.

Direct `Map` iteration exposes a borrowed `Map.Entry<K, V>` with readable
`key` and `value` fields. Direct `Set` iteration exposes a borrowed `T`.
Map/Set bindings always borrow their stored element—even when its fields are
cleanup-free—and structural mutation is rejected until the loop exits. Their
iteration order is deliberately unspecified; the hashed collections do not
promise JavaScript's insertion ordering.

Object destructuring uses the same binding-pattern grammar for locals and
iteration:

```z
const { path, revision } = record;

for (const { key, value } of records) {
  use(key, value);
}
```

The loop pattern inherits the collection's access: cleanup-free fields load by
value, while cleanup-bearing fields remain borrowed and cannot move out. This
preserves the same copy-versus-borrow decision as a whole-element binding and
never silently transfers a stored owner.

Custom synchronous iteration uses the nominal generic trait imported from
`std/iteration`:

```z
import { Iterator } from "std/iteration";

struct Countdown implements Iterator<i32> {
  current: i32;

  function next(inout this): Option<i32> {
    if (this.current == 0) return Option.none;
    const value = this.current;
    this.current = this.current - 1;
    return Option.some(value);
  }
}

let countdown = Countdown({ current: 3 });
for (const value of inout countdown) {
  use(value);
}
```

`Iterator<T>.next(inout this)` makes traversal-state mutation part of the
contract. A stored value iterator therefore requires `let` storage and explicit
`of inout iterator`; this visually exposes the mutable loan and prevents moving
or mutating that iterator during the loop. A temporary iterator has unique
compiler-owned storage and omits `inout`:

```z
for (const value of Countdown({ current: 3 })) {
  use(value);
}
```

Each `some` payload transfers into an owned immutable loop binding and is
destroyed at the end of that iteration when necessary. The iterator remains
usable after the loop. Built-in collections retain their borrowed-element
semantics and do not accept `of inout`; they are not retrofitted through a
mutable user-visible cursor merely to share syntax.

Compiler-lowered generators expose the same pull-based iteration shape without
requiring a user-written cursor struct:

```zs
import { Generator } from "std/iteration";

function identifiers(count: i32): Generator<i32> {
  let current = 1;
  while (current <= count) {
    yield current;
    current = current + 1;
  }
}

const values = identifiers(3);
for (const value of values) {
  console.log(value);
}
```

`Generator<T>` is the real return type. Calling the function allocates and
returns a cold, uniquely owned suspended frame; the body starts on `next()` or
the first `for...of` advance. It satisfies `Iterator<T>` for generic iterator
algorithms. Unlike an ordinary stored value iterator, its
cursor is hidden behind the generator handle, so a stored `const` generator
uses ordinary `of values` syntax rather than `of inout values`. The handle
cannot be copied. Exhaustion or explicit `return;` destroys initialized frame
locals, and dropping the generator early runs the same cleanup before releasing
the frame.

The presence of `yield` selects frame lowering. A function with the same
`Generator<T>` return type but no `yield` is an ordinary function and may
forward an existing generator with `return otherGenerator();`.

Generators that need a terminal result state it as a second type argument:

```zs
function tokenize(source: String): Generator<Token, ParseSummary> {
  while (...) {
    yield token;
  }
  return summary;
}
```

Their `.next()` operation returns the compiler-provided
`GeneratorStep<Yield, Return>` enum:

```zs
match (tokens.next()) {
  yielded(token) => consume(token);
  complete(summary) => finish(summary);
}
```

`yielded` and `complete` are enum variants, not keywords. The terminal value is
transferred exactly once, and all reachable paths must return it.
`Generator<Yield, Return>` does not implement `Iterator<Yield>` and direct
`for...of` is rejected because that would silently discard the completion
value. The one-argument `Generator<T>` remains the sequence-oriented
`Iterator<T>` form with `next(): Option<T>`.

Fallibility remains a property of the generator declaration:

```zs
function rows(): Generator<Row> throws DatabaseError {
  yield row;
  throw error;
}
```

Calling `rows()` only constructs the cold handle and therefore does not require
`try` or `attempt`. Advancing it does:

```zs
const rows = rows();
const next = try rows.next();
```

The explicit stored type is `Generator<Yield, Return, Error>`, with `void` in
the return slot for a value-only sequence. `.next()` returns
`Result<Option<Yield>, Error>` or
`Result<GeneratorStep<Yield, Return>, Error>`. Throwing generators do not
implement `Iterator` and direct `for...of` remains rejected until an explicit
propagation syntax is chosen.

The first tier is synchronous. Parameters transfer owned values into the cold
frame. Built-in collection `for...of` loops persist their cursor and borrowed
element projection across suspension, and statement `match` persists tagged or
niche-encoded payload bindings with exact-once cleanup. Custom iterators that
suspend inside their loop body and value-producing match expressions remain
deferred because their owned iterator/selection temporaries also need explicit
frame slots. Borrowed inputs, generator methods, borrowed yielded values, and
values sent back into a suspension remain later work.

Asynchronous generators retain that protocol and add suspension authority
explicitly:

```zs
async function events(): AsyncGenerator<Event, Summary> throws StreamError {
  const batch = try await fetchEvents();
  yield batch.first;
  return Summary({ count: 1 });
}
```

The two declarations have deliberately different call protocols:

- `async function operation(): T` constructs a one-shot `Task<T>`.
- `async function sequence(): AsyncGenerator<Y, R>` constructs a cold,
  reusable asynchronous sequence handle.

`AsyncGenerator` construction does not execute the body and does not throw.
Its `.next()` returns a one-shot `Task<Option<Y>>` or
`Task<GeneratorStep<Y, R>>`; an error parameter adds `E` to that task.
Awaiting the task resumes the persistent sequence frame until `yield`, terminal
`return`, or `throw`. This keeps `async` concise and consistent as the marker
that authorizes `await`, while the return type states whether the declaration
is a task or a stream.

The current lowering prohibits concurrent advancement. Persistent
`if`/`while`, `break`/`continue`, built-in collection `for...of`, and borrowed
statement-match payloads survive across `yield` and `await`. A nonthrowing
`AsyncGenerator<Y>` without a terminal value supports sequential
`for await (const value of stream)`: each iteration awaits exactly one
advancement, temporary handles are loop-owned, stored handles survive early
`break`, and all exits preserve exact-once cleanup. A throwing
`AsyncGenerator<Y, void, E>` uses
`try for await (const value of stream)`, requires an enclosing `throws E`, and
propagates an advancement error after exact-once yielded-value and stream-frame
cleanup. A plain `for await` never propagates implicitly, while `try for await`
rejects a nonthrowing stream as unnecessary. Terminal-returning streams retain
explicit `.next()` consumption so no terminal result is silently discarded.
Local recovery likewise remains explicit `attempt await stream.next()`.
Cancelling a caller awaiting an advancement cancels and joins it before
destroying the stream frame.

An open design item is recovery-oriented iteration over fallible synchronous
and asynchronous sequences. The candidate spellings are `attempt for...of` and
`attempt for await...of`, potentially paired with an `else` branch. Before
committing that surface, Z must decide whether `else` means natural exhaustion,
captured failure, or both; how the error is bound; what value-producing loops
select on each outcome; and how partial progress and cleanup remain visible.
This is intentionally recorded for later deliberation rather than inferred
from `try for await`.

`for await (const { field, other: local } of stream)` consumes each yielded
value struct and transfers selected fields into frame-backed pattern bindings.
Selected owned fields are cleared in the hidden aggregate; unselected fields
remain there, so pattern bindings and the remainder each clean up exactly once
on every exit. Moving a selected binding in the body clears only that binding's
live state. Structs with custom `deinit`, native RAII value fields, or opaque
foreign cleanup remain whole-value-only because their partial destruction
contract is not compiler-derivable. Async consuming matches now move their
subject into hidden frame storage, transfer a whole selected payload into
arm-owned storage, and keep object-pattern fields borrowed from the hidden
payload. Only the selected value-producing arm may suspend before its final
expression or `select`; live flags preserve exact cleanup through normal
selection, loop exits, return, propagation, and cancellation. Selected results
may themselves own ARC identity, strings, Z values with `deinit`, or move-only
native storage; a directly awaited owned result transfers its suspension slot
into the destination before arm cleanup. Async generator methods, richer async
patterns, and borrowed inputs/yields remain following layers.

The source-inspector pressure test uses this complete synchronous protocol to
tokenize real Z source on first advancement, yield owned `Token` values, return
a `GeneratorScanSummary`, and propagate `LexerError`. It iterates the lexer's
owned token array with natural `for...of`; the compiler-owned cursor and
borrowed `Token` projection live in the generator frame, while `yield copy
token` makes the transfer to the caller explicit.

Mutable element iteration, consuming iterators, cleanup-bearing object
destructuring, move-only foreign iterator elements, array and tuple patterns,
and async iteration over non-generator iterator shapes remain later layers.

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
the join. A child task requires `async scope`; immutable Slice tasks may share the
backing array, while an `inout Slice<T>` task has exclusive access until join,
cancellation, or scope exit. The first executable backing-storage tier is a
cleanup-free fixed array in an async frame. Growable arrays and cleanup-bearing
fixed-array elements require their own async-frame cleanup lowering.

`Array<T>()` explicitly creates an empty growable owned buffer, while
`Array<T>(first, second)` constructs a populated growable buffer and array
literals remain fixed inline arrays. Constructor elements are evaluated in
source order and transfer or copy according to the same ownership rules as
`push`. `Array<T>(value)` therefore means one initialized element, not reserved
capacity; a future reservation operation will use an explicitly named factory.
`Array<T>` carries its allocation, initialized length, and capacity as one
move-only value. `push` requires addressable `let` storage, checks capacity
arithmetic, grows geometrically, and transfers or copies the element according
to its ordinary ownership rules. Safe indexing uses the same bounds check as
fixed arrays. Destruction walks initialized elements in reverse order before
freeing the buffer.

A growable array can be borrowed as `Slice<T>` for a non-escaping call. A local
may name a direct field or element projection with
`const value = view owner.items[index]`; a value-struct method may also return a
direct projection as `view T`. A synchronous non-throwing module function may
return a direct projection from one or more immutable `in` value-struct
parameters. When different return paths select different parameters, the
caller conservatively loans every possible source owner until the result's last
use; the runtime result remains one pointer and carries no provenance tag. The
compiler ties each read-only view to its named value-storage owner or owners and
prevents invalidating mutation until last use.
The local form lowers to `const T *` and does not copy the projected value. The
same pointer representation survives read-only `Array<T>` indexing, length,
and iteration plus read-only `String` inspection, comparison, and formatting;
an explicit `copyBytes` remains the operation that produces an owned String.
This is intrinsic composition over the existing owner loan, not a general
stored-borrow or lifetime mechanism. The
first slice intentionally omits removal, reservation, fallible allocation,
escaping slices, subslices, class-owned views, and general lifetime parameters.
Allocation failure currently traps. `T[]` remains unassigned until those
broader contracts are proven.

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
parameters are supported inside fields and methods. Instance methods may declare
their own type parameters, including on a generic owner, and static methods may
do so on a non-generic owner. Calls infer those method arguments or accept an
explicit `value.method<T>()` / `Utility.method<T>()` specialization. A static
method whose owner and method both introduce independent generic parameters is
deferred until its source spelling is designed; Z does not guess how one angle
list should be divided between them. Constraints use nominal traits and are
checked on every inferred or explicit instance. Generic traits are
monomorphized at each referenced specialization; specialization policy and
cross-module instance ownership remain future layers. Generated instance names
are backend details and do not form part of Z's source or ABI contract.

Transparent named aliases give an existing type a readable source name:

```z
type Transform = (value: i32) => i32;
```

Aliases improve public signatures—especially capability- and error-bearing
function values—without adding runtime representation, nominal identity, or an
implicit conversion. They work locally and through selective or namespace
module imports, preserve nested collection and function capabilities, and may
name structs/classes for construction and static lookup. Recursive alias graphs
are rejected. Generic alias parameters remain a later extension; aliases remain
distinct from future opaque/newtype design.

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

Integer type construction is the explicit width-conversion surface:

```z
const nativeCount = isize(count);
const eventType = u32(events.SDL_EVENT_QUIT);
```

It lowers directly when the complete source range is representable and traps
on an out-of-range narrowing conversion. Nominal imported C enums may convert
outward through their Clang-proven ABI integer representation. They do not
implicitly become integers, and integer-to-enum construction remains rejected
because range checking alone cannot prove that the value names a valid case.

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
type. `select` belongs to local value-producing control flow; `yield` suspends
the enclosing synchronous generator and transfers one yielded value to its
consumer. In `Generator<Yield, Return>`, `return expression;` separately
transfers the terminal completion value.

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

Capture discovery is lexical across nested closures. When an inner closure
uses an outer binding, each intervening closure automatically forwards the
capture with its inferred read or mutation capability. Source-level relay
aliases are unnecessary. Forwarding does not erase a boundary: every
intervening escaping closure must still own its environment, every native
thread transfer must still pass transfer checking, and executor-bound identity
remains unusable outside its placement. Closure parameters and locals shadow
outer bindings before capture forwarding is computed.

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

Cross-process filesystem locking follows the same resource vocabulary:

```z
import fs from "std/fs";

const lock = try fs.lock(".z-cache/build.lock");
publishArtifacts();
lock.unlock();
```

`fs.lock` blocks the current OS thread while acquiring an exclusive kernel
lock. The returned `fs.Lock` is move-only and releases automatically through
deterministic cleanup on scope exit, propagation, and early return. The
optional consuming `unlock()` method releases earlier and makes later use a
compile error. The path names the shared lock identity; the file itself may
remain after release. This is an interprocess artifact primitive, not a
shared-memory synchronization abstraction. Mutexes, read/write locks, atomic
values, condition variables, and semaphores belong to a future explicit
`std/sync` module whose guard values should use the same move-only cleanup
model.

Artifact publication uses a separate typed operation:

```z
try fs.writeText(".z-cache/program.pending", generated);
try fs.replace(".z-cache/program.pending", ".z-cache/program");
```

`fs.replace(source, destination)` atomically changes the destination directory
entry to name the source artifact and removes the source path on success. Both
paths must be on the same filesystem; cross-filesystem copying is deliberately
not hidden behind this API. An existing destination is replaced, while any OS
failure is a typed `String` error. The atomic namespace transition prevents
observers from reading a partially written artifact, but it is not by itself a
power-loss durability guarantee.

Cooperative scheduling is explicit and timer-free:

```z
import { scheduler } from "std/async";

await scheduler.yield();
```

This saves the current task frame, returns it to the back of its existing
executor's ready queue, and creates a cancellation-observation point. It does
not sleep, hop executors, create a child, or yield a generator element.

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
// geometry.zs
export struct Point { x: i32; y: i32; }
export function total(in point: Point): i32 { return point.x + point.y; }
```

```z
import geometry from "./geometry.zs";
import { total as sum } from "./geometry.zs";
```

The bootstrap recognizes explicit relative paths ending in `.zs`, recursively
loads an acyclic dependency graph, and links it into one native translation
unit. Each dependency receives private compiler identities so unrelated files
may reuse ordinary declaration and native-import names without collision.
Those identities are backend details: diagnostics, formatting, hover,
completion, semantic highlighting, and cross-file definitions retain source
names and source locations. Selective imports require an explicit export;
namespace access exposes the same export set. Re-exports, directory indexes,
package resolution, separate compilation, and a package registry remain later
layers.

The deferred package model must preserve Z's bidirectional native boundary
rather than treating every dependency as downloaded Z source. Its planned
package kinds are pure Z source, reviewed native `.zd` contracts, declared
system-native requirements, and Z libraries published with generated C
headers. Resolution must be deterministic and lock contract content,
provenance, target, and native-version expectations alongside source identity.
System-native dependencies should first be declared and verified through the
existing Clang evidence path; target-specific artifacts and constrained
source-build recipes remain later acquisition strategies. Packages must not
execute arbitrary host code during resolution or compilation. Future generated
artifacts should instead use compiler-owned declarative transformations with
explicit inputs and outputs.

Package implementation is intentionally queued behind native-compiler
verification. The intended sequence is local path packages and a deterministic
lockfile, system-native dependency verification, a curated contract index, and
only then remote Z package resolution. Contract policy must distinguish
machine-verifiable ABI facts from behavioral ownership, lifetime, callback, and
threading assertions, and must record whether a dependency uses `unsafe` or
`raw`.

A source file does not need a module declaration or a `main` function. Checking
and editor analysis accept declaration-only and export-only modules. Executable
context supplies the distinction: a file selected by `z run`, the current
executable-oriented `z emit`, or as a manifest entry must declare
`function main(): i32`. This keeps module identity in the
import/build graph rather than duplicating it in source syntax.

Tests follow the same module model rather than introducing a second source
language or required filename:

```z
test "Map.remove transfers the value" {
  // Test body.
}
```

`test` is a compiler-known top-level declaration. Tests may live beside private
implementation details in any `.zs` file; `*.test.zs` is an optional convention
for black-box modules that import public APIs. Tests are never exported or
callable as ordinary functions, and production compilation omits their bodies
and names. `z test <file.zs>` includes tests from the selected project-owned
module graph. Dependencies do not contribute tests merely because an eventual
package is installed; project-wide discovery and explicit dependency inclusion
remain runner policy.

Only the declaration is intrinsic syntax. Assertions and expectations come
from imported standard modules such as `std/test`; normal ownership remains
enforced even when test helpers provide ergonomic statement-bounded borrows.
The first expectation tier is:

```z
import { expect, fail } from "std/test";

test "answer is stable" {
  const answer = 42;
  expect(answer).toEqual(42);
  expect(in answer).toEqual(42); // Equivalent explicit immutable borrow.
}
```

`toEqual` deliberately reuses ordinary Z `==`; it is not implicit deep
structural equality. A failed expectation or `fail(message)` runs deterministic
cleanup, returns an internal owned failure to the runner, and allows later tests
to continue. Reusable assertion helpers require a future explicit test-context
surface rather than ambient hidden state.

## Async and concurrency

Z keeps suspension explicit. Full colorless async is not a goal because hidden
suspension obscures reentrancy, executor changes, borrow validity, cleanup, and
foreign thread-affinity requirements.

The intended model combines:

- `async` and `await` for suspension;
- `try await` and `attempt await` for typed outcomes;
- structured `async scope` and `task` for task lifetime;
- typed, bounded, move-aware channels for communication;
- actors for long-lived isolated mutable state;
- pluggable native executors;
- structural cancellation and deterministic task-frame cleanup.

Async calls never start implicitly. A direct call must be covered by `await`
for sequential work or by `task` for concurrent work. Every async function
body is an implicit root task scope; an explicit `async scope` creates a
narrower child lifetime. `task` produces a scope-bound `Task<T>` or `Task<T,
E>`; child handles and work cannot escape their owning scope. Detached work
requires an explicitly owned supervisor. `await task operation()` is rejected
as redundant; an immediately joined child creates no interval of concurrency.
Child tasks are scheduled immediately. Awaiting a task joins already-hot
work: it returns an available outcome or suspends the current task without
blocking the executor thread.

An explicit scope may bind its runtime handle:

```z
async scope updates {
  callbackSource(move (value) => {
    const control = updates.schedule(thread.main, async move (): void => {
      const calculation = thread.spawn(async move () => calculate(value));
      publish(attempt await calculation);
    });
    if (!control.accepted) reportClosing();
  });
}
```

`updates` has the standard type `TaskScope`. The handle is a synchronized
ownership boundary, not an executor: submission names its target separately.
Closing atomically rejects later submissions and joins accepted operations;
`schedule` returns a non-joining `TaskControl`. Its `accepted` property exposes
the close-versus-submit race, and `requestCancel()` can target that operation
without transferring join ownership away from the scope. The unnamed
form remains statically lowered when no dynamic handle is required. An explicit
`new TaskScope()` may close or cancel earlier; otherwise its owning async
function closes on return and cancels on throw.
`schedule` accepts either synchronous `(): void` work or an explicitly async
`async (): void` root. The async form may suspend and own structured children,
but it cannot declare `throws`: callback-created work must materialize and
handle errors locally because submission returns control authority rather than
a result-bearing task.

Keyword `task` always inherits the current executor. Explicit native CPU work
uses a standard-library boundary rather than overloading the keyword:

```z
import { thread } from "std/thread";
const task = thread.spawn(move () => calculate(input));
const result = await task;
```

`thread.spawn` means exactly one OS thread; future worker-pool submission
remains a separate standard-library operation whose method spelling is not yet
committed. Its closure may be synchronous or explicitly `async`. An async
closure runs a private executor bound to that one worker, may suspend without
blocking the main executor, and resumes ordinary continuations on the same
worker thread. `task` inside it inherits that worker executor. An explicit
`await on thread.main` hops to the main executor and returns the continuation
to the worker. The worker OS thread intentionally remains alive while its task
is suspended; a pool-backed design may make a different tradeoff later.

The implemented transfer classifier copies recursively
cleanup-free values into the one-shot closure and moves uniquely owned
`Array` storage, including recursively supported value aggregates. Capturing
still requires `move`: for a Copy value this describes how the closure acquires
its private snapshot without invalidating the source; for a unique owner it
consumes the source binding. Results follow the same transfer classification.
The operation creates a hot, scope-bound `Task<T>` and joins at `await` or scope
exit. Owned `String` and mutable `TextBuffer` storage use the same unique-owner
transfer and cleanup path as `Array`; the one-shot thread closure may consume or
mutate those captures before returning an owned result. Deeply readonly Z class
identity crosses by an atomic ARC retain, so the parent keeps its own reference.
Mutable classes, borrows, views, native references, `Arena`, and custom `deinit`
remain rejected. Cross-thread `Weak<T>` remains deferred until weak upgrade has
a shared side-table protocol. Completion crosses a synchronized inbound queue,
so awaiting and implicit joins suspend rather than block the caller's executor.
General native sendability, pools, and cross-thread callbacks remain validation
work. Atomic reference counts protect lifetime, not mutable
class fields; isolation or an explicit concurrency contract must address those
data races.

Explicit placement composes the same `task` boundary with typed targets from
the thread namespace:

```z
await on thread.main { /* hop and wait */ }
task on thread.main { /* structured dispatch */ }
```

Existing executor proof comes from the enclosing declaration or placement and
permits direct access. Z has no bare `on thread.main { ... }` form because it
would have no subject describing an execution effect and would add no authority.

Declarations use the same subject-on-executor ordering:

```z
class NotesController on thread.main { /* ... */ }
struct WindowState on thread.main { /* ... */ }
function updateWindow(): void on thread.main { /* ... */ }
```

The declaration establishes an execution requirement while a placement block
establishes proof that the requirement is satisfied. Aggregate affinity is
transitive through stored fields and is reported by editor hover, including
the field path that introduced inferred isolation. The current tier rejects
off-main calls, construction, member access, function-value erasure, and
placement results that would carry isolated state back to a non-main
continuation. A native worker may carry retained Z ARC identity that is
isolated to `thread.main`, but only opaquely: every access must remain inside a
nested main placement and the worker's retain is released back on main. Async
isolated functions do not auto-hop yet; callers use `await on thread.main`.

Foreign declarations carry the same FIIR affinity fact. Explicit Clang
`swift_attr("@UIActor")` and `swift_attr("@MainActor")` metadata maps
automatically to `thread.main`. Generated Objective-C headers omit a Swift
source declaration's `@MainActor`, so a Swift target declared in `z.json`
additionally emits a symbol graph; Z maps its Objective-C runtime identities
onto the Clang ABI declarations before FIIR normalization. Reviewed API notes
and `.zd` declarations such as
`export type LegacyWindow on thread.main;` cover external, legacy, or
incompletely annotated surfaces. The fact applies transitively to Z aggregates
storing the native identity and is visible in editor hover. It changes
compile-time placement and transfer legality, not the native ABI or call
sequence.

The runtime executes placement blocks through structured task frames.
Cleanup-free Copy values and owned `String` snapshots may be inferred;
ownership-bearing lexical captures use explicit `in`, `inout`, or `move`
contracts. A synchronous `thread.spawn`
closure can create a structured child with `task on thread.main` without
becoming async itself. OS-thread exit and Z-task completion are distinct, so an
async main task awaiting that worker suspends rather than blocking main. Darwin
publishes cross-thread children through a protected inbound queue and wakes a
`CFRunLoopSource`; Windows message-loop and Linux toolkit/event-loop adapters
remain platform-runtime work behind the same `thread.main` capability. An
executor-isolated Z class may cross a native worker as an opaque retained
pointer. The worker cannot inspect, alias, return, copy, or destroy it; a nested
main placement borrows it, and worker cleanup posts the release to the owning
executor. This permits a main-isolated Z presenter to store Objective-C fields
without declaring that presenter generally thread-safe. Raw Objective-C
identity, mutable captures, cross-executor borrows, and broader native-owner
transfer remain later capture-contract tiers.
An `async` worker closure may instead `await on thread.main`; after the placed
operation finishes, its continuation is enqueued back onto the private worker
executor. Detailed semantics and lowering order live in
[`docs/executor-placement.md`](docs/executor-placement.md).

The source contract for placed-block captures is a contextual `using` clause
after the executor expression:

```z
const task = task on thread.main
  using (in config, inout value, move buffer)
  : i32 throws WorkError {
    value += config.increment;
    consume(move buffer);
    select value;
  };
```

A committed follow-up makes placement orthogonal to a direct function call:

```z
const loading = task on thread.main load(model);
const value = try await on thread.main refresh(inout state);
```

The callee's argument list is already the capability boundary, so direct placed
calls do not repeat those arguments in `using`. Placement blocks retain
`using (...)` for lexical captures and multi-statement anonymous operations.
This direct-call spelling is executable. Async callees reuse their original
task frame, so placement does not create `Task<Task<T, E>>`; synchronous
nonthrowing calls use a minimal one-shot placed frame. Throwing synchronous
direct calls still require an async adapter until synchronous `try` lowering is
available inside task frames.

The executor configures the target; `using (...)` declares access to existing
bindings. Its entries reuse the ordinary `in`, `inout`, and `move` capabilities
without repeating types. Cleanup-free recursively Copy captures and owned
String snapshots may remain inferred private snapshots. `out` is reserved until
child-task initialization has sound failure, cancellation, and
definite-assignment semantics. A borrowed
capture remains unavailable to conflicting parent access until the task is
actually joined, explicitly or by the enclosing `async scope`; cancellation
request alone does not end the loan. A moved binding remains consumed unless
the task explicitly returns ownership. This capture tier is executable for
`thread.main` placement blocks; future pool targets reuse the same contract.

The error contract is the same as local `task`: a worker closure
declared `(): T throws E` produces `Task<T, E>`, `try await` propagates `E`, and
`attempt await` materializes it. Error slots carry explicit liveness just like
result slots, so transferable String/Array ownership, containing aggregates,
deeply readonly ARC identity, and explicitly contracted native owners can move
from worker to parent and are destroyed exactly once when observed, propagated,
cancelled, or discarded. There is no separate untyped thread-exception channel.
Worker bodies support direct and binding-valued synchronous `try` plus local
`attempt`; nested `try` remains excluded by the language-wide direct-value rule.

An async function continues to declare its domain contract as `T throws E`.
`task` preserves that contract as `Task<T, E>`, `try await` propagates `E`, and
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
frame. A child-task immutable borrow requires an explicit `async scope`; its owner
cannot move or mutate until every borrowing child joins. Multiple immutable
child borrows may share the same owner. A consuming `await task` or `await
task.cancel()` releases that child's borrow early; otherwise the scope's implicit
join releases it. Borrowed ARC class parameters intentionally use the ordinary
owned parameter form instead, which retains identity while preserving caller
access. A direct-awaited `inout` parameter stores a mutable pointer into the same
stable caller frame; the caller cannot resume until the callee finishes. A
child-task `inout` borrow requires an explicit async scope and grants one child
exclusive access until its explicit or implicit join. Mutations completed before
an error or cancellation remain visible—`inout` is not transactional. A non-throwing,
direct-awaited `out` parameter may similarly initialize cleanup-free caller
storage; every successful path must assign it before returning. Ownership-bearing
output waits for completion-time live-storage handoff lowering. Child-task `out`,
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
their child-frame parameter slots when `await` or `task` creates the task;
`task` therefore owns its arguments before the child is first polled. Results
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
Direct awaits suspend their parent; hot `task` enqueues children immediately;
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
Executor adapters are one concrete consumer: Darwin selects CFRunLoop
integration, Windows will select a message-loop adapter, and Linux applications
may select a toolkit/event-loop binding. Target selection must happen at compile
time without exposing C preprocessor text to ordinary Z source.
Platform APIs continue to require explicit native imports; portable `std` APIs
may provide common contracts over them without erasing platform differences.

Interop is bidirectional. Z modules use ordinary `export` for source-module
visibility and the accepted `export c function` qualifier for implementations
that deliberately enter the global C ABI:

```z
export c function z_math_add(left: i32, right: i32): i32 {
  return left + right;
}
```

The source name is initially the exact C symbol. The compiler must reject
cross-module collisions rather than silently module-mangling public ABI names.
Its implemented value tier accepts ABI-stable scalars, checked by-value
`c struct` records, and payload-free `c enum Name: integerType` values; emits a
public wrapper plus a C/C++-compatible header; validates enum inputs from C; and
rejects generics, errors, async, affinity, and Z-owned representations at the
source declaration. Static-library output and a handwritten strict-C consumer
prove that boundary before strings/slices, projected errors, owned results,
callbacks, or async exports.
The wrapper keeps Z's internal identity private and should optimize away when
the implementation is trivial. The complete accepted direction is recorded in
[`docs/c-exports.md`](docs/c-exports.md).

## Inline assembly direction

Z intends to support inline assembly as an explicit, target-specific hardware
boundary. The exact operand and constraint grammar is deliberately open, but
the source surface should compose with the language's existing capability and
definite-initialization model rather than hide reads and writes inside an
opaque string. A representative, non-final shape is:

```z
let cycles: u64;

unsafe {
  asm(out cycles) {
    // target instructions, operand constraints, clobbers, and options
  }
}

return cycles;
```

`in`, `inout`, and `out` describe the Z storage contract: assembly may read an
`in` operand, may read and replace an `inout` operand, and must initialize an
`out` operand without depending on its prior value. A successful `out` block
therefore participates in ordinary definite-initialization analysis. These
capabilities are separate from machine constraints such as register, immediate,
or memory operands. The constraint model must also represent clobbered
registers and memory plus effects such as `volatile` and `noreturn` without
pretending that an optimizer barrier is free.

Inline assembly requires an explicit `unsafe` boundary because Z cannot prove
instruction behavior, ABI preservation, pointer validity, or agreement between
the declared operands and the instruction template. The first tier should be a
statement form over primitive scalars, supported floating-point values, and
explicitly unsafe pointers. ARC identities, owned strings and collections,
closures, and arbitrary aggregates must not cross this boundary implicitly.
Value-producing assembly can be considered after statement-form `out` operands
provide implementation evidence; it should not introduce a second meaning for
`select` merely to return a register value.

Architecture-specific assembly is a motivating use case for the planned small
`comptime` experiment and `std/target`. Inactive target branches must still
parse as Z source, but they must be removed before architecture-specific
instruction and register validation. This same phase boundary must eventually
support conditional platform imports and declarations for cross compilation.
Unsupported targets should receive a source-located compile-time diagnostic,
not a downstream assembler failure.

The first native implementation may lower explicitly backend-specific
constraints through Clang extended assembly because Z currently emits C-family
source. Those strings must be documented as a Clang/GNU backend tier rather
than frozen prematurely as Z's portable assembly model. A future native backend
must be able to preserve the operand, clobber, and effect contract without
depending on generated C syntax. Inline assembly promises direct hardware
access and no wrapper call; register moves, spills, barriers, and clobbers
remain visible real costs.

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
Thread transfer is a separate, trusted native fact rather than an implication of
`move`:

```z
export type desktop.UniqueValue {
  move;
  deinit;
  thread {
    transfer;
    deinit;
  }
}
```

The inner `transfer` authorizes one unique owner to cross a native thread
boundary, while inner `deinit` authorizes destruction on the receiving thread.
Owned C handle results use the same nested block after their `deinit close;`
contract. The first executable tier requires both capabilities and supports
move-only C++ RAII values and owned C handles in `thread.spawn`. `share` is
reserved in the declaration grammar but is not executable until FIIR can name a
concrete native retained/shared representation. Ordinary C++ movability alone
does not establish thread safety.
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
scope-bounded child-task mutable parameters, and cleanup-free direct-awaited output
parameters borrow without a wrapper, retain, or copy; child-task output and
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

Imported Objective-C protocols participate in Z's nominal `implements` list
without turning a Z ARC class into an Objective-C allocation. A synchronous,
non-throwing instance method may attach `as "selector:"` after its return type.
That selector must belong to an implemented protocol, and the compiler checks
the complete parameter capabilities/types and result against the imported SDK
declaration. Code generation emits an `NSObject<Protocol>` adapter that retains
the Z owner and forwards only explicitly implemented selectors.

Weak protocol properties require an explicit lifetime token. The first bridge
is `objc.bind(object, { dataSource: controller, delegate: controller })`. Field
names must resolve to imported writable non-owning protocol properties and each
stored controller must implement the property's protocol. The returned
`objc.Binding` owns the native object, generated adapters, and Z controllers.
This makes delegate/data-source lifetime visible in Z source and prevents
refactoring a controller into a helper scope from producing a dangling native
reference.

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
for general view-bearing enum storage. The implemented `view` tier accepts
either a synchronous borrowed value-struct receiver or immutable value-struct
parameters returning themselves, direct fields, or indexed elements. A
parameter function may select among multiple inputs; the call conservatively
borrows all possible source owners without changing the one-pointer runtime
representation. Last use ends every associated borrow; the view cannot be
stored, returned again, or held across owner mutation or suspension. It can
enter a synchronous `in T` call
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

The same project target may declare validated `includeDirectories` and
`link.directories`. Relative entries resolve from the manifest directory and
absolute entries remain absolute. Header import, compiler analysis, and the
language server consume one shared include-path model; native compilation
consumes those includes plus the configured library search paths. This keeps
portable source imports such as `"raylib.h"` independent of host installation
layout while leaving package discovery as a later layer.

For Objective-C-compatible declared targets, the same cached build emits a
Swift symbol graph. Swift's generated Objective-C header does not retain
`@MainActor`; the symbol graph does, together with Objective-C runtime class and
selector identities. Z merges only that executor-affinity fact into the
header-derived declaration. The header remains ABI authority, and `.zd` remains
responsible for behavioral callback facts such as exactly-once completion and
delivery thread.

Generated Objective-C headers do not encode where Swift invokes an escaping
completion block. An adjacent `.zd` contract may therefore name an existing
static class method as `export function Type.method(...)` and refine an
ARC-owned block with `thread caller` or `thread any`. It cannot invent the class,
selector, parameters, or ABI. The arbitrary-thread probe copies the block,
uses atomic ownership for its Z closure environment, and can submit synchronous
AppKit operations through a named `TaskScope`.

The same contract may state `invoked once;` for the terminal block, then add
`async completion;` to request Task synthesis. Z preserves the raw callback
overload and synthesizes an async overload whose result is the block's
zero-or-one payload. Its owned task frame remains alive until completion,
including after a cancellation request when the native API has no cancellation
hook. A duplicate callback traps before touching completed frame storage; a
missing callback leaves the task pending. An expanded
`async completion(value, error) { return value; throw error; }` contract maps a
conventional nullable Objective-C error slot into `Task<T, E>` while retaining
the ARC error through `try await` or `attempt await`. The first executable tier
covers static methods, cleanup-free scalar success payloads, and Objective-C
reference errors; instance contracts, ownership-bearing success payloads, and
native cancellation hooks remain separate semantics.

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
an owned string. Generated callable case objects for Swift enums also import as
namespaced factories, so an associated-value case can be constructed directly
as `Swift.LoadState.ready(42)` without a Swift helper or handwritten shim.

The installed Swift 6.2 toolchain marks noncopyable (`~Copyable`) values and
Swift `async` functions unavailable in its generated C++ interface. A compiler
fixture records both constraints. Z therefore does not claim direct support for
those surfaces. Public generated interfaces and generated Swift bridge targets
remain preferred. Direct Swift ABI lowering is reserved for a future explicit
escalation if application pressure demands full compatibility, with resilient
layouts, value witnesses, async calls, actors, and runtime-version coupling
treated as first-class costs. Property sugar, generics, protocols, errors,
async, and package import remain open vertical slices.

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

Once a contract establishes an owned opaque C pointer and its release operation,
the native typedef is also a source-nameable Z type. The import namespace keeps
the header identity visible: an owned non-null `sqlite3 *` is written
`sqlite.sqlite3`, while its nullable form is `sqlite.sqlite3 | null`. Storage is
owned by default; `in` borrows it and `move` transfers it. The readable spelling
does not erase the internal pointer identity, nullability, release operation, or
live-state tracking. An ARC class may therefore store the handle and release it
exactly once when the class dies.

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
The narrow `parameter: null` contract restricts an otherwise unsupported
native pointer parameter to the null value in safe Z. A
`view cstring | null` result classifies a native character pointer as nullable
borrowed NUL-terminated text tied to the function's single borrowed pointer
input. The result must be narrowed before copying and keeps its input owner
loaned until last use. Neither form changes the header-defined ABI.
A parameter-local `{ fixed NATIVE_CONSTANT; }` contract likewise preserves its
header-verified ABI position while omitting that policy parameter from Z calls;
code generation supplies the named header constant. This is reserved for
native semantic sentinels such as `SQLITE_TRANSIENT`, not arbitrary expressions.
An integer- or integer-backed-enum-returning native function may additionally declare
`void throws _ { success N; }` or use a compatible header constant such as
`success CURLE_OK;`: listed statuses become successful `void`,
every other native status is preserved as the inferred scalar or enum error, and
owned `out` values become cleanup-active before failure propagation. This
changes only the safe Z surface, not the native ABI, and introduces no heap
exception or wrapper call.

Native C variadics whose trailing ABI types are selected by an enum constant
can be closed into checked overloads:

```z
export function curl_easy_setopt(
  in curl: _,
  option: CURLOPT_URL,
  in url: cstring
): void throws _ {
  success CURLE_OK;
}
```

The enum member in type position is an exact literal discriminant. Parameters
after the header's fixed prefix describe the variadic arguments explicitly.
Repeated contracts for the same native function form an overload set, and once
that set exists safe Z rejects unmatched options rather than falling back to
unchecked varargs. The emitted call remains `curl_easy_setopt(...)`; the
contract adds no wrapper or runtime dispatch.

Declaration-only `clong` describes an exact C `long` variadic argument:

```z
export function curl_easy_setopt(
  in curl: _,
  option: CURLOPT_TIMEOUT,
  seconds: clong
): void throws _ {
  success CURLE_OK;
}
```

It does not introduce a platform-dependent everyday Z integer. The safe call
is checked against the target-width fixed integer (`i64` on LP64 and `i32` on
Windows LLP64), then lowered with an explicit `(long)` cast so default variadic
promotions cannot silently substitute `long long`.

Native libraries sometimes install an escaping callback and its opaque context
through two separate option calls. A paired-option connection contract makes
that relationship explicit:

```z
export function curl_easy_setopt(
  in curl: _,
  option: CURLOPT_WRITEFUNCTION,
  move write: _
): connection throws _ {
  success CURLE_OK;

  callback write {
    type curl_write_callback;
    context option CURLOPT_WRITEDATA;
    owner curl;
    project bytes: Slice<u8> {
      data buffer;
      length size * nitems;
    }
    failure CURL_WRITEFUNC_ERROR;
    thread caller;
    invoked repeatedly;
  }
}
```

The safe Z call accepts an escaping closure and returns a move-only
`native.Connection`:

```z
const writer = try curl.curl_easy_setopt(
  easy,
  curl.CURLOPT_WRITEFUNCTION,
  move (bytes: Slice<u8>): usize throws WriteError => {
    consume(bytes);
    if (cannotContinue()) throw WriteError({ code: 1 });
    return bytes.length;
  }
);
```

`Slice<T>` is already a borrowed view, so its callback parameter does not and
must not add `in`. The `move` applies to the escaping closure value. The
connection retains that closure, installs the native context and callback as
one checked operation, and unregisters both before releasing the closure
environment. Its lexical loan prevents the native owner from moving or
deinitializing first. The first tier supports a byte buffer whose length is a
product of native `size_t` parameters and a callback invoked only on the
registering thread.

Callback invocation cardinality is a separate trusted fact. `invoked once`
means exactly one native invocation and is required before a completion
callback may synthesize a Z `Task`; `invoked repeatedly` means zero or more
invocations and is required for callback connections without being exclusive to
them. Synthesized async adapters trap a duplicate completion before touching
completed task storage. A vendor that never invokes a callback declared
`invoked once` leaves the task pending indefinitely unless a later contract
provides a native cancellation or terminal-completion mechanism.

Callback return projection preserves both directions. An ordinary Z callback
return remains the exact native callback return. `failure N;` or
`failure CONSTANT;` states which value the adapter returns when the Z callback
throws. The adapter destroys the error payload before returning that native
value. The payload therefore stops at the ABI boundary, but the failure fact
survives—for example, libcurl reports `CURLE_WRITE_ERROR` from the owning
operation.

This boundary behavior is intentionally exceptional: the callback's `throw`
does not reach a Z `try` or `attempt` handler because C exposes no payload
channel. Repeated callbacks should generally use cleanup-free error payloads;
constructing an owned message only to destroy it during every failing
invocation is valid but can add hot-path work. A future owner-tied
`native.Connection` extension may preserve the last callback payload and
rethrow it when the owning native operation reports failure.

Ordinary non-callback pointer/length pairs use the same vocabulary at function
scope:

```z
export function blob_hash(in data: _, length: _): _ {
  project input: Slice<u8> {
    data data;
    length length;
  }
}
```

This exposes `blob_hash(input: Slice<u8>)` to safe Z. The declaration's `in`
classifies the native const pointer; callers omit it because `Slice<u8>` is
already a borrowed, non-escaping view. The compiler validates a const
`char *`, `unsigned char *`, or `void *` plus one distinct `size_t` parameter
and lowers directly to `blob_hash(data.data, data.length)`. Stored fixed
`u8` arrays and `Array<u8>` values receive the existing call-scoped slice
conversion. `project inout destination: Slice<u8> { ... }` accepts a mutable
native byte pointer and exposes explicit `inout` at both the generated Z
signature and call site. Retained pointers and broader element/count shapes
remain later contracts rather than unchecked inference.

Z's intended foreign boundary has three explicit trust tiers:

1. Header import plus checked `.zd` facts is the safe surface. Clang remains the
   ABI authority and Z enforces the added ownership and lifetime contract.
2. An `unsafe { ... }` block permits a narrow set of otherwise unsupported
   native pointer calls and active-member assertions for imported C union
   storage while retaining Z expression syntax, but gives up the missing local
   static proof.
3. `raw c`, `raw cpp`, or `raw objc` embeds foreign source for APIs that cannot
   be expressed through Z calls. It escapes Z's type system rather than merely
   accepting an unverified Z proof.

The first raw tier has two forms. An anonymous expression declares its entire
operand and result contract:

```z
const result = raw c
  using (in input, inout state, out output)
  : i32 {
    return native_operation(input, state, output);
  };
```

The compiler lowers this to an isolated generated helper. Native `return`
therefore returns from the helper and cannot skip cleanup in the enclosing Z
function. The raw body cannot reach lexical Z values omitted from `using`.
`in`, `inout`, and `out` have the same storage meaning planned for inline
assembly: read-only access, read/write access, and definite initialization
without reading the prior value. Tier 1 deliberately omits `move`; relinquishing
a cleanup-bearing owner to unverifiable native source needs a separate,
explicit destruction contract.

A named function places the boundary in its ordinary signature, so it does not
repeat `using` or the result type:

```z
function operation(in input: i32, out output: i32): i32 = raw c {
  *output = *input;
  return *output;
}
```

`= raw c` replaces the function body; it is not a general expression-bodied
function precedent. A declaration may retain `on thread.main`, since executor
affinity is a checked header contract and is useful for raw Objective-C.
`async`, `throws`, generic raw functions, and raw method bodies are rejected in
the first tier. Anonymous raw expressions are likewise synchronous.

Raw boundaries initially admit ABI-stable integer, floating-point, boolean,
`cstring`, and imported native types. Z-owned String, collection, ARC, region,
view, and generated Result representations are rejected rather than exposing
unstable names such as generated structs or liveness flags. `#line` mapping
returns native diagnostics to the original `.zs` body. Rich embedded-language
completion remains later editor work. Until raw helpers move to separate
translation units, the compiler compares embedded identifiers with the symbols
this compilation actually emits. Referencing a generated symbol is rejected
rather than exposing an unstable generated-code ABI; unrelated native names
such as zlib's `Z_OK` remain available.

The latter two tiers are escape hatches, not substitutes for extending FIIR and
`.zd`. The first `unsafe` tier accepts two pointer shapes plus scalar/enum
active-member assertions for imported C union storage:

```z
unsafe {
  const version: cstring = native.version();
  const handle = native.open();
  if (handle == null) return 1;
  native.close(handle);
}

const observed = unsafe {
  const handle = native.open();
  if (handle == null) return -1;
  const value = native.read(handle);
  native.close(handle);
  select value;
};
```

An explicit `cstring` context locally asserts that a native character pointer
is readable NUL-terminated text. Every other unsupported pointer becomes a
scope-confined opaque native identity. It can be compared with `null` and
passed only to an unsupported parameter with the exact same normalized native
pointer spelling. It cannot be dereferenced, indexed, inspected, returned,
stored outside the block, selected from a value-producing unsafe expression,
captured, or passed through an ordinary Z call to conceal its unsafe origin.
Exact matching native calls remain available, and `String.from(borrowed)` is
the explicit owned-copy boundary for an asserted `cstring`. `return` still
exits the enclosing function. `select` may produce a representable scalar or
independently owned Z value. Unsafe blocks are synchronous and may not appear
directly in an async function in this tier. Pointer-bearing native records
passed by value remain unavailable in `unsafe`, but checked `.zd` may classify
their canonical C record as a move-only resource:

```z
export type Image {
  move;
  deinit UnloadImage;
}

export function LoadImage(in path: cstring): _ {
  owned;
}
```

The ABI stays native. `owned` activates deterministic cleanup; `borrowed`
withholds cleanup and produces a lexical non-escaping value. Every resource
parameter must declare `in`, `inout`, or `move`, every resource producer must
declare `owned` or `borrowed`, and canonical Clang identity propagates the
contract across typedef aliases. An uncontracted operation still requires raw
source rather than an unchecked by-value representation.

Safe Z cannot synthesize a resource record literal: only a contracted native
producer may establish valid bytes. Imported scalar fields may be inspected,
but direct mutation is rejected and pointer-bearing fields stay hidden;
contracted `inout` operations preserve the native library's invariants.
`copy resource` is rejected unless a distinct native copy operation returns a
new `owned` result. Borrowed results cannot enter fields, arrays, enums,
closures, returns, consuming calls, suspension, or thread transfer in this
tier. These restrictions may relax only when a future `lifetime` contract
names the native owner.

Clang verifies the record identity, ABI, aliases, and release-function
signature. It cannot verify that a producer actually owns its return or that
arbitrary record bytes represent a valid live resource. Those facts remain a
reviewed trust boundary, as do alias-producing APIs such as native sound
aliases whose cleanup differs from their canonical record type.

A C union may receive ABI-preserving storage through a contracted `out Union*`
parameter without entering `unsafe`: the contract proves initialization of the
storage, not its active member. Direct member access is rejected in safe Z.
After validating the native API's discriminator, an unsafe block may read a
supported scalar or nominal enum member, and a scalar copy may leave through
`select`. The first tier deliberately withholds pointer and nested-record union
members. A future `.zd` discriminated projection can make recurring
tag-to-payload relationships safe without weakening the default.

A `.zd` capability may also classify a native pointer to one ABI scalar as
`in`, `inout`, or `out`. Clang supplies the exact pointee type; the contract
asserts that the pointer addresses exactly one call-scoped scalar and supplies
the read/write capability. `out` accepts uninitialized `let` storage and marks
it initialized only after the native call returns. This does not generalize
arbitrary pointers or arrays into Z values.

This deliberately adds no source-level raw-pointer type. A later inline-fact
tier may reuse more `.zd` ownership and lifetime vocabulary when concrete APIs
show which facts need local assertion.

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
records, named or anonymous-typedef enums, scalar typedefs, enum constants, and
supported object-like integer macros can share the same import list and can
each be aliased. Aliases
affect only Z source: generated C uses the original declaration spelling, and
aliases preserve C type identity across selective and namespace imports.
Namespace imports remain useful when provenance and breadth matter.

Imported C data follows Z expression syntax whether it is namespaced or
selective: typedef-named records can appear in signatures, are built with
checked struct literals, and expose imported fields; C enum constants and
active object-like integer macros become typed values. Literal macros follow
target C integer-literal rules; integer aliases and expressions composed from
supported arithmetic, shift, and bitwise operations are evaluated without
textual substitution. Editor definitions point to `#define`, and generated
source preserves the native token. Function-like, string, cast-heavy, and
otherwise unsupported expression macros remain deferred. The native compiler
still includes the original header, so it does not
redeclare layouts or guess padding and calling conventions. A future
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
`extern` is not currently part of the accepted user-facing grammar for importing
implementations supplied elsewhere; header ABI and linkage remain inferred
contract metadata. Outbound `export c function` is distinct because the
implementation is Z-owned. Handwritten declarations and raw operations remain
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
9. Z-to-C scalar exports, generated headers, and native library artifacts.
10. Broader Swift module/interface and Swift Package import for Swift-only APIs,
   methods, strings, protocols, generics, errors, and concurrency.

Completed slices and precise unsupported boundaries are tracked in
[`docs/bootstrap-status.md`](docs/bootstrap-status.md#foreign-interfaces).

## Initial non-goals

- inheritance for Z-defined types (foreign superclass metadata is imported);
- production async scheduling, cancellation, I/O reactors, and CPU-parallel execution;
- ORC cycle collection;
- function-like and general expression macros, plus compile-time execution;
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
   platform substrate. The first components are now concrete: a Z lexer emits
   the same parser-facing token kinds, decoded text, and source locations as
   stage 0 across an adversarial parity corpus and tokenizes its own complete
   source. Public offsets and columns are UTF-16 code units for LSP/stage-0
   compatibility, while the native frontend retains separate UTF-8 byte indexes
   for slicing. A linear declaration parser retains source-located top-level
   kinds, names, export/async state, complete function signatures, aggregate
   fields and lifecycle members, trait methods, and enum payload variants.
   Imports retain namespace or selective bindings, local aliases, binding
   locations, and module headers as structural module-resolver input. Generic
   constraints, capabilities, nested types, returns, typed errors, constructors,
   static/async methods, and `deinit` all have canonical stage-0 parity. Function
   bodies now own the first statement AST slice: `const`/`let`, `return`,
   expression statements, and recursively nested standalone blocks. Primary and
   postfix expressions now use an owned flat node arena: identifiers, scalar
   literals, parenthesized expressions, arrays, objects, calls, member access,
   and indexes have exact node-kind, value, edge, label, and location parity
   without per-node heap boxes. The same arena now retains prefix unary nodes,
   precedence-climbed binary trees for the complete current operator table, and
   right-nested conditional expressions. Z-specific `new`, `weak`, `try`,
   `attempt`, direct `await`, and direct `task` nodes share the arena while
   preserving their postfix-operand grammar; `new` retains its canonical type,
   labels, and argument edges. Generic identifier and member callees retain
   canonical nested type arguments, including the `Array<T>()` construction used
   throughout the native frontend. Expressions outside that slice retain
   source-located canonical token spans and are explicitly opaque until their
   parser slice lands; assignments and other statement forms are traversed
   but deliberately not materialized as this subset. Exact stage-0 parity covers
   every top-level function body in the fixture, lexer, and parser corpus. The
   temporary buffered native protocols are exposed through `z self-host-lex` and
   `z self-host-parse`. The parser bridge is content-addressed across compiler
   and frontend sources, compiled as a dynamic library, and invoked synchronously
   in-process through Bun FFI with host-provided path and source bytes. `--timings`
   separates library preparation, native frontend work, protocol decoding, and
   the stage-0 parity parse. The lexer parity command still uses its standalone
   executable client. Complete syntax coverage and a broader parity corpus
   precede replacing bootstrap frontend phases in ordinary commands. Performance
   claims wait for equivalent frontend coverage and removal of the temporary text
   protocol rather than comparing unlike amounts of work.

   The reusable implementation now lives under `compiler/frontend`. The
   Source Inspector example remains a small inspectable client with smoke tests
   and standalone protocol executables while stage 0 compiles the native
   frontend and consumes its in-process library boundary. A first pure native
   module-resolver phase accepts host-canonicalized paths and source text, parses
   every module, and directly validates local edges, dependency order, selective
   exports, aliases, duplicate bindings, missing modules, and cycles. Keeping
   loading/canonicalization at the host boundary avoids freezing `std/path`
   before the graph semantics are proven. The batch now crosses one in-process
   FFI call and returns a compact graph protocol; `z self-host-resolve` checks it
   against stage zero while reporting boundary, framing, native execution,
   decode, and parity timings independently. A shared canonical batch loader now
   supplies both the current linker and native boundary from one entry path.
   Ordinary compiler analysis exposes an optional resolver callback that runs
   only after successful stage-zero semantics, receives that existing canonical
   batch, and returns a graph retained on the analysis result. A reusable
   prepared-library invocation service owns the Bun FFI mechanics without
   importing compilation, so the compiler core does not depend on the CLI and no
   circular bootstrap dependency is introduced. Stage zero remains diagnostic
   authority while consumers migrate one semantic result at a time. The first
   such consumer is a compiler-owned semantic index that resolves local names,
   selective aliases, and namespace members to their defining native symbols and
   signatures. Exact parity now builds its stage-zero side from the canonical
   batch's retained ASTs and dependency maps rather than lexing and parsing every
   module again. The compiler—not the CLI—then exercises every local binding,
   selective alias, and exported namespace-member lookup through that index and
   compares the resolved definition and signature. The CLI is reduced to native
   preparation/invocation, timing capture, and presentation. Native evidence is
   now prepared before the main stage-zero semantic pass. An observer checks each
   successfully resolved direct Z function call against the native defining
   symbol and source signature. Native preparation/parity failures are buffered
   until stage-zero semantics succeeds, preserving stage zero as diagnostic
   authority while making the native index available to real semantic consumers.
   The graph now carries a first native semantic table: source-located Z
   declarations and namespace/selective import bindings with kinds, exports,
   aliases, and local module targets. Function symbols retain callable
   signatures across the graph boundary: async state, generic parameters,
   parameter capabilities and types, return type, and error type. Concrete
   generic calls additionally export source-keyed resolution records containing
   the defining symbol, settled substitutions, and the fully substituted callable
   contract. The TypeScript bootstrap bridge may consume such a record only after
   validating its target and mapping every concrete type onto the linked
   declaration; it never reconstructs semantics from a mangled monomorph name.
   This includes direct generic functions, instance/static methods whose owner is
   generic, separately generic instance methods, separately generic static
   methods on non-generic owners, and inferred or explicit construction of
   generic classes. Method evidence proves both receiver capability and the
   ordered owner/method substitutions; constructor evidence proves the concrete
   owner result.
   Generic aggregate construction, fields, and explicit type uses do not need a
   separate concrete-call record: the native template supplies structural
   metadata, and the already-linked concrete declaration supplies lowering
   identity. That rebase is keyed by source definition and member name, never by
   decoding a stage-zero monomorph spelling.
   The native resolver performs argument-driven owner inference for generic
   struct literals, synthesized classes, and declared constructors across local,
   selective, and namespace type spellings. Constructor records keep the defining
   class as their target while allowing the concrete result type to retain a
   caller-visible alias. Generic functions, static and instance methods, declared
   constructors, and synthesized aggregate construction accept result context
   from annotations, assignment targets, and enclosing function returns. They
   propagate settled parameter and field contracts through nested calls and
   ternary, value-producing `if`, and expression-`match` branches.
   This call evidence is a temporary bootstrap transport—the eventual native
   driver will pass the same structural result directly between compiler phases.
   Type symbols
   retain aggregate type parameters, field types/visibility/read-only state,
   custom-deinitializer/custom-constructor state, constructor signatures, and enum variants/payloads. Native match typing follows local,
   selective-imported, and namespace-imported enums through that graph,
   including generic aggregate payload destructuring and exhaustiveness.
   Z-defined field reads and assignments use the same type metadata across those
   boundaries, substitute generic fields, and enforce private/read-only access;
   concrete enum fields also participate in equality typing.
   Aggregate method contracts also cross the graph: static/instance identity,
   visibility, receiver mode, async/error state, generics, parameters, and result.
   Native calls use those contracts across local and imported types. Function,
   method, and aggregate signatures also retain generic trait constraints, while
   aggregate symbols retain their nominal conformances. Native inference validates
   those constraints for inferred and explicit calls and construction. Inside a
   constrained generic body, the declared trait methods are the complete legal
   member surface; structurally similar but undeclared members do not leak through.
   Standalone type uses recursively validate Z and intrinsic generic arity and
   nominal constraints through nested generics, arrays, nullable/view wrappers,
   and function signatures. Bare generic names are accepted only where aggregate
   construction is designed to infer their arguments.
   Native nominal equality is keyed by the defining module and symbol, not the
   source spelling. A local name, namespace-qualified name, selective alias, and
   type forwarded through an intermediate module therefore compare as one type;
   diagnostics still use a spelling visible in the caller. Generic unification
   recursively compares that identity rather than raw aliases. Native value
   bindings now retain mutability independently of their type spelling, and
   direct assignment enforces the `const`/value/`in` versus
   `let`/`inout`/`out` distinction. That record now also carries definite
   initialization and ownership state. Direct assignments and nested blocks update it, `if`
   merges only branches that can continue, loops conservatively include zero iterations, reads reject
   uninitialized/maybe-uninitialized values, and successful exits require every
   `out` parameter to be initialized. Ownership is available, moved, or
   maybe-moved; cleanup-bearing values passed to owned parameters transfer while
   ARC classes, weak references, and function values copy their managed handle.
   Continuing branches and loops merge that state while exiting branches are
   excluded; assignment and successful `out` restore it, and borrowed storage
   cannot be consumed. Exhaustive consuming matches move
   cleanup-bearing subjects and expose owned payload bindings; `match (in value)`
   requires named storage and exposes borrowed cleanup-bearing payloads. Object
   patterns keep cleanup-bearing fields borrowed, and every continuing arm merges
   its outer flow state. Nested mutation and loop-control reachability remain later
   flow-state layers over the same record. Local initialization, replacement
   assignment, return, throw, selected match values, conditional branches,
   fixed-array elements, synthesized aggregate fields, and enum payloads all use
   the same transfer operation. Synthesized object construction validates and
   consumes nested fields only when graph metadata proves there is no custom
   constructor. Declared class construction instead checks the constructor's
   graph-carried parameter modes and types, substitutes owner generics, and
   applies the same borrow/transfer transitions as an ordinary call. Constructor
   errors and errors from synchronous Z functions/methods remain pending effects
   until `attempt` materializes `Result<T, E>` or `try` validates the enclosing
   `throws E` contract and yields `T`. Unhandled calls, non-throwing operands,
   incompatible propagation, and invalid `throw` values now diagnose natively;
   async, standard-library, and foreign effect models remain later layers. Local
   closure expressions now carry explicit parameter capabilities/types and an
   inferred or explicit result contract into a nested native analysis scope.
   Their calls reuse ordinary capability and argument checking. Native capture
   discovery applies conservative loans to borrowed cleanup-bearing values and
   consumes unique owners for `move`, while ARC identities retain copy
   semantics. A settled destination function contract from a local, direct call,
   imported call, or Z method now supplies omitted closure parameter types and
   block result types while retaining explicit capability checking. Generic
   destinations whose function shape is not settled before argument inference,
   escaping closure environments, and precise last-use release of closure borrows
   remain later layers. Native direct/imported function
   and Z-method calls now consume their graph-carried parameter modes: `out` and
   `inout` require matching explicit markers and mutable bindings, `inout`
   requires initialized storage, invalid explicit markers on value/`in`
   parameters are rejected, and successful `out` calls initialize their target.
   Left-to-right evaluation carries that transition through expressions while
   ternary and short-circuit alternatives merge it conservatively. Per-call
   access roots reject all conflicts except shared `in`/`in` and copyable
   `value`/`value` uses, including receiver/argument overlap. Value-struct
   `inout this` requires mutable addressable storage. An owned `const` class
   reference may still mutate its shared identity, while an immutable `in`
   class borrow may not; borrowed `this` also cannot invoke a `move this`
   method, and a successful consuming call marks named receiver storage moved.
   Enclosing function result contracts remain active inside statement match
   arms, while payload-free enum constructors are excluded from partial-field
   move rules. These distinctions are sufficient for the native resolver to
   analyze its own implementation and continue into the parser dependency.
   Feeding this graph into ordinary
   compiler commands and replacing the temporary protocol remain next. Native
   semantic analysis has also begun on that graph: source-ordered lexical lookup
   resolves materialized identifiers against module symbols, parameters, and
   locals, with nested scopes for blocks, loops, closures, match arms,
   constructors, methods, and `deinit`. Unknown names now originate from Z with
   exact locations. Types retain a structural flat list of source-located
   nominal references in addition to their canonical spelling. Native lookup
   therefore resolves nested generics, constraints, declaration and local
   annotations, closure/executor signatures, construction, and explicit generic
   arguments without parsing display text. Unknown inner types originate from Z
   at the inner token. Type-constructor generic arity, complete type
   compatibility, value member lookup, opaque expression spans, and complete
   ownership analysis intentionally remain at stage zero while the native semantic model
   grows vertically.
   A first expression-type pass now layers on those resolved names. It infers
   primitive/template/fixed-array literals, parameters and local aliases,
   typed local closures, their capture effects and calls, indexes, core operators,
   ternaries, and direct Z calls. Calls resolve through local declarations, selective imports and
   aliases, and namespace imports, validating known argument types against the
   target module's signature. Generic calls infer or accept explicit type
   arguments and structurally substitute nested parameter and return shapes.
   Local annotations, assignment targets, and enclosing function returns can
   settle result-only parameters. Generic functions, methods, constructors, and
   synthesized aggregate fields then carry those contracts through nested
   arguments and value-producing conditional or match branches.
   Known initializers,
   assignments, conditions, arguments, and returns are checked with native
   diagnostics. Local enums and the intrinsic `Option<T>`/`Result<T, E>` shapes
   now provide match payload bindings, local aggregate destructuring,
   exhaustiveness, and known arm-result unification. Consuming versus borrowed
   match subjects and payloads now participate in native ownership flow. The same
   flow now covers local/assignment/return destinations, fixed-array elements,
   conditional results, synthesized aggregate fields, enum payloads, and declared
   constructor arguments. Synchronous Z call effects now compose through direct
   and nested value contexts without confusing a pending error with an ordinary
   `Result` value. Any other
   missing foreign/member/async expression model produces an
   unresolved internal type, not a guessed type or user-visible false positive.
3. **Stage 2:** Compile the Z compiler with stage 0, then use that result to
   compile itself.
4. **Bootstrap verification:** Compare generated native source and compiler test
   results across consecutive self-hosted generations. The repository-local
   `bun run bootstrap` command now turns that gate into a native executable
   named `z`: Stage 0 emits generation one, generation one builds generation
   two, and complete generated C must match before publication. A release still
   needs signed trusted platform artifacts. The local bootstrap already
   packages the trusted TypeScript/Clang metadata producer as an adjacent
   standalone tool, so running the resulting toolchain does not require an
   installed Bun command.

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

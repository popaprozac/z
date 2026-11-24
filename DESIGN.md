# Z language charter and design

This document owns the rationale, tradeoffs, intended architecture, and open
design questions behind Z. Accepted source semantics are summarized in
[`docs/language-reference.md`](docs/language-reference.md). Temporary stage-0
implementation coverage belongs in
[`docs/bootstrap-status.md`](docs/bootstrap-status.md), not in the language
contract.

Reading convention: unqualified rules in the core-semantics sections describe
accepted language design. Sections explicitly labeled future, intended,
proposed, or open remain design direction rather than an implementation claim.
The implementation-status document is the authority when deciding whether a
program should compile today.

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

## Design lineage

Z is designed in conversation with existing languages rather than in
isolation. TypeScript supplies much of the surface vocabulary; BorrowScript is
clear prior art for putting readable ownership operations into a
TypeScript-shaped language; Rust, Hylo, Swift, Objective-C, Nim, Zig, C++, and
the ML family supply major parts of the ownership, value-semantics, ARC,
interop, error, pattern-matching, and explicit-cost design landscape. Zen-C
informed the raw-native escape-hatch discussion. Ante's reference-counting and
shape-stability work motivates bounded Z experiments. The implemented guarantee
is deliberately narrower: known local class aliases and fixed-layout field
paths refine existing `in`, `inout`, and `view` checks without new syntax or
runtime alias tests.

These influences do not imply semantic compatibility. Z intentionally combines
and changes ideas: it does not adopt JavaScript's runtime model, Rust's explicit
lifetime surface, Hylo's complete mutable-value-semantics model, Swift's ABI or
exception representation, Nim's object model, or Zig's syntax. The
feature-by-feature acknowledgements and divergences are maintained in
[`docs/influences.md`](docs/influences.md).

## Core semantics

- TypeScript-inspired syntax does not imply JavaScript semantics.
- Z-authored types use `PascalCase`; functions, methods, fields, locals, and
  module exports use `camelCase`. Foreign imports and exported ABI symbols keep
  their declared native spelling.
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
Classes plus nested, object-rest, default, and parameter patterns remain later
extensions.

Contiguous collections also support positional local patterns:

```z
const [first, _, third] = values;
const [head, ...remaining] = view values;
```

Plain bindings perform checked reads and keep the collection alive. Cleanup-free
elements load by value. An explicit `view` source permits cleanup-bearing
element bindings as owner-tied `view T` values and is required for `...rest`;
the rest binding is a zero-allocation local `Slice<T>`. `_` is the explicit
discard spelling, rest must be final, and the backing collection cannot move or
mutate structurally until every projected binding's last use.

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

Numeric value conversion uses target-type construction rather than assertion
syntax:

```z
const nativeCount = isize(values.length);
const nativeWidth = f64(width);
```

This is an executable conversion, analogous to JavaScript's `Number(value)`,
not TypeScript's erased `value as number` assertion. Non-literal numeric types
do not convert implicitly. Construction preserves the same mathematical value
or traps; a source range and precision wholly contained by the target lower to
a direct cast, while narrowing, signedness, fractional, and precision-risk
conversions receive a runtime representability check. A float-to-integer
constructor requires a finite, integral, in-range value, and integer-to-float
construction rejects precision loss. Deliberate rounding is a separate visible
operation such as `u32(math.trunc(value))`, so neither bit loss nor rounding
hides behind ordinary construction.

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

A `move this` value-struct method may transfer the receiver's sole
ownership-bearing field. The transfer consumes the whole receiver, so it does
not create observable partial-move state. Structs with custom `deinit` or
another cleanup-bearing field remain rejected until Z has a general partial
move model. This narrow rule supports mutable builder → readonly publication
without weakening deterministic cleanup.

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

Code placement does not wait for that form. `inline function` (inlined into
every caller, never on a function that calls itself) and `cold function` (out
of line, apart, optimized for size) are contextual keywords in the modifier
position of `async`, `static`, and `override`, keywords only directly before
`function`. They were added after measurement showed that marking trap paths
cold changes nothing, since a C compiler already treats a call that never
returns as unlikely, while an interpreter's dispatch loop is a caller too large
for any compiler to inline into by its own judgement.

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

Call exclusivity is one rule for every call, built-in collection methods
included: borrows and moves of the same storage must not overlap unless all are
`in`. A by-value argument that copies is outside it. The copy of a
cleanup-free value is complete before the callee runs, so
`values.push(values[0])` and `counter.add(counter.step)` need no loan; a value
that moves, shares ARC identity, or carries a view keeps one. In a generic
body the rule is applied per instance, with the type arguments settled.

The bootstrap requires `inout` to name direct initialized mutable storage.
Immutable borrows accept stored expressions and non-cleanup struct literals.
A synchronous `in` call may also borrow an inline `Array<T>(...)`: the compiler
materializes one hidden owner for the statement, borrows it for the call, and
destroys it immediately afterward. Other cleanup-bearing temporary shapes still
require a named binding. An `out` parameter begins
uninitialized and write-only, becomes readable after assignment, and must be
initialized along every successful return path. Uninitialized typed `let`
bindings use the same flow-sensitive analysis. Multiple `in` uses may share one
root in a call; uses involving writable access or ownership must not overlap it.
Overlap follows fixed field paths, and an element path keeps the field prefix
before its first index: sibling fields are disjoint, while elements of one
collection conservatively overlap.

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

Initialized storage can be exchanged without destroying its current owner via
the selectively imported `std/memory.replace` utility:

```z
import { replace } from "std/memory";

let active = Resource({ id: 1 });
const pending = Resource({ id: 2 });
const previous = replace(inout active, move pending);
```

The target must be mutable and initialized, the replacement must have exactly
the same type, and a named ownership-bearing replacement requires explicit
`move`. The old value is returned as an owner while the target stays
initialized. Lowering is one native load, store, and return with no allocation,
retain, or copy. This operation does not synchronize; view-bearing storage is
rejected until its provenance can be transferred as part of the exchange.
Direct ARC bindings transfer alias identity and local-containment evidence;
aggregates containing nested ARC identities remain rejected until that evidence
can move with the complete value.

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
synchronous `in T` parameter or a proven nonescaping inline closure. A local
value struct may also contain one or more `view` fields when every field has the
same proven owner. That inferred-`const` composite cannot be copied and may be
transferred only into the Arena that owns its embedded views:

```z
struct Span {
  first: view Coordinate;
  last: view Coordinate;
}

const pending = Span({ first, last });
const stored = arena.create(pending);
inspect(stored); // `in Span`
```

The first dynamic-provenance slice extends that rule to a populated `Array` of
one-owner view-bearing value structs:

```z
const pending = Span({ first, last });
const pendingSpans = Array<Span>(pending);
const spans = arena.create(pendingSpans);
inspect(spans[0]);
```

Every element must have the same Arena provenance. Populated construction
consumes the element composites, the inferred `const` Array may move only into
that Arena, and the Arena owns both the growable buffer and its borrowed edges.
An empty mutable Array may establish that identity with its first consuming
`push`:

```z
let pendingSpans = Array<Span>();
pendingSpans.push(Span({ first, last })); // establishes `arena`
pendingSpans.push(anotherSpan);           // must also belong to `arena`
const spans = arena.create(pendingSpans);
```

The establishing push may occur in straight-line code or across exhaustive
`if`/`match` branches when every continuing path proves the same owner. A path
that leaves the Array empty or establishes another Arena is rejected at the
join. A loop body cannot establish provenance because it may execute zero times.
Later pushes may use ordinary control flow but must match the established Arena.
Structural mutation is rejected while an element view or iteration loan is live
because `push` may reallocate the buffer.

An enum may carry the same fixed graph edge when each variant payload is a
named, one-owner view-bearing value struct:

```z
enum StoredSpan {
  primary Span,
  none,
}

struct Node {
  span: StoredSpan;
}

const pendingSpan = StoredSpan.primary(Span({ first, last }));
const pendingNode = Node({ span: pendingSpan });
const node = arena.create(pendingNode);
const span = node.span;

match (in span) {
  primary(value) => inspect(in value);
  none => {}
}
```

Construction consumes the payload and transfers its one Arena identity to the
enum. The enum may then move through other value structs and only into that
same Arena. Matching must borrow proven storage with `match (in value)`; the
active payload binding inherits the owner's provenance for the arm. The first
tier records payloadless or otherwise non-view-bearing alternatives as carrying
no active Arena identity. At expression joins, ownerless plus Arena A
conservatively becomes A, matching owners remain that owner, and different
owners are rejected. This is flow evidence rather than a hidden runtime tag.
Direct `view T` payloads, object-pattern destructuring, mixed owners, copying,
consuming matches, mutation, escape, and suspension remain rejected.

The first recursive graph tier uses the existing `Option<view T>` shape for a
nullable edge to another value in the same Arena:

```z
struct Node {
  value: i32;
  next: Option<view Node>;
}

const tail = arena.create(Node({
  value: 22,
  next: Option<view Node>.none,
}));
const head = arena.create(Node({
  value: 20,
  next: Option<view Node>.some(tail),
}));
```

`none` carries no owner. `some(view)` inherits the view's proven Arena, so the
containing node may move only into that same Arena. An ordinary local value
cannot be asserted into `Option<view T>`, and a link from Arena A cannot enter a
node stored in Arena B. Both frontends lower this Option to one nullable pointer;
there is no tag, payload union, retain, or cleanup operation.

The first associative region tier applies the same proof to Map values:

```z
struct SymbolLink {
  declaration: view Declaration;
}

let symbols = Map<String, SymbolLink>();
symbols.set("main", SymbolLink({ declaration }));
const storedSymbols = arena.create(symbols);
```

An empty view-bearing Map must use `let`. Its first `set` establishes one Arena
owner, later values must prove that same owner, and the Map may move only into
that Arena. `get` remains a zero-copy `Option<view V>` into Map storage, so
structural mutation is rejected while the lookup view is live. This tier keeps
keys independently owned and allows only named one-owner value structs; direct
views, mixed owners, first insertion inside a loop, escape, and suspension are
rejected. Native lowering supports `set`, `has`, and `get`; the
ownership-bearing `remove` path returns a tagged `Option<V>`, transfers the
stored value without copying it, and preserves its Arena proof. `delete`
destroys a matching key/value and returns whether it existed; `clear` destroys
every entry while retaining reusable allocation and the Map's established
Arena proof.

One Arena and its proven dependent graph may be closed into a returned owner
without exposing a lifetime parameter:

```z
struct NodeRef {
  node: view SyntaxNode;
}

readonly struct ParsedFile {
  arena: Arena;
  roots: Array<NodeRef>;
}

function parse(): ParsedFile {
  let arena = Arena();
  const node = arena.create(SyntaxNode({ kind: 42 }));
  const roots = Array<NodeRef>(NodeRef({ node }));
  return ParsedFile({ arena: move arena, roots: move roots });
}
```

This is a closed region, not a general escaping borrow. The value struct must
be readonly, own exactly one direct Arena, and initialize every view-bearing
field from that Arena. Construction explicitly moves the Arena and dependent
owners together, invalidates earlier local views into the region, and makes the
completed bundle the provenance root for later projections. It may return,
cross a module boundary, move into a synchronous owned parameter, or enter a
synchronous `in` parameter. Dependent fields are destroyed before the Arena.
The wrapper is an ordinary by-value C struct and adds no allocation, retain, or
runtime provenance tag beyond the storage its fields already own.
Struct spread, nested bundles, collection storage, closure capture, generators,
async suspension, multiple Arenas, and mixed provenance remain rejected.

The Arena then owns both the composite's storage and the region that validates
its internal pointers. Borrowed fields do not participate in destruction;
ordinary owned fields still clean up newest-first with the containing value.
View-bearing structs cannot enter classes, general returns, stored or escaping
closures, mutable borrows, or suspension. The closed-region bundle above is the
only returned-storage exception. Ordinary collections reject them except for
the compatible-owner `Array`, Map-value, and Set-element rules above; enums
accept the variant-sensitive one-owner rule above; recursive links are limited
to same-Arena `Option<view T>`. The tier is
single-threaded and allocation failure traps.
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
decide how mutable and broader container-held projections carry provenance,
whether enum alternatives can omit the owner, whether pages are reused,
whether arenas can be sendable, and where allocator parameters belong on
collections and APIs.

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

Value-struct construction supports one leading, same-type spread:

```zs
const resized = WindowOptions({
  ...defaults,
  width: 1200,
});

const snapshot = WindowOptions({
  copy ...current,
  title: "Snapshot",
});

const transferred = WindowOptions({
  move ...pending,
  title: "Ready",
});
```

The source must be a named local with the exact nominal struct type being
constructed, including the same generic specialization. Arbitrary spread
expressions remain deferred so ownership diagnostics can name a stable source.
A spread is evaluated once and must precede all explicit fields. Later fields
override the corresponding source fields; there is no order-dependent merging
after those overrides.

Bare `...source` is an immutable spread. It may retain ordinary cleanup-free
values and shared identities, but it never transfers a unique owner.
`copy ...source` applies Z's explicit-copy operation to every retained field,
leaving the source available. A retained ARC/class identity is not independently
copyable and therefore rejects this form unless explicitly overridden. Both
checks apply only to fields retained from the source, so an explicitly
overridden move-only field does not make a copy spread invalid.
`move ...source` is accepted only when the struct carries unique ownership,
transfers retained fields, and consumes the entire source binding. An
overridden cleanup-bearing field from a moved source is destroyed exactly once
rather than transferred; Z does not expose a partially available aggregate.

Because the source is already a complete value of the same type, it supplies
every non-overridden field and no field default is evaluated. Explicit
initializers are evaluated in source order after the spread. Construction
temporaries participate in ordinary ownership liveness, so an exit while
evaluating an override destroys already acquired fields and any remaining
consumed source storage exactly once.

The initial lowering supports nested Z-owned resources, including
`String`, collections, enums, options, classes, and Z structs with their own
`deinit`. It rejects a spread when the outer struct itself declares custom
`deinit`, because field-wise reconstruction would bypass its aggregate
invariant. It also temporarily rejects nested native C++/Swift/foreign value
storage until relocation and destruction use native-aware lowering.

The first tier deliberately permits only one leading spread. Multiple
construction spreads need a separate rule for per-spread capability and
left-to-right conflict order. Object-rest destructuring is also deferred:
`const { foo, ...rest } = value` needs either a named nominal remainder type or
a deliberately designed anonymous remainder-record model. Neither future
surface has a locked syntax or type rule yet.

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
owned result remains `Option<U>`. A method-declared `view U` result becomes
`Option<view U>` and requires a named optional-owner binding; chaining from a
temporary such as `make()?.current()` is rejected because no stable provenance
can be exported. The receiver is evaluated once.

`throws E` remains an independent effect: an absent receiver is successful
`none`, while a present receiver may still produce `failure E`, so `try` and
`attempt` remain explicit at the call site. The first tier rejects `inout this`
and `move this` methods through `?.`; an explicit `match` must expose mutation
or ownership transfer. This keeps optional chaining as compact control-flow
sugar rather than a hidden capability-changing operation. The first executable
tier is synchronous; async source is checked, while Phase-1 async-frame
execution remains deferred.

Optional-chain expressions are never assignment targets, including when the
optional segment is nested inside a longer member path. Mutation requires an
explicit `match` that establishes present, addressable storage.

Struct declarations and class declarations retain brace-delimited bodies, while
initialization data is an object expression inside call parentheses. `new` is
reserved for native class construction and is not a general allocation operator.
It promises reference identity and an initial owning reference, not a particular
physical heap strategy. A class with no constructor receives synthesized
fieldwise initialization through `new Type({ ... })`. A declared constructor
changes the call shape to `new Type(arguments...)` and is the only construction
path for that class.

Constructors use the same visibility vocabulary as fields and methods. An
unmarked or `public constructor` is callable wherever the class is visible;
an `internal constructor` is callable only from modules with the class's exact
manifest-defined package identity; and a `private constructor` is callable only
inside the declaring class, including its static factories. This lets a package
export a nominal class type and public behavior without publishing arbitrary
construction. Inaccessible constructor signatures are omitted from public
metadata and editor call surfaces, while the class remains nameable as a type.

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
destructuring, move-only foreign iterator elements, tuple and match-array
patterns, and async iteration over non-generator iterator shapes remain later
layers.

## Arrays and views

`T[N]` is a fixed-size inline value whose length participates in its type. Array
literals use `[a, b, c]`, indexing uses `values[index]`, and `.length` produces
`usize`. A `let` array permits element replacement; a `const` array is immutable
through its elements. Nested arrays and arrays inside structs retain value
semantics.

Safe indexing performs a bounds check and traps on failure. Inside `unsafe`,
`values.uncheckedAt(index)` and `values.uncheckedSet(index, value)` access a
cleanup-free element whose bound the programmer has established, such as an
interpreter's register window validated once at frame entry: a debug build
still checks and traps, a release build trusts the assertion. The spelling is
a method rather than unchecked `[]` so that only the accesses the proof covers
lose their check. Ordinary optimization should eliminate checks proven
redundant by loop and range analysis.

Cleanup-bearing arrays own every initialized element and destroy them in reverse
index order. Moving an individual cleanup-bearing element out is initially
rejected because it would create partially initialized storage; whole arrays
follow ordinary move rules.

`Slice<T>` is a non-owning contiguous pointer/length view. Parameters remain its
ordinary spelling: a compatible fixed or growable array converts to a slice for
one call. Array-rest destructuring may additionally create a compiler-proven
local subslice through `const [...rest] = view values`; that binding carries its
named owner and cannot escape. A call-scoped range `values.slice(start, end)`
may be passed directly as a Slice argument; it borrows `[start, end)` of its
receiver through the ordinary call loan and traps unless
`start <= end <= length`. Arbitrary Slice locals, returns, aggregate/enum
storage, and captures remain rejected. This keeps source lifetime obvious
without requiring a source-level lifetime name.

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
capacity. `Array<T>.withCapacity(minimumCapacity: usize)` creates empty owned
storage with at least the requested total element capacity. The instance method
`reserveCapacity(minimumCapacity: usize): void` grows only when needed and never
shrinks or changes initialized length. Zero initial capacity needs no allocation.
Both operations check allocation-size arithmetic and trap on allocation failure,
as ordinary growth does. Reserving an existing Array requires exclusive mutable storage; it does
not make a live view compatible with potential relocation. Uninitialized capacity
is inaccessible and contributes no element construction or destruction.
`append(items: Slice<T>): void` copies a run of cleanup-free elements onto the
end with one capacity check and one block copy; the receiver's `inout` loan and
the elements' `in` loan meet in the ordinary call checker, so self-append is a
compile-time error rather than a runtime alias test. Element types that own
storage wait for an explicit per-element copy design.
`copyWithin(target: usize, start: usize, end: usize): void` moves the
cleanup-free elements in `[start, end)` to `target` as one block move, overlap
allowed, after checking both ranges against the length; it never grows, so
there is no loan between the receiver and itself to check, only positions.
`appendRepeated(value: T, count: usize): void` stores one cleanup-free value
`count` times onto the end with one capacity check: the form a zeroed table or
a run of empty slots takes. It only adds elements; there is no resize that
also truncates.
`Array<T>` carries its allocation, initialized length, and capacity as one
move-only value. `push` requires addressable `let` storage, checks capacity
arithmetic, grows geometrically, and transfers or copies the element according
to its ordinary ownership rules. Safe indexing uses the same bounds check as
fixed arrays. Destruction walks initialized elements in reverse order before
freeing the buffer.

Owned collections have an explicit publication boundary:

```z
let handlers = Map<String, Handler>();
handlers.set("open", openHandler);
const published: readonly Map<String, Handler> = handlers.freeze();
```

Type-position `readonly` is deliberately limited to `Array<T>`, `Map<K, V>`,
and `Set<T>` in this tier. It removes structural mutators while preserving the
same owning representation and deterministic cleanup. `freeze()` consumes the
mutable named owner and transfers its allocation without copying, allocating,
or walking elements. It is distinct from declaration-position `readonly`:
`readonly handlers: Map<K, V>` prevents field replacement but leaves mutable
Map behavior reachable, while `handlers: readonly Map<K, V>` freezes the
collection capability. A shared class generally needs both positions. There is
no implicit or explicit thaw in the first tier.

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
The local-only form also permits a direct fixed-layout field of a locally
contained Z ARC class owner. The first containment proof begins at synthesized
`new Class({ ... })` construction and follows direct named aliases. A class
returned by a function, constructed by user code that can publish `this`, or
previously passed as an owned value does not qualify. Storing, owned passing,
or move-capturing the identity invalidates the proof for every known alias;
doing so while a field view is live is rejected. Known contained aliases share
the same field loan: an overlapping field or whole-instance mutation is
rejected while a sibling field remains available. This does not extend to
returned class-field views, nested aggregate/class traversal, foreign
references, escape, or suspension.

For bounded synchronous call exclusivity only, a directly constructed local
value struct may remember the identity stored in an explicit direct class
field. Direct projection, local rebinding of that projection, and direct field
replacement preserve or update the evidence, so `inout application` conflicts
with `context.application` when both name one ARC object. This is compile-time
flow evidence with no runtime representation and does not restore the stronger
local-containment proof required by `view context.application.field`. Struct
spread, nested aggregate paths, collection/return storage, branch joins, and
suspension remain conservative. An opaque direct class field is an unknown
alias for exclusivity purposes, so absent provenance cannot be mistaken for
proof that two identities are distinct.
One module function may also directly construct and return a named value struct
whose direct `view` fields all project from the same immutable input. The
aggregate lowers to an ordinary C value struct containing borrowed pointers;
the caller's inferred loan is attached to the aggregate binding and ends at its
last use. Different return paths may choose different inputs, conservatively
loaning all possible sources. This first retained tier rejects forwarding,
local-storage escape, mixed owners within one result, nested view-bearing
fields, spread, methods, throwing or suspending producers, and storage in a
class, enum, or collection.
The local form lowers to `const T *` and does not copy the projected value. The
same pointer representation survives read-only `Array<T>` indexing, length,
and iteration plus read-only `String` inspection, comparison, and formatting;
an explicit `copyBytes` remains the operation that produces an owned String.
This is intrinsic composition over the existing owner loan, not a general
stored-borrow or lifetime mechanism. The
first slice intentionally omits removal, reservation, fallible allocation,
escaping slices, stored subslices, stored class-owned views, and general lifetime
parameters.
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

Every integer type also provides `wrappingShiftLeft(count: usize)`, returning
the receiver's exact type without mutating it. It discards high result bits and
zero-fills low bits; signed results preserve the resulting two's-complement
representation. Counts must be less than the receiver's bit width. Known
invalid counts are diagnosed even when the receiver is not constant; dynamic
invalid counts trap. The count is never masked or reduced modulo the width.
This is not rotation. Ordinary `<<` retains its count and result-overflow checks.
The method requires no allocation or reference counting; a proven-valid
constant count can optimize to a native shift without a runtime check.

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

**Planned direction (2026-09-10; not implemented):** refutable pattern bindings
with an explicit, non-fallthrough `else`, such as
`const some(note) = selection else { return Option.none; };`. This reuses match
patterns without changing `try` or `attempt`.

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

The pattern system is exhaustive. A final bare `_` arm matches every remaining
variant without binding its payload:

```z
const text = match (value) {
  string(text) => text;
  _ => "unsupported";
};
```

The wildcard must be final; any later arm is unreachable. Under a consuming
`match (value)`, an owned payload discarded by `_` is still destroyed exactly
once. Under `match (in value)`, `_` only observes the remaining case and leaves
the owner alive. Future pattern tiers include type patterns, guards, literals,
and or-patterns.

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

An ordinary or `on thread.main` capturing environment uses executor-local ARC.
The main-qualified type preserves construction, invocation, storage, and
destruction affinity through aliases and aggregate fields; it may capture
main-isolated state but cannot be weakened to an ordinary local callable or
transferred to a worker. `on thread.any` uses atomic environment ownership and
requires a recursively shareable capture graph. Explicit weak values can be
captured to break class/closure cycles. Inferred single-parameter syntax, weak
capture-list sugar, direct strong capturing of `this`, and automatic cycle
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
values, condition variables, and semaphores belong to later `std/sync` tiers
whose guard values should use the same move-only cleanup model as the initial
`OnceLifetime<T>`.

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

### Package-internal visibility

Real framework composition has established a need for one visibility tier
between module-private and public API. Zapp's public `Window` handle, for
example, delegates through application-owned manager and platform-lifecycle
operations. Those operations must be callable across cooperating framework
types and source modules, but must not become callable application API merely
because `private` is correctly limited to the declaring aggregate.

The spelling is `internal`:

```z
export readonly class WindowManager on thread.main {
  function create(
    inout this,
    options: WindowOptions
  ): Window throws WindowError on thread.main;

  internal function showWindow(
    inout this,
    in id: String
  ): void on thread.main;
}

internal struct WindowRecord {
  id: String;
  nativeId: usize;
}
```

`internal` is implemented as compiler-enforced visibility to the declaration's
owning package. Internal
declarations, members, and constructor signatures must be absent from public package metadata,
documentation, and application completion, and an external call must be a
compile error. `private` continues to mean the declaring aggregate only;
unexported declarations continue to mean the declaring source module only.
At module scope, `internal` is a package-only export: sibling modules in the
same package use ordinary import syntax, while external consumers cannot name
it. `internal` and `export` are mutually exclusive, and a top-level internal
declaration is legal only when its source belongs to a manifest with an
established package identity.

TypeScript libraries often approximate this boundary with non-exported
implementation classes and narrower exported interfaces. Z should continue to
use that architecture where it produces a better public contract, but it is not
a complete substitute here: TypeScript has no enforced package-internal access
tier, and its consumers can ultimately escape erased interfaces. Z's internal
operations can preserve ownership, executor, native-lifetime, and registry
invariants, so the boundary cannot be a double-underscore naming convention or
declaration-emission hint.

Package identity comes from the owning `z.json`, never merely from directory
ancestry or membership in the current linked graph. Local path packages use the
canonical resolved manifest as identity; eventual registry packages must feed
the resolver an equivalent canonical identity. A top-level `internal`
declaration without `package.name` is rejected. The fixed-point frontend
preserves this visibility in its source graph and public metadata filters it.
Both Stage 0 and the standalone native driver derive canonical root and
transitive dependency identities from their resolved manifests, so the same
boundary applies during bootstrap, native checking, and native builds.

Module-level `const` declarations provide immutable named compile-time values:

```z
// app-config.zs
export const APP_NAME: String = "Notes";
export const DEFAULT_PORT: u16 = 34115;
export const ENABLE_METRICS: boolean = true;

const CONFIG_REVISION = 1;
```

They use the same namespace and selective import surface as functions and
types. Z deliberately has no module-level `let`: the initial model introduces
neither mutable global state nor module initialization order. Exported constants
require an explicit type as part of their public contract, while private
constants may infer one. The executable foundation is restricted to cleanup-free
literal `boolean`, numeric, and `String` values plus explicitly typed `cstring`
string literals. Calls, runtime initialization, ownership-bearing storage, and
target-conditional values remain later design work. C-ABI library targets have
one separate explicit escape from this restriction: `target.runtime.initialize`
names an entry-module function whose cleanup-bearing result is owned by the
generated target runtime until shutdown. That is target lifecycle, not module
initialization; importing the module still executes nothing.

Long-lived application identity uses a distinct standard-library capability,
not a relaxation of module `const`:

```z
import { Once } from "std/sync";
import { thread } from "std/thread";

class Application on thread.main {
  readonly name: String;
}

const application = Once<Application>();

async function main(): i32 on thread.main {
  const value = new Application({ name: "Notes" });
  const lifetime = application.initialize(move value);

  // Other modules may now call application.get() under main-executor proof.
  return 0;
} // lifetime deinitializes, removes the root, and releases its ARC reference
```

`Once<T>()` is a statically empty cell rather than a runtime module initializer.
`initialize(move value)` performs its one publication transition and returns a
move-only `OnceLifetime<T>` guard. The guard owns the published interval:
deinitializing it removes the value from the cell and releases the cell's strong
ARC reference on the required executor. `get(): T` returns a retained class
identity while that interval is active. Access before initialization, duplicate
initialization, and access after guard cleanup are invariant violations and
trap; absence is not part of the result type. The runtime distinguishes a cell
that has never been initialized from one whose publication lifetime has closed.
Retrieval and cleanup are serialized: a retrieval that wins retains an
independent ARC reference, while a retrieval after cleanup traps. Structured
workers that may call `get()` must therefore join before the lifetime closes.
`OnceLifetime<T>` is exported from `std/sync` so a wrapper may state its public
return type, but user code cannot construct one independently of
`Once<T>.initialize`.

Direct `get()` results carry the module cell's canonical ARC identity into the
synchronous capability checker. A synchronous, nonthrowing, zero-argument
accessor whose entire body is `return cell.get();` transparently exports the
same identity across source-module imports. This is structural compiler
evidence rather than new syntax or a function-name convention. It lets
overlapping `inout`/`in` uses of two `currentApplication()` results fail as
aliases, while distinct `Once` cells remain distinct. The identity is still
globally published and therefore does not satisfy the stronger local
containment proof required for class-field `view` projection.

Argument evaluation happens before `initialize`. A fallible construction is
first bound through ordinary propagation, then that named value moves into the
cell:

```z
const ready = try new Application(configuration);
const lifetime = application.initialize(move ready);
```

If construction fails, control never reaches `initialize` and the cell remains
empty. The failure is not stored and a later `get()` cannot replay it. This
keeps `Once<T>` responsible only for publication and lifetime, while ordinary
`try`/`attempt` remain responsible for creating the value.

`Once` accepts ARC class payloads whose lifecycle belongs to
`thread.main`, whether that affinity is declared on the class or inherited
from a main-bound field. Construction and initialization require main-executor
proof. `get()` itself is intentionally unrestricted: it returns retained ARC
identity, after which each field and method enforces its own executor contract.
A worker may therefore use readonly thread-safe metadata and `Mutex`-guarded
methods directly, while main-only behavior still requires explicit placement.
Final release from a worker is queued to main so guard cleanup and `deinit`
retain their lifecycle affinity.

Compiler-proven shareable ARC classes are also valid payloads. Their immutable
graph may contain `Mutex<T>`-protected mutable state; the existing shareability
and worker-destruction rules apply, including checked `deinit on thread.any`
for custom cleanup. Initialization and guard cleanup then require no main-thread
placement. The guard remains move-only and may transfer to another thread;
closing it releases the cell's reference, not handles already retained by callers.
A library with only thread-independent state can initialize and shut down on
host worker threads without main-thread proof or release hooks. Any other
main-bound requirement in that library still requires those hooks.

Unsynchronized mutable classes, structs, native owners, replacement, and
optional storage remain outside this contract. In particular,
`Once<T>` is not module-level mutation, a lock, or a general singleton keyword;
`Application` remains an ordinary user-defined framework type.

Shared mutable state uses the separately imported `Mutex<T>` capability:

```z
import { Mutex } from "std/sync";

struct ApplicationState {
  openDocuments: i32;
  revision: i32;
}

function inspectApplicationState(): i32 {
  const state = Mutex(ApplicationState({
    openDocuments: 0,
    revision: 1,
  }));

  state.withLock((inout value): void => {
    value.openDocuments = value.openDocuments + 1;
    value.revision = value.revision + 1;
  });

  return state.withLock(
    (in value): i32 => value.revision
  );
}
```

`withLock` acquires an exclusive native mutex and blocks the executing OS
thread until it can enter the closure. It does not suspend an async task,
cooperate with the executor, or move work to another thread. Code that cannot
afford to block an executor thread must not use this primitive there;
cross-thread transport and scheduler-aware synchronization are later,
separately explicit capabilities.

The closure is deliberately synchronous and non-escaping. Its explicit
capability describes access to the protected value: `in` permits reads and
`inout` permits mutation. The protected borrow ends when the closure returns or
throws, and the mutex is unlocked on either path. `await`, returning a `view`
or other borrow of the protected value, storing that borrow, and capturing it
in an escaping closure are rejected. An independently owned result may leave
the closure. An ordinary typed `throw` does not poison the mutex: cleanup runs
before propagation and a later caller may acquire it again. An invariant trap
terminates the process rather than unwinding through the critical section.
`Mutex<T>` is non-reentrant. Directly nesting `withLock` on the same named
mutex is rejected because the second acquisition would deadlock the current
OS thread; code inside the first closure should reuse its protected binding.

Z uses a closure rather than exposing a general lock guard in this first tier
because the callable boundary makes the critical-section lifetime structural.
It prevents forgotten unlocks, guard escape, suspension while locked, and
accidental use of protected storage after release without requiring a visible
lifetime parameter. Rust commonly returns an RAII guard from `lock`; Go and
Zig commonly expose explicit lock/unlock operations, with Go often pairing
unlock with `defer`. Z's scoped callable preserves deterministic cleanup while
letting the compiler prove non-escape directly. A future guard API is not ruled
out if real programs demonstrate a shape that cannot be expressed cleanly with
`withLock`.

`const Mutex<T>` local storage means that the mutex identity cannot be rebound.
Mutation of `T` remains possible only through
`withLock((inout value) => ...)`; it does not make ordinary `const` values
mutable. This controlled interior mutability is the reason `Mutex<T>` is
useful as shared state rather than merely as a standalone lock.

When `T` has thread-transferable storage and thread-independent destruction, a
`move` native-worker closure may capture `Mutex<T>` without consuming the
caller's handle:

```z
const state = Mutex(ApplicationState({
  openDocuments: 0,
  revision: 1,
}));

const worker = thread.spawn(move (): void => {
  state.withLock((inout value): void => {
    value.revision = value.revision + 20;
  });
});

state.withLock((inout value): void => {
  value.revision = value.revision + 21;
});
await worker;

const revision = state.withLock(
  (in value): i32 => value.revision
);
```

The closure owns one atomically retained handle to the same heap cell; it does
not copy `T` or allocate another native mutex. This is an internal sharing
operation, not permission to write `copy state`: ordinary explicit duplication
of `Mutex<T>` remains rejected. The last handle destroys the protected value
and native mutex exactly once. A main-isolated, borrowed, or otherwise
non-transferable payload keeps its Mutex on the owning thread and produces a
diagnostic at the `thread.spawn` boundary.

The first tier is an exclusive mutex. Read/write locks, condition variables,
semaphores, atomics, asynchronous mutexes, timed acquisition, nonblocking
acquisition, and direct public handle copying remain separate designs.

Cross-task communication uses typed channels from `std/channel`:

```z
import { Channel, ChannelClosed, Sender } from "std/channel";

struct Job {
  path: String;
}

async function produce(sender: Sender<Job>): void throws ChannelClosed<Job> {
  const job = Job({ path: "guide.md" });
  try await sender.send(move job);
  sender.close();
}

async function main(): i32 throws ChannelClosed<Job> {
  const { sender, receiver } = Channel<Job>.bounded(64);
  const producer = task produce(move sender);
  const next = await receiver.receive();
  try await producer;
  return match (next) {
    some(job) => i32(job.path.byteLength);
    none => 0;
  };
}
```

`Channel<T>.bounded(capacity)` returns a split multiple-producer,
single-consumer pair. Capacity is explicit and must be greater than zero. The
split is part of the capability model: `Sender<T>` may be retained and shared
between safe producers, while `Receiver<T>` remains unique. Z does not expose
one symmetric channel handle whose receive authority can be accidentally
duplicated.

The asynchronous endpoint surface is deliberately small:

```z
async send(move value: T): void throws ChannelClosed<T>
async receive(): Option<T>
close(): void
```

`send` transfers message ownership. It completes immediately when the bounded
buffer has room and otherwise suspends the current task without blocking the
executor thread. If closure wins, `ChannelClosed<T>` returns the unsent owner
as `error.value`; a failed send never silently destroys the message. `receive`
completes immediately when a buffered message exists, suspends while the
channel is open and empty, and returns `none` only after closure and buffer
drain. Explicit `close()` wakes both kinds of waiter. Releasing the last sender
also closes the channel. Cancellation unregisters a suspended operation before
its task frame is destroyed.

Blocking native-thread access is an explicit endpoint conversion rather than
an overload chosen by context:

```z
const syncSender = sender.sync();
const syncReceiver = receiver.sync(); // consumes the unique Receiver<T>

try syncSender.send(move job);        // blocks while full
const next = syncReceiver.receive();  // blocks while empty and open
```

The names remain `send` and `receive` because the endpoint type already states
the scheduling behavior. `SyncSender<T>` retains shared send authority;
`Receiver<T>.sync(move this)` consumes the unique asynchronous receiver and
produces one `SyncReceiver<T>`. Synchronous channel operations should not be
used on an executor thread that cannot afford to block.

The first tier requires a direct `await receiver.receive()` so one lexical
receive operation owns the unique endpoint at a time. Concurrent receive loans,
selection across channels, timeouts, zero-capacity rendezvous channels, and
unbounded storage remain future designs. The future unbounded factory is
reserved as the explicit `Channel<T>.unbounded()` spelling; omitting capacity
will not silently select a different resource policy.

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

Framework tools may provide a versioned generated-build overlay for one compiler
invocation:

```text
z build . --generated .zapp/generated/services.zbuild.json
```

The overlay is not an authored package manifest and is never installed as a
dependency. It maps exact bare specifiers to generated `.zs` modules and may
assign a module an existing package identity so compiler-generated framework
code can use that framework's `internal` implementation surface. An unknown
package, import collision, missing source, malformed overlay, or stale
transformation is an error. Generated modules remain ordinary checked Z: their
imports, exports, ownership, executor requirements, and native dependencies do
not bypass semantic analysis.

The intended call-adaptation tier is similarly declarative. A record identifies
one source hash and call offset, the original semantic target, one replacement
target, an argument position, and an exported adapter in a generated module.
The compiler must re-resolve and type-check every named symbol before lowering;
it never executes the generator during compilation and never edits authored
source. This is deliberately narrower than macros and is suitable for RPC,
serialization, service registration, and dependency-injection tooling. Both
compiler drivers now execute this first call-adaptation tier: they check the
source hash and exact call offset, prove the original resolved method, permit
replacement only by another method on that same receiver type, import the
named generated adapter synthetically, and re-run ordinary semantic analysis
over the transformed AST. A stale target, wrong argument position, unavailable
export, or ill-typed replacement is therefore a source-located error rather
than a generated-source failure. The fixed-point driver owns its SHA-256 proof,
native expression-tree transformation, generated-module loading, and second
semantic pass rather than trusting evidence prepared by Stage 0.

If the named adapter module is assigned an existing package identity, the one
synthetic replacement-member access may use that identity to select an
`internal` method owned by the same package. This authority does not attach to
the authored module, does not authorize other expressions, does not bypass
`private`, and is absent when the generated module has no package assignment.
This lets a framework retain a clean public marker while keeping its generated
runtime operations out of consumer metadata and editor surfaces.

Package implementation is intentionally queued behind native-compiler
verification. The intended sequence is local path packages and a deterministic
lockfile, system-native dependency verification, a curated contract index, and
only then remote Z package resolution. Contract policy must distinguish
machine-verifiable ABI facts from behavioral ownership, lifetime, callback, and
threading assertions, and must record whether a dependency uses `unsafe` or
`raw`.

A source file does not need a module declaration or a `main` function. Checking
and editor analysis accept declaration-only and export-only modules. Executable
context supplies the distinction: an explicit file selected by `z run`, an
executable project's `z emit`, or an executable project's `target.entry` must
declare `function main(): i32`. Static- and shared-library
entries are export-only graphs and do not. Every manifest target has a portable
`target.name` and `.zs` `target.entry`; omitting `target.kind` selects an
executable. Project-directory `check`, `run`, and `build` use that entry, while
an explicit `.zs` argument overrides entry selection without discarding the
surrounding deployment and native-link configuration. This keeps module
identity in the import/build graph rather than duplicating it in source syntax.
Static and shared libraries use the same checked `export c` boundary and
generated header; their target kind selects archive or host-native dynamic
linkage. Versioned shared-library identities, installation layouts, Windows
import libraries, and installation-oriented artifact emission remain later
layers. `z emit` accepts an explicit source file, project directory, `z.json`,
or the current project by default and prints the complete generated C-family
translation unit to standard output without writing project artifacts.

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
the field path that introduced inferred isolation.

Stored members may narrow that contract without isolating every operation on
the containing ARC identity:

```z
class Application {
  readonly name: String;
  readonly state: Mutex<ApplicationState>;
  window: AppKit.NSWindow on thread.main;

  function revision(): i32 { /* may run on any thread through state */ }
  function showWindow(): void on thread.main { /* may access window */ }
}
```

The positive suffix remains `field: Type on thread.main`; there is no
`nonisolated` escape from a whole-class declaration. The selected field makes
construction and destruction main-bound. Other fields are usable off-main only
when they are readonly and transitively thread-safe, including a retained
`Mutex<T>` handle. An unrestricted method is checked under no executor proof,
so touching the selected field requires that method to declare the same
affinity. Bare `this` cannot escape from an unrestricted mixed-affinity method.
A main-only trait implementation cannot satisfy an any-thread requirement,
while an any-thread implementation may safely satisfy a main-only requirement.

The current tier rejects off-main use of the affected calls, construction,
member access, function-value erasure, and placement results. A native worker
may carry a fully isolated Z ARC identity only opaquely. A mixed-affinity class
additionally exposes its proven readonly thread-safe members and unrestricted
methods; selected members still require a nested main placement. In both cases
the worker's retain is released back on main. Async isolated functions do not
auto-hop yet; callers use `await on thread.main`.

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

Target selection follows the configured build target, never the machine that
happens to run the compiler or language server. Inactive platform source must
remain parseable, navigable, hoverable, and available to definition lookup, but
its unavailable imports and declarations must not produce ordinary semantic
errors for the selected target. Editors should render it as inactive and state
the target reason rather than covering a shared file in red diagnostics. The
compiler should also be able to check an explicit target matrix and diagnose a
missing implementation before packaging.

Framework consumers such as Zapp should select platform implementation modules
once behind a shared Z contract. Application and framework logic then imports
one portable facade, while macOS, Windows, and Linux modules contain only the
native construction or behavior that truly differs. Scattered target branches
inside otherwise shared functions are an escape for small constants or narrow
operations, not the default cross-platform architecture. The eventual syntax
must preserve that DRY module shape without introducing textual preprocessing.

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
Its implemented value tier accepts ABI-stable scalars, owned UTF-8 `String`
inputs, borrowed read-only `Slice<u8>` inputs, checked by-value
`c struct` records, and payload-free `c enum Name: integerType` values; emits a
public wrapper plus a C/C++-compatible header; validates enum inputs from C; and
rejects generics, errors, async, affinity, and Z-owned representations at the
source declaration. Static-library output and a handwritten strict-C consumer
prove that boundary before general slices, projected errors, owned results,
callbacks, or async exports. Byte inputs expand to `const uint8_t *` plus
`uintptr_t` length without copying or decoding; null is accepted only at zero
length. The host maintains valid, unmodified storage during the synchronous
call, and the Z slice cannot escape or be mutated. String inputs instead
validate and copy NUL-terminated UTF-8 into owned Z storage.
An optional manifest-selected runtime initializer
may return one cleanup-bearing owner such as `OnceLifetime<T>`; generated
initialize retains it and generated shutdown destroys it after active foreign
entries leave. Main-bound roots require explicit host thread proof and release
scheduling rather than trusting the calling thread.
The wrapper keeps Z's internal identity private and should optimize away when
the implementation is trivial. The complete accepted direction is recorded in
[`docs/c-exports.md`](docs/c-exports.md).

## Inline assembly

Inline assembly is not implemented. The intended direction is an explicit,
target-specific `unsafe` boundary whose operands use the existing `in` /
`inout` / `out` capabilities and definite-initialization rules, rather than
hiding reads and writes inside an opaque string.

## Initial non-goals

[Native Objective-C subclasses](docs/objc-subclass-design.md) add an explicitly
foreign-only `extends` / `override` / `super` surface. They do not enable
ordinary Z-to-Z inheritance.

- inheritance among ordinary Z-defined types (foreign superclass metadata is imported);
- production async scheduling, cancellation, I/O reactors, and CPU-parallel execution;
- ORC cycle collection;
- function-like and general expression macros, plus compile-time execution;
- direct LLVM or machine-code generation;
- a package registry;
- complete C++ template support;
- direct implementation of the Swift ABI.

## Self-hosting

The TypeScript/Bun compiler is Stage 0: the trusted bootstrap seed. It has
been frozen since 2026-11-23 and changes only when it blocks the bootstrap or a
test reference. The native compiler is written in Z, and consecutive
generations rebuild it to byte-identical C. New language behavior lands in the
native compiler only. Current coverage and the remaining Stage 0 dependencies
are tracked in [`docs/bootstrap-status.md`](docs/bootstrap-status.md).

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

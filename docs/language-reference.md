# Z language reference

This document summarizes the accepted source-language semantics of Z. It is
about what Z code means, independent of which bootstrap compiler tiers currently
execute every shape. For rationale and unresolved design questions, see
[`DESIGN.md`](../DESIGN.md). For implementation coverage and temporary limits,
see [`bootstrap-status.md`](bootstrap-status.md).

## Declarations and modules

Z source uses explicit exports and TypeScript-shaped imports:

```z
// geometry.zs
export struct Point { x: i32; y: i32; }
export function sum(in point: Point): i32 { return point.x + point.y; }

// main.zs
import geometry from "./geometry.zs";
import { sum as total } from "./geometry.zs";
```

Relative `.zs` imports form a source-module graph. Native headers use the same
surface (`import C from "library.h"`) but bind declarations supplied by the
foreign interface rather than redeclaring their ABI.

The filename contract is `.zs` for Z source and `.zd` for foreign declarations.
Z intentionally leaves `.z` to its established use as a compressed-archive
suffix on Unix systems.

## Comments

Z supports TypeScript/C-style line and block comments:

```z
// Continues to the end of the line.
const answer = 42; /* May span
                      multiple lines. */
```

Block comments do not nest. An unclosed `/*` is a compile error reported at its
opening delimiter. Comments are trivia wherever source tokens are permitted,
including inside template interpolation expressions.

## Bindings and mutation

- `const` creates an immutable lexical binding.
- `let` creates a mutable lexical binding.
- Z has no `var` and no function-scoped declaration hoisting.
- Assignment is a statement, not an expression.
- A `const` value struct is deeply immutable through its fields.
- A `const` class binding fixes the reference, not the shared instance.

Local types are inferred from initializers when unambiguous. Public function
parameters and returns, fields, uninitialized storage, empty collections, and
foreign boundaries remain explicit contracts.

Value structs support object binding patterns with TypeScript-shaped aliases:

```z
const { path, revision } = record;
const { path: localPath } = record;
```

A cleanup-free struct may be destructured directly. Destructuring a named
cleanup-bearing struct requires `copy record` to preserve the source or
`move record` to consume it. Selected fields become independent bindings and
unselected owned fields are destroyed. Private fields are accessible only from
the declaring type. The current tier rejects classes, custom-`deinit` or foreign
RAII storage, and nested, rest, default, array, parameter, and async patterns.

## Type vocabulary

Z uses lowercase names for primitive machine values and PascalCase names for
owned, nominal, or language/library abstractions. `cstring` is the deliberate
exception: it is a primitive borrowed foreign string view rather than a Z-owned
text value.

| Family | Z spelling | Meaning and current rule |
| --- | --- | --- |
| No value | `void` | Function produces no value; not ordinary storable data |
| Boolean | `boolean` | Exactly `true` or `false`; conditions do not use truthiness |
| Signed integers | `i8`, `i16`, `i32`, `i64` | Fixed-width two's-complement values; integer literals prefer `i32` |
| Unsigned integers | `u8`, `u16`, `u32`, `u64` | Fixed-width unsigned values; `u8` is the byte-oriented scalar |
| Pointer-sized integers | `isize`, `usize` | Signed/unsigned target pointer width; sizes and indexes normally use `usize` |
| Floating point | `f32`, `f64` | IEEE-width floating values; floating literals prefer `f64` |
| Owned text | `String` | Immutable owned UTF-8 bytes with explicit byte operations |
| Borrowed C text | `cstring` | Non-owning NUL-terminated native string view; not an owned `String` alias |
| Fixed collection | `T[N]` | Inline fixed-size owned array |
| Growable collection | `Array<T>` | Move-owned growable contiguous buffer |
| Associative collection | `Map<K, V>` | Move-owned key/value storage from `std/collections` |
| Unique collection | `Set<T>` | Move-owned unique-value storage from `std/collections` |
| Borrowed collection | `Slice<T>` | Non-escaping pointer/length view over contiguous storage |
| Optional value | `Option<T>` | Built-in `some`/`none` tagged value, niche-backed where representation permits |
| Typed outcome | `Result<T, E>` | Built-in `success`/`failure` tagged value produced by `attempt` |
| Async handle | `Task<T>` or `Task<T, E>` | Owned structured task handle; the second form carries a typed error channel |
| Weak identity | `Weak<T>` | Non-owning reference to an ARC-managed class, recovered through `upgrade()` |
| Text construction | `TextBuffer` | Move-only mutable UTF-8 builder imported from `std/text` |
| Region owner | `Arena` | Move-only region allocator imported from `std/memory` |
| Hash composition | `Hasher` | Compiler-supplied mutable state passed to `Hashable.hash`, imported from `std/hash` |
| Hash contract | `Hashable` | Nominal equality and hashing trait for readonly collection keys, imported from `std/hash` |
| Iteration contract | `Iterator<T>` | Nominal mutable-cursor trait imported from `std/iteration` |
| Generator sequence | `Generator<T>` | Cold move-only compiler frame imported from `std/iteration`; `.next()` returns `Option<T>` |
| Generator with completion | `Generator<Yield, Return>` | Cold frame whose `.next()` returns `GeneratorStep<Yield, Return>` with `yielded` or `complete` |
| Throwing generator handle | `Generator<Yield, Return, Error>` | Explicit storage spelling for a fallible generator; declarations normally use `Generator<...> throws Error` |
| Async generator | `AsyncGenerator<Yield, Return?, Error?>` | Cold move-only async frame imported from `std/iteration`; `.next()` returns an awaited `Task` |
| Function value | `(in value: T) => U throws E` | Closure/callback signature; parameter capabilities are part of the type |
| Read-only projection | `view T` | Inferred non-storable borrow tied to owner storage, not a general reference type |
| Native types | Imported nominal names and `T | null` | ABI-exact C, Objective-C, C++, or Swift-generated types; nullability is limited to nullable native references/handles |
| User types | `struct`, `class`, `enum`, `trait` names | Nominal PascalCase declarations; structs/enums are values and classes have ARC identity |

There is currently no `char`, arbitrary-width integer, tuple, general structural
object type, `any`, or user-written nullable value union. Use `u8` for a byte,
`String` for owned UTF-8 text, `Option<T>` for optional Z values, and `T | null`
only where a native nullable representation enters the type system.

Integer construction performs an explicit value conversion:

```z
const widened = i32(byte);
const narrowed = u8(count); // traps if count is outside the u8 range
const nativeKind = u32(events.SDL_EVENT_QUIT);
```

Conversions whose complete source range fits the destination lower to a direct
cast. Narrowing conversions perform a runtime range check. A nominal imported
C enum may convert outward through its ABI integer representation; ordinary
assignment remains nominal, and an arbitrary integer cannot be constructed
back into the enum.

## Structs, classes, and traits

`struct` declares a value type. It may contain fields, instance methods, static
methods, and `deinit`. Construction uses the type as a function over an object
value:

```z
const point = Point({ x: 20, y: 22 });
```

`class` declares an ARC-managed reference type with identity. Construction uses
`new`; copying a class reference shares the instance:

```z
const session = new Session({ id: 42 });
const same = session;
```

Field visibility is separate from storage and ownership: struct and class fields
are public unless marked `private`. A user class constructor may establish
invariants and may throw. `trait` is a nominal behavior contract; a struct or
class opts in with `implements`. Traits do not imply inheritance or storage.

Imported Objective-C protocols use the same nominal `implements` list. A
protocol method keeps an ordinary Z-local name and attaches its native selector
after the result:

```zs
class TableController implements AppKit.NSTableViewDataSource {
  function rowCount(
    in tableView: AppKit.NSTableView
  ): isize as "numberOfRowsInTableView:" {
    return 0;
  }
}
```

The selector is declaration evidence, not a stringly typed runtime lookup. The
compiler verifies that it belongs to an implemented protocol and checks its
parameters and result against Clang's SDK declaration. Protocol callbacks are
synchronous and non-throwing in the first tier. The editor offers
unimplemented selectors as complete method scaffolds and identifies required
versus optional requirements.

A field marked `readonly` is initialized during construction and cannot be
assigned or mutated afterward:

```z
class Configuration {
  readonly name: String;
  readonly retries: i32;
}
```

Prefixing an aggregate applies the same rule to all of its stored fields:

```z
readonly struct Coordinate {
  x: i32;
  y: i32;
}

readonly class Configuration {
  name: String;
  retries: i32;
}
```

This is shallow binding immutability. A field cannot be reassigned through the
aggregate, but a referenced value is not recursively frozen merely because its
field is readonly. Deep cross-thread shareability is a separate recursive
compiler proof. Constructors may initialize readonly fields while establishing
the value's initial state.

When every reachable field is similarly immutable and safe to destroy on any
thread, Z infers the class as shareable and uses atomic ARC for its references.
Mutable collections, mutable receiver methods, custom `deinit`, and native
identity without a threading contract prevent that inference.

## Ownership capabilities

Capabilities are written before the binding because they describe how the
callee may use the argument:

| Capability | Callee contract | Caller spelling | Typical use |
| --- | --- | --- | --- |
| value/default | receives ownership or an ordinary copy/share according to the type | `use(value)` | transfer a unique value; share a class |
| `in` | read-only, non-escaping borrow | `inspect(value)` | inspect without transfer |
| `inout` | exclusive, initialized mutable borrow | `mutate(inout value)` | mutate caller-owned storage |
| `out` | exclusive write into possibly uninitialized storage | `fill(out value)` | initialize caller storage |
| `move` | declaration or closure explicitly consumes captured/receiver ownership | `consume(value)`; `move () => ...` for a closure | consuming captures and receivers |

Function declarations and function types include the same capabilities. This
keeps callbacks and ordinary functions substitutable.

An untyped uninitialized binding is accepted only when its first initializing
use is a typed native `out` call:

```z
let database;
try sqlite.sqlite3_open(":memory:", out database);
```

The imported `T **` contract determines the binding's `T *` type. If no such
call initializes the binding, Z asks for an explicit type annotation instead of
leaving an implicit undefined value.

Borrow lifetimes are inferred and lexical. Safe code does not expose general
lifetime parameters. Ordinary borrows cannot be retained or stored. A narrow
`view T` method result may project read-only value-struct storage into an
inferred `const` local:

```z
struct DocumentStore {
  documents: Array<Document>;

  function documentAt(index: usize): view Document {
    return this.documents[index];
  }
}

const document = store.documentAt(0);
console.log(document.title);
store.open(next); // valid after document's last use
```

The first tier is deliberately receiver-tied and zero-overhead: only a
synchronous, non-throwing borrowed method on a value struct may return a direct
field or indexed projection. The view itself cannot be annotated as storage,
duplicated, stored, returned again, or held across `await`. It may be forwarded
to a synchronous `in T` parameter or read through an inline closure passed to a
synchronous `in` function parameter. The latter closure is compiler-proven
nonescaping and copies only the view pointer into its stack environment; owned,
stored, mutable, escaping, and async forwarding remain rejected. Its owner cannot
mutate or move before the view's last use. ARC class owners are excluded because
another alias could invalidate growable projected storage.

When `T` already has ordinary cleanup-free copy semantics, a value context may
load an independent `T` from `view T` implicitly. This is an ordinary by-value
load from the referenced storage—not a heap allocation, retain, or clone. A
scalar is one load; a cleanup-free aggregate has its normal value-copy cost. The
result may outlive the view. Cleanup-bearing and move-only targets remain views;
obtaining an owned copy of those values requires a type-specific operation.
Binding a receiver projection without an owned type annotation still infers
`view T`, so the borrow is not silently erased.

Value-producing `match` and `if` arms are value contexts. A concise arm provides
its expression directly; a block arm uses `select`, while `return` always exits
the enclosing function:

```z
return match (in found) {
  some(count) => count;
  none => 0;
};

const adjusted = match (in found) {
  some(count) => {
    if (count < 0) return -1;
    select count + 1;
  }
  none => 0;
};
```

A cleanup-free view selected by either shape materializes as the arm's owned
value. This contextualization happens before branch types are unified, so a
`view i32` arm and an `i32` arm agree on `i32`.

A lookup that may not find a value returns `Option<view T>` without copying the
payload:

```z
function find(id: i32): Option<view Document> {
  let index: usize = 0;
  while (index < this.documents.length) {
    if (this.documents[index].id == id) {
      return Option.some(this.documents[index]);
    }
    index = index + 1;
  }
  return Option.none;
}

const found = store.find(42);
match (in found) {
  some(document) => console.log(document.title);
  none => console.log("not found");
}
```

The initial optional tier requires a direct `const` binding and
`match (in binding)`. The `some` binding inherits the receiver provenance and
is read-only; the `none` arm carries no borrow. Native lowering uses a single
`const T*`: a projected address for `some` and `NULL` for `none`. The owner may
mutate again after the optional view's last use.

A borrowed callback can expose a scoped view without returning it:

```z
function each(in visit: (in item: Item) => void): void {
  for (const item of this.items) {
    visit(item);
  }
}
```

The immutable `in` capability appears in the function type; its call site does
not repeat `in`. Mutable `inout` and initializing `out` remain explicit at both
declaration and call sites.

## Cleanup and weak references

`deinit` is deterministic, synchronous, infallible, and runs exactly once for
owned value storage or when the final strong class reference ends. Fallible
resource shutdown belongs in an explicit operation such as `close()`.

`weak value` creates a non-owning `Weak<T>` for a class. `upgrade()` either
returns a strong reference or throws `WeakExpired`. Weak references are the
cycle-breaking tool; cycle collection remains a separate runtime concern.

## Functions, errors, and results

A throwing signature names its error domain:

```z
function load(id: i32): User throws UserError { ... }
```

- `return value` completes successfully.
- `throw error` completes with the declared error.
- `try operation()` propagates failure and produces the success value.
- `attempt operation()` materializes `Result<T, E>` for local inspection.

Synchronous and async error values may contain cleanup-bearing fields such as
`String`, ARC identity, or move-only native owners nested in a Z value.
`throw` transfers the error into failure storage; `try` transfers it onward;
and `attempt` materializes a live-state-aware `Result<T, E>`. Consuming or
borrowed `match` follows the same payload rules as other enums. Native-bearing
failure storage uses placement construction, typed moves, and deterministic
destruction rather than plain aggregate assignment.

`Result<T, E>` is a built-in tagged union with `success` and `failure` variants;
those names are variants, not global functions or reserved keywords.

A `.zd` contract may project a conventional native integer status into this
same error model without changing the ABI:

```z
declare module "vendor.h" {
  export function vendor_open(
    out handle: _ | null { deinit vendor_close; }
  ): void throws _ {
    success 0;
  }
}
```

The native return type becomes the inferred error type. A listed status
completes as `void`; any other status is preserved as the failure value.
`try vendor.vendor_open(out handle)` propagates it and `attempt` materializes
`Result<void, NativeStatus>`. This is a tag-only stack value, not an allocated
exception. Owned `out` storage becomes cleanup-active immediately after the
native call and is therefore destroyed even if that call returns failure.

## Enums and matching

Enums may be finite values or carry one typed payload per variant. Construction
uses `Enum.variant(value)`. `match` is exhaustive and uses inverse-constructor
patterns:

```z
const id = match (option) {
  some(user) => user.id;
  none => -1;
};
```

Payload-free Z enums support `==` and `!=` by nominal tag. Payload-bearing
enums require `match`; Z does not implicitly synthesize equality for their
contents.

An expression arm may be concise or use a block with `select value`. `return`
and `throw` always target the enclosing function. `yield` is reserved for
generators rather than overloaded for match blocks.

## Explicit copy and move

Z uses readable prefix keywords when ownership intent should be visible:

```z
const snapshot = copy library.current();
const transferred = move library;
```

`copy value` produces an independent owned value and leaves its source usable.
The compiler currently synthesizes recursive copies for `String`, fixed and
growable arrays, and Z structs/enums whose entire value graph is copyable.
Cleanup-free values use their ordinary value copy. A `.zd` native value must
explicitly declare `copy`; ARC classes and Objective-C identities do not use
this operator because ordinary assignment already shares their identity.

`move value` transfers an existing unique owner and makes the source binding
unavailable. It applies to cleanup-bearing Z values, ARC owners, and native
values whose contract proves move construction. It is rejected for ordinary
scalars—where there is no unique ownership to transfer—and for `view T`, which
never owns the referenced value. To extract an element from a container, use an
owner operation such as `remove`; moving a field or indexed element directly
would leave a hole in its containing owner.

The keywords are contextual: the ownership forms require whitespace
(`copy value`, `move value`), preserving an unambiguous imported call such as
`move(value)` and the existing `move (...) =>` closure capture syntax.

## Control flow and expressions

`if`, `while`, and `match` parenthesize their subject. Z supports ternaries and
value-producing `if` expressions. Statement blocks never return an implicit
last expression; value-producing blocks use `select` explicitly.

Statement `if`/`else` branches may contain one unbraced statement. `else` binds
to the nearest unmatched `if`. Conditions are always `boolean`; nullable pointers
and references require an explicit comparison with `null` rather than
truthiness.

`while` and `for...of` may also produce values. A required `else` block handles
natural exhaustion, including a loop that executes zero times. `select` supplies
the loop expression's value and exits it:

```zs
const firstEven: Option<i32> = for (const value of values) {
  if (value % 2 == 0) {
    select Option.some(value);
  }
} else {
  select Option.none;
};

const state = while (attempts < 3) {
  attempts = attempts + 1;
  if (ready()) {
    select "ready";
  }
} else {
  select "exhausted";
};
```

All reachable `select` values and the exhaustion value must have one compatible
type. `continue` begins the next iteration. A plain `break` is invalid in a
value-producing loop because it would leave the expression without a value;
`return` and `throw` still exit the enclosing function. This first executable
tier is synchronous.

Integer arithmetic is checked. Intentional overflow uses explicit wrapping or
saturating operations.

Non-literal integer widths never convert implicitly. Calling the target integer
type constructs a value with the same mathematical value:

```z
const byte: u8 = 42;
const widened = i32(byte);
const nativeCount = isize(values.length);
const narrowed = u8(widened);
```

When the source type's complete range fits the target, this lowers to a direct
native cast. Otherwise Z emits a range check and traps if the runtime value is
not representable. Integer literals remain contextually typed and receive a
compile-time diagnostic when they do not fit. Boolean conversion, implicit
widening, intentional truncation, and integer/floating-point conversion are not
part of this first tier; floating-point conversion remains deferred until its
rounding, precision-loss, infinity, and NaN policy is explicit.

## Collections and views

- `T[N]` is a fixed-size owned array.
- `Array<T>` is an intrinsic growable owned buffer and requires no import.
- `Map<K, V>` is owned associative storage imported from `std/collections`.
- `Set<T>` is owned unique-value storage imported from `std/collections`.
- `Slice<T>` is a non-owning contiguous view.
- `view T` is a non-storable read-only projection returned from value-struct
  storage and tied to the receiver's inferred lifetime.

Indexing is bounds-checked in safe code. Owned elements are destroyed in reverse
initialization order. Mutation that may reallocate requires exclusive mutable
storage. A slice borrow cannot outlive its backing storage or cross a mutation
that invalidates it.

`Array<T>` supports move-only native C++ values. `push(value)` transfers the
element into the buffer. Growth allocates native storage, move-constructs each
live element into the new allocation, destroys the old elements, and releases
the old allocation. An indexed element is borrowed rather than extractable;
moving the whole array transfers its buffer without relocating its elements.

The first `Map` API makes ownership visible without exposing its storage:

```z
import { Map } from "std/collections";

let users = Map<String, User>();
users.set("ada", User({ id: 1 }));

const found = users.get("ada");
const id = match (in found) {
  some(user) => user.id;
  none => 0;
};
```

`set` transfers unique cleanup-bearing keys and value types into the map.
Replacing an entry destroys its previous value. For value types, `get` returns
`Option<view V>`, so lookup does not copy or transfer the stored value;
structural mutation is rejected until that view's last use. `remove` returns
owned `Option<V>`. `delete`
destroys the matching key and value and reports whether they existed, while
`clear` destroys every entry. `has` and `.length` do not mutate storage.

Z classes and Objective-C objects instead preserve their shared reference
identity. `set` retains the identity while the caller remains free to use its
own reference, and `get` returns `Option<V>` with an independently retained
reference. `remove` transfers the map's retained reference into `Option<V>`.

Move-only native C++ values use the value contract again: `set` transfers the
owner, `get` returns `Option<view V>`, `remove` move-constructs an owned
`Option<V>`, and replacement, deletion, clearing, growth, and final map cleanup
run the required native moves and destructors. Native keys and copy-only native
values are not supported in the current map tier.

If `V` is cleanup-free and ordinarily copyable, using the matched payload where
an owned `V` is required performs the same implicit by-value load described
above. A cleanup-bearing `view V` never becomes owned implicitly.

Use `copy viewValue` when a cleanup-bearing but recursively copyable value must
become an independent owner. This is an explicit allocation/copy boundary; the
view and its original owner are not consumed.

`Set` uses the same explicit ownership vocabulary:

```z
import { Set } from "std/collections";

let visited = Set<String>();
const inserted = visited.add("settings");
const present = visited.has("settings");
const removed = visited.remove("settings");
const deleted = visited.delete("obsolete");
visited.clear();
```

`add` transfers the value and reports whether it was inserted. If an equal
value is already stored, the existing value remains and the incoming owned
value is destroyed. `remove` borrows its lookup argument and transfers the
stored value through `Option<T>`; ignoring that result destroys it normally.
`delete` destroys the stored value directly and returns whether it existed.
`clear` destroys every stored value, while `has` and `.length` are read-only.

Both collections support direct read-only iteration:

```z
for (const { key, value } of users) {
  console.log(`${key}: ${value.name}`);
}

for (const path of visited) {
  console.log(path);
}
```

A whole Map binding has the displayed type `Map.Entry<K, V>` and exposes
borrowed `.key` and `.value` fields. The same fields may be selected directly by
an object binding pattern. Cleanup-free fields load by value; cleanup-bearing
fields stay borrowed from the entry. A Set binding borrows its stored `T`.
Neither whole elements nor borrowed fields can be moved out, and structural
collection mutation is rejected until the loop ends; use `copy` explicitly when
an independently owned copy is supported. Iteration order is unspecified.

User-defined synchronous iterators implement `Iterator<T>`:

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
  console.log(value);
}

for (const value of Countdown({ current: 2 })) {
  console.log(value);
}
```

The explicit `inout` is required for a stored iterator because `next` mutates
its traversal state. A stored value iterator must therefore use `let`; a class
iterator may keep a `const` identity while lending its mutable receiver.
Temporary iterators already have unique compiler-owned storage, so their loop
syntax omits `inout`. Each `some` payload becomes an owned immutable loop
binding and receives normal end-of-iteration cleanup. The stored iterator
survives the loop.

Built-in arrays, slices, maps, and sets keep the borrowed collection semantics
described above and reject `of inout`. Consuming iteration, mutable element
access, cleanup-bearing object-pattern extraction, move-only foreign iterator
elements, and async iteration are not in this tier.

Synchronous generators provide compiler-managed iterator state:

```zs
import { Generator } from "std/iteration";

function noteIdentifiers(count: i32): Generator<i32> {
  let identifier = 1;
  while (identifier <= count) {
    yield identifier;
    identifier = identifier + 1;
  }
}

const identifiers = noteIdentifiers(3);
for (const identifier of identifiers) {
  console.log(identifier);
}
```

The function call returns a cold, move-only `Generator<i32>`; its body starts
when `.next()` or `for...of` first advances it. `.next()` returns `Option<T>`,
and `Generator<T>` satisfies `Iterator<T>` when passed to generic iterator
algorithms.
Stored generators deliberately hide cursor mutation, so a `const` handle uses
plain `of identifiers` rather than the `inout` required by a user-defined value
iterator. Exhaustion, `return;`, and early handle destruction clean every live
suspended local exactly once.

`yield` is what selects suspended-frame lowering. A function returning
`Generator<T>` without `yield` remains an ordinary function and may return or
forward an existing generator value.

Generators may explicitly carry a terminal value with a second type argument:

```zs
struct ScanSummary {
  values: i32;
  total: i32;
}

function scanValues(count: i32): Generator<i32, ScanSummary> {
  let current = 1;
  let total = 0;
  while (current <= count) {
    total = total + current;
    yield current;
    current = current + 1;
  }
  return ScanSummary({ values: count, total });
}

const scanner = scanValues(3);
match (scanner.next()) {
  yielded(value) => consume(value);
  complete(summary) => consumeSummary(summary);
}
```

Here `.next()` returns the compiler-provided
`GeneratorStep<i32, ScanSummary>` enum. `yielded(value)` carries one stream
element and `complete(summary)` carries the terminal return exactly once.
Every reachable path in a two-argument generator must `return` its declared
terminal type. Calling `.next()` again after consuming `complete` is a runtime
contract violation.

`Generator<Yield, Return>` deliberately does not satisfy `Iterator<Yield>` and
cannot be used directly with `for...of`: ordinary iteration would silently
discard `Return`. Advance it explicitly and match both outcomes. The
one-argument `Generator<T>` remains the ergonomic sequence form and continues
to satisfy `Iterator<T>`.

Generator errors occur during advancement, not cold construction:

```zs
struct ReadError {
  code: i32;
}

function readValues(): Generator<i32> throws ReadError {
  yield 20;
  throw ReadError({ code: 7 });
}

const values = readValues();                 // does not execute or throw
const next = attempt values.next();          // Result<Option<i32>, ReadError>
```

Use `try values.next()` inside a function throwing the same error to propagate,
or `attempt values.next()` to retain the `Result`. A fallible handle is written
explicitly as `Generator<Yield, Return, Error>` when it crosses another type
boundary; `void` occupies the terminal slot when there is no terminal value:

```zs
function consume(
  values: Generator<i32, void, ReadError>
): i32 throws ReadError {
  return match (try values.next()) {
    some(value) => value;
    none => 0;
  };
}
```

Direct `for...of` over a throwing generator is rejected until an explicit
propagation form is designed. This keeps generator errors consistent with Z's
rule that throwing work always appears beneath `try` or `attempt`.

The synchronous lowering supports ordinary statements, `if`, `while`, multiple
`yield` points, owned parameters, and owned yielded values. A `for...of` over
`Array`, fixed arrays, `Slice`, `Map`, or `Set` may suspend: its cursor and
borrowed element projection are stored in the generator frame. Statement
`match` may also suspend; payload bindings remain live in the frame and retain
their normal exact-once cleanup semantics. Suspending custom-iterator loops,
value-producing match expressions, generator methods, borrowed parameters or
yielded views, and bidirectional sent values are deferred.

Async generators use the same yield/terminal-result protocol while explicitly
authorizing suspension with `async`:

```zs
import { AsyncGenerator } from "std/iteration";
import { delay } from "std/time";

async function values(): AsyncGenerator<i32, i32> {
  yield 20;
  await delay(1);
  yield 22;
  return 42;
}

async function consume(): i32 {
  const values = values();             // cold: no body execution yet
  const first = await values.next();   // Task<GeneratorStep<i32, i32>>
  const second = await values.next();
  const terminal = await values.next();
  return 0;
}
```

`async` determines which operations are legal in the body; the declared return
shape determines the calling protocol. An ordinary `async function ...: T`
produces a one-shot `Task<T>`. An `async function ...:
AsyncGenerator<Yield, Return>` produces a reusable cold stream handle instead.
Each `.next()` creates one awaited advancement task and resumes the same
persistent frame until the next `yield`, terminal `return`, or `throw`.

Fallible async generators keep cold construction non-throwing and attach the
error to advancement:

```zs
async function rows():
  AsyncGenerator<Row, void, DatabaseError> throws DatabaseError {
  yield row;
  throw error;
}

const rows = rows();
const observed = attempt await rows.next();
```

One-argument, nonthrowing async generators have a natural sequential loop:

```zs
for await (const event of events()) {
  await record(event);
  if (event.complete) break;
}
```

The loop awaits one `.next()` advancement at a time. `continue`, `break`,
`return`, and suspension in the body preserve exact-once yielded-value cleanup.
A temporary stream such as `events()` is owned and destroyed by the loop. A
stored handle remains usable after an early `break`. Async generators with a
terminal return remain explicit `.next()` consumers so the terminal value
cannot be discarded.

A throwing async sequence makes propagation visible on the complete loop:

```zs
async function loadRows(): i32 throws DatabaseError {
  let count = 0;
  try for await (const row of rows()) {
    count = count + 1;
  }
  return count;
}
```

`try for await` accepts `AsyncGenerator<Y, void, E>` and requires the enclosing
async function to declare the same `throws E`. It is the loop equivalent of
`try await stream.next()`: an advancement error ends the loop, cleans the
active yielded value and stream frame exactly once, and propagates `E`.
Nonthrowing streams reject the unnecessary `try`. Local recovery remains
explicit `attempt await stream.next()` so its control flow and partial progress
are visible.

Async iteration also supports object patterns for yielded value structs:

```zs
for await (const { topic: selectedTopic, value } of events()) {
  await record(selectedTopic, value);
}
```

The yielded aggregate is consumed by the loop. Selected owned fields move into
their pattern bindings; unselected fields remain in hidden iteration storage.
Both sets are cleaned exactly once on normal advance, `continue`, `break`,
`return`, propagation, or cancellation. Moving a selected binding again inside
the body transfers that field normally. A yielded struct with custom `deinit`,
native RAII value storage, or opaque foreign cleanup must instead be bound and
moved as a complete value because partial destruction would violate its
contract.

The executable tier supports persistent `if` and `while`, `break` and
`continue`, built-in `Array`/fixed-array/`Slice`/`Map`/`Set` `for...of`
cursors, borrowed `match (in value)` statement payloads, and consuming owned
enum matches across both `yield` and ordinary awaits such as `delay`.
Only the selected arm runs. A value-producing arm may suspend before its final
expression or explicit `select`; `return` and `throw` still exit the enclosing
async function directly:

```zs
return match (lookup) {
  found(job) => {
    const score = await calculate(job.id);
    select job.id + score;
  }
  missing(code) => throw LookupError({ code });
};
```

The enum subject is moved into hidden frame storage exactly once. A whole
payload binding becomes the selected arm's owner; object-pattern fields remain
borrowed from the hidden payload. Live-state cleanup covers normal selection,
`break`, `continue`, return, error propagation, and cancellation. The selected
result may itself own ARC identity, a `String`, a Z value with `deinit`, or
move-only native storage. A directly awaited owned value transfers from its
hidden suspension slot without copying. Async generator methods, async patterns
beyond value-struct object fields, and borrowed parameters/yields remain
explicit follow-up layers.

`Map` and `Set` use open-addressed hashed buckets for amortized O(1) lookup and
membership. Owned entries remain in compact storage, while rehashing moves only
bucket indices; it does not copy or duplicate user-owned values. Built-in
keys/elements include integers, `boolean`, `String`, and payload-free Z or
native enums. Floating-point keys remain excluded because `NaN` does not supply
the required equivalence relation.

Readonly value structs can opt into nominal custom hashing:

```z
import { Map } from "std/collections";
import { Hashable, Hasher } from "std/hash";

readonly struct ProjectKey implements Hashable {
  workspace: String;
  path: String;

  function equals(in other: ProjectKey): boolean {
    return this.workspace == other.workspace && this.path == other.path;
  }

  function hash(inout hasher: Hasher): void {
    hasher.add(this.workspace);
    hasher.add(this.path);
  }
}

let projects = Map<ProjectKey, i32>();
```

The standard `Hashable` requirement conceptually uses
`equals(in other: this)` and `hash(inout hasher: Hasher)`. Equal values must
feed identical components in identical order. `Hasher` owns mixing and final
hash production; implementations feed supported scalars, Strings, enums, or
nested `Hashable` values through `add`. Requiring readonly value keys prevents
mutation from making an inserted bucket unreachable.

`Map` supports ordinary Z values, shared Z-class and Objective-C identity, and
move-only native C++ values. Function/weak values, native keys, and copy-only
native C++ values still wait for their distinct storage rules. A Z value struct
may provide an explicit owned wrapper where that is already safe.

## Arena regions

`std/memory` provides the first explicit region allocator without a new keyword
or source-level lifetime parameter:

```z
import { Arena } from "std/memory";

let scratch = Arena({ initialCapacity: 65536 });
const header = scratch.create(Document({ id: 20 }));
const body = scratch.create(Document({ id: 22 }));
const answer = inspect(header) + inspect(body);
scratch.reset();
```

`Arena` is a move-only value owner and therefore uses `let`: both `create` and
`reset` mutate its descriptor. `create(value)` follows ordinary ownership
rules—copyable values may copy while cleanup-bearing and move-only values
transfer—and returns an inferred read-only `view T`. Addresses remain stable,
so later `create` calls are permitted while earlier views are live. A view can
be read directly or passed to a synchronous `in T` parameter.

`reset()` destroys tracked values in reverse creation order, releases all arena
pages, and leaves the arena reusable. Scope exit performs the same cleanup.
Cleanup-free values carry no per-value destructor record; Z `deinit`, ARC
fields, owned native handles, and C++ RAII fields are tracked when present.
Reset, move, and scope destruction are rejected while a view has a later use.
The options object is optional. `initialCapacity` reserves the first page size
and remains a performance hint: the arena is still growable and uses the same
safety and cleanup rules after it adds more pages.

The first region tier is synchronous and single-threaded. Arena views cannot be
stored, returned, captured by stored or escaping closures, passed as owned or
mutable values, or held across `await`. A synchronous inline closure accepted
through an `in` function parameter may read the view and ends its loan when the
call returns. Direct class/reference-identity roots are excluded, although an
arena-owned value struct may contain ARC fields. Allocation failure currently
traps. Derived projections, mutable views, stored provenance, async regions,
thread transfer, page reuse, and allocator parameters remain later tiers.

## Generics and traits

Generics use TypeScript-shaped angle brackets and are monomorphized for native
values. Call sites infer type arguments from ordinary arguments where possible.
Multiple nominal constraints use intersections:

```z
function describe<T: Measured & Named>(in value: T): String { ... }
```

Traits may also be generic. `trait Source<T>` describes a family of nominal
contracts, and `implements Source<i32>` is checked against that concrete
specialization. A constraint may name the same specialization:

```z
trait Source<T> {
  function next(inout this): Option<T>;
}

function inspect<T: Source<i32>>(inout source: T): i32 {
  return match (source.next()) {
    some(value) => value;
    none => 0;
  };
}
```

Generic traits remain statically dispatched; Z does not yet provide
trait-typed storage or existential/dynamic dispatch.

Transparent aliases name an existing type without changing representation,
ownership, ABI, or assignability:

```zs
export type Operation = (left: i32, right: i32) => i32;
type Values = Array<i32>;

function apply(operation: Operation, left: i32, right: i32): i32 {
  return operation(left, right);
}
```

Aliases may be exported and imported selectively or through a namespace.
Construction and static lookup through an aggregate alias resolve directly to
the underlying aggregate. Alias chains are supported, while recursive cycles
are compile-time errors. Generic alias declarations such as `type Lookup<T> =
Map<String, T>` remain deferred. An alias is not an opaque type or newtype and
therefore adds no conversion or runtime boundary.

Methods may introduce type parameters independently of their owner. Arguments
are inferred at the call site or supplied explicitly:

```z
struct Slot {
  occupied: boolean;

  function choose<T>(primary: T, fallback: T): T {
    if (this.occupied) return primary;
    return fallback;
  }
}

struct Utility {
  static function preserve<T>(value: T): T { return value; }
}

const inferred = slot.choose(20, 22);
const explicit = Utility.preserve<i32>(42);
```

When arguments do not mention every type parameter, a direct call may use its
result contract as inference evidence. Local annotations, assignment targets,
and enclosing function returns provide that context:

```z
function absent<T>(): Option<T> { return Option<T>.none; }

const local: Option<i64> = absent();

function load(): Option<i32> {
  return absent();
}
```

An unannotated `const local = absent();` remains ambiguous and requires either a
destination type or explicit type arguments. Context narrows inference; it does
not create a default generic argument.

An instance of a generic owner may also call a separately generic instance
method. A static method whose owner and method both introduce independent type
parameters is deliberately deferred until that two-level specialization syntax
is designed.

`|` is reserved for union-like type composition; it is not the spelling for
requiring multiple trait conformances.

## Closures and function values

Arrow closures follow TypeScript-shaped parameter and return syntax. Captures
borrow by default. `move` creates an owned capture when a closure must escape:

```z
const deferred: () => i32 = move () => resource.value;
```

A read-only `view` may be captured only where the destination proves that the
closure cannot escape:

```z
const item = store.at(0);
const observed = inspect(() => item.value); // inspect takes `in operation`
store.append(next);                         // valid after inspect returns
```

Owned closure environments use ARC. Noncapturing closures can lower directly to
native function pointers where the foreign ABI permits it. `weak` captures may
break class/closure cycles.

Function types carry their error effect:

```z
struct DecodeError {
  code: i32;
}

type Decoder = (bytes: Slice<u8>) => Message throws DecodeError;

function decode(in operation: Decoder, bytes: Slice<u8>): Message throws DecodeError {
  return try operation(bytes);
}
```

A named throwing function or a closure with the same signature can initialize
`Decoder`. When a destination function type supplies `throws DecodeError`, the
closure body is checked in that error context, so it may use `throw` without
repeating the effect on the literal. An unconstrained closure can spell the
effect explicitly as `(bytes: Slice<u8>): Message throws DecodeError => { ... }`.
Calling either form still requires `try` or `attempt`; function values do not
erase error handling. The error type is part of the function type and ABI.

Nested closures forward free captures automatically:

```z
const save = move (): void => {
  const control = scope.schedule(thread.main, async move (): void => {
    const worker = thread.spawn(async move (): void => {
      await on thread.main {
        presenter.saved();
      }
    });
    await worker;
  });
  if (!control.accepted) presenter.closing();
};
```

`presenter` is captured through every intervening closure without relay
bindings. Each boundary still applies its own rules: borrowed closures cannot
escape, escaping closures require `move`, native-thread captures must be
transferable, and executor-isolated identity remains opaque outside its
executor placement. Parameters and locals in an intervening closure shadow
outer names normally.

## Strings and console

`"text"` and `'text'` are ordinary string literals. Backticks are template
strings and use `${expression}` interpolation. `String` is an owned UTF-8 value;
`cstring` is a borrowed native C string view. The standard console is explicit:

```z
import console from "std/console";
console.log(`answer=${answer}`);
```

String storage operations name their unit explicitly:

```z
const source = "export function main() {}";
const bytes: usize = source.byteLength;
const first: u8 = source.byteAt(0);
const keyword = source.copyBytes(0, 6);
if (source.isEmpty) console.log("empty source");
```

`byteAt(index)` checks its index. `copyBytes(start, end)` uses a half-open range,
creates an independently owned `String`, and checks both bounds and UTF-8
boundaries. Binary-facing code and internal text slicing should use these
explicit byte operations. `String.length` is reserved for a Unicode
grapheme-counting text API; it is not implemented by treating UTF-8 bytes or
JavaScript UTF-16 code units as characters. `byteLength` is constant-time; the
eventual grapheme-aware `length` may require a text scan.

Public source locations deliberately use one-based lines and columns plus
zero-based UTF-16 code-unit offsets. UTF-16 is a protocol coordinate—not Z's
text representation or character model—and matches LSP/VS Code plus the
bootstrap compiler. Native frontend code keeps a separate UTF-8 byte cursor for
`copyBytes`; it must not use public source offsets to slice a `String`.

`String == String` and `String != String` compare exact UTF-8 byte sequences.
Equality performs no locale folding, Unicode normalization, or JavaScript-style
coercion. Comparing text from different normalization domains therefore remains
an explicit text-processing operation.

Repeated text construction uses the explicit `std/text` value type rather than
repeatedly allocating intermediate `String` values:

```z
import { TextBuffer } from "std/text";

let output = TextBuffer();
output.append("answer=");
output.appendBytes(source, start, end);
output.appendAscii(10);
const text = output.finish();
```

`TextBuffer` is move-only mutable construction storage. It must be bound with
`let` before appending, cannot be logged as if it were completed text, and
`finish()` consumes it into an immutable owned `String`. `appendBytes` uses a
checked half-open byte range and requires both offsets to be UTF-8 boundaries;
`appendAscii` accepts only the ASCII range. The explicit import keeps this
specialized construction API out of the language prelude.

## Files, processes, and program arguments

System facilities are explicit standard-module imports. File operations and
child launch use ordinary Z typed errors; `try` propagates them and `attempt`
materializes their `Result` for local handling:

```z
import fs from "std/fs";
import process from "std/process";

function stage(in path: String): i32 throws String {
  const source = try fs.readText(path);
  try fs.writeText(".z-cache/input.zs", source);
  const clangArguments = ["--version"];
  return try process.run("clang", clangArguments);
}
```

`fs.readText(path)` returns an owned `String`; `fs.writeText(path, contents)`
borrows both strings for the call; and `fs.exists(path)` performs a non-throwing
existence probe. `readText` reports invalid UTF-8 as a typed `String` failure.
`process.args()` returns an owned `Array<String>` containing
the arguments after the executable name. `process.run(program, arguments)`
borrows a stored fixed array or `Array<String>` as a non-escaping
`Slice<String>`, launches the executable directly without a shell, inherits the
parent standard streams, and returns its exit code. Failure to launch or wait is
a typed failure; a child program's nonzero exit is a successful `i32` result.

`z run file.zs -- one two` forwards `one` and `two` to the native program.
Stage 0 currently lowers these APIs to a small cross-platform C runtime. The
portable standard-library layers are intended to become ordinary Z modules;
OS/ABI calls remain a thin platform substrate.

## Async and structured concurrency

`async function` returns a task conceptually, while `await` observes its
completion. `task` starts child work immediately. Every child task belongs
to a lexical task scope; an async function body is an implicit root scope and an
`async scope` creates a narrower join boundary.

```z
async function refresh(): void throws NetworkError {
  async scope {
    task refreshUser();
    task refreshPosts();
  }
  publishRefreshedUI();
}
```

Leaving a scope joins its children. Failure propagation cancels live siblings
before the failing task completes. Domain errors remain `T throws E`;
cancellation is a structural task outcome, not an invented member of `E`.

Code performing long synchronous chunks inside an async task can cooperate
with its current executor explicitly:

```z
import { scheduler } from "std/async";

async function index(in records: Array<Record>): void {
  for (const record of records) {
    indexRecord(record);
    await scheduler.yield();
  }
}
```

This requeues the current task and creates a cancellation-observation point. It
does not create a timer, switch executors, or produce a generator value.

A scope can optionally expose its compiler-owned handle:

```z
import { TaskControl, TaskScope } from "std/async";
import { thread } from "std/thread";

async scope updates {
  registerNativeCallback(move (value) => {
    const control: TaskControl = updates.schedule(
      thread.main,
      async move (): void => {
        const worker = thread.spawn(async move () => calculate(value));
        publish(attempt await worker);
      }
    );
    if (!control.accepted) reportClosing();
  });
} // rejects new submissions and joins every accepted operation
```

The unnamed form retains its allocation-free static lowering when all children
are lexically visible. `async scope updates {}` binds `updates: TaskScope` for
dynamic submission by callbacks. `TaskScope.schedule` returns a `TaskControl`;
its `accepted` property is `false` if close has won the submission race. The
explicit form is `new TaskScope()`, followed by
direct `await scope.close()` or `await scope.cancel()` when an earlier boundary
is useful. Its owning async function otherwise closes it on return and cancels
it on throw. `TaskScope` owns lifetime; `thread.main` selects placement.
`schedule` accepts nonthrowing synchronous `(): void` or explicitly async
`async (): void` operations. An async operation can suspend and start
structured children. It handles fallible work locally with `attempt await`;
there is intentionally no unobserved error channel back to the synchronous
submitter.

### Task, TaskScope, and TaskControl

These types deliberately expose different kinds of authority:

| Surface | Created by | Owns completion/join? | Carries a value or typed error? | Cancellation |
|---|---|---:|---:|---|
| Direct `await operation()` | Async call | Current task waits directly | Yes | Parent cancellation propagates structurally |
| `Task<T, E>` | `task operation()` or `thread.spawn(...)` | Yes, for one child; `await` consumes the join handle | Yes | `await task.cancel()` requests cancellation and joins |
| `TaskScope` | `async scope name {}` or `new TaskScope()` | Yes, for every accepted dynamic operation | No per-operation result | `await scope.cancel()` cancels and joins the entire scope |
| `TaskControl` | `scope.schedule(...)` | No; the scope remains the sole join owner | No | `requestCancel()` requests cancellation of only that operation |

`TaskControl` is a shared, cleanup-bearing identity rather than a second task
handle. It may be stored in an `Option<TaskControl>` or ARC-managed controller
for UI cancellation:

```z
const save = updates.schedule(thread.main, async move (): void => {
  const result = attempt await persist(note);
  publish(result);
});

if (!save.accepted) {
  showClosing();
  return;
}

// A later callback may request cancellation without taking join ownership.
if (save.requestCancel()) showCancelling();
```

`requestCancel()` returns `true` only for the first accepted request while the
operation is still live. It returns `false` when scheduling was rejected, the
request was already made, or the operation has completed.
`isCancellationRequested` reports whether this control issued a request; it is
not a completion flag. Dropping a `TaskControl` does not detach or cancel work.
The owning `TaskScope` still rejects, cancels, and joins safely at its boundary.

CPU work that must leave the inherited executor uses the explicitly imported
native-thread launcher:

```z
import { thread } from "std/thread";

const calculation = thread.spawn(move () => calculate(input));
doOtherWork();
const answer = await calculation;

const fallible = thread.spawn(move (): i32 throws CalculationError => {
  const value = try calculateOrThrow(input);
  return value;
});
const result = attempt await fallible;

const threadAffine = thread.spawn(async move (): i32 throws CalculationError => {
  const value = try await on thread.main: i32 throws CalculationError {
    select try await calculateForMain(input);
  };
  return value;
});
const published = try await threadAffine;
```

This is distinct from keyword `task`: `task operation()` schedules an async
child on the current executor, while `thread.spawn(operation)` starts exactly
one OS thread. A synchronous closure runs once; an explicitly `async` closure
owns a private executor bound to that worker, may suspend, and resumes on the
same worker after `await on thread.main`. Child `task` operations inherit the
worker executor. The transfer classifier copies recursively cleanup-free
values, moves unique owners, and retains deeply readonly ARC class identity
atomically. A main-isolated Z class may instead cross opaquely: the worker can
use it only in a nested main placement, and its transferred retain is released
on main. A capturing closure must spell `move`. Copy and shareable ARC captures
remain valid in the parent; moved unique owners do not. `Array`, owned `String`,
mutable `TextBuffer`, and supported aggregates containing them use the
consuming path and may return ownership through `await`. Other mutable classes,
borrows, views, raw native references, `Arena`, custom `deinit`, and
cross-thread `Weak<T>` remain rejected. Results follow the same rules.

The thread namespace also supplies typed placement targets. The first target is
`thread.main`:

```z
const direct = await on thread.main refreshUI(model);
const directChild = task on thread.main loadUI(model);
const updated = await on thread.main using (in model) {
  select refreshUI(model);
};
const child = task on thread.main using (move work) {
  consume(move work);
};
```

`await on` hops and waits, while `task on` creates a hot structured child on
main. A direct call uses its declared parameter capabilities; block placement
is for anonymous multi-statement work and uses lexical captures. A contextual
`using (in value, inout state, move owner)` clause makes ownership-bearing
captures explicit without repeating their types. Cleanup-free recursively Copy
values and owned String snapshots may be omitted and become private copies.
`in` is read-only access until join, `inout` is an exclusive mutable loan until
join, and `move` consumes the source binding. A borrowed `task on` capture
requires an enclosing `async scope`; direct `await on` already joins it. `out`
capture is reserved for a later definite-initialization tier. Value-storage
`inout` requires `let`; a `const` ARC class reference may use `inout` to invoke
mutable instance behavior because binding immutability and object mutation are
separate. Async direct
calls schedule the callee frame itself, so their result is `T`/`Result<T, E>`
when awaited or `Task<T, E>` when forked—never a nested task. Code already
proven to run on main accesses isolated state directly; there is no bare
`on thread.main { ... }` proof block. A native worker can
create a placed main child without blocking main; Darwin wakes the executor
through a CFRunLoop source. A placement used as a statement is a block statement
and does not require a trailing semicolon; bindings and other value expressions
still do. Other ownership shapes and platform UI-loop adapters remain bounded
work. See
[`executor-placement.md`](executor-placement.md).
The returned task remains scope-bound and is joined explicitly by `await` or
implicitly at scope exit.

Awaited operations can suspend inside an awaited placement:

```z
const updated = await on thread.main {
  select await refreshUI();
};
```

The outer `await` joins the executor placement. The inner `await` is the
operation performed on that executor. Its continuation retains main-executor
proof; after the placement completes, a native-worker caller resumes on its
original private executor.

Executor-isolated declarations place the contract after the declaration
signature and before the body:

```z
class NotesController on thread.main { /* ... */ }
struct WindowState on thread.main { /* ... */ }
function updateWindow(): void on thread.main { /* ... */ }
```

For a long public return contract, prefer a semantic type alias so the executor
requirement remains easy to scan:

```z
type LoadNotesResult = Result<Map<String, Array<Note>>, StorageError>;

function loadNotes(): LoadNotesResult on thread.main { /* ... */ }
```

An isolated aggregate establishes main proof inside all of its methods and
lifecycle bodies. A struct or class that stores an isolated aggregate inherits
that affinity transitively; hover shows the originating type and field path.
Calls, construction, member access, and cleanup must remain on main. The
current async tier requires an explicit `await on thread.main` hop rather than
automatically scheduling an isolated async function.

Native declarations use the same contract. Explicit Clang
`swift_attr("@UIActor")` and `swift_attr("@MainActor")` facts automatically map
to `thread.main`. Swift-generated Objective-C headers omit the source
`@MainActor` attribute, so a Swift target declared in `z.json` also emits a
compiler-consumed symbol graph; its actor-isolated Objective-C types and methods
enter the same FIIR fact automatically. A reviewed `.zd` fallback handles
external, legacy, or incompletely annotated surfaces:

```z
declare module "LegacyUI.h" {
  export type LegacyWindow on thread.main;
  export function LegacyWindow.refresh(): _ on thread.main;
}
```

Native affinity appears in class, binding, property, method, and function hover.
A Z aggregate that stores an isolated native identity inherits the same
affinity. The ABI call remains direct; the contract adds compile-time placement
and transfer checks rather than a runtime wrapper.

Throwing worker closures return `Task<T, E>`; `try await` propagates `E` and
`attempt await` produces `Result<T, E>`. Error slots have the same explicit
liveness as result slots, so transferable String/Array ownership, containing
aggregates, readonly ARC identity, and contracted native owners are moved or
shared according to the ordinary thread classifier and destroyed exactly once.
Synchronous worker bodies may use `const value = try operation();`, direct
`return try operation();`, or `attempt operation()` followed by `match`.

## Native interop

Native declarations come from toolchain-owned headers and module interfaces.
Z's foreign semantic model adds facts absent from those declarations: ownership,
nullability, lifetime, callback retention, threading, and async behavior.
Those facts normalize through the
[`Foreign Interface IR`](foreign-interface-ir.md) before semantic checking.

### Unsafe native calls

`unsafe { ... }` keeps Z syntax and types while accepting a local,
unverified native proof:

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

let event;
native.poll(out event);
const eventType = unsafe {
  select event.type;
};
```

An explicit `cstring` context may reinterpret a native character-pointer
result. Other unsupported pointers become opaque scope-local identities. They
may be compared with `null` and passed only to native parameters with the exact
same pointer spelling. They cannot be dereferenced, indexed, inspected,
returned, stored outside the block, captured by a closure, or used directly in async
functions. The first tier does not add raw-pointer syntax or infer ownership,
mutation, initialization, cleanup, or threading facts.

Imported C unions are a separate narrow case. A checked `.zd` `out Union*`
contract may initialize ABI-preserving union storage without `unsafe`, but
Clang's layout does not prove which member the native API activated. After
validating the API's discriminator, an unsafe block may read and select a
supported scalar or enum member. Pointer and nested-record members remain
unavailable in this tier, and imported unions cannot be constructed as Z
struct literals.

An unsafe expression must finish with `select value;`. `select` supplies the
local expression result; `return` continues to exit the enclosing function.
Representable scalars and independently owned Z copies may be selected.
Opaque native identities and locally asserted borrowed `cstring` values may
not. Copy borrowed text with `String.from(value)` before selecting it.

Prefer an adjacent `.zd` contract whenever the fact is reusable or should make
the call safe. Use raw native source when the operation cannot be represented
through Z types at all.

### Raw native source

Use raw source only when header import plus `.zd` cannot represent the native
operation. A standalone raw expression must declare every Z operand and its
result:

```z
const value = raw c
  using (in input, inout state, out output)
  : i32 {
    *state += *input;
    *output = *state;
    return *output;
  };
```

`in` permits reads, `inout` permits reads and replacement, and `out` must
initialize a mutable binding without relying on its prior value. The compiler
lowers the expression to an isolated helper function, so native `return` cannot
return from the enclosing Z function or bypass its cleanup. Nothing outside
`using` is visible to the native body.

When the whole function is native, its ordinary signature is the boundary:

```z
function add(left: i32, right: i32): i32 = raw c {
  return left + right;
}
```

The supported language tags are `c`, `cpp`, and `objc`. A raw function may
retain an `on thread.main` declaration. The first tier rejects `async`,
`throws`, generics, raw methods, `move` operands, and Z-owned representations.
Boundary types are currently ABI-stable scalars, `cstring`, and imported native
types. Native compile errors point to the original `.zs` body.

A project may explicitly configure `target.platform` and
`target.minimumVersion` together in `z.json`. The target is compile-time project
configuration, not a nullable runtime global. Native declarations introduced
after that minimum version or obsoleted by it are unavailable; applicable
deprecations produce warnings. The same minimum version reaches header import,
generated native compilation, and local Swift compilation. If no target is
configured, Z does not invent one for version comparisons. Stage 0 accepts only
the host platform; cross-compilation and runtime availability guards remain
future work.

Native library selection is explicit project configuration:

```json
{
  "target": {
    "includeDirectories": ["vendor/include"],
    "link": {
      "directories": ["vendor/lib"],
      "libraries": ["sqlite3"]
    }
  }
}
```

Each validated, deduplicated library name is translated to the host toolchain's
native library argument. `target.includeDirectories` supplies compiler and
language-server header search paths; `target.link.directories` supplies native
library search paths. Relative entries resolve from the directory containing
`z.json`, absolute entries remain absolute, and configured paths must be
existing directories. Raw linker flags are intentionally not part of this
contract. A header import supplies declarations while `target.link.libraries`
supplies link-time implementations.

C imports may be direct and zero-wrapper. Imported non-null Objective-C classes
are nominal types such as `AppKit.NSWindow`; references use ARC and can be stored
in Z aggregates or named in signatures. Inferred nullable Objective-C
references display as `T | null`, require a null check before member access,
and narrow in the non-null control-flow path without a runtime wrapper. This
spelling is accepted for imported Objective-C reference fields, parameters,
returns, and locals. General Z values use `Option<T>` while representation and
matching are unified. `Option.fromNullable(reference)` explicitly converts the
native nullable form into `Option<T>` for `some`/`none` matching. Objective-C
references and `.zd`-declared C handles use `nil` or `NULL` as the `none` niche
and remain one pointer with no wrapper allocation; general options use the
ordinary tagged enum layout. An
imported Objective-C block parameter accepts a contextual Z closure. Escaping
blocks require `move`; the generated ARC adapter keeps the owned closure
environment alive for exactly as long as the native block. APIs such as
`NSNotificationCenter` return their ordinary native observer token; Z code
keeps that token and explicitly unregisters it according to the API contract.
Weak capture can keep the persistent block from strongly cycling back to its Z
application state. A computed Z `String` converts
contextually to `NSString` for Objective-C arguments and properties using its
explicit byte length. A non-null `NSString` converts to a fresh owned Z copy
when the destination is explicitly `String`; nullable values must be narrowed
first. Console formatting can inspect a non-null `NSString` directly without
creating that owned copy.

An owned opaque C handle with a complete `.zd` release contract is nameable
through its import namespace:

```zs
import sqlite from "sqlite3.h";

class Database {
  private handle: sqlite.sqlite3;
}
```

`sqlite.sqlite3` is the non-null owned handle and
`sqlite.sqlite3 | null` is its nullable form. The namespace name is a safe Z
spelling for the header's native identity, not a wrapper or a copy of the
pointer ABI. Fields and ordinary value parameters own it, `in` borrows it, and
`move` consumes or transfers it. If stored in an ARC class, the contracted
native deinitializer runs exactly once when the final class reference is
released.

Runtime conventions that cannot be represented as an ordinary imported call
use explicit standard-library adapters. `import objc from "std/objc";` is not
needed for normal classes, methods, properties, constants, nullability, or
blocks. Its first adapter, `objc.connect(control, move () => { ... })`, owns the
native target/action control and Z closure, installs the target plus selector,
and returns an `objc.Connection`. The connection must remain bound while the
callback is desired; its precise scope lifetime and teardown prevent a weak
target from silently disappearing after a helper returns.

Zeroing `weak` Objective-C delegate and data-source properties use
`objc.bind`:

```zs
const binding = objc.bind(tableView, {
  dataSource: controller,
  delegate: controller,
});
```

The object literal names real imported writable protocol properties. Each value
must be a stored Z class implementing the property's protocol. The returned
`objc.Binding` retains the native object, generated `NSObject` adapter, and Z
controller, so the native weak property cannot dangle while the token is live.
The current adapter rejects `assign` and `unsafe_unretained` properties:
releasing their adapter would otherwise leave a dangling native pointer because
those storage conventions do not zero themselves.

Adjacent `.zd` contracts can safely restrict native pointer surfaces without
introducing a raw pointer into Z. `parameter: null` permits only the native null
value for that parameter. A `view cstring | null` result denotes borrowed,
NUL-terminated native text tied to the function's single borrowed pointer
input. It must be checked for null before `String.from` makes an owned copy;
the owner cannot be consumed while the view remains live.

A declaration parameter may also use `{ fixed NATIVE_CONSTANT; }`. The
parameter remains part of the header-verified native ABI but is omitted from Z
calls; code generation inserts the named header constant. This is intended for
legacy conventions such as SQLite's `SQLITE_TRANSIENT`, where the C type alone
does not express the safe ownership policy.

```z
const rowStatus: i32 = sqlite.SQLITE_ROW;
const bytes = sqlite.sqlite3_column_text(statement, 1);
if (bytes == null) return "missing";
const title = String.from(bytes);
```

The first C-macro tier imports active object-like integer-literal macros defined
directly by the requested header. Clang's target integer rules determine their Z
type, namespace and selective imports treat them like other native constants,
and generated source preserves the original macro token. There is no runtime
wrapper or textual expansion in Z. Function-like macros, strings, aliases, and
general constant expressions remain outside this tier.

C++ values use their native construction and destruction rules. Swift
interop uses interfaces generated by the Swift toolchain rather than a
reimplementation of the Swift ABI. Unsafe pointer operations, when added,
remain explicit escape hatches rather than the default interop path.

C++ free functions preserve their namespace hierarchy. A unique leaf name may
also be called through a short module alias; colliding leaf names require their
qualified namespace path. Imported overloads are selected from argument count
and type, with integer literals preferring `i32` and floating literals
preferring `f64`. If no unique best native signature exists, compilation fails
with `Z0803` and lists the remaining candidates.

Imported C++ records and opaque values use that same hierarchy. For example,
`cpp.zcpp.Point` is both a valid type annotation and record constructor path.
`cpp.Point` is available only when `Point` is unique across the imported module;
otherwise completion omits it and the qualified native namespace is required.

An adjacent `.zd` file may constrain an opaque native value's lifecycle:

```z
declare module "library.hpp" {
  export type zcpp.ManagedValue {
    copy;
    deinit;
  }
}
```

This does not define a Z type or repeat C++ layout. It names an existing native
type and records which of `copy`, `move`, and deterministic `deinit` are safe.
Capabilities must agree with Clang. Copyable native values follow ordinary C++
copy construction. A value declaring `move` without `copy` follows Z's
single-owner rules: an owned binding, argument, return, or containing Z struct
is consumed at the Z level and emitted with native C++ move construction.
Borrowing with `in` does not consume it. The moved-from C++ object's destructor
still runs normally, while Z rejects later source use.

Lifecycle and thread safety are separate contracts. A native owner may cross an
explicit thread only when its declaration adds:

```z
thread {
  transfer;
  deinit;
}
```

`transfer` authorizes moving one unique owner to another thread; inner `deinit`
authorizes destruction on that receiving thread. The first executable tier
supports move-only C++ values and owned C handles. `share` is reserved for a
future retained/shared native identity and is not executable yet. Because these
facts are not encoded by ordinary C/C++ ABI types, declaring them is a trusted
FFI assertion.

Public constructors plus static and instance methods on contracted C++ values are
imported from the header without wrapper declarations. Construction and static
calls live on the native type:

```z
const direct = native.zcpp.ManagedValue(20);
const made = native.zcpp.ManagedValue.from(22);
```

`Type(args)` constructs an owning native value. It intentionally omits `new`,
which is reserved for ARC-managed Z classes. A native `const` instance method
borrows its receiver; a non-const method requires addressable `let` storage:

```z
let copied = owner;
copied.value.add(2);       // C++ mutable receiver
const answer = copied.value.value(); // C++ const receiver
```

Calls lower to ordinary C++ construction, static calls, or member calls. Native
overloads use the same exact selection and `Z0803` diagnostics as imported free
functions. Copy/move constructors are ownership mechanics rather than ordinary
constructor overloads. The synchronous move-only tier supports locals, owned
parameters and returns, whole Z value structs, growable `Array<T>` buffers, and
named Z enum payloads. Array growth uses native move construction and reverse
destruction. Named enums borrow their payload under `match (in value)` and move
it into the arm under consuming `match (value)`; their active native payload is
destroyed automatically. These storage shapes also compose with ordinary
Z-managed fields such as `String`.

Compiler-provided `Option<T>` and `Result<T, E>` use the same non-trivial
tagged-union lifetime machinery, including borrowed and consuming matches.
Direct async frame locals, whole Z value structs/enums containing them, and
fallible task results also support move-only native storage through `try await`
and `attempt await`. Unqualified owned async parameters move native values or
whole native-owning Z aggregates into the child frame at `await`/`task`; the
source is unavailable immediately after task creation. ARC class fields, owned
closure environments, ownership-bearing async output, and child-task output remain
later construction paths. Immutable `in` value/native parameters may suspend: direct
await bounds the borrow to its join, while task requires an explicit `async
scope` and keeps the owner immutable and unmovable until each borrowing task is
joined. ARC class parameters omit `in` and use their ordinary retained-reference
behavior. Value/native `inout` parameters may suspend when called through direct
`await`; the caller's mutable storage remains stable and inaccessible until the
join. An explicit async scope also permits one `inout` child task to hold
exclusive access. Consuming that task through await or cancellation releases the
borrow early; otherwise scope exit releases it. Async `Slice<T>` parameters copy
only their pointer/length descriptor and borrow fixed-array or growable
`Array<T>` backing storage under the same direct-await or scoped-task rules.
The owner may contain Z cleanup-bearing or move-only C++ elements; task-frame
cleanup destroys initialized elements in reverse order on success, failure, or
cancellation. A live Slice loan prevents `Array.push` and other owner mutation
that could invalidate its data pointer. ARC-reference rebinding is not
implemented. Non-throwing
direct-awaited `out` parameters may initialize cleanup-free caller storage and
must do so on every successful path; child-task and ownership-bearing output remain
deferred. Mutations made before failure or cancellation are not rolled back.

Swift-generated C++ compatibility values use this same surface. For example,
the current owned-value probe supports `Swift.OwnedCounter.init(40)`,
`counter.getValue()`, and `counter.setValue(42)`. A generated const method is an
`in` receiver borrow; a generated mutating method requires addressable `let`
storage and is presented as `inout this` in editor help. This is direct generated
C++ member interop, not Swift property syntax: property sugar, generics,
protocols, errors, async, and packages remain separate slices.

A generated `swift::String` return converts when its destination is explicitly
Z `String`:

```z
const description: String = Swift.describeOwnedCounter(counter);
```

This creates a fresh owned UTF-8 copy and preserves the native byte length,
including embedded NUL bytes. Omitting `: String` is diagnosed so that the copy
is visible in source. Swift `String` parameters are not yet accepted: Apple’s
current C++ overlay constructs them through a null-terminated input path, which
cannot represent every Z `String` safely.

Named C++ value references reuse Z's existing parameter capabilities. No C++
reference punctuation enters Z source:

```z
native.inspect(value);              // const T&: call-scoped in borrow
native.adjust(inout value, 2);      // T&: explicit mutable borrow
native.consume(value);              // T&&: owned move-only transfer
```

The same mapping applies to receiver-qualified methods. `const &` borrows an
immutable receiver, `&` requires addressable `let` storage, and `&&` consumes a
move-only receiver. Hover and signature help show `in`, `inout`, or `move this`
using Z terminology. C++ references do not prove non-escape behavior; imported
native code remains a trusted boundary and the first tier treats reference
borrows as call-scoped.

Reference returns, builtin scalar references, copyable `T&&`, and overload sets
whose only distinction changes an argument or receiver capability remain
deferred. The last case is diagnosed rather than silently choosing borrow or
consume. Conversions and general templates also remain later tiers.

Native namespaces may also be selected and aliased with ordinary import syntax:

```z
import { zcpp as math, alpha, beta } from "cpp_math.hpp";

const origin = math.Point({ x: 20, y: 22 });
const moved = math.translate(origin, 1, -1);
```

The binding is a compile-time Z namespace for the native C++ namespace; it does
not create a runtime object or wrapper. Selecting the namespace is preferred
when leaf declarations collide across C++ namespaces.

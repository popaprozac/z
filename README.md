# Z Lang

Z is an experimental native systems language with TypeScript-inspired syntax,
safe value semantics, deterministic cleanup, typed errors, and first-class
interop with C-family platform APIs.

The stage-0 compiler is written in TypeScript, runs on Bun, and emits readable C,
C++, or Objective-C-family source before the platform compiler produces a native
binary. It has no third-party package dependencies. `z run` streams the native
program's stdout and stderr as they are written, including while a GUI event loop
is active.

Documentation has four explicit roles:

- this README is the approachable tour and runnable cookbook;
- [`docs/language-reference.md`](docs/language-reference.md) states accepted
  source semantics;
- [`DESIGN.md`](DESIGN.md) records rationale, tradeoffs, and open design work;
- [`docs/bootstrap-status.md`](docs/bootstrap-status.md) says exactly what the
  stage-0 implementation supports today.

Temporary lowering limits belong in the status document, not in the language
contract. New language decisions should update the reference and design files;
new implementation slices should update status and their runnable example.

```z
import stdio from "stdio.h";

function add(a: i32, b: i32): i32 {
  return a + b;
}

function main(): i32 {
  const answer: i32 = add(20, 22);
  stdio.printf("Z says %d\n", answer);
  return 0;
}
```

Large headers can expose only the C declarations a file uses, with optional local
aliases:

```z
import { sqlite3_open, sqlite3_close as closeDatabase } from "sqlite3.h";
```

This is a scope filter over the same typed header module, not a wrapper or an
ABI redeclaration. Functions, supported typedef-named types, and enum constants
share the same selective binding model.

Z source files use the same familiar import surface with explicit exports:

```z
// geometry.z
export struct Point { x: i32; y: i32; }
export function total(in point: Point): i32 { return point.x + point.y; }
```

```z
import geometry from "./geometry.z";
import { total as sum } from "./geometry.z";

const point = geometry.Point({ x: 20, y: 22 });
const answer = sum(point);
```

Relative paths ending in `.z` form a recursively loaded source-module graph.
Namespace and selective imports expose only declarations marked `export`;
private declarations receive collision-free compiler identities. Circular
imports, missing files and exports, and duplicate bindings are diagnosed before
native generation. The bootstrap links the graph into one C-family translation
unit while preserving source names in diagnostics, formatting, and editor
services. An export-only file is valid in `z check` and the language server;
only an executable entry selected by `z run` or the current executable-oriented
`z emit` must declare
`function main(): i32`. Run the three-file example with
`bun run z run examples/modules/main.z`.

Structs are value types with fields, literals, and methods:

```z
struct Point {
  x: i32;
  y: i32;

  function translated(dx: i32, dy: i32): Point {
    return Point({ x: this.x + dx, y: this.y + dy });
  }
}

const origin = Point({ x: 0, y: 0 });
```

Classes use reference identity and automatic reference counting. Assigning or
passing a class reference shares the same instance; the compiler inserts retain
and release operations, and `deinit` runs once when the final strong reference
ends. Traits are explicit behavior contracts checked at the `implements` site:

```z
trait Counted {
  function value(): i32;
  function add(inout this, amount: i32): void;
}

class Counter implements Counted {
  count: i32;

  function value(): i32 { return this.count; }

  function add(inout this, amount: i32): void {
    this.count = this.count + amount;
  }
}

const first = new Counter({ count: 1 });
const second = first;
first.add(2); // Both references now observe 3.
```

Construction follows the value/identity distinction. `Point({ ... })` creates a
struct value; `new Counter({ ... })` creates a class instance and its initial
owning strong reference. `new` is class-only—not a general allocator or a manual
memory primitive—and the compiler remains free to optimize physical allocation
without changing class identity. The synthesized initializer currently requires
every public field exactly once. Classes with invariants can declare a
TypeScript-shaped constructor and private state:

```z
class Session {
  private id: i32;
  public name: String;

  constructor(id: i32, name: String) {
    this.id = id;
    this.name = name;
  }

  function identifier(): i32 { return this.id; }
}

const session = new Session(42, "primary");
```

Fields default to `public`. A private field requires a constructor, cannot be
accessed outside its declaring class, and is omitted from external completion.
Constructors return the initialized instance implicitly. Every field must be
initialized on every successful path; fields cannot be read and `this` cannot
escape before that point. A constructor may `throw`, and `try`/`attempt` use the
ordinary `Result<Class, Error>` model. Failure destroys only fields whose
initialization completed, then releases the unfinished allocation.

Type-scoped methods provide factories and utilities without an instance
receiver:

```z
class Session {
  private id: i32;

  constructor(id: i32) { this.id = id; }

  private static function normalizedId(id: i32): i32 {
    if (id < 0) { return 0; }
    return id;
  }

  static function create(id: i32): Session {
    return new Session(Session.normalizedId(id));
  }
}

const session = Session.create(42);
```

The same construct is useful on value structs. `static` describes attachment to
the type rather than allocation strategy:

```z
struct Point {
  x: i32;
  y: i32;

  static function origin(): Point {
    return Point({ x: 0, y: 0 });
  }

  function sum(): i32 { return this.x + this.y; }
}

const origin = Point.origin(); // Point value; no implicit heap allocation
```

A struct is a value type, not a promise that it always occupies a stack slot.
Its storage may be a local slot, registers, inline aggregate or array storage,
caller return storage, and eventually explicitly managed heap or arena memory.
Static struct methods lower to namespaced free functions and add no dispatch or
allocation overhead.

Methods default to `public`; `private` applies to instance and static methods
as well as fields. A static method is called only as `Type.method()`, has no
`this`, performs no implicit allocation, and may use ordinary generics,
`throws`, and source-module imports. Generic static factories infer their owner
type from arguments (`Container.wrap(42)`) or accept explicit method-position
arguments (`Container.wrap<i32>(42)`). Static fields remain deliberately deferred.

`const` fixes the class reference binding; it does not make the referenced
instance deeply immutable. This lets an explicitly mutating `inout this` method
operate through a `const` class reference. Classes do not support `move this`,
because another ARC alias may still refer to the same instance. This first trait
slice checks concrete conformance only; trait-typed values and dynamic dispatch
are not implemented yet.

Zeroing weak references break intentional ARC cycles without making class
references nullable:

```z
const observer = weak owner; // inferred Weak<Owner>
const upgraded = attempt observer.upgrade();
match (upgraded) {
  success(owner) => use(owner);
  failure(expired) => handleClosedOwner();
}
```

`Weak<T>` accepts class types only. `weak value` borrows an existing stored
class reference and lazily creates its control block; it never retains the
class. `upgrade()` is a throwing operation that returns a retained strong
reference on success or `WeakExpired` on failure, so callers use ordinary
`attempt`, `try`, and `success`/`failure` matching. Weak values themselves are
copyable managed handles and release the control block deterministically.

An owned closure breaks a cycle by capturing a weak value rather than the class:

```z
const owner = weak this;
const handler: () => i32 = move (): i32 => {
  const upgraded = attempt owner.upgrade();
  return match (upgraded) {
    success(owner) => owner.value();
    failure(expired) => -1;
  };
};
```

The bootstrap reference counts remain single-threaded. Atomic upgrade and
cross-thread ownership are part of the concurrency design rather than implied
by this first weak tier. See `examples/weak-references.z` for the full lifecycle
and escaping-closure probe.

Bindings make mutation explicit. `const` stores an immutable value; `let`
stores a mutable value in the same lexical scope. Z does not have JavaScript's
function-scoped, hoisted `var`:

```z
const origin = Point({ x: 1, y: 2 });
let position = origin;
position.x = 10;
position = Point({ x: position.x, y: 20 });
```

Assignment is a statement rather than a value-producing expression. It is
statically type-checked, and nested field mutation must remain rooted in a
`let`. Owned and `in` parameters are immutable; `inout` parameters permit
mutation of the caller's explicitly borrowed storage. Match bindings remain
immutable in this bootstrap slice. Replacing cleanup-bearing storage evaluates
the new value first, destroys the old value exactly once, and then installs the
replacement. If evaluation exits with an error, ordinary scope cleanup remains
responsible for the old value.

Methods borrow `this` immutably by default. A method that changes its receiver
declares the non-default capability as a TypeScript-style receiver parameter:

```z
struct Counter {
  value: i32;

  function add(inout this, amount: i32): void {
    this.value = this.value + amount;
  }

  function current(): i32 {
    return this.value;
  }
}

let counter = Counter({ value: 1 });
counter.add(2);
```

`counter.add` requires mutable addressable `let` storage. `current` may be
called through `const`, `let`, or a temporary. The receiver capability belongs
to the method signature; callers do not repeat `inout` because the receiver is
already explicit in member-call syntax.

A consuming method takes ownership with `move this`:

```z
struct Resource {
  handle: usize;

  function close(move this): void {
    // Ownership ends here; deinit performs the release on method exit.
  }

  deinit {
    native_close(this.handle);
  }
}

const resource = Resource({ handle });
resource.close();
// `resource` has moved and cannot be used again.
```

The receiver is passed by value and owned by the method. A cleanup-bearing
receiver is destroyed exactly once on every exit unless the method returns or
forwards `this`. The owned receiver may be mutated. Calling a consuming method
on a copyable struct copies it, so the original remains usable. `move` is
contextual before `this`; functions and enum variants may still be named
`move`.

Native function parameters are owned/by-value by default. Copyable values copy;
cleanup-bearing values move. A function declares a borrow only when it does not
need ownership:

```z
function read(in counter: Counter): i32 {
  return counter.value;
}

function add(inout counter: Counter, amount: i32): void {
  counter.value = counter.value + amount;
}

const current = read(counter); // `in` is quiet at the call site.
add(inout counter, 2);         // Mutation is explicit.
```

Capabilities precede the binding because they describe how the declaration may
access storage; the annotation after `:` is always the value's type.

Borrowed parameters cannot be returned, stored into owning fields, or otherwise
moved. `inout` requires an initialized mutable binding and can be forwarded with
`inout parameter`. The bootstrap currently borrows stored expressions or
non-cleanup struct literals; general borrowed-temporary lowering comes later.
`out` starts write-only, must be initialized on every successful return path,
and becomes readable after definite assignment:

```z
function divide(value: i32, out quotient: i32, out remainder: i32): void {
  quotient = value / 2;
  remainder = value - quotient * 2;
}

let quotient: i32;
let remainder: i32;
divide(17, out quotient, out remainder);
```

Cleanup-bearing output storage becomes live only after initialization. Passing
an already-live value to `out` destroys its old value before the call. Throwing
native functions with `out` parameters remain deferred so failure does not
leave ambiguous output state. A call may share one value through multiple `in`
parameters, but overlapping writable, owned, and borrowed uses are rejected.

Tagged enums carry typed payloads and are matched exhaustively:

```z
enum UserResult {
  success User,
  failure UserError,
}

match (result) {
  success(user) => show(user);
  failure(error) => showError(error);
}
```

`Option<T>` is the compiler-provided form for a value that may be absent. Value
payloads use the same enum and ownership machinery rather than an unsafe
sentinel:

```z
const present = Option.some(user); // infers Option<User>
const absent: Option<User> = Option.none;

const id = match (present) {
  some(user) => user.id;
  none => -1;
};
```

`Option.none` needs either a destination annotation, as above, or an explicit
qualifier such as `Option<User>.none`, because an empty value contains no payload
from which to infer `T`. `Option.none` is a value, so it is not called with `()`.

`T | null` is the TypeScript-shaped optional spelling. Plain `T` remains
non-null, `null` requires an optional destination, and unchecked member access
is rejected. The current executable specialization accepts imported
Objective-C reference types and preserves their native one-pointer null niche;
general values continue to use `Option<T>` until the two source spellings share
all construction and matching paths.

At a native boundary, `Option.fromNullable` explicitly lifts a nullable
Objective-C reference into the Z enum model:

```z
const option = Option.fromNullable(app.keyWindow);
const centered = match (option) {
  some(window) => {
    window.center();
    select true;
  }
  none => false;
};
```

The bootstrap implements Objective-C reference options with the pointer's null
niche: `none` is `nil`, `some(reference)` is the reference, and matching is a
null comparison. The lift does not allocate a wrapper or add a tag, so
`Option<AppKit.NSWindow>` remains one pointer. General `Option<T>` values still
use the ordinary tag-plus-payload enum layout when `T` has no proven niche.

Enums composed only from copyable payloads remain copyable. If any reachable
payload has deterministic cleanup, the enum becomes an owned, move-only value:
construction transfers that payload into the active variant, an uninspected
enum destroys only its active payload, and exhaustive `match` transfers the
payload into its arm binding. This supports option-like class enums, resources
inside user enums, nested enum fields, and arrays of owned enums without a
special runtime representation. Existing class references retain when placed
in a variant; single-owner values move.

Enums may be stored directly in structs and fixed arrays or used as another
enum's payload. The compiler orders generated native definitions from their
value dependencies and rejects recursive struct/enum layouts.

An ordinary match consumes an owned cleanup-bearing enum and transfers its active
payload into the selected arm. A subject that is already an `in` binding is
borrowed automatically. Use `match (in value)` to explicitly inspect owned,
stored enum storage without consuming either the enum or its payload:

```z
function resourceId(in state: ResourceState): i32 {
  return match (state) {
    ready(resource) => resource.id;
    empty => -1;
  };
}
```

Cleanup-bearing bindings introduced by a borrowed match are immutable borrows. They
can be read or passed to `in` parameters, but cannot be moved out. The original
enum remains available after the match. Borrowing a temporary is rejected;
bind it first or omit `in` to consume it.

`match` can produce a value. A concise arm provides its expression directly;
use `select` when an arm needs multiple statements:

```z
const id: i32 = match (result) {
  success(user) => {
    log(user);
    select user.id;
  }
  failure(error) => throw error;
};
```

Conditionals can produce values with the same explicit local selection model.
Ternaries retain their familiar TypeScript spelling:

```z
const short = ready ? "Ready" : "Waiting";
const detailed = if (ready) {
  log("ready");
  select "Ready";
} else {
  log("waiting");
  select "Waiting";
};
```

The bootstrap also supports typed, non-escaping arrow closures with inferred
read and mutable captures. `move` snapshots copyable captures when the closure
is created:

```z
const add = (value: i32): i32 => value + offset;

let total = 0;
const accumulate = (value: i32): i32 => {
  total = total + value;
  return total;
};

const snapshot = move (value: i32): i32 => seed + value;
```

Explicit function types make callables first-class values. Named functions and
non-capturing closures can be stored, passed, returned, and kept in aggregate
fields without allocation:

```z
function apply(operation: (left: i32, right: i32) => i32): i32 {
  return operation(20, 22);
}

const operation: (left: i32, right: i32) => i32 = add;
const doubled: (value: i32) => i32 = (value) => value * 2;
```

Z follows an **infer implementations, declare contracts** rule. Local bindings,
generic call arguments, expression-bodied closure results, and closure parameter
types supplied by a destination function type may be inferred. Function
parameters, public and FFI boundaries, aggregate fields, and uninitialized
storage stay explicit. Access capabilities are never inferred from a closure
body: a destination requiring `inout` still uses `(inout value) => ...`.

Function parameters and imported C callbacks also provide contextual closure
types, allowing TypeScript-style inline callbacks without wrapper declarations:

```z
const answer = apply((value) => value * 2, 21);
const captured = applyWithContext(40, (value) => value + offset);
mutate((inout value) => { value = value + 1; }, inout counter);
```

Noncapturing closures need no environment. An explicit `in` function parameter
or call-scoped C callback borrows captures through an allocation-free stack
environment. Owned/value and escaping callback parameters require explicit
`move` and use the same ARC-managed environment as stored closures; an escaping
C callback transfers it through the API-note release hook.

Run the closure example with:

```sh
bun run z run examples/closures.z
bun run z run examples/function-values.z
bun run z run examples/owned-closures.z
```

Borrowing closures remain non-escaping and allocation-free. A capturing closure
can become a stored or returned function value when it uses `move` and an
explicit function type. Z then creates an ARC-managed environment: copyable
captures are snapshotted, class and function values are retained, unique
cleanup-bearing values transfer ownership, and the final release destroys
captured fields in reverse order. Copies of the function value share the same
environment and therefore share mutable captured state.

Non-capturing function values use the same internal shape with a null
environment and do not allocate. Weak captures, cross-thread reference counts,
and capturing `this` remain later layers.

Typed logging uses the explicit standard `console` module:

```z
import console from "std/console";

console.log(`${someInt} with text in between, struct: ${someStruct}`);
console.write("no automatic newline");
console.error("written to stderr", errorValue);
console.debug("debug stream", state);
```

The equivalent facade spelling is `import { console } from "std";`. Core
language types and intrinsics remain implicit; standard facilities are imports.
`std` and `std/...` are compiler-reserved module paths and are never mistaken
for native headers by Clang.

Blocking and suspending delays live in the focused `std/time` module:

```z
import { sleep, delay } from "std/time";

sleep(250); // milliseconds; blocks the current OS thread

async function waitWithoutBlocking(): void {
  await delay(250); // suspends this task; other ready tasks keep running
}
```

`sleep(milliseconds: u64): void` lowers to the host timing primitive and is
useful in synchronous applications and smoke tests. It remains explicitly
blocking inside async code. `delay(milliseconds: u64): void` is async: its
monotonic deadline enters the executor timer queue, and the executor sleeps the
OS thread only when it has no ready work. Cancelling a delayed task removes its
pending timer.

```sh
bun run z run examples/sleep.z
```

Template expressions use TypeScript's `${expression}` spelling and run exactly
once from left to right. Plain braces are literal text; write `\${expression}`
for a literal interpolation sequence. The bootstrap formats primitives,
structs and imported records, arrays, enums, and class identity. A template
produces an owned, move-only `String`; it can be stored, returned, placed in
owning storage, and logged. Single- and double-quoted literals also produce
`String`, backed directly by static program bytes without allocating. Imported
C APIs that accept `cstring` borrow a `String`'s NUL-terminated bytes for that
call only; `String.from(value)` explicitly copies a borrowed `cstring`. A
template passed directly to `console` keeps an allocation-free lowering.

```sh
bun run z run examples/console.z
bun run z run examples/strings.z
```

Ownership and capability diagnostics include stable codes, the source location
where a move or closure borrow began, explanatory notes, and concrete help.
The CLI renders annotated source while the language server publishes the same
secondary locations to the editor. See [docs/diagnostics.md](docs/diagnostics.md)
for the current code catalog.

Throwing functions use a compiler-provided `Result<T, E>` without constructor
ceremony:

```z
function findUser(id: i32): User throws UserError {
  return User({ id: id });
}

const result = attempt findUser(42);
match (result) {
  success(user) => show(user);
  failure(error) => showError(error);
}
```

`return` constructs success and `throw` constructs failure. A throwing call must
be marked with `attempt` for inspection or `try` for propagation:

```z
function userId(id: i32): i32 throws UserError {
const user = try findUser(id);
  return user.id;
}
```

Control flow uses familiar TypeScript-style conditions with statically checked
Boolean expressions. A non-void function must return on every reachable path:

```z
function classify(value: i32, enabled: bool): i32 {
  if (!enabled) return 0;
  else if (value >= 10 && value != 42) return 1;
  else return 2;
}
```

A statement branch may be one statement or a block; `else` binds to the nearest
unmatched `if`. Value-producing `if` expressions still require braces and
explicit `select`.

`while`, `break`, and `continue` use the same familiar syntax. Every loop-control
transfer runs deterministic cleanup for the local scopes it exits:

```z
let index = 0;
while (index < 10) {
  index = index + 1;
  if (index == 3) { continue; }
  if (index == 8) { break; }
}
```

Ownership analysis reaches a fixed state across loop back-edges. Moving a value
on one iteration and potentially using it on the next is therefore rejected.

Fixed arrays, `Array<T>`, and `Slice<T>` support TypeScript-style read-only
iteration:

```z
for (const value of values) {
  if (value == 0) { continue; }
  consume(value);
}
```

Copyable elements copy into the loop binding. Cleanup-bearing elements are
borrowed and cannot move out of collection storage. The collection remains
structurally borrowed during iteration, so operations such as `Array.push`
that may reallocate are rejected until the loop ends. Mutable element,
consuming, custom-trait, and async iteration remain future tiers.

Fixed arrays are inline values with compile-time length, TypeScript-adjacent
element syntax, and bounds-checked indexing:

```z
let values: i32[4] = [10, 20, 30, 40];
values[2] = 42;
const count: usize = values.length;
```

The length is part of the type, so `i32[3]` and `i32[4]` are distinct. Arrays
copy or move according to their element ownership, may be nested or stored in
structs, and clean up owned elements in reverse order. Safe indexing traps on an
out-of-range index. Empty literals need later contextual literal inference.

`T[N]` intentionally means only a fixed inline array. `Slice<T>` is a non-owning
pointer/length view accepted initially only as a function parameter:

```z
function sum(values: Slice<i32>): i32 { /* read-only elements */ }
function fill(inout values: Slice<i32>, value: i32): void { /* mutable elements */ }

sum(values);
fill(inout values, 0);
```

A fixed array converts to a compatible slice for the duration of the call.
Slice parameters are already borrowed, so read-only slices omit `in`; `inout`
creates an exclusive mutable element borrow and remains explicit at both sides.
Slices cannot yet be returned, stored in fields or enums, or captured in local
bindings. This non-escaping boundary provides lifetime inference without public
lifetime annotations.

`Array<T>` is an explicitly allocated, growable owned buffer:

```z
let values = Array<i32>();
values.push(10);
values.push(20);
values[1] = 42;
```

It exposes checked indexing plus read-only `length` and `capacity` properties.
`push` requires `let` storage because growth may replace the allocation. The
array moves as one owner, borrows as `Slice<T>`, and destroys initialized
elements in reverse order before releasing its buffer. Capacity growth and
allocation-size arithmetic are checked; allocation failure currently traps.
Removal, reservation, and fallible allocation APIs remain upcoming. `T[]` stays
unassigned rather than hiding allocation or borrowing.

User-defined generic structs, classes, and functions use TypeScript-style type
parameters. Function calls infer concrete arguments from their values while
retaining an explicit specialization escape hatch:

```z
struct Pair<T> {
  first: T;
  second: T;

  static function make(first: T, second: T): Pair<T> {
    return Pair({ first, second });
  }
}
function first<T>(pair: Pair<T>): T { return pair.first; }

const pair = Pair({ first: 20, second: 22 }); // inferred Pair<i32>
const value = first(pair);
const explicit = first<i32>(pair);
const explicitPair = Pair.make<i32>(20, 22);
```

Generic parameters can require explicit nominal trait conformance. Multiple
requirements use TypeScript-style `&` intersections and remain statically
dispatched:

```z
function measure<T: Measured & Named>(value: T): i32 {
  return value.measure();
}
```

The compiler infers generic struct object construction, class constructor calls,
static factories, and ordinary function calls. Expected destination or return
types can resolve factories whose parameters do not mention every type argument:

```z
struct Marker<T> {
  tag: i32;
  static function create(): Marker<T> {
    return Marker<T>({ tag: 0 });
  }
}

const marker: Marker<i32> = Marker.create();
```

Concrete uses are monomorphized before semantic analysis and C lowering, so
generic values follow the same copy, move, ARC, borrowing, and `deinit` rules as
handwritten concrete code, with no runtime type metadata or dispatch cost. An
unresolved type parameter receives a diagnostic asking for explicit method- or
function-position arguments. Generic traits and separately generic methods
remain upcoming.

Owned structs can define an infallible compiler-controlled lifecycle hook:

```z
struct File {
  handle: c.FILE;

  deinit {
    c.fclose(this.handle);
  }
}
```

`deinit` runs exactly once in reverse declaration order on normal scope exit,
`return`, `throw`, and `try` propagation. Fields with cleanup are then destroyed
in reverse field order. Cleanup-bearing values move when assigned, passed to an
owned parameter, returned, or placed into an owning field. Their previous
location cannot be used afterward. Path-sensitive analysis rejects values that
may have moved along only some continuing control-flow paths, while generated
live flags ensure each runtime path still performs cleanup exactly once.

Imported opaque handles participate in the same ownership system when API
notes provide the facts missing from C headers:

```z
import stdio from "stdio.h";

const file = stdio.fopen("notes.txt", "w");
if (file == null) {
  return 1;
}

stdio.fputs("owned by Z\n", file);
// fclose(file) is inserted on every exit.
```

The explicit null guard narrows nullable `FILE *` to non-null. Z does not use
pointer truthiness. `fputs` borrows the
handle for the call; an explicit `fclose(file)` consumes it and makes any later
use a compile-time error. If ownership remains local, generated cleanup calls
`fclose` once and only when the handle is non-null.

Complete C records, enums, constants, and scalar typedefs are imported under the
module namespace and used with ordinary Z syntax:

```z
import console from "std/console";
import geometry from "geometry.h";

function move(point: geometry.Point, amount: geometry.Count): geometry.Point {
  return geometry.translate(point, geometry.Forward, amount);
}

const origin = geometry.Point({ x: 10, y: 20 });
const moved = move(origin, 3);
console.log(`moved to ${moved.x}, ${moved.y}`);
```

The header remains the single ABI declaration. Z checks record fields, enum
arguments, qualified signatures, and imported calls without an `extern` mirror.
The standard `console` module provides typed `log`, `write`, `error`, and
`debug` methods. Interpolated expressions are evaluated once from left to right,
and structs, imported records, arrays, enums, primitives, and class identity
receive useful initial formatting without exposing C variadics to Z.

The first C++ tier uses the same source model for uniquely named namespace
functions and plain aggregate records:

```z
import console from "std/console";
import cpp from "cpp_math.hpp";

const origin = cpp.Point({ x: 20, y: 22 });
const moved = cpp.translate(origin, 1, -1);
console.log(`sum=${cpp.sum(moved)}, point=${moved}`);
```

Recognized C++ header extensions select C++20 output and `clang++`; generated
calls preserve names such as `zcpp::translate`. Ambiguous overload or namespace
leaf names are rejected in this tier. Constructors, methods, references, RAII
ownership, inheritance, and templates remain future C++ layers.
The follow-up namespace tier will preserve native paths such as
`library.desktop.calculate` at the Z surface before overload resolution lands.

Pointer parameters to complete imported records remain safe when adjacent API
notes classify their call-only access. Read-only `const T *` parameters borrow a
stored value implicitly; writable `T *` parameters require mutable storage and
an explicit mode at the call site:

```z
let point: geometry.Point;
geometry.reset(out point);
geometry.offset(inout point, 3, 4);
const score = geometry.read(point); // `in` is implicit for const T *.
```

`in` promises no mutation or retention, `inout` requires initialized storage and
permits reading and mutation, and `out` fully initializes possibly uninitialized
storage. The compiler creates an address only for the duration of that call; Z
exposes no general address-of operator.

`try` evaluates its call once, propagates failure immediately, and produces the
success payload. It is currently supported directly in bindings, returns, and
expression statements; general nested-expression lowering comes later.

Integer arithmetic is checked consistently in every build mode. Ordinary
addition, subtraction, multiplication, division, remainder, negation, and
shifts trap on invalid results without exposing C signed-overflow behavior.
Constant invalid arithmetic is diagnosed during compilation. Intentional
overflow uses explicit methods such as `value.wrappingAdd(other)` or
`value.saturatingMultiply(other)`. Signed literals use their destination width,
including exact minimum values such as `const minimum: i8 = -128`.

```sh
bun run z check examples/first.z
bun run z emit examples/first.z
bun run z run examples/first.z
bun run z run examples/control-flow.z
bun run z run examples/deinit.z
bun run z run examples/foreign-handle.z
bun run z run examples/foreign-types.z
bun run z run examples/foreign-pointers.z
bun run z run examples/selective-import.z
bun run z run examples/selective-declarations.z
bun run z run examples/apple-groundwork.z
bun run z run examples/integer-safety.z
bun run z run examples/callbacks.z
bun run z run examples/cpp-interop.z
bun run z run examples/swift-interop/main.z
bun run z run examples/swift-value-interop/main.z
bun run z run examples/objc-nullability.z # macOS: nullable AppKit guard and Option matching
bun run z run examples/nswindow.z # macOS: opens a window and enters AppKit's event loop
bun run z run examples/desktop-ownership/main.z # macOS: owned model plus AppKit shell
bun run z run examples/structs.z
bun run z run examples/classes.z
bun run z run examples/static-methods.z
bun run z run examples/loops.z
bun run z run examples/arrays.z
bun run z run examples/slices.z
bun run z run examples/generics.z
bun run z run examples/match.z
bun run z run examples/match-expression.z
bun run z run examples/mutation.z
bun run z run examples/mutable-methods.z
bun run z run examples/borrowed-parameters.z
bun run z run examples/result.z
bun run z run examples/try.z
bun test
```

The current header importer asks Clang for function declarations, rejects
unknown symbols, checks fixed argument types and counts, enforces variadic
boundaries, carries supported return types into Z inference, and supports both
namespace imports and selective function, type, and enum-constant imports with
aliases. Selective type aliases preserve the underlying C declaration identity
in signatures, literals, field access, and calls. Signed and
unsigned C integer spellings and common fixed-width or pointer-sized typedefs
map to Z's `i8` through `i64`, `u8` through `u64`, `isize`, and `usize` families;
`float` and `double` map to `f32` and `f64`; `_Bool`, `const char *`, and `void`
map to `bool`, `cstring`, and `void`. The
importer also accepts opaque single-pointer handles when API
notes specify nullability, owned returns and their release function, and
borrowed or consuming parameters. Pointer parameters to imported complete
records are accepted only when notes classify them as non-escaping `in`, `out`,
or `inout`; writable calls require explicit mutable storage. The compiler ships
initial `stdio.h` notes
and discovers project notes beside a header as `<header>.zapi.json`; this JSON is
a stage-0 representation, not yet a frozen language format. Unannotated
pointers, borrowed returns without lifetime provenance, mutable strings,
globals, and macros remain conservative errors or future layers rather than
being silently treated as safe. C++ support currently includes uniquely named
namespace functions, plain aggregate records, and the first opaque copyable
RAII value slice used by Swift-generated C++ compatibility headers. General C++
classes, constructors, methods, overloads, inheritance, and templates remain
future layers.

On macOS, importing an installed framework header selects the Objective-C ARC
backend and carries the framework into the native link plan:

```z
import AppKit from "AppKit/AppKit.h";

const app = AppKit.NSApplication.sharedApplication;
const window = AppKit.NSWindow.alloc().initWithContentRect(
  AppKit.NSMakeRect(0.0, 0.0, 800.0, 600.0),
  styleMask: AppKit.NSWindowStyleMaskTitled | AppKit.NSWindowStyleMaskClosable,
  backing: AppKit.NSBackingStoreBuffered,
  defer: false
);
window.title = "Hello from Z";
window.makeKeyAndOrderFront(null);
app.run();
```

The bootstrap imports Objective-C interfaces, superclass method lookup, class
and instance methods, property getters and setters, `instancetype`, object
nullability, external object constants, and C values used inside method
signatures. An inferred nullable
reference is shown by editor services as `AppKit.NSWindow | null`; member access
requires a `reference != null` check, and the checked branch narrows to the
non-null nominal type without changing its one-pointer native representation.
The same `T | null` spelling is accepted in fields, parameters, returns, and
locals for imported Objective-C references. Calls use a selector's first
component as the TypeScript-style method name. Positional calls resolve by
argument count; labeling every argument after the first selects the complete
Objective-C selector. Imported custom property accessors are honored. String
literals bridge contextually to `NSString` for compatible Objective-C method
parameters and properties while remaining `cstring` everywhere else. ARC owns
local object-reference retain/release behavior, and the generated `main` runs
inside an autorelease pool. Escaping Objective-C blocks accept owned `move`
closures, including persistent notification observers whose returned native
tokens are explicitly removed. [`examples/appkit-events.z`](examples/appkit-events.z)
demonstrates repeated AppKit events, weak Z state capture, imported notification
constants, and deterministic unregistration. Protocols, delegates, broader block shapes,
lightweight generics, availability checking, and actor isolation remain
upcoming layers.

[`examples/desktop-ownership`](examples/desktop-ownership) combines a real
AppKit window with an ARC Z application model owning an `Array` of move-only
documents and strings. The companion
[`docs/ownership-pressure.md`](docs/ownership-pressure.md) records the concrete
walls found by extending that program, classifies ownership questions separately
from missing interop surfaces, and preserves candidate borrowing experiments for
later evidence-driven spikes.

Swift interop is deliberately split into two tiers. Swift-authored APIs exposed
through a generated Objective-C compatibility header can reuse this importer
once the build product and header are available. Native Swift support remains a
separate goal: import Swift modules/interfaces and Swift Package products so Z
can reach Swift-only Apple APIs, value types, protocols, generics, errors, and
concurrency without inventing or guessing the Swift ABI.

The compiler recognizes a conventional local `Module-Swift.h` as
Objective-C, imports its classes, methods, initializers, and properties, and
selects Objective-C ARC output. The integration suite generates a real header
and dylib with `swiftc`, links the Z-produced object against it, and executes the
result. A nearby `z.json` can now declare one Swift module, its sources, and
required frameworks; the compiler and language server share its generated
include path, while `z run` links the produced dylib automatically.

```json
{
  "target": {
    "entry": "main.z",
    "swift": {
      "module": "ZSwiftExample",
      "sources": ["Counter.swift"],
      "frameworks": ["Foundation"]
    }
  }
}
```

Paths are relative to `z.json`. Generated headers, modules, and dylibs stay in a
local `.z-cache`; they are rebuilt when the manifest or a Swift source changes.
The manifest slice intentionally supports one Swift module while its build and
link semantics are validated through real projects.

The runnable example is in [`examples/swift-interop`](examples/swift-interop):

```sh
bun run z run examples/swift-interop/main.z
```

A Swift target may instead set `"interop": "cxx"`. Z then asks `swiftc` for
the module's generated C++ compatibility surface, imports
`Module-Swift.hpp`, emits C++20, and links the same dylib automatically:

```json
{
  "target": {
    "entry": "main.z",
    "swift": {
      "module": "ZSwiftOwned",
      "sources": ["OwnedCounter.swift"],
      "interop": "cxx"
    }
  }
}
```

[`examples/swift-value-interop`](examples/swift-value-interop) exercises a
Swift-native struct that owns a Swift class reference. It returns the value to
Z, copies and round-trips it, and observes exactly-once release through the
generated wrapper's copy constructor and destructor. Swift's current generated
C++ value wrappers delete move construction, so this tier is deliberately
modeled as foreign copyable RAII rather than claiming native Swift move support.
Instance methods, properties, `swift::String`, generics, and noncopyable Swift
values remain later importer tiers.

```z
import {
  ZPoint as Point,
  ZForward as forward,
  z_translate as translate
} from "geometry.h";

const origin = Point({ x: 10, y: 20 });
const moved = translate(origin, forward, 3);
```

Complete typedef-named C structs with supported integer, enum, or nested-record
fields, C enums and their constants, and integer typedefs are now usable as
namespaced or selective Z types and values. Numeric literals are contextually
typed and rejected when they do not fit the destination width.

ABI-compatible synchronous callbacks can accept named Z functions or explicitly
typed closures. Context-free C callbacks require a non-capturing target:

```z
import { apply } from "callbacks.h";

function multiply(left: i32, right: i32): i32 {
  return left * right;
}

const answer = apply(6, 7, multiply);
```

Capturing closures work naturally when the C API carries a paired `void *`
context parameter:

```z
import { applyWithContext } from "callbacks.h";

const offset = 2;
const addOffset: (value: i32) => i32 =
  move (value: i32): i32 => value + offset;
const answer = applyWithContext(40, addOffset);
```

The Z call contains only the closure. API notes identify the native context
parameter and its position in the callback signature; the importer hides the
context plumbing from the Z signature and argument list. The backend emits a
typed trampoline plus the closure value's address as the native context
argument.

An escaping callback is also ergonomic when C accepts a destroy callback:

```z
function installRetainedOperation(): void {
  const offset = Offset({ value: 2 });
  const operation: (value: i32) => i32 =
    move (value: i32): i32 => value + offset.value;
  retainOperation(operation);
}

installRetainedOperation();
const answer = invokeRetainedOperation(40);
clearRetainedOperation(); // releases the retained closure and captured Offset
```

For this tier, API notes declare `lifetime: "escape"`, `thread: "caller"`,
and paired context and release parameters. Z heap-boxes and retains the function
value automatically. C receives a generated destroy thunk and must call it
exactly once after the final callback invocation.

The complete example keeps the Z source, C header, and API notes beside one
another:

```sh
bun run z run examples/callbacks.z
bun run z emit examples/callbacks.z # inspect the generated C
```

- `examples/callbacks.z` passes the Z function.
- `examples/callbacks.h` declares `BinaryOperation` and invokes it.
- `examples/callbacks.h.zapi.json` describes both call-only and retained
  callback lifetimes.

Because a C header does not say whether a callback is retained, the parameter
must have a sidecar API note with `"callback": { "lifetime": "call" }`. That
contract means C finishes every callback invocation before the imported
function returns. Named functions and directly bound non-capturing closures
still lower to raw C function pointers for context-free callbacks. For a paired
call-only context, the generated trampoline borrows the Z function value for
the duration of the native call; its owned ARC environment stays alive in the
caller. Unannotated callback lifetimes plus variadic and
calling-convention-specific callbacks remain unsupported. Escaping callbacks
are supported only for caller-thread APIs that unconditionally take ownership
and provide an exactly-once destroy callback. Cross-thread callbacks,
conditional ownership transfer, and unregister-shaped APIs without a native
destroy notification remain unsupported.

Unions, anonymous or incomplete layouts, plain `char` signedness, arrays,
bitfield-specific validation, and pointers stored inside records remain
upcoming interop layers.

See the [`language reference`](docs/language-reference.md) for accepted
semantics, [`DESIGN.md`](DESIGN.md) for rationale, and the
[`bootstrap status`](docs/bootstrap-status.md#foreign-interfaces) for the exact
native-import boundary.

## Async quick start

Z uses structured concurrency: async function bodies are root task scopes,
`spawn` starts a child immediately, `await` observes completion, and explicit
`async scope` blocks create narrower join boundaries. Typed domain failures keep
the same `throws`, `try`, and `attempt` model as synchronous code:

```z
async function fetchValue(value: i32): i32 {
  return value;
}

async function main(): i32 {
  const first = await fetchValue(20);
  const second = await fetchValue(22);
  return first == 20 && second == 22 ? 0 : 1;
}
```

Run it with:

```sh
bun run z run examples/async-sequential.z
bun run z run examples/async-errors.z
bun run z run examples/async-aggregates.z
bun run z run examples/async-ownership.z
bun run z run examples/async-owned-enums.z
bun run z run examples/async-methods.z
bun run z run examples/async-spawn.z
bun run z run examples/async-scopes.z
bun run z run examples/async-cancellation.z
bun run z run examples/async-delay.z
bun run z run examples/async-phase-0.z
```

Spawned tasks are scheduled immediately. A bound handle may be joined once;
non-throwing children left unbound are joined implicitly before function exit:

```z
async function fetchValue(id: i32): i32 throws NetworkError {
  return id;
}

async function main(): i32 throws NetworkError {
  const task = spawn fetchValue(42);
  return try await task;
}
```

Async calls require `await` or scope-bound `spawn`. An async function body is
an implicit root task scope; explicit `async scope` blocks provide narrower
child lifetimes. Borrowed parameters and live borrows across suspension are
rejected in the first tier. `T throws E` remains the function contract,
`Task<T, E>` represents spawned work, and `attempt await` materializes
`Result<T, E>` when the outcome should be retained. A throwing spawned child
must be joined explicitly so its domain error cannot disappear silently.

Run the broader structured-async example with:

```sh
bun run z run examples/async-phase-0.z
```

See [`docs/async-model.md`](docs/async-model.md) for the complete concurrency
model. The exact executable stage-0 lowering surface and current `Z0700`
boundaries live in
[`docs/bootstrap-status.md`](docs/bootstrap-status.md#async-and-concurrency).

## Editor setup

The repository includes a VS Code/Cursor extension in `editors/vscode`. Its
TextMate grammar recognizes `.z` syntax immediately, and it starts the Bun-based
compiler language server when a Z document opens. The server and compiler share
the frontend and imported native metadata. See the
[`bootstrap status`](docs/bootstrap-status.md#modules-and-tooling) for the
current completion, hover, diagnostics, semantic-token, and definition surface.

Install it locally for VS Code and/or Cursor, then reload the editor window:

```sh
./scripts/install-editor-extension.sh
```

The installer creates a development symlink. The extension automatically
restarts its language server when files under `compiler/src` change and
resynchronizes every open Z document. TextMate grammar or extension-host changes
still require an editor reload. Bun must be available on the editor's `PATH`;
the extension also detects the standard `~/.bun/bin/bun` installation, and the
`z.bunPath` editor setting can select another executable. The language server
can also be started directly for another LSP client:

```sh
bun run lsp
```

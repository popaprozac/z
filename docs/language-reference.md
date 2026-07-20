# Z language reference

This document summarizes the accepted source-language semantics of Z. It is
about what Z code means, independent of which bootstrap compiler tiers currently
execute every shape. For rationale and unresolved design questions, see
[`DESIGN.md`](../DESIGN.md). For implementation coverage and temporary limits,
see [`bootstrap-status.md`](bootstrap-status.md).

## Declarations and modules

Z source uses explicit exports and TypeScript-shaped imports:

```z
// geometry.z
export struct Point { x: i32; y: i32; }
export function sum(in point: Point): i32 { return point.x + point.y; }

// main.z
import geometry from "./geometry.z";
import { sum as total } from "./geometry.z";
```

Relative `.z` imports form a source-module graph. Native headers use the same
surface (`import C from "library.h"`) but bind declarations supplied by the
foreign interface rather than redeclaring their ABI.

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

A field marked `readonly` is initialized during construction and cannot be
assigned or mutated afterward:

```z
class Configuration {
  readonly name: String;
  readonly retries: i32;
}
```

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
field or indexed projection. The view cannot be annotated as storage, copied,
stored, returned again, or held across `await`. It may be forwarded to a
synchronous `in T` parameter or read through an inline closure passed to a
synchronous `in` function parameter. The latter closure is compiler-proven
nonescaping and copies only the view pointer into its stack environment; owned,
stored, mutable, escaping, and async forwarding remain rejected. Its owner cannot
mutate or move before the view's last use. ARC class owners are excluded because
another alias could invalidate growable projected storage.

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

Synchronous error values may contain cleanup-bearing fields such as `String`.
`throw` transfers the error into the failure result; `try` transfers it onward;
and consuming or borrowed `match` follows the same payload rules as other
enums. Move-only native values remain excluded from compiler-provided
`Result<T, E>` storage until that built-in representation receives native
construction and destruction.

`Result<T, E>` is a built-in tagged union with `success` and `failure` variants;
those names are variants, not global functions or reserved keywords.

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

An expression arm may be concise or use a block with `select value`. `return`
and `throw` always target the enclosing function. `yield` is reserved for
generators rather than overloaded for match blocks.

## Control flow and expressions

`if`, `while`, and `match` parenthesize their subject. Z supports ternaries and
value-producing `if` expressions. Statement blocks never return an implicit
last expression; value-producing blocks use `select` explicitly.

Statement `if`/`else` branches may contain one unbraced statement. `else` binds
to the nearest unmatched `if`. Conditions are always `bool`; nullable pointers
and references require an explicit comparison with `null` rather than
truthiness.

Integer arithmetic is checked. Intentional overflow uses explicit wrapping or
saturating operations.

## Collections and views

- `T[N]` is a fixed-size owned array.
- `Array<T>` is a growable owned buffer.
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
boundaries. Compiler offsets and binary-facing code should use these explicit
byte operations. `String.length` is reserved for a Unicode grapheme-counting
text API; it is not implemented by treating UTF-8 bytes or JavaScript UTF-16
code units as characters. `byteLength` is constant-time; the eventual
grapheme-aware `length` may require a text scan.

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
  try fs.writeText(".z-cache/input.z", source);
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

`z run file.z -- one two` forwards `one` and `two` to the native program.
Stage 0 currently lowers these APIs to a small cross-platform C runtime. The
portable standard-library layers are intended to become ordinary Z modules;
OS/ABI calls remain a thin platform substrate.

## Async and structured concurrency

`async function` returns a task conceptually, while `await` observes its
completion. `spawn` starts child work immediately. Every spawned child belongs
to a lexical task scope; an async function body is an implicit root scope and an
`async scope` creates a narrower join boundary.

```z
async function refresh(): void throws NetworkError {
  async scope {
    spawn refreshUser();
    spawn refreshPosts();
  }
  publishRefreshedUI();
}
```

Leaving a scope joins its children. Failure propagation cancels live siblings
before the failing task completes. Domain errors remain `T throws E`;
cancellation is a structural task outcome, not an invented member of `E`.

CPU work that must leave the inherited executor uses the explicitly imported
native-thread launcher:

```z
import { thread } from "std/thread";

const calculation = thread.spawn(move () => calculate(input));
doOtherWork();
const answer = await calculation;

const fallible = thread.spawn(move (): i32 throws CalculationError => {
  return try calculateOrThrow(input);
});
const result = attempt await fallible;
```

This is distinct from keyword `spawn`: `spawn operation()` schedules an async
child on the current executor, while `thread.spawn(operation)` starts exactly
one OS thread. The initial transfer classifier copies recursively cleanup-free
values, moves unique owners, and retains deeply readonly ARC class identity
atomically. A capturing closure must spell `move`. Copy and shareable ARC
captures remain valid in the parent; moved unique owners do not. `Array`, owned
`String`, mutable `TextBuffer`, and supported aggregates containing them use the
consuming path and may return ownership through `await`. Mutable classes,
borrows, views, native references, `Arena`, custom `deinit`, and cross-thread
`Weak<T>` remain rejected. Results follow the same rules.
The returned task remains scope-bound and is joined explicitly by `await` or
implicitly at scope exit.
Throwing worker closures return `Task<T, E>`; `try await` propagates `E` and
`attempt await` produces `Result<T, E>`. The first tier requires a cleanup-free
scalar or value error payload. Owned worker errors await explicit live-state
tracking in async error slots.

## Native interop

Native declarations come from toolchain-owned headers and module interfaces.
Z's foreign semantic model adds facts absent from those declarations: ownership,
nullability, lifetime, callback retention, threading, and async behavior.
Those facts normalize through the
[`Foreign Interface IR`](foreign-interface-ir.md) before semantic checking.

A project may explicitly configure `target.platform` and
`target.minimumVersion` together in `z.json`. The target is compile-time project
configuration, not a nullable runtime global. Native declarations introduced
after that minimum version or obsoleted by it are unavailable; applicable
deprecations produce warnings. The same minimum version reaches header import,
generated native compilation, and local Swift compilation. If no target is
configured, Z does not invent one for version comparisons. Stage 0 accepts only
the host platform; cross-compilation and runtime availability guards remain
future work.

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
creating that owned copy. C++ values use their native construction and destruction rules. Swift
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
whole native-owning Z aggregates into the child frame at `await`/`spawn`; the
source is unavailable immediately after task creation. ARC class fields, owned
closure environments, ownership-bearing async output, and spawned output remain
later construction paths. Immutable `in` value/native parameters may suspend: direct
await bounds the borrow to its join, while spawn requires an explicit `async
scope` and keeps the owner immutable and unmovable until each borrowing task is
joined. ARC class parameters omit `in` and use their ordinary retained-reference
behavior. Value/native `inout` parameters may suspend when called through direct
`await`; the caller's mutable storage remains stable and inaccessible until the
join. An explicit async scope also permits one spawned `inout` child to hold
exclusive access. Consuming that task through await or cancellation releases the
borrow early; otherwise scope exit releases it. Async `Slice<T>` parameters copy
only their pointer/length descriptor and borrow fixed-array or growable
`Array<T>` backing storage under the same direct-await or scoped-spawn rules.
The owner may contain Z cleanup-bearing or move-only C++ elements; task-frame
cleanup destroys initialized elements in reverse order on success, failure, or
cancellation. A live Slice loan prevents `Array.push` and other owner mutation
that could invalidate its data pointer. ARC-reference rebinding is not
implemented. Non-throwing
direct-awaited `out` parameters may initialize cleanup-free caller storage and
must do so on every successful path; spawned and ownership-bearing output remain
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

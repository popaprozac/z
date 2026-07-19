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
forwarded, captured, returned again, or held across `await`. Its owner cannot
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

Compiler-provided `Option<T>` and `Result<T, E>`, ARC class fields, owned closure
environments, and async frames still reject move-only native storage until their
distinct non-trivial construction paths land.

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

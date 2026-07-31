# Interop Model

The language's primary interop syntax is intentionally ordinary:

```z
import sqlite from "sqlite3.h";
```

The module name provides a Z namespace while generated native calls remain
direct:

```z
sqlite.sqlite3_libversion();
```

The compiler parses supported headers with Clang and represents declarations,
layouts, safely modeled macros, overloads, calling conventions, availability,
and source locations in a cached foreign module. Unsupported shapes remain
explicit and fail closed rather than relying on a generated-call error as the
first type check.

The reverse direction has a separate accepted design:
`export c function` deliberately publishes a Z implementation through a stable
C ABI, generated header, and native library artifact. That syntax is not
executable yet; its scalar-first boundary and ownership growth path are recorded
in [the C export design](c-exports.md).

Headers do not reliably encode ownership or asynchronous callback contracts.
Packages can therefore ship adjacent `.zd` declarations without modifying
upstream headers.
The toolchain producer first records raw native declarations; a separate
normalizer applies API-note facts and emits the FIIR used by the compiler and
editor. Disjoint metadata sources compose, while malformed, unmatched, or
contradictory safety contracts fail with `Z0801`. API-note edits participate in
the importer cache key, so language-server analysis does not retain stale
ownership contracts. Unannotated declarations remain visible, but operations
whose safety cannot be established retain an explicit unsupported type rather
than gaining a guessed Z signature.

Native declaration locations and availability survive the same normalization
boundary. Go-to-definition opens project headers, SDK interfaces, and generated
Swift compatibility headers. Explicitly unavailable declarations fail at the Z
use site with `Z0802` and a related native location. When `z.json` explicitly
supplies `target.platform` and `target.minimumVersion`, introduced and obsoleted
versions also produce `Z0802`, while applicable deprecations produce the
nonfatal `Z0804` warning. The same minimum reaches Clang header import, generated
native compilation, and local Swift compilation. With no explicit target, the
bootstrap preserves version metadata but does not invent a deployment target.
Runtime availability guards are not yet synthesized.

The Clang producer also runs the preprocessor in declaration-preserving mode for
the requested header. Active object-like integer-literal macros defined directly
by that header become typed constants:

```z
import sqlite from "sqlite3.h";
import { SQLITE_DONE as done } from "sqlite3.h";

const row: i32 = sqlite.SQLITE_ROW;
if (status == done) { ... }
```

Their Z type follows the target's C integer-literal rules, generated source uses
`SQLITE_ROW` or `SQLITE_DONE` directly, and editor definitions return to the
`#define`. This tier intentionally excludes function-like macros, string
macros, aliases, and general expressions. Those require separate decisions
about evaluation, safety, and whether they should appear as constants,
functions, or `comptime` facilities.

C++ namespace paths also survive normalization. A uniquely named function can
use its short module alias, while the native hierarchy is available explicitly:

```z
import cpp from "cpp_math.hpp";

const moved = cpp.zcpp.translate(origin, 1, -1);
const point: cpp.zcpp.Point = cpp.zcpp.Point({ x: 20, y: 22 });
const answer = cpp.scale(6, 7); // unique short alias; selects the i32 overload
```

A native C++ namespace can be selected and locally aliased without flattening
its members:

```z
import { zcpp as math, alpha as left } from "cpp_math.hpp";

const point = math.Point({ x: 20, y: 22 });
const moved = math.translate(point, 1, -1);
```

This is a compile-time name binding. Calls still lower directly to
`zcpp::translate`, with no namespace wrapper or dispatch cost.

Functions and named types follow the same rule: if two namespaces export the
same leaf name, Z omits the short alias and requires the qualified path. Every
overload retains its own full contract and source location. `Z0803` reports
calls for which no candidate is viable or more than one best candidate remains;
declaration order is never a tiebreaker.

Opaque C++ values can carry an adjacent lifecycle contract without repeating
their native layout:

```z
declare module "library.hpp" {
  export type zcpp.ManagedValue {
    copy;
    deinit;
  }
}
```

`type` refers to the existing Clang declaration. `copy`, `move`, and `deinit`
are capabilities rather than function calls; omission denies a capability, and
`.zd` cannot grant an operation Clang cannot prove. `copy + deinit` uses direct
C++ copy construction and assignment. `move + deinit` is single-owner storage:
Z diagnoses use after transfer and C++ receives `std::move` at owned bindings,
calls, and aggregate construction. Native lexical destruction handles both the
destination and the valid moved-from source storage; no wrapper allocation or
Z destructor dispatch is added.

Native ownership does not imply cross-thread safety. An adjacent declaration
must state that separately:

```z
declare module "library.hpp" {
  export type zcpp.UniqueValue {
    move;
    deinit;
    thread {
      transfer;
      deinit;
    }
  }
}
```

The outer `move` and `deinit` describe ordinary value lifetime. Inside
`thread`, `transfer` says one unique owner may move to another thread and
`deinit` says its destruction is safe there. The same block may follow the
`deinit close;` result contract of an owned C handle producer. These are trusted
native facts: Z verifies their shape and enforces them, but cannot prove a
vendor library's thread guarantees from its ABI. The first executable tier
requires both facts and supports move-only C++ RAII values plus owned C handles.
`share` is reserved and parsed for a future retained/shared native identity; it
is rejected at `thread.spawn` until a concrete retain/release representation is
available.

The move-only tier covers direct synchronous locals, owned parameters and
returns, whole Z value structs, dynamic arrays, named enum payloads, and
compiler-provided `Option<T>`/`Result<T, E>` payloads. A direct native value or
whole Z value aggregate containing one may also survive an async suspension.
Its task frame uses aligned raw storage, placement construction, a semantic live
flag, and deterministic cleanup. Transfer move-constructs the destination and
ends the moved-from C++ object's lifetime before releasing raw frame storage.
Infallible async functions may return these values; task results move through
`return`, `return await`, and a caller's awaited binding without default
construction or an extra wrapper allocation. Unclaimed completed results are
destroyed during cancellation. Fallible native tasks transfer through `try
await`; `attempt await` constructs a non-trivial Result in named or hidden frame
storage and match either borrows or consumes its active payload. Owned async
parameters use the same aligned storage: task creation move-constructs each
child-frame slot, and cancellation destroys it even before the child body is
polled. Immutable `in` native values and native-owning Z aggregates borrow stable
caller-frame storage through direct await. Child-task borrows require an explicit
async scope and prevent owner mutation or movement until every borrowing child
joins; no wrapper, retain, or copy is added. Direct-awaited and scope-bounded
child-task `inout` native values similarly use a mutable pointer into the suspended
caller frame; no native copy or move occurs, and the child does not destroy the
owner. An explicit consuming join releases the borrow before scope exit.
Cleanup-free `out` values can use the same direct-await storage path;
ownership-bearing and child-task output still need explicit live-storage handoff
lowering. ARC class fields and owned closure environments likewise remain
deferred.

C++ named-value references map onto the existing Z capability model:

| C++ boundary | Z call shape | Effect |
| --- | --- | --- |
| `const T&` | `native.read(value)` | Call-scoped immutable borrow |
| `T&` | `native.update(inout value)` | Call-scoped mutable borrow; requires initialized `let` storage |
| move-only `T&&` | `native.consume(value)` | Ownership transfer; later source use is rejected |
| method `const &` | `value.read()` | Borrowed receiver |
| method `&` | `value.update()` | Mutable receiver; requires `let` |
| move-only method `&&` | `value.finish()` | Consuming receiver; later source use is rejected |

These calls lower directly to lvalue references or `std::move`; there is no
reference wrapper or dispatch layer. A C++ reference does not prove that native
code will avoid storing it, so the callee remains part of the trusted FFI
boundary. Returned references and capability-changing argument or receiver
overload sets are rejected until Z has explicit lifetime and overload-selection
designs.

Clang-proven public constructors plus static and instance methods on those values
are callable directly. A native value constructor uses `Type(args)` rather than
`new Type(args)`: `new` remains Z's signal for ARC-managed class identity, while
the C++ result is an ordinary owning value. Static methods use
`Type.method(args)`. Const instance methods borrow (`in`) the receiver, while
non-const methods require a mutable, addressable (`inout`) Z owner. All overloads
retain their native signatures, source definitions, and availability metadata,
and lower as direct C++ calls without generated wrappers. Copy/move constructors
remain ownership operations rather than an overloaded source-level constructor
surface. Reference returns, copyable rvalue references, conversions, and
templates are not yet part of this slice.

Swift-generated C++ value interfaces feed the same FIIR path. Z currently calls
generated static factories and const or mutable scalar instance methods directly;
the receiver rules and cost model are identical to the C++ rows above. This
proves behavior on a Swift-owned value, but does not yet infer Swift property
syntax or cover generics, protocols, errors, async, or package products. A
generated `swift::String` return can initialize an explicit Z `String`, producing
a fresh length-aware UTF-8 copy. Swift `String` parameters remain unsupported
until the generated boundary can accept an explicit byte length rather than a
null-terminated input.

Swift associated-value enums use the same owned-value path. Their generated C++
case objects are imported as namespaced factories, so
`Swift.LoadState.ready(42)` constructs the Swift value directly and ordinary Z
copy/cleanup rules govern the generated wrapper. The importer recognizes this
shape only in Swift-generated compatibility headers; it does not reinterpret
arbitrary C++ callable objects as static methods.

The FIIR thread contract is producer-neutral. A future direct Swift importer can
map Swift `Sendable`, consuming/noncopyable ownership, and actor isolation into
the same transfer/share/destruction facts rather than treating generated C++
movability as proof. Swift 6.2's generated C++ interface currently marks both
noncopyable values and Swift `async` functions unavailable; a regression fixture
records that toolchain gate. Public generated interfaces and compiler-generated
Swift bridge targets remain the default paths. Direct Swift ABI lowering is a
reserved escalation path if real application pressure makes full compatibility
urgent; taking it would require an explicit stability and maintenance decision
around resilient layouts, value witnesses, async calls, actors, and runtime
versions rather than quietly treating private ABI as ordinary FIIR.

## Cost model

Z's target is **no interop tax beyond the semantics requested at the
boundary**, not a claim that every bridge operation is free:

| Boundary shape | Intended/generated cost |
| --- | --- |
| C scalar or function call | Native ABI call; no wrapper or allocation |
| C record by value or scoped borrow | Native layout and calling convention; no wrapper allocation |
| Objective-C method or property | Ordinary `objc_msgSend`-family dispatch under Clang ARC |
| `objc.connect` target/action bridge | One ARC connection allocation, indirect closure call, and an owned environment allocation only when the closure captures; the connection retains the native control |
| Z-defined Objective-C protocol conformance | One ARC adapter allocation per distinct bound Z controller; selector dispatch forwards directly to generated Z method functions |
| `objc.bind` weak protocol properties | One ARC binding token plus adapter array; retains the native object, adapters, and Z controllers for the token lifetime |
| Plain C++/Swift-C++ value or method | Native construction, copy, destruction, and member-call rules; no Z wrapper dispatch |
| Non-capturing call-only callback | Function pointer or small adapter indirection; no environment allocation |
| Escaping capturing closure / Objective-C block | Owned closure environment plus a native lifetime adapter, retains/releases, and indirect invocation |
| `String` / `NSString` ownership bridge | Deliberate allocation and byte copy so neither runtime borrows unstable storage |
| Swift `String` return to explicit Z `String` | Swift overlay traversal plus one owned allocation and exact byte copy; embedded NUL preserved |
| Logging an `NSString` | Reads its UTF-8 bytes for the duration of the console call; no Z `String` allocation |
| Z ARC class reference | Retain/release traffic; the bootstrap runtime is non-atomic and not yet optimized |

An eventual explicit foreign contract uses an ambient module declaration:

```z
declare module "vendor.h" {
  export function vendor_version(): i32;
}
```

`declare` describes a surface implemented elsewhere; it does not itself bind a
local name. Ordinary namespace or selective `import` syntax consumes the module.
For an available header, the declaration augments the raw Clang interface and
must agree with every verifiable ABI fact. A future binary-only declaration may
carry explicit ABI and library metadata. Supplying a declaration is distinct
from accepting an unverified memory-safety obligation: unsafe functions and raw
operations still require a separate `unsafe` boundary. Inline declarations,
adjacent `<header>.zd` Z declaration files, and built-in toolchain contracts
feed the same normalizer and FIIR. `.zd` is the sole project-authored foreign
contract format.

`unsafe { ... }` is the middle trust tier. It remains ordinary Z source, but
permits a local unverified interpretation of native pointer data:

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

The annotation on `version` asserts that the native character pointer is
readable NUL-terminated text. An unsupported pointer without a compatible
context becomes an opaque scope-local identity. It may compare with null and
pass only to a native parameter with the exact same normalized pointer
spelling. It has no members, indexing, dereference, arithmetic, ownership, or
implicit cleanup, cannot pass through an ordinary Z function, and cannot leave
the block. Exact matching native calls remain available, while
`String.from(value)` is the explicit owned-copy boundary for an asserted
`cstring`. This first tier rejects
nesting, async functions, suspension, generators, and closure construction. It also
rejects unsupported by-value layouts rather than exposing generated C names.

Imported C unions have ABI-preserving native storage and may be initialized
through a checked `.zd` `out Union*` contract. Reading a member is still a local
proof obligation because a C union carries no active-member tag. After checking
the native API's discriminator, `unsafe` may copy a supported scalar or enum
member into ordinary Z code. Pointer and nested-record members remain excluded
until a reusable checked projection describes their lifetime and active-member
rules.

The expression form uses Z's ordinary value-block rule: `select` supplies the
unsafe expression's value, while `return` still exits the enclosing function.
Only a safe result may be selected. Representable scalars and independently
owned copies such as `String.from(borrowedCString)` may leave; asserted native
identity or borrowed native storage may not.

Unsafe code accepts the proof obligation locally; it does not turn off ordinary
Z ownership or type checking. Reusable ownership, nullability, cleanup,
callback, or threading facts still belong in `.zd`.

Pointer-bearing native records passed by value are not an unsafe-pointer
special case. Checked Z admits them only after `.zd` classifies the canonical
record as a move-only resource, names its C release function, and classifies
each producer as `owned` or `borrowed`. The bytes and calling convention remain
native. Uncontracted records remain rejected in checked and `unsafe` Z; a
one-off operation can still use `raw`.

Borrowed value-resource results are lexical and non-escaping in the first
tier. This closes double-cleanup without pretending Z knows a global runtime
lifetime such as raylib's window/graphics context. Future `lifetime` facts may
relax that wall by tying borrowed records to an explicit owner.

Raw native source is the final escape hatch when an API cannot be represented
as a Z call even with `.zd` facts. The anonymous form is an immediately applied
generated helper, never an inline statement expression:

```z
const status = raw c
  using (in input, inout state, out result)
  : i32 {
    *result = native_operation(input, state);
    return *result;
  };
```

The helper boundary makes native `return` local, prevents access to undeclared
lexical Z values, and preserves enclosing Z cleanup. `out` initializes its
mutable Z binding on successful helper return. Tier 1 accepts only ABI-stable
scalars, `cstring`, and imported native types; `move` operands and Z-owned
representations are rejected.

A whole function can use native source without repeating its declared
contract:

```z
function nativeCount(input: i32): i32 = raw cpp {
  return static_cast<int32_t>(input);
}
```

`raw objc` may be combined with `on thread.main`. Async, throwing, generic, and
method raw bodies remain outside the first tier. Clang diagnostics are mapped
back to the raw source location. Until helpers move to separate translation
units, embedded identifiers are compared with the symbols this compilation
actually emits. A real generated symbol is rejected, while unrelated native
names such as zlib's `Z_OK`, `Z_FINISH`, and `Z_STREAM_END` remain usable.
Prefer header imports and `.zd`; raw code receives no Z safety proof inside the
body.

The first `.zd` slice augments Clang declarations without repeating their ABI
types. `_` means "use the header-derived type," while ordinary Z capabilities,
nullability, and `deinit` describe the missing safety facts:

```z
declare module "vendor.h" {
  export function vendor_open(path: _): _ | null {
    deinit vendor_close;
    thread {
      transfer;
      deinit;
    }
  }
  export function vendor_close(move handle: _): _;
  export function vendor_use(in handle: _): _;
  export function vendor_optional(in handle: _ | null): _;
  export function vendor_position(out x: _, out y: _): _;
  export function vendor_create(
    out handle: _ | null {
      deinit vendor_close;
    }
  ): void throws _ {
    success 0;
  }
}
```

For a native `float *` parameter, `in`, `inout`, or `out` asserts that the
pointer addresses one call-scoped scalar rather than an array. Clang continues
to supply the exact `f32` pointee type. `out` accepts uninitialized mutable
storage and makes it readable only after the native call returns; `inout`
requires an initialized mutable binding; `in` borrows one initialized stored
scalar. All three lower directly to the caller storage address.

The declaration is not a wrapper or implementation. `in`, `move`, and `| null`
retain their ordinary Z meanings. A function contract block is declarative,
not executable; associating `deinit vendor_close` with the result implies
ownership and deterministic release of each non-null value. Functions without
additional contracts end in `;`. The function names, parameter order, and
parameter names must match Clang's raw interface. The module specifier is
resolved relative to the declaration file, so one canonical header contract
works whether importing Z code reaches the header through a local,
parent-relative, or project-relative spelling. `.zd` facts conflict-check with
built-in toolchain facts. General explicit ABI types remain a later
declaration-file slice. Three narrow semantic refinements are available now:
`parameter: null` exposes only the null value of an otherwise unsupported
native pointer parameter, while `view cstring | null` classifies a native
character-pointer result as nullable borrowed NUL-terminated text tied to the
function's single borrowed pointer input. A parameter-local `fixed NAME;`
contract keeps a real native ABI parameter in the declaration while omitting it
from the Z call surface and supplying that header constant during code generation:

Executor affinity is also producer-neutral FIIR metadata. Explicit Clang actor
attributes are imported automatically. A Swift-generated Objective-C header
does not preserve source `@MainActor`, so declared Swift targets additionally
emit a structured Swift symbol graph; Z maps its Objective-C runtime identities
back onto the Clang declarations before FIIR normalization. `.zd` supplies the
same fact for external or legacy surfaces whose toolchain metadata is
unavailable:

```z
declare module "LegacyUI.h" {
  export type LegacyWindow on thread.main;
  export function LegacyWindow.refresh(): _ on thread.main;
}
```

An isolated native type makes construction, member access, calls, cleanup, and
containing Z aggregates main-affine. A function or method annotation isolates
only that operation. These checks compile away: generated code still performs
the original native call directly.

```z
declare module "sqlite3.h" {
  export function sqlite3_prepare_v2(
    in db: _, in zSql: _, nByte: _,
    out ppStmt: _ | null { deinit sqlite3_finalize; },
    pzTail: null
  ): void throws _ {
    success 0;
  }
  export function sqlite3_column_text(
    in pStmt: _, iCol: _
  ): view cstring | null;
  export function sqlite3_bind_text(
    in pStmt: _, i: _, in zData: _, nData: _,
    xDel: _ { fixed SQLITE_TRANSIENT; }
  ): _;
}
```

The null-only form emits the native null pointer and rejects every non-null Z
argument. A borrowed text result must be narrowed before `String.from` copies
it, cannot outlive its native owner, and prevents that owner from being moved
or finalized while the view is live. `fixed` accepts a header-defined
identifier, not an arbitrary expression; the parameter name and position still
must match Clang, and Z callers cannot override it. These are semantic safety contracts; the
header remains the ABI authority. Callback lifetime, context, release, and
explicit `thread caller` or `thread any` contracts are also supported now.

`void throws _` is the narrow status-code projection. It is valid only when
Clang proves an integer native return. Each `success N;` lists one successful
native status; every other value becomes the original integer error. No wrapper
function, heap exception, or ABI conversion is emitted. Z calls must acknowledge
the fallibility with `try` or `attempt`. When the same native call initializes
an owned `out` parameter, that output is marked live before the status is
propagated, so failure cleanup cannot leak a produced native owner. APIs such as
`sqlite3_step`, whose nonzero statuses are useful outcomes rather than ordinary
failures, remain raw integer calls.

Application authors should not normally write one `.zd` per import. The common
case remains header-only import. Platform metadata, package-shipped contracts,
Clang attributes, Apple API notes, and Windows SAL should populate the same
normalized facts. Project-local `.zd` is the deliberate fallback for legacy
APIs whose ownership or sentinel conventions are absent from their C types; it
is written once beside the native package rather than repeated by each source.

An `out` parameter contract may carry its own block when a native `T **`
function initializes an owned handle. `deinit vendor_close` then describes the
produced `T *`, not the pointer-to-pointer ABI parameter. At a call site,
`let handle;` is permitted only for this kind of typed `out` initialization:

```z
let handle;
try vendor.vendor_create(out handle);
if (handle == null) return 1;
vendor.vendor_use(handle);
// vendor_close(handle) is emitted on exit.
```

The same contract makes an opaque C typedef source-nameable through the import
namespace. If the produced native value is `VendorHandle *`, its non-null type
is `vendor.VendorHandle`; `vendor.VendorHandle | null` is the nullable form.
This permits persistent ownership without exposing raw pointer syntax:

```zs
class Client {
  private handle: vendor.VendorHandle;

  constructor() throws i32 {
    let handle;
    try vendor.vendor_create(out handle);
    if (handle == null) throw -1;
    this.handle = move handle;
  }
}
```

ARC teardown of `Client` invokes the handle's declared release operation.
Native pointer identity and ownership remain compiler facts behind the readable
type name.

The enclosing `declare module "vendor.h"` already establishes the native
authoring scope. No import is needed inside the `.zd` file to complete, hover,
or navigate `vendor_close`; imports are reserved for a future need to reuse Z
declaration abstractions across contract files.

The language server reads the same header while editing a `.zd` file. It can
complete native function and parameter names, filter result and out-parameter
`deinit` candidates by the produced native type, and show the Clang-resolved
signature behind each `_` on hover. It also explains compiler-supplied `fixed`
parameters and inferred status-error types without exposing them as Z call
arguments. These are authored contracts with native
context rather than a second, manually synchronized copy of the header surface.

Imported nullable references use the same one-pointer representation as their
native ABI. A Z null check is an ordinary pointer comparison and narrows the
reference statically; the first reference specialization uses `T | null` in
source and does not allocate a tagged `Option` wrapper. The language model treats
this as niche-backed optionality. `Option.fromNullable` exposes that same value
through `some`/`none` matching. `Option<ObjC reference>` and
`Option<declared C handle>` remain one pointer, use `nil` or `NULL` as `none`,
and require neither a wrapper allocation nor a separate tag. A consuming match
transfers a declared handle's cleanup responsibility to the `some` binding; a
borrowed match leaves it with the Option. General `Option<T>` keeps its
tag-plus-payload representation when no safe niche is known.

The bootstrap `z run` path currently asks Clang for a debuggable native build
without an optimization flag. Its runtime measurements therefore validate
behavior, not Z's eventual optimized performance ceiling. Release profiles,
retain/release optimization, escape analysis, and generated-code benchmarking
remain compiler work.

The first callback tier uses `in` to state that the native function borrows a
callback only for the duration of the call:

```z
declare module "callbacks.h" {
  export function z_apply_i32(
    left: _,
    right: _,
    in callback: _
  ): _;
}
```

Clang supplies the function pointer's exact parameter and result ABI. The
contract supplies the fact the header omits: C does not retain the callback
after the call returns. The meaning is type-directed: `in` on a native pointer
is a read-only borrow, while `in` on a native callback is a call-scoped borrow.
Z can therefore pass a named function or explicitly typed non-capturing closure
directly with no allocation or wrapper. A callback without this contract remains
unsupported.

When the native API pairs a callback with a `void *` context parameter, the
function contract names that relationship:

```z
declare module "callbacks.h" {
  export function applyWithContext(
    value: _,
    context: _,
    in operation: _
  ): _ {
    callback operation {
      context context;
      invoked once;
    }
  }
}
```

The first name after `callback` is the native callback parameter; the name after
`context` is its paired native context parameter. Z infers the inner callback
position when the function-pointer signature contains exactly one `void *`.
Zero or multiple candidates are rejected rather than guessed. The generated
trampoline casts the native context back to the borrowed Z function value and
invokes its `call` entry with the owned environment. Since the lifetime is
call-only, the caller keeps the ARC owner alive and no native retain/release
protocol is invented.

The first escaping tier requires the C API to accept a destroy callback and
declares the full ownership relationship in the same block:

```z
declare module "callbacks.h" {
  export function retainOperation(
    move operation: _,
    context: _,
    release: _
  ): _ {
    callback operation {
      context context;
      deinit release;
      thread caller;
      invoked repeatedly;
    }
  }
}
```

`move` is type-directed here: for a native callback it means the API retains an
owned callback adapter beyond the call. `deinit` names the native release
parameter and `thread caller` limits invocation and release to the registering
thread. Z retains the function value in a stable heap box and passes generated
callback and release thunks; the context and release parameters disappear from
the Z call surface. The local ARC function value can then leave scope while C
owns its retained reference. C must take ownership unconditionally, invoke both
callbacks only on the registering thread, call release exactly once after the
final invocation, and never invoke the callback afterward. Those requirements
are a trusted foreign contract, just like pointer ownership API notes.

An API that may invoke or release the callback from arbitrary native threads
uses the stronger contract:

```z
callback operation {
  context context;
  deinit release;
  thread any;
  invoked repeatedly;
}
```

`thread any` conservatively permits overlapping invocations. Z therefore emits
atomic closure-environment ownership and accepts only captures proven safe for
concurrent read-only sharing. The first tier includes primitives, owned
immutable `String` snapshots, and deeply readonly Z ARC identity. Mutable or
borrowed captures, `Weak<T>`, views, slices, and native values without a
compatible sharing contract are rejected.

A callback whose native ABI returns a status can opt into typed Z failure:

```z
callback visitor {
  context context;
  failure 1;
  invoked repeatedly;
}
```

The Z function value retains the real native return type and may declare
`throws E`. An ordinary return passes directly to C. On `throw`, the adapter
destroys the `E` payload and returns native `1`. This narrows a richer Z error
into C's status channel: an enclosing native operation may surface the failure
fact, but the original payload never reaches a Z handler. For hot repeated
callbacks, cleanup-free error payloads avoid constructing owned data that the
ABI boundary must immediately destroy.

Generated Swift Objective-C headers expose escaping closures as ARC-owned
blocks, so they need neither an explicit context parameter nor a destroy
callback. A qualified `.zd` entry adds only the fact the header cannot prove:

```z
declare module "ZSwiftTaskScope-Swift.h" {
  export function ZSwiftBackgroundWorker.calculate(
    value: _,
    move completion: _
  ): _ {
    callback completion {
      thread any;
      invoked once;
    }

    async completion;
  }
}
```

The class, static selector, parameter names, and block ABI remain Clang-derived.
The callback contract makes a raw closure environment atomic and checks its
captures; the copied native block retains and releases that environment through
Objective-C ARC. For `thread any`, its generated invocation and deallocation
paths enter the active Z runtime captured at registration. A raw user callback
may therefore retrieve a synchronized `Once<T>` root, use `Mutex<T>`, and
submit joined work through `TaskScope`; direct main-isolated access remains a
compile-time error. `invoked once` separately promises exactly-one terminal
delivery, while `async completion;` requests the Task projection. The
synthesized completion block writes only its owned task frame and wakes that
task's executor; the raw callback overload remains available for user-authored
callback behavior. Z synthesizes
`async calculate(value: i32): i32`, usable with either `await` or `task`.

The projected task owns its callback frame until completion. Cancellation
without a native cancellation hook requests cancellation but still waits for
the callback before destroying that frame. A duplicate completion traps before
re-entering completed task storage. If native code never invokes a callback
declared `invoked once`, the task remains pending indefinitely; the declaration
is a trusted behavioral contract, not a fact Clang can prove. A value/error
completion names both callback positions explicitly:

```z
async completion(value, error) {
  return value;
  throw error;
}
```

When the nullable Objective-C error is non-null, the generated task completes
as `Task<T, E>` failure; otherwise it transfers the scalar value as success.
`try await` propagates the owned error and `attempt await` materializes
`Result<T, E>`. The first executable tier supports static methods, cleanup-free
scalar success values, and ARC-owned Objective-C errors. Instance methods,
ownership-bearing success values, and native cancellation hooks remain future
tiers.

An arbitrary-thread callback does not itself create an unowned root task.
Instead, the implemented `TaskScope` bridge owns callback-created operations,
rejects submissions that lose the race with close, and joins accepted work.
`async scope updates {}` exposes the same handle with lexical automatic close;
`new TaskScope()` exposes the manual API. A callback may place either a
synchronous nonthrowing operation or an explicitly async, nonthrowing root on
`thread.main`. The async form can await and own `thread.spawn` children; it
handles fallible work locally because submission returns a non-joining
`TaskControl`, not a result-bearing task. The control exposes the
accepted-versus-closing race and per-operation cancellation while the scope
keeps join ownership. Repeated callback APIs may later
synthesize an async sequence:

```z
const events = native.watchEvents();

try for await (const event of events) {
  await on thread.main {
    display(event);
  }
}
```

Such synthesis requires declaration facts for callback cardinality, completion,
errors, cancellation, buffering, and release. It is an intended destination,
not semantics inferred from an ordinary callback signature.

Objective-C APIs that return a separate observer token already use that native
token directly: an owned `move` block may persist across calls, Z keeps the
token, and source code explicitly unregisters it. Weak capture prevents the
block from strongly cycling back to ARC-managed application state. The AppKit
observer probe remains caller-thread/AppKit-executor work. The arbitrary-thread
C and Swift-block tiers now prove atomic ARC environment ownership,
conservative capture shareability, TaskScope-based main-executor delivery, and
exactly-once Swift/Objective-C callback-to-task synthesis, including nullable
Objective-C errors projected into owned `Task<T, E>` failures. Typed scope
errors, conditional C ownership transfer, instance block contracts,
ownership-bearing callback values, and native cancellation hooks still require
richer metadata.

## Direct Objective-C imports versus `std/objc`

The default Objective-C experience remains header-first. Importing AppKit is
enough for ordinary nominal types, class and instance methods, properties,
constants, nullability, ARC identity, and block parameters:

```z
import AppKit from "AppKit/AppKit.h";

const app = AppKit.NSApplication.sharedApplication;
const window = AppKit.NSWindow.alloc().initWithContentRect(
  AppKit.NSMakeRect(0.0, 0.0, 800.0, 600.0),
  styleMask: AppKit.NSWindowStyleMaskTitled,
  backing: AppKit.NSBackingStoreBuffered,
  defer: false,
);
window.title = "Z Notes";
```

`std/objc` is the explicit bridge layer for runtime conventions that a header
cannot express as an ordinary typed call. The first such convention is
target/action: AppKit exposes a weak target object plus a `SEL`, while Z source
wants an owned closure with a clear lifetime.

```z
import objc from "std/objc";
import AppKit from "AppKit/AppKit.h";

const saveConnection = objc.connect(button, move () => {
  saveDocument();
});
```

`objc.connect` allocates one ARC-managed connection object, retains the native
control, and installs itself as the control's weak target. A capturing `move`
closure also owns its normal Z closure environment; non-capturing operations do
not allocate a separate environment. The generated connection binding uses
Objective-C precise lifetime, so it remains alive through the end of its Z
scope. On destruction it clears target/action if still installed, then releases
the closure and control. Source must keep the returned `objc.Connection` bound
for as long as callbacks are desired; discarding it is a compile error.

The Clang importer preserves Objective-C property ownership such as `weak`,
`strong`, `copy`, and `assign`, and editor hover/completion displays it. General
escape analysis for arbitrary weak or unsafe-unretained property assignments is
still a future safety layer; `objc.connect` closes the common target/action
lifetime hole without requiring implicit native associations or retain cycles.

Z-defined classes can implement imported Objective-C protocols. A method's
`as "selector:"` clause is checked against the Clang-imported requirement and
lowered into a generated `NSObject<Protocol>` adapter. The Z class itself
remains a Z ARC allocation; it is not silently changed into an Objective-C
class.

Protocol properties such as `NSTableView.dataSource` and `.delegate` are
zeroing `weak`. `objc.bind(object, { property: controller })` installs generated
adapters and returns an owned `objc.Binding` token that keeps the native object,
adapters, and Z controllers alive. The current adapter rejects `assign` and
`unsafe_unretained` protocol storage because releasing its adapter could leave a
dangling native pointer. This closes the common delegate/data-source lifetime
seam without forcing ordinary Objective-C calls through `std/objc`.

| Native surface | Ordinary header import | `std/objc` bridge |
| --- | --- | --- |
| `NSApplication.sharedApplication`, `NSWindow.alloc()`, methods/properties | Yes | No |
| Objective-C object nullability and `Option.fromNullable` | Yes | No |
| Typed block parameters and observer tokens | Yes | No |
| Target object plus selector pair | Header exposes the raw convention | `objc.connect` owns the control and closure, installs target/action, and returns an explicit lifetime token |
| Protocol/delegate synthesis | Protocol and weak property declarations remain visible | `implements`, `as "selector:"`, and `objc.bind` generate and own the native adapter |

This module is not a prerequisite for Objective-C interop and is not a generic
escape hatch for message sending. If Clang can import a declaration with enough
type and lifetime information, Z should continue to call it directly.

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

The bootstrap compiler treats an imported module member as a native symbol and
lets Clang validate the generated call. The production importer must instead
parse headers with Clang and represent declarations, layouts, macros that can be
modeled safely, overloads, calling conventions, availability, and documentation
in a cached foreign module.

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
use site with `Z0802` and a related native location. Introduced, deprecated, and
obsoleted versions are preserved for hover and future target checks; the
bootstrap does not compare them against an invented deployment target.

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
`.zd` cannot grant an operation Clang cannot prove. The current executable tier
supports `copy + deinit`: C++ copy construction and assignment remain direct,
and native lexical destruction handles values stored in Z aggregates. FIIR can
record native move availability, but move-only foreign values remain rejected
until dedicated move lowering lands.

## Cost model

Z's target is **no interop tax beyond the semantics requested at the
boundary**, not a claim that every bridge operation is free:

| Boundary shape | Intended/generated cost |
| --- | --- |
| C scalar or function call | Native ABI call; no wrapper or allocation |
| C record by value or scoped borrow | Native layout and calling convention; no wrapper allocation |
| Objective-C method or property | Ordinary `objc_msgSend`-family dispatch under Clang ARC |
| Plain C++/Swift-C++ value | Native construction, copy, and destruction rules |
| Non-capturing call-only callback | Function pointer or small adapter indirection; no environment allocation |
| Escaping capturing closure / Objective-C block | Owned closure environment plus a native lifetime adapter, retains/releases, and indirect invocation |
| `String` / `NSString` ownership bridge | Deliberate allocation and byte copy so neither runtime borrows unstable storage |
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

The first `.zd` slice augments Clang declarations without repeating their ABI
types. `_` means "use the header-derived type," while ordinary Z capabilities,
nullability, and `deinit` describe the missing safety facts:

```z
declare module "vendor.h" {
  export function vendor_open(path: _): _ | null {
    deinit vendor_close;
  }
  export function vendor_close(move handle: _): _;
  export function vendor_use(in handle: _): _;
  export function vendor_optional(in handle: _ | null): _;
}
```

The declaration is not a wrapper or implementation. `in`, `move`, and `| null`
retain their ordinary Z meanings. A function contract block is declarative,
not executable; associating `deinit vendor_close` with the result implies
ownership and deterministic release of each non-null value. Functions without
additional contracts end in `;`. The function names, parameter order, and
parameter names must match Clang's raw interface. The module specifier is
resolved relative to the declaration file, so one canonical header contract
works whether importing Z code reaches the header through a local,
parent-relative, or project-relative spelling. `.zd` facts conflict-check with
built-in toolchain facts. Explicit ABI types remain a later declaration-file
slice; callback lifetime, context, release, and caller-thread contracts are
supported now.

The language server reads the same header while editing a `.zd` file. It can
complete native function and parameter names, filter `deinit` candidates by the
returned native type, and show the Clang-resolved signature behind each `_` on
hover. These are authored contracts with native context rather than a second,
manually synchronized copy of the header surface.

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

Objective-C APIs that return a separate observer token already use that native
token directly: an owned `move` block may persist across calls, Z keeps the
token, and source code explicitly unregisters it. Weak capture prevents the
block from strongly cycling back to ARC-managed application state. The current
probe remains caller-thread/AppKit-executor work; cross-thread callbacks still
wait for atomic ARC and sendability rules. Conditional C ownership transfer and
callback-to-async synthesis additionally require completion cardinality,
cancellation, executor, and release metadata.

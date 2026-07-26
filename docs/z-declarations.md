# Z declaration files (`.zd`)

Z imports ABI declarations from the real C, Objective-C, C++, or generated Swift
header. An adjacent `.zd` file adds semantic facts that the header and Clang AST
cannot prove: ownership, borrowing, cleanup, hidden sentinel arguments, status
errors, callback lifetime, and thread transfer.

A `.zd` file is not a duplicate header and cannot invent a native declaration.
Every named function, type, parameter, callback, context, release operation, and
constant is checked against the imported header before it reaches semantic
analysis.

For:

```z
import sqlite from "sqlite3.h";
```

the project-local contract is `sqlite3.h.zd` next to the importing source:

```z
declare module "sqlite3.h" {
  // semantic additions only
}
```

Qualified includes may use either a mirrored path or the adjacent header
basename. For `import curl from "curl/curl.h"`, Z first checks
`curl/curl.h.zd` and then the much more convenient adjacent `curl.h.zd`.
The `declare module "curl/curl.h"` string still identifies the exact header and
prevents a same-basename contract from attaching to the wrong import.

The enclosing `declare module` is already the authoring scope. No import is
required inside the `.zd` file; the editor loads that header for completion,
hover, and validation. `z check path/to/header.h.zd` performs the same ABI
validation against the real header rather than checking grammar alone.

## Complete current shape

```z
declare module "vendor.h" {
  export type NativeValue on thread.main {
    move;
    deinit;
    thread {
      transfer;
      deinit;
    }
  }

  export function vendor_open(
    out handle: _ | null { deinit vendor_close; },
    flags: _,
    sentinel: _ { fixed VENDOR_DEFAULT; }
  ): void throws _ {
    success VENDOR_OK;
  }

  export function vendor_position(
    out x: _,
    out y: _
  ): _;

  export function vendor_setopt(
    in handle: _,
    option: VENDOR_OPTION_TEXT,
    in text: cstring
  ): void throws _ {
    success VENDOR_OK;
  }

  export function vendor_visit(
    in operation: _,
    context: _
  ): _ on thread.main {
    callback operation {
      context context;
      invoked repeatedly;
    }
  }

  export function vendor_observe(
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

  export function vendor_hash(
    in data: _,
    length: _
  ): _ {
    project input: Slice<u8> {
      data data;
      length length;
    }
  }

  export function vendor_setopt(
    in owner: _,
    option: VENDOR_WRITE,
    move write: _
  ): connection throws _ {
    success VENDOR_OK;

    callback write {
      type VendorWriteCallback;
      context option VENDOR_CONTEXT;
      owner owner;
      project bytes: Slice<u8> {
        data buffer;
        length size * count;
      }
      failure VENDOR_WRITE_ERROR;
      thread caller;
      invoked repeatedly;
    }
  }

  export function ZVendorWorker.calculate(
    value: _,
    move completion: _
  ): _ {
    callback completion {
      thread any;
      invoked once;
    }
  }
}
```

For a native signature such as `uint32_t vendor_position(float *x, float *y)`,
the two `_` placeholders are inferred as `f32` from Clang. `out` is the added
semantic fact: each pointer initializes exactly one caller-owned scalar during
the call. Z therefore accepts uninitialized mutable bindings, passes their
addresses directly, and makes both `f32` values readable only after the call.
Use `inout` when native code may read the previous scalar value and replace it;
use `in` for a const pointer that borrows one stored scalar.

Only facts supported by the current compiler are accepted. Undesigned future
spelling does not silently pass through.

## Declaration dictionary

| Form | Meaning in Z | Native evidence or lowering |
| --- | --- | --- |
| `declare module "header"` | Bind this contract to one imported header | Specifier and resolved header must match |
| `export function name(...)` | Refine an existing native function | Name, parameter count/order, and native types come from Clang |
| `export function Type.method(...)` | Refine an existing Objective-C method | The class, selector base name, parameter names, and types must match Clang; static and instance methods share this declaration shape |
| `export type Name { ... }` | Refine an existing C++/generated value type | Clang must prove the named value and supported lifecycle operations |
| `export type Name on thread.main;` | Isolate an existing native type to the main executor | The type must exist in the imported header; values, construction, member access, destruction, and containing Z aggregates retain the affinity |
| `export type Name on thread.main { ... }` | Combine executor isolation with native value lifecycle facts | Affinity is independent from copy/move/deinit capability |
| `export function name(...): _ on thread.main` | Isolate a native function or Objective-C method | Calls require proven main-executor context; the native ABI is unchanged |
| `_` | Infer the ABI type from the header | Never means dynamic or untyped |
| `_ \| null` | Expose a header pointer/reference as nullable | Requires a compatible native pointer/reference representation |
| `null` parameter type | Caller never supplies the native pointer; Z emits null | Used only for a value parameter that is intentionally hidden |
| `in name: _` | Read-only, call-scoped borrow | Typically `const T *`, `const T &`, or a call-only callback |
| `inout name: _` | Exclusive mutable borrow | Typically `T *` or `T &`; caller spells `inout value` |
| `out name: _` | Callee initializes caller storage | Typically an output pointer such as `T *`/`T **`; unreadable until initialized |
| `move name: _` | Transfer ownership into the native call | C++ rvalue/owned parameter or escaping callback, when the full contract proves it |
| `view cstring` | Borrowed native text tied to the supported input owner | Copies explicitly when converted to owned Z `String` |
| `deinit release;` | Associate owned storage with its exact cleanup operation | Meaning depends on whether it appears on a result, output, callback, or type |
| `fixed CONSTANT;` | Hide one native ABI parameter and always pass a header constant | Z call omits that argument; generated native code inserts the constant in place |
| `void throws _` | Project an integer or integer-backed native enum status into Z's error channel | Native return type remains ABI-exact and allocation-free; enum errors retain their imported enum type |
| `success N;` | Treat numeric status `N` as successful `void` completion | Every other integer or enum status becomes the typed error value |
| `success CONSTANT;` | Treat a header-defined integer or enum constant as successful completion | The constant must exist and match the native return type; generated C preserves its symbolic spelling |
| `option: ENUM_MEMBER` | Restrict this argument to one exact header constant | Selects a safe overload of a native variadic function |
| `in value: cstring` after the fixed native parameters | Give a C variadic argument an explicit safe type | The native function must be variadic; the Z call remains a direct native call |
| `value: clong` after the fixed native parameters | Require the exact C `long` variadic ABI | Projects to the target-width fixed Z integer and emits an explicit `(long)` cast |
| `connection throws _` | Turn a native status-returning callback registration into a move-only connection | Success returns `native.Connection`; failure preserves the native integer or enum status |
| `callback operation { ... }` | Classify a named native callback or Objective-C block parameter | The parameter must exist and have a compatible native callable type |
| `invoked once;` | Assert exactly one native callback invocation | Required before an exactly-once callback may synthesize a Z `Task`; generated async adapters trap a duplicate invocation before touching completed task storage |
| `invoked repeatedly;` | Assert zero or more native callback invocations | Required for owner-tied callback connections; also valid for call-scoped APIs such as sorting and visitation |
| `context context;` | Pair a C callback with its opaque native context parameter | Generated trampoline recovers the exact Z closure environment; ARC-owned Objective-C blocks omit this |
| `type NativeCallback;` | Name the exact callback typedef used by an option-selected native callback | The typedef and its full function-pointer signature must exist in the header |
| `context option CONSTANT;` | Name the separate native option used to install the opaque callback context | Constant must exist, match the native option type, and differ from the callback option |
| `owner handle;` | Tie a callback connection to one borrowed native owner parameter | Z prevents the owner from moving or deinitializing while the connection is live |
| `project input: Slice<u8> { data data; length length; }` in a function body | Replace a native byte pointer plus `size_t` length with one named borrowed `Slice<u8>` argument | Read-only projections require const native storage; `project inout` requires mutable native storage and explicit `inout` at the Z call site |
| `project bytes: Slice<u8> { data buffer; length size * count; }` in a callback body | Project native callback byte parameters into one named borrowed `Slice<u8>` callback argument | Every named callback parameter and its native type are checked against the typedef |
| `failure N;` in a callback body | Return numeric native value `N` if the Z callback throws | Checked against the nested callback's native return type, not the enclosing foreign function return |
| `failure CONSTANT;` in a callback body | Return a header-defined native failure value if the Z callback throws | The constant must exist and be compatible with the callback return type; the thrown Z payload is destroyed at the boundary |
| `thread caller;` | Callback invocation and release remain on the registering thread | Escaping closure environment uses ordinary thread-local ownership |
| `thread any;` | Callback invocation and release may occur on arbitrary threads, including overlapping invocations | Escaping closure environment uses atomic ownership and every capture must satisfy Z's conservative concurrent-shareability rules |
| `copy;` | Native value has usable copy construction | Enables `copy value` and copying aggregate storage that contains it |
| `move;` | Native value has usable move construction | Enables ownership transfer and `std::move` lowering |
| `thread { transfer; }` | One unique owner may cross to another native thread | Separate trusted fact from ordinary move construction |
| `thread { share; }` | Native identity may be shared across native threads | Stronger than transfer and therefore cannot be combined with it |
| `thread { ... deinit; }` | Destruction is permitted on the receiving thread | Required by the first unique native-owner `thread.spawn` tier |

## `deinit` by location

The repeated word describes the same fact—how an owned native resource is
released—but its owner is determined by location:

| Location | Owner created or retained | Example |
| --- | --- | --- |
| Function result block | Returned native handle | `(): _ \| null { deinit vendor_close; }` |
| `out` parameter block | Handle written into caller storage | `out handle: _ \| null { deinit vendor_close; }` |
| `export type` block | C++/generated value storage | `export type Lease { move; deinit; }` |
| C `callback` block | Escaping callback environment | `deinit release;` names the native destroy-callback parameter; ARC-owned Objective-C blocks omit it |
| `thread` block | Cross-thread destruction permission | `deinit;` has no name because the ordinary owner already carries its destructor |

`deinit` does not guess ownership. The surrounding result, output, native value,
or escaping callback contract must establish an owner first.

## Ordinary byte buffers

A native pointer and its adjacent length are one logical value in safe Z:

```c
int vendor_hash(const unsigned char *data, size_t length);
```

```z
declare module "vendor.h" {
  export function vendor_hash(in data: _, length: _): _ {
    project input: Slice<u8> {
      data data;
      length length;
    }
  }
}
```

The resulting Z signature is:

```z
vendor_hash(input: Slice<u8>): i32
```

`input` is the Z-visible projected parameter name. The inner `data` and
`length` facts name ABI parameters from the header. A spelling such as
`data data;` is therefore intentional: the first word is the `.zd` fact and the
second is the C parameter. Naming the projection keeps multiple ordinary
projections distinct and gives callback adapters an unambiguous value such as
`bytes.length`.

The current callback tier is narrower: one callback may declare one named byte
projection, although its length expression may multiply several native
`size_t` factors. Multiple named projections and other element types remain
future contract extensions.

Callers pass stored fixed arrays, `Array<u8>`, or existing `Slice<u8>` values
without spelling `in`; a slice is intrinsically borrowed. The declaration's
`in data` describes the native pointer contract. The length disappears from the
safe call and is derived from the slice. Lowering remains a direct native call:

```c
vendor_hash(input.data, input.length);
```

Writable native buffers reuse Z's ordinary capability vocabulary:

```z
export function vendor_fill(inout data: _, length: _): _ {
  project inout destination: Slice<u8> {
    data data;
    length length;
  }
}
```

The resulting `vendor_fill(inout destination: Slice<u8>)` requires mutable
stored Z storage and explicit `inout destination` at the call site. Read-only
projections require a const native byte pointer; mutable projections require a
non-const native byte pointer. The current tier supports `u8` and one `size_t`
length for ordinary calls. Retained pointers, other element types, and
multi-factor ordinary lengths remain separate reviewed contracts.

## Why `fixed SQLITE_TRANSIENT` exists

SQLite declares:

```c
int sqlite3_bind_text(
  sqlite3_stmt *,
  int,
  const char *,
  int,
  void (*)(void *)
);
```

The fifth parameter controls the lifetime of the text bytes. Passing
`SQLITE_TRANSIENT` tells SQLite to copy them before the call returns. Z's
contract keeps the real five-parameter ABI while removing that unsafe policy
choice from every application call:

```z
declare module "sqlite3.h" {
  export function sqlite3_bind_text(
    in statement: _,
    index: _,
    in text: _,
    length: _,
    destructor: _ { fixed SQLITE_TRANSIENT; }
  ): void throws _ {
    success 0;
  }
}
```

Z code supplies four arguments; this SQLite example uses `-1` for its
NUL-terminated `String` storage:

```z
try sqlite.sqlite3_bind_text(statement, 1, title, -1);
```

Generated native code still calls the exact C ABI:

```c
sqlite3_bind_text(statement, 1, title.data, -1, SQLITE_TRANSIENT);
```

`fixed` is therefore not a default Z value. It is a compiler-verified,
header-defined ABI argument that disappears from the safe source surface.

## Native-language mapping

These are semantic mappings, not textual rewrites:

| Native shape | Typical `.zd` fact | Z surface |
| --- | --- | --- |
| C `const T *` input | `in value: _` | Read-only call borrow |
| C mutable `T *` input | `inout value: _` | Exclusive mutable call borrow |
| C `T **` output | `out value: _` plus optional `deinit` | Definitely initialized owned result |
| C opaque returned handle | Return `_ \| null { deinit close; }` | Nullable owned handle with deterministic cleanup |
| C integer or integer-backed enum status | `void throws _ { success N; }` or `success CONSTANT;` | `try`/`attempt` and `Result<void, E>`; enum failures preserve their native enum type |
| C variadic function selected by an enum option | Repeated contracts with `option: ENUM_MEMBER` and explicit trailing types | Closed, type-checked Z overloads that still lower to the original C call |
| C variadic `long` | Declaration-only `clong` | Target-width integer checking at the Z surface plus exact `long` ABI lowering |
| C sentinel/policy argument | Parameter `{ fixed CONSTANT; }` | Argument omitted from the Z call |
| C call-only callback | `in operation: _` plus callback/context pairing when needed | Nonescaping borrowed closure |
| C escaping callback | `move operation: _` plus context, release, and an explicit `thread caller` or `thread any` fact | ARC-owned escaping Z closure; `thread any` adds atomic environment ownership and capture checking |
| C callback/context installed by separate options | `connection throws _` plus callback `type`, `context option`, `owner`, byte projection, and `thread caller` | `try` returns a move-only `native.Connection`; cleanup unregisters the callback before releasing its owner-tied closure |
| C++ `const T &` | `in value: _` | Borrowed value |
| C++ `T &` | `inout value: _` | Mutable borrowed value |
| C++ `T &&` | `move value: _` with value lifecycle contract | Consumed unique owner |
| C++ RAII value | `export type` with `copy` or `move`, and `deinit` | Deterministic Z-owned native storage |
| Objective-C object/method/property/protocol | Usually no `.zd` entry | Clang supplies ARC identity, nullability, selectors, blocks, and protocol metadata directly |
| Clang `swift_attr("@UIActor")` / `swift_attr("@MainActor")` | Imported automatically | Z exposes `on thread.main` in hover and enforces the same executor boundary |
| Swift `@MainActor` in a `z.json`-declared Swift target | Imported automatically from the emitted symbol graph | Generated Objective-C headers erase actor isolation; Z merges the toolchain graph with the header-derived declaration |
| Legacy native UI type or method without actor metadata | `.zd` `on thread.main` fallback or reviewed shipped API notes | The affinity enters the same FIIR field as a compiler-derived fact |
| Objective-C/Swift static method with an escaping block | `export function Type.method(..., move completion: _)` plus `callback completion { thread ...; }` | Native block owns the Z closure under ARC; `.zd` supplies the thread guarantee absent from the header |
| Objective-C/Swift exactly-once completion method | The escaping-block contract with `invoked once;` plus `async completion;` | Keeps the raw overload and synthesizes an infallible `async method(...): T`; zero callback values produce `void`, one cleanup-free scalar produces `T` |
| Objective-C/Swift value/error completion method | `async completion(value, error) { return value; throw error; }` | Names callback positions and synthesizes `async method(...): T throws E`, surfaced as `Task<T, E>` |

The current Objective-C method contract tier names an existing static method by
class and base name; it does not redeclare or rename selectors. Parameter names
disambiguate the imported selector. Block lifetime/thread facts may be refined,
`invoked once` identifies exact terminal delivery, and an `async` clause may
project that terminal escaping block into a Task.
The shorthand `async completion;` accepts zero or one cleanup-free scalar
callback value. A conventional Objective-C/Swift completion pair can instead
name its positions:

```z
async completion(value, error) {
  return value;
  throw error;
}
```

This produces `Task<T, E>` while preserving the raw callback-taking overload.
The first typed-error tier requires a static method, terminal callback
parameter, native and block `void` returns, a cleanup-free scalar success
value, and a nullable Objective-C error reference. Ordinary Objective-C calls
still need no sidecar.

## Callback cardinality

Every `.zd` callback contract states its native invocation cardinality
explicitly:

```z
callback completion {
  thread any;
  invoked once;
}

callback visitor {
  context context;
  failure 1;
  invoked repeatedly;
}
```

`invoked once` means exactly one native invocation. It is required before an
Objective-C or Swift completion may synthesize a Z `Task`. The generated async
adapter atomically records its first completion and traps deterministically if
native code invokes it again, before completed task storage can be touched.
Because this is a trusted behavioral fact rather than a header property, a
vendor that never invokes the callback leaves the synthesized task pending
indefinitely unless a later contract supplies a native cancellation or terminal
completion hook.

`invoked repeatedly` means zero or more invocations. Every owner-tied callback
connection requires it, but it is not connection-specific: a call-scoped
visitor or sorting callback can also be invoked repeatedly.

Native callbacks use their real ABI return type in Z. An ordinary return passes
that value directly to C. A callback contract may add `failure N;` or
`failure HEADER_CONSTANT;`, which permits a compatible Z function value to
declare `throws E`. If the callback throws, the generated adapter destroys the
`E` payload and returns the declared native failure value.

This is narrowing rather than silent loss: the richer Z payload cannot cross
the C callback ABI, but the failure fact does. A libcurl callback failure
becomes `CURLE_WRITE_ERROR` on `curl_easy_perform`; a SQLite-style visitor can
return nonzero to abort traversal. It is nevertheless the only Z `throw` whose
payload never reaches a Z handler, so code should treat it as an explicit ABI
boundary. In a callback declared `invoked repeatedly`, prefer a cleanup-free
error type on hot paths. Owned strings and other cleanup-bearing payloads remain
correct, but they are constructed and destroyed before control returns to C.

The `failure` fact is checked against the callback typedef's return type. An
outer `success CURLE_OK;` still describes the enclosing function's `CURLcode`
return; nested `failure CURL_WRITEFUNC_ERROR;` describes the callback's
`size_t` return. Placing either fact at the wrong nesting depth is rejected with
a diagnostic naming the relevant return channel.

## Trust boundary

Clang remains the ABI authority. The compiler checks `.zd` grammar and validates
ABI-visible claims—symbols, methods, parameter positions and names, callback
shape, nullability, return types, and capability compatibility—against Clang's
imported declaration graph. `.zd` can then narrow or classify that imported
surface, but a project author can still lie about behavioral facts that no
header expresses—for example, claiming that a vendor callback fires exactly
once or that a native owner may be destroyed on another thread. Such a false
contract is the foreign equivalent of an unsafe declaration.

Reusable bindings should ship reviewed `.zd` metadata with the library or
toolchain. Z may also ship reviewed API notes for platform surfaces such as
AppKit when the public header does not uniformly encode its executor contract.
Application-local declarations are the explicit fallback for legacy and
project-specific APIs, not intended as one handwritten sidecar per system
header.

## Paired callback connections

Some C APIs, including libcurl, install a function pointer and its opaque
context in separate calls even though the two values form one logical
registration. Z exposes that registration as one ownership-bearing value:

```z
const writer = try curl.curl_easy_setopt(
  easy,
  curl.CURLOPT_WRITEFUNCTION,
  move (bytes: Slice<u8>): usize => {
    console.log(`received ${bytes.length} bytes`);
    return bytes.length;
  }
);
```

The closure itself is moved because native code retains it after the call.
`bytes` does not use `in`: `Slice<u8>` is intrinsically a borrowed,
non-escaping view and its two-word value is passed directly to the Z closure.
The connection's scope determines when Z unregisters the native callback and
releases the closure environment:

```z
{
  const writer = try installWriter(easy);
  try perform(easy);
} // writer disconnects here

// easy may move or deinitialize again here
```

Discarding the result is rejected. Moving or explicitly cleaning up `easy`
while `writer` is live is also rejected. This converts a native lifetime
convention that is normally maintained by comments into a checked Z ownership
relationship. Connection cleanup is synchronous and cannot throw; if the
native API unexpectedly rejects callback removal, Z terminates rather than
release a closure that native code may still call.

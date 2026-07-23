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

The enclosing `declare module` is already the authoring scope. No import is
required inside the `.zd` file; the editor loads that header for completion,
hover, and validation.

## Complete current shape

```z
declare module "vendor.h" {
  export type NativeValue {
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
    success 0;
  }

  export function vendor_visit(
    in operation: _,
    context: _
  ): _ {
    callback operation {
      context context;
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
    }
  }
}
```

Only facts supported by the current compiler are accepted. Undesigned future
spelling does not silently pass through.

## Declaration dictionary

| Form | Meaning in Z | Native evidence or lowering |
| --- | --- | --- |
| `declare module "header"` | Bind this contract to one imported header | Specifier and resolved header must match |
| `export function name(...)` | Refine an existing native function | Name, parameter count/order, and native types come from Clang |
| `export type Name { ... }` | Refine an existing C++/generated value type | Clang must prove the named value and supported lifecycle operations |
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
| `void throws _` | Project an integer-returning native status into Z's error channel | Native return type remains ABI-exact and allocation-free |
| `success N;` | Treat status `N` as successful `void` completion | Every other integer status becomes the typed error value |
| `callback operation { ... }` | Classify a named native callback parameter | Callback/context/release positions must exist in the function signature |
| `context context;` | Pair the callback with its opaque native context parameter | Generated trampoline recovers the exact Z closure environment |
| `thread caller;` | Callback invocation and release remain on the registering thread | Current escaping-callback tier; cross-thread callbacks remain unsupported |
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
| `callback` block | Escaping callback environment | `deinit release;` names the native destroy-callback parameter |
| `thread` block | Cross-thread destruction permission | `deinit;` has no name because the ordinary owner already carries its destructor |

`deinit` does not guess ownership. The surrounding result, output, native value,
or escaping callback contract must establish an owner first.

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
| C integer status | `void throws _ { success 0; }` | `try`/`attempt` and `Result<void, E>` |
| C sentinel/policy argument | Parameter `{ fixed CONSTANT; }` | Argument omitted from the Z call |
| C call-only callback | `in operation: _` plus callback/context pairing when needed | Nonescaping borrowed closure |
| C escaping callback | `move operation: _` plus context, release, and caller-thread facts | ARC-owned escaping Z closure |
| C++ `const T &` | `in value: _` | Borrowed value |
| C++ `T &` | `inout value: _` | Mutable borrowed value |
| C++ `T &&` | `move value: _` with value lifecycle contract | Consumed unique owner |
| C++ RAII value | `export type` with `copy` or `move`, and `deinit` | Deterministic Z-owned native storage |
| Objective-C object/method/property/protocol | Usually no `.zd` entry | Clang supplies ARC identity, nullability, selectors, blocks, and protocol metadata directly |

The current `.zd` grammar does not redeclare Objective-C methods or selectors.
Use direct header imports and Z protocol conformance for those. Declaration
files remain available for C functions and value types contained in mixed
Objective-C/C++ headers when the ABI lacks the needed semantic facts.

## Trust boundary

Clang remains the ABI authority. `.zd` can narrow or classify that imported
surface, but a project author can still lie about semantic facts that no header
expresses—for example, claiming that a vendor callback is released exactly once
or that a native owner may be destroyed on another thread. Such a false
contract is the foreign equivalent of an unsafe declaration.

Reusable bindings should ship reviewed `.zd` metadata with the library or
toolchain. Application-local declarations are the explicit fallback for legacy
and project-specific APIs, not intended as one handwritten sidecar per system
header.

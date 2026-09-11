---
title: Z declaration contracts
description: Add ownership, cleanup, status, callback, and lifetime semantics to a native header without restating its ABI.
sidebar:
  order: 3
---

An adjacent `.zd` file augments a native header with facts the header cannot
express. It does not replace the header or declare a second ABI.

```z
declare module "vendor.h" {
  export function vendor_open(): _ | null {
    deinit vendor_close;
  }
}
```

The `_` means “use the type Clang derived for this position.” The compiler
checks the declaration against the real `vendor_open` symbol and gives Z an
owned nullable handle whose cleanup is `vendor_close`.

The source file remains simple:

```z
import native from "vendor.h";

function inspect(): i32 {
  const handle = native.vendor_open();
  if (handle == null) return 1;

  return native.vendor_read(handle);
} // vendor_close runs exactly once
```

## The authoring model

Name the exact header in `declare module`, then describe only declarations that
need additional semantics:

```z
declare module "sqlite3.h" {
  export function sqlite3_open(
    in filename: _,
    out database: _ | null {
      deinit sqlite3_close;
    }
  ): void throws _ {
    success 0;
  }

  export function sqlite3_close(move database: _): _;
}
```

This contract contributes four facts:

1. `filename` is borrowed for the call.
2. `database` is an output initialized by the call.
3. A non-null result owns one handle cleaned up by `sqlite3_close`.
4. Native status `0` becomes successful `void`; every other status is the typed
   error used by `try` and `attempt`.

There is no import statement inside the `.zd`. The `declare module` header is
already the authoring scope, and editor completion can use its Clang symbols.

The same capability vocabulary applies when a free C function accepts a
concrete Objective-C object:

```z
declare module "desktop_host.h" {
  export function observe_window(in window: _, in title: _): _;
}
```

Clang remains authoritative for the `NSWindow *` or `NSString *` identities;
`in` states that the function borrows those ARC references for the call. The
generated call passes the original objects directly, without a wrapper or raw
pointer type.

## Core vocabulary

| Fact | Meaning at the Z boundary |
| --- | --- |
| `in value: _` | Read-only call-scoped borrow |
| `inout value: _` | Exclusive readable/writable borrow |
| `out value: _` | Must be initialized on every successful path |
| `move value: _` | Native call consumes the Z owner |
| `deinit release;` | Name deterministic cleanup for returned or output storage |
| `owned;` | Returned C value resource is a new unique owner |
| `borrowed;` | Returned native resource is a non-escaping view |
| `success VALUE;` | Map one native status to successful typed completion |
| `fixed CONSTANT;` | Hide a policy argument and always pass the header constant |
| `borrowed from owner;` | Tie a returned view to one borrowed input owner |
| `invalidates owner;` | Reject the call while derived views remain live |
| `target receiver;` | Pair a native `SEL` callback with an object parameter; declaration validation is implemented, executable selector references are pending |
| `type (in value: NativeObject) => void on thread.main;` | Assert the signature erased by `SEL`; main is a callback requirement, not an automatic hop |

`owned` and `borrowed` have no implicit default for resource-classified return
values. A generated contract should fail closed and require a person to supply
the behavioral fact rather than guess ownership.

## Selector callback contracts

The declaration checker accepts this shape in both compilers:

```z
declare module "AppKit/AppKit.h" {
  export function NSWindow.displayLinkWithTarget(target: _, selector: _): _ {
    callback selector {
      target target;
      type (in link: CADisplayLink) => void on thread.main;
      invoked repeatedly;
    }
  }
}
```

The outer function and target/selector parameter types must match the header.
The callback signature is different: `SEL` erases it, so this fact must come
from reviewed native documentation. The first tier accepts scalar/native-enum
values and borrowed imported Objective-C object parameters, with scalar/enum
or `void` returns. `target target;` reads as the fact followed by the native
parameter's name.

This is a **contract-validation checkpoint**, not an executable selector API
yet. The approved `objc.selector(Type.method)` utility and checked native
callback entries are next; registration remains unavailable until those checks
are in place. No closure environment, automatic hop, or implicit invalidation
is introduced. Display links still need explicit main-run-loop registration
and invalidation during shutdown.

## Returned resources

By-value C resources can receive move-only RAII semantics:

```z
declare module "raylib.h" {
  export type Image {
    move;
    deinit UnloadImage;
  }

  export function GenImageColor(width: _, height: _, color: _): _ {
    owned;
  }

  export function UnloadImage(move image: _): _;
}
```

The original C layout and calls remain unchanged. Z now prevents accidental
copy, double unload, and use after consuming cleanup.

A `borrowed;` resource return is conservatively non-escaping in the current
tier. It cannot be stored in a field or collection, captured, returned, or
passed to a consuming operation. Future named lifetime contracts may safely
relax that boundary; the compiler does not accept an unproven dangling shape
today.

## Hide native policy parameters

Some C APIs require a sentinel or ownership-policy argument callers should not
choose independently:

```z
export function sqlite3_bind_text(
  in statement: _,
  index: _,
  in text: _,
  byteCount: _,
  destructor: _ { fixed SQLITE_TRANSIENT; }
): void throws _ {
  success 0;
}
```

The Z call omits `destructor`; generated native code inserts the verified header
constant. This is particularly useful when one C argument determines how long
another argument's bytes remain valid.

`fixed` also supports header sentinels written as an explicitly typedef-cast
integer expression, including SQLite's `SQLITE_TRANSIENT`. Clang canonicalizes
the cast type and Z requires it to match the hidden native parameter; the
function-pointer-shaped sentinel does not become a general Z value.

## Contract callbacks as one relationship

Callbacks often split one logical operation across a function pointer, context
pointer, release callback, owner, and native thread rule. A `.zd` block keeps
those facts together:

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

The Z callback receives one borrowed `Slice<u8>` instead of unrelated pointer,
size, and count arguments. The returned `native.Connection` owns registration:
its lifetime keeps the closure and `curl` owner valid, and cleanup unregisters
before releasing them.

Callback facts include:

| Fact | Purpose |
| --- | --- |
| `context context;` | Pair a callback with its explicit native context argument |
| `context option CONSTANT;` | Pair separately installed callback/context options |
| `owner handle;` | Keep the native owner alive while registration is live |
| `invoked once;` | Permit exactly-once completion/task synthesis |
| `invoked repeatedly;` | Permit zero or more calls under the stated lifetime |
| `thread caller;` | Callback runs synchronously or later on the registering caller's thread |
| `thread any;` | Callback may enter from any registered native thread |
| `failure VALUE;` | Narrow a thrown Z callback error into the native return status |

`failure` preserves the fact of failure but not an arbitrary Z error payload;
the native callback ABI has only its status return. Cleanup-bearing callback
errors can therefore create needless hot-path allocation and are best avoided
unless a later owner-tied error-preservation contract is available.

## Borrowed native fields and invalidation

Named foreign lifetimes describe runtime-owned storage without exposing raw
pointers or adding general lifetime parameters to Z:

```z
declare module "events.h" {
  lifetime eventMemory;

  export type TextEvent {
    project text: view cstring | null {
      borrowed from eventMemory;
    }
  }

  export function poll(out event: _): _ {
    invalidates eventMemory;
  }
}
```

The projected text can be read while valid. Calling `poll` while such a view is
still live is rejected. Copy with `String.from(text)` when the bytes must
survive the next native event operation.

## What the compiler can prove

`.zd` validation has two layers:

- **ABI-checkable facts:** symbol existence, parameter position, native type,
  callback typedef shape, constant compatibility, record field, and calling
  convention are checked against Clang data.
- **Behavioral facts:** ownership, invocation cardinality, callback thread,
  cleanup behavior, and runtime lifetime relationships may not exist in the
  header. The contract author owns their accuracy.

This is why `.zd` is safer than an `unsafe` block but is not magical proof of
undocumented vendor behavior. It centralizes the assertion, checks everything
that can be checked, exposes it to tooling, and makes every call site obey the
resulting contract.

:::note[Cost model]
`.zd` facts normally compile away into direct native calls plus work required by
their stated semantics: cleanup, retains/releases, callback environments,
status checks, or bounds descriptors. The declaration file itself is not a
runtime wrapper layer.
:::

For the complete current grammar, including discriminated C unions, async
completion synthesis, Objective-C executor facts, and every diagnostic rule,
use the authoritative
[`.zd` reference](https://github.com/popaprozac/z/blob/main/docs/z-declarations.md).

Next: [Unsafe native calls](/interop/unsafe-native-calls/).

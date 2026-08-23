---
title: Native interop
description: Start with a header and add semantic facts only when the ABI is not enough.
sidebar:
  order: 1
---

Z's interop model has four deliberately distinct tiers. Start at the safest,
smallest tier that represents the native API correctly.

## 1. Import the real header

```z
import sqlite from "sqlite3.h";

const version = sqlite.sqlite3_libversion();
```

Clang supplies declarations, layouts, namespaces, supported macros, calling
conventions, availability, and source locations. Generated calls remain direct
native calls.

This tier is enough for many C functions, C aggregates, Objective-C methods,
and selected C++ values and methods.

Objective-C's dynamic `id` can be narrowed without leaving Z. Assigning the
narrowed `NSString` to an explicit `String` destination performs an owned UTF-8
copy, so the Z value does not borrow Objective-C-managed storage:

```z
import native from "WebKit/WebKit.h";

const body = message.body;

if (body instanceof native.NSString) {
  const text: String = body;
  route(move text);
}
```

Zapp exercises this exact shape in a visible WebKit message round trip. The
generated boundary uses the native Objective-C class test and preserves the
string's exact UTF-8 byte length, including embedded null bytes.

## 2. Add a `.zd` contract

Headers cannot reliably encode ownership, cleanup, callback lifetimes, typed
status errors, executor requirements, or buffer relationships. An adjacent
`.zd` file adds those facts without restating the ABI:

```z
declare module "vendor.h" {
  export function vendor_open(): _ | null {
    deinit vendor_close;
  }
}
```

The underscore refers to the Clang-derived type. The contract is checked
against the real declaration and fails closed when its facts contradict the
header. `.zd` is how a library can ship reusable, editor-visible safety
semantics while leaving the upstream header authoritative.

## 3. Use a local `unsafe` assertion

`unsafe` keeps code in Z but lets the author locally assert a native fact the
compiler cannot prove yet. Values crossing back into ordinary Z remain checked.
It is useful for exploration and narrow gaps, but it is not a reusable safety
contract.

## 4. Isolate native source with `raw`

```z
const status = raw c using (): i32 {
  return vendor_expression_macro(42);
};
```

`raw c`, `raw cpp`, and `raw objc` leave Z's type system inside the block. The
native compiler resolves the source; `using` defines the audited boundary for Z
values entering it. Raw blocks are the last resort for constructs that cannot
yet be represented by the checked importer.

## What the tiers protect

| Tier | Primary benefit | Author owns |
| --- | --- | --- |
| Header import | Direct ABI-checked access | Only ordinary Z code |
| `.zd` | Reusable checked semantic contract | Accuracy of non-ABI facts |
| `unsafe` | Local typed assertion | The proof at that site |
| `raw` | Full native-language escape | The entire native block and boundary |

Z's interop thesis is not that native APIs need no modeling. It is that the
header remains the ABI truth, missing semantics are additive and reusable, and
unsupported behavior stays explicit instead of being guessed.

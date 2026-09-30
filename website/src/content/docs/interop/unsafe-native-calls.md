---
title: Unsafe native calls
description: Keep Z syntax and type checking while accepting one local native fact the compiler cannot prove.
sidebar:
  order: 4
---

`unsafe` is the middle interop tier. It keeps ordinary Z syntax, ownership, and
control flow, but makes one native interpretation the author's local proof
obligation.

```z
import native from "vendor.h";

const version = unsafe {
  const borrowed: cstring = native.vendor_version();
  select String.from(borrowed);
};
```

The `cstring` annotation asserts that the returned native character pointer is
readable NUL-terminated text. `String.from` creates an independent owned copy,
which is safe to select out of the block.

## What remains checked

`unsafe` does not turn Z into C or disable the ownership checker:

```z
const observed = unsafe {
  const handle = native.vendor_open(42);

  if (handle == null) return 1;

  const value = native.vendor_read(handle);
  native.vendor_close(handle);
  select value;
};
```

Within the block:

- bindings still have static types;
- `const`, `let`, `if`, `match`, `return`, and `select` keep their Z meaning;
- normal Z owners still receive deterministic cleanup;
- ordinary safe scalars may leave through `select`;
- values cannot silently cross an incompatible call boundary.

`select` supplies the value of an unsafe expression. `return` still exits the
enclosing function, exactly as it does inside `if` and `match` blocks.

## Opaque native identities

Z deliberately has no general safe raw-pointer type. An unsupported native
pointer inside `unsafe` becomes an opaque scope-local identity.

It may:

- compare with `null`;
- pass back to a native parameter with the exact same normalized pointer type.

It may not:

- be dereferenced, indexed, or used in pointer arithmetic;
- expose members;
- pass through an ordinary Z function;
- be stored, returned, captured, or selected out of the block;
- acquire guessed ownership or implicit cleanup.

This covers the common “receive an opaque handle, use it, close it” shape
without making arbitrary pointers part of ordinary Z.

## Read one union fact locally

Imported C union storage may be initialized through a checked `.zd` `out`
contract. When no reusable discriminant contract exists, `unsafe` can express
one reviewed active-member read:

```z
let event;
native.poll(out event);

const eventType = unsafe {
  select event.type;
};
```

Prefer a `.zd` `discriminant` contract when the relationship is reusable. It
can make `match (in event)` exhaustive and keep inactive or pointer-bearing
members inaccessible at every call site.

## Element access with an asserted bound

`unsafe` also covers one Z-only proof: an index already known to be in
bounds.

```z
let registers = Array<i32>(0, 0, 0, 0);
unsafe {
  registers.uncheckedSet(2, 42);
}
const value = unsafe { select registers.uncheckedAt(2); };
```

`uncheckedAt` and `uncheckedSet` skip the bounds check in a release build and
keep it in a debug build, so tests still catch a wrong assertion. They accept
only cleanup-free elements. Use them where an invariant established once (a
window validated at entry, a loop bound) makes every per-access check
redundant, and keep `values[index]` everywhere else.

## When `unsafe` is the right tier

Use `unsafe` when all of these are true:

1. The operation can still be expressed with Z values and native calls.
2. The missing fact is narrow and local.
3. Repeating the proof across call sites is acceptable during exploration.
4. No arbitrary native-language expression is required.

Promote the fact into `.zd` when it should become reusable ownership,
nullability, cleanup, callback, lifetime, or threading semantics. Use `raw`
when the operation cannot be represented through Z's types at all.

:::caution[Current narrow tier]
The first implementation rejects nested unsafe blocks, async functions,
suspension, generator operations, closure construction, unsupported by-value
layouts, and unsafe identities crossing ordinary Z calls. These restrictions
keep the proof local rather than allowing unsafe provenance to disappear.
:::

:::note[Cost model]
The block itself adds no dynamic “unsafe mode.” Supported calls remain direct
native calls. Any cost comes from operations written inside it, such as the
owned allocation performed by `String.from`.
:::

Runnable example:
[unsafe native boundary](https://github.com/popaprozac/z/blob/main/examples/interop/unsafe/native-boundary.zs).

Next: [Raw native source](/interop/raw-native-source/).

---
title: C++ interop
description: Import namespaces, value types, methods, RAII resources, and move-only identities from C++ headers without a handwritten wrapper layer.
sidebar:
  order: 7
---

Import a C++ header through the same source syntax as C:

```z
import cpp from "cpp_math.hpp";

const origin = cpp.zcpp.Point({ x: 20, y: 22 });
const moved = cpp.zcpp.translate(origin, 1, -1);
const total = cpp.sum(moved);
```

`zcpp` represents the C++ global namespace. Named C++ namespaces remain named:

```z
const alpha = cpp.alpha.Point({ value: 20 });
const beta = cpp.beta.Point({ value: 22 });
```

No runtime namespace object is created. These are compile-time paths to the
Clang-imported declarations.

## Select and rename namespaces

Selective imports make namespace-heavy APIs easier to read:

```z
import {
  zcpp as math,
  alpha as left,
  beta as right
} from "cpp_math.hpp";

const origin = math.Point({ x: 20, y: 22 });
const adjusted = left.adjust(20) + right.adjust(22);
```

This changes only the Z source name. It does not generate a forwarding wrapper
or alter native symbol identity.

## Values keep native construction and layout

Aggregate-like values use the familiar Z construction surface when their
fields are safely importable:

```z
const point = math.Point({ x: 20, y: 22 });
```

Native constructors use their declared arguments:

```z
const resource = native.zcpp.UniqueValue(40);
```

Methods remain direct:

```z
const value = resource.value();
```

The type annotation is optional when construction makes the result clear.

## RAII composes with Z ownership

C++ value destructors become deterministic Z cleanup. Copyable native values
use their C++ copy behavior; move-only values remain move-only in Z:

```z
struct NativeOwner {
  value: native.zcpp.UniqueValue;
}

function inspect(in value: native.zcpp.UniqueValue): i32 {
  return value.value();
}

const first = native.zcpp.UniqueValue(40);
const observed = inspect(first);
const owner = NativeOwner({ value: first });
```

The final construction transfers `first` into `owner`. Z rejects later use of
the moved source and runs the imported destructor exactly once when the final
owner leaves scope.

References use the same capability vocabulary as Z where the importer can prove
their native relation: immutable reference inputs become borrowed `in`, mutable
references require `inout`, and returned references become non-escaping views
when provenance is known.

## Current boundary

The implemented vertical slices include:

- namespaces and selective namespace imports;
- plain aggregates, constructors, functions, overloads, and methods;
- copyable values with native copy/destruction;
- move-only RAII values in locals, fields, arrays, and enums;
- supported references and callable boundaries;
- direct Swift-generated C++ compatibility values.

Broad templates, arbitrary standard-library types, exception translation,
complex reference provenance, and library-scale compatibility remain active
work. Z rejects unsupported shapes at the source boundary rather than exposing
an invented approximation.

:::note[Cost model]
Supported construction, calls, copies, moves, and destruction lower to their
ordinary C++ operations. Z namespaces and ownership diagnostics are compile-time
structure. Native copy constructors and destructors still cost exactly what
their C++ implementations cost.
:::

Runnable examples:
[C++ basics](https://github.com/popaprozac/z/blob/main/examples/interop/cpp/cpp-interop.zs),
[selective namespaces](https://github.com/popaprozac/z/blob/main/examples/interop/cpp/cpp-selective-interop.zs),
and [move-only values](https://github.com/popaprozac/z/blob/main/examples/interop/cpp/cpp-move-only.zs).

Next: [Swift interop](/interop/swift/).

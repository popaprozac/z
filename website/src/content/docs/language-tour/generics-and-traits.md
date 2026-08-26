---
title: Generics and traits
description: Reuse statically specialized code while keeping behavior contracts nominal and direct.
sidebar:
  order: 11
---

Z uses TypeScript-shaped angle brackets for generic declarations and calls:

```z
struct Pair<T> {
  first: T;
  second: T;
}

function identity<T>(value: T): T {
  return value;
}

const numbers = Pair({ first: 20, second: 22 });
const value = identity(numbers.first);
```

The call site infers `T` as `i32`. Explicit type arguments remain available
when inference has insufficient evidence or the author wants to make the demand
visible:

```z
const value = identity<i32>(numbers.first);
```

## Generic methods

A method may introduce type parameters independently of its owner:

```z
struct Slot {
  occupied: boolean;

  function choose<T>(primary: T, fallback: T): T {
    if (this.occupied) return primary;
    return fallback;
  }
}

struct Utility {
  static function preserve<T>(value: T): T {
    return value;
  }
}

const inferred = slot.choose(20, 22);
const explicit = Utility.preserve<i32>(42);
```

The owner's type parameters and a method's own type parameters are separate
contracts. Check [implementation status](/reference/status/) before depending
on advanced two-level static specialization in pre-alpha code.

## Result context can guide inference

When arguments do not mention a type parameter, the destination may supply it:

```z
function absent<T>(): Option<T> {
  return Option<T>.none;
}

const local: Option<i64> = absent();

function load(): Option<i32> {
  return absent();
}
```

An unannotated `const local = absent();` remains ambiguous. Z uses real context;
it does not invent a default generic argument.

## Traits are nominal contracts

```z
trait Measured {
  function measure(): i32;
}

struct Reading implements Measured {
  amount: i32;

  function measure(): i32 {
    return this.amount;
  }
}

function measured<T: Measured>(in value: T): i32 {
  return value.measure();
}
```

`Reading` conforms because it explicitly says `implements Measured` and
satisfies the required method. A structurally similar type does not conform
accidentally.

Traits can be generic too:

```z
trait Source<T> {
  function next(inout this): Option<T>;
}

function inspect<T: Source<i32>>(inout source: T): i32 {
  return match (source.next()) {
    some(value) => value;
    none => 0;
  };
}
```

## Multiple constraints use intersections

Require more than one nominal behavior with `&`:

```z
function describe<T: Measured & Named>(in value: T): String {
  return `${value.name()}: ${value.measure()}`;
}
```

`&` means the concrete type must implement both contracts. `|` is reserved for
union-like type composition and is not the spelling for multiple constraints.

## Static dispatch, not trait objects

The current trait model is statically dispatched. The compiler specializes a
constrained generic for the concrete argument and emits a direct call to the
selected method.

Z does not yet provide trait-typed storage, existential values, or general
dynamic dispatch through a trait reference. Use a class, enum, or function
value when runtime identity or runtime-selected behavior is the actual design.

## Type aliases

A type alias gives an existing type a clearer name without changing its
representation or assignability:

```z
export type Operation = (left: i32, right: i32) => i32;
type Values = Array<i32>;
```

Aliases add no conversion, wrapper, allocation, or nominal identity. Alias
chains are valid; recursive alias cycles are compile-time errors. A new nominal
type should be a `struct`, `class`, or `enum`, not an alias.

:::note[Cost model]
Generics are monomorphized for their concrete native demands. Static trait
constraints select direct calls without allocating a trait object or consulting
a vtable. This can increase generated code size when many concrete
specializations are required.
:::

Runnable examples:
[generics](https://github.com/popaprozac/z/blob/main/examples/language/types/generics.zs)
and [generic constraints](https://github.com/popaprozac/z/blob/main/examples/language/types/generic-constraints.zs).

Next: [Strings, text, and JSON](/language-tour/strings-text-and-json/).

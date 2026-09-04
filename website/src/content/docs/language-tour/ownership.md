---
title: Ownership capabilities
description: Read, mutate, initialize, transfer, copy, and borrow values explicitly.
sidebar:
  order: 6
---

Z makes consequential ownership operations readable where they occur while
inferring lexical lifetimes internally.

| Capability | Meaning | Typical use |
| --- | --- | --- |
| `in` | Immutable borrow | Inspect a value without taking ownership |
| `inout` | Exclusive mutable borrow | Mutate caller-owned storage |
| `out` | Write-only initialization borrow | Let a callee initialize storage |
| `move` | Transfer ownership | Hand a move-only value to a new owner |
| `copy` | Explicitly duplicate a copyable value | Preserve the source and create an independent value |
| `view` | Non-owning projection tied to an owner | Inspect interior storage without copying |

```z
struct Counter { count: i32; }

function inspect(in counter: Counter): i32 {
  return counter.count;
}

function increment(inout counter: Counter): void {
  counter.count = counter.count + 1;
}

let counter = Counter({ count: 0 });
increment(inout counter);
```

Immutable `in` is normally inferred at a call site. Writable `inout`, `out`,
`move`, and `copy` remain explicit because they change storage or ownership.

## Replace initialized storage

Use the selectively imported `replace` utility when the old owner must be
returned instead of destroyed by assignment:

```z
import { replace } from "std/memory";

let current = Resource({ id: 1 });
const next = Resource({ id: 2 });
const previous = replace(inout current, move next);
```

`current` stays initialized with `next`, while `previous` owns the displaced
value. A named ownership-bearing replacement requires `move`; fresh values can
be passed directly. The operation adds no allocation or copy and does not
provide synchronization. View-bearing storage remains excluded from this first
tier because its owner provenance cannot be exchanged independently. Direct
ARC bindings preserve alias identity through the exchange; aggregates containing
nested ARC identities wait for complete whole-value provenance transfer.

## Views

A view borrows part of an owner without retaining or copying it:

```z
function first(in library: Library): view Document {
  return library.documents[0];
}
```

The compiler prevents the view from outliving or being invalidated by its
owner. Current rules are intentionally conservative and grow only when Z can
prove a more permissive shape safe.

A direct `readonly` class field has stable storage even when the ARC class has
other aliases, so it may be borrowed or viewed synchronously without copying:

```z
readonly class Application { menu: Menu; }

const application = Application.current();
inspect(in application.menu);
```

Mutable fields, `inout`, nested class identities, and borrows across suspension
remain conservative.

## Deterministic cleanup and shared identity

Move-only values and native resources can define `deinit` for deterministic
cleanup. ARC-managed classes provide shared identity; `Weak<T>` provides a
non-owning reference that must be upgraded before use. Cross-thread shared
mutation goes through synchronization such as `Mutex<T>` or executor isolation,
not unrestricted aliases.

Next: [Control flow and expressions](/language-tour/control-flow/).

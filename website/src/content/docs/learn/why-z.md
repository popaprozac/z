---
title: Why Z?
description: The problem Z is designed to solve and the tradeoffs it makes deliberately.
sidebar:
  order: 1
---

Z is an experimental systems language for developers who want native control
without making ownership syntax or foreign-function glue the center of every
program.

Its design combines three goals:

1. **Familiar source:** TypeScript-inspired syntax makes declarations, modules,
   objects, closures, and asynchronous code recognizable.
2. **Serious safety:** ownership capabilities, deterministic cleanup, ARC
   identity, typed errors, checked views, and structured concurrency prevent
   broad classes of memory and lifetime mistakes.
3. **Direct native integration:** C-family headers remain the ABI authority, so
   supported calls and layouts do not pass through a VM or universal FFI layer.

These goals reinforce one another. Native interop is much more useful when its
ownership and thread contracts participate in the same checker as Z code.

## Familiar syntax, different semantics

Z borrows TypeScript's approachable surface. It does not inherit JavaScript's
runtime model.

```z
struct Request {
  id: u64;
  active: boolean = true;
}

function inspect(in request: Request): i32 {
  return request.active ? 1 : 0;
}
```

`Request` is a statically laid-out value, `u64` has a fixed width, the condition
must be `boolean`, and `in` is a checked immutable borrow. There is no dynamic
object shape, implicit truthiness, or JavaScript number representation hiding
behind the punctuation.

If TypeScript is your primary language, read
[Z for TypeScript developers](/learn/z-for-typescript/) next.

## Readable ownership

Z keeps consequential operations visible at the point where they happen:

```z
inspect(in value);       // immutable borrow; usually inferred at the call site
update(inout value);     // exclusive mutation
initialize(out value);  // write-only initialization
store(move value);      // transfer ownership
const snapshot = copy value;
const element: view Item = collection[0];
```

The compiler infers lexical lifetime relationships internally. Z does not ask
ordinary application code to name lifetime parameters, but it also does not
hide mutation, transfer, or copying behind an innocent-looking call.

Value resources can define `deinit` for deterministic cleanup. Shared reference
identity uses ARC-managed `class` values and non-owning `Weak<T>` handles.
Cross-thread mutation uses synchronization or executor isolation rather than
unrestricted aliases.

## Native APIs stay native

When a header contains enough information, importing a C-family API starts with
the header itself:

```z
import sqlite from "sqlite3.h";

const version = sqlite.sqlite3_libversion();
```

Clang supplies the ABI declaration. Z adds a `.zd` contract only when the
header cannot express a safety fact such as ownership, cleanup, callback
cardinality, executor placement, or a typed status error.

The interop model therefore has four explicit tiers:

| Tier | Use it when |
| --- | --- |
| Header import | The native declaration is already representable and safe |
| `.zd` contract | The ABI needs reusable ownership or behavior facts |
| `unsafe` | You can make a narrow, local typed assertion |
| `raw c` / `raw cpp` / `raw objc` | The construct must leave Z's type system entirely |

See [Native interop](/interop/) for the complete model.

## Predictable native output

Z uses a conventional native pipeline:

```text
.zs source
  -> parsing, types, ownership, and effects
  -> C-family source
  -> Clang
  -> native executable or library
```

This makes generated code inspectable and allows Z to reuse mature platform
compilers and native debuggers. It also makes performance questions concrete:
documentation should say when an operation allocates, copies, retains, checks,
or compiles away.

Z aims for a systems-language performance ceiling. It does not promise that
every abstraction is free or that every program automatically matches expertly
tuned C. ARC identity, bounds checks, synchronization, and safety validation
have intentional costs when their semantics require them.

## What Z is not

Z is not intended to be:

- JavaScript or TypeScript compiled to C
- a tracing-GC runtime disguised as a systems language
- a new universal ABI placed between programs and native libraries
- a promise that arbitrary pointers or foreign behavior are safe automatically
- a replacement for Clang, the platform SDKs, or native linkers

The language prefers a small honest escape hatch over guessed safety, and a
checked direct call over an opaque wrapper.

## Current maturity

Z is pre-alpha. Its central ideas have executable evidence across ownership,
C and Objective-C interop, selected C++ and Swift surfaces, async tasks, native
threads, editor tooling, and a fixed-point native compiler. Composition,
cross-platform coverage, standard-library breadth, packaging, compatibility,
and production hardening remain active work.

The [language guide](/language-tour/) describes accepted Z source semantics.
The [implementation status](/reference/status/) describes what the current
compiler tiers execute and test today. Keeping those separate is deliberate.

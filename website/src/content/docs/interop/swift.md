---
title: Swift interop
description: Consume Swift through generated Objective-C and C++ compatibility interfaces while preserving ownership and async facts.
sidebar:
  order: 8
---

Swift interop currently uses interfaces Swift itself knows how to generate. Z
does not pretend to have a complete native Swift ABI implementation.

## Objective-C compatibility headers

Swift classes visible to Objective-C can be imported directly from the
generated `Module-Swift.h` header:

```z
import console from "std/console";
import Swift from "ZSwiftExample-Swift.h";

function main(): i32 {
  const counter = Swift.ZSwiftCounter.alloc().initWithValue(40);
  counter.value = 41;
  console.log(`swift=${counter.add(1)}`);
  return 0;
}
```

Declare the Swift build in `z.json`:

```json
{
  "target": {
    "name": "swift-interop",
    "entry": "main.zs",
    "swift": {
      "module": "ZSwiftExample",
      "sources": ["Counter.swift"],
      "frameworks": ["Foundation"]
    }
  }
}
```

The Z compiler builds the Swift library and compatibility header, shares the
generated include directory with compiler and editor analysis, then links the
products into the native executable.

## Swift-generated C++ values

Swift-native value types can cross through Swift's generated C++ interface:

```json
{
  "target": {
    "name": "swift-values",
    "entry": "main.zs",
    "swift": {
      "module": "ZSwiftOwned",
      "sources": ["OwnedCounter.swift"],
      "interop": "cxx"
    }
  }
}
```

```z
import Swift from "ZSwiftOwned-Swift.hpp";

const first = Swift.OwnedCounter.init(40);
const copied = first;
let changed = Swift.roundTrip(copied);
changed.setValue(42);
```

The generated value wrapper's native copy constructor and destructor become Z
copy and cleanup behavior. Swift associated-value enums can likewise use their
generated case factories when the C++ interface exposes them.

This is direct use of compiler-generated compatibility code—not a handwritten
Z shim—but it remains bounded by what the installed Swift toolchain exports.

## Project completion callbacks into tasks

An Objective-C-compatible Swift method may expose an escaping completion block.
An adjacent `.zd` can turn the relationship into an awaitable overload:

```z
callback completion {
  thread any;
  invoked once;
}

async completion(value, error) {
  return value;
  throw error;
}
```

The resulting Z call produces typed structured work:

```z
const result = attempt await worker.calculateChecked(42, false);

match (result) {
  success(value) => publish(value);
  failure(error) => report(error);
}
```

`invoked once` is a behavioral contract supplied by the library author. Z keeps
the task frame alive until completion, checks duplicate invocation, enters the
runtime for callbacks arriving on foreign threads, and preserves the raw
callback-taking overload for callers that need it.

Main-actor metadata enters the same executor model as Objective-C:

```z
const value = await on thread.main worker.calculate(42);
```

## What remains future work

The current strategy reaches a useful set of Apple APIs and Swift packages
whose public surface is representable through generated Objective-C or C++
compatibility interfaces. It does not yet provide general direct Swift ABI
interop.

Important remaining boundaries include:

- noncopyable (`~Copyable`) Swift values unavailable to generated C++;
- native Swift protocols and generic metadata;
- general Swift package/module import;
- Swift-native async functions not exported through a compatible callback;
- ownership and resilience rules that require direct Swift ABI metadata.

Those may eventually justify a direct Swift importer and ABI layer. The current
compatibility route is intentionally useful without freezing Z around unstable
or private implementation details.

:::note[Cost model]
Objective-C-compatible classes use ordinary ARC message sends. C++ compatibility
values use the generated wrapper's direct construction, copies, calls, and
destruction. Callback-to-task projection allocates and retains the task frame
required to survive the native asynchronous callback.
:::

Runnable examples:
[Swift class](https://github.com/popaprozac/z/tree/main/examples/interop/swift/swift-interop),
[Swift owned value](https://github.com/popaprozac/z/tree/main/examples/interop/swift/swift-value-interop),
[Swift enum](https://github.com/popaprozac/z/tree/main/examples/interop/swift/swift-enum-interop),
and [callback-to-task](https://github.com/popaprozac/z/tree/main/examples/interop/swift/swift-task-scope).

Next: [Exporting Z through C](/interop/exporting-z-through-c/).

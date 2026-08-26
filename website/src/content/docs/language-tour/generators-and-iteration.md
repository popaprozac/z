---
title: Generators and iteration
description: Produce lazy synchronous or asynchronous sequences without confusing sequence values with local expression results.
sidebar:
  order: 15
---

Generators are cold, move-only state machines. Calling a generator function
creates its frame; the function body begins when the sequence is advanced.

```z
import console from "std/console";
import { Generator } from "std/iteration";

function noteIdentifiers(count: i32): Generator<i32> {
  console.log("generator started");
  let identifier = 1;

  while (identifier <= count) {
    yield identifier;
    identifier = identifier + 1;
  }
}

const identifiers = noteIdentifiers(3); // body has not started

for (const identifier of identifiers) {
  console.log(`note ${identifier}`);
}
```

`yield` emits one sequence element and suspends the generator frame. It is
deliberately different from `select`, which supplies the value of a local
expression block, and `return`, which completes the function.

## Advance a generator directly

The common `Generator<T>` shape exposes `next(): Option<T>`:

```z
const values = noteIdentifiers(2);

const first = values.next();
const observed = match (first) {
  some(value) => value;
  none => 0;
};
```

`some(value)` contains the next yielded element. `none` means the generator has
completed. A generator is one evolving owner, so it cannot be copied into two
independent cursors accidentally.

## Return a completion value

A second type parameter makes the terminal result explicit:

```z
import { Generator } from "std/iteration";

struct ScanSummary {
  values: i32;
  total: i32;
}

function scan(count: i32): Generator<i32, ScanSummary> {
  let current = 1;
  let total = 0;

  while (current <= count) {
    total = total + current;
    yield current;
    current = current + 1;
  }

  return ScanSummary({ values: count, total });
}
```

Advancing this generator returns an exhaustive step rather than `Option<T>`:

```z
const scanner = scan(3);
const step = scanner.next();

match (step) {
  yielded(value) => inspect(value);
  complete(summary) => publish(summary);
}
```

The return value is not another yielded element. Consumers that care only
about elements can use `for...of`; consumers that need the terminal result use
`next()` and match `yielded` against `complete`. Direct advancement requires a
named generator handle so the evolving frame's ownership remains visible.

## Fallible generators

Generator failure uses the ordinary typed error channel:

```z
struct ReadError {
  code: i32;
}

function readings(fail: boolean): Generator<i32> throws ReadError {
  yield 20;
  if (fail) throw ReadError({ code: 7 });
  yield 22;
}
```

The stored callable shape includes the error type as its third parameter:
`Generator<i32, void, ReadError>`. Advancing it is fallible, so `try
values.next()` propagates and `attempt values.next()` materializes a
`Result<Option<i32>, ReadError>`.

## Custom iterators

Types can implement the nominal `Iterator<T>` contract directly:

```z
import { Iterator } from "std/iteration";

struct Countdown implements Iterator<i32> {
  current: i32;

  function next(inout this): Option<i32> {
    if (this.current == 0) return Option.none;

    const value = this.current;
    this.current = this.current - 1;
    return Option.some(value);
  }
}

let countdown = Countdown({ current: 3 });

for (const value of inout countdown) {
  inspect(value);
}
```

The explicit `inout` iteration shows that advancing this stored iterator
mutates its cursor. Arrays, slices, maps, sets, iterators, and generators share
the `for...of` surface without pretending they have identical storage.

## Async generators

An async generator may suspend between elements:

```z
import { AsyncGenerator } from "std/iteration";
import { delay } from "std/time";

async function readings(): AsyncGenerator<i32> {
  yield 20;
  await delay(1);
  yield 22;
}

async function collect(): i32 {
  let total = 0;

  for await (const reading of readings()) {
    total = total + reading;
  }

  return total;
}
```

Use `await sequence.next()` for direct advancement. Async generators can also
carry a completion value with `AsyncGenerator<Yield, Return>` and a typed error
with `AsyncGenerator<Yield, Return, Error>`.

Fallible async iteration keeps propagation visible at the loop boundary:

```z
try for await (const reading of fallibleReadings()) {
  consume(reading);
}
```

This is separate from `task`: a task is hot structured work that starts when
created, while a generator is a cold sequence advanced by its consumer.

:::note[Cost model]
Generators lower to owned state-machine frames. Locals that survive a `yield`
live in the frame, and each `next()` advances one state transition. Async
generators combine that frame with task suspension; they do not allocate a
complete collection before iteration begins.
:::

Runnable examples:
[synchronous generators](https://github.com/popaprozac/z/blob/main/examples/language/control-flow/generators.zs),
[completion values](https://github.com/popaprozac/z/blob/main/examples/language/control-flow/generator-return.zs),
[custom iterators](https://github.com/popaprozac/z/blob/main/examples/language/control-flow/custom-iterator.zs),
and [async iteration](https://github.com/popaprozac/z/blob/main/examples/language/control-flow/async-for-await.zs).

Next: [Files, processes, and system APIs](/language-tour/files-processes-and-system-apis/).

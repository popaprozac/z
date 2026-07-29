# Testing Z

Z's bootstrap test suite is divided by architectural responsibility. This
keeps failures attributable, allows CI tiers to run in parallel, and prevents
Apple-toolchain integration tests from delaying unrelated language feedback.

Run the complete suite:

```sh
bun run test
```

Run one tier while developing:

| Command | Coverage |
|---|---|
| `bun run test:language` | Core syntax, semantics, ownership, collections, generators, errors, standard modules, and editor smoke tests |
| `bun run test:native-interop` | C ABI export, C/C++ imports, `.zd`, callbacks, `unsafe`, and `raw` |
| `bun run test:objc-interop` | Objective-C, AppKit, application pressure tests, ARC, and callback lifetimes |
| `bun run test:swift-interop` | Generated Objective-C/C++ Swift interfaces, task projection, and current ABI boundaries |
| `bun run test:self-hosting` | Native lexer, parser, resolver, semantic evidence, emission, fixed point, and standalone driver |
| `bun run test:async` | Async expressions, tasks, cancellation, executor placement, native threads, and ownership across suspension |

The shared utilities in `tests/support/bootstrap.ts` provide repository paths,
editor-token decoding, host-toolchain timeouts, and writable Clang/Swift module
caches. Tests launch native child processes with Bun's orphan cleanup enabled,
so a timeout does not leave Clang or Swift work running behind later tests.

## CI shape

CI first prepares and caches the content-addressed native frontend. Independent
macOS jobs then run the six tiers in parallel. Clang and Swift module caches are
keyed by the Apple toolchain and by tier. The Swift tier also caches generated
compatibility targets using a key derived from their source and project
configuration.

This separates two different performance concerns:

- fast semantic tests should remain sub-second whenever possible;
- native, Swift, application, and fixed-point tests receive explicit budgets
  because they intentionally execute external toolchains.

The complete `bun run test` suite remains the local pre-commit authority. The tier split
changes orchestration, not coverage: every test must belong to exactly one
domain file.

## Native Z tests

The first native test-runner slice is implemented. Tests are top-level
declarations and may live beside the code they exercise:

```z
import { expect } from "std/test";

function add(left: i32, right: i32): i32 {
  return left + right;
}

test "add combines two values" {
  const answer = add(20, 22);
  expect(answer).toEqual(42);
}
```

Expectation helpers are ordinary imports rather than additional test-only
syntax:

```z
import { expect, fail } from "std/test";

test "an owned value can be checked without moving it" {
  const status = "ready";
  expect(in status).toEqual("ready");
}
```

`expect(actual).toEqual(expected)` uses the same `==` semantics as ordinary Z
code. It does not introduce deep structural comparison. Both operands are
borrowed for the expectation statement; the explicit `in` spelling is optional
and is equivalent to the inferred immutable borrow. `fail(message)` ends the
current test explicitly. Cleanup-bearing expression results must first be bound
to named storage so their lifetime remains visible. Tests do not acquire an
implicit user-facing `throws` channel; use `fail` for an unconditional failure.

Expectation failures run deterministic cleanup, return an internal owned
`String` failure to the runner, and do not prevent later tests from running.
The first tier keeps `expect` and `fail` directly inside test declarations;
reusable assertion-helper functions require a future public test-context
mechanism.

Run a source module and tests in its project-owned import graph with:

```sh
bun run z test path/to/module.test.zs

# After `bun run bootstrap`:
.z-cache/bootstrap/z test path/to/module.test.zs
```

`*.test.zs` is an organizational convention, not a separate source mode.
Inline tests can use private declarations from their own module; dedicated
test modules exercise exported APIs through ordinary imports. Normal `build`,
`run`, and `emit` paths omit test bodies, names, and runner code.

Both Stage 0 and the fixed-point native `z` compile synchronous test bodies
into one native runner. The native command discovers tests in the entry
module's owned import graph, preserves source locations in expectation
failures, continues after failures, and exits nonzero when any test fails.
Filtering, project-wide discovery, reusable assertion helpers, and async tests
are the next testing layers. Their surface is not inferred from Bun's bootstrap
API.

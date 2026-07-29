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

A native `z test` runner remains planned. Its declaration syntax, assertion
surface, discovery rules, filtering, and isolation model are intentionally not
settled here. They will be designed before implementation rather than inferred
from the bootstrap runner.

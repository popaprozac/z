---
title: Reference map
description: Find exact Z semantics, implementation boundaries, diagnostics, and design rationale.
---

Z is pre-alpha, so its documentation separates three questions that are easy to
conflate:

1. **What does accepted Z source mean?**
2. **Which accepted shapes do the current compiler tiers execute?**
3. **Why was the language designed this way, and what remains unsettled?**

Use the source that matches the question.

## Language semantics

The repository's
[language reference](https://github.com/popaprozac/z/blob/main/docs/language-reference.md)
is the current authoritative summary of accepted source semantics. It covers
declarations, types, ownership, control flow, errors, generics, tasks, threads,
native interfaces, and compilation.

The website's [language guide](/language-tour/) explains the same model
progressively. When guide prose and exact wording appear to differ, report the
discrepancy—the reference should provide the precise answer and both should be
kept synchronized.

## Compiler coverage

The [implementation status](/reference/status/) records tested behavior and
temporary compiler boundaries.

Status terms are used consistently:

| Status | Meaning |
| --- | --- |
| Implemented | Parsed, checked, lowered, and regression-tested for the stated surface |
| Partial | A useful executable tier exists with named limitations |
| Experimental | Implemented evidence exists, but the design or breadth may still change |
| Designed | The semantic direction is accepted but is not yet generally executable |
| Planned | A desired investigation or capability, not current behavior |

The detailed
[bootstrap status](https://github.com/popaprozac/z/blob/main/docs/bootstrap-status.md)
tracks Stage-0 and fixed-point native compiler parity. It is intentionally more
technical and transient than the language guide.

## Focused references

| Topic | Reference |
| --- | --- |
| Diagnostics and error codes | [Diagnostics](https://github.com/popaprozac/z/blob/main/docs/diagnostics.md) |
| Testing and test tiers | [Testing](https://github.com/popaprozac/z/blob/main/docs/testing.md) |
| Async tasks and cancellation | [Async model](https://github.com/popaprozac/z/blob/main/docs/async-model.md) |
| Executor and thread placement | [Executor placement](https://github.com/popaprozac/z/blob/main/docs/executor-placement.md) |
| Native interop safety tiers | [Interop model](https://github.com/popaprozac/z/blob/main/docs/interop-model.md) |
| `.zd` vocabulary and contracts | [Z declarations](https://github.com/popaprozac/z/blob/main/docs/z-declarations.md) |
| Exporting a C ABI from Z | [C exports](https://github.com/popaprozac/z/blob/main/docs/c-exports.md) |
| Performance methodology and evidence | [Performance](https://github.com/popaprozac/z/blob/main/docs/performance.md) |
| Real-program ownership findings | [Ownership pressure](https://github.com/popaprozac/z/blob/main/docs/ownership-pressure.md) |

These repository documents will move into fully navigable website reference
pages incrementally. Linking the maintained sources now avoids publishing a
second stale copy during that migration.

## Design rationale

[`DESIGN.md`](https://github.com/popaprozac/z/blob/main/DESIGN.md) records the
language charter, rationale, accepted directions, and deliberately open design
questions. It is not a substitute for the language reference: design notes may
discuss future syntax and experiments that are not current Z behavior.

## File and tool reference

| Surface | Purpose |
| --- | --- |
| `.zs` | Z source module |
| `.zd` | Additive checked semantic contract for a foreign module |
| `z.json` | Project target, entry point, linkage, and build configuration |
| `z check` | Parse, type-check, and validate ownership |
| `z emit` | Inspect the generated C-family translation unit |
| `z build` | Build the configured native artifact |
| `z run` | Build and execute a program |
| `z test` | Discover and run reachable inline Z tests |
| `z metadata` | Produce versioned checked metadata for tools and generators |

During bootstrap, the Stage-0 forms are invoked through `bun run z`; the
bootstrapped native executable uses the same command surface directly.

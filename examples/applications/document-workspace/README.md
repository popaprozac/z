# Document workspace

This example is a small native application model rather than an isolated syntax
probe. It opens documents, keeps their native leases alive while registered,
looks them up without copying, records saves, reports domain errors, and proves
that every native lease is released when the workspace finishes.

Run it from the repository root:

```sh
bun run z run examples/applications/document-workspace/main.zs
```

Expected shape:

```text
workspace registered=3, saved=3, found=42, endpoints=40..42, save count=1, rejected=100, empty save=200, native moves=<count>, live=0
```

The exact move count is an implementation observation. `live=0` is the lifetime
invariant.

## Read it in this order

1. [`document.zs`](document.zs) defines the domain model. `DocumentSession` owns a
   title and a move-only native `DocumentLease`. `WorkspaceError` owns a useful
   message. `DocumentOpenResult` distinguishes an opened document from a
   rejected request.
2. [`workspace.zs`](workspace.zs) owns `Array<DocumentSession>`. Registration
   consumes an opened session into that array, receiver and module-function
   lookup return `Option<view DocumentSession>`, `endpoints()` returns two
   receiver-provenanced views together as `DocumentSelection`, the module
   wrapper forwards that provenance, and saving mutates each registered session.
3. [`main.zs`](main.zs) runs one understandable scenario: reject an invalid draft,
   register three documents, look one up, save them, and inspect the outcome.
4. [`document-lease.hpp`](../../../tests/fixtures/document-lease.hpp) is the
   deterministic native resource used by the probe. Its adjacent
   [`.zd` contract](../../../tests/fixtures/document-lease.hpp.zd) declares that
   the type moves and deinitializes but does not copy.

## Why the ownership syntax appears

| Source shape | Application meaning |
| --- | --- |
| `inout workspace` | saving or registration may mutate the caller's workspace |
| `DocumentOpenResult.opened(document)` | a successfully opened native session has one owner |
| consuming `match (opened)` | the selected session moves from the result into the matching arm |
| `documents.push(document)` | the workspace takes ownership of the open session |
| `Option<view DocumentSession>` | lookup borrows an existing document without copying its title or native lease |
| `findWorkspaceDocument(..., in workspace)` | a module function forwards the optional view while retaining its input-owner provenance |
| `workspace.endpoints()` | returns a stack value containing two borrowed pointers tied to the immutable receiver, with no allocation or retain |
| `selectWorkspaceEndpoints(in workspace)` | forwards that aggregate while preserving the caller's workspace provenance |
| `const { first, last } = ...` | splits the aggregate into two views; the workspace loan ends only after both bindings' final use |
| `match (in found)` | inspecting the optional view does not consume it or its workspace owner |
| `attempt saveWorkspace(...)` | the caller keeps `Result<i32, WorkspaceError>` to handle success and failure locally |
| `liveDocumentLeases()` after the scenario | verifies deterministic native cleanup after the workspace leaves scope |

The example intentionally mutates the workspace after both the optional-view
match and the two destructured endpoint views' final reads. This is safe because
both module-returned loans have ended; attempting the mutation while either
binding is still live is rejected.

## Pressure-test findings

Building this example closed four bootstrap gaps:

- module-linked named enums now retain move-only payload support instead of
  being mistaken for compiler-generated `Option` or `Result` storage;
- synchronous thrown errors may own cleanup-bearing fields such as `String`,
  and `throw` transfers that ownership into `Result`;
- borrowing methods can be called directly through `view T` and
  `Option<view T>` bindings without generating a pointer-to-pointer.
- `throw` now uses ordinary owned-value lowering, so a directly constructed
  error may contain an interpolated owned `String` without a temporary factory
  or code-generation failure.

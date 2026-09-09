---
title: Project status
description: What Z proves today and what remains experimental.
---

Z is pre-alpha. It has moved beyond a toy compiler, but it is not ready for
production or compatibility-sensitive use.

## Implemented and exercised

- TypeScript-shaped parsing, nominal static types, generics, enums, exhaustive
  matching, `Option<T>`, `Result<T, E>`, typed errors, and statically dispatched
  trait constraints that specialize across module-private boundaries
- Value structs, ARC-managed classes, weak references, explicit ownership
  capabilities, deterministic cleanup, and conservative non-escaping views
- Native C-family code generation through Clang
- Header-first C and Objective-C interop, substantial `.zd` contracts, and
  selected C++ values, methods, namespaces, RAII, and move-only resources
- A visible native WebKit round trip whose executable `main`, consuming
  portable application builder, selected platform-module seam, UI ownership,
  protocol handler and owned `objc.adapt<P>` carrier with direct `id<P>` ABI,
  dynamic `id` class narrowing, typed JSON routing, frozen synchronous and
  suspending Z service dispatch, generated TypeScript binding, application
  `TaskScope`, and registration lifetime are implemented in Z. A foreign
  WebKit callback can now submit an owned request, suspend inside the Z
  service, publish its result on `thread.main`, and be cancelled and joined
  before lifecycle shutdown
- Arrays, strings, maps, sets, filesystem/process primitives, synchronization,
  arenas, JSON foundations, and inline Z tests
- Readonly collections preserve ownership and deterministic cleanup in both
  semantic frontends, including aliases and nested aggregate/optional storage.
  Readonly access does not imply borrowing or implicit shared ownership
- Structured tasks, cancellation, executor placement, dedicated native threads,
  `Mutex<T>`, `Once<T>`, and bounded MPSC `Channel<T>` communication across
  proven slices. Channels split shareable async `Sender<T>` from unique async
  `Receiver<T>`, preserve unsent ownership through `ChannelClosed<T>`, suspend
  task frames under backpressure, wake cleanly on close/cancellation, and expose
  explicit blocking `SyncSender<T>` / `SyncReceiver<T>` conversions for native
  threads. Both compilers execute bounded synchronous channels, including
  owned unsent errors, queue cleanup, cross-module storage, and readiness
  signaling from a yielding worker that is later cancelled and joined. Native
  worker capture lookup includes renamed object-destructured sender bindings;
  storing fallible owned values in arrays and channels transfers normalized
  temporaries without duplicate cleanup. Stage 0 nested value-producing async
  matches share one destination and preserve cleanup across suspension, early
  return, failure, and cancellation. These are composition fixes with existing
  syntax, not a general expansion of async storage support. Native
  asynchronous send/receive still report `Z0700`; async waiter execution uses
  Stage 0. Native custom-destructor and foreign-resource transfer proofs remain
  conservative. The hybrid `bun run z check <source> --native-frontend` retains
  native semantic parity coverage. Unbounded and rendezvous storage, selection, timeouts, and
  concurrent receive loans remain future tiers
- Native synchronous `void` block callbacks, including typed throwing callbacks,
  can own local Strings, value aggregates, and consuming match payloads. Each
  invocation cleans up on return, failure, loop exit, or normal completion;
  captures remain owned by the separately retained closure environment. Exact
  cleanup-order and allocation-balance tests cover both compiler paths.
  Ordinary object destructuring rejects root or nested inline custom cleanup
  in both semantic frontends, including aliased and generic payloads; supported
  owned value fields and ARC aliases remain available
- Stored synchronous callables and a Stage 0 stored-async task tier that
  preserve either `thread.main` isolation or arbitrary-thread `thread.any`
  sharing without scheduling implicitly. Native lowering now preserves the
  distinct asynchronous start-frame ABI through aggregate storage and executes
  captured, nonthrowing expression closures. Primitive and ownership-bearing
  results transfer exactly once; an unclaimed owned result is destroyed with
  its frame. A void closure containing one direct `await scheduler.yield()` now
  polls and requeues on a local FIFO executor. The first linear async `main`
  shape now owns its callable local, one ordinary local, and child invocation in
  a persistent heap frame. A cleanup-free local crosses as the child's single
  value argument; a cleanup-bearing owner crosses as an address-stable `in`
  borrow and remains guarded by frame live state. Both normal completion and
  unfinished-frame destruction clean that owner exactly once. Parent-frame
  cancellation now propagates through the dynamic child poll, wakes the parent,
  and deterministically unwinds child, callable, and owner storage. Public
  `task handler(...)` preserves `Task<T, E>` through explicit join, typed
  `try`/`attempt`, cancellation, lexical implicit join, and borrowed-owner
  cleanup in Stage 0. The fixed-point emitter now executes the first bounded
  unnamed-scope version: one stored nonthrowing void callable, one hot task, one
  explicit join or cancellation join, and one optional borrowed owner. Typed
  task results/errors, implicit scope-exit join, broader native function bodies,
  and multiple locals, arguments, and children remain in progress. Direct calls
  to imported async free functions with cleanup-free signatures now also cross
  the fixed-point compiler through a heap-owned task adapter. They may complete
  immediately or begin with one direct `await scheduler.yield()` before a
  synchronous tail. A directly awaited non-consuming ARC class method may use
  that one-yield shape with borrowed or cleanup-free arguments and an owned
  result or typed error; the frame retains the receiver and transfers or
  destroys that result exactly once. A direct async adapter whose body is one tail
  `return await handler(...)` now composes a real heap-owned parent and dynamic
  child. It stores owned and borrowed inputs, resumes through the child's waiter,
  propagates cancellation, and transfers or destroys the owned result exactly
  once. General suspending bodies with locals and control flow around the child
  remain the next library-composition boundary. A non-consuming ARC class
  method may use that same tail adapter; its parent frame retains the receiver
  through child completion and cancellation. Straight-line locals declared
  before the await are frame-owned as well, so cleanup-bearing request values
  may be lent safely to the suspended child. Non-suspending prefix loops and
  early-result branches also execute in that frame. A final consuming
  enum/`Option` match may move one selected owned async handler into guarded
  frame storage, suspend only that arm, and complete alternate arms immediately.
  Synchronous and asynchronous callable types retain distinct native identities
  even when their ordinary signatures match. Direct async free functions may
  use the same prefixed/matched tail-child frame. A direct free function may
  also initialize one local from an awaited ARC method, resume through the
  child waiter, and run a synchronous suffix against that frame-owned result.
  A generic captured async closure may directly await a non-consuming service
  method; each cold invocation retains its environment, preserves borrowed
  arguments through the join, and forwards cancellation to the child.
- An opt-in application pressure test stores `thread.any` async service handlers in a
  frozen map and executes a complete headless bridge request through a real
  suspension and typed response. The native semantic frontend agrees on the
  graph. Its retained, cleanup-bearing `SearchService.invoke` method and the
  containing `AsyncServices.invoke` router now emit natively through loops,
  maps, owned locals, a consuming handler match, and a dynamic child await. The
  outer bridge's decoded-request match now emits through a free-function child
  frame, and its dispatch helper can retain an awaited service result across
  suspension before running the synchronous response-mapping suffix. The
  generic captured async service adapter emits and executes too. The complete
  smoke now executes both its synchronous health route and its suspended search
  route under strict C compilation. This pressure test closed consuming-match
  owner transfer, cleanup-bearing immediate arms, ARC value-argument retains,
  and synchronous control flow after an await. Both requests now run inside one
  ordinary reusable async free function whose heap-owned frame advances through
  two awaited children. Parameters and owned locals remain stable across both
  joins and cancellation follows the active child. The second join may be an
  explicit `await on thread.main publish(value)` call after an ordinary service
  method await; borrowed value parameters are addressed from stable parent-frame
  storage rather than a transient poll-stack alias. Imported `TaskScope` and
  `TaskControl` identities are canonical across modules; aggregate field copies
  use their runtime retain operations, and scope finalization happens after an
  active `return await` child rather than before it starts. Scheduled ARC
  captures receive exactly one storage retain. Arbitrary suspension
  counts, branches between awaits, and equivalent general async method bodies
  remain future frame tiers. The visible WebKit application now imports and
  executes this surface rather than keeping it headless-only. The fixed-point
  compiler also executes its explicit `new TaskScope()` lifecycle: a foreign
  callback schedules an owned async closure on `thread.main`, cleanup-bearing
  captures and moved parameters transfer through guarded frame storage, and
  `close()` joins or cancels them exactly once. A scope with no enclosing Z task
  owns a serial fallback executor on the current thread; it does not create an
  OS thread. Z Notes now runs this complete path through the standalone native
  driver without a Stage 0 override.
- The native launch-listener prerequisite now retains a `TaskScope` captured by
  an ordinary `thread.spawn(async move ...)` closure. A terminal await of a named
  nonthrowing `void`/`i32` yielding helper propagates worker cancellation into its
  cold frame and joins nested children before releasing parent storage. Admitted
  main-thread wakeups remain separately owned and joined by the scope. Bounded
  UBSan tests cover pre-entry cancellation, closed-scope rejection, repeated
  teardown, and exact reference counts. General worker bodies and cross-thread
  `TaskControl` capture remain staged. The real endpoint/inbox/main-host probe
  now passes under both compilers and UBSan, including competing startup,
  closed-scope rejection, idle/partial-client cancellation, and startup failure.
  Root owned match initializers also work in the native yielding frame, with
  cleanup on failed initialization and cancellation. Checked call identities
  now survive native-header private-name mangling across modules, including
  aliased internal async imports. The channel-based readiness/startup probe
  passes both compilers under UBSan. The complete native Zapp startup gate now
  passes automatic primary/secondary forwarding and endpoint/service-startup
  rollback, without starting secondary AppKit or services. Early terminal awaited returns
  now compose with one later awaited local in native function and supported
  method frames, including owned results and cancellation cleanup. Both paths
  reuse one child-invocation slot. Sequential root `TaskScope.close()`/`cancel()`
  joins now preserve that awaited value, resume each following segment once,
  and join admitted work before parent cleanup. Same-executor joins suspend on
  a waiter; separate-driver scopes retain the existing synchronous bridge.
  Root-local `new TaskScope()` values now join their children on function exit,
  including cancellation that skips an explicit await. Errors and cancellation
  cancel the remaining work; normal return waits for it. Moving the handle
  does not remove this obligation. Sequential `await worker.cancel()` also
  preserves the owned result. Native worker handles join before parent storage
  is released on early return, failure, or parent cancellation; explicitly
  cancelling a worker does not cancel its parent. Pending main-thread requests
  wake the join frame and are serviced before it finishes. Nested scope
  constructors and branch-local storage across suspension remain staged.
  Returned consuming matches can nest around one terminal child await; enclosing
  payloads remain owned by the frame. Single-statement `select` blocks and
  payload-free arms are supported; throwing parents use `try await`. Root
  destructuring preserves selected locals across continuation states and cleans
  unselected fields in its synchronous extraction group. These cases reuse the
  existing frame rather than allocating a separate task per match or binding. Direct
  timer awaits in native `main` still require a future resumable entry frame;
  that boundary now reports `Z0700` at the await.
- Language-server highlighting, hover, completion, diagnostics, and `z.json`
  schema support
- Exact `z.json` source-module mappings for bare imports in Stage 0, the editor,
  and the fixed-point native compiler; package versions and installation remain
  separate future tooling
- Versioned `.zbuild.json` overlays resolve tool-generated modules for one
  project invocation in Stage 0 and the fixed-point native driver without
  mutating authored source or `z.json`. Both drivers additionally execute
  source-hashed, exact-target checked call adaptation without rewriting authored
  files. A packaged generated module may authorize its one synthetic replacement
  access to a same-package `internal` method without exposing that method to
  authored consumers; the fixed-point driver owns the SHA-256 and native AST
  transformation. Validated adapter references are function links rather than
  source-initialization edges, allowing adapters to import entry-defined
  exported types. Ordinary import cycles, including those inside generated
  source, remain errors; generated roots and their dependencies stay checked,
  emitted, and tracked for build invalidation.
- A standalone native compiler capable of rebuilding its own constrained source
  graph to a fixed point
- Compiler API 2 and `z metadata`, exposing versioned checked public symbols and
  public call sites to tools without source scanning. External tools can derive
  typed service bindings from this artifact.

## Partial and still expanding

- Feature composition across every ownership, closure, async, and storage shape
- General suspension and thread-affine continuation behavior
- Library-scale C++ coverage and generated Swift/Objective-C compatibility
- The self-hosted compiler's authority over the complete language surface
- Standard-library breadth, diagnostics polish, compilation latency, and editor
  refactoring support
- Linux and Windows validation comparable to the project's macOS pressure tests
- Target-selected platform compilation with inactive-code-aware editor
  behavior; the manifest target is authoritative today, while source-level
  compile-time selection syntax remains deliberately unsettled

## Planned, not promised as current behavior

- A package manager, registry, lockfile, and compatibility policy
- Production release artifacts and a stable bootstrap chain
- Native Swift ABI interoperability, Swift value types, protocols, and concurrency
- ORC cycle collection, richer regions, and carefully bounded shape-stability or
  local-uniqueness analysis
- Fuzzing, sanitizer coverage, deterministic release engineering, debugger
  integration, and ecosystem-scale hardening

The repository's [bootstrap status](https://github.com/popaprozac/z/blob/main/docs/bootstrap-status.md)
is the source of truth for temporary implementation limits. The
[language reference](https://github.com/popaprozac/z/blob/main/docs/language-reference.md)
records accepted semantics independently of which bootstrap tiers execute every
shape today.

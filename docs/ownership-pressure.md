# Ownership pressure log

This log tests Z's ownership model against application-shaped code. It records
observed friction before changing the language, and separates ownership-model
questions from bootstrap implementation gaps.

## Desktop probe 1: owned model plus AppKit shell

Source: [`examples/interop/objc/desktop-ownership`](../examples/interop/objc/desktop-ownership)

What works:

- an ARC-managed `Workspace` can be shared while its methods mutate through an
  explicit `inout this` capability;
- `Array<Document>` owns move-only struct elements containing owned `String`
  values, and `push` transfers each document into stable application state;
- borrowed methods inspect scalar state without copying or exposing storage;
- imported AppKit classes are nominal Z types, so an ARC-managed
  `WindowController` stores both `AppKit.NSWindow` and the Z-owned `Workspace`;
- native run output streams immediately, so diagnostics emitted before entering
  AppKit's event loop are visible while the window is still open.

## Pressure 1: borrowed views cannot escape

A borrowed method can return a copied scalar such as `i32`, but it cannot return
an owned `String` field from a borrowed document without transferring that field
out of borrowed storage. `Slice<T>` similarly cannot be returned or stored
today. This is the deliberate non-escaping wall that replaces explicit source
lifetimes in the current model.

Keep these candidate spikes available when a real caller needs a view:

1. a scoped callback such as `withDocument(index, (in document) => ...)`, which
   keeps the borrow lexical;
2. an explicit owned snapshot/copy API when copying is the desired contract;
3. the implemented inferred `view` return whose lifetime is tied to a
   value-struct receiver, without exposing general lifetime annotations;
4. a region or generational-borrow experiment if scoped callbacks become common
   enough to harm readability.

Do not choose among them from syntax alone. Add the smallest spike when a real
program needs to retain or return a view, then compare call sites, diagnostics,
code generation, and optimizer results.

The deterministic [`ownership-views.zs`](../examples/interop/objc/desktop-ownership/ownership-views.zs) probe now
exercises candidates 1 through 3 against the same lookup:

| Shape | Source contract | Generated cost | Usability boundary |
| --- | --- | --- | --- |
| `withDocument(id, callback)` | callback receives `in Document` | `const Document *`, stack closure environment, indirect call; no title copy | zero-copy, but all use is nested inside the callback |
| `documentSnapshot(id)` | returns owned `Option<Document>` | option tag plus a new `String` allocation and exact byte copy | straight-line and remains valid across workspace mutation |
| `documentAt(index): view Document` | inferred receiver-tied borrow | `const Document *`, bounds check, no document or string copy | straight-line until the view's last use; owner mutation is then permitted |
| `document(id): Option<view Document>` | optional receiver-tied borrow, inspected with `match (in result)` | one `const Document *`; `NULL` is `none`, no tag or string copy | natural fallible lookup; `some` inherits owner provenance and `none` carries no borrow |

The scoped form reads naturally for enumeration and one operation. It becomes
awkward when several later statements need the selected document. The snapshot
is semantically honest when the result must survive `Workspace.open`, but its
copy would be accidental overhead for immediate read-only use.

This evidence produced a narrow receiver-tied read-only view rather than general
lifetime parameters. Its provenance is one borrowed value-struct receiver; it
is non-storable, may enter a synchronous `in T` call, and may be read through an
inline closure whose synchronous `in` destination proves nonescape. Stored,
owned, and escaping captures remain rejected, and receiver mutation is
rejected until the view's last use. `Option<view T>` carries the same provenance
through a constrained local enum shape without admitting general borrowed enum
storage. ARC class owners remain excluded because an alias could mutate the same
storage. Callers needing aliasing or survival across reallocation must use an
owned snapshot or a future stable reference model.

A later compiler-frontend pressure test established one deliberate exception to
the “borrow stays borrowed” rule: when `T` is already cleanup-free and copyable,
a value context may load an independent `T` from `view T`. The generated cost is
its ordinary by-value load: one load for a scalar and the normal value-copy cost
for a cleanup-free aggregate. Cleanup-bearing and move-only targets do not
qualify, so the conversion cannot manufacture ownership or bypass deterministic
destruction.

Concise and block-bodied `match`/`if` expression arms now apply that conversion
before their result types are unified. This preserves the distinction between
`select`, which supplies a local expression value, and `return`, which exits the
enclosing function at any nesting depth.

The follow-up [`arena.zs`](../examples/language/ownership/arena.zs) probe gives a
region owner stable allocation addresses. Multiple direct views coexist across
later allocation; `reset` and destruction are excluded until their last uses.
Generated code omits cleanup records for trivial values and registers reverse
cleanup only for `deinit`, ARC, owned native, or C++ RAII storage. This validates
a useful region shape without yet admitting stored projections or async views.
Receiver and Arena views now register the same shared `in` loan used by the
call/task exclusivity checker. An inline nonescaping closure may copy the view
pointer into its stack environment; the loan ends after that call, so later
owner mutation or Arena reset is legal.

## Pressure 2: imported Objective-C references in owned Z state

Resolved for non-null class references: `AppKit.NSWindow` is a nominal source
type and can be used in Z fields and signatures. The desktop probe stores a
window on an ARC-managed Z `WindowController`. Generated Objective-C uses a
strong field, zero-initializes class storage before the first ARC assignment,
and clears the field before freeing the surrounding Z allocation.

Nullable imported references remain a distinct one-pointer type and editor
services display them as `T | null`. Z now rejects unchecked member access and
narrows after explicit `value != null` / `value == null` control flow. An
explicit source annotation is supported for imported Objective-C reference
fields, parameters, returns, and locals. Protocol-qualified `id`, weak/unowned
foreign fields, and ownership attributes imported from API notes remain later
slices.

## Pressure 3: interactive AppKit adapter surfaces

Resolved for both one-shot and persistent Objective-C block shapes. The desktop
probe passes an owned `move` closure to `beginWithCompletionHandler`. AppKit
copies the block; a generated ARC box retains the Z closure environment and
releases it exactly once when the native block dies. The completion event
mutates the owned `Workspace`, proving a real AppKit-to-Z state path rather
than a static window.

The persistent notification probe registers blocks with
`NSNotificationCenter`, retains each returned observer token, weakly captures
ARC-managed Z state, receives repeated events, and explicitly unregisters both
tokens after the AppKit event loop returns. A deterministic Foundation fixture
posts twice, removes its token, and proves a third post cannot invoke the Z
closure. This validates the native token/block lifetime without creating a
strong reference cycle.

Borrowed captures are rejected at an escaping block boundary. Non-escaping
blocks can borrow lexically. Named function values, block returns with richer
foreign object ownership, target/action selector adapters, delegates,
cross-thread delivery, and Z-defined Objective-C protocol conformance remain
separate follow-ups.

## Pressure 4: owned strings across Objective-C

Resolved for non-null `NSString` boundaries. Computed Z strings can populate
Objective-C properties and arguments. Z passes `data + length` into an ARC
`NSString`, so embedded NUL bytes are preserved. In the reverse direction, an
explicit `String` destination copies a non-null `NSString` into fresh owned Z
storage using its exact UTF-8 byte length.

The copy is intentional: a Z `String` never borrows storage returned by
`UTF8String`, whose lifetime belongs to the Objective-C object. Nullable
`NSString` cannot convert until it is narrowed. Other encodings, zero-copy
views, mutable strings, and explicit conversion APIs remain later pressure
tests.

## Pressure 5: foreign RAII values inside Z aggregates

Resolved for copyable C++, move-only C++, and generated Swift C++ wrapper values
in the first synchronous storage tier. An adjacent
`.zd` type contract may constrain Clang-proven `copy`, `move`, and `deinit`
capabilities without repeating layout. The C++ probe copies a contracted value
into an owning Z struct, copies that struct, and observes three native drops with
zero live values. The Swift probe stores and copies `OwnedCounter` inside a Z
struct while its shared Swift class payload is released exactly once.

This relies on the C++ backend's native member construction, assignment, move
construction, and lexical destruction rather than byte copying or synthesized
destructor calls. The move-only probe borrows a native value, transfers it
through an owned function and a whole Z value struct, rejects later source use,
and observes zero live native values after scope exit.

## Application probe 2: document workspace

Source: [`examples/applications/document-workspace`](../examples/applications/document-workspace)

This cross-platform command-line probe uses application vocabulary rather than
ownership-test verbs. A `DocumentWorkspace` registers documents, rejects an
invalid draft, finds a session, grows after the lookup borrow ends, saves every
open document, and reports a summary. Each `DocumentSession` owns a `String`
title and a move-only C++ `DocumentLease`; the workspace owns a growable array
of sessions.

What the complete run proves:

- an exported named enum can move a native-owning `DocumentSession` across a Z
  module boundary and into `Array<DocumentSession>`;
- array growth native-move-constructs the mixed Z/C++ aggregate and final
  cleanup leaves zero live leases;
- `Option<view DocumentSession>` supports borrowing method calls, ends at last
  use, and permits later collection growth;
- a typed `WorkspaceError` owns an interpolated `String`, moves through
  `throw`, `try`, `attempt`, and `match`, and is cleaned on the handled path;
- `inout` at the ordinary function boundary makes workspace mutation visible
  without a callback-specific capability model.

The probe found three implementation bugs that are now closed: module-mangled
named enums were misclassified as compiler-generated result storage, calls
through optional views generated a pointer-to-pointer, and `throw` bypassed the
ordinary statement-valued lowering needed by directly constructed errors with
interpolated messages.

## Application probe 3: ownership boundaries across suspension

Source:
[`ownership-boundaries.zs`](../examples/interop/objc/desktop-ownership/ownership-boundaries.zs)

This probe applies the current alternatives to the same document lookup while
crossing from synchronous code into a task:

| Need | Current Z shape | Observed cost and boundary |
| --- | --- | --- |
| Immediate read from value-owned storage | `documentAt(index): view Document` before suspension | one checked pointer projection; no document or String copy; mutation and later suspension are legal after last use |
| Immediate read through ARC identity | `withDocument(id, (in document) => ...)` | zero-copy lexical callback; aliases cannot retain the document projection |
| Data that survives mutation and suspension | `documentSnapshot(id): Option<Document>` passed into a task | explicit owned document and String copy; ordinary straight-line use after `await` |

The complete run prints the IDs observed through all three contracts and mutates
both collections after the zero-copy accesses have ended. The snapshot remains
valid while its task is live and after the ARC-owned workspace grows.

One rejected shape remains a deliberate boundary:

- a free function cannot return `view Item` derived from an `in Store`
  parameter; the implemented provenance model requires a synchronous borrowed
  instance receiver.

Parameter provenance is still a design question. The two bootstrap composition
gaps found by the first version of this probe are now closed:

- a receiver view may be declared and read in an async function when its last
  use precedes the next suspension; the frame stores only its non-owning pointer,
  while semantic last-use analysis ends the owner loan before `await`;
- an inline nonescaping closure nested directly inside an async-frame call gets
  a stack environment in that state-machine case, invokes synchronously, and
  leaves no callable value in the task frame.

Using the view after the suspension keeps its loan live and is still rejected
before lowering.

This evidence does not justify user-visible lifetime syntax. The supported call
sites now compose without helper extraction across this application path.
Widening `view` to parameter-provenanced, stored, or class-owned projections
would be a separate design decision requiring new evidence.

## Application-shaped worker ownership

Z Notes now loads its persisted model through
`thread.spawn(async move (): Array<Note> throws i32 => ...)`. The worker owns a
copied path, a private executor, an operation-local ARC `NoteDatabase`, its
owned `sqlite3 *`, and every prepared statement. It suspends before the native
work, then opens, loads, finalizes, and closes entirely on that dedicated
thread. Only the owned `Array<Note>`—including each owned title/body
`String`—crosses back through `Task<T, E>`.

The long-lived database remains a separate main-owned instance while startup
loading and interactive saves use worker-local handles. This is stronger
evidence than marking the SQLite handle sendable: the application does not
transport one at all. The main task moves the returned array into its ARC
`NoteStore`, materializes typed load failure locally, and enters the synchronous
AppKit lifetime through `await on thread.main`.

The target/action callback now captures a synchronized `TaskScope`. It copies
the note's owned strings, submits an explicitly async root onto `thread.main`,
and returns immediately. That root moves the note snapshot into an async
`thread.spawn` worker, awaits persistence, and resumes on main. Scope close
after `app.run()` rejects later submissions and joins every accepted save,
including worker descendants. The submitted root handles its typed SQLite
failure locally because its synchronous callback has no result task.

The save path now also carries a `SaveStatusPresenter on thread.main` through
the worker. The presenter owns the AppKit status label but is opaque on the
worker: only the nested `await on thread.main` child can call it. Its worker
retain is queued back to main for release, so neither AppKit access nor ARC
destruction occurs on the native worker. This is narrower than sendability and
avoids making mutable UI state atomically shared merely to coordinate work.

The presenter now also stores `Option<TaskControl>` for the active save. This
control is shared identity with deliberately narrow authority: it can report
whether scheduling was accepted and request cancellation of its one operation,
but cannot await it or extract a result. The scheduled job and control retain
one another only while the job is live; completion severs that link before
release. The `TaskScope` remains the sole join owner, so dropping the UI control
cannot detach work and cancelling one save cannot accidentally close the whole
application scope.

The probe also keeps boundaries explicit rather than silently widened:
throwing user constructors still use synchronous helpers when called from async
code, escaping `objc.connect` storage remains in a synchronous
application-lifetime function, and raw AppKit identities are not captured into
the worker-owned persistence graph.

## Native library application probes: curl, raylib, and SDL3

Sources:

- [`z-curl`](../examples/applications/z-curl)
- [`z-raylib`](../examples/applications/z-raylib)
- [`z-sdl3`](../examples/applications/z-sdl3)

These applications test whether direct-header ergonomics survive contact with
large, differently shaped C libraries. The compiler suite compiles the real
application sources without launching their windows or performing curl's
network request.

The curl probe remains entirely in checked Z plus `.zd`. It proves typed status
projection, fixed variadic options, a deterministically owned nullable handle,
and an owner-tied callback/context pair whose native byte parameters appear as
one borrowed `Slice<u8>`. No handwritten shim or raw block is involved.

The raylib 6.0 header exposed 600 imported callable overloads in the measured
environment. Of those, 302 fit the current checked tier and 298 were withheld.
The interactive example now crosses the resource boundary without a shim.
Its adjacent `.zd` classifies pointer-bearing `Image` and all-scalar `Texture`
as move-only records, names their releases, marks producers `owned`, and marks
raylib's global shapes texture `borrowed`. The generated ABI remains direct C.
The borrowed texture is deliberately non-escaping until its validity can be
tied to the raylib window/runtime lifetime.

SDL3 proved that spill-backed Clang ingestion handles a 70.8 MB
`SDL_render.h` AST and that `.zd` scalar `out f32` projections compose with
owned window/renderer handles. It also exposed the union boundary:
`SDL_Event`'s scalar `type` discriminator is imported, but nested record and
pointer payload members are deliberately withheld. The current demo therefore
uses `SDL_PumpEvents` plus `SDL_HasEvent`. That detects quit requests but does
not dequeue ordinary events, so it is a temporary pressure probe rather than a
reference SDL event loop. The intended follow-up is a checked
`SDL_PollEvent(out event)` loop after nested union payloads receive a safe
discriminated projection.

Together these probes establish a useful line:

| Native shape | Current result |
| --- | --- |
| Plain scalar/record C call | Direct checked import |
| Missing ownership, status, callback, or scalar-pointer fact | Checked `.zd` contract |
| Scope-local unsupported pointer proof | `unsafe`, without raw-pointer syntax |
| Contracted by-value resource record | Direct checked call, unique moves, deterministic cleanup |
| Uncontracted by-value resource record | Precise rejection; `.zd` must classify type, parameters, and producer ownership |
| Nested C-union payload | Withheld pending a checked discriminator contract |

The next resource checkpoint is lifetime provenance for library-owned records
and branded ownership variants whose cleanup differs despite sharing one C
record type.

### Interop friction that changed the language

These probes did more than confirm already-designed paths:

- curl forced `.zd` callback contracts to name owner-tied context, invocation
  cardinality, caller threading, native failure narrowing, and a projected
  borrowed byte slice without restating the C callback ABI;
- raylib exposed canonical C typedef-alias identity, the difference between an
  owned producer and a library-owned borrowed producer of the same record, and
  the need to keep borrowed records non-escaping until their runtime provenance
  can be named;
- SDL3 broke the former 64 MiB Clang-AST pipe assumption, motivated spill-backed
  importer output, proved scalar `in`/`inout`/`out` projections for floating
  pointers, and left nested union payloads withheld rather than pretending a
  partially understood `SDL_Event` is safe;
- unsupported but locally provable pointer use motivated typed `unsafe`, while
  function-like macros and source-language-only native constructs motivated
  `raw`. Keeping those tiers distinct prevented either escape hatch from
  weakening ordinary Z values or introducing a general raw-pointer type.

The contract surface is consequently larger, but it remains semantic metadata
over the header rather than a second handwritten ABI declaration. Wrong
ownership and lifetime facts remain trusted assertions; generated `.zd`
scaffolding must therefore fail closed instead of inventing them.

## Application probe 4: self-hosted frontend

Source: [`compiler/frontend`](../compiler/frontend)

The 2026-07-26 decomposition checkpoint contains 15,160 lines of Z:

| Component | Lines | Responsibility |
| --- | ---: | --- |
| `lexer.zs` | 673 | UTF-8 scanning with UTF-16 public locations |
| `parser.zs` | 3,913 | declarations, statements, and flat expression arenas |
| `semantic-model.zs` | 180 | graph, symbol, signature, diagnostic, and semantic-evidence values |
| `module-paths.zs` | 94 | lexical local-module recognition and normalization |
| `module-signatures.zs` | 263 | declaration-to-semantic signature projection |
| `module-symbols.zs` | 253 | symbol construction, import bindings, and lookup indexes |
| `module-graph.zs` | 200 | parsing, dependency edges, graph skeletons, and ordering |
| `semantic-names.zs` | 406 | lexical scopes, pattern bindings, and unknown-name diagnostics |
| `semantic-type-shapes.zs` | 340 | intrinsic, array-element, and compound type-shape parsing shared by validation and inference |
| `semantic-type-identities.zs` | 373 | canonical symbol identity, cross-module spelling, and trait conformance lookup |
| `semantic-type-validation.zs` | 723 | declaration and annotated-expression type-name, arity, and constraint validation |
| `semantic-call-contracts.zs` | 114 | per-call capability conflicts plus pending throwing-call encoding and diagnostics |
| `semantic-expression-ownership.zs` | 190 | initialization, storage-root discovery, use-after-move checks, and whole-value consumption |
| `semantic-expression-types.zs` | 196 | expected/actual compatibility for functions, literals, nullability, Slices, and views |
| `semantic-closures.zs` | 452 | closure parameter contextualization, callable-shape construction, and lexical capture discovery |
| `semantic-function-contexts.zs` | 183 | function parameter/receiver bindings, generic context, and generator yield/return discovery |
| `semantic-flow-state.zs` | 361 | initialization/ownership binding state, capability flags, and branch merges |
| `semantic-type-ownership.zs` | 376 | generic substitution plus cleanup, move, copy, and construction properties |
| `semantic-generic-inference.zs` | 285 | recursive generic unification, contextual substitution, constraint checks, and type-name materialization |
| `semantic-member-lookups.zs` | 636 | enum-match shapes, aggregate construction, fields, method signatures, and generic constraint lookup |
| `semantic-pattern-validation.zs` | 235 | match payload bindings, object patterns, field visibility, and pattern diagnostics |
| `module-resolver.zs` | 3,937 | recursive expression inference, closure ownership effects, statement traversal, output proofs, and semantic orchestration |
| protocol/library modules | 777 | temporary host boundary and in-process entry points |

This is the largest ownership pressure test in the repository. It parses its
own twenty-two-module frontend graph and currently produces parity evidence for
784 symbols, 1,568 binding/signature queries, 930 inferred local bindings, and
3,431 root expression types. The binding and expression counts describe the
now-smaller resolver entry module; declarations moved into the new semantic
modules no longer appear in that entry module's evidence totals. On a warm local
run after the function-context extraction, native lexing, parsing, resolution,
semantic analysis, and encoding took approximately 158 ms; decoding the
temporary text protocol took another 9 ms. These are checkpoint
figures, not a TypeScript-versus-Z speed claim: the two frontends do not yet
perform identical work and the structural handoff has not replaced the text
protocol.

What the compiler proves:

- owned `String`, `Array`, `Map`, `Set`, `Option`, enums, and typed errors are
  sufficient to implement a substantial compiler frontend without ARC-owning
  every syntax node;
- flat integer-indexed expression and statement arenas avoid recursive object
  ownership, keep node identity stable across array growth, and cross the
  bootstrap boundary compactly;
- parser traversal borrows the token array and copies only text retained by the
  AST, making the ownership boundary visible rather than depending on hidden
  source-buffer lifetimes;
- explicit `in`/`inout` capabilities make graph, scope, flow-state, and evidence
  mutation reviewable and let the native analyzer model the same capabilities
  it is compiling;
- one typed `ModuleResolveError` channel carries lexer, parser, module, name,
  type, match, and operator failures with source locations through the native
  boundary.

The same code exposes concrete friction:

- `module-resolver.zs` contains 99 explicit `String.copyBytes` calls. Some are
  correct ownership transfers into persistent evidence, but repeated canonical
  type names and identifiers make a compiler-owned string interner and stable
  symbol/type IDs a higher-value optimization than implicit String sharing.
- Branch and contextual inference clone binding-flow arrays repeatedly
  (`copyValueBindings` has 29 call sites). This is safe and simple, but it
  should be measured against checkpoint/rollback storage or persistent scopes
  before the analyzer grows further.
- Core inference functions repeatedly pass six to ten borrowed values:
  module, graph, arena, expression tree, bindings, and evidence. Z cannot
  currently put parameter-provenanced `view` and writable loans into a
  non-escaping context struct, so a conventional stack `SemaContext` is not yet
  expressible without moving owners or allocating unrelated shared identity.
- Splitting private helpers across source modules requires exporting their
  shared implementation types and functions; Z has explicit public exports but
  no package-private visibility tier. This is manageable, but the resulting
  internal API should keep one public resolver operation alongside one explicit
  semantic-model module.

### Why `module-resolver.zs` reached 8,980 lines

Only roughly the first and last 900 lines are module-graph work. The middle is
the native semantic analyzer: lexical scopes, type-name and generic validation,
flow initialization, ownership state, call capabilities, type identity,
matching, field and method lookup, closure capture analysis, expression
inference, and statement checking.

The size has three causes:

1. **Inherent compiler complexity.** The file now performs far more than its
   original name says.
2. **Incremental bootstrap history.** Semantic tiers were deliberately added
   beside the graph and its private helpers while Stage 0 remained authority.
   This minimized changing two axes—semantics and module boundaries—at once.
3. **Real composition pressure.** No package-private exports and no scoped
   borrowed context aggregate make a clean split more verbose than it would be
   in the intended mature language.

The absence of trait-typed values is not the immediate cause. These passes are a
closed, statically selected pipeline and can be ordinary functions in acyclic
modules. Dynamic visitor storage would add indirection without solving the
borrowed-context problem.

The first extractions moved the public graph, symbol, signature, and evidence
values into `semantic-model.zs`, isolated lexical module paths, then separated
declaration-signature projection, symbol construction, graph construction, and
lexical name validation. Type spelling and callable-shape parsing shared by
declaration validation and expression inference form a separate leaf module.
Canonical identity and declaration validation then consume that leaf without
depending on expression inference. Initialization and ownership state transitions
form another dependency-free semantic leaf, and type-level cleanup/copy/move
queries now consume it without depending on expression inference. Match,
aggregate-field, method-signature, and constrained-generic lookup form another
read-only semantic module shared by expression inference and diagnostics. Match
payload binding, object-pattern validation, private-field enforcement, and
pattern diagnostics then consume those lookups without depending on expression
inference. Recursive generic unification, contextual substitution, constraint
checking, and parameterized type construction form another semantic leaf.
Contextual aggregate inference now consumes one normalized construction shape
instead of repeatedly traversing the same symbol. Per-call alias conflicts and
pending throwing effects now form a separate call
contract leaf. Initialization/use-after-move diagnostics, storage-root
discovery, and whole-value consumption form a separate expression-ownership
leaf over the shared flow state. Expected/actual compatibility for contextual
numeric literals, function values, nullability, Slices, and receiver-tied views
now forms one expression-type leaf. Stage 0 checks the split, and the native
resolver resolves its own twenty-module graph.
A same-filesystem, same-toolchain comparison measured the new graph at 290 ms
versus 293 ms for the prior flow-state commit; the independently sampled warm
checkpoint was 264 ms versus 271 ms at the first decomposition checkpoint. This
proves ordinary Z modules are already useful for decomposition without imposing
a material edit-check latency penalty.

The split also made visibility pressure concrete. Signature projection accepts
the parser's owned `Program` directly and needs no new borrowed wrapper.
Symbol construction, however, shares a small `ParsedModule { path, program }`
aggregate with the resolver. It must be marked `export` even though it is an
implementation detail because Z currently has no package-private visibility.
Protocol code similarly imports data from the model module and behavior from
the resolver/symbol modules because Z has no re-export surface. This is genuine
ceremony, but not yet enough evidence to add either feature.

The remaining self-hosting step is a controlled decomposition using the
language as it exists:

1. separate semantic evidence/model types from algorithms;
2. restore `module-resolver.zs` to a small public algorithm facade alongside
   the explicit model module;
3. move expression and ownership-flow analysis behind internal implementation
   modules;
4. keep the complete parity corpus and timing report unchanged;
5. record exactly where explicit parameter threading remains awkward.

Only if step 5 repeatedly blocks useful decomposition should Z prototype a
scoped, non-escaping aggregate of borrowed capabilities. That experiment must
prove last-use release and exclusivity; it should not introduce general stored
references or Rust-style lifetime syntax by default.

## Loop-carried child-task slots

An adversarial loop exposed a compiler/runtime soundness boundary: one
syntactic `task` site inside a loop reused one fixed generated child slot on
every iteration. When the child suspended, later iterations overwrote the
pointer, leaked earlier frames, and allowed multiple exclusive `inout` loans to
the same storage. The serial executor could hide the problem when children did
not suspend.

Z now rejects a child whose lifetime could cross a loop back-edge. Sequential
iteration uses direct `await`. Parallel work within one iteration may use an
`async scope` created inside the loop body, whose implicit join runs before the
back-edge. True cross-iteration fan-out remains a dynamic-child-group feature;
it must not be approximated by reusing a fixed frame slot. This boundary applies
to ordinary `task`, placed `task on`, and explicit `thread.spawn` children, not
only to borrowed arguments.

## Not tested yet

- child-task output and cross-thread borrows that survive suspension;
- accepted parameter-provenanced or retained views; rejected parameter and
  class-owner shapes now have explicit evidence;
- mutable shared ARC identity, concurrent weak upgrade, native sendability
  inference, and destruction-affinity protocols; Copy snapshots, unique owner
  transfer, and deeply readonly atomic ARC sharing now cross one native thread;
- cyclic application graphs under ORC;
- storing move-only native values in ARC fields or owned closure environments;
  compiler `Option`/`Result` payloads, direct native async locals and owned
  parameters, immutable scoped async borrows, direct-awaited and scope-bounded
  child-task mutable borrows, whole Z value aggregates containing them, and
  fallible results now survive suspension, return/await relay, `try`/`attempt`,
  match, failure, and cancellation;
- Windows C++ UI ownership and callback shapes.

Each belongs in a vertical application probe before its design is treated as
settled.

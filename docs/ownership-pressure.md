# Ownership pressure log

This log tests Z's ownership model against application-shaped code. It records
observed friction before changing the language, and separates ownership-model
questions from bootstrap implementation gaps.

The sections are chronological: a limitation recorded in an early pressure
test may be closed by a later one. Use the final “Not tested yet” list for this
log's open evidence gaps and [`bootstrap-status.md`](bootstrap-status.md) for
current compiler coverage.

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
| `chooseDocument(flag, in drafts, in published): view Document` | direct parameter-provenanced borrow | one `const Document *`; no provenance tag, retain, or copy | both possible owners remain read-only until the selected view's last use |

The scoped form reads naturally for enumeration and one operation. It becomes
awkward when several later statements need the selected document. The snapshot
is semantically honest when the result must survive `Workspace.open`, but its
copy would be accidental overhead for immediate read-only use.

This evidence produced the initial narrow owner-tied read-only views rather than general
lifetime parameters. Provenance may be one borrowed value-struct receiver or
the conservative set of immutable value-struct parameters selected by direct
return paths. That first slice made a view non-storable; it could enter a synchronous `in T` call and
may be read through an inline closure whose synchronous `in` destination proves
nonescape. Stored, owned, and escaping captures remain rejected, and source
owner mutation is rejected until the view's last use. `Option<view T>` currently
carries receiver provenance
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

The [`parameter-views.zs`](../examples/language/ownership/parameter-views.zs)
probe extended that result to ordinary module functions. `chooseDocument`
returns a direct element from either `drafts` or `published`. Semantic analysis
records both possible call-site roots, installs an immutable loan for each, and
removes both loans after the result's final use. Mutating either library before
that use is a `Z0205` error; both can grow immediately afterward. Generated C
still returns one checked `const Document *`, so conservative source provenance
does not become a runtime discriminant.

The same probe exposed a separate usability cost: application-shaped setup was
dominated by creating empty `Array<T>()` values and then issuing repeated
`push` calls. `Array<T>(first, second)` now performs source-ordered populated
construction under the same ownership rules as `push`. A guarded temporary
owns each element as soon as it is inserted, then transfers the completed
buffer to its destination. This preserves deterministic ownership internally
without exposing a sequence of user-authored mutations. The one-argument form
is deliberately one element, leaving capacity reservation to a future
explicitly named factory.

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
`SDL_Event` now receives opaque ABI-preserving storage through a checked
`SDL_PollEvent(out event)` contract. The follow-up discriminated-union slice
made that contract reusable: `.zd` names the `type` tag, header constants, and
the active `window` payload. `match (in event)` now emits a direct C switch and
binds a non-escaping view into `event.window`; the prior unsafe scalar read
disappeared from the application unchanged at the ABI boundary. The follow-up
pointer-bearing tier retains `SDL_TextInputEvent` as a view-only record, hides
its uncontracted pointers, and projects its `const char *text` as a nullable
borrowed view tied to the declared `eventMemory` lifetime. `SDL_PollEvent` and
`SDL_PumpEvents` explicitly invalidate that identity, so another event pump is
rejected while the text view remains live.

Together these probes establish a useful line:

| Native shape | Current result |
| --- | --- |
| Plain scalar/record C call | Direct checked import |
| Missing ownership, status, callback, or scalar-pointer fact | Checked `.zd` contract |
| Scope-local unsupported pointer proof | `unsafe`, without raw-pointer syntax |
| Contracted by-value resource record | Direct checked call, unique moves, deterministic cleanup |
| Uncontracted by-value resource record | Precise rejection; `.zd` must classify type, parameters, and producer ownership |
| C-union output with a contracted tag | Checked `out`; allocation-free borrowed `match` with an open fallback |
| Cleanup-free C-union struct payload | Non-escaping `view NativeStruct` into the active member |
| Pointer-bearing C-union payload | View-only native record; safe fields remain visible and a contracted `const char *` field may carry a named foreign lifetime |

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
  pointers, and forced a checked distinction between tag-only events,
  cleanup-free borrowed payloads, unknown fallback tags, and pointer-bearing
  view-only payloads with explicitly projected, lifetime-bound text;
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

The 2026-07-27 decomposition checkpoint contains 16,146 lines of Z:

| Component | Lines | Responsibility |
| --- | ---: | --- |
| `lexer.zs` | 817 | UTF-8 scanning with UTF-16 public locations plus opaque raw-native body boundaries |
| `parser.zs` | 3,932 | declarations, statements, flat expression arenas, and raw-function structural parity |
| `semantic-model.zs` | 180 | graph, symbol, signature, diagnostic, and semantic-evidence values |
| `module-paths.zs` | 94 | lexical local-module recognition and normalization |
| `module-signatures.zs` | 263 | declaration-to-semantic signature projection |
| `module-symbols.zs` | 253 | symbol construction, import bindings, and lookup indexes |
| `module-graph.zs` | 200 | parsing, dependency edges, graph skeletons, and ordering |
| `semantic-names.zs` | 406 | lexical scopes, pattern bindings, and unknown-name diagnostics |
| `semantic-type-shapes.zs` | 376 | intrinsic, array-element, and compound type-shape parsing shared by validation and inference |
| `semantic-type-identities.zs` | 464 | canonical symbol identity, cross-module spelling, transparent aliases, unresolved-external classification, and trait conformance lookup |
| `semantic-type-validation.zs` | 723 | declaration and annotated-expression type-name, arity, and constraint validation |
| `semantic-call-contracts.zs` | 156 | per-call capability conflicts plus pending throwing/async-call encoding and diagnostics |
| `semantic-expression-ownership.zs` | 193 | initialization, storage-root discovery, use-after-move checks, and whole-value consumption |
| `semantic-expression-types.zs` | 218 | expected/actual compatibility for functions, literals, nullability, Slices, views, and unavailable foreign types |
| `semantic-closures.zs` | 484 | closure parameter/effect contextualization, callable-shape construction, and lexical capture discovery |
| `semantic-executor-placement.zs` | 116 | placed-task type effects plus explicit capture capability and move-state preparation |
| `semantic-function-contexts.zs` | 186 | function parameter/receiver bindings, generic context, and generator yield/return discovery |
| `semantic-intrinsics.zs` | 250 | compiler-provided numeric, collection, iteration, generator, and weak-reference callable behavior |
| `semantic-evidence.zs` | 248 | callable target lookup plus generic-call, binding, and expression evidence construction |
| `semantic-operators.zs` | 213 | copy/move eligibility plus unary, arithmetic, bitwise, comparison, equality typing, and foreign-boundary deferral |
| `semantic-flow-state.zs` | 361 | initialization/ownership binding state, capability flags, and branch merges |
| `semantic-type-ownership.zs` | 376 | generic substitution plus cleanup, move, copy, and construction properties |
| `semantic-generic-inference.zs` | 285 | recursive generic unification, contextual substitution, constraint checks, and type-name materialization |
| `semantic-member-lookups.zs` | 636 | enum-match shapes, aggregate construction, fields, method signatures, and generic constraint lookup |
| `semantic-pattern-validation.zs` | 235 | match payload bindings, object patterns, field visibility, and pattern diagnostics |
| `module-resolver.zs` | 4,020 | recursive expression inference, closure ownership effects, statement traversal, output proofs, and semantic orchestration |
| protocol/library modules | 461 | versioned structural phase result, complete graph/evidence projection, and in-process entry points |

This is the largest ownership pressure test in the repository. It parses its
own twenty-nine-module frontend graph and currently produces parity evidence
for 918 symbols, 1,836 binding/signature queries, 1,001 inferred local bindings,
and 3,803 root expression types. The binding and expression counts describe the
now-smaller resolver entry module; declarations moved into the new semantic
modules no longer appear in that entry module's evidence totals. On a warm local
run after phase API version 1 landed, native lexing, parsing, resolution,
semantic analysis, structural validation, and graph adoption took approximately
178 ms. One bulk fixed-width fill carries all 918 symbol identities, kinds, export
states, imported names, local targets, and source locations. Three paired
base/item batches carry top-level functions, aggregate types, and
constructor/method callables, including their generic, constraint, field,
variant, conformance, capability, and effect details. The strings remain
borrowed from the owned graph handle until the host releases it, avoiding
per-field FFI calls while making that lifetime contract meaningful. Additional
base/item batches carry call targets and substitutions; binding/expression
batches carry inferred types and flattened nominal identities. Success no
longer creates, returns, copies, or decodes a text payload; the host adopts the
canonical graph returned by the versioned phase API directly. The latest
whole-process samples were 251.3 ms for Stage 1, 250.4 ms for Stage 0, and
1.137 s for the hybrid parity path. All three remain inside the established
band. These are
checkpoint figures, not a TypeScript-versus-Z speed claim: the two frontends do
not yet perform identical work and the hybrid path deliberately performs both.

A four-module generic-identity probe imports two distinct declarations named
`Node` through aliases, then nests each inside `Envelope<Slot<T>>`. It exposed
that Stage 0's materialized aggregate names had discarded the ordered source
arguments needed to reconstruct nominal evidence. Materialization now retains
the source template and arguments, and the semantic bridge compares their exact
identity-path shape. Equal-looking type text can no longer authorize a linked
generic value whose declarations differ.

The existing async-generator application exposed another composition gap:
Stage 1 retained `async` and `throws` on declarations but discarded the effect
when inferring a call, so none of its seven locals could become native
evidence. A pending async-call shape now carries success and error types until
`await` consumes it. Cold async-generator construction, intrinsic `.next()`,
`attempt await`, and `try await` all use that representation. The application
now exports and consumes all seven inferred bindings; the scalar async-error
example does the same for both of its bindings.

The structured-task application then exposed the adjacent boundary: direct
async effects were known, but `task operation()` discarded them and awaiting a
named handle could not recover its success or error type. Native inference now
materializes source-level `Task<T, E>`, treats it as an owned cleanup-bearing
handle, consumes it on join, and restores the pending error channel for
`try`/`attempt`. The unchanged application moved from four to all twelve
inferred bindings under native authority. Self-analysis now exports 960 binding
and 3,638 root-expression contracts.

Executor placement exposed both the next authority gap and the importance of
honest fallback. The native resolver now infers direct placed calls, placed
tasks, block result/error contracts, explicit `in`/`inout`/`move` captures, and
post-join ownership flow. The unchanged example moves from two to all six
inferred bindings. An AppKit probe also showed that a capture may be valid in
Stage 0 while its upstream foreign or `thread.spawn` type is absent from the
native source graph; that entire placement now defers rather than producing a
false native diagnostic. Capture preparation lives in
`semantic-executor-placement.zs` instead of adding another ownership subsystem
to the resolver.

A broader application and language-example sweep found four native-only
compatibility regressions that the smaller parity corpus did not exercise.
Trait receivers lost their declared capability in signature projection;
contextual `Option.none` was mistaken for moving a field from `Option`; callable
types with different parameter names were treated as different types; and a
function-valued struct field was mistaken for a missing method. The fixes reuse
the existing receiver, enum-shape, callable-signature, and field-visibility
models rather than adding special cases to Stage 0. The unchanged classes,
Option, owned async-enum, and function-value examples now complete under native
authority. This validates corpus sweeps as a distinct self-hosting gate:
aggregate counts can be green while a previously unrepresented composition
still exposes a semantic mismatch.

Throwing function values exposed the next effect-composition gap. A transparent
alias hid the callable parameter types from closure contextualization, while
the flat function-type parser treated `throws E` as part of the return type.
Native type identity now expands transparent aliases at callable boundaries,
and callable shapes retain a distinct error channel. Closure bodies receive
that contextual error type, returned closure evidence preserves it, and calls
recover the same pending throwing effect. The existing synchronous
throwing-function example and both `thread.spawn` error examples now remain
fully native-authoritative without teaching the native resolver about the
thread runtime itself.

Weak capture then exposed a compiler-provided nominal boundary. Stage 0
materializes `WeakExpired`, recognizes `weak value`, and assigns a throwing
`upgrade()` method, while Stage 1 previously knew only that `Weak<T>` had
cleanup. Native intrinsic semantics now require a class target, preserve the
strong owner's availability, and return `T throws WeakExpired` from upgrade.
The unchanged weak-reference application—including an owned closure that
captures a weak controller—now consumes all ten observed bindings and all
twenty-seven observed expressions through native authority.

Project Index exposed a cross-module recursive-ownership bug. Its exported
`IndexReport` contains a `FileRecord`, but the caller imports only
`IndexReport`. Native cleanup analysis rebased the internal field spelling into
the caller, could not resolve the deliberately unimported `FileRecord`, and
therefore rejected `move report` as moving a cleanup-free value. Cleanup and
explicit-copy recursion now walk field and variant types in the defining
module; only concrete generic arguments cross into that namespace before
substitution. The unchanged two-module application now consumes all seven
observed bindings and all twenty-four observed expressions through native
authority.

The original generic `Pair<T>` example exposed the boundary between declaration
analysis and template-style specialization. Its body compares `T` with a
contextual `0`; Stage 0 accepts the concrete `Pair<i32>` specialization, while
Stage 1 eagerly demanded that abstract `T` already be numeric. Native inference
now treats only this dependent relational shape as provisional and returns a
boolean condition. The existing example regains full native authority for five
resolved call contracts, four inferred bindings, and six observed expressions.
This is an honest migration seam, not the final generic rule: Stage 0 continues
to reject invalid concrete specializations, and native specialization must
eventually perform that proof before Stage 1 stands alone.

A sweep of all 155 executable example roots then exposed five false native
diagnostics at foreign boundaries. The source-only native graph cannot know
whether an imported C typedef is numeric, which contextual function type an
Objective-C adapter expects, or whether a foreign property getter copies an
owned `String`. The resolver now classifies only imports whose local-module
target is absent as unresolved external types. Numeric operations, contextual
literals, unannotated foreign closures, and ownership transfer that require
that unavailable metadata defer to Stage 0 instead of guessing. The unchanged
C typedef, selective-import, Objective-C property, and target/action examples
now check with every Stage-0-observed binding and expression still backed by
native authority where Z has enough information. This is intentionally a
migration seam: importing Clang/Swift FIIR into the native compiler remains
future work, and the fallback does not claim that opaque foreign semantics are
understood.

The final executable-root failure was structural rather than semantic:
Stage 1 parsed only ordinary `{ ... }` Z function bodies, while the accepted
grammar also permits `function ... = raw c|cpp|objc { ... }`. The native lexer
now recognizes the same contextual header as Stage 0, emits the body as one
opaque token while respecting nested braces, strings, character literals, and
comments, and leaves ordinary bindings named `raw` untouched. The parser
accepts the function form without interpreting native source; raw expressions
remain opaque semantic spans checked by Stage 0's dedicated escape-hatch
analysis. Lexer parity, parser parity, and hybrid semantic checking now pass on
the unchanged raw-boundary example. The complete 155-root executable corpus
therefore reports zero failures and zero partial native binding/expression
authority gaps.

The first native emitter then tested a different composition boundary: whether
the owned parser AST is usable for code generation without translating it back
through TypeScript. A small Z emitter now walks function, statement, and
expression arenas directly and emits C for scalar functions, value parameters,
typed locals, calls, arithmetic, assignment, `if`, `while`, loop control, and
returns. The emitter reuses native module resolution and semantic analysis
before code generation; a deliberately invalid name is rejected there rather
than delegated to Clang. Regressions compile and execute a scalar call program
with exit status 42 plus a mutable factorial/control-flow program. The narrow
surface also immediately exposed a semantic trap: direct signed C arithmetic
would make overflow undefined even though Z requires a checked failure. The
native emitter now uses checked `i32` helpers and an overflow regression proves
that the generated program terminates. The narrow surface is useful evidence:
direct AST consumption works, recursive expression and statement walking is
ergonomic with index arenas, and an emission failure can remain a typed Z
error. It does not yet prove ownership lowering, runtime support, multi-module
linking, or foreign emission. The first ownership-bearing aggregate slice
must not extend direct AST emission. A third executable probe now lays out,
constructs, passes, and reads a cleanup-free `Point` value struct. Together the
three shapes show that an explicit lowering IR has earned its cost: checked
operators and aggregate construction are already semantic operations, while
ownership-bearing values require cleanup plans for normal, branch, loop,
return, and error exits. The IR should make those plans data before the C
printer sees them.

That boundary is now executable rather than aspirational. `lowering-ir.zs`
normalizes the three fixtures into typed flat expression and statement arenas;
the C emitter consumes only lowered operations and types. Parser enums and
source operator strings no longer cross the target-text boundary. Cleanup plans
remain the next addition, but they now have one explicit representation to join
instead of another control-flow-specific emitter path.

The first explicit plan now covers owned cleanup-bearing value parameters and
top-level locals in linear control flow. Return lowering stores the result,
emits reverse cleanup, and returns the stored value. A local becomes live only
after initialization. Restricting the custom `deinit` body to empty keeps this a
cleanup-order proof rather than silently discarding user behavior.

Linear parameter transfer now has its own proof. A `relay` function passes
`move resource` to the final owner without emitting a deinitializer; the final
callee alone cleans it after result evaluation.

Linear local transfer follows the same rule. An ordinary local is destroyed
after its return expression is evaluated; `move local` removes that cleanup and
leaves the receiving function as the final owner. This probe exposed a
source-to-C distinction that the production compiler must preserve: a Z
`const` value struct is an immutable binding, not immutable storage. Its emitted
C slot cannot be `const`, because deterministic destruction legitimately takes
its address. Z's semantic pass still rejects reassignment.

The first control-flow cleanup probe keeps an outer owner live through `if` and
`while`. Every nested return evaluates its result and then runs the same cleanup
snapshot; ordinary fallthrough retains the owner. Nested cleanup-bearing locals
within `if` branches now enter a lexical cleanup plan:
normal branch fallthrough destroys them, and early function return receives the
full outer-plus-inner cleanup snapshot. A small fallthrough analysis avoids
emitting a second unreachable cleanup after a branch that always transfers
control.

Loop-local owners now provide the next proof. Normal body fallthrough destroys
the current iteration's owners before the back-edge; `continue` and `break`
carry the exact cleanup list for the scopes they exit. Entering a nested loop
resets that edge list while retaining outer owners in the return snapshot, so
an inner-loop transfer cannot destroy an outer-iteration value.

Owned replacement assignment now proves the overwrite boundary too. The RHS is
fully evaluated into an owned temporary before the previous binding is
destroyed; only then is the temporary transferred into the binding. An
initializer may therefore read the old owner without use-after-free, while the
old allocation cannot leak and the replacement remains covered by the ordinary
scope-exit plan.

Cleanup classification also now follows nested value storage. A data-only
`Envelope` containing `Resource` is cleanup-bearing despite declaring no custom
deinitializer. The native emitter synthesizes `Envelope_deinit`, destroys
cleanup-bearing fields in reverse declaration order, and routes the outer local
through the ordinary return cleanup plan. This prerequisite prevents
user-written deinitializer bodies from landing on a shallow ownership model.

The first non-empty custom deinitializer then reuses the typed expression and
statement IR. `this.resource.id` lowers as receiver-pointer field access, an
ordinary Z helper call executes before the generated reverse-field epilogue,
and forward prototypes keep the C translation unit strict.

The cleanup planner now accepts a statement arena plus an owner label instead of
depending on `FunctionDeclaration`. Custom deinitializers therefore reuse the
same lexical and loop-edge machinery: an owned audit local cleans after the
user body and before the receiver's stored resource. This is both less code and
stronger evidence than a parallel deinit-only implementation.

Path-sensitive transfer through `if` now uses the same live-flag principle as
the production backend. A parameter or local that may move on one path starts
live; the move clears its flag before the handoff; return and fallthrough
cleanup test the flag. The untouched branch therefore destroys the owner while
the moved branch cannot. Linear moves retain their zero-flag lowering.

Loop-carried conditional transfer still rejects because its state must be
proven at the back-edge. Error cleanup merging remains the next ownership
evidence required before this tier broadens.

The native emitter then begins the enum representation needed by errors without
coupling both changes. Payload-free enums lower to nominal C enums with
namespaced constants and retain their type through parameters, comparisons,
returns, and value-struct fields.

The first tagged representation is now executable for cleanup-free scalar
payloads. A dedicated nominal tag plus C union carries payload constructors,
payload-free cases, and returned enum values without erasing their Z type.
Aggregate payloads landed only after active-variant cleanup. C definitions are
dependency ordered across structs and enums, so an enum may own a resource
declared later and a containing struct may in turn own that enum. A synthesized
enum deinitializer switches on the nominal tag and destroys only the active
payload; recursive struct cleanup then composes through that enum. The
out-of-source-order executable probe destroys two resources through a direct
enum local and a containing struct, exactly once each.

Exhaustive statement match now makes that representation consumable. An
identifier subject emits one typed switch; scalar payload arms bind the active
union field and execute their lowered statement body. Cleanup planning walks
the parser's arm-to-statement-arena links, so outer owners and branch locals
clean on arm returns and fallthrough rather than bypassing ownership through a
new control-flow form. Cleanup-bearing payloads now have that explicit transfer
plan too: a consuming match removes the wrapper owner, makes the active payload
binding the arm-local owner, and cleans it after the arm's return value is
evaluated. When the match is conditional, entering it clears the wrapper's live
flag; the path that skips it still destroys the wrapper. The emitted C therefore
does not infer union ownership from syntax and cannot clean both aliases.
Direct `return match (...)` expressions with concise arms reuse this same IR:
each selected arm becomes a typed lowered return, evaluates its result, and
then runs the arm payload cleanup. This first value-producing tier avoids a
second C-only ownership path while leaving local-binding destinations and
selecting blocks for the broader match-expression lowering.
Explicitly typed local destinations now use an uninitialized C slot followed by
one assignment in every exhaustive arm. This is portable C rather than a
statement-expression extension, while Stage 1's match proof supplies definite
initialization. If the arm value is the cleanup-bearing payload itself,
ownership transfers into the result and the arm does not clean the old name;
if the arm only projects a scalar, the payload remains arm-local and cleans
after assignment. The resulting owned local then follows the ordinary
scope-exit plan.
Consuming match subjects now always normalize through one typed temporary.
That makes a constructor or function-call subject evaluate exactly once before
the tag switch and gives the union storage a stable identity for arm binding.
The wrapper temporary is consumed by dispatch rather than separately cleaned;
the active payload either cleans in the arm or transfers into its result.
Borrowed `match (in value)` continues to access the required stored source
directly instead of manufacturing a copied borrow.
Selecting block arms compose without a second value channel. Prefix statements
lower normally and the final `select` becomes the arm's existing return or local
assignment destination. Cleanup planning follows the source block edges: a
block-local owner is destroyed after its selected scalar is evaluated and
before the active payload owner, while a local match result performs the same
cleanup before arm fallthrough.

The first compiler-provided sum type now crosses the same lowering path.
`Option<i32>` is a monomorphized tag plus scalar union with no allocation;
`Option<Resource>` derives cleanup from `Resource`, destroys only `some`, and
hands a consuming match's active payload to one arm-local owner. Explicit
constructors, `none`, parameters, returns, typed locals, and direct-call match
subjects all compile and execute unchanged. This is stronger evidence than a
parallel built-in emitter path: Option representation and ownership are ordinary
lowered enum operations.

`Result<T, E>` now proves the same point for Z's error surface without exposing
constructor ceremony. A throwing function's ordinary `return` lowers to the
`success` variant, `throw` lowers to `failure`, and `attempt` leaves the native
tagged result available to `match`. Cleanup-bearing values on either side obey
the active-variant rule: an uninspected result destroys its stored payload,
while a consuming match transfers that payload into one arm-local owner and
cleans it after the arm value is evaluated. Contextually inferred Option
construction now uses the destination or payload evidence instead of requiring
an explicit `Option<T>` receiver. `Option.some(value)` infers `T` for an
unannotated local, contextual `Option.none` emits the same monomorph, a
cleanup-bearing value struct transfers its owner, and an existing ARC class
reference is retained so the source binding remains usable. Matching an `in`
parameter borrows its active payload even when the source uses ordinary
`match (value)` spelling; the emitted arm never destroys borrowed storage.
Broader expression composition remains an intrinsic pressure point. Direct
`return try call()` already relays an ABI-identical result after
evaluating it into a temporary and cleaning surrounding owners. A typed local
initialized through `try` uses an explicit lowering control-flow node: failure
is rebuilt in the enclosing Result only after the inner error payload is
captured and existing owners are cleaned; success transfers into the now-live
local. This keeps propagation visible to cleanup planning rather than relying
on a C statement-expression extension. Fallible `void` functions use the same
shape without inventing a success payload: `return;` sets only the success tag,
while failure retains and conditionally destroys the real error payload.
Expression-statement `try` on a fallible void call uses the same explicit
failure edge and cleanup snapshot, with no assignment or placeholder success
storage on the continuing path.

Inferred ownership-bearing locals now test the semantic-to-lowering boundary.
The native resolver records each inferred binding's settled source type and
location; lowering consumes that evidence for storage, match resolution, and
cleanup classification. Removing annotations from struct construction,
`Option`, `Result`, local `try`, and owned match-result fixtures leaves their
generated C and destruction behavior unchanged. This avoids duplicating type
inference inside code generation.

The emitter now also consumes the resolver's dependency order instead of
discarding every module except the entry. A two-module scalar fixture exports a
function under a local selective alias, lowers both module programs into one
typed IR, resolves that alias back to the exported source symbol, and emits one
direct C call with no wrapper. This first tier intentionally does not claim that
source spelling alone is enough for imported aggregate identity; imported value
types and colliding module-private symbols remain the next nominal-identity
pressure test. Until canonical emitted identities land, duplicate type or
function spellings fail before C generation instead of silently colliding.

The first nominal aggregate crossing now uses the resolved graph instead of
source-spelling inference. A dependency exports `Point` and a factory; its
consumer selectively aliases the type to `Coordinate` and the factory to
`coordinate`, stores the inferred result, passes it through a local function,
and reads both fields. Native lowering canonicalizes both aliases back to the
one emitted `Z_Point` identity and executes unchanged. A second exported
`Resource` adds `deinit`; its alias retains cleanup metadata, an inferred local
owns the factory result, and ordinary owned argument passing transfers it to a
local consumer. Generated C destroys the consumer parameter exactly once and
does not repeat cleanup in the caller. This exposed and closed an emitter gap:
the cleanup planner previously recognized only explicit `move` syntax, although
ordinary owned parameters also move cleanup-bearing values by language design.
A local `Session` then stores the imported `Resource`. Recursive cleanup marks
the wrapper as ownership-bearing, implicit field initialization transfers the
resource, and consuming the session destroys its imported field once. The
generated caller destroys neither the emptied resource binding nor the moved
session.

An exported `ResourceState` then carries the same resource as a payload. The
consumer aliases the type to `State`, constructs `State.ready(...)` and
`State.empty` directly, receives another state from an imported factory, and
matches it exhaustively. Native lowering carries the canonical variant table
and payload type through the graph: consuming `ready(resource)` transfers and
destroys the payload exactly once, while an unmatched scope-owned empty state
uses the synthesized enum destructor. This is the first multi-module test where
nominal type identity, variant syntax, control flow, and recursive ownership all
compose in the native emitter.

The same consumer now constructs `Coordinate({ x: 1, y: 1 })`, where
`Coordinate` is only a selective local alias for exported `Point`. Lowering
emits a `Z_Point` compound value directly; the alias produces neither a wrapper
type nor a conversion call. Imported aggregate identity now composes through
both factory and constructor paths.

Two dependencies may now each define a private `helper` function. Native
lowering detects the source-name collision before emission, assigns each helper
an internal module-qualified C identity, and rewrites only calls originating in
that helper's module. The combined strict-Clang executable returns the same
result. Two same-named exported functions remain a deliberate error: choosing
their externally visible identity belongs with Z-to-C export and ABI design,
not an accidental private-name mangling rule.

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

- `module-resolver.zs` contains 63 explicit `String.copyBytes` calls. Some are
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
- Capability-aware extraction rejected passing several fields of the same
  borrowed AST aggregate into one evidence-recording call because the aggregate
  and its projected fields overlapped. Naming and copying the scalar/text field
  values before the call made the ownership proof explicit and safe, but the
  ceremony is useful evidence for future projection and borrow ergonomics.
- Building the versioned phase response exposed a narrower parity edge: Stage 0
  accepted an explicit `move` on a consuming match payload while native
  authority classified that spelling as non-unique. Passing the payload directly
  into its owned aggregate field is the intended contextual move and checks
  identically in both frontends. The redundant explicit spelling remains a
  native-ownership diagnostic gap to revisit; it does not require new syntax.
- Operator typing provided a useful boundary test: copy/move eligibility and
  scalar result typing moved behind an ordinary Z module, while short-circuit
  branch merging and actual `move` consumption remained in the recursive flow
  engine. No borrowed context object or trait-typed indirection was needed.
- The output-side structural handoff keeps one native result alive while the
  host queries every graph/signature/evidence batch. API version 1 adds no
  second resolver pass, gives borrowed strings an explicit lifetime owner,
  validates references before graph adoption, and reserves text payloads for
  failures only.
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

The native frontend also supplied quantitative evidence for a smaller,
independent feature. A pre-feature corpus query found 840 direct
`tree.nodes[index]` projections across the frontend modules, while
`module-resolver.zs` still contains 87 `String.copyBytes` calls. Those counts are
not all optimization opportunities, but repeated AST navigation and defensive
field copies made the inability to name a temporary borrow concrete. Z now
accepts:

```z
const node = view tree.nodes[index];
record(node.kind);
return node.text.byteLength;
```

The first local-view tier lowers `node` to `const SyntaxNode *`, ties its shared
loan to `tree`, and releases that loan after `node`'s last use. It rejects
mutable or explicitly typed bindings, non-projections, storage, returns,
escaping capture, class-owned projections, suspension, and owner mutation while
live. A compiler-shaped Z test exercises the syntax, ownership conflict, editor
provenance, generated C, and native parser/type parity. Native lowering now
preserves that pointer representation, forwards it directly to synchronous `in`
parameters, and schedules cleanup only for the owner. `semantic-operators.zs`
is the first self-hosted compiler module to use the form; the complete frontend
graph still emits, compiles under strict C warnings, and executes.

The next compiler-shaped adoption replaced the repeated root projections in
`inferExpressionNodeType`:

```z
const node = view tree.nodes[index];
const value = view node.value;
const children = view node.children;
```

The function previously contained 64 direct `tree.nodes[index]` expressions;
it now performs one checked root projection. `children` no longer constructs
and destroys an owned `Array<usize>` on every recursive inference call, and
`value` no longer copies and destroys the expression node's String. This
required read-only intrinsic composition for `view Array<T>` and `view String`,
not a broader lifetime rule: both views retain the tree provenance, reject
mutation, and disappear at last use. A native compiler fixture now exercises
array length/index/iteration and String length/comparison/interpolation/
`copyBytes`, strict-compiles the emitted C, and verifies that only the owning
aggregate is destroyed.

The performance result is deliberately modest. An interleaved 2026-07-29
comparison of the complete hybrid native-frontend check measured 3.870 seconds
for the prior tree and 3.900 seconds for the expanded tree (`1.01 ± 0.01`);
that path also analyzes and lowers the newly larger compiler. Separate
fixed-point native `z check` runs measured 252.1 ms before and 256.0 ms after,
inside the combined run variance (`1.02 ± 0.02`). The generated fixed-point C
became slightly smaller, from 3,248,664 to 3,241,509 bytes. The defensible win
at this checkpoint is eliminated recursive allocation and repeated bounds
checks in generated C; whole-compiler latency is neutral, not yet faster.

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

The remaining decomposition sequence continues using the language as it exists:

1. keep restoring `module-resolver.zs` to a small public algorithm facade
   alongside the extracted model and semantic modules;
2. move the remaining recursive expression and ownership-flow orchestration
   behind internal implementation modules where the dependency graph permits;
3. keep the complete parity corpus and timing report unchanged;
4. record exactly where explicit parameter threading remains awkward.

Only if step 4 repeatedly blocks useful decomposition should Z prototype a
scoped, non-escaping aggregate of borrowed capabilities. That experiment must
prove last-use release and exclusivity; it should not introduce general stored
references or Rust-style lifetime syntax by default.

## Private nominal identity across modules

Lowering multiple source modules into one C translation unit exposed a
different composition problem: two module-private `struct Value` or
`enum State` declarations cannot share one emitted nominal identity merely
because their source spellings match. Z now assigns colliding private types a
module-qualified internal name before lowering fields, payloads, function
signatures, construction, match, or cleanup. The identity is therefore settled
once and propagated through the same imported-type catalog used for canonical
exported types.

The pressure test deliberately combines a private enum with a private struct
payload in two modules, constructs and consumes both, compiles the result under
strict C warnings, and executes it. Same-named exported types still fail closed:
their eventual names are an ABI and library-distribution decision, not an
internal mangling detail that the compiler should choose invisibly.

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

## The complete frontend as strict native C

Lowering the unchanged 31-module frontend graph exposed a concentrated set of
composition gaps only after native emission itself became reachable. Integer
literals inside `usize` arithmetic needed the resolver's contextual binary
evidence rather than an emitter default. `Option.some` needed its destination
type through returns, assignments, and aggregate fields. Throwing `void`
functions needed an explicit successful fallthrough value. A temporary owned
template String borrowed by a call needed a named IR lifetime: evaluate it
once, pass its address, and deinitialize it immediately after the call.

The same pass found target-sensitive mutable Array indexing, C-level physical
constness for cleanup-bearing `Map`/`Set` locals, and nested match payload names
that could collide even when their Z scopes were distinct. These are not new
language features. They are evidence that ownership, contextual typing, and
lexical identity must remain explicit in lowering instead of being recovered by
the printer.

With those gaps closed, `parser-library.zs` emits a roughly 2.3 MB translation
unit that compiles and links as strict C11 under Clang
`-Wall -Wextra -Werror`.

## Executing the self-emitted frontend

The next checkpoint turns that translation unit into a native library and calls
its representation-neutral String protocol directly. Stage 0 still discovers
the source graph and builds the seed library, but the seed emits the unchanged
31-module frontend; Clang then builds that emitted C into the library used for
subsequent `self-host-parse` and `self-host-emit` requests. The latter now
executes native Z parsing, resolution, semantic analysis, ownership-aware
lowering, and C emission before the TypeScript driver receives the final bytes.

Executing the compiler rather than merely compiling it exposed ownership
carriers that the smaller fixture corpus had not composed:

- direct `return`, `throw`, `select`, and `yield` of a cleanup-bearing local
  transfer the value rather than shallow-copying it before cleanup;
- contextual and ordinary enum payload construction transfer a direct owned
  identifier, including `Option.some(value)`;
- consuming match payloads can move into nested enum payloads or mutable
  storage without their arm cleanup destroying the transferred value;
- owned-by-value ordinary function arguments now lower through the same move
  operation that cleanup analysis already assumed;
- local and imported struct construction transfer direct owned fields, so a
  `ModuleGraph` can carry its module and dependency arrays across module
  boundaries;
- a local initialized by a value-producing match is not destroyed on an
  initializer arm that returns before the local exists.

The compiler source also made payload-to-storage intent explicit with
`move` where a consuming match transfers an owned String or aggregate. This
keeps the self-hosting subset honest: implicit expression-block transfer and
owned call/aggregate boundaries remain ergonomic, while ordinary storage
replacement exposes the ownership event.

The existing native emitter matrix now runs unchanged through the self-emitted
library, compiles each result under strict C11, executes the successful
programs, and preserves the structured diagnostic for an invalid program. A
second integration test asks the self-emitted compiler to emit the complete
frontend again, strict-compiles that result, links it, and runs its bootstrap
entry point.

The resolver now executes through that same self-emitted library. Z serializes
the complete graph and semantic-evidence model into a representation-neutral
stream, and the host validates and decodes it without knowing the emitted C
layout. This preserves topology, symbols, callable and aggregate signatures,
constraints, type identities, calls, bindings, and expression evidence while
removing the last command path that executed the seed resolver.

That wider execution probe immediately found an owned replacement-assignment
bug. Contextual closure inference assigned one owned `String` local into
another; native lowering emitted a shallow C assignment while cleanup planning
left both owners live. Stage 0 already consumed the right-hand owner. Native
lowering now wraps a direct identifier on an assignment RHS in the same
implicit transfer node and cleanup planning recognizes that transfer, including
the conditional live flag needed when the assignment occurs under control
flow. The closure-heavy resolver fixture now completes instead of double-freeing.

The Bun driver, filesystem graph discovery, foreign importers, seed emission,
and ordinary `check`/`emit`/`run` path remain stage 0.

## Consecutive-generation fixed point

Cold self-hosted library preparation now executes one more compiler generation
before caching the result. Stage 0 compiles the seed frontend; that seed emits
the 31-module frontend C; Clang builds it; and the resulting self-emitted
compiler emits the unchanged graph again. Preparation compares those two C
translation units byte for byte and removes the candidate library if they
differ, reporting both SHA-256 identities and the first differing byte.

The current generations are identical at 2,506,500 bytes. The verified cold
preparation took about 4.0 seconds on the development machine, compared with
roughly 2.7 seconds before the extra generation. It is content-addressed and
paid once: the following resolver run prepared the cached boundary in 2.74 ms,
performed native lex/parse/resolve plus graph decoding in 2.84 ms, and completed
the Stage-0 parity/index queries in 0.70 ms. The generation-two output also
strict-compiled with `-std=c11 -Wall -Wextra -Werror` and returned the fixture's
expected status 42.

This is evidence of a deterministic compiler fixed point, not yet a standalone
distribution. Bun still performs source discovery and orchestration, and a
trusted native bootstrap artifact must replace the source-built seed before a
fresh installation can remove TypeScript.

That proof is now also an explicit local workflow instead of only a test
fixture. `bun run bootstrap [output]` uses Stage 0 exactly once to emit the
current 39-module driver, strict-compiles generation one, asks generation one
to build generation two in release mode, and compares their complete generated
C before publishing an executable named `z`. The published binary performs
ordinary pure-Z project discovery, checking, emission, building, caching, and
execution without Bun. The same ceremony now compiles the trusted
TypeScript/Clang declaration producer into an adjacent `z-foreign-adapter`.
`process.executablePath()` lets the Z driver locate that sibling before falling
back to `PATH`, so a fresh foreign-header check also runs without an installed
Bun command. This does not erase the trust boundary: installations still need
Bun for the seed ceremony and the producer remains TypeScript-hosted. It turns
“generation two exists” into a repeatable complete-tool boundary suitable for
later signing and distribution.

## First standalone Z driver

The first driver-shaped executable now crosses the boundary that the compiler
library's no-op entry point did not exercise. A Z program imports `std/process`
and `std/fs`, receives its native `argc`/`argv` as an owned `Array<String>`,
indexes one argument, calls the throwing `fs.readText`, and consumes the result
through `attempt` plus `match`. The self-emitted frontend emits the program,
Clang strict-compiles it, and the resulting binary runs without Bun. It returns
distinct statuses for no argument, a successful UTF-8 read, a missing file, and
invalid UTF-8.

This probe found two representation boundaries:

- external standard namespaces existed in the graph but carried no native
  semantic call signature. Standard calls now have a distinct evidence kind
  targeting the imported namespace, while their parameter capabilities,
  return type, and error type remain ordinary `ModuleFunctionSignature` data;
- native `try` lowering initially required an identifier callee even when
  complete throwing-call evidence existed for a member call. It now trusts the
  source-positioned evidence before applying the local-function fallback.

The standard-library signatures live in their own frontend module rather than
growing the resolver monolith. Lowering maps semantic names to runtime entry
points, and runtime emission is demand-driven so programs that do not use
process arguments retain an ordinary `main(void)` ABI.

The broader `source-stager` application is now executable through this path as
well. It reads one source, writes it into a cache directory, launches
`clang --version` without a shell, propagates typed filesystem/process
failures, and flushes interpolated console output before exit. Its process
arguments use an explicit growable `Array<String>`; fixed
`Array<String, N>`-to-`Slice<String>` lowering remains a separate composition
gap rather than a bootstrap-only coercion hidden in the C printer.

Console authority is deliberately narrow in this tier. One syntactic String or
template argument lowers as an immutable borrow and cleanup-bearing templates
use the existing borrowed-temporary lifetime. Multi-value calls and non-String
formatting continue through Stage 0, preventing the native subset from
rejecting already-valid console programs while richer formatting is added.

## Standalone multi-module compilation

The first compiler-shaped Z executable now owns more than runtime plumbing.
`compiler/driver/main.zs` recursively reads an entry module and its relative
imports, parses each source into the native owned AST, resolves the complete
graph, emits readable C, writes that translation unit, and invokes Clang. Stage
0 emits the driver once, but the resulting compilation of a separate
two-module Z application executes no Bun or TypeScript process. The application
returns its expected status 42. The same executable now exposes separate
`check`, `emit`, `build`, and project-cache `run` commands over one
`NativeProject` owner, proving that the parsed module array and resolved graph
can move together across a driver API without representation casts. `run`
creates missing `.z-cache/run` parents through the typed
`fs.createDirectories` API, builds into that stable project-local location,
launches without a shell, forwards owned String arguments after `--`, and
returns the child status. This removes an implementation-shaped output
argument from the ergonomic command while retaining the C translation unit for
inspection and incremental reuse.

The first incremental run tier now executes the native frontend but skips
Clang when five inputs agree: the exact emitted C bytes, debug/release profile,
normalized project target fields, Clang's predefined-macro output, and each
foreign adapter's SHA-backed producer key. This is intentionally stronger than
mtime-only reuse. A transitive header edit invalidates the executable even when
the Z call and emitted native symbol spelling remain unchanged; changing
profile, include configuration, or semantic Z source does the same. An
incomplete metadata marker is atomically published before compilation,
preventing an old binary from being reused after a failed rebuild; complete
metadata is now the final publication step.

Configured native libraries exposed the next correctness boundary. Z now has a
typed `fs.readBytes` operation returning owned `Array<u8>` storage, and the
driver implements SHA-256 in ordinary Z rather than delegating cache identity
to a host script. Each library that resolves to exactly one supported spelling
in an explicit link directory contributes its canonical path and byte digest;
an unchanged static archive hits the cache and rebuilding that archive
invalidates it. Missing, system-search-path, or ambiguous libraries still
report a cache bypass. Serving a possibly stale binary would be faster but
would violate the compiler's safety and predictability goals. Module-level
parse and semantic caches are separate future work.

The cache then exposed a process-level ownership race: two native drivers could
both observe a miss, write the same translation unit and incomplete marker, and
publish one executable path concurrently. The repair deliberately uses Z's
ordinary resource model rather than a compiler-only host helper. `fs.lock(path)`
returns a move-only `fs.Lock`; its generated POSIX `flock` or Windows
`LockFileEx` owner releases through deterministic cleanup on every `return` and
typed-error path. The native driver holds that owner across cache inspection,
Clang, and metadata publication, then calls consuming `unlock()` before running
the child. A real two-process probe confirms that the second owner cannot enter
until the first scope releases. A second `unlock()` is ordinary use-after-move.
This pressure test is useful beyond caching: it proves an OS resource can be
represented identically in Stage 0 and the self-emitted backend without adding
manual cleanup syntax to application code.

Serialization removed competing writers but did not make one writer's
publication crash-safe. The next slice added typed
`fs.replace(source, destination)` to both backends. The driver now invalidates
stable metadata atomically, asks Clang to write pending source/executable
paths, replaces the stable artifacts only after compilation succeeds, and
replaces complete metadata last. That last rename is the cache commit point.
A deliberate link failure proves the previous executable remains byte-for-byte
untouched while its incomplete metadata prevents reuse. This is a useful
composition result: ordinary typed I/O, a move-only OS lock, process execution,
and atomic namespace replacement are sufficient to implement a conservative
compiler cache without a host-only transaction primitive.

The command split also made entry policy executable rather than documentary.
`check` validates an export-only entry graph, but `emit`, `build`, and `run`
require `function main(): i32`. An incompatible present `main` fails every
command with its Z source location; an absent `main` fails only executable
commands. Clang is no longer the first component to explain the missing entry.

The driver now passes the stronger recursive test as well. A Stage-0-seeded
generation-one executable loads all 30 driver/frontend modules and builds
generation two; generation two then checks an independent multi-module
application. The generated C is byte-identical across those driver generations.

The first comparison was not identical even though both binaries behaved
correctly. Stage 0 inserted a module into discovery order before visiting its
imports, while the native loader appended the parsed module after recursion.
Private function names include module indices, so preorder versus postorder
changed names throughout the C output. The native loader now owns dependency
paths separately, stores the parsed module in preorder, and only then recurses.
This preserves deterministic identity without keeping a borrow into moved AST
storage.

Build-profile measurements confirmed that bootstrap configuration is part of
the compiler result. The same native source checked its 30-module graph in
601.7 ms at `-O0` but 185.7 ms at `-O2 -DNDEBUG`, compared with 372.3 ms for
the Bun Stage-0 check. Release native emission measured 257.7 ms versus 1.095 s
for the Bun/self-host command. The driver now exposes `--release` on `build`
and `run` instead of conflating its debuggable default with Z's optimized
ceiling.

Diagnostic presentation also crossed the boundary without a compiler-only
escape hatch. The driver retains or reloads the owned module source at the
failure boundary, walks to the reported line, and builds the canonical
`path:line:column` header, source excerpt, and caret through `TextBuffer`.
Parser and semantic failures now remain readable even when no TypeScript
process exists.

Project configuration supplied another application-shaped parser rather than a
compiler bridge. A typed Z reader now walks the nearest `z.json`, ignores
unknown fields for forward compatibility, validates the established target and
link subset, resolves configured directories relative to the manifest, and
projects those facts into Clang. The implementation added one generally useful
filesystem query—`fs.isDirectory`—but no public JSON value hierarchy merely to
bootstrap the compiler. A recursive fixture builds and links a real temporary
static library through this path.

Trying the resulting driver against curl, Raylib, and SDL exposed a more
important boundary than the first lowering error: native `check` initially
reported success because the module resolver deliberately preserves foreign
bindings as opaque symbols for hybrid Stage-0 evidence. A standalone compiler
has no such evidence. The driver now rejects every foreign import at its source
location until Clang discovery, `.zd` loading, and normalized FIIR can move
together. A partial compiler must fail closed rather than turn an implementation
gap into a false safety claim.

The first raw foreign-declaration round trip then exposed an ownership bug in
the compiler itself. Passing an owned `String` to an imported Z function was
lowered as an implicit transfer, but cleanup planning only inspected
same-module call declarations. The generated C therefore shallow-copied the
String into the callee and also destroyed the caller binding. Cleanup planning
now consumes the resolver's cross-module parameter-mode evidence, so an owned
argument transferred to either a local or imported function becomes
unavailable and is destroyed exactly once. The protocol fixture deliberately
omits an explicit `move` to keep this implicit owned-transfer path executable
as a regression.

The protocol itself uses fixed-width numeric framing plus length-prefixed UTF-8
instead of JSON or delimiter escaping. Flat arrays and explicit source indexes
fit the same representation-neutral style as the native resolver stream. Its
first version rejects non-function declaration categories, preserving the
critical distinction between untrusted producer facts and normalized FIIR
rather than silently treating incomplete native metadata as safe. The first
real adapter probe runs a three-function scalar header through Clang and the
native decoder; the same operation rejects the record-bearing geometry header
instead of dropping its types.

The boundary now survives process separation as well. An internal Stage-0
adapter command writes the header-addressed artifact, while the self-emitted
32-module native driver reads, owns, validates, and reports its declaration
counts. Truncating that artifact is a native diagnostic. At this checkpoint the
ordinary native project loader still rejected the corresponding foreign import,
because a raw producer stream had not yet earned `.zd` ownership facts or FIIR
authority; the later automatic-discovery checkpoint below closes that path.

Adding the first `.zd` reader raised the standalone compiler to 33 modules and
immediately exercised the language's own non-escaping collection borrows.
Token and declaration elements contain owned Strings, so the normalizer could
not copy them into convenient locals; it retains their array indexes and copies
only strings that enter the normalized contract. That is the intended
ownership distinction in real compiler code, not a special-case bridge.

The native contract tier now matches inferred scalar functions and decimal
integer-status functions against the Clang stream. Status normalization
preserves the mapped native integer as the error type and the explicit set of
successful literals while presenting `void` to Z. Module, function, and
parameter identities are checked, a status contract requires at least one
success value, and a non-integer native return is rejected. Symbolic/enum
statuses, exact literal range validation, nullable, borrowed, ownership,
callback, and other result-body facts still fail closed until their semantics
cross. The driver still refuses to call this partial normalization a checked
foreign import.

The next slice added `semantic-foreign.zs`, raising the standalone compiler to
34 modules. It converts only normalized callable contracts into ordinary module
function signatures. A source probe exercises both selective aliases and
namespace calls, verifies native target identity, and preserves a status
function's `void throws i32` effect. Wrong arity, an unhandled status call, and
selection of a header function absent from `.zd` all fail in native Z. This is
the intended FIIR boundary: sema sees checked callables, never Clang records or
raw contract syntax.

The following lowering slice carries those checked facts through generated C.
Headers are deduplicated and emitted as includes, scalar calls retain the exact
Clang target, and status calls use a deterministic wrapper per imported symbol.
The wrapper evaluates the native call once, compares its result with both
declared success literals, and builds the same allocation-free
`Result<void, i32>` representation used by Z throwing functions. Clang
strict-compiles the emitted application together with its C implementation and
the binary exits with the expected status 42. Automatic adapter invocation is
now connected at the standalone driver boundary: it discovers the adjacent
contract, launches `z-foreign-adapter`, regenerates the versioned producer
artifact, normalizes it in Z, strict-compiles the imported call, and runs the
same application to status 42. The next cache slice moves that evidence under
the project's `.z-cache/foreign`, includes module/contract/target inputs in its
identity, and records a SHA-256 fingerprint of Clang's preprocessed header
view. A repeated check leaves both artifact and metadata untouched; changing a
transitively included macro rewrites them, and changing include/target inputs
selects a distinct driver identity. On the fixture, five warm cached native
checks average 40.1 ms (38.9–43.0 ms) while still running the preprocessor
fingerprint before trusting the artifact.

Writing that identity in self-hosted Z exposed another honest subset boundary:
the native emitter did not lower explicit integer construction or wrapping
methods even though Stage 0 accepted both. The next composition slice closes
that mismatch for the native IR's initial `i32`, `u8`, and `usize` vocabulary.
Contained conversions emit direct casts; narrowing and signedness-risk
conversions call checked helpers; and `wrappingAdd`, `wrappingSubtract`, and
`wrappingMultiply` preserve modulo-width behavior. A standalone native-driver
fixture exercises all three paths across a module boundary and a negative
runtime probe proves that checked narrowing traps. The Z-written SHA-256 cache
fingerprint then supplied real compiler pressure for `u32`, `u64`,
`Array<u32>`, checked shifts and conversions, and wrapping arithmetic; those
wider unsigned kinds now cross native lowering and strict C emission as well.
Native compile-time constant-range diagnostics remain separate expansion work.
When an Objective-C or other foreign scalar is intentionally opaque to Stage 1,
native shadow analysis defers the conversion to Stage 0 rather than classifying
the unknown ABI value as a non-integer.

That fixture also found backend-name leakage: the valid Z binding `signed`
became an illegal C declaration. The native C emitter now escapes C-reserved
function, parameter, and local binding names consistently, and the regression
keeps `signed` in the source rather than avoiding the collision.

The next foreign composition slice removes magic status integers from the
native driver without trusting contract text. `ZFDCL` version 2 carried typed
constant records alongside functions. The Z-owned `.zd` normalizer accepts a
symbolic `success Z_FOREIGN_OK;` only when the producer proves that constant
exists and its scalar type exactly matches the native function result. Native
lowering retains the verified C spelling, so generated code compares against
the header symbol. Unknown constants and signedness-mismatched constants fail
before semantic analysis; decimal status values remain supported.

`ZFDCL` version 3 now carries the missing nominal enum evidence. A status
constant from an enum must belong to the exact enum returned by the native
function; an integer macro with the same value is not interchangeable. The
native executable subset compares against the verified enum symbol.

The following slice preserved that enum identity beyond verification. Native
foreign contracts now attach hidden/imported enum type symbols to the module
graph, throwing calls produce `Result<void, ZForeignStatus>`, match payloads
retain that type, and C lowering stores the header's real `ZForeignStatus`
rather than an invented Z enum or flattened `i32`. Explicit `i32(status)`
construction remains available because the producer supplied the underlying
type.

The next native slice generalized that evidence without flattening it. Enum
parameters in inferred `.zd` declarations now retain the exact imported enum
identity, producer-proven constants become ordinary typed namespace or
selective-import expressions, and native lowering emits their verified C
spellings. A contextual integer literal is deliberately not accepted where a
foreign enum is expected; users must pass a constant, retain an enum result, or
write an explicit checked enum construction. The module graph exports the
constant target spelling with expression evidence so aliases do not rely on
source-name guesses.

The first attempt to use that enum evidence from the ordinary geometry fixture
found that the producer still rejected the whole header merely because it also
contained C records. That was stricter than the trust boundary required: the
wire tier needs to prove only what it represents, while the normalizer must
reject any contract that depends on evidence outside that tier. The producer
now projects nominal enums, constants, and raw function spellings out of a
richer header. An unrelated record no longer poisons a checked scalar/enum
import, but a record-bearing function still reaches normalization with its
exact native spelling and fails there until record contracts cross the native
frontend. The end-to-end driver fixture deliberately includes an unused record
to keep this distinction executable. It also imports that header through a
relative path while the adjacent contract declares its basename. The native
driver now mirrors Stage 0 by comparing the resolved header identities before
rebinding the checked contract to the source import spelling; basename equality
alone is not trusted when two include roots could contain different headers.

The same geometry pressure test then supplied the first native record boundary.
`ZFDCL` version 4 carries `ZPoint`'s native struct identity, ordered scalar
fields, and layout evidence. The Z-owned normalizer accepts the existing `.zd`
`in`, `inout`, and `out` capabilities only when the corresponding C parameter is
a compatible const or writable record pointer. Native semantic analysis exposes
the record and its fields, while lowering emits the header's `ZPoint` directly:
construction is a C compound literal and calls pass `&point` with no wrapper or
heap allocation. The fixture mutates, reads, resets, and reads the same value,
then inspects the generated C to keep that zero-wrapper claim executable.

The following slice carried the same record by value. `z_translate` receives
and returns `ZPoint` directly, including an enum argument and a scalar typedef
whose canonical Clang spelling is used for verification; `z_score` receives the
returned record directly. Generated C remains the handwritten ABI shape:
`const ZPoint translated = z_translate(point, ZForward, 3);`. Because `ZPoint`
is cleanup-free and recursively copyable, the original `point` remains usable
under Z's ordinary by-value copy rule. A paired negative contract attempts to
pass a union by value and must fail during normalization rather than flattening
or guessing its layout. A later, orthogonal union tier admits only contracted
writable pointers: it allocates the exact native union storage, lets C
initialize it through `out`, and permits a supported scalar or enum member to
be copied only inside a one-`select` `unsafe` expression. Ordinary construction,
safe member access, by-value transport, and nested payloads remain rejected.

The next composition step required no new field-canonical wire record: the
existing producer had already mapped `ZExtent` fields to `u16` and retained
nested field identities such as `geometry.ZPoint`. The normalizer now resolves
records to a fixed point, admitting a record only after every nested record is
already proven recursively copyable. `ZRect` therefore contains native
`ZPoint` and `ZSize` fields and lowers as one direct compound literal and
by-value call. Unions and pointer/resource fields remain outside the tier.

Function return aliases exposed the evidence that was genuinely absent.
Clang's function AST retains `ZIdentifier` but does not provide a desugared
return signature, so `ZFDCL` version 5 now carries scalar typedef declarations
and their verified underlying types. The Z normalizer resolves `ZIdentifier`
to `u64`, while the emitted ABI continues to call the header declaration
directly. C typedefs are flattened rather than invented as nominal Z types.

This tier is deliberately smaller than Stage 0's record model. Only plain,
recursively copyable C structs cross by value; unions remain confined to the
opaque contracted-output tier, while pointer/resource fields and by-value
ownership facts still fail closed. Running
the fixture through the standalone command also exposed a driver parity gap:
quoted headers in the project directory were visible to Stage 0 but not from
the native cache directory. Native project compilation now includes the owning
project directory automatically, without requiring a redundant
`includeDirectories` entry.

The next native interop slice crossed ownership-bearing C records without
flattening them into Z storage or wrapping their ABI. `ZFDCL` version 6 added
canonical C record identity, so a contract written against an original typedef
governs function signatures that use an alias of the same Clang record. The
Z-owned `.zd` normalizer verifies `move; deinit release;`, proves that the
release consumes the same record by value and returns `void`, and refuses an
unclassified resource record.

Producer ownership is equally explicit. An `owned;` result becomes a unique Z
owner with deterministic cleanup; a `borrowed;` result becomes a non-escaping
`view` and cannot be returned, captured, or stored in an owned field. A
resource parameter spelled `in value` is still a Z borrow, but its lowering
evidence records `inValue` when C receives the record by value. This keeps the
source capability and native ABI orthogonal: the caller retains its owner, the
C call remains direct, and no accidental address-taking changes the signature.

`ZFDCL` version 7 retains exact native spellings for every field of an
otherwise-supported record. This does not expose raw pointers to safe Z: the
native normalizer still withholds them. It gives the `.zd` checker enough ABI
evidence to verify that a reviewed field projection names a real compatible
`const char *` instead of trusting a second description of the record layout.
The executable fixture covers construction, mutation through a pointer, owned
copying, explicit move-to-release, implicit scope cleanup, alias identity,
borrowed observation, borrowed escape rejection, and use-after-move.

The following native slice crossed opaque pointer owners without pretending
they were record values. A `.zd` `deinit` fact on a direct nullable result or
nullable `out T**` establishes one unique handle type and verifies the exact
`release(T *) -> void` contract. The generated C retains the native pointer ABI,
uses a collision-safe internal typedef only for Z storage identity, initializes
unfilled outputs to null, and destroys a partially produced handle before a
typed status error propagates. The pressure fixture exercises direct null
narrowing, implicit scope cleanup, explicit `move` into release,
`Option.fromNullable`, successful output, failure with a produced handle, and
failure without one. It also exposed that native `out` inference had updated
flow state without exporting the inferred declaration type; semantic evidence
now records that type at the original `let` binding rather than asking lowering
to reconstruct it from a later call.

The paired borrowed-pointer tier deliberately introduced no lifetime syntax.
A producer returning one exact header-derived pointer may declare `borrowed;`.
Z represents the result as a nullable, lexical view: a null guard
narrows it for direct `in` observation, but it cannot be returned, stored,
captured, consumed, or lifted into owned `Option` storage, and generated C never
calls the release operation for it. This closes accidental cleanup and escape
without pretending Z knows whether a library global, runtime, or input owner
actually governs the pointer. Requiring an unrelated owned producer would not
prove that lifetime, so borrowed-only library singleton APIs remain usable;
owner-tied escape awaits an explicit provenance contract.

The next pointer tier supplied that missing owner provenance without adding
general lifetime parameters. A `.zd` result may declare `borrowed from owner;`
when `owner` is one non-null immutable `in` handle. The child remains a direct
C pointer at runtime, but semantic analysis records a lexical loan against the
owner. Nullable children lift into `Option<view native.Child>` rather than
`Option<native.Child>`: `Option` expresses presence, while `view` expresses
non-ownership. The view may cross a Z helper boundary derived from the same
`in` owner; moving the owner while the result is live is rejected. This gives
ordinary parent/child C APIs a safe path without pretending a library-global
borrow has provenance that the contract cannot prove.

SQLite then exposed the complementary lifetime hazard: an owner may remain
live while an ordinary native operation invalidates storage borrowed from it.
The `.zd` fact `invalidates owner;` now records that semantic effect separately
from ABI access. Stage 0 ends lexical view loans at last use, while the native
frontend proves the same conflict conservatively through lexical view scope.
Both reject invalidation with a live child and emit the original direct call
after the view ends. Z Notes now declares `sqlite3_column_text` as borrowed from
its statement and `sqlite3_step` as invalidating that statement; copying the
text into owned `String` storage keeps the existing loop valid without unsafe
code or wrapper allocation.

The next native parity slice made that SQLite contract representable without
borrowing Stage 0's type evidence. The Z-owned `.zd` parser now recognizes
`view cstring | null`, and its normalizer proves that Clang reported exactly one
character-pointer return before publishing the borrowed text type. Explicit
`borrowed from owner;` provenance flows through the existing native loan graph,
so a later `invalidates owner;` call rejects a live text view just as it rejects
a live opaque child pointer. A standalone native-driver fixture executes the
direct call, preserves `const char * const` local storage, and rejects both a
non-character native result mislabeled as text and invalidation before the view
scope ends. No wrapper, copy, retain, or runtime validity check was added.

This composition pressure exposed one real ownership rule rather than a
bootstrap exception. Constructing a cleanup-bearing `ModuleSource` directly in
the borrowed `parseModule` argument did not provide a named lifetime, so Z
rejected it. Binding the source first makes its lifetime explicit across the
call and allows deterministic cleanup after parsing. A second boundary remained
The driver originally exposed a native-console syntax restriction: only a
literal or template was recognized as a standard console call, even when an
ordinary expression was already proven to be `String`. The native standard
signature now accepts any `String` expression, so the driver forwards its owned
error payload directly:

```z
console.error(message);
```

Formatting arbitrary non-String values remains outside the self-hosting
subset; this slice removes a syntax-shaped restriction without weakening the
typed `in String` contract.

A value-producing `if` whose result was `Result<i32, String>` passed semantic
analysis but remains outside native lowering. The driver therefore dispatches
commands through ordinary statement branches and a shared consuming
`reportOutcome` helper. This is a native-emitter composition gap, not a language
restriction; it should close when general value-`if` lowering reaches
cleanup-bearing results.

Writing that helper also exposed an unrelated Stage-0 ordering hole: explicit
`Result<T, E>` annotations were accidentally routed through general generic
monomorphization and only appeared to work when another throwing call happened
to materialize the same result enum. `Result` now has direct compiler-provided
materialization, including payload-free `Result<void, E>`, so annotations no
longer depend on discovery order.

The driver uses existing ordinary Z modules and collections; it did not require
trait values, a compiler-only graph loader, or a new lifetime mechanism.
`Set<String>` provides lexical discovery deduplication, `Array<ParsedModule>`
owns the growing graph, and the same `ModuleGraph` consumed by the in-process
bridge flows directly into C emission. That is positive evidence that the
earlier resolver modularization created a reusable compiler architecture rather
than merely splitting a large source file.

This is not yet a distributable replacement for Stage 0. The native loader now
canonicalizes every module through typed `fs.realPath`, preventing lexical or
symlink aliases from creating duplicate module identities, but supports only
the self-hosting subset. Broader foreign declaration/`.zd` categories,
Swift-target preparation, cross-platform target selection,
manifest-selected/custom profiles, complete diagnostics, native-library
resolution outside explicit link directories, foreign-cache locking/eviction,
incremental frontend reuse, and
production command options remain to cross independently.

## Interop probe: exporting a Z library to C

Source:
[`examples/interop/c/z-export`](../examples/interop/c/z-export)

The reverse-boundary probe builds a scalar Z library through a checked
`static-library` manifest, publishes a guarded header and native archive, then
links and runs a handwritten strict-C consumer. Exported functions remain
ordinary Z functions internally: one export calls another and also calls a
private helper.

That private helper deliberately uses the valid Z name `double`. The first
generated translation unit emitted it verbatim and collided with C's `double`
keyword. Z parameters already passed through backend identifier escaping, but
free function definitions and calls did not. The Stage-0 backend now applies
the same C/C++ reserved-word mapping consistently to private function symbols.
The public `export c` spelling remains an exact ABI contract rather than a
compiler-mangled name.

This is useful composition evidence: source-language identifier freedom has to
survive every backend position, and readable native examples expose hygiene
holes that compiler-internal fixtures can miss.

The same project now builds through the fixed-point native `z`. Its semantic
graph and C bridge carry an explicit `nativeCExport` fact, lowering rewrites
ordinary Z calls to a private implementation symbol, and native emission owns
the exact public wrapper and guarded header. The Stage-0 and native archives
run the same C consumer unchanged. This closes a real self-hosting seam: native
parity covers an outward ABI artifact, not only executable programs.

## Native test runner through the fixed-point driver

The fixed-point native `z` now owns the first end-to-end `test` command. It
discovers inline tests across the selected module graph, lowers
`expect(...).toEqual(...)` and `fail(...)` into the existing
`Result<void, String>` function contract, emits one native runner, preserves
source locations in expectation failures, continues after a failure, and
returns a process failure only after the suite finishes.

This exposed an evidence-composition boundary rather than a new language rule.
Capability arguments such as `expect(in answer)` contain an
`argumentBindingExpression`, not an ordinary identifier node. Native lowering
already treated both as the same local value, but its fallback type lookup only
recognized the ordinary identifier shape. Call expressions nested inside
expectations similarly needed to consume the already-recorded call-result
evidence. Extending the shared type lookup closed both cases without special
test-only ownership semantics.

The runner reuses ordinary cleanup planning on every conditional failure path.
Tests remain normal Z functions internally, production emission still erases
them, and the fixed-point compiler can now validate its own Z test surface
without returning to the TypeScript command driver. Filtering, reusable
assertion helpers, discovery beyond the selected import graph, and async tests
remain separate composition slices.

## Array destructuring and the first local Slice

Source:
[`examples/language/basics/array-destructuring.zs`](../examples/language/basics/array-destructuring.zs)

TypeScript-shaped positional bindings composed cleanly with Z only after making
the rest cost explicit:

```z
const [first, _, third] = values;
const [head, ...remaining] = view values;
```

Copying JavaScript's rest behavior would have hidden an allocation. Z instead
uses `view` to produce a two-word `Slice<T>` tied to the fixed array,
`Array<T>`, or existing Slice owner. That made array rest the first justified
local-Slice exception: arbitrary Slice locals are still rejected, while this
compiler-produced subslice carries a named provenance loan, cannot escape, and
blocks owner moves or reallocating mutation only until its last use.

Cleanup-free selected elements load by value. Cleanup-bearing selected elements
remain `view T`, so destructuring an `Array<Document>` neither copies titles nor
relocates owners. Plain ownership-bearing extraction fails with guidance toward
`view`; future owned `copy`/`move` patterns remain separate because dynamic
buffer splitting and partial initialization need an honest cost model.

The implementation exposed two useful backend constraints. First, a rest Slice
from a `const T[N]` still uses the shared mutable-capable Slice ABI, so C
lowering must perform an explicit internal pointer-qualification adaptation
while Z keeps the binding immutable and rejects `inout`. Second, indexed or
computed owner paths would make naïve lowering evaluate the source once for
each selected element. The first tier therefore accepts direct named bindings
and fields; callers bind a nested collection before destructuring it.

The native parser and resolver carry positional binding kinds directly rather
than encoding indexes and rest through object-field sentinels. This preserved
Stage-0/native canonical parity and made `_`, named elements, and `...rest`
available to native semantic evidence and editor services independently.

## Application configuration without runtime globals

Source:
[`examples/language/modules/app-config.zs`](../examples/language/modules/app-config.zs)

The desktop-framework pressure test needed application-wide named values before
it needed shared mutable global state. Implementing those as module-level
`const` values made the distinction explicit: a literal configuration value has
no initializer task, ARC root, destruction order, lock, or executor affinity.
It lowers to immutable static native storage and imports through the same
namespace or selective-binding path as functions and types.

The first tier intentionally accepts only cleanup-free literals. `String`
constants use immutable static UTF-8 bytes; copying the small value descriptor
into ordinary Z storage remains safe, and mutation allocates owned storage
instead of modifying the module value. Exported constants state their type so
editing an initializer cannot silently change another module's contract.

Native self-hosting exposed the important implementation constraint: a
selective import and a namespace member must resolve to the same declaration
identity, not masquerade as foreign-header constants. Native semantic evidence
now records one deterministic module symbol, and strict C execution proves
local, namespace, and aliased reads. Runtime singletons, shared ARC roots,
module-level mutation, target-conditional values, and initialization/destruction
ordering remain separate designs rather than consequences hidden inside
`export const`.

## Application lifetime root without mutable globals

Source:
[`examples/applications/application-root`](../examples/applications/application-root)

The next desktop-framework pressure test needed a long-lived user-defined
`Application` identity without turning module storage into arbitrary mutation.
`Once<Application>` separates those concerns. Its native storage begins empty
without running module code, `initialize` publishes one strong ARC reference,
and a move-only `OnceLifetime<Application>` makes the publication interval
lexically visible in `main`.

The first main-lifecycle tier exposed four useful constraints:

- the root inherits `Application`'s lifecycle requirement rather than
  converting ARC lifetime safety into permission to access UI state anywhere;
- retrieval and access are separate capabilities: a native worker can retain
  the identity directly, but member contracts still decide what it may use;
- deterministic guard cleanup removes the root before the surrounding local
  application reference is released, avoiding an implicit process-lifetime
  leak or unspecified module destruction order;
- throwing construction happens before publication, so `Once<T>` stores
  neither partial identity nor an error that `get()` might later replay.

The synchronized retrieval follow-up then added an OS mutex to the static cell,
atomic ARC to main-lifecycle identities, and executor-routed final release from
native workers. A mixed-affinity `Application` can now be retrieved from any
Z-managed thread, call its unrestricted `Mutex`-backed methods there, and still
receive a compile-time error for a main-only UI field. Whole-class-isolated
identities remain opaque off-main. Initialization and `OnceLifetime` cleanup
remain main operations.

This is intentionally not evidence for general global storage. Ordinary
mutable/shareable classes, value structs, native owners, replacement, optional
presence, and concurrent weak upgrade remain unproven. The `Application` name
belongs to the example and a future desktop package; only the generic
publication-and-lifetime mechanism belongs to Z.

## Scoped shared state without an escaping guard

Source:
[`examples/language/ownership/mutex-state.zs`](../examples/language/ownership/mutex-state.zs)

The application-framework pressure test also needs shared mutable state, but
neither module `const` nor `Once<T>` provides mutual exclusion. The first
`Mutex<T>` tier places one value in address-stable protected storage and admits
access only through synchronous non-escaping `withLock` closures.

The deployment-coordinator probe distinguishes the two capabilities explicitly:
`(in state)` takes a read-only loan and `(inout state)` takes a mutable loan.
The closure can return an ordinary value or independently owned snapshot, while
a `view` or other alias into the protected payload cannot escape. Normal
completion and typed failure follow the same generated unlock cleanup path.
The failure probe then acquires the mutex again, establishing that ordinary
typed errors do not poison protected state.

This shape exposed three useful design constraints:

- mutex acquisition blocks the executing OS thread; it does not masquerade as
  task suspension, so executor-sensitive code must choose where blocking work
  runs;
- `await` while holding the protected borrow is rejected, preventing a task
  from suspending while retaining exclusive access;
- `const Mutex<T>` fixes the synchronization identity while `inout` still
  permits controlled mutation of the protected value, without weakening
  ordinary `const`.

The closure boundary is intentionally narrower than a public lock guard. It
makes unlock and borrow end structural and removes forgotten unlock, escaped
guard, and use-after-unlock shapes from the first tier.

The next pressure slice made the handle itself shareable across
`thread.spawn` when its payload is transferable and safely destructible on the
receiving worker. Each task frame owns an atomic retain of the same stable cell;
the parent can use its handle before and after join, and final release destroys
the payload and native mutex once. This also forced thread-transfer evidence to
distinguish trivial copy, unique move, retained share, and executor-bound
opaque transport instead of overloading cleanup-bearing moves. Main-isolated
and unknown-cleanup payloads remain rejected at capture time.

The probe still does not prove read/write locks, asynchronous mutexes, atomics,
condition variables, semaphores, timed acquisition, nonblocking acquisition,
or arbitrary native resource payloads.

## Mixed-affinity application identity

The next application-framework slice combined a main-thread native handle with
ordinary metadata and mutex-protected Z state in one ARC class:

```z
class Application {
  readonly name: String;
  readonly state: Mutex<ApplicationState>;
  window: AppKit.NSWindow on thread.main;
}
```

Treating inherited affinity as whole-object isolation made this class safe but
needlessly inert on workers. Treating it as ordinary shared identity would make
native handle access and destruction unsound. The resulting split is:

- the isolated field determines construction and destruction placement;
- the field itself and every mutable or non-shareable sibling remain main-only;
- readonly transitively safe fields and unrestricted methods remain available
  on a native worker;
- unrestricted methods receive no main proof and cannot let bare `this`
  escape;
- the explicit `move` thread-closure marker remains, while the captured ARC
  identity is retained and the parent reference survives.

This validates member-level affinity as an access contract distinct from
aggregate lifecycle affinity. It also confirms that `Mutex<T>` is the intended
way to keep mutable Z state behind an any-thread application façade.
`Once<T>.get()` now completes the composition: a native worker synchronizes
with the publication cell, atomically retains the identity, uses only the
permitted surface, and queues its final release to `thread.main`. The parent
continues to use the same root and its main-only member after joining.

## Real AppKit identity in the synchronized root

Source:
[`examples/applications/zapp-appkit`](../examples/applications/zapp-appkit)

The framework skeleton now stores actual `NSWindow` and `NSTextField`
identities in the mixed-affinity `Application`. A dedicated worker retrieves
that same root through `Once<Application>`, increments and completes a job
through `Mutex<RuntimeState>`, and then executes a direct
`await on thread.main publishApplicationStatus(ticket)` call. The placed call
updates both native UI objects; the parent subsequently closes the window on
main and releases the root deterministically.

This confirms that member-level affinity survives imported Objective-C
identity rather than working only for synthetic integer fields. It also found
one current lowering boundary: direct imported Objective-C expressions are not
yet executable in an async frame. Main-bound synchronous
`createApplication()` performs native setup while preserving exactly the same
executor proof, and the async task composes the resulting Z identity normally.

The subsequent pthread callback probe closes the corresponding checked-import
gap. A `.zd` callback declared `thread any` now captures the active Z runtime in
its escaping callback box. Generated invoke and release adapters enter that
runtime, restore any previous nested thread-local route on exit, and retain the
executor until native code releases the callback. The foreign thread can
therefore retrieve the same `Once<Application>` root, use its `Mutex`-guarded
surface, and schedule main-bound work without manually attaching the thread.

This does not grant the callback main-executor proof: direct main-only access
remains rejected and must cross `TaskScope.schedule(thread.main, ...)`. The
same bounded entry primitive will be needed for future `export c` entry points,
together with an embedding-level runtime initialization and shutdown contract.

The Objective-C and Swift probes now use that same primitive without a C-style
context/release ABI. An ARC `Z_ObjCClosureBox` captures the active runtime beside
the owned Z closure, retains the executor until native ARC deallocates the box,
and enters the runtime around both invocation and closure release. A direct
Objective-C fixture dispatches its block on a global queue; the Swift task-scope
example does the same through a generated Objective-C compatibility header.
Both callbacks retrieve a mixed-affinity `Once<Application>`, mutate only its
`Mutex` surface, and publish through a joined `TaskScope` operation on main.
Direct access to the main-only field from the Swift callback remains `Z0711`.

An adversarial main-affine registration probe found that this guarantee was
initially lexical rather than executable: a closure inferred inside an
`on thread.main` function inherited that proof even when `thread.spawn`, a C
`thread any` callback, or an Objective-C `thread any` block would execute the
body elsewhere. Closure inference now receives an explicit execution context.
Synchronous nonescaping callbacks and `Mutex.withLock` inherit the caller,
`TaskScope.schedule(thread.main, ...)` supplies main proof, and native workers
or arbitrary-thread callbacks begin with no executor proof. Regression tests
exercise all three unsafe registration paths from a main-affine caller, not
only from an unrestricted helper. This preserves the ergonomic unrestricted
`Once.get()` facade while making member-level affinity the actual enforcement
boundary rather than a documentation claim.

## Generated-library runtime entry

The same bounded-entry rule now applies in the opposite interop direction.
Static- and shared-library projects publish target-scoped C lifecycle
functions in their generated header. A host initializes the Z runtime, may call
exports concurrently from its own native threads, joins or releases every
outstanding operation, and then shuts down. Public wrappers use atomic active
entry accounting and restore nested thread-local runtime routes; internal Z
calls continue to use private implementations directly.

Shutdown returns `busy` while an exported call or retained foreign callback
prevents teardown from starting. Once an executor-bound runtime-root finalizer
has been queued, it returns the distinct `draining` status and closes export
admission until the host drains that queue and retries. This distinction was
added after an asynchronous host hook exposed that the original state-4 entry
gate trapped while the documentation still described every `busy` runtime as
callable. A second shutdown during the drain no longer queues the root release
twice.
Executor-bound class lifecycle makes
the generated configuration's `enqueue_release` hook mandatory, so a foreign
host cannot silently finalize main-owned identity on an arbitrary worker. The
hook is intentionally narrower than task scheduling: it queues one compiler-
supplied finalizer exactly once. The handwritten `z-export` C consumer proves
the lifecycle against both Stage-0 and fixed-point native emitters;
`z-runtime-export` now adds an explicit `target.runtime.initialize` root. Its
main-bound initializer installs an `Application` in `Once`, returns the
`OnceLifetime`, rejects worker-thread startup, survives a pthread export call,
reports deterministic busy and draining teardown, and releases the application
exactly once at successful generated shutdown. This closed the embedding gap without
introducing mutable module globals or module initialization order: the target
owns one ordinary Z value, and a Z struct can compose additional roots.

The follow-up made that root operational rather than ceremonial. A pthread
enters through `z_embed_complete_job`, retrieves the mixed-affinity application
with `Once.get()`, mutates its `Mutex<EmbeddedState>`, and leaves one completed
job visible to a later C call. Attempting to read the same application's
main-only `uiRevision` from that export remains a compile-time affinity error.
The fixed-point native semantic graph accepts the same Once/Mutex/affinity
shape, and the first native lowering gap is now closed. Non-generic structs and
classes may own `Mutex<T>` fields, ordinary borrowing methods carry explicit
receiver evidence into C, and capture-free expression- or block-bodied
`Mutex.withLock` closures lower to real pthread/SRW acquisition and release.
The native `Once<T>` cell now uses the same synchronized publication protocol,
and native class retain/release is atomic, so the synchronous
`application-root/application.zs` core strict-compiles directly from the
self-emitted frontend. Mutable `inout this` calls now preserve the class
identity rather than transferring compiler-owned type evidence, and the
application-root fixture exercises that mutation beside synchronized reads.

Cleanup-free scalar captures now cross lock helpers by immutable pointer, so a
method argument can participate without being copied or escaping. Capturing
`this` and ownership-bearing captures remain later lowering slices. Block
bodies preserve their structured returns and mutations through a separate
native helper.

The next slice crossed the first real native-worker boundary. The self-emitted
compiler now lowers a capture-free `thread.spawn` closure to one
pthread/Windows worker, represents its cleanup-free scalar result as an owned
`Task<T>`, joins it on `await`, and also joins during deterministic task cleanup
when no explicit await consumed the join. Expression and block bodies work;
the block tier owns cleanup-free locals and can call ordinary Z functions. A
direct callee is classified as a symbol rather than a captured value. A `const
Task<T>` keeps a fixed Z binding while its hidden native join state remains
mutable, matching the existing class and mutex storage distinction. The
strict-C fixture executes the generated worker and checks that the awaited
value reaches `main`.

Thread workers may capture a cleanup-free Copy value. Native lowering
materializes a private per-spawn context, snapshots each value before the OS
thread starts, passes immutable pointers into the worker body, and frees the
context before reporting completion. The parent binding therefore remains
valid.

An ownership-bearing capture now follows the other half of that contract. An
explicit `move` closure transfers the owner into the private worker context;
the capture expression retires the parent's cleanup state, including its live
flag when the transfer is conditional. The worker destroys context fields in
reverse order after the body returns and also destroys them if native thread
creation fails. Expression- and block-bodied strict-C fixtures transfer owned
`String` storage and prove that the parent and worker cannot both clean it up.
Each uniquely owned context field now carries its own live bit. An explicit
worker-side move clears that bit before context destruction, so captured
String/TextBuffer storage may transfer into an owned callee, a worker local, a
task success result, or a typed failure. If no move executes, context cleanup
still destroys the field; if the returned task is discarded, task-result
cleanup destroys the transferred value instead. Shared ARC identity remains a
retained immutable capture and cannot be consumed, while other unsupported
cleanup-bearing aggregates continue to fail closed rather than being mistaken
for unique transfer.

The actual Zapp worker then exposed the classic join-versus-main-hop deadlock.
The native task storage now owns a condition-protected main-request slot. A
worker executing a direct `await on thread.main` publishes a typed callback and
waits; `main`'s await pumps the callback before joining, then wakes the worker
to finish. This first native tier requires the task to be created and awaited
by `main`; it fails closed rather than treating an arbitrary creator as the main
thread. The placed-call tier accepts a synchronous nonthrowing call, a
suspension-free async call with typed failure, or one deliberately bounded
taskified shape: a main-isolated async callee with multiple top-level literal
`await delay(...)` statements separated by synchronous expression statements,
whose placement is the worker closure's tail return. One top-level braced
`if`/`else` may instead contain direct literal delays. A top-level statement
consuming `match` over an enum-valued expression may likewise contain braced
delayed arms, including cleanup-free or cleanup-bearing payload bindings. The
condition or match subject is evaluated once on main. A named subject retires
its prior live flag as the frame takes ownership; a computed call or constructor
is adopted directly. A cleanup-bearing active payload moves between the
match-subject slot and selected arm binding at every
segment boundary. The same live bit follows transfer into a local, successful
result, or typed failure; cancellation observes that bit and destroys the
remaining owner on main. The worker enters only the chosen wait path, and the
paths merge before the suffix. Main runs each
synchronous segment. The worker waits on its condition variable rather than blocking main,
then publishes the next segment back to main. It carries `void`, scalar, or
ownership-bearing results and transfers owned value arguments through the
request context. Borrowed and mutable arguments remain deferred to the unified
cross-executor exclusivity checker. Initialized top-level locals and direct
local assignments now survive in one heap-owned invocation frame. A
cleanup-bearing local occupies one field plus one liveness bit; segment
handoffs transfer its bits without copy or retain, and cancellation routes its
destructor through main. Branch-local owned values use independent live bits,
so an unselected path never acquires cleanup responsibility. Parameter writes,
unrelated ownership transfers, and borrowed cleanup-bearing match subjects
still fail closed. A bounded top-level suspending `while` now reuses the same
frame: main reevaluates its condition and runs synchronous body segments, the
worker owns cancellable waits and repetition, and one control field transports
ordinary `break`/`continue`. Per-iteration cleanup-bearing locals reuse their
frame slot and liveness bit, and are destroyed once on normal iteration exit,
loop control, function exit, or cancellation. `return` and `throw` evaluate
their payload on main, run the existing cleanup plan, set one completion state,
and hand the success or typed failure to the worker without another frame.
A direct synchronous `try` statement reuses that completion state. Its success
payload either remains local or moves into an existing frame field across the
next wait; its failure payload moves into the frame's `Result` slot after the
ordinary cleanup plan runs. The callback returns before saving an intentionally
uninitialized success binding. Suspending `for` loops, nested loops or matches,
`try await`, nested try-value normalization across a wait, deeper suspension,
mixed outer/branch delay plans, and dynamic delays fail closed. The frame remains
valid through every main callback, and its `Result<T, E>` moves back into the
worker before the frame is freed.

The `if`, `match`, and `while` emitters now share one invocation-frame
lifecycle for context layout, argument liveness, callback rehydration,
cancellation cleanup, allocation, and result transfer. Shape-specific code is
limited to choosing and scheduling branches, arms, or iterations. This is the
important consolidation point: adding structured control no longer means
duplicating the ownership protocol and hoping its cleanup paths remain aligned.

That is enough to emit, strict-compile, and run the unchanged Zapp skeleton.
The native path constructs its imported `Application`, publishes it through
`Once`, mutates `Mutex` state on a pthread, executes `std/time.sleep`, publishes
status through a taskified main-isolated callee containing `await delay(1)`,
resumes and joins the worker, prints the final status, and releases the root.
Native async `main` still uses a synchronous host frame. The private worker owns
the timer wait; the main thread only runs the synchronous main-isolated
segments.

The task result path now carries typed failures and ownership through one
representation. `Task<T, E>` stores the same `Result<T, E>` tagged union used by
synchronous throwing calls; worker `return` writes `success(T)` and worker
`throw` writes `failure(E)`. Every task storage has explicit result liveness.
Worker completion publishes the whole tagged value before waking the owner;
`await` transfers it and clears the bit, while task cleanup joins first and
destroys an unobserved result by inspecting its active payload.

Strict-C fixtures exercise cleanup-free failures, owned `String` success, and a
fallible `Result<String, OwnedError>` whose error struct itself owns a String.
Consuming `attempt await` matches transfer and destroy exactly one active
payload. A typed local `try await` uses that same result storage: failure moves
the owned error into the enclosing function's Result, while success moves the
String into the local cleanup plan. The task handle then frees only its empty
storage. The runtime also emits aggregate/enum cleanup declarations before task
helpers so unobserved cleanup-bearing results remain valid strict C.

The native type resolver now infers the success type of
`const value = try await task` directly from `Task<T, E>`; the annotation is an
optional source-level aid rather than a backend requirement. A direct
`return try await task` preserves the complete compatible Result storage while
running the enclosing cleanup plan first. Nested `try await` now normalizes
call arguments and eager value operators into source-ordered hidden locals.
Every hidden failure edge cleans prior hidden results plus the ordinary live
owner set. Cleanup-bearing success values are destroyed after a borrowed use
or transferred without a second cleanup when an owned parameter consumes them.
The normalized statement sequence deliberately stays in the user's lexical
scope so a surrounding `const` remains visible afterward. Ternaries now add a
branch-local destination: only the selected branch awaits, its success value
moves into the destination, and its failure path cleans both ordinary live
owners and branch-local temporaries. Executable probes cover a heap-backed
String result, an unselected throwing branch, and a selected typed failure.
Value-`if` and value-`match` still require the corresponding branch-local
normalization rather than eager hoisting.

Block-bodied native workers now own an independent cleanup scope rather than
borrowing the enclosing function's liveness plan. Cleanup-bearing locals are
destroyed in reverse order on every worker `return` and `throw`; moving a local
into the success or failure payload retires only that worker-local live flag.
The worker return statement also carries its own native result type, so cleanup
temporaries cannot accidentally inherit `main`'s return type. One executable
fixture covers an infallible local `String`, success-side transfer beside an
unused owned error, and failure-side transfer that destroys the unused String.

Native lowering admits result and error shapes only when their complete value
graph is safe to transfer and destroy away from the producing worker. A
custom-deinitializer result is a negative fixture and fails before C emission;
it is not silently treated as Send-like. Re-moving ownership-bearing captures,
selected value-`if`/value-`match` nested `try await`, general suspension,
cleanup-bearing placed arguments/results, void-result native workers, and
additional executor forms remain later slices.

Deeply readonly ARC identity now exercises the shared half of worker capture.
Native lowering carries conservative shareability with each lowered class,
including across module imports. A capture retains into the private worker
context instead of retiring the parent's binding; context cleanup releases
that retain after the body completes and on native thread-creation failure.
The parent therefore remains independently usable before and after `await`.
The strict-C probes cover local and imported deeply readonly classes and reject
mutable, custom-cleanup, and re-consumed capture shapes. Executor-bound identity
uses the separate opaque-transport path described above: workers cannot inspect
it, and final release is routed to the owning executor. A second imported probe
stores mutable `Counter` state behind a readonly `Mutex<Counter>` field; the
class remains shareable because exclusion protects access and the payload is
proven safe to destroy on the worker that releases the last identity.

Every generated public wrapper still installs and restores the same
foreign-thread executor-release route as Stage 0. Native ARC release now
consumes that route for executor-bound identity: its last release enqueues an
extracted finalizer when a route is installed and invokes the same finalizer
inline otherwise. A fresh fixed-point emitter builds the embedding application
with that route, and the handwritten consumer preserves its expected lifecycle.

## Diagnostic identity and mutex hardening

Cross-module application probes exposed that linked identities such as
`__z_module_1_Application` were escaping through member, affinity, construction,
and ownership diagnostics. Type rendering now projects canonical compiler
identity through the module display-name map at the diagnostic boundary,
including nested forms such as `Mutex<Application>`. Generated names remain in
C and native semantic evidence, but source diagnostics use names developers
can actually write.

The same pass reconciled two mutex analyses that had diverged. Native-thread
transfer already treated `Mutex<T>` as retained shared identity when `T` was
transferable, while deep class shareability treated the same field as an
unknown generic representation. `shareableTypeIssue` now recognizes that
contract, so a readonly class whose mutable state is entirely mutex-protected
can cross a worker boundary without acquiring an unrelated main-only field.

`Mutex<T>` also now rejects direct recursive acquisition of the same named
storage during closure analysis. That closes the common self-deadlock shape
without pretending that the current alias analysis can prove two arbitrary
expressions identify the same mutex. Alias-derived reentrancy remains a later
exclusivity-analysis problem. Finally, compiler-private static helpers are
marked unused independently of whether their source declaration came from a
linked module, so a valid but not-yet-instantiated class no longer fails in
Clang under `-Werror`.

## Host-thread and ambient-process hardening

The library review also separated two concerns that an executable gets from
`main` but a foreign host does not. Every Objective-C-backed C export now opens
its own autorelease pool around the public invocation, so a pthread supplied by
the host does not leak autoreleased temporaries merely because it entered Z.
The pool is outside the private Z implementation and therefore adds cost only
at the native boundary.

Conversely, library targets now reject `process.args()` and
`process.executablePath()`. Their current runtime source is the argument vector
installed by Z `main`; silently returning an empty array or a missing path from
a shared library would turn absent host configuration into ordinary data.
Passing host data through an explicit C export is the safe current shape, and a
future embedding config may add a reusable argument channel deliberately.

`Once<T>` runtime traps now distinguish never initialized, already active, and
publication lifetime already closed. Retrieval and cleanup already serialize
on the cell mutex: a winning retrieval retains independent ARC identity, while
a losing retrieval traps after closure. This proves memory safety but not
logical scheduling, so structured workers that may call `get()` must join
before the `OnceLifetime<T>` owner leaves scope.

Finally, the review's proposed `thread any` plus call-scoped callback hole was
already rejected by `.zd` validation: `in` callbacks cannot declare threading
or release facts, while arbitrary-thread callbacks must be escaping `move`
registrations with a complete release contract. A regression fixture now
protects that fail-closed rule explicitly.

The review also noted that the first weak-reference side table uses a
non-atomic count. That is inside the current supported boundary rather than an
unprotected cross-thread operation: `Weak<T>` cannot cross a native thread,
and the transfer checker has a regression test for that rejection. Supporting
concurrent weak upgrade requires one coherent atomic side-table protocol for
control-block publication, value clearing, upgrade, and weak counts; changing
only the counter would not make the operation safe. That broader protocol
remains deliberately deferred.

## Native worker cancellation owns the losing outcome

The fixed-point native backend now lowers the same consuming `await
task.cancel()` surface as Stage 0 for its first `thread.spawn` tier. The task
storage carries a synchronized cancellation request. A worker checks it before
entering the body, but cancellation does not attempt to interrupt synchronous
native code after that boundary. In either race outcome the caller joins the
thread and destroys the transferred capture context.

The more important ownership result is after completion: cancellation destroys
an unobserved cleanup-bearing success or the active payload of `Result<T, E>`
exactly once. A second executable probe now cancels during a taskified
main-callee delay. Cancellation wakes the worker's condition wait immediately;
the joining main thread executes a dedicated cleanup continuation for the
callee's transferred `String` argument, and the remainder of the callee never
runs. This avoids both deadlock and abandonment without claiming interruption
of synchronous code. Arbitrary suspension points, cancellation after multiple
continuations, and cross-executor loans remain later state-machine tiers.

## Native semantic authority must include rejection parity

The main-executor state-machine work exposed a more important pressure result
than another accepted async shape: executable native lowering can advance
faster than the native semantic checker that is supposed to constrain it.

A mixed-affinity ARC class may intentionally expose synchronized metadata on
any thread while keeping one field on `thread.main`. Stage 0 correctly rejects
reading that field from a `thread.spawn` worker with `Z0711`. The review
checkpoint found that the fixed-point native `check` and `build` paths retained
the field's affinity in their graph but did not perform the access-context
comparison, so they accepted and emitted the same invalid program. This was a
semantic safety gap, not merely an unsupported feature or a diagnostic-quality
issue.

The corrective invariant is now explicit: a native lowering slice requires
positive execution parity, negative ownership/capability/sendability/affinity
parity, and a current status boundary. The existing sixteen-root differential
corpus supplies broad positive evidence but cannot prove invalid programs are
rejected. Native sema now closes the observed gap for off-main field, method,
and function access, while preserving valid inherited context inside placed
bodies and `Mutex.withLock` closures. Construction and weak operations also
consult lifecycle affinity. Dedicated negative fixtures keep those rules in
Stage-0/native parity.

The same review found two supporting process lessons that now have mechanical
guards:

- direct `self-host-emit-*.zs` fixtures now require a catalog classification as
  positive differential roots, negative cases, specialized protocol cases, or
  intentional exclusions, because adding an executable fixture does not
  automatically add it to the parity corpus;
- bare `bun test` now receives the same 60-second default budget as the package
  script through `bunfig.toml`, avoiding the former five-second false failures
  under parallel Clang, bootstrap, and Swift contention.

Native hard-stop diagnostics and the frontend status document also need to
move with each slice. Diagnostic codes and polished resolver messages are a DX
follow-up; they do not substitute for semantic rejection coverage.

The first follow-up now inserts a lowerability preflight between native semantic
resolution and IR construction. Ordinary unplaced async functions retain
`Z0700`; generic aggregates, traits, aliases, function-value and fixed-array
types, `Slice`, generators, destructuring, value-producing loops, unsafe
expressions, and other syntactically settled body gaps use `Z1000`, which
explicitly means “valid Z, outside the current fixed-point executable tier.”
Both the standalone driver and the Bun-hosted native emitter preserve the code,
source location, and span. Public lowering and C-emission boundaries now mark
anything that still evades the catalog as an explicit internal compiler error.
The remaining inventory is deliberately split: expected tier boundaries move
from that fallback to coded diagnostics, while malformed, lost, or mismatched
IR guards stay visible compiler errors.

The same audit found two issues that could not be disguised as `Z1000`, and the
next parity slice closed both. Native flow bindings now retain the owner of a
lexical `match (in value)` loan, so statement and expression matches reject
`await` with the same source-mapped `Z0704` as Stage 0. Ordinary async
parameter borrows remain suspension-safe, consuming matches remain owned, and
async-generator frames retain their deliberate persistent-match exception.
The graph-aware lowerability preflight also resolves direct
`await on thread.main operation()` targets before IR construction. When the
target suspends but the placed call is not the worker closure's tail return,
both native emission and the standalone native `check` command now report a
source-mapped `Z0700` instead of exposing a C-emitter-only hard stop.
Graph-provided expression types also moved the first evidence-dependent backend
gap out of the internal-error fallback: iteration over `Set`, `Map`, or another
non-`Array` iterable now reports source-mapped `Z1000` before the current
Array-only native loop lowering runs. The same evidence path recognizes
cleanup-bearing optional field projections as `Option<view T>` and reports
their current native boundary at the member access instead of leaking the
lowerer's deferred-projection string. Resolved binding and expression types now
also stop unsupported collection representations before C emission:
non-`String` `Set` elements, non-`String` `Map` keys, and the currently known
unsupported `String` or nested collection values receive source-mapped `Z1000`
diagnostics.
This is deliberately a fixed-point runtime boundary, not a retreat from Z's
generic `Map<K, V>` and `Set<T>` language surface. Explicit `copy` now uses the
same evidence path: non-`String` copies report `Z1000` at the keyword while the
implemented owned `String` copy continues through native lowering and C
emission. Native `Mutex.withLock` result checking now reuses the semantic
graph's recursive cleanup analysis as well: owned results such as `String`
receive a source-mapped `Z1000` at `withLock`, while cleanup-free scalar and
`void` results continue through the implemented scoped-lock lowering.
The same audit now distinguishes supported thread capture forms rather than
blanket-rejecting ownership. A move closure can still transfer an owned
`String`, and shareable readonly ARC identity is still retained. An inferred
local struct or enum whose graph recursively needs cleanup now reports `Z1000`
at the captured identifier before the current worker-context lowering would
lose its destruction obligations.
Native template lowering had a similar evidence-dependent leak: Stage 0
correctly accepts a much broader set of Z values, while the fixed-point runtime
currently has formatters only for owned/viewed `String`, `boolean`, `i32`,
`u8`, and `usize`. Other resolved interpolation types now report source-mapped
`Z1000` at the embedded value. Interpolations whose Stage 1 expression-type
evidence is still incomplete now fail at that same source boundary instead of
reaching a native lowering assertion. Expanding the native formatter set remains
implementation work rather than a change to Z's string-interpolation semantics.
The spread audit also exposed why contextual keywords must remain contextual in
lowerability. `copy ...source` performs field-wise copying and must not be
classified as standalone `copy value`; its existing native positive remains.
For `move ...source`, retained fields transfer into the destination, while an
overridden cleanup-bearing field still belongs to the consumed source and must
be destroyed exactly once. Until native lowering emits that partial cleanup,
the capability keyword receives source-mapped `Z1000`; no-override moves and
cleanup-free overrides remain executable.
Value-producing `if` expressions are another intentional language feature whose
native lowering is not complete. Stage 1 now reports `Z1000` at the expression's
`if` token instead of falling through to a lowering assertion; ordinary `if`
statements and ternary expressions remain executable native controls.
Stage 0 also exposes checked, wrapping, and saturating integer arithmetic, but
the current native IR only lowers the checked operators and the three wrapping
methods. `saturatingAdd`, `saturatingSubtract`, and `saturatingMultiply` now
report `Z1000` at the integer method token; this exact-name and integer-receiver
classification leaves user-defined methods and the executable wrapping tier
unchanged.
Imported integer-like values exposed one more evidence boundary: explicit
integer conversion requires the operand's source type before native lowering
can choose a direct cast or checked helper. A missing source type now reports
`Z1000` across the conversion operand instead of reaching that lowerer
assertion; the existing resolved scalar conversion chain remains executable.
Closures remain supported language values, and native lowering already owns
their inline `thread.spawn` and `Mutex.withLock` contexts. Storing an inferred
closure as a first-class local still requires a native function-value and
environment representation; Stage 1 now reports that boundary at the root
closure expression instead of trying to lower the internal function type.
## Native Arena pressure exposes the next region boundary

The fixed-point native compiler now owns the first `Arena` representation rather
than treating regions as a Stage-0-only feature. Direct and selectively aliased
`std/memory` imports lower to aligned stable pages. `create` transfers owned
values into type-specific helpers, cleanup-free values carry no destructor
record, cleanup-bearing values register reverse-order cleanup, `reset` frees the
batch and permits reuse, and scope exit performs the same cleanup. Native
semantic rejection covers immutable Arena storage, reset while a view has a
later use, async access, and direct class roots. The last-use scan that permits a
valid reset uses the same view-owner state as the existing loan checker rather
than introducing an Arena-only escape rule.

A differential managed-value fixture moves an aliased region into an owned
parameter after storing a struct with `String`, `Array`, and ARC-class fields.
That composition exposed a native struct-cleanup bug which emitted a nonexistent
class `deinit` call; value-struct fields now release ARC identity through the
same retain/release path as class and enum fields. The fixture verifies one
region cleanup, one container cleanup, and one final ARC release.

The executable pressure path is compiler-shaped: Source Inspector tokenizes
`compiler/frontend/lexer.zs` with the production Z lexer, creates 5,753
short-lived token-coordinate records in a 4 KiB region, reads each through its
inferred view, and resets the complete batch. This forced multiple native pages
and verified that cleanup-free records do not receive per-value cleanup
metadata. It also exposed a composability bug outside Arena: native lowering
treated every member named `byteLength` as the String intrinsic even when the
receiver was `view TokenCoordinate`. Intrinsic member lowering is now gated by
the resolved `String`/`TextBuffer` receiver type, and the probe deliberately
keeps the colliding field name as regression coverage.

On the August 2026 macOS ARM64 development machine, ten warm-cache emission runs
measured a 101.8 ms native median versus 124.4 ms through Stage 0 for this
two-module probe. Fifty optimized executable runs measured 1.9 ms versus 2.0 ms
for native- and Stage-0-emitted C respectively. The runtime difference is within
process/filesystem noise and is recorded as parity, not a speedup claim.

The first follow-up closes the fixed-shape part of that wall without adding
lifetime syntax. A local value struct may contain multiple views when all of
them resolve to exactly one owner, may enter a synchronous immutable `in`
parameter, and may transfer only into that same Arena. The compiler rejects
mixed-region construction, implicit composite copies, normal collection/class/
enum storage, returns, mutation, and suspension. Native lowering represents the
borrowed fields as pointers and excludes them from cleanup while still
destroying ordinary owned fields in the same struct.

The differential `self-host-emit-arena-graph.zs` fixture stores two
`view TokenCoordinate` edges in `TokenSpan`, stores that span in its owner
Arena, then stores a cleanup-bearing `NamedTokenSpan` pointing at it. Stage 0
and the fixed-point emitter produce the same result. The probe exposed two
native-only ownership bugs before they reached compiler data structures:
lowering initially copied borrowed fields into value locals, and an implicit
Arena transfer left the source cleanup live. Both now lower as pointer borrows
and consuming moves, while the containing `String` is destroyed exactly once.

The next slice established the first dynamic provenance without adding syntax.
A populated `Array<TokenSpan>(...)` may consume one-owner view-bearing structs,
prove that every element belongs to the same Arena, and then move only into that
Arena. The fixed-point lowerer gained populated Array construction rather than
delegating that path to Stage 0; its bulk constructor allocates once, copies the
already-consumed value representation into the buffer, and registers the Array
cleanup with the region. Stage 0 and native negative probes reject immutable
empty view-bearing Arrays, mixed owners, use after element transfer, and
transfer into the wrong Arena.

The follow-up mutable slice lets `let Array<T>()` begin without an owner. Its
first `push` consumes a view-bearing element and establishes the Arena identity;
subsequent pushes must prove the same owner. Flow-sensitive joins now accept
exhaustive `if`/`match` control flow when every continuing path establishes
identical provenance. Stage 0 also preserves that evidence through
value-producing expressions; native expression emission retains its existing
bootstrap boundary. Missing paths and mixed owners fail at the join; loop-only
establishment remains rejected because the body may run zero times. A local
element view loans both the Array's relocatable storage and its Arena edge, so
`push` is rejected until that view's last use.

The next graph edge lets an enum consume a named view-bearing value-struct
payload and inherit that payload's single Arena owner. A payloadless or
otherwise non-view-bearing alternative now records an ownerless state rather
than inheriting a fictitious region. Such an enum can nest in another value
struct; an owner-bearing value moves only into its Arena, while a proven
ownerless value can move into any Arena. Inspection uses `match (in value)`, and
its direct payload binding retains the owner proof for the arm. `if` and `match`
expression joins treat ownerless as the bottom of the provenance lattice:
ownerless plus Arena A becomes A, while Arena A plus Arena B is rejected. Both
frontends preserve that evidence without a runtime tag and continue to reject
implicit copies, consuming matches, object destructuring, direct `view T`
payloads, mutation, escape, and suspension.

The next edge makes a compiler-shaped recursive list possible without adding a
lifetime spelling. A value struct may contain `Option<view Self>`; `none` is
ownerless, while `some(view)` inherits the view's proven Arena. The containing
value can therefore enter that Arena and no other one. Construction from an
ordinary local value is rejected because it has no borrowed-storage proof.

`self-host-emit-arena-graph.zs` now stores a tail and head `LinkedNode`, borrows
the optional link through `match (in next)`, and executes under both frontends.
Stage 0 already niche-lowered `Option<view T>` to a nullable pointer. Closing
native parity exposed that native `Map.get` still materialized a copied
`Option<V>` despite its `Option<view V>` signature. Native maps and recursive
Arena links now share the pointer niche: `none` is `NULL`, `some` is the stored
address, and no tag, payload union, retain, or destructor exists.

The next pressure test stores those recursive nodes in a mutable
`Map<String, LinkedNode>`. Its first `set` establishes one Arena owner, later
insertions must agree with that owner, `get` returns an `Option<view
LinkedNode>` loan tied to the Map storage, and the complete Map may move only
into the same Arena. This required no new source syntax, but it exposed two
important implementation assumptions: the fixed-point native Map runtime only
represented scalar values, and calls through a `view Map` incorrectly took the
address of an already-pointer receiver. Native String-keyed maps now store
named Z value structs directly, destroy replaced values when required, and
preserve the lookup pointer niche through both frontends.

The follow-up removal slice deliberately keeps two representations distinct:
`get` returns a nullable `Option<view V>`, while `remove` returns a tagged owned
`Option<V>`. The native runtime destroys the removed key, moves the value into
`some`, repairs the dense hash table when the last entry changes position, and
transfers the Map's Arena proof to the returned Option. The fixture then moves
that Option into the same Arena, proving that removal does not erase lifetime
evidence or duplicate the recursive node.

Native `delete` and `clear` now complete the destructive Map surface. `delete`
destroys one key/value and reports whether it existed; `clear` destroys every
entry, clears the bucket table and tombstones, but intentionally keeps both the
allocation and the Map's established Arena proof. A cleanup-bearing
`NamedTokenSpan` fixture proves that both operations run value destruction and
that the cleared Map can be populated and moved into the same Arena again.

The fixed-point compiler now uses the same nominal key contract as Stage 0
rather than treating `String` as a permanent native-emitter special case. A
readonly `ModuleKey` containing two owned Strings implements `Hashable`, feeds
both components through the compiler-supplied `Hasher`, and drives the complete
native `Map<ModuleKey, i32>` replacement, lookup, deletion, and cleanup path.
The generated table invokes the user-defined `hash` and `equals` methods,
destroys duplicate or removed owned keys exactly once, and remains executable
in the Stage-0/native differential corpus. The same machinery now drives
scalar and readonly nominal `Hashable` Set elements across `add`, `has`,
ownership-transferring `remove`, destructive `delete`, and reusable `clear`.
Pointer identity is deliberately not a fallback for value elements.

The Arena-backed Set pressure fixture stores a readonly `CoordinateKey` whose
identity is computed from an embedded `view Coordinate`. Its first `add`
establishes one Arena, mixed owners and conditional/loop-only establishment are
rejected, `remove` carries the proof through `Option<CoordinateKey>`, and the
remaining Set can move only into the same Arena. This composition exposed a
second implementation seam: after `Arena.create(set)`, collection member reads
must use the pointer-backed view representation. Stage 0 and the fixed-point C
emitter now preserve that access shape instead of emitting an inline `.` read.

Multi-edge recursive enum graphs, class, and returned graph edges remain
rejected or deferred. Richer mutable container
provenance—including loop-carried identity and broader shape-stability
evidence—is still required before claiming whole-compiler allocation gains.

## Fixed and null-only native argument plans

The native `.zd` implementation now handles two SQLite-shaped ABI positions
without weakening the Z call surface. A `tail: null` parameter is accepted only
when Clang proves a pointer position and remains visible as a literal `null`
argument. A parameter block containing `fixed CONSTANT;` must name a
producer-proven constant compatible with the exact or canonical native
parameter type; that parameter is omitted from the Z signature.

The important implementation result is an ordered foreign-argument plan, not a
special case in C text generation. Semantic evidence records every original ABI
slot as either a source-argument index or a verified fixed constant. Direct
calls and status-to-`Result` adapters consume the same plan, preserving native
order while ownership modes remain indexed by the smaller safe signature. A
fixed-point fixture executes direct fixed, status-wrapped fixed, and null-only
calls, inspects the emitted C, and rejects unknown constants and null-only
scalar parameters. This closes the corresponding Z Notes/SQLite bootstrap gap
without introducing a raw pointer or a caller-overridable lifetime policy.

## Scalar pointer capabilities through the native compiler

The native `.zd` normalizer now recognizes a supported scalar behind one C
pointer indirection. It strips native qualifiers only to identify the pointee,
while retaining constness as checked evidence: `in` requires `const T *`, and
`inout` or `out` requires `T *`. The normalized Z signature contains `T`, not a
raw pointer. Existing semantic machinery therefore owns mutable-binding checks,
definite initialization after `out`, and exact capability diagnostics; existing
C lowering owns address-taking.

A platform-independent fixture exercises `f32` through direct `out`, `inout`,
and explicit `in` calls, plus a status-to-`Result` wrapper with two scalar
outputs. It runs through the fixed-point native driver and asserts the emitted
addresses. The real SDL application now passes native-frontend checking for
`SDL_GetMouseState(out mouseX, out mouseY)` through the same path. Const-output
contracts and call-site capability mismatches fail before lowering. This also
exposed and closed a Stage-0 double-address bug for explicit `in value` at a C
scalar-pointer boundary.

## Not tested yet

- child-task output and cross-thread borrows that survive suspension;
- optional parameter-provenanced containers and retained views; direct
  immutable parameter provenance now has positive, negative, native-frontend,
  hover, and one-pointer lowering evidence;
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

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
| `workspace.endpoints(): DocumentSelection`, forwarded and destructured | retained receiver/parameter-provenanced aggregate with two direct view fields | one by-value C struct containing two `const Document *`; destructuring uses one stack temporary and two pointer loads; no allocation, retain, provenance tag, or cleanup | straight-line multi-view access across method and module boundaries; the shared owner remains read-only until both destructured views' last uses |

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
storage. ARC class owners remain excluded from this returned-view tier because
aliases outside the callee could mutate the same storage. The later local-only
class-field tier tracks direct named aliases and is described below; it does not
make a class field view returnable or storable. Callers needing survival across
reallocation or a function boundary must use an owned snapshot or a future
stable reference model.

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

Resolved for both non-null and nullable `NSString` inputs. A non-null computed
Z string can populate either Objective-C shape; Z passes `data + length` into
an ARC `NSString`, so embedded NUL bytes are preserved without making `null`
part of Z's ordinary String model. In the reverse direction, an explicit
`String` destination copies a non-null `NSString` into fresh owned Z storage
using its exact UTF-8 byte length.

The copy is intentional: a Z `String` never borrows storage returned by
`UTF8String`, whose lifetime belongs to the Objective-C object. Nullable
`NSString` cannot convert or receive member calls until it is narrowed. Native
flow evidence now carries that proof through short-circuit conditions such as
`value != null && value.isEqualToString(...)`. Other encodings, zero-copy
views, mutable strings, and explicit conversion APIs remain later pressure
tests.

The fixed-point compiler now consumes imported property setter evidence as
well as getter evidence. An assignment such as `window.title = title;` emits
the verified setter selector directly, contextually converts an owned Z
`String` to `NSString` using its explicit byte length, and leaves ARC to bound
the temporary native string. Imported `readonly` properties remain rejected.
This removes a real Zapp migration blocker without adding Objective-C-specific
surface syntax.

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

`ZFDCL` version 9 completed the first fixed-point Objective-C semantic carry. The Clang producer
now frames interfaces, protocols, inherited protocol names, selectors,
instance/class method shape, exact return and parameter spellings,
method-parameter `id<Protocol>` qualifiers, executor affinity, availability,
async projection indices, and the producer's semantic type/nullability identity.
A Z-native decoder validates the real
`ZRegistrationOwner` fixture and proves that `addHandler:name:` retains its
`ZRegistrationHandler` qualifier as owned flat Z data. Native normalization now
attaches interfaces as reference-class contracts and protocols as trait
contracts, preserves selector-specific facts, and makes `objc.register`
protocol-conformance and stable-teardown rejection native-authoritative.
The next slice carried those selected method facts into lowering: fixed-point
Z now emits direct class and instance message sends, keeps returned object
references in ARC storage, projects owned `String` values for `const char *`
parameters, and makes the native driver choose `.m` plus `-fobjc-arc`
automatically. A self-contained executable probe dispatches through a real
Objective-C class and returns `42`. Objective-C properties, generated protocol
adapters, header-only native-driver discovery, and Objective-C++ remain staged.

`ZFDCL` version 10 closes the next real-application seam by carrying Objective-C
interface properties as first-class producer evidence: getter and optional
setter selectors, readonly and ownership facts, exact ABI plus semantic Z type,
protocol qualifiers, source location, executor affinity, and availability. The
native normalizer projects representable instance properties into inherited
field lookup, and lowering emits the getter message rather than assuming that
the source property name is the selector. A fixed-point executable reads a
concrete Objective-C object property, a custom-getter scalar property, and an
inherited scalar property, while a negative proves writable property assignment
fails with a deliberate setter-lowering diagnostic. Class properties, writes,
and optional property access remain explicit next layers rather than silently
falling back to an invented representation.

The following slice closes that untyped-body seam without introducing `any` or
an assertion cast. Dynamic `id` properties now remain representable in the
native contract graph. `value instanceof native.Class` requires a real imported
Objective-C class, emits `isKindOfClass:`, and narrows only the true branch. A
fresh fixed-point executable reads an `id` property, verifies it as the imported
base class, accesses the narrowed property surface, and still returns `42`.
Stage 0 additionally checks editor hover plus invalid left/right operands. This
is runtime nominal evidence with no wrapper allocation; protocol conformance
and general Z-class runtime inspection remain deliberately separate.

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

The root now also owns a deeply readonly `Router`. Setup registers
`on thread.any` handlers through a unique mutable `RouteRegistry`, then
`finish(move this)` transfers the registry's sole owned Map into the published
router. The AppKit target/action closure and native worker dispatch through the
same immutable table; a worker route deliberately throws `RouteError`, which
is materialized with `attempt` without weakening executor or ownership rules.
This is ordinary example code rather than framework-specific language surface.

This confirms that member-level affinity survives imported Objective-C
identity rather than working only for synthetic integer fields. It also found
one current lowering boundary: direct imported Objective-C expressions are not
yet executable in an async frame. Main-bound synchronous
`createApplication()` performs native setup while preserving exactly the same
executor proof, and the async task composes the resulting Z identity normally.

The route-context follow-up exposed a distinction hidden by the original
global lookup. Both the AppKit callback and native worker now call one
payload-matching `contextFor` factory that returns `RouteContext({ application,
message })`. Treating the returned value as transitively main-bound made a
worker unable to package an identity it was already allowed to retain and use
through synchronized methods. Stage 0 and the native resolver now stop
lifecycle-affinity inheritance at a stored Z ARC class reference: the field is
an atomic retained handle whose final release already routes to its executor,
not inline AppKit storage. Direct native fields and isolated value aggregates
remain transitive. Access through `context.application` still checks the
referenced member and rejects main-only UI work with `Z0711`.

This gives the new audited aggregate-return summary a real composition probe.
The imported exhaustive statement `match` maps every `RouteRequest` arm back
to the same `Application` parameter, preserves that precise identity through
the returned field, and adds neither a runtime provenance tag nor an interop
wrapper. Whole-aggregate capture across a new OS-thread boundary remains a
separate graph-transfer tier.

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
parity, and a current status boundary. The existing differential
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
`Z0700`; generic aggregates, traits, cleanup-bearing fixed arrays, generators,
unsupported collection iteration, value-producing loops, broader unsafe
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
be destroyed exactly once. Native lowering now constructs the destination
first, destroys those overridden source fields in reverse order, and only then
marks the complete source consumed. The same representation supports an
all-fields-overridden move rather than depending on one retained field to carry
the ownership transition. An exact Stage 0/native destructor-trace differential
covers both shapes. Stage 0 also live-guards cleanup-bearing override
temporaries so future nested fallible aggregate expressions inherit correct
partial-construction unwinding rather than requiring another ownership model.
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

Multi-edge recursive enum graphs, class-backed regions, and general returned
borrow edges remain rejected or deferred. Richer mutable container
provenance—including loop-carried identity and broader shape-stability
evidence—is still required before claiming whole-compiler allocation gains.

## Closing one Arena graph into a returned owner

The first returned graph edge deliberately adds no lifetime syntax. A
`readonly struct ParsedFile` owns exactly one direct `Arena` plus an
`Array<NodeRef>` whose embedded node views already prove that same Arena. Its
constructor must spell both transfers: `arena: move arena` closes the region,
and `roots: move roots` transfers the dependent container. The completed value
returns from a synchronous parser, crosses the module/function boundary as one
move-only owner, and remains inspectable through `in ParsedFile`.

This pressure test exposed three rules that a return-type exemption alone would
have missed. Moving the Arena must be atomic with closing the graph rather than
rejected merely because its intended dependent views are live. Any other local
view into that Arena must become unavailable after closure, or it could be used
through a moved owner. Finally, Array indexing and nested field projection must
rebase their provenance onto the completed bundle rather than continue naming
the vanished local Arena binding. Both semantic frontends now enforce those
rules and the differential fixture executes unchanged through Stage 0 and the
fixed-point compiler.

Destruction supplies the runtime half of the proof: cleanup-bearing dependent
fields are destroyed before the Arena regardless of source declaration order.
Mutable fields, multiple Arenas, mixed provenance, spread construction,
containers of bundles, closure capture, generators, and async suspension stay
rejected. This is evidence for a useful compiler-AST storage shape without
pretending Z has general returned borrows.

## The production parser now closes one module batch

The returned-owner shape now participates in the real native compiler rather
than only a synthetic fixture. `parseModuleSources` builds its validated
`Array<ParsedModule>`, moves that completed root into one `Arena`, and returns a
readonly `ParsedModuleBatch` containing the Arena and a `view
Array<ParsedModule>`. Resolution and C emission accept an immutable borrow of
the batch, project its module view locally, and cannot outlive the batch's one
cleanup boundary. The single-module `parseModule` API deliberately remains an
ordinary owning result because the standalone driver uses it during recursive
import discovery before the final module set exists.

This is a lifetime migration, not yet an allocation-speed claim. The Arena owns
the complete module Array and therefore transitively owns every parsed Program,
but individual lexer and AST allocations still use their normal owned
containers. Moving those inner structures directly into region storage remains
a later, measured optimization. Keeping this first production step at the root
avoids inventing general nested returned-borrow or container-of-owner-bundle
semantics merely to migrate the compiler.

The composition exposed two useful first-tier boundaries. An Arena owner bundle
still cannot become the success payload of `Result`, so the parser library
propagates the bundle directly and materializes only its final emitted `String`
through `attempt`. Native lowering also treated inferred binding evidence as if
names were module-global: an earlier local `view Array<ParsedModule>` named
`parsed` contaminated later function parameters with the same spelling.
Parameter lookup is now scoped to the enclosing declaration before inferred
local evidence is consulted, with a dedicated executable regression. The full
frontend graph emits and compiles with the Arena batch through both frontends.

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

## Zapp message routing across a migration boundary

An opt-in Zapp pressure test now preserves its production-shaped Nim adapter,
enters a Z static library through an exported owned `String` parameter, and
calls back into the current Nim router through a checked `const char *`
declaration. A UTF-8 JSON envelope survives Nim → Z → Nim unchanged. Generated
C shows one validated allocation at the C-to-Z export, a zero-allocation
`String`-to-`cstring` projection for the outbound call, and exact Z cleanup
after the router returns.

This found two fixed-point parity gaps immediately: canonical `const char *`
was not normalized to `cstring`, and native call evidence confused Z's
call-scoped borrow with C's by-value pointer ABI. The compiler now keeps those
facts separate. The router-side Nim copy remains deliberate migration
scaffolding; it disappears as envelope parsing, dispatch, application state,
and platform services move into Z. The ignored legacy `void *app` stays in the
Nim compatibility adapter instead of forcing an unproven raw-pointer feature
into Z.

The result is evidence for gradual replacement rather than a permanent mixed
architecture: Zapp can move one ABI seam at a time from Nim and handwritten
Objective-C into Z while direct Objective-C/C/C++ interop preserves the native
platform surface.

## ARC-managed handlers in Map

The next Zapp-shaped slice moved message dispatch from a direct callback seam
toward a Z-native router. `Map<String, Handler>` now treats a function value as
shared ARC identity rather than as a view into bucket storage. `set` retains a
named handler so its caller remains usable; `get` returns an independently
retained `Option<Handler>` that remains callable after the Map is cleared; and
`remove` transfers the stored handle. Replacement, `delete`, `clear`, and final
Map destruction use the ordinary function-value release hook.

An executable application fixture combines a direct function, an owned
capturing closure, typed routing failure, lookup, invocation, and deterministic
ARC cleanup. The captured class state deinitializes once after the router and
all retrieved Options leave scope. This confirms that no collection-specific
closure representation was needed: the existing retain/release function handle
was the correct storage abstraction.

Moving the same Map from a local into a long-lived `Router` class exposed two
native composition gaps. Aggregate destructors could mention collection cleanup
before the emitter declared it, making valid ownership depend on C declaration
order. The emitter now forwards Array, Map, and Set cleanup before aggregate
definitions. Synchronous throwing methods were also rejected even though their
bodies use the same settled `Result<T, E>`, `try`, `attempt`, and cleanup paths
as ordinary functions. Method lowering now carries a qualified semantic owner,
collects its intrinsic types even when the method is unused, and emits that same
typed Result ABI. Async throwing methods remain a separate suspension-frame
tier and fail with a source-mapped boundary.

The pressure test then closed the fixed-point boundary it exposed. Native C
emission represents each callable ABI with a typed call pointer, context, and
retain/release hooks. Direct named functions use static context-free handles;
capturing expression closures allocate one environment whose final release
destroys owned captures. Throwing callables return the same `Result<T, E>` shape
as direct throwing calls. Map insertion and lookup retain independently, while
replacement, removal, clearing, and destruction transfer or release exactly
once.

The message router now compiles and runs through Stage 0 and native semantic
authority under strict C warnings. Registration occurs on a mutable
`RouteRegistry`, while `finish(move this)` consumes that wrapper and publishes
a deeply readonly ARC `Router`. Closing that seam required one deliberately
narrow ownership rule: a consuming value-struct method may transfer its sole
ownership-bearing field, invalidating the whole receiver and disabling its
cleanup guard. Custom `deinit` or a second cleanup-bearing field still rejects
the extraction, so this does not introduce general partial-move state. A second
differential fixture covers transparent aliases, raw function-type parameters,
direct named-function conversion, and an inferred scalar-capturing closure.

The fixed-point audit subsequently carried that same seam through native C
emission rather than stopping at semantic authority. Consuming value-struct
methods now receive `self` by value, own its deterministic cleanup, and guard
that cleanup whenever a return path transfers the receiver or its permitted
sole owned field. `freeze()` is represented as the same zero-copy move while
type-position `readonly` erases only at the C representation boundary. The
unchanged message-router application now emits, compiles under strict Clang
warnings, and produces equivalent observable behavior in the Stage-0/native
differential corpus. A focused fixture separately proves both the ordinary
consuming path, which destroys `self`, and sole-field publication, which clears
the guard before returning the field.

This also exposed two older name/alias shortcuts that application composition
made unsafe. Native lowering had treated every method named `finish` as
`TextBuffer.finish`; it now requires the resolved `TextBuffer` receiver or a
resolved `move this` contract. A `readonly Map<K, Handler>` lookup also has to
see through the transparent callable alias before choosing retained
`Option<Handler>` rather than a bucket view. Both decisions are now driven by
semantic type evidence rather than spelling.

The first fixed-point run also exposed a bootstrap-performance constraint that
ordinary application fixtures could not: adding the readonly callable-alias
logic inline to the recursive expression resolver increased its unoptimized C
stack frame enough to overflow on a deeply nested compiler expression. The
logic now lives in a non-recursive helper, reducing every recursive frame while
preserving the same semantic evidence. Fixed-point tests therefore remain both
correctness and compiler-shape pressure tests; an implementation that is sound
but cannot compile the compiler under the development profile is not complete.

Extracting that router into a reusable module exposed a native-frontend gap
that the single-file fixture could not reveal: an imported transparent callable
alias retained its canonical emitted identity but lost the source signature
needed to contextually lower a closure. Imported callable metadata now carries
both. The consumer can therefore construct an expression closure against an
imported `Handler`, while the fixed-point emitter still shares the exact
canonical ABI declared by the owning module.

The fixed-point native driver now compiles and runs the companion
native-callback entry, which shares the published router with an escaping
callback declared by `callbacks.h.zd`. The C registration owns the generated closure
box; the closure owns the router; the router owns its Map and handler; and the
handler owns captured ARC state. Calling the contracted native clear operation
releases that foreign root before control returns to `main`. The callback is explicitly `thread caller`, so this proves
foreign entry and lifetime composition without claiming arbitrary-thread Map
access; a `thread any` producer would still require synchronization or executor
isolation.

That fixed-point run exposed two adjacent composition gaps. Native contract
attachment had treated `.zd` as a replacement surface, hiding ordinary
header-inferred functions such as the callback invoker and clearer; normalization
now merges every still-representable uncontracted function back into the checked
module. Contextual function types from foreign call signatures also now enter the
native function-type registry, allowing an inline expression closure to share
the exact callable ABI used by its generated trampoline. Finally, immutable ARC
class parameters emit `T * const *` rather than `const T **`, preserving the
pointer identity's constness without changing the pointee type.

Ordinary closure environments remain executor-local. Explicit `on thread.any`
callables now provide atomic environments for proven shareable capture graphs,
and `on thread.main` callables preserve main-only construction, invocation, and
storage without changing the native callable ABI. Block-bodied first-class
closures and suspending callable bodies remain explicit follow-ups.

## Frozen collection publication

The message-router work exposed a distinction that declaration-position
`readonly` could not express. `readonly handlers: Map<String, Handler>` keeps a
class field from being replaced, but the stored Map still exposes structural
mutation and therefore prevents deep cross-thread shareability. Introducing a
second nominal `ReadonlyMap` family would duplicate every collection API and
weaken the established TypeScript-inspired modifier vocabulary.

Z now accepts type-position `readonly Array<T>`, `readonly Map<K, V>`, and
`readonly Set<T>`. A consuming `freeze()` transfers the existing buffer or hash
buckets into that capability without allocation, element copying, or a retain
walk. The source binding becomes moved. The frozen owner still performs exactly
the ordinary reverse/deterministic cleanup; an early implementation bug that
treated the wrapper as a distinct cleanup-free type was caught by inspecting
the emitted live flags and destructors before this slice landed.

The cross-thread probe stores `readonly Map<String, i32>` behind a readonly
field in an ARC `Router`. The compiler proves the reachable graph immutable,
uses atomic ARC for Router identity, transfers that identity into
`thread.spawn`, and executes a Map membership read on the worker. Replacing the
field type with mutable `Map<String, i32>` restores the `Z0704` rejection. This
is zero-runtime-check shared reading: the safety cost is paid once at the
consuming publication boundary.

The function-valued frozen-router seam is now closed explicitly rather than by
silently blessing closures stored in immutable containers. `Handler` declares
`on thread.any`; named functions carry the same declaration contract; and a
contextually typed closure receives a concurrent capture proof. The compiler
rejects an ordinary local function assigned to that stronger type, borrowed or
mutable captures, and a frozen graph whose handler remains executor-local.

The resulting `Router` stores `readonly Map<String, Handler>`, crosses
`thread.spawn` by atomic ARC identity, and invokes both a direct function and a
capturing handler on the worker. The capturing environment also uses atomic
retain/release. The fixed-point compiler preserves the contract in its module
protocol and type comparisons while deliberately omitting it from the C ABI
identity, then emits and executes the same atomic closure representation.

The Zapp AppKit probe then attached the same ownership shape to an Objective-C
event source. Its `Application` class stores the `objc.Connection` alongside
the native button, so the application root—not a blocking function's local
frame—owns the target/action lifetime. The connection's closure owns a router,
the router owns its handler Map, and a deterministic `performClick` crosses
AppKit → Z dispatch → synchronized application state → main-isolated UI. This
also exposed and closed a module-linking defect: qualified standard-library
types such as `objc.Connection` were incorrectly mangled inside a dependency's
exported aggregate fields. Standard module namespaces now keep a canonical
type spelling while their expression bindings remain collision-safe.

The optional parameter-view slice then exercised the same rule across a module
boundary. `findWorkspaceDocument(id, in workspace)` forwards a receiver lookup
as `Option<view DocumentSession>`; a separate two-workspace fixture may return a
document from either immutable input. Both frontends conservatively loan every
possible owner, preserve that provenance through `match (in found)`, and end the
loan after the payload's actual final use even inside a value-producing arm.
Stage 0 and the fixed-point emitter both lower the option to one nullable
`const Document *`: `some` returns a projected address and `none` is `NULL`.
Mutating either workspace before the last use is rejected, while growing both
workspaces immediately afterward is accepted.

The retained parameter-view aggregate slice then extended the same proof to a
named value result without adding lifetime syntax. `DocumentSelection` returns
the first and last document projections from one immutable workspace. Both
frontends require direct construction at the ultimate producer, explicit
`view` on every borrowed field, and exactly one source owner per returned
instance. The composition follow-up proved a borrowed value-struct method,
module forwarding, synchronous `in DocumentSelection` consumption, and object
destructuring. Every wrapper exports the original receiver/parameter evidence;
each destructured view receives the same owner loan, which closes only after
all such bindings reach their final use. Mutation between the first and last
use is rejected with the still-live binding named in the diagnostic.

Stage 0 and the fixed-point emitter both lower the result to a by-value C struct
of two borrowed pointers with no heap allocation or retain. Native
destructuring evaluates the producer once into a stack temporary and loads its
two pointer fields. Local-storage escape, mixed owners, nested retained storage,
ARC-class or mutable/consuming receiver methods, and suspending or throwing
producers remain deliberately closed.

## Cleanup-aware object destructuring in the fixed-point compiler

The earlier native tier only projected cleanup-free fields. That left an
awkward split in compiler code: Stage 0 accepted `copy` and `move` object
patterns over ordinary owned structs, while the fixed-point compiler rejected
the same source before lowering. `semantic-type-validation.zs` now exercises
the closed path directly by copying and destructuring a fixed-array shape.

Native lowering evaluates the source exactly once into an owned temporary.
`copy source` recursively copies its supported Z-owned graph—`String`,
`Array<T>`, structs, and enums—while `move source` transfers the whole owner and
marks the original binding dead. Each selected cleanup-bearing field then moves
into its own binding and its source slot is replaced with an empty value. The
temporary's ordinary destructor cleans up only the unselected fields. The new
bindings receive normal scope cleanup and live flags, so early return and later
movement preserve exact-once destruction without a runtime ownership table.

The generated-C fixture includes nested structs, an Array of owned Strings, and
an enum with an owned String payload. It compiles under strict Clang warnings,
runs successfully, and is part of the differential fixed-point corpus. A paired
negative fixture proves that `move source` makes every later use of the original
struct a native semantic error. The remaining boundary is deliberate: classes,
custom-`deinit` structs, foreign RAII values, nested/rest patterns, mutable
patterns, and object-rest patterns need separate ownership rules rather than
inheriting this transfer mechanically.

## Array, fixed-array, and Slice positional destructuring in the fixed-point compiler

The native frontend now closes the `Array<T>` source part of the local
positional-pattern design, including zero-copy rest. Lowering borrows the source
into one generated local, proves the full requested prefix with one runtime
length check, and then emits unchecked element projections under that
compiler-owned proof. Discards still contribute to the required prefix but
generate no binding. This avoids repeated source evaluation and repeated bounds
checks without weakening safe indexing elsewhere.

Cleanup-free elements load by value. An Array whose element graph needs cleanup
must be destructured from an explicit named `view`; each selected element is an
owner-tied borrowed binding, and the ordinary last-use loan checker prevents a
reallocating `push`, move, or destruction of the Array while any binding is
live. Paired negative fixtures prove both the missing-`view` diagnostic and the
live-view mutation rejection. The executable fixture compiles under strict
Clang warnings, runs in the differential corpus, and the compiler itself now
uses view Array destructuring while resolving `Once<T>` intrinsics.

Rest uses a distinct non-owning native `Slice<T>` descriptor containing only a
data pointer and length. It borrows the Array at the current positional offset;
it never reuses owning Array layout, allocates storage, or gains cleanup. The
runtime proof covers the offset before projection, while a rest-only empty
pattern avoids null-pointer arithmetic. The descriptor is also emitted
independently for synchronous `Slice<T>` parameters. A direct Array argument is
projected to its full pointer/length range at the call boundary, while an
existing Slice may itself be positionally destructured into a shorter Slice.
The fixture exercises scalar and cleanup-bearing parameters, nested rest,
checked indexing, and `Slice<Document>` field access before releasing the owner
loan and mutating the Array. A standalone fixture proves that a Slice signature
does not depend on an owning Array declaration.

Fixed arrays use their established inline C value wrapper in the native IR.
Literals initialize that storage directly; checked indexing, mutable indexing,
`in` parameters, whole-owner move/return, explicit recursive copying,
positional destructuring, and fixed-array-to-Slice projection all compose
without wrapper allocation. Cleanup-bearing element graphs now receive exact
reverse-order destruction, while each statement-lowered literal temporary has
a live flag: if a later nested `try` fails, the completed prefix is destroyed
before error propagation. The same common Stage 0 aggregate fix closes that
partial-construction leak for struct, enum-payload, constructor, and fixed-array
materialization. Their known length removes the dynamic destructuring guard
while leaving ordinary indexing checked. Individual cleanup-bearing elements
remain borrowed; the checker rejects moving one out of the still-owning array.

The representation composes recursively for nested fixed arrays. Inner
declarations are collected before outer wrappers, so C layout is valid without
opaque storage or heap indirection. Imported functions can return these values
by value, callers can explicitly `copy` copyable graphs, and `for...of` uses the
fixed length directly while borrowing each element through the generated array
helper. The differential corpus runs cleanup-free local and multi-module cases
plus cleanup-bearing construction, failure cleanup, explicit String copying,
and custom destruction through Stage 0 and the fixed-point compiler.

## Concrete generic value structs in the fixed-point compiler

Writing the compiler itself exposed that native generic evidence was useful but
not sufficient: Stage 1 could prove `Pair<String>` or
`Pair<Box<i32>>`, yet it still had no concrete value layout to own. The first
generic aggregate execution tier now consumes those settled semantic identities
as a demand list. For every generic value struct used by a module,
lowering substitutes the ordered arguments into its fields, recursively demands
nested specializations, emits them before their owners, and records a
collision-safe C identity keyed by the declaring module and symbol rather than
by display text alone.

Concrete specializations then enter the existing value-struct ownership path.
`Pair<i32>` is cleanup-free, while `Pair<String>` automatically destroys its
fields in reverse order. Construction supports inferred and explicit nested
specializations; cross-module aliases retain the declaration's nominal
identity. Field access, ordinary and explicit-copy spread, whole-owner
move spread with cleanup of overridden fields, and consuming object
destructuring all operate on the concrete layout. The executable fixture is
compiled with strict Clang warnings and is also part of the Stage-0/native
differential corpus together with a multi-module fixture.

Declared instance and static methods now specialize alongside that layout. Lowering adds
temporary local aliases from each aggregate type parameter to its demanded
concrete argument, then sends the method through the ordinary value-struct
method path. This keeps immutable, `inout`, and `move this` semantics identical to
non-generic structs: ownership-bearing field replacement evaluates the incoming
owner once and destroys the previous field before installation, while a
consuming method may transfer its sole owned field and suppress receiver
cleanup. A specialization demanded only through an importing module still
emits its method in the declaring module under the same canonical nominal C
identity, so selective-import aliases cannot create a second ABI.

Static methods carry no receiver in source or generated C. Their semantic call
evidence is explicitly tagged as static, and lowering turns the call into the
same direct owner-qualified symbol from local, selective-import, and
cross-module alias spellings. A factory such as `Cell.create(20)` uses its
settled owner substitutions to demand and return `Cell<i32>`; cleanup-bearing
arguments likewise select a separate owned specialization. Template-internal
references such as `Cell<T>` are kept out of the runnable demand list until `T`
is concrete.

The contextual constructor path matters for correctness. A nested
`Box({ value: 20 })` inside a field expected to be `Box<i32>` must receive that
concrete expected type; otherwise an unspecialized template name can leak into
generated C even though semantic demand already found the right layout. Native
lowering now carries that context into construction and explicitly excludes
generic templates from ordinary local aggregate emission.

The next demand tier activates independently generic methods without changing
their settled source syntax. Call evidence now records the callable's own
generic arity separately from the complete substitution list, so lowering can
split `Holder<T>` owner arguments from `choose<U>` method arguments without a
name-based guess. Concrete owner and method substitutions select one canonical
direct C symbol; inferred and explicit calls deduplicate to that same body.
Local and selectively imported generic owners execute the implementation in
the declaring module, and cleanup-bearing `String` arguments/results plus typed
throwing methods reuse the ordinary ownership and `Result` paths. Static and
instance generic methods on non-generic owners use the same mechanism.

The next direct-call tier now demand-specializes generic free functions. Inferred
and explicit calls deduplicate by the same lowered type identity used for
generic methods, including cleanup-bearing `String` values, typed `throws`, and
generic value-struct parameters. Selective-import aliases call one implementation
in the declaring module, while colliding private helper names receive stable
module-qualified bases before their specialization suffix. Calls whose type
arguments depend on an enclosing specialization recursively add their concrete
callee demands; recursion terminates through canonical specialization
deduplication.

The deliberately undesigned two-level static specialization of
a generic owner and custom constructors remain source-mapped boundaries. Concrete generic
value-field defaults now specialize into
defining-module helpers. Each omitted field invokes its helper independently,
including cleanup-bearing `Array<T>` defaults; an explicit initializer or
same-type spread suppresses it. Local and selective-import construction use the
same canonical helper symbols, so defaults create fresh ownership without
duplicating template ASTs across consumers. The remaining behavior requires
additional call-demand or ownership rules and should be closed as separate
composition slices.

Generic value-struct `deinit` uses the same specialization identity and owner
module as its methods and defaults. The custom body runs once before automatic
reverse field cleanup, and cross-module aliases reuse that implementation. The
executable pressure fixture covers both cleanup-free and owned `String`
specializations so custom behavior cannot accidentally replace automatic field
destruction. Capability derivation remains conservative: a custom generic
`deinit` is neither thread-shareable nor worker-destructible, matching ordinary
value structs with user cleanup.

The next concrete demand tier materializes generic ARC classes. A demanded
`Cell<i32>` or `Cell<String>` receives the same canonical, module-qualified
identity as a generic value struct, but its concrete layout is heap allocated
and begins with the ordinary ARC reference count. Synthesized object
initialization, ordinary specialized instance methods, atomic retain/release,
custom `deinit`, and reverse owned-field cleanup all reuse the non-generic class
runtime rather than introducing a parallel ownership model.

The first generated-code probe exposed a broader native bug before this tier
could be called safe: `const shared = owner` copied a class pointer without a
retain even though both local cleanups released it. Local initialization now
recognizes borrowed class identity, retains it once, and releases both owners;
newly allocated or returned class identities still transfer directly. The
regression covers ordinary and generic class identities through that shared
path. Direct specializations exercise cleanup-free and `String` fields, mutable
field replacement, alias use from both owners, and exact-once reverse cleanup.
A multi-module fixture proves selective-import aliases share one specialization
while an unrelated private generic class with the same source name receives a
distinct nominal C identity.

Fixed-point `Weak<T>` now composes with that ARC foundation rather than adding a
parallel generic runtime. Every ordinary or demand-specialized class carries a
lazy zeroing-control pointer. `weak owner` increments only the weak control,
copying a weak handle retains that control, final strong release clears its
value before custom `deinit`, and `upgrade()` returns the existing native
`Result<T, WeakExpired>` while retaining the recovered class on success.
Focused executables cover ordinary classes, `try`/`attempt`, strong-owner
replacement, a class-owned closure with a weak back-edge, direct generic
classes, and selective cross-module generic aliases. The cycle fixture keeps an
independently retained handler alive after its controller is destroyed, proves
the class field releases its copy exactly once, and observes `WeakExpired`
through the captured weak handle. A copied weak value also crosses an owned
function parameter and enters a class field without consuming the caller's
handle. Closing that fixture additionally required function-handle definitions
to split layout from behavior: the handle layout precedes aggregates that store
it, while `_call` helpers follow complete `Result` and payload definitions.
Function-valued field projections retain their closure environment. Moving that
emission logic across an ordinary compiler helper also exposed canonical
`Mutex_`, `Task_`, `Once_`, and `OnceLifetime_` identities that could previously
be resolved only through their source generic spelling; local and cross-module
lowering now preserve both forms. Null-only native arguments bypass owned-value
projection rather than pretending `null` is a storable Z type.
Registering concrete generic identities before intrinsic wrappers also closes
the broader `Wrapper<Generic<T>>` lowering seam that this pressure test exposed.

This is deliberately not a claim that every generic class composition is done.
Custom generic constructors, class-field defaults, concurrent weak upgrade,
and broader executor/sendability derivation remain separate slices. The ARC
foundation is executable; those features must compose against it rather than
being inferred from the existence of `_retain` and `_release` symbols.

## Direct ARC aliases and bounded local uniqueness

The first Ante-inspired experiment found a concrete hole in Z's existing
exclusivity rule. The call checker keyed access by local name, so this compiled:

```z
let primary = new Counter({ value: 41 });
const alias = primary;
combine(inout primary, alias);
```

Both arguments carry one class identity, but the checker saw two roots. Stage 0
and the fixed-point native resolver now retain direct local alias evidence and
compare identity as well as spelling. The call receives `Z0306`; a mutable
receiver plus an aliased argument is rejected by the same rule. No runtime
check, lifetime annotation, or new source syntax was introduced.

The useful case remains accepted: an alias may coexist with the owner, an
`inout` operation temporarily receives exclusive access, and the alias becomes
usable immediately after the synchronous call. This is the smallest practical
form of local uniqueness rather than a general stable-reference claim.

The Zapp-state pressure pass found that ordinary inline closures must be part of
the same proof. A callback passed beside `inout application` could capture a
second application alias and run before the enclosing call returned. Both
frontends now summarize direct inline closure captures as `in` or `inout` call
uses and reject the overlap with `Z0306`; branch-local mutation joins
conservatively. An alias that is not used by the callback remains available
immediately after the exclusive call, which the Zapp skeleton exercises on its
main-isolated `Application` identity.

The first audited call boundary now carries the same evidence without new
syntax. A synchronous, nonthrowing, zero-argument function whose complete body
is `return cell.get();` transparently exports the canonical identity of that
module-private `Once<T>` cell. Repeated `currentApplication()` calls therefore
conflict when passed as overlapping `inout`/`in` aliases, including when the
accessor and cell live in another source module. Stage 0 uses the linker's
canonical private-cell name; the native resolver uses the defining module and
constant symbol. Distinct cells remain distinct.

This is intentionally an audited structural summary, not a name-based guess or
a general effect system. Adding a statement, branch, parameter, throw, or other
return source makes the function opaque again. Arbitrary function results,
previously stored function values, flow-sensitive identity sets, suspension,
and broader factory summaries need separate probes. Cross-thread mutation still
requires a mutex or executor isolation.

The next Zapp-shaped probe closes one common aggregate seam without broadening
the source language:

```z
let application = currentApplication();
const context = Context({ application });
updateAndInspect(inout application, context.application); // Z0306
```

A directly constructed local value struct now records the ARC identity placed
in each explicit direct class field. A direct field projection recovers that
identity, and binding the projection to another local preserves it. Direct
field replacement updates the evidence. Stage 0 and the fixed-point resolver
therefore reject the same overlap while accepting a context holding a distinct
application identity. The generated representation remains an ordinary value
struct containing one retained class pointer; there is no provenance tag,
runtime uniqueness check, or new syntax.

This evidence is deliberately not local-containment proof. Storing a class in
the struct invalidates the stronger proof required by `view class.field`, so a
context field cannot manufacture a class-field view. Struct spread, nested
aggregate paths, collections, returned contexts, branch joins, and suspension
remain outside this direct local tier. A direct class field on an opaque local
context is treated as an unknown alias and therefore conflicts with another
exclusive class use; missing provenance never means proven independence.

The next refinement exports that evidence through one deliberately small
function boundary:

```z
function wrap(in application: Application): Context {
  return Context({ application });
}

let application = new Application({ value: 41 });
const preview = new Application({ value: 1 });
const context = wrap(preview);
updateAndInspect(inout application, context.application); // accepted
```

Both frontends audit the complete declaration rather than infer from the
function name or return type. The function must be synchronous, nonthrowing,
nongeneric, and receiver-free. The initial form required exactly one
`return Struct({ ... });` statement without spread. Each direct class field
initialized from a same-typed
class parameter carries that argument's identity into the caller, including
across a source-module import. Passing `application` to `wrap` therefore still
rejects the overlapping call, while passing `preview` proves independence.

This is exported semantic evidence, not a hidden runtime wrapper. Generated C
still returns the ordinary value struct and performs the same ARC retains and
releases. A local temporary, spread, throw, async effect, generic function,
indirect initializer, or different return source earns no summary;
its direct class fields retain the wildcard unknown-alias behavior. This strict
fallback keeps partial provenance from becoming a safety claim.

The first control-flow join now admits branches without broadening that trust
boundary. The body may contain only blocks, `if`/`else if`/`else`, and direct
struct returns; it must return on every path, and every return must map each
class field to the same parameter. This accepts both an early `if` return plus
a final fallthrough return and an exhaustive conditional, including through an
imported function signature. If one branch maps `application` from `primary`
and another maps it from `alternate`, the whole result remains opaque. Locals,
assignments, loops, and indirect constructors remain deliberately
outside this first join.

The same intersection now covers exhaustive statement-form `match`. Every arm
must terminate through the permitted block/`if`/`match`/direct-return subset,
and all direct returns must agree. Ordinary payload bindings are allowed, but
an arm binding that shadows a function parameter with the same spelling makes
the whole summary opaque; otherwise a payload could be mistaken for the
caller's ARC identity. Disagreeing arms also fall back to the unknown alias.
This works across source modules and adds no runtime tag. Value-producing
`return match (...) { ... }`, locals within arms, loops, and indirect returns
remain separate provenance problems.

The focused capture follow-up resolved an adjacent frontend mismatch without
adding syntax. Both frontends now preserve the direct class rule through a
synchronous closure: an owned `const` class reference may invoke `inout this`
because its binding is not replaced. Capturing an immutable `in` class borrow
does not manufacture mutable access, while assigning a new class reference to a
captured binding still requires `let`. Stage 0 now records binding reassignment
separately from instance mutation so those cases cannot collapse into one
coarse "mutated capture" flag.

## Executor-bound ARC handles inside transportable values

The real Zapp AppKit route-context factory exposed that executor affinity must
not be inferred transitively through every class field. A Z ARC class reference
is a transportable identity handle; the class's individual members continue to
enforce their own executor contracts. Both frontends now allow an ordinary
value struct such as `RouteContext` to store `Application` and move through
off-main routing code, while an off-main call to an `on thread.main` member on
that stored handle still receives `Z0711`. Directly embedding an executor-bound
value struct or native value remains transitively isolated because its storage
and destruction occur inline.

The Zapp probe now constructs route contexts for action, background, and
rejection requests in an imported module, dispatches through the stored
`Application`, and performs AppKit publication only through its isolated
member. Hover describes the distinction as a transportable ARC handle whose
isolated members still require `thread.main`. `Once<Application>` remains
rejected when the class itself owns main-affine destruction, but merely storing
another executor-bound ARC handle no longer invents that lifecycle.

Actually building the application, rather than stopping at semantic checks,
found two independent lowering seams. Callable adapters used a hidden C
parameter named `context`, which collided with a perfectly valid Z callback
parameter of the same name. Both emitters now choose a fresh compiler-owned
name, and the executable callable corpus fixes `context` as a regression case.
An explicit nested borrow such as `inspect(in context.request)` also arrived in
Stage 0 as an `argumentReference`; recognizing that node as stable storage
prevents an invalid address-of temporary in generated C. Neither fix changes Z
syntax or adds runtime work.

## Shape-stable value and direct ARC field projections

The next Ante-inspired probe reused Z's existing capability vocabulary rather
than adding `uniq`, annotations, reference symbols, or a new borrow type:

```z
let point = Point({ x: 20, y: 22 });
adjust(inout point.x, inout point.y);
```

Both semantic frontends now identify the complete fixed-layout field path for
one synchronous call. Sibling paths are disjoint; an exact duplicate or a
parent/child pair overlaps. `out` deliberately remains a whole-binding
initialization capability. Aggregate-hidden ARC traversal, dynamic indexing,
Slice projection, and suspension fail conservatively. Generated C passes
`&(point.x)` and `&(point.y)` directly, confirming zero allocation, retain, or
runtime alias check.

Both frontends additionally carry a direct field path on a local view. This
accepts mutation of `document.revision` while `view document.title` is live,
but still rejects replacement of `title` or `document`. The owner may now be a
named local ARC class. Its known local aliases share one identity proof, so
`view document.title` also blocks `alias.title = replacement` and
`alias.refresh()` when `refresh` takes `inout this`. A sibling such as
`alias.revision` or a nested value-struct field remains available, including as
an `inout` call argument. After the view's last use, the alias can replace
`title` or invoke the whole-instance mutating method.

This class tier remains local and synchronous. Crucially, a local binding alone
is not proof that all aliases are local: `const app = currentApplication()` may
refer to a global `Once<Application>` identity. Both frontends therefore carry
separate containment evidence. Synthesized `new Class({ ... })` construction
starts contained and direct named aliases preserve it. Arbitrary function
results and user-defined constructors do not. Passing the identity to an owned
parameter, storing it in aggregate or collection storage, or placing it in an
owned closure environment invalidates containment for every known alias. An
escape attempted while a field view remains live is rejected before a hidden
alias can be created.

An immutable `in` class parameter cannot manufacture mutable field access;
class identity stored inside another aggregate, traversal through a nested
class field, foreign reference identity, dynamic indexing, escape, and
suspension remain rejected. Array indexing remains whole-owner conservative
because growth may invalidate element addresses. The transparent `Once<T>`
accessor summary above supplies alias identity only; it does not manufacture
local containment. A value returned by `currentApplication()` therefore still
cannot back a class-field `view`, since the module cell is itself a hidden
alias. Broader accessor provenance remains deferred rather than inferred from a
return type or function name.

The Zapp application-menu pressure test exposed one safe stored-owner case that
did not require local containment. A direct readonly field of an ARC class can
be borrowed through any retained alias: the field cannot be replaced, and the
borrowed root keeps the class alive. Both semantic frontends now admit that
immutable synchronous projection while continuing to reject mutable fields,
`inout`, nested class identity, and suspension. This removed an internal owner
table workaround from Zapp without adding syntax, copying its recursive menu
tree, or relaxing mutation safety.

The native parity work exposed an important internal modeling error in real
compiler code: the resolver had used a view binding's ownership state to mark
whether its owner loan remained live. A loop could therefore report that the
view itself may have moved, even though views never own their targets. Native
flow state now carries loan liveness separately from value ownership, recomputes
it from future uses, and joins it conservatively across branches and loops.
The self-hosted C emitter's nested indexed views and later loop uses provide the
real-program pressure evidence for that separation.

The readable source-inspector probe now models the same shape with a recursive
`SyntaxNode`. While `view node.metadata.name` remains live, analysis counters
and a sibling nested source-span field mutate independently. Generated C passes
their exact addresses and formats the borrowed String without copying. After
the name's last use, the node replaces that field and moves the complete
recursive value into `Array<SyntaxNode>`. This also closed a Stage-0 console
lowering gap: semantic analysis had accepted `view String` interpolation while
the emitter recognized only owned `String`.

This experiment simplified user code by making the checker more precise. It
did not change what `in` or `inout` means, add a runtime mechanism, or permit
shared mutation across threads.

## Zapp typed JSON bridge through the fixed-point compiler

Zapp's first Z-owned message router now parses its real `{ t, id, m, a }`
envelope with source-backed `std/json`, preserves `u64.max` request identity,
routes a typed method, and returns UTF-8 JSON through a strict C host callback.
The bridge is compiled by the bootstrapped native `z`, archived as a static
library, linked into an ordinary C host, and exercised end to end.

That small application exposed four fixed-point composition gaps that isolated
language fixtures had not combined: the published native compiler did not carry
source-backed standard modules beside the executable; nested value-producing
matches were not lowered in every destination; imported enum identity was lost
through a `view`; and contextual `u64` literals reached strict C as unsuffixed
integers. The bootstrap now packages the standard library, the native driver
loads those modules recursively, enum views retain their nominal imported
identity through matching, and C emission uses the exact contextual unsigned
width. None of these fixes is Zapp-specific.

The resulting boundary remains intentionally narrow: Z owns parsing, typed
dispatch, exact request IDs, errors, and response construction, while the C
host owns only ABI delivery. This is stronger evidence for self-hosting than a
standalone JSON sample because the same source-backed module now composes with
exports, archive generation, foreign callbacks, and a real consumer repository.

## Zapp's first visible WebKit round trip

Zapp now builds the fixed-point archive into a visible AppKit/WebKit process.
The generated embedding runtime initializes a main-bound
`OnceLifetime<Application>` before admitting exports and destroys it during
shutdown. The host bundles Zapp's canonical `bootstrap/webview.ts`, installs it
as a `WKUserScript` at document start, and exercises its public
`bridge.invoke()`/`_onInvokeResult()` promise path rather than a demo-only
transport. A WebKit message crosses into the exported owned-String boundary,
uses the Z JSON router, returns typed response fields, updates the page, stops
the AppKit run loop, and releases the runtime root. The strict C regression and
the visible Objective-C host consume the same archive and generated header.

The production bootstrap immediately exposed a useful protocol distinction:
its `ready` action is fire-and-forget, while an invocation expects exactly one
response. The Z router now expresses that distinction as
`Option<BridgeResponse>`—`some(response)` for request/response traffic and
`none` for actions—rather than fabricating a response for every message kind.
This keeps protocol cardinality in the type model without adding a special
bridge primitive.

That change also found a generic fixed-point compiler defect. Returning an
intrinsic `Option<T>` from a value-producing `match` could transfer a borrowed
contextual type-name String out of a consumed temporary and then destroy it,
causing an invalid free during native lowering. Native lowering now copies the
contextual type name it owns and propagates the enclosing destination type into
each match arm. Contextual payload-free constructors such as `Option.none`
therefore lower correctly, and a fixed-point regression compiles the same shape
through the compiler rebuilt by itself. This was a compiler ownership bug, not
a Zapp-specific workaround or a new language rule.

This pressure test made a distinct ownership boundary precise. WebKit registers
a strongly retained `WKScriptMessageHandler` through an add method rather than
a weak delegate property, so `objc.bind` is deliberately inapplicable. Stage 0
now preserves `id<Protocol>` evidence on method parameters and provides the
general `objc.register({ add, remove })` guard. It validates the native pair and
Z protocol conformance, owns the receiver, generated adapter, and controller,
and unregisters exactly once during cleanup. A runtime fixture proves
add/callback/remove ordering, while a real WebKit example proves the SDK shape.
Version 10 carries Objective-C
interfaces, protocols, methods, `id<Protocol>` qualifiers, and semantic type
identity plus interface-property metadata into owned native Z data, and native semantic normalization now
consumes that graph. A fixed-point positive fixture plus protocol-owner and
teardown negatives prove `objc.register` no longer relies on Stage 0 fallback.
Native direct message emission now consumes the same resolutions, including
class and instance selectors, ARC reference storage, and C-string projection.
Representable inherited instance-property reads now lower through their exact
getter selectors as well.
Version 11 carries Clang's flag-enum classification into the same owned native
model. The resolver consumes that narrow verified fact before its general
unresolved-header deferral. As a result, expressions such as
`NSWindowStyleMaskTitled | NSWindowStyleMaskClosable` retain the nominal
`NSWindowStyleMask` type through inference and native lowering.

The same Zapp construction path exposed a distinct nominal-identity seam:
AppKit spells a frame as `NSRect`, while WebKit accepts its canonical `CGRect`
alias. `ZFDCL` already carried Clang's canonical record name, but native
normalization discarded it. The owned type signature now retains both source
and canonical spellings. Equivalence uses the canonical name only inside the
same producer contract; lowering and hover keep the source spelling. Zapp can
construct one frame with `NSMakeRect` and pass it directly to both
`WKWebView.initWithFrame` and `NSWindow.initWithContentRect`, without a wrapper,
copy, cast, or structural-layout guess.
The fixed-point emitter now consumes the registration plan as well. It
synthesizes a protocol-conforming Objective-C adapter that retains the Z
handler, plus an ARC guard that owns the receiver, adapter, and teardown
arguments and sends the verified remove selector once during `dealloc`.
Objective-C fields in a Z ARC class are cleared before its malloc-backed
storage is freed, so a guard stored in long-lived application state has a
deterministic lifetime rather than depending on a local frame. A release-mode
fixture built by a freshly bootstrapped native `z` proves
`registered -> callback -> unregistered` and exercises an ordinary `in`
Objective-C argument without adding a pointer level. Zapp now uses that surface
directly: its Z `DesktopApplication` owns the protocol handler and registration
guard, while the Objective-C host no longer conforms to
`WKScriptMessageHandler` or manually installs/removes itself. A visible WebKit
message reaches the Z-owned adapter, crosses the typed JSON router, and returns
to the page before deterministic runtime shutdown removes the handler.

That real SDK integration first exposed two fixed-point gaps which are now
ordinary regressions. An inherited Objective-C method returning `instancetype` must
rebind to the dynamic receiver type, so `Subclass.alloc().init()` remains a
`Subclass` even when `alloc` or `init` is declared by `NSObject`. Imported C
record fields may also name namespace-qualified nominal enums; native lowering
now resolves that identity and emits the enum field rather than rejecting the
record.

The next checkpoint removed the dynamic host seam. Z reads WebKit's
`id`-typed `message.body`, narrows it with
`body instanceof native.NSString`, and explicitly copies the narrowed object
into an owned `String`. The copy uses the Objective-C UTF-8 byte length rather
than `strlen`, so embedded null bytes remain data rather than truncating the
message. A non-string body produces the typed bridge error from Z; Objective-C
no longer performs validation or calls the routing export.

That move exposed four adjacent fixed-point integration gaps. The native
emitter now lowers the Objective-C `SEL` spelling used by protocol metadata,
projects contextual Z string literals to direct C-string arguments, suppresses
unused imported protocol parameters without changing their signatures, and
copies `NSString` into fresh Z storage with no dependency on Foundation's
`nil` or `NSUInteger` convenience spellings. Foreign declaration caching is
also tied to the current `ZFDCL` protocol version and verifies the cached stream
header, so a compiler upgrade cannot silently reuse stale metadata. Focused
Stage 0, fixed-point, cache-regeneration, and visible WebKit runs retain these
as ordinary regressions.

The lifecycle now has repeatable sanitizer evidence rather than an ad hoc
binary. A bounded Zapp driver recompiles the generated core and host with UBSan,
enables Objective-C zombies, completes the visible message round trip, and
requires deterministic registration teardown. It probes ASan with an empty
program before instrumenting WebKit because the current macOS/Xcode ASan
runtime can deadlock inside dyld initialization before `main`; every probe and
application child has a hard deadline and is killed on timeout. This separates
a broken host sanitizer runtime from a Z failure and prevents a diagnostic run
from leaving CPU-intensive processes behind. ASan and leak evidence still need
a compatible host or CI runner before Phase 1 is considered fully closed.

Expressing a borrowed Objective-C-owned string view remains a future checked
interop layer; the application uses an explicit owned copy rather than
weakening `view` provenance to hide that gap.

The same pressure test also removed an accidental ceremony seam: Zapp's desktop
header needed an empty `.zd` even though every declaration it consumed came
directly from Clang. The fixed-point driver now treats `.zd` as an optional
semantic overlay. Safely representable header types, plain value-ABI functions,
and Objective-C declarations remain available without a sidecar, while a C
function needing pointer or ownership facts still fails at the exact use site.
Native Objective-C fixtures now omit their former empty contracts, proving
convenience did not broaden the trusted ABI surface.

The same registration fixture also runs through Stage 0. An explicit
`publish(in owner)` call now passes an Objective-C reference directly in both
frontends; capability lowering no longer mistakes reference identity for a
value struct and emit `Owner **` at the call site.

The probe also exposed a separate importer identity gap: AppKit's `NSRect` and
WebKit's `CGRect` are ABI aliases, but their namespace-qualified source names do
not currently unify at a cross-framework call. Constructing `WebKit.CGRect`
works, while passing `AppKit.NSMakeRect(...)` does not. Canonical Clang type
identity should eventually make that source-header choice irrelevant.

Moving the next UI identities into Z exposed a more urgent native-compiler
scalability defect. Stored-view validation recursively treated every imported
Objective-C property as embedded value storage. AppKit and WebKit form a large,
mutually referential object graph; one cold Zapp build spent more than four
minutes in that traversal and reached a 55.1 GiB physical footprint before it
was stopped. Foreign Objective-C references now terminate the traversal at
their one-pointer identity. The same build reaches ordinary semantic
diagnostics in seconds instead of recursively exploring the SDK graph.

The migration also closed inherited Objective-C reference assignment in the
fixed-point compiler. `WKWebView` can now populate nullable `NSView` storage,
and a regression proves a non-null imported subclass can flow into a nullable
superclass property while the reverse/nullability-weakening directions remain
checked. Zapp now creates and strongly owns its content controller,
configuration, WebView, window, registration owner, and registration guard in
one main-executor `DesktopApplication`; the Objective-C run-loop host retains
only weak access. The visible WebView round trip remains unchanged. Nominal
inference for bitwise imported enum expressions and canonical `NSRect`/`CGRect`
identity remain follow-ups surfaced by this slice.

Inspecting the emitted ARC graph found a subtler fixed-point parity issue: the
Stage 0 class allocator used zeroed storage, while the native emitter used raw
`malloc` before assigning Objective-C strong fields. ARC strong assignment may
release the prior slot, so an uninitialized slot is not a sound construction
state even when fresh pages happen to be zero. Native Z class construction now
uses `calloc` before initializing fields, and the fixed-point Objective-C
fixture retains that generated-storage requirement.

## Zapp typed-service composition

The first Z-owned Zapp service router combined a transparent callable alias
declared in one module, imported into another module, stored in a mutable Map,
frozen into a readonly Map, retrieved through `Option`, copied into a local
handler, and invoked. Each feature already had isolated native evidence. In
composition, call lowering expanded only local type aliases and emitted the
imported callable handle as though it were a raw C function pointer.

Native call lowering now follows transparent callable aliases through imported
type evidence before selecting the typed handle-call expression. A focused
three-module fixture emits C, compiles it with strict warnings, and executes the
retrieved handler. Zapp retains a frozen typed routing table instead of using a
manual switch or weakening the service abstraction.

The registry also passed one captured handler to two ordinary Z methods before
freezing. That exposed a second composition bug: native method-call lowering
treated every identifier argument as a unique transfer, while Stage 0 retained
ARC-managed callable values passed by value. Both entries could therefore share
one physical closure reference count and intermittently double-release it during
Map cleanup. Native method and Objective-C call arguments now use the same
owned-storage projection as ordinary calls, including retained function values.
The fixture installs one captured imported handler twice and must execute and
destroy the complete routing table without a use-after-free.

The same application probe originally established two honest fixed-point
boundaries. Static trait calls are now executable through concrete
specialization, while cross-module `json.decode<UserType>` specialization is
still not native-authoritative. The generated service adapter therefore
projects `JsonValue` while the public service method and TypeScript binding
remain typed. These are compiler composition tasks, not reasons to expose JSON
or adapter boilerplate to Zapp application authors.

## Zapp-owned executable lifecycle

Moving Zapp's public builder from prose into the visible application exposed
two more composition seams. First, constructing an imported ordinary value
struct omitted a field default whose expression belonged to the declaring
module. Semantic checking correctly accepted `Application({ name: "Notes" })`, but
the fixed-point emitter produced zero-initialized `ServicesBuilder` storage.
Ordinary non-generic defaults now lower to private owner-module helpers, just
as concrete generic defaults already did. A focused two-module regression
constructs an application-shaped value whose fresh default owns an `Array`,
mutates it, and destroys it normally.

Second, an ordinary Z `main` inside a static library naturally collided with
the Objective-C host's `main`. The application now uses the clearer final
ownership split instead of renaming either entry point: Z builds the executable
and owns `main`, while Objective-C is a prelinked platform adapter that prepares
the host, provides the run loop, and returns its exit status. The Z
`run(move this)` method freezes services, publishes the `Once`-backed desktop
root for exactly the blocking run-loop lifetime, and releases it after the
window closes. The visible WebKit round trip exercises this exact path.

That executable also demonstrated that Apple frameworks are native link
dependencies, not Swift-only configuration. `z.json` now accepts validated,
deduplicated `target.link.frameworks`, with Stage 0, fixed-point driver, cache,
schema, and documentation parity. Zapp names AppKit, WebKit, and CoreFoundation
there; its CLI no longer smuggles framework flags into a second final link.

## Zapp platform-contract seam

Separating Zapp's portable `Application` builder from its AppKit runtime found
an executor-contract boundary before target-conditional modules exist. The
shared builder can consume its services into an `ApplicationConfig`, while a
selected module exports
`runApplicationPlatform(config: ApplicationConfig): i32 on thread.main`.
macOS stores AppKit and WebKit identities in a private ARC runtime; a headless
smoke satisfies the same selected-module export with a small value runtime.
Because each target is compiled separately, their storage layouts do not need
to agree and the platform choice needs no runtime vtable.

An ordinary trait remains the natural nominal contract, and the fixed-point
compiler now executes statically constrained calls. The selected module's
exact exported function signature remains the implemented platform seam because
platform selection is a compile-time module problem rather than a reason for
runtime trait dispatch. Stored synchronous callables preserve `thread.main`
without erasing the executor guarantee, which closes the lifecycle-adapter
representation gap but does not replace future target-matrix module selection.

## Zapp lifecycle composition checkpoint

Making that adapter executable against Zapp's real blocking AppKit/WebKit path
found four general compiler seams that smaller callable fixtures had not
combined. A main-affine aggregate default now receives the same main-executor
proof as construction of its containing aggregate. `Result<void, E>` emission
no longer invents a success payload for expression-bodied throwing callables.
Fixed-point try lowering recognizes a throwing callable stored in a field, and
indexed ARC class values are retained when they become owned locals instead of
being borrowed and later released as though independently owned.

The indexed-class correction also fixed the collection C ABI: immutable access
uses pointer-to-const-element storage rather than accidentally making the class
pointee const, and Array/Map/Set teardown releases ARC class elements instead of
calling nonexistent value destructors. A fixed-point regression emits, strict
compiles, and executes a main-qualified throwing callable plus `Array<Class>`;
it asserts the balancing indexed retain and collection release explicitly.

Zapp keeps lifecycle orchestration separate from its `on thread.any` service
router. Starts execute in registration order, a failed start rolls back the
started prefix in reverse order, and normal stop attempts every service in
reverse order before propagating the first stop failure. A lifecycle-only
fixed-point executable proves all three paths. The real Z-owned AppKit/WebKit
application then builds with the same fixed-point compiler, completes its
visible typed WebView round trip, returns from the native run loop, and performs
the empty lifecycle shutdown path without adding work to the service-call fast
path. The stored-callable adapter is framework/compiler plumbing generated from
the checked `ServiceLifecycle` contract, not a second user-facing model.

## Static trait lifecycle adapter checkpoint

Turning `ServiceLifecycle` into an executable nominal trait closed three
fixed-point seams. A constrained type parameter now carries its proven trait
constraint into nested generic construction, trait method evidence is lowered
as a direct concrete call after specialization, and trait declarations no
longer trigger a blanket native-lowerability rejection. The emitted C contains
`Z_Concrete_method(...)`, not a vtable lookup or trait-object allocation.

The lifecycle adapter also exposed an owned-callable retain imbalance. A
captured hook had already been retained by expression lowering, but aggregate
storage wrapped it in a second retain. Recognizing the existing retained value
restores one ownership transfer into the adapter and one balancing release at
destruction.

The downstream ownership boundary is now executable rather than modeled.
Generic free functions and independently generic methods defer specialization
until every module's concrete types have been lowered. Their demand records use
canonical semantic identities for deduplication and retain the consumer's
symbol provenance, so a framework-owned `register<T: ServiceLifecycle>` can
capture an application-private, cleanup-bearing service and emit direct calls
to its concrete methods. A second demand-closure pass also carries such a
method's concrete substitution into generic helper calls in its body.

This removed Zapp's hand-written lifecycle adapter without adding reflection,
trait objects, metadata-only runtime dispatch, or source syntax. Permanent
two-module fixtures compile and execute both the free-function adapter and the
generic builder-method shape under strict C warnings.

## Factory-returned service identity across a framework boundary

Separating Zapp's reusable framework from its Notes application exposed a
three-module native parity gap. The application imported only
`createNotesService()`, then passed its inferred `NotesService` result into the
framework's constrained `ServicesBuilder.register<T: Service>`. Stage 0
correctly followed the factory return identity; the fixed-point resolver looked
only for a caller-local type symbol and demanded an otherwise-unused
`NotesService` import.

The native constraint checker now reuses unique exported-type inference for
both the concrete aggregate and required trait. Ambiguous names still fail
closed, while the ordinary ergonomic call remains sufficient:

```z
app.services.register("notes", createNotesService());
```

A permanent three-module fixture keeps the trait, implementation/factory, and
consumer separate, then checks, emits, compiles, and runs the result. This is a
general module-composition correction rather than a Zapp special case.

## Deferred Zapp probe: Servo through Rust's C ABI

Servo is worth exploring as a future first-party, behaviorally consistent
WebView engine for Zapp rather than as a reason to add a Rust ABI to Z. The
stable architecture is Z calling Servo's Rust implementation through Servo's
C-compatible embedding library:

```text
Zapp application and services in Z
                |
          Z Servo backend
                |
   checked Servo C header plus `.zd`
                |
        Servo's Rust implementation
```

This should use Rust `staticlib` or `cdylib` artifacts, `#[repr(C)]` values,
opaque handles, and generated C headers. Z's existing header importer and
`.zd` vocabulary should carry ownership, cleanup, callback lifetime and
cardinality, caller thread, buffer projection, transfer, and destruction
affinity. Rust `String`, `Vec`, traits, generics, `Result`, and `Future` should
remain behind that boundary rather than entering Z's type system. Panics must
also be contained inside Rust and never unwind through Z.

The bounded spike is:

1. build Servo's C API as one static or shared native dependency;
2. import its generated header into Z without a handwritten Zapp shim;
3. create and deterministically destroy one engine/WebView owner using checked
   contract facts;
4. render one page in a native Zapp window;
5. exercise resize, input, script evaluation, and one JavaScript-to-Z message;
6. measure binary size, idle memory, startup, first paint, build time, and
   bridge overhead; and
7. record missing C API operations instead of depending on Servo's native Rust
   ABI.

Servo could offer stronger engine parity across macOS, Windows, and Linux than
the platform WebViews while fitting Zapp's size and safety goals better than
CEF. It does not eliminate platform work: window surfaces, GPU contexts, event
loops, input/IME, accessibility, packaging, resources, and native services
remain platform adapters. Treat this as an experimental backend until the
embedding surface, web compatibility, build reproducibility, and measurements
justify a product commitment. System WebViews remain the smallest baseline;
CEF remains the mature compatibility comparison.

## A stored async callable forced the enclosing frame to become real

The first stored-async callable suspension initially used a stack-local C
awaiter that drained a private executor. That proved the dynamic child's frame,
result transfer, and waiter wake-up, but the enclosing Z function still lived
on the native C call stack.

The first bounded linear `async main` shape now owns its callable local, child
invocation, state, and result in one heap frame. Starting the child records the
parent task as its waiter and returns to the FIFO executor. When the child
completes after `scheduler.yield()`, the executor requeues the parent; only that
resumed parent takes the result, destroys the child invocation, and releases
the stored callable. Existing lowering cleanup evidence selects this path, so
there is no new source syntax or parallel ownership rule.

The next bounded shape adds one ordinary local and one callable argument. The
parent writes that local into its heap frame, exposes a poll-local C binding
while starting the child, and recreates that binding only after the child wakes
it. The return expression then reads the original value, proving that neither
the child call nor the suspension borrowed a dead C-stack temporary. A
cleanup-free value crosses by value.

The same frame now accepts one cleanup-bearing owner through an `in` callable
parameter. The child receives a pointer to the frame's address-stable storage;
it does not copy, retain, or take ownership of the value. A `live_stored` bit
guards the owner's destructor. Normal completion evaluates the return while the
owner is live, then destroys and clears it. Destroying a parent after its first
poll releases the unfinished child and destroys the owner through the same live
bit. An executable `deinit` fixture observes exactly one destructor call on
both paths.

Cancellation now follows the same ownership path instead of bypassing it. Every
local-executor task frame records requested and terminal cancellation states.
Requesting cancellation on the suspended parent marks its dynamic child. The
child observes that request at its next poll, completes as cancelled, and wakes
the waiting parent through the ordinary executor queue. The resumed parent then
releases the child invocation, callable, and stored owner before entering its
own cancelled terminal state. Destroying that completed parent sees cleared live
bits and cannot repeat cleanup. Unfinished destruction also unlinks both parent
and child from the FIFO queue before freeing either frame, so executor progress
cannot observe a dangling task node. This proves the frame-level contract before
a public dynamic callable `Task` handle exposes it.

This remains intentionally narrow: one stored async callable, one direct await,
one ordinary local and callable argument, and one cleanup-free integer return.
An ownership-bearing argument must be `in`; consuming it would contradict the
required post-resume use. The restriction keeps unsupported control flow on the
existing diagnosed path while establishing the frame shape needed for multiple
locals and arguments and structured control flow in later native slices. That
same invocation contract now backs the public Stage 0 handle described below.

## Public callable tasks reuse the same ownership contract

Stage 0 now lowers `task handler(...)` for a stored async function value instead
of limiting that callable to direct await. The returned handle is the ordinary
owned `Task<T, E>`: `try await` transfers success or propagates the declared
error, `attempt await` materializes both branches, and
`await pending.cancel()` requests cancellation before joining and discarding an
unclaimed outcome. An unobserved callable-backed child is joined at lexical
`async scope` exit. Every path destroys the invocation frame, its retained
callable context, and any live result or error exactly once.

The borrowed-owner pressure case is deliberately stricter than a value-only
task. `task handler(in owner)` requires named address-stable storage inside an
explicit `async scope`; the scope join bounds the loan across normal exit,
throw, return, and cancellation. The executable example starts one child and
joins it, starts another and cancels it, and leaves a third to the implicit scope
join before reverse-order owner cleanup. Removing the scope is a `Z0704`
diagnostic rather than a latent dangling pointer.

The fixed-point emitter now closes the first bounded version of that gap. An
unnamed `async scope` may hold one stored nonthrowing void callable, one hot
callable-backed task, one explicit consuming join or cancellation join, and one
optional address-stable owner borrowed by the child. The scope lowers to the
same heap-owned parent frame already proven by direct await. `await pending`
propagates structural child cancellation to the parent;
`await pending.cancel()` requests cancellation before scheduling the child,
joins its terminal poll, and resumes the parent normally. The borrowed owner is
then usable by the return expression and destroyed exactly once with the stored
callable and invocation.

This pressure test also found that the generic fixed-point `Task<void>` storage
still attempted to emit a C field of type `void`. Void tasks now use an explicit
empty storage byte and their native await path joins without manufacturing a
result slot. Strict C compilation and execution cover both the normal join and
explicit cancellation shapes. Typed callable task results/errors, implicit
scope-exit join, multiple children, named scopes, and general enclosing control
flow remain the next composition tiers. The checkpoint passed all 94
self-hosting tests—including exact fixed-point bootstrap and differential
execution—and all 265 language-tier tests.

The same checkpoint exposed a compiler-velocity problem rather than hiding it.
On the development machine on 2026-08-24, a cold exact fixed-point rebuild of
the 7.85 MB generated compiler took 109.57 seconds of wall time; Stage 0 seed C
emission alone took 77.87 seconds. By contrast, a cached native-front-end check
of the async fixture completed in roughly 15 milliseconds. Incremental work is
still fast, but cold self-host emission is now the measured optimization target
before it becomes routine application-build latency.

Profiling showed that cleanup planning was recomputing the same ownership
answer for every cleanup-bearing local. Each query recursively walked the
statement arena, re-resolved every call's parameter capabilities, and then
rescanned lowered move and thread-capture expressions. Nested statements also
appeared both in the arena and beneath their parents, multiplying that work.

Cleanup lowering now builds one move-evidence index per function: moved binding
names, exact moved thread-capture offsets, and the presence of branching control
flow. Locals, destructured bindings, parameters, and recursive cleanup branches
reuse that evidence without changing the source ownership rules. With the
self-hosted library prepared, the same complete compiler emission fell from
77.87 to 35.43 seconds on the development machine, a 54.5% wall-time reduction.
The resulting 7,857,457-byte C output passed an exact fixed-point rebuild, all
265 language-tier tests, and all 90 self-hosting tests. The remaining 35-second
cost is still too high for routine cold application builds, so profiling and
incremental native emission remain active compiler-velocity work.

The next profile found the same linear semantic-evidence scan on both sides of
lowering. Semantic inference searched every prior expression resolution before
recording a new one, then lowering searched the full array again whenever it
needed a node's resolved type or native target. `ModuleSemanticEvidence` now
keeps a derived source-offset-to-resolution index while the ordered resolution
array remains the protocol truth. Recording and lookup therefore reuse the
same evidence in expected constant time; source line and column are still
checked before lowering consumes the result.

With the prepared self-hosted library, complete compiler emission fell again
from 35.43 to 12.90 seconds. This is an 83.4% reduction from the original
77.87-second baseline, with byte-identical repeated 7,866,641-byte C output.
An exact fixed-point preparation completed in 38.72 seconds. The full
self-hosting suite remained 90/90 and fell from 374.98 to 262.29 seconds on the
two adjacent validation runs; all 265 language-tier tests also remained green.
These are development-machine measurements rather than release benchmarks, but
they establish semantic indexing as a necessary foundation for compiler-scale
Z programs.

The next split profile isolated one more compiler-scale lookup in native
lowering. Function-type discovery asked every binding, expression, parameter,
field, and method whether its type spelling resolved through a callable alias.
Each query rescanned the module's full imported-type array; because an imported
type carries fields, variants, ownership, and executor metadata, ordinary
iteration also copied substantially more state than the lookup needed.

Lowering now builds one callable-alias target array and a `Map<String, usize>`
index per module before function-type discovery. Local aliases still override
imported aliases, alias chains keep the existing bounded resolution rule, and
the broader lowering model remains unchanged. Warm complete compiler emission
fell from 12.90 to 7.50 seconds, a further 41.9% reduction and a 90.4% reduction
from the original 77.87-second baseline. Repeated 7,872,237-byte C output was
byte-identical. The full self-hosting suite remained 90/90 and completed in
242.34 seconds versus 262.29 seconds at the preceding checkpoint; all 265
language-tier tests also remained green in 87.53 seconds. The remaining profile
is materially flatter, so future optimization should continue to require a
measured dominant path rather than accumulating speculative caches.

## Zapp async services exposed library-shaped composition gaps

The first Zapp async-service route stores an `async (in invocation) =>
ServiceOutcome on thread.any` callable in a frozen Map, selects it from a JSON
bridge request, suspends through `scheduler.yield()`, and returns the typed
response. The exercise immediately found that an unused ordinary async method
in an imported module emitted an unreferenced static frame-destroy helper.
Strict C builds therefore failed even when a synchronous application never
called the async surface. Generated destroy helpers are now explicitly marked
unused, and a synchronous program importing an unused async declaration is a
permanent runtime regression.

The application also made the fixed-point boundary visible. Its native semantic
frontend agrees with Stage 0 on the complete async graph. The fixed-point C
emitter executes a direct call to an imported async free function with a
cleanup-free signature through a heap-owned task adapter. Immediate functions
complete directly; a function beginning with one `await scheduler.yield()`
stores its arguments, requeues once, observes cancellation, resumes its
synchronous tail, and transfers the result exactly once under strict C
compilation.

The next slice closed `SearchService.invoke` itself without new source syntax.
A directly awaited, non-consuming ARC class method may begin with the same one
yield and return a cleanup-bearing value. Its frame retains the receiver, keeps
an `in` argument as a loan for the blocking join instead of copying its owned
fields, marks the result live only after the method tail completes, and either
transfers or destroys that result exactly once. A deinitializer regression
proves the receiver retain is balanced. The Zapp graph now advances to
`AsyncServices.invoke`, whose loop, frozen maps, matches, owned locals, and
dynamic child-callable await require a general parent/child frame rather than
another one-off adapter. That is the next honest composition boundary.

The first reusable part of that boundary now executes independently of Zapp.
An async adapter consisting of one tail `return await handler(...)` lowers to a
heap-owned parent frame. A cleanup-bearing handler parameter remains live in
the frame, borrowed request storage stays address-stable, and the child installs
the parent as its waiter. Completion transfers an ownership-bearing result;
cancellation forwards to the child; every child invocation, callable context,
argument, and unclaimed result is destroyed exactly once. The strict-C runtime
fixture captures an ARC owner in the handler environment and proves that its
deinitializer runs once. `AsyncServices.invoke` still requires the next tier:
the same mechanism composed with its prefix loop, early returns, Map loan,
owned local construction, and final Option match.

The same adapter frame now backs a non-consuming ARC class method. A strict-C
fixture proves the method receiver remains retained while the dynamic child
runs, the owned handler environment is released after result transfer, and
both captured state and receiver deinitializers run exactly once. This closes
the method-vs-free-function distinction for the tail adapter without adding a
second source-level async rule.

The next slice hoists straight-line locals declared before that method's tail
await into the same heap frame. A cleanup-bearing `Request` may therefore be
constructed locally, passed `in` to a suspended handler, and destroyed only
after the handler finishes. The ordinary source shape remains unchanged; this
is more work by the compiler rather than another ownership capability for the
author to spell.

That parent now also accepts the first routing-control layer: a synchronous
prefix loop plus an early-result branch before the tail await. A strict-C
fixture executes both the immediate result and dynamic-child paths. The next
remaining Zapp-specific boundary is the final `Option` match that extracts the
selected handler before suspension.

That final consuming match now shares the same parent frame. Its selected
cleanup-bearing callable payload moves from the enum into a guarded frame field,
starts the dynamic child, and remains live until completion or cancellation.
The payload-free arm completes immediately, and unfinished-frame destruction
cleans whichever owner is still live. Applying the fixture to Zapp uncovered a
separate ABI-identity bug: synchronous and asynchronous service handlers with
the same arguments and result had distinct Z types but the same encoded native
callable name. Native function identities now include the async effect, so both
maps can coexist without declaration-order ambiguity. `AsyncServices.invoke`
now emits as strict C; the next boundary is the outer free-function bridge that
matches a decoded request, awaits the service method, and transforms its result.

The outer decoded-request match now uses the same mechanism in a free-function
frame, retaining its decoded message and forwarding it to the selected child.
The next slice makes that child result persistent too. A direct async free
function may initialize one local with an awaited non-consuming ARC method,
resume through the child's waiter, then execute a synchronous suffix that
checks, transforms, returns, or moves the local. The frame retains the receiver,
keeps borrowed arguments address-stable, guards the result after transfer, and
cleans child plus every live owner on cancellation or destruction. The strict-C
fixture executes the full suspend/resume path. Applied to Zapp, this closes
`dispatchWithServicesAsync` and moves the native boundary to the generic
captured `asyncServiceHandler<T>` closure adapter.

That generic adapter now executes without changing its source shape. Lowering
keeps the awaited method expression instead of replacing it with a placeholder,
discovers the specialized service capture, and gives the cold closure a real
parent frame. Each invocation retains the callable environment, stores borrowed
arguments for the join, starts the captured service method on the current
executor, forwards cancellation, and transfers an ownership-bearing result once.
A strict-C generic trait fixture proves the same path independently of Zapp.
The complete Zapp graph now reaches `main`. Its synchronous health route and
suspended search route both emit as strict C and execute end to end. The first
version sequenced the two bridge awaits only from top-level `async main` through
blocking local-executor adapters. The next pressure slice moved both calls into
an ordinary `validateRoutes()` async free function. One heap-owned frame now
stores its service and request/result locals, starts the first child, resumes
through the waiter, starts the second child, and resumes again before returning.
Cancellation follows whichever child is active and unfinished-frame destruction
walks the same live guards. This is deliberately a two-site linear tier;
arbitrary state graphs, branching between awaits, throwing children, and
suspending async method bodies remain broader work.

That final run exposed ownership bugs that smaller fixtures had not combined.
A consuming intrinsic-Result match moved its payload into a child frame while
leaving the original Result live, and a value-parameter async call transferred
an ARC class pointer without retaining it. Native lowering now marks the enum
owner dead before payload extraction, transfers a moved selected payload by
clearing its frame guard, and applies the same owned-storage wrapping used by
synchronous calls to async function, callable, method, and placed-call
arguments. Cleanup-bearing immediate match arms evaluate their return value
before destroying the bound payload. A standalone strict-C fixture combines
the consuming Result, ARC argument, selected child, cleanup-bearing failure,
post-await owned local, and synchronous result match so this application-shaped
ownership seam no longer depends on the sibling Zapp repository.

Two ownership details held without new syntax. `Map.get` returns a view, so the
route first retains the selected ARC-backed async callable into an owned Option
and ends the map loan before `await`. The synchronous and async maps remain
separate, preserving the direct synchronous fast path while one async bridge can
serve either kind. The wrapper can now forward its proven generic constraint
directly into an imported generic builder method. Stage 0 records dependent
method demands while analyzing the generic wrapper and materializes them only
after a downstream concrete specialization exists. Fixed-point lowering closes
the same function-to-method and method-to-method demand graph before emitting C.
A three-module fixture covers both shapes, rejects an unconstrained forwarding
attempt, and executes the resulting direct concrete calls under strict C. Zapp
can therefore delegate to `ServicesBuilder.register<T: Service>` instead of
recreating its three-line handler adapter.

Zapp's first source-local application manifest exposed a project-authority gap
in the fixed-point compiler. The app entry imported framework `.zs` modules
outside its directory; those modules imported Objective-C headers by basename.
The native driver knew the app's `includeDirectories`, but its adjacent Clang
metadata producer rediscovered a project from each framework module and lost
that context. The driver now passes its already validated manifest path to the
producer explicitly. A standalone adapter fixture and a fixed-point two-module
project prove that external source modules keep the owning app's native header
and deployment configuration. This preserves reusable framework layouts
without copied headers or nested compatibility manifests.

The first suspending WebView service round trip then exposed three lifetime bugs
that the headless async fixtures did not combine. A `TaskScope` copied from an
ARC runtime field was treated like an ordinary class pointer instead of using
the scope runtime's retain operation, and a scope local was joined and released
before a direct `return await` child began. Finally, the source location of a
captured ARC value also carried the managed-copy effect of its use inside the
closure, so `TaskScope.schedule` retained it once for the inner call and again
for capture storage. Capture lowering now separates those two effects. Standard
async handles keep one canonical identity across imported modules, managed
field copies retain the correct runtime object, and owned scopes finalize only
after the function's active child has completed or cancellation has propagated.
The same Z Notes
request now travels from a WebKit callback through `TaskScope.schedule`, a
suspending `AsyncService`, and main-thread response delivery before shutdown
cancels and joins the scope. No new source capability was added; the compiler
made the existing structured-lifetime promise hold under application-shaped
composition.

Moving that application entirely onto the fixed-point driver exposed the next
ownership seam. A scheduled async closure correctly cleared the live bit for a
captured `String` when forwarding it into a direct async adapter, but the
adapter's own task-frame parameter remained live after forwarding the same
owner to its child. Parent and child therefore both destroyed one allocation.
Native lowering now gives every cleanup-bearing moved parameter of an async
function a live guard, not only parameters in already-recognized suspending
shapes. Closure environments likewise carry live bits for cleanup-bearing
captures; generated move guards refer to that storage in synchronous calls,
immediate async starts, and suspending polls. Completion, cancellation, and
environment release all consult the same evidence.

The resulting `TaskScope` fixture moves a `String` from a callback environment
through two async frames, places the operation on `thread.main`, and joins the
scope under strict C compilation. It also revealed that an explicit scope can
remain useful after all source awaits optimize to synchronous joins and no
enclosing task supplies an executor. `TaskScope` now owns an embedded serial
fallback executor for that root case. This is not detachment or an implicit
thread: the current thread drives the scope until its accepted work finishes.
With those fixes, the visible Z Notes WebView round trip builds and runs through
the fixed-point native driver with no Stage 0 override.

The next cancellation pressure test moved an owned async parameter into a
frame-local resource before a main-executor delay. Existing frame live bits
already described the transfer, but lowering rejected it before emission.
Branch and match suspension segments now restore and save parameter liveness,
so cancellation destroys the frame local exactly once and does not also
destroy the moved-from parameter. Linear and loop suspension plans retain their
conservative transfer restriction until they carry the same proof.

The same probe found a more serious hidden boundary: a stored async closure
could await a method whose body suspends on `delay`, while the helper invoked
that method's deliberately unavailable synchronous stub after one requeue.
The first fix failed closed instead of emitting the aborting fallback. The next
slice then gave the fixed-point executor a monotonic timer queue and emitted a
heap-owned linear method frame for this composition. A `TaskScope` proof now
runs one delayed method to completion and cancels another while it is parked.
Cancellation removes the timer, resumes the child immediately, skips its
post-delay continuation, destroys a cleanup-bearing local exactly once, and
lets the scope join without waiting for the original deadline. Branching and
looping delay-method frames remain conservative rather than silently falling
back to synchronous code. This closes the runtime prerequisite for Zapp to map
frontend request cancellation onto the accepted `TaskControl`.

The first deterministic Zapp request-cancellation registry then combined three
more seams. A generic class method calling a generic free function reused stale
parameter evidence when two distinct ARC class specializations appeared in one
module. Fixed-point `move` closure lowering transferred ARC and callable
identities out of the enclosing scope even though managed identity capture is a
retain, not a unique-owner move. Stage 0 retained classes copied out of borrowed
`Map` payloads in async frames but omitted the equivalent retain for stored
function identities. Native specialization now rebuilds local generic call
parameters from the concrete type arguments, managed closure capture emits the
type's retain operation, and async frame copies share one retain dispatcher for
classes, functions, `Mutex`, `TaskScope`, and `TaskControl`. Focused strict-C
fixtures reuse one ARC service across two delayed scheduled closures and invoke
the same async handler from a Map twice.

Zapp keeps the mutable request record entirely inside a `thread.main` registry.
Scheduled closures carry only the scalar request ID and generation; attachment
associates the returned `TaskControl` after admission, and completion removes
only the matching generation. The headless proof parks one child in
scheduler-aware `delay`, cancels it by ID, verifies that its continuation never
runs, and then completes a later service request. Stage 0 and the fixed-point
compiler execute the unchanged smoke, and cancellation removes the timer rather
than waiting for its deadline. The probe also closed an adjacent semantic parity
gap: both frontends now check trait executor contracts contravariantly across
module boundaries. An unrestricted implementation may satisfy a
`thread.main`-isolated requirement, but a main-isolated implementation cannot
silently strengthen an unrestricted trait method. Diagnostics use the declared
trait name rather than a compiler-owned module symbol.

The next executor-placement slice removed the tail-only restriction from one
ordinary async free-function composition. A parent may now bind one direct
`await on thread.main operation(...)` result, resume a straight-line
synchronous suffix, and keep an ownership-bearing result in its heap frame
until that suffix consumes or destroys it. The pressure fixture moves a String
inside an owned argument into a delayed main-isolated child, returns a second
cleanup-bearing struct, observes it after resumption, and proves both values
destroy exactly once. That probe exposed a latent delayed-frame bug: the
synchronous continuation destroyed its local alias of an owned parameter, but
the frame still marked the original slot live and destroyed the same storage
again. Successful continuation now disarms the frame's stored-parameter guards
after ordinary function cleanup. Cancellation continues to use those guards
while the child is suspended. The full 118-test fixed-point suite and the
Stage-0 async runtime tier pass with the same worker-placement behavior.

The Zapp-shaped follow-up made that placed local fallible without adding a new
execution form. `const status = try await on thread.main publish(request);`
now keeps the native child's `Result<T, E>` intact through suspension. The
parent frame extracts and stores `T` only on success. On failure it moves the
owned `E` into its own result slot, releases the child, cleans frame locals and
stored arguments, and completes without executing the success suffix. The
strict-C runtime probe deliberately throws a cleanup-bearing error after a
main-executor delay and observes exactly one request destruction and one error
destruction. The generated parent cancellation hook still forwards to the
active child before either result arm is selected.

## Service work followed by explicit main publication

The next Zapp-shaped pressure fixture combines the two bounded async tiers in
one ordinary handler:

```z
async function handle(
  router: ServiceRouter,
  request: ServiceRequest
): i32 {
  const routed = await router.route(in request);
  const published = await on thread.main publish(routed);
  return published.code;
}
```

The first child is an ordinary reusable service method. Its owned result moves
into a directly taskified main-isolated free function, and the parent resumes a
synchronous suffix after the publication result arrives. Both joins share one
heap-owned frame and cancellation follows the currently active child.

This composition exposed a lifetime bug that the simpler fixtures could not:
the async parent copied its owned `request` frame slot into a poll-stack alias,
then passed `in request` to the child by taking that alias's address. The child
correctly suspended, but resumed through a dangling pointer after the poll call
returned. Async child starts now recognize borrowed value parameters and point
directly at `frame->argumentN`. The strict-C executable verifies the complete
message survives the service suspension and immediate placed-child handoff,
and that the routed response, published response, and original request are each
destroyed exactly once.

## Generated immutable application metadata

Zapp now evaluates its typed `zapp.config.ts` once, normalizes the application
identity, and emits a tiny Z module into an isolated build workspace. Its
application entry stays ordinary Z:

```z
let app = Application();
app.services.register("notes", createNotesService());
return try await app.run();
```

`Application()` evaluates field defaults that obtain a readonly metadata value
and a fresh mutable service builder. `run(move this)` then consumes both into a
frozen runtime configuration before publishing the platform-private shared
identity. The application cannot accidentally mutate or diverge from the
configuration that packaging and frontend generation consumed, and source does
not repeat the application name, identifier, or version.

The real staged build exposed a native self-hosting parity gap: semantic
checking accepted an imported `Application()` whose fields all had defaults,
but native lowering recognized only `Application({ ... })` for imported value
structs and emitted the empty form as a C function call. Imported value-struct
construction now admits the same zero-argument default path as local structs,
with an executable cross-module regression. This is a compiler simplification
for users rather than new syntax or ownership vocabulary.

## Zapp window identity and shallow readonly storage

The first Z-owned `app.windows` slice turned the documented shallow-readonly
rule into an executable framework contract. `Application` owns a readonly
`WindowManager` class reference, while the manager mutates its executor-bound
internal state and returns ARC `Window` handles. Each handle holds only a weak
route back to the manager, so the manager retains open windows without forming
an ownership cycle:

```z
let app = Application();
const mainWindow = app.windows.create(WindowOptions({ title: "Notes" }));
return try await app.run();
```

Stage 0 incorrectly treated the readonly field as a recursive freeze and
rejected `app.windows.create(...)`. The checker now distinguishes a class
identity from inline value storage: readonly prevents replacing the class
reference, but an `inout this` class method remains callable when its executor
and exclusivity contracts are satisfied. A readonly value-struct or collection
field still rejects mutation through that path. This closes an implementation
contradiction with the language reference rather than introducing interior
mutability syntax.

The cyclic identity graph also found an ordering bug in fixed-point C emission.
An earlier class finalizer could call the typed weak cleanup helper for a later
class before that helper was declared. The native emitter now forward-declares
every class weak cleanup helper, and a differential fixture compiles and runs
the later-target shape under both compiler paths.

The same pressure test then closed the custom-constructor boundary. Zapp's
public `Window` and `WindowManager` types now use package-visible constructors
and fields rather than public implementation state or double-underscore names.
The fixed-point compiler executes non-generic, nonthrowing class constructors,
including owned `String` transfer and copied `Weak<T>` handles, while generic,
throwing, and value-struct constructors remain explicit staged boundaries. An
inline `weak this` argument still needs a named local for reliable native type
evidence, and imported callable aliases sometimes need explicit local
annotations before aggregate construction; those are smaller composition gaps
than exposing framework construction internals.

## Zapp multi-window Objective-C storage

Zapp's first dynamic two-window WebKit probe exposed an Objective-C lifetime
bug that a single lexical scope could hide. A helper created an `NSWindow`,
`WKWebView`, configuration, content controller, registration owner, and checked
`objc.Registration`, returned them inside an ARC `MacOSWindowRuntime`, and let
its locals end. Generated Z classes stored those Objective-C pointers in plain
C aggregate fields. ARC does not infer owning storage for that representation,
so the later deterministic class finalizer released dangling pointers.

Both C emitters now mark direct Objective-C class fields `__strong`. Their
generated constructors acquire one retain for each stored reference and class
finalization releases exactly that ownership. The protocol-registration
fixture now constructs and returns its registration root from a helper before
invoking the retained handler, proving the owner and adapter survive beyond
their construction scope under both Stage 0 and the fixed-point compiler.

The same application found a distinct AppKit ownership rule: an `NSWindow`
may release itself when closed even while Z still owns its reference. Zapp now
sets `releasedWhenClosed = false`; a close removes routing identity and ends
the native window lifecycle, while the Z runtime remains the sole storage owner
until application teardown. Packaged and Vite smoke tests dynamically create
two windows, isolate their injection profiles and pending-request namespaces,
close the last window, and complete deterministic cleanup without a crash.

## Package-owned native requirements

Turning Zapp's Z implementation into a real local package exposed a build
authority leak after source imports were already clean. Applications could
write `import { Application } from "zapp"`, but every consumer still had to
repeat Zapp's private header search paths and AppKit/WebKit/CoreFoundation
framework list in its own target. Directly checking the package failed because
the package itself did not carry enough context to import its headers.

`library.native` now lets the exporting library own that implementation
contract. Stage 0 and the native driver resolve its include and link directories
relative to the package manifest, merge transitive package requirements with
the selected target, and deduplicate paths, libraries, and frameworks. A
fixture imports a static-inline C header reachable only through a transitive
package's native metadata; both direct library checking and the consuming
application succeed. Zapp now checks directly while Z Notes declares only its
`zapp` path dependency and application deployment target.

The deliberately unresolved pressure is platform selection. The first package
native tier is unconditional, which is honest for Zapp's current macOS-only
implementation. Windows/Linux requirements should arrive through the shared Z
target/comptime model rather than a second condition language invented only for
manifests.

## Zapp compiled capability profiles

Zapp now compiles named WebView capability profiles from `zapp.config.ts` into
immutable Z policy. A native `WindowOptions` selects profile names; window
creation resolves their permission and service-method union once into frozen
hashed Sets, and every bridge request checks that selection before framework or
service dispatch. Frontend-created child windows inherit the exact selection,
while Web content cannot name a profile or inject trusted policy.

This application path exposed two fixed-point composition gaps that Stage 0 did
not share. First, native lowering cannot yet infer the element type of a
`for...of` binding over a `readonly Array<String>` stored on a class. Zapp uses
typed indexed reads plus explicit `copyBytes` while constructing or copying the
small profile-name list; steady-state authorization remains allocation-free
apart from ordinary ARC traffic and performs hashed membership lookup. Second,
extracting an ARC class payload from `Option<T>` into a local emitted a const
payload pointer assigned to a mutable ARC local. Passing the payload directly
into a typed helper retains it correctly and avoids the invalid assignment.

Both are compiler implementation gaps rather than desired language
restrictions. They should become differential fixtures before the workarounds
spread: readonly collection iteration must preserve its element type, and a
consuming `Option<ReadonlyClass>` match must transfer or retain an owned class
payload without discarding C qualifiers.

## Z Notes product benchmark and direct SQLite ownership

The first framework-neutral Z Notes benchmark moved beyond a window-opening
probe: a packaged Zapp application now owns a SQLite-backed notes service,
seeded persistence, typed create/list operations, embedded WebView assets, and
deterministic cleanup. The native implementation imports `sqlite3.h` directly
with a checked `.zd` contract and contains no handwritten C shim.

That workload exposed several fixed-point differences that were easy to miss
in narrower foreign fixtures. A C handle closer may return a status even though
implicit `deinit` intentionally discards it (`sqlite3_close` is canonical);
borrowed `const char *` inputs retain their source-level `in` loan while passing
by value at the ABI; a contract can expose an explicit null-only pointer
argument; `i32` to `i64` widening must compile as a direct representable cast;
and borrowed `unsigned char *` text must cast to the C-string carrier before
`String.from` performs one checked owned copy. Native inference, lowering,
runtime selection, C emission, and differential fixtures now cover those
shapes.

The persistent Zapp revision then made the SQLite handle application-owned:
service startup creates the application data directory, opens one database,
loads prior rows, and installs the owner; service shutdown drops that owner and
closes SQLite deterministically. A second packaged launch observed the three
rows written by the first launch and continued with IDs four and five. This is
the first sustained evidence that application context, lifecycle, ARC-held
native ownership, direct C calls, typed errors, collections, and generated
WebView service dispatch compose in one Z program rather than isolated probes.

That revision closed three compiler gaps instead of encoding application
workarounds. The fixed-point numeric emitter now covers the complete integral
conversion matrix with explicit signed/unsigned bounds; contextually typed
generic enum construction survives conditional branches such as nullable text
lifting into `Option<String>`; and the foreign producer retains explicitly
typedef-cast integer sentinels for checked `fixed` facts. Consequently
`SQLITE_TRANSIENT` is validated as the exact destructor callback type and
inserted directly into `sqlite3_bind_text`, so SQLite copies the borrowed Z
string bytes before the call returns. No C shim or falsely call-scoped null
destructor contract is involved. Throwing class constructors remain outside
the current fixed-point tier, so the private nonthrowing `NoteDatabase`
constructor is intentionally fronted by a throwing static `open` factory.

## Zapp native-authority migration

Comparing Zapp's Objective-C host with its Z macOS runtime exposed an
architectural duplication rather than a missing framework feature: both sides
owned window registries, lifecycle state, injection policy, URL routing, and
serialization. The migration rule is now to freeze the Objective-C host and
close upstream Z gaps before adding more native policy there. Z should become
the sole authority; Objective-C should remain generated adapter code or tiny
ABI glue.

The first closed gap is protocol-existential callback dispatch. WebKit passes
custom-scheme tasks as `id<WKURLSchemeTask>`. Z now preserves that as the
nominal borrowed type `WebKit.WKURLSchemeTask`, provides checked method
dispatch plus hover/completion, emits the original object reference directly,
and rejects storage or suspension. This removes one concrete reason for custom
scheme policy to remain in handwritten Objective-C.

The next gap closed immediately afterward: protocol callbacks may receive
Objective-C blocks as typed `in` Z function values. A generated ARC box copies
the native block and participates in the normal function-value retain/release
path, so a callback can invoke it synchronously or deliberately preserve it
without dangling. A native runtime fixture returns from the Objective-C
callback before invoking the Z-stored function, proving the owned escape rather
than only compiling the bridge.

The copying byte-data boundary is closed as well.
`Foundation.NSData.copy(bytes)` accepts `Slice<u8>`-compatible stored bytes,
projects an Array without allocating a second temporary buffer, and invokes
`initWithBytes:length:` exactly once. The resulting ARC object owns an
independent native copy while Z retains and later destroys its original
storage. A no-copy consuming transfer remains deliberately separate because it
must prove the native deallocator. Compile-time assets now close the safe
zero-copy case: `embed.bytes("./asset")` emits immutable process-lifetime native
storage and `Foundation.NSData.borrow(asset)` wraps it with `freeWhenDone:NO`.
Ordinary runtime storage is rejected by that bridge, keeping the lifetime proof
visible.

The explicit pool blocker is now closed in Stage 0. `objc.pool` accepts one
synchronous non-escaping closure, returns independently owned values, drains on
typed failure, and lowers to a lexical `@autoreleasepool` without allocating a
pool object. A native fixture observes one autoreleased Objective-C instance
inside the closure and zero immediately afterward on both normal and throwing
paths. Both mechanisms now survive fixed-point lowering. `embed.bytes` is read
while the native frontend resolves module constants and emitted as immutable
static byte storage with checked indexing and zero-copy Slice projection.
`objc.pool` becomes a direct `@autoreleasepool` helper whose captures are
borrowed from the calling frame; typed success and failure values leave only
after the lexical pool has drained, without allocating a closure environment.

Splitting Zapp's macOS runtime into application, window-backend, native-event,
and shared-runtime modules exposed one more fixed-point parity gap. A consumer
that inferred an ARC class from a field of an imported aggregate was required
to import that field type redundantly; otherwise native ownership analysis
mistook the class reference for move-only aggregate storage. Native ownership
and alias analysis now resolve uniquely inferred transitive type identities,
matching Stage 0. A two-module fixture reads the inferred class field, retains
it into a local, mutates it, and compiles the emitted C with the retain visible.
Zapp can therefore modularize without source-only imports or ownership
workarounds.

The first policy extraction from Zapp's handwritten Objective-C host moved
WebKit message-handler registration plus window show, hide, close, and title
mutation into Z. `objc.register` now owns the handler and its deterministic
removal directly; the Objective-C registration-owner class and four forwarding
functions disappeared. The packaged two-window Z Notes smoke test exercises
service errors, success, cancellation, window teardown, and service shutdown
through that Z-owned path.

That extraction also exposed three fixed-point composition boundaries that the
source accepted. Loop binding destructuring remains non-executable, so the
runtime currently names the Map entry before reading `entry.value`. Directly
constructing and returning `Option<NSWindow>` fell back to a tagged C union
containing a strong Objective-C reference, which Clang rejects as non-trivial;
the nullable-import/`Option.fromNullable` niche path remains supported, but the
ordinary `Option.some` path needs representation unification. Finally, an
Objective-C `NSString` argument captured by `objc.register` missed the normal
contextual `String` conversion, requiring an explicitly typed local before the
registration plan. These are compiler pressure targets, not intended Zapp API
patterns. That final `NSRect` constructor shim became the pressure test that
settled Z's numeric-construction rule. Integer/float constructors now preserve
the same mathematical value or trap, `std/math` exposes explicit type-preserving
`math.trunc`, and Zapp can express the geometry conversion without inheriting a
silent C cast.

## Zapp retained protocol-slot pressure

Moving Zapp's WebKit scheme handler out of Objective-C exposed a distinct
interop lifetime that neither weak-property binding nor add/remove registration
described. `WKWebViewConfiguration.setURLSchemeHandler` accepts
`id<WKURLSchemeHandler>` and retains it internally. Passing a Z controller
directly would hide the generated adapter lifetime; keeping that adapter in a
native global would move ownership back out of Z.

The resulting `objc.adapt<P>` slice keeps the choice explicit and compiler
checked. It accepts one stored Z class implementing imported protocol `P`,
allocates one generated Objective-C adapter that retains the controller, and
returns a storable ARC `objc.Adapter<P>` with direct `id<P>` representation.
Both Stage 0 and the fixed-point frontend prove exact protocol compatibility,
including method arguments, and fixed-point lowering emits protocol-qualified
callback values as `id<P>` rather than invalid `P *` spellings. Optional
Objective-C protocol requirements are emitted only when the Z class implements
them.

The conservative first tier keeps adapter construction, use, storage, and
destruction on `thread.main`. This closes the Zapp handler-ownership gap without
claiming arbitrary protocol objects are sendable. It also preserves the four
separate convention-specific tools: `objc.connect` for target/action,
`objc.bind` for zeroing weak properties, `objc.register` for paired add/remove
lifetimes, and `objc.adapt` for retained or stored protocol arguments.

With the handler identity Z-owned, the next extraction moved the complete
embedded-asset request policy into the Z protocol implementation: origin and
path validation, SPA fallback, asset selection, MIME and encoding choice,
`NSURLResponse` construction, typed `NSError` construction, and WebKit
delivery. Generated `embed.StaticBytes` values now form the immutable asset
catalog directly in Z; raw payloads borrow process-lifetime bytes into
`NSData` without copying. Handwritten Objective-C only decompresses Brotli
bytes into an ownership-transferring `NSData`. The packaged two-window Z Notes
smoke test exercises this path end to end.

That migration also closed two native-frontend seams. Objective-C class and
protocol identity is now canonical by Clang runtime name, so `NSString` or
`id<P>` surfaced by independent imported headers remains one nominal native
identity. Null narrowing now flows into the right side of short-circuit
conditions, preserving Objective-C selector evidence rather than accepting a
call that later degrades into invalid C member syntax.

Adjacent pressure remains visible rather than being papered over: fixed-point
loop destructuring still limits some migrations; generic `Option.some` storage
of strong Objective-C references still needs niche-representation unification;
captured `NSString` contextual conversion in `objc.register` and direct
`NSRect` floating-point construction remain open seams. Imported Objective-C
protocol existentials now widen safely to ordinary Objective-C `id` parameters.
Free C functions whose signatures themselves carry Objective-C object or
`id<Protocol>` parameters remain outside the checked header-only function tier;
use an imported Objective-C method or an explicit reviewed contract until that
metadata path preserves ObjC identity.

## Compiler-scale foreign aliases must not multiply Clang work

The modular Zapp macOS runtime imports the same native surfaces from several
small Z modules. Stage 0 correctly gives every source module a private linked
namespace, but the foreign cache originally included that private alias in its
producer identity. A cold editor request consequently produced and decoded the
same Clang AST seventeen times even though only three distinct headers were in
play. Instrumentation attributed 58.78 seconds of a 59.03-second analysis to
foreign resolution; the Z graph and semantic work were not the bottleneck.

The cache now separates native evidence identity from source namespace
identity. It builds one compiler-owned canonical IR per exact header/config/
contract key, then requalifies that checked IR into each module-local alias.
This preserves the existing source spelling and nominal behavior—including
callable and Objective-C protocol types—without rerunning Clang or walking its
AST. The Zapp cold diagnostic probe now completes in 11.28 seconds with no
diagnostics, versus a controlled 51.49-second pre-change sample. A linked
two-module C-enum fixture and the complete native/Objective-C suites guard the
namespace boundary.

The same migration moved frontend origin, development mode, bridge bootstrap,
and ordered CSS/JavaScript injection policy into a generated typed Z module.
Removing the parallel Objective-C tables and readers reduced the native host
archive from 54,544 to 35,640 bytes (34.7%) and the complete packaged smoke
binary by 1,296 bytes. More importantly, one checked Z representation now owns
runtime behavior instead of keeping C and Z configuration in sync.

Constructing the WebKit error in Z exposed two importer gaps rather than
justifying another native bridge. Objective-C lightweight generic arguments
such as `NSDictionary<Key, Value> *` are now deliberately erased while the
nominal `NSDictionary` identity remains, matching their ABI. Objective-C
object-valued globals such as `NSLocalizedDescriptionKey` now survive foreign
normalization with their imported object type and native symbol spelling. A
fixed-point Foundation fixture and the Z Notes smoke test guard both paths.

The exercise also found that the editor's short-lived failed-analysis cache
watched only source text. Creating a missing `.zd`, editing `z.json`, or
changing a local header could therefore leave a stale result for two seconds.
Analysis cache entries now snapshot manifests, generated overlays, source
modules, headers, and both present and absent declaration candidates. The
cache remains useful across diagnostics, hover, completion, and semantic
tokens while external build/interop evidence invalidates it immediately.

Profiling the fixed-point `z metadata` path then found a native-driver version
of the same modularity tax. The staged application contained groups of four to
seven 12–28 MB ZFDCL artifacts with identical producer fingerprints. Although
the adjacent adapter correctly avoided rebuilding their Clang evidence, Z
still read, decoded, allocated, and normalized every copy.
`NativeForeignContractSet` is now immutable ARC identity, and the driver shares
one normalized graph only when both the producer fingerprint and imported
namespace match. Module-local bindings remain distinct while the expensive
evidence owner is retained once.

The exact generated Z Notes metadata workload fell from 38.47 seconds to 11.34
seconds (3.39 times faster) with the same 149,930-byte result shape. The adapter
still validates freshness for every import, preserving transitive-header
invalidation. The remaining 11 seconds and duplicate on-disk artifacts are
useful evidence for a future canonical persistent ZFDCL cache rather than a
reason to weaken correctness today.

## Direct Objective-C completion blocks in the fixed-point compiler

Removing Zapp's `evaluateJavaScript:completionHandler:` wrapper exposed a
fixed-point metadata boundary rather than a reason to keep handwritten
Objective-C. `ZFDCL` version 13 now preserves recursive block-function
signatures, including nullable Objective-C values, and native normalization
requalifies those nested identities for each importing module.

The fixed-point emitter now boxes a captured Z closure once under ARC and
passes it with the exact imported block ABI. The box consumes and releases the
callable environment exactly once. In the opposite direction, a protocol
adapter wraps a received Objective-C block as a typed non-escaping `in`
function value. A freshly bootstrapped fixture executes both directions and
checks nullable completion values; the Z Notes application builds and launches
while calling WebKit's evaluation method directly from Z.

This removes the policy-bearing native wrapper. Zapp retains only a smoke-test
observation hook around that path, which is compiled out of production builds.
The work added no source syntax: ordinary closure ownership, imported
nullability, and protocol receiver capabilities compose at the boundary.

## Readonly Objective-C class properties in the fixed-point compiler

Moving Zapp's application host and run-loop ownership into Z exposed one more
bootstrap-only seam: Stage 0 accepted
`AppKit.NSApplication.sharedApplication`, but native semantic construction
discarded properties whose receiver was a class rather than an instance. The
foreign declaration protocol already retained the distinction, so the fix did
not require a new source feature or metadata version.

The native resolver now keeps representable class properties distinct from
instance fields, checks their executor affinity, and lowers readonly access to
a direct class getter message. The native driver also selects Objective-C when
an imported Objective-C interface is present, covering programs whose only
message send is a property read. A freshly bootstrapped fixture executes a
real `@property(class, readonly)` getter and verifies the emitted
`[NativeOwner currentOwner]` expression.

This lets Zapp keep the `NSApplication` identity, synchronized host result, and
run-loop lifecycle in checked Z. The direct `stop` plus application-defined
event wake now lives in Z as ordinary checked AppKit calls. Writable
class-property assignment remains deferred until a real API requires it.

## Objective-C objects in free C declaration contracts

Removing Zapp's application and WebView smoke bridges exposed a narrower
contract gap: a C test hook accepted `WKWebView *`,
`WKUserContentController *`, `NSString *`, `NSUInteger`, and `BOOL`. Clang had
all of the nominal and scalar evidence, but the fixed `.zd` normalizer treated
the object references as unsupported scalar pointers and omitted target-width
`usize` aliases.

Concrete Objective-C references now cross a free C function boundary as
explicit `in` parameters. Both Stage 0 and the fixed compiler validate the
class identity, nullability, ownership availability, and namespace alias, then
emit the original ARC reference directly. `isize`, `usize`, and canonical
`boolean` also remain source-nameable through the contract. No raw pointer type,
wrapper allocation, or new source syntax was introduced.

With build-time smoke selection replacing the runtime environment probe, Zapp
deleted `application-host.m` and `webview-bridge.m`. The byte-level compressed
asset bridge was the next production seam; the desktop smoke harness remains
test-only.

## Named raw bodies through the fixed-point compiler

Removing Zapp's final production Objective-C asset bridge exposed a real
composition gap rather than a reason to retain handwritten native source. The
macOS backend could express Brotli decompression as one private, typed
`raw objc` function, but the fixed-point parser previously accepted that
syntax and discarded its opaque body. Native emission consequently produced an
empty function. It also omitted `compression.h` because no ordinary checked Z
call referenced the import.

The native parser now retains the raw language, source text, and source
location; lowering carries those facts without interpreting them; and the C
emitter writes the body verbatim behind a source-mapped function boundary. A
module containing a named raw body also retains every explicitly imported C,
C++, or Objective-C header for that translation unit. This does not make the
body safe Z—the native compiler remains responsible for its contents—but it
keeps the escape hatch usable through fixed-point compilation rather than
silently changing behavior.

Zapp now performs the same one-allocation Brotli decode in that private Z
module and transfers the buffer directly into `NSData` ownership. Production
desktop builds contain no tracked handwritten `.m` or umbrella `.h`; only the
conditionally compiled smoke harness remains native test support. A focused
fixed-point regression rejects empty-stub emission, and the complete Z Notes
smoke exercises the imported header, raw Objective-C body, WebKit response,
and deterministic shutdown end to end.

## Owned generated-service requests and errors across placement

Turning Z Notes' generated `notes.create` route into a genuinely suspending
main-executor method combined four previously separate shapes: JSON decoding
into an owned request struct, transfer of that request into a child method,
`attempt await on thread.main`, and serialization of an owned typed error after
the parent resumes. Stage 0 already executed the source, while the fixed-point
preflight only admitted the equivalent placed free-function local.

The native lowerability and frame tiers now recognize the resolved async method
call without inventing a wrapper function. The parent frame transfers the
request exactly once, retains the child invocation through placement, takes the
complete `Result<T, E>`, and resumes into an ordinary consuming match. A local
created inside that post-suspension match arm also receives lexical cleanup;
this application probe caught both its missing declaration and its initially
missing destructor. Unused aliases restored from async-frame parameters are
marked at the generated C boundary, so strict `-Werror` builds do not require
artificial source uses.

The Zapp smoke now exercises the unchanged TypeScript call through generated
request decoding, the delayed main-isolated Z service, structured
`NoteCreationError` details, successful note creation, cancellation, window
teardown, and service shutdown. This closes a composition restriction without
new Z syntax or framework-facing transport types.

## Optional service fields and already-optional transfer

Extending Zapp's generated service boundary from arrays and nominal structs to
`Option<T>` exposed one fixed-point lowering discrepancy. Z had already
defined `field?: T` as `Option<T>` storage that accepts either a direct payload
or an already-computed option. The native lowerer correctly recognized a plain
`Option<T>` initializer but treated `move option` as a payload and attempted to
construct `Option<Option<T>>` in emitted C.

Capability wrappers now preserve the operand's already-optional identity during
optional-field construction. This is compiler analysis only: no new source
syntax, allocation, tag, or runtime check was added. Direct `T` still lifts to
`some`, omission still becomes `none`, and `move Option<T>` transfers its
existing representation exactly once.

The Z Notes service now proves the broader composition end to end. JavaScript
omits `CreateNoteInput.subtitle`; generated Z decoding produces `Option.none`;
the option transfers through the application model; generated response encoding
emits canonical JSON `null`; and TypeScript sees `string | null`. Explicit
`Option<T>` service parameters and results use the same recursive codec rule,
while `field: Option<T>` remains required and `field?: T` additionally accepts
an omitted input property.

## Bounded channel ownership across async backpressure

The first channel pressure test deliberately used an owned `Job` struct with a
`String` field rather than a scalar. One producer moved two jobs through a
capacity-one channel while the second send suspended; the consumer received
both, joined the producer, and observed `none` only after explicit close and
buffer drain.

That composition exposed two async-lowering defects hidden by the scalar
foundation. Cleanup for generic `ChannelClosed<Job>` emitted the compiler's raw
generic identity instead of its encoded C symbol, and the intrinsic send frame
cleared `live_value_value` rather than the parameter's actual `live_value`
guard. Both would have either failed strict C compilation or compromised
exactly-once message cleanup. The fixes use the same canonical symbol encoder
and frame-field helpers as ordinary async aggregates; no new source syntax or
channel-specific ownership exception was added.

The resulting evidence is stronger than an integer queue: a cleanup-bearing
message transfers once into a suspended send frame, once into channel storage,
and once into the receiving `Option<Job>`. Cancellation or closure keeps the
same proof, with `ChannelClosed<Job>.value` recovering an unsent owner. The
realistic example remains unchanged at capacity one, so it continuously tests
actual backpressure rather than only the immediate-send path.

## Configured application workers through an engine-neutral lifetime

Zapp's first configured application worker combined embedded module bytes,
generated cross-module metadata, a dedicated ZJS thread, cooperative
cancellation, deterministic join, and application/service teardown ordering.
Two fixed-point limits became visible before that complete shape could remain
entirely in Z:

- an imported aggregate containing generic `Sender<T>` / `Receiver<T>`
  endpoints does not yet have a complete native storage representation; and
- an ownership-bearing `Task<T, E>` returned by `thread.spawn` cannot yet be
  stored and awaited by the generated application supervisor in every native
  frame context.

The first production tier therefore keeps the safety boundary narrow instead
of weakening either rule. Z owns an ARC `ApplicationWorkerControl`, stores one
opaque native identity, requests cancellation, joins every worker before
service shutdown, and destroys the identity from `deinit`. The engine adapter
implements a small cancel/join/destroy vtable and owns the OS thread plus ZJS
context. Embedded `StaticBytes` remain process-lifetime immutable storage and
cross into `NSData` without copying.

This probe also found two general native-emission gaps that are now closed.
An imported value struct field spelled `embed.StaticBytes` or `StaticBytes`
retains its nominal static-byte representation through module lowering, and
ordinary non-exported Z functions receive translation-unit-local linkage.
The latter prevents a private Z helper such as `advance` from colliding with a
same-named symbol in an embedded native library.

The engine-neutral control ABI is an implementation seam, not a new source
language feature or permission escape hatch. The desired follow-up is to move
the supervisor back into ordinary Z once generic channel endpoint storage and
ownership-bearing native thread-task joins compose in the fixed-point backend.
The separate ZJS worker-host probe continues to exercise typed bidirectional
channels and direct Z service calls, so that future replacement has executable
behavioral evidence rather than only a design sketch.

## Worker message events and closure-local temporaries

Zapp's public application-worker message stream carries three owned `String`
values from an arbitrary native engine thread, schedules delivery on the main
executor, and publishes one immutable value through a retained generic event
handler. Writing the natural expression-bodied subscriber exposed a native
emission scope defect:

```zs
worker.messages.subscribe(
  move (in message): void => console.log(
    `worker message ${message.channel}: ${message.payload}`
  )
);
```

The interpolation's borrowed `String` temporary was being initialized in the
enclosing function even though it referenced the closure parameter. The
generated helper consequently used one undeclared parameter and the outer
function emitted a duplicate cleanup. Expression-bodied closure helpers now
initialize and destroy their own borrowed temporaries, and outer temporary
walks stop at closure boundaries. No block-bodied workaround or source-level
restriction was added. A focused emitted-C execution test retains this exact
shape, while Z Notes proves it through a real foreign-thread ZJS callback.

## Note snapshots across locks and executor isolation

Making the Z Notes application worker index real stored notes exposed two
adjacent `Mutex.withLock` composition boundaries. The native preflight already
rejects returning cleanup-bearing lock results, so this direct snapshot is not
yet executable:

```zs
return state.withLock((in value): Array<Note> => copy value.notes);
```

The attempted allocation-outside-the-lock form then uncovered a native-emitter
bug rather than a semantic rejection. An outer mutable `Array<Note>` captured
by the lock closure was emitted as a pointer-to-const, and a `for...of` nested
inside that closure was also misclassified as a free capture. Stage 0 and the
native checker accepted the source, but strict generated-C compilation failed.
This remains a compiler gap to close; application code should not depend on the
accepted check alone for that shape.

The grounded application solution was simpler. `NotesCore` keeps its genuinely
cross-thread counter behind `Mutex<T>`, while `NotesService` owns a mutable
`NotesCatalog on thread.main`. Service creation, mutation, snapshot copying,
and generated worker dispatch already carry main-executor proof, so the catalog
needs no redundant lock. The worker receives an owned `Array<Note>` through the
generated service boundary, processes it on its dedicated engine thread, and
publishes progress to both native Z and authorized WebViews.

This pressure test reinforces an important design rule: use executor isolation
for state whose operations are naturally confined to one executor, and reach
for `Mutex<T>` only when the state must be shared concurrently. The compiler
still needs complete cleanup-bearing lock results and correct `inout`/nested-loop
capture lowering, because general synchronized snapshots remain a legitimate
systems-programming shape.

## Task controls in synchronized request registries

Zapp's application-worker service cancellation registry needs to retain one
optional `TaskControl` for each in-flight request. A mutable ARC request record
correctly failed `thread.any` transfer: putting a mutable class inside a Mutex
does not make unsynchronized mutation through another alias safe. The
application now stores deeply readonly ARC request records and replaces an
entry under `Mutex.withLock` when its control changes. Cancellation may then
read the immutable record from any worker while the map remains synchronized.

An intermediate value-struct version exposed a separate native ownership bug.
Stage 0 already treated both operations below as transfers:

```zs
const found = requests.remove(requestId);
match (found) {
  some(value) => {
    let request = value;
    requests.set(requestId, request);
  }
  none => {}
}
```

When `request` contained `Option<TaskControl>`, the fixed-point emitter moved
neither identifier at the collection boundary and later destroyed storage that
the Map now owned. Native collection lowering now applies the ordinary owned
storage rule to `Map.set` and `Set.add`: cleanup-free values remain direct,
single-owner aggregates move, and shared ARC identities retain. A strict-C
execution fixture requires the match-payload and Map-argument live flags to be
cleared exactly once. Task runtime discovery also walks lowered collection,
function, and enum payload declarations, so a nested `TaskControl` emits the
runtime definitions its generated cleanup calls require.

## Stable application identity across an async run loop

Converting Zapp's public application root from a consumed value struct into a
readonly ARC class exposed two native-compiler composition gaps. First,
compiler-neutral program metadata recorded public function and method calls but
could not recover arguments from an explicit `new Application()` constructor
resolution. Stage 0 and the fixed-point frontend now both treat call and `new`
expressions as callable metadata sources while preserving their different child
layouts. A fixed-point parity fixture proves the same constructor target and
literal arguments in both compilers.

Second, the natural application implementation retained a local named `state`
across its final await. The native async frame also called its internal resume
program counter `state`, producing a duplicate C member and a macro that rewrote
the compiler's own field accesses. Generated frames now use the structurally
reserved `_z_resume_state` member. An executable regression keeps a
cleanup-bearing ARC local named `state` alive across child suspension, proving
that ordinary source vocabulary cannot collide with this control field.

The resulting Zapp root publishes the same ARC `Application` through
`Once<Application>` for the complete run-loop interval, retains its managers,
and uses a deterministic run guard to reach `stopped` on both success and typed
failure. This is evidence that process-wide identity, main-executor lifecycle,
and async cleanup compose without adding a new language capability or forcing
an unsafe global.

## Observable one-time-root lifecycle without weakened invariants

Zapp then needed to distinguish a second process-wide `Application` from a
same-instance rerun before entering `Once.initialize()`. Turning `initialize`
into a conditional operation would have weakened the deliberately strict root
invariant, while relying on its runtime trap prevented Zapp from returning its
own typed `ApplicationStateError`.

`std/sync` now exports the payload-free `OnceState` enum and synchronized
`Once<T>.state()`. Stage 0 and the fixed-point compiler emit the same locked
byte read and exhaustive enum value; the API adds no allocation, retain, or ARC
identity. Editor hover and completion expose the three states and describe the
result as a snapshot. Zapp may safely translate this snapshot before
initialization because the entire application publication and cleanup sequence
is serialized on `thread.main`. General concurrent code must not treat it as an
atomic check-then-act operation; `initialize()` and `get()` retain their strict
traps if the state changes or is otherwise invalid.

## Typed validation before an async tail suspension

Zapp uses that synchronized snapshot from a synchronous throwing helper before
its async application run loop performs a final dynamic await:

```zs
const runLifetime = ApplicationRunLifetime({
  runState: applicationState,
  events: this.events,
});
try requireApplicationPublication();
return try await runApplicationPlatform(config, updates);
```

This exposed a fixed-point emitter boundary rather than a language-design gap:
the heap-owned tail-await frame already retained prefix locals, but did not yet
lower a synchronous `try` in that prefix. Native emission now evaluates the
inner `Result` once. Success continues toward the child task; failure transfers
the typed error to the parent task, skips the tail await, and destroys live
locals, stored parameters, and match payloads exactly once. An executable
regression keeps a cleanup-bearing run lifetime live across this branch, so the
proof covers both typed propagation and deterministic rollback.

## Immutable application-context snapshots expose aggregate-copy ergonomics

Zapp's readonly `ApplicationContext` combines owned strings, nested readonly
structs, and a `readonly Array<String>`. The intended source operation—an
explicit owned snapshot of that complete aggregate—is accepted by Stage 0's
semantic model, but whole-aggregate and readonly-array `copy` are not yet
executable in the fixed-point compiler. Borrowing the nested array identity out
of a shared ARC application class is correctly rejected; that rule prevents a
borrowed collection alias from escaping shared storage.

The current framework preserves the rule by copying each string element with
`copyBytes`, freezing a fresh array, and rebuilding the small value structs.
This is safe and allocation-honest, but unnecessarily verbose compiler-facing
code. A future native-copy slice should make `copy context` lower recursively
through readonly arrays and cleanup-bearing value structs, with the same
per-field semantics already used by Stage 0. Zapp is the regression target:
the concise aggregate copy must produce an independent argument snapshot while
leaving the shared application context intact.

## Persistent CRUD composed imported options, copy spread, and placed errors

Adding edit, archive, and delete to Zapp's application-owned SQLite notes
service combined several individually-supported features in one ordinary
application path. The source uses an imported cleanup-bearing `Note`, returns
`Option<Note>` from a class method, copies a note with an optional `String`
field through `copy ...existing`, translates SQLite status failures into a
typed `NoteMutationError`, and taskifies the main-isolated method for WebView
delivery.

That composition exposed four fixed-point implementation gaps rather than new
language rules:

- contextual return lowering consulted only top-level functions, so
  `Option.none` in a class method could survive into generated C as the source
  spelling; return-type lookup now covers methods through the same nominal
  owner helper;
- copy spread deep-copied `String` fields but not cleanup-bearing aggregate and
  enum fields such as `Option<String>`; it now calls the existing specialized
  copy helper for every supported cleanup-bearing value field;
- executor-placement rewriting unwrapped `try` but not `attempt`, so
  `attempt await on thread.main ...` could index the wrapper as if it were the
  placement expression; both error operators now preserve the same placed
  call shape;
- a successful local `try` binding named `id` was declared with its escaped C
  name but assigned with its raw source name; try emission now uses the
  canonical binding-name emitter at both sites.

Executable regressions cover an imported `Option<Note>.none`, copied optional
owned storage, a synchronous throwing main-isolated call materialized through
`attempt await`, and a C-reserved `id` success binding. The unchanged Zapp
source then builds and runs its generated service bridge. This is useful
evidence that Z's explicit ownership vocabulary remains stable while the
compiler grows more compositional beneath it.

## Populated Array temporaries now have a bounded borrow owner

The Z Notes transfer-codec regression naturally wanted to write an owned
collection directly at a read-only call boundary:

```z
const encoded = encodeNotesDocument(Array<Note>(note));
```

Stage 0 already had the statement-lowering machinery needed to materialize a
cleanup-bearing call argument, but semantic analysis rejected the dynamic
Array shape. The native frontend accepted it and emitted `&(rvalue)`, leaving
Clang to report an invalid address-of operation. Both outcomes exposed one
parity and composition gap rather than a need for new ownership syntax.

Both frontends now create one hidden Array owner before a synchronous `in`
call, borrow that stable storage for the call, secure the result, and destroy
the Array immediately afterward. A strict-C executable regression proves the
allocation is reclaimed once and the callee cannot retain the pointer. Other
cleanup-bearing temporary types stay conservative until each lowering shape
has equivalent exact-once cleanup evidence.

## Direct-awaited borrowed temporaries became compiler-owned frame storage

Z Notes later exposed the suspension counterpart while passing fresh
`OpenDialogOptions` and `SaveDialogOptions` values to directly awaited
operations. Requiring a user-authored local solely to give the temporary an
address would have been a framework workaround, not an ownership rule worth
teaching.

For a sequential direct await, both frontends now synthesize an owner slot in
the parent task frame. The aggregate is initialized before the child starts,
borrowed at a stable address through suspension, and destroyed exactly once
after child teardown. Cancellation and unfinished-frame destruction follow the
same live-state cleanup path. An executable regression uses a cleanup-bearing
`String` field and proves that its destructor runs once.

This does not weaken concurrent borrowing. A hot child created with `task` can
outlive the expression that starts it, so its borrowed argument still requires
named storage inside an explicit `async scope`. The distinction follows the
actual lifetime shape rather than adding source syntax.

## Objective-C identity now composes through native results and collections

The Zapp menu backend combined several individually supported features in one
ordinary path: a synchronous throwing Z closure imported through a callable
alias, an `objc.connect` target/action token returned through `Result`, and an
`Array<objc.Connection>` that owns every installed action. The fixed-point
frontend exposed four composition gaps rather than a need for framework-local
storage or callback shims.

Native lowering now preserves `.zd` type affinity, resolves callable aliases
through package re-exports, gives synchronous throwing closures their own
local result context, and represents Objective-C identity explicitly inside
tagged Z enums. Consuming `try` and `match` transfer that retained payload once;
copy and destruction retain or release it once. Dynamic arrays of Objective-C
identity use ARC-qualified slots, strong element assignment, and ARC-aware
growth and teardown instead of byte copying or `realloc`.

A fixed-point Objective-C regression returns an imported ARC object through a
throwing function, extracts it with `try`, stores two objects in a dynamic
Array, reads one, and destroys the collection. The real Z Notes application
then builds and runs its generated service graph and AppKit menu unchanged.
This is executable evidence for a central Z goal: safe interop abstractions
should keep composing like ordinary Z ownership, without asking applications
to drop into Objective-C or hand-maintain retain/release calls.

The standalone menu test also placed an escaping closure inside the subject of
a value-producing `match`. Native lowering previously completed block closures
only along ordinary expression-statement paths, so the still-raw statement
indices were later mistaken for lowered match-arm indices. Match lowering now
completes its subject before lowering any arm; a fixed-point regression keeps
an early-return failure arm beside the captured callback so this ordering bug
cannot return.

## Chained collection results retain their inferred native type

The Zapp frontend-menu bridge looked up commands through application-owned
state with `menu.state.frontendCommands.get(id)`. Stage 0 inferred the local as
`Option<Command>`, but fixed-point lowering only recovered collection method
signatures when the receiver was a direct binding. A chained field receiver
therefore failed later with an internal missing-local-type diagnostic.

Native lowering now retains transitively referenced implementation-type
evidence, resolves the receiver recursively, and normalizes canonical lowered
collection identities through the same intrinsic model used for source-shaped
types. Inferred types that cannot be named directly by the consuming source now
carry a compiler-only module-qualified nominal identity, so another field or
method access cannot accidentally lose the originating type or conflate it with
a same-named declaration. Returning an ARC class alias from a borrowed
`Option<T>` payload also retains that identity before the temporary enum owner
is destroyed.

An executable fixed-point regression reads a readonly `Map<String, Item>`
through an exported ARC manager, its module-private state class, and a
transitively imported item class. It matches the retained `Option<Item>`, calls
an internal immutable method through both statement and value-producing match
arms, returns one borrowed payload as a new owned alias, and verifies the
generated retain before compiling and running the C. This is important
composition evidence: application architecture should be free to hide storage
behind managers without forcing redundant type annotations or public
implementation types to compensate for compiler internals.

## Real application builds exposed quadratic imported-type lowering

The generated Z Notes native core made a compiler cost visible that small
language fixtures did not: lowering repeatedly scanned broad imported-type,
visible-type, alias, and hidden-identity collections. The application combines
AppKit, WebKit, generated service dispatch, JSON, async work, and Zapp's manager
graph, so those linear scans multiplied into a 179-second release build and
roughly 2.03 trillion retired instructions.

Native lowering now builds indexed type-identity sets and maps once at the
relevant graph boundaries. The same cold build takes about 57.90 seconds and
525 billion instructions. An early project-build cache implemented through Z's
own filesystem, hashing, process, and move-only lock primitives initially
reduced an unchanged build to about 0.29 seconds. The cache tracks reachable Z
inputs and Clang-produced transitive header/`.zd` dependency sidecars, so
convenience does not weaken native dependency correctness.

A second application profile moved foreign-name discovery to contract-local
indices, decodes compiler-hidden identities directly, shares imported evidence
across generic specializations owned by the same module, and retains hidden
lowering aliases only when checked binding, expression, or call evidence can
observe them. The final cold build takes about 35.80 seconds, retires roughly
310 billion instructions, and reports a 3.27 GB peak footprint. The unchanged
cache path takes about 0.22 seconds and 12.5 MB. Its input schema now also
requires the active compiler path and digest, preventing a live but different
compiler binary from authorizing stale generated C.

The pressure test also records the remaining limitation honestly: changing one
source module still performs a full build. A follow-up profile found that fresh
foreign adapter output was not the same thing as cheap native consumption:
normalization still performed graph-wide linear searches for every foreign value
type. Building exact raw declaration indices during decoding reduced the same
cold release build from 35.80 seconds to 19.62 seconds, from roughly 310 billion
to 89.1 billion retired instructions, and from about 3.27 GB to 1.78 GB peak
memory. Foreign project loading fell from 11.15 to 0.47 seconds of sampled
compiler CPU without weakening `.zd` validation or alias identity.

Z Notes now points directly at the next compiler architecture work—sharing the
remaining imported-type context directly through lowering and splitting the
monolithic generated C translation unit into independently compilable
artifacts. Persisting parsed ASTs first would target only about one second of the
measured build and would add a large invalidation surface before addressing the
dominant costs.

## Recursive typed JSON stays streaming and ownership-safe

Zapp's application-menu bridge needs a recursive wire shape: a menu owns an
array of items, and each item may own another array of items. The original
derived `json.decode<T>` tier stopped at `Array<String>`, which made this a
general language composition boundary rather than a framework concern.

Stage 0 and the fixed-point compiler now generate one typed object decoder for
every reachable value struct, declare those helpers before their definitions,
and stream nested objects and `Array<Struct>` elements directly into their
final Z storage. Self-recursive arrays therefore work without a dynamic JSON
tree or framework-local flattening. Defaults remain fresh per decoded value;
missing and duplicate fields retain their precise diagnostics; and every
partially constructed nested value is destroyed on failure. An executable
menu-shaped fixture covers nested success, recursive defaults, malformed child
objects, and non-array input in both compiler generations.

## Native notification APIs require ARC task results, not callback plumbing

Zapp's first application-notification manager exposed a useful async interop
boundary. Apple's `UNUserNotificationCenter` reports its settings through an
exactly-once arbitrary-thread completion block whose success value is a
non-null Objective-C object. The `.zd` async projection previously accepted
only cleanup-free scalars, which would have forced framework code to rebuild
the callback as a channel or blocking semaphore even though Z already knew the
callback's cardinality, thread behavior, and object ownership.

The async projection now retains one non-null Objective-C completion object in
the generated task frame and transfers that ARC identity to the awaiting Z
owner. Frame cancellation and destruction release the object on the same
managed path as other Objective-C async locals. Nullable object results remain
deferred until the projection can represent absence explicitly rather than
silently asserting non-nullness.

The same application found a separate nominal-identity seam: an imported
Objective-C flag enum carried through a private dependency module is encoded by
the linker under a compiler-hidden module identity. Async lowering now resolves
that identity back to its foreign declaration before selecting frame storage,
zero values, cleanup, and C spelling. This keeps a package's internal native
types private without making an application-level async call lose their ABI.

Together these changes let the notification backend remain ordinary Z:
`await` the native completion, inspect the returned settings object, and map
native denial to a Z enum while reserving `throw` for operational failures. No
framework-local global buffer, polling loop, semaphore, or detached callback
state is required.

Storing those backend operations exposed one more fixed-point composition seam.
The framework intentionally erases each throwing native operation behind an
infallible async callable that returns `Result<T, NotificationError>`; its
expression body is simply `attempt await operation()`. Native closure lowering
previously recognized the awaited child but rejected the surrounding `attempt`.
The callable frame now transfers the child's existing Result storage directly,
including its owned error, while cancellation still unwinds through the child
frame. This adds no wrapper allocation and avoids both a nested Result and a
framework-local status convention. Suspended `try await` propagation remains
explicitly rejected until the stored callable can expose a true throwing ABI.

Running that manager inside the complete Z Notes application then exposed four
fixed-point code-generation seams that isolated fixtures had not combined. The
native `.zd` reader now carries both shorthand `async completion;` and named
`async completion(value, error) { ... }` projections into semantic evidence;
direct Objective-C messages synthesize heap-owned task frames rather than
falling back to handwritten callbacks. Objective-C receiver spellings are
normalized to pointer ABI types, and ARC object results leave type-erased task
storage through an ARC-aware strong store. A raw `memcpy` initially appeared to
avoid an illegal ARC pointer-to-pointer conversion, but it bypassed the retain
on the awaiting frame's destination: the callback temporary was released and
left a dangling object that crashed on its first message. Generated async frame
cleanup now clears every Objective-C local with the same strong-store primitive,
so completion, cancellation, and destruction each preserve exactly one ARC
ownership transition. The executable Z Notes smoke checks notification status
in two windows to keep that real callback path under regression coverage.

Suspended Z locals no longer become source-named C preprocessor macros. A local
named `response`, for example, previously rewrote an unrelated `.response`
field token throughout generated C. Frame storage now uses compiler-private
binding aliases consistently in polling, cancellation, match-payload cleanup,
and destroy paths. An executable regression keeps a `title` local alive across
an await while reading `request.title`, proving that ordinary Z names and field
names remain independent after lowering. Finally, a throwing async `main`
retains its typed `Result` in an internal entry and exposes the required C
`int main` wrapper, destroying either payload exactly once. The complete Z
Notes smoke now reaches native notification status, permission, and delivery
routes without global callback storage or a blocking semaphore.

## A framework teardown path exposed a native collection parity hole

Zapp's application-owned filesystem authority needed to revoke every granted
path when the application stopped. The natural spelling was
`this.grants.clear()`. Stage 0 rejected that absent API, while the native
frontend accepted the member call without a collection signature and emitted
literal `self->grants.clear()` into C. The generated translation unit then
failed in Clang, far past the semantic boundary where Z should have resolved or
rejected the operation.

`Array<T>.clear()` is now a first-class operation in both frontends. It destroys
all live elements immediately in reverse order, sets length to zero, retains
the backing capacity, and conservatively preserves established same-Arena
provenance just like `Map.clear()` and `Set.clear()`. The unified mutation rules
reject clearing immutable, frozen, actively viewed, or iterated storage. Native lowering records a
dedicated `arrayClear` expression rather than letting a recognized intrinsic
fall through to ordinary member emission. A fixed-point executable fixture
keeps semantic acceptance, cleanup-aware C emission, retained capacity, and
reuse under regression coverage.

The broader lesson is that native semantic evidence must be authoritative for
every accepted intrinsic member. An absent intrinsic signature must never be
allowed to survive as a source-language-looking member call in generated C.

## Secondary launch snapshots: readonly collections and derived JSON

Zapp's second-instance event is an immutable value snapshot: a readonly Array
of argument Strings and an optional owned working directory, nested inside a
versioned launch envelope. It exposed two independent composition gaps.

- Native `for of` inference did not strip the readonly collection qualifier,
  losing the loop element type and then failing explicit `copy` inside the
  loop. Indexed String copies from readonly fields had the same qualifier
  mismatch. Collection mutability is a capability, not a different element
  layout; semantic evidence and lowering now agree on that distinction.
- Derived JSON decoding already handled nested value structs, but encoding
  rejected those same values. Readonly-only arrays also missed their decoder
  allocation helpers. Both compiler paths now traverse the reachable codec
  graph, build collection storage during decoding, and encode nested values
  directly into one output buffer while borrowing the original owners.

The fixtures `self-host-emit-readonly-field-iteration.zs` and
`std-json-nested-encode.zs` cover readonly Array/Map iteration, explicit String
snapshots, recursive readonly trees, exact round trips, and use after encoding.
The public event must not be flattened merely to satisfy the compiler. Derived
JSON now supports `Option<T>` fields around the supported payload types: null
is none, non-null is some, and omission requires an explicit default. Decoding
releases a cleanup-bearing default before replacing it; malformed payloads and
later field failures destroy partial owned data. Encoding borrows the payload
and adds only the tag branch. Nested Options remain rejected because null
cannot distinguish none from some(none).

`std-json-option.zs` covers exact-width integers, readonly arrays, nested owned
structs, default replacement, required keys, duplicates, and malformed partial
payloads through both compilers. It also exposed generic inference losing a
match-arm binding's type after selection. Arm-result inference now uses the
same lexical payload environment as the arm body; the dedicated
`self-host-emit-match-generic-inference.zs` fixture checks shadowing too.
Native match lowering also resolves transparent local aliases before selecting
the intrinsic enum layout, so `type Name = Option<String>` works in the same
codec and match paths as its target.

The unsupported-codec diagnostic path exposed a native cleanup defect:
`match (try operation())` hoists the owned success value, but cleanup planning
had not recognized its transfer into the consuming match. An early throw then
destroyed both the selected payload and the already-consumed temporary. The
handoff now applies to statement, returned, and local-value matches, while
earlier try failures retain their own cleanup obligations. The differential
fixture `self-host-emit-try-match-cleanup.zs` checks exact destruction counts on
fallthrough, return, and throw, with stored borrowing as a non-consuming control.
It also verifies that a local initialized through a hoisted try retains its
own cleanup registration after the normalization block, including a resource
constructed from a throwing field expression.
That control uncovered a separate Stage 0 name-shadowing defect: early-exit
cleanup of an outer owner could resolve through its same-named arm payload,
and inner payloads inherited the outer ownership flag. Match generation now
captures the outer cleanup storage before entering an arm and gives pattern
bindings independent flags and parameter modes. The same fixture checks
borrowed statement/value matches and an owned payload selected past a shadowed
outer resource, including exact destruction of both owners.

The codec probe also exposed a backend hygiene gap: ordinary Z fields named
`signed` or `unsigned` were emitted as C keywords. Both emitters now select
compiler-reserved storage names without changing source names or JSON keys.
The same mapping covers declarations, construction, copy/spread, field access,
destructuring, cleanup, and the async-frame emitter. Implicit class-constructor
parameters use their own generated namespace, avoiding collisions between
`signed`, `z_signed`, and the constructor's `self` local. This adds no runtime
work or storage, and requires no new source syntax.

Imported native fields retain their exact ABI spelling; explicit `export c`
layouts retain their existing public-identifier validation. The differential
`self-host-emit-field-hygiene.zs` probe checks exact JSON output, defaults,
Option payloads, owned copies, class identity, and valid public C fields.
`field-hygiene-async.zs` covers suspension and generator/loop destructuring;
`field-hygiene-foreign.zs` uses a real C field named `template`, which must not
be renamed just because it is reserved in C++. This is a compiler fix, not a
Zapp-specific codec rule. The checkpoint is limited to aggregate fields, not
a claim that every local, enum payload, or foreign macro naming shape has
received the same audit.

Cross-process arbitration and transport remain Zapp work after this codec and
hygiene checkpoint.

## Zapp primary-instance lease: borrowed native fields during cleanup

The private macOS primary lease stores an `NSFileHandle` in a move-only Z
struct. Its `deinit` passes `in this.file` to a narrow raw Objective-C close
function. Stage 0 accepted that source but emitted `NSFileHandle **` for an
`NSFileHandle *` parameter: projected capability arguments bypassed the
reference-versus-value ABI distinction used for direct bindings. Codegen now
uses that same distinction for stored field paths. The native checker also
stops treating an immutable imported Objective-C reference as a hidden Z class
identity; the Z-class and writable-projection restrictions remain unchanged.

Returning the lease as `Option<Resource>` through a throwing function then
exposed a native-emitter layout mismatch: a C union cannot contain an aggregate
with strong Objective-C fields under ARC. The native emitter now uses separate
payload slots for that recursive by-value shape, as Stage 0 already does.
Ordinary Z-only enums retain union storage; direct Objective-C enum payloads
keep their existing explicit-owner representation. This adds no heap box, but
multiple payload slots can occupy more space than a union. Pointer-like class
identity and niche view options do not trigger recursive layout expansion.

`objc-projected-borrow.zs` covers a local field, a nested field through an `in`
owner, destructor cleanup, scalar `in`/`inout` address controls, and nested
Option/Result success, absence, and error paths with exact cleanup output. The Zapp
multi-process regression then tests the real resource lifetime: same-process
scope release, contention, independent identities, normal exit, process death,
simultaneous launches, and unsafe-path rejection. The lease itself performs no
polling and retains no running thread. Cross-process launch forwarding is still
separate work; acquiring a lease is not delivery of an application event.

Two additional audit leads surfaced while isolating this regression: an
entry-module function named `read` collides with POSIX `read` after importing
Foundation, and native parity checking of an integer `console.log` argument
inside `deinit` reports the String-only import signature. Neither is fixed by
this projected-borrow checkpoint; keep them as focused compiler follow-ups.

## Zapp launch admission: ownership across a scoped lock

Preparing cross-process secondary-launch forwarding exposed two different
boundaries. One synchronized, process-local activation inbox must share the
existing 64-pending-request budget with OS activation; admitting a launch is
not executing its listener. A producer must be able to enqueue owned argument
data, while the main executor takes an independently owned request out and
invokes app code after releasing the mutex.

The result half was already valid Z but rejected by native lowerability. It
now uses the existing scoped helper and cleanup planner for String snapshots,
Array results, ARC identity, and owned Option/Result payloads. The helper's
return type comes from the resolved callback signature, not the success-only
expression evidence under `try`. Callback return/throw lowering carries its
own error context rather than inheriting the enclosing function's effects.
The lock is released before either outcome reaches the caller.

The differential `self-host-emit-mutex-owned-result.zs` fixture tests exact
destruction on transfer, absence, failure, a locally propagated error, and final
Mutex teardown. It also tests ordinary Result-valued callbacks separately from
throwing callbacks, plus a side-effecting void expression body. That last case
caught a Stage-0 bug which discarded the expression while constructing an
empty success Result. Inferred Array results exposed another Stage-0 gap:
codegen guessed `i32` instead of using the checked Mutex call result. Both are
fixed without changing source semantics.

No new wrapper allocation is added to the native scoped-lock call: the helper
returns the owned result by value and the caller owns its existing cleanup.
Explicit String copying and construction of an Array or ARC object still carry
their ordinary allocation costs; this is not a zero-allocation claim for every
callback.

The admission half prompted an explicit design check-in. The agreed rule is
now implemented: `withLock` invokes one synchronous, nonescaping callback, so an
inline `move` closure may consume its owned captures. A unique request moves
from caller to callback to queue; early return or typed failure destroys the
unconsumed request. Shared ARC identity is retained, not uniquely removed from
the caller. This does not add a general consuming function-value type or relax
the restrictions on reusable closures, borrowed captures, views, or suspension.

`self-host-emit-mutex-owned-capture.zs` checks exact destruction across accepted
and rejected admission, early throw, expression-body transfer, returned capture,
and shared ARC capture. Both compilers use stack-local capture storage without
a heap environment. Stage 0 also constructs non-default-constructible move-only
C++ captures directly in that storage. One test caught a compiler bookkeeping
bug: marking the outer capture transferred at its first source occurrence also
marked that occurrence's *read inside the callback* moved, suppressing cleanup
on early failure. The outer transfer and callback-body moves are now separate.

The Zapp threaded inbox test also exposed two existing Stage-0 async composition
gaps: synchronous `try` skipped argument preparation for inline closures, and
executor-release adapters were emitted for executor-bound value structs as if
they were ARC classes. Argument preparation now applies to throwing calls;
release adapters are restricted to classes and use canonical native names.
Scoped lock captures can transfer out of an async frame while the lock callback
itself remains synchronous. Native worker-destructibility evidence now follows
collection elements, aliases, and readonly wrappers inside synchronized state;
it still rejects executor-bound and unproven destruction. The collection-worker
differential fixture exercises a Mutex-backed Map of enum requests containing
readonly String Arrays and optional String data.

Replacing the original queue with the owned inbox also exposed a control-flow
parity bug: `break` in a `match` arm emitted C `break`, exiting only the generated
switch and leaving the enclosing drain loop running. Native loop lowering now
records the actual loop exit target, preserving cleanup before the jump.
`self-host-emit-match-loop-exit.zs` covers while/for exits, nested loops,
continue, and destruction of a live loop-local owner. All runtime probes have
finite watchdogs; the original failing drain was terminated by its watchdog.

The launch-event smoke then caught a second cleanup-scope collision: a borrowing
lock callback moved a callback-local Array out, but the enclosing function's
later move-flag pass erased the callback's live flag. The callback freed the
returned storage before delivery. Callback-local move flags are now protected
regardless of capture mode; the owned-capture differential fixture includes a
borrowing callback with an early-return branch and a moved local result.

## Bounded launch transport: owned resources and result-only bridges

Zapp's private macOS launch transport now consumes the primary-instance lease
into a move-only endpoint. Its `deinit` removes the socket and closes its
descriptor before automatic field cleanup releases the lease. A static factory
initializes the private fields, so application code cannot substitute a socket
or identifier for the lease it owns. Connection owners close on success,
rejection, incomplete frames, and typed failure. Framing, absolute deadlines,
admission into the shared inbox, and acknowledgement interpretation remain Z
code; narrow named raw functions perform OS socket and byte-buffer operations.

This exposed two compiler gaps rather than new ownership rules:

- Stage 0 permitted explicit construction of private struct fields from a free
  function, while the native checker rejected it. Both now require the declaring
  aggregate's access context. Omitted private fields with defaults remain valid;
  a static factory can initialize them explicitly. The destructuring fixture now
  obtains its private value through a legal factory before testing field access.
- A ternary and its condition share a starting source offset. String bridge
  evidence attached to a conditional result was also applied to its boolean
  condition, producing invalid Objective-C. Codegen now suppresses result-only
  bridge evidence while lowering that condition and restores it for the result.
  `objc-conditional-strings.zs` tests both choices, template-valued arms, and
  String/NSString bridging in both directions without a wrapper in source.

The isolated process regression passes through Stage 0 and the native driver,
including UndefinedBehaviorSanitizer builds: bounded/concurrent admission,
fragmented and malformed input, slow-client deadlines, uncertain or invalid
acknowledgements, scope release, process death, and stale-socket recovery.
An acknowledgement proves only admission, not listener completion or durable
delivery. Automatic `app.run()` integration, main-executor drain/wakeup,
startup/shutdown races, sandbox packaging, and other platforms remain separate
work. No new public API, language syntax, or implicit retry policy was added.

## Launch readiness and the next async composition prerequisite

The attempted integration of the launch endpoint into `app.run()` exposed two
independent lowering boundaries. The integration is deliberately not enabled:
the independently tested lease, bounded transport, and inbox do not prove that
the enclosing task cancels and joins correctly.

| Reproduction | Stage 0 | Fixed-point native driver |
| --- | --- | --- |
| `tests/fixtures/async-launch-owned-destructure.zs` | Runs; selected owned fields survive suspension in the task frame | Runs with guarded owned frame fields |
| `tests/fixtures/async-launch-listener.zs` | Runs successfully | Runs through an executor-local resumable loop frame |

The first is the natural error-conversion shape: `const { code, message } =
move error`, followed by a suspension while the selected fields remain live.
The second needs only a counter and `await scheduler.yield()` inside a loop;
it is not specific to Foundation handles or socket ownership. Existing
one-yield-prefix and tail-child helper tiers did not cover it. Both reductions
now have positive native execution evidence and remain in the differential
corpus. This closes the reduced cases, not every composition the real listener
requires; successful native `check` alone still is not execution evidence.

The intended listener must create and destroy its endpoint on its worker,
observe cancellation between deadline-bounded receives, and retain the primary
lease until endpoint cleanup completes. The worker may hold the synchronized
inbox, but main-bound event dispatch remains with the main-owned application
host. Shutdown must close admission and cancel/join the listener before
destroying that host. A synchronous infinite worker that waits for cleanup in
its joining parent would deadlock; moving code into helpers does not solve that
lifetime ordering.

Two independent pieces now have bounded runtime evidence in Zapp: a private
readiness mode retries only transient **pre-send connection** failures within
the original absolute deadline, and the shared inbox coalesces wake reservations
under its mutex. A delayed endpoint succeeds; an elected primary that never
publishes one times out without creating another primary. A lost acknowledgement
never resends a payload. Clearing a wake reservation before draining permits a
concurrent producer to reserve the next wake. The reservation primitive is not
yet wired to main-executor dispatch.

The delayed-readiness test also exposed native conditional type evidence:
`u64(ready ? 250 : 8000)` looked up the boolean condition's type because it
shares a starting offset with the conditional. Sema now records contextual
branch types, and lowering obtains the selected type from those branches.
The executable differential fixture `self-host-emit-conditional-conversion.zs`
covers both choices, nested ternaries, wide integers, floating-point conversions,
and String results. This changes compile-time evidence, not the runtime model.

Continuation order: extend the native loop frame to the actual listener's
parameter/owned native storage and child-await/error composition, preserving
cancellation and endpoint destruction ordering; then restore the listener
integration probe and exercise startup, competing launches, quit, and teardown.
No new source syntax or public Zapp API is required by these prerequisites.

### Stage-0 owned destructuring checkpoint

`tests/fixtures/async-owned-destructure.zs` now exercises the first prerequisite
through the same initializer and cleanup paths as ordinary async locals. An
internal source slot evaluates the producer once, selected fields transfer into
their own guarded frame slots, and unselected fields are destroyed immediately.
Clearing transferred fields and the source live flag prevents duplicate cleanup.
This adds frame storage, not a separate allocation per destructuring operation;
`move` transfers ownership without a deep copy, while explicit `copy` retains
its normal field-copy costs.

The executable evidence includes String/Array/Option copies and moves, retained
class fields, renamed and mutable bindings, awaited producers, an owned field
returned after suspension, scoped borrows joined before destruction, failure
before and after initialization, and cancellation during an awaited initializer
or after its selected fields become live. Observable destructors verify exact
cleanup ordering; the fixture also runs under UndefinedBehaviorSanitizer.

The implementation deliberately preserves ordinary owned-local placement:
cleanup-bearing bindings are supported at the async function root and directly
inside `async scope`, including scopes nested in loops. A bare conditional or
loop-owned local still needs lexical cleanup states; hiding it behind
destructuring must not bypass that restriction. Borrowed views, positional array
patterns, custom-`deinit` value sources, and foreign RAII fields are not newly
admitted. The native checkpoint below closes the two reduced prerequisites,
not all of this broader Stage-0 coverage; the Zapp listener is still not enabled.

### Native executor-local yield-frame checkpoint

The fixed-point emitter now uses one reusable frame implementation per eligible
ordinary function, with direct-callable adapters delegating to the same start
operation. Each invocation owns its own frame.
The initial boundary is a parameterless, non-throwing function returning `void`
or `i32`, without explicit declaration affinity. Its suspension points are
standalone `await scheduler.yield()` statements. Root initialized Z-owned locals
and value-struct patterns survive yields in nested `if`/`while` control flow,
including `break`, `continue`, and early function returns. This uses existing
source syntax and ownership checks; no new capture or lifetime rules are added.

`self-host-emit-async-yield-frame.zs` executes the same branch/loop and ownership
case through Stage 0 and native C. A producer runs once; its unselected ARC field
is destroyed immediately, while selected String and ARC fields remain live.
Transferred fields are cleared without disarming the entire temporary owner.
Guarded reverse cleanup handles normal completion, cancellation before entry,
and cancellation after initialization. C-level invocation tests also check that
destroying a cancelled invocation leaves no queued task; those paths run with
UndefinedBehaviorSanitizer as well as strict ordinary C compilation.

Each invocation allocates one zero-initialized heap frame. A yield stores the
resume state and requeues that same task on that same executor: no new OS thread
or per-yield frame allocation. All admitted locals currently receive frame
slots, including compiler temporaries; liveness-based slot reuse and allocation
elision remain optimization work, not measured wins in this checkpoint.

The initial shared admission rule kept parameters, throwing bodies, child awaits,
placed operations, nested source-local declarations, positional/view patterns,
and native/synchronized storage outside this new tier. The storage check covers
the entire destructuring source, not just selected fields. Existing separately
supported async tiers remain available. The actual launch listener therefore
still needs composition work before `app.run()` can own and cancel/join it.

### Owned inputs to native yield frames

The next slice admits ordinary owned Z-value parameters to the same frame:
scalars, String/Array/Option values, ARC class handles, and supported recursively
owned Z aggregates. They are installed at invocation start, before the first
poll, with live flags already armed. A dropped cold invocation or pre-entry
cancellation therefore destroys its inputs even though no local initializer has
run. After entry, reverse cleanup destroys initialized locals before the
remaining parameters. Moving a parameter into a local or destructuring source
disarms its old slot; selected fields keep their own guards.

`self-host-emit-async-yield-parameters.zs` is in the executable differential
corpus. Its inputs include an owned aggregate containing ARC fields and an
Array<String>, plus scalar limits. It moves selected fields through a yielding
loop and uses names such as `state`, `result`, `task`, `frame`, and `executor`.
Frame binding fields and indexed adapter arguments now keep those source names
separate from internal scheduler state. Tests cover cold drop, pre-entry
cancellation, post-initialization cancellation, and exact destructor ordering,
including UBSan. This adds slots to the existing allocation, not an allocation
per argument or yield.

The ARC alias test exposed an upstream native cleanup omission: ordinary
value-parameter call lowering correctly inserted a retain, but source cleanup
discovery also marked that bare class argument as moved. The caller's final
release was consequently lost. Cleanup discovery now uses class type evidence
(including binding evidence when no per-expression type is present) to preserve
that caller-owned alias. Explicit `move` remains consuming. Regression coverage
compares implicit retain and explicit move with Stage 0, and checks the shared
fix on a synchronous call too. Transparent class aliases are resolved both by
frame admission and by caller cleanup discovery; an alias chain must not turn
an ARC argument into an apparent move.

Borrowed inputs still need parent loan storage/join proof in this loop tier.
Native/synchronized storage was the next prerequisite after this checkpoint;
throwing bodies, child awaits, and declaration placement remain separate
expansions. No automatic launch listener or public Zapp API was enabled.

### Foundation resources and synchronized inboxes in native yield frames

The listener needs two existing ownership mechanisms to compose: its private
Foundation-backed lease/endpoint and an ARC inbox owning Mutex-protected state.
The frame now admits Objective-C interfaces/protocol references (including
nullable references), Mutex, and supported Map storage recursively through Z
aggregates. `readonly` collection qualification does not change owned storage;
checking the actual launch payload exposed and closed that admission omission.
No executor hop, cross-thread transfer permission, or new capture rule follows
from admitting storage to an executor-local frame.

`async-yield-inbox.zs` exercises a readonly ARC inbox, Mutex state, and a Map of
named enum payloads containing readonly Array<String> and Option<String>.
Its caller retains the inbox identity across await. A separate direct Mutex
parameter transfers its handle. Cancellation tests retain a test observer,
verify the payload survives frame destruction until its final owner releases,
and use `pthread_mutex_trylock` to prove the synchronous callback has unlocked
before the frame yields. No lock or `inout` callback loan spans suspension.
Emitting this shape also required early `withLock` helper prototypes; their
definition order must not constrain where an ordinary synchronous call appears.

`async-yield-native-storage.zs` uses real NSFileHandle owners for `/dev/null`.
It combines a nested endpoint/lease, a Mutex inbox, direct native locals,
nullable native parameters, and a plain wrapper with object destructuring.
Unlike a C stack scope, `free(frame)` does not invoke Clang's strong-slot
destructors. Frame cleanup therefore runs guarded Z cleanup and explicitly
clears direct/nested strong slots, including retained aliases in moved-from
storage. The single completion path preserves reverse cleanup order rather
than releasing Z owners first and leaving native locals until a second pass.

The Darwin test builds the standalone native compiler from the current source
so it uses real Clang import metadata, not the source-only emitter's foreign
placeholders. UBSan and descriptor checks cover normal completion, cold drop,
cancellation before entry/after a yield, a null early return, and wrappers with
no user `deinit`. Weak-reference probes also verify that endpoint/lease objects
actually deallocate, including after moving a parameter into a root local;
closing a descriptor alone would not prove ARC release. Endpoint cleanup
precedes lease cleanup. The application is
not launched by these tests, and no ASan probe is left running.

This adds no allocation per yield or per stored argument. Existing Mutex
synchronization and ARC retention costs remain; no new benchmark speedup is
claimed. A separate collection parity gap surfaced: direct Map<usize, String>
values still hit the older native admission restriction, whereas the real
inbox's named enum payload is supported and tested. That restriction should be
revisited as its own collection-lowering check, not papered over in Zapp.

Next: child-await/error composition for bounded receive failures, then listener
startup/readiness and cancellation/join integration. Borrowed parameters,
broader foreign storage, nested source-local declarations, and declaration
placement remain outside this yield tier. No public Zapp API changed.

### Child joins and typed errors in native yield frames

The next listener reduction composes ordinary named child calls with the
existing executor-local heap frame. `async-yield-child.zs` keeps a parent
endpoint alive while an owned request enters a yielding child, receives an
`i32` or a cleanup-bearing typed error, and propagates that error with `try`.
It also materializes Results in root frame locals with `attempt`, repeats
child awaits and synchronous `try` calls inside a loop, awaits void completion,
receives an owned struct from an immediate child, and returns an awaited child
value. The source still contains an explicit `scheduler.yield()` to select
this general frame tier; child-only loop admission is not implied.

No second error channel was introduced. A throwing child returns the existing
owned `Result<T, E>` through the invocation's `take_result` operation. Success
transfers to the parent binding; failure transfers to the parent's Result;
discarded success and unclaimed failure are destroyed. Two lowerer omissions
surfaced: `Result<void, E>` must treat success as payload-free storage, and a
statement-form `try await` must derive the Result from its checked callee when
there is no value-binding type to consult. Neither needs new source syntax.

The parent holds one active child invocation and installs itself as that
child's waiter. It returns to the executor rather than running a synchronous
child driver. Parent cancellation forwards to the active child and joins it
before releasing parent storage. Child-only cancellation propagates as
cancellation, not as `throws E`. Dropping an active parent also joins the child
before freeing its waiter. Bounded UBSan probes cover cold drop, before child
creation, child suspension, an error produced but not consumed, propagated
unclaimed errors, and owned child results before/after transfer. The executor
queue must be empty after each case.

Foundation error payloads additionally exercise Clang ARC, including plain
wrappers without a Z `deinit`. Heap result slots need explicit strong-slot
clearing after either unclaimed cleanup or result transfer. Non-trivial
temporary Result values also need statement-local C scopes: jumping past a
compound literal with ARC fields is invalid even when the corresponding Z
ownership plan is sound. Descriptor and weak-reference probes test resource
closure and actual object deallocation separately. This found the same
strong-slot omission in the older ordinary callable-task wrapper used by a
single-yield child: its parameter and result aliases must also clear before
`free`, even though those fields have no Z cleanup guard. Fixing only the new
parent frame would leave the child's error object retained.

Cost model: the parent allocates one frame, and child calls use the existing
invocation allocation strategy. Child-aware frames carry one invocation slot;
yield-only frames do not acquire that slot. There is no allocation per yield
or per loop iteration except work explicitly done by that iteration, including
starting a child. This is composition evidence, not a new benchmark speedup.

Remaining boundaries are explicit: borrowed child parameters, method/placed
awaits in this loop frame, nested awaited expressions, awaited destructuring
initializers, and nested source-local declarations. Rejected compositions must
not fall through to a blocking child helper. An unrelated native compiler
pressure point was also observed while writing its storage check: a temporary
`Array<String>()` borrowed inside a negated conditional call can lose its C
temporary declaration. Naming that checker work buffer kept this change
bounded; the conditional temporary-lowering gap remains follow-up work.

Next: pressure-test the actual listener's receive-error handling and main-host
wakeup shape against these remaining boundaries, then restore startup/readiness
and cancellation/join integration. No automatic listener or public Zapp API is
enabled by the reduced compiler tests.

### Synchronous matches inside native yielding loops

The actual launch endpoint calls a bounded synchronous `receive(in inbox)` and
materializes failures with `attempt`. Supporting child awaits alone did not make
this listener expressible: it also needs a `match` inside the yielding loop.
`async-yield-match.zs` now executes that shape through Stage 0 and the native
frontend, with exact destructor traces and bounded UBSan checks.

The native frame accepts ordinary enum match statements whose subject and arms
complete synchronously. Payload-free arms, one binding/discard, borrowing, and
wildcards are supported. Root Results produced by `attempt await child()` can
be matched afterward. Match expressions, awaited subjects, object-pattern
destructuring, nested source locals, and suspension inside an arm remain distinct
composition boundaries. Payloads are lexical storage, not new heap-frame fields.
An enclosing C scope ends their Clang ARC lifetime before the next resume label.

This exposed two older native cleanup-planning omissions. A move anywhere in an
arm had suppressed cleanup for the entire arm, leaking its payload on other
branches. Statement arms now use the existing move/live-guard plan. Separately,
`break` and `continue` must include the current arm's payload in the enclosing
loop's cleanup set. The same tests also execute without async to keep these
shared fixes honest. The real transport regression then caught a double cleanup
of a nested `Result<Option<Lease>>`: consuming the inner match was not indexed
under its hygienically renamed payload owner. Move indexing now includes
lowered consuming-match subjects and treats matching as control flow, so an
inner consumption disarms the same owner guarded by outer-arm cleanup. A reduced
nested Result/Option probe exercises both consumption and an early return before
it in synchronous and yielding functions. Early return, throw, and failed synchronous `try` release
lexical payloads before the common frame-completion path releases root owners.
Consuming-match subject temporaries are initialized and destroyed around subject
evaluation, before any arm can exit early.

Cancellation checks cover a borrowed owner retained across a yield, a consumed
wildcard owner, and an unclaimed propagated error. Foundation probes additionally
check real descriptor closure and weak-reference invalidation after normal
completion, an early-return arm, or cancellation after the match. There is no
allocation per match introduced by this change: generated code uses the same
tag switch and ownership operations as synchronous matching.

Two pre-existing boundaries encountered while widening the probes remain queued:
Stage 0 does not yet emit an interpolated String argument directly inside this
async expression shape, and the source-only native path can get farther than
Stage 0 for a rejected cleanup-bearing borrowed call temporary before Clang
rejects it. Keep rejection parity as a separate follow-up; do not infer support
from native emission alone.

Zapp's actual endpoint/inbox probe now includes its bounded receive-error match,
but remains compile-only. Next: main-host wakeup placement and cancellation/join
integration, then startup/readiness. Automatic secondary-instance forwarding is
not enabled by this checkpoint, and no new language syntax or Zapp API was added.

## Full Z Notes build gate after the yielding-match checkpoint

The 2026-09-08 performance sweep reproduced a native code-generation regression
at Z `53ec87f` against Zapp `d89bb92`. Both release build attempts failed with
undeclared `_z_stage1_live__z_stage1_match_payload_*` ownership flags. The real
application exercises older async match paths as well as the new yielding-loop
tier: an owned match payload enters an awaited child, and an owned error payload
is transferred into a returned aggregate. One path has an existing async frame
guard with a different name; another references a guard without declaring it.
The separate 85-module `z check` succeeds, so lowering-only checks are not enough
to certify native executable composition.

This gate is now closed upstream. Tail-await match frames use the lowering
planner's existing live flag for frame storage, moves, and cleanup; synchronous
matches after an await declare that same lexical guard. No generated-C patch or
Zapp source workaround is required. The full Z Notes release and development
builds now compile and link successfully.

`async-match-guard-composition.zs` reduces both paths to owned String-bearing
payloads with observable `deinit`. Stage 0 and native emission agree on exact
cleanup after success and failure. A bounded native harness also cancels before
entry, during child ownership, and after child completion, then destroys
unclaimed success/error aggregate results. It checks exact destructor output
and an empty executor queue under UBSan. The fixture is included in the
executable differential corpus so future yield-frame improvements also exercise
these older tail-await paths. Compilation is not an interactive launch or a
proof of every application shutdown path.

The launch-listener main-host placement/cancellation/join checkpoint above is
paused for this performance sweep, not replaced. `docs/performance.md` records
the successful current build timings, deterministic worker archive publication,
and removal of redundant dispatcher checking. The final generated-overlay build
still rejects malformed dispatch and stale overlays, including after a cache
hit. Foreign-adapter waits, imported-type lowering costs, and profile-specific
cache storage remain the next performance opportunities.

### Listener wakeup probe: cold scheduling and owned scope handles (2026-09-08)

Continuing the launch-listener probe uncovered two native-lowering gaps rather
than a need for new application APIs. `TaskScope` and `TaskControl` now use
their existing retained ownership inside yielding function parameters and root
locals. Cold-frame destruction, cancellation before entry, and cancellation
after an alias is initialized restore the caller's reference count exactly.

More importantly, native `TaskScope.schedule(thread.main, async ... )` used to
start the callable while constructing its job. A non-suspending async body can
execute inside that start function, so a worker could execute main-isolated
code before dispatch. Scheduling now transfers the callable's start/context/
release fields into the existing job and starts it only when the destination
executor polls. No additional wrapper allocation is needed; the job stores
three additional pointer-sized fields. Rejection and cancellation before entry
release the callable without executing its body or allocating its child frame.

`async-yield-scope.zs` runs under Stage 0 and native emission. A bounded Darwin
pthread harness drives the native listener frame on a worker, joins that worker
without pumping main, then joins or cancels admitted main wakeups. The callback
asserts `pthread_main_np()`, owned contexts are released exactly once, and the
scope returns to its original reference count after posted dispatch notifications
drain. These checks run under UBSan, not ASan. Existing captured and
delay-suspending TaskScope probes remain passing.

At this checkpoint the probe tested the frame/scheduler boundary, not a
language-level worker capture. The follow-up below closes that prerequisite;
automatic secondary-instance forwarding remains disabled until the application
startup and teardown checks pass.

### Language-level worker scope capture and yielding-child cancellation (2026-09-08)

`async-worker-scope.zs` now uses ordinary `thread.spawn(async move ...)` rather
than a handwritten pthread driver to carry a retained `TaskScope` onto a worker.
The parent keeps its handle. A terminal await of a named nonthrowing yielding
function drives that cold child on a worker-local executor; each drive observes
the worker's synchronized cancellation flag and forwards it to the child.
Cancellation joins nested children and releases their owned storage before
publishing worker completion. Cancelled children do not expose a result.

```zs
const updates = new TaskScope();
const listener = thread.spawn(async move (): i32 => await listen(updates));
// listen owns its locals, queues main wakeups through updates.schedule(...),
// and reaches scheduler.yield() between bounded operations.
await listener.cancel();
await updates.close();
```

This is the existing API and ownership model, not a new capture rule: `move`
retains shared identity and transfers unique ownership as appropriate. The
native frame tier is still `void`/`i32`, root owned locals, synchronous nested
control flow, and direct named child awaits. General asynchronous worker body
normalization, throwing worker wrappers for this path, and cross-thread
`TaskControl` capture are not added. A scope-capturing worker with an unsupported
child-await shape fails closed; it must not silently call a synchronous bridge
that cannot observe cancellation. Broader Task return annotations and renamed
`TaskControl` parameters receiving a `schedule` result also need a separate
Stage-0/native diagnostic parity audit: the latter currently reports
`expected WakeControl, found TaskControl` in a native-frontend check. This probe
creates and joins the worker in its enclosing async function.

The combined test exposed another real composition failure: when native worker
awaits enable external-completion support, a TaskScope-owned fallback executor
must initialize and destroy that support too. Borrowed enclosing executors keep
their own lifecycle; the scope neither reinitializes nor destroys them.

Bounded UBSan tests cover normal completion, cancellation before worker entry,
cancellation after owned initialization, nested child cleanup, owned String
capture into a void child, and rejection after close. A 60-worker matrix joins
or cancels admitted main work, drains already-posted dispatch notifications,
and checks exact resource cleanup, an empty queue, and the original scope
reference count. Stage 0 and native execution agree. No ASan processes or
unbounded test children are used.

Next: restore the real endpoint/inbox/main-wakeup integration probe, including
startup failure and close-admission → cancel/join listener → drain/cancel main
jobs → destroy host. Passing this runtime prerequisite is not proof of the
complete application listener. A yielding loop is also not an efficient idle
wait: blocking/notification-backed reception must stay bounded and measured.

### Real launch endpoint, inbox, and main-host integration (2026-09-08)

The Zapp `application-launch-listener-smoke.zs` now runs the real bounded Unix
socket receiver on an ordinary Z worker. It uses the existing `ActivationInbox`,
`TaskScope`, and a main-isolated `Once<LaunchHost>`; the Foundation-backed endpoint
is constructed and destroyed on the worker, never transferred to main. The
host pumps the macOS CFRunLoop, as an AppKit host does, so scheduled callbacks
must actually reach the main executor. There is no interactive window or
automatic forwarding installed in `Application` by this probe.

Three compiler seams appeared only when these pieces were combined:

- A root owned local selected by synchronous `match` was rejected by native
  yield-frame admission, although its normalized lowering already existed.
  The frame now admits that shape. A returning/throwing arm does not mark the
  destination live; success, failed initialization, cold cancellation, and
  cancellation after initialization have exact-once cleanup tests. Match arms
  still cannot suspend, and this does not admit nested owned locals.
- An ordinary user method named `release` collided with generated ARC cleanup.
  Both emitters now escape ownership-helper member names and the escape prefix
  itself. Direct, generic, static, trait-constrained, and weak-reference calls
  retain their behavior without reserving these source-level method names.
- A private async helper named `listen` collided with the POSIX declaration
  included by the real socket headers. Native private bridge naming now accounts
  for known foreign symbols and protects private async facades when native
  headers are present. Broader exported-Z symbol and macro-namespace hygiene
  still needs an audit; explicit C exports retain their declared ABI names.

The integrated Stage 0 and fixed-point native executables both pass the bounded
UBSan matrix: normal delivery (including empty, spaced, and Unicode arguments),
a competing secondary that does not disturb the primary, rejection by a closed
main-work scope, idle cancellation, cancellation with an incomplete client
frame, and startup failure at a hostile socket path. The hostile path remains
untouched. Readiness is published only after election **and** socket creation.
Shutdown closes admission, cancels/joins the listener, joins main jobs, and then
releases the main-owned host. The worker's socket/lease cleanup completes before
its join; the identity can be acquired again afterward. Existing lower-level
tests separately inspect reverse endpoint/lease destruction and exact strong
reference counts.

Receive waits remain bounded, not instantly interruptible: listener polling and
an admitted client's frame/acknowledgement each have an absolute deadline. The
integration watchdog allows four seconds after readiness for the complete
scenario and teardown; every child and socket is tracked and cleaned up. This
is not a new throughput or idle-CPU benchmark.

One separate boundary remains explicit: direct `await delay(...)` inside native
`main` needs a resumable entry frame. It now reports `Z0700` at the await instead
of an internal unnamed-Task lowering error. Stage 0 supports that shape. The
CFRunLoop pump in this macOS probe exercises the actual host loop; it does not
claim to implement native-main timers or provide a general polling API.
The entry-name audit also found that renaming the existing suspending
`PublishService.publish` fixture method to `main` hits an older lowering check
that treats its source name as the entry point. The new diagnostic is restricted
to free functions, but this separate method-emission gap remains queued with
the entry-frame work; ordinary suspending methods retain their existing tier.

Next: integrate this proven lifetime/order into the application startup path,
with fail-closed election/readiness/secondary handoff. Keep automatic forwarding
disabled until that application-level gate passes. General native entry-frame
timer suspension stays queued upstream. No new public syntax or framework API
was needed for this checkpoint.

The full self-hosting tier also exposed three stale tests, reproduced from an
untouched `6053fda` checkout: optional-field move guards, owned-match/loop cleanup
snapshots, and the older struct-yield diagnostic wording. Their assertions now
verify disarmed source owners, conditional cleanup, and the matching outer-loop
exit label while preserving compile/run checks. Compiler safety behavior was
not weakened to recover the older emitted text.

### Application startup readiness exposes native channel execution parity (2026-09-08)

Moving the verified launch listener into `Application.run()` needs a one-shot
startup result: elected primary with an open endpoint, successful secondary
handoff, or a typed failure. AppKit setup must not begin before that result.
The existing capacity-one channel and explicit synchronous endpoints fit this
bounded handshake without polling, a new public synchronization API, or an
application-specific native shim.

The initial yielding-worker reproduction was rejected as unsupported
`SyncSender<i32>` frame storage. Removing the worker and all suspension exposed
the underlying boundary: even synchronous channel creation/send/receive reaches
native lowering without an implementation, failing on `ChannelClosed<i32>`.
Native channel tests had proved semantic evidence and ownership parity, not
executable lowering. Existing channel runtime and benchmark evidence comes from
Stage 0-generated native binaries. Native code generation has no channel type,
storage, endpoint operations, or cleanup implementation yet; an admission-list
change would merely hide the first diagnostic.

Emission now reports this prerequisite explicitly as `Z0700`, before async-frame
classification. `bun run z check <source> --native-frontend` still verifies native
semantic parity; standalone native `z check` also validates lowerability and
reports the same boundary as `z build`. Regression coverage keeps that semantic
parity path available,
executes the synchronous reproduction through Stage 0, checks aliased and nested
endpoint declarations, and leaves similarly named user types and unused imports
alone. The status matrix and website distinguish the two compiler paths.

Application integration is paused at this scope boundary. The recommended next
slice is native **synchronous bounded-channel** lowering using the existing
surface: `Channel<T>.bounded`, `.sync()`, blocking send/receive, close, owned
unsent errors, endpoint retention, and exact cleanup. Validate cross-thread
readiness plus yielding-frame endpoint storage and cancellation before resuming
application election/readiness → secondary handoff → ordered shutdown. Full
async channel waiters, unbounded channels, and new synchronization syntax are
not prerequisites for that slice. Automatic application forwarding remains
disabled; the previously verified endpoint/inbox/main-host probe is unchanged.

### Native bounded synchronous channels close the readiness prerequisite (2026-09-08)

The existing channel API now lowers to native bounded queue storage and
blocking endpoint operations. No new language syntax or synchronization API
was introduced. Sender conversion retains a shared handle; receiver conversion
transfers the unique receive authority. Closing drains buffered messages before
`Option.none`, while failed sends return the original owner in `ChannelClosed<T>`.

The executable pressure test is a real `thread.spawn` whose named async callee
owns `SyncSender<i32>` and `TaskScope` parameters, sends readiness, and yields.
The parent receives readiness, cancels/joins the worker, then closes its scope.
Stage 0 and native emission run the same source. Repeated native executions use
UBSan and instrument channel storage releases to detect leaked endpoint aliases.
Other tests cover ring wraparound, buffered drain, receiver-drop wakeup, final
sender destruction, owned String and struct messages, rejected payload recovery,
exactly-once automatic payload cleanup, and aliased cross-module endpoint fields.

Composition exposed four upstream gaps beyond queue emission: Stage 0 lacked
sync endpoint calls and shared-sender retention in async frames; native move
closures consumed shared senders; callable type aliases did not materialize
their nested intrinsic storage; and rebasing an imported `Sender as Producer`
field lost the intrinsic's canonical identity. These are fixed in the compiler,
not worked around in application source. A separate native scalar Array.push
bug attached an unrelated same-named owner's live flag, and worker capture
discovery mistook match-arm bindings for captures; both have regressions.

This does **not** implement native async channel waiter queues or expand custom
destructor/foreign-resource thread-safety proof. The cleanup test instruments
ordinary generated value-struct cleanup rather than treating an unproven custom
destructor as transferable. Synchronous endpoint operations block the calling
OS thread even inside an async function; they are not substitutes for async
backpressure on a responsive executor.

Next: return to Application.run election/readiness, secondary handoff, and
ordered listener cancellation/join. Automatic application forwarding remains
disabled until that integration is verified. Preserve the earlier Stage 0
throughput/allocation measurements; benchmark this new native queue separately
before making a native performance comparison.

### Startup outcome composition and normalized ownership (2026-09-08)

Application startup uses an owned `Result<Option<Endpoint>, Error>`: a primary
keeps its endpoint, a secondary returns after forwarding, and failure carries an
owned message. Stage 0 could check the nested value-producing matches but could
not emit an inner match as the final arm of an outer match in an async frame.
The planner now shares one destination between those matches and finishes each
arm's cleanup separately. Tests cover suspension before selection, early return,
typed failure, and cancellation with exactly-once cleanup. This adds no new
syntax and no extra intermediate owned result or retain.

The same integration caught a regression in native `Array.push(try make())`.
The fallible result is normalized to a synthetic local. Type-directed storage
correctly avoided moving primitive values, but failed to mark a cleanup-bearing
synthetic local as transferred; end-of-statement cleanup then destroyed the
value already held by the array. In the native compiler itself, this corrupted
imported Objective-C method metadata. The shared owned-storage helper now
recognizes normalized fallible/conditional owners after checking the payload's
cleanup requirement. The regression executes array insertion, channel send,
receive, and rejected-send recovery under UBSan, checks three exact payload
destructions, and rejects an emitted duplicate synthetic-local cleanup. The
earlier same-name primitive/owned-local regression remains covered.

Yielding worker capture identity resolution also now recognizes object-pattern
bindings, including renamed channel senders. A test captures a destructured
sender, releases the parent's retained alias, receives readiness, and joins the
worker. These remain ordinary compiler composition fixes, not application-only
storage types or new ownership rules.

Application-level startup integration is still gated on the full native graph
and real-process checks. The standalone listener probe is not by itself proof
that every Application.run failure path joins correctly. Native-header builds
initially collision-mangled an imported `internal async` callee while its caller
retained the original target spelling. The worker bridge could not find that
callee's yielding frame. This was call identity loss, not missing nested-match
syntax or a reason to weaken the worker cancellation check. The following
checkpoint closes that identity gap and records the next integration boundary.

Other async storage
boundaries encountered during integration remain explicit: positional array
destructuring, cleanup-bearing conditional locals, and ownership-bearing
replacement assignment are not generalized by these fixes.

### Checked call identity across emitted module names (2026-09-08)

Native lowering now preserves a call's source offset through direct, awaited,
and placed-call lowering. After module/specialization names are settled, the
containing source module's checked call evidence supplies the exact target
module and symbol. Private naming and generic suffixes are applied to that
declaration, not guessed from the caller's imports or a same-named output
function. Missing/inconsistent evidence fails closed. Named callable values
without a call site continue to use their existing lowering; this is not a
claim that every first-class function-identity shape has been generalized.

The regression imports two internal async functions with the same source name
under different aliases, with native headers present. Both worker frames execute
and join. It also exercises same-module async calls, same-named synchronous
functions, and generic specializations. All 14 native channel tests pass with
UBSan; worker cases repeat eight times and the queue reference counter returns
to zero. All 161 self-hosting tests pass on a frozen source snapshot, and the
compiler rebuild reaches a fixed point. The source-offset field
is compiler IR metadata only, not an application allocation or runtime lookup.

Zapp's production-shaped startup matrix now passes **both** compilers under
UBSan: primary/secondary forwarding, idle shutdown, a partial request during
shutdown, and hostile-path startup failure. The subsequent full Z Notes build
finds a different boundary before launching an application. This minimal
ordinary Z shape checks and runs with Stage 0, but native lowering still rejects
the combination of an early awaited return and a later awaited local:

```zs
async function startup(enabled: boolean): i32 on thread.main {
  if (!enabled) return await operation();
  const result = await operation();
  return result;
}
```

Native frame admission currently separates branched tail awaits from linear
awaited-local continuations. Neither classifier accepts this combination, so
it incorrectly falls through to the main-thread timer-only diagnostic. The
next slice is their safe composition, with precise unsupported-shape diagnostics,
then the real startup wrapper's owned outcome, listener cancellation/join, and
TaskScope joins. Do not work around this with a synchronous wrapper or a new
framework API. The saved Application.run patch remains unapplied; normal Zapp
startup is unchanged until the full application gate passes.

### Early awaited returns and continuing owned frames (2026-09-08)

The minimized startup shape above now executes through both compilers. Native
admission and lowering recognize early terminal child awaits before one later
awaited local. The early branch uses a distinct resume state to complete the
parent; it cannot fall through and initialize the later local. Both branches
reuse the existing child invocation slot, with no additional frame allocation
or result wrapper introduced by this composition.

`tests/fixtures/async-linear-tail.zs` covers owned `Message` inputs/results,
owned typed failures, root guards created before and after the branch, a
genuinely yielding child chain, and the corresponding class-method frame path.
Both successful and failed outcomes execute in Stage 0 and native output under
UBSan. A native driver checks 72 cold-drop, cancellation, completed-result, and
active-destruction cases across both paths. It counts input destruction and
checks exact guard output and an empty executor queue after every case. Child
storage is joined/destroyed before parent-owned inputs are released.

The probe also exposed a generated field collision: a user local named `result`
shared the runtime result member's spelling. Frame locals and matched payload
fields now have their own generated prefix, including their macro targets.
Existing frame tests continue to assert the distinct generated storage.

This is deliberately not general async normalization. In this tier, nested
branch locals that would need storage across an early suspension are rejected, as are early
awaits followed by more than one awaited local. The diagnostic identifies the
continuation-frame boundary instead of suggesting `await delay`. Wrapped or
computed terminal awaits cannot silently use the direct-child completion path;
direct children must have the parent's exact result representation. Throwing
yielding method bodies and arbitrary owned yield-frame return types remain
their earlier separate boundaries.

Next is the saved Application.run integration's owned outcome plus native-thread
and TaskScope cancellation/join composition. Passing this reduced frame fixture
does not enable automatic secondary-instance forwarding; the full application
and real-process teardown gate must still pass.

The rebuilt fixed-point driver passes all eight production-shaped Zapp startup
process cases under UBSan alongside Stage 0. Retrying the complete application
finds the remaining join boundary. Adding `await updates.cancel()` after the
awaited local in the minimized startup function is sufficient to reproduce it:
Stage 0 runs successfully, while native admission reports `Z0700`. The full
wrapper additionally cancels/joins its native listener and another TaskScope.
Its saved patch remains unapplied. Extend these continuations using checked
TaskScope/Task receiver identity, not a blanket exception for `.cancel()` calls.

Final checkpoint: all 210 tests in the self-hosting tier pass on a frozen
compiler snapshot; the standalone compiler reaches a fixed point. The restored
normal Z Notes smoke and both Zapp TypeScript check projects also pass.

### TaskScope joins in an owned continuation (2026-09-08)

The next minimized application shape now executes through both Stage 0 and the
native emitter: an early terminal await, one owned awaited `Result`, synchronous
work, and sequential root `await updates.close()` / `await updates.cancel()`
statements. Free functions and supported class methods share the same suffix
emission. The result remains frame-owned until the last join and final match;
success/error payloads are neither recomputed nor copied on resumption.

Admission checks the actual `std/async` TaskScope receiver, including import
aliases. Ordinary user-defined `.close()` and `.cancel()` methods still receive
the broader-continuation diagnostic; spelling alone cannot authorize a runtime
primitive. Nested joins and additional ordinary awaited locals remain outside
this slice.

Same-executor joins now retain a scope and register a waiter. Finishing the final
admitted child wakes all joiners without busy polling. The parent's existing
single child-invocation slot holds each join in sequence. A join has one small
heap allocation; this is current bootstrap runtime overhead, not a claim of
zero-cost scope joining. Scopes created with a separate executor retain the
existing synchronous driver bridge. General cross-executor readiness composition
has not landed as part of this change.

Bounded UBSan tests exercise normal close, explicit cancel, cancellation of a
close, two simultaneous waiters, cold and active destruction, rejection after
admission closes, the separate-driver bridge, and exact final reference counts.
The actual generated Z parent is cancelled at 19 scheduler positions on both
success/error paths, and naturally resumed after a pending scope on both paths.
Checks ensure child destruction precedes parent guard cleanup and that the
post-join continuation never runs after cancellation. Cancelling before a passed
scope's join is reached does not implicitly close that independently owned scope;
its caller must still finish it.

An additional active-parent probe exposed a separate structural-owner gap:
`new TaskScope()` inside the continuation could leave a scheduled timer/child
behind when parent cancellation skipped the later explicit join. The bounded
generated-C probe returned status 22 because the executor still held pending
work after parent destruction. Merely retaining/deinitializing a scope handle
does not implement the implicit joining promised for a locally created scope.
This shape now receives `Z0700` at construction (including import aliases), with
a lowering backstop, until implicit scope-unwind states are implemented. The
passing handle tests above intentionally receive independently owned scopes;
they do not claim to solve local structural ownership.

Next: implicit continuation-owned TaskScope unwinding, native-thread
cancellation/join, then the saved Application.run integration and full
primary/secondary application gate. Automatic
forwarding remains disabled; passing the TaskScope fixture does not establish the
complete application's lifetime ordering.

Final source snapshot: all 212 self-hosting-tier tests pass (421.63 seconds).
The local standalone compiler was rebuilt to a fixed point (10,870,008 emitted
C bytes); it runs the sequential-join fixture and independently reports `Z0700`
for the continuation-owned scope probe. These are composition/correctness checks,
not a new runtime or compilation performance benchmark.
The ordinary native Z Notes auto-closing smoke also passes, as do all eight
real-process startup transport cases (Stage 0 and native, with UBSan). The saved
full startup wrapper remains unapplied; these passing gates do not enable it.

### Implicit scope ownership in native continuations (2026-09-08)

The continuation now accepts direct root-local `new TaskScope()` constructors.
Every initialized scope has a retained structural-owner slot independent of its
visible binding and cleanup flag. Returns (including early awaited returns),
propagated errors, and cancellation converge on reverse-order scope joins before
root locals and parameters are released. A result already computed stays in the
frame throughout these joins. Normal return closes admission and waits; a typed
failure cancels children without converting the parent's failure into task
cancellation. Cold/active destruction drains the same cancellation states.

Moving a scope handle exposed the equivalent Stage 0 bug: its old implicit join
used the visible binding's live flag, which `move` clears. The child could then
outlive the parent, with UBSan reporting an invalid boolean load from a queued
task. Stage 0 now also records the structural owner independently. This adds no
new source rule: a handle transfer does not transfer the creating frame's
obligation to finish its admitted work.

The pending-timer test exposed another runtime issue. Scheduling on the current
executor used the foreign-driver bridge, recursively polling tasks and retaining
a delayed main-queue wake. It now drains external admission into the current
queue without recursive polling or a host wake. A delayed host wake checks for
an already joined scope before touching the scope's borrowed executor pointer.

Z Notes exposed a necessary distinction in that fast path: a native callback can
re-enter Z while an outer task poll is inside AppKit's run loop. Treating that
callback as ordinary active-executor work stalled the frontend service request.
Native C callback/export, Objective-C block, protocol, and target/action entry
adapters now temporarily clear the inherited polling executor and restore it on
return. The callback uses the host driver; work scheduled by an actual Z poll
still uses the non-recursive queue path. A bounded native-entry regression and
the complete auto-closing Z Notes smoke pass with this distinction in place.

`tests/fixtures/async-linear-owned-scope.zs` covers early/continued success and
failure, two local scopes, a moved handle, and class-method implicit/explicit
joins. A bounded generated-C UBSan harness exercises 492 native cancellation and
destruction cases, checking child completion before parent guard destruction,
exact scope allocation/release counts, owned payload cleanup, and empty task
and timer queues. The focused suite also keeps independent passed-in scopes and
ordinary user-defined close/cancel methods distinct.

Verification: all 215 self-hosting-tier tests and all 98 async-tier tests pass.
The rebuilt local compiler reaches a fixed point and runs this fixture directly.
All eight production-shaped Zapp startup cases pass again with Stage 0 and native
output under UBSan (normal forwarding, idle shutdown, partial request, and startup
failure for each compiler).

Cost is explicit: scoped frames add two state flags and a retained pointer per
constructor. Joins reuse the existing child invocation slot and current small
heap-allocated join object; unscoped frames do not gain these fields. This is a
correctness/composition checkpoint, not a new performance benchmark. Native-entry
guards save/restore a thread-local executor pointer without heap allocation.

Nested/conditional constructors and broader suspension shapes remain rejected.
That checkpoint left native-thread cancellation/join after the owned outcome
as the next gate, addressed below. The saved Application.run integration and
complete primary/secondary process tests still gate automatic forwarding.

## Owned continuations joining native workers (2026-09-08)

The application-startup wrapper keeps an owned `Result` alive while cancelling
its listener, then joins the scopes that own admitted main-thread work. This
ordinary composition was rejected by the native linear-await classifier even
though each operation worked separately.

`tests/fixtures/async-linear-thread-join.zs` now exercises early and continued
success/error paths, a native worker returning owned String storage, and a
following scope join. Worker cancellation is recognized through the intrinsic
Task type or the imported `thread.spawn` constructor, including an import alias;
an arbitrary user-defined `cancel()` does not become a suspension primitive.

The join retains the parent frame and reuses its child-invocation slot. Explicit
worker cancellation discards the worker's result and completes normally. Parent
cancellation propagates to the join and remains a separate structural outcome.
An early return, error, or cancellation before the explicit statement routes
through the same child-unwind states before parent locals are destroyed.

A pending worker-to-main request must also wake this join. The external queue
now distinguishes a notification that resumes a native join from a callback
that completes its task. The join services a main-thread request, resumes the
worker, and waits for actual completion without spinning or creating a helper
thread. Binding the request to its worker now works in expression closures and
main-isolated functions, as well as the previous `main` block-closure shape.

The focused UBSan matrix covers 300 combinations of early/continued control
flow, success/failure, scheduler position, explicit cancellation, and cold/active
frame destruction. It checks worker completion/join before parent guards,
exact owned-input cleanup, and empty queues/external-completion accounting.
Additional parity probes cover a function without TaskScope, a main-bound class
method, and a worker publishing on main while its parent joins.
Another 64 cases destroy the native waiter itself before polling or while it
awaits an external notification. Destruction requests cancellation and drains
the waiter before freeing it, preventing late worker notifications into retired
join storage.

Verification: the full self-hosting run passed 218 tests and the async tier
passed all 98. The final focused suite passed 12 tests, including the additional
waiter-destruction coverage. The rebuilt compiler reached a fixed point; all
eight Zapp Stage 0/native startup cases passed under UBSan, and the complete
auto-closing native Z Notes smoke passed with an isolated application identity.

Cost: the existing join object gains two mode flags; worker creation is unchanged.
The parent still uses one child-invocation slot. This is correctness evidence,
not a new throughput benchmark. Automatic Application.run forwarding remains
gated on applying and testing the saved production integration.

Two adjacent forms encountered while broadening the probe remain separate
native-lowering work: a direct timer await inside an inline worker body, and a
cleanup-bearing return from the first scheduler-yield-only function tier. The
regression uses the already-supported named-child await composition; no Zapp
implementation workaround was introduced.

## Returned matches and destructured continuation owners (2026-09-08)

Reapplying Zapp's saved Application.run startup wrapper exposed two additional
native composition failures in ordinary, already-valid Z:

- `return match (...)` containing a nested match and one terminal awaited call
  was rejected even though explicit returns in similar arms worked.
- Destructured channel endpoints were emitted as poll-stack locals, while later
  return cleanup referred to them from a different continuation state. The full
  application failed Clang compilation with out-of-scope endpoint/guard names.

The first fix shares one conservative source-shape classifier between native
validation and lowering. Consuming returned matches can contain nested matches,
payload-free arms, and one-statement `select` blocks. Exactly one terminal direct
child await is supported; a throwing parent uses `try await`. Borrowing matches,
suspending subjects, multiple awaited arms, and arbitrary arm continuations are
not generalized by this checkpoint. Every payload owner enclosing the selected
await lives in the existing task frame, with inner-before-outer cleanup and
ownership transfer when a nested match consumes its parent's payload.

The second fix treats a normalized root destructuring group as a declaration
group, not a lexical scope. Its selected bindings participate in frame field,
guard, initialization, and reverse cleanup generation like neighboring `const`
bindings. Its temporary source remains in the synchronous extraction scope;
unselected fields are destroyed there. Actual branch-local storage is not
promoted by this rule.

The destruction probes also found a queued-parent lifetime bug: destroying a
child could notify a parent after its frame had been freed. Direct tail/double
frame teardown now detaches child waiters and removes retired tasks from the
queue. Linear frames retain notifications while structurally joining owned
scopes/workers; prematurely detaching those waiters would prevent their unwind
from completing.

The focused UBSan suite checks normal/failed returns, borrowed payload calls,
payload-free arms, 96 nested-match cancellation/destruction cases, and 240
destructured-owner cases. The latter track every initialized owner, including
unselected fields, and require empty executor queues after destruction. The
full native Z Notes smoke builds and completes with the saved integration
present but single-instance disabled. The separate complete Application.run
primary/secondary and rollback gate also passes after the readonly ownership
correction below; the disabled smoke alone was not evidence of forwarding.

Cost: payload and selected-local storage resides in the existing invocation
frame; no extra task allocation, helper thread, or runtime ownership lookup is
introduced. This is cleanup/composition evidence, not a throughput benchmark.
No source syntax or framework API changed.

Verification checkpoint: 224 self-hosting-tier tests and all 98 async-tier tests
passed. After extending the partial-destructuring case, the final focused suite
passed all 17 tests. The compiler rebuilt to a byte-identical fixed point, and
all eight Stage 0/native startup-transport cases passed under UBSan.

The full-application regression also exposed two adjacent follow-ups, neither
of which is hidden by a change to the framework's startup API:

- A captured synchronous block closure rejected a cleanup-bearing local
  such as the `String` returned by `json.encode`. The test initially placed its
  formatter in a named function called by an expression closure. The native
  block-callable cleanup checkpoint below closes that local-storage gap;
  captures themselves were not the unsupported feature.
- Declaring a registered service in the application entry module makes Zapp's
  generated dispatcher import that entry module, creating an import cycle back
  through generated dispatch. The regression keeps its service in a separate
  module, as Z Notes already does. This is a service-generator decomposition
  follow-up, not a reason to change Z's module-cycle rules.

### Readonly collection ownership parity

The complete Application.run regression then trapped after service-startup
rollback, in `ApplicationContext.deinit`. A small Z-only reduction showed that
`const arguments = app.context.arguments` shallow-copied a readonly array and
destroyed both aliases. Stage 0 already rejected that extraction; the native
semantic graph incorrectly treated `readonly Array<T>` as cleanup-free.

Native ownership analysis now follows the owned underlying type through the
readonly qualifier. This applies recursively to Map/Set storage, aliases,
generic fields, and Option/Result payloads. Readonly restricts mutation; it does
not imply borrowing, shared ownership, or implicit duplication. Field extraction
and repeated consumption now receive the existing ownership diagnostics in
both frontends. No new language rule or runtime cost was introduced.

The valid regression reads the collection in place, copies its selected String,
awaits a yielding child, and reads the original collection again. Both compiler
outputs execute under UBSan. The application probe uses this same existing
ownership rule; it does not need an owned copy of the whole argument array.

The complete native Application.run gate now passes endpoint setup failure,
service-startup rollback, and real primary/secondary execution. The secondary
forwards empty/spaced/Unicode arguments and cwd once, exits without starting
AppKit or services, and all paths reach stopped state. Sequential reuse of the
same isolated identity verifies lease/endpoint release after startup failure.
This is full application execution evidence, distinct from the eight earlier
Stage 0/native UBSan transport cases. The complete application gate itself was
run with the fixed-point native compiler, not both compilers.

Final verification: all 226 self-hosting-tier tests pass. The expanded readonly
matrix independently rejects 19 unsafe programs through both semantic frontends;
the valid await probe passes with both emitted binaries under UBSan. The native
compiler reaches a byte-identical fixed point (10,934,642 C bytes).

### Invocation-owned block-callable locals

Zapp's second-instance launch callback now motivates a direct composition probe:

```zs
const handler: (in message: Message) => void = move (in message: Message): void => {
  const encoded = json.encode(in message);
  console.log(`${listener.prefix}: ${encoded}`);
};
```

Native lowering now runs the existing lexical cleanup planner over synchronous
void block-callable bodies. The environment owns captures until its last release;
each invocation separately owns its locals. Early return, typed throw, failed
try initialization, consuming match payloads, nested blocks, loop break/continue,
and normal fallthrough all use the same cleanup representation as ordinary
functions. Invocation-local move guards are protected from the enclosing
function's later cleanup pass. A throwing closure's cleanup-return temporary
uses its own `Result<void, E>` type rather than its enclosing function's return
type, which the new failure regression also exposed.

The three reduced programs execute under Stage 0 and native output with UBSan,
exact destructor-order assertions, and a test allocation ledger that rejects
untracked frees and requires zero live allocations at exit. Repeated calls
exercise a shared ARC capture, an owned String capture, JSON encoding, explicit
move, owned Option payloads, and destructured String locals. Nested closures
also retain independent cleanup scopes, including same-named parameters and
both captured and capture-free inner callables. Their regression exposed a C
helper-order dependency: native emission now declares callable construction
surfaces before emitting bodies that can construct them. No additional
closure environment or per-local heap allocation is introduced by cleanup
planning; the existing value representation determines allocation cost.

This is not a blanket expansion to non-void or asynchronous native block
callables, which remain separate lowering tiers. The complete native Zapp
Application.run gate passes with the JSON formatter restored inline in its
launch callback, including startup rollback and primary/secondary forwarding.

Final verification: 229 self-hosting-tier tests and all 98 async-tier tests pass;
the 22 callable-focused regressions and website build also pass. The native
compiler reaches a byte-identical fixed point (10,939,613 C bytes), and the
complete isolated Application.run gate passes with that final compiler. The
earlier broad run's fixed-point comparison crossed an in-flight compiler edit;
the full suite was rerun with source changes frozen before recording this result.

A probe also exposed an existing rejection-parity gap: Stage 0 rejects
whole-object destructuring when fields contain custom cleanup, but native
semantic checking accepted it. The separate checkpoint below closes that gap;
the positive closure test here uses supported String fields.

## Custom-cleanup destructuring rejection parity (2026-09-08)

The native resolver now rejects ordinary object binding patterns before
consuming their source when the value defines `deinit`, or its inline storage
contains custom cleanup. Selecting only a cleanup-free field does not bypass
the rule: the source container still needs valid cleanup for its other fields.
This is parity with Stage 0, not a new ownership restriction or syntax change.

`native-destructure-cleanup.test.ts` covers direct/nested resources, transparent
aliases, fixed and growable arrays, Map keys/values, Set elements, readonly
collections, Option/Result and enum payloads, and concrete generic fields.
Cross-module tests use distinct types
with the same spelling to ensure the check follows nominal identity and rebases
generic arguments into the declaration's module. The original captured callback
case is a rejection regression too, with `Z0220` and the source location checked.

The classifier follows stored fields, not every generic argument or referenced
object. An unused `Phantom<Resource>` parameter is not stored Resource data;
an ARC class alias does not partially move the referenced object's fields.
The positive executable fixture therefore combines both with String, Array,
Map, Set, and Option fields. Stage 0 and native output run under strict C warnings and
UBSan with exact-once class destruction. Existing recursive copy/move and
captured-callback allocation-balance tests remain the supported ownership cases.

No runtime check, allocation, retain, or representation change is introduced.
Partial extraction through custom cleanup remains deliberately unsupported;
use a whole-value move or a type-specific extraction method. Broader generator
iteration patterns and native RAII extraction are not expanded by this fix.

Final verification: 232 self-hosting-tier tests, all 98 async-tier tests, and
the six focused destructuring/callback tests pass. The website builds, and
the final native compiler reaches a byte-identical fixed point (10,956,083 C
bytes). The complete isolated Zapp Application.run gate passes again with this
compiler, including both startup rollback paths and primary/secondary forwarding.

## Entry-defined services and generated function links (2026-09-09)

Zapp's startup service exposed module-boundary friction unrelated to ownership:
an exported class beside `main` was valid source, but its generated dispatcher
imported that class while call adaptation inserted an import back to the
dispatcher. Both compilers rejected the artificial cycle. Requiring a separate
service file would have hidden this upstream tool-integration problem.

The approved distinction is now implemented: validated adapter references
participate in normal name/export/type checking without becoming source
initialization edges. Ordinary imports in generated code are not privileged.
Generated roots retain their ordinary dependencies and are included in emission
and cache inputs. The source parser cannot manufacture the internal provenance;
names and filename prefixes cannot opt out of cycle checks.

The same executable matrix runs through Stage 0 and the native driver. It uses
an entry-defined move-only value, multiple adapter sites, a registration in an
imported module, and exported constants. Construction/destruction output is
exactly once per value. An edited generated-only dependency changes the result
after reuse. Ordinary source cycles, generated-file cycles, private source types,
unexported adapters, incompatible return types, and runtime module initializers
remain rejected. Existing source-hash/target/internal-member gates remain.

The complete app build exposed one more composition requirement: generated
adapters return ARC implementation objects, not just scalars. Native lowering
now supplies the checked generic-argument ABI/cleanup evidence at each adapted
caller before emitting the generated definitions. Distinct adapters and one
shared adapter requested from multiple modules are covered. A companion Stage-0
fix gives every generic method instance fresh semantic source sites: two
concrete trait receivers must not overwrite each other's member-call evidence.
The independent instance/static/generic-owner test does not use generated code.

This adds no runtime allocation, ownership exception, or source syntax. Zapp's
isolated complete Application.run regression now declares its ARC service beside
`main`, so the full application—not only a reduced linker fixture—exercises this
boundary. General cyclic modules and arbitrary runtime initialization are not
unlocked by generated function linking.

Final checkpoint: 232 self-hosting, 97 module/collection, and 98 async tests pass;
both drivers' expanded ARC adapter probes pass strict C/UBSan with exact cleanup.
The rebuilt compiler reaches a byte-identical fixed point (10,965,112 C bytes).
The complete signed native Zapp startup gate, both Zapp TypeScript checks, and
the website build pass. No ASan probe or interactive app bundle was used.

## Readonly launch snapshot observations (2026-09-09)

Moving the verified single-instance startup path into the ordinary Z Notes
example exposed a smaller native parity gap:

```zs
move (in event: ApplicationSecondInstanceLaunchedEvent): void => {
  console.log(`received ${event.arguments.length} arguments`);
}
```

Stage 0 accepted this ordinary observation, but the standalone native metadata
gate reported that the interpolation type was unknown. Native member inference
recognized `Array<T>.length`, not `readonly Array<T>.length`; its lowerability
fallback repeated the same incomplete classification. The fix shares collection
length classification across both paths, preserves view/readonly restrictions,
and resolves transparent aliases before deciding whether the property is an
intrinsic `usize` read. It does not infer that any member named `length` is numeric.

The reduced fixture covers nested readonly Array/Map/Set fields, an Array type
alias, an explicit aggregate view, a borrowed callback parameter, and an ordinary
struct whose `length` field is String. Stage 0 and native C produce the same
output under strict compilation; the native output also passes UBSan. The
standalone driver's check, metadata, and run routes are permanent regression
gates. No collection copy, extra runtime check, public API, or source workaround
was needed.

### Worker permission snapshots and readonly copy

The real Z Notes build then caught generated startup code passing
`catalog.entries[index].serviceMethods` into an escaping worker callback owner.
That field is an owned readonly Array, not shared ARC storage. The recently
hardened native ownership checker correctly rejects extracting it from the
borrowed catalog. The generator must explicitly request `copy` so the worker
owns its independent permission snapshot while the catalog remains intact.

Stage 0 already supported this copy, but native copy capability and lowerability
checks omitted the readonly wrapper. They now reuse the existing underlying
copy rules and Array deep-copy emitter. A returned copy survives destruction of
the source array, and copying a readonly array of move-only resources remains
invalid. This adds one intentional startup snapshot per worker, not a copy per
service call.

Negative testing also found that unknown-method fallback could hide calls such
as `frozen.push(...)` in native checking. The resolver now rejects the existing
mutating Array/Map/Set methods and `freeze` on readonly receivers before that
fallback, including aliases and copied snapshots. Copy preserves readonly type;
it is not a thaw operation. No public API changed.

Verification: 233 self-hosting-tier tests and 97 collection/module tests pass;
the native snapshot fixture passes strict C and UBSan, and the rebuilt compiler
reaches a byte-identical fixed point (10,971,404 C bytes). Zapp's packaged and
Vite Notes launch gates pass with the explicit worker snapshot, as do its 502
CLI/runtime tests and both TypeScript check projects. The website builds with
the updated status. These runs used no ASan.

A separate follow-up surfaced in a broadened probe: template interpolation of
an indexed element from a function returning a readonly Array through a type
alias can still lose native type evidence (`${detached[0]}`). The direct
readonly Array return is covered by the independent-copy fixture; richer alias
indexing evidence remains queued rather than being hidden by an application
workaround.

## Native subclass pressure from Zapp window resizing (2026-09-09)

An isolated resize probe established that stepping window geometry updates the
WebView viewport during the animation, but naive delegate-only interception lost
the restore frame when zoom was interrupted. The correct native seam requires
subclass dispatch, not more handwritten production Objective-C or an adapter cast
to `NSWindow`.

The first Stage 0 slice now proves one field-free native ARC identity, designated
initialization, real override/super dispatch, base-reference conversion, and
repeated exact destruction. The user approved `extends`, `override`, native
selector `as`, and a first `super.init...(...)` in the existing constructor shape.
This does not justify inheriting ordinary Z classes or adding fields before
initialization/teardown callback safety is understood. Native frontend parity,
owned state, native reentrancy, nullable initialization, and suspension remain
explicit work. Details and evidence: [native subclass design](objc-subclass-design.md).

The native parity follow-up exposed a concrete metadata boundary: carrying the
selector and return type is not enough to validate subclass construction or
overrides. ZFDCL v14 now retains designated initialization, required-super and
direct-dispatch restrictions, subclassing restrictions, consuming receiver and
parameter positions, and variadic evidence. Clang supplies consuming-self
ownership for ARC initializer families even without an explicit source
annotation; the native decoder test checks that fact rather than replacing it
with a Z inference. Native syntax parity and raw evidence now pass, while native
semantic resolution still rejects the class with Z0814. The next slice must
consume this evidence before replacing that boundary with native execution.

The next declaration-checking slice found two ways an otherwise correct decoder
could still lose safety: normalization replaced `instancetype` with the owner
type (discarding nullable-initializer evidence), and callable method filtering
dropped unsupported native ABIs (hiding forbidden overrides). The normalized
contract and module signature now retain the unprojected result and all Clang
safety flags. Unsupported methods occupy a separate evidence list, not ordinary
member lookup. Native tests exercise the full path, including a direct
`long double` method that must be rejected as an override without becoming
callable. Inherited restrictions, consumed-parameter positions, initializer
nullability, and exact override signatures are checked natively. Receiver/body
ownership and emission remain explicitly gated; this is not yet permission to
instantiate the subclass through the self-hosted compiler.

The structural body follow-up exposed a useful control-flow distinction:
`return` inside a constructor's match arm or value-producing block still exits
the constructor, but `return` inside a nested closure exits only that closure.
The native checker now walks the statement and expression arenas together,
carrying that boundary explicitly. It also rejects receiver use anywhere in
initializer arguments, repeated initialization hidden in branches, captured or
extracted `super`, and implicit receiver shadowing in destructuring and patterns.
Superclass call selection reuses the ordinary Objective-C label matcher rather
than growing another subtly different selector grammar. Tests compare legal
body shapes with the Stage 0 compiler. This is structural evidence only: it does
not replace typed receiver identity, alias/move analysis, availability, or
executor proof. The native execution gate stays in place until those checks and
lowering are complete.

That comparison also caught an existing Stage 0 constructor bug: the general
field-initialization pass treated a closure-local return as a constructor return.
It now reuses closure capture discovery and leaves the closure's flow to ordinary
closure checking. A closure that captures `this` before *all* fields are initialized
still fails closed, even if it only reads an already initialized field. Writes
inside a closure cannot count as initialization performed by the constructor.

The typed-body follow-up demonstrates why native subclasses need a distinct
reference identity rather than reusing a Z ARC record or simply renaming the
imported base. Their base-pointer ABI permits native calls, but source subclass
names remain nominal: upcasts work while downcasts and sibling conversions fail.
`this` and `super` share one alias identity, and the existing call/loan checker
detects overlapping receiver aliases. Inherited getters/setters use ordinary
property checking; override calls keep their declared Z capabilities. Tests also
reject reinitialization through aliases, missing imported executor capability,
wrong argument/result types, and missing returns. Super initialization and
dispatch have distinct semantic call evidence. Attached superclass ABI evidence
is mandatory before typed bodies are inspected. Availability, full ownership
composition, and emission remain gated, so this is not yet native execution.

Compiling that checker in Z exposed a Stage 0 emission bug unrelated to Objective-C:
a ternary and its condition share a source offset, allowing the String result
type to overwrite the boolean condition's temporary-storage type when that
condition needs String cleanup. Code generation now carries a small, scoped
boolean type override for the condition, restoring the parent's context for
the result branches without cloning the full semantic type map. A strict-C
runtime regression exercises both branches repeatedly. This was fixed upstream
rather than changing the checker source to avoid an ordinary conditional.

The new sibling-conversion negative caught a second identity shortcut: generic
foreign type canonicalization used the shared native base spelling, collapsing
two source subclasses. Source-defined native references now retain their module
and symbol identity even when their call ABI uses the same base pointer. A
cross-frontend override-call test also found Stage 0 exposing only the header's
parameter contract under a Z override's source name. Source override entries now
retain checked `in` capabilities without changing calls through an imported base
or `super`. The strict-Clang/UBSan fixture exercises the borrowed override call
and still checks exact native destruction across repeated constructions.

The availability follow-up found missing evidence at two boundaries: method and
property availability survived, but interface availability did not, and the
native resolver never received the driver's deployment target. ZFDCL v15 now
carries interface-level facts through normalization into source-visible native
type signatures. The driver passes the existing target platform/minimum version
through module parsing; a compiler-private host probe supplies only the platform
when no target is configured. No new stdlib or target-selection syntax was added.
The checker compares dotted numeric versions without overflow and rejects
unavailable, too-new, or obsoleted bases, overrides, initializers, calls, and
properties. A foreign platform's restriction does not poison a matching host
target. Tests use real Clang attributes, check both version boundaries, and
exercise the full resolver and freshly bootstrapped manifest path. Deprecations
remain retained metadata pending warning reporting. Full subclass execution and
remaining body ownership/availability composition are still gated.

The native subclass ownership audit also found that `typeHasCleanup` alone was
too broad a test for explicit move. It admitted retained Objective-C aliases,
although Stage 0 rejects `move alias` because that reference does not represent
unique ownership. Native operator checking now recognizes imported interfaces,
source subclasses, protocol object identity, nullable references, and transparent
aliases. A second parity gap admitted direct `this` capture whenever the closure
avoided a thread-affine call or had a main-affine function type; structural
checking now preserves Stage 0's existing direct-receiver capture boundary.
Named alias captures are not banned: typed owned closures retain them, and
inline synchronous `in` callbacks can borrow them. The strict-Clang/UBSan fixture
now returns an owned callback from a helper, proves the receiver is still alive,
calls it, and checks zero live native objects after teardown across 200 iterations.

**Next concrete ownership gap:** conversion of a borrowed capturing closure into
a stored function value needs native escape/owned-environment proof. The typed
oracle still accepts a case that Stage 0 rejects. Full native subclass resolution
is explicitly tested to remain gated, so this is evidence to close before native
emission, not an executable safety claim. Continue with stored/returned/passed
closures and nested nonescaping callbacks before lifting that boundary.

### Borrowed-callback forwarding follow-up

The next native closure checkpoint closes the direct conversion gap recorded
above. Inferred lexical closures carry internal borrowed-environment provenance,
preserved through function-signature rebasing and semantic identity. An owning
boundary rejects that provenance before generic inference or a type annotation
can erase it. Tests cover typed storage, aliases, owned/generic arguments,
aggregate fields (including inferred generic fields), fixed arrays, `Option`,
returns, and owned nested captures. Direct lexical invocation, typed `move`
captures, noncapturing function values, and inline synchronous `in` callbacks
remain accepted. This is checker metadata, not new syntax or runtime overhead.

The broader audit also found a **safety gap in both frontends**, not only
native subclass parity (closed by the source-body proof checkpoint below):

```zs
function preserve(in callback: () => i32): () => i32 {
  return callback;
}

function make(): () => i32 {
  const count = 42;
  return preserve((): i32 => count);
}

function main(): i32 {
  const callback = make();
  return callback() - 42;
}
```

Before that fix, Stage 0 accepted this program and emitted a stack-backed borrowed closure with
null environment retain/release hooks. The returned managed function value can
therefore outlive its environment. Copying the callback to a typed local or
capturing it in an owned closure inside `preserve` was also accepted. This was
a checker hole, not permission to write those patterns. A successful compile
or one lucky runtime result is not a lifetime proof.

**Closed: synchronous helper forwarding.** Before accepting a capturing inline
borrowed callback, both frontends now require body-derived evidence about its
destination parameter. The proof accepts direct invocation, conditional uses,
and synchronous forwarding through known named functions, including selective
imports and aliases. Direct method parameters retain the evidence when their
signatures are rebased. Returning, typed aliasing, aggregate storage, owned nested
capture, and forwarding into an unproven helper reject with `Z0212` at the
borrowed closure's call site. Recursive, dynamic, raw, and deferred uses fail
closed; lexical shadowing must not accidentally resolve a global helper.

This is implementation evidence, not a new property of the callable ABI and not
a claim that `in` universally forbids retaining a function value. Owned `move`
callbacks can still be returned through `in` parameters. Imported Objective-C
blocks retain their distinct ARC-backed adapter environment. Tests preserve that
behavior rather than banning all copies of `in` function values. The proof adds
no runtime tags or escape checks and does not change source syntax.

The owned-forwarding runtime probe also found a separate native emission gap:
an inline owned closure maker is a C rvalue, so passing its address as an `in`
argument is invalid C. Native lowering now gives inline callable arguments
call-scoped storage, using the existing borrowed-temporary initialization and
cleanup path. Strict Clang, UBSan, and the allocation ledger check retained
callbacks after their creator returns and final environment/String destruction.
The native subclass execution gate remains; no broader subclass support is
claimed by these closure fixes.

Checkpoint validation: 200 distinct targeted tests passed across language core,
callback nonescape/editor diagnostics, native closure cleanup, native subclass
checks, Objective-C interop, Mutex/memory ownership, fixed-point bootstrapping,
and full frontend graph emission. One Arena test initially hit Bun's default
five-second timeout and passed with the project's 60-second timeout. Website
build and test-tier coverage also pass. This is focused evidence, not a claim
that the entire repository test suite ran.

Broader executable probes also exposed native callable lowering boundaries:
non-void block closures are explicitly gated, and a void lexical closure
mutating an outer scalar originally reached Clang with a copied `const` capture.
The block-capture follow-up below closes the latter without lifting the return
type or native subclass execution gates.

### Native block-capture storage follow-up

The small accumulation probe exposed a representation error, not a missing
language rule:

```zs
let total = 0;
const add = (value: i32): void => {
  total = total + value;
};
add(20);
add(22); // total is now 42
```

Native synchronous `void` block closures now borrow scalar and cleanup-free
value-aggregate storage through pointers in a stack environment. Repeated calls
update the original binding, and a later parent update is visible to the next
call. Immutable captures use const-qualified pointers; `inout` parent parameters
preserve their writable capability. The basic accumulation regression asserts
**zero heap allocations** in both emitters, not merely a balanced allocation
count. The environment has no retain/release hooks and still cannot escape.

Owned `move` block closures instead address their own environment fields. A
mutable captured scalar therefore retains its state between invocations rather
than being copied into a fresh invocation-local variable. The parent's Copy
scalar stays independent. Cleanup-bearing owned captures retain their existing
live guards and deterministic destruction.

Capture discovery now walks executable roots with lexical bindings rather than
scanning a flattened arena. Nested callback bodies and parameter names must not
be mistaken for captures of the outer invocation. Parameter capability rewriting
uses the same scope-aware walk. Additional probes cover nested lexical callbacks,
same-named closure parameters with different capabilities, `inout` helper calls,
typed-error forwarding, and invocation-local cleanup. A hygiene probe also found
that a user capture named `refcount` collided with the environment header in
Stage 0; both emitters now use compiler-reserved counter fields, and native maker
arguments no longer collide with a capture named `environment`.

This does not expand capture permissions. Immutable mutation and borrowed
callback retention still reject in both checkers. Borrowed cleanup-bearing
block captures, broader expression-body capture storage parity, non-void block
return lowering, and asynchronous block callables remain follow-ups. Native
borrowed block environments inside async enclosing functions are explicitly
gated until suspension-stable storage is proven; their C stack lifetime must not
be mistaken for the lifetime of a suspended task frame. Native
subclass execution remains gated until those relevant body compositions and
availability/diagnostic checks have their own evidence.

Checkpoint validation: 243 distinct targeted tests passed across closure
storage/nonescape, core language, async runtime, Objective-C, native C callbacks,
and self-hosting. This includes strict Clang/UBSan plus the allocation ledger,
the fixed-point native bootstrap, and full frontend graph emission. The website
build and test-tier audit pass. This is a focused regression sweep, not the full
repository suite.

## Not tested yet

- child-task output and cross-thread borrows that survive suspension; direct
  await now covers one fresh cleanup-bearing aggregate input, while concurrent
  child-task borrows remain scope-owned named storage;
- broader retained parameter-provenanced aggregates: the one-owner synchronous
  named-struct tier now has positive, negative, native-frontend, hover,
  last-use, method, forwarding, `in` consumer, object-destructuring, and
  borrowed-pointer lowering evidence; nesting, multi-owner fields within one
  result, class/mutable receivers, and suspension remain open;
- broader mutable shared ARC identity beyond direct local, direct
  value-struct-field, and audited one-return aggregate alias evidence;
  nested/stored/general returned aggregate
  provenance, nested-class/dynamic shape stability,
  concurrent weak upgrade, native sendability
  inference, and destruction-affinity protocols; Copy snapshots, unique owner
  transfer, and deeply readonly atomic ARC sharing now cross one native thread;
- cyclic application graphs under ORC;
- storing move-only native values in ARC fields or owned closure environments;
  compiler `Option`/`Result` payloads, direct native async locals and owned
  parameters, immutable scoped async borrows, direct-awaited and scope-bounded
  child-task mutable borrows, whole Z value aggregates containing them, and
  fallible results now survive suspension, return/await relay, `try`/`attempt`,
  match, failure, and cancellation;
- broader nested and returned generic channel endpoint storage beyond the
  verified aliased cross-module fields, plus application-lifetime ownership-bearing
  `thread.spawn` tasks supervised and joined entirely by fixed-point Z;
- Windows C++ UI ownership and callback shapes.
- a Rust-produced native library with opaque ownership, escaping callbacks,
  thread-affinity contracts, Cargo-driven artifact preparation, and a complete
  Servo rendering/event-loop integration.

Each belongs in a vertical application probe before its design is treated as
settled.

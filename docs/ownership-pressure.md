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
constructors and broader expression composition remain intrinsic pressure
points. Direct `return try call()` already relays an ABI-identical result after
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
`check`, `emit`, `build`, and explicit-output `run` commands over one
`NativeProject` owner, proving that the parsed module array and resolved graph
can move together across a driver API without representation casts. `run`
builds, launches without a shell, forwards owned String arguments after `--`,
and returns the child status.

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

This composition pressure exposed one real ownership rule rather than a
bootstrap exception. Constructing a cleanup-bearing `ModuleSource` directly in
the borrowed `parseModule` argument did not provide a named lifetime, so Z
rejected it. Binding the source first makes its lifetime explicit across the
call and allows deterministic cleanup after parsing. A second boundary remained
deliberately visible: native console lowering currently accepts a syntactic
String or template, so forwarding a dynamic diagnostic currently uses:

```z
console.error(`${message}`);
```

General typed console values remain outside the self-hosting subset.

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
the self-hosting subset. Manifest loading, foreign header and `.zd` ingestion,
target/link configuration, manifest-selected/custom profiles, complete
diagnostics, automatic temporary run artifacts, and production command options
remain to cross independently.

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

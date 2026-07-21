# Source inspector

This application is a small, readable pressure test for the APIs a future
self-hosted Z frontend will need. It reads an actual Z source file and runs a
real tokenizer over its UTF-8 storage, producing owned tokens with byte offsets,
line and column locations, decoded string literals, and typed lexer errors.

Run it against its own lexer:

```sh
bun run z run examples/applications/source-inspector/main.z -- \
  examples/applications/source-inspector/lexer.z
```

The lexer deliberately uses `byteLength` and `byteAt` because compiler source
locations are byte offsets. `copyBytes(start, end)` creates an owned token-sized
`String` and checks that both ends fall on UTF-8 boundaries. Escape decoding
uses the move-only `TextBuffer` from `std/text`: unchanged source chunks append
without allocating substrings, while `finish()` transfers the completed bytes
into an owned `String` token.

The lexer now emits exact parser-facing kinds for Z's current reserved keywords,
punctuation, operators, and template interpolation boundaries. `move` and `view`
deliberately remain identifiers because the stage-0 parser treats them as
contextual keywords. Comments are trivia, matching the stage-0 lexer. Decimal
and exponent forms are single number tokens, malformed exponents are typed lexer
errors, and unknown bytes are rejected rather than accepted as generic symbols.

Run its focused grammar checks with:

```sh
bun run z run examples/applications/source-inspector/lexer-smoke.z
```

[`token-stream.z`](token-stream.z) is the first stage-1 bridge. It emits a stable
tab-separated token stream with fixed-width hexadecimal locations and
hexadecimal token text. It buffers the complete stream and performs one native
write rather than flushing once per token. The TypeScript driver exposes the
parity path directly:

```sh
bun run z self-host-lex examples/applications/source-inspector/lexer.z
```

That command compiles the bridge with stage 0, runs it natively, and compares
its complete token sequence and source locations with the bootstrap lexer.

[`parser.z`](parser.z) is the first parser foundation. It consumes those owned
tokens with a linear cursor and builds a declaration skeleton containing source
locations, declaration kinds, names, and export/async state. Top-level function
nodes additionally retain generic parameters and multi-trait constraints,
receiver and parameter capabilities, nested type references, return types, and
typed `throws`. Struct and class nodes retain generic constraints, implemented
traits, field visibility and mutability, constructors, static/async/receiver
methods, and `deinit`; trait signatures and enum payload variants are also
structural nodes. Function and lifecycle bodies retain projected variable,
assignment, return, throw, select, expression, break/continue, and nested-block
statements in flat arenas with integer child edges. Assignments have separate
target and value roots. Structured `if`, `else if`, and `else` retain condition
roots plus explicit branch edges; single statements and braced branches use the
same block representation. `while` retains a condition and required body edge;
`for...of` retains its immutable binding, iterable, and required body edge.
Statement and expression `match` forms share flat subject and arm nodes;
payload bindings, object patterns, aliases, and arm bodies are structural.
`async scope` retains its required body as a lexical structured-join edge.
Value-producing `if` expressions retain condition and value-block edges, with
else-if nodes linked directly and branch statements stored in the shared arena.
Executor placement retains sync/await/spawn mode, exact `on` location, executor
root, optional result/error types, and body statements in the same flat model.
Supported expressions use a separate flat owned arena;
block-bodied closure nodes reference roots in the enclosing statement arena.
Generic expression and member names retain canonical nested type arguments, so
collection constructors such as `Array<Token>()` are structural rather than
opaque.
Unsupported statement and expression forms remain traversable canonical spans.
Only text retained in the tree becomes an owned snapshot.
Run exact stage-0 parity across one or more source files with:

```sh
bun run z self-host-parse examples/applications/source-inspector/lexer.z \
  examples/applications/source-inspector/parser.z
```

The parity command checks canonical function signatures, complete type shapes,
function-body statements, and flat expression arenas as well as declaration
metadata. Its adversarial corpus covers nested generics, function types, fixed
arrays, `view`, nullability, capabilities, aggregate modifiers, constructors,
methods, lifecycle cleanup, traits, enum payloads, scalar and aggregate
expressions, operator precedence, Z prefix forms, nested template interpolation,
and closures with borrow/move capture, typed parameters, expression bodies, or
projected block bodies. Assignments, non-branching control statements,
conditionals, loops, matches, async scopes, value-producing `if` expressions,
enum payload construction, and explicit `out`/`inout` call arguments are
structural too. Generic callees and generic member calls preserve their complete
canonical names. Unicode identifiers and the complete syntax tree remain future
slices. Stage 0 and stage 1 expose one
UTF-16 code-unit coordinate contract for offsets and columns while stage 1 keeps
separate UTF-8 byte indexes for native slicing. Exact parity covers both BMP and
supplementary text. `parser-protocol.z` owns the shared framing,
`parser-stream.z` remains a standalone executable client, and
`parser-library.z` is compiled into a content-addressed dynamic library. The Bun
driver passes source bytes directly to that library through a narrow FFI wrapper,
so parser parity no longer pays subprocess startup or native-side file I/O.
Performance comparisons remain provisional until stage 1 covers the same
frontend work as stage 0 and the temporary text protocol is replaced.

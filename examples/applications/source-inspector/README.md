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
punctuation, and operators. `move` and `view` deliberately remain identifiers
because the stage-0 parser treats them as contextual keywords. Decimal and
exponent forms are single number tokens, malformed exponents are typed lexer
errors, and unknown bytes are rejected rather than accepted as generic symbols.

Run its focused grammar checks with:

```sh
bun run z run examples/applications/source-inspector/lexer-smoke.z
```

This is still an incremental frontend rather than the production Z lexer.
Template delimiters are currently preserved as explicit backtick/dollar tokens;
interpolation modes, Unicode identifiers, block comments, and a Z parser remain
future slices.

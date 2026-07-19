# Source inspector

This application is a small, readable pressure test for the APIs a future
self-hosted Z lexer will need. It reads an actual Z source file, walks its UTF-8
storage with checked byte offsets, ignores quoted text and line comments, and
reports simple lexical statistics.

Run it against its own scanner:

```sh
bun run z run examples/applications/source-inspector/main.z -- \
  examples/applications/source-inspector/scanner.z
```

The example deliberately uses `byteLength` and `byteAt` because compiler source
locations are byte offsets. `copyBytes(start, end)` creates an owned token-sized
`String` and checks that both ends fall on UTF-8 boundaries. The future
`String.length` API is reserved for user-perceived Unicode characters rather
than inheriting JavaScript's UTF-16 behavior.

This is not yet the production Z lexer. In particular, it treats quoted regions
as opaque instead of recursively scanning template interpolation. Its purpose is
to exercise the ownership, file I/O, checked byte access, and source-module
shapes that a direct lexer port will build on.

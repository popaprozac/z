# Z curl

This application is a shimless libcurl interoperability pressure test. It
imports `curl/curl.h` directly and uses the adjacent `curl.h.zd` only for
semantic facts the C header does not express:

- global initialization status projection;
- a fixed `CURL_GLOBAL_ALL` policy argument;
- owned nullable `CURL *` creation;
- deterministic `curl_easy_cleanup`;
- borrowed easy-handle operations; and
- `CURLcode` failures as typed Z errors;
- symbolic `CURLE_OK` status evidence; and
- a checked `CURLOPT_URL` variadic overload with a `cstring` value; and
- a checked `CURLOPT_TIMEOUT` overload whose declaration-only `clong` preserves
  C `long`'s target ABI; and
- an owner-tied `CURLOPT_WRITEFUNCTION` callback projected as
  `move (bytes: Slice<u8>): usize throws WriteError => ...`; and
- `failure CURL_WRITEFUNC_ERROR;`, which narrows a thrown Z callback error to
  libcurl's callback ABI failure sentinel.

Run it from the repository root:

```sh
bun run z run examples/applications/z-curl/main.zs
```

The application performs a real HTTPS `GET https://example.com`. libcurl
delivers response chunks through a Z closure, which logs each borrowed
`Slice<u8>` length and reports the consumed byte count to C. It therefore
requires network connectivity when run. Compiler regressions use a separate
local fixture and do not depend on the network.

The callback and context are installed as one checked operation even though the
C ABI uses two separate `curl_easy_setopt` calls. The returned
`native.Connection` retains the closure and lexically borrows the easy handle.
Its cleanup resets `CURLOPT_WRITEFUNCTION`, resets `CURLOPT_WRITEDATA`, and
releases the closure before `curl_easy_cleanup` can run.

The adjacent declaration states `invoked repeatedly`: libcurl may deliver zero
or more body chunks. This cardinality is independent of the connection
lifetime. Z checks both facts rather than inferring one from the other.
Its named `project bytes: Slice<u8> { ... }` block combines libcurl's
`buffer`, `size`, and `nitems` callback parameters into that one safe closure
parameter without repeating the native length expression at the call site.

The callback's ordinary `usize` return is passed directly to libcurl. If it
throws, the adapter destroys the `WriteError` payload immediately and returns
`CURL_WRITEFUNC_ERROR`. libcurl then widens that failure fact into
`CURLE_WRITE_ERROR` from `curl_easy_perform`, which reaches Z through the
ordinary typed `CURLcode` error channel. The original `WriteError` payload
cannot cross C's narrower ABI and therefore never reaches a Z `try` or
`attempt` handler.

For callbacks marked `invoked repeatedly`, prefer small cleanup-free error
payloads. A cleanup-bearing payload such as an owned `String` is valid and is
destroyed correctly, but constructing and immediately destroying it on every
failing invocation can add hidden hot-path work.

`Slice<u8>` is already borrowed in Z. The callback therefore spells
`move (bytes: Slice<u8>)`, not `move (in bytes: Slice<u8>)`: `move` transfers
the escaping closure environment, while the callback bytes remain a
non-escaping view.

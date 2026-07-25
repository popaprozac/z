# Z curl

This application is a shimless libcurl interoperability pressure test. It
imports `curl/curl.h` directly and uses the adjacent `curl.h.zd` only for
semantic facts the C header does not express:

- global initialization status projection;
- a fixed `CURL_GLOBAL_ALL` policy argument;
- owned nullable `CURL *` creation;
- deterministic `curl_easy_cleanup`;
- borrowed easy-handle operations; and
- `CURLcode` failures as typed Z errors.

Run it from the repository root:

```sh
bun run z run examples/applications/z-curl/main.zs
```

The smoke request uses `file:///etc/hosts`, so it exercises libcurl without
depending on external network access.

The remaining deliberate gap is `curl_easy_setopt`: its C varargs change type
according to the `CURLoption` value. Z currently preserves and compiles the raw
variadic call, but `.zd` cannot yet describe that discriminated relationship,
so editor and semantic checking do not verify the third argument. Callback and
context options are a deeper follow-up because libcurl installs them in
separate calls.

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
  C `long`'s target ABI.

Run it from the repository root:

```sh
bun run z run examples/applications/z-curl/main.zs
```

The application performs a real HTTPS `GET https://example.com` and lets
libcurl stream the response body to standard output. It therefore requires
network connectivity when run. Compiler regressions use a separate local
fixture and do not depend on the network.

The first discriminated variadic slice deliberately covers URL and timeout
options. Callback and context options are the deeper follow-up because libcurl
installs them in separate calls and their shared lifetime must be tied to the
easy handle.

# Z build-latency checkpoint

2026-09-08T15:33:04.827Z

24 modules × 16 helpers, 3 trials per driver.
Apple M4 Pro; darwin 25.4.0 arm64.

Wall time of z build only. Executable/checksum validation excluded. Fresh project caches; warm host filesystem/toolchain. Debug O0; release O2. No GUI or Zapp prerequisites.

Medians (min–max); complete raw samples and toolchain identities in the adjacent JSON.

| Scenario | Stage 0 | Native |
| --- | ---: | ---: |
| fresh-project-cache | 0.316 s (0.300–0.447) | 0.317 s (0.230–0.323) |
| unchanged | 0.309 s (0.301–0.322) | 0.050 s (0.049–0.051) |
| one-module-change | 0.302 s (0.298–0.312) | 0.182 s (0.179–0.196) |
| source-unchanged | 0.303 s (0.302–0.310) | 0.052 s (0.049–0.057) |
| transitive-header-change | 0.303 s (0.298–0.346) | 0.245 s (0.241–0.247) |
| header-unchanged | 0.304 s (0.301–0.308) | 0.049 s (0.046–0.051) |
| switch-to-release | 0.296 s (0.292–0.297) | 0.181 s (0.181–0.188) |
| release-unchanged | 0.292 s (0.289–0.309) | 0.053 s (0.047–0.054) |
| return-to-debug | 0.302 s (0.298–0.308) | 0.169 s (0.168–0.179) |
| debug-unchanged | 0.308 s (0.308–0.309) | 0.052 s (0.048–0.054) |

Source and transitive-header changes alter the verified executable checksum.
Every native unchanged row must report a cache hit; every changed/profile-switch
row must miss. This measures whole-project caching, not module-level incremental
compilation. Compiler replacement, generated overlays, .zd changes, peak memory,
and cold-machine SDK setup require separate probes.

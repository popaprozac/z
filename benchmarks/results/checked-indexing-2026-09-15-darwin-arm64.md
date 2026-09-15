# Checked-indexing checkpoint

2026-09-15T22:40:31.970Z

Compiler 684ce9803a5a8185753b88764dc7f2207b74c9bb; worktree dirty: true. Apple M4 Pro; darwin 25.4.0 arm64.

4096 elements × 32768 rounds (134217728 operations), 2 warmups, 9 samples per variant.

Kernel clock time only. Setup, allocation, cleanup, compilation and process startup excluded. Data-dependent wrapping checksum prevents loop folding. Identical Clang profiles; bounds-removed variants change only array indexing guards and are valid-input experiments, not safe programs on arbitrary inputs. UBSan and independent BigInt oracle validate small inputs; checked C validates measured checksums. No allocation counts or engine-speed claims. Normal optimizer inlining; caller buffer construction is visible to Clang.

Medians (min–max) in milliseconds. Negative reduction means the experimental variant was slower; small differences need repeated runs.

| Kernel | Profile | Emitter | Checked | Bounds removed | Median reduction |
| --- | --- | --- | ---: | ---: | ---: |
| linear | O2 | c | 102.805 (102.298–107.959) | 103.564 (102.033–108.169) | -0.7% |
| linear | O2 | stage0 | 102.808 (101.774–105.780) | 103.733 (101.840–105.248) | -0.9% |
| linear | O2 | native | 104.310 (102.275–110.276) | 103.791 (101.953–129.418) | 0.5% |
| linear | O3 | c | 102.734 (101.908–109.475) | 103.259 (102.040–106.970) | -0.5% |
| linear | O3 | stage0 | 104.199 (102.388–108.428) | 104.196 (102.060–147.216) | 0.0% |
| linear | O3 | native | 103.615 (102.018–110.588) | 103.686 (102.308–105.677) | -0.1% |
| indirect | O2 | c | 103.445 (101.972–107.154) | 103.144 (102.397–108.347) | 0.3% |
| indirect | O2 | stage0 | 104.545 (102.068–107.041) | 103.766 (101.937–106.255) | 0.7% |
| indirect | O2 | native | 102.974 (101.863–107.449) | 103.367 (101.936–105.793) | -0.4% |
| indirect | O3 | c | 114.350 (105.610–155.392) | 112.585 (103.394–135.451) | 1.5% |
| indirect | O3 | stage0 | 108.275 (102.361–141.666) | 114.651 (103.748–123.800) | -5.9% |
| indirect | O3 | native | 105.137 (102.501–144.798) | 119.146 (102.260–168.879) | -13.3% |
| registers-direct | O2 | c | 46.327 (45.850–49.383) | 46.345 (46.016–48.166) | -0.0% |
| registers-direct | O2 | stage0 | 48.912 (46.066–51.554) | 48.802 (46.191–50.880) | 0.2% |
| registers-direct | O2 | native | 46.867 (46.189–51.073) | 46.369 (45.928–47.999) | 1.1% |
| registers-direct | O3 | c | 46.424 (46.089–49.843) | 46.015 (45.583–49.612) | 0.9% |
| registers-direct | O3 | stage0 | 46.111 (45.911–48.331) | 47.154 (45.669–52.130) | -2.3% |
| registers-direct | O3 | native | 47.521 (46.111–50.560) | 46.685 (45.765–50.250) | 1.8% |
| registers-view | O2 | c | 46.908 (45.824–51.489) | 46.370 (46.200–51.241) | 1.1% |
| registers-view | O2 | stage0 | 46.239 (45.910–46.974) | 46.395 (45.934–54.026) | -0.3% |
| registers-view | O2 | native | 46.434 (46.118–53.669) | 48.176 (45.956–50.624) | -3.8% |
| registers-view | O3 | c | 48.964 (46.466–52.110) | 46.744 (45.746–55.009) | 4.5% |
| registers-view | O3 | stage0 | 47.764 (46.359–59.268) | 46.807 (46.084–51.133) | 2.0% |
| registers-view | O3 | native | 46.662 (46.359–67.075) | 47.542 (46.833–51.269) | -1.9% |

Raw samples, toolchain, checksums, exact source hashes, changed helper names and compilation observations are in the adjacent JSON. Generated C, optimized LLVM IR and assembly remain under `benchmarks/.build/checked-indexing/run-vBzAme`. Native rows use the bootstrapped driver, including imported-header metadata. The adjacent bootstrap C is verified against current self-emission; binary and source hashes are recorded. Single emission/build timings are observations, not a comparative compiler-speed result.

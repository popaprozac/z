# Checked-indexing checkpoint

2026-09-16T00:10:07.755Z

Compiler db73fb6cc5472a14a1ed1194cf00571ef01d6a14; worktree dirty: true. Apple M4 Pro; darwin 25.4.0 arm64.

4096 elements × 32768 rounds (134217728 operations), 2 warmups, 9 samples per variant.

Kernel clock time only. Setup, allocation, cleanup, compilation and process startup excluded. Data-dependent wrapping checksum prevents loop folding. Identical Clang profiles; bounds-removed variants change only array indexing guards and are valid-input experiments, not safe programs on arbitrary inputs. UBSan and independent BigInt oracle validate small inputs; checked C validates measured checksums. No allocation counts or engine-speed claims. Normal optimizer inlining; caller buffer construction is visible to Clang.

Medians (min–max) in milliseconds. Negative reduction means the experimental variant was slower; small differences need repeated runs.

| Kernel | Profile | Emitter | Checked | Bounds removed | Median reduction |
| --- | --- | --- | ---: | ---: | ---: |
| linear | O2 | c | 96.880 (96.139–97.779) | 96.466 (94.414–98.175) | 0.4% |
| linear | O2 | stage0 | 96.297 (95.528–97.987) | 97.009 (96.164–98.636) | -0.7% |
| linear | O2 | native | 97.357 (95.891–99.030) | 96.743 (95.782–100.757) | 0.6% |
| linear | O3 | c | 96.782 (94.866–97.625) | 96.717 (95.227–97.736) | 0.1% |
| linear | O3 | stage0 | 97.269 (94.843–98.316) | 96.963 (95.077–97.827) | 0.3% |
| linear | O3 | native | 97.130 (93.978–97.950) | 97.223 (95.659–97.799) | -0.1% |
| indirect | O2 | c | 99.106 (98.124–101.151) | 97.315 (96.265–98.297) | 1.8% |
| indirect | O2 | stage0 | 98.851 (97.894–100.118) | 97.461 (96.334–116.232) | 1.4% |
| indirect | O2 | native | 99.171 (97.562–102.288) | 97.040 (95.403–97.892) | 2.1% |
| indirect | O3 | c | 99.207 (97.679–100.835) | 97.435 (95.877–98.845) | 1.8% |
| indirect | O3 | stage0 | 98.766 (96.826–101.238) | 97.246 (96.597–97.947) | 1.5% |
| indirect | O3 | native | 98.887 (97.383–100.211) | 97.409 (96.066–98.428) | 1.5% |
| registers-direct | O2 | c | 46.461 (46.029–47.279) | 46.196 (45.167–46.897) | 0.6% |
| registers-direct | O2 | stage0 | 46.350 (45.794–61.750) | 46.262 (46.027–47.721) | 0.2% |
| registers-direct | O2 | native | 46.382 (45.852–48.278) | 46.239 (45.823–46.648) | 0.3% |
| registers-direct | O3 | c | 45.858 (45.187–46.377) | 45.912 (45.092–46.397) | -0.1% |
| registers-direct | O3 | stage0 | 46.482 (46.120–47.560) | 46.297 (45.990–46.500) | 0.4% |
| registers-direct | O3 | native | 46.393 (45.711–46.850) | 46.227 (45.548–47.563) | 0.4% |
| registers-view | O2 | c | 46.193 (45.598–46.757) | 46.539 (45.490–46.999) | -0.7% |
| registers-view | O2 | stage0 | 46.184 (45.469–46.775) | 46.257 (45.431–62.326) | -0.2% |
| registers-view | O2 | native | 46.080 (45.854–46.377) | 46.184 (45.623–47.737) | -0.2% |
| registers-view | O3 | c | 46.305 (45.836–46.581) | 45.884 (45.664–46.760) | 0.9% |
| registers-view | O3 | stage0 | 46.157 (45.539–46.547) | 46.475 (45.932–47.601) | -0.7% |
| registers-view | O3 | native | 46.447 (46.014–46.829) | 46.277 (46.075–46.868) | 0.4% |

Raw samples, toolchain, checksums, exact source hashes, changed helper names and compilation observations are in the adjacent JSON. Generated C, optimized LLVM IR and assembly remain under `benchmarks/.build/checked-indexing/run-jJ0Nn8`. Native rows use the bootstrapped driver, including imported-header metadata. The adjacent bootstrap C is verified against current self-emission; binary and source hashes are recorded. Single emission/build timings are observations, not a comparative compiler-speed result.

proc z_bench_iterations(): uint64 {.importc.}
proc z_bench_now_ns(): uint64 {.importc.}
proc z_bench_report(name: cstring, nanoseconds: uint64, checksum: uint64) {.importc.}

proc main() =
  let iterations = z_bench_iterations()
  var index = 0'u64
  var checksum = 0x9e3779b97f4a7c15'u64
  let started = z_bench_now_ns()

  while index < iterations:
    checksum = (checksum xor index) * 1099511628211'u64
    index += 1

  z_bench_report("arithmetic", z_bench_now_ns() - started, checksum)

main()

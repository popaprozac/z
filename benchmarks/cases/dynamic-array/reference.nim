proc z_bench_iterations(): uint64 {.importc.}
proc z_bench_now_ns(): uint64 {.importc.}
proc z_bench_report(name: cstring, nanoseconds: uint64, checksum: uint64) {.importc.}

proc main() =
  let iterations = z_bench_iterations()
  var values: seq[uint64] = @[]
  var index = 0'u64
  let started = z_bench_now_ns()

  while index < iterations:
    values.add(index)
    index += 1

  var checksum = 0'u64
  var read = 0
  while read < values.len:
    checksum += values[read]
    read += 1

  z_bench_report("dynamic-array", z_bench_now_ns() - started, checksum)

main()

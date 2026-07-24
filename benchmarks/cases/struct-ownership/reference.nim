proc z_bench_iterations(): uint64 {.importc.}
proc z_bench_now_ns(): uint64 {.importc.}
proc z_bench_drop(value: uint64) {.importc.}
proc z_bench_report(name: cstring, nanoseconds: uint64, checksum: uint64) {.importc.}

type Resource = object
  value: uint64

proc `=destroy`(resource: Resource) =
  z_bench_drop(resource.value)

proc `=copy`(destination: var Resource, source: Resource) {.error.}

proc consume(resource: sink Resource): uint64 =
  resource.value

proc main() =
  let iterations = z_bench_iterations()
  var index = 0'u64
  var checksum = 0'u64
  let started = z_bench_now_ns()

  while index < iterations:
    let resource = Resource(value: index)
    checksum += consume(resource)
    index += 1

  z_bench_report("struct-ownership", z_bench_now_ns() - started, checksum)

main()

#include "../../support/bench.h"

#include <stdint.h>

int main(void) {
  const uint64_t iterations = z_bench_iterations();
  uint64_t index = 0;
  uint64_t checksum = 0;
  const uint64_t started = z_bench_now_ns();

  while (index < iterations) {
    checksum ^= z_bench_mix(index);
    index += 1;
  }

  z_bench_report("direct-c-call", z_bench_now_ns() - started, checksum);
  return 0;
}

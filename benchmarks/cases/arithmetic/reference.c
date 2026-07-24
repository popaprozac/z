#include "../../support/bench.h"

#include <stdint.h>

int main(void) {
  const uint64_t iterations = z_bench_iterations();
  uint64_t index = 0;
  uint64_t checksum = UINT64_C(0x9e3779b97f4a7c15);
  const uint64_t started = z_bench_now_ns();

  while (index < iterations) {
    checksum = (checksum ^ index) * UINT64_C(1099511628211);
    index += 1;
  }

  z_bench_report("arithmetic", z_bench_now_ns() - started, checksum);
  return 0;
}

#include "../../support/bench.h"

#include <cstdint>
#include <utility>

class Resource {
 public:
  explicit Resource(std::uint64_t value) : value_(value), live_(true) {}
  Resource(const Resource&) = delete;
  Resource& operator=(const Resource&) = delete;
  Resource(Resource&& other) noexcept : value_(other.value_), live_(other.live_) {
    other.live_ = false;
  }
  ~Resource() {
    if (live_) z_bench_drop(value_);
  }

  std::uint64_t value() const { return value_; }

 private:
  std::uint64_t value_;
  bool live_;
};

static std::uint64_t consume(Resource resource) {
  return resource.value();
}

int main() {
  const std::uint64_t iterations = z_bench_iterations();
  std::uint64_t index = 0;
  std::uint64_t checksum = 0;
  const std::uint64_t started = z_bench_now_ns();

  while (index < iterations) {
    checksum += consume(Resource(index));
    index += 1;
  }

  z_bench_report("struct-ownership", z_bench_now_ns() - started, checksum);
  return 0;
}

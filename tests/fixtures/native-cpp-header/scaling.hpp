#pragma once

#include <array>
#include <stdint.h>

// Valid only as C++: the program that imports it must compile as C++.
inline int32_t scaled_total(int32_t factor) {
  constexpr std::array<int32_t, 3> values{1, 2, 3};
  int32_t total = 0;
  for (const auto value : values) total += value * factor;
  return total;
}

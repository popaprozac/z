#pragma once

#include <stdint.h>

namespace zcpp {

inline int32_t unique_created = 0;
inline int32_t unique_moved = 0;
inline int32_t unique_released = 0;

class UniqueValue {
public:
  explicit UniqueValue(int32_t value) : value_(new int32_t(value)) {
    unique_created += 1;
  }

  UniqueValue(const UniqueValue &) = delete;
  UniqueValue &operator=(const UniqueValue &) = delete;

  UniqueValue(UniqueValue &&other) noexcept : value_(other.value_) {
    other.value_ = nullptr;
    unique_moved += 1;
  }

  UniqueValue &operator=(UniqueValue &&other) noexcept {
    if (this != &other) {
      if (value_ != nullptr) {
        delete value_;
        unique_released += 1;
      }
      value_ = other.value_;
      other.value_ = nullptr;
      unique_moved += 1;
    }
    return *this;
  }

  ~UniqueValue() {
    if (value_ != nullptr) {
      delete value_;
      unique_released += 1;
    }
  }

  int32_t value() const {
    return value_ == nullptr ? -1 : *value_;
  }

private:
  int32_t *value_;
};

inline int32_t unique_live() {
  return unique_created - unique_released;
}

inline int32_t unique_moves() {
  return unique_moved;
}

} // namespace zcpp

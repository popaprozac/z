#pragma once

#include <stdint.h>
#include <utility>

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

  int32_t value() const & {
    return value_ == nullptr ? -1 : *value_;
  }

  void add(int32_t amount) & {
    if (value_ != nullptr) *value_ += amount;
  }

  int32_t finish(int32_t offset) && {
    UniqueValue consumed(std::move(*this));
    return consumed.value() + offset;
  }

  int32_t qualified() const & {
    return value();
  }

  int32_t qualified() && {
    return std::move(*this).finish(0);
  }

private:
  int32_t *value_;
};

inline int32_t inspect_unique(const UniqueValue &value) {
  return value.value();
}

inline void adjust_unique(UniqueValue &value, int32_t amount) {
  value.add(amount);
}

inline int32_t consume_unique(UniqueValue &&value) {
  UniqueValue consumed(std::move(value));
  return consumed.value();
}

inline int32_t qualified_unique(const UniqueValue &value) {
  return value.value();
}

inline int32_t qualified_unique(UniqueValue &&value) {
  return std::move(value).finish(0);
}

inline int32_t unique_live() {
  return unique_created - unique_released;
}

inline int32_t unique_moves() {
  return unique_moved;
}

} // namespace zcpp

#pragma once

#include <stdint.h>

namespace zcpp {

inline int32_t managed_created = 0;
inline int32_t managed_copied = 0;
inline int32_t managed_released = 0;

class ManagedValue {
public:
  explicit ManagedValue(int32_t value) : value_(value) {
    managed_created += 1;
  }

  ManagedValue(const ManagedValue &other) : value_(other.value_) {
    managed_copied += 1;
  }

  ManagedValue &operator=(const ManagedValue &other) {
    value_ = other.value_;
    managed_copied += 1;
    return *this;
  }

  ManagedValue(ManagedValue &&) = delete;
  ManagedValue &operator=(ManagedValue &&) = delete;

  ~ManagedValue() {
    managed_released += 1;
  }

  int32_t value() const {
    return value_;
  }

  void add(int32_t amount) {
    value_ += amount;
  }

  int32_t plus(int32_t amount) const {
    return value_ + amount;
  }

  double plus(double amount) const {
    return static_cast<double>(value_) + amount;
  }

private:
  int32_t value_;
};

inline ManagedValue make_managed(int32_t value) {
  return ManagedValue(value);
}

inline int32_t read_managed(const ManagedValue &value) {
  return value.value();
}

inline int32_t managed_live() {
  return managed_created + managed_copied - managed_released;
}

inline int32_t managed_copies() {
  return managed_copied;
}

inline int32_t managed_drops() {
  return managed_released;
}

} // namespace zcpp

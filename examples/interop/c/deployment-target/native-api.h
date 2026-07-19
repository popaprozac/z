#ifndef Z_EXAMPLE_NATIVE_API_H
#define Z_EXAMPLE_NATIVE_API_H

static inline int z_current(int value) {
  return value;
}

static inline int z_legacy(int value)
  __attribute__((availability(macos, introduced=10.12, deprecated=13.0, message="use z_current")));

static inline int z_legacy(int value) {
  return z_current(value);
}

#endif

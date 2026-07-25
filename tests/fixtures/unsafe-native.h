#ifndef Z_UNSAFE_NATIVE_H
#define Z_UNSAFE_NATIVE_H

typedef struct ZUnsafeHandle {
  int value;
} ZUnsafeHandle;

typedef struct ZUnsafeOther {
  int value;
} ZUnsafeOther;

static inline char *z_unsafe_version(void) {
  static char version[] = "unsafe-native";
  return version;
}

static inline ZUnsafeHandle *z_unsafe_open(int value) {
  static ZUnsafeHandle handle;
  handle.value = value;
  return &handle;
}

static inline int z_unsafe_read(ZUnsafeHandle *handle) {
  return handle == 0 ? -1 : handle->value;
}

static inline void z_unsafe_close(ZUnsafeHandle *handle) {
  (void)handle;
}

static inline int z_unsafe_read_other(ZUnsafeOther *other) {
  return other == 0 ? -1 : other->value;
}

#endif

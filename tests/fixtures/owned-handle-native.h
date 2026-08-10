#ifndef Z_TEST_OWNED_HANDLE_NATIVE_H
#define Z_TEST_OWNED_HANDLE_NATIVE_H

#include <stdlib.h>

typedef struct ZOwnedHandle {
  int value;
} ZOwnedHandle;

static int z_owned_handle_closed_count = 0;
static ZOwnedHandle z_owned_handle_default_value = { 41 };

static inline ZOwnedHandle *z_owned_handle_open(int value) {
  if (value < 0) return NULL;
  ZOwnedHandle *handle = (ZOwnedHandle *)malloc(sizeof(ZOwnedHandle));
  if (handle == NULL) return NULL;
  handle->value = value;
  return handle;
}

static inline int z_owned_handle_create(int status, ZOwnedHandle **output) {
  if (status == -2) return status;
  *output = z_owned_handle_open(42);
  if (*output == NULL) return -1;
  return status;
}

static inline int z_owned_handle_read(ZOwnedHandle *handle) {
  return handle == NULL ? -1 : handle->value;
}

static inline ZOwnedHandle *z_owned_handle_default(void) {
  return &z_owned_handle_default_value;
}

static inline void z_owned_handle_close(ZOwnedHandle *handle) {
  if (handle == NULL) return;
  z_owned_handle_closed_count += 1;
  free(handle);
}

static inline int z_owned_handle_closed(void) {
  return z_owned_handle_closed_count;
}

#endif

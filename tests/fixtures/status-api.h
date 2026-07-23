#ifndef Z_TEST_STATUS_API_H
#define Z_TEST_STATUS_API_H

#include <stdlib.h>

typedef struct ZStatusHandle {
  int value;
} ZStatusHandle;

static int z_status_destroyed_handles = 0;

static inline int z_status_open(int status, ZStatusHandle **handle) {
  *handle = (ZStatusHandle *)malloc(sizeof(ZStatusHandle));
  if (*handle == NULL) return -99;
  (*handle)->value = 42;
  return status;
}

static inline void z_status_close(ZStatusHandle *handle) {
  if (handle == NULL) return;
  z_status_destroyed_handles += 1;
  free(handle);
}

static inline int z_status_destroyed(void) {
  return z_status_destroyed_handles;
}

static inline int z_status_plain(int status) {
  return status;
}

#endif

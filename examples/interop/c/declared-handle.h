#ifndef Z_DECLARED_HANDLE_H
#define Z_DECLARED_HANDLE_H

#include <stdlib.h>

typedef struct ZDeclaredHandle ZDeclaredHandle;

static int z_declared_close_count_value = 0;

static inline ZDeclaredHandle *z_declared_open(int value) {
  if (value < 0) return NULL;
  ZDeclaredHandle *handle = (ZDeclaredHandle *)malloc(sizeof(int));
  if (handle) *((int *)handle) = value;
  return handle;
}

static inline int z_declared_read(ZDeclaredHandle *handle) {
  return *((int *)handle);
}

static inline void z_declared_close(ZDeclaredHandle *handle) {
  z_declared_close_count_value += 1;
  free(handle);
}

static inline int z_declared_close_count(void) {
  return z_declared_close_count_value;
}

#endif

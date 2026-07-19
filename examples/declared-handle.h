#ifndef Z_DECLARED_HANDLE_H
#define Z_DECLARED_HANDLE_H

#include <stdlib.h>

typedef struct ZDeclaredHandle ZDeclaredHandle;

static inline ZDeclaredHandle *z_declared_open(int value) {
  ZDeclaredHandle *handle = (ZDeclaredHandle *)malloc(sizeof(int));
  if (handle) *((int *)handle) = value;
  return handle;
}

static inline int z_declared_read(ZDeclaredHandle *handle) {
  return *((int *)handle);
}

static inline void z_declared_close(ZDeclaredHandle *handle) {
  free(handle);
}

#endif

#ifndef Z_CALLBACK_CONNECTION_H
#define Z_CALLBACK_CONNECTION_H

#include <stdarg.h>
#include <stddef.h>
#include <stdlib.h>

typedef enum ZCallbackStatus {
  Z_CALLBACK_OK = 0,
  Z_CALLBACK_FAILED = 1,
} ZCallbackStatus;

typedef enum ZCallbackOption {
  Z_CALLBACK_WRITE = 1,
  Z_CALLBACK_CONTEXT = 2,
} ZCallbackOption;

typedef size_t (*ZCallbackWrite)(
  char *buffer,
  size_t size,
  size_t nitems,
  void *context
);

typedef struct ZCallbackOwner {
  ZCallbackWrite write;
  void *context;
} ZCallbackOwner;

static inline ZCallbackOwner *z_callback_open(void) {
  return (ZCallbackOwner *)calloc(1, sizeof(ZCallbackOwner));
}

static inline void z_callback_close(ZCallbackOwner *owner) {
  free(owner);
}

static inline ZCallbackStatus z_callback_setopt(
  ZCallbackOwner *owner,
  ZCallbackOption option,
  ...
) {
  va_list arguments;
  va_start(arguments, option);
  if (option == Z_CALLBACK_WRITE) {
    owner->write = va_arg(arguments, ZCallbackWrite);
  } else if (option == Z_CALLBACK_CONTEXT) {
    owner->context = va_arg(arguments, void *);
  } else {
    va_end(arguments);
    return Z_CALLBACK_FAILED;
  }
  va_end(arguments);
  return Z_CALLBACK_OK;
}

static inline ZCallbackStatus z_callback_perform(ZCallbackOwner *owner) {
  char payload[] = "hello";
  if (owner->write == NULL) return Z_CALLBACK_FAILED;
  return owner->write(payload, 1, 5, owner->context) == 5
    ? Z_CALLBACK_OK
    : Z_CALLBACK_FAILED;
}

#endif

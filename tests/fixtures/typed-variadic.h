#ifndef Z_TYPED_VARIADIC_H
#define Z_TYPED_VARIADIC_H

#include <stdarg.h>
#include <string.h>

typedef enum {
  Z_TYPED_OK = 0,
  Z_TYPED_BAD_OPTION = 1,
  Z_TYPED_TEXT = 10001,
  Z_TYPED_OTHER = 10002,
  Z_TYPED_UNKNOWN = 10003,
  Z_TYPED_TIMEOUT = 10004
} ZTypedOption;

static const char *z_typed_text = "";

static inline ZTypedOption z_typed_setopt(
  ZTypedOption option,
  ...
) {
  va_list arguments;
  va_start(arguments, option);
  if (option == Z_TYPED_TEXT || option == Z_TYPED_OTHER) {
    z_typed_text = va_arg(arguments, const char *);
  } else if (option == Z_TYPED_TIMEOUT) {
    const long timeout = va_arg(arguments, long);
    if (timeout < 0) {
      va_end(arguments);
      return Z_TYPED_BAD_OPTION;
    }
  } else {
    va_end(arguments);
    return Z_TYPED_BAD_OPTION;
  }
  va_end(arguments);
  return Z_TYPED_OK;
}

static inline int z_typed_length(void) {
  return (int)strlen(z_typed_text);
}

#endif

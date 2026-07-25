#ifndef Z_TYPED_VARIADIC_H
#define Z_TYPED_VARIADIC_H

#include <stdarg.h>
#include <string.h>

typedef enum {
  Z_TYPED_OK = 0,
  Z_TYPED_BAD_OPTION = 1,
  Z_TYPED_TEXT = 10001,
  Z_TYPED_OTHER = 10002,
  Z_TYPED_UNKNOWN = 10003
} ZTypedOption;

static const char *z_typed_text = "";

static inline ZTypedOption z_typed_setopt(
  ZTypedOption option,
  ...
) {
  if (option != Z_TYPED_TEXT && option != Z_TYPED_OTHER) return Z_TYPED_BAD_OPTION;
  va_list arguments;
  va_start(arguments, option);
  z_typed_text = va_arg(arguments, const char *);
  va_end(arguments);
  return Z_TYPED_OK;
}

static inline int z_typed_length(void) {
  return (int)strlen(z_typed_text);
}

#endif

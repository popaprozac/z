#ifndef Z_NATIVE_UNION_H
#define Z_NATIVE_UNION_H

#include <stdbool.h>

typedef union ZNativeEvent {
  int type;
  int integer;
  double decimal;
  void *opaque;
} ZNativeEvent;

static inline bool z_native_poll(ZNativeEvent *event) {
  if (event == 0) return false;
  event->type = 42;
  return true;
}

#endif

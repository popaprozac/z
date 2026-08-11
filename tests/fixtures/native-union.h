#ifndef Z_NATIVE_UNION_H
#define Z_NATIVE_UNION_H

#include <stdbool.h>

#define Z_NATIVE_EVENT_IDLE 0
#define Z_NATIVE_EVENT_VALUE 42
#define Z_NATIVE_EVENT_RESET 43

typedef struct ZNativeValueEvent {
  int type;
  int value;
} ZNativeValueEvent;

typedef union ZNativeEvent {
  int type;
  int integer;
  double decimal;
  ZNativeValueEvent value;
  void *opaque;
} ZNativeEvent;

static inline bool z_native_poll(ZNativeEvent *event) {
  if (event == 0) return false;
  event->value.type = Z_NATIVE_EVENT_VALUE;
  event->value.value = 42;
  return true;
}

#endif

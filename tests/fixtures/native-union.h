#ifndef Z_NATIVE_UNION_H
#define Z_NATIVE_UNION_H

#include <stdbool.h>

#define Z_NATIVE_EVENT_IDLE 0
#define Z_NATIVE_EVENT_VALUE 42
#define Z_NATIVE_EVENT_RESET 43
#define Z_NATIVE_EVENT_TEXT 44

typedef struct ZNativeValueEvent {
  int type;
  int value;
} ZNativeValueEvent;

typedef struct ZNativeTextEvent {
  int type;
  int sequence;
  const char *text;
  void *opaque;
} ZNativeTextEvent;

typedef union ZNativeEvent {
  int type;
  int integer;
  double decimal;
  ZNativeValueEvent value;
  ZNativeTextEvent text;
  void *opaque;
} ZNativeEvent;

static inline bool z_native_poll(ZNativeEvent *event) {
  if (event == 0) return false;
  event->value.type = Z_NATIVE_EVENT_VALUE;
  event->value.value = 42;
  return true;
}

static inline bool z_native_poll_text(ZNativeEvent *event) {
  if (event == 0) return false;
  event->text.type = Z_NATIVE_EVENT_TEXT;
  event->text.sequence = 7;
  event->text.text = "borrowed native text";
  event->text.opaque = 0;
  return true;
}

static inline void z_native_pump(void) {}

#endif

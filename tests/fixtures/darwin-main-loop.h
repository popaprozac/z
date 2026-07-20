#ifndef Z_TEST_DARWIN_MAIN_LOOP_H
#define Z_TEST_DARWIN_MAIN_LOOP_H

#include <CoreFoundation/CoreFoundation.h>

static inline void z_test_run_main_loop(void) {
  CFRunLoopRun();
}

static inline void z_test_stop_main_loop(void) {
  CFRunLoopStop(CFRunLoopGetMain());
}

#endif

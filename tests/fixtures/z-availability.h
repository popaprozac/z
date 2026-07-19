#ifndef Z_TEST_AVAILABILITY_H
#define Z_TEST_AVAILABILITY_H

int z_current(int value);

int z_legacy(int value)
  __attribute__((availability(macos, introduced=10.12, deprecated=13.0, message="use z_current")));

int z_unavailable(int value)
  __attribute__((availability(macos, unavailable, message="not supported on macOS")));

int z_never(int value)
  __attribute__((unavailable("not supported anywhere")));

int z_future(int value)
  __attribute__((availability(macos, introduced=15.0, message="requires the new runtime")));

int z_obsolete(int value)
  __attribute__((availability(macos, obsoleted=13.0, message="use z_current")));

#endif

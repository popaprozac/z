#ifndef Z_TEST_ANONYMOUS_STATUS_H
#define Z_TEST_ANONYMOUS_STATUS_H

typedef enum {
  Z_ANONYMOUS_OK = 0,
  Z_ANONYMOUS_FAILED = 4
} ZAnonymousStatus;

#define Z_ANONYMOUS_FLAG_A (1 << 0)
#define Z_ANONYMOUS_FLAG_B (1 << 1)
#define Z_ANONYMOUS_ALL (Z_ANONYMOUS_FLAG_A | Z_ANONYMOUS_FLAG_B)

static inline ZAnonymousStatus z_anonymous_start(long flags) {
  return flags == Z_ANONYMOUS_ALL ? Z_ANONYMOUS_OK : Z_ANONYMOUS_FAILED;
}

#endif

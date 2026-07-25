#ifndef Z_TEST_BYTE_BUFFER_H
#define Z_TEST_BYTE_BUFFER_H

#include <stddef.h>

static inline int z_byte_sum(const unsigned char *data, size_t length) {
  int total = 0;
  for (size_t index = 0; index < length; index += 1) {
    total += data[index];
  }
  return total;
}

#endif

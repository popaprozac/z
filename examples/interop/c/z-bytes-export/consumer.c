#include "zbytes.h"
#include <stddef.h>
#include <stdio.h>

int main(void) {
  if (zbytes_runtime_initialize(NULL) != ZBYTES_RUNTIME_OK) return 5;
  const uint8_t source[] = { 'A', 0, 0xFF, 'B' };
  if (byteCount(source, sizeof source) != 4) return 1;
  if (byteSum(source, sizeof source) != 386) return 2;
  if (byteCount(NULL, 0) != 0 || byteSum(NULL, 0) != 0) return 3;
  if (combinedByteCount(source, sizeof source, NULL, 0) != 4) return 4;
  puts("4 bytes, sum 386; empty input accepted");
  if (zbytes_runtime_shutdown() != ZBYTES_RUNTIME_OK) return 6;
  return 0;
}

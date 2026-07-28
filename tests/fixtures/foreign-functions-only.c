#include "foreign-functions-only.h"

int z_foreign_add(int left, int right) {
  return left + right;
}

int z_foreign_status(int code) {
  return code;
}

long z_foreign_measure(int value, const char *label) {
  return label == 0 ? value : value + 1;
}

#ifndef Z_TEST_FOREIGN_FUNCTIONS_ONLY_H
#define Z_TEST_FOREIGN_FUNCTIONS_ONLY_H

#define Z_FOREIGN_OK 0
#define Z_FOREIGN_RETRY 2
#define Z_FOREIGN_UNSIGNED 0U

int z_foreign_add(int left, int right);
int z_foreign_status(int code);
long z_foreign_measure(int value, const char *label);

#endif

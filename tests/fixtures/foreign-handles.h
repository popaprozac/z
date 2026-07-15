#ifndef Z_TEST_FOREIGN_HANDLES_H
#define Z_TEST_FOREIGN_HANDLES_H

typedef struct ZTestHandle ZTestHandle;

ZTestHandle *z_test_open(void);
void z_test_close(ZTestHandle *handle);
int z_test_use(ZTestHandle *handle);

#endif

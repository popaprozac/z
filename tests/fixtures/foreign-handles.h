#ifndef Z_TEST_FOREIGN_HANDLES_H
#define Z_TEST_FOREIGN_HANDLES_H

typedef struct ZTestHandle ZTestHandle;
typedef struct ZCreatedHandle ZCreatedHandle;

ZTestHandle *z_test_open(void);
ZTestHandle *z_test_default(void);
int z_test_create(ZCreatedHandle **handle);
void z_test_close(ZTestHandle *handle);
int z_test_use(ZTestHandle *handle);
int z_test_optional(ZTestHandle *handle);
void z_test_created_close(ZCreatedHandle *handle);
int z_test_created_use(ZCreatedHandle *handle);

#endif

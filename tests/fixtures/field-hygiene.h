#ifndef Z_TEST_FIELD_HYGIENE_H
#define Z_TEST_FIELD_HYGIENE_H
typedef struct ZFieldHygiene {
  int template;
  int z_field_template;
  int self;
} ZFieldHygiene;
static inline int z_field_hygiene_sum(ZFieldHygiene value) {
  return value.template + value.z_field_template + value.self;
}
#endif

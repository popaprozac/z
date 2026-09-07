import native from "./field-hygiene.h";

function main(): i32 {
  let record = native.ZFieldHygiene({ template: 10, z_field_template: 20, self: 11 });
  record.template = record.template + 1;
  if (record.template != 11 || record.z_field_template != 20 || record.self != 11) return 1;
  return native.z_field_hygiene_sum(record) - 42;
}

import native from "foreign-functions-only.h";
import {
  z_foreign_add as add,
  z_foreign_status as checkStatus,
} from "foreign-functions-only.h";

function main(): i32 {
  const sum = add(20, 20);
  const extra = native.z_foreign_add(1, 1);
  const outcome = attempt checkStatus(0);
  return match (outcome) {
    success => sum + extra;
    failure(status) => status;
  };
}

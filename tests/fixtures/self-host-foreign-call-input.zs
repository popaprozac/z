import native from "foreign-functions-only.h";
import {
  z_foreign_add as add,
  z_foreign_enum_status as checkEnumStatus,
  z_foreign_status_code as statusCode,
  z_foreign_status as checkStatus,
} from "foreign-functions-only.h";
import {
  Z_FOREIGN_ENUM_FAILED as enumFailed,
} from "foreign-functions-only.h";

function main(): i32 {
  const sum = add(20, 20);
  const extra = native.z_foreign_add(1, 1);
  const outcome = attempt checkStatus(0);
  const enumOutcome = attempt checkEnumStatus(0);
  const namespaceOutcome: Result<void, native.ZForeignStatus> =
    attempt native.z_foreign_enum_status(0);
  const namespaceConstant =
    native.z_foreign_status_code(native.Z_FOREIGN_ENUM_OK);
  const selectedConstant = statusCode(enumFailed);
  const enumStatus = match (enumOutcome) {
    success => 0;
    failure(status) => i32(status);
  };
  if (enumStatus != 0) return enumStatus;
  const namespaceStatus = match (namespaceOutcome) {
    success => 0;
    failure(status) => i32(status);
  };
  if (namespaceStatus != 0) return namespaceStatus;
  return match (outcome) {
    success => sum + extra + namespaceConstant + selectedConstant - 3;
    failure(status) => status;
  };
}

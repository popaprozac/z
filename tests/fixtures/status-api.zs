import native from "./status-api.h";

function propagateFailure(): void throws i32 {
  let handle;
  try native.z_status_open(7, out handle);
}

function openSuccessfully(): i32 throws i32 {
  let handle;
  try native.z_status_open(0, out handle);
  if (handle == null) throw -99;
  return 42;
}

function main(): i32 {
  const failed = attempt propagateFailure();
  const failureStatus = match (failed) {
    success => 0;
    failure(status) => status;
  };
  if (failureStatus != 7) return 1;
  if (native.z_status_destroyed() != 1) return 2;

  const opened = attempt openSuccessfully();
  const value = match (opened) {
    success(value) => value;
    failure(status) => status;
  };
  if (value != 42) return 3;
  if (native.z_status_destroyed() != 2) return 4;

  const plainSuccess = attempt native.z_status_plain(2);
  const successStatus = match (plainSuccess) {
    success => 0;
    failure(status) => status;
  };
  if (successStatus != 0) return 5;

  const plainFailure = attempt native.z_status_plain(9);
  return match (plainFailure) {
    success => 6;
    failure(status) => status - 9;
  };
}

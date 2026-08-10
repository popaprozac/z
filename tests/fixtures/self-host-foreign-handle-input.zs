import native from "owned-handle-native.h";

function openDirectly(): i32 {
  const handle = native.z_owned_handle_open(40);
  if (handle == null) return -1;
  return native.z_owned_handle_read(in handle) + 2;
}

function openAsOption(): i32 {
  const optional = Option.fromNullable(native.z_owned_handle_open(42));
  return match (optional) {
    some(handle) => native.z_owned_handle_read(in handle);
    none => -1;
  };
}

function closeExplicitly(): i32 {
  const handle = native.z_owned_handle_open(1);
  if (handle == null) return -1;
  native.z_owned_handle_close(move handle);
  return 1;
}

function inspectDefault(): i32 {
  const handle = native.z_owned_handle_default();
  if (handle == null) return -1;
  return native.z_owned_handle_read(in handle) + 1;
}

function inspectChild(): i32 {
  const owner = native.z_owned_handle_open(42);
  if (owner == null) return -1;
  const child = Option.fromNullable(native.z_owned_handle_child(in owner));
  return match (in child) {
    some(value) => native.z_owned_child_read(in value);
    none => -2;
  };
}

function inspectLabel(): i32 {
  const owner = native.z_owned_handle_open(42);
  if (owner == null) return -1;
  const label = native.z_owned_handle_label(in owner);
  if (label == null) return -2;
  return native.z_owned_handle_read(in owner);
}

function propagateProducedFailure(): void throws i32 {
  let handle;
  try native.z_owned_handle_create(7, out handle);
}

function propagateEmptyFailure(): void throws i32 {
  let handle;
  try native.z_owned_handle_create(-2, out handle);
}

function openThroughOut(): i32 throws i32 {
  let handle;
  try native.z_owned_handle_create(0, out handle);
  if (handle == null) throw -3;
  return native.z_owned_handle_read(in handle);
}

function main(): i32 {
  if (openDirectly() != 42) return 1;
  if (native.z_owned_handle_closed() != 1) return 2;
  if (closeExplicitly() != 1) return 3;
  if (native.z_owned_handle_closed() != 2) return 4;
  if (openAsOption() != 42) return 5;
  if (native.z_owned_handle_closed() != 3) return 6;
  if (inspectDefault() != 42) return 13;
  if (native.z_owned_handle_closed() != 3) return 14;
  if (inspectChild() != 43) return 15;
  if (native.z_owned_handle_closed() != 4) return 16;
  if (inspectLabel() != 42) return 17;
  if (native.z_owned_handle_closed() != 5) return 18;

  const produced = attempt propagateProducedFailure();
  const producedStatus = match (produced) {
    success => 0;
    failure(status) => status;
  };
  if (producedStatus != 7) return 7;
  if (native.z_owned_handle_closed() != 6) return 8;

  const empty = attempt propagateEmptyFailure();
  const emptyStatus = match (empty) {
    success => 0;
    failure(status) => status;
  };
  if (emptyStatus != -2) return 9;
  if (native.z_owned_handle_closed() != 6) return 10;

  const opened = attempt openThroughOut();
  const openedValue = match (opened) {
    success(value) => value;
    failure(status) => status;
  };
  if (openedValue != 42) return 11;
  if (native.z_owned_handle_closed() != 7) return 12;
  return 0;
}

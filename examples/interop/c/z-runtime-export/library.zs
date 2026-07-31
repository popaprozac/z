import host from "runtime-host.h";

export c function z_embed_hold(value: i32): i32 {
  host.z_runtime_host_entered();
  host.z_runtime_host_wait();
  return value;
}

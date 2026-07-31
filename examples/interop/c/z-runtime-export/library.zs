import host from "runtime-host.h";
import { Once, OnceLifetime } from "std/sync";
import { thread } from "std/thread";

class EmbeddedApplication on thread.main {
  readonly answer: i32;

  deinit {
    host.z_runtime_host_released();
  }
}

const application = Once<EmbeddedApplication>();

function initializeRuntime(): OnceLifetime<EmbeddedApplication> on thread.main {
  return application.initialize(new EmbeddedApplication({ answer: 42 }));
}

export c function z_embed_hold(value: i32): i32 {
  host.z_runtime_host_entered();
  host.z_runtime_host_wait();
  return value;
}

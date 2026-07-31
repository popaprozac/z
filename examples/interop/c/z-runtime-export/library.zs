import host from "runtime-host.h";
import { Mutex, Once, OnceLifetime } from "std/sync";
import { thread } from "std/thread";

struct EmbeddedState {
  completedJobs: i32;
  lastJob: i32;
}

class EmbeddedApplication {
  readonly state: Mutex<EmbeddedState>;
  uiRevision: i32 on thread.main;

  function completeJob(job: i32): i32 {
    return this.state.withLock((inout state): i32 => {
      state.completedJobs = state.completedJobs + 1;
      state.lastJob = job;
      return state.completedJobs;
    });
  }

  function completionChecksum(): i32 {
    return this.state.withLock(
      (in state): i32 => state.completedJobs + state.lastJob
    );
  }

  deinit {
    host.z_runtime_host_released();
  }
}

const application = Once<EmbeddedApplication>();

function initializeRuntime(): OnceLifetime<EmbeddedApplication> on thread.main {
  return application.initialize(new EmbeddedApplication({
    state: Mutex(EmbeddedState({ completedJobs: 0, lastJob: 0 })),
    uiRevision: 1,
  }));
}

export c function z_embed_complete_job(job: i32): i32 {
  const current = application.get();
  const completed = current.completeJob(job);
  host.z_runtime_host_entered();
  host.z_runtime_host_wait();
  return completed;
}

export c function z_embed_completion_checksum(): i32 {
  const current = application.get();
  return current.completionChecksum();
}

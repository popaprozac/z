import console from "std/console";
import { Mutex } from "std/sync";

struct DeploymentState {
  activeJobs: i32;
  completedJobs: i32;
  failedJobs: i32;
}

function main(): i32 {
  const state = Mutex(DeploymentState({
    activeJobs: 0,
    completedJobs: 0,
    failedJobs: 0,
  }));

  state.withLock((inout current): void => {
    current.activeJobs = current.activeJobs + 1;
  });

  state.withLock((inout current): void => {
    current.activeJobs = current.activeJobs - 1;
    current.completedJobs = current.completedJobs + 1;
  });

  const completed = state.withLock(
    (in current): i32 => current.completedJobs
  );
  const active = state.withLock(
    (in current): i32 => current.activeJobs
  );

  console.log(`deployments complete=${completed}, active=${active}`);
  return completed - 1;
}

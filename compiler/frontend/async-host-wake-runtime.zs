import { TextBuffer } from "std/text";

// A queued host wake must outlive its executor without keeping stack-owned
// executor storage alive. Only the creating main thread reads/invalidates the
// pointer; workers retain the ticket while publishing under external_mutex.
export function asyncHostWakeRuntime(timers: boolean): String {
  let output = TextBuffer();
  output.append(`
#if defined(__APPLE__)
struct Z_AsyncHostWake {
  size_t refcount;
  Z_AsyncExecutor *executor;
  bool enabled;
  uint64_t timer_generation;
  uint64_t timer_deadline;
};
static bool z_stage1_async_run_one(Z_AsyncExecutor *executor);
static void z_stage1_async_external_lock(Z_AsyncExecutor *executor);
static void z_stage1_async_external_unlock(Z_AsyncExecutor *executor);
static void z_stage1_async_host_arm_timer(Z_AsyncExecutor *executor);
static Z_AsyncHostWake *z_stage1_async_host_retain(Z_AsyncHostWake *wake) {
  __atomic_add_fetch(&wake->refcount, 1, __ATOMIC_RELAXED);
  return wake;
}
static void z_stage1_async_host_release(Z_AsyncHostWake *wake) {
  if (__atomic_fetch_sub(&wake->refcount, 1, __ATOMIC_ACQ_REL) == 1) free(wake);
}
static void z_stage1_async_host_perform(void *context) {
  Z_AsyncHostWake *wake = (Z_AsyncHostWake *)context;
  if (!pthread_main_np()) abort();
  Z_AsyncExecutor *executor = wake->executor;
  if (executor != NULL) {
    while (z_stage1_async_run_one(executor)) {}
    z_stage1_async_host_arm_timer(executor);
  }
  z_stage1_async_host_release(wake);
}
static void z_stage1_async_host_init(Z_AsyncExecutor *executor) {
  executor->host_wake = NULL;
  if (!pthread_main_np()) return;
  Z_AsyncHostWake *wake = (Z_AsyncHostWake *)calloc(1, sizeof(*wake));
  if (wake == NULL) abort();
  wake->refcount = 1;
  wake->executor = executor;
  executor->host_wake = wake;
}
static void z_stage1_async_host_destroy(Z_AsyncExecutor *executor) {
  Z_AsyncHostWake *wake = executor->host_wake;
  if (wake == NULL) return;
  if (!pthread_main_np()) abort();
  wake->executor = NULL;
  executor->host_wake = NULL;
  z_stage1_async_host_release(wake);
}
static void z_stage1_async_host_signal(Z_AsyncExecutor *executor) {
  if (executor->host_wake != NULL && executor->host_wake->enabled)
    dispatch_async_f(dispatch_get_main_queue(),
      z_stage1_async_host_retain(executor->host_wake), z_stage1_async_host_perform);
}
static __attribute__((unused)) void z_stage1_async_host_enable(Z_AsyncExecutor *executor) {
  // Ordinary command-line drivers wait on the condition variable. Do not leave
  // dispatch tickets accumulating on a main queue they never run.
  z_stage1_async_external_lock(executor);
  if (executor->host_wake != NULL) executor->host_wake->enabled = true;
  z_stage1_async_external_unlock(executor);
}
`);
  if (timers) {
    output.append(`
typedef struct {
  Z_AsyncHostWake *wake;
  uint64_t generation;
} Z_AsyncHostTimer;
static void z_stage1_async_host_timer_perform(void *context) {
  Z_AsyncHostTimer *timer = (Z_AsyncHostTimer *)context;
  Z_AsyncHostWake *wake = timer->wake;
  const bool current = wake->executor != NULL && timer->generation == wake->timer_generation;
  free(timer);
  if (current) {
    wake->timer_deadline = 0;
    z_stage1_async_host_perform(wake);
  } else z_stage1_async_host_release(wake);
}
static void z_stage1_async_host_arm_timer(Z_AsyncExecutor *executor) {
  Z_AsyncHostWake *wake = executor->host_wake;
  if (wake == NULL) return;
  const uint64_t deadline = executor->timers == NULL ? 0 : executor->timers->wake_at_ms;
  if (deadline == wake->timer_deadline) return;
  wake->timer_deadline = deadline;
  wake->timer_generation += 1;
  if (deadline == 0) return;
  Z_AsyncHostTimer *timer = (Z_AsyncHostTimer *)malloc(sizeof(*timer));
  if (timer == NULL) abort();
  timer->wake = z_stage1_async_host_retain(wake);
  timer->generation = wake->timer_generation;
  const uint64_t now = z_stage1_async_now_ms();
  const uint64_t remaining = deadline > now ? deadline - now : 0;
  const int64_t nanoseconds = remaining > (uint64_t)INT64_MAX / UINT64_C(1000000)
    ? INT64_MAX : (int64_t)(remaining * UINT64_C(1000000));
  dispatch_after_f(dispatch_time(DISPATCH_TIME_NOW, nanoseconds), dispatch_get_main_queue(),
    timer, z_stage1_async_host_timer_perform);
}
`);
  } else {
    output.append("static void z_stage1_async_host_arm_timer(Z_AsyncExecutor *executor) { (void)executor; }\n");
  }
  output.append(`
#else
static void z_stage1_async_host_init(Z_AsyncExecutor *executor) { (void)executor; }
static void z_stage1_async_host_destroy(Z_AsyncExecutor *executor) { (void)executor; }
static void z_stage1_async_host_signal(Z_AsyncExecutor *executor) { (void)executor; }
static __attribute__((unused)) void z_stage1_async_host_enable(Z_AsyncExecutor *executor) { (void)executor; }
#endif

`);
  return output.finish();
}

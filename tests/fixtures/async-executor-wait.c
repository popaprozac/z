// Included after the emitted runtime. Worker completion and timer callbacks
// deliberately depend on one another, so another request cannot rescue a stall.
static pthread_mutex_t wait_gate_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t wait_gate_condition = PTHREAD_COND_INITIALIZER;
static bool wait_gate_open;
static int wait_deliveries;
static int wait_timers;
static Z_AsyncTask *wait_external_task;

static void open_wait_gate(void) {
  pthread_mutex_lock(&wait_gate_mutex);
  wait_gate_open = true;
  pthread_cond_signal(&wait_gate_condition);
  pthread_mutex_unlock(&wait_gate_mutex);
}
static void *complete_on_worker(void *context) {
  pthread_mutex_lock(&wait_gate_mutex);
  while (!wait_gate_open) pthread_cond_wait(&wait_gate_condition, &wait_gate_mutex);
  pthread_mutex_unlock(&wait_gate_mutex);
  z_stage1_async_report_external_completion((Z_AsyncTask *)context);
  return NULL;
}
static void external_poll(Z_AsyncTask *task) {
  wait_deliveries += 1;
  task->completed = true;
}
static void timer_poll(Z_AsyncTask *task) {
  wait_timers += 1;
  if (wait_external_task != NULL) z_stage1_async_request_cancel(wait_external_task);
  open_wait_gate();
  task->completed = true;
}
int main(void) {
  // Timer unblocks worker; worker precedes a distant timer; cancellation from
  // a timer; and an infinite external-only wait with a forced spurious wake.
  for (int mode = 0; mode < 4; ++mode) {
    Z_AsyncExecutor executor = {0};
    z_stage1_async_executor_init_external(&executor);
    Z_AsyncTask external = { .executor = &executor, .poll = external_poll, .external_resume = true };
    Z_AsyncTask timer = { .executor = &executor, .poll = timer_poll };
    wait_gate_open = false;
    wait_deliveries = wait_timers = 0;
    wait_external_task = mode == 2 ? &external : NULL;
    z_stage1_async_begin_external_completion(&external);
    if (mode < 3) z_stage1_async_schedule_delay(&timer, mode == 1 ? 60000 : 5);
    // The wait wrapper forces one wake with no predicate change, then releases
    // the worker on entry to the next wait in the external-only case.
    spurious_condition = &executor.external_condition;
    spurious_remaining = 1;
    release_on_wait = mode == 1 || mode == 3 ? open_wait_gate : NULL;
    pthread_t worker;
    if (pthread_create(&worker, NULL, complete_on_worker, &external) != 0) abort();
    while (!external.completed) if (!z_stage1_async_drive_one(&executor)) abort();
    if (pthread_join(worker, NULL) != 0) abort();
    if (wait_deliveries != 1 || wait_timers != (mode == 0 || mode == 2 ? 1 : 0)) return 1;
    if (external.cancellation_requested != (mode == 2)) return 2;
    if (spurious_remaining != 0) return 3;
    z_stage1_async_remove_timer(&timer);
    if (z_stage1_async_drive_one(&executor)) return 4;
    z_stage1_async_executor_destroy_external(&executor);
    spurious_condition = NULL;
  }
  // A completion with no waiter is still progress even though it enqueues no
  // runnable task. It must not be reported as executor exhaustion.
  Z_AsyncExecutor executor = {0};
  z_stage1_async_executor_init_external(&executor);
  Z_AsyncTask completed = { .executor = &executor };
  z_stage1_async_begin_external_completion(&completed);
  z_stage1_async_report_external_completion(&completed);
  if (!z_stage1_async_drive_one(&executor) || !completed.completed) return 5;
  if (z_stage1_async_drive_one(&executor)) return 6;
  z_stage1_async_executor_destroy_external(&executor);
  return 0;
}

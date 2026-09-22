import { TextBuffer } from "std/text";

// The owner thread manages timers; external publishers share only the completion
// queue and count under external_mutex. Wait on either source, never read that
// queue unlocked or treat a spurious wake as executor exhaustion.
export function asyncExecutorWaitRuntime(timers: boolean): String {
  let output = TextBuffer();
  output.append(`
static void z_stage1_async_init_condition(Z_AsyncExecutor *executor) {
#if defined(_WIN32)
  InitializeConditionVariable(&executor->external_condition);
#elif defined(__APPLE__)
  if (pthread_cond_init(&executor->external_condition, NULL) != 0) abort();
#else
`);
  if (timers) output.append(`
  pthread_condattr_t attributes;
  if (pthread_condattr_init(&attributes) != 0) abort();
  if (pthread_condattr_setclock(&attributes, CLOCK_MONOTONIC) != 0) abort();
  if (pthread_cond_init(&executor->external_condition, &attributes) != 0) abort();
  if (pthread_condattr_destroy(&attributes) != 0) abort();
`);
  else output.append("  if (pthread_cond_init(&executor->external_condition, NULL) != 0) abort();\n");
  output.append(`
#endif
}
static bool z_stage1_async_wait_for_work(Z_AsyncExecutor *executor) {
  z_stage1_async_external_lock(executor);
  if (executor->external_completions == NULL && executor->active_external_callbacks == 0
`);
  if (timers) output.append("      && executor->timers == NULL\n");
  output.append(`
  ) {
    z_stage1_async_external_unlock(executor);
    return false;
  }
  if (executor->external_completions == NULL) {
`);
  if (timers) {
    output.append(`
    if (executor->timers != NULL) {
      const uint64_t now = z_stage1_async_now_ms();
      const uint64_t deadline_ms = executor->timers->wake_at_ms;
      const uint64_t remaining = deadline_ms > now ? deadline_ms - now : 0;
#if defined(_WIN32)
      const DWORD timeout = remaining >= (uint64_t)INFINITE ? INFINITE - 1 : (DWORD)remaining;
      if (!SleepConditionVariableCS(&executor->external_condition, &executor->external_mutex, timeout)
          && GetLastError() != ERROR_TIMEOUT) abort();
#else
      // Bound conversion to time_t even for a saturated language-level delay.
      const uint64_t chunk = remaining > UINT64_C(86400000) ? UINT64_C(86400000) : remaining;
      struct timespec deadline = {
        .tv_sec = (time_t)(chunk / UINT64_C(1000)),
        .tv_nsec = (long)((chunk % UINT64_C(1000)) * UINT64_C(1000000))
      };
#if defined(__APPLE__)
      const int waited = pthread_cond_timedwait_relative_np(
        &executor->external_condition, &executor->external_mutex, &deadline);
#else
      struct timespec clock;
      if (clock_gettime(CLOCK_MONOTONIC, &clock) != 0) abort();
      deadline.tv_sec += clock.tv_sec;
      deadline.tv_nsec += clock.tv_nsec;
      if (deadline.tv_nsec >= 1000000000L) {
        deadline.tv_sec += 1;
        deadline.tv_nsec -= 1000000000L;
      }
      const int waited = pthread_cond_timedwait(
        &executor->external_condition, &executor->external_mutex, &deadline);
#endif
      if (waited != 0 && waited != ETIMEDOUT) abort();
#endif
    } else
`);
  }
  output.append(`
    {
#if defined(_WIN32)
      if (!SleepConditionVariableCS(&executor->external_condition, &executor->external_mutex, INFINITE)) abort();
#else
      if (pthread_cond_wait(&executor->external_condition, &executor->external_mutex) != 0) abort();
#endif
    }
  }
  z_stage1_async_external_unlock(executor);
  // Timeout and spurious wakes both require another predicate check by the
  // driver. False is reserved for no remaining source of work.
  return true;
}

`);
  return output.finish();
}

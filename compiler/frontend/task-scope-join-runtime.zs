// Native TaskScope joins used by heap-owned continuations. The ordinary
// entry/foreign-driver join remains in c-emitter; frame polls on the scope's
// executor register a waiter instead of recursively driving that executor.
export function taskScopeJoinRuntime(): String {
  return `
struct Z_TaskScopeJoin {
  Z_AsyncTask task;
  Z_TaskScope *scope;
  Z_TaskScopeJoin *next;
  bool waiting;
  bool cancel;
};

static void z_stage1_task_scope_wake_joiners(Z_TaskScope *scope) {
  z_stage1_task_scope_lock(scope);
  Z_TaskScopeJoin *join = scope->pending == 0 ? scope->join_waiters : NULL;
  if (scope->pending == 0) scope->join_waiters = NULL;
  z_stage1_task_scope_unlock(scope);
  while (join != NULL) {
    Z_TaskScopeJoin *next = join->next;
    join->next = NULL;
    join->waiting = false;
    z_stage1_async_enqueue(join->task.executor, &join->task);
    join = next;
  }
}

static void z_stage1_task_scope_begin_join(Z_TaskScope *scope, bool cancel) {
  z_stage1_task_scope_lock(scope);
  scope->closing = true;
  if (cancel) scope->cancelling = true;
  z_stage1_task_scope_unlock(scope);
  // Admission is now closed. Job completion/destruction, like joining, runs
  // on main; do not hold the admission mutex while forwarding cancellation.
  if (cancel) {
    for (Z_TaskScopeJob *job = scope->jobs; job != NULL; job = job->scope_next)
      z_stage1_async_request_cancel(&job->task);
  }
}

static void z_stage1_task_scope_join_cancel(Z_AsyncTask *task) {
  Z_TaskScopeJoin *join = (Z_TaskScopeJoin *)task;
  z_stage1_task_scope_begin_join(join->scope, true);
}

static void z_stage1_task_scope_join_poll(Z_AsyncTask *task) {
  Z_TaskScopeJoin *join = (Z_TaskScopeJoin *)task;
  Z_TaskScope *scope = join->scope;
  if (join->waiting) abort();
  z_stage1_task_scope_begin_join(scope, join->cancel || task->cancellation_requested);
  z_stage1_task_scope_drain_external(scope);
  if (scope->executor != task->executor) {
    // A scope created outside a Z task has its own driver. Preserve the
    // existing synchronous bridge for that case; cross-executor readiness
    // composition is a separate runtime tier, not an implicit queue transfer.
    z_stage1_task_scope_join(scope, join->cancel || task->cancellation_requested);
  }
  z_stage1_task_scope_lock(scope);
  const bool complete = scope->pending == 0;
  if (!complete) {
    join->next = scope->join_waiters;
    scope->join_waiters = join;
    join->waiting = true;
  }
  z_stage1_task_scope_unlock(scope);
  if (!complete) return;
  z_stage1_task_scope_discard_jobs(scope);
  task->cancelled = task->cancellation_requested;
  task->completed = true;
}

static void z_stage1_task_scope_join_destroy(Z_AsyncTask *task) {
  Z_TaskScopeJoin *join = (Z_TaskScopeJoin *)task;
  // Joining owns a retained scope until every admitted child is finished,
  // including cold cancellation and destruction of an active parent frame.
  task->waiter = NULL;
  if (!task->completed) {
    z_stage1_async_request_cancel(task);
    if (!join->waiting && !task->queued) z_stage1_async_enqueue(task->executor, task);
    while (!task->completed) {
      if (!z_stage1_async_drive_one(task->executor)) abort();
    }
  }
  z_stage1_async_remove_queued(task);
  if (join->waiting) abort();
  Z_TaskScope_release(join->scope);
  free(join);
}

static __attribute__((unused)) Z_AsyncInvocation z_stage1_task_scope_join_start(
  Z_TaskScope *scope, bool cancel, Z_AsyncExecutor *executor
) {
  if (scope == NULL || executor == NULL) abort();
  Z_TaskScopeJoin *join = (Z_TaskScopeJoin *)calloc(1, sizeof(*join));
  if (join == NULL) abort();
  join->task.poll = z_stage1_task_scope_join_poll;
  join->task.request_cancel = z_stage1_task_scope_join_cancel;
  join->task.executor = executor;
  join->scope = Z_TaskScope_retain(scope);
  join->cancel = cancel;
  // The await itself closes admission and forwards cancellation: operations
  // already queued ahead of this join task must observe it before they run.
  // Operations other threads submitted take their place in the queue now too.
  z_stage1_task_scope_begin_join(scope, cancel);
  if (scope->executor == executor) z_stage1_task_scope_drain_external(scope);
  return (Z_AsyncInvocation){ .task = &join->task, .destroy = z_stage1_task_scope_join_destroy };
}
`;
}

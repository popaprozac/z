import { thread } from "std/thread";

export struct Context {
  name: String;
}

export struct LifecycleError {
  message: String;
}

export trait Lifecycle {
  function start(in context: Context): void
    throws LifecycleError on thread.main;
}

export type LifecycleHook = (
  in context: Context
) => Result<void, LifecycleError> on thread.main;

export readonly class LifecycleAdapter {
  hook: LifecycleHook;

  function invoke(in context: Context): Result<void, LifecycleError>
    on thread.main {
    return this.hook(in context);
  }
}

export function adapt<T: Lifecycle>(
  service: T
): LifecycleAdapter on thread.main {
  const hook: LifecycleHook = move (
    in context: Context
  ): Result<void, LifecycleError> => attempt service.start(in context);
  return new LifecycleAdapter({ hook });
}

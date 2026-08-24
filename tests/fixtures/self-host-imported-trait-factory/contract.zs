export trait Lifecycle {
  function start(): i32;
}

export struct LifecycleBuilder {
  values: Array<i32>;

  function register<T: Lifecycle>(inout this, service: T): void {
    this.values.push(service.start());
  }
}

export function createLifecycleBuilder(): LifecycleBuilder {
  return LifecycleBuilder({ values: Array<i32>() });
}

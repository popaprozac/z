export trait Service {
  function invoke(): i32;
}

export struct ServicesBuilder {
  total: i32;

  function register<T: Service>(
    inout this,
    service: T
  ): void {
    this.total = this.total + service.invoke();
  }
}

export function createServicesBuilder(): ServicesBuilder {
  return ServicesBuilder({ total: 0 });
}

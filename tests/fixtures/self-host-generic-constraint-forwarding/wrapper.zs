import {
  Service,
  ServicesBuilder,
} from "./contract.zs";

export function registerService<T: Service>(
  inout builder: ServicesBuilder,
  service: T
): void {
  builder.register(service);
}

export struct ApplicationServicesBuilder {
  routes: ServicesBuilder;

  function register<T: Service>(
    inout this,
    service: T
  ): void {
    this.routes.register(service);
  }
}

export function createApplicationServicesBuilder(
): ApplicationServicesBuilder {
  return ApplicationServicesBuilder({
    routes: ServicesBuilder({ total: 0 }),
  });
}

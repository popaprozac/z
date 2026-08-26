import { ServicesBuilder } from "./contract.zs";

function registerUnknown<T>(
  inout builder: ServicesBuilder,
  service: T
): void {
  builder.register(service);
}

function main(): i32 {
  return 0;
}

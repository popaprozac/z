import {
  createServicesBuilder,
  Service,
} from "./contract.zs";
import {
  createApplicationServicesBuilder,
  registerService,
} from "./wrapper.zs";

struct NotesService implements Service {
  readonly value: i32;

  function invoke(): i32 {
    return this.value;
  }
}

function main(): i32 {
  let builder = createServicesBuilder();
  registerService(inout builder, NotesService({ value: 42 }));
  let application = createApplicationServicesBuilder();
  application.register(NotesService({ value: 42 }));
  return builder.total + application.routes.total - 84;
}

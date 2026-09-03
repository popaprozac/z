export class Application {
  readonly name: String;

  constructor(name: String) {
    this.name = move name;
  }
}

function main(): i32 {
  const application = new Application("Notes");
  return application.name.byteLength == 0 ? 1 : 0;
}

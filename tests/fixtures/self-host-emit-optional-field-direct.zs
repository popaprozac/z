import console from "std/console";

struct Resource {
  id: i32;
  label: String;

  deinit {
    console.log(`released ${this.id}:${this.label}`);
  }
}

struct Holder {
  resource?: Resource;
}

function main(): i32 {
  const holder = Holder({
    resource: Resource({
      id: 42,
      label: `resource-${42}`,
    }),
  });
  const observed = match (in holder.resource) {
    some(value) => value.id;
    none => 0;
  };
  console.log("holder ready");
  return observed - 42;
}

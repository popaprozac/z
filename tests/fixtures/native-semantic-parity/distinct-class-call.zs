import console from "std/console";

readonly class Permissions { readonly allowed: boolean; }
class Record { readonly permissions: Permissions; }
class Registry {
  count: i32;
  function add(inout this, permissions: Permissions): void {
    if (permissions.allowed) this.count = this.count + 1;
  }
  function register(inout this, in record: Record): void {
    this.add(record.permissions);
  }
}
function main(): i32 {
  const permissions = new Permissions({ allowed: true });
  const record = new Record({ permissions });
  let registry = new Registry({ count: 0 });
  registry.register(in record);
  if (registry.count != 1) return 1;
  console.log("ok");
  return 0;
}

// Copyable C++ values in an Array: push copies a copy-only type, clear and
// cleanup run each destructor (live stays exact).
import console from "std/console";
import native from "foreign-values.hpp";
function main(): i32 {
  let values = Array<native.zcpp.ManagedValue>();
  values.push(native.zcpp.make_managed(1));
  values.push(native.zcpp.make_managed(2));
  values.clear();
  values.push(native.zcpp.make_managed(3));
  console.log(`len=${values.length} copies=${native.zcpp.managed_copies()} drops=${native.zcpp.managed_drops()} live=${native.zcpp.managed_live()}`);
  return 0;
}

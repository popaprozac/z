import { Holder as LibraryHolder } from "./library.zs";

function main(): i32 {
  const holder = LibraryHolder({ value: 42 });
  const selected = holder.preserve<String>("module");
  if (selected != "module") return 1;
  return 0;
}

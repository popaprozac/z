import { fetchObjectLength } from "./objc-object-completion-module.zs";

async function main(): i32 {
  return await fetchObjectLength() - 13;
}

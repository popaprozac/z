import native from "objc-blocks.h";

async function main(): i32 {
  const value = await native.ZObjCBlockFixture.fetchObjectOnWorker();
  return i32(value.length) - 13;
}

import native from "objc-blocks.h";

export async function fetchObjectLength(): i32 {
  const options = native.ZObjCFetchOptionPrimary;
  const value = await native.ZObjCBlockFixture.fetchObjectWithOptions(
    options
  );
  return i32(value.length);
}

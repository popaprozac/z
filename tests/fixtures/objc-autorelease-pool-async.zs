import objc from "std/objc";

async function pooledValue(): i32 {
  return objc.pool((): i32 => 42);
}

async function main(): i32 {
  return await pooledValue() - 42;
}

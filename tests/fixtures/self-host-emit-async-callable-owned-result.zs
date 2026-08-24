import { thread } from "std/thread";

type AsyncText =
  async () => String on thread.any;

async function main(): i32 {
  const source: String = `forty-two`;
  const handler: AsyncText = async move () => copy source;
  const value = await handler();
  return value.byteLength == 9 ? 0 : 1;
}

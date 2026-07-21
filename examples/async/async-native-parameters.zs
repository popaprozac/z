import console from "std/console";
import { delay } from "std/time";
import { zcpp } from "../../tests/fixtures/move-only.hpp";

struct DocumentLease {
  id: i32;
  resource: zcpp.UniqueValue;

  function close(move this): i32 {
    return this.resource.value();
  }
}

async function inspectNative(resource: zcpp.UniqueValue): i32 {
  await delay(1);
  return resource.finish(2);
}

async function saveDocument(document: DocumentLease): i32 {
  await delay(1);
  return document.close();
}

async function main(): i32 {
  const resource = zcpp.UniqueValue(40);
  const nativeTask = spawn inspectNative(resource);

  const document = DocumentLease({
    id: 42,
    resource: zcpp.UniqueValue(42),
  });
  const documentTask = spawn saveDocument(document);

  const nativeAnswer = await nativeTask;
  const documentAnswer = await documentTask;
  const live = zcpp.unique_live();
  console.log(`native=${nativeAnswer}, document=${documentAnswer}, live=${live}`);
  return nativeAnswer - 42 + documentAnswer - 42 + live;
}

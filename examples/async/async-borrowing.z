import console from "std/console";
import { delay } from "std/time";
import { zcpp } from "../../tests/fixtures/move-only.hpp";

struct DocumentLease {
  id: i32;
  resource: zcpp.UniqueValue;

  function inspect(): i32 {
    return this.resource.value();
  }

  function close(move this): i32 {
    return this.resource.value();
  }
}

async function inspectDocument(in document: DocumentLease): i32 {
  await delay(1);
  return document.inspect();
}

async function inspectNative(in resource: zcpp.UniqueValue): i32 {
  await delay(1);
  return resource.value();
}

async function observeDocument(in document: DocumentLease): void {
  await delay(1);
  console.log(`observed document ${document.id}`);
}

async function main(): i32 {
  const nativeResource = zcpp.UniqueValue(41);
  const nativeObserved = await inspectNative(nativeResource);

  const document = DocumentLease({
    id: 42,
    resource: zcpp.UniqueValue(42),
  });

  const direct = await inspectDocument(document);

  async scope {
    spawn observeDocument(document);
    spawn observeDocument(document);
  }

  const nativeClosed = nativeResource.finish(1);
  const closed = document.close();
  const live = zcpp.unique_live();
  console.log(`native=${nativeObserved}, direct=${direct}, closed=${closed}, live=${live}`);
  return nativeObserved - 41 + nativeClosed - 42 + direct - 42 + closed - 42 + live;
}

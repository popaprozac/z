import console from "std/console";
import { delay } from "std/time";
import { zcpp } from "../../tests/fixtures/move-only.hpp";

struct LoadError {
  code: i32;
}

struct DocumentLease {
  id: i32;
  resource: zcpp.UniqueValue;

  function inspect(): i32 {
    return this.resource.value();
  }

  function close(move this): i32 {
    return this.resource.value();
  }

  deinit {
    console.log(`released document ${this.id}`);
  }
}

async function loadDocument(id: i32, fail: boolean): DocumentLease throws LoadError {
  const document = DocumentLease({
    id,
    resource: zcpp.UniqueValue(id),
  });
  await delay(1);
  if (fail) throw LoadError({ code: document.inspect() });
  return document;
}

async function relayDocument(): DocumentLease throws LoadError {
  return try await loadDocument(42, false);
}

async function main(): i32 {
  const loaded = attempt await relayDocument();
  const answer = match (loaded) {
    success(document) => document.close();
    failure(error) => -error.code;
  };

  const failed = attempt await loadDocument(7, true);
  const failureCode = match (failed) {
    success(document) => document.close();
    failure(error) => error.code;
  };

  const live = zcpp.unique_live();
  console.log(`answer=${answer}, failure=${failureCode}, live=${live}`);
  return answer - 42 + failureCode - 7 + live;
}

import Native from "objc-blocks.h";
import objc from "std/objc";

type Completion = (value: i32) => void;

class ReceivedBlockHandler implements Native.ZObjCReceivedBlockDelegate {
  private completion: Completion;

  constructor(completion: Completion) {
    this.completion = move completion;
  }

  function complete(
    inout this,
    in fixture: Native.ZObjCBlockFixture,
    in completion: Completion
  ): void as "fixture:complete:" {
    this.completion = completion;
  }

  function finish(): void {
    this.completion(42);
  }
}

function main(): i32 {
  const fixture = Native.ZObjCBlockFixture.alloc().init();
  const handler = new ReceivedBlockHandler(move (value): void => {});
  const binding = objc.bind(fixture, { delegate: handler });
  fixture.prepareDelegate();
  handler.finish();
  return fixture.observed == 42 ? 0 : 1;
}

import native from "objc-block-native.h";
import objc from "std/objc";

type Completion = (value: i32) => void;

class Observation {
  value: i32;
}

class NativeBlockHandler implements native.ZNativeObjCBlockDelegate {
  function requestValue(
    in completion: Completion
  ): void as "requestValue:" {
    completion(22);
  }
}

function main(): i32 {
  const observation = new Observation({ value: 0 });
  native.ZNativeObjCBlockFixture.invoke(move (value, error): void => {
    if (value != null && error == null) observation.value = 20;
  });
  const handler = new NativeBlockHandler({});
  const adapter = objc.adapt<native.ZNativeObjCBlockDelegate>(handler);
  const delegated = native.ZNativeObjCBlockFixture.invokeDelegate(adapter);
  return observation.value + delegated - 42;
}

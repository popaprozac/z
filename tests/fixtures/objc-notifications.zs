import console from "std/console";
import Foundation from "Foundation/Foundation.h";

class EventState {
  count: i32;

  function record(inout this, name: String): void {
    this.count = this.count + 1;
    console.log(`event ${this.count}: ${name}`);
  }

  deinit {
    console.log(`released event state ${this.count}`);
  }
}

function main(): i32 {
  const center = Foundation.NSNotificationCenter.defaultCenter;
  const state = new EventState({ count: 0 });
  const observer = weak state;

  const token = center.addObserverForName(
    "ZEvent",
    object: null,
    queue: null,
    usingBlock: move (notification) => {
      const upgraded = attempt observer.upgrade();
      match (upgraded) {
        success(state) => {
          const name: String = notification.name;
          state.record(name);
        }
        failure(expired) => console.log("ignored event for released state");
      }
    }
  );

  center.postNotificationName("ZEvent", object: null);
  center.postNotificationName("ZEvent", object: null);
  center.removeObserver(token);
  center.postNotificationName("ZEvent", object: null);

  if (state.count != 2) return 1;
  return 0;
}

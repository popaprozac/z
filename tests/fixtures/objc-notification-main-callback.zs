import native from "AppKit/AppKit.h";
import { thread } from "std/thread";

const notificationName: String = "ZCallerExecutor";

class Observations on thread.main {
  count: i32;
  function observe(inout this): void { this.count = this.count + 1; }
}

class Subject extends native.NSWindow on thread.main {
  constructor() {
    super.initWithContentRect(native.NSMakeRect(0, 0, 100, 100),
      styleMask: native.NSWindowStyleMaskTitled,
      backing: native.NSBackingStoreBuffered, defer: false);
    this.releasedWhenClosed = false;
  }
  function read(): i32 as "read" { return 1; }
}

function observeEvents(): i32 on thread.main {
  const app = native.NSApplication.sharedApplication;
  const center = native.NSNotificationCenter.defaultCenter;
  const state = new Observations({ count: 0 });
  const subject = new Subject();
  if (usize(subject.styleMask) != usize(native.NSWindowStyleMaskTitled)) return 2;
  const visible = usize(subject.occlusionState & native.NSWindowOcclusionStateVisible);
  if (visible != 0) return 3;
  const observed = subject;
  const token = center.addObserverForName(notificationName, object: subject, queue: null,
    usingBlock: move (notification): void => {
      if (observed.read() == 1) state.observe();
    }
  );
  center.postNotificationName(notificationName, object: subject);
  center.removeObserver(token);
  center.postNotificationName(notificationName, object: subject);
  if (state.count != 1) return 1;
  const timer = native.NSTimer.timerWithTimeInterval(0, repeats: false,
    block: move (timer): void => { timer.invalidate(); state.observe(); });
  timer.fire();
  timer.invalidate();
  return state.count == 2 ? 0 : 4;
}

function main(): i32 { return observeEvents(); }

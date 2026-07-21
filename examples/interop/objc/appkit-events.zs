import console from "std/console";
import AppKit from "AppKit/AppKit.h";

class WindowEvents {
  becameKey: i32;

  function recordKey(inout this, name: String): void {
    this.becameKey = this.becameKey + 1;
    console.log(`native ${name}: count=${this.becameKey}`);
  }

  deinit {
    console.log(`released window events after ${this.becameKey} key event(s)`);
  }
}

function main(): i32 {
  const app = AppKit.NSApplication.sharedApplication;
  app.setActivationPolicy(AppKit.NSApplicationActivationPolicyRegular);

  const frame = AppKit.NSMakeRect(0.0, 0.0, 640.0, 420.0);
  const style = AppKit.NSWindowStyleMaskTitled
    | AppKit.NSWindowStyleMaskClosable
    | AppKit.NSWindowStyleMaskMiniaturizable
    | AppKit.NSWindowStyleMaskResizable;
  const window = AppKit.NSWindow.alloc().initWithContentRect(
    frame,
    styleMask: style,
    backing: AppKit.NSBackingStoreBuffered,
    defer: false
  );
  window.title = "Z Native Event Callback";
  window.center();

  const center = AppKit.NSNotificationCenter.defaultCenter;
  const events = new WindowEvents({ becameKey: 0 });
  const observer = weak events;

  const keyToken = center.addObserverForName(
    AppKit.NSWindowDidBecomeKeyNotification,
    object: window,
    queue: null,
    usingBlock: move (notification) => {
      const upgraded = attempt observer.upgrade();
      match (upgraded) {
        success(events) => {
          const name: String = notification.name;
          events.recordKey(name);
        }
        failure(expired) => console.log("ignored key event for released state");
      }
    }
  );

  const closeToken = center.addObserverForName(
    AppKit.NSWindowWillCloseNotification,
    object: window,
    queue: null,
    usingBlock: move (notification) => {
      const name = notification.name;
      console.log(`native ${name}: stopping AppKit`);
      app.stop(null);
    }
  );

  app.activate();
  window.makeKeyAndOrderFront(null);
  app.run();

  center.removeObserver(keyToken);
  center.removeObserver(closeToken);
  return 0;
}

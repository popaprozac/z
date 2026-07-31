import AppKit from "AppKit/AppKit.h";
import console from "std/console";
import { Mutex } from "std/sync";
import { sleep } from "std/time";
import { thread } from "std/thread";
import {
  Application,
  RuntimeState,
  closeApplication,
  currentApplication,
  initializeApplication,
  publishApplicationStatus,
} from "./application.zs";
import { refreshProject } from "./background.zs";

function createApplication(): Application on thread.main {
  const nativeApp = AppKit.NSApplication.sharedApplication;
  nativeApp.setActivationPolicy(AppKit.NSApplicationActivationPolicyRegular);

  const window = AppKit.NSWindow.alloc().initWithContentRect(
    AppKit.NSMakeRect(0.0, 0.0, 560.0, 220.0),
    styleMask: AppKit.NSWindowStyleMaskTitled
      | AppKit.NSWindowStyleMaskClosable,
    backing: AppKit.NSBackingStoreBuffered,
    defer: false
  );

  const content = AppKit.NSView.alloc().initWithFrame(
    AppKit.NSMakeRect(0.0, 0.0, 560.0, 220.0)
  );
  window.contentView = content;

  const label = AppKit.NSTextField.alloc().initWithFrame(
    AppKit.NSMakeRect(24.0, 92.0, 500.0, 28.0)
  );
  label.stringValue = "Background job is running";
  label.bezeled = false;
  label.drawsBackground = false;
  label.editable = false;
  label.selectable = false;
  content.addSubview(label);

  return new Application({
    name: "Zapp",
    state: Mutex(RuntimeState({ started: 0, completed: 0 })),
    window,
    statusLabel: label,
  });
}

function runNativeApplication(): void on thread.main {
  const nativeApp = AppKit.NSApplication.sharedApplication;
  const current = currentApplication();
  const center = AppKit.NSNotificationCenter.defaultCenter;
  const closeObserver = center.addObserverForName(
    AppKit.NSWindowWillCloseNotification,
    object: current.window,
    queue: null,
    usingBlock: move (notification) => {
      nativeApp.stop(null);
      const emptyModifiers = AppKit.NSEventModifierFlagCapsLock
        ^ AppKit.NSEventModifierFlagCapsLock;
      const wakeEvent = AppKit.NSEvent.otherEventWithType(
        AppKit.NSEventTypeApplicationDefined,
        location: AppKit.NSMakePoint(0.0, 0.0),
        modifierFlags: emptyModifiers,
        timestamp: 0.0,
        windowNumber: 0,
        context: null,
        subtype: 0,
        data1: 0,
        data2: 0
      );
      nativeApp.postEvent(wakeEvent, atStart: true);
    }
  );

  nativeApp.activate();
  nativeApp.run();
  center.removeObserver(closeObserver);
}

async function main(): i32 on thread.main {
  const value = createApplication();
  const lifetime = initializeApplication(value);
  value.show();

  const refresh = thread.spawn(async (): i32 => {
    const ticket = refreshProject();
    console.log(`worker completed AppKit job ${ticket}`);
    await on thread.main publishApplicationStatus(ticket);
    console.log(`worker resumed after publishing AppKit job ${ticket}`);
    sleep(2000);
    await on thread.main closeApplication();
    return ticket;
  });

  runNativeApplication();
  const ticket = await refresh;

  const current = currentApplication();
  console.log(`${current.name} completed AppKit job ${ticket}`);
  return current.completedWork() - ticket;
}

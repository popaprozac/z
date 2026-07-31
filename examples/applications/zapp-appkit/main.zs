import AppKit from "AppKit/AppKit.h";
import console from "std/console";
import { Mutex } from "std/sync";
import { delay } from "std/time";
import { thread } from "std/thread";
import {
  Application,
  RuntimeState,
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
  nativeApp.activate();

  return new Application({
    name: "Zapp",
    state: Mutex(RuntimeState({ started: 0, completed: 0 })),
    window,
    statusLabel: label,
  });
}

async function main(): i32 on thread.main {
  const value = createApplication();
  const lifetime = initializeApplication(value);
  value.show();

  const refresh = thread.spawn(async (): i32 => {
    const ticket = refreshProject();
    await on thread.main publishApplicationStatus(ticket);
    return ticket;
  });

  const ticket = await refresh;
  await delay(250);

  const current = currentApplication();
  console.log(`${current.name} completed AppKit job ${ticket}`);
  current.close();
  return current.completedWork() - ticket;
}

import AppKit from "AppKit/AppKit.h";

function main(): i32 {
  const app = AppKit.NSApplication.sharedApplication;
  app.setActivationPolicy(AppKit.NSApplicationActivationPolicyRegular);

  const frame = AppKit.NSMakeRect(0.0, 0.0, 800.0, 600.0);
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

  window.title = "Hello from Z";
  window.center();
  window.makeKeyAndOrderFront(null);
  app.activate();
  app.run();
  return 0;
}

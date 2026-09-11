// Manual GUI pressure probe; run through scripts/probe-appkit-subclass-reentry.ts.
// Checked superclass delegation permits real AppKit reentry; this is not yet
// a display-driven resize controller or a WebView smoothness measurement.
import AppKit from "AppKit/AppKit.h";
import probe from "./objc-subclass.h";
import console from "std/console";
import { thread } from "std/thread";

class ProbeWindow extends AppKit.NSWindow on thread.main {
  private changes: i32;

  constructor(frame: AppKit.NSRect) {
    super.initWithContentRect(frame,
      styleMask: AppKit.NSWindowStyleMaskTitled | AppKit.NSWindowStyleMaskResizable,
      backing: AppKit.NSBackingStoreBuffered, defer: false);
    this.changes = 0;
    this.releasedWhenClosed = false;
  }

  // AppKit's zoom implementation dispatches virtually to this override.
  override function resize(inout this, frame: AppKit.NSRect, display: boolean, animate: boolean): void as "setFrame:display:animate:" {
    this.changes = this.changes + 1;
    super.setFrame(frame, display: display, animate: animate);
  }

  // A new selector lets us probe super.zoom without pretending that its `id`
  // argument is NSObject. Source-nameable erased native identity is separate work.
  function requestZoom(inout this): void as "requestZoom" {
    this.changes = this.changes + 1;
    super.zoom(null);
  }

  override function animationResizeTime(frame: AppKit.NSRect): f64 as "animationResizeTime:" {
    return 0.1;
  }
}

function main(): i32 {
  // Expected guard failures exit 86, without emitting macOS crash reports.
  probe.z_subclass_catch_abort();
  const app = AppKit.NSApplication.sharedApplication;
  const window = new ProbeWindow(AppKit.NSMakeRect(100, 100, 320, 240));
  window.makeKeyAndOrderFront(null);
  console.log("before native operation");
  if (probe.z_subclass_access_scenario() == 1) {
    window.resize(AppKit.NSMakeRect(100, 100, 480, 360), true, true);
  } else {
    window.requestZoom();
  }
  console.log("after native operation");
  window.close();
  return 0;
}

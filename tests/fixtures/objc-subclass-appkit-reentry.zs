// Manual GUI pressure probe; run through scripts/probe-appkit-subclass-reentry.ts.
// Checked superclass delegation permits real AppKit reentry; this is not yet
// a display-driven resize controller or a WebView smoothness measurement.
import AppKit from "AppKit/AppKit.h";
import probe from "./objc-subclass.h";
import console from "std/console";
import objc from "std/objc";
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

  // Native identity is retained for this delegation, without borrowing the
  // source field or allowing reentry during argument evaluation or cleanup.
  override function zoom(inout this, in sender: objc.Object | null): void as "zoom:" {
    this.changes = this.changes + 1;
    super.zoom(sender);
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
    window.zoom(null);
  }
  console.log("after native operation");
  window.close();
  return 0;
}

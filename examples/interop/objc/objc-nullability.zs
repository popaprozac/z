import AppKit from "AppKit/AppKit.h";
import { thread } from "std/thread";

function centerNullable(window: AppKit.NSWindow | null): i32 on thread.main {
  if (window == null) return 0;

  window.center();
  return 1;
}

function centerOption(window: Option<AppKit.NSWindow>): i32 on thread.main {
  return match (window) {
    some(window) => {
      window.center();
      select 1;
    }
    none => 0;
  };
}

function main(): i32 {
  const app = AppKit.NSApplication.sharedApplication;
  const direct = centerNullable(app.keyWindow);
  const option = Option.fromNullable(app.keyWindow);
  return direct + centerOption(option);
}

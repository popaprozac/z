import AppKit from "AppKit/AppKit.h";
import { thread } from "std/thread";
import { readVisibility } from "./window.zs";

function inspect(in window: AppKit.NSWindow): boolean on thread.main {
  const fullSize = (window.styleMask & AppKit.NSWindowStyleMaskFullSizeContentView) == AppKit.NSWindowStyleMaskFullSizeContentView;
  const visibility = readVisibility(in window);
  const visible = visibility == AppKit.NSWindowTitleVisible;
  const hidden = AppKit.NSWindowTitleHidden != visibility;
  return fullSize && visible && hidden;
}

function main(): i32 { return 0; }

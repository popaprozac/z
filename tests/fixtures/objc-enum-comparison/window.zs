import native from "AppKit/AppKit.h";
import { thread } from "std/thread";

export function readVisibility(in window: native.NSWindow): native.NSWindowTitleVisibility on thread.main {
  return window.titleVisibility;
}

import AppKit from "AppKit/AppKit.h";
import { thread } from "std/thread";

function wakeApplication(
  in application: AppKit.NSApplication
): void on thread.main {
  const wake = AppKit.NSEvent.otherEventWithType(
    AppKit.NSEventTypeApplicationDefined,
    location: AppKit.NSMakePoint(0.0, 0.0),
    modifierFlags: 0,
    timestamp: 0.0,
    windowNumber: 0,
    context: null,
    subtype: 0,
    data1: 0,
    data2: 0
  );
  if (wake != null) application.postEvent(wake, atStart: true);
}

function main(): i32 {
  return 0;
}

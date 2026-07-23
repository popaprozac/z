import console from "std/console";
import objc from "std/objc";
import AppKit from "AppKit/AppKit.h";

class ActionState {
  value: i32;
}

function main(): i32 {
  const app = AppKit.NSApplication.sharedApplication;
  const state = new ActionState({ value: 42 });
  const button = AppKit.NSButton.alloc().init();
  const connection = objc.connect(button, move () => {
    console.log(`button action value=${state.value}`);
  });

  app.finishLaunching();
  button.performClick(null);
  return 0;
}

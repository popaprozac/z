// Native work can produce owned Z data off the main thread, then publish it
// through an Objective-C identity that remains owned by the main async task.

import console from "std/console";
import { thread } from "std/thread";
import AppKit from "AppKit/AppKit.h";

function currentApplication(): AppKit.NSApplication {
  return AppKit.NSApplication.sharedApplication;
}

function buildStatus(): String {
  return "background work completed";
}

function publishStatus(app: AppKit.NSApplication, in status: String): void {
  console.log(status);
  app.setActivationPolicy(AppKit.NSApplicationActivationPolicyProhibited);
}

async function main(): i32 {
  const app = currentApplication();
  const work = thread.spawn((): String => buildStatus());
  const status = await work;

  await on thread.main {
    publishStatus(app, status);
  }

  return 0;
}

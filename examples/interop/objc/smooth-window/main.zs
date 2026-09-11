import AppKit from "AppKit/AppKit.h";
import QuartzCore from "QuartzCore/CADisplayLink.h";
import clock from "QuartzCore/CABase.h";
import WebKit from "WebKit/WebKit.h";
import objc from "std/objc";
import { thread } from "std/thread";

function interpolateFrame(start: AppKit.NSRect, target: AppKit.NSRect, progress: f64): AppKit.NSRect {
  if (progress <= 0) return start;
  if (progress >= 1) return target;
  const remaining = 1 - progress;
  const eased = progress < 0.5 ? 4 * progress * progress * progress : 1 - 4 * remaining * remaining * remaining;
  return AppKit.NSMakeRect(
    start.origin.x + (target.origin.x - start.origin.x) * eased,
    start.origin.y + (target.origin.y - start.origin.y) * eased,
    start.size.width + (target.size.width - start.size.width) * eased,
    start.size.height + (target.size.height - start.size.height) * eased
  );
}

function invalidateDisplay(in link: QuartzCore.CADisplayLink | null): void on thread.main {
  if (link != null) link.invalidate();
}

// An integration probe, not yet Zapp's production window implementation.
class SmoothWindow extends AppKit.NSWindow on thread.main {
  private displayLink: QuartzCore.CADisplayLink | null;
  private startFrame: AppKit.NSRect;
  private targetFrame: AppKit.NSRect;
  private restartFrame: AppKit.NSRect;
  private restarting: boolean;
  private startedAt: f64;
  private duration: f64;
  private animating: boolean;
  private shuttingDown: boolean;
  private needsDisplay: boolean;
  private callbacks: i32;

  constructor(frame: AppKit.NSRect) {
    super.initWithContentRect(frame,
      styleMask: AppKit.NSWindowStyleMaskTitled | AppKit.NSWindowStyleMaskClosable | AppKit.NSWindowStyleMaskResizable,
      backing: AppKit.NSBackingStoreBuffered, defer: false);
    this.displayLink = null;
    this.startFrame = frame;
    this.targetFrame = frame;
    this.restartFrame = frame;
    this.restarting = false;
    this.startedAt = 0;
    this.duration = 0;
    this.animating = false;
    this.shuttingDown = false;
    this.needsDisplay = true;
    this.callbacks = 0;
    this.releasedWhenClosed = false;
  }

  override function resize(inout this, frame: AppKit.NSRect, display: boolean, animate: boolean): void as "setFrame:display:animate:" {
    // Replacing a transition always disconnects its old tick source first.
    invalidateDisplay(this.displayLink);
    this.displayLink = null;
    this.animating = false;
    const duration = super.animationResizeTime(frame);
    if (!animate || this.shuttingDown || AppKit.NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion || duration <= 0) {
      super.setFrame(frame, display: display);
      return;
    }
    this.startFrame = this.restarting ? this.restartFrame : this.frame;
    this.targetFrame = frame;
    this.duration = duration;
    this.startedAt = clock.CACurrentMediaTime();
    this.needsDisplay = display;
    this.animating = true;
    if (this.restarting) {
      const visible = this.startFrame;
      super.setFrame(visible, display: display);
    }
    const link = this.displayLinkWithTarget(this, selector: objc.selector(SmoothWindow.onDisplay));
    this.displayLink = link;
    const screen = this.screen;
    if (screen != null) {
      const maximum = f32(screen.maximumFramesPerSecond);
      if (maximum > 0) {
        link.preferredFrameRateRange = QuartzCore.CAFrameRateRangeMake(maximum < 60 ? maximum : f32(60), maximum, maximum);
      }
    }
    link.addToRunLoop(AppKit.NSRunLoop.mainRunLoop, forMode: AppKit.NSRunLoopCommonModes);
  }

  override function setFrame(inout this, frame: AppKit.NSRect, display: boolean): void as "setFrame:display:" {
    this.animating = false;
    invalidateDisplay(this.displayLink);
    this.displayLink = null;
    super.setFrame(frame, display: display);
  }

  override function zoom(inout this, in sender: objc.Object | null): void as "zoom:" {
    if (this.animating) {
      // Let AppKit observe the preceding intended state before choosing the
      // next zoom/restore target. Preserve the visible frame for interpolation.
      this.restartFrame = this.frame;
      this.restarting = true;
      this.animating = false;
      invalidateDisplay(this.displayLink);
      this.displayLink = null;
      const intended = this.targetFrame;
      super.setFrame(intended, display: false);
    }
    super.zoom(sender);
    this.restarting = false;
  }

  function onDisplay(inout this, in link: QuartzCore.CADisplayLink): void as "display:" {
    this.callbacks = this.callbacks + 1;
    if (!this.animating || this.shuttingDown) return;
    const progress = (link.targetTimestamp - this.startedAt) / this.duration;
    const frame = interpolateFrame(this.startFrame, this.targetFrame, progress);
    if (progress >= 1) {
      this.animating = false;
      invalidateDisplay(this.displayLink);
      this.displayLink = null;
    }
    const display = this.needsDisplay;
    super.setFrame(frame, display: display);
  }

  override function close(inout this): void as "close" {
    this.shuttingDown = true;
    this.animating = false;
    invalidateDisplay(this.displayLink);
    this.displayLink = null;
    super.close();
  }

  function isAnimating(): boolean as "zResizeIsAnimating" { return this.animating; }
  function displayCallbacks(): i32 as "zResizeDisplayCallbacks" { return this.callbacks; }
}

function main(): i32 {
  const app = AppKit.NSApplication.sharedApplication;
  app.setActivationPolicy(AppKit.NSApplicationActivationPolicyRegular);
  const window = new SmoothWindow(AppKit.NSMakeRect(100, 100, 640, 440));
  window.title = "Z display-link resize probe";
  // This probe covers zoom, not system-owned fullscreen transitions.
  window.collectionBehavior = AppKit.NSWindowCollectionBehaviorFullScreenNone;
  const configuration = WebKit.WKWebViewConfiguration.new();
  configuration.websiteDataStore = WebKit.WKWebsiteDataStore.nonPersistentDataStore();
  const webview = WebKit.WKWebView.alloc().initWithFrame(WebKit.CGRectMake(0, 0, 640, 440), configuration: configuration);
  window.contentView = webview;
  webview.loadHTMLString("<!doctype html><style>html{background:#15212b;color:#eef;font:18px system-ui}body{padding:20px}#grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px}.card{background:#2c4a60;padding:20px}#edge{position:fixed;bottom:0;right:0;background:#baeeae;color:#14251d;padding:12px}</style><h1>Display-driven resizing in Z</h1><p>Use the green zoom button. Try clicking again mid-transition.</p><p id='size'></p><div id='grid'></div><div id='edge'>Bottom right</div><script>document.getElementById('grid').innerHTML=Array.from({length:18},(_,i)=>'<div class=card>Note '+(i+1)+'</div>').join('');function tick(){document.getElementById('size').textContent=innerWidth+' x '+innerHeight;requestAnimationFrame(tick)}tick()</script>", baseURL: null);
  window.makeKeyAndOrderFront(null);
  const center = AppKit.NSNotificationCenter.defaultCenter;
  const closeObserver = center.addObserverForName(
    AppKit.NSWindowWillCloseNotification,
    object: window,
    queue: null,
    usingBlock: move (notification): void => {
      app.stop(null);
      const emptyModifiers = AppKit.NSEventModifierFlagCapsLock ^ AppKit.NSEventModifierFlagCapsLock;
      const wakeEvent = AppKit.NSEvent.otherEventWithType(
        AppKit.NSEventTypeApplicationDefined,
        location: AppKit.NSMakePoint(0, 0), modifierFlags: emptyModifiers,
        timestamp: 0, windowNumber: 0, context: null, subtype: 0, data1: 0, data2: 0
      );
      if (wakeEvent != null) app.postEvent(wakeEvent, atStart: true);
    }
  );
  app.activate();
  // AppKit must dispatch events, not merely service Foundation run-loop sources.
  // The retained observer stops and wakes this loop when the window closes.
  app.run();
  center.removeObserver(closeObserver);
  return 0;
}

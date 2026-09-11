# Display-driven AppKit resizing

This isolated probe keeps a WebView's viewport responsive during native window
zoom/restore by applying intermediate, nonanimated frames from a display link.
The controller is written in Z; the generated Objective-C subclass is the
window itself, not a wrapper or a handwritten native implementation.

Requires macOS 14+ and a logged-in graphical session. From the Z repository:

```sh
bun run z run examples/interop/objc/smooth-window
```

Or use the self-hosted compiler:

```sh
.z-cache/bootstrap/z run examples/interop/objc/smooth-window
```

Option-click the green window button to zoom/restore. Try a second click during
the transition. Watch the viewport dimensions, responsive cards, and bottom-right
label. Close the window to exit. The manual demo stays open until you close it.
Direct mouse resizing stays immediate. This is not yet Zapp's production window.

## What the source demonstrates

- `extends AppKit.NSWindow` creates one native ARC identity.
- `override ... as "selector:"` preserves native dispatch and AppKit's zoom
  target selection. An interrupted zoom synchronizes the old intended frame
  before requesting the next native target, then interpolates from the visible
  frame. It does not intercept/reject zoom through a delegate.
- A private nullable `CADisplayLink` owns an active transition. The checked
  `objc.selector(SmoothWindow.onDisplay)` registration uses the companion `.zd`.
- The link runs on the main run loop, requests the current screen's supported
  frame-rate range, and interpolates using `targetTimestamp`. The rate request
  is not a promise of WebKit presentation FPS.
- Completion, replacement, immediate sizing, and close invalidate the link and
  clear the strong field. There is no idle ticker. Relying on `deinit` alone
  would not break the link's retained-target cycle.
- Reduce Motion bypasses the transition. The manual probe disables fullscreen;
  system-owned fullscreen/tiling integration is not validated by this controller.
- `app.run()` dispatches AppKit input and painting events. A retained close
  observer stops/wakes that loop, then is removed before `main` returns. Pumping
  `NSRunLoop` alone is insufficient for this interactive WebView application.

The manifest supplies IDE/build context, macOS availability, and framework links.
The code deliberately uses the native API's record spelling (`NSRect` for AppKit,
`CGRect` for WebKit); general cross-header C-record alias parity remains separate.

## Reproducible verification

```sh
# No windows; verify the complete controller and scenario harness.
bun scripts/probe-appkit-resize.ts --check
bun scripts/probe-appkit-resize.ts --check --native

# Explicit GUI runs, automatically closed, strict Clang + UBSan, never ASan.
bun scripts/probe-appkit-resize.ts --run
bun scripts/probe-appkit-resize.ts --run --native

# Exercise the actual app.run() + WebView path, not just window geometry.
bun scripts/probe-appkit-resize.ts --run --webview
bun scripts/probe-appkit-resize.ts --run --webview --native
```

The GUI matrix covers completion/idle cleanup, retargeting, immediate interruption,
normal zoom/restore, interrupted zoom/restore, close during animation, and forced
Reduce Motion. Test-only duration/accessibility inputs do not change system
settings. Each child has an eight-second deadline. It checks endpoints and
callback termination, **not visual presentation or repaint FPS**. The separate
WebView check waits for JavaScript readiness, checks intermediate viewport sizes
and the edge element's layout during zoom, then closes the window and verifies
return from `app.run()`. Its children have a fifteen-second deadline. Both checks
run debug and optimized code. Sandboxed
processes without WindowServer access cannot supply useful GUI evidence.

Next: visual confirmation of this Z implementation, then Zapp integration and
its delegate/constraint/shutdown tests. Fullscreen/Spaces, tiling, titlebar drag
interruption, mixed-refresh displays, and system accessibility changes during a
transition still need their own native-behavior evidence.

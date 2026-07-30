struct Image {
  name: String;
  pixels: Array<u8>;
}

struct WindowHandle {
  id: i32;
}

struct WindowOptions {
  url: String;
  title: String = "Z App";
  icon?: Image;
  parent: Option<WindowHandle>;
}

function main(): i32 {
  const loadedIcon = Image({
    name: "z-logo",
    pixels: Array<u8>(90),
  });

  // A direct Image is contextually lifted into Option<Image>.some.
  const configured = WindowOptions({
    url: "https://example.com",
    icon: move loadedIcon,
    parent: Option.none,
  });

  // An omitted optional field becomes Option<Image>.none. The ordinary
  // Option<WindowHandle> field remains required and is supplied explicitly.
  const defaults = WindowOptions({
    url: "https://example.com/settings",
    parent: Option.some(WindowHandle({ id: 42 })),
  });

  // Supplying an explicit Option remains valid.
  const explicit = WindowOptions({
    url: "https://example.com/about",
    icon: Option.some(Image({
      name: "about",
      pixels: Array<u8>(1, 2, 3),
    })),
    parent: Option.none,
  });

  const configuredPixels = match (in configured.icon) {
    some(icon) => icon.pixels.length;
    none => usize(0);
  };
  const defaultPixels = match (in defaults.icon) {
    some(icon) => icon.pixels.length;
    none => usize(0);
  };
  const explicitPixels = match (in explicit.icon) {
    some(icon) => icon.pixels.length;
    none => usize(0);
  };

  if (configuredPixels != 1) return 1;
  if (defaultPixels != 0) return 2;
  if (explicitPixels != 3) return 3;
  if (defaults.title != "Z App") return 4;
  return 0;
}

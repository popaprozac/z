// Compiler-private host evidence, not a public std/target API or a guessed
// deployment version. An explicit project target takes precedence.
function compilerHostPlatformCode(): i32 = raw c {
#if defined(__APPLE__)
  return 1;
#elif defined(_WIN32)
  return 2;
#elif defined(__linux__)
  return 3;
#else
  return 0;
#endif
}

export function compilerHostPlatform(): String {
  const code = compilerHostPlatformCode();
  if (code == 1) return "macos";
  if (code == 2) return "windows";
  if (code == 3) return "linux";
  return "";
}

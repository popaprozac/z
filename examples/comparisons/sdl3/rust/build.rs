fn main() {
    let library_directory =
        std::env::var("SDL3_LIB_DIR").unwrap_or_else(|_| "/opt/homebrew/lib".to_owned());

    println!("cargo:rerun-if-env-changed=SDL3_LIB_DIR");
    println!("cargo:rustc-link-search=native={library_directory}");
    println!("cargo:rustc-link-lib=dylib=SDL3");
}

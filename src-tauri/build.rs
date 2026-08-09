fn main() {
    let protoc = protoc_bin_vendored::protoc_bin_path()
        .expect("a bundled protoc binary should be available");
    let mut proto_config = prost_build::Config::new();
    proto_config.protoc_executable(protoc);
    proto_config
        .compile_protos(&["proto/cockatrice_wire.proto"], &["proto"])
        .expect("Cockatrice compatibility schema should compile");

    println!("cargo:rerun-if-changed=proto/cockatrice_wire.proto");
    tauri_build::build()
}

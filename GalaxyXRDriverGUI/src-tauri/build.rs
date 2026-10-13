use std::{env, fs, path::Path};

fn assert_plain(path: &Path) {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        assert!(!metadata.file_type().is_symlink(), "linked build paths are unsupported");
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            assert_eq!(metadata.file_attributes() & 0x400, 0, "junction build paths are unsupported");
        }
    }
}

fn assert_ancestors(path: &Path) {
    for ancestor in path.ancestors() { assert_plain(ancestor); }
}

fn assert_tree(path: &Path) {
    assert_plain(path);
    if path.is_dir() {
        for entry in fs::read_dir(path).expect("inspect owned build context") {
            assert_tree(&entry.expect("inspect build context entry").path());
        }
    }
}

fn write_if_changed(path: &Path, bytes: &[u8]) {
    assert_ancestors(path);
    if fs::read(path).ok().as_deref() != Some(bytes) {
        fs::write(path, bytes).expect("write owned external build file");
    }
}

fn copy_inputs(source: &Path, destination: &Path, watch: bool) {
    if watch {
        let watched = if source.exists() { source } else { source.parent().unwrap() };
        println!("cargo:rerun-if-changed={}", watched.display());
    }
    assert_ancestors(source);
    assert_ancestors(destination);
    assert_tree(destination);
    if !source.exists() {
        return;
    }
    let metadata = fs::symlink_metadata(source).expect("read build input metadata");
    assert!(!metadata.file_type().is_symlink(), "linked build inputs are unsupported");
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        assert_eq!(metadata.file_attributes() & 0x400, 0, "junction build inputs are unsupported");
    }
    if metadata.is_dir() {
        fs::create_dir_all(destination).expect("create external build input directory");
        for entry in fs::read_dir(destination).expect("inspect copied inputs") {
            let entry = entry.expect("read copied input");
            if !source.join(entry.file_name()).exists() {
                if entry.path().is_dir() { fs::remove_dir_all(entry.path()).expect("remove stale copied input"); }
                else { fs::remove_file(entry.path()).expect("remove stale copied input"); }
            }
        }
        for entry in fs::read_dir(source).expect("list build inputs") {
            let entry = entry.expect("read build input");
            copy_inputs(&entry.path(), &destination.join(entry.file_name()), watch);
        }
    } else {
        write_if_changed(destination, &fs::read(source).expect("read build input"));
    }
}

fn absolute_path(value: &mut serde_json::Value, source: &Path) {
    if let Some(relative) = value.as_str() {
        if !relative.contains("://") && !Path::new(relative).is_absolute() {
            *value = source.join(relative).to_string_lossy().into_owned().into();
        }
    }
}

fn relocate_config(config: &mut serde_json::Value, source: &Path) {
    if let Some(value) = config.pointer_mut("/build/frontendDist") {
        absolute_path(value, source);
    }
    for pointer in ["/bundle/icon", "/bundle/externalBin"] {
        if let Some(values) = config.pointer_mut(pointer).and_then(serde_json::Value::as_array_mut) {
            for value in values { absolute_path(value, source); }
        }
    }
    if let Some(resources) = config.pointer_mut("/bundle/resources") {
        if let Some(values) = resources.as_array_mut() {
            for value in values { absolute_path(value, source); }
        } else if let Some(values) = resources.as_object_mut() {
            let original = std::mem::take(values);
            for (file, destination) in original {
                let mut file = serde_json::Value::String(file);
                absolute_path(&mut file, source);
                values.insert(file.as_str().expect("resource path").into(), destination);
            }
        }
    }
}

fn main() {
    let source = env::var_os("CARGO_MANIFEST_DIR").expect("Cargo manifest directory");
    let source = Path::new(&source).canonicalize().expect("resolve source directory");
    let repository = source.parent().unwrap().parent().unwrap();
    let artifacts = repository.parent().unwrap().join("builds/GalaxyXR-Driver");
    assert_ancestors(&artifacts);
    let artifacts = artifacts.canonicalize().expect("external artifact root exists");
    let output = env::var_os("OUT_DIR").expect("Cargo build output");
    assert_ancestors(Path::new(&output));
    let output = Path::new(&output).canonicalize().expect("resolve Cargo output");
    assert!(output.starts_with(&artifacts), "Cargo output must be under builds/GalaxyXR-Driver");

    // External artifacts (2026-10-08): Tauri 2 writes gen/schemas relative to
    // its working directory. Give its helper a per-Cargo-run external context.
    let context = output.join("tauri-build-context");
    assert_ancestors(&context);
    assert_tree(&context);
    fs::create_dir_all(&context).expect("create external Tauri context");
    copy_inputs(&source.join("Cargo.toml"), &context.join("Cargo.toml"), true);
    for directory in ["capabilities", "permissions", "icons"] {
        let destination = context.join(directory);
        if !source.join(directory).exists() && destination.exists() {
            fs::remove_dir_all(&destination).expect("remove retired input directory");
        }
        copy_inputs(&source.join(directory), &destination, true);
    }
    for entry in fs::read_dir(&context).expect("inspect copied config") {
        let entry = entry.expect("read copied config");
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("tauri.") && name.ends_with(".conf.json") && !source.join(name.as_ref()).exists() {
            fs::remove_file(entry.path()).expect("remove retired platform config");
        }
    }
    for entry in fs::read_dir(&source).expect("list Tauri configuration") {
        let entry = entry.expect("read Tauri configuration entry");
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name == "tauri.conf.json" || (name.starts_with("tauri.") && name.ends_with(".conf.json")) {
            println!("cargo:rerun-if-changed={}", entry.path().display());
            let mut config: serde_json::Value = serde_json::from_slice(&fs::read(entry.path()).unwrap()).expect("parse Tauri config");
            relocate_config(&mut config, &source);
            write_if_changed(&context.join(name.as_ref()), &serde_json::to_vec_pretty(&config).unwrap());
        }
    }
    if let Ok(config) = env::var("TAURI_CONFIG") {
        let mut config = serde_json::from_str(&config).expect("parse Tauri CLI config");
        relocate_config(&mut config, &source);
        env::set_var("TAURI_CONFIG", serde_json::to_string(&config).unwrap());
    }
    let previous = env::current_dir().expect("original working directory");
    env::set_current_dir(&context).expect("select external Tauri context");
    let result = tauri_build::try_build(tauri_build::Attributes::new());
    env::set_current_dir(previous).expect("restore working directory");
    result.expect("build Tauri metadata in external context");

    // Stable editor schema location, separate from Cargo's changing hash paths.
    copy_inputs(&context.join("gen/schemas"), &artifacts.join("gui/schemas"), false);
}

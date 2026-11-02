use moc_host_state::macos::{macos_console_owner, macos_seconds_since_input};
use std::path::PathBuf;

fn fixture_path(relative: &str) -> String {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/macos-tools")
        .join(relative)
        .to_str()
        .unwrap()
        .to_string()
}

#[test]
fn macos_tool_readers() {
    let stat_bin = fixture_path("bin/stat");
    let ioreg_bin = fixture_path("bin/ioreg");
    let shadow_stat = fixture_path("shadow/stat");

    // with bin/stat and bin/ioreg, console owner returns alice and seconds returns 3600
    let owner = macos_console_owner(&stat_bin).expect("macos_console_owner should succeed");
    assert_eq!(owner, "alice");

    let secs =
        macos_seconds_since_input(&ioreg_bin).expect("macos_seconds_since_input should succeed");
    assert_eq!(secs, 3600.0);

    // with shadow/stat it fails with console owner query failed
    let err = macos_console_owner(&shadow_stat).unwrap_err();
    assert_eq!(err, "console owner query failed");

    // HIDIdleTime with 9 digits should give 0.0 (<=9-digit branch)
    let tmp_dir = std::env::temp_dir().join(format!("moc-ioreg-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&tmp_dir);
    let ioreg_path = tmp_dir.join("ioreg");
    std::fs::write(
        &ioreg_path,
        "#!/bin/sh\n[ \"$*\" = \"-c IOHIDSystem\" ] || exit 2\necho '    | |   \"HIDIdleTime\" = 999999999'\n",
    )
    .expect("write ioreg");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&ioreg_path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&ioreg_path, perms).unwrap();
    }
    let secs2 = macos_seconds_since_input(ioreg_path.to_str().unwrap())
        .expect("HIDIdleTime 9-digit should succeed");
    assert_eq!(secs2, 0.0);
    let _ = std::fs::remove_file(&ioreg_path);
    let _ = std::fs::remove_dir(&tmp_dir);
}

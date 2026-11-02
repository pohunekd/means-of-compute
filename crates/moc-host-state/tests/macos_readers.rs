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
}

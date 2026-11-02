use moc_host_state::linux::{
    ProbeError, linux_gpu, linux_power, linux_seconds_since_input, sessions_idle_secs,
};
use std::path::PathBuf;

fn fixtures_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/sysfs-laptop")
}

fn loginctl_fixture(name: &str) -> String {
    // Double paths resolved from CARGO_MANIFEST_DIR/../../tests/fixtures/loginctl/
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .join("../../tests/fixtures/loginctl")
        .join(name)
        .join("loginctl")
        .to_str()
        .unwrap()
        .to_string()
}

#[test]
fn linux_sysfs_readers() {
    let root = fixtures_root().to_str().unwrap().to_string();

    // D1: on the fixture tree linux_power returns (true, Some(85.0))
    let (ac, batt) = linux_power(&root).expect("linux_power should succeed");
    assert!(ac);
    assert_eq!(batt, Some(85.0));

    // D1: linux_gpu returns present, name amdgpu, free 7168
    let gpu = linux_gpu(&root, "/nonexistent/nvidia-smi").expect("linux_gpu should succeed");
    assert!(gpu.present);
    assert_eq!(gpu.name.as_deref(), Some("amdgpu"));
    assert_eq!(gpu.freeMb, Some(7168.0));

    // D1: tree without class/power_supply returns (true, None)
    let tmp = std::env::temp_dir().join(format!("moc-linux-no-ps-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(tmp.join("class")).unwrap();
    let tmp_str = tmp.to_str().unwrap().to_string();
    let (ac2, batt2) = linux_power(&tmp_str).expect("missing ps should return ac true");
    assert!(ac2);
    assert_eq!(batt2, None);
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn linux_logind_readers() {
    let tty_loginctl = loginctl_fixture("tty-only");
    let wayland_loginctl = loginctl_fixture("wayland-active");

    let now_ms = 1_793_102_400_000.0; // 2026-10-27T12:00:00.000Z

    // tty-only returns NoGraphicalSession(["3"])
    match linux_seconds_since_input(&tty_loginctl, now_ms) {
        Err(ProbeError::NoGraphicalSession(ids)) => {
            assert_eq!(ids, vec!["3".to_string()]);
            // sessions_idle_secs on it at now_ms returns 43200
            let secs = sessions_idle_secs(&tty_loginctl, &ids, now_ms)
                .expect("sessions_idle_secs should succeed");
            assert_eq!(secs, 43200.0);
        }
        other => panic!("expected NoGraphicalSession, got {:?}", other),
    }

    // wayland-active double returns Some(0.0)
    let res = linux_seconds_since_input(&wayland_loginctl, now_ms)
        .expect("wayland-active should succeed");
    assert_eq!(res, Some(0.0));

    // missing program gives Executable not found in $PATH
    let missing = "loginctl-missing";
    let err = match linux_seconds_since_input(missing, now_ms) {
        Err(ProbeError::Message(m)) => m,
        Ok(v) => panic!("expected error for missing program, got {:?}", v),
        Err(ProbeError::NoGraphicalSession(ids)) => {
            panic!("expected Message error, got NoGraphicalSession {:?}", ids)
        }
    };
    assert!(
        err.contains("Executable not found in $PATH: \"loginctl-missing\""),
        "expected spawn error, got {}",
        err
    );
}

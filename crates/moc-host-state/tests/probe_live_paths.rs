use moc_host_state::output::to_json_line;
use moc_host_state::platform::Platform;
use moc_host_state::probe::{ProbeEnv, ProbeOptions};
use std::fs;
use std::path::PathBuf;

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../")
}

fn local_minutes_utc(epoch_ms: i64) -> u32 {
    let ms_of_day = epoch_ms.rem_euclid(86_400_000);
    let secs_of_day = ms_of_day / 1000;
    let hour = (secs_of_day / 3600) as u32;
    let minute = ((secs_of_day % 3600) / 60) as u32;
    hour * 60 + minute
}

fn now_ms_fixed() -> i64 {
    // not used when timestamp fact present, but provide
    1_793_102_400_000
}

fn create_temp_config_with_sysfs(sysfs_abs: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "moc-probe-live-{}-{}",
        std::process::id(),
        rand_suffix()
    ));
    let _ = fs::create_dir_all(&dir);
    let orig = workspace_root().join("config/probe.json");
    let text = fs::read_to_string(&orig).expect("read probe.json");
    let mut val: serde_json::Value = serde_json::from_str(&text).expect("parse probe.json");
    if let Some(obj) = val.as_object_mut() {
        obj.insert(
            "sysfsRoot".to_string(),
            serde_json::Value::String(sysfs_abs.to_string()),
        );
    }
    fs::write(
        dir.join("probe.json"),
        serde_json::to_string_pretty(&val).unwrap(),
    )
    .expect("write probe.json");
    dir
}

fn create_temp_config_with_macos_tools(stat_abs: &str, ioreg_abs: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "moc-probe-darwin-{}-{}",
        std::process::id(),
        rand_suffix()
    ));
    let _ = fs::create_dir_all(&dir);
    let orig = workspace_root().join("config/probe.json");
    let text = fs::read_to_string(&orig).expect("read probe.json");
    let mut val: serde_json::Value = serde_json::from_str(&text).expect("parse probe.json");
    if let Some(obj) = val.as_object_mut() {
        if let Some(tools) = obj.get_mut("macosTools") {
            if let Some(tobj) = tools.as_object_mut() {
                tobj.insert(
                    "stat".to_string(),
                    serde_json::Value::String(stat_abs.to_string()),
                );
                tobj.insert(
                    "ioreg".to_string(),
                    serde_json::Value::String(ioreg_abs.to_string()),
                );
            }
        }
    }
    fs::write(
        dir.join("probe.json"),
        serde_json::to_string_pretty(&val).unwrap(),
    )
    .expect("write probe.json");
    dir
}

fn rand_suffix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .subsec_nanos();
    format!("{}-{}", n, std::process::id())
}

fn write_facts(path: &PathBuf, content: serde_json::Value) {
    fs::write(path, serde_json::to_string(&content).unwrap()).expect("write facts");
}

fn write_host(path: &PathBuf, content: &str) {
    fs::write(path, content).expect("write host");
}

#[test]
fn unattended_window() {
    let root = workspace_root();
    let sysfs_abs = root
        .join("crates/moc-host-state/tests/fixtures/sysfs-laptop")
        .to_str()
        .unwrap()
        .to_string();
    let loginctl_tty = root
        .join("tests/fixtures/loginctl/tty-only/loginctl")
        .to_str()
        .unwrap()
        .to_string();
    let loginctl_wayland = root
        .join("tests/fixtures/loginctl/wayland-active/loginctl")
        .to_str()
        .unwrap()
        .to_string();

    // common facts from TS test
    let facts_json = serde_json::json!({
        "acPower": true,
        "batteryPercent": null,
        "cpuCores": 4,
        "cpuLoad1m": 0.1,
        "memoryTotalMb": 8192,
        "memoryFreeMb": 4096,
        "gpuPresent": false,
        "gpuName": null,
        "gpuFreeMb": null,
        "localModelsReachable": false,
        "localModels": [],
        "timestamp": "2026-10-27T12:00:00.000Z"
    });

    // U1
    {
        let config_dir = create_temp_config_with_sysfs(&sysfs_abs);
        let facts_path = config_dir.join("facts.json");
        write_facts(&facts_path, facts_json.clone());
        let host_path = config_dir.join("host.json");
        write_host(
            &host_path,
            r#"{"hostAlias":"laptop-b","unattended":{"start":"00:00","end":"00:00"}}"#,
        );
        let opts = ProbeOptions {
            config_dir: config_dir.clone(),
            facts_path: Some(facts_path.clone()),
            scenario: None,
        };
        let env = ProbeEnv {
            platform: Platform::Linux,
            loginctl: loginctl_tty.clone(),
            nvidia_smi: "nvidia-smi".to_string(),
            local_minutes: local_minutes_utc,
            now_ms: now_ms_fixed,
        };
        let host_path_clone = host_path.clone();
        let output = moc_host_state::probe::run_probe(&opts, &env, &|| {
            let text = fs::read_to_string(&host_path_clone).unwrap();
            let v: serde_json::Value = serde_json::from_str(&text).unwrap();
            let alias = v["hostAlias"].as_str().unwrap().to_string();
            let unattended = v.get("unattended").and_then(|u| {
                if u.is_null() {
                    None
                } else {
                    Some(moc_host_state::config::TimeWindow {
                        start: u["start"].as_str().unwrap().to_string(),
                        end: u["end"].as_str().unwrap().to_string(),
                    })
                }
            });
            Ok(moc_host_state::config::HostFile {
                hostAlias: alias,
                unattended,
            })
        })
        .expect("U1 run_probe failed");
        assert!(output.idle, "U1 should be idle");
        assert_eq!(
            output.idleReason,
            "unattended window 00:00-00:00: no input on the local session for 720 minutes, on AC power"
        );
        assert_eq!(output.secondsSinceInput, 43200.0);
        let _ = fs::remove_dir_all(&config_dir);
    }

    // U2
    {
        let config_dir = create_temp_config_with_sysfs(&sysfs_abs);
        let facts_path = config_dir.join("facts.json");
        write_facts(&facts_path, facts_json.clone());
        let host_path = config_dir.join("host.json");
        write_host(
            &host_path,
            r#"{"hostAlias":"laptop-b","unattended":{"start":"00:00","end":"07:00"}}"#,
        );
        let opts = ProbeOptions {
            config_dir: config_dir.clone(),
            facts_path: Some(facts_path.clone()),
            scenario: None,
        };
        let env = ProbeEnv {
            platform: Platform::Linux,
            loginctl: loginctl_tty.clone(),
            nvidia_smi: "nvidia-smi".to_string(),
            local_minutes: local_minutes_utc,
            now_ms: now_ms_fixed,
        };
        let host_path_clone = host_path.clone();
        let output = moc_host_state::probe::run_probe(&opts, &env, &|| {
            let text = fs::read_to_string(&host_path_clone).unwrap();
            let v: serde_json::Value = serde_json::from_str(&text).unwrap();
            let alias = v["hostAlias"].as_str().unwrap().to_string();
            let unattended = v.get("unattended").and_then(|u| {
                if u.is_null() {
                    None
                } else {
                    Some(moc_host_state::config::TimeWindow {
                        start: u["start"].as_str().unwrap().to_string(),
                        end: u["end"].as_str().unwrap().to_string(),
                    })
                }
            });
            Ok(moc_host_state::config::HostFile {
                hostAlias: alias,
                unattended,
            })
        })
        .expect("U2 run_probe failed");
        assert!(!output.idle);
        assert_eq!(
            output.idleReason,
            "user activity unknown: logged in without an active graphical session"
        );
        assert_eq!(output.secondsSinceInput, 0.0);
        let _ = fs::remove_dir_all(&config_dir);
    }

    // U3
    {
        let config_dir = create_temp_config_with_sysfs(&sysfs_abs);
        let facts_path = config_dir.join("facts.json");
        write_facts(&facts_path, facts_json.clone());
        let host_path = config_dir.join("host.json");
        write_host(
            &host_path,
            r#"{"hostAlias":"laptop-b","unattended":{"start":"00:00","end":"00:00"}}"#,
        );
        let opts = ProbeOptions {
            config_dir: config_dir.clone(),
            facts_path: Some(facts_path.clone()),
            scenario: None,
        };
        let env = ProbeEnv {
            platform: Platform::Linux,
            loginctl: loginctl_wayland.clone(),
            nvidia_smi: "nvidia-smi".to_string(),
            local_minutes: local_minutes_utc,
            now_ms: now_ms_fixed,
        };
        let host_path_clone = host_path.clone();
        let output = moc_host_state::probe::run_probe(&opts, &env, &|| {
            let text = fs::read_to_string(&host_path_clone).unwrap();
            let v: serde_json::Value = serde_json::from_str(&text).unwrap();
            let alias = v["hostAlias"].as_str().unwrap().to_string();
            let unattended = v.get("unattended").and_then(|u| {
                if u.is_null() {
                    None
                } else {
                    Some(moc_host_state::config::TimeWindow {
                        start: u["start"].as_str().unwrap().to_string(),
                        end: u["end"].as_str().unwrap().to_string(),
                    })
                }
            });
            Ok(moc_host_state::config::HostFile {
                hostAlias: alias,
                unattended,
            })
        })
        .expect("U3 run_probe failed");
        assert!(!output.idle);
        assert_eq!(output.idleReason, "user input 0 seconds ago");
        assert_eq!(output.secondsSinceInput, 0.0);
        let _ = fs::remove_dir_all(&config_dir);
    }
}

#[test]
fn darwin_branch_and_number_format() {
    let root = workspace_root();
    let stat_abs = root
        .join("tests/fixtures/macos-tools/bin/stat")
        .to_str()
        .unwrap()
        .to_string();
    let ioreg_abs = root
        .join("tests/fixtures/macos-tools/bin/ioreg")
        .to_str()
        .unwrap()
        .to_string();

    let config_dir = create_temp_config_with_macos_tools(&stat_abs, &ioreg_abs);

    let facts_json = serde_json::json!({
        "acPower": true,
        "batteryPercent": null,
        "cpuCores": 4,
        "cpuLoad1m": 1,
        "memoryTotalMb": 8192.0,
        "memoryFreeMb": 4096,
        "gpuPresent": false,
        "gpuName": null,
        "gpuFreeMb": null,
        "localModelsReachable": false,
        "localModels": [],
        "hostAlias": "laptop-b",
        "timestamp": "2026-10-27T12:00:00.000Z",
        "policyAllowedWindowStart": "00:00",
        "policyAllowedWindowEnd": "00:00"
    });
    let facts_path = config_dir.join("facts.json");
    write_facts(&facts_path, facts_json);

    let opts = ProbeOptions {
        config_dir: config_dir.clone(),
        facts_path: Some(facts_path.clone()),
        scenario: None,
    };
    let env = ProbeEnv {
        platform: Platform::Darwin,
        loginctl: "loginctl".to_string(),
        nvidia_smi: "nvidia-smi".to_string(),
        local_minutes: local_minutes_utc,
        now_ms: now_ms_fixed,
    };
    let output = moc_host_state::probe::run_probe(&opts, &env, &|| {
        panic!("resolve_host should not be called");
    })
    .expect("darwin run_probe failed");

    let line = to_json_line(&output);
    assert!(
        line.contains("\"load1m\":1"),
        "line should contain \"load1m\":1, got {}",
        line
    );
    assert!(
        line.contains("\"totalMb\":8192,"),
        "line should contain \"totalMb\":8192, got {}",
        line
    );
    assert_eq!(
        output.idleReason,
        "no user input for 60 minutes, on AC power"
    );

    let _ = fs::remove_dir_all(&config_dir);
}

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../")
}

fn tmp_dir(prefix: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "moc-binary-test-{}-{}-{}",
        prefix,
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .subsec_nanos()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn copy_binary_and_config(tmp: &Path) -> (PathBuf, PathBuf) {
    let bin_src = PathBuf::from(env!("CARGO_BIN_EXE_moc-host-state"));
    let bin_dst_dir = tmp.join("bin");
    fs::create_dir_all(&bin_dst_dir).unwrap();
    let bin_dst = bin_dst_dir.join("moc-host-state");
    fs::copy(&bin_src, &bin_dst).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&bin_dst).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&bin_dst, perms).unwrap();
    }

    let config_dst = tmp.join("config");
    fs::create_dir_all(config_dst.join("scenarios")).unwrap();
    let root = workspace_root();
    fs::copy(
        root.join("config/plugin.json"),
        config_dst.join("plugin.json"),
    )
    .unwrap();
    fs::copy(
        root.join("config/probe.json"),
        config_dst.join("probe.json"),
    )
    .unwrap();
    for entry in fs::read_dir(root.join("config/scenarios")).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name();
        if name.to_string_lossy().ends_with(".json") {
            fs::copy(entry.path(), config_dst.join("scenarios").join(&name)).unwrap();
        }
    }
    (bin_dst, config_dst)
}

fn minify_json(text: &str) -> String {
    let mut out = String::new();
    let mut in_str = false;
    let mut escape = false;
    for ch in text.chars() {
        if in_str {
            out.push(ch);
            if escape {
                escape = false;
            } else if ch == '\\' {
                escape = true;
            } else if ch == '"' {
                in_str = false;
            }
        } else if ch == '"' {
            in_str = true;
            out.push(ch);
        } else if ch.is_whitespace() {
            continue;
        } else {
            out.push(ch);
        }
    }
    out
}

fn run_bin(bin: &Path, args: &[&str]) -> std::process::Output {
    let mut cmd = Command::new(bin);
    cmd.args(args);
    cmd.env("TZ", "UTC");
    cmd.output().unwrap()
}

#[test]
fn binary_runs_in_package_layout() {
    let tmp = tmp_dir("layout");
    let (bin, _config) = copy_binary_and_config(&tmp);
    // Override plugin.json to point at missing host file so the run never
    // depends on the machine's /etc content (facts contain hostAlias).
    let missing_host = tmp.join("absent").join("host.json");
    let plugin_path = tmp.join("config").join("plugin.json");
    fs::write(
        &plugin_path,
        format!("{{\"hostFile\":\"{}\"}}", missing_host.to_string_lossy()),
    )
    .unwrap();

    let root = workspace_root();
    let golden_path = root.join("tests/fixtures/probe/scenarios/desktop-mains.json");
    let golden_text = fs::read_to_string(&golden_path).unwrap();
    let minified = minify_json(&golden_text);
    let expected = minified + "\n";

    // --scenario desktop-mains
    let out = run_bin(&bin, &["--scenario", "desktop-mains"]);
    assert_eq!(
        out.status.code(),
        Some(0),
        "scenario exit 0, stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(out.stderr.len(), 0, "stderr empty for success");
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert_eq!(stdout, expected, "scenario desktop-mains mismatch");

    // --facts <desktop-mains> --scenario login-active (facts win)
    let scenario_path = tmp
        .join("config")
        .join("scenarios")
        .join("desktop-mains.json");
    let out2 = run_bin(
        &bin,
        &[
            "--facts",
            scenario_path.to_str().unwrap(),
            "--scenario",
            "login-active",
        ],
    );
    assert_eq!(
        out2.status.code(),
        Some(0),
        "facts+scenario exit 0, stderr: {}",
        String::from_utf8_lossy(&out2.stderr)
    );
    assert_eq!(out2.stderr.len(), 0);
    let stdout2 = String::from_utf8(out2.stdout).unwrap();
    assert_eq!(stdout2, expected, "facts win mismatch");

    let _ = fs::remove_dir_all(&tmp);
}

#[test]
fn binary_exit_codes() {
    let tmp = tmp_dir("exit");
    let (bin, _config) = copy_binary_and_config(&tmp);

    // For exit code cases, also point plugin.json at missing host file
    let missing_host = tmp.join("absent").join("host.json");
    let plugin_path = tmp.join("config").join("plugin.json");
    fs::write(
        &plugin_path,
        format!("{{\"hostFile\":\"{}\"}}", missing_host.to_string_lossy()),
    )
    .unwrap();

    // --bogus
    let out = run_bin(&bin, &["--bogus"]);
    assert_eq!(out.status.code(), Some(2));
    assert_eq!(out.stdout.len(), 0);
    assert_eq!(
        String::from_utf8(out.stderr).unwrap(),
        "moc-host-state: unknown argument\n"
    );

    // trailing --facts without value
    let out = run_bin(&bin, &["--facts"]);
    assert_eq!(out.status.code(), Some(2));
    assert_eq!(out.stdout.len(), 0);
    assert_eq!(
        String::from_utf8(out.stderr).unwrap(),
        "moc-host-state: unknown argument\n"
    );

    // --scenario alone
    let out = run_bin(&bin, &["--scenario"]);
    assert_eq!(out.status.code(), Some(2));
    assert_eq!(out.stdout.len(), 0);
    assert_eq!(
        String::from_utf8(out.stderr).unwrap(),
        "moc-host-state: unknown argument\n"
    );

    // missing host file (no hostAlias fact, plugin.json points at absent)
    let empty_facts = tmp.join("empty.json");
    fs::write(&empty_facts, "{}").unwrap();
    let out = run_bin(&bin, &["--facts", empty_facts.to_str().unwrap()]);
    assert_eq!(
        out.status.code(),
        Some(1),
        "missing host should exit 1, stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(out.stdout.len(), 0);
    assert!(
        !out.stderr.is_empty(),
        "stderr should contain error for missing host"
    );

    // invalid facts file
    let bad_facts = tmp.join("bad.json");
    fs::write(&bad_facts, "{ not json").unwrap();
    let out = run_bin(&bin, &["--facts", bad_facts.to_str().unwrap()]);
    assert_eq!(
        out.status.code(),
        Some(1),
        "invalid facts should exit 1, stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(out.stdout.len(), 0);
    assert!(!out.stderr.is_empty());

    let _ = fs::remove_dir_all(&tmp);
}

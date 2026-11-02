use moc_host_state::output::to_json_line;
use moc_host_state::platform::Platform;
use moc_host_state::probe::{ProbeEnv, ProbeOptions};
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
    1_793_102_400_000
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
        } else {
            if ch == '"' {
                in_str = true;
                out.push(ch);
            } else if ch.is_whitespace() {
                continue;
            } else {
                out.push(ch);
            }
        }
    }
    out
}

#[test]
fn shared_scenario_suite() {
    let root = workspace_root();
    let config_dir = root.join("config");
    let scenarios_dir = config_dir.join("scenarios");
    let fixtures_dir = root.join("tests/fixtures/probe/scenarios");

    let mut names: Vec<String> = std::fs::read_dir(&scenarios_dir)
        .expect("read scenarios dir")
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .filter(|n| n.ends_with(".json"))
        .map(|n| n.trim_end_matches(".json").to_string())
        .collect();
    names.sort();

    let fixture_count = std::fs::read_dir(&fixtures_dir)
        .expect("read fixtures dir")
        .filter(|e| {
            e.as_ref()
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".json")
        })
        .count();
    assert_eq!(
        names.len(),
        fixture_count,
        "scenario count must match golden count"
    );

    for name in names {
        let opts = ProbeOptions {
            config_dir: config_dir.clone(),
            facts_path: None,
            scenario: Some(name.clone()),
        };
        let env = ProbeEnv {
            platform: Platform::current(),
            loginctl: "loginctl".to_string(),
            nvidia_smi: "nvidia-smi".to_string(),
            local_minutes: local_minutes_utc,
            now_ms: now_ms_fixed,
        };
        let output = moc_host_state::probe::run_probe(&opts, &env, &|| {
            panic!("resolve_host should not be called for scenarios")
        })
        .unwrap_or_else(|e| panic!("run_probe failed for {}: {}", name, e));

        let line = to_json_line(&output);
        let golden_text = std::fs::read_to_string(fixtures_dir.join(format!("{}.json", name)))
            .unwrap_or_else(|e| panic!("read golden {} failed: {}", name, e));
        let minified = minify_json(&golden_text);
        let expected = minified + "\n";
        assert_eq!(line, expected, "scenario {} mismatch", name);
    }
}

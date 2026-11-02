use moc_host_state::config::{load_host_file, load_plugin_config};
use moc_host_state::output::to_json_line;
use moc_host_state::platform::Platform;
use moc_host_state::probe::{ProbeEnv, ProbeOptions};
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn main() {
    let args: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|os| os.to_string_lossy().into_owned())
        .collect();

    let mut facts_path: Option<String> = None;
    let mut scenario: Option<String> = None;

    let mut idx = 0usize;
    while idx < args.len() {
        let arg = &args[idx];
        if arg == "--facts" {
            if idx + 1 < args.len() {
                facts_path = Some(args[idx + 1].clone());
                idx += 2;
                continue;
            } else {
                let _ = std::io::stderr().write_all(b"moc-host-state: unknown argument\n");
                std::process::exit(2);
            }
        } else if arg == "--scenario" {
            if idx + 1 < args.len() {
                scenario = Some(args[idx + 1].clone());
                idx += 2;
                continue;
            } else {
                let _ = std::io::stderr().write_all(b"moc-host-state: unknown argument\n");
                std::process::exit(2);
            }
        } else {
            let _ = std::io::stderr().write_all(b"moc-host-state: unknown argument\n");
            std::process::exit(2);
        }
    }

    let config_dir = match std::env::current_exe() {
        Ok(exe) => {
            let parent = exe
                .parent()
                .and_then(|p| p.parent())
                .map(|p| p.to_path_buf());
            match parent {
                Some(base) => base.join("config"),
                None => {
                    let _ = std::io::stderr().write_all(b"config dir unavailable\n");
                    std::process::exit(1);
                }
            }
        }
        Err(e) => {
            let msg = format!("{}\n", e);
            let _ = std::io::stderr().write_all(msg.as_bytes());
            std::process::exit(1);
        }
    };

    let plugin_config_path = config_dir.join("plugin.json");
    let plugin_config_str = plugin_config_path.to_string_lossy().to_string();

    let resolve_host = || {
        let plugin_cfg = load_plugin_config(&plugin_config_str)?;
        load_host_file(&plugin_cfg.hostFile)
    };

    let opts = ProbeOptions {
        config_dir: config_dir.clone(),
        facts_path: facts_path.map(PathBuf::from),
        scenario,
    };

    let env = ProbeEnv {
        platform: Platform::current(),
        loginctl: "loginctl".to_string(),
        nvidia_smi: "nvidia-smi".to_string(),
        local_minutes: moc_host_state::time::local_minutes,
        now_ms,
    };

    match moc_host_state::probe::run_probe(&opts, &env, &resolve_host) {
        Ok(output) => {
            let line = to_json_line(&output);
            let _ = std::io::stdout().write_all(line.as_bytes());
            std::process::exit(0);
        }
        Err(msg) => {
            let mut stderr = std::io::stderr();
            let _ = stderr.write_all(msg.as_bytes());
            let _ = stderr.write_all(b"\n");
            std::process::exit(1);
        }
    }
}

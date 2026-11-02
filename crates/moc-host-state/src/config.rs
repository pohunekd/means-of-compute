use crate::js::errno_name;
use crate::platform::Platform;
use regex::Regex;
use std::collections::HashSet;

#[allow(non_snake_case)]
#[derive(Debug, Clone, PartialEq)]
pub struct MacosTools {
    pub stat: String,
    pub pmset: String,
    pub ioreg: String,
    pub sysctl: String,
    pub systemProfiler: String,
}

#[allow(non_snake_case)]
#[derive(Debug, Clone, PartialEq)]
pub struct Policy {
    pub allowedWindowStart: String,
    pub allowedWindowEnd: String,
    pub maxConcurrentAgents: f64,
}

#[allow(non_snake_case)]
#[derive(Debug, Clone, PartialEq)]
pub struct ProbeConfig {
    pub idleMinutes: f64,
    pub batteryThreshold: f64,
    pub localModelsBaseUrl: String,
    pub localModelsTimeoutMs: f64,
    pub sysfsRoot: String,
    pub macosTools: MacosTools,
    pub policy: Policy,
}

#[allow(non_snake_case)]
#[derive(Debug, Clone, PartialEq)]
pub struct PluginConfig {
    pub hostFile: String,
}

#[allow(non_snake_case)]
#[derive(Debug, Clone, PartialEq)]
pub struct TimeWindow {
    pub start: String,
    pub end: String,
}

#[allow(non_snake_case)]
#[derive(Debug, Clone, PartialEq)]
pub struct HostFile {
    pub hostAlias: String,
    pub unattended: Option<TimeWindow>,
}

pub fn read_json(path: &str) -> Result<serde_json::Value, String> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) => return Err(format!("{}: {}", path, errno_name(&e))),
    };
    let text = String::from_utf8_lossy(&bytes).into_owned();
    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(v) => Ok(v),
        Err(_) => Err(format!("{}: parse error", path)),
    }
}

pub(crate) fn time_pattern() -> Regex {
    Regex::new(r"^([01][0-9]|2[0-3]):[0-5][0-9]$").unwrap()
}

pub(crate) fn host_alias_pattern() -> Regex {
    Regex::new(r"^[a-z][a-z0-9-]{0,31}$").unwrap()
}

pub fn assert_sysfs_root(root: &str, label: &str) -> Result<(), String> {
    if !root.starts_with('/') {
        return Err(format!("{}: {}: not an absolute path", label, root));
    }
    let class_dir = format!("{}/class", root);
    match std::fs::symlink_metadata(&class_dir) {
        Ok(meta) => {
            if !meta.is_dir() {
                return Err(format!("{}: {}: no class directory", label, root));
            }
            Ok(())
        }
        Err(e) => Err(format!("{}: {}: {}", label, root, errno_name(&e))),
    }
}

fn validate_macos_tools(value: &serde_json::Value) -> Result<MacosTools, String> {
    let label = "config probe.json: invalid macosTools";
    const KEYS: [&str; 5] = ["stat", "pmset", "ioreg", "sysctl", "systemProfiler"];
    let allowed: HashSet<&str> = KEYS.iter().copied().collect();
    // typeof [] is "object" in TS: an empty array fails on stat, a non-empty one on key 0.
    let synthetic;
    let obj = if let Some(o) = value.as_object() {
        o
    } else if let Some(arr) = value.as_array() {
        if arr.is_empty() {
            synthetic = serde_json::Map::new();
            &synthetic
        } else {
            return Err(format!("config probe.json: invalid macosTools.{}", 0));
        }
    } else {
        return Err(label.to_string());
    };
    for key in obj.keys() {
        if !allowed.contains(key.as_str()) {
            return Err(format!("config probe.json: invalid macosTools.{}", key));
        }
        let v = &obj[key];
        match v.as_str() {
            Some(s) if s.starts_with('/') => {}
            _ => return Err(format!("config probe.json: invalid macosTools.{}", key)),
        }
    }
    for key in KEYS {
        let v = obj.get(key);
        match v.and_then(|x| x.as_str()) {
            Some(s) if s.starts_with('/') => {}
            _ => return Err(format!("config probe.json: invalid macosTools.{}", key)),
        }
    }
    if obj.len() != KEYS.len() {
        return Err(label.to_string());
    }
    let stat = match obj.get("stat").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return Err("config probe.json: invalid macosTools.stat".to_string()),
    };
    let pmset = match obj.get("pmset").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return Err("config probe.json: invalid macosTools.pmset".to_string()),
    };
    let ioreg = match obj.get("ioreg").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return Err("config probe.json: invalid macosTools.ioreg".to_string()),
    };
    let sysctl = match obj.get("sysctl").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return Err("config probe.json: invalid macosTools.sysctl".to_string()),
    };
    let system_profiler = match obj.get("systemProfiler").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => {
            return Err("config probe.json: invalid macosTools.systemProfiler".to_string());
        }
    };
    Ok(MacosTools {
        stat,
        pmset,
        ioreg,
        sysctl,
        systemProfiler: system_profiler,
    })
}

pub fn load_config(path: &str, platform: Platform) -> Result<ProbeConfig, String> {
    let raw = read_json(path)?;
    let raw_obj = match raw.as_object() {
        Some(o) => o,
        None => {
            // TS reads raw["policy"] first, so a non-object top level fails as invalid policy.
            return Err("config probe.json: invalid policy".to_string());
        }
    };

    let num = |key: &str, min: f64, max: f64| -> Result<f64, String> {
        let v = raw_obj.get(key);
        match v.and_then(|x| x.as_f64()) {
            Some(n) if n.is_finite() && n >= min && n <= max => Ok(n),
            _ => Err(format!("config probe.json: invalid {}", key)),
        }
    };
    let str_val = |key: &str| -> Result<String, String> {
        let v = raw_obj.get(key);
        match v.and_then(|x| x.as_str()) {
            Some(s) => Ok(s.to_string()),
            None => Err(format!("config probe.json: invalid {}", key)),
        }
    };
    let non_empty = |key: &str| -> Result<String, String> {
        let s = str_val(key)?;
        if s.is_empty() {
            return Err(format!("config probe.json: invalid {}", key));
        }
        Ok(s)
    };

    let policy_raw = raw_obj.get("policy");
    let empty_map = serde_json::Map::new();
    let policy_obj = match policy_raw.and_then(|v| v.as_object()) {
        Some(o) => o,
        None => {
            if policy_raw.is_some_and(|v| v.is_array()) {
                &empty_map
            } else {
                return Err("config probe.json: invalid policy".to_string());
            }
        }
    };

    let time_re = time_pattern();
    for key in ["allowedWindowStart", "allowedWindowEnd"] {
        let v = policy_obj.get(key);
        match v.and_then(|x| x.as_str()) {
            Some(s) if time_re.is_match(s) => {}
            _ => return Err(format!("config probe.json: invalid policy.{}", key)),
        }
    }

    let max_agents_val = policy_obj.get("maxConcurrentAgents");
    let max_agents = match max_agents_val.and_then(|v| v.as_f64()) {
        Some(n) if n.is_finite() && n.fract() == 0.0 && n >= 1.0 => n,
        _ => return Err("config probe.json: invalid policy.maxConcurrentAgents".to_string()),
    };

    let sysfs_root = non_empty("sysfsRoot")?;
    if platform == Platform::Linux {
        assert_sysfs_root(&sysfs_root, "config probe.json: invalid sysfsRoot")?;
    }

    let idle_minutes = num("idleMinutes", 1.0, f64::INFINITY)?;
    let battery_threshold = num("batteryThreshold", 0.0, 100.0)?;
    let local_models_base_url = str_val("localModelsBaseUrl")?;
    let local_models_timeout_ms = num("localModelsTimeoutMs", 0.0, f64::INFINITY)?;

    let macos_tools_val = raw_obj
        .get("macosTools")
        .unwrap_or(&serde_json::Value::Null);
    let macos_tools = validate_macos_tools(macos_tools_val)?;

    let allowed_start = match policy_obj
        .get("allowedWindowStart")
        .and_then(|v| v.as_str())
    {
        Some(s) => s.to_string(),
        None => {
            return Err("config probe.json: invalid policy.allowedWindowStart".to_string());
        }
    };
    let allowed_end = match policy_obj.get("allowedWindowEnd").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return Err("config probe.json: invalid policy.allowedWindowEnd".to_string()),
    };
    let policy = Policy {
        allowedWindowStart: allowed_start,
        allowedWindowEnd: allowed_end,
        maxConcurrentAgents: max_agents,
    };

    Ok(ProbeConfig {
        idleMinutes: idle_minutes,
        batteryThreshold: battery_threshold,
        localModelsBaseUrl: local_models_base_url,
        localModelsTimeoutMs: local_models_timeout_ms,
        sysfsRoot: sysfs_root,
        macosTools: macos_tools,
        policy,
    })
}

pub fn load_plugin_config(path: &str) -> Result<PluginConfig, String> {
    let raw = read_json(path)?;
    let obj = match raw.as_object() {
        Some(o) => o,
        None => return Err("config plugin.json: invalid hostFile".to_string()),
    };
    if obj.len() != 1 || !obj.contains_key("hostFile") {
        return Err("config plugin.json: invalid hostFile".to_string());
    }
    let Some(host_file) = obj.get("hostFile") else {
        return Err("config plugin.json: invalid hostFile".to_string());
    };
    match host_file.as_str() {
        Some(s) if s.starts_with('/') => Ok(PluginConfig {
            hostFile: s.to_string(),
        }),
        _ => Err("config plugin.json: invalid hostFile".to_string()),
    }
}

pub fn load_host_file(path: &str) -> Result<HostFile, String> {
    let text = match std::fs::read(path) {
        Ok(b) => String::from_utf8_lossy(&b).into_owned(),
        Err(e) => return Err(format!("host file {}: {}", path, errno_name(&e))),
    };
    let raw: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return Err(format!("host file {}: invalid hostAlias", path)),
    };
    let record = match raw.as_object() {
        Some(o) => o,
        None => return Err(format!("host file {}: invalid hostAlias", path)),
    };
    let alias_val = record.get("hostAlias");
    let alias_str = match alias_val.and_then(|v| v.as_str()) {
        Some(s) => s,
        None => return Err(format!("host file {}: invalid hostAlias", path)),
    };
    let alias_re = host_alias_pattern();
    if !alias_re.is_match(alias_str) {
        return Err(format!("host file {}: invalid hostAlias", path));
    }

    for key in record.keys() {
        if key != "hostAlias" && key != "unattended" {
            return Err(format!("host file {}: invalid {}", path, key));
        }
    }

    let unattended_raw = record.get("unattended");
    if unattended_raw.is_none() {
        return Ok(HostFile {
            hostAlias: alias_str.to_string(),
            unattended: None,
        });
    }
    let Some(unattended_val) = unattended_raw else {
        return Err(format!("host file {}: invalid unattended", path));
    };
    let win_obj = match unattended_val.as_object() {
        Some(o) => o,
        None => return Err(format!("host file {}: invalid unattended", path)),
    };
    if win_obj.len() != 2 || !win_obj.contains_key("start") || !win_obj.contains_key("end") {
        return Err(format!("host file {}: invalid unattended", path));
    }
    let start = win_obj.get("start").and_then(|v| v.as_str());
    let end = win_obj.get("end").and_then(|v| v.as_str());
    let time_re = time_pattern();
    match (start, end) {
        (Some(s), Some(e)) if time_re.is_match(s) && time_re.is_match(e) => Ok(HostFile {
            hostAlias: alias_str.to_string(),
            unattended: Some(TimeWindow {
                start: s.to_string(),
                end: e.to_string(),
            }),
        }),
        _ => Err(format!("host file {}: invalid unattended", path)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::Platform;
    use std::fs;
    use std::path::PathBuf;

    fn workspace_path(rel: &str) -> String {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        manifest
            .join("../../")
            .join(rel)
            .to_str()
            .unwrap()
            .to_string()
    }

    fn tmp_path(name: &str) -> String {
        let dir = std::env::temp_dir().join(format!("moc-config-test-{}", name));
        let _ = fs::create_dir_all(&dir);
        dir.join("file.json").to_str().unwrap().to_string()
    }

    #[test]
    fn config_loading() {
        // config/probe.json with Platform::current() should load
        let probe = load_config(&workspace_path("config/probe.json"), Platform::current())
            .expect("probe.json should load");
        assert_eq!(probe.idleMinutes, 15.0);
        // config/plugin.json should load
        let plugin = load_plugin_config(&workspace_path("config/plugin.json"))
            .expect("plugin.json should load");
        assert!(plugin.hostFile.starts_with('/'));

        // host file with invalid unattended 24:00
        let p1 = tmp_path("host1");
        fs::write(
            &p1,
            r#"{"hostAlias":"laptop-b","unattended":{"start":"24:00","end":"07:00"}}"#,
        )
        .unwrap();
        let err = load_host_file(&p1).unwrap_err();
        assert!(
            err.contains("invalid unattended"),
            "expected invalid unattended, got {}",
            err
        );

        // host file with invalid hostAlias
        let p2 = tmp_path("host2");
        fs::write(&p2, r#"{"hostAlias":"Laptop"}"#).unwrap();
        let err2 = load_host_file(&p2).unwrap_err();
        assert!(
            err2.contains("invalid hostAlias"),
            "expected invalid hostAlias, got {}",
            err2
        );
    }
}

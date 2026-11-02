use crate::platform::Platform;
use crate::time::parse_timestamp;
use regex::Regex;
use std::collections::HashSet;

#[allow(non_snake_case)]
#[derive(Debug, Clone, PartialEq)]
pub struct Facts {
    pub secondsSinceInput: Option<f64>,
    pub userActivityError: Option<String>,
    pub noLocalUserSession: Option<bool>,
    pub sysfsRoot: Option<String>,
    pub acPower: Option<bool>,
    pub batteryPercent: Option<Option<f64>>,
    pub cpuCores: Option<f64>,
    pub cpuLoad1m: Option<f64>,
    pub memoryTotalMb: Option<f64>,
    pub memoryFreeMb: Option<f64>,
    pub gpuPresent: Option<bool>,
    pub gpuName: Option<Option<String>>,
    pub gpuFreeMb: Option<Option<f64>>,
    pub localModelsReachable: Option<bool>,
    pub localModels: Option<Vec<String>>,
    pub hostAlias: Option<String>,
    pub timestamp: Option<String>,
    pub policyAllowedWindowStart: Option<String>,
    pub policyAllowedWindowEnd: Option<String>,
}

pub fn validate_facts(
    value: &serde_json::Value,
    path: &str,
    platform: Platform,
) -> Result<Facts, String> {
    let prefix = format!("facts {}:", path);

    let obj = match value.as_object() {
        Some(o) => o,
        None => return Err(format!("{} facts: not an object", prefix)),
    };

    const KNOWN: [&str; 19] = [
        "secondsSinceInput",
        "userActivityError",
        "noLocalUserSession",
        "sysfsRoot",
        "acPower",
        "batteryPercent",
        "cpuCores",
        "cpuLoad1m",
        "memoryTotalMb",
        "memoryFreeMb",
        "gpuPresent",
        "gpuName",
        "gpuFreeMb",
        "localModelsReachable",
        "localModels",
        "hostAlias",
        "timestamp",
        "policyAllowedWindowStart",
        "policyAllowedWindowEnd",
    ];
    let known_set: HashSet<&str> = KNOWN.iter().copied().collect();

    // Ajv reports an unknown key before any other error.
    for key in obj.keys() {
        if !known_set.contains(key.as_str()) {
            return Err(format!("{} {}: unknown key", prefix, key));
        }
    }

    let err_for = |key: &str, msg: &str| format!("{} {}: {}", prefix, key, msg);
    let host_alias_re = crate::config::host_alias_pattern();
    let timestamp_re =
        Regex::new(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$").unwrap();
    let window_re = crate::config::time_pattern();

    for key in KNOWN {
        if let Some(v) = obj.get(key) {
            match key {
                "secondsSinceInput" => {
                    let Some(n) = v.as_f64().filter(|n| n.is_finite() && n.fract() == 0.0) else {
                        return Err(err_for(key, "must be integer"));
                    };
                    if n < 0.0 {
                        return Err(err_for(key, "must be >= 0"));
                    }
                }
                "userActivityError" => {
                    let Some(s) = v.as_str() else {
                        return Err(err_for(key, "must be string"));
                    };
                    if s.is_empty() {
                        return Err(err_for(key, "must NOT have fewer than 1 characters"));
                    }
                }
                "noLocalUserSession" => {
                    if v != &serde_json::Value::Bool(true) {
                        return Err(err_for(key, "must be true or absent"));
                    }
                }
                "sysfsRoot" => {
                    let Some(s) = v.as_str() else {
                        return Err(err_for(key, "must be string"));
                    };
                    if !s.starts_with('/') {
                        return Err(err_for(key, "must match pattern \"^/\""));
                    }
                }
                "acPower" => {
                    if !v.is_boolean() {
                        return Err(err_for(key, "must be boolean"));
                    }
                }
                "batteryPercent" => {
                    if v.is_null() {
                    } else {
                        let Some(n) = v.as_f64().filter(|n| n.is_finite() && n.fract() == 0.0)
                        else {
                            return Err(err_for(key, "must be integer,null"));
                        };
                        if n < 0.0 {
                            return Err(err_for(key, "must be >= 0"));
                        }
                        if n > 100.0 {
                            return Err(err_for(key, "must be <= 100"));
                        }
                    }
                }
                "cpuCores" => {
                    let Some(n) = v.as_f64().filter(|n| n.is_finite() && n.fract() == 0.0) else {
                        return Err(err_for(key, "must be integer"));
                    };
                    if n < 1.0 {
                        return Err(err_for(key, "must be >= 1"));
                    }
                }
                "cpuLoad1m" => {
                    let Some(n) = v.as_f64() else {
                        return Err(err_for(key, "must be number"));
                    };
                    if n < 0.0 {
                        return Err(err_for(key, "must be >= 0"));
                    }
                }
                "memoryTotalMb" => {
                    let Some(n) = v.as_f64().filter(|n| n.is_finite() && n.fract() == 0.0) else {
                        return Err(err_for(key, "must be integer"));
                    };
                    if n < 1.0 {
                        return Err(err_for(key, "must be >= 1"));
                    }
                }
                "memoryFreeMb" => {
                    let Some(n) = v.as_f64().filter(|n| n.is_finite() && n.fract() == 0.0) else {
                        return Err(err_for(key, "must be integer"));
                    };
                    if n < 0.0 {
                        return Err(err_for(key, "must be >= 0"));
                    }
                }
                "gpuPresent" => {
                    if !v.is_boolean() {
                        return Err(err_for(key, "must be boolean"));
                    }
                }
                "gpuName" => {
                    if v.is_null() {
                    } else {
                        let Some(s) = v.as_str() else {
                            return Err(err_for(key, "must be string,null"));
                        };
                        if s.is_empty() {
                            return Err(err_for(key, "must NOT have fewer than 1 characters"));
                        }
                    }
                }
                "gpuFreeMb" => {
                    if v.is_null() {
                    } else {
                        let Some(n) = v.as_f64().filter(|n| n.is_finite() && n.fract() == 0.0)
                        else {
                            return Err(err_for(key, "must be integer,null"));
                        };
                        if n < 0.0 {
                            return Err(err_for(key, "must be >= 0"));
                        }
                    }
                }
                "localModelsReachable" => {
                    if !v.is_boolean() {
                        return Err(err_for(key, "must be boolean"));
                    }
                }
                "localModels" => {
                    let Some(arr) = v.as_array() else {
                        return Err(err_for(key, "must be array"));
                    };
                    for (idx, item) in arr.iter().enumerate() {
                        let Some(s) = item.as_str() else {
                            return Err(format!("{} {}/{}: must be string", prefix, key, idx));
                        };
                        if s.is_empty() {
                            return Err(format!(
                                "{} {}/{}: must NOT have fewer than 1 characters",
                                prefix, key, idx
                            ));
                        }
                    }
                    if has_duplicates(arr) {
                        let (a, b) = duplicate_indices(arr);
                        return Err(err_for(
                            key,
                            &format!(
                                "must NOT have duplicate items (items ## {} and {} are identical)",
                                a, b
                            ),
                        ));
                    }
                }
                "hostAlias" => {
                    let Some(s) = v.as_str() else {
                        return Err(err_for(key, "must be string"));
                    };
                    if !host_alias_re.is_match(s) {
                        return Err(err_for(
                            key,
                            "must match pattern \"^[a-z][a-z0-9-]{0,31}$\"",
                        ));
                    }
                }
                "timestamp" => {
                    let Some(s) = v.as_str() else {
                        return Err(err_for(key, "must be string"));
                    };
                    if !timestamp_re.is_match(s) {
                        return Err(err_for(
                            key,
                            "must match pattern \"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$\"",
                        ));
                    }
                }
                "policyAllowedWindowStart" | "policyAllowedWindowEnd" => {
                    let Some(s) = v.as_str() else {
                        return Err(err_for(key, "must be string"));
                    };
                    if !window_re.is_match(s) {
                        return Err(err_for(
                            key,
                            "must match pattern \"^([01][0-9]|2[0-3]):[0-5][0-9]$\"",
                        ));
                    }
                }
                _ => {}
            }
        }
    }

    if let Some(v) = obj.get("timestamp") {
        if let Some(s) = v.as_str() {
            if parse_timestamp(s).is_none() {
                return Err(err_for("timestamp", "not a real calendar date"));
            }
        }
    }

    if let Some(v) = obj.get("sysfsRoot") {
        if v.is_string() && platform == Platform::Linux {
            let Some(s) = v.as_str() else {
                return Err(err_for("sysfsRoot", "must be string"));
            };
            let label = format!("facts {}: invalid sysfsRoot", path);
            if let Err(e) = crate::config::assert_sysfs_root(s, &label) {
                let detail = e.split(": ").last().unwrap_or("invalid").to_string();
                return Err(format!("{} sysfsRoot: {}", prefix, detail));
            }
        }
    }

    if obj.get("noLocalUserSession") == Some(&serde_json::Value::Bool(true))
        && !obj.contains_key("secondsSinceInput")
    {
        return Err(err_for(
            "secondsSinceInput",
            "required with noLocalUserSession",
        ));
    }

    let get_f64 = |k: &str| obj.get(k).and_then(|v| v.as_f64());
    let get_str = |k: &str| obj.get(k).and_then(|v| v.as_str()).map(|s| s.to_string());
    let get_bool = |k: &str| obj.get(k).and_then(|v| v.as_bool());
    let get_nullable_f64 = |k: &str| -> Option<Option<f64>> {
        obj.get(k)
            .map(|v| if v.is_null() { None } else { v.as_f64() })
    };
    let get_nullable_str = |k: &str| -> Option<Option<String>> {
        obj.get(k).map(|v| {
            if v.is_null() {
                None
            } else {
                v.as_str().map(|s| s.to_string())
            }
        })
    };

    let local_models = obj
        .get("localModels")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        });

    Ok(Facts {
        secondsSinceInput: get_f64("secondsSinceInput"),
        userActivityError: get_str("userActivityError"),
        noLocalUserSession: get_bool("noLocalUserSession"),
        sysfsRoot: get_str("sysfsRoot"),
        acPower: get_bool("acPower"),
        batteryPercent: get_nullable_f64("batteryPercent"),
        cpuCores: get_f64("cpuCores"),
        cpuLoad1m: get_f64("cpuLoad1m"),
        memoryTotalMb: get_f64("memoryTotalMb"),
        memoryFreeMb: get_f64("memoryFreeMb"),
        gpuPresent: get_bool("gpuPresent"),
        gpuName: get_nullable_str("gpuName"),
        gpuFreeMb: get_nullable_f64("gpuFreeMb"),
        localModelsReachable: get_bool("localModelsReachable"),
        localModels: local_models,
        hostAlias: get_str("hostAlias"),
        timestamp: get_str("timestamp"),
        policyAllowedWindowStart: get_str("policyAllowedWindowStart"),
        policyAllowedWindowEnd: get_str("policyAllowedWindowEnd"),
    })
}

fn has_duplicates(arr: &[serde_json::Value]) -> bool {
    for i in 0..arr.len() {
        for j in 0..i {
            if arr[i] == arr[j] {
                return true;
            }
        }
    }
    false
}

// Ajv scans uniqueItems from the end and reports the first repeat it meets, later index first.
fn duplicate_indices(arr: &[serde_json::Value]) -> (usize, usize) {
    let mut seen = std::collections::HashMap::new();
    for i in (0..arr.len()).rev() {
        if let Some(s) = arr[i].as_str() {
            if let Some(&j) = seen.get(s) {
                return (j, i);
            }
            seen.insert(s, i);
        }
    }
    (0, 0)
}

pub fn load_facts(path: &str, platform: Platform) -> Result<Facts, String> {
    let value = crate::config::read_json(path)?;
    validate_facts(&value, path, platform)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::Platform;
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

    fn validate(json: serde_json::Value) -> Result<Facts, String> {
        validate_facts(&json, "/tmp/test.json", Platform::Linux)
    }

    #[test]
    fn facts_validation() {
        for entry in std::fs::read_dir(workspace_path("config/scenarios")).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path().to_str().unwrap().to_string();
            let v = crate::config::read_json(&path).expect("read scenario");
            validate_facts(&v, &path, Platform::current())
                .unwrap_or_else(|e| panic!("scenario {} failed: {}", path, e));
        }

        let v = serde_json::json!({"cpuCores": 4.0});
        let f = validate(v).expect("cpuCores 4.0 should validate");
        assert_eq!(f.cpuCores, Some(4.0));

        let v: serde_json::Value =
            serde_json::from_str(r#"{"cpuLoad1m":0.23015367057258163}"#).unwrap();
        let f = validate(v).expect("cpuLoad1m float should validate");
        assert_eq!(f.cpuLoad1m, Some(0.23015367057258163));

        let v = serde_json::json!({"batteryPercent": null, "gpuName": null, "gpuFreeMb": null});
        let f = validate(v).expect("null values should validate");
        assert_eq!(f.batteryPercent, Some(None));
        assert_eq!(f.gpuName, Some(None));
        assert_eq!(f.gpuFreeMb, Some(None));

        let v = serde_json::json!({});
        let f = validate(v).expect("empty should validate");
        assert_eq!(f.batteryPercent, None);
        assert_eq!(f.gpuName, None);
        assert_eq!(f.gpuFreeMb, None);

        {
            let base =
                std::env::temp_dir().join(format!("moc-facts-sysfs-{}-{}", std::process::id(), 1));
            let _ = std::fs::remove_dir_all(&base);
            std::fs::create_dir_all(&base).unwrap();
            let real_root = base.join("real");
            std::fs::create_dir_all(real_root.join("class")).unwrap();
            let real_str = real_root.to_str().unwrap().to_string();
            let v = serde_json::json!({"sysfsRoot": real_str});
            let f = validate(v).expect("real class dir should validate");
            assert_eq!(f.sysfsRoot, Some(real_str.clone()));
            let link_root = base.join("link");
            let target = base.join("target");
            std::fs::create_dir_all(&target).unwrap();
            std::fs::create_dir_all(&link_root).unwrap();
            std::os::unix::fs::symlink(&target, link_root.join("class")).unwrap();
            let link_str = link_root.to_str().unwrap().to_string();
            let v2 = serde_json::json!({"sysfsRoot": link_str});
            let err = validate(v2).unwrap_err();
            assert_eq!(err, "facts /tmp/test.json: sysfsRoot: no class directory");
            let _ = std::fs::remove_dir_all(&base);
        }

        let cases = vec![
            serde_json::json!({"noLocalUserSession": false}),
            serde_json::json!({"noLocalUserSession": true}),
            serde_json::json!({"extra": 1}),
            serde_json::json!({"localModels": ["a","a"]}),
            serde_json::json!({"gpuName": ""}),
            serde_json::json!({"batteryPercent": 101}),
            serde_json::json!({"timestamp": "2026-02-30T00:00:00.000Z"}),
        ];
        for c in cases {
            assert!(
                validate(c.clone()).is_err(),
                "expected rejection for {:?}",
                c
            );
        }
    }
}

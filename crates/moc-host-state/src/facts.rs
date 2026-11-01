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

fn is_integer_number(v: &serde_json::Value) -> bool {
    match v.as_f64() {
        Some(n) => n.is_finite() && n.fract() == 0.0,
        None => false,
    }
}

fn is_number(v: &serde_json::Value) -> bool {
    v.as_f64().is_some()
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

    // Known keys in schema order
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

    // Additional properties check first (Ajv reports unknown key first)
    for key in obj.keys() {
        if !known_set.contains(key.as_str()) {
            return Err(format!("{} {}: unknown key", prefix, key));
        }
    }

    // Helper to produce error
    let err_for = |key: &str, msg: &str| format!("{} {}: {}", prefix, key, msg);
    let host_alias_re = Regex::new(r"^[a-z][a-z0-9-]{0,31}$").unwrap();
    let timestamp_re = Regex::new(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$").unwrap();
    let window_re = Regex::new(r"^([01][0-9]|2[0-3]):[0-5][0-9]$").unwrap();

    // Validate in schema order, returning first error
    for key in KNOWN {
        if let Some(v) = obj.get(key) {
            // Each key's validation
            match key {
                "secondsSinceInput" => {
                    if !is_integer_number(v) {
                        return Err(err_for(key, "must be integer"));
                    }
                    let n = v.as_f64().unwrap();
                    if n < 0.0 {
                        return Err(err_for(key, "must be >= 0"));
                    }
                }
                "userActivityError" => {
                    if !v.is_string() {
                        return Err(err_for(key, "must be string"));
                    }
                    let s = v.as_str().unwrap();
                    if s.is_empty() {
                        return Err(err_for(key, "must NOT have fewer than 1 characters"));
                    }
                }
                "noLocalUserSession" => {
                    // const true
                    if v != &serde_json::Value::Bool(true) {
                        return Err(err_for(key, "must be true or absent"));
                    }
                }
                "sysfsRoot" => {
                    if !v.is_string() {
                        return Err(err_for(key, "must be string"));
                    }
                    let s = v.as_str().unwrap();
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
                        // valid null
                    } else if !is_integer_number(v) {
                        return Err(err_for(key, "must be integer,null"));
                    } else {
                        let n = v.as_f64().unwrap();
                        if n < 0.0 {
                            return Err(err_for(key, "must be >= 0"));
                        }
                        if n > 100.0 {
                            return Err(err_for(key, "must be <= 100"));
                        }
                    }
                }
                "cpuCores" => {
                    if !is_integer_number(v) {
                        return Err(err_for(key, "must be integer"));
                    }
                    let n = v.as_f64().unwrap();
                    if n < 1.0 {
                        return Err(err_for(key, "must be >= 1"));
                    }
                }
                "cpuLoad1m" => {
                    if !is_number(v) {
                        return Err(err_for(key, "must be number"));
                    }
                    let n = v.as_f64().unwrap();
                    if n < 0.0 {
                        return Err(err_for(key, "must be >= 0"));
                    }
                }
                "memoryTotalMb" => {
                    if !is_integer_number(v) {
                        return Err(err_for(key, "must be integer"));
                    }
                    let n = v.as_f64().unwrap();
                    if n < 1.0 {
                        return Err(err_for(key, "must be >= 1"));
                    }
                }
                "memoryFreeMb" => {
                    if !is_integer_number(v) {
                        return Err(err_for(key, "must be integer"));
                    }
                    let n = v.as_f64().unwrap();
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
                    } else if !v.is_string() {
                        return Err(err_for(key, "must be string,null"));
                    } else {
                        let s = v.as_str().unwrap();
                        if s.is_empty() {
                            return Err(err_for(key, "must NOT have fewer than 1 characters"));
                        }
                    }
                }
                "gpuFreeMb" => {
                    if v.is_null() {
                    } else if !is_integer_number(v) {
                        return Err(err_for(key, "must be integer,null"));
                    } else {
                        let n = v.as_f64().unwrap();
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
                    if !v.is_array() {
                        return Err(err_for(key, "must be array"));
                    }
                    let arr = v.as_array().unwrap();
                    // Items validation: each must be string minLength 1
                    for (idx, item) in arr.iter().enumerate() {
                        if !item.is_string() {
                            return Err(format!("{} {}/{}: must be string", prefix, key, idx));
                        }
                        let s = item.as_str().unwrap();
                        if s.is_empty() {
                            return Err(format!(
                                "{} {}/{}: must NOT have fewer than 1 characters",
                                prefix, key, idx
                            ));
                        }
                    }
                    // uniqueItems
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
                    if !v.is_string() {
                        return Err(err_for(key, "must be string"));
                    }
                    let s = v.as_str().unwrap();
                    if !host_alias_re.is_match(s) {
                        return Err(err_for(
                            key,
                            "must match pattern \"^[a-z][a-z0-9-]{0,31}$\"",
                        ));
                    }
                }
                "timestamp" => {
                    if !v.is_string() {
                        return Err(err_for(key, "must be string"));
                    }
                    let s = v.as_str().unwrap();
                    if !timestamp_re.is_match(s) {
                        return Err(err_for(
                            key,
                            "must match pattern \"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$\"",
                        ));
                    }
                }
                "policyAllowedWindowStart" | "policyAllowedWindowEnd" => {
                    if !v.is_string() {
                        return Err(err_for(key, "must be string"));
                    }
                    let s = v.as_str().unwrap();
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

    // Timestamp real calendar date check (after Ajv passes)
    if let Some(v) = obj.get("timestamp") {
        if let Some(s) = v.as_str() {
            if parse_timestamp(s).is_none() {
                return Err(err_for("timestamp", "not a real calendar date"));
            }
        }
    }

    // sysfsRoot Linux check
    if let Some(v) = obj.get("sysfsRoot") {
        if v.is_string() && platform == Platform::Linux {
            let s = v.as_str().unwrap();
            let label = format!("facts {}: invalid sysfsRoot", path);
            if let Err(e) = crate::config::assert_sysfs_root(s, &label) {
                // Extract detail after last ": "
                let detail = e.split(": ").last().unwrap_or("invalid").to_string();
                return Err(format!("{} sysfsRoot: {}", prefix, detail));
            }
        }
    }

    // noLocalUserSession requires secondsSinceInput
    if obj.get("noLocalUserSession") == Some(&serde_json::Value::Bool(true))
        && !obj.contains_key("secondsSinceInput")
    {
        return Err(err_for(
            "secondsSinceInput",
            "required with noLocalUserSession",
        ));
    }

    // Build Facts struct after validation
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

fn duplicate_indices(arr: &[serde_json::Value]) -> (usize, usize) {
    // Reproduce Ajv behavior: find last index that has duplicate, report with nearest previous
    // Iterate i from end backwards
    for i in (0..arr.len()).rev() {
        // Find nearest j < i with same value, largest j
        let mut nearest: Option<usize> = None;
        for j in (0..i).rev() {
            if arr[i] == arr[j] {
                nearest = Some(j);
                break;
            }
        }
        if let Some(j) = nearest {
            return (i, j);
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
        // every config/scenarios/*.json validates
        for entry in std::fs::read_dir(workspace_path("config/scenarios")).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path().to_str().unwrap().to_string();
            let v = crate::config::read_json(&path).expect("read scenario");
            validate_facts(&v, &path, Platform::current())
                .unwrap_or_else(|e| panic!("scenario {} failed: {}", path, e));
        }

        // {"cpuCores": 4.0} validates to Some(4.0)
        let v = serde_json::json!({"cpuCores": 4.0});
        let f = validate(v).expect("cpuCores 4.0 should validate");
        assert_eq!(f.cpuCores, Some(4.0));

        // rejected cases
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

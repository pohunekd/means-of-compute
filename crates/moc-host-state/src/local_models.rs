use std::collections::HashSet;
use std::time::Duration;

/// Query local models from the given base URL.
pub fn query_local_models(base_url: &str, timeout_ms: f64) -> (bool, Vec<String>) {
    if base_url.is_empty() {
        return (false, Vec::new());
    }
    let base_trimmed = base_url.strip_suffix('/').unwrap_or(base_url);
    let url = format!("{base_trimmed}/v1/models");

    let ms = if (1.0..=2147483647.0).contains(&timeout_ms) {
        timeout_ms
    } else {
        1.0
    };
    let timeout = Duration::from_secs_f64(ms / 1000.0);

    let agent = build_agent(timeout);

    let resp = match agent.get(&url).call() {
        Ok(r) => r,
        Err(_) => return (false, Vec::new()),
    };

    let status = resp.status();
    if !(200..300).contains(&status.as_u16()) || status.as_u16() == 205 {
        return (false, Vec::new());
    }

    let bytes = match resp
        .into_body()
        .with_config()
        .limit(10 * 1024 * 1024)
        .read_to_vec()
    {
        Ok(b) => b,
        Err(_) => return (false, Vec::new()),
    };
    let text = String::from_utf8_lossy(&bytes);
    let body = text.strip_prefix('\u{FEFF}').unwrap_or(&text);

    let data: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return (false, Vec::new()),
    };

    let items = match &data {
        serde_json::Value::Object(map) => match map.get("data") {
            Some(serde_json::Value::Array(arr)) => arr,
            _ => return (false, Vec::new()),
        },
        _ => return (false, Vec::new()),
    };

    let mut seen = HashSet::new();
    let mut models = Vec::new();
    for entry in items {
        let obj = match entry {
            serde_json::Value::Object(m) => m,
            _ => continue,
        };
        let id_val = match obj.get("id") {
            Some(v) => v,
            None => continue,
        };
        let id_str = match id_val {
            serde_json::Value::String(s) => s,
            _ => continue,
        };
        if id_str.is_empty() || seen.contains(id_str) {
            continue;
        }
        seen.insert(id_str.clone());
        models.push(id_str.clone());
    }

    (true, models)
}

fn build_agent(timeout: Duration) -> ureq::Agent {
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .proxy(None)
        .max_redirects(126)
        .build();
    config.new_agent()
}

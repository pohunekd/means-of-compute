use std::collections::HashSet;
use std::time::Duration;

/// Query local models from base_url, mirroring src/probe/probe.ts queryLocalModels.
///
/// Empty base returns (false, []) without any socket. A single trailing `/` is stripped,
/// then GET `<base>/v1/models` is issued with a global timeout of `timeout_ms`.
/// Any error, non-2xx, unreadable body, non-JSON, or missing `data` array gives (false, []).
/// IDs are deduplicated in order; only non-empty string `id` values are kept.
pub fn query_local_models(base_url: &str, timeout_ms: f64) -> (bool, Vec<String>) {
    if base_url.is_empty() {
        return (false, Vec::new());
    }
    let base_trimmed = base_url.strip_suffix('/').unwrap_or(base_url);
    let url = format!("{base_trimmed}/v1/models");

    // Build timeout duration from timeout_ms. The TS value is a finite number
    // validated by config; convert via millis, clamped and handling non-finite.
    let timeout = if !timeout_ms.is_finite() || timeout_ms <= 0.0 {
        Duration::from_millis(0)
    } else {
        // Use from_millis with truncation; for fractional values use from_secs_f64
        // but to keep simple, use duration from millis with rounding.
        let millis = timeout_ms.round().max(0.0) as u64;
        Duration::from_millis(millis)
    };

    // Create ureq agent with global timeout. No TLS feature is enabled, so https
    // URLs will error and be mapped to (false, []).
    let agent = match build_agent(timeout) {
        Some(a) => a,
        None => return (false, Vec::new()),
    };

    let resp = match agent.get(&url).call() {
        Ok(r) => r,
        Err(_) => return (false, Vec::new()),
    };

    // Check non-2xx: ureq's call() returns Ok even for 4xx? Need to check status.
    // In ureq 3, call() returns error for non-2xx if http_status_as_error is true (default).
    // But to be safe, check status code ourselves.
    let status = resp.status();
    if !(200..300).contains(&status.as_u16()) {
        return (false, Vec::new());
    }

    // Read body; unreadable gives (false, []).
    let body = match resp.into_body().read_to_string() {
        Ok(s) => s,
        Err(_) => return (false, Vec::new()),
    };

    let data: serde_json::Value = match serde_json::from_str(&body) {
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

fn build_agent(timeout: Duration) -> Option<ureq::Agent> {
    // `timeout_global` expects Option<Duration>. When timeout is 0, we still set
    // Some(0) which will cause immediate timeout; alternatively we could set None
    // but spec says global timeout is timeout_ms.
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .build();
    Some(config.new_agent())
}

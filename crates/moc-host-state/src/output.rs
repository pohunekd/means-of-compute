use crate::config::{host_alias_pattern, time_pattern};
use crate::js::format_number;
use crate::time::parse_timestamp;

#[allow(non_snake_case)]
#[derive(Debug, Clone, PartialEq)]
pub struct Cpu {
    pub cores: f64,
    pub load1m: f64,
}

#[allow(non_snake_case)]
#[derive(Debug, Clone, PartialEq)]
pub struct Memory {
    pub totalMb: f64,
    pub freeMb: f64,
}

#[allow(non_snake_case)]
#[derive(Debug, Clone, PartialEq)]
pub struct Gpu {
    pub present: bool,
    pub name: Option<String>,
    pub freeMb: Option<f64>,
}

#[allow(non_snake_case)]
#[derive(Debug, Clone, PartialEq)]
pub struct LocalModels {
    pub reachable: bool,
    pub models: Vec<String>,
}

#[allow(non_snake_case)]
#[derive(Debug, Clone, PartialEq)]
pub struct AllowedWindow {
    pub start: String,
    pub end: String,
}

#[allow(non_snake_case)]
#[derive(Debug, Clone, PartialEq)]
pub struct Policy {
    pub allowedWindow: AllowedWindow,
    pub insideWindow: bool,
    pub maxConcurrentAgents: f64,
}

#[allow(non_snake_case)]
#[derive(Debug, Clone, PartialEq)]
pub struct HostCapacity {
    pub schemaVersion: String,
    pub hostAlias: String,
    pub timestamp: String,
    pub idle: bool,
    pub idleReason: String,
    pub secondsSinceInput: f64,
    pub acPower: bool,
    pub batteryPercent: Option<f64>,
    pub cpu: Cpu,
    pub memory: Memory,
    pub gpu: Gpu,
    pub localModels: LocalModels,
    pub policy: Policy,
}

pub fn to_json_line(hc: &HostCapacity) -> String {
    let mut out = String::new();
    out.push('{');
    out.push_str("\"schemaVersion\":");
    out.push_str(&serde_json::to_string(&hc.schemaVersion).unwrap());
    out.push_str(",\"hostAlias\":");
    out.push_str(&serde_json::to_string(&hc.hostAlias).unwrap());
    out.push_str(",\"timestamp\":");
    out.push_str(&serde_json::to_string(&hc.timestamp).unwrap());
    out.push_str(",\"idle\":");
    out.push_str(if hc.idle { "true" } else { "false" });
    out.push_str(",\"idleReason\":");
    out.push_str(&serde_json::to_string(&hc.idleReason).unwrap());
    out.push_str(",\"secondsSinceInput\":");
    out.push_str(&format_number(hc.secondsSinceInput));
    out.push_str(",\"acPower\":");
    out.push_str(if hc.acPower { "true" } else { "false" });
    out.push_str(",\"batteryPercent\":");
    match hc.batteryPercent {
        Some(v) => out.push_str(&format_number(v)),
        None => out.push_str("null"),
    }
    out.push_str(",\"cpu\":{\"cores\":");
    out.push_str(&format_number(hc.cpu.cores));
    out.push_str(",\"load1m\":");
    out.push_str(&format_number(hc.cpu.load1m));
    out.push('}');
    out.push_str(",\"memory\":{\"totalMb\":");
    out.push_str(&format_number(hc.memory.totalMb));
    out.push_str(",\"freeMb\":");
    out.push_str(&format_number(hc.memory.freeMb));
    out.push('}');
    out.push_str(",\"gpu\":{\"present\":");
    out.push_str(if hc.gpu.present { "true" } else { "false" });
    out.push_str(",\"name\":");
    match &hc.gpu.name {
        Some(s) => out.push_str(&serde_json::to_string(s).unwrap()),
        None => out.push_str("null"),
    }
    out.push_str(",\"freeMb\":");
    match hc.gpu.freeMb {
        Some(v) => out.push_str(&format_number(v)),
        None => out.push_str("null"),
    }
    out.push('}');
    out.push_str(",\"localModels\":{\"reachable\":");
    out.push_str(if hc.localModels.reachable {
        "true"
    } else {
        "false"
    });
    out.push_str(",\"models\":[");
    for (i, m) in hc.localModels.models.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&serde_json::to_string(m).unwrap());
    }
    out.push_str("]}");
    out.push_str(",\"policy\":{\"allowedWindow\":{\"start\":");
    out.push_str(&serde_json::to_string(&hc.policy.allowedWindow.start).unwrap());
    out.push_str(",\"end\":");
    out.push_str(&serde_json::to_string(&hc.policy.allowedWindow.end).unwrap());
    out.push_str("},\"insideWindow\":");
    out.push_str(if hc.policy.insideWindow {
        "true"
    } else {
        "false"
    });
    out.push_str(",\"maxConcurrentAgents\":");
    out.push_str(&format_number(hc.policy.maxConcurrentAgents));
    out.push_str("}}");
    out.push('\n');
    out
}

fn is_integer(n: f64) -> bool {
    n.is_finite() && n.fract() == 0.0
}

pub fn contract_violations(hc: &HostCapacity) -> Vec<String> {
    let mut v = Vec::new();
    if hc.schemaVersion != "v1" {
        v.push("schemaVersion: must be \"v1\"".to_string());
    }
    let alias_re = host_alias_pattern();
    if !alias_re.is_match(&hc.hostAlias) {
        v.push("hostAlias: must match pattern \"^[a-z][a-z0-9-]{0,31}$\"".to_string());
    }
    if parse_timestamp(&hc.timestamp).is_none() {
        v.push("timestamp: must match pattern and be a real calendar date".to_string());
    }
    if hc.idleReason.is_empty() {
        v.push("idleReason: must NOT have fewer than 1 characters".to_string());
    }
    if !is_integer(hc.secondsSinceInput) || hc.secondsSinceInput < 0.0 {
        v.push("secondsSinceInput: must be integer >= 0".to_string());
    }
    if let Some(bp) = hc.batteryPercent {
        if !is_integer(bp) || bp < 0.0 || bp > 100.0 {
            v.push("batteryPercent: must be integer 0..100 or null".to_string());
        }
    }
    if !is_integer(hc.cpu.cores) || hc.cpu.cores < 1.0 {
        v.push("cpu.cores: must be integer >= 1".to_string());
    }
    if !hc.cpu.load1m.is_finite() || hc.cpu.load1m < 0.0 {
        v.push("cpu.load1m: must be number >= 0".to_string());
    }
    if !is_integer(hc.memory.totalMb) || hc.memory.totalMb < 1.0 {
        v.push("memory.totalMb: must be integer >= 1".to_string());
    }
    if !is_integer(hc.memory.freeMb) || hc.memory.freeMb < 0.0 {
        v.push("memory.freeMb: must be integer >= 0".to_string());
    }
    if let Some(name) = &hc.gpu.name {
        if name.is_empty() {
            v.push("gpu.name: must NOT have fewer than 1 characters".to_string());
        }
    }
    if let Some(free) = hc.gpu.freeMb {
        if !is_integer(free) || free < 0.0 {
            v.push("gpu.freeMb: must be integer >= 0 or null".to_string());
        }
    }
    // localModels
    for (idx, m) in hc.localModels.models.iter().enumerate() {
        if m.is_empty() {
            v.push(format!(
                "localModels.models/{}: must NOT have fewer than 1 characters",
                idx
            ));
        }
    }
    if hc.localModels.models.len()
        != hc
            .localModels
            .models
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
    {
        v.push("localModels.models: must NOT have duplicate items".to_string());
    }
    let time_re = time_pattern();
    if !time_re.is_match(&hc.policy.allowedWindow.start) {
        v.push(
            "policy.allowedWindow.start: must match pattern \"^([01][0-9]|2[0-3]):[0-5][0-9]$\""
                .to_string(),
        );
    }
    if !time_re.is_match(&hc.policy.allowedWindow.end) {
        v.push(
            "policy.allowedWindow.end: must match pattern \"^([01][0-9]|2[0-3]):[0-5][0-9]$\""
                .to_string(),
        );
    }
    if !is_integer(hc.policy.maxConcurrentAgents) || hc.policy.maxConcurrentAgents < 1.0 {
        v.push("policy.maxConcurrentAgents: must be integer >= 1".to_string());
    }
    v
}

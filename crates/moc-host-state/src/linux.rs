use crate::js::{JS_WS_CLASS, errno_name, js_number, js_round, js_trim};
use crate::proc::{StderrMode, run};
use regex::Regex;
use std::collections::HashMap;

/// GPU status as returned by the DRM and nvidia probes.
#[allow(non_snake_case)]
#[derive(Debug, Clone, PartialEq)]
pub struct Gpu {
    pub present: bool,
    pub name: Option<String>,
    pub freeMb: Option<f64>,
}

/// Errors that can be surfaced as `userActivityError` or `noLocalUserSession`.
#[derive(Debug, Clone, PartialEq)]
pub enum ProbeError {
    Message(String),
    NoGraphicalSession(Vec<String>),
}

impl std::fmt::Display for ProbeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProbeError::Message(m) => write!(f, "{m}"),
            ProbeError::NoGraphicalSession(_) => {
                write!(f, "logged in without an active graphical session")
            }
        }
    }
}

impl std::error::Error for ProbeError {}

pub fn read_file_if_exists(path: &str) -> Result<Option<String>, String> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => {}
        Err(e) => {
            if e.kind() == std::io::ErrorKind::NotFound {
                return Ok(None);
            }
            return Err(format!("{}: {}", path, errno_name(&e)));
        }
    }
    match std::fs::read(path) {
        Ok(bytes) => {
            let text = String::from_utf8_lossy(&bytes).into_owned();
            let trimmed = js_trim(&text).to_string();
            Ok(Some(trimmed))
        }
        Err(e) => Err(format!("{}: {}", path, errno_name(&e))),
    }
}

pub fn read_required(path: &str, what: &str) -> Result<String, String> {
    let value = read_file_if_exists(path)?;
    match value {
        Some(s) if !s.is_empty() => Ok(s),
        _ => Err(format!("cannot read {what}")),
    }
}

pub fn linux_power(sysfs_root: &str) -> Result<(bool, Option<f64>), String> {
    let base = format!("{sysfs_root}/class/power_supply");
    let entries: Vec<String> = match std::fs::read_dir(&base) {
        Ok(rd) => {
            let mut v = Vec::new();
            for ent in rd {
                let ent = ent.map_err(|e| format!("{}: {}", base, errno_name(&e)))?;
                let name = ent.file_name().to_string_lossy().into_owned();
                v.push(name);
            }
            v
        }
        Err(e) => {
            if e.kind() == std::io::ErrorKind::NotFound {
                return Ok((true, None));
            }
            return Err(format!("{}: {}", base, errno_name(&e)));
        }
    };

    let mut ac_power = false;
    let mut battery_percent: Option<f64> = None;
    let mut has_mains = false;
    let mut has_battery = false;

    for entry in &entries {
        let type_path = format!("{base}/{entry}/type");
        let type_val = read_required(&type_path, &format!("type of {entry}"))?;
        if type_val == "Mains" {
            let scope_path = format!("{base}/{entry}/scope");
            let scope = match read_file_if_exists(&scope_path)? {
                Some(s) => s,
                None => "System".to_string(),
            };
            if scope == "Device" {
                continue;
            }
            has_mains = true;
            let online_path = format!("{base}/{entry}/online");
            let online = read_required(&online_path, &format!("online of {entry}"))?;
            if online == "1" {
                ac_power = true;
            }
        }
        if type_val == "Battery" {
            let scope_path = format!("{base}/{entry}/scope");
            let scope = match read_file_if_exists(&scope_path)? {
                Some(s) => s,
                None => "System".to_string(),
            };
            if scope == "Device" {
                continue;
            }
            has_battery = true;
            let cap_path = format!("{base}/{entry}/capacity");
            let cap = read_required(&cap_path, &format!("capacity of {entry}"))?;
            let n = js_number(&cap);
            if !n.is_finite() {
                return Err(format!("cannot read capacity of {entry}: not a number"));
            }
            battery_percent = Some(match battery_percent {
                None => n,
                Some(prev) => prev.min(n),
            });
        }
    }

    if !has_mains && !has_battery {
        return Ok((true, None));
    }
    if has_battery && !has_mains {
        return Err("battery present without mains".to_string());
    }
    Ok((ac_power, battery_percent))
}

fn card_regex() -> Regex {
    Regex::new(r"^card[0-9]+$").unwrap()
}

pub fn linux_gpu(sysfs_root: &str, nvidia_smi: &str) -> Result<Gpu, String> {
    let base = format!("{sysfs_root}/class/drm");
    inner_linux_gpu(&base, nvidia_smi).map_err(|e| format!("gpu unknown: {e}"))
}

fn inner_linux_gpu(base: &str, nvidia_smi: &str) -> Result<Gpu, String> {
    let entries: Vec<String> = match std::fs::read_dir(base) {
        Ok(rd) => {
            let re = card_regex();
            let mut v = Vec::new();
            for ent in rd {
                let ent = ent.map_err(|e| format!("{}: {}", base, errno_name(&e)))?;
                let name = ent.file_name().to_string_lossy().into_owned();
                if re.is_match(&name) {
                    v.push(name);
                }
            }
            v
        }
        Err(e) => {
            if e.kind() == std::io::ErrorKind::NotFound {
                if let Some(gpu) = nvidia_gpu(nvidia_smi) {
                    return Ok(gpu);
                }
                return Ok(Gpu {
                    present: false,
                    name: None,
                    freeMb: None,
                });
            }
            return Err(format!("{}: {}", base, errno_name(&e)));
        }
    };

    let mut best: Option<Gpu> = None;
    for card in &entries {
        let device_dir = format!("{base}/{card}/device");
        let vendor_path = format!("{device_dir}/vendor");
        let vendor = read_file_if_exists(&vendor_path)?;
        let vendor_str = vendor.as_deref().unwrap_or("");
        if vendor_str.is_empty() {
            continue;
        }
        let uevent_path = format!("{device_dir}/uevent");
        let uevent = read_file_if_exists(&uevent_path)?;
        let name = uevent
            .as_deref()
            .and_then(|txt| {
                for line in txt.split('\n') {
                    if let Some(rest) = line.strip_prefix("DRIVER=") {
                        return Some(rest.to_string());
                    }
                }
                None
            })
            .filter(|s| !s.is_empty());

        let total_path = format!("{device_dir}/mem_info_vram_total");
        let used_path = format!("{device_dir}/mem_info_vram_used");
        let total_raw = read_file_if_exists(&total_path)?;
        let used_raw = read_file_if_exists(&used_path)?;

        let mut free_mb: Option<f64> = None;
        if let (Some(total_s), Some(used_s)) = (total_raw, used_raw) {
            let total = js_number(&total_s);
            let used = js_number(&used_s);
            if total.is_finite() && used.is_finite() {
                let free = js_round((total - used) / 1024.0 / 1024.0);
                let free = if free < 0.0 { 0.0 } else { free };
                free_mb = Some(free);
            }
        }

        best = Some(Gpu {
            present: true,
            name,
            freeMb: free_mb,
        });
    }

    if let Some(gpu) = nvidia_gpu(nvidia_smi) {
        return Ok(gpu);
    }
    if let Some(b) = best {
        return Ok(b);
    }
    Ok(Gpu {
        present: false,
        name: None,
        freeMb: None,
    })
}

pub fn nvidia_gpu(program: &str) -> Option<Gpu> {
    let args = vec![
        "--query-gpu=name,memory.free".to_string(),
        "--format=csv,noheader,nounits".to_string(),
    ];
    let (code, out) = match run(program, &args, StderrMode::Null) {
        Ok(v) => v,
        Err(_) => return None,
    };
    if code != Some(0) {
        return None;
    }
    let trimmed = js_trim(&out);
    if trimmed.is_empty() {
        return None;
    }
    let first_line = trimmed.split('\n').next().unwrap_or("");
    let parts: Vec<String> = first_line
        .split(',')
        .map(|s| js_trim(s).to_string())
        .collect();
    let name_raw = parts.first().map(|s| s.as_str()).unwrap_or("");
    if name_raw.is_empty() {
        return None;
    }
    let free_raw = parts.get(1).map(|s| s.as_str()).unwrap_or("");
    let free = if free_raw.is_empty() {
        f64::NAN
    } else {
        js_number(free_raw)
    };
    let free_mb = if free.is_finite() { Some(free) } else { None };
    Some(Gpu {
        present: true,
        name: Some(name_raw.to_string()),
        freeMb: free_mb,
    })
}

pub fn linux_memory() -> Result<(f64, f64), String> {
    let txt = match read_file_if_exists("/proc/meminfo")? {
        Some(s) => s,
        None => return Err("meminfo missing".to_string()),
    };
    // Regexes use JS_WS
    let total_re = Regex::new(&format!(r"MemTotal:[{}]+([0-9]+)", JS_WS_CLASS)).unwrap();
    let avail_re = Regex::new(&format!(r"MemAvailable:[{}]+([0-9]+)", JS_WS_CLASS)).unwrap();
    let free_re = Regex::new(&format!(r"MemFree:[{}]+([0-9]+)", JS_WS_CLASS)).unwrap();

    let total_cap = total_re
        .captures(&txt)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str());
    let avail_cap = avail_re
        .captures(&txt)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str())
        .or_else(|| {
            free_re
                .captures(&txt)
                .and_then(|c| c.get(1))
                .map(|m| m.as_str())
        });

    let (Some(total_s), Some(avail_s)) = (total_cap, avail_cap) else {
        return Err("meminfo parse".to_string());
    };
    let total_kb = js_number(total_s);
    let avail_kb = js_number(avail_s);
    let total_mb = js_round(total_kb / 1024.0);
    let avail_mb = js_round(avail_kb / 1024.0);
    Ok((total_mb, avail_mb))
}

pub fn linux_cpu() -> Result<(f64, f64), String> {
    // cores = number of lines of /proc/stat matching ^cpu[0-9]+
    let cores = match read_file_if_exists("/proc/stat")? {
        Some(txt) => {
            let re = Regex::new(r"^cpu[0-9]+").unwrap();
            txt.lines().filter(|line| re.is_match(line)).count() as f64
        }
        None => 0.0,
    };

    let txt = match read_file_if_exists("/proc/loadavg")? {
        Some(s) => s,
        None => return Err("loadavg missing".to_string()),
    };
    let re = Regex::new(&format!(r"([0-9.]+)[{}]", JS_WS_CLASS)).unwrap();
    let m = re.captures(&txt).and_then(|c| c.get(1)).map(|m| m.as_str());
    let Some(load_s) = m else {
        return Err("loadavg parse".to_string());
    };
    let load = js_number(load_s);
    if !load.is_finite() {
        return Err("loadavg parse".to_string());
    }
    Ok((cores, load))
}

fn split_js_ws_trimmed(s: &str) -> Vec<String> {
    let trimmed = js_trim(s);
    if trimmed.is_empty() {
        return vec!["".to_string()];
    }
    let re = Regex::new(&format!("[{}]+", JS_WS_CLASS)).unwrap();
    re.split(trimmed).map(|p| p.to_string()).collect()
}

fn js_ws_split(s: &str) -> Vec<String> {
    // For show_session props etc we need JS_WS handling; but for list parsing we use split_js_ws_trimmed.
    split_js_ws_trimmed(s)
}

pub fn show_session_props(
    loginctl: &str,
    id: &str,
    names: &[String],
) -> Result<HashMap<String, String>, String> {
    let mut args = vec!["show-session".to_string(), id.to_string()];
    for name in names {
        args.push("-p".to_string());
        args.push(name.clone());
    }
    let (code, out) = run(loginctl, &args, StderrMode::Inherit)?;
    if code != Some(0) {
        return Err(format!("loginctl show-session {id} failed"));
    }
    let mut props = HashMap::new();
    for line in out.split('\n') {
        if let Some(eq) = line.find('=') {
            if eq > 0 {
                let key = line[..eq].to_string();
                let val = line[eq + 1..].to_string();
                props.insert(key, val);
            }
        }
    }
    Ok(props)
}

pub fn sessions_idle_secs(loginctl: &str, ids: &[String], now_ms: f64) -> Result<f64, String> {
    let mut min_secs: Option<f64> = None;
    for id in ids {
        let props = show_session_props(
            loginctl,
            id,
            &["IdleHint".to_string(), "IdleSinceHint".to_string()],
        )?;
        let hint = props.get("IdleHint").map(|s| s.as_str());
        if hint == Some("no") {
            return Ok(0.0);
        }
        if hint != Some("yes") {
            return Err(format!("loginctl session {id} has no IdleHint"));
        }
        let since_raw = props.get("IdleSinceHint").map(|s| s.as_str());
        let idle_since_us = match since_raw {
            Some(s) if !s.is_empty() => js_number(s),
            _ => f64::NAN,
        };
        if !idle_since_us.is_finite() || idle_since_us <= 0.0 {
            return Err(format!(
                "loginctl session {id} has no numeric IdleSinceHint"
            ));
        }
        let secs = (now_ms - idle_since_us / 1000.0) / 1000.0;
        let secs = secs.floor();
        let secs = if secs < 0.0 { 0.0 } else { secs };
        min_secs = Some(match min_secs {
            None => secs,
            Some(prev) => prev.min(secs),
        });
    }
    match min_secs {
        Some(v) => Ok(v),
        None => Err("IdleSinceHint missing".to_string()),
    }
}

pub fn linux_seconds_since_input(loginctl: &str, now_ms: f64) -> Result<Option<f64>, ProbeError> {
    let (code, out) = run(
        loginctl,
        &["list-sessions".to_string(), "--no-legend".to_string()],
        StderrMode::Inherit,
    )
    .map_err(ProbeError::Message)?;

    if code != Some(0) {
        return Err(ProbeError::Message(
            "loginctl list-sessions failed".to_string(),
        ));
    }

    let mut session_ids: Vec<String> = Vec::new();
    for line in out.split('\n') {
        let parts = js_ws_split(line);
        // parts from split_js_ws_trimmed: check length >=2 and id non-empty
        let id = parts.first().cloned().unwrap_or_default();
        if parts.len() >= 2 && !id.is_empty() {
            session_ids.push(id);
        }
    }

    if session_ids.is_empty() {
        return Ok(None);
    }

    let user_re = Regex::new(r"^user(-|$)").unwrap();
    let mut logged_in_ids: Vec<String> = Vec::new();
    for id in &session_ids {
        let props = show_session_props(loginctl, id, &["Class".to_string(), "Remote".to_string()])
            .map_err(ProbeError::Message)?;
        let cls = props.get("Class").map(|s| s.as_str());
        let remote = props.get("Remote").map(|s| s.as_str());
        if cls.is_none() || cls == Some("") || remote.is_none() || remote == Some("") {
            return Err(ProbeError::Message(format!(
                "loginctl session {id} has no Class or Remote"
            )));
        }
        let cls_str = cls.unwrap();
        let remote_str = remote.unwrap();
        if user_re.is_match(cls_str) && remote_str != "yes" {
            logged_in_ids.push(id.clone());
        }
    }

    if logged_in_ids.is_empty() {
        return Ok(None);
    }

    let mut graphical_ids: Vec<String> = Vec::new();
    for id in &logged_in_ids {
        let props = show_session_props(
            loginctl,
            id,
            &["Active".to_string(), "Type".to_string(), "Seat".to_string()],
        )
        .map_err(ProbeError::Message)?;
        let active = props.get("Active").map(|s| s.as_str()).unwrap_or("");
        let seat = props.get("Seat").map(|s| s.as_str()).unwrap_or("");
        let ty = props.get("Type").map(|s| s.as_str()).unwrap_or("");
        if active == "yes" && !seat.is_empty() && (ty == "x11" || ty == "wayland") {
            graphical_ids.push(id.clone());
        }
    }

    if graphical_ids.is_empty() {
        return Err(ProbeError::NoGraphicalSession(logged_in_ids));
    }

    match sessions_idle_secs(loginctl, &graphical_ids, now_ms) {
        Ok(v) => Ok(Some(v)),
        Err(e) => Err(ProbeError::Message(e)),
    }
}

pub fn linux_manager_idle_secs(loginctl: &str, now_ms: f64) -> Result<f64, String> {
    let args = vec![
        "show-session".to_string(),
        "-p".to_string(),
        "IdleHint".to_string(),
        "-p".to_string(),
        "IdleSinceHint".to_string(),
    ];
    let (code, out) = run(loginctl, &args, StderrMode::Inherit)?;
    if code != Some(0) {
        return Err("loginctl show-session manager failed".to_string());
    }
    let mut props = HashMap::new();
    for line in out.split('\n') {
        if let Some(eq) = line.find('=') {
            if eq > 0 {
                props.insert(line[..eq].to_string(), line[eq + 1..].to_string());
            }
        }
    }
    let since_raw = props.get("IdleSinceHint").map(|s| s.as_str());
    let since_us = match since_raw {
        Some(s) if !s.is_empty() => js_number(s),
        _ => f64::NAN,
    };
    if !since_us.is_finite() || since_us <= 0.0 {
        let raw = since_raw.unwrap_or("missing");
        // When key missing, TS reports "missing"; when present but empty, it would be "" then Number("") =>0 => fails and reports raw which is "" (empty string). We replicate: if prop missing => "missing", else raw value.
        // The TS code: sinceRaw ?? "missing" where sinceRaw may be undefined or "". If undefined, "missing", else sinceRaw (which could be ""), so empty reports "".
        // Our since_raw is Option<&str>; if None => "missing", else the string (even empty).
        let display = match props.get("IdleSinceHint") {
            Some(v) => v.as_str(),
            None => "missing",
        };
        // Special case: if prop exists but empty string, display is "" - we already have that.
        // Need to handle case where prop exists as "" => display "" not "missing"
        let _ = raw; // keep for clarity
        return Err(format!("manager IdleSinceHint not above zero: {display}"));
    }
    let secs = (now_ms - since_us / 1000.0) / 1000.0;
    let secs = secs.floor();
    let secs = if secs < 0.0 { 0.0 } else { secs };
    Ok(secs)
}

pub fn linux_uptime_secs() -> Result<f64, String> {
    let txt = match read_file_if_exists("/proc/uptime")? {
        Some(s) => s,
        None => return Err("/proc/uptime unreadable".to_string()),
    };
    if txt.is_empty() {
        return Err("/proc/uptime unreadable".to_string());
    }
    let re = Regex::new(&format!("[{}]+", JS_WS_CLASS)).unwrap();
    let first = re.split(txt.as_str()).next().unwrap_or("");
    if first.is_empty() {
        return Err("/proc/uptime unreadable".to_string());
    }
    let n = js_number(first);
    let up_secs = n.floor();
    if !up_secs.is_finite() {
        return Err("/proc/uptime unreadable".to_string());
    }
    Ok(up_secs)
}

use crate::js::{JS_WS_CLASS, js_number, js_trim};
use crate::proc::{StderrMode, run};
use regex::Regex;
use serde_json::Value;

#[allow(non_snake_case)]
#[derive(Debug, Clone, PartialEq)]
pub struct Gpu {
    pub present: bool,
    pub name: Option<String>,
    pub freeMb: Option<f64>,
}

/// Mirror macOS GPU reader: system_profiler SPDisplaysDataType -json, stderr null.
pub fn macos_gpu(system_profiler: &str) -> Result<Gpu, String> {
    let inner = (|| -> Result<Gpu, String> {
        let args = vec!["SPDisplaysDataType".to_string(), "-json".to_string()];
        let (code, out) = run(system_profiler, &args, StderrMode::Null)?;
        if code != Some(0) || out.is_empty() {
            return Err("system_profiler failed".to_string());
        }
        let data: Value = serde_json::from_str(&out).map_err(|e| e.to_string())?;
        let obj = match data {
            Value::Object(m) => m,
            _ => {
                // Data must be an object; otherwise the SPDisplaysDataType access would be
                // undefined. Treat as not present if we cannot locate the array.
                return Ok(Gpu {
                    present: false,
                    name: None,
                    freeMb: None,
                });
            }
        };
        let cards_value = match obj.get("SPDisplaysDataType") {
            None => {
                return Ok(Gpu {
                    present: false,
                    name: None,
                    freeMb: None,
                });
            }
            Some(v) => v,
        };
        // Missing array is not present; non-array is an error (allowed divergence exit 1).
        if cards_value.is_null() {
            return Ok(Gpu {
                present: false,
                name: None,
                freeMb: None,
            });
        }
        let cards = match cards_value {
            Value::Array(arr) => arr,
            _ => return Err(format!("{} is not an array", "SPDisplaysDataType")),
        };
        if cards.is_empty() {
            return Ok(Gpu {
                present: false,
                name: None,
                freeMb: None,
            });
        }
        let first = &cards[0];
        let first_obj = match first {
            Value::Object(m) => m,
            _ => {
                // First card not an object: treat as present with no name? But to stay strict
                // with spec, a non-object card would have no sppci_model string.
                return Ok(Gpu {
                    present: true,
                    name: None,
                    freeMb: None,
                });
            }
        };
        let name = match first_obj.get("sppci_model") {
            None => None,
            Some(Value::Null) => None,
            Some(Value::String(s)) => Some(s.clone()),
            Some(other) => {
                // Non-string sppci_model is an error (allowed divergence exit 1).
                return Err(format!("sppci_model is not a string: {}", other));
            }
        };
        Ok(Gpu {
            present: true,
            name,
            freeMb: None,
        })
    })();
    match inner {
        Ok(v) => Ok(v),
        Err(msg) => Err(format!("gpu unknown: {msg}")),
    }
}

/// Mirror macOS power reader: pmset -g batt, stderr inherited.
pub fn macos_power(pmset: &str) -> Result<(bool, Option<f64>), String> {
    let args = vec!["-g".to_string(), "batt".to_string()];
    let (code, out) = run(pmset, &args, StderrMode::Inherit)?;
    if code != Some(0) {
        let code_str = match code {
            Some(c) => c.to_string(),
            None => "null".to_string(),
        };
        return Err(format!("pmset failed: exit {code_str}"));
    }
    if !out.contains("drawing from") {
        return Err("pmset failed: no drawing from line".to_string());
    }
    let ac = out.contains("AC Power");
    // First line containing InternalBattery.
    let battery_line = out
        .split('\n')
        .find(|line| line.contains("InternalBattery"));
    let mut battery_percent: Option<f64> = None;
    if let Some(line) = battery_line {
        let re = Regex::new(r"([0-9]{1,3})%").unwrap();
        let m = re.captures(line);
        match m {
            Some(cap) => {
                let digits = cap.get(1).unwrap().as_str();
                let n = js_number(digits);
                battery_percent = Some(n);
            }
            None => {
                return Err(format!("pmset battery unparsable: {line}"));
            }
        }
    }
    Ok((ac, battery_percent))
}

/// Mirror macOS console owner reader: stat -f %Su /dev/console, stderr null.
pub fn macos_console_owner(stat: &str) -> Result<String, String> {
    let args = vec![
        "-f".to_string(),
        "%Su".to_string(),
        "/dev/console".to_string(),
    ];
    let (code, out) = run(stat, &args, StderrMode::Null)?;
    let trimmed = js_trim(&out).to_string();
    if code != Some(0) || trimmed.is_empty() {
        return Err("console owner query failed".to_string());
    }
    Ok(trimmed)
}

/// Mirror macOS secondsSinceInput reader: ioreg -c IOHIDSystem, stderr inherited.
pub fn macos_seconds_since_input(ioreg: &str) -> Result<f64, String> {
    let args = vec!["-c".to_string(), "IOHIDSystem".to_string()];
    let (code, out) = run(ioreg, &args, StderrMode::Inherit)?;
    if code != Some(0) {
        return Err("ioreg HIDIdleTime failed".to_string());
    }
    // "\"HIDIdleTime\"[JS_WS]+=[JS_WS]+([0-9]+)"
    let pattern = format!(
        r#""HIDIdleTime"[{cls}]+=[{cls}]+([0-9]+)"#,
        cls = JS_WS_CLASS
    );
    let re = Regex::new(&pattern).unwrap();
    let caps = re.captures(&out);
    let Some(cap) = caps else {
        return Err("HIDIdleTime missing".to_string());
    };
    let digits = cap.get(1).unwrap().as_str();
    let secs_str = if digits.len() <= 9 {
        "0"
    } else {
        &digits[..digits.len() - 9]
    };
    let secs = js_number(secs_str);
    Ok(secs)
}

/// Wraps macos_seconds_since_input errors as activity unknown after logout.
pub fn macos_hid_idle(ioreg: &str) -> Result<f64, String> {
    match macos_seconds_since_input(ioreg) {
        Ok(v) => Ok(v),
        Err(msg) => Err(format!("activity unknown after logout: {msg}")),
    }
}

#[allow(non_snake_case)]
#[derive(Debug, Clone, PartialEq)]
pub struct Cpu {
    pub cores: f64,
    pub load1m: f64,
}

/// Mirror macOS CPU reader: sysctl -n vm.loadavg, stderr inherited.
pub fn macos_cpu(sysctl: &str) -> Result<Cpu, String> {
    let cores = macos_core_count()?;
    let args = vec!["-n".to_string(), "vm.loadavg".to_string()];
    let (code, out) = run(sysctl, &args, StderrMode::Inherit)?;
    if code != Some(0) {
        return Err("sysctl vm.loadavg failed".to_string());
    }
    // Regex \{([^\n\r\x{2028}\x{2029}]+?)\}
    let re = Regex::new(r"\{([^\n\r\u{2028}\u{2029}]+?)\}").unwrap();
    let caps = re.captures(&out);
    let Some(cap) = caps else {
        return Err("loadavg parse".to_string());
    };
    let inner = cap.get(1).unwrap().as_str();
    let trimmed = js_trim(inner);
    let split_re = Regex::new(&format!("[{}]+", JS_WS_CLASS)).unwrap();
    let parts: Vec<&str> = if trimmed.is_empty() {
        vec![""]
    } else {
        split_re.split(trimmed).collect()
    };
    let first = parts.first().copied().unwrap_or("");
    let load = js_number(first);
    if !load.is_finite() {
        return Err("loadavg parse".to_string());
    }
    Ok(Cpu {
        cores,
        load1m: load,
    })
}

#[cfg(target_os = "macos")]
pub fn macos_core_count() -> Result<f64, String> {
    use std::ffi::CString;
    let name = CString::new("hw.ncpu").unwrap();
    let mut ncpu: u32 = 0;
    let mut len = std::mem::size_of::<u32>() as libc::size_t;
    let ret = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            &mut ncpu as *mut _ as *mut libc::c_void,
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    if ret != 0 {
        return Err("unsupported platform".to_string());
    }
    Ok(ncpu as f64)
}

#[cfg(not(target_os = "macos"))]
pub fn macos_core_count() -> Result<f64, String> {
    Err("unsupported platform".to_string())
}

#[cfg(target_os = "macos")]
pub fn macos_memory() -> Result<(f64, f64), String> {
    use std::ffi::CString;
    let name = CString::new("hw.memsize").unwrap();
    let mut memsize: u64 = 0;
    let mut len = std::mem::size_of::<u64>() as libc::size_t;
    let ret = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            &mut memsize as *mut _ as *mut libc::c_void,
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    if ret != 0 {
        return Err("unsupported platform".to_string());
    }
    let total_mb = crate::js::js_round(memsize as f64 / 1024.0 / 1024.0);
    // free via host_statistics64
    let mut count = libc::HOST_VM_INFO64_COUNT as libc::mach_msg_type_number_t;
    let mut stats: libc::vm_statistics64 = unsafe { std::mem::zeroed() };
    // Single allow with one-line reason comment
    #[allow(deprecated)] // mach_host_self is deprecated in newer SDKs
    let host = unsafe { libc::mach_host_self() };
    let ret2 = unsafe {
        libc::host_statistics64(
            host,
            libc::HOST_VM_INFO64,
            &mut stats as *mut _ as *mut libc::host_info_t,
            &mut count,
        )
    };
    if ret2 != 0 {
        return Err("unsupported platform".to_string());
    }
    let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) } as u64;
    let free_bytes = stats.free_count as u64 * page_size;
    let free_mb = crate::js::js_round(free_bytes as f64 / 1024.0 / 1024.0);
    Ok((total_mb, free_mb))
}

#[cfg(not(target_os = "macos"))]
pub fn macos_memory() -> Result<(f64, f64), String> {
    Err("unsupported platform".to_string())
}

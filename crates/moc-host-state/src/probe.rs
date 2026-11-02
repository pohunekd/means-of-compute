use crate::config::HostFile;
use crate::idle_rule::{IdleInputs, derive_idle, inside_window};
use crate::output::{
    AllowedWindow, Cpu, Gpu, HostCapacity, LocalModels, Memory, Policy, contract_violations,
};
use crate::platform::Platform;
use crate::time::{format_timestamp, parse_timestamp};
use std::path::PathBuf;

pub struct ProbeEnv {
    pub platform: Platform,
    pub loginctl: String,
    pub nvidia_smi: String,
    pub local_minutes: fn(i64) -> u32,
    pub now_ms: fn() -> i64,
}

pub struct ProbeOptions {
    pub config_dir: PathBuf,
    pub facts_path: Option<PathBuf>,
    pub scenario: Option<String>,
}

enum UserActivityError {
    Message(String),
    NoSession(Vec<String>),
}

pub fn run_probe(
    opts: &ProbeOptions,
    env: &ProbeEnv,
    resolve_host: &dyn Fn() -> Result<HostFile, String>,
) -> Result<HostCapacity, String> {
    // Load facts
    let facts = if let Some(p) = opts
        .facts_path
        .as_ref()
        .filter(|p| !p.as_os_str().is_empty())
    {
        let ps = p.to_string_lossy().to_string();
        crate::facts::load_facts(&ps, env.platform)?
    } else if let Some(scn) = opts.scenario.as_deref().filter(|s| !s.is_empty()) {
        let scn_path = opts
            .config_dir
            .join("scenarios")
            .join(format!("{}.json", scn))
            .to_string_lossy()
            .to_string();
        crate::facts::load_facts(&scn_path, env.platform)?
    } else {
        crate::facts::Facts {
            secondsSinceInput: None,
            userActivityError: None,
            noLocalUserSession: None,
            sysfsRoot: None,
            acPower: None,
            batteryPercent: None,
            cpuCores: None,
            cpuLoad1m: None,
            memoryTotalMb: None,
            memoryFreeMb: None,
            gpuPresent: None,
            gpuName: None,
            gpuFreeMb: None,
            localModelsReachable: None,
            localModels: None,
            hostAlias: None,
            timestamp: None,
            policyAllowedWindowStart: None,
            policyAllowedWindowEnd: None,
        }
    };

    let probe_path = opts
        .config_dir
        .join("probe.json")
        .to_string_lossy()
        .to_string();
    let cfg = crate::config::load_config(&probe_path, env.platform)?;

    let sysfs_root = facts
        .sysfsRoot
        .clone()
        .unwrap_or_else(|| cfg.sysfsRoot.clone());

    let host = if let Some(alias) = facts.hostAlias.clone() {
        HostFile {
            hostAlias: alias,
            unattended: None,
        }
    } else {
        resolve_host()?
    };

    let timestamp = facts
        .timestamp
        .clone()
        .unwrap_or_else(|| format_timestamp((env.now_ms)()));
    let eval_ms = parse_timestamp(&timestamp)
        .ok_or_else(|| format!("timestamp parse error: {}", timestamp))?;

    let window_start = facts
        .policyAllowedWindowStart
        .clone()
        .unwrap_or_else(|| cfg.policy.allowedWindowStart.clone());
    let window_end = facts
        .policyAllowedWindowEnd
        .clone()
        .unwrap_or_else(|| cfg.policy.allowedWindowEnd.clone());
    let inside_window_bool =
        inside_window((env.local_minutes)(eval_ms), &window_start, &window_end);

    // Defaults from facts or TS defaults
    let mut seconds_since_input = facts.secondsSinceInput.unwrap_or(0.0);
    let mut ac_power = facts.acPower.unwrap_or(true);
    let mut battery_percent: Option<f64> = facts.batteryPercent.unwrap_or(None);
    // default 0.0 is always replaced by the live CPU reader when the fact is absent
    let mut cpu_cores = facts.cpuCores.unwrap_or(0.0);
    let mut cpu_load1m = facts.cpuLoad1m.unwrap_or(0.0);
    let mut memory_total_mb = facts.memoryTotalMb.unwrap_or(0.0);
    let mut memory_free_mb = facts.memoryFreeMb.unwrap_or(0.0);
    let mut gpu_present = facts.gpuPresent.unwrap_or(false);
    let mut gpu_name: Option<String> = facts.gpuName.clone().unwrap_or(None);
    let mut gpu_free_mb: Option<f64> = facts.gpuFreeMb.unwrap_or(None);
    let mut local_models_reachable = facts.localModelsReachable.unwrap_or(false);
    let mut local_models = facts.localModels.clone().unwrap_or_default();

    let mut user_activity_unknown = facts.userActivityError.is_some();
    let mut user_activity_cause = facts.userActivityError.clone().unwrap_or_default();
    let mut logged_out = facts.noLocalUserSession == Some(true);
    let mut logged_out_secs: Option<f64> = None;
    let mut unattended_window: Option<String> = None;
    let mut power_unknown = false;
    let mut power_cause = String::new();

    if user_activity_unknown {
        seconds_since_input = 0.0;
    } else if facts.secondsSinceInput.is_none() {
        let attempt: Result<(), UserActivityError> = (|| {
            if env.platform == Platform::Linux {
                match crate::linux::linux_seconds_since_input(&env.loginctl, eval_ms as f64) {
                    Ok(Some(secs)) => {
                        seconds_since_input = secs;
                    }
                    Ok(None) => {
                        logged_out = true;
                        match crate::linux::linux_manager_idle_secs(&env.loginctl, eval_ms as f64) {
                            Ok(v) => logged_out_secs = Some(v),
                            Err(manager_err) => match crate::linux::linux_uptime_secs() {
                                Ok(v) => logged_out_secs = Some(v),
                                Err(uptime_err) => {
                                    return Err(UserActivityError::Message(format!(
                                        "logged out but input time unreadable: {}; {}",
                                        manager_err, uptime_err
                                    )));
                                }
                            },
                        }
                    }
                    Err(crate::linux::ProbeError::Message(m)) => {
                        return Err(UserActivityError::Message(m));
                    }
                    Err(crate::linux::ProbeError::NoGraphicalSession(ids)) => {
                        return Err(UserActivityError::NoSession(ids));
                    }
                }
                if logged_out {
                    match logged_out_secs {
                        Some(v) => seconds_since_input = v,
                        None => {
                            return Err(UserActivityError::Message(
                                "logged out but input time unreadable".to_string(),
                            ));
                        }
                    }
                }
            } else if env.platform == Platform::Darwin {
                match crate::macos::macos_console_owner(&cfg.macosTools.stat) {
                    Ok(owner) => {
                        if owner == "root" {
                            logged_out = true;
                        } else {
                            let secs =
                                crate::macos::macos_seconds_since_input(&cfg.macosTools.ioreg)
                                    .map_err(UserActivityError::Message)?;
                            seconds_since_input = secs;
                        }
                    }
                    Err(e) => return Err(UserActivityError::Message(e)),
                }
                if logged_out {
                    if let Some(v) = logged_out_secs {
                        seconds_since_input = v;
                    } else {
                        let v = crate::macos::macos_hid_idle(&cfg.macosTools.ioreg)
                            .map_err(UserActivityError::Message)?;
                        seconds_since_input = v;
                    }
                }
            } else {
                return Err(UserActivityError::Message(
                    "unsupported platform".to_string(),
                ));
            }
            Ok(())
        })();
        match attempt {
            Ok(()) => {}
            Err(UserActivityError::NoSession(ids)) => {
                if let Some(uw) = &host.unattended {
                    if inside_window((env.local_minutes)(eval_ms), &uw.start, &uw.end) {
                        unattended_window = Some(format!("{}-{}", uw.start, uw.end));
                        match crate::linux::sessions_idle_secs(&env.loginctl, &ids, eval_ms as f64)
                        {
                            Ok(secs) => seconds_since_input = secs,
                            Err(e) => {
                                user_activity_unknown = true;
                                user_activity_cause = e;
                                seconds_since_input = 0.0;
                            }
                        }
                    } else {
                        user_activity_unknown = true;
                        user_activity_cause =
                            "logged in without an active graphical session".to_string();
                        seconds_since_input = 0.0;
                    }
                } else {
                    user_activity_unknown = true;
                    user_activity_cause =
                        "logged in without an active graphical session".to_string();
                    seconds_since_input = 0.0;
                }
            }
            Err(UserActivityError::Message(msg)) => {
                user_activity_unknown = true;
                user_activity_cause = msg;
                seconds_since_input = 0.0;
            }
        }
    }

    if facts.acPower.is_none() || facts.batteryPercent.is_none() {
        let power_res: Result<(bool, Option<f64>), String> = match env.platform {
            Platform::Linux => crate::linux::linux_power(&sysfs_root),
            Platform::Darwin => match crate::macos::macos_power(&cfg.macosTools.pmset) {
                Ok((ac, batt)) => Ok((ac, batt)),
                Err(e) => Err(e),
            },
            Platform::Unsupported => Err("unsupported platform".to_string()),
        };
        match power_res {
            Ok((ac, batt)) => {
                if facts.acPower.is_none() {
                    ac_power = ac;
                }
                if facts.batteryPercent.is_none() {
                    battery_percent = batt;
                }
            }
            Err(e) => {
                power_unknown = true;
                power_cause = e;
                if facts.acPower.is_none() {
                    ac_power = false;
                }
            }
        }
    }

    if facts.memoryTotalMb.is_none() || facts.memoryFreeMb.is_none() {
        let mem_res: Result<(f64, f64), String> = match env.platform {
            Platform::Linux => crate::linux::linux_memory(),
            Platform::Darwin => crate::macos::macos_memory(),
            Platform::Unsupported => Err("unsupported platform".to_string()),
        };
        let (total, free) = mem_res?;
        if facts.memoryTotalMb.is_none() {
            memory_total_mb = total;
        }
        if facts.memoryFreeMb.is_none() {
            memory_free_mb = free;
        }
    }

    if facts.cpuCores.is_none() || facts.cpuLoad1m.is_none() {
        let (cores, load) = match env.platform {
            Platform::Linux => crate::linux::linux_cpu()?,
            Platform::Darwin => {
                let cpu = crate::macos::macos_cpu(&cfg.macosTools.sysctl)?;
                (cpu.cores, cpu.load1m)
            }
            Platform::Unsupported => return Err("unsupported platform".to_string()),
        };
        if facts.cpuCores.is_none() {
            cpu_cores = cores;
        }
        if facts.cpuLoad1m.is_none() {
            cpu_load1m = load;
        }
    }

    if facts.gpuPresent.is_none() || facts.gpuName.is_none() || facts.gpuFreeMb.is_none() {
        let gpu_res: Result<crate::linux::Gpu, String> = match env.platform {
            Platform::Linux => crate::linux::linux_gpu(&sysfs_root, &env.nvidia_smi),
            Platform::Darwin => {
                let g = crate::macos::macos_gpu(&cfg.macosTools.systemProfiler)?;
                Ok(crate::linux::Gpu {
                    present: g.present,
                    name: g.name,
                    freeMb: g.freeMb,
                })
            }
            Platform::Unsupported => return Err("unsupported platform".to_string()),
        };
        let gpu = gpu_res?;
        if facts.gpuPresent.is_none() {
            gpu_present = gpu.present;
        }
        if facts.gpuName.is_none() {
            gpu_name = gpu.name;
        }
        if facts.gpuFreeMb.is_none() {
            gpu_free_mb = gpu.freeMb;
        }
    }

    if facts.localModelsReachable.is_none() || facts.localModels.is_none() {
        let (reachable, models) = crate::local_models::query_local_models(
            &cfg.localModelsBaseUrl,
            cfg.localModelsTimeoutMs,
        );
        if facts.localModelsReachable.is_none() {
            local_models_reachable = reachable;
        }
        if facts.localModels.is_none() {
            local_models = models;
        }
    }

    let (idle, reason) = derive_idle(&IdleInputs {
        seconds_since_input,
        ac_power,
        battery_percent,
        inside_window: inside_window_bool,
        idle_minutes: cfg.idleMinutes,
        battery_threshold: cfg.batteryThreshold,
        user_activity_unknown,
        user_activity_cause: user_activity_cause.clone(),
        power_unknown,
        power_cause: power_cause.clone(),
        logged_out,
        unattended_window: unattended_window.clone(),
    });

    let output = HostCapacity {
        schemaVersion: "v1".to_string(),
        hostAlias: host.hostAlias,
        timestamp,
        idle,
        idleReason: reason,
        secondsSinceInput: seconds_since_input,
        acPower: ac_power,
        batteryPercent: battery_percent,
        cpu: Cpu {
            cores: cpu_cores,
            load1m: cpu_load1m,
        },
        memory: Memory {
            totalMb: memory_total_mb,
            freeMb: memory_free_mb,
        },
        gpu: Gpu {
            present: gpu_present,
            name: gpu_name,
            freeMb: gpu_free_mb,
        },
        localModels: LocalModels {
            reachable: local_models_reachable,
            models: local_models,
        },
        policy: Policy {
            allowedWindow: AllowedWindow {
                start: window_start,
                end: window_end,
            },
            insideWindow: inside_window_bool,
            maxConcurrentAgents: cfg.policy.maxConcurrentAgents,
        },
    };

    let violations = contract_violations(&output);
    if !violations.is_empty() {
        return Err(format!(
            "probe output violates host-capacity contract: {}",
            violations.join("; ")
        ));
    }

    Ok(output)
}

use crate::js::{format_number, js_number, js_round};

pub fn parse_minutes(time: &str) -> u32 {
    let parts: Vec<&str> = time.split(':').collect();
    let h_str = parts.first().copied().unwrap_or("");
    let m_str = parts.get(1).copied().unwrap_or("");
    let h_val = js_number(h_str);
    let m_val = js_number(m_str);
    let h = if h_val.is_nan() || !h_val.is_finite() {
        0
    } else {
        // TS Number can be float; but we truncate to u32 as minutes
        h_val as u32
    };
    let m = if m_val.is_nan() || !m_val.is_finite() {
        0
    } else {
        m_val as u32
    };
    h * 60 + m
}

pub fn inside_window(now_minutes: u32, start: &str, end: &str) -> bool {
    let start_m = parse_minutes(start);
    let end_m = parse_minutes(end);
    if start_m == end_m {
        return true;
    }
    if start_m <= end_m {
        now_minutes >= start_m && now_minutes < end_m
    } else {
        now_minutes >= start_m || now_minutes < end_m
    }
}

#[derive(Debug, Clone)]
pub struct IdleInputs {
    pub seconds_since_input: f64,
    pub ac_power: bool,
    pub battery_percent: Option<f64>,
    pub inside_window: bool,
    pub idle_minutes: f64,
    pub battery_threshold: f64,
    pub user_activity_unknown: bool,
    pub user_activity_cause: String,
    pub power_unknown: bool,
    pub power_cause: String,
    pub logged_out: bool,
    pub unattended_window: Option<String>,
}

pub fn derive_idle(inputs: &IdleInputs) -> (bool, String) {
    if inputs.user_activity_unknown {
        let cause = if inputs.user_activity_cause.is_empty() {
            "unavailable"
        } else {
            inputs.user_activity_cause.as_str()
        };
        return (false, format!("user activity unknown: {cause}"));
    }
    if inputs.power_unknown {
        let cause = if inputs.power_cause.is_empty() {
            "unavailable"
        } else {
            inputs.power_cause.as_str()
        };
        return (false, format!("power unknown: {cause}"));
    }

    let battery_ok = match inputs.battery_percent {
        None => true,
        Some(v) => v > inputs.battery_threshold,
    };

    if !inputs.inside_window {
        return (false, "outside the policy window".to_string());
    }
    if !inputs.ac_power {
        return (false, "not on AC power".to_string());
    }
    if !battery_ok {
        let bp = inputs.battery_percent.unwrap();
        let bt = inputs.battery_threshold;
        return (
            false,
            format!(
                "battery at {} percent, at or below the {} percent floor",
                format_number(bp),
                format_number(bt)
            ),
        );
    }
    if inputs.logged_out {
        return (true, "no user logged in, on AC power".to_string());
    }
    let idle_minutes_sec = inputs.idle_minutes * 60.0;
    if inputs.seconds_since_input < idle_minutes_sec {
        return (
            false,
            format!(
                "user input {} seconds ago",
                format_number(inputs.seconds_since_input)
            ),
        );
    }
    let mins = js_round(inputs.seconds_since_input / 60.0);
    if let Some(window) = &inputs.unattended_window {
        return (
            true,
            format!(
                "unattended window {}: no input on the local session for {} minutes, on AC power",
                window,
                format_number(mins)
            ),
        );
    }
    (
        true,
        format!(
            "no user input for {} minutes, on AC power",
            format_number(mins)
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js::format_number;

    fn base_inputs() -> IdleInputs {
        IdleInputs {
            seconds_since_input: 0.0,
            ac_power: true,
            battery_percent: None,
            inside_window: true,
            idle_minutes: 10.0,
            battery_threshold: 50.0,
            user_activity_unknown: false,
            user_activity_cause: String::new(),
            power_unknown: false,
            power_cause: String::new(),
            logged_out: false,
            unattended_window: None,
        }
    }

    #[test]
    fn idle_rule_reasons() {
        // user activity unknown with cause and fallback
        let mut i = base_inputs();
        i.user_activity_unknown = true;
        i.user_activity_cause = "disk error".to_string();
        let (idle, reason) = derive_idle(&i);
        assert!(!idle);
        assert_eq!(reason, "user activity unknown: disk error");

        i.user_activity_cause = String::new();
        let (_, reason) = derive_idle(&i);
        assert_eq!(reason, "user activity unknown: unavailable");

        // power unknown
        let mut i = base_inputs();
        i.power_unknown = true;
        i.power_cause = "no mains".to_string();
        let (_, reason) = derive_idle(&i);
        assert_eq!(reason, "power unknown: no mains");
        i.power_cause = String::new();
        let (_, reason) = derive_idle(&i);
        assert_eq!(reason, "power unknown: unavailable");

        // outside window
        let mut i = base_inputs();
        i.inside_window = false;
        let (idle, reason) = derive_idle(&i);
        assert!(!idle);
        assert_eq!(reason, "outside the policy window");

        // not on AC
        let mut i = base_inputs();
        i.ac_power = false;
        let (_, reason) = derive_idle(&i);
        assert_eq!(reason, "not on AC power");

        // battery at or below floor
        let mut i = base_inputs();
        i.battery_percent = Some(34.0);
        i.battery_threshold = 50.0;
        let (_, reason) = derive_idle(&i);
        assert_eq!(
            reason,
            "battery at 34 percent, at or below the 50 percent floor"
        );
        // using format_number check: D3 example
        assert_eq!(
            format!(
                "battery at {} percent, at or below the {} percent floor",
                format_number(34.0),
                format_number(50.0)
            ),
            "battery at 34 percent, at or below the 50 percent floor"
        );
        // battery OK when > threshold
        let mut i = base_inputs();
        i.battery_percent = Some(80.0);
        i.battery_threshold = 50.0;
        i.seconds_since_input = 0.0;
        i.idle_minutes = 10.0;
        let (_, reason) = derive_idle(&i);
        assert_eq!(reason, "user input 0 seconds ago");

        // logged out
        let mut i = base_inputs();
        i.logged_out = true;
        let (idle, reason) = derive_idle(&i);
        assert!(idle);
        assert_eq!(reason, "no user logged in, on AC power");

        // user input seconds ago (less than idle_minutes*60)
        let mut i = base_inputs();
        i.seconds_since_input = 30.0;
        i.idle_minutes = 5.0;
        let (idle, reason) = derive_idle(&i);
        assert!(!idle);
        assert_eq!(reason, "user input 30 seconds ago");
        // Ensure format_number used: e.g., integer formatting
        assert_eq!(format_number(30.0), "30");

        // unattended window
        let mut i = base_inputs();
        i.seconds_since_input = 43200.0;
        i.idle_minutes = 10.0;
        i.unattended_window = Some("00:00-00:00".to_string());
        let (idle, reason) = derive_idle(&i);
        assert!(idle);
        assert_eq!(
            reason,
            "unattended window 00:00-00:00: no input on the local session for 720 minutes, on AC power"
        );

        // no user input for N minutes
        let mut i = base_inputs();
        i.seconds_since_input = 600.0;
        i.idle_minutes = 5.0;
        let (idle, reason) = derive_idle(&i);
        assert!(idle);
        assert_eq!(reason, "no user input for 10 minutes, on AC power");

        // inside_window helper checks
        assert!(inside_window(0, "00:00", "00:00"));
        assert!(inside_window(570, "09:00", "10:00"));
        assert!(!inside_window(530, "09:00", "10:00"));
        assert!(inside_window(1380, "22:00", "02:00"));
        assert!(inside_window(60, "22:00", "02:00"));
        assert!(!inside_window(180, "22:00", "02:00"))
    }
}

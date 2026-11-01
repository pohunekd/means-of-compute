use std::mem::MaybeUninit;

unsafe extern "C" {
    fn tzset();
}

fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}

fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if is_leap_year(year) {
                29
            } else {
                28
            }
        }
        _ => 0,
    }
}

// Howard Hinnant days_from_civil
fn days_from_civil(year: i32, month: u32, day: u32) -> i32 {
    let y = if month <= 2 { year - 1 } else { year };
    let m = month as i32;
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + day as i32 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn civil_from_days(z: i32) -> (i32, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 {
        z / 146097
    } else {
        (z - 146096) / 146097
    };
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let y = y + if m <= 2 { 1 } else { 0 };
    (y, m as u32, d as u32)
}

pub fn parse_timestamp(s: &str) -> Option<i64> {
    // Exactly YYYY-MM-DDTHH:MM:SS.mmmZ (ASCII digits)
    if s.len() != 24 {
        return None;
    }
    let bytes = s.as_bytes();
    // Check literals
    if bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || bytes[19] != b'.'
        || bytes[23] != b'Z'
    {
        return None;
    }
    // Digits positions
    for &pos in &[0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18, 20, 21, 22] {
        if !bytes[pos].is_ascii_digit() {
            return None;
        }
    }

    let year: i32 = ((bytes[0] - b'0') as i32) * 1000
        + ((bytes[1] - b'0') as i32) * 100
        + ((bytes[2] - b'0') as i32) * 10
        + (bytes[3] - b'0') as i32;
    let month: u32 = ((bytes[5] - b'0') as u32) * 10 + (bytes[6] - b'0') as u32;
    let day: u32 = ((bytes[8] - b'0') as u32) * 10 + (bytes[9] - b'0') as u32;
    let hour: u32 = ((bytes[11] - b'0') as u32) * 10 + (bytes[12] - b'0') as u32;
    let minute: u32 = ((bytes[14] - b'0') as u32) * 10 + (bytes[15] - b'0') as u32;
    let second: u32 = ((bytes[17] - b'0') as u32) * 10 + (bytes[18] - b'0') as u32;
    let millis: u32 = ((bytes[20] - b'0') as u32) * 100
        + ((bytes[21] - b'0') as u32) * 10
        + (bytes[22] - b'0') as u32;

    if !(1..=12).contains(&month) {
        return None;
    }
    let dim = days_in_month(year, month);
    if day == 0 || day > dim {
        return None;
    }
    if hour > 23 {
        return None;
    }
    if minute > 59 {
        return None;
    }
    if second > 59 {
        return None;
    }

    let days = days_from_civil(year, month, day) as i64;
    let secs_of_day = (hour as i64) * 3600 + (minute as i64) * 60 + (second as i64);
    let epoch_ms = days * 86_400_000 + secs_of_day * 1000 + millis as i64;
    Some(epoch_ms)
}

/// Matches toISOString for years 0..=9999 only.
pub fn format_timestamp(epoch_ms: i64) -> String {
    let days = epoch_ms.div_euclid(86_400_000) as i32;
    let ms_of_day = epoch_ms.rem_euclid(86_400_000);
    let secs_of_day = ms_of_day / 1000;
    let millis = (ms_of_day % 1000) as u32;
    let hour = (secs_of_day / 3600) as u32;
    let minute = ((secs_of_day % 3600) / 60) as u32;
    let second = (secs_of_day % 60) as u32;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year, month, day, hour, minute, second, millis
    )
}

pub fn local_minutes(epoch_ms: i64) -> u32 {
    unsafe {
        tzset();
        let secs = epoch_ms.div_euclid(1000);
        let t = secs as libc::time_t;
        let mut tm_uninit = MaybeUninit::<libc::tm>::uninit();
        let ret = libc::localtime_r(&t as *const libc::time_t, tm_uninit.as_mut_ptr());
        if ret.is_null() {
            return 0;
        }
        let tm = tm_uninit.assume_init();
        (tm.tm_hour * 60 + tm.tm_min) as u32
    }
}

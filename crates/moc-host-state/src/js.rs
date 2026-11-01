use std::io;

// JS whitespace as defined by ECMAScript WhiteSpace (including BOM).
#[allow(non_snake_case)]
pub fn JS_WS(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'
            | '\u{2001}'
            | '\u{2002}'
            | '\u{2003}'
            | '\u{2004}'
            | '\u{2005}'
            | '\u{2006}'
            | '\u{2007}'
            | '\u{2008}'
            | '\u{2009}'
            | '\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

// Same set as a regex character class, for use inside `[...]`.
pub const JS_WS_CLASS: &str = "\u{0009}\u{000A}\u{000B}\u{000C}\u{000D} \u{00A0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}";

pub fn js_trim(s: &str) -> &str {
    s.trim_matches(JS_WS)
}

pub fn js_number(s: &str) -> f64 {
    let t = js_trim(s);
    if t.is_empty() {
        return 0.0;
    }
    if t == "Infinity" || t == "+Infinity" {
        return f64::INFINITY;
    }
    if t == "-Infinity" {
        return f64::NEG_INFINITY;
    }
    // Unsigned 0x/0o/0b literals
    let b = t.as_bytes();
    if b.len() >= 2 && b[0] == b'0' && matches!(b[1], b'x' | b'X' | b'o' | b'O' | b'b' | b'B') {
        let rest = &t[2..];
        if rest.is_empty() {
            return f64::NAN;
        }
        let prefix = &t[0..2];
        let valid = match prefix {
            "0x" | "0X" => rest.bytes().all(|b| b.is_ascii_hexdigit()),
            "0o" | "0O" => rest.bytes().all(|b| (b'0'..=b'7').contains(&b)),
            "0b" | "0B" => rest.bytes().all(|b| b == b'0' || b == b'1'),
            _ => false,
        };
        if !valid {
            return f64::NAN;
        }
        let radix: u32 = match prefix {
            "0x" | "0X" => 16,
            "0o" | "0O" => 8,
            _ => 2,
        };
        let trimmed = rest.trim_start_matches('0');
        if trimmed.is_empty() {
            return 0.0;
        }
        let k = match radix {
            16 => 4,
            8 => 3,
            _ => 1,
        };
        let mut bit_str = String::with_capacity(trimmed.len() * k as usize);
        for ch in trimmed.chars() {
            let Some(d) = ch.to_digit(radix) else {
                return f64::NAN;
            };
            for i in (0..k).rev() {
                bit_str.push(if (d >> i) & 1 == 1 { '1' } else { '0' });
            }
        }
        let bit_str = bit_str.trim_start_matches('0').to_string();
        if bit_str.is_empty() {
            return 0.0;
        }
        if bit_str.len() <= 128 {
            let mut val: u128 = 0;
            for ch in bit_str.chars() {
                val = (val << 1) | (ch as u128 - '0' as u128);
            }
            return val as f64;
        }
        let dropped = bit_str.len() - 128;
        let top = &bit_str[..128];
        let rest_bits = &bit_str[128..];
        let mut val: u128 = 0;
        for ch in top.chars() {
            val = (val << 1) | (ch as u128 - '0' as u128);
        }
        if rest_bits.contains('1') {
            val |= 1;
        }
        let f = val as f64;
        return f * 2f64.powi(dropped as i32);
    }

    // Decimal pattern: [+-]?(digits[.digits?]|.digits)([eE][+-]?digits)?
    let bytes = t.as_bytes();
    let mut idx = 0usize;
    let len = bytes.len();

    if idx < len && (bytes[idx] == b'+' || bytes[idx] == b'-') {
        idx += 1;
    }
    if idx >= len {
        return f64::NAN;
    }
    let start_digits = idx;
    while idx < len && bytes[idx].is_ascii_digit() {
        idx += 1;
    }
    let has_digits_before = idx > start_digits;
    let has_dot = idx < len && bytes[idx] == b'.';
    if has_dot {
        idx += 1;
        let start_after = idx;
        while idx < len && bytes[idx].is_ascii_digit() {
            idx += 1;
        }
        let has_digits_after = idx > start_after;
        if !has_digits_before && !has_digits_after {
            return f64::NAN;
        }
    } else if !has_digits_before {
        return f64::NAN;
    }

    if idx < len && (bytes[idx] == b'e' || bytes[idx] == b'E') {
        idx += 1;
        if idx < len && (bytes[idx] == b'+' || bytes[idx] == b'-') {
            idx += 1;
        }
        let start_exp = idx;
        while idx < len && bytes[idx].is_ascii_digit() {
            idx += 1;
        }
        if idx == start_exp {
            return f64::NAN;
        }
    }

    if idx != len {
        return f64::NAN;
    }

    t.parse::<f64>().unwrap_or(f64::NAN)
}

pub fn js_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

pub fn format_number(n: f64) -> String {
    let mut buf = ryu_js::Buffer::new();
    buf.format(n).to_string()
}

pub fn errno_name(e: &io::Error) -> String {
    let code = match e.raw_os_error() {
        Some(c) => c,
        None => return "unknown".to_string(),
    };
    let name = if code == libc::EACCES {
        "EACCES"
    } else if code == libc::EPERM {
        "EPERM"
    } else if code == libc::ENOENT {
        "ENOENT"
    } else if code == libc::ENOTDIR {
        "ENOTDIR"
    } else if code == libc::EISDIR {
        "EISDIR"
    } else if code == libc::ELOOP {
        "ELOOP"
    } else if code == libc::EIO {
        "EIO"
    } else if code == libc::ENXIO {
        "ENXIO"
    } else if code == libc::ENODEV {
        "ENODEV"
    } else if code == libc::EINVAL {
        "EINVAL"
    } else if code == libc::EAGAIN {
        "EAGAIN"
    } else if code == libc::EBUSY {
        "EBUSY"
    } else if code == libc::ENOMEM {
        "ENOMEM"
    } else if code == libc::EMFILE {
        "EMFILE"
    } else if code == libc::ENFILE {
        "ENFILE"
    } else if code == libc::ENAMETOOLONG {
        "ENAMETOOLONG"
    } else if code == libc::ETIMEDOUT {
        "ETIMEDOUT"
    } else if code == libc::EOPNOTSUPP {
        "EOPNOTSUPP"
    } else if code == libc::ENOEXEC {
        "ENOEXEC"
    } else if code == libc::ENODATA {
        "ENODATA"
    } else {
        return format!("errno-{code}");
    };
    name.to_string()
}

pub fn spawn_error(program: &str, e: &io::Error) -> String {
    if !program.contains('/') && e.kind() == io::ErrorKind::NotFound {
        return format!("Executable not found in $PATH: \"{program}\"");
    }
    let errno = errno_name(e);
    let description = match errno.as_str() {
        "ENOENT" => "no such file or directory",
        "EACCES" => "permission denied",
        "ENOTDIR" => "not a directory",
        "ENOEXEC" => "unknown error",
        "ELOOP" => "too many symbolic links encountered",
        "ENAMETOOLONG" => "name too long",
        "EPERM" => "operation not permitted",
        _ => "",
    };
    if description.is_empty() {
        format!("{errno}: posix_spawn '{program}'")
    } else {
        format!("{errno}: {description}, posix_spawn '{program}'")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::time::{format_timestamp, parse_timestamp};

    #[test]
    fn js_compat() {
        assert_eq!(format_number(1.0), "1");
        assert_eq!(format_number(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(format_number(1e21), "1e+21");
        assert_eq!(format_number(1e-7), "1e-7");
        assert_eq!(format_number(-0.0), "0");
        assert_eq!(js_number(" 0x10 "), 16.0);
        assert!(js_number("inf").is_nan());
        assert_eq!(js_number(""), 0.0);
        assert_eq!(js_number("  "), 0.0);
        assert_eq!(js_number("Infinity"), f64::INFINITY);
        assert_eq!(js_number("-Infinity"), f64::NEG_INFINITY);
        assert!(js_number(" 0xG ").is_nan());
        assert!(js_number("1€").is_nan());
        assert_eq!(js_number("0x200000000000011"), 144_115_188_075_855_904.0);
        // parse_timestamp rejects invalid dates
        assert_eq!(parse_timestamp("2026-02-29T00:00:00.000Z"), None);
        assert_eq!(parse_timestamp("2026-10-27T23:59:60.000Z"), None);
        assert_eq!(parse_timestamp("2026-13-01T00:00:00.000Z"), None);
        assert_eq!(parse_timestamp("2026-10-27T24:00:00.000Z"), None);
        assert_eq!(
            parse_timestamp("2026-10-27T12:00:00.000Z"),
            Some(1_793_102_400_000)
        );
        let ms = 1_793_102_400_000;
        assert_eq!(format_timestamp(ms), "2026-10-27T12:00:00.000Z");
        assert_eq!(parse_timestamp(&format_timestamp(ms)), Some(ms));
        // round-trip for epoch
        assert_eq!(format_timestamp(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(parse_timestamp("1970-01-01T00:00:00.000Z"), Some(0));
    }
}

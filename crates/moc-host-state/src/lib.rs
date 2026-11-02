//! Parity rules with the TypeScript probe (src/probe/):
//! - stdout is JSON.stringify(output) + "\n": key order of the TS object literal in
//!   runProbe, numbers via js::format_number, strings via serde_json.
//! - Text that can reach idleReason is byte-identical to the TS text, including Bun spawn
//!   errors (js::spawn_error) and Node errno names (js::errno_name).
//! - Numbers are f64 as in JS; Number(text) is js::js_number, Math.round is js::js_round,
//!   trim and \s use js::JS_WS. Regexes use [0-9] and js::JS_WS_CLASS, never \d or \s.
//! - Directory listings keep read_dir order, never sorted (Bun readdirSync order).
//! - Failures that only reach stderr need the same exit code, not the same text.
//! - Documented divergences: JSON input with unpaired surrogate escapes, numbers that overflow f64, or nesting of 128 levels or more (the top-level value counts as one) is rejected (exit 1) where the TypeScript loader may accept it; the probe's config, host and facts files never contain them.
//! - For stderr-only text, the key named when several keys fail may differ.

pub mod config;
pub mod facts;
pub mod idle_rule;
pub mod js;
pub mod linux;
pub mod platform;
pub mod proc;
pub mod time;

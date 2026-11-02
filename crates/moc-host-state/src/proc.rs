use crate::js::spawn_error;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;

const BUN_DEFAULT_PATH: &str = "/usr/bin:/bin";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StderrMode {
    Inherit,
    Null,
}

/// Spawn `program` with `args`, capture stdout, handle stderr as requested.
/// On spawn failure returns `Err(spawn_error)`, otherwise `Ok((exit_code, stdout))`.
pub fn run(
    program: &str,
    args: &[String],
    stderr: StderrMode,
) -> Result<(Option<i32>, String), String> {
    let resolved = if program.contains('/') {
        None
    } else {
        // Bun searches /usr/bin:/bin when PATH is unset or empty, skips empty entries, and
        // accepts a regular file whose owner exec bit is set.
        let path_var = std::env::var_os("PATH")
            .filter(|p| !p.is_empty())
            .unwrap_or_else(|| std::ffi::OsString::from(BUN_DEFAULT_PATH));
        let mut found: Option<PathBuf> = None;
        for dir in std::env::split_paths(&path_var) {
            if dir.as_os_str().is_empty() {
                continue;
            }
            let candidate = dir.join(program);
            if let Ok(meta) = std::fs::metadata(&candidate) {
                if meta.is_file() && meta.permissions().mode() & 0o100 != 0 {
                    found = Some(candidate);
                    break;
                }
            }
        }
        match found {
            Some(p) => Some(p),
            None => return Err(format!("Executable not found in $PATH: \"{program}\"")),
        }
    };
    let program_to_spawn = resolved.as_deref().unwrap_or(std::path::Path::new(program));

    for (i, a) in args.iter().enumerate() {
        if a.contains('\0') {
            return Err(format!(
                "The argument 'args[{}]' must be a string without null bytes. Received \"{a}\"",
                i + 1
            ));
        }
    }

    let mut cmd = std::process::Command::new(program_to_spawn);
    cmd.arg0(program);
    cmd.args(args);
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    match stderr {
        StderrMode::Inherit => {
            cmd.stderr(std::process::Stdio::inherit());
        }
        StderrMode::Null => {
            cmd.stderr(std::process::Stdio::null());
        }
    }
    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return Err(spawn_error(program, &e)),
    };
    let output = match child.wait_with_output() {
        Ok(o) => o,
        Err(e) => return Err(spawn_error(program, &e)),
    };
    let mut stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    stdout = stdout
        .strip_prefix('\u{FEFF}')
        .map(str::to_string)
        .unwrap_or(stdout);
    let code = output.status.code();
    Ok((code, stdout))
}

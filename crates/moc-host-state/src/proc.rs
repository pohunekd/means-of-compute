use crate::js::spawn_error;

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
    let mut cmd = std::process::Command::new(program);
    cmd.args(args);
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
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let code = output.status.code();
    Ok((code, stdout))
}

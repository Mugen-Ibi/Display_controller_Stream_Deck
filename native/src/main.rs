mod monitor;

use serde::Deserialize;
use serde_json::{Value, json};
use std::io::{self, BufRead, Write};

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum Command {
    List {},
    Get { monitor_id: String },
    Set { monitor_id: String, percent: f64 },
}

#[derive(Deserialize)]
struct Request {
    id: u64,
    #[serde(flatten)]
    command: Command,
}

fn execute(command: Command) -> Result<Value, String> {
    match command {
        Command::List {} => Ok(json!(monitor::list()?)),
        Command::Get { monitor_id } => Ok(json!(monitor::get(&monitor_id)?)),
        Command::Set {
            monitor_id,
            percent,
        } => {
            if !percent.is_finite() || !(0.0..=100.0).contains(&percent) {
                return Err("Brightness must be between 0 and 100".into());
            }
            Ok(json!(monitor::set(&monitor_id, percent)?))
        }
    }
}

fn response(line: &str) -> Value {
    match serde_json::from_str::<Request>(line) {
        Ok(request) => match execute(request.command) {
            Ok(result) => json!({"id": request.id, "ok": true, "result": result}),
            Err(error) => json!({"id": request.id, "ok": false, "error": error}),
        },
        Err(error) => {
            json!({"id": null, "ok": false, "error": format!("Invalid request: {error}")})
        }
    }
}

fn main() {
    // stdout is exclusively the JSON-lines protocol. EOF releases all resources.
    let stdout = io::stdout();
    let mut output = stdout.lock();
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if writeln!(output, "{}", response(&line)).is_err() || output.flush().is_err() {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unknown_operations_and_fields() {
        assert!(serde_json::from_str::<Request>(r#"{"id":1,"op":"powerOff"}"#).is_err());
        assert!(serde_json::from_str::<Request>(r#"{"id":1,"op":"list","extra":1}"#).is_err());
    }
    #[test]
    fn rejects_out_of_range_before_accessing_hardware() {
        for percent in [-1.0, 101.0, f64::NAN] {
            assert!(
                execute(Command::Set {
                    monitor_id: String::new(),
                    percent
                })
                .is_err()
            );
        }
    }
    #[test]
    fn malformed_input_returns_json_error() {
        assert_eq!(response("garbage")["ok"], false);
    }
}

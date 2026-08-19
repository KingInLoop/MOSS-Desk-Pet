use chrono::{Duration as ChronoDuration, NaiveDate, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    env,
    fs::{self, File},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};
use walkdir::WalkDir;

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Limit {
    id: String,
    name: String,
    label: String,
    used_percent: f64,
    remaining_percent: f64,
    window_duration_mins: Option<f64>,
    resets_at: Option<i64>,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyUsage {
    date: String,
    tokens: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub status: String,
    pub source: String,
    pub updated_at: String,
    pub plan_type: Option<String>,
    pub limits: Vec<Limit>,
    pub daily_usage: Vec<DailyUsage>,
    pub message: Option<String>,
}

impl Default for UsageSnapshot {
    fn default() -> Self {
        Self {
            status: "loading".into(),
            source: String::new(),
            updated_at: Utc::now().to_rfc3339(),
            plan_type: None,
            limits: vec![],
            daily_usage: vec![],
            message: Some("正在读取额度…".into()),
        }
    }
}

fn number(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64)
}
fn field<'a>(value: &'a Value, camel: &str, snake: &str) -> Option<&'a Value> {
    value.get(camel).or_else(|| value.get(snake))
}

fn window_label(minutes: f64) -> String {
    if minutes <= 1440.0 {
        if minutes == 1440.0 {
            "每日额度".into()
        } else {
            format!("{} 小时额度", (minutes / 60.0).round())
        }
    } else if (minutes - 10080.0).abs() < 1440.0 {
        "每周额度".into()
    } else {
        format!("{} 天额度", (minutes / 1440.0).round())
    }
}

fn normalize_limits(rate: &Value) -> Vec<Limit> {
    let mut output = vec![];
    let Some(buckets) =
        field(rate, "rateLimitsByLimitId", "rate_limits_by_limit_id").and_then(Value::as_object)
    else {
        return output;
    };
    for (id, bucket) in buckets {
        for slot in ["primary", "secondary"] {
            let Some(window) = bucket.get(slot) else {
                continue;
            };
            let used = number(field(window, "usedPercent", "used_percent"))
                .unwrap_or(0.0)
                .clamp(0.0, 100.0);
            let duration = number(field(window, "windowDurationMins", "window_duration_mins"));
            let name = field(bucket, "limitName", "limit_name")
                .and_then(Value::as_str)
                .unwrap_or(if id == "codex" { "Codex" } else { id })
                .to_string();
            output.push(Limit {
                id: format!("{id}:{slot}"),
                name: name.clone(),
                label: format!(
                    "{} · {}",
                    name,
                    duration.map(window_label).unwrap_or_else(|| "额度".into())
                ),
                used_percent: used,
                remaining_percent: 100.0 - used,
                window_duration_mins: duration,
                resets_at: field(window, "resetsAt", "resets_at").and_then(Value::as_i64),
            });
        }
    }
    output.sort_by_key(|limit| {
        (
            !limit.id.starts_with("codex:"),
            -(limit.window_duration_mins.unwrap_or(0.0) as i64),
        )
    });
    output
}

fn seven_days(raw: Vec<(NaiveDate, u64)>) -> Vec<DailyUsage> {
    let mut totals = BTreeMap::new();
    for (date, tokens) in raw {
        *totals.entry(date).or_insert(0u64) += tokens;
    }
    let today = Utc::now().date_naive();
    (0..7)
        .map(|offset| {
            let date = today - ChronoDuration::days(6 - offset);
            DailyUsage {
                date: date.to_string(),
                tokens: *totals.get(&date).unwrap_or(&0),
            }
        })
        .collect()
}

fn normalize(rate: Value, usage: Value) -> UsageSnapshot {
    let limits = normalize_limits(&rate);
    let plan = field(&rate, "planType", "plan_type")
        .or_else(|| {
            field(&rate, "rateLimitsByLimitId", "rate_limits_by_limit_id")
                .and_then(Value::as_object)
                .and_then(|buckets| buckets.values().next())
                .and_then(|bucket| field(bucket, "planType", "plan_type"))
        })
        .or_else(|| field(&usage, "planType", "plan_type"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let raw = field(&usage, "dailyUsageBuckets", "daily_usage_buckets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let date = field(item, "startDate", "start_date")
                .and_then(Value::as_str)
                .and_then(|value| {
                    NaiveDate::parse_from_str(&value[..value.len().min(10)], "%Y-%m-%d").ok()
                })?;
            Some((
                date,
                item.get("tokens").and_then(Value::as_u64).unwrap_or(0),
            ))
        })
        .collect();
    UsageSnapshot {
        status: if limits.is_empty() {
            "unavailable"
        } else {
            "ok"
        }
        .into(),
        source: "app-server".into(),
        updated_at: Utc::now().to_rfc3339(),
        plan_type: plan,
        limits,
        daily_usage: seven_days(raw),
        message: None,
    }
}

fn candidates() -> Vec<PathBuf> {
    let mut values = vec![];
    for key in ["CODEX_CLI_PATH", "CODEX_PATH"] {
        if let Ok(value) = env::var(key) {
            values.push(PathBuf::from(value));
        }
    }
    if cfg!(windows) {
        if let Ok(local) = env::var("LOCALAPPDATA") {
            values.push(Path::new(&local).join("Programs/ChatGPT/resources/codex.exe"));
            values.push(Path::new(&local).join("Programs/Codex/resources/codex.exe"));
        }
        if let Ok(home) = env::var("USERPROFILE") {
            for root in [
                Path::new(&home).join(".vscode/extensions"),
                Path::new(&home).join(".vscode-insiders/extensions"),
            ] {
                if let Ok(extensions) = fs::read_dir(root) {
                    for extension in extensions.filter_map(Result::ok).filter(|entry| {
                        entry
                            .file_name()
                            .to_string_lossy()
                            .to_lowercase()
                            .contains("openai")
                    }) {
                        for entry in WalkDir::new(extension.path())
                            .max_depth(5)
                            .into_iter()
                            .filter_map(Result::ok)
                        {
                            if entry.file_type().is_file()
                                && entry
                                    .file_name()
                                    .to_string_lossy()
                                    .eq_ignore_ascii_case("codex.exe")
                            {
                                values.push(entry.path().to_path_buf());
                            }
                        }
                    }
                }
            }
        }
    }
    values.push(PathBuf::from(if cfg!(windows) {
        "codex.exe"
    } else {
        "codex"
    }));
    values
}

fn app_server(executable: &Path) -> Result<(Value, Value), String> {
    let mut command = Command::new(executable);
    command
        .arg("app-server")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let stdout = child.stdout.take().ok_or("无法读取 Codex 输出")?;
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                let _ = sender.send(value);
            }
        }
    });
    let input = child.stdin.as_mut().ok_or("无法连接 Codex 输入")?;
    writeln!(input, "{}", json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"moss-desk-pet","version":"1.3.7"},"capabilities":{}}})).map_err(|e| e.to_string())?;
    let started = Instant::now();
    let mut responses = HashMap::new();
    while started.elapsed() < Duration::from_secs(12) {
        let message = match receiver.recv_timeout(Duration::from_millis(500)) {
            Ok(message) => message,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let _ = child.kill();
                return Err("Codex 额度服务已断开".into());
            }
        };
        match message.get("id").and_then(Value::as_i64) {
            Some(1) => {
                writeln!(input, "{}", json!({"method":"initialized","params":{}}))
                    .map_err(|e| e.to_string())?;
                writeln!(
                    input,
                    "{}",
                    json!({"id":2,"method":"account/rateLimits/read","params":{}})
                )
                .map_err(|e| e.to_string())?;
                writeln!(
                    input,
                    "{}",
                    json!({"id":3,"method":"account/usage/read","params":{}})
                )
                .map_err(|e| e.to_string())?;
            }
            Some(id @ (2 | 3)) => {
                if message.get("error").is_some() {
                    let _ = child.kill();
                    return Err("Codex 额度服务不可用".into());
                }
                responses.insert(
                    id,
                    message.get("result").cloned().unwrap_or_else(|| json!({})),
                );
            }
            _ => {}
        }
        if responses.contains_key(&2) && responses.contains_key(&3) {
            let _ = child.kill();
            return Ok((responses.remove(&2).unwrap(), responses.remove(&3).unwrap()));
        }
    }
    let _ = child.kill();
    Err("读取额度超时".into())
}

fn local_daily() -> Vec<DailyUsage> {
    let mut raw = vec![];
    for entry in WalkDir::new(super::monitor::codex_home().join("sessions"))
        .max_depth(6)
        .into_iter()
        .filter_map(Result::ok)
    {
        if entry.path().extension().and_then(|v| v.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(file) = File::open(entry.path()) else {
            continue;
        };
        for line in BufReader::new(file)
            .lines()
            .map_while(Result::ok)
            .filter(|line| line.contains("token_count"))
        {
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if value.pointer("/payload/type").and_then(Value::as_str) != Some("token_count") {
                continue;
            }
            let Some(tokens) = value
                .pointer("/payload/info/last_token_usage/total_tokens")
                .and_then(Value::as_u64)
            else {
                continue;
            };
            let Some(date) = value
                .get("timestamp")
                .and_then(Value::as_str)
                .and_then(|v| NaiveDate::parse_from_str(&v[..v.len().min(10)], "%Y-%m-%d").ok())
            else {
                continue;
            };
            raw.push((date, tokens));
        }
    }
    seven_days(raw)
}

pub fn read() -> UsageSnapshot {
    let executable = candidates()
        .into_iter()
        .find(|value| !value.components().skip(1).next().is_some() || fs::metadata(value).is_ok());
    if let Some(executable) = executable {
        if let Ok((rate, usage)) = app_server(&executable) {
            return normalize(rate, usage);
        }
    }
    UsageSnapshot {
        status: "unavailable".into(),
        source: "local".into(),
        updated_at: Utc::now().to_rfc3339(),
        plan_type: None,
        limits: vec![],
        daily_usage: local_daily(),
        message: Some("官方额度暂不可用；图表为本地估算".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalizes_weekly_remaining_quota() {
        let snapshot = normalize(
            json!({"planType":"pro","rateLimitsByLimitId":{"codex":{"primary":{"usedPercent":34,"windowDurationMins":10080,"resetsAt":1787205216}}}}),
            json!({"dailyUsageBuckets":[]}),
        );
        assert_eq!(snapshot.plan_type.as_deref(), Some("pro"));
        assert_eq!(snapshot.limits[0].remaining_percent, 66.0);
        assert!(snapshot.limits[0].label.contains("每周"));
    }
}

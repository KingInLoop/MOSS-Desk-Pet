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

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Balance {
    currency: String,
    total: f64,
    normal: f64,
    bonus: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsage {
    pub id: String,
    pub name: String,
    pub status: String,
    pub source: String,
    pub updated_at: String,
    pub plan_type: Option<String>,
    pub limits: Vec<Limit>,
    pub balances: Vec<Balance>,
    pub daily_usage: Vec<DailyUsage>,
    pub message: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub status: String,
    pub source: String,
    pub updated_at: String,
    pub plan_type: Option<String>,
    pub limits: Vec<Limit>,
    pub balances: Vec<Balance>,
    pub daily_usage: Vec<DailyUsage>,
    pub message: Option<String>,
    pub providers: Vec<ProviderUsage>,
}

impl Default for UsageSnapshot {
    fn default() -> Self {
        Self {
            status: "loading".into(),
            source: String::new(),
            updated_at: Utc::now().to_rfc3339(),
            plan_type: None,
            limits: vec![],
            balances: vec![],
            daily_usage: vec![],
            message: Some("正在读取额度…".into()),
            providers: vec![],
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
    let mut fallback = serde_json::Map::new();
    let buckets = field(rate, "rateLimitsByLimitId", "rate_limits_by_limit_id")
        .and_then(Value::as_object);
    if buckets.map(|value| value.is_empty()).unwrap_or(true) {
        if let Some(single) = field(rate, "rateLimits", "rate_limits")
            .filter(|value| value.get("primary").is_some() || value.get("secondary").is_some())
        {
            let id = field(single, "limitId", "limit_id")
                .and_then(Value::as_str)
                .unwrap_or("codex");
            fallback.insert(id.into(), single.clone());
        } else if rate.get("primary").is_some() || rate.get("secondary").is_some() {
            fallback.insert("codex".into(), rate.clone());
        }
    }
    let buckets = buckets.unwrap_or(&fallback);
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

fn normalize(rate: Value, usage: Value) -> ProviderUsage {
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
    ProviderUsage {
        id: "codex".into(),
        name: "ChatGPT / Codex".into(),
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
        balances: vec![],
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
    writeln!(input, "{}", json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"moss_desk_pet","title":"MOSS Desk Pet","version":"1.4.0"},"capabilities":{}}})).map_err(|e| e.to_string())?;
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
            Some(2) => {
                if message.get("error").is_some() {
                    let _ = child.kill();
                    return Err("Codex 额度服务不可用".into());
                }
                responses.insert(
                    2,
                    message.get("result").cloned().unwrap_or_else(|| json!({})),
                );
            }
            Some(3) => {
                responses.insert(
                    3,
                    if message.get("error").is_some() { json!({}) } else { message.get("result").cloned().unwrap_or_else(|| json!({})) },
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

fn unavailable(id: &str, name: &str, message: String, daily_usage: Vec<DailyUsage>) -> ProviderUsage {
    ProviderUsage {
        id: id.into(), name: name.into(), status: "unavailable".into(), source: "local".into(),
        updated_at: Utc::now().to_rfc3339(), plan_type: None, limits: vec![], balances: vec![], daily_usage,
        message: Some(message),
    }
}

fn read_codex() -> ProviderUsage {
    let executable = candidates()
        .into_iter()
        .find(|value| !value.components().skip(1).next().is_some() || fs::metadata(value).is_ok());
    if let Some(executable) = executable {
        if let Ok((rate, usage)) = app_server(&executable) {
            return normalize(rate, usage);
        }
    }
    unavailable("codex", "ChatGPT / Codex", "官方额度暂不可用；图表为本地估算".into(), local_daily())
}

fn find_rate_limits(value: &Value, depth: usize) -> Option<&Value> {
    if depth > 7 { return None; }
    if let Some(candidate) = field(value, "rateLimits", "rate_limits") {
        if ["five_hour", "fiveHour", "seven_day", "sevenDay"].iter().any(|key| candidate.get(key).is_some()) {
            return Some(candidate);
        }
    }
    value.as_object()?.values().find_map(|child| find_rate_limits(child, depth + 1))
}

fn claude_limits(raw: &Value) -> Vec<Limit> {
    [("five_hour", "fiveHour", "Claude · 5 小时额度", 300.0), ("seven_day", "sevenDay", "Claude · 每周额度", 10080.0)]
        .into_iter()
        .filter_map(|(snake, camel, label, duration)| {
            let window = raw.get(snake).or_else(|| raw.get(camel))?;
            let used = number(field(window, "usedPercent", "used_percentage")).unwrap_or(0.0).clamp(0.0, 100.0);
            Some(Limit {
                id: format!("claude:{snake}"), name: "Claude".into(), label: label.into(), used_percent: used,
                remaining_percent: 100.0 - used, window_duration_mins: Some(duration),
                resets_at: field(window, "resetsAt", "resets_at").and_then(Value::as_i64),
            })
        })
        .collect()
}

fn claude_daily() -> Vec<DailyUsage> {
    let mut raw = vec![];
    let root = dirs_home().join(".claude/projects");
    for entry in WalkDir::new(root).max_depth(6).into_iter().filter_map(Result::ok) {
        if entry.path().extension().and_then(|value| value.to_str()) != Some("jsonl") { continue; }
        let Ok(file) = File::open(entry.path()) else { continue; };
        for line in BufReader::new(file).lines().map_while(Result::ok).filter(|line| line.contains("usage")) {
            let Ok(value) = serde_json::from_str::<Value>(&line) else { continue; };
            let usage = value.pointer("/message/usage").or_else(|| value.get("usage"));
            let tokens: u64 = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]
                .into_iter().map(|key| usage.and_then(|item| item.get(key)).and_then(Value::as_u64).unwrap_or(0)).sum();
            let date = value.get("timestamp").and_then(Value::as_str)
                .and_then(|text| NaiveDate::parse_from_str(&text[..text.len().min(10)], "%Y-%m-%d").ok());
            if tokens > 0 { if let Some(date) = date { raw.push((date, tokens)); } }
        }
    }
    seven_days(raw)
}

fn dirs_home() -> PathBuf {
    env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from).unwrap_or_default()
}

fn read_claude() -> ProviderUsage {
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = vec![];
    let root = dirs_home().join(".claude");
    for entry in WalkDir::new(&root).max_depth(6).into_iter().filter_map(Result::ok) {
        let extension = entry.path().extension().and_then(|value| value.to_str()).unwrap_or("");
        if !entry.file_type().is_file() || !matches!(extension, "json" | "jsonl") { continue; }
        let Ok(metadata) = entry.metadata() else { continue; };
        if metadata.len() > 2 * 1024 * 1024 { continue; }
        files.push((metadata.modified().unwrap_or(std::time::UNIX_EPOCH), entry.path().to_path_buf()));
    }
    files.sort_by(|left, right| right.0.cmp(&left.0));
    let mut limits = vec![];
    'files: for (_, path) in files.into_iter().take(1200) {
        let Ok(content) = fs::read_to_string(&path) else { continue; };
        let candidates: Vec<&str> = if path.extension().and_then(|value| value.to_str()) == Some("jsonl") {
            content.lines().rev().take(80).collect()
        } else { vec![content.as_str()] };
        for candidate in candidates {
            let Ok(value) = serde_json::from_str::<Value>(candidate) else { continue; };
            if let Some(raw) = find_rate_limits(&value, 0) {
                limits = claude_limits(raw);
                if !limits.is_empty() { break 'files; }
            }
        }
    }
    let available = !limits.is_empty();
    ProviderUsage {
        id: "claude".into(), name: "Claude".into(), status: if limits.is_empty() { "unavailable" } else { "ok" }.into(),
        source: if limits.is_empty() { "local" } else { "claude-statusline" }.into(), updated_at: Utc::now().to_rfc3339(),
        plan_type: None, limits, balances: vec![], daily_usage: claude_daily(),
        message: Some(if available { "来自 Claude 官方状态栏的最近额度快照" } else if files_are_available(&root) { "Claude 桌面端暂无公开额度接口；可读取 Claude Code 官方状态栏快照" } else { "未找到 Claude 客户端用量数据" }.into()),
    }
}

fn files_are_available(path: &Path) -> bool { path.exists() }

fn yaml_scalar(value: &str) -> String {
    let value = value.trim();
    if value.len() >= 2 && ((value.starts_with('"') && value.ends_with('"')) || (value.starts_with('\'') && value.ends_with('\''))) {
        value[1..value.len() - 1].to_string()
    } else { value.to_string() }
}

fn deepseek_credential() -> Option<(String, String)> {
    let root = env::var_os("DSH_HOME").map(PathBuf::from).unwrap_or_else(|| dirs_home().join(".dsh"));
    let text = fs::read_to_string(root.join(".credentials.yaml")).ok()?;
    let mut active = false;
    let mut token = None;
    let mut issuer = None;
    for line in text.lines() {
        if line == "  deepseek-account-platform/default:" { active = true; continue; }
        if active && line.starts_with("  ") && !line.starts_with("    ") { break; }
        if !active { continue; }
        let trimmed = line.trim();
        if let Some(value) = trimmed.strip_prefix("token:") { token = Some(yaml_scalar(value)); }
        if let Some(value) = trimmed.strip_prefix("issuer:") { issuer = Some(yaml_scalar(value)); }
    }
    let issuer = issuer?.trim_end_matches('/').to_string();
    if !issuer.starts_with("https://") || issuer[8..].contains('/') { return None; }
    Some((token?, issuer))
}

fn deepseek_daily() -> Vec<DailyUsage> {
    let root = env::var_os("DSH_HOME").map(PathBuf::from).unwrap_or_else(|| dirs_home().join(".dsh"))
        .join("storages/session_projcache/sessions");
    let mut raw = vec![];
    let Ok(entries) = fs::read_dir(root) else { return seven_days(raw); };
    for entry in entries.filter_map(Result::ok) {
        let Ok(value) = fs::read_to_string(entry.path()).ok().and_then(|text| serde_json::from_str::<Value>(&text).ok()).ok_or(()) else { continue; };
        let tokens: u64 = ["uncachedInputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"].into_iter()
            .map(|key| value.pointer(&format!("/record/rows/tokenUsage/val/totals/{key}")).and_then(Value::as_u64).unwrap_or(0)).sum();
        let date = value.pointer("/record/identity/createdAt").and_then(Value::as_i64)
            .and_then(chrono::DateTime::<Utc>::from_timestamp_millis).map(|date| date.date_naive());
        if tokens > 0 { if let Some(date) = date { raw.push((date, tokens)); } }
    }
    seven_days(raw)
}

fn read_deepseek() -> ProviderUsage {
    let daily = deepseek_daily();
    let Some((token, issuer)) = deepseek_credential() else {
        return unavailable("deepseek", "DeepSeek Harness", "未找到 DeepSeek Harness 登录信息".into(), daily);
    };
    let response = ureq::get(&format!("{issuer}/api/v0/users/get_user_summary"))
        .set("x-dsh-auth-token", &token)
        .set("x-client-platform", if cfg!(windows) { "desktop-win" } else { "desktop-mac" })
        .set("x-client-version", "1.4.0")
        .set("x-client-locale", "zh_CN")
        .timeout(Duration::from_secs(8)).call();
    let Ok(response) = response else {
        return unavailable("deepseek", "DeepSeek Harness", "DeepSeek 余额暂不可用".into(), daily);
    };
    let Ok(value) = response.into_json::<Value>() else {
        return unavailable("deepseek", "DeepSeek Harness", "DeepSeek 余额响应格式不兼容".into(), daily);
    };
    let Some(data) = value.pointer("/data/biz_data").filter(|_| value.get("code").and_then(Value::as_i64) == Some(0) && value.pointer("/data/biz_code").and_then(Value::as_i64) == Some(0)) else {
        return unavailable("deepseek", "DeepSeek Harness", "DeepSeek 余额响应格式不兼容".into(), daily);
    };
    let mut balances: BTreeMap<String, Balance> = BTreeMap::new();
    for (field_name, bonus) in [("normal_wallets", false), ("bonus_wallets", true)] {
        for row in data.get(field_name).and_then(Value::as_array).into_iter().flatten() {
            let currency = row.get("currency").and_then(Value::as_str).unwrap_or("").to_string();
            if currency.is_empty() { continue; }
            let amount = row.get("balance").and_then(Value::as_str).and_then(|value| value.parse::<f64>().ok()).unwrap_or(0.0);
            let entry = balances.entry(currency.clone()).or_insert(Balance { currency, total: 0.0, normal: 0.0, bonus: 0.0 });
            if bonus { entry.bonus += amount; } else { entry.normal += amount; }
            entry.total = entry.normal + entry.bonus;
        }
    }
    ProviderUsage {
        id: "deepseek".into(), name: "DeepSeek Harness".into(), status: if balances.is_empty() { "unavailable" } else { "ok" }.into(),
        source: "deepseek-account".into(), updated_at: Utc::now().to_rfc3339(), plan_type: None, limits: vec![],
        balances: balances.into_values().collect(), daily_usage: daily,
        message: Some("来自 DeepSeek Harness 官方账户余额".into()),
    }
}

pub fn read() -> UsageSnapshot {
    let providers = vec![read_codex(), read_claude(), read_deepseek()];
    let primary = providers[0].clone();
    UsageSnapshot {
        status: primary.status, source: primary.source, updated_at: primary.updated_at, plan_type: primary.plan_type,
        limits: primary.limits, balances: primary.balances, daily_usage: primary.daily_usage, message: primary.message, providers,
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

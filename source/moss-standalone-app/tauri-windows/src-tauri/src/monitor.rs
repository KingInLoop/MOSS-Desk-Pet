use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    env,
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, SystemTime},
};
use walkdir::WalkDir;

const MAX_INITIAL_BYTES: u64 = 2 * 1024 * 1024;
const LOOKBACK: Duration = Duration::from_secs(48 * 60 * 60);
const COMPLETED_RETENTION_MS: i64 = 5 * 60 * 1000;
const MAX_RECENT_COMPLETED: usize = 20;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicTask {
    pub id: String,
    pub turn_id: Option<String>,
    pub title: String,
    pub workspace: Option<String>,
    pub cwd: Option<String>,
    pub source: String,
    pub started_at: Option<String>,
    pub status: &'static str,
    pub completed_at: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub active_count: usize,
    pub source: Option<String>,
    pub tasks: Vec<PublicTask>,
    pub recent_retention_ms: i64,
}

#[derive(Clone, Debug)]
pub enum MonitorEvent {
    Ready(Snapshot),
    Started {
        snapshot: Snapshot,
        source: String,
        task: PublicTask,
    },
    Completed {
        snapshot: Snapshot,
        source: String,
        task: Option<PublicTask>,
    },
    Interrupted {
        snapshot: Snapshot,
        source: String,
        task: Option<PublicTask>,
        kind: String,
    },
    Cancelled {
        snapshot: Snapshot,
        source: String,
        task: Option<PublicTask>,
    },
}

#[derive(Clone, Debug, Default)]
struct FileState {
    offset: u64,
    remainder: String,
    source: String,
    ignored: bool,
    session_id: Option<String>,
    cwd: Option<String>,
    initialized: bool,
}

#[derive(Clone, Debug)]
struct ActiveTask {
    source: String,
    file_path: PathBuf,
    session_id: Option<String>,
    cwd: Option<String>,
    turn_id: Option<String>,
    started_at: Option<String>,
}

#[derive(Clone, Debug)]
struct CompletedTask {
    task: ActiveTask,
    completed_at: String,
    completed_at_ms: i64,
}

#[derive(Clone, Debug)]
enum ParsedEvent {
    SessionMeta {
        source: String,
        ignored: bool,
        session_id: Option<String>,
        cwd: Option<String>,
    },
    Started {
        turn_id: Option<String>,
        timestamp: Option<String>,
    },
    Completed {
        turn_id: Option<String>,
        timestamp: Option<String>,
    },
    Interrupted {
        turn_id: Option<String>,
        kind: String,
    },
    Cancelled {
        turn_id: Option<String>,
    },
}

struct TitleIndex {
    path: PathBuf,
    connection: Option<Connection>,
}

impl TitleIndex {
    fn new(codex_home: &Path) -> Self {
        Self {
            path: codex_home.join("state_5.sqlite"),
            connection: None,
        }
    }

    fn title_for(&mut self, session_id: Option<&str>) -> Option<String> {
        let session_id = session_id?;
        if self.connection.is_none() {
            self.connection = Connection::open_with_flags(
                &self.path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .ok();
        }
        let connection = self.connection.as_ref()?;
        connection.query_row(
            "SELECT COALESCE(NULLIF(name, ''), NULLIF(title, ''), '') FROM threads WHERE id = ?1 LIMIT 1",
            [session_id],
            |row| row.get::<_, String>(0),
        ).ok().filter(|title| !title.trim().is_empty())
    }
}

struct Monitor {
    codex_home: PathBuf,
    sessions_root: PathBuf,
    files: HashMap<PathBuf, FileState>,
    active: HashMap<String, ActiveTask>,
    recent_completed: HashMap<String, CompletedTask>,
    last_source: Option<String>,
    titles: TitleIndex,
}

impl Monitor {
    fn new(codex_home: PathBuf) -> Self {
        Self {
            sessions_root: codex_home.join("sessions"),
            titles: TitleIndex::new(&codex_home),
            codex_home,
            files: HashMap::new(),
            active: HashMap::new(),
            recent_completed: HashMap::new(),
            last_source: None,
        }
    }

    fn task_id(task: &ActiveTask) -> String {
        task.session_id
            .clone()
            .or_else(|| task.turn_id.clone())
            .unwrap_or_else(|| {
                task.file_path
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned()
            })
    }

    fn public_task(
        &mut self,
        task: &ActiveTask,
        status: &'static str,
        completed_at: Option<String>,
    ) -> PublicTask {
        let workspace = task.cwd.as_ref().and_then(|cwd| {
            Path::new(cwd)
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
        });
        let mut title = self
            .titles
            .title_for(task.session_id.as_deref())
            .or_else(|| workspace.clone())
            .unwrap_or_else(|| "未命名对话".into());
        title = title.split_whitespace().collect::<Vec<_>>().join(" ");
        title.truncate(96);
        PublicTask {
            id: Self::task_id(task),
            turn_id: task.turn_id.clone(),
            title,
            workspace,
            cwd: task.cwd.clone(),
            source: task.source.clone(),
            started_at: task.started_at.clone(),
            status,
            completed_at,
        }
    }

    fn snapshot(&mut self) -> Snapshot {
        self.prune_recent_completed();
        let active = self.active.values().cloned().collect::<Vec<_>>();
        let active_ids = active
            .iter()
            .map(Self::task_id)
            .collect::<std::collections::HashSet<_>>();
        let mut completed = self
            .recent_completed
            .values()
            .filter(|entry| !active_ids.contains(&Self::task_id(&entry.task)))
            .cloned()
            .collect::<Vec<_>>();
        completed.sort_by(|left, right| right.completed_at_ms.cmp(&left.completed_at_ms));
        completed.truncate(MAX_RECENT_COMPLETED);
        let mut tasks = active
            .iter()
            .map(|task| self.public_task(task, "running", None))
            .collect::<Vec<_>>();
        tasks.extend(completed.iter().map(|entry| {
            self.public_task(&entry.task, "completed", Some(entry.completed_at.clone()))
        }));
        Snapshot {
            active_count: active.len(),
            source: self.last_source.clone(),
            tasks,
            recent_retention_ms: COMPLETED_RETENTION_MS,
        }
    }

    fn prune_recent_completed(&mut self) {
        let cutoff = now_ms() - COMPLETED_RETENTION_MS;
        self.recent_completed
            .retain(|_, completed| completed.completed_at_ms >= cutoff);
    }

    fn remember_completed(
        &mut self,
        key: String,
        task: ActiveTask,
        timestamp: Option<String>,
    ) -> String {
        let completed_at_ms = timestamp
            .as_deref()
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
            .map(|value| value.timestamp_millis())
            .unwrap_or_else(now_ms);
        let completed_at = timestamp.unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
        if completed_at_ms >= now_ms() - COMPLETED_RETENTION_MS {
            self.recent_completed.insert(
                key,
                CompletedTask {
                    task,
                    completed_at: completed_at.clone(),
                    completed_at_ms,
                },
            );
            self.prune_recent_completed();
        }
        completed_at
    }

    fn recent_files(&self) -> Vec<PathBuf> {
        let cutoff = SystemTime::now()
            .checked_sub(LOOKBACK)
            .unwrap_or(SystemTime::UNIX_EPOCH);
        WalkDir::new(&self.sessions_root)
            .max_depth(5)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry.file_type().is_file()
                    && entry.path().extension().is_some_and(|ext| ext == "jsonl")
            })
            .filter(|entry| {
                entry
                    .metadata()
                    .ok()
                    .and_then(|meta| meta.modified().ok())
                    .is_some_and(|time| time >= cutoff)
            })
            .map(|entry| entry.into_path())
            .collect()
    }

    fn scan<F: FnMut(MonitorEvent)>(&mut self, initializing: bool, mut emit: F) {
        for path in self.recent_files() {
            self.read_file(&path, initializing, &mut emit);
        }
    }

    fn read_file<F: FnMut(MonitorEvent)>(&mut self, path: &Path, initializing: bool, emit: &mut F) {
        let size = match fs::metadata(path) {
            Ok(meta) => meta.len(),
            Err(_) => return,
        };
        if !self.files.contains_key(path) {
            let identity = read_identity(path, size);
            self.files.insert(
                path.to_path_buf(),
                FileState {
                    offset: size.saturating_sub(MAX_INITIAL_BYTES),
                    source: identity.0,
                    ignored: identity.1,
                    session_id: identity.2,
                    cwd: identity.3,
                    ..FileState::default()
                },
            );
        }

        let state = self.files.get_mut(path).expect("file state inserted");
        if size < state.offset {
            state.offset = 0;
            state.remainder.clear();
        }
        if size == state.offset {
            return;
        }
        let start = state.offset;
        let mut file = match File::open(path) {
            Ok(file) => file,
            Err(_) => return,
        };
        if file.seek(SeekFrom::Start(start)).is_err() {
            return;
        }
        let mut bytes = Vec::with_capacity((size - start) as usize);
        if file.read_to_end(&mut bytes).is_err() {
            return;
        }
        state.offset = size;
        let mut text = std::mem::take(&mut state.remainder) + &String::from_utf8_lossy(&bytes);
        if !state.initialized && start > 0 {
            text = text
                .split_once('\n')
                .map(|(_, tail)| tail.to_string())
                .unwrap_or_default();
        }
        let ended_with_newline = text.ends_with('\n');
        let mut lines = text.split('\n').map(str::to_owned).collect::<Vec<_>>();
        if ended_with_newline {
            lines.pop();
        } else {
            state.remainder = lines.pop().unwrap_or_default();
        }
        let should_emit = !initializing;
        state.initialized = true;

        for line in lines {
            if !line.contains("session_meta")
                && !line.contains("task_started")
                && !line.contains("task_complete")
                && !line.contains("turn_aborted")
                && !line.contains("task_cancelled")
            {
                continue;
            }
            let Some(event) = serde_json::from_str::<Value>(&line)
                .ok()
                .and_then(|value| parse_event(&value))
            else {
                continue;
            };
            self.consume(path, event, should_emit, emit);
        }
    }

    fn consume<F: FnMut(MonitorEvent)>(
        &mut self,
        path: &Path,
        event: ParsedEvent,
        should_emit: bool,
        emit: &mut F,
    ) {
        if let ParsedEvent::SessionMeta {
            source,
            ignored,
            session_id,
            cwd,
        } = event
        {
            if let Some(state) = self.files.get_mut(path) {
                state.source = source;
                state.ignored = ignored;
                state.session_id = session_id;
                state.cwd = cwd;
            }
            return;
        }
        let Some(state) = self.files.get(path).cloned() else {
            return;
        };
        if state.ignored {
            return;
        }
        let (turn_id, kind) = match &event {
            ParsedEvent::Started { turn_id, .. } => (turn_id.clone(), "started"),
            ParsedEvent::Completed { turn_id, .. } => (turn_id.clone(), "completed"),
            ParsedEvent::Interrupted { turn_id, .. } => (turn_id.clone(), "interrupted"),
            ParsedEvent::Cancelled { turn_id } => (turn_id.clone(), "cancelled"),
            ParsedEvent::SessionMeta { .. } => unreachable!(),
        };
        let key = format!(
            "{}:{}",
            path.display(),
            turn_id.as_deref().unwrap_or("latest")
        );
        self.last_source = Some(state.source.clone());

        match event {
            ParsedEvent::Started { turn_id, timestamp } => {
                let task = ActiveTask {
                    source: state.source.clone(),
                    file_path: path.to_path_buf(),
                    session_id: state.session_id,
                    cwd: state.cwd,
                    turn_id,
                    started_at: timestamp,
                };
                let task_id = Self::task_id(&task);
                self.recent_completed
                    .retain(|_, completed| Self::task_id(&completed.task) != task_id);
                self.active.insert(key, task.clone());
                if should_emit {
                    let public = self.public_task(&task, "running", None);
                    let snapshot = self.snapshot();
                    emit(MonitorEvent::Started {
                        snapshot,
                        source: state.source,
                        task: public,
                    });
                }
            }
            ParsedEvent::Completed { timestamp, .. } => {
                let task = self.active.remove(&key);
                let public = task.map(|task| {
                    let completed_at =
                        self.remember_completed(key.clone(), task.clone(), timestamp);
                    self.public_task(&task, "completed", Some(completed_at))
                });
                if should_emit {
                    emit(MonitorEvent::Completed {
                        snapshot: self.snapshot(),
                        source: state.source,
                        task: public,
                    });
                }
            }
            ParsedEvent::Interrupted {
                kind: interruption_kind,
                ..
            } => {
                let task = self
                    .active
                    .remove(&key)
                    .map(|task| self.public_task(&task, "running", None));
                if should_emit {
                    emit(MonitorEvent::Interrupted {
                        snapshot: self.snapshot(),
                        source: state.source,
                        task,
                        kind: interruption_kind,
                    });
                }
            }
            ParsedEvent::Cancelled { .. } => {
                let task = self
                    .active
                    .remove(&key)
                    .map(|task| self.public_task(&task, "running", None));
                if should_emit {
                    emit(MonitorEvent::Cancelled {
                        snapshot: self.snapshot(),
                        source: state.source,
                        task,
                    });
                }
            }
            ParsedEvent::SessionMeta { .. } => unreachable!(),
        }
        let _ = kind;
    }
}

fn string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_owned)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn source(originator: Option<&str>) -> String {
    let normalized = originator.unwrap_or_default().to_ascii_lowercase();
    if normalized.contains("desktop") {
        "desktop".into()
    } else if normalized.contains("vscode") {
        "vscode".into()
    } else {
        "codex".into()
    }
}

fn parse_event(record: &Value) -> Option<ParsedEvent> {
    let record_type = record.get("type")?.as_str()?;
    let payload = record.get("payload")?;
    if record_type == "session_meta" {
        let ignored = payload
            .get("source")
            .and_then(Value::as_object)
            .is_some_and(|source| source.contains_key("subagent"));
        return Some(ParsedEvent::SessionMeta {
            source: if ignored {
                "ignored".into()
            } else {
                source(payload.get("originator").and_then(Value::as_str))
            },
            ignored,
            session_id: string(payload.get("id").or_else(|| payload.get("session_id"))),
            cwd: string(payload.get("cwd")),
        });
    }
    if record_type != "event_msg" {
        return None;
    }
    let event_type = payload.get("type")?.as_str()?;
    let turn_id = string(payload.get("turn_id"));
    match event_type {
        "task_started" => Some(ParsedEvent::Started {
            turn_id,
            timestamp: string(record.get("timestamp")),
        }),
        "task_complete" if payload.get("error").is_some_and(|error| !error.is_null()) => {
            Some(ParsedEvent::Interrupted {
                turn_id,
                kind: classify_error(payload.get("error").unwrap()),
            })
        }
        "task_complete" => Some(ParsedEvent::Completed {
            turn_id,
            timestamp: string(record.get("timestamp")),
        }),
        "turn_aborted" | "task_cancelled" => Some(ParsedEvent::Cancelled { turn_id }),
        _ => None,
    }
}

fn classify_error(error: &Value) -> String {
    let text = error.to_string().to_ascii_lowercase();
    let includes = |needles: &[&str]| needles.iter().any(|needle| text.contains(needle));
    if includes(&[
        "network",
        "connection",
        "connect",
        "disconnect",
        "stream",
        "socket",
        "timeout",
        "dns",
        "tls",
        "offline",
        "fetch failed",
        "request failed",
    ]) {
        "network"
    } else if includes(&[
        "unauthor",
        "forbidden",
        "authentication",
        "credential",
        "api key",
    ]) {
        "authentication"
    } else if includes(&["rate limit", "too many requests", "quota"]) {
        "rate-limit"
    } else if includes(&[
        "service unavailable",
        "server error",
        "internal error",
        "bad gateway",
        "gateway timeout",
    ]) {
        "service"
    } else {
        "unknown"
    }
    .into()
}

fn read_identity(path: &Path, size: u64) -> (String, bool, Option<String>, Option<String>) {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(_) => return ("codex".into(), false, None, None),
    };
    let mut bytes = vec![0; size.min(64 * 1024) as usize];
    if file.read_exact(&mut bytes).is_err() {
        return ("codex".into(), false, None, None);
    }
    for line in String::from_utf8_lossy(&bytes).split('\n') {
        if !line.contains("session_meta") {
            continue;
        }
        if let Some(ParsedEvent::SessionMeta {
            source,
            ignored,
            session_id,
            cwd,
        }) = serde_json::from_str::<Value>(line)
            .ok()
            .and_then(|value| parse_event(&value))
        {
            return (source, ignored, session_id, cwd);
        }
    }
    ("codex".into(), false, None, None)
}

pub fn codex_home() -> PathBuf {
    if let Some(value) = env::var_os("CODEX_HOME") {
        return PathBuf::from(value);
    }
    env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_default()
        .join(".codex")
}

pub fn run<F>(stop: Arc<AtomicBool>, mut emit: F)
where
    F: FnMut(MonitorEvent),
{
    let mut monitor = Monitor::new(codex_home());
    let _ = &monitor.codex_home;
    monitor.scan(true, |_| {});
    emit(MonitorEvent::Ready(monitor.snapshot()));
    while !stop.load(Ordering::Relaxed) {
        thread::sleep(Duration::from_millis(900));
        monitor.scan(false, &mut emit);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn recognizes_normal_and_network_completion() {
        assert!(matches!(
            parse_event(&json!({"type":"event_msg","payload":{"type":"task_complete"}})),
            Some(ParsedEvent::Completed { .. })
        ));
        assert!(
            matches!(parse_event(&json!({"type":"event_msg","payload":{"type":"task_complete","error":{"message":"connection timeout"}}})), Some(ParsedEvent::Interrupted { kind, .. }) if kind == "network")
        );
    }

    #[test]
    fn distinguishes_desktop_vscode_and_subagents() {
        assert!(
            matches!(parse_event(&json!({"type":"session_meta","payload":{"originator":"Codex Desktop"}})), Some(ParsedEvent::SessionMeta { source, ignored: false, .. }) if source == "desktop")
        );
        assert!(
            matches!(parse_event(&json!({"type":"session_meta","payload":{"originator":"codex_vscode"}})), Some(ParsedEvent::SessionMeta { source, ignored: false, .. }) if source == "vscode")
        );
        assert!(matches!(
            parse_event(&json!({"type":"session_meta","payload":{"source":{"subagent":"x"}}})),
            Some(ParsedEvent::SessionMeta { ignored: true, .. })
        ));
    }

    #[test]
    fn recently_completed_tasks_expire_after_five_minutes() {
        let root = std::env::temp_dir().join("moss-recent-completed-test");
        let mut monitor = Monitor::new(root.clone());
        monitor.recent_completed.insert(
            "task".into(),
            CompletedTask {
                task: ActiveTask {
                    source: "desktop".into(),
                    file_path: root.join("task.jsonl"),
                    session_id: Some("thread-1".into()),
                    cwd: None,
                    turn_id: Some("turn-1".into()),
                    started_at: None,
                },
                completed_at: chrono::Utc::now().to_rfc3339(),
                completed_at_ms: now_ms(),
            },
        );
        let snapshot = monitor.snapshot();
        assert_eq!(snapshot.active_count, 0);
        assert_eq!(snapshot.tasks.len(), 1);
        assert_eq!(snapshot.tasks[0].status, "completed");
        monitor
            .recent_completed
            .get_mut("task")
            .unwrap()
            .completed_at_ms = now_ms() - COMPLETED_RETENTION_MS - 1;
        assert!(monitor.snapshot().tasks.is_empty());
    }
}

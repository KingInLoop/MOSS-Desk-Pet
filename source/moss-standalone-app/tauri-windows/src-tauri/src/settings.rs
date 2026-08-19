use serde::{Deserialize, Serialize};
use std::{fs, path::Path};

pub const SCALES: [f64; 5] = [0.55, 0.65, 0.75, 0.875, 1.0];
pub const EYE_COLORS: [&str; 6] = ["default", "cyan", "blue", "amber", "violet", "green"];
pub const TRAY_ICON_MODES: [&str; 3] = ["auto", "light", "dark"];

fn default_tray_icon_mode() -> String {
    "auto".into()
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub skin: String,
    pub eye_color: String,
    pub scale: f64,
    pub always_on_top: bool,
    pub notifications: bool,
    pub launch_at_login: bool,
    pub show_status_badge: bool,
    #[serde(default = "default_true")]
    pub click_pet_for_usage: bool,
    #[serde(default = "default_tray_icon_mode")]
    pub tray_icon_mode: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            skin: "dark".into(),
            eye_color: "default".into(),
            scale: 0.75,
            always_on_top: true,
            notifications: true,
            launch_at_login: false,
            show_status_badge: true,
            click_pet_for_usage: true,
            tray_icon_mode: default_tray_icon_mode(),
        }
    }
}

impl Settings {
    pub fn normalize(mut self) -> Self {
        if self.skin != "dark" && self.skin != "light" {
            self.skin = "dark".into();
        }
        if !EYE_COLORS.contains(&self.eye_color.as_str()) {
            self.eye_color = "default".into();
        }
        if !SCALES
            .iter()
            .any(|value| (value - self.scale).abs() < f64::EPSILON)
        {
            self.scale = 0.75;
        }
        if !TRAY_ICON_MODES.contains(&self.tray_icon_mode.as_str()) {
            self.tray_icon_mode = default_tray_icon_mode();
        }
        self
    }
}

pub fn read(path: &Path) -> Settings {
    fs::read_to_string(path)
        .ok()
        .and_then(|value| serde_json::from_str::<Settings>(&value).ok())
        .map(Settings::normalize)
        .unwrap_or_default()
}

pub fn write(path: &Path, settings: &Settings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let json = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    fs::write(path, format!("{json}\n")).map_err(|error| error.to_string())
}

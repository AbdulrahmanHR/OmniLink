//! Tauri command handlers.
//!
//! Each submodule exposes #[tauri::command] functions that the frontend
//! can invoke via `@tauri-apps/api`. Organized by domain per §4.2.

pub mod ai;
pub mod bridge;
pub mod config;
pub mod device;
pub mod flash;
pub mod knowledge;
pub mod logs;
pub mod secret_store;
pub mod telemetry;
pub mod tiles;
pub mod wifi;

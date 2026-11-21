use crate::file_service;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri_plugin_dialog::DialogExt;

const MAX_OUTPUT: u64 = 80 * 1024 * 1024;

#[derive(Serialize)]
pub struct SavedWord { path: String }
fn validate_markdown_docx(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() as u64 > MAX_OUTPUT || !bytes.starts_with(b"PK") { return Err("올바르지 않거나 너무 큰 Word 문서입니다".into()); }
    Ok(())
}
fn markdown_docx_name(suggested: &str) -> PathBuf {
    let name = Path::new(suggested).file_name().filter(|n| !n.is_empty()).unwrap_or_else(|| std::ffi::OsStr::new("Untitled"));
    Path::new(name).with_extension("docx")
}
#[tauri::command]
pub async fn save_docx_as(bytes: Vec<u8>, suggested_name: String, app: tauri::AppHandle) -> Result<Option<SavedWord>, String> {
    validate_markdown_docx(&bytes)?;
    tauri::async_runtime::spawn_blocking(move || {
        let name = markdown_docx_name(&suggested_name);
        let Some(file) = app.dialog().file().add_filter("Word 문서", &["docx"]).set_file_name(name.to_string_lossy()).blocking_save_file() else { return Ok(None); };
        let path = file_service::validate_docx_save_path(&file.into_path().map_err(|e| e.to_string())?)?;
        let path = file_service::write_docx_atomic(&path, &bytes)?;
        Ok(Some(SavedWord { path: path.to_string_lossy().into_owned() }))
    }).await.map_err(|e| format!("Word 저장 실패: {e}"))?
}

#[cfg(test)]
#[path = "docx_export_tests.rs"]
mod tests;

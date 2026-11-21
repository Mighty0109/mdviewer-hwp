mod docx_export;
mod e2e;
mod file_service;
mod instance;
mod pending;
mod watcher;

use file_service::{MarkdownFile, SavedHwpx, SavedImportedMarkdown, SavedMarkdown};
use pending::PendingFiles;
use serde::Serialize;
use std::{path::Path, sync::Mutex};
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use watcher::FileWatch;

#[derive(Default)]
struct AppState {
    pending: Mutex<PendingFiles>,
    watch: Mutex<Option<FileWatch>>,
    last_read: Mutex<Option<(String, String)>>,
    document: Mutex<DocumentState>,
    e2e: Option<e2e::E2eConfig>,
}

#[derive(Default)]
struct DocumentState {
    title: Option<String>,
    dirty: bool,
    quit_requested: bool,
}

impl DocumentState {
    fn set_dirty(&mut self, dirty: bool) {
        if dirty && !self.dirty {
            self.quit_requested = false;
        }
        self.dirty = dirty;
    }

    fn request_close(&mut self, quit_requested: bool) -> bool {
        if self.dirty {
            self.quit_requested = quit_requested;
        }
        self.dirty
    }

    fn window_title(&self) -> String {
        format!(
            "{}{}",
            if self.dirty { "● " } else { "" },
            self.title.as_deref().unwrap_or("MDViewer")
        )
    }
}

fn set_document_title(app: &tauri::AppHandle, state: &AppState, path: &Path) -> Result<(), String> {
    let title = {
        let mut document = state
            .document
            .lock()
            .map_err(|_| "Document state is unavailable")?;
        document.title = path.file_name().and_then(|s| s.to_str()).map(str::to_owned);
        document.window_title()
    };
    if let Some(window) = app.get_webview_window("main") {
        window
            .set_title(&title)
            .map_err(|e| format!("Cannot set window title: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
fn take_pending_files(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    Ok(state
        .pending
        .lock()
        .map_err(|_| "Open request state is unavailable")?
        .take())
}

#[tauri::command]
fn read_markdown(
    path: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<MarkdownFile, String> {
    let file = file_service::read_markdown(Path::new(&path))?;
    let canonical = Path::new(&file.path);
    let parent = canonical
        .parent()
        .ok_or("The document has no parent directory")?;
    app.asset_protocol_scope()
        .allow_directory(parent, true)
        .map_err(|e| format!("Cannot allow document images: {e}"))?;
    set_document_title(&app, &state, canonical)?;
    *state
        .last_read
        .lock()
        .map_err(|_| "Document state is unavailable")? =
        Some((file.path.clone(), file.hash.clone()));
    Ok(file)
}

#[tauri::command]
fn write_markdown(
    path: String,
    content: String,
    expected_hash: String,
    state: State<'_, AppState>,
) -> Result<SavedMarkdown, String> {
    let canonical = file_service::validate_path(Path::new(&path))?;
    let watch = state
        .watch
        .lock()
        .map_err(|_| "File watcher state is unavailable")?;
    let baseline = watch
        .as_ref()
        .and_then(|watch| watch.baseline_for(&canonical));
    let mut last_read = state
        .last_read
        .lock()
        .map_err(|_| "Document state is unavailable")?;
    let saved = file_service::write_markdown(Path::new(&path), &content, &expected_hash, baseline)?;
    *last_read = Some((saved.path.clone(), saved.hash.clone()));
    Ok(saved)
}

#[tauri::command]
async fn save_markdown_as(
    content: String,
    suggested_name: String,
    previous_path: Option<String>,
    app: tauri::AppHandle,
) -> Result<Option<SavedMarkdown>, String> {
    file_service::validate_content(&content)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app
            .dialog()
            .file()
            .add_filter("Markdown", &["md", "markdown", "mdown"])
            .set_file_name(
                Path::new(&suggested_name)
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("Untitled.md"),
            );
        if let Some(parent) = previous_path
            .as_deref()
            .and_then(|p| Path::new(p).parent())
            .filter(|p| p.is_absolute())
        {
            dialog = dialog.set_directory(parent);
        }
        let import_destination = app
            .state::<AppState>()
            .e2e
            .as_ref()
            .and_then(|c| c.import_save_as.clone());
        let path = if let Some(path) = import_destination {
            path.into()
        } else {
            let Some(selected) = dialog.blocking_save_file() else {
                return Ok(None);
            };
            selected
                .into_path()
                .map_err(|e| format!("Cannot resolve selected file: {e}"))?
        };
        let canonical = file_service::validate_save_path(&path)?;
        let parent = canonical
            .parent()
            .ok_or("The document has no parent directory")?;
        // Complete fallible scope setup before publishing bytes on disk.
        app.asset_protocol_scope()
            .allow_directory(parent, true)
            .map_err(|e| format!("Cannot allow document images: {e}"))?;
        let state = app.state::<AppState>();
        let saved = {
            let watch = state
                .watch
                .lock()
                .map_err(|_| "File watcher state is unavailable")?;
            let baseline = watch
                .as_ref()
                .and_then(|watch| watch.baseline_for(&canonical));
            let mut last_read = state
                .last_read
                .lock()
                .map_err(|_| "Document state is unavailable")?;
            let saved = file_service::save_markdown_as(&path, &content, baseline)?;
            *last_read = Some((saved.path.clone(), saved.hash.clone()));
            saved
        };
        // A title failure must not make a successful disk save look like a failed write.
        if let Err(error) = set_document_title(&app, &state, Path::new(&saved.path)) {
            eprintln!("{error}");
        }
        Ok(Some(saved))
    })
    .await
    .map_err(|e| format!("Cannot save document: {e}"))?
}

#[tauri::command]
async fn save_imported_markdown_as(
    request: tauri::ipc::Request<'_>,
    app: tauri::AppHandle,
) -> Result<Option<SavedImportedMarkdown>, String> {
    let tauri::ipc::InvokeBody::Raw(packet) = request.body() else {
        return Err("Imported assets require a binary IPC packet".into());
    };
    let (content, suggested_name, assets) = file_service::decode_import_packet(packet)?;
    let import_save_as = app
        .state::<AppState>()
        .e2e
        .as_ref()
        .and_then(|c| c.import_save_as.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let path = if let Some(path) = import_save_as {
            path.into()
        } else {
            let name = Path::new(&suggested_name)
                .file_name()
                .map(Path::new)
                .unwrap_or(Path::new("Untitled.md"))
                .with_extension("md");
            let Some(selected) = app
                .dialog()
                .file()
                .add_filter("Markdown", &["md"])
                .set_file_name(name.to_string_lossy())
                .blocking_save_file()
            else {
                return Ok(None);
            };
            selected
                .into_path()
                .map_err(|e| format!("Cannot resolve selected file: {e}"))?
        };
        let canonical = file_service::validate_save_path(&path)?;
        app.asset_protocol_scope()
            .allow_directory(
                canonical
                    .parent()
                    .ok_or("The document needs a parent directory")?,
                true,
            )
            .map_err(|e| format!("Cannot allow document images: {e}"))?;
        let state = app.state::<AppState>();
        let saved = {
            let watch = state
                .watch
                .lock()
                .map_err(|_| "File watcher state is unavailable")?;
            let baseline = watch
                .as_ref()
                .and_then(|watch| watch.baseline_for(&canonical));
            let mut last_read = state
                .last_read
                .lock()
                .map_err(|_| "Document state is unavailable")?;
            let saved =
                file_service::save_imported_markdown_as(&path, &content, &assets, baseline)?;
            *last_read = Some((saved.saved.path.clone(), saved.saved.hash.clone()));
            saved
        };
        if let Err(error) = set_document_title(&app, &state, Path::new(&saved.saved.path)) {
            eprintln!("{error}");
        }
        Ok(Some(saved))
    })
    .await
    .map_err(|e| format!("Cannot save imported document: {e}"))?
}

#[tauri::command]
fn set_document_dirty(
    dirty: bool,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let title = {
        let mut document = state
            .document
            .lock()
            .map_err(|_| "Document state is unavailable")?;
        document.set_dirty(dirty);
        document.window_title()
    };
    if let Some(window) = app.get_webview_window("main") {
        window
            .set_title(&title)
            .map_err(|e| format!("Cannot set window title: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
fn confirm_close(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let (was_dirty, quit_requested) = {
        let mut document = state
            .document
            .lock()
            .map_err(|_| "Document state is unavailable")?;
        let previous = (document.dirty, document.quit_requested);
        document.dirty = false;
        document.quit_requested = false;
        previous
    };
    if quit_requested {
        app.exit(0);
    } else if let Some(window) = app.get_webview_window("main") {
        if let Err(error) = window.close() {
            if let Ok(mut document) = state.document.lock() {
                document.dirty = was_dirty;
            }
            return Err(format!("Cannot close document window: {error}"));
        }
    }
    Ok(())
}

fn block_close(app: &tauri::AppHandle, quit_requested: bool) -> bool {
    let state = app.state::<AppState>();
    let blocked = match state.document.lock() {
        Ok(mut document) => document.request_close(quit_requested),
        Err(_) => true,
    };
    if blocked {
        if let Err(error) = app.emit("close-blocked", ()) {
            eprintln!("Cannot deliver close request: {error}");
        }
    }
    blocked
}

#[tauri::command]
fn watch_file(
    path: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let file = file_service::read_markdown(Path::new(&path))?;
    // Match the save lock order. A concurrently completed save must update
    // last_read before this watch chooses its initial baseline.
    let mut current = state
        .watch
        .lock()
        .map_err(|_| "File watcher state is unavailable")?;
    let baseline_hash = state
        .last_read
        .lock()
        .map_err(|_| "Document state is unavailable")?
        .as_ref()
        .filter(|(path, _)| path == &file.path)
        .map(|(_, hash)| hash.clone())
        .unwrap_or(file.hash);
    // Join the old worker before installing another one: no late events after replacement.
    current.take();
    *current = Some(FileWatch::start(
        file.path.into(),
        baseline_hash,
        move |event| {
            if let Err(error) = app.emit("file-changed", event) {
                eprintln!("Cannot deliver document change: {error}");
            }
        },
    )?);
    Ok(())
}

#[tauri::command]
fn unwatch_file(state: State<'_, AppState>) -> Result<(), String> {
    state
        .watch
        .lock()
        .map_err(|_| "File watcher state is unavailable")?
        .take();
    Ok(())
}

/// Open picker for Markdown and HWP documents, validated by extension.
#[tauri::command]
async fn pick_markdown_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    // The blocking dialog must run off the main event loop (macOS dispatches UI to it).
    tauri::async_runtime::spawn_blocking(move || {
        let Some(file) = app
            .dialog()
            .file()
            .add_filter("문서", &file_service::OPEN_PICKER_EXTENSIONS)
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        let path = file
            .into_path()
            .map_err(|e| format!("Cannot resolve selected file: {e}"))?;
        let path = file_service::validate_open_path(&path)?;
        Ok(Some(
            path.to_str()
                .ok_or("The document path is not valid UTF-8")?
                .to_owned(),
        ))
    })
    .await
    .map_err(|e| format!("Cannot open file picker: {e}"))?
}

#[tauri::command]
fn e2e_config(state: State<'_, AppState>) -> Option<e2e::E2eConfig> {
    state.e2e.clone()
}

#[tauri::command]
async fn pick_hwp_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(file) = app
            .dialog()
            .file()
            .add_filter("한글 문서", &["hwp", "hwpx"])
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        let path = file
            .into_path()
            .map_err(|e| format!("Cannot resolve selected file: {e}"))?;
        let path = file_service::validate_hwp_path(&path)?;
        Ok(Some(
            path.to_str()
                .ok_or("The document path is not valid UTF-8")?
                .to_owned(),
        ))
    })
    .await
    .map_err(|e| format!("Cannot open import picker: {e}"))?
}

#[tauri::command]
async fn read_hwp_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        file_service::read_hwp_bytes(Path::new(&path)).map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|e| format!("Cannot read import document: {e}"))?
}

#[tauri::command]
async fn read_document_image(
    doc_path: String,
    rel_path: String,
) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        file_service::read_document_image(Path::new(&doc_path), Path::new(&rel_path))
            .map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|e| format!("Cannot read document image: {e}"))?
}

#[tauri::command]
async fn save_hwpx_as(
    bytes: Vec<u8>,
    suggested_name: String,
    app: tauri::AppHandle,
) -> Result<Option<SavedHwpx>, String> {
    file_service::validate_hwpx_bytes(&bytes)?;
    let export_path = app
        .state::<AppState>()
        .e2e
        .as_ref()
        .and_then(|c| c.export_path.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let path = if let Some(path) = export_path {
            path.into()
        } else {
            let name = Path::new(&suggested_name)
                .file_name()
                .map(Path::new)
                .unwrap_or(Path::new("Untitled.hwpx"))
                .with_extension("hwpx");
            let Some(file) = app
                .dialog()
                .file()
                .add_filter("한글 HWPX", &["hwpx"])
                .set_file_name(name.to_string_lossy())
                .blocking_save_file()
            else {
                return Ok(None);
            };
            file.into_path()
                .map_err(|e| format!("Cannot resolve export destination: {e}"))?
        };
        file_service::write_bytes_atomic(&path, &bytes).map(Some)
    })
    .await
    .map_err(|e| format!("Cannot save HWPX export: {e}"))?
}

#[tauri::command]
fn e2e_gate_open(state: State<'_, AppState>) -> bool {
    e2e::gate_open(state.e2e.as_ref())
}

#[tauri::command]
fn report_e2e_state(json: String, state: State<'_, AppState>) -> Result<(), String> {
    e2e::report(state.e2e.as_ref(), &json)
}

#[derive(Clone, Serialize)]
struct FileOpened {
    path: String,
}

#[derive(Clone, Serialize)]
struct FilesDropped {
    paths: Vec<String>,
}

fn has_document(state: &AppState) -> bool {
    let watching = state
        .watch
        .lock()
        .map(|watch| watch.is_some())
        .unwrap_or(false);
    let dirty = state
        .document
        .lock()
        .map(|document| document.dirty)
        .unwrap_or(false);
    watching || dirty
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn opened(app: &tauri::AppHandle, urls: Vec<tauri::Url>) {
    let state = app.state::<AppState>();
    let paths: Vec<_> = urls
        .into_iter()
        .filter_map(|url| {
            let path = url.to_file_path().ok()?;
            let path = file_service::validate_path(&path).ok()?;
            path.to_str()?;
            Some(path)
        })
        .collect();
    let occupied = has_document(&state);
    let bundle = std::env::current_exe()
        .ok()
        .and_then(|exe| instance::bundle_path(&exe));
    let deliveries = instance::route(occupied, bundle.as_deref(), &paths, instance::launch);
    for (path, delivery) in paths.into_iter().zip(deliveries) {
        match delivery {
            instance::Delivery::Launched => continue,
            instance::Delivery::Fallback(error) => eprintln!("Cannot open a new MDViewer: {error}"),
            instance::Delivery::Current => {}
        }
        let path = path
            .to_str()
            .expect("paths were validated as UTF-8")
            .to_owned();
        let live = match state.pending.lock() {
            Ok(mut pending) => pending.opened(path.clone()),
            Err(_) => {
                eprintln!("Open request state is unavailable");
                continue;
            }
        };
        // Frontend registers its listener before draining the queue. The state lock
        // decides exactly one delivery route even when Opened races with that drain.
        if live {
            if let Err(error) = app.emit("file-opened", FileOpened { path }) {
                eprintln!("Cannot deliver file open: {error}");
            }
        }
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            e2e: e2e::E2eConfig::from_env(),
            ..Default::default()
        })
        .invoke_handler(tauri::generate_handler![
            take_pending_files,
            read_markdown,
            write_markdown,
            save_markdown_as,
            save_imported_markdown_as,
            set_document_dirty,
            confirm_close,
            watch_file,
            unwatch_file,
            pick_markdown_file,
            pick_hwp_file,
            read_hwp_bytes,
            read_document_image,
            save_hwpx_as,
            docx_export::save_docx_as,
            e2e_config,
            e2e_gate_open,
            report_e2e_state
        ])
        .build(tauri::generate_context!())
        .expect("Cannot build MDViewer");
    app.run(|app, event| match event {
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        tauri::RunEvent::Opened { urls } => opened(app, urls),
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }),
            ..
        } if label == "main" => {
            let paths = paths
                .into_iter()
                .filter_map(|path| path.to_str().map(str::to_owned))
                .collect();
            if let Err(error) = app.emit("files-dropped", FilesDropped { paths }) {
                eprintln!("Cannot deliver dropped files: {error}");
            }
        }
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::CloseRequested { api, .. },
            ..
        } if label == "main" => {
            if block_close(app, false) {
                api.prevent_close();
            }
        }
        tauri::RunEvent::ExitRequested { api, .. } => {
            if block_close(app, true) {
                api.prevent_exit();
            }
        }
        tauri::RunEvent::Exit => {
            if let Ok(mut watch) = app.state::<AppState>().watch.lock() {
                watch.take();
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::DocumentState;

    #[test]
    fn new_instance_has_document_when_dirty_or_watching() {
        let state = super::AppState::default();
        assert!(!super::has_document(&state));
        state.document.lock().unwrap().dirty = true;
        assert!(super::has_document(&state));
        state.document.lock().unwrap().dirty = false;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("watch.md");
        std::fs::write(&path, "document").unwrap();
        let file = super::file_service::read_markdown(&path).unwrap();
        *state.watch.lock().unwrap() =
            Some(super::FileWatch::start(file.path.into(), file.hash, |_| {}).unwrap());
        assert!(super::has_document(&state));
        state.watch.lock().unwrap().take();
        assert!(!super::has_document(&state));
    }

    #[test]
    fn dirty_title_marker_is_added_once_and_removed_after_save() {
        let mut document = DocumentState {
            title: Some("문서.md".into()),
            ..Default::default()
        };
        assert_eq!(document.window_title(), "문서.md");
        document.set_dirty(true);
        document.set_dirty(true);
        assert_eq!(document.window_title(), "● 문서.md");
        document.set_dirty(false);
        assert_eq!(document.window_title(), "문서.md");
    }

    #[test]
    fn close_and_quit_block_only_dirty_documents_and_preserve_quit_after_save() {
        let mut document = DocumentState::default();
        assert!(!document.request_close(false));
        assert!(!document.request_close(true));
        document.set_dirty(true);
        assert!(document.request_close(true));
        document.set_dirty(false);
        assert!(document.quit_requested);
        document.set_dirty(true);
        assert!(!document.quit_requested);
        assert!(document.request_close(false));
        assert!(!document.quit_requested);
    }
}

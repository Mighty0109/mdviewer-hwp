//! Parent-directory watches survive editors saving by renaming a temporary file.
use crate::file_service;
use notify::{Config, Event, EventKind, PollWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    sync::{
        mpsc::{self, Receiver, RecvTimeoutError, Sender},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const DEBOUNCE: Duration = Duration::from_millis(200);
const MAX_DEBOUNCE: Duration = Duration::from_millis(600);

#[derive(Clone, Debug, Serialize)]
pub struct FileChanged {
    pub path: String,
    pub hash: String,
    pub source: &'static str,
}

enum Signal {
    Changed,
    Stop,
}

pub struct FileWatch {
    path: PathBuf,
    baseline: Arc<Mutex<String>>,
    watcher: Option<Box<dyn Watcher + Send>>,
    sender: Sender<Signal>,
    worker: Option<JoinHandle<()>>,
}

impl FileWatch {
    pub fn start(
        path: PathBuf,
        baseline_hash: String,
        changed: impl Fn(FileChanged) + Send + 'static,
    ) -> Result<Self, String> {
        let parent = path
            .parent()
            .ok_or("The document has no parent directory")?;
        let (sender, receiver) = mpsc::channel();
        let handler = || {
            let event_sender = sender.clone();
            let watched_path = path.clone();
            move |result: notify::Result<Event>| {
                let relevant = match result {
                    Ok(event) => {
                        !matches!(event.kind, EventKind::Access(_))
                            && (event.need_rescan()
                                || event.paths.is_empty()
                                || event
                                    .paths
                                    .iter()
                                    .any(|p| touches_document(p, &watched_path)))
                    }
                    Err(_) => true, // Re-read after backend errors instead of silently dropping changes.
                };
                if relevant {
                    let _ = event_sender.send(Signal::Changed);
                }
            }
        };
        let native = notify::recommended_watcher(handler()).and_then(|mut watcher| {
            watcher.watch(parent, RecursiveMode::NonRecursive)?;
            Ok(watcher)
        });
        let watcher: Box<dyn Watcher + Send> = match native {
            Ok(watcher) => Box::new(watcher),
            Err(error) => {
                eprintln!("Native file watching unavailable ({error}); using content polling");
                let mut watcher = PollWatcher::new(
                    handler(),
                    Config::default()
                        .with_poll_interval(Duration::from_millis(250))
                        .with_compare_contents(true),
                )
                .map_err(|e| format!("Cannot create fallback file watcher: {e}"))?;
                // Poll only this document, avoiding reads of unrelated directory contents.
                // PollWatcher rescans the path, so replacement saves are supported as well.
                watcher
                    .watch(&path, RecursiveMode::NonRecursive)
                    .map_err(|e| format!("Cannot watch document: {e}"))?;
                Box::new(watcher)
            }
        };
        // Read once after installing the watch: closes the read_markdown -> watch_file gap.
        let baseline = Arc::new(Mutex::new(baseline_hash));
        let worker_baseline = baseline.clone();
        let worker_path = path.clone();
        let worker = thread::Builder::new()
            .name("markdown-watch".into())
            .spawn(move || watch_loop(receiver, worker_path, worker_baseline, changed))
            .map_err(|e| format!("Cannot start file watcher: {e}"))?;
        Ok(Self {
            path,
            baseline,
            watcher: Some(watcher),
            sender,
            worker: Some(worker),
        })
    }

    pub fn baseline_for(&self, path: &Path) -> Option<&Mutex<String>> {
        (path == self.path).then_some(self.baseline.as_ref())
    }
}

fn touches_document(event_path: &Path, document: &Path) -> bool {
    event_path == document
        || document.parent() == Some(event_path)
        || std::fs::canonicalize(event_path).is_ok_and(|p| p == document)
}

fn watch_loop(
    receiver: Receiver<Signal>,
    path: PathBuf,
    baseline: Arc<Mutex<String>>,
    changed: impl Fn(FileChanged),
) {
    let mut dirty_since = Some(Instant::now());
    loop {
        let signal = if dirty_since.is_some() {
            receiver.recv_timeout(DEBOUNCE)
        } else {
            match receiver.recv() {
                Ok(s) => Ok(s),
                Err(_) => break,
            }
        };
        match signal {
            Ok(Signal::Stop) | Err(RecvTimeoutError::Disconnected) => break,
            Ok(Signal::Changed) => {
                let since = dirty_since.get_or_insert_with(Instant::now);
                if since.elapsed() < MAX_DEBOUNCE {
                    continue;
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
        }
        // Acquire before reading disk, not just before comparing hashes. A save
        // publishes the new bytes and baseline together under this same lock.
        let Ok(mut hash) = baseline.lock() else {
            break;
        };
        match file_service::read_markdown(&path) {
            Ok(file) => {
                // Never follow a subsequently swapped symlink to another Markdown document.
                if Path::new(&file.path) != path {
                    continue;
                }
                dirty_since = None;
                if file.hash != *hash {
                    *hash = file.hash.clone();
                    changed(FileChanged {
                        path: file.path,
                        hash: file.hash,
                        source: "external",
                    });
                }
            }
            Err(_) => {
                // The target may be absent during an atomic save; retry until restored.
                dirty_since = Some(Instant::now());
            }
        }
    }
}

impl Drop for FileWatch {
    fn drop(&mut self) {
        let _ = self.sender.send(Signal::Stop);
        self.watcher.take();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn self_write_atomic_save_is_silent_even_before_initial_watch_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("self.md");
        fs::write(&path, "original").unwrap();
        let file = file_service::read_markdown(&path).unwrap();
        let canonical = PathBuf::from(&file.path);
        let (tx, rx) = mpsc::channel();
        let watch = FileWatch::start(canonical.clone(), file.hash.clone(), move |event| {
            let _ = tx.send(event);
        })
        .unwrap();
        let baseline = watch.baseline_for(&canonical).unwrap();
        let saved =
            file_service::write_markdown(&path, "my edit", &file.hash, Some(baseline)).unwrap();
        file_service::write_markdown(&path, "second edit", &saved.hash, Some(baseline)).unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(1200)).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "second edit");
        assert!(watch.baseline_for(&dir.path().join("other.md")).is_none());
    }

    #[test]
    fn self_write_still_reports_subsequent_external_atomic_change() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("external.md");
        fs::write(&path, "original").unwrap();
        let file = file_service::read_markdown(&path).unwrap();
        let canonical = PathBuf::from(&file.path);
        let (tx, rx) = mpsc::channel();
        let watch = FileWatch::start(canonical.clone(), file.hash.clone(), move |event| {
            let _ = tx.send(event);
        })
        .unwrap();
        file_service::write_markdown(&path, "my edit", &file.hash, watch.baseline_for(&canonical))
            .unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(1200)).is_err());
        let replacement = dir.path().join(".external-save");
        fs::write(&replacement, "external edit").unwrap();
        fs::rename(replacement, &path).unwrap();
        let event = rx.recv_timeout(Duration::from_secs(8)).unwrap();
        assert_eq!(event.source, "external");
        assert_eq!(event.path, file.path);
        assert_eq!(event.hash, file_service::read_markdown(&path).unwrap().hash);
    }

    #[test]
    fn self_write_conflict_does_not_suppress_pending_external_change() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("conflict.md");
        fs::write(&path, "original").unwrap();
        let file = file_service::read_markdown(&path).unwrap();
        let canonical = PathBuf::from(&file.path);
        let (tx, rx) = mpsc::channel();
        let watch = FileWatch::start(canonical.clone(), file.hash.clone(), move |event| {
            let _ = tx.send(event);
        })
        .unwrap();
        fs::write(&path, "external edit").unwrap();
        let error = file_service::write_markdown(
            &path,
            "my edit",
            &file.hash,
            watch.baseline_for(&canonical),
        )
        .unwrap_err();
        assert!(error.starts_with("conflict:"));
        let event = rx.recv_timeout(Duration::from_secs(8)).unwrap();
        assert_eq!(event.source, "external");
        assert_eq!(event.hash, file_service::read_markdown(&path).unwrap().hash);
        assert_eq!(fs::read_to_string(path).unwrap(), "external edit");
    }

    #[test]
    fn watches_in_place_and_atomic_saves_ignores_identical_content_and_stops() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("문서.md");
        fs::write(&path, "first").unwrap();
        let file = file_service::read_markdown(&path).unwrap();
        let (tx, rx) = mpsc::channel();
        let watch = FileWatch::start(PathBuf::from(&file.path), file.hash, move |e| {
            tx.send(e).unwrap();
        })
        .unwrap();
        fs::write(&path, "second").unwrap();
        let event = rx.recv_timeout(Duration::from_secs(8)).unwrap();
        assert_eq!(event.hash, file_service::read_markdown(&path).unwrap().hash);
        assert_eq!(event.source, "external");
        fs::write(&path, "second").unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(700)).is_err());
        let replacement = dir.path().join(".save.tmp");
        fs::write(&replacement, "third").unwrap();
        fs::rename(&replacement, &path).unwrap();
        let event = rx.recv_timeout(Duration::from_secs(8)).unwrap();
        assert_eq!(event.hash, file_service::read_markdown(&path).unwrap().hash);
        drop(watch);
        fs::write(&path, "fourth").unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(400)).is_err());
    }
    #[test]
    fn catches_changes_between_read_and_watch_registration() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("gap.md");
        fs::write(&path, "before").unwrap();
        let file = file_service::read_markdown(&path).unwrap();
        fs::write(&path, "after").unwrap();
        let (tx, rx) = mpsc::channel();
        let _watch = FileWatch::start(PathBuf::from(file.path), file.hash.clone(), move |e| {
            tx.send(e).unwrap();
        })
        .unwrap();
        assert_ne!(
            rx.recv_timeout(Duration::from_secs(5)).unwrap().hash,
            file.hash
        );
    }
}

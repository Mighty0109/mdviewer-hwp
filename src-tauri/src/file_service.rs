//! Validated disk access; no dependency on the webview or Tauri.
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::UNIX_EPOCH,
};

pub const OPEN_PICKER_EXTENSIONS: [&str; 5] = ["md", "markdown", "mdown", "hwp", "hwpx"];

pub fn validate_open_path(path: &Path) -> Result<PathBuf, String> {
    let extension = path.extension().and_then(|s| s.to_str()).unwrap_or("");
    if ["hwp", "hwpx"].iter().any(|allowed| extension.eq_ignore_ascii_case(allowed)) {
        validate_hwp_path(path)
    } else {
        validate_path(path)
    }
}

pub const MAX_BYTES: u64 = 20 * 1024 * 1024;

#[path = "import_assets.rs"]
mod import_assets;
pub use import_assets::{decode_import_packet, save_imported_markdown_as, SavedImportedMarkdown};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownFile {
    pub path: String,
    pub content: String,
    pub hash: String,
    pub mtime_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedMarkdown {
    pub path: String,
    pub hash: String,
    pub mtime_ms: u64,
}

pub fn validate_content(content: &str) -> Result<(), String> {
    if content.len() as u64 > MAX_BYTES {
        return Err("The document exceeds the 20 MB limit".into());
    }
    Ok(())
}

/// Unlike an open path, a Save As destination may not exist yet. Resolve its
/// parent, but still validate both ends of an existing symbolic link.
pub fn validate_save_path(path: &Path) -> Result<PathBuf, String> {
    resolve_save_path(path).map(|(canonical, _)| canonical)
}

fn resolve_save_path(path: &Path) -> Result<(PathBuf, bool), String> {
    if !path.is_absolute() {
        return Err("An absolute document path is required".into());
    }
    check_extension(path)?;
    match fs::symlink_metadata(path) {
        Ok(_) => validate_path(path).map(|canonical| (canonical, true)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = path
                .parent()
                .ok_or("The document has no parent directory")?;
            let parent = fs::canonicalize(parent)
                .map_err(|e| format!("Cannot resolve document directory: {e}"))?;
            if !parent.is_dir() {
                return Err("The document parent must be a directory".into());
            }
            let name = path.file_name().ok_or("The document needs a file name")?;
            Ok((parent.join(name), false))
        }
        Err(error) => Err(format!("Cannot inspect document: {error}")),
    }
}

/// A watcher holds this same mutex while reading disk. Hold it across validation
/// and publication, so it cannot observe old bytes against the new baseline (or
/// new bytes against the old baseline).
pub fn write_markdown(
    path: &Path,
    content: &str,
    expected_hash: &str,
    baseline: Option<&Mutex<String>>,
) -> Result<SavedMarkdown, String> {
    validate_content(content)?;
    let mut baseline = baseline
        .map(|hash| hash.lock().map_err(|_| "File watcher state is unavailable"))
        .transpose()?;
    let current = read_markdown(path)?;
    if current.hash != expected_hash {
        return Err(
            "conflict: The document changed on disk; reload it or save as another file".into(),
        );
    }
    let canonical = Path::new(&current.path);
    atomic_write(
        canonical,
        content,
        Some((path, expected_hash)),
        &mut baseline,
    )
}

/// Called only after the native save panel has approved the selected destination,
/// including its overwrite confirmation. A new file uses no-clobber publication.
pub fn save_markdown_as(
    path: &Path,
    content: &str,
    baseline: Option<&Mutex<String>>,
) -> Result<SavedMarkdown, String> {
    validate_content(content)?;
    let (canonical, existed) = resolve_save_path(path)?;
    if existed {
        let current = read_markdown(&canonical)?;
        write_markdown(path, content, &current.hash, baseline)
    } else {
        // Remember that validation saw a new destination. Never switch to an
        // overwrite if another process creates it while we prepare the save.
        let mut baseline = baseline
            .map(|hash| hash.lock().map_err(|_| "File watcher state is unavailable"))
            .transpose()?;
        atomic_write(&canonical, content, None, &mut baseline)
    }
}

fn atomic_write(
    canonical: &Path,
    content: &str,
    existing: Option<(&Path, &str)>,
    baseline: &mut Option<std::sync::MutexGuard<'_, String>>,
) -> Result<SavedMarkdown, String> {
    let path = canonical
        .to_str()
        .ok_or("The document path is not valid UTF-8")?
        .to_owned();
    let parent = canonical
        .parent()
        .ok_or("The document has no parent directory")?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|e| format!("Cannot create document temporary file: {e}"))?;
    temp.write_all(content.as_bytes())
        .map_err(|e| format!("Cannot write document: {e}"))?;
    temp.flush()
        .map_err(|e| format!("Cannot flush document: {e}"))?;
    if existing.is_some() {
        let permissions = fs::metadata(canonical)
            .map_err(|e| format!("Cannot inspect document permissions: {e}"))?
            .permissions();
        temp.as_file()
            .set_permissions(permissions)
            .map_err(|e| format!("Cannot preserve document permissions: {e}"))?;
    }
    temp.as_file()
        .sync_all()
        .map_err(|e| format!("Cannot sync document: {e}"))?;
    let metadata = temp
        .as_file()
        .metadata()
        .map_err(|e| format!("Cannot inspect saved document: {e}"))?;
    let hash = format!("{:x}", Sha256::digest(content.as_bytes()));
    // Recheck after preparing the temporary file: don't overwrite an external
    // edit made during the potentially long write/sync, or a swapped symlink.
    if let Some((original, expected_hash)) = existing {
        let latest = read_markdown(original)
            .map_err(|e| format!("conflict: Cannot revalidate document: {e}"))?;
        if Path::new(&latest.path) != canonical || latest.hash != expected_hash {
            return Err("conflict: The document changed while saving".into());
        }
    }
    let previous = baseline
        .as_mut()
        .map(|value| std::mem::replace(&mut **value, hash.clone()));
    let published = if existing.is_some() {
        temp.persist(canonical)
    } else {
        temp.persist_noclobber(canonical)
    };
    if let Err(error) = published {
        if let (Some(value), Some(previous)) = (baseline.as_mut(), previous) {
            **value = previous;
        }
        return Err(if error.error.kind() == std::io::ErrorKind::AlreadyExists {
            format!(
                "conflict: The destination appeared while saving: {}",
                error.error
            )
        } else {
            format!("Cannot publish document: {}", error.error)
        });
    }
    Ok(SavedMarkdown {
        path,
        hash,
        mtime_ms: metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis().min(u64::MAX as u128) as u64)
            .unwrap_or(0),
    })
}

fn check_extension(path: &Path) -> Result<(), String> {
    match path.extension().and_then(|s| s.to_str()) {
        Some(ext)
            if ["md", "markdown", "mdown"]
                .iter()
                .any(|allowed| ext.eq_ignore_ascii_case(allowed)) =>
        {
            Ok(())
        }
        _ => Err("Only .md, .markdown and .mdown documents can be opened".into()),
    }
}

pub fn validate_path(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("An absolute document path is required".into());
    }
    check_extension(path)?;
    let canonical = fs::canonicalize(path).map_err(|e| format!("Cannot resolve document: {e}"))?;
    // Check the target as well: a Markdown-named symlink cannot expose another file type.
    check_extension(&canonical)?;
    let metadata = fs::metadata(&canonical).map_err(|e| format!("Cannot inspect document: {e}"))?;
    if !metadata.is_file() {
        return Err("The document must be a regular file".into());
    }
    if metadata.len() > MAX_BYTES {
        return Err("The document exceeds the 20 MB limit".into());
    }
    Ok(canonical)
}

pub fn read_markdown(path: &Path) -> Result<MarkdownFile, String> {
    let canonical = validate_path(path)?;
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // Reject a final-component symlink swapped in after canonicalization, and avoid
        // blocking if the file is replaced with a FIFO between validation and open.
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options
        .open(&canonical)
        .map_err(|e| format!("Cannot open document: {e}"))?;
    let metadata = file
        .metadata()
        .map_err(|e| format!("Cannot inspect document: {e}"))?;
    if !metadata.is_file() || metadata.len() > MAX_BYTES {
        return Err("The document must be a regular file of at most 20 MB".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Cannot read document: {e}"))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("The document exceeds the 20 MB limit".into());
    }
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let content =
        String::from_utf8(bytes).map_err(|_| "The document is not valid UTF-8".to_string())?;
    let path = canonical
        .to_str()
        .ok_or("The document path is not valid UTF-8")?
        .to_owned();
    let mtime_ms = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0);
    Ok(MarkdownFile {
        path,
        content,
        hash,
        mtime_ms,
    })
}

pub const MAX_DOCUMENT_IMAGE_BYTES: u64 = 8 * 1024 * 1024;
// The uncompressed image budget is 64 MB; leave room for XML and ZIP overhead.
pub const MAX_HWPX_EXPORT_BYTES: u64 = 80 * 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
pub struct SavedHwpx {
    pub path: String,
}

fn check_hwp_extension(path: &Path, export: bool) -> Result<(), String> {
    let extension = path.extension().and_then(|s| s.to_str()).unwrap_or("");
    if extension.eq_ignore_ascii_case("hwpx") || (!export && extension.eq_ignore_ascii_case("hwp"))
    {
        Ok(())
    } else {
        Err(if export {
            "Only .hwpx export destinations are allowed"
        } else {
            "unsupported-format: Only .hwp and .hwpx documents can be imported"
        }
        .into())
    }
}

/// Import paths deliberately reject final-component symlinks, unlike Markdown.
/// No import function ever obtains a writable source handle.
pub fn validate_hwp_path(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("An absolute document path is required".into());
    }
    check_hwp_extension(path, false)?;
    let metadata =
        fs::symlink_metadata(path).map_err(|e| format!("Cannot inspect import document: {e}"))?;
    if !metadata.is_file() {
        return Err("The import document must be a regular file, not a symbolic link".into());
    }
    if metadata.len() > MAX_BYTES {
        return Err("too-large: The document exceeds the 20 MB limit".into());
    }
    let canonical =
        fs::canonicalize(path).map_err(|e| format!("Cannot resolve import document: {e}"))?;
    check_hwp_extension(&canonical, false)?;
    Ok(canonical)
}

fn read_bytes_limited(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options
        .open(path)
        .map_err(|e| format!("Cannot open file: {e}"))?;
    let metadata = file
        .metadata()
        .map_err(|e| format!("Cannot inspect file: {e}"))?;
    if !metadata.is_file() {
        return Err("The document must be a regular file".into());
    }
    if metadata.len() > limit {
        return Err(format!(
            "too-large: The file exceeds the {} MB limit",
            limit / 1024 / 1024
        ));
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Cannot read file: {e}"))?;
    if bytes.len() as u64 > limit {
        return Err(format!(
            "too-large: The file exceeds the {} MB limit",
            limit / 1024 / 1024
        ));
    }
    Ok(bytes)
}

pub fn read_hwp_bytes(path: &Path) -> Result<Vec<u8>, String> {
    let canonical = validate_hwp_path(path)?;
    // Recheck the selected path as well as O_NOFOLLOW on the resolved path.
    // A newly substituted symlink must not silently become an import source.
    if validate_hwp_path(path)? != canonical {
        return Err("The import document changed while opening".into());
    }
    read_bytes_limited(&canonical, MAX_BYTES)
}

/// Resolve images only beneath the actual Markdown document directory. Both
/// lexical traversal and symlinks escaping that directory are refused.
pub fn read_document_image(doc_path: &Path, rel_path: &Path) -> Result<Vec<u8>, String> {
    if rel_path.as_os_str().is_empty()
        || rel_path.is_absolute()
        || rel_path.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir | std::path::Component::Prefix(_)
            )
        })
    {
        return Err("Image path must stay inside the document directory".into());
    }
    let document = validate_path(doc_path)?;
    let parent = document
        .parent()
        .ok_or("The document has no parent directory")?;
    let image = parent.join(rel_path);
    check_document_image_extension(&image)?;
    let canonical =
        fs::canonicalize(&image).map_err(|e| format!("Cannot resolve document image: {e}"))?;
    if !canonical.starts_with(parent) {
        return Err("Image path must stay inside the document directory".into());
    }
    check_document_image_extension(&canonical)?;
    read_bytes_limited(&canonical, MAX_DOCUMENT_IMAGE_BYTES)
}

fn check_document_image_extension(path: &Path) -> Result<(), String> {
    let extension = path.extension().and_then(|s| s.to_str()).unwrap_or("");
    if ["png", "jpg", "jpeg", "gif", "bmp", "webp", "svg"]
        .iter()
        .any(|allowed| extension.eq_ignore_ascii_case(allowed))
    {
        Ok(())
    } else {
        Err("Only document image files can be read".into())
    }
}

pub fn validate_hwpx_save_path(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("An absolute export path is required".into());
    }
    check_hwp_extension(path, true)?;
    let parent = path.parent().ok_or("The export needs a parent directory")?;
    let parent =
        fs::canonicalize(parent).map_err(|e| format!("Cannot resolve export directory: {e}"))?;
    if !parent.is_dir() {
        return Err("The export parent must be a directory".into());
    }
    let canonical = parent.join(path.file_name().ok_or("The export needs a file name")?);
    match fs::symlink_metadata(&canonical) {
        Ok(metadata) if !metadata.is_file() => {
            return Err("Export destination must be a regular file, not a symbolic link".into())
        }
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("Cannot inspect export destination: {e}")),
    }
    Ok(canonical)
}

pub fn validate_hwpx_bytes(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() as u64 > MAX_HWPX_EXPORT_BYTES {
        return Err("The HWPX export exceeds the 80 MB limit".into());
    }
    if bytes.is_empty() {
        return Err("The HWPX export is empty".into());
    }
    Ok(())
}

/// Called after the native panel approves a .hwpx path. This separate binary
/// writer never changes Markdown watch baselines or the current document state.
pub fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<SavedHwpx, String> {
    validate_hwpx_bytes(bytes)?;
    let canonical = validate_hwpx_save_path(path)?;
    let path_string = canonical
        .to_str()
        .ok_or("The export path is not valid UTF-8")?
        .to_owned();
    let existing = match fs::symlink_metadata(&canonical) {
        Ok(_) => Some(Sha256::digest(read_bytes_limited(
            &canonical,
            MAX_HWPX_EXPORT_BYTES,
        )?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("Cannot inspect export destination: {e}")),
    };
    let mut temp = tempfile::NamedTempFile::new_in(canonical.parent().unwrap())
        .map_err(|e| format!("Cannot create export temporary file: {e}"))?;
    temp.write_all(bytes)
        .map_err(|e| format!("Cannot write export: {e}"))?;
    temp.flush()
        .map_err(|e| format!("Cannot flush export: {e}"))?;
    if existing.is_some() {
        let permissions = fs::metadata(&canonical)
            .map_err(|e| format!("Cannot inspect export permissions: {e}"))?
            .permissions();
        temp.as_file()
            .set_permissions(permissions)
            .map_err(|e| format!("Cannot preserve export permissions: {e}"))?;
    }
    temp.as_file()
        .sync_all()
        .map_err(|e| format!("Cannot sync export: {e}"))?;
    publish_hwpx(temp, &canonical, existing)?;
    Ok(SavedHwpx { path: path_string })
}

fn publish_hwpx(
    temp: tempfile::NamedTempFile,
    canonical: &Path,
    existing: Option<sha2::digest::Output<Sha256>>,
) -> Result<(), String> {
    if let Some(expected) = existing {
        validate_hwpx_save_path(canonical)?;
        let latest = read_bytes_limited(canonical, MAX_HWPX_EXPORT_BYTES)?;
        if Sha256::digest(latest) != expected {
            return Err("conflict: The export destination changed while saving".into());
        }
    }
    let published = if existing.is_some() {
        temp.persist(canonical)
    } else {
        temp.persist_noclobber(canonical)
    };
    published.map_err(|e| format!("Cannot publish export: {}", e.error))?;
    Ok(())
}

#[cfg(test)]
#[path = "hwp_tests.rs"]
mod hwp_tests;

#[cfg(test)]
mod tests {
    use super::*;

    fn document(dir: &Path, name: &str) -> (PathBuf, MarkdownFile) {
        let path = dir.join(name);
        fs::write(&path, "# 원본\n").unwrap();
        let file = read_markdown(&path).unwrap();
        (path, file)
    }

    #[test]
    fn write_markdown_atomically_replaces_bytes_and_returns_disk_hash() {
        let dir = tempfile::tempdir().unwrap();
        let (path, original) = document(dir.path(), "atomic.md");
        let mut old_handle = fs::File::open(&path).unwrap();
        let saved = write_markdown(&path, "# 새 내용\n", &original.hash, None).unwrap();
        let mut old_bytes = String::new();
        old_handle.read_to_string(&mut old_bytes).unwrap();
        // A previously open descriptor still sees the original inode: no truncation.
        assert_eq!(old_bytes, original.content);
        let disk = read_markdown(&path).unwrap();
        assert_eq!(disk.content, "# 새 내용\n");
        assert_eq!(saved.path, disk.path);
        assert_eq!(saved.hash, disk.hash);
        assert_eq!(saved.mtime_ms, disk.mtime_ms);
        assert!(serde_json::to_value(saved)
            .unwrap()
            .get("mtimeMs")
            .is_some());
    }

    #[test]
    fn write_markdown_leaves_no_temporary_files_after_success_or_rejection() {
        let dir = tempfile::tempdir().unwrap();
        let (path, original) = document(dir.path(), "cleanup.md");
        write_markdown(&path, "saved", &original.hash, None).unwrap();
        assert!(write_markdown(&path, "stale", &original.hash, None).is_err());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
        assert_eq!(fs::read_to_string(path).unwrap(), "saved");
    }

    #[test]
    fn write_markdown_refuses_external_hash_conflict_without_changing_disk_or_baseline() {
        let dir = tempfile::tempdir().unwrap();
        let (path, original) = document(dir.path(), "conflict.md");
        let baseline = Mutex::new(original.hash.clone());
        fs::write(&path, "external edit").unwrap();
        let error = write_markdown(&path, "my edit", &original.hash, Some(&baseline)).unwrap_err();
        assert!(error.starts_with("conflict:"));
        assert_eq!(fs::read_to_string(path).unwrap(), "external edit");
        assert_eq!(*baseline.lock().unwrap(), original.hash);
    }

    #[test]
    fn write_markdown_rejects_relative_wrong_extension_missing_and_directory_paths() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secret.txt");
        fs::write(&path, "secret").unwrap();
        let folder = dir.path().join("folder.md");
        fs::create_dir(&folder).unwrap();
        for invalid in [
            Path::new("relative.md"),
            &path,
            &folder,
            &dir.path().join("missing.md"),
        ] {
            assert!(write_markdown(invalid, "replacement", "hash", None).is_err());
        }
        assert_eq!(fs::read_to_string(path).unwrap(), "secret");
    }

    #[test]
    fn write_markdown_enforces_utf8_byte_size_for_content_and_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let (path, original) = document(dir.path(), "limit.md");
        let oversized = "한".repeat((MAX_BYTES / 3 + 1) as usize);
        assert!(write_markdown(&path, &oversized, &original.hash, None)
            .unwrap_err()
            .contains("20 MB"));
        assert_eq!(fs::read_to_string(&path).unwrap(), original.content);
        fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(MAX_BYTES + 1)
            .unwrap();
        assert!(write_markdown(&path, "small", &original.hash, None)
            .unwrap_err()
            .contains("20 MB"));
        assert_eq!(fs::metadata(path).unwrap().len(), MAX_BYTES + 1);
    }

    #[test]
    fn write_markdown_preserves_korean_filename_and_exact_source_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let (path, original) = document(dir.path(), "한글 문서.MDOWN");
        let content = "\u{feff}---\r\ntitle: 한글\r\n---\r\n![그림](./그림.png)\r\n$$x^2$$";
        write_markdown(&path, content, &original.hash, None).unwrap();
        assert_eq!(fs::read(path).unwrap(), content.as_bytes());
    }

    #[cfg(unix)]
    #[test]
    fn write_markdown_resolves_symlink_and_replaces_target_in_its_own_directory() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let real_dir = dir.path().join("real");
        fs::create_dir(&real_dir).unwrap();
        let (target, original) = document(&real_dir, "target.markdown");
        let alias = dir.path().join("alias.md");
        symlink(&target, &alias).unwrap();
        let saved = write_markdown(&alias, "target updated", &original.hash, None).unwrap();
        assert_eq!(
            saved.path,
            fs::canonicalize(&target).unwrap().to_str().unwrap()
        );
        assert!(fs::symlink_metadata(&alias)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(target).unwrap(), "target updated");
        assert_eq!(fs::read_dir(real_dir).unwrap().count(), 1);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
        let secret = dir.path().join("secret.txt");
        fs::write(&secret, "secret").unwrap();
        fs::remove_file(&alias).unwrap();
        symlink(&secret, &alias).unwrap();
        assert!(write_markdown(&alias, "overwrite", &original.hash, None).is_err());
        assert_eq!(fs::read_to_string(secret).unwrap(), "secret");
    }

    #[cfg(unix)]
    #[test]
    fn write_markdown_preserves_existing_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let (path, original) = document(dir.path(), "permissions.md");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        write_markdown(&path, "updated", &original.hash, None).unwrap();
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o640
        );
    }

    #[test]
    fn write_markdown_rechecks_hash_after_temporary_file_preparation() {
        let dir = tempfile::tempdir().unwrap();
        let (path, original) = document(dir.path(), "recheck.md");
        let canonical = fs::canonicalize(&path).unwrap();
        fs::write(&path, "external during preparation").unwrap();
        let mut baseline = None;
        let error = atomic_write(
            &canonical,
            "my edit",
            Some((&path, &original.hash)),
            &mut baseline,
        )
        .unwrap_err();
        assert!(error.starts_with("conflict:"));
        assert_eq!(
            fs::read_to_string(path).unwrap(),
            "external during preparation"
        );
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn write_markdown_rejects_symlink_target_swap_even_with_identical_hash() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let (target, original) = document(dir.path(), "target.md");
        let (other, _) = document(dir.path(), "other.md");
        let canonical = fs::canonicalize(&target).unwrap();
        let alias = dir.path().join("alias.md");
        // The alias now points elsewhere after the initial target was resolved.
        symlink(&other, &alias).unwrap();
        let error = atomic_write(
            &canonical,
            "replacement",
            Some((&alias, &original.hash)),
            &mut None,
        )
        .unwrap_err();
        assert!(error.starts_with("conflict:"));
        assert_eq!(fs::read_to_string(target).unwrap(), original.content);
        assert_eq!(fs::read_to_string(other).unwrap(), original.content);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 3);
    }

    #[test]
    fn save_as_creates_new_markdown_file_with_returned_metadata() {
        let dir = tempfile::tempdir().unwrap();
        for extension in ["md", "markdown", "MDOWN"] {
            let path = dir.path().join(format!("새 문서.{extension}"));
            let saved = save_markdown_as(&path, "# 새 파일\n", None).unwrap();
            let read = read_markdown(&path).unwrap();
            assert_eq!(saved.path, read.path);
            assert_eq!(saved.hash, read.hash);
            assert_eq!(saved.mtime_ms, read.mtime_ms);
            assert_eq!(read.content, "# 새 파일\n");
        }
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 3);
    }

    #[test]
    fn save_as_rejects_missing_parent_relative_extension_directory_and_oversize() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("folder.md");
        fs::create_dir(&folder).unwrap();
        for path in [
            dir.path().join("missing/new.md"),
            dir.path().join("secret.txt"),
            PathBuf::from("relative.md"),
            folder,
        ] {
            assert!(save_markdown_as(&path, "content", None).is_err());
        }
        let oversized = "x".repeat(MAX_BYTES as usize + 1);
        assert!(save_markdown_as(&dir.path().join("large.md"), &oversized, None).is_err());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn save_as_overwrites_only_selected_existing_file_and_updates_watch_baseline() {
        let dir = tempfile::tempdir().unwrap();
        let (path, original) = document(dir.path(), "approved.md");
        let (other, other_file) = document(dir.path(), "other.md");
        let baseline = Mutex::new(original.hash);
        let saved = save_markdown_as(&path, "approved replacement", Some(&baseline)).unwrap();
        assert_eq!(*baseline.lock().unwrap(), saved.hash);
        assert_eq!(fs::read_to_string(path).unwrap(), "approved replacement");
        assert_eq!(fs::read_to_string(other).unwrap(), other_file.content);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
    }

    #[test]
    fn save_as_no_clobber_failure_restores_baseline_and_removes_temporary_file() {
        let dir = tempfile::tempdir().unwrap();
        let (path, original) = document(dir.path(), "appeared.md");
        let baseline = Mutex::new(original.hash.clone());
        {
            let mut guard = Some(baseline.lock().unwrap());
            // Simulate another process creating the destination after validation.
            let error = atomic_write(&path, "my edit", None, &mut guard).unwrap_err();
            assert!(error.starts_with("conflict:"));
        }
        assert_eq!(*baseline.lock().unwrap(), original.hash);
        assert_eq!(fs::read_to_string(path).unwrap(), original.content);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn save_as_resolves_parent_and_rejects_dangling_or_disguised_symlinks() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let real_dir = dir.path().join("real");
        fs::create_dir(&real_dir).unwrap();
        let parent_link = dir.path().join("linked");
        symlink(&real_dir, &parent_link).unwrap();
        let saved = save_markdown_as(&parent_link.join("new.md"), "created", None).unwrap();
        assert_eq!(
            saved.path,
            fs::canonicalize(real_dir.join("new.md"))
                .unwrap()
                .to_str()
                .unwrap()
        );
        let alias = dir.path().join("alias.md");
        symlink(dir.path().join("missing.md"), &alias).unwrap();
        assert!(save_markdown_as(&alias, "content", None).is_err());
        fs::remove_file(&alias).unwrap();
        let secret = dir.path().join("secret.txt");
        fs::write(&secret, "secret").unwrap();
        symlink(&secret, &alias).unwrap();
        assert!(save_markdown_as(&alias, "content", None).is_err());
        assert_eq!(fs::read_to_string(secret).unwrap(), "secret");
    }
    #[test]
    fn reads_korean_and_hashes_content_not_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("한글.MD");
        fs::write(&path, "# 제목\n본문").unwrap();
        let first = read_markdown(&path).unwrap();
        assert_eq!(first.content, "# 제목\n본문");
        assert_eq!(first.hash.len(), 64);
        assert!(first.mtime_ms > 0);
        fs::write(&path, &first.content).unwrap();
        assert_eq!(first.hash, read_markdown(&path).unwrap().hash);
        fs::write(&path, "변경").unwrap();
        assert_ne!(first.hash, read_markdown(&path).unwrap().hash);
        assert!(serde_json::to_value(first)
            .unwrap()
            .get("mtimeMs")
            .is_some());
    }
    #[test]
    fn rejects_relative_paths_directories_unknown_extensions_and_missing_files() {
        assert!(read_markdown(Path::new("relative.md")).is_err());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secret.txt");
        fs::write(&path, "secret").unwrap();
        assert!(read_markdown(&path).is_err());
        let folder = dir.path().join("folder.md");
        fs::create_dir(&folder).unwrap();
        assert!(read_markdown(&folder).is_err());
        assert!(read_markdown(&dir.path().join("missing.md")).is_err());
    }
    #[test]
    fn enforces_size_limit_and_utf8() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("large.md");
        let file = fs::File::create(&path).unwrap();
        file.set_len(MAX_BYTES + 1).unwrap();
        assert!(read_markdown(&path).unwrap_err().contains("20 MB"));
        fs::write(&path, [0xff]).unwrap();
        assert!(read_markdown(&path).unwrap_err().contains("UTF-8"));
    }
    #[cfg(unix)]
    #[test]
    fn resolves_markdown_symlinks_but_rejects_disguised_targets() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target.markdown");
        fs::write(&target, "# ok").unwrap();
        let link = dir.path().join("alias.md");
        symlink(&target, &link).unwrap();
        assert_eq!(
            read_markdown(&link).unwrap().path,
            fs::canonicalize(&target).unwrap().to_str().unwrap()
        );
        fs::remove_file(&link).unwrap();
        let secret = dir.path().join("secret.txt");
        fs::write(&secret, "secret").unwrap();
        symlink(&secret, &link).unwrap();
        assert!(read_markdown(&link).is_err());
    }
}

/// Validate a user-selected Word export destination without following symlinks.
pub fn validate_docx_save_path(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() || !path.extension().and_then(|s| s.to_str()).is_some_and(|s| s.eq_ignore_ascii_case("docx")) {
        return Err("An absolute .docx export path is required".into());
    }
    let parent = fs::canonicalize(path.parent().ok_or("The export needs a parent directory")?)
        .map_err(|e| format!("Cannot resolve export directory: {e}"))?;
    if !parent.is_dir() { return Err("The export parent must be a directory".into()); }
    let target = parent.join(path.file_name().ok_or("The export needs a file name")?);
    match fs::symlink_metadata(&target) {
        Ok(meta) if !meta.is_file() => return Err("Export destination must be a regular file, not a symbolic link".into()),
        Ok(_) => {},
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
        Err(e) => return Err(format!("Cannot inspect export destination: {e}")),
    }
    Ok(target)
}

pub fn write_docx_atomic(path: &Path, bytes: &[u8]) -> Result<PathBuf, String> {
    if bytes.len() as u64 > 80 * 1024 * 1024 || !bytes.starts_with(b"PK") { return Err("Invalid Word export".into()); }
    let target = validate_docx_save_path(path)?;
    let existing = match fs::symlink_metadata(&target) {
        Ok(_) => Some(Sha256::digest(read_bytes_limited(&target, 80 * 1024 * 1024)?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("Cannot inspect export destination: {e}")),
    };
    let mut temp = tempfile::NamedTempFile::new_in(target.parent().unwrap()).map_err(|e| e.to_string())?;
    temp.write_all(bytes).and_then(|_| temp.flush()).map_err(|e| e.to_string())?;
    if existing.is_some() { temp.as_file().set_permissions(fs::metadata(&target).map_err(|e| e.to_string())?.permissions()).map_err(|e| e.to_string())?; }
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    if let Some(expected) = existing {
        validate_docx_save_path(&target)?;
        if Sha256::digest(read_bytes_limited(&target, 80 * 1024 * 1024)?) != expected { return Err("conflict: The export destination changed while saving".into()); }
        temp.persist(&target).map_err(|e| e.error.to_string())?;
    } else { temp.persist_noclobber(&target).map_err(|e| e.error.to_string())?; }
    Ok(target)
}

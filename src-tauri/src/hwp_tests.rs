//! Only synthetic bytes are used here; no private Downloads documents are read.
use super::*;

#[test]
fn hwp_read_returns_exact_binary_bytes_for_both_formats() {
    let dir = tempfile::tempdir().unwrap();
    for name in ["binary.hwp", "archive.HWPX"] {
        let path = dir.path().join(name);
        let bytes = [0xd0, 0xcf, 0, 0xff, 0x80, 10];
        fs::write(&path, bytes).unwrap();
        assert_eq!(read_hwp_bytes(&path).unwrap(), bytes);
    }
}

#[test]
fn hwp_read_preserves_source_sha256_and_creates_no_markdown_or_assets() {
    let dir = tempfile::tempdir().unwrap();
    for name in ["source.hwp", "source.hwpx"] {
        let path = dir.path().join(name);
        fs::write(&path, b"synthetic source\x00\xff").unwrap();
        let before = Sha256::digest(fs::read(&path).unwrap());
        let imported = read_hwp_bytes(&path).unwrap();
        assert_eq!(Sha256::digest(&imported), before);
        assert_eq!(Sha256::digest(fs::read(&path).unwrap()), before);
    }
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
}

#[test]
fn hwp_read_rejects_wrong_extension_and_relative_path() {
    let dir = tempfile::tempdir().unwrap();
    for name in ["private.txt", "text.md", "image.png", "no-extension"] {
        let path = dir.path().join(name);
        fs::write(&path, b"secret").unwrap();
        assert!(read_hwp_bytes(&path)
            .unwrap_err()
            .contains("unsupported-format"));
    }
    assert!(read_hwp_bytes(Path::new("relative.hwp")).is_err());
}

#[test]
fn hwp_read_rejects_missing_files_and_directories() {
    let dir = tempfile::tempdir().unwrap();
    let folder = dir.path().join("folder.hwpx");
    fs::create_dir(&folder).unwrap();
    assert!(read_hwp_bytes(&folder)
        .unwrap_err()
        .contains("regular file"));
    assert!(read_hwp_bytes(&dir.path().join("missing.hwp")).is_err());
}

#[cfg(unix)]
#[test]
fn hwp_read_rejects_symlinks_including_same_extension_and_dangling() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("original.hwp");
    fs::write(&source, b"original").unwrap();
    for (name, target) in [
        ("alias.hwp", source.clone()),
        ("dangling.hwpx", dir.path().join("missing.hwpx")),
    ] {
        let alias = dir.path().join(name);
        symlink(target, &alias).unwrap();
        assert!(read_hwp_bytes(&alias)
            .unwrap_err()
            .contains("symbolic link"));
    }
    assert_eq!(fs::read(source).unwrap(), b"original");
}

#[test]
fn hwp_read_enforces_twenty_mb_limit_including_open_handle_check() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("large.hwp");
    let file = fs::File::create(&path).unwrap();
    file.set_len(MAX_BYTES + 1).unwrap();
    assert!(read_hwp_bytes(&path).unwrap_err().contains("too-large"));
    assert!(read_bytes_limited(&path, MAX_BYTES)
        .unwrap_err()
        .contains("20 MB"));
    file.set_len(MAX_BYTES).unwrap();
    assert_eq!(read_hwp_bytes(&path).unwrap().len() as u64, MAX_BYTES);
}

#[test]
fn hwp_read_handles_korean_and_space_in_path_without_utf8_decoding_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let folder = dir.path().join("한글 폴더");
    fs::create_dir(&folder).unwrap();
    let path = folder.join("검증 보고서.HWP");
    fs::write(&path, [0xff, 0xfe, 0, 0x81]).unwrap();
    assert_eq!(read_hwp_bytes(&path).unwrap(), [0xff, 0xfe, 0, 0x81]);
    assert_eq!(
        validate_hwp_path(&path).unwrap(),
        fs::canonicalize(path).unwrap()
    );
}

#[cfg(unix)]
#[test]
fn hwp_read_rejects_fifo_without_blocking() {
    use std::os::unix::ffi::OsStrExt;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pipe.hwp");
    let c_path = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
    assert!(read_hwp_bytes(&path).is_err());
    assert!(read_bytes_limited(&path, MAX_BYTES).is_err());
}

#[test]
fn hwpx_save_creates_binary_package_and_leaves_no_temporary_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("export.hwpx");
    let bytes = b"PK\x03\x04\x00\xffsynthetic package";
    let saved = write_bytes_atomic(&path, bytes).unwrap();
    assert_eq!(fs::read(&saved.path).unwrap(), bytes);
    assert_eq!(Path::new(&saved.path), fs::canonicalize(&path).unwrap());
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn hwpx_save_atomically_replaces_approved_file_without_mutating_old_handle() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("export.hwpx");
    fs::write(&path, b"old package").unwrap();
    let mut old_handle = fs::File::open(&path).unwrap();
    write_bytes_atomic(&path, b"new package").unwrap();
    let mut old_bytes = Vec::new();
    old_handle.read_to_end(&mut old_bytes).unwrap();
    assert_eq!(old_bytes, b"old package");
    assert_eq!(fs::read(&path).unwrap(), b"new package");
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn hwpx_save_rejects_other_extensions_relative_directory_missing_parent_and_empty() {
    let dir = tempfile::tempdir().unwrap();
    let folder = dir.path().join("folder.hwpx");
    fs::create_dir(&folder).unwrap();
    for path in [
        dir.path().join("source.hwp"),
        dir.path().join("source.md"),
        dir.path().join("no-extension"),
        dir.path().join("missing/export.hwpx"),
        PathBuf::from("relative.hwpx"),
        folder,
    ] {
        assert!(write_bytes_atomic(&path, b"package").is_err());
    }
    assert!(write_bytes_atomic(&dir.path().join("empty.hwpx"), b"").is_err());
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn hwpx_save_supports_korean_filename_and_space_and_returns_path_contract() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("한글 보고서.HWPX");
    let saved = write_bytes_atomic(&path, b"package").unwrap();
    let value = serde_json::to_value(saved).unwrap();
    assert_eq!(
        value["path"],
        fs::canonicalize(&path).unwrap().to_str().unwrap()
    );
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn hwpx_save_no_clobber_race_preserves_destination_and_removes_temp() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("appeared.hwpx");
    assert!(validate_hwpx_save_path(&path).is_ok());
    let mut temp = tempfile::NamedTempFile::new_in(dir.path()).unwrap();
    temp.write_all(b"my package").unwrap();
    fs::write(&path, b"appeared during write").unwrap();
    assert!(publish_hwpx(temp, &path, None).is_err());
    assert_eq!(fs::read(&path).unwrap(), b"appeared during write");
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn hwpx_save_conflict_preserves_external_change_and_removes_temp() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("changed.hwpx");
    fs::write(&path, b"initial").unwrap();
    let expected = Sha256::digest(b"initial");
    let temp = tempfile::NamedTempFile::new_in(dir.path()).unwrap();
    fs::write(&path, b"external edit").unwrap();
    assert!(publish_hwpx(temp, &path, Some(expected))
        .unwrap_err()
        .starts_with("conflict:"));
    assert_eq!(fs::read(&path).unwrap(), b"external edit");
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[cfg(unix)]
#[test]
fn hwpx_save_rejects_symlink_and_preserves_original_file_and_permissions() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.hwp");
    fs::write(&source, b"source unchanged").unwrap();
    let alias = dir.path().join("alias.hwpx");
    symlink(&source, &alias).unwrap();
    assert!(write_bytes_atomic(&alias, b"replacement").is_err());
    assert_eq!(fs::read(&source).unwrap(), b"source unchanged");
    let path = dir.path().join("export.hwpx");
    fs::write(&path, b"old").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
    write_bytes_atomic(&path, b"new").unwrap();
    assert_eq!(
        fs::metadata(path).unwrap().permissions().mode() & 0o777,
        0o640
    );
}

#[test]
fn document_image_reads_only_images_within_document_and_enforces_eight_mb() {
    let dir = tempfile::tempdir().unwrap();
    let doc = dir.path().join("문서.md");
    fs::write(&doc, "![그림](그림.png)").unwrap();
    let image = dir.path().join("그림.png");
    fs::write(&image, [0, 0xff, 0x81]).unwrap();
    assert_eq!(
        read_document_image(&doc, Path::new("./그림.png")).unwrap(),
        [0, 0xff, 0x81]
    );
    for relative in [
        "../그림.png",
        "nested/../../그림.png",
        "문서.md",
        "/tmp/outside.png",
        "",
    ] {
        assert!(read_document_image(&doc, Path::new(relative)).is_err());
    }
    fs::OpenOptions::new()
        .write(true)
        .open(&image)
        .unwrap()
        .set_len(MAX_DOCUMENT_IMAGE_BYTES + 1)
        .unwrap();
    assert!(read_document_image(&doc, Path::new("그림.png"))
        .unwrap_err()
        .contains("8 MB"));
}

#[cfg(unix)]
#[test]
fn document_image_rejects_symlink_escape_and_disguised_extension() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let doc = dir.path().join("document.md");
    fs::write(&doc, "text").unwrap();
    let external = outside.path().join("secret.png");
    fs::write(&external, "private").unwrap();
    symlink(&external, dir.path().join("alias.png")).unwrap();
    assert!(read_document_image(&doc, Path::new("alias.png")).is_err());
    let secret = dir.path().join("secret.txt");
    fs::write(&secret, "private").unwrap();
    symlink(&secret, dir.path().join("disguised.png")).unwrap();
    assert!(read_document_image(&doc, Path::new("disguised.png")).is_err());
    symlink(outside.path(), dir.path().join("linked")).unwrap();
    assert!(read_document_image(&doc, Path::new("linked/secret.png")).is_err());
}

#[test]
fn open_picker_accepts_markdown_extensions() {
    let dir = tempfile::tempdir().unwrap();
    for name in ["note.md", "note.MARKDOWN", "note.mdown"] {
        let path = dir.path().join(name);
        fs::write(&path, b"markdown").unwrap();
        assert_eq!(validate_open_path(&path).unwrap(), fs::canonicalize(&path).unwrap());
    }
}

#[test]
fn open_picker_accepts_hwp_extensions() {
    let dir = tempfile::tempdir().unwrap();
    for name in ["report.hwp", "report.HWPX"] {
        let path = dir.path().join(name);
        fs::write(&path, b"synthetic").unwrap();
        assert_eq!(validate_open_path(&path).unwrap(), fs::canonicalize(&path).unwrap());
    }
}

#[test]
fn open_picker_rejects_other_extensions_and_relative_paths() {
    let dir = tempfile::tempdir().unwrap();
    for name in ["file.txt", "file.png", "file.docx", "file"] {
        let path = dir.path().join(name);
        fs::write(&path, b"synthetic").unwrap();
        assert!(validate_open_path(&path).is_err());
    }
    assert!(validate_open_path(Path::new("relative.hwp")).is_err());
    assert!(validate_open_path(Path::new("relative.md")).is_err());
}

#[cfg(unix)]
#[test]
fn open_picker_preserves_format_specific_symlink_rules() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let hwp = dir.path().join("source.hwp");
    let markdown = dir.path().join("source.md");
    fs::write(&hwp, b"hwp").unwrap();
    fs::write(&markdown, b"markdown").unwrap();
    let hwp_link = dir.path().join("link.hwp");
    let markdown_link = dir.path().join("link.md");
    symlink(&hwp, &hwp_link).unwrap();
    symlink(&markdown, &markdown_link).unwrap();
    assert!(validate_open_path(&hwp_link).unwrap_err().contains("symbolic link"));
    assert_eq!(validate_open_path(&markdown_link).unwrap(), fs::canonicalize(markdown).unwrap());
}

#[test]
fn open_picker_preserves_hwp_size_error() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("large.hwp");
    fs::File::create(&path).unwrap().set_len(MAX_BYTES + 1).unwrap();
    assert!(validate_open_path(&path).unwrap_err().starts_with("too-large:"));
}

#[test]
fn open_picker_filter_matches_supported_formats() {
    assert_eq!(OPEN_PICKER_EXTENSIONS.as_slice(), &["md", "markdown", "mdown", "hwp", "hwpx"]);
    let dir = tempfile::tempdir().unwrap();
    for extension in OPEN_PICKER_EXTENSIONS {
        let path = dir.path().join(format!("file.{extension}"));
        fs::write(&path, b"synthetic").unwrap();
        assert!(validate_open_path(&path).is_ok(), "{extension}");
    }
}

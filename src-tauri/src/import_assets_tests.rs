use super::*;

fn image(name: &str) -> ImportAsset {
    ImportAsset {
        name: name.into(),
        mime_type: "image/png".into(),
        bytes: vec![137, 80, 78, 71, 0, 255],
    }
}
const CONTENT: &str = "# 제목\n\n![그림](mdviewer-import-assets/img-001.png)\n";

#[test]
fn import_assets_writes_bytes_rewrites_links_and_returns_disk_hash() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("document.md");
    let saved = save_imported_markdown_as(&path, CONTENT, &[image("img-001.png")], None).unwrap();
    assert_eq!(IMPORT_ASSET_PREFIX, "mdviewer-import-assets/");
    assert_eq!(saved.assets_dir, "document.assets");
    assert_eq!(
        fs::read(dir.path().join("document.assets/img-001.png")).unwrap(),
        image("img-001.png").bytes
    );
    let disk = read_markdown(&path).unwrap();
    assert_eq!(disk.hash, saved.saved.hash);
    assert_eq!(
        disk.content,
        CONTENT.replace(IMPORT_ASSET_PREFIX, "document.assets/")
    );
    assert_eq!(disk.path, saved.saved.path);
}

#[test]
fn import_assets_numbers_folder_collisions_and_preserves_existing_files() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join("report.assets")).unwrap();
    fs::write(dir.path().join("report.assets/img-001.png"), "existing").unwrap();
    fs::write(dir.path().join("report.assets-2"), "existing file").unwrap();
    let saved = save_imported_markdown_as(
        &dir.path().join("report.md"),
        CONTENT,
        &[image("img-001.png")],
        None,
    )
    .unwrap();
    assert_eq!(saved.assets_dir, "report.assets-3");
    assert_eq!(
        fs::read(dir.path().join("report.assets/img-001.png")).unwrap(),
        b"existing"
    );
    assert_eq!(
        fs::read(dir.path().join("report.assets-2")).unwrap(),
        b"existing file"
    );
}

#[test]
fn import_assets_cleans_only_its_new_directory_when_markdown_save_fails() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join("a long document.assets")).unwrap();
    let keep = dir.path().join("a long document.assets/keep.png");
    fs::write(&keep, b"keep").unwrap();
    let content = "x".repeat(MAX_BYTES as usize - IMPORT_ASSET_PREFIX.len()) + IMPORT_ASSET_PREFIX;
    // Input fits; the longer destination URL exceeds the existing Markdown limit.
    assert!(save_imported_markdown_as(
        &dir.path().join("a long document.md"),
        &content,
        &[image("img-001.png")],
        None
    )
    .is_err());
    assert!(!dir.path().join("a long document.assets-2").exists());
    assert!(!dir.path().join("a long document.md").exists());
    assert_eq!(fs::read(keep).unwrap(), b"keep");
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn import_assets_rejects_traversal_url_and_duplicate_names_before_creating_anything() {
    let dir = tempfile::tempdir().unwrap();
    for name in [
        "../bad.png",
        "/bad.png",
        "a/b.png",
        "a\\b.png",
        "..",
        "a%2F.png",
        "a.png#x",
        "",
        "a png.png",
    ] {
        assert!(
            save_imported_markdown_as(&dir.path().join("a.md"), CONTENT, &[image(name)], None)
                .is_err(),
            "{name}"
        );
    }
    assert!(save_imported_markdown_as(
        &dir.path().join("a.md"),
        CONTENT,
        &[image("a.png"), image("A.png")],
        None
    )
    .is_err());
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
}

#[test]
fn import_assets_enforces_image_extension_and_mime_whitelist() {
    let dir = tempfile::tempdir().unwrap();
    for name in ["a.svg", "a.exe", "a.emf", "a.wmf", "a.webp"] {
        assert!(
            save_imported_markdown_as(&dir.path().join("a.md"), CONTENT, &[image(name)], None)
                .is_err()
        );
    }
    assert!(validate_import_assets(
        CONTENT,
        &[ImportAsset {
            mime_type: "text/html".into(),
            ..image("a.png")
        }]
    )
    .is_err());
    for (name, mime) in [
        ("a.PNG", "image/png"),
        ("a.jpg", "image/jpeg"),
        ("a.jpeg", "image/jpeg"),
        ("a.gif", "image/gif"),
        ("a.bmp", "image/bmp"),
    ] {
        assert!(validate_import_assets(
            CONTENT,
            &[ImportAsset {
                mime_type: mime.into(),
                ..image(name)
            }]
        )
        .is_ok());
    }
}

#[test]
fn import_assets_encodes_korean_spaces_and_markdown_punctuation_in_folder_links() {
    let dir = tempfile::tempdir().unwrap();
    let saved = save_imported_markdown_as(
        &dir.path().join("한글 문서 (1).md"),
        CONTENT,
        &[image("img-001.png")],
        None,
    )
    .unwrap();
    let prefix = "%ED%95%9C%EA%B8%80%20%EB%AC%B8%EC%84%9C%20%281%29.assets/";
    assert_eq!(encode_asset_segment(&saved.assets_dir) + "/", prefix);
    assert_eq!(
        read_markdown(Path::new(&saved.saved.path)).unwrap().content,
        CONTENT.replace(IMPORT_ASSET_PREFIX, prefix)
    );
    assert!(dir
        .path()
        .join(&saved.assets_dir)
        .join("img-001.png")
        .is_file());
}

#[test]
fn import_assets_preserves_original_hwp_and_hwpx_sha256_without_adjacent_outputs() {
    let source = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    for (index, name) in ["synthetic.hwp", "synthetic.hwpx"].iter().enumerate() {
        let path = source.path().join(name);
        let bytes: &[u8] = if index == 0 {
            include_bytes!("../../fixtures/hwp/synthetic.hwp")
        } else {
            include_bytes!("../../fixtures/hwp/synthetic.hwpx")
        };
        fs::write(&path, bytes).unwrap();
        let before = Sha256::digest(fs::read(&path).unwrap());
        read_hwp_bytes(&path).unwrap();
        save_imported_markdown_as(
            &destination.path().join(format!("import-{index}.md")),
            CONTENT,
            &[image("img-001.png")],
            None,
        )
        .unwrap();
        assert_eq!(Sha256::digest(fs::read(&path).unwrap()), before);
    }
    assert_eq!(fs::read_dir(source.path()).unwrap().count(), 2);
}

#[test]
fn import_assets_checks_count_individual_and_total_byte_budgets() {
    let mut empty = image("a.png");
    empty.bytes.clear();
    assert!(validate_import_assets(CONTENT, &[empty]).is_err());
    let mut large = image("a.png");
    large.bytes.resize(MAX_DOCUMENT_IMAGE_BYTES as usize + 1, 0);
    assert!(validate_import_assets(CONTENT, &[large]).is_err());
    let many: Vec<_> = (0..501).map(|n| image(&format!("img-{n}.png"))).collect();
    assert!(validate_import_assets(CONTENT, &many)
        .unwrap_err()
        .contains("500"));
    assert!(validate_import_assets(CONTENT, &many[..500]).is_ok());
    let full: Vec<_> = (0..9)
        .map(|n| ImportAsset {
            bytes: vec![0; MAX_DOCUMENT_IMAGE_BYTES as usize],
            ..image(&format!("img-{n}.png"))
        })
        .collect();
    assert!(validate_import_assets(CONTENT, &full[..8]).is_ok());
    assert!(validate_import_assets(CONTENT, &full)
        .unwrap_err()
        .contains("64 MB"));
}

#[test]
fn import_assets_rejects_invalid_destination_without_touching_images() {
    let dir = tempfile::tempdir().unwrap();
    for name in ["original.hwp", "original.hwpx", "not-markdown.txt"] {
        let path = dir.path().join(name);
        fs::write(&path, b"original").unwrap();
        assert!(save_imported_markdown_as(&path, CONTENT, &[image("a.png")], None).is_err());
        assert_eq!(fs::read(path).unwrap(), b"original");
    }
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 3);
}

#[test]
fn import_assets_existing_markdown_publication_updates_watcher_baseline() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("existing.md");
    fs::write(&path, b"old").unwrap();
    let baseline = Mutex::new("old-hash".into());
    let saved = save_imported_markdown_as(&path, CONTENT, &[image("img-001.png")], Some(&baseline))
        .unwrap();
    assert_eq!(*baseline.lock().unwrap(), saved.saved.hash);
    assert_eq!(read_markdown(&path).unwrap().hash, saved.saved.hash);
}

#[cfg(unix)]
#[test]
fn import_assets_does_not_follow_colliding_asset_directory_symlinks() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let foreign = tempfile::tempdir().unwrap();
    fs::write(foreign.path().join("img-001.png"), b"foreign").unwrap();
    symlink(foreign.path(), dir.path().join("a.assets")).unwrap();
    let saved = save_imported_markdown_as(
        &dir.path().join("a.md"),
        CONTENT,
        &[image("img-001.png")],
        None,
    )
    .unwrap();
    assert_eq!(saved.assets_dir, "a.assets-2");
    assert_eq!(
        fs::read(foreign.path().join("img-001.png")).unwrap(),
        b"foreign"
    );
}

#[test]
fn import_assets_binary_packet_decodes_exact_bytes_and_refuses_bad_framing() {
    let metadata = serde_json::json!({"content": CONTENT, "suggestedName": "보고서.md", "assets": [
        {"name": "img-001.png", "mimeType": "image/png", "byteLength": 6}
    ]})
    .to_string()
    .into_bytes();
    let mut packet = (metadata.len() as u32).to_le_bytes().to_vec();
    packet.extend(metadata);
    packet.extend(&image("img-001.png").bytes);
    let (content, name, assets) = decode_import_packet(&packet).unwrap();
    assert_eq!(content, CONTENT);
    assert_eq!(name, "보고서.md");
    assert_eq!(assets[0].bytes, image("img-001.png").bytes);
    assert!(decode_import_packet(&packet[..packet.len() - 1]).is_err());
    packet.push(0);
    assert!(decode_import_packet(&packet).is_err());
    for bad in [vec![], vec![255; 4], vec![0; 4]] {
        assert!(decode_import_packet(&bad).is_err());
    }
}

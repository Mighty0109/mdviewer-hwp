use super::*;
use std::fs;

#[test] fn docx_atomic_path_and_bytes() { let d = tempfile::tempdir().unwrap(); assert!(file_service::write_docx_atomic(&d.path().join("bad.hwpx"), b"PKok").is_err()); let p = d.path().join("ok.docx"); file_service::write_docx_atomic(&p, b"PKok").unwrap(); assert_eq!(fs::read(p).unwrap(), b"PKok"); }
#[test] fn md_docx_rejects_empty() { assert!(validate_markdown_docx(b"").is_err()); }
#[test] fn md_docx_rejects_non_zip() { assert!(validate_markdown_docx(b"bad").is_err()); }
#[test] fn md_docx_rejects_oversize() { assert!(validate_markdown_docx(&vec![0; MAX_OUTPUT as usize + 1]).is_err()); }
#[test] fn md_docx_accepts_zip() { assert!(validate_markdown_docx(b"PKok").is_ok()); }
#[test] fn md_docx_names() { assert_eq!(markdown_docx_name("a/b/문서.md"), PathBuf::from("문서.docx")); assert_eq!(markdown_docx_name(""), PathBuf::from("Untitled.docx")); assert_eq!(markdown_docx_name("x.docx"), PathBuf::from("x.docx")); }

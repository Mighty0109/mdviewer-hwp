use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    process::Command,
};

pub const OPEN_PROGRAM: &str = "/usr/bin/open";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Delivery {
    Current,
    Launched,
    Fallback(String),
}

pub fn bundle_path(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    if macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.extension()? == "app"
    {
        Some(bundle.to_path_buf())
    } else {
        None
    }
}

pub fn open_args(bundle: &Path, file: &Path) -> Vec<OsString> {
    vec![
        "-n".into(),
        "-a".into(),
        bundle.as_os_str().to_owned(),
        file.as_os_str().to_owned(),
    ]
}

pub fn route<L>(
    occupied: bool,
    bundle: Option<&Path>,
    files: &[PathBuf],
    mut launch: L,
) -> Vec<Delivery>
where
    L: FnMut(&Path, &[OsString]) -> Result<(), String>,
{
    let mut sent_here = false;
    files
        .iter()
        .map(|file| {
            let delivery = match bundle {
                Some(bundle) if occupied || sent_here => {
                    match launch(Path::new(OPEN_PROGRAM), &open_args(bundle, file)) {
                        Ok(()) => Delivery::Launched,
                        Err(error) => Delivery::Fallback(error),
                    }
                }
                _ => Delivery::Current,
            };
            if delivery != Delivery::Launched {
                sent_here = true;
            }
            delivery
        })
        .collect()
}

pub fn launch(program: &Path, args: &[OsString]) -> Result<(), String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let excerpt: String = stderr.chars().take(512).collect();
        Err(format!("{}: {}", output.status, excerpt.trim()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn new_instance_occupied_app_launches_open_with_bundle_and_file() {
        let bundle = Path::new("/Applications/MDViewer.app");
        let file = PathBuf::from("/tmp/b.md");
        let mut calls = Vec::new();
        let result = route(
            true,
            Some(bundle),
            std::slice::from_ref(&file),
            |program, args| {
                calls.push((program.to_path_buf(), args.to_vec()));
                Ok(())
            },
        );
        assert_eq!(result, [Delivery::Launched]);
        assert_eq!(
            calls,
            [(
                PathBuf::from("/usr/bin/open"),
                vec![
                    "-n".into(),
                    "-a".into(),
                    bundle.as_os_str().to_owned(),
                    file.into_os_string()
                ]
            )]
        );
    }

    #[test]
    fn new_instance_empty_app_opens_here_without_launching() {
        let mut calls = 0;
        let result = route(
            false,
            Some(Path::new("/Applications/MDViewer.app")),
            &["/tmp/a.md".into()],
            |_, _| {
                calls += 1;
                Ok(())
            },
        );
        assert_eq!(result, [Delivery::Current]);
        assert_eq!(calls, 0);
    }

    #[test]
    fn new_instance_without_bundle_opens_here() {
        let mut calls = 0;
        let result = route(true, None, &["/tmp/a.md".into()], |_, _| {
            calls += 1;
            Ok(())
        });
        assert_eq!(result, [Delivery::Current]);
        assert_eq!(calls, 0);
    }

    #[test]
    fn new_instance_launch_failure_falls_back_with_error() {
        let mut calls = 0;
        let result = route(
            true,
            Some(Path::new("/Applications/MDViewer.app")),
            &["/tmp/a.md".into()],
            |_, _| {
                calls += 1;
                Err("boom".into())
            },
        );
        assert_eq!(result, [Delivery::Fallback("boom".into())]);
        assert_eq!(calls, 1);
    }

    #[test]
    fn new_instance_args_keep_special_paths_as_single_arguments() {
        let bundle = Path::new("/Applications/My MD Viewer.app");
        let file = Path::new("/tmp/내 문서 \"따옴표\" 'x'.md");
        assert_eq!(
            open_args(bundle, file),
            [
                OsString::from("-n"),
                OsString::from("-a"),
                bundle.as_os_str().to_owned(),
                file.as_os_str().to_owned()
            ]
        );
    }

    #[test]
    fn new_instance_bundle_path_only_inside_app_bundle() {
        assert_eq!(
            bundle_path(Path::new(
                "/Applications/MDViewer.app/Contents/MacOS/mdviewer"
            )),
            Some(PathBuf::from("/Applications/MDViewer.app"))
        );
        for path in [
            "/Users/x/Code/mdviewer/src-tauri/target/debug/mdviewer",
            "/tmp/Fake.app/mdviewer",
            "/tmp/Plain/Contents/MacOS/mdviewer",
            "/tmp/X.app/Contents/Resources/mdviewer",
            "mdviewer",
        ] {
            assert_eq!(bundle_path(Path::new(path)), None, "{path}");
        }
    }

    #[test]
    fn new_instance_batch_opens_first_here_and_rest_in_new_apps() {
        let files: Vec<PathBuf> = ["/tmp/a.md", "/tmp/b.md", "/tmp/c.md"]
            .iter()
            .map(PathBuf::from)
            .collect();
        let mut calls = Vec::new();
        let result = route(
            false,
            Some(Path::new("/Applications/MDViewer.app")),
            &files,
            |_, args| {
                calls.push(args.to_vec());
                Ok(())
            },
        );
        assert_eq!(
            result,
            [Delivery::Current, Delivery::Launched, Delivery::Launched]
        );
        assert_eq!(
            calls.iter().map(|args| args[3].clone()).collect::<Vec<_>>(),
            [files[1].as_os_str(), files[2].as_os_str()]
        );
        let result = route(false, None, &files[..2], |_, _| panic!("must not launch"));
        assert_eq!(result, [Delivery::Current, Delivery::Current]);
    }

    #[test]
    fn new_instance_batch_fallback_keeps_later_files_routed_to_new_apps() {
        let files: Vec<PathBuf> = ["/tmp/a.md", "/tmp/b.md"]
            .iter()
            .map(PathBuf::from)
            .collect();
        let mut calls = 0;
        let result = route(
            true,
            Some(Path::new("/Applications/MDViewer.app")),
            &files,
            |_, _| {
                calls += 1;
                if calls == 1 {
                    Err("boom".into())
                } else {
                    Ok(())
                }
            },
        );
        assert_eq!(
            result,
            [Delivery::Fallback("boom".into()), Delivery::Launched]
        );
        assert_eq!(calls, 2);
    }
}

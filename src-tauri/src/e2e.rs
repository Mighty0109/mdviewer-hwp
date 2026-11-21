//! An opt-in test observation channel. Its destination comes only from launch-time env.
use serde::Serialize;
use std::{
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eConfig {
    pub state_path: String,
    pub query: String,
    pub edit: Option<String>,
    pub save_gate: Option<String>,
    pub import_path: Option<String>,
    pub import_save_as: Option<String>,
    pub export_path: Option<String>,
}

impl E2eConfig {
    pub fn from_env() -> Option<Self> {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Option<Self> {
        let mut config = Self::from_values(
            get("MDVIEWER_E2E_STATE"),
            get("MDVIEWER_E2E_QUERY"),
            get("MDVIEWER_E2E_EDIT"),
            get("MDVIEWER_E2E_SAVE_GATE"),
        )?;
        let absolute =
            |value: Option<String>| value.filter(|p| !p.is_empty() && Path::new(p).is_absolute());
        config.import_path = absolute(get("MDVIEWER_E2E_IMPORT"));
        config.import_save_as = absolute(get("MDVIEWER_E2E_IMPORT_SAVE"));
        config.export_path = absolute(get("MDVIEWER_E2E_EXPORT"));
        Some(config)
    }

    fn from_values(
        state_path: Option<String>,
        query: Option<String>,
        edit: Option<String>,
        save_gate: Option<String>,
    ) -> Option<Self> {
        let state_path = state_path.filter(|p| !p.is_empty() && Path::new(p).is_absolute())?;
        Some(Self {
            state_path,
            query: query?,
            edit,
            save_gate: save_gate.filter(|p| !p.is_empty()),
            import_path: None,
            import_save_as: None,
            export_path: None,
        })
    }
}

pub fn gate_open(config: Option<&E2eConfig>) -> bool {
    config
        .and_then(|config| config.save_gate.as_deref())
        .is_none_or(|path| Path::new(path).exists())
}

pub fn report(config: Option<&E2eConfig>, json: &str) -> Result<(), String> {
    let Some(config) = config else {
        return Ok(());
    };
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("Invalid e2e JSON: {e}"))?;
    let path = PathBuf::from(&config.state_path);
    let parent = path
        .parent()
        .ok_or("E2e state path needs a parent directory")?;
    let mut file = tempfile::NamedTempFile::new_in(parent)
        .map_err(|e| format!("Cannot create e2e state: {e}"))?;
    serde_json::to_writer(&mut file, &value)
        .map_err(|e| format!("Cannot serialize e2e state: {e}"))?;
    file.flush()
        .map_err(|e| format!("Cannot flush e2e state: {e}"))?;
    file.persist(&path)
        .map_err(|e| format!("Cannot publish e2e state: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn e2e_import_reads_launch_environment_keys_and_serializes_contract() {
        let config = E2eConfig::from_lookup(|name| match name {
            "MDVIEWER_E2E_STATE" => Some("/tmp/state.json".into()),
            "MDVIEWER_E2E_QUERY" => Some("".into()),
            "MDVIEWER_E2E_IMPORT" => Some("/tmp/한글 문서.hwp".into()),
            "MDVIEWER_E2E_IMPORT_SAVE" => Some("/tmp/새 문서.md".into()),
            "MDVIEWER_E2E_EXPORT" => Some("/tmp/내보내기.hwpx".into()),
            _ => None,
        })
        .unwrap();
        let value = serde_json::to_value(config).unwrap();
        assert_eq!(value["importPath"], "/tmp/한글 문서.hwp");
        assert_eq!(value["importSaveAs"], "/tmp/새 문서.md");
        assert_eq!(value["exportPath"], "/tmp/내보내기.hwpx");
    }

    #[test]
    fn e2e_import_absent_or_invalid_paths_are_none_and_hooks_require_opt_in() {
        assert!(E2eConfig::from_lookup(|_| None).is_none());
        for path in [None, Some("".into()), Some("relative.hwp".into())] {
            let config = E2eConfig::from_lookup(|name| match name {
                "MDVIEWER_E2E_STATE" => Some("/tmp/state.json".into()),
                "MDVIEWER_E2E_QUERY" => Some("".into()),
                _ => path.clone(),
            })
            .unwrap();
            assert!(config.import_path.is_none());
            assert!(config.import_save_as.is_none());
            assert!(config.export_path.is_none());
        }
    }

    #[test]
    fn requires_explicit_environment_configuration_and_is_otherwise_noop() {
        assert!(E2eConfig::from_values(None, Some("x".into()), None, None).is_none());
        assert!(E2eConfig::from_values(Some("/tmp/state".into()), None, None, None).is_none());
        assert!(
            E2eConfig::from_values(Some("relative".into()), Some("x".into()), None, None).is_none()
        );
        assert!(report(None, "not json").is_ok());
        assert!(gate_open(None));
    }
    #[test]
    fn atomically_replaces_valid_json_without_publishing_invalid_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let config = E2eConfig::from_values(
            Some(path.to_str().unwrap().into()),
            Some("한글".into()),
            None,
            None,
        )
        .unwrap();
        report(Some(&config), r#"{"loadCount":1}"#).unwrap();
        report(Some(&config), r#"{"loadCount":2}"#).unwrap();
        assert!(report(Some(&config), "invalid").is_err());
        let value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(value["loadCount"], 2);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn edit_and_save_gate_are_opt_in_and_use_camel_case_contract() {
        let dir = tempfile::tempdir().unwrap();
        let gate = dir.path().join("save.gate");
        let mut config = E2eConfig::from_values(
            Some(dir.path().join("state.json").to_str().unwrap().into()),
            Some("query".into()),
            Some("추가할 한 줄".into()),
            Some(gate.to_str().unwrap().into()),
        )
        .unwrap();
        assert!(!gate_open(Some(&config)));
        std::fs::write(&gate, "").unwrap();
        assert!(gate_open(Some(&config)));
        let json = serde_json::to_value(&config).unwrap();
        assert_eq!(json["edit"], "추가할 한 줄");
        assert_eq!(json["saveGate"], gate.to_str().unwrap());
        config.save_gate = None;
        assert!(gate_open(Some(&config)));
    }
}

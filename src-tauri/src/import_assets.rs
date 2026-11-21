//! First-save transaction for in-memory import images. Source documents are never opened here.
use super::*;
use serde::Deserialize;
use std::collections::HashSet;

pub const IMPORT_ASSET_PREFIX: &str = "mdviewer-import-assets/";
const MAX_ASSETS: usize = 500;
const MAX_ASSET_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug)]
pub struct ImportAsset {
    pub name: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedImportedMarkdown {
    #[serde(flatten)]
    pub saved: SavedMarkdown,
    /// Relative, unencoded directory name. Both runtimes encode this as one URL segment.
    pub assets_dir: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PacketMetadata {
    content: String,
    suggested_name: String,
    assets: Vec<AssetMetadata>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AssetMetadata {
    name: String,
    mime_type: String,
    byte_length: usize,
}

/// Wire format: u32 LE JSON byte length, UTF-8 metadata, then concatenated image
/// bytes in descriptor order. No JSON byte arrays/base64 or temporary disk staging.
pub fn decode_import_packet(packet: &[u8]) -> Result<(String, String, Vec<ImportAsset>), String> {
    if packet.len() < 4 || packet.len() > MAX_ASSET_BYTES + MAX_BYTES as usize + 4 {
        return Err("Invalid imported asset packet size".into());
    }
    let length = u32::from_le_bytes(packet[..4].try_into().unwrap()) as usize;
    if length > MAX_BYTES as usize || length > packet.len() - 4 {
        return Err("Invalid imported asset metadata length".into());
    }
    let metadata: PacketMetadata = serde_json::from_slice(&packet[4..4 + length])
        .map_err(|_| "Invalid imported asset metadata")?;
    let mut cursor = 4 + length;
    if metadata.assets.len() > MAX_ASSETS {
        return Err("Imported images exceed the 500 image limit".into());
    }
    let mut assets = Vec::with_capacity(metadata.assets.len());
    for asset in metadata.assets {
        if asset.byte_length > MAX_DOCUMENT_IMAGE_BYTES as usize
            || asset.byte_length > packet.len() - cursor
        {
            return Err("Invalid imported image byte length (maximum 8 MB)".into());
        }
        let end = cursor + asset.byte_length;
        assets.push(ImportAsset {
            name: asset.name,
            mime_type: asset.mime_type,
            bytes: packet[cursor..end].to_vec(),
        });
        cursor = end;
    }
    if cursor != packet.len() {
        return Err("Unexpected trailing imported asset bytes".into());
    }
    validate_import_assets(&metadata.content, &assets)?;
    Ok((metadata.content, metadata.suggested_name, assets))
}

pub fn validate_import_assets(content: &str, assets: &[ImportAsset]) -> Result<(), String> {
    validate_content(content)?;
    if assets.len() > MAX_ASSETS {
        return Err("Imported images exceed the 500 image limit".into());
    }
    let mut total = 0usize;
    let mut names = HashSet::new();
    for asset in assets {
        // Parser-created names are ASCII basenames. Refuse traversal, URL syntax,
        // whitespace and platform separators rather than attempting to sanitize them.
        if asset.name.starts_with('.')
            || !asset
                .name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
            || asset.name.is_empty()
            || asset.name.len() > 200
            || !names.insert(asset.name.to_lowercase())
        {
            return Err("Invalid or duplicate imported image name".into());
        }
        let mime = match Path::new(&asset.name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str()
        {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "bmp" => "image/bmp",
            _ => return Err("Unsupported imported image extension".into()),
        };
        if mime != asset.mime_type {
            return Err("Imported image MIME type does not match its extension".into());
        }
        if asset.bytes.is_empty() || asset.bytes.len() > MAX_DOCUMENT_IMAGE_BYTES as usize {
            return Err("Imported images must contain 1 byte to 8 MB each".into());
        }
        total += asset.bytes.len();
        if total > MAX_ASSET_BYTES {
            return Err("Imported images exceed the 64 MB total limit".into());
        }
    }
    Ok(())
}

/// RFC 3986 segment encoding; also escape Markdown's parentheses. Mirrors TS.
pub fn encode_asset_segment(name: &str) -> String {
    let mut encoded = String::new();
    for b in name.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            encoded.push(b as char);
        } else {
            encoded.push_str(&format!("%{b:02X}"));
        }
    }
    encoded
}

pub fn save_imported_markdown_as(
    path: &Path,
    content: &str,
    assets: &[ImportAsset],
    baseline: Option<&Mutex<String>>,
) -> Result<SavedImportedMarkdown, String> {
    validate_import_assets(content, assets)?;
    let canonical = validate_save_path(path)?;
    let parent = canonical
        .parent()
        .ok_or("The document needs a parent directory")?;
    let stem = canonical
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("Invalid document name")?;
    let mut suffix = 1u32;
    let (folder, name) = loop {
        let name = if suffix == 1 {
            format!("{stem}.assets")
        } else {
            format!("{stem}.assets-{suffix}")
        };
        let folder = parent.join(&name);
        match fs::create_dir(&folder) {
            Ok(()) => break (folder, name),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                suffix = suffix
                    .checked_add(1)
                    .ok_or("Too many asset directory collisions")?;
            }
            Err(error) => return Err(format!("Cannot create imported image directory: {error}")),
        }
    };
    let mut created = Vec::new();
    let result = (|| {
        for asset in assets {
            let destination = folder.join(&asset.name);
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&destination)
                .map_err(|e| format!("Cannot create imported image: {e}"))?;
            created.push(destination);
            file.write_all(&asset.bytes)
                .map_err(|e| format!("Cannot write imported image: {e}"))?;
            file.sync_all()
                .map_err(|e| format!("Cannot sync imported image: {e}"))?;
        }
        let rewritten = content.replace(
            IMPORT_ASSET_PREFIX,
            &format!("{}/", encode_asset_segment(&name)),
        );
        // Existing phase-two publication, overwrite approval and conflict semantics.
        let saved = super::save_markdown_as(path, &rewritten, baseline)?;
        Ok(SavedImportedMarkdown {
            saved,
            assets_dir: name,
        })
    })();
    if result.is_err() {
        // Never remove pre-existing siblings or recursively delete foreign files.
        for file in created {
            let _ = fs::remove_file(file);
        }
        let _ = fs::remove_dir(&folder);
    }
    result
}

#[cfg(test)]
#[path = "import_assets_tests.rs"]
mod tests;

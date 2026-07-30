//! User-imported document reading (M52, D18).
//!
//! The ONLY new IPC this milestone adds: a LOCAL text-file read with a hard byte
//! cap. It reads a `.txt`/`.md` file from disk, validates the extension, rejects
//! anything over the cap, and returns UTF-8 text (lossy-safe). It NEVER uploads —
//! imported docs stay on the machine (D18).
//!
//! The imported text then flows through the EXACT SAME retrieval →
//! `sanitize_retrieved_docs` → `<retrieved_docs untrusted>` fence as trusted
//! packs (see [`crate::commands::ai`]). There is NO second, weaker path for
//! imported content: it inherits every prompt-injection / redaction / length
//! bound (`MAX_RETRIEVED_DOCS`, `MAX_EXCERPT_CHARS`, `cap_and_neutralize`,
//! `scrub_value`) that trusted retrieved docs get, and the closed
//! `suggestable_rule` allowlist means nothing an imported doc says can widen the
//! set of applyable config suggestions.

use std::path::Path;

/// Hard cap on an imported doc's size (bytes). Mirrors the TypeScript
/// `MAX_IMPORTED_DOC_BYTES` in `src/lib/knowledge/import.ts` — the two must stay
/// in lockstep. A file over this is rejected via its metadata length BEFORE its
/// content is read into memory.
const MAX_IMPORTED_DOC_BYTES: u64 = 256 * 1024;

/// Extensions accepted for import (text/Markdown only — DI-3; PDF deferred).
/// Mirrors `ALLOWED_IMPORT_EXTENSIONS` on the TS side.
const ALLOWED_IMPORT_EXTENSIONS: &[&str] = &["txt", "md", "markdown"];

/// True when `path` ends in an allowed import extension (case-insensitive).
fn extension_allowed(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| ALLOWED_IMPORT_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Read a LOCAL text file for import (M52, D18).
///
/// Validates the extension against the allowlist, enforces the byte cap via the
/// file metadata (so an oversize file is rejected WITHOUT being read into memory),
/// and returns UTF-8 text — LOSSY, so invalid bytes become the replacement char
/// and a mangled file can't error the import. It NEVER uploads anything; the only
/// side effect is a local read. All error strings are English dev detail; the
/// frontend maps failures to a localized message.
#[tauri::command]
pub fn knowledge_read_doc(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    if !extension_allowed(p) {
        return Err("unsupported file type: only .txt/.md/.markdown may be imported".into());
    }
    let meta = std::fs::metadata(p).map_err(|e| format!("cannot read file: {e}"))?;
    if !meta.is_file() {
        return Err("not a regular file".into());
    }
    if meta.len() > MAX_IMPORTED_DOC_BYTES {
        return Err(format!(
            "file too large: {} bytes exceeds the {MAX_IMPORTED_DOC_BYTES}-byte import cap",
            meta.len()
        ));
    }
    let bytes = std::fs::read(p).map_err(|e| format!("cannot read file: {e}"))?;
    // Defense in depth: a race could grow the file between the metadata check and
    // the read, so re-check the actual byte count before returning.
    if bytes.len() as u64 > MAX_IMPORTED_DOC_BYTES {
        return Err("file too large: exceeds the import byte cap".into());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    /// A unique temp path (no external crate) so parallel tests never collide.
    fn temp_path(ext: &str) -> PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "omnilink-import-{}-{nanos}-{n}.{ext}",
            std::process::id()
        ))
    }

    #[test]
    fn extension_allowlist_accepts_only_text_and_markdown() {
        for good in [
            "note.txt",
            "manual.md",
            "GUIDE.MD",
            "readme.markdown",
            "a/b/c.Txt",
        ] {
            assert!(extension_allowed(Path::new(good)), "should accept {good}");
        }
        for bad in [
            "manual.pdf",
            "note.exe",
            "config.json",
            "image.png",
            "noext",
            "archive.tar.gz",
        ] {
            assert!(!extension_allowed(Path::new(bad)), "should reject {bad}");
        }
    }

    #[test]
    fn reads_a_local_text_file() {
        let path = temp_path("md");
        std::fs::write(&path, "# Title\n\nBody line.").unwrap();
        let out = knowledge_read_doc(path.to_string_lossy().into_owned()).unwrap();
        assert!(out.contains("# Title"));
        assert!(out.contains("Body line."));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn rejects_a_disallowed_extension() {
        let path = temp_path("pdf");
        std::fs::write(&path, "not really a pdf").unwrap();
        let err = knowledge_read_doc(path.to_string_lossy().into_owned()).unwrap_err();
        assert!(err.contains("unsupported file type"));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn rejects_a_file_over_the_byte_cap() {
        let path = temp_path("txt");
        let mut f = std::fs::File::create(&path).unwrap();
        // One byte over the cap.
        let big = vec![b'a'; (MAX_IMPORTED_DOC_BYTES as usize) + 1];
        f.write_all(&big).unwrap();
        f.flush().unwrap();
        let err = knowledge_read_doc(path.to_string_lossy().into_owned()).unwrap_err();
        assert!(err.contains("too large"));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn invalid_utf8_is_read_lossily_not_errored() {
        let path = temp_path("txt");
        // 0xff is never valid UTF-8; the lossy read must substitute, not fail.
        std::fs::write(&path, [b'o', b'k', 0xff, b'!']).unwrap();
        let out = knowledge_read_doc(path.to_string_lossy().into_owned()).unwrap();
        assert!(out.starts_with("ok"));
        assert!(out.contains('\u{FFFD}'));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn rejects_a_missing_file() {
        let path = temp_path("txt"); // never created
        assert!(knowledge_read_doc(path.to_string_lossy().into_owned()).is_err());
    }
}

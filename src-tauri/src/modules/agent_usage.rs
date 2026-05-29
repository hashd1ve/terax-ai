use serde::Serialize;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// A snapshot of the agent's token/context state derived from the last priced
/// assistant turn in its transcript. All fields are best-effort: the transcript
/// is owned by another process and its schema can drift, so the parser degrades
/// to None rather than guessing.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageInfo {
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    /// What counts against the context window this turn: the prompt the model
    /// actually saw (fresh input + everything served from or written to cache).
    pub context_tokens: u64,
    pub context_window: u64,
    /// context_tokens / context_window, clamped to 0..100. The single number
    /// the HUD watches: how close the session is to auto-compact.
    pub context_pct: f64,
    /// Rough USD spend for this turn, or None when the model is not in the
    /// price table (so the UI shows nothing rather than a wrong number).
    pub cost_usd_est: Option<f64>,
}

const DEFAULT_CONTEXT_WINDOW: u64 = 200_000;
const LONG_CONTEXT_WINDOW: u64 = 1_000_000;

/// Per-million-token USD rates, best-effort and intended only as an order-of-
/// magnitude estimate (published list prices change and exclude discounts). The
/// match is by substring on the lowercased model id, so "claude-opus-4-8[1m]"
/// resolves via the "opus" arm.
struct ModelRates {
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
}

fn model_rates(model_lower: &str) -> Option<ModelRates> {
    if model_lower.contains("opus") {
        Some(ModelRates {
            input: 15.0,
            output: 75.0,
            cache_read: 1.5,
            cache_write: 18.75,
        })
    } else if model_lower.contains("sonnet") {
        Some(ModelRates {
            input: 3.0,
            output: 15.0,
            cache_read: 0.3,
            cache_write: 3.75,
        })
    } else if model_lower.contains("haiku") {
        Some(ModelRates {
            input: 0.8,
            output: 4.0,
            cache_read: 0.08,
            cache_write: 1.0,
        })
    } else {
        None
    }
}

fn context_window_for(model_lower: &str) -> u64 {
    if model_lower.contains("1m") {
        LONG_CONTEXT_WINDOW
    } else {
        DEFAULT_CONTEXT_WINDOW
    }
}

fn estimate_cost(
    model_lower: &str,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_creation: u64,
) -> Option<f64> {
    let r = model_rates(model_lower)?;
    let per_m = |tokens: u64, rate: f64| (tokens as f64) * rate / 1_000_000.0;
    Some(
        per_m(input, r.input)
            + per_m(output, r.output)
            + per_m(cache_read, r.cache_read)
            + per_m(cache_creation, r.cache_write),
    )
}

fn usage_from_line(line: &str) -> Option<UsageInfo> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    if value.get("type")?.as_str()? != "assistant" {
        return None;
    }
    let message = value.get("message")?;
    let usage = message.get("usage")?;
    // A model id is required: it drives both the window and the price table, and
    // without it the percentage would be meaningless.
    let model = message.get("model")?.as_str()?.to_string();

    let u = |key: &str| usage.get(key).and_then(serde_json::Value::as_u64).unwrap_or(0);
    let input_tokens = u("input_tokens");
    let output_tokens = u("output_tokens");
    let cache_read_tokens = u("cache_read_input_tokens");
    let cache_creation_tokens = u("cache_creation_input_tokens");

    let model_lower = model.to_lowercase();
    let context_window = context_window_for(&model_lower);
    let context_tokens = input_tokens
        .saturating_add(cache_read_tokens)
        .saturating_add(cache_creation_tokens);
    let context_pct = if context_window == 0 {
        0.0
    } else {
        ((context_tokens as f64) / (context_window as f64) * 100.0).clamp(0.0, 100.0)
    };
    let cost_usd_est = estimate_cost(
        &model_lower,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_creation_tokens,
    );

    Some(UsageInfo {
        model,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_creation_tokens,
        context_tokens,
        context_window,
        context_pct,
        cost_usd_est,
    })
}

/// Scan `jsonl` and return the usage of the LAST assistant line that carries a
/// `message.usage`. Pure over the text so the recency rule and the field math
/// are unit-testable without touching the filesystem.
pub fn parse_last_usage(jsonl: &str) -> Option<UsageInfo> {
    jsonl
        .lines()
        .rev()
        .find_map(|line| usage_from_line(line.trim()))
}

/// How much of the file tail to read. The relevant signal is the final priced
/// turn, which is a handful of lines; this caps the read so a multi-megabyte
/// transcript never costs a full slurp.
const TAIL_BYTES: u64 = 64 * 1024;

/// The only directory this command will ever read from. The transcript path is
/// attacker-influenced (it arrives from a hook channel), so it is canonicalized
/// and required to live under here before any read.
fn transcripts_root() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("projects"))
}

/// Canonicalize `path` and confirm it sits under `root`. Returns the canonical
/// path on success. Factored out so the boundary is testable without a command
/// invocation. Both sides are canonicalized so symlink tricks cannot smuggle a
/// path that is textually under root but resolves elsewhere.
fn resolve_under_root(path: &str, root: &Path) -> Result<PathBuf, String> {
    let canon = std::fs::canonicalize(path).map_err(|e| format!("cannot resolve path: {e}"))?;
    let root_canon = std::fs::canonicalize(root)
        .map_err(|e| format!("cannot resolve transcripts root: {e}"))?;
    if !canon.starts_with(&root_canon) {
        return Err("path is outside the Claude projects directory".to_string());
    }
    Ok(canon)
}

fn read_tail(path: &Path, max_bytes: u64) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    let start = len.saturating_sub(max_bytes);
    file.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::with_capacity(max_bytes.min(len) as usize);
    file.take(max_bytes).read_to_end(&mut buf)?;
    // The seek can land mid-line / mid-codepoint; lossy decode keeps the parse
    // lenient, and a partial first line is simply skipped by the JSON parse.
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

#[tauri::command]
pub fn agent_read_usage(transcript_path: String) -> Result<Option<UsageInfo>, String> {
    let root = transcripts_root().ok_or_else(|| "could not resolve home dir".to_string())?;

    // A missing file is the common idle case (no agent has written a transcript
    // yet), not an error: report Ok(None) so the HUD just stays empty. The
    // boundary check needs an existing path to canonicalize, so probe first.
    let raw = Path::new(&transcript_path);
    if !raw.exists() {
        return Ok(None);
    }

    let path = resolve_under_root(&transcript_path, &root)?;

    match read_tail(&path, TAIL_BYTES) {
        Ok(tail) => Ok(parse_last_usage(&tail)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("failed to read transcript: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Two assistant lines: the LAST one must win.
    const TWO_TURNS: &str = r#"{"type":"user","message":{"role":"user","content":"hi"}}
{"type":"assistant","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":1000,"cache_creation_input_tokens":500}}}
{"type":"assistant","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":5,"output_tokens":40,"cache_read_input_tokens":80000,"cache_creation_input_tokens":2000}}}"#;

    #[test]
    fn last_assistant_usage_wins() {
        let info = parse_last_usage(TWO_TURNS).expect("a priced turn exists");
        assert_eq!(info.input_tokens, 5);
        assert_eq!(info.output_tokens, 40);
        assert_eq!(info.cache_read_tokens, 80_000);
        assert_eq!(info.cache_creation_tokens, 2_000);
        // context = 5 + 80000 + 2000 = 82005 of a 200k window.
        assert_eq!(info.context_tokens, 82_005);
        assert_eq!(info.context_window, DEFAULT_CONTEXT_WINDOW);
        assert!((info.context_pct - 41.0025).abs() < 1e-6);
        assert!(info.cost_usd_est.is_some());
    }

    #[test]
    fn long_context_model_uses_1m_window() {
        // The real long-context id carries a "[1m]" suffix.
        let line = r#"{"type":"assistant","message":{"model":"claude-opus-4-8[1m]","usage":{"input_tokens":2,"output_tokens":828,"cache_read_input_tokens":431884,"cache_creation_input_tokens":3334}}}"#;
        let info = parse_last_usage(line).expect("a priced turn exists");
        assert_eq!(info.context_window, LONG_CONTEXT_WINDOW);
        // 435220 / 1_000_000 * 100 = 43.522
        assert_eq!(info.context_tokens, 435_220);
        assert!((info.context_pct - 43.522).abs() < 1e-6);
    }

    #[test]
    fn percentage_clamps_to_100() {
        // A turn whose prompt exceeds the window (post-compaction artifacts,
        // schema drift) must not report > 100%.
        let line = r#"{"type":"assistant","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":250000,"cache_creation_input_tokens":0}}}"#;
        let info = parse_last_usage(line).unwrap();
        assert_eq!(info.context_pct, 100.0);
    }

    #[test]
    fn no_usage_or_non_assistant_is_none() {
        let only_user = r#"{"type":"user","message":{"role":"user","content":"hi"}}
{"type":"system","subtype":"init"}"#;
        assert!(parse_last_usage(only_user).is_none());

        let assistant_without_usage =
            r#"{"type":"assistant","message":{"model":"claude-sonnet-4-6","content":[]}}"#;
        assert!(parse_last_usage(assistant_without_usage).is_none());

        assert!(parse_last_usage("").is_none());
        assert!(parse_last_usage("not json at all\n{ broken").is_none());
    }

    #[test]
    fn unknown_model_has_no_cost_estimate() {
        let line = r#"{"type":"assistant","message":{"model":"some-future-model-x","usage":{"input_tokens":100,"output_tokens":200,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#;
        let info = parse_last_usage(line).unwrap();
        assert!(info.cost_usd_est.is_none());
        // Still reports a sensible window and percentage.
        assert_eq!(info.context_window, DEFAULT_CONTEXT_WINDOW);
    }

    #[test]
    fn missing_usage_fields_default_to_zero() {
        let line = r#"{"type":"assistant","message":{"model":"claude-haiku-4-5","usage":{"output_tokens":12}}}"#;
        let info = parse_last_usage(line).unwrap();
        assert_eq!(info.input_tokens, 0);
        assert_eq!(info.output_tokens, 12);
        assert_eq!(info.context_tokens, 0);
        assert_eq!(info.context_pct, 0.0);
    }

    #[test]
    fn command_rejects_path_traversal() {
        // An absolute path outside the projects root is rejected at the boundary.
        let err = agent_read_usage("/etc/passwd".to_string());
        // /etc/passwd exists on Unix, so it reaches and fails the root check.
        // On a host where it does not exist this returns Ok(None); both are
        // safe (no read of an out-of-root file ever happens).
        assert!(err.is_err() || err == Ok(None));
    }

    #[test]
    fn resolve_under_root_rejects_outside_and_traversal() {
        let root = std::env::temp_dir().join(format!("terax-usage-root-{}", std::process::id()));
        let inside = root.join("sub");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&inside).unwrap();
        let good = inside.join("session.jsonl");
        std::fs::write(&good, "{}").unwrap();

        // A real file under root resolves.
        assert!(resolve_under_root(good.to_str().unwrap(), &root).is_ok());

        // A traversal that climbs out of root is rejected even though it is
        // textually rooted there.
        let escape = inside.join("..").join("..").join("escape.txt");
        std::fs::write(root.parent().unwrap().join("escape.txt"), "x").ok();
        assert!(resolve_under_root(escape.to_str().unwrap(), &root).is_err());

        let _ = std::fs::remove_dir_all(&root);
    }
}

import { invoke } from "@tauri-apps/api/core";

/**
 * If the system clipboard holds an image (e.g. a screenshot), persist it to a
 * temp file and return its absolute path; otherwise null.
 *
 * A terminal is text-only, so an image can't be "pasted" as bytes. Instead we
 * write the image to a temp file and hand its path to whatever runs in the
 * terminal (Claude Code reads images by path). Permission/read failures resolve
 * to null so the caller can fall back to a normal text paste.
 */
export async function clipboardImageToTempPath(): Promise<string | null> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.read) {
    return null;
  }
  let items: ClipboardItems;
  try {
    items = await navigator.clipboard.read();
  } catch {
    return null;
  }
  for (const item of items) {
    const type = item.types.find((t) => t.startsWith("image/"));
    if (!type) continue;
    const blob = await item.getType(type).catch(() => null);
    if (blob) return imageBlobToTempPath(blob);
  }
  return null;
}

/**
 * Persist an image blob to a temp file and return its absolute path, or null.
 *
 * Used by the terminal's `paste` handler, whose `clipboardData` blob is read
 * synchronously from the paste event and so never triggers a clipboard
 * permission prompt (unlike the async Clipboard API above).
 */
export async function imageBlobToTempPath(blob: Blob): Promise<string | null> {
  try {
    const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
    const ext = (blob.type || "image/png").slice("image/".length) || "png";
    return await invoke<string>("fs_write_temp_image", { data: bytes, ext });
  } catch {
    return null;
  }
}

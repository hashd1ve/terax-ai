import { cn } from "@/lib/utils";
import { Refresh01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useEffect, useMemo, useState } from "react";

type Props = {
  path: string;
  visible: boolean;
};

// Mirror PreviewPane: drop the iframe after a long stretch invisible so a
// background HTML page can't hold onto WebView memory indefinitely.
const SUSPEND_AFTER_MS = 30_000;

export function HtmlPreviewPane({ path, visible }: Props) {
  const [nonce, setNonce] = useState(0);
  const [loaded, setLoaded] = useState(visible);

  // asset: URL — Tauri's protocol that serves local files to the webview.
  // Origin is asset.localhost (or asset://localhost), distinct from the main
  // tauri://localhost origin so the iframe can't reach window.__TAURI__.
  const src = useMemo(() => convertFileSrc(path), [path]);

  useEffect(() => {
    if (visible) {
      setLoaded(true);
      return;
    }
    const t = setTimeout(() => setLoaded(false), SUSPEND_AFTER_MS);
    return () => clearTimeout(t);
  }, [visible]);

  // Auto-reload when this exact file is written from anywhere inside Terax
  // (editor save, AI tool, external watcher echo). Cheap: one listener per
  // pane, filter is a string compare.
  useEffect(() => {
    type FileWrittenPayload = { path: string; source?: string };
    const unlistenPromise = getCurrentWebviewWindow()
      .listen<FileWrittenPayload>("fs:file-written", (event) => {
        const a = event.payload.path.replace(/\\/g, "/");
        const b = path.replace(/\\/g, "/");
        if (a === b) setNonce((n) => n + 1);
      });
    return () => {
      void unlistenPromise.then((un) => un());
    };
  }, [path]);

  const reload = () => {
    setLoaded(true);
    setNonce((n) => n + 1);
  };

  return (
    <div
      className={cn(
        "flex h-full w-full flex-col overflow-hidden rounded-md border border-border/60 bg-background",
        !visible && "pointer-events-none",
      )}
    >
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/60 px-2">
        <span
          className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground"
          title={path}
        >
          {path}
        </span>
        <button
          type="button"
          onClick={reload}
          className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          title="Reload"
          aria-label="Reload"
        >
          <HugeiconsIcon icon={Refresh01Icon} size={13} strokeWidth={2} />
        </button>
      </div>
      <div className="relative min-h-0 flex-1 bg-white">
        {loaded ? (
          <iframe
            key={`${src}#${nonce}`}
            src={src}
            title="HTML preview"
            className="h-full w-full border-0"
            // Same sandbox shape as PreviewPane: scripts + same-origin lets
            // the page fetch relative assets and run JS modules, while the
            // absence of allow-top-navigation* keeps it from navigating the
            // parent Tauri webview to an attacker origin (which would expose
            // window.__TAURI__). asset: origin is already distinct from
            // tauri:, so allow-same-origin doesn't leak IPC access.
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
            referrerPolicy="no-referrer"
            allow="clipboard-read; clipboard-write; fullscreen"
          />
        ) : (
          <SuspendedState onReload={reload} />
        )}
      </div>
    </div>
  );
}

function SuspendedState({ onReload }: { onReload: () => void }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="space-y-1">
        <p className="text-[12.5px] font-medium text-foreground">
          Preview suspended
        </p>
        <p className="max-w-xs text-[11px] leading-relaxed text-muted-foreground">
          Released to free memory after sitting in the background.
        </p>
      </div>
      <button
        type="button"
        onClick={onReload}
        className="rounded-md border border-border/60 bg-card px-3 py-1 text-[11px] hover:bg-accent/50"
      >
        Reload
      </button>
    </div>
  );
}

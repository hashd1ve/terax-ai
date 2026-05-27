import { useTheme } from "@/modules/theme";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { isRestoredLeaf } from "@/modules/workspace/lib/workspaceStore";
import type { SearchAddon } from "@xterm/addon-search";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import {
  preloadScrollback,
  useTerminalSession,
  whenSessionReady,
} from "./lib/useTerminalSession";

export type TerminalPaneHandle = {
  write: (data: string) => void;
  focus: () => void;
  getBuffer: (maxLines?: number) => string | null;
  getSelection: () => string | null;
};

type Props = {
  /** Stable identifier for this leaf (passed back through callbacks). */
  leafId: number;
  /** Tab containing this pane is on screen. */
  visible: boolean;
  /** This leaf is the active pane within its tab — receives auto-focus. */
  focused?: boolean;
  initialCwd?: string;
  /** Stable per-leaf uuid; keys the tmux session (terax_<uuid>). */
  persistId?: string;
  onSearchReady?: (leafId: number, addon: SearchAddon) => void;
  onExit?: (leafId: number, code: number) => void;
  onCwd?: (leafId: number, cwd: string) => void;
};

export const TerminalPane = forwardRef<TerminalPaneHandle, Props>(
  function TerminalPane(
    {
      leafId,
      visible,
      focused = true,
      initialCwd,
      persistId,
      onSearchReady,
      onExit,
      onCwd,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const { resolvedMode, themeId, customThemes } = useTheme();

    const session = useTerminalSession({
      leafId,
      container: containerRef,
      visible,
      focused,
      initialCwd,
      persistId,
      onSearchReady: (a) => onSearchReady?.(leafId, a),
      onExit: (c) => onExit?.(leafId, c),
      onCwd: (c) => onCwd?.(leafId, c),
    });

    useEffect(() => {
      // Defer one frame so CSS-variable token resolution sees the new class.
      const id = requestAnimationFrame(() => session.applyTheme());
      return () => cancelAnimationFrame(id);
    }, [resolvedMode, themeId, customThemes, session]);

    // Preload prior tmux scrollback once for restored panes (those that came
    // from the persisted snapshot), after the session reattaches. No-op for
    // freshly created tabs and when capture returns empty (no tmux).
    const didPreload = useRef(false);
    const scrollback = usePreferencesStore((p) => p.terminalScrollback);
    useEffect(() => {
      if (didPreload.current || !persistId || !isRestoredLeaf(persistId)) return;
      didPreload.current = true;
      void whenSessionReady(leafId).then(() =>
        preloadScrollback(leafId, `terax_${persistId}`, scrollback),
      );
    }, [leafId, persistId, scrollback]);

    useImperativeHandle(
      ref,
      () => ({
        write: (data: string) => session.write(data),
        focus: () => session.focus(),
        getBuffer: (max?: number) => session.getBuffer(max),
        getSelection: () => session.getSelection(),
      }),
      [session],
    );

    return (
      <div
        ref={containerRef}
        className="zoom-exempt h-full w-full"
        style={{
          visibility: visible ? "visible" : "hidden",
          pointerEvents: visible ? "auto" : "none",
        }}
      />
    );
  },
);

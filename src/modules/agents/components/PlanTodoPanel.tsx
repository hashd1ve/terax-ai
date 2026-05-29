import { cn } from "@/lib/utils";
import { findLeafUuid } from "@/modules/terminal/lib/panes";
import type { Tab } from "@/modules/tabs";
import {
  CheckmarkCircle02Icon,
  CircleIcon,
  Loading03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo } from "react";
import { useActivityStore } from "../store/activityStore";
import { type TodoItem, useTodosStore } from "../store/todosStore";

type Props = {
  tabs: Tab[];
  activeId: number;
};

function glyphFor(status: TodoItem["status"]) {
  if (status === "completed")
    return { icon: CheckmarkCircle02Icon, className: "text-emerald-500" };
  if (status === "in_progress")
    return { icon: Loading03Icon, className: "animate-spin text-primary" };
  return { icon: CircleIcon, className: "text-muted-foreground/55" };
}

export function PlanTodoPanel({ tabs, activeId }: Props) {
  const activeLeafUuid = useMemo(() => {
    const t = tabs.find((x) => x.id === activeId);
    if (!t || t.kind !== "terminal") return undefined;
    return findLeafUuid(t.paneTree, t.activeLeafId);
  }, [tabs, activeId]);

  const sessionId = useActivityStore((s) =>
    activeLeafUuid ? s.leaves[activeLeafUuid]?.sessionId : undefined,
  );
  const items = useTodosStore((s) =>
    sessionId ? s.bySession[sessionId] : undefined,
  );

  const done = items?.filter((i) => i.status === "completed").length ?? 0;

  return (
    <aside className="flex h-full min-w-0 flex-col bg-card/80 backdrop-blur [contain:layout_style]">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border/50 px-3 pb-2.5 pt-3">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/85">
          Plan
        </span>
        {items && items.length > 0 ? (
          <span className="text-[10px] font-medium tabular-nums leading-none text-muted-foreground/70">
            {done}/{items.length}
          </span>
        ) : null}
      </header>

      {!items || items.length === 0 ? (
        <div className="flex flex-1 items-start px-3 pt-3 text-[11px] leading-relaxed text-muted-foreground/65">
          No active plan
        </div>
      ) : (
        <ol className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 py-2 [scrollbar-gutter:stable]">
          {items.map((item, i) => {
            const active = item.status === "in_progress";
            const { icon, className } = glyphFor(item.status);
            const text =
              active && item.activeForm ? item.activeForm : item.content;
            return (
              <li
                key={`${i}-${item.content}`}
                className={cn(
                  "flex items-start gap-2 rounded-md px-1.5 py-1 text-[12px] leading-snug",
                  active && "bg-foreground/[0.05]",
                )}
              >
                <HugeiconsIcon
                  icon={icon}
                  size={14}
                  strokeWidth={1.9}
                  className={cn("mt-0.5 shrink-0", className)}
                />
                <span
                  className={cn(
                    "min-w-0 break-words",
                    item.status === "completed" &&
                      "text-muted-foreground/60 line-through",
                    active && "font-medium text-foreground",
                    item.status === "pending" && "text-muted-foreground",
                  )}
                >
                  {text}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </aside>
  );
}

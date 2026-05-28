import { cn } from "@/lib/utils";
import type { HtmlPreviewTab, Tab } from "@/modules/tabs";
import { HtmlPreviewPane } from "./HtmlPreviewPane";

type Props = {
  tabs: Tab[];
  activeId: number;
};

export function HtmlPreviewStack({ tabs, activeId }: Props) {
  const previews = tabs.filter(
    (t): t is HtmlPreviewTab => t.kind === "html-preview",
  );
  if (previews.length === 0) return null;
  return (
    <div className="relative h-full w-full">
      {previews.map((t) => {
        const visible = t.id === activeId;
        return (
          <div
            key={t.id}
            className={cn(
              "absolute inset-0",
              !visible && "invisible pointer-events-none",
            )}
            aria-hidden={!visible}
          >
            <HtmlPreviewPane path={t.path} visible={visible} />
          </div>
        );
      })}
    </div>
  );
}

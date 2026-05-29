import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  fillPlaceholders,
  type PromptContext,
  type QuickPrompt,
} from "@/modules/agents/lib/quickPrompts";

export type SlashCommand = { id: string; name: string };

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prompts: QuickPrompt[];
  /** Resolved by App so this component stays presentational. */
  context: PromptContext;
  slashCommands?: SlashCommand[];
  /** Receives the staged text (no trailing carriage return). */
  onSubmit: (text: string) => void;
};

export function QuickPromptPalette({
  open,
  onOpenChange,
  prompts,
  context,
  slashCommands,
  onSubmit,
}: Props) {
  // Mounting cmdk + the dialog only while open keeps the closed state free.
  if (!open) return null;

  const submit = (text: string) => {
    onOpenChange(false);
    if (text) onSubmit(text);
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Quick prompts"
      description="Insert a reusable prompt into the focused terminal."
    >
      <CommandInput placeholder="Search prompts..." autoFocus />
      <CommandList>
        <CommandEmpty>No prompts found.</CommandEmpty>
        <CommandGroup heading="Prompts">
          {prompts.map((p) => (
            <CommandItem
              key={p.id}
              value={`${p.label} ${p.body}`}
              onSelect={() => submit(fillPlaceholders(p.body, context))}
            >
              {p.label}
            </CommandItem>
          ))}
        </CommandGroup>
        {slashCommands && slashCommands.length > 0 ? (
          <CommandGroup heading="Slash commands">
            {slashCommands.map((c) => (
              <CommandItem
                key={c.id}
                value={`/${c.name}`}
                onSelect={() => submit(`/${c.name} `)}
              >
                /{c.name}
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
      </CommandList>
    </CommandDialog>
  );
}

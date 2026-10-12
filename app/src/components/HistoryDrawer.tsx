import { Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useVyrse } from "@/lib/vyrse/store";
import { groupHistory, relativeTime } from "@/lib/vyrse/mock-history";
import { cn } from "@/lib/utils";
import { IS_PHONE } from "@/services/phone";

export function HistoryDrawer() {
  const {
    historyOpen,
    setHistoryOpen,
    conversations,
    activeId,
    selectConversation,
    startNew,
    deleteConversation,
    exportActive,
    renameConversation,
  } = useVyrse();
  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const search = useRef<HTMLInputElement>(null);

  // Opening the drawer (or Ctrl+K) puts the cursor in search.
  useEffect(() => {
    if (!historyOpen) {
      setRenaming(null);
      return;
    }
    if (IS_PHONE) return; // would pop the keyboard up over the list
    const t = window.setTimeout(() => search.current?.focus(), 60);
    return () => window.clearTimeout(t);
  }, [historyOpen]);

  const commitRename = () => {
    if (renaming) renameConversation(renaming.id, renaming.title);
    setRenaming(null);
  };

  // The list exists only while the drawer is open (and while it slides shut): closed, it would otherwise
  // re-render on every streamed word of a reply.
  const [listShown, setListShown] = useState(historyOpen);
  useEffect(() => {
    if (historyOpen) return setListShown(true);
    const t = window.setTimeout(() => setListShown(false), 560);
    return () => window.clearTimeout(t);
  }, [historyOpen]);

  const groups = useMemo(() => {
    if (!listShown) return [];
    const filtered = conversations
      .filter((c) => c.messages.length > 0 || c.title !== "New conversation")
      .filter((c) => c.title.toLowerCase().includes(query.trim().toLowerCase()))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return groupHistory(filtered);
  }, [conversations, query, listShown]);

  return (
    <>
      <div
        onClick={() => setHistoryOpen(false)}
        className={cn(
          "fixed inset-0 z-40 bg-background/50 backdrop-blur-[2px] transition-opacity duration-500",
          historyOpen ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        aria-hidden="true"
      />
      <aside
        aria-label="Conversation history"
        aria-hidden={!historyOpen}
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-full flex-col liquid-strong sm:max-w-[21rem] sm:rounded-r-[1.75rem] transition-transform duration-[520ms] ease-[cubic-bezier(0.16,0.84,0.24,1)]",
          historyOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex items-center justify-between gap-3 px-5 pt-5">
          <p className="eyebrow">history</p>
          <button
            type="button"
            onClick={() => setHistoryOpen(false)}
            aria-label="Close history"
            className="liquid-hover relative grid size-8 place-items-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none"
          >
            <X className="size-4" strokeWidth={1.5} />
          </button>
        </div>

        <div className="px-5 pt-4">
          <div className="liquid relative flex items-center gap-2 rounded-xl px-3 py-2 transition-shadow focus-within:shadow-[var(--glow-core)]">
            <Search className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
            <input
              ref={search}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={IS_PHONE ? "Search conversations" : "Search conversations  (Ctrl+K)"}
              className="min-w-0 flex-1 bg-transparent text-[13.5px] text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
            />
          </div>
          <button
            type="button"
            onClick={exportActive}
            disabled={!activeId}
            className="liquid-hover relative mt-2 flex w-full items-center gap-2 rounded-xl border-border/60 px-3 py-2.5 text-left text-[13.5px] text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {IS_PHONE ? "Copy this conversation" : "Export active conversation"}
          </button>
          <button
            type="button"
            onClick={startNew}
            className="liquid relative mt-3 flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-[13.5px] text-foreground transition-transform active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus className="size-4 text-primary" strokeWidth={1.6} />
            New conversation
          </button>
        </div>

        <div className="field-scroll mt-4 flex-1 overflow-y-auto px-3 pb-6">
          {listShown && groups.length === 0 && (
            <p className="px-2 py-10 text-center text-[13px] text-muted-foreground">
              Nothing here yet.
            </p>
          )}
          {groups.map((g) => (
            <section key={g.label} className="mb-4">
              <p className="eyebrow px-2 py-2">{g.label}</p>
              <ul>
                {g.items.map((c) => (
                  <li key={c.id} className="cv-row">
                    <div
                      className={cn(
                        "group relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-xl px-2 py-2",
                        c.id === activeId ? "liquid" : "liquid-hover",
                      )}
                    >
                      {renaming?.id === c.id ? (
                        <input
                          autoFocus
                          value={renaming.title}
                          onChange={(e) => setRenaming({ id: c.id, title: e.target.value })}
                          onBlur={commitRename}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitRename();
                            if (e.key === "Escape") {
                              e.stopPropagation();
                              setRenaming(null);
                            }
                          }}
                          aria-label="Conversation name"
                          maxLength={80}
                          className="min-w-0 rounded-md border border-border-strong bg-background/60 px-2 py-1 text-[13.5px] text-foreground focus:outline-none"
                        />
                      ) : (
                      <button
                        type="button"
                        onClick={() => selectConversation(c.id)}
                        onDoubleClick={() => setRenaming({ id: c.id, title: c.title })}
                        className="min-w-0 text-left focus-visible:outline-none"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span
                            className={cn(
                              "size-1.5 shrink-0 rounded-full",
                              c.state === "error"
                                ? "bg-destructive"
                                : c.id === activeId
                                  ? "bg-primary"
                                  : "bg-muted-foreground/35",
                            )}
                          />
                          <span className="truncate text-[13.5px] text-foreground">{c.title}</span>
                        </span>
                        <span className="mt-0.5 block pl-3.5 font-mono text-[10.5px] text-muted-foreground/80">
                          {relativeTime(c.updatedAt)}
                        </span>
                      </button>
                      )}
                      <span className="flex items-center">
                      <button
                        type="button"
                        onClick={() => setRenaming({ id: c.id, title: c.title })}
                        aria-label={`Rename ${c.title}`}
                        className="liquid-hover relative grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Pencil className="size-3.5" strokeWidth={1.5} />
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteConversation(c.id)}
                        aria-label={`Delete ${c.title}`}
                        className="liquid-hover relative grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Trash2 className="size-3.5" strokeWidth={1.5} />
                      </button>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </aside>
    </>
  );
}

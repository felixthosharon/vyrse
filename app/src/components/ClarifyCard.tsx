import { useEffect, useState } from "react";
import { MessageCircleQuestion } from "lucide-react";
import { useVyrse } from "@/lib/vyrse/store";
import { cn } from "@/lib/utils";

/**
 * Inline card for Hermes' clarify tool: the agent paused to ask something. Not a modal —
 * the user can read the conversation while answering. "Skip" declines every question.
 */
export function ClarifyCard() {
  const { pendingClarify, respondToClarify } = useVyrse();
  const [answers, setAnswers] = useState<Record<string, string>>({});

  useEffect(() => setAnswers({}), [pendingClarify?.id]);
  if (!pendingClarify) return null;

  const toggleChoice = (qid: string, choice: string, multi: boolean) =>
    setAnswers((prev) => {
      if (!multi) return { ...prev, [qid]: choice };
      const current = new Set((prev[qid] ?? "").split(", ").filter(Boolean));
      if (current.has(choice)) current.delete(choice);
      else current.add(choice);
      return { ...prev, [qid]: [...current].join(", ") };
    });

  const complete = pendingClarify.questions.every((q) => (answers[q.qid] ?? "").trim() !== "");
  // One question with fixed choices (e.g. "Install this skill?"): a click answers it.
  const only = pendingClarify.questions.length === 1 ? pendingClarify.questions[0] : undefined;
  const oneClick = Boolean(only?.choices?.length && !only.multiSelect);

  return (
    <div className="mb-3 w-full max-w-[min(44rem,90vw)] liquid-strong relative rounded-2xl p-4 vyr-emerge">
      <div className="mb-3 flex items-center gap-2">
        <MessageCircleQuestion className="size-4 text-primary" strokeWidth={1.8} />
        <p className="eyebrow">vyrse needs your input</p>
      </div>
      <div className="space-y-4">
        {pendingClarify.questions.map((q) => (
          <div key={q.qid} className="space-y-2">
            <p className="text-[13.5px] text-foreground">{q.question}</p>
            {q.choices && q.choices.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {q.choices.map((choice) => {
                  const selected = (answers[q.qid] ?? "").split(", ").includes(choice);
                  return (
                    <button
                      key={choice}
                      type="button"
                      onClick={() =>
                        oneClick ? respondToClarify({ [q.qid]: choice }) : toggleChoice(q.qid, choice, Boolean(q.multiSelect))
                      }
                      className={cn(
                        "rounded-full border px-3 py-1.5 text-[12px] transition-colors",
                        selected
                          ? "border-primary/50 bg-primary/12 text-primary"
                          : "border-border-strong text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {choice}
                    </button>
                  );
                })}
              </div>
            ) : (
              <input
                type="text"
                value={answers[q.qid] ?? ""}
                onChange={(e) => setAnswers((prev) => ({ ...prev, [q.qid]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && complete) respondToClarify(answers);
                }}
                placeholder="Type your answer"
                className="w-full rounded-xl border border-border bg-background/60 px-3 py-2 text-[13px] text-foreground outline-none focus:border-primary/40"
              />
            )}
          </div>
        ))}
      </div>
      <div className={cn("mt-4 flex justify-end gap-2", oneClick && "hidden")}>
        <button
          type="button"
          onClick={() => respondToClarify(null)}
          className="rounded-full px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
        >
          Skip
        </button>
        <button
          type="button"
          disabled={!complete}
          onClick={() => respondToClarify(answers)}
          className="rounded-full border border-primary/40 bg-primary/12 px-4 py-1.5 text-[12px] text-primary transition-opacity disabled:opacity-40"
        >
          Answer
        </button>
      </div>
    </div>
  );
}

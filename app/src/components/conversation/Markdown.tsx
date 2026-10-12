import { Fragment, memo, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { copyText } from "@/lib/clipboard";

/** Minimal markdown renderer tuned for editorial-style AI responses. */

/**
 * Streaming replies: plain text becomes one span per word, keyed by position, so React keeps the words
 * already on screen and only newly arrived ones mount and play the soft blur-to-sharp reveal (CSS).
 */
function words(text: string, keyBase: string, reveal: boolean): ReactNode[] {
  if (!reveal) return [text];
  return text.split(/(\s+)/).map((part, n) =>
    /^\s*$/.test(part) ? part : (
      <span key={`${keyBase}-w${n}`} className="vyr-word">
        {part}
      </span>
    ),
  );
}

function inline(text: string, keyBase: string, reveal = false): ReactNode[] {
  const out: ReactNode[] = [];
  let seg = 0;
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(...words(text.slice(last, m.index), `${keyBase}-s${seg++}`, reveal));
    const tok = m[0];
    if (tok.startsWith("`")) {
      out.push(
        <code
          key={`${keyBase}-c${i++}`}
          className="rounded-[5px] border border-border bg-secondary/50 px-1.5 py-0.5 font-mono text-[0.85em] text-primary"
        >
          {tok.slice(1, -1)}
        </code>,
      );
    } else {
      out.push(
        <strong key={`${keyBase}-b${i++}`} className="font-medium text-foreground">
          {tok.slice(2, -2)}
        </strong>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(...words(text.slice(last), `${keyBase}-s${seg++}`, reveal));
  return out;
}

/**
 * Splits the reply at blank lines (outside code fences) and renders each piece as its own memoised segment:
 * while a reply streams in, only the piece being written re-renders, not everything above it.
 */
export const Markdown = memo(function Markdown({ text, reveal = false }: { text: string; reveal?: boolean }) {
  const segments: string[] = [];
  let current: string[] = [];
  let fenced = false;
  for (const line of unflattenTables(text).split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    if (!fenced && line.trim() === "" && current.length) {
      segments.push(current.join("\n"));
      current = [];
    } else if (fenced || line.trim() !== "") current.push(line);
  }
  if (current.length) segments.push(current.join("\n"));
  return (
    <Fragment>
      {segments.map((seg, n) => (
        <Segment key={n} text={seg} reveal={reveal} index={n} />
      ))}
    </Fragment>
  );
});

const TABLE_SEP = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const TABLE_SEP_INLINE = /\|\s*:?-{3,}:?\s*\|/;

/**
 * Small local models sometimes write a whole table on one line. A line that holds a table's separator
 * row and more cells after it is split back into rows at each "| |" (the end of one row and the start of
 * the next), and any lead-in text before the first cell goes on its own line.
 */
export function unflattenTables(text: string): string {
  if (!text.includes("|")) return text;
  let fenced = false;
  return text
    .split("\n")
    .map((line) => {
      if (line.startsWith("```")) fenced = !fenced;
      if (fenced || !TABLE_SEP_INLINE.test(line) || TABLE_SEP.test(line.trim())) return line;
      const start = line.indexOf("|");
      const lead = line.slice(0, start).trim();
      const rows = line.slice(start).replace(/\|\s+\|/g, "|\n|");
      return lead ? `${lead}\n\n${rows}` : rows;
    })
    .join("\n");
}

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

const Segment = memo(function Segment({ text, reveal, index }: { text: string; reveal: boolean; index: number }) {
  return <MarkdownBlocks text={text} reveal={reveal} keyBase={`g${index}`} />;
});

function MarkdownBlocks({ text, reveal, keyBase }: { text: string; reveal: boolean; keyBase: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split("\n");
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) {
        body.push(lines[i] ?? "");
        i++;
      }
      i++;
      blocks.push(
        <CodeBlock key={key++} lang={lang} code={body.join("\n")} />,
      );
      continue;
    }

    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      const content = inline(h[2] ?? "", `${keyBase}h${key}`, reveal);
      blocks.push(
        level <= 2 ? (
          <h3
            key={key++}
            className="mt-6 mb-2 font-display text-[17px] font-medium tracking-tight text-foreground first:mt-0"
          >
            {content}
          </h3>
        ) : (
          <h4 key={key++} className="mt-5 mb-2 font-display text-[15px] font-medium text-foreground">
            {content}
          </h4>
        ),
      );
      i++;
      continue;
    }

    if (line.trim().startsWith("|") && TABLE_SEP.test((lines[i + 1] ?? "").trim())) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && (lines[i] ?? "").trim().startsWith("|")) {
        rows.push(cells(lines[i] ?? ""));
        i++;
      }
      blocks.push(
        <div key={key++} className="my-4 overflow-x-auto rounded-xl border border-border">
          <table className="w-full border-collapse text-left text-[13.5px]">
            <thead className="bg-secondary/30">
              <tr>
                {head.map((c, n) => (
                  <th key={n} className="px-3 py-2 font-medium text-foreground">
                    {inline(c, `${keyBase}th${key}-${n}`, reveal)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, rn) => (
                <tr key={rn} className="border-t border-border">
                  {head.map((_, n) => (
                    <td key={n} className="px-3 py-2 align-top text-foreground/85">
                      {inline(r[n] ?? "", `${keyBase}td${key}-${rn}-${n}`, reveal)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push(
        <ul key={key++} className="my-3 space-y-1.5">
          {items.map((it, n) => (
            <li key={n} className="flex gap-3 text-[15px] leading-relaxed text-foreground/85">
              <span className="mt-[0.62em] size-1 shrink-0 rounded-full bg-primary/70" />
              <span>{inline(it, `${keyBase}l${key}-${n}`, reveal)}</span>
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      blocks.push(
        <ol key={key++} className="my-3 space-y-1.5">
          {items.map((it, n) => (
            <li key={n} className="flex gap-3 text-[15px] leading-relaxed text-foreground/85">
              <span className="mt-[0.15em] w-4 shrink-0 font-mono text-[12px] text-primary/80">
                {String(n + 1).padStart(2, "0")}
              </span>
              <span>{inline(it, `${keyBase}o${key}-${n}`, reveal)}</span>
            </li>
          ))}
        </ol>,
      );
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() !== "" &&
      !/^(```|#{1,4}\s|\s*[-*]\s|\s*\d+\.\s)/.test(lines[i] ?? "") &&
      !((lines[i] ?? "").trim().startsWith("|") && TABLE_SEP.test((lines[i + 1] ?? "").trim()))
    ) {
      para.push(lines[i] ?? "");
      i++;
    }
    blocks.push(
      <p key={key++} className="my-3 text-[15px] leading-[1.72] text-foreground/85 first:mt-0">
        {inline(para.join(" "), `${keyBase}p${key}`, reveal)}
      </p>,
    );
  }

  return <Fragment>{blocks}</Fragment>;
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="my-4 overflow-hidden rounded-xl border border-border">
      <div className="flex items-center justify-between border-b border-border bg-secondary/30 px-3 py-1">
        <span className="eyebrow">{lang || "code"}</span>
        <button
          type="button"
          onClick={async () => {
            if (await copyText(code)) { setCopied(true); window.setTimeout(() => setCopied(false), 1200); }
          }}
          className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="field-scroll-x overflow-x-auto bg-secondary/15 px-3 py-3">
        <code className="font-mono text-[12.5px] leading-relaxed text-foreground/90">{code}</code>
      </pre>
    </div>
  );
}

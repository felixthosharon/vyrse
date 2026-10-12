import { useState } from "react";
import { Loader2, Smartphone } from "lucide-react";
import { pair } from "@/services/phone";

const field =
  "liquid relative w-full rounded-2xl px-4 py-3 text-[15px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none";

/** First run on the phone: connect to VYRSE on the PC with the code from PC Settings → Phone. */
export function PhonePairing() {
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("My phone");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await pair(address, code, name.trim() || "Android phone");
      window.location.reload();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-background px-6 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <span className="liquid relative grid size-11 place-items-center rounded-2xl text-primary">
            <Smartphone className="size-5" strokeWidth={1.6} />
          </span>
          <div>
            <p className="font-display text-sm font-medium tracking-[0.34em] text-foreground">VYRSE</p>
            <p className="eyebrow mt-1">connect to your pc</p>
          </div>
        </div>
        <p className="mb-6 text-[13.5px] leading-relaxed text-muted-foreground">
          On the PC, open VYRSE → Settings → <span className="text-foreground">Phone</span>, turn on phone access and tap{" "}
          <span className="text-foreground">Pair a phone</span>. Enter the address and code it shows. Both need to be on
          the same Wi-Fi.
        </p>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="PC address, e.g. 192.168.1.20"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            aria-label="PC address"
            className={field}
          />
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder="6-digit code"
            inputMode="numeric"
            aria-label="Pairing code"
            className={`${field} font-mono tracking-[0.4em]`}
          />
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name for this phone"
            aria-label="Phone name"
            className={field}
          />
          {error && <p className="px-1 text-[12.5px] leading-relaxed text-destructive">{error}</p>}
          <button
            type="submit"
            disabled={busy || !address.trim() || code.length !== 6}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-2xl bg-primary px-4 py-3 text-[14.5px] font-medium text-primary-foreground transition-opacity disabled:opacity-40"
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            Connect
          </button>
        </form>
      </div>
    </div>
  );
}

import { useVyrse } from "@/lib/vyrse/store";

/** Brief, quiet confirmation (mode changes, messages Hermes shows with `vyrse_ui notify`). */
export function Toast() {
  const { toast } = useVyrse();
  if (!toast) return null;
  return (
    <div role="status" className="pointer-events-none fixed inset-x-0 top-[4.5rem] z-40 flex justify-center px-4">
      <p className="vyr-emerge max-w-[min(32rem,90vw)] liquid relative rounded-full px-4 py-2 text-center text-[12.5px] text-foreground">
        {toast}
      </p>
    </div>
  );
}

/** Ambient environment behind the presence. Subordinate by design. */
export function Environment() {
  return (
    <div className="pointer-events-none fixed inset-0 overflow-hidden" aria-hidden="true">
      {/* light theme only (styles.css): coloured daylight for the glass to refract */}
      <div className="vyr-daylight vyr-ambient absolute -inset-[6%]" style={{ animation: "vyr-drift 60s ease-in-out infinite" }} />
      <div
        className="absolute inset-0 opacity-[0.5]"
        style={{
          background:
            "radial-gradient(120% 90% at 50% 38%, color-mix(in oklab, var(--color-primary) 9%, transparent) 0%, transparent 62%)",
        }}
      />
      <div
        className="vyr-ambient absolute -inset-[20%] opacity-40"
        style={{
          background:
            "radial-gradient(45% 40% at 22% 78%, color-mix(in oklab, var(--color-accent) 7%, transparent) 0%, transparent 70%)",
          animation: "vyr-drift 46s ease-in-out infinite",
        }}
      />
      <div
        className="absolute inset-0 opacity-[0.22]"
        style={{
          backgroundImage:
            "linear-gradient(to right, color-mix(in oklab, var(--color-foreground) 6%, transparent) 1px, transparent 1px), linear-gradient(to bottom, color-mix(in oklab, var(--color-foreground) 6%, transparent) 1px, transparent 1px)",
          backgroundSize: "72px 72px",
          maskImage: "radial-gradient(80% 70% at 50% 45%, black 0%, transparent 85%)",
          WebkitMaskImage: "radial-gradient(80% 70% at 50% 45%, black 0%, transparent 85%)",
        }}
      />
      <div
        className="vyr-ambient vyr-sweep-layer absolute inset-x-0 h-1/3"
        style={{
          background:
            "linear-gradient(to bottom, transparent, color-mix(in oklab, var(--color-primary) 4%, transparent), transparent)",
          animation: "vyr-sweep 24s linear infinite",
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 120% at 50% 50%, transparent 55%, color-mix(in oklab, var(--color-background) 70%, transparent) 100%)",
        }}
      />
    </div>
  );
}

import { useId } from "react";

const V = "M164 138 C200 246 228 326 256 362 C284 326 312 246 348 138";

/**
 * The VYRSE logo mark: the "Liquid Chrome" V (same design as the app icon, assets/brand). Drawn inline
 * so it stays sharp at any size; in the light theme the metal reflects a bright room instead of a dark one.
 */
export function VyrseMark({ className, light = false }: { className?: string; light?: boolean }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const chrome = light
    ? ["#ffffff", "#c9d6e0", "#3a4b5a", "#e6f3fa", "#ffffff", "#7b8f9d", "#2b3a46", "#7fcde3"]
    : ["#f6fbff", "#9fb3c2", "#121a21", "#cfe9f5", "#ffffff", "#58707f", "#0d1419", "#8fd8ec"];
  const stops = [0, 0.16, 0.3, 0.44, 0.52, 0.62, 0.8, 1];
  return (
    <svg viewBox="122 96 268 300" className={className} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}c`} gradientUnits="userSpaceOnUse" x1="0" y1="120" x2="0" y2="390">
          {stops.map((o, i) => (
            <stop key={o} offset={o} stopColor={chrome[i]} />
          ))}
        </linearGradient>
        <linearGradient id={`${id}i`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#74daec" />
          <stop offset=".5" stopColor="#9a93f2" />
          <stop offset="1" stopColor="#ffc480" />
        </linearGradient>
      </defs>
      <path d={V} fill="none" stroke={`url(#${id}i)`} strokeWidth="56" strokeLinecap="round" strokeLinejoin="round" opacity={light ? 0.28 : 0.4} />
      <path d={V} fill="none" stroke={`url(#${id}i)`} strokeWidth="47" strokeLinecap="round" strokeLinejoin="round" />
      <path d={V} fill="none" stroke={`url(#${id}c)`} strokeWidth="42" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M157 152 C190 246 216 310 242 344" fill="none" stroke="#fff" strokeOpacity=".85" strokeWidth="4" strokeLinecap="round" />
      <path d="M348 116 L352 134 L370 138 L352 142 L348 160 L344 142 L326 138 L344 134 Z" fill="#fff" />
    </svg>
  );
}

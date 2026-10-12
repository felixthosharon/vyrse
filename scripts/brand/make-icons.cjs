/*
 * VYRSE brand: renders every app icon from one design (the "Liquid Chrome" V).
 *
 *   npm i --no-save @resvg/resvg-js@2.6.2      (once, anywhere on NODE_PATH)
 *   node scripts/brand/make-icons.cjs         (from the repo root)
 *
 * Writes: assets/brand/*, desktop/resources/icon.{svg,png,ico}, app/public/favicon.ico + logo.svg,
 * and the Android launcher icons (adaptive, round, themed/monochrome), status-bar icon and splash screens.
 */
const fs = require("node:fs");
const path = require("node:path");
const { Resvg } = require("@resvg/resvg-js");

const ROOT = path.resolve(__dirname, "..", "..");
const RES = path.join(ROOT, "app/android/app/src/main/res");
const out = (rel, data) => {
  const p = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
};

// ------------------------------------------------------------------------------------------ design

/** The V: a poured stroke of liquid chrome with an iridescent edge and one glint (512 x 512 space). */
const V = "M164 138 C200 246 228 326 256 362 C284 326 312 246 348 138";
const DEFS = `
  <radialGradient id="voidBg" cx="50%" cy="42%" r="78%"><stop offset="0" stop-color="#101924"/><stop offset=".6" stop-color="#06090d"/><stop offset="1" stop-color="#030406"/></radialGradient>
  <linearGradient id="voidRim" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset=".5" stop-color="#fff" stop-opacity=".02"/><stop offset="1" stop-color="#fff" stop-opacity=".08"/></linearGradient>
  <linearGradient id="chrome" gradientUnits="userSpaceOnUse" x1="0" y1="120" x2="0" y2="390">
    <stop offset="0" stop-color="#f6fbff"/><stop offset=".16" stop-color="#9fb3c2"/><stop offset=".3" stop-color="#121a21"/>
    <stop offset=".44" stop-color="#cfe9f5"/><stop offset=".52" stop-color="#ffffff"/><stop offset=".62" stop-color="#58707f"/>
    <stop offset=".8" stop-color="#0d1419"/><stop offset="1" stop-color="#8fd8ec"/>
  </linearGradient>
  <linearGradient id="irid" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#74daec"/><stop offset=".5" stop-color="#9a93f2"/><stop offset="1" stop-color="#ffc480"/></linearGradient>
  <filter id="b8" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="8"/></filter>`;
const MARK = `
  <path d="${V}" fill="none" stroke="url(#irid)" stroke-width="52" stroke-linecap="round" stroke-linejoin="round" opacity=".5" filter="url(#b8)"/>
  <path d="${V}" fill="none" stroke="url(#irid)" stroke-width="47" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="${V}" fill="none" stroke="url(#chrome)" stroke-width="42" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M157 152 C190 246 216 310 242 344" fill="none" stroke="#fff" stroke-opacity=".85" stroke-width="3.5" stroke-linecap="round"/>
  <path d="M348 118 L351.5 134.5 L368 138 L351.5 141.5 L348 158 L344.5 141.5 L328 138 L344.5 134.5 Z" fill="#fff"/>`;
/** Centre of the mark's visual bounds, and its size, in the 512 space. */
const CX = 256, CY = 250, SPAN = 290;

const svg = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs>${DEFS}</defs>${body}</svg>`;
/** The mark scaled so its bounds are `size` px, centred at (x, y). */
const markAt = (x, y, size) => `<g transform="translate(${x} ${y}) scale(${size / SPAN}) translate(${-CX} ${-CY})">${MARK}</g>`;

const iconSvg = () =>
  svg(512, 512, `<rect x="8" y="8" width="496" height="496" rx="116" fill="url(#voidBg)"/>
    <rect x="9.5" y="9.5" width="493" height="493" rx="114.5" fill="none" stroke="url(#voidRim)" stroke-width="3"/>${MARK}`);
const roundSvg = () =>
  svg(512, 512, `<circle cx="256" cy="256" r="248" fill="url(#voidBg)"/>
    <circle cx="256" cy="256" r="246.5" fill="none" stroke="url(#voidRim)" stroke-width="3"/>${markAt(256, 256, 300)}`);
const markSvg = () => svg(512, 512, MARK);
/** Adaptive icon layers: 108 dp canvas, the mark kept inside the 66 dp safe circle. */
const fgSvg = () => svg(432, 432, markAt(216, 216, 250));
const bgSvg = () => svg(432, 432, `<rect width="432" height="432" fill="url(#voidBg)"/>`);
const splashSvg = (w, h) =>
  svg(w, h, `<rect width="${w}" height="${h}" fill="#0b0f14"/>
    <radialGradient id="sg" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#74daec" stop-opacity=".10"/><stop offset="1" stop-color="#74daec" stop-opacity="0"/></radialGradient>
    <circle cx="${w / 2}" cy="${h / 2}" r="${Math.min(w, h) * 0.42}" fill="url(#sg)"/>${markAt(w / 2, h / 2, Math.min(w, h) * 0.3)}`);

const png = (svgText, width) => new Resvg(svgText, { fitTo: { mode: "width", value: width } }).render().asPng();

/** .ico with PNG-compressed entries (Windows Vista and later). */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((im) => im.data)]);
}
const icoFrom = (svgText, sizes) => ico(sizes.map((size) => ({ size, data: png(svgText, size) })));

// ------------------------------------------------------------------------------------------ outputs

// Brand files (README, GitHub, anyone making videos or posts)
out("assets/brand/vyrse-icon.svg", iconSvg());
out("assets/brand/vyrse-mark.svg", markSvg());
out("assets/brand/vyrse-icon-1024.png", png(iconSvg(), 1024));
out("assets/brand/vyrse-icon-256.png", png(iconSvg(), 256));
out("assets/brand/social-preview.png", png(svg(1280, 640, `<rect width="1280" height="640" fill="url(#voidBg)"/>
  ${markAt(400, 320, 300)}
  <text x="600" y="345" font-family="Segoe UI, Arial, sans-serif" font-size="96" font-weight="600" letter-spacing="30" fill="#e8eef3">VYRSE</text>
  <text x="604" y="405" font-family="Segoe UI, Arial, sans-serif" font-size="28" letter-spacing="2" fill="#8fa0ad">Your voice-first AI, on your own PC</text>`), 1280));

// Windows app + installer, browser tab
out("desktop/resources/icon.svg", iconSvg());
out("desktop/resources/icon.png", png(iconSvg(), 512));
out("desktop/resources/icon.ico", icoFrom(iconSvg(), [16, 20, 24, 32, 40, 48, 64, 128, 256]));
out("app/public/favicon.ico", icoFrom(iconSvg(), [16, 32, 48]));
out("app/public/logo.svg", iconSvg());

// Android launcher icons
const DENS = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [d, k] of Object.entries(DENS)) {
  out(`app/android/app/src/main/res/mipmap-${d}/ic_launcher.png`, png(iconSvg(), 48 * k));
  out(`app/android/app/src/main/res/mipmap-${d}/ic_launcher_round.png`, png(roundSvg(), 48 * k));
  out(`app/android/app/src/main/res/mipmap-${d}/ic_launcher_foreground.png`, png(fgSvg(), 108 * k));
  out(`app/android/app/src/main/res/mipmap-${d}/ic_launcher_background.png`, png(bgSvg(), 108 * k));
}
const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
    <monochrome android:drawable="@drawable/ic_launcher_monochrome"/>
</adaptive-icon>
`;
out("app/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml", adaptive);
out("app/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml", adaptive);

// The V as a single-colour vector: themed icons (Android 13+) and the status-bar icon.
const vVector = (comment, sizeDp, viewport, scaleTo) => {
  const s = scaleTo / SPAN;
  const p = (x, y) => `${(viewport / 2 + (x - CX) * s).toFixed(2)},${(viewport / 2 + (y - CY) * s).toFixed(2)}`;
  const d = `M${p(164, 138)} C${p(200, 246)} ${p(228, 326)} ${p(256, 362)} C${p(284, 326)} ${p(312, 246)} ${p(348, 138)}`;
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- ${comment} Generated by scripts/brand/make-icons.cjs. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="${sizeDp}dp" android:height="${sizeDp}dp" android:viewportWidth="${viewport}" android:viewportHeight="${viewport}">
    <path android:fillColor="#00000000" android:strokeColor="#FFFFFFFF" android:strokeWidth="${(46 * s).toFixed(2)}"
        android:strokeLineCap="round" android:strokeLineJoin="round" android:pathData="${d}"/>
</vector>
`;
};
out("app/android/app/src/main/res/drawable/ic_launcher_monochrome.xml", vVector("Themed icon: the VYRSE V.", 108, 108, 62));
out("app/android/app/src/main/res/drawable/ic_stat_vyrse.xml", vVector("Status-bar icon: the VYRSE V (white silhouette, as Android requires).", 24, 24, 21));

// Splash screens (every density and orientation the project already has)
for (const dir of fs.readdirSync(RES)) {
  const f = path.join(RES, dir, "splash.png");
  if (!fs.existsSync(f)) continue;
  const head = fs.readFileSync(f);
  const w = head.readUInt32BE(16), h = head.readUInt32BE(20);
  fs.writeFileSync(f, png(splashSvg(w, h), w));
}
console.log("icons written");

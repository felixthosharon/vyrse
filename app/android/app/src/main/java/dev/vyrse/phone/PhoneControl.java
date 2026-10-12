package dev.vyrse.phone;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.Path;
import android.graphics.Rect;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.view.Display;
import android.view.accessibility.AccessibilityNodeInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Pattern;

/**
 * Full phone control for VYRSE: read the screen, tap, type, swipe, system keys, open apps.
 *
 * Safety, enforced here on the phone (not just by the PC):
 *  - needs Android's Accessibility switch AND VYRSE's own "Allow full control" switch (phone-side only);
 *  - payment, banking and password-manager apps and app installers are off limits;
 *  - password fields are never read or typed into;
 *  - tapping something like Send / Pay / Buy / Delete / Install / Call needs `confirmed` (the PC asks the user);
 *  - at most a few actions a second; a glowing border shows while VYRSE acts.
 */
public final class PhoneControl {
    private PhoneControl() {}

    static final String PREF_CONTROL = "full_control";
    private static final int MAX_NODES = 70;
    private static final Pattern SENSITIVE = Pattern.compile(
            "\\b(send|pay|payment|buy|purchase|order|checkout|delete|remove|uninstall|install|call|dial|transfer|"
                    + "confirm|post|publish|share|reply all|sign out|log ?out|reset|erase|format|subscribe|unsubscribe|accept|allow)\\b",
            Pattern.CASE_INSENSITIVE);
    /** Apps VYRSE never operates: money, passwords and installing apps stay with the user's own hands. */
    private static final String[] BLOCKED = {
            "com.google.android.apps.nbu.paisa.user", "com.phonepe.app", "net.one97.paytm", "in.org.npci.upiapp",
            "in.amazon.mShop.android.shopping", "com.mobikwik_new", "com.freecharge.android", "com.whatsapp.w4b.payments",
            "com.sbi.lotusintouch", "com.sbi.SBIFreedomPlus", "com.csam.icici.bank.imobile", "com.snapwork.hdfc",
            "com.axis.mobile", "com.msf.kbank.mobile", "com.bankofbaroda.mconnect", "com.google.android.apps.walletnfcrel",
            "com.paypal.android.p2pmobile", "com.x8bit.bitwarden", "com.lastpass.lpandroid", "com.agilebits.onepassword",
            "com.google.android.packageinstaller", "com.android.packageinstaller", "com.android.vending",
            // VYRSE itself: its own switches are only ever flipped by the user.
            "dev.vyrse.phone",
    };

    private static final List<AccessibilityNodeInfo> lastScreen = new ArrayList<>();
    private static long lastAction = 0;
    private static int burst = 0;

    static boolean enabled(Context ctx) {
        return ctx.getSharedPreferences(VyrseLinkService.PREFS, Context.MODE_PRIVATE).getBoolean(PREF_CONTROL, false);
    }

    static void setEnabled(Context ctx, boolean on) {
        SharedPreferences.Editor e = ctx.getSharedPreferences(VyrseLinkService.PREFS, Context.MODE_PRIVATE).edit();
        e.putBoolean(PREF_CONTROL, on).apply();
    }

    static boolean isControlAction(String action) {
        switch (action) {
            case "screen": case "screenshot": case "tap": case "long_press": case "type": case "swipe":
            case "key": case "open_app": case "open_url":
                return true;
            default:
                return false;
        }
    }

    static JSONObject run(Context ctx, String action, JSONObject args) throws Exception {
        VyrseAccessibilityService svc = VyrseAccessibilityService.instance;
        if (svc == null) {
            return PhoneActions.error("Full control is off: on the phone, turn on VYRSE in Settings → Accessibility "
                    + "(then VYRSE → Settings → Phone → Allow full control).");
        }
        if (!enabled(ctx)) return PhoneActions.error("Full control isn't allowed on the phone (VYRSE → Settings → Phone).");
        long now = System.currentTimeMillis();
        burst = now - lastAction < 1000 ? burst + 1 : 0;
        lastAction = now;
        if (burst > 6) return PhoneActions.error("Slow down: too many phone actions at once.");
        String pkg = currentPackage(svc);
        if (isBlocked(pkg) && !action.equals("key")) {
            return PhoneActions.error("That app (" + pkg + ") is off limits: payments, banking, passwords and installing apps stay with you.");
        }
        svc.showControlIndicator();
        JSONObject result;
        switch (action) {
            case "screen": return screen(svc, pkg);
            case "screenshot": return screenshot(svc);
            case "tap": result = tap(svc, args, false); break;
            case "long_press": result = tap(svc, args, true); break;
            case "type": result = type(svc, args); break;
            case "swipe": result = swipe(svc, args); break;
            case "key": result = key(svc, args.optString("key")); break;
            case "open_app": result = openApp(svc, args.optString("name")); break;
            case "open_url": result = openUrl(svc, args.optString("url")); break;
            default: return PhoneActions.error("Unknown control action: " + action);
        }
        // Hand back the screen the action led to: the next step can be decided without another round trip.
        if (result.optBoolean("ok")) {
            Thread.sleep(action.startsWith("open_") ? 1300 : 650);
            JSONObject after = screen(svc, currentPackage(svc));
            if (after.optBoolean("ok")) {
                result.put("app", after.opt("app")).put("screen", after.opt("items"));
            }
        }
        return result;
    }

    private static boolean isBlocked(String pkg) {
        for (String b : BLOCKED) if (b.equals(pkg)) return true;
        return false;
    }

    private static String appLabel(Context ctx, String pkg) {
        try {
            PackageManager pm = ctx.getPackageManager();
            return pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString();
        } catch (Exception e) {
            return pkg;
        }
    }

    private static String currentPackage(VyrseAccessibilityService svc) {
        AccessibilityNodeInfo root = svc.getRootInActiveWindow();
        if (root != null && root.getPackageName() != null) return root.getPackageName().toString();
        return VyrseAccessibilityService.foregroundPackage;
    }

    private static String label(AccessibilityNodeInfo n) {
        if (n.isPassword()) return "(password field)";
        CharSequence t = n.getText();
        if (t == null || t.length() == 0) t = n.getContentDescription();
        if ((t == null || t.length() == 0) && Build.VERSION.SDK_INT >= 26) t = n.getHintText();
        String s = t == null ? "" : t.toString().replace('\n', ' ').trim();
        return s.length() > 80 ? s.substring(0, 80) + "…" : s;
    }

    /** What's on screen as numbered items (tap by number), plus the app in front. */
    private static JSONObject screen(VyrseAccessibilityService svc, String pkg) throws Exception {
        AccessibilityNodeInfo root = svc.getRootInActiveWindow();
        if (root == null) return PhoneActions.error("Can't read the screen right now (locked or a protected screen).");
        synchronized (lastScreen) {
            lastScreen.clear();
            collect(root, 0);
        }
        JSONArray items = new JSONArray();
        synchronized (lastScreen) {
            for (int i = 0; i < lastScreen.size(); i++) {
                AccessibilityNodeInfo n = lastScreen.get(i);
                JSONObject o = new JSONObject().put("n", i + 1);
                String l = rowText(n);
                if (!l.isEmpty()) o.put("text", l);
                if (n.isEditable()) o.put("kind", "field");
                else if (n.isCheckable()) o.put("kind", n.isChecked() ? "switch:on" : "switch:off");
                else if (isImage(n) && n.isClickable()) o.put("kind", "image");
                else if (n.isClickable() || n.isLongClickable()) o.put("kind", "button");
                else if (n.isScrollable()) o.put("kind", "list");
                items.put(o);
            }
        }
        return new JSONObject().put("ok", true).put("app", appLabel(svc, pkg)).put("package", pkg).put("items", items)
                .put("note", "Rows carry all their text: tap the row, not its image. Tap by n or by text.");
    }

    private static boolean actionable(AccessibilityNodeInfo n) {
        return n.isClickable() || n.isLongClickable() || n.isEditable() || n.isCheckable();
    }

    private static boolean isImage(AccessibilityNodeInfo n) {
        CharSequence c = n.getClassName();
        return c != null && (c.toString().endsWith("ImageView") || c.toString().endsWith("ImageButton"));
    }

    /** A tappable element's own label, or else the text of what's inside it ("Mom · see you soon · 10:42"). */
    private static String rowText(AccessibilityNodeInfo n) {
        String own = label(n);
        if (!actionable(n) || n.getChildCount() == 0) return own;
        StringBuilder sb = new StringBuilder(own);
        gatherText(n, sb, 0);
        String s = sb.toString().trim();
        if (s.startsWith("·")) s = s.substring(1).trim();
        return s.length() > 110 ? s.substring(0, 110) + "…" : s;
    }

    private static void gatherText(AccessibilityNodeInfo n, StringBuilder sb, int depth) {
        if (depth > 6 || sb.length() > 140) return;
        for (int i = 0; i < n.getChildCount(); i++) {
            AccessibilityNodeInfo c = n.getChild(i);
            if (c == null || !c.isVisibleToUser() || actionable(c)) continue; // tappable children are their own items
            String t = label(c);
            if (!t.isEmpty() && sb.indexOf(t) < 0) sb.append(sb.length() > 0 ? " · " : "").append(t);
            gatherText(c, sb, depth + 1);
        }
    }

    /**
     * Items are what can be acted on (with the text inside them) plus text that sits outside any of them.
     * Text inside a tappable row isn't listed again, and unlabelled decoration is left out.
     */
    private static void collect(AccessibilityNodeInfo n, int depth) {
        collect(n, depth, false);
    }

    private static void collect(AccessibilityNodeInfo n, int depth, boolean insideActionable) {
        if (n == null || depth > 40 || lastScreen.size() >= MAX_NODES) return;
        boolean act = actionable(n);
        if (n.isVisibleToUser()) {
            boolean labelled = !label(n).isEmpty() || (act && n.getChildCount() > 0 && !rowText(n).isEmpty());
            if (act && labelled) lastScreen.add(n);
            else if (!act && !insideActionable && !label(n).isEmpty()) lastScreen.add(n);
            else if (n.isScrollable() && !insideActionable && lastScreen.size() < 3) lastScreen.add(n);
        }
        for (int i = 0; i < n.getChildCount(); i++) collect(n.getChild(i), depth + 1, insideActionable || act);
    }

    private static AccessibilityNodeInfo find(VyrseAccessibilityService svc, JSONObject args) {
        int idx = args.optInt("n", 0);
        if (idx > 0) {
            synchronized (lastScreen) {
                if (idx <= lastScreen.size()) {
                    AccessibilityNodeInfo n = lastScreen.get(idx - 1);
                    if (n.refresh()) return n;
                }
            }
            return null;
        }
        String text = args.optString("text", "").trim();
        if (text.isEmpty()) return null;
        AccessibilityNodeInfo root = svc.getRootInActiveWindow();
        if (root == null) return null;
        List<AccessibilityNodeInfo> hits = root.findAccessibilityNodeInfosByText(text);
        AccessibilityNodeInfo best = null;
        int bestScore = -1;
        for (AccessibilityNodeInfo h : hits) {
            if (!h.isVisibleToUser()) continue;
            int score = 0;
            if (h.getText() != null && h.getText().length() > 0) score += 4; // real words, not an image's description
            if (label(h).equalsIgnoreCase(text)) score += 2;
            if (isImage(h)) score -= 3;
            if (score > bestScore) {
                bestScore = score;
                best = h;
            }
        }
        return best;
    }

    private static AccessibilityNodeInfo clickableAncestor(AccessibilityNodeInfo n) {
        AccessibilityNodeInfo cur = n;
        for (int i = 0; cur != null && i < 8; i++) {
            if (cur.isClickable() || cur.isLongClickable()) return cur;
            cur = cur.getParent();
        }
        return n;
    }

    private static JSONObject tap(VyrseAccessibilityService svc, JSONObject args, boolean longPress) throws Exception {
        if (args.has("x") && args.has("y") && !args.has("n") && !args.has("text")) {
            return gesture(svc, args.getInt("x"), args.getInt("y"), args.getInt("x"), args.getInt("y"), longPress ? 700 : 60)
                    ? new JSONObject().put("ok", true).put("tapped", args.getInt("x") + "," + args.getInt("y"))
                    : PhoneActions.error("The tap didn't go through.");
        }
        AccessibilityNodeInfo node = find(svc, args);
        if (node == null) return PhoneActions.error("Couldn't find that on screen; read the screen again (action=screen).");
        String what = label(node);
        AccessibilityNodeInfo target = clickableAncestor(node);
        String context = what + " " + label(target);
        if (SENSITIVE.matcher(context).find() && !"yes".equals(args.optString("confirmed"))) {
            return new JSONObject().put("ok", false).put("needs_confirmation", true).put("label", what.isEmpty() ? label(target) : what)
                    .put("error", "This could send, pay, delete, install or call: ask the user, then repeat with confirmed=yes.");
        }
        boolean done = target.performAction(longPress ? AccessibilityNodeInfo.ACTION_LONG_CLICK : AccessibilityNodeInfo.ACTION_CLICK);
        if (!done) {
            Rect r = new Rect();
            target.getBoundsInScreen(r);
            done = gesture(svc, r.centerX(), r.centerY(), r.centerX(), r.centerY(), longPress ? 700 : 60);
        }
        return done ? new JSONObject().put("ok", true).put("tapped", what) : PhoneActions.error("The tap didn't go through.");
    }

    private static JSONObject type(VyrseAccessibilityService svc, JSONObject args) throws Exception {
        String text = args.optString("text", "");
        AccessibilityNodeInfo field = args.has("n") ? find(svc, args) : null;
        if (field == null) {
            AccessibilityNodeInfo root = svc.getRootInActiveWindow();
            field = root == null ? null : root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        }
        if (field == null || !field.isEditable()) return PhoneActions.error("No text field is selected; tap one first.");
        if (field.isPassword()) return PhoneActions.error("VYRSE never types into password fields.");
        Bundle b = new Bundle();
        b.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
        boolean ok = field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, b);
        if (ok && "yes".equals(args.optString("submit")) && Build.VERSION.SDK_INT >= 30) {
            field.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.getId());
        }
        return ok
                ? new JSONObject().put("ok", true).put("typed", text)
                        .put("note", "Typed into the box only; NOT sent. To send, tap the Send button.")
                : PhoneActions.error("Couldn't type there.");
    }

    private static JSONObject swipe(VyrseAccessibilityService svc, JSONObject args) throws Exception {
        DisplayMetrics m = svc.getResources().getDisplayMetrics();
        int w = m.widthPixels, h = m.heightPixels;
        String dir = args.optString("direction", "up");
        int cx = w / 2, cy = h / 2;
        int x1 = cx, y1 = cy, x2 = cx, y2 = cy;
        switch (dir) {
            case "up": y1 = (int) (h * 0.75); y2 = (int) (h * 0.25); break;   // content moves up (scroll down)
            case "down": y1 = (int) (h * 0.25); y2 = (int) (h * 0.75); break;
            case "left": x1 = (int) (w * 0.85); x2 = (int) (w * 0.15); break;
            case "right": x1 = (int) (w * 0.15); x2 = (int) (w * 0.85); break;
            default: return PhoneActions.error("direction must be up, down, left or right");
        }
        return gesture(svc, x1, y1, x2, y2, 320) ? new JSONObject().put("ok", true).put("swiped", dir) : PhoneActions.error("The swipe didn't go through.");
    }

    private static boolean gesture(AccessibilityService svc, int x1, int y1, int x2, int y2, long ms) throws InterruptedException {
        Path p = new Path();
        p.moveTo(x1, y1);
        if (x1 != x2 || y1 != y2) p.lineTo(x2, y2);
        GestureDescription g = new GestureDescription.Builder().addStroke(new GestureDescription.StrokeDescription(p, 0, ms)).build();
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<Boolean> result = new AtomicReference<>(false);
        boolean sent = svc.dispatchGesture(g, new AccessibilityService.GestureResultCallback() {
            @Override public void onCompleted(GestureDescription d) { result.set(true); latch.countDown(); }
            @Override public void onCancelled(GestureDescription d) { latch.countDown(); }
        }, null);
        if (!sent) return false;
        latch.await(3, TimeUnit.SECONDS);
        return result.get();
    }

    private static JSONObject key(VyrseAccessibilityService svc, String key) throws Exception {
        int action;
        switch (key) {
            case "back": action = AccessibilityService.GLOBAL_ACTION_BACK; break;
            case "home": action = AccessibilityService.GLOBAL_ACTION_HOME; break;
            case "recents": action = AccessibilityService.GLOBAL_ACTION_RECENTS; break;
            case "notifications": action = AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS; break;
            case "quick_settings": action = AccessibilityService.GLOBAL_ACTION_QUICK_SETTINGS; break;
            case "lock": action = AccessibilityService.GLOBAL_ACTION_LOCK_SCREEN; break;
            default: return PhoneActions.error("key must be back, home, recents, notifications, quick_settings or lock");
        }
        return svc.performGlobalAction(action) ? new JSONObject().put("ok", true).put("pressed", key) : PhoneActions.error("That key didn't work.");
    }

    private static JSONObject openApp(VyrseAccessibilityService svc, String name) throws Exception {
        String want = name.toLowerCase(Locale.ROOT).trim();
        if (want.isEmpty()) return PhoneActions.error("Which app?");
        PackageManager pm = svc.getPackageManager();
        Intent launcher = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        ResolveInfo best = null;
        int bestScore = 0;
        for (ResolveInfo ri : pm.queryIntentActivities(launcher, 0)) {
            String label = ri.loadLabel(pm).toString().toLowerCase(Locale.ROOT);
            int score = label.equals(want) ? 3 : label.startsWith(want) ? 2 : label.contains(want) ? 1 : 0;
            if (score > bestScore) {
                bestScore = score;
                best = ri;
            }
        }
        if (best == null) return PhoneActions.error("No app called \"" + name + "\" on this phone.");
        String pkg = best.activityInfo.packageName;
        if (isBlocked(pkg)) return PhoneActions.error("That app is off limits: payments, banking, passwords and installing apps stay with you.");
        Intent open = pm.getLaunchIntentForPackage(pkg);
        if (open == null) return PhoneActions.error("That app can't be opened directly.");
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        svc.startActivity(open);
        return new JSONObject().put("ok", true).put("opened", best.loadLabel(pm).toString());
    }

    private static JSONObject openUrl(VyrseAccessibilityService svc, String url) throws Exception {
        Uri u = Uri.parse(url);
        if (u.getScheme() == null || !(u.getScheme().equals("https") || u.getScheme().equals("http"))) {
            return PhoneActions.error("Only web links (http/https) can be opened.");
        }
        svc.startActivity(new Intent(Intent.ACTION_VIEW, u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        return new JSONObject().put("ok", true).put("opened", u.getHost());
    }

    /** A JPEG of the screen (Android 11+), for the PC's vision model. Protected screens come back black. */
    private static JSONObject screenshot(VyrseAccessibilityService svc) throws Exception {
        if (Build.VERSION.SDK_INT < 30) return PhoneActions.error("Screenshots need Android 11 or newer.");
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<Bitmap> shot = new AtomicReference<>();
        svc.takeScreenshot(Display.DEFAULT_DISPLAY, svc.getMainExecutor(), new AccessibilityService.TakeScreenshotCallback() {
            @Override public void onSuccess(AccessibilityService.ScreenshotResult r) {
                Bitmap hw = Bitmap.wrapHardwareBuffer(r.getHardwareBuffer(), r.getColorSpace());
                if (hw != null) shot.set(hw.copy(Bitmap.Config.ARGB_8888, false));
                r.getHardwareBuffer().close();
                latch.countDown();
            }
            @Override public void onFailure(int code) { latch.countDown(); }
        });
        latch.await(5, TimeUnit.SECONDS);
        Bitmap b = shot.get();
        if (b == null) return PhoneActions.error("Couldn't take a screenshot (try again in a second).");
        int w = 720;
        Bitmap small = Bitmap.createScaledBitmap(b, w, Math.round(b.getHeight() * (w / (float) b.getWidth())), true);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        small.compress(Bitmap.CompressFormat.JPEG, 70, out);
        return new JSONObject().put("ok", true).put("jpeg_base64", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP))
                .put("width", w).put("height", small.getHeight());
    }
}

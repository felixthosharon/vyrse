package dev.vyrse.phone;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.view.KeyEvent;

import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * What VYRSE (Hermes on the PC) can do on this phone. Each action takes JSON args and returns
 * {ok, ...}. Nothing here reads messages beyond notifications the user allowed (Android's
 * notification access), and nothing installs, sends or pays for anything.
 */
public final class PhoneActions {
    private PhoneActions() {}

    static final String CHANNEL_MESSAGES = "vyrse_messages";
    private static Boolean torchOn = false;
    private static MediaPlayer ringer;
    private static int ringerRestoreVolume = -1;
    private static final Handler main = new Handler(Looper.getMainLooper());
    private static Context appCtx;

    public static JSONObject run(Context ctx, String action, JSONObject args) {
        appCtx = ctx.getApplicationContext();
        try {
            if (PhoneControl.isControlAction(action)) return PhoneControl.run(ctx, action, args);
            switch (action) {
                case "battery": return battery(ctx);
                case "flashlight": return flashlight(ctx, args.optString("state", "toggle"));
                case "find": return find(ctx, args.optString("state", "start"));
                case "media": return media(ctx, args.optString("command", "play_pause"));
                case "volume": return volume(ctx, args);
                case "notifications": return notifications(args.optInt("limit", 12));
                case "notify": return notify(ctx, args.optString("title", "VYRSE"), args.optString("text", ""));
                case "status": return status(ctx);
                default: return error("Unknown phone action: " + action);
            }
        } catch (Exception e) {
            return error(e.getClass().getSimpleName() + ": " + e.getMessage());
        }
    }

    static JSONObject error(String message) {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", false);
            o.put("error", message);
        } catch (Exception ignored) {}
        return o;
    }

    private static JSONObject ok() throws Exception {
        return new JSONObject().put("ok", true);
    }

    private static JSONObject battery(Context ctx) throws Exception {
        Intent b = ctx.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        int level = b == null ? -1 : b.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
        int scale = b == null ? 100 : b.getIntExtra(BatteryManager.EXTRA_SCALE, 100);
        int status = b == null ? -1 : b.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
        boolean charging = status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL;
        return ok().put("percent", level < 0 ? JSONObject.NULL : Math.round(level * 100f / scale)).put("charging", charging);
    }

    private static JSONObject flashlight(Context ctx, String state) throws Exception {
        CameraManager cm = (CameraManager) ctx.getSystemService(Context.CAMERA_SERVICE);
        String id = null;
        for (String c : cm.getCameraIdList()) {
            Boolean flash = cm.getCameraCharacteristics(c).get(CameraCharacteristics.FLASH_INFO_AVAILABLE);
            if (Boolean.TRUE.equals(flash)) {
                id = c;
                break;
            }
        }
        if (id == null) return error("This phone has no flashlight.");
        boolean on = state.equals("on") || (state.equals("toggle") && !torchOn);
        cm.setTorchMode(id, on);
        torchOn = on;
        return ok().put("flashlight", on ? "on" : "off");
    }

    /** Ring loudly (alarm sound, alarm volume, vibration) so the phone can be found; stops after 30 s. */
    private static JSONObject find(Context ctx, String state) throws Exception {
        AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        if (state.equals("stop")) {
            stopRinging(am);
            return ok().put("ringing", false);
        }
        stopRinging(am);
        Uri uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
        if (uri == null) uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        ringerRestoreVolume = am.getStreamVolume(AudioManager.STREAM_ALARM);
        am.setStreamVolume(AudioManager.STREAM_ALARM, am.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0);
        MediaPlayer mp = new MediaPlayer();
        mp.setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
        mp.setDataSource(ctx, uri);
        mp.setLooping(true);
        mp.prepare();
        mp.start();
        ringer = mp;
        Vibrator v = (Vibrator) ctx.getSystemService(Context.VIBRATOR_SERVICE);
        if (v != null) v.vibrate(VibrationEffect.createWaveform(new long[]{0, 600, 400}, 0));
        main.postDelayed(() -> stopRinging(am), 30_000);
        return ok().put("ringing", true).put("seconds", 30);
    }

    private static void stopRinging(AudioManager am) {
        if (ringer != null) {
            try {
                ringer.stop();
            } catch (Exception ignored) {}
            ringer.release();
            ringer = null;
        }
        if (ringerRestoreVolume >= 0) {
            am.setStreamVolume(AudioManager.STREAM_ALARM, ringerRestoreVolume, 0);
            ringerRestoreVolume = -1;
        }
        Context app = appCtx;
        if (app != null) {
            Vibrator v = (Vibrator) app.getSystemService(Context.VIBRATOR_SERVICE);
            if (v != null) v.cancel();
        }
    }

    private static JSONObject media(Context ctx, String command) throws Exception {
        int code;
        switch (command) {
            case "play": code = KeyEvent.KEYCODE_MEDIA_PLAY; break;
            case "pause": code = KeyEvent.KEYCODE_MEDIA_PAUSE; break;
            case "next": code = KeyEvent.KEYCODE_MEDIA_NEXT; break;
            case "previous": code = KeyEvent.KEYCODE_MEDIA_PREVIOUS; break;
            case "stop": code = KeyEvent.KEYCODE_MEDIA_STOP; break;
            default: code = KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE;
        }
        AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        am.dispatchMediaKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN, code));
        am.dispatchMediaKeyEvent(new KeyEvent(KeyEvent.ACTION_UP, code));
        return ok().put("media", command);
    }

    private static JSONObject volume(Context ctx, JSONObject args) throws Exception {
        AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        int max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
        if (args.has("level")) {
            int pct = Math.max(0, Math.min(100, args.getInt("level")));
            am.setStreamVolume(AudioManager.STREAM_MUSIC, Math.round(pct * max / 100f), 0);
        }
        int now = am.getStreamVolume(AudioManager.STREAM_MUSIC);
        return ok().put("level", Math.round(now * 100f / max));
    }

    private static JSONObject notifications(int limit) throws Exception {
        VyrseNotificationListener l = VyrseNotificationListener.instance;
        if (l == null) {
            return error("Notification access is off. On the phone: VYRSE → Settings → Phone → Allow notification access.");
        }
        JSONArray list = l.recent(Math.max(1, Math.min(30, limit)));
        return ok().put("count", list.length()).put("notifications", list);
    }

    private static JSONObject notify(Context ctx, String title, String text) throws Exception {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            return error("VYRSE isn't allowed to show notifications on this phone (Android Settings → Apps → VYRSE → Notifications).");
        }
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL_MESSAGES, "Messages from VYRSE", NotificationManager.IMPORTANCE_HIGH));
        Intent open = new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(ctx, 2, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new Notification.Builder(ctx, CHANNEL_MESSAGES)
                .setSmallIcon(R.drawable.ic_stat_vyrse)
                .setContentTitle(title.isEmpty() ? "VYRSE" : title)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setAutoCancel(true)
                .setContentIntent(pi)
                .build();
        nm.notify((int) (System.currentTimeMillis() % 100000), n);
        return ok().put("shown", true);
    }

    private static JSONObject status(Context ctx) throws Exception {
        return ok()
                .put("notificationAccess", VyrseNotificationListener.instance != null)
                .put("link", VyrseLinkService.running)
                .put("accessibility", VyrseAccessibilityService.instance != null)
                .put("fullControl", PhoneControl.enabled(ctx))
                .put("model", Build.MANUFACTURER + " " + Build.MODEL);
    }
}

package dev.vyrse.phone;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * "Let my PC reach this phone": a foreground service that keeps asking the VYRSE bridge on the PC
 * (home Wi-Fi) for commands, runs them (PhoneActions) and sends back the result. It talks only to the
 * paired PC, with this phone's own key. Shows a quiet ongoing notification while on, as Android requires.
 */
public class VyrseLinkService extends Service {
    static final String PREFS = "vyrse_link";
    static final String CHANNEL = "vyrse_link";
    static volatile boolean running = false;
    private volatile boolean stop = false;
    private Thread loop;

    static void start(Context ctx, String base, String token) {
        ctx.getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                .putString("base", base).putString("token", token).putBoolean("on", true).apply();
        ctx.startForegroundService(new Intent(ctx, VyrseLinkService.class));
    }

    static void stop(Context ctx) {
        ctx.getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("on", false).apply();
        ctx.stopService(new Intent(ctx, VyrseLinkService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Connection to your PC", NotificationManager.IMPORTANCE_MIN));
        PendingIntent open = PendingIntent.getActivity(this, 1, new Intent(this, MainActivity.class),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent stopControl = PendingIntent.getBroadcast(this, 3,
                new Intent(this, StopControlReceiver.class), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder nb = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_vyrse)
                .setContentTitle("VYRSE")
                .setContentText(PhoneControl.enabled(this) ? "Your PC can reach and control this phone" : "Your PC can reach this phone")
                .setOngoing(true)
                .setContentIntent(open);
        if (PhoneControl.enabled(this)) {
            nb.addAction(new Notification.Action.Builder(null, "Stop control", stopControl).build());
        }
        Notification n = nb.build();
        if (Build.VERSION.SDK_INT >= 34) startForeground(7, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(7, n);
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        if (!p.getBoolean("on", false)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (loop == null || !loop.isAlive()) {
            stop = false;
            loop = new Thread(this::poll, "vyrse-link");
            loop.start();
        }
        running = true;
        return START_STICKY;
    }

    private void poll() {
        long backoff = 2000;
        while (!stop) {
            SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
            String base = p.getString("base", null);
            String token = p.getString("token", null);
            if (base == null || token == null) break;
            try {
                JSONObject res = new JSONObject(http("GET", base + "/phone/commands", token, null, 35_000));
                JSONArray cmds = res.optJSONArray("commands");
                for (int i = 0; cmds != null && i < cmds.length(); i++) {
                    JSONObject c = cmds.getJSONObject(i);
                    JSONObject args = c.optJSONObject("args");
                    JSONObject result = PhoneActions.run(this, c.optString("action"), args == null ? new JSONObject() : args);
                    http("POST", base + "/phone/command-result", token,
                            new JSONObject().put("id", c.optString("id")).put("result", result).toString(), 15_000);
                }
                backoff = 2000;
            } catch (Exception e) {
                // PC off, other Wi-Fi, VYRSE closed: try again, slowly.
                try {
                    Thread.sleep(backoff);
                } catch (InterruptedException ignored) {
                    return;
                }
                backoff = Math.min(backoff * 2, 60_000);
            }
        }
    }

    private static String http(String method, String url, String token, String body, int timeoutMs) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(5000);
        c.setReadTimeout(timeoutMs);
        c.setRequestProperty("X-Hermes-Session-Token", token);
        if (body != null) {
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            try (OutputStream os = c.getOutputStream()) {
                os.write(body.getBytes(StandardCharsets.UTF_8));
            }
        }
        int code = c.getResponseCode();
        if (code >= 400) throw new IllegalStateException("HTTP " + code);
        try (InputStream in = c.getInputStream()) {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] chunk = new byte[4096];
            for (int r; (r = in.read(chunk)) > 0; ) buf.write(chunk, 0, r);
            return buf.toString("UTF-8");
        } finally {
            c.disconnect();
        }
    }

    @Override
    public void onDestroy() {
        stop = true;
        running = false;
        if (loop != null) loop.interrupt();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}

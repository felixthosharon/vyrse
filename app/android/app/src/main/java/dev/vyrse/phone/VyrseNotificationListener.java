package dev.vyrse.phone;

import android.app.Notification;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Arrays;
import java.util.Comparator;

/**
 * Notification access (the user turns it on in Android settings): lets VYRSE read what's currently in the
 * notification shade when asked ("any new messages?"). Nothing is stored or sent until VYRSE asks.
 */
public class VyrseNotificationListener extends NotificationListenerService {
    static volatile VyrseNotificationListener instance;

    @Override
    public void onListenerConnected() {
        instance = this;
    }

    @Override
    public void onListenerDisconnected() {
        if (instance == this) instance = null;
    }

    @Override
    public void onDestroy() {
        if (instance == this) instance = null;
        super.onDestroy();
    }

    JSONArray recent(int limit) throws Exception {
        StatusBarNotification[] active = getActiveNotifications();
        JSONArray out = new JSONArray();
        if (active == null) return out;
        Arrays.sort(active, Comparator.comparingLong(StatusBarNotification::getPostTime).reversed());
        PackageManager pm = getPackageManager();
        for (StatusBarNotification sbn : active) {
            if (out.length() >= limit) break;
            Notification n = sbn.getNotification();
            if (sbn.getPackageName().equals(getPackageName())) continue;
            if ((n.flags & Notification.FLAG_ONGOING_EVENT) != 0 || (n.flags & Notification.FLAG_GROUP_SUMMARY) != 0) continue;
            Bundle e = n.extras;
            CharSequence title = e.getCharSequence(Notification.EXTRA_TITLE);
            CharSequence text = e.getCharSequence(Notification.EXTRA_BIG_TEXT);
            if (text == null) text = e.getCharSequence(Notification.EXTRA_TEXT);
            if (title == null && text == null) continue;
            String app = sbn.getPackageName();
            try {
                ApplicationInfo ai = pm.getApplicationInfo(app, 0);
                app = pm.getApplicationLabel(ai).toString();
            } catch (Exception ignored) {}
            String body = text == null ? "" : text.toString();
            out.put(new JSONObject()
                    .put("app", app)
                    .put("title", title == null ? "" : title.toString())
                    .put("text", body.length() > 300 ? body.substring(0, 300) + "…" : body)
                    .put("minutesAgo", Math.max(0, (System.currentTimeMillis() - sbn.getPostTime()) / 60000)));
        }
        return out;
    }
}

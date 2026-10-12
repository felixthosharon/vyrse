package dev.vyrse.phone;

import android.Manifest;
import android.content.ComponentName;
import android.content.Intent;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONObject;

/** The web app's door to PhoneActions and the PC link (window.Capacitor.Plugins.VyrsePhone). */
@CapacitorPlugin(
        name = "VyrsePhone",
        permissions = {@Permission(strings = {Manifest.permission.POST_NOTIFICATIONS}, alias = "notifications")}
)
public class VyrsePhonePlugin extends Plugin {

    @PluginMethod
    public void run(PluginCall call) {
        String action = call.getString("action", "");
        JSObject args = call.getObject("args", new JSObject());
        new Thread(() -> {
            JSONObject result = PhoneActions.run(getContext(), action, args);
            try {
                call.resolve(JSObject.fromJSONObject(result));
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        }, "vyrse-action").start();
    }

    @PluginMethod
    public void startLink(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            // The link's ongoing notification (and "show this on my phone") need notification permission.
            requestPermissionForAlias("notifications", call, "afterNotificationPermission");
            return;
        }
        doStartLink(call);
    }

    @PermissionCallback
    private void afterNotificationPermission(PluginCall call) {
        doStartLink(call);
    }

    private void doStartLink(PluginCall call) {
        String base = call.getString("base");
        String token = call.getString("token");
        if (base == null || token == null) {
            call.reject("base and token are required");
            return;
        }
        VyrseLinkService.start(getContext(), base, token);
        call.resolve(status());
    }

    @PluginMethod
    public void stopLink(PluginCall call) {
        VyrseLinkService.stop(getContext());
        call.resolve(status());
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(status());
    }

    @PluginMethod
    public void openNotificationAccess(PluginCall call) {
        Intent i;
        if (Build.VERSION.SDK_INT >= 30) {
            i = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS);
            i.putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME,
                    new ComponentName(getContext(), VyrseNotificationListener.class).flattenToString());
        } else {
            i = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
        }
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(i);
        } catch (Exception e) {
            getContext().startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        }
        call.resolve();
    }

    /** Full control is switched on here only, on the phone itself (never from the PC). */
    @PluginMethod
    public void setFullControl(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        PhoneControl.setEnabled(getContext(), on && VyrseAccessibilityService.instance != null);
        call.resolve(status());
    }

    @PluginMethod
    public void openAccessibilitySettings(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    /** Android 13+ hides Accessibility for sideloaded apps until "Allow restricted settings" in App info. */
    @PluginMethod
    public void openAppInfo(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                android.net.Uri.parse("package:" + getContext().getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    private JSObject status() {
        JSObject o = new JSObject();
        o.put("link", getContext().getSharedPreferences(VyrseLinkService.PREFS, 0).getBoolean("on", false));
        o.put("linkRunning", VyrseLinkService.running);
        o.put("notificationAccess", VyrseNotificationListener.instance != null);
        o.put("accessibility", VyrseAccessibilityService.instance != null);
        // Accessibility switched off in Android: full control is off too, for next time.
        if (VyrseAccessibilityService.instance == null && PhoneControl.enabled(getContext())) PhoneControl.setEnabled(getContext(), false);
        o.put("fullControl", PhoneControl.enabled(getContext()));
        o.put("notificationPermission", Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED);
        return o;
    }
}

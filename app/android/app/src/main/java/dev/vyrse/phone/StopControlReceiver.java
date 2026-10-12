package dev.vyrse.phone;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** "Stop control" in VYRSE's notification: full control off at once. */
public class StopControlReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        PhoneControl.setEnabled(ctx, false);
        if (ctx.getSharedPreferences(VyrseLinkService.PREFS, Context.MODE_PRIVATE).getBoolean("on", false)) {
            ctx.startForegroundService(new Intent(ctx, VyrseLinkService.class)); // refresh the notification
        }
    }
}

package dev.vyrse.phone;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** After a restart, reconnect to the PC if "Let my PC reach this phone" was on. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;
        if (ctx.getSharedPreferences(VyrseLinkService.PREFS, Context.MODE_PRIVATE).getBoolean("on", false)) {
            ctx.startForegroundService(new Intent(ctx, VyrseLinkService.class));
        }
    }
}

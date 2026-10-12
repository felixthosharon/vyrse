package dev.vyrse.phone;

import android.accessibilityservice.AccessibilityService;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.widget.FrameLayout;

/**
 * Full phone control (PhoneControl): the only official way an app can see and operate other apps without
 * root. Android requires the user to switch it on in Settings → Accessibility, and VYRSE additionally needs
 * its own "Allow full control" switch. While VYRSE is acting, a glowing border is shown on screen.
 */
public class VyrseAccessibilityService extends AccessibilityService {
    static volatile VyrseAccessibilityService instance;
    static volatile String foregroundPackage = "";

    private final Handler main = new Handler(Looper.getMainLooper());
    private View border;
    private final Runnable hideBorder = this::removeBorder;

    @Override
    protected void onServiceConnected() {
        instance = this;
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event.getEventType() == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED && event.getPackageName() != null) {
            foregroundPackage = event.getPackageName().toString();
        }
    }

    @Override
    public void onInterrupt() {}

    @Override
    public boolean onUnbind(android.content.Intent intent) {
        if (instance == this) instance = null;
        main.post(this::removeBorder);
        return super.onUnbind(intent);
    }

    @Override
    public void onDestroy() {
        if (instance == this) instance = null;
        super.onDestroy();
    }

    /** Glow the screen edge while VYRSE is in control; it fades out a few seconds after the last action. */
    void showControlIndicator() {
        main.post(() -> {
            if (border == null) {
                WindowManager wm = (WindowManager) getSystemService(WINDOW_SERVICE);
                FrameLayout frame = new FrameLayout(this);
                GradientDrawable glow = new GradientDrawable();
                glow.setColor(Color.TRANSPARENT);
                glow.setStroke(dp(4), Color.parseColor("#B37FE3F0"));
                glow.setCornerRadius(dp(28));
                frame.setBackground(glow);
                WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                        WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT,
                        WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                        WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE | WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                                | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                        PixelFormat.TRANSLUCENT);
                lp.gravity = Gravity.TOP | Gravity.START;
                try {
                    wm.addView(frame, lp);
                    border = frame;
                } catch (Exception ignored) {
                    return;
                }
            }
            main.removeCallbacks(hideBorder);
            main.postDelayed(hideBorder, 3500);
        });
    }

    private void removeBorder() {
        if (border == null) return;
        try {
            ((WindowManager) getSystemService(WINDOW_SERVICE)).removeView(border);
        } catch (Exception ignored) {}
        border = null;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}

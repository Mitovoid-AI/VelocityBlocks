package com.velocityblocks.game;

import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.WindowManager;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import java.io.File;

public class MainActivity extends BridgeActivity {
    /** Everything that can pause a race is logged under this tag: adb logcat -s VbPause */
    static final String TAG = "VbPause";
    /**
     * Focus lost for less than this does not pause the race: the screenshot flash, a quick peek
     * at the shade, an OEM edge or game panel opened and closed.
     */
    private static final long FOCUS_LOSS_GRACE_MS = 500;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Runnable focusLostTask = this::dispatchFocusLost;
    private boolean resumed;
    private long focusLostAt;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins must be registered before the bridge starts in super.onCreate.
        registerPlugin(VbNativePlugin.class);
        super.onCreate(savedInstanceState);
        clearOldCaptures();
        // Lay the game out under a side camera cutout in landscape. With the default mode (Android
        // 9-14) the window stops short of it, and a back swipe that starts in that black strip never
        // reaches the WebView, so it could not be told from a real Back and paused the race.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(lp);
        }
        hideSystemBars();
        // No bridge when the system WebView is missing: Capacitor shows its own message then.
        if (getBridge() == null) return;
        // The HUD is laid out in px; WebView would otherwise apply the system font size as a
        // page-wide text zoom and make it overlap. (The screen-on flag is set by the game
        // while racing, through VbNativePlugin.keepAwake.)
        WebView webView = getBridge().getWebView();
        webView.getSettings().setTextZoom(100);
        // Back pauses the race or goes up a menu; on the main menu the app goes to the
        // background like any other Android back press. During a race the game may swallow a
        // Back that came from a swipe over its controls (RaceMode.back).
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                Log.i(TAG, "back");
                webView.evaluateJavascript("!!(window.vbBack && window.vbBack())", handled -> {
                    if (!"true".equals(handled)) moveTaskToBack(true);
                });
            }
        });
    }

    @Override
    public void onResume() {
        super.onResume();
        resumed = true;
    }

    @Override
    public void onPause() {
        resumed = false;
        super.onPause();
    }

    @Override
    public void onDestroy() {
        ui.removeCallbacks(focusLostTask);
        super.onDestroy();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        ui.removeCallbacks(focusLostTask);
        if (hasFocus) {
            hideSystemBars();
            if (focusLostAt != 0) Log.i(TAG, "focus back after " + (SystemClock.uptimeMillis() - focusLostAt) + " ms");
            focusLostAt = 0;
        } else if (getBridge() != null) {
            // The notification shade, an overlay or a dialog covers the game without hiding the
            // page. The game pauses only if it is still covered after the grace period.
            focusLostAt = SystemClock.uptimeMillis();
            ui.postDelayed(focusLostTask, FOCUS_LOSS_GRACE_MS);
        }
    }

    /**
     * Tell the game the window has stayed unfocused. `resumed` is read half a second in, when
     * onPause has run if a whole screen covers the game (call, camera) rather than an overlay
     * (shade, pop-up, game panel). Old web bundles ignore the detail; the event name is unchanged.
     */
    private void dispatchFocusLost() {
        if (getBridge() == null || hasWindowFocus()) return;
        long ms = SystemClock.uptimeMillis() - focusLostAt;
        boolean multiWindow = Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && isInMultiWindowMode();
        Log.i(TAG, "focus lost " + ms + " ms, resumed=" + resumed + ", multiWindow=" + multiWindow);
        String detail = "{\"ms\":" + ms + ",\"resumed\":" + resumed + ",\"multiWindow\":" + multiWindow + "}";
        getBridge()
            .getWebView()
            .evaluateJavascript("window.dispatchEvent(new CustomEvent('vb-focuslost',{detail:" + detail + "}))", null);
    }

    /**
     * Capacitor's <input capture> path writes the full-size shot to files/Pictures/JPEG_*.jpg
     * and never deletes it (BridgeWebChromeClient.createImageFile); the game keeps only a
     * 192px copy. Cold start only: in onPause the camera app may still be writing the file.
     */
    private void clearOldCaptures() {
        try {
            File dir = getExternalFilesDir(Environment.DIRECTORY_PICTURES);
            File[] files = dir == null ? null : dir.listFiles((d, n) -> n.startsWith("JPEG_") && n.endsWith(".jpg"));
            if (files == null) return;
            long cutoff = System.currentTimeMillis() - 10 * 60 * 1000L;
            for (File f : files) {
                if (f.lastModified() < cutoff) f.delete();
            }
        } catch (SecurityException ignored) {
            // External storage unavailable: nothing to clean.
        }
    }

    /**
     * Sticky immersive: a swipe from an edge shows the bars for a moment. Keep that behaviour;
     * the game's touch controls carry gesture-exclusion rects and keep clear of the gesture
     * strips (VbNativePlugin.setGestureExclusion / getGestureInsets).
     */
    private void hideSystemBars() {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        WindowInsetsControllerCompat controller =
            WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        controller.hide(WindowInsetsCompat.Type.systemBars());
        controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
    }
}

package com.velocityblocks.game;

import android.os.Bundle;
import android.os.Environment;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import java.io.File;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins must be registered before the bridge starts in super.onCreate.
        registerPlugin(VbNativePlugin.class);
        super.onCreate(savedInstanceState);
        clearOldCaptures();
        hideSystemBars();
        // No bridge when the system WebView is missing: Capacitor shows its own message then.
        if (getBridge() == null) return;
        // The HUD is laid out in px; WebView would otherwise apply the system font size as a
        // page-wide text zoom and make it overlap. (The screen-on flag is set by the game
        // while racing, through VbNativePlugin.keepAwake.)
        WebView webView = getBridge().getWebView();
        webView.getSettings().setTextZoom(100);
        // Back pauses the race or goes up a menu; on the main menu the app goes to the
        // background like any other Android back press.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                webView.evaluateJavascript("!!(window.vbBack && window.vbBack())", handled -> {
                    if (!"true".equals(handled)) moveTaskToBack(true);
                });
            }
        });
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            hideSystemBars();
        } else if (getBridge() != null) {
            // The notification shade or an overlay covers the game without hiding the page.
            getBridge().getWebView().evaluateJavascript("window.dispatchEvent(new Event('vb-focuslost'))", null);
        }
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

    private void hideSystemBars() {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        WindowInsetsControllerCompat controller =
            WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        controller.hide(WindowInsetsCompat.Type.systemBars());
        controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
    }
}

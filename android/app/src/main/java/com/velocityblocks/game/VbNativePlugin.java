package com.velocityblocks.game;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.res.Resources;
import android.graphics.Rect;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebView;
import androidx.activity.result.ActivityResult;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;

/** Native helpers the web game needs on Android (see src/platform/native.ts). */
@CapacitorPlugin(name = "VbNative")
public class VbNativePlugin extends Plugin {
    /** The last gesture strips sent to the game, so only changes are sent. */
    private String lastInsets = "";

    @Override
    public void load() {
        // The game keeps its touch controls out of the system gesture strips (getGestureInsets).
        // Send them again whenever insets are dispatched (rotation, a nav mode or sensitivity
        // change) or the window is laid out again; the listener passes the insets on unchanged.
        // On the WebView's parent, not the WebView: there it would replace Chromium's own listener,
        // which feeds env(safe-area-inset-*) on Android 9-11. The parent (Capacitor's layout, no
        // fitsSystemWindows) passes the insets on to the WebView unconsumed.
        WebView web = getBridge().getWebView();
        if (web.getParent() instanceof View) {
            ViewCompat.setOnApplyWindowInsetsListener((View) web.getParent(), (v, insets) -> {
                v.post(this::reportGestureInsets);
                return ViewCompat.onApplyWindowInsets(v, insets);
            });
        }
        getActivity().getWindow().getDecorView().addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> reportGestureInsets());
    }

    @Override
    protected void handleOnResume() {
        reportGestureInsets();
    }

    /**
     * Save a text file where the user chooses (Android's "Save as" screen). The WebView drops
     * <a download> links, so this replaces the browser download used on the web.
     */
    @PluginMethod
    public void saveText(PluginCall call) {
        String text = call.getString("text");
        if (text == null) {
            call.reject("Nothing to save");
            return;
        }
        // Park the text in a file and drop it from the call: Capacitor keeps the call (and
        // writes its options into the saved-state Bundle) while the picker is open.
        try (OutputStream out = new FileOutputStream(pendingFile())) {
            out.write(text.getBytes(StandardCharsets.UTF_8));
        } catch (IOException e) {
            call.reject("Could not prepare the file: " + e.getMessage(), e);
            return;
        }
        call.getData().remove("text");
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(call.getString("mime", "application/json"));
        intent.putExtra(Intent.EXTRA_TITLE, call.getString("name", "track.json"));
        try {
            startActivityForResult(call, intent, "onSaveTextResult");
        } catch (ActivityNotFoundException e) {
            getBridge().releaseCall(call);
            pendingFile().delete();
            call.reject("No app on this device can save files");
        }
    }

    @ActivityCallback
    private void onSaveTextResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        File pending = pendingFile();
        Intent data = result.getData();
        Uri uri = data != null ? data.getData() : null;
        try {
            boolean saved = false;
            if (result.getResultCode() == Activity.RESULT_OK && uri != null) {
                try (InputStream in = new FileInputStream(pending); OutputStream out = openTruncated(uri)) {
                    byte[] buf = new byte[16384];
                    for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
                }
                saved = true;
            }
            JSObject ret = new JSObject();
            ret.put("saved", saved);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Could not save the file: " + e.getMessage(), e);
        } finally {
            pending.delete();
            getBridge().releaseCall(call);
        }
    }

    private File pendingFile() {
        return new File(getContext().getCacheDir(), "pending-export");
    }

    /** "wt" so overwriting a longer file leaves no stale tail; some providers only take "w". */
    private OutputStream openTruncated(Uri uri) throws IOException {
        OutputStream out;
        try {
            out = getContext().getContentResolver().openOutputStream(uri, "wt");
        } catch (FileNotFoundException | IllegalArgumentException e) {
            out = getContext().getContentResolver().openOutputStream(uri, "w");
        }
        if (out == null) throw new IOException("the file could not be opened");
        return out;
    }

    /*
     * RESOLVED: a call with nothing to return still resolves with an empty object, never resolve().
     * Capacitor's bridge logs every plugin result in debug builds with console.dir(result.data); with no
     * data that is console.dir(undefined), which logcat shows as "Capacitor/Console: Line 353 - Msg:
     * undefined" (keepAwake and setGestureExclusion run at every launch). An object logs as
     * "[object Object]", which Capacitor's console filter drops.
     */

    /** Keep the screen on while a race is running; menus may time out normally. */
    @PluginMethod
    public void keepAwake(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        Activity activity = getActivity();
        activity.runOnUiThread(() -> {
            if (on) activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            call.resolve(new JSObject()); // not resolve(): see RESOLVED
        });
    }

    /**
     * Turn the back swipe off over the touch controls while racing (Android 10+; a no-op below).
     * "rects" are {l,t,r,b} in CSS px of a "vw" x "vh" page; an empty list clears them. They are
     * set on the decor view, which nothing else touches, in window coordinates.
     */
    @PluginMethod
    public void setGestureExclusion(PluginCall call) {
        JSArray list = call.getArray("rects", new JSArray());
        double vw = call.getDouble("vw", 0d);
        double vh = call.getDouble("vh", 0d);
        getActivity().runOnUiThread(() -> {
            WebView web = getBridge().getWebView();
            if (web.getWidth() == 0 || web.getHeight() == 0 || vw <= 0 || vh <= 0) {
                call.reject("not laid out");
                return;
            }
            int[] at = new int[2];
            web.getLocationInWindow(at);
            double sx = web.getWidth() / vw;
            double sy = web.getHeight() / vh;
            List<Rect> rects = new ArrayList<>();
            for (int i = 0; i < list.length(); i++) {
                JSONObject r = list.optJSONObject(i);
                if (r == null) continue;
                rects.add(new Rect(
                    at[0] + (int) Math.floor(r.optDouble("l", 0) * sx),
                    at[1] + (int) Math.floor(r.optDouble("t", 0) * sy),
                    at[0] + (int) Math.ceil(r.optDouble("r", 0) * sx),
                    at[1] + (int) Math.ceil(r.optDouble("b", 0) * sy)
                ));
            }
            ViewCompat.setSystemGestureExclusionRects(getActivity().getWindow().getDecorView(), rects);
            Log.i(MainActivity.TAG, "gesture exclusion " + rects);
            call.resolve(new JSObject()); // not resolve(): see RESOLVED
        });
    }

    /**
     * The system gesture strips in dp ({l,r,t,b}): the back-swipe edges, the home bar and the
     * shade pull. They are reported even while the bars are hidden. Also sent as the
     * "gestureInsets" event whenever they change.
     */
    @PluginMethod
    public void getGestureInsets(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            JSObject g = gestureInsets();
            if (g == null) call.reject("not attached");
            else call.resolve(g);
        });
    }

    /** Main thread only. */
    private void reportGestureInsets() {
        JSObject g = gestureInsets();
        if (g == null) return;
        String key = g.toString();
        if (key.equals(lastInsets)) return;
        lastInsets = key;
        Log.i(MainActivity.TAG, "gesture insets " + key);
        notifyListeners("gestureInsets", g);
    }

    /** Null before the window is attached. Main thread only. */
    private JSObject gestureInsets() {
        View decor = getActivity().getWindow().getDecorView();
        WindowInsetsCompat w = ViewCompat.getRootWindowInsets(decor);
        if (w == null) return null;
        Insets i = w.getInsets(WindowInsetsCompat.Type.systemGestures() | WindowInsetsCompat.Type.mandatorySystemGestures());
        float d = getContext().getResources().getDisplayMetrics().density;
        JSObject o = new JSObject();
        o.put("l", Math.round(i.left / d));
        o.put("r", Math.round(i.right / d));
        o.put("t", Math.round(i.top / d));
        o.put("b", Math.round(i.bottom / d));
        return o;
    }

    /** The phone and its navigation mode, for the pause screen's diagnostics line. */
    @PluginMethod
    public void deviceInfo(PluginCall call) {
        JSObject o = new JSObject();
        o.put("sdk", Build.VERSION.SDK_INT);
        o.put("release", Build.VERSION.RELEASE);
        o.put("maker", Build.MANUFACTURER);
        o.put("model", Build.MODEL);
        o.put("nav", navMode());
        call.resolve(o);
    }

    /** 'gesture', '3-button', '2-button' or 'unknown'. Diagnostics only: OEM skins may misreport. */
    private String navMode() {
        try {
            Resources res = getContext().getResources();
            int id = res.getIdentifier("config_navBarInteractionMode", "integer", "android");
            int mode = id != 0 ? res.getInteger(id) : -1;
            if (mode == 2) return "gesture";
            // Xiaomi (MIUI / HyperOS) keeps its own full-screen gesture switch and reports 0 above.
            if (Settings.Global.getInt(getContext().getContentResolver(), "force_fsg_nav_bar", 0) == 1) return "gesture";
            if (mode == 1) return "2-button";
            if (mode == 0) return "3-button";
        } catch (RuntimeException e) {
            // Resource missing or setting unreadable: say unknown.
        }
        return "unknown";
    }
}

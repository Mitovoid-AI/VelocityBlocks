package com.velocityblocks.game;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.view.WindowManager;
import androidx.activity.result.ActivityResult;
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

/** Native helpers the web game needs on Android (see src/platform/native.ts). */
@CapacitorPlugin(name = "VbNative")
public class VbNativePlugin extends Plugin {

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

    /** Keep the screen on while a race is running; menus may time out normally. */
    @PluginMethod
    public void keepAwake(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        Activity activity = getActivity();
        activity.runOnUiThread(() -> {
            if (on) activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            call.resolve();
        });
    }
}

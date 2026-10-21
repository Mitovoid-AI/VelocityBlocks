package com.velocityblocks.game;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.InstallSourceInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
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
import androidx.core.content.FileProvider;
import androidx.core.content.pm.PackageInfoCompat;
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
import java.io.InterruptedIOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
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
        updateExec.execute(this::clearOldUpdate);
    }

    @Override
    protected void handleOnResume() {
        reportGestureInsets();
        resumeInstall();
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

    /**
     * The package that installed this app: "com.android.vending" for Google Play, a package installer
     * or file manager (or nothing) for an APK installed by hand. {known: false} when Android would not
     * say. The update check (src/platform/updates.ts) only runs for installs that are not from Play.
     */
    @PluginMethod
    public void installSource(PluginCall call) {
        JSObject o = new JSObject();
        try {
            String installer = installerPackage();
            o.put("known", true);
            if (installer != null) o.put("installer", installer);
        } catch (Throwable e) {
            // Unknown: the game then treats the install as if it came from Play (no update check).
            Log.w(MainActivity.TAG, "install source unknown", e);
            o.put("known", false);
        }
        call.resolve(o);
    }

    @SuppressWarnings("deprecation")
    private String installerPackage() throws PackageManager.NameNotFoundException {
        PackageManager pm = getContext().getPackageManager();
        String pkg = getContext().getPackageName();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            InstallSourceInfo info = pm.getInstallSourceInfo(pkg);
            return info.getInstallingPackageName();
        }
        return pm.getInstallerPackageName(pkg);
    }

    /**
     * Open an https address in the system browser (or the app that handles it), outside the game. Used
     * for an update's APK download: the browser downloads it and Android offers to install it.
     * Resolves {opened: false} when no app can open it.
     */
    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url");
        Uri uri = url != null ? Uri.parse(url) : null;
        if (uri == null || !"https".equalsIgnoreCase(uri.getScheme())) {
            call.reject("Not an https address");
            return;
        }
        JSObject ret = new JSObject();
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            intent.addCategory(Intent.CATEGORY_BROWSABLE);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            ret.put("opened", true);
        } catch (ActivityNotFoundException e) {
            ret.put("opened", false);
        } catch (Exception e) {
            call.reject("Could not open the address: " + e.getMessage(), e);
            return;
        }
        call.resolve(ret);
    }

    // ------------------------------------------------------------------ In-app updates (GitHub build)
    //
    // The GitHub build downloads a release's APK itself, with progress for the game's pop-up, then opens
    // Android's installer on it. The Play build (BuildConfig.SELF_UPDATE false) refuses: Google Play
    // updates it. Android 6 (API 23) cannot install from a content:// address, so it keeps the browser
    // download (openUrl).

    /** Only APKs attached to this repo's releases are downloaded (src/platform/updates.ts DOWNLOAD_PREFIX). */
    private static final String UPDATE_PREFIX = "https://github.com/Mitovoid-AI/VelocityBlocks/releases/download/";
    private static final String APK_MIME = "application/vnd.android.package-archive";
    private final ExecutorService updateExec = Executors.newSingleThreadExecutor();
    private volatile boolean updateBusy = false;
    private volatile boolean updateCancel = false;
    /** The player was sent to "Install unknown apps": open the installer when they come back with it allowed. */
    private boolean installOnResume = false;

    private File updateDir() {
        return new File(getContext().getCacheDir(), "updates");
    }

    private File updateFile() {
        return new File(updateDir(), "update.apk");
    }

    private static boolean inAppUpdates() {
        return BuildConfig.SELF_UPDATE && Build.VERSION.SDK_INT >= Build.VERSION_CODES.N;
    }

    /** {inApp}: whether this build downloads and installs updates itself (else: the browser download). */
    @PluginMethod
    public void updateSupport(PluginCall call) {
        JSObject o = new JSObject();
        o.put("inApp", inAppUpdates());
        call.resolve(o);
    }

    /**
     * Download {url} (a release APK of this repo; {size} bytes if known) to the app's cache, sending
     * "updateProgress" {received, total} events. Resolves {version} once the file is a complete APK of this
     * app with a higher versionCode; rejects otherwise ("cancelled" after cancelUpdate).
     */
    @PluginMethod
    public void downloadUpdate(PluginCall call) {
        if (!inAppUpdates()) {
            call.reject("In-app updates are off in this build");
            return;
        }
        String url = call.getString("url");
        if (url == null || !url.startsWith(UPDATE_PREFIX) || !url.toLowerCase(java.util.Locale.ROOT).endsWith(".apk")) {
            call.reject("Not a release APK of this app");
            return;
        }
        if (updateBusy) {
            call.reject("A download is already running");
            return;
        }
        long expected = call.getData().optLong("size", 0);
        updateBusy = true;
        updateCancel = false;
        updateExec.execute(() -> {
            File dir = updateDir();
            File part = new File(dir, "update.apk.part");
            File out = updateFile();
            HttpURLConnection conn = null;
            try {
                if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("no space for the download");
                out.delete();
                conn = (HttpURLConnection) new URL(url).openConnection();
                // GitHub answers with a redirect to its download host (https to https: followed).
                conn.setInstanceFollowRedirects(true);
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(30000);
                conn.setRequestProperty("Accept", "application/octet-stream");
                int code = conn.getResponseCode();
                if (code != HttpURLConnection.HTTP_OK) throw new IOException("the server answered " + code);
                long total = parseLength(conn.getHeaderField("Content-Length"));
                if (total <= 0) total = expected;
                long received = 0;
                long lastSent = 0;
                try (InputStream in = conn.getInputStream(); OutputStream os = new FileOutputStream(part)) {
                    byte[] buf = new byte[65536];
                    for (int n; (n = in.read(buf)) > 0; ) {
                        if (updateCancel) throw new InterruptedIOException("cancelled");
                        os.write(buf, 0, n);
                        received += n;
                        long now = System.currentTimeMillis();
                        if (now - lastSent >= 120) {
                            lastSent = now;
                            sendProgress(received, total);
                        }
                    }
                }
                if (updateCancel) throw new InterruptedIOException("cancelled");
                if (total > 0 && received != total) throw new IOException("the download was cut short");
                sendProgress(received, total);
                if (!part.renameTo(out)) throw new IOException("could not keep the download");
                String version = checkApk(out);
                Log.i(MainActivity.TAG, "update downloaded: " + version + " (" + received + " bytes)");
                JSObject ret = new JSObject();
                ret.put("version", version);
                ret.put("size", received);
                call.resolve(ret);
            } catch (InterruptedIOException e) {
                out.delete();
                call.reject("cancelled", "CANCELLED");
            } catch (Exception e) {
                Log.w(MainActivity.TAG, "update download failed", e);
                out.delete();
                call.reject(e.getMessage() != null ? e.getMessage() : e.toString(), e);
            } finally {
                part.delete();
                if (conn != null) conn.disconnect();
                updateBusy = false;
            }
        });
    }

    /** Stop a running download (its call rejects with "cancelled"). */
    @PluginMethod
    public void cancelUpdate(PluginCall call) {
        updateCancel = true;
        call.resolve(new JSObject()); // not resolve(): see RESOLVED
    }

    /**
     * Open Android's installer on the downloaded update. {state: "installing"} when it opened; {state:
     * "permission"} when Android first needs "Install unknown apps" allowed for this app: its settings page
     * opens, and coming back with it allowed opens the installer (the "updateInstall" event says which).
     */
    @PluginMethod
    public void installUpdate(PluginCall call) {
        if (!inAppUpdates() || !updateFile().isFile()) {
            call.reject("No downloaded update");
            return;
        }
        JSObject ret = new JSObject();
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getContext().getPackageManager().canRequestPackageInstalls()) {
                installOnResume = true;
                Intent s = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
                s.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(s);
                ret.put("state", "permission");
            } else {
                launchInstaller();
                ret.put("state", "installing");
            }
            call.resolve(ret);
        } catch (Exception e) {
            installOnResume = false;
            call.reject("Could not open the installer: " + e.getMessage(), e);
        }
    }

    /** Back from "Install unknown apps": install if it was allowed. */
    private void resumeInstall() {
        if (!installOnResume) return;
        installOnResume = false;
        JSObject o = new JSObject();
        boolean allowed = Build.VERSION.SDK_INT < Build.VERSION_CODES.O || getContext().getPackageManager().canRequestPackageInstalls();
        if (!allowed) o.put("state", "denied");
        else {
            try {
                launchInstaller();
                o.put("state", "installing");
            } catch (Exception e) {
                Log.w(MainActivity.TAG, "installer did not open", e);
                o.put("state", "failed");
            }
        }
        notifyListeners("updateInstall", o);
    }

    private void launchInstaller() {
        Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", updateFile());
        Intent i = new Intent(Intent.ACTION_VIEW);
        i.setDataAndType(uri, APK_MIME);
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
    }

    /** The APK's versionName, if it is this app at a higher versionCode; throws otherwise. */
    private String checkApk(File apk) throws IOException {
        PackageManager pm = getContext().getPackageManager();
        PackageInfo got = pm.getPackageArchiveInfo(apk.getPath(), 0);
        if (got == null) throw new IOException("the download is not a valid APK");
        if (!getContext().getPackageName().equals(got.packageName)) throw new IOException("the APK is for another app");
        try {
            PackageInfo mine = pm.getPackageInfo(getContext().getPackageName(), 0);
            if (PackageInfoCompat.getLongVersionCode(got) <= PackageInfoCompat.getLongVersionCode(mine)) {
                throw new IOException("the APK is not newer than this version");
            }
        } catch (PackageManager.NameNotFoundException e) {
            throw new IOException("this app's version is unknown");
        }
        return got.versionName != null ? got.versionName : "";
    }

    private void sendProgress(long received, long total) {
        JSObject p = new JSObject();
        p.put("received", received);
        p.put("total", total);
        notifyListeners("updateProgress", p);
    }

    private static long parseLength(String s) {
        try {
            return s != null ? Long.parseLong(s.trim()) : -1;
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    /** A finished update restarts the app: drop what an earlier download left (never during one). */
    private void clearOldUpdate() {
        File[] old = updateDir().listFiles();
        if (old != null) for (File f : old) f.delete();
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

package tw.clockin.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import android.util.Log;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.File;

/**
 * App 自己檢查更新：後台「上架 App」換了新版，打開 App 時就會提示「更新」，
 * 按一下自動下載、跳出安裝畫面（Android 規定最後一步一定要本人按「安裝」）。
 */
final class Updater {
    private static final String TAG = "ClockinUpdate";
    private static boolean askedThisRun = false;
    private static long downloadId = -1;

    private Updater() {}

    static void check(Activity act) {
        if (askedThisRun) return;
        new Thread(() -> {
            try {
                JSONObject r = Api.get(act, "/api/app-version");
                String remote = r.optString("version", "");
                if (remote.isEmpty() || !newer(remote, BuildConfig.VERSION_NAME)) return;
                act.runOnUiThread(() -> ask(act, remote));
            } catch (Exception e) { Log.w(TAG, "check failed", e); }
        }).start();
    }

    /** "v1.0.9" 是否比 "1.0.8" 新 */
    static boolean newer(String remote, String local) {
        String[] a = remote.replaceAll("[^0-9.]", "").split("\\."), b = local.replaceAll("[^0-9.]", "").split("\\.");
        for (int i = 0; i < Math.max(a.length, b.length); i++) {
            int x = i < a.length && !a[i].isEmpty() ? Integer.parseInt(a[i]) : 0;
            int y = i < b.length && !b[i].isEmpty() ? Integer.parseInt(b[i]) : 0;
            if (x != y) return x > y;
        }
        return false;
    }

    private static void ask(Activity act, String remote) {
        if (askedThisRun || act.isFinishing()) return;
        askedThisRun = true;
        new AlertDialog.Builder(act)
                .setIcon(R.mipmap.ic_launcher)
                .setTitle("有新版本 " + remote)
                .setMessage("按「更新」會自動下載，\n再按「安裝」就完成。\n打卡紀錄不會不見。")
                .setPositiveButton("更新", (d, w) -> start(act))
                .setNegativeButton("稍後", null)
                .show();
    }

    private static void start(Activity act) {
        // 第一次要允許「安裝不明應用程式」
        if (Build.VERSION.SDK_INT >= 26 && !act.getPackageManager().canRequestPackageInstalls()) {
            new AlertDialog.Builder(act)
                    .setTitle("先開一個設定")
                    .setMessage("下一頁請打開\n「允許來自這個來源的應用程式」\n然後按返回鍵回來。")
                    .setPositiveButton("好", (d, w) -> {
                        askedThisRun = false; // 回來後再問一次
                        try { act.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + act.getPackageName()))); }
                        catch (Exception ignored) { }
                    })
                    .setNegativeButton("稍後", null)
                    .show();
            return;
        }
        try {
            File dir = act.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            File old = new File(dir, "update.apk");
            if (old.exists()) old.delete();
            DownloadManager dm = (DownloadManager) act.getSystemService(Context.DOWNLOAD_SERVICE);
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(Api.BASE + "/app.apk?t=" + System.currentTimeMillis()))
                    .setTitle("洪英夥伴 更新")
                    .setMimeType("application/vnd.android.package-archive")
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
                    .setDestinationInExternalFilesDir(act, Environment.DIRECTORY_DOWNLOADS, "update.apk");
            downloadId = dm.enqueue(req);
            Toast.makeText(act, "下載中，完成後會跳出安裝畫面", Toast.LENGTH_LONG).show();
            final Context app = act.getApplicationContext();
            BroadcastReceiver done = new BroadcastReceiver() {
                @Override public void onReceive(Context c, Intent i) {
                    if (i.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -2) != downloadId) return;
                    try { app.unregisterReceiver(this); } catch (Exception ignored) { }
                    Uri apk = dm.getUriForDownloadedFile(downloadId);
                    if (apk == null) { Toast.makeText(app, "下載失敗，請稍後再試", Toast.LENGTH_LONG).show(); return; }
                    Intent install = new Intent(Intent.ACTION_VIEW).setDataAndType(apk, "application/vnd.android.package-archive")
                            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                    try { app.startActivity(install); } catch (Exception e) { Log.w(TAG, "install failed", e); }
                }
            };
            IntentFilter f = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
            if (Build.VERSION.SDK_INT >= 33) app.registerReceiver(done, f, Context.RECEIVER_EXPORTED);
            else app.registerReceiver(done, f);
        } catch (Exception e) {
            Log.w(TAG, "download failed", e);
            act.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(Api.BASE + "/android")));
        }
    }
}

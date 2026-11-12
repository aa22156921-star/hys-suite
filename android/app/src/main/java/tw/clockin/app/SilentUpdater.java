package tw.clockin.app;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInstaller;
import android.os.Build;
import android.util.Log;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 背景自動更新：不用打開 App。
 * Android 12 以上：App 自己下載新版並更新自己，多數手機不需要按任何東西。
 * 手機若仍要求確認（或 Android 11 以下）：跳一則通知「點一下完成更新」。
 * 更新完成後系統會送 MY_PACKAGE_REPLACED，BootReceiver 會重新排定自動定位，所以也不用打開。
 */
final class SilentUpdater {
    private static final String TAG = "ClockinSilentUpd";
    private static final long CHECK_EVERY = 3 * 3600_000L;
    static final String ACTION_RESULT = "tw.clockin.app.INSTALL_RESULT";

    private SilentUpdater() {}

    /** 在背景執行緒呼叫（Scheduler.refresh 裡）。 */
    static void maybeUpdate(Context ctx) {
        SharedPreferences sp = ctx.getSharedPreferences("upd", Context.MODE_PRIVATE);
        long now = System.currentTimeMillis();
        if (now - sp.getLong("last", 0) < CHECK_EVERY) return;
        sp.edit().putLong("last", now).apply();
        try {
            JSONObject r = Api.get(ctx, "/api/app-version");
            String remote = r.optString("version", "");
            if (remote.isEmpty() || !Updater.newer(remote, BuildConfig.VERSION_NAME)) return;
            if (Build.VERSION.SDK_INT < 31) { notifyTapToUpdate(ctx, null, remote); return; }
            install(ctx, remote);
        } catch (Exception e) {
            Log.w(TAG, "update check failed", e);
        }
    }

    private static void install(Context ctx, String remote) throws Exception {
        PackageInstaller pi = ctx.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams p = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        p.setAppPackageName(ctx.getPackageName());
        if (Build.VERSION.SDK_INT >= 31) p.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
        int id = pi.createSession(p);
        try (PackageInstaller.Session s = pi.openSession(id)) {
            HttpURLConnection c = (HttpURLConnection) new URL(Api.BASE + "/app.apk?t=" + System.currentTimeMillis()).openConnection();
            c.setInstanceFollowRedirects(true);
            c.setConnectTimeout(20_000);
            c.setReadTimeout(60_000);
            if (c.getResponseCode() != 200) throw new Exception("HTTP " + c.getResponseCode());
            long len = c.getContentLengthLong();
            try (InputStream in = c.getInputStream(); OutputStream out = s.openWrite("app.apk", 0, len > 0 ? len : -1)) {
                byte[] buf = new byte[64 * 1024]; int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                s.fsync(out);
            }
            Intent i = new Intent(ctx, InstallResultReceiver.class).setAction(ACTION_RESULT).putExtra("ver", remote);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            s.commit(PendingIntent.getBroadcast(ctx, id, i, flags).getIntentSender());
            Log.i(TAG, "已送出背景更新 " + remote);
        } catch (Exception e) {
            try { pi.abandonSession(id); } catch (Exception ignored) { }
            throw e;
        }
    }

    /** 需要本人確認時：跳通知，點一下就完成。 */
    static void notifyTapToUpdate(Context ctx, Intent confirm, String ver) {
        PingService.createChannels(ctx);
        Intent open = confirm != null ? confirm : new Intent(ctx, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent pi = PendingIntent.getActivity(ctx, 7, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification n = new Notification.Builder(ctx, PingService.CH_RESULT)
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentTitle("洪英打卡 有新版本 " + (ver == null ? "" : ver))
                .setContentText("點一下完成更新")
                .setContentIntent(pi)
                .setAutoCancel(true)
                .build();
        try { ((NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE)).notify(5, n); } catch (Exception ignored) { }
    }

    public static class InstallResultReceiver extends BroadcastReceiver {
        @Override
        public void onReceive(Context ctx, Intent intent) {
            int st = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
            String ver = intent.getStringExtra("ver");
            if (st == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                Intent confirm = Build.VERSION.SDK_INT >= 33
                        ? intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent.class)
                        : intent.getParcelableExtra(Intent.EXTRA_INTENT);
                notifyTapToUpdate(ctx, confirm, ver);
            } else if (st != PackageInstaller.STATUS_SUCCESS) {
                Log.w(TAG, "更新失敗 " + st + " " + intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE));
            }
        }
    }
}

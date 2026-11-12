package tw.clockin.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 依伺服器上的班表排定自動打卡時間：
 * 上班前 5 分鐘、下班後 2 分鐘各定位一次（都落在前後 15 分鐘的打卡時段內）。
 * 幹部另外依後台設定的時間定時定位。
 * 另外每 3 小時重新抓一次班表，避免班表更新後沒排到。
 */
final class Scheduler {
    private static final String TAG = "ClockinScheduler";
    static final String ACTION_PING = "tw.clockin.app.PING";
    static final String ACTION_REFRESH = "tw.clockin.app.REFRESH";
    static final String ACTION_POLL = "tw.clockin.app.POLL";
    private static final long POLL_EVERY = 10 * 60_000L; // 幹部上班時段：每 10 分鐘看一次後台有沒有要求「立即定位」
    private static final int MAX_SLOTS = 12;
    private static final long BEFORE_START = 5 * 60_000L;
    private static final long AFTER_END = 2 * 60_000L;

    private Scheduler() {}

    /** 在背景執行緒重新抓班表並排程。 */
    static void refreshAsync(Context ctx) {
        final Context app = ctx.getApplicationContext();
        new Thread(() -> refresh(app)).start();
    }

    static void refresh(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        scheduleRefresh(ctx, am);
        if (Api.deviceToken(ctx) == null) return; // 還沒綁定
        try {
            JSONObject me = Api.get(ctx, "/api/me");
            if (!me.optBoolean("bound")) { cancelAll(ctx, am); am.cancel(pollIntent(ctx)); return; }
            // 後台按了「立即定位」→ 馬上定位一次
            if (me.optBoolean("locate")) {
                try {
                    Intent svc = new Intent(ctx, PingService.class);
                    if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(svc); else ctx.startService(svc);
                } catch (Exception e) { Log.w(TAG, "立即定位啟動失敗", e); }
            }
            // 在幹部上班時段內 → 10 分鐘後再檢查一次
            if (me.optBoolean("poll")) setExact(ctx, am, System.currentTimeMillis() + POLL_EVERY, pollIntent(ctx));
            else am.cancel(pollIntent(ctx));
            SilentUpdater.maybeUpdate(ctx); // 背景自動更新（每 3 小時最多檢查一次）
            long serverNow = me.optLong("now", System.currentTimeMillis());
            long skew = serverNow - System.currentTimeMillis(); // 以伺服器時間為準
            JSONArray up = me.optJSONArray("upcoming");
            cancelAll(ctx, am);
            int slot = 0;
            if (up != null) {
                for (int i = 0; i < up.length() && slot < MAX_SLOTS; i++) {
                    JSONObject s = up.getJSONObject(i);
                    long[] times = { s.getLong("start") - BEFORE_START, s.getLong("end") + AFTER_END };
                    for (long t : times) {
                        long local = t - skew;
                        if (local > System.currentTimeMillis() + 30_000L && slot < MAX_SLOTS) {
                            setExact(ctx, am, local, pingIntent(ctx, slot));
                            Log.i(TAG, "排定自動打卡 slot " + slot + " at " + local);
                            slot++;
                        }
                    }
                }
            }
            // 幹部定時定位（例如週一到五 9:00、12:00、18:00），由後台設定
            JSONArray checks = me.optJSONArray("checks");
            if (checks != null) {
                for (int i = 0; i < checks.length() && slot < MAX_SLOTS; i++) {
                    long local = checks.getLong(i) - skew;
                    if (local > System.currentTimeMillis() + 30_000L) {
                        setExact(ctx, am, local, pingIntent(ctx, slot));
                        Log.i(TAG, "排定定時定位 slot " + slot + " at " + local);
                        slot++;
                    }
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "refresh failed", e);
        }
    }

    /** 定位失敗時，幾分鐘後再試一次。 */
    static void retryLater(Context ctx, long delayMs) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        setExact(ctx, am, System.currentTimeMillis() + delayMs, pingIntent(ctx, 90));
    }

    private static PendingIntent pollIntent(Context ctx) {
        Intent i = new Intent(ctx, AlarmReceiver.class).setAction(ACTION_POLL);
        return PendingIntent.getBroadcast(ctx, 2, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static PendingIntent pingIntent(Context ctx, int slot) {
        Intent i = new Intent(ctx, AlarmReceiver.class).setAction(ACTION_PING);
        return PendingIntent.getBroadcast(ctx, 100 + slot, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static void cancelAll(Context ctx, AlarmManager am) {
        for (int s = 0; s < MAX_SLOTS; s++) am.cancel(pingIntent(ctx, s));
    }

    private static void scheduleRefresh(Context ctx, AlarmManager am) {
        Intent i = new Intent(ctx, AlarmReceiver.class).setAction(ACTION_REFRESH);
        PendingIntent pi = PendingIntent.getBroadcast(ctx, 1, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        am.setInexactRepeating(AlarmManager.RTC_WAKEUP, System.currentTimeMillis() + AlarmManager.INTERVAL_HOUR * 3,
                AlarmManager.INTERVAL_HOUR * 3, pi);
    }

    static boolean canExact(Context ctx) {
        if (Build.VERSION.SDK_INT < 31) return true;
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        return am.canScheduleExactAlarms();
    }

    private static void setExact(Context ctx, AlarmManager am, long at, PendingIntent pi) {
        try {
            if (canExact(ctx)) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
            else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
        } catch (SecurityException e) {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
        }
    }
}

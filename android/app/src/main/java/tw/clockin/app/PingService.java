package tw.clockin.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import org.json.JSONObject;

/**
 * 背景自動打卡：短暫以前景服務取得一次 GPS，送到伺服器後結束。
 * 會在通知列短暫顯示「正在自動打卡」，結束後留下一則結果通知。
 */
public class PingService extends Service {
    private static final String TAG = "ClockinPing";
    static final String CH_WORK = "clockin_work";
    static final String CH_RESULT = "clockin_result";
    private static final long MAX_WAIT_MS = 45_000L;
    private static final float GOOD_ACCURACY_M = 60f;

    private LocationManager lm;
    private Location best;
    private boolean finished = false;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private PowerManager.WakeLock wakeLock;

    private final LocationListener listener = new LocationListener() {
        @Override public void onLocationChanged(Location loc) {
            if (best == null || loc.getAccuracy() < best.getAccuracy()) best = loc;
            if (loc.getAccuracy() <= GOOD_ACCURACY_M) finish();
        }
        @Override public void onStatusChanged(String p, int s, Bundle e) { }
        @Override public void onProviderEnabled(String p) { }
        @Override public void onProviderDisabled(String p) { }
    };

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        createChannels(this);
        Notification n = new Notification.Builder(this, CH_WORK)
                .setSmallIcon(android.R.drawable.ic_menu_mylocation)
                .setContentTitle("洪英打卡")
                .setContentText("打卡中")
                .setOngoing(true)
                .build();
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            else startForeground(1, n);
        } catch (Exception e) {
            Log.w(TAG, "startForeground failed", e);
            Scheduler.retryLater(this, 3 * 60_000L);
            stopSelf();
            return START_NOT_STICKY;
        }

        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "clockin:ping");
        wakeLock.acquire(MAX_WAIT_MS + 30_000L);

        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            send(null, "denied");
            return START_NOT_STICKY;
        }
        lm = (LocationManager) getSystemService(LOCATION_SERVICE);
        try {
            // 兩分鐘內的舊定位先當候選
            for (String p : new String[]{LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER}) {
                Location last = lm.getLastKnownLocation(p);
                if (last != null && System.currentTimeMillis() - last.getTime() < 120_000L
                        && (best == null || last.getAccuracy() < best.getAccuracy())) best = last;
            }
            if (lm.isProviderEnabled(LocationManager.GPS_PROVIDER))
                lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000, 0, listener, Looper.getMainLooper());
            if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER))
                lm.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 1000, 0, listener, Looper.getMainLooper());
        } catch (SecurityException e) {
            send(null, "denied");
            return START_NOT_STICKY;
        }
        handler.postDelayed(this::finish, MAX_WAIT_MS);
        return START_NOT_STICKY;
    }

    private void finish() {
        if (finished) return;
        finished = true;
        handler.removeCallbacksAndMessages(null);
        try { if (lm != null) lm.removeUpdates(listener); } catch (Exception ignored) { }
        send(best, best == null ? "timeout" : null);
    }

    private void send(final Location loc, final String err) {
        finished = true;
        new Thread(() -> {
            String title = "自動打卡", text;
            boolean retry = false;
            try {
                JSONObject body = new JSONObject();
                if (loc != null) {
                    body.put("lat", loc.getLatitude());
                    body.put("lng", loc.getLongitude());
                    body.put("acc", (double) loc.getAccuracy());
                } else {
                    body.put("err", err);
                }
                JSONObject r = Api.post(PingService.this, "/api/ping", body);
                int status = r.optInt("_status");
                if (status == 401) {
                    text = "請打開 App 輸入姓名";
                } else if (!r.optBoolean("ok")) {
                    text = "打卡失敗";
                    retry = true;
                } else {
                    JSONObject hit = r.optJSONObject("hit");
                    JSONObject at = r.optJSONObject("at");
                    String place = loc == null ? "沒有定位" : at != null ? at.optString("name") : "無對應上班地點";
                    if (hit != null) {
                        String kind = "in".equals(hit.optString("kind")) ? "上班" : "下班";
                        boolean inRange = !r.isNull("inRange") && r.optBoolean("inRange");
                        title = kind + (loc == null ? "：沒有定位" : inRange ? "打卡 ✓" : "：不在工地範圍");
                    } else {
                        title = "已記錄";
                    }
                    text = place;
                    if (loc == null) retry = true;
                }
            } catch (Exception e) {
                Log.w(TAG, "ping failed", e);
                text = "網路錯誤，稍後重試";
                retry = true;
            }
            notifyResult(title, text);
            if (retry) Scheduler.retryLater(PingService.this, 3 * 60_000L);
            Scheduler.refresh(getApplicationContext());
            handler.post(() -> {
                try { if (wakeLock != null && wakeLock.isHeld()) wakeLock.release(); } catch (Exception ignored) { }
                stopForeground(true);
                stopSelf();
            });
        }).start();
    }

    private void notifyResult(String title, String text) {
        try {
            Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE);
            Notification n = new Notification.Builder(this, CH_RESULT)
                    .setSmallIcon(android.R.drawable.ic_menu_mylocation)
                    .setContentTitle(title)
                    .setContentText(text)
                    .setStyle(new Notification.BigTextStyle().bigText(text))
                    .setContentIntent(pi)
                    .setAutoCancel(true)
                    .build();
            ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(2, n);
        } catch (Exception ignored) { }
    }

    static void createChannels(android.content.Context ctx) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(NOTIFICATION_SERVICE);
        nm.createNotificationChannel(new NotificationChannel(CH_WORK, "自動打卡進行中", NotificationManager.IMPORTANCE_LOW));
        nm.createNotificationChannel(new NotificationChannel(CH_RESULT, "打卡結果", NotificationManager.IMPORTANCE_DEFAULT));
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        try { if (lm != null) lm.removeUpdates(listener); } catch (Exception ignored) { }
        try { if (wakeLock != null && wakeLock.isHeld()) wakeLock.release(); } catch (Exception ignored) { }
        super.onDestroy();
    }
}

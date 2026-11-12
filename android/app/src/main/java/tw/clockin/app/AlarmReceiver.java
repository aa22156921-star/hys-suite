package tw.clockin.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

/** 時間到：啟動定位服務自動打卡；或重新整理班表排程。 */
public class AlarmReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        String action = intent.getAction();
        if (Scheduler.ACTION_PING.equals(action)) {
            Intent svc = new Intent(ctx, PingService.class);
            try {
                if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(svc);
                else ctx.startService(svc);
            } catch (Exception e) {
                Log.w("ClockinAlarm", "無法啟動定位服務", e);
                Scheduler.retryLater(ctx, 3 * 60_000L);
            }
        } else if (Scheduler.ACTION_REFRESH.equals(action) || Scheduler.ACTION_POLL.equals(action)) {
            final PendingResult pr = goAsync();
            new Thread(() -> { try { Scheduler.refresh(ctx.getApplicationContext()); } finally { pr.finish(); } }).start();
        }
    }
}

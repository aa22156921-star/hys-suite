package tw.clockin.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** 手機重開機或 App 更新後，重新排定自動打卡。 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        final PendingResult pr = goAsync();
        new Thread(() -> { try { Scheduler.refresh(ctx.getApplicationContext()); } finally { pr.finish(); } }).start();
    }
}

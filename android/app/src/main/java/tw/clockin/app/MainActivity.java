package tw.clockin.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * 主畫面：直接顯示原本的員工打卡網頁（同意書、輸入姓名、打開即打卡都沿用），
 * 另外引導員工開啟「一律允許定位」等權限，讓 App 在上下班時間自動打卡。
 */
public class MainActivity extends Activity {
    private long pausedAt = 0;
    private static final int REQ_BASIC = 1, REQ_BG = 2;
    private WebView web;
    private GeolocationPermissions.Callback pendingGeo;
    private String pendingOrigin;
    private final Set<String> skipped = new HashSet<>();
    private AlertDialog dialog;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        PingService.createChannels(this);

        web = new WebView(this);
        setContentView(web);
        CookieManager.getInstance().setAcceptCookie(true);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setGeolocationEnabled(true);
        s.setUserAgentString(s.getUserAgentString() + " ClockinApp/" + BuildConfig.VERSION_NAME);

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                if (hasFine()) callback.invoke(origin, true, false);
                else { pendingGeo = callback; pendingOrigin = origin; requestBasic(); }
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (Uri.parse(Api.BASE).getHost().equals(u.getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }
            @Override
            public void onPageFinished(WebView view, String url) {
                CookieManager.getInstance().flush();
                Scheduler.refreshAsync(MainActivity.this); // 綁定後或班表更新後重新排程
            }
            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) {
                    view.loadDataWithBaseURL(null,
                        "<html><meta name='viewport' content='width=device-width'><body style='font-family:sans-serif;text-align:center;padding:60px 20px;color:#1c2421'>"
                        + "<h2>網路錯誤</h2>"
                        + "<button style='font-size:18px;padding:14px 28px;border:0;border-radius:12px;background:#0f766e;color:#fff' onclick=\"location.href='" + Api.BASE + "/'\">重新整理</button></body></html>",
                        "text/html", "utf-8", null);
                }
            }
        });

        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else { Api.carryBinding(this); web.loadUrl(Api.BASE + "/"); }
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        // 在背景超過 5 分鐘再回來：重新載入頁面，伺服器端的新版畫面馬上看得到
        if (pausedAt > 0 && System.currentTimeMillis() - pausedAt > 5 * 60_000L) web.reload();
        pausedAt = 0;
        nextSetupStep();
        if (hasFine() && hasBg()) Updater.check(this); // 權限都給了再檢查更新，避免同時跳太多視窗
    }

    @Override
    protected void onPause() {
        CookieManager.getInstance().flush();
        pausedAt = System.currentTimeMillis();
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack(); else super.onBackPressed();
    }

    // ---------------- 權限引導（一步一步來）----------------
    private boolean has(String p) { return checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED; }
    private boolean hasFine() { return has(Manifest.permission.ACCESS_FINE_LOCATION); }
    private boolean hasBg() { return Build.VERSION.SDK_INT < 29 || has(Manifest.permission.ACCESS_BACKGROUND_LOCATION); }
    private boolean hasNotif() { return Build.VERSION.SDK_INT < 33 || has(Manifest.permission.POST_NOTIFICATIONS); }
    private boolean ignoringBattery() {
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        return pm.isIgnoringBatteryOptimizations(getPackageName());
    }

    // 盡量少跳窗：系統本身的權限視窗直接跳出，只有「一律允許」需要先說明一次
    private void nextSetupStep() {
        if (dialog != null && dialog.isShowing()) return;
        if (!hasFine() || !hasNotif()) {
            if (skipped.add("basic")) requestBasic();
            return;
        }
        if (!hasBg()) {
            if (!skipped.contains("bg")) ask("bg", "最後一步", "下一頁請選\n「一律允許」\n\n上下班時才會自動定位", "好",
                    () -> requestPermissions(new String[]{Manifest.permission.ACCESS_BACKGROUND_LOCATION}, REQ_BG));
            return;
        }
        if (!Scheduler.canExact(this)) {
            if (skipped.add("exact")) {
                try { startActivity(new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:" + getPackageName()))); }
                catch (Exception ignored) { }
            }
            return;
        }
        if (!ignoringBattery() && skipped.add("battery")) {
            try {
                @SuppressLint("BatteryLife")
                Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName()));
                startActivity(i);
            } catch (Exception ignored) { }
        }
    }

    private void ask(String key, String title, String msg, String ok, Runnable action) {
        dialog = new AlertDialog.Builder(this)
                .setTitle(title)
                .setMessage(msg)
                .setCancelable(false)
                .setPositiveButton(ok, (d, w) -> { skipped.add(key); action.run(); })
                .setNegativeButton("稍後", (d, w) -> { skipped.add(key); nextSetupStep(); })
                .setIcon(R.mipmap.ic_launcher)
                .show();
    }

    private void requestBasic() {
        List<String> ps = new ArrayList<>();
        ps.add(Manifest.permission.ACCESS_FINE_LOCATION);
        ps.add(Manifest.permission.ACCESS_COARSE_LOCATION);
        if (Build.VERSION.SDK_INT >= 33) ps.add(Manifest.permission.POST_NOTIFICATIONS);
        requestPermissions(ps.toArray(new String[0]), REQ_BASIC);
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        if (pendingGeo != null) { pendingGeo.invoke(pendingOrigin, hasFine(), false); pendingGeo = null; }
        if (code == REQ_BASIC && hasFine()) web.reload(); // 取得定位後重新整理，讓網頁立刻打卡
        Scheduler.refreshAsync(this);
        nextSetupStep();
    }
}

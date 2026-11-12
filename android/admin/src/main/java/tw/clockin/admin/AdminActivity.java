package tw.clockin.admin;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * 洪英打卡「後台」App：直接打開 /admin 管理頁面。
 * 另外補上 WebView 本身做不到的：選檔案（匯入班表、上架 APK）、下載檔案（Excel、CSV、QR 圖片）。
 */
public class AdminActivity extends Activity {
    private static final int REQ_FILE = 10;
    private static final String BASE = BuildConfig.BASE_URL;
    private WebView web;
    private ValueCallback<Uri[]> fileCb;

    // 攔截網頁的「下載」：把 blob:/data: 連結轉成 base64 交給 App 存檔
    private static final String HOOK =
        "(function(){if(window.__hysHook)return;window.__hysHook=1;" +
        "function send(href,name){if(/^data:/.test(href)){var m=href.match(/^data:([^;,]*)(;base64)?,(.*)$/);" +
        "var b=m[2]?m[3]:btoa(unescape(encodeURIComponent(decodeURIComponent(m[3]))));HysApp.save(b,m[1]||'application/octet-stream',name);return;}" +
        "fetch(href).then(function(r){return r.blob();}).then(function(bl){var fr=new FileReader();fr.onload=function(){var s=String(fr.result);" +
        "HysApp.save(s.slice(s.indexOf(',')+1),bl.type||'application/octet-stream',name);};fr.readAsDataURL(bl);});}" +
        "var oc=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){" +
        "if(this.hasAttribute('download')&&/^(blob|data):/.test(this.href)){send(this.href,this.getAttribute('download')||'download');return;}return oc.apply(this,arguments);};" +
        "document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[download]');" +
        "if(a&&/^(blob|data):/.test(a.href)){e.preventDefault();send(a.href,a.getAttribute('download')||'download');}},true);" +
        "window.print=function(){alert('App 不能直接列印，請按「下載圖片」再列印');};})();";

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        setContentView(web);
        CookieManager.getInstance().setAcceptCookie(true);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setUserAgentString(s.getUserAgentString() + " HysAdminApp/" + BuildConfig.VERSION_NAME);
        web.addJavascriptInterface(new Bridge(), "HysApp");

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCb != null) fileCb.onReceiveValue(null);
                fileCb = cb;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
                try { startActivityForResult(Intent.createChooser(i, "選擇檔案"), REQ_FILE); }
                catch (Exception e) { fileCb = null; return false; }
                return true;
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (Uri.parse(BASE).getHost().equals(u.getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true; // Google 地圖等外部連結交給手機的 App 打開
            }
            @Override
            public void onPageFinished(WebView view, String url) {
                CookieManager.getInstance().flush();
                view.evaluateJavascript(HOOK, null);
            }
            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) {
                    view.loadDataWithBaseURL(null,
                        "<html><meta name='viewport' content='width=device-width'><body style='font-family:sans-serif;text-align:center;padding:60px 20px'>"
                        + "<h2>網路錯誤</h2><button style='font-size:18px;padding:14px 28px;border:0;border-radius:12px;background:#0f766e;color:#fff' "
                        + "onclick=\"location.href='" + BASE + "/admin'\">重新整理</button></body></html>", "text/html", "utf-8", null);
                }
            }
        });

        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(BASE + "/admin");
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == REQ_FILE && fileCb != null) {
            Uri u = (res == RESULT_OK && data != null) ? data.getData() : null;
            fileCb.onReceiveValue(u != null ? new Uri[]{u} : null);
            fileCb = null;
        }
    }

    @Override protected void onPause() { CookieManager.getInstance().flush(); web.onPause(); super.onPause(); }
    @Override protected void onResume() { super.onResume(); web.onResume(); }
    @Override protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); web.saveState(out); }
    @Override public void onBackPressed() { if (web.canGoBack()) web.goBack(); else super.onBackPressed(); }

    final class Bridge {
        @JavascriptInterface
        public void save(String b64, String mime, String name) {
            String safe = name.replaceAll("[\\\\/:*?\"<>|]", "_");
            try {
                byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
                String where;
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.Downloads.DISPLAY_NAME, safe);
                    v.put(MediaStore.Downloads.MIME_TYPE, mime);
                    v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                    Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                    try (OutputStream o = getContentResolver().openOutputStream(uri)) { o.write(bytes); }
                    where = "已存到「下載」：" + safe;
                } else {
                    File f = new File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), safe);
                    try (FileOutputStream o = new FileOutputStream(f)) { o.write(bytes); }
                    where = "已存檔：" + f.getAbsolutePath();
                }
                final String msg = where;
                runOnUiThread(() -> Toast.makeText(AdminActivity.this, msg, Toast.LENGTH_LONG).show());
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(AdminActivity.this, "存檔失敗：" + e.getMessage(), Toast.LENGTH_LONG).show());
            }
        }
    }
}

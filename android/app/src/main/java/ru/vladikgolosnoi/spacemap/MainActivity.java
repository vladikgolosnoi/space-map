package ru.vladikgolosnoi.spacemap;

import android.app.*;
import android.content.*;
import android.graphics.Color;
import android.net.Uri;
import android.os.*;
import android.provider.*;
import android.util.Base64;
import android.view.*;
import android.webkit.*;
import android.widget.*;
import org.json.JSONObject;
import java.io.*;

/** Same-origin web client with system file/camera pickers and streamed document exports. */
public class MainActivity extends Activity {
    private WebView web;
    private TextView error;
    private ProgressBar progress;
    private ValueCallback<Uri[]> picker;
    private Uri cameraUri;
    private volatile String exportUrl;
    private Uri exportUri;
    private OutputStream output;
    private long exportedBytes;
    private static final int PICK = 10, CAMERA = 11, SAVE = 12;
    private final Bridge bridge = new Bridge();
    private String origin() { return BuildConfig.ORIGIN; }
    private boolean own(Uri uri) {
        Uri expected = Uri.parse(origin());
        return uri != null && expected.getScheme().equals(uri.getScheme()) && expected.getAuthority().equals(uri.getAuthority());
    }
    private void toast(String message) { runOnUiThread(() -> Toast.makeText(this, message, Toast.LENGTH_LONG).show()); }
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(Color.WHITE);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            } else view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets;
        });
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        root.addView(progress, new LinearLayout.LayoutParams(-1, 5));
        error = new TextView(this); error.setTextSize(16); error.setPadding(20,20,20,20); error.setVisibility(View.GONE);
        error.setOnClickListener(v -> load()); root.addView(error);
        web = new WebView(this);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setUserAgentString(settings.getUserAgentString() + " SpaceMapNative/Android");
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        web.addJavascriptInterface(bridge, "SpaceMapNative");
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (own(uri) || uri.toString().startsWith("blob:" + origin() + "/")) return false;
                if (request.isForMainFrame() && "https".equals(uri.getScheme())) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); } catch (ActivityNotFoundException ignored) {}
                }
                return true;
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (("https".equals(uri.getScheme()) || "http".equals(uri.getScheme())) && !own(uri))
                    return new WebResourceResponse("text/plain", "UTF-8", 403, "External resource blocked", null, new ByteArrayInputStream(new byte[0]));
                return null;
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError failure) {
                if (request.isForMainFrame()) showError("Не удалось открыть карту. Проверьте интернет и нажмите здесь, чтобы повторить.");
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (request.isForMainFrame()) showError("Сервер временно недоступен. Нажмите здесь, чтобы повторить.");
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView view, int value) { progress.setProgress(value); progress.setVisibility(value == 100 ? View.GONE : View.VISIBLE); }
            @Override public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
                new AlertDialog.Builder(MainActivity.this).setMessage(message).setPositiveButton("Понятно", (d,w) -> result.confirm()).setOnCancelListener(d -> result.cancel()).show(); return true;
            }
            @Override public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
                new AlertDialog.Builder(MainActivity.this).setMessage(message).setPositiveButton("Продолжить", (d,w) -> result.confirm()).setNegativeButton("Отмена", (d,w) -> result.cancel()).setOnCancelListener(d -> result.cancel()).show(); return true;
            }
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (picker != null) picker.onReceiveValue(null);
                picker = callback;
                if (params.isCaptureEnabled()) {
                    // Every captured frame must remain distinct while the web form assembles a series.
                    cameraUri = Uri.parse("content://" + getPackageName() + ".camera/capture-" + java.util.UUID.randomUUID() + ".jpg");
                    Intent capture = new Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, cameraUri)
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                    capture.setClipData(ClipData.newRawUri("Фото", cameraUri));
                    try { startActivityForResult(capture, CAMERA); return true; } catch (ActivityNotFoundException ignored) { cameraUri = null; }
                }
                Intent choose = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
                choose.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                String types = String.join(",", params.getAcceptTypes());
                if (!types.contains("json") && (types.contains("image") || types.contains(".jpg") || types.contains(".png"))) choose.setType("image/*");
                try { startActivityForResult(choose, PICK); } catch (ActivityNotFoundException unavailable) { picker.onReceiveValue(null); picker = null; toast("Не найден выбор файлов. Установите системное приложение «Файлы»."); }
                return true;
            }
        });
        root.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));
        LinearLayout actions = new LinearLayout(this);
        addAction(actions, "Назад", () -> onBackPressed());
        addAction(actions, "Обновить", () -> new AlertDialog.Builder(this).setMessage("Обновить? Несохранённые изменения будут потеряны.").setNegativeButton("Отмена", null).setPositiveButton("Обновить", (d,w) -> load()).show());
        addAction(actions, "В браузере", () -> startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(origin() + "/map/demo"))));
        root.addView(actions); setContentView(root); load();
    }
    private void addAction(LinearLayout row, String label, Runnable action) {
        Button button = new Button(this); button.setText(label); button.setTextSize(12); button.setAllCaps(false); button.setMinHeight((int)(48*getResources().getDisplayMetrics().density)); button.setOnClickListener(v -> action.run()); row.addView(button, new LinearLayout.LayoutParams(0,-2,1));
    }
    private void showError(String text) { error.setText(text); error.setVisibility(View.VISIBLE); web.setVisibility(View.GONE); progress.setVisibility(View.GONE); }
    private void load() { error.setVisibility(View.GONE); web.setVisibility(View.VISIBLE); web.loadUrl(origin() + "/map/demo"); }
    @Override public void onBackPressed() {
        web.evaluateJavascript("(()=>{const dialog=document.querySelector('[role=dialog]');if(!dialog)return false;(dialog.contains(document.activeElement)?document.activeElement:dialog).dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return true})()", result -> {
            if ("true".equals(result)) return;
            if (web.canGoBack()) web.goBack(); else super.onBackPressed();
        });
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request,result,data);
        if (request == SAVE) {
            if (result != RESULT_OK || data == null) { releaseExport(); return; }
            try { exportUri = data.getData(); output = getContentResolver().openOutputStream(exportUri); exportedBytes = 0; }
            catch (Exception e) { toast("Не удалось открыть файл для записи."); releaseExport(); return; }
            String url = JSONObject.quote(exportUrl);
            // Read bounded chunks rather than copying a 96 MB offline map through one base64 string.
            web.evaluateJavascript("(async()=>{const u="+url+";try{const r=await fetch(u);const reader=r.body.getReader();while(true){const part=await reader.read();if(part.done)break;for(let i=0;i<part.value.length;i+=32768){const a=part.value.subarray(i,i+32768);let s='';for(const n of a)s+=String.fromCharCode(n);if(!SpaceMapNative.append(btoa(s)))throw Error('write');}}SpaceMapNative.finish(true);}catch(e){SpaceMapNative.finish(false);}finally{URL.revokeObjectURL(u);}})()",null);
            return;
        }
        if (picker == null) return;
        Uri[] values = null;
        if (result == RESULT_OK) {
            if (request == CAMERA) values = new Uri[]{cameraUri};
            else if (data != null && data.getClipData() != null) {
                ClipData clip = data.getClipData(); values = new Uri[clip.getItemCount()];
                for(int i=0;i<values.length;i++) values[i]=clip.getItemAt(i).getUri();
            } else if (data != null && data.getData() != null) values = new Uri[]{data.getData()};
        }
        picker.onReceiveValue(values); picker = null; cameraUri = null;
    }
    private void releaseExport() {
        if (exportUrl != null) web.evaluateJavascript("URL.revokeObjectURL("+JSONObject.quote(exportUrl)+")",null);
        exportUrl = null;
    }
    public class Bridge {
        @JavascriptInterface public void saveBlob(String url, String filename, String mime) {
            if (!url.startsWith("blob:"+origin()+"/") || url.length()>2048) return;
            runOnUiThread(() -> {
                if (exportUrl != null) { web.evaluateJavascript("URL.revokeObjectURL("+JSONObject.quote(url)+")",null); toast("Сначала завершите текущее сохранение."); return; }
                exportUrl=url;
                String name = filename.replaceAll("[^a-zA-Z0-9._-]", "_"); if(name.length()>100)name=name.substring(0,100);
                Intent save=new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("text/html".equals(mime)?"text/html":"application/json").putExtra(Intent.EXTRA_TITLE,name);
                try { startActivityForResult(save,SAVE); } catch(ActivityNotFoundException unavailable) { releaseExport(); toast("Для сохранения нужно приложение «Файлы»."); }
            });
        }
        @JavascriptInterface public synchronized boolean append(String base64) {
            if(output==null || base64.length()>48000)return false;
            try { byte[] bytes=Base64.decode(base64,Base64.NO_WRAP); exportedBytes+=bytes.length; if(exportedBytes>96L*1024*1024)return false; output.write(bytes); return true; } catch(Exception e){return false;}
        }
        @JavascriptInterface public synchronized void finish(boolean success) {
            try { if(output!=null)output.close(); } catch(IOException e){success=false;} output=null;
            if(!success && exportUri!=null) try { DocumentsContract.deleteDocument(getContentResolver(),exportUri); } catch(Exception ignored){}
            exportUri=null; exportUrl=null; toast(success?"Файл сохранён в выбранную папку.":"Не удалось сохранить файл. Повторите экспорт.");
        }
    }
    @Override protected void onDestroy() {
        if(picker!=null)picker.onReceiveValue(null);
        try { if(output!=null)output.close(); } catch(IOException ignored){}
        web.destroy(); super.onDestroy();
    }
}

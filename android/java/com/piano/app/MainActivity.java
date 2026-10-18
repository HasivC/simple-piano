package com.piano.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * PIANO Android 外壳：一个全屏 WebView 承载 assets 里的琴键应用。
 * 没有联网权限，界面与音频全部在本地完成。
 *
 * 注意：这里刻意不写任何内部类/匿名类。build-tools 34 自带的 R8/d8 在 dex 化
 * 内部类时会抛 NullPointerException，只用 MainActivity 一个类即可正常打包。
 * 返回键因此走 JS 桥：onBackPressed -> 页面里的 __skyBack() -> 需要退出时回调 exitApp()。
 */
public class MainActivity extends Activity {

    private static final String START_URL = "file:///android_asset/index.html";
    private static final String BACK_JS =
            "(function(){try{if(window.__skyBack){window.__skyBack();return;}}catch(e){}" +
            "try{PianoShell.exitApp();}catch(e){}})()";

    private WebView web;

    @SuppressLint("SetJavaScriptEnabled")
    @SuppressWarnings("deprecation")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        goFullscreen();

        web = new WebView(this);
        web.setBackgroundColor(0xFF050A18);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setVerticalScrollBarEnabled(false);
        web.setHorizontalScrollBarEnabled(false);
        web.setWebViewClient(new WebViewClient());

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        /* Web Audio 需要它：否则必须等用户手势才能出声（多点触控弹奏会吞掉第一个音） */
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(false);
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);
        s.setUseWideViewPort(false);
        s.setLoadWithOverviewMode(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        WebView.setWebContentsDebuggingEnabled(true);

        /* 只暴露 exitApp 一个方法给页面，页面是本地资源，不联网 */
        web.addJavascriptInterface(this, "PianoShell");

        setContentView(web);
        web.loadUrl(START_URL);
    }

    /** 由页面在「返回键无面板可关、无回放可停」时回调；finish() 可从任意线程调用 */
    @JavascriptInterface
    public void exitApp() {
        finish();
    }

    private void goFullscreen() {
        View decor = getWindow().getDecorView();
        decor.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) goFullscreen();
    }

    /** 返回键：交给页面处理，页面处理不了会调用 PianoShell.exitApp() */
    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        if (web == null) {
            super.onBackPressed();
            return;
        }
        web.evaluateJavascript(BACK_JS, null);
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (web != null) {
            web.onPause();
            web.pauseTimers();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) {
            web.resumeTimers();
            web.onResume();
        }
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}

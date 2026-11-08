package com.adrian.psportal;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;

public class MainActivity extends Activity {
    private static final String PREFS = "ps_portal";
    private static final String KEY_URL = "server_url";
    private static final String DEFAULT_URL = "http://192.168.1.100:4545";

    private WebView webView;
    private WebChromeClient chromeClient;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private FrameLayout fullscreenContainer;
    private String serverBase = DEFAULT_URL;
    private boolean tvMode = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        tvMode = getPackageManager().hasSystemFeature(PackageManager.FEATURE_LEANBACK)
            || getPackageManager().hasSystemFeature(PackageManager.FEATURE_TELEVISION);

        webView = findViewById(R.id.webview);
        configureWebView();
        webView.addJavascriptInterface(new Object() {
            @JavascriptInterface
            public void openSettings() {
                runOnUiThread(() -> showServerDialog());
            }
        }, "AndroidApp");
        findViewById(R.id.serverButton).setOnClickListener(view -> showServerDialog());

        serverBase = getPreferences().getString(KEY_URL, DEFAULT_URL);
        loadPortal();
    }

    private SharedPreferences getPreferences() {
        return getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        webView.setBackgroundColor(Color.parseColor("#0f1117"));
        WebView.setWebContentsDebuggingEnabled(true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme() == null ? "" : uri.getScheme();
                if (scheme.equals("http") || scheme.equals("https")) {
                    if (isServerUrl(uri)) {
                        return false;
                    }
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, uri));
                    } catch (Exception ignored) {
                    }
                    return true;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    String html = "<html><body style='background:#0f1117;color:#e7eaf3;font-family:sans-serif;padding:24px'>"
                        + "<h2>Får ikke kontakt med serveren</h2>"
                        + "<p>Start portalen på PC-en med <code>npm run serve</code>.</p>"
                        + "<p>Sjekk at telefonen er på samme nett og at serveradressen er riktig:</p>"
                        + "<p><b>" + serverBase + "</b></p>"
                        + "<p>Trykk på <b>Server</b> øverst for å endre adresse.</p>"
                        + "</body></html>";
                    view.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
                }
            }
        });

        chromeClient = new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                customView = view;
                customViewCallback = callback;
                fullscreenContainer = new FrameLayout(MainActivity.this);
                fullscreenContainer.setBackgroundColor(Color.BLACK);
                fullscreenContainer.addView(view, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                ((ViewGroup) findViewById(android.R.id.content)).addView(fullscreenContainer,
                    new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                webView.setVisibility(View.GONE);
                findViewById(R.id.serverButton).setVisibility(View.GONE);
                getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
            }

            @Override
            public void onHideCustomView() {
                if (customView == null) {
                    return;
                }
                if (fullscreenContainer != null) {
                    ((ViewGroup) findViewById(android.R.id.content)).removeView(fullscreenContainer);
                    fullscreenContainer = null;
                }
                customView = null;
                webView.setVisibility(View.VISIBLE);
                findViewById(R.id.serverButton).setVisibility(View.VISIBLE);
                getWindow().clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
                if (customViewCallback != null) {
                    customViewCallback.onCustomViewHidden();
                    customViewCallback = null;
                }
            }
        };
        webView.setWebChromeClient(chromeClient);
    }

    private boolean isServerUrl(Uri uri) {
        try {
            Uri base = Uri.parse(serverBase);
            return uri.getHost() != null
                && uri.getHost().equals(base.getHost())
                && uri.getPort() == base.getPort();
        } catch (Exception error) {
            return false;
        }
    }

    private void loadPortal() {
        String url = serverBase;
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            url = "http://" + url;
        }
        if (url.endsWith("/")) {
            url = url.substring(0, url.length() - 1);
        }
        serverBase = url;
        String pageUrl = url + "/";
        if (tvMode) {
            pageUrl = Uri.parse(pageUrl).buildUpon().appendQueryParameter("tv", "1").build().toString();
        }
        webView.loadUrl(pageUrl);
    }

    private void showServerDialog() {
        final EditText input = new EditText(this);
        input.setText(serverBase);
        input.setSingleLine(true);
        input.setTextColor(Color.parseColor("#e7eaf3"));
        input.setHint("http://192.168.1.100:4545");
        int padding = (int) (20 * getResources().getDisplayMetrics().density);
        input.setPadding(padding, padding / 2, padding, padding / 2);

        new AlertDialog.Builder(this)
            .setTitle("Serveradresse")
            .setMessage("Skriv inn adressen til PC-en som kjører portalen.")
            .setView(input)
            .setPositiveButton("Lagre", (dialog, which) -> {
                String value = input.getText().toString().trim();
                if (!value.isEmpty()) {
                    getPreferences().edit().putString(KEY_URL, value).apply();
                    serverBase = value;
                    loadPortal();
                }
            })
            .setNegativeButton("Avbryt", null)
            .show();
    }

    @Override
    public void onBackPressed() {
        if (customView != null) {
            chromeClient.onHideCustomView();
            return;
        }
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onPause() {
        if (webView != null) {
            webView.onPause();
        }
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.onResume();
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.loadUrl("about:blank");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}

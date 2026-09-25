package com.qinghaipao.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * Thin shell: bring up the node backend, wait for it to answer on
 * 127.0.0.1:3000, then hand the WebView over to it. node serves the built web
 * app itself, so there is nothing to load from assets here.
 */
public class MainActivity extends Activity {

    private static final String BASE = "http://127.0.0.1:" + NodeService.PORT;
    /** Long enough for a first-run unpack of ~120 MB, short enough to fail fast. */
    private static final long READY_TIMEOUT_MS = 75_000L;
    private static final long POLL_INTERVAL_MS = 500L;

    private WebView webView;
    private ScrollView statusScroll;
    private LinearLayout statusBox;
    private TextView statusTitle;
    private TextView statusDetail;
    private Button copyLogButton;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private volatile boolean loaded;
    private long pollStartedAt;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFF0C0A09);
        // WebView first, status view second: in a FrameLayout the last child wins
        // the z-order, and while node is starting the status view is what the
        // user must see.
        root.addView(buildWebView(), match());
        root.addView(buildStatusView(), match());
        setContentView(root);
        showStatus();

        Intent svc = new Intent(this, NodeService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(svc);
        } else {
            startService(svc);
        }

        pollStartedAt = System.currentTimeMillis();
        setStatus("正在启动服务", "首次启动需要解压运行时，请稍候…");
        pollUntilReady();
    }

    // ------------------------------------------------------------------- UI

    private FrameLayout.LayoutParams match() {
        return new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
    }

    private View buildStatusView() {
        ScrollView scroll = new ScrollView(this);
        statusScroll = scroll;
        statusBox = new LinearLayout(this);
        statusBox.setOrientation(LinearLayout.VERTICAL);
        statusBox.setGravity(Gravity.CENTER);
        statusBox.setPadding(dp(24), dp(24), dp(24), dp(24));

        statusTitle = new TextView(this);
        statusTitle.setTextColor(0xFF67E8F9);
        statusTitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        statusTitle.setGravity(Gravity.CENTER);
        statusBox.addView(statusTitle);

        statusDetail = new TextView(this);
        statusDetail.setTextColor(0xFF78716C);
        statusDetail.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        statusDetail.setGravity(Gravity.CENTER);
        statusDetail.setPadding(0, dp(12), 0, 0);
        statusDetail.setTextIsSelectable(true);
        statusBox.addView(statusDetail);

        copyLogButton = new Button(this);
        copyLogButton.setText("复制日志");
        copyLogButton.setVisibility(View.GONE);
        copyLogButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm != null) {
                    cm.setPrimaryClip(ClipData.newPlainText("氢氦跑日志", statusDetail.getText()));
                    Toast.makeText(MainActivity.this, "日志已复制", Toast.LENGTH_SHORT).show();
                }
            }
        });
        statusBox.addView(copyLogButton);

        scroll.addView(statusBox, match());
        return scroll;
    }

    private View buildWebView() {
        webView = new WebView(this);
        webView.setBackgroundColor(0xFF0C0A09);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);      // the app keeps its session in localStorage
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return openExternally(request.getUrl());
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request,
                                        WebResourceError error) {
                if (request.isForMainFrame()) {
                    loaded = false;
                    showStatus();
                    setStatus("无法连接到本地服务",
                            String.valueOf(error.getDescription()) + "\n" + tailLog());
                }
            }
        });
        return webView;
    }

    /** Keep the app self-contained: anything that is not our own origin goes to the browser. */
    private boolean openExternally(Uri uri) {
        if (uri == null) {
            return false;
        }
        String host = uri.getHost();
        if (host != null && (host.equals("127.0.0.1") || host.equals("localhost"))) {
            return false;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception e) {
            Toast.makeText(this, "无法打开链接", Toast.LENGTH_SHORT).show();
        }
        return true;
    }

    private void setStatus(String title, String detail) {
        statusTitle.setText(title);
        statusDetail.setText(detail);
    }

    private void showStatus() {
        // Hide the whole ScrollView, not just its child: a visible empty
        // ScrollView still sits above the WebView and swallows every touch,
        // which made the page render but leave everything un-tappable.
        statusScroll.setVisibility(View.VISIBLE);
        webView.setVisibility(View.GONE);
    }

    private void showWeb() {
        statusScroll.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    // -------------------------------------------------------------- startup

    private void pollUntilReady() {
        new Thread(new Runnable() {
            @Override
            public void run() {
                int ticks = 0;
                while (!loaded) {
                    long waited = System.currentTimeMillis() - pollStartedAt;
                    if (waited > READY_TIMEOUT_MS) {
                        final String detail = tailLog();
                        ui.post(new Runnable() {
                            @Override
                            public void run() {
                                showStatus();
                                copyLogButton.setVisibility(View.VISIBLE);
                                setStatus("服务启动超时（" + (READY_TIMEOUT_MS / 1000) + " 秒）", detail);
                            }
                        });
                        return;
                    }
                    if (probe()) {
                        ui.post(new Runnable() {
                            @Override
                            public void run() {
                                loaded = true;
                                showWeb();
                                webView.loadUrl(BASE);
                            }
                        });
                        return;
                    }
                    // A ticking counter proves the app is alive and tells us how
                    // long the wait has actually been.
                    if (++ticks % 4 == 0) {
                        final long secs = waited / 1000;
                        ui.post(new Runnable() {
                            @Override
                            public void run() {
                                if (statusScroll.getVisibility() == View.VISIBLE) {
                                    statusDetail.setText("首次启动需要解压运行时，请稍候…\n已等待 "
                                            + secs + " 秒（超过 "
                                            + (READY_TIMEOUT_MS / 1000) + " 秒会显示日志）");
                                }
                            }
                        });
                    }
                    try {
                        Thread.sleep(POLL_INTERVAL_MS);
                    } catch (InterruptedException e) {
                        return;
                    }
                }
            }
        }, "hh-ready-poll").start();
    }

    private boolean probe() {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(BASE + "/").openConnection();
            c.setConnectTimeout(1500);
            c.setReadTimeout(1500);
            c.setRequestMethod("GET");
            int code = c.getResponseCode();
            return code >= 200 && code < 500;
        } catch (Exception e) {
            return false;
        } finally {
            if (c != null) {
                c.disconnect();
            }
        }
    }

    /** Last lines of node's stdout/stderr, so a failure is diagnosable on-device. */
    private String tailLog() {
        File log = NodeService.getLogFile(this);
        if (!log.isFile()) {
            return "（暂无日志：" + log.getAbsolutePath() + "）";
        }
        StringBuilder sb = new StringBuilder();
        try (RandomAccessFile raf = new RandomAccessFile(log, "r")) {
            long len = raf.length();
            long from = Math.max(0, len - 16384);
            raf.seek(from);
            byte[] buf = new byte[(int) (len - from)];
            raf.readFully(buf);
            String[] lines = new String(buf, StandardCharsets.UTF_8).split("\n");
            int start = Math.max(0, lines.length - 60);
            for (int i = start; i < lines.length; i++) {
                sb.append(lines[i]).append('\n');
            }
        } catch (Exception e) {
            return "（读取日志失败：" + e.getMessage() + "）";
        }
        String text = sb.toString().trim();
        return text.isEmpty() ? "（日志为空）" : text;
    }

    // ------------------------------------------------------------ lifecycle

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // Returning from the launcher while the service already runs: just show
        // the app again and let the existing WebView keep its state.
        if (loaded && webView != null) {
            showWeb();
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.setWebViewClient(new WebViewClient());
        }
        super.onDestroy();
        // node is owned by NodeService, not by this activity -- leave it running.
    }

    @SuppressWarnings("unused")
    private String describe() {
        return String.format(Locale.US, "backend=%s port=%d", BASE, NodeService.PORT);
    }
}

package com.controlrondas.app;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;
import org.json.JSONArray;
import org.json.JSONObject;

/** Barcos en tiempo real (AIS) desde aisstream.io por WebSocket. La web recoge los mensajes con RondasNative.ships(). */
public class ShipFeed {
    private static final OkHttpClient http = new OkHttpClient.Builder().pingInterval(30, TimeUnit.SECONDS).readTimeout(0, TimeUnit.MILLISECONDS).build();
    private static WebSocket ws;
    private static String key, sub;
    private static boolean on;
    private static final ArrayList<String> queue = new ArrayList<>();
    private static final android.os.Handler h = new android.os.Handler(android.os.Looper.getMainLooper());

    static synchronized void start(String apiKey, JSONArray box) {
        try {
            JSONObject s = new JSONObject();
            s.put("APIKey", apiKey);
            JSONArray boxes = new JSONArray(); boxes.put(box);
            s.put("BoundingBoxes", boxes);
            JSONArray types = new JSONArray();
            types.put("PositionReport"); types.put("StandardClassBPositionReport"); types.put("ExtendedClassBPositionReport"); types.put("ShipStaticData"); types.put("StaticDataReport");
            s.put("FilterMessageTypes", types);
            sub = s.toString();
        } catch (Exception e) { return; }
        key = apiKey; on = true;
        if (ws == null) connect();
        else ws.send(sub); // actualizar la zona
    }

    static synchronized void stop() {
        on = false;
        if (ws != null) { try { ws.close(1000, "fin"); } catch (Exception e) { } ws = null; }
    }

    static synchronized List<String> drain() {
        ArrayList<String> out = new ArrayList<>(queue); queue.clear(); return out;
    }

    private static synchronized void push(String t) {
        queue.add(t);
        if (queue.size() > 3000) queue.subList(0, queue.size() - 3000).clear();
    }

    private static synchronized void connect() {
        if (!on) return;
        Request req = new Request.Builder().url("wss://stream.aisstream.io/v0/stream").build();
        ws = http.newWebSocket(req, new WebSocketListener() {
            @Override public void onOpen(WebSocket w, Response r) { w.send(sub); }
            @Override public void onMessage(WebSocket w, String text) { push(text); }
            @Override public void onMessage(WebSocket w, ByteString bytes) { push(bytes.utf8()); }
            @Override public void onClosed(WebSocket w, int code, String reason) { retry(w); }
            @Override public void onFailure(WebSocket w, Throwable t, Response r) { retry(w); }
        });
    }

    private static void retry(WebSocket w) {
        synchronized (ShipFeed.class) { if (ws == w) ws = null; }
        h.postDelayed(() -> { synchronized (ShipFeed.class) { if (on && ws == null) connect(); } }, 15000);
    }
}

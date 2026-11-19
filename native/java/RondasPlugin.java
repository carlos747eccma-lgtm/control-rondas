package com.controlrondas.app;

import android.Manifest;
import android.content.Intent;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(name = "RondasNative", permissions = {
    @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }),
    @Permission(alias = "notifications", strings = { "android.permission.POST_NOTIFICATIONS" })
})
public class RondasPlugin extends Plugin {
    static RondasPlugin inst;

    static double num(PluginCall call, String k, double d) {
        Object v = call.getData().opt(k);
        return v instanceof Number ? ((Number) v).doubleValue() : d;
    }

    @Override
    public void load() { inst = this; }

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("location") != PermissionState.GRANTED) {
            requestPermissionForAliases(new String[] { "location", "notifications" }, call, "permCb");
            return;
        }
        if (android.os.Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "permCb");
            return;
        }
        doStart(call);
    }

    @PermissionCallback
    private void permCb(PluginCall call) {
        if (getPermissionState("location") == PermissionState.GRANTED) doStart(call);
        else call.reject("Permiso de ubicación denegado", "NOT_AUTHORIZED");
    }

    private void doStart(PluginCall call) {
        try {
            Intent i = new Intent(getContext(), GuardService.class);
            i.putExtra("cfg", true);
            i.putExtra("speedLimit", num(call, "speedLimit", 25.0));
            i.putExtra("stopAlarm", num(call, "stopAlarm", 10.0));
            i.putExtra("stopRad", num(call, "stopRad", 8.0));
            i.putExtra("stopSec", num(call, "stopSec", 30.0));
            i.putExtra("maxAcc", num(call, "maxAcc", 25.0));
            i.putExtra("jumpSpd", num(call, "jumpSpd", 90.0));
            ContextCompat.startForegroundService(getContext(), i);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void test(PluginCall call) {
        final android.content.Context ctx = getContext().getApplicationContext();
        new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() ->
            GuardService.alarm(ctx, 9199, "Prueba de alarma", "Así suena la alarma con la pantalla apagada"), 10000);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        try { ShipFeed.stop(); } catch (Exception e) { }
        try { getContext().stopService(new Intent(getContext(), GuardService.class)); } catch (Exception e) { }
        call.resolve();
        if (getActivity() != null) getActivity().runOnUiThread(() -> getActivity().finishAndRemoveTask());
    }

    @PluginMethod
    public void email(PluginCall call) {
        try {
            java.util.ArrayList<String> tos = new java.util.ArrayList<>();
            com.getcapacitor.JSArray to = call.getArray("to");
            if (to != null) for (int k = 0; k < to.length(); k++) tos.add(to.getString(k));
            java.util.ArrayList<android.net.Uri> uris = new java.util.ArrayList<>();
            com.getcapacitor.JSArray paths = call.getArray("paths");
            if (paths != null) for (int k = 0; k < paths.length(); k++) {
                java.io.File f = new java.io.File(android.net.Uri.parse(paths.getString(k)).getPath());
                uris.add(androidx.core.content.FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f));
            }
            Intent i = new Intent(uris.size() > 1 ? Intent.ACTION_SEND_MULTIPLE : Intent.ACTION_SEND);
            i.setType("application/pdf");
            i.putExtra(Intent.EXTRA_EMAIL, tos.toArray(new String[0]));
            i.putExtra(Intent.EXTRA_SUBJECT, call.getString("subject", ""));
            i.putExtra(Intent.EXTRA_TEXT, call.getString("body", ""));
            if (uris.size() > 1) i.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
            else if (uris.size() == 1) i.putExtra(Intent.EXTRA_STREAM, uris.get(0));
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent ch = Intent.createChooser(i, "Enviar informe por correo");
            ch.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            if (getActivity() != null) getActivity().startActivity(ch);
            else { ch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); getContext().startActivity(ch); }
            call.resolve();
        } catch (Exception e) { call.reject(e.getMessage()); }
    }

    @PluginMethod
    public void relevo(PluginCall call) {
        try {
            Intent i = new Intent(getContext(), GuardService.class);
            i.putExtra("relevo", Boolean.TRUE.equals(call.getBoolean("on", false)));
            ContextCompat.startForegroundService(getContext(), i);
            call.resolve();
        } catch (Exception e) { call.reject(e.getMessage()); }
    }

    @PluginMethod
    public void shipsStart(PluginCall call) {
        String key = call.getString("key", "");
        com.getcapacitor.JSArray box = call.getArray("box");
        if (key == null || key.isEmpty() || box == null) { call.reject("Falta la clave AIS"); return; }
        ShipFeed.start(key, box);
        call.resolve();
    }

    @PluginMethod
    public void shipsStop(PluginCall call) { ShipFeed.stop(); call.resolve(); }

    @PluginMethod
    public void ships(PluginCall call) {
        com.getcapacitor.JSArray a = new com.getcapacitor.JSArray();
        for (String t : ShipFeed.drain()) a.put(t);
        JSObject r = new JSObject(); r.put("msgs", a);
        call.resolve(r);
    }

    @PluginMethod
    public void drain(PluginCall call) {
        long since = (long) num(call, "since", 0); // ojo: getDouble devuelve el valor por defecto con números enteros grandes (Long)
        java.util.List<double[]> l = GuardService.since(getContext(), since);
        com.getcapacitor.JSArray a = new com.getcapacitor.JSArray();
        try {
            for (double[] f : l) {
                com.getcapacitor.JSArray x = new com.getcapacitor.JSArray();
                for (double v : f) x.put(v);
                a.put(x);
            }
        } catch (Exception e) { }
        JSObject r = new JSObject(); r.put("fixes", a);
        call.resolve(r);
    }
}

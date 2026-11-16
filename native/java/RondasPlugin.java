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
            i.putExtra("speedLimit", call.getDouble("speedLimit", 25.0));
            i.putExtra("stopAlarm", call.getDouble("stopAlarm", 5.0));
            i.putExtra("stopRad", call.getDouble("stopRad", 8.0));
            i.putExtra("stopSec", call.getDouble("stopSec", 30.0));
            i.putExtra("maxAcc", call.getDouble("maxAcc", 25.0));
            i.putExtra("jumpSpd", call.getDouble("jumpSpd", 90.0));
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
    public void drain(PluginCall call) {
        long since = (long) (double) call.getDouble("since", 0.0);
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

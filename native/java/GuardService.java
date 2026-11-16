package com.controlrondas.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;

/**
 * Servicio en primer plano: GPS permanente y alarmas (parada larga, exceso de velocidad)
 * calculadas aquí, en nativo, para que suenen aunque la pantalla esté apagada y la web congelada.
 */
public class GuardService extends Service implements LocationListener {
    static final String CH_RUN = "rondas_run", CH_AL = "rondas_alarma_v1";
    static final int ID_RUN = 1, ID_WARN = 9000, ID_STOP = 9001, ID_SPEED = 9100;

    private LocationManager lm;
    private PowerManager.WakeLock wl;
    private final Handler h = new Handler(Looper.getMainLooper());

    private double speedLimit = 25, stopRad = 8, maxAcc = 25, jumpSpd = 90;
    private long stopSecMs = 30000, stopAlarmMs = 10 * 60000;

    private boolean hasA, inStop, warned;
    private double aLat, aLng; private long aT; private int aN; private long lastAlarm;
    private int osN, osLow; private boolean inOs; private int osCount;
    private Location prev;
    // modo relevo: sin alarma de parado hasta que se aleje 20 m
    private boolean relevo; private double rLat = Double.NaN, rLng;

    // Posiciones guardadas en nativo: la web las recoge al volver (con la pantalla bloqueada está congelada)
    static final java.util.ArrayList<double[]> BUF = new java.util.ArrayList<>();
    static final int MAX_BUF = 100000;
    static java.io.File bufFile(Context ctx) { return new java.io.File(ctx.getFilesDir(), "fixes.csv"); }
    static synchronized void loadBuf(Context ctx) {
        if (!BUF.isEmpty()) return;
        try (java.io.BufferedReader r = new java.io.BufferedReader(new java.io.FileReader(bufFile(ctx)))) {
            String ln; while ((ln = r.readLine()) != null) {
                String[] p = ln.split(","); if (p.length < 5) continue;
                BUF.add(new double[] { Double.parseDouble(p[0]), Double.parseDouble(p[1]), Double.parseDouble(p[2]), Double.parseDouble(p[3]), Double.parseDouble(p[4]) });
            }
        } catch (Exception e) { }
        while (BUF.size() > MAX_BUF) BUF.remove(0);
    }
    static synchronized void addBuf(Context ctx, double[] f) {
        BUF.add(f);
        if (BUF.size() > MAX_BUF) {
            BUF.subList(0, MAX_BUF / 2).clear();
            try (java.io.FileWriter w = new java.io.FileWriter(bufFile(ctx), false)) { for (double[] x : BUF) w.write(line(x)); } catch (Exception e) { }
            return;
        }
        try (java.io.FileWriter w = new java.io.FileWriter(bufFile(ctx), true)) { w.write(line(f)); } catch (Exception e) { }
    }
    static String line(double[] f) { return String.format(java.util.Locale.ROOT, "%.7f,%.7f,%.1f,%.2f,%d%n", f[0], f[1], f[2], f[3], (long) f[4]); }
    static synchronized java.util.List<double[]> since(Context ctx, long t) {
        loadBuf(ctx);
        java.util.ArrayList<double[]> out = new java.util.ArrayList<>();
        int i = BUF.size() - 1;
        while (i >= 0 && BUF.get(i)[4] > t) i--;
        for (int k = i + 1; k < BUF.size() && out.size() < 5000; k++) out.add(BUF.get(k));
        return out;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        channels(this);
        loadBuf(this);
        Notification n = new NotificationCompat.Builder(this, CH_RUN)
            .setSmallIcon(R.drawable.ic_stat_alarm)
            .setContentTitle("Control de Rondas")
            .setContentText("Vigilancia GPS activa")
            .setOngoing(true)
            .setContentIntent(openApp(this))
            .build();
        if (Build.VERSION.SDK_INT >= 29) startForeground(ID_RUN, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        else startForeground(ID_RUN, n);
        try {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "rondas:gps");
            wl.acquire();
        } catch (Exception e) { }
        try {
            lm = (LocationManager) getSystemService(LOCATION_SERVICE);
            lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000, 0, this, Looper.getMainLooper());
        } catch (SecurityException e) { } catch (Exception e) { }
        h.postDelayed(tick, 3000);
    }

    @Override
    public int onStartCommand(Intent i, int flags, int startId) {
        if (i != null && i.hasExtra("relevo")) {
            relevo = i.getBooleanExtra("relevo", false);
            if (relevo) { cancelStop(); if (prev != null) { rLat = prev.getLatitude(); rLng = prev.getLongitude(); } else rLat = Double.NaN; }
        }
        if (i != null && i.getBooleanExtra("cfg", false)) {
            speedLimit = i.getDoubleExtra("speedLimit", speedLimit);
            stopAlarmMs = (long) (i.getDoubleExtra("stopAlarm", stopAlarmMs / 60000.0) * 60000);
            stopRad = i.getDoubleExtra("stopRad", stopRad);
            stopSecMs = (long) (i.getDoubleExtra("stopSec", stopSecMs / 1000.0) * 1000);
            maxAcc = i.getDoubleExtra("maxAcc", maxAcc);
            jumpSpd = i.getDoubleExtra("jumpSpd", jumpSpd);
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        h.removeCallbacksAndMessages(null);
        try { if (lm != null) lm.removeUpdates(this); } catch (Exception e) { }
        try { if (wl != null && wl.isHeld()) wl.release(); } catch (Exception e) { }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onLocationChanged(Location l) {
        long now = System.currentTimeMillis();
        addBuf(this, new double[] { l.getLatitude(), l.getLongitude(), l.hasAccuracy() ? l.getAccuracy() : 99, l.hasSpeed() ? l.getSpeed() : -1, now });

        float acc = l.hasAccuracy() ? l.getAccuracy() : 99;
        if (acc > maxAcc) return;
        // velocidad: la del GPS o la calculada entre posiciones
        double spd = 0;
        if (l.hasSpeed()) spd = l.getSpeed() * 3.6;
        else if (prev != null) { double dt = (l.getTime() - prev.getTime()) / 1000.0; if (dt > 0) spd = l.distanceTo(prev) / dt * 3.6; }
        if (prev != null) {
            double dt = (l.getTime() - prev.getTime()) / 1000.0;
            if (dt > 0 && l.distanceTo(prev) / dt * 3.6 > jumpSpd) return; // salto de GPS
        }
        prev = l;
        if (relevo) {
            if (Double.isNaN(rLat)) { rLat = l.getLatitude(); rLng = l.getLongitude(); }
            else { float[] dr = new float[1]; Location.distanceBetween(rLat, rLng, l.getLatitude(), l.getLongitude(), dr); if (dr[0] > 20) relevo = false; }
        }
        checkSpeed(spd, acc);
        checkStop(l, acc, now);
    }

    private void checkSpeed(double spd, float acc) {
        if (speedLimit <= 0) return;
        if (spd > speedLimit && acc <= 20) {
            osN++; osLow = 0;
            if (!inOs && osN >= 3) {
                inOs = true;
                alarm(this, ID_SPEED + (osCount++ % 50), "⚠ Más de " + Math.round(speedLimit) + " km/h",
                    Math.round(spd) + " km/h a las " + hm(System.currentTimeMillis()) + ": queda registrado");
            }
        } else {
            osN = 0;
            if (inOs && ++osLow >= 2) { inOs = false; osLow = 0; }
        }
    }

    private void checkStop(Location l, float acc, long now) {
        if (!hasA) { newAnchor(l, now); return; }
        float[] d = new float[1];
        Location.distanceBetween(aLat, aLng, l.getLatitude(), l.getLongitude(), d);
        if (d[0] <= stopRad + Math.min(acc * 0.3, 6)) {
            aLat = (aLat * aN + l.getLatitude()) / (aN + 1);
            aLng = (aLng * aN + l.getLongitude()) / (aN + 1);
            aN++;
            if (!inStop && now - aT >= stopSecMs) inStop = true;
        } else {
            if (inStop) cancelStop();
            newAnchor(l, now);
        }
    }

    private void newAnchor(Location l, long now) {
        hasA = true; inStop = false; warned = false; lastAlarm = 0;
        aLat = l.getLatitude(); aLng = l.getLongitude(); aT = now; aN = 1;
    }

    private void cancelStop() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        nm.cancel(ID_WARN); nm.cancel(ID_STOP);
    }

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            try {
                if (inStop && stopAlarmMs > 0 && !relevo) {
                    long now = System.currentTimeMillis(), dt = now - aT;
                    if (dt >= stopAlarmMs) {
                        if (now - lastAlarm >= 30000) {
                            lastAlarm = now;
                            alarm(GuardService.this, ID_STOP, "⚠ PARADO " + (dt / 60000) + " MIN",
                                "Desde las " + hm(aT) + ". Queda registrado como incidencia. Muévete para que pare la alarma.");
                        }
                    } else if (stopAlarmMs >= 120000 && dt >= stopAlarmMs - 60000 && !warned) {
                        warned = true;
                        alarm(GuardService.this, ID_WARN, "Llevas " + (dt / 60000) + " min parado", "Muévete: en 1 minuto salta la alarma");
                    }
                }
            } catch (Exception e) { }
            h.postDelayed(this, 3000);
        }
    };

    static String hm(long t) {
        java.util.Calendar c = java.util.Calendar.getInstance(); c.setTimeInMillis(t);
        return String.format(java.util.Locale.ROOT, "%02d:%02d", c.get(java.util.Calendar.HOUR_OF_DAY), c.get(java.util.Calendar.MINUTE));
    }

    static PendingIntent openApp(Context ctx) {
        Intent i = new Intent(ctx, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(ctx, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    static void channels(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) ctx.getSystemService(NOTIFICATION_SERVICE);
        if (nm.getNotificationChannel(CH_RUN) == null) {
            NotificationChannel c = new NotificationChannel(CH_RUN, "Vigilancia activa", NotificationManager.IMPORTANCE_LOW);
            c.setShowBadge(false);
            nm.createNotificationChannel(c);
        }
        if (nm.getNotificationChannel(CH_AL) == null) {
            NotificationChannel c = new NotificationChannel(CH_AL, "Alarmas de ronda", NotificationManager.IMPORTANCE_HIGH);
            c.setDescription("Paradas largas y excesos de velocidad");
            c.enableVibration(true);
            c.setVibrationPattern(new long[] { 0, 800, 200, 800, 200, 800 });
            c.enableLights(true);
            c.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            c.setBypassDnd(true);
            AudioAttributes aa = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build();
            c.setSound(Uri.parse("android.resource://" + ctx.getPackageName() + "/" + R.raw.alarma), aa);
            nm.createNotificationChannel(c);
        }
    }

    static void alarm(Context ctx, int id, String title, String body) {
        try {
            channels(ctx);
            Notification n = new NotificationCompat.Builder(ctx, CH_AL)
                .setSmallIcon(R.drawable.ic_stat_alarm)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setSound(Uri.parse("android.resource://" + ctx.getPackageName() + "/" + R.raw.alarma), android.media.AudioManager.STREAM_ALARM)
                .setVibrate(new long[] { 0, 800, 200, 800, 200, 800 })
                .setAutoCancel(true)
                .setContentIntent(openApp(ctx))
                .build();
            ((NotificationManager) ctx.getSystemService(NOTIFICATION_SERVICE)).notify(id, n);
            // enciende la pantalla un momento para que se vea el aviso
            try {
                PowerManager pm = (PowerManager) ctx.getSystemService(POWER_SERVICE);
                @SuppressWarnings("deprecation")
                PowerManager.WakeLock w = pm.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK | PowerManager.ACQUIRE_CAUSES_WAKEUP, "rondas:alarm");
                w.acquire(5000);
            } catch (Exception e) { }
        } catch (Exception e) { }
    }

    @Override public void onProviderEnabled(String p) { }
    @Override public void onProviderDisabled(String p) { }
    @Override public void onStatusChanged(String p, int s, Bundle b) { }
}

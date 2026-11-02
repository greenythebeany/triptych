package com.triptych.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import androidx.core.content.ContextCompat;

// Stands in for the media-session plugin's own MediaButtonReceiver (removed
// in AndroidManifest.xml). Android sends media buttons -- headphones
// connecting, a car, a Bluetooth play key -- to the last app that played,
// even when it isn't running. The plugin's receiver then started its
// notification service with no app behind it: a "playing" notification
// while Triptych was closed. Here buttons only reach that service while
// the app is actually open; otherwise they're ignored.
//
// Also the receiver the notification's own buttons go through
// (MediaButtonReceiver.buildMediaButtonPendingIntent finds it by its
// MEDIA_BUTTON intent filter), so those keep working while the app runs.
public class MediaButtonGate extends BroadcastReceiver {
    private static final String SERVICE = "com.capgo.mediasession.MediaSessionService";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !Intent.ACTION_MEDIA_BUTTON.equals(intent.getAction())) return;
        if (!MainActivity.isRunning()) return;
        Intent forward = new Intent(intent);
        forward.setClassName(context, SERVICE);
        try {
            ContextCompat.startForegroundService(context, forward);
        } catch (RuntimeException ignored) {
            // Background-start restrictions: nothing to control then anyway.
        }
    }
}

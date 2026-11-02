package com.triptych.app;

import android.content.Context;
import android.content.Intent;
import android.media.AudioManager;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    // Whether the app (its WebView, and so the player) is alive -- media
    // buttons are only passed on while it is (MediaButtonGate).
    private static volatile boolean running = false;

    static boolean isRunning() {
        return running;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        running = true;
        registerPlugin(LoudnessPlugin.class);
        registerPlugin(SystemVolumePlugin.class);
        registerPlugin(LocalMusicPlugin.class);
        registerPlugin(PowerSaverPlugin.class);
        super.onCreate(savedInstanceState);

        // The WebView's <audio> playback otherwise runs without ever
        // claiming the music audio stream, which on many devices leaves it
        // noticeably quieter than native apps at the same hardware volume
        // (hardware volume keys and any system loudness handling target
        // STREAM_MUSIC, not whatever stream Chromium picks by default).
        AudioManager audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        if (audioManager != null) {
            setVolumeControlStream(AudioManager.STREAM_MUSIC);
        }

        // The actual audio focus *request* — with a real listener, not a
        // no-op — lives in LoudnessPlugin now instead of here, since it
        // needs to notify the JS side (Player) when focus is lost/regained
        // so playback can pause and auto-resume properly. A bare
        // requestAudioFocus() with an empty callback used to live here:
        // Chromium's own WebView audio pipeline still reacts to focus loss
        // by pausing on its own, but with nothing listening for focus
        // *regain*, playback stayed paused after any interruption (another
        // app's notification sound, switching apps, etc.) until manually
        // resumed — exactly the "stops when backgrounded" symptom this
        // fixes.

        // Volume boosting is handled by LoudnessPlugin instead of here — an
        // always-on LoudnessEnhancer used to live in this file, but it broke
        // Bluetooth AVRCP volume sync on at least one car head unit, so it's
        // now a single fixed-gain attempt tied to actual playback starting
        // rather than something that runs unconditionally from launch.
    }

    // Closing the app takes its media notification with it, instead of
    // leaving a "playing" one behind with nothing playing.
    @Override
    public void onDestroy() {
        running = false;
        if (isFinishing()) {
            try {
                stopService(new Intent().setClassName(this, "com.capgo.mediasession.MediaSessionService"));
            } catch (RuntimeException ignored) {
                // Not running.
            }
        }
        super.onDestroy();
    }
}

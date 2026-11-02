package com.triptych.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.PowerManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import androidx.core.content.ContextCompat;

// Battery saver on/off, so Settings -> Animations can go Static while it's
// on (see watchPowerSaver in platform.js). Reports the current state and
// every change ("change" event, { on }).
@CapacitorPlugin(name = "TriptychPowerSaver")
public class PowerSaverPlugin extends Plugin {
    private PowerManager powerManager;
    private BroadcastReceiver receiver;

    private JSObject state() {
        JSObject data = new JSObject();
        data.put("on", powerManager != null && powerManager.isPowerSaveMode());
        return data;
    }

    @Override
    public void load() {
        powerManager = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                notifyListeners("change", state());
            }
        };
        ContextCompat.registerReceiver(getContext(), receiver,
            new IntentFilter(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED), ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    @Override
    protected void handleOnDestroy() {
        if (receiver != null) {
            try { getContext().unregisterReceiver(receiver); } catch (IllegalArgumentException ignored) { }
            receiver = null;
        }
    }

    @PluginMethod
    public void getState(PluginCall call) {
        call.resolve(state());
    }
}

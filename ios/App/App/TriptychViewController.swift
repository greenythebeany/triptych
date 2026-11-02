import UIKit
import Capacitor
import AVFoundation
import MediaPlayer

// The app's own bridge view controller (set as the root in Main.storyboard),
// only so the app-local native plugins below get registered -- Capacitor
// auto-registers plugins from npm packages, not ones that live in the app.
class TriptychViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        // A music player, not app sound: the "playback" category keeps audio
        // going in the background and with the silent switch on, and is what
        // gives the app the lock screen / Control Center player. (With the
        // default category those only showed up some of the time.) Only the
        // category is set here -- the session is activated once something
        // plays (SystemVolumePlugin.activate), so just opening the app never
        // stops music another app is playing.
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [])
        bridge?.registerPluginInstance(SystemVolumePlugin())
        bridge?.registerPluginInstance(PowerSaverPlugin())
    }
}

// iOS counterpart of Android's SystemVolumePlugin.java: lets the in-app
// volume slider show and set the phone's real volume and follow the
// hardware buttons. (WebKit ignores <audio>.volume on iOS, so an in-app
// level was never possible here anyway.) Levels are 0...1 fractions.
@objc(SystemVolumePlugin)
public class SystemVolumePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SystemVolumePlugin"
    public let jsName = "TriptychSystemVolume"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getVolume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setVolume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "activate", returnType: CAPPluginReturnPromise)
    ]

    private var observation: NSKeyValueObservation?
    // Set once something has played; from then on the session is re-activated
    // whenever iOS deactivates it (a call, Siri, another app, coming back from
    // the background), since outputVolume only reports changes -- i.e. the
    // hardware buttons only move the slider -- while it's active.
    private var wantsActive = false

    // iOS has no public API to set the system volume; the standard approach
    // is an MPVolumeView's internal slider. Kept off-screen (but in the view
    // hierarchy, which also stops the system volume HUD from popping up
    // over the app while our own slider is in use).
    private lazy var volumeView: MPVolumeView = {
        let view = MPVolumeView(frame: CGRect(x: -2000, y: -2000, width: 100, height: 40))
        view.alpha = 0.01
        bridge?.viewController?.view.addSubview(view)
        return view
    }()

    override public func load() {
        let session = AVAudioSession.sharedInstance()
        observation = session.observe(\.outputVolume, options: [.new]) { [weak self] _, change in
            guard let level = change.newValue else { return }
            self?.notifyListeners("volumeChange", data: ["level": Double(level)])
        }
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(reactivate), name: UIApplication.didBecomeActiveNotification, object: nil)
        center.addObserver(self, selector: #selector(reactivate), name: AVAudioSession.mediaServicesWereResetNotification, object: nil)
        center.addObserver(self, selector: #selector(interruption(_:)), name: AVAudioSession.interruptionNotification, object: session)
        DispatchQueue.main.async { _ = self.volumeView }
    }

    deinit {
        observation?.invalidate()
        NotificationCenter.default.removeObserver(self)
    }

    @objc private func reactivate() {
        guard wantsActive else { return }
        let session = AVAudioSession.sharedInstance()
        if session.category != .playback {
            try? session.setCategory(.playback, mode: .default, options: [])
        }
        try? session.setActive(true)
        // Catch up on anything the buttons changed while it was inactive.
        notifyListeners("volumeChange", data: ["level": Double(session.outputVolume)])
    }

    @objc private func interruption(_ note: Notification) {
        guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              AVAudioSession.InterruptionType(rawValue: raw) == .ended else { return }
        reactivate()
    }

    // Called from JS whenever playback starts.
    @objc func activate(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.wantsActive = true
            self.reactivate()
            call.resolve()
        }
    }

    @objc func getVolume(_ call: CAPPluginCall) {
        call.resolve(["level": Double(AVAudioSession.sharedInstance().outputVolume)])
    }

    @objc func setVolume(_ call: CAPPluginCall) {
        let level = Float(max(0, min(1, call.getDouble("level") ?? 0.5)))
        DispatchQueue.main.async {
            guard let slider = self.volumeView.subviews.compactMap({ $0 as? UISlider }).first else {
                call.reject("Volume control unavailable")
                return
            }
            slider.setValue(level, animated: false)
            slider.sendActions(for: .valueChanged)
            call.resolve(["level": Double(level)])
        }
    }
}

// Low Power Mode on/off, so Settings -> Animations can go Static while it's
// on (see watchPowerSaver in platform.js). Same shape as Android's
// PowerSaverPlugin.java: getState() and a "change" event, both { on }.
@objc(PowerSaverPlugin)
public class PowerSaverPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PowerSaverPlugin"
    public let jsName = "TriptychPowerSaver"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise)
    ]

    override public func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(changed), name: .NSProcessInfoPowerStateDidChange, object: nil)
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    @objc private func changed() {
        notifyListeners("change", data: ["on": ProcessInfo.processInfo.isLowPowerModeEnabled])
    }

    @objc func getState(_ call: CAPPluginCall) {
        call.resolve(["on": ProcessInfo.processInfo.isLowPowerModeEnabled])
    }
}

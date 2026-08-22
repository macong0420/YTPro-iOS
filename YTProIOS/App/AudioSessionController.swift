import AVFoundation
import Foundation
import os

/// Owns the *category* of the shared `AVAudioSession` so WebKit keeps playing
/// once the app leaves the foreground.
///
/// Activating the session is deliberately left to WebKit. Media plays in
/// WebKit's own process, which holds its own client of the shared session, and
/// a `setActive(true)` from the app process reaches that client as an
/// interruption: the video pauses, YouTube restarts it, the resulting playback
/// report activates the session again, and playback ends up in a pause loop
/// that survives until the page is reloaded.
///
/// The division of labour is that the app owns the category — it is process
/// wide, and `.playback` together with the `audio` background mode is what
/// earns the background time — while WebKit's media process owns activation.
@MainActor
final class AudioSessionController {
    static let shared = AudioSessionController()

    private static let log = Logger(subsystem: "com.ytpro.app", category: "audio-session")

    private var observers: [NSObjectProtocol] = []

    private init() {
    }

    func configure() {
        ensurePlaybackCategory()
        installObservers()
    }

    /// Everything about the shared session that matters when background
    /// playback misbehaves, in one line for the log.
    var stateDescription: String {
        let session = AVAudioSession.sharedInstance()

        return "category=\(session.category.rawValue.replacingOccurrences(of: "AVAudioSessionCategory", with: ""))"
            + " mode=\(session.mode.rawValue.replacingOccurrences(of: "AVAudioSessionMode", with: ""))"
            + " otherAudio=\(session.isOtherAudioPlaying)"
            + " outputs=\(session.currentRoute.outputs.map(\.portType.rawValue).joined(separator: ","))"
    }

    /// Repairs the category when something else has changed it.
    ///
    /// Only writes when it is genuinely wrong: rewriting the category while
    /// media is playing reaches WebKit's media session as an interruption, the
    /// same way activation does.
    func ensurePlaybackCategory() {
        let session = AVAudioSession.sharedInstance()

        guard session.category != .playback else {
            return
        }

        do {
            try session.setCategory(.playback, mode: .moviePlayback)
            Self.log.info("playback category applied, \(self.stateDescription, privacy: .public)")
        } catch {
            Self.log.error(
                "failed to configure the audio session: \(error.localizedDescription, privacy: .public)"
            )
        }
    }

    private func installObservers() {
        guard observers.isEmpty else {
            return
        }

        let center = NotificationCenter.default

        observers = [
            center.addObserver(
                forName: AVAudioSession.interruptionNotification,
                object: AVAudioSession.sharedInstance(),
                queue: .main
            ) { [weak self] notification in
                MainActor.assumeIsolated {
                    self?.handleInterruption(notification)
                }
            },
            center.addObserver(
                forName: AVAudioSession.mediaServicesWereResetNotification,
                object: AVAudioSession.sharedInstance(),
                queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    Self.log.info("media services were reset")
                    self?.ensurePlaybackCategory()
                }
            }
        ]
    }

    /// Observed for the log only. Resuming after an interruption belongs to
    /// WebKit's media session, and the bridge's own hold covers the case where
    /// it does not.
    private func handleInterruption(_ notification: Notification) {
        let rawType = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt

        guard let type = rawType.flatMap(AVAudioSession.InterruptionType.init(rawValue:)) else {
            return
        }

        switch type {
        case .began:
            Self.log.info("interruption began, \(self.stateDescription, privacy: .public)")
        case .ended:
            let rawOptions = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt
            let options = AVAudioSession.InterruptionOptions(rawValue: rawOptions ?? 0)

            Self.log.info(
                "interruption ended, shouldResume: \(options.contains(.shouldResume)), \(self.stateDescription, privacy: .public)"
            )
        @unknown default:
            break
        }
    }
}

# YTPro iOS

Personal-use iOS wrapper for mobile YouTube with two focused features:

- WebView-side ad cleanup through `WKUserScript`
- Background audio support through iOS background audio mode and `AVAudioSession`

This project intentionally does not include video download, account automation, or App Store packaging work.

## Run On iPhone

1. Open `YTPro-iOS.xcodeproj` in Xcode.
2. Connect your iPhone by USB or pair it over Wi-Fi.
3. Select the `YTProIOS` scheme and your iPhone as the run destination.
4. Open the target settings and set `Signing & Capabilities > Team` to your Apple ID team.
5. Press Run.

If you use a free Apple ID, Xcode may require you to refresh the install periodically.

## Files

- `YTProIOS/App/AppDelegate.swift` configures the playback audio session.
- `YTProIOS/Resources/Info.plist` declares `UIBackgroundModes` with `audio`.
- `YTProIOS/Browser/BrowserState.swift` owns the `WKWebView` and injects the user script.
- `YTProIOS/Resources/ytpro-adblock.js` contains the ad cleanup and background playback helper script.

## Login Troubleshooting

Google sign-in uses several redirect and helper domains. `BrowserState.swift` allows normal `http` and `https` navigation instead of maintaining a narrow host allowlist, because blocking one auxiliary auth domain can make sign-in appear successful and then lose state after returning to YouTube.

The injected script also exits immediately outside YouTube-owned hosts. This keeps the ad cleanup and background playback patches away from `accounts.google.com` and other login pages.

## Notes

YouTube changes its page structure regularly. When ads start showing again, update the selectors in `ytpro-adblock.js`.

Background playback on iOS still depends on WebKit and YouTube page behavior. The native side is configured correctly for background audio, but the JavaScript helper may need maintenance if YouTube changes its pause logic.

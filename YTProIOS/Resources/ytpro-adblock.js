(function () {
  "use strict";

  const supportedHosts = [
    "youtube.com",
    "youtu.be",
    "youtube-nocookie.com"
  ];

  const currentHost = window.location.hostname.toLowerCase();
  const isSupportedHost = supportedHosts.some(function (host) {
    return currentHost === host || currentHost.endsWith("." + host);
  });

  if (!isSupportedHost) {
    return;
  }

  const blockedSelectors = [
    "ytd-ad-slot-renderer",
    "ytd-action-companion-ad-renderer",
    "ytd-banner-promo-renderer",
    "ytd-carousel-ad-renderer",
    "ytd-companion-slot-renderer",
    "ytd-display-ad-renderer",
    "ytd-engagement-panel-section-list-renderer[target-id='engagement-panel-ads']",
    "ytd-in-feed-ad-layout-renderer",
    "ytd-player-legacy-desktop-watch-ads-renderer",
    "ytd-promoted-sparkles-text-search-renderer",
    "ytd-promoted-sparkles-web-renderer",
    "ytd-rich-item-renderer:has(ytd-ad-slot-renderer)",
    "ytm-companion-slot",
    "ytm-promoted-sparkles-web-renderer",
    "ytm-promoted-video-renderer",
    "ytm-paid-content-overlay-renderer",
    ".ad-container",
    ".ad-div",
    ".masthead-ad-control",
    ".video-ads",
    ".ytp-ad-module",
    ".ytp-ad-overlay-container",
    ".ytp-ad-player-overlay",
    ".ytp-ad-progress-list",
    ".ytp-paid-content-overlay",
    "[id^='player-ads']",
    "[layout*='display-ad']"
  ];

  const clickableSelectors = [
    ".ytp-ad-overlay-close-button",
    ".ytp-ad-skip-button",
    ".ytp-ad-skip-button-modern",
    ".ytp-skip-ad-button",
    ".ytp-ad-skip-button-slot button",
    ".ytp-ad-skip-button-container button"
  ];

  // YouTube reuses the requested video's media element for pre-rolls. Hiding
  // the controls alone therefore leaves the actual ad playing. `ad-showing` is
  // the stable player state; `ad-interrupting` is deliberately excluded from
  // forced seeking because it can appear before the media source has switched.
  const seekableAdPlayerSelectors = [
    ".html5-video-player.ad-showing",
    "#movie_player.ad-showing",
    "ytm-player.ad-showing"
  ];

  // On screen only while an ad is actually running: its countdown, its preview
  // timer, its badge, its skip control. Nothing else in the player produces
  // these, so a player showing one is playing an ad whatever its length claims.
  const liveAdEvidenceSelectors = [
    ".ytp-ad-duration-remaining",
    ".ytp-ad-preview-container",
    ".ytp-ad-preview-text",
    ".ytp-ad-simple-ad-badge",
    ".ytp-ad-message-container",
    ".ytp-ad-text",
    ".ytp-ad-text-overlay",
    ".ytp-ad-player-overlay",
    ".ytp-ad-player-overlay-layout",
    ".ytp-ad-player-overlay-instream-info",
    ".ytp-ad-skip-button-container",
    ".ytp-ad-skip-button-slot"
  ];

  // Containers YouTube keeps in the player whether or not an ad is running.
  // Treating these as evidence is what made every detection weak, and a weak
  // detection is why the length cap below had to be the only real guard.
  const persistentAdContainerSelectors = [
    ".video-ads",
    ".ytp-ad-module"
  ];

  const maximumForcedAdDurationSeconds = 120;

  // Seeking to the end of an ad is refused whenever the media source has not
  // buffered that far, and the ad then plays out in full. Muting it and running
  // the clock as fast as the element allows costs the user a second or two of
  // silence instead of the whole break.
  const forcedAdPlaybackRate = 16;

  const playerAdResponseKeys = new Set([
    "adPlacements",
    "playerAds",
    "adSlots",
    "adBreakHeartbeatParams"
  ]);

  // WebKit only reports "fullscreen" for the native video presentation. The
  // YouTube players frequently drive their own CSS fullscreen layout instead,
  // which these markers expose.
  const fullscreenMarkerSelectors = [
    "ytm-app[player-fullscreen]",
    "ytd-watch-flexy[fullscreen]",
    ".ytp-fullscreen"
  ];

  const INLINE = "inline";
  const FULLSCREEN = "fullscreen";
  const PICTURE_IN_PICTURE = "picture-in-picture";

  // Child-list and ad-revealing attribute changes are handled incrementally.
  // This slower full scan remains a recovery path for anything still missed.
  const fallbackScanIntervalMilliseconds = 5000;

  // How long a pause is still attributed to the background transition instead
  // of to the user. WebKit may freeze the media process well past the actual
  // suspension, so the window has to outlast the native ping schedule.
  const backgroundHoldWindowMilliseconds = 15000;
  const backgroundHoldIntervalMilliseconds = 250;
  const backgroundHoldReportIntervalMilliseconds = 1000;

  // Leaving the floating window is asynchronous; playback only resumes once
  // the element is inline again.
  const inlineRestorePollIntervalMilliseconds = 60;
  const inlineRestorePollLimit = 12;

  const renderProbeIntervalMilliseconds = 400;
  const renderProbeClockDeltaSeconds = 0.05;
  const repaintAttemptLimit = 2;

  // The fullscreen teardown interrupted by opening the floating window can
  // complete late: seconds after the app is back and the element was already
  // restored inline, WebKit flips it back to fullscreen behind the player's
  // back. A player told inline while the platform presents something else is
  // what leaves its controls unresponsive, so the restore is watched for a
  // few seconds and the drift is corrected.
  const presentationDriftCheckDelaysMilliseconds = [1200, 2400, 3600, 5000];
  const driftResumeRetryDelayMilliseconds = 300;

  const playbackSyncIntervalMilliseconds = 1000;

  // WebKit silently drops a presentation request made while another transition
  // is still in flight (`HTMLVideoElement::webkitSetPresentationMode` returns
  // early on `isChangingVideoFullscreenMode`), and the page cannot read that
  // flag, so recency of the last change stands in for it.
  const presentationSettleMilliseconds = 700;

  // The bridge announcing the background trip runs through `evaluateJavaScript`
  // and the web process is already throttled by the time the app resigns
  // active, so WebKit's own suspension pause regularly reaches the element
  // first. By then the two kinds of pause are indistinguishable — but the
  // gesture that preceded one of them is not, and that signal is available
  // without waiting for native.
  const userGestureWindowMilliseconds = 800;
  const transitionPauseWindowMilliseconds = 2000;
  const userGestureEventTypes = ["pointerdown", "mousedown", "touchstart", "keydown"];

  // A pause inside the floating window normally belongs to the user, because
  // its controls are system UI and leave no gesture on the page. During the
  // handover itself it does not: WebKit suspends the element as the app leaves,
  // and reading that as the user abandoning the trip silenced it.
  const backgroundTransitionGraceMilliseconds = 1500;

  const observedVideos = new Set();
  const pendingRoots = new Set();
  let incrementalScanScheduled = false;

  let appIsActive = true;
  let activeVideo = null;

  // `null` until the first report, so the initial sync always reaches native.
  let lastReportedPlaying = null;

  // Set while the app leaves the foreground with playback running, and cleared
  // as soon as a pause can be attributed to the user.
  let backgroundPlaybackIntended = false;
  let backgroundPresentationMode = INLINE;
  let backgroundHoldWindowOpen = false;
  let backgroundHoldWindowToken = 0;
  let backgroundHoldTimer = 0;

  let foregroundRestoreToken = 0;
  let foregroundRestoreInProgress = false;
  let repaintAttempts = 0;

  // Set when the video comes back from a fullscreen hand-out, so the first
  // render probe forces one layout even if the frame count keeps advancing.
  let pendingForegroundRepaint = false;

  let lastUserGestureAt = 0;
  let lastPauseAt = 0;
  let backgroundTransitionAt = 0;

  // Refreshed by the playback poll, so it stays within a second of the truth
  // however long the video has been running.
  let lastPlayingObservedAt = 0;

  let lastBackgroundHoldReportAt = 0;

  // Whether the floating window currently open is one the bridge asked for. A
  // window the user opened is theirs to keep; one opened for a background trip
  // has to be handed back when that trip ends.
  let bridgeOpenedPictureInPicture = false;
  let lastPresentationChangeAt = 0;

  let lastAdDiagnosticKey = "";
  let lastAdDiagnosticAt = 0;

  // The ad and the content share one media element, so whatever is forced on it
  // for the break has to be handed back exactly as it was found.
  let shieldedAdVideo = null;
  let shieldedAdMuted = false;
  let shieldedAdPlaybackRate = 1;

  function noteUserGesture() {
    lastUserGestureAt = Date.now();
  }

  // A pause the user asked for follows a gesture on the page within a few
  // hundred milliseconds. WebKit's suspension pause follows nothing. Both
  // timestamps must be real: at their initial zero the arithmetic would read as
  // a gesture and a pause in the same instant.
  function pauseFollowedUserGesture() {
    return lastPauseAt > 0 && lastUserGestureAt > 0 &&
      lastPauseAt >= lastUserGestureAt &&
      lastPauseAt - lastUserGestureAt <= userGestureWindowMilliseconds;
  }

  // The same question asked of the present moment, for the paths that cannot
  // trust `lastPauseAt`: `video.paused` flips synchronously while the `pause`
  // event is delivered as a later task, so the timestamp can still belong to
  // the previous trip.
  function recentUserGesture() {
    return Date.now() - lastUserGestureAt <= userGestureWindowMilliseconds;
  }

  // Was this pause WebKit suspending the app rather than the user? The element
  // has to have been playing moments ago — a video the user parked minutes back
  // must never be started again — and no gesture may have preceded it.
  function pausedByBackgroundTransition(video) {
    return Boolean(video) && video.paused && !video.ended &&
      Date.now() - lastPlayingObservedAt <= transitionPauseWindowMilliseconds &&
      !recentUserGesture() && !pauseFollowedUserGesture();
  }

  function ignoreRejection(result) {
    if (result && typeof result.catch === "function") {
      result.catch(function () {});
    }
  }

  function postToNative(payload) {
    try {
      const messageHandlers = window.webkit && window.webkit.messageHandlers;

      if (messageHandlers && messageHandlers.ytpro) {
        messageHandlers.ytpro.postMessage(payload);
      }
    } catch (_) {
      // The bridge is absent when the script runs outside the app.
    }
  }

  function logToNative(message) {
    postToNative({ type: "log", message: String(message) });
  }

  function logAdDiagnostic(reason, video) {
    const duration = video ? Number(video.duration) : -1;
    const currentTime = video ? Number(video.currentTime) : -1;
    const key = reason + ":" + duration + ":" + (video ? video.paused : "none");
    const now = Date.now();

    if (key === lastAdDiagnosticKey && now - lastAdDiagnosticAt < 2000) {
      return;
    }

    lastAdDiagnosticKey = key;
    lastAdDiagnosticAt = now;
    logToNative(
      "ad: waiting reason=" + reason +
      " paused=" + (video ? video.paused : "none") +
      " duration=" + duration +
      " t=" + currentTime
    );
  }

  function reportPlaybackState() {
    const playing = Boolean(activeVideo) && !activeVideo.paused && !activeVideo.ended;
    lastReportedPlaying = playing;

    postToNative({
      type: "playback",
      playing: playing
    });
  }

  // The player can start a video before the mutation observer has attached its
  // listeners to that element, and the `playing` event is then lost for good —
  // leaving the native side convinced nothing is playing and skipping the audio
  // session claim that background playback depends on. Polling closes that gap.
  function syncPlaybackState() {
    const video = pickActiveVideo();

    if (video) {
      activeVideo = video;
    }

    const playing = Boolean(activeVideo) && !activeVideo.paused && !activeVideo.ended;

    if (playing) {
      lastPlayingObservedAt = Date.now();
    }

    if (playing !== lastReportedPlaying) {
      reportPlaybackState();
    }
  }

  function hideElement(element) {
    if (!element || element.dataset.ytproHidden === "1") {
      return;
    }

    element.dataset.ytproHidden = "1";
    element.style.setProperty("display", "none", "important");
    element.style.setProperty("visibility", "hidden", "important");
    element.style.setProperty("pointer-events", "none", "important");
  }

  function forEachMatchingElement(root, selector, action) {
    const scope = root && root.querySelectorAll ? root : document;

    if (scope.nodeType === Node.ELEMENT_NODE && typeof scope.matches === "function") {
      try {
        if (scope.matches(selector)) {
          action(scope);
        }
      } catch (_) {
        // Some WebKit builds do not support every selector variant.
      }
    }

    try {
      scope.querySelectorAll(selector).forEach(action);
    } catch (_) {
      // Some WebKit builds do not support every selector variant.
    }
  }

  function stripAdsFromPlayerResponse(value, seen) {
    if (!value || typeof value !== "object") {
      return false;
    }

    if (seen.has(value)) {
      return false;
    }

    seen.add(value);
    let changed = false;

    for (const key of Object.keys(value)) {
      if (playerAdResponseKeys.has(key)) {
        try {
          delete value[key];
          changed = true;
        } catch (_) {
          // Frozen response objects are left to the DOM fallback.
        }
        continue;
      }

      if (stripAdsFromPlayerResponse(value[key], seen)) {
        changed = true;
      }
    }

    return changed;
  }

  function sanitizePlayerResponse(data, source) {
    const changed = stripAdsFromPlayerResponse(data, new Set());

    if (changed) {
      logToNative("ad: stripped player response from " + source);
    }

    return data;
  }

  // Captured before the patch below replaces the global, so the bridge's own
  // parsing never re-enters its own interception.
  const nativeJSONParse = JSON.parse;

  // `null` when the payload carried no ad scheduling, so callers can leave the
  // original body in place instead of round-tripping it through JSON.
  function strippedPlayerResponseText(text, source) {
    let data;

    try {
      data = nativeJSONParse(text);
    } catch (_) {
      return null;
    }

    if (!stripAdsFromPlayerResponse(data, new Set())) {
      return null;
    }

    logToNative("ad: stripped player response from " + source);

    try {
      return JSON.stringify(data);
    } catch (_) {
      return null;
    }
  }

  function sanitizePlayerResponseText(text, source) {
    const stripped = strippedPlayerResponseText(text, source);
    return stripped === null ? text : stripped;
  }

  function playerRequestURL(input) {
    if (typeof input === "string") {
      return input;
    }

    return input && typeof input.url === "string" ? input.url : "";
  }

  function isPlayerResponseRequest(url) {
    return url.includes("/youtubei/v1/player");
  }

  // The page parses a great deal of JSON that has nothing to do with playback.
  // These keys are what a player response always carries, and checking for them
  // is a handful of property lookups against a full recursive walk.
  const playerResponseMarkerKeys = [
    "adPlacements",
    "playerAds",
    "adSlots",
    "streamingData",
    "playabilityStatus",
    "videoDetails"
  ];

  function looksLikePlayerResponse(value) {
    if (!value || typeof value !== "object") {
      return false;
    }

    for (const key of playerResponseMarkerKeys) {
      if (key in value) {
        return true;
      }
    }

    return false;
  }

  function wrapPlayerFetchResponse(response) {
    if (!response || typeof Proxy !== "function") {
      return response;
    }

    return new Proxy(response, {
      get: function (target, property) {
        if (property === "json") {
          return function () {
            return target.json().then(function (data) {
              return sanitizePlayerResponse(data, "fetch.json");
            });
          };
        }

        if (property === "text") {
          return function () {
            return target.text().then(function (text) {
              return sanitizePlayerResponseText(text, "fetch.text");
            });
          };
        }

        if (property === "clone") {
          return function () {
            return wrapPlayerFetchResponse(target.clone());
          };
        }

        const value = target[property];
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
  }

  function installPlayerFetchPatch() {
    if (typeof window.fetch !== "function" || window.fetch.__ytproPatched === true) {
      return;
    }

    const originalFetch = window.fetch;

    function patchedFetch() {
      const requestURL = playerRequestURL(arguments[0]);
      const result = originalFetch.apply(this, arguments);

      if (!isPlayerResponseRequest(requestURL) || !result || typeof result.then !== "function") {
        return result;
      }

      // One line per player load. An ad the DOM fallback later has to catch is
      // only explicable if the response it came from was never seen here, so
      // the interception itself has to be visible, not just its hits.
      logToNative("ad: intercepting player response over fetch");

      return result.then(wrapPlayerFetchResponse);
    }

    patchedFetch.__ytproPatched = true;
    window.fetch = patchedFetch;
  }

  // The mobile player issues a large share of its `youtubei` calls through
  // `XMLHttpRequest` rather than `fetch`, so patching `fetch` alone left the
  // pre-roll scheduling of those loads intact.
  function sanitizePlayerXHR(request) {
    if (request.readyState !== 4) {
      return;
    }

    const responseType = request.responseType;

    // A parsed JSON response is created once and handed to every reader, so
    // editing it in place is enough.
    if (responseType === "json") {
      const data = request.response;

      if (data && typeof data === "object") {
        sanitizePlayerResponse(data, "xhr.json");
      }

      return;
    }

    if (responseType !== "" && responseType !== "text") {
      return;
    }

    const text = request.responseText;

    if (typeof text !== "string" || text.length === 0) {
      return;
    }

    const stripped = strippedPlayerResponseText(text, "xhr.text");

    if (stripped === null) {
      return;
    }

    // Shadowing the prototype accessors is the only way to hand the player a
    // body it never received.
    Object.defineProperty(request, "responseText", {
      configurable: true,
      get: function () {
        return stripped;
      }
    });

    Object.defineProperty(request, "response", {
      configurable: true,
      get: function () {
        return stripped;
      }
    });
  }

  function installPlayerXHRPatch() {
    const requestConstructor = window.XMLHttpRequest;

    if (typeof requestConstructor !== "function" || requestConstructor.__ytproPatched === true) {
      return;
    }

    const prototype = requestConstructor.prototype;
    const originalOpen = prototype && prototype.open;

    if (typeof originalOpen !== "function") {
      return;
    }

    prototype.open = function (method, url) {
      // A reused request still carries the accessors installed for its previous
      // response, which would hand the player a stale body.
      try {
        delete this.responseText;
        delete this.response;
      } catch (_) {
        // Nothing was shadowed on this request.
      }

      this.__ytproIsPlayerRequest = isPlayerResponseRequest(String(url == null ? "" : url));

      // Registered here rather than from `send` so the listener precedes the
      // player's own handlers: a `readystatechange` listener added first runs
      // before any `load` handler assigned after `open`, which is the only
      // ordering that lets the body be rewritten before it is read.
      if (this.__ytproListening !== true) {
        this.__ytproListening = true;

        try {
          this.addEventListener("readystatechange", function () {
            if (this.__ytproIsPlayerRequest !== true) {
              return;
            }

            try {
              sanitizePlayerXHR(this);
            } catch (_) {
              // A response the player never reads is not worth failing over.
            }
          });
        } catch (_) {
          // Some WebKit builds refuse listeners on an unsent request.
          this.__ytproListening = false;
        }
      }

      return originalOpen.apply(this, arguments);
    };

    requestConstructor.__ytproPatched = true;
  }

  function installInitialPlayerResponsePatch() {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(window, "ytInitialPlayerResponse");

      if (descriptor && descriptor.configurable === false) {
        sanitizePlayerResponse(window.ytInitialPlayerResponse, "initial-existing");
        return;
      }

      let playerResponse = sanitizePlayerResponse(
        window.ytInitialPlayerResponse,
        "initial-existing"
      );

      Object.defineProperty(window, "ytInitialPlayerResponse", {
        configurable: true,
        enumerable: true,
        get: function () {
          return playerResponse;
        },
        set: function (value) {
          playerResponse = sanitizePlayerResponse(value, "initial-assignment");
        }
      });
    } catch (_) {
      // Some YouTube builds own a sealed global; fetch remains the main path.
    }
  }

  function sanitizeKnownPlayerGlobals() {
    sanitizePlayerResponse(window.ytInitialPlayerResponse, "initial-poll");

    try {
      const args = window.ytplayer && window.ytplayer.config && window.ytplayer.config.args;

      if (args && typeof args.player_response === "string") {
        args.player_response = sanitizePlayerResponseText(
          args.player_response,
          "ytplayer.config"
        );
      }
    } catch (_) {
      // Legacy config is absent on most mobile player builds.
    }
  }

  // Whatever transport the player uses, a JSON body reaches it through
  // `JSON.parse` — and the device log showed watch loads whose response passed
  // through neither the patched `fetch` nor `XMLHttpRequest`, so the ad
  // scheduling survived every request-level patch. Parsing is the one
  // chokepoint they all share.
  function installJSONParsePatch() {
    if (typeof nativeJSONParse !== "function" || JSON.parse.__ytproPatched === true) {
      return;
    }

    function patchedParse() {
      const value = nativeJSONParse.apply(this, arguments);

      if (looksLikePlayerResponse(value)) {
        sanitizePlayerResponse(value, "json.parse");
      }

      return value;
    }

    patchedParse.__ytproPatched = true;
    JSON.parse = patchedParse;
  }

  function installPlayerResponsePatches() {
    installPlayerFetchPatch();
    installPlayerXHRPatch();
    installJSONParsePatch();
    installInitialPlayerResponsePatch();
    sanitizeKnownPlayerGlobals();
  }

  function clickSkipControls(scope) {
    for (const selector of clickableSelectors) {
      forEachMatchingElement(scope, selector, function (button) {
        button.click();
      });
    }
  }

  function firstMatchingSelector(player, selectors) {
    for (const selector of selectors) {
      try {
        if (player.querySelectorAll(selector).length > 0) {
          return selector;
        }
      } catch (_) {
        // Keep trying selector variants supported by this WebKit.
      }
    }

    return null;
  }

  function videoIsInsideAdPlayer(video) {
    let node = video;

    while (node) {
      if (typeof node.matches === "function") {
        for (const selector of seekableAdPlayerSelectors) {
          try {
            if (node.matches(selector)) {
              return true;
            }
          } catch (_) {
            // Some WebKit builds do not support every selector variant.
          }
        }
      }

      node = node.parentElement;
    }

    return false;
  }

  function shieldAdVideo(video, evidence) {
    if (shieldedAdVideo === video) {
      return;
    }

    releaseAdShield();
    shieldedAdVideo = video;
    shieldedAdMuted = video.muted === true;
    shieldedAdPlaybackRate = Number(video.playbackRate) || 1;

    try {
      video.muted = true;
      video.playbackRate = forcedAdPlaybackRate;
    } catch (_) {
      // The element may refuse the rate; muting alone is still worth having.
    }

    // The player owns these properties too and can overrule either one, so what
    // actually stuck is worth recording rather than assuming. The selector that
    // triggered the detection is what tells a real break apart from a container
    // div that is always in the DOM.
    logToNative(
      "ad: shielded, muted=" + (video.muted === true) +
      " rate=" + video.playbackRate +
      " evidence=" + evidence
    );
  }

  function releaseAdShield() {
    const video = shieldedAdVideo;

    if (!video) {
      return;
    }

    shieldedAdVideo = null;

    try {
      video.muted = shieldedAdMuted;
      video.playbackRate = shieldedAdPlaybackRate;
    } catch (_) {
      // The player may already have replaced the element.
    }
  }

  // The break is over as soon as the element leaves the ad player, which the
  // player signals by dropping the class the shield was keyed on. Walking the
  // element's own ancestors keeps this off the document-wide query path.
  function releaseAdShieldIfContentResumed() {
    if (shieldedAdVideo && (!shieldedAdVideo.isConnected || !videoIsInsideAdPlayer(shieldedAdVideo))) {
      releaseAdShield();
    }
  }

  function furthestSeekableTime(video) {
    try {
      const seekable = video.seekable;

      if (seekable && seekable.length > 0) {
        return Number(seekable.end(seekable.length - 1));
      }
    } catch (_) {
      // The element may not have a media source attached yet.
    }

    return Number.NaN;
  }

  function finishInStreamAd(player) {
    const liveEvidence = firstMatchingSelector(player, liveAdEvidenceSelectors);
    const evidence = liveEvidence || firstMatchingSelector(player, persistentAdContainerSelectors);

    if (!evidence) {
      logAdDiagnostic("no-ui-evidence", null);
      return;
    }

    let videos = [];

    try {
      videos = Array.from(player.querySelectorAll("video"));
    } catch (_) {
      return;
    }

    // Preview/content elements may coexist with the ad media. Only the active
    // element is shielded and advanced.
    const video = videos.find(function (candidate) {
      return !candidate.paused && !candidate.ended;
    });

    if (!video) {
      if (!videos.some(function (candidate) { return candidate.ended; })) {
        logAdDiagnostic("no-playing-video", videos[0] || null);
      }
      return;
    }

    const duration = Number(video.duration);
    const currentTime = Number(video.currentTime);

    // NaN or zero is metadata that has not arrived yet — the very start of a
    // break, and still eligible. An unbounded stream is never a break.
    //
    // Length only matters when the detection is weak. The ad's own countdown
    // or skip control being on screen settles the question by itself, and a
    // 300-second ad refused for being too long is exactly what played through
    // in full before this distinction existed.
    const durationIsPending = Number.isNaN(duration) || duration <= 0;
    const lengthIsPlausible = liveEvidence !== null ||
      duration <= maximumForcedAdDurationSeconds;
    const durationRulesOutAnAd = !durationIsPending &&
      !(Number.isFinite(duration) && lengthIsPlausible);

    if (durationRulesOutAnAd) {
      releaseAdShield();
      logAdDiagnostic("duration-not-an-ad:" + evidence, video);
      return;
    }

    // Applied before the seek is even attempted: a duration that is still
    // pending is the very start of the break, which is exactly when a refused
    // seek would otherwise let the ad play out loud.
    shieldAdVideo(video, evidence);


    if (durationIsPending) {
      // A break whose metadata has not landed still has a buffered range, and
      // its end is where the ad stops. Using it here is what removes the poll
      // cycle the ad used to be visible for. The same length guard applies, so
      // content the player mislabelled is never skipped wholesale.
      const seekableEnd = furthestSeekableTime(video);

      if (Number.isFinite(seekableEnd) && seekableEnd > 0 &&
        seekableEnd <= maximumForcedAdDurationSeconds &&
        seekableEnd - Number(video.currentTime) > 0.1) {
        try {
          video.currentTime = seekableEnd;
          logToNative("ad: advanced to the buffered end at " + Math.round(seekableEnd * 10) / 10 + "s");
          return;
        } catch (_) {
          // Fall through to the diagnostic; the next poll retries.
        }
      }

      logAdDiagnostic("duration-unavailable", video);
      return;
    }

    if (!Number.isFinite(currentTime) || currentTime < 0) {
      logAdDiagnostic("clock-unavailable", video);
      return;
    }

    if (duration - currentTime <= 0.1) {
      return;
    }

    try {
      video.currentTime = duration;
      logToNative(
        "ad: advanced in-stream media from " + Math.round(currentTime * 10) / 10 +
        "s to " + Math.round(duration * 10) / 10 + "s"
      );
    } catch (_) {
      logAdDiagnostic("seek-rejected", video);
    }
  }

  function finishInStreamAds(root) {
    // Ending an ad can emit `ended` on the shared media element before YouTube
    // switches it to content. Doing that while backgrounded would clear the
    // lifecycle bridge's playback intent, so forced seeking is foreground-only.
    if (!appIsActive) {
      return;
    }

    const scope = root && root.querySelectorAll ? root : document;
    const players = new Set();

    releaseAdShieldIfContentResumed();

    for (const selector of seekableAdPlayerSelectors) {
      forEachMatchingElement(scope, selector, function (player) {
        players.add(player);
      });
    }

    for (const player of players) {
      finishInStreamAd(player);
    }
  }

  function cleanAds(root) {
    const scope = root && root.querySelectorAll ? root : document;

    for (const selector of blockedSelectors) {
      forEachMatchingElement(scope, selector, hideElement);
    }

    clickSkipControls(scope);
    finishInStreamAds(scope);
  }

  function trackedVideos() {
    const videos = [];

    for (const video of observedVideos) {
      if (!video.isConnected) {
        observedVideos.delete(video);
        continue;
      }

      videos.push(video);
    }

    return videos;
  }

  // A watch page keeps preview players around, so lifecycle work must target a
  // single element instead of every tracked video.
  function pickActiveVideo() {
    const videos = trackedVideos();

    for (const video of videos) {
      if (!video.paused && !video.ended) {
        return video;
      }
    }

    if (activeVideo && activeVideo.isConnected) {
      return activeVideo;
    }

    for (const video of videos) {
      if (video.currentTime > 0 && !video.ended) {
        return video;
      }
    }

    return videos.length > 0 ? videos[0] : null;
  }

  function nativePresentationModeOf(video) {
    if (document.pictureInPictureElement === video) {
      return PICTURE_IN_PICTURE;
    }

    const mode = video.webkitPresentationMode;

    if (mode === PICTURE_IN_PICTURE || mode === FULLSCREEN) {
      return mode;
    }

    if (video.webkitDisplayingFullscreen === true) {
      return FULLSCREEN;
    }

    const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;

    if (
      fullscreenElement &&
      (fullscreenElement === video ||
        (typeof fullscreenElement.contains === "function" && fullscreenElement.contains(video)))
    ) {
      return FULLSCREEN;
    }

    return null;
  }

  function coversViewport(video) {
    if (typeof video.getBoundingClientRect !== "function") {
      return false;
    }

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    if (!viewportWidth || !viewportHeight) {
      return false;
    }

    const rect = video.getBoundingClientRect();

    return rect.width >= viewportWidth * 0.92 && rect.height >= viewportHeight * 0.82;
  }

  function isPageFullscreen(video) {
    for (const selector of fullscreenMarkerSelectors) {
      try {
        if (typeof document.querySelector === "function" && document.querySelector(selector)) {
          return true;
        }
      } catch (_) {
        // Some WebKit builds do not support every selector variant.
      }
    }

    return coversViewport(video);
  }

  function presentationModeOf(video) {
    if (!video) {
      return INLINE;
    }

    return nativePresentationModeOf(video) || (isPageFullscreen(video) ? FULLSCREEN : INLINE);
  }

  // Everything about the element that matters when background playback
  // misbehaves, in one line for the native log.
  function describeVideo(video) {
    if (!video) {
      return "video=none";
    }

    return "mode=" + presentationModeOf(video) +
      " native=" + (nativePresentationModeOf(video) || INLINE) +
      " paused=" + video.paused +
      " ended=" + video.ended +
      " ready=" + video.readyState +
      // A clock that advances while this stands still is a frozen picture over
      // live audio — the shape a throttled media process leaves behind.
      " frames=" + decodedFrameCount(video) +
      " t=" + Math.round(video.currentTime || 0);
  }

  // Why the floating window is or is not available for this element. Every
  // field here is a precondition WebKit checks before it will hand a video to
  // Picture in Picture, so a line of this is usually enough to tell a refusal
  // apart from a request that was never made.
  function describePictureInPictureReadiness(video) {
    if (!video) {
      return "video=none";
    }

    let supported = "unknown";

    try {
      if (typeof video.webkitSupportsPresentationMode === "function") {
        supported = String(video.webkitSupportsPresentationMode(PICTURE_IN_PICTURE));
      }
    } catch (_) {
      supported = "threw";
    }

    return "pipSupported=" + supported +
      " pipEnabled=" + (document.pictureInPictureEnabled === true) +
      " pipDisabled=" + (video.disablePictureInPicture === true) +
      " hasSetter=" + (typeof video.webkitSetPresentationMode === "function") +
      // A stream WebKit sees as audio only has no picture to float.
      " size=" + (video.videoWidth || 0) + "x" + (video.videoHeight || 0) +
      " pageFullscreen=" + isPageFullscreen(video) +
      " " + describeVideo(video);
  }

  function allowPictureInPicture(video) {
    try {
      video.removeAttribute("disablepictureinpicture");
      video.disablePictureInPicture = false;
    } catch (_) {
      // The player may expose a read-only element.
    }
  }

  function setPresentationMode(video, mode) {
    try {
      if (mode === INLINE && document.pictureInPictureElement === video &&
        typeof document.exitPictureInPicture === "function") {
        ignoreRejection(document.exitPictureInPicture());
        return;
      }

      if (typeof video.webkitSetPresentationMode === "function") {
        video.webkitSetPresentationMode(mode);
      }
    } catch (_) {
      // WebKit refuses the transition while another one is still running.
    }
  }

  // WebKit never enters the floating window on its own from inline playback:
  // `HTMLMediaElement::shouldOverrideBackgroundPlaybackRestriction` keeps video
  // decoding alive across the background transition only for an element that is
  // *already* in Picture in Picture, and no automatic-from-inline path exists
  // for web video at all. Inline playback therefore has to ask, or it degrades
  // to audio the moment the app leaves the screen.
  //
  // The request is callable without a user gesture only because the web view
  // sets `mediaTypesRequiringUserActionForPlayback` to none, which is what
  // makes WebKit drop its `RequireUserGestureForFullscreen` restriction on iOS.
  function requestPictureInPicture(video) {
    const nativeMode = nativePresentationModeOf(video);

    if (nativeMode === PICTURE_IN_PICTURE) {
      return;
    }

    // AVKit performs this handover itself out of a native fullscreen
    // presentation. A request placed into that teardown is both dropped and
    // destructive — it hides the player view and leaves the media layer
    // detached, which is the black picture over live audio seen before.
    if (nativeMode === FULLSCREEN) {
      logToNative("pip: leaving the fullscreen handover to WebKit");
      return;
    }

    if (Date.now() - lastPresentationChangeAt < presentationSettleMilliseconds) {
      logToNative("pip: skipped, a presentation change is still settling");
      return;
    }

    if (typeof video.webkitSetPresentationMode !== "function") {
      logToNative("pip: skipped, the element has no presentation mode setter");
      return;
    }

    try {
      if (typeof video.webkitSupportsPresentationMode === "function" &&
        video.webkitSupportsPresentationMode(PICTURE_IN_PICTURE) !== true) {
        logToNative("pip: refused by the element, " + describePictureInPictureReadiness(video));
        return;
      }
    } catch (_) {
      // An element that cannot answer the question is still worth asking.
    }

    try {
      video.webkitSetPresentationMode(PICTURE_IN_PICTURE);
      bridgeOpenedPictureInPicture = true;
      logToNative("pip: requested, " + describePictureInPictureReadiness(video));
    } catch (error) {
      logToNative("pip: request threw " + ((error && error.message) || "unknown"));
    }
  }

  // Leaving the floating window always returns the element inline.
  //
  // Restoring WebKit's native fullscreen was tried and is what left the player
  // black with a dead fullscreen button: entering the floating window tears the
  // fullscreen presentation down — `AVPlayerViewController` logs
  // `exitFullScreenAnimated ... Invalid call` as it happens — so asking for it
  // again on the way back fights a teardown that is still in flight. There is
  // nothing to restore. A page-driven fullscreen layout needs no restoring
  // either: it survives the trip untouched and only wants the element back.
  function restorePresentationMode() {
    return INLINE;
  }

  function cancelBackgroundHold() {
    if (backgroundHoldTimer) {
      window.clearTimeout(backgroundHoldTimer);
      backgroundHoldTimer = 0;
    }
  }

  function closeBackgroundHoldWindow() {
    backgroundHoldWindowOpen = false;
    backgroundHoldWindowToken += 1;
    cancelBackgroundHold();
  }

  function openBackgroundHoldWindow() {
    backgroundHoldWindowOpen = true;
    const windowToken = ++backgroundHoldWindowToken;

    window.setTimeout(function () {
      if (windowToken !== backgroundHoldWindowToken) {
        return;
      }

      closeBackgroundHoldWindow();
    }, backgroundHoldWindowMilliseconds);
  }

  // WebKit pauses backgrounded media as part of its own suspension, so the
  // element is asked to resume for as long as that pause can still be the
  // transition rather than the user.
  function holdBackgroundPlayback() {
    cancelBackgroundHold();

    if (appIsActive || !backgroundPlaybackIntended || !backgroundHoldWindowOpen) {
      return;
    }

    const video = activeVideo;

    if (!video || !video.isConnected || video.ended) {
      return;
    }

    if (video.paused) {
      logToNative("hold: resuming suspended video");
      ignoreRejection(video.play());
    }

    // Throttled to roughly a second: the interesting question in the background
    // is whether the frame count is still moving, and answering it four times a
    // second would bury every other line.
    const now = Date.now();

    if (now - lastBackgroundHoldReportAt >= backgroundHoldReportIntervalMilliseconds) {
      lastBackgroundHoldReportAt = now;
      logToNative("hold: " + describeVideo(video));
    }

    // Nothing else is done here. The bridge must not ask for Picture in
    // Picture while the app resigns: a request made out of a live native
    // fullscreen presentation makes `AVPlayerViewController` fight its own
    // teardown (`exitFullScreenAnimated ... Invalid call`), which detaches the
    // media layer and leaves the element flapping between inline and the
    // floating window — black video over live audio once the app is back.
    // WebKit performs the fullscreen→Picture in Picture handover itself on the
    // home gesture; the bridge only keeps the audio alive here and hands the
    // window back to inline on the way in.

    backgroundHoldTimer = window.setTimeout(
      holdBackgroundPlayback,
      backgroundHoldIntervalMilliseconds
    );
  }

  // Called from willResignActive: the last moment at which WebKit still
  // accepts a Picture in Picture handover.
  function prepareForBackground() {
    appIsActive = false;
    foregroundRestoreToken += 1;
    foregroundRestoreInProgress = false;
    closeBackgroundHoldWindow();

    // Forced seeking stops at the edge of the foreground, so nothing would be
    // left to notice the break ending. A couple of seconds of ad audio is a far
    // smaller cost than content resuming muted at sixteen times its speed.
    releaseAdShield();

    const video = pickActiveVideo();
    activeVideo = video;

    // WebKit may already have suspended the media session before this call was
    // delivered. A pause that landed a moment ago with no gesture behind it is
    // that suspension, not the user, so the trip still counts as playing and
    // the element is started again below.
    const suspendedByTransition = pausedByBackgroundTransition(video);

    backgroundPlaybackIntended = Boolean(video) && !video.ended &&
      (!video.paused || suspendedByTransition);

    // The presentation the user actually left is what the trip is handed over
    // from. A floating window the user opened keeps being reported as such, so
    // on the way back it is left under their control rather than closed.
    backgroundPresentationMode = backgroundPlaybackIntended ? presentationModeOf(video) : INLINE;
    backgroundTransitionAt = Date.now();
    repaintAttempts = 0;

    logToNative(
      "prepareForBackground: intended=" + backgroundPlaybackIntended +
      " mode=" + backgroundPresentationMode +
      " lateSuspend=" + suspendedByTransition +
      ", " + describeVideo(video)
    );

    // The decisive moment for the floating window: WebKit only performs the
    // handover itself out of its own native fullscreen presentation, and the
    // mobile player drives a page fullscreen layout instead. This line records
    // which of the two the element was actually in.
    logToNative("pip readiness: " + describePictureInPictureReadiness(video));

    if (!backgroundPlaybackIntended) {
      reportPlaybackState();
      return;
    }

    // The transition starts here, not at didEnterBackground. WebKit suspends
    // the media session while the app is still only resigning active, and that
    // pause reached `handlePause` before the window had opened — so the bridge
    // read its own transition as the user pressing pause and abandoned the
    // whole trip. Locking the screen hits this every time.
    openBackgroundHoldWindow();

    if (suspendedByTransition) {
      ignoreRejection(video.play());
    }

    // A native fullscreen presentation is handed to the floating window by
    // AVKit itself, and a request placed into that teardown is dropped and
    // destructive. Every other presentation — inline, or a page-driven
    // fullscreen layout WebKit knows nothing about — gets nothing from WebKit
    // and has to ask, or the trip degrades to audio over a frozen picture.
    requestPictureInPicture(video);

    reportPlaybackState();
  }

  function didEnterBackground() {
    appIsActive = false;

    logToNative("didEnterBackground: intended=" + backgroundPlaybackIntended +
      ", " + describePictureInPictureReadiness(activeVideo));

    if (!backgroundPlaybackIntended) {
      return;
    }

    openBackgroundHoldWindow();
    holdBackgroundPlayback();
  }

  // Called from willEnterForeground, early enough to stop fighting WebKit
  // before it restores its own media state.
  function prepareForForeground() {
    appIsActive = true;
    closeBackgroundHoldWindow();
  }

  function finishForegroundRestore(restoreToken) {
    if (restoreToken !== foregroundRestoreToken) {
      return;
    }

    foregroundRestoreInProgress = false;
    reportPlaybackState();
  }

  function decodedFrameCount(video) {
    try {
      if (typeof video.getVideoPlaybackQuality === "function") {
        const quality = video.getVideoPlaybackQuality();

        if (quality && typeof quality.totalVideoFrames === "number") {
          return quality.totalVideoFrames;
        }
      }
    } catch (_) {
      // Not every WebKit build exposes playback quality.
    }

    return typeof video.webkitDecodedFrameCount === "number" ? video.webkitDecodedFrameCount : -1;
  }

  function repaintVideo(video) {
    try {
      const inlineDisplay = video.style.display;
      const inlineTransform = video.style.transform;

      video.style.setProperty("display", "none", "important");
      // A fresh compositing layer is the part of the fix that actually makes
      // WebKit hand the element a new rendering surface.
      video.style.setProperty("transform", "translateZ(0)", "important");
      void video.offsetHeight;

      if (inlineDisplay) {
        video.style.setProperty("display", inlineDisplay);
      } else {
        video.style.removeProperty("display");
      }

      if (inlineTransform) {
        video.style.setProperty("transform", inlineTransform);
      } else {
        video.style.removeProperty("transform");
      }

      void video.offsetHeight;
    } catch (_) {
      // The element may already have been replaced by the player.
    }
  }

  // A media layer that was detached while the app was suspended keeps feeding
  // audio without ever painting again. Comparing decoded frames against the
  // playback clock detects exactly that, and a forced layout hands the element
  // a fresh rendering surface.
  //
  // A forced layout is as far as this goes. Reloading the element was tried as
  // a last resort and was worse than the symptom: `load()` throws away the
  // MediaSource that YouTube's player is feeding, and the player cannot rebuild
  // it, so the black surface became permanent and playback stopped for good.
  function probeRendering(video, restoreToken) {
    if (restoreToken !== foregroundRestoreToken) {
      return;
    }

    if (!video.isConnected || video.paused || video.ended || repaintAttempts >= repaintAttemptLimit) {
      finishForegroundRestore(restoreToken);
      return;
    }

    // Leaving the floating window after a fullscreen hand-out is the transition
    // WebKit lands with a detached media layer: the element keeps decoding and
    // feeding audio but never paints, so the stall check below never sees the
    // frame count stall and would let the black surface stand. One forced
    // layout up front hands it a fresh rendering surface before the check
    // decides anything.
    if (pendingForegroundRepaint) {
      pendingForegroundRepaint = false;
      repaintAttempts += 1;
      logToNative("repaint after fullscreen hand-out");
      repaintVideo(video);

      if (repaintAttempts >= repaintAttemptLimit) {
        finishForegroundRestore(restoreToken);
        return;
      }
    }

    const framesBefore = decodedFrameCount(video);

    if (framesBefore < 0) {
      finishForegroundRestore(restoreToken);
      return;
    }

    const clockBefore = video.currentTime;

    window.setTimeout(function () {
      if (restoreToken !== foregroundRestoreToken) {
        return;
      }

      const clockAdvanced = video.currentTime > clockBefore + renderProbeClockDeltaSeconds;
      const framesAdvanced = decodedFrameCount(video) > framesBefore;

      if (!clockAdvanced || framesAdvanced) {
        finishForegroundRestore(restoreToken);
        return;
      }

      repaintAttempts += 1;
      logToNative("render stalled, repaint attempt " + repaintAttempts);
      repaintVideo(video);

      if (repaintAttempts >= repaintAttemptLimit) {
        logToNative("render still stalled, leaving the element to the player");
        finishForegroundRestore(restoreToken);
        return;
      }

      probeRendering(video, restoreToken);
    }, renderProbeIntervalMilliseconds);
  }

  function resumeAfterForeground(video, restoreToken) {
    if (restoreToken !== foregroundRestoreToken) {
      return;
    }

    if (backgroundPlaybackIntended && video.paused && !video.ended) {
      ignoreRejection(video.play());
    }

    backgroundPlaybackIntended = false;

    watchPresentationDrift(video, restoreToken, 0);

    window.setTimeout(function () {
      probeRendering(video, restoreToken);
    }, renderProbeIntervalMilliseconds);
  }

  // Page-driven fullscreen layouts are the player's own coherent state and are
  // left alone; only native presentations the player knows nothing about are
  // corrected. A gesture in progress means the change is the user's doing.
  function watchPresentationDrift(video, restoreToken, index) {
    if (
      restoreToken !== foregroundRestoreToken ||
      index >= presentationDriftCheckDelaysMilliseconds.length
    ) {
      return;
    }

    window.setTimeout(function () {
      if (restoreToken !== foregroundRestoreToken) {
        return;
      }

      const nativeMode = nativePresentationModeOf(video);

      if (
        (nativeMode === FULLSCREEN || nativeMode === PICTURE_IN_PICTURE) &&
        !recentUserGesture()
      ) {
        const wasPlaying = !video.paused && !video.ended;

        logToNative(
          "presentation drifted to " + nativeMode + ", restoring " + INLINE
        );
        setPresentationMode(video, INLINE);

        if (wasPlaying) {
          ignoreRejection(video.play());
          window.setTimeout(function () {
            if (restoreToken === foregroundRestoreToken && video.paused && !video.ended) {
              ignoreRejection(video.play());
            }
          }, driftResumeRetryDelayMilliseconds);
        }
      }

      watchPresentationDrift(video, restoreToken, index + 1);
    }, presentationDriftCheckDelaysMilliseconds[index]);
  }

  function waitForPresentation(video, targetMode, restoreToken, attempt) {
    if (restoreToken !== foregroundRestoreToken) {
      return;
    }

    const mode = presentationModeOf(video);

    if (mode !== PICTURE_IN_PICTURE || attempt >= inlineRestorePollLimit) {
      if (mode === PICTURE_IN_PICTURE) {
        // Still stuck in the floating window: force the target presentation so
        // the player state and the actual mode cannot diverge.
        setPresentationMode(video, targetMode);
      }

      resumeAfterForeground(video, restoreToken);
      return;
    }

    window.setTimeout(function () {
      waitForPresentation(video, targetMode, restoreToken, attempt + 1);
    }, inlineRestorePollIntervalMilliseconds);
  }

  // Called once per background trip from didBecomeActive. Every step is guarded
  // by a token because overlapping presentation changes are what leaves WebKit
  // with a detached media layer and a fullscreen button that no longer reacts.
  function recoverAfterForeground() {
    appIsActive = true;
    closeBackgroundHoldWindow();

    if (foregroundRestoreInProgress) {
      return;
    }

    const restoreToken = ++foregroundRestoreToken;
    foregroundRestoreInProgress = true;
    repaintAttempts = 0;
    pendingForegroundRepaint = false;

    const video = pickActiveVideo();
    activeVideo = video;

    if (!video) {
      backgroundPlaybackIntended = false;
      finishForegroundRestore(restoreToken);
      return;
    }

    // Fullscreen video backgrounded by the home gesture is handed into the
    // floating window by WebKit itself, so the bridge never asked for that
    // window; gating on ownership skipped the exit entirely and returned to an
    // element whose inline layer was gone — audio kept playing over a black
    // surface.
    //
    // What separates the two cases is where the window came from. One that
    // arrived while the video was in fullscreen, and one the bridge opened for
    // the trip, both come back so the inline player can render again. A window
    // the user opened for themselves is theirs and stays theirs.
    const leavingPictureInPicture =
      presentationModeOf(video) === PICTURE_IN_PICTURE;
    const targetMode = restorePresentationMode();
    const windowIsAHandoff = leavingPictureInPicture &&
      (backgroundPresentationMode === FULLSCREEN || bridgeOpenedPictureInPicture);

    bridgeOpenedPictureInPicture = false;

    logToNative(
      "recoverAfterForeground: leavingPiP=" + leavingPictureInPicture +
      " handoff=" + windowIsAHandoff + " target=" + targetMode +
      ", " + describeVideo(video)
    );


    if (!leavingPictureInPicture) {
      // Not in a floating window at all: revive playback and watch for the
      // detached surface.
      resumeAfterForeground(video, restoreToken);
      return;
    }

    if (!windowIsAHandoff) {
      // The user's own floating window. Forcing it back inline is not the
      // bridge's place, but the app's suspension paused the element, so
      // playback is revived and the window is left under the user's control.
      // The presentation is deliberately not touched here.
      if (backgroundPlaybackIntended && video.paused && !video.ended) {
        ignoreRejection(video.play());
      }
      backgroundPlaybackIntended = false;
      finishForegroundRestore(restoreToken);
      return;
    }

    setPresentationMode(video, targetMode);
    pendingForegroundRepaint = true;
    waitForPresentation(video, targetMode, restoreToken, 0);
  }

  // A banner, Control Center or the app switcher deactivates the app without
  // ever backgrounding it, so the handover has to be rolled back.
  function cancelBackgroundPreparation() {
    appIsActive = true;
    closeBackgroundHoldWindow();

    backgroundPlaybackIntended = false;

    // A window the bridge opened for a trip that never happened is the bridge's
    // to close. One the user or WebKit opened is left exactly as it is.
    if (bridgeOpenedPictureInPicture) {
      bridgeOpenedPictureInPicture = false;

      const video = activeVideo;

      if (video && presentationModeOf(video) === PICTURE_IN_PICTURE) {
        logToNative("pip: closing the window opened for a cancelled trip");
        setPresentationMode(video, INLINE);
      }
    }

    reportPlaybackState();
  }

  function installLifecycleBridge() {
    window.__ytproPrepareForBackground = prepareForBackground;
    window.__ytproDidEnterBackground = didEnterBackground;
    window.__ytproHoldPlayback = holdBackgroundPlayback;
    window.__ytproPrepareForForeground = prepareForForeground;
    window.__ytproRecoverAfterForeground = recoverAfterForeground;
    window.__ytproCancelBackgroundPreparation = cancelBackgroundPreparation;
  }

  function installVisibilityPatch() {
    try {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: function () {
          return false;
        }
      });

      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: function () {
          return "visible";
        }
      });
    } catch (_) {
      // The page may have sealed the descriptors first.
    }
  }

  function handlePause(video) {
    if (video !== activeVideo) {
      return;
    }

    lastPauseAt = Date.now();

    if (appIsActive) {
      // Leaving the floating window pauses the element on the way back in;
      // that is the restore, not the user.
      if (!foregroundRestoreInProgress) {
        backgroundPlaybackIntended = false;
      }

      reportPlaybackState();
      return;
    }

    if (!backgroundPlaybackIntended) {
      return;
    }

    // Outside the transition window, and inside the floating window where the
    // user has real controls, a pause belongs to the user. The floating window
    // is exempt during the handover itself: its controls are system UI and
    // leave no gesture behind, so time is the only thing separating WebKit's
    // suspension from a real tap.
    const withinTransition =
      Date.now() - backgroundTransitionAt <= backgroundTransitionGraceMilliseconds;
    const userOwnsTheControls =
      presentationModeOf(video) === PICTURE_IN_PICTURE && !withinTransition;

    if (!backgroundHoldWindowOpen || userOwnsTheControls) {
      backgroundPlaybackIntended = false;
      closeBackgroundHoldWindow();
      return;
    }

    holdBackgroundPlayback();
  }

  function handlePresentationModeChange(video) {
    if (video !== activeVideo) {
      return;
    }

    lastPresentationChangeAt = Date.now();
    logToNative("presentation changed: " + describePictureInPictureReadiness(video));
    reportPlaybackState();
  }

  function observeVideo(video) {
    if (observedVideos.has(video)) {
      return;
    }

    observedVideos.add(video);
    video.dataset.ytproObserved = "1";
    allowPictureInPicture(video);

    video.addEventListener("play", function () {
      activeVideo = video;
    }, { passive: true });

    video.addEventListener("playing", function () {
      activeVideo = video;
      lastPlayingObservedAt = Date.now();

      // Once per element, so the floating window's preconditions can be read
      // off the log without having to background the app first.
      if (video.dataset.ytproPipLogged !== "1") {
        video.dataset.ytproPipLogged = "1";
        logToNative("pip readiness on play: " + describePictureInPictureReadiness(video));
      }

      reportPlaybackState();
    }, { passive: true });

    video.addEventListener("pause", function () {
      if (video === activeVideo) {
        logToNative(
          "pause event: appIsActive=" + appIsActive +
          " intended=" + backgroundPlaybackIntended +
          " holdWindow=" + backgroundHoldWindowOpen +
          ", " + describeVideo(video)
        );
      }

      handlePause(video);
    }, { passive: true });

    video.addEventListener("ended", function () {
      if (video !== activeVideo) {
        return;
      }

      backgroundPlaybackIntended = false;
      closeBackgroundHoldWindow();
    }, { passive: true });

    video.addEventListener("webkitpresentationmodechanged", function () {
      handlePresentationModeChange(video);
    }, { passive: true });

    video.addEventListener("enterpictureinpicture", function () {
      handlePresentationModeChange(video);
    }, { passive: true });

    video.addEventListener("leavepictureinpicture", function () {
      handlePresentationModeChange(video);
    }, { passive: true });
  }

  function installMediaListeners(root) {
    const scope = root && root.querySelectorAll ? root : document;

    try {
      if (scope.nodeType === Node.ELEMENT_NODE && scope.tagName === "VIDEO") {
        observeVideo(scope);
      }

      scope.querySelectorAll("video").forEach(observeVideo);
    } catch (_) {
      // Some WebKit builds do not support every selector variant.
    }
  }

  function scanRoot(root) {
    cleanAds(root);
    installMediaListeners(root);
  }

  function scanDocument() {
    scanRoot(document);

    const video = pickActiveVideo();

    if (video) {
      activeVideo = video;
    }
  }

  function compactPendingRoots() {
    return Array.from(pendingRoots).filter(function (root) {
      if (!root.isConnected) {
        return false;
      }

      // Scanning an added ancestor already covers every queued descendant.
      let ancestor = root.parentElement;

      while (ancestor) {
        if (pendingRoots.has(ancestor)) {
          return false;
        }

        ancestor = ancestor.parentElement;
      }

      return true;
    });
  }

  function flushIncrementalScan() {
    incrementalScanScheduled = false;
    const roots = compactPendingRoots();
    pendingRoots.clear();

    for (const root of roots) {
      scanRoot(root);
    }
  }

  function scheduleIncrementalScan(root) {
    pendingRoots.add(root);

    if (incrementalScanScheduled) {
      return;
    }

    incrementalScanScheduled = true;
    window.setTimeout(flushIncrementalScan, 0);
  }

  // Install before DOM readiness so YouTube never receives ad scheduling data
  // for the initial player or later SPA navigations.
  installPlayerResponsePatches();
  installLifecycleBridge();
  installVisibilityPatch();

  const observer = new MutationObserver(function (mutations) {
    for (const mutation of mutations) {
      // YouTube commonly reuses a player and reveals the ad only by toggling
      // its class. Without attribute observation the pre-roll is missed until
      // the slow fallback scan.
      if (mutation.type === "attributes") {
        const target = mutation.target;

        if (target && target.nodeType === Node.ELEMENT_NODE) {
          scheduleIncrementalScan(target);
        }

        continue;
      }

      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          scheduleIncrementalScan(node);
        }
      }
    }
  });

  const adSkipPollIntervalMilliseconds = 250;

  // The fast poll retries ads whose duration is still NaN during the first
  // mutation callback and handles skip controls created without a usable
  // mutation record.
  function clickAdSkipButtons() {
    sanitizeKnownPlayerGlobals();

    if (appIsActive && !document.querySelector("video")) {
      return;
    }

    clickSkipControls(document);
    finishInStreamAds(document);
  }

  function start() {
    scanDocument();

    for (const type of userGestureEventTypes) {
      document.addEventListener(type, noteUserGesture, { capture: true, passive: true });
    }

    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
      attributeFilter: ["class", "style", "id", "layout"]
    });
    window.setInterval(scanDocument, fallbackScanIntervalMilliseconds);
    window.setInterval(clickAdSkipButtons, adSkipPollIntervalMilliseconds);
    window.setInterval(syncPlaybackState, playbackSyncIntervalMilliseconds);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();

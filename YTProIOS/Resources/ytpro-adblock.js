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
    ".ytp-skip-ad-button"
  ];

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

  // Child-list mutations are handled incrementally. This slower full scan is a
  // recovery path for selector changes caused only by class/attribute updates.
  const fallbackScanIntervalMilliseconds = 5000;

  // Only the sliver between willResignActive and the actual suspension is left
  // to hand playback over, so a dropped request is retried immediately — and
  // kept being retried from the background hold below.
  const pictureInPictureRetryDelaysMilliseconds = [60, 200, 500, 1200];

  // A locked screen cannot present the floating window at all, and WebKit
  // answers every request with the same silent refusal. Past this many attempts
  // the retries stop being a recovery and become the fault: the background hold
  // repeated the request every 250ms for its whole 15 second window, and ~60
  // presentation changes in a row left the element unable to play at all.
  // Giving up keeps the audio, which is the most a locked screen can offer.
  const pictureInPictureAttemptLimit = 6;

  // How long a pause is still attributed to the background transition instead
  // of to the user. WebKit may freeze the media process well past the actual
  // suspension, so the window has to outlast the native ping schedule.
  const backgroundHoldWindowMilliseconds = 15000;
  const backgroundHoldIntervalMilliseconds = 250;

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

  // Only a handover this bridge performed itself may be undone; a floating
  // window the user opened stays under their control.
  let pictureInPictureOwnedByBridge = false;

  // Ownership is claimed when WebKit confirms the mode actually changed, not
  // when the request was merely issued: `webkitSetPresentationMode` returns
  // nothing and refuses silently, so a request that never landed used to leave
  // the bridge convinced it owned a window that was not there.
  let pictureInPictureRequested = false;
  let pictureInPictureAttempts = 0;

  let foregroundRestoreToken = 0;
  let foregroundRestoreInProgress = false;
  let repaintAttempts = 0;

  let lastUserGestureAt = 0;
  let lastPauseAt = 0;
  let backgroundTransitionAt = 0;

  // Refreshed by the playback poll, so it stays within a second of the truth
  // however long the video has been running.
  let lastPlayingObservedAt = 0;

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

  function cleanAds(root) {
    const scope = root && root.querySelectorAll ? root : document;

    for (const selector of blockedSelectors) {
      forEachMatchingElement(scope, selector, hideElement);
    }

    for (const selector of clickableSelectors) {
      forEachMatchingElement(scope, selector, function (button) {
        button.click();
      });
    }
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
      " t=" + Math.round(video.currentTime || 0);
  }

  function allowPictureInPicture(video) {
    try {
      video.removeAttribute("disablepictureinpicture");
      video.disablePictureInPicture = false;
    } catch (_) {
      // The player may expose a read-only element.
    }
  }

  function enterPictureInPicture(video) {
    allowPictureInPicture(video);

    try {
      if (typeof video.webkitSetPresentationMode === "function") {
        video.webkitSetPresentationMode(PICTURE_IN_PICTURE);
        return true;
      }

      if (typeof video.requestPictureInPicture === "function") {
        ignoreRejection(video.requestPictureInPicture());
        return true;
      }
    } catch (_) {
      // WebKit refuses the transition while another one is still running.
    }

    return false;
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

    // A Picture in Picture request that WebKit dropped during the transition is
    // retried for as long as the background hold keeps the process alive. A
    // retry out of native fullscreen repeats the collision described in
    // `prepareForBackground`, so the element is collapsed first there too.
    if (
      backgroundPresentationMode === FULLSCREEN &&
      presentationModeOf(video) !== PICTURE_IN_PICTURE
    ) {
      if (nativePresentationModeOf(video) === FULLSCREEN) {
        setPresentationMode(video, INLINE);
      }

      requestPictureInPicture(video, 0);
    }

    backgroundHoldTimer = window.setTimeout(
      holdBackgroundPlayback,
      backgroundHoldIntervalMilliseconds
    );
  }

  function requestPictureInPicture(video, attempt) {
    if (appIsActive || !backgroundPlaybackIntended) {
      return;
    }

    if (presentationModeOf(video) === PICTURE_IN_PICTURE) {
      if (pictureInPictureRequested) {
        pictureInPictureOwnedByBridge = true;
      }

      return;
    }

    if (pictureInPictureAttempts >= pictureInPictureAttemptLimit) {
      if (pictureInPictureRequested) {
        pictureInPictureRequested = false;
        logToNative("picture-in-picture unavailable after " + pictureInPictureAttempts +
          " attempts, keeping audio only");
      }

      return;
    }

    pictureInPictureAttempts += 1;
    pictureInPictureRequested = true;

    logToNative(
      "picture-in-picture " + (enterPictureInPicture(video) ? "requested" : "rejected") +
      " (attempt " + pictureInPictureAttempts + "), " + describeVideo(video)
    );

    if (attempt >= pictureInPictureRetryDelaysMilliseconds.length) {
      return;
    }

    window.setTimeout(function () {
      requestPictureInPicture(video, attempt + 1);
    }, pictureInPictureRetryDelaysMilliseconds[attempt]);
  }

  // Called from willResignActive: the last moment at which WebKit still
  // accepts a Picture in Picture handover.
  function prepareForBackground() {
    appIsActive = false;
    foregroundRestoreToken += 1;
    foregroundRestoreInProgress = false;
    closeBackgroundHoldWindow();

    const video = pickActiveVideo();
    activeVideo = video;

    // WebKit may already have suspended the media session before this call was
    // delivered. A pause that landed a moment ago with no gesture behind it is
    // that suspension, not the user, so the trip still counts as playing and
    // the element is started again below.
    const suspendedByTransition = pausedByBackgroundTransition(video);

    backgroundPlaybackIntended = Boolean(video) && !video.ended &&
      (!video.paused || suspendedByTransition);

    // Ownership carries over while the element is still in the floating window
    // this bridge opened. A locking device sends a spurious activation that
    // cancels the trip mid-rollback, and dropping ownership there orphaned the
    // window: nothing closed it on the way back, so the inline player stayed
    // black while the picture kept going to the floating window. The
    // presentation the user actually left is carried over with it.
    const keepsOwnedFloatingWindow = pictureInPictureOwnedByBridge &&
      presentationModeOf(video) === PICTURE_IN_PICTURE;

    if (!keepsOwnedFloatingWindow) {
      backgroundPresentationMode = backgroundPlaybackIntended ? presentationModeOf(video) : INLINE;
    }

    pictureInPictureOwnedByBridge = keepsOwnedFloatingWindow;
    pictureInPictureRequested = keepsOwnedFloatingWindow;
    pictureInPictureAttempts = 0;
    backgroundTransitionAt = Date.now();
    repaintAttempts = 0;

    logToNative(
      "prepareForBackground: intended=" + backgroundPlaybackIntended +
      " mode=" + backgroundPresentationMode +
      " lateSuspend=" + suspendedByTransition +
      ", " + describeVideo(video)
    );

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

    // Fullscreen playback continues as a floating window. Inline playback is
    // only meant to keep its audio, so its presentation is left untouched.
    //
    // Collapsing native fullscreen before the request was tried and is worse
    // on both ends: WebKit silently refuses a Picture in Picture request made
    // from plain inline with no user gesture behind it, so the window never
    // appears at all, while a request made straight out of fullscreen is
    // honoured — and the fullscreen teardown rumbling underneath it is the
    // same transition WebKit performs for its own automatic handover.
    if (backgroundPresentationMode === FULLSCREEN) {
      requestPictureInPicture(video, 0);
    }

    reportPlaybackState();
  }

  function didEnterBackground() {
    appIsActive = false;

    logToNative("didEnterBackground: intended=" + backgroundPlaybackIntended +
      ", " + describeVideo(activeVideo));

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

    const video = pickActiveVideo();
    activeVideo = video;

    if (!video) {
      backgroundPlaybackIntended = false;
      finishForegroundRestore(restoreToken);
      return;
    }

    // Ownership must not gate the way back. Fullscreen video backgrounded by
    // the home gesture is handed into the floating window by WebKit itself, so
    // the bridge never owns that window (`pictureInPictureRequested` stayed
    // false); gating on ownership skipped the exit entirely and returned to an
    // element whose inline layer was gone — audio kept playing over a black
    // surface. Anything still presenting as Picture in Picture comes back.
    const leavingPictureInPicture =
      presentationModeOf(video) === PICTURE_IN_PICTURE;
    const targetMode = restorePresentationMode();

    pictureInPictureOwnedByBridge = false;
    pictureInPictureRequested = false;

    logToNative(
      "recoverAfterForeground: leavingPiP=" + leavingPictureInPicture +
      " target=" + targetMode + ", " + describeVideo(video)
    );

    if (!leavingPictureInPicture) {
      resumeAfterForeground(video, restoreToken);
      return;
    }

    setPresentationMode(video, targetMode);
    waitForPresentation(video, targetMode, restoreToken, 0);
  }

  // A banner, Control Center or the app switcher deactivates the app without
  // ever backgrounding it, so the handover has to be rolled back.
  function cancelBackgroundPreparation() {
    appIsActive = true;
    closeBackgroundHoldWindow();

    const video = activeVideo;
    const targetMode = restorePresentationMode();

    backgroundPlaybackIntended = false;

    // Ownership is deliberately not cleared here. Leaving the floating window
    // is asynchronous and a locking device abandons the rollback half way;
    // clearing it at this point orphaned a window this bridge had opened. The
    // presentation change event clears it once the element is actually out.
    if (pictureInPictureOwnedByBridge && video &&
      presentationModeOf(video) === PICTURE_IN_PICTURE) {
      setPresentationMode(video, targetMode);
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

    if (presentationModeOf(video) === PICTURE_IN_PICTURE) {
      // WebKit confirmed the handover, so the bridge may undo it on the way
      // back. A window the user opened never sets `pictureInPictureRequested`
      // and therefore stays theirs.
      if (pictureInPictureRequested) {
        pictureInPictureOwnedByBridge = true;
      }
    } else {
      pictureInPictureOwnedByBridge = false;
    }

    logToNative("presentation changed: " + describeVideo(video) +
      " owned=" + pictureInPictureOwnedByBridge);
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

  installLifecycleBridge();
  installVisibilityPatch();

  const observer = new MutationObserver(function (mutations) {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          scheduleIncrementalScan(node);
        }
      }
    }
  });

  const adSkipPollIntervalMilliseconds = 1000;

  // In-stream video ads render inside the player itself, so hiding alone is
  // not enough — the skip button has to be clicked as soon as it exists. A one
  // second poll closes the gap between the five second fallback scans.
  function clickAdSkipButtons() {
    if (appIsActive && observedVideos.size === 0) {
      return;
    }

    for (const selector of clickableSelectors) {
      forEachMatchingElement(document, selector, function (button) {
        button.click();
      });
    }
  }

  function start() {
    scanDocument();

    for (const type of userGestureEventTypes) {
      document.addEventListener(type, noteUserGesture, { capture: true, passive: true });
    }

    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true
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

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

  let hasStartedPlayback = false;
  let shouldResumeInBackground = false;
  let appIsActive = true;
  const observedVideos = new Set();
  const pendingRoots = new Set();
  let incrementalScanScheduled = false;

  // Child-list mutations are handled incrementally. This slower full scan is a
  // recovery path for selector changes caused only by class/attribute updates.
  const fallbackScanIntervalMilliseconds = 5000;

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

  function rememberPlayback() {
    for (const video of trackedVideos()) {
      if (!video.paused && !video.ended) {
        hasStartedPlayback = true;
        shouldResumeInBackground = true;
      }
    }
  }

  function resumePlaybackIfNeeded() {
    if (appIsActive || !hasStartedPlayback || !shouldResumeInBackground) {
      return;
    }

    for (const video of trackedVideos()) {
      if (video.paused && !video.ended) {
        video.play().catch(function () {});
      }
    }
  }

  function isFullscreenVideo(video) {
    const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;

    return fullscreenElement === video ||
      (fullscreenElement && fullscreenElement.contains && fullscreenElement.contains(video)) ||
      video.webkitPresentationMode === "fullscreen";
  }

  function enablePictureInPicture(video) {
    try {
      video.removeAttribute("disablepictureinpicture");
      video.disablePictureInPicture = false;
    } catch (_) {
    }
  }

  function requestPictureInPictureIfNeeded() {
    if (!hasStartedPlayback || !shouldResumeInBackground) {
      return;
    }

    for (const video of trackedVideos()) {
      if (video.paused || video.ended || !isFullscreenVideo(video)) {
        continue;
      }

      enablePictureInPicture(video);

      try {
        if (
          video.webkitPresentationMode === "picture-in-picture" ||
          document.pictureInPictureElement === video
        ) {
          continue;
        }

        if (typeof video.webkitSetPresentationMode === "function") {
          video.webkitSetPresentationMode("picture-in-picture");
        } else if (
          document.pictureInPictureEnabled &&
          typeof video.requestPictureInPicture === "function"
        ) {
          video.requestPictureInPicture().catch(function () {});
        }
      } catch (_) {
      }
    }
  }

  function installLifecycleBridge() {
    window.__ytproSetAppActive = function (isActive) {
      appIsActive = Boolean(isActive);

      if (!appIsActive) {
        requestPictureInPictureIfNeeded();
        resumePlaybackIfNeeded();
        window.setTimeout(function () {
          requestPictureInPictureIfNeeded();
          resumePlaybackIfNeeded();
        }, 600);
      }
    };
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
    }
  }

  function observeVideo(video) {
    if (observedVideos.has(video)) {
      return;
    }

    observedVideos.add(video);
    video.dataset.ytproObserved = "1";
    enablePictureInPicture(video);
    video.addEventListener("play", function () {
      hasStartedPlayback = true;
      shouldResumeInBackground = true;
    }, { passive: true });
    video.addEventListener("playing", function () {
      hasStartedPlayback = true;
      shouldResumeInBackground = true;
    }, { passive: true });
    video.addEventListener("pause", function () {
      if (appIsActive) {
        shouldResumeInBackground = false;
        return;
      }

      window.setTimeout(resumePlaybackIfNeeded, 400);
    }, { passive: true });
    video.addEventListener("ended", function () {
      shouldResumeInBackground = false;
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
    }
  }

  function scanRoot(root) {
    cleanAds(root);
    installMediaListeners(root);
  }

  function scanDocument() {
    scanRoot(document);
    rememberPlayback();
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

  function start() {
    scanDocument();
    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true
    });
    window.setInterval(function () {
      scanDocument();
      resumePlaybackIfNeeded();
    }, fallbackScanIntervalMilliseconds);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();

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

  function hideElement(element) {
    if (!element || element.dataset.ytproHidden === "1") {
      return;
    }

    element.dataset.ytproHidden = "1";
    element.style.setProperty("display", "none", "important");
    element.style.setProperty("visibility", "hidden", "important");
    element.style.setProperty("pointer-events", "none", "important");
  }

  function cleanAds(root) {
    const scope = root && root.querySelectorAll ? root : document;

    for (const selector of blockedSelectors) {
      try {
        scope.querySelectorAll(selector).forEach(hideElement);
      } catch (_) {
        // Some WebKit builds do not support every selector variant.
      }
    }

    for (const selector of clickableSelectors) {
      try {
        scope.querySelectorAll(selector).forEach((button) => button.click());
      } catch (_) {
      }
    }
  }

  function rememberPlayback() {
    for (const video of document.querySelectorAll("video")) {
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

    for (const video of document.querySelectorAll("video")) {
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

    for (const video of document.querySelectorAll("video")) {
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

  function installMediaListeners(root) {
    const scope = root && root.querySelectorAll ? root : document;

    try {
      scope.querySelectorAll("video").forEach((video) => {
        if (video.dataset.ytproObserved === "1") {
          return;
        }

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
      });
    } catch (_) {
    }
  }

  function tick(root) {
    cleanAds(root);
    installMediaListeners(root);
    rememberPlayback();
  }

  installLifecycleBridge();
  installVisibilityPatch();

  const observer = new MutationObserver(function (mutations) {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          tick(node);
        }
      }
    }

    tick(document);
  });

  function start() {
    tick(document);
    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true
    });
    window.setInterval(function () {
      tick(document);
      resumePlaybackIfNeeded();
    }, 1000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();

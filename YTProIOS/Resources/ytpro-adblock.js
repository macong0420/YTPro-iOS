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

  const visibilityState = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState").get;
  const play = HTMLVideoElement.prototype.play;
  const pause = HTMLVideoElement.prototype.pause;
  const playbackStates = new WeakMap();
  let backgroundAt = null;

  HTMLVideoElement.prototype.pause = function () {
    const state = playbackStates.get(this);
    if (state) {
      state.wanted = false;
    }
    return pause.call(this);
  };

  try {
    if (navigator.audioSession) {
      navigator.audioSession.type = "playback";
    }
  } catch (_) {
    // Older WebKit versions may not expose a writable Audio Session API.
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

  function resumePlaybackIfNeeded(video, state) {
    if (visibilityState.call(document) === "visible") {
      return;
    }

    const now = performance.now();
    if (backgroundAt === null) {
      backgroundAt = now;
    }

    // debt: WebKit pause events have no cause; allow one recovery within the
    // 2s background transition, not a keepalive. Use device logs if this window changes.
    if (!state.wanted || state.resumed || !video.paused || video.ended ||
        video.muted || video.volume === 0 || !video.isConnected ||
        now - backgroundAt > 2000 || now - state.pausedAt > 2000 ||
        navigator.audioSession?.state === "interrupted") {
      return;
    }

    state.resumed = true;
    play.call(video).catch(function () {
      console.warn("YTPro: background audio resume was denied by WebKit");
    });
  }

  document.addEventListener("visibilitychange", function () {
    const hidden = visibilityState.call(document) !== "visible";
    backgroundAt = hidden ? (backgroundAt ?? performance.now()) : null;
    for (const video of document.querySelectorAll("video")) {
      const state = playbackStates.get(video);
      if (!state) {
        continue;
      }
      if (hidden) {
        resumePlaybackIfNeeded(video, state);
      } else {
        state.resumed = false;
        state.wanted = !video.paused && !video.ended;
        state.pausedAt = -Infinity;
      }
    }
  }, true);

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
        const state = { wanted: !video.paused && !video.ended, resumed: false, pausedAt: -Infinity };
        playbackStates.set(video, state);
        const rememberPlayback = function () {
          state.wanted = !video.paused && !video.ended;
        };
        video.addEventListener("play", rememberPlayback, { passive: true });
        video.addEventListener("playing", rememberPlayback, { passive: true });
        video.addEventListener("ended", function () {
          state.wanted = false;
        }, { passive: true });
        video.addEventListener("pause", function () {
          state.pausedAt = performance.now();
          resumePlaybackIfNeeded(video, state);
        }, { passive: true });
      });
    } catch (_) {
    }
  }

  function tick(root) {
    cleanAds(root);
    installMediaListeners(root);
  }

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
    }, 1000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();

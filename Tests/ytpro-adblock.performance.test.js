"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const scriptPath = path.join(
  __dirname,
  "..",
  "YTProIOS",
  "Resources",
  "ytpro-adblock.js"
);
const scriptSource = fs.readFileSync(scriptPath, "utf8");
const browserStateSource = fs.readFileSync(path.join(
  __dirname,
  "..",
  "YTProIOS",
  "Browser",
  "BrowserState.swift"
), "utf8");

class FakeElement {
  constructor(tagName, selectors = []) {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.selectors = new Set(selectors);
    this.children = [];
    this.parentElement = null;
    this.isConnected = false;
    this.dataset = {};
    this.attributes = new Map();
    this.queryCount = 0;
    this.clickCount = 0;
    this.playCount = 0;
    this.presentationModeRequests = [];
    this.listeners = new Map();
    this.paused = true;
    this.ended = false;
    this.currentTime = 0;
    this.duration = Number.NaN;
    this.decodedFrames = 0;
    this.repaintCount = 0;
    this.webkitPresentationMode = "inline";
    this.webkitDisplayingFullscreen = false;
    this.disablePictureInPicture = true;
    this.rect = { width: 320, height: 180 };
    this.styleValues = new Map();
    this.stylePriorities = new Map();
    this.style = {
      setProperty: (name, value, priority = "") => {
        this.styleValues.set(name, value);
        this.stylePriorities.set(name, priority);
      },
      removeProperty: (name) => {
        this.styleValues.delete(name);
        this.stylePriorities.delete(name);
      },
      getPropertyValue: (name) => this.styleValues.get(name) || "",
      getPropertyPriority: (name) => this.stylePriorities.get(name) || "",
      get display() {
        return "";
      }
    };
  }

  get offsetHeight() {
    if (this.styleValues.get("display") === "none") {
      this.repaintCount += 1;
    }

    return 180;
  }

  getBoundingClientRect() {
    return this.rect;
  }

  getVideoPlaybackQuality() {
    return { totalVideoFrames: this.decodedFrames };
  }

  append(child) {
    child.parentElement = this;
    child.setConnected(this.isConnected);
    this.children.push(child);
    return child;
  }

  setConnected(isConnected) {
    this.isConnected = isConnected;
    this.children.forEach((child) => child.setConnected(isConnected));
  }

  matches(selector) {
    return selector === "video"
      ? this.tagName === "VIDEO"
      : this.selectors.has(selector);
  }

  querySelectorAll(selector) {
    this.queryCount += 1;
    return collectMatches(this.children, selector);
  }

  contains(candidate) {
    let node = candidate;

    while (node) {
      if (node === this) {
        return true;
      }

      node = node.parentElement;
    }

    return false;
  }

  click() {
    this.clickCount += 1;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type) {
    for (const listener of this.listeners.get(type) || []) {
      listener({ type, target: this });
    }
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  remove() {
    if (!this.parentElement) {
      return;
    }

    const index = this.parentElement.children.indexOf(this);

    if (index >= 0) {
      this.parentElement.children.splice(index, 1);
    }

    this.parentElement = null;
    this.setConnected(false);
  }

  webkitSetPresentationMode(mode) {
    this.presentationModeRequests.push(mode);
  }

  removeAttribute() {
  }

  play() {
    this.paused = false;
    this.playCount += 1;
    this.dispatch("playing");
    return Promise.resolve();
  }

  setPresentationMode(mode) {
    this.webkitPresentationMode = mode;
    this.dispatch("webkitpresentationmodechanged");
  }
}

class FakeDocument {
  constructor(root) {
    this.nodeType = 9;
    this.readyState = "complete";
    this.documentElement = root;
    this.body = root;
    this.fullscreenElement = null;
    this.webkitFullscreenElement = null;
    this.pictureInPictureElement = null;
    this.pictureInPictureEnabled = false;
    this.queryCount = 0;
    this.listeners = new Map();
  }

  createElement(tagName) {
    return new FakeElement(tagName);
  }

  querySelectorAll(selector) {
    this.queryCount += 1;
    return collectMatches([this.documentElement], selector);
  }

  querySelector(selector) {
    return collectMatches([this.documentElement], selector)[0] || null;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type) {
    for (const listener of this.listeners.get(type) || []) {
      listener({ type });
    }
  }
}

function collectMatches(elements, selector) {
  const matches = [];

  for (const element of elements) {
    if (element.matches(selector)) {
      matches.push(element);
    }

    matches.push(...collectMatches(element.children, selector));
  }

  return matches;
}

function createHarness(options = {}) {
  const documentRoot = new FakeElement("html");
  documentRoot.setConnected(true);
  const document = new FakeDocument(documentRoot);
  const timeouts = [];
  const intervals = [];
  const nativeMessages = [];
  let mutationCallback;
  let clock = 1_000_000;

  class FakeMutationObserver {
    constructor(callback) {
      mutationCallback = callback;
    }

    observe() {
    }
  }

  const window = {
    location: { hostname: "m.youtube.com" },
    fetch: options.fetch,
    ytInitialPlayerResponse: options.initialPlayerResponse,
    innerWidth: 390,
    innerHeight: 844,
    webkit: {
      messageHandlers: {
        ytpro: {
          postMessage(payload) {
            nativeMessages.push(payload);
          }
        }
      }
    },
    setTimeout(callback, delay) {
      timeouts.push({ callback, delay, id: timeouts.length + 1 });
      return timeouts.length;
    },
    clearTimeout(id) {
      const index = timeouts.findIndex((timer) => timer.id === id);

      if (index >= 0) {
        timeouts.splice(index, 1);
      }
    },
    setInterval(callback, delay) {
      intervals.push({ callback, delay });
      return intervals.length;
    }
  };

  vm.runInNewContext(scriptSource, {
    console,
    document,
    // A controllable clock: the bridge separates WebKit's suspension pause from
    // the user's by how long after the handover it arrived.
    Date: { now: () => clock },
    MutationObserver: FakeMutationObserver,
    Node: { ELEMENT_NODE: 1 },
    window
  });

  return {
    advanceClock(milliseconds) {
      clock += milliseconds;
    },
    document,
    documentRoot,
    intervals,
    mutationCallback,
    nativeMessages,
    timeouts,
    window
  };
}

function playbackReports(harness) {
  return harness.nativeMessages
    .filter((message) => message.type === "playback")
    .map((message) => message.playing);
}

function runNextTimeout(harness, expectedDelay) {
  const timer = harness.timeouts.shift();
  assert.ok(timer, "expected a scheduled timeout");
  assert.equal(timer.delay, expectedDelay);
  timer.callback();
}

function runTimeouts(harness, expectedDelay) {
  const matchingTimers = harness.timeouts.filter((timer) => timer.delay === expectedDelay);

  assert.ok(matchingTimers.length > 0, `expected a scheduled timeout at ${expectedDelay}ms`);

  for (const timer of matchingTimers) {
    const index = harness.timeouts.indexOf(timer);
    harness.timeouts.splice(index, 1);
    timer.callback();
  }
}

function attachPlayingVideo(harness) {
  const video = new FakeElement("video");
  harness.documentRoot.append(video);
  harness.mutationCallback([{ addedNodes: [video] }]);
  runNextTimeout(harness, 0);
  video.paused = false;
  video.dispatch("playing");
  return video;
}

test("mutation bursts are batched and scan only compacted added subtrees", () => {
  const harness = createHarness();
  const initialDocumentQueries = harness.document.queryCount;
  const adContainer = new FakeElement("ytd-ad-slot-renderer", ["ytd-ad-slot-renderer"]);
  const video = new FakeElement("video");

  harness.documentRoot.append(adContainer);
  adContainer.append(video);

  harness.mutationCallback([
    { addedNodes: [adContainer, video] }
  ]);

  assert.equal(harness.timeouts.length, 1, "one batch should schedule one flush");
  assert.equal(harness.document.queryCount, initialDocumentQueries, "mutation handling must not rescan document");
  assert.equal(adContainer.styleValues.get("display"), undefined, "scan should be deferred to the batch flush");

  runNextTimeout(harness, 0);

  assert.equal(adContainer.styleValues.get("display"), "none", "an added ad root should hide itself");
  assert.equal(video.queryCount, 0, "a child root should be removed from the batch when its ancestor is queued");
  assert.equal(video.listeners.get("play").length, 1);
  assert.equal(video.listeners.get("playing").length, 1);
  assert.equal(video.listeners.get("pause").length, 1);
  assert.equal(video.listeners.get("ended").length, 1);
  assert.equal(harness.document.queryCount, initialDocumentQueries, "flushing added roots must stay incremental");

  harness.mutationCallback([{ addedNodes: [video] }]);
  runNextTimeout(harness, 0);

  assert.equal(video.listeners.get("play").length, 1, "an observed video must not receive duplicate listeners");
});

test("skip buttons are handled incrementally and full scans are low-frequency fallbacks", () => {
  const harness = createHarness();
  const initialDocumentQueries = harness.document.queryCount;
  const skipButton = new FakeElement("button", [".ytp-ad-skip-button"]);

  harness.documentRoot.append(skipButton);
  harness.mutationCallback([{ addedNodes: [skipButton] }]);
  runNextTimeout(harness, 0);

  assert.equal(skipButton.clickCount, 1);
  assert.equal(harness.document.queryCount, initialDocumentQueries, "added nodes must not trigger a document scan");
  assert.equal(harness.intervals.length, 3);
  assert.equal(harness.intervals[0].delay, 5000);
  assert.equal(harness.intervals[1].delay, 250);
  assert.equal(harness.intervals[2].delay, 1000);

  harness.intervals[0].callback();
  assert.ok(harness.document.queryCount > initialDocumentQueries, "the fallback interval should retain a full recovery scan");

  harness.intervals[1].callback();
  assert.equal(skipButton.clickCount, 2, "the skip poll clicks buttons that appeared without a mutation");
});

test("initial player responses are stripped before YouTube can schedule ads", () => {
  const initialPlayerResponse = {
    adPlacements: [{ adPlacementRenderer: {} }],
    playerAds: [{ playerLegacyDesktopWatchAdsRenderer: {} }],
    adSlots: [{ adSlotRenderer: {} }],
    videoDetails: { videoId: "content-video" },
    nested: {
      adBreakHeartbeatParams: "ad-heartbeat",
      keep: true
    }
  };
  const harness = createHarness({ initialPlayerResponse });

  assert.equal("adPlacements" in harness.window.ytInitialPlayerResponse, false);
  assert.equal("playerAds" in harness.window.ytInitialPlayerResponse, false);
  assert.equal("adSlots" in harness.window.ytInitialPlayerResponse, false);
  assert.equal("adBreakHeartbeatParams" in harness.window.ytInitialPlayerResponse.nested, false);
  assert.equal(harness.window.ytInitialPlayerResponse.videoDetails.videoId, "content-video");
  assert.equal(harness.window.ytInitialPlayerResponse.nested.keep, true);
  assert.ok(
    harness.nativeMessages.some((message) => message.type === "log" && message.message.includes("stripped player response"))
  );
});

test("fetch player responses are stripped without delaying the content response", async () => {
  const source = {
    adPlacements: [{ adPlacementRenderer: {} }],
    playerAds: [{}],
    streamingData: { formats: [{ itag: 18 }] },
    videoDetails: { videoId: "content-video" }
  };
  const response = {
    json() {
      return Promise.resolve(JSON.parse(JSON.stringify(source)));
    },
    text() {
      return Promise.resolve(JSON.stringify(source));
    },
    clone() {
      return this;
    }
  };
  const harness = createHarness({
    fetch() {
      return Promise.resolve(response);
    }
  });

  const playerResponse = await harness.window
    .fetch("https://m.youtube.com/youtubei/v1/player?prettyPrint=false")
    .then((result) => result.json());

  assert.equal("adPlacements" in playerResponse, false);
  assert.equal("playerAds" in playerResponse, false);
  assert.deepEqual(playerResponse.streamingData.formats, [{ itag: 18 }]);
  assert.equal(playerResponse.videoDetails.videoId, "content-video");
});

test("non-player fetch responses pass through untouched", async () => {
  const source = { adPlacements: ["not-a-player-response"], keep: true };
  const response = {
    json() {
      return Promise.resolve(source);
    }
  };
  const harness = createHarness({
    fetch() {
      return Promise.resolve(response);
    }
  });

  const result = await harness.window
    .fetch("https://m.youtube.com/youtubei/v1/search")
    .then((value) => value.json());

  assert.deepEqual(result.adPlacements, ["not-a-player-response"]);
  assert.equal(result.keep, true);
});

test("the DOM fallback advances a confirmed in-stream pre-roll", () => {
  const harness = createHarness();
  const player = new FakeElement("div", [".html5-video-player.ad-showing"]);
  const adEvidence = new FakeElement("div", [".ytp-ad-duration-remaining"]);
  const video = new FakeElement("video");

  video.duration = 6.041;
  video.paused = false;
  harness.documentRoot.append(player);
  player.append(adEvidence);
  player.append(video);

  harness.mutationCallback([{ type: "attributes", target: player }]);
  runNextTimeout(harness, 0);

  assert.equal(video.currentTime, 6.041);
  assert.equal(video.styleValues.get("opacity"), undefined, "the fallback must not replace ads with a black shield");
  assert.ok(
    harness.nativeMessages.some((message) => message.type === "log" && message.message.startsWith("ad: advanced"))
  );
});

test("an ad is retried while its duration is initially unavailable", () => {
  const harness = createHarness();
  const player = new FakeElement("div", ["#movie_player.ad-showing"]);
  const adEvidence = new FakeElement("div", [".ytp-ad-module"]);
  const video = new FakeElement("video");

  video.currentTime = 8;
  video.paused = false;
  harness.documentRoot.append(player);
  player.append(adEvidence);
  player.append(video);

  harness.mutationCallback([{ type: "attributes", target: player }]);
  runNextTimeout(harness, 0);

  assert.equal(video.currentTime, 8);
  assert.ok(
    harness.nativeMessages.some((message) => message.type === "log" && message.message.includes("duration-unavailable"))
  );

  video.duration = 30;
  harness.intervals[1].callback();

  assert.equal(video.currentTime, 30, "the 250ms poll should finish the previously unseekable ad");
});

test("ordinary, long and live media are never force-seeked", () => {
  const harness = createHarness();
  const ordinaryPlayer = new FakeElement("div", [".html5-video-player"]);
  const ordinaryVideo = new FakeElement("video");

  ordinaryVideo.duration = 60;
  ordinaryVideo.currentTime = 12;
  ordinaryVideo.paused = false;
  harness.documentRoot.append(ordinaryPlayer);
  ordinaryPlayer.append(ordinaryVideo);

  harness.mutationCallback([{ type: "attributes", target: ordinaryPlayer }]);
  runNextTimeout(harness, 0);
  assert.equal(ordinaryVideo.currentTime, 12);
  assert.equal(ordinaryVideo.styleValues.get("opacity"), undefined);

  const adPlayer = new FakeElement("div", ["ytm-player.ad-showing"]);
  const adEvidence = new FakeElement("div", [".ytp-ad-text"]);
  const longVideo = new FakeElement("video");

  longVideo.duration = 600;
  longVideo.currentTime = 1;
  longVideo.paused = false;
  harness.documentRoot.append(adPlayer);
  adPlayer.append(adEvidence);
  adPlayer.append(longVideo);

  harness.mutationCallback([{ type: "attributes", target: adPlayer }]);
  runNextTimeout(harness, 0);
  assert.equal(longVideo.currentTime, 1);

  longVideo.duration = Number.POSITIVE_INFINITY;
  harness.intervals[1].callback();
  assert.equal(longVideo.currentTime, 1);
});

test("only the actively playing ad video is advanced", () => {
  const harness = createHarness();
  const player = new FakeElement("div", ["ytm-player.ad-showing"]);
  const adEvidence = new FakeElement("div", [".ytp-ad-preview-container"]);
  const contentVideo = new FakeElement("video");
  const adVideo = new FakeElement("video");

  contentVideo.duration = 600;
  contentVideo.currentTime = 12;
  adVideo.duration = 20;
  adVideo.currentTime = 2;
  adVideo.paused = false;
  harness.documentRoot.append(player);
  player.append(adEvidence);
  player.append(contentVideo);
  player.append(adVideo);

  harness.mutationCallback([{ type: "attributes", target: player }]);
  runNextTimeout(harness, 0);

  assert.equal(contentVideo.currentTime, 12);
  assert.equal(adVideo.currentTime, 20);
});

test("ad-interrupting is not sufficient evidence for forced seeking", () => {
  const harness = createHarness();
  const player = new FakeElement("div", [".html5-video-player.ad-interrupting"]);
  const adEvidence = new FakeElement("div", [".ytp-ad-player-overlay"]);
  const video = new FakeElement("video");

  video.duration = 30;
  video.currentTime = 1;
  video.paused = false;
  harness.documentRoot.append(player);
  player.append(adEvidence);
  player.append(video);

  harness.mutationCallback([{ type: "attributes", target: player }]);
  runNextTimeout(harness, 0);

  assert.equal(video.currentTime, 1);
  assert.equal(video.styleValues.get("opacity"), undefined);
});

test("mobile skip-slot controls are clicked", () => {
  const harness = createHarness();
  const skipButton = new FakeElement("button", [".ytp-ad-skip-button-slot button"]);
  const video = new FakeElement("video");

  harness.documentRoot.append(skipButton);
  harness.documentRoot.append(video);
  harness.mutationCallback([{ addedNodes: [skipButton] }]);
  runNextTimeout(harness, 0);

  assert.equal(skipButton.clickCount, 1);
});

test("forced ad seeking is disabled while backgrounding", () => {
  const harness = createHarness();
  const player = new FakeElement("div", [".html5-video-player"]);
  const adEvidence = new FakeElement("div", [".ytp-ad-duration-remaining"]);
  const video = new FakeElement("video");

  video.duration = 15;
  video.currentTime = 1;
  video.paused = false;
  harness.documentRoot.append(player);
  player.append(adEvidence);
  player.append(video);

  harness.mutationCallback([{ addedNodes: [player] }]);
  runNextTimeout(harness, 0);
  video.dispatch("playing");
  harness.window.__ytproPrepareForBackground();

  player.selectors.add(".html5-video-player.ad-showing");
  harness.mutationCallback([{ type: "attributes", target: player }]);
  runTimeouts(harness, 0);

  assert.equal(video.currentTime, 1);
});

test("the native side drives one background handover and one foreground restore", () => {
  assert.match(browserStateSource, /UIApplication\.willResignActiveNotification/);
  assert.match(browserStateSource, /UIApplication\.didEnterBackgroundNotification/);
  assert.match(browserStateSource, /UIApplication\.willEnterForegroundNotification/);
  assert.match(browserStateSource, /UIApplication\.didBecomeActiveNotification/);
  assert.match(browserStateSource, /__ytproPrepareForBackground/);
  assert.match(browserStateSource, /__ytproDidEnterBackground/);
  assert.match(browserStateSource, /__ytproHoldPlayback/);
  assert.match(browserStateSource, /__ytproPrepareForForeground/);
  assert.match(browserStateSource, /__ytproRecoverAfterForeground/);
  assert.match(browserStateSource, /__ytproCancelBackgroundPreparation/);
  assert.match(browserStateSource, /beginBackgroundTask/, "a frozen web process cannot resume itself");
  assert.doesNotMatch(
    browserStateSource,
    /closeAllMediaPresentations/,
    "closing presentations natively races the transition the bridge is already running"
  );
});

test("a manually paused video is never started by the app leaving the foreground", () => {
  const harness = createHarness();
  const video = attachPlayingVideo(harness);

  // The tap on the player is what marks this pause as the user's.
  harness.document.dispatch("pointerdown");
  video.paused = true;
  video.dispatch("pause");
  harness.window.__ytproPrepareForBackground();
  harness.window.__ytproDidEnterBackground();
  video.dispatch("pause");

  assert.equal(video.playCount, 0);
  assert.deepEqual(video.presentationModeRequests, []);
});

test("inline playback keeps its audio without opening a floating window", () => {
  const harness = createHarness();
  const video = attachPlayingVideo(harness);

  harness.window.__ytproPrepareForBackground();
  harness.window.__ytproDidEnterBackground();

  assert.deepEqual(video.presentationModeRequests, [], "audio only playback stays inline");

  // WebKit suspends the media session a moment after the app leaves the screen.
  video.paused = true;
  video.dispatch("pause");

  assert.equal(video.playCount, 1);
});

test("a suspended web process is resumed by the native hold ping", () => {
  const harness = createHarness();
  const video = attachPlayingVideo(harness);

  harness.window.__ytproPrepareForBackground();
  harness.window.__ytproDidEnterBackground();

  // The pause event is never delivered because the process was already frozen.
  video.paused = true;
  harness.window.__ytproHoldPlayback();

  assert.equal(video.playCount, 1);
});

test("only the playing video takes part in the background handover", () => {
  const harness = createHarness();
  const preview = new FakeElement("video");

  harness.documentRoot.append(preview);
  harness.mutationCallback([{ addedNodes: [preview] }]);
  runNextTimeout(harness, 0);

  const video = attachPlayingVideo(harness);

  harness.window.__ytproPrepareForBackground();
  harness.window.__ytproDidEnterBackground();
  video.paused = true;
  video.dispatch("pause");

  assert.equal(video.playCount, 1);
  assert.equal(preview.playCount, 0, "a preview player must stay untouched");
});

test("a pause after the transition window belongs to the user", () => {
  const harness = createHarness();
  const video = attachPlayingVideo(harness);

  harness.window.__ytproPrepareForBackground();
  harness.window.__ytproDidEnterBackground();
  runTimeouts(harness, 15000);

  video.paused = true;
  video.dispatch("pause");

  assert.equal(video.playCount, 0);
});

test("fullscreen playback is left to WebKit's own floating window handover", () => {
  const harness = createHarness();
  const video = attachPlayingVideo(harness);

  video.webkitPresentationMode = "fullscreen";
  harness.window.__ytproPrepareForBackground();

  // The bridge must not ask for Picture in Picture while the fullscreen
  // presentation is live — that request makes `AVPlayerViewController` fight
  // its own teardown (`exitFullScreenAnimated ... Invalid call`) and detaches
  // the media layer. WebKit hands the video to the floating window itself.
  assert.deepEqual(video.presentationModeRequests, []);
  assert.equal(video.disablePictureInPicture, false, "the player may forbid the floating window");
});

test("page-driven fullscreen is also left to the player", () => {
  const harness = createHarness();
  const playerShell = new FakeElement("ytm-app", ["ytm-app[player-fullscreen]"]);

  harness.documentRoot.append(playerShell);

  const video = attachPlayingVideo(harness);

  harness.window.__ytproPrepareForBackground();

  assert.deepEqual(video.presentationModeRequests, []);
});

test("a video stretched over the whole viewport is still left to the player", () => {
  const harness = createHarness();
  const video = attachPlayingVideo(harness);

  video.rect = { width: 390, height: 844 };
  harness.window.__ytproPrepareForBackground();

  assert.deepEqual(video.presentationModeRequests, []);
});

test("a pause in the floating window belongs to the user", () => {
  const harness = createHarness();
  const video = attachPlayingVideo(harness);

  video.webkitPresentationMode = "fullscreen";
  harness.window.__ytproPrepareForBackground();
  video.setPresentationMode("picture-in-picture");
  harness.window.__ytproDidEnterBackground();

  // Well clear of the handover, so this can only be a tap on the window's own
  // controls.
  harness.advanceClock(5000);
  video.paused = true;
  video.dispatch("pause");

  assert.equal(video.playCount, 0);
});

test("a pause during the handover into the floating window is not the user", () => {
  const harness = createHarness();
  const video = attachPlayingVideo(harness);

  video.webkitPresentationMode = "fullscreen";
  harness.window.__ytproPrepareForBackground();
  video.setPresentationMode("picture-in-picture");

  // WebKit suspends the element while the handover is still settling. The
  // window's controls leave no gesture behind, so only its timing separates
  // this from a real tap.
  video.paused = true;
  video.dispatch("pause");

  assert.equal(video.playCount, 1, "the handover must not be read as the user giving up");
});

test("returning to the foreground leaves the floating window once and resumes playback", () => {
  const harness = createHarness();
  const video = attachPlayingVideo(harness);

  video.webkitPresentationMode = "fullscreen";
  harness.window.__ytproPrepareForBackground();
  video.setPresentationMode("picture-in-picture");
  harness.window.__ytproDidEnterBackground();
  video.paused = true;

  harness.window.__ytproPrepareForForeground();
  harness.window.__ytproRecoverAfterForeground();
  harness.window.__ytproRecoverAfterForeground();

  assert.deepEqual(
    video.presentationModeRequests,
    ["inline"],
    "a hand-off window WebKit opened is closed once; there is nothing to restore"
  );

  video.setPresentationMode("inline");
  runTimeouts(harness, 60);

  assert.equal(video.playCount, 1);
});

test("a floating window the user opened is left alone on the way back", () => {
  const harness = createHarness();
  const video = attachPlayingVideo(harness);

  video.setPresentationMode("picture-in-picture");
  harness.window.__ytproPrepareForBackground();
  harness.window.__ytproDidEnterBackground();
  harness.window.__ytproPrepareForForeground();
  harness.window.__ytproRecoverAfterForeground();

  assert.deepEqual(video.presentationModeRequests, []);
});

test("a transient deactivation leaves no bridge-owned window to roll back", () => {
  const harness = createHarness();
  const video = attachPlayingVideo(harness);

  video.webkitPresentationMode = "fullscreen";
  harness.window.__ytproPrepareForBackground();
  video.setPresentationMode("picture-in-picture");
  harness.window.__ytproCancelBackgroundPreparation();

  assert.deepEqual(video.presentationModeRequests, []);
  assert.equal(video.playCount, 0);
});

test("a media layer that stopped painting is handed a fresh surface", () => {
  const harness = createHarness();
  const video = attachPlayingVideo(harness);

  harness.window.__ytproPrepareForBackground();
  harness.window.__ytproDidEnterBackground();
  harness.window.__ytproPrepareForForeground();
  harness.window.__ytproRecoverAfterForeground();

  runTimeouts(harness, 400);
  video.currentTime += 1;
  runTimeouts(harness, 400);

  assert.equal(video.repaintCount, 1);
  assert.equal(video.styleValues.get("display"), undefined, "the player's own layout is restored");
});

test("playback that keeps painting is never repainted", () => {
  const harness = createHarness();
  const video = attachPlayingVideo(harness);

  harness.window.__ytproPrepareForBackground();
  harness.window.__ytproDidEnterBackground();
  harness.window.__ytproPrepareForForeground();
  harness.window.__ytproRecoverAfterForeground();

  runTimeouts(harness, 400);
  video.currentTime += 1;
  video.decodedFrames += 30;
  runTimeouts(harness, 400);

  assert.equal(video.repaintCount, 0);
});

test("playback that started before the listeners attached is still reported", () => {
  const harness = createHarness();
  const video = new FakeElement("video");

  // The player can begin playing before the observer reaches the element, and
  // the `playing` event is then lost — native would never claim the audio
  // session that background playback depends on.
  video.paused = false;
  harness.documentRoot.append(video);
  harness.mutationCallback([{ addedNodes: [video] }]);
  runNextTimeout(harness, 0);

  assert.deepEqual(playbackReports(harness), [], "the lost event reports nothing on its own");

  harness.intervals[2].callback();

  assert.deepEqual(playbackReports(harness), [true]);
});

test("the playback poll reports only when the state actually changed", () => {
  const harness = createHarness();
  const video = attachPlayingVideo(harness);

  assert.deepEqual(playbackReports(harness), [true]);

  harness.intervals[2].callback();
  harness.intervals[2].callback();

  assert.deepEqual(playbackReports(harness), [true], "an unchanged state must not cross the bridge");

  video.paused = true;
  harness.intervals[2].callback();

  assert.deepEqual(playbackReports(harness), [true, false]);
});

test("a pause between resigning active and backgrounding is not the user", () => {
  const harness = createHarness();
  const video = attachPlayingVideo(harness);

  // WebKit suspends the media session while the app is still only resigning
  // active, so its pause lands before didEnterBackground. Locking the screen
  // hits this every time, and reading it as a user pause silenced the trip.
  harness.window.__ytproPrepareForBackground();
  video.paused = true;
  video.dispatch("pause");

  assert.equal(video.playCount, 1, "the background transition begins at willResignActive");

  harness.window.__ytproDidEnterBackground();

  assert.equal(video.playCount, 1, "the trip must still be considered live");
});

test("a suspension pause that beat the bridge call still counts as playing", () => {
  const harness = createHarness();
  const video = attachPlayingVideo(harness);

  // `evaluateJavaScript` is asynchronous and the web process is already
  // throttled when the app resigns active, so WebKit's suspension pause
  // regularly reaches the element before prepareForBackground runs. No gesture
  // preceded it, which is what separates it from the user pressing pause.
  video.paused = true;
  video.dispatch("pause");
  harness.window.__ytproPrepareForBackground();

  assert.equal(video.playCount, 1, "the trip must survive a pause that arrived first");

  harness.window.__ytproDidEnterBackground();
  video.paused = true;
  video.dispatch("pause");

  assert.equal(video.playCount, 2, "and the hold must keep resuming it");
});

test("a cancelled trip never opened a floating window to orphan", () => {
  const harness = createHarness();
  const video = attachPlayingVideo(harness);

  video.webkitPresentationMode = "fullscreen";
  harness.window.__ytproPrepareForBackground();
  video.setPresentationMode("picture-in-picture");

  // A locking device sends a spurious activation. The bridge opened nothing,
  // so its window stays exactly as it was — it must not be closed on the way
  // back, or the inline player stays black.
  harness.window.__ytproCancelBackgroundPreparation();
  harness.window.__ytproPrepareForBackground();
  harness.window.__ytproDidEnterBackground();
  harness.window.__ytproPrepareForForeground();
  harness.window.__ytproRecoverAfterForeground();

  assert.deepEqual(video.presentationModeRequests, []);
});

test("an element already suspended before the bridge call is still resumed", () => {
  const harness = createHarness();
  const video = attachPlayingVideo(harness);

  // `video.paused` flips synchronously when WebKit suspends the app, while the
  // `pause` event that would have told the bridge arrives as a later task.
  // prepareForBackground therefore sees a paused element and no pause it can
  // date — only that the element was playing a moment ago.
  video.paused = true;
  harness.window.__ytproPrepareForBackground();

  assert.equal(video.playCount, 1, "a silently suspended element must still be resumed");
});

test("a video the user paused earlier is not revived by the handover", () => {
  const harness = createHarness();
  const video = attachPlayingVideo(harness);

  harness.document.dispatch("pointerdown");
  video.paused = true;
  video.dispatch("pause");

  // The user walks away, then locks the screen a while later.
  harness.advanceClock(30_000);
  harness.window.__ytproPrepareForBackground();
  harness.window.__ytproDidEnterBackground();
  video.dispatch("pause");

  assert.equal(video.playCount, 0);
});

test("no Picture in Picture request is made during the handover", () => {
  const harness = createHarness();
  const video = attachPlayingVideo(harness);

  video.webkitPresentationMode = "fullscreen";
  harness.window.__ytproPrepareForBackground();
  harness.window.__ytproDidEnterBackground();

  for (let ping = 0; ping < 60; ping += 1) {
    harness.window.__ytproHoldPlayback();
  }

  // The bridge leaves the fullscreen→Picture in Picture handover to WebKit.
  // It asks for nothing, so a view that cannot present a window is never
  // hammered into a detached media layer.
  assert.deepEqual(video.presentationModeRequests, []);
});

test("giving up on the floating window keeps the audio alive", () => {
  const harness = createHarness();
  const video = attachPlayingVideo(harness);

  video.webkitPresentationMode = "fullscreen";
  harness.window.__ytproPrepareForBackground();
  harness.window.__ytproDidEnterBackground();

  for (let ping = 0; ping < 60; ping += 1) {
    harness.window.__ytproHoldPlayback();
  }

  // WebKit suspends the media session a moment after the screen locks.
  video.paused = true;
  harness.window.__ytproHoldPlayback();

  assert.equal(video.playCount, 1, "audio only is the most a locked screen can offer");
});

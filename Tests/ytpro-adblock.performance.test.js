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
    this.seekableEnd = Number.NaN;
    this.muted = false;
    this.playbackRate = 1;
    this.decodedFrames = 0;
    this.repaintCount = 0;
    this.webkitPresentationMode = "inline";
    this.webkitDisplayingFullscreen = false;
    this.supportsPictureInPicture = true;
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

  get seekable() {
    if (Number.isNaN(this.seekableEnd)) {
      return { length: 0 };
    }

    return { length: 1, end: () => this.seekableEnd };
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

  webkitSupportsPresentationMode(mode) {
    return mode === "picture-in-picture" ? this.supportsPictureInPicture : true;
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

// One class per harness: the patch mutates the prototype it is handed, so a
// shared class would leak a previous harness's bridge into the next test.
function createFakeXHRClass() {
  return class FakeXMLHttpRequest {
    constructor() {
      this.readyState = 0;
      this.responseType = "";
      this.onload = null;
      this.listeners = new Map();
      this.body = "";
      this.parsedBody = null;
    }

    get responseText() {
      return this.body;
    }

    get response() {
      if (this.responseType !== "json") {
        return this.body;
      }

      // The spec builds the JSON response object once and hands the same one to
      // every reader, which is what makes editing it in place effective.
      if (this.parsedBody === null) {
        this.parsedBody = JSON.parse(this.body);
      }

      return this.parsedBody;
    }

    open() {
      this.readyState = 1;
    }

    send() {
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    /// Drives the response through the same event order WebKit uses.
    deliver(body) {
      this.body = body;
      this.readyState = 4;

      for (const listener of this.listeners.get("readystatechange") || []) {
        listener.call(this, { type: "readystatechange" });
      }

      if (this.onload) {
        this.onload.call(this, { type: "load" });
      }
    }
  };
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
    XMLHttpRequest: createFakeXHRClass(),
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

  const context = vm.createContext({
    console,
    document,
    // A controllable clock: the bridge separates WebKit's suspension pause from
    // the user's by how long after the handover it arrived.
    Date: { now: () => clock },
    MutationObserver: FakeMutationObserver,
    Node: { ELEMENT_NODE: 1 },
    window
  });

  vm.runInContext(scriptSource, context);

  // The script patches the realm's own `JSON`, so tests have to reach that one
  // rather than the host's.
  window.JSON = vm.runInContext("JSON", context);

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

test("a player response parsed off any transport at all is stripped", () => {
  const harness = createHarness();

  // The device log showed watch loads whose response reached the player
  // through neither the patched `fetch` nor `XMLHttpRequest`, and the ads in
  // them survived every request-level patch. Parsing is the chokepoint they
  // all share.
  const parsed = harness.window.JSON.parse(JSON.stringify({
    adPlacements: [{ adPlacementRenderer: {} }],
    playerAds: [{}],
    streamingData: { formats: [{ itag: 18 }] },
    videoDetails: { videoId: "content-video" },
    nested: { adBreakHeartbeatParams: "ad-heartbeat", keep: true }
  }));

  assert.equal("adPlacements" in parsed, false);
  assert.equal("playerAds" in parsed, false);
  assert.equal("adBreakHeartbeatParams" in parsed.nested, false);
  assert.equal(parsed.streamingData.formats[0].itag, 18);
  assert.equal(parsed.videoDetails.videoId, "content-video");
  assert.equal(parsed.nested.keep, true);
});

test("JSON that is not a player response is never walked", () => {
  const harness = createHarness();

  // No marker key, so the guard skips the walk entirely — which is what keeps
  // the patch off every other payload the page parses. An ad-shaped key that
  // survives here proves the object was never descended into.
  const parsed = harness.window.JSON.parse(JSON.stringify({
    adBreakHeartbeatParams: "unrelated-payload",
    keep: true
  }));

  assert.equal(parsed.adBreakHeartbeatParams, "unrelated-payload");
  assert.equal(parsed.keep, true);
});

test("a primitive parse result is passed straight through", () => {
  const harness = createHarness();
  const parsedArray = harness.window.JSON.parse("[1,2]");

  assert.equal(harness.window.JSON.parse("42"), 42);
  assert.equal(harness.window.JSON.parse("null"), null);
  assert.equal(parsedArray.length, 2);
  assert.equal(parsedArray[1], 2);
});

test("an ad whose duration has not landed is cut at its buffered end", () => {
  const harness = createHarness();
  const player = new FakeElement("div", [".html5-video-player.ad-showing"]);
  const adEvidence = new FakeElement("div", [".ytp-ad-duration-remaining"]);
  const video = new FakeElement("video");

  video.paused = false;
  video.seekableEnd = 14.5;
  harness.documentRoot.append(player);
  player.append(adEvidence);
  player.append(video);

  harness.mutationCallback([{ type: "attributes", target: player }]);
  runNextTimeout(harness, 0);

  assert.equal(video.currentTime, 14.5, "the poll cycle the ad used to be visible for is gone");
  assert.ok(
    harness.nativeMessages.some(
      (message) => message.type === "log" && message.message.startsWith("ad: advanced to the buffered end")
    )
  );
});

test("a buffered range too long to be an ad is left alone", () => {
  const harness = createHarness();
  const player = new FakeElement("div", [".html5-video-player.ad-showing"]);
  const adEvidence = new FakeElement("div", [".ytp-ad-duration-remaining"]);
  const video = new FakeElement("video");

  video.paused = false;
  video.seekableEnd = 900;
  harness.documentRoot.append(player);
  player.append(adEvidence);
  player.append(video);

  harness.mutationCallback([{ type: "attributes", target: player }]);
  runNextTimeout(harness, 0);

  assert.equal(video.currentTime, 0, "the length guard still protects mislabelled content");
});

test("XMLHttpRequest player responses are stripped before the player reads them", () => {
  const harness = createHarness();
  const request = new harness.window.XMLHttpRequest();
  let bodySeenByThePlayer = null;

  request.open("POST", "https://m.youtube.com/youtubei/v1/player?prettyPrint=false");

  // Assigned after `open`, exactly as the player does it. The strip only helps
  // if it lands before this handler runs.
  request.onload = function () {
    bodySeenByThePlayer = JSON.parse(request.responseText);
  };

  request.send();
  request.deliver(JSON.stringify({
    adPlacements: [{ adPlacementRenderer: {} }],
    playerAds: [{}],
    streamingData: { formats: [{ itag: 18 }] },
    videoDetails: { videoId: "content-video" }
  }));

  assert.equal("adPlacements" in bodySeenByThePlayer, false);
  assert.equal("playerAds" in bodySeenByThePlayer, false);
  assert.deepEqual(bodySeenByThePlayer.streamingData.formats, [{ itag: 18 }]);
  assert.equal(bodySeenByThePlayer.videoDetails.videoId, "content-video");
  assert.equal("adPlacements" in JSON.parse(request.response), false, "`response` must agree with `responseText`");
});

test("XMLHttpRequest json player responses are stripped in place", () => {
  const harness = createHarness();
  const request = new harness.window.XMLHttpRequest();

  request.responseType = "json";
  request.open("POST", "https://m.youtube.com/youtubei/v1/player");
  request.send();
  request.deliver(JSON.stringify({
    adSlots: [{ adSlotRenderer: {} }],
    videoDetails: { videoId: "content-video" }
  }));

  assert.equal("adSlots" in request.response, false);
  assert.equal(request.response.videoDetails.videoId, "content-video");
});

test("non-player XMLHttpRequest responses pass through untouched", () => {
  const harness = createHarness();
  const request = new harness.window.XMLHttpRequest();

  request.open("POST", "https://m.youtube.com/youtubei/v1/search");
  request.send();
  request.deliver(JSON.stringify({ adPlacements: ["not-a-player-response"], keep: true }));

  const result = JSON.parse(request.responseText);

  assert.deepEqual(result.adPlacements, ["not-a-player-response"]);
  assert.equal(result.keep, true);
});

test("a reused request never serves the body of its previous response", () => {
  const harness = createHarness();
  const request = new harness.window.XMLHttpRequest();

  request.open("POST", "https://m.youtube.com/youtubei/v1/player");
  request.send();
  request.deliver(JSON.stringify({ adPlacements: [{}], videoDetails: { videoId: "first" } }));

  assert.equal(JSON.parse(request.responseText).videoDetails.videoId, "first");

  request.open("POST", "https://m.youtube.com/youtubei/v1/search");
  request.send();
  request.deliver(JSON.stringify({ videoDetails: { videoId: "second" } }));

  assert.equal(
    JSON.parse(request.responseText).videoDetails.videoId,
    "second",
    "the shadowed accessors from the previous response must be gone"
  );
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

test("an ad whose end cannot be reached is silenced and run down at speed", () => {
  const harness = createHarness();
  const player = new FakeElement("div", [".html5-video-player.ad-showing"]);
  const adEvidence = new FakeElement("div", [".ytp-ad-duration-remaining"]);
  const video = new FakeElement("video");

  // The duration is still unknown at the start of the break, so there is
  // nothing to seek to — the point at which a refused seek used to leave the
  // ad playing out loud.
  video.paused = false;
  harness.documentRoot.append(player);
  player.append(adEvidence);
  player.append(video);

  harness.mutationCallback([{ type: "attributes", target: player }]);
  runNextTimeout(harness, 0);

  assert.equal(video.muted, true);
  assert.equal(video.playbackRate, 16);
});

test("content resuming on the shared element gets its sound and speed back", () => {
  const harness = createHarness();
  const player = new FakeElement("div", [".html5-video-player.ad-showing"]);
  const adEvidence = new FakeElement("div", [".ytp-ad-duration-remaining"]);
  const video = new FakeElement("video");

  video.paused = false;
  harness.documentRoot.append(player);
  player.append(adEvidence);
  player.append(video);

  harness.mutationCallback([{ type: "attributes", target: player }]);
  runNextTimeout(harness, 0);
  assert.equal(video.muted, true);

  // The player ends the break by dropping the class the shield was keyed on.
  player.selectors.delete(".html5-video-player.ad-showing");
  harness.intervals[1].callback();

  assert.equal(video.muted, false);
  assert.equal(video.playbackRate, 1);
});

test("a video the user had already muted stays muted after the break", () => {
  const harness = createHarness();
  const player = new FakeElement("div", [".html5-video-player.ad-showing"]);
  const adEvidence = new FakeElement("div", [".ytp-ad-duration-remaining"]);
  const video = new FakeElement("video");

  video.paused = false;
  video.muted = true;
  harness.documentRoot.append(player);
  player.append(adEvidence);
  player.append(video);

  harness.mutationCallback([{ type: "attributes", target: player }]);
  runNextTimeout(harness, 0);

  player.selectors.delete(".html5-video-player.ad-showing");
  harness.intervals[1].callback();

  assert.equal(video.muted, true, "the element is handed back exactly as it was found");
});

test("leaving the foreground hands the element back rather than stranding it", () => {
  const harness = createHarness();
  const player = new FakeElement("div", [".html5-video-player.ad-showing"]);
  const adEvidence = new FakeElement("div", [".ytp-ad-duration-remaining"]);
  const video = new FakeElement("video");

  video.paused = false;
  harness.documentRoot.append(player);
  player.append(adEvidence);
  player.append(video);

  harness.mutationCallback([{ type: "attributes", target: player }]);
  runNextTimeout(harness, 0);
  assert.equal(video.playbackRate, 16);

  // Nothing runs in the background to notice the break ending, so content must
  // never be left muted at sixteen times its speed.
  harness.window.__ytproPrepareForBackground();

  assert.equal(video.muted, false);
  assert.equal(video.playbackRate, 1);
});

test("ordinary content is never silenced or accelerated", () => {
  const harness = createHarness();
  const player = new FakeElement("div", [".html5-video-player"]);
  const video = new FakeElement("video");

  video.duration = 600;
  video.currentTime = 12;
  video.paused = false;
  harness.documentRoot.append(player);
  player.append(video);

  harness.mutationCallback([{ type: "attributes", target: player }]);
  runNextTimeout(harness, 0);

  assert.equal(video.muted, false);
  assert.equal(video.playbackRate, 1);
});

test("a long ad the player is counting down is skipped whatever its length", () => {
  const harness = createHarness();
  const player = new FakeElement("div", [".html5-video-player.ad-showing"]);
  // The ad's own countdown. Nothing but a running ad puts this on screen.
  const adEvidence = new FakeElement("div", [".ytp-ad-duration-remaining"]);
  const video = new FakeElement("video");

  video.duration = 300.581;
  video.currentTime = 1;
  video.paused = false;
  harness.documentRoot.append(player);
  player.append(adEvidence);
  player.append(video);

  harness.mutationCallback([{ type: "attributes", target: player }]);
  runNextTimeout(harness, 0);

  // A break this long refused for exceeding the length cap is exactly what
  // played through in full on device.
  assert.equal(video.currentTime, 300.581);
});

test("a long video behind only a permanent container div is left alone", () => {
  const harness = createHarness();
  const player = new FakeElement("div", [".html5-video-player.ad-showing"]);
  // `.video-ads` sits in the player whether or not an ad is running, so on its
  // own it says nothing about what is on screen now.
  const weakEvidence = new FakeElement("div", [".video-ads"]);
  const video = new FakeElement("video");

  video.paused = false;
  harness.documentRoot.append(player);
  player.append(weakEvidence);
  player.append(video);

  harness.mutationCallback([{ type: "attributes", target: player }]);
  runNextTimeout(harness, 0);
  assert.equal(video.playbackRate, 16, "an unknown duration is shielded on the chance it is an ad");

  video.duration = 600;
  harness.intervals[1].callback();

  assert.equal(video.muted, false);
  assert.equal(video.playbackRate, 1);
  assert.equal(video.currentTime, 0, "the length cap still guards a weak detection");
});

test("a live stream is never silenced or accelerated", () => {
  const harness = createHarness();
  const player = new FakeElement("div", [".html5-video-player.ad-showing"]);
  const adEvidence = new FakeElement("div", [".ytp-ad-duration-remaining"]);
  const video = new FakeElement("video");

  // An unbounded duration is a live stream, never a break — the player has
  // simply not dropped the class yet.
  video.duration = Number.POSITIVE_INFINITY;
  video.paused = false;
  harness.documentRoot.append(player);
  player.append(adEvidence);
  player.append(video);

  harness.mutationCallback([{ type: "attributes", target: player }]);
  runNextTimeout(harness, 0);

  assert.equal(video.muted, false);
  assert.equal(video.playbackRate, 1);
  assert.equal(video.currentTime, 0);
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

test("ordinary and live media are never force-seeked", () => {
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
  assert.equal(ordinaryVideo.currentTime, 12, "a player with no ad class is never touched");
  assert.equal(ordinaryVideo.styleValues.get("opacity"), undefined);

  const adPlayer = new FakeElement("div", ["ytm-player.ad-showing"]);
  const adEvidence = new FakeElement("div", [".ytp-ad-text"]);
  const liveVideo = new FakeElement("video");

  // An unbounded stream is never a break, however strong the evidence looks.
  liveVideo.duration = Number.POSITIVE_INFINITY;
  liveVideo.currentTime = 1;
  liveVideo.paused = false;
  harness.documentRoot.append(adPlayer);
  adPlayer.append(adEvidence);
  adPlayer.append(liveVideo);

  harness.mutationCallback([{ type: "attributes", target: adPlayer }]);
  runNextTimeout(harness, 0);

  assert.equal(liveVideo.currentTime, 1);
  assert.equal(liveVideo.muted, false);
  assert.equal(liveVideo.playbackRate, 1);
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

test("inline playback asks for the floating window, because WebKit never offers it", () => {
  const harness = createHarness();
  const video = attachPlayingVideo(harness);

  harness.window.__ytproPrepareForBackground();

  // `shouldOverrideBackgroundPlaybackRestriction` keeps video decoding alive
  // across the transition only for an element already in the floating window,
  // and WebKit has no automatic-from-inline path at all. Not asking is what
  // left the trip as audio over a frozen picture.
  assert.deepEqual(video.presentationModeRequests, ["picture-in-picture"]);

  harness.window.__ytproDidEnterBackground();

  // WebKit suspends the media session a moment after the app leaves the screen.
  video.paused = true;
  video.dispatch("pause");

  assert.equal(video.playCount, 1);
});

test("a native fullscreen presentation is still left to WebKit's own handover", () => {
  const harness = createHarness();
  const video = attachPlayingVideo(harness);

  video.webkitPresentationMode = "fullscreen";
  harness.window.__ytproPrepareForBackground();

  // AVKit performs this handover itself, and a request placed into its
  // teardown is both silently dropped and destructive — it hides the player
  // view and leaves the media layer detached.
  assert.deepEqual(video.presentationModeRequests, []);
});

test("a request is withheld while a presentation change is still settling", () => {
  const harness = createHarness();
  const video = attachPlayingVideo(harness);

  // WebKit drops any request made while another transition is in flight, so a
  // change this recent means the answer would be silently discarded.
  video.setPresentationMode("inline");
  harness.window.__ytproPrepareForBackground();

  assert.deepEqual(video.presentationModeRequests, []);
});

test("an element that refuses the floating window is not asked for it", () => {
  const harness = createHarness();
  const video = attachPlayingVideo(harness);

  video.supportsPictureInPicture = false;
  harness.window.__ytproPrepareForBackground();

  assert.deepEqual(video.presentationModeRequests, []);
  assert.ok(
    harness.nativeMessages.some(
      (message) => message.type === "log" && message.message.startsWith("pip: refused by the element")
    )
  );
});

test("a window the bridge opened is handed back on the way in", () => {
  const harness = createHarness();
  const video = attachPlayingVideo(harness);

  harness.window.__ytproPrepareForBackground();
  video.setPresentationMode("picture-in-picture");
  harness.window.__ytproDidEnterBackground();
  video.paused = true;

  harness.window.__ytproPrepareForForeground();
  harness.window.__ytproRecoverAfterForeground();

  assert.deepEqual(
    video.presentationModeRequests,
    ["picture-in-picture", "inline"],
    "the bridge opened this window, so the inline player gets its element back"
  );

  video.setPresentationMode("inline");
  runTimeouts(harness, 60);

  assert.equal(video.playCount, 1);
});

test("a window opened for a trip that never happened is closed again", () => {
  const harness = createHarness();
  const video = attachPlayingVideo(harness);

  harness.window.__ytproPrepareForBackground();
  video.setPresentationMode("picture-in-picture");

  // A banner or Control Center deactivated the app without ever backgrounding
  // it, so the window the bridge opened has no trip left to serve.
  harness.window.__ytproCancelBackgroundPreparation();

  assert.deepEqual(video.presentationModeRequests, ["picture-in-picture", "inline"]);
});

test("a page-driven fullscreen layout also has to ask for the window", () => {
  const harness = createHarness();
  const playerShell = new FakeElement("ytm-app", ["ytm-app[player-fullscreen]"]);

  harness.documentRoot.append(playerShell);

  const video = attachPlayingVideo(harness);

  harness.window.__ytproPrepareForBackground();

  // WebKit owns no presentation for a layout the page drew itself, so there is
  // no teardown to fight — and nothing that would happen on its own either.
  assert.deepEqual(video.presentationModeRequests, ["picture-in-picture"]);
});

test("a video stretched over the whole viewport is never asked for fullscreen", () => {
  const harness = createHarness();
  const video = attachPlayingVideo(harness);

  video.rect = { width: 390, height: 844 };
  harness.window.__ytproPrepareForBackground();

  assert.deepEqual(video.presentationModeRequests, ["picture-in-picture"]);
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

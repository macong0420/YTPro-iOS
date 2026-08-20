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
    this.queryCount = 0;
    this.clickCount = 0;
    this.playCount = 0;
    this.presentationModeRequests = [];
    this.listeners = new Map();
    this.paused = true;
    this.ended = false;
    this.webkitPresentationMode = "inline";
    this.styleValues = new Map();
    this.style = {
      setProperty: (name, value) => {
        this.styleValues.set(name, value);
      }
    };
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

  removeAttribute() {
  }

  setAttribute() {
  }

  webkitSetPresentationMode(mode) {
    this.presentationModeRequests.push(mode);
  }

  play() {
    this.paused = false;
    this.playCount += 1;
    return Promise.resolve();
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
  }

  querySelectorAll(selector) {
    this.queryCount += 1;
    return collectMatches([this.documentElement], selector);
  }

  addEventListener() {
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

function createHarness() {
  const documentRoot = new FakeElement("html");
  documentRoot.setConnected(true);
  const document = new FakeDocument(documentRoot);
  const timeouts = [];
  const intervals = [];
  let mutationCallback;

  class FakeMutationObserver {
    constructor(callback) {
      mutationCallback = callback;
    }

    observe() {
    }
  }

  const window = {
    location: { hostname: "m.youtube.com" },
    setTimeout(callback, delay) {
      timeouts.push({ callback, delay });
      return timeouts.length;
    },
    setInterval(callback, delay) {
      intervals.push({ callback, delay });
      return intervals.length;
    }
  };

  vm.runInNewContext(scriptSource, {
    console,
    document,
    MutationObserver: FakeMutationObserver,
    Node: { ELEMENT_NODE: 1 },
    window
  });

  return {
    document,
    documentRoot,
    intervals,
    mutationCallback,
    timeouts,
    window
  };
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
  assert.equal(harness.intervals.length, 1);
  assert.equal(harness.intervals[0].delay, 5000);

  harness.intervals[0].callback();
  assert.ok(harness.document.queryCount > initialDocumentQueries, "the fallback interval should retain a full recovery scan");
});

test("background playback starts only after the app actually enters background", () => {
  assert.match(browserStateSource, /UIApplication\.willResignActiveNotification/);
  assert.match(browserStateSource, /UIApplication\.didEnterBackgroundNotification/);
  assert.match(browserStateSource, /__ytproPrepareForBackground/);
  assert.match(browserStateSource, /__ytproDidEnterBackground/);
  assert.match(browserStateSource, /__ytproPrepareForForeground/);
  assert.match(browserStateSource, /closeAllMediaPresentations/);
});

test("a manually paused video never starts just because the app enters background", () => {
  const harness = createHarness();
  const video = attachPlayingVideo(harness);

  video.paused = true;
  video.dispatch("pause");
  harness.window.__ytproPrepareForBackground();
  harness.window.__ytproSetAppActive(false);

  assert.equal(video.playCount, 0);
  assert.deepEqual(video.presentationModeRequests, []);
});

test("a pause caused during the background transition is recovered once", () => {
  const harness = createHarness();
  const video = attachPlayingVideo(harness);

  harness.window.__ytproPrepareForBackground();
  video.paused = true;
  video.dispatch("pause");

  runTimeouts(harness, 400);

  assert.equal(video.playCount, 1);
  assert.deepEqual(video.presentationModeRequests, ["picture-in-picture"]);
});

test("foreground recovery returns a detached video to inline mode and resumes it", () => {
  const harness = createHarness();
  const video = attachPlayingVideo(harness);

  harness.window.__ytproPrepareForBackground();
  video.webkitPresentationMode = "picture-in-picture";
  video.paused = true;
  harness.window.__ytproSetAppActive(true);

  runTimeouts(harness, 120);

  assert.deepEqual(video.presentationModeRequests, ["picture-in-picture", "inline"]);
  assert.equal(video.playCount, 1);
});

test("a native media close during foreground preparation does not look like a user pause", () => {
  const harness = createHarness();
  const video = attachPlayingVideo(harness);

  harness.window.__ytproPrepareForBackground();
  harness.window.__ytproPrepareForForeground();
  video.paused = true;
  video.dispatch("pause");
  harness.window.__ytproSetAppActive(true);

  runTimeouts(harness, 120);

  assert.equal(video.playCount, 1);
});

test("a later pause in Picture in Picture is treated as a manual pause", () => {
  const harness = createHarness();
  const video = attachPlayingVideo(harness);

  harness.window.__ytproPrepareForBackground();
  video.paused = true;
  video.dispatch("pause");
  runTimeouts(harness, 400);

  video.webkitPresentationMode = "picture-in-picture";
  video.paused = true;
  video.dispatch("pause");

  assert.equal(video.playCount, 1);
});

test("a manual background pause after the transition window is not restarted", () => {
  const harness = createHarness();
  const video = attachPlayingVideo(harness);

  harness.window.__ytproPrepareForBackground();
  runTimeouts(harness, 1500);

  video.paused = true;
  video.dispatch("pause");

  assert.equal(video.playCount, 0);
  assert.equal(harness.timeouts.some((timer) => timer.delay === 400), false);
});

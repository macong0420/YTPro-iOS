// Run: node tests/background-playback.test.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(`${__dirname}/../YTProIOS/Resources/ytpro-adblock.js`, "utf8");

function page(host = "m.youtube.com", audioSession = { state: "active" }) {
  let now = 0;
  const intervals = [];
  const timeouts = [];
  class Target {
    listeners = {};
    addEventListener(name, callback) { (this.listeners[name] ??= []).push(callback); }
    emit(name) { for (const callback of this.listeners[name] ?? []) callback(); }
  }
  class Video extends Target {
    dataset = {};
    paused = true;
    ended = false;
    muted = false;
    volume = 1;
    isConnected = true;
    plays = 0;
    play() {
      this.plays++;
      if (this.rejectPlay) return Promise.reject(new Error("Playback denied"));
      this.paused = false;
      this.emit("play");
      this.emit("playing");
      return Promise.resolve();
    }
    pause() { this.systemPause(); }
    systemPause() { this.paused = true; this.emit("pause"); }
  }
  const video = new Video();
  const idle = new Video();
  const ad = { dataset: {}, styles: {}, style: { setProperty(k, v) { ad.styles[k] = v; } } };
  const skip = { clicks: 0, click() { this.clicks++; } };
  class Document extends Target {
    visibility = "visible";
    readyState = "complete";
    documentElement = {};
    get visibilityState() { return this.visibility; }
    get hidden() { return this.visibility !== "visible"; }
    querySelectorAll(selector) {
      if (selector === "video") return [video, idle];
      if (selector === ".video-ads") return [ad];
      if (selector === ".ytp-ad-skip-button") return [skip];
      return [];
    }
  }
  const document = new Document();
  const window = new Target();
  Object.assign(window, {
    location: { hostname: host },
    setInterval(callback) { intervals.push(callback); },
    setTimeout(callback) { timeouts.push(callback); }
  });
  vm.runInNewContext(source, {
    window, document, Document, HTMLVideoElement: Video,
    navigator: { audioSession }, performance: { now: () => now },
    MutationObserver: class { observe() {} }, Node: { ELEMENT_NODE: 1 },
    console: { warn() {} }
  });
  return {
    document, video, idle, ad, skip, audioSession,
    advance(ms) { now += ms; },
    visibility(value) { document.visibility = value; document.emit("visibilitychange"); },
    timers() { for (const callback of intervals) callback(); for (const callback of timeouts.splice(0)) callback(); }
  };
}

(async () => {
  // Native pause can arrive on either side of visibilitychange. No timer should be needed.
  for (const pauseFirst of [true, false]) {
    const p = page();
    await p.video.play();
    if (pauseFirst) p.video.systemPause();
    p.visibility("hidden");
    if (!pauseFirst) p.video.systemPause();
    assert.equal(p.video.plays, 2, `immediate background recovery, pauseFirst=${pauseFirst}`);
    assert.equal(p.idle.plays, 0, "never start a different/idle video");
    p.video.systemPause();
    p.timers();
    assert.equal(p.video.plays, 2, "do not fight a second pause or system interruption");
    p.visibility("visible");
    await p.video.play();
    p.visibility("hidden");
    p.video.systemPause();
    assert.equal(p.video.plays, 4, "a later background trip can recover again");
  }

  for (const condition of ["explicit", "foreground", "ended", "muted", "silent", "detached", "interrupted", "late", "stale"]) {
    const p = page();
    await p.video.play();
    if (condition === "explicit") p.video.pause();
    if (condition === "ended") p.video.ended = true;
    if (condition === "muted") p.video.muted = true;
    if (condition === "silent") p.video.volume = 0;
    if (condition === "detached") p.video.isConnected = false;
    if (condition === "interrupted") p.audioSession.state = "interrupted";
    if (condition === "stale") { p.video.systemPause(); p.advance(3000); }
    if (condition !== "foreground") p.visibility("hidden");
    if (condition === "late") p.advance(3000);
    if (condition !== "stale") p.video.systemPause();
    p.timers();
    assert.equal(p.video.plays, 1, `must respect ${condition} pause`);
  }

  const rejected = page();
  await rejected.video.play();
  rejected.video.rejectPlay = true;
  rejected.visibility("hidden");
  rejected.video.systemPause();
  await new Promise(setImmediate);
  rejected.timers();
  assert.equal(rejected.video.plays, 2, "a rejected play is handled and not retried forever");

  const ads = page();
  assert.equal(ads.ad.styles.display, "none");
  assert.equal(ads.skip.clicks, 1);
  ads.timers();
  assert.equal(ads.skip.clicks, 2, "ad cleanup still runs every tick");
  assert.equal(ads.document.hidden, false);
  assert.equal(ads.document.visibilityState, "visible");
  assert.equal(ads.audioSession.type, "playback");
  page("m.youtube.com", undefined); // Older WebKit without the Audio Session API.

  for (const host of ["accounts.google.com", "youtube.com.attacker.example"]) {
    const other = page(host);
    other.visibility("hidden");
    assert.equal(other.document.hidden, true, "do not patch non-YouTube pages");
    assert.equal(other.ad.styles.display, undefined);
    assert.equal(other.audioSession.type, undefined);
  }
  console.log("PASS: background transitions, pause intent, interruption bounds, host guard and ad cleanup");
})().catch(error => { console.error(error); process.exitCode = 1; });

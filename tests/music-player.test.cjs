const test = require("node:test");
const assert = require("node:assert/strict");
const FastReadMusic = require("../music-player.js");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class Media extends EventTarget {
  constructor() {
    super();
    this.paused = true;
    this.error = null;
    this.plays = [];
    this.loads = 0;
    this.pauses = 0;
    this.src = "";
    this.volume = 1;
    this.muted = false;
    this.playbackRate = 1;
    this.preservesPitch = true;
    this.currentTime = 0;
  }
  pause() { this.paused = true; this.pauses++; this.dispatchEvent(new Event("pause")); }
  load() { this.loads++; this.error = null; this.currentTime = 0; }
  removeAttribute(name) { if (name === "src") this.src = ""; }
  play() {
    this.paused = false;
    const attempt = deferred();
    attempt.source = this.src;
    this.plays.push(attempt);
    return attempt.promise;
  }
}

function setup() {
  const element = new Media();
  const changes = [], errors = [], successes = [];
  const player = new FastReadMusic({element, fadeInMs:0, fadeOutMs:0, onChange: p => changes.push(p.state), onError: e => errors.push(e), onSuccess: p => successes.push(p.state)});
  assert.equal(changes.length, 0, "construction does not call into a half-initialized UI");
  player.prepare({selection:"first",source:"assets/sounds/first.mp3"});
  return {element, player, changes, errors, successes};
}

test("play reaches the media element synchronously and deduplicates pending starts", async () => {
  const {element,player,successes} = setup();
  const playback = player.play();
  assert.equal(element.plays.length,1,"native play executes inside the original user gesture");
  assert.equal(player.play(),playback);
  assert.equal(player.state,"loading");
  element.plays[0].resolve();
  assert.equal(await playback,true);
  assert.equal(player.state,"playing");
  assert.equal(await player.play(),true);
  assert.equal(element.plays.length,1);
  assert.deepEqual(successes,["playing"]);
});

test("source preparation preserves the media element and does not restart an unchanged source", () => {
  const {element,player} = setup();
  const loads = element.loads;
  assert.equal(player.prepare({selection:"first",source:"assets/sounds/first.mp3"}),false);
  assert.equal(element.loads,loads);
  assert.equal(player.element,element);
  player.prepare(null);
  assert.equal(element.src,"");
  assert.equal(player.state,"idle");
});

test("restoring and automatically changing modes never installs a media source", () => {
  const {element,player} = setup();
  assert.equal(element.src,"");
  assert.equal(element.loads,0);
  assert.equal(element.preload,"none");
  player.prepare({selection:"second",source:"second.mp3"});
  assert.equal(element.src,"");
  assert.equal(element.loads,0);
  assert.equal(element.plays.length,0);
});

test("an explicit preload buffers only the chosen track and playback reuses it", async () => {
  const {element,player} = setup();
  assert.equal(player.preload(),true);
  assert.equal(element.src,"assets/sounds/first.mp3");
  assert.equal(element.paused,true);
  assert.equal(element.loads,1);
  element.currentTime=7;
  assert.equal(player.preload(),true);
  const playback=player.play();
  assert.equal(element.loads,1);
  assert.equal(element.currentTime,7);
  assert.equal(player.preload(),false,"preload cannot interrupt active playback");
  element.plays[0].resolve();
  assert.equal(await playback,true);
  player.destroy();
});

test("changing a buffered selection cancels its source without fetching the next one", () => {
  const {element,player} = setup();
  player.preload();
  player.prepare({selection:"second",source:"second.mp3"});
  assert.equal(element.src,"");
  assert.equal(element.preload,"none");
  assert.equal(element.loads,2,"remove src and load abort the previous media request");
  player.preload();
  assert.equal(element.src,"second.mp3");
  player.destroy();
  assert.equal(element.src,"");
  assert.equal(element.preload,"none");
});

test("pause makes late rejections and late successes harmless", async () => {
  const {element,player,errors,successes} = setup();
  const first = player.play();
  player.pause();
  element.plays[0].reject(Object.assign(new Error("blocked"),{name:"NotAllowedError"}));
  assert.equal(await first,false);
  assert.deepEqual(errors,[]);
  const second = player.play();
  player.pause();
  element.paused = false;
  element.plays[1].resolve();
  assert.equal(await second,false);
  assert.equal(element.paused,true);
  assert.equal(player.state,"paused");
  assert.deepEqual(successes,[]);
});

test("old playback cannot overwrite a newer selection or pause its successful playback", async () => {
  const {element,player,errors} = setup();
  const first = player.play();
  player.prepare({selection:"second",source:"assets/sounds/second.mp3"});
  const second = player.play();
  element.plays[1].resolve();
  assert.equal(await second,true);
  element.plays[0].resolve();
  assert.equal(await first,false);
  assert.equal(element.paused,false);
  assert.equal(player.selection,"second");
  assert.equal(player.state,"playing");
  assert.deepEqual(errors,[]);
});

test("only NotAllowedError is a permission failure and an explicit retry can succeed", async () => {
  const {element,player,errors,successes} = setup();
  const first = player.play();
  element.plays[0].reject(Object.assign(new Error("gesture required"),{name:"NotAllowedError"}));
  assert.equal(await first,false);
  assert.equal(errors[0].kind,"permission");
  const second = player.play();
  assert.equal(element.plays.length,2);
  element.plays[1].resolve();
  assert.equal(await second,true);
  assert.equal(player.error,null);
  assert.equal(successes.length,1);
});

test("resource failures distinguish source, network and decode errors and can reload", async () => {
  for (const [code,kind] of [[2,"network"],[3,"decode"],[4,"source"]]) {
    const {element,player,errors} = setup();
    const playback = player.play();
    element.error = {code};
    element.dispatchEvent(new Event("error"));
    element.plays[0].reject(Object.assign(new Error("bad resource"),{name:"NotSupportedError"}));
    assert.equal(await playback,false);
    assert.equal(errors.length,1);
    assert.equal(errors[0].kind,kind);
    assert.notEqual(errors[0].kind,"permission");
    const loads = element.loads;
    const retry = player.play();
    assert.equal(element.loads,loads+1);
    assert.equal(element.plays.length,2);
    element.plays[1].resolve();
    assert.equal(await retry,true);
  }
});

test("preload failures and AbortError are not shown as playback permission failures", async () => {
  const {element,player,errors} = setup();
  element.error = {code:4};
  element.dispatchEvent(new Event("error"));
  assert.equal(errors.length,0);
  const playback = player.play();
  element.plays[0].reject(Object.assign(new Error("interrupted"),{name:"AbortError"}));
  assert.equal(await playback,false);
  assert.equal(errors.length,0);
  assert.equal(player.state,"paused");
});

test("a queued error from a replaced resource cannot stop the new track", async () => {
  const {element,player,errors} = setup();
  player.prepare({selection:"second",source:"assets/sounds/second.mp3"});
  const playback = player.play();
  element.dispatchEvent(new Event("error"));
  assert.deepEqual(errors,[]);
  element.plays[0].resolve();
  assert.equal(await playback,true);
  assert.equal(player.state,"playing");
});

test("offline built-in tracks offer reconnect advice while local blobs retain their real error", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis,"navigator");
  Object.defineProperty(globalThis,"navigator",{value:{onLine:false},configurable:true});
  try {
    const {element,player,errors} = setup();
    const remote = player.play();
    element.plays[0].reject(Object.assign(new Error("not available"),{name:"NotSupportedError"}));
    assert.equal(await remote,false);
    assert.equal(errors[0].kind,"offline");
    player.prepare({selection:"custom:one",source:"blob:local-track"});
    const local = player.play();
    element.plays[1].reject(Object.assign(new Error("format"),{name:"NotSupportedError"}));
    assert.equal(await local,false);
    assert.equal(errors[1].kind,"source");
  } finally {
    if (descriptor) Object.defineProperty(globalThis,"navigator",descriptor);
    else delete globalThis.navigator;
  }
});

test("destroy cancels pending work and removes media event listeners", async () => {
  const {element,player,errors} = setup();
  const playback = player.play();
  player.destroy();
  element.plays[0].reject(new Error("late"));
  assert.equal(await playback,false);
  element.error={code:4};
  element.dispatchEvent(new Event("error"));
  assert.equal(errors.length,0);
  assert.equal(await player.play(),false);
});

function fakeClock(t) {
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const originalPerformance = Object.getOwnPropertyDescriptor(globalThis,"performance");
  let time = 0, id = 0;
  const timers = new Map();
  globalThis.setTimeout = (callback,delay) => { const key = ++id; timers.set(key,{callback,at:time+Number(delay)}); return key; };
  globalThis.clearTimeout = key => timers.delete(key);
  Object.defineProperty(globalThis,"performance",{value:{now:()=>time},configurable:true});
  t.after(() => {
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
    if (originalPerformance) Object.defineProperty(globalThis,"performance",originalPerformance);
    else delete globalThis.performance;
  });
  return {
    timers,
    async advance(milliseconds) {
      const end = time + milliseconds;
      while (true) {
        const next = [...timers.entries()].filter(([,timer]) => timer.at <= end).sort((a,b) => a[1].at-b[1].at)[0];
        if (!next) break;
        const [key,timer] = next;
        time = timer.at;
        timers.delete(key);
        timer.callback();
        await Promise.resolve();
        await Promise.resolve();
      }
      time = end;
      await Promise.resolve();
      await Promise.resolve();
    }
  };
}

async function startedPlayer(options = {}) {
  const element = new Media();
  const player = new FastReadMusic({element,...options});
  player.prepare({selection:"first",source:"first.mp3"});
  const playback = player.play();
  element.plays[0].resolve();
  assert.equal(await playback,true);
  return {element,player};
}

test("music fades in and out, resumes its position, and completion resets the track", async t => {
  const clock = fakeClock(t);
  const {element,player} = await startedPlayer({volume:.4});
  assert.equal(element.volume,0);
  await clock.advance(175);
  assert.ok(element.volume>0 && element.volume<.4,"fade-in is gradual");
  await clock.advance(175);
  assert.equal(element.volume,.4);
  element.currentTime=12;
  const pausing=player.pause();
  assert.equal(player.state,"paused");
  assert.equal(element.paused,false,"the old sound continues only through fade-out");
  await clock.advance(100);
  assert.ok(element.volume>0 && element.volume<.4);
  await clock.advance(100);
  assert.equal(await pausing,true);
  assert.equal(element.paused,true);
  assert.equal(element.currentTime,12);
  const resumed=player.play();
  assert.equal(element.currentTime,12);
  element.plays[1].resolve();
  await resumed;
  await clock.advance(350);
  const stopped=player.stop();
  await clock.advance(200);
  assert.equal(await stopped,true);
  assert.equal(element.currentTime,0);
  assert.equal(element.paused,true);
  assert.equal(clock.timers.size,0);
});

test("mode transitions fade before switching one element and only the latest choice plays", async t => {
  const clock=fakeClock(t);
  const {element,player}=await startedPlayer();
  await clock.advance(350);
  const first=player.transition({selection:"second",source:"second.mp3"});
  await clock.advance(80);
  assert.equal(element.src,"first.mp3");
  assert.equal(element.plays.length,1);
  const latest=player.transition({selection:"third",source:"third.mp3"});
  player.setVolume(.4);
  await clock.advance(199);
  assert.equal(element.src,"first.mp3");
  await clock.advance(1);
  assert.equal(await first,false);
  assert.equal(element.src,"third.mp3");
  assert.equal(element.volume,0);
  assert.equal(element.plays.length,2);
  assert.deepEqual(element.plays.map(attempt=>attempt.source),["first.mp3","third.mp3"]);
  element.plays[1].resolve();
  assert.equal(await latest,true);
  await clock.advance(350);
  assert.equal(element.volume,.4);
  const silent=player.transition(null);
  await clock.advance(200);
  assert.equal(await silent,false);
  assert.equal(player.state,"idle");
  assert.equal(element.paused,true);
  assert.equal(element.src,"");
  assert.equal(element.plays.length,2);
  player.destroy();
  assert.equal(clock.timers.size,0);
});

test("pause during a mode fade cannot resume the old source, and immediate stop clears resources", async t => {
  const clock=fakeClock(t);
  const {element,player}=await startedPlayer();
  await clock.advance(350);
  const changing=player.transition({selection:"second",source:"second.mp3"});
  await clock.advance(80);
  await player.pause({immediate:true});
  assert.equal(await changing,false);
  const resumed=player.play();
  assert.equal(element.src,"second.mp3");
  assert.equal(element.plays[1].source,"second.mp3");
  element.plays[1].resolve();
  assert.equal(await resumed,true);
  await clock.advance(350);
  element.currentTime=23;
  const pausing=player.pause();
  await clock.advance(50);
  const completion=player.stop();
  const restarted=player.play();
  assert.equal(element.currentTime,0,"rereading during completion fade starts the track again");
  element.plays[2].resolve();
  assert.equal(await restarted,true);
  assert.equal(await pausing,false);
  assert.equal(await completion,false);
  player.destroy();
  assert.equal(element.paused,true);
  assert.equal(clock.timers.size,0);
});

test("volume and mute keep their setting across pause and do not restart music", async t => {
  const clock=fakeClock(t);
  const {element,player}=await startedPlayer({volume:.25});
  await clock.advance(350);
  player.setVolume(.7);
  await clock.advance(90);
  assert.equal(element.volume,.7);
  player.setMuted(true);
  assert.equal(element.muted,true);
  await clock.advance(90);
  assert.equal(element.volume,0);
  assert.equal(player.volume,.7);
  player.setMuted(false);
  await clock.advance(90);
  assert.equal(element.volume,.7);
  assert.equal(element.plays.length,1);
  await player.pause({immediate:true});
  player.setVolume(2);
  assert.equal(player.volume,1);
  player.setVolume(-1);
  assert.equal(player.volume,0);
  assert.equal(element.muted,true);
  player.destroy();
  assert.equal(clock.timers.size,0);
});

test("playback rate changes immediately without preserving pitch or restarting audio", () => {
  const {element,player}=setup();
  assert.equal(element.playbackRate,1);
  assert.equal(element.preservesPitch,false);
  player.setPlaybackRate(1.25);
  assert.equal(element.playbackRate,1.25);
  assert.equal(element.plays.length,0);
  player.setPlaybackRate(4);
  assert.equal(element.playbackRate,1.75);
  player.setPlaybackRate(.1);
  assert.equal(element.playbackRate,.8);
  player.destroy();
});

/* Serve the repo; PLAYWRIGHT_MODULE, CHROME_PATH and BASE_URL match browser.cjs. */
const assert = require("node:assert/strict");
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || "playwright-core");
const modes = require("../music-modes.js");
const baseURL = process.env.BASE_URL || "http://127.0.0.1:4173";

async function open(browser) {
  const context = await browser.newContext({viewport:{width:375,height:667},serviceWorkers:"block"});
  const page = await context.newPage();
  const errors = [], requests = [];
  page.on("pageerror",error => {errors.push(error.message);console.error("Browser error:",error.message);});
  page.on("request",request => { if (/\.mp3(?:\?|$)/i.test(request.url())) requests.push(request.url()); });
  await page.goto(baseURL);
  try {
    await page.waitForFunction(() => document.getElementById("documentMeta").textContent === "Только на устройстве");
  } catch(error) {
    console.error("Initial state:",await page.evaluate(() => ({meta:document.getElementById("documentMeta")?.textContent,status:document.getElementById("statusMessage")?.textContent,ready:document.readyState})),errors);
    await context.close();
    throw error;
  }
  await page.evaluate(() => {
    window.musicPlayCalls = 0;
    const play = FastReadMusic.prototype.play;
    FastReadMusic.prototype.play = function (...args) {
      window.musicPlayCalls += 1;
      return play.apply(this,args);
    };
  });
  return {context,page,errors,requests};
}

async function setVolume(page,id,value) {
  await page.locator(`#${id}`).evaluate((input,volume) => {
    input.value = String(volume);
    input.dispatchEvent(new Event("input",{bubbles:true}));
  },value);
}

async function waitForMusic(page) {
  await page.waitForFunction(() => {
    const audio = document.getElementById("backgroundAudio");
    return !audio.paused && audio.readyState >= 2 && audio.currentTime > .08 && Number.isFinite(audio.duration);
  });
}

(async () => {
  const browser = await chromium.launch({headless:true,...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {})});
  try {
    {
      const {context,page,errors,requests} = await open(browser);
      try {
        await page.waitForTimeout(250);
        assert.deepEqual(requests,[],"opening the app must not request any music");
        assert.equal(await page.locator("#readerMusicModeInput").inputValue(),"adrenaline");
        await page.locator("#settingsTab").click();
        await page.locator("#musicSettingsTab").click();
        await page.locator("#musicAutoInput").check();
        await page.locator("#homeTab").click();
        for (const wpm of [150,500,900,150]) {
          await page.locator("#wpmInput").evaluate((input,value) => {
            input.value=String(value);input.dispatchEvent(new Event("input",{bubbles:true}));
          },wpm);
        }
        await page.waitForTimeout(200);
        assert.deepEqual(requests,[],"automatic recommendations must not request music while stopped");
        assert.equal(await page.locator("#backgroundAudio").getAttribute("src"),null);
        console.log("✓ Opening the app and automatic speed changes request no MP3 files");

        await page.locator("#settingsTab").click();
        await page.locator("#musicSettingsTab").click();
        await page.locator("#musicAutoInput").uncheck();
        // Focus is already selected: this must still explicitly preload it.
        await page.locator("[data-music-mode=focus]").click();
        await page.waitForFunction(() => Boolean(document.getElementById("backgroundAudio").getAttribute("src")));
        await page.waitForTimeout(200);
        assert.ok(requests.length>0,"manual selection starts preparing the chosen track");
        assert.ok(requests.every(url => new URL(url).pathname.endsWith(`/${modes.get("focus").source}`)),"only the chosen track is requested");
        assert.equal(await page.locator("#backgroundAudio").evaluate(audio => audio.paused),true,"prefetch does not start playback");
        assert.equal(await page.locator("#backgroundAudio").evaluate(audio => audio.currentTime),0);
        await setVolume(page,"musicVolumeInput",45);
        await page.locator("#musicMuteBtn").click();
        await page.locator("#musicMuteBtn").click();
        await page.waitForTimeout(300);
        assert.equal(await page.evaluate(() => window.musicPlayCalls),0,"mode, volume and unmute must not call play before Start");
        assert.equal(await page.locator("#backgroundAudio").evaluate(audio => audio.paused && audio.currentTime === 0),true);
        console.log("✓ Choosing and adjusting music prepares it silently until Start");

        await page.locator("#homeTab").click();
        await page.locator("#fileInput").setInputFiles({
          name:"start-only.txt",
          mimeType:"text/plain",
          buffer:Buffer.from("Спокойный поток помогает внимательно читать длинный текст. ".repeat(250))
        });
        await page.waitForFunction(() => document.getElementById("fileName").textContent === "start-only.txt" && !document.getElementById("startBtn").disabled);
        assert.equal(await page.evaluate(() => window.musicPlayCalls),0,"opening a document must not call play");
        await page.locator("#startBtn").click();
        await waitForMusic(page);
        assert.ok((await page.locator("#backgroundAudio").getAttribute("src"))?.endsWith(modes.get("focus").source));
        console.log("✓ Start begins reading and plays the prepared Focus track");

        await page.locator("#pauseBtn").click();
        await page.waitForFunction(() => document.getElementById("backgroundAudio").paused);
        const pausedPlayCalls = await page.evaluate(() => window.musicPlayCalls);
        await page.locator("#readerMusicBtn").click();
        await page.locator("#readerMusicModeInput").selectOption("adrenaline");
        await setVolume(page,"readerMusicVolumeInput",60);
        await page.locator("#readerMusicMuteBtn").click();
        await page.locator("#readerMusicMuteBtn").click();
        await page.waitForTimeout(400);
        assert.equal(await page.locator("#readerStatus").textContent(),"На паузе");
        assert.equal(await page.locator("#backgroundAudio").evaluate(audio => audio.paused && audio.currentTime === 0),true,"adjusting music on pause remains silent");
        assert.equal(await page.evaluate(() => window.musicPlayCalls),pausedPlayCalls,"paused settings must not call play");
        await page.locator("#readerMusicCloseBtn").click();
        await page.locator("#pauseBtn").click();
        await waitForMusic(page);
        assert.ok((await page.locator("#backgroundAudio").getAttribute("src"))?.endsWith(modes.get("adrenaline").source));
        assert.ok(await page.evaluate(() => window.musicPlayCalls) > pausedPlayCalls,"Continue starts the chosen mode");
        console.log("✓ Paused music settings stay silent; Continue plays the new mode");

        await page.locator("#exitBtn").click();
        await page.waitForFunction(() => document.getElementById("backgroundAudio").paused);
        const stoppedPlayCalls = await page.evaluate(() => window.musicPlayCalls);
        await page.locator("#settingsTab").click();
        await page.locator("#musicSettingsTab").click();
        await page.locator("[data-music-mode=jazz]").click();
        await setVolume(page,"musicVolumeInput",35);
        await page.locator("#musicMuteBtn").click();
        await page.locator("#musicMuteBtn").click();
        await page.waitForTimeout(400);
        assert.equal(await page.locator("#backgroundAudio").evaluate(audio => audio.paused && audio.currentTime === 0),true);
        assert.equal(await page.evaluate(() => window.musicPlayCalls),stoppedPlayCalls,"settings after exit must not restart playback");
        assert.deepEqual(errors,[]);
        console.log("✓ Choosing music after leaving the reader stays silent");
      } finally { await context.close(); }
    }

    {
      const {context,page,errors,requests} = await open(browser);
      try {
        await page.locator("#settingsTab").click();
        await page.locator("#musicSettingsTab").click();
        await page.locator("#musicMuteBtn").click();
        await page.locator("#homeTab").click();
        await page.locator("#demoBtn").click();
        await page.waitForFunction(() => Number.parseInt(document.getElementById("readerProgress").textContent,10)>1);
        assert.deepEqual(requests,[],"a muted reader must not download inaudible music");
        assert.equal(await page.evaluate(() => window.musicPlayCalls),0,"muted reading must not call play");
        await page.locator("#readerMusicBtn").click();
        await page.locator("#readerMusicMuteBtn").click();
        await page.waitForFunction(() => {
          const audio=document.getElementById("backgroundAudio");
          return !audio.paused&&audio.readyState>=2&&audio.currentTime>.08;
        });
        assert.ok(requests.length>0);
        assert.ok(requests.every(url => new URL(url).pathname.endsWith(`/${modes.get("adrenaline").source}`)));
        assert.deepEqual(errors,[]);
        console.log("✓ Muted reading stays download-free; unmuting starts the default Adrenaline track");
      } finally { await context.close(); }
    }

    {
      const {context,page,errors} = await open(browser);
      const release = [];
      try {
        await page.route("**/*.mp3",async route => {
          await new Promise(resolve => release.push(resolve));
          try { await route.continue(); } catch (_) { /* Clearing src may already cancel this request. */ }
        });
        const start=Date.now();
        await page.locator("#demoBtn").click();
        await page.waitForFunction(() => document.getElementById("readerScreen").classList.contains("active"),{},{timeout:1500});
        assert.ok(Date.now()-start<1500,"music must not delay entry into the reader");
        await page.waitForFunction(() => Number.parseInt(document.getElementById("readerProgress").textContent,10)>1,{},{timeout:3000});
        assert.ok(release.length>0,"the selected audio request is being held back");
        assert.equal(await page.locator("#backgroundAudio").evaluate(audio => audio.readyState),0);
        assert.match(await page.locator("#readerMusicModeName").textContent(),/загру[зж]/i,"the reader explains that music is loading");
        assert.match(await page.locator("#musicRecommendation").textContent(),/загру[зж]/i,"settings explain that music is loading");
        assert.equal(await page.locator("#readerMusicNotice").isVisible(),false,"slow loading is not a playback error");
        await page.locator("#readerMusicBtn").click();
        await page.locator("#readerMusicModeInput").selectOption("silence");
        await page.waitForFunction(() => {
          const audio=document.getElementById("backgroundAudio");
          return audio.paused&&!audio.getAttribute("src");
        });
        for (const resume of release.splice(0)) resume();
        await page.waitForTimeout(200);
        assert.equal(await page.locator("#backgroundAudio").evaluate(audio => audio.paused),true);
        assert.equal(await page.locator("#readerMusicNotice").isVisible(),false);
        assert.equal(await page.locator("#readerMusicModeInput").inputValue(),"silence");
        assert.deepEqual(errors,[]);
        console.log("✓ Delayed music never blocks RSVP; Silence cancels it and late responses stay harmless");
      } finally {
        for (const resume of release.splice(0)) resume();
        await context.close();
      }
    }
  } finally { await browser.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});

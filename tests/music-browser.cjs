/* Serve the repo; PLAYWRIGHT_MODULE, CHROME_PATH and BASE_URL match browser.cjs. */
const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const modes = require('../music-modes.js');
const baseURL = process.env.BASE_URL || 'http://127.0.0.1:4173';
const errors = [];
async function open(browser, init) {
  const context = await browser.newContext({viewport:{width:375,height:667},serviceWorkers:'block'});
  if(init) await context.addInitScript(init);
  const page = await context.newPage();
  page.on('pageerror',e=>{errors.push(e.message);console.error(e.message);});
  page.on('requestfailed',r=>{if(r.failure()?.errorText!=='net::ERR_ABORTED')console.error('Request failed:',r.url(),r.failure()?.errorText);});
  await page.goto(baseURL);
  await page.waitForFunction(()=>document.getElementById('documentMeta').textContent==='Только на устройстве');
  return {context,page};
}
async function settings(page,mode) {
  await page.locator('#settingsTab').click();await page.locator('#musicSettingsTab').click();
  if(mode) await page.locator(`[data-music-mode=${mode}]`).click();
}
async function speed(page,value) {
  await page.locator('#homeTab').click();
  await page.locator('#wpmInput').evaluate((e,v)=>{e.value=String(v);e.dispatchEvent(new Event('input',{bubbles:true}));},value);
}
async function upload(page,text='Музыка помогает держать спокойный ритм чтения. '.repeat(100)) {
  await page.locator('#homeTab').click();
  await page.locator('#fileInput').setInputFiles({name:'music-reading.txt',mimeType:'text/plain',buffer:Buffer.from(text)});
  await page.waitForFunction(()=>!document.getElementById('startBtn').disabled&&document.getElementById('fileName').textContent==='music-reading.txt');
}
async function playing(page,mode,minimum=.08) {
  await page.waitForFunction(({source,minimum})=>{
    const a=document.getElementById('backgroundAudio');
    return !a.paused&&a.readyState>=2&&a.currentTime>minimum&&Number.isFinite(a.duration)&&a.duration>1&&a.currentSrc.endsWith(source);
  },{source:modes.get(mode).source,minimum});
}
async function saved(page) {return page.evaluate(()=>JSON.parse(localStorage.getItem('speedReaderState')).settings);}
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
 try {
  {
   const {context,page}=await open(browser);
   assert.equal(await page.evaluate(()=>typeof FastReadAudio),'undefined');
   await settings(page);assert.equal(await page.locator('#musicVolumeInput').inputValue(),'25');
   assert.equal(await page.locator('#musicAutoInput').isChecked(),false);
   assert.equal(await page.locator('#readerMusicModeInput').inputValue(),'adrenaline');
   await speed(page,900);
   assert.equal(await page.locator('#readerMusicModeInput').inputValue(),'adrenaline','default music does not change with reading speed');
   await settings(page);await page.locator('#musicAutoInput').check();
   for(const [wpm,expected] of [[150,'focus'],[290,'focus'],[300,'jazz'],[490,'jazz'],[500,'hyperflow'],[790,'hyperflow'],[800,'extreme'],[1200,'extreme']]) {
    await speed(page,wpm);assert.equal(await page.locator('#readerMusicModeInput').inputValue(),expected);
    assert.equal(await page.locator('#backgroundAudio').evaluate(a=>a.paused),true);
   }
   await settings(page,'adrenaline');assert.equal(await page.locator('#musicAutoInput').isChecked(),false);
   await speed(page,200);assert.equal(await page.locator('#readerMusicModeInput').inputValue(),'adrenaline');
   await settings(page);assert.ok((await page.locator('#musicRecommendation').textContent()).includes('Focus'));
   await page.locator('#musicVolumeInput').evaluate(e=>{e.value='37';e.dispatchEvent(new Event('input',{bubbles:true}));});
   await page.locator('#musicMuteBtn').click();await page.reload();await settings(page);
   assert.equal(await page.locator('#musicVolumeInput').inputValue(),'37');
   assert.equal(await page.locator('#musicMuteBtn').getAttribute('aria-pressed'),'true');
   assert.equal(await page.locator('[data-music-mode=adrenaline]').getAttribute('aria-pressed'),'true');
   assert.equal(await page.locator('#musicAutoInput').isChecked(),false);
   await page.locator('#musicAutoInput').check();assert.equal((await saved(page)).musicMode,'focus');
   await context.close();console.log('✓ Recommendations, manual mode, 1200 WPM, volume and mute persist');
  }
  {
   const {context,page}=await open(browser);
   await page.evaluate(()=>{
    window.sourceChanges=[];window.nativePlays=0;
    const desc=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'src');
    Object.defineProperty(HTMLMediaElement.prototype,'src',{...desc,set(value){if(this.id==='backgroundAudio')window.sourceChanges.push({paused:this.paused,value});desc.set.call(this,value);}});
    const native=HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play=function(...args){if(this.id==='backgroundAudio')window.nativePlays++;return native.apply(this,args);};
    const play=FastReadMusic.prototype.play;
    FastReadMusic.prototype.play=function(...args){window.livePlayer=this;return play.apply(this,args);};
   });
   await upload(page);await speed(page,800);await settings(page,'focus');
   assert.equal(await page.evaluate(()=>window.nativePlays),0,'choosing music does not start playback');
   await page.locator('#homeTab').click();await page.locator('#startBtn').click();await playing(page,'focus');
   const early=await page.evaluate(()=>window.livePlayer._gain?.gain.value??document.getElementById('backgroundAudio').volume);
   await page.waitForTimeout(400);
   const full=await page.evaluate(()=>window.livePlayer._gain?.gain.value??document.getElementById('backgroundAudio').volume);
   assert.ok(full>=early&&Math.abs(full-.25)<.015,'fade reaches chosen level');
   await page.waitForTimeout(700);
   assert.equal(await page.evaluate(()=>window.nativePlays),1,'words do not start individual sounds');
   await page.locator('#pauseBtn').click();await page.waitForFunction(()=>document.getElementById('backgroundAudio').paused);
   const paused=await page.locator('#backgroundAudio').evaluate(a=>a.currentTime);await page.waitForTimeout(150);
   assert.ok(Math.abs(await page.locator('#backgroundAudio').evaluate(a=>a.currentTime)-paused)<.03);
   await page.locator('#pauseBtn').click();await playing(page,'focus',paused+.08);
   await page.locator('#readerMusicBtn').click();await page.locator('#readerMusicModeInput').selectOption('hyperflow');await playing(page,'hyperflow');
   assert.equal(await page.locator('audio').count(),1);
   assert.ok((await page.evaluate(()=>window.sourceChanges)).every(c=>c.paused),'sources switch only after old track stops');
   await page.locator('#readerMusicModeInput').selectOption('silence');
   await page.waitForFunction(()=>document.getElementById('backgroundAudio').paused&&!document.getElementById('backgroundAudio').getAttribute('src'));
   await page.locator('#readerMusicModeInput').selectOption('focus');await playing(page,'focus');
   await page.locator('#readerMusicModeInput').selectOption('adrenaline');await playing(page,'adrenaline');
   assert.equal(await page.locator('#readerStatus').textContent(),'В вашем ритме');
   await page.locator('#readerMusicVolumeInput').evaluate(e=>{e.value='42';e.dispatchEvent(new Event('input',{bubbles:true}));});
   await page.locator('#readerMusicMuteBtn').click();assert.equal(await page.locator('#backgroundAudio').evaluate(a=>a.muted),true);
   assert.equal((await saved(page)).musicVolume,42);await page.locator('#readerMusicMuteBtn').click();
   await page.locator('#readerMusicCloseBtn').click();await page.locator('#exitBtn').click();await upload(page,'Готово.');await page.locator('#startBtn').click();
   await page.waitForFunction(()=>document.getElementById('readerScreen').dataset.mode==='complete');
   await page.waitForFunction(()=>document.getElementById('backgroundAudio').paused&&document.getElementById('backgroundAudio').currentTime===0);
   await context.close();console.log('✓ Real media fades, resumes, switches sequentially, follows reader controls and resets on completion');
  }
  {
   const {context,page}=await open(browser);await upload(page);await settings(page,'focus');
   await page.evaluate(()=>{const native=HTMLMediaElement.prototype.play;let once=true;HTMLMediaElement.prototype.play=function(...args){if(this.id==='backgroundAudio'&&once){once=false;return Promise.reject(new DOMException('gesture required','NotAllowedError'));}return native.apply(this,args);};});
   await page.locator('#homeTab').click();await page.locator('#startBtn').click();await page.locator('#readerMusicNotice').waitFor({state:'visible'});
   await page.locator('#readerMusicRetryBtn').click();await playing(page,'focus');assert.equal(await page.locator('#readerMusicNotice').isVisible(),false);
   assert.equal(await page.locator('#readerStatus').textContent(),'В вашем ритме');await page.locator('#exitBtn').click();
   await page.route('**/assets/sounds/alex-morgan-techno-warehouse-537487.mp3',r=>r.fulfill({status:404,contentType:'text/plain',body:'Missing audio'}));
   await settings(page,'extreme');await page.locator('#homeTab').click();await page.locator('#startBtn').click();await page.locator('#readerMusicNotice').waitFor({state:'visible'});
   const message=await page.locator('#readerMusicMessage').textContent();assert.ok(message.includes('недоступна')||message.includes('загрузить'));assert.ok(!message.includes('отдельное нажатие'));
   await page.locator('#readerMusicBtn').click();await page.locator('#readerMusicModeInput').selectOption('silence');assert.equal(await page.locator('#readerMusicNotice').isVisible(),false);
   await context.close();console.log('✓ Permission retry and missing-file recovery preserve RSVP');
  }
  {
   const {context,page}=await open(browser,()=>{
    window.musicGesture=false;window.musicCalls=[];window.musicUnlocked=false;
    const add=EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener=function(type,listener,options){if(type!=='click'||typeof listener!=='function')return add.call(this,type,listener,options);return add.call(this,type,function(event){window.musicGesture=event.isTrusted;window.musicTarget=event.target.closest?.('button');queueMicrotask(()=>window.musicGesture=false);return listener.call(this,event);},options);};
    const native=HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play=function(...args){if(this.id!=='backgroundAudio')return native.apply(this,args);window.musicCalls.push({gesture:window.musicGesture,document:window.musicTarget?.dataset.openDocument||''});if(!window.musicUnlocked&&!window.musicGesture)return Promise.reject(new DOMException('expired gesture','NotAllowedError'));return native.apply(this,args).then(()=>window.musicUnlocked=true);};
   });
   await upload(page);await settings(page,'focus');await page.locator('#libraryTab').click();await page.locator('[data-open-document]').first().click();await playing(page,'focus');
   const calls=await page.evaluate(()=>window.musicCalls);assert.equal(calls[0].gesture,true);assert.ok(calls[0].document);
   await context.close();console.log('✓ Saved-library music starts inside the trusted click before asynchronous loading');
  }
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});

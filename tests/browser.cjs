/* Optional integration checks. Serve the repo, install playwright-core separately,
   then set PLAYWRIGHT_MODULE / CHROME_PATH if they are outside the default paths. */
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright-core");
const baseURL = process.env.BASE_URL || "http://127.0.0.1:4173";

function pdfFixture() {
  const stream = "BT /F1 12 Tf 50 750 Td (Hello PDF reader) Tj 0 -20 Td (const value = 42;) Tj 0 -20 Td (console.log\(value\);) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  ];
  let value = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(value));
    value += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(value);
  value += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(value);
}

async function upload(page, name, content, mimeType = "text/plain") {
  await page.locator("#fileInput").setInputFiles({ name, mimeType, buffer: Buffer.isBuffer(content) ? content : Buffer.from(content) });
  await page.waitForFunction(name => document.getElementById("fileName").textContent === name && !document.getElementById("startBtn").disabled, name);
}

async function cachedDocuments(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open("speedReaderCache", 2);
    request.onsuccess = () => {
      const db = request.result;
      const read = db.transaction("documents").objectStore("documents").getAll();
      read.onsuccess = () => { resolve(read.result); db.close(); };
      read.onerror = () => reject(read.error);
    };
    request.onerror = () => reject(request.error);
  }));
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const failures = [];
  const context = await browser.newContext({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.on("pageerror", error => { failures.push(error.message); console.error("Browser error:", error.message); });
  try {
    await page.goto(baseURL);
    await page.waitForFunction(() => document.getElementById("documentMeta").textContent === "Только на устройстве");
    assert.equal(await page.locator("#startBtn").isDisabled(), true);

    for (const [width, height] of [[320,568], [375,667], [390,844], [667,375], [1440,900]]) {
      await page.setViewportSize({width,height});
      await page.locator("#homeTab").click();
      const home = await page.evaluate(() => {
        const button = document.getElementById("startBtn").getBoundingClientRect();
        const nav = document.querySelector(".bottom-nav").getBoundingClientRect();
        return { height: document.documentElement.scrollHeight, width: document.documentElement.scrollWidth, button: button.bottom, nav: nav.top };
      });
      assert.ok(home.height <= height && home.width <= width && home.button <= home.nav, `home fits ${width}×${height}`);
      await page.locator("#settingsTab").click();
      await page.waitForFunction(() => document.getElementById("settingsTab").getAttribute("aria-selected") === "true");
      for (const tab of ["reading", "music"]) {
        await page.locator(`[data-settings-tab=${tab}]`).click();
        const dimensions = await page.locator(`#${tab}Settings`).evaluate(element => ({height: element.clientHeight, scroll: element.scrollHeight}));
        assert.ok(dimensions.scroll <= dimensions.height + 1, `${tab} settings fit ${width}×${height}: ${JSON.stringify(dimensions)}`);
      }
    }
    console.log("✓ Mobile, landscape and desktop screens fit without scrolling");

    await page.setViewportSize({width:375,height:667});
    await page.locator("#musicSettingsTab").click();
    await page.locator('[data-music-mode="silence"]').click();
    await page.locator("#readingSettingsTab").click();
    await page.locator("#themeInput").selectOption("oled");
    await page.locator("#homeTab").click();
    await page.locator("#demoBtn").click();
    await page.waitForFunction(() => document.getElementById("readerScreen").classList.contains("active"));
    assert.equal(await page.locator("#readerDocumentTitle").textContent(), "Знакомство с FastRead.md");
    const demoProgress = await page.locator("#readerProgress").textContent();
    await page.waitForFunction(progress => document.getElementById("readerProgress").textContent !== progress, demoProgress, {timeout:3000});
    assert.equal(await page.locator("#readerStatus").textContent(), "В вашем ритме");
    await page.locator("#exitBtn").click();
    console.log("✓ The example button immediately starts reading and advances through the text");
    await upload(page, "meaning.md", '# Полезный заголовок\n\n**Один** [два](https://example.com) (три [четыре пять]) «шесть семь».\n\n```js\nconst answer = 42;\n```\n\n| Имя | Значение |\n| --- | --- |\n| Ответ | 42 |');
    let saved = (await cachedDocuments(page)).find(item => item.fileName === "meaning.md");
    assert.equal(saved.words[0].type, "heading");
    assert.ok(saved.words.some(item => item.type === "group" && item.text === "(три [четыре пять])"));
    assert.ok(saved.words.some(item => item.type === "table"));
    assert.ok(!JSON.stringify(saved.words).includes("https://example.com"));
    await page.reload();
    await page.waitForFunction(() => !document.getElementById("startBtn").disabled);
    assert.equal(await page.locator("html").getAttribute("data-theme"), "oled");
    console.log("✓ Markdown uses formatted content; documents and settings survive reload");

    const longCode = Array.from({length:60}, (_, index) => `const line${index + 1} = "значение ${index + 1}";`).join("\n");
    await upload(page, "code.md", `\`\`\`js\n${longCode}\n\`\`\`\n\nПосле кода текст продолжается.`);
    await page.locator("#startBtn").click();
    await page.waitForFunction(() => document.getElementById("readerStatus").textContent === "Пауза для фрагмента");
    const progress = await page.locator("#readerProgress").textContent();
    await page.waitForTimeout(2900);
    assert.equal(await page.locator("#readerProgress").textContent(), progress);
    assert.equal(await page.locator("#pauseBtn").getAttribute("aria-label"), "Продолжить");
    const pageCount = Number((await page.locator("#codePageLabel").textContent()).split("/")[1].trim());
    assert.ok(pageCount > 1);
    for (let index = 0; index < pageCount; index++) {
      const bounds = await page.locator("#codeContent").evaluate(element => ({height:element.clientHeight,scroll:element.scrollHeight,width:element.clientWidth,scrollWidth:element.scrollWidth,stage:document.querySelector('.reader-stage').clientHeight,card:document.getElementById('codeCard').clientHeight,lineHeight:getComputedStyle(element).lineHeight}));
      assert.ok(bounds.scroll <= bounds.height + 1 && bounds.scrollWidth <= bounds.width + 1, `code page ${index + 1} fits without scrolling: ${JSON.stringify(bounds)}`);
      if (index < pageCount - 1) await page.locator("#codePageNextBtn").click();
    }
    assert.ok((await page.locator("#codeContent").textContent()).includes("line60"));
    for (const [width,height] of [[320,568],[667,375],[390,844],[375,667]]) {
      await page.setViewportSize({width,height});
      await page.waitForTimeout(50);
      const fits = await page.locator("#codeContent").evaluate(element => element.scrollHeight <= element.clientHeight + 1 && element.scrollWidth <= element.clientWidth + 1);
      assert.ok(fits, `code reflows without scrolling at ${width}×${height}`);
      const continueButton = await page.locator("#codeContinueBtn").boundingBox();
      assert.ok(continueButton.y >= 0 && continueButton.y + continueButton.height <= height, "continue remains reachable");
    }
    await page.locator("#exitBtn").click();
    await page.locator("#startBtn").click();
    await page.waitForFunction(() => document.getElementById("readerStatus").textContent === "Пауза для фрагмента");
    assert.ok((await page.locator("#codeContent").textContent()).includes("line1"));
    await page.locator("#exitBtn").click();
    await page.reload();
    await page.waitForFunction(() => !document.getElementById("startBtn").disabled);
    await page.locator("#startBtn").click();
    await page.waitForFunction(() => document.getElementById("readerStatus").textContent === "Пауза для фрагмента");
    await page.locator("#codeContinueBtn").click();
    await page.waitForFunction(() => document.getElementById("readerScreen").dataset.mode === "word");
    await page.locator("#pauseBtn").click();
    await page.locator("#exitBtn").click();
    console.log("✓ Code waits for the user, paginates, resumes and restores at the same fragment");

    await upload(page, "last-code.md", "```python\nprint('Готово')\n```");
    await page.locator("#startBtn").click();
    await page.waitForFunction(() => document.getElementById("readerStatus").textContent === "Пауза для фрагмента");
    await page.locator("#codeContinueBtn").click();
    await page.waitForFunction(() => document.getElementById("readerScreen").dataset.mode === "complete");
    await page.locator("#pauseBtn").click();
    await page.waitForFunction(() => document.getElementById("readerScreen").dataset.mode === "code");
    await page.locator("#exitBtn").click();
    console.log("✓ A final code fragment completes correctly and can be reread");

    await upload(page, "sample.pdf", pdfFixture(), "application/pdf");
    saved = (await cachedDocuments(page)).find(item => item.fileName === "sample.pdf");
    assert.deepEqual(saved.words.slice(0,3), ["Hello", "PDF", "reader"]);
    assert.ok(saved.words.some(item => item.type === "code" && item.text.includes("const value")));
    await page.locator("#fileInput").setInputFiles({name:"empty.txt",mimeType:"text/plain",buffer:Buffer.from("")});
    await page.waitForFunction(() => document.getElementById("statusMessage").textContent.includes("нет текста"));
    assert.equal(await page.locator("#fileName").textContent(), "sample.pdf");
    assert.equal(await page.locator("#startBtn").isDisabled(), false);
    console.log("✓ PDF extraction and code detection work; failed imports retain the open document");

    await page.locator("#libraryTab").click();
    const beforeExtras = (await cachedDocuments(page)).length;
    const pagesBefore = Math.max(1, Math.ceil(beforeExtras / 4));
    assert.equal(await page.locator("#libraryPageLabel").textContent(), `1 / ${pagesBefore}`);
    for (let index=0; index<3; index++) {
      await page.locator("#homeTab").click();
      await upload(page, `extra-${index}.txt`, "Текст для локальной библиотеки.");
    }
    await page.locator("#libraryTab").click();
    const pageTotal = Math.ceil((await cachedDocuments(page)).length / 4);
    assert.ok(pageTotal >= 2);
    assert.equal(await page.locator("#libraryPageLabel").textContent(), `1 / ${pageTotal}`);
    await page.locator("#libraryNextBtn").click();
    assert.equal(await page.locator("#libraryPageLabel").textContent(), `2 / ${pageTotal}`);
    console.log("✓ Local library is paginated without page scrolling");

    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await context.setOffline(true);
    await page.reload();
    await page.waitForFunction(() => !document.getElementById("startBtn").disabled);
    await page.locator("#demoBtn").click();
    await page.waitForFunction(() => document.getElementById("readerScreen").classList.contains("active") && document.getElementById("readerDocumentTitle").textContent === "Знакомство с FastRead.md");
    await page.locator("#exitBtn").click();
    await upload(page, "offline.pdf", pdfFixture(), "application/pdf");
    console.log("✓ The app, Markdown and PDF import work after going offline");
    await context.setOffline(false);

    const blockedContext = await browser.newContext({serviceWorkers:"block"});
    await blockedContext.addInitScript(() => {
      localStorage.setItem("speedReaderState", JSON.stringify({settings:{wpm:300,theme:"paper",musicMode:"silence",musicAutomatic:false,musicVolume:25,musicMuted:false}}));
      indexedDB.open = () => { throw new DOMException("Local storage is blocked", "SecurityError"); };
    });
    const blockedPage = await blockedContext.newPage();
    blockedPage.on("pageerror", error => failures.push(error.message));
    await blockedPage.goto(baseURL);
    await blockedPage.locator("#demoBtn").click();
    await blockedPage.waitForFunction(() => document.getElementById("readerScreen").classList.contains("active"));
    const blockedProgress = await blockedPage.locator("#readerProgress").textContent();
    await blockedPage.waitForFunction(progress => document.getElementById("readerProgress").textContent !== progress, blockedProgress, {timeout:3000});
    await blockedContext.close();
    console.log("✓ The example still starts when browser document storage is unavailable");

    const migrationContext = await browser.newContext({serviceWorkers:"block"});
    const migrationPage = await migrationContext.newPage();
    migrationPage.on("pageerror", error => failures.push(error.message));
    await migrationPage.route("**/app.js", route => route.abort());
    await migrationPage.goto(baseURL);
    await migrationPage.evaluate(() => new Promise((resolve,reject) => {
      const words = ["первое", "второе", "(три", "четыре)", "пять", "шесть"];
      const request = indexedDB.open("speedReaderCache",2);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("documents",{keyPath:"id"});
        request.result.createObjectStore("customSounds",{keyPath:"id"});
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("documents","readwrite");
        tx.objectStore("documents").put({id:"legacy",fileName:"old.txt",file:new File(["первое второе (три четыре) пять шесть"],"old.txt",{type:"text/plain"}),words,index:0,updatedAt:1});
        tx.oncomplete = () => {
          localStorage.setItem("speedReaderState", JSON.stringify({documentId:"legacy",fileName:"old.txt",index:4,total:6,settings:{wpm:300,theme:"paper",sound:"off",music:"off",ambient:0}}));
          db.close();resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    }));
    await migrationPage.unroute("**/app.js");
    await migrationPage.reload();
    await migrationPage.waitForFunction(() => !document.getElementById("startBtn").disabled);
    const migrated = (await cachedDocuments(migrationPage))[0];
    assert.equal(migrated.parserVersion,2);
    assert.equal(migrated.words.length,5);
    assert.equal(migrated.index,3);
    await migrationPage.locator("#startBtn").click();
    await migrationPage.waitForFunction(() => document.getElementById("wordDisplay").textContent === "пять");
    await migrationContext.close();
    console.log("✓ Existing library migration preserves the latest reading position");
    assert.deepEqual(failures, []);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

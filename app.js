(() => {
  "use strict";

  const STORAGE_KEY = "speedReaderState";
  const CACHE_DB_NAME = "speedReaderCache";
  const CACHE_STORE_NAME = "documents";
  const SOUND_STORE_NAME = "customSounds";
  const MODES = window.FastReadModes;
  const DEFAULT_SETTINGS = { wpm: 300, theme: "oled", musicMode: "adrenaline", musicAutomatic: false, musicVolume: 25, musicMuted: false };
  const THEME_NAMES = new Set(["oled", "midnight", "grey", "paper"]);
  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "assets/vendor/pdf.worker.min.js";
  }

  const $ = (id) => document.getElementById(id);
  const fileInput = $("fileInput");
  const fileNameDisplay = $("fileName");
  const wpmInput = $("wpmInput");
  const wpmValue = $("wpmValue");
  const themeInput = $("themeInput");
  const setupScreen = $("setupScreen");
  const readerScreen = $("readerScreen");
  const wordDisplay = $("wordDisplay");
  const wordBefore = wordDisplay.querySelector(".word-before");
  const wordFocus = wordDisplay.querySelector(".word-focus");
  const wordAfter = wordDisplay.querySelector(".word-after");
  let wordArrivalAnimation = null;
  const readerProgress = $("readerProgress");
  const codeCard = $("codeCard");
  const codeContent = $("codeContent");
  const pauseBtn = $("pauseBtn");
  const statusMessage = $("statusMessage");
  const savedDocumentsList = $("savedDocumentsList");
  const savedDocumentCount = $("savedDocumentCount");

  let words = [];
  let currentIndex = 0;
  let currentFileName = "";
  let currentDocumentId = "";
  let isPlaying = false;
  let timer = null;
  let displayedIndex = -1;
  let holdingCode = false;
  let codePages = [];
  let codePageIndex = 0;
  let libraryPage = 0;
  let lastProgressSave = 0;
  let loadingFile = false;
  let importGeneration = 0;
  let activeTab = "home";
  let countedWords = null;
  let documentWordCount = 0;
  const backgroundAudio = $("backgroundAudio");
  let musicFailure = null;
  let musicMode = DEFAULT_SETTINGS.musicMode;
  let musicAutomatic = false;
  let musicVolume = 25;
  let musicMuted = false;
  const musicPlayer = new window.FastReadMusic({
    element: backgroundAudio,
    onChange: updateMusicControls,
    onError: showMusicError,
    onSuccess: clearMusicError
  });
  backgroundAudio.loop = true;
  backgroundAudio.preload = "none";
  let cachedDocuments = [];
  let savedState = readSavedState();
  let touchStart = null;
  let ignoreClickUntil = 0;

  applySettings(savedState?.settings || DEFAULT_SETTINGS);
  updateMusicControls();

  function readSavedState() {
    try {
      const value = localStorage.getItem(STORAGE_KEY);
      if (!value) return null;
      const parsed = JSON.parse(value);
      if (!parsed || typeof parsed !== "object") return null;
      const settings = parsed.settings && typeof parsed.settings === "object"
        ? parsed.settings : {};
      return {
        fileName: typeof parsed.fileName === "string" ? parsed.fileName : "",
        documentId: typeof parsed.documentId === "string" ? parsed.documentId : "",
        index: Number.isInteger(parsed.index) && parsed.index >= 0 ? parsed.index : 0,
        total: Number.isInteger(parsed.total) && parsed.total > 0 ? parsed.total : 0,
        settings: {
          wpm: clamp(Number(settings.wpm) || DEFAULT_SETTINGS.wpm, 100, 1200),
          theme: THEME_NAMES.has(settings.theme) ? settings.theme : DEFAULT_SETTINGS.theme,
          ...readMusicSettings(settings)
        }
      };
    } catch (error) {
      console.error("Не удалось прочитать сохранённый прогресс.", error);
      setStatus("Не удалось прочитать сохранённый прогресс в этом браузере.");
      return null;
    }
  }

  function readMusicSettings(settings) {
    const valid = MODES.isValid(settings.musicMode);
    const legacy = !valid && typeof settings.music === "string";
    let mode = valid ? settings.musicMode : DEFAULT_SETTINGS.musicMode;
    if (legacy) {
      mode = settings.sound === "heartbeat" ? "adrenaline"
        : settings.music === "off" || settings.music.startsWith("custom:") ? "silence"
        : /horror|dark/i.test(settings.music) ? "adrenaline"
        : /synthwave/i.test(settings.music) ? "hyperflow" : "focus";
    }
    const automatic = valid && settings.musicAutomatic === true;
    return {
      musicMode: automatic ? MODES.recommend(Number(settings.wpm) || 300) : mode,
      musicAutomatic: automatic,
      musicVolume: settings.musicVolume != null && Number.isFinite(Number(settings.musicVolume)) ? clamp(Number(settings.musicVolume), 0, 100) : 25,
      musicMuted: settings.musicMuted === true
    };
  }

  function getSettings() {
    return { wpm: Number(wpmInput.value), theme: themeInput.value, musicMode, musicAutomatic, musicVolume, musicMuted };
  }

  function applySettings(settings) {
    wpmInput.value = String(settings.wpm);
    themeInput.value = settings.theme;
    musicMode = settings.musicAutomatic ? MODES.recommend(settings.wpm) : settings.musicMode;
    musicAutomatic = settings.musicAutomatic;
    musicVolume = settings.musicVolume;
    musicMuted = settings.musicMuted;
    document.documentElement.dataset.theme = settings.theme;
    document.querySelector('meta[name="theme-color"]').content = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
    wpmValue.textContent = String(settings.wpm);
    $("readerWpm").textContent = String(settings.wpm);
    musicPlayer.setVolume(musicVolume / 100);
    musicPlayer.setMuted(musicMuted);
    musicPlayer.setPlaybackRate(readingMusicPlaybackRate(settings.wpm));
    configureBackgroundMusic();
    updateMusicControls();
  }

  function positionToSave() {
    return holdingCode ? Math.max(0, currentIndex - 1) : currentIndex;
  }

  function saveState() {
    const state = {
      fileName: currentFileName || savedState?.fileName || "",
      documentId: currentDocumentId || savedState?.documentId || "",
      index: currentFileName ? positionToSave() : (savedState?.index || 0),
      total: words.length || savedState?.total || 0,
      settings: getSettings()
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      savedState = state;
    } catch (error) {
      console.error("Не удалось сохранить прогресс.", error);
      setStatus("Не удалось сохранить прогресс в этом браузере.");
    }
    if (currentDocumentId) {
      const cached = cachedDocuments.find((item) => item.id === currentDocumentId);
      if (cached) cached.index = state.index;
      updateCachedProgress(currentDocumentId, state.index).catch((error) => {
        console.error("Не удалось сохранить позицию.", error);
        setStatus("Не удалось сохранить позицию в локальной библиотеке.");
      });
    }
    lastProgressSave = Date.now();
    updateSelectedDocument();
  }

  function openCacheDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(CACHE_DB_NAME, 2);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(CACHE_STORE_NAME)) {
          database.createObjectStore(CACHE_STORE_NAME, { keyPath: "id" });
        }
        if (!database.objectStoreNames.contains(SOUND_STORE_NAME)) {
          database.createObjectStore(SOUND_STORE_NAME, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Не удалось открыть локальный кэш."));
    });
  }

  async function runCacheRequest(storeName, mode, operation) {
    const database = await openCacheDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      let request;
      try {
        request = operation(transaction.objectStore(storeName));
      } catch (error) {
        database.close();
        reject(error);
        return;
      }
      transaction.oncomplete = () => {
        database.close();
        resolve(request ? request.result : undefined);
      };
      transaction.onerror = () => {
        database.close();
        reject(transaction.error || new Error("Не удалось сохранить текст в локальный кэш."));
      };
      transaction.onabort = () => {
        database.close();
        reject(transaction.error || new Error("Сохранение локального кэша было прервано."));
      };
    });
  }

  function readAllCachedDocuments() {
    return runCacheRequest(CACHE_STORE_NAME, "readonly", (store) => store.getAll());
  }

  function readCachedDocument(id) {
    return runCacheRequest(CACHE_STORE_NAME, "readonly", (store) => store.get(id));
  }

  function isCachedWords(value) {
    return Array.isArray(value) && value.length > 0 && value.every((word) =>
      typeof word === "string" ||
      (word && typeof word === "object" && ["group", "heading", "code", "table"].includes(word.type) && typeof word.text === "string"));
  }

  function createId() {
    return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }



  async function cacheDocument(file, loadedWords) {
    const existing = await readAllCachedDocuments();
    const match = existing.find((item) => item.fileName === file.name &&
      ((item.size === file.size && item.lastModified === file.lastModified) ||
        (item.id === STORAGE_KEY && !item.file)));
    const record = {
      id: match?.id || createId(),
      fileName: file.name,
      type: file.type || "application/octet-stream",
      size: file.size,
      lastModified: file.lastModified,
      file,
      words: loadedWords,
      parserVersion: window.FastReadContent.version,
      index: match && match.parserVersion !== window.FastReadContent.version && match.words?.length
        ? Math.floor(((match.index || 0) / match.words.length) * loadedWords.length)
        : match?.index || 0,
      updatedAt: Date.now()
    };
    await runCacheRequest(CACHE_STORE_NAME, "readwrite", (store) => store.put(record));
    cachedDocuments = [...existing.filter((item) => item.id !== record.id), record]
      .sort((a, b) => b.updatedAt - a.updatedAt);
    renderSavedDocuments();
    return record;
  }

  function updateCachedProgress(id, index) {
    return runCacheRequest(CACHE_STORE_NAME, "readwrite", (store) => {
      const request = store.get(id);
      request.onsuccess = () => {
        if (!request.result) return;
        request.result.index = index;
        request.result.updatedAt = Date.now();
        store.put(request.result);
      };
      return request;
    });
  }

  async function upgradeDocument(record) {
    if (record.parserVersion === window.FastReadContent.version && isCachedWords(record.words)) return record;
    if (!record.file || typeof record.file.arrayBuffer !== "function") return record;
    const updated = await parseFile(record.file, record.fileName);
    if (!updated.length) return record;
    const fraction = record.words?.length ? (record.index || 0) / record.words.length : 0;
    record.words = updated;
    record.index = Math.min(updated.length, Math.floor(fraction * updated.length));
    record.parserVersion = window.FastReadContent.version;
    await runCacheRequest(CACHE_STORE_NAME, "readwrite", (store) => store.put(record));
    const index = cachedDocuments.findIndex((item) => item.id === record.id);
    if (index >= 0) cachedDocuments[index] = record;
    return record;
  }

  async function restoreCachedDocument() {
    const generation = importGeneration;
    try {
      cachedDocuments = await readAllCachedDocuments();
      cachedDocuments.sort((a, b) => b.updatedAt - a.updatedAt);
      renderSavedDocuments();
      let current = cachedDocuments.find((item) => item.id === savedState?.documentId) ||
        cachedDocuments.find((item) => item.id === STORAGE_KEY && item.fileName === savedState?.fileName);
      if (current && generation === importGeneration) {
        if ((savedState?.documentId === current.id || (!savedState?.documentId && savedState?.fileName === current.fileName)) && savedState?.total === current.words?.length) {
          current.index = savedState.index;
        }
        current = await upgradeDocument(current);
        if (generation !== importGeneration || !isCachedWords(current.words)) return;
        currentDocumentId = current.id;
        currentFileName = current.fileName;
        words = current.words;
        currentIndex = clamp(current.index || 0, 0, words.length);
        updateSelectedDocument();
        renderSavedDocuments();
      }
    } catch (error) {
      console.error("Не удалось восстановить локальные данные.", error);
      setStatus("Локальная библиотека недоступна. Файлы по-прежнему можно открывать для чтения.");
    }
  }

  function renderSavedDocuments() {
    const pageSize = window.innerHeight < 460 ? 1 : window.innerHeight < 620 ? 3 : 4;
    const pages = Math.max(1, Math.ceil(cachedDocuments.length / pageSize));
    libraryPage = clamp(libraryPage, 0, pages - 1);
    savedDocumentCount.textContent = String(cachedDocuments.length);
    $("libraryPageLabel").textContent = `${libraryPage + 1} / ${pages}`;
    $("libraryPrevBtn").disabled = libraryPage === 0;
    $("libraryNextBtn").disabled = libraryPage === pages - 1;
    savedDocumentsList.replaceChildren();
    if (!cachedDocuments.length) {
      const empty = document.createElement("li");
      empty.className = "saved-documents-empty";
      empty.textContent = "Здесь будут ваши документы. Откройте первый файл на вкладке «Чтение».";
      savedDocumentsList.append(empty);
      return;
    }
    for (const item of cachedDocuments.slice(libraryPage * pageSize, (libraryPage + 1) * pageSize)) {
      const row = document.createElement("li");
      row.className = "saved-document";
      const details = document.createElement("div");
      details.className = "saved-document-details";
      const name = document.createElement("strong");
      name.textContent = item.fileName;
      const progress = document.createElement("span");
      const percent = item.words?.length ? Math.min(100, Math.floor(((item.index || 0) / item.words.length) * 100)) : 0;
      progress.textContent = `${percent}% прочитано · ${item.fileName.split(".").pop().toUpperCase()}`;
      details.append(name, progress);
      const actions = document.createElement("div");
      actions.className = "saved-document-actions";
      const resume = document.createElement("button");
      resume.className = "preview-btn";
      resume.type = "button";
      resume.dataset.openDocument = item.id;
      resume.textContent = percent >= 100 ? "Сначала" : "Читать";
      resume.setAttribute("aria-label", `${resume.textContent}: ${item.fileName}`);
      const remove = document.createElement("button");
      remove.className = "preview-btn delete-btn";
      remove.type = "button";
      remove.dataset.deleteDocument = item.id;
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Удалить ${item.fileName}`);
      actions.append(resume, remove);
      row.append(details, actions);
      savedDocumentsList.append(row);
    }
  }

  async function openSavedDocument(id) {
    const generation = ++importGeneration;
    loadingFile = true;
    updateSelectedDocument();
    let opened = false;
    try {
      let record = cachedDocuments.find((item) => item.id === id) || await readCachedDocument(id);
      if (generation !== importGeneration) return;
      if (!record) throw new Error("Документ недоступен. Загрузите файл ещё раз.");
      if (savedState?.documentId === record.id && savedState.total === record.words?.length) record.index = savedState.index;
      if (record.parserVersion !== window.FastReadContent.version || !isCachedWords(record.words)) record = await upgradeDocument(record);
      if (generation !== importGeneration) return;
      if (!isCachedWords(record.words)) throw new Error("Документ недоступен. Загрузите файл ещё раз.");
      words = record.words;
      currentDocumentId = record.id;
      currentFileName = record.fileName;
      holdingCode = false;
      loadingFile = false;
      startReading(record.index >= words.length ? 0 : record.index || 0);
      opened = true;
    } finally {
      if (generation === importGeneration) {
        if (!opened) musicPlayer.pause();
        loadingFile = false;
        updateSelectedDocument();
      }
    }
  }

  async function deleteSavedDocument(id) {
    if (currentDocumentId === id) {
      currentDocumentId = "";
      if (isPlaying) pause();
      currentFileName = "";
      words = [];
      currentIndex = 0;
      fileNameDisplay.textContent = "Не выбран";
      const state = { ...savedState, documentId: "", fileName: "", index: 0, total: 0 };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      savedState = state;
    }
    await runCacheRequest(CACHE_STORE_NAME, "readwrite", (store) => store.delete(id));
    cachedDocuments = cachedDocuments.filter((item) => item.id !== id);
    updateSelectedDocument();
    renderSavedDocuments();
  }

  function modeConfiguration() {
    const mode = MODES.get(musicMode);
    return mode?.source ? { selection: mode.id, source: new URL(mode.source, document.baseURI).href } : null;
  }

  function updateMusicControls() {
    const mode = MODES.get(musicMode);
    const recommendation = MODES.get(MODES.recommend(Number(wpmInput.value)));
    const active = musicPlayer.state === "loading" || musicPlayer.state === "playing";
    for (const button of document.querySelectorAll("[data-music-mode]")) {
      button.setAttribute("aria-pressed", String(button.dataset.musicMode === musicMode));
      const recommended = button.dataset.musicMode === recommendation.id;
      button.dataset.recommended = String(recommended);
      button.classList.toggle("is-recommended", recommended);
    }
    $("musicModeName").textContent = mode.name;
    $("homeMusicModeName").textContent = musicMuted ? `${mode.name} · без звука` : mode.name;
    const loading = musicPlayer.state === "loading";
    $("readerMusicModeName").textContent = loading ? `${mode.name} · загрузка…` : mode.name;
    $("musicRecommendation").textContent = loading ? "Музыка загружается…" : `Рекомендуем ${recommendation.name} · ${recommendation.range}`;
    $("readerMusicBtn").setAttribute("aria-busy", String(loading));
    $("musicAutoInput").checked = musicAutomatic;
    $("readerMusicModeInput").value = musicMode;
    for (const prefix of ["music", "readerMusic"]) {
      $(`${prefix}VolumeInput`).value = String(musicVolume);
      $(`${prefix}VolumeValue`).textContent = `${musicVolume}%`;
      const mute = $(`${prefix}MuteBtn`);
      mute.textContent = musicMuted ? "🔇" : "♫";
      mute.disabled = !mode.source;
      mute.setAttribute("aria-label", musicMuted ? "Включить звук" : "Отключить звук");
      mute.setAttribute("aria-pressed", String(musicMuted));
    }
    $("readerMusicBtn").hidden = false;
    $("readerMusicBtn").setAttribute("aria-label", `Звуковое сопровождение: ${mode.name}`);
    $("readerMusicBtn").setAttribute("aria-pressed", String(active && !musicMuted && musicVolume > 0));
  }

  function clearMusicError() {
    if (musicFailure && statusMessage.textContent === musicFailure.message) setStatus("");
    musicFailure = null;
    $("readerMusicNotice").hidden = true;
  }

  function showMusicError(error) {
    musicFailure = error;
    $("readerMusicPanel").hidden = true;
    $("readerMusicBtn").setAttribute("aria-expanded", "false");
    setStatus(error.message);
    $("readerMusicMessage").textContent = error.message;
    $("readerMusicRetryBtn").textContent = error.kind === "permission" ? "Включить музыку" : "Повторить";
    $("readerMusicNotice").hidden = !isPlaying || !readerScreen.classList.contains("active");
  }

  function configureBackgroundMusic() {
    const configuration = modeConfiguration();
    if (musicPlayer.selection !== (configuration?.selection || "")) clearMusicError();
    musicPlayer.prepare(configuration);
    if (!configuration) clearMusicError();
    return Boolean(configuration);
  }

  function readingMusicPlaybackRate(wpm = Number(wpmInput.value)) {
    return clamp(1 + (wpm - 300) / 1200, .8, 1.75);
  }

  function startBackgroundMusic() {
    if (!isPlaying || !readerScreen.classList.contains("active") || musicMuted || musicVolume === 0) return Promise.resolve(false);
    try {
      if (!configureBackgroundMusic()) return Promise.resolve(false);
      // The first native play call stays in the original user gesture.
      return musicPlayer.play();
    } catch (error) {
      showMusicError({ kind: "source", message: error instanceof Error ? error.message : "Не удалось открыть трек." });
      return Promise.resolve(false);
    }
  }

  function chooseMusicMode(value, { manual = true, persist = true } = {}) {
    if (!MODES.isValid(value)) return;
    const changed = value !== musicMode;
    const active = isPlaying && (musicPlayer.state === "loading" || musicPlayer.state === "playing");
    musicMode = value;
    if (manual) musicAutomatic = false;
    if (changed) {
      clearMusicError();
      if (active) void musicPlayer.transition(modeConfiguration());
      else {
        configureBackgroundMusic();
        if (isPlaying) void startBackgroundMusic();
      }
    }
    if (manual && !active && !isPlaying && !musicMuted && musicVolume > 0) musicPlayer.preload();
    updateMusicControls();
    if (persist) saveState();
  }

  function changeMusicVolume(value) {
    const number = Number(value);
    musicVolume = clamp(Number.isFinite(number) ? number : 25, 0, 100);
    musicPlayer.setVolume(musicVolume / 100);
    if (isPlaying && !musicMuted && musicVolume > 0) void startBackgroundMusic();
    updateMusicControls();
    saveState();
  }

  function toggleMusicMute() {
    musicMuted = !musicMuted;
    musicPlayer.setMuted(musicMuted);
    if (!musicMuted && isPlaying) void startBackgroundMusic();
    updateMusicControls();
    saveState();
  }

  function showReaderMusicPanel(visible) {
    $("readerMusicPanel").hidden = !visible;
    $("readerMusicBtn").setAttribute("aria-expanded", String(visible));
    if (visible) $("readerMusicModeInput").focus({ preventScroll: true });
    else $("readerMusicBtn").focus({ preventScroll: true });
  }


  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function setStatus(message) {
    statusMessage.textContent = message;
  }

  function normalizeText(text) {
    return window.FastReadContent.tokenize(text);
  }

  function readMarkdown(text) {
    return window.FastReadContent.readMarkdown(text);
  }

  function updateSelectedDocument() {
    fileNameDisplay.textContent = currentFileName || "Файл ещё не выбран";
    const ready = words.length > 0;
    if (countedWords !== words) {
      countedWords = words;
      documentWordCount = words.reduce((total, item) => total + (typeof item === "string" ? 1 : item.text.trim().split(/\s+/u).length), 0);
    }
    const count = documentWordCount;
    const minutes = Math.max(1, Math.ceil(count / Number(wpmInput.value)));
    $("documentMeta").textContent = ready ? `${count.toLocaleString("ru-RU")} слов · ≈ ${minutes} мин` : "Только на устройстве";
    $("startBtn").disabled = !ready || loadingFile;
    $("demoBtn").disabled = loadingFile;
    $("startBtn").textContent = ready && currentIndex > 0 && currentIndex < words.length ? "Продолжить чтение" : "Начать чтение";
    $("readerWpm").textContent = wpmInput.value;
  }

  async function readPdf(file) {
    if (!window.pdfjsLib) {
      throw new Error("Обработчик PDF недоступен. Перезагрузите приложение и попробуйте ещё раз.");
    }
    const document = await pdfjsLib.getDocument({ data: await file.arrayBuffer(), isEvalSupported: false }).promise;
    const segments = [];
    try {
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        const positionedItems = content.items
          .filter((item) => "str" in item && item.str.trim())
          .map((item) => ({
            text: item.str.trim(),
            x: item.transform[4],
            y: item.transform[5],
            width: item.width,
            fontSize: Math.abs(item.transform[3]) || 10
          }))
          .sort((a, b) => b.y - a.y || a.x - b.x);
        const lines = [];
        for (const item of positionedItems) {
          let line = lines.find((candidate) =>
            Math.abs(candidate.y - item.y) <= Math.max(2, item.fontSize * 0.24));
          if (!line) {
            line = { y: item.y, items: [] };
            lines.push(line);
          }
          line.items.push(item);
        }

        const pageLines = lines
          .sort((a, b) => b.y - a.y)
          .map((line) => {
            line.items.sort((a, b) => a.x - b.x);
            let text = "";
            let previous = null;
            for (const item of line.items) {
              if (previous) {
                const gap = item.x - (previous.x + previous.width);
                if (gap > Math.max(1.5, item.fontSize * 0.2) && !text.endsWith(" ")) {
                  text += " ";
                }
              }
              text += item.text;
              previous = item;
            }
            return text.trim();
          })
          .filter(Boolean);

        segments.push(...splitPdfCodeBlocks(pageLines));
        page.cleanup();
      }
    } finally {
      await document.destroy();
    }
    return segments.flatMap((segment) => segment.type === "code"
      ? [{ type: "code", text: segment.text }]
      : normalizeText(segment.text));
  }

  function isCodeLikeLine(line) {
    let score = 0;
    if (/[{}]|=>|===?|!==?|<=|>=|&&|\|\||\+\+|--|::/.test(line)) score += 2;
    if (/;/.test(line)) score += 1;
    if (/^\s*(?:\/\/|#|\/\*|\*|<\/?[a-z][^>]*>)/i.test(line)) score += 2;
    if (/\b(?:function|const|let|var|return|class|import|export|def|async|await|print|public|private|SELECT|FROM|WHERE)\b/.test(line)) score += 1;
    if (/\b[\w$]+\s*\([^)]*\)\s*[{;=]/.test(line) || /\b[\w$]+\s*=\s*[^=]/.test(line)) score += 1;
    if (/^\s*[\w$.]+\s*\([^)]*\)\s*;?\s*$/.test(line)) score += 2;
    return score >= 2;
  }

  function splitPdfCodeBlocks(lines) {
    const codeCandidate = lines.map(isCodeLikeLine);
    const codeLine = codeCandidate.map((candidate, index) =>
      candidate && ((codeCandidate[index - 1] || codeCandidate[index + 1]) ||
        /[{}]|=>|===?|!==?|<=|>=|&&|\|\||<\/?[a-z][^>]*>/i.test(lines[index])));
    const segments = [];
    let prose = [];
    let code = [];

    const flushProse = () => {
      if (prose.length) segments.push({ type: "text", text: prose.join(" ") });
      prose = [];
    };
    const flushCode = () => {
      if (code.length) segments.push({ type: "code", text: code.join("\n") });
      code = [];
    };

    lines.forEach((line, index) => {
      if (codeLine[index]) {
        flushProse();
        code.push(line);
      } else {
        flushCode();
        prose.push(line);
      }
    });
    flushCode();
    return segments;
  }

  async function parseFile(file, name = file.name || "") {
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(name);
    const isMarkdown = file.type === "text/markdown" || /\.(?:md|markdown)$/i.test(name);
    if (isPdf) return readPdf(file);
    const text = typeof file.text === "function" ? await file.text() : await new Response(file).text();
    return isMarkdown ? readMarkdown(text) : normalizeText(text);
  }

  function startDemo(text) {
    const generation = ++importGeneration;
    const file = new File([text], "Знакомство с FastRead.md", { type: "text/markdown", lastModified: 1 });
    try {
      const parsed = readMarkdown(text);
      if (!parsed.length) throw new Error("Не удалось открыть пример.");
      words = parsed;
      currentFileName = file.name;
      currentDocumentId = "";
      currentIndex = 0;
      holdingCode = false;
      loadingFile = false;
      savedState = { ...savedState, documentId: "", fileName: file.name, index: 0, total: words.length };
      selectTab("home");
      setStatus("");
      // Start text and music together in the original click; cache afterwards.
      startReading(0);
      saveState();
      cacheDocument(file, parsed).then((record) => {
        if (generation !== importGeneration) return;
        currentDocumentId = record.id;
        saveState();
      }).catch((error) => {
        console.info("Пример открыт без сохранения в библиотеке.", error);
        if (generation === importGeneration) setStatus("Пример открыт. Сохранение в этом браузере недоступно.");
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Не удалось открыть пример.");
    }
  }

  async function loadFile(file) {
    const generation = ++importGeneration;
    loadingFile = true;
    updateSelectedDocument();
    setStatus("Открываем документ…");
    try {
      if (!/\.(txt|md|markdown|pdf)$/i.test(file.name) && !["text/plain", "text/markdown", "application/pdf"].includes(file.type)) {
        throw new Error("Выберите файл TXT, Markdown или PDF.");
      }
      const loadedWords = await parseFile(file);
      if (generation !== importGeneration) return;
      if (!loadedWords.length) throw new Error("В файле нет текста для чтения. Для PDF со сканами сначала нужно распознавание текста.");
      words = loadedWords;
      currentFileName = file.name;
      currentDocumentId = "";
      currentIndex = 0;
      holdingCode = false;
      savedState = { ...savedState, documentId: "", fileName: file.name, index: 0, total: words.length };
      try {
        const cached = await cacheDocument(file, loadedWords);
        if (generation !== importGeneration) return;
        currentDocumentId = cached.id;
        currentIndex = clamp(cached.index || 0, 0, words.length);
        setStatus("Готово. Документ сохранён в вашей библиотеке.");
      } catch (error) {
        console.error("Не удалось сохранить файл.", error);
        setStatus("Документ открыт. Сохранение в этом браузере недоступно.");
      }
      saveState();
      selectTab("home");
    } catch (error) {
      console.error("Не удалось открыть файл.", error);
      setStatus(error instanceof Error ? error.message : "Не удалось открыть файл.");
    } finally {
      if (generation === importGeneration) {
        loadingFile = false;
        updateSelectedDocument();
      }
    }
  }



  function renderCode(code) {
    const tokenPattern = /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:const|let|var|function|return|class|import|export|from|if|else|for|while|async|await|new|true|false|null|undefined|def|print|public|private|SELECT|FROM|WHERE)\b|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b)/g;
    const keywordPattern = /^(?:const|let|var|function|return|class|import|export|from|if|else|for|while|async|await|new|true|false|null|undefined|def|print|public|private|SELECT|FROM|WHERE)$/;
    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    for (const match of code.matchAll(tokenPattern)) {
      if (match.index > lastIndex) {
        fragment.append(document.createTextNode(code.slice(lastIndex, match.index)));
      }
      const token = match[0];
      const span = document.createElement("span");
      span.textContent = token;
      if (/^(?:\/\/|#|\/\*|\*)/.test(token)) span.className = "code-comment";
      else if (/^["'`]/.test(token)) span.className = "code-string";
      else if (/^\d/.test(token)) span.className = "code-number";
      else if (keywordPattern.test(token)) span.className = "code-keyword";
      else if (/^\s*\(/.test(code.slice(match.index + token.length))) span.className = "code-function";
      fragment.append(span);
      lastIndex = match.index + token.length;
    }
    if (lastIndex < code.length) {
      fragment.append(document.createTextNode(code.slice(lastIndex)));
    }
    codeContent.replaceChildren(fragment);
  }



  function selectTab(name) {
    if (name !== activeTab) setStatus("");
    activeTab = name;
    for (const button of document.querySelectorAll("[data-tab]")) {
      const active = button.dataset.tab === name;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    }
    for (const panel of document.querySelectorAll(".app-panel")) panel.hidden = panel.id !== `${name}Panel`;
    if (name === "library") renderSavedDocuments();
  }

  function selectSettingsTab(name) {
    for (const button of document.querySelectorAll("[data-settings-tab]")) {
      const active = button.dataset.settingsTab === name;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    }
    for (const section of ["reading", "music"]) $(`${section}Settings`).hidden = section !== name;
  }

  function updateReaderStatus() {
    const mode = readerScreen.dataset.mode;
    const complete = mode === "complete";
    readerScreen.classList.toggle("is-reading-clean", isPlaying);
    $("readerStatus").textContent = complete ? "Готово" : holdingCode ? "Пауза для фрагмента" : isPlaying ? "В вашем ритме" : "На паузе";
    pauseBtn.textContent = isPlaying ? "Ⅱ" : "▶";
    pauseBtn.setAttribute("aria-label", complete ? "Читать ещё раз" : isPlaying ? "Пауза" : "Продолжить");
    $("readerHint").textContent = complete ? "Вы прочитали весь документ" : holdingCode ? "Продолжите, когда будете готовы" : isPlaying ? "Коснитесь экрана, чтобы сделать паузу" : "Коснитесь экрана, чтобы продолжить";
    $("readerMusicNotice").hidden = !musicFailure || !isPlaying || !readerScreen.classList.contains("active");
    $("readerSpeedDown").disabled = Number(wpmInput.value) <= 100;
    $("readerSpeedUp").disabled = Number(wpmInput.value) >= 1200;
  }

  function paginateCode(text) {
    const style = getComputedStyle(codeContent);
    const lineHeight = parseFloat(style.lineHeight) || 22;
    const stage = readerScreen.querySelector(".reader-stage");
    const stageStyle = getComputedStyle(stage);
    const cardStyle = getComputedStyle(codeCard);
    // Reserve pagination before measuring: it can add a row on narrow phones.
    $("codePages").hidden = false;
    $("codePageLabel").textContent = "1 / 999";
    const verticalSpace = [stageStyle.paddingTop, stageStyle.paddingBottom,
      cardStyle.paddingTop, cardStyle.paddingBottom, cardStyle.borderTopWidth,
      cardStyle.borderBottomWidth].reduce((sum, value) => sum + (parseFloat(value) || 0), 0);
    const headerHeight = codeCard.querySelector(".code-card-header").getBoundingClientRect().height;
    const footerHeight = codeCard.querySelector(".code-card-footer").getBoundingClientRect().height;
    const availableHeight = Math.max(lineHeight, stage.clientHeight - verticalSpace - headerHeight - footerHeight - (parseFloat(cardStyle.rowGap) || 0) * 2 - 4);
    const linesPerPage = Math.max(1, Math.floor(availableHeight / lineHeight));
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    ctx.font = `${style.fontSize} ${style.fontFamily}`;
    const maxWidth = Math.max(100, codeContent.clientWidth - 4);
    const lines = [];
    for (const source of text.replace(/\t/g, "  ").split("\n")) {
      let line = "";
      for (const letter of Array.from(source)) {
        if (line && ctx.measureText(line + letter).width > maxWidth) {
          lines.push(line);
          line = "";
        }
        line += letter;
      }
      lines.push(line);
    }
    const pages = [];
    for (let index = 0; index < lines.length; index += linesPerPage) pages.push(lines.slice(index, index + linesPerPage).join("\n"));
    return pages.length ? pages : [text];
  }

  function renderCodePage() {
    const item = words[displayedIndex];
    const text = codePages[codePageIndex] || "";
    if (item?.type === "code") renderCode(text);
    else codeContent.textContent = text;
    $("codePageLabel").textContent = `${codePageIndex + 1} / ${codePages.length}`;
    $("codePagePrevBtn").disabled = codePageIndex === 0;
    $("codePageNextBtn").disabled = codePageIndex >= codePages.length - 1;
    $("codePages").hidden = codePages.length <= 1;
  }

  function isWholeCard(item) {
    const textLimit = window.innerHeight < 460 ? 90 : window.innerHeight < 620 ? 180 : 280;
    return typeof item === "object" && (item.type === "code" || item.type === "table" || item.text.length > textLimit);
  }

  function renderWord(index, repaginate = true) {
    const item = words[index];
    if (!item) return;
    const previous = displayedIndex;
    displayedIndex = index;
    readerProgress.textContent = `${index + 1} / ${words.length}`;
    const percentage = (index + 1) / words.length * 100;
    $("readerProgressFill").style.width = `${percentage}%`;
    $("readerDocumentTitle").textContent = currentFileName;
    codeCard.hidden = true;
    wordDisplay.hidden = true;
    $("groupDisplay").hidden = true;
    if (isWholeCard(item)) {
      readerScreen.dataset.mode = "code";
      codeCard.hidden = false;
      $("codeHeading").textContent = item.type === "table" ? "Таблица" : item.type === "code" ? "Прочитайте код целиком" : item.type === "heading" ? "Заголовок" : "Фраза целиком";
      $("codeLanguage").textContent = item.language || (item.type === "table" ? "Markdown" : "");
      if (repaginate || previous !== index) {
        codePageIndex = 0;
        codePages = paginateCode(item.text);
      }
      renderCodePage();
    } else if (typeof item === "object") {
      readerScreen.dataset.mode = "group";
      const group = $("groupDisplay");
      group.hidden = false;
      group.textContent = item.text;
      group.dataset.kind = item.type;
      group.style.fontSize = `${item.text.length > 150 ? 20 : item.text.length > 70 ? 24 : item.text.length > 35 ? 29 : 36}px`;
    } else {
      readerScreen.dataset.mode = "word";
      wordDisplay.hidden = false;
      const letters = Array.from(item);
      const start = Math.max(0, letters.findIndex((letter) => /[\p{L}\p{N}]/u.test(letter)));
      const focus = Math.min(letters.length - 1, start + Math.round((letters.length - start - 1) / 2));
      wordBefore.textContent = letters.slice(0, focus).join("");
      wordFocus.textContent = letters[focus];
      wordAfter.textContent = letters.slice(focus + 1).join("");
      const halfWidth = Math.max(45, wordDisplay.clientWidth / 2);
      const longerSide = Math.max(focus, letters.length - focus - 1, 1);
      wordDisplay.style.fontSize = `${Math.min(58, halfWidth / (longerSide + .75) / .62)}px`;
      if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        wordArrivalAnimation?.cancel();
        wordArrivalAnimation = wordDisplay.animate(
          [{ opacity: .35 }, { opacity: 1 }],
          { duration: Math.min(120, Math.max(50, 60000 / Number(wpmInput.value) * .5)), easing: "ease-out" }
        );
      }
    }
    updateReaderStatus();
  }

  function delayAfterWord(index) {
    const item = words[index];
    const text = typeof item === "string" ? item : item.text;
    const beat = 60000 / Number(wpmInput.value);
    const count = text.trim().split(/\s+/u).length;
    let multiplier = Math.max(1, count * .85);
    if (item?.type === "heading") multiplier = Math.max(3.5, multiplier + 1.5);
    if (typeof item === "object") multiplier = Math.max(2.8, multiplier);
    if (/[.!?…][)\]»”"']*$/u.test(text)) multiplier += .65;
    else if (/[,;:][)\]»”"']*$/u.test(text)) multiplier += .3;
    if (text.length > 12 && typeof item === "string") multiplier += Math.min(.6, (text.length - 12) * .04);
    return beat * multiplier;
  }

  function showCompletion() {
    pause();
    void musicPlayer.stop();
    holdingCode = false;
    currentIndex = words.length;
    readerScreen.dataset.mode = "complete";
    codeCard.hidden = true;
    wordDisplay.hidden = true;
    const group = $("groupDisplay");
    group.hidden = false;
    group.textContent = "Прочитано.";
    group.dataset.kind = "heading";
    group.style.fontSize = "38px";
    $("readerProgressFill").style.width = "100%";
    updateReaderStatus();
    saveState();
  }

  function renderNextWord() {
    if (!isPlaying) return;
    if (currentIndex >= words.length) { showCompletion(); return; }
    const index = currentIndex;
    const item = words[index];
    renderWord(index);
    currentIndex = index + 1;
    if (isWholeCard(item)) {
      holdingCode = true;
      pause();
      return;
    }
    if (Date.now() - lastProgressSave > 1200) saveState();
    timer = window.setTimeout(renderNextWord, delayAfterWord(index));
  }

  function play() {
    if (!words.length || isPlaying) return;
    if (readerScreen.dataset.mode === "complete") {
      currentIndex = 0;
      renderWord(0);
    }
    holdingCode = false;
    isPlaying = true;
    void startBackgroundMusic();
    updateReaderStatus();
    timer = window.setTimeout(renderNextWord, 0);
  }

  function pause({ immediate = false } = {}) {
    isPlaying = false;
    window.clearTimeout(timer);
    timer = null;
    void musicPlayer.pause({ immediate });
    updateMusicControls();
    updateReaderStatus();
    saveState();
  }

  function startReading(index = 0) {
    if (!words.length || loadingFile) { setStatus("Сначала выберите текстовый файл."); return; }
    currentIndex = clamp(index, 0, words.length - 1);
    holdingCode = false;
    displayedIndex = -1;
    setupScreen.style.display = "none";
    readerScreen.classList.add("active");
    readerScreen.setAttribute("tabindex", "-1");
    readerScreen.focus({ preventScroll: true });
    if (musicFailure) $("readerMusicNotice").hidden = false;
    renderWord(currentIndex);
    play();
  }

  function exitReading() {
    pause();
    readerScreen.classList.remove("active");
    $("readerMusicPanel").hidden = true;
    $("readerMusicBtn").setAttribute("aria-expanded", "false");
    setupScreen.style.display = "flex";
    updateSelectedDocument();
    renderSavedDocuments();
    if (activeTab === "home") $("startBtn").focus({ preventScroll: true });
  }

  function jumpWords(delta) {
    if (!words.length) return;
    const wasPlaying = isPlaying;
    window.clearTimeout(timer);
    const target = clamp(Math.max(0, displayedIndex) + delta, 0, words.length - 1);
    holdingCode = false;
    renderWord(target);
    currentIndex = target + 1;
    if (isWholeCard(words[target])) { holdingCode = true; pause(); }
    else if (wasPlaying) timer = window.setTimeout(renderNextWord, delayAfterWord(target));
    updateReaderStatus();
    saveState();
  }

  function changeSpeed(delta) {
    wpmInput.value = String(clamp(Number(wpmInput.value) + delta, 100, 1200));
    wpmValue.textContent = wpmInput.value;
    $("readerWpm").textContent = wpmInput.value;
    musicPlayer.setPlaybackRate(readingMusicPlaybackRate());
    if (musicAutomatic) chooseMusicMode(MODES.recommend(Number(wpmInput.value)), { manual: false, persist: false });
    else updateMusicControls();
    updateReaderStatus();
    if (isPlaying && displayedIndex >= 0) {
      window.clearTimeout(timer);
      timer = window.setTimeout(renderNextWord, delayAfterWord(displayedIndex));
    }
    saveState();
  }

  function handleReaderTap(event) {
    if (Date.now() < ignoreClickUntil || event.target.closest("button, .code-card, .reader-header, .reader-speed, .reader-music-notice, .reader-music-panel")) return;
    isPlaying ? pause() : play();
  }

  $("chooseFileBtn").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (file) await loadFile(file);
    fileInput.value = "";
  });
  $("startBtn").addEventListener("click", () => startReading(positionToSave() >= words.length ? 0 : positionToSave()));
  $("demoBtn").addEventListener("click", () => {
    const demo = '# Читайте в своём ритме\n\nFastRead помогает сосредоточиться на тексте. Не нужно двигать глазами по строкам. Выберите удобную скорость и просто читайте.\n\nВыражения в скобках (например, эта короткая мысль) остаются целыми. Как и «фразы в кавычках». **Markdown** превращается в текст без лишних символов.\n\nКод можно спокойно рассмотреть:\n\n```python\ndef focus(text):\n    return "Меньше шума. Больше смысла."\n```\n\nНажмите «Продолжить» в удобный момент. Ваш документ и место чтения сохраняются на этом устройстве. Хорошего чтения!';
    startDemo(demo);
  });


  for (const button of document.querySelectorAll("[data-tab]")) button.addEventListener("click", () => selectTab(button.dataset.tab));
  document.querySelector("[data-home-link]").addEventListener("click", (event) => { event.preventDefault(); selectTab("home"); });
  for (const button of document.querySelectorAll("[data-settings-tab]")) button.addEventListener("click", () => selectSettingsTab(button.dataset.settingsTab));
  for (const selector of ["[data-tab]", "[data-settings-tab]"]) {
    const buttons = [...document.querySelectorAll(selector)];
    for (const button of buttons) button.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const index = buttons.indexOf(button);
      const target = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[target].click();
      buttons[target].focus();
    });
  }
  $("libraryPrevBtn").addEventListener("click", () => { libraryPage -= 1; renderSavedDocuments(); });
  $("libraryNextBtn").addEventListener("click", () => { libraryPage += 1; renderSavedDocuments(); });
  savedDocumentsList.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    try {
      if (button.dataset.openDocument) await openSavedDocument(button.dataset.openDocument);
      else if (button.dataset.deleteDocument) {
        const record = cachedDocuments.find((item) => item.id === button.dataset.deleteDocument);
        if (record && window.confirm(`Удалить «${record.fileName}» из этого браузера?`)) await deleteSavedDocument(record.id);
      }
    } catch (error) { setStatus(error instanceof Error ? error.message : "Не удалось открыть документ."); }
  });
  $("readerMusicBtn").addEventListener("click", () => showReaderMusicPanel($("readerMusicPanel").hidden));
  $("readerMusicCloseBtn").addEventListener("click", () => showReaderMusicPanel(false));
  $("readerMusicRetryBtn").addEventListener("click", () => { void startBackgroundMusic(); });
  for (const button of document.querySelectorAll("[data-music-mode]")) button.addEventListener("click", () => chooseMusicMode(button.dataset.musicMode));
  $("readerMusicModeInput").addEventListener("change", () => chooseMusicMode($("readerMusicModeInput").value));
  $("musicAutoInput").addEventListener("change", () => {
    musicAutomatic = $("musicAutoInput").checked;
    if (musicAutomatic) chooseMusicMode(MODES.recommend(Number(wpmInput.value)), { manual: false });
    else { updateMusicControls(); saveState(); }
  });
  for (const prefix of ["music", "readerMusic"]) {
    $(`${prefix}VolumeInput`).addEventListener("input", (event) => changeMusicVolume(event.target.value));
    $(`${prefix}MuteBtn`).addEventListener("click", toggleMusicMute);
  }
  wpmInput.addEventListener("input", () => changeSpeed(0));
  $("readerSpeedDown").addEventListener("click", () => changeSpeed(-50));
  $("readerSpeedUp").addEventListener("click", () => changeSpeed(50));
  themeInput.addEventListener("input", () => {
    document.documentElement.dataset.theme = themeInput.value;
    document.querySelector('meta[name="theme-color"]').content = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
    saveState();
  });
  pauseBtn.addEventListener("click", () => isPlaying ? pause() : play());
  $("codeContinueBtn").addEventListener("click", play);
  $("codePagePrevBtn").addEventListener("click", () => { codePageIndex = Math.max(0, codePageIndex - 1); renderCodePage(); });
  $("codePageNextBtn").addEventListener("click", () => { codePageIndex = Math.min(codePages.length - 1, codePageIndex + 1); renderCodePage(); });
  $("rewindBtn").addEventListener("click", () => jumpWords(-10));
  $("forwardBtn").addEventListener("click", () => jumpWords(10));
  $("exitBtn").addEventListener("click", exitReading);
  readerScreen.addEventListener("click", handleReaderTap);
  readerScreen.addEventListener("touchstart", (event) => {
    if (event.target.closest("button, .code-card, .reader-music-notice, .reader-music-panel")) return;
    const touch = event.changedTouches[0];
    touchStart = { x: touch.clientX, y: touch.clientY };
  }, { passive: true });
  readerScreen.addEventListener("touchend", (event) => {
    if (!touchStart) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - touchStart.x;
    const dy = touch.clientY - touchStart.y;
    touchStart = null;
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.25) {
      ignoreClickUntil = Date.now() + 450;
      jumpWords(dx < 0 ? 10 : -10);
    }
  }, { passive: true });
  readerScreen.addEventListener("touchcancel", () => { touchStart = null; }, { passive: true });
  document.addEventListener("keydown", (event) => {
    if (!readerScreen.classList.contains("active") || event.target.closest("button, input, select")) return;
    if (event.code === "Space") { event.preventDefault(); isPlaying ? pause() : play(); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); jumpWords(-10); }
    else if (event.key === "ArrowRight") { event.preventDefault(); jumpWords(10); }
    else if (event.key === "Escape") {
      if (!$("readerMusicPanel").hidden) showReaderMusicPanel(false);
      else exitReading();
    }
  });
  window.addEventListener("resize", () => {
    if (activeTab === "library") renderSavedDocuments();
    if (readerScreen.classList.contains("active") && displayedIndex >= 0) {
      if (readerScreen.dataset.mode === "complete") return;
      renderWord(displayedIndex);
    }
  });
  window.addEventListener("pagehide", () => { pause({ immediate: true }); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      if (isPlaying) pause({ immediate: true });
      else { void musicPlayer.pause({ immediate: true }); saveState(); }
    }
  });

  updateSelectedDocument();
  selectTab("home");
  selectSettingsTab("reading");
  restoreCachedDocument();

  if ("serviceWorker" in navigator && window.isSecureContext) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch((error) => {
        console.info("Офлайн-кэш приложения недоступен.", error);
      });
    });
  }

})();

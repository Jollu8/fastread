/* One media element: gesture-safe starts, fades, and sequential mode changes. */
(function (root) {
  "use strict";

  const bounded = (value, fallback, minimum, maximum) => {
    const number = Number(value);
    return Math.max(minimum, Math.min(maximum, Number.isFinite(number) ? number : fallback));
  };
  const now = () => root.performance?.now?.() ?? Date.now();

  class FastReadMusic {
    constructor({ element, onChange = () => {}, onError = () => {}, onSuccess = () => {}, volume = .25, fadeInMs = 350, fadeOutMs = 200 }) {
      this.element = element;
      this.onChange = onChange;
      this.onError = onError;
      this.onSuccess = onSuccess;
      this.selection = "";
      this.source = "";
      this.state = "idle";
      this.pending = null;
      this.error = null;
      this.volume = bounded(volume, .25, 0, 1);
      this.muted = false;
      this.fadeInMs = bounded(fadeInMs, 350, 0, 2000);
      this.fadeOutMs = bounded(fadeOutMs, 200, 0, 2000);
      this._generation = 0;
      this._wanted = false;
      this._updating = false;
      this._destroyed = false;
      this._installedSource = "";
      this._level = 0;
      this._fade = null;
      this._context = null;
      this._gain = null;
      this._mediaSource = null;
      this._resetRequested = false;
      this._listeners = {
        playing: () => {
          if (this._updating || this._destroyed) return;
          if (!this._wanted) { this._pauseElement(); return; }
          if (this._installedSource !== this.source) return;
          if (this.element.paused) return;
          this.state = "playing";
          this._notify(this.onChange, this);
        },
        pause: () => {
          // A queued pause from an old load must not cancel a new play request.
          if (this._updating || this._destroyed || !this.element.paused) return;
          if (!this._wanted && this.state !== "playing" && this.state !== "loading") return;
          this._invalidate();
          this._setLevel(0);
          this.state = this.source ? "paused" : "idle";
          this._notify(this.onChange, this);
        },
        error: () => {
          if (this._updating || this._destroyed || !this._wanted || !this.element.error) return;
          this._fail(this.element.error, this._generation);
        }
      };
      for (const [name, listener] of Object.entries(this._listeners)) element.addEventListener(name, listener);
    }

    _notify(callback, value) {
      try { callback(value); }
      catch (error) { root.console?.error("Ошибка обновления музыкального проигрывателя.", error); }
    }

    _targetLevel() { return this.muted ? 0 : this.volume; }

    _currentLevel() {
      if (!this._fade) return this._level;
      const elapsed = Math.max(0, now() - this._fade.start);
      const progress = Math.min(1, elapsed / Math.max(1, this._fade.duration));
      return this._fade.from + (this._fade.target - this._fade.from) * progress;
    }

    _setLevel(level) {
      this._level = bounded(level, 0, 0, 1);
      if (this._gain && this._context?.state !== "closed") {
        const parameter = this._gain.gain;
        parameter.cancelScheduledValues(this._context.currentTime);
        parameter.setValueAtTime(this._level, this._context.currentTime);
        this.element.volume = 1;
      } else this.element.volume = this._level;
    }

    _cancelFade() {
      if (!this._fade) return;
      const level = this._currentLevel();
      const fade = this._fade;
      this._fade = null;
      root.clearTimeout(fade.timer);
      this._setLevel(level);
      fade.resolve(false);
    }

    _fadeTo(target, duration, generation = this._generation) {
      this._cancelFade();
      const from = this._level;
      if (!duration || Math.abs(from - target) < .00001) {
        this._setLevel(target);
        return Promise.resolve(generation === this._generation);
      }
      return new Promise((resolve) => {
        const fade = { start: now(), from, target, duration, generation, timer: null, resolve };
        this._fade = fade;
        if (this._gain && this._context?.state !== "closed") {
          const parameter = this._gain.gain;
          parameter.cancelScheduledValues(this._context.currentTime);
          parameter.setValueAtTime(from, this._context.currentTime);
          parameter.linearRampToValueAtTime(target, this._context.currentTime + duration / 1000);
        }
        const tick = () => {
          if (this._fade !== fade || generation !== this._generation) return;
          const elapsed = now() - fade.start;
          if (elapsed >= duration) {
            this._fade = null;
            this._setLevel(target);
            resolve(true);
          } else {
            // Web Audio ramps on the audio thread. Native volume is a fallback.
            if (!this._gain) this.element.volume = this._currentLevel();
            fade.timer = root.setTimeout(tick, this._gain ? duration - elapsed : Math.min(16, duration - elapsed));
          }
        };
        fade.timer = root.setTimeout(tick, this._gain ? duration : Math.min(16, duration));
      });
    }

    _invalidate() {
      this._cancelFade();
      this._generation += 1;
      this._wanted = false;
      this.pending = null;
    }

    _ensureGraph() {
      if (!this._context) {
        const AudioContext = root.AudioContext || root.webkitAudioContext;
        if (AudioContext) {
          let context;
          try {
            context = new AudioContext();
            if (typeof context.createMediaElementSource !== "function") {
              context.close()?.catch?.(() => {});
            } else {
              const gain = context.createGain();
              gain.gain.value = this._level;
              gain.connect(context.destination);
              const source = context.createMediaElementSource(this.element);
              source.connect(gain);
              this._context = context;
              this._gain = gain;
              this._mediaSource = source;
              this.element.volume = 1;
            }
          } catch (_) {
            if (context && context !== this._context) context.close()?.catch?.(() => {});
          }
        }
      }
      this.element.muted = this.muted || this.volume === 0;
      if (this._context && this._context.state !== "running" && this._context.state !== "closed") {
        return this._context.resume();
      }
    }

    _pauseElement(reset = false) {
      this._updating = true;
      try {
        this.element.pause();
        if (reset) {
          try { this.element.currentTime = 0; } catch (_) { /* Metadata may not be available yet. */ }
          this._resetRequested = false;
        }
      } finally { this._updating = false; }
    }

    _installSource(source) {
      this._updating = true;
      try {
        this.element.pause();
        this.element.preload = "metadata";
        this.element.loop = true;
        if (source) this.element.src = source;
        else this.element.removeAttribute("src");
        this.element.load();
        this._installedSource = source;
      } finally { this._updating = false; }
      this._resetRequested = false;
    }

    prepare(configuration) {
      if (this._destroyed) return false;
      const selection = configuration?.selection || "";
      const source = configuration?.source || "";
      if (this.selection === selection && this.source === source) return false;
      this._invalidate();
      this.selection = selection;
      this.source = source;
      this.error = null;
      this._setLevel(0);
      this._installSource(source);
      this.state = source ? "paused" : "idle";
      this._notify(this.onChange, this);
      return true;
    }

    _nativePlay(generation) {
      let playback;
      let graphReady;
      try {
        graphReady = this._ensureGraph();
        if (this.element.error) {
          this._updating = true;
          try { this.element.load(); }
          finally { this._updating = false; }
        }
        // Keep this native call inside the original click for first play/retry.
        playback = this.element.play();
      } catch (error) {
        this._fail(error, generation);
        return Promise.resolve(false);
      }
      return Promise.all([playback, graphReady]).then(
        () => {
          if (this._destroyed || generation !== this._generation) {
            if (!this._wanted) this._pauseElement();
            return false;
          }
          this.pending = null;
          this.state = "playing";
          this.error = null;
          void this._fadeTo(this._targetLevel(), this.fadeInMs, generation);
          this._notify(this.onSuccess, this);
          this._notify(this.onChange, this);
          return true;
        },
        (error) => this._fail(error, generation)
      );
    }

    play() {
      if (this._destroyed || !this.source) return Promise.resolve(false);
      if (this.pending) return this.pending;
      if (this.state === "playing" && !this.element.paused && !this.element.error) return Promise.resolve(true);
      this._invalidate();
      const generation = this._generation;
      if (this._installedSource !== this.source) {
        this._setLevel(0);
        this._installSource(this.source);
      }
      if (this._resetRequested) this._pauseElement(true);
      this._wanted = true;
      this.error = null;
      this.state = "loading";
      this._notify(this.onChange, this);
      const pending = this._nativePlay(generation);
      if (generation === this._generation) this.pending = pending;
      return pending;
    }

    transition(configuration) {
      if (this._destroyed) return Promise.resolve(false);
      const selection = configuration?.selection || "";
      const source = configuration?.source || "";
      if (selection === this.selection && source === this.source) return this.pending || Promise.resolve(this.state === "playing");
      const active = this._wanted && !this.element.paused;
      if (!active) {
        this.prepare(configuration);
        return Promise.resolve(false);
      }
      this._invalidate();
      const generation = this._generation;
      this._wanted = true;
      this.selection = selection;
      this.source = source;
      this.error = null;
      this.state = "loading";
      this._notify(this.onChange, this);
      const pending = (async () => {
        try {
          if (!await this._fadeTo(0, this.fadeOutMs, generation) || generation !== this._generation) return false;
          this._installSource(source);
          if (!source) {
            this._wanted = false;
            this.pending = null;
            this.state = "idle";
            this._notify(this.onChange, this);
            return false;
          }
          return this._nativePlay(generation);
        } catch (error) { return this._fail(error, generation); }
      })();
      this.pending = pending;
      return pending;
    }

    setVolume(value) {
      this.volume = bounded(value, this.volume, 0, 1);
      this.element.muted = this.muted || this.volume === 0;
      if (this._wanted && this.state === "playing" && !this.pending) void this._fadeTo(this._targetLevel(), 90);
      this._notify(this.onChange, this);
    }

    setMuted(value) {
      this.muted = Boolean(value);
      this.element.muted = this.muted || this.volume === 0;
      if (this._wanted && this.state === "playing" && !this.pending) void this._fadeTo(this._targetLevel(), 90);
      this._notify(this.onChange, this);
    }

    _describe(error) {
      const name = error?.name || "MediaError";
      const code = Number(this.element.error?.code || error?.code) || 0;
      let kind;
      let message;
      if (name === "NotAllowedError") {
        kind = "permission";
        message = "Для запуска музыки нажмите «Включить музыку». Браузеру нужно отдельное нажатие.";
      } else if (!/^(?:blob:|data:)/i.test(this.source) && root.navigator?.onLine === false && code !== 3) {
        kind = "offline";
        message = "Для этого режима нужен интернет. Подключитесь к сети и попробуйте ещё раз.";
      } else if (code === 2 || name === "NetworkError") {
        kind = "network";
        message = "Не удалось загрузить трек. Проверьте подключение и попробуйте ещё раз.";
      } else if (code === 3) {
        kind = "decode";
        message = "Не удалось прочитать аудиофайл. Выберите другой режим.";
      } else if (code === 4 || name === "NotSupportedError") {
        kind = "source";
        message = "Музыка режима недоступна или её формат не поддерживается. Выберите другой режим.";
      } else {
        kind = "unknown";
        message = "Не удалось воспроизвести музыку. Попробуйте ещё раз или выберите другой режим.";
      }
      return { kind, message, name, code };
    }

    _fail(error, generation) {
      if (this._destroyed || generation !== this._generation) return false;
      this._invalidate();
      this._setLevel(0);
      this._pauseElement();
      if (error?.name === "AbortError") {
        this.state = this.source ? "paused" : "idle";
        this._notify(this.onChange, this);
        return false;
      }
      this.error = this._describe(error);
      this.state = "error";
      this._notify(this.onError, this.error);
      this._notify(this.onChange, this);
      return false;
    }

    pause({ immediate = false, reset = false } = {}) {
      if (this._destroyed) return Promise.resolve(false);
      const wasPlaying = !this.element.paused && !this.pending &&
        (this.state === "playing" || (this._fade && this._currentLevel() > 0));
      this._resetRequested = reset || this._resetRequested;
      this._invalidate();
      const generation = this._generation;
      this.error = null;
      this.state = this.source ? "paused" : "idle";
      this._notify(this.onChange, this);
      if (immediate || !wasPlaying) {
        this._setLevel(0);
        this._pauseElement(this._resetRequested);
        return Promise.resolve(true);
      }
      return this._fadeTo(0, this.fadeOutMs, generation).then((finished) => {
        if (!finished || generation !== this._generation) return false;
        this._pauseElement(this._resetRequested);
        return true;
      });
    }

    stop({ immediate = false } = {}) { return this.pause({ immediate, reset: true }); }

    destroy() {
      if (this._destroyed) return;
      void this.pause({ immediate: true, reset: true });
      this._destroyed = true;
      for (const [name, listener] of Object.entries(this._listeners)) this.element.removeEventListener(name, listener);
      this._mediaSource?.disconnect();
      this._gain?.disconnect();
      if (this._context && this._context.state !== "closed") this._context.close()?.catch?.(() => {});
      this._mediaSource = null;
      this._gain = null;
    }
  }

  root.FastReadMusic = FastReadMusic;
  if (typeof module !== "undefined" && module.exports) module.exports = FastReadMusic;
})(typeof window !== "undefined" ? window : globalThis);

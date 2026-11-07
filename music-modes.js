/* Local music catalogue. Keep the source filenames in sync with assets/sounds/. */
(function (root) {
  "use strict";

  const modes = Object.freeze([
    Object.freeze({
      id: "focus",
      name: "Focus",
      description: "Спокойная электроника для концентрации",
      icon: "◌",
      range: "150–299",
      source: "assets/sounds/leberch-sci-fi-ambient-589945.mp3"
    }),
    Object.freeze({
      id: "jazz",
      name: "Jazz Flow",
      description: "Ритмичный джаз, бас и ударные",
      icon: "♬",
      range: "300–499",
      source: "assets/sounds/icsilviu-rhythmic-jazz-289915.mp3"
    }),
    Object.freeze({
      id: "adrenaline",
      name: "Adrenaline",
      description: "Сердцебиение и напряжённый синтезаторный бас",
      icon: "♥︎",
      range: "300–499",
      source: "assets/sounds/tomas_herudek-heartbeat-and-tense-synth-529666.mp3"
    }),
    Object.freeze({
      id: "hyperflow",
      name: "Hyperflow",
      description: "Liquid Drum & Bass для быстрого потока",
      icon: "≈",
      range: "500–799",
      source: "assets/sounds/audiodollar-liquid-drum-and-bass-477325.mp3"
    }),
    Object.freeze({
      id: "extreme",
      name: "Extreme",
      description: "Плотный техно-ритм и глубокий бас",
      icon: "ϟ",
      range: "800+",
      source: "assets/sounds/alex-morgan-techno-warehouse-537487.mp3"
    }),
    Object.freeze({
      id: "silence",
      name: "Silence",
      description: "Только текст. Полная тишина.",
      icon: "∅",
      range: "Любая скорость",
      source: null
    })
  ]);

  const byId = new Map(modes.map((mode) => [mode.id, mode]));

  function get(id) {
    return byId.get(id) || null;
  }

  function isValid(id) {
    return byId.has(id);
  }

  function recommend(wpm) {
    const number = Number(wpm);
    const speed = Number.isFinite(number) ? number : 300;
    if (speed < 300) return "focus";
    if (speed < 500) return "jazz";
    if (speed < 800) return "hyperflow";
    return "extreme";
  }

  const api = Object.freeze({ modes, get, isValid, recommend });
  root.FastReadModes = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

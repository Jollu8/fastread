"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
globalThis.marked = require("../assets/vendor/marked.min.js");
const content = require("../content-parser.js");

test("balanced nested brackets remain one RSVP item, including punctuation", () => {
  assert.deepEqual(content.tokenize("Начало (одна [вложенная {мысль}])! конец"), [
    "Начало", { type: "group", text: "(одна [вложенная {мысль}])!" }, "конец"
  ]);
});

test("Russian, typographic and ASCII quotes keep phrases together", () => {
  const result = content.tokenize('«Одна мысль» “another thought” "one more"');
  assert.deepEqual(result, [
    { type: "group", text: "«Одна мысль»" },
    { type: "group", text: "“another thought”" },
    { type: "group", text: '"one more"' }
  ]);
});

test("escaped quotes and parentheses inside quoted JSON strings are respected", () => {
  assert.deepEqual(content.tokenize('До {"text": "one ) two", "nested": [1, 2]} после'), [
    "До", { type: "group", text: '{"text": "one ) two", "nested": [1, 2]}' }, "после"
  ]);
  assert.deepEqual(content.tokenize('"one \\"two\\" three"'), [{ type: "group", text: '"one \\"two\\" three"' }]);
});

test("contractions and unmatched/mismatched delimiters do not swallow following prose", () => {
  assert.deepEqual(content.tokenize("Don't don’t (unfinished text\n\nNext paragraph) here"), ["Don't", "don’t", "(unfinished", "text", "Next", "paragraph)", "here"]);
  assert.deepEqual(content.tokenize("Before ([broken) after words"), ["Before", "([broken)", "after", "words"]);
  assert.deepEqual(content.tokenize("Keep (don’t panic) and 'one thought'"), ["Keep", { type: "group", text: "(don’t panic)" }, "and", { type: "group", text: "'one thought'" }]);
});

test("TXT fenced code retains indentation and language and resumes prose", () => {
  assert.deepEqual(content.tokenize("Before\n```js\nconst n = 1;\n  console.log(n);\n```\nAfter"), [
    "Before", { type: "code", text: "const n = 1;\n  console.log(n);", language: "js" }, "After"
  ]);
});

test("Markdown formatting yields semantic readable content instead of source markers", () => {
  const result = content.readMarkdown("# Новый **раздел**\n\nПростой *текст* и [подпись](https://example.com/private) ![Схема](image.png).\n\n- Первый\n- [x] Готово\n\n> Цитата\n\n(важная **цель**)\n");
  assert.deepEqual(result, [
    { type: "heading", text: "Новый раздел", level: 1 },
    "Простой", "текст", "и", "подпись", "Схема.", "Первый", "Готово", "Цитата",
    { type: "group", text: "(важная цель)" }
  ]);
  assert.ok(!JSON.stringify(result).includes("https://"));
});

test("Markdown inline, fenced and indented code each become a whole code item", () => {
  assert.deepEqual(content.readMarkdown("Use `doWork(a, b)` next.\n\n```python\ndef f():\n    return 2\n```\n\n    const x = 3;\n"), [
    "Use", { type: "code", text: "doWork(a, b)", language: "" }, "next.",
    { type: "code", text: "def f():\n    return 2", language: "python" },
    { type: "code", text: "const x = 3;", language: "" }
  ]);
});

test("Markdown table is kept together without pipe/separator syntax", () => {
  const result = content.readMarkdown("| **Имя** | Значение |\n| --- | --- |\n| [A](https://example.com) | `1` |\n");
  assert.equal(result.length, 1);
  assert.equal(result[0].type, "table");
  assert.equal(result[0].text, "Имя  Значение\n───  ────────\nA    1");
});

test("HTML scripts/styles are skipped and inert HTML text/entities remain readable", () => {
  const result = content.readMarkdown("<script>alert('invisible')</script>\n\n<style>.hidden {}</style>\n\nHello <b>world</b> &amp; &#x1f4d6; &lt;safe&gt;\n\nText <script>invisible()</script> end.\n");
  assert.deepEqual(result, ["Hello", "world", "&", "📖", "<safe>", "Text", "end."]);
});

test("empty input and CRLF are supported", () => {
  assert.deepEqual(content.tokenize(""), []);
  assert.deepEqual(content.readMarkdown(""), []);
  assert.deepEqual(content.tokenize("a\r\n\r\n[b c]\r\nd"), ["a", { type: "group", text: "[b c]" }, "d"]);
});

test("a realistic Markdown reading fixture preserves content order and reading stops", () => {
  const fixture = [
    "# Чтение без **шума**", "",
    "Прочитайте [инструкцию](https://example.com/guide), затем (выберите свой ритм).", "",
    "## Первый шаг", "",
    "1. Откройте **документ**.",
    "2. Проверьте `reader.start(300)`.",
    "   - Поддерживается «режим фокуса».", "",
    "> Сохраняйте внимание, а не скорость.", "",
    "```js", "const options = { speed: 300 };", "reader.start(options);", "```", "",
    "| Режим | Скорость |", "| :--- | ---: |", "| Мягкий | 300 |", "",
    "![Схема чтения](private-image.png)", "",
    "Последняя строка."
  ].join("\n");
  const result = content.readMarkdown(fixture);
  assert.deepEqual(result.slice(0, 7), [
    { type: "heading", text: "Чтение без шума", level: 1 }, "Прочитайте", "инструкцию,", "затем",
    { type: "group", text: "(выберите свой ритм)." },
    { type: "heading", text: "Первый шаг", level: 2 }, "Откройте"
  ]);
  assert.deepEqual(result.filter((item) => typeof item === "object" && item.type === "code"), [
    { type: "code", text: "reader.start(300)", language: "" },
    { type: "code", text: "const options = { speed: 300 };\nreader.start(options);", language: "js" }
  ]);
  assert.ok(result.some((item) => item.type === "table" && item.text.includes("Мягкий")));
  assert.deepEqual(result.slice(-4), ["Схема", "чтения", "Последняя", "строка."]);
});

test("entities are decoded once and inline code displays its literal entity spelling", () => {
  assert.deepEqual(content.readMarkdown("[&amp;lt;safe&amp;gt;](https://example.com) `&lt;div&gt;` &lt;visible&gt;"), [
    "&lt;safe&gt;", { type: "code", text: "&lt;div&gt;", language: "" }, "<visible>"
  ]);
  assert.deepEqual(content.readMarkdown("# `&lt;div&gt;`\n\n<div>&amp;lt;safe&amp;gt;</div>"), [
    { type: "heading", text: "&lt;div&gt;", level: 1 }, "&lt;safe&gt;"
  ]);
});

test("an unclosed code fence retains all code through the end of the file", () => {
  for (const read of [content.tokenize, content.readMarkdown]) {
    assert.deepEqual(read("Intro\n\n~~~js\nconst x = 1;\nconsole.log(x);"), [
      "Intro", { type: "code", text: "const x = 1;\nconsole.log(x);", language: "js" }
    ]);
  }
});

test("large unmatched bracket input is handled without recursive parsing", () => {
  const text = "(".repeat(50000);
  assert.deepEqual(content.tokenize(text), [text]);
});

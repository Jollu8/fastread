const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const catalogue = require("../music-modes.js");

test("all six music modes have distinct, selectable identities and descriptive UI content", () => {
  assert.deepEqual(catalogue.modes.map(mode => mode.id), ["focus", "jazz", "adrenaline", "hyperflow", "extreme", "silence"]);
  for (const mode of catalogue.modes) {
    assert.equal(catalogue.get(mode.id), mode);
    assert.equal(catalogue.isValid(mode.id), true);
    assert.ok(mode.name && mode.description && mode.icon && mode.range);
  }
  assert.equal(catalogue.get("missing"), null);
  assert.equal(catalogue.isValid("missing"), false);
});

test("configured tracks exist locally and Silence has no source", () => {
  const sources = catalogue.modes.filter(mode => mode.source).map(mode => mode.source);
  assert.equal(new Set(sources).size, 5);
  for (const source of sources) {
    assert.ok(source.startsWith("assets/sounds/"));
    assert.ok(!source.includes(".."));
    assert.ok(!/^https?:/.test(source));
    const file = path.join(__dirname, "..", source);
    assert.ok(fs.statSync(file).isFile());
    assert.ok(fs.statSync(file).size > 1000);
  }
  assert.equal(catalogue.get("silence").source, null);
});

test("recommendations follow speed boundaries while Adrenaline remains a manual alternative", () => {
  for (const [speed, expected] of [[100,"focus"],[150,"focus"],[299,"focus"],[300,"jazz"],[499,"jazz"],[500,"hyperflow"],[799,"hyperflow"],[800,"extreme"],[1200,"extreme"]]) {
    assert.equal(catalogue.recommend(speed), expected);
  }
  assert.equal(catalogue.recommend("500"), "hyperflow");
  assert.equal(catalogue.recommend(undefined), "jazz");
  assert.equal(catalogue.recommend(NaN), "jazz");
  assert.equal(catalogue.get("adrenaline").range, "300–499");
  assert.equal(catalogue.isValid("adrenaline"), true);
});

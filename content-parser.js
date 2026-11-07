(function (root) {
  "use strict";

  const PAIRS = new Map([["(", ")"], ["[", "]"], ["{", "}"], ["«", "»"], ["“", "”"], ["„", "“"], ["\"", "\""], ["‘", "’"], ["'", "'"]]);
  const QUOTES = new Set(["«", "“", "„", "\"", "‘", "'"]);
  const CLOSERS = new Set([")", "]", "}"]);
  const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", laquo: "«", raquo: "»", copy: "©", reg: "®", trade: "™", bull: "•", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”" };

  function decodeEntities(value) {
    return String(value || "").replace(/&(#x[\da-f]+|#\d+|[a-z][\da-z]+);/gi, (entity, name) => {
      if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? entity;
      const code = /^#x/i.test(name) ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code) : "�";
    });
  }

  function isBoundary(character) {
    return !character || /[\s([{«“„‘]/u.test(character);
  }

  // Scan once rather than repeatedly looking ahead from unmatched openers.
  function matchingGroups(text) {
    const matches = new Map();
    const stack = [];
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (character === "\\") { index += 1; continue; }
      if (QUOTES.has(character) && isBoundary(text[index - 1])) {
        let end = index + 1;
        while (end < text.length) {
          if (text[end] === "\\") { end += 2; continue; }
          if (text[end] === PAIRS.get(character)) break;
          end += 1;
        }
        if (end < text.length) { matches.set(index, end + 1); index = end; }
      } else if (PAIRS.has(character) && !QUOTES.has(character) && (stack.length || isBoundary(text[index - 1]))) {
        stack.push({ start: index, close: PAIRS.get(character) });
      } else if (CLOSERS.has(character)) {
        if (stack.length && character === stack[stack.length - 1].close) {
          matches.set(stack.pop().start, index + 1);
        } else stack.length = 0;
      }
    }
    return matches;
  }

  function tokenizeProse(text) {
    const result = [];
    // Paragraph boundaries also bound bracket/quote lookahead.
    for (const paragraph of String(text || "").replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").split(/\n\s*\n/u)) {
      const matches = matchingGroups(paragraph);
      let index = 0;
      let plain = "";
      const flush = () => {
        result.push(...plain.trim().split(/\s+/u).filter(Boolean));
        plain = "";
      };
      while (index < paragraph.length) {
        const character = paragraph[index];
        if (PAIRS.has(character) && isBoundary(paragraph[index - 1])) {
          let end = matches.get(index) ?? -1;
          if (end > index) {
            while (/[.,;:!?…]/u.test(paragraph[end] || "") && end < paragraph.length) end += 1;
            flush();
            result.push({ type: "group", text: paragraph.slice(index, end).replace(/\s+/gu, " ") });
            index = end;
            continue;
          }
        }
        plain += character;
        index += 1;
      }
      flush();
    }
    return result;
  }

  function tokenize(text) {
    const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
    const segments = [];
    let prose = [];
    const flush = () => { segments.push(...tokenizeProse(prose.join("\n"))); prose = []; };
    for (let index = 0; index < lines.length; index += 1) {
      const fence = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^\n]*$/.exec(lines[index]);
      if (!fence) { prose.push(lines[index]); continue; }
      const fenceCharacter = fence[1][0];
      const closing = new RegExp(`^ {0,3}${fenceCharacter}{${fence[1].length},}\\s*$`);
      let end = index + 1;
      while (end < lines.length && !closing.test(lines[end])) end += 1;
      flush();
      const code = lines.slice(index + 1, end).join("\n").replace(/\n+$/u, "");
      if (code.trim()) segments.push({ type: "code", text: code, language: fence[2] || "" });
      index = end;
    }
    flush();
    return segments;
  }

  function htmlText(value) {
    return decodeEntities(String(value || "")
      .replace(/<!--([\s\S]*?)-->/g, "")
      .replace(/<(script|style|iframe|object|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<img\b[^>]*\balt\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi, (_, double, single) => double ?? single ?? "")
      .replace(/<(?:br|hr)\b[^>]*>|<\/(?:p|div|li|h[1-6]|section|article|blockquote|tr)>/gi, "\n")
      .replace(/<[^>]*>/g, ""));
  }

  function readMarkdown(text) {
    const marked = root.marked;
    if (!marked || typeof marked.lexer !== "function") {
      throw new Error("Обработчик Markdown недоступен. Перезагрузите приложение и попробуйте ещё раз.");
    }
    const result = [];
    let prose = "";
    const flush = () => { result.push(...tokenizeProse(prose)); prose = ""; };

    function inlinePlain(tokens, fallback = "") {
      if (!Array.isArray(tokens)) return decodeEntities(fallback);
      let hidden = null;
      let value = "";
      for (const token of tokens) {
        if (token.type === "html") {
          const html = token.raw || token.text || "";
          const opening = /^<(script|style|iframe|object|template)\b/i.exec(html);
          if (opening) {
            if (!new RegExp(`</${opening[1]}\\s*>`, "i").test(html)) hidden = opening[1].toLowerCase();
            continue;
          }
          if (hidden && new RegExp(`</${hidden}\\s*>`, "i").test(html)) { hidden = null; continue; }
          if (!hidden) value += htmlText(html);
        } else if (!hidden) {
          if (token.type === "br") value += " ";
          else if (token.type === "image") value += decodeEntities(token.text);
          else if (token.tokens) value += inlinePlain(token.tokens, token.text);
          else value += decodeEntities(token.text ?? token.raw ?? "");
        }
      }
      return value;
    }

    function visitInline(tokens, fallback = "") {
      if (!Array.isArray(tokens)) { prose += decodeEntities(fallback); return; }
      let hidden = null;
      for (const token of tokens) {
        if (token.type === "html") {
          const html = token.raw || token.text || "";
          const opening = /^<(script|style|iframe|object|template)\b/i.exec(html);
          if (opening) {
            if (!new RegExp(`</${opening[1]}\\s*>`, "i").test(html)) hidden = opening[1].toLowerCase();
            continue;
          }
          if (hidden && new RegExp(`</${hidden}\\s*>`, "i").test(html)) { hidden = null; continue; }
          if (!hidden) prose += htmlText(html);
          continue;
        }
        if (hidden) continue;
        if (token.type === "codespan") {
          flush();
          result.push({ type: "code", text: decodeEntities(token.text), language: "" });
        } else if (token.type === "br") prose += " ";
        else if (token.type === "image") prose += decodeEntities(token.text);
        else if (token.tokens) visitInline(token.tokens, token.text);
        else prose += decodeEntities(token.text ?? token.raw ?? "");
      }
    }

    function visitBlock(tokens) {
      for (const token of tokens) {
        if (token.type === "space" || token.type === "hr" || token.type === "def") { flush(); continue; }
        if (token.type === "heading") {
          flush();
          const heading = inlinePlain(token.tokens, token.text).replace(/\s+/gu, " ").trim();
          if (heading) result.push({ type: "heading", text: heading, level: token.depth || 1 });
        } else if (token.type === "code") {
          flush();
          if (token.text?.trim()) result.push({ type: "code", text: token.text.replace(/\n+$/u, ""), language: (token.lang || "").split(/\s/u)[0] });
        } else if (token.type === "table") {
          flush();
          const rows = [token.header, ...token.rows].map((row) => row.map((cell) => inlinePlain(cell.tokens, cell.text).trim()));
          const widths = rows[0].map((_, index) => Math.max(...rows.map((row) => Array.from(row[index] || "").length)));
          const formatted = rows.map((row, rowIndex) => {
            const line = row.map((cell, index) => cell + " ".repeat(Math.max(0, widths[index] - Array.from(cell).length))).join("  ").trimEnd();
            return rowIndex === 0 ? `${line}\n${widths.map((width) => "─".repeat(width)).join("  ")}` : line;
          }).join("\n");
          result.push({ type: "table", text: formatted });
        } else if (token.type === "list") {
          flush();
          for (const item of token.items) { visitBlock(item.tokens || []); flush(); }
        } else if (token.type === "blockquote") {
          flush();
          visitBlock(token.tokens || []);
          flush();
        } else if (token.type === "html") {
          flush();
          result.push(...tokenizeProse(htmlText(token.text || token.raw)));
        } else {
          visitInline(token.tokens, token.text || token.raw || "");
          flush();
        }
      }
    }

    visitBlock(marked.lexer(String(text || ""), { gfm: true }));
    flush();
    return result;
  }

  const api = { version: 2, tokenize, readMarkdown };
  root.FastReadContent = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

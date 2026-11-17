/* ===== JsCore.html ===== */
/*
 * JsCore: shared client code. DOM builder (text only, never markup from data), the server call
 * wrapper (request ids, retry with exponential backoff and jitter, save indicator), session storage,
 * polling, loading of helper scripts from the project's static site, and the message channel of the
 * 360 viewer.
 */
(function () {
  "use strict";
  var IELT = window.IELT = { state: { token: "", boot: null, stage: null, progress: null, offset: 0, module: "" }, modules: {}, siteProgress: {}, drafts: {} };
  var PREFIX = "ielt:";

  /* ---------- DOM (user text always goes through textContent) ---------- */
  function el(tag, attrs, children) {
    var n = document.createElement(tag), k, v;
    attrs = attrs || {};
    for (k in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
      v = attrs[k];
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = String(v);
      else if (k === "for") n.htmlFor = v;
      else if (k === "value") n.value = v;
      else if (k === "checked" || k === "disabled" || k === "selected" || k === "required" || k === "readOnly" || k === "hidden") n[k] = !!v;
      else if (k.slice(0, 2) === "on" && typeof v === "function") n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : String(v));
    }
    add(n, children);
    return n;
  }
  function add(node, children) {
    if (children === undefined || children === null || children === false) return node;
    if (!Array.isArray(children)) children = [children];
    children.forEach(function (c) {
      if (c === undefined || c === null || c === false) return;
      if (Array.isArray(c)) add(node, c);
      else node.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
    });
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
  var idSeq = 0;
  function uid(prefix) { idSeq++; return (prefix || "f") + idSeq; }
  function announce(text) { var a = document.getElementById("announcer"); if (a) { a.textContent = ""; setTimeout(function () { a.textContent = text; }, 30); } }

  /* ---------- small helpers ---------- */
  function rid() {
    var a = new Uint8Array(12), s = "";
    (window.crypto || window.msCrypto).getRandomValues(a);
    for (var i = 0; i < a.length; i++) s += (a[i] < 16 ? "0" : "") + a[i].toString(16);
    return "c" + s;
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function words(s) { s = String(s || "").replace(/^\s+|\s+$/g, ""); return s ? s.split(/\s+/).length : 0; }
  function clock(ms) { var d = new Date(ms === undefined ? Date.now() : ms); return (d.getHours() < 10 ? "0" : "") + d.getHours() + ":" + (d.getMinutes() < 10 ? "0" : "") + d.getMinutes(); }
  function serverNow() { return Date.now() + IELT.state.offset; }
  function countdown(ms) {
    if (!(ms > 0)) return "0:00";
    var s = Math.floor(ms / 1000), m = Math.floor(s / 60); s = s % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }
  var store = {
    get: function (k) { try { var v = sessionStorage.getItem(PREFIX + k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
    set: function (k, v) { try { sessionStorage.setItem(PREFIX + k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    del: function (k) { try { sessionStorage.removeItem(PREFIX + k); } catch (e) { /* storage may be unavailable */ } }
  };

  /* ---------- save indicator ---------- */
  var saveState = { state: "idle", at: 0 };
  function setSave(state) {
    saveState.state = state;
    if (state === "saved") saveState.at = Date.now();
    var text = state === "saving" ? "Saving…" : state === "saved" ? "Saved " + clock(saveState.at) : state === "retrying" ? "Not saved, retrying"
      : state === "failed" ? "Not saved. Check your connection" : state === "dirty" ? "Unsaved changes" : (saveState.at ? "Saved " + clock(saveState.at) : "Nothing to save yet");
    var box = document.getElementById("saveState");
    if (box) { box.setAttribute("data-state", state); var v = box.querySelector(".value"); if (v && v.textContent !== text) v.textContent = text; }
  }

  /* ---------- server calls ---------- */
  function rawCall(name, args) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () { if (!done) { done = true; reject(new Error("timeout")); } }, 45000);
      var runner = google.script.run
        .withSuccessHandler(function (out) { if (done) return; done = true; clearTimeout(timer); try { resolve(JSON.parse(out)); } catch (e) { reject(e); } })
        .withFailureHandler(function (err) { if (done) return; done = true; clearTimeout(timer); reject(err || new Error("failed")); });
      runner[name].apply(runner, args);
    });
  }
  function apiError(res) { var e = new Error(res.message || "The request failed."); e.code = res.code; e.data = res.data; return e; }
  /*
   * api(name, payload, opts)
   * opts.write: the call changes data. It gets one request id for all its attempts, so the server
   *             stores it once however often it is repeated.
   * opts.save:  drive the save indicator (Saving…, Saved, Not saved, retrying).
   * opts.args:  explicit argument list (sign-in and public calls).
   * Retries: transport errors, timeouts and server answers marked retry (busy lock, server error)
   * are repeated with exponential backoff and random jitter.
   */
  function api(name, payload, opts) {
    opts = opts || {};
    var max = opts.attempts || (opts.write ? 6 : 3), attempt = 0;
    if (opts.write) { payload = payload || {}; if (!payload.rid) payload.rid = rid(); }
    if (opts.save) setSave("saving");
    function wait() {
      if (opts.save) setSave("retrying");
      var base = Math.min(15000, 700 * Math.pow(2, attempt - 1));
      return sleep(base * (0.5 + Math.random()));
    }
    function once() {
      attempt++;
      if (opts.write) payload.attempt = attempt;
      var args = opts.args || [IELT.state.token].concat(payload === undefined ? [] : [payload]);
      return rawCall(name, args).then(function (res) {
        if (res && typeof res.now === "number") IELT.state.offset = res.now - Date.now();
        if (res && res.ok) { if (opts.save) setSave("saved"); return res.data; }
        if (res && res.code === "AUTH" && !opts.args) { if (IELT.onAuthLost) IELT.onAuthLost(); throw apiError(res); }
        if (res && res.retry && attempt < max) return wait().then(once);
        if (opts.save) setSave(res && res.retry ? "failed" : "dirty");
        throw apiError(res || {});
      }, function () {
        if (attempt < max) return wait().then(once);
        if (opts.save) setSave("failed");
        var e = new Error("The portal could not be reached. Your text is kept in this browser. Check your connection and try again.");
        e.code = "NETWORK";
        throw e;
      });
    }
    return once();
  }

  /* ---------- technical error reports (best effort, at most eight per page load) ---------- */
  var reported = 0;
  function reportError(module, err) {
    try {
      if (reported >= 8 || !window.google || !google.script) return;
      reported++;
      var msg = err && err.message ? err.message : String(err);
      rawCall("apiReportError", [IELT.state.token || "", { module: String(module || IELT.state.module || "page").slice(0, 60), message: String(msg).slice(0, 500),
        detail: err && err.stack ? String(err.stack).slice(0, 1000) : "", userAgent: String(navigator.userAgent || "").slice(0, 200) }]).then(function () {}, function () {});
    } catch (e) { /* never throw from the error reporter */ }
  }
  window.addEventListener("error", function (ev) { reportError("window", ev.error || new Error(ev.message)); });
  window.addEventListener("unhandledrejection", function (ev) { var r = ev.reason; if (r && (r.code && r.code !== "NETWORK")) return; reportError("promise", r || new Error("unhandled rejection")); });

  /* ---------- helper scripts from the project's static site (never from a CDN) ---------- */
  var loaded = {};
  function staticUrl(path) { var b = IELT.state.boot; return b && b.staticBaseUrl ? b.staticBaseUrl + "/" + path : ""; }
  function loadScript(key) {
    if (loaded[key]) return loaded[key];
    var b = IELT.state.boot;
    if (!b || !b.staticBaseUrl) return Promise.reject(new Error("The address of the static site has not been set by the administrator."));
    if (b.sriEnforce && !b.sri[key]) return Promise.reject(new Error("No integrity hash is configured for a helper script (" + key + "). The administrator has to set it in Settings."));
    loaded[key] = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = staticUrl(b.vendorFiles[key]);
      s.async = true;
      if (b.sriEnforce) { s.integrity = b.sri[key]; s.crossOrigin = "anonymous"; }
      s.onload = function () { resolve(); };
      s.onerror = function () { delete loaded[key]; reject(new Error("A helper script could not be loaded from the static site (" + key + "). Check your connection and try again.")); };
      document.head.appendChild(s);
    });
    return loaded[key];
  }

  /* ---------- progress messages from the static site (360 viewer in the iframe, or a tab it opened) ---------- */
  function countOf(v) { return Array.isArray(v) ? v.length : (typeof v === "number" && v >= 0 && v < 1000 ? Math.floor(v) : undefined); }
  window.addEventListener("message", function (ev) {
    var b = IELT.state.boot, origin;
    if (!b || !b.staticBaseUrl) return;
    try { origin = new URL(b.staticBaseUrl).origin; } catch (e) { return; }
    if (ev.origin !== origin) return;
    var d = ev.data;
    if (!d || typeof d !== "object" || d.source !== "ielt-site" || (d.kind !== "vr" && d.kind !== "ar") || d.event) return;
    var p = { mode: String(d.mode || "").replace(/[^a-z-]/g, "").slice(0, 12), complete: d.complete === true };
    ["total", "required", "scenes"].forEach(function (k) { var c = countOf(d[k]); if (c !== undefined) p[k] = c; });
    var opened = countOf(d.opened); if (opened !== undefined) p.opened = opened;
    var targets = countOf(d.targetsFound); if (targets !== undefined) p.targets = targets;
    IELT.siteProgress[d.kind] = p;
    if (IELT.onSiteProgress) IELT.onSiteProgress(d.kind, p);
  });

  /* ---------- polling: about every 20 seconds, paused while the tab is hidden ---------- */
  var pollTimer = null, lastPoll = 0, polling = false;
  function schedulePoll() { clearTimeout(pollTimer); pollTimer = setTimeout(pollNow, 20000 + Math.random() * 6000 - 3000); }
  function pollNow() {
    if (!IELT.state.token) return;
    if (document.hidden || polling) { schedulePoll(); return; }
    polling = true; lastPoll = Date.now();
    api("apiPoll", undefined, { attempts: 1 }).then(function (res) { if (IELT.onPoll) IELT.onPoll(res); }, function () {}).then(function () { polling = false; schedulePoll(); });
  }
  document.addEventListener("visibilitychange", function () { if (!document.hidden && IELT.state.token && Date.now() - lastPoll > 8000) pollNow(); });
  function stopPolling() { clearTimeout(pollTimer); pollTimer = null; }

  /* ---------- form helpers ---------- */
  /* A labelled text input or textarea with a live character or word counter. Returns { node, input, set, get }. */
  function textField(o) {
    var id = uid("in"), helpId = id + "h", countId = id + "c";
    var input = el(o.rows ? "textarea" : "input", { id: id, type: o.rows ? undefined : (o.type || "text"), rows: o.rows, maxlength: o.max ? o.max : undefined, disabled: o.disabled, required: o.required,
      autocomplete: o.autocomplete || "off", "aria-describedby": (o.help ? helpId + " " : "") + countId, placeholder: o.placeholder, spellcheck: o.spellcheck === false ? "false" : undefined, inputmode: o.inputmode });
    input.value = o.value || "";
    var count = el("div", { class: "count", id: countId, "aria-live": "off" });
    function refresh() {
      if (o.maxWords) { var w = words(input.value); count.textContent = w + " of " + o.maxWords + " words"; count.className = "count" + (w > o.maxWords ? " over" : ""); }
      else if (o.minWords) { var w2 = words(input.value); count.textContent = w2 + " words (at least " + o.minWords + ")"; count.className = "count" + (w2 < o.minWords && input.value ? " over" : ""); }
      else if (o.max) count.textContent = input.value.length + " of " + o.max + " characters";
    }
    input.addEventListener("input", function () { refresh(); if (o.oninput) o.oninput(input.value); });
    if (o.onblur) input.addEventListener("blur", function () { o.onblur(input.value); });
    refresh();
    var node = el("div", { class: "field" }, [el("label", { for: id, text: o.label }), o.help ? el("div", { class: "help", id: helpId, text: o.help }) : null, input, count]);
    return { node: node, input: input, get: function () { return input.value; }, set: function (v) { input.value = v || ""; refresh(); } };
  }
  function selectField(o) {
    var id = uid("sel");
    var sel = el("select", { id: id, disabled: o.disabled, required: o.required }, [el("option", { value: "", text: o.placeholder || "Choose…" })].concat(o.options.map(function (opt) {
      var value = typeof opt === "string" ? opt : opt.value, label = typeof opt === "string" ? opt : opt.label;
      return el("option", { value: value, text: label });
    })));
    sel.value = o.value === undefined || o.value === null ? "" : String(o.value);
    sel.addEventListener("change", function () { if (o.onchange) o.onchange(sel.value); });
    return { node: el("div", { class: "field" }, [el("label", { for: id, text: o.label }), o.help ? el("div", { class: "help", text: o.help }) : null, sel]), input: sel, get: function () { return sel.value; }, set: function (v) { sel.value = v || ""; } };
  }
  function radioGroup(o) {
    var name = uid("rad"), inputs = [];
    var fs = el("fieldset", {}, [el("legend", { text: o.label }), o.help ? el("div", { class: "help small muted", text: o.help }) : null, el("div", { class: "choices" }, o.options.map(function (opt) {
      var value = String(typeof opt === "string" ? opt : opt.value), label = typeof opt === "string" ? opt : opt.label, id = uid("r");
      var inp = el("input", { type: "radio", name: name, id: id, value: value, disabled: o.disabled, checked: String(o.value) === value, onchange: function () { if (o.onchange) o.onchange(value); } });
      inputs.push(inp);
      return el("label", { for: id }, [inp, label]);
    }))]);
    return { node: fs, get: function () { for (var i = 0; i < inputs.length; i++) if (inputs[i].checked) return inputs[i].value; return ""; } };
  }
  function message(kind, text) { return el("div", { class: "msg " + kind, role: kind === "error" ? "alert" : "status", text: text }); }
  /* Runs an async action from a button: disables it, shows errors in the given box. */
  function run(button, box, fn) {
    if (button.disabled) return;
    button.disabled = true;
    if (box) clear(box);
    Promise.resolve().then(fn).then(function () { button.disabled = false; }, function (err) {
      button.disabled = false;
      if (box) { box.appendChild(message("error", err && err.message ? err.message : "Something went wrong. Please try again.")); }
      if (err && !err.code) reportError(IELT.state.module, err);
    });
  }
  /* Local backup of a simple form, so text survives a reload or a lost connection. */
  function backup(key) {
    var timer = null;
    return {
      load: function () { return store.get("form:" + key) || {}; },
      save: function (obj) { clearTimeout(timer); timer = setTimeout(function () { store.set("form:" + key, obj); }, 600); },
      clear: function () { clearTimeout(timer); store.del("form:" + key); }
    };
  }

  IELT.el = el; IELT.add = add; IELT.clear = clear; IELT.uid = uid; IELT.announce = announce; IELT.rid = rid; IELT.sleep = sleep; IELT.words = words; IELT.clock = clock;
  IELT.serverNow = serverNow; IELT.countdown = countdown; IELT.store = store; IELT.setSave = setSave; IELT.api = api; IELT.reportError = reportError;
  IELT.loadScript = loadScript; IELT.staticUrl = staticUrl; IELT.pollNow = pollNow; IELT.schedulePoll = schedulePoll; IELT.stopPolling = stopPolling;
  IELT.textField = textField; IELT.selectField = selectField; IELT.radioGroup = radioGroup; IELT.message = message; IELT.run = run; IELT.backup = backup;
})();

/* ===== JsCertEngine.html ===== */
/*
 * cert_engine.js
 * Certificate engine of the IMMERSIVE ELT DESIGN LAB. One pure function, used unchanged by
 *   - the portal (04_APPS_SCRIPT/src/JsCertEngine.html is a copy of this file inside a script tag),
 *   - the administrator's calibration preview,
 *   - the Node tests (13_TESTING_DEPLOYMENT/apps_script_tests/tests/certificate.test.js).
 *
 * It draws exactly one thing on the template: the participant's name. It adds no date, number, QR
 * code, logo, signature or other text, does not touch page size or page count, does not update the
 * document metadata, and never modifies the template bytes it is given (it works on a parsed copy).
 *
 * Dependencies are passed in: PDFLib (pdf-lib 1.17.1) and fontkit (@pdf-lib/fontkit 1.1.1).
 * No DOM, no network, no clock, no randomness: the same input always gives the same bytes.
 *
 * config = {
 *   page:     0-based index of the page that carries the name (default 0),
 *   x, y:     left end of the name box and the text baseline, in PDF points from the bottom-left corner,
 *   boxWidth: width of the name box in points,
 *   size:     preferred font size in points,
 *   minSize:  smallest size allowed when a long name is shrunk to fit,
 *   align:    "left" | "center" | "right" (position of the name inside the box),
 *   color:    "#RRGGBB",
 *   subset:   embed only the glyphs that are used (default true)
 * }
 *
 * The name box is the rectangle [x, x + boxWidth] horizontally and, vertically, the font's bounding
 * box at the preferred size around the baseline (see nameBox). The engine fits the INK of the name
 * (the outlines of its glyphs, not only their advance widths) into the box, 0.75 pt away from its
 * left and right edge, so nothing is drawn outside it. If the name does not fit even at minSize the engine refuses (reason NAME_TOO_LONG)
 * instead of drawing outside the box or below the minimum size.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CertEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var VERSION = "1.0.0";
  /* The ink keeps this distance (in points) from the left and right edge of the name box, so that
     the antialiasing of a PDF viewer never paints outside the box. */
  var INSET = 0.75;
  var DEFAULTS = { page: 0, x: 0, y: 0, boxWidth: 400, size: 32, minSize: 14, align: "center", color: "#000000", subset: true };

  function normalizeName(name) {
    var s = String(name === null || name === undefined ? "" : name);
    try { s = s.normalize("NFC"); } catch (e) { /* keep as is */ }
    return s.replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
  }
  function normalizeConfig(config) {
    var c = {}, k;
    for (k in DEFAULTS) c[k] = DEFAULTS[k];
    for (k in (config || {})) if (config[k] !== undefined && config[k] !== null) c[k] = config[k];
    ["page", "x", "y", "boxWidth", "size", "minSize"].forEach(function (key) { c[key] = Number(c[key]); if (!isFinite(c[key])) throw new Error("Certificate config: " + key + " is not a number"); });
    c.page = Math.floor(c.page);
    if (!(c.boxWidth > 0) || !(c.size > 0) || !(c.minSize > 0)) throw new Error("Certificate config: boxWidth, size and minSize must be positive");
    if (c.minSize > c.size) c.minSize = c.size;
    if (["left", "center", "right"].indexOf(c.align) < 0) c.align = "center";
    if (!/^#[0-9A-Fa-f]{6}$/.test(String(c.color))) c.color = "#000000";
    c.subset = c.subset !== false;
    return c;
  }
  function hexToRgb(hex) {
    return { r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255 };
  }
  function codePoints(text) {
    var out = [], i, c;
    for (i = 0; i < text.length; i++) {
      c = text.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) { var d = text.charCodeAt(i + 1); if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; } }
      out.push(c);
    }
    return out;
  }
  function fromCodePoint(cp) {
    if (cp <= 0xffff) return String.fromCharCode(cp);
    cp -= 0x10000;
    return String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023));
  }

  /* Characters of the name for which the font has no glyph. */
  function missingGlyphs(fkFont, text) {
    var missing = [];
    codePoints(text).forEach(function (cp) {
      if (!fkFont.hasGlyphForCodePoint(cp)) { var ch = fromCodePoint(cp); if (missing.indexOf(ch) < 0) missing.push(ch); }
    });
    return missing;
  }

  /*
   * Lays the text out exactly as pdf-lib will (fontkit layout with default features, glyph advance
   * widths without kerning adjustments) and returns advance and ink extents in font units.
   */
  function measureUnits(fkFont, text) {
    var run = fkFont.layout(text), pen = 0, left = Infinity, right = -Infinity, top = -Infinity, bottom = Infinity, notdef = 0;
    run.glyphs.forEach(function (g) {
      if (g.id === 0) notdef++;
      var bb = g.bbox;
      if (bb && isFinite(bb.minX) && isFinite(bb.maxX) && bb.maxX > bb.minX) {
        if (pen + bb.minX < left) left = pen + bb.minX;
        if (pen + bb.maxX > right) right = pen + bb.maxX;
        if (bb.maxY > top) top = bb.maxY;
        if (bb.minY < bottom) bottom = bb.minY;
      }
      pen += g.advanceWidth;
    });
    if (!isFinite(left)) { left = 0; right = pen; top = 0; bottom = 0; }
    return { advance: pen, inkLeft: left, inkRight: right, inkTop: top, inkBottom: bottom, glyphs: run.glyphs.length, notdef: notdef };
  }

  /* The name box in PDF points: { x0, y0, x1, y1 } with y0 below the baseline and y1 above it. */
  function nameBox(config, fkFont) {
    var c = normalizeConfig(config), k = c.size / fkFont.unitsPerEm, bb = fkFont.bbox;
    return { x0: c.x, x1: c.x + c.boxWidth, y0: c.y + bb.minY * k, y1: c.y + bb.maxY * k, baseline: c.y };
  }

  /* Chooses the font size and the drawing origin. Sizes are rounded down to 0.05 pt. */
  function fitName(fkFont, text, config) {
    var c = normalizeConfig(config), m = measureUnits(fkFont, text), upm = fkFont.unitsPerEm;
    var inkUnits = m.inkRight - m.inkLeft, avail = Math.max(1, c.boxWidth - 2 * INSET);
    var size = c.size, widthAtSize = inkUnits * size / upm;
    if (widthAtSize > avail) {
      size = Math.floor((avail / inkUnits) * upm * 20) / 20;
      if (size > c.size) size = c.size;
    }
    var fits = size >= c.minSize && size > 0;
    if (!fits) size = c.minSize;
    var k = size / upm, inkWidth = inkUnits * k, drawX;
    if (c.align === "left") drawX = c.x + INSET - m.inkLeft * k;
    else if (c.align === "right") drawX = c.x + c.boxWidth - INSET - m.inkRight * k;
    else drawX = c.x + (c.boxWidth - inkWidth) / 2 - m.inkLeft * k;
    return { fits: fits, size: size, shrunk: size < c.size, drawX: drawX, baseline: c.y,
      ink: { x0: drawX + m.inkLeft * k, x1: drawX + m.inkRight * k, y0: c.y + m.inkBottom * k, y1: c.y + m.inkTop * k, width: inkWidth },
      widthAtMinSize: inkUnits * c.minSize / upm, glyphs: m.glyphs, notdef: m.notdef };
  }

  /* Checks a name against a font and a config without producing a PDF (used for the roster check). */
  function checkName(fontkit, fontBytes, name, config) {
    var fk = fontkit.create(fontBytes), text = normalizeName(name);
    if (!text) return { ok: false, reason: "EMPTY_NAME", name: text };
    var missing = missingGlyphs(fk, text);
    if (missing.length) return { ok: false, reason: "MISSING_GLYPH", missing: missing, name: text };
    var fit = fitName(fk, text, config);
    if (fit.notdef) return { ok: false, reason: "MISSING_GLYPH", missing: [], name: text };
    if (!fit.fits) return { ok: false, reason: "NAME_TOO_LONG", name: text, fittedSize: fit.size, widthAtMinSize: fit.widthAtMinSize };
    return { ok: true, name: text, fittedSize: fit.size, shrunk: fit.shrunk, ink: fit.ink, box: nameBox(config, fk) };
  }

  /*
   * renderCertificate({ PDFLib, fontkit, templateBytes, fontBytes, name, config })
   * Resolves to { ok: true, bytes, name, fittedSize, shrunk, box, ink, pageCount, pageSizes }
   * or          { ok: false, reason, ... } with reason one of
   *   EMPTY_NAME, MISSING_GLYPH, NAME_TOO_LONG, PAGE_OUT_OF_RANGE, ROTATED_PAGE, INTEGRITY.
   */
  function renderCertificate(opts) {
    var PDFLib = opts.PDFLib, fontkit = opts.fontkit;
    var config, text, fk, missing, fit;
    try {
      config = normalizeConfig(opts.config);
      text = normalizeName(opts.name);
      if (!text) return Promise.resolve({ ok: false, reason: "EMPTY_NAME", name: text });
      fk = fontkit.create(opts.fontBytes);
      missing = missingGlyphs(fk, text);
      if (missing.length) return Promise.resolve({ ok: false, reason: "MISSING_GLYPH", missing: missing, name: text });
      fit = fitName(fk, text, config);
      if (fit.notdef) return Promise.resolve({ ok: false, reason: "MISSING_GLYPH", missing: [], name: text });
      if (!fit.fits) return Promise.resolve({ ok: false, reason: "NAME_TOO_LONG", name: text, fittedSize: fit.size, widthAtMinSize: fit.widthAtMinSize });
    } catch (e) { return Promise.reject(e); }

    var before = null, doc = null;
    return PDFLib.PDFDocument.load(opts.templateBytes, { updateMetadata: false }).then(function (d) {
      doc = d;
      doc.registerFontkit(fontkit);
      var pages = doc.getPages();
      before = pages.map(function (p) { var s = p.getSize(); return { width: s.width, height: s.height }; });
      if (config.page < 0 || config.page >= pages.length) return { ok: false, reason: "PAGE_OUT_OF_RANGE", pageCount: pages.length };
      var page = pages[config.page];
      if (page.getRotation().angle % 360 !== 0) return { ok: false, reason: "ROTATED_PAGE", rotation: page.getRotation().angle };
      return doc.embedFont(opts.fontBytes, { subset: config.subset }).then(function (font) {
        var rgb = hexToRgb(config.color);
        page.drawText(text, { x: fit.drawX, y: fit.baseline, size: fit.size, font: font, color: PDFLib.rgb(rgb.r, rgb.g, rgb.b) });
        return doc.save();
      }).then(function (bytes) {
        /* Integrity check on the result: same number of pages, same page sizes. */
        return PDFLib.PDFDocument.load(bytes, { updateMetadata: false }).then(function (check) {
          var after = check.getPages().map(function (p) { var s = p.getSize(); return { width: s.width, height: s.height }; });
          var same = after.length === before.length && after.every(function (s, i) { return Math.abs(s.width - before[i].width) < 0.001 && Math.abs(s.height - before[i].height) < 0.001; });
          if (!same) return { ok: false, reason: "INTEGRITY" };
          return { ok: true, bytes: bytes, name: text, fittedSize: fit.size, shrunk: fit.shrunk, box: nameBox(config, fk), ink: fit.ink, pageCount: after.length, pageSizes: after, glyphs: fit.glyphs };
        });
      });
    });
  }

  return { VERSION: VERSION, DEFAULTS: DEFAULTS, INSET: INSET, renderCertificate: renderCertificate, checkName: checkName, fitName: fitName, nameBox: nameBox, measureUnits: measureUnits,
    missingGlyphs: missingGlyphs, normalizeName: normalizeName, normalizeConfig: normalizeConfig };
});

/* ===== JsDrafts.html ===== */
/*
 * JsDrafts: the client side of versioned group drafts (design, feedback, revision).
 *
 * Saving rules: nothing is sent on a keystroke. A dirty draft is saved at most every 20 seconds, when
 * a field loses focus (not more often than every 8 seconds) and when "Save draft" is pressed. Every
 * save carries the version it was based on; a stale save is refused by the server and the latest
 * draft is shown. Unsaved text is always kept in sessionStorage so it survives a lost connection, a
 * lost editing turn or a reload.
 */
(function () {
  "use strict";
  var IELT = window.IELT, el = IELT.el, clear = IELT.clear, api = IELT.api, store = IELT.store;
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function Draft(kind) {
    this.kind = kind; this.version = 0; this.content = null; this.status = "open"; this.lease = { mine: false, holder: "", expiresAt: 0 };
    this.dirty = false; this.lastInput = 0; this.lastSaveTry = 0; this.saving = null; this.loaded = false; this.notice = ""; this.unsaved = null;
    this.updatedAt = ""; this.updatedBy = ""; this.subs = []; this.backupTimer = null;
  }
  Draft.prototype.sub = function (fn) { if (this.subs.indexOf(fn) < 0) this.subs.push(fn); };
  Draft.prototype.unsub = function (fn) { var i = this.subs.indexOf(fn); if (i >= 0) this.subs.splice(i, 1); };
  Draft.prototype.emit = function (what) { this.subs.slice().forEach(function (fn) { try { fn(what || "state"); } catch (e) { IELT.reportError("draft", e); } }); };
  Draft.prototype.editable = function () { return this.loaded && this.status === "open" && this.lease.mine; };
  Draft.prototype.apply = function (view) {
    this.version = view.version; this.content = view.content; this.status = view.status; this.lease = view.lease || { mine: false, holder: "", expiresAt: 0 };
    this.updatedAt = view.updatedAt || ""; this.updatedBy = view.updatedBy || ""; this.loaded = true;
  };
  /* What a member can see of a draft. If it is the same before and after a refresh, the page is left alone. */
  Draft.prototype.signature = function () {
    return JSON.stringify([this.loaded, this.version, this.status, this.lease.mine, this.lease.holder || "", this.updatedAt, this.updatedBy, this.content, !!this.unsaved]);
  };
  /*
   * Reads the group's draft. While this member is editing with unsaved text, nothing is replaced.
   * The page is redrawn only if something visible changed: a redraw rebuilds the form, and a member
   * who is choosing or typing at that moment should not be interrupted for nothing.
   */
  Draft.prototype.load = function () {
    var self = this;
    return api("apiGetDraft", { kind: self.kind }).then(function (view) {
      if (self.dirty && self.lease.mine) return;
      var before = self.signature();
      self.apply(view);
      var b = store.get("draft:" + self.kind);
      if (b && b.content && self.status === "open" && JSON.stringify(b.content) !== JSON.stringify(view.content)) self.unsaved = b; else if (b) store.del("draft:" + self.kind);
      if (self.signature() !== before) self.emit();
    });
  };
  /* Start editing, or take over editing from another member. restore: put back this browser's unsaved text afterwards. */
  Draft.prototype.start = function (takeover, restore) {
    var self = this;
    return api("apiAcquireLease", { kind: self.kind, takeover: !!takeover }, { write: true }).then(function (view) {
      self.apply(view);
      if (view.granted) {
        self.notice = "";
        if (restore && self.unsaved) { self.content = clone(self.unsaved.content); self.unsaved = null; self.touch(); self.emit(); return self.save(true); }
      } else self.notice = view.reason === "FROZEN" ? "This document has been submitted and can no longer be edited." : (view.lease.holder || "Another member") + " is editing now. You can read along, or take over editing.";
      self.emit();
    });
  };
  /* Called on every change to the working copy. Never talks to the server. */
  Draft.prototype.touch = function () {
    var self = this;
    self.dirty = true; self.lastInput = Date.now();
    IELT.setSave("dirty");
    clearTimeout(self.backupTimer);
    self.backupTimer = setTimeout(function () { store.set("draft:" + self.kind, { version: self.version, content: self.content, at: Date.now() }); }, 700);
  };
  Draft.prototype.blurSave = function () { if (this.dirty && this.lease.mine && !this.saving && Date.now() - this.lastSaveTry > 8000) this.save().then(function () {}, function () {}); };
  Draft.prototype.save = function (explicit) {
    var self = this;
    if (self.saving) return self.saving.then(function () { return self.dirty ? self.save(explicit) : null; });
    if (!self.dirty && !explicit) return Promise.resolve();
    if (!self.editable()) return Promise.reject(new Error("Press \"Start editing\" before you save."));
    self.lastSaveTry = Date.now();
    var sentAt = self.lastInput;
    self.saving = api("apiSaveDraft", { kind: self.kind, baseVersion: self.version, content: clone(self.content) }, { write: true, save: true }).then(function (res) {
      self.saving = null;
      self.version = res.version; self.lease.mine = true; self.lease.expiresAt = res.leaseExpiresAt; if (res.savedAt) self.updatedAt = res.savedAt;
      if (self.lastInput === sentAt) { self.dirty = false; clearTimeout(self.backupTimer); store.del("draft:" + self.kind); } else IELT.setSave("dirty");
      self.emit("saved");
    }, function (err) { self.saving = null; self.saveFailed(err); throw err; });
    return self.saving;
  };
  Draft.prototype.saveFailed = function (err) {
    if (err && err.data && (err.code === "CONFLICT" || err.code === "LEASE_HELD" || err.code === "FROZEN")) {
      this.unsaved = { version: this.version, content: clone(this.content), at: Date.now() };
      store.set("draft:" + this.kind, this.unsaved);
      this.apply(err.data);
      this.dirty = false;
      this.notice = err.message;
      IELT.setSave("idle");
      this.emit();
    }
  };
  Draft.prototype.renew = function () {
    var self = this;
    return api("apiAcquireLease", { kind: self.kind, takeover: false }, { write: true, attempts: 2 }).then(function (view) {
      if (view.granted) self.lease = view.lease; else { self.apply(view); self.notice = (view.lease.holder || "Another member") + " is editing now."; self.emit(); }
    }, function () {});
  };
  /* Runs every two seconds for every draft this page has opened. */
  Draft.prototype.tick = function () {
    if (!this.loaded || !this.lease.mine || this.status !== "open" || this.saving) return;
    var now = Date.now(), left = this.lease.expiresAt - IELT.serverNow();
    if (this.dirty && now - this.lastSaveTry >= 20000) { this.save().then(function () {}, function () {}); return; }
    if (left < 25000) {
      if (now - this.lastInput < 75000) { if (this.dirty) this.save().then(function () {}, function () {}); else if (now - (this.lastRenew || 0) > 10000) { this.lastRenew = now; this.renew(); } }
      else if (left <= 0 && !this.dirty) {
        this.lease = { mine: false, holder: "", expiresAt: 0 };
        this.notice = "Your editing turn ended after 90 seconds without changes. Press \"Start editing\" to continue.";
        this.emit();
      }
    }
  };
  /* Polling tells every member which version exists and who is editing. */
  Draft.prototype.onPoll = function (meta) {
    if (!meta || !this.loaded) return;
    if (this.lease.mine && this.status === "open") { if (!meta.leaseMine && meta.leaseHolder && !this.saving) this.load().then(function () {}, function () {}); return; }
    var changed = meta.version !== this.version || meta.status !== this.status || (meta.leaseHolder || "") !== (this.lease.holder || "");
    if (changed) this.load().then(function () {}, function () {});
  };
  function draft(kind) { if (!IELT.drafts[kind]) IELT.drafts[kind] = new Draft(kind); return IELT.drafts[kind]; }
  setInterval(function () { Object.keys(IELT.drafts).forEach(function (k) { IELT.drafts[k].tick(); }); }, 2000);
  /* Keep the latest text locally when the tab is hidden or closed (a request may not get through then). */
  function flushLocal() { Object.keys(IELT.drafts).forEach(function (k) { var d = IELT.drafts[k]; if (d.dirty) store.set("draft:" + k, { version: d.version, content: d.content, at: Date.now() }); }); }
  document.addEventListener("visibilitychange", function () { if (document.hidden) flushLocal(); });
  window.addEventListener("pagehide", flushLocal);

  /* ---------- shared pieces of the group modules ---------- */

  /* Who is editing, with the buttons Start editing, Take over editing and Save draft. */
  function leaseBar(d, opts) {
    opts = opts || {};
    var box = el("div", {}), bar = el("div", { class: "card lease" }), msg = el("div", {});
    var text = el("p", { role: "status", "aria-live": "polite", style: "margin:0" });
    bar.appendChild(text);
    if (d.status === "frozen") text.textContent = opts.frozenText || "This document has been submitted and is locked.";
    else if (d.lease.mine) {
      text.textContent = "You are editing. Your group sees your text after each save.";
      bar.appendChild(el("span", { class: "spacer" }));
      var save = el("button", { class: "btn", type: "button", text: opts.saveLabel || "Save draft" });
      save.addEventListener("click", function () { IELT.run(save, msg, function () { return (opts.onSave ? opts.onSave() : d.save(true)).then(function () { msg.appendChild(IELT.message("ok", "Saved. Version " + d.version + ".")); }); }); });
      bar.appendChild(save);
    } else if (d.lease.holder) {
      text.textContent = d.lease.holder + " is editing now. The text below updates after each save.";
      bar.appendChild(el("span", { class: "spacer" }));
      var take = el("button", { class: "btn", type: "button", text: "Take over editing" });
      take.addEventListener("click", function () { if (window.confirm(d.lease.holder + " is editing. Take over? Tell them first, so that nobody loses text.")) IELT.run(take, msg, function () { return d.start(true); }); });
      bar.appendChild(take);
    } else {
      text.textContent = "Nobody is editing. One member edits at a time; the others read along.";
      bar.appendChild(el("span", { class: "spacer" }));
      var start = el("button", { class: "btn primary", type: "button", text: "Start editing" });
      start.addEventListener("click", function () { IELT.run(start, msg, function () { return d.start(false); }); });
      bar.appendChild(start);
    }
    box.appendChild(bar);
    if (d.notice) box.appendChild(IELT.message("info", d.notice));
    if (d.unsaved && d.status === "open") {
      var restore = el("button", { class: "btn", type: "button", text: d.lease.mine ? "Restore my unsaved text" : "Take over editing and restore my text" });
      var drop = el("button", { class: "btn quiet", type: "button", text: "Discard it" });
      restore.addEventListener("click", function () { IELT.run(restore, msg, function () { return d.start(!d.lease.mine && !!d.lease.holder, true); }); });
      drop.addEventListener("click", function () { d.unsaved = null; store.del("draft:" + d.kind); d.emit(); });
      box.appendChild(el("div", { class: "card warning" }, [el("p", { text: "This browser holds text of yours from " + IELT.clock(d.unsaved.at) + " that was not saved to the group draft." }), el("div", { class: "row" }, [restore, drop])]));
    }
    if (d.updatedAt && d.status !== "frozen") box.appendChild(el("p", { class: "small muted", "data-version-info": "1", text: "Version " + d.version + ", last saved at " + d.updatedAt + (d.updatedBy ? " by " + d.updatedBy : "") + "." }));
    box.appendChild(msg);
    return box;
  }

  /* The 12 designer fields, grouped by PIVOT, bound to design (an object inside a draft's content). */
  function designFields(d, design) {
    var schema = IELT.state.boot.schema, editable = d.editable(), wrap = el("div", {});
    schema.pivot.forEach(function (pv) {
      var body = el("div", { class: "body" });
      schema.designerFields.filter(function (f) { return f.pivot === pv.id; }).forEach(function (f) {
        var set = function (v) { design[f.id] = v; d.touch(); };
        var help = [f.helper, f.example].filter(Boolean).join(" ");
        if (f.type === "select") body.appendChild(IELT.selectField({ label: f.label, options: f.options, value: design[f.id], disabled: !editable, help: help, onchange: function (v) { set(v); d.blurSave(); } }).node);
        else {
          var tf = IELT.textField({ label: f.label, rows: f.type === "textarea" ? (f.max > 450 ? 5 : 3) : 0, max: f.max, value: design[f.id], disabled: !editable, help: help, oninput: set, onblur: function () { d.blurSave(); } });
          if (f.starter && editable && !design[f.id]) tf.input.setAttribute("placeholder", f.starter + "…");
          body.appendChild(tf.node);
        }
      });
      wrap.appendChild(el("section", { class: "pivot", "aria-label": pv.name }, [
        el("header", {}, [el("span", { class: "letter", "aria-hidden": "true", text: pv.id }), el("div", {}, [el("h3", { style: "margin:0", text: pv.name }), el("div", { class: "small muted", text: pv.prompt })]),
          el("span", { class: "pace", text: "about " + pv.minutes + " min" })]), body]));
    });
    return wrap;
  }

  /* Builds a student instruction sheet from the designer fields (one click, then editable). */
  function instructionSheet(design) {
    var lines = [];
    var push = function (label, v) { if (v) lines.push(label + v); };
    push("Level: ", design.cefr);
    push("Work in: ", design.interaction);
    push("Your goal: ", design.objective);
    push("The situation: ", design.context);
    push("Your problem: ", design.problem);
    push("What to do: ", design.instructions);
    push("What you will produce: ", design.output);
    push("How you will know you did well: ", design.evidence);
    push("If you cannot use the device: ", design.accessibility);
    return { type: "student instruction sheet", title: (design.title || "Our task").slice(0, 80), body: lines.join("\n").slice(0, IELT.state.boot.schema.materialLimits.body) };
  }

  /* Editor for the list of materials inside a draft's content. repaint() redraws the module after add or remove. */
  function materialsEditor(d, holder, repaint) {
    var schema = IELT.state.boot.schema, lim = schema.materialLimits, editable = d.editable(), wrap = el("div", {});
    if (!holder.materials) holder.materials = [];
    if (!holder.materials.length) wrap.appendChild(el("p", { class: "muted", text: "No material yet. A design needs at least one short student-facing material." }));
    holder.materials.forEach(function (m, i) {
      var box = el("div", { class: "material" });
      box.appendChild(el("h4", { text: "Material " + (i + 1) }));
      box.appendChild(IELT.selectField({ label: "Type", options: schema.materialTypes, value: m.type, disabled: !editable, onchange: function (v) { m.type = v || schema.materialTypes[0]; d.touch(); d.blurSave(); } }).node);
      box.appendChild(IELT.textField({ label: "Title", max: lim.title, value: m.title, disabled: !editable, oninput: function (v) { m.title = v; d.touch(); }, onblur: function () { d.blurSave(); } }).node);
      box.appendChild(IELT.textField({ label: "Text for the learners", rows: 7, max: lim.body, value: m.body, disabled: !editable, oninput: function (v) { m.body = v; d.touch(); }, onblur: function () { d.blurSave(); } }).node);
      if (editable) box.appendChild(el("button", { class: "btn danger", type: "button", text: "Remove material " + (i + 1), onclick: function () {
        if (!window.confirm("Remove this material?")) return;
        holder.materials.splice(i, 1); d.touch(); repaint();
      } }));
      wrap.appendChild(box);
    });
    if (editable) {
      var full = holder.materials.length >= lim.max;
      wrap.appendChild(el("div", { class: "row" }, [
        el("button", { class: "btn", type: "button", text: "Add material", disabled: full, onclick: function () { holder.materials.push({ type: schema.materialTypes[0], title: "", body: "" }); d.touch(); repaint(); } }),
        el("button", { class: "btn primary", type: "button", text: "Generate instruction sheet from our design", disabled: full, onclick: function () { holder.materials.push(instructionSheet(holder.design || {})); d.touch(); repaint(); d.save().then(function () {}, function () {}); } })
      ]));
      if (full) wrap.appendChild(el("p", { class: "small muted", text: "A design can have at most " + lim.max + " materials." }));
    }
    return wrap;
  }

  /* Read-only view of a design and its materials (own snapshot, or the design under review). */
  function designReadout(design, materials) {
    var schema = IELT.state.boot.schema, dl = el("dl", { class: "readout" });
    schema.designerFields.forEach(function (f) {
      dl.appendChild(el("dt", { text: f.label }));
      dl.appendChild(el("dd", { class: design[f.id] ? "" : "empty", text: design[f.id] || "Not filled in" }));
    });
    var wrap = el("div", {}, [dl]);
    (materials || []).forEach(function (m, i) {
      wrap.appendChild(el("div", { class: "material" }, [el("h4", { text: "Material " + (i + 1) + ": " + m.type + (m.title ? " (" + m.title + ")" : "") }), el("p", { style: "white-space:pre-wrap;overflow-wrap:anywhere", text: m.body })]));
    });
    return wrap;
  }

  /* "Check in to this stage": each member records the part they contributed to, under their own sign-in. */
  /*
   * Personal check-in to a stage. The surrounding page can be redrawn at any moment (a group mate saves,
   * the editing turn changes), which replaces this card by a new one. So the choice that was made, a
   * request that is on its way and the confirmation are kept outside the card and shown by whichever
   * card is on the page.
   */
  var checkins = { cards: [], choice: {}, busy: {}, confirmedAt: {} };
  function checkinCard(kind) {
    var parts = IELT.state.boot.schema.checkinParts[kind];
    var box = el("div", { class: "card" }), msg = el("div", {}), state = el("p", { role: "status" });
    function mine() { return IELT.state.boot.mine.ci[kind]; }
    var sel = IELT.selectField({ label: "The part you contributed to", options: parts, value: checkins.choice[kind] || (mine() ? mine().contribution : ""),
      help: "A group submission does not credit a member by itself. Each member checks in under their own sign-in.", onchange: function (v) { checkins.choice[kind] = v; } });
    var btn = el("button", { class: "btn go", type: "button", text: "Check in to this stage" });
    function show() {
      var m = mine();
      state.textContent = m ? "You checked in at " + m.at + ": " + m.contribution + "." : "You have not checked in to this stage yet.";
      btn.disabled = !!checkins.busy[kind];
      if (checkins.confirmedAt[kind] && Date.now() - checkins.confirmedAt[kind] < 20000 && !msg.firstChild) msg.appendChild(IELT.message("ok", "Your check-in is recorded."));
    }
    function showAll(errorText) {
      checkins.cards = checkins.cards.filter(function (c) { return document.body.contains(c.box); });
      checkins.cards.forEach(function (c) { if (c.kind === kind) { c.show(); if (errorText && c.box !== box) c.fail(errorText); } });
    }
    btn.addEventListener("click", function () {
      IELT.run(btn, msg, function () {
        if (!sel.get()) throw new Error("Choose the part you contributed to.");
        checkins.busy[kind] = true; checkins.confirmedAt[kind] = 0;
        return api("apiCheckIn", { stage: kind, contribution: sel.get() }, { write: true }).then(function (res) {
          checkins.busy[kind] = false; checkins.confirmedAt[kind] = Date.now(); delete checkins.choice[kind];
          IELT.state.boot.mine.ci[kind] = { contribution: res.record.contribution, at: res.record.at, late: res.record.late };
          IELT.setProgress(res.progress); IELT.renderNext();
          showAll();
        }, function (e) { checkins.busy[kind] = false; showAll(e && e.message ? e.message : "The check-in could not be recorded. Please try again."); throw e; });
      });
    });
    checkins.cards.push({ kind: kind, box: box, show: show, fail: function (text) { IELT.clear(msg); msg.appendChild(IELT.message("error", text)); } });
    show();
    IELT.add(box, [el("h3", { text: "Your check-in" }), state, sel.node, btn, msg]);
    return box;
  }

  IELT.draft = draft; IELT.leaseBar = leaseBar; IELT.designFields = designFields; IELT.materialsEditor = materialsEditor; IELT.designReadout = designReadout;
  IELT.checkinCard = checkinCard; IELT.instructionSheet = instructionSheet; IELT.clone = clone;
})();

/* ===== JsParticipant.html ===== */
/*
 * JsParticipant: the educational modules. Welcome, VR Explorer, AR Explorer, Task Analyzer,
 * Task Designer, Materials Studio, Peer Feedback, Revision Studio, Final Submission, Exit Ticket.
 * Labels follow 00_PROJECT_CONTROL/UI_Labels.md.
 */
(function () {
  "use strict";
  var IELT = window.IELT, el = IELT.el, clear = IELT.clear, api = IELT.api, M = IELT.modules;
  function boot() { return IELT.state.boot; }
  function schema() { return IELT.state.boot.schema; }
  function card(cls, children) { return el("div", { class: "card " + (cls || "") }, children); }
  function stamp(rec, text) { return el("span", { class: "stamp" + (rec && rec.late ? " late" : ""), text: text + (rec && rec.late ? " (after its stage)" : "") }); }
  function needGroup(root) {
    if (boot().group) return false;
    root.appendChild(card("notice", [el("p", { text: "You are not in a group yet. Groups are assigned by the facilitator. This page will work as soon as you are in a group." })]));
    IELT.current = { onPoll: function () { if (boot().group) IELT.go(IELT.state.module, true); } };
    return true;
  }
  function modeName(mode) { return mode === "vr" ? "360° viewer" : mode === "vr-alt" ? "static version" : mode === "ar" ? "camera AR" : mode === "ar-alt" ? "non-camera version" : mode; }
  function staticMissing(root) {
    if (boot().staticBaseUrl) return false;
    root.appendChild(card("warning", [el("p", { text: "The address of the workshop site has not been set yet. Please tell the facilitator." })]));
    return true;
  }
  /* Link to the project's static site in a new tab. rel=opener lets that page report its progress back; no personal data is in the address. */
  function siteLink(path, label, cls) { return el("a", { class: "btn " + (cls || ""), href: IELT.staticUrl(path), target: "_blank", rel: "opener", text: label }); }

  /* ---------- Welcome ---------- */
  M.welcome = { render: function (root) {
    var b = boot(), g = b.group, st = IELT.state.stage;
    root.appendChild(card("instructions", [
      el("p", { class: "eyebrow", text: "Designing Immersive ELT Tasks: From VR and AR to Pedagogy" }),
      el("p", {}, [el("strong", { text: "Welcome, " + b.me.name + "." }), " This portal guides you through the workshop one step at a time."]),
      el("p", { text: "Our question today: how can we transform virtual and augmented experiences into pedagogically meaningful language-learning tasks?" }),
      el("ul", {}, [
        el("li", { text: "The facilitator opens each stage. Your next step is always shown at the bottom of the page and in the list of steps." }),
        el("li", { text: "Earlier steps stay open, so you can catch up if you were disconnected. Late steps are recorded with their time." }),
        el("li", { text: "The bar at the top shows the stage, your progress, whether your work is saved, and your certificate status." })
      ])
    ]));
    root.appendChild(card("", [el("h3", { text: "Where we are" }), el("p", {}, ["Current stage: ", el("strong", { text: st.id + " " + st.name }), "."]),
      el("p", { class: "muted", text: st.index === 0 ? "The workshop has not started yet. You can check your device now: when the VR Explorer opens you will need a browser that can show the 360° scenes (no headset is needed)." : "Follow the facilitator in the meeting and use \"Continue\" below." })]));
    if (g) root.appendChild(card("", [el("h3", { text: "Your group: Group " + g.no }),
      el("p", {}, ["Members: ", g.members.join(", "), "."]),
      g.brief ? el("p", {}, [el("strong", { text: "Challenge brief " + g.brief.no + ": " }), g.brief.context + ". Learners: " + g.brief.learners + ". Target: " + g.brief.target + "."]) : null,
      el("p", { class: "muted", text: "Your group will review the design of Group " + g.reviewsNo + ", and Group " + g.reviewedByNo + " will review yours." })]));
    else root.appendChild(card("notice", [el("p", { text: "Groups have not been assigned yet. The facilitator does this before the design sprint." })]));
    if (b.research && b.research.enabled) root.appendChild(card(st.index === 0 ? "notice" : "", [el("h3", { text: "Individual Tasks" }),
      el("p", {}, [el("strong", { text: "Everyone does these. " }), "Before the workshop: a few background questions and one short design task (about 10 minutes). This part closes when the workshop starts. After the workshop: one design task and two reflection questions."]),
      el("p", { class: "muted", text: "You also decide there whether your answers may be used in the research. Your certificate does not depend on these tasks." }),
      el("button", { class: "btn primary", type: "button", text: "Open Individual Tasks", onclick: function () { IELT.go("research"); } })]));
    IELT.current = { onPoll: function (res) { if (res.groupStamp !== undefined && res.groupStamp !== boot().groupStamp) IELT.refreshBoot().then(function () { IELT.go("welcome", true); }, function () {}); } };
  } };

  /* ---------- VR Explorer and AR Explorer share the checkpoint form ---------- */
  function checkpointForm(kind, root) {
    var b = boot(), rec = b.mine[kind], lim = schema().individualLimits, saved = IELT.backup("checkpoint:" + kind), draft = saved.load();
    var box = card(""), msg = el("div", {}), state = el("p", { role: "status" });
    function showState() {
      clear(state);
      if (rec) IELT.add(state, [stamp(rec, "Recorded at " + rec.at + ": " + modeName(rec.mode)), " You can record it again if you used a different version."]);
      else state.textContent = "Not recorded yet.";
    }
    showState();
    var word = IELT.textField({ label: "Checkpoint word", max: 40, value: draft.word || "", spellcheck: false, help: "The word shown at the end of the " + (kind === "vr" ? "VR" : "AR") + " experience. It records which version you used.", oninput: function () { saved.save({ word: word.get(), note: note.get() }); } });
    word.input.setAttribute("autocapitalize", "characters");
    var note = IELT.textField({ label: kind === "vr" ? "In one sentence: what could you do in the scenes that a photo or a video would not let you do?" : "In one sentence: what did the overlay add to the printed target?",
      rows: 2, max: lim.note, value: draft.note || (rec ? rec.note : ""), oninput: function () { saved.save({ word: word.get(), note: note.get() }); } });
    var btn = el("button", { class: "btn go", type: "button", text: kind === "vr" ? "Record my VR exploration" : "Record my AR exploration" });
    btn.addEventListener("click", function () {
      IELT.run(btn, msg, function () {
        if (!word.get().replace(/\s/g, "")) throw new Error("Type the checkpoint word.");
        if (IELT.words(note.get()) < lim.noteMinWords) throw new Error("Please write one full sentence in the note.");
        return api("apiSubmitCheckpoint", { kind: kind, word: word.get(), note: note.get(), progress: IELT.siteProgress[kind] || {} }, { write: true, save: true }).then(function (res) {
          rec = res.record; b.mine[kind] = rec; saved.clear(); word.set(""); showState();
          IELT.setProgress(res.progress); IELT.renderNext();
          msg.appendChild(IELT.message("ok", "Recorded: " + modeName(rec.mode) + "."));
          IELT.announce("Your " + (kind === "vr" ? "VR" : "AR") + " exploration is recorded.");
        });
      });
    });
    IELT.add(box, [el("h3", { text: "Record this step" }), state, word.node, note.node, btn, msg]);
    root.appendChild(box);
  }

  M.vr = { render: function (root) {
    if (staticMissing(root)) return;
    var progress = el("p", { class: "small muted", role: "status", "aria-live": "polite" });
    function showProgress(p) {
      if (!p) { progress.textContent = "Progress of the viewer appears here while you explore."; return; }
      progress.textContent = p.complete ? "The tour is complete. The viewer now shows your checkpoint word."
        : "Viewer progress: " + (p.total === undefined ? (p.opened || 0) : p.total) + (p.required ? " of " + p.required : "") + " steps done" + (p.scenes !== undefined ? ", " + p.scenes + " of 3 scenes finished" : "") + ".";
    }
    root.appendChild(card("instructions", [el("p", { class: "eyebrow", text: "Stage S2, about 6 minutes" }),
      el("p", { text: "Explore the Virtual City: three connected 360° scenes (Tourist Information Centre, Train Station, Cultural Museum). No headset is needed." }),
      el("ol", {}, [el("li", { text: "Open the 360° viewer. Drag to look around." }),
        el("li", { text: "Follow the numbered steps in order. The scenes unlock one after another." }),
        el("li", { text: "The checkpoint word appears after the last step. Type it below with a one-sentence note." })]),
      el("p", { class: "muted", text: "If the viewer does not load, feels uncomfortable or your connection is slow, use the static version. It counts in the same way and has its own checkpoint word." })]));
    var holder = el("div", {});
    var open = el("button", { class: "btn primary", type: "button", text: "Open the 360° viewer" });
    open.addEventListener("click", function () {
      clear(holder);
      holder.appendChild(el("iframe", { class: "viewer", src: IELT.staticUrl("vr/index.html?embed=1"), title: "The Virtual City Experience, 360 degree viewer", allow: "fullscreen; accelerometer; gyroscope", allowfullscreen: true, referrerpolicy: "no-referrer", loading: "eager" }));
      open.textContent = "Reload the 360° viewer";
    });
    root.appendChild(card("", [el("div", { class: "row" }, [open, siteLink("alt/vr.html", "Open the static version")]), progress, holder]));
    showProgress(IELT.siteProgress.vr);
    checkpointForm("vr", root);
    IELT.current = { onSiteProgress: function (kind, p) { if (kind === "vr") showProgress(p); } };
  } };

  M.ar = { render: function (root) {
    if (staticMissing(root)) return;
    var targets = schema().arTargets, current = IELT.store.get("arTarget") || targets[0].id;
    var arUrl = IELT.staticUrl("ar/index.html");
    root.appendChild(card("instructions", [el("p", { class: "eyebrow", text: "Stage S3, about 5 minutes" }),
      el("p", { text: "Explore the Augmented City: point a phone camera at a printed or on-screen target and extra information appears on top of it." }),
      el("ol", {}, [el("li", { text: "Show a target on this screen (or use a printed target)." }),
        el("li", { text: "Scan the QR code with your phone to open the AR page, allow the camera, and point the phone at the target. The camera image never leaves your phone." }),
        el("li", { text: "Open at least two overlay items. Then type the checkpoint word below with a one-sentence note." })]),
      el("p", { class: "muted", text: "The portal itself cannot use a camera, so AR opens in a separate tab or on your phone. No camera, or camera not allowed? Use the non-camera version. It is not AR, but it shows the same information and counts for this step." })]));
    /* 1. target */
    var img = el("img", { class: "target-img", alt: "" }), caption = el("p", { class: "small muted" });
    function show(id) {
      var t = targets.filter(function (x) { return x.id === id; })[0] || targets[0];
      current = t.id; IELT.store.set("arTarget", t.id);
      img.src = IELT.staticUrl(t.file);
      img.alt = "AR target " + t.letter + ": " + t.title + ". Point the phone camera at this picture.";
      caption.textContent = "Target " + t.letter + ": " + t.title + ". Keep the whole picture visible to the phone camera.";
      Array.prototype.forEach.call(picker.querySelectorAll("button"), function (bn) { bn.setAttribute("aria-pressed", bn.getAttribute("data-id") === t.id ? "true" : "false"); });
    }
    var picker = el("div", { class: "row stagebtns", role: "group", "aria-label": "Show a target on this screen" }, targets.map(function (t) {
      return el("button", { class: "btn", type: "button", "data-id": t.id, "aria-pressed": "false", text: t.letter + ": " + t.title, onclick: function () { show(t.id); } });
    }));
    root.appendChild(card("", [el("h3", { text: "1. Show a target on this screen" }), picker, img, caption]));
    show(current);
    /* 2. open AR */
    var qrBox = el("div", { class: "qr" }), qrNote = el("p", { class: "small muted", text: "Preparing the QR code…" });
    qrBox.appendChild(qrNote);
    root.appendChild(card("", [el("h3", { text: "2. Scan with your phone (QR)" }), qrBox,
      el("p", { class: "small", style: "overflow-wrap:anywhere" }, ["Or type this address on your phone: ", arUrl]),
      el("div", { class: "row" }, [siteLink("ar/index.html", "Open AR on this device"), siteLink("alt/ar.html", "Open the non-camera version")])]));
    IELT.loadScript("qrcode").then(function () {
      var qr = window.qrcode(0, "M"); qr.addData(arUrl); qr.make();
      var n = qr.getModuleCount(), quiet = 4, scale = 6, size = (n + quiet * 2) * scale;
      var c = el("canvas", { width: size, height: size, role: "img", "aria-label": "QR code that opens the AR page on a phone" }), ctx = c.getContext("2d");
      ctx.fillStyle = "#FFFFFF"; ctx.fillRect(0, 0, size, size); ctx.fillStyle = "#0C1322";
      for (var r = 0; r < n; r++) for (var col = 0; col < n; col++) if (qr.isDark(r, col)) ctx.fillRect((col + quiet) * scale, (r + quiet) * scale, scale, scale);
      clear(qrBox); qrBox.appendChild(c);
      qrBox.appendChild(el("p", { class: "small muted", text: "The code contains only the address of the AR page. It carries no information about you." }));
    }, function (err) { qrNote.textContent = "The QR code could not be prepared (" + err.message + "). Use the address below instead."; });
    /* 3. record */
    var progress = el("p", { class: "small muted", role: "status", "aria-live": "polite", text: "" });
    root.appendChild(progress);
    checkpointForm("ar", root);
    IELT.current = { onSiteProgress: function (kind, p) { if (kind === "ar") progress.textContent = p.complete ? "The AR page reports that you have finished. It now shows your checkpoint word." : "AR progress: " + (p.opened || 0) + " overlay items opened."; } };
  } };

  /* ---------- Task Analyzer (items TA1 to TA4 of 03_INSTRUMENTS/Reflection_Prompts.md, served by the server) ---------- */
  M.analyzer = { render: function (root) {
    var b = boot(), rec = b.mine.analyzer, form = schema().analyzerForm, saved = IELT.backup("analyzer"), d = saved.load(), ctl = {};
    var keep = function () { var o = {}; form.items.forEach(function (it) { o[it.field] = ctl[it.field].get(); }); saved.save(o); };
    root.appendChild(card("instructions", [el("p", { class: "eyebrow", text: "Stage S4, individual, about 3 minutes" }), el("p", { text: form.screenText }),
      el("p", {}, [el("strong", { text: "Objective: " }), schema().analyzerObjective])]));
    var msg = el("div", {}), state = el("p", { role: "status" }), box = card("", [state]);
    form.items.forEach(function (it) {
      var value = d[it.field] || (rec ? rec[it.field] : "");
      ctl[it.field] = it.options ? IELT.radioGroup({ label: it.prompt, value: value, options: it.options, onchange: keep }) : IELT.textField({ label: it.prompt, rows: 3, max: it.max, value: value, oninput: keep });
      ctl[it.field].node.setAttribute("data-item", it.item);
      box.appendChild(ctl[it.field].node);
    });
    function showState() { clear(state); if (rec) state.appendChild(stamp(rec, "Submitted at " + rec.at)); else state.textContent = "Not submitted yet."; }
    showState();
    var btn = el("button", { class: "btn go", type: "button", text: "Submit my analysis" });
    btn.addEventListener("click", function () {
      IELT.run(btn, msg, function () {
        var payload = {};
        form.items.forEach(function (it) { payload[it.field] = ctl[it.field].get(); });
        if (form.items.some(function (it) { return !payload[it.field]; })) throw new Error("Please answer all four questions.");
        return api("apiSubmitAnalyzer", payload, { write: true, save: true }).then(function (res) {
          rec = res.record; b.mine.analyzer = rec; saved.clear(); showState(); IELT.setProgress(res.progress); IELT.renderNext();
          msg.appendChild(IELT.message("ok", "Your analysis is recorded."));
        });
      });
    });
    IELT.add(box, [btn, msg]);
    root.appendChild(box);
  } };

  /* ---------- Task Designer and Materials Studio (one shared group draft) ---------- */
  function briefCard() {
    var g = boot().group, br = g.brief;
    return card("instructions", [el("p", { class: "eyebrow", text: "Stage S5, design sprint, 13 minutes in your breakout room" }),
      el("p", {}, [el("strong", { text: "Your challenge brief " + (br ? br.no : "") + ". " }), br ? "Context: " + br.context + ". Learners: " + br.learners + ". Target area: " + br.target + "." : ""]),
      el("p", { text: "Design ONE complete, coherent communicative task of 8 to 10 minutes, not a lesson plan. VR or AR is your group's choice. Justify it, and say when the technology would not be the right choice." }),
      g.modalityAssigned ? el("p", {}, [el("strong", { text: "For this session the facilitator has assigned your group: " + g.assignedModality + "." })]) : null,
      el("p", { class: "small muted", text: schema().pacingNote })]);
  }
  /*
   * Reference view of the 360 scene of the group's brief (shown in the Task Designer, which opens with stage S5).
   * It opens the static site in a new tab without an opener, so nothing can be reported back: it is a way to look
   * things up, not exploration evidence. The address holds the scene id only, never anything about the person.
   */
  function sceneReferenceCard() {
    var br = boot().group.brief;
    if (!br || !br.scene || !IELT.staticUrl("")) return null;
    return card("", [el("h3", { text: "Look at your brief's scene again" }),
      el("p", { text: "This opens the 360° scene of your brief in a new tab, with every information point open and no fixed order, so your group can check details while you design." }),
      el("a", { class: "btn", href: IELT.staticUrl("vr/index.html?free=1&scene=" + encodeURIComponent(br.scene)), target: "_blank", rel: "noopener noreferrer", "data-scene-reference": br.scene,
        text: "Open your brief's scene (reference view)" }),
      el("p", { class: "small muted", text: "The reference view shows no checkpoint word and is not recorded. It does not replace your VR exploration." })]);
  }
  function groupModule(kind, paintBody, extraLeave) {
    return function (root) {
      if (needGroup(root)) return;
      var d = IELT.draft(kind), view = el("div", {}), err = el("div", {});
      root.appendChild(view); root.appendChild(err);
      function paint(what) {
        if (what === "saved") { var info = view.querySelector("[data-version-info]"); if (info) info.textContent = "Version " + d.version + ", last saved at " + d.updatedAt + "."; return; }
        var active = document.activeElement, keep = active && view.contains(active) && active.id ? active.id : "";
        clear(view);
        if (!d.loaded) { view.appendChild(el("p", { class: "card", role: "status", text: "Loading your group's draft…" })); return; }
        paintBody(view, d, paint);
        if (keep) { var again = document.getElementById(keep); if (again && again.focus) again.focus(); }
      }
      d.sub(paint);
      paint();
      d.load().then(function () {}, function (e) { err.appendChild(IELT.message("error", e.message)); });
      IELT.current = {
        onPoll: function (res) { if (res.drafts) d.onPoll(res.drafts[kind]); if (extraLeave && extraLeave.onPoll) extraLeave.onPoll(res, paint); },
        onLeave: function () { d.unsub(paint); if (d.dirty && d.lease.mine) d.save().then(function () {}, function () {}); }
      };
    };
  }
  function v1Note(d) { return d.status === "frozen" ? "V1 has been submitted. The design is locked here; your group revises it in the Revision Studio after peer feedback." : ""; }

  M.designer = { render: groupModule("design", function (view, d, paint) {
    var p = IELT.state.progress, msg = el("div", {});
    view.appendChild(briefCard());
    var reference = sceneReferenceCard();
    if (reference) view.appendChild(reference);
    view.appendChild(IELT.leaseBar(d, { frozenText: v1Note(d) }));
    view.appendChild(IELT.designFields(d, d.content.design));
    view.appendChild(card("", [el("h3", { text: "Teaching material" }),
      el("p", { text: "Materials in this design: " + (d.content.materials || []).length + ". One short student-facing material is required before V1 can be submitted." }),
      el("button", { class: "btn", type: "button", text: "Open the Materials Studio", onclick: function () { IELT.go("materials"); } })]));
    view.appendChild(IELT.checkinCard("design"));
    if (d.status !== "frozen") {
      var submit = el("button", { class: "btn go", type: "button", text: "Submit V1 for peer review" });
      submit.addEventListener("click", function () {
        var req = schema().v1Required, missing = schema().designerFields.filter(function (f) { return req.indexOf(f.id) >= 0 && !d.content.design[f.id]; }).map(function (f) { return f.label; });
        var empty = schema().designerFields.filter(function (f) { return !d.content.design[f.id]; }).length;
        IELT.run(submit, msg, function () {
          if (missing.length) throw new Error("Before submitting, fill in: " + missing.join(", ") + ".");
          if (!(d.content.materials || []).some(function (m) { return m.body; })) throw new Error("Add one student-facing material in the Materials Studio first. One click there creates an instruction sheet from your design.");
          if (!window.confirm("Submit V1 for peer review?" + (empty ? " " + empty + " fields are still empty." : "") + " After this, the design is locked until the revision stage.")) return null;
          return (d.dirty ? d.save() : Promise.resolve()).then(function () { return api("apiSubmitV1", { baseVersion: d.version }, { write: true, save: true }); }).then(function (res) {
            IELT.setProgress(res.progress); IELT.announce("V1 is submitted.");
            return d.load().then(function () { IELT.renderNext(); });
          }, function (e) { if (e.data && e.data.version !== undefined) d.saveFailed(e); else if (e.code === "ALREADY_SUBMITTED") d.load(); throw e; });
        });
      });
      view.appendChild(card("", [el("h3", { text: "Submit" }), el("p", { class: "muted", text: "Any member can submit once the draft is saved. V1 is a snapshot: it cannot be changed afterwards." }), submit, msg]));
    } else view.appendChild(card("success", [el("p", {}, [el("strong", { text: "V1 submitted" + (p && p.group && p.group.v1At ? " at " + p.group.v1At : "") + ". " }), "It is now with your reviewing group."])]));
  }) };

  M.materials = { render: groupModule("design", function (view, d, paint) {
    view.appendChild(card("instructions", [el("p", { class: "eyebrow", text: "Part of the design sprint, about 1 minute" }),
      el("p", { text: "Add one short student-facing material for your task: a role card, a student instruction sheet, an information-gap card, a scenario card, a language scaffold or an assessment checklist. One is required; more are optional." }),
      el("p", { class: "muted", text: "Short on time? \"Generate instruction sheet from our design\" builds an instruction sheet from the Task Designer fields. You can edit it afterwards." })]));
    view.appendChild(IELT.leaseBar(d, { frozenText: v1Note(d) }));
    view.appendChild(card("", [el("h3", { text: "Materials" }), IELT.materialsEditor(d, d.content, paint)]));
    view.appendChild(card("", [el("p", { text: "When the material is ready, go back to the Task Designer to check in and submit V1." }),
      el("button", { class: "btn", type: "button", text: "Back to the Task Designer", onclick: function () { IELT.go("designer"); } })]));
  }) };

  /* ---------- Peer Feedback ---------- */
  var review = { loaded: false, data: null, error: "" };
  function loadReview(paint) {
    if (review.loading) return null;
    review.loading = true;
    return api("apiGetReviewTarget", undefined, {}).then(function (res) { review.loading = false; review.loaded = true; review.data = res; review.error = ""; paint(); },
      function (e) { review.loading = false; review.loaded = true; review.error = e.message; paint(); });
  }
  function feedbackReadout(fb, title) {
    var s = schema(), box = card("", [el("h3", { text: title })]);
    var dl = el("dl", { class: "readout" });
    s.feedbackCriteria.forEach(function (c) { dl.appendChild(el("dt", { text: c.item + ". " + c.label })); dl.appendChild(el("dd", { text: s.ratingLevels[fb.ratings[c.id]] || "Not rated" })); });
    s.feedbackComments.forEach(function (c) { dl.appendChild(el("dt", { text: c.item + ". " + c.label })); dl.appendChild(el("dd", { text: fb[c.id] })); });
    box.appendChild(dl);
    return box;
  }
  IELT.feedbackReadout = feedbackReadout;
  function generic(text) {
    var t = " " + String(text || "").toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ") + " ", pats = schema().genericPatterns;
    for (var i = 0; i < pats.length; i++) if (t.indexOf(" " + pats[i] + " ") >= 0) return true;
    return false;
  }
  M.feedback = { render: function (root) {
    review.loaded = false;
    groupModule("feedback", function (view, d, paint) {
      var s = schema(), g = boot().group, lim = s.feedbackLimits, msg = el("div", {}), editable = d.editable();
      var intro = s.feedbackIntro;
      view.appendChild(card("instructions", [el("p", { class: "eyebrow", text: "Stage S6, about 6 minutes. You review Group " + g.reviewsNo + "." }),
        el("h3", { text: intro.heading }), el("p", { text: intro.text }),
        el("ul", {}, intro.plan.map(function (row) { return el("li", {}, [el("strong", { text: row[0] + ": " }), row[1]]); })),
        el("p", { text: intro.roles }), el("p", { class: "muted", text: intro.useful }),
        el("ol", { class: "small muted" }, intro.rules.map(function (r) { return el("li", { text: r }); })), el("p", { class: "small muted", text: intro.finish })]));
      if (!review.loaded) { view.appendChild(el("p", { class: "card", role: "status", text: "Loading the design you review…" })); loadReview(paint); return; }
      if (review.error) { view.appendChild(card("warning", [el("p", { text: review.error })])); return; }
      var r = review.data;
      if (r.submitted) {
        view.appendChild(card("success", [el("p", {}, [el("strong", { text: "Your group's feedback was submitted at " + r.submitted.submittedAt + ". " }), "Thank you."])]));
        view.appendChild(feedbackReadout(r.submitted, "Feedback your group gave to Group " + r.targetGroupNo));
        view.appendChild(IELT.checkinCard("feedback"));
        return;
      }
      if (!r.target) {
        view.appendChild(card("notice", [el("p", { role: "status", text: "Group " + r.targetGroupNo + " has not submitted its V1 yet. This page updates by itself when it arrives." })]));
        view.appendChild(IELT.checkinCard("feedback"));
        return;
      }
      view.appendChild(card("", [el("h3", { text: "The design you review: Group " + r.targetGroupNo + ", V1" }), IELT.designReadout(r.target.design, r.target.materials)]));
      view.appendChild(IELT.leaseBar(d, {}));
      var form = card("", [el("h3", { text: "Step 1. Rate six criteria" }),
        el("ul", { class: "small muted" }, s.ratingLevels.map(function (l, i) { return el("li", {}, [el("strong", { text: l + ": " }), s.ratingMeanings[i]]); }))]);
      s.feedbackCriteria.forEach(function (c) {
        var rg = IELT.radioGroup({ label: c.item + ". " + c.label, help: c.ask, value: d.content.ratings[c.id] === "" ? "" : String(d.content.ratings[c.id]), disabled: !editable,
          options: s.ratingLevels.map(function (l, i) { return { value: String(i), label: l }; }), onchange: function (v) { d.content.ratings[c.id] = Number(v); d.touch(); d.blurSave(); } });
        rg.node.setAttribute("data-item", c.item);
        form.appendChild(rg.node);
      });
      form.appendChild(el("h3", { text: "Step 2. Write three comments" }));
      form.appendChild(el("p", { class: "muted", text: "Each comment needs at least " + lim.minWords + " words. Use a sentence starter if it helps." }));
      s.feedbackComments.forEach(function (c) {
        var warn = el("p", { class: "small", style: "color:#9A2F1B", role: "status" });
        var check = function (v) { warn.textContent = generic(v) ? s.genericWarning : ""; };
        var tf = IELT.textField({ label: c.item + ". " + c.label, rows: 3, max: lim.maxChars, minWords: lim.minWords, value: d.content[c.id], disabled: !editable, help: "Sentence starters: " + c.starters.join("  /  "),
          oninput: function (v) { d.content[c.id] = v; d.touch(); check(v); }, onblur: function () { d.blurSave(); } });
        tf.node.setAttribute("data-item", c.item);
        check(d.content[c.id]);
        form.appendChild(tf.node); form.appendChild(warn);
      });
      view.appendChild(form);
      view.appendChild(IELT.checkinCard("feedback"));
      var submit = el("button", { class: "btn go", type: "button", text: "Submit feedback" });
      submit.addEventListener("click", function () {
        IELT.run(submit, msg, function () {
          var miss = s.feedbackCriteria.filter(function (c) { return d.content.ratings[c.id] === ""; });
          if (miss.length) throw new Error("Rate every criterion. Missing: " + miss.map(function (c) { return c.label; }).join(", ") + ".");
          var short = s.feedbackComments.filter(function (c) { return IELT.words(d.content[c.id]) < lim.minWords; });
          if (short.length) throw new Error("Each comment needs at least " + lim.minWords + " words. Too short: " + short.map(function (c) { return c.label; }).join(", ") + ".");
          if (!window.confirm("Submit your group's feedback to Group " + r.targetGroupNo + "? It cannot be changed afterwards.")) return null;
          return (d.dirty ? d.save() : Promise.resolve()).then(function () { return api("apiSubmitFeedback", { baseVersion: d.version }, { write: true, save: true }); }).then(function (res) {
            IELT.setProgress(res.progress); IELT.announce("Feedback is submitted.");
            review.loaded = false; return d.load().then(function () { IELT.renderNext(); });
          }, function (e) { if (e.data && e.data.version !== undefined) d.saveFailed(e); else if (e.code === "ALREADY_SUBMITTED") { review.loaded = false; d.load(); } throw e; });
        });
      });
      view.appendChild(card("", [el("p", { class: "muted", text: "One submission per group. Any member can submit once the feedback is saved." }), submit, msg]));
    }, { onPoll: function (res, paint) { if (review.loaded && review.data && !review.data.submitted && (!review.data.target || (res.progress && res.progress.group && res.progress.group.feedbackGiven))) loadReview(paint); } })(root);
  } };

  /* ---------- Revision Studio and Final Submission (one shared revision draft) ---------- */
  var rev = { loaded: false, data: null, error: "" };
  function loadRevision(paint) {
    if (rev.loading) return null;
    rev.loading = true;
    return api("apiGetRevisionContext", undefined, {}).then(function (res) { rev.loading = false; rev.loaded = true; rev.data = res; rev.error = ""; paint(); },
      function (e) { rev.loading = false; rev.loaded = true; rev.error = e.message; paint(); });
  }
  function decisionsComplete(c, hasFeedback) {
    if (!hasFeedback) return IELT.words(c.otherChanges) >= 5;
    return ["limitation", "recommendation"].every(function (k) { return c.decisions[k].decision && IELT.words(c.decisions[k].rationale) >= 3; });
  }
  M.revision = { render: function (root) {
    rev.loaded = false;
    groupModule("revision", function (view, d, paint) {
      var s = schema(), g = boot().group, msg = el("div", {}), editable = d.editable();
      view.appendChild(card("instructions", [el("p", { class: "eyebrow", text: "Stage S7, about 5 minutes" }),
        el("p", { text: "Read the feedback from Group " + g.reviewedByNo + ". For the limitation and for the recommendation, decide: adopt fully, adopt partly or do not adopt, and give a one-sentence reason. Not adopting a suggestion is fine if you can justify it. Then edit your design. V1 stays as it was; you are now writing V2." })]));
      if (!rev.loaded) { view.appendChild(el("p", { class: "card", role: "status", text: "Loading the feedback for your group…" })); loadRevision(paint); return; }
      if (rev.error) { view.appendChild(card("warning", [el("p", { text: rev.error })])); return; }
      var r = rev.data;
      if (!r.v1) { view.appendChild(card("warning", [el("p", { text: "Your group has not submitted V1 yet. Submit V1 in the Task Designer first; the Revision Studio starts from V1." }), el("button", { class: "btn", type: "button", text: "Open the Task Designer", onclick: function () { IELT.go("designer"); } })])); return; }
      if (r.v2) {
        view.appendChild(card("success", [el("p", {}, [el("strong", { text: "The final version (V2) was submitted at " + r.v2.submittedAt + ". " })])]));
        if (r.feedback) view.appendChild(feedbackReadout(r.feedback, "Feedback from Group " + r.reviewedByNo));
        view.appendChild(card("", [el("h3", { text: "Final version (V2)" }), IELT.designReadout(r.v2.design, r.v2.materials)]));
        view.appendChild(IELT.checkinCard("revision"));
        return;
      }
      if (r.feedback) view.appendChild(feedbackReadout(r.feedback, "Feedback from Group " + r.reviewedByNo));
      else view.appendChild(card("notice", [el("p", { role: "status", text: "No feedback from Group " + r.reviewedByNo + " has arrived yet. This page updates by itself. If none arrives, describe under \"Other changes\" what you changed and why, and continue." })]));
      view.appendChild(IELT.leaseBar(d, { saveLabel: "Save revision", onSave: function () {
        if (!decisionsComplete(d.content, !!r.feedback)) return Promise.reject(new Error(r.feedback ? "Choose a decision and write a one-sentence rationale for the limitation and for the recommendation." : "Describe under \"Other changes\" what you changed and why (at least one sentence)."));
        return api("apiSaveRevision", { baseVersion: d.version, content: IELT.clone(d.content) }, { write: true, save: true }).then(function (res) {
          d.version = res.version; d.dirty = false; d.lease.expiresAt = res.leaseExpiresAt; d.updatedAt = res.savedAt; IELT.store.del("draft:revision");
          IELT.setProgress(res.progress); IELT.renderNext(); d.emit("saved");
        }, function (e) { d.saveFailed(e); throw e; });
      } }));
      var dec = card("", [el("h3", { text: "Your decisions" })]);
      if (r.feedback) ["limitation", "recommendation"].forEach(function (k) {
        var item = d.content.decisions[k];
        dec.appendChild(el("p", {}, [el("strong", { text: (k === "limitation" ? "The limitation: " : "The recommendation: ") }), r.feedback[k]]));
        dec.appendChild(IELT.selectField({ label: "Decision on the " + k, value: item.decision, disabled: !editable, options: s.decisionOptions.map(function (o, i) { return { value: o, label: s.decisionLabels[i] }; }),
          onchange: function (v) { item.decision = v; d.touch(); d.blurSave(); } }).node);
        dec.appendChild(IELT.textField({ label: "Why? (one sentence)", rows: 2, max: s.revisionLimits.rationale, value: item.rationale, disabled: !editable, help: "Sentence starters: " + s.rationaleStarters.join("  /  "),
          oninput: function (v) { item.rationale = v; d.touch(); }, onblur: function () { d.blurSave(); } }).node);
      });
      dec.appendChild(IELT.textField({ label: r.feedback ? "Other changes not prompted by the feedback (optional)" : "Other changes: what did you change, and why?", rows: 2, max: s.revisionLimits.otherChanges, value: d.content.otherChanges, disabled: !editable,
        oninput: function (v) { d.content.otherChanges = v; d.touch(); }, onblur: function () { d.blurSave(); } }).node);
      if (r.decisions) dec.appendChild(el("p", { class: "small muted", text: "Decisions were last recorded at " + r.decisions.savedAt + ". Press \"Save revision\" to record them again after a change." }));
      view.appendChild(dec);
      view.appendChild(el("h3", { text: "Your design, version 2 (started from V1)" }));
      view.appendChild(IELT.designFields(d, d.content.design));
      view.appendChild(card("", [el("h3", { text: "Materials" }), IELT.materialsEditor(d, d.content, paint)]));
      view.appendChild(IELT.checkinCard("revision"));
      view.appendChild(card("", [el("p", { text: "When the decisions are saved and the design is ready, go to Final Submission." }),
        el("button", { class: "btn", type: "button", text: "Go to Final Submission", onclick: function () { IELT.go("final"); } }), msg]));
    }, { onPoll: function (res, paint) { var gp = res.progress && res.progress.group; if (rev.loaded && rev.data && gp && ((!rev.data.feedback && gp.feedbackReceived) || (!rev.data.v2 && gp.v2) || (!rev.data.v1 && gp.v1))) loadRevision(paint); } })(root);
  } };

  M.final = { render: function (root) {
    rev.loaded = false;
    groupModule("revision", function (view, d, paint) {
      var msg = el("div", {});
      view.appendChild(card("instructions", [el("p", { class: "eyebrow", text: "Stage S7, last minute" }),
        el("p", { text: "Submitting freezes your final version (V2). V1, the feedback you received and your decisions stay on record next to it, so the path from V1 to V2 remains visible." })]));
      if (!rev.loaded) { view.appendChild(el("p", { class: "card", role: "status", text: "Loading…" })); loadRevision(paint); return; }
      if (rev.error) { view.appendChild(card("warning", [el("p", { text: rev.error })])); return; }
      var r = rev.data;
      if (r.v2) { view.appendChild(card("success", [el("p", {}, [el("strong", { text: "Final version (V2) submitted at " + r.v2.submittedAt + ". " }), "Well done."])])); view.appendChild(card("", [IELT.designReadout(r.v2.design, r.v2.materials)])); return; }
      if (!r.v1) { view.appendChild(card("warning", [el("p", { text: "Your group has not submitted V1 yet." })])); return; }
      var okDec = decisionsComplete(d.content, !!r.feedback), okMat = (d.content.materials || []).some(function (m) { return m.body; }), okSaved = d.version > 0 && !d.dirty;
      var item = function (ok, text) { return el("li", { class: ok ? "ok" : "" }, [el("span", { class: "tick", "aria-hidden": "true", text: ok ? "✓" : "" }), el("span", {}, [el("span", { class: "sr-only", text: ok ? "Done: " : "Missing: " }), text])]); };
      view.appendChild(card("", [el("h3", { text: "Before you submit" }), el("ul", { class: "steps" }, [
        item(true, "V1 was submitted at " + r.v1.submittedAt + "."),
        item(okDec, r.feedback ? "Decisions and reasons for the limitation and the recommendation." : "A note on what you changed and why (no feedback arrived)."),
        item(okMat, "At least one student-facing material."),
        item(okSaved, "The revision is saved (Revision Studio, \"Save revision\").")]),
        el("button", { class: "btn", type: "button", text: "Open the Revision Studio", onclick: function () { IELT.go("revision"); } })]));
      view.appendChild(card("", [el("h3", { text: "The version that will be submitted" }), IELT.designReadout(d.content.design, d.content.materials)]));
      view.appendChild(IELT.leaseBar(d, { saveLabel: "Save draft" }));
      var submit = el("button", { class: "btn go", type: "button", text: "Submit final version (V2)" });
      submit.addEventListener("click", function () {
        IELT.run(submit, msg, function () {
          if (!okDec) throw new Error("Complete your decisions in the Revision Studio first.");
          if (!okMat) throw new Error("The design needs at least one material.");
          if (d.version === 0) throw new Error("Save the revision in the Revision Studio first.");
          if (!window.confirm("Submit the final version (V2)? It cannot be changed afterwards.")) return null;
          return (d.dirty && d.lease.mine ? d.save() : Promise.resolve()).then(function () { return api("apiSubmitV2", { baseVersion: d.version }, { write: true, save: true }); }).then(function (res) {
            IELT.setProgress(res.progress); IELT.announce("The final version is submitted.");
            rev.loaded = false; return d.load().then(function () { IELT.renderNext(); });
          }, function (e) { if (e.data && e.data.version !== undefined) d.saveFailed(e); else if (e.code === "ALREADY_SUBMITTED") { rev.loaded = false; d.load(); } throw e; });
        });
      });
      view.appendChild(card("", [submit, msg]));
    }, { onPoll: function (res, paint) { var gp = res.progress && res.progress.group; if (rev.loaded && rev.data && gp && ((!rev.data.v2 && gp.v2) || (!rev.data.feedback && gp.feedbackReceived))) loadRevision(paint); } })(root);
  } };

  /* ---------- Exit Ticket (items ET1 and ET2 of 03_INSTRUMENTS/Reflection_Prompts.md, served by the server) ---------- */
  M.exit = { render: function (root) {
    var b = boot(), rec = b.mine.exit, form = schema().exitForm, saved = IELT.backup("exit"), d = saved.load(), ctl = {};
    var keep = function () { var o = {}; form.items.forEach(function (it) { o[it.field] = ctl[it.field].get(); }); saved.save(o); };
    root.appendChild(card("instructions", [el("p", { class: "eyebrow", text: "Stage S8, last minute of the workshop" }), el("p", { text: "One selection and one sentence. This is your last step." })]));
    var msg = el("div", {}), state = el("p", { role: "status" }), box = card("", [state]);
    form.items.forEach(function (it) {
      var value = d[it.field] || (rec ? rec[it.field] : "");
      ctl[it.field] = it.options ? IELT.selectField({ label: it.prompt, value: value, options: it.options, onchange: keep }) : IELT.textField({ label: it.prompt, rows: 2, max: it.max, value: value, oninput: keep });
      ctl[it.field].node.setAttribute("data-item", it.item);
      box.appendChild(ctl[it.field].node);
    });
    function showState() { clear(state); if (rec) state.appendChild(stamp(rec, "Submitted at " + rec.at)); else state.textContent = "Not submitted yet."; }
    showState();
    var btn = el("button", { class: "btn go", type: "button", text: "Submit exit ticket" });
    btn.addEventListener("click", function () {
      IELT.run(btn, msg, function () {
        var payload = {};
        form.items.forEach(function (it) { payload[it.field] = ctl[it.field].get(); });
        if (form.items.some(function (it) { return !String(payload[it.field]).replace(/\s/g, ""); })) throw new Error("Choose a PIVOT step and complete the sentence.");
        return api("apiSubmitExitTicket", payload, { write: true, save: true }).then(function (res) {
          rec = res.record; b.mine.exit = rec; saved.clear(); showState(); IELT.setProgress(res.progress); IELT.renderNext();
          msg.appendChild(IELT.message("ok", "Thank you. Your exit ticket is recorded."));
        });
      });
    });
    IELT.add(box, [btn, msg]);
    root.appendChild(box);
  } };
})();

/* ===== JsResearch.html ===== */
/*
 * JsResearch: the Individual Tasks module. The information sheet with the choice about research use,
 * background questions, the individual design task before the workshop (T0) and after it (T2), the
 * scale (shown only if the administrator has entered its six items) and two reflection prompts after
 * the workshop. The tasks are part of the workshop for every participant (decision D-33); the choice
 * decides only whether the answers may be used in the research. Nothing in this module is needed for
 * any other step or for the certificate.
 */
(function () {
  "use strict";
  var IELT = window.IELT, el = IELT.el, clear = IELT.clear, api = IELT.api;
  function card(cls, children) { return el("div", { class: "card " + (cls || "") }, children); }
  function span(ms) {
    if (!(ms > 0)) return "now";
    var m = Math.round(ms / 60000), h = Math.floor(m / 60);
    return h >= 1 ? h + " h " + (m % 60) + " min" : m + " min";
  }
  var timerNode = null, timerStart = 0, closeNode = null, closeAt = 0, warnMinutes = 10;

  function render(root) {
    var view = el("div", {});
    root.appendChild(view);
    function load() {
      clear(view); view.appendChild(el("p", { class: "card", role: "status", text: "Loading…" }));
      api("apiResearchState", undefined, {}).then(paint, function (e) { clear(view); view.appendChild(IELT.message("error", e.message)); });
    }
    function paint(st) {
      clear(view); timerNode = null; closeNode = null; closeAt = 0;
      IELT.state.boot.research = { enabled: st.enabled, status: st.status };
      view.appendChild(card("instructions", [
        el("p", {}, [el("strong", { text: "The individual tasks are part of the workshop for every participant." }), " A few background questions and one design task before the workshop, one design task and two reflection questions after it."]),
        el("p", { text: "Whether your answers may also be used in the research is your decision. It changes nothing in your workshop, and your certificate does not depend on these tasks." })]));
      if (!st.enabled) { view.appendChild(card("notice", [el("p", { text: "The individual tasks are not open at the moment." })])); return; }
      if (st.status === "none") { consentView(st); return; }
      participantView(st);
    }
    function decide(decision, button, box, confirmText) {
      if (confirmText && !window.confirm(confirmText)) return;
      IELT.run(button, box, function () { return api("apiConsentDecision", { decision: decision }, { write: true }).then(paint); });
    }
    function consentView(st) {
      var msg = el("div", {});
      var text = el("div", { class: "card", tabindex: "0", role: "region", "aria-label": "Information sheet", style: "white-space:pre-wrap;max-height:26rem;overflow:auto" }, [st.consentText]);
      var yes = el("button", { class: "btn go", type: "button", text: "My answers may be used in the research" });
      var no = el("button", { class: "btn", type: "button", text: "Do not use my answers in the research" });
      yes.addEventListener("click", function () { decide("agree", yes, msg); });
      no.addEventListener("click", function () { decide("decline", no, msg); });
      IELT.add(view, [el("h3", { text: "Information sheet (version " + st.consentVersion + ")" }), text,
        card("", [el("p", { text: "Please read the information sheet. Then choose. You do the tasks in both cases; your choice decides only whether your answers are used in the research." }), el("div", { class: "row" }, [yes, no]), msg])]);
    }
    function participantView(st) {
      var w = st.windows, now = IELT.serverNow(), t0 = st.occasions.T0, t2 = st.occasions.T2;
      var item = function (ok, text) { return el("li", { class: ok ? "ok" : "" }, [el("span", { class: "tick", "aria-hidden": "true", text: ok ? "✓" : "" }), el("span", {}, [el("span", { class: "sr-only", text: ok ? "Done: " : "Open: " }), text])]); };
      var list = el("ul", { class: "steps" }, [item(st.backgroundDone, "Background questions"), item(t0.taskDone, "Design task before the workshop"),
        st.scale.enabled ? item(t0.scaleDone, "Short questionnaire before the workshop") : null, item(t2.taskDone, "Design task after the workshop"),
        st.scale.enabled ? item(t2.scaleDone, "Short questionnaire after the workshop") : null, item(st.reflectionDone, "Two optional reflection questions after the workshop")]);
      view.appendChild(card(st.dataUse ? "success" : "notice", [el("p", {}, [el("strong", { text: st.dataUse ? "Your answers may be used in the research. Thank you." : "Your answers will not be used in the research." }),
        st.dataUse ? "" : " The tasks below are still part of your workshop."]), el("h3", { text: "Your individual tasks" }), list]));
      var active = false;
      /* background */
      if (!st.backgroundDone) { view.appendChild(backgroundForm(st)); active = true; }
      /* T0 */
      /* T0 closes when the workshop starts; a task that was begun but not submitted by then is not accepted. */
      if (!active && !t0.taskDone && w.T0.open) { view.appendChild(taskSection(st, "T0")); active = true; }
      if (!active && t0.taskDone && st.scale.enabled && !t0.scaleDone && w.T0.open) { view.appendChild(scaleForm(st, "T0")); active = true; }
      /* T2 */
      var t2Open = w.T2.open || (t2.started && !t2.taskDone);
      if (!active && !t2.taskDone && t2Open) { view.appendChild(taskSection(st, "T2")); active = true; }
      if (!active && t2.taskDone && st.scale.enabled && !t2.scaleDone) { view.appendChild(scaleForm(st, "T2")); active = true; }
      if (!active && t2.taskDone && !st.reflectionDone) { view.appendChild(reflectionForm(st)); active = true; }
      if (!active) {
        var text = !t0.taskDone && w.T0.opensAt && now < w.T0.opensAt ? "The pre-workshop part opens in " + span(w.T0.opensAt - now) + " (72 hours before the workshop)."
          : t0.started && !t0.taskDone && !w.T2.opensAt ? "The pre-workshop part closed when the workshop started. The design task you began was not submitted, so it was not recorded. The next part opens when the workshop closes. You will find it here."
          : !t2.taskDone && !w.T2.opensAt ? "The next part opens when the workshop closes. You will find it here."
          : !t2.taskDone ? "The post-workshop part has closed." : "You have completed every individual task. Thank you.";
        view.appendChild(card("notice", [el("p", { role: "status", text: text })]));
      } else if (w.T0.open && !t0.taskDone) view.appendChild(el("p", { class: "small muted", text: "The pre-workshop part closes when the workshop starts, in " + span(w.T0.closesAt - now) + "." }));
      else if (w.T2.open && (!t2.taskDone || !st.reflectionDone)) view.appendChild(el("p", { class: "small muted", text: "The post-workshop part stays open for " + span(w.T2.closesAt - now) + ". Doing it now, in the same sitting, is best." }));
      /* changing the choice about research use */
      var msg = el("div", {});
      if (st.dataUse) {
        var out = el("button", { class: "btn danger", type: "button", text: "Withdraw from the research" });
        out.addEventListener("click", function () { decide("withdraw", out, msg, "Withdraw from the research? Your answers will be excluded from the research data. The tasks stay part of your workshop, and your certificate is not affected."); });
        view.appendChild(card("", [el("h3", { text: "Changing your mind" }), el("p", { class: "muted", text: "You can stop the use of your answers in the research at any time, without giving a reason." }), out, msg]));
      } else {
        var allow = el("button", { class: "btn", type: "button", text: "Allow the use of my answers in the research" });
        allow.addEventListener("click", function () { decide("agree", allow, msg); });
        view.appendChild(card("", [el("h3", { text: "Changing your mind" }), el("p", { class: "muted", text: st.status === "withdraw" ? "You have withdrawn: your answers are excluded from the research data. You can allow their use again at any time." : "You can allow the use of your answers at any time while the study is open." }), allow, msg]));
      }
    }
    /* Background questions B1 to B7, exactly as served by the server (03_INSTRUMENTS/Background_Questions.md). Every question may be left empty. */
    function backgroundForm(st) {
      var msg = el("div", {}), fields = {}, box = card("", [el("h3", { text: "Background questions" }), el("p", { text: st.backgroundIntro })]);
      st.backgroundQuestions.forEach(function (q) {
        var opts = q.options.map(function (o) { return typeof o === "string" ? { value: o, label: o } : o; });
        if (q.multiple) {
          var boxes = [], name = IELT.uid("chk");
          var fs = el("fieldset", { "data-item": q.item }, [el("legend", { text: q.label }), el("div", { class: "help small muted", text: "Select all that apply." }), el("div", {}, opts.map(function (o) {
            var id = IELT.uid("c"), inp = el("input", { type: "checkbox", id: id, name: name, value: o.value });
            boxes.push(inp);
            return el("div", {}, [el("label", { for: id, style: "font-weight:400;display:inline-flex;align-items:center;min-height:36px" }, [inp, o.label])]);
          }))]);
          fields[q.id] = { node: fs, get: function () { return boxes.filter(function (b) { return b.checked; }).map(function (b) { return b.value; }); } };
        } else {
          fields[q.id] = IELT.selectField({ label: q.label, options: opts, placeholder: "No answer" });
          fields[q.id].node.setAttribute("data-item", q.item);
        }
        box.appendChild(fields[q.id].node);
      });
      var btn = el("button", { class: "btn go", type: "button", text: "Save my answers" });
      btn.addEventListener("click", function () {
        IELT.run(btn, msg, function () {
          var answers = {};
          st.backgroundQuestions.forEach(function (q) { var v = fields[q.id].get(); if (q.multiple ? v.length : v !== "") answers[q.id] = v; });
          return api("apiSubmitBackground", { answers: answers }, { write: true, save: true }).then(paint);
        });
      });
      IELT.add(box, [btn, msg]);
      return box;
    }
    /* The individual design task. Every sentence comes from the AssessmentForms sheet (03_INSTRUMENTS/Individual_Design_Tasks.md). */
    function taskSection(st, occ) {
      var o = st.occasions[occ], msg = el("div", {}), box = el("div", {});
      /* T0 only: the part closes when the workshop starts. The warning is visible from ten minutes before that. */
      closeAt = occ === "T0" ? st.windows.T0.closesAt : 0;
      warnMinutes = st.t0WarningMinutes || 10;
      closeNode = null;
      if (closeAt) {
        /* Two parts: the message changes only when the state changes (and is announced then); the running time is not announced. */
        closeNode = el("div", { class: "msg info", "data-t0-deadline": "1" }, [el("span", { role: "status", "data-part": "message" }), " ", el("span", { "aria-hidden": "true", "data-part": "time" })]);
        box.appendChild(closeNode);
        paintDeadline();
      }
      if (!o.task) {
        var start = el("button", { class: "btn primary", type: "button", text: "Start the design task" });
        start.addEventListener("click", function () { IELT.run(start, msg, function () { return api("apiStartTask", { occasion: occ }, { write: true }).then(function () { load(); }); }); });
        box.appendChild(card("", [el("h3", { text: "Individual design task" }),
          el("p", { text: "You will design one short classroom task on your own. Suggested time: " + st.softMinutes + " minutes. A timer is shown; the timer has no cut-off. Start when you can work without interruption."
            + (occ === "T0" ? " The response must be submitted before the workshop starts." : "") }), start, msg]));
        return box;
      }
      var t = o.task, saved = IELT.backup("task:" + occ), d = saved.load(), inputs = {};
      var keep = function () { var a = { f2_choice: choice.get() }; t.fields.forEach(function (f) { a[f.id] = inputs[f.id].get(); }); saved.save(a); };
      timerStart = o.startedAtMs || IELT.serverNow();
      timerNode = el("p", { class: "timer", role: "timer", "aria-live": "off" });
      box.appendChild(card("notice", [el("h3", { text: t.heading }), el("h4", { text: "Before you start" }), el("p", { text: t.beforeYouStart }), timerNode]));
      box.appendChild(card("", [el("h4", { text: "Your class" }), el("p", { text: t.yourClass }),
        el("h4", { text: "What you can use" }), el("ol", {}, t.use.map(function (x) { return el("li", { text: x }); })), el("p", { text: t.useNote }),
        el("h4", { text: "This lesson" }), el("p", { text: t.topic }), el("p", { text: t.target }), el("p", { text: t.scenes }), el("p", { text: t.arCards })]));
      var form = card("", [el("h4", { text: "Your task" }), el("p", { text: t.taskIntro })]);
      var choice = null;
      t.fields.forEach(function (f) {
        if (f.choice) {
          choice = IELT.radioGroup({ label: f.no + ". " + f.label, value: d.f2_choice || "", options: t.choices, onchange: keep });
          form.appendChild(choice.node);
          inputs[f.id] = IELT.textField({ label: "Field 2, your sentence: exactly what learners will use", rows: 2, max: 800, value: d[f.id] || "", oninput: keep });
        } else inputs[f.id] = IELT.textField({ label: f.no + ". " + f.label, rows: f.maxWords > 100 ? 6 : 3, maxWords: f.maxWords, value: d[f.id] || "", oninput: keep });
        inputs[f.id].node.setAttribute("data-field", f.id);
        form.appendChild(inputs[f.id].node);
      });
      var btn = el("button", { class: "btn go", type: "button", text: "Submit my response" });
      btn.addEventListener("click", function () {
        IELT.run(btn, msg, function () {
          if (!choice.get()) throw new Error("Choose one option in field 2: 360° scenes, AR cards, both or neither.");
          var over = t.fields.filter(function (f) { return f.maxWords && IELT.words(inputs[f.id].get()) > f.maxWords; });
          var empty = t.fields.filter(function (f) { return !inputs[f.id].get(); });
          var warn = (over.length ? " Field " + over.map(function (f) { return f.no; }).join(", ") + " is over its word limit; it will be stored as you wrote it." : "")
            + (empty.length ? " Field " + empty.map(function (f) { return f.no; }).join(", ") + " is empty." : "");
          if (!window.confirm("Submit your response?" + warn + " You cannot change it afterwards.")) return null;
          var answers = { f2_choice: choice.get() };
          t.fields.forEach(function (f) { answers[f.id] = inputs[f.id].get(); });
          return api("apiSubmitTask", { occasion: occ, answers: answers }, { write: true, save: true }).then(function (res) { saved.clear(); paint(res.state); });
        });
      });
      IELT.add(form, [btn, msg]);
      box.appendChild(form);
      return box;
    }
    function scaleForm(st, occ) {
      var msg = el("div", {}), groups = [], box = card("", [el("h3", { text: "Short questionnaire" }), el("p", { text: st.scale.instruction })]);
      st.scale.items.forEach(function (text, i) {
        var g = IELT.radioGroup({ label: (i + 1) + ". " + text, options: st.scale.anchors.map(function (a, k) { return { value: String(k + 1), label: /^\d+$/.test(a) ? a : (k + 1) + " " + a }; }) });
        groups.push(g); box.appendChild(g.node);
      });
      var btn = el("button", { class: "btn go", type: "button", text: "Submit my response" });
      btn.addEventListener("click", function () {
        IELT.run(btn, msg, function () {
          var r = groups.map(function (g) { return Number(g.get()); });
          if (r.some(function (v) { return !(v >= 1 && v <= 5); })) throw new Error("Please answer all six statements.");
          return api("apiSubmitScale", { occasion: occ, responses: r }, { write: true, save: true }).then(paint);
        });
      });
      IELT.add(box, [btn, msg]);
      return box;
    }
    /* Two optional reflection prompts R1 and R2 (03_INSTRUMENTS/Reflection_Prompts.md). They can be skipped. */
    function reflectionForm(st) {
      var msg = el("div", {}), saved = IELT.backup("reflection"), d = saved.load(), inputs = {};
      var keep = function () { var a = {}; st.reflectionPrompts.forEach(function (q) { a[q.id] = inputs[q.id].get(); }); saved.save(a); };
      var box = card("", [el("h3", { text: "Two reflection questions" }), el("p", { text: st.reflectionIntro })]);
      st.reflectionPrompts.forEach(function (q) {
        inputs[q.id] = IELT.textField({ label: q.label + " (up to " + q.maxWords + " words)", rows: 5, maxWords: q.maxWords, value: d[q.id] || "", oninput: keep });
        inputs[q.id].node.setAttribute("data-item", q.item);
        box.appendChild(inputs[q.id].node);
      });
      var send = function (button, blank) {
        IELT.run(button, msg, function () {
          var a = {}; st.reflectionPrompts.forEach(function (q) { a[q.id] = blank ? "" : inputs[q.id].get(); });
          return api("apiSubmitReflection", { answers: a }, { write: true, save: true }).then(function (res) { saved.clear(); paint(res); });
        });
      };
      var btn = el("button", { class: "btn go", type: "button", text: "Submit my response" });
      var skip = el("button", { class: "btn quiet", type: "button", text: "Skip these questions" });
      btn.addEventListener("click", function () { send(btn, false); });
      skip.addEventListener("click", function () { if (window.confirm("Skip the two optional questions?")) send(skip, true); });
      IELT.add(box, [el("div", { class: "row" }, [btn, skip]), msg]);
      return box;
    }
    /* T0 deadline line: plain information first, a warning when fewer than ten minutes remain, a clear statement after the close. */
    function paintDeadline() {
      if (!closeNode || !closeAt) return;
      var left = closeAt - IELT.serverNow(), state = left <= 0 ? "closed" : left < warnMinutes * 60000 ? "warn" : "info";
      var message = closeNode.firstChild, time = closeNode.lastChild;
      if (closeNode.getAttribute("data-state") !== state) {
        closeNode.setAttribute("data-state", state);
        closeNode.className = "msg " + (state === "info" ? "info" : "error");
        message.setAttribute("role", state === "info" ? "status" : "alert");
        message.textContent = state === "closed" ? "The workshop has started, so the pre-workshop part is closed. This response can no longer be submitted."
          : state === "warn" ? "Fewer than " + warnMinutes + " minutes remain. The pre-workshop part closes when the workshop starts. Submit your response before then: it cannot be submitted afterwards."
          : "The pre-workshop part closes when the workshop starts. A response cannot be submitted after that.";
      }
      var t = state === "closed" ? "" : "Time left: " + (state === "warn" ? IELT.countdown(left) : span(left)) + ".";
      if (time.textContent !== t) time.textContent = t;
    }
    load();
    IELT.current = {
      onTick: function () {
        paintDeadline();
        if (!timerNode) return;
        var used = Math.max(0, IELT.serverNow() - timerStart);
        timerNode.textContent = "Time used: " + IELT.countdown(used) + ". Suggested: 8 minutes. The timer has no cut-off; take the time you need.";
      },
      onPoll: function (res) { if (res.stage.id === "S9" && !timerNode && !view.querySelector("textarea, select, input")) load(); }
    };
  }
  IELT.modules.research = { render: render };
})();

/* ===== JsCertificate.html ===== */
/*
 * JsCertificate: the Certificate Center.
 * The server decides eligibility (nine educational steps, never the individual tasks or the research choice). Only if the participant is
 * eligible and a template is active does it send the template, the verified registered name and the
 * placement settings. The PDF is then made in this browser by the shared engine (JsCertEngine) with
 * pdf-lib and fontkit from the project's static site, downloaded, and its SHA-256 is reported back.
 * Only the name is drawn on the template.
 */
(function () {
  "use strict";
  var IELT = window.IELT, el = IELT.el, clear = IELT.clear, api = IELT.api;
  var kept = null;   /* the PDF made in this session, so it can be downloaded again without a new release */

  function b64ToBytes(b64) {
    var bin = atob(b64), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesToB64(bytes) {
    var s = "", chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(s);
  }
  function sha256Hex(bytes) {
    return crypto.subtle.digest("SHA-256", bytes).then(function (buf) {
      var a = new Uint8Array(buf), s = "";
      for (var i = 0; i < a.length; i++) s += (a[i] < 16 ? "0" : "") + a[i].toString(16);
      return s;
    });
  }
  function fetchFont(file) {
    return fetch(IELT.staticUrl("assets/fonts/" + encodeURIComponent(file)), { credentials: "omit", cache: "force-cache" }).then(function (r) {
      if (!r.ok) throw new Error("The font for the certificate could not be loaded from the static site.");
      return r.arrayBuffer();
    }).then(function (buf) { return new Uint8Array(buf); }, function (e) { throw new Error(e && /font/.test(e.message) ? e.message : "The font for the certificate could not be loaded. Check your connection and try again."); });
  }
  function loadPdfTools() { return IELT.loadScript("pdflib").then(function () { return IELT.loadScript("fontkit"); }); }
  function download(bytes, fileName) {
    var url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    var a = el("a", { href: url, download: fileName, style: "display:none" });
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 4000);
  }
  function fileNameFor(name) { return "Certificate " + String(name).replace(/[\\\/:*?"<>|\u0000-\u001F]/g, " ").replace(/\s+/g, " ").slice(0, 80) + ".pdf"; }
  function reasonText(res) {
    if (res.reason === "NAME_TOO_LONG") return "Your name is too long for the automatic layout of the certificate. The administrator has been informed and will adjust the layout. Please try again later.";
    if (res.reason === "MISSING_GLYPH") return "The certificate font cannot show every character of your name" + (res.missing && res.missing.length ? " (" + res.missing.join(" ") + ")" : "") + ". The administrator has been informed. Please try again later.";
    return "The certificate could not be created (" + res.reason + "). The administrator has been informed.";
  }
  IELT.certTools = { b64ToBytes: b64ToBytes, bytesToB64: bytesToB64, sha256Hex: sha256Hex, fetchFont: fetchFont, loadPdfTools: loadPdfTools, download: download };

  /* Collects the template bytes of a release: the first chunks come with it, the rest is fetched. */
  function templateBytes(release) {
    var t = release.template, parts = t.chunks.slice();
    function more() {
      if (parts.length >= t.chunkCount) return Promise.resolve();
      return api("apiGetCertificateChunks", { issueId: release.issueId, from: parts.length }, {}).then(function (res) { parts = parts.concat(res.chunks); return more(); });
    }
    return more().then(function () {
      var bytes = b64ToBytes(parts.join(""));
      return sha256Hex(bytes).then(function (hex) {
        if ("sha256:" + hex !== t.sha256) throw new Error("The certificate template arrived incomplete. Please try again.");
        return bytes;
      });
    });
  }

  function render(root) {
    var view = el("div", {});
    root.appendChild(view);
    function load() {
      clear(view); view.appendChild(el("p", { class: "card", role: "status", text: "Checking your steps…" }));
      api("apiGetCertificatePackage", { check: true }, {}).then(paint, function (e) { clear(view); view.appendChild(IELT.message("error", e.message)); });
    }
    var last = null;
    function paint(st) {
      clear(view);
      last = st;
      view.appendChild(el("div", { class: "card instructions" }, [
        el("p", { text: "The certificate confirms that you completed the nine workshop steps below. The individual tasks before and after the workshop and your choice about the research are not among them and never affect the certificate." })]));
      view.appendChild(el("div", { class: "card" }, [el("h3", { text: "Your steps" }), el("ul", { class: "steps" }, st.steps.map(function (s) {
        return el("li", { class: s.done ? "ok" : "" }, [el("span", { class: "tick", "aria-hidden": "true", text: s.done ? "✓" : "" }),
          el("span", {}, [el("span", { class: "sr-only", text: s.done ? "Done: " : "Missing: " }), el("strong", { text: s.label }),
            s.exception ? " (recorded by the administrator as an exception)" : (s.done ? "" : ": missing " + s.missing.join(", "))])]);
      }))]));
      if (!st.eligible) {
        view.appendChild(el("div", { class: "card notice" }, [el("p", { role: "status" }, [el("strong", { text: "Not yet eligible. " }), "Complete the missing steps above. Earlier steps stay open, so you can still catch up."])]));
        return;
      }
      if (!st.available) {
        view.appendChild(el("div", { class: "card notice" }, [el("p", { role: "status" }, [el("strong", { text: "You are eligible. " }), "The certificate is not available yet: the administrator has not activated the certificate template. Please come back later."]),
          el("button", { class: "btn", type: "button", text: "Check again", onclick: load })]));
        return;
      }
      var msg = el("div", {}), status = el("p", { role: "status", "aria-live": "polite", class: "muted" });
      if (kept) {
        view.appendChild(el("div", { class: "card success" }, [el("p", {}, [el("strong", { text: "Your certificate has been created. " }), "If the download did not start, use the button."]),
          el("button", { class: "btn", type: "button", text: "Download my certificate again", onclick: function () { download(kept.bytes, kept.fileName); } })]));
      }
      if (!st.canRelease) {
        view.appendChild(el("div", { class: "card notice" }, [el("p", { role: "status", text: st.reason === "ALREADY_ISSUED"
          ? "Your certificate was issued at " + st.issuedAt + ". If you need it again, or your name needs to be corrected, ask the administrator: a reissue has to be authorised."
          : "The certificate could not be created on this device after several attempts. Please tell the administrator, who can allow another attempt." })]));
        return;
      }
      var ok = el("input", { type: "checkbox", id: "certNameOk" });
      var btn = el("button", { class: "btn primary", type: "button", text: "Download my certificate", disabled: true });
      ok.addEventListener("change", function () { btn.disabled = !ok.checked; });
      btn.addEventListener("click", function () { IELT.run(btn, msg, function () { return issue(st, status).then(function () { load(); }); }); });
      view.appendChild(el("div", { class: "card" }, [el("h3", { text: st.kind === "reissue" ? "Your certificate (reissue)" : "Your certificate" }),
        el("p", {}, ["The certificate will show this name: ", el("strong", { text: st.name })]),
        el("p", { class: "muted", text: "This is your registered name. If it is not correct, do not download yet: ask the administrator to correct it first." }),
        el("p", {}, [ok, el("label", { for: "certNameOk", text: "My name is spelled correctly." })]), btn, status, msg]));
    }
    function issue(st, status) {
      var release = null, fontBytes = null;
      status.textContent = "Preparing…";
      return loadPdfTools().then(function () { return fetchFont(st.font); }).then(function (f) {
        fontBytes = f;
        return api("apiGetCertificatePackage", {}, { write: true });
      }).then(function (pkg) {
        if (!pkg.release) throw new Error("The certificate is not available right now. Reload this page.");
        release = pkg.release;
        status.textContent = "Creating your certificate…";
        return templateBytes(release).then(function (tpl) {
          return window.CertEngine.renderCertificate({ PDFLib: window.PDFLib, fontkit: window.fontkit, templateBytes: tpl, fontBytes: fontBytes, name: pkg.name, config: release.config });
        }).then(function (res) {
          if (!res.ok) { var text = reasonText(res); var e = new Error(text); e.code = "CERT"; e.reason = res.reason; throw e; }
          var fileName = fileNameFor(res.name);
          download(res.bytes, fileName);
          kept = { bytes: res.bytes, fileName: fileName };
          return sha256Hex(res.bytes).then(function (hex) { return api("apiReportCertificateIssued", { issueId: release.issueId, sha256: hex }, { write: true }); });
        });
      }).then(function () { status.textContent = "Your certificate has been downloaded."; IELT.announce("Your certificate has been downloaded."); }, function (err) {
        status.textContent = "";
        if (release && !kept) api("apiReportCertificateFailure", { issueId: release.issueId, message: String(err && (err.reason || err.message) || "error").slice(0, 280) }, { write: true, attempts: 2 }).then(function () {}, function () {});
        if (!(err && err.code)) IELT.reportError("certificate", err);
        throw err;
      });
    }
    load();
    IELT.current = { onPoll: function (res) { if (last && !last.eligible && res.progress && res.progress.eligible) load(); } };
  }
  IELT.modules.certificate = { render: render };
})();

/* ===== JsAdmin.html ===== */
/*
 * JsAdmin: the dashboard for administrators and facilitators.
 * A facilitator gets the Live tab only (stage controls and live status). Everything else, including
 * every consent or research view, is for administrators. The server enforces this for each call; the
 * tabs here only reflect it.
 */
(function () {
  "use strict";
  var IELT = window.IELT, el = IELT.el, clear = IELT.clear, api = IELT.api;
  var root = null, tabBody = null, activeTab = "live", timer = null, liveRefresh = null;
  function card(cls, children) { return el("div", { class: "card " + (cls || "") }, children); }
  function isAdmin() { return IELT.state.boot.me.role === "admin"; }
  function yn(v) { return el("span", { class: v ? "yes" : "no", text: v ? "yes" : "no" }); }
  function table(caption, heads, rows) {
    return el("div", { class: "tablewrap" }, [el("table", {}, [el("caption", { text: caption }),
      el("thead", {}, [el("tr", {}, heads.map(function (h) { return el("th", { scope: "col", text: h }); }))]),
      el("tbody", {}, rows.length ? rows.map(function (r) { return el("tr", {}, r.map(function (c) { return el("td", {}, [c]); })); }) : [el("tr", {}, [el("td", { colspan: heads.length, class: "muted", text: "Nothing yet." })])])])]);
  }
  function csvCell(v) { v = String(v === undefined || v === null ? "" : v); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return "\"" + v.replace(/"/g, "\"\"") + "\""; }
  function downloadText(name, text, type) {
    var url = URL.createObjectURL(new Blob([text], { type: type || "text/plain;charset=utf-8" }));
    var a = el("a", { href: url, download: name, style: "display:none" });
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 3000);
  }

  IELT.renderAdminShell = function (app, signOut) {
    var boot = IELT.state.boot, tabs = [["live", "Live"]];
    if (isAdmin()) tabs = tabs.concat([["roster", "Roster and codes"], ["groups", "Groups"], ["research", "Research"], ["certificates", "Certificates"], ["settings", "Settings"], ["logs", "Logs"]]);
    clear(app);
    root = app;
    app.appendChild(el("header", { class: "topbar" }, [
      el("div", { class: "brand" }, [el("h1", { text: boot.app.name }), el("span", { class: "sub", text: (isAdmin() ? "Administrator" : "Facilitator") + " dashboard" })]),
      el("div", { class: "who" }, [el("span", {}, ["Signed in as ", el("strong", { text: boot.me.name })]), el("span", { class: "chip", text: boot.me.role }), el("button", { class: "btn onDark", type: "button", text: "Sign out", onclick: signOut })])]));
    var tabList = el("div", { class: "tabs", role: "tablist", "aria-label": "Dashboard sections" }, tabs.map(function (t) {
      return el("button", { type: "button", role: "tab", id: "tab-" + t[0], "aria-selected": t[0] === activeTab ? "true" : "false", "aria-controls": "tabpanel", text: t[1], onclick: function () { show(t[0]); } });
    }));
    tabBody = el("div", { id: "tabpanel", role: "tabpanel", tabindex: "-1" });
    app.appendChild(el("main", { id: "main", style: "max-width:1240px;margin:0 auto;padding:1rem" }, [tabList, tabBody]));
    if (!isAdmin()) activeTab = "live";
    show(activeTab);
    if (timer) clearInterval(timer);
    timer = setInterval(function () { var t = document.getElementById("stageTimer"), st = IELT.state.stage; if (t && st) { var left = st.timerEndsAt ? st.timerEndsAt - IELT.serverNow() : 0; t.textContent = st.timerEndsAt ? (left > 0 ? IELT.countdown(left) + " left" : "time is up") : "no timer"; } }, 1000);
  };
  function show(id) {
    activeTab = id; liveRefresh = null;
    Array.prototype.forEach.call(document.querySelectorAll(".tabs button"), function (b) { b.setAttribute("aria-selected", b.id === "tab-" + id ? "true" : "false"); });
    clear(tabBody);
    tabBody.setAttribute("aria-labelledby", "tab-" + id);
    IELT.state.module = "admin:" + id;
    ({ live: liveTab, roster: rosterTab, groups: groupsTab, research: researchTab, certificates: certificatesTab, settings: settingsTab, logs: logsTab })[id](tabBody);
  }
  IELT.onAdminPoll = function () { if (activeTab === "live" && liveRefresh) liveRefresh(); };

  /* ================= Live: stage controls and live status ================= */
  function liveTab(body) {
    var stages = IELT.state.boot.schema.stages, chosen = null;
    var controls = card(""), statusBox = el("div", {}), msg = el("div", {});
    var minutes = IELT.textField({ label: "Timer (minutes, 0 for none)", type: "number", inputmode: "numeric", value: "" });
    minutes.node.style.maxWidth = "14rem";
    var now = el("p", { role: "status", "aria-live": "polite" });
    function paintStage() {
      var st = IELT.state.stage;
      clear(now);
      IELT.add(now, ["Open stage: ", el("strong", { text: st.id + " " + st.name }), " (", el("span", { id: "stageTimer", class: "timer" }), ")"]);
      Array.prototype.forEach.call(btns.querySelectorAll("button"), function (b) { b.setAttribute("aria-pressed", b.getAttribute("data-id") === (chosen || st.id) ? "true" : "false"); });
    }
    var btns = el("div", { class: "stagebtns", role: "group", "aria-label": "Choose the stage to open" }, stages.map(function (s) {
      return el("button", { class: "btn", type: "button", "data-id": s.id, "aria-pressed": "false", text: s.id + " " + s.name, onclick: function () { chosen = s.id; minutes.set(String(s.minutes)); paintStage(); } });
    }));
    var open = el("button", { class: "btn primary", type: "button", text: "Open stage" });
    open.addEventListener("click", function () {
      var st = IELT.state.stage, target = chosen || stages[Math.min(st.index + 1, stages.length - 1)].id;
      var idx = stages.map(function (s) { return s.id; }).indexOf(target);
      var warn = target === "S9" ? "Open S9 Closed? This ends the workshop, makes certificates available and starts the 24-hour window of the post-workshop individual tasks."
        : idx < st.index ? "Go back to " + target + "? Steps that were already opened stay open." : "";
      if (warn && !window.confirm(warn)) return;
      IELT.run(open, msg, function () {
        return api("apiAdminOpenStage", { stage: target, timerMinutes: minutes.get() === "" ? undefined : Number(minutes.get()) }, {}).then(function (res) {
          IELT.state.stage = res.stage; chosen = null; paintStage(); msg.appendChild(IELT.message("ok", "Stage " + res.stage.id + " " + res.stage.name + " is open.")); refresh();
        });
      });
    });
    IELT.add(controls, [el("h2", { text: "Stage controls" }), now, el("p", { class: "muted small", text: "Choose a stage, set the timer, then press \"Open stage\". Participants see the change within about 20 seconds. Earlier steps stay open for anyone who needs to catch up." }),
      btns, el("div", { class: "row", style: "align-items:flex-end;margin-top:.8rem" }, [minutes.node, el("div", { class: "field" }, [open])]), msg]);
    body.appendChild(controls);
    body.appendChild(el("div", { class: "row" }, [el("h2", { text: "Live status", style: "margin:0" }), el("span", { class: "spacer" }), el("button", { class: "btn", type: "button", text: "Refresh now", onclick: function () { refresh(); } })]));
    body.appendChild(statusBox);
    paintStage();
    function refresh() {
      return api("apiAdminOverview", undefined, { attempts: 2 }).then(function (ov) { IELT.state.stage = ov.stage; paintStage(); paintStatus(ov); }, function (e) { if (!statusBox.firstChild) statusBox.appendChild(IELT.message("error", e.message)); });
    }
    function paintStatus(ov) {
      var c = ov.counts, open = {};
      Array.prototype.forEach.call(statusBox.querySelectorAll("[data-exc-open]"), function (n) { open[n.getAttribute("data-exc-open")] = true; });
      if (Object.keys(open).length && statusBox.contains(document.activeElement)) return;   /* do not redraw while an exception form is in use */
      clear(statusBox);
      var tile = function (n, label) { return el("div", {}, [el("b", { text: String(n) }), el("span", { text: label })]); };
      statusBox.appendChild(el("div", { class: "stat" }, [tile(c.signedIn + " / " + c.participants, "signed in"), tile(c.vr.vr + " + " + c.vr["vr-alt"], "VR: viewer + static"), tile(c.ar.ar + " + " + c.ar["ar-alt"], "AR: camera + non-camera"),
        tile(c.analyzer, "Task Analyzer"), tile(c.checkins.design + " / " + c.checkins.feedback + " / " + c.checkins.revision, "check-ins: design / feedback / revision"), tile(c.exit, "exit tickets"), tile(c.eligible, "certificate-eligible"), tile(c.noGroup, "without a group")]));
      statusBox.appendChild(table("Groups", ["Group", "Brief", "Members", "Reviews", "Design draft", "V1", "Material", "Feedback given", "Feedback received", "Decisions", "V2", "Check-ins D / F / R", "Technology"], ov.groups.map(function (g) {
        var d = g.drafts.design, when = function (t, late) { return t ? t + (late ? " (late)" : "") : el("span", { class: "no", text: "no" }); };
        return [String(g.no), String(g.brief), String(g.size), "Group " + g.reviewsNo, d ? "v" + d.version + (d.editing ? ", " + d.editing + " editing" : "") : "not started", when(g.v1At, g.v1Late), g.v1At ? String(g.materials) : "",
          when(g.feedbackGivenAt), when(g.feedbackReceivedAt), when(g.decisionsAt), when(g.v2At), g.checkins.design + " / " + g.checkins.feedback + " / " + g.checkins.revision, g.modality + (g.modalityAssigned ? " (assigned)" : "")];
      })));
      statusBox.appendChild(el("p", { class: "small muted", text: "Times are times of day (Europe/Istanbul). Updated at " + IELT.clock() + "." }));
      statusBox.appendChild(table("Participants", ["Name", "Group", "Signed in", "VR", "AR", "Analyzer", "Design", "Feedback", "Revision", "Exit", "Steps", "Certificate"].concat(isAdmin() ? ["Exception"] : []), ov.participants.map(function (p) {
        var row = [p.name + (p.status !== "active" ? " (disabled)" : ""), p.groupNo ? String(p.groupNo) : el("span", { class: "no", text: "none" }), yn(p.signedIn), p.vr || el("span", { class: "no", text: "no" }), p.ar || el("span", { class: "no", text: "no" }),
          yn(p.analyzer), yn(p.design), yn(p.feedback), yn(p.revision), yn(p.exit), p.done + " / " + p.total + (p.exceptions.length ? " (exception: " + p.exceptions.join(", ") + ")" : ""), yn(p.eligible)];
        if (isAdmin()) row.push(p.missing.length ? exceptionControl(p, ov.certSteps) : "");
        return row;
      })));
    }
    function exceptionControl(p, steps) {
      var box = el("div", {});
      var btn = el("button", { class: "btn quiet", type: "button", text: "Record exception", "aria-label": "Record exception for " + p.name });
      btn.addEventListener("click", function () {
        clear(box); box.setAttribute("data-exc-open", p.id);
        var m = el("div", {});
        var step = IELT.selectField({ label: "Step", options: steps.filter(function (s) { return p.missing.indexOf(s.id) >= 0; }).map(function (s) { return { value: s.id, label: s.label }; }) });
        var reason = IELT.textField({ label: "Reason (for example: connection failed during the AR stage)", rows: 2, max: 300 });
        var save = el("button", { class: "btn", type: "button", text: "Save exception" });
        save.addEventListener("click", function () { IELT.run(save, m, function () {
          return api("apiAdminRecordException", { participantId: p.id, step: step.get(), reason: reason.get() }, {}).then(function () { box.removeAttribute("data-exc-open"); clear(box); box.appendChild(IELT.message("ok", "Exception recorded.")); });
        }); });
        IELT.add(box, [step.node, reason.node, el("div", { class: "row" }, [save, el("button", { class: "btn quiet", type: "button", text: "Cancel", onclick: function () { box.removeAttribute("data-exc-open"); clear(box); box.appendChild(btn); } })]), m]);
        step.input.focus();
      });
      box.appendChild(btn);
      return box;
    }
    liveRefresh = function () { if (!document.hidden) refresh(); };
    refresh();
  }

  /* ================= Roster and access codes ================= */
  function rosterTab(body) {
    var listBox = el("div", {}), msg = el("div", {}), codesBox = el("div", {}), people = [], selected = {};
    var csv = IELT.textField({ label: "Paste the roster as CSV: full_name,email,institution (one person per line; a header line is optional)", rows: 6, max: 200000, spellcheck: false });
    var imp = el("button", { class: "btn", type: "button", text: "Import roster" });
    imp.addEventListener("click", function () { IELT.run(imp, msg, function () {
      return api("apiAdminImportRoster", { csv: csv.get() }, {}).then(function (res) {
        msg.appendChild(IELT.message("ok", res.added + " added. " + (res.skipped.length ? res.skipped.length + " skipped: " + res.skipped.map(function (s) { return "line " + s.line + " (" + s.reason + ")"; }).join("; ") : "Nothing skipped.")));
        csv.set(""); return load();
      });
    }); });
    body.appendChild(card("", [el("h2", { text: "Roster" }), csv.node, imp, msg]));
    var deliver = IELT.radioGroup({ label: "How to deliver the codes", value: "show", options: [{ value: "show", label: "Show them here once (download as CSV and distribute yourself)" }, { value: "email", label: "Email each person their code" }] });
    var quota = el("p", { class: "small muted" });
    var issue = el("button", { class: "btn primary", type: "button", text: "Issue access codes" });
    var issueMsg = el("div", {});
    issue.addEventListener("click", function () {
      var ids = Object.keys(selected).filter(function (k) { return selected[k]; });
      IELT.run(issue, issueMsg, function () {
        if (!ids.length) throw new Error("Select at least one person in the table below.");
        var withCode = people.filter(function (p) { return selected[p.id] && p.hasCode; }).length;
        if (withCode && !window.confirm(withCode + " of the selected people already have a code. A new code replaces the old one and signs them out. Continue?")) return null;
        var all = [], sent = 0, failed = 0, i = 0;
        function next() {
          if (i >= ids.length) return Promise.resolve();
          var batch = ids.slice(i, i + 25); i += 25;
          return api("apiAdminIssueCodes", { participantIds: batch, deliver: deliver.get() }, { attempts: 1 }).then(function (res) {
            all = all.concat(res.issued); sent += res.mail.sent; failed += res.mail.failed; quota.textContent = quotaText(res.mailQuota);
            issueMsg.textContent = "Issued " + all.length + " of " + ids.length + "…";
            return next();
          });
        }
        return next().then(function () {
          clear(issueMsg); selected = {};
          showCodes(all, sent, failed);
          return load();
        });
      });
    });
    function quotaText(q) { return q >= 0 ? "Emails this Google account can still send today: " + q + " recipients. (Consumer accounts: 100 per day; Google Workspace: 1,500 per day. One code email uses one.)" : "The remaining email quota could not be read."; }
    function showCodes(list, sent, failed) {
      clear(codesBox);
      var withCodes = list.filter(function (x) { return x.code; });
      var box = card("notice", [el("h3", { text: "Codes issued: " + list.length }),
        el("p", { text: (sent ? sent + " emailed. " : "") + (failed ? failed + " emails failed; their codes are listed here so that you can deliver them yourself. " : "") + (withCodes.length ? "These codes are shown only now. They are not stored anywhere in readable form." : "") })]);
      if (withCodes.length) {
        box.appendChild(el("button", { class: "btn", type: "button", text: "Download codes as CSV", onclick: function () {
          downloadText("access_codes.csv", "full_name,email,access_code\r\n" + withCodes.map(function (x) { return [csvCell(x.name), csvCell(x.email), csvCell(x.code)].join(","); }).join("\r\n") + "\r\n", "text/csv;charset=utf-8");
        } }));
        box.appendChild(table("Codes (shown once)", ["Name", "Email", "Access code"], withCodes.map(function (x) { return [x.name, x.email, el("code", { text: x.code })]; })));
      }
      codesBox.appendChild(box);
    }
    body.appendChild(card("", [el("h2", { text: "Access codes" }),
      el("p", { class: "muted", text: "Each person signs in with their email address and a personal 10-character code. Select people in the table, choose the delivery, then issue. Issuing again resets a code. People who registered themselves (Settings, Registration) already have a code; issue one here only if they lost it." }),
      deliver.node, quota, issue, issueMsg]));
    body.appendChild(codesBox);
    body.appendChild(listBox);
    function load() {
      return api("apiAdminListParticipants", undefined, {}).then(function (res) {
        people = res.participants; quota.textContent = quotaText(res.mailQuota);
        clear(listBox);
        var pick = function (fn) { people.forEach(function (p) { selected[p.id] = fn(p); }); Array.prototype.forEach.call(listBox.querySelectorAll("input[type=checkbox]"), function (c) { c.checked = !!selected[c.value]; }); };
        listBox.appendChild(el("div", { class: "row", style: "margin:.6rem 0" }, [
          el("button", { class: "btn", type: "button", text: "Select everyone without a code", onclick: function () { pick(function (p) { return !p.hasCode && p.status === "active"; }); } }),
          el("button", { class: "btn", type: "button", text: "Select all participants", onclick: function () { pick(function (p) { return p.role === "participant" && p.status === "active"; }); } }),
          el("button", { class: "btn quiet", type: "button", text: "Clear selection", onclick: function () { pick(function () { return false; }); } })]));
        listBox.appendChild(table("People on the roster: " + people.length, ["Select", "Name", "Email", "Institution", "Role", "Status", "Code issued", "Signed in", "Group", "Actions"], people.map(function (p) {
          var cb = el("input", { type: "checkbox", value: p.id, "aria-label": "Select " + p.name, checked: !!selected[p.id], onchange: function () { selected[p.id] = cb.checked; } });
          var role = el("select", { "aria-label": "Role of " + p.name }, ["participant", "facilitator", "admin"].map(function (r) { return el("option", { value: r, text: r }); }));
          role.value = p.role;
          var rowMsg = el("div", {});
          role.addEventListener("change", function () {
            if (!window.confirm("Change the role of " + p.name + " to " + role.value + "? They are signed out and sign in again.")) { role.value = p.role; return; }
            api("apiAdminUpdateParticipant", { participantId: p.id, role: role.value }, {}).then(load, function (e) { role.value = p.role; rowMsg.appendChild(IELT.message("error", e.message)); });
          });
          var toggle = el("button", { class: "btn quiet", type: "button", text: p.status === "active" ? "Disable" : "Enable", onclick: function () {
            if (!window.confirm((p.status === "active" ? "Disable " : "Enable ") + p.name + "?")) return;
            api("apiAdminUpdateParticipant", { participantId: p.id, status: p.status === "active" ? "disabled" : "active" }, {}).then(load, function (e) { rowMsg.appendChild(IELT.message("error", e.message)); });
          } });
          return [cb, p.name, p.email, p.institution, role, p.status, p.hasCode ? p.codeIssuedAt : el("span", { class: "no", text: "no" }), yn(p.signedIn), p.groupNo ? String(p.groupNo) : "", el("div", {}, [toggle, rowMsg])];
        })));
      }, function (e) { clear(listBox); listBox.appendChild(IELT.message("error", e.message)); });
    }
    load();
  }

  /* ================= Groups ================= */
  function groupsTab(body) {
    var msg = el("div", {}), out = el("div", {});
    var mode = IELT.radioGroup({ label: "Make groups by", value: "count", options: [{ value: "count", label: "Number of groups" }, { value: "size", label: "Target group size" }] });
    var value = IELT.textField({ label: "Number (for example 12 groups, or size 5)", type: "number", inputmode: "numeric", value: "12" });
    value.node.style.maxWidth = "16rem";
    var scope = IELT.radioGroup({ label: "Who is assigned", value: "all", options: [{ value: "all", label: "All active participants on the roster" }, { value: "signed_in", label: "Only participants who have signed in" }] });
    var btn = el("button", { class: "btn primary", type: "button", text: "Assign groups" });
    function assign(confirmReplace) {
      return api("apiAdminAssignGroups", { mode: mode.get(), value: Number(value.get()), scope: scope.get(), confirmReplace: !!confirmReplace }, {}).then(function (res) {
        clear(out);
        out.appendChild(IELT.message("ok", res.participants + " participants were assigned to " + res.groups.length + " groups."));
        out.appendChild(table("Groups", ["Group", "Members", "Brief", "Reviews"], res.groups.map(function (g) { return [String(g.no), String(g.size), String(g.brief), "Group " + g.reviewsNo]; })));
      }, function (e) {
        if (e.code === "NEEDS_CONFIRM" && window.confirm(e.message)) return assign(true);
        throw e;
      });
    }
    btn.addEventListener("click", function () { IELT.run(btn, msg, function () { return assign(false); }); });
    body.appendChild(card("", [el("h2", { text: "Group assignment" }),
      el("p", { class: "muted", text: "Groups are random and balanced in size. Briefs rotate 1, 2, 3 by group number, so all three contexts are covered. Review ring: each group reviews the next group, the last group reviews the first. A group never reviews itself." }),
      el("p", { class: "muted small", text: "Consent-aware grouping is a setting (Settings tab) and is OFF by default." }),
      mode.node, value.node, scope.node, btn, msg, out]));
    var moveMsg = el("div", {}), who = IELT.selectField({ label: "Participant", options: [] }), groupNo = IELT.textField({ label: "Group number (0 removes the person from all groups)", type: "number", inputmode: "numeric" });
    groupNo.node.style.maxWidth = "22rem";
    var move = el("button", { class: "btn", type: "button", text: "Move participant" });
    move.addEventListener("click", function () { IELT.run(move, moveMsg, function () {
      if (!who.get() || groupNo.get() === "") throw new Error("Choose a participant and a group number.");
      return api("apiAdminMoveParticipant", { participantId: who.get(), groupNo: Number(groupNo.get()) }, {}).then(function () { moveMsg.appendChild(IELT.message("ok", "Moved. The participant sees the new group within about 20 seconds.")); });
    }); });
    body.appendChild(card("", [el("h2", { text: "Late joiners and corrections" }), el("p", { class: "muted", text: "Put a late participant into a group, or move someone. Their individual steps stay with them." }), who.node, groupNo.node, move, moveMsg]));
    var modMsg = el("div", {}), gNo = IELT.textField({ label: "Group number", type: "number", inputmode: "numeric" }), modality = IELT.selectField({ label: "Assigned technology", options: ["VR 360° scene", "AR target"], placeholder: "Not assigned (the group chooses)" });
    gNo.node.style.maxWidth = "12rem";
    var setMod = el("button", { class: "btn", type: "button", text: "Save" });
    setMod.addEventListener("click", function () { IELT.run(setMod, modMsg, function () {
      return api("apiAdminSetGroupModality", { groupNo: Number(gNo.get()), assigned: !!modality.get(), modality: modality.get() || undefined }, {}).then(function () { modMsg.appendChild(IELT.message("ok", "Saved. The group's submissions will be marked as modality assigned: " + (modality.get() ? "yes" : "no") + ".")); });
    }); });
    body.appendChild(card("", [el("h2", { text: "Assigned modality (only if needed)" }), el("p", { class: "muted", text: "Groups normally choose VR or AR themselves. If you assign a technology to a group for an instructional reason, record it here so that assigned and freely chosen cases are kept apart in the analysis." }), gNo.node, modality.node, setMod, modMsg]));
    api("apiAdminListParticipants", undefined, {}).then(function (res) {
      res.participants.filter(function (p) { return p.role === "participant"; }).forEach(function (p) { who.input.appendChild(el("option", { value: p.id, text: p.name + (p.groupNo ? " (Group " + p.groupNo + ")" : " (no group)") })); });
    }, function () {});
  }

  /* ================= Research (administrators only) ================= */
  function researchTab(body) {
    var box = el("div", {}), msg = el("div", {}), out = el("div", {});
    body.appendChild(el("h2", { text: "Research" }));
    body.appendChild(box);
    api("apiAdminResearchSummary", undefined, {}).then(function (s) {
      var tile = function (n, label) { return el("div", {}, [el("b", { text: String(n) }), el("span", { text: label })]); };
      box.appendChild(IELT.message(s.enabled ? "ok" : "info", s.enabled ? "The individual tasks are open. Information sheet version: " + s.consentVersion + "." : "The individual tasks and the research part are switched off (Settings)."));
      box.appendChild(el("div", { class: "stat" }, [tile(s.consent.agree, "allow research use"), tile(s.consent.decline, "do not allow it"), tile(s.consent.withdraw, "withdrew"), tile(s.consent.none, "not decided yet"),
        tile(s.formOrder.AB + " / " + s.formOrder.BA, "form order AB / BA"), tile(s.groups.fullyConsenting + " / " + s.groups.total, "groups with full consent")]));
      if (s.everyone) box.appendChild(table("Completion by everyone (the tasks are a workshop step for all " + s.participants + " participants)", ["Occasion", "Background", "Design task", "Reflection"], [
        ["Before the workshop", String(s.everyone.background), String(s.everyone.t0Task), ""],
        ["After the workshop", "", String(s.everyone.t2Task), String(s.everyone.reflection)]]));
      box.appendChild(table("Research data (participants who currently allow the use of their answers)", ["Occasion", "Background", "Design task", "Scale", "Reflection"], [
        ["T0, before the workshop", String(s.t0.background), String(s.t0.task), s.scaleEnabled ? String(s.t0.scale) : "scale off", ""],
        ["T2, after the workshop", "", String(s.t2.task), s.scaleEnabled ? String(s.t2.scale) : "scale off", String(s.t2.reflection)]]));
      box.appendChild(el("p", { class: "small muted", text: (s.scaleEnabled ? "The scale is on: the ScaleItems sheet holds six items." : "The scale is off: the ScaleItems sheet in the data workbook has no item wording. Paste the six items there only after permission has been obtained.")
        + " T0 window: " + (s.windows.T0.open ? "open" : "closed") + ". T2 window: " + (s.windows.T2.open ? "open" : "closed") + "." }));
    }, function (e) { box.appendChild(IELT.message("error", e.message)); });
    var rule = IELT.radioGroup({ label: "Group artifacts are included", value: "all_members", options: [{ value: "all_members", label: "only if every assigned member of the group consented (default)" }, { value: "contributing_members", label: "only if every member with recorded workshop activity consented" }] });
    var exp = el("button", { class: "btn primary", type: "button", text: "Research export" });
    exp.addEventListener("click", function () { IELT.run(exp, msg, function () {
      return api("apiAdminResearchExport", { groupRule: rule.get() }, { attempts: 1 }).then(function (res) {
        clear(out);
        out.appendChild(card("success", [el("p", {}, [el("strong", { text: "Export created: " }), el("a", { href: res.url, target: "_blank", rel: "noopener", text: res.name })]),
          el("p", { text: res.counts.consentingParticipants + " consenting participants, " + res.counts.taskResponses + " task responses, " + res.counts.groupsIncluded + " of " + res.counts.groupsTotal + " groups with artifacts, " + res.counts.feedbackEpisodes + " feedback episodes." })]));
      });
    }); });
    body.appendChild(card("", [el("h3", { text: "Research export" }),
      el("p", { text: "Creates a new spreadsheet in your Google Drive with the records of participants who currently allow the research use of their answers, keyed by research ID. Answers of everyone else are never exported. Names, emails and internal ids are not exported. It includes a blind rating sheet for each of two raters (the same responses, each in its own random order), the key sheet, and a score sheet for each rater." }),
      el("p", {}, [el("strong", { text: "Exports contain times of day and elapsed minutes, never dates." })]),
      rule.node, exp, msg, out]));
    var pMsg = el("div", {}), purge = el("button", { class: "btn danger", type: "button", text: "Remove records that may not be used" });
    purge.addEventListener("click", function () {
      if (!window.confirm("Delete the individual task records of everyone who has withdrawn and, once the post-workshop part has closed, of everyone who did not allow research use? Exports already exclude them; this removes the rows from the data workbook. It cannot be undone.")) return;
      IELT.run(purge, pMsg, function () { return api("apiAdminPurgeWithdrawn", undefined, { attempts: 1 }).then(function (res) { pMsg.appendChild(IELT.message("ok", res.rowsRemoved + " rows removed." + (res.declinedIncluded ? "" : " Records of participants who did not allow research use stay until the post-workshop part has closed."))); }); });
    });
    body.appendChild(card("", [el("h3", { text: "Answers that may not be used" }), el("p", { class: "muted", text: "Participants who withdrew or did not allow research use are always left out of exports. You can also delete their individual task rows: at any time for withdrawals, after the post-workshop part has closed for the others." }), purge, pMsg]));
  }

  /* ================= Certificates ================= */
  var SAMPLE_NAMES = ["Ada Testperson", "Çağla Şimşek Öztürk", "İbrahim Ğ. Ünlüoğlu-Işık", "Maximiliane Aleksandra Çağlayangil-Öztürkoğlu von Hohenberg"];
  function certificatesTab(body) {
    var T = IELT.certTools, listBox = el("div", {}), calib = el("div", {}), upMsg = el("div", {});
    body.appendChild(el("h2", { text: "Certificates" }));
    /* upload */
    var file = el("input", { type: "file", id: "tplFile", accept: "application/pdf,.pdf" });
    var up = el("button", { class: "btn", type: "button", text: "Upload template" });
    up.addEventListener("click", function () { IELT.run(up, upMsg, function () {
      var f = file.files && file.files[0];
      if (!f) throw new Error("Choose a PDF file first.");
      if (f.size > 4 * 1024 * 1024) throw new Error("The template is larger than 4 MB. Export it with compressed images (2 MB or less is best: every participant downloads it).");
      var bytes, start, b64, size = 45000;
      return T.loadPdfTools().then(function () { return f.arrayBuffer(); }).then(function (buf) {
        bytes = new Uint8Array(buf);
        return Promise.all([T.sha256Hex(bytes), window.PDFLib.PDFDocument.load(bytes, { updateMetadata: false })]);
      }).then(function (r) {
        var doc = r[1], page = doc.getPages()[0], sz = page.getSize();
        b64 = T.bytesToB64(bytes);
        var count = Math.ceil(b64.length / size);
        return api("apiAdminTemplateUploadStart", { fileName: f.name.slice(0, 120), sizeBytes: bytes.length, sha256: r[0], chunkCount: count }, { attempts: 1 }).then(function (st) {
          start = st; var i = 0;
          function next() {
            if (i >= count) return Promise.resolve();
            var chunks = [];
            for (var k = 0; k < st.chunksPerCall && i < count; k++, i++) chunks.push({ index: i, data: b64.slice(i * size, (i + 1) * size) });
            upMsg.textContent = "Uploading… " + Math.round(100 * i / count) + "%";
            return api("apiAdminTemplateUploadChunks", { templateId: st.templateId, chunks: chunks }, { attempts: 3 }).then(next);
          }
          return next().then(function () { return api("apiAdminTemplateUploadFinish", { templateId: st.templateId, pageCount: doc.getPageCount(), pageWidth: sz.width, pageHeight: sz.height }, { attempts: 1 }); });
        });
      }).then(function (meta) { clear(upMsg); upMsg.appendChild(IELT.message("ok", "Template version " + meta.version + " uploaded and verified. Calibrate the name position below, then activate it.")); file.value = ""; return loadList().then(function () { calibrate(meta); }); });
    }); });
    body.appendChild(card("", [el("h3", { text: "Certificate template" }),
      el("p", { class: "muted", text: "Upload the final certificate as a PDF. The portal adds only the participant's name. The original file is stored unchanged; each upload becomes a new version." }),
      el("div", { class: "field" }, [el("label", { for: "tplFile", text: "Template PDF (4 MB at most)" }), file]), up, upMsg]));
    body.appendChild(listBox);
    body.appendChild(calib);
    var fonts = [];
    function loadList() {
      return api("apiAdminTemplateList", undefined, {}).then(function (res) {
        fonts = res.fonts;
        clear(listBox);
        var active = res.templates.filter(function (t) { return t.status === "active"; })[0];
        listBox.appendChild(IELT.message(active ? "ok" : "info", active ? "Active template: version " + active.version + " (" + active.fileName + "). Eligible participants can download their certificate." : "No template is active. Participants see \"the certificate is not available yet\"."));
        listBox.appendChild(table("Template versions", ["Version", "File", "Size", "Pages", "Status", "Uploaded", "Actions"], res.templates.map(function (t) {
          var m = el("span", {});
          return [String(t.version), t.fileName, Math.round(t.sizeBytes / 1024) + " KB", String(t.pageCount), t.status, t.uploadedAt, el("div", { class: "row" }, [
            el("button", { class: "btn", type: "button", text: "Calibrate and test", onclick: function () { calibrate(t); } }),
            t.status === "active" ? null : el("button", { class: "btn primary", type: "button", text: "Activate", onclick: function () {
              if (!window.confirm("Activate template version " + t.version + "? Eligible participants will receive this template with the saved name position.")) return;
              api("apiAdminTemplateActivate", { templateId: t.templateId }, {}).then(loadList, function (e) { m.textContent = e.message; });
            } }), m])];
        })));
      }, function (e) { clear(listBox); listBox.appendChild(IELT.message("error", e.message)); });
    }
    /* calibration */
    function calibrate(meta) {
      clear(calib);
      var cfg = JSON.parse(JSON.stringify(meta.config)), tplBytes = null, fontCache = {}, msg = el("div", {}), result = el("div", {});
      var canvas = el("canvas", { role: "img", "aria-label": "Preview of the certificate template. Click to place the name, or drag to draw the name box." });
      var boxEl = el("div", { class: "box" }), baseEl = el("div", { class: "base" }), wrap = el("div", { class: "canvaswrap" }, [canvas, boxEl, baseEl]);
      var viewport = null, sampleBytes = null;
      var inputs = {};
      function num(key, label, step) { inputs[key] = IELT.textField({ label: label, type: "number", inputmode: "decimal", value: String(cfg[key]), oninput: function (v) { if (v !== "" && isFinite(Number(v))) { cfg[key] = Number(v); sampleBytes = null; drawOverlay(); } } }); inputs[key].input.step = step || "1"; return inputs[key].node; }
      var fontSel = IELT.selectField({ label: "Font", options: fonts.map(function (f) { return { value: f.id, label: f.label }; }), value: cfg.font, onchange: function (v) { if (v) { cfg.font = v; sampleBytes = null; drawOverlay(); } } });
      var alignSel = IELT.selectField({ label: "Alignment in the box", options: ["left", "center", "right"], value: cfg.align, onchange: function (v) { if (v) { cfg.align = v; sampleBytes = null; } } });
      var colour = el("input", { type: "color", id: "certColour", value: cfg.color, onchange: function () { cfg.color = colour.value.toUpperCase(); sampleBytes = null; } });
      var names = IELT.textField({ label: "Test names (one per line; include long names and Turkish characters)", rows: 5, value: SAMPLE_NAMES.join("\n") });
      function font() { if (!fontCache[cfg.font]) fontCache[cfg.font] = T.fetchFont(cfg.font); return fontCache[cfg.font]; }
      function setInputs() { ["page", "x", "y", "boxWidth", "size", "minSize"].forEach(function (k) { inputs[k].set(String(cfg[k])); }); }
      function drawOverlay() {
        if (!viewport) return;
        font().then(function (fb) {
          var fk = window.fontkit.create(fb), b = window.CertEngine.nameBox(cfg, fk);
          var p0 = viewport.convertToViewportPoint(b.x0, b.y1), p1 = viewport.convertToViewportPoint(b.x1, b.y0), base = viewport.convertToViewportPoint(b.x0, b.baseline);
          var k = canvas.clientWidth / canvas.width;
          boxEl.style.left = p0[0] * k + "px"; boxEl.style.top = p0[1] * k + "px"; boxEl.style.width = (p1[0] - p0[0]) * k + "px"; boxEl.style.height = (p1[1] - p0[1]) * k + "px";
          baseEl.style.left = p0[0] * k + "px"; baseEl.style.top = base[1] * k + "px"; baseEl.style.width = (p1[0] - p0[0]) * k + "px";
        }, function (e) { msg.textContent = e.message; });
      }
      function renderPdf(bytes) {
        return window.pdfjsLib.getDocument({ data: bytes.slice(0), isEvalSupported: false }).promise.then(function (doc) {
          return doc.getPage(Math.min(doc.numPages, cfg.page + 1));
        }).then(function (page) {
          var base = page.getViewport({ scale: 1 }), scale = Math.min(2, 1100 / base.width);
          viewport = page.getViewport({ scale: scale });
          canvas.width = Math.round(viewport.width); canvas.height = Math.round(viewport.height);
          if (page.rotate) msg.appendChild(IELT.message("error", "This page is rotated inside the PDF. Certificates cannot be created on rotated pages: export the template again without rotation."));
          return page.render({ canvasContext: canvas.getContext("2d"), viewport: viewport }).promise;
        }).then(drawOverlay);
      }
      function point(ev) {
        var r = canvas.getBoundingClientRect(), k = canvas.width / r.width;
        var p = viewport.convertToPdfPoint((ev.clientX - r.left) * k, (ev.clientY - r.top) * k);
        return { x: Math.round(p[0] * 10) / 10, y: Math.round(p[1] * 10) / 10 };
      }
      var dragStart = null;
      canvas.addEventListener("pointerdown", function (ev) { if (viewport) { dragStart = point(ev); canvas.setPointerCapture(ev.pointerId); } });
      canvas.addEventListener("pointerup", function (ev) {
        if (!dragStart || !viewport) return;
        var end = point(ev);
        if (Math.abs(end.x - dragStart.x) > 12) { cfg.x = Math.min(dragStart.x, end.x); cfg.boxWidth = Math.round(Math.abs(end.x - dragStart.x) * 10) / 10; cfg.y = Math.min(dragStart.y, end.y); }
        else { cfg.x = Math.round((end.x - cfg.boxWidth / 2) * 10) / 10; cfg.y = end.y; }
        dragStart = null; sampleBytes = null; setInputs(); drawOverlay();
      });
      function testNames(showFirst) {
        var list = names.get().split("\n").map(function (s) { return s.replace(/^\s+|\s+$/g, ""); }).filter(Boolean);
        return font().then(function (fb) {
          clear(result);
          var rows = list.map(function (n) {
            var c = window.CertEngine.checkName(window.fontkit, fb, n, cfg);
            return [n, c.ok ? "fits" : (c.reason === "NAME_TOO_LONG" ? "too long, even at the minimum size" : c.reason === "MISSING_GLYPH" ? "font lacks: " + (c.missing || []).join(" ") : c.reason), c.ok ? c.fittedSize + " pt" + (c.shrunk ? " (shrunk)" : "") : ""];
          });
          result.appendChild(table("Test names", ["Name", "Result", "Font size used"], rows));
          if (!showFirst || !list.length) return null;
          return window.CertEngine.renderCertificate({ PDFLib: window.PDFLib, fontkit: window.fontkit, templateBytes: tplBytes, fontBytes: fb, name: showFirst === true ? list[0] : showFirst, config: cfg }).then(function (res) {
            if (!res.ok) { result.appendChild(IELT.message("error", "The preview name cannot be drawn: " + res.reason + ".")); return renderPdf(tplBytes); }
            sampleBytes = res.bytes;
            return renderPdf(res.bytes);
          });
        });
      }
      var preview = el("button", { class: "btn", type: "button", text: "Test with these names" });
      preview.addEventListener("click", function () { IELT.run(preview, msg, function () { return testNames(true); }); });
      var longest = el("button", { class: "btn", type: "button", text: "Check all roster names" });
      longest.addEventListener("click", function () { IELT.run(longest, msg, function () {
        return Promise.all([api("apiAdminListParticipants", undefined, {}), font()]).then(function (r) {
          var bad = r[0].participants.filter(function (p) { return p.role === "participant"; }).map(function (p) { return { p: p, c: window.CertEngine.checkName(window.fontkit, r[1], p.name, cfg) }; }).filter(function (x) { return !x.c.ok; });
          clear(result);
          if (!bad.length) result.appendChild(IELT.message("ok", "Every name on the roster fits with this font and position."));
          else result.appendChild(table("Names that cannot be printed with these settings", ["Name", "Problem"], bad.map(function (x) { return [x.p.name, x.c.reason === "NAME_TOO_LONG" ? "too long, even at the minimum size" : "font lacks: " + (x.c.missing || []).join(" ")]; })));
        });
      }); });
      var clearPrev = el("button", { class: "btn quiet", type: "button", text: "Show the empty template", onclick: function () { sampleBytes = null; renderPdf(tplBytes); } });
      var dl = el("button", { class: "btn quiet", type: "button", text: "Download this test PDF", onclick: function () { if (sampleBytes) T.download(sampleBytes, "certificate_test.pdf"); else msg.textContent = "Press \"Test with these names\" first."; } });
      var save = el("button", { class: "btn primary", type: "button", text: "Save name position" });
      save.addEventListener("click", function () { IELT.run(save, msg, function () {
        return api("apiAdminTemplateSaveConfig", { templateId: meta.templateId, config: cfg }, {}).then(function (m) { cfg = JSON.parse(JSON.stringify(m.config)); setInputs(); msg.appendChild(IELT.message("ok", "Saved for template version " + m.version + ".")); return loadList(); });
      }); });
      calib.appendChild(card("", [el("h3", { text: "Calibrate and test: template version " + meta.version }),
        el("p", { class: "muted", text: "Click on the preview to put the centre of the name on that point, or drag from left to right to draw the name box. The dashed box is the area the name may use; the thin line is the text baseline. Units are PDF points (1/72 inch) from the bottom-left corner." }),
        wrap,
        el("div", { class: "grid2", style: "margin-top:1rem" }, [
          el("div", {}, [num("x", "x: left edge of the name box", "0.1"), num("y", "y: baseline of the name", "0.1"), num("boxWidth", "Box width", "0.1"), num("page", "Page (0 is the first page)", "1")]),
          el("div", {}, [fontSel.node, num("size", "Font size", "0.5"), num("minSize", "Minimum size when a long name is shrunk to fit", "0.5"), alignSel.node,
            el("div", { class: "field" }, [el("label", { for: "certColour", text: "Colour" }), colour])])]),
        names.node, el("div", { class: "row" }, [preview, longest, clearPrev, dl, el("span", { class: "spacer" }), save]), msg, result]));
      msg.textContent = "Loading the template…";
      Promise.all([IELT.loadScript("pdfjsWorker").then(function () { return IELT.loadScript("pdfjs"); }), T.loadPdfTools()]).then(function () {
        var parts = [];
        function more() { return api("apiAdminTemplateChunks", { templateId: meta.templateId, from: parts.length }, {}).then(function (res) { parts = parts.concat(res.chunks); return parts.length < res.chunkCount ? more() : null; }); }
        return more().then(function () { tplBytes = T.b64ToBytes(parts.join("")); return renderPdf(tplBytes); });
      }).then(function () { msg.textContent = ""; }, function (e) { clear(msg); msg.appendChild(IELT.message("error", e.message)); });
    }
    /* corrections, reissue, log */
    var who = IELT.selectField({ label: "Participant", options: [] }), newName = IELT.textField({ label: "Correct name, exactly as it should appear on the certificate", max: 120 }), reason = IELT.textField({ label: "Reason", max: 300 });
    var cMsg = el("div", {}), corr = el("button", { class: "btn", type: "button", text: "Correct name" }), grant = el("button", { class: "btn", type: "button", text: "Authorise a reissue" });
    corr.addEventListener("click", function () { IELT.run(corr, cMsg, function () {
      return api("apiAdminCorrectName", { participantId: who.get(), newName: newName.get(), reason: reason.get() }, {}).then(function (res) { cMsg.appendChild(IELT.message("ok", "Name corrected." + (res.reissueGranted ? " A reissue was authorised because a certificate had already been issued." : ""))); newName.set(""); reason.set(""); return loadLog(); });
    }); });
    grant.addEventListener("click", function () { IELT.run(grant, cMsg, function () {
      return api("apiAdminGrantReissue", { participantId: who.get(), reason: reason.get() }, {}).then(function () { cMsg.appendChild(IELT.message("ok", "Reissue authorised. The participant can download once more from the Certificate Center.")); reason.set(""); return loadLog(); });
    }); });
    var logBox = el("div", {});
    body.appendChild(card("", [el("h3", { text: "Name corrections and reissue" }),
      el("p", { class: "muted", text: "The certificate prints the registered name. Correct it here if needed (every correction is logged). After a certificate has been issued, another download needs your authorisation; give the reason." }),
      who.node, newName.node, reason.node, el("div", { class: "row" }, [corr, grant]), cMsg]));
    body.appendChild(logBox);
    function loadLog() {
      return api("apiAdminCertificateLog", undefined, {}).then(function (res) {
        clear(logBox);
        logBox.appendChild(table("Certificate log (newest first; internal record, never printed)", ["Time", "Name printed", "Kind", "Status", "PDF hash", "Detail"], res.events.map(function (e) { return [e.at, e.namePrinted, e.kind, e.status, e.bytesSha256 ? e.bytesSha256.slice(0, 23) + "…" : "", e.detail]; })));
        logBox.appendChild(table("Reissue authorisations", ["Time", "Participant", "Reason", "By"], res.grants.map(function (g) { return [g.at, g.name, g.reason, g.by]; })));
        logBox.appendChild(table("Name corrections", ["Time", "Before", "After", "Reason", "By"], res.corrections.map(function (c) { return [c.at, c.oldName, c.newName, c.reason, c.by]; })));
      }, function () {});
    }
    api("apiAdminListParticipants", undefined, {}).then(function (res) { res.participants.filter(function (p) { return p.role === "participant"; }).forEach(function (p) { who.input.appendChild(el("option", { value: p.id, text: p.name })); }); }, function () {});
    loadList(); loadLog();
  }

  /* ================= Settings ================= */
  function settingsTab(body) {
    var box = el("div", {});
    body.appendChild(el("h2", { text: "Settings" }));
    body.appendChild(box);
    api("apiAdminGetSettings", undefined, {}).then(function (res) {
      var v = res.values, f = {}, msg = el("div", {});
      var text = function (key, label, o) { o = o || {}; f[key] = IELT.textField({ label: label, value: v[key], rows: o.rows, max: o.max, help: o.help, spellcheck: o.spellcheck }); return f[key].node; };
      var flag = function (key, label, help) { f[key] = IELT.selectField({ label: label, value: v[key], options: [{ value: "true", label: "On" }, { value: "false", label: "Off" }], help: help }); return f[key].node; };
      /* workshop start: an instant. The browser turns the local date and time into epoch milliseconds; records never store it. */
      var startId = IELT.uid("in"), start = el("input", { type: "datetime-local", id: startId });
      if (v.WORKSHOP_START_MS) { var d = new Date(Number(v.WORKSHOP_START_MS)), pad = function (n) { return (n < 10 ? "0" : "") + n; }; start.value = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()); }
      var save = el("button", { class: "btn primary", type: "button", text: "Save settings" });
      save.addEventListener("click", function () { IELT.run(save, msg, function () {
        var values = {};
        Object.keys(f).forEach(function (k) { if (f[k].get() !== v[k]) values[k] = f[k].get(); });
        var ms = start.value ? String(new Date(start.value).getTime()) : "";
        if (ms !== (v.WORKSHOP_START_MS || "")) { if (ms && isNaN(Number(ms))) throw new Error("The workshop start is not a valid date and time."); values.WORKSHOP_START_MS = ms; }
        if (!Object.keys(values).length) { msg.appendChild(IELT.message("info", "Nothing has changed.")); return null; }
        return api("apiAdminSaveSettings", { values: values }, {}).then(function (r) { Object.keys(values).forEach(function (k) { v[k] = values[k]; }); msg.appendChild(IELT.message("ok", "Saved: " + r.changed.join(", ") + ".")); return IELT.refreshBoot ? api("apiBootstrap", undefined, {}).then(function (b) { IELT.state.boot = b; }) : null; });
      }); });
      IELT.add(box, [
        card("", [el("h3", { text: "Workshop" }),
          text("STATIC_BASE_URL", "Address of the static VR/AR site", { spellcheck: false, help: "The published project site (https). The portal loads the 360° viewer, the AR targets, fonts and helper scripts from here and from nowhere else." }),
          text("PORTAL_URL", "Address of this portal (used only in access-code emails)", { spellcheck: false, help: "The address participants open: the portal page on the project site (it ends in /portal/)." }),
          el("div", { class: "field" }, [el("label", { for: startId, text: "Workshop start (your local date and time)" }),
            el("div", { class: "help", text: "Opens the pre-workshop individual tasks 72 hours earlier and is the zero point of \"minutes from workshop start\". Set it once, before the window opens. It is kept as a technical value only: records store times of day and elapsed minutes, never dates." }), start]),
          text("SUPPORT_NOTE", "Note on the sign-in page", { max: 300 }),
          text("ANALYZER_OBJECTIVE", "Objective shown in the Task Analyzer", { rows: 2, max: 300 })]),
        card("", [el("h3", { text: "Registration" }),
          el("p", { class: "muted", text: "Two ways to put people on the roster. Off: you import the list under Roster and codes and issue the codes. On: each person registers on the sign-in page with the workshop word, sees a personal access code once and is signed in. Both ways can be used together." }),
          flag("SELF_REGISTRATION", "Self-registration", "Needs a workshop word. Switch it off again when everyone has registered."),
          text("REGISTRATION_WORD", "Workshop word", { spellcheck: false, help: "4 to 20 letters (A to Z) or digits; capitals and spaces do not matter. Send it with the invitation. Anyone who has the portal address and this word can register." }),
          flag("SELF_REG_EMAIL_CODE", "Also email the access code after registration", "On: the code is shown on the screen and also sent to the address the person typed (one email from your daily quota). A mistyped address sends the code to someone else. Off: the screen is the only copy."),
          text("SELF_REG_MAX", "Largest roster size", { spellcheck: false, help: "Self-registration stops when the roster holds this many people, staff included (1 to 500)." }),
          el("p", { class: "small muted", text: "Names typed by participants are printed on certificates as typed. Check the roster before the workshop: correct names under Certificates, and disable a second entry of the same person under Roster and codes." })]),
        card("", [el("h3", { text: "Checkpoint words" }), el("p", { class: "muted", text: "The same four words must be set in config.js of the static site. They are not secrets: they record which version a participant used. Compared without regard to capital letters." }),
          el("div", { class: "grid2" }, [el("div", {}, [text("WORD_VR", "VR, 360° viewer", { spellcheck: false }), text("WORD_VR_ALT", "VR, static version", { spellcheck: false })]),
            el("div", {}, [text("WORD_AR", "AR, camera", { spellcheck: false }), text("WORD_AR_ALT", "AR, non-camera version", { spellcheck: false })])])]),
        card("", [el("h3", { text: "Individual tasks and research" }),
          el("p", { class: "muted", text: "When this part is on, every participant is asked to do the individual tasks before and after the workshop. Each participant chooses whether the answers may be used in the research; only those answers are exported. The certificate does not depend on this part." }),
          res.consentPlaceholder ? IELT.message("info", "The information sheet is still the placeholder. Replace it with the approved information sheet before you switch this part on.") : null,
          flag("RESEARCH_ENABLED", "Individual tasks and research part", "Off until the ethics-approved information sheet is in place."),
          text("CONSENT_VERSION", "Consent version label", { max: 40, help: "Change the label whenever you change the text." }),
          text("CONSENT_TEXT", "Information sheet and consent text", { rows: 12, max: 20000 }),
          flag("CONSENT_AWARE_GROUPING", "Consent-aware grouping", "Off by default. When on, consenting participants are grouped together so that more groups can be used for research. Trade-off: group membership then hints at consent status. See the protocol."),
          text("SCALE_INSTRUCTION", "Instruction above the scale", { max: 300 }),
          text("SCALE_ANCHOR_LABELS", "Five scale labels, separated by |", { max: 250, help: "Use the labels of the original instrument. The scale appears only when the ScaleItems sheet holds all six items (" + (res.scaleEnabled ? "it does" : "it does not yet") + ")." }),
          text("FORM_VERSION", "Version label of the individual task forms", { max: 20 })]),
        card("", [el("h3", { text: "Helper scripts from the static site" }),
          flag("SRI_ENFORCE", "Check integrity hashes of helper scripts", "On: a script from the static site runs only if it matches the hash below. Needs a host that sends CORS headers (GitHub Pages does)."),
          text("VENDOR_SRI_JSON", "Integrity hashes (JSON). Leave empty to use the built-in hashes of the vendored files.", { rows: 5, max: 2000, spellcheck: false }),
          el("pre", { class: "code", text: "Built-in: " + JSON.stringify(res.vendorSriDefault, null, 1) })]),
        save, msg]);
    }, function (e) { box.appendChild(IELT.message("error", e.message)); });
    var rMsg = el("div", {}), reset = el("button", { class: "btn danger", type: "button", text: "Return the workshop to S0" });
    reset.addEventListener("click", function () {
      var word = window.prompt("This sets the stage back to S0 and clears the closing time of the workshop (for a mistaken click or after a rehearsal). Records stay. Type RESET to confirm.");
      if (word === null) return;
      IELT.run(reset, rMsg, function () { return api("apiAdminResetStage", { confirm: word }, {}).then(function (res) { IELT.state.stage = res.stage; rMsg.appendChild(IELT.message("ok", "The workshop is back at S0.")); }); });
    });
    body.appendChild(card("", [el("h3", { text: "Stage reset" }), el("p", { class: "muted", text: "Use a separate copy of the portal for rehearsals if you can. This button is for emergencies." }), reset, rMsg]));
  }

  /* ================= Logs ================= */
  function logsTab(body) {
    var box = el("div", {});
    body.appendChild(el("div", { class: "row" }, [el("h2", { text: "Logs", style: "margin:0" }), el("span", { class: "spacer" }), el("button", { class: "btn", type: "button", text: "Refresh", onclick: load })]));
    body.appendChild(box);
    function load() {
      clear(box);
      api("apiAdminErrorLog", undefined, {}).then(function (res) {
        box.appendChild(table("Technical errors (newest first)", ["Time", "Source", "Who", "Where", "Message", "Browser"], res.errors.map(function (e) { return [e.at, e.source, e.name, e.module, e.message, e.userAgent]; })));
        return api("apiAdminAuditLog", undefined, {});
      }).then(function (res) {
        box.appendChild(table("Administrative actions (newest first)", ["Time", "Who", "Role", "Action", "Target", "Detail"], res.entries.map(function (a) { return [a.at, a.actor, a.role, a.action, a.target, a.detail]; })));
      }, function (e) { box.appendChild(IELT.message("error", e.message)); });
    }
    load();
  }
})();

/* ===== JsMain.html ===== */
/*
 * JsMain: start-up, sign-in, the participant shell (top bar, always-visible status bar, guided
 * navigation, pending tasks) and module switching.
 */
(function () {
  "use strict";
  var IELT = window.IELT, el = IELT.el, clear = IELT.clear, api = IELT.api;
  var app = document.getElementById("app");
  var TITLE = app.getAttribute("data-app-title"), SUBTITLE = app.getAttribute("data-app-subtitle");
  var STEP_OF = { vr: ["vr"], ar: ["ar"], analyzer: ["analysis"], designer: ["design"], materials: ["material"], feedback: ["feedback"], revision: ["revision"], final: ["final"], exit: ["exit"] };
  var chrome = {}, timerHandle = null, stageBanner = null;

  /* ---------- sign-in and self-registration ---------- */
  function hero() {
    return el("section", { class: "hero" }, [
      el("h1", { text: TITLE }), el("div", { class: "sub", text: SUBTITLE }),
      el("p", { text: "Workshop portal for Designing Immersive ELT Tasks: From VR and AR to Pedagogy." }),
      el("p", { text: "How can we transform virtual and augmented experiences into pedagogically meaningful language-learning tasks?" })
    ]);
  }
  function renderSignIn(note) {
    IELT.stopPolling();
    if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
    IELT.state.boot = null; IELT.state.module = "signin";
    clear(app);
    var box = el("div", {}), ready = el("div", {}), offer = el("div", {});
    var email = IELT.textField({ label: "Email address", type: "email", autocomplete: "username", required: true, inputmode: "email", spellcheck: false });
    var code = IELT.textField({ label: "Personal access code", type: "text", autocomplete: "one-time-code", required: true, spellcheck: false, help: "Ten letters and digits, for example ABCDE-FGHJK. Capital or small letters both work." });
    code.input.setAttribute("autocapitalize", "characters");
    var submit = el("button", { class: "btn primary", type: "submit", text: "Sign in" });
    var form = el("form", { novalidate: true, onsubmit: function (ev) {
      ev.preventDefault();
      IELT.run(submit, box, function () {
        if (!email.get() || !code.get()) throw new Error("Enter your email address and your personal access code.");
        return api("apiLogin", undefined, { args: [email.get(), code.get()], attempts: 2 }).then(function (boot) {
          IELT.state.token = boot.token; IELT.store.set("token", boot.token); delete boot.token;
          enter(boot);
        });
      });
    } }, [email.node, code.node, box, submit]);
    app.appendChild(el("div", { class: "signin" }, [
      hero(),
      el("main", { class: "panel", id: "main" }, [el("h2", { text: "Sign in" }), note ? IELT.message("info", note) : null, ready,
        el("p", { class: "muted", text: "Use the email address you registered with and the access code you received. The code is personal." }), form, offer])
    ]));
    api("apiPublicInfo", undefined, { args: [], attempts: 2 }).then(function (info) {
      if (!info.ready) ready.appendChild(IELT.message("error", "The portal has not been set up yet. Please tell the facilitator."));
      else if (info.supportNote) ready.appendChild(el("p", { class: "small muted", text: info.supportNote }));
      /* Shown only while the administrator has self-registration switched on. */
      if (info.ready && info.registrationOpen) IELT.add(offer, [el("div", { class: "register-offer" }, [
        el("h3", { text: "First time here?" }),
        el("p", { class: "muted", text: "Register once. You then get your personal access code straight away." }),
        el("button", { class: "btn", type: "button", text: "Register for the workshop", onclick: renderRegister })])]);
    }, function () { ready.appendChild(IELT.message("error", "The portal cannot be reached right now. Check your connection and reload the page.")); });
    email.input.focus();
  }

  /* Self-registration: the person types their own name and address; the server adds them to the roster. */
  function renderRegister() {
    IELT.state.module = "register";
    clear(app);
    var box = el("div", {});
    var name = IELT.textField({ label: "Full name", type: "text", autocomplete: "name", required: true, max: 120, help: "First name and surname, exactly as they should appear on your certificate." });
    var email = IELT.textField({ label: "Email address", type: "email", autocomplete: "email", required: true, inputmode: "email", spellcheck: false, help: "You sign in with this address. Check it for typing mistakes." });
    var institution = IELT.textField({ label: "Institution", type: "text", autocomplete: "organization", max: 160, help: "Your university or school (optional)." });
    var word = IELT.textField({ label: "Workshop word", type: "text", required: true, spellcheck: false, help: "Your instructor gave you this word with the invitation." });
    word.input.setAttribute("autocapitalize", "characters");
    var submit = el("button", { class: "btn primary", type: "submit", text: "Register" });
    var requestId = IELT.rid();   /* one id for every attempt, so a repeated request never creates a second person */
    var form = el("form", { novalidate: true, onsubmit: function (ev) {
      ev.preventDefault();
      IELT.run(submit, box, function () {
        if (!name.get().replace(/\s/g, "") || !email.get().replace(/\s/g, "") || !word.get().replace(/\s/g, "")) throw new Error("Fill in your full name, your email address and the workshop word.");
        return api("apiRegister", undefined, { args: [{ fullName: name.get(), email: email.get(), institution: institution.get(), word: word.get(), rid: requestId }], attempts: 3 }).then(function (boot) {
          var reg = boot.registration; delete boot.registration;
          IELT.state.token = boot.token; IELT.store.set("token", boot.token); delete boot.token;
          renderAccessCode(reg, boot);
        });
      });
    } }, [name.node, email.node, institution.node, word.node, box, submit]);
    app.appendChild(el("div", { class: "signin" }, [
      hero(),
      el("main", { class: "panel", id: "main" }, [el("h2", { text: "Register" }),
        el("p", { class: "muted", text: "Fill in this form once. You then see your personal access code. You need the code, together with your email address, every time you sign in." }),
        form,
        el("p", {}, [el("button", { class: "btn quiet", type: "button", text: "Back to sign in", onclick: function () { renderSignIn(); } })])])
    ]));
    name.input.focus();
  }

  /* The access code is shown once, right after registration. The person is already signed in. */
  function renderAccessCode(reg, boot) {
    IELT.state.module = "accesscode";
    clear(app);
    var go = el("button", { class: "btn primary", type: "button", text: "I have saved my code. Continue", onclick: function () { enter(boot); } });
    app.appendChild(el("div", { class: "signin" }, [
      hero(),
      el("main", { class: "panel", id: "main" }, [el("h2", { text: "Your personal access code" }),
        IELT.message("ok", "You are registered."),
        el("p", { class: "bigcode", "aria-label": "Access code" }, [el("code", { text: reg.code })]),
        el("p", {}, [el("strong", { text: "Write this code down or take a screenshot now. It is shown only once." })]),
        el("p", { text: "You sign in with " + reg.email + " and this code. The code is personal: do not share it." }),
        el("p", { class: "muted", text: reg.emailed ? "The code has also been sent to " + reg.email + ". If it does not arrive, check your spam folder." : "No email was sent, so this screen is your only copy. If you lose the code, ask your instructor for a new one." }),
        go])
    ]));
    IELT.announce("You are registered. Your personal access code is on the screen.");
    go.focus();
  }
  IELT.onAuthLost = function () {
    if (!IELT.state.token) return;
    IELT.state.token = ""; IELT.store.del("token");
    renderSignIn("Your session has ended. Please sign in again. Text you had not saved is kept in this browser.");
  };
  function signOut() {
    var token = IELT.state.token;
    IELT.stopPolling();
    api("apiLogout", undefined, { attempts: 1 }).then(function () {}, function () {});
    IELT.state.token = ""; IELT.drafts = {};
    try { Object.keys(sessionStorage).forEach(function (k) { if (k.indexOf("ielt:") === 0) sessionStorage.removeItem(k); }); } catch (e) { /* ignore */ }
    if (token) renderSignIn("You have signed out.");
  }

  /* ---------- after sign-in ---------- */
  function enter(boot) {
    IELT.state.boot = boot; IELT.state.stage = boot.stage; IELT.state.progress = boot.progress || null;
    if (boot.me.role === "participant") renderParticipantShell(); else IELT.renderAdminShell(app, signOut);
    IELT.schedulePoll();
  }
  function refreshBoot() {
    return api("apiBootstrap", undefined, {}).then(function (boot) {
      IELT.state.boot = boot; IELT.state.stage = boot.stage; if (boot.progress) IELT.state.progress = boot.progress;
      refreshChrome();
      return boot;
    });
  }
  IELT.refreshBoot = refreshBoot;

  /* ---------- participant shell ---------- */
  function moduleDef(id) { var m = IELT.state.boot.schema.modules; for (var i = 0; i < m.length; i++) if (m[i].id === id) return m[i]; return null; }
  function available(id) { var d = moduleDef(id); return !!d && d.stage <= IELT.state.stage.maxIndex; }
  function stepDone(id) {
    var p = IELT.state.progress, need = STEP_OF[id];
    if (!p || !need) return false;
    return need.every(function (s) { return p.steps.some(function (x) { return x.id === s && x.done; }); });
  }
  /* The one clear next step: the first required module, in order, that is open and not complete. */
  function nextStep() {
    var order = ["vr", "ar", "analyzer", "designer", "materials", "feedback", "revision", "final", "exit"];
    for (var i = 0; i < order.length; i++) {
      if (stepDone(order[i])) continue;
      if (available(order[i])) return { module: order[i], label: moduleDef(order[i]).label };
      var st = IELT.state.boot.schema.stages[moduleDef(order[i]).stage];
      return { wait: true, label: st.id + " " + st.name };
    }
    return { module: "certificate", label: "Certificate Center", finished: true };
  }
  IELT.nextStep = nextStep; IELT.available = available; IELT.stepDone = stepDone; IELT.moduleDef = moduleDef;

  function renderParticipantShell() {
    var boot = IELT.state.boot;
    clear(app);
    chrome = {};
    chrome.group = el("span", { class: "chip" });
    var top = el("header", { class: "topbar" }, [
      el("div", { class: "brand" }, [el("h1", { text: TITLE }), el("span", { class: "sub", text: SUBTITLE })]),
      el("div", { class: "who" }, [el("span", {}, ["Signed in as ", el("strong", { text: boot.me.name })]), chrome.group, el("button", { class: "btn onDark", type: "button", text: "Sign out", onclick: signOut })])
    ]);
    chrome.stage = el("span", { class: "value" }); chrome.timer = el("span", { class: "timer small" });
    chrome.progress = el("span", { class: "value" }); chrome.bar = el("span", {});
    chrome.cert = el("span", { class: "value" });
    var status = el("div", { class: "statusbar", role: "region", "aria-label": "Your status" }, [
      el("div", { class: "cell" }, [el("span", { class: "label", text: "Current stage" }), chrome.stage, " ", chrome.timer]),
      el("div", { class: "cell" }, [el("span", { class: "label", text: "Progress" }), chrome.progress, el("div", { class: "bar", "aria-hidden": "true" }, [chrome.bar])]),
      el("div", { class: "cell save-state", id: "saveState", "data-state": "idle", role: "status", "aria-live": "polite" }, [el("span", { class: "label", text: "Save status" }), el("span", { class: "value", text: "Nothing to save yet" })]),
      el("div", { class: "cell" }, [el("span", { class: "label", text: "Certificate" }), chrome.cert])
    ]);
    chrome.navList = el("ol", {});
    chrome.todo = el("div", { class: "todo" });
    chrome.navBody = el("div", { class: "nav-body" }, [el("h2", { text: "Steps" }), chrome.navList, chrome.todo]);
    chrome.navToggle = el("button", { class: "nav-toggle", type: "button", "aria-expanded": "false", onclick: function () {
      var closed = chrome.nav.classList.toggle("closed"); chrome.navToggle.setAttribute("aria-expanded", closed ? "false" : "true");
    } }, [el("span", { text: "Steps and pending tasks" }), el("span", { "aria-hidden": "true", text: "▾" })]);
    chrome.nav = el("nav", { class: "nav closed", "aria-label": "Workshop steps" }, [chrome.navToggle, chrome.navBody]);
    chrome.banner = el("div", {});
    chrome.main = el("main", { id: "main", tabindex: "-1" });
    app.appendChild(top); app.appendChild(status);
    app.appendChild(el("div", { class: "layout" }, [chrome.nav, el("div", {}, [chrome.banner, chrome.main])]));
    if (timerHandle) clearInterval(timerHandle);
    timerHandle = setInterval(tickTimer, 1000);
    refreshChrome();
    var first = IELT.store.get("module");
    go(first && moduleDef(first) && available(first) ? first : "welcome", true);
  }

  function tickTimer() {
    var st = IELT.state.stage;
    if (!chrome.timer || !st) return;
    var left = st.timerEndsAt ? st.timerEndsAt - IELT.serverNow() : 0;
    var text = st.timerEndsAt ? (left > 0 ? IELT.countdown(left) + " left" : "time is up") : "";
    if (chrome.timer.textContent !== text) chrome.timer.textContent = text;
    if (IELT.current && IELT.current.onTick) IELT.current.onTick();
  }

  function refreshChrome() {
    var boot = IELT.state.boot, st = IELT.state.stage, p = IELT.state.progress;
    if (!chrome.stage || !boot) return;
    chrome.stage.textContent = st.id + " " + st.name;
    chrome.group.textContent = boot.group ? "Group " + boot.group.no : "No group yet";
    if (p) {
      chrome.progress.textContent = p.done + " of " + p.total + " steps";
      chrome.bar.style.width = Math.round(100 * p.done / p.total) + "%";
      chrome.cert.textContent = p.eligible ? "Eligible" : "Not yet eligible (" + (p.total - p.done) + " steps left)";
      chrome.cert.className = "value" + (p.eligible ? " cert-yes" : "");
    }
    /* navigation */
    clear(chrome.navList);
    var next = nextStep(), n = 0;
    boot.schema.modules.forEach(function (m) {
      n++;
      var open = available(m.id), done = stepDone(m.id), isNext = next.module === m.id && !next.finished;
      var hint = !open ? "Opens at " + boot.schema.stages[m.stage].id : (done ? "Done" : (isNext ? "Your next step" : ""));
      var btn = el("button", { type: "button", disabled: !open, "aria-current": IELT.state.module === m.id ? "page" : undefined, onclick: function () { go(m.id); } }, [
        el("span", { class: "mark", "aria-hidden": "true", text: done ? "✓" : String(n) }),
        el("span", {}, [m.label, hint ? el("span", { class: "hint", text: hint }) : null])
      ]);
      chrome.navList.appendChild(el("li", { class: (done ? "done" : "") + (isNext ? " now" : "") }, [btn]));
    });
    /* pending tasks */
    clear(chrome.todo);
    chrome.todo.appendChild(el("h2", { text: "Pending tasks" }));
    var pending = p ? p.pending : [];
    if (!pending.length) chrome.todo.appendChild(el("p", { class: "small muted", text: p && p.eligible ? "Everything is complete." : "Nothing is waiting for you at this stage." }));
    else chrome.todo.appendChild(el("ul", {}, pending.map(function (t) { return el("li", {}, [t.label, el("small", { text: "Missing: " + t.missing.join(", ") })]); })));
    if (IELT.current && IELT.current.onChrome) IELT.current.onChrome();
  }
  IELT.refreshChrome = refreshChrome;
  IELT.setProgress = function (p) { if (p) { IELT.state.progress = p; refreshChrome(); } };

  /* ---------- module switching ---------- */
  function go(id, quiet) {
    var def = moduleDef(id);
    if (!def || !IELT.modules[id]) return;
    if (IELT.current && IELT.current.onLeave) { try { IELT.current.onLeave(); } catch (e) { IELT.reportError(IELT.state.module, e); } }
    IELT.current = null;
    IELT.state.module = id; IELT.store.set("module", id);
    clear(chrome.main);
    clear(chrome.banner);
    if (!chrome.nav.classList.contains("closed")) { chrome.nav.classList.add("closed"); chrome.navToggle.setAttribute("aria-expanded", "false"); }
    var head = el("h2", { tabindex: "-1", text: def.label });
    chrome.main.appendChild(head);
    var body = el("div", {});
    chrome.main.appendChild(body);
    if (!available(id)) {
      var s = IELT.state.boot.schema.stages[def.stage];
      body.appendChild(el("div", { class: "card notice" }, [el("p", { text: "This step opens at stage " + s.id + " " + s.name + ". The facilitator opens the stages during the workshop." })]));
    } else {
      try { IELT.modules[id].render(body); } catch (e) { IELT.reportError(id, e); body.appendChild(IELT.message("error", "This page could not be shown. Reload the page and try again.")); }
    }
    chrome.nextBox = el("div", {});
    chrome.main.appendChild(chrome.nextBox);
    renderNext();
    refreshChrome();
    if (!quiet) { head.focus(); window.scrollTo(0, 0); }
  }
  IELT.go = go;
  function renderNext() {
    if (!chrome.nextBox) return;
    clear(chrome.nextBox);
    var next = nextStep(), here = IELT.state.module;
    if (next.wait) chrome.nextBox.appendChild(el("div", { class: "next" }, [el("p", { text: "You are up to date. The next step opens at stage " + next.label + "." })]));
    else if (next.module !== here) chrome.nextBox.appendChild(el("div", { class: "next" }, [
      el("p", {}, [next.finished ? "All nine steps are complete." : "Your next step: ", next.finished ? null : el("strong", { text: next.label })]),
      el("button", { class: "btn primary", type: "button", text: next.finished ? "Go to the Certificate Center" : "Continue to " + next.label, onclick: function () { go(next.module); } })]));
  }
  IELT.renderNext = renderNext;

  /* ---------- polling results ---------- */
  var lastBootRefresh = 0;
  IELT.onPoll = function (res) {
    var boot = IELT.state.boot;
    if (!boot) return;
    var before = IELT.state.stage;
    IELT.state.stage = res.stage;
    if (boot.me.role !== "participant") { if (IELT.onAdminPoll) IELT.onAdminPoll(res); return; }
    if (res.progress) IELT.state.progress = res.progress;
    var needBoot = (res.groupStamp !== undefined && res.groupStamp !== boot.groupStamp) || res.progressStale;
    if (needBoot && Date.now() - lastBootRefresh > 60000 * (res.progressStale ? 2 : 0.2)) { lastBootRefresh = Date.now(); setTimeout(function () { refreshBoot().then(renderNext, function () {}); }, Math.random() * 4000); }
    if (before && res.stage.seq !== before.seq) stageChanged(before, res.stage);
    refreshChrome();
    renderNext();
    if (IELT.current && IELT.current.onPoll) { try { IELT.current.onPoll(res); } catch (e) { IELT.reportError(IELT.state.module, e); } }
  };
  function stageChanged(before, now) {
    IELT.announce("Stage " + now.id + " " + now.name + " is now open.");
    if (!chrome.banner) return;
    clear(chrome.banner);
    var next = nextStep();
    var here = IELT.state.module;
    var card = el("div", { class: "card notice", role: "status" }, [el("p", {}, [el("strong", { text: "Stage " + now.id + " " + now.name + " is now open. " }),
      next.module && next.module !== here && !next.finished ? "Finish what you are doing, then continue." : ""])]);
    if (next.module && next.module !== here && !next.finished) card.appendChild(el("button", { class: "btn primary", type: "button", text: "Go to " + next.label, onclick: function () { go(next.module); } }));
    chrome.banner.appendChild(card);
    /* a module that was waiting for this stage is shown now */
    if (moduleDef(here) && moduleDef(here).stage > before.maxIndex && moduleDef(here).stage <= now.maxIndex) go(here, true);
  }
  IELT.onSiteProgress = function (kind, p) { if (IELT.current && IELT.current.onSiteProgress) IELT.current.onSiteProgress(kind, p); };

  /* ---------- start ---------- */
  IELT.start = function () {
    var skip = document.querySelector("a.skip-link");
    /* The skip link moves focus itself: inside the Apps Script frame a "#main" address is not a reliable target. */
    if (skip) skip.addEventListener("click", function (ev) { var m = document.getElementById("main"); if (m) { ev.preventDefault(); if (!m.hasAttribute("tabindex")) m.setAttribute("tabindex", "-1"); m.focus(); } });
    var token = IELT.store.get("token");
    if (!token) { renderSignIn(); return; }
    IELT.state.token = token;
    clear(app);
    app.appendChild(el("p", { class: "card", role: "status", text: "Loading…" }));
    api("apiBootstrap", undefined, {}).then(enter, function (err) { if (IELT.state.token) { IELT.state.token = ""; IELT.store.del("token"); renderSignIn(err && err.code === "NETWORK" ? err.message : ""); } });
  };
})();

/* ===== start ===== */
/* The portal is never shown inside another site's frame. */
if (window.top === window.self) window.IELT.start();
else document.getElementById("app").textContent = "Open the portal in its own browser tab.";

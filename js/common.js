/* Shared helpers for the VR viewer, the AR app and the accessible alternatives. */
(function () {
  "use strict";
  var C = window.IELT_CONFIG || {};
  var TYPE_LABEL = { listen: "Listen", look: "Look", language: "Language", decide: "Decide", lens: "Teacher lens", go: "Go", live: "Live information", audio: "Listen", note: "Look" };

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "class") n.className = attrs[k];
      else if (k === "text") n.textContent = attrs[k];
      else if (k.indexOf("on") === 0) n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }
  function qs(name) { return new URLSearchParams(location.search).get(name); }
  function store(key, value) {
    try {
      if (value === undefined) { var v = sessionStorage.getItem(key); return v ? JSON.parse(v) : null; }
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch (e) { /* storage can be unavailable; progress then lives in memory only */ }
    return null;
  }

  /* Audio block with transcript. Audio never autoplays. */
  function audioBlock(audioId) {
    var a = (window.CITY.audio || {})[audioId];
    if (!a) return null;
    var wrap = el("div", { class: "audio-block" });
    var player = el("audio", { controls: "", preload: "none", src: window.CITY.audioBase + a.file, "aria-label": a.title });
    player.addEventListener("error", function () {
      wrap.insertBefore(el("p", { class: "small", role: "status", text: "The audio file could not be loaded. Please use the transcript below." }), wrap.firstChild);
    });
    wrap.appendChild(player);
    var det = el("details", { class: "transcript" }, [el("summary", { text: "Show transcript" })]);
    a.transcript.forEach(function (line) { det.appendChild(el("p", null, [el("b", { text: line[0] + ": " }), line[1]])); });
    wrap.appendChild(det);
    wrap.appendChild(el("p", { class: "small", text: a.speakers + " · about CEFR " + a.cefr + " · synthetic voice" }));
    return wrap;
  }

  /* Detail content for a VR hotspot or an AR overlay item. */
  function detail(item, opts) {
    opts = opts || {};
    var type = item.type || item.kind;
    var box = el("div", { class: "detail" });
    box.appendChild(el("span", { class: "badge t-" + type, text: TYPE_LABEL[type] || type }));
    var h = el("h2", { tabindex: "-1", text: item.title || item.label });
    box.appendChild(h);
    if (item.text) box.appendChild(el("p", { text: item.text }));
    if (item.table) {
      var t = el("table", { class: "tt" });
      t.appendChild(el("caption", { class: "sr-only", text: item.title }));
      var hr = el("tr"); item.table.head.forEach(function (x) { hr.appendChild(el("th", { scope: "col", text: x })); });
      t.appendChild(el("thead", null, [hr]));
      var tb = el("tbody");
      item.table.rows.forEach(function (r) { var tr = el("tr"); r.forEach(function (x) { tr.appendChild(el("td", { text: x })); }); tb.appendChild(tr); });
      t.appendChild(tb); box.appendChild(t);
    }
    if (item.audio) box.appendChild(audioBlock(item.audio));
    if (item.phrases) {
      var ul = el("ul", { class: "phrases" });
      item.phrases.forEach(function (p) { ul.appendChild(el("li", { text: p })); });
      box.appendChild(ul);
    }
    if (item.task) {
      var lens = type === "lens";
      box.appendChild(el("div", { class: "task" + (lens ? " lens" : "") }, [
        el("h4", { text: lens ? "Think as a teacher" : "Learner task" }), el("p", { text: item.task })]));
    }
    if (opts.extra) box.appendChild(opts.extra);
    return { node: box, heading: h };
  }

  /* Report progress to the portal (embedded iframe or opener tab). Only counts and ids, never personal data. */
  function report(kind, payload) {
    var msg = Object.assign({ source: "ielt-site", kind: kind, siteVersion: C.siteVersion || "" }, payload || {});
    try { if (window.parent && window.parent !== window) window.parent.postMessage(msg, "*"); } catch (e) {}
    try { if (window.opener && !window.opener.closed) window.opener.postMessage(msg, "*"); } catch (e) {}
  }

  function checkpointBox(word, what) {
    return el("div", { class: "checkpoint", role: "status" }, [
      el("strong", { text: what + " complete. " }),
      el("span", { text: "Your checkpoint word is" }), el("br"),
      el("span", { class: "word", text: word }), el("br"),
      el("span", { text: "Type this word into the Immersive ELT Design Lab portal to record this step." })
    ]);
  }

  window.IELT = { el: el, qs: qs, store: store, audioBlock: audioBlock, detail: detail, report: report, checkpointBox: checkpointBox, TYPE_LABEL: TYPE_LABEL, config: C };
})();

/*
 * transport.js: the connection layer of the copy of the portal page that is served from the project site.
 *
 * The portal client (portal.js, the same code that the Apps Script web app serves) reaches the server
 * through google.script.run. That interface exists only inside a page served by Apps Script. This file
 * gives the page an object with the same interface, built on plain requests to the web app's JSON door
 * (doPost in Participant.gs): a text/plain POST with { fn, args }, answered with the endpoint's JSON text.
 *
 * The requests are sent without credentials, so no Google cookie travels with them and the answer does
 * not depend on which Google accounts are signed in to the browser. The session is the portal's own
 * token, which the client passes as an argument exactly as before.
 *
 * The endpoint list below is written by tools/build_static_portal.py from the server sources.
 */
(function () {
  "use strict";
  var cfg = window.IELT_PORTAL || {};
  var EXEC = typeof cfg.execUrl === "string" ? cfg.execUrl : "";
  var ENDPOINTS = ["apiAcquireLease", "apiAdminAssignGroups", "apiAdminAuditLog", "apiAdminCertificateLog", "apiAdminCorrectName", "apiAdminErrorLog", "apiAdminGetSettings", "apiAdminGrantReissue", "apiAdminImportRoster", "apiAdminIssueCodes", "apiAdminListParticipants", "apiAdminMoveParticipant", "apiAdminOpenStage", "apiAdminOverview", "apiAdminPurgeWithdrawn", "apiAdminRecordException", "apiAdminResearchExport", "apiAdminResearchSummary", "apiAdminResetStage", "apiAdminSaveSettings", "apiAdminSetGroupModality", "apiAdminTemplateActivate", "apiAdminTemplateChunks", "apiAdminTemplateList", "apiAdminTemplateSaveConfig", "apiAdminTemplateUploadChunks", "apiAdminTemplateUploadFinish", "apiAdminTemplateUploadStart", "apiAdminUpdateParticipant", "apiBootstrap", "apiCheckIn", "apiConsentDecision", "apiGetCertificateChunks", "apiGetCertificatePackage", "apiGetDraft", "apiGetReviewTarget", "apiGetRevisionContext", "apiLogin", "apiLogout", "apiPoll", "apiPublicInfo", "apiRegister", "apiReleaseLease", "apiReportCertificateFailure", "apiReportCertificateIssued", "apiReportError", "apiResearchState", "apiSaveDraft", "apiSaveRevision", "apiStartTask", "apiSubmitAnalyzer", "apiSubmitBackground", "apiSubmitCheckpoint", "apiSubmitExitTicket", "apiSubmitFeedback", "apiSubmitReflection", "apiSubmitScale", "apiSubmitTask", "apiSubmitV1", "apiSubmitV2"];

  function send(name, args, ok, fail) {
    var body;
    try {
      if (!EXEC) throw new Error("The address of the portal service is not set (config.js).");
      body = JSON.stringify({ fn: name, args: args });
    } catch (e) { if (fail) fail(e); return; }
    window.fetch(EXEC, { method: "POST", mode: "cors", credentials: "omit", cache: "no-store", redirect: "follow", referrerPolicy: "no-referrer",
      headers: { "Content-Type": "text/plain;charset=utf-8" }, body: body })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
      .then(function (text) { if (ok) ok(text); }, function (err) { if (fail) fail(err || new Error("The request failed.")); });
  }

  function Runner(ok, fail) { this._ok = ok; this._fail = fail; }
  Runner.prototype.withSuccessHandler = function (f) { return new Runner(f, this._fail); };
  Runner.prototype.withFailureHandler = function (f) { return new Runner(this._ok, f); };
  ENDPOINTS.forEach(function (name) {
    Runner.prototype[name] = function () { send(name, Array.prototype.slice.call(arguments), this._ok, this._fail); };
  });

  window.google = { script: { run: new Runner(null, null) } };
})();

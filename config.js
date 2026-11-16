/*
 * Site configuration. Edit before publishing.
 * checkpoints: participation checkpoint words. They are NOT secrets and carry no personal data.
 *   The same four words must be set in the portal (Admin > Settings > Checkpoint words).
 *   The portal records which word was entered, so the access mode (VR / static alternative,
 *   camera AR / non-camera alternative) is documented for every participant.
 * portalUrl: optional. The Apps Script web app URL, used only for "Return to the portal" links.
 */
window.IELT_CONFIG = {
  checkpoints: { vr: "COMPASS", vrAlt: "ATLAS", ar: "LANTERN", arAlt: "BEACON" },
  portalUrl: "",
  siteVersion: "1.2.0"
};

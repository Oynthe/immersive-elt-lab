/*
 * Site configuration. Edit before publishing.
 * checkpoints: participation checkpoint words. They are NOT secrets and carry no personal data.
 *   The same four words must be set in the portal (Admin > Settings > Checkpoint words).
 *   The portal records which word was entered, so the access mode (VR / static alternative,
 *   camera AR / non-camera alternative) is documented for every participant.
 * portalUrl: the address of the workshop portal page (folder portal/ of this site), for "Return to the portal" links.
 *   The portal page talks to the Apps Script web app named in portal/config.js.
 */
window.IELT_CONFIG = {
  checkpoints: { vr: "COMPASS", vrAlt: "ATLAS", ar: "LANTERN", arAlt: "BEACON" },
  portalUrl: "https://oynthe.github.io/immersive-elt-lab/portal/",
  siteVersion: "1.3.1"
};

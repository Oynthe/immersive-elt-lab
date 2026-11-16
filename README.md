# Immersive ELT Design Lab: media site

Static site for the workshop **Designing Immersive ELT Tasks: From VR and AR to Pedagogy**.

- `vr/` The Virtual City Experience: three connected 360° scenes in a custom Pannellum viewer (no headset needed).
- `ar/` The Augmented City Experience: camera-based image-target AR (MindAR with three.js) on three printed pages, plus a page that shows the targets with a QR code.
- `alt/` Accessible alternatives: a static version of the scenes and a non-camera walkthrough of the AR content (labelled as not AR).
- `targets/` Printable targets.
- `content/city.js` Single content source for scenes, hotspots, overlays and transcripts.
- `config.js` Checkpoint words and the optional portal URL.
- Reference view: `vr/index.html?free=1&scene=<visitor-centre|central-station|museum>` opens a scene with every point open, no lock and no checkpoint word. It reports nothing and does not count as the tour.
- Tour length: `content/city.js`, `vrCompletion.requiredIds` lists the steps that stay required and in order; other points become optional extras.

Lindenbrück, its services and its museum collection are fictional. Panoramas, photographs and the 3D object are AI-generated; voices are synthetic. The site sets no cookies, collects no personal data, and processes the camera image on the device only.

Open-source components (MIT): Pannellum 2.5.7, MindAR 1.2.5, three.js r160, qrcode-generator 2.0.4, pdf-lib 1.17.1, @pdf-lib/fontkit 1.1.1. PDF.js (Apache License 2.0) is used by the portal's administrator view to preview a certificate template. Fonts under the SIL Open Font License. Licence texts are in `vendor/licenses` and `assets/fonts`.

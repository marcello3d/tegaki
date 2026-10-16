# Tegaki (vendored build)

Static build of the 2draw branch of tegaki.js (MIT, by Maxime Youdine):
upstream https://github.com/desuwa/tegaki, patched on a local `2draw` branch.
`VERSION` has the upstream commit and the patch commit it was built from;
`TEGAKI_BUILD` in `worker/src/lib/applet.ts` must match the patch commit.

Built with `node 2draw/build.mjs` in the fork (writes `dist-2draw/`).

- `index.html?w=&h=[&anim=][&load=]`: the editor, embedded by lib/applet.ts
  `tegakiEmbedHtml` as an iframe. Submit calls
  `window.parent.tegakiHost.submit(pngBlob, { animation: tgkrBlob })`.
  `anim` is the previous version's `.tgkr`: it is replayed into the editor and
  the new recording continues it.
- `replay.html`: the replay engine `player.js` runs in a hidden iframe.
- `player.js`: `window.TegakiPlayer`, the inline animation strip's player
  (the LascauxClassicPlayer interface: ready, duration, currentTime,
  isPlaying, seeking, play, pause, seek, setSpeed, destroy).

To update: build in the fork, replace this directory with `dist-2draw/`,
bump `TEGAKI_BUILD`.

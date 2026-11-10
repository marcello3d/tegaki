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
- `&draft=<key>`: the 2draw draft key. `tegaki-draft.js` keeps a copy of the
  drawing in progress on this device (IndexedDB `2draw-tegaki-drafts`) under
  it and restores it on the next load, ahead of `anim` and `load`; the
  draw page's bar shows "Saved on this device" and its Close asks nothing
  once saved. It saves 0.7 s after the first change since the last save
  (later changes don't put it off; a save due mid-stroke runs as the pen
  lifts), because on iOS a write begun as the page is left never runs: a page
  going into WebKit's back/forward cache starts none, and saves what it held
  when shown again. Every IndexedDB transaction commits at once.
  Test: `node 2draw/build.mjs && node 2draw/test-autosave.mjs`
  (`PLAYWRIGHT_CHANNEL=chrome` if 2draw.net's playwright-core has no browser).
- `replay.html`: the replay engine `player.js` runs in a hidden iframe.
- `player.js`: `window.TegakiPlayer`, the inline animation strip's player
  (the LascauxClassicPlayer interface: ready, duration, currentTime,
  isPlaying, seeking, play, pause, seek, setSpeed, destroy).

To update: build in the fork, replace this directory with `dist-2draw/`,
bump `TEGAKI_BUILD`.

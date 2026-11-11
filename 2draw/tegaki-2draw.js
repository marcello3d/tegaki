// tegaki.js on 2draw.net: the editor page (index.html) and the replay engine
// page (replay.html, driven by player.js). Both run inside an iframe of the
// 2draw page, so Tegaki (a page-wide singleton) has a document to itself.
//
// Editor: index.html?w=<width>&h=<height>[&anim=<.tgkr URL>][&load=<.png URL>]
//   - anim: the drawing's recording. It is replayed into the editor and the
//     new recording continues it, so the animation stays complete.
//   - load: the drawing's picture, used when there is no recording (it goes
//     onto the first layer, and this session is not recorded).
//   - draft: the 2draw draft key. A copy of the drawing in progress is kept
//     on this device under it (tegaki-draft.js) and restored on the next
//     load, ahead of anim and load.
//   Submit hands the PNG and the recording to window.parent.tegakiHost.submit
//   (lib/applet.ts tegakiEmbedHtml), which uploads them and leaves the page.
//   extra.uploaded(), which the host calls once the server has the drawing,
//   deletes the device copy.
//
//   With a draft key it also sets, on the (same-origin) parent, as JSPaint.exe
//   and Lascaux Pocket do (2draw.net client/draw-bar.ts, applet-boot.ts):
//     tegakiHost.draftSaved({at} | {failed: true})  the bar's "Saved on this
//                            device" / "Not saved" line
//     drawPersists: boolean  the drawing is kept on this device: Close asks
//                            nothing
//     drawUnchanged: boolean nothing drawn: leaving loses nothing
//     drawGuard(on)          the parent's leave warning: on while leaving
//                            would lose something
//     drawFlush(): Promise   saves now (Close waits for it, 2 s at most)
//     drawOnDiscard[]        the draft's Discard deletes the copy too
//
// Replay engine: window.tegakiReplay (see the bottom of this file).
(function () {
  "use strict";

  var REPLAY = document.documentElement.getAttribute("data-mode") === "replay";

  function params() {
    var q = new URLSearchParams(location.search);
    return {
      width: Math.max(1, Math.min(8192, parseInt(q.get("w"), 10) || 400)),
      height: Math.max(1, Math.min(8192, parseInt(q.get("h"), 10) || 400)),
      anim: q.get("anim"),
      load: q.get("load"),
      draft: window.TegakiDraft && TegakiDraft.validKey(q.get("draft")) ? q.get("draft") : null,
    };
  }

  function host() {
    try {
      return window.parent !== window ? window.parent.tegakiHost : null;
    } catch (e) {
      return null;
    }
  }

  // --- editor -------------------------------------------------------------

  function notice(text) {
    var el = document.getElementById("tegaki-2draw-notice");
    if (!el) {
      el = document.createElement("div");
      el.id = "tegaki-2draw-notice";
      el.setAttribute("role", "status");
      document.body.appendChild(el);
    }
    el.textContent = text || "";
    el.hidden = !text;
  }

  function fetchBytes(url) {
    return fetch(url, { mode: "cors", credentials: "omit" }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.arrayBuffer();
    });
  }

  function loadImage(url) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error("could not load the picture")); };
      img.src = url;
    });
  }

  /** restored: the device copy this session continues ({meta}), or null.
   * Returns a promise: the recording (continueReplay, the bytes of a .tgkr)
   * replayed into it, true (rejects if it can't be read or replayed; false
   * if the editor was closed first). Without one the editor is open on
   * return. */
  function openEditor(p, continueReplay, record, restored) {
    if (!continueReplay) {
      openNow(p, null, record, restored);
      return Promise.resolve(true);
    }
    // Read in slices, then replayed in slices (tegaki.js TegakiReplayRunner),
    // so the page never freezes; nothing can be drawn meanwhile.
    showReplaying();
    return TegakiReplayRunner.load(continueReplay).then(function (viewer) {
      openNow(p, viewer, record, restored);
      var replayed = Tegaki.replayDone || Promise.resolve(true);
      replayed.then(hideReplaying, hideReplaying);
      return replayed;
    }, function (err) {
      hideReplaying();
      throw err;
    });
  }

  function openNow(p, viewer, record, restored) {
    // Inside 2draw the draw page warns before leaving unsaved work; a second
    // warning from this frame would only stack another prompt on it.
    if (host()) Tegaki.onTabClose = function () {};
    Tegaki.open({
      width: p.width,
      height: p.height,
      saveReplay: record,
      continueReplay: viewer || undefined,
      replayAsync: true,
      onReplayProgress: replayProgress,
      onDone: onDone,
      onCancel: function () {},
    });
    if (Tegaki.replaying && Tegaki.bg) Tegaki.bg.inert = true;
    customizeMenu();
    if (!record) {
      // (its indicator only exists while recording: without the guard a
      // revision from a picture never got its picture)
      try {
        TegakiUI.setRecordingStatus(false);
      } catch (e) {}
    }
    fitZoom();
    installPanelToggle();
    installTouchGestures();
    if (p.draft) startSaver(p, record ? "record" : "picture", restored || null);
  }

  // --- while a recording is replayed into the editor ----------------------
  // Nothing can be drawn or changed until it's done (tegaki.js ignores the
  // pen and keys meanwhile; this covers the rest of the UI), and after a
  // moment a small box says how far it has got. The picture builds up
  // behind it.

  var replayBoxTimer = 0;

  function showReplaying() {
    var cover = document.getElementById("tegaki-2draw-replaying");
    if (!cover) {
      cover = document.createElement("div");
      cover.id = "tegaki-2draw-replaying";
      cover.innerHTML = '<div class="tegaki-2draw-replaying-box" role="status" hidden>Opening the drawing… <span class="tegaki-2draw-replaying-pct"></span><div class="tegaki-2draw-replaying-bar"><div></div></div></div>';
      ["pointerdown", "pointerup", "click", "dblclick", "contextmenu", "touchstart", "keydown"].forEach(function (type) {
        cover.addEventListener(type, function (e) {
          e.stopPropagation();
          if (type !== "touchstart") e.preventDefault();
        });
      });
      document.body.appendChild(cover);
    }
    cover.hidden = false;
    if (Tegaki.bg) Tegaki.bg.inert = true;
    clearTimeout(replayBoxTimer);
    replayBoxTimer = setTimeout(function () {
      var box = cover.querySelector(".tegaki-2draw-replaying-box");
      if (box) box.hidden = false;
    }, 400);
  }

  function replayProgress(fraction) {
    var cover = document.getElementById("tegaki-2draw-replaying");
    if (!cover) return;
    var pct = Math.floor(fraction * 100);
    var bar = cover.querySelector(".tegaki-2draw-replaying-bar > div");
    var label = cover.querySelector(".tegaki-2draw-replaying-pct");
    if (bar) bar.style.width = pct + "%";
    if (label) label.textContent = pct + "%";
  }

  function hideReplaying() {
    clearTimeout(replayBoxTimer);
    var cover = document.getElementById("tegaki-2draw-replaying");
    if (cover) cover.remove();
    if (Tegaki.bg) Tegaki.bg.inert = false;
  }

  // --- the copy on this device (tegaki-draft.js) ---------------------------

  /** @type {any} TegakiDraft.Saver, with a draft key */
  var saver = null;
  /** another tab took the drawing over */
  var yielded = false;
  /** something was drawn (or changed) since the editor opened */
  var touched = false;

  /** The same-origin 2draw page, or null. */
  function parentPage() {
    try {
      if (window.parent !== window && window.parent.location.origin === location.origin) return window.parent;
    } catch (e) {}
    return null;
  }

  function announce(info) {
    var h = host();
    try {
      if (h && typeof h.draftSaved === "function") h.draftSaved(info);
    } catch (e) {}
  }

  var shownLeave = "";
  /** The parent's leave question: asked only while leaving would lose
   * something. */
  function syncLeave() {
    var page = parentPage();
    if (!page || !saver) return;
    var s = saver.state();
    var persists = s.saved || s.yielded;
    var unchanged = !saver.everSaved && !touched;
    var guard = !s.yielded && (s.pending || (!persists && !unchanged));
    var k = persists + "|" + unchanged + "|" + guard;
    if (k === shownLeave) return;
    shownLeave = k;
    try {
      page.drawPersists = persists;
      page.drawUnchanged = unchanged;
      if (typeof page.drawGuard === "function") page.drawGuard(guard);
    } catch (e) {
      console.error("[autosave] couldn't tell the page", e);
    }
  }

  /** A small picture (256 px on the long side): WebP, or JPEG where the
   * browser can't make WebP. */
  function thumbnail(canvas) {
    var scale = Math.min(1, 256 / Math.max(canvas.width, canvas.height, 1));
    var c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(canvas.width * scale));
    c.height = Math.max(1, Math.round(canvas.height * scale));
    var g = c.getContext("2d");
    if (!g) return Promise.resolve(null);
    g.fillStyle = "#fff";
    g.fillRect(0, 0, c.width, c.height);
    g.imageSmoothingQuality = "high";
    g.drawImage(canvas, 0, 0, c.width, c.height);
    function as(type, q) {
      return new Promise(function (res) { c.toBlob(res, type, q); });
    }
    return as("image/webp", 0.8).then(function (b) { return b && b.type === "image/webp" ? b : as("image/jpeg", 0.85); });
  }

  function startSaver(p, mode, restored) {
    if (yielded) return;
    try {
      var first = true;
      saver = new TegakiDraft.Saver({
        key: p.draft,
        width: Tegaki.baseWidth,
        height: Tegaki.baseHeight,
        mode: mode,
        restored: restored,
        onsaved: function (info) {
          announce({ at: info.at });
          if (first) {
            first = false;
            TegakiDraft.requestPersistentStorage();
          }
        },
        onfailed: function () { announce({ failed: true }); },
        onstate: function () { syncLeave(); },
      });
      window.tegakiSaver = saver;
      // Every recorded change (strokes, undo, colours, layers) goes through
      // Tegaki.recordEvent, recording or not.
      var record = Tegaki.recordEvent;
      Tegaki.recordEvent = function () {
        var r = record.apply(this, arguments);
        // (replaying the drawing changes nothing: it is what is saved)
        if (Tegaki.replaying) return r;
        touched = true;
        if (saver) saver.changed();
        syncLeave();
        return r;
      };
      var page = parentPage();
      if (page) {
        page.drawFlush = function () { return saver ? saver.flush() : Promise.resolve(); };
        page.drawOnDiscard = (page.drawOnDiscard || []).concat([function () { return saver ? saver.delete() : Promise.resolve(); }]);
        // the picture for the lists of unsaved drawings (draw-bar.ts cloudThumb)
        page.drawThumb = function () {
          // (of the whole drawing, once it is replayed)
          return Promise.resolve(Tegaki.replayDone).catch(function () {}).then(function () { return thumbnail(Tegaki.flatten()); });
        };
      }
      if (restored) announce({ at: restored.meta.saved || Date.now() });
      syncLeave();
    } catch (e) {
      console.error("[autosave] couldn't start", e);
      saver = null;
    }
  }

  /** Another tab took this drawing over: cover the editor; Continue here
   * takes it back. */
  function onTaken() {
    yielded = true;
    showTakenCover();
    return (saver ? saver.yieldEdit() : Promise.resolve()).then(syncLeave);
  }

  function showTakenCover() {
    if (document.getElementById("tegaki-2draw-taken")) return;
    var cover = document.createElement("div");
    cover.id = "tegaki-2draw-taken";
    cover.setAttribute("role", "dialog");
    cover.setAttribute("aria-modal", "true");
    var card = document.createElement("div");
    card.className = "tegaki-2draw-taken-card";
    var title = document.createElement("p");
    title.className = "tegaki-2draw-taken-title";
    title.textContent = "This drawing is open in another tab.";
    var words = document.createElement("p");
    words.textContent = "Drawing saved on this device.";
    var button = document.createElement("button");
    button.type = "button";
    button.textContent = "Continue here";
    button.addEventListener("click", function () {
      button.disabled = true;
      location.reload();
    });
    card.appendChild(title);
    card.appendChild(words);
    card.appendChild(button);
    cover.appendChild(card);
    ["pointerdown", "pointermove", "pointerup", "touchstart", "wheel", "keydown", "contextmenu"].forEach(function (type) {
      cover.addEventListener(type, function (e) {
        if (e.target === button) return;
        e.stopPropagation();
        if (type !== "pointermove" && type !== "touchstart" && type !== "wheel") e.preventDefault();
      });
    });
    document.body.appendChild(cover);
    button.focus();
  }

  function reportError(message, err) {
    try {
      if (typeof window.reportClientError === "function") window.reportClientError(message, err);
    } catch (e) {}
  }

  /** No New / Open (they change the canvas size or drop the recording) and
   * no Close (the 2draw page has its own way out); Finish is Submit. */
  function customizeMenu() {
    var drop = [TegakiStrings.newCanvas, TegakiStrings.open, TegakiStrings.close];
    var btns = document.querySelectorAll("#tegaki-menu-bar .tegaki-mb-btn");
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].id !== "tegaki-finish-btn" && drop.indexOf(btns[i].textContent) >= 0) btns[i].remove();
    }
    var finish = document.getElementById("tegaki-finish-btn");
    if (finish) {
      finish.textContent = "Submit";
      finish.title = "Send the drawing to 2draw";
    }
  }

  /** The largest zoom step (at most 100%) at which the canvas fits. */
  function fitZoom() {
    var cnt = Tegaki.canvasCnt;
    var pad = 16;
    var w = cnt.clientWidth - pad, h = cnt.clientHeight - pad;
    if (w <= 0 || h <= 0) return;
    var fit = Math.min(w / Tegaki.baseWidth, h / Tegaki.baseHeight, 1);
    var level = 0;
    for (var i = 0; i < Tegaki.zoomFactorList.length; i++) {
      if (Tegaki.zoomFactorList[i] <= fit + 1e-6) level = i - Tegaki.zoomBaseLevel;
    }
    if (level !== Tegaki.zoomLevel) {
      Tegaki.setZoom(level);
      TegakiCursor.updateCanvasSize();
    }
  }

  /** Phones: the right-hand panel (zoom, colour, size, layers) is a drawer
   * that a menu button opens. */
  function installPanelToggle() {
    var bar = document.getElementById("tegaki-menu-bar");
    if (!bar) return;
    var btn = document.createElement("span");
    btn.className = "tegaki-mb-btn tegaki-2draw-panel-btn";
    btn.textContent = "Colors & layers";
    btn.setAttribute("role", "button");
    btn.addEventListener("click", function () {
      var on = Tegaki.bg.classList.toggle("tegaki-2draw-panel-open");
      btn.classList.toggle("tegaki-2draw-on", on);
      TegakiCursor.updateCanvasSize();
    });
    bar.insertBefore(btn, bar.firstChild);
    // Picking a colour closes the drawer again.
    var grids = document.getElementById("tegaki-color-grids");
    if (grids) {
      grids.addEventListener("click", function () {
        if (Tegaki.bg.classList.contains("tegaki-2draw-panel-open") && isPhoneLayout()) btn.click();
      });
    }
  }

  function isPhoneLayout() {
    var b = document.querySelector(".tegaki-2draw-panel-btn");
    return !!b && getComputedStyle(b).display !== "none";
  }

  /**
   * Touch: one finger draws; two fingers pan and pinch-zoom, and never draw.
   *
   * A touch that lands on the canvas is held back for a moment (or until it
   * moves) before it is handed to Tegaki, so that a second finger arriving
   * meanwhile makes a gesture without even a flash of ink, and a fill or a
   * colour pick never fires. A second finger after that ends the first
   * finger's stroke: it is kept if it began at least KEEP_MS ago (it was
   * meant), and otherwise dropped without a trace: its pixels come back off
   * the layer, it is no undo or redo step, and its events leave the .tgkr
   * recording. The gesture lasts until every finger is up, so a finger left
   * down does not draw. Pens and mice are not affected, and a touch during a
   * pen or mouse stroke is ignored (a palm).
   */
  function installTouchGestures() {
    var cursor = TegakiCursor.getCanvas();
    var cnt = Tegaki.canvasCnt;
    var HOLD_MS = 90, SLOP = 8, KEEP_MS = 500;
    var touches = new Map();
    /** The first touch, held back: { down, moves, timer }. */
    var pending = null;
    /** The touch stroke Tegaki is drawing: { id, t0, events, pressure }. */
    var stroke = null;
    /** Pan and pinch, from the second finger until every finger is up. */
    var gesture = null;

    function stop(e) {
      e.stopImmediatePropagation();
      e.preventDefault();
    }
    function commitPending() {
      if (!pending) return;
      var p = pending;
      pending = null;
      clearTimeout(p.timer);
      var rec = Tegaki.replayRecorder;
      // where the stroke starts, to take it back if a second finger follows
      var mark = {
        id: p.down.pointerId,
        t0: p.down.timeStamp,
        events: rec ? rec.events.length : 0,
        pressure: [TegakiPressure.pressureNow, TegakiPressure.pressureThen],
      };
      Tegaki.onPointerDown(p.down);
      stroke = Tegaki.isPainting ? mark : null;
      for (var i = 0; i < p.moves.length; i++) Tegaki.onPointerMove(p.moves[i]);
    }
    function isDrawEvent(ev) {
      return ev instanceof TegakiEventDrawStart || ev instanceof TegakiEventDrawStartNoP
        || ev instanceof TegakiEventDraw || ev instanceof TegakiEventDrawNoP;
    }
    /** A second finger landed while a touch stroke was being drawn. */
    function endStroke(e) {
      var s = stroke;
      stroke = null;
      if (e.timeStamp - s.t0 >= KEEP_MS) {
        // as if the finger had lifted
        Tegaki.onPointerUp({ pointerId: s.id, timeStamp: e.timeStamp });
        return;
      }
      var action = TegakiHistory.pendingAction;
      Tegaki.isPainting = false;
      TegakiHistory.pendingAction = null;
      if (action && action.imageDataBefore) {
        var layer = TegakiLayers.getLayerById(action.layerId);
        if (layer) {
          layer.ctx.putImageData(action.imageDataBefore, 0, 0);
          TegakiLayers.syncLayerImageData(layer, action.imageDataBefore);
          TegakiUI.updateLayerPreview(layer);
        }
      }
      Tegaki.clearBuffers();
      TegakiPressure.pressureNow = s.pressure[0];
      TegakiPressure.pressureThen = s.pressure[1];
      var rec = Tegaki.replayRecorder;
      if (rec && rec.events.length > s.events) {
        // The stroke's drawing events go; anything else it did stays (the
        // colour a pick chose), so the recording still matches the editor.
        var rest = rec.events.slice(s.events).filter(function (ev) { return !isDrawEvent(ev); });
        rec.events.length = s.events;
        for (var i = 0; i < rest.length; i++) rec.events.push(rest[i]);
      }
    }
    function mid() {
      var xs = 0, ys = 0, pts = Array.from(touches.values()).slice(0, 2);
      pts.forEach(function (t) { xs += t.x; ys += t.y; });
      var d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      return { x: xs / 2, y: ys / 2, d: d };
    }
    function startGesture() {
      var m = mid();
      // the canvas point under the fingers stays under them
      gesture = {
        cx: (m.x + cnt.scrollLeft - Tegaki.offsetX) / Tegaki.zoomFactor,
        cy: (m.y + cnt.scrollTop - Tegaki.offsetY) / Tegaki.zoomFactor,
        d: m.d || 1,
        zoom: Tegaki.zoomFactor,
      };
    }
    function moveGesture() {
      var m = mid();
      var want = gesture.zoom * (m.d / gesture.d);
      var best = 0, bestErr = Infinity;
      for (var i = 0; i < Tegaki.zoomFactorList.length; i++) {
        var err = Math.abs(Math.log(Tegaki.zoomFactorList[i] / want));
        if (err < bestErr) { bestErr = err; best = i; }
      }
      var level = best - Tegaki.zoomBaseLevel;
      if (level !== Tegaki.zoomLevel) {
        Tegaki.setZoom(level);
        TegakiCursor.updateCanvasSize();
      }
      cnt.scrollLeft = gesture.cx * Tegaki.zoomFactor + Tegaki.offsetX - m.x;
      cnt.scrollTop = gesture.cy * Tegaki.zoomFactor + Tegaki.offsetY - m.y;
    }

    window.addEventListener("pointerdown", function (e) {
      if (e.pointerType !== "touch" || e.target !== cursor) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      // Tegaki sees a touch go down only through commitPending.
      stop(e);
      if (gesture) {
        if (touches.size >= 2) startGesture(); // other fingers now: re-anchor
        return;
      }
      if (touches.size === 1) {
        // during a pen or mouse stroke, a touch is a palm
        if (!Tegaki.isPainting) pending = { down: e, moves: [], timer: setTimeout(commitPending, HOLD_MS) };
        return;
      }
      if (pending) {
        clearTimeout(pending.timer);
        pending = null;
      } else if (stroke && Tegaki.isPainting && Tegaki.activePointerId === stroke.id) {
        endStroke(e);
      } else if (Tegaki.isPainting) {
        return; // a pen or mouse stroke: palms
      }
      startGesture();
    }, true);

    window.addEventListener("pointermove", function (e) {
      if (e.pointerType !== "touch" || !touches.has(e.pointerId)) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (gesture) {
        stop(e);
        if (touches.size >= 2) moveGesture();
      } else if (pending && e.pointerId === pending.down.pointerId) {
        stop(e);
        pending.moves.push(e);
        if (Math.hypot(e.clientX - pending.down.clientX, e.clientY - pending.down.clientY) > SLOP) commitPending();
      } else if (Tegaki.isPainting && e.pointerId !== Tegaki.activePointerId) {
        stop(e);
      }
    }, true);

    function end(e) {
      if (e.pointerType !== "touch" || !touches.has(e.pointerId)) return;
      touches.delete(e.pointerId);
      if (gesture) {
        stop(e);
        // nothing draws until every finger is up; two still down go on
        if (!touches.size) gesture = null;
        else if (touches.size >= 2) startGesture();
        return;
      }
      if (pending && e.pointerId === pending.down.pointerId) {
        // a tap: draw the dot, then let Tegaki see the pointerup
        if (e.type === "pointercancel") {
          clearTimeout(pending.timer);
          pending = null;
          return;
        }
        commitPending();
      } else if (Tegaki.isPainting && e.pointerId !== Tegaki.activePointerId) {
        stop(e);
      }
      if (stroke && e.pointerId === stroke.id) stroke = null;
    }
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
    window.addEventListener("resize", function () {
      // the phone rotated, or the address bar came or went
      TegakiCursor.updateCanvasSize();
    });
  }

  var sending = false;

  function onDone() {
    // Tegaki.onDoneClick has hidden the editor and stopped the recording.
    if (sending) return;
    sending = true;
    notice("Uploading drawing…");
    var replay = null;
    try {
      replay = Tegaki.replayRecorder ? Tegaki.replayRecorder.toBlob() : null;
    } catch (e) {
      console.error("tegaki: the recording could not be saved", e);
    }
    var h = host();
    Tegaki.flatten().toBlob(function (png) {
      var done;
      if (!png) done = Promise.reject(new Error("The picture could not be encoded."));
      else if (!h) done = Promise.reject(new Error("This page is not inside 2draw's draw page."));
      else {
        // The host calls uploaded() once the server has the drawing, before
        // it leaves the page: then the device copy goes.
        var uploaded = function () {
          return saver ? saver.delete().catch(function (e) { console.warn("[autosave] couldn't delete the device copy", e); }) : Promise.resolve();
        };
        done = Promise.resolve(h.submit(png, { animation: replay, uploaded: uploaded })).then(function (r) {
          uploaded();
          return r;
        });
      }
      // (accepted: the draw page's upload screen shows its check and leaves)
      done.then(null, function (err) {
        sending = false;
        notice("");
        window.alert((err && err.message) || String(err));
        Tegaki.resume();
      });
    }, "image/png");
  }

  function startEditor() {
    var p = params();
    if (!p.draft) return startPosted(p);
    var expire = function () {
      TegakiDraft.expireDrafts(Date.now(), p.draft).catch(function () {});
    };
    // One editor per draft (another tab hands over first), then its copy.
    TegakiDraft.takeEditLock(p.draft, onTaken)
      .catch(function (e) {
        console.error("[autosave] edit lock", e);
      })
      .then(function () {
        // With cloud drafts on, a copy on 2draw that this device lacks (drawn
        // on another device) is put here first (2draw.net
        // worker/src/client/draw-bar.ts drawCloudReady), so it is read as
        // this device's own.
        var page = parentPage();
        if (!page || typeof page.drawCloudReady !== "function") return null;
        return Promise.resolve(page.drawCloudReady()).catch(function (e) {
          console.warn("[autosave] couldn't check the copy on 2draw", e);
        });
      })
      .then(function () {
        var read = TegakiDraft.loadDraft(p.draft);
        // old copies (of other drawings) go after this one is read, not before
        read.then(expire, expire);
        return read;
      })
      .then(function (draft) {
        if (!draft) return startPosted(p);
        return restoreDraft(p, draft);
      }, function (err) {
        console.error("[autosave] couldn't read the copy on this device", err);
        return startPosted(p);
      });
  }

  /** Opens the copy on this device. One that can't be opened (or is for
   * another canvas size) is set aside, kept for 30 days, and the editor
   * starts from the posted drawing instead. */
  function restoreDraft(p, draft) {
    var meta = draft.meta;
    function setAside(why, err) {
      console.error("[autosave] " + why, err);
      reportError("tegaki: device copy set aside: " + why, err);
      if (Tegaki.bg) {
        try {
          Tegaki.destroy();
        } catch (e) {}
      }
      return TegakiDraft.setDraftAside(p.draft).catch(function () {}).then(function () {
        startPosted(p);
        setTimeout(function () {
          try {
            TegakiUI.printMsg("The copy of this drawing on this device couldn't be opened. It's kept, and this starts over.", 10000);
          } catch (e) {}
        }, 0);
      });
    }
    if (meta.width !== p.width || meta.height !== p.height) {
      return setAside("it is " + meta.width + "x" + meta.height + ", the drawing " + p.width + "x" + p.height);
    }
    if (meta.mode === "picture") {
      var png = draft.parts.get(meta.picture);
      if (!png) return setAside("its picture is missing");
      var url = URL.createObjectURL(new Blob([png], { type: "image/png" }));
      return loadImage(url).then(function (img) {
        URL.revokeObjectURL(url);
        openEditor(p, null, false, draft);
        var layer = Tegaki.activeLayer;
        layer.ctx.drawImage(img, 0, 0);
        TegakiLayers.syncLayerImageData(layer);
        TegakiUI.updateLayerPreview(layer);
      }, function (err) {
        URL.revokeObjectURL(url);
        return setAside("its picture can't be read", err);
      });
    }
    var buf, replayed;
    try {
      // (uncompressed: it is read straight back)
      buf = TegakiDraft.toTgkr(draft, true);
      replayed = openEditor(p, buf, true, draft);
    } catch (err) {
      return setAside("it can't be replayed", err);
    }
    return replayed.then(function (applied) {
      if (!applied || meta.hash == null) return;
      // Replayed as it was saved? A difference is reported, not acted on: the
      // replay is what the recording shows, so it is what gets posted.
      return TegakiDraft.hashLayersSliced().then(function (now) {
        if (now != null && now !== meta.hash) {
          console.warn("[autosave] the restored drawing differs from the saved one", meta.hash, now);
          reportError("tegaki: device copy replay drifted (" + meta.events + " events)");
        }
      });
    }, function (err) {
      return setAside("it can't be replayed", err);
    });
  }

  /** Starts from the posted drawing: its recording, else its picture. */
  function startPosted(p) {
    if (p.anim) {
      notice("Loading drawing…");
      fetchBytes(p.anim)
        .then(function (buf) {
          notice("");
          var failed = function (err) {
            console.error("tegaki: could not continue the recording", err);
            if (Tegaki.bg) Tegaki.destroy();
            hideReplaying();
            throw err;
          };
          try {
            return openEditor(p, buf, true).catch(failed);
          } catch (err) {
            failed(err);
          }
        })
        .catch(function (err) {
          console.error(err);
          if (p.load) return startFromPicture(p);
          notice("");
          window.alert("This drawing's recording couldn't be loaded (" + (err && err.message ? err.message : err) + ").");
          openEditor(p, null, true);
        });
    } else if (p.load) {
      startFromPicture(p);
    } else {
      openEditor(p, null, true);
    }
  }

  /** Revising a drawing without a recording: its picture is the first layer. */
  function startFromPicture(p) {
    notice("Loading drawing…");
    return loadImage(p.load).then(
      function (img) {
        notice("");
        openEditor(p, null, false);
        var layer = Tegaki.activeLayer;
        layer.ctx.drawImage(img, 0, 0);
        TegakiLayers.syncLayerImageData(layer);
        TegakiUI.updateLayerPreview(layer);
        TegakiUI.printMsg("No recording to continue: this version has no animation.", 8000);
      },
      function (err) {
        notice("");
        window.alert("This drawing couldn't be loaded (" + err.message + ").");
        openEditor(p, null, true);
      },
    );
  }

  // --- replay engine (player.js) ---------------------------------------------
  //
  // window.tegakiReplay.load(arrayBuffer) -> { duration, width, height }
  //   duration: ms of drawing time, with every pause longer than MAX_GAP_MS
  //   shortened to it (the timeline the player shows and seeks in).
  // advance_to(ms, budgetMs) -> true once every event up to `ms` is applied
  //   (false: out of time; call again next frame).
  // get_frame() -> { canvas } the flattened picture (cached between changes).
  // version: bumps whenever the picture may have changed. done: all applied.

  var MAX_GAP_MS = 1000;

  function ReplayEngine() {
    this.version = 0;
    this.done = false;
    this._events = null;
    this._times = null;
    this._index = 0;
    this._frame = document.createElement("canvas");
    this._frameVersion = -1;
  }

  ReplayEngine.prototype.load = function (buffer) {
    Tegaki.open({ replayMode: true });
    Tegaki.replayViewer.loadFromBuffer(buffer);
    return this._start();
  };

  /** load, reading the recording in slices (a promise of the same). */
  ReplayEngine.prototype.load_async = function (buffer) {
    var self = this;
    var viewer = new TegakiReplayViewer();
    return viewer.loadFromBufferSliced(buffer, TegakiReplayRunner.SLICE_MS).then(function () {
      Tegaki.open({ replayMode: true });
      Tegaki.replayViewer = viewer;
      return self._start();
    });
  };

  ReplayEngine.prototype._start = function () {
    var viewer = Tegaki.replayViewer;
    Tegaki.initFromReplay();
    Tegaki.init();
    Tegaki.setTool(Tegaki.defaultTool);
    TegakiReplayRunner.eventCodes();
    // the hidden engine shows no layer list
    TegakiReplayRunner.deferPreviews();
    var events = viewer.events;
    var times = new Float64Array(events.length);
    var t = 0;
    for (var i = 1; i < events.length; i++) {
      var dt = events[i].timeStamp - events[i - 1].timeStamp;
      if (!(dt > 0)) dt = 0;
      else if (dt > MAX_GAP_MS) dt = MAX_GAP_MS;
      t += dt;
      times[i] = t;
    }
    this._events = events;
    this._times = times;
    this._index = 0;
    this.done = events.length === 0;
    this.version++;
    return { duration: t, width: viewer.canvasWidth, height: viewer.canvasHeight };
  };

  ReplayEngine.prototype.advance_to = function (ms, budget) {
    var events = this._events, times = this._times;
    if (!events) return true;
    var start = performance.now();
    var n = 0;
    while (this._index < events.length && times[this._index] <= ms) {
      // (no undo copies for strokes nothing will undo, no layer previews)
      TegakiReplayRunner.dispatch(events, this._index, false);
      this._index++;
      n++;
      if ((n & 7) === 0 && performance.now() - start > budget) break;
    }
    if (n) this.version++;
    this.done = this._index >= events.length;
    return this.done || times[this._index] > ms;
  };

  ReplayEngine.prototype.get_frame = function () {
    if (this._frameVersion !== this.version && Tegaki.canvas) {
      Tegaki.flatten(this._frame.getContext("2d"));
      this._frameVersion = this.version;
    }
    return { canvas: this._frame };
  };

  if (REPLAY) {
    window.tegakiReplay = new ReplayEngine();
  } else if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startEditor);
  } else {
    startEditor();
  }
})();

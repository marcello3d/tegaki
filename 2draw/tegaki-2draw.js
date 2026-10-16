// tegaki.js on 2draw.net: the editor page (index.html) and the replay engine
// page (replay.html, driven by player.js). Both run inside an iframe of the
// 2draw page, so Tegaki (a page-wide singleton) has a document to itself.
//
// Editor: index.html?w=<width>&h=<height>[&anim=<.tgkr URL>][&load=<.png URL>]
//   - anim: the drawing's recording. It is replayed into the editor and the
//     new recording continues it, so the animation stays complete.
//   - load: the drawing's picture, used when there is no recording (it goes
//     onto the first layer, and this session is not recorded).
//   Submit hands the PNG and the recording to window.parent.tegakiHost.submit
//   (lib/applet.ts tegakiEmbedHtml), which uploads them and leaves the page.
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

  function openEditor(p, continueReplay, record) {
    // Inside 2draw the draw page warns before leaving unsaved work; a second
    // warning from this frame would only stack another prompt on it.
    if (host()) Tegaki.onTabClose = function () {};
    Tegaki.open({
      width: p.width,
      height: p.height,
      saveReplay: record,
      continueReplay: continueReplay || undefined,
      onDone: onDone,
      onCancel: function () {},
    });
    customizeMenu();
    if (!record) TegakiUI.setRecordingStatus(false);
    fitZoom();
    installPanelToggle();
    installTouchGestures();
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
   * Touch: one finger draws, two fingers pan and pinch-zoom. A touch that
   * lands on the canvas is held back for a moment (or until it moves) before
   * it is handed to Tegaki, so that a second finger arriving meanwhile turns
   * it into a gesture instead of a dot on the drawing. Pens and mice are not
   * affected.
   */
  function installTouchGestures() {
    var cursor = TegakiCursor.getCanvas();
    var cnt = Tegaki.canvasCnt;
    var HOLD_MS = 90, SLOP = 8;
    var touches = new Map();
    var pending = null;
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
      Tegaki.onPointerDown(p.down);
      for (var i = 0; i < p.moves.length; i++) Tegaki.onPointerMove(p.moves[i]);
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
      if (touches.size === 1 && !Tegaki.isPainting) {
        stop(e);
        pending = { down: e, moves: [], timer: setTimeout(commitPending, HOLD_MS) };
      } else if (touches.size === 2 && pending) {
        stop(e);
        clearTimeout(pending.timer);
        pending = null;
        startGesture();
      } else {
        // a second finger after the stroke began, or a third: ignored
        stop(e);
      }
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
        if (!touches.size) gesture = null;
        else if (touches.size === 1) gesture = null;
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
    notice("Sending your drawing to 2draw…");
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
      else done = Promise.resolve(h.submit(png, { animation: replay }));
      done.then(function () {
        notice("Sent! Opening your drawing…");
      }, function (err) {
        sending = false;
        notice("");
        window.alert((err && err.message) || String(err));
        Tegaki.resume();
      });
    }, "image/png");
  }

  function startEditor() {
    var p = params();
    if (p.anim) {
      notice("Loading your drawing…");
      fetchBytes(p.anim)
        .then(function (buf) {
          notice("");
          try {
            openEditor(p, buf, true);
          } catch (err) {
            console.error("tegaki: could not continue the recording", err);
            if (Tegaki.bg) Tegaki.destroy();
            throw err;
          }
        })
        .catch(function (err) {
          console.error(err);
          if (p.load) return startFromPicture(p);
          notice("");
          window.alert("Your drawing's recording could not be loaded (" + (err && err.message ? err.message : err) + ").");
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
    notice("Loading your drawing…");
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
        window.alert("Your drawing could not be loaded (" + err.message + ").");
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
    var viewer = Tegaki.replayViewer;
    viewer.loadFromBuffer(buffer);
    Tegaki.initFromReplay();
    Tegaki.init();
    Tegaki.setTool(Tegaki.defaultTool);
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
      events[this._index].dispatch();
      this._index++;
      n++;
      if ((n & 31) === 0 && performance.now() - start > budget) break;
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

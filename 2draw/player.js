// Tegaki animation player for 2draw (classic script; no modules needed by the host page).
//
//   new TegakiPlayer({ domRoot, lsaUrl /* .tgkr URL */, width?, height?, autoplay?, speed?, controls?,
//     fit?: "box" | "contain", onTimeUpdate?, onError?, onEnd? })
//   members: ready (Promise), duration (ms), currentTime (ms), isPlaying, seeking, play(), pause(), seek(ms),
//   setSpeed(multiplier 0.5..64; 64 = the strip's "max"), destroy()
//
// The same interface as 2draw's other inline players (LascauxClassicPlayer, Paint95Player), so the view page's
// animation strip drives it. The recording is replayed by tegaki.js itself, in a hidden same-origin iframe of
// replay.html next to this script (tegaki-2draw.js window.tegakiReplay); this copies the flattened picture into a
// <canvas> in domRoot. Pauses longer than a second are shortened to one. Seeking back starts a fresh engine and
// replays up to the target (the old frame stays up meanwhile).
(function () {
  "use strict";

  var script = document.currentScript;
  var base_url = new URL(".", (script && script.src) || location.href).href;
  var build = (script && script.src && new URL(script.src).searchParams.get("v")) || "";

  var FRAME_BUDGET_MS = 12;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function TegakiPlayer(options) {
    if (!(this instanceof TegakiPlayer)) return new TegakiPlayer(options);
    var self = this;
    self._options = options || {};
    self._speed = clamp(Number(self._options.speed) || 1, 0.5, 64);
    self._time = 0;
    self._playing = false;
    self._duration = 0;
    self._destroyed = false;
    self._frame = null;
    self._engine = null;
    self._caught_up = true;
    self._raf = 0;
    self._last_tick = 0;
    self._restarting = null;
    self._seeking = false;
    self._seek_back = false;

    var root = self._options.domRoot;
    if (!root) throw new Error("TegakiPlayer: domRoot is required");
    self._container = document.createElement("div");
    self._container.className = "tegaki-player";
    self._container.style.cssText = "position:relative;overflow:hidden;width:100%;height:100%;";
    if (self._options.fit === "box" && self._options.width && self._options.height) {
      self._container.style.width = self._options.width + "px";
      self._container.style.height = self._options.height + "px";
    }
    self._stage = document.createElement("div");
    self._stage.style.cssText = "position:absolute;left:0;top:0;right:0;bottom:0;";
    self._canvas = document.createElement("canvas");
    self._canvas.style.cssText = "position:absolute;display:block;";
    self._ctx = self._canvas.getContext("2d");
    self._stage.appendChild(self._canvas);
    self._container.appendChild(self._stage);
    if (self._options.controls) self._build_controls();
    root.appendChild(self._container);

    if (typeof ResizeObserver !== "undefined") {
      self._resize_observer = new ResizeObserver(function () { self._layout(); });
      self._resize_observer.observe(self._container);
    }

    self.ready = self._init();
    self.ready.catch(function (error) {
      if (self._options.onError) self._options.onError(error instanceof Error ? error : new Error(String(error)));
    });
  }

  Object.defineProperties(TegakiPlayer.prototype, {
    duration: { get: function () { return this._duration; } },
    currentTime: { get: function () { return this._time; } },
    isPlaying: { get: function () { return this._playing; } },
    /** true from a seek until its target frame is drawn */
    seeking: { get: function () { return this._seeking; } },
  });

  TegakiPlayer.prototype._init = function () {
    var self = this;
    return fetch(self._options.lsaUrl || self._options.url, { mode: "cors", credentials: "omit" })
      .then(function (response) {
        if (!response.ok) throw new Error("Failed to load animation (HTTP " + response.status + ")");
        return response.arrayBuffer();
      })
      .then(function (buffer) {
        self._buffer = buffer;
        return self._create_frame();
      })
      .then(function (frame) {
        if (self._destroyed) {
          frame.iframe.remove();
          return;
        }
        self._install(frame);
        self._advance(Infinity);
        self._render();
        self._emit_time();
        if (self._options.autoplay) self.play();
      });
  };

  /** A hidden replay engine with the recording loaded. */
  TegakiPlayer.prototype._create_frame = function () {
    var self = this;
    return new Promise(function (resolve, reject) {
      var iframe = document.createElement("iframe");
      iframe.setAttribute("aria-hidden", "true");
      iframe.tabIndex = -1;
      iframe.title = "";
      // laid out (not display:none) but offscreen
      iframe.style.cssText = "position:fixed;left:-10000px;top:0;width:800px;height:600px;border:0;visibility:hidden;pointer-events:none;";
      iframe.onload = function () {
        try {
          var engine = iframe.contentWindow.tegakiReplay;
          if (!engine) throw new Error("Replay engine failed to start");
          var info = engine.load(self._buffer.slice(0));
          resolve({ iframe: iframe, engine: engine, info: info });
        } catch (error) {
          iframe.remove();
          reject(error instanceof Error ? error : new Error("Could not read the animation (" + error + ")"));
        }
      };
      iframe.onerror = function () {
        iframe.remove();
        reject(new Error("Failed to load the replay engine"));
      };
      iframe.src = base_url + "replay.html" + (build ? "?v=" + encodeURIComponent(build) : "");
      document.body.appendChild(iframe);
    });
  };

  TegakiPlayer.prototype._install = function (frame) {
    if (this._frame && this._frame.iframe !== frame.iframe) this._frame.iframe.remove();
    this._frame = frame;
    this._engine = frame.engine;
    this._duration = frame.info.duration;
    this._width = frame.info.width;
    this._height = frame.info.height;
    this._layout();
  };

  TegakiPlayer.prototype._advance = function (budget) {
    if (!this._engine) return;
    this._caught_up = this._engine.advance_to(this._time, budget === undefined ? FRAME_BUDGET_MS : budget);
  };

  /** Replays from the start in a fresh engine (one at a time; seeks meanwhile move the target). */
  TegakiPlayer.prototype._restart = function () {
    var self = this;
    if (self._restarting) return;
    var restart = self._create_frame().then(function (frame) {
      if (self._destroyed || self._restarting !== restart) {
        frame.iframe.remove();
        return;
      }
      self._restarting = null;
      self._install(frame);
      self._caught_up = false;
      self._schedule();
    }, function (error) {
      self._restarting = null;
      self._seeking = false;
      if (self._options.onError) self._options.onError(error);
    });
    self._restarting = restart;
  };

  TegakiPlayer.prototype._schedule = function () {
    var self = this;
    if (self._raf || self._destroyed) return;
    self._last_tick = performance.now();
    self._raf = requestAnimationFrame(function tick(now) {
      self._raf = 0;
      if (self._destroyed) return;
      var dt = now - self._last_tick;
      self._last_tick = now;
      if (self._playing && !self._restarting && self._caught_up) {
        self._time = Math.min(self._duration, self._time + dt * self._speed);
      }
      if (!self._restarting && self._seek_back) {
        self._seek_back = false;
        self._restart();
      }
      if (!self._restarting) {
        self._advance();
        var landed = self._seeking && self._caught_up;
        if (landed) self._seeking = false;
        if (!self._seeking) self._render();
        if (landed) self._emit_time();
      }
      if (self._playing) self._emit_time();
      if (self._playing && self._caught_up && self._time >= self._duration && self._engine && self._engine.done) {
        self._playing = false;
        self._update_controls();
        self._emit_time();
        if (self._options.onEnd) self._options.onEnd();
      }
      if (self._playing || !self._caught_up || self._restarting || self._seek_back) {
        self._raf = requestAnimationFrame(tick);
      }
    });
  };

  TegakiPlayer.prototype.play = function () {
    if (this._destroyed) return;
    if (this._time >= this._duration && this._duration > 0) this.seek(0);
    this._playing = true;
    this._update_controls();
    this._schedule();
  };

  TegakiPlayer.prototype.pause = function () {
    this._playing = false;
    this._update_controls();
    this._emit_time();
  };

  TegakiPlayer.prototype.seek = function (ms) {
    if (this._destroyed) return;
    ms = clamp(Number(ms) || 0, 0, this._duration);
    // the engine only goes forward: going back means starting over
    if (this._engine && ms < this._applied_time()) this._seek_back = true;
    this._seeking = true;
    this._time = ms;
    this._caught_up = false;
    this._emit_time();
    this._schedule();
  };

  /** How far the current engine has replayed (its events only go forward). */
  TegakiPlayer.prototype._applied_time = function () {
    var e = this._engine;
    if (!e || !e._times || !e._index) return 0;
    return e._times[e._index - 1];
  };

  TegakiPlayer.prototype.setSpeed = function (multiplier) {
    this._speed = clamp(Number(multiplier) || 1, 0.5, 64);
  };

  TegakiPlayer.prototype.destroy = function () {
    this._destroyed = true;
    this._playing = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._resize_observer) this._resize_observer.disconnect();
    if (this._frame) this._frame.iframe.remove();
    this._container.remove();
  };

  TegakiPlayer.prototype._emit_time = function () {
    this._update_controls();
    if (this._options.onTimeUpdate) {
      this._options.onTimeUpdate({
        currentTime: this._time,
        duration: this._duration,
        isPlaying: this._playing,
        progress: this._duration ? this._time / this._duration : 0,
        seeking: this._seeking,
      });
    }
  };

  TegakiPlayer.prototype._layout = function () {
    if (!this._width) return;
    var box_width = this._stage.clientWidth || this._width;
    var box_height = this._stage.clientHeight || this._height;
    var scale = Math.min(box_width / this._width, box_height / this._height);
    if (!isFinite(scale) || scale <= 0) scale = 1;
    var css_width = this._width * scale;
    var css_height = this._height * scale;
    this._canvas.style.width = css_width + "px";
    this._canvas.style.height = css_height + "px";
    this._canvas.style.left = (box_width - css_width) / 2 + "px";
    this._canvas.style.top = (box_height - css_height) / 2 + "px";
    this._canvas.style.imageRendering = scale >= 1 ? "pixelated" : "auto";
  };

  TegakiPlayer.prototype._render = function () {
    var engine = this._engine;
    if (!engine) return;
    if (this._rendered_version === engine.version && this._rendered_engine === engine) return;
    this._rendered_version = engine.version;
    this._rendered_engine = engine;
    var source = engine.get_frame().canvas;
    if (!source.width || !source.height) return;
    if (this._canvas.width !== source.width || this._canvas.height !== source.height) {
      this._canvas.width = source.width;
      this._canvas.height = source.height;
      this._width = source.width;
      this._height = source.height;
      this._layout();
    }
    this._ctx.drawImage(source, 0, 0);
  };

  TegakiPlayer.prototype._build_controls = function () {
    var self = this;
    var bar = document.createElement("div");
    bar.style.cssText = "position:absolute;left:0;right:0;bottom:0;height:28px;display:flex;align-items:center;gap:6px;padding:0 6px;background:rgba(141,153,166,0.95);font:12px sans-serif;box-sizing:border-box;";
    self._stage.style.bottom = "28px";
    var button = document.createElement("button");
    button.type = "button";
    button.style.cssText = "min-width:56px;";
    button.onclick = function () {
      if (self._playing) self.pause();
      else self.play();
    };
    var range = document.createElement("input");
    range.type = "range";
    range.min = "0";
    range.max = "1000";
    range.value = "0";
    range.style.cssText = "flex:1;min-width:0;";
    range.oninput = function () {
      self.seek(Number(range.value) / 1000 * self._duration);
    };
    bar.appendChild(button);
    bar.appendChild(range);
    self._container.appendChild(bar);
    self._controls = { button: button, range: range };
    self._update_controls();
  };

  TegakiPlayer.prototype._update_controls = function () {
    if (!this._controls) return;
    this._controls.button.textContent = this._playing ? "Pause" : "Play";
    if (document.activeElement !== this._controls.range) {
      this._controls.range.value = String(this._duration ? Math.round(this._time / this._duration * 1000) : 0);
    }
  };

  window.TegakiPlayer = TegakiPlayer;
})();

// [2draw] Replays recorded events into the editor (continueReplay: reopening
// a drawing from its recording) and the player's engine, fast and without
// freezing the page. What the events draw is exactly what dispatching them
// one by one draws; only work nothing can see is left out:
//
// - Undo copies. A stroke keeps two full copies of its layer (before and
//   after) for undo, two canvas-sized allocations per stroke. A stroke whose
//   copies can never be read makes none: undo can't reach it before it falls
//   off the end of the history (TegakiHistory.maxSize steps), and it isn't
//   in the history once the replay ends (the editor's; the player keeps
//   none). copyNeeded works that out from the events still to come,
//   following TegakiHistory's own push/undo/redo rules; anything it doesn't
//   follow (layer changes that may or may not push a step) keeps the copies.
// - Layer previews (the layer list's thumbnails) are drawn once at the end,
//   not after every stroke.
//
// run() replays in slices of about SLICE_MS, yielding between them (and
// letting a frame be drawn now and then, so the picture builds up), so no
// task runs long; runSync() all at once.
var TegakiReplayRunner = {
  SLICE_MS: 12,

  // How the history sees each event type: 1 a stroke starts, 2 it is
  // committed (pushed), 3 undo, 4 redo, 5 a step is pushed, 6 a step may be
  // pushed.
  codes: null,

  eventCodes: function() {
    var c, E;

    if (this.codes) {
      return this.codes;
    }

    E = TegakiEvents;
    c = new Uint8Array(256);

    c[E.TegakiEventDrawStart[0]] = 1;
    c[E.TegakiEventDrawStartNoP[0]] = 1;
    c[E.TegakiEventDrawCommit[0]] = 2;
    c[E.TegakiEventUndo[0]] = 3;
    c[E.TegakiEventRedo[0]] = 4;
    c[E.TegakiEventHistoryDummy[0]] = 5;
    c[E.TegakiEventAddLayer[0]] = 6;
    c[E.TegakiEventDeleteLayers[0]] = 6;
    c[E.TegakiEventMergeLayers[0]] = 6;
    c[E.TegakiEventMoveLayers[0]] = 6;
    c[E.TegakiEventSetSelectedLayersAlpha[0]] = 6;

    return (this.codes = c);
  },

  // Whether the undo copies of the stroke that events[s] starts can ever be
  // read, with undoLen steps in the history now. keepSurvivors: the history
  // is kept after the replay (the editor), so a stroke still in it at the end
  // needs its copies.
  copyNeeded: function(events, s, undoLen, keepSurvivors) {
    var codes, max, n, i, c, below, depth, redo, fresh, limit;

    codes = this.codesOf(events);
    max = TegakiHistory.maxSize;
    n = events.length;
    limit = Math.min(n, s + 1 + 500000);

    // its commit
    for (i = s + 1; i < limit; ++i) {
      c = codes[i];

      if (c === 2) {
        break;
      }

      if (c === 1) {
        // another stroke starts first: this one is never pushed
        return false;
      }

      if (c !== 0) {
        return true;
      }
    }

    if (i >= limit) {
      return true;
    }

    // pushed (the oldest step goes if the history is full): `below` steps
    // under it, `depth` over it, `redo` undone over it
    below = Math.min(undoLen + 1, max) - 1;
    depth = 0;
    redo = 0;
    fresh = false;

    for (++i; i < limit; ++i) {
      c = codes[i];

      if (c === 0) {
        continue;
      }

      if (c === 1) {
        fresh = true;
      }
      else if (c === 2 || c === 5) {
        if (c === 2) {
          if (!fresh) {
            // a commit with no new stroke pushes the same one again
            return true;
          }

          fresh = false;
        }

        depth++;
        redo = 0;

        if (below + depth + 1 > max) {
          if (below > 0) {
            below--;
          }
          else {
            // it falls off the end of the history, never undone
            return false;
          }
        }
      }
      else if (c === 3) {
        if (depth === 0) {
          return true;
        }

        depth--;
        redo++;
      }
      else if (c === 4) {
        if (redo > 0) {
          redo--;
          depth++;
        }
      }
      else {
        return true;
      }
    }

    return i >= n ? keepSurvivors : true;
  },

  // eventCodes for each of events (kept with the list; events are never
  // added to a list being replayed).
  codesOf: function(events) {
    var codes, all, i;

    if (events.tegakiCodes && events.tegakiCodes.length === events.length) {
      return events.tegakiCodes;
    }

    all = this.eventCodes();
    codes = new Uint8Array(events.length);

    for (i = 0; i < events.length; ++i) {
      codes[i] = all[events[i].type];
    }

    Object.defineProperty(events, 'tegakiCodes', { value: codes, configurable: true, writable: true });

    return codes;
  },

  // Dispatches events[i].
  dispatch: function(events, i, keepSurvivors) {
    var e = events[i];

    if (this.codes[e.type] === 1) {
      TegakiHistory.skipCopy = !this.copyNeeded(events, i, TegakiHistory.undoStack.length, keepSurvivors);

      try {
        e.dispatch();
      }
      finally {
        TegakiHistory.skipCopy = false;
      }
    }
    else {
      e.dispatch();
    }
  },

  deferPreviews: function() {
    if (!TegakiUI.deferredPreviews) {
      TegakiUI.deferredPreviews = new Set();
    }
  },

  // Draws the layer previews the replay skipped.
  flushPreviews: function() {
    var layers = TegakiUI.deferredPreviews, layer;

    TegakiUI.deferredPreviews = null;

    if (!layers) {
      return;
    }

    for (layer of layers) {
      if (Tegaki.layers.indexOf(layer) !== -1) {
        TegakiUI.updateLayerPreview(layer);
      }
    }
  },

  // All of events at once. keepSurvivors: see copyNeeded.
  runSync: function(events, keepSurvivors) {
    var i;

    this.eventCodes();
    this.deferPreviews();

    try {
      for (i = 0; i < events.length; ++i) {
        this.dispatch(events, i, keepSurvivors);
      }
    }
    finally {
      this.flushPreviews();
    }
  },

  // events in slices; resolves once all are applied, rejects if one throws.
  // opts: onProgress(fraction) after each slice; isCancelled() to stop
  // (resolves, applied or not, with false).
  run: function(events, opts) {
    var self = this;

    opts = opts || {};

    this.eventCodes();
    this.deferPreviews();

    return new Promise(function(resolve, reject) {
      var i = 0, n = events.length, lastPaint = performance.now();

      function slice() {
        var start = performance.now();

        if (opts.isCancelled && opts.isCancelled()) {
          // (the editor was closed: a new one may be replaying by now)
          resolve(false);
          return;
        }

        try {
          while (i < n) {
            self.dispatch(events, i, true);
            ++i;

            if ((i & 7) === 0 && performance.now() - start >= self.SLICE_MS) {
              break;
            }
          }

          if (i >= n) {
            self.flushPreviews();
          }
        }
        catch (err) {
          TegakiUI.deferredPreviews = null;
          reject(err);
          return;
        }

        if (opts.onProgress) {
          try {
            opts.onProgress(n ? i / n : 1);
          }
          catch (e) {}
        }

        if (i >= n) {
          resolve(true);
          return;
        }

        // now and then a frame, so the picture builds up on screen (not in
        // a hidden page, which draws none)
        if (!document.hidden && performance.now() - lastPaint > 100) {
          self.afterFrame(function() {
            lastPaint = performance.now();
            slice();
          });
        }
        else {
          self.post(slice);
        }
      }

      self.post(slice);
    });
  },

  // The bytes of a .tgkr as a loaded TegakiReplayViewer (a promise), read in
  // slices.
  load: function(buffer) {
    var viewer = new TegakiReplayViewer();
    
    return viewer.loadFromBufferSliced(buffer, this.SLICE_MS).then(function() {
      return viewer;
    });
  },
  
  // fn as a task of its own, at once (setTimeout waits 4 ms once nested).
  post: function(fn) {
    var ch;

    if (typeof MessageChannel === 'undefined') {
      setTimeout(fn, 0);
      return;
    }

    if (!this.channel) {
      ch = this.channel = new MessageChannel();
      this.queue = [];
      ch.port1.onmessage = function() {
        var f = TegakiReplayRunner.queue.shift();

        if (f) {
          f();
        }
      };
    }

    this.queue.push(fn);
    this.channel.port2.postMessage(0);
  },

  // fn once the next frame is drawn (or after 50 ms, if none is).
  afterFrame: function(fn) {
    var self = this, done = false;

    function go() {
      if (!done) {
        done = true;
        self.post(fn);
      }
    }

    requestAnimationFrame(go);
    setTimeout(go, 50);
  }
};

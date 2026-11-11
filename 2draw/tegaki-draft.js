// Tegaki on 2draw.net: a copy of the drawing in progress on this device
// (IndexedDB), keyed by the 2draw draft key (index.html?draft=<key>).
// Reloading, going back and forward, or reopening /draw/<key>/ restores it.
// Modelled on JSPaint.exe's (marcello3d/jspaint src/paint95-draft.js).
//
// What is stored is the recording so far (the .tgkr events), not the picture,
// so restoring replays it: the layers, the undo history and the recording all
// come back, and the recording carries on.
//
// - DB "2draw-tegaki-drafts", store "drafts": one record per draft key: the
//   recording's head (its meta and tool list, as .tgkr bytes, fixed for the
//   session), the names and event counts of its sealed chunks, the last
//   events as a "tail", a hash of the layers at the save, and when it was
//   saved.
// - store "parts", keyed [draft key, name]: sealed chunks of CHUNK_EVENTS
//   packed events each (.tgkr event bytes, never rewritten).
// A copy is turned back into a .tgkr (toTgkr) by joining the head, the chunks
// and the tail and adding a conclusion; the editor opens it as it opens a
// posted recording (continueReplay).
//
// A revision of a drawing that has no recording is not recorded (the editor
// starts from its picture, tegaki-2draw.js startFromPicture): then the copy
// is a PNG of the picture ("picture" mode), and restoring puts it back on the
// first layer.
//
// window.TegakiDraft: loadDraft, deleteDraft, setDraftAside, expireDrafts,
// toTgkr, Saver, takeEditLock, requestPersistentStorage, hashLayers.
(function () {
  "use strict";

  var DB_NAME = "2draw-tegaki-drafts";
  var DRAFTS = "drafts";
  var PARTS = "parts";
  var VERSION = 1;
  /** Drafts not saved (or set aside) for this long are deleted on load. */
  var MAX_AGE_MS = 30 * 24 * 3600 * 1000;
  /** Events per sealed chunk. */
  var CHUNK_EVENTS = 2048;
  /** A save is due this long after the first change since the last save;
   * later changes don't put it off (see Saver). */
  var SAVE_DELAY_MS = 700;
  /** A store that failed is tried again after these waits (a fresh
   * connection each time) before a save says it failed. */
  var DB_RETRY_MS = [250, 1000, 3000];
  /** After a failed save, try again this long after (and at every change). */
  var RETRY_MS = 5000;

  // Nothing interrupts drawing. On 2draw's draw page (the same-origin parent)
  // window.drawPen (2draw.net client/draw-bar.ts) says when the pen rests: a
  // save waits for a pause in the drawing, not just for the pen to lift (a
  // save in the gap between two fast strokes held up the next one), and runs
  // in slices of a few ms with a yield between them, each slice again only
  // once the pen rests. Without that page (the editor alone), as before:
  // at once, with plain yields.
  function drawPen() {
    try {
      var p = window.parent !== window ? window.parent.drawPen : null;
      return p && typeof p.idle === "function" ? p : null;
    } catch (e) {
      return null;
    }
  }
  /** fn() once the pen rests (now if it does). */
  function whenPenRests(fn) {
    var p = drawPen();
    if (p) p.idle(fn);
    else fn();
  }
  /** ms a slice of a save may take. */
  function sliceMs() {
    var p = drawPen();
    return (p && p.sliceMs) || 4;
  }
  /** Before the next slice of a save started at `since` (not when `urgent`:
   * the page is being hidden or left, and the save has to start now). */
  function nextSlice(urgent, since) {
    if (urgent || document.visibilityState === "hidden") return Promise.resolve();
    var p = drawPen();
    if (p && typeof p.slice === "function") return Promise.resolve(p.slice(since));
    return new Promise(function (r) { setTimeout(r, 0); });
  }
  /** A slice should end early: input is waiting. */
  function yielded() {
    var p = drawPen();
    try {
      return !!(p && p.yielded && p.yielded());
    } catch (e) {
      return false;
    }
  }

  function validKey(key) {
    return typeof key === "string" && /^[0-9a-z_-]{4,64}$/.test(key);
  }

  // --- IndexedDB -------------------------------------------------------------
  // Every transaction is committed as soon as its last request is made
  // (commitTx), never left to commit by itself: WebKit (Safari, the iOS app)
  // puts a page that is left into its back/forward cache right after
  // pagehide and freezes it there, and a frozen page with a transaction
  // still open holds the store, so the same drawing opened again waited
  // behind it until the frozen page was thrown away, minutes later. So, too,
  // as Lascaux Pocket does (2draw.net worker/src/pocket/ink.ts, "The
  // device's store"): a page going into that cache (pagehide, persisted)
  // starts no new transaction until it is shown again (pageAway), aborts any
  // still making requests (openTx) and closes its connection (opened again
  // when next needed). A transaction that fails is tried again on a fresh
  // connection (DB_RETRY_MS) before anyone says "Not saved".

  var dbPromise = null;
  var dbConn = null;
  var pageAway = null;
  var pageBack = null;
  var openTx = new Set();
  var onPageBack = [];

  function isPageAway() {
    return !!pageAway;
  }

  /** A transaction aborted because the page went into the back/forward
   * cache: not a failure. */
  function pageAwayError() {
    var e = new Error("the page went into the back/forward cache");
    e.name = "PageAwayError";
    return e;
  }

  function commitTx(tx) {
    // (commit(): Safari 15+, Chrome 76+; older ones commit by themselves)
    if (typeof tx.commit === "function") {
      try {
        tx.commit();
      } catch (e) {} // (already finishing)
    }
  }

  function dropDb(db) {
    try {
      db.close();
    } catch (e) {}
    if (dbConn === db) {
      dbConn = null;
      dbPromise = null;
    }
  }

  addEventListener("pagehide", function (e) {
    if (!e.persisted) return;
    if (!pageAway) pageAway = new Promise(function (r) { pageBack = r; });
    openTx.forEach(function (tx) {
      try {
        tx.abort();
      } catch (e2) {}
    });
    openTx.clear();
    if (dbConn) dropDb(dbConn);
  });
  addEventListener("pageshow", function () {
    if (!pageAway) return;
    pageAway = null;
    if (pageBack) pageBack();
    pageBack = null;
    for (var i = 0; i < onPageBack.length; i++) {
      try {
        onPageBack[i]();
      } catch (e) {
        console.error("[autosave] pageshow handler failed", e);
      }
    }
  });

  function openDbOnce() {
    return new Promise(function (resolve, reject) {
      if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB is not available"));
      var r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = function () {
        var db = r.result;
        if (!db.objectStoreNames.contains(DRAFTS)) db.createObjectStore(DRAFTS, { keyPath: "key" });
        if (!db.objectStoreNames.contains(PARTS)) db.createObjectStore(PARTS, { keyPath: ["key", "name"] });
      };
      r.onsuccess = function () {
        var db = r.result;
        // another tab upgrading: let it
        db.onversionchange = function () { dropDb(db); };
        db.onclose = function () { dropDb(db); };
        dbConn = db;
        resolve(db);
      };
      r.onerror = function () { reject(r.error); };
      r.onblocked = function () { console.warn("[autosave] the device store's open is waiting on another page"); };
    });
  }

  function openDb() {
    if (!dbPromise) {
      var attempt = 0;
      var tryOpen = function () {
        return openDbOnce().catch(function (err) {
          if (attempt >= DB_RETRY_MS.length || typeof indexedDB === "undefined") throw err;
          return sleep(DB_RETRY_MS[attempt++]).then(tryOpen);
        });
      };
      dbPromise = tryOpen();
      dbPromise.catch(function () { dbPromise = null; });
    }
    return dbPromise;
  }

  function retryable(err) {
    return !(err && ["PageAwayError", "QuotaExceededError", "DataError", "DataCloneError", "ConstraintError", "ReadOnlyError", "VersionError"].indexOf(err.name) >= 0);
  }

  function waitBack() {
    return pageAway ? pageAway.then(waitBack) : Promise.resolve();
  }

  /**
   * A transaction: fn(tx, finish) makes its requests. Unchained, it makes
   * them all at once (none from another's callback) and the transaction is
   * committed straight after; chained, fn calls finish() after its last
   * request (made from a callback), which commits it, and it is aborted if
   * the page goes into the back/forward cache first. Never started while the
   * page is in that cache; tried again (DB_RETRY_MS, a fresh connection) if
   * it fails. Resolves with what fn returned, its requests' results filled in.
   */
  function runTx(stores, mode, fn, chained) {
    var attempt = 0;
    function once() {
      return waitBack().then(openDb).then(function (db) {
        var tx;
        try {
          tx = db.transaction(stores, mode);
        } catch (e) {
          // (closed under it: opened again)
          dropDb(db);
          throw e;
        }
        if (chained) openTx.add(tx);
        var finished = done(tx);
        var out;
        try {
          out = fn(tx, function () { commitTx(tx); });
        } catch (e) {
          try {
            tx.abort();
          } catch (e2) {}
          openTx.delete(tx);
          return finished.catch(function () {}).then(function () { throw e; });
        }
        if (!chained) commitTx(tx);
        return finished.then(function () {
          openTx.delete(tx);
          return out;
        }, function (e) {
          openTx.delete(tx);
          throw e;
        });
      });
    }
    function go() {
      return once().catch(function (err) {
        if (attempt >= DB_RETRY_MS.length || !retryable(err)) throw err;
        return sleep(DB_RETRY_MS[attempt++]).then(go);
      });
    }
    return go();
  }

  function done(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(pageAway ? pageAwayError() : tx.error || new Error("transaction aborted")); };
    });
  }

  function partsRange(key) {
    return IDBKeyRange.bound([key, ""], [key, "￿"]);
  }

  function bytes(data) {
    return data instanceof Uint8Array ? data : new Uint8Array(data);
  }

  /** A draft's record and its parts by name, or null. */
  function loadDraft(key) {
    return runTx([DRAFTS, PARTS], "readonly", function (tx) {
      return { meta: tx.objectStore(DRAFTS).get(key), parts: tx.objectStore(PARTS).getAll(partsRange(key)) };
    }).then(function (got) {
      var meta = got.meta.result;
      var list = got.parts.result;
      if (!meta) return null;
      if (meta.v !== VERSION) throw new Error("Unsupported device copy version " + meta.v);
      var parts = new Map();
      for (var i = 0; i < list.length; i++) parts.set(list[i].name, bytes(list[i].data));
      return { meta: meta, parts: parts };
    });
  }

  function deleteDraft(key) {
    return runTx([DRAFTS, PARTS], "readwrite", function (tx) {
      tx.objectStore(DRAFTS).delete(key);
      tx.objectStore(PARTS).delete(partsRange(key));
    });
  }

  /** Keeps a copy that can't be opened for 30 more days (from now) under
   * another key, so a new session doesn't overwrite it. (Read, then written
   * in a second transaction: each commits at once; one editor per draft, so
   * nothing writes it in between.) */
  function setDraftAside(key) {
    var aside = key + "~unreadable-" + Date.now();
    return runTx([DRAFTS, PARTS], "readonly", function (tx) {
      return { meta: tx.objectStore(DRAFTS).get(key), parts: tx.objectStore(PARTS).getAll(partsRange(key)) };
    }).then(function (got) {
      var meta = got.meta.result;
      if (!meta) return aside;
      var list = got.parts.result;
      return runTx([DRAFTS, PARTS], "readwrite", function (tx) {
        var drafts = tx.objectStore(DRAFTS), parts = tx.objectStore(PARTS);
        for (var i = 0; i < list.length; i++) parts.put({ key: aside, name: list[i].name, data: list[i].data });
        drafts.put(Object.assign({}, meta, { key: aside, set_aside: true, aside_at: Date.now() }));
        drafts.delete(key);
        parts.delete(partsRange(key));
      }).then(function () { return aside; });
    });
  }

  /** Deletes copies not saved (or set aside) for MAX_AGE_MS, but never
   * `keep` (the draft this page has open). (The records read in one
   * transaction and the old ones deleted in another, not with a cursor,
   * whose requests come from callbacks.) */
  function expireDrafts(now, keep) {
    now = now || Date.now();
    return runTx([DRAFTS], "readonly", function (tx) {
      return tx.objectStore(DRAFTS).getAll();
    }).then(function (all) {
      var old = (all.result || []).filter(function (m) {
        var at = Math.max(typeof m.saved === "number" ? m.saved : 0, typeof m.aside_at === "number" ? m.aside_at : 0);
        return m.key !== keep && !(at > 0 && now - at < MAX_AGE_MS);
      });
      if (!old.length) return 0;
      return runTx([DRAFTS, PARTS], "readwrite", function (tx) {
        for (var i = 0; i < old.length; i++) {
          tx.objectStore(PARTS).delete(partsRange(old[i].key));
          tx.objectStore(DRAFTS).delete(old[i].key);
        }
      }).then(function () { return old.length; });
    });
  }

  // --- the recording's bytes -------------------------------------------------

  function isConclusion(e) {
    return e.type === TegakiEvents.TegakiEventConclusion[0];
  }

  /** .tgkr event bytes for events[from, to), plus `extra` events. */
  function packEvents(events, from, to, extra) {
    var size = 0, i;
    for (i = from; i < to; i++) size += events[i].size;
    for (i = 0; i < extra.length; i++) size += extra[i].size;
    var w = new TegakiBinWriter(new ArrayBuffer(size));
    for (i = from; i < to; i++) events[i].pack(w);
    for (i = 0; i < extra.length; i++) extra[i].pack(w);
    return new Uint8Array(w.buf);
  }

  /** The recording's meta and tool list as .tgkr bytes (fixed once it has
   * started). */
  function packHead(rec) {
    var w = new TegakiBinWriter(new ArrayBuffer(rec.getMetaSize() + rec.getToolListSize()));
    rec.writeMeta(w);
    rec.writeToolList(w);
    return new Uint8Array(w.buf);
  }

  /** A copy (loadDraft) as the bytes of a .tgkr, for continueReplay. raw:
   * uncompressed (the format's flag; only for reading straight back). */
  function toTgkr(draft, raw) {
    var meta = draft.meta;
    var pieces = [bytes(meta.head)];
    var count = 0;
    for (var i = 0; i < meta.chunks.length; i++) {
      var part = draft.parts.get(meta.chunks[i].name);
      if (!part) throw new Error("The device copy is missing its part " + meta.chunks[i].name);
      pieces.push(part);
      count += meta.chunks[i].count;
    }
    pieces.push(bytes(meta.tail));
    count += meta.tailCount;
    if (count < 1) throw new Error("The device copy has no events");
    var end = new TegakiEventConclusion((meta.lastTime || 0) + 1);
    var endBytes = packEvents([end], 0, 1, []);
    count += 1;
    var size = 4 + endBytes.length;
    for (i = 0; i < pieces.length; i++) size += pieces[i].length;
    var data = new Uint8Array(size);
    var pos = 0;
    data.set(pieces[0], pos);
    pos += pieces[0].length;
    new DataView(data.buffer).setUint32(pos, count);
    pos += 4;
    for (i = 1; i < pieces.length; i++) {
      data.set(pieces[i], pos);
      pos += pieces[i].length;
    }
    data.set(endBytes, pos);
    var comp = raw ? data : UZIP.deflateRaw(data, { level: 1 });
    var out = new Uint8Array(12 + comp.length);
    var dv = new DataView(out.buffer);
    out[0] = 0x54;
    out[1] = 0x47;
    out[2] = 0x4b;
    out[3] = raw ? 0 : 1;
    dv.setUint32(4, data.length);
    out[8] = meta.tegakiVersion[0];
    out[9] = meta.tegakiVersion[1];
    out[10] = meta.tegakiVersion[2];
    out[11] = meta.formatVersion;
    out.set(comp, 12);
    return out.buffer;
  }

  /** A hash of what the layers hold (a sample of their pixels, order, visibility and
   * opacity), to tell whether a restore replayed the drawing as it was. Null
   * while a stroke is under way (the layer data is not current then). */
  /** hashLayers in slices with a yield between them (nextSlice): the same
   * hash, or null if the layers may have changed meanwhile (`same()` false:
   * something was drawn or recorded since the save's snapshot). */
  async function hashLayersSliced(urgent, since, same) {
    if (!Tegaki.layers || Tegaki.isPainting) return null;
    var layers = Tegaki.layers.slice();
    var h = 0x811c9dc5 | 0;
    var budget = sliceMs(), t = performance.now();
    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      h = Math.imul(h ^ (layer.visible ? 1 : 2), 0x01000193);
      h = Math.imul(h ^ Math.round((layer.alpha == null ? 1 : layer.alpha) * 1000), 0x01000193);
      var d = layer.imageData && layer.imageData.data;
      if (!d) continue;
      var u = new Uint32Array(d.buffer, d.byteOffset, d.byteLength >> 2);
      // every fourth pixel: enough to tell
      for (var j = 0; j < u.length; ) {
        var end = Math.min(u.length, j + 32768);
        for (; j < end; j += 4) h = Math.imul(h ^ u[j], 0x01000193);
        if (j < u.length && !urgent && (performance.now() - t > budget || yielded())) {
          await nextSlice(urgent, since);
          t = performance.now();
          if (!same() || Tegaki.isPainting || Tegaki.layers.length !== layers.length || Tegaki.layers[i] !== layer || layer.imageData.data !== d) return null;
        }
      }
    }
    return h >>> 0;
  }

  function hashLayers() {
    if (!Tegaki.layers || Tegaki.isPainting) return null;
    var h = 0x811c9dc5 | 0;
    function mix(v) {
      h = Math.imul(h ^ v, 0x01000193);
    }
    for (var i = 0; i < Tegaki.layers.length; i++) {
      var layer = Tegaki.layers[i];
      mix(layer.visible ? 1 : 2);
      mix(Math.round((layer.alpha == null ? 1 : layer.alpha) * 1000));
      var d = layer.imageData && layer.imageData.data;
      if (!d) continue;
      var u = new Uint32Array(d.buffer, d.byteOffset, d.byteLength >> 2);
      // every fourth pixel: enough to tell, and a few ms on a big canvas
      for (var j = 0; j < u.length; j += 4) h = Math.imul(h ^ u[j], 0x01000193);
    }
    return h >>> 0;
  }

  /** hashLayers in slices of about 8 ms (a promise). Null if the drawing
   * changed meanwhile. */
  function hashLayersSliced() {
    return new Promise(function (resolve) {
      if (!Tegaki.layers || Tegaki.isPainting) return resolve(null);
      var layers = Tegaki.layers.slice();
      var rec = Tegaki.replayRecorder;
      var events = rec ? rec.events.length : -1;
      var h = 0x811c9dc5 | 0;
      var li = 0, j = 0, u = null;
      function mix(v) {
        h = Math.imul(h ^ v, 0x01000193);
      }
      function step() {
        if (Tegaki.isPainting || Tegaki.replayRecorder !== rec || (rec ? rec.events.length : -1) !== events) return resolve(null);
        var start = performance.now();
        while (li < layers.length) {
          if (!u) {
            var layer = layers[li];
            mix(layer.visible ? 1 : 2);
            mix(Math.round((layer.alpha == null ? 1 : layer.alpha) * 1000));
            var d = layer.imageData && layer.imageData.data;
            if (!d) {
              li++;
              continue;
            }
            u = new Uint32Array(d.buffer, d.byteOffset, d.byteLength >> 2);
            j = 0;
          }
          // (as hashLayers: every fourth pixel)
          var end = Math.min(u.length, j + 262144);
          for (; j < end; j += 4) h = Math.imul(h ^ u[j], 0x01000193);
          if (j >= u.length) {
            u = null;
            li++;
          }
          if (performance.now() - start > 8 && li < layers.length) return setTimeout(step, 0);
        }
        resolve(h >>> 0);
      }
      step();
    });
  }

  function sessionId() {
    var b = crypto.getRandomValues(new Uint8Array(6));
    return Array.from(b, function (x) { return x.toString(16).padStart(2, "0"); }).join("");
  }

  function pngOf(canvas) {
    return new Promise(function (resolve) {
      try {
        canvas.toBlob(function (blob) {
          if (!blob) return resolve(null);
          blob.arrayBuffer().then(function (buf) { resolve(new Uint8Array(buf)); }, function () { resolve(null); });
        }, "image/png");
      } catch (e) {
        resolve(null);
      }
    });
  }

  // --- saving ----------------------------------------------------------------

  /**
   * Saves the drawing to the device a moment after each change, and at once
   * when the page is hidden (mid-stroke too), without ending the recording.
   *
   * opts: key, width, height, mode ("record": the recording; "picture": a PNG
   * of the picture), restored (the copy this session was restored from, or
   * null), onsaved({at}), onfailed(error), onstate(state).
   * Call changed() after every change.
   */
  function Saver(opts) {
    this.key = opts.key;
    this.width = opts.width;
    this.height = opts.height;
    this.mode = opts.mode;
    this.onsaved = opts.onsaved;
    this.onfailed = opts.onfailed;
    this.onstate = opts.onstate;
    this.session = sessionId();
    this.everSaved = !!opts.restored;
    this.failed = false;
    this.yielded = false;
    this.deleted = false;
    this.disabled = false;
    this.dirty = false;
    this.saving = null;
    this.again = false;
    this.timer = 0;
    this.reported = "";
    this.deleting = null;
    /** sealed chunks of the recording: [{name, count}], and the events they
     * hold (the last one kept, to notice the events before it changing) */
    this.chunks = [];
    this.sealed = 0;
    this.sealedLast = null;
    this.head = null;
    this.saves = 0;
    this.lastStats = null;
    /** a save is due, waiting for the pen to lift */
    this.due = false;
    this.dueCheck = false;
    var self = this;
    // When to save: the copy has to be current before the page is left, not
    // when it is. A save is due SAVE_DELAY_MS after the first change since
    // the last one, and later changes don't put it off, so drawing without a
    // pause still saves (it waits for the pen to lift). Leaving is a bonus: a
    // page hidden (the app switcher, another tab; iOS delivers it before it
    // suspends the page) saves at once, up to the stroke under way; but a
    // page going into the back/forward cache (a swipe back in Safari or the
    // iOS app: pagehide, persisted, and the visibilitychange after it) starts
    // nothing, since WebKit freezes it right away and the write would never
    // run (it would only hold the store). What it held is saved when it is
    // shown again.
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden" && !isPageAway()) self.saveNow();
    });
    addEventListener("pagehide", function (e) {
      if (!e.persisted) self.saveNow();
    });
    onPageBack.push(function () {
      if (self.dirty && !self.deleted && !self.disabled) {
        clearTimeout(self.timer);
        self.timer = setTimeout(function () { self.onTimer(); }, 0);
      }
    });
  }

  Saver.prototype.state = function () {
    var pending = !this.yielded && !this.deleted && (this.dirty || !!this.saving || this.failed || !!Tegaki.isPainting);
    return { pending: pending, failed: this.failed, saved: this.everSaved && !this.failed, yielded: this.yielded };
  };

  Saver.prototype.report = function () {
    var s = this.state();
    var k = s.pending + "|" + s.failed + "|" + s.saved + "|" + s.yielded;
    if (k === this.reported) return;
    this.reported = k;
    try {
      if (this.onstate) this.onstate(s);
    } catch (e) {
      console.error("[autosave] onstate failed", e);
    }
  };

  Saver.prototype.changed = function () {
    if (this.deleted || this.disabled) return;
    var self = this;
    this.dirty = true;
    if (this.due && drawPen()) {
      // a save is due, waiting for the pen: it goes once the pen rests
      // (gatedSave)
    } else if (this.due) {
      // a save is due, waiting for the pen to lift: this change may be its
      // lifting (checked once it is recorded)
      if (!this.dueCheck) {
        this.dueCheck = true;
        setTimeout(function () {
          self.dueCheck = false;
          if (self.due && !Tegaki.isPainting) {
            clearTimeout(self.timer);
            self.onTimer();
          }
        }, 0);
      }
    } else if (!this.timer) {
      // (a save already due stands: later changes never put it off)
      this.timer = setTimeout(function () { self.onTimer(); }, SAVE_DELAY_MS);
    }
    this.report();
  };

  Saver.prototype.onTimer = function () {
    var self = this;
    this.timer = 0;
    if (!this.dirty || this.deleted || this.disabled || isPageAway()) {
      // (in the back/forward cache: saved when shown again)
      this.due = false;
      return;
    }
    if (drawPen()) return this.gatedSave();
    if (Tegaki.isPainting) {
      // mid-stroke: found here a moment later (a hidden page saves anyway)
      this.due = true;
      this.timer = setTimeout(function () { self.onTimer(); }, 250);
      return;
    }
    this.due = false;
    this.save();
  };

  /** On 2draw's draw page: the save once the pen rests (drawPen.idle: in a
   * pause between strokes; after a while of drawing without one, at the
   * next pen-up). */
  Saver.prototype.gatedSave = function () {
    var self = this;
    this.due = true;
    if (this.gateWaiting) return;
    this.gateWaiting = true;
    whenPenRests(function () {
      self.gateWaiting = false;
      if (!self.due) return;
      if (Tegaki.isPainting) {
        // (the pen of another frame, or none: Tegaki's own stroke under way)
        self.due = false;
        clearTimeout(self.timer);
        self.timer = setTimeout(function () { self.onTimer(); }, 250);
        return;
      }
      self.due = false;
      if (!self.dirty || self.deleted || self.disabled || isPageAway()) return;
      self.save();
    });
  };

  /** Saves at once if anything changed, up to the stroke under way. */
  Saver.prototype.saveNow = function () {
    if (!this.dirty || this.deleted || this.disabled) return this.saving || Promise.resolve();
    clearTimeout(this.timer);
    this.timer = 0;
    this.due = false;
    // (urgent: the page is hidden or left, or Close: no slices)
    return this.save(true);
  };

  /** Saves everything now and waits for it (Close: drawFlush). */
  Saver.prototype.flush = function () {
    var self = this, i = 0;
    function step() {
      if (i++ >= 3 || self.deleted || self.disabled || !(self.dirty || self.saving)) return Promise.resolve();
      return self.saveNow().then(step, step);
    }
    return step();
  };

  /** Another tab takes the drawing over: a last save, then no more. */
  Saver.prototype.yieldEdit = function () {
    var self = this;
    if (this.yielded) return Promise.resolve();
    return this.flush().catch(function () {}).then(function () {
      self.yielded = true;
      self.disabled = true;
      clearTimeout(self.timer);
      self.timer = 0;
      self.report();
    });
  };

  Saver.prototype.save = function (urgent) {
    var self = this;
    if (this.deleted || this.disabled) return Promise.resolve();
    if (this.saving) {
      this.again = true;
      if (urgent) this.urgent = true;
      return this.saving;
    }
    this.dirty = false;
    this.due = false;
    this.urgent = !!urgent;
    this.saving = Promise.resolve()
      .then(function () { return self.write(); })
      .then(function () {
        self.failed = false;
      }, function (err) {
        self.dirty = true;
        // (the page went into the back/forward cache: not a failure; saved
        // again when it is shown)
        if (err && err.name === "PageAwayError") return;
        // QuotaExceededError (the device is full) or a broken IndexedDB, still
        // broken through DB_RETRY_MS. Nothing it wrote counts, so the next try
        // writes it all again.
        console.warn("[autosave] couldn't save the drawing on this device", err);
        var first = !self.failed;
        self.failed = true;
        if (first) {
          try {
            if (self.onfailed) self.onfailed(err);
          } catch (e) {}
        }
        if (!self.timer && !self.deleted && !self.disabled) {
          self.timer = setTimeout(function () { self.onTimer(); }, RETRY_MS);
        }
      })
      .then(function () {
        self.saving = null;
        if (self.again) {
          self.again = false;
          if (self.dirty && !self.failed) {
            if (document.visibilityState === "hidden" || self.urgent) self.saveNow();
            else self.changed();
          }
        }
        self.urgent = false;
        self.report();
      });
    this.report();
    return this.saving;
  };

  Saver.prototype.write = function () {
    return this.mode === "picture" ? this.writePicture() : this.writeRecording();
  };

  /** The recording: new sealed chunks, and the rest as the tail. Off the
   * page being left (urgent), in slices (nextSlice): each new chunk, the
   * tail and the layers' hash a slice or a few, never in the middle of a
   * stroke. Begun again if the events before its end changed meanwhile (the
   * touch gestures take a just-begun stroke back out). */
  Saver.prototype.writeRecording = async function () {
    for (var attempt = 0; ; attempt++) {
      var r = await this.writeRecordingOnce(attempt >= 2 || this.urgent);
      if (r !== "again") return r;
    }
  };

  Saver.prototype.writeRecordingOnce = async function (urgent) {
    var self = this;
    var start = performance.now(), since = Date.now();
    var mainMs = 0, sliceStart = start;
    var rec = Tegaki.replayRecorder;
    if (!rec) return;
    var events = rec.events;
    var count = events.length;
    // stopped for a submit: its conclusion is not part of the drawing
    while (count > 0 && isConclusion(events[count - 1])) count--;
    var lastEv = count ? events[count - 1] : null;
    var n0 = events.length;
    var same = function () {
      return Tegaki.replayRecorder === rec && rec.events === events && events.length >= count && (!count || events[count - 1] === lastEv);
    };
    var slice = async function () {
      var t = performance.now();
      mainMs = Math.max(mainMs, t - sliceStart);
      await nextSlice(urgent, since);
      sliceStart = performance.now();
      return same();
    };
    var chunks = this.chunks.slice();
    var sealed = this.sealed;
    var sealedLast = this.sealedLast;
    // The touch gestures (tegaki-2draw.js endStroke) take a just-begun stroke
    // back out of the events: if that reached into a sealed chunk, seal again.
    if (sealed > 0 && (count < sealed || events[sealed - 1] !== sealedLast)) {
      chunks = [];
      sealed = 0;
      sealedLast = null;
    }
    var puts = [];
    var prefix = this.session + ":";
    // (never the last event: a colour or tool change may still replace it)
    while (count - 1 - sealed >= CHUNK_EVENTS) {
      var name = prefix + "c" + chunks.length + "-" + sealed;
      puts.push({ name: name, data: packEvents(events, sealed, sealed + CHUNK_EVENTS, []) });
      chunks.push({ name: name, count: CHUNK_EVENTS });
      sealed += CHUNK_EVENTS;
      sealedLast = events[sealed - 1];
      if (!urgent && !(await slice())) return "again";
    }
    // A stroke under way (the page is being hidden): the copy ends it here.
    var closing = [];
    var lastTime = count ? events[count - 1].timeStamp : 0;
    if (Tegaki.isPainting && count) closing.push(new TegakiEventDrawCommit(lastTime));
    var tail = packEvents(events, sealed, count, closing);
    var head = this.head || packHead(rec);
    var hash = null;
    if (!closing.length) {
      if (urgent) hash = hashLayers();
      else {
        if (!(await slice())) return "again";
        // (null when something was drawn meanwhile: this copy goes unchecked, the next has it)
        hash = await hashLayersSliced(false, since, function () { return same() && events.length === n0; });
        if (!same()) return "again";
      }
    }
    var syncMs = Math.max(mainMs, performance.now() - sliceStart);
    var saved = Date.now();
    var meta = {
      key: this.key,
      v: VERSION,
      tool: "tegaki",
      mode: "record",
      saved: saved,
      session: this.session,
      width: this.width,
      height: this.height,
      tegakiVersion: rec.tegakiVersion.slice(),
      formatVersion: rec.formatVersion,
      head: head,
      chunks: chunks,
      tail: tail,
      tailCount: count - sealed + closing.length,
      lastTime: lastTime,
      events: count + closing.length,
      hash: hash,
      openStroke: closing.length > 0,
    };
    var keep = new Set(chunks.map(function (c) { return c.name; }));
    if (self.deleted || self.disabled) return;
    // (chained: the stale pieces are found by a request, and deleted from its
    // callback; committed after that)
    return runTx([DRAFTS, PARTS], "readwrite", function (tx, finish) {
      var parts = tx.objectStore(PARTS);
      for (var i = 0; i < puts.length; i++) parts.put({ key: self.key, name: puts[i].name, data: puts[i].data });
      tx.objectStore(DRAFTS).put(meta);
      // pieces no longer named (an earlier session's, or resealed): go
      var keysReq = parts.getAllKeys(partsRange(self.key));
      keysReq.onsuccess = function () {
        var ks = keysReq.result || [];
        for (var j = 0; j < ks.length; j++) if (!keep.has(ks[j][1])) parts.delete(ks[j]);
        finish();
      };
    }, true).then(function () {
      self.chunks = chunks;
      self.sealed = sealed;
      self.sealedLast = sealedLast;
      self.head = head;
      self.everSaved = true;
      var wrote = tail.length;
      for (var k = 0; k < puts.length; k++) wrote += puts[k].data.length;
      self.saves++;
      self.lastStats = {
        at: saved,
        ms: Math.round((performance.now() - start) * 10) / 10,
        sync_ms: Math.round(syncMs * 10) / 10,
        bytes: wrote,
        events: meta.events,
        chunks: chunks.length,
        open_stroke: meta.openStroke,
      };
      console.log("[autosave] saved on this device: " + meta.events + " events" + (meta.openStroke ? " (mid-stroke)" : "") + ", wrote " + wrote + " bytes in " + self.lastStats.ms + " ms");
      try {
        if (self.onsaved) self.onsaved({ at: saved });
      } catch (e) {}
    });
  };

  /** Not recorded: a PNG of the picture. */
  Saver.prototype.writePicture = function () {
    var self = this;
    var saved = Date.now();
    var name = this.session + ":picture";
    return pngOf(Tegaki.flatten()).then(function (png) {
      if (!png) throw new Error("The picture could not be encoded");
      if (self.deleted || self.disabled) return;
      return runTx([DRAFTS, PARTS], "readwrite", function (tx, finish) {
        var parts = tx.objectStore(PARTS);
        parts.put({ key: self.key, name: name, data: png });
        tx.objectStore(DRAFTS).put({
          key: self.key,
          v: VERSION,
          tool: "tegaki",
          mode: "picture",
          saved: saved,
          session: self.session,
          width: self.width,
          height: self.height,
          picture: name,
        });
        var keysReq = parts.getAllKeys(partsRange(self.key));
        keysReq.onsuccess = function () {
          var ks = keysReq.result || [];
          for (var j = 0; j < ks.length; j++) if (ks[j][1] !== name) parts.delete(ks[j]);
          finish();
        };
      }, true).then(function () {
        self.everSaved = true;
        self.saves++;
        try {
          if (self.onsaved) self.onsaved({ at: saved });
        } catch (e) {}
      });
    });
  };

  /** After a successful submit, or Discard: stop saving and delete the copy. */
  Saver.prototype.delete = function () {
    var self = this;
    if (!this.deleting) {
      this.deleted = true;
      clearTimeout(this.timer);
      this.timer = 0;
      this.deleting = Promise.resolve(this.saving).catch(function () {}).then(function () { return deleteDraft(self.key); });
      this.deleting.then(function () { console.log("[autosave] deleted the device copy"); }, function () { self.deleting = null; });
      this.report();
    }
    return this.deleting;
  };

  // --- one editor per draft --------------------------------------------------

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /**
   * One editor per draft on this device (two tabs, or a tab and the iOS app).
   * The editor holds the Web Lock "tegaki-draft-edit:<key>". A new one that
   * finds it held posts "take" on BroadcastChannel("tegaki-draft:<key>"); the
   * holder answers "taking", saves (ontake, 2 s at most), lets go and posts
   * "released". The new one waits for that (4 s at most, then steals the
   * lock), and only then reads the copy, so it starts from everything the
   * other tab drew. As JSPaint.exe's take_edit_lock and Lascaux Pocket's.
   */
  function takeEditLock(key, ontake) {
    var tab = sessionId();
    var handle = { lost: false, held: false };
    var release = null, answered = null, released = null, channel = null;
    try {
      channel = new BroadcastChannel("tegaki-draft:" + key);
    } catch (e) {}
    function post(t) {
      try {
        if (channel) channel.postMessage({ t: t, from: tab });
      } catch (e) {}
    }
    function giveUp() {
      if (handle.lost) return;
      handle.lost = true;
      Promise.race([Promise.resolve().then(ontake), sleep(2000)]).catch(function (e) {
        console.error("[autosave] couldn't hand the drawing over", e);
      }).then(function () {
        if (release) release();
        release = null;
        post("released");
      });
    }
    if (channel) {
      channel.addEventListener("message", function (e) {
        var m = e.data || {};
        if (m.from === tab) return;
        if (m.t === "take" && handle.held && !handle.lost) {
          post("taking");
          giveUp();
        } else if (m.t === "taking") {
          if (answered) answered();
        } else if (m.t === "released") {
          if (released) released();
        }
      });
    }
    var locks = navigator.locks;
    if (!locks || !locks.request) {
      if (!channel) {
        handle.held = true;
        return Promise.resolve(handle);
      }
      return new Promise(function (resolve) {
        answered = function () { resolve(true); };
        setTimeout(function () { resolve(false); }, 250);
        post("take");
      }).then(function (yes) {
        if (!yes) return;
        return Promise.race([new Promise(function (r) { released = r; }), sleep(4000)]);
      }).then(function () {
        answered = released = null;
        handle.held = true;
        return handle;
      });
    }
    var letGo = function () {};
    var held = new Promise(function (r) { letGo = r; });
    var name = "tegaki-draft-edit:" + key;
    function request(options) {
      return new Promise(function (granted) {
        var mine = false;
        locks.request(name, options, function (lock) {
          if (!lock) {
            granted(false);
            return undefined;
          }
          mine = true;
          granted(true);
          return held;
        }).catch(function () {
          // stolen (by a tab that waited 4 s), or our own wait ran out
          if (mine) giveUp();
          else granted(false);
        });
      });
    }
    return request({ ifAvailable: true }).then(function (got) {
      if (got) return;
      post("take");
      var abort = new AbortController();
      var timer = setTimeout(function () { abort.abort(); }, 4000);
      return request({ signal: abort.signal }).then(function (got2) {
        clearTimeout(timer);
        if (got2) return;
        console.warn("[autosave] the other tab didn't let go of the drawing; taking it");
        return request({ steal: true });
      });
    }).then(function () {
      release = letGo;
      handle.held = true;
      return handle;
    });
  }

  /** Asks once per device for storage the browser won't evict. */
  function requestPersistentStorage() {
    try {
      var flag = "2draw-tegaki-persist-requested";
      if (localStorage.getItem(flag)) return;
      localStorage.setItem(flag, String(Date.now()));
    } catch (e) {}
    try {
      var s = navigator.storage;
      if (s && s.persisted && s.persist) {
        s.persisted().then(function (p) { return p ? true : s.persist(); }).then(function (g) {
          console.log("[autosave] persistent storage " + (g ? "granted" : "not granted"));
        }, function () {});
      }
    } catch (e) {}
  }

  window.TegakiDraft = {
    DB_NAME: DB_NAME,
    CHUNK_EVENTS: CHUNK_EVENTS,
    SAVE_DELAY_MS: SAVE_DELAY_MS,
    DB_RETRY_MS: DB_RETRY_MS,
    RETRY_MS: RETRY_MS,
    MAX_AGE_MS: MAX_AGE_MS,
    validKey: validKey,
    loadDraft: loadDraft,
    deleteDraft: deleteDraft,
    setDraftAside: setDraftAside,
    expireDrafts: expireDrafts,
    toTgkr: toTgkr,
    hashLayers: hashLayers,
    hashLayersSliced: hashLayersSliced,
    Saver: Saver,
    takeEditLock: takeEditLock,
    requestPersistentStorage: requestPersistentStorage,
  };
})();

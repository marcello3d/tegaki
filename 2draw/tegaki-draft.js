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
  /** Save this long after the last change. */
  var SAVE_DELAY_MS = 1500;
  /** After a failed save, try again this long after (and at every change). */
  var RETRY_MS = 5000;

  function validKey(key) {
    return typeof key === "string" && /^[0-9a-z_-]{4,64}$/.test(key);
  }

  // --- IndexedDB -------------------------------------------------------------

  var dbPromise = null;

  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise(function (resolve, reject) {
        if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB is not available"));
        var r = indexedDB.open(DB_NAME, 1);
        r.onupgradeneeded = function () {
          var db = r.result;
          if (!db.objectStoreNames.contains(DRAFTS)) db.createObjectStore(DRAFTS, { keyPath: "key" });
          if (!db.objectStoreNames.contains(PARTS)) db.createObjectStore(PARTS, { keyPath: ["key", "name"] });
        };
        r.onsuccess = function () {
          var db = r.result;
          db.onversionchange = function () {
            db.close();
            dbPromise = null;
          };
          resolve(db);
        };
        r.onerror = function () { reject(r.error); };
        r.onblocked = function () { reject(new Error("IndexedDB open blocked")); };
      });
      dbPromise.catch(function () { dbPromise = null; });
    }
    return dbPromise;
  }

  function req(r) {
    return new Promise(function (resolve, reject) {
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }

  function done(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error || new Error("transaction aborted")); };
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
    return openDb().then(function (db) {
      var tx = db.transaction([DRAFTS, PARTS], "readonly");
      return Promise.all([req(tx.objectStore(DRAFTS).get(key)), req(tx.objectStore(PARTS).getAll(partsRange(key)))]);
    }).then(function (got) {
      var meta = got[0];
      if (!meta) return null;
      if (meta.v !== VERSION) throw new Error("Unsupported device copy version " + meta.v);
      var parts = new Map();
      for (var i = 0; i < got[1].length; i++) parts.set(got[1][i].name, bytes(got[1][i].data));
      return { meta: meta, parts: parts };
    });
  }

  function deleteDraft(key) {
    return openDb().then(function (db) {
      var tx = db.transaction([DRAFTS, PARTS], "readwrite");
      tx.objectStore(DRAFTS).delete(key);
      tx.objectStore(PARTS).delete(partsRange(key));
      return done(tx);
    });
  }

  /** Keeps a copy that can't be opened for 30 more days (from now) under
   * another key, so a new session doesn't overwrite it. */
  function setDraftAside(key) {
    return openDb().then(function (db) {
      var tx = db.transaction([DRAFTS, PARTS], "readwrite");
      var drafts = tx.objectStore(DRAFTS), parts = tx.objectStore(PARTS);
      var aside = key + "~unreadable-" + Date.now();
      return req(drafts.get(key)).then(function (meta) {
        if (!meta) return done(tx);
        return req(parts.getAll(partsRange(key))).then(function (list) {
          for (var i = 0; i < list.length; i++) {
            parts.put({ key: aside, name: list[i].name, data: list[i].data });
          }
          var m = Object.assign({}, meta, { key: aside, set_aside: true, aside_at: Date.now() });
          drafts.put(m);
          drafts.delete(key);
          parts.delete(partsRange(key));
          return done(tx);
        });
      }).then(function () { return aside; });
    });
  }

  /** Deletes copies not saved (or set aside) for MAX_AGE_MS. */
  function expireDrafts(now) {
    now = now || Date.now();
    return openDb().then(function (db) {
      var tx = db.transaction([DRAFTS, PARTS], "readwrite");
      var drafts = tx.objectStore(DRAFTS), parts = tx.objectStore(PARTS);
      var count = 0;
      var c = drafts.openCursor();
      c.onsuccess = function () {
        var cur = c.result;
        if (!cur) return;
        var m = cur.value;
        var at = Math.max(typeof m.saved === "number" ? m.saved : 0, typeof m.aside_at === "number" ? m.aside_at : 0);
        if (!(at > 0 && now - at < MAX_AGE_MS)) {
          parts.delete(partsRange(m.key));
          cur.delete();
          count++;
        }
        cur.continue();
      };
      return done(tx).then(function () { return count; });
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

  /** A copy (loadDraft) as the bytes of a .tgkr, for continueReplay. */
  function toTgkr(draft) {
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
    var comp = UZIP.deflateRaw(data, { level: 1 });
    var out = new Uint8Array(12 + comp.length);
    var dv = new DataView(out.buffer);
    out[0] = 0x54;
    out[1] = 0x47;
    out[2] = 0x4b;
    out[3] = 1;
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
    this.lastChange = 0;
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
    var self = this;
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") self.saveNow();
    });
    addEventListener("pagehide", function () { self.saveNow(); });
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
    this.dirty = true;
    this.lastChange = performance.now();
    var self = this;
    if (!this.timer) this.timer = setTimeout(function () { self.onTimer(); }, SAVE_DELAY_MS);
    this.report();
  };

  Saver.prototype.onTimer = function () {
    var self = this;
    this.timer = 0;
    var since = performance.now() - this.lastChange;
    if (since < SAVE_DELAY_MS - 20) {
      this.timer = setTimeout(function () { self.onTimer(); }, SAVE_DELAY_MS - since);
      return;
    }
    if (Tegaki.isPainting) {
      // mid-stroke: wait for it to end (a hidden page saves anyway)
      this.timer = setTimeout(function () { self.onTimer(); }, 400);
      return;
    }
    var run = function () {
      if (Tegaki.isPainting) {
        self.timer = setTimeout(function () { self.onTimer(); }, 400);
        return;
      }
      self.save();
    };
    if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 1000 });
    else setTimeout(run, 0);
  };

  /** Saves at once if anything changed, up to the stroke under way. */
  Saver.prototype.saveNow = function () {
    if (!this.dirty || this.deleted || this.disabled) return this.saving || Promise.resolve();
    clearTimeout(this.timer);
    this.timer = 0;
    return this.save();
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

  Saver.prototype.save = function () {
    var self = this;
    if (this.deleted || this.disabled) return Promise.resolve();
    if (this.saving) {
      this.again = true;
      return this.saving;
    }
    this.dirty = false;
    this.saving = Promise.resolve()
      .then(function () { return self.write(); })
      .then(function () {
        self.failed = false;
      }, function (err) {
        // QuotaExceededError (the device is full) or a broken IndexedDB.
        // Nothing it wrote counts, so the next try writes it all again.
        console.warn("[autosave] couldn't save the drawing on this device", err);
        self.dirty = true;
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
            if (document.visibilityState === "hidden") self.saveNow();
            else self.changed();
          }
        }
        self.report();
      });
    this.report();
    return this.saving;
  };

  Saver.prototype.write = function () {
    return this.mode === "picture" ? this.writePicture() : this.writeRecording();
  };

  /** The recording: new sealed chunks, and the rest as the tail. */
  Saver.prototype.writeRecording = function () {
    var self = this;
    var start = performance.now();
    var rec = Tegaki.replayRecorder;
    if (!rec) return Promise.resolve();
    var events = rec.events;
    var count = events.length;
    // stopped for a submit: its conclusion is not part of the drawing
    while (count > 0 && isConclusion(events[count - 1])) count--;
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
    }
    // A stroke under way (the page is being hidden): the copy ends it here.
    var closing = [];
    var lastTime = count ? events[count - 1].timeStamp : 0;
    if (Tegaki.isPainting && count) closing.push(new TegakiEventDrawCommit(lastTime));
    var tail = packEvents(events, sealed, count, closing);
    var head = this.head || packHead(rec);
    var hash = closing.length ? null : hashLayers();
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
    var syncMs = performance.now() - start;
    return openDb().then(function (db) {
      if (self.deleted || self.disabled) return;
      var tx = db.transaction([DRAFTS, PARTS], "readwrite");
      var parts = tx.objectStore(PARTS);
      for (var i = 0; i < puts.length; i++) parts.put({ key: self.key, name: puts[i].name, data: puts[i].data });
      tx.objectStore(DRAFTS).put(meta);
      // pieces no longer named (an earlier session's, or resealed): go
      var keysReq = parts.getAllKeys(partsRange(self.key));
      keysReq.onsuccess = function () {
        var ks = keysReq.result || [];
        for (var j = 0; j < ks.length; j++) if (!keep.has(ks[j][1])) parts.delete(ks[j]);
      };
      return done(tx).then(function () {
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
    });
  };

  /** Not recorded: a PNG of the picture. */
  Saver.prototype.writePicture = function () {
    var self = this;
    var saved = Date.now();
    var name = this.session + ":picture";
    return pngOf(Tegaki.flatten()).then(function (png) {
      if (!png) throw new Error("The picture could not be encoded");
      return openDb().then(function (db) {
        if (self.deleted || self.disabled) return;
        var tx = db.transaction([DRAFTS, PARTS], "readwrite");
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
        };
        return done(tx).then(function () {
          self.everSaved = true;
          self.saves++;
          try {
            if (self.onsaved) self.onsaved({ at: saved });
          } catch (e) {}
        });
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
    RETRY_MS: RETRY_MS,
    MAX_AGE_MS: MAX_AGE_MS,
    validKey: validKey,
    loadDraft: loadDraft,
    deleteDraft: deleteDraft,
    setDraftAside: setDraftAside,
    expireDrafts: expireDrafts,
    toTgkr: toTgkr,
    hashLayers: hashLayers,
    Saver: Saver,
    takeEditLock: takeEditLock,
    requestPersistentStorage: requestPersistentStorage,
  };
})();

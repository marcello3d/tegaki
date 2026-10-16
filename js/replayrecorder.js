class TegakiReplayRecorder {
  constructor() {
    this.formatVersion = 1;
    
    this.compressed = true;
    
    this.tegakiVersion = Tegaki.VERSION.split('.').map((v) => +v);
    
    this.canvasWidth = Tegaki.baseWidth;
    this.canvasHeight = Tegaki.baseHeight;
    
    this.bgColor = $T.hexToRgb(Tegaki.bgColor);
    this.toolColor = $T.hexToRgb(Tegaki.toolColor);
    
    this.toolId = Tegaki.tools[Tegaki.defaultTool].id;
    
    this.toolList = this.buildToolList(Tegaki.tools);
    
    this.startTimeStamp = 0;
    this.endTimeStamp = 0;
    
    this.recording = false;
    
    this.events = [];
    
    // [2draw] Added to every timestamp: continueFrom() sets it so that this
    // session's events follow the earlier recording's.
    this.timeOffset = 0;
    
    this.mimeType = 'application/octet-stream';
  }
  
  buildToolList(tools) {
    var k, tool, toolMap;
    
    toolMap = [];
    
    for (k in tools) {
      tool = tools[k];
      
      toolMap.push({
        id: tool.id, 
        size: tool.size,
        alpha: tool.alpha,
        flow: tool.flow,
        step: tool.step,
        sizeDynamicsEnabled: +tool.sizeDynamicsEnabled,
        alphaDynamicsEnabled: +tool.alphaDynamicsEnabled,
        flowDynamicsEnabled: +tool.flowDynamicsEnabled,
        usePreserveAlpha: +tool.usePreserveAlpha,
        tipId: tool.tipId
      });
    }
    
    return toolMap;
  }
  
  start() {
    if (this.recording) {
      return;
    }
    
    if (this.endTimeStamp > 0) {
      this.events.pop();
      this.endTimeStamp = 0;
    }
    
    if (this.startTimeStamp === 0) {
      this.events.push(new TegakiEventPrelude(performance.now() + this.timeOffset));
      this.startTimeStamp = Date.now();
    }
    
    this.recording = true;
  }
  
  stop() {
    if (this.startTimeStamp === 0 || !this.recording) {
      return;
    }
    
    this.events.push(new TegakiEventConclusion(performance.now() + this.timeOffset));
    this.endTimeStamp = Date.now();
    this.recording = false;
  }
  
  push(e) {
    if (this.recording) {
      e.timeStamp += this.timeOffset;
      
      if (e.coalesce && this.events[this.events.length - 1].type === e.type) {
        this.events[this.events.length - 1] = e;
      }
      else {
        this.events.push(e);
      }
    }
  }
  
  // [2draw] Continues the recording `viewer` (a loaded TegakiReplayViewer):
  // its header (initial canvas and tool state) and its events, without the
  // conclusion, followed by this session's after a one second pause.
  continueFrom(viewer) {
    var id, events, last;
    
    this.canvasWidth = viewer.canvasWidth;
    this.canvasHeight = viewer.canvasHeight;
    this.bgColor = viewer.bgColor.slice();
    this.toolColor = viewer.toolColor.slice();
    this.toolId = viewer.toolId;
    
    this.toolList = [];
    
    for (id in viewer.toolMap) {
      this.toolList.push(viewer.toolMap[id]);
    }
    
    events = viewer.events.slice(0, -1);
    last = events[events.length - 1].timeStamp;
    
    this.events = events;
    this.startTimeStamp = viewer.startTimeStamp || Date.now();
    this.endTimeStamp = 0;
    this.timeOffset = last + 1000 - performance.now();
  }
  
  getEventStackSize() {
    var e, size;
    
    size = 4;
    
    for (e of this.events) {
      size += e.size;
    }
    
    return size;
  }
  
  getHeaderSize() {
    return 12;
  }
  
  getMetaSize() {
    return 21;
  }
  
  getToolSize() {
    return 19;
  }
  
  getToolListSize() {
    return 2 + (this.toolList.length * this.getToolSize());
  }
  
  writeToolList(w) {
    var tool, field, fields;
    
    fields = [
      ['id', 'Uint8'],
      ['size', 'Uint8'],
      ['alpha', 'Float32'],
      ['step', 'Float32'],
      ['sizeDynamicsEnabled', 'Uint8'],
      ['alphaDynamicsEnabled', 'Uint8'],
      ['usePreserveAlpha', 'Uint8'],
      ['tipId', 'Int8'],
      ['flow', 'Float32'],
      ['flowDynamicsEnabled', 'Uint8'],
    ];
    
    w.writeUint8(this.toolList.length);
    
    w.writeUint8(this.getToolSize());
    
    for (tool of this.toolList) {
      for (field of fields) {
        w['write' + field[1]](tool[field[0]]);
      }
    }
  }
  
  writeMeta(w) {
    w.writeUint16(this.getMetaSize());
    
    w.writeUint32(Math.ceil(this.startTimeStamp / 1000));
    w.writeUint32(Math.ceil(this.endTimeStamp / 1000));
    
    w.writeUint16(this.canvasWidth);
    w.writeUint16(this.canvasHeight);
    
    w.writeUint8(this.bgColor[0]);
    w.writeUint8(this.bgColor[1]);
    w.writeUint8(this.bgColor[2]);
    
    w.writeUint8(this.toolColor[0]);
    w.writeUint8(this.toolColor[1]);
    w.writeUint8(this.toolColor[2]);
    
    w.writeUint8(this.toolId);
  }
  
  writeEventStack(w) {
    var event;
    
    w.writeUint32(this.events.length);
    
    for (event of this.events) {
      event.pack(w);
    }
  }
  
  writeHeader(w, dataSize) {
    w.writeUint8(0x54);
    w.writeUint8(0x47);
    w.writeUint8(0x4B);
    
    w.writeUint8(+this.compressed);
    
    w.writeUint32(dataSize);
    
    w.writeUint8(this.tegakiVersion[0]);
    w.writeUint8(this.tegakiVersion[1]);
    w.writeUint8(this.tegakiVersion[2]);
    w.writeUint8(this.formatVersion);
  }
  
  compressData(w) {
    return UZIP.deflateRaw(new Uint8Array(w.buf), { level: 9 });
  }
  
  toUint8Array() {
    var headerSize, dataSize, data, w, compData, bytes;
    
    if (!this.startTimeStamp || !this.endTimeStamp) {
      return null;
    }
    
    headerSize = this.getHeaderSize();
    dataSize = this.getMetaSize() + this.getToolListSize() + this.getEventStackSize();
    
    data = new ArrayBuffer(dataSize);
    
    w = new TegakiBinWriter(data);
    
    this.writeMeta(w);
    
    this.writeToolList(w);
    
    this.writeEventStack(w);
    
    compData = this.compressData(w);
    //compData = new Uint8Array(data.slice(0));
    
    w = new TegakiBinWriter(new ArrayBuffer(headerSize + compData.length));
    
    this.writeHeader(w, dataSize);
    
    bytes = new Uint8Array(w.buf);
    
    bytes.set(compData, headerSize);
    
    return bytes;
  }
  
  toBlob() {
    var ary = this.toUint8Array();
    
    if (!ary) {
      return null;
    }
    
    return new Blob([ary.buffer], { type: this.mimeType });
  }
}

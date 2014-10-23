const object = require("sdk/util/object");
const task = require("../util/task");
const {URL} = require("sdk/url");

const {Class} = require("sdk/core/heritage");
const protocol = require("../devtools-require")("devtools/server/protocol");
const {asyncMethod} = require("../util/protocol-extra");
const {Actor, ActorClass, Pool, method, Arg, Option, RetVal, types, emit} = protocol;
const {LongStringActor} = require("../devtools-require")("devtools/server/actors/string");

const values = require("./value");
const preview = require("./preview");

const {normalize} = require("./resource-store");

protocol.types.addLifetime("pause", "pauseActor");
protocol.types.addLifetime("thread", "threadActor");

var PauseActor = ActorClass({
  typeName: "chromium_pauseactor",
  initialize: function(conn, rpc) {
    this.rpc = rpc;
    Actor.prototype.initialize.call(this, conn);
  },
  form: function(detail) { return this.actorID; }
});

var BreakpointActor = ActorClass({
  typeName: "chromium_breakpoint",
  initialize: function(thread, breakpointId) {
    this.thread = thread;
    this.breakpointId = breakpointId;
    Actor.prototype.initialize.call(this);

  },

  get conn() { return this.thread.conn },
  get rpc() { return this.thread.rpc },

  form: function(detail) {
    if (detail === "actorid") {
      return this.actorID;
    }
  },

  delete: asyncMethod(function*() {
    yield this.rpc.request("Debugger.removeBreakpoint", {
      breakpointId: this.breakpointId
    });
  }, {
    release: true,
  })
})

var EnvironmentActor = ActorClass({
  typeName: "chromium_environment",

  initialize: function(frame) {
    this.frame = frame;
    Actor.prototype.initialize.call(this);
  },

  get conn() { return this.frame.conn },
  get rpc() { return this.frame.rpc },

  form: function() {
    return {
      actorID: this.actorID
    }
  }
})

var FrameActor = ActorClass({
  typeName: "chromium_frame",
  initialize: function(thread, frame) {
    this.thread = thread;
    this.frame = frame;
    Actor.prototype.initialize.call(this);
    this.updatedPauseActor = null;
    this.environment = new EnvironmentActor(this);
    this.manage(this.environment);
  },

  get conn() { return this.thread.conn; },
  get rpc() { return this.thread.rpc; },
  get callFrameId() { return this.frame.callFrameId; },

  // This form method relies on faithful calling of updateActors.
  form: function(detail, ctx) {
    let location = this.frame.location;

    let source = this.thread.scriptSources.get(location.scriptId);
    if (source) {
      location = source.getRelativeLocation(location);
    }

    let form = {
      actor: this.actorID,
      type: "call",
      this: this.frameThis.form(null, this.thread.pauseActor),
      // The specification calls for this to be a grip, but it ain't easy
      // to get with chrome.
      callee: {
        name: this.frame.functionName
      },
      depth: this.depth,
      where: location,
      environment: this.environment.form(null, this)
    };

    // form.callee / grip(pause)
    // arguments / array:grip(pause)
    // oldest


    return form;
  },

  // Update all the actors needed for the form.
  updateActors: task.async(function*() {
    if (this.updatedPauseActor !== this.thread.pauseActor) {
      this.updatedPauseActor = this.thread.pauseActor;

      if (this.frameThis) {
        this.thread.unmanage(this.frameThis);
        this.frameThis = null;
      }

      if (this.thread.pauseActor) {
        yield preview.loadPreview(this.rpc, this.frame.this);
        if (!this.thread.pauseActor) {
          // We may have resumed during that call.
          return;
        }
        this.frameThis = values.grip(this.frame.this, this.thread.pauseActor);
      }
    }
  }),
});

var Stack = Class({
  initialize: function(thread) {
    this.thread = thread;
    this.frames = [];
    this.expired = [];
  },

  /**
   * Update frames and return a list of expired stack frames.
   */
  updateFrames: function(frames) {
    let i;
    // Find the common point of difference
    for (i = 0; i < this.frames.length && i < frames.length; i++) {
      this.frames[i].frame = frames[i];
      if (this.frames[i].callFrameId != frames[i].callFrameId) {
        break;
      }
    }

    let departure = i;
    for (i = departure; i < this.frames.length && i < frames.length; i++) {
      this.expired.push(this.frames[i]);
    }

    let newFrames = [];
    for (i = departure; i < frames.length; i++) {
      let frame = new FrameActor(this.thread, frames[i]);
      newFrames.push(frame);
    }

    this.frames.splice.apply(this.frames, [departure, this.frames.length].concat(newFrames));

    for (i = this.frames.length - 1; i >= 0; i--) {
      this.frames[i].depth = (this.frames.length - 1) - i;
    }

  },

  updateActors: task.async(function*() {
    for (let frame of this.frames) {
      yield frame.updateActors();
    }
  }),

  getYoungestFrame: function() {
    if (this.frames.length < 1) {
      return undefined;
    }
    return this.frames[this.frames.length - 1];
  },

  getFrame: function(callFrameId) {
    for (let frame of this.frames) {
      if (frame.callFrameId == callFrameId) {
        return frame;
      }
    }
    return null;
  },

  processExpired: function() {
    let expired = this.expired;
    this.expired = [];
    return expired;
  }
})

var SourceActor = ActorClass({
  typeName: "chromium_source",
  initialize: function(thread, url) {
    this.thread = thread;
    this.url = url;
    Actor.prototype.initialize.call(this);
    this.scripts = new Map();
  },

  get conn() { return this.thread.conn; },
  get rpc() { return this.thread.rpc; },

  marshallPool: function() { return this.thread; },

  form: function(detail) {
    return {
      actor: this.actorID,
      url: this.url,
      isBlackBoxed: false,
      isPrettyPrinted: false
    }
  },

  addScript: function(params) {
    this.scripts.set(params.scriptId, params);
  },

  getRelativeLocation: function(params) {
    let scriptId = params.scriptId;
    let scriptHandle = this.scripts.get(scriptId);

    return {
      url: this.url,
      line: params.lineNumber + (scriptHandle.sourceLine || 1),
      column: params.columnNumber
    }
  },

  cacheSource: task.async(function*() {
    if (this.cachedSource) {
      return this.cachedSource;
    }

    let source = "";
    let sourceLine = 1;

    if (this.scripts.size > 1) {
      source += "<script>\n";
      sourceLine++;
    }

    for (let [id, params] of this.scripts) {
      params.sourceLine = sourceLine;
      sourceLine += (params.endLine - params.startLine) + 1;
      if (source !== "") {
        source += "\n";
      }
      let response = yield this.rpc.request("Debugger.getScriptSource", {
        scriptId: id
      });
      source += response.scriptSource;
    }
    if (this.scripts.size > 1) {
      source += "\n</script>";
    }

    this.cachedSource = source;

    return this.cachedSource;
  }),

  source: asyncMethod(function*() {
    let cachedSource = yield this.cacheSource();
    return LongStringActor(this.conn, cachedSource);
  }, {
    response: {
      source: RetVal("longstring")
    }
  }),

  blackbox: method(function() {
  }, {
  }),

  unblackbox: method(function() {
  }, {
  }),

  prettyPrint: method(function() {
  }, {
  }),

  disablePrettyPrint: method(function() {
  }, {
  }),

  // Rewrite a chromium frame in this source as an RDP packet.
  frame: function(chromiumFrame) {
    let frame = {};
  }
});

var ChromiumThreadActor = ActorClass({
  typeName: "chromium_thread",

  events: {
    "exited": { type: "exited" },
    "paused": {
      type: "paused",
      actor: Option(0, "chromium_pauseactor"),
      why: Option(0, "string"),
      frame: Option(0, "chromium_frame"),
      poppedFrames: Option(0, "array:string")
    },
    "resumed": {
      type: "resumed"
    },
    "new-source": {
      type: "newSource",
      source: Arg(0, "chromium_source")
    }
  },

  initialize: function(tab) {
    this.tab = tab;
    Actor.prototype.initialize.call(this);

    this.rpc.on("Runtime.executionContextCreated", this.onExecutionContextCreated.bind(this));
    this.rpc.on("Runtime.executionContextDestroyed", this.onExecutionContextDestroyed.bind(this));

    this.rpc.on("Debugger.scriptParsed", this.onScriptParsed.bind(this));

    this.rpc.on("Debugger.paused", this.onPaused.bind(this));


    this.state = "detached";
    this.options = {};
    this._sources = new Map();
    this._breakpoints = new Map();
    this.scriptSources = new Map();
    this.stack = new Stack(this);

    this.config = {};
    this.exceptionState = "none";
  },

  get conn() { return this.tab.conn },
  get rpc() { return this.tab.rpc },

  form: function(detail) {
    return this.actorID;
  },

  onExecutionContextCreated: function(params) { },
  onExecutionContextDestroyed: function(params) { },

  onScriptParsed: function(params) {
    if (params.url === "") {
      console.log("Ignoring empty-url script.");
      return;
    }
    if (params.url === "about:firefox-resume-hack") {
      console.log("Ignoring implementation detail");
      return;
    }
    let source = this.sourceRef(params.url, params);
    emit(this, "new-source", source);
  },

  onPaused: task.async(function*(params) {
    // If this is the pause kick, or a pause that happened after we asked
    // for a pause kick, return.
    if (this.resuming && this.pauseOutstanding) {
      yield this.rpc.request("Debugger.resume");
      return;
    }

    params.callFrames.reverse();
    this.stack.updateFrames(params.callFrames);

    yield this.startPause({
      why: params.reason
    });
  }),

  sourceRef: function(url, script) {
    url = normalize(url);
    let source;
    if (!this._sources.has(url)) {
      source = new SourceActor(this, url);
      this._sources.set(url, source);
    } else {
      source = this._sources.get(url);
    }

    if (script) {
      this.scriptSources.set(script.scriptId, source);
      source.addScript(script);
    }

    return source;
  },

  breakpointRef: function(id) {
    if (this._breakpoints.has(id)) {
      return this._breakpoints.get(id);
    }

    let bp = BreakpointActor(this, id);
    this._breakpoints.set(id, bp);
    return bp;
  },

  unmanage: function(actor) {
    if (actor instanceof BreakpointActor) {
      this._breakpoints.delete(actor.breakpointId);
    }
    Actor.prototype.unmanage.call(this, actor);
  },

  startPause: task.async(function*(options={}) {
    this.state = "paused";

    this.pauseActor = new PauseActor(this.conn, this.rpc);
    this.manage(this.pauseActor);

    yield this.stack.updateActors();

    let packet = {
      pause: this.pauseActor,
      why: options.why,
      frame: this.stack.getYoungestFrame(),
      poppedFrames: []
    };

    let poppedFrames = this.stack.processExpired();
    for (let frame of poppedFrames) {
      packet.poppedFrames.push(frame.actorID);
      this.unmanage(frame);
    }

    emit(this, "paused", packet);
  }),

  stopPause: function() {
    this.unmanage(this.pauseActor);
    this.pauseActor = null;
    this.stack.updateFrames([]);
    emit(this, "resumed");
  },

  reconfigure: method(function(options = {}) {
    if (this.state === "exited") {
      throw new Error("Wrong state - current state is: " + this.state);
    }

    object.merge(this.options, options);

    // XXX: Reset sources?
  },{
    request: {
      options: Arg(0, "json")
    }
  }),

  attach: asyncMethod(function*(options) {
    if (this.state === "exited") {
      emit(this, "exited");
    }

    if (this.state !== "detached") {
      throw new Error("Wrong state - current state is: " + this.state);
    }

    yield this.rpc.request("Runtime.enable");
    yield this.rpc.request("Debugger.enable");

    this.state = "attached";
    this.attaching = true;
    yield this.pseudoPause({
      why: "attached"
    });

    // The pause handler will let us know that we're paused.
  }, {
    request: {
      useSourceMaps: Option(0, "boolean")
    },
    // State changes in the debugger are handled with events, not
    // responses.
    oneway: true,
  }),

  interrupt: asyncMethod(function*() {
    yield this.pseudoPause({
      why: "interrupted"
    });
    // XXX: This won't actually generate a pause yet!  Oh shit, is that what was
    // happening...
  }, {
    oneway: true
  }),

  pseudoPause: task.async(function*(options) {
    yield this.rpc.request("Debugger.pause");
    this.pauseOutstanding = true;
    this.startPause(options);
  }),

  getDesiredExceptionState: function() {
    if (this.config.pauseOnExceptions) {
      return options.ignoreCaughtException ? "uncaught" : "all"
    }
    return "none";
  },

  updateExceptionState: task.async(function*(state) {
    if (this.exceptionState != state) {
      yield this.rpc.request("Debugger.setPauseOnExceptions", {
        state: state
      });
      this.exceptionState = state;
    }
  }),

  resume: asyncMethod(function*(options) {
    if (this.state !== "paused") {
      throw new Error("Wrong state - current state is: " + this.state);
    }

    if (options.forceCompletion) {
      throw new Error("Can't force completion yet.");
    }

    let resumeCommand = "Debugger.resume";
    if (options.resumeLimit) {
      resumeCommand = {
        "next": "Debugger.stepOver",
        "step": "Debugger.stepInto",
        "finish": "Debugger.stepOut",
      }[options.resumeLimit.type];
    }

    this.config.pauseOnExceptions = options.pauseOnExceptions;
    this.config.ignoreCaughtExceptions = options.ignoreCaughtExceptions;

    console.log("Resuming");
    var wasKicked = false;

    if (this.pauseOutstanding) {
      this.resuming = true;
      yield this.updateExceptionState("all");
      // The engine has a pause requested but doesn't actually pause
      // until something happens. Evaluate a script to kick it into
      // the pause state, and `onPaused` which simply resume from here
      yield this.rpc.request("Runtime.evaluate", {
        expression: "5"
      });
      this.resuming = false;
      this.pauseOutstanding = false;
      wasKicked = true;
    }

    this.state = "running";
    yield this.updateExceptionState(this.getDesiredExceptionState());

    if(!wasKicked) {
      yield this.rpc.request(resumeCommand);
    }
  }, {
    oneway: true,
    request: {
      forceCompletion: Option(0, "json"),
      resumeLimit: Option(0, "json")
    }
  }),

  sources: method(function() {
    return this._sources.values();
  }, {
    request: {},
    response: {
      sources: RetVal("array:chromium_source")
    }
  }),

  frames: method(function(start, count) {
    if (this.state !== "paused") {
      throw new Error("Wrong state - current state is: " + this.state);
    }
    return this.stack.frames;
  }, {
    request: {
      start: Arg(0, "number"),
      count: Arg(1, "number")
    },
    response: {
      frames: RetVal("array:chromium_frame")
    }
  }),

  setBreakpoint: asyncMethod(function*(location, condition=undefined) {
    let response = yield this.rpc.request("Debugger.setBreakpointByUrl", {
      url: location.url,
      lineNumber: location.line - 1,
      columnNumber: location.column
    });

    let bp = this.breakpointRef(response.breakpointId);
    let setLocation = response.locations[0];

    let actualLocation = {
      url: location.url,
      line: setLocation.lineNumber + 1,
      column: setLocation.columnNumber
    };

    // Yeah, this only responds with the breakpoint and actual location
    // of one of the potentially many breakpoints, but that's because the
    // Firefox protocol's setBreakpoint method is stupid.

    // Firefox protocol doesn't return an actual location if
    // the one requested was used.
    if (actualLocation.line == location.line) {
//        (!("column" in location) || actualLocation.column === location.column)) {
      actualLocation = undefined;
    }

    return {
      actor: bp,
      actualLocation: actualLocation
    }
  }, {
    request: {
      location: Arg(0, "json"),
      condition: Arg(1, "nullable:string")
    },
    response: RetVal(types.addDictType("chromium_setBreakpointResponse", {
      actor: "chromium_breakpoint#actorid",
      actualLocation: "nullable:json"
    }))
  })

});
exports.ChromiumThreadActor = ChromiumThreadActor;

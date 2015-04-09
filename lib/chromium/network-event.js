const protocol = require("../devtools-require")("devtools/server/protocol");
const { asyncMethod, ActorClass, types } = require("../util/protocol-extra");
const { Actor, Pool, method, Arg, Option, RetVal, emit } = protocol;

/**
 * Creates an actor for a network event.
 *
 * @constructor
 * @param object|string netRequest
 *        The request nsIChannel or ID (for Valence) associated with this event.
 * @param object console
 *        The parent WebConsoleActor instance for this object.
 */
let NetworkEventActor = ActorClass({
  typeName: "netEvent",

  _request: null,
  _response: null,
  _timings: null,
  _longStringActors: null,

  initialize: function(netRequest, console) {
    Actor.prototype.initialize.call(this);
    this.parent = console;
    if (typeof netRequest == "string") {
      this.rpc = console.rpc;
    } else {
      this.conn = this.parent.conn;
    }
    this.netRequest = netRequest;

    this._request = {
      method: null,
      url: null,
      httpVersion: null,
      headers: [],
      cookies: [],
      headersSize: null,
      postData: {},
    };

    this._response = {
      headers: [],
      cookies: [],
      content: {},
    };

    this._timings = {};

    // Keep track of LongStringActors owned by this NetworkEventActor.
    this._longStringActors = new Set();
  },

  form: function(detail) {
    return {
      actor: this.actorID,
      startedDateTime: this._startedDateTime,
      url: this._request.url,
      method: this._request.method,
      isXHR: this._isXHR,
      private: this._private,
    };
  },

  /**
   * Releases this actor from the pool.
   */
  release: function()
  {
    for (let grip of this._longStringActors) {
      let actor = this.parent.getActorByID(grip.actor);
      if (actor) {
        this.parent.releaseActor(actor);
      }
    }
    this._longStringActors = new Set();

    if (this.netRequest) {
      this.parent._netEvents.delete(this.netRequest);
    }
    this.parent.releaseActor(this);
  },

  /**
   * Handle a protocol request to release a grip.
   */
  onRelease: method(function()
  {
    this.release();
  }, {
    request: {},
    response: {}
  }),

  /**
   * Since NetworkEventActor doesn't have a protocol.js parent actor that takes
   * care of its lifetime, implementing disconnect is required to cleanup.
   */
  disconnect: function() {
    this.release();
    Actor.prototype.destroy.call(this);
    this._longStringActors = null;
  },

  /**
   * Set the properties of this actor based on it's corresponding
   * network event.
   *
   * @param object networkEvent
   *        The network event associated with this actor.
   */
  init: function(networkEvent)
  {
    this._startedDateTime = networkEvent.startedDateTime;
    this._isXHR = networkEvent.isXHR;

    for (let prop of ['method', 'url', 'httpVersion', 'headersSize']) {
      this._request[prop] = networkEvent[prop];
    }

    this._discardRequestBody = networkEvent.discardRequestBody;
    this._discardResponseBody = networkEvent.discardResponseBody;
    this._private = networkEvent.private;
  },

  /**
   * The "getRequestHeaders" packet type handler.
   *
   * @return object
   *         The response packet - network request headers.
   */
  onGetRequestHeaders: function()
  {
    return {
      from: this.actorID,
      headers: this._request.headers,
      headersSize: this._request.headersSize,
      rawHeaders: this._request.rawHeaders,
    };
  },

  /**
   * The "getRequestCookies" packet type handler.
   *
   * @return object
   *         The response packet - network request cookies.
   */
  onGetRequestCookies: function NEA_onGetRequestCookies()
  {
    return {
      from: this.actorID,
      cookies: this._request.cookies,
    };
  },

  /**
   * The "getRequestPostData" packet type handler.
   *
   * @return object
   *         The response packet - network POST data.
   */
  onGetRequestPostData: function NEA_onGetRequestPostData()
  {
    return {
      from: this.actorID,
      postData: this._request.postData,
      postDataDiscarded: this._discardRequestBody,
    };
  },

  /**
   * The "getSecurityInfo" packet type handler.
   *
   * @return object
   *         The response packet - connection security information.
   */
  onGetSecurityInfo: function NEA_onGetSecurityInfo()
  {
    return {
      from: this.actorID,
      securityInfo: this._securityInfo,
    };
  },

  /**
   * The "getResponseHeaders" packet type handler.
   *
   * @return object
   *         The response packet - network response headers.
   */
  onGetResponseHeaders: function NEA_onGetResponseHeaders()
  {
    return {
      from: this.actorID,
      headers: this._response.headers,
      headersSize: this._response.headersSize,
      rawHeaders: this._response.rawHeaders,
    };
  },

  /**
   * The "getResponseCookies" packet type handler.
   *
   * @return object
   *         The response packet - network response cookies.
   */
  onGetResponseCookies: function NEA_onGetResponseCookies()
  {
    return {
      from: this.actorID,
      cookies: this._response.cookies,
    };
  },

  /**
   * The "getResponseContent" packet type handler.
   *
   * @return object
   *         The response packet - network response content.
   */
  onGetResponseContent: function NEA_onGetResponseContent()
  {
    return {
      from: this.actorID,
      content: this._response.content,
      contentDiscarded: this._discardResponseBody,
    };
  },

  /**
   * The "getEventTimings" packet type handler.
   *
   * @return object
   *         The response packet - network event timings.
   */
  onGetEventTimings: function NEA_onGetEventTimings()
  {
    return {
      from: this.actorID,
      timings: this._timings,
      totalTime: this._totalTime,
    };
  },

  /******************************************************************
   * Listeners for new network event data coming from NetworkMonitor.
   ******************************************************************/

  /**
   * Add network request headers.
   *
   * @param array aHeaders
   *        The request headers array.
   * @param string aRawHeaders
   *        The raw headers source.
   */
  addRequestHeaders: function NEA_addRequestHeaders(aHeaders, aRawHeaders)
  {
    this._request.headers = aHeaders;
    this._prepareHeaders(aHeaders);

    var rawHeaders = this.parent._createStringGrip(aRawHeaders);
    if (typeof rawHeaders == "object") {
      this._longStringActors.add(rawHeaders);
    }
    this._request.rawHeaders = rawHeaders;

    let packet = {
      from: this.actorID,
      type: "networkEventUpdate",
      updateType: "requestHeaders",
      headers: aHeaders.length,
      headersSize: this._request.headersSize,
    };

    this.conn.send(packet);
  },

  /**
   * Add network request cookies.
   *
   * @param array aCookies
   *        The request cookies array.
   */
  addRequestCookies: function NEA_addRequestCookies(aCookies)
  {
    this._request.cookies = aCookies;
    this._prepareHeaders(aCookies);

    let packet = {
      from: this.actorID,
      type: "networkEventUpdate",
      updateType: "requestCookies",
      cookies: aCookies.length,
    };

    this.conn.send(packet);
  },

  /**
   * Add network request POST data.
   *
   * @param object aPostData
   *        The request POST data.
   */
  addRequestPostData: function NEA_addRequestPostData(aPostData)
  {
    this._request.postData = aPostData;
    aPostData.text = this.parent._createStringGrip(aPostData.text);
    if (typeof aPostData.text == "object") {
      this._longStringActors.add(aPostData.text);
    }

    let packet = {
      from: this.actorID,
      type: "networkEventUpdate",
      updateType: "requestPostData",
      dataSize: aPostData.text.length,
      discardRequestBody: this._discardRequestBody,
    };

    this.conn.send(packet);
  },

  /**
   * Add the initial network response information.
   *
   * @param object aInfo
   *        The response information.
   * @param string aRawHeaders
   *        The raw headers source.
   */
  addResponseStart: function NEA_addResponseStart(aInfo, aRawHeaders)
  {
    var rawHeaders = this.parent._createStringGrip(aRawHeaders);
    if (typeof rawHeaders == "object") {
      this._longStringActors.add(rawHeaders);
    }
    this._response.rawHeaders = rawHeaders;

    this._response.httpVersion = aInfo.httpVersion;
    this._response.status = aInfo.status;
    this._response.statusText = aInfo.statusText;
    this._response.headersSize = aInfo.headersSize;
    this._discardResponseBody = aInfo.discardResponseBody;

    let packet = {
      from: this.actorID,
      type: "networkEventUpdate",
      updateType: "responseStart",
      response: aInfo,
    };

    this.conn.send(packet);
  },

  /**
   * Add connection security information.
   *
   * @param object info
   *        The object containing security information.
   */
  addSecurityInfo: function NEA_addSecurityInfo(info)
  {
    this._securityInfo = info;

    let packet = {
      from: this.actorID,
      type: "networkEventUpdate",
      updateType: "securityInfo",
      state: info.state,
    };

    this.conn.send(packet);
  },

  /**
   * Add network response headers.
   *
   * @param array aHeaders
   *        The response headers array.
   */
  addResponseHeaders: function NEA_addResponseHeaders(aHeaders)
  {
    this._response.headers = aHeaders;
    this._prepareHeaders(aHeaders);

    let packet = {
      from: this.actorID,
      type: "networkEventUpdate",
      updateType: "responseHeaders",
      headers: aHeaders.length,
      headersSize: this._response.headersSize,
    };

    this.conn.send(packet);
  },

  /**
   * Add network response cookies.
   *
   * @param array aCookies
   *        The response cookies array.
   */
  addResponseCookies: function NEA_addResponseCookies(aCookies)
  {
    this._response.cookies = aCookies;
    this._prepareHeaders(aCookies);

    let packet = {
      from: this.actorID,
      type: "networkEventUpdate",
      updateType: "responseCookies",
      cookies: aCookies.length,
    };

    this.conn.send(packet);
  },

  /**
   * Add network response content.
   *
   * @param object aContent
   *        The response content.
   * @param boolean aDiscardedResponseBody
   *        Tells if the response content was recorded or not.
   */
  addResponseContent:
  function NEA_addResponseContent(aContent, aDiscardedResponseBody)
  {
    this._response.content = aContent;
    aContent.text = this.parent._createStringGrip(aContent.text);
    if (typeof aContent.text == "object") {
      this._longStringActors.add(aContent.text);
    }

    let packet = {
      from: this.actorID,
      type: "networkEventUpdate",
      updateType: "responseContent",
      mimeType: aContent.mimeType,
      contentSize: aContent.text.length,
      transferredSize: aContent.transferredSize,
      discardResponseBody: aDiscardedResponseBody,
    };

    this.conn.send(packet);
  },

  /**
   * Add network event timing information.
   *
   * @param number aTotal
   *        The total time of the network event.
   * @param object aTimings
   *        Timing details about the network event.
   */
  addEventTimings: function NEA_addEventTimings(aTotal, aTimings)
  {
    this._totalTime = aTotal;
    this._timings = aTimings;

    let packet = {
      from: this.actorID,
      type: "networkEventUpdate",
      updateType: "eventTimings",
      totalTime: aTotal,
    };

    this.conn.send(packet);
  },

  /**
   * Prepare the headers array to be sent to the client by using the
   * LongStringActor for the header values, when needed.
   *
   * @private
   * @param array aHeaders
   */
  _prepareHeaders: function NEA__prepareHeaders(aHeaders)
  {
    for (let header of aHeaders) {
      header.value = this.parent._createStringGrip(header.value);
      if (typeof header.value == "object") {
        this._longStringActors.add(header.value);
      }
    }
  },
});

NetworkEventActor.prototype.requestTypes =
{
  "release": NetworkEventActor.prototype.onRelease,
  "getRequestHeaders": NetworkEventActor.prototype.onGetRequestHeaders,
  "getRequestCookies": NetworkEventActor.prototype.onGetRequestCookies,
  "getRequestPostData": NetworkEventActor.prototype.onGetRequestPostData,
  "getResponseHeaders": NetworkEventActor.prototype.onGetResponseHeaders,
  "getResponseCookies": NetworkEventActor.prototype.onGetResponseCookies,
  "getResponseContent": NetworkEventActor.prototype.onGetResponseContent,
  "getEventTimings": NetworkEventActor.prototype.onGetEventTimings,
  "getSecurityInfo": NetworkEventActor.prototype.onGetSecurityInfo,
};

exports.NetworkEventActor = NetworkEventActor;

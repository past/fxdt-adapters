const { Class } = require("sdk/core/heritage");
const { URL } = require("sdk/url");
const { asyncMethod } = require("../util/protocol-extra");
const NetworkHelper = require("../devtools-require")("devtools/toolkit/webconsole/network-helper");

let NetworkMonitor = Class({
  /**
   * Whether to save the bodies of network requests and responses. Disabled by
   * default to save memory.
   * @type boolean
   */
  saveRequestAndResponseBodies: false,

  initialize: function(console) {
    this.owner = console;
    this.rpc = console.rpc;

    this.onRequestWillBeSent = this.onRequestWillBeSent.bind(this);
    this.onRequestServedFromCache = this.onRequestServedFromCache.bind(this);
    this.onResponseReceived = this.onResponseReceived.bind(this);
    this.onDataReceived = this.onDataReceived.bind(this);
    this.onLoadingFinished = this.onLoadingFinished.bind(this);
    this.onLoadingFailed = this.onLoadingFailed.bind(this);
  },

  start: asyncMethod(function*() {
    yield this.rpc.on("Network.requestWillBeSent", this.onRequestWillBeSent);
    yield this.rpc.on("Network.requestServedFromCache",
                      this.onRequestServedFromCache);
    yield this.rpc.on("Network.responseReceived", this.onResponseReceived);
    yield this.rpc.on("Network.dataReceived", this.onDataReceived);
    yield this.rpc.on("Network.loadingFinished", this.onLoadingFinished);
    yield this.rpc.on("Network.loadingFailed", this.onLoadingFailed);
  }),

  destroy: function() {
    yield this.rpc.off("Network.requestWillBeSent", this.onRequestWillBeSent);
    yield this.rpc.off("Network.requestServedFromCache",
                       this.onRequestServedFromCache);
    yield this.rpc.off("Network.responseReceived", this.onResponseReceived);
    yield this.rpc.off("Network.dataReceived", this.onDataReceived);
    yield this.rpc.off("Network.loadingFinished", this.onLoadingFinished);
    yield this.rpc.off("Network.loadingFailed", this.onLoadingFailed);
  },

  onRequestWillBeSent: function({ requestId, frameId, loaderId, documentURL, request,
                             timestamp, initiator, redirectResponse, type}) {
    let url = new URL(request.url);
    let httpActivity = this.createActivityObject({ requestId, url });
    httpActivity.charset = null; // XXX: win ? win.document.characterSet : null;
    httpActivity.private = false; // XXX
    httpActivity.timings.REQUEST_HEADER = {
      first: timestamp,
      last: timestamp
    };

    let event = {};
    event.startedDateTime = new Date(Math.round(timestamp / 1000)).toISOString();
    event.method = request.method;
    event.url = request.url;
    event.private = httpActivity.private;
    httpActivity.isXHR = event.isXHR = type == "XHR";

    event.httpVersion = null; // XXX: "HTTP/1.1"
    event.discardRequestBody = !this.saveRequestAndResponseBodies;
    event.discardResponseBody = !this.saveRequestAndResponseBodies;

    let headers = [];
    let cookies = [];
    let cookieHeader = null;

    // Copy the request header data.
    let headerString = "";
    for (let name of Object.keys(request.headers) {
      let value = request.headers[name];
      headerString += name + ": " + value + "\n";
      if (name == "Cookie") {
        cookieHeader = value;
      }
      headers.push({ name, value });
    }
    event.headersSize = headerString.length;

    if (cookieHeader) {
      cookies = NetworkHelper.parseCookieHeader(cookieHeader);
    }

    httpActivity.owner = this.owner.onNetworkEvent(event, requestId, this);

    this.openRequests[httpActivity.id] = httpActivity;
    httpActivity.owner.addRequestHeaders(headers, headerString);
    httpActivity.owner.addRequestCookies(cookies);
  },

  onRequestServedFromCache: function() {

  },

  onResponseReceived: function() {

  },

  onDataReceived: function() {

  },

  onLoadingFinished: function() {

  },

  onLoadingFailed: function() {

  },

  /**
   * Create the empty HTTP activity object. This object is used for storing all
   * the request and response information.
   *
   * This is a HAR-like object. Conformance to the spec is not guaranteed at
   * this point.
   *
   * TODO: Bug 708717 - Add support for network log export to HAR
   *
   * @see http://www.softwareishard.com/blog/har-12-spec
   * @param string requestId
   *        The ID of the network request that corresponds to the HTTP activity
   *        that is going to be created.
   * @param URL url
   *        The URL of the network request.
   * @return object
   *         The new HTTP activity object.
   */
  createActivityObject: function({ requestId, url }) {
    return {
      id: gSequenceId(),
      channel: requestId,
      charset: null, // see NM__onRequestHeader()
      url: url.href,
      hostname: url.host, // needed for host specific security info
      discardRequestBody: !this.saveRequestAndResponseBodies,
      discardResponseBody: !this.saveRequestAndResponseBodies,
      timings: {}, // internal timing information, see NM_observeActivity()
      responseStatus: null, // see NM__onResponseHeader()
      owner: null, // the activity owner which is notified when changes happen
    };
  },

});

exports.NetworkMonitor = NetworkMonitor;

function gSequenceId() { return gSequenceId.n++; }
gSequenceId.n = 1;

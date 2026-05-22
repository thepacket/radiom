/* rfwhisper-worklet.js — RNNoise-backed noise reducer (RFWhisper integration).
 *
 * AudioWorkletProcessor that applies RNNoise GRU-based noise suppression.
 * RNNoise is the lightweight model vendored by JakenHerman/RFWhisper.
 *
 * Main-thread handshake:
 *   1. Main thread fetches /rnnoise.wasm as ArrayBuffer.
 *   2. Main thread creates AudioWorkletNode('rfwhisper') and sends:
 *        node.port.postMessage({ type: 'init', wasmBinary: <ArrayBuffer> }, [<ArrayBuffer>])
 *   3. Worklet instantiates the WASM with the pre-fetched binary (avoids any
 *      fetch attempt from the worklet context, which is not a regular Worker).
 *   4. Worklet replies { type: 'ready' } when the WASM state is allocated.
 *
 * Toggles: node.port.postMessage({ enabled: true/false })
 *
 * Frame size: RNNoise requires exactly 480 float32 samples at 48 kHz.
 * AudioWorklet quanta are 128 samples, so samples accumulate until a full
 * 480-sample frame is ready, then rnnoise_process_frame runs synchronously.
 * This introduces ~10 ms of buffering latency (inaudible).
 *
 * Scaling: RNNoise expects and returns samples in the int16 amplitude range
 * (−32768 … 32767). Input is scaled ×32768 on entry, ÷32768 on exit.
 */

// ── Emscripten-compiled RNNoise glue ─────────────────────────────────────────
// Derived from @jitsi/rnnoise-wasm dist/rnnoise.js (Apache-2.0 / BSD).
// ES-module export removed; factory called with { wasmBinary } to skip fetch.
var createRNNWasmModule = (() => {
  return (
function(createRNNWasmModule) {
  createRNNWasmModule = createRNNWasmModule || {};

var Module = typeof createRNNWasmModule != "undefined" ? createRNNWasmModule : {};

var readyPromiseResolve, readyPromiseReject;

Module["ready"] = new Promise(function(resolve, reject) {
 readyPromiseResolve = resolve;
 readyPromiseReject = reject;
});

var moduleOverrides = Object.assign({}, Module);

var arguments_ = [];

var thisProgram = "./this.program";

var quit_ = (status, toThrow) => {
 throw toThrow;
};

var ENVIRONMENT_IS_WEB = typeof window == "object";
var ENVIRONMENT_IS_WORKER = typeof importScripts == "function";
var ENVIRONMENT_IS_NODE = typeof process == "object" && typeof process.versions == "object" && typeof process.versions.node == "string";

var scriptDirectory = "";

function locateFile(path) {
 if (Module["locateFile"]) return Module["locateFile"](path, scriptDirectory);
 return scriptDirectory + path;
}

var read_, readAsync, readBinary, setWindowTitle;

if (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) {
 if (ENVIRONMENT_IS_WORKER) {
  scriptDirectory = self.location.href;
 } else if (typeof document != "undefined" && document.currentScript) {
  scriptDirectory = document.currentScript.src;
 }
 if (scriptDirectory.indexOf("blob:") !== 0) {
  scriptDirectory = scriptDirectory.substr(0, scriptDirectory.replace(/[?#].*/, "").lastIndexOf("/") + 1);
 } else {
  scriptDirectory = "";
 }
 read_ = url => {
  var xhr = new XMLHttpRequest();
  xhr.open("GET", url, false);
  xhr.send(null);
  return xhr.responseText;
 };
 if (ENVIRONMENT_IS_WORKER) {
  readBinary = url => {
   var xhr = new XMLHttpRequest();
   xhr.open("GET", url, false);
   xhr.responseType = "arraybuffer";
   xhr.send(null);
   return new Uint8Array(xhr.response);
  };
 }
 readAsync = (url, onload, onerror) => {
  var xhr = new XMLHttpRequest();
  xhr.open("GET", url, true);
  xhr.responseType = "arraybuffer";
  xhr.onload = () => {
   if (xhr.status == 200 || (xhr.status == 0 && xhr.response)) { onload(xhr.response); return; }
   onerror();
  };
  xhr.onerror = onerror;
  xhr.send(null);
 };
 setWindowTitle = title => {};
}

var out = Module["print"] || console.log.bind(console);
var err = Module["printErr"] || console.warn.bind(console);

Object.assign(Module, moduleOverrides);
moduleOverrides = null;

if (Module["arguments"]) arguments_ = Module["arguments"];
if (Module["thisProgram"]) thisProgram = Module["thisProgram"];
if (Module["quit"]) quit_ = Module["quit"];

var wasmBinary;
if (Module["wasmBinary"]) wasmBinary = Module["wasmBinary"];

var noExitRuntime = Module["noExitRuntime"] || true;

if (typeof WebAssembly != "object") abort("no native wasm support detected");

var wasmMemory;
var ABORT = false;
var EXITSTATUS;
var buffer, HEAP8, HEAPU8, HEAP16, HEAPU16, HEAP32, HEAPU32, HEAPF32, HEAPF64;

function updateGlobalBufferAndViews(buf) {
 buffer = buf;
 Module["HEAP8"] = HEAP8 = new Int8Array(buf);
 Module["HEAP16"] = HEAP16 = new Int16Array(buf);
 Module["HEAP32"] = HEAP32 = new Int32Array(buf);
 Module["HEAPU8"] = HEAPU8 = new Uint8Array(buf);
 Module["HEAPU16"] = HEAPU16 = new Uint16Array(buf);
 Module["HEAPU32"] = HEAPU32 = new Uint32Array(buf);
 Module["HEAPF32"] = HEAPF32 = new Float32Array(buf);
 Module["HEAPF64"] = HEAPF64 = new Float64Array(buf);
}

var INITIAL_MEMORY = Module["INITIAL_MEMORY"] || 16777216;
var wasmTable;
var __ATPRERUN__ = [], __ATINIT__ = [], __ATPOSTRUN__ = [];
var runtimeInitialized = false;

function preRun() {
 if (Module["preRun"]) {
  if (typeof Module["preRun"] == "function") Module["preRun"] = [Module["preRun"]];
  while (Module["preRun"].length) addOnPreRun(Module["preRun"].shift());
 }
 callRuntimeCallbacks(__ATPRERUN__);
}
function initRuntime() { runtimeInitialized = true; callRuntimeCallbacks(__ATINIT__); }
function postRun() {
 if (Module["postRun"]) {
  if (typeof Module["postRun"] == "function") Module["postRun"] = [Module["postRun"]];
  while (Module["postRun"].length) addOnPostRun(Module["postRun"].shift());
 }
 callRuntimeCallbacks(__ATPOSTRUN__);
}
function addOnPreRun(cb) { __ATPRERUN__.unshift(cb); }
function addOnInit(cb)   { __ATINIT__.unshift(cb); }
function addOnPostRun(cb){ __ATPOSTRUN__.unshift(cb); }

var runDependencies = 0;
var runDependencyWatcher = null;
var dependenciesFulfilled = null;

function addRunDependency(id) {
 runDependencies++;
 if (Module["monitorRunDependencies"]) Module["monitorRunDependencies"](runDependencies);
}
function removeRunDependency(id) {
 runDependencies--;
 if (Module["monitorRunDependencies"]) Module["monitorRunDependencies"](runDependencies);
 if (runDependencies == 0) {
  if (runDependencyWatcher !== null) { clearInterval(runDependencyWatcher); runDependencyWatcher = null; }
  if (dependenciesFulfilled) { var callback = dependenciesFulfilled; dependenciesFulfilled = null; callback(); }
 }
}

function abort(what) {
 if (Module["onAbort"]) Module["onAbort"](what);
 what = "Aborted(" + what + ")";
 err(what);
 ABORT = true;
 EXITSTATUS = 1;
 what += ". Build with -sASSERTIONS for more info.";
 var e = new WebAssembly.RuntimeError(what);
 readyPromiseReject(e);
 throw e;
}

var dataURIPrefix = "data:application/octet-stream;base64,";
function isDataURI(filename) { return filename.startsWith(dataURIPrefix); }

var wasmBinaryFile = "rnnoise.wasm";
if (!isDataURI(wasmBinaryFile)) wasmBinaryFile = locateFile(wasmBinaryFile);

function getBinary(file) {
 try {
  if (file == wasmBinaryFile && wasmBinary) return new Uint8Array(wasmBinary);
  if (readBinary) return readBinary(file);
  throw "both async and sync fetching of the wasm failed";
 } catch (err) { abort(err); }
}

function getBinaryPromise() {
 if (!wasmBinary && (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER)) {
  if (typeof fetch == "function") {
   return fetch(wasmBinaryFile, { credentials: "same-origin" }).then(function(response) {
    if (!response["ok"]) throw "failed to load wasm binary file at '" + wasmBinaryFile + "'";
    return response["arrayBuffer"]();
   }).catch(function() { return getBinary(wasmBinaryFile); });
  }
 }
 return Promise.resolve().then(function() { return getBinary(wasmBinaryFile); });
}

function createWasm() {
 var info = { "a": asmLibraryArg };
 function receiveInstance(instance, module) {
  var exports = instance.exports;
  Module["asm"] = exports;
  wasmMemory = Module["asm"]["c"];
  updateGlobalBufferAndViews(wasmMemory.buffer);
  wasmTable = Module["asm"]["k"];
  addOnInit(Module["asm"]["d"]);
  removeRunDependency("wasm-instantiate");
 }
 addRunDependency("wasm-instantiate");
 function receiveInstantiationResult(result) { receiveInstance(result["instance"]); }
 function instantiateArrayBuffer(receiver) {
  return getBinaryPromise().then(function(binary) {
   return WebAssembly.instantiate(binary, info);
  }).then(function(instance) { return instance; }).then(receiver, function(reason) {
   err("failed to asynchronously prepare wasm: " + reason);
   abort(reason);
  });
 }
 function instantiateAsync() {
  if (!wasmBinary && typeof WebAssembly.instantiateStreaming == "function" && !isDataURI(wasmBinaryFile) && typeof fetch == "function") {
   return fetch(wasmBinaryFile, { credentials: "same-origin" }).then(function(response) {
    var result = WebAssembly.instantiateStreaming(response, info);
    return result.then(receiveInstantiationResult, function(reason) {
     err("wasm streaming compile failed: " + reason);
     err("falling back to ArrayBuffer instantiation");
     return instantiateArrayBuffer(receiveInstantiationResult);
    });
   });
  } else {
   return instantiateArrayBuffer(receiveInstantiationResult);
  }
 }
 if (Module["instantiateWasm"]) {
  try {
   var exports = Module["instantiateWasm"](info, receiveInstance);
   return exports;
  } catch (e) {
   err("Module.instantiateWasm callback failed with error: " + e);
   return false;
  }
 }
 instantiateAsync().catch(readyPromiseReject);
 return {};
}

function callRuntimeCallbacks(callbacks) {
 while (callbacks.length > 0) {
  var callback = callbacks.shift();
  if (typeof callback == "function") { callback(Module); continue; }
  var func = callback.func;
  if (typeof func == "number") {
   if (callback.arg === undefined) getWasmTableEntry(func)();
   else getWasmTableEntry(func)(callback.arg);
  } else { func(callback.arg === undefined ? null : callback.arg); }
 }
}
function getWasmTableEntry(funcPtr) { return wasmTable.get(funcPtr); }

function _emscripten_memcpy_big(dest, src, num) { HEAPU8.copyWithin(dest, src, src + num); }
function getHeapMax() { return 2147483648; }
function emscripten_realloc_buffer(size) {
 try {
  wasmMemory.grow(size - buffer.byteLength + 65535 >>> 16);
  updateGlobalBufferAndViews(wasmMemory.buffer);
  return 1;
 } catch (e) {}
}
function _emscripten_resize_heap(requestedSize) {
 var oldSize = HEAPU8.length;
 requestedSize = requestedSize >>> 0;
 var maxHeapSize = getHeapMax();
 if (requestedSize > maxHeapSize) return false;
 let alignUp = (x, multiple) => x + (multiple - x % multiple) % multiple;
 for (var cutDown = 1; cutDown <= 4; cutDown *= 2) {
  var overGrownHeapSize = oldSize * (1 + .2 / cutDown);
  overGrownHeapSize = Math.min(overGrownHeapSize, requestedSize + 100663296);
  var newSize = Math.min(maxHeapSize, alignUp(Math.max(requestedSize, overGrownHeapSize), 65536));
  var replacement = emscripten_realloc_buffer(newSize);
  if (replacement) return true;
 }
 return false;
}

var asmLibraryArg = {
 "b": _emscripten_memcpy_big,
 "a": _emscripten_resize_heap
};

var asm = createWasm();

var ___wasm_call_ctors = Module["___wasm_call_ctors"] = function() {
 return (___wasm_call_ctors = Module["___wasm_call_ctors"] = Module["asm"]["d"]).apply(null, arguments);
};
var _rnnoise_init = Module["_rnnoise_init"] = function() {
 return (_rnnoise_init = Module["_rnnoise_init"] = Module["asm"]["e"]).apply(null, arguments);
};
var _rnnoise_create = Module["_rnnoise_create"] = function() {
 return (_rnnoise_create = Module["_rnnoise_create"] = Module["asm"]["f"]).apply(null, arguments);
};
var _malloc = Module["_malloc"] = function() {
 return (_malloc = Module["_malloc"] = Module["asm"]["g"]).apply(null, arguments);
};
var _rnnoise_destroy = Module["_rnnoise_destroy"] = function() {
 return (_rnnoise_destroy = Module["_rnnoise_destroy"] = Module["asm"]["h"]).apply(null, arguments);
};
var _free = Module["_free"] = function() {
 return (_free = Module["_free"] = Module["asm"]["i"]).apply(null, arguments);
};
var _rnnoise_process_frame = Module["_rnnoise_process_frame"] = function() {
 return (_rnnoise_process_frame = Module["_rnnoise_process_frame"] = Module["asm"]["j"]).apply(null, arguments);
};

var calledRun;
dependenciesFulfilled = function runCaller() {
 if (!calledRun) run();
 if (!calledRun) dependenciesFulfilled = runCaller;
};
function run(args) {
 args = args || arguments_;
 if (runDependencies > 0) return;
 preRun();
 if (runDependencies > 0) return;
 function doRun() {
  if (calledRun) return;
  calledRun = true;
  Module["calledRun"] = true;
  if (ABORT) return;
  initRuntime();
  readyPromiseResolve(Module);
  if (Module["onRuntimeInitialized"]) Module["onRuntimeInitialized"]();
  postRun();
 }
 if (Module["setStatus"]) {
  Module["setStatus"]("Running...");
  setTimeout(function() { setTimeout(function() { Module["setStatus"](""); }, 1); doRun(); }, 1);
 } else { doRun(); }
}
Module["run"] = run;
if (Module["preInit"]) {
 if (typeof Module["preInit"] == "function") Module["preInit"] = [Module["preInit"]];
 while (Module["preInit"].length > 0) Module["preInit"].pop()();
}
run();

return createRNNWasmModule.ready
}
  );
})();
// ── End of RNNoise Emscripten glue ───────────────────────────────────────────

const FRAME_SIZE = 480; // RNNoise native frame size at 48 kHz

class RFWhisperProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.enabled  = !!opts.enabled;
    // Wet/dry mix: 0.0 = full bypass, 1.0 = fully denoised.
    // Default 0.8 — aggressive enough to cut RF noise while passing speech.
    this.strength = typeof opts.strength === 'number'
      ? Math.max(0, Math.min(1, opts.strength)) : 0.8;
    this.mod      = null;   // resolved RNNoise Emscripten module
    this.state    = 0;      // rnnoise DenoiseState* (WASM heap ptr)
    this.inPtr    = 0;      // WASM heap ptr for input  frame (480 × float32)
    this.outPtr   = 0;      // WASM heap ptr for output frame (480 × float32)
    // Input accumulation and output drain.
    this.inBuf    = new Float32Array(FRAME_SIZE);
    this.inPos    = 0;
    this.wetQueue = [];     // Array<Float32Array(FRAME_SIZE)> — denoised frames
    this.dryQueue = [];     // Array<Float32Array(FRAME_SIZE)> — matching dry frames
    this.outPos   = 0;      // read position within wetQueue[0]/dryQueue[0]

    this.port.onmessage = async (e) => {
      const msg = e.data || {};
      if (msg.type === 'init' && msg.wasmBinary) {
        try {
          // Pass the pre-fetched WASM binary so the glue never attempts a
          // fetch (which would fail in an AudioWorklet context).
          const mod = await createRNNWasmModule({ wasmBinary: msg.wasmBinary });
          this.mod    = mod;
          // Allocate persistent float32 buffers in the WASM heap.
          this.inPtr  = mod._malloc(FRAME_SIZE * 4);
          this.outPtr = mod._malloc(FRAME_SIZE * 4);
          // 0 = use built-in model weights.
          this.state  = mod._rnnoise_create(0);
          this.port.postMessage({ type: 'ready' });
        } catch (ex) {
          this.port.postMessage({ type: 'error', message: String(ex) });
        }
      }
      if (typeof msg.enabled  === 'boolean') this.enabled  = msg.enabled;
      if (typeof msg.strength === 'number')  this.strength = Math.max(0, Math.min(1, msg.strength));
    };
  }

  process(inputs, outputs) {
    const inp = inputs[0] && inputs[0][0];
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    const n = out.length;

    // Pass-through when disabled or WASM not yet ready.
    if (!inp || !this.enabled || !this.mod || !this.state) {
      for (let i = 0; i < n; i++) out[i] = inp ? inp[i] : 0;
      return true;
    }

    const mod     = this.mod;
    const inBuf   = this.inBuf;
    const inPtr2  = this.inPtr  >> 2; // HEAPF32 index (bytes → float32 offset)
    const outPtr2 = this.outPtr >> 2;

    // Accumulate input → run rnnoise_process_frame every 480 samples.
    // Store matching dry frames so wet/dry blend is time-aligned.
    for (let i = 0; i < n; i++) {
      // RNNoise expects int16-range amplitudes.
      inBuf[this.inPos] = inp[i] * 32768;
      this.inPos++;
      if (this.inPos >= FRAME_SIZE) {
        this.inPos = 0;
        // Dry frame (pre-denoise, scaled to float).
        const dryFrame = new Float32Array(FRAME_SIZE);
        for (let j = 0; j < FRAME_SIZE; j++) dryFrame[j] = inBuf[j] / 32768;
        this.dryQueue.push(dryFrame);
        // Wet frame.
        mod.HEAPF32.set(inBuf, inPtr2);
        mod._rnnoise_process_frame(this.state, this.outPtr, this.inPtr);
        const wetFrame = new Float32Array(FRAME_SIZE);
        wetFrame.set(mod.HEAPF32.subarray(outPtr2, outPtr2 + FRAME_SIZE));
        this.wetQueue.push(wetFrame);
      }
    }

    // Drain — mix denoised (wet) and original (dry) at the chosen strength.
    const w = this.strength;
    const d = 1 - w;
    for (let i = 0; i < n; i++) {
      if (this.wetQueue.length > 0) {
        const wet = this.wetQueue[0][this.outPos] / 32768;
        const dry = this.dryQueue[0][this.outPos];
        out[i] = d * dry + w * wet;
        this.outPos++;
        if (this.outPos >= FRAME_SIZE) {
          this.wetQueue.shift();
          this.dryQueue.shift();
          this.outPos = 0;
        }
      } else {
        // Silent during the initial ~10 ms fill before the first frame.
        out[i] = 0;
      }
    }

    return true;
  }
}

registerProcessor('rfwhisper', RFWhisperProcessor);

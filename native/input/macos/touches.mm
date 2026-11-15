// Clover's trackpad-touch add-on for macOS (native/input), for the four-finger tap that puts the Dispatch pill away (the old
// app's gesture, ported from apple/Winter/Sources/Gesture/MultitouchTrigger.swift). It reads the trackpad's touches and
// nothing else: no keyboard, no pointer, no events posted, no window, no file. `start(onFrame)` registers a contact-frame
// callback on every multitouch device and calls `onFrame(timeSeconds, [id, x, y, id, x, y, …])` on the app's main thread
// for each frame in which a finger is down, and once with an empty list when the last one lifts; `stop()` takes it all
// down again. Everything about what a tap IS lives in the app (src/main/touch-tap.ts), where it is tested.
//
// The framework is Apple's private MultitouchSupport, opened with dlopen as the old app did (an Apple-signed system library,
// so hardened-runtime library validation always permits it). Nothing is opened until `start`.
//
// A Node-API module like screen.mm, built with clang alone (apps/desktop/scripts/build.ts): its few Node-API calls are
// declared here from the stable ABI.
#import <Foundation/Foundation.h>
#include <dlfcn.h>
#include <stddef.h>
#include <stdlib.h>
#include <vector>

extern "C" {
typedef struct napi_env__* napi_env;
typedef struct napi_value__* napi_value;
typedef struct napi_callback_info__* napi_callback_info;
typedef struct napi_threadsafe_function__* napi_threadsafe_function;
typedef int napi_status;
typedef napi_value (*napi_callback)(napi_env env, napi_callback_info info);
typedef void (*napi_finalize)(napi_env env, void* data, void* hint);
typedef void (*napi_threadsafe_function_call_js)(napi_env env, napi_value js_callback, void* context, void* data);

napi_status napi_create_function(napi_env env, const char* name, size_t length, napi_callback cb, void* data, napi_value* result);
napi_status napi_set_named_property(napi_env env, napi_value object, const char* name, napi_value value);
napi_status napi_get_cb_info(napi_env env, napi_callback_info info, size_t* argc, napi_value* argv, napi_value* this_arg, void** data);
napi_status napi_create_string_utf8(napi_env env, const char* str, size_t length, napi_value* result);
napi_status napi_create_double(napi_env env, double value, napi_value* result);
napi_status napi_create_array_with_length(napi_env env, size_t length, napi_value* result);
napi_status napi_set_element(napi_env env, napi_value object, uint32_t index, napi_value value);
napi_status napi_get_undefined(napi_env env, napi_value* result);
napi_status napi_get_boolean(napi_env env, bool value, napi_value* result);
napi_status napi_call_function(napi_env env, napi_value recv, napi_value func, size_t argc, const napi_value* argv, napi_value* result);
napi_status napi_create_threadsafe_function(napi_env env, napi_value func, napi_value async_resource, napi_value async_resource_name, size_t max_queue_size, size_t initial_thread_count, void* thread_finalize_data, napi_finalize thread_finalize_cb, void* context, napi_threadsafe_function_call_js call_js_cb, napi_threadsafe_function* result);
napi_status napi_call_threadsafe_function(napi_threadsafe_function func, void* data, int is_blocking);
napi_status napi_release_threadsafe_function(napi_threadsafe_function func, int mode);
napi_status napi_unref_threadsafe_function(napi_env env, napi_threadsafe_function func);
}

// MultitouchSupport's contact layout (the old app's WinterBridge.h).
typedef struct { float x; float y; } MTPoint;
typedef struct { MTPoint pos; MTPoint vel; } MTReadout;
typedef struct {
  int frame;
  double timestamp;
  int identifier;
  int state;
  int fingerID;
  int handID;
  MTReadout normalized;
  float size;
  int zero1;
  float angle;
  float majorAxis;
  float minorAxis;
  MTReadout absolute;
  int zero2[2];
  float density;
} MTTouch;
typedef int (*MTContactCallbackFunction)(int device, MTTouch* touches, int nFingers, double timestamp, int frame);
typedef CFMutableArrayRef (*MTDeviceCreateListFn)(void);
typedef void (*MTDeviceStartFn)(void*, int);
typedef void (*MTDeviceStopFn)(void*);
typedef void (*MTRegisterFn)(void*, MTContactCallbackFunction);

static void* gHandle = nullptr;
static std::vector<void*> gDevices;
static MTDeviceStopFn gStop = nullptr;
static MTRegisterFn gUnregister = nullptr;
static napi_threadsafe_function gSink = nullptr;
static bool gWasDown = false;

struct Frame {
  double time;
  std::vector<float> flat; // id, x, y, …
};

// On the main thread: one frame to the app's callback.
static void deliver(napi_env env, napi_value js, void*, void* data) {
  Frame* f = static_cast<Frame*>(data);
  if (env != nullptr && js != nullptr) {
    napi_value time = nullptr, list = nullptr, undefined = nullptr;
    napi_create_double(env, f->time, &time);
    napi_create_array_with_length(env, f->flat.size(), &list);
    for (size_t i = 0; i < f->flat.size(); i++) {
      napi_value n = nullptr;
      napi_create_double(env, f->flat[i], &n);
      napi_set_element(env, list, (uint32_t)i, n);
    }
    napi_get_undefined(env, &undefined);
    napi_value argv[2] = {time, list};
    napi_call_function(env, undefined, js, 2, argv, nullptr);
  }
  delete f;
}

// On MultitouchSupport's thread: a frame of contacts. Only touching contacts (states 4 and 5) count; a frame with none is
// sent once, when the last finger lifts, and idle frames are not sent at all.
static int onContacts(int, MTTouch* touches, int n, double, int) {
  if (touches == nullptr || gSink == nullptr) return 0;
  Frame* f = new Frame();
  f->time = CFAbsoluteTimeGetCurrent();
  for (int i = 0; i < n; i++) {
    if (touches[i].state != 4 && touches[i].state != 5) continue;
    f->flat.push_back((float)(touches[i].identifier != 0 ? touches[i].identifier : touches[i].fingerID));
    f->flat.push_back(touches[i].normalized.pos.x);
    f->flat.push_back(touches[i].normalized.pos.y);
  }
  bool down = !f->flat.empty();
  if (!down && !gWasDown) { delete f; return 0; }
  gWasDown = down;
  if (napi_call_threadsafe_function(gSink, f, 0) != 0) delete f;
  return 0;
}

static void detach() {
  for (void* d : gDevices) {
    if (gUnregister != nullptr) gUnregister(d, onContacts);
    if (gStop != nullptr) gStop(d);
  }
  gDevices.clear();
  gStop = nullptr;
  gUnregister = nullptr;
  if (gHandle != nullptr) { dlclose(gHandle); gHandle = nullptr; }
  gWasDown = false;
}

/// Registers the callback on every device the framework lists now. True when it is listening on at least one.
static bool attach() {
  if (gHandle != nullptr) return true;
  void* h = dlopen("/System/Library/PrivateFrameworks/MultitouchSupport.framework/MultitouchSupport", RTLD_NOW);
  if (h == nullptr) return false;
  auto create = (MTDeviceCreateListFn)dlsym(h, "MTDeviceCreateList");
  auto start = (MTDeviceStartFn)dlsym(h, "MTDeviceStart");
  auto stop = (MTDeviceStopFn)dlsym(h, "MTDeviceStop");
  auto reg = (MTRegisterFn)dlsym(h, "MTRegisterContactFrameCallback");
  auto unreg = (MTRegisterFn)dlsym(h, "MTUnregisterContactFrameCallback");
  if (create == nullptr || start == nullptr || stop == nullptr || reg == nullptr || unreg == nullptr) { dlclose(h); return false; }
  CFMutableArrayRef list = create();
  if (list == nullptr) { dlclose(h); return false; }
  gHandle = h;
  gStop = stop;
  gUnregister = unreg;
  CFIndex count = CFArrayGetCount(list);
  for (CFIndex i = 0; i < count; i++) {
    void* d = const_cast<void*>(CFArrayGetValueAtIndex(list, i));
    if (d == nullptr) continue;
    reg(d, onContacts);
    start(d, 0);
    gDevices.push_back(d);
  }
  return !gDevices.empty();
}

static napi_value Start(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1] = {nullptr};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  napi_value ok = nullptr;
  if (argc < 1 || gSink != nullptr) { napi_get_boolean(env, false, &ok); return ok; }
  napi_value name = nullptr;
  napi_create_string_utf8(env, "clover-touches", 14, &name);
  if (napi_create_threadsafe_function(env, argv[0], nullptr, name, 0, 1, nullptr, nullptr, nullptr, deliver, &gSink) != 0) {
    gSink = nullptr;
    napi_get_boolean(env, false, &ok);
    return ok;
  }
  // Listening must not keep the app alive.
  napi_unref_threadsafe_function(env, gSink);
  napi_get_boolean(env, attach(), &ok);
  return ok;
}

/// After a wake or a trackpad coming back: the framework stops sending frames then, so the registration is made again.
static napi_value Reattach(napi_env env, napi_callback_info) {
  napi_value ok = nullptr;
  if (gSink == nullptr) { napi_get_boolean(env, false, &ok); return ok; }
  detach();
  napi_get_boolean(env, attach(), &ok);
  return ok;
}

static napi_value Stop(napi_env env, napi_callback_info) {
  detach();
  if (gSink != nullptr) { napi_release_threadsafe_function(gSink, 0); gSink = nullptr; }
  napi_value u = nullptr;
  napi_get_undefined(env, &u);
  return u;
}

extern "C" __attribute__((visibility("default"))) napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  napi_value fn = nullptr;
  napi_create_function(env, "start", 5, Start, nullptr, &fn);
  napi_set_named_property(env, exports, "start", fn);
  napi_create_function(env, "reattach", 8, Reattach, nullptr, &fn);
  napi_set_named_property(env, exports, "reattach", fn);
  napi_create_function(env, "stop", 4, Stop, nullptr, &fn);
  napi_set_named_property(env, exports, "stop", fn);
  return exports;
}

extern "C" __attribute__((visibility("default"))) int32_t node_api_module_get_api_version_v1(void) {
  return 8;
}

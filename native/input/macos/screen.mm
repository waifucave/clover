// MOSS's screen add-on for macOS (native/input, lane E): what Electron's `screen` doesn't say about each display,
// for the island's place beside the camera housing (spec §5.5, lane G's ask): the safe area's top inset and the two
// auxiliary areas either side of the housing (NSScreen, macOS 12 and later). And (lane RT, R12) the on-screen windows
// above one of ours, from the OS's own window list, for the overlap check of a sealed press: each one's bounds, layer,
// alpha, window number and owning process id, never a title or an owner's name (those are what the Screen Recording permission guards;
// bounds, layer, alpha and pid are not, and reading them prompts for nothing). It reads and nothing else: no input, no
// events, no state. A window counts for that check only when its owner is one of MOSS's own programs, so `bundleOf(pid)`
// gives the bundle identifier of a running app by its pid (NSRunningApplication: no permission guards it, nothing prompts).
//
// A Node-API module, built with clang alone (apps/desktop/scripts/build.ts) and loaded by the app's main process. The
// few Node-API calls it makes are declared here, from Node-API's stable ABI, so it needs no headers and works with
// any runtime that speaks Node-API (Electron's Node; Bun for its test).
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#include <stddef.h>
#include <string.h>

extern "C" {
typedef struct napi_env__* napi_env;
typedef struct napi_value__* napi_value;
typedef struct napi_callback_info__* napi_callback_info;
typedef int napi_status;
typedef napi_value (*napi_callback)(napi_env env, napi_callback_info info);

napi_status napi_create_object(napi_env env, napi_value* result);
napi_status napi_create_array_with_length(napi_env env, size_t length, napi_value* result);
napi_status napi_create_double(napi_env env, double value, napi_value* result);
napi_status napi_set_element(napi_env env, napi_value object, uint32_t index, napi_value value);
napi_status napi_set_named_property(napi_env env, napi_value object, const char* name, napi_value value);
napi_status napi_create_function(napi_env env, const char* name, size_t length, napi_callback cb, void* data, napi_value* result);
napi_status napi_get_cb_info(napi_env env, napi_callback_info cbinfo, size_t* argc, napi_value* argv, napi_value* this_arg, void** data);
napi_status napi_get_value_double(napi_env env, napi_value value, double* result);
napi_status napi_create_string_utf8(napi_env env, const char* str, size_t length, napi_value* result);
napi_status napi_get_undefined(napi_env env, napi_value* result);
}

static napi_value number(napi_env env, double v) {
  napi_value out = nullptr;
  napi_create_double(env, v, &out);
  return out;
}

static napi_value rect(napi_env env, NSRect r) {
  napi_value out = nullptr;
  napi_create_object(env, &out);
  napi_set_named_property(env, out, "x", number(env, r.origin.x));
  napi_set_named_property(env, out, "y", number(env, r.origin.y));
  napi_set_named_property(env, out, "width", number(env, r.size.width));
  napi_set_named_property(env, out, "height", number(env, r.size.height));
  return out;
}

// screens(): one object per display, in AppKit's points (origin at the bottom left of the main display):
// { id, frame, safeTop, left?, right? }, `left` and `right` the auxiliary areas when the display has a housing.
static napi_value Screens(napi_env env, napi_callback_info) {
  @autoreleasepool {
    NSArray<NSScreen*>* screens = [NSScreen screens];
    napi_value list = nullptr;
    napi_create_array_with_length(env, screens.count, &list);
    uint32_t i = 0;
    for (NSScreen* s in screens) {
      napi_value o = nullptr;
      napi_create_object(env, &o);
      NSNumber* n = s.deviceDescription[@"NSScreenNumber"];
      napi_set_named_property(env, o, "id", number(env, n != nil ? n.doubleValue : 0));
      napi_set_named_property(env, o, "frame", rect(env, s.frame));
      double top = 0;
      if (@available(macOS 12.0, *)) {
        top = s.safeAreaInsets.top;
        NSRect left = s.auxiliaryTopLeftArea;
        NSRect right = s.auxiliaryTopRightArea;
        if (!NSIsEmptyRect(left)) napi_set_named_property(env, o, "left", rect(env, left));
        if (!NSIsEmptyRect(right)) napi_set_named_property(env, o, "right", rect(env, right));
      }
      napi_set_named_property(env, o, "safeTop", number(env, top));
      napi_set_element(env, list, i++, o);
    }
    return list;
  }
}

static double numberOf(CFDictionaryRef d, CFStringRef key, double otherwise) {
  CFNumberRef n = (CFNumberRef)CFDictionaryGetValue(d, key);
  double v = otherwise;
  if (n != nullptr && CFGetTypeID(n) == CFNumberGetTypeID()) CFNumberGetValue(n, kCFNumberDoubleType, &v);
  return v;
}

// windowsAbove(windowId): the on-screen windows above the window with that CGWindowID (front first), desktop elements left
// out, each { x, y, width, height, layer, alpha, pid, id } in global points (`id` its CGWindowID) (origin at the top left of the main display, as
// Electron's screen coordinates). Nothing else of a window is read. An unknown id, or a list the OS won't give, is [].
static napi_value WindowsAbove(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    size_t argc = 1;
    napi_value argv[1] = {nullptr};
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    double idv = 0;
    if (argc < 1 || napi_get_value_double(env, argv[0], &idv) != 0 || !(idv > 0)) idv = 0;
    napi_value list = nullptr;
    napi_create_array_with_length(env, 0, &list);
    if (idv <= 0) return list;
    CFArrayRef windows = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenAboveWindow | kCGWindowListExcludeDesktopElements, (CGWindowID)idv);
    if (windows == nullptr) return list;
    uint32_t i = 0;
    for (CFIndex k = 0; k < CFArrayGetCount(windows); k++) {
      CFDictionaryRef w = (CFDictionaryRef)CFArrayGetValueAtIndex(windows, k);
      CFDictionaryRef b = (CFDictionaryRef)CFDictionaryGetValue(w, kCGWindowBounds);
      CGRect r = CGRectZero;
      if (b == nullptr || !CGRectMakeWithDictionaryRepresentation(b, &r)) continue;
      napi_value o = nullptr;
      napi_create_object(env, &o);
      napi_set_named_property(env, o, "x", number(env, r.origin.x));
      napi_set_named_property(env, o, "y", number(env, r.origin.y));
      napi_set_named_property(env, o, "width", number(env, r.size.width));
      napi_set_named_property(env, o, "height", number(env, r.size.height));
      napi_set_named_property(env, o, "layer", number(env, numberOf(w, kCGWindowLayer, 0)));
      napi_set_named_property(env, o, "alpha", number(env, numberOf(w, kCGWindowAlpha, 1)));
      napi_set_named_property(env, o, "pid", number(env, numberOf(w, kCGWindowOwnerPID, 0)));
      napi_set_named_property(env, o, "id", number(env, numberOf(w, kCGWindowNumber, 0)));
      napi_set_element(env, list, i++, o);
    }
    CFRelease(windows);
    return list;
  }
}

// bundleOf(pid): the bundle identifier of the running app with that pid, or undefined (no such app, or no bundle).
static napi_value BundleOf(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    size_t argc = 1;
    napi_value argv[1] = {nullptr};
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    double pid = 0;
    napi_value none = nullptr;
    napi_get_undefined(env, &none);
    if (argc < 1 || napi_get_value_double(env, argv[0], &pid) != 0 || !(pid > 0)) return none;
    NSRunningApplication* a = [NSRunningApplication runningApplicationWithProcessIdentifier:(pid_t)pid];
    NSString* b = a != nil ? a.bundleIdentifier : nil;
    if (b == nil) return none;
    const char* s = b.UTF8String;
    napi_value out = nullptr;
    napi_create_string_utf8(env, s, strlen(s), &out);
    return out;
  }
}

extern "C" __attribute__((visibility("default"))) napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  napi_value fn = nullptr;
  napi_create_function(env, "screens", 7, Screens, nullptr, &fn);
  napi_set_named_property(env, exports, "screens", fn);
  napi_value above = nullptr;
  napi_create_function(env, "windowsAbove", 12, WindowsAbove, nullptr, &above);
  napi_set_named_property(env, exports, "windowsAbove", above);
  napi_value bundle = nullptr;
  napi_create_function(env, "bundleOf", 8, BundleOf, nullptr, &bundle);
  napi_set_named_property(env, exports, "bundleOf", bundle);
  return exports;
}

// The Node-API version it was written for (Node reads it when present).
extern "C" __attribute__((visibility("default"))) int32_t node_api_module_get_api_version_v1(void) {
  return 8;
}

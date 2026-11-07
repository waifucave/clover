// Clover's screen add-on for macOS (native/input, lane E): what Electron's `screen` doesn't say about each display,
// for the island's place beside the camera housing (spec §5.5, lane G's ask): the safe area's top inset and the two
// auxiliary areas either side of the housing (NSScreen, macOS 12 and later). It reads them and nothing else: no input,
// no events, no state.
//
// A Node-API module, built with clang alone (apps/desktop/scripts/build.ts) and loaded by the app's main process. The
// few Node-API calls it makes are declared here, from Node-API's stable ABI, so it needs no headers and works with
// any runtime that speaks Node-API (Electron's Node; Bun for its test).
#import <AppKit/AppKit.h>
#include <stddef.h>

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

extern "C" __attribute__((visibility("default"))) napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  napi_value fn = nullptr;
  napi_create_function(env, "screens", 7, Screens, nullptr, &fn);
  napi_set_named_property(env, exports, "screens", fn);
  return exports;
}

// The Node-API version it was written for (Node reads it when present).
extern "C" __attribute__((visibility("default"))) int32_t node_api_module_get_api_version_v1(void) {
  return 8;
}

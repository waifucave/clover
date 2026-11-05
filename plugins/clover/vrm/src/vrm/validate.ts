// The structural check a VRM passes before any of it reaches the renderer. Adapted from waifucave/daydreamers
// (src/core/roster/vrm-validate.ts), which the spec names as the renderer's starting point (§12).
//
// Pure and bounded: it reads the GLB container, the glTF JSON and the image headers, never decodes a texture or
// builds a scene. What passes is a GLB v2 whose lengths agree; a VRM (`VRMC_vrm` 1.0 or `VRM` 0.x);
// self-contained (no `uri` on a buffer or image, so parsing never fetches); every view and accessor inside the
// BIN chunk; a node forest; within the budgets; requiring only extensions three-vrm handles; PNG or JPEG images
// within 4096 × 4096. It also reads the model's licence fields, which the renderer honours (open question 26).

export type AssetRejection = "too-large" | "not-glb" | "malformed" | "not-vrm" | "unsupported-extension" | "external-reference" | "over-budget";

export interface VrmMeta {
  readonly title: string;
  readonly author: string | null;
  readonly version: "1.0" | "0.x";
  /** The model's own version string, when it gives one. */
  readonly modelVersion: string | null;
  readonly licenceName: string | null;
  readonly licenceUrl: string | null;
  readonly otherLicenceUrl: string | null;
  readonly commercialUse: "allowed" | "disallowed" | "unknown";
  /** The licence asks for the author to be credited wherever the avatar shows. */
  readonly creditRequired: boolean;
  readonly redistribution: "allowed" | "disallowed" | "unknown";
  /** Marked a placeholder by its maker: shown with a credit line, so it is never mistaken for the real one. */
  readonly placeholder: boolean;
}


export const MAX_VRM_BYTES = 96 * 1024 * 1024

export const VRM_BUDGETS = {
  jsonBytes: 16 * 1024 * 1024,
  nodes: 2_000,
  nodeDepth: 64,
  meshes: 128,
  primitives: 512,
  vertices: 1_000_000,
  morphTargetsPerPrimitive: 128,
  skins: 8,
  jointsPerSkin: 256,
  images: 48,
  imageDimension: 4_096,
} as const

/** `extensionsRequired` must be a subset of these, or start with `VRMC_`. */
export const SUPPORTED_REQUIRED_EXTENSIONS: ReadonlySet<string> = new Set([
  "KHR_materials_unlit",
  "KHR_texture_transform",
  "KHR_mesh_quantization",
  "KHR_materials_emissive_strength",
  "VRM",
])

/** What was measured, for the budget report. */
export interface VrmStats {
  readonly jsonBytes: number
  readonly nodes: number
  readonly maxNodeDepth: number
  readonly meshes: number
  readonly primitives: number
  readonly vertices: number
  readonly maxMorphTargets: number
  readonly skins: number
  readonly maxJoints: number
  readonly images: number
  readonly maxImageWidth: number
  readonly maxImageHeight: number
}

export type VrmValidation =
  | { readonly ok: true; readonly meta: VrmMeta; readonly stats: VrmStats }
  | { readonly ok: false; readonly reason: AssetRejection; readonly detail: string }

const GLB_MAGIC = 0x46546c67 // "glTF"
const CHUNK_JSON = 0x4e4f534a
const CHUNK_BIN = 0x004e4942

class Rejection extends Error {
  constructor(
    readonly reason: AssetRejection,
    readonly detail: string,
  ) {
    super(detail)
  }
}

function reject(reason: AssetRejection, detail: string): never {
  throw new Rejection(reason, detail)
}

export function validateVrm(bytes: Uint8Array): VrmValidation {
  try {
    return check(bytes)
  } catch (e) {
    if (e instanceof Rejection) return { ok: false, reason: e.reason, detail: e.detail }
    // A bug or an engine limit (a JSON nested past the stack): never a pass.
    return { ok: false, reason: "malformed", detail: "The file could not be read." }
  }
}

type Json = Record<string, unknown>

function check(bytes: Uint8Array): VrmValidation {
  if (bytes.byteLength > MAX_VRM_BYTES) reject("too-large", `Over ${MAX_VRM_BYTES / 1024 / 1024} MiB.`)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  // ── GLB container ──
  if (bytes.byteLength < 4 || view.getUint32(0, true) !== GLB_MAGIC) reject("not-glb", "Not a binary glTF (.vrm/.glb) file.")
  if (bytes.byteLength < 12) reject("malformed", "The GLB header is truncated.")
  const version = view.getUint32(4, true)
  if (version !== 2) reject("not-glb", `GLB version ${version}; only version 2 is supported.`)
  const total = view.getUint32(8, true)
  if (total !== bytes.byteLength) reject("malformed", `The header says ${total} bytes; the file has ${bytes.byteLength}.`)

  if (total < 20) reject("malformed", "The JSON chunk header is truncated.")
  const jsonLength = view.getUint32(12, true)
  if (view.getUint32(16, true) !== CHUNK_JSON) reject("malformed", "The first chunk is not JSON.")
  if (jsonLength > VRM_BUDGETS.jsonBytes) reject("over-budget", `The JSON chunk is ${jsonLength} bytes (limit ${VRM_BUDGETS.jsonBytes}).`)
  if (20 + jsonLength > total) reject("malformed", "The JSON chunk runs past the end of the file.")

  let binStart = 0
  let binLength = -1
  const afterJson = 20 + jsonLength
  if (afterJson < total) {
    if (afterJson + 8 > total) reject("malformed", "The BIN chunk header is truncated.")
    const len = view.getUint32(afterJson, true)
    if (view.getUint32(afterJson + 4, true) === CHUNK_BIN) {
      if (afterJson + 8 + len > total) reject("malformed", "The BIN chunk runs past the end of the file.")
      binStart = afterJson + 8
      binLength = len
    }
  }

  let gltf: unknown
  try {
    gltf = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(20, 20 + jsonLength)))
  } catch {
    reject("malformed", "The glTF JSON does not parse.")
  }
  if (!isObj(gltf)) return reject("malformed", "The glTF JSON is not an object.")

  // ── VRM, extensions, external references ──
  const ext = isObj(gltf.extensions) ? gltf.extensions : {}
  const vrm1 = isObj(ext.VRMC_vrm) ? ext.VRMC_vrm : null
  const vrm0 = isObj(ext.VRM) ? ext.VRM : null
  if (vrm1 === null && vrm0 === null) reject("not-vrm", "This is a glTF model, but not a VRM.")

  for (const name of arr(gltf.extensionsRequired)) {
    if (typeof name !== "string") reject("malformed", "extensionsRequired holds a non-string.")
    if (!SUPPORTED_REQUIRED_EXTENSIONS.has(name as string) && !(name as string).startsWith("VRMC_")) {
      reject("unsupported-extension", `It requires ${String(name)}, which is not supported.`)
    }
  }

  const buffers = arr(gltf.buffers)
  const images = arr(gltf.images)
  buffers.forEach((b, i) => {
    if (isObj(b) && "uri" in b) reject("external-reference", `Buffer ${i} points outside the file.`)
  })
  images.forEach((im, i) => {
    if (isObj(im) && "uri" in im) reject("external-reference", `Image ${i} points outside the file.`)
  })

  // ── buffers, views, accessors: all inside BIN ──
  if (buffers.length > 1) reject("malformed", "A self-contained GLB has one buffer.")
  if (buffers.length === 1) {
    const b = obj(buffers[0], "buffer 0")
    if (binLength < 0) reject("malformed", "Buffer 0 has no BIN chunk.")
    if (uint(b.byteLength, "buffer 0 byteLength") > binLength) reject("malformed", "Buffer 0 is longer than the BIN chunk.")
  }
  const views = arr(gltf.bufferViews).map((v, i) => {
    const bv = obj(v, `bufferView ${i}`)
    if (uint(bv.buffer, `bufferView ${i} buffer`) >= buffers.length) reject("malformed", `bufferView ${i} names a missing buffer.`)
    const offset = optUint(bv.byteOffset, `bufferView ${i} byteOffset`)
    const length = uint(bv.byteLength, `bufferView ${i} byteLength`)
    if (offset + length > binLength) reject("malformed", `bufferView ${i} lies outside the BIN chunk.`)
    const stride = bv.byteStride === undefined ? null : uint(bv.byteStride, `bufferView ${i} byteStride`)
    return { offset, length, stride }
  })
  const viewAt = (i: unknown, what: string) => {
    const v = views[uint(i, what)]
    return v === undefined ? reject("malformed", `${what} names a missing bufferView.`) : v
  }

  const accessors = arr(gltf.accessors).map((a, i) => {
    const acc = obj(a, `accessor ${i}`)
    const count = uint(acc.count, `accessor ${i} count`)
    const elem = elementSize(acc.componentType, acc.type, `accessor ${i}`)
    if (acc.bufferView !== undefined) {
      const v = viewAt(acc.bufferView, `accessor ${i}`)
      const offset = optUint(acc.byteOffset, `accessor ${i} byteOffset`)
      const stride = v.stride ?? elem
      if (count > 0 && offset + (count - 1) * stride + elem > v.length) reject("malformed", `accessor ${i} overruns its bufferView.`)
    }
    if (acc.sparse !== undefined) {
      const sp = obj(acc.sparse, `accessor ${i} sparse`)
      const n = uint(sp.count, `accessor ${i} sparse count`)
      const idx = obj(sp.indices, `accessor ${i} sparse indices`)
      const val = obj(sp.values, `accessor ${i} sparse values`)
      const iv = viewAt(idx.bufferView, `accessor ${i} sparse indices`)
      const vv = viewAt(val.bufferView, `accessor ${i} sparse values`)
      if (optUint(idx.byteOffset, "sparse offset") + n * componentSize(idx.componentType, `accessor ${i} sparse indices`) > iv.length) {
        reject("malformed", `accessor ${i} sparse indices overrun their bufferView.`)
      }
      if (optUint(val.byteOffset, "sparse offset") + n * elem > vv.length) reject("malformed", `accessor ${i} sparse values overrun their bufferView.`)
    }
    return { count }
  })
  const accessorAt = (i: unknown, what: string) => {
    const a = accessors[uint(i, what)]
    return a === undefined ? reject("malformed", `${what} names a missing accessor.`) : a
  }

  // ── nodes: a forest within budget ──
  const nodes = arr(gltf.nodes)
  if (nodes.length > VRM_BUDGETS.nodes) reject("over-budget", `${nodes.length} nodes (limit ${VRM_BUDGETS.nodes}).`)
  const parent = new Array<number>(nodes.length).fill(-1)
  const children = nodes.map((n, i) =>
    arr(obj(n, `node ${i}`).children).map((c) => {
      const ci = uint(c, `node ${i} child`)
      if (ci >= nodes.length) reject("malformed", `node ${i} has a missing child.`)
      if (parent[ci] !== -1 || ci === i) reject("malformed", `node ${ci} has two parents, or is its own child.`)
      parent[ci] = i
      return ci
    }),
  )
  let maxNodeDepth = 0
  let reached = 0
  const stack: [number, number][] = []
  parent.forEach((p, i) => {
    if (p === -1) stack.push([i, 1])
  })
  while (stack.length > 0) {
    const [n, depth] = stack.pop()!
    reached++
    if (depth > maxNodeDepth) maxNodeDepth = depth
    if (depth > VRM_BUDGETS.nodeDepth) reject("over-budget", `The node tree is ${depth} deep (limit ${VRM_BUDGETS.nodeDepth}).`)
    for (const c of children[n]!) stack.push([c, depth + 1])
  }
  // One parent each, so any node no root reaches sits on a cycle.
  if (reached !== nodes.length) reject("malformed", "The node graph has a cycle.")

  // ── meshes ──
  const meshes = arr(gltf.meshes)
  if (meshes.length > VRM_BUDGETS.meshes) reject("over-budget", `${meshes.length} meshes (limit ${VRM_BUDGETS.meshes}).`)
  let primitives = 0
  let vertices = 0
  let maxMorphTargets = 0
  meshes.forEach((m, i) => {
    for (const p of arr(obj(m, `mesh ${i}`).primitives)) {
      const prim = obj(p, `mesh ${i} primitive`)
      primitives++
      const attrs = obj(prim.attributes, `mesh ${i} attributes`)
      if (attrs.POSITION !== undefined) vertices += accessorAt(attrs.POSITION, `mesh ${i} POSITION`).count
      const targets = arr(prim.targets).length
      if (targets > maxMorphTargets) maxMorphTargets = targets
    }
  })
  if (primitives > VRM_BUDGETS.primitives) reject("over-budget", `${primitives} primitives (limit ${VRM_BUDGETS.primitives}).`)
  if (vertices > VRM_BUDGETS.vertices) reject("over-budget", `${vertices} vertices (limit ${VRM_BUDGETS.vertices}).`)
  if (maxMorphTargets > VRM_BUDGETS.morphTargetsPerPrimitive) {
    reject("over-budget", `A primitive has ${maxMorphTargets} morph targets (limit ${VRM_BUDGETS.morphTargetsPerPrimitive}).`)
  }

  // ── skins ──
  const skins = arr(gltf.skins)
  if (skins.length > VRM_BUDGETS.skins) reject("over-budget", `${skins.length} skins (limit ${VRM_BUDGETS.skins}).`)
  let maxJoints = 0
  skins.forEach((s, i) => {
    const joints = arr(obj(s, `skin ${i}`).joints)
    for (const j of joints) if (uint(j, `skin ${i} joint`) >= nodes.length) reject("malformed", `skin ${i} names a missing joint.`)
    if (joints.length > maxJoints) maxJoints = joints.length
  })
  if (maxJoints > VRM_BUDGETS.jointsPerSkin) reject("over-budget", `A skin has ${maxJoints} joints (limit ${VRM_BUDGETS.jointsPerSkin}).`)

  // ── images: PNG or JPEG, header dimensions within budget ──
  if (images.length > VRM_BUDGETS.images) reject("over-budget", `${images.length} images (limit ${VRM_BUDGETS.images}).`)
  let maxImageWidth = 0
  let maxImageHeight = 0
  images.forEach((im, i) => {
    const image = obj(im, `image ${i}`)
    if (image.bufferView === undefined) reject("malformed", `Image ${i} has no data.`)
    const v = viewAt(image.bufferView, `image ${i}`)
    const data = bytes.subarray(binStart + v.offset, binStart + v.offset + v.length)
    const dims = pngSize(data) ?? jpegSize(data)
    if (dims === null) return reject("unsupported-extension", `Image ${i} is not a PNG or JPEG.`)
    if (dims.width > VRM_BUDGETS.imageDimension || dims.height > VRM_BUDGETS.imageDimension) {
      reject("over-budget", `Image ${i} is ${dims.width} × ${dims.height} (limit ${VRM_BUDGETS.imageDimension}).`)
    }
    maxImageWidth = Math.max(maxImageWidth, dims.width)
    maxImageHeight = Math.max(maxImageHeight, dims.height)
  })

  return {
    ok: true,
    meta: vrm1 !== null ? meta1(vrm1) : meta0(vrm0!),
    stats: {
      jsonBytes: jsonLength,
      nodes: nodes.length,
      maxNodeDepth,
      meshes: meshes.length,
      primitives,
      vertices,
      maxMorphTargets,
      skins: skins.length,
      maxJoints,
      images: images.length,
      maxImageWidth,
      maxImageHeight,
    },
  }
}

/* ── metadata ───────────────────────────────────────────────────────────── */

const VRM1_LICENCE = /^https:\/\/vrm\.dev\/licenses\/1\.0\/?$/

function meta1(vrm: Json): VrmMeta {
  const m = isObj(vrm.meta) ? vrm.meta : {}
  const authors = arr(m.authors).filter((a): a is string => typeof a === "string").map((a) => text(a)).filter((a) => a !== null)
  const licenceUrl = url(m.licenseUrl)
  const usage = m.commercialUsage
  const title = text(m.name) ?? "Untitled model"
  const modelVersion = text(m.version)
  return {
    title,
    author: authors.length > 0 ? text(authors.join(", ")) : null,
    version: "1.0",
    modelVersion,
    licenceName: licenceUrl !== null && VRM1_LICENCE.test(licenceUrl) ? "VRM Public License 1.0" : null,
    licenceUrl,
    otherLicenceUrl: url(m.otherLicenseUrl),
    commercialUse: usage === "personalNonProfit" ? "disallowed" : usage === "personalProfit" || usage === "corporation" ? "allowed" : "unknown",
    creditRequired: m.creditNotation === "required",
    redistribution: m.allowRedistribution === true ? "allowed" : m.allowRedistribution === false ? "disallowed" : "unknown",
    placeholder: /placeholder/i.test(`${title} ${modelVersion ?? ""}`),
  }
}

function meta0(vrm: Json): VrmMeta {
  const m = isObj(vrm.meta) ? vrm.meta : {}
  // `commercialUssageName` is the VRM 0.x spelling.
  const usage = m.commercialUssageName
  const title = text(m.title) ?? "Untitled model"
  const modelVersion = text(m.version)
  const licenceName = text(m.licenseName)
  return {
    title,
    author: text(m.author),
    version: "0.x",
    modelVersion,
    licenceName,
    licenceUrl: null,
    otherLicenceUrl: url(m.otherLicenseUrl),
    commercialUse: usage === "Allow" ? "allowed" : usage === "Disallow" ? "disallowed" : "unknown",
    // The Creative Commons licences VRM 0.x names all ask for attribution, CC0 aside.
    creditRequired: licenceName !== null && /^CC_BY/.test(licenceName),
    redistribution: licenceName === "Redistribution_Prohibited" ? "disallowed" : licenceName !== null ? "allowed" : "unknown",
    placeholder: /placeholder/i.test(`${title} ${modelVersion ?? ""}`),
  }
}

/** Untrusted text bound for the screen: control characters out, trimmed, at most 200 characters. */
function text(v: unknown): string | null {
  if (typeof v !== "string") return null
  const s = v.replace(/\p{Cc}/gu, " ").trim().slice(0, 200)
  return s.length > 0 ? s : null
}

function url(v: unknown): string | null {
  return typeof v === "string" && /^https?:\/\/[^\s]{1,500}$/.test(v) ? v : null
}

/* ── image headers ──────────────────────────────────────────────────────── */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function pngSize(d: Uint8Array): { width: number; height: number } | null {
  if (d.length < 24 || !PNG_SIGNATURE.every((b, i) => d[i] === b)) return null
  // IHDR is always the first chunk: length(4) "IHDR"(4) width(4) height(4), big-endian.
  if (String.fromCharCode(d[12]!, d[13]!, d[14]!, d[15]!) !== "IHDR") return null
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength)
  return { width: v.getUint32(16), height: v.getUint32(20) }
}

function jpegSize(d: Uint8Array): { width: number; height: number } | null {
  if (d.length < 4 || d[0] !== 0xff || d[1] !== 0xd8) return null
  let i = 2
  while (i + 9 < d.length) {
    if (d[i] !== 0xff) return null
    const marker = d[i + 1]!
    if (marker === 0xff) {
      i++
      continue
    }
    // Start-of-frame markers carry the size; C4 (DHT), C8 (JPG), CC (DAC) do not.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (d[i + 5]! << 8) | d[i + 6]!, width: (d[i + 7]! << 8) | d[i + 8]! }
    }
    if (marker === 0xd9 || marker === 0xda) return null
    i += 2 + ((d[i + 2]! << 8) | d[i + 3]!)
  }
  return null
}

/* ── glTF accessors ─────────────────────────────────────────────────────── */

const COMPONENT_BYTES: Readonly<Record<number, number>> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }
const TYPE_COMPONENTS: Readonly<Record<string, number>> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 }

function componentSize(componentType: unknown, what: string): number {
  const n = typeof componentType === "number" ? COMPONENT_BYTES[componentType] : undefined
  return n ?? reject("malformed", `${what} has an unknown component type.`)
}

function elementSize(componentType: unknown, type: unknown, what: string): number {
  const c = typeof type === "string" ? TYPE_COMPONENTS[type] : undefined
  if (c === undefined) reject("malformed", `${what} has an unknown type.`)
  return componentSize(componentType, what) * c!
}

/* ── JSON shape helpers ─────────────────────────────────────────────────── */

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function obj(v: unknown, what: string): Json {
  return isObj(v) ? v : reject("malformed", `${what} is not an object.`)
}

function arr(v: unknown): readonly unknown[] {
  if (v === undefined) return []
  return Array.isArray(v) ? v : reject("malformed", "Expected a list.")
}

function uint(v: unknown, what: string): number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : reject("malformed", `${what} is not a whole number.`)
}

function optUint(v: unknown, what: string): number {
  return v === undefined ? 0 : uint(v, what)
}

// A small glTF 2.0 binary (GLB) writer: one buffer, 4-byte aligned views, accessors with the min and max a
// POSITION needs. Enough to build the placeholder avatar and the tests' synthetic models in code, so no
// model is ever a fixture nobody can read.

export const GLB_MAGIC = 0x46546c67;
export const CHUNK_JSON = 0x4e4f534a;
export const CHUNK_BIN = 0x004e4942;

export const FLOAT = 5126;
export const UNSIGNED_SHORT = 5123;
export const UNSIGNED_INT = 5125;
export const ARRAY_BUFFER = 34962;
export const ELEMENT_ARRAY_BUFFER = 34963;

const pad4 = (n: number) => (n + 3) & ~3;

type Json = Record<string, unknown>;

export type AccessorType = "SCALAR" | "VEC2" | "VEC3" | "VEC4";
const COMPONENTS: Record<AccessorType, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

export class GltfBuilder {
  readonly json: Json & {
    nodes: Json[];
    meshes: Json[];
    materials: Json[];
    accessors: Json[];
    bufferViews: Json[];
    scenes: { nodes: number[] }[];
    extensionsUsed: string[];
    extensions: Json;
  };
  private readonly chunks: Uint8Array[] = [];
  private length = 0;

  constructor(generator: string) {
    this.json = {
      asset: { version: "2.0", generator },
      scene: 0,
      scenes: [{ nodes: [] }],
      nodes: [],
      meshes: [],
      materials: [],
      accessors: [],
      bufferViews: [],
      extensionsUsed: [],
      extensions: {},
    };
  }

  /** Appends bytes as a view of the one buffer; returns the view's index. */
  view(data: ArrayBufferView, target?: number): number {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const offset = this.length;
    this.chunks.push(bytes);
    const padded = pad4(bytes.byteLength);
    if (padded > bytes.byteLength) this.chunks.push(new Uint8Array(padded - bytes.byteLength));
    this.length += padded;
    const view: Json = { buffer: 0, byteOffset: offset, byteLength: bytes.byteLength };
    if (target !== undefined) view.target = target;
    this.json.bufferViews.push(view);
    return this.json.bufferViews.length - 1;
  }

  /** A float accessor; positions carry their bounds, as the glTF spec asks. */
  floats(values: ArrayLike<number>, type: AccessorType, options: { bounds?: boolean; target?: number } = {}): number {
    const data = Float32Array.from(values);
    const n = COMPONENTS[type];
    const accessor: Json = { bufferView: this.view(data, options.target ?? ARRAY_BUFFER), componentType: FLOAT, count: data.length / n, type };
    if (options.bounds) {
      const min = new Array<number>(n).fill(Number.POSITIVE_INFINITY);
      const max = new Array<number>(n).fill(Number.NEGATIVE_INFINITY);
      for (let i = 0; i < data.length; i++) {
        const c = i % n;
        min[c] = Math.min(min[c]!, data[i]!);
        max[c] = Math.max(max[c]!, data[i]!);
      }
      accessor.min = min.map((v) => (Object.is(v, -0) ? 0 : v));
      accessor.max = max.map((v) => (Object.is(v, -0) ? 0 : v));
    }
    this.json.accessors.push(accessor);
    return this.json.accessors.length - 1;
  }

  indices(values: ArrayLike<number>): number {
    let largest = 0;
    for (let i = 0; i < values.length; i++) largest = Math.max(largest, values[i]!);
    const data = largest < 65536 ? Uint16Array.from(values) : Uint32Array.from(values);
    this.json.accessors.push({
      bufferView: this.view(data, ELEMENT_ARRAY_BUFFER),
      componentType: data instanceof Uint16Array ? UNSIGNED_SHORT : UNSIGNED_INT,
      count: data.length,
      type: "SCALAR",
    });
    return this.json.accessors.length - 1;
  }

  node(node: Json, parent?: number): number {
    this.json.nodes.push(node);
    const index = this.json.nodes.length - 1;
    if (parent === undefined) this.json.scenes[0]!.nodes.push(index);
    else {
      const p = this.json.nodes[parent]!;
      p.children = [...((p.children as number[] | undefined) ?? []), index];
    }
    return index;
  }

  material(material: Json): number {
    this.json.materials.push(material);
    return this.json.materials.length - 1;
  }

  mesh(mesh: Json): number {
    this.json.meshes.push(mesh);
    return this.json.meshes.length - 1;
  }

  use(extension: string): void {
    if (!this.json.extensionsUsed.includes(extension)) this.json.extensionsUsed.push(extension);
  }

  /** The GLB: header, the JSON chunk (space-padded), the BIN chunk (zero-padded). */
  toGlb(): Uint8Array {
    const json: Json = { ...this.json, buffers: [{ byteLength: this.length }] };
    if ((json.extensionsUsed as string[]).length === 0) delete json.extensionsUsed;
    const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
    const jsonLength = pad4(jsonBytes.length);
    const total = 12 + 8 + jsonLength + 8 + this.length;
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    view.setUint32(0, GLB_MAGIC, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, total, true);
    view.setUint32(12, jsonLength, true);
    view.setUint32(16, CHUNK_JSON, true);
    out.set(jsonBytes, 20);
    out.fill(0x20, 20 + jsonBytes.length, 20 + jsonLength);
    view.setUint32(20 + jsonLength, this.length, true);
    view.setUint32(24 + jsonLength, CHUNK_BIN, true);
    let at = 28 + jsonLength;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.byteLength;
    }
    return out;
  }
}

/** The glTF JSON inside a GLB (no checks: `validateVrm` is the checker). */
export function glbJson(bytes: Uint8Array): Json {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length))) as Json;
}

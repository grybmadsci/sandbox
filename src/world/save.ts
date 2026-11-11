import type { SavedGroup } from '../sim/bodies'
import { CHUNK_SIZE, CHUNK_WORDS, WORLD_CHUNKS } from './config'
import type { WorldMode } from './worldgen'

const MAGIC = 'SANDSAVE'
const VERSION = 1

/** Everything about a saved game but the chunks' cells. */
export type SaveHeader = {
  version: number
  chunkSize: number
  worldChunks: number
  seed: number
  mode: WorldMode
  /** The simulation's step and paint counts (the seeds of its random choices derive from them). */
  steps: number
  paints: number
  camera: { x: number; y: number; zoom: number }
  /** Every body, whether simulated or put away outside the window. */
  bodies: SavedGroup[]
  /** The chunks saved, in the order their states follow the header. Chunks not listed are as generated from the seed. */
  chunks: [number, number][]
}

export type SaveGame = { header: SaveHeader; chunks: Int32Array[] }

/**
 * A saved game as a file: gzip of the magic bytes, the format version and the header's
 * length (u32 each, little-endian), the header as JSON, then each chunk's state
 * (CHUNK_WORDS 32-bit words, see config.ts).
 */
export async function encodeSave({ header, chunks }: SaveGame): Promise<Blob> {
  const json = new TextEncoder().encode(JSON.stringify(header))
  const head = new DataView(new ArrayBuffer(16))
  new TextEncoder().encodeInto(MAGIC, new Uint8Array(head.buffer))
  head.setUint32(8, VERSION, true)
  head.setUint32(12, json.byteLength, true)
  const parts: BlobPart[] = [head.buffer, json, ...chunks.map((c) => c.slice().buffer)]
  const stream = new Blob(parts).stream().pipeThrough(new CompressionStream('gzip'))
  return new Response(stream).blob()
}

/** Read a saved game back; throws, saying why, if it isn't one this world can load. */
export async function decodeSave(file: Blob): Promise<SaveGame> {
  let bytes: ArrayBuffer
  try {
    bytes = await new Response(file.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
  } catch {
    throw new Error('Not a saved game (it is not gzip-compressed).')
  }
  const head = new DataView(bytes, 0, Math.min(16, bytes.byteLength))
  if (bytes.byteLength < 16 || new TextDecoder().decode(bytes.slice(0, 8)) !== MAGIC) throw new Error('Not a saved game.')
  const version = head.getUint32(8, true)
  if (version !== VERSION) throw new Error(`Saved game format ${version} isn't supported (this version reads ${VERSION}).`)
  const length = head.getUint32(12, true)
  const header = JSON.parse(new TextDecoder().decode(bytes.slice(16, 16 + length))) as SaveHeader
  if (header.chunkSize !== CHUNK_SIZE || header.worldChunks !== WORLD_CHUNKS) {
    throw new Error(`Saved with ${header.worldChunks}x${header.worldChunks} chunks of ${header.chunkSize} cells; this world has ${WORLD_CHUNKS}x${WORLD_CHUNKS} of ${CHUNK_SIZE}.`)
  }
  const chunkBytes = CHUNK_WORDS * 4
  const start = 16 + length
  if (bytes.byteLength !== start + header.chunks.length * chunkBytes) throw new Error('Saved game is truncated or corrupt.')
  const chunks = header.chunks.map((_, i) => new Int32Array(bytes.slice(start + i * chunkBytes, start + (i + 1) * chunkBytes)))
  return { header, chunks }
}

/** The browser's quick-save slot (IndexedDB). */
const DB = 'sandbox'
const STORE = 'saves'
const SLOT = 'quick'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function transact<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE, mode).objectStore(STORE))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}

export const writeQuickSave = (file: Blob) => transact('readwrite', (store) => store.put(file, SLOT))
export const readQuickSave = () => transact<Blob | undefined>('readonly', (store) => store.get(SLOT))

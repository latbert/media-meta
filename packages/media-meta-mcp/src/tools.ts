import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { access, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { readMetaBuffer, MediaMetaError } from '@nopilot/media-meta-engine';

export const SERVER_NAME = 'media-meta-mcp';
export const SERVER_VERSION = '1.0.0';

const MAX_FILE_BYTES = 256 * 1024 * 1024; // 256MB read guard

function errorPayload(err: unknown) {
  if (err instanceof MediaMetaError) {
    return { isError: true as const, code: err.code, message: err.message };
  }
  return { isError: true as const, code: 'internal_error', message: String(err) };
}

function text(content: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(content, null, 2) }] };
}

async function readImageFile(p: string): Promise<{ buf: Buffer; size: number }> {
  const resolved = path.resolve(p);
  try {
    const s = await stat(resolved);
    if (!s.isFile()) throw new MediaMetaError('not_a_file', `Not a regular file: ${resolved}`);
    if (s.size > MAX_FILE_BYTES) {
      throw new MediaMetaError('file_too_large', `File exceeds ${MAX_FILE_BYTES} bytes`);
    }
    const buf = await readFile(resolved);
    return { buf, size: s.size };
  } catch (err) {
    if (err instanceof MediaMetaError) throw err;
    throw new MediaMetaError('file_unreadable', `Cannot access file: ${resolved}`);
  }
}

export function registerMediaMetaTools(server: McpServer): void {
  server.registerTool(
    'image_metadata_read',
    {
      title: 'Read image metadata',
      description:
        'Read EXIF and XMP metadata from a local modern-format image: HEIC/HEIF/AVIF (metadata ' +
        'decoded from the ISOBMFF meta box — iinf item info + iloc item locations → Exif/XMP items) ' +
        'and WebP (RIFF EXIF/XMP chunks). Returns container, brand, grouped EXIF tags ' +
        '(IFD0 / Exif sub-IFD / GPS: make, model, orientation, timestamps, exposure, GPS coords...), ' +
        'the raw XMP packet, and the container box/chunk list. Pure local byte parsing — the file ' +
        'never leaves the machine, zero network, zero LLM, deterministic output.',
      inputSchema: {
        path: z.string().min(1).describe('Absolute or cwd-relative path of the local image file'),
        includeXmp: z
          .boolean()
          .optional()
          .describe('Include the raw XMP XML packet in the response (default true)'),
        includeBoxes: z
          .boolean()
          .optional()
          .describe('Include the container box/chunk list (default true)'),
      },
    },
    async ({ path: p, includeXmp, includeBoxes }) => {
      try {
        void access; // access imported for parity with sibling servers; stat is the guard
        const { buf, size } = await readImageFile(p);
        const meta = readMetaBuffer(buf);
        const wantXmp = includeXmp ?? true;
        const wantBoxes = includeBoxes ?? true;
        const out: Record<string, unknown> = {
          file: path.resolve(p),
          sizeBytes: size,
          container: meta.container,
          brand: meta.brand,
          exif: meta.exif ?? null,
          xmp: wantXmp ? (meta.xmp ?? null) : undefined,
          boxes: wantBoxes ? meta.boxes : undefined,
          warnings: meta.warnings,
        };
        return text(out);
      } catch (err) {
        return text(errorPayload(err));
      }
    },
  );
}

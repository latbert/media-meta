import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildServer, registerMediaMetaTools } from '../index.js';
import { buildHeicFixture, buildWebp, buildExifPayload } from '@nopilot/media-meta-engine';

async function connect() {
  const server = buildServer({
    name: 'media-meta-mcp-test',
    version: '0.0.0-test',
    defaultPort: 0,
    register: (s) => registerMediaMetaTools(s),
  });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'media-meta-mcp-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function payload(res: unknown): any {
  const content = (res as { content?: { text?: string }[] }).content;
  return JSON.parse(content![0].text!);
}

describe('media-meta-mcp tool surface', () => {
  it('lists the tool with a complete schema', async () => {
    const { client, server } = await connect();
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(['image_metadata_read']);
    const t = tools.tools[0];
    expect(t.description!.length).toBeGreaterThan(60);
    expect(t.inputSchema.type).toBe('object');
    await client.close();
    await server.close();
  });

  it('reads HEIC EXIF groups + XMP through MCP', async () => {
    const file = path.join(dir, 'photo.heic');
    writeFileSync(file, buildHeicFixture());
    const { client, server } = await connect();
    const res = await client.callTool({ name: 'image_metadata_read', arguments: { path: file } });
    const p = payload(res);
    expect(p.container).toBe('heic');
    expect(p.exif.IFD0.Make).toBe('TestCam');
    expect(p.exif.IFD0.Orientation).toBe(6);
    expect(p.exif.Exif.ISOSpeedRatings).toBe(200);
    expect(p.exif.GPS.GPSLatitude).toEqual([37, 30, 0]);
    expect(p.xmp).toContain('<x:xmpmeta');
    expect(p.boxes.some((b: { type: string }) => b.type === 'iloc')).toBe(true);
    await client.close();
    await server.close();
  });

  it('reads WebP EXIF and honors includeXmp/includeBoxes=false', async () => {
    const file = path.join(dir, 'img.webp');
    writeFileSync(file, buildWebp(buildExifPayload([[0x010f, 'WebCam']]), '<x:xmpmeta/>'));
    const { client, server } = await connect();
    const res = await client.callTool({
      name: 'image_metadata_read',
      arguments: { path: file, includeXmp: false, includeBoxes: false },
    });
    const p = payload(res);
    expect(p.container).toBe('webp');
    expect(p.exif.IFD0.Make).toBe('WebCam');
    expect(p.xmp).toBeUndefined();
    expect(p.boxes).toBeUndefined();
    await client.close();
    await server.close();
  });

  it('returns structured errors for missing/invalid files', async () => {
    const { client, server } = await connect();
    const r1 = await client.callTool({
      name: 'image_metadata_read',
      arguments: { path: path.join(dir, 'nope.heic') },
    });
    expect(payload(r1)).toMatchObject({ isError: true, code: 'file_unreadable' });

    const bad = path.join(dir, 'bad.heic');
    writeFileSync(bad, Buffer.from('not an image at all'));
    const r2 = await client.callTool({ name: 'image_metadata_read', arguments: { path: bad } });
    expect(payload(r2)).toMatchObject({ isError: true, code: 'unknown_container' });
    await client.close();
    await server.close();
  });

  it('byte-deterministic responses for identical files', async () => {
    const file = path.join(dir, 'same.heic');
    writeFileSync(file, buildHeicFixture());
    const { client, server } = await connect();
    const r1 = await client.callTool({ name: 'image_metadata_read', arguments: { path: file } });
    const r2 = await client.callTool({ name: 'image_metadata_read', arguments: { path: file } });
    expect((r1.content as { text: string }[])[0].text).toBe((r2.content as { text: string }[])[0].text);
    await client.close();
    await server.close();
  });
});

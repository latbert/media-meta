/** Parsed EXIF groups: IFD0 always; Exif/GPS sub-IFDs when present. */
export interface ExifGroups {
  /** true = big-endian ("MM"), false = little-endian ("II"). */
  bigEndian: boolean;
  IFD0: Record<string, unknown>;
  Exif?: Record<string, unknown>;
  GPS?: Record<string, unknown>;
}

/** Parsed metadata result for a media file. */
export interface MediaMeta {
  /** Container format detected from the file signature. */
  container: 'heic' | 'heif' | 'avif' | 'webp';
  /** Raw major brand from the ftyp box (ISOBMFF) or FourCC (WebP). */
  brand?: string;
  /** EXIF tags extracted from the Exif segment, grouped IFD0/Exif/GPS. */
  exif?: ExifGroups;
  /** XMP packet (raw XML string) when present. */
  xmp?: string;
  /** Container-level boxes encountered (types + sizes), useful for debugging. */
  boxes: BoxRecord[];
  warnings: string[];
}

export interface BoxRecord {
  /** Four-character box type (ISOBMFF) or chunk FourCC (RIFF/WebP). */
  type: string;
  /** Box size in bytes as declared by the header. */
  size: number;
}

export type MediaKind = 'heic' | 'heif' | 'avif' | 'webp';

export class MediaMetaError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'MediaMetaError';
    this.code = code;
  }
}

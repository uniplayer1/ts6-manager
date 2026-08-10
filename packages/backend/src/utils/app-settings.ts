/** Typed access to AppSetting rows, shared by routes and services. */

export const MAX_PLAYLIST_IMPORT_KEY = 'max_playlist_import';
export const DEFAULT_MAX_PLAYLIST_IMPORT = 50;

export const MAX_VIDEO_DURATION_KEY = 'max_video_duration';
export const DEFAULT_MAX_VIDEO_DURATION = 900;  // 15 min in seconds

/** Read the stored cap, tolerating anything a hand-edited row might contain. */
export function parseImportCap(raw: string | null | undefined): number {
  if (raw == null || raw === '') return DEFAULT_MAX_PLAYLIST_IMPORT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_MAX_PLAYLIST_IMPORT;
  return Math.max(0, Math.floor(n));
}

/** Read the stored max video duration (seconds), tolerating bad rows. */
export function parseVideoDuration(raw: string | null | undefined): number {
  if (raw == null || raw === '') return DEFAULT_MAX_VIDEO_DURATION;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_MAX_VIDEO_DURATION;
  return Math.max(0, Math.floor(n));
}

/** Load the max video duration from AppSetting (default 900s = 15 min). */
export async function loadMaxVideoDuration(prisma: any): Promise<number> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: MAX_VIDEO_DURATION_KEY } });
    return parseVideoDuration(row?.value);
  } catch {
    return DEFAULT_MAX_VIDEO_DURATION;
  }
}

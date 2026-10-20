import JSZip from 'jszip';
import type { PhotoMap, Student } from '../types';

/**
 * Photo matching engine.
 *
 * A photo is attached to a student only when a *strong* identity signal
 * matches — never because of upload/array order:
 *
 *   1. the exact filename listed in the workbook's photo column;
 *   2. the student's roll / serial number (e.g. "13_EKANJOT.jpg" → roll 13);
 *   3. the admission number;
 *   4. the internal student / row id;
 *   5. the exact normalised student name;
 *   6. the student's name appearing inside the filename.
 *
 * When two students would match the same photo and it cannot be disambiguated
 * by name, the photo is left blank: attaching the wrong child's photograph is
 * never acceptable.
 */

/* ── archive safety ──────────────────────────────────────────────────── */

/** A hostile or accidental archive must not be able to exhaust the browser. */
export const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024; // 200 MB compressed input
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024; // 12 MB per photo
export const MAX_IMAGES = 3000;

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp']);

const extOf = (name: string): string => name.split('.').pop()?.toLowerCase() ?? '';
const baseOf = (path: string): string => path.split(/[\\/]/).pop() ?? '';

/** True when any path segment climbs out of the archive root. */
const hasTraversal = (path: string): boolean =>
  path.split(/[\\/]/).some((segment) => segment === '..');

export interface ZipPlan {
  /** Basenames safe to read, in archive order. */
  accepted: string[];
  /** Basenames that appeared more than once — only the first is kept. */
  duplicates: string[];
  /** Everything ignored, with the reason. */
  rejected: Array<{ name: string; reason: string }>;
}

/**
 * Decides which archive entries may be read. Pure, so it is fully testable.
 *
 * Safety rules:
 *   • path-traversal entries are refused;
 *   • hidden / macOS resource-fork entries are ignored;
 *   • only image extensions are considered;
 *   • a repeated basename is reported and SKIPPED — it never silently
 *     overwrites the first file that claimed that name.
 */
export function planZipEntries(names: string[]): ZipPlan {
  const plan: ZipPlan = { accepted: [], duplicates: [], rejected: [] };
  const seen = new Set<string>();

  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;

    if (hasTraversal(name)) {
      plan.rejected.push({ name, reason: 'path traversal' });
      continue;
    }

    const base = baseOf(name);
    if (!base || base.startsWith('.') || name.startsWith('__MACOSX')) {
      plan.rejected.push({ name, reason: 'hidden or system entry' });
      continue;
    }

    if (!IMAGE_EXTS.has(extOf(base))) {
      plan.rejected.push({ name, reason: 'unsupported file type' });
      continue;
    }

    // Case-insensitive: "rahul.JPG" and "Rahul.jpg" are the same identity to a
    // human and must not both be loaded under different keys.
    const key = base.toLowerCase();
    if (seen.has(key)) {
      plan.duplicates.push(base);
      continue;
    }

    seen.add(key);
    plan.accepted.push(base);
  }

  return plan;
}

/** Sniffs the real format so a renamed or truncated file is not trusted. */
export function detectImageFormat(
  bytes: Uint8Array,
): 'jpeg' | 'png' | 'gif' | 'webp' | 'bmp' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif';
  if (bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'webp';
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'bmp';
  return null;
}

export interface PhotoZipResult {
  map: PhotoMap;
  duplicates: string[];
  rejected: Array<{ name: string; reason: string }>;
}

/**
 * Reads a photo ZIP and reports what was skipped.
 *
 * Reads the bytes itself (rather than handing the File to JSZip) so the archive
 * is size-checked first and so the parsing is testable outside a browser.
 */
export async function loadPhotoZipDetailed(file: File): Promise<PhotoZipResult> {
  if (file.size > MAX_ARCHIVE_BYTES) {
    throw new Error(
      `That ZIP is ${Math.round(file.size / (1024 * 1024))} MB. Please keep it under ${Math.round(
        MAX_ARCHIVE_BYTES / (1024 * 1024),
      )} MB.`,
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new Error(
      'That ZIP could not be read — the file looks corrupted. Please re-create the archive and try again.',
    );
  }

  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  const plan = planZipEntries(entries.map((entry) => entry.name));

  if (plan.accepted.length > MAX_IMAGES) {
    throw new Error(
      `That ZIP contains ${plan.accepted.length} photos. Please split it into batches of ${MAX_IMAGES} or fewer.`,
    );
  }

  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const result: PhotoMap = {};
  const rejected = [...plan.rejected];

  for (const base of plan.accepted) {
    // Find the entry whose basename matches (the plan already de-duplicated).
    const entry = entries.find((candidate) => baseOf(candidate.name).toLowerCase() === base.toLowerCase())
      ?? byName.get(base);
    if (!entry) continue;

    let dataUrl: string;
    try {
      const blob = await entry.async('blob');

      if (blob.size > MAX_IMAGE_BYTES) {
        rejected.push({ name: base, reason: 'photo too large' });
        continue;
      }

      // Trust the bytes, not the extension: a .jpg that is really a text file
      // must never be attached to a child's report card.
      const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
      if (detectImageFormat(head) === null) {
        rejected.push({ name: base, reason: 'not a readable image' });
        continue;
      }

      dataUrl = await blobToDataUrl(blob);
    } catch {
      rejected.push({ name: base, reason: 'unreadable entry' });
      continue;
    }

    result[base] = dataUrl;
    result[base.toLowerCase()] = dataUrl;
    const nameNoExt = base.replace(/\.[^.]+$/, '');
    result[nameNoExt] = dataUrl;
    result[nameNoExt.toLowerCase()] = dataUrl;
  }

  if (plan.accepted.length === 0) {
    throw new Error(
      'No usable photos were found in that ZIP. Please include JPG, PNG, WEBP, GIF or BMP files.',
    );
  }

  return { map: result, duplicates: plan.duplicates, rejected };
}

/**
 * Backwards-compatible wrapper. Duplicates and skipped files are handled safely
 * inside; use `loadPhotoZipDetailed` when you want to show them to the user.
 */
export async function loadPhotoZip(file: File): Promise<PhotoMap> {
  return (await loadPhotoZipDetailed(file)).map;
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(blob);
  });
}

export function fileToDataUrl(file: File): Promise<string> {
  return blobToDataUrl(file);
}

/* ── indexing ─────────────────────────────────────────────────────────── */

interface PhotoEntry {
  /** Original file name including extension, when available. */
  fileLabel: string;
  dataUrl: string;
  /** Lower-cased label without extension (used for matching). */
  key: string;
  /** Alphanumeric tokens extracted from the file name. */
  tokens: string[];
}

export interface PhotoIndex {
  entries: PhotoEntry[];
}

function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

/** "13_EKANJOT Singh.jpg" → ["13", "ekanjot", "singh"] */
function tokenize(label: string): string[] {
  return stripExtension(label)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token !== '');
}

function collapse(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function uniquePhotoEntries(photoMap: PhotoMap): PhotoEntry[] {
  if (!photoMap) return [];
  const seen = new Set<string>();
  const entries: PhotoEntry[] = [];

  for (const [fileLabel, dataUrl] of Object.entries(photoMap)) {
    if (!dataUrl) continue;
    /* loadPhotoZip registers several aliases per file; the data URL uniquely
     * identifies the file, so the first (original) alias wins. */
    if (seen.has(dataUrl)) continue;
    seen.add(dataUrl);
    entries.push({
      fileLabel: /\.(jpe?g|png|webp|gif|bmp)$/i.test(fileLabel) ? fileLabel : `${fileLabel}.jpg`,
      dataUrl,
      key: collapse(stripExtension(fileLabel)),
      tokens: tokenize(fileLabel),
    });
  }

  return entries;
}

export function buildPhotoIndex(photoMap: PhotoMap): PhotoIndex {
  return { entries: uniquePhotoEntries(photoMap) };
}

/* ── matching ─────────────────────────────────────────────────────────── */

type PhotoStudent = Pick<Student, 'studentId' | 'rowNumber' | 'rollNo' | 'name'> &
  Partial<Pick<Student, 'admissionNo' | 'photoFilename'>>;

/** Words that carry no identity — they never describe a student. */
const GENERIC_PHOTO_TOKENS = new Set([
  'student',
  'students',
  'photo',
  'photos',
  'pic',
  'pics',
  'picture',
  'image',
  'img',
  'roll',
  'rollno',
  'sr',
  'sno',
  'no',
  'class',
  'section',
  'final',
  'new',
  'scan',
  'copy',
  'jpg',
  'jpeg',
  'png',
  'webp',
  'adm',
  'admission',
  'reg',
  'registration',
  'enroll',
  'enrolment',
  'enrollment',
  'id',
  'code',
]);

/** Identity words carried by a file name ("13_EKANJOT" → ["ekanjot"]). */
function nameTokensOf(entry: PhotoEntry): string[] {
  return entry.tokens.filter(
    (token) => token.length >= 3 && !/^\d+$/.test(token) && !GENERIC_PHOTO_TOKENS.has(token),
  );
}

/** Does the file name mention this student by name? */
function entryNamesStudent(
  entry: PhotoEntry,
  student: PhotoStudent,
  identifier = '',
): boolean {
  const nameTokens = nameTokensOf(entry).filter(
    (token) => !identifier.includes(token),
  );
  if (nameTokens.length === 0) return true;
  const studentTokens = String(student.name ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return nameTokens.every((token) => studentTokens.includes(token));
}

/** Does the file name contain this identifier (roll / admission / id)? */
function entryHasIdentifier(entry: PhotoEntry, value: string): boolean {
  if (!value) return false;
  return (
    entry.key === value ||
    entry.tokens.includes(value) ||
    entry.tokens.join('') === value
  );
}

/** Tier value — lower is stronger. `null` means "no match". */
function matchTier(entry: PhotoEntry, student: PhotoStudent): number | null {
  const roll = collapse(student.rollNo);
  const admission = collapse(student.admissionNo ?? '');
  const id = collapse(student.studentId ?? '');
  const rowId = collapse(`row${student.rowNumber ?? ''}`);
  const name = collapse(student.name);
  const filename = collapse(stripExtension(student.photoFilename ?? ''));

  /* 1. the workbook explicitly names the file */
  if (filename && entry.key === filename) return 1;

  /* 2. roll / serial number — "13_EKANJOT.jpg" only matches an EKANJOT with
   *    roll 13; a same-roll classmate is left blank instead of receiving the
   *    wrong child's photograph. */
  if (roll && entryHasIdentifier(entry, roll)) {
    return entryNamesStudent(entry, student) ? 2 : null;
  }

  /* 3. admission number */
  if (admission && entryHasIdentifier(entry, admission)) {
    return entryNamesStudent(entry, student, admission) ? 3 : null;
  }

  /* 4. internal id */
  if (id && (entry.tokens.includes(id) || entry.key === id)) return 4;
  if (rowId && (entry.tokens.includes(rowId) || entry.key === rowId)) return 4;

  /* 5. exact normalised name (filename is only the student's name) */
  if (name && entry.key === name) return 5;

  /* 6. the name appears inside the filename. Only accept a full token
   *    sequence, so "AN" never matches "ANJALI". */
  if (name && containsNameTokens(entry, student.name)) return 6;

  return null;
}

/** True when every token of the student's name appears, in order, in the file name. */
function containsNameTokens(entry: PhotoEntry, rawName: string): boolean {
  const nameTokens = String(rawName ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (nameTokens.length === 0) return false;

  let cursor = 0;
  for (const token of nameTokens) {
    const next = entry.tokens.indexOf(token, cursor);
    if (next === -1) return false;
    cursor = next + 1;
  }
  return true;
}

/** A matched photo with the strength (tier) of the signal that found it. */
export interface PhotoMatch {
  entry: PhotoEntry;
  /** Lower is stronger: 1 = named in the workbook, 6 = name inside filename. */
  tier: number;
}

/**
 * Best match for one student, with the tier that produced it.
 * Returns undefined when nothing matches, or when two equally strong candidates
 * exist and neither carries the student's name.
 */
export function resolveStudentPhotoMatch(
  index: PhotoIndex,
  student: PhotoStudent,
): PhotoMatch | undefined {
  let bestTier: number | null = null;
  let best: PhotoEntry[] = [];

  for (const entry of index.entries) {
    const tier = matchTier(entry, student);
    if (tier === null) continue;
    if (bestTier === null || tier < bestTier) {
      bestTier = tier;
      best = [entry];
    } else if (tier === bestTier) {
      best.push(entry);
    }
  }

  if (best.length === 0 || bestTier === null) return undefined;
  if (best.length === 1) return { entry: best[0], tier: bestTier };

  /* Multiple candidates at the same strength: only accept one that also
   * carries the student's name. Otherwise leave the photo blank rather than
   * risk attaching another child's photograph. */
  const name = collapse(student.name);
  const nameMatch = best.filter(
    (entry) =>
      (name !== '' && entry.key === name) || containsNameTokens(entry, student.name),
  );
  if (nameMatch.length === 1) return { entry: nameMatch[0], tier: bestTier };

  return undefined;
}

/**
 * Resolve the photo for one student inside a pre-built index.
 * Returns undefined (blank placeholder) when the match is missing or ambiguous.
 */
export function resolveStudentPhoto(
  index: PhotoIndex,
  student: PhotoStudent,
): string | undefined {
  return resolveStudentPhotoMatch(index, student)?.entry.dataUrl;
}

/**
 * Resolve photos for a whole batch.
 *
 * A photo is handed to at most one student, and only when that student has the
 * STRONGEST claim on it. If two students claim the same picture at the same
 * strength the picture is refused for both (and both are reported), because
 * attaching the wrong child's photograph is worse than showing none.
 *
 * A strong identifier beats a weak name match: "27_Aarav Sharma.jpg" goes to the
 * child whose roll number is 27, not to a same-named classmate who merely has
 * their name inside the file name.
 */
export function resolvePhotosForStudents(
  index: PhotoIndex,
  students: PhotoStudent[],
): { photos: Map<string, string>; ambiguous: string[] } {
  const photos = new Map<string, string>();
  const ambiguous: string[] = [];
  /* dataUrl → every student that claimed it, with the tier of that claim. */
  const claims = new Map<string, { studentId: string; tier: number }[]>();

  for (const student of students) {
    const match = resolveStudentPhotoMatch(index, student);
    if (!match) continue;
    const owners = claims.get(match.entry.dataUrl) ?? [];
    owners.push({ studentId: student.studentId, tier: match.tier });
    claims.set(match.entry.dataUrl, owners);
  }

  for (const [dataUrl, owners] of claims) {
    if (owners.length === 1) {
      photos.set(owners[0].studentId, dataUrl);
      continue;
    }

    const strongest = Math.min(...owners.map((owner) => owner.tier));
    const winners = owners.filter((owner) => owner.tier === strongest);

    if (winners.length === 1) {
      photos.set(winners[0].studentId, dataUrl);
      for (const owner of owners) {
        if (owner.studentId !== winners[0].studentId) ambiguous.push(owner.studentId);
      }
      continue;
    }

    /* Same picture, same strength, more than one child — refuse it for all. */
    for (const owner of owners) ambiguous.push(owner.studentId);
  }

  return { photos, ambiguous };
}

/**
 * Backwards-compatible single-student helper (used where no student list is
 * available). Prefer `buildPhotoIndex` + `resolveStudentPhoto` for batches.
 */
export function resolvePhotoForStudent(
  photoMap: PhotoMap,
  rollNo?: string,
  photoFilename?: string,
  studentName?: string,
): string | undefined {
  if (photoFilename && photoMap[photoFilename]) return photoMap[photoFilename];
  if (photoFilename && photoMap[photoFilename.toLowerCase()]) {
    return photoMap[photoFilename.toLowerCase()];
  }

  const index = buildPhotoIndex(photoMap);
  return resolveStudentPhoto(index, {
    studentId: '',
    rowNumber: 0,
    rollNo: rollNo ?? '',
    name: studentName ?? '',
    photoFilename,
  });
}

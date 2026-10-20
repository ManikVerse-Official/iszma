import type { PhotoMap, Student } from '../types';
import { buildPhotoIndex, resolvePhotosForStudents } from './photoMatcher';

/**
 * Manual photo corrections.
 *
 * The automatic matcher (services/photoMatcher.ts) only ever attaches a photo
 * when a *strong* identity signal matches. When it refuses — an ambiguous name,
 * a missing roll number, a photo nothing points at — a human must be able to
 * decide, per student, without re-uploading the whole ZIP.
 *
 * An override map is keyed by `studentId`:
 *
 *   • `string` → the data URL of the photo the user chose for that student
 *                (manual pick from the ZIP, or a single file they uploaded);
 *   • `null`   → the user cleared the photo: no photo is printed, even when the
 *                matcher would have found one.
 *
 * There is one resolver. The review table, the on-screen preview and the real
 * PDF generator all call `resolvePhotosWithOverrides`, so a green row in the
 * review table is always the picture that will be printed.
 */

export type PhotoOverrides = Record<string, string | null>;

export type PhotoStatus =
  /** Chosen by the user for this student. */
  | 'manual'
  /** The user explicitly removed the photo for this student. */
  | 'cleared'
  /** Matched by identity. */
  | 'matched'
  /** The same photo fits more than one student — refused. */
  | 'ambiguous'
  /** Nothing matched. */
  | 'missing';

/** Minimal student shape the resolver needs (same as the matcher's). */
export type PhotoStudent = Pick<Student, 'studentId' | 'rowNumber' | 'rollNo' | 'name'> &
  Partial<Pick<Student, 'admissionNo' | 'photoFilename'>>;

export interface PhotoResolution {
  /** studentId → photo data URL, for every student that will print a photo. */
  photos: Map<string, string>;
  /** studentIds the automatic matcher refused to decide. */
  ambiguous: string[];
  /** studentId → how its photo was decided. */
  status: Map<string, PhotoStatus>;
  /**
   * Manual choices that give the same picture to more than one student. The
   * user's explicit choice is honoured (they may have two identical files) but
   * the UI warns instead of letting it pass silently.
   */
  conflicts: string[];
}

/**
 * Photos for a batch, with manual corrections applied on top of identity
 * matching. Pure and deterministic: no browser APIs, so it is directly testable.
 */
export function resolvePhotosWithOverrides(
  students: PhotoStudent[],
  photoMap: PhotoMap,
  overrides: PhotoOverrides = {},
): PhotoResolution {
  const index = buildPhotoIndex(photoMap);
  const { photos, ambiguous } = resolvePhotosForStudents(index, students);
  const status = new Map<string, PhotoStatus>();

  for (const student of students) {
    const id = student.studentId;
    if (!Object.prototype.hasOwnProperty.call(overrides, id)) continue;

    const manual = overrides[id];
    if (manual) {
      photos.set(id, manual);
      status.set(id, 'manual');
    } else {
      /* Explicitly cleared: never fall back to an automatic match. */
      photos.delete(id);
      status.set(id, 'cleared');
    }
  }

  for (const student of students) {
    const id = student.studentId;
    if (status.has(id)) continue;
    status.set(
      id,
      ambiguous.includes(id) ? 'ambiguous' : photos.has(id) ? 'matched' : 'missing',
    );
  }

  /* Two students sharing one manually chosen picture is worth a warning. */
  const claims = new Map<string, string[]>();
  for (const [id, url] of photos) {
    const owners = claims.get(url) ?? [];
    owners.push(id);
    claims.set(url, owners);
  }
  const conflicts: string[] = [];
  for (const owners of claims.values()) {
    if (owners.length < 2) continue;
    const manualOwners = owners.filter((id) => status.get(id) === 'manual');
    if (manualOwners.length < 2) continue;
    conflicts.push(...manualOwners);
  }

  return { photos, ambiguous, status, conflicts };
}

/** Human sentence for a review-table status (UI copy lives with the resolver). */
export function photoStatusLabel(status: PhotoStatus): string {
  switch (status) {
    case 'manual':
      return 'Chosen manually';
    case 'cleared':
      return 'Cleared — no photo will print';
    case 'matched':
      return 'Confirmed';
    case 'ambiguous':
      return 'Needs review — left blank rather than risk the wrong photo';
    default:
      return 'No photo matched — blank photo box on report';
  }
}

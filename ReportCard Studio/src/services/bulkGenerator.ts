import JSZip from 'jszip';
import type { GenerationResult } from '../types';
import {
  generateStudentPdfBlob,
  buildPdfFilename,
  buildZipFilename,
} from './pdfGenerator';
import { resolvePhotosWithOverrides, type PhotoOverrides } from './photoOverrides';
import type { PhotoMap, SchoolProfile, Student } from '../types';

export interface BatchOptions {
  students: Student[];
  school: SchoolProfile;
  photoMap: PhotoMap;
  /** Manual per-student photo corrections made in the review table. */
  photoOverrides?: PhotoOverrides;
  batchSize?: number;
  onProgress?: (info: {
    completed: number;
    failed: number;
    total: number;
    current?: Student;
  }) => void;
  onStudentComplete?: (res: GenerationResult) => void;
  signal?: AbortSignal;
}

export async function generateAllAndZip(opts: BatchOptions): Promise<{
  blob: Blob;
  filename: string;
  results: GenerationResult[];
}> {
  const {
    students,
    school,
    photoMap,
    photoOverrides,
    batchSize = 5,
    onProgress,
    onStudentComplete,
    signal,
  } = opts;

  const zip = new JSZip();
  const usedNames = new Set<string>();
  const results: GenerationResult[] = [];
  let completed = 0;
  let failed = 0;

  /*
   * Photos are resolved once for the whole batch with the SAME resolver the
   * review table uses: identity matching (roll / admission / name), never
   * upload order, with the user's manual corrections applied on top. A picture
   * claimed by two students is dropped for both instead of being attached to
   * the wrong child.
   */
  const { photos: studentPhotos } = resolvePhotosWithOverrides(students, photoMap, photoOverrides ?? {});

  for (let i = 0; i < students.length; i += batchSize) {
    if (signal?.aborted) {
      throw new Error('Generation cancelled by user');
    }
    const batch = students.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(
      batch.map(async (stu) => {
        if (signal?.aborted) throw new Error('Cancelled');
        const photo = studentPhotos.get(stu.studentId);
        const blob = await generateStudentPdfBlob({
          student: stu,
          school,
          photoDataUrl: photo,
        });
        const fileName = buildPdfFilename(stu.rollNo, stu.name, usedNames);
        return { student: stu, blob, fileName };
      }),
    );

    for (const result of batchResults) {
      if (result.status === 'fulfilled') {
        const { student, blob, fileName } = result.value;
        zip.file(fileName, blob);
        const res: GenerationResult = {
          studentId: student.studentId,
          rollNo: student.rollNo,
          name: student.name,
          rowNumber: student.rowNumber,
          success: true,
          fileName,
        };
        results.push(res);
        onStudentComplete?.(res);
        completed++;
      } else {
        const idx = batchResults.indexOf(result);
        const student = batch[idx];
        const res: GenerationResult = {
          studentId: student.studentId,
          rollNo: student.rollNo,
          name: student.name,
          rowNumber: student.rowNumber,
          success: false,
          error: result.reason?.message || 'Unknown error',
        };
        results.push(res);
        onStudentComplete?.(res);
        failed++;
      }
    }

    onProgress?.({
      completed,
      failed,
      total: students.length,
      current: batch[batch.length - 1],
    });
  }

  const zipBlob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  const someStudent = students[0];
  const filename = buildZipFilename(someStudent?.class, someStudent?.section);

  return { blob: zipBlob, filename, results };
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

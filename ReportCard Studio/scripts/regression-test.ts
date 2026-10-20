/*
 * ReportCard Studio regression harness.
 *
 * Runs the real services in Node and asserts the product rules:
 *   1. photo matching uses identity, never upload order;
 *   2. grading / percentage math is correct for mixed maximum marks;
 *   3. stars and remarks differ per student and reflect real performance;
 *   4. Excel-provided data (marks, grades, totals, remarks) wins;
 *   5. every generated PDF contains only that student's data, stays inside one
 *      A4 page and has NO overlapping text (the historical Father's Name /
 *      Admission No. bug).
 *
 * Usage:  npx jiti scripts/regression-test.ts [workbook.xlsx ...]
 */
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { resolveJoyQuery } from '../../src/services/joyAssistant';
import { inflateSync } from 'node:zlib';
import jsPDF from 'jspdf';

import * as XLSX from 'xlsx';

import { parseWorkbookFromFile } from '../src/services/excelParser';
import { parseDynamicStructure } from '../src/services/dynamicExcelParser';
import {
  convertDetectedStructureToColumnMapping,
  createStructureMappingFromDetected,
} from '../src/services/dynamicMappingEngine';
import { autoMapColumns } from '../src/services/mappingEngine';
import {
  buildStudentsFromDynamicStructure,
  buildStudentsFromRows,
} from '../src/services/normalizationEngine';
import { computeTotals, resolveExcelGrades } from '../src/services/calculationEngine';
import {
  DEFAULT_GRADING_BANDS,
  bandsLegend,
  gradeFromMarksOutOf,
  gradeFromPercent,
  percentFromGradeLabel,
} from '../src/services/gradingEngine';
import {
  DEFAULT_ASSESSMENT_CONFIG,
  buildPerformanceProfile,
  rateSkill,
  starsFromAssessmentValue,
} from '../src/services/assessmentEngine';
import { buildRemarkContext, generateTeacherRemark } from '../src/services/remarksEngine';
import { buildReportCardModel } from '../src/services/reportCardModel';
import { verifyReportCardModel } from '../src/services/reportVerification';
import JSZip from 'jszip';
import {
  buildPhotoIndex,
  resolveStudentPhoto,
  resolvePhotosForStudents,
  planZipEntries,
  loadPhotoZipDetailed,
  detectImageFormat,
  MAX_ARCHIVE_BYTES,
} from '../src/services/photoMatcher';
import { generateStudentPdfBlob } from '../src/services/pdfGenerator';
import { generateAllAndZip } from '../src/services/bulkGenerator';
import { REPORT_CARD_THEMES } from '../src/themes';
import { mmToPt, TYPE_MM } from '../src/themes/typography';
import {
  GREETING_ROUTE,
  SCREEN_GUIDES,
  detectExplainLang,
  studioReplyLanguage,
  detectJoyLanguage,
  editDistance,
  explainValidation,
  isValidationQuery,
  MALL_KNOWLEDGE,
  resolveStudioQuery,
  resolveMallSectionAnswer,
  studioFallback,
  studioWelcome,
} from '../src/services/joyKnowledge';
import {
  resolvePhotosWithOverrides,
  photoStatusLabel,
} from '../src/services/photoOverrides';
import { validateStudents } from '../src/services/validationEngine';
import {
  analyzeExaminations,
  classifyComponent,
} from '../src/services/examinationEngine';
import {
  explainExaminations,
  explainGenerationFailures,
  explainGrandTotal,
  explainMapping,
  explainMaximumMarks,
  explainPhotoMatching,
  isExaminationQuery,
  isGenerationFailureQuery,
  isGrandTotalQuery,
  isMappingQuery,
  isMaxMarksQuery,
  isPhotoQuery,
} from '../src/services/joyKnowledge';
import type { PhotoMap, SchoolProfile, Student } from '../src/types';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++;
    return;
  }
  failed++;
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

function near(a: number, b: number, tolerance = 0.01): boolean {
  return Math.abs(a - b) <= tolerance;
}

(globalThis as any).FileReader = class FileReader {
  result: any;
  error: any;
  onload: any;
  onerror: any;
  readAsArrayBuffer(file: any) {
    Promise.resolve(file.arrayBuffer())
      .then((ab: ArrayBuffer) => {
        this.result = ab;
        if (this.onload) this.onload({ target: this });
      })
      .catch((e: any) => {
        this.error = e;
        if (this.onerror) this.onerror(e);
      });
  }
};

function fileFromPath(p: string): File {
  const buf = readFileSync(p);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return { name: basename(p), arrayBuffer: () => Promise.resolve(ab) } as any as File;
}

const SCHOOL: SchoolProfile = {
  schoolName:
    'SHAHEED BHAGAT SINGH SENIOR SECONDARY PUBLIC SCHOOL OF EXCELLENCE (AFFILIATED TO C.B.S.E., NEW DELHI)',
  address: 'Village Jhiwerheri, Yamuna Nagar (Haryana) - 135001',
  affiliationText: 'AFFILIATED TO C.B.S.E., NEW DELHI',
  schoolCode: '41627',
  affiliationNo: '531651',
  principalName: 'Ruhi Rani',
  teacherName: 'Pooja Sharma',
  checkedByName: 'Zahida',
  academicSession: '2026-27',
  examTerm: 'Periodic Test - I',
  dateOfIssue: '14-08-2026',
};

/* ─────────────────────────── 1. photo matching ─────────────────────────── */

function testPhotoMatching(): void {
  console.log('\n## photo matching');
  const photoMap: PhotoMap = {
    '13_EKANJOT.jpg': 'data:image/png;base64,AAAA',
    'ADM-2019-1043.png': 'data:image/png;base64,BBBB',
    'Aarav Sharma.jpeg': 'data:image/png;base64,CCCC',
    'Riya_Verma.jpg': 'data:image/png;base64,DDDD',
  };
  const index = buildPhotoIndex(photoMap);

  const ekanjot = {
    studentId: 'row-2',
    rowNumber: 2,
    rollNo: '13',
    name: 'EKANJOT',
    admissionNo: 'X1',
  };
  check(
    'roll-prefixed filename matches the right student',
    resolveStudentPhoto(index, ekanjot) === photoMap['13_EKANJOT.jpg'],
  );

  const admission = {
    studentId: 'row-3',
    rowNumber: 3,
    rollNo: '77',
    name: 'Simran Kaur',
    admissionNo: 'ADM-2019-1043',
  };
  check(
    'admission number matches when the filename has no roll',
    resolveStudentPhoto(index, admission) === photoMap['ADM-2019-1043.png'],
  );

  const byName = {
    studentId: 'row-4',
    rowNumber: 4,
    rollNo: '91',
    name: 'Riya Verma',
  };
  check(
    'normalised name matches',
    resolveStudentPhoto(index, byName) === photoMap['Riya_Verma.jpg'],
  );

  /* Two students share roll 13: the filename carries the name to disambiguate. */
  const duplicateRoll = {
    studentId: 'row-9',
    rowNumber: 9,
    rollNo: '13',
    name: 'Gurpreet',
  };
  check(
    'ambiguous roll without a name match leaves the photo blank',
    resolveStudentPhoto(index, duplicateRoll) === undefined,
  );

  /* Identical names, different rolls: identity still resolves correctly. */
  const aarav = {
    studentId: 'row-5',
    rowNumber: 5,
    rollNo: '5',
    name: 'Aarav Sharma',
  };
  check(
    'duplicate names resolve by their own filename',
    resolveStudentPhoto(index, aarav) === photoMap['Aarav Sharma.jpeg'],
  );

  const missing = {
    studentId: 'row-6',
    rowNumber: 6,
    rollNo: '404',
    name: 'Nobody Here',
  };
  check('missing photo stays blank', resolveStudentPhoto(index, missing) === undefined);

  /* Order must not matter at all. */
  const reversed = buildPhotoIndex({
    'Riya_Verma.jpg': photoMap['Riya_Verma.jpg'],
    'Aarav Sharma.jpeg': photoMap['Aarav Sharma.jpeg'],
    'ADM-2019-1043.png': photoMap['ADM-2019-1043.png'],
    '13_EKANJOT.jpg': photoMap['13_EKANJOT.jpg'],
  });
  check(
    'matching is independent of upload order',
    resolveStudentPhoto(reversed, ekanjot) === resolveStudentPhoto(index, ekanjot),
  );

  /*
   * The batch resolver is what the PDF generator and the preview's photo-review
   * table both call, so these two guarantees are what keep "confirmed" in the
   * UI and "printed" in the PDF the same thing.
   */
  {
    const batch = resolvePhotosForStudents(index, [
      ekanjot,
      admission,
      byName,
      aarav,
      missing,
    ]);
    check(
      'a clearly matched student gets a photo',
      batch.photos.get('row-2') === photoMap['13_EKANJOT.jpg'],
    );
    check('an unmatched student gets no photo (blank box)', !batch.photos.has('row-6'));
    check('no student is reported ambiguous when every match is unique', batch.ambiguous.length === 0);

    /*
     * A surname alone is not an identity: "Sharma.jpg" must not be attached to
     * a child just because the file shares their surname. Nobody matches, so
     * both are simply reported as missing.
     */
    const surnameOnly = resolvePhotosForStudents(
      buildPhotoIndex({ 'Sharma.jpg': 'data:image/png;base64,ZZZZ' }),
      [
        { studentId: 'a', rowNumber: 1, rollNo: '1', name: 'Aarav Sharma' },
        { studentId: 'b', rowNumber: 2, rollNo: '2', name: 'Meera Sharma' },
      ],
    );
    check(
      'a surname-only filename is not treated as a match',
      surnameOnly.photos.size === 0 && surnameOnly.ambiguous.length === 0,
    );

    /*
     * The real ambiguity case: one photo whose only signal is a roll number
     * that TWO students share. It must be refused for both, and both must be
     * reported so the UI can say "Needs review" instead of silently blanking.
     */
    const sharedRoll = resolvePhotosForStudents(
      buildPhotoIndex({ '01_Rahul.jpg': 'data:image/png;base64,ZZZZ' }),
      [
        { studentId: 'a', rowNumber: 1, rollNo: '01', name: 'Rahul Kumar' },
        { studentId: 'b', rowNumber: 2, rollNo: '01', name: 'Rahul Singh' },
      ],
    );
    check(
      'one photo is never handed to two students who share a roll number',
      sharedRoll.photos.size === 0 && sharedRoll.ambiguous.length === 2,
      `${sharedRoll.photos.size} photos, ${sharedRoll.ambiguous.length} flagged`,
    );

    /* A photo that only one student's roll number matches stays confirmed. */
    const single = resolvePhotosForStudents(buildPhotoIndex({ '7_Ishaan.jpg': 'data:image/png;base64,YYYY' }), [
      { studentId: 'c', rowNumber: 1, rollNo: '7', name: 'Ishaan' },
      { studentId: 'd', rowNumber: 2, rollNo: '8', name: 'Meera' },
    ]);
    check(
      'a unique roll-number match stays confirmed',
      single.photos.get('c') === 'data:image/png;base64,YYYY' && !single.photos.has('d'),
    );
  }
}

/* ────────────── 1b. photo ZIP safety (hostile / messy archives) ────────────── */

function testPhotoZipPlan(): void {
  console.log('\n## photo ZIP safety');

  const dupes = planZipEntries(['Rahul.jpg', 'rahul.JPG', 'Roll_01_Rahul.jpg']);
  check(
    'duplicate photo names are reported and the first one is kept',
    dupes.accepted.length === 2 &&
      dupes.accepted[0] === 'Rahul.jpg' &&
      dupes.duplicates.length === 1 &&
      dupes.duplicates[0] === 'rahul.JPG',
  );

  const traversal = planZipEntries([
    '../../etc/passwd.jpg',
    '..\\..\\windows\\evil.png',
    'photos/01_Rahul_Kumar.jpg',
  ]);
  check(
    'path traversal entries are refused, nested folders are fine',
    traversal.rejected.filter((r) => r.reason === 'path traversal').length === 2 &&
      traversal.accepted.length === 1 &&
      traversal.accepted[0] === '01_Rahul_Kumar.jpg',
  );

  const junk = planZipEntries([
    '__MACOSX/._Rahul.jpg',
    '.DS_Store.jpg',
    'notes.txt',
    'photo.pdf',
    'README',
  ]);
  check(
    'hidden and macOS system entries are ignored',
    junk.rejected.filter((r) => r.reason === 'hidden or system entry').length === 2,
  );
  check('non-image files are ignored entirely', junk.accepted.length === 0);

  const distinct = planZipEntries(['01_Rahul.jpg', '1_Amit.jpg', '  02_Sara.png  ']);
  check(
    'leading zeros stay distinct identities (01 ≠ 1)',
    distinct.accepted.length === 3 && distinct.accepted[2] === '02_Sara.png',
  );

  check(
    'jpeg is detected from its bytes',
    detectImageFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])) === 'jpeg',
  );
  check(
    'png is detected from its bytes',
    detectImageFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])) === 'png',
  );
  check(
    'a renamed text file is not mistaken for an image',
    detectImageFormat(new TextEncoder().encode('this is definitely not a photograph')) === null,
  );
}

/** Minimal browser File stand-in: Node has no FileReader/File. */
const fakeFile = (bytes: Uint8Array): File =>
  ({
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  }) as unknown as File;

/**
 * blobToDataUrl uses FileReader, which Node lacks. The stub returns a fixed
 * data URL — these tests assert *which* photos are handed out, not the bytes.
 */
class StubFileReader {
  result: string | ArrayBuffer | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL(blob: Blob): void {
    blob
      .arrayBuffer()
      .then(() => {
        this.result = 'data:image/png;base64,STUB';
        this.onload?.();
      })
      .catch(() => this.onerror?.());
  }
}

async function testPhotoZipLoading(): Promise<void> {
  console.log('\n## photo ZIP loading');
  const realFileReader = (globalThis as Record<string, unknown>).FileReader;
  (globalThis as Record<string, unknown>).FileReader = StubFileReader;

  try {
    let oversize = '';
    try {
      await loadPhotoZipDetailed({
        size: MAX_ARCHIVE_BYTES + 1,
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as File);
    } catch (error) {
      oversize = (error as Error).message;
    }
    check('an oversized ZIP is refused before it is read', /under 200 MB/.test(oversize));

    let corrupt = '';
    try {
      await loadPhotoZipDetailed(fakeFile(new TextEncoder().encode('this is not a zip archive at all')));
    } catch (error) {
      corrupt = (error as Error).message;
    }
    check('a corrupted ZIP fails with a clear, non-crashing message', /corrupted/i.test(corrupt));

    /* A real archive: one good photo, one renamed text file, one note. */
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const zip = new JSZip();
    zip.file('01_Rahul_Kumar.jpg', png);
    zip.file('fake.jpg', 'not really a photo');
    zip.file('notes.txt', 'hello');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const result = await loadPhotoZipDetailed(fakeFile(bytes));

    check(
      'a real photo loads under its filename and its bare name',
      typeof result.map['01_Rahul_Kumar.jpg'] === 'string' &&
        result.map['01_Rahul_Kumar'] === result.map['01_Rahul_Kumar.jpg'],
    );
    check('a text file named .jpg is rejected, not attached', result.map['fake.jpg'] === undefined);
    check(
      'the rejected file is reported with a reason',
      result.rejected.some((r) => r.name === 'fake.jpg' && r.reason === 'not a readable image'),
    );
    check('non-image entries never enter the photo map', result.map['notes.txt'] === undefined);
  } finally {
    (globalThis as Record<string, unknown>).FileReader = realFileReader;
  }
}

/* ─────────────────────── 2. grading & totals math ─────────────────────── */

function makeStudent(overrides: Partial<Student> = {}): Student {
  return {
    studentId: 'row-2',
    rowNumber: 2,
    rollNo: '1',
    name: 'Test Student',
    class: '8',
    section: 'A',
    subjects: [],
    ...overrides,
  };
}

function testGradingAndTotals(): void {
  console.log('\n## grading & totals');

  check('grade A1 at 95%', gradeFromPercent(95) === 'A1');
  /* The scale is capped at C1 — nothing below it is ever printed. */
  check('grades never go below C1', gradeFromPercent(42) === 'C1');
  /* 20/25 = 80% → B1, 12/25 = 48% → C1 */
  check('grade for a 25-mark subject (80%)', gradeFromMarksOutOf(20, 25) === 'B1');
  check('grade for a 25-mark subject (48%)', gradeFromMarksOutOf(12, 25) === 'C1');
  check('legend stops at C1', bandsLegend(DEFAULT_GRADING_BANDS).includes('C1 (0-60)'));
  check('grade for 80-mark subject', gradeFromMarksOutOf(72, 80) === 'A2');
  check('legend is generated from the bands', bandsLegend(DEFAULT_GRADING_BANDS).includes('A1 (91-100)'));
  check('percent from a letter grade', percentFromGradeLabel('B+') === 78);

  /* Mixed maxima: 80 + 50 + 25 + 100 = 255, obtained 60 + 45 + 20 + 90 = 215 */
  const student = makeStudent({
    subjects: [
      { name: 'Mathematics', marks: 60, maxMarks: 80, status: 'present', hasComponents: false },
      { name: 'English', marks: 45, maxMarks: 50, status: 'present', hasComponents: false },
      { name: 'GK', marks: 20, maxMarks: 25, status: 'present', hasComponents: false },
      { name: 'Science', marks: 90, maxMarks: 100, status: 'present', hasComponents: false },
    ],
  });
  const totals = computeTotals(student);
  check('grand total uses mixed maxima', totals.totalMarks === 215 && totals.totalMax === 255,
    `${totals.totalMarks}/${totals.totalMax}`);
  const expectedPct = Math.round((215 / 255) * 10000) / 100;
  check('percentage = obtained / max × 100', totals.percentage === expectedPct, `${totals.percentage}`);

  /* Component subject with an Excel TOTAL: the TOTAL wins, components are not summed twice. */
  const withTotal = makeStudent({
    subjects: [
      {
        name: 'English',
        marks: 79,
        maxMarks: 100,
        status: 'present',
        hasComponents: true,
        components: [
          { name: 'PT', marks: 9, maxMarks: 10, status: 'present', isTotal: false },
          { name: 'NB', marks: 5, maxMarks: 5, status: 'present', isTotal: false },
          { name: 'SEA', marks: 5, maxMarks: 5, status: 'present', isTotal: false },
          { name: 'SA2', marks: 60, maxMarks: 80, status: 'present', isTotal: false },
          { name: 'TOTAL', marks: 79, maxMarks: 100, status: 'present', isTotal: true },
        ],
      },
    ],
  });
  const totalTotals = computeTotals(withTotal);
  check('Excel TOTAL is not double counted', totalTotals.totalMarks === 79, `${totalTotals.totalMarks}`);
  check('Excel TOTAL maximum is used', totalTotals.totalMax === 100);

  /* Total missing → components are summed. */
  const noTotal = makeStudent({
    subjects: [
      {
        name: 'English',
        marks: 69,
        maxMarks: 100,
        status: 'present',
        hasComponents: true,
        components: [
          { name: 'PT', marks: 9, maxMarks: 10, status: 'present', isTotal: false },
          { name: 'SA2', marks: 60, maxMarks: 90, status: 'present', isTotal: false },
        ],
      },
    ],
  });
  check('components are summed when no TOTAL exists', computeTotals(noTotal).totalMarks === 69);

  /* Absent subject: never counted as marks. */
  const absent = makeStudent({
    subjects: [
      { name: 'English', marks: null, maxMarks: 100, status: 'absent', hasComponents: false },
      { name: 'Maths', marks: 80, maxMarks: 100, status: 'present', hasComponents: false },
    ],
  });
  check('AB subject contributes no marks', computeTotals(absent).totalMarks === 80);

  /* An impossible Excel percentage is never printed. */
  const badPercent = makeStudent({
    subjects: [{ name: 'Maths', marks: 90, maxMarks: 100, status: 'present', hasComponents: false }],
    overall: { total: 90, percentage: 140 },
  });
  const badTotals = computeTotals(badPercent);
  check(
    'impossible Excel percentage is rejected',
    badTotals.percentage === 90 && badTotals.percentageSource === 'computed',
    `${badTotals.percentage} (${badTotals.percentageSource})`,
  );

  /* A plausible Excel percentage is preserved. */
  const goodPercent = makeStudent({
    subjects: [{ name: 'Maths', marks: 90, maxMarks: 100, status: 'present', hasComponents: false }],
    overall: { percentage: 90 },
  });
  check('plausible Excel percentage is preserved', computeTotals(goodPercent).percentageSource === 'excel');

  /* Excel grades are preserved instead of recomputed. */
  const graded = makeStudent({
    subjects: [
      { name: 'MATHEMATICS', marks: 76, maxMarks: 80, status: 'present', hasComponents: false },
      { name: 'Science', marks: 40, maxMarks: 100, status: 'present', hasComponents: false },
    ],
    gradeFields: [
      { name: 'MATHEMATICS | GRADE', value: 'A1' },
      { name: 'MV', value: 'B' },
    ],
  });
  const gradeMap = resolveExcelGrades(graded);
  check('Excel subject grade is preserved', gradeMap.get('MATHEMATICS') === 'A1');
  const gradedModel = buildReportCardModel(graded, SCHOOL);
  const mathsRow = gradedModel.academic.find((row) => row.name === 'MATHEMATICS');
  check('academic row prints the Excel grade', mathsRow?.grade === 'A1', mathsRow?.grade);
  check('co-scholastic keeps MV', gradedModel.coScholastic.some((row) => row.name === 'MV'));
  check(
    'subject grade column is not duplicated as co-scholastic',
    !gradedModel.coScholastic.some((row) => /mathematics/i.test(row.name)),
  );
}

/* ───────────────────────── 3. stars & remarks ─────────────────────────── */

function testAssessmentAndRemarks(): void {
  console.log('\n## stars & remarks');

  const high = makeStudent({
    studentId: 'row-10',
    name: 'High Performer',
    subjects: [
      { name: 'English', marks: 92, maxMarks: 100, status: 'present', hasComponents: false },
      { name: 'Maths', marks: 74, maxMarks: 80, status: 'present', hasComponents: false },
    ],
  });
  const low = makeStudent({
    studentId: 'row-11',
    name: 'Low Performer',
    subjects: [
      { name: 'English', marks: 38, maxMarks: 100, status: 'present', hasComponents: false },
      { name: 'Maths', marks: 22, maxMarks: 80, status: 'present', hasComponents: false },
    ],
  });

  const highProfile = buildPerformanceProfile(high);
  const lowProfile = buildPerformanceProfile(low);
  const highStars = ['Understanding', 'Creativity', 'Leadership Qualities'].map(
    (skill) => rateSkill(skill, highProfile).stars,
  );
  const lowStars = ['Understanding', 'Creativity', 'Leadership Qualities'].map(
    (skill) => rateSkill(skill, lowProfile).stars,
  );

  check('high performer earns more stars', Math.min(...highStars) > Math.max(...lowStars),
    `${highStars.join(',')} vs ${lowStars.join(',')}`);
  check('stars stay inside the scale', [...highStars, ...lowStars].every((s) => s >= 0 && s <= 5));
  check('stars are not the same for every skill', new Set(highStars).size > 1, highStars.join(','));
  check(
    'stars are deterministic for a student',
    rateSkill('Understanding', highProfile).stars === highStars[0],
  );

  /* Excel assessment values win over the computed rating. */
  const excelRated = rateSkill('Understanding', lowProfile, 'A+');
  check('Excel grade overrides the computed stars', excelRated.stars === 5 && excelRated.source === 'excel');
  check('star glyphs are parsed', starsFromAssessmentValue('★★★☆☆') === 3);
  check('numeric assessment is parsed out of 5', starsFromAssessmentValue('4/5') === 4);

  const models = [high, low].map((student) => buildReportCardModel(student, SCHOOL));
  const starSets = models.map((m) =>
    [...m.learning, ...m.personality].map((row) => row.stars).join('-') + '-' + m.academic.length,
  );
  check(
    'two students never receive identical star sets',
    starSets[0] !== starSets[1],
    starSets.join(' | '),
  );

  const highRemark = models[0].teacherRemarks;
  const lowRemark = models[1].teacherRemarks;
  check('remarks differ between performance bands', highRemark !== lowRemark);
  check('remarks mention a real subject', /english|maths/i.test(highRemark), highRemark);
  check('no placeholder remark is printed', !/TODO|undefined|null/.test(highRemark));

  const sameBandA = makeStudent({
    studentId: 'row-21',
    name: 'Same Band A',
    subjects: [{ name: 'English', marks: 76, maxMarks: 100, status: 'present', hasComponents: false }],
  });
  const sameBandB = makeStudent({
    studentId: 'row-22',
    name: 'Same Band B',
    subjects: [{ name: 'Hindi', marks: 76, maxMarks: 100, status: 'present', hasComponents: false }],
  });
  const remarkA = generateTeacherRemark(buildRemarkContext(sameBandA));
  const remarkB = generateTeacherRemark(buildRemarkContext(sameBandB));
  check('same marks do not produce byte-identical remarks', remarkA !== remarkB, `${remarkA} || ${remarkB}`);

  /* Excel remarks take priority. */
  const withRemark = makeStudent({
    studentId: 'row-30',
    subjects: [{ name: 'English', marks: 76, maxMarks: 100, status: 'present', hasComponents: false }],
    teacherRemarks: 'Teacher wrote this in the workbook.',
  });
  const remarkModel = buildReportCardModel(withRemark, SCHOOL);
  check(
    'workbook remarks are preserved',
    remarkModel.teacherRemarks === 'Teacher wrote this in the workbook.',
  );
  check('model flags Excel remarks', remarkModel.remarksFromExcel === true);
}

/* ─────────────────── 4. PDF text extraction and overlap ───────────────── */

interface TextRun {
  page: number;
  x: number;
  y: number;
  size: number;
  style: 'normal' | 'bold';
  text: string;
}

const BLOCK_RE =
  /BT\s*\/(F\d+)\s+([\d.]+)\s+Tf[\s\S]*?([\d.-]+)\s+([\d.-]+)\s+Td\s*\(((?:[^()\\]|\\.)*)\)\s*Tj\s*ET/g;

function decodePdfText(raw: string): string {
  return raw
    .replace(/\\([()\\])/g, '$1')
    .replace(/\\n/g, '\n')
    .replace(/\\(\d{3})/g, (_match, code) => String.fromCharCode(Number.parseInt(code, 8)));
}

const OBJ_RE = /(\d+)\s+0\s+obj([\s\S]*?)endobj/g;
const STREAM_RE = /stream\r?\n([\s\S]*?)\r?\nendstream/;

/**
 * Page content streams in document order. Coordinates in a PDF are page-local,
 * so text from different pages must never be compared as if it shared a plane
 * (a multi-page card legitimately restarts near the top margin on page 2).
 */
function extractPageContents(pdfLatin1: string): string[] {
  const objects = new Map<number, string>();
  const order: number[] = [];
  OBJ_RE.lastIndex = 0;
  let object: RegExpExecArray | null;
  while ((object = OBJ_RE.exec(pdfLatin1))) {
    const number = Number(object[1]);
    objects.set(number, object[2]);
    order.push(number);
  }

  const pages: string[] = [];
  for (const number of order) {
    const body = objects.get(number) ?? '';
    if (!/\/Type\s*\/Page(?!s)/.test(body)) continue;
    const contentsRef = /\/Contents\s+(\d+)\s+0\s+R/.exec(body);
    if (!contentsRef) continue;
    const streamBody = objects.get(Number(contentsRef[1]));
    if (!streamBody) continue;
    /*
     * Slice EXACTLY the declared stream length. Relying on `\nendstream` loses
     * a trailing byte when the compressed data itself ends in 0x0A/0x0D, which
     * truncates the buffer and makes inflate fail (the PDF is still valid — this
     * is purely a harness-parsing detail).
     */
    const header = /stream\r?\n/.exec(streamBody);
    if (!header) continue;
    const start = header.index + header[0].length;
    const declared = Number(/\/Length\s+(\d+)/.exec(streamBody)?.[1]);
    const raw = Number.isFinite(declared)
      ? Buffer.from(streamBody.slice(start, start + declared), 'latin1')
      : Buffer.from(STREAM_RE.exec(streamBody)?.[1] ?? '', 'latin1');
    try {
      pages.push(inflateSync(raw).toString('latin1'));
    } catch {
      /* not a flate stream — skip this page's content */
    }
  }
  return pages;
}

function extractTextRuns(pdfLatin1: string): TextRun[] {
  let contents = extractPageContents(pdfLatin1);
  if (contents.length === 0) {
    /* Fallback: concatenate every readable stream (single-page documents). */
    let content = '';
    const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    let match: RegExpExecArray | null;
    while ((match = streamRe.exec(pdfLatin1))) {
      try {
        content += `${inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1')}\n`;
      } catch {
        /* not a flate stream */
      }
    }
    contents = [content];
  }

  const runs: TextRun[] = [];
  contents.forEach((content, page) => {
    let block: RegExpExecArray | null;
    BLOCK_RE.lastIndex = 0;
    while ((block = BLOCK_RE.exec(content))) {
      runs.push({
        page,
        style: block[1] === 'F2' ? 'bold' : 'normal',
        size: Number(block[2]),
        x: Number(block[3]),
        y: Number(block[4]),
        text: decodePdfText(block[5]),
      });
    }
  });
  return runs;
}

const measureDoc = new jsPDF({ unit: 'pt', format: 'a4' });

function runWidth(run: TextRun): number {
  measureDoc.setFont('helvetica', run.style);
  measureDoc.setFontSize(run.size);
  return measureDoc.getTextWidth(run.text);
}

/** Report overlapping text runs (same page) with their ids. */
function findOverlaps(runs: TextRun[]): string[] {
  const boxes = runs.map((run, index) => {
    const width = runWidth(run);
    return {
      index,
      run,
      left: run.x - 0.4,
      right: run.x + width + 0.4,
      bottom: run.y - run.size * 0.22,
      top: run.y + run.size * 0.82,
    };
  });

  const overlaps: string[] = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.run.page !== b.run.page) continue;
      const horizontal = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const vertical = Math.min(a.top, b.top) - Math.max(a.bottom, b.bottom);
      if (horizontal > 0.75 && vertical > 0.6) {
        overlaps.push(
          `"${a.run.text}" (${a.run.x.toFixed(1)},${a.run.y.toFixed(1)}) ↔ "${b.run.text}" (${b.run.x.toFixed(
            1,
          )},${b.run.y.toFixed(1)})`,
        );
      }
    }
  }
  return overlaps;
}

function pageCount(pdfLatin1: string): number {
  const match = pdfLatin1.match(/\/Count\s+(\d+)/);
  return match ? Number(match[1]) : 0;
}

const PT_PER_MM = 72 / 25.4;

/**
 * Vertical distance (mm) between the lowest line of the assessment body and the
 * TEACHER'S REMARKS label.
 *
 * The remarks/signature blocks must FLOW under the content. They used to be
 * pinned to the bottom of the sheet, which left a ~25-30% blank band (≈60mm on a
 * normal six-subject card) between the skills tables and the remarks, while the
 * browser preview was always compact. `null` when the theme has no remarks block.
 *
 * NOTE: jsPDF writes text in PDF user space — points, y measured from the BOTTOM
 * of the page — so content that sits above the remarks has a LARGER y.
 */
/**
 * Distance (mm) between the lowest printed line and the bottom edge of the card
 * frame (the frame sits 6mm inside the page). A card that uses the page keeps
 * this at roughly 10-15mm; the old layout left ~55mm and the pinned one ~8mm
 * with a hole in the middle instead.
 */
/**
 * Vertical difference (mm) between the lowest line of the left column and the
 * lowest line of the right column of a holistic card.
 *
 * The right column (co-scholastic / attendance / overall) is spread over the
 * depth of the left column; without that, the whole difference appeared as a
 * blank patch under the overall panel. `null` for single-column themes.
 */
function columnBalanceMm(runs: TextRun[], columnSplitPt: number): number | null {
  const label = runs.find((run) => run.text.toUpperCase().includes("TEACHER'S REMARKS"));
  if (!label) return null;
  const above = runs.filter((run) => run.page === label.page && run.y > label.y + 2);
  const left = above.filter((run) => run.x < columnSplitPt).map((run) => run.y);
  const right = above.filter((run) => run.x >= columnSplitPt).map((run) => run.y);
  if (left.length === 0 || right.length === 0) return null;
  return (Math.min(...left) - Math.min(...right)) / PT_PER_MM;
}

function bottomMarginMm(runs: TextRun[]): number {
  const lowest = runs.reduce((min, run) => Math.min(min, run.y), Number.POSITIVE_INFINITY);
  return lowest / PT_PER_MM - 6;
}

function remarksGapMm(runs: TextRun[]): number | null {
  const label = runs.find((run) => run.text.toUpperCase().includes("TEACHER'S REMARKS"));
  if (!label) return null;
  const above = runs.filter((run) => run.page === label.page && run.y > label.y + 2);
  if (above.length === 0) return null;
  const contentLowest = above.reduce((min, run) => Math.min(min, run.y), Number.POSITIVE_INFINITY);
  return (contentLowest - label.y) / PT_PER_MM;
}

async function renderAndCheck(
  student: Student,
  label: string,
  themeId: string,
  expectations: {
    name: string;
    roll: string;
    subjects: string[];
    marks: number[];
    extra?: string[];
    /* Very long mark sheets are allowed to paginate instead of being squeezed. */
    onePage?: boolean;
    /**
     * Allowed blank space below the card frame, in mm. Cards with a real mark
     * sheet are expected to fill the sheet; a card with only a couple of rows
     * (or none at all, e.g. a grade-only workbook) genuinely cannot, so it gets
     * a bigger allowance.
     */
    maxBottomMm?: number;
  },
): Promise<void> {
  const school: SchoolProfile = { ...SCHOOL, reportTheme: themeId };
  const model = buildReportCardModel(student, school);

  const verification = verifyReportCardModel(student, model);
  check(
    `${label} [${themeId}] passes verification`,
    verification.ok,
    verification.errors.map((issue) => issue.message).join(' '),
  );

  const blob = await generateStudentPdfBlob({ student, school });
  const latin1 = Buffer.from(await blob.arrayBuffer()).toString('latin1');
  const runs = extractTextRuns(latin1);
  /* Wrapped lines are separate PDF runs, so compare on a whitespace-normalised
   * single line — a long subject name must still be fully present. */
  const text = runs.map((run) => run.text).join(' ').replace(/\s+/g, ' ');

  if (expectations.onePage === false) {
    /* An oversized card must paginate (never squash itself over the remarks). */
    const pages = pageCount(latin1);
    check(
      `${label} [${themeId}] paginates cleanly`,
      pages >= 2 && pages <= 4,
      `${pages} pages`,
    );
  } else {
    check(`${label} [${themeId}] fits on one A4 page`, pageCount(latin1) <= 1, `${pageCount(latin1)} pages`);
  }
  check(`${label} [${themeId}] draws text`, runs.length > 10, `${runs.length} runs`);

  const offPage = runs.filter(
    (run) => run.x < -1 || run.x > 595.5 || run.y < -1 || run.y > 843,
  );
  check(`${label} [${themeId}] keeps all text on the sheet`, offPage.length === 0,
    offPage.slice(0, 3).map((run) => `${run.text}@${run.x.toFixed(0)},${run.y.toFixed(0)}`).join(' | '));

  const overlaps = findOverlaps(runs);
  check(`${label} [${themeId}] has no overlapping text`, overlaps.length === 0, overlaps.slice(0, 4).join(' || '));

  /* Remarks must hug the content — no large blank band in the lower page. */
  if (expectations.onePage !== false) {
    const gap = remarksGapMm(runs);
    if (gap !== null) {
      /*
       * Upper bound is generous on purpose: part of this distance is the padding
       * inside the last block (a grown result strip is a filled box, not empty
       * space). The bug this guards was ~60mm of truly blank space.
       */
      check(
        `${label} [${themeId}] remarks follow the assessment section`,
        gap >= 2 && gap <= 26,
        `${gap.toFixed(1)}mm gap between content and remarks`,
      );
    }

    /*
     * Holistic cards have two columns; both must reach roughly the same depth
     * (the layout splits the right column's slack over its blocks).
     */
    if (themeId === 'holistic' && expectations.subjects.length >= 4) {
      const balance = columnBalanceMm(runs, 132 * PT_PER_MM);
      if (balance !== null) {
        check(
          `${label} [${themeId}] columns reach the same depth`,
          Math.abs(balance) <= 20,
          `${balance.toFixed(1)}mm difference between column bottoms`,
        );
      }
    }

    /* And the card must use the page height instead of ending early. */
    const margin = bottomMarginMm(runs);
    /*
     * A mark sheet with fewer than four rows (or none at all, e.g. a grade-only
     * workbook) has nothing to fill the page with — the remaining space is
     * decided by the theme's header/footer, so those cards get a wide budget.
     */
    const fillBudget = expectations.maxBottomMm ?? (expectations.subjects.length >= 4 ? 22 : 95);
    check(
      `${label} [${themeId}] fills the page down to the footer`,
      margin <= fillBudget,
      `${margin.toFixed(1)}mm of blank space below the card frame`, 
    );
  }

  check(`${label} [${themeId}] prints the student name`, text.includes(expectations.name));
  check(`${label} [${themeId}] prints the roll number`, text.includes(expectations.roll));

  const missingSubjects = expectations.subjects.filter(
    (subject) => !text.includes(subject.replace(/\s+/g, ' ')),
  );
  check(
    `${label} [${themeId}] prints every subject`,
    missingSubjects.length === 0,
    missingSubjects.join(', '),
  );

  const missingMarks = expectations.marks.filter((marks) => !new RegExp(`\\b${marks}\\b`).test(text));
  check(`${label} [${themeId}] prints the real marks`, missingMarks.length === 0, missingMarks.join(', '));

  for (const needle of expectations.extra ?? []) {
    check(`${label} [${themeId}] prints "${needle}"`, text.includes(needle));
  }
}

/* ───────────────────── 5. workbook driven end-to-end ─────────────────── */

async function buildStudentsFromWorkbook(file: string): Promise<{ students: Student[]; schoolName?: string }> {
  const f = fileFromPath(resolve(process.cwd(), file));
  const workbook = await parseWorkbookFromFile(f);
  const detected = await parseDynamicStructure(f);
  const mappings = convertDetectedStructureToColumnMapping(detected, workbook.headers);
  const structureMapping = createStructureMappingFromDetected(detected);
  const students = buildStudentsFromDynamicStructure(
    workbook.rows,
    structureMapping.detected,
    structureMapping,
    {
      defaultClass: '',
      defaultSection: '',
      inferredClass: detected.inferredClass,
      inferredSection: detected.inferredSection,
    },
    workbook.headers,
    mappings,
  );
  return { students, schoolName: detected.schoolName };
}

async function testWorkbooks(files: string[]): Promise<void> {
  for (const file of files) {
    console.log(`\n## workbook ${file}`);
    const { students, schoolName } = await buildStudentsFromWorkbook(file);
    check(`${file} produced students`, students.length > 0, `${students.length}`);

    if (file.includes('layout_stress')) {
      check(
        'stress workbook exposes all six subjects',
        students[0].subjects.length === 6,
        students[0].subjects.map((s) => `${s.name}:${s.maxMarks}`).join(', '),
      );
      check(
        'different maximum marks survive parsing',
        JSON.stringify(students[0].subjects.map((s) => s.maxMarks)) === JSON.stringify([80, 50, 100, 50, 25, 40]),
        students[0].subjects.map((s) => `${s.name}=${s.maxMarks}`).join(', '),
      );
      check(
        'long subject name is kept verbatim',
        students[0].subjects.some(
          (s) => s.name === 'ENVIRONMENTAL EDUCATION AND DISASTER MANAGEMENT',
        ),
      );
      check('class is not taken from a subject grade column', students[0].class === '8', String(students[0].class));
      check(
        'Excel school name is detected',
        Boolean(schoolName && schoolName.includes('SHAHEED BHAGAT SINGH')),
        schoolName,
      );

      /* Every student passes verification and the percentages are sane. */
      for (const student of students) {
        const model = buildReportCardModel(student, SCHOOL);
        const verification = verifyReportCardModel(student, model);
        check(
          `${file} student ${student.rollNo} verifies`,
          verification.ok,
          verification.errors.map((issue) => issue.message).join(' '),
        );
        check(
          `${file} student ${student.rollNo} percentage is valid`,
          model.totals.percentage === null ||
            (model.totals.percentage >= 0 && model.totals.percentage <= 100),
          `${model.totals.percentage}`,
        );
      }

      /* Stars must not be identical for every student. */
      const starSignatures = students.map((student) =>
        buildReportCardModel(student, SCHOOL)
          .learning.map((row) => row.stars)
          .join(''),
      );
      check('stars vary between students', new Set(starSignatures).size > 1, starSignatures.join(' '));

      const remarkSignatures = students.map(
        (student) => buildReportCardModel(student, SCHOOL).teacherRemarks,
      );
      check('generated remarks vary between students', new Set(remarkSignatures).size > 1);

      /* The reported bug: Father's Name must never collide with Admission No. */
      const first = students[0];
      for (const theme of REPORT_CARD_THEMES) {
        await renderAndCheck(first, `${file} #1`, theme.id, {
          name: first.name,
          roll: first.rollNo,
          subjects: first.subjects.map((s) => s.name),
          marks: first.subjects
            .filter((s) => s.status === 'present' && s.marks !== null)
            .map((s) => s.marks as number),
          extra: [
            'MR.CHARNJEET SINGH SANDHU (S/O LATE KARTAR SINGH)'.slice(0, 20),
            first.admissionNo ?? '',
          ].filter(Boolean),
        });
      }

      /* The exact father's name and the admission number must both be present
       * on their own lines — this is the historical overlap report. */
      const model = buildReportCardModel(first, SCHOOL);
      const blob = await generateStudentPdfBlob({ student: first, school: SCHOOL });
      const runs = extractTextRuns(Buffer.from(await blob.arrayBuffer()).toString('latin1'));
      const fatherRuns = runs.filter((run) => /CHARNJEET/i.test(run.text));
      const admissionRuns = runs.filter((run) => run.text.includes(first.admissionNo ?? '@@'));
      check('father name is printed', fatherRuns.length > 0);
      check('admission number is printed', admissionRuns.length > 0);
      const collision = fatherRuns.some((a) =>
        admissionRuns.some((b) => {
          const overlapX =
            Math.min(a.x + runWidth(a), b.x + runWidth(b)) - Math.max(a.x, b.x);
          const overlapY =
            Math.min(a.y + a.size * 0.82, b.y + b.size * 0.82) -
            Math.max(a.y - a.size * 0.22, b.y - b.size * 0.22);
          return overlapX > 0.5 && overlapY > 0.5;
        }),
      );
      check("Father's Name never overlaps Admission No.", !collision);
      check(
        'long father name wraps onto its own lines',
        fatherRuns.length >= 2 || fatherRuns[0].text.includes('CHARNJEET'),
      );
      /*
       * Both columns carry five fields: Attendance is printed on the card (the
       * reported gap "attendance kahin likhi hi nahi"), and it is the fifth row
       * of the right column so the info grid keeps its height.
       */
      const attendanceRow = model.infoRight.find((item) => item.label === 'Attendance');
      const sourceAttendance = String(first.attendance ?? first.daysPresent ?? '').trim();
      check(
        'the card prints the student attendance',
        model.infoLeft.length === 5 &&
          model.infoRight.length === 5 &&
          Boolean(attendanceRow) &&
          (sourceAttendance ? attendanceRow!.value !== '—' : attendanceRow!.value === '—'),
        JSON.stringify({ expected: sourceAttendance, row: attendanceRow ?? null }),
      );
      check(
        'a days-present value is never relabelled as a percentage',
        !(Number(sourceAttendance) > 100 && /%$/.test(attendanceRow?.value ?? '')),
        attendanceRow?.value,
      );
    } else {
      /* Sample a few students from every other workbook in both themes. */
      const sample = students.slice(0, 3);
      for (const student of sample) {
        for (const theme of REPORT_CARD_THEMES) {
          await renderAndCheck(student, `${file} #${student.rollNo}`, theme.id, {
            name: student.name,
            roll: student.rollNo,
            subjects: student.subjects.map((s) => s.name),
            marks: student.subjects
              .filter((s) => s.status === 'present' && s.marks !== null)
              .map((s) => s.marks as number),
          });
        }
      }
    }
  }
}

/* ──────────────── 6. synthetic layout / data extremes ───────────────── */

async function testSyntheticLayout(): Promise<void> {
  console.log('\n## synthetic layout stress');

  const maxima = [25, 40, 50, 80, 100];
  const many = makeStudent({
    studentId: 'row-99',
    rollNo: '99',
    name: 'A Very Long Student Name That Keeps Going On And On',
    class: '10',
    section: 'B',
    fatherName: 'MR. CHARANJEET SINGH SANDHU S/O LATE SARDAR KARTAR SINGH JI',
    motherName: 'MRS. HARJINDER KAUR SANDHU W/O SARDAR CHARANJEET SINGH SANDHU',
    admissionNo: 'ADM/2019/1043/VERY/LONG',
    dob: '2013-04-12',
    address: 'House No. 1043/7, Guru Nanak Nagar, Near Old Bus Stand, Yamuna Nagar',
    attendance: '96%',
    subjects: Array.from({ length: 30 }, (_, index) => {
      const maxMarks = maxima[index % maxima.length];
      return {
        name:
          index % 3 === 0
            ? `ENVIRONMENTAL EDUCATION AND DISASTER MANAGEMENT PART ${index + 1}`
            : `SUBJECT ${index + 1}`,
        marks: Math.round(maxMarks * 0.82),
        maxMarks,
        status: 'present' as const,
        hasComponents: false,
      };
    }),
    teacherRemarks:
      'The student has worked steadily through the term and shows a good understanding of most concepts. '.repeat(
        4,
      ),
    principalRemarks: 'Regular revision and consistent effort will improve the result further. '.repeat(3),
  });

  for (const theme of REPORT_CARD_THEMES) {
    await renderAndCheck(many, '30 subjects', theme.id, {
      name: many.name,
      roll: many.rollNo,
      subjects: many.subjects.map((subject) => subject.name),
      marks: many.subjects.map((subject) => subject.marks as number),
      onePage: false,
    });
  }

  /* A student with no marks at all must still produce a valid (blank) card. */
  const empty = makeStudent({ studentId: 'row-100', rollNo: '100', name: 'No Marks Student', subjects: [] });
  const emptyModel = buildReportCardModel(empty, SCHOOL);
  check('student without marks verifies', verifyReportCardModel(empty, emptyModel).ok);
  check('student without marks shows a placeholder percentage', emptyModel.totals.percentage === null);
  await renderAndCheck(empty, 'no marks', 'holistic', {
    name: empty.name,
    roll: empty.rollNo,
    subjects: [],
    marks: [],
  });
}

/* ──────────── 6b. layout density (blank band regression) ─────────────── */

/**
 * The complaint that started this section: the PDF kept a large blank area
 * between the Personality/Learning skills tables and the remarks while the
 * browser preview was compact. These cards cover the shapes that change the
 * body height (subject count, name/remark length, performance band).
 */
async function testLayoutDensity(): Promise<void> {
  console.log('\n## layout density');

  const subject = (name: string, marks: number, maxMarks = 100) => ({
    name,
    marks,
    maxMarks,
    status: 'present' as const,
    hasComponents: false,
  });
  const six = (marks: number[]) =>
    ['English', 'Hindi', 'Maths', 'Science', 'Social Science', 'Computer'].map((name, index) =>
      subject(name, marks[index]),
    );

  const cases: { label: string; student: Student }[] = [
    {
      label: 'high performer',
      student: makeStudent({ studentId: 'row-201', rollNo: '201', name: 'Aarav Mehta', subjects: six([96, 92, 98, 95, 94, 99]) }),
    },
    {
      label: 'low performer',
      student: makeStudent({ studentId: 'row-202', rollNo: '202', name: 'Bhavya Rani', subjects: six([24, 19, 12, 21, 27, 31]) }),
    },
    {
      label: 'long names',
      student: makeStudent({
        studentId: 'row-203',
        rollNo: '203',
        name: 'Gurpreet Kaur Sandhu Dhillon Brar',
        fatherName: 'MR. CHARANJEET SINGH SANDHU S/O LATE SARDAR KARTAR SINGH JI',
        motherName: 'MRS. HARJINDER KAUR SANDHU W/O SARDAR CHARANJEET SINGH SANDHU',
        admissionNo: 'ADM/2019/1043/VERY/LONG',
        address: 'House No. 1043/7, Guru Nanak Nagar, Near Old Bus Stand, Yamuna Nagar',
        subjects: six([76, 68, 81, 74, 66, 88]),
      }),
    },
    {
      label: 'long remarks',
      student: makeStudent({
        studentId: 'row-204',
        rollNo: '204',
        name: 'Meera Joshi',
        subjects: six([70, 64, 58, 77, 69, 83]),
        teacherRemarks:
          'The student has worked steadily through the term and shows a good understanding of most concepts. '.repeat(4),
        principalRemarks:
          'Regular revision and consistent effort will improve the result further. '.repeat(3),
      }),
    },
    {
      label: 'two subjects',
      student: makeStudent({
        studentId: 'row-205',
        rollNo: '205',
        name: 'Kabir Singh',
        subjects: [subject('English', 63), subject('Mathematics', 47)],
      }),
    },
  ];

  for (const { label, student } of cases) {
    for (const theme of REPORT_CARD_THEMES) {
      await renderAndCheck(student, label, theme.id, {
        name: student.name,
        roll: student.rollNo,
        subjects: student.subjects.map((item) => item.name),
        marks: student.subjects.map((item) => item.marks as number),
      });
    }
  }
}

/* ────────────── 6c. theme identity (the looks must differ) ───────────── */

async function renderRuns(student: Student, themeId: string): Promise<TextRun[]> {
  const school: SchoolProfile = { ...SCHOOL, reportTheme: themeId };
  const blob = await generateStudentPdfBlob({ student, school });
  return extractTextRuns(Buffer.from(await blob.arrayBuffer()).toString('latin1'));
}

/**
 * Share of text positions used by both cards, measured RELATIVE to each card's
 * topmost line so a plain vertical shift (a taller header) does not count as a
 * different layout.
 */
function geometryOverlap(a: TextRun[], b: TextRun[]): number {
  const keysOf = (runs: TextRun[]) => {
    const top = runs.reduce((max, run) => Math.max(max, run.y), 0);
    return new Set(runs.map((run) => `${Math.round(run.x / 5)}:${Math.round((top - run.y) / 5)}`));
  };
  const left = keysOf(a);
  const right = keysOf(b);
  let shared = 0;
  left.forEach((key) => {
    if (right.has(key)) shared += 1;
  });
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 1 : shared / union;
}

/**
 * "Simple Academic" and "Modern School" are two different products, not a
 * palette swap: the modern card re-skins the header, the student info, the
 * table and the result summary. These checks fail if the two ever collapse into
 * the same look again.
 */
async function testThemeIdentity(): Promise<void> {
  console.log('\n## theme identity');

  const classic = REPORT_CARD_THEMES.find((theme) => theme.id === 'academic')!;
  const modern = REPORT_CARD_THEMES.find((theme) => theme.id === 'modern')!;
  check(
    'the two marks-focused themes use different visuals',
    (classic.variant ?? 'classic') !== (modern.variant ?? 'classic'),
    `${classic.variant ?? 'classic'} vs ${modern.variant ?? 'classic'}`,
  );
  check(
    'both keep the same layout family (shared fitting engine)',
    classic.layout === 'academic' && modern.layout === 'academic',
  );

  const student = makeStudent({
    studentId: 'row-301',
    rollNo: '301',
    name: 'Identity Check',
    subjects: ['English', 'Hindi', 'Maths', 'Science', 'Social Science', 'Computer'].map((name, index) => ({
      name,
      marks: [88, 74, 91, 66, 79, 83][index],
      maxMarks: 100,
      status: 'present' as const,
      hasComponents: false,
    })),
  });

  const classicRuns = await renderRuns(student, classic.id);
  const modernRuns = await renderRuns(student, modern.id);
  const classicText = classicRuns.map((run) => run.text).join(' ').toUpperCase();
  const modernText = modernRuns.map((run) => run.text).join(' ').toUpperCase();

  check('classic card prints the grading-scale line', classicText.includes('GRADING SCALE'));
  check(
    'modern card replaces it with the wide result band',
    !modernText.includes('GRADING SCALE') && modernText.includes('OVERALL PERFORMANCE'),
  );
  check('classic card keeps its own title', classicText.includes(classic.title.toUpperCase()));
  check('modern card keeps its own title', modernText.includes(modern.title.toUpperCase()));

  /* Both must still print the same data — different look, same content. */
  for (const name of ['ENGLISH', 'HINDI', 'MATHS', 'SCIENCE', 'SOCIAL SCIENCE', 'COMPUTER']) {
    check(`modern card prints ${name}`, modernText.includes(name));
  }
  check('modern card prints the grand total', modernText.includes('GRAND TOTAL'));

  /*
   * Measured ~11%; a palette-only swap would score ~100% because the two cards
   * would place every line in the same spot.
   */
  const overlap = geometryOverlap(classicRuns, modernRuns);
  check(
    'the two looks place their text differently',
    overlap <= 0.5,
    `${(overlap * 100).toFixed(0)}% of text positions shared`,
  );
}

/* ────────────── 6d. preview ↔ PDF typography parity ────────────── */

/**
 * The preview and the PDF must render the same text at the same physical size.
 *
 * Both now read `themes/typography.ts` (sizes in mm): the preview sets
 * `font-size: <x>mm` in CSS and the PDF calls `setFontSize(mmToPt(x))`. These
 * checks read BOTH real outputs — the rendered preview markup and the font size
 * embedded in the generated PDF — so a size change on one side alone fails.
 */
async function testTypographyParity(): Promise<void> {
  console.log('\n## typography parity (preview vs PDF)');

  const student = makeStudent({
    studentId: 'row-401',
    rollNo: '401',
    name: 'Parity Check',
    fatherName: 'Parity Father',
    admissionNo: 'ADM/2024/401',
    subjects: ['English', 'Hindi', 'Maths', 'Science', 'Social Science', 'Computer'].map(
      (name, index) => ({
        name,
        marks: [88, 74, 91, 66, 79, 83][index],
        maxMarks: 100,
        status: 'present' as const,
        hasComponents: false,
      }),
    ),
  });

  /* The shared scale must actually be bigger than the old hardcoded sizes. */
  check(
    'academic text is larger than the old 7.6pt PDF size',
    mmToPt(TYPE_MM.academic) > 7.6,
    `${mmToPt(TYPE_MM.academic).toFixed(2)}pt`,
  );
  /*
   * Every shared size must be at least as large as the value it replaced, and
   * the body text the user complained about must be strictly larger. The map is
   * the PDF point size each element used before the shared mm scale existed.
   */
  const replacedPt: Record<keyof typeof TYPE_MM, number> = {
    academic: 7.6,
    sectionBar: 8,
    coScholastic: 7.4,
    holisticValue: 7.2,
    skills: 7.2,
    info: 8.5,
    title: 11,
    summaryLabel: 6.8,
    summaryValue: 15,
    overallValue: 12.5,
    overallLabel: 7.2,
    gradingScale: 6.5,
    remarks: 7.4,
    remarksLabel: 8,
    signatureName: 8.5,
    footer: 6.5,
  };
  const shrunk = (Object.keys(replacedPt) as (keyof typeof TYPE_MM)[]).filter(
    (key) => mmToPt(TYPE_MM[key]) < replacedPt[key] - 0.01,
  );
  check('no shared size is smaller than the value it replaced', shrunk.length === 0, shrunk.join(', '));

  const mustGrow: (keyof typeof TYPE_MM)[] = [
    'academic',
    'coScholastic',
    'holisticValue',
    'skills',
    'info',
    'gradingScale',
    'remarks',
    'footer',
    'sectionBar',
    'summaryLabel',
    'overallValue',
  ];
  const notGrown = mustGrow.filter((key) => mmToPt(TYPE_MM[key]) <= replacedPt[key] + 0.01);
  check('the body text sizes were actually increased', notGrown.length === 0, notGrown.join(', '));
  check(
    'academic rows are at least 13% larger than before',
    mmToPt(TYPE_MM.academic) >= replacedPt.academic * 1.13,
    `${((mmToPt(TYPE_MM.academic) / replacedPt.academic - 1) * 100).toFixed(1)}%`,
  );

  for (const theme of REPORT_CARD_THEMES) {
    const runs = await renderRuns(student, theme.id);
    const subjectRun = runs.find((run) => /^English$/i.test(run.text.trim()));
    const infoRun = runs.find((run) => /Date of Birth/i.test(run.text));

    check(`[${theme.id}] the academic subject cell prints`, Boolean(subjectRun));
    check(
      `[${theme.id}] academic cell uses the shared mm size (PDF)`,
      Boolean(subjectRun) && Math.abs((subjectRun as TextRun).size - mmToPt(TYPE_MM.academic)) <= 0.06,
      subjectRun ? `${subjectRun.size}pt vs ${mmToPt(TYPE_MM.academic).toFixed(2)}pt` : 'no run',
    );
    check(`[${theme.id}] the student info grid prints`, Boolean(infoRun));
    check(
      `[${theme.id}] info grid uses the shared mm size (PDF)`,
      Boolean(infoRun) && Math.abs((infoRun as TextRun).size - mmToPt(TYPE_MM.info)) <= 0.06,
      infoRun ? `${infoRun.size}pt vs ${mmToPt(TYPE_MM.info).toFixed(2)}pt` : 'no run',
    );

  }
  /*
   * The preview half of this parity check runs in `npm run test:preview`, which
   * bundles the real .tsx components with esbuild and asserts the rendered
   * markup carries the same mm sizes (jiti cannot load .tsx modules).
   */

  /*
   * Body text may no longer carry a px font size — it must come from the shared
   * mm scale. Only the card header (school name, address, session chip, photo
   * placeholder) is allowed to keep its own px sizes, so these counts act as a
   * ceiling: adding a px size back into a table or panel trips the check.
   */
  const headerPxBudget: Record<string, number> = {
    HolisticReportPreview: 8,
    AcademicReportPreview: 12,
  };
  for (const [name, budget] of Object.entries(headerPxBudget)) {
    const source = readFileSync(resolve(process.cwd(), 'src/components/report/' + name + '.tsx'), 'utf8');
    const pxSizes = source.match(/text-\[[0-9.]+px\]/g) ?? [];
    check(
      `${name}: body text has no hardcoded px size`,
      pxSizes.length <= budget,
      `${pxSizes.length} px sizes (budget ${budget}): ${pxSizes.join(', ')}`,
    );
  }
}

/* ────────────── 6e. Studio Joy (bilingual + typo tolerant) ────────────── */

function testStudioJoy(): void {
  console.log('\n## studio joy (English + Hinglish)');

  /* Both languages must exist for every screen guide and every step. */
  const untranslated: string[] = [];
  for (const [screen, guide] of Object.entries(SCREEN_GUIDES)) {
    if (!guide.intro?.en || !guide.intro?.hi) untranslated.push(`${screen}.intro`);
    guide.steps.forEach((step, index) => {
      if (!step.title?.en || !step.title?.hi) untranslated.push(`${screen}.steps[${index}].title`);
      if (!step.detail?.en || !step.detail?.hi) untranslated.push(`${screen}.steps[${index}].detail`);
    });
    guide.chips.forEach((chip, index) => {
      if (!chip.en || !chip.hi) untranslated.push(`${screen}.chips[${index}]`);
    });
  }
  check('every screen guide exists in English and Hinglish', untranslated.length === 0, untranslated.join(', '));

  /* Language policy: English is the default. */
  check('plain English stays English', detectJoyLanguage('how do i import an excel file') === 'en');
  check('Hinglish is detected', detectJoyLanguage('excel kaise import karu') === 'hi');
  check('Hinglish with a typo is still Hinglish', detectJoyLanguage('excle kaise import karu') === 'hi');

  /* Language policy: the answer comes back in the language the question used. */
  check('English input maps to English replies', studioReplyLanguage('where is my excel') === 'en');
  check('Hinglish input maps to Hinglish replies', studioReplyLanguage('excel kaha hai') === 'hinglish');
  check('Devanagari input maps to Hindi replies', studioReplyLanguage('यह error क्यों है') === 'hi');
  const en = resolveStudioQuery('walk me through this screen', 'import', 'en');
  const hi = resolveStudioQuery('ye screen kaise chalau', 'import', 'hi');
  check('an English question is answered', en !== null);
  check('a Hinglish question is answered', hi !== null);
  check(
    'the two answers differ by language',
    Boolean(en?.reply) && Boolean(hi?.reply) && en!.reply !== hi!.reply,
  );
  check(
    'a walkthrough answer carries its steps',
    Boolean(en?.guide && en.guide.steps.length > 0),
    en?.guide ? `${en.guide.steps.length} steps` : 'no guide',
  );

  /* Typos still reach the answer instead of the fallback. */
  const typoGuide = resolveStudioQuery('excle import kaise karu', 'import', 'hi');
  check('a typo still resolves instead of falling back', typoGuide !== null);
  const typoFaq = resolveStudioQuery('how many free treis do i get', 'dashboard', 'en');
  check('a typo in a FAQ keyword still resolves', typoFaq !== null);
  check('editDistance treats a transposition as one edit', editDistance('tries', 'treis') === 1);
  check('editDistance is zero for equal words', editDistance('excel', 'excel') === 0);

  /* Off-topic still gets the scoped, polite redirect — in both languages. */
  check('off-topic questions resolve to nothing', resolveStudioQuery('what is the weather today', 'dashboard', 'en') === null);
  const fallbackEn = studioFallback('dashboard', 'en');
  const fallbackHi = studioFallback('dashboard', 'hi');
  /*
   * Joy is Ishmaverse's assistant, so the fallback names every section she can
   * really answer about (ReportCard Studio included) and refuses to guess — it
   * is no longer a Studio-only line.
   */
  for (const section of MALL_KNOWLEDGE) {
    check(`the English fallback names “${section.name}”`, fallbackEn.includes(section.name));
  }
  check(
    'the English fallback offers ReportCard Studio help too',
    /ReportCard Studio/i.test(fallbackEn),
  );
  check('the Hinglish fallback names the sections as well', /ReportCard Studio/.test(fallbackHi) && /Game Zone/.test(fallbackHi));
  check(
    'the fallback admits it does not know instead of guessing',
    /won’t guess|won't guess/i.test(fallbackEn) && /guess nahi karungi/i.test(fallbackHi),
    fallbackEn.slice(0, 90),
  );

  const welcomeEn = studioWelcome('en');
  const welcomeHi = studioWelcome('hi');
  check('the welcome message exists in both languages', welcomeEn !== welcomeHi && welcomeEn.length > 0 && welcomeHi.length > 0);

  /*
   * Greeting-card requests are a mall navigation action. Joy must hand the
   * parent Ishmaverse window the real Digital Greetings route — never answer
   * with ReportCard Studio subscription / free-generation limits.
   */
  const navigationCases: { text: string; lang: 'en' | 'hi' }[] = [
    { text: 'joy free greeting card pe leke jana', lang: 'hi' },
    { text: 'Mujhe greeting card banana hai', lang: 'hi' },
    { text: 'Open Digital Greetings', lang: 'en' },
    { text: 'Take me to free greeting cards', lang: 'en' },
    { text: 'Greeting card section kholo', lang: 'hi' },
  ];
  for (const { text, lang } of navigationCases) {
    const answer = resolveStudioQuery(text, 'dashboard', lang);
    check(`\"${text}\" navigates to Digital Greetings`, answer?.navigate === GREETING_ROUTE, String(answer?.navigate));
    check(
      `\"${text}\" does not answer with report-card limits`,
      Boolean(answer) && !/report-card generations|7 free|subscribe for unlimited/i.test(answer!.reply),
      answer?.reply.slice(0, 60),
    );
  }

  /*
   * Report-card questions must keep their own answers: free tries, plans and
   * billing are still answered — and never hijacked by the greeting words.
   */
  const freeTries = resolveStudioQuery('how many free tries do i get', 'dashboard', 'en');
  check(
    'a report-card free-tries question still gets the Studio answer',
    Boolean(freeTries?.navigate) === false && /report-card generations/i.test(freeTries?.reply ?? ''),
    freeTries?.reply.slice(0, 60),
  );
  const plans = resolveStudioQuery('what are the report card plans', 'pricing', 'en');
  check(
    'a report-card plan question still gets the Studio answer',
    Boolean(plans?.navigate) === false && Boolean(plans),
    plans?.reply.slice(0, 60),
  );
  check(
    'a greeting request inside ReportCard Studio is detected',
    resolveStudioQuery('free greeting card', 'import', 'en')?.navigate === GREETING_ROUTE,
  );

  /*
   * Joy is Ishmaverse's assistant, not a Studio-only bot: from inside the Studio
   * she answers about EVERY other section (live or coming soon) and hands the
   * parent window that section's real route.
   */
  const sectionPhrases: Record<string, string> = {
    greetings: 'greeting card',
    'game-zone': 'pair 3 balls',
    'tech-ai': 'tech and ai',
    education: 'education section',
    originals: 'originals section',
    'ui-themes': 'ui themes',
    'fx-studios': 'fx studios',
    comics: 'comics section',
  };
  for (const [id, phrase] of Object.entries(sectionPhrases)) {
    const section = MALL_KNOWLEDGE.find((entry) => entry.id === id);
    if (!section) {
      check(`the Studio knows “${id}”`, false, 'missing from MALL_KNOWLEDGE');
      continue;
    }
    const answer = resolveStudioQuery(phrase, 'dashboard', 'en');
    check(
      `the Studio answers about “${section.name}”`,
      Boolean(answer) && answer!.reply.includes(section.name),
      answer?.reply.slice(0, 70),
    );
    check(
      `the Studio points at “${section.name}”`,
      answer?.navigate === `/section/${id}`,
      String(answer?.navigate),
    );
    const hindi = resolveStudioQuery(phrase, 'dashboard', 'hi');
    check(
      `the Studio answers about “${section.name}” in Hinglish too`,
      Boolean(hindi) && hindi!.reply !== answer?.reply,
    );
  }

  /* Coming-soon sections are described honestly, never sold. */
  const comingSoon = MALL_KNOWLEDGE.filter((section) => !section.available);
  check(
    'every coming-soon section is described as coming soon',
    comingSoon.every((section) => {
      const answer = resolveMallSectionAnswer(section.keywords[0], 'en');
      return Boolean(answer) && /coming soon|not live yet/i.test(answer!.reply);
    }),
    comingSoon.map((section) => section.name).join(', '),
  );

  /* A problem inside another section is explained with its cause and its fix. */
  const crossProblems: { text: string; expect: RegExp }[] = [
    { text: 'game zone me online modes unavailable kyu hai', expect: /backend|offline/i },
    { text: 'pair 3 balls room code not working', expect: /6 characters|Private Room/i },
    { text: 'greeting card link not opening after 48 hours', expect: /48 ghante|48 hours/i },
    { text: 'greeting card payment failed but money deducted', expect: /idempotent|refund/i },
  ];
  for (const { text, expect } of crossProblems) {
    const answer = resolveMallSectionAnswer(text, 'hi');
    check(
      `the Studio explains “${text}”`,
      Boolean(answer) && expect.test(answer!.reply),
      (answer?.reply ?? 'no answer').slice(0, 80),
    );
  }

  /* "What sections are there?" lists the whole mall, live and coming soon. */
  const list = resolveStudioQuery('ishmaverse me kya kya hai', 'dashboard', 'hi');
  check(
    'a “what is in Ishmaverse” question lists every section',
    Boolean(list) && MALL_KNOWLEDGE.every((section) => list!.reply.includes(section.name)),
    list?.reply.slice(0, 80),
  );

  /* …while a Studio question is never hijacked by the section bank. */
  check(
    'a Studio question is not answered as another section',
    resolveStudioQuery('how many free report-card generations do i get', 'dashboard', 'en')?.navigate === undefined,
  );
}

/* ──────────── 6f. grouped subject-component workbooks (reported bug) ─────── */

/**
 * Runs the exact pipeline the Import screen uses: the dynamic structure engine
 * when it recognises a name + subjects, otherwise the index-based mapping
 * fallback (which is what a sheet without a plain "Name" column gets).
 */
async function buildStudentsFromFile(f: File): Promise<{
  students: Student[];
  headers: string[];
  usedFallback: boolean;
}> {
  const workbook = await parseWorkbookFromFile(f);

  try {
    const detected = await parseDynamicStructure(f);
    const hasName = detected.studentFields.some((field) => field.fieldType === 'name');
    const hasSubjects = detected.subjectGroups.length > 0;

    if (hasName && hasSubjects) {
      const mappings = convertDetectedStructureToColumnMapping(detected, workbook.headers);
      const structureMapping = createStructureMappingFromDetected(detected);
      const students = buildStudentsFromDynamicStructure(
        workbook.rows,
        structureMapping.detected,
        structureMapping,
        {
          defaultClass: '',
          defaultSection: '',
          inferredClass: detected.inferredClass,
          inferredSection: detected.inferredSection,
        },
        workbook.headers,
        mappings,
      );
      return { students, headers: workbook.headers, usedFallback: false };
    }
  } catch {
    /* fall through to the fallback path */
  }

  const students = buildStudentsFromRows(workbook.rows, autoMapColumns(workbook.headers), {
    defaultClass: '',
    defaultSection: '',
  });
  return { students, headers: workbook.headers, usedFallback: true };
}

async function buildStudentsLikeApp(file: string): Promise<{
  students: Student[];
  headers: string[];
  usedFallback: boolean;
}> {
  return buildStudentsFromFile(fileFromPath(resolve(process.cwd(), file)));
}

/** Raw worksheet values, read independently of the app's parser. */
function readRawGrid(file: string): unknown[][] {
  const wb = XLSX.readFile(resolve(process.cwd(), file));
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    blankrows: false,
    defval: '',
    raw: true,
  });
}

/**
 * The reported "S.B.S PUBLIC SCHOOL (CLASS-3rd)" mark sheet: a grouped multi-row
 * header with PT / NB / SEA / SA1 / TOTAL per subject, and standalone
 * MV / GK / DRAW / TOTAL / % / POSITION columns after the subjects.
 *
 * These checks guard three things the report complained about:
 *   1. a subject name ("MATHS") is never split into two columns ("MATH" + "S");
 *   2. every component stays attached to ITS subject — none is dropped or moved;
 *   3. the subject-level TOTAL stays inside the subject while the standalone
 *      TOTAL / % / POSITION stay separate as the overall fields.
 */
async function testGroupedComponentWorkbooks(): Promise<void> {
  console.log('\n## grouped subject-component workbook (reported structure)');

  const files = [
    'testdata_sbs_components.xlsx',
    'testdata_sbs_components_no_name.xlsx',
    'testdata_unmerged_groups.xlsx',
    /* Same grouped structure, but the term component is SA2 (as reported). */
    'testdata_sbs_components_sa2.xlsx',
  ];

  for (const file of files) {
    const grid = readRawGrid(file);
    const componentRowIndex = grid.findIndex(
      (row) =>
        row.includes('PT' as never) &&
        (row.includes('SA1' as never) || row.includes('SA2' as never)),
    );
    check(`${file}: component header row found`, componentRowIndex >= 0, `${componentRowIndex}`);
    if (componentRowIndex < 0) continue;

    const componentRow = grid[componentRowIndex];
    const firstSubjectCol = componentRow.indexOf('PT' as never);
    const subjectColumns = componentRow.filter((cell) => String(cell ?? '').trim() !== '');
    /* The five component headers the sheet repeats for every subject. */
    const componentNames = subjectColumns.slice(0, 5).map((cell) => String(cell).trim());
    const expectedComponents = componentNames.join(',');
    const subjectCount = subjectColumns.length / 5;
    check(
      `${file}: five components per subject ${expectedComponents}`,
      componentNames[0] === 'PT' && componentNames[componentNames.length - 1] === 'TOTAL',
      expectedComponents,
    );
    const subjectLabels = Array.from({ length: subjectCount }, (_, index) =>
      String(grid[componentRowIndex - 1][firstSubjectCol + index * 5] ?? '').trim(),
    );
    const dataStart = grid.findIndex((row) => String(row[0] ?? '').toUpperCase().startsWith('MR.'));
    const dataRows = grid.slice(dataStart);
    const standaloneStart = firstSubjectCol + subjectCount * 5;
    const standaloneLabels = grid[componentRowIndex - 1]
      .slice(standaloneStart)
      .map((cell) => String(cell ?? '').trim());

    check(
      `${file}: sheet carries the expected 6 subjects x 5 components`,
      subjectCount === 6 && subjectLabels.join(',') === 'English,Hindi,Maths,SCI.,Sst,COMPUTER',
      subjectLabels.join(','),
    );
    check(
      `${file}: standalone columns are TOTAL / % / POSITION`,
      standaloneLabels.join(',') === 'MV,GK,DRAW,TOTAL,%,POSITION',
      standaloneLabels.join(','),
    );

    const { students, headers, usedFallback } = await buildStudentsLikeApp(file);
    check(`${file}: every student row is imported`, students.length === dataRows.length,
      `${students.length} of ${dataRows.length}`);

    /* Grouped headers must be exposed as "Subject | Component", never split. */
    const groupedHeaders = headers.filter((header) => header.includes('|'));
    check(`${file}: headers keep the subject + component together`, groupedHeaders.length >= 30,
      `${groupedHeaders.length} grouped headers`);
    check(
      `${file}: no column header is a split subject fragment`,
      !headers.some((header) => /^(MATH|S|SCI)$/i.test(header.trim())),
      headers.filter((header) => /^(MATH|S|SCI)$/i.test(header.trim())).join(', '),
    );

    const student = students[0];
    const rawFirst = dataRows[0];
    check(`${file}: subject names are kept intact and in order`,
      student.subjects.map((s) => s.name).join(',') === subjectLabels.join(','),
      student.subjects.map((s) => s.name).join(','));
    check(
      `${file}: no subject is duplicated and no component became a subject`,
      new Set(student.subjects.map((s) => s.name)).size === student.subjects.length &&
        !student.subjects.some((s) => /^(pt|nb|sea|sa1|total)$/i.test(s.name)),
      student.subjects.map((s) => s.name).join(','),
    );

    /* Every component must sit under its own subject with its own marks. */
    let componentMismatch = '';
    students.forEach((entry, studentIndex) => {
      const rawRow = dataRows[studentIndex];
      entry.subjects.forEach((subject, subjectIndex) => {
        const expected = rawRow
          .slice(firstSubjectCol + subjectIndex * 5, firstSubjectCol + subjectIndex * 5 + 5)
          .map((value) => String(value ?? '').trim());
        const actual = (subject.components ?? []).map((component) => (
          component.status === 'present' ? String(component.marks ?? '') : component.status.toUpperCase()
        ));
        if (actual.join(',') !== expected.join(',')) {
          componentMismatch = `${entry.rollNo}/${subject.name}: [${actual.join(',')}] vs [${expected.join(',')}]`;
        }
        if (subject.components?.map((component) => component.name).join(',') !== expectedComponents) {
          componentMismatch = `${entry.rollNo}/${subject.name}: components ${subject.components?.map((c) => c.name).join(',')}`;
        }
        if (subject.marks !== Number(expected[4])) {
          componentMismatch = `${entry.rollNo}/${subject.name}: subject total ${subject.marks} vs ${expected[4]}`;
        }
      });
    });
    check(`${file}: each component keeps its own subject and marks`, componentMismatch === '', componentMismatch);

    /* Standalone overall fields stay separate from the subject totals. */
    const [mv, gk, draw, overallTotal, overallPct, position] = rawFirst.slice(standaloneStart);
    check(`${file}: standalone TOTAL becomes the overall total`,
      Number(student.overall?.total) === Number(overallTotal),
      `${student.overall?.total} vs ${overallTotal}`);
    check(`${file}: standalone % becomes the overall percentage`,
      Number(student.overall?.percentage) === Number(overallPct),
      `${student.overall?.percentage} vs ${overallPct}`);
    check(`${file}: standalone POSITION becomes the overall position`,
      String(student.overall?.position ?? '') === String(position),
      `${student.overall?.position} vs ${position}`);
    check(
      `${file}: MV / GK / DRAW stay co-scholastic grade fields`,
      (student.gradeFields ?? []).map((field) => `${field.name}=${field.value}`).join(',') ===
        `MV=${mv},GK=${gk},DRAW=${draw}`,
      (student.gradeFields ?? []).map((field) => `${field.name}=${field.value}`).join(','),
    );

    /*
     * The preview table must mirror the sheet's own columns — and every header
     * must say what that column is out of. The expected hint is built from the
     * workbook's own max-marks row (the row under the component header): the
     * value when all subjects agree, the range when they do not.
     */
    const model = buildReportCardModel(student, SCHOOL);
    const maxRow = grid[componentRowIndex + 1] ?? [];
    /* A max-marks row sits between the component header and the student rows. */
    const hasMaxRow = componentRowIndex + 1 < dataStart;
    const maxAt = (subjectIndex: number, columnIndex: number) =>
      Number(String(maxRow[firstSubjectCol + subjectIndex * 5 + columnIndex] ?? '').trim());
    const lastComponentIndex = componentNames.length - 1;
    /*
     * A component hint is only correct when the component maxima add up to the
     * subject's own maximum. Sheets that repeat ONE maximum on every component
     * (PT 100 / NB 100 out of 100) must not advertise "PT (100)".
     */
    const componentsPartition =
      hasMaxRow &&
      Array.from({ length: subjectCount }, (_, subjectIndex) => {
        const parts = Array.from({ length: lastComponentIndex }, (_, columnIndex) =>
          maxAt(subjectIndex, columnIndex),
        ).filter((value) => Number.isFinite(value) && value > 0);
        const sum = parts.reduce((total, value) => total + value, 0);
        return parts.length > 0 && Math.abs(sum - maxAt(subjectIndex, lastComponentIndex)) <= 0.001;
      }).every(Boolean);

    /* The Total column states the subject maximum the parser itself resolved. */
    const subjectMaxima = student.subjects
      .map((subject) => Number(subject.maxMarks))
      .filter((value) => Number.isFinite(value) && value > 0);
    const minimaOf = (values: number[]) => Math.min(...values);
    const maximaOf = (values: number[]) => Math.max(...values);

    const expectedLabels = componentNames
      .map((name, columnIndex) => {
        if (columnIndex === lastComponentIndex) {
          if (subjectMaxima.length === 0) return name;
          const low = minimaOf(subjectMaxima);
          const high = maximaOf(subjectMaxima);
          return low === high ? `${name} (${low})` : `${name} (${low}–${high})`;
        }
        if (!componentsPartition) return name;
        const values = Array.from({ length: subjectCount }, (_, subjectIndex) =>
          maxAt(subjectIndex, columnIndex),
        ).filter((value) => Number.isFinite(value) && value > 0);
        if (values.length === 0) return name;
        const low = minimaOf(values);
        const high = maximaOf(values);
        return low === high ? `${name} (${low})` : `${name} (${low}–${high})`;
      })
      .join(',');
    check(
      `${file}: preview columns are the workbook components + TOTAL, each out of its maximum`,
      model.academicColumns.map((column) => column.label).join(',') === expectedLabels,
      model.academicColumns.map((column) => column.label).join(','),
    );
    /*
     * The hint must be present exactly when it is truthful: every component
     * column carries one when the workbook partitions the subject, and the
     * Total column always states the subject maximum.
     */
    check(
      `${file}: component columns carry a maximum hint only when the workbook partitions the subject`,
      model.academicColumns.every((column, index) => {
        const hasHint = /\(\d/.test(column.label);
        if (index === model.academicColumns.length - 1) return hasHint;
        return hasHint === componentsPartition;
      }),
      model.academicColumns.map((column) => column.label).join(','),
    );

    const academicRows = model.academic.slice(0, -1);
    const grandTotalRow = model.academic[model.academic.length - 1];
    let previewMismatch = '';
    academicRows.forEach((row, subjectIndex) => {
      const expected = rawFirst
        .slice(firstSubjectCol + subjectIndex * 5, firstSubjectCol + subjectIndex * 5 + 5)
        .map((value) => String(value ?? '').trim());
      if (row.name !== subjectLabels[subjectIndex]) {
        previewMismatch = `row ${subjectIndex}: ${row.name} vs ${subjectLabels[subjectIndex]}`;
      }
      /* Component cells are the sheet's own marks, in the sheet's own order. */
      const expectedParts = expected.slice(0, -1);
      const actualParts = row.cells.slice(0, -1);
      if (actualParts.join(',') !== expectedParts.join(',')) {
        previewMismatch = `${row.name}: [${actualParts.join(',')}] vs [${expectedParts.join(',')}]`;
      }
      /*
       * The subject's Total cell states what it is out of — "88 / 100" — so a
       * reader never has to guess which line is marked out of how much. A
       * non-numeric sheet value (AB / EX / blank) passes through unchanged.
       */
      const expectedTotal = /^\d/.test(expected[expected.length - 1])
        ? `${expected[expected.length - 1]} / ${row.maxMarks}`
        : expected[expected.length - 1];
      const totalCell = String(row.cells[row.cells.length - 1] ?? '');
      if (totalCell !== expectedTotal) {
        previewMismatch = `${row.name}: total "${totalCell}" vs "${expectedTotal}"`;
      }
    });
    check(`${file}: preview values align with the Excel columns`, previewMismatch === '', previewMismatch);
    check(
      `${file}: every subject line states its total out of its maximum`,
      academicRows.every((row) => /^\d+(\.\d+)?\s*\/\s*\d+(\.\d+)?$/.test(String(row.cells[row.cells.length - 1] ?? ''))),
      academicRows.map((row) => String(row.cells[row.cells.length - 1])).join(','),
    );
    check(`${file}: preview prints every subject name intact`,
      academicRows.map((row) => row.name).join(',') === subjectLabels.join(','),
      academicRows.map((row) => row.name).join(','));
    check(`${file}: grand total is the standalone overall TOTAL with its maximum`,
      grandTotalRow.name === 'GRAND TOTAL' &&
        grandTotalRow.cells[grandTotalRow.cells.length - 1] ===
          `${overallTotal} / ${model.totals.max}`,
      grandTotalRow.cells.join(','));

    /*
     * Each component column of the GRAND TOTAL row must be the REAL sum of that
     * column over the subject rows (with its own maximum), never an unexplained
     * dash when the workbook supplies the component, and never an invented
     * number when it does not.
     */
    let componentTotalMismatch = '';
    grandTotalRow.cells.slice(0, -1).forEach((cell, columnIndex) => {
      let sum = 0;
      let contributors = 0;
      for (const row of academicRows) {
        const value = String(row.cells[columnIndex] ?? '').trim();
        if (!/^\d+(?:\.\d+)?$/.test(value)) continue;
        sum += Number(value);
        contributors += 1;
      }
      const ok =
        contributors === 0
          ? cell === '—' || cell === ''
          : cell === String(sum) || cell.startsWith(`${sum} / `);
      if (!ok) {
        componentTotalMismatch = `${model.academicColumns[columnIndex].label}: "${cell}" (sum ${sum}, ${contributors} contributors)`;
      }
    });
    check(
      `${file}: component columns of the grand total add up (or stay blank)`,
      componentTotalMismatch === '',
      componentTotalMismatch,
    );
    check(
      `${file}: subject TOTAL is not mistaken for the grand total`,
      grandTotalRow.cells[4] !== academicRows[0].cells[4],
      `${grandTotalRow.cells[4]} vs ${academicRows[0].cells[4]}`,
    );

    /*
     * The no-name workbook exercises the mapping fallback — it has no plain
     * "Name" column, so the dynamic engine stands down and the index-based
     * fallback has to produce the same grouped subjects.
     */
    check(`${file}: ${usedFallback ? 'fallback' : 'dynamic'} path used as expected`,
      file.includes('no_name') ? usedFallback : true, `usedFallback=${usedFallback}`);
  }
}

/* ── 6g. real school mark sheet: column-B block + max-marks row (reported) ── */

/**
 * Reads a cell by its REAL Excel address (A1-style) straight from the sheet, so
 * an expectation can never be derived from the app's own parser.
 */
function rawSheetCellReader(file: string): (row: number, column: string) => string {
  const wb = XLSX.readFile(resolve(process.cwd(), file));
  const ws = wb.Sheets[wb.SheetNames[0]];

  return (row, column) => {
    const cell = ws[`${column}${row}`];
    return cell === undefined || cell.v === undefined ? '' : String(cell.v).trim();
  };
}

/**
 * The reported "8th marks list 26 -27.xlsx" (SHAHEED BHAGAT SINGH PUBLIC SCHOOL).
 *
 * Its layout is what made the import wrong:
 *   - the used range starts at column B, so an array position sits one column
 *     behind the real Excel column index that the mapping engine uses;
 *   - "S.No", "Student Name" and "Father name" are merged DOWN over three
 *     rows, so the max-marks row underneath them looks like a student row;
 *   - "Adm" (column C) has no merge of its own and must not be read as a roll
 *     number, and "Mother" (column F) must not be read as the father's name.
 *
 * Every expectation below is taken from the sheet's own cells.
 */
async function testRealSchoolMarkSheet(): Promise<void> {
  console.log('\n## real school mark sheet (column-B block + max-marks row)');

  const file = 'testdata_sbs_marks_list_class7.xlsx';
  const cell = rawSheetCellReader(file);

  /* Rows the sheet itself identifies as students (its S.No column is filled). */
  const numberedRows: number[] = [];
  for (let row = 1; row <= 60; row++) {
    if (/^\d+$/.test(cell(row, 'B'))) numberedRows.push(row);
  }

  check(
    `${file}: the sheet lists ${numberedRows.length} numbered student rows`,
    numberedRows.length === 13,
    `${numberedRows.length}`,
  );
  check(
    `${file}: row 5 is the max-marks row, not a student (no name, numeric components)`,
    cell(5, 'D') === '' && cell(5, 'G') === '10' && cell(5, 'K') === '100',
    `D5="${cell(5, 'D')}" G5="${cell(5, 'G')}" K5="${cell(5, 'K')}"`,
  );

  const { students, headers, usedFallback } = await buildStudentsLikeApp(file);

  check(`${file}: the dynamic structure engine is used`, !usedFallback);
  check(
    `${file}: exactly the numbered student rows are imported`,
    students.length === numberedRows.length,
    `${students.length} of ${numberedRows.length}`,
  );
  check(
    `${file}: the imported rows are the sheet's own rows`,
    students.map((student) => student.rowNumber).join(',') === numberedRows.join(','),
    students.map((student) => student.rowNumber).join(','),
  );
  check(
    `${file}: no header row is imported as a student`,
    !students.some((student) => student.rowNumber <= 5),
    students.map((student) => student.rowNumber).join(','),
  );

  /*
   * The sheet's max-marks row must reach the imported subjects, so the report
   * card can print what every line is out of (PT 10 / NB 5 / SEA 5 / SA1 80,
   * subject total 100). Expected values are read from row 5 of the sheet itself.
   */
  /*
   * Each subject owns a five-column block starting at G, in sheet order (the
   * sheet's used range begins at column B, so an array position is one column
   * behind the real Excel column — the parser's column numbers are absolute).
   */
  const sheetSubjectColumn = (subjectIndex: number, offset: number): string =>
    XLSX.utils.encode_col(6 + subjectIndex * 5 + offset);
  let maximaMismatch = '';
  students.forEach((student) => {
    student.subjects.forEach((subject, subjectIndex) => {
      const expectedSubjectMax = Number(cell(5, sheetSubjectColumn(subjectIndex, 4)));
      if (Number(subject.maxMarks) !== expectedSubjectMax) {
        maximaMismatch = `${student.name}/${subject.name}: subject max ${subject.maxMarks} vs ${expectedSubjectMax}`;
      }
      (subject.components ?? []).forEach((component, componentIndex) => {
        if (component.isTotal) return;
        const expected = Number(cell(5, sheetSubjectColumn(subjectIndex, componentIndex)));
        if (!Number.isFinite(expected)) return;
        if (Number(component.maxMarks) !== expected) {
          maximaMismatch = `${student.name}/${subject.name}/${component.name}: max ${component.maxMarks} vs ${expected}`;
        }
      });
    });
  });
  check(
    `${file}: every component keeps the sheet's own maximum marks`,
    maximaMismatch === '',
    maximaMismatch,
  );

  /*
   * …and those maxima reach the card: every column states what it is out of,
   * with the subject's own Total beside it.
   */
  const cardModel = buildReportCardModel(students[0], SCHOOL);
  const columnLabels = cardModel.academicColumns.map((column) => column.label).join(',');
  check(
    `${file}: the card states what every column is out of`,
    columnLabels === 'PT (10),NB (5),SEA (5),SA1 (80),TOTAL (100)',
    columnLabels,
  );
  const cardTotals = cardModel.academic
    .slice(0, -1)
    .map((row) => String(row.cells[row.cells.length - 1]));
  check(
    `${file}: each subject line ends in obtained / maximum`,
    cardTotals.every((value) => /^\d+(\.\d+)?\s*\/\s*100$/.test(value)),
    cardTotals.join(','),
  );
  check(
    `${file}: every imported student has a name`,
    students.every((student) => student.name.trim() !== ''),
    students.filter((student) => student.name.trim() === '').map((s) => s.rowNumber).join(','),
  );

  /* Identity fields, each against its own source column. */
  const rollNoCol = 'B';
  const admissionCol = 'C';
  const nameCol = 'D';
  const fatherCol = 'E';
  const motherCol = 'F';
  const attendanceCol = 'AV';

  let identityMismatch = '';
  for (const student of students) {
    const row = student.rowNumber;
    const expected = {
      rollNo: cell(row, rollNoCol),
      admissionNo: cell(row, admissionCol),
      name: cell(row, nameCol),
      fatherName: cell(row, fatherCol),
      motherName: cell(row, motherCol),
      attendance: cell(row, attendanceCol),
    };
    const actual = {
      rollNo: student.rollNo,
      admissionNo: student.admissionNo ?? '',
      name: student.name,
      fatherName: student.fatherName ?? '',
      motherName: student.motherName ?? '',
      attendance: student.attendance ?? '',
    };

    for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
      if (actual[key] !== expected[key]) {
        identityMismatch = `row ${row} ${key}: "${actual[key]}" vs "${expected[key]}"`;
      }
    }
  }
  check(
    `${file}: roll / admission / name / father / mother / attendance match their own columns`,
    identityMismatch === '',
    identityMismatch,
  );
  check(
    `${file}: no father's name is the max-marks number 10`,
    !students.some((student) => student.fatherName === '10'),
    students.map((student) => `${student.name}=${student.fatherName}`).join(' | '),
  );
  check(
    `${file}: the admission number is not read as the roll number`,
    students.every((student) => student.rollNo !== student.admissionNo),
    students.map((student) => `${student.rollNo}/${student.admissionNo}`).join(','),
  );

  /* Subjects: each subject's own PT / NB / SEA / SA1 / TOTAL columns. */
  const subjectColumns = [
    { name: 'English', columns: ['G', 'H', 'I', 'J', 'K'] },
    { name: 'Hindi', columns: ['L', 'M', 'N', 'O', 'P'] },
    { name: 'Math', columns: ['Q', 'R', 'S', 'T', 'U'] },
    { name: 'Science', columns: ['V', 'W', 'X', 'Y', 'Z'] },
    { name: 'Social Science', columns: ['AA', 'AB', 'AC', 'AD', 'AE'] },
    { name: 'Computer', columns: ['AF', 'AG', 'AH', 'AI', 'AJ'] },
    { name: 'Punjabi/Sanskrit', columns: ['AK', 'AL', 'AM', 'AN', 'AO'] },
  ];

  check(
    `${file}: subjects are detected in sheet order`,
    students[0].subjects.map((subject) => subject.name).join(',') ===
      subjectColumns.map((subject) => subject.name).join(','),
    students[0].subjects.map((subject) => subject.name).join(','),
  );

  let markMismatch = '';
  for (const student of students) {
    const row = student.rowNumber;

    subjectColumns.forEach((subject, index) => {
      const entry = student.subjects[index];
      const source = subject.columns.map((column) => cell(row, column));
      const components = (entry?.components ?? []).map((component) =>
        component.marks === null ? '' : String(component.marks),
      );

      if (components.join(',') !== source.join(',')) {
        markMismatch = `row ${row} ${subject.name} components [${components.join(',')}] vs [${source.join(',')}]`;
      }
      /* The subject mark is the sheet's own TOTAL cell — never a fresh sum. */
      if (String(entry?.marks ?? '') !== source[4]) {
        markMismatch = `row ${row} ${subject.name} total ${entry?.marks} vs source TOTAL ${source[4]}`;
      }
      if (String(entry?.maxMarks ?? '') !== '100') {
        markMismatch = `row ${row} ${subject.name} max ${entry?.maxMarks} vs source max 100`;
      }
    });
  }
  check(
    `${file}: every component and subject total matches its own Excel column`,
    markMismatch === '',
    markMismatch,
  );

  /*
   * The reported symptom: Punjabi/Sanskrit printed 115/100 because the TOTAL
   * column was read one column to the right (the grade column) and the max-mark
   * cell was then summed in as if it were SA1 marks.
   */
  const first = students[0];
  const punjabi = first.subjects.find((subject) => /punjabi/i.test(subject.name));
  check(
    `${file}: Punjabi/Sanskrit is the sheet's own TOTAL cell`,
    punjabi?.marks === Number(cell(first.rowNumber, 'AO')),
    `${punjabi?.marks} vs ${cell(first.rowNumber, 'AO')}`,
  );
  check(
    `${file}: Punjabi/Sanskrit never prints the impossible 115/100`,
    students.every((student) => {
      const subject = student.subjects.find((entry) => /punjabi/i.test(entry.name));
      return !subject || subject.marks === null || subject.marks <= subject.maxMarks;
    }),
    students
      .map((student) => student.subjects[6]?.marks)
      .join(','),
  );
  check(
    `${file}: no subject anywhere exceeds its maximum`,
    students.every((student) =>
      student.subjects.every((subject) => subject.marks === null || subject.marks <= subject.maxMarks),
    ),
    '',
  );

  /* Overall columns stay separate from the subject totals. */
  let overallMismatch = '';
  for (const student of students) {
    const row = student.rowNumber;
    if (Number(student.overall?.total ?? NaN) !== Number(cell(row, 'AS'))) {
      overallMismatch = `row ${row} total ${student.overall?.total} vs ${cell(row, 'AS')}`;
    } else if (Number(student.overall?.percentage ?? NaN) !== Number(cell(row, 'AT'))) {
      overallMismatch = `row ${row} percentage ${student.overall?.percentage} vs ${cell(row, 'AT')}`;
    } else if (String(student.overall?.position ?? '') !== cell(row, 'AU')) {
      overallMismatch = `row ${row} position ${student.overall?.position} vs ${cell(row, 'AU')}`;
    }
  }
  check(`${file}: overall TOTAL / % / POSITION match the sheet`, overallMismatch === '', overallMismatch);

  const grades = (first.gradeFields ?? [])
    .map((field) => `${field.name}=${field.value}`)
    .join(',');
  check(
    `${file}: MV / GK / Drawing stay co-scholastic grade fields`,
    grades ===
      `M.V.=${cell(first.rowNumber, 'AP')},GK=${cell(first.rowNumber, 'AQ')},Drawing=${cell(first.rowNumber, 'AR')}`,
    grades,
  );

  /*
   * The empty column behind ATTENDANCE must not inherit its label: a phantom
   * second attendance column silently replaced the real value.
   */
  check(
    `${file}: only the real column is an attendance column`,
    headers.filter((header) => /attendance/i.test(header)).length === 1,
    headers.filter((header) => /attendance/i.test(header)).join(','),
  );

  /*
   * The file is named "8th", the sheet title says CLASS-7th. Neither may be
   * silently rewritten: the report uses the sheet's own class.
   */
  check(
    `${file}: the class comes from the sheet title, never the file name`,
    students.every((student) => student.class === '7th'),
    students.map((student) => student.class).join(','),
  );

  /*
   * The sheet has no blank marks, so a copy with two cells cleared is used to
   * prove a genuine blank stays blank and never drags a neighbour into the
   * empty cell (mother's name ← father's name, English NB ← SEA …).
   */
  const wb = XLSX.readFile(resolve(process.cwd(), file));
  const ws = wb.Sheets[wb.SheetNames[0]];
  delete ws[`${motherCol}8`];
  delete ws[`H${first.rowNumber + 1}`];
  const serialised = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  const blankedFile = {
    name: 'blanked-copy.xlsx',
    arrayBuffer: () =>
      Promise.resolve(
        serialised.buffer.slice(
          serialised.byteOffset,
          serialised.byteOffset + serialised.byteLength,
        ) as ArrayBuffer,
      ),
  } as unknown as File;

  const blanked = await buildStudentsFromFile(blankedFile);
  const withoutMother = blanked.students.find((student) => student.rowNumber === 8);
  const withoutNb = blanked.students.find((student) => student.rowNumber === first.rowNumber + 1);

  check(
    `${file}: a blank mother cell stays blank and never becomes the father name`,
    withoutMother !== undefined &&
      (withoutMother.motherName ?? '') === '' &&
      withoutMother.fatherName === cell(8, fatherCol),
    `${withoutMother?.motherName} / ${withoutMother?.fatherName}`,
  );
  check(
    `${file}: a blank component stays blank and the next one is not shifted in`,
    withoutNb !== undefined &&
      (withoutNb.subjects[0]?.components ?? []).map((component) =>
        component.marks === null ? '' : String(component.marks),
      ).join(',') ===
        `${cell(first.rowNumber + 1, 'G')},,${cell(first.rowNumber + 1, 'I')},${cell(
          first.rowNumber + 1,
          'J',
        )},${cell(first.rowNumber + 1, 'K')}`,
    (withoutNb?.subjects[0]?.components ?? [])
      .map((component) => (component.marks === null ? '' : String(component.marks)))
      .join(','),
  );
}

/* ────────────────────────────── 7. themes ────────────────────────────── */

function testThemes(): void {
  console.log('\n## themes');
  check('three themes are registered', REPORT_CARD_THEMES.length >= 3);
  check(
    'theme ids are unique',
    new Set(REPORT_CARD_THEMES.map((theme) => theme.id)).size === REPORT_CARD_THEMES.length,
  );
  const holistic = REPORT_CARD_THEMES.find((theme) => theme.id === 'holistic')!;
  const academic = REPORT_CARD_THEMES.find((theme) => theme.layout === 'academic')!;
  const student = makeStudent({
    subjects: [{ name: 'English', marks: 76, maxMarks: 100, status: 'present', hasComponents: false }],
  });
  const holisticModel = buildReportCardModel(student, { ...SCHOOL, reportTheme: holistic.id });
  const academicModel = buildReportCardModel(student, { ...SCHOOL, reportTheme: academic.id });
  check('theme decides the card title', holisticModel.title !== academicModel.title,
    `${holisticModel.title} vs ${academicModel.title}`);
  check(
    'unknown theme falls back to the default',
    buildReportCardModel(student, { ...SCHOOL, reportTheme: 'does-not-exist' }).themeId === 'holistic',
  );
  check('default assessment scale is five stars', DEFAULT_ASSESSMENT_CONFIG.maxStars === 5);
}

/* ──────── 6g. mall navigation through Joy must not crash SectionPage ───── */

/**
 * Two guards for the reported crash: asking Joy to take you to ReportCard Studio
 * must (a) resolve to that real route, and (b) render without breaking the Rules
 * of Hooks. `SectionPage` used to return the ReportCard Studio embed BEFORE its
 * `useMemo` calls, so navigating in from another section made React throw
 * "Rendered fewer hooks than expected" and blank the page.
 */
function testMallNavigationSafety(): void {
  console.log('\n## mall navigation (Joy → ReportCard Studio)');

  const resolved = resolveJoyQuery('ReportCard mein le chalo', 'hi');
  check(
    'Joy resolves the ReportCard Studio route',
    resolved?.kind === 'section' && resolved.topic.route === '/section/reportcard-studio',
    resolved?.kind === 'section' ? resolved.topic.route : String(resolved?.kind),
  );
  check(
    'Joy navigates on a clear action request',
    resolved?.kind === 'section' && resolved.navigate === true,
  );

  const source = readFileSync(resolve(process.cwd(), '..', 'src', 'pages', 'SectionPage.tsx'), 'utf8');
  const hookIndex = Math.max(
    source.indexOf('useMemo('),
    source.indexOf('useEffect('),
    source.indexOf('useRef('),
  );
  const reportCardReturn = source.indexOf('if (isReportCard)');
  check(
    'SectionPage runs every hook before the ReportCard Studio early return',
    hookIndex >= 0 && reportCardReturn > hookIndex,
    `hook=${hookIndex} reportCardReturn=${reportCardReturn}`,
  );

  /* No top-level `return` may appear before the ReportCard Studio branch either. */
  const firstReturn = source.indexOf('\n  return ');
  check(
    'SectionPage has no early return before its hooks',
    firstReturn === -1 || firstReturn > hookIndex,
    `firstReturn=${firstReturn} hook=${hookIndex}`,
  );
}

/* ───────── 8. attendance warnings, Joy explanations, grand-total max ─────── */

function testAttendanceWarningsAndJoy(): void {
  console.log('\n## attendance warnings + Joy explanations + grand-total maximum');

  /*
   * The reported workbook stores days present (101–106) in the Attendance
   * column. The value must NOT be silently converted or hidden — it is flagged
   * as a warning that names the student and explains it is a days-present count.
   */
  const dayStudents = [
    makeStudent({ studentId: 'row-1', rollNo: '1', rowNumber: 2, name: 'Rohit Kumar', attendance: '104' }),
    makeStudent({ studentId: 'row-2', rollNo: '2', rowNumber: 3, name: 'Sita Devi', attendance: '106' }),
    makeStudent({ studentId: 'row-3', rollNo: '3', rowNumber: 4, name: 'Amit', attendance: '92%' }),
    makeStudent({ studentId: 'row-4', rollNo: '4', rowNumber: 5, name: 'Bina', attendance: 'abc' }),
    makeStudent({ studentId: 'row-5', rollNo: '5', rowNumber: 6, name: 'Cara', attendance: '-5' }),
  ];
  const daysValidation = validateStudents(dayStudents);

  check('days-present attendance stays visible (no silent conversion)',
    dayStudents.every((s) => s.attendance === undefined ? false : true) &&
      dayStudents[0].attendance === '104',
    String(dayStudents[0].attendance));
  check('days-present values raise warnings, not errors',
    daysValidation.errorCount === 0 && daysValidation.warningCount === 4,
    `${daysValidation.errorCount}E/${daysValidation.warningCount}W`);

  const daysIssues = daysValidation.issues.filter((i) => i.type === 'attendance_looks_like_days');
  check('both 104 and 106 are flagged as days-present', daysIssues.length === 2, `${daysIssues.length}`);
  check('the warning names the affected student', daysIssues.some((i) => i.studentName === 'Rohit Kumar'),
    daysIssues.map((i) => i.studentName).join(','));
  check('the warning names the affected field', daysIssues.every((i) => i.field === 'attendance'));
  check('the warning carries the offending value', daysIssues.every((i) => i.value === '104' || i.value === '106'),
    daysIssues.map((i) => i.value).join(','));
  check('the days-present cause is presented as possible, not confirmed',
    daysIssues.every((i) => i.confirmed === false));
  check('the reason explains the value cannot be a percentage',
    daysIssues.every((i) => /days present/i.test(i.reason ?? '')),
    daysIssues[0]?.reason ?? 'no reason');
  check('the suggested fix maps the column to Days Present',
    daysIssues.every((i) => /Days Present/.test(i.suggestion ?? '')),
    daysIssues[0]?.suggestion ?? 'no suggestion');

  check('a real percentage produces no attendance issue',
    daysValidation.issues.every((i) => i.studentId !== 'row-3'));
  check('a non-numeric attendance value is malformed (confirmed)',
    daysValidation.issues.some((i) => i.studentId === 'row-4' && i.type === 'invalid_attendance' && i.confirmed === true));
  check('a negative attendance value is malformed (confirmed)',
    daysValidation.issues.some((i) => i.studentId === 'row-5' && i.type === 'invalid_attendance' && i.confirmed === true));

  /* Genuine errors stay errors and remain distinguishable from the warnings. */
  const mixed = validateStudents([
    makeStudent({ studentId: 'row-1', rollNo: '1', rowNumber: 2, name: '', attendance: '104' }),
  ]);
  check('a genuine error is still an error beside attendance warnings',
    mixed.errorCount === 1 && mixed.warningCount === 1 &&
      mixed.issues.some((i) => i.type === 'missing_name' && i.severity === 'error'),
    `${mixed.errorCount}E/${mixed.warningCount}W`);

  /* ── Multilingual Joy explanations from the CURRENT validation data ── */
  const context = { validation: daysValidation, students: dayStudents };
  const en = explainValidation(context, 'en');
  const hi = explainValidation(context, 'hi');
  const hinglish = explainValidation(context, 'hinglish');

  check('English explanation states the totals', /0 errors and 4 warnings/.test(en), en.split('\n')[0]);
  check('English explanation names the affected student', en.includes('Rohit Kumar'));
  check('English explanation names the issue type', /Attendance looks like days present/.test(en));
  check('English explanation gives a correction', /Days Present/.test(en));
  check('English explanation separates confirmed and possible causes',
    en.includes('Possible cause') && en.includes('Confirmed cause'));
  check('Hindi explanation is in Devanagari', /[\u0900-\u097F]/.test(hi), hi.slice(0, 40));
  check('Hindi explanation still names the student', hi.includes('Rohit Kumar'));
  check('Hinglish explanation is Hinglish, not English',
    hinglish !== en && /warning/i.test(hinglish) && hinglish.includes('Rohit Kumar'));
  check('the three languages differ', en !== hi && hi !== hinglish && en !== hinglish);

  check('English question is detected as English',
    detectExplainLang('what warnings am i getting') === 'en');
  check('Hinglish question is detected as Hinglish',
    detectExplainLang('Mujhe kya warning aa rahi hai?') === 'hinglish');
  check('Devanagari question is detected as Hindi',
    detectExplainLang('यह error क्यों आ रहा है?') === 'hi');

  check('"What warnings am I getting?" is a validation question',
    isValidationQuery('what warnings am i getting', ['what', 'warnings', 'am', 'i', 'getting']));
  check('"How can I fix these issues?" is a validation question',
    isValidationQuery('how can i fix these issues', ['how', 'can', 'i', 'fix', 'these', 'issues']));
  check('an off-topic question is not a validation question',
    !isValidationQuery('what is the weather today', ['what', 'is', 'the', 'weather', 'today']));
  check('a plan-renewal warning question is not the import validation',
    !isValidationQuery('when will my renewal warning come', ['when', 'will', 'my', 'renewal', 'warning', 'come']));

  /* resolveStudioQuery must answer from the live context, in the right language. */
  const enAnswer = resolveStudioQuery('What warnings am I getting?', 'import', 'en', context);
  check('Joy answers a warning question from the current import',
    Boolean(enAnswer?.reply) && enAnswer!.reply.includes('Rohit Kumar') && /4 warnings/.test(enAnswer!.reply),
    enAnswer?.reply.slice(0, 50));
  const hiAnswer = resolveStudioQuery('Mujhe kya warning aa rahi hai?', 'import', 'hi', context);
  check('Joy answers a Hinglish warning question IN HINGLISH, from the live data',
    Boolean(hiAnswer?.reply) &&
      hiAnswer!.reply.includes('Rohit Kumar') &&
      /warning/i.test(hiAnswer!.reply) &&
      /aa rahi|mil|dikh|hai/.test(hiAnswer!.reply),
    hiAnswer?.reply.slice(0, 60));
  const devAnswer = resolveStudioQuery('यह error क्यों आ रहा है?', 'import', 'hi', context);
  check('Joy answers a Devanagari question in Hindi',
    Boolean(devAnswer?.reply) && /[\u0900-\u097F]/.test(devAnswer!.reply) && /Rohit Kumar/.test(devAnswer!.reply));

  /* The generic validation FAQ must no longer shadow the live answer. */
  check('the answer is data-specific, not the generic FAQ',
    Boolean(enAnswer) && !/Validation catches missing names/.test(enAnswer!.reply));

  /* Not enough data → Joy says what to check instead of inventing a cause. */
  const noResults = explainValidation({ validation: null, students: [] }, 'en');
  check('no validation results → Joy asks the user to import first',
    /validation results yet/i.test(noResults) && /import/i.test(noResults));
  const clean = explainValidation(
    { validation: { isValid: true, issues: [], errorCount: 0, warningCount: 0 }, students: [] },
    'en',
  );
  check('a clean import reports zero errors and warnings', /0 errors, 0 warnings/.test(clean));

  /* Undeterminable cause must be stated, not guessed. */
  const unknown = explainValidation(
    {
      validation: {
        isValid: true,
        errorCount: 0,
        warningCount: 1,
        issues: [
          { studentId: 'row-1', studentName: 'Rohit Kumar', severity: 'warning', type: 'invalid_attendance', field: 'attendance', message: 'Attendance malformed.' },
        ],
      },
      students: dayStudents,
    },
    'en',
  );
  check('an undeterminable cause tells the user what to check',
    /could not be determined/.test(unknown) && unknown.includes('attendance'));

  /* ── Grand total maximum must be computed from the subjects, not hardcoded ── */
  const sevenSubjects = ['English', 'Hindi', 'Maths', 'Science', 'Social Science', 'Computer', 'Sanskrit'];
  const sevenMarks = [80, 72, 75, 78, 79, 79, 79]; // obtained 542 of 700
  const grandStudent = makeStudent({
    studentId: 'row-501',
    rollNo: '501',
    name: 'Grand Total Check',
    subjects: sevenSubjects.map((name, index) => ({
      name,
      marks: sevenMarks[index],
      maxMarks: 100,
      status: 'present' as const,
      hasComponents: false,
    })),
  });
  const grandModel = buildReportCardModel(grandStudent, SCHOOL);
  const grandRow = grandModel.academic[grandModel.academic.length - 1];
  const grandCell = grandRow.cells[grandRow.cells.length - 1];
  check('grand total prints obtained / maximum', grandCell === '542 / 700', grandCell);
  /*
   * Every subject line carries its own "obtained / maximum" beside the grand
   * total, and the Total column header names the maximum it is out of.
   */
  const totalColumnLabel = grandModel.academicColumns[grandModel.academicColumns.length - 1].label;
  check('the TOTAL column header states its maximum', totalColumnLabel === 'Total (100)', totalColumnLabel);
  const subjectTotalCells = grandModel.academic
    .slice(0, -1)
    .map((row) => String(row.cells[row.cells.length - 1]));
  check(
    'every subject line prints its marks out of its own maximum',
    subjectTotalCells.every((cell, index) => cell === `${sevenMarks[index]} / 100`),
    subjectTotalCells.join(','),
  );
  check('grand total maximum is derived from the subjects', grandRow.maxMarks === 700, String(grandRow.maxMarks));
  check('grand total marks are unchanged', grandRow.marks === 542, String(grandRow.marks));
  check('percentage uses the same dynamic maximum', grandModel.totals.percentage === 77.43,
    String(grandModel.totals.percentage));

  /* A grade-only column (maxMarks 0) must not inflate the maximum. */
  const withGradeOnly = makeStudent({
    studentId: 'row-502',
    rollNo: '502',
    name: 'Grade Only Check',
    subjects: [
      ...sevenSubjects.map((name, index) => ({
        name,
        marks: sevenMarks[index],
        maxMarks: 100,
        status: 'present' as const,
        hasComponents: false,
      })),
      { name: 'GK', marks: null, maxMarks: 0, status: 'present' as const, hasComponents: false },
    ],
  });
  const gradeOnlyRow =
    buildReportCardModel(withGradeOnly, SCHOOL).academic.slice(-1)[0];
  check('a co-scholastic grade column does not change the maximum',
    gradeOnlyRow.cells[gradeOnlyRow.cells.length - 1] === '542 / 700',
    gradeOnlyRow.cells[gradeOnlyRow.cells.length - 1]);
}

/* ───── 8b. manual photo correction (per-student override) ────────────────── */

function testManualPhotoCorrection(): void {
  console.log('\n## manual photo correction');

  const ZIP: PhotoMap = {
    '13_EKANJOT.jpg': 'data:image/png;base64,AAAA',
    'Aarav Sharma.jpeg': 'data:image/png;base64,CCCC',
    'spare.png': 'data:image/png;base64,ZZZZ',
  };

  const students = [
    { studentId: 'row-1', rowNumber: 1, rollNo: '1', name: 'Aarav Sharma' },
    { studentId: 'row-2', rowNumber: 2, rollNo: '13', name: 'EKANJOT' },
    /* Same name as row-1, different roll: never merged by name alone. */
    { studentId: 'row-3', rowNumber: 3, rollNo: '27', name: 'Aarav Sharma' },
    { studentId: 'row-4', rowNumber: 4, rollNo: '31', name: 'Rohit Kumar' },
  ];

  /* Automatic matching first — this is what the override builds on. */
  const auto = resolvePhotosWithOverrides(students, ZIP, {});
  check('auto: roll-prefixed photo is matched without a manual choice',
    auto.photos.get('row-2') === ZIP['13_EKANJOT.jpg'] && auto.status.get('row-2') === 'matched');
  check('auto: two students sharing a name are both refused the photo',
    !auto.photos.has('row-1') &&
      !auto.photos.has('row-3') &&
      auto.status.get('row-1') === 'ambiguous' &&
      auto.status.get('row-3') === 'ambiguous',
    `row-1=${auto.status.get('row-1')} row-3=${auto.status.get('row-3')}`);
  check('auto: an unmatched student is reported missing',
    auto.status.get('row-4') === 'missing' && !auto.photos.has('row-4'));

  /* A manual pick must win for the student it names, and only that student. */
  const manual = resolvePhotosWithOverrides(students, ZIP, {
    'row-4': ZIP['spare.png'],
  });
  check('manual: the chosen photo is attached to the chosen student',
    manual.photos.get('row-4') === ZIP['spare.png'] && manual.status.get('row-4') === 'manual');
  check('manual: other students keep their automatic match',
    manual.photos.get('row-2') === ZIP['13_EKANJOT.jpg'] &&
      manual.status.get('row-2') === 'matched' &&
      manual.status.get('row-1') === 'ambiguous');
  check('manual: the user can resolve an ambiguous row by hand',
    resolvePhotosWithOverrides(students, ZIP, { 'row-1': ZIP['Aarav Sharma.jpeg'] })
      .status.get('row-1') === 'manual');

  /* Clearing must not silently fall back to the automatic photo. */
  const cleared = resolvePhotosWithOverrides(students, ZIP, { 'row-2': null });
  check('cleared: the cleared student prints no photo',
    !cleared.photos.has('row-2') && cleared.status.get('row-2') === 'cleared');
  check('cleared: other rows are untouched',
    cleared.status.get('row-1') === 'ambiguous' && cleared.status.get('row-4') === 'missing');

  /* Two students given the same manual picture: honoured, then warned. */
  const conflict = resolvePhotosWithOverrides(students, ZIP, {
    'row-3': ZIP['spare.png'],
    'row-4': ZIP['spare.png'],
  });
  check('shared manual photo is honoured for both students',
    conflict.photos.get('row-3') === ZIP['spare.png'] &&
      conflict.photos.get('row-4') === ZIP['spare.png']);
  check('shared manual photo is reported as a conflict',
    conflict.conflicts.length === 2 &&
      conflict.conflicts.includes('row-3') &&
      conflict.conflicts.includes('row-4'),
    conflict.conflicts.join(','));

  /* Ambiguity still leaves the automatic match blank. */
  const twin = resolvePhotosWithOverrides(
    [
      { studentId: 'row-1', rowNumber: 1, rollNo: '1', name: 'Aarav Sharma' },
      { studentId: 'row-3', rowNumber: 3, rollNo: '27', name: 'Aarav Sharma' },
    ],
    { 'Aarav Sharma.jpeg': 'data:image/png;base64,CCCC' },
    {},
  );
  check('duplicate names never receive the same automatic photo', twin.photos.size === 0);
  check('a roll number disambiguates the duplicate names',
    resolvePhotosWithOverrides(
      [
        { studentId: 'row-1', rowNumber: 1, rollNo: '1', name: 'Aarav Sharma' },
        { studentId: 'row-3', rowNumber: 3, rollNo: '27', name: 'Aarav Sharma' },
      ],
      { '27_Aarav Sharma.jpg': 'data:image/png;base64,CCCC' },
      {},
    ).photos.get('row-3') === 'data:image/png;base64,CCCC');

  /* There is one resolver, so every status has user-facing wording. */
  const statuses = ['manual', 'cleared', 'matched', 'ambiguous', 'missing'] as const;
  check('every photo status has a label',
    statuses.every((s) => photoStatusLabel(s).length > 0));

  /* Every student gets exactly one status row. */
  check('the review table covers every student',
    students.every((s) => auto.status.has(s.studentId)));
}

/* ───── 8b-ii. the PDF ARTIFACT itself (not the HTML preview) ───────────── */

/** 1x1 transparent PNG — a real image the PDF can embed. */
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

function pdfText(latin1: string): string {
  return extractTextRuns(latin1).map((run) => run.text).join(' ');
}

async function testPdfArtifact(): Promise<void> {
  console.log('\n## pdf artifact (totals + manual photo)\n');

  const subjects = [
    'English',
    'Hindi',
    'Maths',
    'Science',
    'Social Science',
    'Computer',
    'Sanskrit',
  ];
  const marks = [80, 72, 75, 78, 79, 79, 79]; // 542 of 700 = 77.43%
  const student = makeStudent({
    studentId: 'row-601',
    rollNo: '601',
    name: 'Pdf Artifact Check',
    attendance: '92',
    subjects: subjects.map((name, index) => ({
      name,
      marks: marks[index],
      maxMarks: 100,
      status: 'present' as const,
      hasComponents: false,
    })),
  });
  const school: SchoolProfile = { ...SCHOOL };

  /* ---- the values must be IN the generated PDF, not only in the model ---- */
  const blob = await generateStudentPdfBlob({ student, school });
  const latin1 = Buffer.from(await blob.arrayBuffer()).toString('latin1');
  const text = pdfText(latin1);

  check('the PDF is a real PDF document', latin1.startsWith('%PDF-'));
  check('the PDF prints the grand total as obtained / maximum',
    text.includes('542 / 700'),
    text.match(/5\d\d[^|]{0,12}/)?.[0] ?? 'grand total not found');
  check('the PDF prints the same percentage as the model', /77\.4/.test(text),
    text.match(/77\.[0-9]+/)?.[0] ?? 'percentage not found');
  check('the PDF prints the student it belongs to', text.toUpperCase().includes('PDF ARTIFACT CHECK'));

  /*
   * The card must also carry the OVERALL GRADE and RESULT, computed by the same
   * engine as the sidebar — not the 33% rule duplicated in the UI.
   */
  const artifactModel = buildReportCardModel(student, school);
  check(
    'the model reports a pass with PROMOTED for 77.4%',
    artifactModel.totals.passed === true && artifactModel.totals.result === 'PROMOTED',
    `${artifactModel.totals.passed}/${artifactModel.totals.result}`,
  );
  check(
    'the summary line carries total, percentage, grade and result',
    artifactModel.totals.summary.includes('542 / 700') &&
      artifactModel.totals.summary.includes(`${artifactModel.totals.percentage}%`) &&
      artifactModel.totals.summary.includes(artifactModel.totals.grade) &&
      artifactModel.totals.summary.includes('PROMOTED'),
    artifactModel.totals.summary,
  );
  check('the PDF prints the overall grade',
    text.includes(artifactModel.totals.grade),
    artifactModel.totals.grade);
  check('the PDF prints the result',
    text.toUpperCase().includes('PROMOTED'),
    text.match(/PROMOTED|NEEDS IMPROVEMENT/)?.[0] ?? 'result not found');
  check('the PDF prints the attendance line',
    /attendance/i.test(text) && /92/.test(text),
    text.match(/attendance[^|]{0,20}/i)?.[0] ?? 'attendance not found');

  const holisticSchool: SchoolProfile = { ...school, reportTheme: 'holistic' };
  const holisticBlob = await generateStudentPdfBlob({ student, school: holisticSchool });
  const holisticPdfText = pdfText(Buffer.from(await holisticBlob.arrayBuffer()).toString('latin1'));
  check('the holistic PDF also prints the grade and the result',
    holisticPdfText.includes(artifactModel.totals.grade) &&
      holisticPdfText.toUpperCase().includes('PROMOTED'),
    holisticPdfText.match(/PROMOTED|NEEDS IMPROVEMENT/)?.[0] ?? 'result not found');
  check('the holistic PDF prints the same percentage',
    /77\.4/.test(holisticPdfText),
    holisticPdfText.match(/77\.[0-9]+/)?.[0] ?? 'percentage not found');

  check('the PDF stays on a single A4 page',
    (latin1.match(/\/Type\s*\/Page[^s]/g) ?? []).length === 1,
    String((latin1.match(/\/Type\s*\/Page[^s]/g) ?? []).length));

  /* ---- a manual photo correction must reach the real PDF -------------- */
  const zipWithout = await generateAllAndZip({
    students: [student],
    school,
    photoMap: { 'unrelated.jpg': TINY_PNG },
  });
  const zipManual = await generateAllAndZip({
    students: [student],
    school,
    photoMap: { 'unrelated.jpg': TINY_PNG },
    photoOverrides: { 'row-601': TINY_PNG },
  });

  const imageInZip = async (result: { blob: Blob }): Promise<boolean> => {
    const archive = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const names = Object.keys(archive.files).filter((name) => name.endsWith('.pdf'));
    if (names.length !== 1) return false;
    const bytes = await archive.files[names[0]].async('uint8array');
    return /\/Subtype\s*\/Image/.test(Buffer.from(bytes).toString('latin1'));
  };

  check('without a manual choice the unrelated photo is not attached',
    (await imageInZip(zipWithout)) === false);
  check('a manually chosen photo IS embedded in the generated PDF',
    (await imageInZip(zipManual)) === true);
  const manualArchive = await JSZip.loadAsync(await zipManual.blob.arrayBuffer());
  const manualPdfs = Object.keys(manualArchive.files).filter((name) => name.endsWith('.pdf'));
  check('the batch produces one PDF per student',
    manualPdfs.length === 1 && manualPdfs[0] === '601_Pdf_Artifact_Check.pdf',
    manualPdfs.join(','));
}

/* ───── 8c. one calculation source for sidebar / preview / PDF ────────────── */

function testSingleCalculationSource(): void {
  console.log('\n## single calculation source (sidebar = card = PDF)');

  const student = makeStudent({
    studentId: 'row-601',
    rollNo: '601',
    name: 'Source Check',
    subjects: [
      { name: 'English', marks: 80, maxMarks: 100, status: 'present' as const, hasComponents: false },
      { name: 'Maths', marks: 90, maxMarks: 100, status: 'present' as const, hasComponents: false },
    ],
  });

  const defaultSchool: SchoolProfile = { ...SCHOOL };
  /* A school with its own grading bands — the case that used to drift. */
  const customSchool: SchoolProfile = {
    ...SCHOOL,
    gradingBands: [
      { grade: 'DISTINCTION', min: 80, max: 100, remark: 'Outstanding' },
      { grade: 'PASS', min: 0, max: 79, remark: 'Keep going' },
    ],
  };

  const model = buildReportCardModel(student, customSchool);
  const defaultTotals = computeTotals(student);
  const bandTotals = computeTotals(student, { bands: customSchool.gradingBands });

  check('the card model uses the school\'s own grading bands',
    model.totals.grade === 'DISTINCTION' && model.totals.grade !== defaultTotals.overallGrade,
    `${model.totals.grade} vs ${defaultTotals.overallGrade}`);
  check('the model totals equal computeTotals with the same bands',
    model.totals.grade === bandTotals.overallGrade &&
      model.totals.obtained === bandTotals.totalMarks &&
      model.totals.max === bandTotals.totalMax &&
      model.totals.percentage === bandTotals.percentage);
  check('marks and maximum are unchanged by the bands',
    model.totals.obtained === 170 && model.totals.max === 200,
    `${model.totals.obtained}/${model.totals.max}`);
  check('percentage is 85% for 170 of 200', model.totals.percentage === 85,
    String(model.totals.percentage));

  /* Nothing about the default school changed for other tests. */
  const plainModel = buildReportCardModel(student, defaultSchool);
  check('a school without custom bands keeps the default scale',
    plainModel.totals.grade === defaultTotals.overallGrade);
}

/* ───── 9. universal compatibility: dynamic components, Hindi, exam rules ─── */

function testExaminationClassification(): void {
  console.log('\n## examination component classification');

  const cases: Array<[string, string, boolean]> = [
    ['SA1', 'SA1', true],
    ['SA2', 'SA2', true],
    ['sa-1', 'SA1', true],
    ['FA1', 'FA1', true],
    ['FA2', 'FA2', true],
    ['Term 2', 'Term2', true],
    ['Half Yearly', 'Half Yearly', true],
    ['Annual', 'Annual', true],
    ['Pre-Board', 'Pre-Board', true],
    ['PT', 'General', false],
    ['NB', 'General', false],
    ['SEA', 'General', false],
    ['Theory', 'General', false],
    ['Practical', 'General', false],
    ['Internal Assessment', 'General', false],
  ];
  for (const [input, exam, terminal] of cases) {
    const result = classifyComponent(input);
    check(`"${input}" → ${exam} (terminal=${terminal})`,
      result.examination === exam && result.terminal === terminal,
      `${result.examination}/${result.terminal}`);
  }

  const component = (name: string, maxMarks: number, isTotal = false) => ({
    name, marks: maxMarks, maxMarks, status: 'present' as const, isTotal,
  });

  /* Pattern C: PT + NB + SEA + SA1 + SA2 — SA1/SA2 are separate examinations. */
  const multi = makeStudent({
    name: 'Multi Exam',
    subjects: [{
      name: 'English', marks: 140, maxMarks: 180, status: 'present', hasComponents: true,
      components: [component('PT', 10), component('NB', 5), component('SEA', 5), component('SA1', 80), component('SA2', 80)],
    }],
  });
  const multiPlan = analyzeExaminations([multi]).subjects[0];
  check('SA1+SA2 with no TOTAL is a multi-exam that needs confirmation',
    multiPlan.combination === 'multi-exam' && multiPlan.needsConfirmation === true,
    `${multiPlan.combination}/${multiPlan.needsConfirmation}`);
  check('the two separate examinations are named',
    multiPlan.examinations.join('+') === 'SA1+SA2', multiPlan.examinations.join('+'));

  /* Pattern A: PT + NB + SEA + SA1 — a single examination. */
  const single = makeStudent({
    name: 'Single Exam',
    subjects: [{
      name: 'English', marks: 79, maxMarks: 100, status: 'present', hasComponents: true,
      components: [component('PT', 10), component('NB', 5), component('SEA', 5), component('SA1', 80)],
    }],
  });
  check('one terminal exam is a single-exam subject',
    analyzeExaminations([single]).subjects[0].combination === 'single-exam');

  /* Pattern E: Theory + Practical + Internal — one examination. */
  const written = makeStudent({
    name: 'Written',
    subjects: [{
      name: 'Science', marks: 80, maxMarks: 100, status: 'present', hasComponents: true,
      components: [component('Theory', 70), component('Practical', 20), component('Internal', 10)],
    }],
  });
  check('theory + practical + internal is a single examination',
    analyzeExaminations([written]).subjects[0].combination === 'single-exam');

  /* An explicit TOTAL is the workbook establishing the rule. */
  const withTotal = makeStudent({
    name: 'With Total',
    subjects: [{
      name: 'English', marks: 79, maxMarks: 100, status: 'present', hasComponents: true,
      components: [component('SA1', 40), component('SA2', 39), component('TOTAL', 79, true)],
    }],
  });
  const totalPlan = analyzeExaminations([withTotal]).subjects[0];
  check('an explicit TOTAL resolves the rule (no confirmation needed)',
    totalPlan.combination === 'explicit-total' && totalPlan.needsConfirmation === false,
    `${totalPlan.combination}/${totalPlan.needsConfirmation}`);

  const multiValidation = validateStudents([multi]);
  const examIssues = multiValidation.issues.filter((i) => i.type === 'examination_rule_assumed');
  check('multi-exam subject raises a warning, not an error',
    multiValidation.errorCount === 0 && examIssues.length === 1,
    `${multiValidation.errorCount}E/${examIssues.length}`);
  check('the examination warning is unconfirmed and never blocks generation',
    examIssues[0]?.confirmed === false && examIssues[0]?.blocksGeneration === false,
    `${examIssues[0]?.confirmed}/${examIssues[0]?.blocksGeneration}`);
  check('errors DO block generation',
    validateStudents([{ ...makeStudent({ attendance: '95%' }), name: '' }])
      .issues.filter((i) => i.severity === 'error')
      .every((i) => i.blocksGeneration === true));
}

async function testUniversalWorkbooks(): Promise<void> {
  console.log('\n## universal workbooks (dynamic components, Hindi, exam rules)');

  /* 1. SA1 + SA2 with meaningful maxima and no TOTAL. */
  const { students: saStudents } = await buildStudentsFromWorkbook('testdata_universal_sa1_sa2.xlsx');
  check('SA1/SA2 workbook parses every student', saStudents.length === 8, `${saStudents.length}`);
  const first = saStudents[0];
  check('student identity is read', first.name === 'Aarav Sharma' && first.rollNo === '1' && first.class === '5',
    `${first.name}/${first.rollNo}/${first.class}`);
  const english = first.subjects.find((s) => s.name === 'English');
  check('English is one subject with five components',
    Boolean(english) && (english!.components?.length ?? 0) === 5,
    english?.components?.map((c) => c.name).join(','));
  check('component names and maxima are discovered from the workbook',
    JSON.stringify(english?.components?.map((c) => [c.name, c.maxMarks])) ===
      JSON.stringify([['PT (10)', 10], ['NB (5)', 5], ['SEA (5)', 5], ['SA1 (80)', 80], ['SA2 (80)', 80]]),
    english?.components?.map((c) => `${c.name}=${c.maxMarks}`).join(','));
  check('SA1 and SA2 maxima are NOT blindly merged into a 100-mark exam',
    english?.maxMarks === 180, String(english?.maxMarks));

  const saValidation = validateStudents(saStudents);
  const saExamWarnings = saValidation.issues.filter((i) => i.type === 'examination_rule_assumed');
  check('SA1+SA2 with no TOTAL warns for every subject (no errors)',
    saValidation.errorCount === 0 && saExamWarnings.length === 4,
    `${saValidation.errorCount}E/${saExamWarnings.length}W`);
  check('the warning tells the user to confirm the summation',
    saExamWarnings.every((i) => /confirm/i.test(i.suggestion ?? '')),
    saExamWarnings[0]?.suggestion?.slice(0, 40));

  /* 2. Written + practical (single examination, merged grouped header). */
  const { students: wpStudents } = await buildStudentsFromWorkbook('testdata_universal_written_practical.xlsx');
  const englishWp = wpStudents[0].subjects.find((s) => s.name === 'English');
  check('written + practical is one subject with two components',
    Boolean(englishWp) && (englishWp!.components?.length ?? 0) === 2,
    englishWp?.components?.map((c) => c.name).join(','));
  check('theory and practical maxima are read',
    JSON.stringify(englishWp?.components?.map((c) => c.maxMarks)) === JSON.stringify([70, 30]),
    englishWp?.components?.map((c) => c.maxMarks).join(','));
  check('written + practical is a single examination (no exam warning)',
    validateStudents(wpStudents).issues.every((i) => i.type !== 'examination_rule_assumed'));

  /* 3. Mixed Devanagari + English headers. */
  const { students: hiStudents } = await buildStudentsFromWorkbook('testdata_universal_hindi_mixed.xlsx');
  const hi = hiStudents[0];
  check('Devanagari roll / name / class headers are mapped',
    hi.rollNo === '1' && hi.name === 'Aarav Sharma' && hi.class === '5',
    `${hi.rollNo}/${hi.name}/${hi.class}`);
  check('mixed Hindi + English subject headers are detected',
    hi.subjects.length === 3 && hi.subjects.some((s) => s.name === 'Science'),
    hi.subjects.map((s) => s.name).join(','));
  check('Hindi attendance header is mapped', String(hi.attendance ?? '').endsWith('%'), String(hi.attendance));

  /* 4. Joy answers from the real workbook, in the visitor's language. */
  const context = { validation: saValidation, students: saStudents };
  const countsLine = explainValidation(context, 'en').split('\n')[0];
  check('Joy counts match the current validation exactly',
    countsLine.includes(`${saValidation.errorCount} error`) &&
      countsLine.includes(`${saValidation.warningCount} warning`),
    countsLine);

  const maxAnswer = explainMaximumMarks({ students: saStudents }, 'en');
  check('Joy reports the real maximum marks', /180/.test(maxAnswer) && /PT \(10\)/.test(maxAnswer),
    maxAnswer.split('\n')[0]);
  const maxHinglish = explainMaximumMarks({ students: saStudents }, 'hinglish');
  check('Joy answers the maximum-marks question in Hinglish',
    maxHinglish !== maxAnswer && /maximum marks/i.test(maxHinglish));

  const totalAnswer = explainGrandTotal(context, 'en');
  check('Joy explains the grand total from real marks',
    totalAnswer.includes('Aarav Sharma') && /obtained \d+ \/ \d+/.test(totalAnswer), totalAnswer.split('\n')[0]);
  check('Joy flags the ambiguous SA1/SA2 contribution in the grand total',
    /SA1/.test(totalAnswer) && /summed/i.test(totalAnswer));

  const examAnswer = explainExaminations(context, 'SA1 aur SA2 dono ka total kaise niklega?', 'hinglish');
  check('Joy explains SA1/SA2 combination in Hinglish',
    /SA1/.test(examAnswer) && /confirm/i.test(examAnswer), examAnswer.split('\n')[0]);

  /* A component the workbook does NOT have must never be invented. */
  const missingAnswer = explainExaminations(
    { students: wpStudents },
    'Why is SA2 missing?',
    'en',
  );
  check('Joy says a missing component is not found, without inventing it',
    /did not find/i.test(missingAnswer) && /SA2/.test(missingAnswer),
    missingAnswer.split('\n')[1] ?? missingAnswer.slice(0, 60));

  /* Intent routing from resolveStudioQuery. */
  check('"Why is SA2 missing?" routes to the examination answer',
    Boolean(resolveStudioQuery('Why is SA2 missing?', 'import', 'en', { students: wpStudents })) &&
      /did not find/i.test(resolveStudioQuery('Why is SA2 missing?', 'import', 'en', { students: wpStudents })!.reply));
  check('"Is Excel mein maximum marks kya hain?" routes to the maximum-marks answer',
    isMaxMarksQuery(normalizeForTest('is excel mein maximum marks kya hain')));
  check('"Why is the grand total incorrect?" routes to the grand-total answer',
    isGrandTotalQuery(normalizeForTest('why is the grand total incorrect')));
  check('"SA1 aur SA2 dono ka total kaise niklega" routes to the examination answer',
    isExaminationQuery(normalizeForTest('sa1 aur sa2 dono ka total kaise niklega')));

  /* Empty context must not invent anything. */
  check('empty context → Joy asks for an import (maximum marks)',
    /import/i.test(explainMaximumMarks({ students: [] }, 'en')));
  check('empty context → Joy asks for an import (examinations)',
    /import/i.test(explainExaminations({ students: [] }, 'SA2', 'en')));
  check('no validation results → Joy asks for an import',
    /validation results yet/i.test(explainValidation({ validation: null, students: [] }, 'en')));
}

/** Minimal header normalisation mirroring the parser's, for intent tests. */
function normalizeForTest(value: string): string {
  return value.toLowerCase().replace(/[^\w\s+.-]/g, ' ').replace(/\s+/g, ' ').trim();
}

/* ───── 10b. Joy reads the live screen state (mapping / photos / runs) ────── */

function testJoyLiveDiagnostics(): void {
  console.log('\n## joy live diagnostics (mapping, photos, generation)');

  /* ---- mapping: a non-academic column mapped as a subject ------------- */
  const misMapped = makeStudent({
    studentId: 'row-701',
    rollNo: '1',
    name: 'Aarav Sharma',
    subjects: [
      { name: 'Maths', marks: 78, maxMarks: 100, status: 'present' as const, hasComponents: false, rawValue: '78' },
      {
        name: "Father's Name",
        marks: null,
        maxMarks: 100,
        status: 'present' as const,
        hasComponents: false,
        rawValue: 'RAMESH KUMAR',
      },
    ],
  });

  const mappingContext = {
    students: [misMapped],
    columnMapping: [
      { columnName: 'Maths', fieldKey: 'subject' as const, subjectName: 'Maths', maxMarks: 100 },
      {
        columnName: "Father's Name",
        fieldKey: 'subject' as const,
        subjectName: "Father's Name",
        maxMarks: 100,
      },
    ],
  };

  const mappingAnswer = explainMapping(mappingContext, 'en');
  check('Joy names the mis-mapped column and its real sample value',
    /Father's Name/.test(mappingAnswer) && /RAMESH KUMAR/.test(mappingAnswer), mappingAnswer.slice(0, 160));
  check('Joy reports that the column holds no marks', /0 of 1 students have a numeric value/.test(mappingAnswer));
  check('Joy names the field the auto-mapper would use', /normally detected as/.test(mappingAnswer));
  check('Joy gives the concrete fix (Column Mapping step)', /Column Mapping/.test(mappingAnswer));
  check('Joy does not flag the real subject column', !/"Maths" is mapped as/.test(mappingAnswer));
  check('Joy answers the mapping question in Hinglish too',
    /Column Mapping/.test(explainMapping(mappingContext, 'hinglish')) &&
      explainMapping(mappingContext, 'hinglish') !== mappingAnswer);
  check('Joy says so when there is no mapping to read',
    /can't see the confirmed column mapping/.test(explainMapping({ students: [misMapped] }, 'en')));

  /* ---- photos: ambiguous + missing + manual --------------------------- */
  const photoStudents = [
    makeStudent({ studentId: 'row-801', rollNo: '1', name: 'Aarav Sharma' }),
    makeStudent({ studentId: 'row-802', rollNo: '2', name: 'Aarav Sharma' }),
    makeStudent({ studentId: 'row-803', rollNo: '13', name: 'EKANJOT' }),
    makeStudent({ studentId: 'row-804', rollNo: '31', name: 'Rohit Kumar' }),
  ];
  const photoMap: PhotoMap = {
    'Aarav Sharma.jpeg': 'data:image/png;base64,CCCC',
    '13_EKANJOT.jpg': 'data:image/png;base64,AAAA',
  };

  const photoAnswer = explainPhotoMatching({ students: photoStudents, photoMap }, 'en');
  check('Joy reports the real photo counts',
    /2 distinct photo\(s\) loaded/.test(photoAnswer) && /1 of 4 student\(s\) will print a photo/.test(photoAnswer),
    photoAnswer.split('\n')[0]);
  check('Joy lists the students whose photo needs review',
    /Needs review \(2\)/.test(photoAnswer) && /Aarav Sharma/.test(photoAnswer));
  check('Joy names the unmatched student', /No photo matched \(1\)/.test(photoAnswer) && /Rohit Kumar/.test(photoAnswer));
  check('Joy offers the manual-correction path for a blank photo',
    /Student photo review/.test(photoAnswer) && /Change photo/.test(photoAnswer));
  check('Joy explains the cause without inventing one',
    /same photo fits more than one child/.test(photoAnswer));

  const manualPhotoAnswer = explainPhotoMatching(
    { students: photoStudents, photoMap, photoOverrides: { 'row-804': 'data:image/png;base64,ZZZZ' } },
    'en',
  );
  check('Joy reports a hand-picked photo', /Set by hand \(1\)/.test(manualPhotoAnswer) && /Rohit Kumar/.test(manualPhotoAnswer));
  check('a manual pick removes that student from the missing list',
    !/No photo matched \(1\)/.test(manualPhotoAnswer));

  const clearedPhotoAnswer = explainPhotoMatching(
    { students: photoStudents, photoMap, photoOverrides: { 'row-803': null } },
    'en',
  );
  check('Joy reports a deliberately cleared photo',
    /Cleared on purpose \(1\)/.test(clearedPhotoAnswer) && /EKANJOT/.test(clearedPhotoAnswer));

  const noZipAnswer = explainPhotoMatching({ students: photoStudents, photoMap: {} }, 'en');
  check('Joy says plainly when no photo ZIP was uploaded',
    /No photo ZIP has been uploaded/.test(noZipAnswer));

  const conflictAnswer = explainPhotoMatching(
    {
      students: photoStudents,
      photoMap,
      photoOverrides: { 'row-803': 'data:image/png;base64,ZZZZ', 'row-804': 'data:image/png;base64,ZZZZ' },
    },
    'en',
  );
  check('Joy warns when one picture was chosen for two students',
    /same picture was chosen by hand for 2 students/.test(conflictAnswer));

  /* ---- generation: a real failed run --------------------------------- */
  const failedRun = {
    total: 3,
    completed: 2,
    failed: 1,
    results: [
      { studentId: 'row-901', rollNo: '1', name: 'Aarav Sharma', rowNumber: 3, success: true, fileName: '1_Aarav_Sharma.pdf' },
      { studentId: 'row-902', rollNo: '2', name: 'Meera Verma', rowNumber: 4, success: true, fileName: '2_Meera_Verma.pdf' },
      {
        studentId: 'row-903',
        rollNo: '3',
        name: 'Rohit Kumar',
        rowNumber: 5,
        success: false,
        error: 'Report card data check failed for "Rohit Kumar" (Roll 3): Roll number 3 is duplicated.',
      },
    ],
    status: 'complete' as const,
  };

  const genAnswer = explainGenerationFailures({ generation: failedRun }, 'en');
  check('Joy reports the real run counts',
    /2 report card\(s\) produced, 1 failed/.test(genAnswer), genAnswer.split('\n')[0]);
  check('Joy quotes the generator\'s own error for the failed student',
    /Rohit Kumar/.test(genAnswer) && /Roll number 3 is duplicated/.test(genAnswer));
  check('Joy points at the data, not at the app', /fix that student/.test(genAnswer));
  check('Joy answers the failure question in Hinglish',
    explainGenerationFailures({ generation: failedRun }, 'hinglish') !== genAnswer);

  const cleanRun = {
    total: 2,
    completed: 2,
    failed: 0,
    results: [
      { studentId: 'row-901', rollNo: '1', name: 'Aarav Sharma', rowNumber: 3, success: true },
      { studentId: 'row-902', rollNo: '2', name: 'Meera Verma', rowNumber: 4, success: true },
    ],
    status: 'complete' as const,
  };
  check('Joy confirms a clean run instead of inventing a failure',
    /Nothing failed/.test(explainGenerationFailures({ generation: cleanRun }, 'en')));
  check('Joy says no run has happened yet when that is the truth',
    /No report generation has run/.test(
      explainGenerationFailures(
        { generation: { total: 0, completed: 0, failed: 0, results: [], status: 'idle' } },
        'en',
      ),
    ));
  check('Joy never fabricates a failure without a generation context',
    /No report generation has run/.test(explainGenerationFailures({}, 'en')));

  /* ---- intent routing -------------------------------------------------- */
  const route = (text: string, context: any) =>
    resolveStudioQuery(text, 'import', 'en', context);

  check('"Marks are mapping wrongly" routes to the mapping answer',
    /Column Mapping/.test(route('Marks are mapping wrongly', mappingContext)?.reply ?? ''));
  check('"Ye warning kyun aa rahi hai?" is not hijacked by the mapping answer',
    !/Column Mapping/.test(route('Ye warning kyun aa rahi hai?', mappingContext)?.reply ?? 'x'));
  check('"Why is my photo blank?" routes to the photo answer',
    /photo review for the current import/i.test(
      route('Why is my photo blank?', { students: photoStudents, photoMap })?.reply ?? '',
    ));
  check('"Generation fail kyun ho gayi?" routes to the generation answer',
    /Rohit Kumar/.test(route('Generation fail kyun ho gayi?', { generation: failedRun })?.reply ?? ''));
  check('"How is one try counted?" is NOT treated as a generation failure',
    !isGenerationFailureQuery(normalizeForTest('how is one try counted'),
      normalizeForTest('how is one try counted').split(' ')));
  check('"How many free tries do I get?" still reaches the FAQ',
    /7 free/.test(route('How many free tries do I get?', { generation: failedRun })?.reply ?? 'x'));
  check('the mapping intent is detected in Hinglish',
    isMappingQuery(normalizeForTest('column galat map ho raha hai'), normalizeForTest('column galat map ho raha hai').split(' ')));
  check('the photo intent is detected',
    isPhotoQuery(normalizeForTest('why is my photo blank'), normalizeForTest('why is my photo blank').split(' ')));
}

/* ─────────────────────────────── run ─────────────────────────────── */

(async () => {
  testPhotoMatching();
  testPhotoZipPlan();
  await testPhotoZipLoading();
  testManualPhotoCorrection();
  testGradingAndTotals();
  testAssessmentAndRemarks();
  testThemes();
  testStudioJoy();
  testAttendanceWarningsAndJoy();
  testSingleCalculationSource();
  await testPdfArtifact();
  testJoyLiveDiagnostics();
  testExaminationClassification();
  await testUniversalWorkbooks();
  testMallNavigationSafety();
  await testGroupedComponentWorkbooks();
  await testRealSchoolMarkSheet();
  await testSyntheticLayout();
  await testLayoutDensity();
  await testThemeIdentity();
  await testTypographyParity();

  const args = process.argv.slice(2);
  const files = args.length
    ? args
    : [
        'testdata_layout_stress.xlsx',
        'testdata_10_students.xlsx',
        'testdata_alt_subjects.xlsx',
        'testdata_complex_structure.xlsx',
        'testdata_sheetname_class.xlsx',
        'testdata_title_class_30.xlsx',
        'testdata_50_students.xlsx',
      ];

  await testWorkbooks(files);

  console.log(`\n=== regression summary: ${passed} passed, ${failed} failed ===`);
  if (failures.length > 0) {
    console.log('failures:');
    for (const failure of failures.slice(0, 40)) console.log('  - ' + failure);
  }
  process.exit(failed > 0 ? 1 : 0);
})().catch((error) => {
  console.error('HARNESS ERROR:', error);
  process.exit(1);
});

/* Renders the real ReportCardPreview component for every student and checks it. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

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
import ReportCardPreview from '../src/components/report/ReportCardPreview';
import { REPORT_CARD_THEMES } from '../src/themes';
import { mmCss, TYPE_MM } from '../src/themes/typography';
import type { SchoolProfile, Student } from '../src/types';

/*
 * Preview half of the preview↔PDF typography parity check.
 *
 * The PDF half lives in regression-test.ts (it reads the font size embedded in
 * the generated PDF). Together they prove both renderers use the same mm value:
 * the preview writes `font-size: <x>mm` and the PDF writes `setFontSize(mmToPt(x))`.
 * A size changed on one side alone fails one of the two checks.
 */
let parityFailures = 0;
function checkTypographyParity(student: Student): void {
  console.log('\n### typography parity (preview side)');
  for (const theme of REPORT_CARD_THEMES) {
    const html = renderToStaticMarkup(
      <ReportCardPreview student={student} school={{ ...SCHOOL, reportTheme: theme.id }} />,
    );
    const wanted: [string, number][] = [
      ['academic table', TYPE_MM.academic],
      ['student info grid', TYPE_MM.info],
      ['remarks', TYPE_MM.remarks],
      ['footer', TYPE_MM.footer],
    ];
    for (const [label, mm] of wanted) {
      const needle = `font-size:${mmCss(mm)}`;
      if (!html.includes(needle)) {
        console.log(`  FAIL [${theme.id}] ${label} does not use the shared size (${needle})`);
        parityFailures++;
      }
    }
  }
  console.log(`  checked ${REPORT_CARD_THEMES.length} themes x 4 shared sizes`);
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

function fileFromPath(p: string) {
  const buf = readFileSync(p);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return { name: basename(p), arrayBuffer: () => Promise.resolve(ab) } as any as File;
}

const SCHOOL: SchoolProfile = {
  schoolName: 'SHAHEED BHAGAT SINGH PUBLIC SCHOOL',
  address: 'Village Jhiwerheri, Yamuna Nagar (Haryana)',
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

async function buildStudents(file: string): Promise<Student[]> {
  const f = fileFromPath(resolve(process.cwd(), file));
  const wbData = await parseWorkbookFromFile(f);
  try {
    const detected = await parseDynamicStructure(f);
    const hasName = detected.studentFields.some((x) => x.fieldType === 'name');
    const hasSubjects = detected.subjectGroups.length > 0;
    if (hasName && hasSubjects) {
      const mappings = convertDetectedStructureToColumnMapping(detected, wbData.headers);
      const sm = createStructureMappingFromDetected(detected);
      return buildStudentsFromDynamicStructure(
        wbData.rows,
        sm.detected,
        sm,
        {
          defaultClass: '',
          defaultSection: '',
          inferredClass: detected.inferredClass,
          inferredSection: detected.inferredSection,
        },
        wbData.headers,
        mappings,
      );
    }
  } catch {
    /* fall through to fallback */
  }
  return buildStudentsFromRows(wbData.rows, autoMapColumns(wbData.headers), {
    defaultClass: '',
    defaultSection: '',
  });
}

async function run(file: string) {
  const students = await buildStudents(file);
  console.log(`\n### ${file}: ${students.length} students`);

  let failures = 0;
  let undefinedCount = 0;
  let markFailures = 0;

  students.forEach((student, idx) => {
    const html = renderToStaticMarkup(
      <ReportCardPreview student={student} school={SCHOOL} />,
    );

    if (html.includes('undefined')) undefinedCount++;
    if (!html.includes(student.name)) {
      console.log(`  FAIL: name missing for ${student.name}`);
      failures++;
    }
    for (const subject of student.subjects) {
      if (!html.includes(subject.name)) {
        console.log(`  FAIL: subject "${subject.name}" missing for ${student.name}`);
        failures++;
      }
      if (
        subject.status === 'present' &&
        subject.marks !== null &&
        !html.includes(`>${subject.marks}<`)
      ) {
        console.log(
          `  FAIL: marks ${subject.marks} of ${subject.name} not rendered for ${student.name}`,
        );
        markFailures++;
      }
    }

    if (idx === 0) {
      mkdirSync('.tmpbuild', { recursive: true });
      writeFileSync(
        `.tmpbuild/preview-${basename(file).replace('.xlsx', '')}.html`,
        `<html><head><script src="https://cdn.tailwindcss.com"></script></head><body style="background:#e2e8f0;padding:20px">${html}</body></html>`,
      );
    }
  });

  console.log(
    `  rendered ${students.length} report cards | name/subject failures=${failures} | mark failures=${markFailures} | cards containing "undefined"=${undefinedCount}`,
  );

  // Show a text snippet of the first card to eyeball structure.
  const sample = renderToStaticMarkup(
    <ReportCardPreview student={students[0]} school={SCHOOL} />,
  );
  const text = sample
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  console.log('  text sample:', text.slice(0, 2400));

  checkTypographyParity(students[0]);
}

(async () => {
  const targets = process.argv.slice(2);
  const files = targets.length
    ? targets
    : [
        'testdata_layout_stress.xlsx',
        'testdata_title_class_30.xlsx',
        'testdata_complex_structure.xlsx',
        'testdata_alt_subjects.xlsx',
        'testdata_sheetname_class.xlsx',
        'testdata_10_students.xlsx',
        'testdata_sbs_components.xlsx',
        'testdata_sbs_components_no_name.xlsx',
        'testdata_unmerged_groups.xlsx',
      ];
  for (const file of files) {
    await run(file);
  }
  if (parityFailures > 0) {
    console.error(`\n✗ typography parity FAILED (${parityFailures} mismatch(es))`);
    process.exit(1);
  }
  console.log('\n✓ typography parity OK — preview and PDF share the same mm sizes.');
})().catch((e) => {
  console.error('RENDER ERROR:', e);
  process.exit(1);
});

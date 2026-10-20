/*
 * Universal-compatibility fixtures (synthetic data only — no real students).
 *
 * Three representative workbooks that exercise patterns the existing fixtures
 * do not cover:
 *
 *   testdata_universal_sa1_sa2.xlsx        grouped, multi-row header with
 *                                          PT / NB / SEA / SA1 / SA2 and NO
 *                                          TOTAL column (separate exams summed)
 *   testdata_universal_written_practical.xlsx
 *                                          Theory (70) + Practical (30), single
 *                                          examination, single-row header
 *   testdata_universal_hindi_mixed.xlsx    mixed Devanagari + English headers
 *                                          (क्रमांक / Student Name / कक्षा /
 *                                          Attendance / गणित / Science / अंग्रेजी)
 */
import * as XLSX from 'xlsx';

const FIRST = ['Aarav', 'Ananya', 'Riya', 'Aryan', 'Ishaan', 'Saanvi', 'Vivaan', 'Diya'];
const LAST = ['Sharma', 'Verma', 'Singh', 'Kumar', 'Gupta', 'Mehta', 'Patel', 'Iyer'];
const CLASSES = ['5', '6', '7', '8'];

let seed = 20261014;
const rand = (min, max) => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return min + Math.floor((seed / 2147483648) * (max - min + 1));
};

const STUDENTS = FIRST.map((first, index) => ({
  name: `${first} ${LAST[index]}`,
  roll: String(index + 1),
  class: CLASSES[index % CLASSES.length],
  father: `MR.${LAST[index]} LAL`,
}));

function write(rows, merges, sheetName, file) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!merges'] = merges;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, file);
  console.log(`Wrote ${file}`);
}

/* ── 1. SA1 + SA2, no TOTAL (separate examinations summed) ───────────────── */
{
  const SUBJECTS = ['English', 'Hindi', 'Maths', 'Science'];
  /* Maxima carried in the header, exactly as schools write them. */
  const COMPONENTS = ['PT (10)', 'NB (5)', 'SEA (5)', 'SA1 (80)', 'SA2 (80)'];
  const MAXES = [10, 5, 5, 80, 80];

  const groupRow = ['Roll No', 'Student Name', 'Class'];
  const componentRow = ['', '', ''];
  for (const subject of SUBJECTS) {
    for (let i = 0; i < COMPONENTS.length; i++) groupRow.push(i === 0 ? subject : '');
    componentRow.push(...COMPONENTS);
  }

  const rows = [new Array(groupRow.length).fill(''), groupRow, componentRow];
  rows[0][0] = 'UNIVERSAL PUBLIC SCHOOL (CLASS-5)';

  for (const student of STUDENTS) {
    const row = [student.roll, student.name, student.class];
    for (const _subject of SUBJECTS) {
      for (const max of MAXES) row.push(rand(Math.ceil(max * 0.6), max));
    }
    rows.push(row);
  }

  const identity = 3;
  const merges = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: rows[1].length - 1 } },
    { s: { r: 1, c: 0 }, e: { r: 2, c: 0 } },
    { s: { r: 1, c: 1 }, e: { r: 2, c: 1 } },
    { s: { r: 1, c: 2 }, e: { r: 2, c: 2 } },
  ];
  SUBJECTS.forEach((_subject, index) => {
    const start = identity + index * COMPONENTS.length;
    merges.push({ s: { r: 1, c: start }, e: { r: 1, c: start + COMPONENTS.length - 1 } });
  });
  write(rows, merges, 'Class-5', 'testdata_universal_sa1_sa2.xlsx');
}

/* ── 2. Written + practical, single examination (merged grouped header) ───── */
{
  const SUBJECTS = ['English', 'Maths', 'Science', 'Computer'];
  const COMPONENTS = ['Theory (70)', 'Practical (30)'];

  const groupRow = ['Roll No', 'Student Name', 'Father Name', 'Class'];
  const componentRow = ['', '', '', ''];
  for (const subject of SUBJECTS) {
    for (let i = 0; i < COMPONENTS.length; i++) groupRow.push(i === 0 ? subject : '');
    componentRow.push(...COMPONENTS);
  }

  const rows = [new Array(groupRow.length).fill(''), groupRow, componentRow];
  rows[0][0] = 'UNIVERSAL PUBLIC SCHOOL (CLASS-6)';

  for (const student of STUDENTS) {
    const row = [student.roll, student.name, student.father, student.class];
    for (const _subject of SUBJECTS) row.push(rand(35, 70), rand(15, 30));
    rows.push(row);
  }

  const identity = 4;
  const merges = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: rows[1].length - 1 } },
    ...Array.from({ length: identity }, (_v, col) => ({ s: { r: 1, c: col }, e: { r: 2, c: col } })),
  ];
  SUBJECTS.forEach((_subject, index) => {
    const start = identity + index * COMPONENTS.length;
    merges.push({ s: { r: 1, c: start }, e: { r: 1, c: start + COMPONENTS.length - 1 } });
  });
  write(rows, merges, 'Class-6', 'testdata_universal_written_practical.xlsx');
}

/* ── 3. Mixed Devanagari + English headers ───────────────────────────────── */
{
  const header = ['क्रमांक', 'Student Name', 'कक्षा', 'Attendance', 'गणित', 'Science', 'अंग्रेजी', 'कुल'];
  const rows = [header];
  for (const student of STUDENTS) {
    const maths = rand(60, 100);
    const science = rand(60, 100);
    const english = rand(60, 100);
    rows.push([student.roll, student.name, student.class, `${rand(80, 99)}%`, maths, science, english, maths + science + english]);
  }
  write(rows, [], 'कक्षा-7', 'testdata_universal_hindi_mixed.xlsx');
}

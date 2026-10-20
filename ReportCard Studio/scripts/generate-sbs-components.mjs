/*
 * Test workbooks for the reported "S.B.S PUBLIC SCHOOL (CLASS-3rd)" mark sheet.
 *
 * Every subject is spread across its own component columns
 * (PT / NB / SEA / SA1 / TOTAL) under a grouped, multi-row header, and a set of
 * standalone columns (MV / GK / DRAW / TOTAL / % / POSITION) follows the
 * subjects. This is the exact shape that used to split "MATHS" into two columns
 * and drop the PT / NB / SEA / SA1 / TOTAL components.
 *
 * Three files are written:
 *   testdata_sbs_components.xlsx          — merged grouped header + Student Name
 *   testdata_sbs_components_no_name.xlsx  — same sheet WITHOUT a plain Name
 *                                           column, so the mapping fallback runs
 *   testdata_unmerged_groups.xlsx         — grouped header with NO merged cells
 *                                           (subject label only on its first
 *                                           component column)
 */
import * as XLSX from 'xlsx';

const TITLE = 'S.B.S PUBLIC SCHOOL (CLASS-3rd)';

const SUBJECTS = ['English', 'Hindi', 'Maths', 'SCI.', 'Sst', 'COMPUTER'];
const COMPONENTS = ['PT', 'NB', 'SEA', 'SA1', 'TOTAL'];
const MAXES = [10, 5, 5, 80];
const STANDALONE = ['MV', 'GK', 'DRAW', 'TOTAL', '%', 'POSITION'];

const FIRST = ['Aarav', 'Ananya', 'Riya', 'Aryan', 'Ishaan', 'Saanvi', 'Vivaan', 'Diya', 'Kabir', 'Myra', 'Arjun', 'Anika'];
const LAST = ['Sharma', 'Verma', 'Singh', 'Kumar', 'Gupta', 'Mehta', 'Patel', 'Iyer', 'Rao', 'Khan', 'Joshi', 'Nair'];
const FATHERS = ['Rajesh', 'Rakesh', 'Amit', 'Suresh', 'Vijay', 'Ajay', 'Ramesh', 'Mukesh', 'Anil', 'Sunil', 'Dinesh', 'Manoj'];

/* Deterministic PRNG so the generated workbooks (and the tests) are stable. */
let seed = 20261012;
const rand = (min, max) => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return min + Math.floor((seed / 2147483648) * (max - min + 1));
};
const grade = () => ['A1', 'A2', 'B1', 'B2', 'C1'][rand(0, 4)];

const STUDENTS = FIRST.map((first, index) => {
  const components = SUBJECTS.map(() => {
    const pt = rand(4, MAXES[0]);
    const nb = rand(2, MAXES[1]);
    const sea = rand(2, MAXES[2]);
    const sa1 = rand(40, MAXES[3]);
    return [pt, nb, sea, sa1, pt + nb + sea + sa1];
  });
  return {
    name: `${first} ${LAST[index]}`,
    father: `MR.${FATHERS[index]} ${LAST[index]}`,
    address: `Village ${LAST[index]} Nagar, Yamuna Nagar`,
    components,
  };
});

function buildData(withStudentName) {
  const identity = withStudentName
    ? ['Fathers Name', 'Address', 'Student Name']
    : ['Fathers Name', 'Address'];

  const groupRow = [...identity];
  const componentRow = new Array(identity.length).fill('');
  for (const subject of SUBJECTS) {
    for (let i = 0; i < COMPONENTS.length; i++) {
      /* Grouped headers usually spell the subject once; other columns are blank. */
      groupRow.push(i === 0 ? subject : '');
    }
    componentRow.push(...COMPONENTS);
  }
  groupRow.push(...STANDALONE);
  componentRow.push(...new Array(STANDALONE.length).fill(''));

  const totalMax = SUBJECTS.length * 100;
  const totals = STUDENTS.map((student) =>
    student.components.reduce((sum, c) => sum + c[4], 0),
  );
  /* Position = rank by grand total (highest first, ties share the better rank). */
  const positions = totals.map(
    (total) => totals.filter((other) => other > total).length + 1,
  );

  const rows = [new Array(groupRow.length).fill(''), groupRow, componentRow];
  rows[0][0] = TITLE;

  STUDENTS.forEach((student, index) => {
    const row = withStudentName
      ? [student.father, student.address, student.name]
      : [student.father, student.address];
    for (const components of student.components) row.push(...components);
    const grandTotal = totals[index];
    row.push(
      grade(),
      grade(),
      grade(),
      grandTotal,
      Math.round((grandTotal / totalMax) * 100),
      positions[index],
    );
    rows.push(row);
  });
  return rows;
}

function writeWorkbook(file, merges, withStudentName) {
  const ws = XLSX.utils.aoa_to_sheet(buildData(withStudentName));
  ws['!merges'] = merges;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Class-3rd');
  XLSX.writeFile(wb, file);
  console.log(`Wrote ${file}`);
}

const identityCount = 3;

/* 1. Merged grouped header, with a Student Name column (dynamic parser path). */
const mergedMerges = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 41 } }];
for (let col = 0; col < identityCount; col++) {
  mergedMerges.push({ s: { r: 1, c: col }, e: { r: 2, c: col } });
}
for (let s = 0; s < SUBJECTS.length; s++) {
  const start = identityCount + s * COMPONENTS.length;
  mergedMerges.push({ s: { r: 1, c: start }, e: { r: 1, c: start + COMPONENTS.length - 1 } });
}
for (let i = 0; i < STANDALONE.length; i++) {
  const col = identityCount + SUBJECTS.length * COMPONENTS.length + i;
  mergedMerges.push({ s: { r: 1, c: col }, e: { r: 2, c: col } });
}
writeWorkbook('testdata_sbs_components.xlsx', mergedMerges, true);

/* 2. Same sheet without a plain "Student Name" column (mapping fallback path). */
writeWorkbook(
  'testdata_sbs_components_no_name.xlsx',
  [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 38 } },
    { s: { r: 1, c: 0 }, e: { r: 2, c: 0 } },
    { s: { r: 1, c: 1 }, e: { r: 2, c: 1 } },
    ...Array.from({ length: SUBJECTS.length }, (_, s) => {
      const start = 2 + s * COMPONENTS.length;
      return { s: { r: 1, c: start }, e: { r: 1, c: start + COMPONENTS.length - 1 } };
    }),
  ],
  false,
);

/* 3. Grouped header with NO merged cells at all. */
writeWorkbook('testdata_unmerged_groups.xlsx', [], true);

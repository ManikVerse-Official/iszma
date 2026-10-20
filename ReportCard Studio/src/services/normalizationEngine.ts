import type {
  ColumnMapping,
  Student,
  SubjectMark,
  SubjectStatus,
  SubjectComponent,
  GradeField,
  OverallFields,
} from '../types';

const ABSENT_VALUES = ['ab', 'absent', 'a'];
const EXEMPT_VALUES = ['ex', 'exempt', 'exmp'];
const MEDICAL_VALUES = ['medical', 'med', 'md'];

export function parseCellValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v).trim();
}

export function parseSubjectCell(v: unknown): {
  status: SubjectStatus;
  marks: number | null;
  rawValue: string;
} {
  const raw = parseCellValue(v);
  if (raw === '') {
    return { status: 'present', marks: null, rawValue: raw };
  }
  const lower = raw.toLowerCase();
  if (ABSENT_VALUES.includes(lower)) {
    return { status: 'absent', marks: null, rawValue: raw };
  }
  if (EXEMPT_VALUES.includes(lower)) {
    return { status: 'exempt', marks: null, rawValue: raw };
  }
  if (MEDICAL_VALUES.includes(lower)) {
    return { status: 'medical', marks: null, rawValue: raw };
  }

  const cleaned = raw.replace(/,/g, '');

  const slashIndex = cleaned.indexOf('/');
  if (slashIndex >= 0) {
    const first = cleaned.slice(0, slashIndex).trim();
    const num = Number(first);
    if (Number.isFinite(num)) {
      return { status: 'present', marks: num, rawValue: raw };
    }
  }

  const directNum = Number(cleaned);
  if (Number.isFinite(directNum)) {
    return { status: 'present', marks: directNum, rawValue: raw };
  }

  const sepRegex = /[\/·•|:\-\s_]+/g;
  const tokens = cleaned
    .split(sepRegex)
    .map((t) => t.trim())
    .filter((t) => t !== '' && !/^[a-zA-Z]+$/.test(t));

  for (const token of tokens) {
    const n = Number(token);
    if (Number.isFinite(n)) {
      return { status: 'present', marks: n, rawValue: raw };
    }
  }

  const numericMatch = cleaned.match(/-?\d+(?:\.\d+)?/);
  if (numericMatch) {
    const n = Number(numericMatch[0]);
    if (Number.isFinite(n)) {
      return { status: 'present', marks: n, rawValue: raw };
    }
  }

  return { status: 'present', marks: null, rawValue: raw };
}

export function parseGradeCell(v: unknown): {
  value: string;
  rawValue: string;
} {
  const raw = parseCellValue(v);
  return {
    value: raw,
    rawValue: raw,
  };
}

function getOriginalRowNumber(
  row: Record<string, unknown>,
  fallback: number,
): number {
  const value = row.__rowNumber;
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : fallback;
}

function getCellByColumn(
  row: Record<string, unknown>,
  col: number | undefined,
  fallbackHeader: string,
): unknown {
  const cells = row.__cells;

  if (
    typeof col === 'number' &&
    Array.isArray(cells) &&
    col >= 0
  ) {
    return cells[col] ?? '';
  }

  return row[fallbackHeader];
}

function getMappedCell(
  row: Record<string, unknown>,
  mapping: ColumnMapping,
): unknown {
  return getCellByColumn(
    row,
    mapping.excelColumn,
    mapping.columnName,
  );
}

function normalizeCellForComparison(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function isHeaderLikeStudentValue(value: string): boolean {
  const normalized = normalizeCellForComparison(value);

  return [
    'name',
    'student',
    'studentname',
    'studentsname',
    'nameofstudent',
    'roll',
    'rollno',
    'rollnumber',
    'srno',
    'sno',
    'serialno',
    'total',
    'grandtotal',
    'subtotal',
    'percentage',
    'percent',
    'average',
    'result',
    'signature',
  ].includes(normalized);
}

function isTotalLikeHeader(text: string): boolean {
  const normalized = normalizeCellForComparison(text);

  return (
    normalized === 'total' ||
    normalized === 'subtotal' ||
    normalized === 'grandtotal' ||
    normalized === 'overalltotal' ||
    normalized.endsWith('total')
  );
}

function deriveComponentName(header: string, subjectName: string): string {
  const parts = String(header ?? '')
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length <= 1) return parts[0] ?? String(header ?? '');

  const rest = parts.filter(
    (part) =>
      normalizeCellForComparison(part) !==
      normalizeCellForComparison(subjectName),
  );

  return rest.length ? rest[rest.length - 1] : parts[parts.length - 1];
}

/**
 * A row is a valid student row when it has a name or an identifier.
 * Optional fields (roll no, father name, DOB, address, ...) may be blank.
 *
 * This intentionally never drops a row just because roll no is empty.
 */
function isPlausibleStudentRow(
  row: Record<string, unknown>,
  detected: any,
  existingHeaders: string[],
  nameColOverride?: number,
  rollColOverride?: number,
): boolean {
  const studentFields = detected?.studentFields ?? [];

  const nameCol =
    nameColOverride ??
    studentFields.find((field: any) => field.fieldType === 'name')
      ?.excelColumn;
  const rollCol =
    rollColOverride ??
    studentFields.find((field: any) => field.fieldType === 'rollNo')
      ?.excelColumn;

  const readCell = (col?: number): string => {
    if (typeof col !== 'number' || col < 0) return '';
    return parseCellValue(
      getCellByColumn(
        row,
        col,
        existingHeaders[col] || `Column_${col + 1}`,
      ),
    );
  };

  const name = readCell(nameCol);
  const roll = readCell(rollCol);

  /* No identity information at all → not a student row. */
  if (!name && !roll) return false;

  if (
    (name && isHeaderLikeStudentValue(name)) ||
    (roll && isHeaderLikeStudentValue(roll))
  ) {
    return false;
  }

  return true;
}

function sumPresentMarks(components: SubjectComponent[]): number | null {
  let sum = 0;
  let found = false;

  for (const component of components) {
    if (
      component.status === 'present' &&
      typeof component.marks === 'number' &&
      Number.isFinite(component.marks)
    ) {
      sum += component.marks;
      found = true;
    }
  }

  return found ? sum : null;
}

function lastNumericMarks(
  components: SubjectComponent[],
): number | null {
  for (let i = components.length - 1; i >= 0; i--) {
    const component = components[i];
    if (
      typeof component.marks === 'number' &&
      Number.isFinite(component.marks)
    ) {
      return component.marks;
    }
  }

  return null;
}

function resolveSubjectMaxMarks(
  subjectGroup: any,
  components: SubjectComponent[],
  authoritativeTotalMaxMarks?: number,
): number {
  if (
    typeof authoritativeTotalMaxMarks === 'number' &&
    Number.isFinite(authoritativeTotalMaxMarks) &&
    authoritativeTotalMaxMarks > 0
  ) {
    return authoritativeTotalMaxMarks;
  }

  const totalComponent = subjectGroup?.components?.find(
    (component: any) => component.isTotal,
  );

  if (
    totalComponent &&
    typeof totalComponent.maxMarks === 'number' &&
    Number.isFinite(totalComponent.maxMarks)
  ) {
    return totalComponent.maxMarks;
  }

  const explicitComponentMax = (subjectGroup?.components ?? [])
    .filter((component: any) => !component.isTotal)
    .reduce((sum: number, component: any) => {
      return typeof component.maxMarks === 'number' &&
        Number.isFinite(component.maxMarks)
        ? sum + component.maxMarks
        : sum;
    }, 0);

  if (subjectGroup?.hasTotal || totalComponent) {
    return explicitComponentMax > 0 ? explicitComponentMax : 100;
  }

  if (explicitComponentMax > 0) {
    return explicitComponentMax;
  }

  /*
   * Never blindly sum component default maxes (that would produce 200/300/...
   * for a subject that actually has a 100-mark scale). Fall back to 100 and
   * let the user override it in the Subjects tab.
   */
  return 100;
}

/**
 * Attendance may be supplied as a percentage, or derived from working days and
 * days present. Returns a display string ("91%") or undefined.
 */
function resolveAttendance(
  fields: Record<string, string>,
  overallAttendance?: string,
): string | undefined {
  if (overallAttendance && String(overallAttendance).trim()) {
    return overallAttendance;
  }
  if (fields.attendance && String(fields.attendance).trim()) {
    return fields.attendance;
  }

  const toNumber = (value?: string): number => {
    const match = String(value ?? '').replace(/,/g, '').match(/\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : NaN;
  };

  const present = toNumber(fields.daysPresent);
  const working = toNumber(fields.workingDays);

  if (Number.isFinite(present) && Number.isFinite(working) && working > 0) {
    const pct = Math.round((present / working) * 1000) / 10;
    return `${pct}%`;
  }

  return undefined;
}

function mapDetectedFieldToStudentField(fieldType: string): string {
  const mapping: Record<string, string> = {
    photo: 'photoFilename',
    remarks: 'teacherRemarks',
  };

  return mapping[fieldType] ?? fieldType;
}

export function buildStudentsFromRows(
  rows: Record<string, unknown>[],
  mapping: ColumnMapping[],
  defaults: {
    defaultClass: string;
    defaultSection: string;
    inferredClass?: string;
    inferredSection?: string;
  },
): Student[] {
  const subjectMappings = mapping.filter((m) => m.fieldKey === 'subject');
  const gradeFieldMappings = mapping.filter((m) => m.fieldKey === 'gradeField');
  const overallFieldMappings = mapping.filter((m) => m.fieldKey === 'overallField');

  return rows.map((row, idx) => {
    const rowNumber = getOriginalRowNumber(row, idx + 2);
    const studentId = `row-${rowNumber}`;

    const fields: Record<string, string> = {};
    for (const m of mapping) {
      if (m.fieldKey === 'subject' || m.fieldKey === 'gradeField' || m.fieldKey === 'overallField' || m.fieldKey === 'ignore') continue;
      fields[m.fieldKey] = parseCellValue(getMappedCell(row, m));
    }

    /*
     * Subject columns are grouped by their subject name so PT / NB / SEA / SA1 /
     * TOTAL stay components of ONE subject instead of becoming five copies of
     * "English". Each component is read from its own Excel column index, so a
     * component can never be attached to the wrong subject.
     */
    const groupedSubjects = new Map<
      string,
      { name: string; entries: { mapping: ColumnMapping; index: number }[] }
    >();

    subjectMappings.forEach((m, index) => {
      const rawName = (m.subjectName || m.columnName || '').trim();
      if (!rawName) return;

      const normalized = rawName.toLowerCase();
      const group = groupedSubjects.get(normalized) ?? { name: rawName, entries: [] };
      group.entries.push({ mapping: m, index });
      groupedSubjects.set(normalized, group);
    });

    const subjects: SubjectMark[] = [...groupedSubjects.values()].map((group) => {
      const components: SubjectComponent[] = group.entries.map(({ mapping }) => {
        const parsed = parseSubjectCell(getMappedCell(row, mapping));
        const header = String(mapping.columnName ?? '');
        const componentName =
          mapping.componentName ||
          deriveComponentName(header, group.name) ||
          group.name;

        return {
          name: componentName,
          marks: parsed.marks,
          maxMarks: mapping.maxMarks ?? 100,
          status: parsed.status,
          rawValue: parsed.rawValue,
          isTotal:
            isTotalLikeHeader(componentName) ||
            isTotalLikeHeader(header),
        };
      });

      /* A single-column subject keeps the plain subject value. */
      if (components.length === 1) {
        return {
          name: group.name,
          marks: components[0].marks,
          maxMarks: components[0].maxMarks ?? 100,
          status: components[0].status,
          rawValue: components[0].rawValue,
          hasComponents: false,
        };
      }

      const totalComponent = components.find((component) => component.isTotal);
      const marks = totalComponent
        ? totalComponent.marks
        : sumPresentMarks(components) ?? lastNumericMarks(components);
      const status = totalComponent
        ? totalComponent.status
        : components.find((component) => component.status !== 'present')?.status ?? 'present';
      const maxMarks = totalComponent?.maxMarks || 100;

      return {
        name: group.name,
        marks,
        maxMarks,
        status,
        hasComponents: true,
        components,
      };
    });

    // Extract grade fields (new gradeField type)
    const gradeFields: GradeField[] = gradeFieldMappings.map((m) => {
      const parsed = parseGradeCell(getMappedCell(row, m));
      return {
        name: m.subjectName || m.columnName,
        value: parsed.value,
        rawValue: parsed.rawValue,
      };
    });

    // Extract overall fields (new overallField type)
    const overall: OverallFields = {};
    for (const m of overallFieldMappings) {
      const raw = getMappedCell(row, m);
      if (m.overallFieldType === 'total') {
        const parsed = parseSubjectCell(raw);
        if (parsed.marks !== null) overall.total = parsed.marks;
      } else if (m.overallFieldType === 'percentage') {
        const parsed = parseSubjectCell(raw);
        if (parsed.marks !== null) overall.percentage = parsed.marks;
      } else if (m.overallFieldType === 'position') {
        const value = parseCellValue(raw);
        if (value) overall.position = value;
      } else if (m.overallFieldType === 'attendance') {
        const value = parseCellValue(raw);
        if (value) overall.attendance = value;
      } else if (m.overallFieldType === 'remarks') {
        const value = parseCellValue(raw);
        if (value) overall.remarks = value;
      }
    }

    // Also check for student field mappings for attendance/remarks
    if (fields.attendance) {
      overall.attendance = fields.attendance;
    }
    if (fields.teacherRemarks) {
      overall.remarks = fields.teacherRemarks;
    }

    const cls =
      fields.class || defaults.defaultClass || defaults.inferredClass || '';
    const sec =
      fields.section || defaults.defaultSection || defaults.inferredSection || '';

    return {
      studentId,
      rowNumber,
      rollNo: fields.rollNo || String(idx + 1),
      admissionNo: fields.admissionNo || undefined,
      class: cls || undefined,
      section: sec || undefined,
      name: fields.name,
      fatherName: fields.fatherName || undefined,
      motherName: fields.motherName || undefined,
      dob: fields.dob || undefined,
      address: fields.address || undefined,
      attendance: resolveAttendance(fields, overall.attendance),
      workingDays: fields.workingDays || undefined,
      daysPresent: fields.daysPresent || undefined,
      photoFilename: fields.photoFilename || undefined,
      subjects,
      gradeFields: gradeFields.length > 0 ? gradeFields : undefined,
      overall: Object.keys(overall).length > 0 ? overall : undefined,
      teacherRemarks: fields.teacherRemarks || undefined,
      principalRemarks: fields.principalRemarks || undefined,
      rawRow: row,
    };
  });
}

/**
 * Build students from the detected dynamic structure.
 *
 * IMPORTANT: `columnMappings` is the authoritative source of truth. It is what
 * the user edits in the Mapping/Subjects tabs, so any user override (rename,
 * max marks, ignore, re-map) MUST be reflected here. The detected structure is
 * used for grouping and as a fallback when no authoritative mapping exists.
 *
 * Every column is addressed by its exact Excel index — never by header text —
 * so duplicate headers remain distinct.
 */
export function buildStudentsFromDynamicStructure(
  rows: Record<string, unknown>[],
  detectedStructure: any,
  structureMapping: any,
  defaults: {
    defaultClass: string;
    defaultSection: string;
    inferredClass?: string;
    inferredSection?: string;
  },
  existingHeaders: string[],
  columnMappings: ColumnMapping[] = [],
): Student[] {
  const detected = structureMapping?.detected ?? detectedStructure ?? {};
  const hasAuthoritative = columnMappings.length > 0;

  const byCol = new Map<number, ColumnMapping>();
  columnMappings.forEach((mapping, index) => {
    const col = mapping.excelColumn ?? index;
    byCol.set(col, mapping);
  });

  const authAt = (col: number): ColumnMapping | undefined =>
    byCol.get(col);

  const headerAt = (col: number): string =>
    existingHeaders[col] ?? `Column_${col + 1}`;

  const dataStartRowNumber =
    typeof detected.dataStartRow === 'number'
      ? detected.dataStartRow + 1
      : 1;

  /* Effective name/roll columns (authoritative mapping first). */
  const resolveColumn = (fieldKey: string): number | undefined => {
    const fromMapping = columnMappings.find(
      (m) => m.fieldKey === fieldKey,
    );
    if (fromMapping && typeof fromMapping.excelColumn === 'number') {
      return fromMapping.excelColumn;
    }
    const fromDetected = detected.studentFields?.find(
      (field: any) => field.fieldType === fieldKey,
    );
    return fromDetected?.excelColumn;
  };

  const nameCol = resolveColumn('name');
  const rollCol = resolveColumn('rollNo');

  return rows
    .filter((row) => {
      const rowNumber = getOriginalRowNumber(row, 0);

      if (rowNumber && rowNumber < dataStartRowNumber) {
        return false;
      }

      return isPlausibleStudentRow(
        row,
        detected,
        existingHeaders,
        nameCol,
        rollCol,
      );
    })
    .map((row, idx) => {
      const rowNumber = getOriginalRowNumber(row, idx + 2);
      const studentId = `row-${rowNumber}`;

      /* ---------------------------------------------------------------- */
      /* 1. STUDENT IDENTITY FIELDS                                        */
      /* ---------------------------------------------------------------- */
      const fields: Record<string, string> = {};

      for (const mapping of columnMappings) {
        const key = mapping.fieldKey;
        if (
          !key ||
          key === 'subject' ||
          key === 'gradeField' ||
          key === 'overallField' ||
          key === 'ignore'
        ) {
          continue;
        }
        const col = mapping.excelColumn;
        if (typeof col !== 'number' || col < 0) continue;
        fields[key] = parseCellValue(
          getCellByColumn(row, col, headerAt(col)),
        );
      }

      /*
       * Fallback for columns the parser detected but that have no
       * authoritative mapping (for example when the mapping list is empty).
       * A column that IS present in columnMappings is never overridden here, so
       * a user who mapped it to "ignore" keeps it ignored.
       */
      if (Array.isArray(detected.studentFields)) {
        for (const field of detected.studentFields) {
          const col = field.excelColumn;
          const fieldType = field.fieldType;
          if (
            !Number.isInteger(col) ||
            col < 0 ||
            !fieldType ||
            fieldType === 'ignore' ||
            fieldType === 'total' ||
            fieldType === 'percentage' ||
            fieldType === 'position'
          ) {
            continue;
          }
          const key = mapDetectedFieldToStudentField(fieldType);
          if (hasAuthoritative && byCol.has(col)) continue;
          if (fields[key] && String(fields[key]).trim() !== '') continue;
          fields[key] = parseCellValue(
            getCellByColumn(row, col, headerAt(col)),
          );
        }
      }

      /* ---------------------------------------------------------------- */
      /* 2. SUBJECT GROUPS                                                 */
      /* ---------------------------------------------------------------- */
      const subjects: SubjectMark[] = [];
      const coveredCols = new Set<number>();

      const buildSubject = (
        groupName: string,
        components: SubjectComponent[],
        group: any,
        options?: { totalCol?: number; explicitMax?: number },
      ): void => {
        const totalComponent = components.find((c) => c.isTotal);
        const numericTotal =
          totalComponent &&
          totalComponent.status === 'present' &&
          typeof totalComponent.marks === 'number'
            ? totalComponent.marks
            : null;

        let finalMarks: number | null;
        if (totalComponent) {
          finalMarks =
            totalComponent.status === 'present'
              ? numericTotal ?? sumPresentMarks(components)
              : null;
        } else {
          finalMarks = sumPresentMarks(components) ?? lastNumericMarks(components);
        }

        let status: SubjectStatus;
        if (totalComponent) {
          status = totalComponent.status;
        } else {
          const nonPresent = components.find((c) => c.status !== 'present');
          status = nonPresent ? nonPresent.status : 'present';
        }

        const totalCol = options?.totalCol;
        const authMax =
          typeof totalCol === 'number' ? authAt(totalCol)?.maxMarks : undefined;

        const explicitMax = options?.explicitMax;

        const finalMaxMarks =
          typeof explicitMax === 'number' &&
          Number.isFinite(explicitMax) &&
          explicitMax > 0
            ? explicitMax
            : typeof authMax === 'number' &&
                Number.isFinite(authMax) &&
                authMax > 0
              ? authMax
              : resolveSubjectMaxMarks(group, components, undefined);

        const hasComponents = components.length > 1;

        subjects.push({
          name: groupName,
          marks: finalMarks,
          maxMarks: finalMaxMarks,
          status,
          rawValue:
            finalMarks !== null && finalMarks !== undefined
              ? String(finalMarks)
              : undefined,
          hasComponents,
          components: hasComponents ? components : undefined,
        });
      };

      for (const group of detected.subjectGroups ?? []) {
        const groupComponents = group.components ?? [];

        /* Skip columns the user explicitly turned off / re-mapped. */
        const activeComponents = groupComponents.filter((component: any) => {
          if (!hasAuthoritative) return true;
          const auth = authAt(component.col);
          return !!auth && auth.fieldKey === 'subject';
        });

        if (activeComponents.length === 0) continue;

        /* Authoritative subject name (falls back to the detected group name). */
        const authName = activeComponents
          .map((component: any) => authAt(component.col)?.subjectName)
          .find((name: string | undefined) => name && name.trim());
        const groupName = (authName || group.name || '').trim() || group.name;

        const components: SubjectComponent[] = activeComponents.map(
          (component: any) => {
            const auth = authAt(component.col);
            const parsed = parseSubjectCell(
              getCellByColumn(row, component.col, headerAt(component.col)),
            );

            coveredCols.add(component.col);

            return {
              name: component.name,
              marks: parsed.marks,
              maxMarks: auth?.maxMarks ?? component.maxMarks ?? 100,
              status: parsed.status,
              rawValue: parsed.rawValue,
              isTotal: !!component.isTotal,
            };
          },
        );

        const totalCol = activeComponents.find(
          (component: any) => component.isTotal,
        )?.col;

        buildSubject(groupName, components, group, { totalCol });
      }

      /*
       * Standalone subject columns: columns the user (or parser) mapped to
       * "subject" that are not part of any detected group. This keeps manual
       * mapping changes effective.
       */
      const standalone = new Map<string, ColumnMapping[]>();
      for (const mapping of columnMappings) {
        if (mapping.fieldKey !== 'subject') continue;
        const col = mapping.excelColumn;
        if (typeof col !== 'number' || col < 0) continue;
        if (coveredCols.has(col)) continue;
        const name = (mapping.subjectName || mapping.columnName).trim();
        if (!name) continue;
        const list = standalone.get(name) ?? [];
        list.push(mapping);
        standalone.set(name, list);
      }

      for (const [name, mappingsForName] of standalone) {
        const components: SubjectComponent[] = mappingsForName.map((mapping) => {
          const col = mapping.excelColumn as number;
          const header = headerAt(col);
          const parsed = parseSubjectCell(
            getCellByColumn(row, col, header),
          );
          coveredCols.add(col);
          return {
            name: deriveComponentName(header, name),
            marks: parsed.marks,
            maxMarks: mapping.maxMarks ?? 100,
            status: parsed.status,
            rawValue: parsed.rawValue,
            isTotal: isTotalLikeHeader(header),
          };
        });

        const existing = subjects.find((s) => s.name === name);
        if (existing) {
          const merged = [...(existing.components ?? []), ...components];
          existing.components = merged;
          existing.hasComponents = merged.length > 1;
          const totalComponent = merged.find((c) => c.isTotal);
          existing.marks = totalComponent
            ? totalComponent.marks
            : sumPresentMarks(merged) ?? lastNumericMarks(merged);
          existing.status = totalComponent
            ? totalComponent.status
            : (merged.find((c) => c.status !== 'present')?.status ?? 'present');
        } else {
          const totalIdx = components.findIndex((c) => c.isTotal);
          const totalCol =
            totalIdx >= 0
              ? mappingsForName[totalIdx]?.excelColumn
              : undefined;
          const explicitMax =
            (totalIdx >= 0
              ? mappingsForName[totalIdx]?.maxMarks
              : undefined) ?? mappingsForName[0]?.maxMarks;

          buildSubject(
            name,
            components,
            { components, hasTotal: false },
            { totalCol, explicitMax },
          );
        }
      }

      /* ---------------------------------------------------------------- */
      /* 3. GRADE / CO-SCHOLASTIC FIELDS                                   */
      /* ---------------------------------------------------------------- */
      const gradeFields: GradeField[] = [];
      const gradeCovered = new Set<number>();

      for (const gradeField of detected.gradeFields ?? []) {
        const auth = authAt(gradeField.col);
        if (hasAuthoritative) {
          if (!auth || auth.fieldKey !== 'gradeField') continue;
        }
        gradeCovered.add(gradeField.col);
        const parsed = parseGradeCell(
          getCellByColumn(row, gradeField.col, headerAt(gradeField.col)),
        );
        gradeFields.push({
          name: auth?.subjectName || gradeField.name,
          value: parsed.value,
          rawValue: parsed.rawValue,
        });
      }

      for (const mapping of columnMappings) {
        if (mapping.fieldKey !== 'gradeField') continue;
        const col = mapping.excelColumn;
        if (typeof col !== 'number' || col < 0 || gradeCovered.has(col)) {
          continue;
        }
        gradeCovered.add(col);
        const parsed = parseGradeCell(
          getCellByColumn(row, col, headerAt(col)),
        );
        gradeFields.push({
          name: mapping.subjectName || mapping.columnName,
          value: parsed.value,
          rawValue: parsed.rawValue,
        });
      }

      /* ---------------------------------------------------------------- */
      /* 4. OVERALL FIELDS (kept separate from subjects)                   */
      /* ---------------------------------------------------------------- */
      const overall: OverallFields = {};

      const recordOverall = (
        fieldType: string | undefined,
        value: unknown,
      ): void => {
        if (!fieldType) return;
        if (fieldType === 'total') {
          const parsed = parseSubjectCell(value);
          if (parsed.marks !== null) overall.total = parsed.marks;
        } else if (fieldType === 'percentage') {
          const parsed = parseSubjectCell(value);
          if (parsed.marks !== null) overall.percentage = parsed.marks;
        } else if (fieldType === 'position') {
          const text = parseCellValue(value);
          if (text) overall.position = text;
        } else if (fieldType === 'attendance') {
          const text = parseCellValue(value);
          if (text) overall.attendance = text;
        } else if (fieldType === 'remarks') {
          const text = parseCellValue(value);
          if (text) overall.remarks = text;
        }
      };

      for (const overallField of detected.overallFields ?? []) {
        const auth = authAt(overallField.col);
        if (hasAuthoritative) {
          if (!auth || auth.fieldKey !== 'overallField') continue;
        }
        recordOverall(
          auth?.overallFieldType ?? overallField.fieldType,
          getCellByColumn(row, overallField.col, headerAt(overallField.col)),
        );
      }

      for (const mapping of columnMappings) {
        if (mapping.fieldKey !== 'overallField') continue;
        const col = mapping.excelColumn;
        if (typeof col !== 'number' || col < 0) continue;
        recordOverall(
          mapping.overallFieldType,
          getCellByColumn(row, col, headerAt(col)),
        );
      }

      const cls =
        fields.class || defaults.defaultClass || defaults.inferredClass || '';
      const sec =
        fields.section || defaults.defaultSection || defaults.inferredSection || '';

      return {
        studentId,
        rowNumber,
        rollNo: fields.rollNo || String(idx + 1),
        admissionNo: fields.admissionNo || undefined,
        class: cls || undefined,
        section: sec || undefined,
        name: fields.name,
        fatherName: fields.fatherName || undefined,
        motherName: fields.motherName || undefined,
        dob: fields.dob || undefined,
        address: fields.address || undefined,
        attendance: resolveAttendance(fields, overall.attendance),
        workingDays: fields.workingDays || undefined,
        daysPresent: fields.daysPresent || undefined,
        photoFilename: fields.photoFilename || undefined,
        subjects,
        gradeFields: gradeFields.length > 0 ? gradeFields : undefined,
        overall: Object.keys(overall).length > 0 ? overall : undefined,
        teacherRemarks:
          overall.remarks || fields.teacherRemarks || undefined,
        principalRemarks: fields.principalRemarks || undefined,
        rawRow: row,
      };
    });
}

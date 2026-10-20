import { useMemo, useRef, useState, ChangeEvent } from 'react';
import {
  Upload,
  FileSpreadsheet,
  Check,
  AlertTriangle,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Plus,
  X,
  Image as ImageIcon,
  Package,
  RefreshCw,
} from 'lucide-react';
import clsx from 'clsx';

import { useAppStore } from '../store/appStore';

import {
  parseWorkbookFromFile,
  parseSheetFromFileByName,
} from '../services/excelParser';

import {
  autoMapColumns,
  getCoreFieldOptions,
  summarizeMappings,
} from '../services/mappingEngine';

import {
  buildStudentsFromRows,
  buildStudentsFromDynamicStructure,
} from '../services/normalizationEngine';

import { validateStudents } from '../services/validationEngine';
import {
  detectImageFormat,
  fileToDataUrl,
  loadPhotoZipDetailed,
  MAX_IMAGE_BYTES,
} from '../services/photoMatcher';
import {
  photoStatusLabel,
  resolvePhotosWithOverrides,
  type PhotoOverrides,
  type PhotoStatus,
} from '../services/photoOverrides';
import { computeTotals } from '../services/calculationEngine';

import { parseDynamicStructure } from '../services/dynamicExcelParser';

import {
  convertDetectedStructureToColumnMapping,
  createStructureMappingFromDetected,
  summarizeDetectedStructure,
} from '../services/dynamicMappingEngine';

import type { ColumnMapping, DetectedStructure, FieldKey, Student } from '../types';

type Tab = 'upload' | 'mapping' | 'subjects' | 'photos' | 'preview';

/**
 * Read a cell for a mapping using the exact Excel column index first.
 *
 * The `__cells` array preserves duplicate headers, so it must be preferred
 * over the header-keyed object (which collapses duplicate column names).
 */
function getRowCell(
  row: Record<string, unknown> | undefined,
  mapping: ColumnMapping,
): string {
  if (!row) return '';

  const cells = (row as { __cells?: unknown[] }).__cells;
  const col = mapping.excelColumn;

  if (typeof col === 'number' && Array.isArray(cells)) {
    const value = cells[col];
    return value === null || value === undefined ? '' : String(value);
  }

  const value = row[mapping.columnName];
  return value === null || value === undefined ? '' : String(value);
}

export default function ImportStudents() {
  const workbook = useAppStore((s) => s.workbook);
  const setWorkbook = useAppStore((s) => s.setWorkbook);
  const setActiveSheet = useAppStore((s) => s.setActiveSheet);

  const columnMapping = useAppStore((s) => s.columnMapping);
  const setColumnMapping = useAppStore((s) => s.setColumnMapping);

  const setStudents = useAppStore((s) => s.setStudents);
  const setValidation = useAppStore((s) => s.setValidation);

  const validation = useAppStore((s) => s.validation);
  const students = useAppStore((s) => s.students);

  const defaultClass = useAppStore((s) => s.defaultClass);
  const defaultSection = useAppStore((s) => s.defaultSection);

  const setDefaultClass = useAppStore((s) => s.setDefaultClass);
  const setDefaultSection = useAppStore((s) => s.setDefaultSection);

  const photoMap = useAppStore((s) => s.photoMap);
  const setPhotoMap = useAppStore((s) => s.setPhotoMap);
  const photoOverrides = useAppStore((s) => s.photoOverrides);
  const setPhotoOverride = useAppStore((s) => s.setPhotoOverride);
  const resetPhotoOverride = useAppStore((s) => s.resetPhotoOverride);
  const clearPhotoOverrides = useAppStore((s) => s.clearPhotoOverrides);

  const resetWorkflow = useAppStore((s) => s.resetWorkflow);

  const schoolProfile = useAppStore((s) => s.schoolProfile);
  const setSchoolProfile = useAppStore((s) => s.setSchoolProfile);

  const setDetectedStructure = useAppStore(
    (s) => s.setDetectedStructure,
  );

  const setStructureMapping = useAppStore(
    (s) => s.setStructureMapping,
  );

  const structureMapping = useAppStore(
    (s) => s.structureMapping,
  );

  const detectedStructure = useAppStore(
    (s) => s.detectedStructure,
  );

  const [tab, setTab] = useState<Tab>('upload');
  const [fileError, setFileError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [photoLoading, setPhotoLoading] = useState(false);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoNotice, setPhotoNotice] = useState<string | null>(null);
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [dynamicParserFailed, setDynamicParserFailed] =
    useState<boolean>(false);
  /** School name that was read from the workbook title (fallback only). */
  const [detectedSchoolName, setDetectedSchoolName] =
    useState<string | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);
  const photoRef = useRef<HTMLInputElement>(null);

  const tabs: { id: Tab; label: string; desc: string }[] = [
    {
      id: 'upload',
      label: '1. Upload Excel',
      desc: 'Drop your file',
    },
    {
      id: 'mapping',
      label: '2. Column Mapping',
      desc: 'Map fields',
    },
    {
      id: 'subjects',
      label: '3. Subject Config',
      desc: 'Names & max marks',
    },
    {
      id: 'photos',
      label: '4. Photos (Optional)',
      desc: 'Match from ZIP',
    },
    {
      id: 'preview',
      label: '5. Preview & Validate',
      desc: 'Check & confirm',
    },
  ];

  /*
   * IMPORTANT:
   * Every PT/NB/SEA/SA/SA2/TOTAL column can still be present
   * in columnMapping, but subjectCount is based on unique
   * subject-group names.
   */
  const summary = useMemo(() => {
    const base = summarizeMappings(columnMapping);

    const uniqueSubjects = new Set(
      columnMapping
        .filter((m) => m.fieldKey === 'subject')
        .map((m) => (m.subjectName || m.columnName).trim())
        .filter(Boolean),
    );

    return {
      ...base,
      subjectCount: uniqueSubjects.size,
    };
  }, [columnMapping]);

  /**
   * Apply class/section/school context inferred from the workbook title or
   * sheet name. Nothing school-specific is hard-coded and user-entered values
   * always win.
   */
  const applyInferredContext = (detected: DetectedStructure) => {
    /*
     * The workbook's own class/section context is authoritative when present
     * (there may be no Class column at all). Manual defaults are only used when
     * nothing can be inferred.
     */
    if (detected.inferredClass) {
      setDefaultClass(detected.inferredClass);
    }
    if (detected.inferredSection) {
      setDefaultSection(detected.inferredSection);
    }
    /*
     * School name priority: the School Profile always wins. The workbook title
     * is only used as a fallback, and only when the profile is still empty.
     */
    if (detected.schoolName && !schoolProfile.schoolName.trim()) {
      setSchoolProfile({ schoolName: detected.schoolName });
      setDetectedSchoolName(detected.schoolName);
    }
  };

  const handleFile = async (file: File) => {
    setSourceFile(file);
    setFileError(null);
    setLoading(true);
    setDynamicParserFailed(false);

    try {
      const wb = await parseWorkbookFromFile(file);

      try {
        const detectedStructure = await parseDynamicStructure(file);

        setDetectedStructure(detectedStructure);

        applyInferredContext(detectedStructure);

        const hasName = detectedStructure.studentFields.some(
          (f) => f.fieldType === 'name',
        );

        const hasSubjects =
          detectedStructure.subjectGroups.length > 0;

        if (!hasName || !hasSubjects) {
          console.warn(
            'Dynamic structure detection low confidence: using fallback.',
          );

          setDynamicParserFailed(true);
          setStructureMapping(null);
          setWorkbook(wb);
          setColumnMapping(autoMapColumns(wb.headers));
        } else {
          const mappings =
            convertDetectedStructureToColumnMapping(
              detectedStructure,
              wb.headers,
            );

          const structureMappingData =
            createStructureMappingFromDetected(
              detectedStructure,
            );

          setWorkbook(wb);
          setColumnMapping(mappings);
          setStructureMapping(structureMappingData);
          setDynamicParserFailed(false);

          console.log(
            'Detected structure:',
            summarizeDetectedStructure(
              detectedStructure,
            ),
          );
        }
      } catch (dynamicError) {
        console.warn(
          'Dynamic structure detection failed, using fallback:',
          dynamicError,
        );

        setDynamicParserFailed(true);
        setDetectedStructure(null);
        setStructureMapping(null);
        setWorkbook(wb);
        setColumnMapping(autoMapColumns(wb.headers));
      }

      setPhotoMap({});
      setPhotoFile(null);
      setTab('mapping');
    } catch (e) {
      setFileError(
        (e as Error).message ||
          'Failed to parse Excel file',
      );
    } finally {
      setLoading(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();

    const file = e.dataTransfer.files?.[0];

    if (file) {
      handleFile(file);
    }
  };

  const handleFileChange = (
    e: ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];

    if (file) {
      handleFile(file);
    }
  };

  const handleSwitchSheet = async (name: string) => {
    if (!workbook || !sourceFile) return;

    setLoading(true);

    try {
      const parsed = await parseSheetFromFileByName(
        sourceFile,
        name,
      );        let nextDetected: DetectedStructure | null = null;
      let nextMappings: ColumnMapping[];

      try {
        nextDetected = await parseDynamicStructure(
          sourceFile,
          name,
        );

        setDetectedStructure(nextDetected);
        applyInferredContext(nextDetected);

        const hasName = nextDetected.studentFields.some(
          (field) => field.fieldType === 'name',
        );
        const hasAcademic =
          nextDetected.subjectGroups.length > 0 ||
          nextDetected.gradeFields.length > 0;

        if (hasName && hasAcademic) {
          nextMappings =
            convertDetectedStructureToColumnMapping(
              nextDetected,
              parsed.headers,
            );
          setStructureMapping(
            createStructureMappingFromDetected(nextDetected),
          );
          setDynamicParserFailed(false);
        } else {
          nextMappings = autoMapColumns(parsed.headers);
          setStructureMapping(null);
          setDynamicParserFailed(true);
        }
      } catch {
        nextDetected = null;
        setDetectedStructure(null);
        setStructureMapping(null);
        setDynamicParserFailed(true);
        nextMappings = autoMapColumns(parsed.headers);
      }

      setActiveSheet(name);
      setColumnMapping(nextMappings);
      setWorkbook({
        ...workbook,
        activeSheet: name,
        headers: parsed.headers,
        rows: parsed.rows,
      });
    } catch (error) {
      setFileError(
        (error as Error).message ||
          `Failed to switch to worksheet: ${name}`,
      );
    } finally {
      setLoading(false);
    }
  };

  /*
   * Changing one component's subject name changes
   * the complete subject group.
   */
  const setFieldForColumn = (
    columnIndex: number,
    value: ColumnMapping['fieldKey'],
  ) => {
    const current = columnMapping[columnIndex];
    if (!current) return;

    const oldGroupName =
      current.subjectName || current.columnName;

    setColumnMapping(
      columnMapping.map((m, index) => {
        if (index === columnIndex) {
          return {
            ...m,
            fieldKey: value,
            subjectName:
              value === 'subject'
                ? m.subjectName || m.columnName
                : undefined,
            maxMarks:
              value === 'subject'
                ? m.maxMarks ?? 100
                : undefined,
          };
        }

        if (
          value === 'subject' &&
          m.fieldKey === 'subject' &&
          (m.subjectName || m.columnName) === oldGroupName
        ) {
          return {
            ...m,
            subjectName:
              current.subjectName ||
              current.columnName ||
              oldGroupName,
          };
        }

        return m;
      }),
    );
  };

  const updateSubjectName = (
    columnIndex: number,
    name: string,
  ) => {
    const current = columnMapping[columnIndex];

    const oldName =
      current?.subjectName || current?.columnName;

    setColumnMapping(
      columnMapping.map((m) => {
        if (m.fieldKey !== 'subject') {
          return m;
        }

        const groupName =
          m.subjectName || m.columnName;

        return groupName === oldName
          ? {
              ...m,
              subjectName: name,
            }
          : m;
      }),
    );
  };

  const updateMaxMarks = (
    columnIndex: number,
    max: number,
  ) => {
    const current = columnMapping[columnIndex];

    const oldName =
      current?.subjectName || current?.columnName;

    setColumnMapping(
      columnMapping.map((m) => {
        if (m.fieldKey !== 'subject') {
          return m;
        }

        const groupName =
          m.subjectName || m.columnName;

        return groupName === oldName
          ? {
              ...m,
              maxMarks: max,
            }
          : m;
      }),
    );
  };

  const addSubjectRow = () => {
    const colName =
      `Custom_Subject_${Date.now()}`;

    setColumnMapping([
      ...columnMapping,
      {
        columnName: colName,
        fieldKey: 'subject',
        subjectName: 'New Subject',
        maxMarks: 100,
      },
    ]);
  };

  /*
   * Removing one subject means removing its complete
   * subject group, not just one component.
   */
  const removeMappingRow = (columnIndex: number) => {
    const current = columnMapping[columnIndex];

    const groupName =
      current?.subjectName || current?.columnName;

    setColumnMapping(
      columnMapping.filter((m) => {
        if (m.fieldKey !== 'subject') {
          return true;
        }

        return (
          (m.subjectName || m.columnName) !==
          groupName
        );
      }),
    );
  };

  /*
   * Dynamic structure builder is used whenever the
   * advanced detector succeeded.
   *
   * This preserves PT/NB/SEA/SA2/TOTAL inside one
   * SubjectMark instead of creating duplicate subjects.
   */
  const buildStudentsAndValidate = () => {
    if (!workbook) return;

    /*
     * Class/section may come from a column, a user default, or the workbook
     * title/sheet context. The detected structure is used for both the dynamic
     * and the fallback path so an inferred class always reaches the preview.
     */
    const detectedForContext =
      structureMapping?.detected ?? detectedStructure;

    const effectiveDefaults = {
      defaultClass,
      defaultSection,
      inferredClass: detectedForContext?.inferredClass,
      inferredSection: detectedForContext?.inferredSection,
    };

    const stds = structureMapping?.detected
      ? buildStudentsFromDynamicStructure(
          workbook.rows,
          structureMapping.detected,
          structureMapping,
          effectiveDefaults,
          workbook.headers,
          columnMapping,
        )
      : buildStudentsFromRows(
          workbook.rows,
          columnMapping,
          effectiveDefaults,
        );

    setStudents(stds);

    const v = validateStudents(stds);

    setValidation(v);
    setTab('preview');
  };

  const handlePhotoZip = async (file: File) => {
    setPhotoLoading(true);

    try {
      const { map, duplicates, rejected } =
        await loadPhotoZipDetailed(file);

      setPhotoMap(map);
      /* A new ZIP is a new set of photos — stale manual picks must not survive
       * it, or a card could print a picture the user never re-approved. */
      clearPhotoOverrides();
      setPhotoFile(file);
      setPhotoNotice(
        buildPhotoNotice(duplicates, rejected),
      );
    } catch (e) {
      setFileError(
        (e as Error).message ||
          'Failed to read photo zip',
      );
      setPhotoNotice(null);
    } finally {
      setPhotoLoading(false);
    }
  };

  const handlePhotoFileChange = (
    e: ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];

    if (file) {
      handlePhotoZip(file);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-ink-900">
            Import Students
          </h2>

          <p className="text-sm text-ink-500">
            Upload student data, map columns, configure
            subjects, attach photos, validate records.
          </p>

          {detectedSchoolName &&
            schoolProfile.schoolName.trim() === detectedSchoolName && (
              <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-2 rc-wrap">
                School name “{detectedSchoolName}” was detected from the Excel file because your
                School Profile was empty. You can change it any time in School Profile.
              </p>
            )}
        </div>

        {workbook && (
          <button
            onClick={resetWorkflow}
            className="btn-ghost"
          >
            <RefreshCw className="h-4 w-4" />
            Start Over
          </button>
        )}
      </div>

      {/*
       * Step tabs: a 2-column grid on phones (no sideways scrolling) and a
       * single row from small tablets up.
       */}
      <div className="grid grid-cols-2 sm:flex gap-2 pb-1">
        {tabs.map((t, i) => {
          const locked = i > 0 && !workbook;
          const active = tab === t.id;

          return (
            <button
              key={t.id}
              onClick={() =>
                !locked && setTab(t.id)
              }
              disabled={locked}
              className={clsx(
                'text-left rounded-lg border px-3 py-3 sm:px-4 min-h-[64px] sm:min-w-[170px] sm:shrink-0 transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
                active
                  ? 'border-brand-300 bg-brand-50 ring-1 ring-brand-200'
                  : 'border-slate-200 bg-white hover:border-slate-300',
              )}
            >
              <div
                className={clsx(
                  'text-xs font-semibold',
                  active
                    ? 'text-brand-700'
                    : 'text-ink-500',
                )}
              >
                {t.label}
              </div>

              <div className="text-sm font-semibold text-ink-900 mt-0.5">
                {t.desc}
              </div>
            </button>
          );
        })}
      </div>

      {tab === 'upload' && (
        <UploadTab
          loading={loading}
          fileError={fileError}
          onFile={handleFile}
          fileRef={fileRef}
          onFileChange={handleFileChange}
        />
      )}

      {tab === 'mapping' && workbook && (
        <MappingTab
          headers={workbook.headers}
          rows={workbook.rows}
          sheetNames={workbook.sheetNames}
          activeSheet={workbook.activeSheet}
          fileName={workbook.fileName}
          mappings={columnMapping}
          onSwitchSheet={handleSwitchSheet}
          onSetField={setFieldForColumn}
          onContinue={() => setTab('subjects')}
          summary={summary}
          detectedStructure={structureMapping?.detected ?? null}
          dynamicParserFailed={dynamicParserFailed}
        />
      )}

      {tab === 'subjects' && workbook && (
        <SubjectsTab
          workbook={workbook}
          mappings={columnMapping}
          onUpdateName={updateSubjectName}
          onUpdateMax={updateMaxMarks}
          onRemove={removeMappingRow}
          onAddSubject={addSubjectRow}
          onBack={() => setTab('mapping')}
          onContinue={() => setTab('photos')}
          defaultClass={defaultClass}
          defaultSection={defaultSection}
          setDefaultClass={setDefaultClass}
          setDefaultSection={setDefaultSection}
        />
      )}

      {tab === 'photos' && workbook && (
        <PhotosTab
          photoMap={photoMap}
          photoFile={photoFile}
          loading={photoLoading}
          photoRef={photoRef}
          onChange={handlePhotoFileChange}
          onPhotoDrop={handlePhotoZip}
          onBack={() => setTab('subjects')}
          onContinue={buildStudentsAndValidate}
          notice={photoNotice}
          onClear={() => {
            setPhotoMap({});
            clearPhotoOverrides();
            setPhotoFile(null);
            setPhotoNotice(null);
          }}
        />
      )}

      {tab === 'preview' && workbook && (
        <PreviewTab
          students={students}
          validation={validation}
          workbook={workbook}
          onBack={() => setTab('photos')}
          onRefresh={buildStudentsAndValidate}
          photoMap={photoMap}
          photoOverrides={photoOverrides}
          setPhotoOverride={setPhotoOverride}
          resetPhotoOverride={resetPhotoOverride}
        />
      )}
    </div>
  );
}

function UploadTab({
  loading,
  fileError,
  onFile,
  fileRef,
  onFileChange,
}: {
  loading: boolean;
  fileError: string | null;
  onFile: (f: File) => void;
  fileRef: React.RefObject<HTMLInputElement>;
  onFileChange: (
    e: ChangeEvent<HTMLInputElement>,
  ) => void;
}) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div
        className="card lg:col-span-2"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();

          const file =
            e.dataTransfer.files?.[0];

          if (file) onFile(file);
        }}
      >
        <div className="card-body">
          <label
            htmlFor="excel-input"
            className="block cursor-pointer"
            onDragOver={(e) =>
              e.preventDefault()
            }
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();

              const file =
                e.dataTransfer.files?.[0];

              if (file) onFile(file);
            }}
          >
            <div className="border-2 border-dashed border-slate-300 hover:border-brand-400 rounded-xl p-12 text-center transition-colors bg-slate-50/50">
              {loading ? (
                <div className="flex flex-col items-center gap-2 text-ink-600">
                  <RefreshCw className="h-10 w-10 text-brand-600 animate-spin" />
                  <div className="font-semibold">
                    Parsing workbook...
                  </div>
                </div>
              ) : (
                <>
                  <div className="h-14 w-14 mx-auto rounded-2xl bg-brand-100 text-brand-600 flex items-center justify-center">
                    <FileSpreadsheet className="h-7 w-7" />
                  </div>

                  <h3 className="mt-4 text-lg font-semibold text-ink-900">
                    Drop your Excel / CSV file here
                  </h3>

                  <p className="mt-1 text-sm text-ink-500">
                    or{' '}
                    <span className="text-brand-600 font-semibold">
                      browse to choose
                    </span>{' '}
                    from your computer
                  </p>

                  <p className="mt-3 text-xs text-ink-500">
                    Supports .xlsx · .xls · .csv —
                    reads the first worksheet by default.
                  </p>
                </>
              )}
            </div>

            <input
              ref={fileRef}
              id="excel-input"
              type="file"
              className="hidden"
              accept=".xlsx,.xls,.csv"
              onChange={onFileChange}
            />
          </label>

          {fileError && (
            <div className="mt-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800 flex items-start gap-2">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{fileError}</span>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3 className="font-semibold text-ink-900">
            Expected Format
          </h3>
        </div>

        <div className="card-body text-xs space-y-3 text-ink-700">
          <p>
            Header row should be the first or near-top
            non-empty row.
          </p>

          <p>Auto-detected columns:</p>

          <ul className="space-y-1 text-ink-600 pl-4 list-disc">
            <li>Name / Student Name</li>
            <li>Roll No / Roll Number</li>
            <li>Class / Section</li>
            <li>Father / Mother Name</li>
            <li>DOB / Date of Birth</li>
            <li>Attendance %</li>
            <li>Photo filename</li>
          </ul>

          <p>
            Other columns are classified by the dynamic
            structure detector.
          </p>

          <p className="pt-2 border-t border-slate-100">
            Special mark values:{' '}
            <code className="bg-slate-100 px-1 rounded">
              AB / Absent
            </code>
            ,{' '}
            <code className="bg-slate-100 px-1 rounded">
              EX / Exempt
            </code>
            ,{' '}
            <code className="bg-slate-100 px-1 rounded">
              Medical
            </code>
            .
          </p>
        </div>
      </div>
    </div>
  );
}

function MappingTab({
  headers,
  rows,
  sheetNames,
  activeSheet,
  fileName,
  mappings,
  onSwitchSheet,
  onSetField,
  onContinue,
  summary,
  detectedStructure,
  dynamicParserFailed,
}: {
  headers: string[];
  rows: Record<string, unknown>[];
  sheetNames: string[];
  activeSheet: string;
  fileName: string;
  mappings: ColumnMapping[];
  onSwitchSheet: (name: string) => void;
  onSetField: (
    columnIndex: number,
    value: ColumnMapping['fieldKey'],
  ) => void;
  onContinue: () => void;
  summary: ReturnType<typeof summarizeMappings>;
  detectedStructure: DetectedStructure | null;
  dynamicParserFailed: boolean;
}) {
  const fieldOptions = getCoreFieldOptions();

  const getDetectedRole = (columnIndex: number): string | null => {
    // First check the actual mapping to determine the role
    const mapping = mappings[columnIndex];
    if (!mapping) return null;

    if (mapping.fieldKey === 'gradeField') {
      return 'Grade / Co-scholastic';
    }

    if (mapping.fieldKey === 'overallField') {
      if (mapping.overallFieldType === 'total') return 'Overall Total';
      if (mapping.overallFieldType === 'percentage') return 'Overall %';
      if (mapping.overallFieldType === 'position') return 'Overall Position';
      return 'Overall';
    }

    if (mapping.fieldKey === 'subject') {
      return 'Subject';
    }

    if (mapping.fieldKey !== 'ignore') {
      return 'Field';
    }

    // Fallback to detected structure if available
    if (!detectedStructure) return null;

    if (detectedStructure.studentFields?.some((f) => f.excelColumn === columnIndex)) {
      return 'Field';
    }

    const overall = detectedStructure.overallFields?.find((f) => f.col === columnIndex);
    if (overall) {
      if (overall.fieldType === 'total') return 'Overall Total';
      if (overall.fieldType === 'percentage') return 'Overall %';
      if (overall.fieldType === 'position') return 'Overall Position';
      return 'Overall';
    }

    if (detectedStructure.gradeFields?.some((f) => f.col === columnIndex)) {
      return 'Grade / Co-scholastic';
    }

    if (detectedStructure.subjectGroups?.some((g) =>
      (g.components ?? []).some((c) => c.col === columnIndex),
    )) {
      return 'Subject';
    }

    return null;
  };

  return (
    <div className="space-y-4">
      {dynamicParserFailed && (
        <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />

          <span>
            <strong>
              Advanced structure detection had low
              confidence on this workbook.
            </strong>{' '}
            Please review mappings carefully.
          </span>
        </div>
      )}

      <div className="card">
        <div className="card-body grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
          <div>
            <label className="label">
              Uploaded File
            </label>

            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-sm">
              <FileSpreadsheet className="h-4 w-4 text-brand-600" />

              <span className="truncate font-medium text-ink-800">
                {fileName}
              </span>
            </div>

            <p className="mt-1 text-xs text-ink-500">
              {rows.length} data rows
            </p>
          </div>

          <div>
            <label className="label">
              Worksheet
            </label>

            <select
              value={activeSheet}
              onChange={(e) =>
                onSwitchSheet(e.target.value)
              }
              className="input"
            >
              {sheetNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>

            <p className="mt-1 text-xs text-ink-500">
              {headers.length} columns
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <label className="label">
              &nbsp;
            </label>

            <div className="flex flex-wrap gap-2">
              {summary.missing.length > 0 ? (
                <span className="badge-warning flex-1">
                  <AlertTriangle className="h-3 w-3" />
                  Missing:{' '}
                  {summary.missing.join(', ')}
                </span>
              ) : (
                <span className="badge-success flex-1">
                  <Check className="h-3 w-3" />
                  Required fields mapped
                </span>
              )}

              <span className="badge-info">
                {summary.subjectCount} subjects
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header flex items-center justify-between">
          <h3 className="font-semibold text-ink-900">
            Column Mapping
          </h3>

          <p className="text-xs text-ink-500">
            Excel Column → Internal Field / Subject
          </p>
        </div>

        <div className="max-h-[460px] overflow-auto">
          <table className="table">
            <thead className="sticky top-0 bg-white">
              <tr>
                <th className="w-1/4">
                  Excel Column
                </th>

                <th className="w-1/4">
                  Map to...
                </th>

                <th>
                  First Row Preview
                </th>

                <th className="w-24">
                  Auto-Match
                </th>
              </tr>
            </thead>

            <tbody>
              {(() => {
                /*
                 * SUBJECT GROUP DISPLAY
                 *
                 * The internal mapping is column-level because every Excel
                 * column must remain addressable. The UI, however, should
                 * present PT/NB/SEA/SA2/TOTAL as ONE subject group.
                 *
                 * This avoids showing:
                 *   English
                 *   English
                 *   English
                 *   English
                 *
                 * while keeping every underlying component mapping intact.
                 */
                const rendered = new Set<string>();

                return mappings.map((m, columnIndex) => {
                  if (m.fieldKey === 'subject') {
                    const groupName = (
                      m.subjectName ||
                      m.columnName
                    ).trim();

                    if (rendered.has(`subject:${groupName}`)) {
                      return null;
                    }

                    rendered.add(`subject:${groupName}`);

                    const groupColumns = mappings.filter(
                      (candidate) =>
                        candidate.fieldKey === 'subject' &&
                        (
                          candidate.subjectName ||
                          candidate.columnName
                        ).trim() === groupName,
                    );

                    const componentCount =
                      groupColumns.length;

                    const samples = Array.from(
                      new Set(
                        groupColumns.flatMap((column) =>
                          rows
                            .map((row) => getRowCell(row, column))
                            .filter(Boolean),
                        ),
                      ),
                    ).slice(0, 3);

                    /*
                     * Show every component column grouped under its subject.
                     * The subject TOTAL is highlighted so it is obvious that it
                     * belongs to this subject and is not the overall total.
                     */
                    const componentNames = groupColumns.map((column) => {
                      const parts = column.columnName
                        .split('|')
                        .map((part) => part.trim())
                        .filter(Boolean);
                      return parts.length > 1
                        ? parts[parts.length - 1]
                        : parts[0] ?? column.columnName;
                    });

                    return (
                      <tr key={`subject-group:${groupName}`}>
                        <td>
                          <div className="font-semibold text-sm">
                            {groupName}
                          </div>

                          <div className="text-[10px] text-ink-400 mt-0.5">
                            {componentCount}{' '}
                            component
                            {componentCount === 1
                              ? ''
                              : 's'} linked
                          </div>
                        </td>

                        <td>
                          <div className="flex items-center gap-2">
                            <select
                              value="subject"
                              disabled
                              className="input !py-1.5 text-sm bg-slate-50 cursor-not-allowed"
                            >
                              <option value="subject">
                                Subject Marks
                              </option>
                            </select>

                            <span className="badge-info text-[10px] shrink-0">
                              Grouped
                            </span>
                          </div>
                        </td>

                        <td className="text-xs text-ink-600">
                          <div className="flex flex-wrap gap-1">
                            <span className="px-1.5 py-0.5 rounded bg-slate-100 font-medium">
                              {groupName}
                            </span>
                            {componentNames.map((component, ci) => {
                              const isTotal = /total/i.test(component);
                              return (
                                <span
                                  key={`${component}-${ci}`}
                                  className={clsx(
                                    'px-1.5 py-0.5 rounded font-mono text-[10px]',
                                    isTotal
                                      ? 'bg-emerald-50 text-emerald-700'
                                      : 'bg-slate-100 text-ink-600',
                                  )}
                                  title={
                                    isTotal
                                      ? 'Subject TOTAL component'
                                      : undefined
                                  }
                                >
                                  {component}
                                </span>
                              );
                            })}
                            {componentCount > 1 && (
                              <span className="px-1.5 py-0.5 rounded bg-brand-50 text-brand-700">
                                {componentCount} components
                              </span>
                            )}
                            {samples.length > 0 && (
                              <span className="text-ink-400 ml-1">
                                {samples.join(' · ')}
                              </span>
                            )}
                          </div>
                        </td>

                        <td>
                          <span className="badge-info text-[10px]">
                            Subject
                          </span>
                        </td>
                      </tr>
                    );
                  }

                  const firstVal = getRowCell(rows[0], m);

                  return (
                    <tr key={m.excelColumn ?? m.columnName}>
                      <td className="font-mono text-xs">
                        {m.columnName}
                      </td>

                      <td>
                        {m.fieldKey === 'gradeField' ? (
                          <div className="input !py-1.5 text-sm bg-amber-50 text-amber-800 border-amber-200">
                            Grade / Co-scholastic
                          </div>
                        ) : m.fieldKey === 'overallField' ? (
                          <div className="input !py-1.5 text-sm bg-blue-50 text-blue-800 border-blue-200">
                            {m.overallFieldType === 'total'
                              ? 'Overall Total'
                              : m.overallFieldType === 'percentage'
                                ? 'Overall Percentage'
                                : m.overallFieldType === 'position'
                                  ? 'Overall Position'
                                  : 'Overall Field'}
                          </div>
                        ) : (
                          <select
                            value={m.fieldKey}
                            onChange={(e) =>
                              onSetField(
                                columnIndex,
                                e.target.value as ColumnMapping['fieldKey'],
                              )
                            }
                            className="input !py-1.5 text-sm"
                          >
                            {fieldOptions.map((fo) => (
                              <option key={fo.value} value={fo.value}>
                                {fo.label}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>

                      <td className="text-xs text-ink-600 truncate max-w-[240px]">
                        {String(firstVal ?? '—')}
                      </td>

                      <td>
                        {(() => {
                          const role = getDetectedRole(columnIndex);

                          if (role === 'Grade / Co-scholastic') {
                            return (
                              <span className="badge-warning text-[10px]">
                                Grade / Co-scholastic
                              </span>
                            );
                          }

                          if (role?.startsWith('Overall')) {
                            return (
                              <span className="badge-info text-[10px]">
                                {role}
                              </span>
                            );
                          }

                          if (role === 'Subject') {
                            return (
                              <span className="badge-info text-[10px]">
                                Subject
                              </span>
                            );
                          }

                          if (role === 'Field') {
                            return (
                              <span className="badge-success text-[10px]">
                                Field
                              </span>
                            );
                          }

                          return (
                            <span className="text-xs text-ink-400">
                              Ignored
                            </span>
                          );
                        })()}
                      </td>
                    </tr>
                  );
                });
              })()}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex justify-end">
        <button
          onClick={onContinue}
          className="btn-primary"
          disabled={
            summary.missing.length > 0 ||
            summary.subjectCount === 0
          }
        >
          Continue to Subjects
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function SubjectsTab({
  workbook,
  mappings,
  onUpdateName,
  onUpdateMax,
  onRemove,
  onAddSubject,
  onBack,
  onContinue,
  defaultClass,
  defaultSection,
  setDefaultClass,
  setDefaultSection,
}: {
  workbook: {
    rows: Record<string, unknown>[];
  };

  mappings: ColumnMapping[];

  onUpdateName: (
    columnIndex: number,
    name: string,
  ) => void;

  onUpdateMax: (
    columnIndex: number,
    max: number,
  ) => void;

  onRemove: (columnIndex: number) => void;

  onAddSubject: () => void;

  onBack: () => void;

  onContinue: () => void;

  defaultClass: string;
  defaultSection: string;

  setDefaultClass: (c: string) => void;
  setDefaultSection: (s: string) => void;
}) {
  /*
   * GROUPING:
   *
   * English PT
   * English NB
   * English SEA
   * English SA2
   * English TOTAL
   *
   * become one visual subject:
   *
   * English
   */
  const subjects = useMemo(() => {
    const groups =
      new Map<string, ColumnMapping[]>();

    for (const mapping of mappings) {
      // Co-scholastic grade fields are NOT academic subjects.
      // They stay in DetectedStructure.gradeFields and are consumed
      // separately by buildStudentsFromDynamicStructure().
      if (mapping.fieldKey !== 'subject') {
        continue;
      }

      const name = (
        mapping.subjectName ||
        mapping.columnName
      ).trim();

      if (!name) continue;

      const existing =
        groups.get(name) || [];

      existing.push(mapping);

      groups.set(name, existing);
    }

    return Array.from(groups.entries()).map(
      ([name, columns]) => ({
        name,
        columns,
        representative: columns[0],
      }),
    );
  }, [mappings]);

  const updateGroupName = (
    oldName: string,
    newName: string,
  ) => {
    const target = newName.trim();

    if (!target) return;

    const group = subjects.find(
      (s) => s.name === oldName,
    );

    if (!group) return;

    onUpdateName(
      group.representative.excelColumn ??
        mappings.indexOf(group.representative),
      target,
    );
  };

  const updateGroupMax = (
    oldName: string,
    max: number,
  ) => {
    const group = subjects.find(
      (s) => s.name === oldName,
    );

    if (!group) return;

    onUpdateMax(
      group.representative.excelColumn ??
        mappings.indexOf(group.representative),
      max,
    );
  };

  const removeGroup = (name: string) => {
    const group = subjects.find(
      (s) => s.name === name,
    );

    if (!group) return;

    onRemove(
      group.representative.excelColumn ??
        mappings.indexOf(group.representative),
    );
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="card">
          <div className="card-header">
            <h3 className="font-semibold text-ink-900">
              Default Class / Section
            </h3>

            <p className="text-xs text-ink-500 mt-1">
              Used for rows missing Class or Section.
            </p>
          </div>

          <div className="card-body grid grid-cols-2 gap-4">
            <div>
              <label className="label">
                Default Class
              </label>

              <input
                className="input"
                placeholder="e.g. 8"
                value={defaultClass}
                onChange={(e) =>
                  setDefaultClass(e.target.value)
                }
              />
            </div>

            <div>
              <label className="label">
                Default Section
              </label>

              <input
                className="input"
                placeholder="e.g. A"
                value={defaultSection}
                onChange={(e) =>
                  setDefaultSection(e.target.value)
                }
              />
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h3 className="font-semibold text-ink-900">
              Quick Legend
            </h3>
          </div>

          <div className="card-body text-xs text-ink-700 space-y-2">
            <p>
              <strong>Present:</strong> Numbers
              contribute to totals.
            </p>

            <p>
              <strong>AB / Absent:</strong> Status
              preserved.
            </p>

            <p>
              <strong>EX / Exempt:</strong> Skipped
              from totals.
            </p>

            <p>
              <strong>Medical:</strong> Treated
              similarly to exempt.
            </p>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-ink-900">
              Dynamic Subject Configuration
            </h3>

            <p className="text-xs text-ink-500 mt-1">
              Each subject group appears once.
              Component columns remain linked internally.
            </p>
          </div>

          <button
            onClick={onAddSubject}
            className="btn-secondary"
          >
            <Plus className="h-4 w-4" />
            Add Subject
          </button>
        </div>

        <div className="overflow-auto">
          <table className="table">
            <thead>
              <tr>
                <th>
                  Subject Group
                </th>

                <th>
                  Components
                </th>

                <th>
                  Subject Name
                </th>

                <th className="w-28">
                  Max Marks
                </th>

                <th className="w-32">
                  Sample
                </th>

                <th className="w-12"></th>
              </tr>
            </thead>

            <tbody>
              {subjects.map((group) => {
                const representative =
                  group.representative;

                const samples =
                  Array.from(
                    new Set(
                      group.columns.flatMap(
                        (column) =>
                          workbook.rows
                            .map((row) => getRowCell(row, column))
                            .filter(Boolean),
                      ),
                    ),
                  ).slice(0, 3);

                return (
                  <tr key={group.name}>
                    <td className="font-semibold text-sm">
                      {group.name}
                    </td>

                    <td className="text-xs text-ink-500">
                      <div className="flex flex-wrap gap-1 max-w-[300px]">
                        {group.columns.map(
                          (column) => {
                            const component =
                              column.columnName
                                .split(' | ')
                                .pop() ||
                              column.columnName;

                            return (
                              <span
                                key={
                                  column.columnName
                                }
                                className="px-1.5 py-0.5 rounded bg-slate-100 font-mono"
                                title={
                                  column.columnName
                                }
                              >
                                {component}
                              </span>
                            );
                          },
                        )}
                      </div>
                    </td>

                    <td>
                      <input
                        className="input !py-1.5"
                        value={group.name}
                        onChange={(e) =>
                          updateGroupName(
                            group.name,
                            e.target.value,
                          )
                        }
                      />
                    </td>

                    <td>
                      <input
                        type="number"
                        min={1}
                        className="input !py-1.5"
                        value={
                          representative.maxMarks ??
                          100
                        }
                        onChange={(e) =>
                          updateGroupMax(
                            group.name,
                            Number(
                              e.target.value,
                            ) || 100,
                          )
                        }
                      />
                    </td>

                    <td className="text-xs text-ink-600">
                      {samples.length
                        ? samples.join(' · ')
                        : (
                          <span className="text-ink-400">
                            —
                          </span>
                        )}
                    </td>

                    <td>
                      <button
                        onClick={() =>
                          removeGroup(group.name)
                        }
                        className="p-1 text-ink-400 hover:text-red-600"
                        title={`Remove ${group.name}`}
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}

              {subjects.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="py-12 text-center text-ink-500 text-sm"
                  >
                    No subjects mapped.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex justify-between">
        <button
          onClick={onBack}
          className="btn-secondary"
        >
          <ChevronDown className="h-4 w-4 rotate-90" />
          Back to Mapping
        </button>

        <button
          onClick={onContinue}
          className="btn-primary"
          disabled={subjects.length === 0}
        >
          Continue to Photos
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

/**
 * Plain-language summary of what the ZIP reader ignored, so a duplicate or a
 * renamed file is never a silent surprise. Returns null when nothing was
 * skipped.
 */
function buildPhotoNotice(
  duplicates: string[],
  rejected: Array<{ name: string; reason: string }>,
): string | null {
  if (duplicates.length === 0 && rejected.length === 0) {
    return null;
  }

  const parts: string[] = [];

  if (duplicates.length > 0) {
    parts.push(
      `${duplicates.length} duplicate filename${
        duplicates.length === 1 ? '' : 's'
      } ignored (first file kept): ${duplicates
        .slice(0, 4)
        .join(', ')}${duplicates.length > 4 ? '…' : ''}`,
    );
  }

  if (rejected.length > 0) {
    const summary = rejected
      .slice(0, 4)
      .map((entry) => `${entry.name} (${entry.reason})`)
      .join(', ');

    parts.push(
      `${rejected.length} file${
        rejected.length === 1 ? '' : 's'
      } skipped: ${summary}${rejected.length > 4 ? '…' : ''}`,
    );
  }

  return parts.join(' · ');
}

function PhotosTab({
  photoMap,
  photoFile,
  loading,
  photoRef,
  onChange,
  onPhotoDrop,
  onBack,
  onContinue,
  onClear,
  notice,
}: {
  photoMap: Record<string, string>;
  photoFile: File | null;
  loading: boolean;
  photoRef: React.RefObject<HTMLInputElement>;
  onChange: (
    e: ChangeEvent<HTMLInputElement>,
  ) => void;
  onPhotoDrop: (file: File) => void;
  onBack: () => void;
  onContinue: () => void;
  onClear: () => void;
  notice: string | null;
}) {
  const count = Object.keys(photoMap).length;

  const handleDrop = (
    e: React.DragEvent,
  ) => {
    e.preventDefault();
    e.stopPropagation();

    const file =
      e.dataTransfer.files?.[0];

    if (file) {
      onPhotoDrop(file);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="card lg:col-span-2">
          <div className="card-body">
            <label
              htmlFor="photo-input"
              className="block cursor-pointer"
              onDragOver={(e) =>
                e.preventDefault()
              }
              onDrop={handleDrop}
            >
              <div className="border-2 border-dashed border-slate-300 hover:border-brand-400 rounded-xl p-10 text-center bg-slate-50/50 transition-colors">
                {loading ? (
                  <div className="flex flex-col items-center gap-2 text-ink-600">
                    <RefreshCw className="h-10 w-10 text-brand-600 animate-spin" />

                    <div className="font-semibold">
                      Reading photos from ZIP...
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="h-14 w-14 mx-auto rounded-2xl bg-brand-100 text-brand-600 flex items-center justify-center">
                      <Package className="h-7 w-7" />
                    </div>

                    <h3 className="mt-4 text-lg font-semibold text-ink-900">
                      Drop Student Photos ZIP
                    </h3>

                    <p className="mt-1 text-sm text-ink-500">
                      or{' '}
                      <span className="text-brand-600 font-semibold">
                        browse to select
                      </span>{' '}
                      a ZIP file
                    </p>

                    <p className="mt-3 text-xs text-ink-500">
                      Naming: match by RollNo.jpg,
                      or use a Photo column.
                    </p>
                  </>
                )}
              </div>

              <input
                ref={photoRef}
                id="photo-input"
                type="file"
                accept=".zip"
                className="hidden"
                onChange={onChange}
              />
            </label>
          </div>
        </div>

        <div className="card">
          <div className="card-header flex items-center justify-between">
            <h3 className="font-semibold text-ink-900">
              Photo Matching
            </h3>

            {count > 0 && (
              <button
                onClick={onClear}
                className="btn-ghost !py-1 !px-2 text-xs"
              >
                <X className="h-3.5 w-3.5" />
                Clear
              </button>
            )}
          </div>

          <div className="card-body text-sm space-y-2 text-ink-700">
            <p>
              <strong>{count}</strong> distinct photo
              file{count === 1 ? '' : 's'} loaded.
            </p>

            {photoFile && (
              <div className="flex items-center gap-2 text-xs text-ink-600">
                <Package className="h-4 w-4" />
                {photoFile.name}
              </div>
            )}

            {notice && (
              <div
                role="status"
                className="flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800"
              >
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>{notice}</span>
              </div>
            )}

            <p className="text-xs text-ink-500 border-t border-slate-100 pt-2 mt-2">
              Matching logic:
            </p>

            <ol className="list-decimal pl-4 text-xs text-ink-600 space-y-1">
              <li>
                Exact photo filename
              </li>
              <li>
                Roll number
              </li>
              <li>
                Student name
              </li>
            </ol>

            <p className="text-xs text-ink-500 pt-2">
              Missing photos show a blank photo box.
            </p>
          </div>
        </div>
      </div>

      <div className="flex justify-between">
        <button
          onClick={onBack}
          className="btn-secondary"
        >
          <ChevronDown className="h-4 w-4 rotate-90" />
          Back to Subjects
        </button>

        <button
          onClick={onContinue}
          className="btn-primary"
        >
          Preview &amp; Validate
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function PreviewTab({
  students,
  validation,
  workbook,
  onBack,
  onRefresh,
  photoMap,
  photoOverrides,
  setPhotoOverride,
  resetPhotoOverride,
}: {
  students: {
    studentId: string;
    rowNumber: number;
    rollNo: string;
    admissionNo?: string;
    class?: string;
    section?: string;
    name: string;
    fatherName?: string;
    motherName?: string;
    attendance?: string;
    workingDays?: string;
    daysPresent?: string;
    photoFilename?: string;
    subjects: {
      name: string;
      marks: number | null;
      maxMarks: number;
      status: string;
      rawValue?: string;
    }[];
    gradeFields?: {
      name: string;
      value: string;
      rawValue?: string;
    }[];
    overall?: {
      total?: number | string;
      percentage?: number | string;
      position?: number | string;
      attendance?: string;
      remarks?: string;
    };
  }[];

  validation:
    ReturnType<typeof validateStudents> | null;

  workbook: {
    fileName: string;
    rows: Record<string, unknown>[];
  };

  onBack: () => void;
  onRefresh: () => void;
  photoMap: Record<string, string>;
  photoOverrides: PhotoOverrides;
  setPhotoOverride: (studentId: string, dataUrl: string | null) => void;
  resetPhotoOverride: (studentId: string) => void;
}) {
  /*
   * Every photo file in the uploaded ZIP, listed once (the ZIP loader registers
   * several aliases per file, so entries are de-duplicated by data URL). These
   * are the pictures the user may assign manually — no new upload is needed, so
   * the ZIP's own path/format validation still applies.
   */
  const photoLibrary = useMemo(() => {
    const seen = new Map<string, string>();
    for (const [label, url] of Object.entries(photoMap)) {
      if (!url || seen.has(url)) continue;
      seen.set(url, /\.[a-z0-9]+$/i.test(label) ? label : `${label}.jpg`);
    }
    return [...seen.entries()].map(([url, label]) => ({ url, label }));
  }, [photoMap]);

  /** One-off photo for a single student, validated the same way the ZIP is. */
  const [attachingFor, setAttachingFor] = useState<string | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const attachRef = useRef<HTMLInputElement>(null);

  /** Value of the per-row picker: auto / cleared / a specific ZIP photo. */
  const pickerValue = (studentId: string): string => {
    if (!Object.prototype.hasOwnProperty.call(photoOverrides, studentId)) return '__auto';
    const override = photoOverrides[studentId];
    if (override === null) return '__clear';
    const index = photoLibrary.findIndex((entry) => entry.url === override);
    return index >= 0 ? `lib:${index}` : '__manual';
  };

  const handleSinglePhoto = async (file: File) => {
    const studentId = attachingFor;
    setAttachError(null);
    if (!studentId) return;

    if (file.size > MAX_IMAGE_BYTES) {
      setAttachError(
        `That photo is ${Math.round(file.size / (1024 * 1024))} MB — please keep it under ${Math.round(
          MAX_IMAGE_BYTES / (1024 * 1024),
        )} MB.`,
      );
      return;
    }

    try {
      /* Trust the bytes, not the extension. */
      const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
      if (detectImageFormat(head) === null) {
        setAttachError('That file is not a readable image (JPG, PNG, WEBP, GIF or BMP).');
        return;
      }
      setPhotoOverride(studentId, await fileToDataUrl(file));
    } catch {
      setAttachError('That photo could not be read. Please try another file.');
    } finally {
      setAttachingFor(null);
    }
  };
  const [selectedId, setSelectedId] =
    useState<string>(
      students[0]?.studentId || '',
    );

  const selected =
    students.find(
      (s) => s.studentId === selectedId,
    ) || students[0];

  const selectedIssues =
    validation?.issues.filter(
      (i) =>
        i.studentId ===
        selected?.studentId,
    ) ?? [];

  const selectedTotals = selected
    ? computeTotals(selected as unknown as Student)
    : null;

  /**
   * The SAME resolver the PDF generator uses — with the user's manual
   * corrections applied — so this table can never promise a photo that
   * generation would refuse to attach, nor hide one it would attach.
   */
  const photoReview = useMemo(() => {
    const { photos, status, conflicts } = resolvePhotosWithOverrides(
      students.map((student) => ({
        studentId: student.studentId,
        rowNumber: student.rowNumber,
        rollNo: student.rollNo,
        name: student.name,
        admissionNo: student.admissionNo,
        photoFilename: student.photoFilename,
      })),
      photoMap,
      photoOverrides,
    );

    const rows = students.map((student) => ({
      student,
      photo: photos.get(student.studentId),
      status: (status.get(student.studentId) ?? 'missing') as PhotoStatus,
    }));

    return {
      rows,
      conflicts,
      confirmed: rows.filter((r) => r.status === 'matched').length,
      manual: rows.filter((r) => r.status === 'manual').length,
      cleared: rows.filter((r) => r.status === 'cleared').length,
      review: rows.filter((r) => r.status === 'ambiguous').length,
      missing: rows.filter((r) => r.status === 'missing').length,
    };
  }, [photoMap, students, photoOverrides]);

  const selectedPhotoStatus: PhotoStatus =
    photoReview.rows.find(
      (row) => row.student.studentId === selected?.studentId,
    )?.status ?? 'missing';

  const exportErrors = () => {
    if (
      !validation ||
      validation.issues.length === 0
    ) {
      return;
    }

    const lines = [
      'Row,Student,RollNo,Severity,Field,Message',
    ];

    for (const i of validation.issues) {
      const stu = students.find(
        (s) => s.studentId === i.studentId,
      );

      lines.push(
        [
          i.rowNumber ?? '',
          stu?.name ?? '',
          stu?.rollNo ?? '',
          i.severity,
          i.field ?? '',
          JSON.stringify(
            i.message,
          ).replace(/^"|"$/g, ''),
        ].join(','),
      );
    }

    const blob = new Blob(
      [lines.join('\n')],
      {
        type: 'text/csv;charset=utf-8;',
      },
    );

    const url =
      URL.createObjectURL(blob);

    const a =
      document.createElement('a');

    a.href = url;
    a.download =
      'validation_errors.csv';

    a.click();

    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      {validation ? (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div className="card">
            <div className="card-body">
              <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">
                Total Students
              </div>

              <div className="text-2xl font-bold mt-1 text-ink-900">
                {students.length}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-body">
              <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">
                Status
              </div>

              <div
                className={`text-2xl font-bold mt-1 ${
                  validation.isValid
                    ? 'text-emerald-700'
                    : 'text-amber-700'
                }`}
              >
                {validation.isValid
                  ? 'VALID'
                  : 'HAS ISSUES'}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-body">
              <div className="text-xs font-semibold uppercase tracking-wide text-red-500">
                Errors
              </div>

              <div className="text-2xl font-bold mt-1 text-red-700">
                {validation.errorCount}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-body">
              <div className="text-xs font-semibold uppercase tracking-wide text-amber-600">
                Warnings
              </div>

              <div className="text-2xl font-bold mt-1 text-amber-700">
                {validation.warningCount}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="card-body text-sm text-ink-600">
            Building preview...
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
        <div className="card xl:col-span-5">
          <div className="card-header flex items-center justify-between">
            <h3 className="font-semibold text-ink-900">
              Student List &amp; Validation
            </h3>

            <div className="flex gap-2">
              <button
                onClick={onRefresh}
                className="btn-secondary !py-1.5 !px-3 text-xs"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Re-run
              </button>

              {validation &&
                validation.issues.length > 0 && (
                  <button
                    onClick={exportErrors}
                    className="btn-secondary !py-1.5 !px-3 text-xs"
                  >
                    Export Errors CSV
                  </button>
                )}
            </div>
          </div>

          <div className="max-h-[560px] overflow-auto">
            <table className="table">
              <thead className="sticky top-0 bg-white z-10">
                <tr>
                  <th className="w-12">
                    Row
                  </th>

                  <th>
                    Roll
                  </th>

                  <th>
                    Name
                  </th>

                  <th className="w-20">
                    Issues
                  </th>
                </tr>
              </thead>

              <tbody>
                {students.map((s) => {
                  const issues =
                    validation?.issues.filter(
                      (i) =>
                        i.studentId ===
                        s.studentId,
                    ) ?? [];

                  const err =
                    issues.filter(
                      (i) =>
                        i.severity ===
                        'error',
                    ).length;

                  const warn =
                    issues.filter(
                      (i) =>
                        i.severity ===
                        'warning',
                    ).length;

                  const active =
                    s.studentId ===
                    selected?.studentId;

                  return (
                    <tr
                      key={s.studentId}
                      onClick={() =>
                        setSelectedId(
                          s.studentId,
                        )
                      }
                      className={clsx(
                        'cursor-pointer',
                        active &&
                          'bg-brand-50/60',
                      )}
                    >
                      <td className="text-xs text-ink-500 font-mono">
                        {s.rowNumber}
                      </td>

                      <td className="font-medium">
                        {s.rollNo}
                      </td>

                      <td className="rc-wrap">
                        {s.name}
                      </td>

                      <td>
                        <div className="flex gap-1">
                          {err > 0 && (
                            <span className="badge-error">
                              {err}E
                            </span>
                          )}

                          {warn > 0 && (
                            <span className="badge-warning">
                              {warn}W
                            </span>
                          )}

                          {err === 0 &&
                            warn === 0 && (
                              <span className="badge-success">
                                OK
                              </span>
                            )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card xl:col-span-7">
          <div className="card-header flex items-center justify-between">
            <h3 className="font-semibold text-ink-900">
              {selected
                ? `${selected.rollNo} · ${selected.name}`
                : 'No student selected'}
            </h3>

            {selected && (
              <span className="text-xs text-ink-500">
                Row {selected.rowNumber} ·{' '}
                {workbook.fileName}
              </span>
            )}
          </div>

          <div className="card-body space-y-4">
            {selected &&
              selectedIssues.length > 0 && (
                <div className="p-3 rounded-lg bg-red-50 border border-red-200">
                  <div className="text-xs font-semibold text-red-800 mb-2">
                    Issues for this student:
                  </div>

                  <ul className="space-y-1 text-sm text-red-800">
                    {selectedIssues.map(
                      (i, idx) => (
                        <li
                          key={idx}
                          className="flex gap-2 items-start"
                        >
                          {i.severity ===
                          'error' ? (
                            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                          ) : (
                            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-amber-600" />
                          )}

                          <span>
                            {i.field && (
                              <span className="font-mono text-xs mr-2">
                                [{i.field}]
                              </span>
                            )}

                            {i.message}
                            {i.reason && (
                              <span className="block text-xs text-red-700/80 mt-0.5">
                                {i.confirmed === false ? 'Possible cause: ' : 'Cause: '}
                                {i.reason}
                              </span>
                            )}
                            {i.suggestion && (
                              <span className="block text-xs text-ink-600 mt-0.5">
                                Fix: {i.suggestion}
                              </span>
                            )}
                          </span>
                        </li>
                      ),
                    )}
                  </ul>
                </div>
              )}

            {selected && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <Detail
                  label="Class / Section"
                  value={`${selected.class ?? '—'}${
                    selected.section
                      ? ` - ${selected.section}`
                      : ''
                  }`}
                />

                <Detail
                  label="Roll No"
                  value={selected.rollNo}
                />

                <Detail
                  label="Admission No"
                  value={selected.admissionNo}
                />

                <Detail
                  label="Father's Name"
                  value={selected.fatherName}
                />

                <Detail
                  label="Mother's Name"
                  value={selected.motherName}
                />

                <Detail
                  label="Attendance"
                  value={selected.attendance}
                />

                <Detail
                  label="Working / Present"
                  value={
                    selected.workingDays || selected.daysPresent
                      ? `${selected.workingDays ?? '—'} / ${selected.daysPresent ?? '—'}`
                      : undefined
                  }
                />

                <Detail
                  label="Photo Filename"
                  value={
                    selected.photoFilename
                  }
                />
              </div>
            )}

            {selected && (
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-500 mb-2">
                  Subjects &amp; Marks
                </h4>

                <div className="overflow-auto border border-slate-200 rounded">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>
                          Subject
                        </th>

                        <th className="w-24">
                          Marks
                        </th>

                        <th className="w-24">
                          Max
                        </th>

                        <th className="w-24">
                          Status
                        </th>
                      </tr>
                    </thead>

                    <tbody>
                      {selected.subjects.map(
                        (s, i) => (
                          <tr key={i}>
                            <td>
                              {s.name}
                            </td>

                            <td
                              className={clsx(
                                s.status !==
                                  'present' &&
                                  'text-ink-500 italic',
                              )}
                            >
                              {s.status ===
                              'present'
                                ? s.marks ??
                                  '—'
                                : s.rawValue ??
                                  s.status}
                            </td>

                            <td>
                              {s.maxMarks}
                            </td>

                            <td>
                              <span
                                className={clsx(
                                  'badge',
                                  s.status ===
                                    'present'
                                    ? 'badge-info'
                                    : 'badge-warning',
                                )}
                              >
                                {s.status}
                              </span>
                            </td>
                          </tr>
                        ),
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {selected &&
              selected.gradeFields &&
              selected.gradeFields.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-500 mb-2">
                  Co-scholastic / Grades
                </h4>

                <div className="overflow-auto border border-slate-200 rounded">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Area</th>
                        <th className="w-32">Grade</th>
                      </tr>
                    </thead>

                    <tbody>
                      {selected.gradeFields.map((g, i) => (
                        <tr key={i}>
                          <td>{g.name}</td>
                          <td>{g.value || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {selected && selectedTotals && (
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-500 mb-2">
                  Overall Result
                </h4>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-2">
                    <div className="text-[10px] uppercase tracking-wide text-ink-500">
                      Grand Total
                    </div>
                    <div className="text-sm font-bold text-ink-900 mt-0.5">
                      {selected.overall?.total !== undefined &&
                      selected.overall?.total !== ''
                        ? selected.overall.total
                        : `${selectedTotals.totalMarks} / ${selectedTotals.totalMax || '—'}`}
                    </div>
                  </div>

                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-2">
                    <div className="text-[10px] uppercase tracking-wide text-ink-500">
                      Percentage
                    </div>
                    <div className="text-sm font-bold text-ink-900 mt-0.5">
                      {selected.overall?.percentage !== undefined &&
                      selected.overall?.percentage !== ''
                        ? `${selected.overall.percentage}%`
                        : selectedTotals.percentage !== null
                          ? `${selectedTotals.percentage}%`
                          : '—'}
                    </div>
                  </div>

                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-2">
                    <div className="text-[10px] uppercase tracking-wide text-ink-500">
                      Position
                    </div>
                    <div className="text-sm font-bold text-ink-900 mt-0.5">
                      {selected.overall?.position ?? '—'}
                    </div>
                  </div>

                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-2">
                    <div className="text-[10px] uppercase tracking-wide text-ink-500">
                      Attendance
                    </div>
                    <div className="text-sm font-bold text-ink-900 mt-0.5">
                      {selected.attendance ?? selected.overall?.attendance ?? '—'}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {selected && (
              <div className="pt-2 border-t border-slate-100 text-xs text-ink-500">
                <span
                  className={clsx(
                    'flex items-center gap-1',
                    selectedPhotoStatus === 'matched' || selectedPhotoStatus === 'manual'
                      ? 'text-emerald-700'
                      : selectedPhotoStatus === 'cleared'
                        ? 'text-ink-500'
                        : 'text-amber-700',
                  )}
                >
                  <ImageIcon className="h-3.5 w-3.5" />
                  {photoStatusLabel(selectedPhotoStatus)}
                </span>
              </div>
            )}

            {selected &&
              validation?.isValid && (
                <div className="flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                  <Check className="h-4 w-4" />
                  This student record is valid.
                </div>
              )}
          </div>
        </div>
      </div>

      {/*
        Photo review + manual correction. Built from the SAME resolver the PDF
        generator uses (with the manual choices applied), so a row that says
        "Confirmed" here is really the photograph that will be printed.
      */}
      <div className="card">
        <div className="card-header flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold text-ink-900">
            Student photo review
          </h3>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
              {photoReview.confirmed} matched
            </span>
            {photoReview.manual > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-brand-50 text-brand-700 border border-brand-200">
                {photoReview.manual} set manually
              </span>
            )}
            {photoReview.cleared > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-slate-50 text-ink-600 border border-slate-200">
                {photoReview.cleared} cleared
              </span>
            )}
            {photoReview.review > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200">
                {photoReview.review} need review
              </span>
            )}
            {photoReview.missing > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-slate-50 text-ink-600 border border-slate-200">
                {photoReview.missing} missing
              </span>
            )}
          </div>
        </div>

        <div className="card-body overflow-x-auto">
          <p className="text-xs text-ink-500 mb-3">
            {photoLibrary.length > 0
              ? `Photos are matched by identity (workbook filename, roll number, admission number or an exact name) — never by upload order. ${photoLibrary.length} distinct photo${photoLibrary.length === 1 ? '' : 's'} loaded. Use “Change photo” on any row to pick a different picture, attach one from this computer, or clear the photo for that student.`
              : 'No photo ZIP uploaded yet — every card prints with a blank photo box. Use “Change photo → Attach” on a row to add a single photo, or upload a ZIP in step 4.'}
          </p>

          {attachError && (
            <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">
              {attachError}
            </p>
          )}

          {photoReview.review > 0 && (
            <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">
              {photoReview.review} student
              {photoReview.review === 1 ? '' : 's'} could not be matched with
              certainty (the same photo fits more than one child, or the
              identifier conflicts). Those report cards print with the blank
              photo box — a wrong photograph is worse than none. Rename the
              photo to the student&apos;s roll number, or fix the Roll No
              column, and import the ZIP again — or choose the correct photo by
              hand in the table below.
            </p>
          )}

          {photoReview.conflicts.length > 0 && (
            <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">
              You chose the same picture for {photoReview.conflicts.length}{' '}
              students. Your choice is used exactly as made — check that each
              child really has that photo.
            </p>
          )}

          <input
            ref={attachRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleSinglePhoto(file);
              if (attachRef.current) attachRef.current.value = '';
            }}
          />

          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-ink-500">
                <th className="py-1 pr-3">Roll No</th>
                <th className="py-1 pr-3">Student</th>
                <th className="py-1 pr-3">Photo</th>
                <th className="py-1 pr-3">Status</th>
                <th className="py-1">Change photo</th>
              </tr>
            </thead>
            <tbody>
              {photoReview.rows.map(({ student, photo, status }) => (
                <tr
                  key={student.studentId}
                  className="border-t border-slate-100"
                >
                  <td className="py-2 pr-3 font-medium text-ink-800">
                    {student.rollNo || '—'}
                  </td>
                  <td className="py-2 pr-3 text-ink-700">
                    {student.name}
                  </td>
                  <td className="py-2 pr-3">
                    {photo ? (
                      <img
                        src={photo}
                        alt=""
                        className="h-10 w-10 rounded-md object-cover border border-slate-200"
                      />
                    ) : (
                      <span className="text-ink-400">—</span>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    <span
                      className={clsx(
                        status === 'matched' && 'text-emerald-700',
                        status === 'manual' && 'text-brand-700',
                        status === 'cleared' && 'text-ink-500',
                        (status === 'ambiguous' || status === 'missing') && 'text-amber-800',
                      )}
                    >
                      {status === 'matched'
                        ? 'Confirmed'
                        : status === 'manual'
                          ? 'Set manually'
                          : status === 'cleared'
                            ? 'Cleared'
                            : status === 'ambiguous'
                              ? 'Needs review'
                              : 'Missing'}
                    </span>

                    <button
                      type="button"
                      onClick={() => setSelectedId(student.studentId)}
                      className="ml-3 text-xs text-brand-600 hover:underline"
                    >
                      Inspect
                    </button>
                  </td>
                  <td className="py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        className="input !w-auto max-w-[190px] !py-1 text-xs"
                        aria-label={`Photo for ${student.name}`}
                        value={pickerValue(student.studentId)}
                        onChange={(e) => {
                          const value = e.target.value;
                          if (value === '__auto') {
                            resetPhotoOverride(student.studentId);
                            return;
                          }
                          if (value === '__clear') {
                            setPhotoOverride(student.studentId, null);
                            return;
                          }
                          if (value === '__manual') return;
                          const index = Number(value.slice(4));
                          const entry = photoLibrary[index];
                          if (entry) setPhotoOverride(student.studentId, entry.url);
                        }}
                      >
                        {pickerValue(student.studentId) === '__manual' && (
                          <option value="__manual">Attached photo</option>
                        )}
                        <option value="__auto">Auto (match by identity)</option>
                        {photoLibrary.map((entry, index) => (
                          <option key={entry.url.slice(-24) + index} value={`lib:${index}`}>
                            {entry.label}
                          </option>
                        ))}
                        <option value="__clear">Clear — print no photo</option>
                      </select>

                      <button
                        type="button"
                        className="text-xs text-brand-600 hover:underline"
                        onClick={() => {
                          setAttachError(null);
                          setAttachingFor(student.studentId);
                          attachRef.current?.click();
                        }}
                      >
                        Attach…
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <p className="text-[11px] text-ink-500 mt-3">
            Manual choices are used by the real PDF generator and the preview —
            they are not applied to the on-screen preview only.
          </p>
        </div>
      </div>

      <div className="flex justify-between items-center">
        <button
          onClick={onBack}
          className="btn-secondary"
        >
          <ChevronDown className="h-4 w-4 rotate-90" />
          Back to Photos
        </button>

        <div className="flex items-center gap-3 text-xs text-ink-500">
          When you are happy with the data,
          proceed to <strong>Generate Reports</strong>.
        </div>
      </div>
    </div>
  );
}

function Detail({
  label,
  value,
}: {
  label: string;
  value?: string;
}) {
  return (
    <div className="flex gap-2 border-b border-slate-100 py-1">
      <span className="text-ink-500 w-32 shrink-0">
        {label}:
      </span>

      <span className="text-ink-900 truncate">
        {value || '—'}
      </span>
    </div>
  );
}

export type { FieldKey };

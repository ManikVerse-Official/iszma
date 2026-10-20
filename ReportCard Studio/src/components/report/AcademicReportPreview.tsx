import type { SchoolProfile, Student } from '../../types';
import { buildReportCardModel } from '../../services/reportCardModel';
import { getTheme, type ReportCardTheme } from '../../themes';
import { mmCss, TYPE_MM } from '../../themes/typography';

interface Props {
  student: Student;
  school: SchoolProfile;
  photoDataUrl?: string;
  theme?: ReportCardTheme;
}

/**
 * Marks-focused report card. Two looks share this structure:
 *
 *   - "Simple Academic" (classic): formal printed statement — bordered table,
 *     boxed student info, four summary boxes;
 *   - "Modern School" (modern): a colour header band, pill-shaped student info,
 *     zebra table with per-subject performance bars and one wide result band.
 *
 * Both follow the same zero-overlap rules: table-fixed columns, min-w-0 grid
 * children, wrapping everywhere and no truncation. Percentages are always
 * calculated from the subject's own maximum marks, so 25/50/80/100-mark
 * subjects are all handled correctly.
 */
export default function AcademicReportPreview({ student, school, photoDataUrl, theme }: Props) {
  const model = buildReportCardModel(student, school);
  const activeTheme = theme ?? getTheme(model.themeId);
  const p = activeTheme.palette;
  const { header } = model;
  const { sections } = activeTheme;
  const modern = activeTheme.variant === 'modern';

  /*
   * Column widths for the dynamic marks table. The Subject column keeps a
   * healthy but bounded share; every workbook component column plus the Total
   * (and the optional Percentage) then splits what is left evenly.
   */
  const dataCols =
    model.academicColumns.length + (sections.subjectPercentage ? 1 : 0);
  const subjectColWidth = Math.min(34, Math.max(18, 36 - dataCols * 2));
  const dataColWidth = (100 - subjectColWidth) / Math.max(1, dataCols);

  const affiliationLine = [
    header.affiliationText,
    header.schoolCode ? `SCHOOL CODE: ${header.schoolCode}` : '',
    header.affiliationNo ? `AFFILIATION NO.: ${header.affiliationNo}` : '',
  ]
    .filter(Boolean)
    .join(' | ');

  const percentageText =
    model.totals.percentage !== null ? `${model.totals.percentage}%` : '—';

  return (
    <div
      data-testid="report-card"
      className="bg-white shadow-card border border-slate-300 rounded-lg overflow-hidden mx-auto text-ink-900"
      style={{ width: '210mm', minHeight: '297mm', padding: modern ? '6mm' : '10mm' }}
    >
      {/* ── Header ─────────────────────────────────────────────── */}
      {modern ? (
        <div className="rounded-lg overflow-hidden" style={{ backgroundColor: p.primary }}>
          <div className="flex items-stretch gap-3 p-3">
            <div className="w-[18mm] h-[18mm] shrink-0 rounded-md bg-white flex items-center justify-center overflow-hidden self-start">
              {header.logoDataUrl && (
                <img src={header.logoDataUrl} alt="logo" className="h-full w-full object-contain" />
              )}
            </div>

            <div className="flex-1 min-w-0 text-center">
              <h1 className="text-[22px] leading-tight font-extrabold tracking-wide uppercase text-white rc-wrap">
                {header.schoolName}
              </h1>
              {header.address && (
                <p className="text-[10px] mt-0.5 rc-wrap" style={{ color: '#e0e7ff' }}>
                  {header.address}
                </p>
              )}
              {affiliationLine && (
                <p className="text-[9px] mt-0.5 rc-wrap" style={{ color: '#e0e7ff' }}>
                  {affiliationLine}
                </p>
              )}

              <div className="mt-2 mx-auto w-[42mm] rounded-md bg-white text-center overflow-hidden">
                <div className="text-[6.5px] font-semibold uppercase tracking-wide text-ink-500 px-1 py-1">
                  Academic Session
                </div>
                <div className="text-[11px] font-bold rc-wrap px-1 pb-1" style={{ color: p.primary }}>
                  {header.academicSession || '—'}
                </div>
              </div>
            </div>

            <div className="w-[22mm] shrink-0 flex justify-center self-start">
              {/* Student photo — blank placeholder when no photo matched. */}
              <div className="h-[22mm] w-[18mm] rounded-md bg-white p-[1px]">
                <div
                  className="h-full w-full rounded-sm overflow-hidden flex items-center justify-center"
                  style={{ border: `1px solid ${p.line}` }}
                >
                  {photoDataUrl ? (
                    <img src={photoDataUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <span className="text-[7px] text-ink-400">PHOTO</span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex items-stretch gap-3">
          <div className="w-[22mm] shrink-0 flex flex-col items-center justify-center">
            {header.logoDataUrl ? (
              <img src={header.logoDataUrl} alt="logo" className="h-[20mm] w-[20mm] object-contain" />
            ) : (
              <div className="h-[20mm] w-[20mm] rounded-full border border-dashed border-slate-300" />
            )}
          </div>

          <div className="flex-1 min-w-0 text-center">
            <h1
              className="text-[23px] leading-tight font-extrabold tracking-wide uppercase rc-wrap"
              style={{ color: p.primary }}
            >
              {header.schoolName}
            </h1>
            {header.address && <p className="text-[11px] text-ink-700 mt-0.5 rc-wrap">{header.address}</p>}
            {affiliationLine && <p className="text-[10px] text-ink-700 mt-0.5 rc-wrap">{affiliationLine}</p>}
          </div>

          <div className="w-[32mm] shrink-0 text-center">
            <div
              className="rounded-md text-white text-[9px] font-semibold uppercase px-1 py-1 rc-wrap"
              style={{ backgroundColor: p.primary }}
            >
              Academic Session
            </div>
            <div className="border border-t-0 rounded-b-md text-[13px] font-bold py-1 rc-wrap" style={{ borderColor: p.primary }}>
              {header.academicSession || '—'}
            </div>
            {/* Student photo — blank placeholder when no photo matched. */}
            <div className="mt-1 flex justify-center">
              <div
                className="h-[22mm] w-[18mm] rounded-sm overflow-hidden flex items-center justify-center"
                style={{ border: `1px solid ${p.line}` }}
              >
                {photoDataUrl ? (
                  <img src={photoDataUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <span className="text-[7px] text-ink-400">PHOTO</span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Title ──────────────────────────────────────────────── */}
      {modern ? (
        <div
          className="mt-2 flex items-stretch rounded-sm overflow-hidden"
          style={{ backgroundColor: p.headerFill }}
        >
          <div className="w-[1.5mm] shrink-0" style={{ backgroundColor: p.primary }} />
          <div
            className="px-3 py-1 font-bold tracking-wide uppercase rc-wrap"
            style={{ color: p.primary, fontSize: mmCss(TYPE_MM.title) }}
          >
            {model.title}
          </div>
        </div>
      ) : (
        <div
          className="mt-3 rounded-sm text-white text-center py-1 font-bold tracking-wide uppercase rc-wrap"
          style={{ backgroundColor: p.primary, fontSize: mmCss(TYPE_MM.title) }}
        >
          {model.title}
        </div>
      )}

      {/* ── Student info ──────────────────────────────────────── */}
      <div
        className="mt-2 grid grid-cols-2 gap-x-4 items-start"
        style={
          modern
            ? { gap: '3px' }
            : { border: `1px solid ${p.primary}`, borderRadius: '2px', padding: '8px', rowGap: '4px' }
        }
      >
        <InfoColumn items={model.infoLeft} modern={modern} accent={p.primary} chip={p.headerFill} />
        <InfoColumn items={model.infoRight} modern={modern} accent={p.primary} chip={p.headerFill} />
      </div>

      {/* ── Marks table ───────────────────────────────────────── */}
      <div className="mt-3">
        <div
          className={`${modern ? 'text-left px-2' : 'text-center'} py-1 font-bold uppercase rc-wrap`}
          style={{
            backgroundColor: p.headerFill,
            border: `1px solid ${modern ? p.headerFill : p.line}`,
            color: modern ? p.primary : undefined,
            borderRadius: modern ? '3px' : undefined,
            fontSize: mmCss(TYPE_MM.sectionBar),
          }}
        >
          Academic Performance
        </div>
        {/*
         * The marks table mirrors the uploaded sheet: Subject followed by the
         * workbook's own component columns (PT / NB / SEA / SA2 …), the subject
         * Total, then (when the theme asks for it) a computed Percentage. There
         * is deliberately no Grade column and no Remarks column here.
         */}
        <table
          className={`w-full border-collapse table-fixed ${modern ? 'mt-1' : ''}`}
          style={{ fontSize: mmCss(TYPE_MM.academic) }}
        >
          <colgroup>
            <col style={{ width: `${subjectColWidth}%` }} />
            {model.academicColumns.map((_column, i) => (
              <col key={i} style={{ width: `${dataColWidth}%` }} />
            ))}
            {sections.subjectPercentage && <col style={{ width: `${dataColWidth}%` }} />}
          </colgroup>
          <thead>
            <tr
              style={{
                backgroundColor: modern ? p.primary : '#f8fafc',
                color: modern ? '#ffffff' : undefined,
              }}
            >
              <Th theme={activeTheme} modern={modern} className="text-left">Subject</Th>
              {model.academicColumns.map((column, i) => (
                <Th key={i} theme={activeTheme} modern={modern} className="uppercase">
                  {column.label}
                </Th>
              ))}
              {sections.subjectPercentage && (
                <Th theme={activeTheme} modern={modern}>Percentage</Th>
              )}
            </tr>
          </thead>
          <tbody>
            {model.academic.map((row, i) => (
              <tr
                key={i}
                className={row.isGrandTotal ? 'font-semibold' : ''}
                style={
                  row.isGrandTotal
                    ? { backgroundColor: modern ? p.primary : p.totalFill, color: modern ? '#ffffff' : undefined }
                    : modern && i % 2 === 1
                      ? { backgroundColor: p.headerFill }
                      : undefined
                }
              >
                <Td theme={activeTheme} modern={modern} className="text-left px-1.5">{row.name}</Td>
                {row.cells.map((cell, j) => (
                  <Td
                    key={j}
                    theme={activeTheme}
                    modern={modern}
                    className="px-1 text-center"
                    style={modern && !row.isGrandTotal ? { color: p.primary, fontWeight: 600 } : undefined}
                  >
                    {cell}
                  </Td>
                ))}
                {sections.subjectPercentage && (
                  <td
                    className={`${modern ? 'border-0 px-2' : 'border'} py-1 align-middle`}
                    style={{ borderColor: p.line }}
                  >
                    {modern ? (
                      <div className="flex flex-col items-center gap-[2px]">
                        <span className="font-semibold" style={{ color: p.primary }}>
                          {subjectPercentage(row)}
                        </span>
                        <span
                          className="block h-[3px] w-full rounded-full overflow-hidden"
                          style={{ backgroundColor: p.line }}
                        >
                          <span
                            className="block h-full rounded-full"
                            style={{
                              width: `${subjectPercentageValue(row)}%`,
                              backgroundColor: p.overall,
                            }}
                          />
                        </span>
                      </div>
                    ) : (
                      <span className="block text-center rc-wrap">{subjectPercentage(row)}</span>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Summary ───────────────────────────────────────────── */}
      {modern ? (
        <div
          className="mt-3 rounded-md grid grid-cols-4 items-stretch overflow-hidden"
          style={{ backgroundColor: p.headerFill }}
        >
          <ResultCell
            label="Marks Obtained"
            value={model.totals.max ? `${model.totals.obtained} / ${model.totals.max}` : String(model.totals.obtained)}
            color={p.primary}
            dividerColor={p.line}
          />
          <ResultCell
            label="Percentage"
            value={percentageText}
            color={p.overall}
            dividerColor={p.line}
            divider
          />
          <ResultCell
            label="Overall Performance"
            value={model.overallPerformance}
            color={p.overall}
            dividerColor={p.line}
            divider
          />
          {/* Grade and result come from the model, never from the UI. */}
          <ResultCell
            label="Grade / Result"
            value={`${model.totals.grade} \u00b7 ${model.totals.result}`}
            color={p.overall}
            dividerColor={p.line}
            divider
          />
        </div>
      ) : (
        <div className="mt-3 grid grid-cols-4 gap-2 items-stretch">
          <SummaryBox theme={activeTheme} label="Marks Obtained" value={String(model.totals.obtained)} />
          <SummaryBox theme={activeTheme} label="Maximum Marks" value={model.totals.max ? String(model.totals.max) : '—'} />
          <SummaryBox theme={activeTheme} label="Percentage" value={percentageText} />
          <div
            className="rounded-sm overflow-hidden flex flex-col"
            style={{ border: `1px solid ${p.overall}` }}
          >
            <div
              className="text-white text-center py-1 font-bold uppercase rc-wrap"
              style={{ backgroundColor: p.overall, fontSize: mmCss(TYPE_MM.summaryLabel) }}
            >
              Overall Performance
            </div>
            <div
              className="flex-1 flex items-center justify-center text-center font-extrabold px-1 py-1 rc-wrap"
              style={{
                backgroundColor: p.overallSoft,
                color: p.overall,
                fontSize: mmCss(TYPE_MM.overallValue),
              }}
            >
              {model.overallPerformance}
            </div>
          </div>
        </div>
      )}

      {/*
       * Total · percentage · grade · result, exactly as the sidebar and the PDF
       * print them (one model string, so they cannot drift apart).
       */}
      {!modern && (
        <div
          className="mt-2 text-center font-bold rc-wrap"
          style={{ fontSize: mmCss(TYPE_MM.summaryLabel), color: p.overall }}
        >
          {model.totals.summary}
        </div>
      )}

      {sections.gradingScale && (
        <div className="mt-2 text-ink-700 rc-wrap" style={{ fontSize: mmCss(TYPE_MM.gradingScale) }}>
          <span className="font-bold uppercase">Grading Scale:</span> {model.gradeScale}
        </div>
      )}

      {sections.remarks && (
        <div className="mt-3 grid grid-cols-2 gap-2 items-start">
          {(['teacher', 'principal'] as const).map((kind) => (
            <div
              key={kind}
              className={`min-w-0 ${modern ? 'rounded-sm overflow-hidden pl-2 pr-2 py-1.5' : 'rounded-sm p-2 border'}`}
              style={
                modern
                  ? { backgroundColor: p.headerFill, borderLeft: `1.5mm solid ${p.primary}` }
                  : { borderColor: p.line }
              }
            >
              <div
                className="font-bold uppercase mb-1"
                style={{ color: modern ? p.primary : undefined, fontSize: mmCss(TYPE_MM.remarksLabel) }}
              >
                {kind === 'teacher' ? 'Teacher’s Remarks' : 'Principal’s Remarks'}
              </div>
              <p
                className="text-ink-700 leading-snug whitespace-pre-line rc-wrap"
                style={{ fontSize: mmCss(TYPE_MM.remarks) }}
              >
                {(kind === 'teacher' ? model.teacherRemarks : model.principalRemarks) || '—'}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* ── Signatures ────────────────────────────────────────── */}
      <div
        className={`${modern ? 'mt-5' : 'mt-6'} grid grid-cols-3 gap-2`}
        style={{ fontSize: mmCss(TYPE_MM.signatureName) }}
      >
        <SignBlock
          label="Class Teacher"
          name={model.signatures.teacherName}
          image={school.teacherSignDataUrl}
          modern={modern}
          accent={p.primary}
        />
        <SignBlock
          label="Checked by (Vice Principal)"
          name={model.signatures.checkedByName}
          image={school.checkedBySignDataUrl}
          modern={modern}
          accent={p.primary}
        />
        <SignBlock
          label="Principal"
          name={model.signatures.principalName}
          image={school.principalSignDataUrl}
          stamp={school.stampDataUrl}
          modern={modern}
          accent={p.primary}
        />
      </div>

      <div
        className="mt-3 rounded-sm text-center py-1 rc-wrap"
        style={
          modern
            ? { backgroundColor: p.primary, color: '#ffffff', fontSize: mmCss(TYPE_MM.footer) }
            : { border: `1px solid ${p.line}`, color: '#475569', fontSize: mmCss(TYPE_MM.footer) }
        }
      >
        This report card is generated from the marks recorded by the school.
      </div>
    </div>
  );
}

function subjectPercentage(row: { maxMarks: number | string; marks: number | string }): string {
  const max = typeof row.maxMarks === 'number' ? row.maxMarks : Number(row.maxMarks);
  const marks = typeof row.marks === 'number' ? row.marks : Number(row.marks);
  if (!Number.isFinite(max) || max <= 0 || !Number.isFinite(marks)) return '—';
  return `${Math.round((marks / max) * 10000) / 100}%`;
}

/** Numeric percentage for the modern performance bar (0 when unknown). */
function subjectPercentageValue(row: { maxMarks: number | string; marks: number | string }): number {
  const max = typeof row.maxMarks === 'number' ? row.maxMarks : Number(row.maxMarks);
  const marks = typeof row.marks === 'number' ? row.marks : Number(row.marks);
  if (!Number.isFinite(max) || max <= 0 || !Number.isFinite(marks)) return 0;
  return Math.max(0, Math.min(100, (marks / max) * 100));
}

function Th({
  children,
  className = '',
  theme,
  modern = false,
}: {
  children: React.ReactNode;
  className?: string;
  theme: ReportCardTheme;
  modern?: boolean;
}) {
  return (
    <th
      className={`${modern ? 'border-0' : 'border'} px-1 py-1 font-semibold rc-wrap ${className || 'text-center'}`}
      style={{ borderColor: theme.palette.line }}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  className = '',
  theme,
  modern = false,
  style,
}: {
  children: React.ReactNode;
  className?: string;
  theme: ReportCardTheme;
  modern?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <td
      className={`${modern ? 'border-0' : 'border'} py-1 align-top rc-wrap ${className}`}
      style={{ borderColor: theme.palette.line, ...style }}
    >
      {children}
    </td>
  );
}

function ResultCell({
  label,
  value,
  color,
  divider = false,
  dividerColor,
}: {
  label: string;
  value: string;
  color: string;
  divider?: boolean;
  dividerColor: string;
}) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-0.5 px-2 py-2 min-w-0"
      style={divider ? { borderLeft: `1px solid ${dividerColor}` } : undefined}
    >
      <div
        className="font-bold uppercase tracking-wide text-ink-500 rc-wrap"
        style={{ fontSize: mmCss(TYPE_MM.summaryLabel) }}
      >
        {label}
      </div>
      <div
        className="font-extrabold leading-tight rc-wrap"
        style={{ color, fontSize: mmCss(TYPE_MM.summaryValue) }}
      >
        {value}
      </div>
    </div>
  );
}

function SummaryBox({
  label,
  value,
  theme,
}: {
  label: string;
  value: string;
  theme: ReportCardTheme;
}) {
  return (
    <div className="rounded-sm overflow-hidden flex flex-col" style={{ border: `1px solid ${theme.palette.line}` }}>
      <div
        className="text-center py-1 font-bold uppercase rc-wrap"
        style={{ backgroundColor: theme.palette.headerFill, fontSize: mmCss(TYPE_MM.summaryLabel) }}
      >
        {label}
      </div>
      <div
        className="flex-1 flex items-center justify-center font-bold py-1 rc-wrap"
        style={{ fontSize: mmCss(TYPE_MM.summaryValue) }}
      >
        {value}
      </div>
    </div>
  );
}

function InfoColumn({
  items,
  modern = false,
  accent,
  chip,
}: {
  items: { label: string; value: string }[];
  modern?: boolean;
  accent: string;
  chip: string;
}) {
  return (
    <div className={`min-w-0 flex flex-col ${modern ? 'gap-[3px]' : 'gap-y-1'}`}>
      {items.map((item, i) => (
        <div
          key={i}
          className={`flex gap-1 min-w-0 items-start ${modern ? 'rounded-sm px-2 py-[3px]' : ''}`}
          style={modern ? { backgroundColor: chip } : undefined}
        >
          <span
            className="font-semibold w-[27mm] shrink-0 rc-wrap"
            style={{ color: modern ? accent : undefined, fontSize: mmCss(TYPE_MM.info) }}
          >
            {item.label}
          </span>
          <span className="text-ink-500 shrink-0" style={{ fontSize: mmCss(TYPE_MM.info) }}>
            :
          </span>
          {/* Value wraps onto as many lines as it needs — never truncated. */}
          <span
            className="flex-1 min-w-0 whitespace-normal rc-wrap text-ink-900"
            style={{ fontSize: mmCss(TYPE_MM.info) }}
          >
            {item.value || '—'}
          </span>
        </div>
      ))}
    </div>
  );
}

function SignBlock({
  label,
  name,
  image,
  stamp,
  modern = false,
  accent,
}: {
  label: string;
  name?: string;
  image?: string;
  stamp?: string;
  modern?: boolean;
  accent: string;
}) {
  return (
    <div className="text-center min-w-0">
      <div className={`${modern ? 'h-[14mm]' : 'h-[16mm]'} flex items-end justify-center relative`}>
        {image ? (
          <img src={image} alt="" className="max-h-[14mm] object-contain" />
        ) : (
          <span style={{ fontSize: mmCss(TYPE_MM.footer) }} className="text-ink-300">
            Signature
          </span>
        )}
        {stamp && <img src={stamp} alt="" className="absolute -right-1 -top-1 h-[16mm] object-contain opacity-80" />}
      </div>
      <div
        className="mt-0.5 pt-0.5"
        style={
          modern
            ? { borderTop: `2px solid ${accent}` }
            : { borderTop: '1px solid #94a3b8' }
        }
      >
        <div className="font-semibold text-ink-900 rc-wrap">{name || ''}</div>
        <div
          className="font-bold uppercase tracking-wide rc-wrap"
          style={{ color: modern ? accent : '#475569', fontSize: mmCss(TYPE_MM.footer) }}
        >
          {label}
        </div>
      </div>
    </div>
  );
}

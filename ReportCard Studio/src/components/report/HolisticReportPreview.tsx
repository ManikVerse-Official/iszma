import type { ReactNode } from 'react';
import type { SchoolProfile, Student } from '../../types';
import { buildReportCardModel } from '../../services/reportCardModel';
import { getTheme, type ReportCardTheme } from '../../themes';
import {
  academicColumnRatios,
  ATTENDANCE_BAR_H,
  BODY_GAP_MM,
  CO_VALUE_W_MM,
  LOGO_MM,
  MARGIN_MM,
  OVERALL_BAR_H,
  OVERALL_MIN_H_MM,
  PHOTO_H_MM,
  PHOTO_W_MM,
  RIGHT_W_MM,
  SECTION_BAR_H,
  SESSION_LABEL_H_MM,
  SESSION_VALUE_H_MM,
  SESSION_W_MM,
  SKILLS_BAR_H,
  SKILLS_GAP_MM,
  TITLE_BAR_H,
  LEFT_W_MM,
} from '../../themes/geometry';
import {
  DENSITY_SCALE,
  densityTierFor,
  mmCss,
  TYPE_MM,
  type DensityTier,
} from '../../themes/typography';

interface Props {
  student: Student;
  school: SchoolProfile;
  photoDataUrl?: string;
  theme?: ReportCardTheme;
}

/*
 * The report card is an A4 sheet, so the preview must never grow past one page.
 * The PDF fits any number of subjects by shrinking its row height; the preview
 * mirrors that by picking a density tier based on how many subjects the student
 * has.
 *
 * Geometry (column widths, gutters, bar heights, header furniture) is imported
 * from `themes/geometry.ts` — the exact same numbers the PDF renderer uses — so
 * what you see here is what gets printed. Layout rules that must never regress:
 *   - every cell wraps; text is never truncated or clipped;
 *   - every flex/grid child is min-w-0 so long names/remarks cannot push a
 *     neighbouring field out of its column;
 *   - nothing overlaps, whatever the length of the school name, father's name,
 *     subject names or remarks.
 */
interface DensityTokens {
  /** Font shrink factor for this tier — applied to every TYPE_MM size. */
  scale: number;
  sectionGap: string;
  acadPad: string;
  acadHeadPad: string;
  coPad: string;
  skillPad: string;
  attPad: string;
  infoGap: string;
  infoPad: string;
  remarkPad: string;
  remarkMinH: string;
  sigGap: string;
  sigBox: string;
  sigImg: string;
  sigStamp: string;
}

/**
 * Font size for a shared TYPE_MM value at this density: the same mm the PDF
 * prints, because CSS mm is an absolute unit. Text can therefore never be a
 * different physical size on screen than on paper.
 */
function font(tokens: DensityTokens, baseMm: number): string {
  return mmCss(baseMm * tokens.scale);
}

const DENSITY: Record<DensityTier, DensityTokens> = {
  normal: {
    scale: DENSITY_SCALE.normal,
    sectionGap: 'mt-[2mm]',
    acadPad: 'py-[1.4mm]',
    acadHeadPad: 'py-[1.6mm]',
    coPad: 'py-[1.5mm]',
    skillPad: 'py-[1.2mm]',
    attPad: 'py-[1.5mm]',
    infoGap: 'gap-y-[1mm]',
    infoPad: 'p-[2mm]',
    remarkPad: 'p-[2mm]',
    remarkMinH: 'min-h-[9mm]',
    sigGap: 'mt-[4mm]',
    sigBox: 'h-[16mm]',
    sigImg: 'max-h-[14mm]',
    sigStamp: 'h-[16mm]',
  },
  compact: {
    scale: DENSITY_SCALE.compact,
    sectionGap: 'mt-[1.6mm]',
    acadPad: 'py-[1mm]',
    acadHeadPad: 'py-[1.1mm]',
    coPad: 'py-[1mm]',
    skillPad: 'py-[0.8mm]',
    attPad: 'py-[1mm]',
    infoGap: 'gap-y-[0.6mm]',
    infoPad: 'p-[1.5mm]',
    remarkPad: 'p-[1.5mm]',
    remarkMinH: 'min-h-[8mm]',
    sigGap: 'mt-[3mm]',
    sigBox: 'h-[14mm]',
    sigImg: 'max-h-[12mm]',
    sigStamp: 'h-[14mm]',
  },
  ultra: {
    scale: DENSITY_SCALE.ultra,
    sectionGap: 'mt-[1.2mm]',
    acadPad: 'py-[0.6mm]',
    acadHeadPad: 'py-[0.8mm]',
    coPad: 'py-[0.6mm]',
    skillPad: 'py-[0.5mm]',
    attPad: 'py-[0.6mm]',
    infoGap: 'gap-y-[0.4mm]',
    infoPad: 'p-[1mm]',
    remarkPad: 'p-[1mm]',
    remarkMinH: 'min-h-[6mm]',
    sigGap: 'mt-[2mm]',
    sigBox: 'h-[12mm]',
    sigImg: 'max-h-[10mm]',
    sigStamp: 'h-[12mm]',
  },
};

function pickDensity(rows: number): DensityTokens {
  // `rows` counts the academic table including the GRAND TOTAL row.
  return DENSITY[densityTierFor(rows)];
}

/** Section bar used for the title and every table header, at the PDF height. */
function SectionBar({
  children,
  heightMm,
  background,
  color = 'inherit',
  border,
  tokens,
  className = '',
}: {
  children: ReactNode;
  heightMm: number;
  background: string;
  color?: string;
  border?: string;
  tokens: DensityTokens;
  className?: string;
}) {
  return (
    <div
      className={`w-full flex items-center justify-center text-center font-bold uppercase rc-wrap ${className}`}
      style={{
        height: `${heightMm}mm`,
        fontSize: font(tokens, TYPE_MM.sectionBar),
        backgroundColor: background,
        color,
        border: border ? `1px solid ${border}` : undefined,
        boxSizing: 'border-box',
      }}
    >
      {children}
    </div>
  );
}

function Stars({ value, max, theme }: { value: number; max: number; theme: ReportCardTheme }) {
  const filled = Math.max(0, Math.min(max, value));
  return (
    <span
      className="tracking-[2px] whitespace-nowrap"
      style={{ color: theme.palette.accent }}
      aria-label={`${filled} of ${max} stars`}
    >
      {'★'.repeat(filled)}
      <span className="text-slate-300">{'★'.repeat(Math.max(0, max - filled))}</span>
    </span>
  );
}

export default function HolisticReportPreview({ student, school, photoDataUrl, theme }: Props) {
  const model = buildReportCardModel(student, school);
  const activeTheme = theme ?? getTheme(model.themeId);
  const p = activeTheme.palette;
  const { header } = model;
  const d = pickDensity(model.academic.length);
  const maxStars = model.assessment.maxStars;

  const affiliationLine = [
    header.affiliationText,
    header.schoolCode ? `SCHOOL CODE: ${header.schoolCode}` : '',
    header.affiliationNo ? `AFFILIATION NO.: ${header.affiliationNo}` : '',
  ]
    .filter(Boolean)
    .join(' | ');

  return (
    <div
      data-testid="report-card"
      className="bg-white shadow-card border border-slate-300 rounded-lg overflow-hidden mx-auto text-ink-900"
      style={{
        width: '100%',
        maxWidth: '210mm',
        minWidth: 0,
        minHeight: '297mm',
        padding: `${MARGIN_MM}mm`,
        boxSizing: 'border-box',
        // Column flex so the body stretches to fill the A4 sheet — the preview
        // then matches the PDF, which grows its rows to fill the page.
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* ── Header ───────────────────────────────────────────────
          Mirrors drawHeader(): 20mm logo on the left, an 18×22mm photo pinned
          top-right, and the centred school block in between (23mm / 21mm
          horizontal insets so the text column is exactly 150mm wide). */}
      <div className="relative" style={{ minHeight: `${PHOTO_H_MM}mm` }}>
        <div
          className="absolute left-0 top-0 flex flex-col items-center justify-start"
          style={{ width: `${LOGO_MM}mm` }}
        >
          {header.logoDataUrl ? (
            <img
              src={header.logoDataUrl}
              alt="logo"
              className="object-contain"
              style={{ width: `${LOGO_MM}mm`, height: `${LOGO_MM}mm` }}
            />
          ) : (
            <div
              className="border border-slate-300"
              style={{ width: `${LOGO_MM}mm`, height: `${LOGO_MM}mm` }}
            />
          )}
          {header.tagline && (
            <span className="text-[6.5px] tracking-wide text-center uppercase text-ink-500 mt-0.5 leading-tight rc-wrap">
              {header.tagline}
            </span>
          )}
        </div>

        <div
          className="min-w-0 text-center"
          style={{ marginLeft: `${LOGO_MM + 3}mm`, marginRight: '21mm' }}
        >
          <h1
            className="text-[22px] leading-tight font-extrabold tracking-wide uppercase rc-wrap"
            style={{ color: p.primary }}
          >
            {header.schoolName}
          </h1>
          {header.address && (
            <p className="text-[11px] text-ink-700 mt-[0.6mm] rc-wrap">{header.address}</p>
          )}
          {affiliationLine && (
            <p className="text-[10px] text-ink-700 mt-[1.2mm] rc-wrap">{affiliationLine}</p>
          )}
          {/* Academic session — centred directly under the address, matching the PDF. */}
          <div className="mt-[1.5mm] flex flex-col items-center">
            <div
              className="rounded-t-md text-white text-[9px] font-semibold uppercase px-1 flex items-center justify-center rc-wrap text-center"
              style={{
                width: `${SESSION_W_MM}mm`,
                height: `${SESSION_LABEL_H_MM}mm`,
                backgroundColor: p.primary,
              }}
            >
              Academic Session
            </div>
            <div
              className="rounded-b-md text-[13px] font-bold rc-wrap text-center"
              style={{
                width: `${SESSION_W_MM}mm`,
                height: `${SESSION_VALUE_H_MM}mm`,
                border: `1px solid ${p.primary}`,
                borderTop: 'none',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {header.academicSession || '—'}
            </div>
          </div>
        </div>

        {/* Student photo — top-aligned in the right gutter, never over any text. */}
        <div
          className="absolute top-0"
          style={{ right: 0, width: `${PHOTO_W_MM}mm`, height: `${PHOTO_H_MM}mm` }}
        >
          <div
            className="w-full h-full rounded-sm overflow-hidden flex items-center justify-center"
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

      {/* ── Title ──────────────────────────────────────────────── */}
      <div className="mt-[2mm]">
        <SectionBar
          heightMm={TITLE_BAR_H}
          background={p.primary}
          color="#ffffff"
          tokens={d}
          className="tracking-wide"
        >
          {model.title}
        </SectionBar>
      </div>

      {/* ── Student info ──────────────────────────────────────── */}
      <div
        className={`${d.sectionGap} rounded-sm ${d.infoPad} grid grid-cols-2 items-start`}
        style={{
          border: `1px solid ${p.primary}`,
          columnGap: '4mm',
        }}
      >
        <InfoColumn items={model.infoLeft} tokens={d} />
        <InfoColumn items={model.infoRight} tokens={d} />
      </div>

      {/*
       * Body — LEFT: academic + skills (122mm). RIGHT: co-scholastic →
       * attendance → overall as ONE continuous column (68mm), with the same
       * 4mm gutter the PDF uses. Previously the columns were split 2.15fr/1fr,
       * which made the right column noticeably wider than the printed card.
       */}
      <div
        className={`${d.sectionGap} grid items-stretch`}
        style={{
          gridTemplateColumns: `${LEFT_W_MM}mm ${RIGHT_W_MM}mm`,
          columnGap: `${BODY_GAP_MM}mm`,
          flex: '1 1 auto',
          minHeight: 0,
        }}
      >
        <div className="min-w-0 flex flex-col">
          <SectionBar
            heightMm={SECTION_BAR_H}
            background={p.headerFill}
            border={p.line}
            tokens={d}
          >
            Academic Performance
          </SectionBar>
          <table
            data-rc-section="academic"
            className="w-full border-collapse table-fixed"
            // Rows grow into the spare height, mirroring the PDF's row fill.
            // Font size comes from the shared TYPE_MM scale, so the printed card
            // and this preview are the same physical size.
            style={{ flex: '1 1 auto', fontSize: font(d, TYPE_MM.academic) }}
          >
            <colgroup>
              {academicColumnRatios(model.academicColumns.length).map((ratio, i) => (
                <col key={i} style={{ width: `${ratio * 100}%` }} />
              ))}
            </colgroup>
            {/*
             * Header mirrors the uploaded sheet: the workbook's own component
             * columns (PT / NB / SEA / SA2 …) followed by the Total column. There
             * is no Grade column and no Remarks column inside the academic table.
             */}
            <thead>
              <tr style={{ backgroundColor: '#f8fafc' }} className="text-ink-800">
                <th className={`border ${d.acadHeadPad} px-1.5 text-left font-semibold uppercase rc-wrap`} style={{ borderColor: p.line }}>Subjects</th>
                {model.academicColumns.map((column, i) => (
                  <th
                    key={i}
                    className={`border ${d.acadHeadPad} px-0.5 font-semibold uppercase rc-wrap`}
                    style={{ borderColor: p.line }}
                  >
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {model.academic.map((row, i) => (
                <tr
                  key={i}
                  className={row.isGrandTotal ? 'font-semibold' : ''}
                  style={row.isGrandTotal ? { backgroundColor: p.totalFill } : undefined}
                >
                  <td className={`border px-1.5 ${d.acadPad} align-middle rc-wrap`} style={{ borderColor: p.line }}>
                    {row.name}
                  </td>
                  {row.cells.map((cell, j) => (
                    <td
                      key={j}
                      className={`border px-0.5 ${d.acadPad} text-center align-middle rc-wrap`}
                      style={{ borderColor: p.line }}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>

          <div
            className="mt-[1.4mm] text-ink-700 rc-wrap"
            style={{ fontSize: font(d, TYPE_MM.gradingScale) }}
          >
            <span className="font-bold uppercase">Grading Scale:</span> {model.gradeScale}
          </div>

          {/* Skills — two 59.5mm boxes with the PDF's 3mm gutter. */}
          <div
            data-rc-section="skills"
            className="mt-[2mm] grid min-w-0"
            style={{ gridTemplateColumns: '1fr 1fr', columnGap: `${SKILLS_GAP_MM}mm` }}
          >
            <SkillTable
              title="Personality Development"
              rows={model.personality}
              headerFill={p.skillsFillWarm}
              theme={activeTheme}
              tokens={d}
              maxStars={maxStars}
            />
            <SkillTable
              title="Learning Skills"
              rows={model.learning}
              headerFill={p.skillsFillCool}
              theme={activeTheme}
              tokens={d}
              maxStars={maxStars}
            />
          </div>
        </div>

        <div className="min-w-0 flex flex-col">
          <SectionBar
            heightMm={SECTION_BAR_H}
            background={p.coScholasticFill}
            border={p.line}
            tokens={d}
          >
            Co-scholastic Areas (Grades)
          </SectionBar>
          <table
            data-rc-section="co"
            className="w-full border-collapse table-fixed"
            style={{ fontSize: font(d, TYPE_MM.coScholastic) }}
          >
            <colgroup>
              <col />
              <col style={{ width: `${CO_VALUE_W_MM}mm` }} />
            </colgroup>
            <tbody>
              {model.coScholastic.map((row, i) => (
                <tr key={i}>
                  <td
                    className={`border px-1.5 ${d.coPad} uppercase align-middle rc-wrap`}
                    style={{ borderColor: p.line }}
                  >
                    {row.name}
                  </td>
                  <td
                    className={`border px-1 ${d.coPad} text-center font-semibold align-middle rc-wrap`}
                    style={{ borderColor: p.line }}
                  >
                    {row.value || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Bounded flexible gap — shares the slack instead of pooling it into
              one blank area (mirrors the PDF's RIGHT_GAP_MAX). */}
          <div aria-hidden style={{ flex: '1 1 0%', minHeight: 6, maxHeight: '12mm' }} />

          <div
            data-rc-section="holistic-development"
            className="rounded-sm overflow-hidden"
            style={{ border: `1px solid ${p.line}` }}
          >
            <SectionBar
              heightMm={ATTENDANCE_BAR_H}
              background={p.coScholasticFill}
              border={p.line}
              tokens={d}
              className="!border-0"
              >
              Holistic Development Profile
            </SectionBar>
            <table
              className="w-full table-fixed border-collapse"
              style={{ fontSize: font(d, TYPE_MM.holisticValue) }}
            >
              <colgroup>
                <col />
                <col style={{ width: `${CO_VALUE_W_MM}mm` }} />
              </colgroup>
              <tbody>
                {model.holisticDevelopment.map((row, i) => (
                  <tr key={i}>
                    <td
                      className={`border px-1.5 ${d.coPad} align-middle rc-wrap`}
                      style={{ borderColor: p.line }}
                    >
                      {row.name}
                    </td>
                    <td
                      className={`border px-1 ${d.coPad} text-center font-semibold align-middle rc-wrap`}
                      style={{ borderColor: p.line }}
                    >
                      {row.value || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div aria-hidden style={{ flex: '1 1 0%', minHeight: 6, maxHeight: '12mm' }} />

          {/* The overall panel absorbs whatever is left, like the PDF output. */}
          <div
            data-rc-section="overall"
            className="rounded-sm overflow-hidden flex flex-col"
            style={{
              flex: '1 1 0%',
              minHeight: `${OVERALL_MIN_H_MM}mm`,
              border: `1px solid ${p.overall}`,
            }}
          >
            <SectionBar
              heightMm={OVERALL_BAR_H}
              background={p.overall}
              color="#ffffff"
              tokens={d}
            >
              Overall Performance
            </SectionBar>
            <div
              className="flex-1 flex flex-col items-center justify-center text-center py-2 gap-1"
              style={{ backgroundColor: p.overallSoft, color: p.overall }}
            >
              <div className="font-extrabold rc-wrap" style={{ fontSize: font(d, TYPE_MM.overallValue) }}>
                {model.overallPerformance}
              </div>
              {/*
               * Percentage · grade · result as ONE line taken from the model, so
               * the card and the PDF can never print different wording for the
               * same numbers. (The total sits in the GRAND TOTAL row above.)
               */}
              {model.totals.percentage !== null && (
                <div className="font-bold rc-wrap" style={{ fontSize: font(d, TYPE_MM.overallLabel) }}>
                  {model.totals.summaryShort}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Remarks ───────────────────────────────────────────── */}
      <div
        data-rc-section="remarks"
        className={`${d.sectionGap} grid grid-cols-2 rounded-sm ${d.remarkPad} items-start`}
        style={{ border: `1px solid ${p.line}`, columnGap: '4mm', fontSize: font(d, TYPE_MM.remarks) }}
      >
        <div className="min-w-0">
          <div className="font-bold uppercase mb-1">Teacher&rsquo;s Remarks</div>
          <p className={`text-ink-700 leading-snug whitespace-pre-line rc-wrap ${d.remarkMinH}`}>
            {model.teacherRemarks || '—'}
          </p>
        </div>
        <div className="min-w-0 border-l border-slate-200 pl-2">
          <div className="font-bold uppercase mb-1">Principal&rsquo;s Remarks</div>
          <p className={`text-ink-700 leading-snug whitespace-pre-line rc-wrap ${d.remarkMinH}`}>
            {model.principalRemarks || '—'}
          </p>
        </div>
      </div>

      {/* ── Signatures ────────────────────────────────────────── */}
      <div
        className={`${d.sigGap} grid grid-cols-3 gap-2`}
        style={{ fontSize: font(d, TYPE_MM.signatureName) }}
      >
        <SignBlock
          label="Class Teacher"
          name={model.signatures.teacherName}
          image={school.teacherSignDataUrl}
          tokens={d}
        />
        <SignBlock
          label="Checked by (Vice Principal)"
          name={model.signatures.checkedByName}
          image={school.checkedBySignDataUrl}
          tokens={d}
        />
        <SignBlock
          label="Principal"
          name={model.signatures.principalName}
          image={school.principalSignDataUrl}
          stamp={school.stampDataUrl}
          tokens={d}
        />
      </div>

      <div
        data-rc-section="footer-note"
        className={`${d.sectionGap} rounded-sm text-center text-ink-600 py-1 rc-wrap`}
        style={{ border: `1px solid ${p.line}`, fontSize: font(d, TYPE_MM.footer) }}
      >
        This Report Card reflects the holistic development of the child and is a shared responsibility of the school and parents.
      </div>
    </div>
  );
}

function InfoColumn({ items, tokens }: { items: { label: string; value: string }[]; tokens: DensityTokens }) {
  const infoFont = { fontSize: font(tokens, TYPE_MM.info) };
  return (
    <div className={`min-w-0 ${tokens.infoGap} flex flex-col`}>
      {items.map((item, i) => (
        <div key={i} className="flex gap-1 min-w-0 items-start">
          <span
            className="font-semibold text-ink-700 w-[30mm] shrink-0 rc-wrap"
            style={infoFont}
          >
            {item.label}
          </span>
          <span className="text-ink-500 shrink-0" style={infoFont}>
            :
          </span>
          {/* Value wraps onto as many lines as it needs — never truncated. */}
          <span className="flex-1 min-w-0 whitespace-normal rc-wrap text-ink-900" style={infoFont}>
            {item.value || '—'}
          </span>
        </div>
      ))}
    </div>
  );
}

function SkillTable({
  title,
  rows,
  headerFill,
  theme,
  tokens,
  maxStars,
}: {
  title: string;
  rows: { name: string; stars?: number }[];
  headerFill: string;
  theme: ReportCardTheme;
  tokens: DensityTokens;
  maxStars: number;
}) {
  return (
    <div className="rounded-sm overflow-hidden min-w-0" style={{ border: `1px solid ${theme.palette.line}` }}>
      <SectionBar heightMm={SKILLS_BAR_H} background={headerFill} tokens={tokens} className="!border-0">
        {title}
      </SectionBar>
      <table className="w-full table-fixed" style={{ fontSize: font(tokens, TYPE_MM.skills) }}>
        <colgroup>
          <col style={{ width: '60%' }} />
          <col style={{ width: '40%' }} />
        </colgroup>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-slate-100 last:border-0">
              <td className={`px-1.5 ${tokens.skillPad} uppercase text-ink-700 align-middle rc-wrap`}>
                {row.name}
              </td>
              <td className={`px-1 ${tokens.skillPad} text-center whitespace-nowrap`}>
                <Stars value={row.stars ?? 0} max={maxStars} theme={theme} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SignBlock({
  label,
  name,
  image,
  stamp,
  tokens,
}: {
  label: string;
  name?: string;
  image?: string;
  stamp?: string;
  tokens: DensityTokens;
}) {
  return (
    <div className="text-center min-w-0">
      <div className={`${tokens.sigBox} flex items-end justify-center relative`}>
        {image ? (
          <img src={image} alt="" className={`${tokens.sigImg} object-contain`} />
        ) : (
          <span className="text-[9px] text-ink-300">Signature</span>
        )}
        {stamp && (
          <img src={stamp} alt="" className={`absolute -right-1 -top-1 ${tokens.sigStamp} object-contain opacity-80`} />
        )}
      </div>
      <div className="border-t border-slate-400 mt-0.5 pt-0.5">
        <div className="font-semibold text-ink-900 rc-wrap">{name || ''}</div>
        <div
          className="font-bold uppercase tracking-wide text-ink-600 rc-wrap"
          style={{ fontSize: font(tokens, TYPE_MM.footer) }}
        >
          {label}
        </div>
      </div>
    </div>
  );
}

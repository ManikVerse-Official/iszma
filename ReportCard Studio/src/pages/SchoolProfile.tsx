import type { ChangeEvent, CSSProperties } from 'react';
import { useAppStore } from '../store/appStore';
import { Upload, Trash2, Save, Check } from 'lucide-react';
import { fileToDataUrl } from '../services/photoMatcher';
import { useState } from 'react';
import { DEFAULT_THEME_ID, REPORT_CARD_THEMES } from '../themes';
import SignatureExtractorDialog from '../components/SignatureExtractorDialog';

/** Profile fields that hold an uploaded image. */
type ImageField =
  | 'logoDataUrl'
  | 'principalSignDataUrl'
  | 'teacherSignDataUrl'
  | 'checkedBySignDataUrl'
  | 'stampDataUrl';

/**
 * Signature and stamp photos are cleaned up before they are stored: the paper
 * and its shadow are removed in the browser and only the ink is kept as a
 * transparent PNG. Logos keep the plain upload. "Keep original" is always
 * available in the dialog, so a photo the extractor cannot handle safely is
 * never destroyed.
 */
const EXTRACTED_FIELDS: ReadonlySet<ImageField> = new Set<ImageField>([
  'principalSignDataUrl',
  'teacherSignDataUrl',
  'checkedBySignDataUrl',
  'stampDataUrl',
]);

/** Transparent preview so an extracted signature is obvious at a glance. */
const CHECKERBOARD: CSSProperties = {
  backgroundColor: '#ffffff',
  backgroundImage:
    'linear-gradient(45deg, #e2e8f0 25%, transparent 25%), linear-gradient(-45deg, #e2e8f0 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #e2e8f0 75%), linear-gradient(-45deg, transparent 75%, #e2e8f0 75%)',
  backgroundSize: '12px 12px',
  backgroundPosition: '0 0, 0 6px, 6px -6px, -6px 0',
};

const FIELD_LABELS: Partial<Record<ImageField, string>> = {
  principalSignDataUrl: "Principal's Signature",
  teacherSignDataUrl: "Teacher's Signature",
  checkedBySignDataUrl: 'Checked by Signature',
  stampDataUrl: 'School Stamp',
};

export default function SchoolProfile() {
  const profile = useAppStore((s) => s.schoolProfile);
  const setProfile = useAppStore((s) => s.setSchoolProfile);
  const [saved, setSaved] = useState(false);
  const [extracting, setExtracting] = useState<{ field: ImageField; file: File } | null>(null);

  const update = (k: keyof typeof profile, v: string) => {
    setProfile({ [k]: v });
    setSaved(false);
  };

  const onImage = (k: ImageField) => async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Allow picking the same file again after a cancel.
    e.target.value = '';
    if (!file) return;

    if (EXTRACTED_FIELDS.has(k)) {
      setExtracting({ field: k, file });
      return;
    }

    const dataUrl = await fileToDataUrl(file);
    setProfile({ [k]: dataUrl });
    setSaved(false);
  };

  const clearImage = (k: ImageField) => () => {
    setProfile({ [k]: undefined });
    setSaved(false);
  };

  const handleSave = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-ink-900">School Profile</h2>
          <p className="text-sm text-ink-500">
            Configure your school information, logos, and signatures. Stored locally in your browser.
          </p>
        </div>
        <button onClick={handleSave} className="btn-primary">
          {saved ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />}
          {saved ? 'Saved' : 'Save Profile'}
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="card lg:col-span-2">
          <div className="card-header">
            <h3 className="font-semibold text-ink-900">School & Examination Details</h3>
          </div>
          <div className="card-body grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <label className="label">School Name *</label>
              <input
                className="input"
                placeholder="e.g. Delhi Public School"
                value={profile.schoolName}
                onChange={(e) => update('schoolName', e.target.value)}
              />
            </div>
            <div className="md:col-span-2">
              <label className="label">School Address</label>
              <textarea
                className="input min-h-[72px]"
                placeholder="Full address with city, state, PIN"
                value={profile.address}
                onChange={(e) => update('address', e.target.value)}
              />
            </div>
            <div className="md:col-span-2">
              <label className="label">Tagline (shown under the logo)</label>
              <input
                className="input"
                placeholder="DISCIPLINE • DEDICATION • EXCELLENCE"
                value={profile.tagline ?? ''}
                onChange={(e) => update('tagline', e.target.value)}
              />
            </div>
            <div className="md:col-span-2">
              <label className="label">Affiliation line</label>
              <input
                className="input"
                placeholder="AFFILIATED TO C.B.S.E., NEW DELHI"
                value={profile.affiliationText ?? ''}
                onChange={(e) => update('affiliationText', e.target.value)}
              />
            </div>
            <div>
              <label className="label">School Code</label>
              <input
                className="input"
                placeholder="e.g. 41627"
                value={profile.schoolCode ?? ''}
                onChange={(e) => update('schoolCode', e.target.value)}
              />
            </div>
            <div>
              <label className="label">Affiliation No.</label>
              <input
                className="input"
                placeholder="e.g. 531651"
                value={profile.affiliationNo ?? ''}
                onChange={(e) => update('affiliationNo', e.target.value)}
              />
            </div>
            <div>
              <label className="label">Academic Session *</label>
              <input
                className="input"
                placeholder="e.g. 2025-2026"
                value={profile.academicSession}
                onChange={(e) => update('academicSession', e.target.value)}
              />
            </div>
            <div>
              <label className="label">Exam / Term *</label>
              <input
                className="input"
                placeholder="e.g. Periodic Test - I"
                value={profile.examTerm}
                onChange={(e) => update('examTerm', e.target.value)}
              />
            </div>
            <div>
              <label className="label">Date of Issue</label>
              <input
                className="input"
                placeholder="e.g. 14-08-2026"
                value={profile.dateOfIssue ?? ''}
                onChange={(e) => update('dateOfIssue', e.target.value)}
              />
            </div>
            <div>
              <label className="label">Grading Scale (optional)</label>
              <input
                className="input"
                placeholder="A1 (91-100)  A2 (81-90) ..."
                value={profile.gradingScale ?? ''}
                onChange={(e) => update('gradingScale', e.target.value)}
              />
            </div>
            <div>
              <label className="label">Class Teacher Name</label>
              <input
                className="input"
                placeholder="Ms. Priya Verma"
                value={profile.teacherName}
                onChange={(e) => update('teacherName', e.target.value)}
              />
            </div>
            <div>
              <label className="label">Checked by (Vice Principal)</label>
              <input
                className="input"
                placeholder="Mrs. Zahida"
                value={profile.checkedByName ?? ''}
                onChange={(e) => update('checkedByName', e.target.value)}
              />
            </div>
            <div className="md:col-span-2">
              <label className="label">Principal Name</label>
              <input
                className="input"
                placeholder="Dr. R. K. Sharma"
                value={profile.principalName}
                onChange={(e) => update('principalName', e.target.value)}
              />
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h3 className="font-semibold text-ink-900">Visual Identity</h3>
            <p className="text-xs text-ink-500 mt-1">
              PNG / JPG files are recommended. Max 2 MB each.
            </p>
          </div>
          <div className="card-body space-y-4">
            <ImagePicker
              label="School Logo"
              value={profile.logoDataUrl}
              onChange={onImage('logoDataUrl')}
              onClear={clearImage('logoDataUrl')}
              hint="Square or slightly rectangular works best."
            />
            <ImagePicker
              label="Principal's Signature"
              value={profile.principalSignDataUrl}
              onChange={onImage('principalSignDataUrl')}
              onClear={clearImage('principalSignDataUrl')}
              hint="Upload a photo or scan — the paper background is removed automatically."
            />
            <ImagePicker
              label="Teacher's Signature"
              value={profile.teacherSignDataUrl}
              onChange={onImage('teacherSignDataUrl')}
              onClear={clearImage('teacherSignDataUrl')}
              hint="Upload a photo or scan — the paper background is removed automatically."
            />
            <ImagePicker
              label="Checked by Signature"
              value={profile.checkedBySignDataUrl}
              onChange={onImage('checkedBySignDataUrl')}
              onClear={clearImage('checkedBySignDataUrl')}
              hint="Vice Principal / coordinator signature (optional)."
            />
            <ImagePicker
              label="School Stamp (Optional)"
              value={profile.stampDataUrl}
              onChange={onImage('stampDataUrl')}
              onClear={clearImage('stampDataUrl')}
              hint="Photograph or scan the stamp — only the imprint is kept."
              stamp
            />
          </div>
        </div>
      </div>

      {/* ── Report card theme ────────────────────────────────── */}
      <div className="card">
        <div className="card-header">
          <h3 className="font-semibold text-ink-900">Report Card Theme</h3>
          <p className="text-xs text-ink-500 mt-1">
            The selected theme is used for the preview and for every generated PDF. You can switch
            it at any time — no other setting changes.
          </p>
        </div>
        <div className="card-body grid grid-cols-1 sm:grid-cols-3 gap-3">
          {REPORT_CARD_THEMES.map((theme) => {
            const active = (profile.reportTheme ?? DEFAULT_THEME_ID) === theme.id;
            return (
              <button
                key={theme.id}
                type="button"
                onClick={() => {
                  setProfile({ reportTheme: theme.id });
                  setSaved(false);
                }}
                className={`text-left rounded-xl border p-3 transition-colors ${
                  active
                    ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-300'
                    : 'border-slate-200 hover:border-brand-300'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className="h-4 w-4 rounded-full shrink-0"
                    style={{ backgroundColor: theme.palette.primary }}
                  />
                  <span className="font-semibold text-sm text-ink-900">{theme.name}</span>
                  {active && <Check className="h-4 w-4 text-brand-600 ml-auto shrink-0" />}
                </div>
                <p className="text-xs text-ink-500 mt-1.5 leading-snug rc-wrap">{theme.description}</p>
              </button>
            );
          })}
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3 className="font-semibold text-ink-900">Profile Checklist</h3>
        </div>
        <div className="card-body grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 text-sm">
          <CheckItem ok={Boolean(profile.schoolName)} label="School Name" />
          <CheckItem ok={Boolean(profile.address)} label="Address" />
          <CheckItem ok={Boolean(profile.logoDataUrl)} label="Logo Uploaded" />
          <CheckItem ok={Boolean(profile.academicSession)} label="Academic Session" />
          <CheckItem ok={Boolean(profile.examTerm)} label="Exam / Term" />
          <CheckItem ok={Boolean(profile.principalName)} label="Principal Name" />
          <CheckItem ok={Boolean(profile.teacherName)} label="Teacher Name" />
          <CheckItem ok={Boolean(profile.affiliationText)} label="Affiliation Line" />
          <CheckItem ok={Boolean(profile.dateOfIssue)} label="Date of Issue" />
          <CheckItem ok label={`Theme: ${REPORT_CARD_THEMES.find((t) => t.id === (profile.reportTheme ?? DEFAULT_THEME_ID))?.name ?? DEFAULT_THEME_ID}`} />
          <CheckItem ok={Boolean(profile.principalSignDataUrl)} label="Principal Signature" />
          <CheckItem ok={Boolean(profile.teacherSignDataUrl)} label="Teacher Signature" />
          <CheckItem ok={Boolean(profile.stampDataUrl)} label="School Stamp" />
        </div>
      </div>

      <SignatureExtractorDialog
        open={extracting !== null}
        kind={extracting?.field === 'stampDataUrl' ? 'stamp' : 'signature'}
        label={extracting ? FIELD_LABELS[extracting.field] ?? 'Image' : 'Image'}
        file={extracting?.file ?? null}
        onCancel={() => setExtracting(null)}
        onApply={(dataUrl) => {
          if (!extracting) return;
          setProfile({ [extracting.field]: dataUrl });
          setSaved(false);
          setExtracting(null);
        }}
        onKeepOriginal={(dataUrl) => {
          if (!extracting) return;
          setProfile({ [extracting.field]: dataUrl });
          setSaved(false);
          setExtracting(null);
        }}
      />
    </div>
  );
}

function CheckItem({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${ok ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-slate-200 bg-slate-50 text-ink-500'}`}>
      <Check className={`h-4 w-4 shrink-0 ${ok ? 'text-emerald-600' : 'text-slate-400'}`} />
      <span className="font-medium">{label}</span>
    </div>
  );
}

function ImagePicker({
  label,
  value,
  onChange,
  onClear,
  hint,
  stamp = false,
}: {
  label: string;
  value?: string;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  onClear: () => void;
  hint?: string;
  stamp?: boolean;
}) {
  const id = label.replace(/[^a-z0-9]/gi, '_');
  return (
    <div>
      <label className="label">{label}</label>
      <div className="flex gap-3">
        <label
          className={`relative shrink-0 cursor-pointer rounded-lg border-2 border-dashed border-slate-300 hover:border-brand-400 flex items-center justify-center overflow-hidden ${stamp ? 'h-20 w-20' : 'h-20 w-32'}`}
          style={CHECKERBOARD}
        >
          <input type="file" className="hidden" accept="image/jpeg,image/jpg,image/png,image/webp" onChange={onChange} />
          {value ? (
            <img src={value} alt={label} className="h-full w-full object-contain" />
          ) : (
            <div className="text-center px-2">
              <Upload className="h-5 w-5 text-ink-400 mx-auto" />
              <span className="text-[10px] text-ink-500 mt-1 block">Upload</span>
            </div>
          )}
        </label>
        <div className="flex-1 min-w-0">
          <p className="text-xs text-ink-500 leading-snug mb-2">{hint}</p>
          <div className="flex gap-2 flex-wrap">
            <label className="btn-secondary !py-1 !px-3 text-xs cursor-pointer">
              <Upload className="h-3.5 w-3.5" />
              Choose
              <input
                type="file"
                className="hidden"
                accept="image/jpeg,image/jpg,image/png,image/webp"
                capture="environment"
                onChange={onChange}
              />
            </label>
            {value && (
              <button type="button" onClick={onClear} className="btn-ghost !py-1 !px-3 text-xs">
                <Trash2 className="h-3.5 w-3.5" />
                Clear
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

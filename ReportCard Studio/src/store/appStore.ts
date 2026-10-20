import { create } from 'zustand';
import type {
  Student,
  ColumnMapping,
  SchoolProfile,
  WorkbookData,
  ValidationResult,
  PhotoMap,
  GenerationProgress,
  DetectedStructure,
  StructureMapping,
} from '../types';
import type { PhotoOverrides } from '../services/photoOverrides';

const DEFAULT_SCHOOL: SchoolProfile = {
  schoolName: '',
  address: '',
  principalName: '',
  teacherName: '',
  academicSession: '',
  examTerm: '',
};

const SCHOOL_STORAGE_KEY = 'rcs:schoolProfile';

function loadSchoolProfile(): SchoolProfile {
  try {
    const raw = localStorage.getItem(SCHOOL_STORAGE_KEY);
    if (!raw) return DEFAULT_SCHOOL;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SCHOOL, ...parsed };
  } catch {
    return DEFAULT_SCHOOL;
  }
}

export interface AppState {
  schoolProfile: SchoolProfile;
  workbook: WorkbookData | null;
  columnMapping: ColumnMapping[];
  defaultClass: string;
  defaultSection: string;
  students: Student[];
  validation: ValidationResult | null;
  photoMap: PhotoMap;
  /** Manual per-student photo corrections (see services/photoOverrides.ts). */
  photoOverrides: PhotoOverrides;
  generation: GenerationProgress;
  detectedStructure: DetectedStructure | null;
  structureMapping: StructureMapping | null;

  setSchoolProfile: (p: Partial<SchoolProfile>) => void;

  setWorkbook: (w: WorkbookData | null) => void;
  setActiveSheet: (name: string) => void;
  setColumnMapping: (m: ColumnMapping[]) => void;
  setDefaultClass: (c: string) => void;
  setDefaultSection: (s: string) => void;

  setStudents: (s: Student[]) => void;
  setValidation: (v: ValidationResult | null) => void;
  updateStudent: (id: string, patch: Partial<Student>) => void;

  setPhotoMap: (m: PhotoMap) => void;
  /** dataUrl = null clears the photo for that student. */
  setPhotoOverride: (studentId: string, dataUrl: string | null) => void;
  /** Drops the manual choice so the automatic matcher decides again. */
  resetPhotoOverride: (studentId: string) => void;
  clearPhotoOverrides: () => void;

  resetGeneration: () => void;
  setGenerationProgress: (p: Partial<GenerationProgress>) => void;

  setDetectedStructure: (s: DetectedStructure | null) => void;
  setStructureMapping: (m: StructureMapping | null) => void;

  resetWorkflow: () => void;
}

const initialGen: GenerationProgress = {
  total: 0,
  completed: 0,
  failed: 0,
  results: [],
  status: 'idle',
};

export const useAppStore = create<AppState>((set, get) => ({
  schoolProfile: loadSchoolProfile(),
  workbook: null,
  columnMapping: [],
  defaultClass: '',
  defaultSection: '',
  students: [],
  validation: null,
  photoMap: {},
  photoOverrides: {},
  generation: initialGen,
  detectedStructure: null,
  structureMapping: null,

  setSchoolProfile: (p) =>
    set(() => {
      const next = { ...get().schoolProfile, ...p };
      try {
        localStorage.setItem(SCHOOL_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore quota
      }
      return { schoolProfile: next };
    }),

  setWorkbook: (w) => set({ workbook: w, validation: null }),
  setActiveSheet: (name) =>
    set((s) =>
      s.workbook ? { workbook: { ...s.workbook, activeSheet: name } } : s,
    ),
  setColumnMapping: (m) => set({ columnMapping: m }),
  setDefaultClass: (c) => set({ defaultClass: c }),
  setDefaultSection: (s) => set({ defaultSection: s }),

  setStudents: (s) => set({ students: s, validation: null }),
  setValidation: (v) => set({ validation: v }),
  updateStudent: (id, patch) =>
    set((s) => ({
      students: s.students.map((st) =>
        st.studentId === id ? { ...st, ...patch } : st,
      ),
    })),

  setPhotoMap: (m) => set({ photoMap: m }),

  setPhotoOverride: (studentId, dataUrl) =>
    set((s) => ({
      photoOverrides: { ...s.photoOverrides, [studentId]: dataUrl },
    })),

  resetPhotoOverride: (studentId) =>
    set((s) => {
      if (!Object.prototype.hasOwnProperty.call(s.photoOverrides, studentId)) return s;
      const next = { ...s.photoOverrides };
      delete next[studentId];
      return { photoOverrides: next };
    }),

  clearPhotoOverrides: () => set({ photoOverrides: {} }),

  resetGeneration: () => set({ generation: initialGen }),
  setGenerationProgress: (p) =>
    set((s) => ({
      generation: { ...s.generation, ...p },
    })),

  setDetectedStructure: (s) => set({ detectedStructure: s }),
  setStructureMapping: (m) => set({ structureMapping: m }),

  resetWorkflow: () =>
    set({
      workbook: null,
      columnMapping: [],
      defaultClass: '',
      defaultSection: '',
      students: [],
      validation: null,
      photoMap: {},
      photoOverrides: {},
      generation: initialGen,
      detectedStructure: null,
      structureMapping: null,
    }),
}));

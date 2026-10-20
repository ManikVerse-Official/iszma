/**
 * Devanagari (Hindi) header vocabulary → English canonical terms.
 *
 * Applied at the very start of {@link normalizeHeader}, so every downstream
 * matcher — student fields, subjects, examination components, totals — sees the
 * same English tokens it already understands. Multi-word phrases come first so
 * "जन्म तिथि" wins over a bare "जन्म". English-only workbooks are untouched.
 */
const DEVANAGARI_ALIASES: Array<[RegExp, string]> = [
  [/जन्म\s*(तिथि|दिनांक|दिन)/g, 'dob'],
  [/जन्म\s*तारीख/g, 'dob'],
  [/जन्म/g, 'dob'],
  [/कुल\s*कार्य\s*दिवस/g, 'working days'],
  [/कार्य\s*दिवस/g, 'working days'],
  [/उपस्थित\s*दिन/g, 'days present'],
  [/उपस्थिति/g, 'attendance'],
  [/प्राप्तांक/g, 'marks obtained'],
  [/पूर्णांक/g, 'max marks'],
  [/अधिकतम\s*अंक/g, 'max marks'],
  [/अधिकतम/g, 'max'],
  [/कुल\s*योग/g, 'grand total'],
  [/कुल\s*अंक/g, 'total marks'],
  [/कुल/g, 'total'],
  [/योग/g, 'total'],
  [/प्रतिशत/g, 'percentage'],
  [/श्रेणी/g, 'grade'],
  [/ग्रेड/g, 'grade'],
  [/परिणाम/g, 'result'],
  [/टिप्पणी(याँ|यां)?/g, 'remarks'],
  [/विषय/g, 'subject'],
  [/प्रवेश\s*(संख्या|नंबर)?/g, 'admission no'],
  [/अनुक्रमांक/g, 'roll no'],
  [/क्रमांक/g, 'roll no'],
  [/अनुभाग/g, 'section'],
  [/वर्ग/g, 'class'],
  [/कक्षा/g, 'class'],
  [/छात्र\s*का\s*नाम/g, 'student name'],
  [/विद्यार्थी\s*का\s*नाम/g, 'student name'],
  [/छात्र/g, 'student'],
  [/विद्यार्थी/g, 'student'],
  [/पिता(\s*का)?\s*नाम/g, 'father name'],
  [/पिता/g, 'father'],
  [/माता(\s*का)?\s*नाम/g, 'mother name'],
  [/माता|मां|माँ/g, 'mother'],
  [/नाम/g, 'name'],
  /* Examination components. */
  [/अर्ध\s*वार्षिक/g, 'half yearly'],
  [/वार्षिक/g, 'annual'],
  [/त्रैमासिक/g, 'term'],
  [/इकाई\s*परीक्षा/g, 'unit test'],
  [/मासिक/g, 'monthly'],
  [/परीक्षा/g, 'exam'],
  [/प्रायोगिक|प्रैक्टिकल/g, 'practical'],
  [/मौखिक/g, 'oral'],
  [/लिखित/g, 'written'],
  [/आंतरिक/g, 'internal'],
  [/प्रोजेक्ट/g, 'project'],
  [/नोटबुक/g, 'notebook'],
  [/गृहकार्य/g, 'homework'],
  [/असाइनमेंट|कार्यपत्रिका/g, 'assignment'],
  [/गतिविधि/g, 'activity'],
  [/प्रश्नपत्र/g, 'paper'],
  /* Subjects. */
  [/सामाजिक\s*विज्ञान/g, 'social science'],
  [/सामान्य\s*ज्ञान/g, 'general knowledge'],
  [/शारीरिक\s*शिक्षा/g, 'physical education'],
  [/पर्यावरण/g, 'evs'],
  [/अंग्रेजी/g, 'english'],
  [/हिंदी|हिन्दी/g, 'hindi'],
  [/गणित/g, 'math'],
  [/विज्ञान/g, 'science'],
  [/संस्कृत/g, 'sanskrit'],
  [/कंप्यूटर/g, 'computer'],
  [/कला|चित्रकला/g, 'art'],
  [/संगीत/g, 'music'],
  [/खेल/g, 'sports'],
  [/नैतिक/g, 'moral'],
  [/उर्दू/g, 'urdu'],
  [/पंजाबी/g, 'punjabi'],
];

export function normalizeHeader(input: string): string {
  let source = input ?? '';
  if (/[\u0900-\u097F]/.test(source)) {
    for (const [pattern, english] of DEVANAGARI_ALIASES) {
      source = source.replace(pattern, english);
    }
  }
  return source
    .toLowerCase()
    .trim()
    .replace(/[._\-/\\]/g, ' ')
    .replace(/['''`"]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .replace(/\s*\[.*?\]\s*/g, ' ')
    .replace(/[.,:;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface FieldAliasMap {
  field: string;
  aliases: string[];
}

export const FIELD_ALIASES: FieldAliasMap[] = [
  {
    field: 'name',
    aliases: [
      'name',
      'student name',
      'students name',
      'student s name',
      'student',
      'full name',
      'studentname',
      's name',
      'name of student',
      'student s name',
    ],
  },
  {
    field: 'rollNo',
    aliases: [
      'sr no',
      'srno',
      's no',
      'sno',
      'serial no',
      'serial number',
      'sl no',
      'roll',
      'roll no',
      'roll number',
      'rollno',
      'r no',
      'rno',
    ],
  },
  {
    field: 'admissionNo',
    aliases: [
      'admission no',
      'admission number',
      'adm no',
      'adm',
      'admn no',
      'admission',
      'registration no',
      'registration number',
      'reg no',
      'enrollment no',
      'enrollment number',
      'scholar no',
      'scholar number',
    ],
  },
  {
    field: 'class',
    aliases: ['class', 'standard', 'std', 'grade', 'klass', 'cls'],
  },
  {
    field: 'section',
    aliases: ['section', 'sec', 'division', 'div'],
  },
  {
    field: 'fatherName',
    aliases: [
      'father name',
      'father',
      'fathers name',
      'father s name',
      'fathername',
      'f name',
      'guardian',
      'guardian name',
      'parent name',
      'parent',
    ],
  },
  {
    field: 'motherName',
    aliases: [
      'mother name',
      'mother',
      'mothers name',
      'mother s name',
      'mothername',
      'm name',
    ],
  },
  {
    field: 'dob',
    aliases: [
      'dob',
      'd o b',
      'date of birth',
      'birth date',
      'birthday',
      'date of birth',
      'birthdate',
    ],
  },
  {
    field: 'attendance',
    aliases: [
      'attendance',
      'attendance %',
      'attendance percent',
      'attendance percentage',
    ],
  },
  {
    field: 'workingDays',
    aliases: [
      'total working days',
      'working days',
      'working day',
      'total days',
      'no of working days',
    ],
  },
  {
    field: 'daysPresent',
    aliases: [
      'days present',
      'present days',
      'days attended',
      'no of days present',
    ],
  },
  {
    field: 'photoFilename',
    aliases: [
      'photo',
      'photo filename',
      'photo name',
      'image',
      'image filename',
      'photograph',
      'pic',
      'picture',
    ],
  },
  {
    field: 'teacherRemarks',
    aliases: [
      'teacher remarks',
      'remarks',
      'class teacher remarks',
      'comments',
      'teacher comment',
      'class teacher comments',
    ],
  },
  {
    field: 'principalRemarks',
    aliases: [
      'principal remarks',
      'headmaster remarks',
      'principal comment',
      'headmaster comment',
    ],
  },
  {
    field: 'address',
    aliases: [
      'address',
      'residential address',
      'permanent address',
      'home address',
      'city',
      'location',
    ],
  },
  {
    field: 'position',
    aliases: [
      'position',
      'rank',
      'class rank',
      'overall rank',
      'standing',
    ],
  },
];

export const OVERALL_FIELD_SYNONYMS = [
  'total',
  'grand total',
  'overall total',
  'percentage',
  'percent',
  'position',
  'rank',
  'attendance',
  'days present',
  'remarks',
  'comment',
];

export function isKnownNonSubjectHeader(header: string): boolean {
  const norm = normalizeHeader(header);
  if (!norm) return false;

  const matchesAlias = FIELD_ALIASES.some((fa) =>
    fa.aliases.some((a) => {
      const normAlias = normalizeHeader(a);
      return norm === normAlias || norm.includes(normAlias);
    }),
  );
  if (matchesAlias) return true;

  for (const syn of OVERALL_FIELD_SYNONYMS) {
    const normSyn = normalizeHeader(syn);
    if (norm === normSyn || norm.includes(normSyn)) {
      return true;
    }
  }

  if (/^(obtained|marks|score|grade)$/.test(norm)) return true;
  if (norm.includes('max') || norm.includes('total')) return true;

  return false;
}

export const SUBJECT_NAME_VARIANTS: Record<string, string> = {
  maths: 'Mathematics',
  math: 'Mathematics',
  mathematics: 'Mathematics',
  'maths em': 'Mathematics',
  sci: 'Science',
  science: 'Science',
  physics: 'Physics',
  chemistry: 'Chemistry',
  biology: 'Biology',
  english: 'English',
  eng: 'English',
  hindi: 'Hindi',
  'hindi em': 'Hindi',
  urdu: 'Urdu',
  sanskrit: 'Sanskrit',
  sans: 'Sanskrit',
  punjabi: 'Punjabi',
  gujarati: 'Gujarati',
  marathi: 'Marathi',
  tamil: 'Tamil',
  telugu: 'Telugu',
  bengali: 'Bengali',
  kannada: 'Kannada',
  malayalam: 'Malayalam',
  sst: 'Social Science',
  'social science': 'Social Science',
  social: 'Social Science',
  'social studies': 'Social Science',
  history: 'History',
  geography: 'Geography',
  civics: 'Civics',
  economics: 'Economics',
  evs: 'EVS',
  'environmental studies': 'EVS',
  'environmental science': 'EVS',
  gk: 'GK',
  'general knowledge': 'GK',
  computer: 'Computer',
  'computer science': 'Computer',
  cs: 'Computer',
  it: 'IT',
  'information technology': 'IT',
  drawing: 'Drawing',
  art: 'Art',
  'value education': 'Value Education',
  'moral science': 'Moral Science',
  'physical education': 'Physical Education',
  pe: 'Physical Education',
  sport: 'Sports',
  sports: 'Sports',
  music: 'Music',
  dance: 'Dance',
  yoga: 'Yoga',
  'third language': 'Third Language',
  'second language': 'Second Language',
};

export function canonicalizeSubjectName(raw: string): string {
  const norm = normalizeHeader(raw);
  if (SUBJECT_NAME_VARIANTS[norm]) return SUBJECT_NAME_VARIANTS[norm];
  return norm.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function looksLikeSubjectHeader(header: string): boolean {
  const norm = normalizeHeader(header);
  if (!norm) return false;
  if (norm.length > 60) return false;

  if (isKnownNonSubjectHeader(header)) return false;

  const isCoreField = FIELD_ALIASES.some((fa) =>
    fa.aliases.some((a) => norm === a || norm.startsWith(a + ' ')),
  );
  if (isCoreField) return false;

  return true;
}

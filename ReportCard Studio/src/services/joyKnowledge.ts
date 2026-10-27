/**
 * Joy's knowledge base for ReportCard Studio.
 *
 * Joy is rule-based (no external model), so her "smarts" live here: a
 * step-by-step guide per screen, a bank of answers for the questions people
 * actually ask, and bilingual copy everywhere. English is the default voice;
 * she switches to Hinglish only when the visitor writes in Hinglish.
 *
 * The Studio runs inside an iframe, so it cannot reuse the mall's Joy — this is
 * the in-Studio guider that knows every screen, button and limit.
 */

import type {
  ColumnMapping,
  GenerationProgress,
  PhotoMap,
  Student,
  ValidationIssue,
  ValidationResult,
} from '../types';
import { analyzeExaminations } from './examinationEngine';
import { computeTotals } from './calculationEngine';
import { autoMapColumns } from './mappingEngine';
import { resolvePhotosWithOverrides, type PhotoOverrides } from './photoOverrides';

export type JoyLang = 'en' | 'hi';

/** Bilingual text, resolved with {@link pick}. */
export interface JoyText {
  en: string;
  hi: string;
}

export const pick = (text: JoyText, lang: JoyLang): string => text[lang];

/** Screens Joy can guide on, keyed by the Studio's own routes. */
export type StudioScreen =
  | 'dashboard'
  | 'school-profile'
  | 'import'
  | 'template'
  | 'generate'
  | 'pricing'
  | 'login';

export const screenFromPath = (pathname: string): StudioScreen => {
  if (pathname.startsWith('/school-profile')) return 'school-profile';
  if (pathname.startsWith('/import')) return 'import';
  if (pathname.startsWith('/template')) return 'template';
  if (pathname.startsWith('/generate')) return 'generate';
  if (pathname.startsWith('/pricing')) return 'pricing';
  if (pathname.startsWith('/login')) return 'login';
  return 'dashboard';
};

export interface GuideStep {
  title: JoyText;
  detail: JoyText;
}

export interface ScreenGuide {
  /** Shown the moment the panel opens on this screen. */
  intro: JoyText;
  /** Ordered steps for the walkthrough. */
  steps: GuideStep[];
  /** One-tap questions relevant to this screen. */
  chips: JoyText[];
}

/* ------------------------------------------------------------------ */
/* Per-screen guides                                                  */
/* ------------------------------------------------------------------ */

export const SCREEN_GUIDES: Record<StudioScreen, ScreenGuide> = {
  dashboard: {
    intro: {
      en: "You're on the Dashboard — this is your home base. It shows how many students are loaded, whether validation passed, and how many free generations you have left. Shall I walk you through the four steps?",
      hi: 'Aap Dashboard par ho — yahi aapka home base hai. Yahan dikhta hai kitne students load hain, validation pass hui ya nahi, aur kitni free generations bachi hain. Chaaron steps samjhaun?',
    },
    steps: [
      {
        title: { en: '1. Set up your School Profile', hi: '1. School Profile set karo' },
        detail: {
          en: 'Open School Profile and fill in the school name, address, academic session, exam term, logo and signatures. You only do this once — every card picks it up automatically afterwards.',
          hi: 'School Profile pe jao — school ka naam, address, academic session, exam term, logo aur signatures daalo. Ye ek hi baar karna hota hai, phir har card me apne aap aata hai.',
        },
      },
      {
        title: { en: '2. Import your Excel sheet', hi: '2. Excel sheet import karo' },
        detail: {
          en: 'Import Students pe apni .xlsx / .xls / .csv file drop karo. Columns automatically name, roll number, parents, attendance aur subjects se map ho jaate hain — kuch bhi hard-coded nahi hai, koi bhi subject add kar sakte ho.',
          hi: 'Import Students pe apni .xlsx / .xls / .csv file drop karo. Columns automatically name, roll number, parents, attendance aur subjects se map ho jaate hain — kuch bhi hard-coded nahi hai, koi bhi subject add kar sakte ho.',
        },
      },
      {
        title: { en: '3. Check the preview & validation', hi: '3. Preview aur validation check karo' },
        detail: {
          en: 'Report Template pe har student ka card dekho. Validation errors (missing name, duplicate roll, out-of-range marks) wahi dikhte hain — pehle unhe theek kar lo.',
          hi: 'Report Template pe har student ka card dekho. Validation errors (naam missing, duplicate roll, marks range se bahar) wahi dikhte hain — pehle unhe theek kar lo.',
        },
      },
      {
        title: { en: '4. Generate and download', hi: '4. Generate karke download karo' },
        detail: {
          en: 'Generate Reports pe ek click me har student ka PDF banta hai aur sab ek ZIP me download ho jate hain. Ek generation run = ek free try.',
          hi: 'Generate Reports pe ek click me har student ka PDF banta hai aur sab ek ZIP me download ho jate hain. Ek generation run = ek free try.',
        },
      },
    ],
    chips: [
      { en: 'What do I do on this page?', hi: 'Is page par kya karna hai?' },
      { en: 'How many free tries do I get?', hi: 'Kitni free tries milti hain?' },
      { en: 'Which theme should I pick?', hi: 'Kaunsa theme chunna chahiye?' },
    ],
  },

  'school-profile': {
    intro: {
      en: "This is School Profile — what you fill in here is printed on every single report card. Everything is saved in your browser, so you only do it once per school/session.",
      hi: 'Ye School Profile hai — yahan jo bharoge wahi har report card par print hoga. Sab kuch aapke browser me save hota hai, isliye ek school/session ke liye ek hi baar bharo.',
    },
    steps: [
      {
        title: { en: 'Fill the basics', hi: 'Basic details bharo' },
        detail: {
          en: 'School name, address, affiliation text, school code and affiliation number. School name is the first thing printed at the top of the card.',
          hi: 'School ka naam, address, affiliation text, school code aur affiliation number. School ka naam card ke sabse upar print hota hai.',
        },
      },
      {
        title: { en: 'Set the session & term', hi: 'Session aur term set karo' },
        detail: {
          en: 'Academic Session (e.g. 2026-27) and Examination / Term (e.g. Periodic Test - I). These appear in the card header and the title bar.',
          hi: 'Academic Session (jaise 2026-27) aur Examination / Term (jaise Periodic Test - I). Ye card ke header aur title bar me aate hain.',
        },
      },
      {
        title: { en: 'Upload logo & signatures', hi: 'Logo aur signatures upload karo' },
        detail: {
          en: 'Logo top-left me, aur teacher / vice-principal / principal ke signature niche signature block me aate hain. Blank chhodne par ek placeholder box print hota hai — error nahi hota.',
          hi: 'Logo top-left me, aur teacher / vice-principal / principal ke signature niche signature block me aate hain. Blank chhodne par ek placeholder box print hota hai — error nahi hota.',
        },
      },
      {
        title: { en: 'Choose your report theme', hi: 'Report theme chuno' },
        detail: {
          en: 'Holistic Progress Card = marks + co-scholastic grades + personality/learning skills with stars. Simple Academic = clean marks-only card. Modern School = bold card with performance bars. Theme yahan se kabhi bhi badal sakte ho.',
          hi: 'Holistic Progress Card = marks + co-scholastic grades + personality/learning skills stars ke saath. Simple Academic = simple marks-only card. Modern School = performance bars wala bold card. Theme yahan se kabhi bhi badal sakte ho.',
        },
      },
    ],
    chips: [
      { en: 'Which theme suits my school?', hi: 'Mere school ke liye kaunsa theme?' },
      { en: 'Do I need signatures?', hi: 'Signature zaroori hain?' },
      { en: 'What is academic session?', hi: 'Academic session kya hota hai?' },
    ],
  },

  import: {
    intro: {
      en: "Import Students is where your Excel becomes report cards. You can upload, auto-map columns, check subjects and match student photos — all on this screen.",
      hi: 'Import Students par aapka Excel report card ban jaata hai. Yahan upload, column auto-mapping, subject check aur student photos match, sab hota hai.',
    },
    steps: [
      {
        title: { en: 'Upload the file', hi: 'File upload karo' },
        detail: {
          en: 'Drop an .xlsx, .xls or .csv file. First row should be your headings (Roll, Name, Class, then one column per subject).',
          hi: '.xlsx, .xls ya .csv file drop karo. Pehli row me headings honi chahiye (Roll, Name, Class, aur phir har subject ka ek column).',
        },
      },
      {
        title: { en: 'Review the column mapping', hi: 'Column mapping check karo' },
        detail: {
          en: 'Joy/Studio auto-detects which column is the name, roll number, class, parents, attendance and which ones are subjects. Kuch galat lage to dropdown se manually badal do.',
          hi: 'Studio khud detect kar leta hai ki kaunsa column name, roll number, class, parents, attendance hai aur kaunse subjects. Kuch galat lage to dropdown se manually badal do.',
        },
      },
      {
        title: { en: 'Confirm the subjects', hi: 'Subjects confirm karo' },
        detail: {
          en: 'Every detected subject is listed — English, Hindi, Maths, Science, GK, IT, anything. Koi subject limit nahi hai; jo column hai wahi card me aayega.',
          hi: 'Har detected subject list hota hai — English, Hindi, Maths, Science, GK, IT, kuch bhi. Subject ki koi limit nahi; jo column hai wahi card me aayega.',
        },
      },
      {
        title: { en: 'Match student photos (optional)', hi: 'Student photos match karo (optional)' },
        detail: {
          en: 'Upload photos named after the roll number or admission number and they are matched by identity — order matters nahi karta. Bina photo ke bhi card ban jaata hai.',
          hi: 'Photos ko roll number ya admission number ke naam se upload karo, wo identity se match ho jaati hain — order se farak nahi padta. Bina photo ke bhi card ban jaata hai.',
        },
      },
      {
        title: { en: 'Check the preview', hi: 'Preview check karo' },
        detail: {
          en: 'Last tab me pehla card render hota hai. Dikh raha ho sahi, to Generate Reports pe jao.',
          hi: 'Aakhri tab me pehla card render hota hai. Agar sahi dikh raha hai to Generate Reports pe jao.',
        },
      },
    ],
    chips: [
      { en: 'What format should my Excel be?', hi: 'Excel ka format kaisa hona chahiye?' },
      { en: 'Marks are mapping wrongly', hi: 'Marks galat map ho rahe hain' },
      { en: 'How do photos get matched?', hi: 'Photos kaise match hoti hain?' },
    ],
  },

  template: {
    intro: {
      en: "Report Template is your preview room. You can flip through every student, switch the theme, and download a single card — but note a single download also counts as one generation.",
      hi: 'Report Template aapka preview room hai. Har student dekh sakte ho, theme badal sakte ho, aur ek card download kar sakte ho — par dhyaan rahe, ek single download bhi ek generation maana jaata hai.',
    },
    steps: [
      {
        title: { en: 'Pick a student', hi: 'Student chuno' },
        detail: {
          en: 'Use the ‹ › arrows or the "Jump to Student" dropdown. Left panel me totals — percentage, overall grade aur result — live dikhte hain.',
          hi: '‹ › arrows ya "Jump to Student" dropdown use karo. Left panel me totals — percentage, overall grade aur result — live dikhte hain.',
        },
      },
      {
        title: { en: 'Try the themes', hi: 'Themes try karo' },
        detail: {
          en: 'Top-right dropdown se theme badal ke dekh lo. Preview aur actual PDF bilkul same layout use karte hain, isliye jo dikh raha hai wahi print hoga.',
          hi: 'Top-right dropdown se theme badal ke dekh lo. Preview aur actual PDF bilkul same layout use karte hain, isliye jo dikh raha hai wahi print hoga.',
        },
      },
      {
        title: { en: 'Fix what looks wrong', hi: 'Jo galat lage theek karo' },
        detail: {
          en: 'Validation cards me is student ke errors dikhte hain. Marks ya remarks galat ho to wapas Import me jakar mapping theek karo.',
          hi: 'Validation cards me is student ke errors dikhte hain. Marks ya remarks galat ho to wapas Import me jakar mapping theek karo.',
        },
      },
      {
        title: { en: 'Then generate them all', hi: 'Phir sab generate karo' },
        detail: {
          en: 'Ek student ke liye "Download This PDF"; poori class ke liye Generate Reports use karo — sabhi cards ek ZIP me aayenge.',
          hi: 'Ek student ke liye "Download This PDF"; poori class ke liye Generate Reports use karo — sabhi cards ek ZIP me aayenge.',
        },
      },
    ],
    chips: [
      { en: 'Where is the preview on mobile?', hi: 'Mobile par preview kaha hai?' },
      { en: 'Preview vs actual PDF?', hi: 'Preview aur actual PDF same hai?' },
      { en: 'How do I change the theme?', hi: 'Theme kaise badlu?' },
    ],
  },

  generate: {
    intro: {
      en: "Generate Reports is the finish line. One click makes a PDF per student and packs them into a single ZIP. Each run uses one free generation unless you're subscribed.",
      hi: 'Generate Reports aakhri step hai. Ek click me har student ka PDF banta hai aur sab ek ZIP me pack ho jaate hain. Har run ek free generation kha jaata hai, jab tak aap subscribe na karo.',
    },
    steps: [
      {
        title: { en: 'Choose who to include', hi: 'Kisko include karna hai chuno' },
        detail: {
          en: '"Only records with no errors" is safest. "All records" tab use karo jab aap errors ke saath bhi card chaahte ho.',
          hi: '"Only records with no errors" sabse safe hai. "All records" tab tab use karo jab errors ke saath bhi card chahiye.',
        },
      },
      {
        title: { en: 'Hit Generate', hi: 'Generate dabao' },
        detail: {
          en: 'Progress bar live update hota hai — kitne ban gaye, kitne fail hue. Beech me rokna ho to Cancel dabao, jitne ban chuke hain wo safe rehte hain.',
          hi: 'Progress bar live update hota hai — kitne ban gaye, kitne fail hue. Beech me rokna ho to Cancel dabao, jitne ban chuke hain wo safe rehte hain.',
        },
      },
      {
        title: { en: 'Download the ZIP', hi: 'ZIP download karo' },
        detail: {
          en: 'Har PDF ka naam {rollNo}_{name}.pdf hota hai aur ZIP ka naam class/section se banta hai — seedha print karke baant sakte ho.',
          hi: 'Har PDF ka naam {rollNo}_{name}.pdf hota hai aur ZIP ka naam class/section se banta hai — seedha print karke baant sakte ho.',
        },
      },
      {
        title: { en: 'If something failed', hi: 'Kuch fail ho gaya to' },
        detail: {
          en: '"Export Failed CSV" se sirf fail hue students ki list milti hai, unhe theek karke dobara generate kar lo.',
          hi: '"Export Failed CSV" se sirf fail hue students ki list milti hai, unhe theek karke dobara generate kar lo.',
        },
      },
    ],
    chips: [
      { en: 'Generation failed, what now?', hi: 'Generation fail ho gayi, ab kya?' },
      { en: 'How is one try counted?', hi: 'Ek try kaise count hoti hai?' },
      { en: 'How do I get unlimited?', hi: 'Unlimited kaise milega?' },
    ],
  },

  pricing: {
    intro: {
      en: "These are the ReportCard Studio plans. All three run for 6 months and give unlimited report cards — the difference is which report card designs you unlock.",
      hi: 'Ye ReportCard Studio ke plans hain. Teeno 6 months ke hain aur unlimited report cards dete hain — farak sirf ye hai ki kaunse designs milte hain.',
    },
    steps: [
      {
        title: { en: 'Simple Academic · ₹369 / $4.99', hi: 'Simple Academic · ₹369 / $4.99' },
        detail: {
          en: 'Marks-focused card. Best value if you only need subject marks, grades and result. 6 months unlimited.',
          hi: 'Marks-focused card. Agar sirf subject marks, grades aur result chahiye to best value. 6 months unlimited.',
        },
      },
      {
        title: { en: 'Modern School · ₹578 / $6.99', hi: 'Modern School · ₹578 / $6.99' },
        detail: {
          en: 'Everything in Simple plus the bold Modern theme with performance bars. 6 months unlimited.',
          hi: 'Simple ka sab kuch, plus performance bars wala bold Modern theme. 6 months unlimited.',
        },
      },
      {
        title: { en: 'Holistic Progress · ₹859 / $10.99', hi: 'Holistic Progress · ₹859 / $10.99' },
        detail: {
          en: 'Recommended. Marks + co-scholastic grades + personality & learning skills with stars. All future themes included. 6 months unlimited.',
          hi: 'Recommended. Marks + co-scholastic grades + personality & learning skills stars ke saath. Aage ke sab themes included. 6 months unlimited.',
        },
      },
      {
        title: { en: 'Subscribe with a secure payment', hi: 'Secure payment ke saath subscribe' },
        detail: {
          en: '"Subscribe" dabao → sign in (naam + email) → Razorpay se payment karo → payment verify hone ke baad hi plan activate hota hai, aur bill aapke email par aa jaata hai. Receipt bhi wahi se milti hai.',
          hi: '"Subscribe" dabao → sign in (naam + email) → Razorpay se payment karo → payment verify hone ke baad hi plan activate hota hai, aur bill aapke email par aa jaata hai. Receipt bhi wahin se milti hai.',
        },
      },
    ],
    chips: [
      { en: 'Which plan should I pick?', hi: 'Kaunsa plan lun?' },
      { en: 'Will I get a receipt?', hi: 'Receipt milegi?' },
      { en: 'Can I try before paying?', hi: 'Bina pay kiye try kar sakta hoon?' },
    ],
  },

  login: {
    intro: {
      en: "This is the sign-in screen. An account is what ties your free generations, your plan and your bills to you — that's why generating asks you to sign in first.",
      hi: 'Ye sign-in screen hai. Account se hi aapki free generations, plan aur bills aapse jud jaate hain — isliye generate karne se pehle sign in maanga jaata hai.',
    },
    steps: [
      {
        title: { en: 'Sign in with name + email', hi: 'Naam + email se sign in karo' },
        detail: {
          en: 'No password, no OTP. Bas naam aur woh email daalo jahan bill aur renewals chahiye. Ye email hi aapki identity hai.',
          hi: 'Na password, na OTP. Bas naam aur woh email daalo jahan bill aur renewals chahiye. Ye email hi aapki identity hai.',
        },
      },
      {
        title: { en: 'Check your allowance', hi: 'Apna allowance dekho' },
        detail: {
          en: 'Sign in karne ke baad screen par dikhta hai aapke paas kitni free generations bachi hain, ya plan kab tak active hai.',
          hi: 'Sign in karne ke baad screen par dikhta hai kitni free generations bachi hain, ya plan kab tak active hai.',
        },
      },
      {
        title: { en: 'Subscribe when ready', hi: 'Ready ho to subscribe karo' },
        detail: {
          en: 'Aap bina pay kiye free tries use kar sakte ho. Jab lage ki unlimited chahiye, tab plan chuno aur subscribe karo.',
          hi: 'Aap bina pay kiye free tries use kar sakte ho. Jab unlimited chahiye lage, tab plan chuno aur subscribe karo.',
        },
      },
      {
        title: { en: 'Your bill and renewals', hi: 'Bill aur renewals' },
        detail: {
          en: 'Plan activate hone par bill email aata hai. Plan khatam hone se 7 din pehle renewal reminder aayega, aur renew na karne par plan apne aap off ho jaayega.',
          hi: 'Plan activate hone par bill email aata hai. Plan khatam hone se 7 din pehle renewal reminder aayega, aur renew na karne par plan apne aap off ho jaayega.',
        },
      },
    ],
    chips: [
      { en: 'Why do I need to sign in?', hi: 'Sign in kyun zaroori hai?' },
      { en: 'Is my data safe?', hi: 'Mera data safe hai?' },
      { en: 'How much does it cost?', hi: 'Kitna kharcha aayega?' },
    ],
  },
};

/* ------------------------------------------------------------------ */
/* Questions & answers                                                */
/* ------------------------------------------------------------------ */

export interface FaqEntry {
  keywords: string[];
  reply: JoyText;
}

const FAQ: FaqEntry[] = [
  {
    keywords: [
      'free', 'free try', 'free tries', 'free generation', 'free generations', 'how many free',
      'trial', 'try', 'try before', 'before paying', 'kitni free', 'kitne free', 'muft',
      'free me', 'free mein', 'bina pay',
    ],
    reply: {
      en: 'You get 7 free report-card generations on your account. Sign in, generate, aur counter apne aap kam hota jaayega. After 7, subscribe for unlimited.',
      hi: 'Aapke account par 7 free report-card generations milti hain. Sign in karo, generate karo, aur counter apne aap kam hota jaayega. 7 ke baad unlimited ke liye subscribe karo.',
    },
  },
  {
    keywords: [
      'price', 'pricing', 'cost', 'rate', 'kitna', 'kitne', 'paisa', 'paise', 'plan', 'plans',
      'subscription', 'charge', 'fees',
    ],
    reply: {
      en: 'Plans: Simple Academic ₹369, Modern School ₹578, Holistic Progress ₹859 — each for 6 months, unlimited report cards. First 7 generations free.',
      hi: 'Plans: Simple Academic ₹369, Modern School ₹578, Holistic Progress ₹859 — teeno 6 months ke, unlimited report cards. Pehli 7 generations free.',
    },
  },
  {
    keywords: ['receipt', 'bill', 'invoice', 'refund', 'receipt kaha', 'bill kaha', 'gst'],
    reply: {
      en: 'Har order par professional bill + receipt aapke email par jaata hai (logo ke saath, Cost column me actual amount). Chahe order free ho ya admin comp ho — receipt hamesha generate hoti hai, free product par cost ₹0.00 dikhta hai.',
      hi: 'Har order par professional bill + receipt aapke email par jaata hai (logo ke saath, Cost column me actual amount). Order free ho ya admin comp — receipt hamesha banti hai, free product par cost ₹0.00 dikhta hai.',
    },
  },
  {
    keywords: ['excel', 'xlsx', 'xls', 'csv', 'format', 'upload', 'sheet', 'columns', 'column'],
    reply: {
      en: 'Excel format: pehli row me headings rakho — Roll, Name, Class, Section, aur phir har subject ka apna column (English, Maths, Science…). Koi bhi subject add kar sakte ho, koi limit nahi. .xlsx / .xls / .csv teeno chalte hain.',
      hi: 'Excel format: pehli row me headings rakho — Roll, Name, Class, Section, aur phir har subject ka apna column (English, Maths, Science…). Koi bhi subject add kar sakte ho, koi limit nahi. .xlsx / .xls / .csv teeno chalte hain.',
    },
  },
  {
    keywords: ['holistic', 'academic', 'modern', 'theme', 'themes', 'design', 'layout', 'look'],
    reply: {
      en: 'Holistic Progress Card = marks + co-scholastic grades + personality/learning skills with stars (most complete). Simple Academic = clean marks-only card. Modern School = bold card with performance bars. Koi bhi theme School Profile ya Report Template se badal sakte ho.',
      hi: 'Holistic Progress Card = marks + co-scholastic grades + personality/learning skills stars ke saath (sabse complete). Simple Academic = simple marks-only card. Modern School = performance bars wala bold card. Koi bhi theme School Profile ya Report Template se badal sakte ho.',
    },
  },
  {
    keywords: ['photo', 'photos', 'picture', 'image', 'images', 'photo kaise', 'photo match'],
    reply: {
      en: 'Photos name se match hoti hain — roll number ya admission number file ka naam rakho (e.g. 01.jpg ya ADM-2019-1043.jpg). Order se farak nahi padta. Photo na ho to placeholder box chhap jaata hai, card phir bhi ban jaata hai.',
      hi: 'Photos naam se match hoti hain — file ka naam roll number ya admission number rakho (jaise 01.jpg ya ADM-2019-1043.jpg). Order se farak nahi padta. Photo na ho to placeholder box chhap jaata hai, card phir bhi ban jaata hai.',
    },
  },
  {
    keywords: ['pdf', 'zip', 'download', 'print', 'a4', 'printable'],
    reply: {
      en: 'Output: har student ka ek A4 print-ready PDF, aur poori class ka ek ZIP. Generate Reports par ek click me sab ban jaata hai aur "Download …zip" button se milta hai.',
      hi: 'Output: har student ka ek A4 print-ready PDF, aur poori class ka ek ZIP. Generate Reports par ek click me sab ban jaata hai aur "Download …zip" button se milta hai.',
    },
  },
  {
    keywords: ['marks', 'grade', 'grades', 'grading', 'percentage', 'result', 'promoted', 'fail'],
    reply: {
      en: 'Marks se grade, percentage, overall grade aur result (PROMOTED / NEEDS IMPROVEMENT) apne aap nikalte hain. Grading scale card me hi printed hota hai — A1 (91-100), A2 (81-90), B1 (71-80), B2 (61-70), C (51-60), D (0-50).',
      hi: 'Marks se grade, percentage, overall grade aur result (PROMOTED / NEEDS IMPROVEMENT) apne aap nikalte hain. Grading scale card me hi printed hota hai — A1 (91-100), A2 (81-90), B1 (71-80), B2 (61-70), C (51-60), D (0-50).',
    },
  },
  {
    keywords: ['safe', 'privacy', 'data', 'upload kaha', 'server', 'secure', 'leak'],
    reply: {
      en: 'Aapka Excel aur student data browser me hi process hota hai — student data kahin upload nahi hota. Sirf aapka naam/email aur free-try counter server par jaata hai, wo bhi sirf limits ke liye.',
      hi: 'Aapka Excel aur student data browser me hi process hota hai — student data kahin upload nahi hota. Sirf aapka naam/email aur free-try counter server par jaata hai, wo bhi sirf limits ke liye.',
    },
  },
  {
    keywords: ['sign in', 'login', 'account', 'signin', 'register', 'password', 'otp'],
    reply: {
      en: 'Sign in bas naam + email se hota hai — na password, na OTP. Account se hi aapki free tries, plan aur receipts judte hain, isliye generate karne se pehle sign in maanga jaata hai.',
      hi: 'Sign in bas naam + email se hota hai — na password, na OTP. Account se hi aapke free tries, plan aur receipts judte hain, isliye generate karne se pehle sign in maanga jaata hai.',
    },
  },
  {
    keywords: ['renew', 'expire', 'expiry', 'expired', 'reminder', 'warning', 'cancel plan'],
    reply: {
      en: 'Plan khatam hone se 7 din pehle renewal reminder email aata hai. Renew na karo to expiry par plan apne aap off ho jaata hai — aur bache hue free generations phir bhi use kar sakte ho. Jab chaho renew ya upgrade kar sakte ho.',
      hi: 'Plan khatam hone se 7 din pehle renewal reminder email aata hai. Renew na karo to expiry par plan apne aap off ho jaata hai — aur bache hue free generations phir bhi use kar sakte ho. Jab chaho renew ya upgrade kar sakte ho.',
    },
  },
  {
    keywords: ['admin', 'owner', 'unlimited', 'unlimited free', 'unlimited kaise', 'unlimited milega', 'how do i get unlimited'],
    reply: {
      en: 'Unlimited comes with any plan — Simple ₹369, Modern ₹578 or Holistic ₹859, each 6 months. Owner/admin accounts (recognised by email or office IP) get unlimited free access automatically, without any plan.',
      hi: 'Unlimited kisi bhi plan ke saath milta hai — Simple ₹369, Modern ₹578 ya Holistic ₹859, teeno 6 months. Owner/admin accounts (email ya office IP se pehchane gaye) ko bina plan ke bhi unlimited free access milta hai.',
    },
  },
  {
    keywords: ['signature', 'signatures', 'sign', 'principal sign', 'teacher sign', 'stamp'],
    reply: {
      en: 'Signatures are optional. Upload teacher / vice-principal / principal signature images and a stamp in School Profile and they print in the signature block. Blank chhodne par ek placeholder rehta hai — card phir bhi ban jaata hai.',
      hi: 'Signatures optional hain. School Profile me teacher / vice-principal / principal ke signature aur stamp upload karo, wo signature block me print ho jaate hain. Blank chhodne par placeholder rehta hai — card phir bhi ban jaata hai.',
    },
  },
  {
    keywords: ['session', 'academic session', 'term', 'examination', 'exam', 'periodic test'],
    reply: {
      en: 'Academic Session (e.g. 2026-27) and Examination / Term (e.g. Periodic Test - I) are set in School Profile. They print in the card header and title bar, so bharo ek hi baar aur sab cards me aa jaayega.',
      hi: 'Academic Session (jaise 2026-27) aur Examination / Term (jaise Periodic Test - I) School Profile me set hote hain. Wo card ke header aur title bar me print hote hain, isliye ek hi baar bharo.',
    },
  },
  {
    keywords: ['remarks', 'remark', 'teacher remarks', 'principal remarks', 'comment'],
    reply: {
      en: 'Teacher’s and Principal’s remarks are generated from the student’s own result — strengths, weak subjects and attendance. Agar aapka Excel me apna remark column hai to wahi use hoga. Remarks galat lage to Import me column mapping check karo.',
      hi: 'Teacher’s aur Principal’s remarks student ke result se ban jaate hain — strengths, weak subjects aur attendance ke hisaab se. Agar aapke Excel me apna remark column hai to wahi use hota hai. Galat lage to Import me column mapping check karo.',
    },
  },
  {
    keywords: ['validate', 'validation', 'error', 'errors', 'fail', 'failed', 'wrong', 'issue', 'issues'],
    reply: {
      en: 'Validation catches missing names, duplicate roll numbers, marks outside the 0–max range and unreadable cells. Errors wale students ko default me skip kiya jaata hai — Generate me “All records” choose karke unhe bhi include kar sakte ho, ya Import me fix kar lo.',
      hi: 'Validation missing name, duplicate roll number, marks 0–max se bahar aur unreadable cells pakadta hai. Errors wale students default me skip ho jaate hain — Generate me “All records” choose karke include kar sakte ho, ya Import me fix kar lo.',
    },
  },
  {
    keywords: [
      'preview', 'preview kaha', 'preview kahan', 'where is the preview', 'show preview', 'preview dikhao',
      'mobile preview', 'phone preview', 'preview mobile', 'not showing', 'nahi dikh', 'preview nahi dikh',
    ],
    reply: {
      en: 'The preview is on this screen — “Report Template”. On a phone the full A4 card is scaled down to fit your screen, so scroll down and it appears right under the “Step … of 7” bar (use ‹ › to move between students, theme selector on top). The preview matches the printed PDF exactly.',
      hi: 'Preview isi screen (“Report Template”) par hai. Phone par poora A4 card screen ke hisaab se chhota (scaled) hota hai, isliye neeche scroll karo — “Step … of 7” bar ke thik neeche dikh jaayega (students badalne ke liye ‹ ›, upar theme selector). Preview bilkul wahi hota hai jo PDF me print hota hai.',
    },
  },
];

/* ------------------------------------------------------------------ */
/* Matching                                                           */
/* ------------------------------------------------------------------ */

const normalize = (input: string): string =>
  input
    .toLowerCase()
    .replace(/[^\w\s+.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const toRegexes = (words: string[]): RegExp[] =>
  words.map((word) => new RegExp(`\\b${escapeRegExp(word)}\\b`, 'i'));

const anyMatch = (text: string, regexes: RegExp[]): boolean => regexes.some((re) => re.test(text));

const tokensOf = (text: string): string[] => text.split(' ').filter(Boolean);

/**
 * Optimal-string-alignment distance (Levenshtein + adjacent transposition), so
 * a swapped pair like "reprot" → "report" counts as ONE typo.
 */
export const editDistance = (a: string, b: string): number => {
  if (a === b) return 0;
  let prev2: number[] = [];
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(prev[j] + 1, current[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, prev2[j - 2] + 1);
      }
      current[j] = value;
    }
    prev2 = prev;
    prev = current;
  }
  return prev[b.length];
};

/** How many typos a keyword of this length may carry before we stop trusting it. */
const typoBudget = (word: string): number =>
  word.length >= 9 ? 2 : word.length >= 5 ? 1 : 0;

/**
 * Typo-tolerant keyword search, used only after the exact matcher misses, so
 * "excle format", "reciept" or "holisitc theme" still find their answer.
 */
export const fuzzyKeywordMatch = (tokens: string[], keywords: string[]): string | null => {
  for (const keyword of keywords) {
    const parts = keyword.split(' ').filter(Boolean);
    if (parts.length === 0 || tokens.length < parts.length) continue;
    for (let start = 0; start + parts.length <= tokens.length; start++) {
      let distance = 0;
      let usable = true;
      for (let offset = 0; offset < parts.length; offset++) {
        const typed = tokens[start + offset];
        const expected = parts[offset];
        if (typed === expected) continue;
        const d = editDistance(typed, expected);
        const budget = typoBudget(expected);
        if (budget === 0 || d > budget) {
          usable = false;
          break;
        }
        distance += d;
      }
      if (usable && distance > 0) return keyword;
    }
  }
  return null;
};

/** Exact word match, then (only if that misses) a typo-tolerant retry. */
const bankHit = (text: string, tokens: string[], exact: RegExp[], words: string[]): boolean =>
  anyMatch(text, exact) || fuzzyKeywordMatch(tokens, words) !== null;

/** Markers that indicate romanised Hindi (Hinglish). */
const HINGLISH_MARKERS = [
  'kya', 'kaise', 'kaisa', 'kaisi', 'kaha', 'kahan', 'nahi', 'nahin', 'mujhe', 'mera', 'meri',
  'aap', 'aapko', 'chahiye', 'karo', 'kro', 'karna', 'krna', 'kholo', 'batao', 'bata', 'hai',
  'hain', 'kaun', 'kon', 'kis', 'mein', 'konsi', 'kaunsi', 'chalega', 'hoga', 'kabu', 'kaun',
  'kitna', 'kitne', 'paisa', 'paise', 'dedo', 'banao', 'banana', 'bana', 'dekhna', 'kaam',
];
const HINGLISH_RE = toRegexes(HINGLISH_MARKERS);

/** Detects Hinglish. English is the default, so no marker means English. */
export const detectJoyLanguage = (raw: string): JoyLang =>
  anyMatch(normalize(raw), HINGLISH_RE) ? 'hi' : 'en';

/** "how do I use this / guide me / steps" intent. */
const GUIDE_WORDS = [
  'how do i', 'how to', 'how can i', 'guide', 'guide me', 'walk me', 'walkthrough', 'steps',
  'step by step', 'help', 'help me', 'stuck', 'confused', 'what do i do', 'what to do',
  'next', 'start', 'begin', 'teach me', 'explain', 'show me how', 'process', 'workflow',
  'kaise', 'kaisa', 'kese', 'batao', 'bata do', 'samjhao', 'samjao', 'madad', 'help karo',
  'kya karu', 'kya karna', 'kaise kare', 'kaise karu', 'kaise banau', 'kaise banaun',
  'kaise use', 'use kaise', 'chalana', 'chalana kaise', 'shuru',
];
const GUIDE_RE = toRegexes(GUIDE_WORDS);

/* ------------------------------------------------------------------ */
/* Current-import validation explanation                              */
/* ------------------------------------------------------------------ */

/**
 * Joy answers validation questions from the *current* import, never generic
 * copy. Three voices are supported: English, Hindi (Devanagari) and Hinglish
 * (romanised Hindi), matching the language the visitor typed in.
 */
export type ExplainLang = 'en' | 'hi' | 'hinglish';

/**
 * The language the Studio widget answers in: the visitor's own.
 *
 * A Hinglish question ("warning kyu aa rahi hai") gets a Hinglish explanation
 * and an English question gets an English one; the diagostic readings behind the
 * answer are identical because the keyword banks are language-independent.
 */
export const studioReplyLanguage = (raw: string): ExplainLang => detectExplainLang(raw);

const DEVANAGARI_RE = /[\u0900-\u097F]/;

/** English is the default; Devanagari → Hindi; romanised Hindi → Hinglish. */
export const detectExplainLang = (raw: string): ExplainLang => {
  if (DEVANAGARI_RE.test(raw)) return 'hi';
  return detectJoyLanguage(raw) === 'hi' ? 'hinglish' : 'en';
};

const tri = (lang: ExplainLang, en: string, hi: string, hinglish: string): string =>
  lang === 'en' ? en : lang === 'hi' ? hi : hinglish;

/**
 * A validation question. Weak, plan-related words are excluded so a renewal
 * "warning" question is still answered by the billing FAQ, not by the import.
 */
const VALIDATION_WORDS = [
  'warning', 'warnings', 'error', 'errors', 'issue', 'issues', 'problem', 'problems',
  'invalid', 'validation', 'validate', 'malformed', 'galat', 'galti',
];
const VALIDATION_RE = toRegexes(VALIDATION_WORDS);

const PLAN_CONTEXT_WORDS = [
  'renew', 'renewal', 'expire', 'expiry', 'expired', 'subscription', 'plan', 'plans',
  'bill', 'billing', 'receipt', 'refund',
];
const PLAN_CONTEXT_RE = toRegexes(PLAN_CONTEXT_WORDS);

export const isValidationQuery = (text: string, tokens: string[]): boolean => {
  if (anyMatch(text, PLAN_CONTEXT_RE)) return false;
  return anyMatch(text, VALIDATION_RE) || fuzzyKeywordMatch(tokens, VALIDATION_WORDS) !== null;
};

/** Friendly, localized name per issue type; unknown types fall back to the raw type. */
const VALIDATION_TYPE_LABELS: Record<string, [en: string, hi: string, hinglish: string]> = {
  attendance_looks_like_days: [
    'Attendance looks like days present',
    'Attendance दिन-गिनती जैसी लग रही है',
    'Attendance days jaise lag rahe hain',
  ],
  invalid_attendance: ['Invalid attendance', 'अमान्य attendance', 'Galat attendance'],
  missing_name: ['Missing name', 'नाम गायब', 'Naam missing'],
  missing_roll: ['Missing roll number', 'रोल नंबर गायब', 'Roll number missing'],
  missing_class: ['Missing class', 'कक्षा गायब', 'Class missing'],
  missing_marks: ['Missing marks', 'अंक गायब', 'Marks missing'],
  invalid_marks_negative: ['Negative marks', 'नकारात्मक अंक', 'Negative marks'],
  marks_exceed_max: ['Marks exceed maximum', 'अंक अधिकतम से ज़्यादा', 'Marks maximum se zyada'],
  duplicate_roll: ['Duplicate roll number', 'रोल नंबर दोहराया गया', 'Roll number duplicate'],
};

const issueLabel = (issue: ValidationIssue, lang: ExplainLang): string => {
  const labels = VALIDATION_TYPE_LABELS[issue.type];
  if (!labels) return issue.type;
  return tri(lang, labels[0], labels[1], labels[2]);
};

export interface ValidationContext {
  validation?: ValidationResult | null;
  students?: Student[];
}

/**
 * Everything Joy may look at on the current screen (P1.2 shared context).
 *
 * Every field is optional and comes straight from the live app store. A section
 * that does not expose a value simply leaves it undefined — Joy then says what
 * she cannot see instead of inventing an answer. `ValidationContext` is kept as
 * the narrower, backward-compatible shape used by the older helpers.
 */
export interface JoyContext extends ValidationContext {
  /** The confirmed column mapping (Import Students → Column Mapping). */
  columnMapping?: ColumnMapping[];
  /** Photos loaded from the ZIP, keyed by file name. */
  photoMap?: PhotoMap;
  /** Manual per-student photo corrections. */
  photoOverrides?: PhotoOverrides;
  /** The last/current generation run, for "why did it fail?" questions. */
  generation?: GenerationProgress;
}

/**
 * Explains the current import's validation results in the visitor's language.
 *
 * Reports the totals, each issue's type, the affected students and fields, the
 * determinable cause and a concrete correction — and clearly labels each cause
 * as confirmed (certain from the data) or possible. Nothing is invented: when
 * the data is not enough, it says exactly what to check.
 */
export function explainValidation(context: ValidationContext, lang: ExplainLang): string {
  const validation = context.validation ?? null;
  const students = context.students ?? [];

  if (!validation) {
    return tri(
      lang,
      "I don't have any validation results yet. Import your Excel file (Import Students → upload) or open Report Template to validate, then ask me again.",
      'अभी मेरे पास validation का कोई नतीजा नहीं है। पहले अपनी Excel फ़ाइल आयात करें (Import Students → upload) या Report Template खोलें, फिर मुझसे दोबारा पूछें।',
      'Abhi mere paas validation ka result nahi hai. Pehle apni Excel file import karo (Import Students → upload) ya Report Template kholo, phir mujhse dobara poocho.',
    );
  }

  const { issues, errorCount, warningCount } = validation;

  if (issues.length === 0) {
    return tri(
      lang,
      `Good news — the current import has no validation errors or warnings (0 errors, 0 warnings). Nothing is flagged.`,
      `अच्छी खबर — मौजूदा import में कोई validation error या warning नहीं है (0 error, 0 warning)।`,
      'Good news — abhi ke import me koi validation error ya warning nahi hai (0 error, 0 warning).',
    );
  }

  const nameOf = (issue: ValidationIssue): string => {
    if (issue.studentName && issue.studentName.trim()) return issue.studentName.trim();
    const student = students.find((s) => s.studentId === issue.studentId);
    return student?.name?.trim() || '';
  };

  const lines: string[] = [];
  lines.push(
    tri(
      lang,
      `Current import validation: ${errorCount} error${errorCount === 1 ? '' : 's'} and ${warningCount} warning${warningCount === 1 ? '' : 's'}.`,
      `मौजूदा import में ${errorCount} error और ${warningCount} warning मिल रहे हैं।`,
      `Abhi ke import me ${errorCount} error aur ${warningCount} warning aa rahe hain.`,
    ),
  );

  /* Group by severity + type so 13 identical warnings read as one block. */
  const groups = new Map<string, ValidationIssue[]>();
  for (const issue of issues) {
    const key = `${issue.severity}__${issue.type}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(issue);
    groups.set(key, bucket);
  }

  for (const bucket of groups.values()) {
    const first = bucket[0];
    const severityLabel =
      first.severity === 'error'
        ? tri(lang, 'ERROR', 'ERROR', 'ERROR')
        : tri(lang, 'WARNING', 'WARNING', 'WARNING');
    lines.push('');
    lines.push(`${severityLabel} · ${issueLabel(first, lang)} (${bucket.length})`);

    for (const issue of bucket) {
      const name = nameOf(issue);
      const who = name || tri(lang, 'Unnamed student', 'नाम रहित छात्र', 'Bina naam wala student');
      const row = issue.rowNumber ? ` (row ${issue.rowNumber})` : '';
      const field = issue.field ? ` — ${tri(lang, 'field', 'फ़ील्ड', 'field')}: ${issue.field}` : '';
      const value = issue.value ? ` — ${tri(lang, 'value', 'मान', 'value')}: "${issue.value}"` : '';
      lines.push(`• ${who}${row}${field}${value}`);

      if (issue.reason) {
        const causeLabel = issue.confirmed
          ? tri(lang, 'Confirmed cause', 'पक्का कारण', 'Pakka karan')
          : tri(lang, 'Possible cause', 'संभावित कारण', 'Sambhavit karan');
        lines.push(`   ${causeLabel}: ${issue.reason}`);
      } else {
        lines.push(
          `   ${tri(
            lang,
            `Cause could not be determined from the validation data — please check the ${issue.field ?? 'row'} for ${who} in the source file.`,
            `Validation डेटा से कारण तय नहीं हो सका — कृपया स्रोत फ़ाइल में ${who} का ${issue.field ?? 'row'} जाँचें।`,
            `Validation data se karan pata nahi chala — source file me ${who} ka ${issue.field ?? 'row'} check karo.`,
          )}`,
        );
      }

      lines.push(
        `   ${tri(lang, 'Fix', 'सुधार', 'Fix')}: ${
          issue.suggestion ||
          tri(
            lang,
            'Open Import Students, review the column mapping and the source row, then re-import.',
            'Import Students खोलें, column mapping और स्रोत पंक्ति जाँचें, फिर दोबारा आयात करें।',
            'Import Students kholo, column mapping aur source row check karo, phir dobara import karo.',
          )
        }`,
      );
      lines.push(
        `   ${tri(
          lang,
          issue.blocksGeneration
            ? 'This blocks report generation for this student.'
            : 'This does not block report generation.',
          issue.blocksGeneration
            ? 'यह इस छात्र के लिए report generation रोकता है।'
            : 'यह report generation नहीं रोकता।',
          issue.blocksGeneration
            ? 'Ye is student ke report generation ko rokta hai.'
            : 'Ye report generation nahi rokta.',
        )}`,
      );
    }
  }

  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Examination components, maximum marks and totals                   */
/* ------------------------------------------------------------------ */

const EXAM_COMPONENT_RE = /\b(sa|fa|pt|nb|sea|ut|term|sem|t)\s*-?\s*\d+\b/i;
const EXAM_COMPONENT_WORDS = [
  'practical', 'theory', 'internal', 'oral', 'written', 'component', 'components',
  'half yearly', 'annual', 'unit test', 'internal assessment', 'project', 'notebook',
];
const EXAM_COMPONENT_WORD_RE = toRegexes(EXAM_COMPONENT_WORDS);

/** A question about examination components (SA1/SA2/practical/…). */
export const isExaminationQuery = (text: string): boolean =>
  EXAM_COMPONENT_RE.test(text) || anyMatch(text, EXAM_COMPONENT_WORD_RE);

const MAX_MARKS_WORDS = [
  'maximum marks', 'max marks', 'maximum mark', 'max mark', 'full marks', 'purnank',
  'marks mapped', 'max mapped', 'maximum mapped', 'maximum',
];
const MAX_MARKS_RE = toRegexes(MAX_MARKS_WORDS);
export const isMaxMarksQuery = (text: string): boolean => anyMatch(text, MAX_MARKS_RE);

const GRAND_TOTAL_PHRASES = [
  'grand total', 'overall total', 'total incorrect', 'total wrong', 'total galat',
  'total kyun', 'total kyu', 'total why', 'total mismatch', 'total sahi nahi',
];
const GRAND_TOTAL_RE = toRegexes(GRAND_TOTAL_PHRASES);
export const isGrandTotalQuery = (text: string): boolean =>
  anyMatch(text, GRAND_TOTAL_RE) ||
  (/\btotal\b/.test(text) && /(incorrect|wrong|galat|kyun|kyu|why|mismatch|sahi nahi)/.test(text));

function notImportedMessage(lang: ExplainLang): string {
  return tri(
    lang,
    "I don't have an imported workbook to look at yet. Import your Excel file in Import Students first, then ask me again.",
    'अभी मेरे पास imported workbook नहीं है। पहले Import Students में अपनी Excel फ़ाइल आयात करें, फिर मुझसे दोबारा पूछें।',
    'Abhi mere paas imported workbook nahi hai. Pehle Import Students me apni Excel file import karo, phir mujhse dobara poocho.',
  );
}

/**
 * Maximum marks discovered from the current workbook — per subject, per
 * component, and the overall maximum. Reads the real parser output; nothing is
 * assumed.
 */
export function explainMaximumMarks(context: ValidationContext, lang: ExplainLang): string {
  const students = context.students ?? [];
  if (students.length === 0) return notImportedMessage(lang);

  const report = analyzeExaminations(students);
  const totals = computeTotals(students[0]);
  const lines: string[] = [];
  lines.push(
    tri(
      lang,
      `Maximum marks found in this workbook — overall maximum ${totals.totalMax} across ${totals.presentSubjects} academic subject(s):`,
      `इस workbook में अधिकतम अंक — कुल अधिकतम ${totals.totalMax}, ${totals.presentSubjects} शैक्षणिक विषय:`,
      `Is workbook me maximum marks — overall maximum ${totals.totalMax}, ${totals.presentSubjects} academic subject(s):`,
    ),
  );

  for (const plan of report.subjects) {
    if (plan.maxMarks === 0) continue;
    const components = plan.components
      .filter((component) => !component.isTotal)
      .map((component) => `${component.name} (${component.maxMarks})`)
      .join(', ');
    lines.push(
      `• ${plan.subject} — ${tri(lang, 'max', 'अधिकतम', 'max')} ${plan.maxMarks}` +
        (components ? ` — ${components}` : ''),
    );
  }

  lines.push(
    tri(
      lang,
      'If any maximum looks wrong, open Import Students → Subjects tab and correct it there.',
      'कोई अधिकतम गलत लगे तो Import Students → Subjects tab में जाकर सही करें।',
      'Koi maximum galat lage to Import Students → Subjects tab me jaake sahi karo.',
    ),
  );
  return lines.join('\n');
}

/**
 * Explains the current grand total from the real marks, names every subject's
 * contribution, and flags subjects whose total may add separate examinations.
 */
export function explainGrandTotal(context: ValidationContext, lang: ExplainLang): string {
  const students = context.students ?? [];
  if (students.length === 0) return notImportedMessage(lang);

  const student = students[0];
  const totals = computeTotals(student);
  const pct = totals.percentage === null ? '—' : `${totals.percentage}%`;
  const lines: string[] = [];
  lines.push(
    tri(
      lang,
      `${student.name}: obtained ${totals.totalMarks} / ${totals.totalMax} = ${pct}.`,
      `${student.name}: प्राप्त ${totals.totalMarks} / ${totals.totalMax} = ${pct}।`,
      `${student.name}: obtained ${totals.totalMarks} / ${totals.totalMax} = ${pct}.`,
    ),
  );
  for (const summary of totals.gradedSubjects) {
    if (summary.maxMarks === 0) continue;
    lines.push(`• ${summary.name}: ${summary.marks ?? '—'} / ${summary.maxMarks}`);
  }

  const ambiguous = analyzeExaminations(students).subjects.filter((plan) => plan.needsConfirmation);
  if (ambiguous.length > 0) {
    lines.push(
      tri(
        lang,
        `Note: ${ambiguous.map((plan) => `${plan.subject} (${plan.examinations.join(' and ')})`).join(', ')} add components from more than one examination with no TOTAL column. Until the rule is confirmed, the total assumes those marks are summed.`,
        `ध्यान दें: ${ambiguous.map((plan) => `${plan.subject} (${plan.examinations.join(' और ')})`).join(', ')} में एक से अधिक परीक्षा के components जोड़े जा रहे हैं और TOTAL column नहीं है। नियम की पुष्टि होने तक कुल में योग माना गया है।`,
        `Dhyan do: ${ambiguous.map((plan) => `${plan.subject} (${plan.examinations.join(' aur ')})`).join(', ')} me ek se zyada exam ke components jode ja rahe hain aur TOTAL column nahi hai. Rule confirm hone tak total me summation maana gaya hai.`,
      ),
    );
  } else {
    lines.push(
      tri(
        lang,
        'Every subject has either a single examination or an explicit TOTAL column, so no calculation rule is ambiguous.',
        'हर विषय में या तो एक ही परीक्षा है या स्पष्ट TOTAL column है, इसलिए कोई calculation नियम अस्पष्ट नहीं है।',
        'Har subject me ya to single exam hai ya explicit TOTAL column hai, isliye koi calculation rule ambiguous nahi hai.',
      ),
    );
  }
  return lines.join('\n');
}

/** Records the component the visitor actually named, when it is absent. */
function referencedMissingComponent(raw: string, names: string[]): string | null {
  const lower = names.map((name) => name.toLowerCase());
  const candidates: string[] = [];
  const rx = /\b(sa|fa|pt|nb|sea|ut|term|sem|t)\s*-?\s*(\d+)\b/gi;
  let match: RegExpExecArray | null;
  while ((match = rx.exec(raw))) candidates.push(`${match[1]}${match[2]}`.toLowerCase());
  for (const word of ['practical', 'theory', 'internal', 'oral', 'written']) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(raw)) candidates.push(word);
  }
  for (const candidate of candidates) {
    const present = lower.some((name) => name.replace(/[^a-z0-9]/g, '').includes(candidate.replace(/[^a-z0-9]/g, '')));
    if (!present) return candidate.toUpperCase();
  }
  return null;
}

/**
 * Explains the examination components the current workbook actually has, and
 * (when a component the user named is absent) says so instead of inventing one.
 */
export function explainExaminations(
  context: ValidationContext,
  raw: string,
  lang: ExplainLang,
): string {
  const students = context.students ?? [];
  if (students.length === 0) return notImportedMessage(lang);

  const report = analyzeExaminations(students);
  const lines: string[] = [];
  lines.push(
    tri(
      lang,
      report.componentNames.length > 0
        ? `Components found in this workbook: ${report.componentNames.join(', ')}.`
        : 'No examination components were detected in this workbook — it may be a single-marks-column format.',
      report.componentNames.length > 0
        ? `इस workbook में मिले components: ${report.componentNames.join(', ')}।`
        : 'इस workbook में कोई examination component नहीं मिला — शायद इसमें एक ही marks column है।',
      report.componentNames.length > 0
        ? `Is workbook me mile components: ${report.componentNames.join(', ')}.`
        : 'Is workbook me koi examination component nahi mila — shayad isme single marks column format hai.',
    ),
  );

  const missing = referencedMissingComponent(raw, report.componentNames);
  if (missing) {
    lines.push(
      tri(
        lang,
        `You asked about "${missing}" — I did not find it in the current workbook's components. Possible cause (unconfirmed): that column is missing from the file, or its header was mapped to something else. Check Import Students → column mapping, then re-import.`,
        `आपने "${missing}" के बारे में पूछा — यह मौजूदा workbook के components में नहीं मिला। संभावित कारण (अपुष्ट): वह column फ़ाइल में नहीं है, या उसका header कहीं और map हो गया। Import Students → column mapping जाँचें, फिर दोबारा आयात करें।`,
        `Aapne "${missing}" ke baare me poocha — ye current workbook ke components me nahi mila. Sambhavit karan (unconfirmed): wo column file me nahi hai, ya uska header kahin aur map ho gaya. Import Students → column mapping check karo, phir dobara import karo.`,
      ),
    );
  }

  for (const plan of report.subjects) {
    if (plan.combination === 'no-marks' || plan.combination === 'single-component') continue;
    const components = plan.components
      .filter((component) => !component.isTotal)
      .map((component) => `${component.name} (${component.maxMarks})`)
      .join(' + ');
    const note = plan.needsConfirmation
      ? ' — ' +
        tri(
          lang,
          `${plan.examinations.join(' and ')} look like separate examinations; confirm whether to sum them.`,
          `${plan.examinations.join(' और ')} अलग परीक्षाएँ लगती हैं; पुष्टि करें कि इन्हें जोड़ना है या नहीं।`,
          `${plan.examinations.join(' aur ')} alag exams lagte hain; confirm karo ki inhe jodna hai ya nahi.`,
        )
      : '';
    lines.push(`• ${plan.subject}: ${components}${note}`);
  }

  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Mapping, photo and generation diagnostics (real app state)          */
/* ------------------------------------------------------------------ */

/** First few names of a list, so Joy stays readable with 50 students. */
function nameSample(names: string[], max = 6): string {
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} +${names.length - max} more`;
}

const MAPPING_WORDS = [
  'mapping', 'mapped', 'map', 'column mapping', 'column', 'columns', 'header', 'headers',
  'wrong column', 'mis-mapped', 'mismapped', 'galat column', 'column galat', 'marks galat map',
  'map ho raha', 'map ho rahe', 'kis column', 'kaunsa column', 'kaunse column',
];
const MAPPING_RE = toRegexes(MAPPING_WORDS);
export const isMappingQuery = (text: string, tokens: string[]): boolean =>
  anyMatch(text, MAPPING_RE) || fuzzyKeywordMatch(tokens, MAPPING_WORDS) !== null;

const PHOTO_QUESTION_WORDS = [
  'photo', 'photos', 'picture', 'pictures', 'image', 'images', 'photograph', 'photograph',
];
const PHOTO_QUESTION_RE = toRegexes(PHOTO_QUESTION_WORDS);

/**
 * A photo question — it must actually mention a photo.
 *
 * Deliberately NOT triggered by words like "missing" or "blank" on their own:
 * "Why is SA2 missing?" is an examination question, and a photo answer there
 * would be wrong.
 */
export const isPhotoQuery = (text: string, tokens: string[]): boolean =>
  anyMatch(text, PHOTO_QUESTION_RE) ||
  fuzzyKeywordMatch(tokens, PHOTO_QUESTION_WORDS) !== null;

const GENERATION_WORDS = ['generation', 'generate', 'generating', 'pdf', 'zip', 'export', 'download'];
const GENERATION_FAILURE_WORDS = [
  'fail', 'failed', 'failing', 'failure', 'error', 'errors', 'galat', 'stuck', 'problem',
  'issue', 'issues', 'why', 'kyun', 'kyu', 'nahi ban', 'nahi chal', 'band',
];
const GENERATION_RE = toRegexes(GENERATION_WORDS);
const GENERATION_FAILURE_RE = toRegexes(GENERATION_FAILURE_WORDS);

/**
 * A question about a generation that FAILED — a generation word plus a failure
 * word. "How many free generations do I get?" must not be mistaken for one.
 */
export const isGenerationFailureQuery = (text: string, tokens: string[]): boolean =>
  (anyMatch(text, GENERATION_RE) || fuzzyKeywordMatch(tokens, GENERATION_WORDS) !== null) &&
  (anyMatch(text, GENERATION_FAILURE_RE) ||
    fuzzyKeywordMatch(tokens, GENERATION_FAILURE_WORDS) !== null);

/**
 * Explains the ACTUAL column mapping and flags any column that is mapped as a
 * subject but does not hold marks.
 *
 * The evidence is the parsed workbook itself: how many students have a numeric
 * value in that column and one real sample value. When a column holds no marks,
 * the EXISTING auto-mapper is asked what the header normally means, so Joy can
 * name the field the column should be mapped to instead of guessing.
 */
export function explainMapping(context: JoyContext, lang: ExplainLang): string {
  const students = context.students ?? [];
  const mapping = context.columnMapping ?? [];
  if (students.length === 0) return notImportedMessage(lang);
  if (mapping.length === 0) {
    return tri(
      lang,
      "I can't see the confirmed column mapping for this import. Open Import Students → Column Mapping and confirm the mapping, then ask me again — I'll tell you exactly which column is which.",
      'इस import की confirmed column mapping मुझे नहीं दिख रही। Import Students → Column Mapping खोलें और mapping confirm करें, फिर पूछें — मैं बता दूँगी कौनसा column क्या है।',
      'Is import ki confirmed column mapping mujhe nahi dikh rahi. Import Students → Column Mapping kholo aur mapping confirm karo, phir poocho — main bata dungi kaunsa column kya hai.',
    );
  }

  const subjectColumns = mapping.filter((column) => column.fieldKey === 'subject');
  const studentColumns = mapping.filter(
    (column) => column.fieldKey !== 'subject' && column.fieldKey !== 'ignore',
  );

  const lines: string[] = [];
  lines.push(
    tri(
      lang,
      `Current mapping: ${subjectColumns.length} subject column(s) and ${studentColumns.length} student field column(s) across ${students.length} student(s).`,
      `मौजूदा mapping: ${subjectColumns.length} subject column और ${studentColumns.length} student field column, कुल ${students.length} छात्र।`,
      `Abhi ki mapping: ${subjectColumns.length} subject column aur ${studentColumns.length} student field column, total ${students.length} student.`,
    ),
  );

  /* Every subject column's evidence: numeric marks vs real sample values. */
  const autoDetected = new Map(
    autoMapColumns([...new Set(mapping.map((column) => column.columnName))]).map((column) => [
      column.columnName,
      column.fieldKey,
    ]),
  );

  const suspicious: string[] = [];
  for (const column of subjectColumns) {
    const subjectName = (column.subjectName || column.columnName).trim();
    const matches = students
      .flatMap((student) => student.subjects)
      .filter((subject) => subject.name.trim().toLowerCase() === subjectName.toLowerCase());
    if (matches.length === 0) continue;

    const numeric = matches.filter(
      (subject) => subject.status === 'present' && typeof subject.marks === 'number',
    ).length;
    const sample = matches
      .map((subject) => subject.rawValue)
      .find((value) => value !== undefined && String(value).trim() !== '');

    if (numeric === 0) {
      /*
       * Nothing numeric in this column: it is very probably not marks. Name the
       * field the existing auto-mapper would give this header.
       */
      const detected = autoDetected.get(column.columnName);
      const shouldBe =
        detected && detected !== 'subject' && detected !== 'ignore' && detected !== 'overallField'
          ? ` It is normally detected as "${detected}".`
          : '';
      suspicious.push(
        `• "${column.columnName}" is mapped as the subject "${subjectName}", but 0 of ${matches.length} students have a numeric value in it${sample ? ` (sample: "${sample}")` : ''}.${shouldBe}`,
      );
    }
  }

  if (suspicious.length > 0) {
    lines.push('');
    lines.push(
      tri(
        lang,
        `${suspicious.length} subject column(s) hold no marks — this is a mapping problem, not a marks problem:`,
        `${suspicious.length} subject column में कोई अंक नहीं है — यह mapping की समस्या है, अंकों की नहीं:`,
        `${suspicious.length} subject column me koi marks nahi hain — ye mapping ki problem hai, marks ki nahi:`,
      ),
    );
    lines.push(...suspicious);
    lines.push(
      tri(
        lang,
        'Fix: open Import Students → step 2 “Column Mapping”, set each of those columns to the correct field (for example Father’s Name, D.O.B or Attendance), confirm the mapping and import again.',
        'सुधार: Import Students → step 2 “Column Mapping” खोलें, उन columns को सही field पर सेट करें (जैसे Father’s Name, D.O.B या Attendance), mapping confirm करके दोबारा import करें।',
        'Fix: Import Students → step 2 “Column Mapping” kholo, un columns ko sahi field par set karo (jaise Father’s Name, D.O.B ya Attendance), mapping confirm karke dobara import karo.',
      ),
    );
  } else {
    lines.push(
      tri(
        lang,
        'Every subject column carries numeric marks for at least one student, so no column looks mis-mapped.',
        'हर subject column में कम से कम एक छात्र के अंक numeric हैं, इसलिए कोई column गलत mapped नहीं लगता।',
        'Har subject column me kam se kam ek student ke marks numeric hain, isliye koi column galat mapped nahi lagta.',
      ),
    );
  }

  if (subjectColumns.length > 0) {
    lines.push('');
    lines.push(tri(lang, 'Subject columns', 'Subject columns', 'Subject columns'));
    for (const column of subjectColumns) {
      const subjectName = (column.subjectName || column.columnName).trim();
      const component = column.componentName ? ` [${column.componentName}]` : '';
      const max = column.maxMarks ? ` — max ${column.maxMarks}` : '';
      lines.push(`• ${column.columnName} → ${subjectName}${component}${max}`);
    }
  }

  return lines.join('\n');
}

/**
 * Explains the LIVE photo state: how many photos were loaded, who will print a
 * photo, and why each blank one is blank — using the same resolver the PDF
 * generator uses.
 */
export function explainPhotoMatching(context: JoyContext, lang: ExplainLang): string {
  const students = context.students ?? [];
  if (students.length === 0) return notImportedMessage(lang);

  const photoMap = context.photoMap ?? {};
  const distinct = new Set(Object.values(photoMap)).size;
  const { photos, status, conflicts } = resolvePhotosWithOverrides(
    students,
    photoMap,
    context.photoOverrides ?? {},
  );

  const byStatus = (wanted: string): string[] =>
    students
      .filter((student) => status.get(student.studentId) === wanted)
      .map((student) => `${student.name}${student.rollNo ? ` (Roll ${student.rollNo})` : ''}`);

  const ambiguous = byStatus('ambiguous');
  const missing = byStatus('missing');
  const manual = byStatus('manual');
  const cleared = byStatus('cleared');

  const lines: string[] = [];
  lines.push(
    tri(
      lang,
      `Photo review for the current import: ${distinct} distinct photo(s) loaded, ${photos.size} of ${students.length} student(s) will print a photo.`,
      `मौजूदा import की photo review: ${distinct} अलग photo लोड हैं, ${students.length} में से ${photos.size} छात्र का photo print होगा।`,
      `Abhi ke import ki photo review: ${distinct} distinct photo load hain, ${students.length} me se ${photos.size} student ka photo print hoga.`,
    ),
  );

  if (distinct === 0) {
    lines.push(
      tri(
        lang,
        'No photo ZIP has been uploaded for this import, so every card prints the blank photo box. Upload a ZIP in Import Students → step 4 “Photos”, or attach a single photo per student in step 5 → Student photo review.',
        'इस import के लिए कोई photo ZIP upload नहीं हुआ, इसलिए हर card में खाली photo box छपेगा। Import Students → step 4 “Photos” में ZIP upload करें, या step 5 → Student photo review में एक-एक photo लगाएँ।',
        'Is import ke liye koi photo ZIP upload nahi hua, isliye har card me blank photo box chhapega. Import Students → step 4 “Photos” me ZIP upload karo, ya step 5 → Student photo review me ek-ek photo lagao.',
      ),
    );
  }

  if (ambiguous.length > 0) {
    lines.push('');
    lines.push(
      tri(
        lang,
        `Needs review (${ambiguous.length}) — the same photo fits more than one child, or the identifier conflicts, so the card is left blank rather than risk the wrong photograph:`,
        `समीक्षा चाहिए (${ambiguous.length}) — एक ही photo एक से ज़्यादा बच्चों पर लगती है, या पहचान टकरा रही है, इसलिए गलत photo से बचने के लिए card खाली रखा गया है:`,
        `Review chahiye (${ambiguous.length}) — ek hi photo ek se zyada bachchon par lagti hai, ya identifier conflict kar raha hai, isliye galat photo se bachne ke liye card blank rakha gaya hai:`,
      ),
    );
    lines.push(`• ${nameSample(ambiguous)}`);
    lines.push(
      tri(
        lang,
        'Fix: rename the photo to the student’s roll number (e.g. “13_name.jpg”), or correct the Roll No column, or pick the right picture by hand in Import Students → step 5 → Student photo review → “Change photo”.',
        'सुधार: photo का नाम छात्र के roll number पर रखें (जैसे “13_name.jpg”), या Roll No column ठीक करें, या Import Students → step 5 → Student photo review → “Change photo” से सही photo चुनें।',
        'Fix: photo ka naam student ke roll number par rakho (jaise “13_name.jpg”), ya Roll No column theek karo, ya Import Students → step 5 → Student photo review → “Change photo” se sahi photo chuno.',
      ),
    );
  }

  if (missing.length > 0) {
    lines.push('');
    lines.push(
      tri(
        lang,
        `No photo matched (${missing.length}) — nothing in the ZIP points at these students, so their card prints the blank photo box:`,
        `कोई photo match नहीं हुई (${missing.length}) — ZIP में इन छात्रों की ओर कोई संकेत नहीं है, इसलिए उनके card में खाली photo box छपेगा:`,
        `Koi photo match nahi hui (${missing.length}) — ZIP me in students ki taraf koi ishara nahi hai, isliye unke card me blank photo box chhapega:`,
      ),
    );
    lines.push(`• ${nameSample(missing)}`);
    lines.push(
      tri(
        lang,
        'Fix: add a photo named after the roll number or admission number, or attach one manually in Student photo review.',
        'सुधार: roll number या admission number के नाम से photo जोड़ें, या Student photo review में हाथ से लगाएँ।',
        'Fix: roll number ya admission number ke naam se photo jodo, ya Student photo review me haath se lagao.',
      ),
    );
  }

  if (manual.length > 0 || cleared.length > 0) {
    lines.push('');
    if (manual.length > 0) {
      lines.push(
        tri(
          lang,
          `Set by hand (${manual.length}): ${nameSample(manual)}.`,
          `हाथ से चुनी गई (${manual.length}): ${nameSample(manual)}।`,
          `Haath se chuni gayi (${manual.length}): ${nameSample(manual)}.`,
        ),
      );
    }
    if (cleared.length > 0) {
      lines.push(
        tri(
          lang,
          `Cleared on purpose (${cleared.length}): ${nameSample(cleared)} — these print no photo.`,
          `जान-बूझकर हटाई गई (${cleared.length}): ${nameSample(cleared)} — इनमें photo नहीं छपेगी।`,
          `Jaan-boojh kar hatayi gayi (${cleared.length}): ${nameSample(cleared)} — inme photo nahi chhapegi.`,
        ),
      );
    }
  }

  if (conflicts.length > 0) {
    lines.push('');
    lines.push(
      tri(
        lang,
        `Note: the same picture was chosen by hand for ${conflicts.length} students (${nameSample(conflicts)}). Your choice is used exactly as made — check that each child really has that photo.`,
        `ध्यान दें: ${conflicts.length} छात्रों के लिए एक ही photo हाथ से चुनी गई है (${nameSample(conflicts)})। आपकी चुनी हुई photo ही लगेगी — जाँच लें कि हर बच्चे की वही photo है।`,
        `Dhyan do: ${conflicts.length} students ke liye ek hi photo haath se chuni gayi hai (${nameSample(conflicts)}). Aapki chuni hui photo hi lagegi — check kar lo ki har bachche ki wahi photo hai.`,
      ),
    );
  }

  if (lines.length === 1) {
    lines.push(
      tri(
        lang,
        'Every student already has a confirmed photo, so nothing needs review.',
        'हर छात्र की photo confirm है, कुछ समीक्षा करने की ज़रूरत नहीं।',
        'Har student ka photo confirm hai, kuch review karne ki zaroorat nahi.',
      ),
    );
  }

  return lines.join('\n');
}

/**
 * Explains a real generation run: what was produced and, from the generator's
 * own error strings, why each failed student failed.
 */
export function explainGenerationFailures(context: JoyContext, lang: ExplainLang): string {
  const generation = context.generation;
  const results = generation?.results ?? [];

  if (!generation || (results.length === 0 && generation.status === 'idle')) {
    return tri(
      lang,
      'No report generation has run in this session yet, so there is nothing to diagnose. Open Generate Reports and press Generate — if anything fails, ask me again and I will explain each failure from the real error.',
      'इस session में अभी कोई report generation नहीं चली, इसलिए जाँचने के लिए कुछ नहीं है। Generate Reports खोलें और Generate दबाएँ — कुछ fail हो तो मुझसे फिर पूछें, मैं असली error से हर failure समझा दूँगी।',
      'Is session me abhi koi report generation nahi chali, isliye diagnose karne ke liye kuch nahi hai. Generate Reports kholo aur Generate dabao — kuch fail ho to mujhse phir poocho, main asli error se har failure samjha dungi.',
    );
  }

  const failed = results.filter((result) => !result.success);
  const succeeded = results.filter((result) => result.success);
  const lines: string[] = [];

  if (generation.status === 'running') {
    lines.push(
      tri(
        lang,
        `A generation run is still going: ${generation.completed} done, ${generation.failed} failed, ${generation.total} in total.`,
        `एक generation अभी चल रही है: ${generation.completed} हो गए, ${generation.failed} fail, कुल ${generation.total}।`,
        `Ek generation abhi chal rahi hai: ${generation.completed} ho gaye, ${generation.failed} fail, total ${generation.total}.`,
      ),
    );
  }

  lines.push(
    tri(
      lang,
      `Last generation run: ${succeeded.length} report card(s) produced, ${failed.length} failed.`,
      `पिछली generation: ${succeeded.length} report card बने, ${failed.length} fail हुए।`,
      `Pichhli generation: ${succeeded.length} report card bane, ${failed.length} fail hue.`,
    ),
  );

  if (failed.length === 0) {
    lines.push(
      tri(
        lang,
        'Nothing failed, so there is nothing to fix. The ZIP is ready to download on Generate Reports.',
        'कुछ fail नहीं हुआ, ठीक करने को कुछ नहीं है। ZIP Generate Reports पर download के लिए तैयार है।',
        'Kuch fail nahi hua, theek karne ko kuch nahi hai. ZIP Generate Reports par download ke liye taiyar hai.',
      ),
    );
    return lines.join('\n');
  }

  lines.push('');
  lines.push(
    tri(
      lang,
      'Each failure with its real reason from the generator:',
      'हर failure और generator का असली कारण:',
      'Har failure aur generator ka asli karan:',
    ),
  );
  for (const result of failed.slice(0, 12)) {
    lines.push(
      `• ${result.name} (Roll ${result.rollNo}, row ${result.rowNumber}): ${result.error || 'no reason reported'}`,
    );
  }
  if (failed.length > 12) {
    lines.push(`• +${failed.length - 12} more — use “Export Failed CSV” on Generate Reports for the full list.`);
  }

  lines.push('');
  lines.push(
    tri(
      lang,
      'A card is refused rather than printed wrong, so each reason above points at the data: fix that student’s record (marks, name, roll number or duplicate roll) in Import Students, or run the export with “All records” and re-generate. Only the failed students need re-running.',
      'गलत card छापने के बजाय रोक दिया जाता है, इसलिए ऊपर का हर कारण data की ओर इशारा करता है: Import Students में उस छात्र का record ठीक करें (अंक, नाम, roll number या duplicate roll), या “All records” से export चलाएँ और दोबारा generate करें। सिर्फ fail हुए छात्र दोबारा चलाने होंगे।',
      'Galat card chhapne ke bajaye rok diya jata hai, isliye upar ka har karan data ki taraf ishara karta hai: Import Students me us student ka record theek karo (marks, naam, roll number ya duplicate roll), ya “All records” se export chalao aur dobara generate karo. Sirf fail hue students dobara chalane honge.',
    ),
  );

  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Cross-section navigation                                          */
/* ------------------------------------------------------------------ */

/**
 * The Digital Greetings section already implemented in Ishmaverse.
 *
 * The Studio runs in an iframe, but it is same-origin with the mall, so Joy can
 * hand the parent window this exact route instead of inventing a URL. The free
 * Welcome Card lives at the very top of this section — opening it is the start
 * of the free greeting-card creation flow.
 */
export const GREETING_ROUTE = '/section/greetings';

/**
 * Words that mean the visitor wants the mall's greeting cards, not ReportCard
 * Studio (English + Hinglish). Multi-word entries keep a bare "card" from ever
 * hijacking a report-card question.
 */
const GREETING_WORDS = [
  'greeting', 'greetings', 'greeting card', 'greeting cards', 'digital greetings', 'digital greeting',
  'e card', 'ecard', 'e-card', 'welcome card', 'free welcome card', 'free card', 'free greeting',
  'free greeting card', 'free greeting cards', 'wish card', 'wishing card', 'birthday card',
  'anniversary card', 'wedding card', 'diwali card', 'christmas card', 'holiday card',
  'thank you card', 'invitation card', 'greeting card banana', 'greeting card banao',
  'greeting card banan', 'greeting banana', 'greeting banao', 'greeting kaha', 'greeting kahan',
  'greeting chahiye', 'card banana', 'card banan', 'card bnana', 'card banao', 'card chahiye',
  'card kaha', 'card kahan', 'greeting dikhao', 'greeting kholo', 'card section',
];
const GREETING_RE = toRegexes(GREETING_WORDS);

/** Markers that keep a report-card question on ReportCard Studio. */
const REPORT_CARD_MARKERS = [
  'report card', 'reportcard', 'report-card', 'marksheet', 'mark sheet', 'studio', 'excel', 'pdf',
];
const isReportCardContext = (text: string): boolean =>
  REPORT_CARD_MARKERS.some((marker) => text.includes(marker));

/** True when the message asks to see / create the mall's greeting cards. */
export const isGreetingRequest = (text: string, tokens: string[]): boolean =>
  anyMatch(text, GREETING_RE) || fuzzyKeywordMatch(tokens, GREETING_WORDS) !== null;

const FAQ_REGEXES = FAQ.map((entry) => toRegexes(entry.keywords));

export interface StudioAnswer {
  reply: string;
  /** Present when the answer is a screen walkthrough. */
  guide?: { steps: GuideStep[]; index: number };
  /** One-tap follow-up questions. */
  chips: JoyText[];
  /** Mall route Joy should open (the caller navigates the parent window). */
  navigate?: string;
}

/**
 * Answers a visitor's message for the screen they are on.
 *
 * Resolution order: an FAQ hit (specific), then a guide request for the current
 * screen, then the screen's own intro. Everything is bilingual and nothing is
 * invented — only what the Studio actually does.
 */
/* ------------------------------------------------------------------ */
/* Every Ishmaverse section (the Studio twin is not Studio-only)        */
/* ------------------------------------------------------------------ */

/**
 * Joy is Ishmaverse's assistant, not a ReportCard Studio bot.
 *
 * The Studio runs inside the mall, so a visitor asks her about the OTHER
 * sections from here too — what they are, how to use them and what usually goes
 * wrong. This bank answers those questions instead of refusing them, and hands
 * the parent window the section's real route when the visitor wants to go there.
 *
 * It is deliberately self-contained: ReportCard Studio is shipped as a
 * standalone SPA (it can be dropped into any site), so it never imports the
 * mall's own source. `scripts/check-joy-sections.ts` asserts this table still
 * matches `src/data/sections.ts` (ids, names and availability).
 *
 * Answers here are English or Hinglish — the two the visitor asked for; the
 * Studio's own screens stay trilingual as before.
 */
export interface MallSectionKnowledge {
  id: string;
  name: string;
  emoji: string;
  available: boolean;
  /** Multi-word keywords only, so "card" or "ai" can never hijack a Studio question. */
  keywords: string[];
  what: { en: string; hinglish: string };
  /** The things that actually go wrong here, each with its cause and its fix. */
  problems: { keywords: string[]; en: string; hinglish: string }[];
}

export const MALL_KNOWLEDGE: MallSectionKnowledge[] = [
  {
    id: 'greetings',
    name: 'Digital Greetings',
    emoji: '💌',
    available: true,
    keywords: [
      'digital greetings', 'greeting card', 'greeting cards', 'welcome card', 'free greeting',
      'birthday card', 'anniversary card', 'wedding card', 'diwali card', 'greeting section',
    ],
    what: {
      en: 'Digital Greetings 💌 is the card section: animated cards for birthdays, anniversaries, weddings, Diwali and more, plus a FREE Welcome Card pinned at the top. A card lives for 48 hours and is shared with one link.',
      hinglish: 'Digital Greetings 💌 card section hai: birthday, anniversary, wedding, Diwali waghairah ke animated cards, aur sabse upar FREE Welcome Card. Card 48 ghante live rehta hai aur ek link se share hota hai.',
    },
    problems: [
      {
        keywords: ['photo upload fail', 'photo upload nahi', 'photo error', 'photo nahi lag'],
        en: 'Photo upload fails 📷 — the photo goes through the upload-image function, so it needs that function deployed and IMGBB_API_KEY set. Keep the file under a few MB as JPEG/PNG; an oversized or HEIC file is rejected before it is stored.',
        hinglish: 'Photo upload fail 📷 — photo upload-image function se jaati hai, isliye woh function deployed hona chahiye aur IMGBB_API_KEY set hona chahiye. File kuch MB se kam aur JPEG/PNG rakho; bahut badi ya HEIC file store hone se pehle hi reject ho jaati hai.',
      },
      {
        keywords: ['link not opening', 'card not opening', 'link nahi khul', 'card expire', 'link expired', 'card kyu nahi'],
        en: 'A card link stops opening after 48 hours — that is the card’s lifetime, free or paid. Make a fresh card for a fresh 48 hours. If it is inside 48 hours and still not opening, the card id in the link is wrong or the card was deleted with its manage link.',
        hinglish: 'Card ka link 48 ghante baad khulna band ho jaata hai — free ho ya paid, lifetime 48 ghante hi hai. Nayi 48 ghante ke liye naya card banao. Agar 48 ghante ke andar bhi nahi khul raha to link ka card id galat hai ya card uske manage link se delete ho chuka hai.',
      },
      {
        keywords: ['payment failed', 'double charged', 'refund', 'paisa kat gaya', 'money deducted'],
        en: 'A failed or doubled payment 💳 — do not pay again. The server is idempotent on the payment id, so retrying the same order returns the original card instead of charging twice. Send the payment id (pay_…) and your email to the team for a refund or re-issue.',
        hinglish: 'Payment fail ya double charge 💳 — dobara pay mat karo. Server payment id par idempotent hai, isliye wahi order retry karne par naya charge nahi hota, wahi card milta hai. Payment id (pay_…) aur apna email team ko bhejo — refund ya re-issue ho jaata hai.',
      },
    ],
  },
  {
    id: 'game-zone',
    name: 'Game Zone',
    emoji: '🎮',
    available: true,
    keywords: [
      'game zone', 'pair 3 balls', 'pair3balls', 'pair-3balls', 'three balls game',
      'world match', 'private room', 'room code', 'online game', 'game khel', 'game khelna',
    ],
    what: {
      en: 'Game Zone 🎮 is Pair-3Balls: nine points, three pieces each, one line to win, 60 seconds per turn. Three modes — vs Computer (offline), a Private Room with a code, and World Match against a real player.',
      hinglish: 'Game Zone 🎮 me Pair-3Balls hai: nau points, teen pieces, ek line banao aur jeeto, har turn 60 second. Teen modes — Computer ke saath (offline), Private Room (code se) aur World Match (asli player se).',
    },
    problems: [
      {
        keywords: ['online modes unavailable', 'online nahi chal', 'online unavailable', 'online mode off', 'game not working online'],
        en: 'If the library says the online modes are unavailable, the Game Zone backend is switched off or Supabase is not configured — offline games (vs Computer) still play. Nothing is faked: the badge appears when the server-side setting is off or unreachable.',
        hinglish: 'Agar library me likha hai ki online modes unavailable hain, to Game Zone ka backend off hai ya Supabase configure nahi hai — offline game (Computer ke saath) phir bhi chalta hai. Kuch fake nahi hota: ye badge tab dikhta hai jab server-side setting off ho ya server na mile.',
      },
      {
        keywords: ['room code not working', 'room code galat', 'code invalid', 'code nahi chal', 'join nahi ho raha'],
        en: 'A room code is 6 characters and is valid while that room is live. A code from an older game, or a room whose host left and got cleaned up, cannot be joined — create a fresh Private Room and send the new code or invite link.',
        hinglish: 'Room code 6 characters ka hota hai aur tab tak valid hai jab tak woh room live hai. Purane game ka code, ya jis room ka host chala gaya aur room cleanup ho gaya, usme join nahi hota — naya Private Room banao aur naya code ya invite link bhejo.',
      },
    ],
  },
  {
    id: 'reportcard-studio',
    name: 'ReportCard Studio',
    emoji: '📊',
    available: true,
    keywords: [
      'reportcard studio', 'report card studio', 'reportcard', 'report card section', 'studio section',
    ],
    what: {
      en: 'ReportCard Studio 📊 turns an Excel mark sheet into print-ready report cards (holistic or academic) as PDFs. You are inside it right now — the first 7 generations are free.',
      hinglish: 'ReportCard Studio 📊 Excel mark sheet se print-ready report cards (holistic ya academic) PDF me banata hai. Aap abhi isi ke andar ho — pehli 7 generations free hain.',
    },
    problems: [],
  },
  {
    id: 'tech-ai',
    name: 'Tech & AI',
    emoji: '🤖',
    available: false,
    keywords: ['tech and ai', 'tech & ai', 'tech ai', 'autocad', 'wiring assistant', 'automation tool'],
    what: {
      en: 'Tech & AI 🤖 will hold AutoCAD scripts, wiring assistants and automation tools. It is not live yet (“Coming soon”) — the section page is the honest placeholder until it is stocked.',
      hinglish: 'Tech & AI 🤖 me AutoCAD scripts, wiring assistants aur automation tools aayenge. Abhi live nahi hai (“Coming soon”) — jab tak stock na ho, section page sirf honest placeholder hai.',
    },
    problems: [],
  },
  {
    id: 'education',
    name: 'Education',
    emoji: '📚',
    available: false,
    keywords: ['education section', 'sample papers', 'question bank', 'study material', 'notes section'],
    what: {
      en: 'Education 📚 will carry notes, sample papers and question banks. It is “Coming soon” — nothing is sold there yet.',
      hinglish: 'Education 📚 me notes, sample papers aur question banks aayenge. Abhi “Coming soon” hai — wahan se kuch bikta nahi.',
    },
    problems: [],
  },
  {
    id: 'originals',
    name: 'Originals',
    emoji: '✨',
    available: false,
    keywords: ['originals section', 'print on demand', 'premium artwork', 'wallpaper pack'],
    what: {
      en: 'Originals ✨ will offer premium artwork, wallpapers and print-on-demand pieces. It is “Coming soon”.',
      hinglish: 'Originals ✨ me premium artwork, wallpapers aur print-on-demand items aayenge. Abhi “Coming soon” hai.',
    },
    problems: [],
  },
  {
    id: 'ui-themes',
    name: 'UI Themes & Scripts',
    emoji: '🎨',
    available: false,
    keywords: ['ui themes', 'figma kit', 'figma kits', 'web layout', 'mockup pack'],
    what: {
      en: 'UI Themes & Scripts 🎨 will sell Figma kits, web layouts and mockups. It is “Coming soon”.',
      hinglish: 'UI Themes & Scripts 🎨 me Figma kits, web layouts aur mockups milenge. Abhi “Coming soon” hai.',
    },
    problems: [],
  },
  {
    id: 'fx-studios',
    name: 'FX / Studios',
    emoji: '🎬',
    available: false,
    keywords: ['fx studios', 'fx / studios', 'video effects', 'premiere pack', 'video transitions'],
    what: {
      en: 'FX / Studios 🎬 will offer video effects, transitions and Premiere packs. It is “Coming soon”.',
      hinglish: 'FX / Studios 🎬 me video effects, transitions aur Premiere packs aayenge. Abhi “Coming soon” hai.',
    },
    problems: [],
  },
  {
    id: 'comics',
    name: 'Comics',
    emoji: '📖',
    available: false,
    keywords: ['comics section', 'graphic novel', 'comic book', 'manga series'],
    what: {
      en: 'Comics 📖 will carry graphic novels and ongoing series. It is “Coming soon”.',
      hinglish: 'Comics 📖 me graphic novels aur ongoing series aayengi. Abhi “Coming soon” hai.',
    },
    problems: [],
  },
];

export const mallSectionRoute = (id: string): string => `/section/${id}`;

const MALL_LIST_WORDS = [
  'sections', 'section list', 'all sections', 'which sections', 'what sections', 'kaunse section',
  'kaun kaun section', 'sab section', 'saare section', 'kya kya hai', 'what is inside ishmaverse',
  'what does ishmaverse have', 'ishmaverse me kya', 'mall sections',
];
const MALL_LIST_RE = toRegexes(MALL_LIST_WORDS);

/**
 * Deliberately exact (no fuzzy pass): a section's own name contains the word
 * "section" ("education section"), and a loose match would answer the whole
 * mall list instead of that one section.
 */
export const isMallListQuery = (text: string): boolean => anyMatch(text, MALL_LIST_RE);

/** One line per section, with what is live and what is still coming. */
const describeSections = (lang: JoyLang): string => {
  const lines = MALL_KNOWLEDGE.map((section) => {
    const state = section.available
      ? sectionText(lang, 'live', 'live')
      : sectionText(lang, 'coming soon', 'coming soon');
    return `${section.emoji} ${section.name} — ${state}: ${sectionText(lang, section.what.en, section.what.hinglish)}`;
  });
  return [
    sectionText(
      lang,
      'Ishmaverse is a digital mall with these sections:',
      'Ishmaverse ek digital mall hai, in sections ke saath:',
    ),
    ...lines,
  ].join('\n');
};

/**
 * The section answer for a question asked inside the Studio.
 *
 * Nothing is guessed: a section the mall does not have is not invented, and the
 * problems list only ever holds conditions the app itself reports (an
 * unreachable backend, an expired 48-hour link, a cleaned-up room).
 */
export const resolveMallSectionAnswer = (
  raw: string,
  lang: JoyLang,
  options: {
    /**
     * True when the message is about report cards. The Studio section then keeps
     * its own, sharper answers (free tries, plans, the workflow) instead of the
     * generic "you are inside it right now" line.
     */
    reportCardContext?: boolean;
  } = {},
): StudioAnswer | null => {
  const text = normalize(raw);
  if (!text) return null;
  const tokens = tokensOf(text);

  /* Longest keyword wins, so "report card studio" beats a generic "studio". */
  let best: { section: MallSectionKnowledge; keyword: string } | null = null;
  for (const section of MALL_KNOWLEDGE) {
    for (const keyword of section.keywords) {
      const matched =
        new RegExp(`\\b${escapeRegExp(keyword)}\\b`, 'i').test(text) ||
        fuzzyKeywordMatch(tokens, [keyword]) !== null;
      if (!matched) continue;
      if (!best || keyword.length > best.keyword.length) best = { section, keyword };
    }
  }

  if (best && best.section.id === 'reportcard-studio' && options.reportCardContext) return null;

  /* A named section always beats the whole-mall list. */
  if (!best && isMallListQuery(text)) {
    return {
      reply: describeSections(lang),
      chips: MALL_KNOWLEDGE.slice(0, 3).map((section) => ({
        en: `What is ${section.name}?`,
        hi: `${section.name} kya hai?`,
      })),
    };
  }

  if (!best) return null;

  const { section } = best;

  /* A question about something going wrong in that section. */
  const problem = section.problems.find((entry) => anyMatch(text, toRegexes(entry.keywords)));
  if (problem) {
    return {
      reply: `${section.emoji} ${section.name} — ${sectionText(lang, problem.en, problem.hinglish)}`,
      chips: [
        { en: `What is ${section.name}?`, hi: `${section.name} kya hai?` },
        { en: 'Is there a problem anywhere else?', hi: 'Kahin aur koi problem hai?' },
      ],
    };
  }

  const where = sectionText(
    lang,
    `It lives in the “${section.name}” section — I can open it for you.`,
    `Ye “${section.name}” section me hai — main khol sakti hoon.`,
  );
  return {
    reply: `${section.emoji} ${sectionText(lang, section.what.en, section.what.hinglish)}\n\n${where}`,
    navigate: mallSectionRoute(section.id),
    chips: section.problems.slice(0, 2).map((entry) => ({
      en: `Something is wrong in ${section.name}`,
      hi: `${section.name} me kuch gadbad hai`,
    })),
  };
};

/**
 * The language slot for the section bank: English and Hinglish, as asked. A
 * Devanagari question falls back to English here (the Studio's own screens keep
 * their full Hindi).
 */
const sectionText = (lang: JoyLang, en: string, hinglish: string): string =>
  lang === 'hi' ? hinglish : en;

export const resolveStudioQuery = (
  raw: string,
  routeKey: StudioScreen,
  lang: JoyLang,
  context?: JoyContext,
): StudioAnswer | null => {
  const text = normalize(raw);
  if (!text) return null;

  const guide = SCREEN_GUIDES[routeKey];
  const tokens = tokensOf(text);

  /*
   * 0) A greeting-card request is a navigation/action request for a DIFFERENT
   *    Ishmaverse section. It must win before the ReportCard Studio FAQ bank,
   *    otherwise the broad "free" keyword answers "free report generations"
   *    instead of taking the visitor to Digital Greetings.
   */
  if (!isReportCardContext(text) && isGreetingRequest(text, tokens)) {
    return {
      reply: pick(
        {
          en: 'Digital Greetings 💌 is a different section of Ishmaverse — the FREE Welcome Card sits right at the top, and you can make and send it at no cost. I’m opening the Digital Greetings section now; pick the free card and tap “Create card” to start. This will leave ReportCard Studio.',
          hi: 'Digital Greetings 💌 Ishmaverse ka doosra section hai — sabse upar FREE Welcome Card hai, aur use bilkul free bana ke bhej sakte ho. Main abhi Digital Greetings section khol rahi hoon; free card chuno aur “Create card” dabao. Isse ReportCard Studio chhodna padega.',
        },
        lang,
      ),
      navigate: GREETING_ROUTE,
      chips: guide.chips,
    };
  }

  /*
   * 0-ii) Any OTHER Ishmaverse section — what it is, how to use it, and what
   *       usually goes wrong there — answered instead of refused. Only a
   *       matched section keyword triggers this (so a Studio-state question
   *       like "photo upload fail" still reaches the photo handler below), and
   *       a report-card question keeps its own, sharper Studio answer.
   */
  const mallSection = resolveMallSectionAnswer(raw, lang, {
    reportCardContext: isReportCardContext(text),
  });
  if (mallSection) return mallSection;

  /*
   * 0a) A mapping question is answered from the *current* mapping, before the
   *     validation handler (its keywords include "galat", which a mapping
   *     question also uses) and before the FAQ bank.
   */
  if (context && isMappingQuery(text, tokens) && !isValidationQuery(text, tokens)) {
    return {
      reply: explainMapping(context, studioReplyLanguage(raw)),
      chips: guide.chips,
    };
  }

  /*
   * 0b) A photo question is answered from the LIVE photo state — which photos
   *     are loaded, who will print one, and why the blank ones are blank —
   *     instead of the generic "photos match by name" FAQ entry.
   */
  if (context && isPhotoQuery(text, tokens)) {
    return {
      reply: explainPhotoMatching(context, studioReplyLanguage(raw)),
      chips: guide.chips,
    };
  }

  /*
   * 0c) "Why did generation fail?" is answered from the real generation run.
   */
  if (context && isGenerationFailureQuery(text, tokens)) {
    return {
      reply: explainGenerationFailures(context, studioReplyLanguage(raw)),
      chips: guide.chips,
    };
  }

  /*
   * 0d) A validation question is answered from the *current* import when the
   *     caller has provided validation context. This must win before the FAQ
   *     bank, whose broad "error / issue / warning" entries would otherwise
   *     give a generic answer.
   */
  if (context && isValidationQuery(text, tokens)) {
    return {
      reply: explainValidation(context, studioReplyLanguage(raw)),
      chips: guide.chips,
    };
  }

  /*
   * 0c) Examination / maximum-marks / grand-total questions are answered from
   *     the current workbook's real parser output. Component questions come
   *     first because "SA1 aur SA2 ka total…" mentions both a component and a
   *     total, and the component context is the more specific one.
   */
  if (context) {
    const explainLang = studioReplyLanguage(raw);
    if (isExaminationQuery(text)) {
      return { reply: explainExaminations(context, raw, explainLang), chips: guide.chips };
    }
    if (isMaxMarksQuery(text)) {
      return { reply: explainMaximumMarks(context, explainLang), chips: guide.chips };
    }
    if (isGrandTotalQuery(text)) {
      return { reply: explainGrandTotal(context, explainLang), chips: guide.chips };
    }
  }

  // 1) A specific question (free tries, price, excel format, …).
  for (let index = 0; index < FAQ.length; index += 1) {
    if (
      anyMatch(text, FAQ_REGEXES[index]) ||
      fuzzyKeywordMatch(tokens, FAQ[index].keywords) !== null
    ) {
      return { reply: pick(FAQ[index].reply, lang), chips: guide.chips };
    }
  }

  // 2) "How do I use this?" → the step-by-step walkthrough for this screen.
  if (bankHit(text, tokens, GUIDE_RE, GUIDE_WORDS)) {
    return {
      reply: `${pick(guide.intro, lang)}\n\n${pick(
        { en: `Step 1 of ${guide.steps.length}:`, hi: `Step 1 of ${guide.steps.length}:` },
        lang,
      )} ${pick(guide.steps[0].title, lang)}`,
      guide: { steps: guide.steps, index: 0 },
      chips: guide.chips,
    };
  }

  return null;
};

/**
 * The reply Joy gives when nothing matched.
 *
 * She is Ishmaverse's assistant, not a Studio-only bot, so the redirect names
 * every section she can actually answer about — and says plainly that she will
 * not guess. The Studio walkthrough is still offered for the screen at hand.
 */
export const studioFallback = (routeKey: StudioScreen, lang: JoyLang): string =>
  pick(
    {
      en: `I don’t have that one, and I won’t guess. I can help with ReportCard Studio — this screen, the 4-step workflow, free tries, pricing and billing — and with the rest of Ishmaverse: ${MALL_KNOWLEDGE.map(
        (section) => section.name,
      ).join(', ')}. Name a section, or the problem you are stuck on. ${pick(
        SCREEN_GUIDES[routeKey].intro,
        'en',
      )}`,
      hi: `Ye mujhe nahi pata, aur main guess nahi karungi. Main ReportCard Studio me madad kar sakti hoon — ye screen, 4-step workflow, free tries, pricing aur billing — aur poori Ishmaverse me: ${MALL_KNOWLEDGE.map(
        (section) => section.name,
      ).join(', ')}. Kisi section ka naam bolo, ya woh problem jisme aap atke ho. ${pick(
        SCREEN_GUIDES[routeKey].intro,
        'hi',
      )}`,
    },
    lang,
  );

export const studioWelcome = (lang: JoyLang): string =>
  pick(
    {
      en: "Hi, I'm Joy 👋 I'm right here inside ReportCard Studio. Ask me anything — how to use a screen, which theme fits, how the free tries work, or how billing/receipts happen.",
      hi: 'Namaste, main Joy hoon 👋 Main ReportCard Studio ke andar hi hoon. Kuch bhi poocho — screen kaise use karni hai, kaunsa theme sahi hai, free tries kaise kaam karti hain, ya billing/receipt kaise hoti hai.',
    },
    lang,
  );

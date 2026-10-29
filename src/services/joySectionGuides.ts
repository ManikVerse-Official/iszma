/**
 * Joy's step-by-step guides, per section of the mall.
 *
 * The topics in `joyAssistant.ts` answer "where is it?". This file answers
 * "how do I actually use it?" — the walkthrough Joy runs when someone is
 * standing inside a section and doesn't know what to press next.
 *
 * Language policy matches the rest of Joy: English by default, Hinglish only
 * when the visitor writes in Hinglish, and every line exists in both.
 */

import type { JoyText } from './joyAssistant';
import { TIER_LABELS, TIER_OPTIONS, greetingThemes } from '../data/greetingThemes';
import { mallSections } from '../data/sections';

/** Real tier prices from the catalogue, so the FAQ cannot drift from the data. */
const TIER_PRICE_LINE = TIER_OPTIONS.map((tier) => {
  const theme = greetingThemes.find((entry) => entry.tier === tier && entry.price > 0);
  return `${TIER_LABELS[tier]} ₹${theme?.price ?? 0}`;
}).join(' · ');

/*
 * The mall's own section list, used by the "what is Ishmaverse" answer. It is
 * derived from data/sections.ts here (rather than imported from joyAssistant)
 * so the two modules keep only the one import direction and a new or launched
 * section can never be missing from that answer.
 */
const LIVE_SECTION_LINE = mallSections
  .filter((section) => section.available)
  .map((section) => section.name)
  .join(', ');
const COMING_SOON_LINE = mallSections
  .filter((section) => !section.available)
  .map((section) => section.name)
  .join(', ');

export interface JoyGuideStep {
  title: JoyText;
  detail: JoyText;
}

export interface JoySectionGuide {
  /** Shown when the guide starts. */
  intro: JoyText;
  steps: JoyGuideStep[];
  /** One-tap questions for this section. */
  chips: JoyText[];
}

export const JOY_SECTION_GUIDES: Record<string, JoySectionGuide> = {
  greetings: {
    intro: {
      en: 'Happy to walk you through the Digital Greetings section — card chunna, personalise karna, preview aur payment. Shall we start?',
      hi: 'Digital Greetings section main aapko poora samjha deti hoon — card chunna, personalise karna, preview aur payment. Shuru karein?',
    },
    steps: [
      {
        title: { en: '1. Pick your card', hi: '1. Apna card chuno' },
        detail: {
          en: 'Themes are grouped by occasion — birthday, anniversary, wedding, Diwali, thank-you and more. Har theme par price likha hota hai. Sabse upar ek FREE Welcome Card bhi hai.',
          hi: 'Themes occasion ke hisaab se group hue hain — birthday, anniversary, wedding, Diwali, thank-you waghaira. Har theme par price likha hota hai. Sabse upar ek FREE Welcome Card bhi hai.',
        },
      },
      {
        title: { en: '2. Personalise it', hi: '2. Card personalise karo' },
        detail: {
          en: 'Sender ka naam, receiver ka naam, message, font, colour theme aur background music — sab ek hi screen par set hote hain. Live preview saath-saath update hota rehta hai.',
          hi: 'Sender ka naam, receiver ka naam, message, font, colour theme aur background music — sab ek hi screen par set hote hain. Live preview saath-saath update hota rehta hai.',
        },
      },
      {
        title: { en: '3. Preview before paying', hi: '3. Pay karne se pehle preview dekho' },
        detail: {
          en: 'Preview par tap karo — jaisa dikhega, waisa hi receiver ko milega. Pasand na aaye to bina pay kiye back jaake badal sakte ho.',
          hi: 'Preview par tap karo — jaisa dikhega, waisa hi receiver ko milega. Pasand na aaye to bina pay kiye back jaake badal sakte ho.',
        },
      },
      {
        title: { en: '4. Pay (or use the free card)', hi: '4. Pay karo (ya free card use karo)' },
        detail: {
          en: 'Inside India you pay through Razorpay (UPI, cards, netbanking, wallets); outside India through Paypal or Stripe — payment happens on a secure gateway and we never store your card details. The FREE Welcome Card needs no payment at all: it is genuinely free and you can send it again and again (a small fair-use free allowance applies per email and per network). Font choice, custom text/background colours and background music come with the paid themes only.',
          hi: 'India me Razorpay (UPI, cards, netbanking, wallets) aur bahar Paypal ya Stripe — payment safe gateway par hoti hai, card details hum store nahi karte. FREE Welcome Card ke liye payment ki zaroorat hi nahi: ye bilkul free hai aur aap ise baar baar bhej sakte ho (per email aur per network ek chhoti fair-use limit lagti hai). Font choice, custom text/background colours aur background music sirf paid themes me milta hai.',
        },
      },
      {
        title: { en: '5. Share the link', hi: '5. Link share karo' },
        detail: {
          en: 'Card ban jaane par ek share link milta hai. Card 48 ghante live rehta hai, aur bill + receipt aapke email par chala jaata hai — usi email par manage/delete link bhi hota hai.',
          hi: 'Card ban jaane par ek share link milta hai. Card 48 ghante live rehta hai, aur bill + receipt aapke email par chala jaata hai — usi email par manage/delete link bhi hota hai.',
        },
      },
    ],
    chips: [
      { en: 'How do I use this section?', hi: 'Ye section kaise use karein?' },
      { en: 'Which card is free?', hi: 'Kaunsa card free hai?' },
      { en: 'What does a paid card give?', hi: 'Paid card me kya milta hai?' },
    ],
  },

  'reportcard-studio': {
    intro: {
      en: "Let's walk through ReportCard Studio — Excel daalne se lekar print-ready PDF nikalne tak, plus login aur plans. Ready?",
      hi: 'Chalo ReportCard Studio samjhein — Excel daalne se lekar print-ready PDF nikalne tak, aur login aur plans bhi. Ready?',
    },
    steps: [
      {
        title: { en: '1. Sign in (name + email)', hi: '1. Sign in karo (naam + email)' },
        detail: {
          en: 'No password, no OTP — just your name and the email where you want the bill. Your account carries 7 free generations; sign in is required so they can be counted to you.',
          hi: 'Na password, na OTP — bas naam aur woh email jahan bill chahiye. Account par 7 free generations milti hain; sign in isliye zaroori hai taaki wo aapke naam count ho.',
        },
      },
      {
        title: { en: '2. Set up the School Profile', hi: '2. School Profile set karo' },
        detail: {
          en: 'School name, address, academic session, exam term, logo and signatures. Ek hi baar bharna hota hai, phir har card me apne aap aata hai.',
          hi: 'School ka naam, address, academic session, exam term, logo aur signatures. Ek hi baar bharna hota hai, phir har card me apne aap aata hai.',
        },
      },
      {
        title: { en: '3. Import the Excel sheet', hi: '3. Excel sheet import karo' },
        detail: {
          en: 'Upload the .xlsx / .csv mark sheet. Keep one heading row (Roll, Name, Class) and give every subject its own column — grouped sheets work too: a subject row with PT / NB / SEA / SA1 / TOTAL underneath is matched automatically, each column keeps its own position (a subject name is never split in two) and the subject’s own TOTAL is not confused with the sheet’s grand total. Any wrong guess can be fixed from a dropdown.',
          hi: 'Apni .xlsx / .csv mark sheet upload karo. Ek heading row (Roll, Name, Class) aur har subject ka apna column rakho — grouped sheet bhi chalti hai: subject row ke neeche PT / NB / SEA / SA1 / TOTAL ho to sab automatically map ho jaata hai, har column apni jagah par rehta hai (subject ka naam do hisson me kabhi nahi tootta) aur subject ka TOTAL sheet ke grand total se mix nahi hota. Galat lage to dropdown se badal do.',
        },
      },
      {
        title: { en: '4. Check the preview', hi: '4. Preview check karo' },
        detail: {
          en: 'Report Template is the preview room — every student\'s card is shown there, with totals on the left and a theme selector. On a phone the A4 card is scaled down to fit your screen, so scroll down on that screen and the card appears just below the “Step … of 7” bar. The preview is exactly what the PDF prints.',
          hi: 'Report Template hi preview room hai — wahan har student ka card dikhta hai, left me totals aur upar theme selector. Phone par A4 card screen ke hisaab se chhota (scaled) ho jaata hai, isliye us screen par thoda neeche scroll karo — card “Step … of 7” bar ke thik neeche dikh jaayega. Preview bilkul wahi hota hai jo PDF me print hota hai.',
        },
      },
      {
        title: { en: '5. Generate & download the ZIP', hi: '5. Generate karke ZIP download karo' },
        detail: {
          en: 'Generate Reports par ek click = har student ka PDF + ek ZIP. Ek generation run ek free try kha jaata hai. Fail hue students ki list CSV me export kar sakte ho.',
          hi: 'Generate Reports par ek click = har student ka PDF + ek ZIP. Ek generation run ek free try kha jaata hai. Fail hue students ki list CSV me export kar sakte ho.',
        },
      },
      {
        title: { en: '6. Need unlimited? Subscribe', hi: '6. Unlimited chahiye? Subscribe karo' },
        detail: {
          en: 'Plans: Simple Academic ₹369, Modern School ₹578, Holistic Progress ₹859 — teeno 6 months, unlimited. Activate hone par bill + receipt email par aa jaata hai.',
          hi: 'Plans: Simple Academic ₹369, Modern School ₹578, Holistic Progress ₹859 — teeno 6 months, unlimited. Activate hone par bill + receipt email par aa jaata hai.',
        },
      },
    ],
    chips: [
      { en: 'How do I use ReportCard Studio?', hi: 'ReportCard Studio kaise use karein?' },
      { en: 'Which Excel columns do I need?', hi: 'Excel me kaunse columns chahiye?' },
      { en: 'How many free tries?', hi: 'Kitni free tries milti hain?' },
      { en: 'Which plan should I take?', hi: 'Kaunsa plan lun?' },
    ],
  },
  'game-zone': {
    intro: {
      en: 'Happy to explain Pair-3Balls — the board, the two phases, the timer and how you win. Just ask.',
      hi: 'Pair-3Balls samjha deti hoon — board, dono phases, timer aur jeetne ka rule. Aap bas poochho.',
    },
    steps: [
      {
        title: { en: '1. Pick a mode', hi: '1. Mode chuno' },
        detail: {
          en: 'Game Zone has four modes. Play vs Computer lets you choose Easy, Medium or Hard. Two Players — One Device is pass and play with a friend on this screen. Private Room gives you a room code and an invite link to send a friend, who can join from their own device and location. World Match pairs you with a real player who is searching right now. All four use the same rules and the same board.',
          hi: 'Game Zone me chaar modes hain. Play vs Computer me aap Easy, Medium ya Hard chunte ho. Two Players — One Device me dost ke saath isi screen par pass-and-play hota hai. Private Room me room code aur invite link milta hai — dost apne device aur apni location se join kar sakta hai. World Match aapko us waqt search kar rahe asli player se match kar deta hai. Chaaron me rules aur board same hain.',
        },
      },
      {
        title: { en: '2. The board', hi: '2. Board' },
        detail: {
          en: 'The board has nine points — four corners, four side midpoints and one centre — joined by straight lines. There are eight valid lines of three: three across, three down and two diagonals through the centre.',
          hi: 'Board me nau points hain — chaar corner, chaar side midpoint aur ek centre — sab seedhi lines se jude. Total aath valid lines hain: teen horizontal, teen vertical aur do diagonal jo centre se jaati hain.',
        },
      },
      {
        title: { en: '3. Placement phase', hi: '3. Placement phase' },
        detail: {
          en: 'White and Black take turns placing their three pieces on empty points. White starts, so six pieces in total get placed.',
          hi: 'White aur Black khaali points par apne teen pieces ek-ek karke rakhte hain. White pehle khelta hai, isliye total chhe pieces rakhe jaate hain.',
        },
      },
      {
        title: { en: '4. Movement phase', hi: '4. Movement phase' },
        detail: {
          en: 'When all six pieces are placed, players take turns stepping one of their OWN pieces to an empty point joined to it by a line. Pieces are never captured or removed.',
          hi: 'Jab saare chhe pieces rakh diye jaate hain, tab players apna hi piece utha kar usse line se jude khaali point par step karte hain. Pieces kabhi capture ya remove nahi hote.',
        },
      },
      {
        title: { en: '5. Winning and the timer', hi: '5. Jeet aur timer' },
        detail: {
          en: 'Line up three of your own pieces on any drawn line to win. Each turn has a 60-second timer, and the player whose timer runs out loses. Pieces are never captured. A game can also end as a draw: the same move (same piece, same point, same side) may be played three times, and playing it once more ends the game as a draw — against the computer or another player.',
          hi: 'Apne teen pieces kisi bhi drawn line par ek saath laane wala jeet jaata hai. Har turn par 60 second ka timer hota hai, aur jiska timer khatam ho jaaye woh haar jaata hai. Pieces capture nahi hote. Game draw bhi ho sakta hai: wahi move (same piece, same point, same side) teen baar khela ja sakta hai, aur chauthi baar dohraane par game draw ho jaata hai — computer ke saath bhi aur doosre player ke saath bhi.',
        },
      },
    ],
    chips: [
      { en: 'How do I play Pair-3Balls?', hi: 'Pair-3Balls kaise khelte hain?' },
      { en: 'How does the movement phase work?', hi: 'Movement phase kaise chalti hai?' },
      { en: 'How do I win?', hi: 'Jeet kaise hoti hai?' },
      { en: 'How long is the turn timer?', hi: 'Turn timer kitne seconds ka hai?' },
    ],
  },
};

export const getSectionGuide = (sectionId?: string): JoySectionGuide | null =>
  (sectionId && JOY_SECTION_GUIDES[sectionId]) || null;

/* ------------------------------------------------------------------ */
/* Questions & answers                                                */
/* ------------------------------------------------------------------ */

export interface JoyFaqEntry {
  keywords: string[];
  reply: JoyText;
}

export const JOY_FAQ: JoyFaqEntry[] = [
  /*
   * Pair-3Balls comes first so a rules question is answered before any broader
   * keyword can claim it. These entries only ever state the official rules —
   * the no-strategy boundary lives in `isGameStrategyQuery` in joyAssistant.ts,
   * which is checked before any FAQ can be reached.
   */
  {
    keywords: [
      'pair 3 balls', 'pair3balls', 'pair-3balls', 'pair 3balls', 'three balls game',
      'teen balls', 'nine point board', '9 point board', 'how do i play pair',
      'how to play pair', 'pair 3 balls rules', 'pair3balls rules', 'pair 3 balls kaise',
      'pair3balls kaise', 'pair 3 balls khelte', 'game zone', 'pair 3 ball khelte',
      'who starts first', 'who starts', 'who goes first', 'first move', 'who plays first',
      'kaun pehle', 'pehla turn', 'pehle kaun khelta',
    ],
    reply: {
      en: 'Pair-3Balls 🎮 — the board has NINE points: four corners, four side midpoints and one centre, joined by straight lines (eight lines of three: across, down and two diagonals through the centre). Each player has three pieces. First you PLACE them, one per turn, on empty points (White starts). When all six are placed you MOVE, taking turns to step one of your own pieces to an empty point joined to it by a line. Pieces are never captured. The first player to line up three of their own pieces on a drawn line wins, and each turn has a 60-second timer — run out and you lose. A game is drawn if the same move (same piece, same point, same side) is repeated more than three times.',
      hi: 'Pair-3Balls 🎮 — board me NAU points hain: chaar corner, chaar side midpoint aur ek centre, sab seedhi lines se jude (kul aath lines: horizontal, vertical aur centre se jaati do diagonal). Har player ke paas teen pieces hote hain. Pehle aap inhe PLACE karte ho — ek-ek karke khaali point par (White pehle). Chhe pieces rakhne ke baad MOVE hota hai: apna piece utha kar usse line se jude khaali point par step karte ho. Pieces kabhi capture nahi hote. Jo pehle apne teen pieces kisi drawn line par ek saath laata hai woh jeet jaata hai, aur har turn par 60 second ka timer hota hai — khatam hone par aap haar jaate ho. Agar wahi move (same piece, same point, same side) teen baar se zyada dohraya jaaye to game draw ho jaata hai.',
    },
  },
  {
    keywords: [
      'timer kitne', 'timer ka', 'game timer', 'turn timer', 'timer', 'kitne second',
      'how many seconds', 'time limit', 'kitna time milta', 'timer kitne seconds',
    ],
    reply: {
      en: '⏱️ In Pair-3Balls every turn has a 60-second timer. If your 60 seconds run out, you lose the game — the clock starts again for the other player after every move, and it is checked on the server, not in your browser.',
      hi: '⏱️ Pair-3Balls me har turn par 60 second ka timer hota hai. Aapke 60 second khatam ho gaye to aap game haar jaate ho — har move ke baad doosre player ke liye clock dobara shuru hota hai, aur ye server par check hota hai, browser me nahi.',
    },
  },
  {
    keywords: [
      'how do i win', 'how to win the game', 'how do you win', 'win condition',
      'three in a row', 'three in line', 'teen line', 'line mein kaise', 'pehle kaun jeetta',
      'jeet kaise hoti', 'jeetne ka rule', 'how do i get three', 'what makes you win',
    ],
    reply: {
      en: '🏆 You win Pair-3Balls by lining up three of your own pieces on one of the eight drawn lines — the three horizontals, the three verticals, or the two diagonals through the centre. You can complete a line during the placement phase or the movement phase; the game stops the moment a line forms. Pieces are never captured. The other endings are the 60-second turn timer (run out and you lose) and a repetition draw — the same move repeated more than three times.',
      hi: '🏆 Pair-3Balls aap aath drawn lines me se kisi ek par apne teen pieces ek saath laa kar jeette ho — teen horizontal, teen vertical, ya centre se jaati do diagonals. Line placement phase me bhi ban sakti hai aur movement phase me bhi; line bante hi game ruk jaata hai. Capture nahi hota. Baaki endings hain 60-second turn timer (khatam hone par haar) aur repetition draw — wahi move teen baar se zyada dohrane par.',
    },
  },
  {
    keywords: [
      'how do i move', 'how does movement work', 'movement phase', 'move a piece',
      'piece kaise move', 'kaise move karte', 'chaal kaise chalti', 'which piece can i move',
      'adjacent', 'connected point',
    ],
    reply: {
      en: '➡️ After all six pieces are placed, on your turn you pick ONE of your own pieces and step it to an EMPTY point that is joined to it by a line — you cannot jump, capture, or land on an occupied point. A piece on a corner can reach its two side midpoints and the centre; the centre can reach all eight outer points. If you have no legal step, you cannot move.',
      hi: '➡️ Chhe pieces rakhne ke baad, apne turn par aap apna EK piece utha kar usi se seedhi line se jude KHAALI point par step karte ho — jump nahi kar sakte, capture nahi, aur bhari hui point par nahi utar sakte. Corner wala piece apne do side midpoints aur centre tak ja sakta hai; centre se sab aath outer points tak. Agar koi legal step nahi hai to aap move nahi kar sakte.',
    },
  },
  {
    keywords: [
      'world match', 'private room', 'room code', 'invite link', 'play with a friend',
      'play with friend', 'friend ke saath', 'random player', 'matchmaking', 'join a room',
      'room kaise', 'online khel', 'dost ke saath khel', 'online opponent', 'opponent se khel',
      'online match', 'real player', 'asli player', 'world match kaise', 'online khelna',
      'kisi ke saath khel', 'dusre player',
    ],
    reply: {
      en: '🎮 Game Zone has four modes. Play vs Computer: choose Easy, Medium or Hard and play on this device. Two Players — One Device: pass the screen back and forth with a friend. Private Room: create a room to get a 6-character code and an invite link — send either to a friend anywhere, and whoever joins plays you from their own device in that same room. World Match: you join a queue and get paired with a real player who is searching at that moment. All four use the same board, the same rules and the same 60-second turn timer — and repeating the same move more than three times ends the game as a draw.',
      hi: '🎮 Game Zone me chaar modes hain. Play vs Computer: Easy, Medium ya Hard chuno aur isi device par khelo. Two Players — One Device: dost ke saath screen pass karke khelo. Private Room: room banao, 6-character code aur invite link milega — dost ko kahin bhi bhej do, woh apne device se usi room me aapse khelega. World Match: aap queue me jaate ho aur us waqt search kar rahe asli player se match ho jaate ho. Chaaron me board, rules aur 60-second turn timer same hain — aur wahi move teen baar se zyada dohrane par game draw ho jaata hai.',
    },
  },
  {
    keywords: ['free card', 'free greeting', 'free', 'muft', 'free me', 'free mein', 'no cost'],
    reply: {
      en: 'The FREE Welcome Card 🎁 is pinned at the very top of “Digital Greetings” and costs nothing — no payment, no card details, ever. You can send it again and again; the only fair-use cap is a small free allowance per email (and per network), and its share link stays live for 48 hours.',
      hi: 'FREE Welcome Card 🎁 “Digital Greetings” me sabse upar hai aur bilkul free hai — na payment, na card details. Aap ise baar baar bhej sakte ho; bas ek chhoti fair-use limit per email (aur per network) lagti hai, aur share link 48 ghante live rehta hai.',
    },
  },
  {
    keywords: [
      'free vs paid', 'free or paid', 'difference free', 'paid card', 'paid greeting', 'why pay',
      'free mein difference', 'paid me kya', 'free aur paid', 'kaunsa paid', 'what does paid give',
    ],
    reply: {
      en: `Free vs paid 💌 — the FREE Welcome Card is one fixed design and keeps your names, message and photo. Paid themes (current catalogue: ${TIER_PRICE_LINE}; the USD price shows outside India) add the full theme library (birthday, wedding, Diwali, farewell…), a bigger font choice, custom text & background colours, and — on Premium and Elite — background music or your own MP3. Everything stays live for 48 hours either way.`,
      hi: `Free vs paid 💌 — FREE Welcome Card ka ek hi fixed design hai, jisme aapke naam, message aur photo lagte hain. Paid themes (current catalogue: ${TIER_PRICE_LINE}; India ke bahar USD price dikhta hai) me poori theme library (birthday, wedding, Diwali, farewell…), zyada font options, custom text aur background colours, aur Premium/Elite me background music ya aapka khud ka MP3 milta hai. Dono hi 48 ghante live rehte hain.`,
    },
  },
  {
    keywords: [
      'how do i send', 'how to send', 'send the card', 'share the card', 'share link', 'send to',
      'card kaise bheje', 'card kaise bhej', 'link share', 'link kaise', 'bhejna hai', 'kaise bheju',
    ],
    reply: {
      en: 'Sending a card 📤 — create it, and right after payment (or instantly for the free card) you get a share link. Open WhatsApp, email or any chat, paste that link, and whoever opens it sees the animated card. No app or login is needed to view it.',
      hi: 'Card bhejna 📤 — card banane ke baad (paid card me payment ke turant baad, free card me turant) aapko ek share link milta hai. WhatsApp, email ya kisi bhi chat me woh link paste kar do — jisne bhi khola, usse animated card dikh jayega. dekhne ke liye koi app ya login nahi chahiye.',
    },
  },
  {
    keywords: [
      'cannot find my card', 'lost link', 'link lost', 'link kho', 'card kaha gaya', 'manage link',
      'delete card', 'card delete', 'remove card', 'card hata', 'edit card', 'edit my card',
      'edit a card', 'change a card', 'card change', 'card edit', 'card link not opening',
      'link is not opening', 'link not working',
      'card not opening', 'link nahi khul', 'card nahi khul', 'link kaam nahi',
    ],
    reply: {
      en: 'Managing a card 🔗 — the bill email you receive contains a private manage link plus the card’s share link. The manage link opens the card and can delete it permanently (deleting cannot be undone); to send the card again, re-share the share link itself. A card cannot be edited after it is created — its design, names, message and photo are fixed, so make a new card for a change. If the link will not open, the 48 hours are usually over or the card was deleted; if the email is lost, tell me the email address you used and the payment id and I’ll pass it to the team.',
      hi: 'Card manage karna 🔗 — aapko milne wala bill email ek private manage link aur card ka share link dono deta hai. Manage link se card khulta hai aur use permanently delete kar sakte ho (delete undo nahi hota); dobara bhejna ho to share link hi re-share karo. Card ban jaane ke baad edit nahi hota — design, naam, message aur photo fix ho jaate hain, isliye badlaav ke liye naya card banao. Link na khule to aksar 48 ghante poore ho gaye hote hain ya card delete ho gaya hota hai; email kho gaya ho to mujhe email address aur payment id bata do, main team ko de dungi.',
    },
  },
  {
    keywords: [
      'tier', 'tiers', 'basic premium elite', 'premium', 'elite', 'music', 'song', 'audio', 'mp3',
      'background music', 'gaana', 'music kaise', 'font', 'fonts', 'colour', 'color', 'colors', 'colours',
      'text colour', 'customise', 'customize', 'design change',
    ],
    reply: {
      en: `Card tiers ✨ — there are four: ${TIER_PRICE_LINE} (current catalogue prices, INR). Basic is clean and simple. Plus adds richer motion. Premium adds ornaments and stock background music. Elite adds the deepest gradients and lets you upload your own song (.mp3). Fonts, text colours and background colours are adjustable on the paid themes; the free Welcome Card keeps its designed look.`,
      hi: `Card tiers ✨ — chaar hain: ${TIER_PRICE_LINE} (catalogue ke current INR prices). Basic simple aur clean hai. Plus me richer motion milta hai. Premium me ornaments aur stock background music. Elite me sabse gehre gradients aur aap apna gaana (.mp3) upload kar sakte ho. Font, text colours aur background colours paid themes par adjust hote hain; free Welcome Card apne design me hi rehta hai.`,
    },
  },
  {
    keywords: [
      'failed payment', 'payment failed', 'did not get card', 'card nahi mila', 'money deducted',
      'paisa kat gaya', 'double charged', 'charged twice', 'refund', 'money back', 'paise wapas',
      'cancel my order', 'order cancel',
    ],
    reply: {
      en: 'If a payment failed or was charged twice, don’t pay again — the server is idempotent on the payment id, so retrying the same order returns the original card instead of charging again. Send the payment id (it starts with “pay_” or “FREE-”) and the email you used to the team and a refund or a re-issue is sorted out.',
      hi: 'Payment fail ho gaya ya do baar kata, to dobara pay mat karo — server payment id par idempotent hai, isliye wahi order retry karne par naya charge nahi hota, wahi card wapas milta hai. Team ko payment id (“pay_” ya “FREE-” se shuru) aur apna email bhej do — refund ya re-issue ho jaata hai.',
    },
  },
  {
    keywords: [
      'contact', 'support', 'help me', 'talk to someone', 'human', 'email the team', 'customer care',
      'complaint', 'shikayat', 'team se baat', 'phone', 'whatsapp number',
    ],
    reply: {
      en: 'Support 📮 — I can answer most questions right here (cards, prices, ReportCard Studio, billing). For anything I can’t fix — a failed payment, a wrong bill, a refund — say the word and I’ll pass your details to the team; you can also reply to the bill email you received, which reaches the same inbox.',
      hi: 'Support 📮 — yahin par main zyada tar sawaalon ka jawab de deti hoon (cards, price, ReportCard Studio, billing). Jo main theek na kar sakun — fail payment, galat bill, refund — uske liye bolo, main aapki details team ko de dungi; aap bill email par reply bhi kar sakte ho, wahi inbox tak pahunchta hai.',
    },
  },
  {
    keywords: [
      'photo', 'upload photo', 'picture', 'image', 'imgbb', 'photo size', 'photo kaise', 'tasveer',
      'face cut', 'crop',
    ],
    reply: {
      en: 'Photos 🖼️ — upload the photo while creating the card; it is cropped to the card’s frame so faces are never cut off, and it auto-deletes from hosting after 48 hours (same as the card). Keep it under a few MB, and JPEG/PNG both work.',
      hi: 'Photo 🖼️ — card banate waqt photo upload karo; ye card ke frame me crop hoti hai taaki chehra na kate, aur hosting se 48 ghante baad apne aap delete ho jaati hai (card ki tarah). Size kuch MB se kam rakho, JPEG aur PNG dono chal jaati hain.',
    },
  },
  {
    keywords: [
      'currency', 'usd', 'dollar', 'inr', 'rupees', 'international', 'worldwide', 'outside india',
      'language', 'hindi', 'english', 'bhasha',
    ],
    reply: {
      en: `Prices are shown in ₹ (INR) inside India and in $ (USD) elsewhere, using your region — the USD price is the dollar amount listed on the same item, so nothing is re-converted at checkout. Greeting card tiers are ${TIER_PRICE_LINE}; ReportCard Studio plans are ₹369 / ₹578 / ₹859 ($4.99 / $6.99 / $10.99) for six months. I can talk to you in English or Hinglish — just write in whichever you prefer.`,
      hi: `Price India me ₹ (INR) me aur bahar $ (USD) me dikhte hain, aapke region ke hisaab se — USD price usi item par likha dollar amount hota hai, checkout par koi re-conversion nahi hota. Greeting card tiers ${TIER_PRICE_LINE} hain; ReportCard Studio plans ₹369 / ₹578 / ₹859 ($4.99 / $6.99 / $10.99) me 6 mahine ke liye. Main English ya Hinglish dono me baat kar sakti hoon — aap jis bhasha me likho, wahi use karungi.`,
    },
  },
  {
    keywords: [
      'how many free tries', 'free generations', 'free uses', 'kitni free', 'free kitni', '7 free',
      'seven free', 'free limit', 'kitne free', 'free kitne',
    ],
    reply: {
      en: 'ReportCard Studio gives every account 7 free report generations — one generation run counts as one use, no matter how many students are inside it. After that, a plan (₹369 / ₹578 / ₹859 for six months) unlocks unlimited generations. The free card greetings have their own separate allowance.',
      hi: 'ReportCard Studio me har account ko 7 free generations milti hain — ek generation run ek use count hota hai, chahe usme kitne bhi students hon. Uske baad plan (₹369 / ₹578 / ₹859, 6 mahine) unlimited generations deta hai. Free greeting card ki limit alag hai.',
    },
  },
  {
    keywords: [
      'excel format', 'which columns', 'columns needed', 'sheet format', 'excel kaise', 'header',
      'subject columns', 'marks sheet format', 'csv',
    ],
    reply: {
      en: 'Excel format 📊 — keep one heading row for Roll No, Student Name and the identity fields, then give each subject its own column. Grouped mark sheets work too: a subject row with PT / NB / SEA / SA1 / TOTAL underneath is matched automatically, and every column keeps its own position, so maths is never split into two columns. You can fix any guess from the dropdowns before generating.',
      hi: 'Excel format 📊 — Roll No, Student Name aur baaki identity fields ke liye ek heading row rakho, phir har subject ka apna column. Grouped mark sheet bhi chalti hai: subject row ke neeche PT / NB / SEA / SA1 / TOTAL ho to sab automatically map ho jaata hai, aur har column apni jagah par rehta hai — maths do columns me kabhi nahi tootta. Generate karne se pehle galat mapping dropdown se theek kar sakte ho.',
    },
  },
  {
    keywords: [
      'zip', 'download report', 'download pdf', 'failed students', 'generated file', 'report kaha milega',
      'result kaha', 'report download', 'pdf download',
    ],
    reply: {
      en: 'Generated reports 📦 — “Generate Reports” builds one PDF per student and hands you a single ZIP with all of them. If a few students fail (usually a missing name), the list can be exported as CSV so you can fix the sheet and re-run only those. Your remaining free generations are shown on the dashboard.',
      hi: 'Generated reports 📦 — “Generate Reports” par har student ka ek PDF banta hai aur sab ek single ZIP me milte hain. Agar kuch students fail ho jaayein (aksar naam missing hone par), to list CSV me export kar sakte ho — sheet theek karke sirf unhe dobara chala do. Bachi hui free generations dashboard par dikhti hain.',
    },
  },
  {
    keywords: [
      'how long is', 'how long do', 'how long does', 'how long will', 'stay live', 'stays live',
      'kitne din', 'kitni der', 'kitne ghante', '48', 'card live', 'validity', 'expire card',
      'card expire', 'kab tak', 'live rehta', 'live rehta hai',
    ],
    reply: {
      en: 'Every card — free or paid — stays live for 48 hours from the moment it is created, and you can share that one link as many times as you like in those 48 hours. After that the link stops opening; making a fresh card gives you a fresh 48 hours.',
      hi: 'Har card — free ya paid — banane ke waqt se 48 ghante live rehta hai, aur us ek link ko aap 48 ghante me jitni baar chaaho share kar sakte ho. Uske baad link khulna band ho jaata hai; naya card banane par nayi 48 ghante milti hain.',
    },
  },
  {
    keywords: ['payment', 'pay', 'upi', 'razorpay', 'paypal', 'stripe', 'card payment', 'netbanking', 'paise kaise'],
    reply: {
      en: 'India me Razorpay se pay karo (UPI, PhonePe, GPay, cards, netbanking, wallets). Bahar se Paypal ya Stripe. Payment safe gateway par hoti hai — card details hum store nahi karte.',
      hi: 'India me Razorpay se pay karo (UPI, PhonePe, GPay, cards, netbanking, wallets). Bahar se Paypal ya Stripe. Payment safe gateway par hoti hai — card details hum store nahi karte.',
    },
  },
  {
    keywords: ['receipt', 'bill', 'invoice', 'email aayega', 'receipt milegi', 'bill kaha'],
    reply: {
      en: 'Har order par professional bill + receipt email par jaata hai — logo ke saath aur Cost column me actual amount. Free product par cost ₹0.00 dikhta hai; bill hamesha generate hoti hai.',
      hi: 'Har order par professional bill + receipt email par jaata hai — logo ke saath aur Cost column me actual amount. Free product par cost ₹0.00 dikhta hai; bill hamesha banti hai.',
    },
  },
  {
    keywords: ['account', 'sign in', 'signin', 'login', 'register', 'password', 'otp'],
    reply: {
      en: 'Sign in bas naam + email se hota hai — na password, na OTP. Account se hi aapki free tries, plan aur receipts aapse judte hain. ReportCard Studio me generate karne se pehle sign in maanga jaata hai.',
      hi: 'Sign in bas naam + email se hota hai — na password, na OTP. Account se hi aapke free tries, plan aur receipts aapse judte hain. ReportCard Studio me generate karne se pehle sign in maanga jaata hai.',
    },
  },
  {
    keywords: [
      'plan', 'plans', 'subscription', 'unlimited', 'reportcard plan', 'reportcard plans',
      'report card plan', 'report card plans', 'studio plan', 'studio plans', 'reportcard pricing',
    ],
    reply: {
      en: 'ReportCard Studio plans: Simple Academic ₹369 ($4.99), Modern School ₹578 ($6.99), Holistic Progress ₹859 ($10.99) — all three for 6 months with unlimited report cards, billed in ₹ inside India and in $ outside. The first 7 generations are free on every account, and a bill + receipt email arrives as soon as a plan is activated.',
      hi: 'ReportCard Studio plans: Simple Academic ₹369 ($4.99), Modern School ₹578 ($6.99), Holistic Progress ₹859 ($10.99) — teeno 6 months ke liye unlimited report cards ke saath, India me ₹ me aur bahar $ me bill hote hain. Har account par pehli 7 generations free hain, aur plan activate hote hi bill + receipt email aa jaati hai.',
    },
  },
  {
    keywords: ['renew', 'expire', 'expiry', 'expired', 'reminder', 'cancel'],
    reply: {
      en: 'Plan khatam hone se 7 din pehle renewal reminder email aata hai. Renew na karo to expiry par plan apne aap off ho jaata hai — aur bache hue free generations phir bhi use kar sakte ho.',
      hi: 'Plan khatam hone se 7 din pehle renewal reminder email aata hai. Renew na karo to expiry par plan apne aap off ho jaata hai — aur bache hue free generations phir bhi use kar sakte ho.',
    },
  },
  {
    keywords: [
      'preview', 'preview kaha', 'preview kahan', 'card preview', 'preview dikhao', 'report preview',
      'sample card', 'card kaise dikhega', 'preview mobile', 'mobile preview', 'phone preview',
      'preview not showing', 'preview nahi', 'report kaisa dikhega',
    ],
    reply: {
      en: 'You can see every student’s card in ReportCard Studio → “Report Template” — that is the preview room. On a phone the full A4 card is scaled down to fit the screen, so just scroll down on that screen and the card shows up right under the “Step … of 7” bar (with ‹ › to move between students and a theme selector on top). What you see there is exactly what the PDF will print.',
      hi: 'Har student ka card ReportCard Studio ke “Report Template” me dikhta hai — wahi preview room hai. Phone par poora A4 card screen ke hisaab se chhota (scaled) ho jaata hai, isliye us screen par neeche scroll karo — card “Step … of 7” bar ke thik neeche dikh jaayega (students badalne ke liye ‹ › aur upar theme selector). Jo wahan dikhta hai, bilkul wahi PDF me print hota hai.',
    },
  },
  {
    keywords: [
      'order history', 'my orders', 'purchase history', 'past orders', 'order list',
      'orders kaha', 'order kaha dekhu', 'order track', 'track my order', 'mera order',
      'receipt kaha', 'invoice kaha', 'previous order',
    ],
    reply: {
      en: 'Order history 📧 — there is no separate “my orders” page on the site. Every paid order gets a bill + receipt email that also carries the private manage link: open it to see the card, or delete it for good (deleting cannot be undone). Search your inbox for “isZma” (older receipts say “Ishmaverse”; check Spam/Promotions too). If the email is lost, tell me the email address you used and the payment id (it starts with “pay_” or “FREE-”), and I’ll pass it to the team to look up.',
      hi: 'Order history 📧 — site par alag “my orders” page nahi hai. Har paid order ki bill + receipt email aati hai, jisme private manage link bhi hota hai: usse card dekh sakte ho, ya permanently delete kar sakte ho (delete undo nahi hota). Apne inbox me “isZma” search karo (purani receipts me “Ishmaverse” likha hoga; Spam/Promotions bhi dekh lo). Email kho gaya ho to mujhe woh email address aur payment id (“pay_” ya “FREE-” se shuru) bata do — main team ko lookup ke liye de dungi.',
    },
  },
  {
    keywords: [
      'coupon', 'coupon code', 'promo', 'promo code', 'discount', 'discount code', 'offer',
      'offers', 'sale', 'koi offer', 'koi coupon', 'chhoot', 'deal',
    ],
    reply: {
      en: 'There are no coupon codes or seasonal discounts running right now. 🎁 What is always free: the FREE Welcome Card you can send again and again, and the first 7 report generations in ReportCard Studio. Every other price is the live catalogue price — you can see it on the theme tile before paying, and nothing is added at checkout.',
      hi: 'Abhi koi coupon code ya seasonal discount chal nahi raha. 🎁 Jo hamesha free hai: FREE Welcome Card (baar baar bhej sakte ho) aur ReportCard Studio ki pehli 7 report generations. Baaki har price live catalogue ka price hai — payment se pehle theme tile par dikhta hai, aur checkout par kuch extra nahi judta.',
    },
  },
  {
    keywords: [
      'privacy', 'privacy policy', 'data safe', 'safe hai', 'personal data', 'my data',
      'data delete', 'delete my data', 'terms', 'terms and conditions', 'policy', 'kya data',
      'mera data', 'data kaise store',
    ],
    reply: {
      en: 'Privacy 🔒 — you sign in with just a name and email (no password, no OTP). Payments run on the gateway (Razorpay inside India, PayPal/Stripe outside), so we never see or store your card details. Card photos and audio are hosted only while the card is live and are deleted automatically with it after 48 hours. Your email is used for receipts, card links and plan reminders, nothing else. To have your data removed, tell me the email you used and I’ll pass the request to the team.',
      hi: 'Privacy 🔒 — sign in sirf naam aur email se hota hai (na password, na OTP). Payment gateway par hoti hai (India me Razorpay, bahar PayPal/Stripe), isliye aapke card details hum kabhi dekhte ya store nahi karte. Card ki photo aur audio sirf tab tak host hoti hai jab tak card live hai — 48 ghante baad card ke saath apne aap delete ho jaati hai. Aapka email sirf receipt, card link aur plan reminder ke liye use hota hai, aur kisi aur kaam ke liye nahi. Data hataana ho to mujhe woh email bata do, main request team ko de dungi.',
    },
  },
  /*
   * "What is this place?" — the whole mall in one answer. Both lists are built
   * from data/sections.ts, so a section added or launched later can never be
   * missing from Joy's description of Ishmaverse.
   */
  {
    keywords: [
      'ishmaverse', 'about ishmaverse', 'what is ishmaverse', 'ishmaverse kya',
      'ishmaverse ke baare', 'ishmaverse ke bare', 'ishmaverse about', 'tell me about ishmaverse',
      'iszma', 'about iszma', 'what is iszma', 'iszma kya', 'iszma ke baare',
      'iszma ke bare', 'iszma about', 'tell me about iszma', 'digital mall kya hai',
      'what is this site', 'what is this website', 'what is this place', 'this site kya',
      'ye site kya', 'ye website kya', 'is site par', 'what can i do here', 'what can i buy here',
      'what do you sell', 'what do you have', 'kya bechte', 'kya kya milta', 'yahan kya kya hai',
      'mall me kya', 'mall kya hai', 'digital mall', 'online mall', 'ishmaverse par kya',
      'iszma par kya',
    ],
    reply: {
      en: `isZma is The Digital Mall — one place for digital products instead of one shop. Live right now: ${LIVE_SECTION_LINE} — animated greeting cards that stay live for 48 hours (a FREE Welcome Card plus paid tiers at ${TIER_PRICE_LINE}), print-ready report cards generated from an Excel mark sheet (first 7 generations free, then ₹369 / ₹578 / ₹859 for six months), and Game Zone with Pair-3Balls (vs Computer offline, a Private Room code, or a World Match). Coming soon: ${COMING_SOON_LINE}. Prices show in ₹ inside India and in $ elsewhere; payment runs on Razorpay (UPI, cards, netbanking) inside India and PayPal/Stripe outside, and we never store your card details. Ask me about any section, price or problem and I will answer or take you straight there.`,
      hi: `isZma ek digital mall hai — ek hi jagah par digital products, alag-alag dukaanon me bhatakne ki zaroorat nahi. Abhi live: ${LIVE_SECTION_LINE} — animated greeting cards jo 48 ghante live rehte hain (FREE Welcome Card ke saath, paid tiers ${TIER_PRICE_LINE}), Excel mark sheet se print-ready report cards (pehli 7 generations free, uske baad ₹369 / ₹578 / ₹859 me 6 mahine) aur Game Zone me Pair-3Balls (Computer ke saath offline, Private Room code, ya World Match). Coming soon: ${COMING_SOON_LINE}. Price India me ₹ me aur bahar $ me dikhte hain; payment India me Razorpay (UPI, cards, netbanking) aur bahar PayPal/Stripe se hoti hai, aur aapke card details hum store nahi karte. Kisi bhi section, price ya problem ke baare me poochho — main jawab doongi ya seedha wahan le chalti hoon.`,
    },
  },
  /*
   * Game Zone availability. The online modes genuinely need the backend, and an
   * admin can switch the game off or put it in maintenance, so Joy explains the
   * real behaviour instead of promising a game that will not open.
   */
  {
    keywords: [
      'game not working', 'game is not working', 'game not opening', 'game nahi chal',
      'game nahi khul', 'online game not working', 'online modes not available',
      'online khel nahi', 'online mode band', 'maintenance', 'maintenance mode',
      'game band', 'game band hai', 'game off', 'game down', 'server down',
      'offline game', 'game offline', 'internet nahi', 'no internet', 'without internet',
      'without connection', 'no connection', 'work offline', 'works offline', 'play offline',
      'game work offline', 'game works offline', 'offline khel',
      'online unavailable', 'why is the game not', 'game kyu nahi',
    ],
    reply: {
      en: '🎮 Pair-3Balls has one mode that never needs a connection — “Play vs Computer” runs entirely on your device. Private Room and World Match are online, so they only work when the site’s backend is reachable; if it is not, or if an admin has switched the game off or set maintenance mode, the Game Zone says the online modes are unavailable instead of failing silently. If vs Computer also will not open, reload the page once; if it still does not, tell me and I will pass it to the team.',
      hi: '🎮 Pair-3Balls ka ek mode connection ke bina bhi chalta hai — “Play vs Computer” poori tarah aapke device par chalta hai. Private Room aur World Match online hain, isliye ye tabhi chalte hain jab site ka backend reachable ho; agar nahi hai, ya admin ne game band kar diya ho ya maintenance mode laga diya ho, to Game Zone saaf likh deta hai ki online modes available nahi hain — chupchaap fail nahi hota. Agar Computer ke saath bhi na khule, ek baar page reload karo; phir bhi na chale to batao, main team ko de dungi.',
    },
  },
  {
    keywords: [
      'leaderboard', 'leader board', 'ranking', 'rankings', 'high score', 'highscore',
      'scores', 'scoreboard', 'top players', 'tournament', 'rank', 'points table',
    ],
    reply: {
      en: '🏆 There is no leaderboard, ranking or tournament ladder in Pair-3Balls — each game is played for itself, and the result is win, loss (or a loss on the 60-second timer) or a repetition draw when the same move is played more than three times. Nothing is publicly ranked, and your games are not posted anywhere.',
      hi: '🏆 Pair-3Balls me koi leaderboard, ranking ya tournament ladder nahi hai — har game apne aap ke liye khela jaata hai aur result jeet, haar (ya 60-second timer par haar) ya repetition draw hota hai jab wahi move teen baar se zyada khela jaaye. Kuch bhi publicly rank nahi hota aur aapke games kahin post nahi hote.',
    },
  },
  {
    keywords: [
      'is there an app', 'mobile app', 'android app', 'ios app', 'play store', 'app store',
      'download the app', 'download app', 'apk', 'install the app', 'install app', 'app kab',
      'app hai kya', 'application', 'pwa', 'add to home screen', 'home screen par',
    ],
    reply: {
      en: '📱 isZma runs in the browser — there is no separate Play Store / App Store download to hunt for. On a phone you can open the site and use your browser’s “Add to Home screen” option to get an app-like icon that opens full-screen, and the site keeps working offline for the parts already loaded (the vs-Computer game works without a connection). ReportCard Studio is built into the same site under /reportcard.',
      hi: '📱 isZma browser me chalta hai — Play Store / App Store par alag download nahi hai. Phone par site kholiye aur browser ke “Add to Home screen” option se app-jaisa icon bana lijiye jo full-screen khulta hai, aur jo hissa load ho chuka hai wo offline bhi chalta rehta hai (Computer ke saath game bina internet chalta hai). ReportCard Studio usi site ke andar /reportcard par hai.',
    },
  },
];

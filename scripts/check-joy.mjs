// Validates Joy's assistant rules.
//
//  • Joy understands English and Hinglish and ANSWERS IN THE LANGUAGE ASKED.
//  • Every topic carries both translations (no missing language).
//  • Typos still resolve ("reprot card kaha hai").
//  • Off-topic questions get the polite "I only help with Ishmaverse" reply.
//  • Pair-3Balls: Joy explains the official rules, and
//    REFUSES gameplay coaching (move suggestions, board analysis, strategies).
//
// Run: node scripts/check-joy.mjs
import { createServer } from 'vite';

const problems = [];
let checked = 0;
const check = (label, condition, detail = '') => {
  checked += 1;
  const ok = Boolean(condition);
  if (!ok) problems.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` -> ${detail}`}`);
};

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
});

try {
  const joy = await server.ssrLoadModule('/src/services/joyAssistant.ts');
  const {
    JOY_TOPICS,
    joyReplyLanguage,
    detectJoyLanguage,
    resolveJoyQuery,
    getFallback,
    isFounderQuery,
    parseConfirmation,
    editDistance,
    fuzzyKeywordMatch,
    getSectionGuide,
    getGreetingTierPrices,
    GAME_STRATEGY_REFUSAL,
  } = joy;
  const { mallSections } = await server.ssrLoadModule('/src/data/sections.ts');

  /* ---------- every topic is fully bilingual ---------- */
  const missing = [];
  for (const topic of JOY_TOPICS) {
    for (const field of ['reply', 'actionLabel']) {
      const text = topic[field];
      if (!text || !text.en || !text.hi) missing.push(`${topic.id}.${field}`);
    }
  }
  check('every topic reply/action exists in English and Hinglish', missing.length === 0, missing.join(', '));
  check('the catalog covers the live sections', JOY_TOPICS.length >= 8, `${JOY_TOPICS.length} topics`);

  /* ---------- language detection ---------- */
  check('plain English stays English', detectJoyLanguage('where is the report card section') === 'en');
  check('Hinglish is detected', detectJoyLanguage('report card kaha hai') === 'hi');
  check('Hinglish with a typo is still Hinglish', detectJoyLanguage('reprot card dikhao') === 'hi');
  check('empty input defaults to English', detectJoyLanguage('   ') === 'en');

  /* ---------- English answers ---------- */
  const enReport = resolveJoyQuery('where is report card', 'en');
  check('English report-card query resolves', enReport !== null);
  check('…as a section answer', enReport?.kind === 'section');
  check('…pointing at ReportCard Studio', enReport?.topic?.id === 'reportcard-studio', enReport?.topic?.id);
  check('…in English', typeof enReport?.reply === 'string' && /ReportCard Studio/.test(enReport.reply));
  check("…and 'where' does not auto-navigate", enReport?.navigate === false);

  const enOpen = resolveJoyQuery('open the greeting cards please', 'en');
  check("'open …' asks Joy to navigate", enOpen?.navigate === true);

  /* ---------- reply language follows the question ---------- */
  check('English input keeps English replies', joyReplyLanguage('where is report card') === 'en');
  check('Hinglish input gets Hinglish replies', joyReplyLanguage('report card kaha hai') === 'hi');
  const hiReport = resolveJoyQuery('report card kaha hai', joyReplyLanguage('report card kaha hai'));
  check('Hinglish report-card query still resolves', hiReport?.kind === 'section');
  check(
    '…in Hinglish',
    typeof hiReport?.reply === 'string' && /section me hai/.test(hiReport.reply),
    hiReport?.reply?.slice(0, 60),
  );
  check(
    '…with a Hinglish button label',
    typeof hiReport?.actionLabel === 'string' && /kholo/.test(hiReport.actionLabel),
    hiReport?.actionLabel,
  );

  /* ---------- typo tolerance ---------- */
  const typo = resolveJoyQuery('reprot card kaha hai', 'hi');
  check('a typo still finds ReportCard Studio', typo?.topic?.id === 'reportcard-studio', typo?.topic?.id);
  const typoEn = resolveJoyQuery('where is the greeeting section', 'en');
  check('a typo still finds Digital Greetings', typoEn?.topic?.id === 'greetings', typoEn?.topic?.id);
  const typoPrice = resolveJoyQuery('report card ka prie kitna hai', 'hi');
  check('a typo in a phrase bank still resolves', typoPrice !== null);

  check('editDistance handles transpositions as one edit', editDistance('reprot', 'report') === 1);
  check('editDistance is 0 for identical words', editDistance('card', 'card') === 0);
  check(
    'fuzzy matching ignores short keywords',
    fuzzyKeywordMatch(['ai'], ['ai']) === null,
    'exact hits are left to the regex path',
  );

  /* ---------- money & help ---------- */
  const pricing = resolveJoyQuery('how much do the cards cost', 'en');
  check('pricing questions are answered', pricing?.kind === 'pricing' || pricing?.kind === 'section');

  /* Joy answers with the live catalogue prices when the UI supplies them. */
  const livePrices = getGreetingTierPrices([
    { tier: 'basic', price: 60, price_usd: 3 },
    { tier: 'plus', price: 90, price_usd: 4 },
    { tier: 'premium', price: 120, price_usd: 5 },
    { tier: 'elite', price: 180, price_usd: 7 },
  ]);
  check(
    'tiers are read from the existing four-tier schema',
    livePrices.map((tier) => tier.tier).join(',') === 'basic,plus,premium,elite',
    livePrices.map((tier) => tier.tier).join(','),
  );
  const livePricing = resolveJoyQuery('price kitna hai', 'hi', livePrices);
  check(
    'Home Joy uses live catalogue prices instead of hard-coded ones',
    /Basic ₹60/.test(livePricing?.reply ?? '') && /Elite ₹180/.test(livePricing?.reply ?? ''),
    livePricing?.reply?.slice(0, 120),
  );
  const help = resolveJoyQuery('what can you do', 'en');
  check('“what can you do” returns help', help?.kind === 'help');
  check('help names both live sections', /Greetings/.test(help?.reply ?? '') && /ReportCard/.test(help?.reply ?? ''));
  /*
   * The help answer is built from the mall's own section list, so every live
   * section (Game Zone included) and every coming-soon section must be named —
   * a new section can never be silently missing from Joy's introduction.
   */
  check(
    'help names every live section',
    mallSections
      .filter((section) => section.available)
      .every((section) => (help?.reply ?? '').includes(section.name)),
    mallSections
      .filter((section) => section.available && !(help?.reply ?? '').includes(section.name))
      .map((section) => section.name)
      .join(', '),
  );
  check(
    'help names every coming-soon section',
    mallSections
      .filter((section) => !section.available)
      .every((section) => (help?.reply ?? '').includes(section.name)),
    mallSections
      .filter((section) => !section.available && !(help?.reply ?? '').includes(section.name))
      .map((section) => section.name)
      .join(', '),
  );
  check(
    'the Game Zone is a real destination in Joy',
    resolveJoyQuery('where is the game zone', 'en')?.kind === 'section',
  );

  /* ---------- founder ---------- */
  check('founder questions are detected', isFounderQuery('who is the founder') === true);
  check('founder questions are detected in Hinglish', isFounderQuery('kisne banaya ye website') === true);
  check('a typo still finds the founder', isFounderQuery('who is the foundr'));
  check('unrelated text is not a founder question', isFounderQuery('how much is a birthday card') === false);
  check('confirmation parses yes', parseConfirmation('haan bilkul') === 'yes');
  check('confirmation parses no', parseConfirmation('nahi abhi') === 'no');
  check('confirmation parses neither', parseConfirmation('hmm let me think about it') === null);

  /* ---------- product knowledge (free card, tiers, lifetime, free tries) ---------- */
  const freeAgain = resolveJoyQuery('can i send the free card again and again', 'en');
  check('Joy knows the free card can be used repeatedly',
    /again and again/i.test(freeAgain?.reply ?? ''), freeAgain?.reply?.slice(0, 60));
  const freeAgainHi = resolveJoyQuery('free card baar baar bhej sakte hain kya', 'hi');
  check('a Hinglish free-card question is answered in Hinglish', /baar baar/.test(freeAgainHi?.reply ?? ''));

  const paid = resolveJoyQuery('what is the difference between free and paid card', 'en');
  check('Joy explains free vs paid',
    /font/i.test(paid?.reply ?? '') && /(music|colour|color)/i.test(paid?.reply ?? ''),
    paid?.reply?.slice(0, 60));

  const lifetime = resolveJoyQuery('how long does my card stay live', 'en');
  check('Joy explains the 48-hour card lifetime', /48/.test(lifetime?.reply ?? ''));

  const tries = resolveJoyQuery('how many free tries do i get', 'en');
  check('Joy knows the 7 free ReportCard generations',
    /7/.test(tries?.reply ?? '') && /(generation|free)/i.test(tries?.reply ?? ''));

  const excelFormat = resolveJoyQuery('which excel columns do i need', 'en');
  check('Joy explains the Excel layout (grouped components, no column splitting)',
    /(PT|column)/i.test(excelFormat?.reply ?? '') && /(split|column)/i.test(excelFormat?.reply ?? ''));

  const sending = resolveJoyQuery('how do i send the card to someone', 'en');
  check('Joy explains how to send a card', /link/i.test(sending?.reply ?? ''));

  const editCard = resolveJoyQuery('can i edit a card after paying', 'en');
  check('Joy states a card cannot be edited after it is made', /cannot be edited/i.test(editCard?.reply ?? ''), editCard?.reply?.slice(0, 60));
  const brokenLink = resolveJoyQuery('my card link is not opening', 'en');
  check('Joy explains why a card link stops opening', /48 hours/.test(brokenLink?.reply ?? ''));

  const firstPlayer = resolveJoyQuery('who starts first in pair 3 balls', 'en');
  check('Joy answers who moves first', /White starts/i.test(firstPlayer?.reply ?? ''), firstPlayer?.reply?.slice(0, 60));

  const leaderboard = resolveJoyQuery('is there a leaderboard', 'en');
  check('Joy knows there is no leaderboard', /no leaderboard/i.test(leaderboard?.reply ?? ''));

  const app = resolveJoyQuery('is there an app', 'en');
  check('Joy explains how to use Ishmaverse on a phone', /Add to Home screen/i.test(app?.reply ?? ''), app?.reply?.slice(0, 60));
  check('…and does not send the visitor to an unrelated section', /browser/i.test(app?.reply ?? ''));

  /* ---------- Pair-3Balls: Joy explains the official rules ---------- */
  const rules = resolveJoyQuery('how do i play pair 3 balls', 'en');
  check('Joy explains the Pair-3Balls board (nine points)', /nine points/i.test(rules?.reply ?? ''));
  check('Joy explains the placement phase', /place/i.test(rules?.reply ?? ''));
  check('Joy states the 60-second timer', /60-second/.test(rules?.reply ?? ''));
  check('Joy states the no-capture rule', /never captured/i.test(rules?.reply ?? ''));
  check('Joy mentions the eight lines', /eight lines/i.test(rules?.reply ?? ''));

  const rulesHi = resolveJoyQuery('pair 3 balls kaise khelte hain', 'hi');
  check('a Hinglish rules question is answered in Hinglish', /nau points/i.test(rulesHi?.reply ?? ''));

  const timerQ = resolveJoyQuery('timer kitne seconds ka hai', 'hi');
  check('Joy answers the timer question', /60/.test(timerQ?.reply ?? ''));

  const winQ = resolveJoyQuery('how do i win', 'en');
  check('"How do I win" gets the win CONDITION, not a refusal',
    /three/i.test(winQ?.reply ?? '') && !/cannot help with the play/i.test(winQ?.reply ?? ''));
  check('the win answer names the drawn lines', /(horizontal|vertical|diagonal)/i.test(winQ?.reply ?? ''));

  const movementQ = resolveJoyQuery('how does the movement phase work', 'en');
  check('Joy explains the movement rule', /empty point/i.test(movementQ?.reply ?? ''));
  check('the movement answer says pieces are not captured', /(never captured|capture)/i.test(movementQ?.reply ?? ''));

  const modesQ = resolveJoyQuery('how do i play with a friend', 'en');
  check('Joy explains the four modes', /(Private Room|World Match)/.test(modesQ?.reply ?? ''));
  check(
    'Joy mentions two players on one device',
    /(two players|one device)/i.test(modesQ?.reply ?? ''),
    modesQ?.reply,
  );
  check(
    'Joy does not claim there are no draws',
    /draw/i.test(modesQ?.reply ?? '') && !/no draw/i.test(modesQ?.reply ?? ''),
    modesQ?.reply,
  );

  /* ---------- Pair-3Balls: gameplay coaching is refused ---------- */
  const coaching = [
    ['what is the best move for me', 'en'],
    ['give me a hint', 'en'],
    ['any tips to win', 'en'],
    ['which point should I choose', 'en'],
    ['how do i beat the computer', 'en'],
    ['can you suggest a winning strategy', 'en'],
    ['analyse the board for me', 'en'],
    ['tell me my opponent weakness', 'en'],
    ['help me win this game', 'en'],
    ['mujhe jeetne ke liye kya karna chahiye', 'hi'],
    ['chaal batao', 'hi'],
    ['mujhe tip do', 'hi'],
    ['kaunsa point lun', 'hi'],
  ];
  let refusedAll = true;
  let leaked = '';
  for (const [question, lang] of coaching) {
    const answer = resolveJoyQuery(question, lang);
    const refused =
      answer?.kind === 'help' &&
      /(cannot help with the play|khel me madad nahi)/i.test(answer.reply ?? '');
    if (!refused) {
      refusedAll = false;
      leaked = `"${question}" -> ${answer?.reply?.slice(0, 70) ?? 'null'}`;
      break;
    }
  }
  check('Joy refuses every gameplay-coaching request', refusedAll, leaked);
  check('the English refusal states the boundary explicitly',
    /no move suggestions/i.test(GAME_STRATEGY_REFUSAL.en));
  check('the Hinglish refusal is written in Hinglish', /khel me madad nahi/i.test(GAME_STRATEGY_REFUSAL.hi));
  check('the refusal still offers the rules instead', /nine points/i.test(GAME_STRATEGY_REFUSAL.en));

  /* ---------- the guard must not damage the rest of Joy ---------- */
  check('the strategy guard leaves other sections alone',
    resolveJoyQuery('where is report card', 'en')?.topic?.id === 'reportcard-studio');
  check('the strategy guard does not swallow pricing',
    resolveJoyQuery('what does reportcard studio cost', 'en') !== null);
  check('the strategy guard does not swallow the free-card answer',
    /(FREE Welcome Card|free)/i.test(resolveJoyQuery('is there a free card', 'en')?.reply ?? ''));

  /* ---------- the Game Zone guide is complete and bilingual ---------- */
  const gameGuide = getSectionGuide('game-zone');
  check('a Game Zone guide exists for Joy', gameGuide !== null);
  check('the guide intro is bilingual', Boolean(gameGuide?.intro?.en && gameGuide?.intro?.hi));
  check('every Game Zone step is bilingual',
    (gameGuide?.steps ?? []).length >= 4 &&
    (gameGuide?.steps ?? []).every((s) => s.title?.en && s.title?.hi && s.detail?.en && s.detail?.hi));
  check('the Game Zone chips are bilingual',
    (gameGuide?.chips ?? []).length > 0 && (gameGuide?.chips ?? []).every((c) => c.en && c.hi));

  /* ---------- Ishmaverse itself: the whole mall in one answer ---------- */
  const aboutEn = resolveJoyQuery('what is ishmaverse', 'en');
  check('Joy can explain what Ishmaverse is', /digital mall/i.test(aboutEn?.reply ?? ''), aboutEn?.reply?.slice(0, 60));
  check(
    '…and names every live section in that answer',
    mallSections.filter((s) => s.available).every((s) => (aboutEn?.reply ?? '').includes(s.name)),
    mallSections.filter((s) => s.available && !(aboutEn?.reply ?? '').includes(s.name)).map((s) => s.name).join(', '),
  );
  check(
    '…and every coming-soon section',
    mallSections.filter((s) => !s.available).every((s) => (aboutEn?.reply ?? '').includes(s.name)),
    mallSections.filter((s) => !s.available && !(aboutEn?.reply ?? '').includes(s.name)).map((s) => s.name).join(', '),
  );
  const aboutHi = resolveJoyQuery('ishmaverse kya hai', 'hi');
  check('…in Hinglish too', /digital mall hai/i.test(aboutHi?.reply ?? ''), aboutHi?.reply?.slice(0, 60));
  for (const question of ['what do you sell', 'how does ishmaverse work', 'kya bechte ho', 'yahan kya kya hai']) {
    check(`"${question}" is answered from the same knowledge`,
      /digital mall/i.test(resolveJoyQuery(question, question.includes('kya') || question.includes('yahan') ? 'hi' : 'en')?.reply ?? ''));
  }

  /* ---------- Game Zone availability (offline / maintenance) ---------- */
  const offline = resolveJoyQuery('does the game work offline', 'en');
  check('Joy knows vs-Computer runs without a connection', /on your device/i.test(offline?.reply ?? ''), offline?.reply?.slice(0, 60));
  check('…and which modes need the backend', /(Private Room|World Match)/.test(offline?.reply ?? ''));
  const maintenance = resolveJoyQuery('game band hai kya', 'hi');
  check('Joy explains maintenance in Hinglish', /maintenance/i.test(maintenance?.reply ?? ''));
  check('Joy never promises the online modes when they are off',
    /(unavailable|available nahi)/i.test(maintenance?.reply ?? ''));

  /* ---------- ReportCard plan prices match the server's plan table ---------- */
  const { STUDIO_PLANS } = await server.ssrLoadModule('/supabase/functions/_shared/plans.ts');
  const planFaq = resolveJoyQuery('what are the reportcard plans', 'en')?.reply ?? '';
  const plansInCopy = Object.values(STUDIO_PLANS).every(
    (plan) => planFaq.includes(plan.name) && planFaq.includes(`₹${plan.priceInr}`) && planFaq.includes(`$${plan.priceUsd}`),
  );
  check(
    'Joy quotes the real studio plans (INR and USD)',
    plansInCopy,
    Object.values(STUDIO_PLANS).map((p) => `${p.name} ₹${p.priceInr}/$${p.priceUsd}`).join(', '),
  );
  check('…and the six-month duration', /6 months/i.test(planFaq));

  /* ---------- off-topic redirect ---------- */
  const offEn = resolveJoyQuery('what is the weather in paris tomorrow', 'en');
  const offHi = resolveJoyQuery('mujhe pizza order karna hai', 'hi');
  check('off-topic questions resolve to nothing (caller falls back)', offEn === null && offHi === null);
  const fallbackEn = getFallback('en');
  const fallbackHi = getFallback('hi');
  check('the English fallback is polite and scoped', /only help with/i.test(fallbackEn) && /isZma/.test(fallbackEn));
  check('the Hinglish fallback is polite and scoped', /sirf isZma/.test(fallbackHi));
  check('the two fallbacks are different languages', fallbackEn !== fallbackHi);

  console.log(`\njoy rules checked: ${checked}`);
  if (problems.length) {
    console.error('\n✗ Joy checks FAILED:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log('\n✓ Joy OK — bilingual, typo-tolerant and correctly scoped.');
} finally {
  await server.close();
}

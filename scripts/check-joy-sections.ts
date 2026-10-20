/*
 * Joy knows every Ishmaverse section — checked against the real section data.
 *
 * Two things are pinned here:
 *
 *   1. ReportCard Studio ships as a standalone SPA, so its Joy keeps its own
 *      section bank instead of importing the mall's source. That copy must not
 *      drift: every section in `src/data/sections.ts` has to exist in the
 *      Studio's bank with the same name, emoji, availability and route, and the
 *      bank may not invent a section the mall does not have.
 *   2. The mall's Joy and the Studio's Joy must both ANSWER about every section
 *      (including the ones that are not live yet) in English and Hinglish, and
 *      the Studio's answers must carry that section's real mall route.
 *
 * Usage:  npx jiti ../scripts/check-joy-sections.ts      (from ReportCard Studio)
 *         npm run check:joy-sections                     (from the repo root)
 */
import { mallSections } from '../src/data/sections.ts';
import { JOY_TOPICS, resolveJoyQuery } from '../src/services/joyAssistant.ts';
import { JOY_SECTION_GUIDES } from '../src/services/joySectionGuides.ts';
import {
  MALL_KNOWLEDGE,
  mallSectionRoute,
  resolveMallSectionAnswer,
  studioFallback,
} from '../ReportCard Studio/src/services/joyKnowledge.ts';

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++;
    return;
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

/* ── 1. the Studio's bank mirrors the mall's section data ─────────────────── */

const mallById = new Map(mallSections.map((section) => [section.id, section]));
const studioById = new Map(MALL_KNOWLEDGE.map((section) => [section.id, section]));

check(
  'the Studio knows every section the mall has',
  [...mallById.keys()].every((id) => studioById.has(id)),
  [...mallById.keys()].filter((id) => !studioById.has(id)).join(', '),
);
check(
  'the Studio invents no section the mall does not have',
  [...studioById.keys()].every((id) => mallById.has(id)),
  [...studioById.keys()].filter((id) => !mallById.has(id)).join(', '),
);

for (const [id, mallSection] of mallById) {
  const studioSection = studioById.get(id);
  if (!studioSection) continue;
  check(
    `“${mallSection.name}” keeps its name, emoji and availability`,
    studioSection.name === mallSection.name &&
      studioSection.emoji === mallSection.emoji &&
      studioSection.available === mallSection.available,
    `${studioSection.name}/${studioSection.emoji}/${studioSection.available} vs ${mallSection.name}/${mallSection.emoji}/${mallSection.available}`,
  );
  check(
    `“${mallSection.name}” points at its own route`,
    mallSectionRoute(id) === `/section/${id}`,
    mallSectionRoute(id),
  );
}

/* ── 2. both Joys answer about every section ─────────────────────────────── */

const LIVE: Record<string, string> = {
  greetings: 'greeting card',
  'reportcard-studio': 'reportcard studio',
  'game-zone': 'pair 3 balls',
  'tech-ai': 'tech and ai',
  education: 'education section',
  originals: 'originals section',
  'ui-themes': 'ui themes',
  'fx-studios': 'fx studios',
  comics: 'comics section',
};

for (const section of mallSections) {
  const phrase = LIVE[section.id] ?? section.name.toLowerCase();

  /* The mall's Joy answers it in both languages. */
  const mallEn = resolveJoyQuery(phrase, 'en');
  const mallHi = resolveJoyQuery(phrase, 'hi');
  check(
    `the mall Joy answers about “${section.name}” in English and Hinglish`,
    Boolean(mallEn) && Boolean(mallHi) && mallEn!.reply !== mallHi!.reply,
    `en=${mallEn?.kind ?? 'null'} hi=${mallHi?.kind ?? 'null'}`,
  );

  /* The Studio's Joy answers it too, and hands over the real route. */
  const studioEn = resolveMallSectionAnswer(phrase, 'en');
  const studioHi = resolveMallSectionAnswer(phrase, 'hi');
  check(
    `the Studio Joy answers about “${section.name}” in English and Hinglish`,
    Boolean(studioEn) && Boolean(studioHi) && studioEn!.reply !== studioHi!.reply,
    `en=${studioEn ? 'yes' : 'no'} hi=${studioHi ? 'yes' : 'no'}`,
  );
  check(
    `the Studio Joy points at “${section.name}”`,
    section.id === 'reportcard-studio' || studioEn?.navigate === `/section/${section.id}`,
    String(studioEn?.navigate),
  );

  /* Coming-soon sections must say so instead of selling something not there. */
  if (!section.available) {
    check(
      `the Studio Joy says “${section.name}” is not live yet`,
      /coming soon|not live yet|nahi hai/i.test(`${studioEn?.reply ?? ''} ${studioHi?.reply ?? ''}`),
      (studioEn?.reply ?? '').slice(0, 80),
    );
  }
}

/* ── 3. problems inside another section, and honest bounds ───────────────── */

const problemCases: { text: string; expect: RegExp }[] = [
  { text: 'greeting card photo upload fail kyu ho raha hai', expect: /upload-image|IMGBB|few MB|JPEG/i },
  { text: 'game zone me online modes unavailable kyu hai', expect: /backend|offline|Supabase/i },
  { text: 'pair 3 balls room code not working', expect: /6 characters|fresh Private Room|live/i },
];
for (const { text, expect } of problemCases) {
  const answer = resolveMallSectionAnswer(text, 'hi');
  check(
    `a problem inside another section is explained: “${text}”`,
    Boolean(answer) && expect.test(answer!.reply),
    (answer?.reply ?? 'no answer').slice(0, 100),
  );
}

check(
  'the Studio Joy still refuses what it does not know',
  resolveMallSectionAnswer('what is the weather in paris', 'en') === null,
);

const fallback = studioFallback('dashboard', 'en');
check(
  'the fallback names the sections Joy can actually answer about',
  mallSections.every((section) => fallback.includes(section.name)),
  mallSections.filter((s) => !fallback.includes(s.name)).map((s) => s.name).join(', '),
);
check(
  'the fallback never claims to be Studio-only any more',
  !/only help with ReportCard Studio|sirf ReportCard Studio/i.test(
    `${fallback} ${studioFallback('dashboard', 'hi')}`,
  ),
);

/* ── 4. every section still has a walkthrough in the mall Joy ───────────── */

for (const section of mallSections) {
  const hasTopic = JOY_TOPICS.some((topic) => topic.id === section.id);
  check(`the mall Joy has a topic for “${section.name}”`, hasTopic);
}
check(
  'every live section has a step-by-step guide',
  mallSections
    .filter((section) => section.available)
    .every((section) => Boolean(JOY_SECTION_GUIDES[section.id])),
  mallSections
    .filter((section) => section.available && !JOY_SECTION_GUIDES[section.id])
    .map((section) => section.name)
    .join(', '),
);

console.log(`\njoy section checks: ${passed}`);
if (failures.length) {
  console.error('\n✗ Joy section checks FAILED:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('✓ Joy knows every Ishmaverse section in both apps (english + hinglish).');

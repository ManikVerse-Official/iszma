import { BookOpen } from 'lucide-react';
import { TURN_SECONDS } from '../../game/pair3balls/engine';

/**
 * Pair-3Balls rules, in English.
 *
 * The wording is generated from the engine's own constants so the instructions
 * can never contradict the rules actually being enforced (e.g. the timer length
 * is read from TURN_SECONDS rather than typed twice).
 *
 * The library used to ship a language switch here. The whole user-facing app is
 * English, so the switch (and the second copy of every rule) was removed rather
 * than hidden: there is now one rules text and no language state to drift.
 */

export const Pair3BallsRules: React.FC = () => {
  const items = [
    'Nine points: four corners, four side midpoints and one centre, joined by straight lines. Eight lines of three run across, down and diagonally through the centre.',
    'Each player places three pieces, one per turn, on any empty point. White starts.',
    'Once all six pieces are placed, players take turns stepping one of their own pieces to an empty point connected to it by a line.',
    'Line up three of your own pieces on one of the drawn lines to win.',
    `Each turn has a ${TURN_SECONDS}-second timer. If it runs out, that player loses.`,
    'Pieces are never captured and never removed.',
  ];

  return (
    <div className="rounded-2xl border border-white/10 p-5 space-y-3">
      <p className="inline-flex items-center gap-2 text-sm font-semibold text-white">
        <BookOpen className="w-4 h-4 text-neon-purple" />
        How to play
      </p>

      <ul className="space-y-2 text-sm text-gray-300 leading-relaxed">
        {items.map((line, index) => (
          <li key={line} className={index === 3 ? 'text-emerald-300' : undefined}>
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
};

import { LINES, POINT_GRID, type Cell, type Player, type Point } from '../../game/pair3balls/engine';

/**
 * The Pair-3Balls board.
 *
 * Rendering only — every rule lives in the engine. The nine points sit on a 3x3
 * grid whose cell centres (16.67% / 50% / 83.33%) are exactly the coordinates
 * the background SVG draws its lines through, so board and pieces can never
 * drift apart.
 *
 * The clickable elements are real <button>s, so the board is keyboard playable
 * and screen readers announce each point by name.
 */

/** Grid cell order, row by row. */
const GRID_ORDER: Point[] = [0, 4, 1, 7, 8, 5, 2, 6, 3];

/** Grid index (0-2) -> SVG coordinate, matching the 3x3 cell centres. */
const coord = (index: number): number => (index / 2) * 66.666 + 16.666;

export const POINT_NAMES: ReadonlyArray<string> = [
  'top-left corner',
  'top-right corner',
  'bottom-left corner',
  'bottom-right corner',
  'top middle',
  'right middle',
  'bottom middle',
  'left middle',
  'centre',
];

export const pointName = (point: Point): string => POINT_NAMES[point] ?? `point ${point}`;

interface Pair3BallsBoardProps {
  board: Cell[];
  /** Points the local player may click right now. */
  selectablePoints?: Point[];
  /** A point already picked as the piece to move. */
  selected?: Point | null;
  /** Completed line to highlight, when the game is won. */
  winningLine?: readonly [Point, Point, Point] | null;
  /** The most recent move, drawn with a ring. */
  lastMove?: { from?: Point; to: Point } | null;
  onPointClick?: (point: Point) => void;
  /** Whose pieces are the local player's (for the "your piece" affordance). */
  myPlayer?: Player | null;
  disabled?: boolean;
}

export const Pair3BallsBoard: React.FC<Pair3BallsBoardProps> = ({
  board,
  selectablePoints = [],
  selected = null,
  winningLine = null,
  lastMove = null,
  onPointClick,
  myPlayer = null,
  disabled = false,
}) => {
  const selectable = new Set(selectablePoints);
  const highlight = new Set(winningLine ?? []);

  return (
    <div className="relative w-full aspect-square max-w-[26rem] mx-auto select-none">
      {/* Drawn board: the outer rectangle plus every valid line. */}
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="xMidYMid meet"
        className="absolute inset-0 w-full h-full"
        aria-hidden="true"
      >
        <rect
          x="16.666"
          y="16.666"
          width="66.668"
          height="66.668"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          className="text-neon-purple/50"
          rx="2"
        />
        {LINES.map((line) => {
          const [a, b, c] = line;
          const isWin = winningLine && line.every((point) => highlight.has(point));
          const lastA = lastMove?.from;
          const isLast = lastMove && (line.includes(lastMove.to)) && (lastA === undefined || line.includes(lastA));
          return (
            <polyline
              key={`${a}-${b}-${c}`}
              points={[a, b, c]
                .map((point) => `${coord(POINT_GRID[point].x)},${coord(POINT_GRID[point].y)}`)
                .join(' ')}
              fill="none"
              stroke="currentColor"
              strokeWidth={isWin ? 2.6 : isLast ? 1.6 : 1}
              strokeLinecap="round"
              className={
                isWin
                  ? 'text-emerald-400'
                  : isLast
                    ? 'text-neon-purple/80'
                    : 'text-neon-purple/30'
              }
            />
          );
        })}
      </svg>

      {/* Playable points. */}
      <div className="absolute inset-0 grid grid-cols-3 grid-rows-3">
        {GRID_ORDER.map((point) => {
          const cell = board[point];
          const isSelectable = !disabled && selectable.has(point);
          const isSelected = selected === point;
          const isLast = lastMove?.to === point;
          const isWinning = highlight.has(point);
          const isMine = myPlayer !== null && cell === myPlayer;

          return (
            <div key={point} className="flex items-center justify-center">
              <button
                type="button"
                onClick={() => onPointClick?.(point)}
                disabled={!isSelectable}
                aria-label={`${pointName(point)}${
                  cell ? `, ${cell} piece` : ', empty'
                }${isSelectable ? ', selectable' : ''}`}
                aria-pressed={isSelected}
                title={pointName(point)}
                className={[
                  'relative rounded-full transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-neon-purple focus-visible:ring-offset-2 focus-visible:ring-offset-bg-dark-start',
                  // A generous touch target on phones, a smaller one on desktop.
                  'w-11 h-11 sm:w-12 sm:h-12 flex items-center justify-center',
                  isSelectable ? 'cursor-pointer hover:scale-105 active:scale-95' : 'cursor-default',
                ].join(' ')}
              >
                {/* The point itself. */}
                <span
                  className={[
                    'rounded-full transition-all duration-150',
                    cell ? 'w-8 h-8 sm:w-9 sm:h-9' : 'w-3.5 h-3.5',
                    cell === 'white'
                      ? 'bg-white shadow-[0_0_14px_rgba(255,255,255,0.55)]'
                      : '',
                    cell === 'black'
                      ? 'bg-[#1a0b2e] border-2 border-gray-300 shadow-[0_0_14px_rgba(139,92,246,0.55)]'
                      : '',
                    !cell ? 'bg-neon-purple/35' : '',
                  ].join(' ')}
                />

                {/* Ring for the point just played. */}
                {isLast && (
                  <span className="absolute inset-0 rounded-full border-2 border-neon-purple/80 pointer-events-none" />
                )}

                {/* Ring for a completed winning line. */}
                {isWinning && (
                  <span className="absolute inset-0 rounded-full border-2 border-emerald-400 pointer-events-none animate-pulse" />
                )}

                {/* Ring for the piece currently picked up. */}
                {isSelected && (
                  <span className="absolute inset-0 rounded-full border-2 border-dashed border-emerald-400 pointer-events-none" />
                )}

                {/* Hint that this piece belongs to you. */}
                {isMine && !isSelected && (
                  <span className="absolute -bottom-0.5 w-1.5 h-1.5 rounded-full bg-emerald-400/80 pointer-events-none" />
                )}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
};

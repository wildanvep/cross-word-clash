export type Direction = "Across" | "Down";
export type Difficulty = "Easy" | "Medium" | "Hard" | "Expert";
export type ClueStatus = "Unanswered" | "Active" | "Correct" | "Incorrect" | "Skipped";
export type GameStatus = "ready" | "playing" | "paused" | "finished";

export interface Team {
  id: string;
  name: string;
  score: number;
  correctCount: number;
  incorrectCount: number;
  completedClues: number;
}

export interface Clue {
  id: string;
  number: number;
  direction: Direction;
  hints: [string, string, string];
  revealedHintCount: number;
  answer: string;
  difficulty: Difficulty;
  points: number;
  row: number;
  col: number;
  status: ClueStatus;
  revealed: boolean;
  attemptedTeamIds: string[];
  allowRepeatAttempts: boolean;
  awardedTeamId: string | null;
  awardedPoints: number | null;
}

export interface GameState {
  teams: Team[];
  clues: Clue[];
  selectedClueId: string | null;
  selectedTeamId: string | null;
  currentRound: number;
  gameStatus: GameStatus;
  timerDuration: number;
  timerEndsAt: number | null;
  pausedTimeLeft: number;
  message: { type: "correct" | "incorrect" | "time" | "timeout" | "bonus"; text: string; id: number } | null;
  resultStep: number;
}

export const STORAGE_KEY = "crossword-club-game-v1";
export const GRID_SIZE = 13;

const entries: Omit<Clue, "number" | "status" | "revealed" | "revealedHintCount" | "attemptedTeamIds" | "allowRepeatAttempts" | "awardedTeamId" | "awardedPoints">[] = [
  { id: "a-candle", direction: "Across", hints: ["This wax object has a wick that can be lit.", "People often put one on a birthday cake.", "It has six letters and begins with C."], answer: "CANDLE", difficulty: "Easy", points: 10, row: 0, col: 6 },
  { id: "a-plane", direction: "Across", hints: ["This vehicle flies through the air using wings.", "Passengers board one at an airport.", "It has five letters and begins with P."], answer: "PLANE", difficulty: "Easy", points: 10, row: 2, col: 5 },
  { id: "a-beef", direction: "Across", hints: ["This meat comes from a cow.", "It is often used for burgers or steak.", "It has four letters and begins with B."], answer: "BEEF", difficulty: "Easy", points: 10, row: 4, col: 6 },
  { id: "a-banner", direction: "Across", hints: ["This long strip displays a message, symbol, or design.", "It may hang at an event or appear across a website.", "It has six letters and begins with B."], answer: "BANNER", difficulty: "Medium", points: 20, row: 6, col: 5 },
  { id: "a-spice", direction: "Across", hints: ["This flavorful ingredient is added to food for seasoning.", "Pepper and cinnamon are examples.", "It has five letters and begins with S."], answer: "SPICE", difficulty: "Easy", points: 10, row: 8, col: 4 },
  { id: "a-nurse", direction: "Across", hints: ["This healthcare professional cares for sick or injured people.", "They may work in a hospital or clinic.", "It has five letters and begins with N."], answer: "NURSE", difficulty: "Easy", points: 10, row: 10, col: 6 },
  { id: "d-celebration", direction: "Down", hints: ["This is a joyful event held for a special reason.", "A party or ceremony can mark an important occasion.", "It has eleven letters and begins with C."], answer: "CELEBRATION", difficulty: "Hard", points: 30, row: 0, col: 6 },
  { id: "d-eels", direction: "Down", hints: ["These long, slippery fish live in rivers or the sea.", "The word is the plural form of a fish called an eel.", "It has four letters and begins with E."], answer: "EELS", difficulty: "Easy", points: 10, row: 0, col: 11 },
  { id: "d-elf", direction: "Down", hints: ["This small magical character appears in many folk stories.", "It is often shown with pointed ears.", "It has three letters and begins with E."], answer: "ELF", difficulty: "Easy", points: 10, row: 2, col: 9 },
  { id: "d-eon", direction: "Down", hints: ["This word describes an extremely long period of time.", "Geologists use it for one of the largest divisions of Earth's history.", "It has three letters and begins with E."], answer: "EON", difficulty: "Medium", points: 20, row: 4, col: 8 },
  { id: "d-range", direction: "Down", hints: ["This can mean a variety of things or the distance something reaches.", "A mountain chain can also be called this.", "It has five letters and begins with R."], answer: "RANGE", difficulty: "Medium", points: 20, row: 6, col: 10 },
  { id: "d-ear", direction: "Down", hints: ["This body part helps you hear sounds.", "Most people have one on each side of the head.", "It has three letters and begins with E."], answer: "EAR", difficulty: "Easy", points: 10, row: 8, col: 8 },
  { id: "d-sun", direction: "Down", hints: ["This star is at the center of our solar system.", "It gives Earth light and warmth.", "It has three letters and begins with S."], answer: "SUN", difficulty: "Easy", points: 10, row: 10, col: 9 },
];

function numberEntries(): Clue[] {
  const starts = new Map<string, number>();
  const sortedStarts = [...new Set(entries.map(({ row, col }) => `${row},${col}`))]
    .map((key) => key.split(",").map(Number) as [number, number])
    .sort(([rowA, colA], [rowB, colB]) => rowA - rowB || colA - colB);
  sortedStarts.forEach(([row, col], index) => starts.set(`${row},${col}`, index + 1));
  return entries.map((entry) => ({
    ...entry,
    number: starts.get(`${entry.row},${entry.col}`)!,
    status: "Unanswered",
    revealed: false,
    revealedHintCount: 0,
    attemptedTeamIds: [],
    allowRepeatAttempts: false,
    awardedTeamId: null,
    awardedPoints: null,
  }));
}

export function validatePuzzle(clues: Clue[]): void {
  const cells = new Map<string, { letter: string; acrossId?: string; downId?: string }>();
  for (const clue of clues) {
    for (let index = 0; index < clue.answer.length; index += 1) {
      const row = clue.row + (clue.direction === "Down" ? index : 0);
      const col = clue.col + (clue.direction === "Across" ? index : 0);
      if (row < 0 || col < 0 || row >= GRID_SIZE || col >= GRID_SIZE) throw new Error(`Clue ${clue.id} extends beyond the crossword grid.`);
      const key = `${row},${col}`;
      const letter = clue.answer[index];
      const cell = cells.get(key) ?? { letter };
      if (cell.letter !== letter) throw new Error(`Crossword answers conflict at row ${row + 1}, column ${col + 1}.`);
      const directionId = clue.direction === "Across" ? "acrossId" : "downId";
      if (cell[directionId] && cell[directionId] !== clue.id) throw new Error(`Clues overlap in the same direction at row ${row + 1}, column ${col + 1}.`);
      cell[directionId] = clue.id;
      cells.set(key, cell);
    }
  }

  const crossedClueIds = new Set<string>();
  const clueConnections = new Map(clues.map((clue) => [clue.id, new Set<string>()]));
  for (const cell of cells.values()) {
    if (cell.acrossId && cell.downId) {
      crossedClueIds.add(cell.acrossId);
      crossedClueIds.add(cell.downId);
      clueConnections.get(cell.acrossId)?.add(cell.downId);
      clueConnections.get(cell.downId)?.add(cell.acrossId);
    }
  }
  const uncrossed = clues.find((clue) => !crossedClueIds.has(clue.id));
  if (uncrossed) throw new Error(`Clue ${uncrossed.id} does not cross another answer.`);

  if (clues.length > 0) {
    const connectedClueIds = new Set([clues[0].id]);
    const pendingClueIds = [clues[0].id];
    while (pendingClueIds.length > 0) {
      const currentClueId = pendingClueIds.pop()!;
      for (const connectedClueId of clueConnections.get(currentClueId) ?? []) {
        if (connectedClueIds.has(connectedClueId)) continue;
        connectedClueIds.add(connectedClueId);
        pendingClueIds.push(connectedClueId);
      }
    }
    if (connectedClueIds.size !== clues.length) throw new Error("All clues must connect to one crossword grid.");
  }

  for (const [direction, rowStep, colStep] of [["Across", 0, 1], ["Down", 1, 0]] as const) {
    const clueStarts = new Map(clues
      .filter((clue) => clue.direction === direction)
      .map((clue) => [`${clue.row},${clue.col}`, clue]));

    for (const key of cells.keys()) {
      const [row, col] = key.split(",").map(Number);
      if (cells.has(`${row - rowStep},${col - colStep}`)) continue;
      let word = "";
      let nextRow = row;
      let nextCol = col;
      while (cells.has(`${nextRow},${nextCol}`)) {
        word += cells.get(`${nextRow},${nextCol}`)!.letter;
        nextRow += rowStep;
        nextCol += colStep;
      }
      if (word.length < 2) continue;
      const clue = clueStarts.get(`${row},${col}`);
      if (!clue || clue.answer !== word) {
        throw new Error(`The ${direction.toLowerCase()} run "${word}" at row ${row + 1}, column ${col + 1} has no matching clue.`);
      }
    }
  }
}

export function createInitialState(): GameState {
  const clues = numberEntries();
  validatePuzzle(clues);
  const teams: Team[] = ["Team 1", "Team 2", "Team 3"].map((name, index) => ({
    id: `team-${index + 1}`,
    name,
    score: 0,
    correctCount: 0,
    incorrectCount: 0,
    completedClues: 0,
  }));
  return {
    teams,
    clues,
    selectedClueId: null,
    selectedTeamId: teams[0].id,
    currentRound: 1,
    gameStatus: "ready",
    timerDuration: 30,
    timerEndsAt: null,
    pausedTimeLeft: 30,
    message: null,
    resultStep: 0,
  };
}

export function selectClue(state: GameState, clueId: string): GameState {
  const clue = state.clues.find((entry) => entry.id === clueId);
  if (!clue || clue.status === "Correct" || clue.status === "Skipped") return state;
  return {
    ...state,
    selectedClueId: clueId,
    clues: state.clues.map((entry) => entry.id === clueId
      ? { ...entry, status: "Active", revealedHintCount: 0 }
      : entry.status === "Active" ? { ...entry, status: "Unanswered" } : entry),
    message: null,
  };
}

export function getGrid(clues: Clue[]) {
  const cells = new Map<string, { letter: string; clueNumbers: number[]; acrossId?: string; downId?: string }>();
  for (const clue of clues) {
    for (let index = 0; index < clue.answer.length; index += 1) {
      const row = clue.row + (clue.direction === "Down" ? index : 0);
      const col = clue.col + (clue.direction === "Across" ? index : 0);
      const key = `${row},${col}`;
      const cell = cells.get(key) ?? { letter: clue.answer[index], clueNumbers: [] };
      if (index === 0 && !cell.clueNumbers.includes(clue.number)) cell.clueNumbers.push(clue.number);
      if (clue.direction === "Across") cell.acrossId = clue.id;
      else cell.downId = clue.id;
      cells.set(key, cell);
    }
  }
  return cells;
}

export function orderedTeams(teams: Team[]): Team[] {
  return [...teams].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

export function teamRank(teams: Team[], teamId: string): number {
  const sorted = orderedTeams(teams);
  const team = sorted.find((entry) => entry.id === teamId);
  if (!team) return sorted.length;
  return 1 + sorted.filter((entry) => entry.score > team.score).length;
}

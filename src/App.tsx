import { useCallback, useEffect, useMemo, useState } from "react";
import RoomPanel, { type RoomPanelProps } from "./RoomPanel";
import { hostTokenStorageKey, useRoomConnection, type RoomConnectionStatus } from "./realtime";
import {
  createInitialState,
  getGrid,
  GRID_SIZE,
  orderedTeams,
  selectClue as applyClueSelection,
  STORAGE_KEY,
  teamRank,
  validatePuzzle,
  type Clue,
  type ClueStatus,
  type Difficulty,
  type GameState,
  type Team,
} from "./game";

function loadState(): GameState {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return createInitialState();
    const parsed = JSON.parse(stored) as Partial<GameState> & { clues?: (Partial<Clue> & { id: string; text?: string })[] };
    if (!Array.isArray(parsed.teams) || !Array.isArray(parsed.clues) || parsed.clues.length === 0) {
      throw new Error("Saved game data is incomplete.");
    }
    const defaults = createInitialState();
    const previousDefaultNames = ["Team A", "Team B", "Team C", "Team D"];
    const isPreviousDefaultRoster = parsed.teams.length === previousDefaultNames.length
      && parsed.teams.every((team, index) => team.name === previousDefaultNames[index]
        && team.score === 0 && team.correctCount === 0 && team.incorrectCount === 0 && team.completedClues === 0);
    const teams = isPreviousDefaultRoster ? defaults.teams : parsed.teams;
    const defaultClues = new Map(defaults.clues.map((clue) => [clue.id, clue]));
    if (parsed.clues.length !== defaults.clues.length || parsed.clues.some((clue) => !defaultClues.has(clue.id))) {
      console.warn("The saved crossword has changed. Starting a fresh puzzle with the saved session settings.");
      return { ...defaults, teams, selectedTeamId: teams[0]?.id ?? null };
    }
    let clues = parsed.clues.map((savedClue) => {
      const base = defaultClues.get(savedClue.id)!;
      const hints = Array.isArray(savedClue.hints) && savedClue.hints.length === 3
        ? savedClue.hints as [string, string, string]
        : base.hints;
      return {
        ...base,
        ...savedClue,
        number: base.number,
        direction: base.direction,
        row: base.row,
        col: base.col,
        hints,
        revealedHintCount: Number.isInteger(savedClue.revealedHintCount) ? savedClue.revealedHintCount! : 0,
        allowRepeatAttempts: savedClue.allowRepeatAttempts ?? false,
        awardedPoints: savedClue.awardedPoints ?? null,
      };
    });
    try {
      validatePuzzle(clues);
    } catch (error) {
      const editedAnswerIds = new Set(clues
        .filter((clue) => clue.answer !== defaultClues.get(clue.id)!.answer)
        .map((clue) => clue.id));
      if (editedAnswerIds.size === 0) throw error;
      console.warn("Saved custom answers do not fit the updated crossword layout. Restoring those answers to the default words.");
      clues = clues.map((clue) => {
        if (!editedAnswerIds.has(clue.id)) return clue;
        const base = defaultClues.get(clue.id)!;
        return { ...clue, answer: base.answer, hints: base.hints, revealedHintCount: 0, revealed: false };
      });
      validatePuzzle(clues);
    }
    const timerDuration = parsed.timerDuration === 60 ? defaults.timerDuration : parsed.timerDuration ?? defaults.timerDuration;
    const pausedTimeLeft = parsed.pausedTimeLeft === 60 ? defaults.pausedTimeLeft : parsed.pausedTimeLeft ?? timerDuration;
    const selectedTeamId = teams.find((team) => team.id === parsed.selectedTeamId)?.id ?? teams[0]?.id ?? null;
    return { ...defaults, ...parsed, teams, selectedTeamId, clues, timerDuration, pausedTimeLeft };
  } catch (error) {
    console.error("Could not load the saved Crossword Club game.", error);
    return createInitialState();
  }
}

function useGameState() {
  const [state, setState] = useState<GameState>(loadState);
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY || !event.newValue) return;
      try {
        setState(JSON.parse(event.newValue) as GameState);
      } catch (error) {
        console.error("Could not synchronize saved game data.", error);
      }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  return [state, setState] as const;
}

function currentRoute(): "/game" | "/host" {
  const path = window.location.pathname;
  if (path === "/host") return "/host";
  if (path !== "/game") window.history.replaceState({}, "", "/game");
  return "/game";
}

function nextTeamName(teams: Team[]): string {
  let number = teams.length + 1;
  while (teams.some((team) => team.name === `Team ${number}`)) number += 1;
  return `Team ${number}`;
}

function roomCodeFromLocation(): string | null {
  const roomCode = new URLSearchParams(window.location.search).get("room")?.trim().toUpperCase();
  return roomCode && /^[A-F0-9]{12}$/.test(roomCode) ? roomCode : null;
}

function App() {
  const [state, setState] = useGameState();
  const [path, setPath] = useState(currentRoute);
  const [roomCode, setRoomCode] = useState(roomCodeFromLocation);
  const [roomActionError, setRoomActionError] = useState<string | null>(null);
  const [creatingRoom, setCreatingRoom] = useState(false);
  const [confirmAction, setConfirmAction] = useState<"reset" | "reset-game" | "finish" | "reveal" | null>(null);
  const [seconds, setSeconds] = useState(60);
  const hostPage = path === "/host";
  const hostToken = roomCode ? localStorage.getItem(hostTokenStorageKey(roomCode)) : null;
  const roomConnection = useRoomConnection(
    roomCode,
    hostPage ? "host" : "player",
    hostToken,
    state,
    setState,
  );
  const hostSessionActive = hostPage && (!roomCode || roomConnection.status === "connected");

  useEffect(() => {
    const handleNavigation = () => {
      const route = currentRoute();
      setPath(route);
      setRoomCode(roomCodeFromLocation());
    };
    window.addEventListener("popstate", handleNavigation);
    return () => window.removeEventListener("popstate", handleNavigation);
  }, []);

  const navigate = (to: "/game" | "/host") => {
    if (window.location.pathname !== to) {
      const query = roomCode ? `?room=${encodeURIComponent(roomCode)}` : "";
      window.history.pushState({}, "", `${to}${query}`);
    }
    setPath(to);
  };

  const createRoom = async () => {
    setCreatingRoom(true);
    setRoomActionError(null);
    try {
      const response = await fetch("/api/ws", { method: "POST" });
      let result: { roomCode?: string; token?: string; error?: string };
      try {
        result = await response.json() as typeof result;
      } catch {
        throw new Error("The live room service is not available here. Deploy to Vercel with Redis configured, or use `vercel dev`.");
      }
      if (!response.ok || !result.roomCode || !result.token) {
        throw new Error(result.error ?? "Could not create a live room.");
      }
      localStorage.setItem(hostTokenStorageKey(result.roomCode), result.token);
      const url = new URL(window.location.href);
      url.search = `?room=${encodeURIComponent(result.roomCode)}`;
      window.history.pushState({}, "", `${url.pathname}${url.search}`);
      setRoomCode(result.roomCode);
    } catch (error) {
      console.error("Could not create a live room.", error);
      setRoomActionError(error instanceof Error ? error.message : "Could not create a live room.");
    } finally {
      setCreatingRoom(false);
    }
  };

  const joinRoom = (value: string) => {
    const code = value.trim().toUpperCase();
    if (!/^[A-F0-9]{12}$/.test(code)) {
      setRoomActionError("Enter the 12-character room code shown by the Host Desk.");
      return;
    }
    setRoomActionError(null);
    const url = new URL(window.location.href);
    url.pathname = "/game";
    url.search = `?room=${encodeURIComponent(code)}`;
    window.history.pushState({}, "", `${url.pathname}${url.search}`);
    setRoomCode(code);
    setPath("/game");
  };

  const copyPlayerLink = async () => {
    if (!roomCode) return;
    try {
      const playerOrigin = window.location.hostname.endsWith(".vercel.app")
        ? "https://cross-word-clash.vercel.app"
        : window.location.origin;
      await navigator.clipboard.writeText(`${playerOrigin}/game?room=${encodeURIComponent(roomCode)}`);
      setRoomActionError(null);
    } catch (error) {
      console.error("Could not copy the player room link.", error);
      setRoomActionError("Could not copy the link. You can share the room code instead.");
    }
  };

  const remaining = useCallback(() => {
    if (!state.timerEndsAt) return state.pausedTimeLeft;
    return Math.max(0, Math.ceil((state.timerEndsAt - Date.now()) / 1000));
  }, [state.timerEndsAt, state.pausedTimeLeft]);

  useEffect(() => {
    setSeconds(remaining());
    const interval = window.setInterval(() => setSeconds(remaining()), 250);
    return () => window.clearInterval(interval);
  }, [remaining]);

  useEffect(() => {
    if (!hostSessionActive || seconds !== 0 || !state.timerEndsAt) return;
    setState((current) => {
      if (current.timerEndsAt === null) return current;
      const team = current.teams.find((entry) => entry.id === current.selectedTeamId);
      const clue = current.clues.find((entry) => entry.id === current.selectedClueId);
      if (!team || !clue || clue.awardedTeamId || clue.status === "Correct" || clue.status === "Skipped") {
        return { ...current, timerEndsAt: null, pausedTimeLeft: 0, message: { type: "time", text: "TIME'S UP!", id: Date.now() } };
      }

      const nextTeam = current.teams.find((entry) => entry.id !== team.id && !clue.attemptedTeamIds.includes(entry.id));
      return {
        ...current,
        selectedTeamId: nextTeam?.id ?? current.selectedTeamId,
        teams: current.teams.map((entry) => entry.id === team.id ? { ...entry, incorrectCount: entry.incorrectCount + 1 } : entry),
        clues: current.clues.map((entry) => entry.id === clue.id ? {
          ...entry,
          status: nextTeam ? "Incorrect" : "Skipped",
          revealedHintCount: 0,
          attemptedTeamIds: entry.attemptedTeamIds.includes(team.id) ? entry.attemptedTeamIds : [...entry.attemptedTeamIds, team.id],
        } : entry),
        timerEndsAt: null,
        pausedTimeLeft: 0,
        message: {
          type: "timeout",
          text: `${team.name} passed.${nextTeam ? ` ${nextTeam.name} is up next.` : " No teams are left to answer."}`,
          id: Date.now(),
        },
      };
    });
  }, [hostSessionActive, seconds, state.timerEndsAt, setState]);

  useEffect(() => {
    const messageId = state.message?.id;
    if (!messageId || state.message?.type === "timeout") return;
    const timeout = window.setTimeout(() => {
      setState((current) => current.message?.id === messageId ? { ...current, message: null } : current);
    }, 7000);
    return () => window.clearTimeout(timeout);
  }, [state.message?.id, state.message?.type, setState]);

  useEffect(() => {
    if (state.gameStatus !== "finished" || state.resultStep >= 3) return;
    const currentStep = state.resultStep;
    const timeout = window.setTimeout(() => {
      setState((current) => current.gameStatus === "finished" && current.resultStep === currentStep
        ? { ...current, resultStep: currentStep + 1 }
        : current);
    }, 1700);
    return () => window.clearTimeout(timeout);
  }, [state.gameStatus, state.resultStep, setState]);

  const updateClue = (id: string, updater: (clue: Clue) => Clue) => {
    setState((current) => ({ ...current, clues: current.clues.map((clue) => clue.id === id ? updater(clue) : clue) }));
  };

  const chooseClue = (clue: Clue) => {
    if (clue.status === "Correct" || clue.status === "Skipped") return;
    if (!hostPage) roomConnection.requestClueSelection(clue.id);
    setState((current) => applyClueSelection(current, clue.id));
  };

  const timerStartPause = () => {
    setState((current) => {
      if (current.gameStatus === "paused" || current.gameStatus === "finished") return current;
      if (current.timerEndsAt) {
        const left = Math.max(0, Math.ceil((current.timerEndsAt - Date.now()) / 1000));
        return { ...current, timerEndsAt: null, pausedTimeLeft: left };
      }
      const left = current.pausedTimeLeft || current.timerDuration;
      return { ...current, timerEndsAt: Date.now() + left * 1000, pausedTimeLeft: left, gameStatus: current.gameStatus === "ready" ? "playing" : current.gameStatus };
    });
  };

  const resetTimer = () => setState((current) => ({ ...current, timerEndsAt: null, pausedTimeLeft: current.timerDuration }));
  const selectedClue = state.clues.find((clue) => clue.id === state.selectedClueId) ?? null;
  const selectedTeam = state.teams.find((team) => team.id === state.selectedTeamId) ?? null;
  const grid = useMemo(() => getGrid(state.clues), [state.clues]);
  const sortedTeams = useMemo(() => orderedTeams(state.teams), [state.teams]);

  const recordIncorrect = () => {
    if (!selectedClue || !selectedTeam) return;
    setState((current) => {
      const clue = current.clues.find((entry) => entry.id === selectedClue.id);
      if (!clue || clue.awardedTeamId || clue.status === "Correct" || clue.status === "Skipped" || (clue.attemptedTeamIds.includes(selectedTeam.id) && !clue.allowRepeatAttempts)) return current;
      return {
        ...current,
        selectedTeamId: current.teams.find((team) => team.id !== selectedTeam.id && !clue.attemptedTeamIds.includes(team.id))?.id ?? selectedTeam.id,
        teams: current.teams.map((team) => team.id === selectedTeam.id ? { ...team, incorrectCount: team.incorrectCount + 1 } : team),
        clues: current.clues.map((entry) => entry.id === clue.id ? {
          ...entry,
          status: "Incorrect",
          revealedHintCount: 0,
          attemptedTeamIds: entry.attemptedTeamIds.includes(selectedTeam.id) ? entry.attemptedTeamIds : [...entry.attemptedTeamIds, selectedTeam.id],
        } : entry),
        timerEndsAt: null,
        pausedTimeLeft: current.timerDuration,
        message: { type: "incorrect", text: "WRONG ANSWER — STEAL OPPORTUNITY", id: Date.now() },
      };
    });
  };

  const markCorrect = (teamId = state.selectedTeamId) => {
    if (!selectedClue || !teamId || selectedClue.awardedTeamId || selectedClue.status === "Correct" || selectedClue.status === "Skipped") return;
    const scoringTeam = state.teams.find((team) => team.id === teamId);
    if (!scoringTeam) return;
    setState((current) => {
      const clue = current.clues.find((entry) => entry.id === selectedClue.id);
      const team = current.teams.find((entry) => entry.id === teamId);
      if (!clue || !team || clue.awardedTeamId || clue.status === "Correct" || clue.status === "Skipped" || (clue.attemptedTeamIds.includes(teamId) && !clue.allowRepeatAttempts)) return current;
      return {
        ...current,
        selectedTeamId: teamId,
        teams: current.teams.map((entry) => entry.id === teamId
          ? { ...entry, score: entry.score + clue.points, correctCount: entry.correctCount + 1, completedClues: entry.completedClues + 1 }
          : entry),
        clues: current.clues.map((entry) => entry.id === clue.id ? { ...entry, status: "Correct", awardedTeamId: teamId, awardedPoints: clue.points } : entry),
        timerEndsAt: null,
        pausedTimeLeft: current.timerDuration,
        message: { type: "correct", text: `${team.name.toUpperCase()} +${clue.points} POINTS`, id: Date.now() },
      };
    });
  };

  const passClue = () => {
    if (!selectedClue) return;
    updateClue(selectedClue.id, (clue) => ({ ...clue, status: "Skipped" }));
    setState((current) => ({ ...current, timerEndsAt: null, pausedTimeLeft: current.timerDuration, message: { type: "time", text: "CLUE PASSED", id: Date.now() } }));
  };

  const adjustScore = (teamId: string, delta: number) => {
    setState((current) => ({
      ...current,
      teams: current.teams.map((team) => team.id === teamId ? { ...team, score: Math.max(0, team.score + delta) } : team),
    }));
  };

  const changeTeamName = (teamId: string, name: string) => {
    setState((current) => ({ ...current, teams: current.teams.map((team) => team.id === teamId ? { ...team, name } : team) }));
  };

  const addTeam = () => {
    const id = `team-${Date.now()}`;
    setState((current) => ({
      ...current,
      teams: [...current.teams, { id, name: nextTeamName(current.teams), score: 0, correctCount: 0, incorrectCount: 0, completedClues: 0 }],
    }));
  };

  const removeTeam = (team: Team) => {
    if (state.teams.length < 2) return;
    setState((current) => ({
      ...current,
      teams: current.teams.filter((entry) => entry.id !== team.id),
      selectedTeamId: current.selectedTeamId === team.id ? current.teams.find((entry) => entry.id !== team.id)?.id ?? null : current.selectedTeamId,
      clues: current.clues.map((clue) => ({
        ...clue,
        attemptedTeamIds: clue.attemptedTeamIds.filter((id) => id !== team.id),
        ...(clue.awardedTeamId === team.id ? { awardedTeamId: null, awardedPoints: null, status: "Unanswered" as const } : {}),
      })),
    }));
  };

  const resetClue = (clue: Clue) => {
    setState((current) => {
      const currentClue = current.clues.find((entry) => entry.id === clue.id);
      if (!currentClue || (currentClue.status === "Unanswered" && !currentClue.revealed && currentClue.attemptedTeamIds.length === 0)) return current;
      return {
        ...current,
        teams: current.teams.map((team) => team.id === currentClue.awardedTeamId
          ? { ...team, score: Math.max(0, team.score - (currentClue.awardedPoints ?? currentClue.points)), correctCount: Math.max(0, team.correctCount - 1), completedClues: Math.max(0, team.completedClues - 1) }
          : team),
        clues: current.clues.map((entry) => entry.id === currentClue.id ? {
          ...entry,
          status: "Unanswered",
          awardedTeamId: null,
          awardedPoints: null,
          attemptedTeamIds: [],
          revealedHintCount: 0,
          revealed: false,
        } : entry),
      };
    });
  };

  const resetGame = (destination: "/game" | "/host" = "/host") => {
    setState(createInitialState());
    setConfirmAction(null);
    navigate(destination);
  };

  const finishGame = () => {
    setState((current) => ({ ...current, gameStatus: "finished", timerEndsAt: null, pausedTimeLeft: current.timerDuration, resultStep: 0 }));
    setConfirmAction(null);
    if (!hostPage) navigate("/game");
  };

  useEffect(() => {
    if (!hostSessionActive) return;
    const keyHandler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.key === "Escape") {
        setConfirmAction(null);
        return;
      }
      if (confirmAction || target.closest('[role="dialog"]')) return;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) {
        return;
      }
      if (event.key === " ") {
        event.preventDefault();
        timerStartPause();
      } else if (event.key === "Enter" && selectedClue && selectedTeam) {
        event.preventDefault();
        markCorrect();
      } else if (["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown"].includes(event.key)) {
        const available = state.clues.filter((clue) => clue.status !== "Correct" && clue.status !== "Skipped");
        const index = available.findIndex((clue) => clue.id === state.selectedClueId);
        const next = available[(index + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) + available.length) % available.length];
        if (next) chooseClue(next);
      }
    };
    window.addEventListener("keydown", keyHandler);
    return () => window.removeEventListener("keydown", keyHandler);
  }, [hostSessionActive, state, selectedClue, selectedTeam, confirmAction]);

  const completed = state.clues.filter((clue) => clue.status === "Correct" || clue.status === "Skipped").length;
  const revealed = state.clues.filter((clue) => clue.revealed).length;
  const maxScore = state.clues.reduce((sum, clue) => sum + clue.points, 0);
  const totalPoints = state.teams.reduce((sum, team) => sum + team.score, 0);

  const roomPanelProps: RoomPanelProps = {
    hostPage,
    roomCode,
    status: roomConnection.status,
    connectionError: roomConnection.error,
    actionError: roomActionError,
    creating: creatingRoom,
    onCreateRoom: () => { void createRoom(); },
    onJoinRoom: joinRoom,
    onCopyPlayerLink: () => { void copyPlayerLink(); },
  };

  const pageProps = {
    state, setState, hostPage, navigate, selectedClue, selectedTeam, sortedTeams, grid, seconds,
    chooseClue, timerStartPause, resetTimer, markCorrect, recordIncorrect, passClue, updateClue,
    adjustScore, changeTeamName, addTeam, removeTeam, resetClue, setConfirmAction, finishGame,
    roomPanelProps,
  };

  return (
    <div className="app-shell">
      {hostPage && roomCode && !hostSessionActive
        ? <HostAccessGate state={state} status={roomConnection.status} error={roomConnection.error} navigate={navigate} />
        : hostPage
        ? <HostPage {...pageProps} completed={completed} revealed={revealed} maxScore={maxScore} totalPoints={totalPoints} />
        : <PlayerPage {...pageProps} completed={completed} />}
      {confirmAction && (
        <ConfirmDialog
          action={confirmAction}
          onCancel={() => setConfirmAction(null)}
          onConfirm={() => {
            if (confirmAction === "reset") resetGame("/host");
            if (confirmAction === "reset-game") resetGame("/game");
            if (confirmAction === "finish") finishGame();
            if (confirmAction === "reveal") {
              setState((current) => ({ ...current, clues: current.clues.map((clue) => ({ ...clue, revealed: true })) }));
              setConfirmAction(null);
            }
          }}
        />
      )}
    </div>
  );
}

type SharedProps = {
  state: GameState;
  setState: React.Dispatch<React.SetStateAction<GameState>>;
  hostPage: boolean;
  navigate: (to: "/game" | "/host") => void;
  roomPanelProps: RoomPanelProps;
  selectedClue: Clue | null;
  selectedTeam: Team | null;
  sortedTeams: Team[];
  grid: ReturnType<typeof getGrid>;
  seconds: number;
  chooseClue: (clue: Clue) => void;
  timerStartPause: () => void;
  resetTimer: () => void;
  markCorrect: (teamId?: string | null) => void;
  recordIncorrect: () => void;
  passClue: () => void;
  updateClue: (id: string, updater: (clue: Clue) => Clue) => void;
  adjustScore: (teamId: string, delta: number) => void;
  changeTeamName: (teamId: string, name: string) => void;
  addTeam: () => void;
  removeTeam: (team: Team) => void;
  resetClue: (clue: Clue) => void;
  setConfirmAction: (action: "reset" | "reset-game" | "finish" | "reveal" | null) => void;
  finishGame: () => void;
};

function BrandHeader({ hostPage, navigate, state }: Pick<SharedProps, "hostPage" | "navigate" | "state">) {
  return (
    <header className="masthead">
      <a className="brand-lockup" href="/game" onClick={(event) => { event.preventDefault(); navigate("/game"); }}>
        <span className="brand-kicker">TEAM 4 ENGLISH DAY</span>
        <span className="brand-title">Crossword Clash</span>
        <span className="brand-subtitle">Eco × Commercial English word challenge</span>
      </a>
      <div className="masthead-center">
        <span className="edition-mark">EST. MMXXIV</span>
        <span className="ornament-rule"><i />✦<i /></span>
        <span className="round-chip">ROUND {String(state.currentRound).padStart(2, "0")}</span>
      </div>
      <nav className="view-switch" aria-label="Choose screen">
        <button className={!hostPage ? "active" : ""} onClick={() => navigate("/game")}>Player screen</button>
        <button className={hostPage ? "active" : ""} onClick={() => navigate("/host")}>Host desk</button>
      </nav>
    </header>
  );
}

function HostAccessGate({
  state,
  status,
  error,
  navigate,
}: {
  state: GameState;
  status: RoomConnectionStatus;
  error: string | null;
  navigate: (to: "/game" | "/host") => void;
}) {
  const message = status === "connecting" || status === "reconnecting"
    ? "Verifying this device's Host Desk access…"
    : error ?? "This device does not have Host Desk access for this room.";

  return (
    <main className="host-page host-access-page">
      <BrandHeader hostPage navigate={navigate} state={state} />
      <section className="host-access-message" role={status === "error" ? "alert" : "status"}>
        <span className="eyebrow">LIVE ROOM</span>
        <h1>Host access required</h1>
        <p>{message}</p>
        <p>Open the Host Desk on an authorized device, or return to the Player screen.</p>
        <button className="button-primary" onClick={() => navigate("/game")}>Return to Player screen</button>
      </section>
    </main>
  );
}

function TimeoutPopup({ message, onDismiss }: { message: GameState["message"]; onDismiss: () => void }) {
  if (message?.type !== "timeout") return null;
  return (
    <div className="modal-backdrop timeout-backdrop">
      <section className="confirm-dialog timeout-dialog" role="alertdialog" aria-modal="true" aria-labelledby={`timeout-title-${message.id}`} aria-describedby={`timeout-message-${message.id}`}>
        <span className="timeout-icon">⏱</span>
        <p className="eyebrow">TURN UPDATE</p>
        <h2 id={`timeout-title-${message.id}`}>Time’s up!</h2>
        <p id={`timeout-message-${message.id}`}>{message.text}</p>
        <button className="button-primary" onClick={onDismiss}>Continue</button>
      </section>
    </div>
  );
}

function StatusTag({ status }: { status: ClueStatus }) {
  return <span className={`status-tag status-${status.toLowerCase()}`}>{status}</span>;
}

function Crossword({ state, grid, selectedClue, chooseClue }: Pick<SharedProps, "state" | "grid" | "selectedClue" | "chooseClue">) {
  const activeCellSet = new Set<string>();
  if (selectedClue) {
    for (let index = 0; index < selectedClue.answer.length; index += 1) {
      activeCellSet.add(`${selectedClue.row + (selectedClue.direction === "Down" ? index : 0)},${selectedClue.col + (selectedClue.direction === "Across" ? index : 0)}`);
    }
  }
  return (
    <div className="crossword-paper">
      <div className="grid-heading"><span>THE DAILY PUZZLE</span><span>NO. 001 <b>✦</b></span></div>
      <div className="crossword-grid" role="grid" aria-label="Crossword puzzle">
        {Array.from({ length: GRID_SIZE * GRID_SIZE }, (_, index) => {
          const row = Math.floor(index / GRID_SIZE);
          const col = index % GRID_SIZE;
          const key = `${row},${col}`;
          const cell = grid.get(key);
          if (!cell) return <div key={key} className="grid-cell blocked" role="gridcell" />;
          const across = cell.acrossId ? state.clues.find((clue) => clue.id === cell.acrossId) : undefined;
          const down = cell.downId ? state.clues.find((clue) => clue.id === cell.downId) : undefined;
          const active = activeCellSet.has(key);
          const complete = [across, down].some((clue) => clue?.status === "Correct" || clue?.status === "Skipped");
          const revealedLetter = [across, down].find((clue) => clue?.revealed)?.answer[
            across?.revealed ? col - across.col : down ? row - down.row : 0
          ];
          const clueNumber = cell.clueNumbers[0];
          const activeClue = selectedClue && (selectedClue.id === across?.id || selectedClue.id === down?.id);
          return (
            <button
              key={key}
              className={`grid-cell open ${active ? "highlight" : ""} ${complete ? "complete" : ""} ${activeClue ? "cell-current" : ""}`}
              onClick={() => {
                const clue = selectedClue?.direction === "Down" ? down : across;
                const candidate = clue ?? across ?? down;
                if (candidate) chooseClue(candidate);
              }}
              aria-label={`Row ${row + 1}, column ${col + 1}${revealedLetter ? `, ${revealedLetter}` : ""}`}
              role="gridcell"
            >
              {clueNumber !== undefined && <span className="cell-number">{clueNumber}</span>}
              {revealedLetter && <span className="cell-letter">{revealedLetter}</span>}
            </button>
          );
        })}
      </div>
      <div className="grid-footnote"><span>✦</span> PENCIL IN YOUR BEST GUESS <span>✦</span></div>
    </div>
  );
}

function ClueLists({ state, selectedClue, chooseClue, compact = false }: Pick<SharedProps, "state" | "selectedClue" | "chooseClue"> & { compact?: boolean }) {
  return (
    <div className={`clue-lists ${compact ? "compact" : ""}`}>
      {(["Across", "Down"] as const).map((direction) => (
        <section className="clue-column" key={direction}>
          <h3><span className="direction-icon">{direction === "Across" ? "→" : "↓"}</span>{direction.toUpperCase()}<span className="clue-total">{state.clues.filter((clue) => clue.direction === direction).length} clues</span></h3>
          <div className="clue-items">
            {state.clues.filter((clue) => clue.direction === direction).map((clue) => (
              <button
                key={clue.id}
                className={`clue-item ${selectedClue?.id === clue.id ? "selected" : ""} ${clue.status === "Correct" || clue.status === "Skipped" ? "done" : ""}`}
                onClick={() => chooseClue(clue)}
              >
                <span className="clue-index">{String(clue.number).padStart(2, "0")}</span>
                <span className="clue-copy"><span>Listen to the host.</span>{!compact && <small>{clue.difficulty}</small>}</span>
                <span className="clue-points">{clue.points}<small>PTS</small></span>
                {clue.status === "Correct" || clue.status === "Skipped" ? <span className="clue-check">✓</span> : null}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function Scoreboard({ teams, compact = false }: { teams: Team[]; compact?: boolean }) {
  return (
    <div className={`scoreboard ${compact ? "compact" : ""}`}>
      {orderedTeams(teams).map((team, index, ranked) => {
        const rank = 1 + ranked.filter((candidate) => candidate.score > team.score).length;
        const tied = ranked.filter((candidate) => candidate.score === team.score).length > 1;
        return (
          <div className={`score-row ${index === 0 ? "leader" : ""}`} key={team.id}>
            <span className="rank-number">{String(rank).padStart(2, "0")}{tied ? "=" : ""}</span>
            <span className="score-team">{team.name}<small>{team.correctCount} correct</small></span>
            <strong>{team.score}<small>PTS</small></strong>
          </div>
        );
      })}
    </div>
  );
}

function PlayerPage(props: SharedProps & { completed: number }) {
  const { state, setState, hostPage, navigate, selectedClue, selectedTeam, sortedTeams, grid, seconds, chooseClue, completed } = props;
  const progress = Math.round((completed / state.clues.length) * 100);
  const activeMessage = state.message && state.message.type !== "timeout" && Date.now() - state.message.id < 7000;
  const finalTeams = orderedTeams(state.teams);
  const podiumTeams = finalTeams.filter((team) => teamRank(state.teams, team.id) <= 3);

  if (state.gameStatus === "finished") {
    const revealLevel = state.resultStep;
    return (
      <main className="player-page final-page">
        <BrandHeader hostPage={hostPage} navigate={navigate} state={state} />
          <RoomPanel {...props.roomPanelProps} />
          <section className="final-sheet">
          <div className="final-topline"><span>ENGLISH DAY CHAMPIONSHIP</span><span>FINAL EDITION · ROUND {state.currentRound}</span></div>
          <p className="eyebrow centered">THE PUZZLE IS COMPLETE</p>
          <h1>The Final Results</h1>
          <p className="final-deck">Every letter counted. Every point earned.</p>
          <div className="laurel-line">❧ <span>✦</span> ❧</div>
          <div className="podium">
            {[...podiumTeams].reverse().map((team) => {
              const place = teamRank(state.teams, team.id);
              return <PodiumPlace key={team.id} team={team} place={place} visible={revealLevel >= 4 - place} />;
            })}
          </div>
          {revealLevel >= 3 && <div className="winner-ribbon">CONGRATULATIONS! <span>{podiumTeams.filter((team) => team.score === finalTeams[0]?.score).length > 1 ? "SHARED CROSSWORD CHAMPIONS" : "THE CROSSWORD CHAMPIONS"}</span></div>}
          <div className="final-leaderboard">
            <div className="final-list-heading"><span>FINAL LEADERBOARD</span><span>POINTS · CORRECT</span></div>
            {finalTeams.map((team) => (
              <div className="final-list-row" key={team.id}>
                <span>{teamRank(state.teams, team.id)}{teamRank(state.teams, team.id) === 1 ? "ST" : teamRank(state.teams, team.id) === 2 ? "ND" : teamRank(state.teams, team.id) === 3 ? "RD" : "TH"}</span>
                <strong>{team.name}</strong>
                <b>{team.score} <small>PTS</small></b>
                <small>{team.correctCount} correct</small>
              </div>
            ))}
          </div>
          <div className="final-actions">
            {revealLevel < 3 && <button className="button-primary" onClick={() => setState((current) => ({ ...current, resultStep: current.resultStep + 1 }))}>Reveal next place <span>→</span></button>}
            <button className="button-outline" onClick={() => { setState((current) => ({ ...current, gameStatus: "playing", resultStep: 0 })); navigate("/game"); }}>Back to game</button>
            <button className="button-outline" onClick={() => props.setConfirmAction("reset")}>Start a new game</button>
            <button className="button-outline" onClick={() => props.setConfirmAction("reset-game")}>Reset session</button>
          </div>
          <p className="final-footnote">Crossword Clash · Team 4 English Day</p>
        </section>
      </main>
    );
  }

  return (
    <main className="player-page">
      <BrandHeader hostPage={hostPage} navigate={navigate} state={state} />
      <RoomPanel {...props.roomPanelProps} />
      <div className="player-toolbar">
        <div><span className={`live-dot ${state.gameStatus === "playing" ? "on" : ""}`} />{state.gameStatus === "playing" ? "LIVE GAME" : state.gameStatus === "paused" ? "PAUSED" : "READY WHEN YOU ARE"}</div>
        <div className="toolbar-center">PUZZLE No. 001 <i>✦</i> THE DAILY WORD</div>
        <div>{completed} <span className="muted">/ {state.clues.length} CLUES SOLVED</span></div>
      </div>
      {activeMessage && <div className={`announcement announcement-${state.message?.type}`} key={state.message?.id}>{state.message?.text}</div>}
      <section className="player-layout">
        <div className="puzzle-column">
          <div className="section-heading"><span>01</span><div><h2>The Puzzle</h2><p>Listen carefully as your host reads each clue.</p></div><div className="section-stamp">VOL. I<br />NO. 01</div></div>
          <Crossword state={state} grid={grid} selectedClue={selectedClue} chooseClue={chooseClue} />
          <div className="active-question">
            <div className="question-label"><span className="question-asterisk">✳</span> NOW PLAYING <span className="question-line" /></div>
            {selectedClue ? (
              <div className="question-content">
                <div className="question-count">{selectedClue.number}<span>{selectedClue.direction.toUpperCase()}</span></div>
                <div className="question-text"><p>Listen carefully as your host reads the clue.</p><small>{selectedClue.points} POINTS · {selectedClue.answer.length} LETTERS</small></div>
                <div className="question-turn"><small>ANSWERING TEAM</small><strong>{selectedTeam?.name ?? "Choose a team"}</strong></div>
              </div>
            ) : <p className="empty-question">Your host will select a clue and read it aloud.</p>}
            <div className={`public-timer ${seconds <= 10 ? "urgent" : ""}`}>
              <span className="timer-caption">{state.timerEndsAt ? "TIME LEFT" : "THE CLOCK"}</span>
              <strong>{`${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`}</strong>
              <span className="clock-mark">✦</span>
            </div>
          </div>
        </div>
        <aside className="player-side">
          <section className="side-section">
            <div className="side-title"><h2>Today’s Clues</h2><span>ACROSS & DOWN</span></div>
            <ClueLists state={state} selectedClue={selectedClue} chooseClue={chooseClue} compact />
          </section>
          <section className="side-section leaderboard-section">
            <div className="side-title"><h2>The Scoreboard</h2><span><i className="live-dot" /> LIVE</span></div>
            <Scoreboard teams={sortedTeams} compact />
          </section>
          <div className="editorial-note"><span className="note-star">✳</span><p>“A word well placed is a point well earned.”</p><small>— THE CLUB MOTTO</small></div>
          <div className="progress-stamp"><span>PUZZLE PROGRESS</span><strong>{progress}<small>%</small></strong><div><i style={{ width: `${progress}%` }} /></div></div>
        </aside>
      </section>
      <footer className="page-footer"><span>CROSSWORD CLASH</span><i>✦</i><span>TEAM 4 ENGLISH DAY</span><span className="footer-right">A LITTLE WORDPLAY GOES A LONG WAY</span></footer>
      <TimeoutPopup message={state.message} onDismiss={() => setState((current) => current.message?.type === "timeout" ? { ...current, message: null } : current)} />
    </main>
  );
}

function PodiumPlace({ team, place, visible }: { team?: Team; place: number; visible: boolean }) {
  if (!team) return null;
  return (
    <div className={`podium-entry place-${place} ${visible ? "revealed" : "concealed"}`}>
      <div className="podium-team">
        <span className="medal">{place === 1 ? "✦" : place === 2 ? "✧" : "✤"}</span>
        <strong>{team.name}</strong>
        <span>{team.score} points · {team.correctCount} correct</span>
      </div>
      <div className="podium-block"><b>{place === 1 ? "1ST" : place === 2 ? "2ND" : "3RD"}{team && place === 1 ? " · CHAMPION" : ""}</b></div>
    </div>
  );
}

function HostPage(props: SharedProps & { completed: number; revealed: number; maxScore: number; totalPoints: number }) {
  const {
    state, setState, hostPage, navigate, selectedClue, selectedTeam, sortedTeams, seconds,
    chooseClue, timerStartPause, resetTimer, markCorrect, recordIncorrect, passClue, updateClue,
    adjustScore, changeTeamName, addTeam, removeTeam, resetClue, setConfirmAction,
    completed, revealed, maxScore, totalPoints,
  } = props;
  const [editingClueId, setEditingClueId] = useState<string | null>(null);
  const [draftHints, setDraftHints] = useState<[string, string, string]>(["", "", ""]);
  const [draftAnswer, setDraftAnswer] = useState("");
  const [editError, setEditError] = useState("");
  const editingClue = state.clues.find((clue) => clue.id === editingClueId) ?? null;

  const startEditingClue = (clue: Clue) => {
    setEditingClueId(clue.id);
    setDraftHints(clue.hints);
    setDraftAnswer(clue.answer);
    setEditError("");
  };

  const saveClueEdit = () => {
    if (!editingClue) return;
    const hints = draftHints.map((hint) => hint.trim()) as [string, string, string];
    const answer = draftAnswer.trim().toUpperCase();
    if (hints.some((hint) => !hint) || !/^[A-Z]+$/.test(answer) || answer.length !== editingClue.answer.length) {
      setEditError(`Enter all three clue lines and an answer of exactly ${editingClue.answer.length} letters.`);
      return;
    }
    const candidate = state.clues.map((clue) => clue.id === editingClue.id ? { ...clue, hints, answer } : clue);
    try {
      validatePuzzle(candidate);
    } catch (error) {
      setEditError(error instanceof Error ? error.message : "The answer conflicts with a crossing clue.");
      return;
    }
    setState((current) => ({ ...current, clues: current.clues.map((clue) => clue.id === editingClue.id ? { ...clue, hints, answer, revealedHintCount: 0 } : clue) }));
    setEditingClueId(null);
  };

  const moveClue = (direction: -1 | 1) => {
    const available = state.clues.filter((clue) => clue.status !== "Correct" && clue.status !== "Skipped");
    const index = available.findIndex((clue) => clue.id === state.selectedClueId);
    const next = available[(index + direction + available.length) % available.length];
    if (next) chooseClue(next);
  };

  const toggleGame = () => setState((current) => {
    if (current.gameStatus === "finished") return current;
    if (current.gameStatus === "playing") {
      const left = current.timerEndsAt ? Math.max(0, Math.ceil((current.timerEndsAt - Date.now()) / 1000)) : current.pausedTimeLeft;
      return { ...current, gameStatus: "paused", timerEndsAt: null, pausedTimeLeft: left };
    }
    return { ...current, gameStatus: "playing" };
  });

  return (
    <main className="host-page">
      <BrandHeader hostPage={hostPage} navigate={navigate} state={state} />
      <RoomPanel {...props.roomPanelProps} />
      <div className="host-intro">
        <div><span className="eyebrow">TEAM 4 ENGLISH DAY · HOST CONTROL</span><h1>Host Desk</h1><p>One desk. Every clue. Let the wordplay begin.</p></div>
        <div className="host-intro-tools">
          <div className="keyboard-hint"><span>⌘ LIVE CONTROLS</span><small><kbd>SPACE</kbd> timer <kbd>ENTER</kbd> correct <kbd>←</kbd><kbd>→</kbd> clues</small></div>
          <div className="host-quick-actions">
            <button className="host-start-button" onClick={toggleGame}>{state.gameStatus === "playing" ? "Ⅱ Pause" : state.gameStatus === "paused" ? "▶ Resume" : "▶ Start"}</button>
            <div className="host-round-setting"><button aria-label="Previous round" onClick={() => setState((current) => ({ ...current, currentRound: Math.max(1, current.currentRound - 1) }))}>−</button><span>ROUND {String(state.currentRound).padStart(2, "0")}</span><button aria-label="Next round" onClick={() => setState((current) => ({ ...current, currentRound: current.currentRound + 1 }))}>+</button></div>
            <button className="host-finish-button" onClick={() => setConfirmAction("finish")}>Finish <span>→</span></button>
            <button className="host-reset-button" onClick={() => setConfirmAction("reset")}>Reset session</button>
          </div>
        </div>
      </div>
      <div className="overview-strip">
        <OverviewItem label="CLUES SOLVED" value={`${completed}/${state.clues.length}`} />
        <OverviewItem label="ANSWERS REVEALED" value={`${revealed}/${state.clues.length}`} />
        <OverviewItem label="POINTS AWARDED" value={String(totalPoints)} />
        <OverviewItem label="MAXIMUM SCORE" value={String(maxScore)} />
        <OverviewItem label="ROUND" value={String(state.currentRound).padStart(2, "0")} />
      </div>
      <div className="host-columns">
        <div className="host-main-column">
          <section className="host-card team-card">
            <div className="card-heading"><div><span className="card-index">01 / PLAYERS</span><h2>Teams & Scores</h2></div><button className="small-action" onClick={addTeam}>＋ Add team</button></div>
            <div className="team-table">
              <div className="table-head"><span>TEAM NAME</span><span>SCORE</span><span>RECORD</span><span>ADJUST</span><span /></div>
              {sortedTeams.map((team) => (
                <div className={`team-row ${state.selectedTeamId === team.id ? "current-team" : ""}`} key={team.id}>
                  <div className="team-name-cell"><button className={`team-select-dot ${state.selectedTeamId === team.id ? "selected" : ""}`} aria-label={`Select ${team.name}`} onClick={() => setState((current) => ({ ...current, selectedTeamId: team.id }))} /><input value={team.name} onChange={(event) => changeTeamName(team.id, event.target.value)} aria-label="Team name" /><span className="selected-label">{state.selectedTeamId === team.id ? "UP" : ""}</span></div>
                  <input className="score-edit" type="number" value={team.score} min="0" step="1" aria-label={`${team.name} score`} onChange={(event) => setState((current) => ({ ...current, teams: current.teams.map((entry) => entry.id === team.id ? { ...entry, score: Math.max(0, Math.trunc(Number(event.target.value)) || 0) } : entry) }))} />
                  <span className="record-cell">{team.correctCount}<small>✓</small> / {team.incorrectCount}<small>×</small></span>
                  <div className="score-buttons"><button onClick={() => adjustScore(team.id, 1)}>+1</button><button onClick={() => adjustScore(team.id, 5)}>+5</button><button onClick={() => adjustScore(team.id, -1)}>−1</button></div>
                  <button className="remove-team" title="Remove team" onClick={() => removeTeam(team)} disabled={state.teams.length < 2}>×</button>
                </div>
              ))}
            </div>
          </section>
          <section className="host-card clue-manager">
            <div className="card-heading"><div><span className="card-index">02 / PUZZLE BOOK</span><h2>Clue Management <span className="sub-count">{state.clues.length} TOTAL</span></h2></div><button className="small-action reveal-all" onClick={() => setConfirmAction("reveal")}>Reveal all answers</button></div>
            <div className="clue-manager-head"><span>CLUE</span><span>DIFFICULTY</span><span>POINTS</span><span>STATUS</span><span>ANSWER</span><span /></div>
            <div className="clue-manager-list">
              {state.clues.map((clue) => (
                <div className={`manager-clue-row ${selectedClue?.id === clue.id ? "active" : ""}`} key={clue.id}>
                  <button className="manager-clue" onClick={() => chooseClue(clue)}><b>{String(clue.number).padStart(2, "0")}</b><span>{clue.direction === "Across" ? "→" : "↓"} {clue.hints[0]}</span></button>
                  <select value={clue.difficulty} onChange={(event) => {
                    const difficulty = event.target.value as Difficulty;
                    const value = { Easy: 10, Medium: 20, Hard: 30, Expert: 50 }[difficulty];
                    updateClue(clue.id, (entry) => ({ ...entry, difficulty, points: value }));
                  }} aria-label="Clue difficulty">
                    {(["Easy", "Medium", "Hard", "Expert"] as const).map((difficulty) => <option key={difficulty}>{difficulty}</option>)}
                  </select>
                  <label className="point-input"><input type="number" min="0" step="1" value={clue.points} onChange={(event) => updateClue(clue.id, (entry) => ({ ...entry, points: Math.max(0, Math.trunc(Number(event.target.value)) || 0) }))} /><small>PTS</small></label>
                  <StatusTag status={clue.status} />
                  <button className={`answer-toggle ${clue.revealed ? "visible" : ""}`} onClick={() => updateClue(clue.id, (entry) => ({ ...entry, revealed: !entry.revealed }))}>{clue.revealed ? clue.answer : "Reveal"}</button>
                  <button className="edit-clue" title={clue.status === "Correct" || clue.status === "Skipped" ? "Reset this clue before editing" : "Edit clue text and answer"} disabled={clue.status === "Correct" || clue.status === "Skipped"} onClick={() => startEditingClue(clue)}>Edit</button>
                  <button className="reset-clue" title="Reset clue result" onClick={() => resetClue(clue)} disabled={clue.status === "Unanswered" && !clue.revealed}>↺</button>
                </div>
              ))}
            </div>
          </section>
        </div>
        <aside className="host-side-column">
          <section className="host-card control-card">
            <div className="card-heading"><div><span className="card-index">03 / ON AIR</span><h2>Live Controls</h2></div><span className={`on-air ${state.gameStatus === "playing" ? "live" : ""}`}><i />{state.gameStatus === "playing" ? "LIVE" : state.gameStatus.toUpperCase()}</span></div>
            <div className="active-clue-card">
              <div className="active-clue-top"><span>ACTIVE CLUE</span><span>{selectedClue ? `${selectedClue.number} ${selectedClue.direction.toUpperCase()}` : "—"}</span></div>
              <div className="host-hint-list" aria-live="polite">
                {!selectedClue && <p>Select a clue from the puzzle book.</p>}
                {selectedClue && selectedClue.revealedHintCount === 0 && <p>Reveal each line here, then read it aloud to the players.</p>}
                {selectedClue?.hints.slice(0, selectedClue.revealedHintCount).map((hint, index) => <p key={`${selectedClue.id}-${index}`}><b>{index + 1}.</b> {hint}</p>)}
              </div>
              <button
                className="next-hint-button"
                disabled={!selectedClue || selectedClue.revealedHintCount >= selectedClue.hints.length}
                onClick={() => selectedClue && updateClue(selectedClue.id, (clue) => ({ ...clue, revealedHintCount: Math.min(clue.hints.length, clue.revealedHintCount + 1) }))}
              >
                {!selectedClue ? "Select a clue" : selectedClue.revealedHintCount >= selectedClue.hints.length ? "All three lines shown" : `Show clue line ${selectedClue.revealedHintCount + 1} of 3`}
              </button>
              <div className="active-clue-meta"><span>{selectedClue?.difficulty ?? "—"}</span><b>{selectedClue?.points ?? 0} <small>POINTS</small></b></div>
            </div>
            <label className="field-label">ANSWERING TEAM</label>
            <select className="team-picker" value={state.selectedTeamId ?? ""} onChange={(event) => setState((current) => ({ ...current, selectedTeamId: event.target.value }))}>
              {state.teams.map((team) => <option key={team.id} value={team.id} disabled={Boolean(selectedClue?.attemptedTeamIds.includes(team.id) && !selectedClue.allowRepeatAttempts)}>{team.name}{selectedClue?.attemptedTeamIds.includes(team.id) ? " — already tried" : ""}</option>)}
            </select>
            {selectedClue?.status === "Incorrect" && <div className="steal-box"><strong>STEAL OPPORTUNITY</strong><span>Choose an eligible team; attempted teams are marked on the clue.</span>{selectedClue.attemptedTeamIds.length > 0 && <small>ALREADY TRIED: {state.teams.filter((team) => selectedClue.attemptedTeamIds.includes(team.id)).map((team) => team.name).join(", ")}</small>}<label><input type="checkbox" checked={selectedClue.allowRepeatAttempts} onChange={(event) => updateClue(selectedClue.id, (clue) => ({ ...clue, allowRepeatAttempts: event.target.checked }))} /> Allow a team to try this clue again</label></div>}
            <div className={`host-timer ${seconds <= 10 ? "urgent" : ""}`}><span>TIME REMAINING</span><strong>{`${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`}</strong></div>
            <label className="field-label timer-duration-label">TIMER LENGTH (SECONDS)</label>
            <div className="timer-setting"><input type="number" min="5" max="600" step="1" value={state.timerDuration} onChange={(event) => {
              const duration = Math.min(600, Math.max(5, Math.trunc(Number(event.target.value)) || 30));
              setState((current) => ({ ...current, timerDuration: duration, pausedTimeLeft: duration, timerEndsAt: null }));
            }} /><button onClick={resetTimer}>Reset clock</button></div>
            <div className="clue-navigation"><button onClick={() => moveClue(-1)}>← Previous clue</button><button onClick={() => moveClue(1)}>Next clue →</button></div>
            <button className="timer-button" onClick={timerStartPause}>{state.timerEndsAt ? "Ⅱ  Pause timer" : seconds === 0 ? "↻  Restart timer" : "▶  Start timer"} <kbd>SPACE</kbd></button>
            <div className="answer-actions">
              <button className="correct-button" onClick={() => markCorrect()} disabled={!selectedClue || !selectedTeam || selectedClue.status === "Correct" || selectedClue.status === "Skipped"}>✓ Correct</button>
              <button className="incorrect-button" onClick={recordIncorrect} disabled={!selectedClue || !selectedTeam || selectedClue.status === "Correct" || selectedClue.status === "Skipped"}>× Incorrect</button>
              <button className="pass-button" onClick={passClue} disabled={!selectedClue || selectedClue.status === "Correct" || selectedClue.status === "Skipped"}>Pass / skip</button>
            </div>
          </section>
        </aside>
      </div>
      <footer className="page-footer"><span>CROSSWORD CLASH</span><i>✦</i><span>HOST DESK</span><span className="footer-right">EVERY GREAT GAME STARTS WITH A GOOD CLUE</span></footer>
      <TimeoutPopup message={state.message} onDismiss={() => setState((current) => current.message?.type === "timeout" ? { ...current, message: null } : current)} />
      {editingClue && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditingClueId(null); }} onKeyDown={(event) => { if (event.key === "Escape") setEditingClueId(null); }}>
          <section className="confirm-dialog edit-dialog" role="dialog" aria-modal="true" aria-labelledby="edit-title">
            <span className="dialog-star">✳</span><p className="eyebrow">CLUE {editingClue.number} · {editingClue.direction.toUpperCase()}</p><h2 id="edit-title">Edit this clue</h2>
            <label className="field-label">THREE CLUE LINES · READ ALOUD IN ORDER</label>
            {draftHints.map((hint, index) => (
              <textarea key={index} aria-label={`Clue line ${index + 1}`} placeholder={`Clue line ${index + 1}`} value={hint} onChange={(event) => setDraftHints((current) => current.map((line, lineIndex) => lineIndex === index ? event.target.value : line) as [string, string, string])} />
            ))}
            <label className="field-label">CORRECT ANSWER · {editingClue.answer.length} LETTERS</label><input value={draftAnswer} maxLength={editingClue.answer.length} onChange={(event) => setDraftAnswer(event.target.value.toUpperCase())} />
            {editError && <p className="edit-error" role="alert">{editError}</p>}
            <div><button className="button-outline" onClick={() => setEditingClueId(null)}>Cancel</button><button className="button-primary" onClick={saveClueEdit}>Save clue</button></div>
          </section>
        </div>
      )}
    </main>
  );
}

function OverviewItem({ label, value }: { label: string; value: string }) {
  return <div className="overview-item"><span>{label}</span><strong>{value}</strong></div>;
}

function ConfirmDialog({ action, onCancel, onConfirm }: { action: "reset" | "reset-game" | "finish" | "reveal"; onCancel: () => void; onConfirm: () => void }) {
  const copy = {
    reset: ["Reset this game?", "All scores, clue results, timer settings and revealed answers will return to the opening state."],
    "reset-game": ["Reset this session?", "All scores, clue results, timer settings and revealed answers will return to the opening state."],
    finish: ["Finish the game?", "The timer will stop and the final standings will be presented on the Player Screen."],
    reveal: ["Reveal every answer?", "All crossword answers will become visible to players. This cannot be hidden all at once."],
  }[action];
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <span className="dialog-star">✳</span><p className="eyebrow">A MOMENT, PLEASE</p><h2 id="confirm-title">{copy[0]}</h2><p>{copy[1]}</p>
        <div><button className="button-outline" onClick={onCancel}>Go back</button><button className="button-primary" onClick={onConfirm}>{action === "finish" ? "Finish game" : action === "reveal" ? "Reveal answers" : "Reset session"}</button></div>
      </section>
    </div>
  );
}

export default App;

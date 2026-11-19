import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { selectClue, type GameState } from "./game";

export type RoomConnectionStatus = "offline" | "connecting" | "connected" | "reconnecting" | "error";
export type RoomRole = "host" | "player" | null;

export const hostTokenStorageKey = (roomCode: string) => `crossword-clash-host-token:${roomCode}`;

function isGameState(value: unknown): value is GameState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<GameState>;
  return Array.isArray(state.teams)
    && Array.isArray(state.clues)
    && typeof state.currentRound === "number"
    && typeof state.gameStatus === "string";
}

export function useRoomConnection(
  roomCode: string | null,
  role: RoomRole,
  hostToken: string | null,
  state: GameState,
  setState: Dispatch<SetStateAction<GameState>>,
) {
  const [status, setStatus] = useState<RoomConnectionStatus>("offline");
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!roomCode || !role) {
      setStatus("offline");
      setError(null);
      socketRef.current = null;
      return;
    }

    if (role === "host" && !hostToken) {
      setStatus("error");
      setError("This device does not have Host Desk access for this room.");
      socketRef.current = null;
      return;
    }

    let disposed = false;
    let fatalError = false;
    let retryCount = 0;
    let retryTimer = 0;
    let activeSocket: WebSocket | null = null;

    const connect = () => {
      if (disposed) return;
      setStatus(retryCount === 0 ? "connecting" : "reconnecting");
      setError(null);
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${window.location.host}/api/ws`);
      activeSocket = socket;
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        if (disposed || activeSocket !== socket) return;
        socket.send(JSON.stringify({ type: "join", roomCode, role, token: role === "host" ? hostToken : undefined }));
      });

      socket.addEventListener("message", (event) => {
        if (disposed || activeSocket !== socket) return;
        let message: { type?: unknown; state?: unknown; message?: unknown; clueId?: unknown };
        try {
          message = JSON.parse(String(event.data)) as typeof message;
        } catch (cause) {
          console.error("Could not read a live room update.", cause);
          setStatus("error");
          setError("Received an invalid live room update.");
          fatalError = true;
          socket.close();
          return;
        }

        if (message.type === "joined") {
          retryCount = 0;
          setStatus("connected");
          setError(null);
          return;
        }
        if (message.type === "error") {
          fatalError = true;
          setStatus("error");
          setError(typeof message.message === "string" ? message.message : "The live room could not connect.");
          socket.close();
          return;
        }
        if (message.type === "state" && role === "player") {
          if (!isGameState(message.state)) {
            console.error("Received invalid game state from the live room.");
            setStatus("error");
            setError("Received invalid game state from the host.");
            fatalError = true;
            socket.close();
            return;
          }
          setState(message.state);
        }
        const selectedClueId = message.clueId;
        if (message.type === "clue-selection" && role === "host" && typeof selectedClueId === "string") {
          setState((current) => selectClue(current, selectedClueId));
        }
      });

      socket.addEventListener("close", () => {
        if (socketRef.current === socket) socketRef.current = null;
        if (disposed || fatalError) return;
        const delay = Math.min(1000 * (2 ** retryCount), 15000);
        retryCount += 1;
        setStatus("reconnecting");
        retryTimer = window.setTimeout(connect, delay);
      });

      socket.addEventListener("error", () => socket.close());
    };

    connect();
    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      if (socketRef.current === activeSocket) socketRef.current = null;
      activeSocket?.close();
    };
  }, [roomCode, role, hostToken, setState]);

  useEffect(() => {
    if (role !== "host" || status !== "connected") return;
    const timeout = window.setTimeout(() => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "state", state }));
      }
    }, 100);
    return () => window.clearTimeout(timeout);
  }, [role, state, status]);

  const requestClueSelection = (clueId: string) => {
    if (role !== "player" || status !== "connected") return;
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "select-clue", clueId }));
    }
  };

  return { status, error, requestClueSelection };
}

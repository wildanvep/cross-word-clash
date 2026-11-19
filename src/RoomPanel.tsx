import { useEffect, useState, type FormEvent } from "react";
import type { RoomConnectionStatus } from "./realtime";

export interface RoomPanelProps {
  hostPage: boolean;
  roomCode: string | null;
  status: RoomConnectionStatus;
  connectionError: string | null;
  actionError: string | null;
  creating: boolean;
  onCreateRoom: () => void;
  onJoinRoom: (roomCode: string) => void;
  onCopyPlayerLink: () => void;
}

const statusLabels: Record<RoomConnectionStatus, string> = {
  offline: "LOCAL ONLY",
  connecting: "CONNECTING",
  connected: "LIVE",
  reconnecting: "RECONNECTING",
  error: "NEEDS ATTENTION",
};

function ConnectionBadge({ status }: { status: RoomConnectionStatus }) {
  return <span className={`room-connection ${status}`}><i />{statusLabels[status]}</span>;
}

export default function RoomPanel({
  hostPage,
  roomCode,
  status,
  connectionError,
  actionError,
  creating,
  onCreateRoom,
  onJoinRoom,
  onCopyPlayerLink,
}: RoomPanelProps) {
  const [draftCode, setDraftCode] = useState(roomCode ?? "");

  useEffect(() => setDraftCode(roomCode ?? ""), [roomCode]);

  const join = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onJoinRoom(draftCode);
  };

  return (
    <section className="room-panel" aria-label="Live room">
      {hostPage ? (
        roomCode ? (
          <>
            <div className="room-panel-copy">
              <span className="eyebrow">LIVE ROOM</span>
              <strong>Room {roomCode}</strong>
              <small>Share the player link so another laptop can follow the game.</small>
            </div>
            <ConnectionBadge status={status} />
            <button className="button-primary room-action" onClick={onCopyPlayerLink}>Copy player link</button>
          </>
        ) : (
          <>
            <div className="room-panel-copy">
              <span className="eyebrow">PLAY ACROSS DEVICES</span>
              <strong>Keep every screen in sync</strong>
              <small>Create a live room, then share its player link.</small>
            </div>
            <ConnectionBadge status="offline" />
            <button className="button-primary room-action" onClick={onCreateRoom} disabled={creating}>
              {creating ? "Creating room…" : "Create live room"}
            </button>
          </>
        )
      ) : roomCode ? (
        <>
          <div className="room-panel-copy">
            <span className="eyebrow">PLAYER SCREEN</span>
            <strong>Room {roomCode}</strong>
            <small>Game updates are shared from the Host Desk.</small>
          </div>
          <ConnectionBadge status={status} />
        </>
      ) : (
        <>
          <div className="room-panel-copy">
            <span className="eyebrow">PLAYER SCREEN</span>
            <strong>Join the Host Desk</strong>
            <small>Enter the room code from the host to follow on this device.</small>
          </div>
          <form className="room-join-form" onSubmit={join}>
            <input aria-label="Room code" value={draftCode} onChange={(event) => setDraftCode(event.target.value.toUpperCase())} placeholder="5-CHAR CODE" maxLength={12} autoComplete="off" />
            <button className="button-primary room-action" type="submit">Join room</button>
          </form>
        </>
      )}
      {(connectionError || actionError) && <p className="room-error" role="alert">{connectionError ?? actionError}</p>}
    </section>
  );
}

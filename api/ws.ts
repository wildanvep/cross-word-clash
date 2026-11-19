import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import Redis from "ioredis";
import { WebSocket, WebSocketServer, type RawData } from "ws";

const ROOM_TTL_SECONDS = 12 * 60 * 60;
const MAX_MESSAGE_BYTES = 128 * 1024;
const PLAYER_STATE_POLL_MS = 1000;
const EVENT_CHANNEL = "crossword-clash:room-events";
const redisUrl = process.env.REDIS_URL;
const redis = redisUrl ? new Redis(redisUrl, {
  commandTimeout: 10_000,
  connectTimeout: 5_000,
  maxRetriesPerRequest: 1,
}) : null;
const subscriber = redis?.duplicate();

redis?.on("error", (error) => console.error("Crossword Clash Redis connection failed.", error));
subscriber?.on("error", (error) => console.error("Crossword Clash Redis subscriber failed.", error));

let subscriberReady: Promise<boolean> | null = null;

function ensureSubscriberReady(): Promise<boolean> {
  if (!subscriber) return Promise.resolve(false);
  if (!subscriberReady) {
    subscriberReady = subscriber.subscribe(EVENT_CHANNEL).then(() => true).catch((error: unknown) => {
      console.error("Could not subscribe to Crossword Clash room updates.", error);
      subscriberReady = null;
      return false;
    });
  }
  return subscriberReady;
}

interface RoomSocket {
  roomCode: string;
  role: "host" | "player";
}

interface ClientMessage {
  type?: unknown;
  roomCode?: unknown;
  role?: unknown;
  token?: unknown;
  state?: unknown;
}

const roomSockets = new Map<string, Set<WebSocket>>();
const socketRooms = new WeakMap<WebSocket, RoomSocket>();
const socketStatePollers = new WeakMap<WebSocket, ReturnType<typeof setInterval>>();
const lastSentStates = new WeakMap<WebSocket, string>();

function authKey(roomCode: string): string {
  return `crossword-clash:room:${roomCode}:auth`;
}

function stateKey(roomCode: string): string {
  return `crossword-clash:room:${roomCode}:state`;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function tokenMatches(token: string, expectedHash: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !/^[a-f0-9]{64}$/.test(expectedHash)) return false;
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return timingSafeEqual(actual, expected);
}

function send(socket: WebSocket, message: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(message));
}

function isGameState(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return Array.isArray(state.teams)
    && Array.isArray(state.clues)
    && typeof state.currentRound === "number"
    && typeof state.gameStatus === "string";
}

function sendPlayerState(socket: WebSocket, state: unknown): void {
  if (!isGameState(state)) return;
  const serializedState = JSON.stringify(state);
  if (lastSentStates.get(socket) === serializedState) return;
  lastSentStates.set(socket, serializedState);
  send(socket, { type: "state", state });
}

function broadcastState(roomCode: string, state: unknown): void {
  for (const socket of roomSockets.get(roomCode) ?? []) {
    if (socketRooms.get(socket)?.role === "player") sendPlayerState(socket, state);
  }
}

function startPlayerStatePolling(socket: WebSocket, roomCode: string): void {
  const client = redis;
  if (!client) return;
  let polling = false;
  let failureReported = false;
  const poller = setInterval(() => {
    if (polling || socket.readyState !== WebSocket.OPEN) return;
    polling = true;
    void client.get(stateKey(roomCode)).then((savedState) => {
      failureReported = false;
      if (!savedState) return;
      try {
        const state: unknown = JSON.parse(savedState);
        sendPlayerState(socket, state);
      } catch (error) {
        console.error("Could not read the saved Crossword Clash room state.", error);
      }
    }).catch((error: unknown) => {
      if (!failureReported) console.error("Could not poll the Crossword Clash room state.", error);
      failureReported = true;
    }).finally(() => {
      polling = false;
    });
  }, PLAYER_STATE_POLL_MS);
  socketStatePollers.set(socket, poller);
}

subscriber?.on("message", (_channel, rawMessage) => {
  try {
    const message = JSON.parse(rawMessage) as { roomCode?: unknown; state?: unknown };
    if (typeof message.roomCode !== "string" || !isGameState(message.state)) return;
    broadcastState(message.roomCode, message.state);
  } catch (error) {
    console.error("Could not relay a Crossword Clash room update.", error);
  }
});

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function createRoom(response: ServerResponse): Promise<void> {
  if (!redis) {
    sendJson(response, 503, { error: "Live rooms are not configured. Add REDIS_URL to the Vercel project environment." });
    return;
  }

  try {
    const token = randomBytes(32).toString("base64url");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const roomCode = randomBytes(6).toString("hex").toUpperCase();
      const result = await redis.set(authKey(roomCode), hashToken(token), "EX", ROOM_TTL_SECONDS, "NX");
      if (result === "OK") {
        sendJson(response, 201, { roomCode, token });
        return;
      }
    }
    sendJson(response, 503, { error: "Could not create a room. Please try again." });
  } catch (error) {
    console.error("Could not create a Crossword Clash room.", error);
    sendJson(response, 503, { error: "Could not connect to Redis. Verify REDIS_URL for Production and redeploy." });
  }
}

const server = createServer((request, response) => {
  if (request.method === "POST") {
    void createRoom(response);
    return;
  }
  sendJson(response, 426, { error: "Connect to this endpoint with a WebSocket." });
});

const webSocketServer = new WebSocketServer({ server, maxPayload: MAX_MESSAGE_BYTES });

async function handleMessage(socket: WebSocket, rawMessage: RawData): Promise<void> {
  const messageBuffer = Buffer.isBuffer(rawMessage)
    ? rawMessage
    : Array.isArray(rawMessage)
      ? Buffer.concat(rawMessage)
      : Buffer.from(rawMessage);
  if (messageBuffer.byteLength > MAX_MESSAGE_BYTES) {
    send(socket, { type: "error", message: "That update is too large." });
    socket.close(1009, "Message too large");
    return;
  }

  let message: ClientMessage;
  try {
    message = JSON.parse(messageBuffer.toString()) as ClientMessage;
  } catch {
    send(socket, { type: "error", message: "The live room received an invalid message." });
    return;
  }

  const joined = socketRooms.get(socket);
  if (!joined) {
    if (message.type !== "join" || typeof message.roomCode !== "string" || !/^[A-F0-9]{12}$/i.test(message.roomCode)) {
      send(socket, { type: "error", message: "Enter a valid room code to join." });
      socket.close(1008, "Invalid room");
      return;
    }
    if (message.role !== "host" && message.role !== "player") {
      send(socket, { type: "error", message: "This room role is not supported." });
      socket.close(1008, "Invalid role");
      return;
    }
    if (!redis) {
      send(socket, { type: "error", message: "Could not connect to live room updates. Please retry in a moment." });
      socket.close(1011, "Room service unavailable");
      return;
    }
    void ensureSubscriberReady();

    const roomCode = message.roomCode.toUpperCase();
    try {
      const expectedHash = await redis.get(authKey(roomCode));
      if (!expectedHash) {
        send(socket, { type: "error", message: "That room was not found or has expired." });
        socket.close(1008, "Room not found");
        return;
      }
      await redis.expire(authKey(roomCode), ROOM_TTL_SECONDS);
      await redis.expire(stateKey(roomCode), ROOM_TTL_SECONDS);
      if (message.role === "host"
        && (typeof message.token !== "string" || !tokenMatches(message.token, expectedHash))) {
        send(socket, { type: "error", message: "This device does not have Host Desk access for that room." });
        socket.close(1008, "Host access denied");
        return;
      }

      const room: RoomSocket = { roomCode, role: message.role };
      socketRooms.set(socket, room);
      const sockets = roomSockets.get(roomCode) ?? new Set<WebSocket>();
      sockets.add(socket);
      roomSockets.set(roomCode, sockets);
      send(socket, { type: "joined", roomCode });

      const savedState = await redis.get(stateKey(roomCode));
      if (savedState) {
        const state: unknown = JSON.parse(savedState);
        sendPlayerState(socket, state);
      }
      if (message.role === "player") startPlayerStatePolling(socket, roomCode);
      return;
    } catch (error) {
      console.error("Could not join a Crossword Clash room.", error);
      send(socket, { type: "error", message: "Could not join the room. Please reconnect." });
      socket.close(1011, "Room connection failed");
      return;
    }
  }

  if (message.type !== "state" || joined.role !== "host" || !isGameState(message.state)) return;
  if (!redis) {
    send(socket, { type: "error", message: "The live room service is temporarily unavailable." });
    return;
  }

  try {
    const serializedState = JSON.stringify(message.state);
    await redis.set(stateKey(joined.roomCode), serializedState, "EX", ROOM_TTL_SECONDS);
    await redis.expire(authKey(joined.roomCode), ROOM_TTL_SECONDS);
    await redis.publish(EVENT_CHANNEL, JSON.stringify({ roomCode: joined.roomCode, state: message.state }));
  } catch (error) {
    console.error("Could not save a Crossword Clash room update.", error);
    send(socket, { type: "error", message: "Could not save the latest game update." });
  }
}

webSocketServer.on("connection", (socket, request: IncomingMessage) => {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) {
        socket.close(1008, "Origin not allowed");
        return;
      }
    } catch {
      socket.close(1008, "Origin not allowed");
      return;
    }
  }

  socket.on("message", (message) => {
    void handleMessage(socket, message).catch((error: unknown) => {
      console.error("Unexpected Crossword Clash WebSocket error.", error);
      send(socket, { type: "error", message: "The live room encountered an unexpected error." });
      socket.close(1011, "Internal error");
    });
  });

  const removeSocket = () => {
    const poller = socketStatePollers.get(socket);
    if (poller) clearInterval(poller);
    socketStatePollers.delete(socket);
    lastSentStates.delete(socket);
    const room = socketRooms.get(socket);
    if (!room) return;
    const sockets = roomSockets.get(room.roomCode);
    sockets?.delete(socket);
    if (sockets?.size === 0) roomSockets.delete(room.roomCode);
    socketRooms.delete(socket);
  };
  socket.on("close", removeSocket);
  socket.on("error", removeSocket);
});

export default server;

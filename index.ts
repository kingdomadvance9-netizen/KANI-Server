import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import { prisma } from "./prisma";
import { createMediaRouter, mediaRouter } from "./mediasoup/router";
import {
  getOrCreateRoom,
  createWebRtcTransport,
  removePeerFromRoom,
} from "./mediasoup/rooms";
import mpesaRoutes from "./mpesa/mpesa.routes";
import {
  checkPermission,
  checkRateLimit,
  auditLog,
  getGlobalActionTargets,
  isExemptFromGlobalControls,
  canUnmute,
  canStartScreenShare,
} from "./permissions";

const app = express();
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get("/", (req, res) => {
  res.json({
    status: "online",
    message: "KANI Server - WebRTC Video Conferencing API",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
    endpoints: {
      socket: "ws://161.97.67.188:8080 (Socket.IO)",
      mpesa: "/api/mpesa",
      debug: "/debug/room/:roomId"
    },
    documentation: "See README.md for full API documentation"
  });
});

// M-Pesa API routes
app.use("/api/mpesa", mpesaRoutes);

// Debug endpoint to inspect room state
app.get("/debug/room/:roomId", async (req, res) => {
  try {
    const { roomId } = req.params;
    const { getRoom } = require("./mediasoup/rooms");
    const room = getRoom(roomId);

    if (!room) {
      return res.json({ error: "Room not found", roomId });
    }

    const peers: any[] = [];
    room.peers.forEach((peer: any, peerId: string) => {
      peers.push({
        peerId,
        name: peer.name,
        isHost: peer.isHost,
        transports: Array.from(peer.transports.values()).map((t: any) => ({
          id: t.id,
          direction: t.appData.direction,
          iceState: t.iceState,
          dtlsState: t.dtlsState,
          closed: t.closed,
        })),
        producers: Array.from(peer.producers.values()).map((p: any) => ({
          id: p.id,
          kind: p.kind,
          paused: p.paused,
          closed: p.closed,
        })),
        consumers: Array.from(peer.consumers.values()).map((c: any) => ({
          id: c.id,
          kind: c.kind,
          producerId: c.producerId,
          paused: c.paused,
          closed: c.closed,
        })),
      });
    });

    res.json({
      roomId,
      routerClosed: room.router.closed,
      peerCount: room.peers.size,
      peers,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

// Recording state
const recordings = new Map<string, { startTime: number }>();

(async () => {
  try {
    await createMediaRouter();
  } catch (err) {
    console.error("🛑 Mediasoup Bootstrap Failed:", err);
  }
})();

io.on("connection", (socket) => {
  console.log("✅ user connected:", socket.id);

  // Store userId in socket data when provided
  socket.on("set-user-id", (userId: string) => {
    (socket as any).data = { ...((socket as any).data || {}), userId };
    console.log(`🆔 Socket ${socket.id} mapped to user ${userId}`);
  });

  /* =========================
     CHAT
  ========================= */

  socket.on(
    "join-room",
    async ({ roomId, userId, userName, userImageUrl }: any) => {
      console.log("📥 join-room received:", {
        roomId,
        userId,
        userName,
        userImageUrl,
      });

      // Validate required fields
      if (!roomId || !userId || !userName) {
        console.error("❌ Missing required fields for join-room");
        socket.emit("error", {
          message:
            "Missing required fields: roomId, userId, and userName are required",
        });
        return;
      }

      socket.join(roomId);

      try {
        // Check if room exists, if not create it
        let room = await prisma.room.findUnique({ where: { id: roomId } });

        if (!room) {
          room = await prisma.room.create({
            data: {
              id: roomId,
              creatorId: userId,
            },
          });
          console.log(`🏠 Created new room ${roomId} with creator ${userId}`);
        }

        // Check if user is already a participant
        let participant = await prisma.roomParticipant.findUnique({
          where: {
            roomId_userId: {
              roomId,
              userId,
            },
          },
        });

        // If not, create participant entry
        if (!participant) {
          const role = userId === room.creatorId ? "HOST" : "PARTICIPANT";
          participant = await prisma.roomParticipant.create({
            data: {
              roomId,
              userId,
              name: userName,
              imageUrl: userImageUrl,
              role,
            },
          });
          console.log(`✅ ${userName} joined as ${role} (NEW)`);
        } else {
          // Update existing participant info (in case name or image changed)
          participant = await prisma.roomParticipant.update({
            where: {
              roomId_userId: {
                roomId,
                userId,
              },
            },
            data: {
              name: userName,
              imageUrl: userImageUrl,
            },
          });
          console.log(`♻️ ${userName} rejoined (EXISTING)`);
        }

        // ✅ Create or update in-memory peer with host status
        const mediasoupRoom = await getOrCreateRoom(roomId);
        const peer = {
          socketId: socket.id,
          userId: userId,
          name: userName,
          imageUrl: userImageUrl,
          isHost: participant.role === "HOST",
          isCoHost: participant.role === "COHOST",
          producers: new Map(),
          consumers: new Map(),
          transports: new Map(),
        };

        mediasoupRoom.peers.set(socket.id, peer);

        console.log(`👤 Peer added to room.peers:`, {
          socketId: socket.id,
          userId,
          name: userName,
          role: participant.role,
          isHost: peer.isHost,
          isCoHost: peer.isCoHost,
        });

        // Fetch all active participants
        const participants = await prisma.roomParticipant.findMany({
          where: { roomId },
        });

        console.log(
          `📋 Room ${roomId} has ${participants.length} participants`
        );

        // Broadcast participant list to all in room
        io.to(roomId).emit(
          "participant-list-update",
          participants.map((p) => ({
            id: p.userId,
            name: p.name,
            imageUrl: p.imageUrl,
            isAudioMuted: p.isAudioMuted,
            isVideoPaused: p.isVideoPaused,
            isHost: p.role === "HOST",
            isCoHost: p.role === "COHOST",
            audioLocked: p.audioLocked ?? false,
            screenShareLocked: p.screenShareLocked ?? false,
          }))
        );

        // Send chat history (last 150 messages to prevent memory issues)
        const history = await prisma.message.findMany({
          where: { roomId },
          orderBy: { createdAt: "desc" },
          take: 150,
          include: {
            reactions: true,
            replyTo: {
              select: {
                id: true,
                text: true,
                senderName: true,
              },
            },
          },
        });

        // Reverse to get chronological order (oldest first)
        const chronologicalHistory = history.reverse();

        socket.emit(
          "chat-history",
          chronologicalHistory.map((msg: any) => ({
            socketId: "system",
            message: {
              id: msg.id,
              text: msg.text,
              createdAt: msg.createdAt.getTime(),
              sender: {
                id: msg.senderId,
                name: msg.senderName,
                avatarUrl: msg.senderAvatar,
              },
              pinned: msg.pinned,
              replyTo: msg.replyTo
                ? {
                    id: msg.replyTo.id,
                    text: msg.replyTo.text,
                    senderName: msg.replyTo.senderName,
                  }
                : undefined,
              reactions: msg.reactions.reduce((acc: any, r: any) => {
                acc[r.emoji] ??= [];
                acc[r.emoji].push(r.userId);
                return acc;
              }, {}),
            },
          }))
        );

        console.log(
          `💬 Sent ${chronologicalHistory.length} chat messages to ${userName}`
        );
      } catch (err) {
        console.error("Error in join-room:", err);
        socket.emit("chat-history", []);
      }
    }
  );

  /* =========================
     EXPLICIT CHAT HISTORY REQUEST
     (For late joins, refreshes, or when initial join-room was missed)
  ========================= */

  socket.on("request-chat-history", async ({ roomId }: { roomId: string }) => {
    try {
      console.log(`💬 Explicit chat history request for room ${roomId}`);

      if (!roomId) {
        console.error("❌ No roomId provided for chat history request");
        socket.emit("chat-history", []);
        return;
      }

      // Fetch last 150 messages
      const history = await prisma.message.findMany({
        where: { roomId },
        orderBy: { createdAt: "desc" },
        take: 150,
        include: {
          reactions: true,
          replyTo: {
            select: {
              id: true,
              text: true,
              senderName: true,
            },
          },
        },
      });

      // Reverse to get chronological order (oldest first)
      const chronologicalHistory = history.reverse();

      socket.emit(
        "chat-history",
        chronologicalHistory.map((msg: any) => ({
          socketId: "system",
          message: {
            id: msg.id,
            text: msg.text,
            createdAt: msg.createdAt.getTime(),
            sender: {
              id: msg.senderId,
              name: msg.senderName,
              avatarUrl: msg.senderAvatar,
            },
            pinned: msg.pinned,
            replyTo: msg.replyTo
              ? {
                  id: msg.replyTo.id,
                  text: msg.replyTo.text,
                  senderName: msg.replyTo.senderName,
                }
              : undefined,
            reactions: msg.reactions.reduce((acc: any, r: any) => {
              acc[r.emoji] ??= [];
              acc[r.emoji].push(r.userId);
              return acc;
            }, {}),
          },
        }))
      );

      console.log(
        `✅ Sent ${chronologicalHistory.length} chat messages via explicit request`
      );
    } catch (err) {
      console.error("Error fetching chat history:", err);
      socket.emit("chat-history", []);
    }
  });

  socket.on("send-message", async ({ roomId, message }) => {
    try {
      // Save to database FIRST to ensure persistence
      await prisma.message.create({
        data: {
          id: message.id,
          roomId,
          text: message.text,
          senderId: message.sender.id,
          senderName: message.sender.name,
          senderAvatar: message.sender.avatarUrl,
          createdAt: new Date(message.createdAt),
          replyToId: message.replyTo?.id,
        },
      });

      // Broadcast to room AFTER successful save
      io.to(roomId).emit("receive-message", {
        socketId: socket.id,
        message,
      });

      console.log(`💬 Message saved and broadcast in room ${roomId}`);
    } catch (error) {
      console.error("❌ Failed to save message:", error);

      // Notify sender of failure
      socket.emit("message-error", {
        messageId: message.id,
        error: "Failed to save message. Please try again.",
      });
    }
  });

  /* =========================
     CHAT TYPING INDICATORS
  ========================= */

  socket.on("typing-start", ({ roomId, name }) => {
    socket.to(roomId).emit("typing-start", {
      socketId: socket.id,
      name,
    });
  });

  socket.on("typing-stop", ({ roomId }) => {
    socket.to(roomId).emit("typing-stop", {
      socketId: socket.id,
    });
  });

  /* =========================
     CHAT MESSAGE REACTIONS
  ========================= */

  socket.on("message-react", async ({ roomId, messageId, emoji, userId }) => {
    try {
      // Check if reaction already exists
      const existing = await prisma.reaction.findUnique({
        where: {
          messageId_userId: {
            messageId,
            userId,
          },
        },
      });

      if (existing) {
        // Update to new emoji if different, or remove if same
        if (existing.emoji === emoji) {
          await prisma.reaction.delete({
            where: { id: existing.id },
          });
          io.to(roomId).emit("message-react-update", {
            messageId,
            userId,
            emoji,
            action: "removed",
          });
        } else {
          await prisma.reaction.update({
            where: { id: existing.id },
            data: { emoji },
          });
          io.to(roomId).emit("message-react-update", {
            messageId,
            userId,
            emoji,
            action: "updated",
          });
        }
      } else {
        // Create new reaction
        await prisma.reaction.create({
          data: {
            messageId,
            userId,
            emoji,
          },
        });
        io.to(roomId).emit("message-react-update", {
          messageId,
          userId,
          emoji,
          action: "added",
        });
      }
    } catch (err) {
      console.error("Error in message-react:", err);
    }
  });

  /* =========================
     PIN MESSAGE
  ========================= */

  socket.on("pin-message", async ({ roomId, messageId, pinned }) => {
    try {
      // Unpin all other messages in this room first
      await prisma.message.updateMany({
        where: { roomId },
        data: { pinned: false },
      });

      // Pin/unpin the target message
      await prisma.message.update({
        where: { id: messageId },
        data: { pinned },
      });

      // Broadcast to all participants
      io.to(roomId).emit("pin-message-update", {
        messageId,
        pinned,
      });
    } catch (err) {
      console.error("Error in pin-message:", err);
    }
  });

  /* =========================
     VIDEO CALL REACTIONS (Synchronized Floating Particles)
  ========================= */

  socket.on("video-reaction", ({ roomId, emoji, sessionId, userId, userName }) => {
    console.log(`🎉 Video reaction from ${userName}:`, { emoji, sessionId });

    // Broadcast to all OTHER participants in the room
    socket.to(roomId).emit("receive-video-reaction", {
      emoji,
      sessionId,
      userId,
      userName,
    });
  });

  /* =========================
     PARTICIPANT STATE SYNC
  ========================= */

  socket.on(
    "update-my-state",
    async ({ roomId, userId, isAudioMuted, isVideoPaused }: any) => {
      try {
        if (!roomId || !userId) {
          console.error("❌ Missing roomId or userId in update-my-state:", {
            roomId,
            userId,
            isAudioMuted,
            isVideoPaused,
            socketId: socket.id,
          });
          return;
        }

        console.log(`🔄 State update from ${userId}:`, {
          isAudioMuted,
          isVideoPaused,
        });

        // Build update data object with only defined values
        const updateData: any = {};
        if (isAudioMuted !== undefined && isAudioMuted !== null) {
          updateData.isAudioMuted = isAudioMuted;
        }
        if (isVideoPaused !== undefined && isVideoPaused !== null) {
          updateData.isVideoPaused = isVideoPaused;
        }

        // Only update if there's data to update
        if (Object.keys(updateData).length > 0) {
          await prisma.roomParticipant.update({
            where: {
              roomId_userId: {
                roomId,
                userId,
              },
            },
            data: updateData,
          });

          // Broadcast to all OTHER participants in the room
          socket.to(roomId).emit("participant-state-changed", {
            userId,
            isAudioMuted,
            isVideoPaused,
          });

          console.log(`✅ State broadcast to room ${roomId}:`, {
            userId,
            isAudioMuted,
            isVideoPaused,
          });
        }
      } catch (err) {
        console.error("Error in update-my-state:", err);
      }
    }
  );

  /* =========================
     ROOM CONTROLS (HOST ONLY)
  ========================= */

  socket.on("mute-all-participants", async ({ roomId, userId }: any) => {
    try {
      // 1. Rate limiting
      if (!checkRateLimit(userId)) {
        await auditLog({
          action: "GLOBAL_MUTE",
          actor: userId,
          roomId,
          result: "DENIED",
          reason: "RATE_LIMIT_EXCEEDED",
          timestamp: new Date(),
        });
        return;
      }

      // 2. Permission check
      const permissionResult = await checkPermission(userId, roomId, "GLOBAL_MUTE");

      if (!permissionResult.allowed) {
        if (permissionResult.shouldAuditLog) {
          await auditLog({
            action: "GLOBAL_MUTE",
            actor: userId,
            roomId,
            result: "DENIED",
            reason: permissionResult.reason || "UNAUTHORIZED",
            timestamp: new Date(),
          });
        }
        console.log(`❌ ${userId} unauthorized for global mute: ${permissionResult.reason}`);
        return;
      }

      // 3. Get requester info
      const requester = await prisma.roomParticipant.findUnique({
        where: { roomId_userId: { roomId, userId } },
      });

      if (!requester) return;

      // 4. Get only PARTICIPANTS (not hosts or co-hosts) 🔥 CRITICAL FIX
      const participants = await getGlobalActionTargets(roomId);

      // 5. Update database - ONLY participants, set audioLocked = true
      await prisma.roomParticipant.updateMany({
        where: {
          roomId,
          role: "PARTICIPANT", // 🔥 Only target participants
        },
        data: {
          isAudioMuted: true,
          audioLocked: true, // 🔒 Lock so they cannot unmute themselves
        },
      });

      // 6. Get active sockets
      const targetSockets = await io.in(roomId).fetchSockets();

      // 7. Emit force-mute to each PARTICIPANT only
      for (const participant of participants) {
        const targetSocket = targetSockets.find(
          (s: any) => s.data?.userId === participant.userId
        );

        if (targetSocket) {
          targetSocket.emit("force-mute", {
            audio: true,
            by: requester.name,
            locked: true,
          });
        }
      }

      // 8. Send updated participant list to all (more efficient than individual state-changed events)
      const allParticipants = await prisma.roomParticipant.findMany({
        where: { roomId },
      });
      io.to(roomId).emit(
        "participant-list-update",
        allParticipants.map((p) => ({
          id: p.userId,
          name: p.name,
          imageUrl: p.imageUrl,
          isAudioMuted: p.isAudioMuted,
          isVideoPaused: p.isVideoPaused,
          isHost: p.role === "HOST",
          isCoHost: p.role === "COHOST",
          audioLocked: p.audioLocked ?? false,
          screenShareLocked: p.screenShareLocked ?? false,
        }))
      );

      // 9. Audit log success
      await auditLog({
        action: "GLOBAL_MUTE",
        actor: userId,
        roomId,
        result: "ALLOWED",
        timestamp: new Date(),
      });

      console.log(`🔇 ${requester.name} (${requester.role}) muted all PARTICIPANTS in room ${roomId}`);
    } catch (err) {
      console.error("Error in mute-all-participants:", err);
    }
  });

  socket.on("unmute-all-participants", async ({ roomId, userId }: any) => {
    try {
      // 1. Rate limiting
      if (!checkRateLimit(userId)) {
        await auditLog({
          action: "GLOBAL_UNMUTE",
          actor: userId,
          roomId,
          result: "DENIED",
          reason: "RATE_LIMIT_EXCEEDED",
          timestamp: new Date(),
        });
        return;
      }

      // 2. Permission check
      const permissionResult = await checkPermission(userId, roomId, "GLOBAL_UNMUTE");

      if (!permissionResult.allowed) {
        if (permissionResult.shouldAuditLog) {
          await auditLog({
            action: "GLOBAL_UNMUTE",
            actor: userId,
            roomId,
            result: "DENIED",
            reason: permissionResult.reason || "UNAUTHORIZED",
            timestamp: new Date(),
          });
        }
        console.log(`❌ ${userId} unauthorized for global unmute: ${permissionResult.reason}`);
        return;
      }

      // 3. Get requester info
      const requester = await prisma.roomParticipant.findUnique({
        where: { roomId_userId: { roomId, userId } },
      });

      if (!requester) return;

      // 4. Get only PARTICIPANTS (not hosts or co-hosts)
      const participants = await getGlobalActionTargets(roomId);

      // 5. Update database - ONLY participants, clear audioLocked
      await prisma.roomParticipant.updateMany({
        where: {
          roomId,
          role: "PARTICIPANT",
        },
        data: {
          isAudioMuted: false,
          audioLocked: false, // 🔓 Unlock so they can control their audio
        },
      });

      // 6. Get active sockets
      const targetSockets = await io.in(roomId).fetchSockets();

      // 7. Emit allow-unmute to each PARTICIPANT only
      for (const participant of participants) {
        const targetSocket = targetSockets.find(
          (s: any) => s.data?.userId === participant.userId
        );

        if (targetSocket) {
          targetSocket.emit("allow-unmute", {
            by: requester.name,
            locked: false,
          });
        }
      }

      // 8. Send updated participant list to all
      const allParticipants = await prisma.roomParticipant.findMany({
        where: { roomId },
      });
      io.to(roomId).emit(
        "participant-list-update",
        allParticipants.map((p) => ({
          id: p.userId,
          name: p.name,
          imageUrl: p.imageUrl,
          isAudioMuted: p.isAudioMuted,
          isVideoPaused: p.isVideoPaused,
          isHost: p.role === "HOST",
          isCoHost: p.role === "COHOST",
          audioLocked: p.audioLocked ?? false,
          screenShareLocked: p.screenShareLocked ?? false,
        }))
      );

      // 9. Audit log success
      await auditLog({
        action: "GLOBAL_UNMUTE",
        actor: userId,
        roomId,
        result: "ALLOWED",
        timestamp: new Date(),
      });

      console.log(`🔊 ${requester.name} (${requester.role}) unmuted all PARTICIPANTS in room ${roomId}`);
    } catch (err) {
      console.error("Error in unmute-all-participants:", err);
    }
  });

  socket.on("disable-all-cameras", async ({ roomId, userId }: any) => {
    try {
      // 1. Rate limiting
      if (!checkRateLimit(userId)) {
        await auditLog({
          action: "GLOBAL_CAMERA_DISABLE",
          actor: userId,
          roomId,
          result: "DENIED",
          reason: "RATE_LIMIT_EXCEEDED",
          timestamp: new Date(),
        });
        return;
      }

      // 2. Permission check
      const permissionResult = await checkPermission(userId, roomId, "GLOBAL_CAMERA_DISABLE");

      if (!permissionResult.allowed) {
        if (permissionResult.shouldAuditLog) {
          await auditLog({
            action: "GLOBAL_CAMERA_DISABLE",
            actor: userId,
            roomId,
            result: "DENIED",
            reason: permissionResult.reason || "UNAUTHORIZED",
            timestamp: new Date(),
          });
        }
        console.log(`❌ ${userId} unauthorized for global camera disable: ${permissionResult.reason}`);
        return;
      }

      // 3. Get requester info
      const requester = await prisma.roomParticipant.findUnique({
        where: { roomId_userId: { roomId, userId } },
      });

      if (!requester) return;

      // 4. Get only PARTICIPANTS (not hosts or co-hosts)
      const participants = await getGlobalActionTargets(roomId);

      // 5. Update database - ONLY participants, set screenShareLocked
      await prisma.roomParticipant.updateMany({
        where: {
          roomId,
          role: "PARTICIPANT",
        },
        data: {
          isVideoPaused: true,
          screenShareLocked: true, // Lock screen share when disabling cameras
        },
      });

      // 6. Get active sockets
      const targetSockets = await io.in(roomId).fetchSockets();

      // 7. Emit force-video-pause to each PARTICIPANT only
      for (const participant of participants) {
        const targetSocket = targetSockets.find(
          (s: any) => s.data?.userId === participant.userId
        );

        if (targetSocket) {
          targetSocket.emit("force-video-pause", {
            video: true,
            by: requester.name,
          });
        }
      }

      // 8. Send updated participant list to all
      const allParticipants = await prisma.roomParticipant.findMany({
        where: { roomId },
      });
      io.to(roomId).emit(
        "participant-list-update",
        allParticipants.map((p) => ({
          id: p.userId,
          name: p.name,
          imageUrl: p.imageUrl,
          isAudioMuted: p.isAudioMuted,
          isVideoPaused: p.isVideoPaused,
          isHost: p.role === "HOST",
          isCoHost: p.role === "COHOST",
          audioLocked: p.audioLocked ?? false,
          screenShareLocked: p.screenShareLocked ?? false,
        }))
      );

      // 9. Audit log success
      await auditLog({
        action: "GLOBAL_CAMERA_DISABLE",
        actor: userId,
        roomId,
        result: "ALLOWED",
        timestamp: new Date(),
      });

      console.log(`📹 ${requester.name} (${requester.role}) disabled all PARTICIPANTS cameras in room ${roomId}`);
    } catch (err) {
      console.error("Error in disable-all-cameras:", err);
    }
  });

  socket.on("enable-all-cameras", async ({ roomId, userId }: any) => {
    try {
      // 1. Rate limiting
      if (!checkRateLimit(userId)) {
        await auditLog({
          action: "GLOBAL_CAMERA_ENABLE",
          actor: userId,
          roomId,
          result: "DENIED",
          reason: "RATE_LIMIT_EXCEEDED",
          timestamp: new Date(),
        });
        return;
      }

      // 2. Permission check
      const permissionResult = await checkPermission(userId, roomId, "GLOBAL_CAMERA_ENABLE");

      if (!permissionResult.allowed) {
        if (permissionResult.shouldAuditLog) {
          await auditLog({
            action: "GLOBAL_CAMERA_ENABLE",
            actor: userId,
            roomId,
            result: "DENIED",
            reason: permissionResult.reason || "UNAUTHORIZED",
            timestamp: new Date(),
          });
        }
        console.log(`❌ ${userId} unauthorized for global camera enable: ${permissionResult.reason}`);
        return;
      }

      // 3. Get requester info
      const requester = await prisma.roomParticipant.findUnique({
        where: { roomId_userId: { roomId, userId } },
      });

      if (!requester) return;

      // 4. Get only PARTICIPANTS (not hosts or co-hosts)
      const participants = await getGlobalActionTargets(roomId);

      // 5. Update database - ONLY participants, clear screenShareLocked
      await prisma.roomParticipant.updateMany({
        where: {
          roomId,
          role: "PARTICIPANT",
        },
        data: {
          isVideoPaused: false,
          screenShareLocked: false, // Unlock screen share when enabling cameras
        },
      });

      // 6. Get active sockets
      const targetSockets = await io.in(roomId).fetchSockets();

      // 7. Emit allow-unpause to each PARTICIPANT only
      for (const participant of participants) {
        const targetSocket = targetSockets.find(
          (s: any) => s.data?.userId === participant.userId
        );

        if (targetSocket) {
          targetSocket.emit("allow-unpause", {
            by: requester.name,
          });
        }
      }

      // 8. Send updated participant list to all
      const allParticipants = await prisma.roomParticipant.findMany({
        where: { roomId },
      });
      io.to(roomId).emit(
        "participant-list-update",
        allParticipants.map((p) => ({
          id: p.userId,
          name: p.name,
          imageUrl: p.imageUrl,
          isAudioMuted: p.isAudioMuted,
          isVideoPaused: p.isVideoPaused,
          isHost: p.role === "HOST",
          isCoHost: p.role === "COHOST",
          audioLocked: p.audioLocked ?? false,
          screenShareLocked: p.screenShareLocked ?? false,
        }))
      );

      // 9. Audit log success
      await auditLog({
        action: "GLOBAL_CAMERA_ENABLE",
        actor: userId,
        roomId,
        result: "ALLOWED",
        timestamp: new Date(),
      });

      console.log(`📹 ${requester.name} (${requester.role}) enabled all PARTICIPANTS cameras in room ${roomId}`);
    } catch (err) {
      console.error("Error in enable-all-cameras:", err);
    }
  });

  // ✅ Disable screen sharing for all participants
  socket.on("disable-all-screen-sharing", async ({ roomId, userId }: any) => {
    try {
      // 1. Rate limiting
      if (!checkRateLimit(userId)) {
        await auditLog({
          action: "GLOBAL_SCREENSHARE_DISABLE",
          actor: userId,
          roomId,
          result: "DENIED",
          reason: "RATE_LIMIT_EXCEEDED",
          timestamp: new Date(),
        });
        return;
      }

      // 2. Permission check
      const permissionResult = await checkPermission(userId, roomId, "GLOBAL_SCREENSHARE_DISABLE");

      if (!permissionResult.allowed) {
        if (permissionResult.shouldAuditLog) {
          await auditLog({
            action: "GLOBAL_SCREENSHARE_DISABLE",
            actor: userId,
            roomId,
            result: "DENIED",
            reason: permissionResult.reason || "UNAUTHORIZED",
            timestamp: new Date(),
          });
        }
        console.log(`❌ ${userId} unauthorized for global screenshare disable: ${permissionResult.reason}`);
        return;
      }

      // 3. Get requester info
      const requester = await prisma.roomParticipant.findUnique({
        where: { roomId_userId: { roomId, userId } },
      });

      if (!requester) return;

      // 4. Get only PARTICIPANTS (not hosts or co-hosts)
      const participants = await getGlobalActionTargets(roomId);

      // 5. Update database - ONLY participants, set screenShareLocked
      await prisma.roomParticipant.updateMany({
        where: {
          roomId,
          role: "PARTICIPANT",
        },
        data: {
          screenShareLocked: true, // Lock screen share
        },
      });

      // 6. Get active sockets
      const targetSockets = await io.in(roomId).fetchSockets();

      // 7. Emit screenshare-control to each PARTICIPANT only
      for (const participant of participants) {
        const targetSocket = targetSockets.find(
          (s: any) => s.data?.userId === participant.userId
        );

        if (targetSocket) {
          targetSocket.emit("screenshare-control", {
            enabled: false,
            by: requester.name,
          });
        }
      }

      // 8. Refresh participant list
      const allParticipants = await prisma.roomParticipant.findMany({
        where: { roomId },
      });
      io.to(roomId).emit(
        "participant-list-update",
        allParticipants.map((p) => ({
          id: p.userId,
          name: p.name,
          imageUrl: p.imageUrl,
          isAudioMuted: p.isAudioMuted,
          isVideoPaused: p.isVideoPaused,
          isHost: p.role === "HOST",
          isCoHost: p.role === "COHOST",
          audioLocked: p.audioLocked ?? false,
          screenShareLocked: p.screenShareLocked ?? false,
        }))
      );

      // 9. Audit log success
      await auditLog({
        action: "GLOBAL_SCREENSHARE_DISABLE",
        actor: userId,
        roomId,
        result: "ALLOWED",
        timestamp: new Date(),
      });

      console.log(`🖥️ ${requester.name} (${requester.role}) disabled all PARTICIPANTS screen sharing in room ${roomId}`);
    } catch (err) {
      console.error("Error in disable-all-screen-sharing:", err);
    }
  });

  // ✅ Enable screen sharing for all participants
  socket.on("enable-all-screen-sharing", async ({ roomId, userId }: any) => {
    try {
      // 1. Rate limiting
      if (!checkRateLimit(userId)) {
        await auditLog({
          action: "GLOBAL_SCREENSHARE_ENABLE",
          actor: userId,
          roomId,
          result: "DENIED",
          reason: "RATE_LIMIT_EXCEEDED",
          timestamp: new Date(),
        });
        return;
      }

      // 2. Permission check
      const permissionResult = await checkPermission(userId, roomId, "GLOBAL_SCREENSHARE_ENABLE");

      if (!permissionResult.allowed) {
        if (permissionResult.shouldAuditLog) {
          await auditLog({
            action: "GLOBAL_SCREENSHARE_ENABLE",
            actor: userId,
            roomId,
            result: "DENIED",
            reason: permissionResult.reason || "UNAUTHORIZED",
            timestamp: new Date(),
          });
        }
        console.log(`❌ ${userId} unauthorized for global screenshare enable: ${permissionResult.reason}`);
        return;
      }

      // 3. Get requester info
      const requester = await prisma.roomParticipant.findUnique({
        where: { roomId_userId: { roomId, userId } },
      });

      if (!requester) return;

      // 4. Get only PARTICIPANTS (not hosts or co-hosts)
      const participants = await getGlobalActionTargets(roomId);

      // 5. Update database - ONLY participants, clear screenShareLocked
      await prisma.roomParticipant.updateMany({
        where: {
          roomId,
          role: "PARTICIPANT",
        },
        data: {
          screenShareLocked: false, // Unlock screen share
        },
      });

      // 6. Get active sockets
      const targetSockets = await io.in(roomId).fetchSockets();

      // 7. Emit screenshare-control to each PARTICIPANT only
      for (const participant of participants) {
        const targetSocket = targetSockets.find(
          (s: any) => s.data?.userId === participant.userId
        );

        if (targetSocket) {
          targetSocket.emit("screenshare-control", {
            enabled: true,
            by: requester.name,
          });
        }
      }

      // 8. Refresh participant list
      const allParticipants = await prisma.roomParticipant.findMany({
        where: { roomId },
      });
      io.to(roomId).emit(
        "participant-list-update",
        allParticipants.map((p) => ({
          id: p.userId,
          name: p.name,
          imageUrl: p.imageUrl,
          isAudioMuted: p.isAudioMuted,
          isVideoPaused: p.isVideoPaused,
          isHost: p.role === "HOST",
          isCoHost: p.role === "COHOST",
          audioLocked: p.audioLocked ?? false,
          screenShareLocked: p.screenShareLocked ?? false,
        }))
      );

      // 9. Audit log success
      await auditLog({
        action: "GLOBAL_SCREENSHARE_ENABLE",
        actor: userId,
        roomId,
        result: "ALLOWED",
        timestamp: new Date(),
      });

      console.log(`🖥️ ${requester.name} (${requester.role}) enabled all PARTICIPANTS screen sharing in room ${roomId}`);
    } catch (err) {
      console.error("Error in enable-all-screen-sharing:", err);
    }
  });

  socket.on(
    "toggle-remote-audio",
    async ({ roomId, userId, targetUserId, force }: any) => {
      try {
        // 1. Rate limiting
        if (!checkRateLimit(userId)) {
          await auditLog({
            action: force === "mute" ? "MUTE_INDIVIDUAL" : "UNMUTE_INDIVIDUAL",
            actor: userId,
            target: targetUserId,
            roomId,
            result: "DENIED",
            reason: "RATE_LIMIT_EXCEEDED",
            timestamp: new Date(),
          });
          return;
        }

        // 2. Permission check (actor + target)
        const action = force === "mute" ? "MUTE_INDIVIDUAL" : "UNMUTE_INDIVIDUAL";
        const permissionResult = await checkPermission(
          userId,
          roomId,
          action,
          targetUserId
        );

        if (!permissionResult.allowed) {
          if (permissionResult.shouldAuditLog) {
            await auditLog({
              action,
              actor: userId,
              target: targetUserId,
              roomId,
              result: "DENIED",
              reason: permissionResult.reason || "UNAUTHORIZED",
              timestamp: new Date(),
            });
          }
          console.log(
            `❌ ${userId} unauthorized to ${force} ${targetUserId}: ${permissionResult.reason}`
          );
          return;
        }

        // 3. Get requester info
        const requester = await prisma.roomParticipant.findUnique({
          where: { roomId_userId: { roomId, userId } },
        });

        if (!requester) return;

        // 4. Update target user's audio state
        await prisma.roomParticipant.update({
          where: {
            roomId_userId: {
              roomId,
              userId: targetUserId,
            },
          },
          data: {
            isAudioMuted: force === "mute",
            audioLocked: force === "mute", // Set lock when muting, clear when unmuting
          },
        });

        // 5. Find target's socket and emit control event
        const targetSockets = await io.in(roomId).fetchSockets();
        const targetSocket = targetSockets.find(
          (s: any) => s.data?.userId === targetUserId
        );

        if (targetSocket) {
          if (force === "mute") {
            targetSocket.emit("force-mute", {
              audio: true,
              by: requester.name,
              locked: true,
            });
          } else {
            targetSocket.emit("allow-unmute", {
              by: requester.name,
              locked: false,
            });
          }

          console.log(
            `🔇 ${requester.name} (${requester.role}) ${
              force === "mute" ? "muted" : "unmuted"
            } ${targetUserId}`
          );
        }

        // 6. Send updated participant list to ensure lock state is synced
        const allParticipants = await prisma.roomParticipant.findMany({
          where: { roomId },
        });
        io.to(roomId).emit(
          "participant-list-update",
          allParticipants.map((p) => ({
            id: p.userId,
            name: p.name,
            imageUrl: p.imageUrl,
            isAudioMuted: p.isAudioMuted,
            isVideoPaused: p.isVideoPaused,
            isHost: p.role === "HOST",
            isCoHost: p.role === "COHOST",
            audioLocked: p.audioLocked ?? false,
            screenShareLocked: p.screenShareLocked ?? false,
          }))
        );

        // 7. Audit log success
        await auditLog({
          action,
          actor: userId,
          target: targetUserId,
          roomId,
          result: "ALLOWED",
          timestamp: new Date(),
        });
      } catch (err) {
        console.error("Error in toggle-remote-audio:", err);
      }
    }
  );

  socket.on(
    "toggle-remote-video",
    async ({ roomId, userId, targetUserId, force }: any) => {
      try {
        // 1. Rate limiting
        if (!checkRateLimit(userId)) {
          await auditLog({
            action: force === "disable" ? "DISABLE_CAMERA" : "ENABLE_CAMERA",
            actor: userId,
            target: targetUserId,
            roomId,
            result: "DENIED",
            reason: "RATE_LIMIT_EXCEEDED",
            timestamp: new Date(),
          });
          return;
        }

        // 2. Permission check (actor + target)
        const action = force === "disable" ? "DISABLE_CAMERA" : "ENABLE_CAMERA";
        const permissionResult = await checkPermission(
          userId,
          roomId,
          action,
          targetUserId
        );

        if (!permissionResult.allowed) {
          if (permissionResult.shouldAuditLog) {
            await auditLog({
              action,
              actor: userId,
              target: targetUserId,
              roomId,
              result: "DENIED",
              reason: permissionResult.reason || "UNAUTHORIZED",
              timestamp: new Date(),
            });
          }
          console.log(
            `❌ ${userId} unauthorized to ${force} camera for ${targetUserId}: ${permissionResult.reason}`
          );
          return;
        }

        // 3. Get requester info
        const requester = await prisma.roomParticipant.findUnique({
          where: { roomId_userId: { roomId, userId } },
        });

        if (!requester) return;

        // 4. Update target user's video state
        await prisma.roomParticipant.update({
          where: {
            roomId_userId: {
              roomId,
              userId: targetUserId,
            },
          },
          data: {
            isVideoPaused: force === "disable" || force === "pause",
          },
        });

        // 5. Find target's socket and emit control event
        const targetSockets = await io.in(roomId).fetchSockets();
        const targetSocket = targetSockets.find(
          (s: any) => s.data?.userId === targetUserId
        );

        if (targetSocket) {
          if (force === "disable" || force === "pause") {
            // Pause video and disable control
            targetSocket.emit("force-video-pause", {
              video: true,
              by: requester.name,
            });
          } else {
            // Allow user to unpause video themselves
            targetSocket.emit("allow-unpause", {
              by: requester.name,
            });
          }

          // Broadcast state change to everyone
          io.to(roomId).emit("participant-state-changed", {
            userId: targetUserId,
            isVideoPaused: force === "disable" || force === "pause",
          });

          console.log(
            `📹 ${requester.name} (${requester.role}) ${
              force === "disable" || force === "pause" ? "disabled" : "enabled"
            } camera of ${targetUserId}`
          );
        }

        // 6. Audit log success
        await auditLog({
          action,
          actor: userId,
          target: targetUserId,
          roomId,
          result: "ALLOWED",
          timestamp: new Date(),
        });
      } catch (err) {
        console.error("Error in toggle-remote-video:", err);
      }
    }
  );

  socket.on(
    "remove-participant",
    async ({ roomId, userId, targetUserId }: any) => {
      try {
        // 1. Rate limiting
        if (!checkRateLimit(userId)) {
          await auditLog({
            action: "REMOVE_FROM_ROOM",
            actor: userId,
            target: targetUserId,
            roomId,
            result: "DENIED",
            reason: "RATE_LIMIT_EXCEEDED",
            timestamp: new Date(),
          });
          return;
        }

        // 2. Permission check (actor + target)
        const permissionResult = await checkPermission(
          userId,
          roomId,
          "REMOVE_FROM_ROOM",
          targetUserId
        );

        if (!permissionResult.allowed) {
          if (permissionResult.shouldAuditLog) {
            await auditLog({
              action: "REMOVE_FROM_ROOM",
              actor: userId,
              target: targetUserId,
              roomId,
              result: "DENIED",
              reason: permissionResult.reason || "UNAUTHORIZED",
              timestamp: new Date(),
            });
          }
          console.log(
            `❌ ${userId} unauthorized to remove ${targetUserId}: ${permissionResult.reason}`
          );
          return;
        }

        // 3. Get requester info
        const requester = await prisma.roomParticipant.findUnique({
          where: { roomId_userId: { roomId, userId } },
        });

        if (!requester) return;

        // 4. Delete participant from DB
        await prisma.roomParticipant.delete({
          where: {
            roomId_userId: {
              roomId,
              userId: targetUserId,
            },
          },
        });

        // 5. Find target's socket and force disconnect
        const targetSockets = await io.in(roomId).fetchSockets();
        const targetSocket = targetSockets.find(
          (s: any) => s.data?.userId === targetUserId
        );

        if (targetSocket) {
          targetSocket.emit("kicked-from-room", {
            by: requester.name,
            reason: "Removed by host",
          });
          targetSocket.leave(roomId);
          console.log(
            `🚫 ${requester.name} (${requester.role}) removed ${targetUserId} from room`
          );
        }

        // 6. Broadcast updated participant list
        const participants = await prisma.roomParticipant.findMany({
          where: { roomId },
        });

        io.to(roomId).emit(
          "participant-list-update",
          participants.map((p) => ({
            id: p.userId,
            name: p.name,
            imageUrl: p.imageUrl,
            isAudioMuted: p.isAudioMuted,
            isVideoPaused: p.isVideoPaused,
            isHost: p.role === "HOST",
            isCoHost: p.role === "COHOST",
            audioLocked: p.audioLocked ?? false,
            screenShareLocked: p.screenShareLocked ?? false,
          }))
        );

        // 7. Audit log success
        await auditLog({
          action: "REMOVE_FROM_ROOM",
          actor: userId,
          target: targetUserId,
          roomId,
          result: "ALLOWED",
          timestamp: new Date(),
        });
      } catch (err) {
        console.error("Error in remove-participant:", err);
      }
    }
  );

  /* =========================
     MEDIASOUP
  ========================= */

  socket.on("get-rtp-capabilities", async ({ roomId }, cb) => {
    try {
      const room = await getOrCreateRoom(roomId);
      cb({ rtpCapabilities: room.router.rtpCapabilities });
    } catch (err: any) {
      console.error("Error getting RTP capabilities:", err);
      cb({ error: err.message });
    }
  });

  socket.on(
    "join-mediasoup-room",
    async (
      { roomId, rtpCapabilities, userName, userImageUrl, isCreator, userId },
      cb
    ) => {
      try {
        console.log(
          `🔍 JOIN REQUEST - User: ${userName}, UserId: ${userId}, Image: ${userImageUrl}, Creator: ${isCreator}`
        );

        // ====== PREVENT DUPLICATE JOINS ======
        const room = await getOrCreateRoom(roomId);
        const existingPeer = room.peers.get(socket.id);

        if (existingPeer) {
          console.log(
            `⚠️ ${userName} already joined - ignoring duplicate call`
          );

          // ✅ FIXED: Still return existing producers with full details including userId
          const existingProducers: Array<{
            producerId: string;
            peerId: string;
            userId: string;
            userName: string;
            kind: string;
            isScreenShare: boolean;
          }> = [];
          for (const [peerId, peer] of room.peers) {
            if (peerId !== socket.id && peer.userId) {
              peer.producers.forEach((producer) => {
                existingProducers.push({
                  producerId: producer.id,
                  peerId: peerId,
                  userId: peer.userId!, // userId is guaranteed to exist
                  userName: peer.name || "Unknown",
                  kind: producer.kind,
                  isScreenShare:
                    producer.appData?.share ||
                    producer.appData?.isScreenShare ||
                    false,
                });
              });
            }
          }
          console.log(`📡 Returning existing producers for duplicate join:`, existingProducers.length);
          return cb({ success: true, existingProducers, alreadyJoined: true });
        }

        // ====== MAP USERID EARLY ======
        if (userId) {
          socket.data.userId = userId;
          console.log(`🆔 Socket ${socket.id} mapped to user ${userId}`);
        }

        // ====== DATABASE PARTICIPANT STORAGE ======
        if (userId && userName) {
          try {
            // Check if room exists in DB, if not create it
            let dbRoom = await prisma.room.findUnique({
              where: { id: roomId },
            });

            if (!dbRoom) {
              dbRoom = await prisma.room.create({
                data: {
                  id: roomId,
                  creatorId: userId,
                },
              });
              console.log(
                `🏠 Created DB room ${roomId} with creator ${userId}`
              );
            }

            // Check if user is already a participant in DB
            let dbParticipant = await prisma.roomParticipant.findUnique({
              where: {
                roomId_userId: {
                  roomId,
                  userId,
                },
              },
            });

            // Create or update participant in DB
            if (!dbParticipant) {
              const role = userId === dbRoom.creatorId ? "HOST" : "PARTICIPANT";
              dbParticipant = await prisma.roomParticipant.create({
                data: {
                  roomId,
                  userId,
                  name: userName,
                  imageUrl: userImageUrl,
                  role,
                },
              });
              console.log(`✅ ${userName} joined as ${role} (NEW in DB)`);
            } else {
              // Update existing participant info
              dbParticipant = await prisma.roomParticipant.update({
                where: {
                  roomId_userId: {
                    roomId,
                    userId,
                  },
                },
                data: {
                  name: userName,
                  imageUrl: userImageUrl,
                },
              });
              console.log(`♻️ ${userName} rejoined (EXISTING in DB)`);
            }
          } catch (dbError) {
            console.error("❌ Database error:", dbError);
            // Continue with mediasoup even if DB fails
          }
        }

        // ====== MEDIASOUP SETUP ======
        socket.join(roomId);

        // ====== HOST OWNERSHIP ENFORCEMENT ======
        // RULE: Only the meeting creator (room.creatorId) can be HOST
        // RULE: Never assign host based on join order
        let shouldBeHost = false;
        let shouldBeCoHost = false;

        if (!userId) {
          console.error("❌ Cannot join without userId - host status requires authentication");
          return cb({ error: "userId is required" });
        }

        try {
          const dbRoom = await prisma.room.findUnique({
            where: { id: roomId },
          });

          if (!dbRoom) {
            console.error("❌ Room not found in database:", roomId);
            return cb({ error: "Room not found" });
          }

          const dbParticipant = await prisma.roomParticipant.findUnique({
            where: {
              roomId_userId: {
                roomId,
                userId,
              },
            },
          });

          // User is HOST if and only if they are the room creator
          shouldBeHost = dbRoom.creatorId === userId;

          // User is co-host if marked in DB (but not if they're the creator)
          shouldBeCoHost = !shouldBeHost && dbParticipant?.role === "COHOST";

          console.log(`🔍 Host check for ${userName}:`, {
            userId,
            creatorId: dbRoom.creatorId,
            dbRole: dbParticipant?.role,
            isCreator: dbRoom.creatorId === userId,
            shouldBeHost,
            shouldBeCoHost,
          });

          // ✅ CRITICAL: If this user is the creator, ensure they are marked as HOST in DB
          // and demote any other users who may have been incorrectly marked as HOST
          if (shouldBeHost) {
            // Update this user to be HOST
            await prisma.roomParticipant.update({
              where: {
                roomId_userId: {
                  roomId,
                  userId,
                },
              },
              data: {
                role: "HOST",
              },
            });

            // Demote any other users who are marked as HOST (they shouldn't be)
            await prisma.roomParticipant.updateMany({
              where: {
                roomId,
                userId: {
                  not: userId,
                },
                role: "HOST",
              },
              data: {
                role: "PARTICIPANT",
              },
            });

            // Update in-memory peers - demote any other hosts
            for (const [peerId, peer] of room.peers) {
              if (peer.userId !== userId && peer.isHost) {
                peer.isHost = false;
                console.log(`⬇️ Demoted ${peer.name} from HOST (creator joined)`);

                // Notify the demoted user
                const demotedSocket = await io.in(peerId).fetchSockets();
                if (demotedSocket.length > 0) {
                  demotedSocket[0].emit("role-changed", {
                    role: "PARTICIPANT",
                    reason: "Meeting owner joined",
                  });
                }
              }
            }

            console.log(`👑 ${userName} is the meeting creator - enforcing HOST status`);
          }
        } catch (err) {
          console.error("❌ Error checking host status:", err);
          return cb({ error: "Failed to verify host status" });
        }

        console.log(
          `🎯 Final status - shouldBeHost: ${shouldBeHost}, shouldBeCoHost: ${shouldBeCoHost}`
        );

        // ✅ CRITICAL: Create peer with user info from client
        room.peers.set(socket.id, {
          socketId: socket.id,
          userId: userId, // Store userId for proper mapping
          name: userName || "User " + socket.id.slice(0, 4),
          imageUrl: userImageUrl || null,
          isHost: shouldBeHost,
          isCoHost: shouldBeCoHost,
          transports: new Map(),
          producers: new Map(),
          consumers: new Map(),
          rtpCapabilities,
        });

        // ✅ FIXED: Include peerId, userId and producer details for existing producers
        // CRITICAL: Only include producers from peers with valid userId
        const existingProducers: Array<{
          producerId: string;
          peerId: string;
          userId: string;
          userName: string;
          kind: string;
          isScreenShare: boolean;
        }> = [];
        for (const [peerId, peer] of room.peers) {
          if (peerId !== socket.id && peer.userId) {
            peer.producers.forEach((producer) => {
              existingProducers.push({
                producerId: producer.id,
                peerId: peerId,
                userId: peer.userId!, // userId is guaranteed to exist
                userName: peer.name || "Unknown",
                kind: producer.kind,
                isScreenShare:
                  producer.appData?.share ||
                  producer.appData?.isScreenShare ||
                  false,
              });
            });
          }
        }

        console.log(`📡 Sending ${existingProducers.length} existing producers to ${userName}:`,
          existingProducers.map(p => ({
            kind: p.kind,
            userId: p.userId,
            isScreenShare: p.isScreenShare
          }))
        );

        // ✅ CRITICAL: Get participant list from DATABASE if available
        let participants;
        try {
          const dbParticipants = await prisma.roomParticipant.findMany({
            where: { roomId },
          });

          if (dbParticipants.length > 0) {
            // Use DB data with accurate audio/video states
            const participantMap = new Map();

            dbParticipants.forEach((p) => {
              // Deduplicate by userId - keep only one entry per user
              if (!participantMap.has(p.userId)) {
                participantMap.set(p.userId, {
                  id: p.userId,
                  name: p.name,
                  imageUrl: p.imageUrl,
                  isAudioMuted: p.isAudioMuted,
                  isVideoPaused: p.isVideoPaused,
                  isHost: p.role === "HOST",
                  isCoHost: p.role === "COHOST",
                  audioLocked: p.audioLocked ?? false,
                  screenShareLocked: p.screenShareLocked ?? false,
                });
              }
            });

            participants = Array.from(participantMap.values());
            console.log(
              `📋 Using DB participant list (${participants.length} unique participants from ${dbParticipants.length} DB entries)`
            );
          } else {
            // Fallback to in-memory peers if DB is empty
            participants = Array.from(room.peers.values()).map((p) => ({
              id: p.userId || p.socketId, // Use userId if available, fallback to socketId
              name: p.name,
              imageUrl: p.imageUrl,
              isAudioMuted: false,
              isVideoPaused: false,
              isHost: p.isHost || false,
              isCoHost: p.isCoHost || false,
              audioLocked: false,
              screenShareLocked: false,
            }));
            console.log(
              `📋 Using memory participant list (${participants.length} participants)`
            );
          }
        } catch (dbError) {
          console.error("❌ Error fetching participants from DB:", dbError);
          // Fallback to in-memory peers
          participants = Array.from(room.peers.values()).map((p) => ({
            id: p.userId || p.socketId, // Use userId if available, fallback to socketId
            name: p.name,
            imageUrl: p.imageUrl,
            isAudioMuted: false,
            isVideoPaused: false,
            isHost: p.isHost || false,
            isCoHost: p.isCoHost || false,
            audioLocked: false,
            screenShareLocked: false,
          }));
        }

        console.log(`📤 SENDING PARTICIPANT LIST:`, participants);

        // ✅ MUST use io.to() not socket.to() - includes sender
        io.to(roomId).emit("participant-list-update", participants);

        // ✅ Notify other peers that a new consumer is ready
        // They should prepare to send their producers to this new peer
        socket.to(roomId).emit("new-peer-joined", {
          peerId: socket.id,
          userId: userId,
          name: userName,
          imageUrl: userImageUrl,
          isHost: shouldBeHost,
          isCoHost: shouldBeCoHost,
        });

        console.log(`📢 Notified existing peers that ${userName} (${userId}) joined`);

        console.log(`🎧 Mediasoup ready for ${socket.id} in ${roomId}`);

        // ✅ Send current screen share permission state to joining participant
        socket.emit("screenshare-global-update", {
          enabled: room.screenShareEnabled,
          by: "System",
        });

        // ✅ Send current user's status in callback
        const currentPeer = room.peers.get(socket.id);
        console.log(`📤 Sending join response with status:`, {
          userId: currentPeer?.userId,
          isHost: currentPeer?.isHost,
          isCoHost: currentPeer?.isCoHost,
        });

        cb({
          success: true,
          existingProducers,
          isHost: currentPeer?.isHost || false,
          isCoHost: currentPeer?.isCoHost || false,
        });
      } catch (err: any) {
        console.error("Error joining mediasoup room:", err);
        cb({ error: err.message });
      }
    }
  );

  socket.on("create-webrtc-transport", async ({ roomId, direction }, cb) => {
    try {
      const room = await getOrCreateRoom(roomId);
      const peer = room.peers.get(socket.id);

      if (!peer) {
        console.error(
          `❌ Peer not found for ${socket.id} - did you call join-mediasoup-room?`
        );
        return cb({ error: "Peer not found. Call join-mediasoup-room first." });
      }

      const transport = await createWebRtcTransport(room.router);
      transport.appData.direction = direction;
      transport.appData.socketId = socket.id;
      peer.transports.set(transport.id, transport);

      // Track transport state changes
      transport.on("icestatechange", (iceState) => {
        console.log(`🧊 Transport ${transport.id} ICE state: ${iceState}`);
      });

      transport.on("dtlsstatechange", (dtlsState) => {
        console.log(`🔐 Transport ${transport.id} DTLS state: ${dtlsState}`);
        if (dtlsState === "failed" || dtlsState === "closed") {
          console.error(`❌ Transport ${transport.id} connection failed!`);
        }
      });

      console.log(
        `✅ ${direction} transport created: ${transport.id} for ${socket.id}`
      );

      cb({
        params: {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        },
      });
    } catch (err: any) {
      console.error("Error creating transport:", err);
      cb({ error: err.message });
    }
  });

  socket.on(
    "connect-transport",
    async ({ roomId, transportId, dtlsParameters }, cb) => {
      try {
        const room = await getOrCreateRoom(roomId, mediaRouter);
        const peer = room.peers.get(socket.id);
        const transport = peer?.transports.get(transportId);

        if (!transport) {
          console.error(
            `❌ Transport ${transportId} not found for ${socket.id}`
          );
          return cb({ error: "Transport not found" });
        }
        if (transport.closed) {
          console.error(`❌ Transport ${transportId} already closed`);
          return cb({ error: "Transport already closed" });
        }

        await transport.connect({ dtlsParameters });
        console.log(
          `✅ Transport ${transportId} connected (${transport.appData.direction})`
        );
        cb({ success: true });
      } catch (err: any) {
        console.error("Error connecting transport:", err);
        cb({ error: err.message });
      }
    }
  );

  /* =========================
     PRODUCE
  ========================= */

  socket.on(
    "produce",
    async ({ roomId, transportId, kind, rtpParameters, appData }, cb) => {
      try {
        const room = await getOrCreateRoom(roomId);
        const peer = room.peers.get(socket.id);
        const transport = peer?.transports.get(transportId);

        if (kind !== "audio" && kind !== "video") {
          console.error(`❌ Invalid kind: ${kind}`);
          return cb({ error: "Only audio and video are allowed" });
        }

        if (!transport) {
          console.error(`❌ No transport found for ${transportId}`);
          return cb({ error: "No transport" });
        }
        if (transport.closed) {
          console.error(`❌ Transport ${transportId} is closed`);
          return cb({ error: "Transport closed" });
        }
        if (!peer) {
          console.error(`❌ Peer ${socket.id} not found`);
          return cb({ error: "Peer not found" });
        }

        // ✅ LOCK VALIDATION: Check if user is allowed to produce based on locks
        const userId = peer.userId || (socket as any).data?.userId;
        const requestingScreenShare = appData?.share || false;

        // Check audio lock
        if (kind === "audio" && userId) {
          const canUnmuteResult = await canUnmute(userId, roomId);
          if (!canUnmuteResult.allowed) {
            console.warn(
              `🔒 Audio producer denied for ${socket.id} - ${canUnmuteResult.reason}`
            );
            socket.emit("audio-locked", {
              reason: "You have been muted by the host and cannot unmute yourself",
            });
            return cb({ error: "Audio is locked by host" });
          }
        }

        // Check screen share lock
        if (requestingScreenShare && userId) {
          const canShareResult = await canStartScreenShare(userId, roomId);
          if (!canShareResult.allowed) {
            console.warn(
              `🔒 Screen share denied for ${socket.id} - ${canShareResult.reason}`
            );
            socket.emit("screenshare-denied", {
              reason: "Screen sharing has been disabled by the host",
            });
            return cb({ error: "Screen sharing is locked by host" });
          }
        }

        // Check if screen sharing is globally disabled
        if (requestingScreenShare && !room.screenShareEnabled) {
          console.warn(
            `⛔ Screen share denied for ${socket.id} - disabled by host`
          );
          socket.emit("screenshare-denied", {
            reason: "Screen sharing is currently disabled by the host",
          });
          return cb({ error: "Screen sharing is disabled" });
        }

        // ✅ Store screen share metadata in producer's appData
        const producerAppData = {
          ...appData,
          media: kind,
          share: appData?.share || false,
          isScreenShare: appData?.share || false,
        };

        const producer = await transport.produce({
          kind,
          rtpParameters,
          appData: producerAppData,
        });

        peer.producers.set(producer.id, producer);

        // ✅ Handle producer close event
        producer.on("transportclose", () => {
          console.log(`🔌 Producer ${producer.id} transport closed`);
          peer.producers.delete(producer.id);
        });

        // Track producer lifecycle
        producer.on("score", (score) => {
          if (score.length > 0 && score[0].score < 5) {
            console.warn(
              `⚠️ Producer ${producer.id} low quality score:`,
              score[0].score
            );
          }
        });

        // Track producer score (quality)
        producer.on("score", (score) => {
          console.log(`📊 Producer ${producer.id} score:`, score);
        });

        const isScreenShare =
          producer.appData?.share || producer.appData?.isScreenShare || false;
        const emoji = kind === "audio" ? "🎤" : isScreenShare ? "🖥️" : "📹";

        console.log(
          `${emoji} ${kind} producer ${producer.id} created by ${socket.id}${
            isScreenShare ? " (screen share)" : ""
          }`
        );

        // ✅ CRITICAL: Include peerId, userId and screen share info
        // MUST have userId - cannot fallback to socket.id as it breaks client mapping
        if (!peer.userId) {
          console.error("❌ Cannot emit new-producer without userId");
          return cb({ error: "User identification required" });
        }

        const producerEvent = {
          producerId: producer.id,
          peerId: socket.id,
          userId: peer.userId,
          userName: peer.name || "Unknown",
          kind,
          isScreenShare,
        };
        console.log("📡 Emitting new-producer:", producerEvent);
        socket.to(roomId).emit("new-producer", producerEvent);

        cb({ id: producer.id });
      } catch (err: any) {
        console.error("❌ Error producing:", err);
        cb({ error: err.message });
      }
    }
  );

  /* =========================
     CONSUME (ENHANCED WITH DEBUG)
  ========================= */
  socket.on("consume", async ({ roomId, producerId, rtpCapabilities }, cb) => {
    try {
      console.log("🔍 Consume request:", {
        roomId,
        producerId,
        fromSocket: socket.id,
        hasRtpCapabilities: !!rtpCapabilities,
      });

      const room = await getOrCreateRoom(roomId);
      const peer = room.peers.get(socket.id);

      if (!peer) {
        console.error(`❌ Peer not found for socket ${socket.id}`);
        return cb({ error: "Peer not found" });
      }

      // ✅ Find the transport meant for receiving
      const transport = Array.from(peer.transports.values()).find(
        (t) => t.appData.direction === "recv"
      );

      if (!transport) {
        console.error(`❌ No receive transport found for ${socket.id}`);
        console.log(
          "Available transports:",
          Array.from(peer.transports.values()).map((t) => ({
            id: t.id,
            direction: t.appData.direction,
          }))
        );
        return cb({ error: "No receive transport found" });
      }

      // ✅ Ensure transport is connected (not closed)
      if (transport.closed) {
        console.error(`❌ Receive transport ${transport.id} is closed`);
        return cb({ error: "Receive transport is closed" });
      }

      console.log(`✅ Using recv transport: ${transport.id} (connected: ${transport.dtlsState === 'connected' || transport.iceState === 'connected'})`);

      // ✅ Find the producer's peer ID and producer details
      let producerPeerId = "";
      let producer = null;
      for (const [peerId, p] of room.peers) {
        if (p.producers.has(producerId)) {
          producerPeerId = peerId;
          producer = p.producers.get(producerId);
          console.log("✅ Found producer:", {
            producerId: producer.id,
            kind: producer.kind,
            peerId: producerPeerId,
          });
          break;
        }
      }

      if (!producer) {
        console.error(`❌ Producer ${producerId} not found`);
        console.log(
          "📋 Available producers:",
          Array.from(room.peers.entries()).map(([pid, p]) => ({
            peerId: pid,
            producers: Array.from(p.producers.keys()),
          }))
        );
        return cb({ error: "Producer not found" });
      }

      // Check if router can consume
      const canConsume = room.router.canConsume({
        producerId,
        rtpCapabilities,
      });

      if (!canConsume) {
        console.error(`❌ Cannot consume - RTP capabilities mismatch`);
        console.log(
          "Producer codec:",
          producer.rtpParameters?.codecs?.[0]?.mimeType
        );
        return cb({ error: "Cannot consume - incompatible codecs" });
      }

      console.log("✅ Can consume producer");

      // Create consumer
      const consumer = await transport.consume({
        producerId,
        rtpCapabilities,
        paused: true,
      });

      peer.consumers.set(consumer.id, consumer);

      // Track consumer events
      consumer.on("transportclose", () => {
        console.log(`🔌 Consumer ${consumer.id} transport closed`);
        peer.consumers.delete(consumer.id);
      });

      consumer.on("producerclose", () => {
        console.log(`❌ Consumer ${consumer.id} producer closed`);
        peer.consumers.delete(consumer.id);
      });

      consumer.on("score", (score) => {
        console.log(`📊 Consumer ${consumer.id} score:`, score);
      });

      console.log(
        `✅ Consumer created: ${consumer.id} for producer ${producerId} (${consumer.kind}) from peer ${producerPeerId}`
      );

      // ✅ CRITICAL: Include userId and screen share flag so client knows whose stream this is
      const producerPeer = room.peers.get(producerPeerId);

      if (!producerPeer?.userId) {
        console.error(`❌ Cannot consume - producer peer ${producerPeerId} has no userId`);
        return cb({ error: "Producer peer has no user identification" });
      }

      const response = {
        producerId,
        id: consumer.id,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        type: consumer.type,
        producerPaused: consumer.producerPaused,
        peerId: producerPeerId,
        userId: producerPeer.userId, // ALWAYS valid - no fallback
        userName: producerPeer.name || "Unknown",
        producerSocketId: producerPeerId,
        isScreenShare:
          producer.appData?.share || producer.appData?.isScreenShare || false,
        appData: producer.appData,
      };

      console.log("📤 Consumer response:", {
        consumerId: response.id,
        kind: response.kind,
        userId: response.userId,
        userName: response.userName,
        peerId: response.peerId,
        isScreenShare: response.isScreenShare,
      });
      cb(response);
    } catch (err: any) {
      console.error("❌ Error in consume:", err);
      cb({ error: err.message });
    }
  });

  socket.on("resume-consumer", async ({ roomId, consumerId }, cb) => {
    try {
      console.log(
        `▶️ Resume consumer request for ${consumerId} from ${socket.id}`
      );

      const room = await getOrCreateRoom(roomId);
      const consumer = room.peers.get(socket.id)?.consumers.get(consumerId);

      if (!consumer) {
        console.error(`❌ Consumer ${consumerId} not found for ${socket.id}`);
        return cb?.({ error: "Consumer not found" });
      }
      if (consumer.closed) {
        console.error(`❌ Consumer ${consumerId} already closed`);
        return cb?.({ error: "Consumer closed" });
      }

      await consumer.resume();
      console.log(
        `✅ Consumer ${consumerId} resumed successfully (kind: ${consumer.kind})`
      );
      cb?.({ success: true });
    } catch (err: any) {
      console.error("❌ Error resuming consumer:", err);
      cb?.({ error: err.message });
    }
  });

  // ✅ NEW: Handle producer closing
  socket.on("close-producer", async ({ roomId, producerId }, cb) => {
    try {
      const room = await getOrCreateRoom(roomId);
      const peer = room.peers.get(socket.id);
      const producer = peer?.producers.get(producerId);

      if (!peer) {
        console.error(`❌ Peer ${socket.id} not found`);
        return cb?.({ error: "Peer not found" });
      }

      if (!producer) {
        console.error(`❌ Producer ${producerId} not found`);
        return cb?.({ error: "Producer not found" });
      }

      // Extract metadata before closing
      const isScreenShare =
        producer.appData?.share || producer.appData?.isScreenShare || false;
      const kind = producer.kind;

      // ✅ Close producer - mediasoup will automatically close all consumers
      producer.close();
      peer.producers.delete(producerId);

      // ✅ Notify other peers with consistent event
      // Include userId if available (should always be available)
      const closeEvent: any = {
        producerId,
        peerId: socket.id,
        isScreenShare,
        kind,
      };

      if (peer.userId) {
        closeEvent.userId = peer.userId;
      }

      io.to(roomId).emit("producer-closed", closeEvent);

      const emoji = kind === "audio" ? "🎤" : isScreenShare ? "🖥️" : "📹";
      console.log(
        `${emoji} Producer ${producerId} closed by ${socket.id}${
          isScreenShare ? " (screen share)" : ""
        }`
      );

      cb?.({ success: true });
    } catch (err: any) {
      console.error("❌ Error closing producer:", err);
      cb?.({ error: err.message });
    }
  });

  // ✅ Handle screen share stopped - follows mediasoup best practices
  socket.on("screen-share-stopped", async ({ roomId, producerId }, cb) => {
    try {
      const room = await getOrCreateRoom(roomId);
      const peer = room.peers.get(socket.id);
      const producer = peer?.producers.get(producerId);

      if (!peer) {
        console.error(`❌ Peer ${socket.id} not found`);
        return cb?.({ error: "Peer not found" });
      }

      if (!producer) {
        console.error(`❌ Screen share producer ${producerId} not found`);
        return cb?.({ error: "Producer not found" });
      }

      // Extract screen share flag before closing
      const isScreenShare =
        producer.appData?.share || producer.appData?.isScreenShare || false;

      // ✅ ONLY close the producer - DO NOT manually close consumers
      // mediasoup will automatically trigger "producerclose" event on all consumers
      producer.close();
      peer.producers.delete(producerId);

      // ✅ Emit consistent "producer-closed" event (same as camera)
      // This ensures all media removal follows the same code path
      const closeEvent: any = {
        producerId,
        peerId: socket.id,
        isScreenShare, // Flag to differentiate screen share from camera
      };

      if (peer.userId) {
        closeEvent.userId = peer.userId;
      }

      io.to(roomId).emit("producer-closed", closeEvent);

      const emoji = isScreenShare ? "🖥️" : "🔴";
      console.log(
        `${emoji} Producer ${producerId} closed by ${socket.id}${
          isScreenShare ? " (screen share)" : ""
        }`
      );

      cb?.({ success: true });
    } catch (err: any) {
      console.error("❌ Error stopping screen share:", err);
      cb?.({ error: err.message });
    }
  });

  /* =========================
     HOST CONTROLS
  ========================= */

  // ✅ Make participant a co-host
  socket.on("make-cohost", async ({ roomId, participantId }) => {
    try {
      const actorUserId = (socket as any).data?.userId;

      console.log("📥 Received make-cohost:", {
        roomId,
        participantId,
        actorUserId,
        fromSocket: socket.id,
      });

      // 1. Rate limiting
      if (actorUserId && !checkRateLimit(actorUserId)) {
        await auditLog({
          action: "MAKE_COHOST",
          actor: actorUserId,
          target: participantId,
          roomId,
          result: "DENIED",
          reason: "RATE_LIMIT_EXCEEDED",
          timestamp: new Date(),
        });
        socket.emit("error", { message: "Too many actions. Please wait." });
        return;
      }

      // 2. Permission check
      if (actorUserId) {
        const permissionResult = await checkPermission(
          actorUserId,
          roomId,
          "MAKE_COHOST",
          participantId
        );

        if (!permissionResult.allowed) {
          if (permissionResult.shouldAuditLog) {
            await auditLog({
              action: "MAKE_COHOST",
              actor: actorUserId,
              target: participantId,
              roomId,
              result: "DENIED",
              reason: permissionResult.reason || "UNAUTHORIZED",
              timestamp: new Date(),
            });
          }
          console.log(
            `❌ ${actorUserId} unauthorized to promote ${participantId}: ${permissionResult.reason}`
          );
          socket.emit("error", {
            message: "You don't have permission to promote co-hosts",
          });
          return;
        }
      }

      // 3. Get requester and room
      const room = await getOrCreateRoom(roomId);
      const requester = room.peers.get(socket.id);

      if (!requester) {
        socket.emit("error", { message: "Requester not found" });
        return;
      }

      // 4. Find target participant in database
      const targetParticipant = await prisma.roomParticipant.findUnique({
        where: {
          roomId_userId: {
            roomId,
            userId: participantId,
          },
        },
      });

      if (!targetParticipant) {
        socket.emit("error", { message: "Participant not found" });
        return;
      }

      // Cannot promote host to co-host
      if (targetParticipant.role === "HOST") {
        socket.emit("error", { message: "Cannot promote host to co-host" });
        return;
      }

      // 5. Update participant role in database
      await prisma.roomParticipant.update({
        where: {
          roomId_userId: {
            roomId,
            userId: participantId,
          },
        },
        data: {
          role: "COHOST",
        },
      });

      // 6. Update in-memory peer if they're connected
      for (const [peerId, peer] of room.peers) {
        if (peer.userId === participantId) {
          peer.isCoHost = true;
          break;
        }
      }

      console.log(
        `🤝 ${participantId} promoted to co-host by ${requester.name || socket.id}`
      );

      // 7. Find target's socket ID
      let targetSocketId = null;
      for (const [peerId, peer] of room.peers) {
        if (peer.userId === participantId) {
          targetSocketId = peerId;
          break;
        }
      }

      // 8. 🔥 CRITICAL: Check for active global controls and immediately exempt
      if (targetSocketId) {
        // Check if participant was previously muted by global control
        if (targetParticipant.isAudioMuted) {
          // Check if there are other participants still muted (indicating global mute might be active)
          const mutedCount = await prisma.roomParticipant.count({
            where: { roomId, role: "PARTICIPANT", isAudioMuted: true },
          });

          if (mutedCount > 0) {
            // Global mute likely active, exempt the new co-host
            io.to(targetSocketId).emit("allow-unmute", {
              audio: false,
              reason: "Promoted to Co-Host",
            });
            console.log(
              `🔓 Exempted ${participantId} from global audio mute (promoted to co-host)`
            );
          }
        }

        // Check if participant's video was paused by global control
        if (targetParticipant.isVideoPaused) {
          // Check if there are other participants with paused video (indicating global disable might be active)
          const pausedCount = await prisma.roomParticipant.count({
            where: { roomId, role: "PARTICIPANT", isVideoPaused: true },
          });

          if (pausedCount > 0) {
            // Global video disable likely active, exempt the new co-host
            io.to(targetSocketId).emit("allow-video-enable", {
              video: false,
              reason: "Promoted to Co-Host",
            });
            console.log(
              `🔓 Exempted ${participantId} from global video disable (promoted to co-host)`
            );
          }
        }

        // Notify the promoted user
        io.to(targetSocketId).emit("cohost-granted", {
          by: requester.name || "Host",
          roomId,
        });
      }

      // 9. Broadcast to all participants in room
      io.to(roomId).emit("participant-updated", {
        participantId,
        updates: {
          isCoHost: true,
        },
      });

      // 10. Confirm to host
      socket.emit("success", { message: "Co-host status granted" });

      // 11. Refresh participant list for all
      const participants = await prisma.roomParticipant.findMany({
        where: { roomId },
      });
      io.to(roomId).emit(
        "participant-list-update",
        participants.map((p) => ({
          id: p.userId,
          name: p.name,
          imageUrl: p.imageUrl,
          isAudioMuted: p.isAudioMuted,
          isVideoPaused: p.isVideoPaused,
          isHost: p.role === "HOST",
          isCoHost: p.role === "COHOST",
          audioLocked: p.audioLocked ?? false,
          screenShareLocked: p.screenShareLocked ?? false,
        }))
      );

      // 12. Audit log success
      if (actorUserId) {
        await auditLog({
          action: "MAKE_COHOST",
          actor: actorUserId,
          target: participantId,
          roomId,
          result: "ALLOWED",
          timestamp: new Date(),
        });
      }
    } catch (err: any) {
      console.error("❌ Error in make-cohost:", err);
      socket.emit("error", { message: err.message });
    }
  });

  // ✅ Remove co-host status from participant
  socket.on("remove-cohost", async ({ roomId, participantId }) => {
    try {
      const room = await getOrCreateRoom(roomId);
      const requester = room.peers.get(socket.id);

      // Verify authorization - only host can remove co-hosts
      if (!requester?.isHost) {
        console.warn(`⛔ Non-host ${socket.id} attempted to remove co-host`);
        socket.emit("error", { message: "Only hosts can remove co-hosts" });
        return;
      }

      // Find target participant in database
      const targetParticipant = await prisma.roomParticipant.findUnique({
        where: {
          roomId_userId: {
            roomId,
            userId: participantId,
          },
        },
      });

      if (!targetParticipant) {
        socket.emit("error", { message: "Participant not found" });
        return;
      }

      // Check if global locks are active before demotion
      const globalLockStatus = await prisma.roomParticipant.findFirst({
        where: {
          roomId,
          role: "PARTICIPANT",
          OR: [{ audioLocked: true }, { screenShareLocked: true }],
        },
        select: {
          audioLocked: true,
          screenShareLocked: true,
        },
      });

      const shouldApplyAudioLock = globalLockStatus?.audioLocked ?? false;
      const shouldApplyScreenShareLock = globalLockStatus?.screenShareLocked ?? false;

      // Update participant role in database and re-apply locks if needed
      await prisma.roomParticipant.update({
        where: {
          roomId_userId: {
            roomId,
            userId: participantId,
          },
        },
        data: {
          role: "PARTICIPANT",
          audioLocked: shouldApplyAudioLock,
          screenShareLocked: shouldApplyScreenShareLock,
        },
      });

      // Update in-memory peer if they're connected
      for (const [peerId, peer] of room.peers) {
        if (peer.userId === participantId) {
          peer.isCoHost = false;
          break;
        }
      }

      console.log(
        `👥 ${participantId} demoted from co-host by ${
          requester.name || socket.id
        }`,
        shouldApplyAudioLock ? "🔒 Audio locked" : "",
        shouldApplyScreenShareLock ? "🔒 Screen share locked" : ""
      );

      // Broadcast to all participants in room
      io.to(roomId).emit("participant-updated", {
        participantId,
        updates: {
          isCoHost: false,
        },
      });

      // Find target's socket ID to notify them directly
      let targetSocketId = null;
      for (const [peerId, peer] of room.peers) {
        if (peer.userId === participantId) {
          targetSocketId = peerId;
          break;
        }
      }

      // Notify the demoted user and re-apply locks if needed
      if (targetSocketId) {
        io.to(targetSocketId).emit("cohost-revoked", {
          by: requester.name || "Host",
        });

        // Re-apply audio lock if global mute is active
        if (shouldApplyAudioLock) {
          io.to(targetSocketId).emit("force-mute", {
            audio: true,
            by: "Host",
            locked: true,
          });
          console.log(`🔒 Re-applied audio lock to demoted user ${participantId}`);
        }

        // Re-apply screen share lock if global disable is active
        if (shouldApplyScreenShareLock) {
          io.to(targetSocketId).emit("screenshare-control", {
            enabled: false,
            by: "Host",
          });
          console.log(`🔒 Re-applied screen share lock to demoted user ${participantId}`);
        }
      }

      // Confirm to host
      socket.emit("success", { message: "Co-host status removed" });

      // Refresh participant list for all
      const participants = await prisma.roomParticipant.findMany({
        where: { roomId },
      });
      io.to(roomId).emit(
        "participant-list-update",
        participants.map((p) => ({
          id: p.userId,
          name: p.name,
          imageUrl: p.imageUrl,
          isAudioMuted: p.isAudioMuted,
          isVideoPaused: p.isVideoPaused,
          isHost: p.role === "HOST",
          isCoHost: p.role === "COHOST",
          audioLocked: p.audioLocked ?? false,
          screenShareLocked: p.screenShareLocked ?? false,
        }))
      );
    } catch (err: any) {
      console.error("❌ Error in remove-cohost:", err);
      socket.emit("error", { message: err.message });
    }
  });

  // ✅ Host disables screen sharing for everyone
  socket.on("host-disable-screenshare", async ({ roomId }) => {
    try {
      const room = await getOrCreateRoom(roomId);
      const peer = room.peers.get(socket.id);

      // Verify authorization - only hosts or co-hosts can disable
      if (!peer?.isHost && !peer?.isCoHost) {
        console.warn(
          `⛔ Non-host/co-host ${socket.id} attempted to disable screen sharing`
        );
        socket.emit("error", {
          message: "Only hosts and co-hosts can control screen sharing",
        });
        return;
      }

      if (!room) {
        socket.emit("error", { message: "Room not found" });
        return;
      }

      // Update room state
      room.screenShareEnabled = false;

      console.log(
        `🚫 Host ${peer.name || socket.id} disabled screen sharing in ${roomId}`
      );

      // Close all active screen share producers
      let closedCount = 0;
      for (const [peerId, p] of room.peers) {
        for (const [producerId, producer] of p.producers) {
          const isScreenShare =
            producer.appData?.share || producer.appData?.isScreenShare || false;

          if (isScreenShare) {
            console.log(
              `🚫 Force closing screen share producer ${producerId} from ${peerId}`
            );

            // Close the producer - mediasoup will handle consumer cleanup
            producer.close();
            p.producers.delete(producerId);
            closedCount++;

            // Broadcast producer closed
            io.to(roomId).emit("producer-closed", {
              producerId,
              peerId,
              userId: p.userId || peerId,
              isScreenShare: true,
              kind: producer.kind,
            });
          }
        }
      }

      if (closedCount > 0) {
        console.log(
          `✅ Closed ${closedCount} screen share producer(s) in ${roomId}`
        );
      }

      // Broadcast permission change to ALL participants
      io.to(roomId).emit("screenshare-global-update", {
        enabled: false,
        by: peer.name || "Host",
      });

      // Confirm to host
      socket.emit("success", { message: "Screen sharing disabled" });
    } catch (err: any) {
      console.error("❌ Error in host-disable-screenshare:", err);
      socket.emit("error", { message: err.message });
    }
  });

  // ✅ Host enables screen sharing for everyone
  socket.on("host-enable-screenshare", async ({ roomId }) => {
    try {
      const room = await getOrCreateRoom(roomId);
      const peer = room.peers.get(socket.id);

      // Verify authorization - only hosts or co-hosts can enable
      if (!peer?.isHost && !peer?.isCoHost) {
        console.warn(
          `⛔ Non-host/co-host ${socket.id} attempted to enable screen sharing`
        );
        socket.emit("error", {
          message: "Only hosts and co-hosts can control screen sharing",
        });
        return;
      }

      if (!room) {
        socket.emit("error", { message: "Room not found" });
        return;
      }

      // Update room state
      room.screenShareEnabled = true;

      console.log(
        `✅ Host ${peer.name || socket.id} enabled screen sharing in ${roomId}`
      );

      // Broadcast permission change to ALL participants
      io.to(roomId).emit("screenshare-global-update", {
        enabled: true,
        by: peer.name || "Host",
      });

      // Confirm to host
      socket.emit("success", { message: "Screen sharing enabled" });
    } catch (err: any) {
      console.error("❌ Error in host-enable-screenshare:", err);
      socket.emit("error", { message: err.message });
    }
  });

  // ✅ Legacy bulk action handler (kept for backwards compatibility)
  socket.on("host-bulk-action", async ({ roomId, type, grant }, cb) => {
    try {
      const room = await getOrCreateRoom(roomId);
      const peer = room.peers.get(socket.id);

      // Verify the user is a host
      if (!peer?.isHost) {
        console.warn(`⛔ Non-host ${socket.id} attempted host-bulk-action`);
        return cb?.({ error: "Only hosts can perform bulk actions" });
      }

      // Handle screen share permission toggle
      if (type === "screenshare") {
        const wasEnabled = room.screenShareEnabled;
        room.screenShareEnabled = grant;

        console.log(
          `🖥️ Host ${socket.id} ${
            grant ? "enabled" : "disabled"
          } screen sharing in ${roomId}`
        );

        // If disabling screen sharing, force close all active screen-share producers
        if (!grant && wasEnabled) {
          let closedCount = 0;

          for (const [peerId, p] of room.peers) {
            for (const [producerId, producer] of p.producers) {
              const isScreenShare =
                producer.appData?.share ||
                producer.appData?.isScreenShare ||
                false;

              if (isScreenShare) {
                console.log(
                  `🚫 Force closing screen share producer ${producerId} from ${peerId}`
                );

                // Close the producer - mediasoup will handle consumer cleanup
                producer.close();
                p.producers.delete(producerId);
                closedCount++;

                // Notify all participants that this producer was closed
                io.to(roomId).emit("producer-closed", {
                  producerId,
                  peerId,
                  userId: p.userId || peerId,
                  isScreenShare: true,
                  kind: producer.kind,
                  reason: "disabled-by-host",
                });
              }
            }
          }

          if (closedCount > 0) {
            console.log(
              `✅ Closed ${closedCount} screen share producer(s) in ${roomId}`
            );
          }
        }

        // Broadcast state change to all participants
        io.to(roomId).emit("screenshare-global-update", {
          enabled: grant,
          by: peer.name || "Host",
        });

        cb?.({ success: true, enabled: grant });
      } else {
        // Handle other bulk action types if needed
        cb?.({ error: `Unknown bulk action type: ${type}` });
      }
    } catch (err: any) {
      console.error("❌ Error in host-bulk-action:", err);
      cb?.({ error: err.message });
    }
  });

  /* =========================
     RECORDING
  ========================= */

  socket.on("start-recording", async ({ roomId }, callback) => {
    try {
      recordings.set(roomId, { startTime: Date.now() });
      io.to(roomId).emit("recording-started", { roomId });
      console.log(`🔴 Recording started: ${roomId}`);
      callback?.({ success: true });
    } catch (err: any) {
      console.error("Error starting recording:", err);
      callback?.({ error: err.message });
    }
  });

  socket.on("stop-recording", async ({ roomId }, callback) => {
    try {
      const recording = recordings.get(roomId);
      if (!recording) return callback?.({ error: "No recording found" });

      const duration = Date.now() - recording.startTime;
      recordings.delete(roomId);
      io.to(roomId).emit("recording-stopped", { roomId, duration });
      console.log(`⏹️ Recording stopped: ${roomId}`);
      callback?.({ success: true, duration });
    } catch (err: any) {
      console.error("Error stopping recording:", err);
      callback?.({ error: err.message });
    }
  });

  /* =========================
     HOST MANAGEMENT
  ========================= */

  socket.on("make-host", async ({ roomId, participantId }) => {
    try {
      const room = await getOrCreateRoom(roomId);
      const requester = room.peers.get(socket.id);

      // Only full hosts can make other hosts (not co-hosts)
      if (!requester?.isHost) {
        console.warn(`⛔ Non-host ${socket.id} attempted to make host`);
        socket.emit("error", { message: "Only hosts can promote other hosts" });
        return;
      }

      const peer = room.peers.get(participantId);
      if (!peer) {
        socket.emit("error", { message: "Participant not found" });
        return;
      }

      peer.isHost = true;
      console.log(`👑 Made ${peer.name} a host`);

      // Update participant list (filter out peers without userId)
      const participants = Array.from(room.peers.values())
        .filter((p) => p.userId)
        .map((p) => ({
          id: p.userId!,
          name: p.name || "Unknown",
          imageUrl: p.imageUrl,
          isAudioMuted: false,
          isVideoPaused: false,
          isHost: p.isHost || false,
          isCoHost: p.isCoHost || false,
          audioLocked: false,
          screenShareLocked: false,
        }));
      io.to(roomId).emit("participant-list-update", participants);
    } catch (err) {
      console.error("Error making host:", err);
    }
  });

  socket.on("remove-host", async ({ roomId, participantId }) => {
    try {
      const room = await getOrCreateRoom(roomId);
      const requester = room.peers.get(socket.id);

      // Only full hosts can remove host status (not co-hosts)
      if (!requester?.isHost) {
        console.warn(`⛔ Non-host ${socket.id} attempted to remove host`);
        socket.emit("error", { message: "Only hosts can remove host status" });
        return;
      }

      const peer = room.peers.get(participantId);
      if (!peer) {
        socket.emit("error", { message: "Participant not found" });
        return;
      }

      peer.isHost = false;
      console.log(`👤 Removed host status from ${peer.name}`);

      // Update participant list (filter out peers without userId)
      const participants = Array.from(room.peers.values())
        .filter((p) => p.userId)
        .map((p) => ({
          id: p.userId!,
          name: p.name || "Unknown",
          imageUrl: p.imageUrl,
          isAudioMuted: false,
          isVideoPaused: false,
          isHost: p.isHost || false,
          isCoHost: p.isCoHost || false,
          audioLocked: false,
          screenShareLocked: false,
        }));
      io.to(roomId).emit("participant-list-update", participants);
    } catch (err) {
      console.error("Error removing host:", err);
    }
  });

  /* =========================
     CLEANUP
  ========================= */

  socket.on("disconnecting", async () => {
    try {
      for (const roomId of socket.rooms) {
        if (roomId === socket.id) continue;

        // Get userId before removing peer
        const userId = (socket as any).data?.userId;

        // Emit participant-left FIRST so frontend can clean up
        io.to(roomId).emit("participant-left", {
          peerId: socket.id,
          userId: userId || null,
        });

        console.log(`👋 User ${socket.id} (${userId}) left room ${roomId}`);

        // Remove peer from mediasoup
        removePeerFromRoom(roomId, socket.id);

        // 🔥 DELETE FROM DATABASE - This is critical!
        if (userId) {
          try {
            await prisma.roomParticipant.delete({
              where: {
                roomId_userId: {
                  roomId,
                  userId,
                },
              },
            });
            console.log(`🗑️ Deleted ${userId} from database for room ${roomId}`);
          } catch (dbErr) {
            console.error("Error deleting participant from DB:", dbErr);
          }
        }

        // Get room if it still exists (might be deleted if last peer)
        const room = await getOrCreateRoom(roomId).catch(() => null);
        if (!room) continue;

        // Update participant list with remaining users
        // Filter out any peers without userId (shouldn't happen with new validation)
        const participants = Array.from(room.peers.values())
          .filter((p) => p.userId) // Only include properly identified peers
          .map((p) => ({
            id: p.userId!,
            name: p.name || "Unknown",
            imageUrl: p.imageUrl,
            isAudioMuted: false,
            isVideoPaused: false,
            isHost: p.isHost || false,
            isCoHost: p.isCoHost || false,
            audioLocked: false,
            screenShareLocked: false,
          }));

        if (participants.length > 0) {
          io.to(roomId).emit("participant-list-update", participants);
        }
      }
      console.log(`👋 User ${socket.id} disconnected from all rooms`);
    } catch (err) {
      console.error("Error during disconnect:", err);
    }
  });
});

const PORT = process.env.PORT || 8080;
httpServer.listen(PORT, () => console.log(`🚀 Server on ${PORT}`));

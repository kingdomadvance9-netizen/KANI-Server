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

const app = express();
app.use(cors());

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
          }))
        );

        // Send chat history
        const history = await prisma.message.findMany({
          where: { roomId },
          orderBy: { createdAt: "asc" },
          include: { reactions: true },
        });

        socket.emit(
          "chat-history",
          history.map((msg: any) => ({
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
              reactions: msg.reactions.reduce((acc: any, r: any) => {
                acc[r.emoji] ??= [];
                acc[r.emoji].push(r.userId);
                return acc;
              }, {}),
            },
          }))
        );
      } catch (err) {
        console.error("Error in join-room:", err);
        socket.emit("chat-history", []);
      }
    }
  );

  socket.on("send-message", async ({ roomId, message }) => {
    io.to(roomId).emit("receive-message", {
      socketId: socket.id,
      message,
    });

    try {
      await prisma.message.create({
        data: {
          id: message.id,
          roomId,
          text: message.text,
          senderId: message.sender.id,
          senderName: message.sender.name,
          senderAvatar: message.sender.avatarUrl,
          createdAt: new Date(message.createdAt),
        },
      });
    } catch {}
  });

  /* =========================
     ROOM CONTROLS (HOST ONLY)
  ========================= */

  socket.on(
    "toggle-remote-audio",
    async ({ roomId, userId, targetUserId, force }: any) => {
      try {
        // Check if requester has HOST role
        const requester = await prisma.roomParticipant.findUnique({
          where: {
            roomId_userId: {
              roomId,
              userId,
            },
          },
        });

        if (!requester || requester.role !== "HOST") {
          console.log(`❌ ${userId} tried to mute but is not HOST`);
          return;
        }

        // Update target user's audio state
        await prisma.roomParticipant.update({
          where: {
            roomId_userId: {
              roomId,
              userId: targetUserId,
            },
          },
          data: {
            isAudioMuted: force === "mute",
          },
        });

        // Find target's socket ID and emit force-mute
        const targetSockets = await io.in(roomId).fetchSockets();
        const targetSocket = targetSockets.find(
          (s: any) => s.data?.userId === targetUserId
        );

        if (targetSocket) {
          targetSocket.emit("force-mute", {
            audio: force === "mute",
            by: requester.name,
          });
          console.log(
            `🔇 HOST ${requester.name} ${
              force === "mute" ? "muted" : "unmuted"
            } ${targetUserId}`
          );
        }

        // Broadcast updated participant list
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
          }))
        );
      } catch (err) {
        console.error("Error in toggle-remote-audio:", err);
      }
    }
  );

  socket.on(
    "toggle-remote-video",
    async ({ roomId, userId, targetUserId, force }: any) => {
      try {
        // Check if requester has HOST role
        const requester = await prisma.roomParticipant.findUnique({
          where: {
            roomId_userId: {
              roomId,
              userId,
            },
          },
        });

        if (!requester || requester.role !== "HOST") {
          console.log(`❌ ${userId} tried to control video but is not HOST`);
          return;
        }

        // Update target user's video state
        await prisma.roomParticipant.update({
          where: {
            roomId_userId: {
              roomId,
              userId: targetUserId,
            },
          },
          data: {
            isVideoPaused: force === "pause",
          },
        });

        // Find target's socket and emit force-video-pause
        const targetSockets = await io.in(roomId).fetchSockets();
        const targetSocket = targetSockets.find(
          (s: any) => s.data?.userId === targetUserId
        );

        if (targetSocket) {
          targetSocket.emit("force-video-pause", {
            video: force === "pause",
            by: requester.name,
          });
          console.log(
            `📹 HOST ${requester.name} ${
              force === "pause" ? "paused" : "unpaused"
            } video of ${targetUserId}`
          );
        }

        // Broadcast updated participant list
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
          }))
        );
      } catch (err) {
        console.error("Error in toggle-remote-video:", err);
      }
    }
  );

  socket.on(
    "remove-participant",
    async ({ roomId, userId, targetUserId }: any) => {
      try {
        // Check if requester has HOST role
        const requester = await prisma.roomParticipant.findUnique({
          where: {
            roomId_userId: {
              roomId,
              userId,
            },
          },
        });

        if (!requester || requester.role !== "HOST") {
          console.log(
            `❌ ${userId} tried to remove participant but is not HOST`
          );
          return;
        }

        // Delete participant from DB
        await prisma.roomParticipant.delete({
          where: {
            roomId_userId: {
              roomId,
              userId: targetUserId,
            },
          },
        });

        // Find target's socket and force disconnect
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
            `🚫 HOST ${requester.name} removed ${targetUserId} from room`
          );
        }

        // Broadcast updated participant list
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
          }))
        );
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

          // Still return existing producers so frontend works
          const existingProducers: string[] = [];
          for (const [peerId, peer] of room.peers) {
            if (peerId !== socket.id) {
              peer.producers.forEach((p) => existingProducers.push(p.id));
            }
          }
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

        // ✅ If room is empty, first person becomes host automatically
        const isFirstPerson = room.peers.size === 0;
        const shouldBeHost = isCreator === true || isFirstPerson;

        console.log(
          `🎯 isCreator: ${isCreator}, isFirstPerson: ${isFirstPerson}, shouldBeHost: ${shouldBeHost}`
        );

        // ✅ CRITICAL: Create peer with user info from client
        room.peers.set(socket.id, {
          socketId: socket.id,
          name: userName || "User " + socket.id.slice(0, 4),
          imageUrl: userImageUrl || null,
          isHost: shouldBeHost,
          transports: new Map(),
          producers: new Map(),
          consumers: new Map(),
          rtpCapabilities,
        });

        const existingProducers: string[] = [];
        for (const [peerId, peer] of room.peers) {
          if (peerId !== socket.id) {
            peer.producers.forEach((p) => existingProducers.push(p.id));
          }
        }

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
              id: p.socketId,
              name: p.name,
              imageUrl: p.imageUrl,
              isAudioMuted: false,
              isVideoPaused: false,
              isHost: p.isHost || false,
            }));
            console.log(
              `📋 Using memory participant list (${participants.length} participants)`
            );
          }
        } catch (dbError) {
          console.error("❌ Error fetching participants from DB:", dbError);
          // Fallback to in-memory peers
          participants = Array.from(room.peers.values()).map((p) => ({
            id: p.socketId,
            name: p.name,
            imageUrl: p.imageUrl,
            isAudioMuted: false,
            isVideoPaused: false,
            isHost: p.isHost || false,
          }));
        }

        console.log(`📤 SENDING PARTICIPANT LIST:`, participants);

        // ✅ MUST use io.to() not socket.to() - includes sender
        io.to(roomId).emit("participant-list-update", participants);

        console.log(`🎧 Mediasoup ready for ${socket.id} in ${roomId}`);
        cb({ success: true, existingProducers });
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
      peer.transports.set(transport.id, transport);

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
        const transport = room.peers
          .get(socket.id)
          ?.transports.get(transportId);

        if (!transport) return cb({ error: "Transport not found" });
        if (transport.closed) return cb({ error: "Transport already closed" });

        await transport.connect({ dtlsParameters });
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
          return cb({ error: "Only audio and video are allowed" });
        }

        if (!transport) return cb({ error: "No transport" });
        if (transport.closed) return cb({ error: "Transport closed" });
        if (!peer) return cb({ error: "Peer not found" });

        const producer = await transport.produce({
          kind,
          rtpParameters,
          appData: appData || { media: kind },
        });

        peer.producers.set(producer.id, producer);

        // ✅ CRITICAL: Include peerId and screen share info
        socket.to(roomId).emit("new-producer", {
          producerId: producer.id,
          peerId: socket.id,
          kind,
          isScreenShare: appData?.share === true,
        });
        console.log(
          `${
            kind === "audio" ? "🎤" : appData?.share ? "🖥️" : "📹"
          } ${kind} producer ${producer.id} from ${socket.id}`
        );

        cb({ id: producer.id });
      } catch (err: any) {
        console.error("Error producing:", err);
        cb({ error: err.message });
      }
    }
  );

  /* =========================
     CONSUME (FIXED)
  ========================= */

  /* =========================
    CONSUME (FIXED)
========================= */
  socket.on("consume", async ({ roomId, producerId, rtpCapabilities }, cb) => {
    try {
      const room = await getOrCreateRoom(roomId);
      const peer = room.peers.get(socket.id);
      if (!peer) throw new Error("Peer not found");

      // ✅ FIX: Specifically find the transport meant for receiving
      const transport = Array.from(peer.transports.values()).find(
        (t) => t.appData.direction === "recv"
      );

      if (!transport) throw new Error("No receive transport found");

      if (!room.router.canConsume({ producerId, rtpCapabilities })) {
        return cb({ error: "Cannot consume" });
      }

      // ✅ Find the producer's peer ID
      let producerPeerId = "";
      for (const [peerId, p] of room.peers) {
        if (p.producers.has(producerId)) {
          producerPeerId = peerId;
          break;
        }
      }

      const consumer = await transport.consume({
        producerId,
        rtpCapabilities,
        paused: true,
      });

      peer.consumers.set(consumer.id, consumer);

      // ✅ CRITICAL: Include peerId so client knows whose stream this is
      cb({
        id: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        peerId: producerPeerId,
      });
    } catch (err: any) {
      cb({ error: err.message });
    }
  });

  socket.on("resume-consumer", async ({ roomId, consumerId }, cb) => {
    try {
      const room = await getOrCreateRoom(roomId);
      const consumer = room.peers.get(socket.id)?.consumers.get(consumerId);

      if (!consumer) {
        console.error("Consumer not found:", consumerId);
        return cb?.({ error: "Consumer not found" });
      }
      if (consumer.closed) {
        console.error("Consumer already closed:", consumerId);
        return cb?.({ error: "Consumer closed" });
      }

      await consumer.resume();
      cb?.({ success: true });
    } catch (err: any) {
      console.error("Error resuming consumer:", err);
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
      const peer = room.peers.get(participantId);

      if (!peer) return;

      peer.isHost = true;
      console.log(`👑 Made ${peer.name} a host`);

      // Update participant list
      const participants = Array.from(room.peers.values()).map((p) => ({
        id: p.socketId,
        name: p.name,
        imageUrl: p.imageUrl,
        isAudioMuted: false,
        isVideoPaused: false,
        isHost: p.isHost || false,
      }));
      io.to(roomId).emit("participant-list-update", participants);
    } catch (err) {
      console.error("Error making host:", err);
    }
  });

  socket.on("remove-host", async ({ roomId, participantId }) => {
    try {
      const room = await getOrCreateRoom(roomId);
      const peer = room.peers.get(participantId);

      if (!peer) return;

      peer.isHost = false;
      console.log(`👤 Removed host status from ${peer.name}`);

      // Update participant list
      const participants = Array.from(room.peers.values()).map((p) => ({
        id: p.socketId,
        name: p.name,
        imageUrl: p.imageUrl,
        isAudioMuted: false,
        isVideoPaused: false,
        isHost: p.isHost || false,
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

        // Remove peer first
        removePeerFromRoom(roomId, socket.id);

        // Get room if it still exists (might be deleted if last peer)
        const room = await getOrCreateRoom(roomId).catch(() => null);
        if (!room) continue;

        // ✅ Update participant list with ALL user info
        const participants = Array.from(room.peers.values()).map((p) => ({
          id: p.socketId,
          name: p.name,
          imageUrl: p.imageUrl,
          isAudioMuted: false,
          isVideoPaused: false,
          isHost: p.isHost || false,
        }));

        if (participants.length > 0) {
          io.to(roomId).emit("participant-list-update", participants);
          io.to(roomId).emit("participant-left", { peerId: socket.id });
        }
      }
      console.log(`👋 User ${socket.id} disconnected`);
    } catch (err) {
      console.error("Error during disconnect:", err);
    }
  });
});

const PORT = process.env.PORT || 8080;
httpServer.listen(PORT, () => console.log(`🚀 Server on ${PORT}`));

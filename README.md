# KANI Server - WebRTC Video Conferencing Backend

A real-time video conferencing server built with Node.js, Express, Socket.IO, Mediasoup, and PostgreSQL. Includes M-Pesa payment integration for Kenyan users.

## 🚀 Server URL

**Production:** `http://161.97.67.188:8080`

## 📋 Table of Contents

- [Features](#features)
- [Tech Stack](#tech-stack)
- [API Endpoints](#api-endpoints)
- [Socket.IO Events](#socketio-events)
- [Frontend Integration](#frontend-integration)
- [M-Pesa Integration](#mpesa-integration)
- [Deployment](#deployment)

## ✨ Features

- ✅ WebRTC video conferencing with Mediasoup
- ✅ Real-time audio/video streaming
- ✅ Screen sharing support
- ✅ Room-based meetings
- ✅ Host controls (mute, kick, lock room)
- ✅ Recording capabilities
- ✅ M-Pesa payment integration (Kenya)
- ✅ Auto-deployment via GitHub Actions

## 🛠 Tech Stack

- **Runtime:** Node.js 20+
- **Framework:** Express.js
- **Real-time:** Socket.IO
- **WebRTC:** Mediasoup
- **Database:** PostgreSQL (Neon)
- **ORM:** Prisma
- **Payment:** M-Pesa Daraja API
- **Process Manager:** PM2
- **Deployment:** Contabo VPS + GitHub Actions

## 📡 API Endpoints

### Health Check

```http
GET /debug/room/:roomId
```

Check the status of a specific room.

**Response:**
```json
{
  "roomId": "room123",
  "routerClosed": false,
  "peerCount": 3,
  "peers": [...]
}
```

### M-Pesa Endpoints

#### 1. Initiate Payment (STK Push)

```http
POST /api/mpesa/initiate
```

**Request Body:**
```json
{
  "userId": "user123",
  "userName": "John Doe",
  "phoneNumber": "0712345678",
  "amount": 100,
  "accountReference": "MeetingFee"
}
```

**Response:**
```json
{
  "success": true,
  "message": "STK Push sent successfully. Please check your phone.",
  "data": {
    "transactionId": "tx_123",
    "checkoutRequestId": "ws_CO_xxx",
    "merchantRequestId": "mr_xxx"
  }
}
```

#### 2. Check Payment Status

```http
GET /api/mpesa/status/:checkoutRequestId
```

**Response (Pending):**
```json
{
  "success": true,
  "status": "PENDING",
  "message": "Waiting for payment confirmation"
}
```

**Response (Success):**
```json
{
  "success": true,
  "status": "SUCCESS",
  "data": {
    "id": "tx_123",
    "mpesaReceiptNumber": "ABC123XYZ",
    "phoneNumber": "254712345678",
    "amount": "100",
    "transactionDate": "2026-01-19T10:30:00Z",
    "userId": "user123"
  }
}
```

#### 3. Get Transaction History

```http
GET /api/mpesa/transactions/:userId?limit=20&offset=0
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "tx_123",
      "amount": "100",
      "status": "SUCCESS",
      "mpesaReceiptNumber": "ABC123XYZ",
      "createdAt": "2026-01-19T10:30:00Z"
    }
  ]
}
```

#### 4. Get Receipt

```http
GET /api/mpesa/receipt/:checkoutRequestId
```

#### 5. Test Callback Endpoint

```http
GET /api/mpesa/callback-test
```

## 🔌 Socket.IO Events

### Connection

```javascript
import { io } from "socket.io-client";

const socket = io("http://161.97.67.188:8080");

socket.on("connect", () => {
  console.log("Connected:", socket.id);
});
```

### User Authentication

```javascript
// Set user ID
socket.emit("set-user-id", "user123");

// Set user name
socket.emit("set-user-name", "John Doe");
```

### Room Management

#### Join Room

```javascript
socket.emit("join-room", {
  roomId: "room123",
  userName: "John Doe",
  isHost: false
});

socket.on("room-joined", (data) => {
  console.log("Joined room:", data);
  // data: { roomId, peerId, peers, routerRtpCapabilities }
});
```

#### Leave Room

```javascript
socket.emit("leave-room");
```

### WebRTC Transport & Media

#### Create WebRTC Transport

```javascript
socket.emit("create-webrtc-transport", {
  roomId: "room123",
  direction: "send" // or "recv"
});

socket.on("webrtc-transport-created", (transport) => {
  // transport: { id, iceParameters, iceCandidates, dtlsParameters }
});
```

#### Connect Transport

```javascript
socket.emit("connect-transport", {
  transportId: "transport123",
  dtlsParameters: {...}
});
```

#### Produce Media (Send Audio/Video)

```javascript
socket.emit("produce", {
  transportId: "transport123",
  kind: "video", // or "audio"
  rtpParameters: {...},
  appData: { source: "webcam" }
});

socket.on("producer-created", ({ producerId }) => {
  console.log("Producer created:", producerId);
});
```

#### Consume Media (Receive Audio/Video)

```javascript
socket.emit("consume", {
  transportId: "transport123",
  producerId: "producer123",
  rtpCapabilities: {...}
});

socket.on("consumer-created", (consumer) => {
  // consumer: { id, producerId, kind, rtpParameters, ... }
});
```

#### Resume Consumer

```javascript
socket.emit("resume-consumer", { consumerId: "consumer123" });
```

### Screen Sharing

```javascript
// Start screen share
socket.emit("produce", {
  transportId: "transport123",
  kind: "video",
  rtpParameters: {...},
  appData: { source: "screen" }
});

// Listen for screen share events
socket.on("user-screen-share-started", ({ peerId, producerId }) => {
  console.log(`${peerId} started screen sharing`);
});

socket.on("user-screen-share-stopped", ({ peerId, producerId }) => {
  console.log(`${peerId} stopped screen sharing`);
});
```

### Host Controls

#### Mute/Unmute User

```javascript
socket.emit("host-mute-peer", {
  roomId: "room123",
  peerId: "peer456",
  mediaType: "audio" // or "video"
});
```

#### Kick User

```javascript
socket.emit("host-kick-peer", {
  roomId: "room123",
  peerId: "peer456"
});
```

#### Lock/Unlock Room

```javascript
socket.emit("host-lock-room", { roomId: "room123" });
socket.emit("host-unlock-room", { roomId: "room123" });
```

### Recording

```javascript
// Start recording
socket.emit("start-recording", { roomId: "room123" });

socket.on("recording-started", ({ roomId, startTime }) => {
  console.log("Recording started");
});

// Stop recording
socket.emit("stop-recording", { roomId: "room123" });

socket.on("recording-stopped", ({ roomId, duration }) => {
  console.log("Recording stopped, duration:", duration);
});
```

### Peer Events (Listen for these)

```javascript
// New peer joined
socket.on("peer-joined", ({ peerId, userName, isHost }) => {
  console.log(`${userName} joined`);
});

// Peer left
socket.on("peer-left", ({ peerId }) => {
  console.log(`${peerId} left`);
});

// New producer (someone started sharing audio/video)
socket.on("new-producer", ({ peerId, producerId, kind }) => {
  console.log(`${peerId} started ${kind}`);
});

// Producer closed (someone stopped sharing)
socket.on("producer-closed", ({ peerId, producerId, kind }) => {
  console.log(`${peerId} stopped ${kind}`);
});

// You were kicked
socket.on("you-were-kicked", ({ reason }) => {
  console.log("Kicked:", reason);
});

// Room locked
socket.on("room-locked", ({ roomId }) => {
  console.log("Room is now locked");
});

// Room unlocked
socket.on("room-unlocked", ({ roomId }) => {
  console.log("Room is now unlocked");
});
```

## 🎯 Frontend Integration

### Complete Example (React)

```javascript
import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';

const SERVER_URL = "http://161.97.67.188:8080";

function VideoConference() {
  const [socket, setSocket] = useState(null);
  const [roomId] = useState("room123");
  const [userId] = useState("user456");
  const [userName] = useState("John Doe");

  useEffect(() => {
    // Connect to server
    const newSocket = io(SERVER_URL);
    setSocket(newSocket);

    newSocket.on("connect", () => {
      console.log("Connected to server");

      // Set user credentials
      newSocket.emit("set-user-id", userId);
      newSocket.emit("set-user-name", userName);

      // Join room
      newSocket.emit("join-room", {
        roomId,
        userName,
        isHost: false
      });
    });

    newSocket.on("room-joined", (data) => {
      console.log("Room joined:", data);
      // Initialize WebRTC here
    });

    newSocket.on("peer-joined", ({ peerId, userName }) => {
      console.log(`${userName} joined`);
    });

    newSocket.on("peer-left", ({ peerId }) => {
      console.log(`${peerId} left`);
    });

    return () => {
      newSocket.close();
    };
  }, []);

  return (
    <div>
      <h1>Video Conference</h1>
      {/* Your video elements here */}
    </div>
  );
}

export default VideoConference;
```

### M-Pesa Payment Example

```javascript
import axios from 'axios';

const API_URL = "http://161.97.67.188:8080/api/mpesa";

async function initiatePayment() {
  try {
    const response = await axios.post(`${API_URL}/initiate`, {
      userId: "user123",
      userName: "John Doe",
      phoneNumber: "0712345678",
      amount: 100,
      accountReference: "MeetingFee"
    });

    const { checkoutRequestId } = response.data.data;

    // Poll for status
    const interval = setInterval(async () => {
      const statusRes = await axios.get(`${API_URL}/status/${checkoutRequestId}`);

      if (statusRes.data.status === "SUCCESS") {
        clearInterval(interval);
        console.log("Payment successful!", statusRes.data.data);
      } else if (statusRes.data.status === "FAILED" || statusRes.data.status === "CANCELLED") {
        clearInterval(interval);
        console.log("Payment failed:", statusRes.data.message);
      }
    }, 3000);

  } catch (error) {
    console.error("Payment error:", error);
  }
}
```

## 💳 M-Pesa Integration

### Phone Number Format

Phone numbers are automatically normalized:
- `0712345678` → `254712345678`
- `+254712345678` → `254712345678`
- `712345678` → `254712345678`

### Amount Validation

- Must be an integer >= 1
- No decimals allowed
- Range: 1 - 250,000 KES

### Payment Flow

1. **Initiate:** POST `/api/mpesa/initiate` → User receives STK push
2. **User enters PIN:** On their phone
3. **Poll status:** GET `/api/mpesa/status/:checkoutRequestId` every 3 seconds
4. **Callback:** M-Pesa sends confirmation to `/api/mpesa/callback`
5. **Success:** Receive receipt number and transaction details

### Testing

```bash
# Test callback endpoint
curl http://161.97.67.188:8080/api/mpesa/callback-test

# Check transaction
curl http://161.97.67.188:8080/api/mpesa/status/ws_CO_xxx
```

## 🚀 Deployment

### Auto-Deployment

Every push to `main` branch automatically deploys to Contabo VPS via GitHub Actions.

### Manual Deployment

SSH into VPS and run:

```bash
ssh deploy@161.97.67.188
cd /var/www/KANI-SERVER/KANI-Server
git pull origin main
npm install
npx prisma generate
npx prisma migrate deploy
pm2 restart kani-server
```

### Check Server Status

```bash
# View running processes
pm2 status

# View logs
pm2 logs kani-server

# Restart server
pm2 restart kani-server

# Stop server
pm2 stop kani-server
```

## 🔒 Environment Variables

Required in `.env` file on VPS:

```env
DATABASE_URL=postgresql://...
NODE_ENV=production
PORT=8080
MEDIASOUP_MIN_PORT=40000
MEDIASOUP_MAX_PORT=49999
NEXT_PUBLIC_SOCKET_URL=http://161.97.67.188:8080

# M-Pesa Configuration
MPESA_CONSUMER_KEY=xxx
MPESA_CONSUMER_SECRET=xxx
MPESA_PASSKEY=xxx
MPESA_SHORT_CODE=xxx
MPESA_CALLBACK_URL=http://161.97.67.188:8080/api/mpesa/callback
MPESA_ENVIRONMENT=production
```

## 🐛 Troubleshooting

### "Cannot GET /" Error

This is normal! The server uses Socket.IO for communication, not REST endpoints at root. Connect via Socket.IO client instead.

### Port Already in Use

```bash
pm2 stop kani-server
pm2 delete kani-server
pm2 start npm --name "kani-server" -- start
```

### Database Connection Issues

```bash
# Test database connection
npx prisma db pull

# Reset database (CAREFUL!)
npx prisma migrate reset
```

### M-Pesa Callback Not Received

1. Check firewall allows port 8080
2. Verify callback URL is correct
3. Check PM2 logs: `pm2 logs kani-server`
4. Test callback: `curl http://161.97.67.188:8080/api/mpesa/callback-test`

## 📚 Additional Resources

- [Mediasoup Documentation](https://mediasoup.org/documentation/v3/)
- [Socket.IO Documentation](https://socket.io/docs/v4/)
- [M-Pesa Daraja API](https://developer.safaricom.co.ke/)
- [Prisma Documentation](https://www.prisma.io/docs/)

## 📄 License

MIT

## 🤝 Contributing

1. Fork the repository
2. Create feature branch: `git checkout -b feature/new-feature`
3. Commit changes: `git commit -m "Add new feature"`
4. Push to branch: `git push origin feature/new-feature`
5. Open pull request

---

**Server Status:** ✅ Live at `http://161.97.67.188:8080`

For issues or questions, open an issue on GitHub.

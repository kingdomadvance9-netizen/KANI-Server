Grace Meet — Mediasoup Powered Video Conferencing

Grace Meet is a real-time video conferencing platform built with Next.js, Socket.IO, mediasoup, and Prisma.
The project is designed with a step-by-step, debuggable architecture, gradually replacing third-party real-time services with a fully self-hosted media stack.

✨ Features (Current & Planned)
✅ Implemented

Next.js frontend

Express + Socket.IO backend

PostgreSQL database (Neon)

Prisma ORM

Real-time socket connection

Text chat (Socket.IO based)

Local & production builds working

Clean separation of frontend and backend

🚧 In Progress / Planned

mediasoup (Audio → Video)

Custom WebRTC signaling

Active speaker detection

Grid & speaker layouts

Media controls (mute, camera, leave)

Stream SDK fully removed

🧭 Project Roadmap

We follow a strict phased approach to avoid breaking changes.

Phase 0 — Safety & Baseline

App runs locally

Stream still works

Git clean

Phase 1 — Backend Socket.IO

Express + Socket.IO server

Room join / leave

Presence tracking

Phase 2 — Replace Stream Chat

Socket-based chat

Local UI state

No Stream chat dependency

Phase 3 — Remove Stream Chat

Stream used only for video

Chat fully custom

Phase 4 — mediasoup (Audio Only)

Worker + Router

RTP capabilities exchange

WebRTC transports

Microphone audio

Phase 5 — Remove Stream Video

Stream SDK fully removed

Audio fully mediasoup

Phase 6 — mediasoup Video

VP8 codec

Simulcast

Multi-peer video grid

Phase 7 — UX Polish

Mute / unmute

Camera toggle

Active speaker

Clean UI/UX

🏗️ Project Structure
grace-meet-mediasoup/
├── server/
│   ├── index.ts
│   ├── prisma/
│   │   ├── schema.prisma
│   │   └── migrations/
│   ├── generated/
│   ├── package.json
│   └── tsconfig.json
│
├── app/                # Next.js App Router
├── components/
├── lib/
├── public/
├── package.json
└── README.md

⚙️ Tech Stack
Frontend

Next.js (App Router)

TypeScript

Socket.IO Client

Backend

Node.js

Express

Socket.IO

mediasoup

Prisma ORM

Database

PostgreSQL (Neon)

🔐 Environment Variables
Backend (server/.env)
DATABASE_URL=postgresql://...
PORT=4000
NODE_ENV=development

Frontend (.env.local)
NEXT_PUBLIC_SOCKET_URL=http://localhost:4000

🚀 Running Locally
1️⃣ Backend
cd server
npm install
npm run dev


Server runs on:

http://localhost:4000

2️⃣ Frontend
npm install
npm run dev


Frontend runs on:

http://localhost:3000

🧬 Prisma Notes

Do NOT commit generated Prisma client

Prisma client is generated automatically via:

"postinstall": "prisma generate"


Only commit:

schema.prisma

migrations/

☁️ Deployment
Supported Platforms

Railway (Backend)

Vercel (Frontend)

Important Notes

Do not commit node_modules

Do not commit .env

Prisma client is generated during deployment

🛑 Development Rules (Strict)

One phase at a time

No skipping steps

Every phase must be testable

No DB-dependent media logic

No production hosting until media is stable

🤝 Contribution

This project follows a controlled architecture plan.
Please open an issue before submitting major changes.
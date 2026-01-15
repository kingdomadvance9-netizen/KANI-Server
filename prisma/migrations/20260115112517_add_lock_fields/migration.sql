-- AlterTable
ALTER TABLE "RoomParticipant" ADD COLUMN     "audioLocked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "screenShareLocked" BOOLEAN NOT NULL DEFAULT false;
